use super::*;
use crate::command_error::CommandError;

pub(crate) static CORE_OPERATION_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn spawn_core_child(mut command: Command) -> Result<Child, String> {
    command
        .spawn()
        .map_err(|error| format!("Couldn't start the core: {error}"))
}

async fn run_core_command(
    app: tauri::AppHandle,
    operation: fn(&CoreProcessState, &GuiConfigState) -> Result<CoreStatus, String>,
) -> Result<CoreStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CORE_OPERATION_LOCK
            .try_lock()
            .map_err(|_| "The core is performing another operation; please try again later".to_string())?;
        let status = operation(
            app.state::<CoreProcessState>().inner(),
            app.state::<GuiConfigState>().inner(),
        )?;
        emit_core_status(&app, &status);
        Ok(status)
    })
    .await
    .map_err(|error| format!("Core background task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn check_latest_core(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreLatest, String> {
    let platform = current_core_platform()?;
    let config = gui_config_state.snapshot()?;
    let client = http_client(&config.proxy_url)?;
    let release = fetch_release(&client, None).await?;
    let asset_name = select_release_asset(&release, &platform)?.name.clone();

    Ok(CoreLatest {
        version: normalize_version(&release.tag_name),
        asset_name,
        releases: release.release_notes,
    })
}

/// Records the bundled core version Arbor has already dealt with, so a core rolled back by hand stays put on the next
/// launch instead of being replaced with the bundled one again.
const BUNDLED_CORE_HANDLED_FILE: &str = "arbor-bundled-core-handled.txt";

fn parse_core_version(version: &str) -> Option<semver::Version> {
    semver::Version::parse(version.trim().trim_start_matches('v')).ok()
}

/// Whether the core bundled with this build should be installed: there's no core yet, or the installed one is older
/// (or its version is unknown) and this bundled version hasn't been dealt with before. Never a downgrade.
pub(crate) fn core_needs_bundled_install(install_dir: &Path, bundled_version: &str) -> bool {
    let Some(bundled) = parse_core_version(bundled_version) else {
        return false;
    };
    if find_core_binary(install_dir).is_none() {
        return true;
    }
    if bundled_core_version_handled(install_dir, &bundled) {
        return false;
    }
    read_core_metadata(install_dir)
        .and_then(|metadata| parse_core_version(&metadata.version))
        .is_none_or(|installed| bundled > installed)
}

fn bundled_core_version_handled(install_dir: &Path, bundled: &semver::Version) -> bool {
    fs::read_to_string(install_dir.join(BUNDLED_CORE_HANDLED_FILE))
        .ok()
        .and_then(|version| parse_core_version(&version))
        .is_some_and(|version| &version == bundled)
}

pub(crate) fn mark_bundled_core_version_handled(install_dir: &Path, bundled_version: &str) -> Result<(), String> {
    write_bytes_atomically(&install_dir.join(BUNDLED_CORE_HANDLED_FILE), bundled_version.trim().as_bytes())
        .map_err(|error| format!("Failed to record the bundled core version: {error}"))
}

/// Marks the bundled version dealt with when the installed core is already as new, so rolling back later doesn't bring
/// the bundled one back on the next launch.
pub(crate) fn remember_bundled_core_when_up_to_date(install_dir: &Path, bundled_version: &str) -> Result<(), String> {
    let Some(bundled) = parse_core_version(bundled_version) else {
        return Ok(());
    };
    if bundled_core_version_handled(install_dir, &bundled) {
        return Ok(());
    }
    let installed = read_core_metadata(install_dir).and_then(|metadata| parse_core_version(&metadata.version));
    if find_core_binary(install_dir).is_some() && installed.is_some_and(|version| version >= bundled) {
        mark_bundled_core_version_handled(install_dir, bundled_version)?;
    }
    Ok(())
}

/// At launch: installs the core this build bundles when there's none yet, or when an Arbor update brought a newer one
/// than the installed core. A core that's running keeps serving while the new one is unpacked, and stops only for the
/// swap.
pub(crate) fn auto_install_bundled_core_if_needed(app: &tauri::AppHandle) -> Result<bool, String> {
    let install_dir = core_install_dir()?;
    let (info, archive_path) = match bundled_core_archive()? {
        Some(bundled) => bundled,
        None if find_core_binary(&install_dir).is_some() => return Ok(false),
        None => return Err("The core isn't installed, and this version of Arbor has none bundled for this Mac".to_string()),
    };
    if !core_needs_bundled_install(&install_dir, &info.version) {
        remember_bundled_core_when_up_to_date(&install_dir, &info.version)?;
        return Ok(false);
    }
    let window = app
        .get_webview_window("main")
        .map(|webview| webview.as_ref().window())
        .ok_or_else(|| "Cannot access the main window to automatically install the offline core".to_string())?;
    let state = app.state::<CoreDownloadState>();
    state.start(CancellationToken::new(), Some(info.version.clone()))?;
    let result = stage_bundled_core(&window, state.inner(), &info, &archive_path).and_then(|staged| {
        swap_in_staged_core_with_runtime_restore(
            app,
            &window,
            state.inner(),
            app.state::<CoreProcessState>().inner(),
            &app.state::<GuiConfigState>().snapshot()?,
            &staged,
        )
    });
    if result.is_err() {
        let _ = cleanup_core_work_dirs();
    }
    // Nothing can stop the bundled install.
    state.finish(&window, result.clone(), false);
    result?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn cancel_core_install(state: tauri::State<'_, CoreDownloadState>) {
    state.cancel();
}

#[tauri::command]
pub(crate) fn get_core_install_task(state: tauri::State<'_, CoreDownloadState>) -> CoreInstallTask {
    state.snapshot()
}

#[tauri::command]
pub(crate) async fn install_core_version(
    app: tauri::AppHandle,
    window: tauri::Window,
    version: Option<String>,
) -> Result<CoreInstallResult, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CORE_OPERATION_LOCK
            .try_lock()
            .map_err(|_| "The core is performing another operation; please try again later".to_string())?;
        let state = app.state::<CoreDownloadState>();
        let process_state = app.state::<CoreProcessState>();
        let config = app.state::<GuiConfigState>().snapshot()?;
        let token = CancellationToken::new();
        let stopped = token.clone();
        state.start(token.clone(), version.clone())?;
        let result = tauri::async_runtime::block_on(stage_core_version(
            &window,
            state.inner(),
            token,
            version,
            &config.proxy_url,
        ))
        .and_then(|staged| {
            swap_in_staged_core_with_runtime_restore(
                &app,
                &window,
                state.inner(),
                process_state.inner(),
                &config,
                &staged,
            )
        });
        if result.is_err() {
            let _ = cleanup_core_work_dirs();
        }
        // Whether it was stopped comes from the stop itself: a failure can say "canceled" too.
        let canceled = stopped.is_cancelled();
        state.finish(&window, result.clone(), canceled);
        result.map_err(|error| install_error(error, canceled))
    })
    .await
    .map_err(|error| CommandError::failed(format!("Core installation background task failed: {error}")))?
}

fn install_error(message: String, canceled: bool) -> CommandError {
    if canceled {
        CommandError::canceled(message)
    } else {
        CommandError::failed(message)
    }
}

/// A core unpacked, checked and waiting in the staging folder with its config merged. Getting it there (downloading,
/// verifying, unpacking) runs while the installed core keeps serving; only swapping it in needs the core stopped.
pub(crate) struct StagedCore {
    pub(crate) version: String,
    pub(crate) asset_name: String,
    pub(crate) binary_relative_path: PathBuf,
    /// The core this build bundles, marked dealt with once it's in.
    pub(crate) bundled: bool,
    /// Where a downloaded archive waits, removed once the core is in.
    pub(crate) download_dir: Option<PathBuf>,
}

fn core_staging_dir() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join("cpa-core.staging"))
}

/// Swaps a staged core in. The running core stops only for the swap and starts again straight after, so agents lose
/// the proxy for a stop and a start rather than for the whole download and unpack.
fn swap_in_staged_core_with_runtime_restore(
    app: &tauri::AppHandle,
    window: &tauri::Window,
    state: &CoreDownloadState,
    process_state: &CoreProcessState,
    config: &GuiConfigFile,
    staged: &StagedCore,
) -> Result<CoreInstallResult, String> {
    state.progress(window, "swapping", 0, None, false);
    let (was_running, result) = match pause_core_for_install(app, process_state, config) {
        Ok(was_running) => (
            was_running,
            core_install_dir().and_then(|install_dir| {
                if current_core_status(None, None)?.running {
                    return Err("The core is still running, so the new version wasn't swapped in".to_string());
                }
                swap_in_staged_core(&install_dir, &core_staging_dir()?, staged)
            }),
        ),
        Err(error) => (false, Err(error)),
    };
    restore_core_after_install(app, process_state, config, was_running, result)
}

/// Moves a staged core into the install folder, with the core stopped. Its config is carried over again first: the
/// running core's could have changed while the new one was staged.
pub(crate) fn swap_in_staged_core(
    install_dir: &Path,
    staging_dir: &Path,
    staged: &StagedCore,
) -> Result<CoreInstallResult, String> {
    {
        // Held from reading config.yaml to copying the staged one over it, so a settings save landing in between
        // isn't overwritten by the copy made before it.
        let _config_guard = lock_core_config_file();
        migrate_core_config_for_update(install_dir, staging_dir)?;
        overlay_install_dir(install_dir, staging_dir)?;
    }
    if staged.bundled {
        mark_bundled_core_version_handled(install_dir, &staged.version)?;
    }
    if let Some(download_dir) = &staged.download_dir {
        let _ = fs::remove_dir_all(download_dir);
    }
    Ok(CoreInstallResult {
        version: staged.version.clone(),
        asset_name: staged.asset_name.clone(),
        install_dir: path_to_string(install_dir),
        binary_path: Some(path_to_string(&install_dir.join(&staged.binary_relative_path))),
    })
}

fn pause_core_for_install(
    app: &tauri::AppHandle,
    process_state: &CoreProcessState,
    config: &GuiConfigFile,
) -> Result<bool, String> {
    let was_running = current_core_status(Some(process_state), Some(config.port))?.running;
    if was_running {
        stop_core_process_inner(process_state)?;
        emit_current_core_status(app, process_state, config.port);
    }
    Ok(was_running)
}

fn restore_core_after_install<T>(
    app: &tauri::AppHandle,
    process_state: &CoreProcessState,
    config: &GuiConfigFile,
    was_running: bool,
    install_result: Result<T, String>,
) -> Result<T, String> {
    let restart_result = if was_running {
        start_core_process_inner(process_state, config)
    } else {
        Ok(())
    };
    emit_current_core_status(app, process_state, config.port);
    combine_install_and_restart_results(install_result, restart_result)
}

pub(crate) fn combine_install_and_restart_results<T>(
    install_result: Result<T, String>,
    restart_result: Result<(), String>,
) -> Result<T, String> {
    match (install_result, restart_result) {
        (Ok(result), Ok(())) => Ok(result),
        (Ok(_), Err(restart_error)) => {
            Err(format!("Core installed, but failed to automatically resume running: {restart_error}"))
        }
        (Err(install_error), Ok(())) => Err(install_error),
        (Err(install_error), Err(restart_error)) => Err(format!(
            "{install_error}; also failed to restore the original core running state: {restart_error}"
        )),
    }
}

fn emit_current_core_status(app: &tauri::AppHandle, process_state: &CoreProcessState, port: u16) {
    if let Ok(status) = current_core_status(Some(process_state), Some(port)) {
        emit_core_status(app, &status);
    }
}

#[tauri::command]
pub(crate) async fn start_core_process(app: tauri::AppHandle) -> Result<CoreStatus, String> {
    run_core_command(app, start_core_process_with_state).await
}

pub(crate) fn start_core_process_with_state(
    process_state: &CoreProcessState,
    gui_config_state: &GuiConfigState,
) -> Result<CoreStatus, String> {
    let config = gui_config_state.refresh_core_settings()?;
    start_core_process_inner(process_state, &config)?;
    if let Err(error) = gui_config_state.set_run_on_startup(true) {
        let _ = stop_core_process_inner(process_state);
        return Err(error);
    }
    current_core_status(Some(process_state), Some(config.port))
}

#[tauri::command]
pub(crate) async fn stop_core_process(app: tauri::AppHandle) -> Result<CoreStatus, String> {
    run_core_command(app, stop_core_process_with_state).await
}

pub(crate) fn stop_core_process_with_state(
    process_state: &CoreProcessState,
    gui_config_state: &GuiConfigState,
) -> Result<CoreStatus, String> {
    stop_core_process_inner(process_state)?;
    let config = gui_config_state.set_run_on_startup(false)?;
    current_core_status(Some(process_state), Some(config.port))
}

#[tauri::command]
pub(crate) async fn restart_core_process(app: tauri::AppHandle) -> Result<CoreStatus, String> {
    run_core_command(app, restart_core_process_with_state).await
}

pub(crate) fn restart_core_process_with_state(
    process_state: &CoreProcessState,
    gui_config_state: &GuiConfigState,
) -> Result<CoreStatus, String> {
    let _ = stop_core_process_inner(process_state);
    // Read once the core is down: host and port changed in config.yaml while it ran are taken up now.
    let config = gui_config_state.refresh_core_settings()?;
    start_core_process_inner(process_state, &config)?;
    if let Err(error) = gui_config_state.set_run_on_startup(true) {
        let _ = stop_core_process_inner(process_state);
        return Err(error);
    }
    current_core_status(Some(process_state), Some(config.port))
}

pub(crate) async fn stage_core_version(
    window: &tauri::Window,
    state: &CoreDownloadState,
    token: CancellationToken,
    version: Option<String>,
    proxy_url: &str,
) -> Result<StagedCore, String> {
    let platform = current_core_platform()?;
    let client = http_client(proxy_url)?;
    state.progress(window, "preparing-download", 0, None, true);
    let release = fetch_release_cancelable(&client, version.as_deref(), &token).await?;
    let asset = select_release_asset(&release, &platform)?;

    let install_dir = core_install_dir()?;
    let staging_dir = core_staging_dir()?;
    let download_dir = core_base_dir()?.join("cpa-core.download");

    reset_dir(&staging_dir)?;
    reset_dir(&download_dir)?;

    let archive_file_name = Path::new(&asset.name)
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .ok_or_else(|| format!("Invalid asset filename: {}", asset.name))?;
    let archive_path = download_dir.join(archive_file_name);

    let downloaded = download_asset(&client, asset, &archive_path, window, state, &token).await?;
    validate_downloaded_asset(asset, &downloaded)?;
    // The archive is about to be unpacked and run, so it has to match the checksum the release
    // publishes on GitHub. Release lookups carry no digest of their own.
    state.progress(window, "verifying", downloaded.size, Some(downloaded.size), true);
    let checksum_url = release_checksum_url(&release.tag_name);
    let verified = fetch_release_checksum(&client, &checksum_url, &asset.name, &token)
        .await
        .and_then(|expected| {
            validate_download_metadata(downloaded.size, None, &downloaded.sha256, Some(&expected))
        });
    if let Err(error) = verified {
        let _ = fs::remove_file(&archive_path);
        return Err(error);
    }

    ensure_not_canceled(&token, Some(&archive_path))?;
    state.progress(
        window,
        "extracting",
        downloaded.size,
        Some(downloaded.size),
        false,
    );
    match platform.archive_kind.as_str() {
        "tar.gz" => extract_tar_gz(&archive_path, &staging_dir)?,
        "zip" => extract_zip(&archive_path, &staging_dir)?,
        other => return Err(format!("Unsupported archive type: {other}")),
    }
    ensure_not_canceled(&token, Some(&archive_path))?;

    let binary_path = find_core_binary(&staging_dir)
        .ok_or_else(|| "The core's program wasn't in the download".to_string())?;
    let binary_relative_path = binary_path
        .strip_prefix(&staging_dir)
        .map_err(|err| format!("Failed to determine core binary relative path: {err}"))?
        .to_path_buf();
    // Merged now to catch a config that can't be migrated before anything stops, and again at the swap.
    migrate_core_config_for_update(&install_dir, &staging_dir)?;
    preserve_bundled_core_assets(&install_dir, &staging_dir)?;
    write_core_metadata(
        &staging_dir,
        &CoreMetadata {
            version: normalize_version(&release.tag_name),
            asset_name: asset.name.clone(),
            installed_at_unix: unix_now(),
        },
    )?;
    ensure_not_canceled(&token, Some(&archive_path))?;

    Ok(StagedCore {
        version: normalize_version(&release.tag_name),
        asset_name: asset.name.clone(),
        binary_relative_path,
        bundled: false,
        download_dir: Some(download_dir),
    })
}

pub(crate) fn stage_bundled_core(
    window: &tauri::Window,
    state: &CoreDownloadState,
    info: &BundledCoreInfo,
    archive_path: &Path,
) -> Result<StagedCore, String> {
    let platform = current_core_platform()?;
    let install_dir = core_install_dir()?;
    let staging_dir = core_staging_dir()?;

    let archive_size = fs::metadata(archive_path)
        .map_err(|error| format!("Failed to read bundled core archive: {error}"))?
        .len();
    state.progress(window, "preparing-bundled", 0, Some(archive_size), false);
    validate_bundled_core_checksum(archive_path)?;
    reset_dir(&staging_dir)?;
    state.progress(
        window,
        "extracting",
        archive_size,
        Some(archive_size),
        false,
    );
    match platform.archive_kind.as_str() {
        "tar.gz" => extract_tar_gz(archive_path, &staging_dir)?,
        "zip" => extract_zip(archive_path, &staging_dir)?,
        other => return Err(format!("Unsupported bundled archive type: {other}")),
    }

    let binary_path = find_core_binary(&staging_dir)
        .ok_or_else(|| "The core bundled with Arbor is missing its program".to_string())?;
    let binary_relative_path = binary_path
        .strip_prefix(&staging_dir)
        .map_err(|error| format!("Failed to determine bundled core binary path: {error}"))?
        .to_path_buf();
    // Merged now to catch a config that can't be migrated before anything stops, and again at the swap.
    migrate_core_config_for_update(&install_dir, &staging_dir)?;
    preserve_bundled_core_assets(&install_dir, &staging_dir)?;
    preserve_selected_bundled_core_asset(archive_path, &staging_dir)?;
    write_core_metadata(
        &staging_dir,
        &CoreMetadata {
            version: info.version.clone(),
            asset_name: info.asset_name.clone(),
            installed_at_unix: unix_now(),
        },
    )?;

    Ok(StagedCore {
        version: info.version.clone(),
        asset_name: info.asset_name.clone(),
        binary_relative_path,
        bundled: true,
        download_dir: None,
    })
}

pub(crate) async fn fetch_release(
    client: &reqwest::Client,
    version: Option<&str>,
) -> Result<GithubRelease, String> {
    match version {
        Some(version) => Ok(release_from_tag(version)),
        None => fetch_release_from_github(client).await,
    }
}

pub(crate) async fn fetch_release_from_github(client: &reqwest::Client) -> Result<GithubRelease, String> {
    let atom_result = fetch_release_from_atom(client).await;
    match atom_result {
        Ok(release) => Ok(release),
        Err(atom_error) => fetch_release_from_page(client)
            .await
            .map_err(|page_error| {
                format!("GitHub release feed request failed: {atom_error}; release page request failed: {page_error}")
            }),
    }
}

pub(crate) async fn fetch_release_from_page(client: &reqwest::Client) -> Result<GithubRelease, String> {
    let response = client
        .get(RELEASE_PAGE_URL)
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|err| format!("GitHub release page request failed: {err}"))?;
    let status = response.status();
    let final_url = response.url().clone();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .map_err(|err| format!("Failed to read GitHub release page: {err}"))?;
        return Err(format_github_error(status.as_u16(), &body));
    }

    let tag = release_tag_from_url(&final_url)
        .ok_or_else(|| "GitHub release page did not return a version tag".to_string())?;
    Ok(release_from_tag(&tag))
}

pub(crate) async fn fetch_release_from_atom(client: &reqwest::Client) -> Result<GithubRelease, String> {
    let response = client
        .get(RELEASE_ATOM_URL)
        .header(
            reqwest::header::ACCEPT,
            "application/atom+xml,application/xml,text/xml",
        )
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|err| format!("GitHub Atom feed request failed: {err}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Failed to read GitHub Atom feed: {err}"))?;
    if !status.is_success() {
        return Err(format_github_error(status.as_u16(), &body));
    }
    let tag = release_tag_from_atom(&body)
        .ok_or_else(|| "GitHub Atom feed did not return a version tag".to_string())?;
    let mut release = release_from_tag(&tag);
    release.release_notes = release_notes_from_atom(&body);
    Ok(release)
}

pub(crate) fn release_tag_from_atom(xml: &str) -> Option<String> {
    atom_entry_tag(xml.split_once("<entry>")?.1)
}

/// An Atom entry's release tag: from its release link, or failing that its title.
pub(crate) fn atom_entry_tag(entry: &str) -> Option<String> {
    if let Some(tag_path) = entry.split_once("/releases/tag/").map(|(_, value)| value) {
        let tag = tag_path
            .split(['\"', '<', '?', '#'])
            .next()
            .unwrap_or_default()
            .trim_matches('/');
        if !tag.is_empty() {
            return Some(normalize_version(tag));
        }
    }
    let title = entry
        .split_once("<title>")?
        .1
        .split_once("</title>")?
        .0
        .trim();
    (!title.is_empty()).then(|| normalize_version(title))
}

pub(crate) fn release_from_tag(tag: &str) -> GithubRelease {
    let tag = normalize_version(tag);
    let version = tag.trim_start_matches('v');
    let assets = [
        ("linux", "amd64", "tar.gz"),
        ("linux", "aarch64", "tar.gz"),
        ("darwin", "amd64", "tar.gz"),
        ("darwin", "aarch64", "tar.gz"),
        ("windows", "amd64", "zip"),
        ("windows", "aarch64", "zip"),
    ]
    .into_iter()
    .map(|(os, arch, extension)| {
        let name = format!("CLIProxyAPI_{version}_{os}_{arch}.{extension}");
        GithubAsset {
            browser_download_url: format!("{RELEASE_DOWNLOAD_PREFIX}{tag}/{name}"),
            name,
            size: None,
            digest: None,
        }
    })
    .collect();
    GithubRelease {
        tag_name: tag,
        assets,
        release_notes: Vec::new(),
    }
}

pub(crate) fn release_tag_from_url(url: &reqwest::Url) -> Option<String> {
    let mut segments = url.path_segments()?;
    let tag = segments.next_back()?.trim();
    if tag.is_empty() || tag == "latest" {
        None
    } else {
        Some(tag.to_string())
    }
}

pub(crate) fn is_app_update_available(current: &str, latest: &str) -> Result<bool, String> {
    let parse = |value: &str| {
        semver::Version::parse(value.trim().trim_start_matches('v'))
            .map_err(|error| format!("Failed to parse version {value}: {error}"))
    };
    Ok(parse(latest)? > parse(current)?)
}

pub(crate) fn format_github_error(status: u16, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(message) = value.get("message").and_then(|item| item.as_str()) {
            return format!("GitHub returned an error ({status}): {}", message.trim());
        }
    }
    let body = body.trim();
    if body.is_empty() {
        format!("GitHub returned an error ({status})")
    } else {
        format!("GitHub returned an error ({status}): {}", truncate_for_error(body))
    }
}

pub(crate) async fn fetch_release_cancelable(
    client: &reqwest::Client,
    version: Option<&str>,
    token: &CancellationToken,
) -> Result<GithubRelease, String> {
    tokio::select! {
        result = fetch_release(client, version) => result,
        _ = token.cancelled() => Err("Download canceled".to_string()),
    }
}

pub(crate) fn apply_configured_proxy(
    builder: reqwest::ClientBuilder,
    proxy_url: &str,
) -> Result<reqwest::ClientBuilder, String> {
    let proxy_url = proxy_url.trim();
    if proxy_url.is_empty() {
        return Ok(builder);
    }
    let proxy =
        reqwest::Proxy::all(proxy_url).map_err(|error| format!("Invalid proxy URL: {error}"))?;
    Ok(builder.proxy(proxy))
}

pub(crate) fn build_http_client_with_proxy(
    builder: reqwest::ClientBuilder,
    proxy_url: &str,
    error_prefix: &str,
) -> Result<reqwest::Client, String> {
    apply_configured_proxy(builder, proxy_url)
        .map_err(|error| format!("{error_prefix}: {error}"))?
        .build()
        .map_err(|error| format!("{error_prefix}: {error}"))
}

pub(crate) fn http_client(proxy_url: &str) -> Result<reqwest::Client, String> {
    build_http_client_with_proxy(
        reqwest::Client::builder()
            .redirect(github_release_redirect_policy())
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(600)),
        proxy_url,
        "Failed to create HTTP client",
    )
}

pub(crate) fn select_release_asset<'a>(
    release: &'a GithubRelease,
    platform: &CorePlatform,
) -> Result<&'a GithubAsset, String> {
    let expected_name = core_release_asset_name(&release.tag_name, platform);
    let mut matches = release
        .assets
        .iter()
        .filter(|asset| asset.name == expected_name && !asset.name.contains("_no-plugin"));
    let asset = matches
        .next()
        .ok_or_else(|| format!("No release asset found for the current platform: {expected_name}"))?;

    if matches.next().is_some() {
        return Err(format!("Multiple matching release assets found: {expected_name}"));
    }

    Ok(asset)
}

pub(crate) fn core_release_asset_name(version: &str, platform: &CorePlatform) -> String {
    let version = normalize_version(version);
    let version = version.trim_start_matches('v');
    format!(
        "CLIProxyAPI_{}_{}_{}.{}",
        version, platform.asset_os, platform.asset_arch, platform.archive_kind
    )
}

/// Downloads the release archive from GitHub. Nothing half-written is left behind when it fails or is canceled.
pub(crate) async fn download_asset(
    client: &reqwest::Client,
    asset: &GithubAsset,
    archive_path: &Path,
    window: &tauri::Window,
    state: &CoreDownloadState,
    token: &CancellationToken,
) -> Result<DownloadedArchive, String> {
    let result = download_asset_inner(
        client,
        &asset.browser_download_url,
        archive_path,
        asset.size,
        asset.digest.as_deref(),
        window,
        state,
        token,
    )
    .await;
    if result.is_err() {
        let _ = fs::remove_file(archive_path);
    }
    result
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_asset_inner(
    client: &reqwest::Client,
    url: &str,
    archive_path: &Path,
    expected_total: Option<u64>,
    expected_digest: Option<&str>,
    window: &tauri::Window,
    state: &CoreDownloadState,
    token: &CancellationToken,
) -> Result<DownloadedArchive, String> {
    state.progress(window, "preparing-download", 0, expected_total, true);
    ensure_not_canceled(token, Some(archive_path))?;

    let request = client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send();
    let response = tokio::select! {
        response = request => response.map_err(|err| format!("Failed to download core archive: {err}"))?,
        _ = token.cancelled() => return Err("Download canceled".to_string()),
    }
    .error_for_status()
    .map_err(|err| format!("Download URL returned an error status: {err}"))?;
    let total = expected_total.or_else(|| response.content_length());
    let mut stream = response.bytes_stream();
    let mut file =
        File::create(archive_path).map_err(|err| format!("Failed to create core archive: {err}"))?;
    let mut downloaded = 0_u64;
    let mut hasher = Sha256::new();
    let mut progress = crate::progress::ProgressThrottle::default();

    while let Some(chunk) = tokio::select! {
        chunk = stream.next() => chunk,
        _ = token.cancelled() => return Err("Download canceled".to_string()),
    } {
        ensure_not_canceled(token, Some(archive_path))?;

        let chunk = chunk.map_err(|err| format!("Failed to read download data: {err}"))?;
        file.write_all(&chunk)
            .map_err(|err| format!("Failed to save download data: {err}"))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        if progress.ready(Instant::now(), total == Some(downloaded)) {
            state.progress(window, "downloading", downloaded, total, true);
        }
    }

    state.progress(window, "downloading", downloaded, total, true);
    file.flush()
        .map_err(|err| format!("Failed to flush core archive: {err}"))?;
    ensure_not_canceled(token, Some(archive_path))?;

    let sha256 = format!("{:x}", hasher.finalize());
    validate_download_metadata(downloaded, expected_total, &sha256, expected_digest)?;

    Ok(DownloadedArchive {
        size: downloaded,
        sha256,
    })
}

pub(crate) fn ensure_not_canceled(
    token: &CancellationToken,
    archive_path: Option<&Path>,
) -> Result<(), String> {
    if token.is_cancelled() {
        if let Some(archive_path) = archive_path {
            let _ = fs::remove_file(archive_path);
        }

        return Err("Download canceled".to_string());
    }

    Ok(())
}

pub(crate) fn current_core_platform() -> Result<CorePlatform, String> {
    let os = env::consts::OS;
    let arch = env::consts::ARCH;

    let (asset_os, archive_kind) = match os {
        "linux" => ("linux", "tar.gz"),
        "macos" => ("darwin", "tar.gz"),
        "windows" => ("windows", "zip"),
        other => return Err(format!("Unsupported operating system: {other}")),
    };

    let asset_arch = match arch {
        "x86_64" => "amd64",
        "aarch64" => "aarch64",
        other => return Err(format!("Unsupported CPU architecture: {other}")),
    };

    Ok(CorePlatform {
        os: os.to_string(),
        arch: arch.to_string(),
        asset_os: asset_os.to_string(),
        asset_arch: asset_arch.to_string(),
        archive_kind: archive_kind.to_string(),
    })
}

pub(crate) fn current_core_status(
    process_state: Option<&CoreProcessState>,
    management_port: Option<u16>,
) -> Result<CoreStatus, String> {
    let install_dir = core_install_dir()?;
    let binary_path = find_core_binary(&install_dir);
    let installed = binary_path.is_some();
    let starting = process_state.is_some_and(CoreProcessState::is_starting);
    let managed_pid = process_state.and_then(|state| state.managed_pid());
    let management_port_open = management_port.map(is_management_port_open);
    let process_id = match managed_pid {
        Some(process_id) => Some(process_id),
        None if management_port_open.unwrap_or(true) => binary_path
            .as_ref()
            .and_then(|path| find_core_process_ids(path).first().copied()),
        None => None,
    };
    // A tracked process stays running even if a management-port probe misses. The probe still
    // gates discovery of an untracked process, but letting it override a known live PID would flip
    // the UI between running and stopped while it still showed that PID. Whether the core answers
    // on its port is reported separately as `ready`.
    let running = process_id.is_some();
    let ready = running && management_port_open.unwrap_or(true);
    let current_version = read_core_metadata(&install_dir).map(|metadata| metadata.version);

    let message = if starting {
        "The core is starting".to_string()
    } else if !installed {
        "The core isn't installed yet. Install it first.".to_string()
    } else if running {
        "The core is running".to_string()
    } else {
        "The core is installed and stopped".to_string()
    };

    Ok(CoreStatus {
        installed,
        running,
        ready,
        starting,
        managed: managed_pid.is_some(),
        process_id,
        current_version,
        install_dir: path_to_string(&install_dir),
        binary_path: binary_path.map(|path| path_to_string(&path)),
        message,
    })
}

pub(crate) fn is_management_port_open(port: u16) -> bool {
    let listen_host = read_installed_core_config_settings()
        .map(|settings| settings.host)
        .unwrap_or_else(|_| "127.0.0.1".to_string());
    let Ok(address) = core_management_address(&listen_host, port) else {
        return false;
    };
    // A busy core can miss a single short connect, so retry briefly before reporting it as not ready.
    for attempt in 0..3 {
        if TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok() {
            return true;
        }
        if attempt < 2 {
            thread::sleep(Duration::from_millis(50));
        }
    }
    false
}

fn core_management_address(listen_host: &str, port: u16) -> Result<SocketAddr, String> {
    let host = core_connect_host(listen_host);
    let ip = host
        .parse::<IpAddr>()
        .map_err(|_| format!("Invalid core listen IP: {listen_host}"))?;
    Ok(SocketAddr::new(ip, port))
}

pub(crate) enum CoreStartupFailure {
    Exited(std::process::ExitStatus),
    Spawn(String),
    StatusCheck(io::Error),
    TimedOut(u16),
}

impl CoreStartupFailure {
    fn child_has_exited(&self) -> bool {
        matches!(self, Self::Exited(_))
    }

    #[cfg(target_os = "macos")]
    fn was_killed_by_sigkill(&self) -> bool {
        use std::os::unix::process::ExitStatusExt;

        matches!(
            self,
            Self::Exited(status)
                if status.code().is_none() && status.signal() == Some(libc::SIGKILL)
        )
    }
}

impl std::fmt::Display for CoreStartupFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Exited(status) => write!(formatter, "The core quit as soon as it started: {status}"),
            Self::Spawn(error) => formatter.write_str(error),
            Self::StatusCheck(error) => write!(formatter, "Couldn't check whether the core started: {error}"),
            Self::TimedOut(port) => {
                write!(formatter, "The core didn't start: nothing answered on port {port} within 10 seconds")
            }
        }
    }
}

pub(crate) fn core_start_log_path(install_dir: &Path, auth_dir: &str) -> PathBuf {
    core_logs_dir_path(auth_dir, install_dir).join("core-start-output.log")
}

pub(crate) fn core_start_stdio(log_path: &Path) -> io::Result<(Stdio, Stdio)> {
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)?;
    }

    // Keep only the current process run so console output cannot grow without
    // bound across restarts. Both child handles use append mode to avoid their
    // independent file cursors overwriting each other's output.
    let mut header_file = File::options()
        .write(true)
        .create(true)
        .truncate(true)
        .open(log_path)?;
    writeln!(header_file, "===== CPA core startup {} =====", unix_now())?;
    drop(header_file);

    let stdout_file = File::options().append(true).open(log_path)?;
    let stderr_file = File::options().append(true).create(true).open(log_path)?;

    Ok((Stdio::from(stdout_file), Stdio::from(stderr_file)))
}

fn core_start_error_with_log(error: &str, log_path: &Path, log_error: Option<&str>) -> String {
    match log_error {
        Some(log_error) => format!(
            "{error}; failed to write startup log {}: {log_error}",
            path_to_string(log_path)
        ),
        None => format!("{error}; startup log: {}", path_to_string(log_path)),
    }
}

struct CoreStartAttemptFailure {
    failure: CoreStartupFailure,
    log_error: Option<String>,
}

impl CoreStartAttemptFailure {
    #[cfg(target_os = "macos")]
    fn was_killed_by_sigkill(&self) -> bool {
        self.failure.was_killed_by_sigkill()
    }

    fn message(&self, log_path: &Path) -> String {
        self.message_with_detail(log_path, None)
    }

    fn message_with_detail(&self, log_path: &Path, detail: Option<&str>) -> String {
        let error = match detail {
            Some(detail) => format!("{}；{detail}", self.failure),
            None => self.failure.to_string(),
        };
        core_start_error_with_log(&error, log_path, self.log_error.as_deref())
    }
}

fn start_core_process_once(
    binary_path: &Path,
    config_path: &str,
    install_dir: &Path,
    log_path: &Path,
    management_address: SocketAddr,
) -> Result<Child, CoreStartAttemptFailure> {
    let mut command = Command::new(binary_path);
    command
        .args(["-config", config_path])
        .current_dir(install_dir)
        .stdin(Stdio::null());
    let log_error = match core_start_stdio(log_path) {
        Ok((stdout, stderr)) => {
            command.stdout(stdout).stderr(stderr);
            None
        }
        Err(error) => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
            Some(error.to_string())
        }
    };
    configure_background_command(&mut command);

    let mut child = match spawn_core_child(command) {
        Ok(child) => child,
        Err(error) => {
            return Err(CoreStartAttemptFailure {
                failure: CoreStartupFailure::Spawn(error),
                log_error,
            });
        }
    };
    match wait_for_core_management_port(&mut child, management_address) {
        Ok(()) => Ok(child),
        Err(failure) => {
            if !failure.child_has_exited() {
                let _ = terminate_child(&mut child);
            }
            Err(CoreStartAttemptFailure { failure, log_error })
        }
    }
}

pub(crate) fn start_core_process_inner(
    process_state: &CoreProcessState,
    gui_config: &GuiConfigFile,
) -> Result<(), String> {
    let install_dir = core_install_dir()?;
    if !gui_config.auth_dir.trim().is_empty() {
        let auth_dir = auth_dir_path_for_core(&gui_config.auth_dir, &install_dir);
        fs::create_dir_all(&auth_dir)
            .map_err(|error| format!("Failed to create credentials directory {}: {error}", path_to_string(&auth_dir)))?;
    }
    let binary_path = find_core_binary(&install_dir)
        .ok_or_else(|| "The core isn't installed yet. Install it first.".to_string())?;

    let existing_process_ids = find_core_process_ids(&binary_path);
    if process_state.managed_pid().is_some() || !existing_process_ids.is_empty() {
        if !existing_process_ids.is_empty() {
            process_state.adopt_process_ids(&binary_path, existing_process_ids)?;
        }
        return Err("The core is already running".to_string());
    }
    let management_address = core_management_address(&gui_config.host, gui_config.port)?;
    if TcpStream::connect_timeout(&management_address, Duration::from_millis(250)).is_ok() {
        return Err(format!(
            "Port {} is in use by another application; please change the port and try again",
            gui_config.port
        ));
    }

    let config_path = merge_core_config_for_start(&install_dir, gui_config)?;
    let config_path = path_to_string(&config_path);
    let log_path = core_start_log_path(&install_dir, &gui_config.auth_dir);
    let start_once = || {
        start_core_process_once(
            &binary_path,
            &config_path,
            &install_dir,
            &log_path,
            management_address,
        )
    };

    let child = match start_once() {
        Ok(child) => child,
        Err(failure) if failure.was_killed_by_sigkill() => {
            if let Err(heal_error) = rematerialize_core_binary(&binary_path) {
                return Err(failure.message_with_detail(
                    &log_path,
                    Some(&format!("Couldn't repair the core's files: {heal_error}")),
                ));
            }
            match start_once() {
                Ok(child) => child,
                Err(failure) if failure.was_killed_by_sigkill() => {
                    return Err(failure.message_with_detail(
                        &log_path,
                        Some("macOS stopped the core again. Reinstall it and try again."),
                    ));
                }
                Err(failure) => return Err(failure.message(&log_path)),
            }
        }
        Err(failure) => return Err(failure.message(&log_path)),
    };

    process_state.store_child(child)?;
    Ok(())
}

pub(crate) fn wait_for_core_management_port(
    child: &mut Child,
    address: SocketAddr,
) -> Result<(), CoreStartupFailure> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().map_err(CoreStartupFailure::StatusCheck)? {
            return Err(CoreStartupFailure::Exited(status));
        }
        if TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(CoreStartupFailure::TimedOut(address.port()));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// Readies a helper process that can outlive the moment it starts: the core, the update helper, the app it relaunches,
/// `open`. It gets none of Arbor's open files: they're marked here, and again in the new process just before it runs,
/// which catches a file another thread opened in between. That takes a fork where a quick helper doesn't (see
/// `keep_open_files_from_helpers`), which only these rare starts pay for.
pub(crate) fn configure_background_command(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    keep_open_files_from_helpers();
    // SAFETY: between fork and exec the closure only makes system calls, into a buffer on its own stack.
    unsafe {
        command.pre_exec(|| {
            keep_open_files_from_helpers();
            Ok(())
        });
    }
}

/// Marks every file Arbor has open, bar stdin, stdout and stderr, to close when a process starts, so a helper gets
/// only the stdio it's handed. Apple's frameworks leave the files they open inheritable, and Rust marks a socket only
/// a moment after opening it. Unmarked, every helper gets what Arbor has open: the core keeps those files for as long
/// as it runs, across Arbor updates, and an ssh can hold one of Arbor's listening ports. Marked in Arbor, a helper
/// still starts the quick way (posix_spawn), which never hands over a file marked so.
#[cfg(target_os = "macos")]
pub(crate) fn keep_open_files_from_helpers() {
    const LISTED: usize = 4096;
    let mut files = [libc::proc_fdinfo { proc_fd: 0, proc_fdtype: 0 }; LISTED];
    let entry = std::mem::size_of::<libc::proc_fdinfo>();
    // SAFETY: the buffer holds LISTED entries, as the size passed with it says.
    let bytes = unsafe {
        libc::proc_pidinfo(libc::getpid(), libc::PROC_PIDLISTFDS, 0, files.as_mut_ptr().cast(), (LISTED * entry) as libc::c_int)
    };
    let listed = usize::try_from(bytes).unwrap_or(0) / entry;
    let close_on_exec = |fd: libc::c_int| {
        // SAFETY: F_SETFD only sets a descriptor's flags, of which close-on-exec is the one; a closed one just fails.
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    };
    if listed == 0 || listed == LISTED {
        // Not all listed: every number a file could have.
        (3..unsafe { libc::getdtablesize() }).for_each(close_on_exec);
    } else {
        files[..listed].iter().map(|file| file.proc_fd).filter(|&fd| fd > 2).for_each(close_on_exec);
    }
}

pub(crate) fn stop_core_process_inner(process_state: &CoreProcessState) -> Result<(), String> {
    let mut stopped_any = false;
    let mut errors = Vec::new();

    if let Some(mut child) = process_state.take_child() {
        stopped_any = true;
        if let Err(error) = terminate_child(&mut child) {
            errors.push(error);
        }
    }

    let mut process_ids = process_state
        .take_adopted_processes()
        .into_iter()
        .filter(|process| {
            process_executable_path(process.process_id)
                .as_deref()
                .is_some_and(|path| executable_paths_match(&process.binary_path, path))
        })
        .map(|process| process.process_id)
        .collect::<Vec<_>>();
    if let Ok(install_dir) = core_install_dir() {
        if let Some(binary_path) = find_core_binary(&install_dir) {
            process_ids.extend(find_core_process_ids(&binary_path));
        }
    }
    process_ids.sort_unstable();
    process_ids.dedup();

    for process_id in process_ids {
        if !is_process_alive(process_id) {
            continue;
        }
        stopped_any = true;
        if let Err(error) = terminate_process_id(process_id) {
            errors.push(error);
        }
    }

    if !errors.is_empty() {
        Err(errors.join("；"))
    } else if stopped_any {
        Ok(())
    } else {
        Err("The core is stopped".to_string())
    }
}

pub(crate) fn core_install_dir() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join("cpa-core"))
}

pub(crate) fn executable_dir() -> Result<PathBuf, String> {
    let exe_path = env::current_exe().map_err(|err| format!("Failed to read current executable path: {err}"))?;
    exe_path
        .parent()
        .map(|path| path.to_path_buf())
        .ok_or_else(|| format!("The current executable path has no parent directory: {}", path_to_string(&exe_path)))
}

pub(crate) fn macos_app_resources_dir(executable_dir: &Path) -> Option<PathBuf> {
    if executable_dir.file_name().and_then(|name| name.to_str()) != Some("MacOS") {
        return None;
    }
    let contents_dir = executable_dir.parent()?;
    if contents_dir.file_name().and_then(|name| name.to_str()) != Some("Contents") {
        return None;
    }
    let app_dir = contents_dir.parent()?;
    if app_dir.extension().and_then(|extension| extension.to_str()) != Some("app") {
        return None;
    }
    Some(contents_dir.join("Resources"))
}

pub(crate) fn core_base_dir() -> Result<PathBuf, String> {
    let executable_dir = executable_dir()?;
    #[cfg(target_os = "macos")]
    if macos_app_resources_dir(&executable_dir).is_some() {
        let home_dir = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Cannot determine the macOS user directory".to_string())?;
        return Ok(crate::app_identity::macos_data_dir(&home_dir));
    }
    Ok(executable_dir)
}

pub(crate) fn bundled_core_locations(
    base_dir: &Path,
    executable_dir: &Path,
) -> Vec<(PathBuf, PathBuf)> {
    // The app's own Resources come first, so a stray core-version.txt left in the data folder can't pin an older core
    // over the one an update brought.
    let mut locations = Vec::new();
    if let Some(resources_dir) = macos_app_resources_dir(executable_dir) {
        locations.push((
            resources_dir.join(CORE_VERSION_FILE),
            resources_dir.join("cpa-core"),
        ));
    }
    locations.push((base_dir.join(CORE_VERSION_FILE), base_dir.join("cpa-core")));
    if let Some(project_root) = source_project_root(executable_dir) {
        if project_root != base_dir {
            locations.push((
                project_root.join(CORE_VERSION_FILE),
                project_root.join("cpa-core"),
            ));
        }
    }
    locations
}

pub(crate) fn bundled_core_archive() -> Result<Option<(BundledCoreInfo, PathBuf)>, String> {
    let platform = current_core_platform()?;
    let base_dir = core_base_dir()?;
    let executable_dir = executable_dir()?;
    let locations = bundled_core_locations(&base_dir, &executable_dir);

    let configured_version = locations.iter().find_map(|(version_path, _)| {
        fs::read_to_string(version_path)
            .ok()
            .map(|value| normalize_version(value.trim()))
            .filter(|value| value != "v")
    });
    if let Some(version) = configured_version {
        let asset_name = core_release_asset_name(&version, &platform);
        for (_, archive_dir) in &locations {
            let archive_path = archive_dir.join(&asset_name);
            if !archive_path.is_file() {
                continue;
            }
            let size_bytes = fs::metadata(&archive_path)
                .map_err(|error| format!("Failed to read bundled core information: {error}"))?
                .len();
            return Ok(Some((
                BundledCoreInfo {
                    version,
                    asset_name,
                    size_bytes,
                },
                archive_path,
            )));
        }
        return Ok(None);
    }

    let suffix = format!(
        "_{}_{}.{}",
        platform.asset_os, platform.asset_arch, platform.archive_kind
    );
    let mut matches = Vec::new();
    for (_, archive_dir) in &locations {
        if !archive_dir.is_dir() {
            continue;
        }
        for entry in fs::read_dir(archive_dir)
            .map_err(|error| format!("Failed to read bundled core directory: {error}"))?
            .filter_map(Result::ok)
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !entry.path().is_file()
                || !name.starts_with("CLIProxyAPI_")
                || !name.ends_with(&suffix)
                || name.contains("_no-plugin")
            {
                continue;
            }
            let Some(version) = name
                .strip_prefix("CLIProxyAPI_")
                .and_then(|value| value.strip_suffix(&suffix))
            else {
                continue;
            };
            let version = normalize_version(version);
            if matches.iter().any(|(existing, _, _)| existing == &version) {
                continue;
            }
            matches.push((version, name, entry.path()));
        }
    }
    matches.sort_by(|left, right| left.0.cmp(&right.0));
    if matches.len() > 1 {
        return Err(format!(
            "Multiple bundled cores match the current platform; please specify the release version in {}",
            CORE_VERSION_FILE
        ));
    }
    let Some((version, asset_name, archive_path)) = matches.pop() else {
        return Ok(None);
    };
    let size_bytes = fs::metadata(&archive_path)
        .map_err(|error| format!("Failed to read bundled core information: {error}"))?
        .len();
    Ok(Some((
        BundledCoreInfo {
            version,
            asset_name,
            size_bytes,
        },
        archive_path,
    )))
}

pub(crate) fn source_project_root(start: &Path) -> Option<PathBuf> {
    start.ancestors().find_map(|directory| {
        (directory.join("package.json").is_file() && directory.join("src-tauri").is_dir())
            .then(|| directory.to_path_buf())
    })
}

/// The arbor-models core plugin (see `core_config::extra_models`) as this build bundles it. The core's plugins folder
/// gets a copy per provider, named by `extra_models_plugin_file`.
pub(crate) const EXTRA_MODELS_PLUGIN_FILE: &str = "arbor-models.dylib";

/// Where this build keeps the arbor-models plugin: the app's Resources, or, run from the source tree, what the release
/// script or a `cargo build` of `core-plugins/arbor-models` left there.
pub(crate) fn bundled_core_plugin_locations(executable_dir: &Path) -> Vec<PathBuf> {
    let mut locations = Vec::new();
    if let Some(resources_dir) = macos_app_resources_dir(executable_dir) {
        locations.push(resources_dir.join("cpa-core").join("plugins").join(EXTRA_MODELS_PLUGIN_FILE));
    }
    if let Some(project_root) = source_project_root(executable_dir) {
        locations.push(project_root.join("cpa-core").join("plugins").join(EXTRA_MODELS_PLUGIN_FILE));
        locations.push(
            project_root
                .join("core-plugins")
                .join("arbor-models")
                .join("target")
                .join("release")
                .join("libarbor_models.dylib"),
        );
    }
    locations
}

/// Puts the first plugin in `sources` that's there into `plugins_dir` as `file_name`, when it isn't there already. A
/// core that has the old one loaded keeps it until it restarts: the copy replaces the file rather than writing into it
/// (see `copy_core_file_replace`), which also keeps each provider's copy its own file, as the core needs. Says whether
/// it copied one.
pub(crate) fn install_core_plugin_at(sources: &[PathBuf], plugins_dir: &Path, file_name: &str) -> Result<bool, String> {
    let Some(source) = sources.iter().find(|source| source.is_file()) else {
        return Ok(false);
    };
    let target = plugins_dir.join(file_name);
    if target.is_file() && sha256_file(&target)? == sha256_file(source)? {
        return Ok(false);
    }
    copy_core_file_replace(source, &target)?;
    Ok(true)
}

/// Brings every provider's copy of the plugins this build bundles in the core's plugins folder up to date, once
/// Arbor has updated. A provider without one gets it when its first extra model is added.
pub(crate) fn refresh_installed_core_plugins_at(sources: &[PathBuf], plugins_dir: &Path) -> Result<bool, String> {
    let mut installed = false;
    for provider in EXTRA_MODEL_PROVIDERS {
        let file_name = extra_models_plugin_file(provider);
        if plugins_dir.join(&file_name).is_file() {
            installed |= install_core_plugin_at(sources, plugins_dir, &file_name)?;
        }
    }
    Ok(installed)
}

pub(crate) fn install_bundled_core_plugins() -> Result<bool, String> {
    refresh_installed_core_plugins_at(
        &bundled_core_plugin_locations(&executable_dir()?),
        &core_install_dir()?.join("plugins"),
    )
}

/// Installs `provider`'s copy of the extra models plugin. Plugins stay off in the core until an extra model turns them
/// on.
pub(crate) fn install_extra_models_plugin(provider: &str) -> Result<bool, String> {
    install_core_plugin_at(
        &bundled_core_plugin_locations(&executable_dir()?),
        &core_install_dir()?.join("plugins"),
        &extra_models_plugin_file(provider),
    )
}

pub(crate) fn preserve_bundled_core_assets(
    source_dir: &Path,
    target_dir: &Path,
) -> Result<(), String> {
    if !source_dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(source_dir)
        .map_err(|error| format!("Failed to read bundled core file: {error}"))?
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_archive = name.starts_with("CLIProxyAPI_")
            && (name.ends_with(".tar.gz") || name.ends_with(".zip"))
            && !name.contains("_no-plugin");
        if !is_archive && name != CORE_CHECKSUMS_FILE {
            continue;
        }
        fs::copy(&path, target_dir.join(&name))
            .map_err(|error| format!("Failed to preserve bundled core file {name}: {error}"))?;
    }
    Ok(())
}

pub(crate) fn preserve_selected_bundled_core_asset(
    archive_path: &Path,
    target_dir: &Path,
) -> Result<(), String> {
    let archive_name = archive_path
        .file_name()
        .ok_or_else(|| "Invalid bundled core archive filename".to_string())?;
    fs::copy(archive_path, target_dir.join(archive_name))
        .map_err(|error| format!("Failed to preserve selected bundled core archive: {error}"))?;
    if let Some(source_dir) = archive_path.parent() {
        let checksums = source_dir.join(CORE_CHECKSUMS_FILE);
        if checksums.is_file() {
            fs::copy(&checksums, target_dir.join(CORE_CHECKSUMS_FILE))
                .map_err(|error| format!("Failed to preserve bundled core checksum file: {error}"))?;
        }
    }
    Ok(())
}

pub(crate) fn migrate_core_config_for_update(
    source_dir: &Path,
    target_dir: &Path,
) -> Result<(), String> {
    if !source_dir.is_dir() {
        return Ok(());
    }
    let old_config_path = source_dir.join(CORE_CONFIG_FILE);
    let old_config = match fs::read_to_string(&old_config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Could not read the current core configuration {}, so the update was canceled to avoid losing settings. Check config.yaml and try the update again: {error}",
                path_to_string(&old_config_path)
            ));
        }
    };
    let current = parse_core_config_for_update(&old_config_path, &old_config)?;

    // Every core start reads the template, so a new core without one isn't swapped in.
    let template_path = target_dir.join(CORE_EXAMPLE_CONFIG_FILE);
    if !template_path.is_file() {
        return Err(format!(
            "The new core is missing a configuration template; update canceled: {}",
            path_to_string(&template_path)
        ));
    }
    let migrated = match current {
        // The config carries over exactly as it is. The core uses its own default for anything the file leaves
        // out, and moves a legacy file to its current layout itself. Merged into the new template instead, every
        // example value the file didn't override went live: placeholder client keys, an empty management secret,
        // a host listening on every interface, usage statistics off, the example plugin config.
        Some(_) => old_config,
        // An empty or comment-only file holds no settings, so the new core starts from its template.
        None => {
            let template = fs::read_to_string(&template_path).map_err(|error| {
                format!(
                    "Failed to read new core configuration template {}: {error}",
                    path_to_string(&template_path)
                )
            })?;
            merge_core_config_value(&template, None)?
        }
    };
    let config_path = target_dir.join(CORE_CONFIG_FILE);
    fs::write(&config_path, migrated).map_err(|error| {
        format!(
            "Failed to write migrated new core configuration {}: {error}",
            path_to_string(&config_path)
        )
    })?;
    Ok(())
}

/// Parses the live config.yaml before a core update. The migration is all or nothing: merging only
/// the blocks that happen to parse would silently drop the rest (API keys, aliases, payload rules),
/// so anything that is not a YAML mapping cancels the update. An empty or comment-only file parses
/// to null and holds no settings, so the new template is used as is.
fn parse_core_config_for_update(
    path: &Path,
    content: &str,
) -> Result<Option<serde_norway::Value>, String> {
    let current = serde_norway::from_str::<serde_norway::Value>(content).map_err(|error| {
        format!(
            "The current core configuration {} is not valid YAML, so the update was canceled to avoid losing settings. Fix config.yaml and try the update again: {error}",
            path_to_string(path)
        )
    })?;
    match current {
        serde_norway::Value::Null => Ok(None),
        current if current.is_mapping() => Ok(Some(current)),
        _ => Err(format!(
            "The current core configuration {} is not a YAML mapping, so the update was canceled to avoid losing settings. Fix config.yaml and try the update again",
            path_to_string(path)
        )),
    }
}

pub(crate) fn validate_bundled_core_checksum(archive_path: &Path) -> Result<(), String> {
    let Some(directory) = archive_path.parent() else {
        return Err("Bundled core archive has no parent directory".to_string());
    };
    let checksums_path = directory.join(CORE_CHECKSUMS_FILE);
    if !checksums_path.is_file() {
        return Ok(());
    }
    let archive_name = archive_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid bundled core archive filename".to_string())?;
    let checksums = fs::read_to_string(&checksums_path)
        .map_err(|error| format!("Failed to read bundled core checksum file: {error}"))?;
    let Some(expected) = release_checksum_for(&checksums, archive_name) else {
        return Err(format!("Checksum file has no SHA-256 for {archive_name}"));
    };
    let actual = sha256_file(archive_path)?;
    if actual != expected {
        return Err("Bundled core archive SHA-256 verification failed".to_string());
    }
    Ok(())
}

/// The SHA-256 a release's `checksums.txt` lists for `archive_name`. Each line is `<sha256>  <file name>`.
pub(crate) fn release_checksum_for(checksums: &str, archive_name: &str) -> Option<String> {
    checksums.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let digest = fields.next()?;
        let name = fields.next()?.trim_start_matches('*');
        (name == archive_name
            && digest.len() == 64
            && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| digest.to_ascii_lowercase())
    })
}

pub(crate) fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("Failed to open checksum file: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read checksum file: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub(crate) fn read_core_metadata(install_dir: &Path) -> Option<CoreMetadata> {
    let metadata_path = install_dir.join(CORE_METADATA_FILE);
    let content = fs::read_to_string(metadata_path).ok()?;
    serde_json::from_str(&content).ok()
}

pub(crate) fn write_core_metadata(
    install_dir: &Path,
    metadata: &CoreMetadata,
) -> Result<(), String> {
    let metadata_path = install_dir.join(CORE_METADATA_FILE);
    let content = serde_json::to_string_pretty(metadata)
        .map_err(|err| format!("Failed to generate core metadata: {err}"))?;
    fs::write(metadata_path, content).map_err(|err| format!("Failed to write core metadata: {err}"))
}

pub(crate) fn validate_downloaded_asset(
    asset: &GithubAsset,
    downloaded: &DownloadedArchive,
) -> Result<(), String> {
    validate_download_metadata(
        downloaded.size,
        asset.size,
        &downloaded.sha256,
        asset.digest.as_deref(),
    )
}

/// Where the release publishes its `checksums.txt` on GitHub, the same place the archive comes from.
pub(crate) fn release_checksum_url(tag: &str) -> String {
    format!("{RELEASE_DOWNLOAD_PREFIX}{}/{CORE_CHECKSUMS_FILE}", normalize_version(tag))
}

/// A release lists a few dozen archives, so anything bigger isn't its checksum file.
const MAX_RELEASE_CHECKSUMS_BYTES: usize = 256 * 1024;

/// The SHA-256 the release publishes for `asset_name`. A checksum file that can't be read, or doesn't list the
/// archive, fails the install: nothing unverified is unpacked.
pub(crate) async fn fetch_release_checksum(
    client: &reqwest::Client,
    url: &str,
    asset_name: &str,
    token: &CancellationToken,
) -> Result<String, String> {
    let checksums = tokio::select! {
        result = fetch_release_checksums_text(client, url) => result,
        _ = token.cancelled() => return Err("Download canceled".to_string()),
    }
    .map_err(|error| {
        format!("Core download not verified: couldn't fetch the release's {CORE_CHECKSUMS_FILE} ({error})")
    })?;
    release_checksum_for(&checksums, asset_name).ok_or_else(|| {
        format!("Core download not verified: the release's {CORE_CHECKSUMS_FILE} has no SHA-256 for {asset_name}")
    })
}

async fn fetch_release_checksums_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("error status: {error}"))?;
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("read failed: {error}"))?;
        if body.len() + chunk.len() > MAX_RELEASE_CHECKSUMS_BYTES {
            return Err("file is too large".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| "file is not text".to_string())
}

pub(crate) fn validate_download_metadata(
    downloaded: u64,
    expected_total: Option<u64>,
    sha256: &str,
    expected_digest: Option<&str>,
) -> Result<(), String> {
    if let Some(expected_total) = expected_total {
        if downloaded != expected_total {
            return Err(format!(
                "Download size verification failed: got {downloaded} bytes, expected {expected_total} bytes"
            ));
        }
    }

    if let Some(expected_digest) = expected_digest {
        let expected = expected_digest
            .strip_prefix("sha256:")
            .unwrap_or(expected_digest)
            .to_ascii_lowercase();

        if !expected.is_empty() && sha256 != expected {
            return Err("Downloaded file SHA-256 verification failed".to_string());
        }
    }

    Ok(())
}

pub(crate) fn cleanup_core_work_dirs() -> Result<(), String> {
    let base_dir = core_base_dir()?;
    let mut last_error = None;

    for name in ["cpa-core.staging", "cpa-core.download"] {
        let path = base_dir.join(name);
        if path.exists() {
            if let Err(err) = fs::remove_dir_all(&path) {
                last_error = Some(format!("Failed to clean up temporary directory {}: {err}", path_to_string(&path)));
            }
        }
    }

    if let Some(error) = last_error {
        Err(error)
    } else {
        Ok(())
    }
}

pub(crate) fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub(crate) fn normalize_version(version: &str) -> String {
    let version = version.trim();

    if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    }
}

pub(crate) fn is_core_running(binary_path: &Path) -> bool {
    !find_core_process_ids(binary_path).is_empty()
}

pub(crate) fn find_core_process_ids(binary_path: &Path) -> Vec<u32> {
    find_candidate_core_process_ids()
        .into_iter()
        .filter(|process_id| {
            process_executable_path(*process_id)
                .as_deref()
                .is_some_and(|path| executable_paths_match(binary_path, path))
        })
        .collect()
}

pub(crate) fn executable_paths_match(expected: &Path, actual: &Path) -> bool {
    let expected = fs::canonicalize(expected).unwrap_or_else(|_| expected.to_path_buf());
    let actual = fs::canonicalize(actual).unwrap_or_else(|_| actual.to_path_buf());
    expected == actual
}

pub(crate) fn find_candidate_core_process_ids() -> Vec<u32> {
    Command::new("pgrep")
        .args(["-x", core_binary_name()])
        .output()
        .ok()
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| line.trim().parse::<u32>().ok())
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn process_executable_path(process_id: u32) -> Option<PathBuf> {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};

    extern "C" {
        fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, buffer_size: u32) -> i32;
    }

    let mut buffer = vec![0_u8; 4096];
    let length = unsafe {
        proc_pidpath(
            process_id.try_into().ok()?,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
        )
    };
    if length <= 0 {
        return None;
    }
    buffer.truncate(length as usize);
    Some(PathBuf::from(OsString::from_vec(buffer)))
}

pub(crate) fn adopt_existing_core_processes(
    process_state: &CoreProcessState,
) -> Result<Vec<u32>, String> {
    let install_dir = core_install_dir()?;
    let Some(binary_path) = find_core_binary(&install_dir) else {
        process_state.clear_adopted_processes()?;
        return Ok(Vec::new());
    };
    let process_ids = find_core_process_ids(&binary_path);
    process_state.adopt_process_ids(&binary_path, process_ids.clone())?;
    Ok(process_ids)
}

/// Whether quitting would stop a core: the one Arbor manages, or one running from its install folder.
pub(crate) fn managed_core_is_running(process_state: &CoreProcessState) -> bool {
    process_state.managed_pid().is_some()
        || core_install_dir()
            .ok()
            .and_then(|install_dir| find_core_binary(&install_dir))
            .is_some_and(|binary_path| is_core_running(&binary_path))
}

pub(crate) fn shutdown_managed_core(
    process_state: &CoreProcessState,
    gui_config_state: &GuiConfigState,
) {
    let was_running = managed_core_is_running(process_state);
    let _ = gui_config_state.set_run_on_startup(was_running);
    stop_core_for_exit(process_state);
}

/// Stops the core as Arbor quits, unless an app update kept it: then agents' requests carry on through the swap and
/// the new version adopts the core at launch.
pub(crate) fn stop_core_for_exit(process_state: &CoreProcessState) {
    if !process_state.is_kept_through_exit() {
        let _ = stop_core_process_inner(process_state);
    }
}

pub(crate) fn terminate_child(child: &mut Child) -> Result<(), String> {
    let process_id = child.id();
    send_process_signal(process_id, "TERM")?;

    for _ in 0..20 {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(err) => return Err(format!("Couldn't check the core's process: {err}")),
        }
    }

    child
        .kill()
        .map_err(|err| format!("Couldn't force the core to stop: {err}"))?;
    child
        .wait()
        .map_err(|err| format!("Couldn't wait for the core to stop: {err}"))?;

    Ok(())
}

pub(crate) fn terminate_process_id(process_id: u32) -> Result<(), String> {
    send_process_signal(process_id, "TERM")?;

    for _ in 0..20 {
        if !is_process_alive(process_id) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }

    send_process_signal(process_id, "KILL")
}

pub(crate) fn send_process_signal(process_id: u32, signal: &str) -> Result<(), String> {
    let status = Command::new("kill")
        .args([format!("-{signal}"), process_id.to_string()])
        .status()
        .map_err(|err| format!("Failed to send process signal: {err}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Failed to send process signal: PID {process_id}"))
    }
}

pub(crate) fn is_process_alive(process_id: u32) -> bool {
    let process_id = process_id.to_string();
    Command::new("kill")
        .args(["-0", &process_id])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub(crate) fn reset_dir(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_dir_all(path)
            .map_err(|err| format!("Failed to clean up directory {}: {err}", path_to_string(path)))?;
    }

    fs::create_dir_all(path).map_err(|err| format!("Failed to create directory {}: {err}", path_to_string(path)))
}

pub(crate) fn overlay_install_dir(install_dir: &Path, staging_dir: &Path) -> Result<(), String> {
    if !staging_dir.is_dir() {
        return Err(format!(
            "Core staging directory does not exist: {}",
            path_to_string(staging_dir)
        ));
    }

    if !install_dir.exists() {
        return fs::rename(staging_dir, install_dir)
            .map_err(|err| format!("Failed to install new core directory: {err}"));
    }
    if !install_dir.is_dir() {
        return Err(format!(
            "Core installation path is not a directory: {}",
            path_to_string(install_dir)
        ));
    }

    overlay_directory(staging_dir, install_dir)?;
    fs::remove_dir_all(staging_dir).map_err(|err| format!("Failed to clean up core staging directory: {err}"))
}

fn overlay_directory(source_dir: &Path, target_dir: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source_dir)
        .map_err(|err| format!("Failed to read core staging directory {}: {err}", path_to_string(source_dir)))?
    {
        let entry = entry.map_err(|err| format!("Failed to read core staging entry: {err}"))?;
        let source_path = entry.path();
        let target_path = target_dir.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|err| format!("Failed to read core staging entry type: {err}"))?;

        if file_type.is_dir() {
            if target_path.exists() && !target_path.is_dir() {
                return Err(format!(
                    "Cannot overwrite a file with a core directory of the same name: {}",
                    path_to_string(&target_path)
                ));
            }
            fs::create_dir_all(&target_path).map_err(|err| {
                format!(
                    "Failed to create core installation subdirectory {}: {err}",
                    path_to_string(&target_path)
                )
            })?;
            overlay_directory(&source_path, &target_path)?;
        } else if file_type.is_file() {
            if target_path.exists() && !target_path.is_file() {
                return Err(format!(
                    "Cannot overwrite a directory with a core file of the same name: {}",
                    path_to_string(&target_path)
                ));
            }
            copy_core_file_replace(&source_path, &target_path)?;
        } else {
            return Err(format!(
                "Core staging directory contains an unsupported entry: {}",
                path_to_string(&source_path)
            ));
        }
    }

    Ok(())
}

/// Copies through a sibling temporary file and atomically replaces the target.
///
/// In particular, do not change this to copy over an existing file:
/// macOS caches code-signature validation by vnode, so in-place updates can
/// leave an otherwise valid executable permanently rejected with SIGKILL.
pub(crate) fn copy_core_file_replace(source_path: &Path, target_path: &Path) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let parent = target_path.parent().ok_or_else(|| {
        format!(
            "Failed to overwrite core file {}: cannot determine parent directory",
            path_to_string(target_path)
        )
    })?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create core file directory {}: {error}", path_to_string(parent)))?;
    let file_name = target_path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "cpa-core".into());
    let temporary_path = parent.join(format!(
        ".{file_name}.replace.{}.{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));

    let replace_result = (|| -> io::Result<()> {
        fs::copy(source_path, &temporary_path)?;
        let temporary_file = File::options().write(true).open(&temporary_path)?;
        temporary_file.sync_all()?;
        drop(temporary_file);
        replace_file_atomically(&temporary_path, target_path)
    })();

    if let Err(error) = replace_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!(
            "Failed to overwrite core file {}: {error}",
            path_to_string(target_path)
        ));
    }

    Ok(())
}

pub(crate) fn rematerialize_core_binary(binary_path: &Path) -> Result<(), String> {
    // Replacing the path with an identical copy gives it a fresh vnode and
    // clears the macOS signature-cache state left by older in-place updates.
    copy_core_file_replace(binary_path, binary_path)
}

pub(crate) fn extract_tar_gz(archive_path: &Path, install_dir: &Path) -> Result<(), String> {
    let archive_file =
        File::open(archive_path).map_err(|err| format!("Failed to open tar.gz: {err}"))?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|err| format!("Failed to read tar.gz entry: {err}"))?;

    for entry in entries {
        let mut entry = entry.map_err(|err| format!("Failed to read tar.gz entry: {err}"))?;
        let entry_path = entry
            .path()
            .map_err(|err| format!("Failed to read tar.gz entry path: {err}"))?;
        let out_path = checked_archive_path(install_dir, entry_path.as_ref())?;
        let entry_type = entry.header().entry_type();

        if entry_type.is_dir() {
            fs::create_dir_all(&out_path).map_err(|err| format!("Failed to create directory: {err}"))?;
        } else if entry_type.is_file() {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|err| format!("Failed to create directory: {err}"))?;
            }
            entry
                .unpack(&out_path)
                .map_err(|err| format!("Failed to extract tar.gz file: {err}"))?;
        } else {
            return Err(format!(
                "tar.gz contains an unsupported entry type: {}",
                path_to_string(&out_path)
            ));
        }
    }

    Ok(())
}

pub(crate) fn extract_zip(archive_path: &Path, install_dir: &Path) -> Result<(), String> {
    let archive_file = File::open(archive_path).map_err(|err| format!("Failed to open zip: {err}"))?;
    let mut archive =
        ZipArchive::new(archive_file).map_err(|err| format!("Failed to read zip: {err}"))?;

    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|err| format!("Failed to read zip entry: {err}"))?;
        let enclosed_name = file
            .enclosed_name()
            .ok_or_else(|| format!("Unsafe zip entry path: {}", file.name()))?;
        let out_path = checked_archive_path(install_dir, &enclosed_name)?;

        if is_zip_symlink(&file) {
            return Err(format!("zip contains an unsupported symbolic link entry: {}", file.name()));
        }

        if file.is_dir() {
            fs::create_dir_all(&out_path).map_err(|err| format!("Failed to create directory: {err}"))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("Failed to create directory: {err}"))?;
        }

        let mut out_file = File::create(&out_path).map_err(|err| format!("Failed to create file: {err}"))?;
        io::copy(&mut file, &mut out_file).map_err(|err| format!("Failed to write file: {err}"))?;

        if let Some(mode) = file.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&out_path, fs::Permissions::from_mode(mode))
                .map_err(|err| format!("Failed to set file permissions: {err}"))?;
        }
    }

    Ok(())
}

pub(crate) fn checked_archive_path(base_dir: &Path, entry_path: &Path) -> Result<PathBuf, String> {
    if entry_path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!(
            "Unsafe archive entry path: {}",
            path_to_string(entry_path)
        ));
    }

    Ok(base_dir.join(entry_path))
}

pub(crate) fn is_zip_symlink(file: &zip::read::ZipFile<'_>) -> bool {
    file.unix_mode()
        .map(|mode| mode & 0o170000 == 0o120000)
        .unwrap_or(false)
}

pub(crate) fn find_core_binary(install_dir: &Path) -> Option<PathBuf> {
    let binary_path = install_dir.join(core_binary_name());
    if binary_path.is_file() {
        return Some(binary_path);
    }

    let mut dirs = vec![install_dir.to_path_buf()];

    while let Some(dir) = dirs.pop() {
        let entries = fs::read_dir(dir).ok()?;

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
            } else if path
                .file_name()
                .and_then(|file_name| file_name.to_str())
                .map(|file_name| file_name == core_binary_name())
                .unwrap_or(false)
            {
                return Some(path);
            }
        }
    }

    None
}

pub(crate) fn core_binary_name() -> &'static str {
    if env::consts::OS == "windows" {
        "cli-proxy-api.exe"
    } else {
        "cli-proxy-api"
    }
}

pub(crate) fn should_start_hidden(config: &GuiConfigFile) -> bool {
    config.silent_start
}

pub(crate) fn should_start_core_on_launch(config: &GuiConfigFile) -> bool {
    config.start_core_on_launch
}

pub(crate) fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

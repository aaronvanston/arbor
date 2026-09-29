use super::*;

pub(crate) const PORTABLE_UPDATE_HELPER_ACK_FILE: &str = "update-helper-started.ack";
const PORTABLE_UPDATE_HELPER_START_TIMEOUT: Duration = Duration::from_secs(10);

#[tauri::command]
pub(crate) fn get_version_source_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<VersionSourceSettings, String> {
    let config = gui_config_state.snapshot()?;
    Ok(version_source_settings(&config))
}

fn version_source_settings(config: &GuiConfigFile) -> VersionSourceSettings {
    VersionSourceSettings {
        source: config.selected_download_candidate().key(),
        custom_mirrors: config.custom_download_mirrors.clone(),
    }
}

#[tauri::command]
pub(crate) fn set_download_source(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    source: String,
) -> Result<VersionSourceSettings, String> {
    let candidate = if let Some(url) = source.strip_prefix("custom:") {
        VersionDownloadCandidate::custom(&normalize_custom_download_mirror_url(url)?)
    } else {
        VersionDownloadCandidate::builtin(
            VersionDownloadSource::from_str(&source)
                .filter(|source| *source != VersionDownloadSource::Custom)
                .ok_or_else(|| "Unsupported download source".to_string())?,
        )
    };
    let config = gui_config_state.set_download_candidate(candidate)?;
    Ok(version_source_settings(&config))
}

#[tauri::command]
pub(crate) fn add_custom_download_mirror(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    url: String,
) -> Result<VersionSourceSettings, String> {
    let url = normalize_custom_download_mirror_url(&url)?;
    let config = gui_config_state.update(|config| {
        if !config.custom_download_mirrors.contains(&url) {
            if config.custom_download_mirrors.len() >= 12 {
                return Err("A maximum of 12 custom mirrors can be added".to_string());
            }
            config.custom_download_mirrors.push(url.clone());
        }
        config.download_source = VersionDownloadSource::Custom;
        config.active_custom_download_mirror = url.clone();
        Ok(())
    })?;
    Ok(version_source_settings(&config))
}

#[tauri::command]
pub(crate) fn remove_custom_download_mirror(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    url: String,
) -> Result<VersionSourceSettings, String> {
    let url = normalize_custom_download_mirror_url(&url)?;
    let config = gui_config_state.update(|config| {
        config.custom_download_mirrors.retain(|item| item != &url);
        if config.download_source == VersionDownloadSource::Custom
            && config.active_custom_download_mirror == url
        {
            config.download_source = VersionDownloadSource::Github;
            config.active_custom_download_mirror.clear();
        }
        Ok(())
    })?;
    Ok(version_source_settings(&config))
}

pub(crate) fn persist_automatic_download_source_switch(
    app: &tauri::AppHandle,
    gui_config_state: &GuiConfigState,
    requested_source: &VersionDownloadCandidate,
    resolved_source: &VersionDownloadCandidate,
) -> Result<(), String> {
    let Some(config) =
        gui_config_state.switch_download_source_after_failure(requested_source, resolved_source)?
    else {
        return Ok(());
    };
    app.emit(
        VERSION_DOWNLOAD_SOURCE_CHANGED_EVENT,
        version_source_settings(&config),
    )
    .map_err(|error| format!("Failed to notify automatic download source switch: {error}"))
}

#[tauri::command]
pub(crate) fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    open_external_url_inner(&app, &url)
}

#[tauri::command]
pub(crate) async fn check_app_update(
    state: tauri::State<'_, AppUpdateState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<AppUpdateInfo, String> {
    let (info, _) = resolve_app_update(gui_config_state.inner()).await?;
    state.set_available(AppUpdateTask {
        phase: if info.update_available { AppUpdatePhase::Available } else { AppUpdatePhase::Idle },
        target_version: info.update_available.then(|| info.latest_version.clone()),
        total_bytes: info.download_size_bytes,
        ..AppUpdateTask::default()
    });
    Ok(info)
}

/// Reads the update feed: what's on offer, and what to download when this build can install it itself.
async fn resolve_app_update(
    gui_config_state: &GuiConfigState,
) -> Result<(AppUpdateInfo, Option<PendingAppUpdate>), String> {
    let _detection_guard = VERSION_SOURCE_DETECTION_LOCK.lock().await;
    // Arbor's own releases on GitHub; each asset's url is where the API serves that DMG.
    let manifest = {
        let config = gui_config_state.snapshot()?;
        let client = build_http_client_with_proxy(
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(8))
                .read_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(20)),
            &config.proxy_url,
            "Failed to create version check client",
        )?;
        let github_token = crate::release_feed::github_cli_token().await;
        crate::release_feed::fetch_release_feed(&client, &crate::release_feed::ARBOR_RELEASE_FEED, github_token.as_deref())
            .await?
    };
    let latest_version = normalize_version(&manifest.version);
    let current_version = normalize_version(env!("CARGO_PKG_VERSION"));
    let update_available = is_app_update_available(&current_version, &latest_version)?;
    let target = portable_update_target();
    let asset_catalog = manifest.full_assets.as_ref().unwrap_or(&manifest.assets);
    let asset = target.and_then(|(key, _)| asset_catalog.get(key)).cloned();
    let portable_support = target
        .map(|(_, arch)| validate_local_portable_app_manifest(arch))
        .transpose()?;
    let auto_update_supported = portable_support == Some(true) && asset.is_some();
    let unsupported_reason = if auto_update_supported {
        None
    } else if portable_support != Some(true) {
        Some("This application is not a portable version that supports automatic updates; please manually download the first supported version".to_string())
    } else {
        Some("The update manifest does not include the current platform or architecture".to_string())
    };

    let pending = if update_available && auto_update_supported {
        let (_, arch) = target.expect("portable target checked above");
        Some(PendingAppUpdate {
            version: latest_version.clone(),
            asset: asset.clone().expect("portable asset checked above"),
            arch: arch.to_string(),
        })
    } else {
        None
    };
    let releases = release_notes_from_manifest(manifest.releases.as_ref());
    let bundled_core_version = manifest
        .core_version
        .as_deref()
        .map(|version| version.trim().trim_start_matches('v'))
        .filter(|version| semver::Version::parse(version).is_ok())
        .map(str::to_string);
    let info = AppUpdateInfo {
        current_version,
        latest_version,
        update_available,
        releases,
        release_url: manifest.release_url,
        auto_update_supported,
        download_size_bytes: asset.map(|value| value.size_bytes),
        unsupported_reason,
        bundled_core_version,
    };
    Ok((info, pending))
}

pub(crate) fn release_https_redirect_policy_with_mirrors(
    custom_mirrors: &[String],
) -> reqwest::redirect::Policy {
    let custom_hosts = custom_mirrors
        .iter()
        .filter_map(|value| reqwest::Url::parse(value).ok())
        .filter_map(|url| url.host_str().map(str::to_string))
        .collect::<HashSet<_>>();
    reqwest::redirect::Policy::custom(move |attempt| {
        let url = attempt.url();
        let trusted_host = matches!(
            url.host_str(),
            Some(
                "github.com"
                    | "objects.githubusercontent.com"
                    | "release-assets.githubusercontent.com"
                    | "gh-proxy.com"
                    | "ghfast.top"
            )
        ) || url
            .host_str()
            .is_some_and(|host| custom_hosts.contains(host));
        if url.scheme() == "https"
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && trusted_host
        {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}

pub(crate) fn validate_portable_update_asset(asset: &PortableUpdateAsset) -> Result<(), String> {
    let url = reqwest::Url::parse(&asset.url).map_err(|_| "Invalid application update download URL".to_string())?;
    // Only Arbor's own release files.
    if !crate::release_feed::is_release_asset_api_url(&crate::release_feed::ARBOR_RELEASE_FEED, &asset.url)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Untrusted application update download URL".to_string());
    }
    validate_portable_update_asset_digest(asset)
}

/// A download's declared size and SHA-256 are usable: the download is checked against both.
pub(crate) fn validate_portable_update_asset_digest(asset: &PortableUpdateAsset) -> Result<(), String> {
    if asset.size_bytes == 0 || asset.size_bytes > 512 * 1024 * 1024 {
        return Err("Invalid application update package size".to_string());
    }
    let digest = asset.sha256.trim().to_ascii_lowercase();
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid application update SHA-256".to_string());
    }
    Ok(())
}

pub(crate) fn portable_update_target() -> Option<(&'static str, &'static str)> {
    let platform = portable_update_platform_key()?;
    let arch = match env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "aarch64",
        _ => return None,
    };
    match (platform, arch) {
        ("darwin", "amd64") => Some(("darwin-amd64", "amd64")),
        ("darwin", "aarch64") => Some(("darwin-aarch64", "aarch64")),
        _ => None,
    }
}

pub(crate) fn portable_update_platform_key() -> Option<&'static str> {
    match env::consts::OS {
        "macos" => Some("darwin"),
        _ => None,
    }
}

pub(crate) fn local_portable_app_manifest_path() -> Result<PathBuf, String> {
    let executable_dir = executable_dir()?;
    #[cfg(target_os = "macos")]
    if let Some(resources_dir) = macos_app_resources_dir(&executable_dir) {
        return Ok(resources_dir.join(PORTABLE_APP_MANIFEST_FILE));
    }
    Ok(executable_dir.join(PORTABLE_APP_MANIFEST_FILE))
}

pub(crate) fn validate_local_portable_app_manifest(expected_arch: &str) -> Result<bool, String> {
    let path = local_portable_app_manifest_path()?;
    if !path.is_file() {
        return Ok(false);
    }
    let contents =
        fs::read_to_string(&path).map_err(|error| format!("Failed to read portable version marker: {error}"))?;
    let manifest = serde_json::from_str::<PortableAppManifest>(&contents)
        .map_err(|error| format!("Failed to parse portable version marker: {error}"))?;
    Ok(manifest.schema_version == 1
        && manifest.application == "EasyCLIProxyAPI"
        && Some(manifest.platform.as_str()) == portable_update_platform_key()
        && manifest.arch == expected_arch
        && manifest.auto_update
        && normalize_version(&manifest.version) == normalize_version(env!("CARGO_PKG_VERSION")))
}

#[tauri::command]
pub(crate) fn get_app_update_task(state: tauri::State<'_, AppUpdateState>) -> AppUpdateTask {
    state.snapshot()
}

#[tauri::command]
pub(crate) fn cancel_app_update(state: tauri::State<'_, AppUpdateState>) -> Result<(), String> {
    let task = state.snapshot();
    if !task.running || !task.cancelable {
        return Err("The application update cannot be canceled at this stage".to_string());
    }
    state.cancel();
    Ok(())
}

#[tauri::command]
pub(crate) async fn start_app_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppUpdateState>,
) -> Result<(), String> {
    if portable_update_platform_key().is_none() {
        return Err("In-app automatic updates are not supported on this platform".to_string());
    }
    let token = CancellationToken::new();
    state.start(token.clone())?;
    let task = state.snapshot();
    let _ = app.emit(APP_UPDATE_PROGRESS_EVENT, task);
    let update_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = async {
            let state = update_app.state::<AppUpdateState>();
            let gui_config_state = update_app.state::<GuiConfigState>();
            let pending = refresh_app_update_for_install(state.inner(), &token, async {
                let (info, pending) = resolve_app_update(gui_config_state.inner()).await?;
                pending.ok_or_else(|| {
                    if info.update_available {
                        info.unsupported_reason
                            .unwrap_or_else(|| "This version can't install updates itself".to_string())
                    } else {
                        "There's no update to install anymore; check for updates again".to_string()
                    }
                })
            })
            .await?;
            let _ = update_app.emit(APP_UPDATE_PROGRESS_EVENT, state.snapshot());
            let config = gui_config_state.snapshot()?;
            download_and_stage_portable_app_update(
                &update_app,
                &pending,
                &token,
                &config.proxy_url,
                config.selected_download_candidate(),
            )
            .await
        }
        .await;
        if let Err(error) = outcome {
            let state = update_app.state::<AppUpdateState>();
            let canceled = token.is_cancelled();
            let task = state.finish(
                if canceled { AppUpdatePhase::Canceled } else { AppUpdatePhase::Failed },
                Some(if canceled {
                    "Application update download canceled".to_string()
                } else {
                    error
                }),
            );
            let _ = update_app.emit(APP_UPDATE_PROGRESS_EVENT, task);
        }
    });
    Ok(())
}

/// Waits for the fresh feed check an install starts with, then moves on to downloading what it found. Canceling
/// during the check stops the install; the offer from an earlier check is never downloaded instead.
pub(crate) async fn refresh_app_update_for_install<F>(
    state: &AppUpdateState,
    token: &CancellationToken,
    refresh: F,
) -> Result<PendingAppUpdate, String>
where
    F: std::future::Future<Output = Result<PendingAppUpdate, String>>,
{
    let pending = tokio::select! {
        biased;
        _ = token.cancelled() => return Err("Application update download canceled".to_string()),
        result = refresh => result?,
    };
    state.start_download(&pending)?;
    Ok(pending)
}

pub(crate) async fn download_and_stage_portable_app_update(
    app: &tauri::AppHandle,
    pending: &PendingAppUpdate,
    token: &CancellationToken,
    proxy_url: &str,
    download_source: VersionDownloadCandidate,
) -> Result<(), String> {
    validate_portable_update_asset(&pending.asset)?;
    let work_dir = portable_update_work_dir(&pending.version);
    fs::create_dir_all(&work_dir)
        .map_err(|error| format!("Failed to create application update temporary directory: {error}"))?;
    let archive_path = work_dir.join("update.dmg");
    let result = async {
        download_portable_update_archive(
            app,
            pending,
            token,
            &archive_path,
            proxy_url,
            &download_source,
        )
        .await?;
        ensure_portable_update_download(token, &archive_path, pending)?;
        update_app_task(app, |task| {
            task.cancelable = false;
            task.phase = AppUpdatePhase::Staging;
            task.message = Some("Preparing the application update".to_string());
        });

        let staged_app = work_dir
            .join("staging")
            .join("Arbor.app");
        stage_macos_application_from_dmg(&archive_path, &work_dir, &staged_app)?;
        validate_macos_staged_application(&staged_app, pending)?;
        let current_exe =
            env::current_exe().map_err(|error| format!("Failed to read current executable path: {error}"))?;
        let current_app = macos_application_bundle_from_executable(&current_exe)?;
        preflight_macos_update_directory(&current_app)?;
        let executable_relative_path = current_exe
            .strip_prefix(&current_app)
            .map_err(|_| "Invalid macOS application path".to_string())?
            .to_path_buf();
        let backup_app = current_app
            .parent()
            .ok_or_else(|| "The macOS application path has no parent directory".to_string())?
            .join(".Arbor.app.update-backup");
        let descriptor = MacosUpdateDescriptor {
            parent_pid: std::process::id(),
            current_app,
            staged_app,
            backup_app,
            executable_relative_path,
            ack_path: work_dir.join("update-started.ack"),
            work_dir: work_dir.clone(),
            target_version: pending.version.clone(),
        };
        // Keep the updater inside its signed application bundle. Copying the Mach-O
        // executable into a temporary directory strips the bundle context Gatekeeper
        // uses to validate it and can cause macOS to terminate it before it starts.
        let helper_path = macos_update_helper_path(&current_exe);
        launch_portable_update_helper(app, &helper_path, &work_dir, &descriptor).await
    }
    .await;
    if result.is_err() {
        // An image still busy stays mounted here, and removing the folder would reach into it.
        cleanup_macos_update_dmg(&work_dir);
        if !work_dir.join("mount").exists() {
            let _ = fs::remove_dir_all(&work_dir);
        }
    }
    result
}

fn portable_update_work_dir(version: &str) -> PathBuf {
    env::temp_dir().join(format!(
        "EasyCLIProxyAPI-update-{}-{}-{}",
        version,
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ))
}

fn ensure_portable_update_download(
    token: &CancellationToken,
    archive_path: &Path,
    pending: &PendingAppUpdate,
) -> Result<(), String> {
    if token.is_cancelled() {
        return Err("Application update download canceled".to_string());
    }
    let actual_sha256 = sha256_file(archive_path)?;
    if actual_sha256 != pending.asset.sha256.trim().to_ascii_lowercase() {
        return Err("Application update package SHA-256 verification failed".to_string());
    }
    Ok(())
}

pub(crate) fn macos_update_helper_path(current_exe: &Path) -> PathBuf {
    current_exe.to_path_buf()
}

async fn launch_portable_update_helper<T: Serialize>(
    app: &tauri::AppHandle,
    helper_path: &Path,
    work_dir: &Path,
    descriptor: &T,
) -> Result<(), String> {
    let descriptor_path = work_dir.join("update-descriptor.json");
    fs::write(
        &descriptor_path,
        serde_json::to_vec_pretty(descriptor)
            .map_err(|error| format!("Failed to serialize application update descriptor: {error}"))?,
    )
    .map_err(|error| format!("Failed to write application update descriptor: {error}"))?;
    let helper_ack_path = portable_update_helper_ack_path(work_dir);
    let _ = fs::remove_file(&helper_ack_path);
    let mut command = Command::new(helper_path);
    command
        .arg("--portable-update-helper")
        .arg(&descriptor_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_background_command(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start application update helper: {error}"))?;
    wait_for_portable_update_helper_start(
        &mut child,
        &helper_ack_path,
        PORTABLE_UPDATE_HELPER_START_TIMEOUT,
    )
    .await?;
    update_app_task(app, |task| {
        task.cancelable = false;
        task.phase = AppUpdatePhase::Restarting;
        task.message = Some("Update ready; the app will restart shortly".to_string());
    });
    app.state::<CoreProcessState>().keep_through_exit();
    app.exit(0);
    Ok(())
}

pub(crate) fn portable_update_helper_ack_path(work_dir: &Path) -> PathBuf {
    work_dir.join(PORTABLE_UPDATE_HELPER_ACK_FILE)
}

pub(crate) fn acknowledge_portable_update_helper_start(work_dir: &Path) -> Result<(), String> {
    fs::write(
        portable_update_helper_ack_path(work_dir),
        std::process::id().to_string(),
    )
    .map_err(|error| format!("Failed to write application update helper startup confirmation: {error}"))
}

async fn wait_for_portable_update_helper_start(
    child: &mut Child,
    ack_path: &Path,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if ack_path.is_file() {
            return Ok(());
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Failed to check application update helper status: {error}"))?
        {
            return Err(format!("Application update helper failed to start, exit status: {status}"));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Application update helper did not confirm startup within {} seconds",
                timeout.as_secs()
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub(crate) async fn download_portable_update_archive(
    app: &tauri::AppHandle,
    pending: &PendingAppUpdate,
    token: &CancellationToken,
    destination: &Path,
    proxy_url: &str,
    download_source: &VersionDownloadCandidate,
) -> Result<(), String> {
    let client_builder = reqwest::Client::builder()
            .redirect(release_https_redirect_policy_with_mirrors(
                &download_source
                    .custom_url
                    .clone()
                    .into_iter()
                    .collect::<Vec<_>>(),
            ))
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(15 * 60));
    // Arbor's own DMG: the API, asked with the GitHub CLI's sign-in, names a short-lived storage address that's then
    // downloaded without it.
    #[cfg(target_os = "macos")]
    if crate::release_feed::is_release_asset_api_url(&crate::release_feed::ARBOR_RELEASE_FEED, &pending.asset.url) {
        let client = build_http_client_with_proxy(
            client_builder.redirect(reqwest::redirect::Policy::none()),
            proxy_url,
            "Failed to create application update download client",
        )?;
        let github_token = crate::release_feed::github_cli_token().await;
        let location = crate::release_feed::release_asset_download_location(
            &client,
            &crate::release_feed::ARBOR_RELEASE_FEED,
            github_token.as_deref(),
            &pending.asset.url,
        )
        .await?;
        return download_portable_update_archive_url(app, pending, token, destination, &client, &location).await;
    }
    let client = build_http_client_with_proxy(
        client_builder,
        proxy_url,
        "Failed to create application update download client",
    )?;
    let urls = portable_update_download_urls(&pending.asset, download_source);
    let mut failures = Vec::new();
    for (index, url) in urls.iter().enumerate() {
        update_app_task(app, |task| {
            task.downloaded_bytes = 0;
            task.percent = Some(0.0);
            if index > 0 {
                task.message = Some(format!(
                    "Download failed, switching to {}",
                    update_download_source_name(url)
                ));
            }
        });
        match download_portable_update_archive_url(app, pending, token, destination, &client, url)
            .await
        {
            Ok(()) => return Ok(()),
            Err(error) if token.is_cancelled() => return Err(error),
            Err(error) => failures.push(error),
        }
    }
    Err(format!("All application update download sources failed: {}", failures.join("; ")))
}

pub(crate) fn portable_update_download_urls(
    asset: &PortableUpdateAsset,
    source: &VersionDownloadCandidate,
) -> Vec<String> {
    let mut urls = std::iter::once(asset.url.as_str())
        .chain(asset.fallback_urls.iter().map(String::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if source.proxy_prefix().is_some() {
        if let Some(github_url) = urls
            .iter()
            .find(|url| update_download_source_name(url) == "GitHub")
            .cloned()
        {
            urls.insert(0, version_source_url(source, &github_url));
        }
    }
    urls.dedup();
    urls
}

pub(crate) fn update_download_source_name(url: &str) -> String {
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string));
    match host.as_deref() {
        Some("gh-proxy.com") => "gh-proxy.com".to_string(),
        Some("ghfast.top") => "ghfast.top".to_string(),
        Some(
            "github.com" | "objects.githubusercontent.com" | "release-assets.githubusercontent.com",
        ) => "GitHub".to_string(),
        Some(host) => host.to_string(),
        None => "GitHub".to_string(),
    }
}

pub(crate) async fn download_portable_update_archive_url(
    app: &tauri::AppHandle,
    pending: &PendingAppUpdate,
    token: &CancellationToken,
    destination: &Path,
    client: &reqwest::Client,
    url: &str,
) -> Result<(), String> {
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/octet-stream")
        .header(reqwest::header::USER_AGENT, APP_USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("Failed to download application update: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Failed to download application update: {error}"))?;
    let mut stream = response.bytes_stream();
    let mut file =
        File::create(destination).map_err(|error| format!("Failed to create application update temporary file: {error}"))?;
    let mut downloaded = 0_u64;
    let mut progress = crate::progress::ProgressThrottle::default();
    while let Some(chunk) = stream.next().await {
        if token.is_cancelled() {
            return Err("Application update download canceled".to_string());
        }
        let chunk = chunk.map_err(|error| format!("Failed to read application update download data: {error}"))?;
        file.write_all(&chunk)
            .map_err(|error| format!("Failed to write application update temporary file: {error}"))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > pending.asset.size_bytes {
            return Err("Application update package exceeds the size declared in the manifest".to_string());
        }
        if progress.ready(Instant::now(), downloaded == pending.asset.size_bytes) {
            update_app_task(app, |task| {
                task.downloaded_bytes = downloaded;
                task.total_bytes = Some(pending.asset.size_bytes);
                task.percent = Some((downloaded as f64 / pending.asset.size_bytes as f64) * 100.0);
                task.message = Some(format!(
                    "{} / {}",
                    format_byte_count(downloaded),
                    format_byte_count(pending.asset.size_bytes)
                ));
            });
        }
    }
    file.flush()
        .map_err(|error| format!("Failed to save application update temporary file: {error}"))?;
    if downloaded != pending.asset.size_bytes {
        return Err(format!(
            "Application update package size mismatch: expected {}, got {}",
            pending.asset.size_bytes, downloaded
        ));
    }
    Ok(())
}

pub(crate) fn update_app_task<F>(app: &tauri::AppHandle, update: F)
where
    F: FnOnce(&mut AppUpdateTask),
{
    let state = app.state::<AppUpdateState>();
    let task = state.update_task(update);
    let _ = app.emit(APP_UPDATE_PROGRESS_EVENT, task);
}

pub(crate) fn format_byte_count(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0_usize;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

pub(crate) fn wait_for_portable_parent_exit(pid: u32, timeout: Duration) -> Result<(), String> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err("Invalid application update parent process ID".to_string());
    }
    let deadline = Instant::now() + timeout;
    loop {
        let result = unsafe { libc::kill(pid as i32, 0) };
        if result != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            if error.raw_os_error() != Some(libc::EPERM) {
                return Err(format!("Failed to check old application process: {error}"));
            }
        }
        if Instant::now() >= deadline {
            return Err("Timed out waiting for the old application to exit".to_string());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(target_os = "macos")]
fn run_macos_update_command(command: &mut Command, action: &str) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|error| format!("{action} failed: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let details = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("; ");
    Err(format!("{action} failed ({}): {details}", output.status))
}

#[cfg(target_os = "macos")]
pub(crate) fn stage_macos_application_from_dmg(
    dmg_path: &Path,
    work_dir: &Path,
    staged_app: &Path,
) -> Result<(), String> {
    stage_macos_application_from_dmg_with_commands(
        dmg_path,
        work_dir,
        staged_app,
        run_macos_update_command,
        thread::sleep,
    )
}

#[cfg(target_os = "macos")]
pub(crate) fn stage_macos_application_from_dmg_with_commands(
    dmg_path: &Path,
    work_dir: &Path,
    staged_app: &Path,
    mut run: impl FnMut(&mut Command, &str) -> Result<(), String>,
    mut wait: impl FnMut(Duration),
) -> Result<(), String> {
    let mount_dir = work_dir.join("mount");
    fs::create_dir_all(&mount_dir).map_err(|error| format!("Failed to create DMG mount directory: {error}"))?;
    let mut attach = Command::new("hdiutil");
    attach
        .arg("attach")
        .arg(dmg_path)
        .args(["-nobrowse", "-readonly", "-mountpoint"])
        .arg(&mount_dir);
    run(&mut attach, "Mount application update DMG")?;

    let source_app = mount_dir.join("Arbor.app");
    let stage_result = (|| -> Result<(), String> {
        if !source_app.is_dir() {
            return Err("Application update DMG is missing Arbor.app".to_string());
        }
        let staging_parent = staged_app
            .parent()
            .ok_or_else(|| "Invalid application update staging path".to_string())?;
        fs::create_dir_all(staging_parent)
            .map_err(|error| format!("Failed to create application update staging directory: {error}"))?;
        let mut ditto = Command::new("ditto");
        ditto.arg(&source_app).arg(staged_app);
        run(&mut ditto, "Stage new macOS application")?;
        let mut codesign = Command::new("codesign");
        codesign
            .args(["--verify", "--deep", "--strict"])
            .arg(staged_app);
        run(&mut codesign, "Verify new macOS application signature")?;
        Ok(())
    })();

    match eject_macos_update_dmg_with_commands(&mount_dir, &mut run, &mut wait) {
        Ok(()) => {
            let _ = fs::remove_dir(&mount_dir);
        }
        // The staged, verified copy no longer needs the image, so an image macOS still holds is left for the
        // payload cleanup rather than failing the update.
        Err(error) => eprintln!("Application update DMG cleanup deferred: {error}"),
    }
    stage_result
}

/// Ejects the update's image, trying again while it's busy (Spotlight and the malware scan open a freshly mounted
/// image), then forcing it: the mount is this updater's own read-only one.
#[cfg(target_os = "macos")]
pub(crate) fn eject_macos_update_dmg_with_commands(
    mount_dir: &Path,
    mut run: impl FnMut(&mut Command, &str) -> Result<(), String>,
    mut wait: impl FnMut(Duration),
) -> Result<(), String> {
    let mut last_error = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            wait(Duration::from_millis(500));
        }
        let mut eject = Command::new("diskutil");
        eject.arg("eject").arg(mount_dir);
        match run(&mut eject, "Eject application update DMG") {
            Ok(()) => return Ok(()),
            Err(error) => last_error = error,
        }
    }
    let mut detach = Command::new("hdiutil");
    detach.args(["detach", "-force"]).arg(mount_dir);
    run(&mut detach, "Force unmount application update DMG").map_err(|error| format!("{last_error}; {error}"))
}

#[cfg(target_os = "macos")]
fn cleanup_macos_update_dmg(work_dir: &Path) {
    cleanup_macos_update_dmg_with_commands(work_dir, run_macos_update_command, thread::sleep);
}

/// Ejects and removes the update's image. One that won't eject stays, with its mount folder, for a later cleanup.
#[cfg(target_os = "macos")]
pub(crate) fn cleanup_macos_update_dmg_with_commands(
    work_dir: &Path,
    run: impl FnMut(&mut Command, &str) -> Result<(), String>,
    wait: impl FnMut(Duration),
) {
    let mount_dir = work_dir.join("mount");
    if mount_dir.exists() {
        if let Err(error) = eject_macos_update_dmg_with_commands(&mount_dir, run, wait) {
            eprintln!("Application update DMG cleanup deferred: {error}");
            return;
        }
        let _ = fs::remove_dir(&mount_dir);
    }
    let _ = fs::remove_file(work_dir.join("update.dmg"));
}

#[cfg(target_os = "macos")]
pub(crate) fn validate_macos_staged_application(
    staged_app: &Path,
    pending: &PendingAppUpdate,
) -> Result<(), String> {
    let manifest_path = staged_app
        .join("Contents")
        .join("Resources")
        .join(PORTABLE_APP_MANIFEST_FILE);
    let contents = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Failed to read new macOS auto-update marker: {error}"))?;
    let manifest = serde_json::from_str::<PortableAppManifest>(&contents)
        .map_err(|error| format!("Failed to parse new macOS auto-update marker: {error}"))?;
    if manifest.schema_version != 1
        || manifest.application != "EasyCLIProxyAPI"
        || manifest.platform != "darwin"
        || manifest.arch != pending.arch
        || !manifest.auto_update
        || normalize_version(&manifest.version) != normalize_version(&pending.version)
    {
        return Err("New macOS application marker does not match the update target".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_application_bundle_from_executable(
    executable: &Path,
) -> Result<PathBuf, String> {
    let macos_dir = executable
        .parent()
        .filter(|path| path.file_name().and_then(|name| name.to_str()) == Some("MacOS"))
        .ok_or_else(|| "The current executable is not in a standard macOS application bundle".to_string())?;
    let contents_dir = macos_dir
        .parent()
        .filter(|path| path.file_name().and_then(|name| name.to_str()) == Some("Contents"))
        .ok_or_else(|| "The current executable is not in a standard macOS application bundle".to_string())?;
    let app = contents_dir
        .parent()
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("app"))
        .ok_or_else(|| "The current executable is not in a standard macOS application bundle".to_string())?;
    Ok(app.to_path_buf())
}

#[cfg(target_os = "macos")]
pub(crate) fn preflight_macos_update_directory(current_app: &Path) -> Result<(), String> {
    if !current_app.is_dir() {
        return Err("The current macOS application bundle does not exist".to_string());
    }
    let app_parent = current_app
        .parent()
        .ok_or_else(|| "The macOS application bundle has no parent directory".to_string())?;
    let probe = app_parent.join(format!(
        ".easycliproxy-update-write-test-{}",
        std::process::id()
    ));
    fs::write(&probe, b"update-write-test")
        .map_err(|error| format!("The macOS application directory is not writable; automatic updates are unavailable: {error}"))?;
    fs::remove_file(&probe).map_err(|error| format!("Failed to clean up application update write test: {error}"))
}

#[cfg(target_os = "macos")]
pub(crate) fn validate_macos_update_descriptor(
    descriptor_path: &Path,
    descriptor: &MacosUpdateDescriptor,
) -> Result<(), String> {
    if descriptor.parent_pid == 0
        || semver::Version::parse(descriptor.target_version.trim().trim_start_matches('v')).is_err()
        || !descriptor.current_app.is_absolute()
        || descriptor
            .current_app
            .extension()
            .and_then(|value| value.to_str())
            != Some("app")
    {
        return Err("Invalid macOS application update descriptor".to_string());
    }
    let app_parent = descriptor
        .current_app
        .parent()
        .ok_or_else(|| "Invalid macOS application update target path".to_string())?;
    if descriptor.backup_app != app_parent.join(".Arbor.app.update-backup")
        || descriptor.executable_relative_path.is_absolute()
        || descriptor
            .executable_relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !descriptor
            .executable_relative_path
            .starts_with(Path::new("Contents").join("MacOS"))
    {
        return Err("Invalid macOS application update target path".to_string());
    }
    let canonical_work_dir = fs::canonicalize(&descriptor.work_dir)
        .map_err(|error| format!("Failed to read application update temporary directory: {error}"))?;
    let canonical_temp_dir = fs::canonicalize(env::temp_dir())
        .map_err(|error| format!("Failed to read system temporary directory: {error}"))?;
    if !canonical_work_dir.starts_with(&canonical_temp_dir)
        || !canonical_work_dir
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.starts_with("EasyCLIProxyAPI-update-"))
    {
        return Err("Invalid application update working directory".to_string());
    }
    let canonical_descriptor = fs::canonicalize(descriptor_path)
        .map_err(|error| format!("Failed to read application update descriptor path: {error}"))?;
    let canonical_staged_app = fs::canonicalize(&descriptor.staged_app)
        .map_err(|error| format!("Failed to read new macOS application path: {error}"))?;
    if canonical_descriptor.parent() != Some(canonical_work_dir.as_path())
        || canonical_descriptor
            .file_name()
            .and_then(|value| value.to_str())
            != Some("update-descriptor.json")
        || descriptor.staged_app
            != descriptor
                .work_dir
                .join("staging")
                .join("Arbor.app")
        || !canonical_staged_app.starts_with(&canonical_work_dir)
        || descriptor.ack_path != descriptor.work_dir.join("update-started.ack")
    {
        return Err("macOS application update staging path is out of bounds".to_string());
    }
    if !descriptor
        .current_app
        .join(&descriptor.executable_relative_path)
        .is_file()
        || !descriptor
            .staged_app
            .join(&descriptor.executable_relative_path)
            .is_file()
    {
        return Err("macOS application update executable is missing".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn restore_macos_update_backup(
    descriptor: &MacosUpdateDescriptor,
) -> Result<(), String> {
    if !descriptor.backup_app.is_dir() {
        return Err("macOS application update backup is incomplete; rollback is unavailable".to_string());
    }
    if descriptor.current_app.exists() {
        fs::remove_dir_all(&descriptor.current_app)
            .map_err(|error| format!("Failed to remove new macOS application: {error}"))?;
    }
    fs::rename(&descriptor.backup_app, &descriptor.current_app)
        .map_err(|error| format!("Failed to restore old macOS application: {error}"))
}

#[cfg(target_os = "macos")]
pub(crate) fn replace_macos_application(descriptor: &MacosUpdateDescriptor) -> Result<(), String> {
    let app_parent = descriptor
        .current_app
        .parent()
        .ok_or_else(|| "Invalid macOS application update target path".to_string())?;
    let replacement_app = app_parent.join(".EasyCLIProxyAPI-update-new.app");
    let legacy_replacement_app = app_parent.join(".EasyCLIProxyAPI.app.update-new");
    if legacy_replacement_app.exists() {
        fs::remove_dir_all(&legacy_replacement_app)
            .map_err(|error| format!("Failed to clean up legacy macOS update staging: {error}"))?;
    }
    if replacement_app.exists() {
        fs::remove_dir_all(&replacement_app)
            .map_err(|error| format!("Failed to clean up old macOS update staging: {error}"))?;
    }
    let mut ditto = Command::new("ditto");
    ditto.arg(&descriptor.staged_app).arg(&replacement_app);
    run_macos_update_command(&mut ditto, "Prepare new macOS application")?;
    let mut codesign = Command::new("codesign");
    codesign
        .args(["--verify", "--deep", "--strict"])
        .arg(&replacement_app);
    if let Err(error) = run_macos_update_command(&mut codesign, "Verify replacement macOS application signature")
    {
        let _ = fs::remove_dir_all(&replacement_app);
        return Err(error);
    }
    if descriptor.backup_app.exists() {
        fs::remove_dir_all(&descriptor.backup_app)
            .map_err(|error| format!("Failed to clean up old macOS application backup: {error}"))?;
    }
    fs::rename(&descriptor.current_app, &descriptor.backup_app)
        .map_err(|error| format!("Failed to back up old macOS application: {error}"))?;
    if let Err(error) = fs::rename(&replacement_app, &descriptor.current_app) {
        let _ = fs::rename(&descriptor.backup_app, &descriptor.current_app);
        let _ = fs::remove_dir_all(&replacement_app);
        return Err(format!("Failed to replace macOS application: {error}"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn cleanup_macos_update_payload(descriptor_path: &Path, descriptor: &MacosUpdateDescriptor) {
    cleanup_macos_update_dmg(&descriptor.work_dir);
    let _ = fs::remove_dir_all(descriptor.work_dir.join("staging"));
    let _ = fs::remove_file(&descriptor.ack_path);
    let _ = fs::remove_file(portable_update_helper_ack_path(&descriptor.work_dir));
    let _ = fs::remove_file(descriptor_path);
}

pub(crate) fn run_portable_update_helper(descriptor_path: &Path) -> Result<(), String> {
    let descriptor = serde_json::from_slice::<MacosUpdateDescriptor>(
        &fs::read(descriptor_path).map_err(|error| format!("Failed to read application update descriptor: {error}"))?,
    )
    .map_err(|error| format!("Failed to parse application update descriptor: {error}"))?;
    validate_macos_update_descriptor(descriptor_path, &descriptor)?;
    acknowledge_portable_update_helper_start(&descriptor.work_dir)?;
    if let Err(error) =
        wait_for_portable_parent_exit(descriptor.parent_pid, Duration::from_secs(120))
    {
        cleanup_macos_update_payload(descriptor_path, &descriptor);
        return Err(error);
    }
    if let Err(error) = replace_macos_application(&descriptor) {
        relaunch_macos_app(&descriptor);
        cleanup_macos_update_payload(descriptor_path, &descriptor);
        return Err(error);
    }

    let current_exe = descriptor
        .current_app
        .join(&descriptor.executable_relative_path);
    let _ = fs::remove_file(&descriptor.ack_path);
    let mut command = Command::new(&current_exe);
    command
        .arg("--portable-update-ack")
        .arg(&descriptor.ack_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_background_command(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            restore_macos_update_backup(&descriptor)?;
            relaunch_macos_app(&descriptor);
            cleanup_macos_update_payload(descriptor_path, &descriptor);
            return Err(format!("Failed to start new macOS application: {error}"));
        }
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if descriptor.ack_path.is_file() {
            let _ = fs::remove_dir_all(&descriptor.backup_app);
            cleanup_macos_update_payload(descriptor_path, &descriptor);
            return Ok(());
        }
        if child
            .try_wait()
            .map_err(|error| format!("Failed to check new macOS application status: {error}"))?
            .is_some()
        {
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }
    let _ = child.kill();
    let _ = child.wait();
    restore_macos_update_backup(&descriptor)?;
    relaunch_macos_app(&descriptor);
    cleanup_macos_update_payload(descriptor_path, &descriptor);
    Err(format!(
        "New application {} did not confirm startup within 60 seconds; rolled back",
        descriptor.target_version
    ))
}

/// Starts the app the update was meant to replace again, after a failed update.
#[cfg(target_os = "macos")]
fn relaunch_macos_app(descriptor: &MacosUpdateDescriptor) {
    let mut command = Command::new(descriptor.current_app.join(&descriptor.executable_relative_path));
    configure_background_command(&mut command);
    let _ = command.spawn();
}

pub(crate) fn portable_update_ack_argument() -> Option<PathBuf> {
    let mut args = env::args_os();
    while let Some(argument) = args.next() {
        if argument == "--portable-update-ack" {
            let path = PathBuf::from(args.next()?);
            let parent = path.parent()?;
            let valid_name =
                path.file_name().and_then(|value| value.to_str()) == Some("update-started.ack");
            let valid_parent = parent.starts_with(env::temp_dir())
                && parent
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.starts_with("EasyCLIProxyAPI-update-"));
            return (valid_name && valid_parent).then_some(path);
        }
    }
    None
}

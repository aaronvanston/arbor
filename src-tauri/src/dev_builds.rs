//! The dev update channel: builds of main this Mac makes itself (scripts/dev-build.sh, run by the LaunchAgent
//! scripts/install-dev-builds.sh sets up), offered like any update once main moves. The builder leaves a DMG, an update
//! list signed with the release key and its own status in one folder; the app reads that folder and nothing else, so
//! the channel works only on a Mac that builds Arbor and can sign for it.

use super::*;

/// The builder's folder, in Application Support beside Arbor's own.
const DEV_FEED_DIR: &str = "Library/Application Support/Arbor Dev Builds";
/// The signed update list of the newest build.
pub(crate) const DEV_FEED_FILE: &str = "arbor-update-dev.json";
const DEV_STATUS_FILE: &str = "status.json";
/// Left by "Build latest main": the builder skips waiting for main to settle and builds once more after a running build.
const DEV_BUILD_NOW_FILE: &str = "build-now";
pub(crate) const DEV_BUILD_AGENT: &str = "onl.arbor.dev-build";
const DEV_STATUS_MAX_BYTES: u64 = 64 * 1024;
/// The Arbor repository the builder was set up from, written by scripts/install-dev-builds.sh.
const DEV_REPOSITORY_FILE: &str = "repository";
const DEV_INSTALLER: &str = "scripts/install-dev-builds.sh";
/// Setting up clones Arbor, which can take a while on a slow connection.
const DEV_INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub(crate) fn dev_feed_dir() -> Result<PathBuf, String> {
    let home = env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .ok_or_else(|| "Couldn't find your home folder".to_string())?;
    Ok(PathBuf::from(home).join(DEV_FEED_DIR))
}

fn dev_build_agent_plist() -> Result<PathBuf, String> {
    let home = env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .ok_or_else(|| "Couldn't find your home folder".to_string())?;
    Ok(PathBuf::from(home).join("Library/LaunchAgents").join(format!("{DEV_BUILD_AGENT}.plist")))
}

/// What the builder is doing, as it writes it in status.json.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DevBuildState {
    #[default]
    Idle,
    /// Main moved and the builder is waiting for it to settle before building.
    Waiting,
    Building,
    Failed,
}

/// The step a running build is on.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename = "DevBuildStep")]
pub(crate) enum DevBuildStep {
    Fetching,
    Installing,
    Verifying,
    Building,
    Signing,
}

/// The builder's status.json. Read leniently: a field it doesn't have, or one this version doesn't know, is left out.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DevBuildStatusFile {
    #[serde(deserialize_with = "lenient")]
    state: Option<DevBuildState>,
    commit: Option<String>,
    #[serde(deserialize_with = "lenient")]
    step: Option<DevBuildStep>,
    started_at: Option<String>,
    finished_at: Option<String>,
    error: Option<String>,
    log: Option<String>,
    built_version: Option<String>,
    built_commit: Option<String>,
    built_at: Option<String>,
    settles_at: Option<String>,
}

fn lenient<'de, D: serde::Deserializer<'de>, T: serde::de::DeserializeOwned>(deserializer: D) -> Result<Option<T>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

/// Whether this Mac builds main for the dev channel, and how its builds are going.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DevBuildStatus {
    /// The builder's LaunchAgent is set up (scripts/install-dev-builds.sh).
    pub(crate) installed: bool,
    /// The Arbor repository it was set up from, which turning it back on uses.
    pub(crate) repository: Option<String>,
    pub(crate) state: DevBuildState,
    /// The commit of main being waited on or built.
    pub(crate) commit: Option<String>,
    pub(crate) step: Option<DevBuildStep>,
    pub(crate) started_at: Option<String>,
    pub(crate) finished_at: Option<String>,
    /// Why the last build failed.
    pub(crate) error: Option<String>,
    /// The last build's log, when there is one to open.
    pub(crate) has_log: bool,
    /// "Build latest main" was asked for and the builder hasn't taken it yet.
    pub(crate) requested: bool,
    /// The newest build that finished, which the dev channel offers.
    pub(crate) built_version: Option<String>,
    pub(crate) built_commit: Option<String>,
    pub(crate) built_at: Option<String>,
    /// While it waits for main to settle: when it'll start building, unless main moves again.
    pub(crate) settles_at: Option<String>,
}

pub(crate) fn read_dev_build_status(dir: &Path, installed: bool) -> DevBuildStatus {
    let file = read_small_file(&dir.join(DEV_STATUS_FILE), DEV_STATUS_MAX_BYTES)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<DevBuildStatusFile>(&bytes).ok())
        .unwrap_or_default();
    let commit = |value: Option<String>| value.filter(|commit| is_commit(commit));
    DevBuildStatus {
        installed,
        repository: dev_repository(dir).map(|path| path.to_string_lossy().into_owned()),
        state: file.state.unwrap_or_default(),
        commit: commit(file.commit),
        step: file.step,
        started_at: file.started_at,
        finished_at: file.finished_at,
        error: file.error.map(|error| error.chars().take(2_000).collect()),
        has_log: file.log.as_deref().and_then(|log| dev_build_log_path(dir, log)).is_some(),
        requested: dir.join(DEV_BUILD_NOW_FILE).exists(),
        built_version: file.built_version.filter(|version| semver::Version::parse(version).is_ok()),
        built_commit: commit(file.built_commit),
        built_at: file.built_at,
        settles_at: file.settles_at.filter(|_| file.state == Some(DevBuildState::Waiting)),
    }
}

/// A log the status names, only when it's a file in the builder's logs folder.
fn dev_build_log_path(dir: &Path, name: &str) -> Option<PathBuf> {
    let name = Path::new(name);
    if name.components().count() != 1 || name.extension().and_then(|value| value.to_str()) != Some("log") {
        return None;
    }
    let logs = dir.join("logs").canonicalize().ok()?;
    let path = logs.join(name).canonicalize().ok()?;
    (path.starts_with(&logs) && path.is_file()).then_some(path)
}

/// The repository the builder was set up from, while it still has the installer.
fn dev_repository(dir: &Path) -> Option<PathBuf> {
    let text = read_small_file(&dir.join(DEV_REPOSITORY_FILE), 4 * 1024).ok()?;
    let path = PathBuf::from(String::from_utf8(text).ok()?.trim());
    dev_installer(&path).ok().map(|_| path)
}

/// The installer in an Arbor repository, or why the folder isn't one.
pub(crate) fn dev_installer(repository: &Path) -> Result<PathBuf, String> {
    let installer = repository.join(DEV_INSTALLER);
    if !repository.is_absolute() || !repository.join(".git").exists() || !installer.is_file() {
        return Err(format!(
            "{} isn't a copy of Arbor's repository with {DEV_INSTALLER}. Choose the folder you cloned Arbor into.",
            repository.display()
        ));
    }
    Ok(installer)
}

fn is_commit(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn read_small_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|error| format!("Couldn't read {}: {error}", path.display()))?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(file, max_bytes + 1), &mut bytes)
        .map_err(|error| format!("Couldn't read {}: {error}", path.display()))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("{} is too large", path.display()));
    }
    Ok(bytes)
}

/// The newest dev build's update list, once its signature checks out, with each DMG's `url` swapped for the file's
/// full path in `dir`.
pub(crate) fn read_dev_feed(dir: &Path, public_key: &str, repository: &str) -> Result<PortableUpdateManifest, String> {
    let bytes = match read_small_file(&dir.join(DEV_FEED_FILE), crate::release_feed::SIGNED_FEED_MAX_BYTES) {
        Ok(bytes) => bytes,
        Err(_) if !dir.join(DEV_FEED_FILE).exists() => {
            return Err("This Mac hasn't built main yet. Set up dev builds, or wait for the first one.".to_string());
        }
        Err(error) => return Err(error),
    };
    let mut manifest = crate::release_feed::verify_signed_feed(&bytes, public_key)?;
    validate_dev_feed_manifest(&manifest, repository)?;
    let root = dir
        .canonicalize()
        .map_err(|error| format!("Couldn't read the dev builds folder: {error}"))?;
    for asset in manifest.assets.values_mut() {
        let path = root
            .join(&asset.url)
            .canonicalize()
            .map_err(|_| format!("The dev build {} is missing", asset.url))?;
        let size = fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or_default();
        if !path.starts_with(&root) || !path.is_file() || size != asset.size_bytes {
            return Err(format!("The dev build {} doesn't match its update list", asset.url));
        }
        asset.url = path.to_string_lossy().into_owned();
    }
    Ok(manifest)
}

/// A dev list names each DMG by its file name beside the list, and the commit of main it was built from.
pub(crate) fn validate_dev_feed_manifest(manifest: &PortableUpdateManifest, repository: &str) -> Result<(), String> {
    if manifest.schema_version != 1 {
        return Err(format!("Unsupported application update manifest version: {}", manifest.schema_version));
    }
    let version = manifest.version.trim();
    let parsed = semver::Version::parse(version).map_err(|error| format!("Invalid application update version: {error}"))?;
    if !parsed.pre.as_str().starts_with("dev.") {
        return Err(format!("{version} isn't a dev build"));
    }
    chrono::DateTime::parse_from_rfc3339(manifest.published_at.trim())
        .map_err(|error| format!("Invalid application update release time: {error}"))?;
    let commit = manifest
        .release_url
        .strip_prefix(&format!("https://github.com/{repository}/commit/"))
        .filter(|commit| is_commit(commit));
    if commit.is_none() {
        return Err("The dev build's update list doesn't name the commit it was built from".to_string());
    }
    if manifest.full_assets.is_some() || manifest.assets.is_empty() {
        return Err("The update list must name each Mac DMG once".to_string());
    }
    for (key, asset) in &manifest.assets {
        let arch = match key.as_str() {
            "darwin-aarch64" => "aarch64",
            "darwin-amd64" => "amd64",
            _ => return Err(format!("Unexpected update list entry: {key}")),
        };
        if asset.url != format!("Arbor-v{version}-Darwin-{arch}.dmg") || !asset.fallback_urls.is_empty() {
            return Err(format!("The update list's {key} build doesn't match its version"));
        }
        validate_portable_update_asset_digest(asset)?;
    }
    Ok(())
}

/// The builder only keeps the newest build of main, so on the dev channel any other build is the one to take, whatever
/// its version says: `-dev` sorts below `-nightly` of the same release, and a nightly would otherwise never move to dev.
/// A build for an older release than the one running is the exception, left from before a stable release came out.
pub(crate) fn is_dev_update_available(current: &str, latest: &str) -> Result<bool, String> {
    let parse = |value: &str| {
        semver::Version::parse(value.trim().trim_start_matches('v'))
            .map_err(|error| format!("Invalid application version {value}: {error}"))
    };
    let (current, latest) = (parse(current)?, parse(latest)?);
    let release = |version: &semver::Version| (version.major, version.minor, version.patch);
    Ok(current != latest && release(&latest) >= release(&current))
}

/// Copies a dev build from the builder's folder to where an update is staged; the caller checks its SHA-256.
pub(crate) fn copy_dev_build(source: &Path, destination: &Path, size_bytes: u64) -> Result<(), String> {
    let copied = fs::copy(source, destination).map_err(|error| format!("Couldn't copy the dev build: {error}"))?;
    if copied != size_bytes {
        return Err("The dev build changed while it was being copied; check for updates again".to_string());
    }
    Ok(())
}

/// Whether this Mac builds main for the dev channel, and how its builds are going.
#[tauri::command]
pub(crate) fn get_dev_build_status() -> Result<DevBuildStatus, String> {
    let installed = dev_build_agent_plist()?.is_file();
    Ok(read_dev_build_status(&dev_feed_dir()?, installed))
}

/// Starts a build of main now, or right after the one running.
#[tauri::command]
pub(crate) fn request_dev_build() -> Result<DevBuildStatus, String> {
    let dir = dev_feed_dir()?;
    if !dev_build_agent_plist()?.is_file() {
        return Err("Dev builds aren't set up on this Mac. Run scripts/install-dev-builds.sh from Arbor's repository.".to_string());
    }
    fs::write(dir.join(DEV_BUILD_NOW_FILE), b"")
        .map_err(|error| format!("Couldn't ask for a build: {error}"))?;
    // kickstart starts the agent unless it's running, and a running build sees build-now when it ends.
    let mut command = Command::new("/bin/launchctl");
    // SAFETY: getuid has no preconditions and can't fail.
    let uid = unsafe { libc::getuid() };
    command
        .args(["kickstart", &format!("gui/{uid}/{DEV_BUILD_AGENT}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    configure_background_command(&mut command);
    let output = command.output().map_err(|error| format!("Couldn't start the dev builder: {error}"))?;
    if !output.status.success() {
        let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("Couldn't start the dev builder: {reason}"));
    }
    Ok(read_dev_build_status(&dir, true))
}

/// Turns the builder on, from `repository` or the one it was set up from before, or off. On runs the repository's
/// installer through the login shell, so it finds bun, node and cargo where the user's shell does; off stops the
/// LaunchAgent and leaves the builds, the clone and the repository it remembers.
#[tauri::command]
pub(crate) async fn set_dev_builds(enabled: bool, repository: Option<String>) -> Result<DevBuildStatus, String> {
    let dir = dev_feed_dir()?;
    let plist = dev_build_agent_plist()?;
    if !enabled {
        let mut command = tokio::process::Command::new("/bin/launchctl");
        // SAFETY: getuid has no preconditions and can't fail.
        let uid = unsafe { libc::getuid() };
        command
            .args(["bootout", &format!("gui/{uid}/{DEV_BUILD_AGENT}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::usage::machine_health::shell::configure_helper_command(&mut command);
        // Not loaded is fine: the point is that it isn't running.
        let _ = command.status().await;
        if plist.exists() {
            fs::remove_file(&plist).map_err(|error| format!("Couldn't remove the dev builder: {error}"))?;
        }
        return Ok(read_dev_build_status(&dir, false));
    }
    let repository = match repository.filter(|path| !path.trim().is_empty()) {
        Some(path) => PathBuf::from(path.trim()),
        None => dev_repository(&dir).ok_or_else(|| "Choose the folder you cloned Arbor into first.".to_string())?,
    };
    let installer = dev_installer(&repository)?;
    let shell = env::var("SHELL")
        .ok()
        .filter(|shell| shell.ends_with("/zsh") || shell.ends_with("/bash"))
        .unwrap_or_else(|| "/bin/zsh".to_string());
    let mut command = tokio::process::Command::new(shell);
    command
        .args(["-l", "-c", "exec /bin/bash \"$0\""])
        .arg(&installer)
        .current_dir(&repository)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::usage::machine_health::shell::configure_helper_command(&mut command);
    let output = tokio::time::timeout(DEV_INSTALL_TIMEOUT, command.output())
        .await
        .map_err(|_| "Setting up dev builds took more than ten minutes and was stopped.".to_string())?
        .map_err(|error| format!("Couldn't run {DEV_INSTALLER}: {error}"))?;
    if !output.status.success() {
        let said = String::from_utf8_lossy(&output.stderr);
        let reason = said.lines().filter(|line| !line.trim().is_empty()).collect::<Vec<_>>();
        let reason = reason[reason.len().saturating_sub(3)..].join(" ");
        return Err(if reason.is_empty() { format!("{DEV_INSTALLER} stopped without saying why") } else { reason });
    }
    Ok(read_dev_build_status(&dir, plist.is_file()))
}

#[tauri::command]
pub(crate) fn open_dev_build_log(app: tauri::AppHandle) -> Result<(), String> {
    let dir = dev_feed_dir()?;
    let status = read_small_file(&dir.join(DEV_STATUS_FILE), DEV_STATUS_MAX_BYTES)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<DevBuildStatusFile>(&bytes).ok())
        .unwrap_or_default();
    let path = status
        .log
        .as_deref()
        .and_then(|log| dev_build_log_path(&dir, log))
        .ok_or_else(|| "The last build left no log".to_string())?;
    crate::system_open::open_with_system(&app, &path.to_string_lossy(), None)
}

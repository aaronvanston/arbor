mod agents;
mod app_icon;
mod app_menu;
mod app_identity;
mod app_settings;
mod app_update;
mod auth_file_contents;
mod bindings;
mod build_channel;
mod cli;
mod command_error;
mod configuration_watcher;
mod core_config;
mod core_runtime;
mod dev_builds;
mod digest_export;
mod instance_lock;
mod main_window;
mod management_api;
mod oauth_browser;
mod oauth_callback;
mod phone_alerts;
mod product_analytics;
mod progress;
mod proxy_checks;
mod quit_guard;
mod release_feed;
mod release_notes;
mod saved_store;
mod settings_in_effect;
mod system_locale;
mod system_open;
mod tray;
mod usage;
mod zoom;

#[cfg(test)]
use configuration_watcher::nearest_existing_watch_directory;
use management_api::{
    format_management_request_error, management_authorization, management_endpoint,
    management_http_client, read_management_value, send_management,
};
use oauth_browser::*;

use agents::*;
use app_settings::*;
use app_update::*;
use core_config::*;
use core_runtime::*;
use release_notes::*;
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use instance_lock::*;
use main_window::*;
#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSEvent;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::Arc;
use std::{
    env, fs,
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, UdpSocket},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{LazyLock, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tar::Archive;
#[cfg(target_os = "macos")]
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, LogicalSize, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;
use tray::*;
use zip::ZipArchive;

const RELEASE_PAGE_URL: &str = "https://github.com/router-for-me/CLIProxyAPI/releases/latest";
const RELEASE_ATOM_URL: &str = "https://github.com/router-for-me/CLIProxyAPI/releases.atom";
const RELEASE_DOWNLOAD_PREFIX: &str =
    "https://github.com/router-for-me/CLIProxyAPI/releases/download/";
const APP_UPDATE_PROGRESS_EVENT: &str = "app-update-progress";
const PORTABLE_APP_MANIFEST_FILE: &str = "portable-app.json";
const CORE_INSTALL_PROGRESS_EVENT: &str = "core-install-progress";
const CORE_STATUS_EVENT: &str = "core-status-changed";
const CONFIG_FILES_CHANGED_EVENT: &str = "config-files-changed";
const CORE_METADATA_FILE: &str = "core-metadata.json";
const LEGACY_CORE_METADATA_FILE: &str = "cpa-gui-meta.json";
const CORE_CONFIG_FILE: &str = "config.yaml";
const CORE_EXAMPLE_CONFIG_FILE: &str = "config.example.yaml";
const CORE_VERSION_FILE: &str = "core-version.txt";
const CORE_CHECKSUMS_FILE: &str = "checksums.txt";
const GUI_CONFIG_FILE: &str = "config.toml";
const LEGACY_GUI_CONFIG_FILE: &str = "cpa-gui.yaml";
const MIN_MAIN_WINDOW_WIDTH: u32 = 640;
const MIN_MAIN_WINDOW_HEIGHT: u32 = 600;
const MAX_SAVED_WINDOW_DIMENSION: u32 = 16_384;
const DEFAULT_MAIN_WINDOW_WIDTH: u32 = 1280;
const DEFAULT_MAIN_WINDOW_HEIGHT: u32 = 800;
const LEGACY_DEFAULT_MAIN_WINDOW_WIDTH: u32 = 1531;
const LEGACY_DEFAULT_MAIN_WINDOW_HEIGHT: u32 = 891;
const OAUTH_DIR_NAME: &str = "oauth";
const DEFAULT_AUTH_DIR: &str = "../oauth";
/// The client key every install started with before new ones got a random key. The proxy checks warn while it's
/// still in use, since anyone can guess it.
const LEGACY_DEFAULT_API_KEY: &str = "123456";
const DEFAULT_API_KEY_INITIAL_REMARK: &str = "Default key";
const DEFAULT_REQUEST_RETRY: u32 = 3;
const DEFAULT_MAX_RETRY_CREDENTIALS: u32 = 0;
const DEFAULT_MAX_RETRY_INTERVAL: u32 = 30;
const DEFAULT_STREAMING_BOOTSTRAP_RETRIES: u32 = 0;
const DEFAULT_DISABLE_COOLING: bool = false;
const DEFAULT_LOGS_MAX_TOTAL_SIZE_MB: u32 = 0;
const DEFAULT_ERROR_LOGS_MAX_FILES: u32 = 10;
const DEFAULT_REDIS_USAGE_QUEUE_RETENTION_SECONDS: u32 = 60;
const LEGACY_DEFAULT_MANAGEMENT_SECRET_KEY: &str = "123456";
const MODEL_ALIAS_CONFIG_SECTIONS: &[&str] = &[
    "codex-api-key",
    "openai-compatibility",
    "claude-api-key",
    "gemini-api-key",
];
// What Arbor calls itself when it asks GitHub for core releases and its own updates.
const USER_AGENT: &str = concat!("Arbor/", env!("CARGO_PKG_VERSION"), " (+https://github.com/aaronvanston/arbor)");
static CORE_CONFIG_FILE_LOCK: Mutex<()> = Mutex::new(());
static CONFIG_WRITE_HASHES: LazyLock<Mutex<std::collections::HashMap<PathBuf, String>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

#[derive(Default)]
struct CoreDownloadState {
    inner: Mutex<CoreDownloadInner>,
}

#[derive(Default)]
struct CoreDownloadInner {
    running: bool,
    token: Option<CancellationToken>,
    task: CoreInstallTask,
}

#[derive(Default)]
struct AppUpdateState {
    inner: Mutex<AppUpdateInner>,
}

#[derive(Default)]
struct AppUpdateInner {
    task: AppUpdateTask,
    token: Option<CancellationToken>,
}

#[derive(Default)]
struct CoreProcessState {
    child: Mutex<Option<Child>>,
    adopted_processes: Mutex<Vec<AdoptedCoreProcess>>,
    starting: AtomicBool,
    /// Set by an app update just before it quits: the core outlives Arbor, for the new version to adopt.
    kept_through_exit: AtomicBool,
}

#[derive(Clone)]
struct AdoptedCoreProcess {
    process_id: u32,
    binary_path: PathBuf,
}

struct GuiConfigState {
    inner: Mutex<GuiConfigFile>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SavedWindowSize {
    width: u32,
    height: u32,
}

struct MainWindowSizeState {
    inner: Mutex<Option<SavedWindowSize>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigFilesChangedPayload {
    paths: Vec<String>,
    errors: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CorePlatform {
    os: String,
    arch: String,
    asset_os: String,
    asset_arch: String,
    archive_kind: String,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct CoreStatus {
    installed: bool,
    /// The tracked core process is alive. Drives the status label and Start/Stop controls.
    running: bool,
    /// Running and answering on its management port, so the UI and usage collector can talk to it. Gate anything
    /// that calls the core on this.
    ready: bool,
    starting: bool,
    managed: bool,
    process_id: Option<u32>,
    current_version: Option<String>,
    install_dir: String,
    binary_path: Option<String>,
    message: String,
}

/// What one release changed, as plain text: from the signed update list for Arbor, from GitHub's releases feed for
/// the core.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ReleaseNotes {
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    summary: Option<String>,
    changes: Vec<String>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct CoreLatest {
    version: String,
    asset_name: String,
    /// The newest releases' changelogs from GitHub, when the check read its releases feed.
    releases: Vec<ReleaseNotes>,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct AppUpdateInfo {
    current_version: String,
    latest_version: String,
    update_available: bool,
    release_url: String,
    auto_update_supported: bool,
    download_size_bytes: Option<u64>,
    unsupported_reason: Option<String>,
    /// Recent releases' notes from the update feed; empty for feeds published before notes.
    releases: Vec<ReleaseNotes>,
    /// The core the latest release bundles, which it installs at launch over an older one; None when the feed
    /// doesn't say.
    bundled_core_version: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableUpdateManifest {
    schema_version: u32,
    version: String,
    published_at: String,
    release_url: String,
    assets: std::collections::HashMap<String, PortableUpdateAsset>,
    #[serde(default)]
    full_assets: Option<std::collections::HashMap<String, PortableUpdateAsset>>,
    /// Recent releases' notes, read leniently so bad notes can't stop an update being offered.
    #[serde(default)]
    releases: Option<serde_json::Value>,
    /// The core the release bundles, so installing it can say whether the proxy restarts.
    #[serde(default)]
    core_version: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableUpdateAsset {
    url: String,
    #[serde(default)]
    fallback_urls: Vec<String>,
    sha256: String,
    size_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableAppManifest {
    schema_version: u32,
    application: String,
    version: String,
    platform: String,
    arch: String,
    #[serde(default)]
    auto_update: bool,
}

#[derive(Clone)]
struct PendingAppUpdate {
    version: String,
    asset: PortableUpdateAsset,
    arch: String,
    /// A dev build in this Mac's builder folder, copied instead of downloaded.
    local_file: Option<PathBuf>,
}

/// Where an app update is; the window shows its progress from this.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
enum AppUpdatePhase {
    #[default]
    Idle,
    Available,
    Checking,
    Downloading,
    /// Checking the downloaded image's hash against the signed feed.
    Verifying,
    /// Opening the image, copying the app out and checking its signature.
    Staging,
    Restarting,
    Canceled,
    Failed,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct AppUpdateTask {
    running: bool,
    cancelable: bool,
    phase: AppUpdatePhase,
    target_version: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<f64>,
    message: Option<String>,
    /// A dev build copied from this Mac's builder folder: no download, so no progress to show for it.
    from_this_mac: bool,
}

impl Default for AppUpdateTask {
    fn default() -> Self {
        Self {
            running: false,
            cancelable: false,
            phase: AppUpdatePhase::Idle,
            target_version: None,
            downloaded_bytes: 0,
            total_bytes: None,
            percent: None,
            message: None,
            from_this_mac: false,
        }
    }
}

#[cfg(target_os = "macos")]
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MacosUpdateDescriptor {
    parent_pid: u32,
    current_app: PathBuf,
    staged_app: PathBuf,
    backup_app: PathBuf,
    executable_relative_path: PathBuf,
    ack_path: PathBuf,
    work_dir: PathBuf,
    target_version: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BundledCoreInfo {
    version: String,
    asset_name: String,
    size_bytes: u64,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct CoreInstallResult {
    version: String,
    asset_name: String,
    install_dir: String,
    binary_path: Option<String>,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct CoreInstallTask {
    running: bool,
    cancelable: bool,
    phase: String,
    downloaded: u64,
    total: Option<u64>,
    percent: Option<f64>,
    message: Option<String>,
    result: Option<CoreInstallResult>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
struct GuiConfigFile {
    port: u16,
    allow_lan: bool,
    host: String,
    run_on_startup: bool,
    start_core_on_launch: bool,
    silent_start: bool,
    close_behavior: WindowsCloseBehavior,
    window_width: Option<u32>,
    window_height: Option<u32>,
    /// The window's zoom as a step (zoom.rs); 0 is actual size.
    zoom_step: i32,
    /// The Dock icon's color (app_icon.rs); auto follows the build that's running.
    #[serde(deserialize_with = "app_icon::deserialize_app_icon")]
    app_icon: app_icon::AppIconChoice,
    auth_dir: String,
    #[serde(deserialize_with = "deserialize_gui_api_keys")]
    api_keys: Vec<GuiApiKeyEntry>,
    /// Keys taken out of the core's list until they're resumed. The core has no per-key
    /// switch, so this is where a paused key and its remark wait.
    paused_api_keys: Vec<GuiApiKeyEntry>,
    /// Each client key's name, by the key's fingerprint. The keys themselves are config.yaml's; this is the only
    /// place their names are kept. A file without any has none, rather than the default key's first name.
    #[serde(default)]
    client_key_names: Vec<GuiClientKeyName>,
    api_access_remarks: Vec<GuiApiAccessRemark>,
    management_secret_key: String,
    debug: bool,
    commercial_mode: bool,
    logging_to_file: bool,
    logs_max_total_size_mb: u32,
    error_logs_max_files: u32,
    usage_statistics_enabled: bool,
    redis_usage_queue_retention_seconds: u32,
    request_log: bool,
    plugins_enabled: bool,
    routing_strategy: String,
    proxy_url: String,
    /// Which releases Arbor updates to.
    #[serde(deserialize_with = "release_feed::deserialize_update_channel")]
    update_channel: release_feed::UpdateChannel,
    routing_session_affinity: bool,
    routing_session_affinity_ttl: String,
    disable_cooling: bool,
    request_retry: u32,
    max_retry_credentials: u32,
    max_retry_interval: u32,
    streaming_bootstrap_retries: u32,
}

/// What the app does when its window is closed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
enum WindowsCloseBehavior {
    #[default]
    Ask,
    Exit,
    MinimizeToTray,
}

impl WindowsCloseBehavior {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Exit => "exit",
            Self::MinimizeToTray => "minimize-to-tray",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct GuiApiKeyEntry {
    key: String,
    #[serde(default)]
    remark: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct GuiApiAccessRemark {
    provider_section: String,
    api_key_hash: String,
    remark: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum GuiApiKeyInput {
    Legacy(String),
    Entry(GuiApiKeyEntry),
}

fn deserialize_gui_api_keys<'de, D>(deserializer: D) -> Result<Vec<GuiApiKeyEntry>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries = Vec::<GuiApiKeyInput>::deserialize(deserializer)?;
    Ok(entries
        .into_iter()
        .map(|entry| match entry {
            GuiApiKeyInput::Legacy(key) => GuiApiKeyEntry {
                remark: String::new(),
                key,
            },
            GuiApiKeyInput::Entry(entry) => entry,
        })
        .collect())
}

impl Default for GuiConfigFile {
    fn default() -> Self {
        Self {
            port: 8317,
            allow_lan: false,
            host: "127.0.0.1".to_string(),
            run_on_startup: false,
            start_core_on_launch: true,
            silent_start: false,
            close_behavior: WindowsCloseBehavior::Ask,
            window_width: Some(DEFAULT_MAIN_WINDOW_WIDTH),
            window_height: Some(DEFAULT_MAIN_WINDOW_HEIGHT),
            zoom_step: 0,
            app_icon: app_icon::AppIconChoice::Auto,
            auth_dir: DEFAULT_AUTH_DIR.to_string(),
            // config.yaml has the client keys. A first start writes one made by `ensure_first_client_key`.
            api_keys: Vec::new(),
            paused_api_keys: Vec::new(),
            client_key_names: Vec::new(),
            api_access_remarks: Vec::new(),
            // Populated with an OS-generated secret while loading the GUI
            // configuration. Core hashes the value written into config.yaml.
            management_secret_key: String::new(),
            debug: false,
            commercial_mode: false,
            logging_to_file: false,
            logs_max_total_size_mb: DEFAULT_LOGS_MAX_TOTAL_SIZE_MB,
            error_logs_max_files: DEFAULT_ERROR_LOGS_MAX_FILES,
            usage_statistics_enabled: true,
            redis_usage_queue_retention_seconds: DEFAULT_REDIS_USAGE_QUEUE_RETENTION_SECONDS,
            request_log: false,
            plugins_enabled: false,
            routing_strategy: "round-robin".to_string(),
            proxy_url: String::new(),
            update_channel: release_feed::UpdateChannel::Stable,
            routing_session_affinity: false,
            routing_session_affinity_ttl: String::new(),
            disable_cooling: DEFAULT_DISABLE_COOLING,
            request_retry: DEFAULT_REQUEST_RETRY,
            max_retry_credentials: DEFAULT_MAX_RETRY_CREDENTIALS,
            max_retry_interval: DEFAULT_MAX_RETRY_INTERVAL,
            streaming_bootstrap_retries: DEFAULT_STREAMING_BOOTSTRAP_RETRIES,
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
struct GuiConfigPresence {
    /// Only a config.toml from before config.yaml became the core settings' one home has these, with their names.
    api_keys: Option<Vec<GuiApiKeyInput>>,
    management_secret_key: Option<String>,
    close_behavior: Option<WindowsCloseBehavior>,
    start_core_on_launch: Option<bool>,
    silent_start: Option<bool>,
    /// Only versions that offered download mirrors wrote these, whatever their values; a file that has them is written
    /// again without them, since the core and its checksums now come from GitHub alone.
    download_source: Option<serde::de::IgnoredAny>,
    custom_download_mirrors: Option<serde::de::IgnoredAny>,
    active_custom_download_mirror: Option<serde::de::IgnoredAny>,
    /// Only versions that offered the GitCode mirror wrote this; a file that has it is written again without it.
    prefer_gitcode_downloads: Option<bool>,
}

impl GuiConfigPresence {
    fn has_retired_download_settings(&self) -> bool {
        self.download_source.is_some()
            || self.custom_download_mirrors.is_some()
            || self.active_custom_download_mirror.is_some()
            || self.prefer_gitcode_downloads.is_some()
    }
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct GuiSettings {
    host: String,
    port: u16,
    allow_lan: bool,
    run_on_startup: bool,
    close_behavior: WindowsCloseBehavior,
}

/// Settings › Software: the app's own settings, kept by the desktop app and never by the core.
#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct SoftwareSettings {
    close_behavior: WindowsCloseBehavior,
    autostart_enabled: bool,
    start_core_on_launch: bool,
    silent_start_enabled: bool,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
struct SoftwareSettingsInput {
    close_behavior: WindowsCloseBehavior,
    autostart_enabled: bool,
    start_core_on_launch: bool,
    silent_start_enabled: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentModelOption {
    name: String,
    alias: Option<String>,
    #[serde(default)]
    is_alias: bool,
    #[serde(default)]
    context_window: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CodexModelDefinition {
    id: String,
    display_name: Option<String>,
    description: Option<String>,
    context_window: Option<u64>,
    reasoning_levels: Vec<String>,
    supports_tools: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ThinkingAliasEntry {
    source_model: String,
    alias: String,
    effort: Option<String>,
    provider: String,
    kind: String,
    oauth_channel: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ModelOverrideEntry {
    requested_model: String,
    upstream_model: String,
    oauth_channel: String,
    provider: String,
    kind: String,
    force_mapping: bool,
    long_context: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct SpeedAliasEntry {
    source_model: String,
    alias: String,
    service_tier: String,
    provider: String,
    kind: String,
    oauth_channel: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ThinkingAliasSource {
    id: String,
    model: String,
    display_name: Option<String>,
    provider: String,
    kind: String,
    protocol: String,
    reasoning_levels: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ThinkingAliasSourceLocation {
    Oauth {
        channel: &'static str,
        force_mapping: bool,
    },
    ConfigModel {
        section: &'static str,
        provider_index: usize,
        model_index: usize,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ResolvedThinkingAliasSource {
    source: ThinkingAliasSource,
    location: ThinkingAliasSourceLocation,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
struct GuiNetworkEndpointSettings {
    host: String,
    port: u16,
    proxy_url: String,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
struct GuiRetrySettings {
    #[serde(default)]
    disable_cooling: bool,
    request_retry: u32,
    max_retry_credentials: u32,
    max_retry_interval: u32,
    streaming_bootstrap_retries: u32,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
struct GuiSessionRoutingSettings {
    routing_session_affinity: bool,
    routing_session_affinity_ttl: String,
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct CoreTlsSettings {
    enabled: bool,
    cert: String,
    key: String,
}

#[derive(Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
struct CoreLoggingSettingsInput {
    debug: bool,
    commercial_mode: bool,
    logging_to_file: bool,
    logs_max_total_size_mb: u32,
    error_logs_max_files: u32,
    usage_statistics_enabled: bool,
    redis_usage_queue_retention_seconds: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreConfigSettings {
    #[serde(skip_serializing)]
    host: String,
    #[serde(skip_serializing)]
    port: u16,
    #[serde(skip_serializing)]
    auth_dir: String,
    api_keys: Vec<String>,
    management_secret_configured: bool,
    debug: bool,
    commercial_mode: bool,
    logging_to_file: bool,
    logs_max_total_size_mb: u32,
    error_logs_max_files: u32,
    usage_statistics_enabled: bool,
    redis_usage_queue_retention_seconds: u32,
    request_log: bool,
    plugins_enabled: bool,
    routing_strategy: String,
    proxy_url: String,
    routing_session_affinity: bool,
    routing_session_affinity_ttl: String,
    disable_cooling: bool,
    request_retry: u32,
    max_retry_credentials: u32,
    max_retry_interval: u32,
    streaming_bootstrap_retries: u32,
    // Kept for internal config migration/tests; never exposed to the WebView.
    #[allow(dead_code)]
    #[serde(skip_serializing)]
    management_secret_key: Option<String>,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct CoreApiKeyView {
    api_key: String,
    /// The hash usage records carry for this key.
    api_key_hash: String,
    remark: String,
}

impl From<&GuiApiKeyEntry> for CoreApiKeyView {
    fn from(entry: &GuiApiKeyEntry) -> Self {
        Self {
            api_key: entry.key.clone(),
            api_key_hash: usage::hash_text(&entry.key),
            remark: entry.remark.clone(),
        }
    }
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct CoreConfigView {
    host: String,
    api_keys: Vec<CoreApiKeyView>,
    paused_api_keys: Vec<CoreApiKeyView>,
    management_secret_configured: bool,
    port: u16,
    allow_lan: bool,
    debug: bool,
    commercial_mode: bool,
    logging_to_file: bool,
    logs_max_total_size_mb: u32,
    error_logs_max_files: u32,
    usage_statistics_enabled: bool,
    redis_usage_queue_retention_seconds: u32,
    request_log: bool,
    plugins_enabled: bool,
    routing_strategy: String,
    proxy_url: String,
    routing_session_affinity: bool,
    routing_session_affinity_ttl: String,
    disable_cooling: bool,
    request_retry: u32,
    max_retry_credentials: u32,
    max_retry_interval: u32,
    streaming_bootstrap_retries: u32,
}

impl Default for CoreInstallTask {
    fn default() -> Self {
        Self {
            running: false,
            cancelable: false,
            phase: "idle".to_string(),
            downloaded: 0,
            total: None,
            percent: None,
            message: None,
            result: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoreMetadata {
    version: String,
    asset_name: String,
    installed_at_unix: u64,
}

#[derive(Debug)]
struct DownloadedArchive {
    size: u64,
    sha256: String,
}

impl CoreDownloadState {
    fn start(&self, token: CancellationToken, version: Option<String>) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Core installation state lock is poisoned".to_string())?;

        if inner.running {
            return Err("A core installation task is already running".to_string());
        }

        inner.running = true;
        inner.token = Some(token);
        inner.task = CoreInstallTask {
            running: true,
            cancelable: true,
            phase: version
                .map(|version| format!("Preparing to install {version}"))
                .unwrap_or_else(|| "Preparing to install the latest version".to_string()),
            downloaded: 0,
            total: None,
            percent: None,
            message: None,
            result: None,
        };

        Ok(())
    }

    fn cancel(&self) {
        if let Ok(inner) = self.inner.lock() {
            if let Some(token) = &inner.token {
                token.cancel();
            }
        }
    }

    fn snapshot(&self) -> CoreInstallTask {
        self.inner
            .lock()
            .map(|inner| inner.task.clone())
            .unwrap_or_default()
    }

    fn progress(
        &self,
        window: &tauri::Window,
        phase: &str,
        downloaded: u64,
        total: Option<u64>,
        cancelable: bool,
    ) {
        let percent = total
            .filter(|total| *total > 0)
            .map(|total| downloaded as f64 * 100.0 / total as f64);

        let task = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };

            inner.task.running = inner.running;
            inner.task.cancelable = cancelable;
            inner.task.phase = phase.to_string();
            inner.task.downloaded = downloaded;
            inner.task.total = total;
            inner.task.percent = percent;
            inner.task.clone()
        };

        let _ = window.emit(CORE_INSTALL_PROGRESS_EVENT, task);
    }

    fn finish(&self, window: &tauri::Window, result: Result<CoreInstallResult, String>, canceled: bool) {
        let task = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };

            inner.running = false;
            inner.token = None;
            inner.task.running = false;
            inner.task.cancelable = false;

            match result {
                Ok(result) => {
                    inner.task.phase = "completed".to_string();
                    inner.task.downloaded = 1;
                    inner.task.total = Some(1);
                    inner.task.percent = Some(100.0);
                    inner.task.message = Some(format!("{} installed", result.version));
                    inner.task.result = Some(result);
                }
                Err(error) => {
                    inner.task.phase = if canceled { "canceled" } else { "failed" }.to_string();
                    inner.task.message = Some(error);
                    inner.task.result = None;
                }
            }

            inner.task.clone()
        };

        let _ = window.emit(CORE_INSTALL_PROGRESS_EVENT, task);
    }
}

impl AppUpdateState {
    fn snapshot(&self) -> AppUpdateTask {
        self.inner
            .lock()
            .map(|inner| inner.task.clone())
            .unwrap_or_default()
    }

    fn set_available(&self, task: AppUpdateTask) {
        if let Ok(mut inner) = self.inner.lock() {
            if !inner.task.running {
                inner.task = task;
            }
        }
    }

    /// Starts an install by checking the feed again: the offer from the last check may be hours old (installs can
    /// wait for idle agents), and downloading it could fetch an older build than the feed now has.
    fn start(&self, token: CancellationToken) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Application update state lock is poisoned".to_string())?;
        if inner.task.running {
            return Err("An application update task is already running".to_string());
        }
        inner.token = Some(token);
        inner.task = AppUpdateTask {
            running: true,
            cancelable: true,
            phase: AppUpdatePhase::Checking,
            ..AppUpdateTask::default()
        };
        Ok(())
    }

    fn start_download(&self, pending: &PendingAppUpdate) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Application update state lock is poisoned".to_string())?;
        if !inner.task.running || inner.task.phase != AppUpdatePhase::Checking {
            return Err("The application update isn't checking for the latest version".to_string());
        }
        if inner.token.as_ref().is_none_or(CancellationToken::is_cancelled) {
            return Err("Application update download canceled".to_string());
        }
        inner.task = AppUpdateTask {
            running: true,
            cancelable: true,
            phase: AppUpdatePhase::Downloading,
            target_version: Some(pending.version.clone()),
            downloaded_bytes: 0,
            total_bytes: Some(pending.asset.size_bytes),
            percent: pending.local_file.is_none().then_some(0.0),
            message: None,
            from_this_mac: pending.local_file.is_some(),
        };
        Ok(())
    }

    fn update_task<F>(&self, update: F) -> AppUpdateTask
    where
        F: FnOnce(&mut AppUpdateTask),
    {
        let Ok(mut inner) = self.inner.lock() else {
            return AppUpdateTask::default();
        };
        update(&mut inner.task);
        inner.task.clone()
    }

    fn finish(&self, phase: AppUpdatePhase, message: Option<String>) -> AppUpdateTask {
        let Ok(mut inner) = self.inner.lock() else {
            return AppUpdateTask::default();
        };
        inner.task.running = false;
        inner.task.cancelable = false;
        inner.task.phase = phase;
        inner.task.message = message;
        inner.token = None;
        inner.task.clone()
    }

    fn cancel(&self) {
        if let Ok(inner) = self.inner.lock() {
            if let Some(token) = &inner.token {
                token.cancel();
            }
        }
    }
}

impl CoreProcessState {
    fn new(starting: bool) -> Self {
        Self {
            child: Mutex::new(None),
            adopted_processes: Mutex::new(Vec::new()),
            starting: AtomicBool::new(starting),
            kept_through_exit: AtomicBool::new(false),
        }
    }

    fn is_starting(&self) -> bool {
        self.starting.load(Ordering::Acquire)
    }

    fn set_starting(&self, starting: bool) {
        self.starting.store(starting, Ordering::Release);
    }

    fn keep_through_exit(&self) {
        self.kept_through_exit.store(true, Ordering::Release);
    }

    fn is_kept_through_exit(&self) -> bool {
        self.kept_through_exit.load(Ordering::Acquire)
    }

    fn managed_pid(&self) -> Option<u32> {
        if let Ok(mut child) = self.child.lock() {
            if let Some(process) = child.as_mut() {
                if let Ok(None) = process.try_wait() {
                    return Some(process.id());
                }

                *child = None;
            }
        }

        self.adopted_processes
            .lock()
            .ok()
            .and_then(|mut processes| {
                processes.retain(|process| {
                    process_executable_path(process.process_id)
                        .as_deref()
                        .is_some_and(|path| executable_paths_match(&process.binary_path, path))
                });
                processes.first().map(|process| process.process_id)
            })
    }

    fn take_child(&self) -> Option<Child> {
        self.child.lock().ok().and_then(|mut child| child.take())
    }

    fn adopt_process_ids(&self, binary_path: &Path, process_ids: Vec<u32>) -> Result<(), String> {
        let mut adopted = self
            .adopted_processes
            .lock()
            .map_err(|_| "Adopted core process state lock is poisoned".to_string())?;
        *adopted = process_ids
            .into_iter()
            .filter(|process_id| is_process_alive(*process_id))
            .map(|process_id| AdoptedCoreProcess {
                process_id,
                binary_path: binary_path.to_path_buf(),
            })
            .collect();
        adopted.sort_unstable_by_key(|process| process.process_id);
        adopted.dedup_by_key(|process| process.process_id);
        Ok(())
    }

    fn clear_adopted_processes(&self) -> Result<(), String> {
        self.adopted_processes
            .lock()
            .map(|mut processes| processes.clear())
            .map_err(|_| "Adopted core process state lock is poisoned".to_string())
    }

    fn take_adopted_processes(&self) -> Vec<AdoptedCoreProcess> {
        self.adopted_processes
            .lock()
            .map(|mut processes| std::mem::take(&mut *processes))
            .unwrap_or_default()
    }

    fn store_child(&self, child: Child) -> Result<u32, String> {
        let pid = child.id();
        self.clear_adopted_processes()?;

        let mut managed_child = match self.child.lock() {
            Ok(managed_child) => managed_child,
            Err(_) => {
                let mut child = child;
                let cleanup_error = terminate_child(&mut child).err();
                return Err(match cleanup_error {
                    Some(cleanup_error) => format!(
                        "Core process state lock is poisoned; also failed to clean up the unmanaged core process: {cleanup_error}"
                    ),
                    None => "Core process state lock is poisoned".to_string(),
                });
            }
        };
        *managed_child = Some(child);

        Ok(pid)
    }
}

impl MainWindowSizeState {
    fn new(size: Option<SavedWindowSize>) -> Self {
        Self {
            inner: Mutex::new(size),
        }
    }

    fn snapshot(&self) -> Result<Option<SavedWindowSize>, String> {
        self.inner
            .lock()
            .map(|size| *size)
            .map_err(|_| "Main window size state lock is poisoned".to_string())
    }

    fn replace(&self, size: SavedWindowSize) -> Result<(), String> {
        let mut current = self
            .inner
            .lock()
            .map_err(|_| "Main window size state lock is poisoned".to_string())?;
        *current = Some(size);
        Ok(())
    }
}

impl GuiConfigState {
    fn new(config: GuiConfigFile) -> Self {
        Self {
            inner: Mutex::new(config),
        }
    }

    fn snapshot(&self) -> Result<GuiConfigFile, String> {
        self.inner
            .lock()
            .map(|config| config.clone())
            .map_err(|_| "GUI configuration state lock is poisoned".to_string())
    }

    /// Takes in the settings file as it was changed outside Arbor, and returns what it replaced so a caller can
    /// follow what moved. The zoom is brought within its range here, as a change made in Arbor would be: the next
    /// Zoom In or Out steps from this one.
    fn replace_external(&self, mut config: GuiConfigFile) -> Result<GuiConfigFile, String> {
        let mut current = self
            .inner
            .lock()
            .map_err(|_| "GUI configuration state lock is poisoned".to_string())?;
        config.zoom_step = zoom::clamp_zoom_step(config.zoom_step);
        Ok(std::mem::replace(&mut *current, config))
    }

    /// Takes in config.yaml's settings without writing config.toml, which is left as it is while it can't be read.
    fn replace_core_settings_external(
        &self,
        settings: &CoreConfigSettings,
        keep_listener: bool,
    ) -> Result<GuiConfigFile, String> {
        let mut current = self
            .inner
            .lock()
            .map_err(|_| "GUI configuration state lock is poisoned".to_string())?;
        let mut config = current.clone();
        import_core_settings_to_gui_config(&mut config, settings);
        if keep_listener {
            (config.host, config.port) = (current.host.clone(), current.port);
            config.allow_lan = !is_loopback_host(&config.host);
        }
        sanitize_gui_config(&mut config)?;
        validate_arbor_settings(&config)?;
        *current = config.clone();
        Ok(config)
    }

    fn update_network_endpoint(&self, settings: &GuiConfigFile) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.host = settings.host.clone();
            config.allow_lan = settings.allow_lan;
            config.port = settings.port;
            config.proxy_url = settings.proxy_url.clone();
            Ok(())
        })
    }

    fn update_retry_settings(&self, settings: &GuiConfigFile) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.disable_cooling = settings.disable_cooling;
            config.request_retry = settings.request_retry;
            config.max_retry_credentials = settings.max_retry_credentials;
            config.max_retry_interval = settings.max_retry_interval;
            config.streaming_bootstrap_retries = settings.streaming_bootstrap_retries;
            Ok(())
        })
    }

    fn update_session_routing(&self, settings: &GuiConfigFile) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.routing_session_affinity = settings.routing_session_affinity;
            config.routing_session_affinity_ttl = settings.routing_session_affinity_ttl.clone();
            Ok(())
        })
    }

    fn set_run_on_startup(&self, run_on_startup: bool) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.run_on_startup = run_on_startup;
            Ok(())
        })
    }

    fn set_software_preferences(
        &self,
        close_behavior: WindowsCloseBehavior,
        start_core_on_launch: bool,
        silent_start: bool,
    ) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.close_behavior = close_behavior;
            config.start_core_on_launch = start_core_on_launch;
            config.silent_start = silent_start;
            Ok(())
        })
    }

    fn set_window_size(&self, size: SavedWindowSize) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.window_width = Some(size.width);
            config.window_height = Some(size.height);
            Ok(())
        })
    }

    fn set_management_secret_key(&self, secret_key: String) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.management_secret_key = secret_key;
            Ok(())
        })
    }

    fn sync_core_settings(&self, settings: &CoreConfigSettings) -> Result<GuiConfigFile, String> {
        self.sync_core_settings_with_api_key(settings, None)
    }

    /// Takes in settings read back from config.yaml: a refresh, or the file changing outside Arbor.
    fn import_core_settings(&self, settings: &CoreConfigSettings) -> Result<GuiConfigFile, String> {
        self.import_core_settings_keeping_listener(settings, false)
    }

    /// Like `import_core_settings`, keeping the host and port Arbor reaches the core on when `keep_listener` is set:
    /// a running core only moves to new ones when it restarts, and the start reads them again.
    fn import_core_settings_keeping_listener(
        &self,
        settings: &CoreConfigSettings,
        keep_listener: bool,
    ) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            let listener = (config.host.clone(), config.port);
            import_core_settings_to_gui_config(config, settings);
            if keep_listener {
                (config.host, config.port) = listener;
                config.allow_lan = !is_loopback_host(&config.host);
            }
            Ok(())
        })
    }

    /// The settings to start the core with: config.yaml's as they are now, host and port included. A file that isn't
    /// there yet or can't be read leaves them as they were; the start makes the one or reports the other.
    fn refresh_core_settings(&self) -> Result<GuiConfigFile, String> {
        let installed = core_install_dir()
            .map(|install_dir| install_dir.join(CORE_CONFIG_FILE).is_file())
            .unwrap_or(false);
        if !installed {
            return self.snapshot();
        }
        match read_installed_core_config_settings() {
            Ok(settings) => self.import_core_settings(&settings),
            Err(error) => {
                eprintln!("Starting the core with the settings Arbor last read: {error}");
                self.snapshot()
            }
        }
    }

    fn sync_core_settings_with_api_key(
        &self,
        settings: &CoreConfigSettings,
        added_api_key: Option<GuiApiKeyEntry>,
    ) -> Result<GuiConfigFile, String> {
        self.sync_core_settings_then(settings, added_api_key, |_| {})
    }

    /// Syncs the core settings and makes `also` in the same write, so the two can't land apart.
    fn sync_core_settings_then<F>(
        &self,
        settings: &CoreConfigSettings,
        added_api_key: Option<GuiApiKeyEntry>,
        also: F,
    ) -> Result<GuiConfigFile, String>
    where
        F: FnOnce(&mut GuiConfigFile),
    {
        self.update(|config| {
            apply_core_settings_to_gui_config(config, settings, added_api_key.as_ref());
            also(config);
            Ok(())
        })
    }

    fn update<F>(&self, update: F) -> Result<GuiConfigFile, String>
    where
        F: FnOnce(&mut GuiConfigFile) -> Result<(), String>,
    {
        let mut current = self
            .inner
            .lock()
            .map_err(|_| "GUI configuration state lock is poisoned".to_string())?;
        let mut config = current.clone();
        update(&mut config)?;
        sanitize_gui_config(&mut config)?;
        write_gui_config(&config)?;
        *current = config.clone();
        Ok(config)
    }
}

impl From<&GuiConfigFile> for GuiSettings {
    fn from(config: &GuiConfigFile) -> Self {
        Self {
            host: config.host.clone(),
            port: config.port,
            allow_lan: config.allow_lan,
            run_on_startup: config.run_on_startup,
            close_behavior: config.close_behavior,
        }
    }
}

impl From<&GuiConfigFile> for CoreConfigSettings {
    fn from(config: &GuiConfigFile) -> Self {
        Self {
            host: config.host.clone(),
            port: config.port,
            auth_dir: config.auth_dir.clone(),
            api_keys: gui_api_key_values(&config.api_keys),
            management_secret_configured: !config.management_secret_key.is_empty(),
            debug: config.debug,
            commercial_mode: config.commercial_mode,
            logging_to_file: config.logging_to_file,
            logs_max_total_size_mb: config.logs_max_total_size_mb,
            error_logs_max_files: config.error_logs_max_files,
            usage_statistics_enabled: config.usage_statistics_enabled,
            redis_usage_queue_retention_seconds: config.redis_usage_queue_retention_seconds,
            request_log: config.request_log,
            plugins_enabled: config.plugins_enabled,
            routing_strategy: config.routing_strategy.clone(),
            proxy_url: config.proxy_url.clone(),
            routing_session_affinity: config.routing_session_affinity,
            routing_session_affinity_ttl: config.routing_session_affinity_ttl.clone(),
            disable_cooling: config.disable_cooling,
            request_retry: config.request_retry,
            max_retry_credentials: config.max_retry_credentials,
            max_retry_interval: config.max_retry_interval,
            streaming_bootstrap_retries: config.streaming_bootstrap_retries,
            management_secret_key: Some(config.management_secret_key.clone()),
        }
    }
}

impl From<&GuiConfigFile> for CoreConfigView {
    fn from(config: &GuiConfigFile) -> Self {
        Self {
            host: config.host.clone(),
            api_keys: config.api_keys.iter().map(CoreApiKeyView::from).collect(),
            paused_api_keys: config.paused_api_keys.iter().map(CoreApiKeyView::from).collect(),
            management_secret_configured: !config.management_secret_key.is_empty(),
            port: config.port,
            allow_lan: config.allow_lan,
            debug: config.debug,
            commercial_mode: config.commercial_mode,
            logging_to_file: config.logging_to_file,
            logs_max_total_size_mb: config.logs_max_total_size_mb,
            error_logs_max_files: config.error_logs_max_files,
            usage_statistics_enabled: config.usage_statistics_enabled,
            redis_usage_queue_retention_seconds: config.redis_usage_queue_retention_seconds,
            request_log: config.request_log,
            plugins_enabled: config.plugins_enabled,
            routing_strategy: config.routing_strategy.clone(),
            proxy_url: config.proxy_url.clone(),
            routing_session_affinity: config.routing_session_affinity,
            routing_session_affinity_ttl: config.routing_session_affinity_ttl.clone(),
            disable_cooling: config.disable_cooling,
            request_retry: config.request_retry,
            max_retry_credentials: config.max_retry_credentials,
            max_retry_interval: config.max_retry_interval,
            streaming_bootstrap_retries: config.streaming_bootstrap_retries,
        }
    }
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
    /// Filled from the releases Atom feed, the only source that carries notes.
    #[serde(skip)]
    release_notes: Vec<ReleaseNotes>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: Option<u64>,
    digest: Option<String>,
}

/// Each time the main window's page starts loading, at launch or on a reload: the saved zoom goes back on, and the
/// command line's bridge waits for the new page.
fn on_page_load(webview: &tauri::Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    zoom::reapply_zoom_on_load(webview, payload);
    cli::bridge::forget_page_on_load(webview, payload);
}

fn main() {
    // Run as `arbor`, the program is the command line instead of the app: it talks to the running app and never opens
    // the app's files, takes the one-app lock or starts a window.
    if let Some(arguments) = cli::command_line_arguments() {
        std::process::exit(cli::run(arguments));
    }

    let mut args = env::args_os();
    while let Some(argument) = args.next() {
        if argument == "--portable-update-helper" {
            let result = args
                .next()
                .map(PathBuf::from)
                .ok_or_else(|| "Application update helper is missing a descriptor file".to_string())
                .and_then(|path| run_portable_update_helper(&path));
            if let Err(error) = result {
                eprintln!("{error}");
            }
            return;
        }
    }

    let _instance_guard = match acquire_app_instance_guard() {
        Ok(guard) => guard,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };

    app_identity::move_legacy_data_at_launch();
    move_legacy_core_folder_at_launch();

    let portable_update_ack = portable_update_ack_argument();
    let gui_config = match load_or_create_gui_config() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            // A new version that can't read the settings right after an update quits without confirming it started,
            // so the update helper puts the old version back, instead of it running on defaults and a new management
            // key that a start would write into config.yaml.
            if portable_update_ack.is_some() {
                return;
            }
            let mut config = GuiConfigFile::default();
            if let Err(secret_error) = ensure_strong_management_secret(&mut config) {
                eprintln!("Failed to initialize WebUI security key: {secret_error}");
                return;
            }
            if let Err(sanitize_error) = sanitize_gui_config(&mut config) {
                eprintln!("Failed to initialize fixed credentials directory: {sanitize_error}");
            }
            let no_core_config = core_install_dir().is_ok_and(|dir| !dir.join(CORE_CONFIG_FILE).is_file());
            if no_core_config {
                if let Err(key_error) = ensure_first_client_key(&mut config) {
                    eprintln!("Failed to create a client key: {key_error}");
                }
            }
            config
        }
    };
    product_analytics::start();
    let initial_window_size = configured_window_size(&gui_config);
    let start_hidden = should_start_hidden(&gui_config);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(CoreDownloadState::default())
        .manage(AppUpdateState::default())
        .manage(CoreProcessState::new(gui_config.start_core_on_launch))
        .manage(usage::UsageCollectorState::default())
        .manage(usage::machine_health::MachineHealthState::default())
        .manage(usage::machine_health::archive::ArchiveState::default())
        .manage(usage::machine_health::telemetry::TelemetryState::default())
        .manage(GuiConfigState::new(gui_config))
        .manage(MainWindowSizeState::new(initial_window_size))
        .manage(LaunchShowState::default())
        .manage(quit_guard::QuitGuardState::default())
        .manage(saved_store::SavedStoreState::default())
        .manage(cli::bridge::BridgeState::default());

    // Arbor's own ⌘Q, so quitting can't stop the proxy for every machine by accident.
    #[cfg(target_os = "macos")]
    let app = app
        .menu(quit_guard::app_menu)
        .on_menu_event(|app_handle, event| {
            let id = event.id().as_ref();
            if id == quit_guard::QUIT_MENU_ID {
                quit_guard::press_quit(app_handle);
            } else if let Some(change) = zoom::menu_zoom_change(id) {
                zoom::press_zoom(app_handle, change);
            } else {
                app_menu::run_app_menu_action(app_handle, id);
            }
        });

    let app = app.on_page_load(on_page_load).on_window_event(|window, event| {
        if window.label() != "main" {
            return;
        }

        let observed_size = match event {
            tauri::WindowEvent::Resized(physical_size) => {
                window.scale_factor().ok().and_then(|scale_factor| {
                    logical_window_size_from_physical(physical_size, scale_factor)
                })
            }
            tauri::WindowEvent::ScaleFactorChanged {
                scale_factor,
                new_inner_size,
                ..
            } => logical_window_size_from_physical(new_inner_size, *scale_factor),
            _ => None,
        };

        if let Some(observed_size) = observed_size {
            let window_size_state = window.state::<MainWindowSizeState>();
            if let Err(error) = window_size_state.replace(observed_size) {
                eprintln!("Failed to record main window size: {error}");
            }
        }
    });

    #[cfg(target_os = "macos")]
    let app = app.on_window_event(|window, event| {
        if window.label() == "main" {
            // The menu bar can turn light or dark with the system; a status dot's mark is inked to match it.
            if let tauri::WindowEvent::ThemeChanged(_) = event {
                refresh_tray_status(window.app_handle());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                set_macos_dock_visible(window.app_handle(), false);
                if let Err(error) = window.hide() {
                    eprintln!("Failed to hide main window: {error}");
                    set_macos_dock_visible(window.app_handle(), true);
                }
            }
        }
    });

    let app = app
        .setup(move |app| {
            // First, before anything can make a management request.
            management_api::remember_app(app.handle());
            move_legacy_login_item(app.handle());
            if let Err(error) = restore_main_window_size(app.handle()) {
                eprintln!("{error}");
            }
            // Before the window is shown, so its first frame is already at the saved zoom.
            zoom::apply_saved_zoom(app.handle());

            #[cfg(target_os = "macos")]
            setup_macos_tray(app)?;

            if let Err(error) = configure_initial_main_window(app.handle(), start_hidden) {
                eprintln!("Failed to configure startup window state: {error}");
            }
            app_icon::apply_saved_app_icon(app.handle());

            if let Err(error) =
                configuration_watcher::start_configuration_file_watcher(app.handle().clone())
            {
                eprintln!("Failed to start configuration file watcher: {error}");
            }

            product_analytics::start_flushing(app.handle().clone());
            cli::server::start(app.handle().clone());

            let usage_app = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = usage::initialize_usage_storage() {
                    eprintln!("Failed to initialize usage records directory: {error}");
                }
                usage::diagnostics::start();
                usage::start_usage_collector(usage_app.clone());
                let telemetry_app = usage_app.clone();
                tauri::async_runtime::spawn(async move { usage::machine_health::telemetry::restart(&telemetry_app).await });
                usage::machine_health::setup_projects::restore_saved_scans(&usage_app);
                usage::machine_health::setup::restore_saved_scans(&usage_app);
                usage::machine_health::setup_repo_keeper::start(usage_app.clone());
                usage::machine_health::project_places::start_place_fetcher(usage_app.clone());
                usage::machine_health::start_machine_health_sampler(usage_app);
            });

            let core_app = app.handle().clone();
            let launched_by_update = portable_update_ack.is_some();
            tauri::async_runtime::spawn_blocking(move || {
                let Ok(_guard) = CORE_OPERATION_LOCK.lock() else {
                    return;
                };
                let gui_config_state = core_app.state::<GuiConfigState>();
                let process_state = core_app.state::<CoreProcessState>();
                let Ok(config) = gui_config_state.snapshot() else {
                    process_state.set_starting(false);
                    return;
                };

                if config.start_core_on_launch {
                    if let Ok(status) =
                        current_core_status(Some(process_state.inner()), Some(config.port))
                    {
                        emit_core_status(&core_app, &status);
                    }
                }

                match auto_install_bundled_core_if_needed(&core_app) {
                    Ok(true) => eprintln!("Installed the core bundled with this version of Arbor"),
                    Ok(false) => {}
                    Err(error) => eprintln!("Failed to install the bundled core: {error}"),
                }
                match install_bundled_core_plugins() {
                    Ok(true) => eprintln!("Updated the core plugins to the ones bundled with this version of Arbor"),
                    Ok(false) => {}
                    Err(error) => eprintln!("Failed to install the bundled core plugins: {error}"),
                }

                let adopted_process_ids = match adopt_existing_core_processes(process_state.inner())
                {
                    Ok(process_ids) => process_ids,
                    Err(error) => {
                        eprintln!("Failed to look for a core already running from the install folder: {error}");
                        Vec::new()
                    }
                };
                if !adopted_process_ids.is_empty() {
                    eprintln!(
                        "Adopted the core already running from the install folder: PID {}",
                        adopted_process_ids
                            .iter()
                            .map(u32::to_string)
                            .collect::<Vec<_>>()
                            .join(", ")
                    );
                    // Kept running through the update: its config.yaml only gets what this version needs to reach it.
                    if launched_by_update {
                        if let Err(error) = core_install_dir()
                            .and_then(|install_dir| merge_core_config_for_start(&install_dir, &config))
                        {
                            eprintln!("Failed to bring the running core's config up to date after the update: {error}");
                        }
                    }
                } else if should_start_core_on_launch(&config) {
                    if let Err(error) = start_core_process_inner(process_state.inner(), &config) {
                        eprintln!("Failed to start the core at launch: {error}");
                    }
                }

                process_state.set_starting(false);

                if let Ok(status) =
                    current_core_status(Some(process_state.inner()), Some(config.port))
                {
                    emit_core_status(&core_app, &status);
                }
            });

            if let Some(ack_path) = portable_update_ack.as_ref() {
                fs::write(ack_path, env!("CARGO_PKG_VERSION").as_bytes())
                    .map_err(|error| format!("Failed to write application update startup confirmation: {error}"))?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_tray_rows,
            set_tray_status,
            set_tray_unread,
            set_tray_waiting,
            get_core_status,
            get_gui_settings,
            main_window::frontend_ready,
            system_locale::system_locale,
            quit_guard::set_quit_guard,
            zoom::get_zoom_level,
            zoom::set_zoom_level,
            app_icon::get_app_icon,
            app_icon::set_app_icon,
            get_software_settings,
            save_software_settings,
            product_analytics::get_product_analytics,
            product_analytics::set_product_analytics,
            product_analytics::mark_product_analytics_notice_shown,
            product_analytics::track_event,
            product_analytics::report_exception,
            get_thinking_aliases,
            get_model_alias_sources,
            get_thinking_alias_sources,
            create_thinking_alias,
            delete_thinking_alias,
            get_speed_aliases,
            get_speed_alias_sources,
            create_speed_alias,
            delete_speed_alias,
            get_model_overrides,
            create_model_override,
            delete_model_override,
            get_extra_models,
            set_extra_models,
            save_network_endpoint_settings,
            save_retry_settings,
            save_session_routing_settings,
            get_core_tls_settings,
            save_core_tls_settings,
            get_core_config_settings,
            save_core_logging_settings,
            turn_on_usage_statistics,
            proxy_checks::check_proxy_settings,
            settings_in_effect::confirm_core_settings,
            add_core_api_key,
            update_core_api_key,
            delete_core_api_key,
            pause_core_api_key,
            resume_core_api_key,
            delete_paused_core_api_key,
            set_core_management_secret_key,
            management_api::management_request,
            phone_alerts::send_phone_alert,
            phone_alerts::get_phone_alert_secrets,
            phone_alerts::set_phone_alert_secret,
            digest_export::save_digest_page,
            digest_export::open_saved_page,
            management_api::upload_auth_file,
            auth_file_contents::fold_reauth_credential,
            auth_file_contents::get_auth_file_project_id,
            auth_file_contents::get_auth_file_excluded_models,
            management_api::open_auth_files_directory,
            management_api::open_core_logs_directory,
            management_api::reveal_core_config_file,
            set_core_routing_strategy,
            management_api::start_oauth_login,
            management_api::get_oauth_status,
            management_api::submit_oauth_callback,
            list_oauth_browsers,
            open_oauth_url,
            open_external_url,
            check_app_update,
            dev_builds::get_dev_build_status,
            dev_builds::request_dev_build,
            dev_builds::set_dev_builds,
            dev_builds::open_dev_build_log,
            get_update_channel,
            set_update_channel,
            get_app_update_task,
            start_app_update,
            cancel_app_update,
            check_latest_core,
            install_core_version,
            cancel_core_install,
            get_core_install_task,
            usage::get_usage_collector_status,
            usage::get_usage_overview,
            usage::get_usage_analysis,
            usage::get_usage_events,
            usage::get_usage_sessions,
            usage::get_heavy_sessions,
            usage::projects::get_session_projects,
            usage::projects::get_merged_pull_requests,
            usage::pull_requests::get_pull_request_states,
            usage::live::get_live_sessions,
            usage::machine_sessions::get_machine_sessions,
            usage::digest::get_cache_misses,
            usage::get_usage_session_timeline,
            usage::machines::get_usage_machine_assignments,
            usage::machines::save_usage_machine_assignments,
            usage::capacity::get_capacity_report,
            usage::capacity::get_limit_cycles,
            usage::limit_history::record_limit_samples,
            usage::limit_history::rename_limit_history_accounts,
            usage::machine_health::get_machine_health,
            usage::machine_health::get_machine_hosts,
            usage::machine_health::get_this_mac,
            usage::machine_health::save_machine_hosts,
            usage::machine_health::discovery::discover_machine_hosts,
            usage::machine_health::agent_homes::get_agent_homes,
            usage::machine_health::agent_homes::save_agent_home,
            usage::machine_health::agent_homes::remove_agent_home,
            usage::machine_health::agent_homes::scan_agent_homes,
            usage::machine_health::agent_homes::preview_agent_home,
            usage::machine_health::cleanup::get_machine_cleanup,
            usage::machine_health::cleanup::check_machine_cleanup,
            usage::machine_health::cleanup::remove_cleanup_items,
            usage::machine_health::cleanup::restore_set_aside,
            usage::machine_health::cleanup::delete_set_aside,
            usage::machine_health::cleanup::uninstall_cleanup_agent,
            usage::machine_health::pools::get_pools,
            usage::machine_health::pools::save_pool,
            usage::machine_health::pools::remove_pool,
            usage::machine_health::pools::preview_pools,
            usage::machine_health::pools::report_working_sessions,
            usage::machine_health::pool_ssh::get_pool_ssh,
            usage::machine_health::pool_ssh::add_pool_ssh_include,
            usage::machine_health::pool_ssh::forget_pool_ssh_name,
            usage::machine_health::runs::start_pool_run,
            usage::machine_health::runs::set_run_harnesses_off,
            usage::machine_health::runs::get_runs,
            usage::machine_health::runs::cancel_run,
            usage::machine_health::runs::open_run,
            usage::machine_health::agents::update_machine_agent,
            usage::machine_health::harness_update::update_machine_harness,
            usage::machine_health::fix_session::open_fix_session,
            usage::machine_health::agent_releases::get_agent_latest_versions,
            usage::machine_health::agent_releases::get_t3_compatibility,
            usage::machine_health::t3_threads::set_t3_threads_enabled,
            usage::machine_health::t3_threads::set_t3_thread_titles,
            usage::machine_health::transcripts::set_session_titles,
            usage::machine_health::automations::commands::list_automations,
            usage::machine_health::automations::commands::scan_automations,
            usage::machine_health::automations::commands::get_automation,
            usage::machine_health::automations::commands::list_automation_runs,
            usage::machine_health::automations::commands::open_automation_run_in_terminal,
            usage::machine_health::automations::commands::save_automation,
            usage::machine_health::automations::commands::delete_automation,
            usage::machine_health::automations::commands::set_automation_enabled,
            usage::machine_health::automations::commands::run_automation_now,
            usage::machine_health::automations::commands::cancel_automation_run,
            usage::machine_health::automations::commands::install_background_runner,
            usage::machine_health::grove::get_machine_probes,
            usage::machine_health::grove::get_machine_history,
            usage::machine_health::grove::install_machine_probe,
            usage::machine_health::grove::uninstall_machine_probe,
            usage::machine_health::automations::commands::copy_automation_into_arbor,
            usage::machine_health::automations::commands::draft_automation,
            usage::machine_health::automations::commands::set_automations_running,
            usage::machine_health::automations::commands::set_automation_app_enabled,
            usage::machine_health::automations::commands::set_automation_draft_model,
            usage::machine_health::automations::commands::add_automations_key,
            usage::machine_health::automations::commands::set_automation_proxy_address,
            usage::fleet::get_fleet_sources,
            usage::fleet::get_fleet_tray_counts,
            usage::antiburn::get_antiburn,
            usage::antiburn::open_antiburn,
            usage::machine_health::attention::set_agent_reporter,
            usage::machine_health::keep_sessions::keep_claude_sessions,
            usage::machine_health::telemetry::get_agent_telemetry,
            usage::machine_health::telemetry::set_agent_telemetry,
            usage::machine_health::telemetry::set_machine_telemetry,
            usage::machine_health::telemetry::get_agent_telemetry_breakdown,
            usage::machine_health::starting_context::get_starting_context,
            usage::machine_health::client_versions::get_client_versions,
            usage::machine_health::archive::get_session_archive_status,
            usage::machine_health::archive::get_lifetime_tokens,
            usage::machine_health::archive::preview_session_import,
            usage::machine_health::archive::add_session_import,
            usage::machine_health::archive::cancel_session_import,
            usage::machine_health::archive::export_session_archive,
            usage::machine_health::archive::check_session_archive_folder,
            usage::machine_health::archive::create_session_archive,
            usage::machine_health::archive::use_session_archive,
            usage::machine_health::archive::run_session_archive_now,
            usage::machine_health::archive::set_session_archive_paused,
            usage::machine_health::archive::save_session_archive_settings,
            usage::machine_health::archive::set_session_archive_machine,
            usage::machine_health::archive::set_session_archive_project,
            usage::machine_health::archive::reveal_session_archive,
            usage::machine_health::setup::get_setup_inventory,
            usage::machine_health::setup::scan_setup,
            usage::machine_health::setup_standing::get_sync_standing,
            usage::machine_health::setup_repo_keeper::get_setup_repo_keeper,
            usage::machine_health::setup_repo_keeper::keep_setup_repo_now,
            usage::machine_health::setup_autoline::get_setup_autoline,
            usage::machine_health::setup_autoline::set_setup_autoline_paused,
            usage::machine_health::setup::read_setup_text,
            usage::machine_health::setup::read_setup_skill,
            usage::machine_health::setup_sync::get_setup_repo,
            usage::machine_health::project_places::get_project_drift,
            usage::machine_health::project_fixes::apply_project_fixes,
            usage::machine_health::project_skills::apply_project_skills,
            usage::machine_health::project_hub::sync_local_project,
            usage::machine_health::setup_layers::add_setup_schemas,
            usage::machine_health::setup_sync::read_setup_repo_file,
            usage::machine_health::setup_repo_browse::list_setup_repo_tree,
            usage::machine_health::setup_repo_browse::read_setup_repo_text,
            usage::machine_health::setup_repo_browse::write_setup_repo_text,
            usage::machine_health::setup_repo_browse::move_setup_repo_path,
            usage::machine_health::setup_repo_browse::delete_setup_repo_path,
            usage::machine_health::setup_repo_browse::discard_setup_repo_changes,
            usage::machine_health::setup_repo_browse::get_setup_repo_changes,
            usage::machine_health::setup_repo_browse::get_setup_repo_log,
            usage::machine_health::setup_repo_browse::commit_setup_repo,
            usage::machine_health::setup_sync::start_setup_repo,
            usage::machine_health::setup_sync::take_setup_file,
            usage::machine_health::setup_wanted::set_setup_skill_machine,
            usage::machine_health::setup_repo_skills::set_setup_skill_removed,
            usage::machine_health::setup_repo_skills::drop_setup_skills,
            usage::machine_health::setup_sync::set_setup_file_removed,
            usage::machine_health::setup_sync::set_setup_skill_off,
            usage::machine_health::plugin_catalog::get_marketplace_catalog,
            usage::machine_health::setup_sync::set_setup_file_off,
            usage::machine_health::setup_wanted::set_setup_file_machine,
            usage::machine_health::setup_wanted::set_setup_plugin,
            usage::machine_health::setup_wanted::set_setup_codex_plugin,
            usage::machine_health::setup_wanted::set_setup_skill_project,
            usage::machine_health::checkout_settings::apply_checkout_skills,
            usage::machine_health::checkout_settings::apply_checkout_mcp,
            usage::machine_health::setup_wanted::set_setup_mcp_project,
            usage::machine_health::project_instructions::apply_checkout_instructions,
            usage::machine_health::setup_sync::pull_setup_repo,
            usage::machine_health::setup_sync::push_setup_repo,
            usage::machine_health::setup_sync::apply_setup_sync,
            usage::machine_health::setup_sync::list_setup_backups,
            usage::machine_health::setup_sync::undo_setup_sync,
            usage::machine_health::setup_repo_skills::take_setup_skills,
            usage::machine_health::setup_repo_skills::read_setup_repo_skill,
            usage::machine_health::setup_repo_skills::check_setup_skill_sources,
            usage::machine_health::setup_repo_skills::update_setup_skills,
            usage::machine_health::setup_skills::apply_skill_changes,
            usage::machine_health::transcripts::get_skill_usage,
            usage::machine_health::setup_plugins::apply_plugin_changes,
            usage::machine_health::setup_plugins::apply_codex_plugin_changes,
            usage::machine_health::setup_plugins::forget_plugin_leftovers,
            usage::machine_health::setup_plugins::check_mcp_health,
            usage::machine_health::setup_plugins::measure_plugin_costs,
            usage::machine_health::setup_mcp::get_mcp_registry,
            usage::machine_health::setup_mcp::apply_mcp_changes,
            usage::machine_health::setup_mcp::take_mcp_server,
            usage::machine_health::setup_mcp::set_mcp_wanted,
            usage::machine_health::setup_mcp::put_back_mcp_server,
            usage::machine_health::setup_hooks::get_hook_registry,
            usage::machine_health::setup_hooks::set_hook_wanted,
            usage::machine_health::setup_hooks::take_hook,
            usage::machine_health::setup_hooks::apply_hooks,
            usage::machine_health::setup_hooks::set_hook_agents,
            usage::machine_health::setup_projects::get_projects,
            usage::machine_health::setup_projects::scan_projects,
            usage::machine_health::setup_projects::measure_projects,
            usage::machine_health::setup_projects::read_project_file,
            usage::machine_health::setup_projects::remove_worktrees,
            usage::machine_health::setup_toolchain::get_toolchain,
            usage::machine_health::setup_toolchain::scan_toolchain,
            usage::machine_health::setup_toolchain::change_node_versions,
            usage::machine_health::transcripts::get_mcp_usage,
            usage::get_usage_pricing,
            usage::repair_usage_cache_records,
            usage::storage::get_usage_storage_info,
            usage::storage::set_usage_retention,
            usage::storage::compact_usage_database,
            usage::diagnostics::get_call_diagnostics,
            usage::diagnostics::clear_call_diagnostics,
            usage::diagnostics::undo_clear_call_diagnostics,
            usage::save_usage_model_price,
            usage::delete_usage_model_price,
            usage::sync_usage_model_prices,
            start_core_process,
            stop_core_process,
            restart_core_process,
            saved_store::saved_store_snapshot,
            saved_store::saved_store_set,
            saved_store::saved_store_migrate,
            cli::bridge::cli_bridge_ready,
            cli::bridge::cli_respond,
            cli::settings::get_cli_overview,
            cli::settings::save_cli_settings,
            cli::settings::install_cli_link,
            cli::settings::remove_cli_link,
            usage::machine_health::cli_skill::install_cli_skill,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build app");

    app.run(|app_handle, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => show_main_window(app_handle),
        tauri::RunEvent::ExitRequested { .. } => {
            if let Err(error) = persist_main_window_size(app_handle) {
                eprintln!("Failed to save main window size: {error}");
            }
        }
        tauri::RunEvent::Exit => {
            cli::server::stop();
            product_analytics::flush_on_quit(app_handle);
            usage::stop_usage_collector(app_handle);
            usage::machine_health::stop_machine_health_sampler(app_handle);
            let gui_config_state = app_handle.state::<GuiConfigState>();
            let process_state = app_handle.state::<CoreProcessState>();
            shutdown_managed_core(process_state.inner(), gui_config_state.inner());
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests;

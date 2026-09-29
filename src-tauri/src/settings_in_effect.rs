//! Whether the running core has the settings its config.yaml holds. The core reloads the file a moment after it
//! changes, but one value it can't read anywhere in the file makes it skip the whole reload, and only its own log says
//! so: on a copy of core 8.0.3 a bad request-retry kept a usage-statistics change saved beside it from taking effect.
//! Arbor asks the core what it's running after each save, and in the proxy checks, and compares.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::command_error::CommandError;
use crate::proxy_checks::{read_core, CoreAnswer};
use crate::{
    core_install_dir, core_logs_dir_path, core_start_log_path, current_core_status, is_example_core_api_key,
    read_installed_core_config_settings, CoreConfigSettings, CoreProcessState, GuiConfigState, CORE_CONFIG_FILE,
};

/// A setting the core takes from its file without a restart. Host, port, TLS and commercial mode only change when it
/// restarts, so a difference there says nothing about whether it reloaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LiveCoreSetting {
    Debug,
    LoggingToFile,
    LogsMaxTotalSize,
    ErrorLogsMaxFiles,
    RequestLog,
    UsageStatistics,
    UsageQueueRetention,
    DisableCooling,
    RequestRetry,
    MaxRetryCredentials,
    MaxRetryInterval,
    StreamingBootstrapRetries,
    RoutingStrategy,
    SessionAffinity,
    SessionAffinityTtl,
    ProxyUrl,
    Plugins,
    ClientKeys,
}

/// What `GET /v0/management/config` answers, cut down to the settings compared. It gives the values in effect under
/// the old flat names, with the core's defaults filled in; a field it leaves out when empty reads as empty here.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
pub(crate) struct RunningSettings {
    debug: bool,
    logging_to_file: bool,
    logs_max_total_size_mb: i64,
    error_logs_max_files: i64,
    request_log: bool,
    usage_statistics_enabled: bool,
    redis_usage_queue_retention_seconds: i64,
    disable_cooling: bool,
    request_retry: i64,
    max_retry_credentials: i64,
    max_retry_interval: i64,
    streaming: RunningStreaming,
    routing: RunningRouting,
    proxy_url: String,
    plugins: RunningPlugins,
    // Held only to be counted and compared, never passed on.
    api_keys: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
struct RunningStreaming {
    bootstrap_retries: i64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
struct RunningRouting {
    strategy: String,
    session_affinity: bool,
    session_affinity_ttl: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RunningPlugins {
    enabled: bool,
}

impl RunningSettings {
    pub(crate) fn usage_statistics_enabled(&self) -> bool {
        self.usage_statistics_enabled
    }

    /// The client keys it accepts, less the example ones Arbor never counts as keys.
    fn client_keys(&self) -> BTreeSet<&str> {
        self.api_keys
            .iter()
            .flatten()
            .map(|key| key.trim())
            .filter(|key| !key.is_empty() && !is_example_core_api_key(key))
            .collect()
    }

    pub(crate) fn client_key_count(&self) -> usize {
        self.client_keys().len()
    }
}

/// The live settings where the core runs something other than what its file says, in the order Settings lists them.
pub(crate) fn settings_not_in_effect(file: &CoreConfigSettings, running: &RunningSettings) -> Vec<LiveCoreSetting> {
    let number = |value: u32| i64::from(value);
    // The core leaves an empty strategy out and runs round-robin.
    let strategy = match running.routing.strategy.trim() {
        "" => "round-robin",
        strategy => strategy,
    };
    let file_keys: BTreeSet<&str> = file.api_keys.iter().map(|key| key.trim()).filter(|key| !key.is_empty()).collect();
    [
        (LiveCoreSetting::Debug, file.debug == running.debug),
        (LiveCoreSetting::LoggingToFile, file.logging_to_file == running.logging_to_file),
        (LiveCoreSetting::LogsMaxTotalSize, number(file.logs_max_total_size_mb) == running.logs_max_total_size_mb),
        (LiveCoreSetting::ErrorLogsMaxFiles, number(file.error_logs_max_files) == running.error_logs_max_files),
        (LiveCoreSetting::RequestLog, file.request_log == running.request_log),
        (LiveCoreSetting::UsageStatistics, file.usage_statistics_enabled == running.usage_statistics_enabled),
        (
            LiveCoreSetting::UsageQueueRetention,
            number(file.redis_usage_queue_retention_seconds) == running.redis_usage_queue_retention_seconds,
        ),
        (LiveCoreSetting::DisableCooling, file.disable_cooling == running.disable_cooling),
        (LiveCoreSetting::RequestRetry, number(file.request_retry) == running.request_retry),
        (LiveCoreSetting::MaxRetryCredentials, number(file.max_retry_credentials) == running.max_retry_credentials),
        (LiveCoreSetting::MaxRetryInterval, number(file.max_retry_interval) == running.max_retry_interval),
        (
            LiveCoreSetting::StreamingBootstrapRetries,
            number(file.streaming_bootstrap_retries) == running.streaming.bootstrap_retries,
        ),
        (LiveCoreSetting::RoutingStrategy, file.routing_strategy.trim() == strategy),
        (LiveCoreSetting::SessionAffinity, file.routing_session_affinity == running.routing.session_affinity),
        (
            LiveCoreSetting::SessionAffinityTtl,
            file.routing_session_affinity_ttl.trim() == running.routing.session_affinity_ttl.trim(),
        ),
        (LiveCoreSetting::ProxyUrl, file.proxy_url.trim() == running.proxy_url.trim()),
        (LiveCoreSetting::Plugins, file.plugins_enabled == running.plugins.enabled),
        (LiveCoreSetting::ClientKeys, file_keys == running.client_keys()),
    ]
    .into_iter()
    .filter_map(|(setting, same)| (!same).then_some(setting))
    .collect()
}

/// The line of its file the core last said it couldn't read, unless it has loaded the file since. Only the number is
/// taken: the core quotes the value it choked on, which could be a key.
pub(crate) fn failed_reload_line(log: &str) -> Option<u32> {
    let failed = log.rfind("failed to reload config")?;
    if log[failed..].contains("config successfully reloaded") {
        return None;
    }
    // The reason follows on the same line ("yaml: line 12: …") or the next few ("  line 153: cannot unmarshal …").
    log[failed..].lines().take(4).find_map(|line| {
        line.match_indices("line ").find_map(|(at, _)| {
            // The word itself, not the end of "deadline".
            if line[..at].ends_with(char::is_alphabetic) {
                return None;
            }
            let rest = &line[at + "line ".len()..];
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            (digits > 0 && rest[digits..].starts_with(':')).then(|| rest[..digits].parse().ok()).flatten()
        })
    })
}

/// The end of the core's own output, where a failed reload is logged. The log keeps only the current run.
fn read_core_output_tail(log_path: &Path) -> String {
    const TAIL: u64 = 64 * 1024;
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(log_path) else {
        return String::new();
    };
    let length = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(length.saturating_sub(TAIL)));
    let mut bytes = Vec::new();
    let _ = file.take(TAIL).read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Where the core's log goes: its output, which Arbor keeps, or with logging to file on, main.log in its own logs
/// folder (`core_own_logs_dir_path`). Both folders are read, since the core picks one when it starts. Only one of the
/// logs is written at a time.
fn core_log_paths(auth_dir: &str) -> Vec<PathBuf> {
    let Ok(install_dir) = core_install_dir() else {
        return Vec::new();
    };
    let mut paths = vec![
        core_start_log_path(&install_dir, auth_dir),
        install_dir.join("logs").join("main.log"),
        core_logs_dir_path(auth_dir, &install_dir).join("main.log"),
    ];
    paths.dedup();
    paths
}

/// How long each of the core's logs is now, so what it logs after a write can be read on its own.
pub(crate) fn core_log_marks(auth_dir: &str) -> Vec<(PathBuf, u64)> {
    core_log_paths(auth_dir)
        .into_iter()
        .map(|path| {
            let length = std::fs::metadata(&path).map_or(0, |metadata| metadata.len());
            (path, length)
        })
        .collect()
}

/// What the core has logged since `marks`. A log that's shorter now was started over, by a restart or its rotation,
/// and is read from the start.
pub(crate) fn core_log_since(marks: &[(PathBuf, u64)]) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let mut log = String::new();
    for (path, from) in marks {
        let Ok(mut file) = std::fs::File::open(path) else {
            continue;
        };
        let length = file.metadata().map_or(0, |metadata| metadata.len());
        let _ = file.seek(SeekFrom::Start(if *from <= length { *from } else { 0 }));
        let mut bytes = Vec::new();
        let _ = file.take(64 * 1024).read_to_end(&mut bytes);
        log.push_str(&String::from_utf8_lossy(&bytes));
    }
    log
}

/// What the core made of a changed config.yaml, from what it logged after the change.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Reload {
    Loaded,
    /// It kept running what it had; the line it couldn't read, when it said.
    Failed(Option<u32>),
    /// It hasn't said yet.
    Pending,
}

pub(crate) fn reload_outcome(log: &str) -> Reload {
    match (log.rfind("failed to reload config"), log.rfind("config successfully reloaded")) {
        (Some(failed), Some(loaded)) if loaded > failed => Reload::Loaded,
        (Some(_), _) => Reload::Failed(failed_reload_line(log)),
        (None, Some(_)) => Reload::Loaded,
        (None, None) => Reload::Pending,
    }
}

/// The line the core couldn't read, from its log next to the credentials it was started with.
pub(crate) fn core_reload_failure_line(auth_dir: &str) -> Option<u32> {
    let live = core_log_paths(auth_dir)
        .into_iter()
        .filter_map(|path| Some((std::fs::metadata(&path).ok()?.modified().ok()?, path)))
        .max_by_key(|(modified, _)| *modified)?;
    failed_reload_line(&read_core_output_tail(&live.1))
}

/// Whether config.yaml changed within `window`, when the core may still be reloading it.
pub(crate) fn core_config_changed_within(window: Duration) -> bool {
    let Ok(install_dir) = core_install_dir() else {
        return false;
    };
    std::fs::metadata(install_dir.join(CORE_CONFIG_FILE))
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age < window)
}

/// Where the running core stands against its file.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Standing {
    /// It runs what the file says.
    InStep,
    /// It runs something else, or couldn't load a file Arbor can't read either.
    NotLoaded { settings: Vec<LiveCoreSetting>, line: Option<u32> },
    /// Arbor can't read the file and the core hasn't said it failed to, so there's no telling: Arbor's reader is
    /// stricter than the core's in places (a negative retry count), and a file it can't read may still load.
    Unclear,
}

/// Where the core stands, from the file as Arbor read it, what the core answered and the line its log names.
pub(crate) fn standing(
    file: Result<CoreConfigSettings, String>,
    running: &RunningSettings,
    failed_line: impl FnOnce() -> Option<u32>,
) -> Standing {
    match file {
        Ok(file) => match settings_not_in_effect(&file, running) {
            settings if settings.is_empty() => Standing::InStep,
            settings => Standing::NotLoaded { settings, line: failed_line() },
        },
        Err(_) => match failed_line() {
            Some(line) => Standing::NotLoaded { settings: Vec::new(), line: Some(line) },
            None => Standing::Unclear,
        },
    }
}

/// Where the core stands against the installed config.yaml.
pub(crate) fn core_standing(running: &RunningSettings, auth_dir: &str) -> Standing {
    standing(read_installed_core_config_settings(), running, || core_reload_failure_line(auth_dir))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum InEffect {
    /// The core runs what the file says.
    Live,
    /// The core still runs something else after waiting for it to reload.
    NotLoaded,
    /// The core isn't running; it reads the file when it starts.
    CoreStopped,
    /// The core didn't answer, or turned Arbor away, so there's nothing to say either way.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsInEffect {
    pub(crate) state: InEffect,
    /// What the core still runs differently, when it hasn't loaded the file.
    pub(crate) settings: Vec<LiveCoreSetting>,
    /// The line of config.yaml the core said it couldn't read.
    pub(crate) line: Option<u32>,
}

impl SettingsInEffect {
    fn just(state: InEffect) -> Self {
        Self { state, settings: Vec::new(), line: None }
    }
}

/// How long a save waits for the core to reload before saying it didn't: it takes about 0.2 s.
const RELOAD_WAIT: Duration = Duration::from_secs(3);
const RELOAD_POLL: Duration = Duration::from_millis(200);

/// After a settings save, waits until the running core has what config.yaml now says, and says whether it got there.
/// It's never asked after the management key changes: the core locks this Mac out for 30 minutes after five refused
/// keys, so a refusal ends the wait at once.
#[tauri::command]
pub(crate) async fn confirm_core_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    process_state: tauri::State<'_, CoreProcessState>,
) -> Result<SettingsInEffect, CommandError> {
    let config = gui_config_state.snapshot()?;
    if !current_core_status(Some(process_state.inner()), Some(config.port))?.ready {
        return Ok(SettingsInEffect::just(InEffect::CoreStopped));
    }
    let deadline = Instant::now() + RELOAD_WAIT;
    loop {
        tokio::time::sleep(RELOAD_POLL).await;
        let running = match read_core(&config, "config", |running: RunningSettings| running).await? {
            CoreAnswer::Value(running) => running,
            CoreAnswer::Refused(_) | CoreAnswer::Unreachable => return Ok(SettingsInEffect::just(InEffect::Unknown)),
        };
        match core_standing(&running, &config.auth_dir) {
            Standing::InStep => return Ok(SettingsInEffect::just(InEffect::Live)),
            _ if Instant::now() < deadline => {}
            Standing::NotLoaded { settings, line } => {
                return Ok(SettingsInEffect { state: InEffect::NotLoaded, settings, line });
            }
            Standing::Unclear => return Ok(SettingsInEffect::just(InEffect::Unknown)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_the_core_logged_after_the_mark_is_read_from_whichever_log_it_writes() {
        let dir = std::env::temp_dir().join(format!("arbor-core-log-marks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let output = dir.join("core-start-output.log");
        let main = dir.join("main.log");
        std::fs::write(&output, "config successfully reloaded, triggering client reload\n").unwrap();
        std::fs::write(&main, "an earlier run of the core, which logged a good deal more than this\n".repeat(4)).unwrap();
        let marks: Vec<(PathBuf, u64)> = [&output, &main, &dir.join("absent.log")]
            .into_iter()
            .map(|path| (path.clone(), std::fs::metadata(path).map_or(0, |metadata| metadata.len())))
            .collect();
        assert_eq!(core_log_since(&marks), "");

        // Logging to file: the reload is logged in main.log. Rotation started it over, so all of it is new.
        std::fs::write(&main, "failed to reload config: yaml: line 7: bad\n").unwrap();
        assert_eq!(reload_outcome(&core_log_since(&marks)), Reload::Failed(Some(7)));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_reload_is_read_from_what_the_core_logged_after_the_write() {
        assert_eq!(reload_outcome(""), Reload::Pending);
        assert_eq!(reload_outcome("config file changed, reloading\n"), Reload::Pending);
        assert_eq!(
            reload_outcome("config successfully reloaded, triggering client reload\n"),
            Reload::Loaded
        );
        let failed = "failed to reload config: yaml: unmarshal errors:\n  line 42: cannot unmarshal !!str into int\n";
        assert_eq!(reload_outcome(failed), Reload::Failed(Some(42)));
        assert_eq!(reload_outcome("failed to reload config: open config.yaml: no such file\n"), Reload::Failed(None));
        assert_eq!(
            reload_outcome(&format!("{failed}config successfully reloaded, triggering client reload\n")),
            Reload::Loaded
        );
    }

    fn file() -> CoreConfigSettings {
        crate::core_config_settings_from_value(
            &serde_norway::from_str(
                "config-version: 8\n\
                 access:\n  api-keys: [\"sk-one\", \"sk-two\"]\n\
                 routing:\n  strategy: fill-first\n  retry:\n    request-retry: 4\n    max-retry-interval: 30\n\
                 observability:\n  usage:\n    usage-statistics-enabled: true\n",
            )
            .unwrap(),
        )
        .unwrap()
    }

    fn running(json: serde_json::Value) -> RunningSettings {
        serde_json::from_value(json).unwrap()
    }

    fn matching() -> serde_json::Value {
        serde_json::json!({
            "api-keys": ["sk-two", "sk-one"],
            "routing": { "strategy": "fill-first", "session-affinity-subagents": true },
            "request-retry": 4,
            "max-retry-interval": 30,
            "max-retry-credentials": 0,
            "usage-statistics-enabled": true,
            "redis-usage-queue-retention-seconds": 60,
            "error-logs-max-files": 10,
            "logs-max-total-size-mb": 0,
            "proxy-url": "",
            "plugins": { "enabled": false, "dir": "plugins" },
            "streaming": {},
            "tls": { "enable": false }
        })
    }

    #[test]
    fn a_core_running_what_its_file_says_has_nothing_out_of_step() {
        assert_eq!(settings_not_in_effect(&file(), &running(matching())), []);
    }

    #[test]
    fn each_live_setting_the_core_runs_differently_is_named() {
        let mut answer = matching();
        answer["usage-statistics-enabled"] = false.into();
        answer["request-retry"] = 3.into();
        answer["api-keys"] = serde_json::json!(["sk-one"]);
        assert_eq!(
            settings_not_in_effect(&file(), &running(answer)),
            [LiveCoreSetting::UsageStatistics, LiveCoreSetting::RequestRetry, LiveCoreSetting::ClientKeys]
        );
    }

    #[test]
    fn an_empty_strategy_is_the_round_robin_the_core_runs() {
        let mut settings = file();
        settings.routing_strategy = "round-robin".into();
        let mut answer = matching();
        answer["routing"] = serde_json::json!({});
        assert_eq!(settings_not_in_effect(&settings, &running(answer)), []);
    }

    #[test]
    fn example_keys_the_core_accepts_are_not_counted() {
        let mut answer = matching();
        answer["api-keys"] = serde_json::json!(["sk-one", "your-api-key-1", "sk-two"]);
        let with_examples = running(answer);
        assert_eq!(with_examples.client_key_count(), 2);
        assert_eq!(settings_not_in_effect(&file(), &with_examples), []);
        assert_eq!(running(serde_json::json!({ "api-keys": null })).client_key_count(), 0);
    }

    #[test]
    fn restart_only_settings_are_left_out() {
        let mut answer = matching();
        answer["tls"] = serde_json::json!({ "enable": true });
        answer["commercial-mode"] = true.into();
        assert_eq!(settings_not_in_effect(&file(), &running(answer)), []);
    }

    #[test]
    fn a_file_arbor_cannot_read_counts_only_when_the_core_failed_on_it_too() {
        let unreadable = || Err("request-retry must be a non-negative integer".to_string());
        assert_eq!(
            standing(unreadable(), &running(matching()), || Some(153)),
            Standing::NotLoaded { settings: Vec::new(), line: Some(153) }
        );
        assert_eq!(standing(unreadable(), &running(matching()), || None), Standing::Unclear);
        assert_eq!(standing(Ok(file()), &running(matching()), || Some(153)), Standing::InStep);
        let mut answer = matching();
        answer["request-retry"] = 3.into();
        assert_eq!(
            standing(Ok(file()), &running(answer), || None),
            Standing::NotLoaded { settings: vec![LiveCoreSetting::RequestRetry], line: None }
        );
    }

    #[test]
    fn a_failed_reload_gives_the_line_it_named_and_never_the_value() {
        let log = "[info ] config file changed, reloading\n\
                   [error] [config_reload.go:94] failed to reload config: failed to parse config file: yaml: unmarshal errors:\n  \
                   line 153: cannot unmarshal !!str `sk-secret` into int\n";
        assert_eq!(failed_reload_line(log), Some(153));
        let syntax = "[error] failed to reload config: failed to parse config file: yaml: line 12: did not find expected key\n";
        assert_eq!(failed_reload_line(syntax), Some(12));
    }

    #[test]
    fn a_reload_that_worked_since_clears_the_failure() {
        let log = "[error] failed to reload config: yaml: line 12: did not find expected key\n\
                   [info ] config file changed, reloading\n\
                   [info ] config successfully reloaded, triggering client reload\n";
        assert_eq!(failed_reload_line(log), None);
        assert_eq!(failed_reload_line("[info ] config successfully reloaded\n"), None);
        assert_eq!(failed_reload_line("[error] failed to reload config: permission denied\n"), None);
        assert_eq!(failed_reload_line("[error] failed to reload config: deadline 5: exceeded, line 7: bad\n"), Some(7));
    }
}

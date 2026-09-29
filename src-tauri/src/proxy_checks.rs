//! Checks on the proxy settings Arbor depends on, asked of the running core rather than read from its config.yaml: the
//! core fills in its own default for what the file leaves out, and a config it hasn't reloaded yet says one thing while
//! it runs with another. With usage statistics off, for one, Usage just goes quiet; these say why.

use serde::Serialize;
use ts_rs::TS;

use crate::command_error::CommandError;
use crate::management_api::{management_authorization, management_endpoint, management_http_client, send_management};
use crate::settings_in_effect::{core_config_changed_within, core_standing, LiveCoreSetting, RunningSettings, Standing};
use crate::{current_core_status, is_loopback_host, CoreProcessState, GuiConfigState};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProxyProblemKind {
    /// The management API turned Arbor away or isn't there: accounts, sign-ins and usage all go through it.
    ManagementRefused,
    /// Usage statistics are off, so the core sends Arbor no usage records.
    UsageOff,
    /// No client API keys, so anyone who can reach the proxy can use its accounts.
    NoClientKeys,
    /// The core runs settings other than its config.yaml's: a value it couldn't read made it skip the reload.
    SettingsNotLoaded,
    /// The proxy listens beyond this Mac.
    OpenToNetwork,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxyProblem {
    pub(crate) kind: ProxyProblemKind,
    /// The management API's HTTP status, the address the proxy listens on, or the line of config.yaml the core
    /// couldn't read.
    pub(crate) detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxyChecks {
    /// Whether the core answered. A stopped core isn't checked: its own status says so.
    pub(crate) checked: bool,
    pub(crate) problems: Vec<ProxyProblem>,
}

/// What the core answered one management read with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CoreAnswer<T> {
    Value(T),
    /// A status other than 200, such as 401 for a key it doesn't take or 404 with remote management off.
    Refused(u16),
    /// No answer at all: the core stopped or is restarting.
    Unreachable,
}

impl<T> CoreAnswer<T> {
    fn pick<U>(&self, pick: impl FnOnce(&T) -> U) -> CoreAnswer<U> {
        match self {
            CoreAnswer::Value(value) => CoreAnswer::Value(pick(value)),
            CoreAnswer::Refused(status) => CoreAnswer::Refused(*status),
            CoreAnswer::Unreachable => CoreAnswer::Unreachable,
        }
    }
}

/// The problems in what the core answered, in the order a banner lists them. A refused management API hides the
/// rest, which it would have answered. A file the core didn't load comes first, and hides usage being off or no keys
/// when that's only because it's still running older settings: turning usage on or adding a key wouldn't help.
pub(crate) fn proxy_problems(
    usage: CoreAnswer<bool>,
    client_keys: CoreAnswer<usize>,
    host: &str,
    standing: Standing,
) -> ProxyChecks {
    let mut problems = Vec::new();
    let refused = match (&usage, &client_keys) {
        (CoreAnswer::Unreachable, _) | (_, CoreAnswer::Unreachable) => return ProxyChecks { checked: false, problems },
        (CoreAnswer::Refused(status), _) | (_, CoreAnswer::Refused(status)) => Some(*status),
        _ => None,
    };
    if let Some(status) = refused {
        problems.push(ProxyProblem { kind: ProxyProblemKind::ManagementRefused, detail: Some(status.to_string()) });
    } else {
        let stale = match standing {
            Standing::NotLoaded { settings, line } => {
                problems.push(ProxyProblem {
                    kind: ProxyProblemKind::SettingsNotLoaded,
                    detail: line.map(|line| line.to_string()),
                });
                settings
            }
            Standing::InStep | Standing::Unclear => Vec::new(),
        };
        if usage == CoreAnswer::Value(false) && !stale.contains(&LiveCoreSetting::UsageStatistics) {
            problems.push(ProxyProblem { kind: ProxyProblemKind::UsageOff, detail: None });
        }
        if client_keys == CoreAnswer::Value(0) && !stale.contains(&LiveCoreSetting::ClientKeys) {
            problems.push(ProxyProblem { kind: ProxyProblemKind::NoClientKeys, detail: None });
        }
    }
    if !is_loopback_host(host) {
        problems.push(ProxyProblem { kind: ProxyProblemKind::OpenToNetwork, detail: Some(host.trim().to_string()) });
    }
    ProxyChecks { checked: true, problems }
}

/// Reads one management value, keeping only what the caller needs: client keys are counted or compared, never passed
/// on.
pub(crate) async fn read_core<R: serde::de::DeserializeOwned, T>(
    config: &crate::GuiConfigFile,
    path: &str,
    pick: impl FnOnce(R) -> T,
) -> Result<CoreAnswer<T>, String> {
    let request = management_http_client()?
        .get(management_endpoint(config, path)?)
        .header("Authorization", management_authorization(config)?)
        .timeout(std::time::Duration::from_secs(5));
    let Ok(response) = send_management(request).await else {
        return Ok(CoreAnswer::Unreachable);
    };
    let status = response.status().as_u16();
    if status != 200 {
        return Ok(CoreAnswer::Refused(status));
    }
    let reply = response
        .json::<R>()
        .await
        .map_err(|error| format!("The core's answer to {path} wasn't what Arbor expected: {error}"))?;
    Ok(CoreAnswer::Value(pick(reply)))
}

/// How long after config.yaml changes the check leaves it be: the core takes about 0.2 s to reload it.
const RELOAD_SETTLE: std::time::Duration = std::time::Duration::from_secs(5);

/// Checks the running core's usage statistics and client keys, that it runs what config.yaml says, and where it
/// listens. One read of its settings in effect answers all of them.
#[tauri::command]
pub(crate) async fn check_proxy_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    process_state: tauri::State<'_, CoreProcessState>,
) -> Result<ProxyChecks, CommandError> {
    let config = gui_config_state.snapshot()?;
    if !current_core_status(Some(process_state.inner()), Some(config.port))?.ready {
        return Ok(ProxyChecks { checked: false, problems: Vec::new() });
    }
    // Without a plaintext key there's nothing to ask with, which is the management API turning Arbor away.
    if management_authorization(&config).is_err() {
        return Ok(proxy_problems(CoreAnswer::Refused(401), CoreAnswer::Refused(401), &config.host, Standing::InStep));
    }
    let mut running = read_core(&config, "config", |running: RunningSettings| running).await?;
    // A core that's just restarted, or a key being changed, can turn one request away; asked again, a refusal that
    // lasts is real.
    if matches!(running, CoreAnswer::Refused(_)) {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let config = gui_config_state.snapshot()?;
        running = read_core(&config, "config", |running: RunningSettings| running).await?;
    }
    let standing = match &running {
        CoreAnswer::Value(running) if !core_config_changed_within(RELOAD_SETTLE) => {
            core_standing(running, &config.auth_dir)
        }
        _ => Standing::InStep,
    };
    Ok(proxy_problems(
        running.pick(RunningSettings::usage_statistics_enabled),
        running.pick(RunningSettings::client_key_count),
        &config.host,
        standing,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(checks: &ProxyChecks) -> Vec<ProxyProblemKind> {
        checks.problems.iter().map(|problem| problem.kind).collect()
    }

    fn not_loaded(settings: &[LiveCoreSetting], line: Option<u32>) -> Standing {
        Standing::NotLoaded { settings: settings.to_vec(), line }
    }

    #[test]
    fn a_file_the_core_did_not_load_comes_first_with_its_line() {
        let checks = proxy_problems(
            CoreAnswer::Value(true),
            CoreAnswer::Value(2),
            "127.0.0.1",
            not_loaded(&[LiveCoreSetting::RequestRetry], Some(153)),
        );
        assert_eq!(
            checks.problems,
            [ProxyProblem { kind: ProxyProblemKind::SettingsNotLoaded, detail: Some("153".into()) }]
        );
    }

    #[test]
    fn usage_off_or_no_keys_only_because_the_file_was_not_loaded_are_not_offered_a_fix() {
        let stale = not_loaded(&[LiveCoreSetting::UsageStatistics, LiveCoreSetting::ClientKeys], None);
        let checks = proxy_problems(CoreAnswer::Value(false), CoreAnswer::Value(0), "127.0.0.1", stale);
        assert_eq!(kinds(&checks), [ProxyProblemKind::SettingsNotLoaded]);

        // Off in the file as well: turning it on is the fix, whatever else didn't load.
        let other = not_loaded(&[LiveCoreSetting::RequestRetry], None);
        let checks = proxy_problems(CoreAnswer::Value(false), CoreAnswer::Value(2), "127.0.0.1", other);
        assert_eq!(kinds(&checks), [ProxyProblemKind::SettingsNotLoaded, ProxyProblemKind::UsageOff]);
    }

    #[test]
    fn a_healthy_proxy_on_this_mac_has_no_problems() {
        let checks = proxy_problems(CoreAnswer::Value(true), CoreAnswer::Value(2), "127.0.0.1", Standing::InStep);
        assert_eq!(checks, ProxyChecks { checked: true, problems: Vec::new() });
    }

    #[test]
    fn usage_off_and_no_client_keys_are_each_a_problem() {
        let checks = proxy_problems(CoreAnswer::Value(false), CoreAnswer::Value(0), "localhost", Standing::InStep);
        assert_eq!(kinds(&checks), [ProxyProblemKind::UsageOff, ProxyProblemKind::NoClientKeys]);
    }

    #[test]
    fn a_refused_management_api_hides_what_it_would_have_answered() {
        for (usage, keys) in [
            (CoreAnswer::Refused(404), CoreAnswer::Refused(404)),
            (CoreAnswer::Value(false), CoreAnswer::Refused(404)),
            (CoreAnswer::Refused(404), CoreAnswer::Value(0)),
        ] {
            let checks = proxy_problems(usage, keys, "127.0.0.1", not_loaded(&[], Some(3)));
            assert_eq!(
                checks.problems,
                [ProxyProblem { kind: ProxyProblemKind::ManagementRefused, detail: Some("404".into()) }]
            );
        }
    }

    #[test]
    fn listening_beyond_this_mac_names_the_address() {
        for host in ["0.0.0.0", "", "::", "192.168.1.20"] {
            let checks = proxy_problems(CoreAnswer::Value(true), CoreAnswer::Value(1), host, Standing::InStep);
            assert_eq!(
                checks.problems,
                [ProxyProblem { kind: ProxyProblemKind::OpenToNetwork, detail: Some(host.to_string()) }],
                "{host:?}"
            );
        }
        let checks = proxy_problems(CoreAnswer::Value(true), CoreAnswer::Value(1), "::1", Standing::InStep);
        assert!(checks.problems.is_empty());
    }

    #[test]
    fn a_core_that_stops_answering_is_not_checked() {
        let checks = proxy_problems(CoreAnswer::Unreachable, CoreAnswer::Value(0), "0.0.0.0", not_loaded(&[], None));
        assert_eq!(checks, ProxyChecks { checked: false, problems: Vec::new() });
    }
}

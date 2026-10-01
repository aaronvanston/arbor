//! Running one request from the command line inside the app: the command table's helpers, the access rules, and the
//! choice between the app's own commands, the window's actions and the socket's own methods.

use super::{audit, bridge, commands, protocol, redact, settings};
use crate::command_error::CommandError;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Instant;
use tauri::Manager;
use ts_rs::TS;

/// What a command does, which decides whether it runs straight away.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "CliAccess")]
pub(crate) enum Access {
    /// Only looks.
    Read,
    /// Changes something the window would change without asking.
    Write,
    /// Changes something the window asks about first; the request has to carry `confirm`.
    Confirm,
}

/// One argument a command takes, by the name the webview passes it with.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArgSpec {
    pub(crate) name: &'static str,
    /// Its TypeScript type, from src/native/types.ts.
    pub(crate) ts_type: &'static str,
    pub(crate) optional: bool,
}

/// One command the command line can call.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandSpec {
    pub(crate) name: &'static str,
    pub(crate) access: Access,
    pub(crate) summary: &'static str,
    pub(crate) args: &'static [ArgSpec],
}

/// One argument from a request; a missing one reads as null, which an optional argument takes as none.
pub(crate) fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, CommandError> {
    let value = args.get(name).cloned().unwrap_or(Value::Null);
    serde_json::from_value(value).map_err(|error| CommandError::failed(format!("The {name} argument isn't right: {error}")))
}

/// A command's answer as JSON, from a command that can fail.
pub(crate) fn done<T: Serialize, E: Into<CommandError>>(result: Result<T, E>) -> Result<Value, CommandError> {
    result.map_err(Into::into).and_then(plain)
}

/// A command's answer as JSON, from a command that can't fail.
pub(crate) fn plain<T: Serialize>(value: T) -> Result<Value, CommandError> {
    serde_json::to_value(value).map_err(|error| CommandError::failed(format!("Couldn't write the answer: {error}")))
}

/// Runs a plain command off the async runtime, where the app runs it too.
pub(crate) async fn blocking<F>(run: F) -> Result<Value, CommandError>
where
    F: FnOnce() -> Result<Value, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(run)
        .await
        .map_err(|error| CommandError::failed(format!("The command stopped before it finished: {error}")))?
}

/// What a request to the socket can be, once its method has been looked up.
enum Target {
    Command(&'static CommandSpec),
    Window(bridge::CliWindowAction),
}

fn find_command(name: &str) -> Option<&'static CommandSpec> {
    commands::COMMANDS.iter().find(|spec| spec.name == name)
}

/// The methods the socket answers, for `hello`: every command, then every action the window has registered.
pub(crate) fn method_list(app: &tauri::AppHandle) -> Value {
    let window = app.state::<bridge::BridgeState>().actions();
    json!({ "commands": commands::COMMANDS, "windowActions": window })
}

/// What a change would do, for a request without `confirm`.
fn plan_for(method: &str, summary: &str, args: &Value) -> Value {
    json!({ "method": method, "summary": summary, "args": redact::redacted(args.clone()) })
}

/// Answers one request. `client` is who's asking (the command line or the MCP server), for the activity log.
pub(crate) async fn handle(app: &tauri::AppHandle, client: &str, request: protocol::Request) -> protocol::Response {
    let started = Instant::now();
    let method = request.method.clone();
    let (access, outcome) = answer(app, request.clone()).await;
    let response = match outcome {
        Outcome::Ok(value) => protocol::Response::ok(&request.id, redact::redacted(value)),
        Outcome::Plan(plan) => protocol::Response::plan(&request.id, plan),
        Outcome::Error(error) => protocol::Response::error(&request.id, error),
    };
    audit::record(&audit::Entry::new(client, &method, access, &response, started.elapsed()));
    response
}

enum Outcome {
    Ok(Value),
    Plan(Value),
    Error(CommandError),
}

impl From<Result<Value, CommandError>> for Outcome {
    fn from(result: Result<Value, CommandError>) -> Self {
        match result {
            Ok(value) => Self::Ok(value),
            Err(error) => Self::Error(error),
        }
    }
}

async fn answer(app: &tauri::AppHandle, request: protocol::Request) -> (Option<Access>, Outcome) {
    let allowed = settings::read();
    if !allowed.enabled {
        return (None, Outcome::Error(protocol::unavailable("Command line control is off in Arbor's Settings › Software.")));
    }
    if request.method == protocol::HELLO {
        return (None, Outcome::Ok(protocol::hello(app)));
    }
    let target = match find_command(&request.method) {
        Some(spec) => Target::Command(spec),
        None => match app.state::<bridge::BridgeState>().action(&request.method) {
            Some(action) => Target::Window(action),
            None => {
                let message = format!("Arbor has no command called {}. `arbor commands` lists them.", request.method);
                return (None, Outcome::Error(protocol::unsupported(message)));
            }
        },
    };
    let (access, summary) = match &target {
        Target::Command(spec) => (spec.access, spec.summary.to_string()),
        Target::Window(action) => (action.access, action.summary.clone()),
    };
    if access != Access::Read && !allowed.changes {
        let message = "Changes from the command line are off in Arbor's Settings › Software.";
        return (Some(access), Outcome::Error(protocol::unsupported(message)));
    }
    if access == Access::Confirm && !request.confirm {
        return (Some(access), Outcome::Plan(plan_for(&request.method, &summary, &request.args)));
    }
    let result = match target {
        Target::Command(spec) => match commands::call(app, spec.name, &request.args).await {
            Some(result) => result,
            None => Err(protocol::unsupported(format!("Arbor has no command called {}.", spec.name))),
        },
        Target::Window(action) => bridge::ask_window(app, &action.name, request.args, request.confirm).await,
    };
    (Some(access), result.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn a_missing_argument_reads_as_none_and_a_wrong_one_names_itself() {
        let args = json!({ "since": 5, "name": 3 });
        assert_eq!(arg::<Option<u64>>(&args, "windowMs").unwrap(), None);
        assert_eq!(arg::<Option<u64>>(&args, "since").unwrap(), Some(5));
        let error = arg::<String>(&args, "name").unwrap_err();
        assert!(error.message.contains("name"), "{}", error.message);
    }

    #[test]
    fn answers_are_json_and_failures_keep_their_kind() {
        assert_eq!(done::<_, String>(Ok(vec![1, 2])).unwrap(), json!([1, 2]));
        let error = done::<(), _>(Err(CommandError::canceled("Stopped"))).unwrap_err();
        assert_eq!(error, CommandError::canceled("Stopped"));
        assert_eq!(done::<(), String>(Err("No".into())).unwrap_err(), CommandError::failed("No"));
    }

    #[test]
    fn every_command_has_one_entry_and_reads_never_ask() {
        let mut seen = HashSet::new();
        for spec in commands::COMMANDS {
            assert!(seen.insert(spec.name), "{} is in the table twice", spec.name);
            if spec.name.starts_with("get_") {
                assert_eq!(spec.access, Access::Read, "{}", spec.name);
            }
        }
        assert_eq!(find_command("stop_core_process").map(|spec| spec.access), Some(Access::Confirm));
    }

    #[test]
    fn nothing_that_spends_a_reset_or_passes_requests_through_is_in_the_table() {
        for spec in commands::COMMANDS {
            for word in ["management_request", "reset", "redeem", "claim", "banked"] {
                assert!(!spec.name.contains(word), "{} can't be reachable from the command line", spec.name);
            }
        }
    }

    #[test]
    fn a_plan_shows_the_arguments_with_secrets_hidden() {
        let plan = plan_for("save_machine_hosts", "Saves the hosts", &json!({ "hosts": ["casey-mbp"] }));
        assert_eq!(plan["args"]["hosts"], json!(["casey-mbp"]));
        let plan = plan_for("x", "y", &json!({ "apiKey": "sk-abcdefghijklmnop" }));
        assert_eq!(plan["args"]["apiKey"], json!(redact::HIDDEN));
    }
}

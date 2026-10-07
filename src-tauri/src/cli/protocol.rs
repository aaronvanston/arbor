//! What crosses the socket: one JSON value a line. A request names a method and its arguments; the answer is the
//! method's result, a plan for a change that wasn't confirmed, or the `CommandError` the window would have got.
//! `watch` turns its connection into a stream of the app's events.

use crate::command_error::{CommandError, CommandErrorKind};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The envelope's version. A change that an older `arbor` would misread raises it; new methods and arguments don't.
pub(crate) const PROTOCOL: u32 = 1;
/// The longest line either side accepts, so a stray writer can't make the other hold everything it sends.
pub(crate) const MAX_LINE: usize = 8 * 1024 * 1024;

pub(crate) const HELLO: &str = "hello";
pub(crate) const WATCH: &str = "watch";
/// Routes an SSH connection to one of a pool's machines and holds it there until the connection closes.
pub(crate) const POOL_CONNECT: &str = "pools.connect";

/// The events `watch` passes on: everything the window listens to so it stays current.
pub(crate) const WATCHED_EVENTS: &[&str] = &[
    "core-status-changed",
    "config-files-changed",
    "usage-records-updated",
    "machine-health-updated",
    "agent-telemetry-updated",
    "agent-attention-updated",
    "agent-homes-updated",
    "machine-pools-updated",
    "pool-ssh-updated",
    "harness-runs-updated",
    "t3-threads-updated",
    "session-transcripts-updated",
    "setup-inventory-updated",
    "setup-changed",
    "setup-projects-updated",
    "setup-toolchain-updated",
    "saved-store-changed",
    "app-update-progress",
    "core-install-progress",
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Request {
    #[serde(default)]
    pub(crate) id: String,
    pub(crate) method: String,
    #[serde(default)]
    pub(crate) args: Value,
    /// Set once the person (or the agent's person) has seen the plan and wants the change.
    #[serde(default)]
    pub(crate) confirm: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Response {
    pub(crate) v: u32,
    pub(crate) id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ok: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) plan: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<WireError>,
}

/// A `CommandError` as it crosses the socket, with the two kinds only the socket has.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WireError {
    /// failed, canceled, core, changed, unarchived, unsupported (no such method, or not allowed) or unavailable (not ready, or too slow).
    pub(crate) kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
    pub(crate) message: String,
}

/// The socket's own kinds ride in `reason`, so they stay `CommandError`s inside the app.
const UNSUPPORTED: &str = "arbor-cli:unsupported";
const UNAVAILABLE: &str = "arbor-cli:unavailable";

pub(crate) fn unsupported(message: impl Into<String>) -> CommandError {
    CommandError { reason: Some(UNSUPPORTED.into()), ..CommandError::failed(message) }
}

pub(crate) fn unavailable(message: impl Into<String>) -> CommandError {
    CommandError { reason: Some(UNAVAILABLE.into()), ..CommandError::failed(message) }
}

impl From<CommandError> for WireError {
    fn from(error: CommandError) -> Self {
        let (kind, reason) = match (error.kind, error.reason.as_deref()) {
            (_, Some(UNSUPPORTED)) => ("unsupported", None),
            (_, Some(UNAVAILABLE)) => ("unavailable", None),
            (CommandErrorKind::Failed, _) => ("failed", error.reason),
            (CommandErrorKind::Canceled, _) => ("canceled", error.reason),
            (CommandErrorKind::Core, _) => ("core", error.reason),
            (CommandErrorKind::Changed, _) => ("changed", error.reason),
            (CommandErrorKind::Unarchived, _) => ("unarchived", error.reason),
        };
        Self { kind: kind.into(), status: error.status, reason, message: error.message }
    }
}

impl Response {
    pub(crate) fn ok(id: &str, value: Value) -> Self {
        Self { v: PROTOCOL, id: id.into(), ok: Some(value), plan: None, error: None }
    }

    pub(crate) fn plan(id: &str, plan: Value) -> Self {
        Self { v: PROTOCOL, id: id.into(), ok: None, plan: Some(plan), error: None }
    }

    pub(crate) fn error(id: &str, error: CommandError) -> Self {
        Self { v: PROTOCOL, id: id.into(), ok: None, plan: None, error: Some(error.into()) }
    }

    /// For the activity log: ok, plan, or the error's kind.
    pub(crate) fn outcome(&self) -> &str {
        match (&self.plan, &self.error) {
            (Some(_), _) => "plan",
            (_, Some(error)) => &error.kind,
            _ => "ok",
        }
    }
}

/// One event passed on by `watch`.
pub(crate) fn event_line(event: &str, payload: &str) -> Value {
    let payload = serde_json::from_str(payload).unwrap_or_else(|_| Value::String(payload.to_string()));
    json!({ "v": PROTOCOL, "event": event, "payload": super::redact::redacted(payload) })
}

/// The answer to `hello`: the app's version and protocol, whether the window is ready for its actions, and every
/// method there is to call.
pub(crate) fn hello(app: &tauri::AppHandle) -> Value {
    use tauri::Manager;
    json!({
        "protocol": PROTOCOL,
        "app": env!("CARGO_PKG_VERSION"),
        "windowReady": app.state::<super::bridge::BridgeState>().is_ready(),
        "methods": super::dispatch::method_list(app),
        "events": WATCHED_EVENTS,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_needs_only_its_method() {
        let request: Request = serde_json::from_str(r#"{"method":"get_core_status"}"#).unwrap();
        assert_eq!(request.method, "get_core_status");
        assert_eq!(request.args, Value::Null);
        assert!(!request.confirm);
    }

    #[test]
    fn an_answer_carries_only_what_it_has() {
        let line = serde_json::to_value(Response::ok("7", json!({ "running": true }))).unwrap();
        assert_eq!(line, json!({ "v": 1, "id": "7", "ok": { "running": true } }));
        let line = serde_json::to_value(Response::error("8", unsupported("No such command"))).unwrap();
        assert_eq!(line, json!({ "v": 1, "id": "8", "error": { "kind": "unsupported", "message": "No such command" } }));
    }

    #[test]
    fn the_cores_own_failure_keeps_its_status_and_words() {
        let error = CommandError {
            kind: CommandErrorKind::Core,
            status: Some(502),
            reason: Some("request failed".into()),
            message: "Management API error".into(),
        };
        let wire = WireError::from(error);
        assert_eq!((wire.kind.as_str(), wire.status, wire.reason.as_deref()), ("core", Some(502), Some("request failed")));
        assert_eq!(Response::error("1", unavailable("Not yet")).outcome(), "unavailable");
        assert_eq!(Response::plan("1", json!({})).outcome(), "plan");
    }

    #[test]
    fn an_event_payload_is_json_when_it_can_be() {
        assert_eq!(event_line("usage-records-updated", "\"2026-10-01\"")["payload"], json!("2026-10-01"));
        assert_eq!(event_line("x", "not json")["payload"], json!("not json"));
    }
}

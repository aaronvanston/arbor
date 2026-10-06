//! Requests the window answers. Some of what Arbor does is worked out in the webview (account limits, caps, routing,
//! Sync's plan, the alert history), and the window keeps running while it's closed, so instead of a second copy of that
//! logic the command line asks the window: the app sends `cli-request` with an id, the window does the work and hands
//! the result back with `cli_respond`. The window says which actions it answers with `cli_bridge_ready` when it loads,
//! and the bridge forgets that each time the page loads again: the hidden window reloads itself after a long while
//! closed to the tray (src/services/backgroundReload.ts), and a request then waits for the new page.

use super::dispatch::Access;
use super::protocol::unavailable;
use crate::command_error::CommandError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Emitter;
use tokio::sync::{oneshot, Notify};
use ts_rs::TS;

pub(crate) const CLI_REQUEST_EVENT: &str = "cli-request";
/// How long a request waits for the window to load, as after `arbor` has just opened Arbor.
const READY_WAIT: Duration = Duration::from_secs(30);
/// How long the window has to answer. Reading every account's limits can take a while on a slow network.
const ANSWER_WAIT: Duration = Duration::from_secs(120);

/// One argument a window action takes.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "CliWindowArg")]
pub(crate) struct WindowArg {
    pub(crate) name: String,
    pub(crate) ts_type: String,
    pub(crate) optional: bool,
}

/// An action the window answers for the command line.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CliWindowAction {
    pub(crate) name: String,
    pub(crate) access: Access,
    pub(crate) summary: String,
    pub(crate) args: Vec<WindowArg>,
}

/// Why the window couldn't do what was asked.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CliWindowError {
    pub(crate) message: String,
}

type Answer = Result<Value, CommandError>;

#[derive(Default)]
struct Bridge {
    ready: bool,
    actions: Vec<CliWindowAction>,
    pending: HashMap<String, oneshot::Sender<Answer>>,
    next_id: u64,
}

#[derive(Default)]
pub(crate) struct BridgeState {
    bridge: Mutex<Bridge>,
    loaded: Notify,
}

impl BridgeState {
    pub(crate) fn is_ready(&self) -> bool {
        self.bridge.lock().is_ok_and(|bridge| bridge.ready)
    }

    pub(crate) fn actions(&self) -> Vec<CliWindowAction> {
        self.bridge.lock().map(|bridge| bridge.actions.clone()).unwrap_or_default()
    }

    pub(crate) fn action(&self, name: &str) -> Option<CliWindowAction> {
        self.bridge.lock().ok()?.actions.iter().find(|action| action.name == name).cloned()
    }

    fn set_ready(&self, actions: Vec<CliWindowAction>) {
        if let Ok(mut bridge) = self.bridge.lock() {
            bridge.ready = true;
            bridge.actions = actions;
        }
        self.loaded.notify_waiters();
    }

    /// The page is loading again: nothing answers until the new one says it's ready, and whatever the old one was asked
    /// fails at once, so the command line can try again rather than wait out ANSWER_WAIT for an answer that won't come.
    fn page_loading(&self) {
        let pending = match self.bridge.lock() {
            Ok(mut bridge) => {
                bridge.ready = false;
                std::mem::take(&mut bridge.pending)
            }
            Err(_) => return,
        };
        for (_, sender) in pending {
            let _ = sender.send(Err(unavailable("Arbor's window reloaded before it answered. Try again.")));
        }
    }

    async fn wait_until_ready(&self, wait: Duration) -> Result<(), CommandError> {
        let deadline = Instant::now() + wait;
        loop {
            let loaded = self.loaded.notified();
            if self.is_ready() {
                return Ok(());
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if tokio::time::timeout(left, loaded).await.is_err() {
                return Err(unavailable("Arbor's window hasn't loaded yet. Try again in a moment."));
            }
        }
    }

    fn open_request(&self) -> Result<(String, oneshot::Receiver<Answer>), CommandError> {
        let mut bridge = self.bridge.lock().map_err(|_| CommandError::failed("The window bridge is unusable"))?;
        bridge.next_id += 1;
        let id = format!("cli-{}", bridge.next_id);
        let (sender, receiver) = oneshot::channel();
        bridge.pending.insert(id.clone(), sender);
        Ok((id, receiver))
    }

    fn forget(&self, id: &str) {
        if let Ok(mut bridge) = self.bridge.lock() {
            bridge.pending.remove(id);
        }
    }

    /// Hands the window's answer to the request waiting for it; false when nothing is waiting any more.
    fn settle(&self, id: &str, answer: Answer) -> bool {
        let sender = self.bridge.lock().ok().and_then(|mut bridge| bridge.pending.remove(id));
        sender.is_some_and(|sender| sender.send(answer).is_ok())
    }

    /// Asks the window to run an action and waits for its answer.
    async fn ask(&self, emit: impl FnOnce(Value) -> Result<(), String>, action: &str, args: Value, confirm: bool, answer_wait: Duration) -> Answer {
        let (id, receiver) = self.open_request()?;
        if let Err(error) = emit(json!({ "id": id, "action": action, "args": args, "confirm": confirm })) {
            self.forget(&id);
            return Err(CommandError::failed(format!("Couldn't reach Arbor's window: {error}")));
        }
        match tokio::time::timeout(answer_wait, receiver).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(unavailable("Arbor's window went away before it answered.")),
            Err(_) => {
                self.forget(&id);
                Err(unavailable("Arbor's window didn't answer in time."))
            }
        }
    }
}

/// Runs one of the window's actions.
pub(crate) async fn ask_window(app: &tauri::AppHandle, action: &str, args: Value, confirm: bool) -> Answer {
    use tauri::Manager;
    let state = app.state::<BridgeState>();
    state.wait_until_ready(READY_WAIT).await?;
    let emit = |payload: Value| app.emit(CLI_REQUEST_EVENT, payload).map_err(|error| error.to_string());
    state.ask(emit, action, args, confirm, ANSWER_WAIT).await
}

/// The main window's page has started loading (`on_page_load`), at launch or on a reload.
pub(crate) fn forget_page_on_load<R: tauri::Runtime>(webview: &tauri::Webview<R>, payload: &tauri::webview::PageLoadPayload<'_>) {
    use tauri::Manager;
    if webview.label() != "main" || payload.event() != tauri::webview::PageLoadEvent::Started {
        return;
    }
    if let Some(state) = webview.try_state::<BridgeState>() {
        state.page_loading();
    }
}

/// The window has loaded and answers these actions.
#[tauri::command]
pub(crate) fn cli_bridge_ready(state: tauri::State<'_, BridgeState>, actions: Vec<CliWindowAction>) {
    state.set_ready(actions);
}

/// The window's answer to a `cli-request`: its result, or why it failed.
#[tauri::command]
pub(crate) fn cli_respond(state: tauri::State<'_, BridgeState>, id: String, result: Option<Value>, error: Option<CliWindowError>) {
    let answer = match error {
        Some(error) => Err(CommandError::failed(error.message)),
        None => Ok(result.unwrap_or(Value::Null)),
    };
    state.settle(&id, answer);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn action(name: &str) -> CliWindowAction {
        CliWindowAction { name: name.into(), access: Access::Read, summary: "Reads".into(), args: Vec::new() }
    }

    #[tokio::test]
    async fn a_request_waits_for_the_window_and_gets_its_answer() {
        let state = Arc::new(BridgeState::default());
        let waiting = state.clone();
        let asked = tokio::spawn(async move {
            waiting.wait_until_ready(Duration::from_secs(5)).await?;
            let window = waiting.clone();
            let emit = move |payload: Value| {
                let id = payload["id"].as_str().unwrap_or_default().to_string();
                assert_eq!(payload["action"], "limits.read");
                tokio::spawn(async move { window.settle(&id, Ok(json!({ "accounts": 2 }))) });
                Ok(())
            };
            waiting.ask(emit, "limits.read", json!({}), false, Duration::from_secs(5)).await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        state.set_ready(vec![action("limits.read")]);
        assert_eq!(asked.await.unwrap().unwrap(), json!({ "accounts": 2 }));
        assert!(state.action("limits.read").is_some());
        assert!(state.action("other").is_none());
    }

    #[tokio::test]
    async fn a_window_that_never_loads_or_answers_fails_as_unavailable() {
        let state = BridgeState::default();
        let error = state.wait_until_ready(Duration::from_millis(10)).await.unwrap_err();
        assert_eq!(error.reason.as_deref(), unavailable("").reason.as_deref());
        state.set_ready(Vec::new());
        let error = state.ask(|_| Ok(()), "slow", Value::Null, false, Duration::from_millis(10)).await.unwrap_err();
        assert!(error.message.contains("didn't answer"), "{}", error.message);
        assert!(state.bridge.lock().unwrap().pending.is_empty(), "a timed-out request is forgotten");
    }

    #[tokio::test]
    async fn a_reload_fails_what_the_old_page_was_asked_and_the_next_request_waits_for_the_new_page() {
        let state = Arc::new(BridgeState::default());
        state.set_ready(vec![action("limits.read")]);
        let asking = state.clone();
        let asked = tokio::spawn(async move { asking.ask(|_| Ok(()), "limits.read", Value::Null, false, Duration::from_secs(60)).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        state.page_loading();
        let error = tokio::time::timeout(Duration::from_secs(1), asked).await.expect("answered at once").unwrap().unwrap_err();
        assert!(error.message.contains("reloaded"), "{}", error.message);
        assert_eq!(error.reason.as_deref(), unavailable("").reason.as_deref());
        assert!(!state.is_ready(), "the new page isn't ready yet");

        let waiting = state.clone();
        let next = tokio::spawn(async move { waiting.wait_until_ready(Duration::from_secs(5)).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!next.is_finished(), "a request waits for the new page");
        state.set_ready(vec![action("limits.read")]);
        assert!(next.await.unwrap().is_ok());
    }

    #[test]
    fn a_late_answer_has_nobody_to_go_to() {
        let state = BridgeState::default();
        assert!(!state.settle("cli-9", Ok(Value::Null)));
    }
}

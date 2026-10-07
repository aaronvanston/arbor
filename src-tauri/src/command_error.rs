//! What a command tells the webview when it fails, for the commands whose
//! callers act on what went wrong: the kind of failure, and when the core
//! answered, its status and its own words, beside the sentence to show. The
//! webview reads these instead of the sentence (`src/services/commandError.ts`),
//! so the sentence can change without anything reading it breaking. Commands
//! whose callers only show the failure still answer with the sentence alone.

use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CommandErrorKind {
    /// It didn't work; `message` says why.
    Failed,
    /// Someone stopped it.
    Canceled,
    /// The core answered, with a status other than success.
    Core,
    /// What it was to change isn't as Arbor last read it, so it changed nothing.
    Changed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandError {
    pub(crate) kind: CommandErrorKind,
    /// The core's HTTP status.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub(crate) status: Option<u16>,
    /// The core's own words for it, from its `error` or `message` field.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub(crate) reason: Option<String>,
    /// What to show.
    pub(crate) message: String,
}

impl CommandError {
    pub(crate) fn failed(message: impl Into<String>) -> Self {
        Self { kind: CommandErrorKind::Failed, status: None, reason: None, message: message.into() }
    }

    pub(crate) fn canceled(message: impl Into<String>) -> Self {
        Self { kind: CommandErrorKind::Canceled, ..Self::failed(message) }
    }

    pub(crate) fn changed(message: impl Into<String>) -> Self {
        Self { kind: CommandErrorKind::Changed, ..Self::failed(message) }
    }
}

/// Everything that fails with only a sentence fails plainly.
impl From<String> for CommandError {
    fn from(message: String) -> Self {
        Self::failed(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_crosses_as_its_kind_with_only_what_it_has() {
        assert_eq!(
            serde_json::to_value(CommandError::canceled("Download canceled")).unwrap(),
            serde_json::json!({ "kind": "canceled", "message": "Download canceled" })
        );
        let core = CommandError {
            kind: CommandErrorKind::Core,
            status: Some(502),
            reason: Some("request failed".into()),
            message: "Management API error (502): request failed".into(),
        };
        assert_eq!(
            serde_json::to_value(core).unwrap(),
            serde_json::json!({
                "kind": "core",
                "status": 502,
                "reason": "request failed",
                "message": "Management API error (502): request failed",
            })
        );
    }
}

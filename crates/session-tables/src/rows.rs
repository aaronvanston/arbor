//! The rows a transcript becomes. One struct is one table; a field is a column. Rows are only ever added: something
//! that arrives on a later line (a tool's result, after its call) is its own row in its own table, joined by an id.

use serde::{Deserialize, Serialize};

/// Where a row came from: the line of the transcript file, and what that line said of itself.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct At {
    /// The line's number in its file, from 0.
    pub line: u64,
    pub ts: Option<String>,
    /// For a line with no time of its own, the time of the nearest line before it that had one. It isn't a column:
    /// the row's `day` is worked out from it, so a line an agent wrote with no time still falls on a day.
    pub near: Option<String>,
    pub session_id: Option<String>,
    /// Whether this line was read before, from another file: a session kept more than once, or one that carried on
    /// from another and copied its lines.
    pub repeat: bool,
}

/// Every line of a transcript, once. `rest` is whatever the line held that no column took, as JSON, so a field this
/// crate doesn't know yet is still there to query.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Line {
    #[serde(flatten)]
    pub at: At,
    pub kind: String,
    pub subkind: Option<String>,
    pub id: Option<String>,
    pub parent_id: Option<String>,
    pub parent_session_id: Option<String>,
    pub sidechain: Option<bool>,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub model: Option<String>,
    pub agent_version: Option<String>,
    pub entrypoint: Option<String>,
    pub user_type: Option<String>,
    pub slug: Option<String>,
    pub bytes: u64,
    pub rest: Option<String>,
}

/// A prompt, a block of a reply, a block of thinking, or instructions given to the model.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Message {
    #[serde(flatten)]
    pub at: At,
    pub role: String,
    /// `prompt`, `text`, `thinking`, `redacted_thinking`, `instructions` or `compact_summary`.
    pub kind: String,
    /// Which block of the line this was, from 0.
    pub block: u32,
    pub message_id: Option<String>,
    pub request_id: Option<String>,
    pub model: Option<String>,
    pub meta: Option<bool>,
    pub chars: u64,
    pub text: Option<String>,
}

/// One call to a model. Token columns never overlap: `input` leaves out what was read from or written to the cache.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Request {
    #[serde(flatten)]
    pub at: At,
    pub message_id: Option<String>,
    pub request_id: Option<String>,
    pub turn_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub service_tier: Option<String>,
    pub speed: Option<String>,
    pub stop_reason: Option<String>,
    pub input: u64,
    pub output: u64,
    /// Part of `output` for Claude, and Codex's reasoning output.
    pub thinking: Option<u64>,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cache_write_5m: Option<u64>,
    pub cache_write_1h: Option<u64>,
    pub web_searches: Option<u64>,
    pub web_fetches: Option<u64>,
    pub cache_miss_reason: Option<String>,
    pub cache_missed_tokens: Option<u64>,
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ToolCall {
    #[serde(flatten)]
    pub at: At,
    pub tool_use_id: Option<String>,
    pub tool: String,
    pub namespace: Option<String>,
    pub mcp_server: Option<String>,
    pub mcp_tool: Option<String>,
    pub caller: Option<String>,
    pub message_id: Option<String>,
    pub request_id: Option<String>,
    pub subagent_type: Option<String>,
    pub skill: Option<String>,
    pub background: Option<bool>,
    pub timeout_ms: Option<u64>,
    pub input_chars: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ToolResult {
    #[serde(flatten)]
    pub at: At,
    pub tool_use_id: Option<String>,
    pub is_error: Option<bool>,
    pub interrupted: Option<bool>,
    pub timed_out: Option<bool>,
    pub background: Option<bool>,
    /// The output was too long to keep whole in the transcript.
    pub truncated: Option<bool>,
    pub user_modified: Option<bool>,
    pub exit_code: Option<i64>,
    pub status_code: Option<i64>,
    pub duration_ms: Option<u64>,
    pub output_chars: u64,
    pub stdout_chars: Option<u64>,
    pub stderr_chars: Option<u64>,
    pub lines_added: Option<u64>,
    pub lines_removed: Option<u64>,
}

/// What went into a tool and what came out, kept apart from the two tables above so they stay narrow.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ToolIo {
    #[serde(flatten)]
    pub at: At,
    pub tool_use_id: Option<String>,
    /// `input` or `output`.
    pub part: String,
    pub text: String,
}

/// A shell command an agent ran. What it ran is worked out from the command's text once, here, so questions about
/// programs never have to read that text again.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Command {
    #[serde(flatten)]
    pub at: At,
    pub tool_use_id: Option<String>,
    pub cwd: Option<String>,
    pub command_chars: u64,
    pub command: Option<String>,
    pub program: Option<String>,
    pub programs: Vec<String>,
    pub pipes_to_head_tail: bool,
    pub uses_grep: bool,
    pub uses_rg: bool,
    pub inline_script: bool,
    pub script_language: Option<String>,
    pub exit_code: Option<i64>,
    pub duration_ms: Option<u64>,
    pub output_chars: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Hook {
    #[serde(flatten)]
    pub at: At,
    pub event: Option<String>,
    pub name: Option<String>,
    pub tool_use_id: Option<String>,
    pub duration_ms: Option<u64>,
    pub exit_code: Option<i64>,
    pub stdout_chars: u64,
    pub stderr_chars: u64,
    pub command: Option<String>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
}

/// A system prompt, by the hash of its text. The same prompt opens thousands of sessions, so whoever stores these
/// keeps one row per hash.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Prompt {
    pub hash: String,
    pub chars: u64,
    pub text: Option<String>,
}

/// A tool as it was described to the model, by the hash of its name, description and schema.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ToolDef {
    pub hash: String,
    pub name: String,
    pub chars: u64,
    pub description: Option<String>,
    pub schema: Option<String>,
}

/// The prompt and tools a session was given at this line.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ContextUse {
    #[serde(flatten)]
    pub at: At,
    pub prompt_hash: Option<String>,
    pub tool_hashes: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct FileTouched {
    #[serde(flatten)]
    pub at: At,
    pub tool_use_id: Option<String>,
    pub path: String,
    pub ext: Option<String>,
    pub language: Option<String>,
    /// `read`, `edit`, `write`, `add`, `delete` or `search`.
    pub op: String,
    pub lines_added: Option<u64>,
    pub lines_removed: Option<u64>,
}

/// What a run of lines became, a list per table.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Rows {
    pub lines: Vec<Line>,
    pub messages: Vec<Message>,
    pub requests: Vec<Request>,
    pub tool_calls: Vec<ToolCall>,
    pub tool_results: Vec<ToolResult>,
    pub tool_io: Vec<ToolIo>,
    pub commands: Vec<Command>,
    pub hooks: Vec<Hook>,
    pub prompts: Vec<Prompt>,
    pub tool_defs: Vec<ToolDef>,
    pub context_use: Vec<ContextUse>,
    pub files_touched: Vec<FileTouched>,
}

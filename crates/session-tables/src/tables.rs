//! The tables rows go into, column by column. This list is the format: whatever reads the tables, in whatever engine,
//! reads these names and types. A test holds it to the row structs, so neither moves without the other.

/// What a column holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    /// A whole number that is never below zero: a count, a size, a length of time.
    Count,
    /// A whole number that can be below zero, like an exit code.
    Number,
    Flag,
    /// A list of texts.
    Texts,
    /// A moment, with its time zone.
    Time,
    /// A calendar day in UTC, worked out from the row's time.
    Day,
}

pub struct Table {
    pub name: &'static str,
    /// Whether rows say where they came from. A table of distinct things (a prompt, by its hash) doesn't: the same
    /// one comes from many files, and is kept once.
    pub placed: bool,
    own: &'static [(&'static str, Kind)],
}

/// The columns every placed row starts with. `source` is the file a row was read from, as whoever read it names it.
const PLACE: [(&str, Kind); 7] =
    [("agent", Kind::Text), ("machine", Kind::Text), ("source", Kind::Text), ("line", Kind::Count), ("ts", Kind::Time), ("day", Kind::Day), ("session_id", Kind::Text)];

impl Table {
    /// Every column, in the order the table has them.
    pub fn columns(&self) -> Vec<(&'static str, Kind)> {
        let place: &[(&str, Kind)] = if self.placed { &PLACE } else { &[] };
        place.iter().chain(self.own).copied().collect()
    }
}

pub fn table(name: &str) -> Option<&'static Table> {
    TABLES.iter().find(|table| table.name == name)
}

use Kind::{Count, Flag, Number, Text, Texts};

pub const TABLES: [Table; 12] = [
    Table {
        name: "lines",
        placed: true,
        own: &[
            ("kind", Text),
            ("subkind", Text),
            ("id", Text),
            ("parent_id", Text),
            ("parent_session_id", Text),
            ("sidechain", Flag),
            ("cwd", Text),
            ("branch", Text),
            ("model", Text),
            ("agent_version", Text),
            ("entrypoint", Text),
            ("user_type", Text),
            ("slug", Text),
            ("bytes", Count),
            ("rest", Text),
        ],
    },
    Table {
        name: "messages",
        placed: true,
        own: &[
            ("role", Text),
            ("kind", Text),
            ("block", Count),
            ("message_id", Text),
            ("request_id", Text),
            ("model", Text),
            ("meta", Flag),
            ("chars", Count),
            ("text", Text),
        ],
    },
    Table {
        name: "requests",
        placed: true,
        own: &[
            ("message_id", Text),
            ("request_id", Text),
            ("turn_id", Text),
            ("model", Text),
            ("effort", Text),
            ("service_tier", Text),
            ("speed", Text),
            ("stop_reason", Text),
            ("input", Count),
            ("output", Count),
            ("thinking", Count),
            ("cache_read", Count),
            ("cache_write", Count),
            ("cache_write_5m", Count),
            ("cache_write_1h", Count),
            ("web_searches", Count),
            ("web_fetches", Count),
            ("cache_miss_reason", Text),
            ("cache_missed_tokens", Count),
            ("context_window", Count),
        ],
    },
    Table {
        name: "tool_calls",
        placed: true,
        own: &[
            ("tool_use_id", Text),
            ("tool", Text),
            ("namespace", Text),
            ("mcp_server", Text),
            ("mcp_tool", Text),
            ("caller", Text),
            ("message_id", Text),
            ("request_id", Text),
            ("subagent_type", Text),
            ("skill", Text),
            ("background", Flag),
            ("timeout_ms", Count),
            ("input_chars", Count),
        ],
    },
    Table {
        name: "tool_results",
        placed: true,
        own: &[
            ("tool_use_id", Text),
            ("is_error", Flag),
            ("interrupted", Flag),
            ("timed_out", Flag),
            ("background", Flag),
            ("truncated", Flag),
            ("user_modified", Flag),
            ("exit_code", Number),
            ("status_code", Number),
            ("duration_ms", Count),
            ("output_chars", Count),
            ("stdout_chars", Count),
            ("stderr_chars", Count),
            ("lines_added", Count),
            ("lines_removed", Count),
        ],
    },
    Table { name: "tool_io", placed: true, own: &[("tool_use_id", Text), ("part", Text), ("text", Text)] },
    Table {
        name: "commands",
        placed: true,
        own: &[
            ("tool_use_id", Text),
            ("cwd", Text),
            ("command_chars", Count),
            ("command", Text),
            ("program", Text),
            ("programs", Texts),
            ("pipes_to_head_tail", Flag),
            ("uses_grep", Flag),
            ("uses_rg", Flag),
            ("inline_script", Flag),
            ("script_language", Text),
            ("exit_code", Number),
            ("duration_ms", Count),
            ("output_chars", Count),
        ],
    },
    Table {
        name: "hooks",
        placed: true,
        own: &[
            ("event", Text),
            ("name", Text),
            ("tool_use_id", Text),
            ("duration_ms", Count),
            ("exit_code", Number),
            ("stdout_chars", Count),
            ("stderr_chars", Count),
            ("command", Text),
            ("stdout", Text),
            ("stderr", Text),
        ],
    },
    Table { name: "prompts", placed: false, own: &[("hash", Text), ("chars", Count), ("text", Text)] },
    Table { name: "tool_defs", placed: false, own: &[("hash", Text), ("name", Text), ("chars", Count), ("description", Text), ("schema", Text)] },
    Table { name: "context_use", placed: true, own: &[("prompt_hash", Text), ("tool_hashes", Texts)] },
    Table {
        name: "files_touched",
        placed: true,
        own: &[
            ("tool_use_id", Text),
            ("path", Text),
            ("ext", Text),
            ("language", Text),
            ("op", Text),
            ("lines_added", Count),
            ("lines_removed", Count),
        ],
    },
];

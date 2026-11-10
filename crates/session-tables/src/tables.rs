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
/// `day` is the day of `ts`, or for a line with no time, of the nearest line before it that had one. `repeat` is
/// whether the row's line was read before, from another file.
const PLACE: [(&str, Kind); 8] = [
    ("agent", Kind::Text),
    ("machine", Kind::Text),
    ("source", Kind::Text),
    ("line", Kind::Count),
    ("ts", Kind::Time),
    ("day", Kind::Day),
    ("session_id", Kind::Text),
    (REPEAT, Kind::Flag),
];
pub(crate) const REPEAT: &str = "repeat";

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

/// Something a query can name: a table as it's read, or a view worked out from tables.
pub struct Shown {
    pub name: &'static str,
    pub columns: Vec<(&'static str, Kind)>,
}

/// Everything a query can name, with its columns. A table is read without its repeats, so it has no `repeat`
/// column; the same name with `_all` after it (`lines_all`) has the repeats too, and the column that marks them.
pub fn shown() -> Vec<Shown> {
    let tables = TABLES.iter().map(|table| Shown { name: table.name, columns: table.columns().into_iter().filter(|(name, _)| *name != REPEAT).collect() });
    tables.chain(VIEWS.iter().map(|view| Shown { name: view.name, columns: view.columns.to_vec() })).collect()
}

use Kind::{Count, Day, Flag, Number, Text, Texts, Time};

/// Rows worked out from the tables when they're asked for, and kept nowhere.
pub(crate) struct View {
    pub(crate) name: &'static str,
    pub(crate) columns: &'static [(&'static str, Kind)],
    /// What it selects, over the tables as they're read.
    pub(crate) sql: &'static str,
}

/// How each tool call ended, once per call: the earliest result with its id.
pub(crate) const RESULTS: &str = "(SELECT agent, tool_use_id, min(ts) AS ts, bool_or(is_error) AS is_error, max(exit_code) AS exit_code, bool_or(interrupted) AS interrupted, bool_or(timed_out) AS timed_out, max(duration_ms) AS duration_ms, max(output_chars) AS output_chars FROM \"tool_results\" WHERE tool_use_id IS NOT NULL GROUP BY agent, tool_use_id)";

pub(crate) const VIEWS: [View; 2] = [
    // A tool call with how it ended. `elapsed_ms` is from the call's line to its result's, so it counts a wait for
    // the person's leave as well as the run; `duration_ms` is the run alone, where the agent wrote it down.
    View {
        name: "tools",
        columns: &[
            ("agent", Text),
            ("machine", Text),
            ("source", Text),
            ("line", Count),
            ("ts", Time),
            ("day", Day),
            ("session_id", Text),
            ("tool_use_id", Text),
            ("tool", Text),
            ("namespace", Text),
            ("mcp_server", Text),
            ("mcp_tool", Text),
            ("subagent_type", Text),
            ("skill", Text),
            ("input_chars", Count),
            ("ended", Time),
            ("is_error", Flag),
            ("exit_code", Number),
            ("interrupted", Flag),
            ("timed_out", Flag),
            ("duration_ms", Count),
            ("elapsed_ms", Count),
            ("output_chars", Count),
        ],
        sql: "SELECT c.agent, c.machine, c.source, c.line, c.ts, c.day, c.session_id, c.tool_use_id, c.tool, c.namespace, c.mcp_server, c.mcp_tool, c.subagent_type, c.skill, c.input_chars, r.ts AS ended, r.is_error, r.exit_code, r.interrupted, r.timed_out, r.duration_ms, CASE WHEN r.ts >= c.ts THEN date_diff('millisecond', c.ts, r.ts) END AS elapsed_ms, r.output_chars FROM \"tool_calls\" c LEFT JOIN {results} r ON r.agent = c.agent AND r.tool_use_id = c.tool_use_id",
    },
    // A session, once, however many files it's in.
    View {
        name: "sessions",
        columns: &[
            ("agent", Text),
            ("session_id", Text),
            ("machine", Text),
            ("started", Time),
            ("ended", Time),
            ("day", Day),
            ("cwd", Text),
            ("branch", Text),
            ("parent_session_id", Text),
            ("agent_version", Text),
            ("model", Text),
            ("lines", Count),
            ("prompts", Count),
            ("requests", Count),
            ("input", Count),
            ("output", Count),
            ("cache_read", Count),
            ("cache_write", Count),
            ("tool_calls", Count),
            ("tool_errors", Count),
        ],
        sql: "SELECT l.agent, l.session_id, l.machine, l.started, l.ended, CAST(l.started AT TIME ZONE 'UTC' AS DATE) AS day, l.cwd, l.branch, l.parent_session_id, l.agent_version, r.model, l.lines, coalesce(m.prompts, 0) AS prompts, coalesce(r.requests, 0) AS requests, coalesce(r.input, 0) AS input, coalesce(r.output, 0) AS output, coalesce(r.cache_read, 0) AS cache_read, coalesce(r.cache_write, 0) AS cache_write, coalesce(t.tool_calls, 0) AS tool_calls, coalesce(t.tool_errors, 0) AS tool_errors \
              FROM (SELECT agent, session_id, any_value(machine) AS machine, min(ts) AS started, max(ts) AS ended, arg_min(cwd, line) AS cwd, arg_max(branch, line) AS branch, any_value(parent_session_id) AS parent_session_id, arg_max(agent_version, line) AS agent_version, count(*) AS lines FROM \"lines\" WHERE session_id IS NOT NULL GROUP BY agent, session_id) l \
              LEFT JOIN (SELECT agent, session_id, mode(model) AS model, count(*) AS requests, CAST(sum(input) AS BIGINT) AS input, CAST(sum(output) AS BIGINT) AS output, CAST(sum(cache_read) AS BIGINT) AS cache_read, CAST(sum(cache_write) AS BIGINT) AS cache_write FROM \"requests\" GROUP BY agent, session_id) r ON r.agent = l.agent AND r.session_id = l.session_id \
              LEFT JOIN (SELECT agent, session_id, count(*) AS prompts FROM \"messages\" WHERE kind = 'prompt' AND meta IS NOT TRUE GROUP BY agent, session_id) m ON m.agent = l.agent AND m.session_id = l.session_id \
              LEFT JOIN (SELECT agent, session_id, count(*) AS tool_calls, count(*) FILTER (WHERE is_error) AS tool_errors FROM \"tools\" GROUP BY agent, session_id) t ON t.agent = l.agent AND t.session_id = l.session_id",
    },
];

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

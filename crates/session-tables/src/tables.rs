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
    /// A number with a fraction, like a cost.
    Real,
}

/// How a table's rows come and are kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// Rows read from a transcript's lines. Each says where it came from, and is kept by month.
    Lines,
    /// Distinct things (a prompt, by its hash): the same one comes from many files, and is kept once.
    Things,
    /// Rows with a time of their own that come from somewhere other than a transcript, kept by month.
    Dated,
}

pub struct Table {
    pub name: &'static str,
    pub shape: Shape,
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
    /// Whether rows say where they came from: the columns of [`PLACE`].
    pub fn placed(&self) -> bool {
        self.shape == Shape::Lines
    }

    /// Every column, in the order the table has them.
    pub fn columns(&self) -> Vec<(&'static str, Kind)> {
        let place: &[(&str, Kind)] = if self.placed() { &PLACE } else { &[] };
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

use Kind::{Count, Day, Flag, Number, Real, Text, Texts, Time};

/// Rows worked out from the tables when they're asked for, and kept nowhere.
pub(crate) struct View {
    pub(crate) name: &'static str,
    pub(crate) columns: &'static [(&'static str, Kind)],
    /// What it selects, over the tables as they're read.
    pub(crate) sql: &'static str,
}

/// How each tool call ended, once per call: the earliest result with its id.
pub(crate) const RESULTS: &str = "(SELECT agent, tool_use_id, min(ts) AS ts, bool_or(is_error) AS is_error, max(exit_code) AS exit_code, bool_or(interrupted) AS interrupted, bool_or(background) AS background, bool_or(timed_out) AS timed_out, max(duration_ms) AS duration_ms, max(output_chars) AS output_chars FROM \"tool_results\" WHERE tool_use_id IS NOT NULL GROUP BY agent, tool_use_id)";

/// A call's exit code, from its result `r` and whether the call asked to run in the background, `{asked}`. A
/// subagent's transcript holds a Claude command's result without the run's own account of itself, so nothing there
/// says exit code 0. Claude Code marks a command that exited with anything else as an error, so one that isn't an
/// error, wasn't interrupted and wasn't sent to the background exited with 0.
pub(crate) const EXIT_CODE: &str = "coalesce(r.exit_code, CASE WHEN c.agent = 'claude' AND {bash} AND r.is_error = false AND r.interrupted IS NOT TRUE AND r.background IS NOT TRUE AND {asked} IS NOT TRUE THEN 0 END)";

pub(crate) const VIEWS: [View; 3] = [
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
        sql: "SELECT c.agent, c.machine, c.source, c.line, c.ts, c.day, c.session_id, c.tool_use_id, c.tool, c.namespace, c.mcp_server, c.mcp_tool, c.subagent_type, c.skill, c.input_chars, r.ts AS ended, r.is_error, {exit_code} AS exit_code, r.interrupted, r.timed_out, r.duration_ms, CASE WHEN r.ts >= c.ts THEN date_diff('millisecond', c.ts, r.ts) END AS elapsed_ms, r.output_chars FROM \"tool_calls\" c LEFT JOIN {results} r ON r.agent = c.agent AND r.tool_use_id = c.tool_use_id",
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
            ("proxy_requests", Count),
            ("cost", Real),
        ],
        sql: "SELECT l.agent, l.session_id, l.machine, l.started, l.ended, CAST(l.started AT TIME ZONE 'UTC' AS DATE) AS day, l.cwd, l.branch, l.parent_session_id, l.agent_version, r.model, l.lines, coalesce(m.prompts, 0) AS prompts, coalesce(r.requests, 0) AS requests, coalesce(r.input, 0) AS input, coalesce(r.output, 0) AS output, coalesce(r.cache_read, 0) AS cache_read, coalesce(r.cache_write, 0) AS cache_write, coalesce(t.tool_calls, 0) AS tool_calls, coalesce(t.tool_errors, 0) AS tool_errors, coalesce(p.proxy_requests, 0) AS proxy_requests, p.cost \
              FROM (SELECT agent, session_id, any_value(machine) AS machine, min(ts) AS started, max(ts) AS ended, arg_min(cwd, line) AS cwd, arg_max(branch, line) AS branch, any_value(parent_session_id) AS parent_session_id, arg_max(agent_version, line) AS agent_version, count(*) AS lines FROM \"lines\" WHERE session_id IS NOT NULL GROUP BY agent, session_id) l \
              LEFT JOIN (SELECT agent, session_id, mode(model) AS model, count(*) AS requests, CAST(sum(input) AS BIGINT) AS input, CAST(sum(output) AS BIGINT) AS output, CAST(sum(cache_read) AS BIGINT) AS cache_read, CAST(sum(cache_write) AS BIGINT) AS cache_write FROM \"requests\" GROUP BY agent, session_id) r ON r.agent = l.agent AND r.session_id = l.session_id \
              LEFT JOIN (SELECT agent, session_id, count(*) AS prompts FROM \"messages\" WHERE kind = 'prompt' AND meta IS NOT TRUE GROUP BY agent, session_id) m ON m.agent = l.agent AND m.session_id = l.session_id \
              LEFT JOIN (SELECT agent, session_id, count(*) AS tool_calls, count(*) FILTER (WHERE is_error) AS tool_errors FROM \"tools\" GROUP BY agent, session_id) t ON t.agent = l.agent AND t.session_id = l.session_id \
              LEFT JOIN (SELECT session_id, count(*) AS proxy_requests, sum(cost) AS cost FROM \"proxy_requests\" WHERE session_id IS NOT NULL GROUP BY session_id) p ON p.session_id = l.session_id",
    },
    // How fast each model wrote: a request's output tokens over the time from its first token to its last.
    View {
        name: "speed",
        columns: &[
            ("ts", Time),
            ("day", Day),
            ("session_id", Text),
            ("provider", Text),
            ("account", Text),
            ("model", Text),
            ("alias", Text),
            ("effort", Text),
            ("service_tier", Text),
            ("output", Count),
            ("ttft_ms", Count),
            ("generation_ms", Count),
            ("tokens_per_second", Real),
        ],
        sql: "SELECT ts, day, session_id, provider, account, model, alias, effort, service_tier, output, ttft_ms, latency_ms - ttft_ms AS generation_ms, output * 1000.0 / (latency_ms - ttft_ms) AS tokens_per_second FROM \"proxy_requests\" WHERE NOT failed AND NOT canceled AND output > 0 AND ttft_ms IS NOT NULL AND latency_ms > ttft_ms",
    },
];

pub const TABLES: [Table; 13] = [
    Table {
        name: "lines",
        shape: Shape::Lines,
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
        shape: Shape::Lines,
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
        shape: Shape::Lines,
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
        shape: Shape::Lines,
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
        shape: Shape::Lines,
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
    Table { name: "tool_io", shape: Shape::Lines, own: &[("tool_use_id", Text), ("part", Text), ("text", Text)] },
    Table {
        name: "commands",
        shape: Shape::Lines,
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
        shape: Shape::Lines,
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
    Table { name: "prompts", shape: Shape::Things, own: &[("hash", Text), ("chars", Count), ("text", Text)] },
    Table { name: "tool_defs", shape: Shape::Things, own: &[("hash", Text), ("name", Text), ("chars", Count), ("description", Text), ("schema", Text)] },
    Table { name: "context_use", shape: Shape::Lines, own: &[("prompt_hash", Text), ("tool_hashes", Texts)] },
    Table {
        name: "files_touched",
        shape: Shape::Lines,
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
    // A request as a proxy in front of the agents saw it. `input` leaves out what was read from and written to the
    // cache, as `requests` does. `account` is the proxy's own index for the sign-in that served it, never its name.
    Table {
        name: "proxy_requests",
        shape: Shape::Dated,
        own: &[
            ("id", Count),
            ("ts", Time),
            ("day", Day),
            ("session_id", Text),
            ("parent_session_id", Text),
            ("request_id", Text),
            ("provider", Text),
            ("account", Text),
            ("model", Text),
            ("response_model", Text),
            ("alias", Text),
            ("effort", Text),
            ("service_tier", Text),
            ("endpoint", Text),
            ("kind", Text),
            ("failed", Flag),
            ("canceled", Flag),
            ("status", Number),
            ("fork", Flag),
            ("compaction", Flag),
            ("latency_ms", Count),
            ("ttft_ms", Count),
            ("input", Count),
            ("output", Count),
            ("thinking", Count),
            ("cache_read", Count),
            ("cache_write", Count),
            ("cost", Real),
        ],
    },
];

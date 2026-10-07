//! T3 Code's threads, for the live fleet board: which are asking for approval or an
//! answer, working, failed or done, read from T3 Code's own database on each machine
//! that has one.
//!
//! Only the columns in `COLUMNS` are ever named in SQL, and nothing is selected with a
//! star. A thread's title is read only while Settings › Harnesses' Thread names is on
//! (`set_t3_thread_titles`), and is only held in memory for the board. Its branch (T3
//! Code names branches from the first message), errors, payloads, messages, activities,
//! plans, diffs and auth rows are never read,
//! and neither are T3 Code's settings, tokens, secrets or logs. The resume cursor gives
//! up one id, picked out by `json_extract` inside SQLite along the one path its
//! provider uses. `server-runtime.json` gives up its pid and start time.
//!
//! This Mac's databases are looked at every few seconds with rusqlite: read-only and
//! query-only, one transaction, closed straight away so T3 Code's checkpoints never
//! wait on Arbor. A database whose files haven't changed isn't queried. Other machines
//! where the agents check found `~/.t3` are asked every 30 seconds, over the health
//! samples' shell or SSH, where sqlite3 prints fixed tags and JSON-quoted values.
//!
//! Nothing is read until the webview turns it on with `set_t3_threads_enabled`.

use super::*;
use ts_rs::TS;
use rusqlite::OpenFlags;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};

/// How often this Mac's T3 Code databases are looked at.
const LOCAL_TICK: Duration = Duration::from_secs(5);
/// A database whose files haven't changed is read again this often anyway, so threads leave the window on time.
const LOCAL_REREAD_MS: i64 = 5 * 60_000;
/// How often another machine is asked, and how long it gets to answer.
const REMOTE_INTERVAL_MS: i64 = 30_000;
const REMOTE_TIMEOUT: Duration = Duration::from_secs(8);
/// A machine's clock offset that moves by less than this between looks is kept, so its times don't jitter.
const OFFSET_JITTER_MS: i64 = 2_000;
/// How long a read waits on T3 Code's writer.
const BUSY_TIMEOUT: Duration = Duration::from_secs(1);
/// T3 Code writes its start time just after its process starts: a process that started later is another one.
const START_SLACK_MS: i64 = 5_000;
/// How often a live server's process is checked again for being the one that wrote the runtime file.
const START_RECHECK_MS: i64 = 60_000;
/// The most threads read from one database, the most recently updated first.
const THREAD_LIMIT: usize = 500;
const PATH_CHARS: usize = 4_096;
const RUNTIME_FILE_BYTES: u64 = 64 * 1024;

/// The migrations Arbor knows T3 Code's database through. 34 added the last column read (the snooze);
/// 54 is the newest T3 Code checked. Raising the newest means reading the migrations since, making sure
/// no column below changed, and adding a fixture test at the new number.
const OLDEST_MIGRATION: i64 = 34;
const NEWEST_MIGRATION: i64 = 54;
/// The migrations that made the tables and columns read, which must still carry these names.
const SLOTS: [(i64, &str); 6] = [
    (4, "ProviderSessionRuntime"),
    (5, "Projections"),
    (17, "ProjectionThreadsArchivedAt"),
    (23, "ProjectionThreadShellSummary"),
    (33, "ProjectionThreadsSettled"),
    (34, "ProjectionThreadsSnoozed"),
];
/// Every column Arbor names in T3 Code's tables, and the only ones. Each must be there for a database to be read.
const COLUMNS: [(&str, &str); 34] = [
    ("projection_projects", "project_id"),
    ("projection_projects", "workspace_root"),
    ("projection_projects", "deleted_at"),
    ("projection_threads", "thread_id"),
    ("projection_threads", "project_id"),
    ("projection_threads", "latest_turn_id"),
    ("projection_threads", "created_at"),
    ("projection_threads", "updated_at"),
    ("projection_threads", "deleted_at"),
    ("projection_threads", "archived_at"),
    ("projection_threads", "interaction_mode"),
    ("projection_threads", "latest_user_message_at"),
    ("projection_threads", "pending_approval_count"),
    ("projection_threads", "pending_user_input_count"),
    ("projection_threads", "has_actionable_proposed_plan"),
    ("projection_threads", "settled_override"),
    ("projection_threads", "snoozed_until"),
    ("projection_threads", "snoozed_at"),
    ("projection_thread_sessions", "thread_id"),
    ("projection_thread_sessions", "status"),
    ("projection_thread_sessions", "provider_name"),
    ("projection_thread_sessions", "updated_at"),
    ("projection_turns", "thread_id"),
    ("projection_turns", "turn_id"),
    ("projection_turns", "state"),
    ("projection_turns", "requested_at"),
    ("projection_turns", "started_at"),
    ("projection_turns", "completed_at"),
    ("projection_pending_approvals", "thread_id"),
    ("projection_pending_approvals", "status"),
    ("projection_pending_approvals", "created_at"),
    ("provider_session_runtime", "thread_id"),
    ("provider_session_runtime", "provider_name"),
    ("provider_session_runtime", "resume_cursor_json"),
];

const DATABASE_FILE: &str = "state.sqlite";
const WAL_FILE: &str = "state.sqlite-wal";
const RUNTIME_FILE: &str = "server-runtime.json";
const MACHINE_QUIET_MS: i64 = 2 * 60 * 1000;

pub(crate) const T3_THREADS_UPDATED_EVENT: &str = "t3-threads-updated";

/// Off until the webview says otherwise, so nothing is read before the setting is known.
static ENABLED: AtomicBool = AtomicBool::new(false);
/// Wakes the loop when reading is turned on.
static WAKE: Notify = Notify::const_new();

/// Off until the webview says otherwise: threads are read by ids alone.
static TITLES: AtomicBool = AtomicBool::new(false);

fn enabled() -> bool {
    ENABLED.load(Ordering::SeqCst)
}

fn titles() -> bool {
    TITLES.load(Ordering::SeqCst)
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/// Six hours ago, as T3 Code writes its times (`DateTime.formatIso`: UTC, milliseconds, a Z), so they compare as text.
/// The same window as the reporter's waits.
const SINCE: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours')";

/// The id the agent knows the session by, from the resume cursor, along the one path the row's own provider writes:
/// Codex's thread id; Claude's session UUID (`resume`, or `sessionId` in older rows), never the cursor's `threadId`,
/// which is T3 Code's own; `sessionId` for the rest. Malformed JSON never reaches `json_extract`, which would fail the
/// whole read: `CASE` stops at the first match.
const AGENT_SESSION_ID_SQL: &str = "CASE \
    WHEN r.resume_cursor_json IS NULL OR json_valid(r.resume_cursor_json) = 0 THEN NULL \
    WHEN r.provider_name = 'codex' THEN \
    CASE WHEN json_type(r.resume_cursor_json, '$.threadId') = 'text' THEN json_extract(r.resume_cursor_json, '$.threadId') END \
    WHEN r.provider_name = 'claudeAgent' THEN \
    CASE WHEN json_type(r.resume_cursor_json, '$.resume') = 'text' THEN json_extract(r.resume_cursor_json, '$.resume') \
    WHEN json_type(r.resume_cursor_json, '$.sessionId') = 'text' THEN json_extract(r.resume_cursor_json, '$.sessionId') END \
    WHEN json_type(r.resume_cursor_json, '$.sessionId') = 'text' THEN json_extract(r.resume_cursor_json, '$.sessionId') \
    END";

/// The one column read only while titles are on, which `COLUMNS` leaves out so the probe never needs it. T3 Code's
/// thread table has had it since `Projections` (migration 5), one of the slots checked.
#[cfg(test)]
const TITLE_COLUMN: (&str, &str) = ("projection_threads", "title");
/// What the data query selects in the title's place: nothing, or the title.
const NO_TITLE: &str = "NULL";
const TITLE: &str = "t.title";
/// The most of a title kept.
const TITLE_CHARS: usize = 200;

/// What the data query selects, in order, the last in the title's place. `column` names the positions.
const DATA_COLUMNS: [&str; 24] = [
    "t.thread_id",
    "t.project_id",
    "p.workspace_root",
    "s.status",
    "s.provider_name",
    "s.updated_at",
    "t.pending_approval_count",
    "t.pending_user_input_count",
    "(SELECT MIN(a.created_at) FROM projection_pending_approvals a WHERE a.thread_id = t.thread_id AND a.status = 'pending')",
    "t.interaction_mode",
    "t.has_actionable_proposed_plan",
    "tu.state",
    "tu.requested_at",
    "tu.started_at",
    "tu.completed_at",
    "t.latest_user_message_at",
    "t.settled_override",
    "t.snoozed_until",
    "t.snoozed_at",
    "t.updated_at",
    "r.provider_name",
    AGENT_SESSION_ID_SQL,
    "(SELECT MAX(a.created_at) FROM projection_pending_approvals a WHERE a.thread_id = t.thread_id AND a.status = 'pending')",
    NO_TITLE,
];

/// The data query's columns, with the title or without.
fn data_columns(titled: bool) -> Vec<&'static str> {
    let mut columns = DATA_COLUMNS.to_vec();
    if titled {
        columns[column::TITLE] = TITLE;
    }
    columns
}

mod column {
    pub(super) const THREAD_ID: usize = 0;
    pub(super) const PROJECT_ID: usize = 1;
    pub(super) const WORKSPACE_ROOT: usize = 2;
    pub(super) const SESSION_STATUS: usize = 3;
    pub(super) const SESSION_PROVIDER: usize = 4;
    pub(super) const SESSION_UPDATED_AT: usize = 5;
    pub(super) const PENDING_APPROVALS: usize = 6;
    pub(super) const PENDING_QUESTIONS: usize = 7;
    pub(super) const APPROVAL_SINCE: usize = 8;
    pub(super) const INTERACTION_MODE: usize = 9;
    pub(super) const ACTIONABLE_PLAN: usize = 10;
    pub(super) const TURN_STATE: usize = 11;
    pub(super) const TURN_REQUESTED_AT: usize = 12;
    pub(super) const TURN_STARTED_AT: usize = 13;
    pub(super) const TURN_COMPLETED_AT: usize = 14;
    pub(super) const LATEST_USER_MESSAGE_AT: usize = 15;
    pub(super) const SETTLED_OVERRIDE: usize = 16;
    pub(super) const SNOOZED_UNTIL: usize = 17;
    pub(super) const SNOOZED_AT: usize = 18;
    pub(super) const UPDATED_AT: usize = 19;
    pub(super) const RUNTIME_PROVIDER: usize = 20;
    pub(super) const AGENT_SESSION_ID: usize = 21;
    pub(super) const LATEST_APPROVAL: usize = 22;
    pub(super) const TITLE: usize = 23;
}

/// The threads worth a look: asking for something, working, with a plan waiting on a decision (T3 Code's Plan Ready
/// lasts until it's acted on or the thread is filed away), or touched in the window. The joins are T3 Code's own
/// (its latest turn, its session, active projects only). The query returns nothing unless the migrations are ones
/// Arbor knows, so a database of another shape gives up no rows even where its columns happen to line up; a missing
/// column fails it before it runs.
fn data_from() -> String {
    let slots = SLOTS
        .iter()
        .map(|(id, name)| format!("(migration_id = {id} AND name = '{name}')"))
        .collect::<Vec<_>>()
        .join(" OR ");
    format!(
        "FROM projection_threads t \
         JOIN projection_projects p ON p.project_id = t.project_id AND p.deleted_at IS NULL \
         LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id \
         LEFT JOIN projection_turns tu ON tu.thread_id = t.thread_id AND tu.turn_id = t.latest_turn_id \
         LEFT JOIN provider_session_runtime r ON r.thread_id = t.thread_id \
         WHERE t.deleted_at IS NULL AND t.archived_at IS NULL \
         AND (SELECT MAX(migration_id) FROM effect_sql_migrations) BETWEEN {OLDEST_MIGRATION} AND {NEWEST_MIGRATION} \
         AND (SELECT COUNT(*) FROM effect_sql_migrations WHERE {slots}) = {slot_count} \
         AND (t.pending_approval_count > 0 OR t.pending_user_input_count > 0 OR s.status IN ('starting', 'running') \
         OR (t.interaction_mode = 'plan' AND t.has_actionable_proposed_plan = 1 \
         AND (t.settled_override IS NULL OR t.settled_override <> 'settled')) \
         OR t.updated_at >= {SINCE} OR tu.requested_at >= {SINCE} OR tu.completed_at >= {SINCE} \
         OR s.updated_at >= {SINCE} OR t.latest_user_message_at >= {SINCE}) \
         ORDER BY t.updated_at DESC, t.thread_id \
         LIMIT {THREAD_LIMIT}",
        slot_count = SLOTS.len(),
    )
}

const NEWEST_COLUMNS: [&str; 1] = ["MAX(migration_id)"];
const NEWEST_FROM: &str = "FROM effect_sql_migrations";
const SLOT_COLUMNS: [&str; 2] = ["migration_id", "name"];
const TABLE_COLUMNS: [&str; 2] = ["m.name", "c.name"];

fn slots_from() -> String {
    let ids = SLOTS.iter().map(|(id, _)| id.to_string()).collect::<Vec<_>>().join(", ");
    format!("FROM effect_sql_migrations WHERE migration_id IN ({ids}) ORDER BY migration_id")
}

fn table_columns_from() -> String {
    let quoted = |names: Vec<&str>| {
        let mut names = names;
        names.sort_unstable();
        names.dedup();
        names.iter().map(|name| format!("'{name}'")).collect::<Vec<_>>().join(", ")
    };
    format!(
        "FROM sqlite_master m, pragma_table_info(m.name) c WHERE m.type = 'table' AND m.name IN ({}) AND c.name IN ({}) \
         ORDER BY m.name, c.name",
        quoted(COLUMNS.iter().map(|(table, _)| *table).collect()),
        quoted(COLUMNS.iter().map(|(_, column)| *column).collect()),
    )
}

fn select(columns: &[&str], from: &str) -> String {
    format!("SELECT {} {from}", columns.join(", "))
}

/// A statement whose rows come out as one line each: the tag, then each value JSON-quoted, tab-separated. Quoting
/// keeps nulls, tabs and line breaks in a value from breaking the line.
fn tagged(tag: char, columns: &[&str], from: &str) -> String {
    let fields: String = columns.iter().map(|column| format!(" || char(9) || json_quote({column})")).collect();
    format!("SELECT '{tag}'{fields} {from};")
}

/// The statements this Mac runs: the migrations, the slots, the columns, then the threads, without their titles or
/// with them.
struct LocalSql {
    newest: String,
    slots: String,
    columns: String,
    data: String,
    data_titled: String,
}

static LOCAL_SQL: LazyLock<LocalSql> = LazyLock::new(|| LocalSql {
    newest: select(&NEWEST_COLUMNS, NEWEST_FROM),
    slots: select(&SLOT_COLUMNS, &slots_from()),
    columns: select(&TABLE_COLUMNS, &table_columns_from()),
    data: select(&data_columns(false), &data_from()),
    data_titled: select(&data_columns(true), &data_from()),
});

/// The same statements for sqlite3 on another machine, tagged, stopping at the first that fails: the probe's lines
/// are out by then, so Arbor can say why.
fn remote_sql(titled: bool) -> String {
    [
        ".bail on".to_string(),
        tagged('M', &NEWEST_COLUMNS, NEWEST_FROM),
        tagged('N', &SLOT_COLUMNS, &slots_from()),
        tagged('C', &TABLE_COLUMNS, &table_columns_from()),
        tagged('T', &data_columns(titled), &data_from()),
    ]
    .join("\n")
        + "\n"
}

// ---------------------------------------------------------------------------
// What's read
// ---------------------------------------------------------------------------

/// Where on a machine T3 Code keeps its state: the app's `~/.t3/userdata`, or `$T3CODE_HOME/userdata`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum T3ChannelKind {
    Userdata,
    Custom,
}

impl T3ChannelKind {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "userdata" => Some(Self::Userdata),
            "custom" => Some(Self::Custom),
            _ => None,
        }
    }
}

/// How a database was opened: read-only beside T3 Code's writer, or as it lies on disk, which is only done while T3 Code
/// is down and kept only when nothing touched the files during the read.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReadMode {
    #[default]
    Readonly,
    Immutable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SkipReason {
    /// The machine has no sqlite3 to read with.
    NoSqlite3,
    /// T3 Code's migrations are outside the range Arbor knows.
    MigrationRange,
    /// A migration slot or column isn't what Arbor expects.
    Schema,
    /// The database couldn't be opened or read.
    Unreadable,
}

/// Why a database wasn't read, and the newest migration it had when that's known.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Skipped {
    reason: SkipReason,
    migration: Option<i64>,
}

/// One of T3 Code's databases on a machine, as last read.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct T3Channel {
    pub(in crate::usage) machine: String,
    pub(in crate::usage) channel: T3ChannelKind,
    /// When it was last read, or found unchanged, in Arbor's clock.
    pub(in crate::usage) read_at_ms: i64,
    /// T3 Code's server is running: its runtime file names a live process that started when it says.
    pub(in crate::usage) server_running: bool,
    pub(in crate::usage) read_mode: ReadMode,
    pub(in crate::usage) skipped: Option<Skipped>,
    pub(in crate::usage) threads: Vec<T3Thread>,
}

/// A thread's latest turn.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct T3Turn {
    state: String,
    requested_at_ms: i64,
    started_at_ms: Option<i64>,
    completed_at_ms: Option<i64>,
}

/// The proxy session with the thread's agent session id, when its requests came through Arbor.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArborSession {
    pub(in crate::usage) id: String,
    pub(in crate::usage) last_active_at_ms: i64,
    /// Its own thread's last request failed, and wasn't canceled.
    pub(in crate::usage) last_request_failed: bool,
}

/// A thread, as far as the board needs it: ids, statuses, counts and times, all in Arbor's clock.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct T3Thread {
    pub(in crate::usage) thread_id: String,
    project_id: String,
    workspace_root: Option<String>,
    /// The provider T3 Code runs the thread with (`claudeAgent`, `codex`, …): the one whose cursor gave the agent
    /// session id, else the session's.
    provider: Option<String>,
    session_status: Option<String>,
    session_updated_at_ms: Option<i64>,
    pub(in crate::usage) pending_approvals: u32,
    pub(in crate::usage) pending_questions: u32,
    /// When the oldest pending approval began.
    approval_since_ms: Option<i64>,
    /// When the newest pending approval began: one asked for after a snooze wakes it, though an older one still waits.
    latest_approval_at_ms: Option<i64>,
    /// When Arbor first saw it asking a question. The real time is only in T3 Code's activities, which aren't read.
    question_seen_at_ms: Option<i64>,
    interaction_mode: String,
    has_actionable_plan: bool,
    turn: Option<T3Turn>,
    latest_user_message_at_ms: Option<i64>,
    /// Filed away in T3 Code.
    settled: bool,
    t3_snoozed_until_ms: Option<i64>,
    t3_snoozed_at_ms: Option<i64>,
    updated_at_ms: i64,
    /// Claude's session UUID or Codex's thread id, from the resume cursor.
    pub(in crate::usage) agent_session_id: Option<String>,
    pub(in crate::usage) arbor_session: Option<ArborSession>,
    /// T3 Code's title for it, only while Thread names is on.
    title: Option<String>,
}

#[cfg(test)]
impl T3Thread {
    /// A thread with only its ids, for tests of what's joined to it.
    pub(in crate::usage) fn for_test(thread_id: &str, agent_session_id: Option<&str>) -> Self {
        Self {
            thread_id: thread_id.into(),
            project_id: "project".into(),
            workspace_root: None,
            provider: None,
            session_status: None,
            session_updated_at_ms: None,
            pending_approvals: 0,
            pending_questions: 0,
            approval_since_ms: None,
            latest_approval_at_ms: None,
            question_seen_at_ms: None,
            interaction_mode: "default".into(),
            has_actionable_plan: false,
            turn: None,
            latest_user_message_at_ms: None,
            settled: false,
            t3_snoozed_until_ms: None,
            t3_snoozed_at_ms: None,
            updated_at_ms: 0,
            agent_session_id: agent_session_id.map(str::to_string),
            arbor_session: None,
            title: None,
        }
    }
}

/// T3 Code's thread and project ids: its UUIDs, or `import:<instance>:<session>` for an imported session.
fn is_t3_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
}

/// A Claude session UUID or Codex thread id, as `is_word` takes them from the reporter.
fn is_agent_session_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A status, state, mode or provider name.
fn is_word(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

/// What a project's folder looks like: an absolute path with no control characters. It's the one free-text column
/// read, so anything else (a line break, a relative path) is dropped rather than shown.
fn is_folder(value: &str) -> bool {
    value.starts_with('/') && value.chars().count() <= PATH_CHARS && !value.chars().any(char::is_control)
}

/// A title as one line: control characters and runs of spaces become one space, cut at `TITLE_CHARS`. Empty is none.
fn clean_title(value: &str) -> Option<String> {
    let line = value.split(|c: char| c.is_control() || c.is_whitespace()).filter(|word| !word.is_empty()).collect::<Vec<_>>().join(" ");
    let cut: String = line.chars().take(TITLE_CHARS).collect();
    (!cut.is_empty()).then_some(cut)
}

fn iso_ms(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value.trim()).ok().map(|time| time.timestamp_millis())
}

/// One row of the data query, in the order of `DATA_COLUMNS`. Ids that aren't ids drop the row; odd values drop
/// themselves.
fn thread_from_row(row: &[SqlValue], offset_ms: i64, titled: bool) -> Option<T3Thread> {
    if row.len() != DATA_COLUMNS.len() {
        return None;
    }
    let text = |index: usize| match row.get(index) {
        Some(SqlValue::Text(value)) => Some(value.as_str()),
        _ => None,
    };
    let number = |index: usize| match row.get(index) {
        Some(SqlValue::Integer(value)) => Some(*value),
        Some(SqlValue::Real(value)) => Some(*value as i64),
        Some(SqlValue::Text(value)) => value.trim().parse().ok(),
        _ => None,
    };
    let time = |index: usize| text(index).and_then(iso_ms).map(|ms| ms + offset_ms);
    let word = |index: usize| text(index).filter(|value| is_word(value)).map(str::to_string);
    let count = |index: usize| number(index).unwrap_or(0).clamp(0, i64::from(u32::MAX)) as u32;
    let thread_id = text(column::THREAD_ID).filter(|id| is_t3_id(id))?.to_string();
    let project_id = text(column::PROJECT_ID).filter(|id| is_t3_id(id))?.to_string();
    let updated_at_ms = time(column::UPDATED_AT)?;
    let turn = word(column::TURN_STATE).zip(time(column::TURN_REQUESTED_AT)).map(|(state, requested_at_ms)| T3Turn {
        state,
        requested_at_ms,
        started_at_ms: time(column::TURN_STARTED_AT),
        completed_at_ms: time(column::TURN_COMPLETED_AT),
    });
    Some(T3Thread {
        thread_id,
        project_id,
        workspace_root: text(column::WORKSPACE_ROOT).filter(|path| is_folder(path)).map(str::to_string),
        provider: word(column::RUNTIME_PROVIDER).or_else(|| word(column::SESSION_PROVIDER)),
        session_status: word(column::SESSION_STATUS),
        session_updated_at_ms: time(column::SESSION_UPDATED_AT),
        pending_approvals: count(column::PENDING_APPROVALS),
        pending_questions: count(column::PENDING_QUESTIONS),
        approval_since_ms: time(column::APPROVAL_SINCE),
        latest_approval_at_ms: time(column::LATEST_APPROVAL),
        question_seen_at_ms: None,
        interaction_mode: word(column::INTERACTION_MODE).unwrap_or_else(|| "default".into()),
        has_actionable_plan: number(column::ACTIONABLE_PLAN).is_some_and(|value| value != 0),
        turn,
        latest_user_message_at_ms: time(column::LATEST_USER_MESSAGE_AT),
        settled: text(column::SETTLED_OVERRIDE) == Some("settled"),
        t3_snoozed_until_ms: time(column::SNOOZED_UNTIL),
        t3_snoozed_at_ms: time(column::SNOOZED_AT),
        updated_at_ms,
        agent_session_id: text(column::AGENT_SESSION_ID).filter(|id| is_agent_session_id(id)).map(str::to_string),
        arbor_session: None,
        title: text(column::TITLE).filter(|_| titled).and_then(clean_title),
    })
}

/// What the schema probe found.
#[derive(Debug, Default, PartialEq)]
struct Probe {
    /// The migrations table was read.
    read: bool,
    newest: Option<i64>,
    slots: Vec<(i64, String)>,
    columns: HashSet<(String, String)>,
}

impl Probe {
    /// Why the database can't be read as Arbor knows it, or None when it can.
    fn skipped(&self) -> Option<Skipped> {
        if !self.read {
            return Some(Skipped { reason: SkipReason::Unreadable, migration: None });
        }
        let Some(newest) = self.newest else {
            return Some(Skipped { reason: SkipReason::Schema, migration: None });
        };
        let skip = |reason| Some(Skipped { reason, migration: Some(newest) });
        if !(OLDEST_MIGRATION..=NEWEST_MIGRATION).contains(&newest) {
            return skip(SkipReason::MigrationRange);
        }
        let slots_match = SLOTS
            .iter()
            .all(|(id, name)| self.slots.iter().any(|(slot, slot_name)| slot == id && slot_name == name));
        let columns_match = COLUMNS
            .iter()
            .all(|(table, name)| self.columns.contains(&((*table).to_string(), (*name).to_string())));
        if !slots_match || !columns_match {
            return skip(SkipReason::Schema);
        }
        None
    }
}

/// One database's read, before it's checked and turned into threads.
#[derive(Debug, PartialEq)]
struct ChannelRead {
    kind: T3ChannelKind,
    server_running: bool,
    mode: ReadMode,
    probe: Probe,
    rows: Vec<Vec<SqlValue>>,
    /// Opening or reading it failed.
    failed: bool,
}

impl ChannelRead {
    fn new(kind: T3ChannelKind) -> Self {
        Self { kind, server_running: false, mode: ReadMode::Readonly, probe: Probe::default(), rows: Vec::new(), failed: false }
    }
}

/// A read, checked: its threads when the probe passed, else why not. Threads asking a question take the time they
/// were first seen asking.
fn channel_snapshot(
    machine: &str,
    read: ChannelRead,
    read_at_ms: i64,
    offset_ms: i64,
    questions: &mut HashMap<(T3ChannelKind, String), i64>,
) -> T3Channel {
    let skipped = read
        .probe
        .skipped()
        .or_else(|| read.failed.then_some(Skipped { reason: SkipReason::Unreadable, migration: read.probe.newest }));
    let mut threads: Vec<T3Thread> = if skipped.is_none() {
        // A read that began before Thread names was turned off keeps no title.
        read.rows.iter().filter_map(|row| thread_from_row(row, offset_ms, titles())).collect()
    } else {
        Vec::new()
    };
    for thread in threads.iter_mut().filter(|thread| thread.pending_questions > 0) {
        let seen = questions.entry((read.kind, thread.thread_id.clone())).or_insert(read_at_ms);
        thread.question_seen_at_ms = Some(*seen);
    }
    T3Channel {
        machine: machine.to_string(),
        channel: read.kind,
        read_at_ms,
        server_running: read.server_running,
        read_mode: read.mode,
        skipped,
        threads,
    }
}

/// Everything but the read time.
fn same_channels(left: &[T3Channel], right: &[T3Channel]) -> bool {
    left.len() == right.len()
        && left.iter().zip(right).all(|(a, b)| {
            a.machine == b.machine
                && a.channel == b.channel
                && a.server_running == b.server_running
                && a.read_mode == b.read_mode
                && a.skipped == b.skipped
                && a.threads == b.threads
        })
}

// ---------------------------------------------------------------------------
// This Mac
// ---------------------------------------------------------------------------

/// The runtime file's two fields Arbor reads. Whatever else is in it is skipped unseen.
#[derive(Deserialize)]
struct RuntimeFile {
    pid: Option<i64>,
    #[serde(rename = "startedAt")]
    started_at: Option<String>,
}

fn read_runtime_file(path: &Path) -> Option<RuntimeFile> {
    let mut text = String::new();
    fs::File::open(path).ok()?.take(RUNTIME_FILE_BYTES).read_to_string(&mut text).ok()?;
    serde_json::from_str(&text).ok()
}

/// Only the characters of an ISO time, so nothing else from the file is kept.
fn is_iso_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 40 && value.chars().all(|c| c.is_ascii_digit() || matches!(c, 'T' | 'Z' | ':' | '.' | '+' | '-'))
}

/// Whether a process with this pid exists: 0 from `kill(pid, 0)`, or EPERM for one of another user's, as T3 Code
/// checks itself.
fn pid_alive(pid: i32) -> bool {
    if pid <= 1 {
        return false;
    }
    // Signal 0 is never delivered; it only asks whether the pid exists.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// `ps`'s elapsed time, `[[dd-]hh:]mm:ss`, in seconds.
fn etime_seconds(value: &str) -> Option<i64> {
    let value = value.trim();
    let (days, rest) = match value.split_once('-') {
        Some((days, rest)) => (days.parse::<i64>().ok()?, rest),
        None => (0, value),
    };
    let parts = rest.split(':').map(|part| part.parse::<i64>().ok()).collect::<Option<Vec<_>>>()?;
    let (hours, minutes, seconds) = match parts[..] {
        [minutes, seconds] => (0, minutes, seconds),
        [hours, minutes, seconds] => (hours, minutes, seconds),
        _ => return None,
    };
    Some(((days * 24 + hours) * 60 + minutes) * 60 + seconds)
}

/// How long ago the process started, from `ps`. None when it can't say.
fn process_elapsed_s(pid: i32) -> Option<i64> {
    let output = std::process::Command::new("ps")
        .args(["-o", "etime=", "-p", &pid.to_string()])
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    etime_seconds(&String::from_utf8_lossy(&output.stdout))
}

/// Whether T3 Code's server for a state folder is running: its runtime file names a live pid, and that process
/// started by the time the file says (a pid reused after a crash didn't). Each pid and start time is checked with
/// `ps` about once a minute.
fn local_server_running(dir: &Path, now_ms: i64, started: &mut HashMap<(i32, String), (bool, i64)>) -> bool {
    let Some(runtime) = read_runtime_file(&dir.join(RUNTIME_FILE)) else {
        return false;
    };
    let Some(pid) = runtime.pid.and_then(|pid| i32::try_from(pid).ok()).filter(|pid| *pid > 1) else {
        return false;
    };
    if !pid_alive(pid) {
        return false;
    }
    let Some((started_at, started_ms)) = runtime
        .started_at
        .filter(|value| is_iso_text(value))
        .and_then(|value| iso_ms(&value).map(|ms| (value, ms)))
    else {
        return true;
    };
    let key = (pid, started_at);
    if let Some((same, checked_at)) = started.get(&key) {
        if now_ms - checked_at < START_RECHECK_MS {
            return *same;
        }
    }
    let Some(elapsed_s) = process_elapsed_s(pid) else {
        return true;
    };
    let same = now_ms - elapsed_s * 1000 <= started_ms + START_SLACK_MS;
    started.retain(|_, (_, checked_at)| now_ms - *checked_at < 10 * START_RECHECK_MS);
    started.insert(key, (same, now_ms));
    same
}

/// A file's size and modification time.
fn stat(path: &Path) -> Option<(u64, SystemTime)> {
    let meta = fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

/// What a state folder's files looked like, and whether its server was running: a read while nothing has changed
/// finds what the last one did.
#[derive(Clone, Debug, PartialEq)]
struct FileSignature {
    database: Option<(u64, SystemTime)>,
    wal: Option<(u64, SystemTime)>,
    runtime: Option<(u64, SystemTime)>,
    server_running: bool,
}

/// What the local reads keep between ticks.
#[derive(Clone, Debug, Default)]
struct LocalWatch {
    /// Each state folder's files at its last read, and when that was.
    seen: HashMap<T3ChannelKind, (FileSignature, i64)>,
    /// Whether a pid's process started by its runtime file's start time, and when that was checked.
    started: HashMap<(i32, String), (bool, i64)>,
}

/// This Mac's state folders that could hold a database, each once.
fn local_channels(home: &Path, t3_home: Option<&str>) -> Vec<(T3ChannelKind, PathBuf)> {
    let base = home.join(".t3");
    let mut found = vec![(T3ChannelKind::Userdata, base.join("userdata"))];
    if let Some(custom) = t3_home.map(str::trim).filter(|value| !value.is_empty()) {
        let custom = if custom == "~" {
            home.to_path_buf()
        } else if let Some(rest) = custom.strip_prefix("~/") {
            home.join(rest)
        } else {
            PathBuf::from(custom)
        };
        if custom.is_absolute() {
            found.push((T3ChannelKind::Custom, custom.join("userdata")));
        }
    }
    let mut seen = HashSet::new();
    found.retain(|(_, dir)| seen.insert(fs::canonicalize(dir).unwrap_or_else(|_| dir.clone())));
    found
}

fn immutable_uri(database: &Path) -> Option<String> {
    let path = database.to_str()?;
    let escaped = path.replace('%', "%25").replace(' ', "%20").replace('?', "%3F").replace('#', "%23");
    Some(format!("file:{escaped}?immutable=1"))
}

fn query_only(connection: &Connection) -> rusqlite::Result<()> {
    connection.pragma_update(None, "query_only", 1)?;
    connection.busy_timeout(BUSY_TIMEOUT)
}

/// Read-only beside T3 Code's writer, which it never blocks.
fn open_readonly(database: &Path) -> rusqlite::Result<Connection> {
    let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    query_only(&connection)?;
    // Opening is lazy: this is where a database, or its write-ahead log, that can't be read says so.
    connection.query_row("SELECT COUNT(*) FROM sqlite_master", [], |_| Ok(()))?;
    Ok(connection)
}

/// As the file lies: exact once everything is checkpointed, and it leaves no files behind.
fn open_immutable(database: &Path) -> rusqlite::Result<Connection> {
    let uri = immutable_uri(database).ok_or_else(|| rusqlite::Error::InvalidPath(database.to_path_buf()))?;
    let connection = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    query_only(&connection)?;
    Ok(connection)
}

fn values(row: &rusqlite::Row<'_>, count: usize) -> rusqlite::Result<Vec<SqlValue>> {
    (0..count).map(|index| row.get::<_, SqlValue>(index)).collect()
}

/// The probe, then the threads when it passes, in one transaction so they come from one snapshot.
fn query_database(connection: &Connection, read: &mut ChannelRead) -> rusqlite::Result<()> {
    connection.execute_batch("BEGIN")?;
    let result = (|| {
        read.probe.newest = connection.query_row(&LOCAL_SQL.newest, [], |row| row.get::<_, Option<i64>>(0))?;
        read.probe.read = true;
        let mut statement = connection.prepare(&LOCAL_SQL.slots)?;
        let slots = statement.query_map([], |row| values(row, SLOT_COLUMNS.len()))?;
        for slot in slots {
            if let [SqlValue::Integer(id), SqlValue::Text(name)] = &slot?[..] {
                read.probe.slots.push((*id, name.clone()));
            }
        }
        let mut statement = connection.prepare(&LOCAL_SQL.columns)?;
        let columns = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        for column in columns {
            read.probe.columns.insert(column?);
        }
        if read.probe.skipped().is_none() {
            let mut statement = connection.prepare(if titles() { &LOCAL_SQL.data_titled } else { &LOCAL_SQL.data })?;
            let rows = statement.query_map([], |row| values(row, DATA_COLUMNS.len()))?;
            for row in rows {
                read.rows.push(row?);
            }
        }
        Ok(())
    })();
    let _ = connection.execute_batch("COMMIT");
    result
}

/// The files a read as the database lies depends on: the database, its write-ahead log and the runtime file.
fn read_inputs(dir: &Path) -> [Option<(u64, SystemTime)>; 3] {
    [stat(&dir.join(DATABASE_FILE)), stat(&dir.join(WAL_FILE)), stat(&dir.join(RUNTIME_FILE))]
}

/// Runs a read that takes no locks, keeping what it found only when none of its files changed meanwhile. With
/// nothing to lock against, a read that raced T3 Code starting (its migrations, a checkpoint) could follow a page
/// T3 Code was rewriting into another table's rows, whose text isn't Arbor's to see.
fn unchanged_during<T>(dir: &Path, read: impl FnOnce() -> T) -> Option<T> {
    let before = read_inputs(dir);
    let result = read();
    (read_inputs(dir) == before).then_some(result)
}

/// The database as it lies, or None when it can't be opened so or changed while it was read.
fn read_immutable(kind: T3ChannelKind, dir: &Path) -> Option<ChannelRead> {
    unchanged_during(dir, || {
        let connection = open_immutable(&dir.join(DATABASE_FILE)).ok()?;
        let mut read = ChannelRead::new(kind);
        read.mode = ReadMode::Immutable;
        read.failed = query_database(&connection, &mut read).is_err();
        Some(read)
    })
    .flatten()
}

/// Reads one state folder's database. While T3 Code's server is down and its write-ahead log is empty everything is
/// in the file, so it's read as it lies, as long as nothing touches it meanwhile. Otherwise it's read-only beside the
/// writer; when that can't open it's read as it lies only while T3 Code is down, since beside a running T3 Code only
/// a read that takes its locks is safe.
fn read_channel(kind: T3ChannelKind, dir: &Path, server_running: bool) -> ChannelRead {
    let wal_empty = fs::metadata(dir.join(WAL_FILE)).map_or(true, |meta| meta.len() == 0);
    let immutable = || {
        read_immutable(kind, dir).map(|read| ChannelRead { server_running, ..read })
    };
    if !server_running && wal_empty {
        if let Some(read) = immutable() {
            return read;
        }
    }
    let mut read = ChannelRead::new(kind);
    read.server_running = server_running;
    match open_readonly(&dir.join(DATABASE_FILE)) {
        Ok(connection) => read.failed = query_database(&connection, &mut read).is_err(),
        Err(_) => match (!server_running).then(immutable).flatten() {
            Some(read) => return read,
            None => read.failed = true,
        },
    }
    read
}

/// One state folder on this Mac, looked at: read, or None when nothing changed since its last read.
struct LocalScan {
    kind: T3ChannelKind,
    read: Option<ChannelRead>,
}

/// Looks at this Mac's state folders. `present` are the channels there's a snapshot of; the rest are read whatever
/// their files look like.
fn scan_local(watch: &mut LocalWatch, present: &[T3ChannelKind], home: &Path, t3_home: Option<&str>, now_ms: i64) -> Vec<LocalScan> {
    let mut scans = Vec::new();
    for (kind, dir) in local_channels(home, t3_home) {
        if !dir.join(DATABASE_FILE).is_file() {
            continue;
        }
        let server_running = local_server_running(&dir, now_ms, &mut watch.started);
        let signature = FileSignature {
            database: stat(&dir.join(DATABASE_FILE)),
            wal: stat(&dir.join(WAL_FILE)),
            runtime: stat(&dir.join(RUNTIME_FILE)),
            server_running,
        };
        let unchanged = present.contains(&kind)
            && watch
                .seen
                .get(&kind)
                .is_some_and(|(known, read_at)| *known == signature && now_ms - read_at < LOCAL_REREAD_MS);
        let read = if unchanged {
            None
        } else {
            watch.seen.insert(kind, (signature, now_ms));
            Some(read_channel(kind, &dir, server_running))
        };
        scans.push(LocalScan { kind, read });
    }
    watch.seen.retain(|kind, _| scans.iter().any(|scan| scan.kind == *kind));
    scans
}

/// A machine's T3 Code databases, as last read, and how reading them has gone.
#[derive(Debug, Default)]
pub(super) struct T3Log {
    channels: Vec<T3Channel>,
    /// When each thread asking a question was first seen asking.
    questions: HashMap<(T3ChannelKind, String), i64>,
    /// The machine's clock against Arbor's, as last taken up.
    offset_ms: Option<i64>,
    polling: bool,
    polled_at: Option<i64>,
    error: Option<String>,
    /// This Mac only.
    watch: LocalWatch,
}

impl T3Log {
    /// Puts in a new set of channels. Returns whether anything but the read times changed.
    fn replace(&mut self, channels: Vec<T3Channel>) -> bool {
        {
            let asking: HashSet<(T3ChannelKind, &str)> = channels
                .iter()
                .flat_map(|channel| {
                    channel
                        .threads
                        .iter()
                        .filter(|thread| thread.pending_questions > 0)
                        .map(move |thread| (channel.channel, thread.thread_id.as_str()))
                })
                .collect();
            // A database that couldn't be read this time keeps when its questions were first seen.
            let unread: HashSet<T3ChannelKind> =
                channels.iter().filter(|channel| channel.skipped.is_some()).map(|channel| channel.channel).collect();
            self.questions
                .retain(|(kind, id), _| unread.contains(kind) || asking.contains(&(*kind, id.as_str())));
        }
        let changed = !same_channels(&self.channels, &channels);
        self.channels = channels;
        changed
    }
}

fn apply_local(log: &mut T3Log, machine: &str, scans: Vec<LocalScan>, now_ms: i64) -> bool {
    let mut channels = Vec::new();
    for scan in scans {
        match scan.read {
            Some(read) => channels.push(channel_snapshot(machine, read, now_ms, 0, &mut log.questions)),
            None => {
                if let Some(known) = log.channels.iter().find(|channel| channel.channel == scan.kind) {
                    channels.push(T3Channel { read_at_ms: now_ms, ..known.clone() });
                }
            }
        }
    }
    log.replace(channels)
}

/// Where this Mac's reads are kept: under its series when the Machines page lists it, else beside the series.
#[derive(Clone, Debug, PartialEq)]
enum LocalTarget {
    Series(String),
    ThisMachine(String),
}

impl LocalTarget {
    fn machine(&self) -> &str {
        match self {
            Self::Series(machine) | Self::ThisMachine(machine) => machine,
        }
    }
}

fn local_target(inner: &Inner) -> Option<LocalTarget> {
    if let Some(series) = inner.series.values().find(|series| series.local && series.host.enabled) {
        return Some(LocalTarget::Series(series.host.machine.clone()));
    }
    this_machine_name(inner).map(LocalTarget::ThisMachine)
}

fn local_log<'a>(inner: &'a mut Inner, target: &LocalTarget) -> Option<&'a mut T3Log> {
    match target {
        LocalTarget::Series(machine) => inner.series.get_mut(machine).map(|series| &mut series.t3),
        LocalTarget::ThisMachine(_) => Some(&mut inner.local_t3),
    }
}

/// Looks at this Mac's databases, off the async threads. Returns whether any snapshot changed.
async fn read_this_machine(state: &MachineHealthState, now_ms: i64) -> bool {
    let (target, watch, present) = {
        let mut inner = state.lock();
        let Some(target) = local_target(&inner) else {
            return false;
        };
        let Some(log) = local_log(&mut inner, &target) else {
            return false;
        };
        let present: Vec<T3ChannelKind> = log.channels.iter().map(|channel| channel.channel).collect();
        (target, log.watch.clone(), present)
    };
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return false;
    };
    let t3_home = std::env::var("T3CODE_HOME").ok();
    let scanned = tauri::async_runtime::spawn_blocking(move || {
        let mut watch = watch;
        let scans = scan_local(&mut watch, &present, &home, t3_home.as_deref(), now_ms);
        (watch, scans)
    })
    .await;
    let Ok((watch, scans)) = scanned else {
        return false;
    };
    let mut inner = state.lock();
    // Turned off, or the Machines page changed which series is this Mac, while it read.
    if !enabled() || local_target(&inner).as_ref() != Some(&target) {
        return false;
    }
    let Some(log) = local_log(&mut inner, &target) else {
        return false;
    };
    log.watch = watch;
    apply_local(log, target.machine(), scans, now_ms)
}

// ---------------------------------------------------------------------------
// Other machines
// ---------------------------------------------------------------------------

// Runs with `sh` on the machine, fed on stdin like the health sample. The statements go in the heredoc between the
// two halves. Lines out, tab-separated:
//   now seconds             the machine's clock
//   X sqlite3               there's a T3 Code database but no sqlite3 to read it with, and nothing else is printed
//   D channel               a state folder with a database: userdata or custom
//   P pid alive start etime its runtime file's pid and start time (digits and ISO characters only), whether that pid
//                           is running, and how long it has been
//   R mode                  how it was read: readonly, immutable, or unreadable when no safe read could be made
//   M / N / C / T values    the probe's and the data query's rows, each value JSON-quoted
//   E status                sqlite3's exit status
// A read as the file lies is kept only when its files didn't change meanwhile; read-only is picked with a query that
// has to read the database first. Only the read that counts is printed, so no row comes out twice.
const SCRIPT_HEAD: &str = r##"set -u
export LC_ALL=C
printf 'now\t%s\n' "$(date +%s)"
tab=$(printf '\t')
# T3 Code's state folders: the app's and where T3CODE_HOME points, each once.
dirs=$({ printf '%s\tuserdata\n' "$HOME/.t3/userdata"
  if [ -n "${T3CODE_HOME:-}" ]; then printf '%s\tcustom\n' "${T3CODE_HOME%/}/userdata"; fi; } | awk -F'\t' '!seen[$1]++')
found=
while IFS=$tab read -r dir channel; do
  if [ -f "$dir/state.sqlite" ]; then found=1; fi
done <<ARBOR_DIRS
$dirs
ARBOR_DIRS
[ -n "$found" ] || exit 0
command -v sqlite3 >/dev/null 2>&1 || { printf 'X\tsqlite3\n'; exit 0; }
work=$(mktemp -d "${TMPDIR:-/tmp}/arbor-t3.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT
printf '%s\n' "$dirs" > "$work/dirs"
printf 'SELECT COUNT(*) FROM sqlite_master;\n' > "$work/ping.sql"
cat > "$work/read.sql" <<'ARBOR_T3'
"##;

const SCRIPT_TAIL: &str = r##"ARBOR_T3
# The sizes of the files a read as the database lies depends on, or - for one that isn't there.
inputs() {
  for f in "$db" "$db-wal" "$dir/server-runtime.json"; do
    if [ -f "$f" ]; then printf '%s ' "$(wc -c < "$f")"; else printf '%s ' -; fi
  done
}
# Reads the database as it lies into $work/out, read-only so a file that went missing is never made. With nothing to
# lock against, the read only counts when none of those files changed or appeared meanwhile: one that raced T3 Code
# starting could follow a page it was rewriting into another table's rows.
read_immutable() {
  before=$(inputs)
  : > "$work/mark"
  sqlite3 -batch -init /dev/null -readonly -noheader -list "$uri" < "$work/read.sql" > "$work/out" 2>/dev/null
  status=$?
  [ "$(inputs)" = "$before" ] && [ -z "$(find "$db" "$db-wal" "$dir/server-runtime.json" -newer "$work/mark" 2>/dev/null)" ]
}
while IFS=$tab read -r dir channel; do
  db="$dir/state.sqlite"
  [ -f "$db" ] || continue
  printf 'D\t%s\n' "$channel"
  pid=; started=; alive=0; etime=
  if [ -f "$dir/server-runtime.json" ]; then
    json=$(head -c 65536 "$dir/server-runtime.json" | tr -d '\n')
    pid=$(printf '%s' "$json" | sed -n 's/.*"pid":\([1-9][0-9]*\).*/\1/p')
    started=$(printf '%s' "$json" | sed -n 's/.*"startedAt":"\([0-9TZ:.+-]*\)".*/\1/p')
  fi
  if [ -n "$pid" ] && { kill -0 "$pid" 2>/dev/null || ps -p "$pid" >/dev/null 2>&1; }; then
    alive=1; etime=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
  fi
  printf 'P\t%s\t%s\t%s\t%s\n' "$pid" "$alive" "$started" "$etime"
  uri="file:$(printf '%s' "$db" | sed -e 's/%/%25/g' -e 's/ /%20/g' -e 's/?/%3F/g' -e 's/#/%23/g')?immutable=1"
  mode=; status=
  if [ "$alive" = 0 ] && [ ! -s "$db-wal" ] && read_immutable; then mode=immutable; fi
  if [ -z "$mode" ] && sqlite3 -batch -init /dev/null -readonly -noheader -cmd '.timeout 2000' "$db" < "$work/ping.sql" >/dev/null 2>&1; then
    mode=readonly
    sqlite3 -batch -init /dev/null -readonly -noheader -list -cmd '.timeout 2000' "$db" < "$work/read.sql" > "$work/out" 2>/dev/null
    status=$?
  fi
  # Beside a running T3 Code only a read that takes its locks is safe; with it down, the file as it lies will do.
  if [ -z "$mode" ] && [ "$alive" = 0 ] && read_immutable; then mode=immutable; fi
  printf 'R\t%s\n' "${mode:-unreadable}"
  if [ -n "$mode" ]; then
    cat "$work/out"
    printf 'E\t%s\n' "$status"
  fi
done < "$work/dirs"
"##;

static REMOTE_SCRIPT: LazyLock<String> = LazyLock::new(|| [SCRIPT_HEAD, &remote_sql(false), SCRIPT_TAIL].concat());
static REMOTE_SCRIPT_TITLED: LazyLock<String> = LazyLock::new(|| [SCRIPT_HEAD, &remote_sql(true), SCRIPT_TAIL].concat());

/// What the script printed about a runtime file.
#[derive(Debug, Default, PartialEq)]
struct ProcessLine {
    alive: bool,
    started_ms: Option<i64>,
    elapsed_s: Option<i64>,
}

impl ProcessLine {
    /// Running, and the process is the one that wrote the file. Both times are in the machine's clock.
    fn running(&self, now_s: i64) -> bool {
        self.alive
            && match (self.started_ms, self.elapsed_s) {
                (Some(started_ms), Some(elapsed_s)) => (now_s - elapsed_s) * 1000 <= started_ms + START_SLACK_MS,
                _ => true,
            }
    }
}

/// What the script printed.
#[derive(Debug, Default, PartialEq)]
struct RemoteRead {
    /// The machine's clock, in seconds.
    now_s: i64,
    no_sqlite3: bool,
    channels: Vec<ChannelRead>,
}

fn sql_value(value: Value) -> Option<SqlValue> {
    Some(match value {
        Value::Null => SqlValue::Null,
        Value::Number(number) => match number.as_i64() {
            Some(integer) => SqlValue::Integer(integer),
            None => SqlValue::Real(number.as_f64()?),
        },
        Value::String(text) => SqlValue::Text(text),
        _ => return None,
    })
}

fn json_values(fields: &[&str]) -> Option<Vec<SqlValue>> {
    fields.iter().map(|field| serde_json::from_str::<Value>(field).ok().and_then(sql_value)).collect()
}

/// Reads the script's lines. A line it doesn't know, or that comes before a state folder's, is dropped.
fn parse_remote(stdout: &str) -> Result<RemoteRead, String> {
    let mut read = RemoteRead::default();
    let mut channels: Vec<(ChannelRead, ProcessLine, Option<ReadMode>, Option<i32>)> = Vec::new();
    let mut current = false;
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        let Some((&tag, rest)) = fields.split_first() else {
            continue;
        };
        match (tag, rest) {
            ("now", [now]) => {
                read.now_s = now.trim().parse().map_err(|_| "The machine's clock came back unreadable".to_string())?;
            }
            ("X", ["sqlite3"]) => read.no_sqlite3 = true,
            ("D", [kind]) => {
                current = match T3ChannelKind::parse(kind) {
                    Some(kind) => {
                        channels.push((ChannelRead::new(kind), ProcessLine::default(), None, None));
                        true
                    }
                    None => false,
                };
            }
            _ if !current => {}
            ("P", [pid, alive, started, etime]) => {
                if let Some((_, process, _, _)) = channels.last_mut() {
                    let pid_ok = pid.parse::<i64>().is_ok_and(|pid| pid > 1);
                    process.alive = pid_ok && *alive == "1";
                    process.started_ms = Some(*started).filter(|value| is_iso_text(value)).and_then(iso_ms);
                    process.elapsed_s = etime_seconds(etime);
                }
            }
            ("R", [mode]) => {
                if let Some((_, _, read_mode, _)) = channels.last_mut() {
                    *read_mode = match *mode {
                        "readonly" => Some(ReadMode::Readonly),
                        "immutable" => Some(ReadMode::Immutable),
                        _ => None,
                    };
                }
            }
            ("M", [newest]) => {
                if let (Some((channel, ..)), Ok(newest)) = (channels.last_mut(), serde_json::from_str::<Value>(newest)) {
                    channel.probe.read = true;
                    channel.probe.newest = newest.as_i64();
                }
            }
            ("N", [id, name]) => {
                let slot = serde_json::from_str::<Value>(id).ok().and_then(|id| id.as_i64()).zip(
                    serde_json::from_str::<Value>(name).ok().and_then(|name| name.as_str().map(str::to_string)),
                );
                if let (Some((channel, ..)), Some(slot)) = (channels.last_mut(), slot) {
                    channel.probe.slots.push(slot);
                }
            }
            ("C", [table, name]) => {
                let text = |field: &str| serde_json::from_str::<Value>(field).ok().and_then(|value| value.as_str().map(str::to_string));
                if let (Some((channel, ..)), Some(table), Some(name)) = (channels.last_mut(), text(table), text(name)) {
                    channel.probe.columns.insert((table, name));
                }
            }
            ("T", values) if values.len() == DATA_COLUMNS.len() => {
                if let (Some((channel, ..)), Some(row)) = (channels.last_mut(), json_values(values)) {
                    channel.rows.push(row);
                }
            }
            ("E", [status]) => {
                if let Some((_, _, _, exit)) = channels.last_mut() {
                    *exit = status.trim().parse().ok();
                }
            }
            _ => {}
        }
    }
    if read.now_s == 0 {
        return Err("The machine didn't say what time it is".into());
    }
    read.channels = channels
        .into_iter()
        .map(|(mut channel, process, mode, exit)| {
            channel.server_running = process.running(read.now_s);
            channel.mode = mode.unwrap_or_default();
            channel.failed = mode.is_none() || exit != Some(0);
            channel
        })
        .collect();
    Ok(read)
}

/// Takes a look's result into a machine's log, in Arbor's clock. Returns whether anything changed.
fn apply_remote(log: &mut T3Log, machine: &str, read: RemoteRead, at_ms: i64) -> bool {
    let fresh = at_ms - read.now_s * 1000;
    let offset_ms = match log.offset_ms {
        Some(known) if (known - fresh).abs() <= OFFSET_JITTER_MS => known,
        _ => fresh,
    };
    log.offset_ms = Some(offset_ms);
    let channels = if read.no_sqlite3 {
        vec![T3Channel {
            machine: machine.to_string(),
            channel: T3ChannelKind::Userdata,
            read_at_ms: at_ms,
            server_running: false,
            read_mode: ReadMode::Readonly,
            skipped: Some(Skipped { reason: SkipReason::NoSqlite3, migration: None }),
            threads: Vec::new(),
        }]
    } else {
        read.channels
            .into_iter()
            .map(|channel| channel_snapshot(machine, channel, at_ms, offset_ms, &mut log.questions))
            .collect()
    };
    log.replace(channels)
}

/// Machines to ask now: enabled, answering their samples, with `~/.t3` as their agents check last found, and not
/// asked in the last REMOTE_INTERVAL_MS. They're marked as being asked.
fn take_remote(state: &MachineHealthState, now_ms: i64) -> Vec<Machine> {
    let mut inner = state.lock();
    inner
        .series
        .values_mut()
        .filter(|series| !series.local && series.host.enabled && !series.host.endpoint.trim().is_empty())
        .filter(|series| series.error.is_none() && series.last_ok_at.is_some() && series.agents.t3().is_some())
        .filter(|series| !series.t3.polling && series.t3.polled_at.is_none_or(|at| now_ms - at >= REMOTE_INTERVAL_MS))
        .map(|series| {
            series.t3.polling = true;
            Machine::listed(series)
        })
        .collect()
}

async fn read_remote(machine: &Machine) -> Result<RemoteRead, String> {
    let script = if titles() { &REMOTE_SCRIPT_TITLED } else { &REMOTE_SCRIPT };
    parse_remote(&run_checked(machine, MachineOp::T3Threads, script, REMOTE_TIMEOUT).await?)
}

/// Stores a look's result, unless reading was turned off or the machine pointed somewhere else meanwhile. A machine
/// that doesn't answer keeps its last snapshot, which its read time dates.
fn record_remote(state: &MachineHealthState, machine: &str, host: &MachineHost, result: Result<RemoteRead, String>, at_ms: i64) -> bool {
    let mut inner = state.lock();
    let Some(series) = inner.series.get_mut(machine) else {
        return false;
    };
    if series.host.endpoint != host.endpoint || series.host.port != host.port {
        return false;
    }
    let log = &mut series.t3;
    log.polling = false;
    log.polled_at = Some(at_ms);
    if !enabled() {
        return false;
    }
    match result {
        Ok(read) => {
            log.error = None;
            apply_remote(log, machine, read, at_ms)
        }
        Err(error) => {
            log.error = Some(error);
            false
        }
    }
}

// ---------------------------------------------------------------------------
// The loop, the switch and the snapshot
// ---------------------------------------------------------------------------

fn emit_updated(app: &tauri::AppHandle) {
    let _ = app.emit(T3_THREADS_UPDATED_EVENT, Local::now().timestamp_millis());
}

/// Reads this Mac every few seconds, and asks the other machines with T3 Code every 30, while reading is on.
pub(super) async fn poll_loop(app: tauri::AppHandle, token: CancellationToken) {
    let state = app.state::<MachineHealthState>();
    loop {
        tokio::select! {
            _ = tokio::time::sleep(LOCAL_TICK) => {},
            _ = WAKE.notified() => {},
            _ = token.cancelled() => return,
        }
        if !enabled() {
            continue;
        }
        let now_ms = Local::now().timestamp_millis();
        if read_this_machine(&state, now_ms).await {
            emit_updated(&app);
        }
        for machine in take_remote(&state, now_ms) {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let started_ms = Local::now().timestamp_millis();
                let result = read_remote(&machine).await;
                // The machine read its clock somewhere in between.
                let at_ms = (started_ms + Local::now().timestamp_millis()) / 2;
                if record_remote(&app.state::<MachineHealthState>(), machine.name(), machine.host(), result, at_ms) {
                    emit_updated(&app);
                }
            });
        }
    }
}

/// Turns reading T3 Code's threads on or off. Off drops everything read.
#[tauri::command]
pub(crate) async fn set_t3_threads_enabled(enabled: bool, state: tauri::State<'_, MachineHealthState>) -> Result<(), String> {
    let was = ENABLED.swap(enabled, Ordering::SeqCst);
    if !enabled {
        let mut inner = state.lock();
        inner.local_t3 = T3Log::default();
        for series in inner.series.values_mut() {
            series.t3 = T3Log::default();
        }
    } else if !was {
        WAKE.notify_one();
    }
    Ok(())
}

/// Turns reading T3 Code's thread titles on or off. Either way everything read so far is dropped and read again, so
/// no title outlives the switch and a fresh one shows straight away.
#[tauri::command]
pub(crate) async fn set_t3_thread_titles(enabled: bool, state: tauri::State<'_, MachineHealthState>) -> Result<(), String> {
    if TITLES.swap(enabled, Ordering::SeqCst) == enabled {
        return Ok(());
    }
    {
        let mut inner = state.lock();
        inner.local_t3 = T3Log::default();
        for series in inner.series.values_mut() {
            series.t3 = T3Log::default();
        }
    }
    WAKE.notify_one();
    Ok(())
}

/// This Mac, as the Machines page names it: the machine its transcripts and T3 Code threads are filed under.
pub(in crate::usage) fn this_machine(state: &MachineHealthState) -> String {
    let inner = state.lock();
    machine_name(&inner, local_target(&inner).as_ref())
}

fn machine_name(inner: &Inner, target: Option<&LocalTarget>) -> String {
    target
        .map(|target| target.machine().to_string())
        .or_else(|| {
            inner
                .series
                .values()
                .find(|series| series.local && series.host.enabled)
                .map(|series| series.host.machine.clone())
        })
        .or_else(|| inner.local_names.first().cloned())
        .unwrap_or_else(|| "localhost".into())
}

/// What the fleet board gets of T3 Code: whether reading is on, whether any machine has it, this Mac's name and every
/// database's last read.
pub(in crate::usage) struct T3Snapshot {
    pub(in crate::usage) enabled: bool,
    pub(in crate::usage) found: bool,
    pub(in crate::usage) this_machine: String,
    pub(in crate::usage) channels: Vec<T3Channel>,
}

pub(in crate::usage) fn snapshot(state: &MachineHealthState) -> T3Snapshot {
    let inner = state.lock();
    let enabled = enabled();
    let target = local_target(&inner);
    let this_machine = machine_name(&inner, target.as_ref());
    // A listed machine whose agents check found it, or this Mac with T3 Code's folder.
    let found = inner.series.values().any(|series| series.host.enabled && series.agents.t3().is_some())
        || std::env::var_os("T3CODE_HOME").is_some()
        || std::env::var_os("HOME").is_some_and(|home| Path::new(&home).join(".t3").is_dir());
    let mut channels = Vec::new();
    if enabled {
        for series in inner.series.values().filter(|series| series.host.enabled) {
            if series.local || series.agents.t3().is_some() {
                channels.extend(series.t3.channels.iter().cloned());
            }
        }
        if matches!(target, Some(LocalTarget::ThisMachine(_))) {
            channels.extend(inner.local_t3.channels.iter().cloned());
        }
    }
    T3Snapshot { enabled, found, this_machine, channels }
}

/// IDs of T3 threads asking for approval or input, read from the in-memory
/// snapshots only. This is deliberately separate from `snapshot`: the tray
/// badge needs counts, not the thread payload or database links.
pub(in crate::usage) fn waiting_ids(state: &MachineHealthState, now_ms: i64) -> HashSet<String> {
    let inner = state.lock();
    if !enabled() {
        return HashSet::new();
    }
    let target = local_target(&inner);
    let mut ids = HashSet::new();
    let mut add = |machine: &str, channels: &[T3Channel]| {
        for channel in channels {
            if !channel.server_running || (machine != target.as_ref().map(LocalTarget::machine).unwrap_or_default() && now_ms - channel.read_at_ms > MACHINE_QUIET_MS) {
                continue;
            }
            for thread in &channel.threads {
                if thread.pending_approvals == 0 && thread.pending_questions == 0 {
                    continue;
                }
                ids.insert(thread.agent_session_id.clone().unwrap_or_else(|| format!("t3:{machine}:{}", thread.thread_id)));
            }
        }
    };
    for series in inner.series.values().filter(|series| series.host.enabled && (series.local || series.agents.t3().is_some())) {
        add(&series.host.machine, &series.t3.channels);
    }
    if matches!(target, Some(LocalTarget::ThisMachine(_))) {
        add(target.as_ref().map(LocalTarget::machine).unwrap_or("localhost"), &inner.local_t3.channels);
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{SecondsFormat, Utc};

    const SECRET: &str = "SECRET-NEVER-LEAVES-T3";
    const CLAUDE_SESSION: &str = "a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7";
    const CLAUDE_LEGACY: &str = "b2c3d4e5-6f70-4a81-9b2c-3d4e5f6a7b8c";
    const CODEX_THREAD: &str = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
    const IMPORTED: &str = "import:claude-work:0f8b5c2e-1111-4222-8333-444455556666";

    /// T3 Code's migration manifest (Migrations.ts), by number from 1.
    const MIGRATION_NAMES: [&str; 54] = [
        "OrchestrationEvents", "OrchestrationCommandReceipts", "CheckpointDiffBlobs", "ProviderSessionRuntime",
        "Projections", "ProjectionThreadSessionRuntimeModeColumns", "ProjectionThreadMessageAttachments",
        "ProjectionThreadActivitySequence", "ProviderSessionRuntimeMode", "ProjectionThreadsRuntimeMode",
        "OrchestrationThreadCreatedRuntimeMode", "ProjectionThreadsInteractionMode", "ProjectionThreadProposedPlans",
        "ProjectionThreadProposedPlanImplementation", "ProjectionTurnsSourceProposedPlan", "CanonicalizeModelSelections",
        "ProjectionThreadsArchivedAt", "ProjectionThreadsArchivedAtIndex", "ProjectionSnapshotLookupIndexes",
        "AuthAccessManagement", "AuthSessionClientMetadata", "AuthSessionLastConnectedAt", "ProjectionThreadShellSummary",
        "BackfillProjectionThreadShellSummary", "CleanupInvalidProjectionPendingApprovals",
        "CanonicalizeModelSelectionOptions", "ProviderSessionRuntimeInstanceId", "ProjectionThreadSessionInstanceId",
        "ProjectionThreadDetailOrderingIndexes", "ProjectionThreadShellArchiveIndexes", "AuthAuthorizationScopes",
        "AuthPairingProofKeyThumbprint", "ProjectionThreadsSettled", "ProjectionThreadsSnoozed",
        "ProjectionThreadTitleRegeneration", "ProjectionThreadsPinned", "ProjectionTurnsKeysetIndex",
        "ProjectionThreadsPinOrderKey", "ProjectionProjectsDefaultThreadEnvMode", "ProjectionProjectFaviconPath",
        "AuthSessionClientConnection", "ProjectionThreadLinkedPullRequest", "ProjectionThreadsUnsettledAt",
        "ClearAutomaticProjectModelDefaults", "ProjectionProjectsAutoPull", "RepairAutomaticSettlementTimestamps",
        "ProjectionProjectIcon", "ProjectionThreadBranchPullRequest", "ProjectionThreadsActiveOrderKey",
        "ProjectionThreadPullRequests", "ProjectionThreadMessageContext", "ProjectionThreadTitleState",
        "PullRequestFilesViewed", "ProjectionThreadsAutoSettleDisabledAt",
    ];

    /// The tables and columns T3 Code's migrations leave, as 004 and 005 made them and the ALTERs since changed them.
    const SCHEMA_004_005: &str = "
        CREATE TABLE provider_session_runtime (
          thread_id TEXT PRIMARY KEY, provider_name TEXT NOT NULL, adapter_key TEXT NOT NULL,
          runtime_mode TEXT NOT NULL DEFAULT 'full-access', status TEXT NOT NULL, last_seen_at TEXT NOT NULL,
          resume_cursor_json TEXT, runtime_payload_json TEXT);
        CREATE TABLE projection_projects (
          project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL, default_model TEXT,
          scripts_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, model TEXT NOT NULL, branch TEXT,
          worktree_path TEXT, latest_turn_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
        CREATE TABLE projection_thread_messages (
          message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, role TEXT NOT NULL, text TEXT NOT NULL,
          is_streaming INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE projection_thread_activities (
          activity_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, tone TEXT NOT NULL, kind TEXT NOT NULL,
          summary TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE projection_thread_sessions (
          thread_id TEXT PRIMARY KEY, status TEXT NOT NULL, provider_name TEXT, provider_session_id TEXT,
          provider_thread_id TEXT, active_turn_id TEXT, last_error TEXT, updated_at TEXT NOT NULL);
        CREATE TABLE projection_turns (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, turn_id TEXT, pending_message_id TEXT,
          assistant_message_id TEXT, state TEXT NOT NULL, requested_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
          checkpoint_turn_count INTEGER, checkpoint_ref TEXT, checkpoint_status TEXT, checkpoint_files_json TEXT NOT NULL,
          UNIQUE (thread_id, turn_id), UNIQUE (thread_id, checkpoint_turn_count));
        CREATE TABLE projection_pending_approvals (
          request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, status TEXT NOT NULL, decision TEXT,
          created_at TEXT NOT NULL, resolved_at TEXT);
        CREATE TABLE projection_state (projector TEXT PRIMARY KEY, last_applied_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, payload_json TEXT NOT NULL);
        CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, client_label TEXT);
    ";

    const ALTERS: [(i64, &str); 32] = [
        (6, "ALTER TABLE projection_thread_sessions ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'full-access'"),
        (7, "ALTER TABLE projection_thread_messages ADD COLUMN attachments_json TEXT"),
        (8, "ALTER TABLE projection_thread_activities ADD COLUMN sequence INTEGER"),
        (10, "ALTER TABLE projection_threads ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'full-access'"),
        (12, "ALTER TABLE projection_threads ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'default'"),
        (13, "CREATE TABLE projection_thread_proposed_plans (plan_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, plan_markdown TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
        (16, "ALTER TABLE projection_projects ADD COLUMN default_model_selection_json TEXT"),
        (16, "ALTER TABLE projection_threads ADD COLUMN model_selection_json TEXT"),
        (16, "ALTER TABLE projection_projects DROP COLUMN default_model"),
        (16, "ALTER TABLE projection_threads DROP COLUMN model"),
        (17, "ALTER TABLE projection_threads ADD COLUMN archived_at TEXT"),
        (23, "ALTER TABLE projection_threads ADD COLUMN latest_user_message_at TEXT"),
        (23, "ALTER TABLE projection_threads ADD COLUMN pending_approval_count INTEGER NOT NULL DEFAULT 0"),
        (23, "ALTER TABLE projection_threads ADD COLUMN pending_user_input_count INTEGER NOT NULL DEFAULT 0"),
        (23, "ALTER TABLE projection_threads ADD COLUMN has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0"),
        (27, "ALTER TABLE provider_session_runtime ADD COLUMN provider_instance_id TEXT"),
        (28, "ALTER TABLE projection_thread_sessions ADD COLUMN provider_instance_id TEXT"),
        (33, "ALTER TABLE projection_threads ADD COLUMN settled_override TEXT"),
        (33, "ALTER TABLE projection_threads ADD COLUMN settled_at TEXT"),
        (34, "ALTER TABLE projection_threads ADD COLUMN snoozed_until TEXT"),
        (34, "ALTER TABLE projection_threads ADD COLUMN snoozed_at TEXT"),
        (35, "ALTER TABLE projection_threads ADD COLUMN title_regeneration_request_id TEXT"),
        (35, "ALTER TABLE projection_threads ADD COLUMN title_regeneration_started_at TEXT"),
        (36, "ALTER TABLE projection_threads ADD COLUMN pinned_at TEXT"),
        (38, "ALTER TABLE projection_threads ADD COLUMN pin_order_key TEXT"),
        (42, "ALTER TABLE projection_threads ADD COLUMN linked_pull_request_json TEXT"),
        (43, "ALTER TABLE projection_threads ADD COLUMN unsettled_at TEXT"),
        (48, "ALTER TABLE projection_threads ADD COLUMN branch_pull_request_json TEXT"),
        (49, "ALTER TABLE projection_threads ADD COLUMN active_order_key TEXT"),
        (51, "ALTER TABLE projection_thread_messages ADD COLUMN context_json TEXT"),
        (52, "ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT"),
        (54, "ALTER TABLE projection_threads ADD COLUMN auto_settle_disabled_at TEXT"),
    ];

    /// How a fixture database differs from what T3 Code's migrations through `migration` leave.
    struct Shape {
        migration: i64,
        slot_34: &'static str,
        without: Option<&'static str>,
    }

    fn shape(migration: i64) -> Shape {
        Shape { migration, slot_34: "ProjectionThreadsSnoozed", without: None }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("arbor-t3-{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(&dir).unwrap()
    }

    fn iso(ms: i64) -> String {
        chrono::DateTime::<Utc>::from_timestamp_millis(ms).unwrap().to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    fn now_ms() -> i64 {
        Local::now().timestamp_millis()
    }

    fn text(value: &str) -> SqlValue {
        SqlValue::Text(value.to_string())
    }

    /// Inserts the values whose columns the table has at this migration.
    fn insert(connection: &Connection, table: &str, values: &[(&str, SqlValue)]) {
        let present: HashSet<String> = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let kept: Vec<&(&str, SqlValue)> = values.iter().filter(|(name, _)| present.contains(*name)).collect();
        let names = kept.iter().map(|(name, _)| *name).collect::<Vec<_>>().join(", ");
        let marks = vec!["?"; kept.len()].join(", ");
        connection
            .execute(&format!("INSERT INTO {table} ({names}) VALUES ({marks})"), params_from_iter(kept.iter().map(|(_, value)| value)))
            .unwrap();
    }

    /// Writes T3 Code's state.sqlite in `dir` as its migrations leave it, in WAL mode with nothing checkpointed, and
    /// returns the writer, still open. Every column Arbor must never read holds the secret.
    fn state_database(dir: &Path, shape: &Shape, now: i64) -> Connection {
        fs::create_dir_all(dir).unwrap();
        let connection = Connection::open(dir.join(DATABASE_FILE)).unwrap();
        connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get::<_, String>(0)).unwrap();
        connection.execute_batch("PRAGMA wal_autocheckpoint = 0;").unwrap();
        connection
            .execute_batch(
                "CREATE TABLE effect_sql_migrations (migration_id integer PRIMARY KEY NOT NULL, \
                 created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL);",
            )
            .unwrap();
        connection.execute_batch(SCHEMA_004_005).unwrap();
        for (migration, statement) in ALTERS {
            if migration <= shape.migration && shape.without.is_none_or(|column| !statement.contains(&format!(" {column} "))) {
                connection.execute_batch(statement).unwrap();
            }
        }
        for id in 1..=shape.migration {
            let name = match id {
                34 => shape.slot_34.to_string(),
                _ => MIGRATION_NAMES.get(id as usize - 1).map_or_else(|| format!("FutureMigration{id}"), |name| name.to_string()),
            };
            connection.execute("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?1, ?2)", params![id, name]).unwrap();
        }
        seed(&connection, now);
        connection
    }

    struct Thread<'a> {
        id: &'a str,
        project: &'a str,
        provider: &'a str,
        status: &'a str,
        cursor: Option<&'a str>,
        extra: Vec<(&'a str, SqlValue)>,
        turn: Option<(&'a str, i64, Option<i64>)>,
        updated_ms: i64,
    }

    fn add_thread(connection: &Connection, thread: Thread<'_>) {
        let mut values = vec![
            ("thread_id", text(thread.id)),
            ("project_id", text(thread.project)),
            ("title", text(SECRET)),
            ("model", text(SECRET)),
            ("model_selection_json", text(&format!(r#"{{"provider":"{}","model":"{SECRET}"}}"#, thread.provider))),
            ("branch", text(&format!("t3/{SECRET}"))),
            ("worktree_path", text(&format!("/tmp/{SECRET}"))),
            ("latest_turn_id", thread.turn.map_or(SqlValue::Null, |_| text(&format!("turn-{}", thread.id)))),
            ("created_at", text(&iso(thread.updated_ms - 3_600_000))),
            ("updated_at", text(&iso(thread.updated_ms))),
            ("title_state_json", text(&format!(r#"{{"title":"{SECRET}"}}"#))),
            ("linked_pull_request_json", text(&format!(r#"{{"title":"{SECRET}"}}"#))),
            ("branch_pull_request_json", text(&format!(r#"{{"title":"{SECRET}"}}"#))),
            ("title_regeneration_request_id", text(SECRET)),
        ];
        values.extend(thread.extra);
        insert(connection, "projection_threads", &values);
        insert(
            connection,
            "projection_thread_sessions",
            &[
                ("thread_id", text(thread.id)),
                ("status", text(thread.status)),
                ("provider_name", text(thread.provider)),
                ("provider_session_id", text(SECRET)),
                ("provider_thread_id", text(SECRET)),
                ("last_error", text(&format!("{SECRET}: the model said no"))),
                ("updated_at", text(&iso(thread.updated_ms))),
            ],
        );
        if let Some(cursor) = thread.cursor {
            insert(
                connection,
                "provider_session_runtime",
                &[
                    ("thread_id", text(thread.id)),
                    ("provider_name", text(thread.provider)),
                    ("adapter_key", text(thread.provider)),
                    ("status", text("running")),
                    ("last_seen_at", text(&iso(thread.updated_ms))),
                    ("resume_cursor_json", text(cursor)),
                    ("runtime_payload_json", text(&format!(r#"{{"cwd":"/Users/{SECRET}","imported":"/{SECRET}.jsonl"}}"#))),
                ],
            );
        }
        if let Some((state, requested_ms, completed_ms)) = thread.turn {
            insert(
                connection,
                "projection_turns",
                &[
                    ("thread_id", text(thread.id)),
                    ("turn_id", text(&format!("turn-{}", thread.id))),
                    ("pending_message_id", text(SECRET)),
                    ("state", text(state)),
                    ("requested_at", text(&iso(requested_ms))),
                    ("started_at", text(&iso(requested_ms + 1_000))),
                    ("completed_at", completed_ms.map_or(SqlValue::Null, |ms| text(&iso(ms)))),
                    ("checkpoint_ref", text(SECRET)),
                    ("checkpoint_files_json", text(&format!(r#"["{SECRET}"]"#))),
                ],
            );
        }
        insert(
            connection,
            "projection_thread_messages",
            &[
                ("message_id", text(&format!("message-{}", thread.id))),
                ("thread_id", text(thread.id)),
                ("role", text("user")),
                ("text", text(&format!("Please fix {SECRET}"))),
                ("is_streaming", SqlValue::Integer(0)),
                ("created_at", text(&iso(thread.updated_ms))),
                ("updated_at", text(&iso(thread.updated_ms))),
            ],
        );
        insert(
            connection,
            "projection_thread_activities",
            &[
                ("activity_id", text(&format!("activity-{}", thread.id))),
                ("thread_id", text(thread.id)),
                ("tone", text("info")),
                ("kind", text("tool")),
                ("summary", text(SECRET)),
                ("payload_json", text(&format!(r#"{{"command":"{SECRET}"}}"#))),
                ("created_at", text(&iso(thread.updated_ms))),
            ],
        );
    }

    fn claude_cursor(thread: &str, resume: &str) -> String {
        format!(r#"{{"threadId":"{thread}","resume":"{resume}","resumeSessionAt":"{SECRET}","turnCount":2,"turnStartMessageIds":["{SECRET}",null]}}"#)
    }

    /// Threads in every state the board shows, and some it must leave out.
    fn seed(connection: &Connection, now: i64) {
        let project = |id: &str, root: &str, deleted: bool| {
            insert(
                connection,
                "projection_projects",
                &[
                    ("project_id", text(id)),
                    ("title", text(SECRET)),
                    ("workspace_root", text(root)),
                    ("default_model", text(SECRET)),
                    ("default_model_selection_json", text(&format!(r#"{{"model":"{SECRET}"}}"#))),
                    ("scripts_json", text(&format!(r#"[{{"command":"{SECRET}"}}]"#))),
                    ("created_at", text(&iso(now - 86_400_000))),
                    ("updated_at", text(&iso(now - 86_400_000))),
                    ("deleted_at", if deleted { text(&iso(now - 60_000)) } else { SqlValue::Null }),
                ],
            );
        };
        project("project-arbor", "/Users/cam/src/arbor", false);
        project("project-quoted", "/Users/cam/src/a b\"c#d%e", false);
        project("project-gone", "/Users/cam/src/gone", true);
        insert(connection, "orchestration_events", &[("event_id", text("event-1")), ("payload_json", text(&format!(r#"{{"text":"{SECRET}"}}"#)))]);
        insert(connection, "auth_sessions", &[("session_id", text("auth-1")), ("token_hash", text(SECRET)), ("client_label", text(SECRET))]);
        let minute = 60_000;
        let claude = claude_cursor("thread-approval", CLAUDE_SESSION);
        add_thread(connection, Thread {
            id: "thread-approval", project: "project-arbor", provider: "claudeAgent", status: "running", cursor: Some(&claude),
            extra: vec![("pending_approval_count", SqlValue::Integer(2)), ("latest_user_message_at", text(&iso(now - 9 * minute)))],
            turn: Some(("running", now - 9 * minute, None)), updated_ms: now - 3 * minute,
        });
        insert(connection, "projection_pending_approvals", &[
            ("request_id", text("approval-1")), ("thread_id", text("thread-approval")), ("status", text("pending")),
            ("decision", text(SECRET)), ("created_at", text(&iso(now - 3 * minute))),
        ]);
        insert(connection, "projection_pending_approvals", &[
            ("request_id", text("approval-0")), ("thread_id", text("thread-approval")), ("status", text("resolved")),
            ("created_at", text(&iso(now - 8 * minute))),
        ]);
        insert(connection, "projection_pending_approvals", &[
            ("request_id", text("approval-2")), ("thread_id", text("thread-approval")), ("status", text("pending")),
            ("created_at", text(&iso(now - minute))),
        ]);
        insert(connection, "projection_pending_approvals", &[
            ("request_id", text("approval-3")), ("thread_id", text("thread-approval")), ("status", text("resolved")),
            ("created_at", text(&iso(now - 10_000))),
        ]);
        let codex = format!(r#"{{"threadId":"{CODEX_THREAD}"}}"#);
        add_thread(connection, Thread {
            id: "thread-working", project: "project-arbor", provider: "codex", status: "running", cursor: Some(&codex),
            extra: vec![], turn: Some(("running", now - 2 * minute, None)), updated_ms: now - minute,
        });
        let legacy = format!(r#"{{"threadId":"thread-question","sessionId":"{CLAUDE_LEGACY}","resumeSessionAt":"{SECRET}"}}"#);
        add_thread(connection, Thread {
            id: "thread-question", project: "project-quoted", provider: "claudeAgent", status: "running", cursor: Some(&legacy),
            extra: vec![("pending_user_input_count", SqlValue::Integer(1))], turn: Some(("running", now - 4 * minute, None)), updated_ms: now - 2 * minute,
        });
        add_thread(connection, Thread {
            id: "thread-done", project: "project-arbor", provider: "claudeAgent", status: "ready", cursor: Some(&format!("{{not json {SECRET}")),
            extra: vec![("interaction_mode", text("plan")), ("has_actionable_proposed_plan", SqlValue::Integer(1))],
            turn: Some(("completed", now - 20 * minute, Some(now - 10 * minute))), updated_ms: now - 10 * minute,
        });
        insert(connection, "projection_thread_proposed_plans", &[
            ("plan_id", text("plan-1")), ("thread_id", text("thread-done")), ("plan_markdown", text(&format!("# {SECRET}"))),
            ("created_at", text(&iso(now - 10 * minute))), ("updated_at", text(&iso(now - 10 * minute))),
        ]);
        add_thread(connection, Thread {
            id: "thread-failed", project: "project-arbor", provider: "codex", status: "error", cursor: Some(r#"{"threadId":42}"#),
            extra: vec![], turn: Some(("error", now - 30 * minute, Some(now - 29 * minute))), updated_ms: now - 29 * minute,
        });
        add_thread(connection, Thread {
            id: "thread-cursor", project: "project-arbor", provider: "cursor", status: "ready",
            cursor: Some(r#"{"schemaVersion":1,"sessionId":"cursor-session-1"}"#), extra: vec![], turn: None, updated_ms: now - 50 * minute,
        });
        add_thread(connection, Thread {
            id: "thread-snoozed", project: "project-arbor", provider: "claudeAgent", status: "stopped", cursor: None,
            extra: vec![
                ("settled_override", text("settled")),
                ("snoozed_until", text(&iso(now + 60 * minute))),
                ("snoozed_at", text(&iso(now - minute))),
            ],
            turn: Some(("completed", now - 90 * minute, Some(now - 80 * minute))), updated_ms: now - 80 * minute,
        });
        let imported = claude_cursor(IMPORTED, "0f8b5c2e-1111-4222-8333-444455556666");
        add_thread(connection, Thread {
            id: IMPORTED, project: "project-arbor", provider: "claudeAgent", status: "stopped", cursor: Some(&imported),
            extra: vec![], turn: None, updated_ms: now - 100 * minute,
        });
        // Left out: archived, deleted, in a deleted project, idle for days, and an id that isn't one.
        let archived = vec![("archived_at", text(&iso(now - minute)))];
        add_thread(connection, Thread {
            id: "thread-archived", project: "project-arbor", provider: "codex", status: "running", cursor: None,
            extra: archived, turn: None, updated_ms: now - minute,
        });
        add_thread(connection, Thread {
            id: "thread-deleted", project: "project-arbor", provider: "codex", status: "ready", cursor: None,
            extra: vec![("deleted_at", text(&iso(now - minute)))], turn: None, updated_ms: now - minute,
        });
        add_thread(connection, Thread {
            id: "thread-orphan", project: "project-gone", provider: "codex", status: "ready", cursor: None,
            extra: vec![], turn: None, updated_ms: now - minute,
        });
        add_thread(connection, Thread {
            id: "thread-old", project: "project-arbor", provider: "codex", status: "stopped", cursor: None,
            extra: vec![], turn: Some(("completed", now - 50 * 60 * minute, Some(now - 49 * 60 * minute))), updated_ms: now - 49 * 60 * minute,
        });
        // A plan still waiting on a decision stays whatever its age, until it's filed away.
        let plan = || vec![("interaction_mode", text("plan")), ("has_actionable_proposed_plan", SqlValue::Integer(1))];
        add_thread(connection, Thread {
            id: "thread-old-plan", project: "project-arbor", provider: "codex", status: "stopped", cursor: None,
            extra: plan(), turn: Some(("completed", now - 50 * 60 * minute, Some(now - 49 * 60 * minute))), updated_ms: now - 49 * 60 * minute,
        });
        add_thread(connection, Thread {
            id: "thread-old-plan-filed", project: "project-arbor", provider: "codex", status: "stopped", cursor: None,
            extra: [plan(), vec![("settled_override", text("settled"))]].concat(),
            turn: Some(("completed", now - 50 * 60 * minute, Some(now - 49 * 60 * minute))), updated_ms: now - 49 * 60 * minute,
        });
        add_thread(connection, Thread {
            id: "not an id/../x", project: "project-arbor", provider: "codex", status: "ready", cursor: None,
            extra: vec![], turn: None, updated_ms: now - minute,
        });
    }

    /// A writer holding the database so a read that takes locks can't start (SQLITE_BUSY), with everything already
    /// checkpointed into the file.
    fn locked_out(dir: &Path) -> Connection {
        let writer = Connection::open(dir.join(DATABASE_FILE)).unwrap();
        writer.execute_batch("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;").unwrap();
        writer
    }

    fn runtime_file(dir: &Path, pid: i64, started_ms: i64) {
        fs::write(
            dir.join(RUNTIME_FILE),
            format!(
                r#"{{"version":1,"pid":{pid},"host":"{SECRET}.local","port":3773,"origin":"http://{SECRET}:3773","devUrl":"http://{SECRET}","startedAt":"{}","serviceManaged":true}}"#,
                iso(started_ms)
            ) + "\n",
        )
        .unwrap();
    }

    fn channel_dir(home: &Path) -> PathBuf {
        home.join(".t3/userdata")
    }

    /// One local look, as the loop makes it.
    fn look(log: &mut T3Log, home: &Path, now: i64) -> bool {
        let present: Vec<T3ChannelKind> = log.channels.iter().map(|channel| channel.channel).collect();
        let mut watch = log.watch.clone();
        let scans = scan_local(&mut watch, &present, home, None, now);
        log.watch = watch;
        apply_local(log, "cam-mbp", scans, now)
    }

    fn thread<'a>(channel: &'a T3Channel, id: &str) -> &'a T3Thread {
        channel.threads.iter().find(|thread| thread.thread_id == id).unwrap_or_else(|| panic!("no {id}"))
    }

    fn ids(channel: &T3Channel) -> Vec<&str> {
        let mut ids: Vec<&str> = channel.threads.iter().map(|thread| thread.thread_id.as_str()).collect();
        ids.sort_unstable();
        ids
    }

    const SHOWN: [&str; 9] = [
        IMPORTED,
        "thread-approval",
        "thread-cursor",
        "thread-done",
        "thread-failed",
        "thread-old-plan",
        "thread-question",
        "thread-snoozed",
        "thread-working",
    ];

    #[cfg(unix)]
    #[test]
    fn statuses_times_and_ids_are_read_and_nothing_else_ever_is() {
        let home = temp_dir("read");
        let dir = channel_dir(&home);
        let now = now_ms();
        let _writer = state_database(&dir, &shape(NEWEST_MIGRATION), now);
        runtime_file(&dir, i64::from(std::process::id()), now);

        let read = read_channel(T3ChannelKind::Userdata, &dir, true);
        assert!(!format!("{read:?}").contains(SECRET), "nothing that holds the secret is read");
        assert_eq!(read.mode, ReadMode::Readonly);

        let mut log = T3Log::default();
        assert!(look(&mut log, &home, now));
        let serialized = serde_json::to_string(&log.channels).unwrap();
        assert!(!serialized.contains(SECRET), "{serialized}");
        let [channel] = &log.channels[..] else { panic!("{:?}", log.channels) };
        assert_eq!((channel.machine.as_str(), channel.channel), ("cam-mbp", T3ChannelKind::Userdata));
        assert!(channel.server_running);
        assert_eq!(channel.read_mode, ReadMode::Readonly);
        assert_eq!(channel.skipped, None);
        assert_eq!(ids(channel), SHOWN);

        let approval = thread(channel, "thread-approval");
        assert_eq!(approval.pending_approvals, 2);
        assert_eq!(approval.session_status.as_deref(), Some("running"));
        assert_eq!(approval.provider.as_deref(), Some("claudeAgent"));
        assert_eq!(approval.workspace_root.as_deref(), Some("/Users/cam/src/arbor"));
        assert!(approval.approval_since_ms.is_some_and(|since| (since - (now - 3 * 60_000)).abs() < 5), "the oldest pending one");
        assert!(approval.latest_approval_at_ms.is_some_and(|at| (at - (now - 60_000)).abs() < 5), "the newest pending one");
        assert_eq!(approval.agent_session_id.as_deref(), Some(CLAUDE_SESSION), "Claude's resume id, never the cursor's threadId");
        assert!(approval.latest_user_message_at_ms.is_some());
        assert_eq!(approval.turn.as_ref().map(|turn| turn.state.as_str()), Some("running"));

        assert_eq!(thread(channel, "thread-working").agent_session_id.as_deref(), Some(CODEX_THREAD));
        let question = thread(channel, "thread-question");
        assert_eq!(question.pending_questions, 1);
        assert_eq!(question.question_seen_at_ms, Some(now), "first seen asking now");
        assert_eq!(question.agent_session_id.as_deref(), Some(CLAUDE_LEGACY), "older Claude rows keep it as sessionId");
        assert_eq!(question.workspace_root.as_deref(), Some("/Users/cam/src/a b\"c#d%e"));

        let done = thread(channel, "thread-done");
        assert_eq!(done.agent_session_id, None, "a cursor that isn't JSON gives no id, and the row still comes");
        assert_eq!((done.interaction_mode.as_str(), done.has_actionable_plan), ("plan", true));
        let turn = done.turn.as_ref().unwrap();
        assert_eq!(turn.state, "completed");
        assert!(turn.completed_at_ms.is_some_and(|at| (at - (now - 10 * 60_000)).abs() < 5));

        let failed = thread(channel, "thread-failed");
        assert_eq!(failed.session_status.as_deref(), Some("error"));
        assert_eq!(failed.agent_session_id, None, "an id that isn't text isn't one");
        assert_eq!(thread(channel, "thread-cursor").agent_session_id.as_deref(), Some("cursor-session-1"));
        let snoozed = thread(channel, "thread-snoozed");
        assert!(snoozed.settled);
        assert!(snoozed.t3_snoozed_until_ms.is_some_and(|until| until > now));
        assert!(snoozed.t3_snoozed_at_ms.is_some());
        assert_eq!(thread(channel, IMPORTED).agent_session_id.as_deref(), Some("0f8b5c2e-1111-4222-8333-444455556666"));

        // Unchanged files aren't read again, and a question keeps when it was first seen.
        assert!(!look(&mut log, &home, now + 5_000));
        assert_eq!(log.channels[0].read_at_ms, now + 5_000);
        assert_eq!(thread(&log.channels[0], "thread-question").question_seen_at_ms, Some(now));
    }

    #[cfg(unix)]
    #[test]
    fn a_database_arbor_doesnt_know_is_skipped_with_the_reason() {
        let skipped = |shape: Shape| {
            let home = temp_dir("schema");
            let _writer = state_database(&channel_dir(&home), &shape, now_ms());
            let mut log = T3Log::default();
            look(&mut log, &home, now_ms());
            let [channel] = &log.channels[..] else { panic!() };
            assert_eq!(channel.threads.is_empty(), channel.skipped.is_some(), "threads only from a database Arbor knows");
            channel.skipped.clone()
        };
        let range = |migration| Some(Skipped { reason: SkipReason::MigrationRange, migration: Some(migration) });
        assert_eq!(skipped(shape(33)), range(33), "from before the snooze");
        assert_eq!(skipped(shape(57)), range(57), "newer than Arbor knows");
        assert_eq!(skipped(Shape { slot_34: "SomethingElse", ..shape(NEWEST_MIGRATION) }), Some(Skipped { reason: SkipReason::Schema, migration: Some(54) }));
        assert_eq!(
            skipped(Shape { without: Some("pending_user_input_count"), ..shape(NEWEST_MIGRATION) }),
            Some(Skipped { reason: SkipReason::Schema, migration: Some(54) }),
        );
        assert_eq!(skipped(shape(NEWEST_MIGRATION)), None);

        let home = temp_dir("not-t3");
        fs::create_dir_all(channel_dir(&home)).unwrap();
        fs::write(channel_dir(&home).join(DATABASE_FILE), "not a database").unwrap();
        let mut log = T3Log::default();
        look(&mut log, &home, now_ms());
        assert_eq!(log.channels[0].skipped, Some(Skipped { reason: SkipReason::Unreadable, migration: None }));
    }

    #[cfg(unix)]
    #[test]
    fn writes_t3_has_not_checkpointed_are_seen_and_a_quiet_database_is_read_as_it_lies() {
        let home = temp_dir("wal");
        let dir = channel_dir(&home);
        let now = now_ms();
        let writer = state_database(&dir, &shape(NEWEST_MIGRATION), now);
        assert!(fs::metadata(dir.join(WAL_FILE)).unwrap().len() > 0, "nothing is checkpointed yet");
        add_thread(&writer, Thread {
            id: "thread-new", project: "project-arbor", provider: "codex", status: "starting", cursor: None,
            extra: vec![], turn: None, updated_ms: now,
        });
        // No server, but a write-ahead log to read beside.
        let mut log = T3Log::default();
        look(&mut log, &home, now);
        assert_eq!(log.channels[0].read_mode, ReadMode::Readonly);
        assert!(!log.channels[0].server_running);
        assert!(ids(&log.channels[0]).contains(&"thread-new"));

        drop(writer);
        assert!(fs::metadata(dir.join(WAL_FILE)).map_or(true, |meta| meta.len() == 0), "closing checkpoints");
        assert!(look(&mut log, &home, now + 5_000), "the read mode changed");
        assert_eq!(log.channels[0].read_mode, ReadMode::Immutable);
        assert!(ids(&log.channels[0]).contains(&"thread-new"));
        assert!(!dir.join(WAL_FILE).exists() && !dir.join("state.sqlite-shm").exists(), "an immutable read leaves no files");
    }

    #[cfg(unix)]
    #[test]
    fn a_read_as_the_file_lies_never_runs_beside_t3_and_counts_only_if_nothing_changed() {
        let home = temp_dir("unsafe");
        let dir = channel_dir(&home);
        drop(state_database(&dir, &shape(NEWEST_MIGRATION), now_ms()));
        let _writer = locked_out(&dir);

        runtime_file(&dir, i64::from(std::process::id()), now_ms());
        let running = read_channel(T3ChannelKind::Userdata, &dir, true);
        assert!(running.failed, "no read at all rather than one without locks beside a running T3 Code");
        assert_eq!(running.mode, ReadMode::Readonly);
        assert!(running.rows.is_empty());

        fs::remove_file(dir.join(RUNTIME_FILE)).unwrap();
        let stopped = read_channel(T3ChannelKind::Userdata, &dir, false);
        assert!(!stopped.failed);
        assert_eq!(stopped.mode, ReadMode::Immutable);
        assert!(!stopped.rows.is_empty());

        // Anything written, made or checkpointed during the read throws it away.
        assert_eq!(unchanged_during(&dir, || 1), Some(1));
        assert_eq!(unchanged_during(&dir, || fs::write(dir.join(WAL_FILE), b"").unwrap()), None, "a log that appeared");
        assert_eq!(unchanged_during(&dir, || fs::write(dir.join(WAL_FILE), b"frames").unwrap()), None, "a log that grew");
        assert_eq!(unchanged_during(&dir, || runtime_file(&dir, 4242, now_ms())), None, "T3 Code started");
        let database = dir.join(DATABASE_FILE);
        let checkpointed = unchanged_during(&dir, || {
            let file = fs::OpenOptions::new().write(true).open(&database).unwrap();
            file.set_modified(SystemTime::now() + Duration::from_secs(1)).unwrap();
        });
        assert_eq!(checkpointed, None, "a page rewritten in place, the same size");
    }

    #[cfg(unix)]
    #[test]
    fn t3_is_running_only_while_the_process_that_wrote_its_file_is() {
        let dir = temp_dir("alive");
        let now = now_ms();
        let mut started = HashMap::new();
        assert!(!local_server_running(&dir, now, &mut started), "no file");
        fs::write(dir.join(RUNTIME_FILE), "{ not json").unwrap();
        assert!(!local_server_running(&dir, now, &mut started), "a file that can't be read");
        fs::write(dir.join(RUNTIME_FILE), r#"{"pid":"12","startedAt":"now"}"#).unwrap();
        assert!(!local_server_running(&dir, now, &mut started), "a pid that isn't one");
        runtime_file(&dir, 0, now);
        assert!(!local_server_running(&dir, now, &mut started), "pid 0 is never T3 Code");

        runtime_file(&dir, i64::from(std::process::id()), now);
        assert!(local_server_running(&dir, now, &mut started), "this process");

        let exited = std::process::Command::new("true").spawn().unwrap();
        let pid = exited.id();
        let mut exited = exited;
        exited.wait().unwrap();
        runtime_file(&dir, i64::from(pid), now);
        assert!(!local_server_running(&dir, now, &mut started), "an exited child");

        let mut later = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        runtime_file(&dir, i64::from(later.id()), now - 3_600_000);
        let reused = local_server_running(&dir, now_ms(), &mut started);
        later.kill().unwrap();
        later.wait().unwrap();
        assert!(!reused, "a process that started after the file's start time has the pid of one that's gone");
    }

    #[test]
    fn elapsed_times_read_as_ps_writes_them() {
        assert_eq!(etime_seconds("00:07"), Some(7));
        assert_eq!(etime_seconds(" 01:02:03\n"), Some(3_723));
        assert_eq!(etime_seconds("2-00:00:01"), Some(172_801));
        assert_eq!(etime_seconds(""), None);
        assert_eq!(etime_seconds("7"), None);
        assert_eq!(etime_seconds("a:b"), None);
    }

    /// Each whitelisted table's alias in the data query.
    const ALIASES: [(&str, &str); 6] = [
        ("t", "projection_threads"),
        ("p", "projection_projects"),
        ("s", "projection_thread_sessions"),
        ("tu", "projection_turns"),
        ("a", "projection_pending_approvals"),
        ("r", "provider_session_runtime"),
    ];

    #[test]
    fn the_queries_name_only_whitelisted_columns() {
        for (data, titled) in [(&LOCAL_SQL.data, false), (&LOCAL_SQL.data_titled, true)] {
            names_only_whitelisted_columns(data, titled);
        }
        let every = [LOCAL_SQL.newest.as_str(), &LOCAL_SQL.slots, &LOCAL_SQL.columns, &LOCAL_SQL.data, &remote_sql(false)].join("\n");
        // JSON's type name and counting rows aren't columns.
        let every = every.replace("'text'", "").replace("COUNT(*)", "");
        for never in [
            "title", "branch", "last_error", "runtime_payload_json", "model_selection_json", "worktree_path", "payload_json",
            "summary", "text", "plan_markdown", "provider_session_id", "provider_thread_id", "orchestration_events", "auth_",
            "messages", "activities", "*",
        ] {
            assert!(!every.contains(never), "the queries mention {never}");
        }
        for (_, name) in COLUMNS {
            assert!(!name.contains('*'));
        }
        assert!(every.contains("'$.resume'") && every.contains("'$.threadId'") && every.contains("'$.sessionId'"));
        // With titles on, the title is the one thing more.
        let titled = [LOCAL_SQL.data_titled.as_str(), &remote_sql(true)].join("\n").replace("COUNT(*)", "");
        assert_eq!(titled.matches("title").count(), 2, "{titled}");
        assert!(!titled.contains("branch") && !titled.contains("summary") && !titled.contains('*'));
    }

    #[cfg(unix)]
    #[test]
    fn a_title_is_read_only_when_asked_for_and_kept_as_one_short_line() {
        let home = temp_dir("titles");
        let dir = channel_dir(&home);
        let _writer = state_database(&dir, &shape(NEWEST_MIGRATION), now_ms());
        let connection = open_readonly(&dir.join(DATABASE_FILE)).unwrap();
        let rows = |sql: &str| -> Vec<Vec<SqlValue>> {
            let mut statement = connection.prepare(sql).unwrap();
            statement.query_map([], |row| values(row, DATA_COLUMNS.len())).unwrap().map(Result::unwrap).collect()
        };
        let titled = rows(&LOCAL_SQL.data_titled);
        assert!(!titled.is_empty());
        let threads: Vec<T3Thread> = titled.iter().filter_map(|row| thread_from_row(row, 0, true)).collect();
        assert!(threads.iter().all(|thread| thread.title.as_deref() == Some(SECRET)), "the fixture's title is its secret");
        // A row read with titles that's taken up after they're off keeps none.
        assert!(titled.iter().filter_map(|row| thread_from_row(row, 0, false)).all(|thread| thread.title.is_none()));
        assert!(rows(&LOCAL_SQL.data).iter().filter_map(|row| thread_from_row(row, 0, true)).all(|thread| thread.title.is_none()));

        assert_eq!(clean_title("  Fix the\nlogin\tflow \u{7}  ").as_deref(), Some("Fix the login flow"));
        assert_eq!(clean_title(" \n "), None);
        assert_eq!(clean_title(&"a".repeat(500)).map(|title| title.chars().count()), Some(TITLE_CHARS));
    }

    fn names_only_whitelisted_columns(data: &str, titled: bool) {
        let mut named = 0;
        for (index, _) in data.match_indices('.') {
            let before = &data[..index];
            let alias: String = before.chars().rev().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect::<Vec<_>>().into_iter().rev().collect();
            let name: String = data[index + 1..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            // A JSON path ('$.resume') or a time format isn't a column.
            if alias.is_empty() || name.is_empty() || before.ends_with('$') {
                continue;
            }
            let table = ALIASES.iter().find(|(known, _)| *known == alias).map(|(_, table)| *table);
            let table = table.unwrap_or_else(|| panic!("unknown alias {alias}.{name}"));
            let known = COLUMNS.contains(&(table, name.as_str())) || (titled && (table, name.as_str()) == TITLE_COLUMN);
            assert!(known, "{table}.{name} isn't whitelisted");
            named += 1;
        }
        assert!(named > 30);
    }

    /// The probe's lines for a database of the known shape at `migration`.
    fn probe_lines(migration: i64) -> String {
        let mut lines = format!("M\t{migration}\n");
        for (id, name) in SLOTS {
            lines += &format!("N\t{id}\t\"{name}\"\n");
        }
        for (table, name) in COLUMNS {
            lines += &format!("C\t\"{table}\"\t\"{name}\"\n");
        }
        lines
    }

    /// A T line: the thread's id, its project and root, a running Codex session, and the rest.
    fn t_line(thread: &str, root: &str, agent: &str, updated: &str) -> String {
        let mut values = vec!["null".to_string(); DATA_COLUMNS.len()];
        values[column::THREAD_ID] = thread.into();
        values[column::PROJECT_ID] = "\"project-arbor\"".into();
        values[column::WORKSPACE_ROOT] = root.into();
        values[column::SESSION_STATUS] = "\"running\"".into();
        values[column::RUNTIME_PROVIDER] = "\"codex\"".into();
        values[column::PENDING_APPROVALS] = "0".into();
        values[column::PENDING_QUESTIONS] = "2".into();
        values[column::INTERACTION_MODE] = "\"default\"".into();
        values[column::ACTIONABLE_PLAN] = "0".into();
        values[column::TURN_STATE] = "\"running\"".into();
        values[column::TURN_REQUESTED_AT] = "\"2026-09-26T00:00:00.000Z\"".into();
        values[column::UPDATED_AT] = updated.into();
        values[column::AGENT_SESSION_ID] = agent.into();
        format!("T\t{}\n", values.join("\t"))
    }

    #[test]
    fn the_script_s_lines_are_read_by_tag_and_everything_odd_is_dropped() {
        let updated = "\"2026-09-26T00:10:00.000Z\"";
        let good = t_line("\"thread-1\"", r#""\/Users\/cam\/a b\"c#d""#, &format!("\"{CODEX_THREAD}\""), updated);
        let stdout = [
            "now\t1790000000\n".to_string(),
            // Before any state folder: dropped.
            good.clone(),
            "D\tsomewhere\n".into(),
            good.clone(),
            "D\tuserdata\n".into(),
            "P\t4242\t1\t2026-09-21T13:13:20.000Z\t00:20\n".into(),
            "R\treadonly\n".into(),
            probe_lines(54),
            "Q\tsomething new\n".into(),
            good.clone(),
            t_line("\"has space\"", "null", "null", updated),
            t_line("\"thread-2\"", "null", "\"../../etc\"", updated),
            t_line("\"thread-3\"", "null", "null", "\"not a time\""),
            // Roots that aren't folders: a line break or a tab in one, or one that isn't absolute.
            t_line("\"thread-5\"", r#""\/Users\/cam\/a\nb""#, "null", updated),
            t_line("\"thread-6\"", r#""\/Users\/cam\/a\tb""#, "null", updated),
            t_line("\"thread-7\"", r#""src\/arbor""#, "null", updated),
            "T\t\"thread-4\"\n".into(),
            good.replace("\"thread-1\"", "{\"thread\""),
            "E\t0\n".into(),
            "D\tcustom\n".into(),
            "P\t\t0\t\t\n".into(),
            "R\timmutable\n".into(),
            probe_lines(57),
            good.replace("thread-1", "thread-9"),
            "E\t0\n".into(),
        ]
        .concat();
        let read = parse_remote(&stdout).unwrap();
        assert_eq!(read.now_s, 1_790_000_000);
        assert!(!read.no_sqlite3);
        assert_eq!(read.channels.len(), 2);

        // 60s ahead of the machine.
        let at_ms = 1_790_000_000_000 + 60_000;
        let mut log = T3Log::default();
        assert!(apply_remote(&mut log, "cedar-02", read, at_ms));
        let [userdata, custom] = &log.channels[..] else { panic!() };
        assert_eq!(
            ids(userdata),
            ["thread-1", "thread-2", "thread-5", "thread-6", "thread-7"],
            "bad ids, missing times and short or broken lines are dropped",
        );
        for id in ["thread-5", "thread-6", "thread-7"] {
            assert_eq!(thread(userdata, id).workspace_root, None, "{id}'s root isn't a folder");
        }
        let first = thread(userdata, "thread-1");
        assert_eq!(first.workspace_root.as_deref(), Some("/Users/cam/a b\"c#d"));
        assert_eq!(first.agent_session_id.as_deref(), Some(CODEX_THREAD));
        assert_eq!(first.provider.as_deref(), Some("codex"));
        assert_eq!(first.pending_questions, 2);
        assert_eq!(first.question_seen_at_ms, Some(at_ms));
        let updated_ms = iso_ms("2026-09-26T00:10:00.000Z").unwrap();
        assert_eq!(first.updated_at_ms, updated_ms + 60_000, "times move into Arbor's clock");
        assert_eq!(thread(userdata, "thread-2").agent_session_id, None, "an agent id that isn't one");
        assert!(!userdata.server_running, "the process started 20s before the machine's now, after the file's start time");
        assert_eq!(userdata.read_mode, ReadMode::Readonly);

        assert_eq!(custom.skipped, Some(Skipped { reason: SkipReason::MigrationRange, migration: Some(57) }));
        assert!(custom.threads.is_empty(), "no T line is taken from a database Arbor doesn't know");
        assert_eq!(custom.read_mode, ReadMode::Immutable);
        assert!(!custom.server_running);

        // The next look, a moment later by a clock that ticked over: nothing moves.
        let again = stdout
            .replace("now\t1790000000", "now\t1790000031")
            .replace("\t00:20\n", "\t00:51\n");
        let read = parse_remote(&again).unwrap();
        assert!(!apply_remote(&mut log, "cedar-02", read, at_ms + 30_500));
        assert_eq!(thread(&log.channels[0], "thread-1").updated_at_ms, updated_ms + 60_000);
        assert_eq!(thread(&log.channels[0], "thread-1").question_seen_at_ms, Some(at_ms));
    }

    #[test]
    fn a_process_is_t3_s_only_when_it_started_by_the_file_s_start_time() {
        let started = iso_ms("2026-09-26T00:00:00.000Z").unwrap();
        let now_s = started / 1000 + 60;
        let line = |alive, elapsed| ProcessLine { alive, started_ms: Some(started), elapsed_s: elapsed };
        assert!(line(true, Some(61)).running(now_s));
        assert!(line(true, Some(58)).running(now_s), "within the slack");
        assert!(!line(true, Some(20)).running(now_s));
        assert!(line(true, None).running(now_s), "ps couldn't say");
        assert!(!line(false, Some(61)).running(now_s));
    }

    #[test]
    fn a_machine_without_sqlite3_or_a_clock_says_so() {
        let read = parse_remote("now\t1790000000\nX\tsqlite3\n").unwrap();
        assert!(read.no_sqlite3);
        let mut log = T3Log::default();
        apply_remote(&mut log, "cedar-02", read, 1_790_000_000_000);
        assert_eq!(log.channels[0].skipped, Some(Skipped { reason: SkipReason::NoSqlite3, migration: None }));
        assert!(parse_remote("D\tuserdata\n").is_err());
        assert!(parse_remote("now\tsoon\n").is_err());
        assert!(parse_remote("now\t1790000000\n").unwrap().channels.is_empty(), "no T3 Code database");
    }

    #[test]
    fn a_question_keeps_the_time_it_was_first_seen_until_it_s_answered() {
        let read = |questions: &str| {
            let line = t_line("\"thread-1\"", "null", "null", "\"2026-09-26T00:10:00.000Z\"").replace("\t2\t", &format!("\t{questions}\t"));
            parse_remote(&format!("now\t1790000000\nD\tuserdata\nP\t\t0\t\t\nR\timmutable\n{}{line}E\t0\n", probe_lines(54))).unwrap()
        };
        let mut log = T3Log::default();
        let at = 1_790_000_000_000;
        apply_remote(&mut log, "m", read("1"), at);
        apply_remote(&mut log, "m", read("1"), at + 1_000);
        assert_eq!(thread(&log.channels[0], "thread-1").question_seen_at_ms, Some(at));
        apply_remote(&mut log, "m", read("0"), at + 2_000);
        assert!(log.questions.is_empty());
        apply_remote(&mut log, "m", read("1"), at + 3_000);
        assert_eq!(thread(&log.channels[0], "thread-1").question_seen_at_ms, Some(at + 3_000), "a new question");
    }

    #[test]
    fn t3_code_s_state_folders_are_each_looked_in_once() {
        let home = temp_dir("channels");
        let kinds = |t3_home: Option<&str>| local_channels(&home, t3_home).into_iter().map(|(kind, _)| kind).collect::<Vec<_>>();
        assert_eq!(kinds(None), [T3ChannelKind::Userdata]);
        assert_eq!(kinds(Some("~/.t3")), [T3ChannelKind::Userdata], "the same folder");
        assert_eq!(kinds(Some("/opt/t3")), [T3ChannelKind::Userdata, T3ChannelKind::Custom]);
        assert_eq!(kinds(Some("relative")), [T3ChannelKind::Userdata]);
        assert_eq!(local_channels(&home, Some("/opt/t3/"))[1].1, PathBuf::from("/opt/t3/userdata"));
        assert_eq!(immutable_uri(Path::new("/a b/c?d#e%f")).unwrap(), "file:/a%20b/c%3Fd%23e%25f?immutable=1");
    }

    #[cfg(unix)]
    mod script {
        use super::*;

        fn run(shell: &str, home: &Path, path: &str, t3_home: Option<&Path>) -> String {
            let mut command = tokio::process::Command::new(shell);
            command
                .env_clear()
                .env("HOME", home)
                .env("PATH", path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            if let Some(t3_home) = t3_home {
                command.env("T3CODE_HOME", t3_home);
            }
            let output = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(run_script(command, &REMOTE_SCRIPT, Duration::from_secs(20)))
                .unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8(output.stdout).unwrap()
        }

        fn has_sqlite3() -> bool {
            Path::new("/usr/bin/sqlite3").exists()
        }

        #[test]
        fn the_script_reads_what_the_local_read_does_and_never_the_secret() {
            if !has_sqlite3() {
                return;
            }
            let home = temp_dir("script");
            let dir = channel_dir(&home);
            let now = now_ms();
            let _writer = state_database(&dir, &shape(NEWEST_MIGRATION), now);
            runtime_file(&dir, i64::from(std::process::id()), now);
            let mut local = T3Log::default();
            look(&mut local, &home, now);
            for shell in shells() {
                // T3CODE_HOME pointing at the same place doesn't read it twice.
                let stdout = run(shell, &home, "/usr/bin:/bin", Some(&home.join(".t3")));
                assert!(!stdout.contains(SECRET), "{shell}: {stdout}");
                assert!(stdout.lines().any(|line| line.starts_with("T\t")), "{shell}: {stdout}");
                let read = parse_remote(&stdout).unwrap();
                let mut log = T3Log::default();
                apply_remote(&mut log, "cedar-02", read, now_ms());
                let [channel] = &log.channels[..] else { panic!("{shell}: {stdout}") };
                assert_eq!(channel.skipped, None, "{shell}");
                assert!(channel.server_running, "{shell}");
                assert_eq!(channel.read_mode, ReadMode::Readonly, "{shell}");
                assert_eq!(ids(channel), ids(&local.channels[0]), "{shell}");
                for local_thread in &local.channels[0].threads {
                    let remote = thread(channel, &local_thread.thread_id);
                    assert_eq!(remote.agent_session_id, local_thread.agent_session_id, "{shell}");
                    assert_eq!(remote.workspace_root, local_thread.workspace_root, "{shell}");
                    assert_eq!(remote.pending_approvals, local_thread.pending_approvals, "{shell}");
                    assert_eq!(remote.turn.as_ref().map(|turn| &turn.state), local_thread.turn.as_ref().map(|turn| &turn.state), "{shell}");
                }
                assert!(!serde_json::to_string(&log.channels).unwrap().contains(SECRET));
            }
        }

        #[test]
        fn a_quiet_database_is_read_as_it_lies_and_one_arbor_doesnt_know_gives_no_threads() {
            if !has_sqlite3() {
                return;
            }
            let home = temp_dir("script-57");
            let writer = state_database(&home.join(".t3/userdata"), &shape(57), now_ms());
            drop(writer);
            for shell in shells() {
                let stdout = run(shell, &home, "/usr/bin:/bin", None);
                assert!(stdout.contains("D\tuserdata\n") && stdout.contains("R\timmutable\n") && stdout.contains("M\t57\n"), "{shell}: {stdout}");
                assert!(!stdout.lines().any(|line| line.starts_with("T\t")), "{shell}: {stdout}");
                assert!(!stdout.contains(SECRET));
                let mut log = T3Log::default();
                apply_remote(&mut log, "cedar-02", parse_remote(&stdout).unwrap(), now_ms());
                assert_eq!(log.channels[0].skipped, Some(Skipped { reason: SkipReason::MigrationRange, migration: Some(57) }));
                assert!(log.channels[0].threads.is_empty());
            }
            assert!(!home.join(".t3/userdata").join(WAL_FILE).exists(), "the immutable read left nothing behind");
        }

        #[test]
        fn beside_a_running_t3_the_script_never_reads_without_locks() {
            if !has_sqlite3() {
                return;
            }
            let home = temp_dir("script-unsafe");
            let dir = channel_dir(&home);
            drop(state_database(&dir, &shape(NEWEST_MIGRATION), now_ms()));
            let _writer = locked_out(&dir);
            runtime_file(&dir, i64::from(std::process::id()), now_ms());
            for shell in shells() {
                let stdout = run(shell, &home, "/usr/bin:/bin", None);
                assert!(stdout.contains("R\tunreadable\n"), "{shell}: {stdout}");
                assert!(!stdout.lines().any(|line| line.starts_with("T\t") || line.starts_with("M\t")), "{shell}: {stdout}");
                let mut log = T3Log::default();
                apply_remote(&mut log, "cedar-02", parse_remote(&stdout).unwrap(), now_ms());
                assert_eq!(log.channels[0].skipped, Some(Skipped { reason: SkipReason::Unreadable, migration: None }));
            }
            // With T3 Code down, the same database is read as it lies.
            fs::remove_file(dir.join(RUNTIME_FILE)).unwrap();
            for shell in shells() {
                let stdout = run(shell, &home, "/usr/bin:/bin", None);
                assert!(stdout.contains("R\timmutable\n") && stdout.lines().any(|line| line.starts_with("T\t")), "{shell}: {stdout}");
            }
        }

        #[test]
        fn without_sqlite3_the_script_says_so_and_nothing_else() {
            let home = temp_dir("script-no-sqlite");
            let _writer = state_database(&channel_dir(&home), &shape(NEWEST_MIGRATION), now_ms());
            let bin = temp_dir("script-bin");
            for tool in ["date", "awk", "printf"] {
                for dir in ["/bin", "/usr/bin"] {
                    let from = Path::new(dir).join(tool);
                    if from.exists() && !bin.join(tool).exists() {
                        std::os::unix::fs::symlink(&from, bin.join(tool)).unwrap();
                    }
                }
            }
            for shell in shells() {
                let stdout = run(&format!("/bin/{shell}"), &home, &bin.to_string_lossy(), None);
                let tags: Vec<&str> = stdout.lines().map(|line| line.split('\t').next().unwrap_or("")).collect();
                assert_eq!(tags, ["now", "X"], "{shell}: {stdout}");
                assert!(stdout.ends_with("X\tsqlite3\n"));
            }
            let empty = temp_dir("script-empty");
            for shell in shells() {
                let stdout = run(shell, &empty, "/usr/bin:/bin", None);
                assert_eq!(stdout.lines().count(), 1, "no T3 Code, nothing but the clock: {stdout}");
            }
        }
    }

    /// Times one local look while T3 Code writes, on a database the size a busy user's gets. Ignored in the normal run;
    /// run it in release:
    ///
    /// ```sh
    /// cd src-tauri && cargo test --release t3_threads::tests::local_look_at_volume -- --ignored --nocapture
    /// ```
    ///
    /// `ARBOR_BENCH_T3_THREADS` (default 5,000) sizes the history; a twentieth of the threads are in the window.
    #[cfg(unix)]
    #[test]
    #[ignore = "benchmark: run in release with --ignored --nocapture"]
    fn local_look_at_volume() {
        use std::time::Instant;
        let threads: i64 = std::env::var("ARBOR_BENCH_T3_THREADS").ok().and_then(|value| value.parse().ok()).unwrap_or(5_000);
        let home = temp_dir("bench");
        let dir = channel_dir(&home);
        let now = now_ms();
        let writer = state_database(&dir, &shape(NEWEST_MIGRATION), now);
        runtime_file(&dir, i64::from(std::process::id()), now);
        writer.execute_batch("BEGIN").unwrap();
        for index in 0..threads {
            let id = format!("thread-bench-{index}");
            let recent = index % 20 == 0;
            let updated_ms = if recent { now - index * 1_000 } else { now - 3 * 86_400_000 - index * 60_000 };
            let cursor = claude_cursor(&id, CLAUDE_SESSION);
            add_thread(&writer, Thread {
                id: &id, project: "project-arbor", provider: "claudeAgent", status: if recent { "running" } else { "stopped" },
                cursor: Some(&cursor), extra: vec![], turn: Some(("completed", updated_ms - 60_000, Some(updated_ms))), updated_ms,
            });
        }
        writer.execute_batch("COMMIT; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        // T3 Code writes as its agents work: an activity row and the thread's time, each its own commit.
        let mut written = 0_i64;
        let mut write = || {
            written += 1;
            insert(&writer, "projection_thread_activities", &[
                ("activity_id", text(&format!("activity-bench-{written}"))), ("thread_id", text("thread-working")),
                ("tone", text("info")), ("kind", text("tool")), ("summary", text(SECRET)), ("payload_json", text("{}")),
                ("created_at", text(&iso(now))),
            ]);
            writer.execute("UPDATE projection_threads SET updated_at = ?1 WHERE thread_id = 'thread-working'", [iso(now + written)]).unwrap();
        };
        let mut log = T3Log::default();
        assert!(look(&mut log, &home, now));
        let shown = log.channels[0].threads.len();
        // CPU time on this thread, which is what an idle app pays, and steadier than the clock on a busy Mac.
        let cpu_ms = || {
            let mut spec = libc::timespec { tv_sec: 0, tv_nsec: 0 };
            unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut spec) };
            spec.tv_sec as f64 * 1_000.0 + spec.tv_nsec as f64 / 1_000_000.0
        };
        let mut sample = |label: &str, writing: bool| {
            let (mut wall, mut cpu): (Vec<f64>, Vec<f64>) = (0..200)
                .map(|_| {
                    if writing {
                        write();
                    }
                    let (started, cpu_started) = (Instant::now(), cpu_ms());
                    look(&mut log, &home, now);
                    (started.elapsed().as_secs_f64() * 1_000.0, cpu_ms() - cpu_started)
                })
                .unzip();
            wall.sort_by(f64::total_cmp);
            cpu.sort_by(f64::total_cmp);
            println!(
                "{label:<30} wall median {:>7.3} ms (p10 {:.3}, p90 {:.3})   cpu median {:>7.3} ms (p10 {:.3}, p90 {:.3})",
                wall[100], wall[20], wall[180], cpu[100], cpu[20], cpu[180]
            );
        };
        println!("T3 Code database: {threads} threads, {shown} shown");
        sample("look, T3 Code writing", true);
        sample("look, nothing written", false);
        let _ = fs::remove_dir_all(&home);
    }
}

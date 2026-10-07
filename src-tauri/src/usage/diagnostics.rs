//! Diagnostics: how Arbor's calls out went.
//!
//! Every script Arbor runs on a machine (over SSH, or with `sh` on this Mac) and every
//! request it makes to the core's management API is noted here: when it finished, where
//! it went (the machine's name, or "core"), what it was for (a fixed name such as "setup
//! scan", or a core request's method and path, like "GET /auth-files"), how long it took,
//! the exit code or HTTP status, and whether it failed or ran out of time.
//!
//! Nothing else. Never the command, its arguments or what it printed, and never a
//! request's query, headers or body. A machine call's name comes from [`MachineOp`], a
//! closed set, so there's no way to hand this module anything more; a core request's path
//! is cut down to plain words by [`core_operation`]. The SECRET tests prove it.
//!
//! Calls wait in memory and go into usage.db a couple of seconds later, a batch at a time,
//! so a burst of calls is one short write. The table keeps a week, and at most
//! [`MAX_CALLS`] calls. Calls that went fine make way before failures and slow ones, and
//! each machine's (or the core's) operation keeps only its latest [`ROUTINE_PER_OPERATION`]
//! that went fine and its latest [`PROBLEMS_PER_OPERATION`] of each way a call goes wrong
//! (failed, timed out, slow). So neither a health check every few seconds nor one that
//! fails every time while its machine is asleep can push a rarer scan's history out.

use super::*;
use ts_rs::TS;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

const KEEP_DAYS: i64 = 7;
const KEEP_MS: i64 = KEEP_DAYS * 86_400_000;
const MAX_CALLS: usize = 2_000;
const ROUTINE_PER_OPERATION: usize = 50;
/// Failures, timeouts and slow calls each keep this many per operation: hours of a machine that's off,
/// checked every minute, without its failures filling the table.
const PROBLEMS_PER_OPERATION: usize = 100;
/// Calls waiting to be saved. Past this the oldest are dropped, so memory stays flat while
/// usage.db can't be written.
const MAX_PENDING: usize = 1_000;
const FLUSH_DELAY: Duration = Duration::from_secs(2);
/// A script on a machine is slow past this.
const MACHINE_SLOW_MS: u64 = 10_000;
/// Scans that walk a machine's disks or ask its tools, and changes that write several files.
const MACHINE_SCAN_SLOW_MS: u64 = 60_000;
/// Installs, which download.
const MACHINE_INSTALL_SLOW_MS: u64 = 180_000;
/// A core request is slow past this.
const CORE_SLOW_MS: u64 = 3_000;
/// Core requests that wait on a provider's own API.
const CORE_PROVIDER_SLOW_MS: u64 = 10_000;
const CORE_PROVIDER_PATHS: [&str; 3] = ["/api-call", "/reset-quota", "/auth-files/refresh"];
const CORE_TARGET: &str = "core";
/// A path keeps this many of its segments.
const MAX_PATH_SEGMENTS: usize = 4;
const MAX_SEGMENT_CHARS: usize = 32;
const CLEARED_KEY: &str = "cleared_at_ms";

static QUEUE: Queue = Queue::new();
/// usage.db's folder, once the app has set it up. Tests never set it, so their calls only
/// ever wait in memory.
static STORE: OnceLock<PathBuf> = OnceLock::new();
static FLUSH_SCHEDULED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CallKind {
    Machine,
    Core,
}

impl CallKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Machine => "machine",
            Self::Core => "core",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "machine" => Some(Self::Machine),
            "core" => Some(Self::Core),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "CallOutcome")]
pub(crate) enum Outcome {
    Ok,
    Failed,
    TimedOut,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Failed => "failed",
            Self::TimedOut => "timedOut",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "ok" => Some(Self::Ok),
            "failed" => Some(Self::Failed),
            "timedOut" => Some(Self::TimedOut),
            _ => None,
        }
    }
}

/// What a script run on a machine was for. Its name is all Diagnostics keeps of the script.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MachineOp {
    HealthCheck,
    AgentVersions,
    AgentUpdate,
    NeedsYouPoll,
    T3Threads,
    ReporterCheck,
    ReporterSetup,
    ClaudeSettingsRead,
    ClaudeSettingsWrite,
    CodexSettingsRead,
    CodexSettingsWrite,
    TranscriptScan,
    SetupScan,
    SetupFileRead,
    SkillRead,
    SetupApply,
    SetupBackups,
    SetupUndo,
    SkillsApply,
    SkillsTake,
    McpRead,
    McpApply,
    McpHealth,
    PluginApply,
    CodexPluginApply,
    PluginCost,
    ProjectsScan,
    ProjectsMeasure,
    ProjectFixes,
    WorktreeRemoval,
    ToolchainScan,
    PackageScan,
    NodeChange,
    ArchiveList,
    ArchiveRead,
    AgentHomesScan,
    AgentHomeCheck,
    AutomationScan,
    AutomationStart,
    AutomationPoll,
    AutomationChange,
    SshConfigWrite,
    RunnerInstall,
    RunHandOff,
    RunCheck,
    RunOpen,
    CleanupScan,
    CleanupList,
    CleanupMove,
    CleanupDelete,
    CleanupUninstall,
}

impl MachineOp {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::HealthCheck => "health check",
            Self::AgentVersions => "agent versions",
            Self::AgentUpdate => "agent update",
            Self::NeedsYouPoll => "needs-you check",
            Self::T3Threads => "T3 Code threads",
            Self::ReporterCheck => "reporter check",
            Self::ReporterSetup => "reporter setup",
            Self::ClaudeSettingsRead => "Claude settings read",
            Self::ClaudeSettingsWrite => "Claude settings write",
            Self::CodexSettingsRead => "Codex settings read",
            Self::CodexSettingsWrite => "Codex settings write",
            Self::TranscriptScan => "transcript scan",
            Self::SetupScan => "setup scan",
            Self::SetupFileRead => "setup file read",
            Self::SkillRead => "skill read",
            Self::SetupApply => "setup sync",
            Self::SetupBackups => "setup backups",
            Self::SetupUndo => "setup undo",
            Self::SkillsApply => "skill changes",
            Self::SkillsTake => "skills into repo",
            Self::McpRead => "MCP servers read",
            Self::McpApply => "MCP changes",
            Self::McpHealth => "MCP health",
            Self::PluginApply => "plugin changes",
            Self::CodexPluginApply => "Codex plugin changes",
            Self::PluginCost => "plugin cost",
            Self::ProjectsScan => "projects scan",
            Self::ProjectsMeasure => "projects measure",
            Self::ProjectFixes => "project fixes",
            Self::WorktreeRemoval => "worktree removal",
            Self::ToolchainScan => "toolchain scan",
            Self::PackageScan => "package scan",
            Self::NodeChange => "Node versions",
            Self::ArchiveList => "archive list",
            Self::ArchiveRead => "archive read",
            Self::AgentHomesScan => "agent homes scan",
            Self::AgentHomeCheck => "agent home check",
            Self::AutomationScan => "automations scan",
            Self::AutomationStart => "automation start",
            Self::AutomationPoll => "automation runs check",
            Self::AutomationChange => "automation change",
            Self::SshConfigWrite => "SSH config change",
            Self::RunnerInstall => "background runner install",
            Self::RunHandOff => "run hand-off",
            Self::RunCheck => "run check",
            Self::RunOpen => "run open",
            Self::CleanupScan => "clean-up scan",
            Self::CleanupList => "set-aside list",
            Self::CleanupMove => "clean-up move",
            Self::CleanupDelete => "set-aside delete",
            Self::CleanupUninstall => "agent uninstall",
        }
    }

    fn slow_after_ms(self) -> u64 {
        match self {
            Self::AgentUpdate | Self::CleanupUninstall | Self::PluginApply | Self::CodexPluginApply | Self::McpApply | Self::NodeChange | Self::RunnerInstall => {
                MACHINE_INSTALL_SLOW_MS
            }
            Self::TranscriptScan
            | Self::SetupScan
            | Self::SetupApply
            | Self::SetupUndo
            | Self::SkillsApply
            | Self::SkillsTake
            | Self::RunHandOff
            | Self::McpHealth
            | Self::PluginCost
            | Self::ProjectsScan
            | Self::ProjectsMeasure
            | Self::ProjectFixes
            | Self::WorktreeRemoval
            | Self::ToolchainScan
            | Self::PackageScan
            | Self::ArchiveList
            | Self::ArchiveRead
            | Self::AgentHomesScan
            | Self::AutomationScan
            | Self::AutomationStart
            | Self::CleanupScan
            | Self::CleanupMove
            | Self::CleanupDelete => MACHINE_SCAN_SLOW_MS,
            _ => MACHINE_SLOW_MS,
        }
    }
}

/// How a core request ended: the status the core answered with, or no answer at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CoreReply {
    Status(u16),
    TimedOut,
    Unreachable,
}

/// One call, as Diagnostics keeps it.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "DiagnosticCall")]
pub(crate) struct Call {
    /// When it finished.
    at_ms: i64,
    kind: CallKind,
    /// The machine's name, or "core".
    target: String,
    /// A fixed name for a machine's script ("setup scan"), or a core request's method and path
    /// ("GET /auth-files").
    operation: String,
    duration_ms: u64,
    /// The script's exit code, or the core's HTTP status.
    code: Option<i64>,
    outcome: Outcome,
    slow_after_ms: u64,
    /// Finished fine, but took longer than `slow_after_ms`.
    slow: bool,
}

impl Call {
    #[allow(clippy::too_many_arguments)]
    fn new(
        kind: CallKind,
        target: &str,
        operation: String,
        elapsed: Duration,
        code: Option<i64>,
        outcome: Outcome,
        slow_after_ms: u64,
        at_ms: i64,
    ) -> Self {
        let duration_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX);
        Self {
            at_ms,
            kind,
            target: target.to_string(),
            operation,
            duration_ms,
            code,
            outcome,
            slow_after_ms,
            slow: outcome == Outcome::Ok && duration_ms > slow_after_ms,
        }
    }
}

fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

/// A script run on `machine`: its output, a failure to run it at all, or None when it ran
/// out of time. Only the exit status is read from the output.
pub(crate) fn machine_call(
    machine: &str,
    op: MachineOp,
    elapsed: Duration,
    finished: Option<&Result<std::process::Output, String>>,
) -> Call {
    let (code, outcome) = match finished {
        None => (None, Outcome::TimedOut),
        Some(Err(_)) => (None, Outcome::Failed),
        Some(Ok(output)) => (
            output.status.code().map(i64::from),
            if output.status.success() { Outcome::Ok } else { Outcome::Failed },
        ),
    };
    Call::new(CallKind::Machine, machine, op.name().to_string(), elapsed, code, outcome, op.slow_after_ms(), now_ms())
}

/// A request to the core's management API, by its method and URL path.
pub(crate) fn core_call(method: &str, path: &str, elapsed: Duration, reply: CoreReply) -> Call {
    let operation = core_operation(method, path);
    let slow_after_ms = if CORE_PROVIDER_PATHS.iter().any(|provider| operation.ends_with(&format!(" {provider}"))) {
        CORE_PROVIDER_SLOW_MS
    } else {
        CORE_SLOW_MS
    };
    let (code, outcome) = match reply {
        CoreReply::Status(status) => (Some(i64::from(status)), if status < 400 { Outcome::Ok } else { Outcome::Failed }),
        CoreReply::TimedOut => (None, Outcome::TimedOut),
        CoreReply::Unreachable => (None, Outcome::Failed),
    };
    Call::new(CallKind::Core, CORE_TARGET, operation, elapsed, code, outcome, slow_after_ms, now_ms())
}

/// "GET /auth-files" for a request to `/v0/management/auth-files?name=…`: the method and
/// the path without its query. A segment that isn't a plain lowercase word (a file name,
/// an address, a number, anything long) becomes `*`, so nothing that names an account or
/// looks like a token is kept.
pub(crate) fn core_operation(method: &str, path: &str) -> String {
    let method = method.trim().to_ascii_uppercase();
    let method = if !method.is_empty() && method.len() <= 7 && method.bytes().all(|byte| byte.is_ascii_uppercase()) {
        method
    } else {
        "?".to_string()
    };
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let path = path.trim_start_matches('/');
    let path = path.strip_prefix("v0/management").unwrap_or(path);
    let segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .take(MAX_PATH_SEGMENTS)
        .map(|segment| if plain_segment(segment) { segment } else { "*" })
        .collect();
    format!("{method} /{}", segments.join("/"))
}

fn plain_segment(segment: &str) -> bool {
    segment.len() <= MAX_SEGMENT_CHARS
        && segment.bytes().any(|byte| byte.is_ascii_lowercase())
        && segment.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.'))
        && segment.bytes().filter(u8::is_ascii_digit).count() <= 2
}

/// Calls waiting to be saved.
struct Queue {
    pending: Mutex<VecDeque<Call>>,
    /// Held from taking calls off the queue until they're committed, and from copying the queue until the table
    /// has been read, so a read finds each call exactly once: still waiting, or saved. Taken after usage.db's
    /// write lock, never before it.
    saving: Mutex<()>,
}

impl Queue {
    const fn new() -> Self {
        Self { pending: Mutex::new(VecDeque::new()), saving: Mutex::new(()) }
    }

    fn lock_pending(&self) -> MutexGuard<'_, VecDeque<Call>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn lock_saving(&self) -> MutexGuard<'_, ()> {
        // The lock guards no data, so a poisoned lock is safe to keep using.
        self.saving.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn push(&self, call: Call) {
        let mut pending = self.lock_pending();
        pending.push_back(call);
        while pending.len() > MAX_PENDING {
            pending.pop_front();
        }
    }

    fn take(&self) -> Vec<Call> {
        self.lock_pending().drain(..).collect()
    }

    fn is_empty(&self) -> bool {
        self.lock_pending().is_empty()
    }

    /// Saves the calls waiting. usage.db is opened only when there are some.
    fn save(&self, open: impl FnOnce() -> Result<Connection, String>, now_ms: i64) -> Result<(), String> {
        let _saving = self.lock_saving();
        let calls = self.take();
        if calls.is_empty() {
            return Ok(());
        }
        write_calls(&mut open()?, &calls, now_ms)
    }

    /// The calls shown, newest first, those still waiting included, and when they were last cleared.
    fn read(&self, connection: &Connection, now_ms: i64) -> Result<(Vec<Call>, Option<i64>), String> {
        let _saving = self.lock_saving();
        let pending: Vec<Call> = self.lock_pending().iter().cloned().collect();
        let (saved, cleared) = read_calls(connection, now_ms)?;
        let from = shown_from(cleared, now_ms);
        // Calls still waiting to be saved are newer than any saved one.
        let mut calls: Vec<Call> = pending.into_iter().rev().filter(|call| call.at_ms >= from).collect();
        calls.extend(saved);
        calls.truncate(MAX_CALLS);
        Ok((calls, cleared))
    }

    /// Hides every call so far, those still waiting included: they're saved first, so the count covers them and
    /// Undo brings them back too.
    fn clear(&self, connection: &mut Connection, now_ms: i64) -> Result<ClearedCalls, String> {
        let _saving = self.lock_saving();
        write_calls(connection, &self.take(), now_ms)?;
        clear_calls(connection, now_ms)
    }
}

/// Notes a call. It's saved with the next batch.
pub(crate) fn record(call: Call) {
    if call.outcome != Outcome::Ok || call.slow {
        crate::product_analytics::note_call_problem(call.kind.as_str(), &call.operation, call.outcome.as_str(), call.slow, call.duration_ms, call.at_ms);
    }
    QUEUE.push(call);
    schedule_flush();
}

/// Starts saving calls to usage.db, once it has been set up; until then they wait in memory.
pub(crate) fn start() {
    match usage_root_dir() {
        Ok(root) => {
            if STORE.set(root).is_ok() {
                schedule_flush();
            }
        }
        Err(error) => eprintln!("Diagnostics won't be saved: {error}"),
    }
}

fn schedule_flush() {
    let Some(root) = STORE.get().cloned() else {
        return;
    };
    if FLUSH_SCHEDULED.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FLUSH_DELAY).await;
        FLUSH_SCHEDULED.store(false, Ordering::Release);
        if QUEUE.is_empty() {
            return;
        }
        let saved = run_usage_task(move || {
            let _write_guard = lock_usage_writes();
            QUEUE.save(|| open_usage_database_at(&root), now_ms())
        })
        .await;
        if let Err(error) = saved {
            eprintln!("Failed to save diagnostics: {error}");
        }
    });
}

/// Saves a batch of calls and trims the table back to its limits.
fn write_calls(connection: &mut Connection, calls: &[Call], now_ms: i64) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start saving diagnostics: {error}"))?;
    {
        let mut insert = transaction
            .prepare(
                "INSERT INTO diagnostic_calls
                 (at_ms, kind, target, operation, duration_ms, code, outcome, slow_after_ms, slow)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )
            .map_err(|error| format!("Failed to save diagnostics: {error}"))?;
        for call in calls {
            insert
                .execute(params![
                    call.at_ms,
                    call.kind.as_str(),
                    call.target,
                    call.operation,
                    to_sql_i64(call.duration_ms),
                    call.code,
                    call.outcome.as_str(),
                    to_sql_i64(call.slow_after_ms),
                    call.slow,
                ])
                .map_err(|error| format!("Failed to save diagnostics: {error}"))?;
        }
    }
    prune(&transaction, now_ms)?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to save diagnostics: {error}"))
}

fn prune(connection: &Connection, now_ms: i64) -> Result<(), String> {
    let failed = |error: rusqlite::Error| format!("Failed to trim diagnostics: {error}");
    connection
        .execute("DELETE FROM diagnostic_calls WHERE at_ms < ?1", params![now_ms - KEEP_MS])
        .map_err(failed)?;
    connection
        .execute(
            "DELETE FROM diagnostic_calls WHERE id IN (
                SELECT id FROM (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY kind, target, operation ORDER BY at_ms DESC, id DESC
                    ) AS newer
                    FROM diagnostic_calls WHERE outcome = 'ok' AND slow = 0
                ) WHERE newer > ?1
            )",
            params![ROUTINE_PER_OPERATION as i64],
        )
        .map_err(failed)?;
    // A call that went fine but slowly is outcome 'ok', so the outcome keeps slow calls apart from failures.
    connection
        .execute(
            "DELETE FROM diagnostic_calls WHERE id IN (
                SELECT id FROM (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY kind, target, operation, outcome ORDER BY at_ms DESC, id DESC
                    ) AS newer
                    FROM diagnostic_calls WHERE NOT (outcome = 'ok' AND slow = 0)
                ) WHERE newer > ?1
            )",
            params![PROBLEMS_PER_OPERATION as i64],
        )
        .map_err(failed)?;
    // Past the cap, calls that went fine go first, oldest first; then the oldest problems.
    connection
        .execute(
            "DELETE FROM diagnostic_calls WHERE id IN (
                SELECT id FROM diagnostic_calls
                ORDER BY (outcome = 'ok' AND slow = 0), at_ms DESC, id DESC
                LIMIT -1 OFFSET ?1
            )",
            params![MAX_CALLS as i64],
        )
        .map_err(failed)?;
    Ok(())
}

fn cleared_at(connection: &Connection) -> Result<Option<i64>, String> {
    connection
        .query_row("SELECT value FROM diagnostic_settings WHERE key = ?1", params![CLEARED_KEY], |row| row.get(0))
        .optional()
        .map_err(|error| format!("Failed to read diagnostics: {error}"))
}

fn set_cleared_at(connection: &Connection, value: Option<i64>) -> Result<(), String> {
    let result = match value {
        Some(value) => connection.execute(
            "INSERT INTO diagnostic_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![CLEARED_KEY, value],
        ),
        None => connection.execute("DELETE FROM diagnostic_settings WHERE key = ?1", params![CLEARED_KEY]),
    };
    result
        .map(|_| ())
        .map_err(|error| format!("Failed to clear diagnostics: {error}"))
}

/// The first moment a call is shown from: a week back, or just after the last Clear.
fn shown_from(cleared: Option<i64>, now_ms: i64) -> i64 {
    (now_ms - KEEP_MS).max(cleared.map_or(i64::MIN, |cleared| cleared + 1))
}

/// The calls shown, newest first, and when they were last cleared.
fn read_calls(connection: &Connection, now_ms: i64) -> Result<(Vec<Call>, Option<i64>), String> {
    let cleared = cleared_at(connection)?;
    let failed = |error: rusqlite::Error| format!("Failed to read diagnostics: {error}");
    let mut statement = connection
        .prepare(
            "SELECT at_ms, kind, target, operation, duration_ms, code, outcome, slow_after_ms, slow
             FROM diagnostic_calls WHERE at_ms >= ?1 ORDER BY at_ms DESC, id DESC LIMIT ?2",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![shown_from(cleared, now_ms), MAX_CALLS as i64], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, bool>(8)?,
            ))
        })
        .map_err(failed)?;
    let mut calls = Vec::new();
    for row in rows {
        let (at_ms, kind, target, operation, duration_ms, code, outcome, slow_after_ms, slow) = row.map_err(failed)?;
        // A row from a later version, with a kind or outcome this one doesn't know, is left out.
        let (Some(kind), Some(outcome)) = (CallKind::parse(&kind), Outcome::parse(&outcome)) else {
            continue;
        };
        calls.push(Call {
            at_ms,
            kind,
            target,
            operation,
            duration_ms: from_sql_i64(duration_ms),
            code,
            outcome,
            slow_after_ms: from_sql_i64(slow_after_ms),
            slow,
        });
    }
    Ok((calls, cleared))
}

/// Hides every call so far. Only the latest Clear can be undone, so the calls an earlier
/// one hid are deleted now.
fn clear_calls(connection: &mut Connection, now_ms: i64) -> Result<ClearedCalls, String> {
    let failed = |error: rusqlite::Error| format!("Failed to clear diagnostics: {error}");
    let transaction = connection.transaction().map_err(failed)?;
    let previous = cleared_at(&transaction)?;
    if let Some(previous) = previous {
        transaction
            .execute("DELETE FROM diagnostic_calls WHERE at_ms <= ?1", params![previous])
            .map_err(failed)?;
    }
    let count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM diagnostic_calls WHERE at_ms >= ?1 AND at_ms <= ?2",
            params![shown_from(previous, now_ms), now_ms],
            |row| row.get(0),
        )
        .map_err(failed)?;
    set_cleared_at(&transaction, Some(now_ms))?;
    transaction.commit().map_err(failed)?;
    Ok(ClearedCalls { count: from_sql_i64(count), cleared_at_ms: now_ms, previous_cleared_at_ms: previous })
}

/// Shows again what the Clear at `cleared_at_ms` hid, unless the calls were cleared again since.
fn undo_clear(connection: &mut Connection, cleared_at_ms: i64, previous: Option<i64>) -> Result<(), String> {
    let failed = |error: rusqlite::Error| format!("Failed to bring diagnostics back: {error}");
    let transaction = connection.transaction().map_err(failed)?;
    if cleared_at(&transaction)? != Some(cleared_at_ms) {
        return Err("These calls were cleared again since, so they can't be brought back".into());
    }
    set_cleared_at(&transaction, previous)?;
    transaction.commit().map_err(failed)
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CallDiagnostics {
    calls: Vec<Call>,
    keep_days: i64,
    max_calls: usize,
    machine_slow_ms: u64,
    core_slow_ms: u64,
    cleared_at_ms: Option<i64>,
}

#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClearedCalls {
    count: u64,
    cleared_at_ms: i64,
    previous_cleared_at_ms: Option<i64>,
}

#[tauri::command]
pub(crate) async fn get_call_diagnostics() -> Result<CallDiagnostics, String> {
    run_usage_task(move || {
        let connection = open_usage_database()?;
        let (calls, cleared) = QUEUE.read(&connection, now_ms())?;
        Ok(CallDiagnostics {
            calls,
            keep_days: KEEP_DAYS,
            max_calls: MAX_CALLS,
            machine_slow_ms: MACHINE_SLOW_MS,
            core_slow_ms: CORE_SLOW_MS,
            cleared_at_ms: cleared,
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn clear_call_diagnostics() -> Result<ClearedCalls, String> {
    run_usage_task(move || {
        let _write_guard = lock_usage_writes();
        QUEUE.clear(&mut open_usage_database()?, now_ms())
    })
    .await
}

#[tauri::command]
pub(crate) async fn undo_clear_call_diagnostics(cleared_at_ms: i64, previous_cleared_at_ms: Option<i64>) -> Result<(), String> {
    run_usage_task(move || {
        let _write_guard = lock_usage_writes();
        undo_clear(&mut open_usage_database()?, cleared_at_ms, previous_cleared_at_ms)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const HOUR: i64 = 3_600_000;

    fn call(kind: CallKind, target: &str, operation: &str, at_ms: i64, duration_ms: u64, outcome: Outcome) -> Call {
        let slow_after_ms = if kind == CallKind::Core { CORE_SLOW_MS } else { MACHINE_SLOW_MS };
        Call::new(kind, target, operation.into(), Duration::from_millis(duration_ms), None, outcome, slow_after_ms, at_ms)
    }

    fn fine(target: &str, operation: &str, at_ms: i64) -> Call {
        call(CallKind::Machine, target, operation, at_ms, 400, Outcome::Ok)
    }

    fn stored(connection: &Connection) -> Vec<(i64, String, String, String)> {
        let mut statement = connection
            .prepare("SELECT at_ms, target, operation, outcome FROM diagnostic_calls ORDER BY at_ms, id")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    /// Every text and number in every row, and every column name, as one string to search.
    fn everything_stored(connection: &Connection) -> String {
        let mut statement = connection.prepare("SELECT * FROM diagnostic_calls").unwrap();
        let columns: Vec<String> = statement.column_names().iter().map(|name| name.to_string()).collect();
        let count = columns.len();
        let mut rows = statement.query([]).unwrap();
        let mut all = columns.join(" ");
        while let Some(row) = rows.next().unwrap() {
            for index in 0..count {
                let value: rusqlite::types::Value = row.get(index).unwrap();
                all.push_str(&format!(" {value:?}"));
            }
        }
        all
    }

    #[test]
    fn a_script_run_keeps_its_exit_code_and_whether_it_failed_timed_out_or_was_slow() {
        let ok = Command::new("sh").arg("-c").arg("exit 0").output().unwrap();
        let refused = Command::new("sh").arg("-c").arg("exit 255").output().unwrap();
        let quick = machine_call("ci-01", MachineOp::HealthCheck, Duration::from_millis(900), Some(&Ok(ok.clone())));
        assert_eq!((quick.code, quick.outcome, quick.slow), (Some(0), Outcome::Ok, false));
        assert_eq!((quick.kind, quick.target.as_str(), quick.operation.as_str()), (CallKind::Machine, "ci-01", "health check"));
        let slow = machine_call("ci-01", MachineOp::HealthCheck, Duration::from_millis(10_001), Some(&Ok(ok.clone())));
        assert!(slow.slow);
        // A scan gets longer before it's slow.
        let scan = machine_call("ci-01", MachineOp::ToolchainScan, Duration::from_secs(40), Some(&Ok(ok)));
        assert!(!scan.slow);
        let failed = machine_call("ci-01", MachineOp::HealthCheck, Duration::from_millis(30), Some(&Ok(refused)));
        assert_eq!((failed.code, failed.outcome, failed.slow), (Some(255), Outcome::Failed, false));
        let unstarted = machine_call("ci-01", MachineOp::SetupScan, Duration::ZERO, Some(&Err("Could not start ssh".into())));
        assert_eq!((unstarted.code, unstarted.outcome), (None, Outcome::Failed));
        // Running out of time is its own outcome, not a slow call.
        let timed_out = machine_call("ci-01", MachineOp::HealthCheck, Duration::from_secs(12), None);
        assert_eq!((timed_out.code, timed_out.outcome, timed_out.slow), (None, Outcome::TimedOut, false));
    }

    #[test]
    fn a_core_request_keeps_its_status_and_only_its_method_and_plain_path() {
        let listed = core_call("get", "/v0/management/auth-files", Duration::from_millis(80), CoreReply::Status(200));
        assert_eq!((listed.target.as_str(), listed.operation.as_str()), ("core", "GET /auth-files"));
        assert_eq!((listed.code, listed.outcome, listed.slow), (Some(200), Outcome::Ok, false));
        let refused = core_call("POST", "/v0/management/api-call", Duration::from_secs(4), CoreReply::Status(502));
        assert_eq!((refused.code, refused.outcome), (Some(502), Outcome::Failed));
        // Requests that wait on a provider get longer before they're slow.
        assert!(!core_call("POST", "/v0/management/api-call", Duration::from_secs(4), CoreReply::Status(200)).slow);
        assert!(core_call("GET", "/v0/management/config.yaml", Duration::from_secs(4), CoreReply::Status(200)).slow);
        assert_eq!(core_call("GET", "/", Duration::ZERO, CoreReply::TimedOut).outcome, Outcome::TimedOut);
        assert_eq!(core_call("GET", "/", Duration::ZERO, CoreReply::Unreachable).outcome, Outcome::Failed);

        assert_eq!(core_operation("GET", "/v0/management/model-definitions/codex"), "GET /model-definitions/codex");
        assert_eq!(core_operation("DELETE", "auth-files?name=cam@example.com.json"), "DELETE /auth-files");
        assert_eq!(core_operation("PATCH", "/v0/management/auth-files/cam%40example.com.json/fields"), "PATCH /auth-files/*/fields");
        assert_eq!(core_operation("GET", "/v0/management/api-keys/12345"), "GET /api-keys/*");
        assert_eq!(core_operation("GET", "/v0/management/keys/sk-AbC123dEf456"), "GET /keys/*");
        assert_eq!(core_operation("GET", "/v0/management/a/b/c/d/e/f"), "GET /a/b/c/d");
        assert_eq!(core_operation("GET ME", "/x"), "? /x");
    }

    #[test]
    fn calls_are_saved_and_read_back_newest_first_for_a_week() {
        let mut connection = crate::usage::schema::test_database();
        let now = 30 * 24 * HOUR;
        let calls = [
            fine("ci-01", "health check", now - 8 * 24 * HOUR),
            call(CallKind::Core, "core", "GET /auth-files", now - 2 * HOUR, 5_000, Outcome::Ok),
            call(CallKind::Machine, "ci-01", "setup scan", now - HOUR, 60_000, Outcome::TimedOut),
        ];
        write_calls(&mut connection, &calls, now).unwrap();
        let (read, cleared) = read_calls(&connection, now).unwrap();
        assert_eq!(cleared, None);
        // The one from eight days ago is gone.
        assert_eq!(read, vec![calls[2].clone(), calls[1].clone()]);
        assert!(read[1].slow);
    }

    #[test]
    fn the_table_keeps_the_latest_routine_calls_of_each_operation_and_problems_before_routine_ones() {
        let mut connection = crate::usage::schema::test_database();
        let now = 30 * 24 * HOUR;
        // A busy health check, a rare scan, and a few failures, all within the week.
        let mut calls: Vec<Call> = (0..ROUTINE_PER_OPERATION as i64 + 30).map(|at| fine("ci-01", "health check", now - HOUR + at)).collect();
        calls.push(fine("ci-01", "setup scan", now - 3 * HOUR));
        calls.extend((0..5).map(|at| call(CallKind::Machine, "ci-01", "health check", now - 2 * HOUR + at, 30, Outcome::Failed)));
        write_calls(&mut connection, &calls, now).unwrap();
        let rows = stored(&connection);
        let routine_checks = rows.iter().filter(|row| row.2 == "health check" && row.3 == "ok").count();
        assert_eq!(routine_checks, ROUTINE_PER_OPERATION);
        // The newest ones are the ones kept.
        assert!(rows.iter().filter(|row| row.2 == "health check" && row.3 == "ok").all(|row| row.0 >= now - HOUR + 30));
        assert_eq!(rows.iter().filter(|row| row.3 == "failed").count(), 5);
        assert_eq!(rows.iter().filter(|row| row.2 == "setup scan").count(), 1);

        // Past the cap, routine calls go before problems, however new they are.
        let mut connection = crate::usage::schema::test_database();
        let problems: Vec<Call> = (0..MAX_CALLS as i64 - 10)
            .map(|at| call(CallKind::Machine, &format!("machine-{at}"), "setup scan", now - 5 * HOUR + at, 20, Outcome::Failed))
            .collect();
        write_calls(&mut connection, &problems, now).unwrap();
        let routine: Vec<Call> = (0..40).map(|index| fine(&format!("machine-{index}"), "health check", now - index)).collect();
        write_calls(&mut connection, &routine, now).unwrap();
        let rows = stored(&connection);
        assert_eq!(rows.len(), MAX_CALLS);
        assert_eq!(rows.iter().filter(|row| row.3 == "failed").count(), MAX_CALLS - 10);
        // The ten newest routine calls stayed.
        assert!(rows.iter().filter(|row| row.3 == "ok").all(|row| row.0 > now - 10));
        // More problems than the cap: the oldest go.
        let more: Vec<Call> = (0..20).map(|at| call(CallKind::Core, "core", "GET /usage-queue", now - at, 20, Outcome::TimedOut)).collect();
        write_calls(&mut connection, &more, now).unwrap();
        let rows = stored(&connection);
        assert_eq!(rows.len(), MAX_CALLS);
        assert_eq!(rows.iter().filter(|row| row.3 == "ok").count(), 0);
        assert_eq!(rows.iter().filter(|row| row.3 == "timedOut").count(), 20);
        assert_eq!(rows.first().map(|row| row.0), Some(now - 5 * HOUR + 10));
    }

    #[test]
    fn an_operation_that_keeps_failing_keeps_only_its_latest_problems_so_others_stay() {
        let mut connection = crate::usage::schema::test_database();
        let now = 30 * 24 * HOUR;
        let minute = 60_000;
        // Earlier in the week: a setup scan that ran out of time, and two slow health checks.
        let mut calls = vec![
            call(CallKind::Machine, "cedar-02", "setup scan", now - 5 * 24 * HOUR, 60_000, Outcome::TimedOut),
            call(CallKind::Machine, "ci-01", "health check", now - 4 * 24 * HOUR, 12_000, Outcome::Ok),
            call(CallKind::Machine, "ci-01", "health check", now - 4 * 24 * HOUR + minute, 12_000, Outcome::Ok),
        ];
        // Then ci-01 asleep for two days, its health check failing every minute and now and then running out of time.
        calls.extend((0..2 * 24 * 60).map(|index| {
            let outcome = if index % 10 == 0 { Outcome::TimedOut } else { Outcome::Failed };
            call(CallKind::Machine, "ci-01", "health check", now - 2 * 24 * HOUR + index * minute, 30, outcome)
        }));
        write_calls(&mut connection, &calls, now).unwrap();
        let rows = stored(&connection);
        let count = |target: &str, outcome: &str| rows.iter().filter(|row| row.1 == target && row.3 == outcome).count();
        assert_eq!(count("ci-01", "failed"), PROBLEMS_PER_OPERATION);
        assert_eq!(count("ci-01", "timedOut"), PROBLEMS_PER_OPERATION);
        // The failures kept are the latest.
        assert!(rows.iter().filter(|row| row.3 == "failed").all(|row| row.0 > now - 3 * HOUR));
        // The slow checks and the other machine's scan are still there.
        assert_eq!(count("ci-01", "ok"), 2);
        assert_eq!(count("cedar-02", "timedOut"), 1);
    }

    /// A read copies the calls waiting and then reads the table, while a save takes the calls waiting and then
    /// commits them. Neither may fall between the other's two steps, or a call shows twice or not at all.
    #[test]
    fn a_read_finds_each_call_once_while_calls_are_being_saved() {
        use std::collections::HashSet;
        use std::sync::atomic::AtomicUsize;

        const CALLS: usize = 300;
        let root = std::env::temp_dir().join(format!("arbor-diagnostics-race-{}-{}", std::process::id(), now_ms()));
        let queue = Queue::new();
        let now = now_ms();
        let recorded = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                for index in 0..CALLS {
                    // A machine each, so none make way for newer routine calls.
                    queue.push(fine(&format!("machine-{index}"), "health check", now - HOUR + index as i64));
                    recorded.store(index + 1, Ordering::SeqCst);
                    if index % 7 == 0 {
                        std::thread::yield_now();
                    }
                }
            });
            scope.spawn(|| loop {
                let done = recorded.load(Ordering::SeqCst) == CALLS;
                queue.save(|| open_usage_database_at(&root), now).unwrap();
                if done && queue.is_empty() {
                    break;
                }
            });
            scope.spawn(|| {
                let connection = open_usage_database_at(&root).unwrap();
                let mut shown: HashSet<i64> = HashSet::new();
                loop {
                    let done = recorded.load(Ordering::SeqCst) == CALLS;
                    let (calls, _) = queue.read(&connection, now).unwrap();
                    let now_shown: HashSet<i64> = calls.iter().map(|call| call.at_ms).collect();
                    assert_eq!(now_shown.len(), calls.len(), "a call showed twice");
                    assert!(shown.is_subset(&now_shown), "a call shown before went missing");
                    shown = now_shown;
                    if done && shown.len() == CALLS {
                        break;
                    }
                }
            });
        });
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clear_hides_the_calls_so_far_undo_brings_them_back_and_a_second_clear_deletes_them() {
        let mut connection = crate::usage::schema::test_database();
        let now = 30 * 24 * HOUR;
        write_calls(&mut connection, &[fine("ci-01", "health check", now - 2 * HOUR), fine("ci-01", "setup scan", now - HOUR)], now).unwrap();
        let cleared = clear_calls(&mut connection, now).unwrap();
        assert_eq!(cleared, ClearedCalls { count: 2, cleared_at_ms: now, previous_cleared_at_ms: None });
        assert!(read_calls(&connection, now + 1).unwrap().0.is_empty());
        // What comes after shows.
        write_calls(&mut connection, &[fine("ci-01", "health check", now + 10)], now + 10).unwrap();
        assert_eq!(read_calls(&connection, now + 20).unwrap().0.len(), 1);

        undo_clear(&mut connection, cleared.cleared_at_ms, cleared.previous_cleared_at_ms).unwrap();
        let (calls, marker) = read_calls(&connection, now + 20).unwrap();
        assert_eq!((calls.len(), marker), (3, None));

        let first = clear_calls(&mut connection, now + 30).unwrap();
        let second = clear_calls(&mut connection, now + 40).unwrap();
        assert_eq!(second.previous_cleared_at_ms, Some(now + 30));
        // The first Clear's calls are gone for good, so it can't be undone any more.
        assert!(stored(&connection).is_empty());
        assert!(undo_clear(&mut connection, first.cleared_at_ms, first.previous_cleared_at_ms).is_err());
        undo_clear(&mut connection, second.cleared_at_ms, second.previous_cleared_at_ms).unwrap();
        assert_eq!(cleared_at(&connection).unwrap(), Some(now + 30));
    }

    /// SECRET: a script's text, its arguments and everything it prints stay out of the
    /// table, and so do a core request's query, file names and tokens.
    #[test]
    fn secret_arguments_output_and_request_details_never_reach_the_table() {
        const ARGUMENT: &str = "arbor-secret-argument-5b1e";
        const SCRIPT: &str = "echo arbor-secret-script-9c2d; echo arbor-secret-stderr-77aa >&2; exit 3";
        const OUTPUT: &str = "arbor-secret-script-9c2d";
        const STDERR: &str = "arbor-secret-stderr-77aa";
        let machine = "diagnostics-secret-test";
        let mut command = tokio::process::Command::new("sh");
        command
            .arg("-s")
            .arg(ARGUMENT)
            .env("ARBOR_SECRET_ENV", "arbor-secret-env-31f0")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let target = crate::usage::machine_health::shell::MachineCommand::named(command, machine);
        let output = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(crate::usage::machine_health::shell::run_on_machine(target, MachineOp::SetupScan, SCRIPT, Duration::from_secs(10)))
            .unwrap();
        // The script really ran and printed them.
        assert!(String::from_utf8_lossy(&output.stdout).contains(OUTPUT));
        assert!(String::from_utf8_lossy(&output.stderr).contains(STDERR));

        // Other tests run alongside, so only this test's machine is taken from the calls waiting.
        let mut calls: Vec<Call> = QUEUE.take().into_iter().filter(|call| call.target == machine).collect();
        assert_eq!(calls.len(), 1);
        calls.push(core_call(
            "GET",
            "/v0/management/auth-files/cam@example.com.json?token=sk-live-arbor-secret-token",
            Duration::from_millis(12),
            CoreReply::Status(401),
        ));
        let mut connection = crate::usage::schema::test_database();
        write_calls(&mut connection, &calls, now_ms()).unwrap();
        let all = everything_stored(&connection);
        assert!(all.contains("setup scan") && all.contains(machine) && all.contains("GET /auth-files/*"));
        for secret in [ARGUMENT, "arbor-secret-script", OUTPUT, STDERR, "arbor-secret-env", "exit 3", "cam@example.com", "sk-live", "token"] {
            assert!(!all.contains(secret), "{secret} reached the diagnostics table: {all}");
        }
        // Nor does it reach what the page reads.
        let (read, _) = read_calls(&connection, now_ms()).unwrap();
        let shown = serde_json::to_string(&read).unwrap();
        for secret in [ARGUMENT, OUTPUT, STDERR, "cam@example.com", "sk-live"] {
            assert!(!shown.contains(secret));
        }
    }
}

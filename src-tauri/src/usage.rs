mod resp;
#[cfg(test)]
mod bench;
pub(crate) mod antiburn;
pub(crate) mod capacity;
mod collector;
mod cost_groups;
mod database;
pub(crate) mod diagnostics;
pub(crate) mod digest;
pub(crate) mod fleet;
pub(crate) mod limit_history;
pub(crate) mod live;
pub(crate) mod machines;
pub(crate) mod machine_health;
pub(crate) mod machine_sessions;
mod pricing;
pub(crate) mod projects;
pub(crate) mod pull_requests;
mod schema;
mod session_filters;
mod session_read;
pub(crate) mod storage;

use super::executable_dir;
use super::{
    apply_configured_proxy, core_base_dir, current_core_status, format_management_request_error,
    management_authorization, management_endpoint, management_http_client, send_management,
    CoreProcessState, GuiConfigFile, GuiConfigState,
};
use chrono::{DateTime, Local};
use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Row,
    Transaction,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, MutexGuard, PoisonError},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;

use self::resp::UsageSubscription;
// The collector, the database's setup and pricing are their own files; everything that used them here still does.
pub(crate) use self::{collector::*, database::*, pricing::*};

const USAGE_UPDATED_EVENT: &str = "usage-records-updated";
const ACTIVE_SESSION_WINDOW_MS: i64 = 5 * 60_000;
/// A thread's context has to fall from at least this many tokens to count as compacted.
const COMPACTION_MIN_CONTEXT: u64 = 20_000;
/// How many of the requests after a drop in context are checked for the
/// conversation carrying on where it was, which makes the drop a side request.
const CONVERSATION_LOOKAHEAD: usize = 5;
/// The most requests a session timeline returns. A longer session shows its first ones.
const SESSION_TIMELINE_LIMIT: usize = 20_000;
/// How much of a failed request's response a session timeline keeps, in characters.
const SESSION_TIMELINE_FAILURE_CHARS: usize = 300;
const SESSION_LOOKUP_BATCH_SIZE: usize = 500;
const MAX_SESSION_ANCESTRY_ROUNDS: usize = 32;
/// Reads at once. Readers don't block each other in WAL mode, and the monitors
/// behind the live board and alerts read every few seconds, so a page opened
/// meanwhile needs slots of its own rather than a place in their queue.
const USAGE_QUERY_SLOT_COUNT: u32 = 4;
static USAGE_QUERY_SLOTS: tokio::sync::Semaphore =
    tokio::sync::Semaphore::const_new(USAGE_QUERY_SLOT_COUNT as usize);

/// Serializes writes to usage.db within the app, so retention batches and
/// compaction never run alongside a collector write. The collector waits out a
/// VACUUM instead of failing with SQLITE_BUSY and dropping records it has
/// already read from the core.
static USAGE_WRITE_LOCK: Mutex<()> = Mutex::new(());

fn lock_usage_writes() -> MutexGuard<'static, ()> {
    // The lock guards no data, so a poisoned lock is safe to keep using.
    USAGE_WRITE_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

async fn run_usage_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    run_usage_task_with_slots(1, task).await
}

/// Runs a task that needs usage.db to itself, such as compaction. It waits for
/// in-flight queries and holds every slot, so new queries queue behind it
/// instead of failing with SQLITE_BUSY or pinning the WAL it checkpoints.
async fn run_exclusive_usage_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    run_usage_task_with_slots(USAGE_QUERY_SLOT_COUNT, task).await
}

async fn run_usage_task_with_slots<T, F>(slots: u32, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let permit = USAGE_QUERY_SLOTS
        .acquire_many(slots)
        .await
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        task()
    })
    .await
    .map_err(|error| format!("Usage history background task failed: {error}"))?
}

#[derive(Clone, Default, Serialize, Deserialize, TS)]
struct UsageTokenStats {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    reasoning_tokens: u64,
    #[serde(default)]
    cache_read_tokens: u64,
    #[serde(default)]
    cache_creation_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
}

#[derive(Clone, Serialize, Deserialize, TS)]
pub(crate) struct UsageRecord {
    id: String,
    timestamp: String,
    #[serde(default)]
    latency_ms: u64,
    #[serde(default)]
    ttft_ms: Option<u64>,
    #[serde(default)]
    source: String,
    #[serde(default)]
    source_display: String,
    #[serde(default)]
    auth_index: String,
    #[serde(default)]
    failed: bool,
    #[serde(default)]
    canceled: bool,
    #[serde(default)]
    failure_status: u16,
    #[serde(default)]
    failure_body: String,
    #[serde(default)]
    provider: String,
    #[serde(default, skip_serializing)]
    api_group_key: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    alias: String,
    #[serde(default)]
    client_ip: Option<String>,
    #[serde(default)]
    x_forwarded_for: Option<String>,
    #[serde(default)]
    user_agent: Option<String>,
    #[serde(default)]
    machine: String,
    #[serde(default)]
    pool: String,
    #[serde(default)]
    reasoning_effort: String,
    #[serde(default)]
    service_tier: String,
    #[serde(default)]
    response_service_tier: String,
    #[serde(default)]
    executor_type: String,
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    auth_type: String,
    #[serde(default)]
    api_key_hash: String,
    #[serde(default)]
    api_key_display: String,
    #[serde(default)]
    api_key_remark: String,
    #[serde(default)]
    request_id: String,
    #[serde(default = "default_usage_generate", skip_serializing)]
    generate: bool,
    #[serde(default, skip_serializing)]
    cached_tokens: u64,
    #[serde(default, skip_serializing)]
    collector_source: String,
    #[serde(default)]
    tokens: UsageTokenStats,
    #[serde(skip)]
    lineage: UsageLineage,
}

/// Session and lineage fields the core attaches to each usage record: session
/// ids (7.2.156+), `response_model` (7.3.8) and the node kind, fork and
/// compaction flags (7.3.10). The sessions view reads the two session ids back
/// in SQL; nothing reads the other fields yet. None of them are part of the
/// records sent to the UI.
#[derive(Clone, Debug, Default, PartialEq)]
struct UsageLineage {
    session_id: Option<String>,
    parent_session_id: Option<String>,
    response_model: Option<String>,
    node_kind: Option<String>,
    is_fork: Option<bool>,
    is_compaction: Option<bool>,
}

impl UsageLineage {
    fn from_record(object: &serde_json::Map<String, Value>) -> Self {
        Self {
            session_id: string_field(object, "session_id"),
            parent_session_id: string_field(object, "parent_session_id"),
            response_model: string_field(object, "response_model"),
            node_kind: string_field(object, "node_kind"),
            is_fork: object.get("is_fork").and_then(Value::as_bool),
            is_compaction: object.get("is_compaction").and_then(Value::as_bool),
        }
    }

    fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

// Every field has a default, so the webview sends only the filters it uses.
#[derive(Clone, Default, Deserialize, TS)]
#[ts(optional_fields)]
pub(crate) struct UsageQuery {
    /// Requests sent with a key assigned to this machine. Sessions are matched
    /// whole, by where they ran: their key's machine, else where their
    /// transcript is.
    #[serde(default)]
    machine: Option<String>,
    #[serde(default)]
    pool: Option<String>,
    #[serde(default)]
    start: Option<String>,
    #[serde(default)]
    end: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    api_key_hash: Option<String>,
    /// Only requests sent with this credential, by its auth index.
    #[serde(default)]
    auth_index: Option<String>,
    /// Only requests to models whose name contains this, like "opus" for a
    /// limit that only counts Opus.
    #[serde(default)]
    model_family: Option<String>,
    #[serde(default)]
    failed: Option<bool>,
    #[serde(default)]
    canceled: Option<bool>,
    #[serde(default)]
    page: Option<usize>,
    #[serde(default)]
    page_size: Option<usize>,
    /// Matches this session and every session descended from it.
    #[serde(default)]
    session: Option<String>,
    /// Session list order: "recent" (the default), "cost", "tokens" or "requests".
    #[serde(default)]
    sort: Option<String>,
    /// Sessions only: words that each have to be somewhere in a session's
    /// title, project, folder, branch, pull requests, ids, client, machine or
    /// models.
    #[serde(default)]
    search: Option<String>,
    /// Sessions only: the project, as the Sessions page names it.
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    /// Sessions only: the client, as the Sessions page names it without its
    /// version, like "Claude Code" or "Codex CLI · AcmeDesk".
    #[serde(default)]
    client: Option<String>,
    /// Sessions only: "with" for sessions that opened or worked on a pull
    /// request, "without" for the rest.
    #[serde(default)]
    pull_requests: Option<String>,
    /// Sessions only: also count the sessions behind each choice in the
    /// filter menus.
    #[serde(default)]
    facets: Option<bool>,
    /// Requests only: the column the Requests list is ordered by, and which
    /// way. Newest first when unset.
    #[serde(default)]
    request_order: Option<UsageRequestOrder>,
}

/// A column the Requests list can be ordered by: the ones the database holds
/// as they're shown, so the order is the database's and every page follows on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum UsageRequestSortKey {
    Time,
    Input,
    Output,
    Cache,
    Reasoning,
    Total,
    Ttft,
    Latency,
}

#[derive(Clone, Copy, Debug, Deserialize, TS)]
pub(crate) struct UsageRequestOrder {
    by: UsageRequestSortKey,
    descending: bool,
}

impl UsageRequestOrder {
    /// The ORDER BY for this order. Ties, and requests with no time to first
    /// token, which sit last either way, fall back to newest first so a page
    /// never shuffles between loads.
    fn clause(order: Option<Self>) -> String {
        let Some(order) = order else {
            return "timestamp_ms DESC, id DESC".to_string();
        };
        let column = match order.by {
            UsageRequestSortKey::Time => "timestamp_ms",
            UsageRequestSortKey::Input => "input_tokens",
            UsageRequestSortKey::Output => "output_tokens",
            UsageRequestSortKey::Cache => "cache_read_tokens",
            UsageRequestSortKey::Reasoning => "reasoning_tokens",
            UsageRequestSortKey::Total => "total_tokens",
            UsageRequestSortKey::Ttft => "ttft_ms",
            UsageRequestSortKey::Latency => "latency_ms",
        };
        let direction = if order.descending { "DESC" } else { "ASC" };
        if order.by == UsageRequestSortKey::Time {
            return format!("timestamp_ms {direction}, id {direction}");
        }
        format!("{column} {direction} NULLS LAST, timestamp_ms DESC, id DESC")
    }
}

#[derive(Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageOverview {
    total_requests: u64,
    success_count: u64,
    failure_count: u64,
    canceled_count: u64,
    success_rate: f64,
    input_tokens: u64,
    output_tokens: u64,
    reasoning_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    total_tokens: u64,
    rpm: f64,
    tpm: f64,
    tps: f64,
    tps_sample_count: u64,
    average_latency_ms: f64,
    cache_hit_rate: f64,
    estimated_cost: f64,
    priced_requests: u64,
    timeline: Vec<UsageTimelinePoint>,
    machines: Vec<machines::MachineUsage>,
    machine_live: Vec<machines::MachineLive>,
}

#[derive(Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct UsageTimelinePoint {
    hour: String,
    /// When the hour's first request happened. `hour` is a label in the timezone the Mac had when
    /// the requests were recorded; this lets the chart place the hour after a timezone change.
    first_timestamp_ms: Option<i64>,
    requests: u64,
    success: u64,
    failure: u64,
    canceled: u64,
    tokens: u64,
}

#[derive(Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageAnalysis {
    models: Vec<UsageCategory>,
    providers: Vec<UsageCategory>,
    /// By the source text the core records, which the Source filter matches on.
    sources: Vec<UsageCategory>,
    accounts: Vec<UsageAccountCategory>,
    api_keys: Vec<UsageCategory>,
}

/// A range's requests by the credential that served them, found by the auth index each carries, so the Breakdown can
/// name each one with its account's profile: two credentials with one email (a Claude and a Codex sign-in) stay apart.
/// Requests with no index are counted under their source, as that's all there is to name them by.
#[derive(Clone, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct UsageAccountCategory {
    /// The credential's auth index, trimmed; empty for requests that carry none.
    auth_index: String,
    /// What the core calls the account (its email, or a masked key), for when no profile is found for the index.
    label: String,
    requests: u64,
    failures: u64,
    tokens: u64,
}

#[derive(Clone, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct UsageCategory {
    key: String,
    label: String,
    requests: u64,
    failures: u64,
    tokens: u64,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageEventPage {
    items: Vec<UsageRecord>,
    total: usize,
    page: usize,
    page_size: usize,
    total_pages: usize,
}

#[derive(Clone, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct UsageSessionTotals {
    started_at_ms: i64,
    last_active_at_ms: i64,
    requests: u64,
    failures: u64,
    canceled: u64,
    input_tokens: u64,
    output_tokens: u64,
    reasoning_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    total_tokens: u64,
    estimated_cost: f64,
    priced_requests: u64,
}

impl UsageSessionTotals {
    fn add(&mut self, other: &Self) {
        // An empty total takes the other's times instead of comparing with zero.
        if self.requests == 0 {
            self.started_at_ms = other.started_at_ms;
            self.last_active_at_ms = other.last_active_at_ms;
        } else {
            self.started_at_ms = self.started_at_ms.min(other.started_at_ms);
            self.last_active_at_ms = self.last_active_at_ms.max(other.last_active_at_ms);
        }
        self.requests = self.requests.saturating_add(other.requests);
        self.failures = self.failures.saturating_add(other.failures);
        self.canceled = self.canceled.saturating_add(other.canceled);
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.reasoning_tokens = self.reasoning_tokens.saturating_add(other.reasoning_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(other.cache_read_tokens);
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_add(other.cache_creation_tokens);
        self.total_tokens = self.total_tokens.saturating_add(other.total_tokens);
        self.estimated_cost += other.estimated_cost;
        self.priced_requests = self.priced_requests.saturating_add(other.priced_requests);
    }
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct UsageSessionThread {
    id: String,
    parent_id: Option<String>,
    depth: usize,
    models: Vec<String>,
    providers: Vec<String>,
    user_agent: Option<String>,
    #[serde(flatten)]
    totals: UsageSessionTotals,
    /// The largest context the thread's conversation reached, in input tokens.
    /// Like `compactions`, it covers the whole thread whatever the filters: a
    /// thread missing some of its requests would show drops that never happened.
    peak_context: u64,
    /// How often the thread's context was compacted. A session's own count is
    /// its main thread's.
    compactions: usize,
}

/// A root session. Its thread fields add up every thread in `threads`.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct UsageSession {
    #[serde(flatten)]
    root: UsageSessionThread,
    provider: String,
    machine: String,
    pool: String,
    api_key_hash: String,
    active: bool,
    has_own_requests: bool,
    subagents: usize,
    threads: Vec<UsageSessionThread>,
    /// Where the session ran and what it was called, from its transcript. None until one is found.
    transcript: Option<machine_health::transcripts::SessionTranscript>,
}

#[derive(Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct UsageSessionSummary {
    sessions: usize,
    subagent_threads: usize,
    active: usize,
    requests: u64,
    total_tokens: u64,
    estimated_cost: f64,
    /// Requests with a price. Without any, the cost isn't known.
    priced_requests: u64,
    untracked_requests: u64,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageSessionPage {
    items: Vec<UsageSession>,
    total: usize,
    page: usize,
    page_size: usize,
    total_pages: usize,
    summary: UsageSessionSummary,
    /// Only when the query asks for them.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    facets: Option<session_filters::SessionFacets>,
}

/// Every request of one session, its subagents' included, in the order they were made.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageSessionTimeline {
    /// The session as the list shows it, over its whole history. None when it has no requests.
    session: Option<UsageSession>,
    requests: Vec<UsageTimelineRequest>,
    /// True when the session has more than SESSION_TIMELINE_LIMIT requests and only the first are here.
    truncated: bool,
    /// For each model in the session with long-context rates, the input size they start above.
    long_context_thresholds: HashMap<String, u64>,
}

/// One request of a session, as `get_usage_session_timeline` returns it.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "SessionRequest")]
struct UsageTimelineRequest {
    timestamp_ms: i64,
    /// The session id the request was made in: the session's own, or a subagent's.
    thread_id: String,
    model: String,
    reasoning_effort: String,
    /// The tier the request was billed at.
    service_tier: String,
    latency_ms: i64,
    ttft_ms: Option<i64>,
    failed: bool,
    canceled: bool,
    failure_status: i64,
    /// The start of a failed request's response.
    failure: String,
    /// The request's context: cached tokens are counted in it.
    input_tokens: u64,
    output_tokens: u64,
    reasoning_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    /// None when neither the model nor its alias has a price.
    cost: Option<CostParts>,
    /// Billed at long-context rates.
    long_context: bool,
    /// Where the request sits in its thread's conversation. None when it
    /// carried no context, like a request that failed before it started.
    step: Option<ContextStep>,
}

/// How a request relates to the conversation in its thread, worked out from
/// context sizes alone: the proxy doesn't see the conversation itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
enum ContextStep {
    /// The conversation carrying on.
    Conversation,
    /// The context fell to under half and stayed down. Usually a compaction,
    /// though a rewind or context editing looks the same from here.
    Compacted,
    /// A request with a small context of its own, like Claude Code writing a
    /// title or summary, after which the conversation went on where it was.
    Side,
}

/// One session's requests for one set of pricing dimensions.
struct UsageSessionGroup {
    cost: UsageCostGroup,
    session_id: String,
    parent_session_id: Option<String>,
    started_at_ms: i64,
    last_active_at_ms: i64,
    failures: u64,
    canceled: u64,
    reasoning_tokens: u64,
    user_agent: Option<String>,
    api_key_hash: String,
}

/// A session's requests in one cost group, besides their tokens: what the sessions
/// query needs of them, folded in one pass rather than with SQL's MAX, MIN and SUM.
#[derive(Default)]
struct SessionGroupSums {
    parent_session_id: Option<String>,
    started_at_ms: Option<i64>,
    last_active_at_ms: Option<i64>,
    failures: i64,
    canceled: i64,
    reasoning_tokens: i64,
    user_agent: Option<String>,
    api_key_hash: Option<String>,
}

/// A session's groups folded together, before its place in a tree is known.
#[derive(Default)]
struct UsageSessionTally {
    parent_id: Option<String>,
    user_agent: Option<String>,
    api_key_hash: String,
    models: HashMap<String, u64>,
    providers: HashMap<String, u64>,
    totals: UsageSessionTotals,
}

struct UsageSqlFilter {
    clause: String,
    params: Vec<SqlValue>,
}

/// What a write did to the records.
#[derive(Clone, Copy, Debug, Default)]
struct RecordChanges {
    added: u64,
    removed: u64,
    /// Kept, with different numbers.
    rewritten: u64,
}

/// Moves the running record count and has open usage views and the storage
/// figures reload, together, after any write that changed the records.
fn publish_record_changes(app: &tauri::AppHandle, changes: RecordChanges) {
    if changes.added == 0 && changes.removed == 0 && changes.rewritten == 0 {
        return;
    }
    app.state::<UsageCollectorState>().adjust_total_records(changes);
    let send = |app: &tauri::AppHandle| {
        let _ = app.emit(USAGE_UPDATED_EVENT, Local::now().to_rfc3339());
    };
    let decision = lock_usage_event_gate().pass(std::time::Instant::now());
    match decision {
        UsageEventSend::Now => send(app),
        UsageEventSend::After(wait) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(wait).await;
                lock_usage_event_gate().sent_late(std::time::Instant::now());
                send(&app);
            });
        }
        UsageEventSend::AlreadyDue => {}
    }
}

/// A busy proxy saves a record or more per request, and every open view and
/// background monitor reloads on the event, so it goes out at most once
/// a second: the first change at once, the rest together once the second is up.
const USAGE_EVENT_SPACING: Duration = Duration::from_secs(1);

static USAGE_EVENT_GATE: Mutex<UsageEventGate> = Mutex::new(UsageEventGate { last_sent: None, due: false });

fn lock_usage_event_gate() -> MutexGuard<'static, UsageEventGate> {
    // The gate only spaces events out, so a poisoned one is fine to keep using.
    USAGE_EVENT_GATE.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Debug, PartialEq)]
enum UsageEventSend {
    Now,
    After(Duration),
    /// One is already waiting to go out, and it'll cover this change too.
    AlreadyDue,
}

struct UsageEventGate {
    last_sent: Option<std::time::Instant>,
    due: bool,
}

impl UsageEventGate {
    fn pass(&mut self, now: std::time::Instant) -> UsageEventSend {
        if self.due {
            return UsageEventSend::AlreadyDue;
        }
        match self.last_sent.map(|last| now.saturating_duration_since(last)) {
            Some(since) if since < USAGE_EVENT_SPACING => {
                self.due = true;
                UsageEventSend::After(USAGE_EVENT_SPACING - since)
            }
            _ => {
                self.last_sent = Some(now);
                UsageEventSend::Now
            }
        }
    }

    fn sent_late(&mut self, now: std::time::Instant) {
        self.due = false;
        self.last_sent = Some(now);
    }
}

fn build_usage_filter(query: &UsageQuery) -> UsageSqlFilter {
    let mut clauses = Vec::<String>::new();
    let mut params = Vec::<SqlValue>::new();
    for (column, value) in [("machine", &query.machine), ("pool", &query.pool)] {
        if let Some(value) = value.as_deref().filter(|v| !v.is_empty()) {
            if value == "__unassigned__" {
                clauses.push(format!("api_key_hash NOT IN (SELECT api_key_hash FROM usage_machine_assignments WHERE {column} != '')"));
            } else {
                clauses.push(format!("api_key_hash IN (SELECT api_key_hash FROM usage_machine_assignments WHERE {column} = ?)"));
                params.push(SqlValue::Text(value.to_string()));
            }
        }
    }
    if let Some(start) = query.start.as_deref().and_then(parse_timestamp_millis) {
        clauses.push("timestamp_ms >= ?".to_string());
        params.push(SqlValue::Integer(start));
    }
    if let Some(end) = query.end.as_deref().and_then(parse_timestamp_millis) {
        clauses.push("timestamp_ms <= ?".to_string());
        params.push(SqlValue::Integer(end));
    }
    add_text_filter(&mut clauses, &mut params, "model", query.model.as_deref());
    add_text_filter(
        &mut clauses,
        &mut params,
        "provider",
        query.provider.as_deref(),
    );
    add_text_filter(&mut clauses, &mut params, "source", query.source.as_deref());
    add_text_filter(
        &mut clauses,
        &mut params,
        "auth_index",
        query.auth_index.as_deref(),
    );
    if let Some(family) = query
        .model_family
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        clauses.push("instr(LOWER(model), ?) > 0".to_string());
        params.push(SqlValue::Text(family.to_lowercase()));
    }
    if query.api_key_hash.as_deref() == Some("__unrecorded_api_key__") {
        clauses.push("COALESCE(TRIM(api_key_hash), '') = ''".to_string());
    } else {
        add_text_filter(
            &mut clauses,
            &mut params,
            "api_key_hash",
            query.api_key_hash.as_deref(),
        );
    }
    if let Some(canceled) = query.canceled {
        clauses.push("canceled = ?".to_string());
        params.push(SqlValue::Integer(i64::from(canceled)));
    }
    if let Some(failed) = query.failed {
        if failed {
            // The + keeps SQLite off the canceled index, which nearly every request matches, so it reads
            // idx_usage_events_failures instead.
            clauses.push("failed != 0 AND +canceled = 0".to_string());
        } else {
            clauses.push("failed = 0".to_string());
        }
    }
    if let Some(session) = query
        .session
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        // UNION rather than UNION ALL, so a cycle in the parent links ends the
        // walk. Each step is a lookup in idx_usage_events_parent_session.
        clauses.push(
            "session_id IN (WITH RECURSIVE session_tree(id) AS (SELECT ? UNION SELECT e.session_id FROM usage_events e JOIN session_tree t ON e.parent_session_id = t.id WHERE e.session_id IS NOT NULL) SELECT id FROM session_tree)"
                .to_string(),
        );
        params.push(SqlValue::Text(session.to_string()));
    }
    UsageSqlFilter {
        clause: if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        },
        params,
    }
}

fn add_text_filter(
    clauses: &mut Vec<String>,
    params: &mut Vec<SqlValue>,
    column: &str,
    value: Option<&str>,
) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        clauses.push(format!("{column} = ? COLLATE NOCASE"));
        params.push(SqlValue::Text(value.to_string()));
    }
}

#[tauri::command]
pub(crate) async fn get_usage_overview(query: UsageQuery) -> Result<UsageOverview, String> {
    run_usage_task(move || load_usage_overview(&open_usage_database()?, &query)).await
}

fn load_usage_overview(
    connection: &Connection,
    query: &UsageQuery,
) -> Result<UsageOverview, String> {
    let filter = build_usage_filter(query);
    // One pass over the requests makes the totals, the hourly trend, the
    // machines and the cost groups, rather than one read of the range for each,
    // grouped in SQL, which sorts every request first.
    let mut totals = OverviewSums::default();
    let mut hours = HashMap::<String, HourSums>::new();
    let mut by_key = HashMap::<String, machines::KeyUsage>::new();
    let groups = cost_groups::fold_cost_rows::<()>(
        connection,
        &[],
        "failed != 0, canceled != 0, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, \
         cache_creation_tokens, total_tokens, latency_ms, generate != 0, ttft_ms, timestamp_ms, local_hour, api_key_hash, timestamp",
        &filter,
        |_, row, at| {
            let failed: bool = row.get(at)?;
            let canceled: bool = row.get(at + 1)?;
            let output: i64 = row.get(at + 3)?;
            let total: i64 = row.get(at + 7)?;
            let latency: i64 = row.get(at + 8)?;
            let ttft: Option<i64> = row.get(at + 10)?;
            let timestamp_ms: i64 = row.get(at + 11)?;
            totals.requests += 1;
            totals.success += i64::from(!failed);
            totals.failure += i64::from(failed && !canceled);
            totals.canceled += i64::from(canceled);
            for (sum, column) in totals.tokens.iter_mut().zip([2, 3, 4, 5, 6, 7]) {
                *sum = sum.saturating_add(row.get(at + column)?);
            }
            totals.latency = totals.latency.saturating_add(latency);
            // Output speed counts only generated, finished requests whose first token came before the end.
            if let Some(ttft) = ttft.filter(|&ttft| {
                ttft > 0 && latency > ttft && output > 0 && !failed && !canceled
            }) {
                if row.get::<_, bool>(at + 9)? {
                    totals.tps_output = totals.tps_output.saturating_add(output);
                    totals.tps_time = totals.tps_time.saturating_add(latency - ttft);
                    totals.tps_samples += 1;
                }
            }
            totals.first_ms = Some(totals.first_ms.map_or(timestamp_ms, |first| first.min(timestamp_ms)));
            totals.last_ms = Some(totals.last_ms.map_or(timestamp_ms, |last| last.max(timestamp_ms)));
            let hour = row.get_ref(at + 12)?.as_str()?;
            if !hours.contains_key(hour) {
                hours.insert(hour.to_string(), HourSums::default());
            }
            if let Some(sums) = hours.get_mut(hour) {
                sums.requests += 1;
                sums.success += i64::from(!failed);
                sums.failure += i64::from(failed && !canceled);
                sums.canceled += i64::from(canceled);
                sums.tokens = sums.tokens.saturating_add(total);
                if timestamp_ms > 0 {
                    sums.first_ms = Some(sums.first_ms.map_or(timestamp_ms, |first| first.min(timestamp_ms)));
                }
            }
            machines::key_usage(&mut by_key, row.get_ref(at + 13)?.as_str()?).add(total, failed, canceled, row.get_ref(at + 14)?);
            Ok(())
        },
    )?;
    let prices = load_model_prices(connection)?;
    let (estimated_cost, priced_requests) =
        sum_usage_cost(&groups.into_iter().map(|group| group.cost).collect::<Vec<_>>(), &prices);
    let mut timeline = hours
        .into_iter()
        .map(|(hour, sums)| UsageTimelinePoint {
            hour,
            first_timestamp_ms: sums.first_ms,
            requests: from_sql_i64(sums.requests),
            success: from_sql_i64(sums.success),
            failure: from_sql_i64(sums.failure),
            canceled: from_sql_i64(sums.canceled),
            tokens: from_sql_i64(sums.tokens),
        })
        .collect::<Vec<_>>();
    timeline.sort_by(|left, right| left.hour.cmp(&right.hour));
    let [input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens, total_tokens] =
        totals.tokens.map(from_sql_i64);

    let mut overview = UsageOverview {
        total_requests: from_sql_i64(totals.requests),
        success_count: from_sql_i64(totals.success),
        failure_count: from_sql_i64(totals.failure),
        canceled_count: from_sql_i64(totals.canceled),
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        total_tokens,
        estimated_cost,
        priced_requests,
        timeline,
        machines: machines::usage_by_machine(connection, by_key)?,
        machine_live: machines::live_usage(connection, query, Local::now().timestamp_millis())?,
        ..UsageOverview::default()
    };
    if overview.total_requests > 0 {
        let completed_requests = overview
            .success_count
            .saturating_add(overview.failure_count);
        if completed_requests > 0 {
            overview.success_rate =
                overview.success_count as f64 * 100.0 / completed_requests as f64;
        }
        overview.average_latency_ms =
            from_sql_i64(totals.latency) as f64 / overview.total_requests as f64;
        overview.tps = if totals.tps_time == 0 {
            0.0
        } else {
            totals.tps_output as f64 * 1000.0 / totals.tps_time as f64
        };
        overview.tps_sample_count = from_sql_i64(totals.tps_samples);
        if overview.input_tokens > 0 {
            overview.cache_hit_rate =
                (overview.cache_read_tokens as f64 / overview.input_tokens as f64).min(1.0);
        }
        let minutes = query_window_minutes(query, totals.first_ms, totals.last_ms);
        overview.rpm = overview.total_requests as f64 / minutes;
        overview.tpm = overview.total_tokens as f64 / minutes;
    }
    Ok(overview)
}

/// What the overview adds up over its requests, signed until the end as SQL's SUM kept them.
#[derive(Default)]
struct OverviewSums {
    requests: i64,
    success: i64,
    failure: i64,
    canceled: i64,
    /// Input, output, reasoning, cache read, cache creation and total tokens.
    tokens: [i64; 6],
    latency: i64,
    tps_output: i64,
    tps_time: i64,
    tps_samples: i64,
    first_ms: Option<i64>,
    last_ms: Option<i64>,
}

/// One hour of the overview's trend.
#[derive(Default)]
struct HourSums {
    requests: i64,
    success: i64,
    failure: i64,
    canceled: i64,
    tokens: i64,
    first_ms: Option<i64>,
}

#[tauri::command]
pub(crate) async fn get_usage_analysis(
    query: UsageQuery,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<UsageAnalysis, String> {
    let config = gui_config_state.snapshot()?;
    run_usage_task(move || load_usage_analysis(&open_usage_database()?, &query, &config)).await
}

fn load_usage_analysis(
    connection: &Connection,
    query: &UsageQuery,
    config: &GuiConfigFile,
) -> Result<UsageAnalysis, String> {
    let filter = build_usage_filter(query);
    // Each request is added to its four categories here. Grouping in SQL
    // first sorts every request on four text columns, which over a long
    // range takes several times as long as reading them.
    let sql = format!(
        "SELECT model, provider, source, api_key_hash, api_key_remark, api_key_display,
             failed != 0 AND canceled = 0, total_tokens, auth_index
         FROM usage_events{}",
        filter.clause
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare usage analytics query: {error}"))?;
    let mut rows = statement
        .query(params_from_iter(filter.params.iter()))
        .map_err(|error| format!("Failed to query usage analytics: {error}"))?;
    const UNNAMED: [&str; 4] = ["unknown", "Unknown provider", "Unknown source", "__unrecorded_api_key__"];
    let mut categories: [HashMap<String, UsageCategory>; 4] = Default::default();
    let mut key_labels = HashMap::<String, (String, String)>::new();
    // Credentials by auth index, then requests with none by their source. Each keeps its raw source as its label
    // until the end, the greatest when a credential's requests carry more than one, so the label doesn't depend on
    // the order rows are read in.
    let mut by_index = HashMap::<String, UsageAccountCategory>::new();
    let mut by_source = HashMap::<String, UsageAccountCategory>::new();
    let read_result = (|| -> rusqlite::Result<()> {
        while let Some(row) = rows.next()? {
            let failures = u64::from(row.get::<_, i64>(6)? != 0);
            let tokens = from_sql_i64(row.get(7)?);
            let source = sql_trim(row.get_ref(2)?.as_str()?);
            let index = sql_trim(row.get_ref(8)?.as_str()?);
            let (group, key) = if index.is_empty() { (&mut by_source, source) } else { (&mut by_index, index) };
            if !group.contains_key(key) {
                group.insert(
                    key.to_string(),
                    UsageAccountCategory { auth_index: index.to_string(), ..UsageAccountCategory::default() },
                );
            }
            if let Some(account) = group.get_mut(key) {
                if source > account.label.as_str() {
                    account.label = source.to_string();
                }
                account.requests = account.requests.saturating_add(1);
                account.failures = account.failures.saturating_add(failures);
                account.tokens = account.tokens.saturating_add(tokens);
            }
            for (index, group) in categories.iter_mut().enumerate() {
                let key = Some(sql_trim(row.get_ref(index)?.as_str()?)).filter(|key| !key.is_empty()).unwrap_or(UNNAMED[index]);
                if index == 3 {
                    let remark = sql_trim(row.get_ref(4)?.as_str()?);
                    let display = sql_trim(row.get_ref(5)?.as_str()?);
                    if !key_labels.contains_key(key) {
                        key_labels.insert(key.to_string(), Default::default());
                    }
                    if let Some(labels) = key_labels.get_mut(key) {
                        if remark > labels.0.as_str() {
                            labels.0 = remark.to_string();
                        }
                        if display > labels.1.as_str() {
                            labels.1 = display.to_string();
                        }
                    }
                }
                if !group.contains_key(key) {
                    group.insert(
                        key.to_string(),
                        UsageCategory { key: key.to_string(), label: key.to_string(), ..UsageCategory::default() },
                    );
                }
                if let Some(category) = group.get_mut(key) {
                    category.requests = category.requests.saturating_add(1);
                    category.failures = category.failures.saturating_add(failures);
                    category.tokens = category.tokens.saturating_add(tokens);
                }
            }
        }
        Ok(())
    })();
    read_result.map_err(|error| format!("Failed to read usage analytics: {error}"))?;
    let [models, providers, sources, api_keys] = categories.map(sorted_usage_categories);
    let sources = sources
        .into_iter()
        .map(|mut category| {
            category.label = usage_source_display(config, "", &category.key);
            category
        })
        .collect();
    let api_keys = api_keys
        .into_iter()
        .map(|mut category| {
            let (remark, display) = key_labels.remove(&category.key).unwrap_or_default();
            category.label = api_key_category_label(remark, display);
            category
        })
        .collect();
    let mut accounts: Vec<_> = by_index
        .into_values()
        .chain(by_source.into_values())
        .map(|mut account| {
            account.label = usage_source_display(config, "", &account.label);
            account
        })
        .collect();
    accounts.sort_by(|left, right| {
        right
            .tokens
            .cmp(&left.tokens)
            .then_with(|| right.requests.cmp(&left.requests))
            .then_with(|| left.auth_index.cmp(&right.auth_index))
            .then_with(|| left.label.cmp(&right.label))
    });
    Ok(UsageAnalysis {
        models,
        providers,
        sources,
        accounts,
        api_keys,
    })
}

/// `text` as SQLite's one-argument TRIM leaves it: without spaces at either end, and nothing else taken off.
fn sql_trim(text: &str) -> &str {
    text.trim_matches(' ')
}

fn sorted_usage_categories(categories: HashMap<String, UsageCategory>) -> Vec<UsageCategory> {
    let mut categories: Vec<_> = categories.into_values().collect();
    categories.sort_by(|left, right| {
        right
            .tokens
            .cmp(&left.tokens)
            .then_with(|| right.requests.cmp(&left.requests))
            .then_with(|| left.key.cmp(&right.key))
    });
    categories
}

#[cfg(test)]
fn load_source_categories(
    connection: &Connection,
    query: &UsageQuery,
    config: &GuiConfigFile,
) -> Result<Vec<UsageCategory>, String> {
    let mut categories = load_simple_categories(connection, query, "source", "Unknown source")?;
    for category in &mut categories {
        category.label = usage_source_display(config, "", &category.key);
    }
    Ok(categories)
}

#[cfg(test)]
fn load_simple_categories(
    connection: &Connection,
    query: &UsageQuery,
    column: &str,
    fallback: &str,
) -> Result<Vec<UsageCategory>, String> {
    let filter = build_usage_filter(query);
    let sql = format!(
        r#"
        SELECT
            COALESCE(NULLIF(TRIM({column}), ''), ?),
            COUNT(*),
            COALESCE(SUM(CASE WHEN failed != 0 AND canceled = 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(total_tokens), 0)
        FROM usage_events{}
        GROUP BY 1
        ORDER BY 4 DESC, 2 DESC
        "#,
        filter.clause
    );
    let mut values = Vec::with_capacity(filter.params.len() + 1);
    values.push(SqlValue::Text(fallback.to_string()));
    values.extend(filter.params);
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare SQLite usage analytics query: {error}"))?;
    let categories = statement
        .query_map(params_from_iter(values.iter()), |row| {
            let key = row.get::<_, String>(0)?;
            Ok(UsageCategory {
                label: key.clone(),
                key,
                requests: from_sql_i64(row.get(1)?),
                failures: from_sql_i64(row.get(2)?),
                tokens: from_sql_i64(row.get(3)?),
            })
        })
        .map_err(|error| format!("Failed to query SQLite usage analytics: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read SQLite usage analytics: {error}"))?;
    Ok(categories)
}

#[cfg(test)]
fn load_api_key_categories(
    connection: &Connection,
    query: &UsageQuery,
) -> Result<Vec<UsageCategory>, String> {
    let filter = build_usage_filter(query);
    let sql = format!(
        r#"
        SELECT
            COALESCE(NULLIF(TRIM(api_key_hash), ''), '__unrecorded_api_key__'),
            MAX(TRIM(api_key_remark)),
            MAX(TRIM(api_key_display)),
            COUNT(*),
            COALESCE(SUM(CASE WHEN failed != 0 AND canceled = 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(total_tokens), 0)
        FROM usage_events{}
        GROUP BY 1
        ORDER BY 6 DESC, 4 DESC
        "#,
        filter.clause
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare SQLite API Key usage analytics query: {error}"))?;
    let categories = statement
        .query_map(params_from_iter(filter.params.iter()), |row| {
            let key = row.get::<_, String>(0)?;
            let remark = row.get::<_, String>(1)?;
            let display = row.get::<_, String>(2)?;
            let label = api_key_category_label(remark, display);
            Ok(UsageCategory {
                key,
                label,
                requests: from_sql_i64(row.get(3)?),
                failures: from_sql_i64(row.get(4)?),
                tokens: from_sql_i64(row.get(5)?),
            })
        })
        .map_err(|error| format!("Failed to query SQLite API Key usage analytics: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read SQLite API Key usage analytics: {error}"))?;
    Ok(categories)
}

#[tauri::command]
pub(crate) async fn get_usage_events(
    query: UsageQuery,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<UsageEventPage, String> {
    let config = gui_config_state.snapshot()?;
    run_usage_task(move || load_usage_events(&open_usage_database()?, &query, &config)).await
}

fn load_usage_events(
    connection: &Connection,
    query: &UsageQuery,
    config: &GuiConfigFile,
) -> Result<UsageEventPage, String> {
    let assignments = machines::load_assignments(connection, config)?;
    let filter = build_usage_filter(query);
    let total_sql = format!("SELECT COUNT(*) FROM usage_events{}", filter.clause);
    let total = connection
        .query_row(&total_sql, params_from_iter(filter.params.iter()), |row| {
            row.get::<_, i64>(0)
        })
        .map(from_sql_i64)
        .map_err(|error| format!("Failed to count SQLite usage events: {error}"))?
        .min(usize::MAX as u64) as usize;
    let page_size = query.page_size.unwrap_or(50).clamp(20, 200);
    let total_pages = total.div_ceil(page_size).max(1);
    let page = query.page.unwrap_or(1).clamp(1, total_pages);
    let offset = (page - 1).saturating_mul(page_size);

    let sql = format!(
        r#"
        SELECT
            CAST(id AS TEXT), timestamp, latency_ms, ttft_ms, source, auth_index, failed,
            provider, model, alias, reasoning_effort, service_tier,
            response_service_tier, executor_type, endpoint, auth_type,
            api_key_hash, api_key_display, api_key_remark, request_id,
            api_group_key, client_ip, x_forwarded_for, user_agent, generate,
            cached_tokens, collector_source,
            input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
            cache_creation_tokens, total_tokens, canceled, failure_status,
            failure_body
        FROM usage_events{}
        ORDER BY {}
        LIMIT ? OFFSET ?
        "#,
        filter.clause,
        UsageRequestOrder::clause(query.request_order),
    );
    let mut values = filter.params;
    values.push(SqlValue::Integer(page_size as i64));
    values.push(SqlValue::Integer(offset.min(i64::MAX as usize) as i64));
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare SQLite usage event query: {error}"))?;
    let mut items = statement
        .query_map(params_from_iter(values.iter()), usage_record_from_row)
        .map_err(|error| format!("Failed to query SQLite usage events: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read SQLite usage events: {error}"))?;
    for item in &mut items {
        item.source_display = usage_source_display(config, &item.provider, &item.source);
        if let Some(assignment) = assignments.iter().find(|a| a.api_key_hash == item.api_key_hash) {
            item.machine = assignment.machine.clone();
            item.pool = assignment.pool.clone();
        }
    }
    Ok(UsageEventPage {
        items,
        total,
        page,
        page_size,
        total_pages,
    })
}

fn usage_record_from_row(row: &Row<'_>) -> rusqlite::Result<UsageRecord> {
    Ok(UsageRecord {
        id: row.get(0)?,
        timestamp: row.get(1)?,
        latency_ms: from_sql_i64(row.get(2)?),
        ttft_ms: row.get::<_, Option<i64>>(3)?.map(from_sql_i64),
        source: row.get(4)?,
        source_display: String::new(),
        auth_index: row.get(5)?,
        failed: row.get::<_, i64>(6)? != 0,
        canceled: row.get::<_, i64>(33)? != 0,
        failure_status: row.get::<_, i64>(34)?.clamp(0, u16::MAX as i64) as u16,
        failure_body: row.get(35)?,
        provider: row.get(7)?,
        api_group_key: row.get(20)?,
        model: row.get(8)?,
        alias: row.get(9)?,
        client_ip: row.get(21)?,
        machine: String::new(),
        pool: String::new(),
        x_forwarded_for: row.get(22)?,
        user_agent: row.get(23)?,
        reasoning_effort: row.get(10)?,
        service_tier: row.get(11)?,
        response_service_tier: row.get(12)?,
        executor_type: row.get(13)?,
        endpoint: row.get(14)?,
        auth_type: row.get(15)?,
        api_key_hash: row.get(16)?,
        api_key_display: row.get(17)?,
        api_key_remark: row.get(18)?,
        request_id: row.get(19)?,
        generate: row.get::<_, i64>(24)? != 0,
        cached_tokens: from_sql_i64(row.get(25)?),
        collector_source: row.get(26)?,
        tokens: UsageTokenStats {
            input_tokens: from_sql_i64(row.get(27)?),
            output_tokens: from_sql_i64(row.get(28)?),
            reasoning_tokens: from_sql_i64(row.get(29)?),
            cache_read_tokens: from_sql_i64(row.get(30)?),
            cache_creation_tokens: from_sql_i64(row.get(31)?),
            total_tokens: from_sql_i64(row.get(32)?),
        },
        lineage: UsageLineage::default(),
    })
}

#[tauri::command]
pub(crate) async fn get_usage_sessions(
    query: UsageQuery,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<UsageSessionPage, String> {
    let config = gui_config_state.snapshot()?;
    run_usage_task(move || {
        let connection = open_usage_database()?;
        load_usage_sessions(
            &connection,
            &query,
            &config,
            Local::now().timestamp_millis(),
        )
    })
    .await
}

/// Groups the requests matching the query into root sessions, each with the
/// subagent threads descended from it.
fn load_usage_sessions(
    connection: &Connection,
    query: &UsageQuery,
    config: &GuiConfigFile,
    now_ms: i64,
) -> Result<UsageSessionPage, String> {
    let filters = session_filters::SessionFilters::from_query(query);
    let untracked_requests = if filters.narrows_beyond_requests() {
        // Nothing says which project, client or pull request those were for.
        0
    } else {
        let untracked = usage_filter_and(
            &build_usage_filter(query),
            "(session_id IS NULL OR session_id = '')",
        );
        connection
            .query_row(
                &format!("SELECT COUNT(*) FROM usage_events{}", untracked.clause),
                params_from_iter(untracked.params.iter()),
                |row| row.get::<_, i64>(0),
            )
            .map(from_sql_i64)
            .map_err(|error| format!("Failed to count usage records without a session: {error}"))?
    };
    let session_read::SelectedSessions { sessions, facets } = session_read::select_sessions(
        connection,
        config,
        now_ms,
        &session_read::SessionSelect {
            query,
            only_active: false,
            order: session_read::SessionOrder::named(query.sort.as_deref()),
            limit: None,
            transcripts: false,
        },
    )?;

    let mut summary = UsageSessionSummary {
        sessions: sessions.len(),
        untracked_requests,
        ..UsageSessionSummary::default()
    };
    for session in &sessions {
        summary.subagent_threads += session.subagents;
        summary.active += usize::from(session.active);
        summary.requests = summary
            .requests
            .saturating_add(session.root.totals.requests);
        summary.total_tokens = summary
            .total_tokens
            .saturating_add(session.root.totals.total_tokens);
        summary.estimated_cost += session.root.totals.estimated_cost;
        summary.priced_requests = summary
            .priced_requests
            .saturating_add(session.root.totals.priced_requests);
    }

    let total = sessions.len();
    let page_size = query.page_size.unwrap_or(50).clamp(20, 200);
    let total_pages = total.div_ceil(page_size).max(1);
    let page = query.page.unwrap_or(1).clamp(1, total_pages);
    let mut items = sessions
        .into_iter()
        .skip((page - 1).saturating_mul(page_size))
        .take(page_size)
        .collect::<Vec<_>>();
    session_read::complete_sessions(connection, &mut items)?;
    Ok(UsageSessionPage {
        items,
        total,
        page,
        page_size,
        total_pages,
        summary,
        facets,
    })
}

/// Follows a thread's conversation through the context sizes of its requests
/// (input tokens, cached ones included), in order. A drop to under half of a
/// context of at least COMPACTION_MIN_CONTEXT is a compaction, unless one of
/// the next CONVERSATION_LOOKAHEAD requests is back near where the context
/// was: then the drop was a side request and the conversation hasn't moved.
fn follow_conversation(contexts: &[u64]) -> Vec<ContextStep> {
    let mut steps = Vec::with_capacity(contexts.len());
    let mut current: Option<u64> = None;
    for (index, &context) in contexts.iter().enumerate() {
        let step = match current {
            Some(before) if before >= COMPACTION_MIN_CONTEXT && context < before / 2 => {
                let resumes = contexts[index + 1..]
                    .iter()
                    .take(CONVERSATION_LOOKAHEAD)
                    .any(|&next| next.saturating_mul(10) >= before.saturating_mul(6));
                if resumes {
                    ContextStep::Side
                } else {
                    ContextStep::Compacted
                }
            }
            _ => ContextStep::Conversation,
        };
        if step != ContextStep::Side {
            current = Some(context);
        }
        steps.push(step);
    }
    steps
}

#[tauri::command]
pub(crate) async fn get_usage_session_timeline(
    session: String,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<UsageSessionTimeline, String> {
    let config = gui_config_state.snapshot()?;
    run_usage_task(move || {
        load_usage_session_timeline(
            &open_usage_database()?,
            &session,
            &config,
            Local::now().timestamp_millis(),
        )
    })
    .await
}

/// A session's requests for its detail view: the whole session, whatever the
/// Sessions list is filtered to, each with its cost and its step in its thread's
/// conversation.
fn load_usage_session_timeline(
    connection: &Connection,
    session: &str,
    config: &GuiConfigFile,
    now_ms: i64,
) -> Result<UsageSessionTimeline, String> {
    let query = UsageQuery {
        session: Some(session.to_string()),
        ..UsageQuery::default()
    };
    let mut sessions = session_read::select_sessions(
        connection,
        config,
        now_ms,
        &session_read::SessionSelect {
            query: &query,
            only_active: false,
            order: session_read::SessionOrder::Recent,
            limit: Some(1),
            transcripts: false,
        },
    )?
    .sessions;
    session_read::complete_sessions(connection, &mut sessions)?;
    let summary = sessions.pop();
    let prices = load_model_prices(connection)?;
    let filter = build_usage_filter(&query);
    let sql = format!(
        r#"
        SELECT timestamp_ms, session_id, model, alias, reasoning_effort, service_tier,
            response_service_tier, executor_type, provider, auth_type, latency_ms, ttft_ms,
            failed, canceled, failure_status,
            CASE WHEN failed != 0 THEN substr(failure_body, 1, {SESSION_TIMELINE_FAILURE_CHARS}) ELSE '' END,
            input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens
        FROM usage_events{}
        ORDER BY timestamp_ms, id
        LIMIT {}
        "#,
        filter.clause,
        SESSION_TIMELINE_LIMIT + 1
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare session timeline query: {error}"))?;
    let mut long_context_thresholds = HashMap::new();
    // A long session repeats a few models thousands of times, and finding a
    // model's price walks the price lists, so each pair is priced once.
    let mut priced = HashMap::<(String, String), Option<ModelPrice>>::new();
    let mut requests = statement
        .query_map(params_from_iter(filter.params.iter()), |row| {
            let model: String = row.get(2)?;
            let alias: String = row.get(3)?;
            let input_tokens = from_sql_i64(row.get(16)?);
            let output_tokens = from_sql_i64(row.get(17)?);
            let cache_read_tokens = from_sql_i64(row.get(19)?);
            let cache_creation_tokens = from_sql_i64(row.get(20)?);
            let group = UsageCostGroup {
                tokens: request_cost_tokens(
                    &model,
                    &alias,
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_creation_tokens,
                ),
                model,
                alias,
                service_tier: row.get(5)?,
                response_service_tier: row.get(6)?,
                executor_type: row.get(7)?,
                provider: row.get(8)?,
                auth_type: row.get(9)?,
                requests: 1,
                total_tokens: 0,
            };
            if let Some(tier) = billed_long_context_tier(&group.model, &group.alias) {
                long_context_thresholds.insert(group.model.clone(), LONG_CONTEXT_THRESHOLDS[tier]);
            }
            Ok(UsageTimelineRequest {
                timestamp_ms: row.get(0)?,
                thread_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                cost: priced
                    .entry((group.model.clone(), group.alias.clone()))
                    .or_insert_with(|| {
                        resolve_model_price(&group.model, &group.alias, &prices)
                            .map(|(model, price)| enriched_model_price(model, &price))
                    })
                    .as_ref()
                    .map(|price| cost_parts_at_price(&group.model, billed_service_tier(&group), &group.tokens, price)),
                long_context: group.tokens.long_input > 0,
                service_tier: billed_service_tier(&group).to_string(),
                model: group.model,
                reasoning_effort: row.get(4)?,
                latency_ms: row.get(10)?,
                ttft_ms: row.get(11)?,
                failed: row.get::<_, i64>(12)? != 0,
                canceled: row.get::<_, i64>(13)? != 0,
                failure_status: row.get(14)?,
                failure: row.get(15)?,
                input_tokens,
                output_tokens,
                reasoning_tokens: from_sql_i64(row.get(18)?),
                cache_read_tokens,
                cache_creation_tokens,
                step: None,
            })
        })
        .map_err(|error| format!("Failed to query session timeline: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read session timeline: {error}"))?;
    let truncated = requests.len() > SESSION_TIMELINE_LIMIT;
    requests.truncate(SESSION_TIMELINE_LIMIT);

    let mut threads = HashMap::<String, Vec<usize>>::new();
    for (index, request) in requests.iter().enumerate() {
        if request.input_tokens > 0 {
            threads.entry(request.thread_id.clone()).or_default().push(index);
        }
    }
    for indices in threads.values() {
        let contexts = indices
            .iter()
            .map(|&index| requests[index].input_tokens)
            .collect::<Vec<_>>();
        for (&index, step) in indices.iter().zip(follow_conversation(&contexts)) {
            requests[index].step = Some(step);
        }
    }
    Ok(UsageSessionTimeline {
        session: summary,
        requests,
        truncated,
        long_context_thresholds,
    })
}

fn usage_filter_and(filter: &UsageSqlFilter, condition: &str) -> UsageSqlFilter {
    let joiner = if filter.clause.is_empty() {
        " WHERE "
    } else {
        " AND "
    };
    UsageSqlFilter {
        clause: format!("{}{joiner}{condition}", filter.clause),
        params: filter.params.clone(),
    }
}

/// Folds the matching requests into one tally per session id. Costs are worked
/// out per pricing group, the same way as everywhere else on the Usage page.
fn load_usage_session_tallies(
    connection: &Connection,
    filter: &UsageSqlFilter,
    prices: &HashMap<String, ModelPrice>,
) -> Result<HashMap<String, UsageSessionTally>, String> {
    let groups = cost_groups::fold_cost_rows::<SessionGroupSums>(
        connection,
        &["session_id"],
        "parent_session_id, timestamp_ms, timestamp_ms + latency_ms, failed != 0 AND canceled = 0, canceled != 0, \
         reasoning_tokens, user_agent, api_key_hash",
        filter,
        |sums, row, at| {
            cost_groups::keep_max_text(&mut sums.parent_session_id, row.get_ref(at)?);
            let started: i64 = row.get(at + 1)?;
            let finished: i64 = row.get(at + 2)?;
            sums.started_at_ms = Some(sums.started_at_ms.map_or(started, |kept| kept.min(started)));
            sums.last_active_at_ms = Some(sums.last_active_at_ms.map_or(finished, |kept| kept.max(finished)));
            sums.failures += row.get::<_, i64>(at + 3)?;
            sums.canceled += row.get::<_, i64>(at + 4)?;
            sums.reasoning_tokens = sums.reasoning_tokens.saturating_add(row.get(at + 5)?);
            cost_groups::keep_max_text(&mut sums.user_agent, row.get_ref(at + 6)?);
            cost_groups::keep_max_text(&mut sums.api_key_hash, row.get_ref(at + 7)?);
            Ok(())
        },
    )?;
    let groups = groups.into_iter().map(|group| {
        let [session_id] = <[String; 1]>::try_from(group.keys).unwrap_or_default();
        let sums = group.extra;
        UsageSessionGroup {
            cost: group.cost,
            session_id,
            parent_session_id: sums.parent_session_id,
            started_at_ms: sums.started_at_ms.unwrap_or_default(),
            last_active_at_ms: sums.last_active_at_ms.unwrap_or_default(),
            failures: from_sql_i64(sums.failures),
            canceled: from_sql_i64(sums.canceled),
            reasoning_tokens: from_sql_i64(sums.reasoning_tokens),
            user_agent: sums.user_agent,
            api_key_hash: sums.api_key_hash.unwrap_or_default(),
        }
    });

    let mut tallies = HashMap::<String, UsageSessionTally>::new();
    for group in groups {
        let cost = cost_for_usage_group(&group.cost, prices);
        let tally = tallies.entry(group.session_id).or_default();
        // MAX, like the SQL, so a session's parent is the same whichever
        // group is read first.
        tally.parent_id = tally
            .parent_id
            .take()
            .max(group.parent_session_id.filter(|id| !id.is_empty()));
        tally.user_agent = tally
            .user_agent
            .take()
            .max(group.user_agent.filter(|agent| !agent.trim().is_empty()));
        if group.api_key_hash > tally.api_key_hash {
            tally.api_key_hash = group.api_key_hash;
        }
        count_session_name(&mut tally.models, &group.cost.model, group.cost.requests);
        count_session_name(
            &mut tally.providers,
            &group.cost.provider,
            group.cost.requests,
        );
        tally.totals.add(&UsageSessionTotals {
            started_at_ms: group.started_at_ms,
            last_active_at_ms: group.last_active_at_ms,
            requests: group.cost.requests,
            failures: group.failures,
            canceled: group.canceled,
            input_tokens: group.cost.tokens.input,
            output_tokens: group.cost.tokens.output,
            reasoning_tokens: group.reasoning_tokens,
            cache_read_tokens: group.cost.tokens.cache_read,
            cache_creation_tokens: group.cost.tokens.cache_creation,
            total_tokens: group.cost.total_tokens,
            estimated_cost: cost.unwrap_or_default(),
            priced_requests: if cost.is_some() {
                group.cost.requests
            } else {
                0
            },
        });
    }
    Ok(tallies)
}

fn count_session_name(counts: &mut HashMap<String, u64>, name: &str, requests: u64) {
    let name = name.trim();
    if !name.is_empty() {
        let count = counts.entry(name.to_string()).or_default();
        *count = count.saturating_add(requests);
    }
}

/// Most requests first, then by name.
fn ranked_session_names(counts: &HashMap<String, u64>) -> Vec<String> {
    let mut ranked = counts.iter().collect::<Vec<_>>();
    ranked.sort_by(|left, right| right.1.cmp(left.1).then_with(|| left.0.cmp(right.0)));
    ranked.into_iter().map(|(name, _)| name.clone()).collect()
}

/// Maps each session to its parent. Ancestors the filter left out are looked
/// up across every stored request, since a subagent's requests can fall in the
/// range while its parent's do not. An ancestor with no requests at all, such
/// as a Codex parent conversation that never went through the proxy, maps to
/// None and becomes a root.
fn resolve_session_parents(
    connection: &Connection,
    tallies: &HashMap<String, UsageSessionTally>,
) -> Result<HashMap<String, Option<String>>, String> {
    let mut parent_of = tallies
        .iter()
        .map(|(id, tally)| (id.clone(), tally.parent_id.clone()))
        .collect::<HashMap<_, _>>();
    let mut pending = parent_of
        .values()
        .flatten()
        .filter(|parent| !parent_of.contains_key(*parent))
        .cloned()
        .collect::<HashSet<_>>();
    // A chain still open after the last round ends at the id it could not look
    // up, which session_ancestry treats as a root.
    for _ in 0..MAX_SESSION_ANCESTRY_ROUNDS {
        if pending.is_empty() {
            break;
        }
        let ids = pending.drain().collect::<Vec<_>>();
        for id in &ids {
            parent_of.insert(id.clone(), None);
        }
        for batch in ids.chunks(SESSION_LOOKUP_BATCH_SIZE) {
            for (id, parent) in load_session_parents(connection, batch)? {
                if let Some(parent) = parent
                    .as_ref()
                    .filter(|parent| !parent_of.contains_key(*parent))
                {
                    pending.insert(parent.clone());
                }
                parent_of.insert(id, parent);
            }
        }
    }
    Ok(parent_of)
}

fn load_session_parents(
    connection: &Connection,
    ids: &[String],
) -> Result<Vec<(String, Option<String>)>, String> {
    let sql = format!(
        "SELECT session_id, MAX(parent_session_id) FROM usage_events WHERE session_id IN ({}) GROUP BY session_id",
        vec!["?"; ids.len()].join(", ")
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare usage session parent query: {error}"))?;
    let parents = statement
        .query_map(params_from_iter(ids.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?
                    .filter(|parent| !parent.is_empty()),
            ))
        })
        .map_err(|error| format!("Failed to query usage session parents: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read usage session parents: {error}"))?;
    Ok(parents)
}

/// The session followed by its ancestors, root last. A session whose ancestry
/// loops back on itself is its own root.
fn session_ancestry<'a>(
    id: &'a str,
    parent_of: &'a HashMap<String, Option<String>>,
) -> Vec<&'a str> {
    let mut ancestry = vec![id];
    let mut seen = HashSet::from([id]);
    let mut current = id;
    while let Some(parent) = parent_of.get(current).and_then(Option::as_deref) {
        if !seen.insert(parent) {
            return vec![id];
        }
        ancestry.push(parent);
        current = parent;
    }
    ancestry
}

fn build_usage_session(
    root: &str,
    ancestries: &[Vec<&str>],
    tallies: &HashMap<String, UsageSessionTally>,
    parent_of: &HashMap<String, Option<String>>,
    assignments: &[machines::MachineAssignment],
    active_since: i64,
) -> UsageSession {
    let earlier = |left: &str, right: &str| {
        tallies[left]
            .totals
            .started_at_ms
            .cmp(&tallies[right].totals.started_at_ms)
            .then_with(|| left.cmp(right))
    };
    let present = ancestries
        .iter()
        .map(|ancestry| ancestry[0])
        .collect::<HashSet<_>>();
    let has_own_requests = present.contains(root);

    // A thread hangs under its nearest ancestor with requests in range, so a
    // subagent whose parent was filtered out still shows inside the tree, at
    // its real depth.
    let mut children = HashMap::<&str, Vec<(&str, usize)>>::new();
    for ancestry in ancestries.iter().filter(|ancestry| ancestry[0] != root) {
        let anchor = ancestry[1..]
            .iter()
            .copied()
            .find(|id| present.contains(id))
            .unwrap_or(root);
        children
            .entry(anchor)
            .or_default()
            .push((ancestry[0], ancestry.len() - 1));
    }
    for siblings in children.values_mut() {
        siblings.sort_by(|left, right| earlier(left.0, right.0));
    }
    let mut order = Vec::with_capacity(ancestries.len());
    if has_own_requests {
        order.push((root, 0));
    }
    let mut stack = children
        .get(root)
        .map(|siblings| siblings.iter().rev().copied().collect::<Vec<_>>())
        .unwrap_or_default();
    while let Some((id, depth)) = stack.pop() {
        order.push((id, depth));
        if let Some(siblings) = children.get(id) {
            stack.extend(siblings.iter().rev().copied());
        }
    }

    let mut totals = UsageSessionTotals::default();
    let mut models = HashMap::<String, u64>::new();
    let mut providers = HashMap::<String, u64>::new();
    let mut threads = Vec::with_capacity(order.len());
    for &(id, depth) in &order {
        let tally = &tallies[id];
        totals.add(&tally.totals);
        for (merged, counts) in [
            (&mut models, &tally.models),
            (&mut providers, &tally.providers),
        ] {
            for (name, requests) in counts {
                let count = merged.entry(name.clone()).or_default();
                *count = count.saturating_add(*requests);
            }
        }
        threads.push(UsageSessionThread {
            id: id.to_string(),
            parent_id: if depth == 0 {
                None
            } else {
                parent_of.get(id).cloned().flatten()
            },
            depth,
            models: ranked_session_names(&tally.models),
            providers: ranked_session_names(&tally.providers),
            user_agent: tally.user_agent.clone(),
            totals: tally.totals.clone(),
            peak_context: 0,
            compactions: 0,
        });
    }

    let representative = if has_own_requests {
        root
    } else {
        order
            .iter()
            .map(|(id, _)| *id)
            .min_by(|left, right| earlier(left, right))
            .unwrap_or(root)
    };
    let (user_agent, api_key_hash) = tallies
        .get(representative)
        .map(|tally| (tally.user_agent.clone(), tally.api_key_hash.clone()))
        .unwrap_or_default();
    let assignment = assignments
        .iter()
        .find(|assignment| assignment.api_key_hash == api_key_hash);
    let providers = ranked_session_names(&providers);
    let provider = providers.first().cloned().unwrap_or_default();
    let active = totals.last_active_at_ms >= active_since;
    UsageSession {
        root: UsageSessionThread {
            id: root.to_string(),
            parent_id: None,
            depth: 0,
            models: ranked_session_names(&models),
            providers,
            user_agent,
            totals,
            peak_context: 0,
            compactions: 0,
        },
        provider,
        machine: assignment
            .map(|assignment| assignment.machine.clone())
            .unwrap_or_default(),
        pool: assignment
            .map(|assignment| assignment.pool.clone())
            .unwrap_or_default(),
        api_key_hash,
        active,
        has_own_requests,
        subagents: threads.len() - usize::from(has_own_requests),
        threads,
        transcript: None,
    }
}

fn total_usage_records() -> Result<u64, String> {
    let connection = open_usage_database()?;
    connection
        .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
            row.get::<_, i64>(0)
        })
        .map(from_sql_i64)
        .map_err(|error| format!("Failed to count total SQLite usage records: {error}"))
}

fn query_window_minutes(query: &UsageQuery, first: Option<i64>, last: Option<i64>) -> f64 {
    let start = query
        .start
        .as_deref()
        .and_then(parse_timestamp_millis)
        .or(first)
        .unwrap_or(0);
    let end = query
        .end
        .as_deref()
        .and_then(parse_timestamp_millis)
        .or(last)
        .unwrap_or(start);
    ((end.saturating_sub(start)) as f64 / 60_000.0).max(1.0)
}

fn record_local_hour(record: &UsageRecord) -> String {
    local_hour_from_timestamp(&record.timestamp)
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d-%H").to_string())
}

fn local_hour_from_timestamp(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value).ok().map(|timestamp| {
        timestamp
            .with_timezone(&Local)
            .format("%Y-%m-%d-%H")
            .to_string()
    })
}

fn record_timestamp_millis(record: &UsageRecord) -> i64 {
    parse_timestamp_millis(&record.timestamp).unwrap_or(0)
}

fn parse_timestamp_millis(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

fn to_sql_i64(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

fn from_sql_i64(value: i64) -> u64 {
    value.max(0) as u64
}

fn unique_file_stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn string_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(|value| match value {
            Value::String(value) => Some(value.trim().to_string()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        })
        .filter(|value| !value.is_empty())
}

fn u64_field(object: &serde_json::Map<String, Value>, key: &str) -> u64 {
    optional_u64_field(object, key).unwrap_or(0)
}

fn optional_u64_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<u64> {
    object.get(key).and_then(|value| {
        value.as_u64().or_else(|| {
            value
                .as_i64()
                .map(|number| number.max(0) as u64)
                .or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
        })
    })
}

fn token_u64(object: Option<&serde_json::Map<String, Value>>, key: &str) -> u64 {
    object.map(|object| u64_field(object, key)).unwrap_or(0)
}

pub(crate) fn hash_text(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn mask_api_key(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return String::new();
    }
    if value.chars().count() <= 8 {
        return format!("{}••••", value.chars().take(2).collect::<String>());
    }
    let start = value.chars().take(4).collect::<String>();
    let end = value
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{start}••••{end}")
}

fn api_key_category_label(remark: String, display: String) -> String {
    if !remark.is_empty() {
        remark
    } else if !display.is_empty() {
        mask_api_key(&display)
    } else {
        "Unrecorded API key".to_string()
    }
}

fn usage_source_display(config: &GuiConfigFile, provider: &str, source: &str) -> String {
    let source = source.trim();
    if source.is_empty() {
        return "Unknown source".to_string();
    }
    if let Some(remark) = config.api_access_remark_for_source(provider, source) {
        return remark.to_string();
    }
    let character_count = source.chars().count();
    let looks_like_secret = !source.contains('@')
        && !source.chars().any(char::is_whitespace)
        && (source.starts_with("sk-")
            || source.starts_with("AIza")
            || source.starts_with("key-")
            || character_count >= 48);
    if looks_like_secret {
        mask_api_key(source)
    } else {
        source.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::schema::{
        quote_sqlite_identifier, replace_sql_fragment_case_insensitive, LATEST, USAGE_DATABASE_MIGRATION_KEY,
        USAGE_EVENT_KEY_MIGRATION_KEY, USAGE_FAILURE_MIGRATION_KEY, USAGE_SESSION_COLUMNS, USAGE_SESSION_MIGRATION_KEY,
    };
    use std::collections::BTreeSet;

    #[tokio::test]
    async fn background_usage_jobs_limit_database_concurrency() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut jobs = Vec::new();
        for index in 0..USAGE_QUERY_SLOT_COUNT as usize * 3 {
            let active = active.clone();
            let peak = peak.clone();
            jobs.push(tokio::spawn(run_usage_task(move || {
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(count, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(10));
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(index)
            })));
        }
        for (index, job) in jobs.into_iter().enumerate() {
            assert_eq!(job.await.unwrap().unwrap(), index);
        }
        assert!(peak.load(Ordering::SeqCst) <= USAGE_QUERY_SLOT_COUNT as usize);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn single_scan_analysis_matches_independent_categories_for_mixed_data_and_filters() {
        let mut connection = schema::test_database();
        let records: Vec<_> = (0..600)
            .map(|index| {
                let mut record = sample_record(
                    &format!("analysis-{index}"),
                    if index % 2 == 0 {
                        "2026-08-27T00:00:00Z"
                    } else {
                        "2026-08-28T00:00:00Z"
                    },
                    [" Model-A ", "model-a", "", "unknown", "Model-B"][index % 5],
                );
                record.provider = ["openai", "claude", " "][index % 3].to_string();
                record.source =
                    ["source-a", " ", "source-b", "sk-secret-source"][index % 4].to_string();
                record.api_key_hash = ["hash-a", "hash-b", " "][index % 3].to_string();
                record.api_key_remark = ["", " alpha ", "zeta", "Test remark"][index % 4].to_string();
                record.api_key_display = ["", "ab••••", "xy••••"][index % 3].to_string();
                record.failed = index % 3 == 0;
                record.canceled = index % 6 == 0;
                record.tokens.total_tokens = (index % 17) as u64;
                record
            })
            .collect();
        insert_usage_records(&mut connection, &records).unwrap();
        let config = GuiConfigFile::default();
        let queries = [
            UsageQuery::default(),
            UsageQuery {
                model: Some("MODEL-A".into()),
                ..UsageQuery::default()
            },
            UsageQuery {
                provider: Some("claude".into()),
                ..UsageQuery::default()
            },
            UsageQuery {
                source: Some("source-a".into()),
                ..UsageQuery::default()
            },
            UsageQuery {
                api_key_hash: Some("hash-a".into()),
                ..UsageQuery::default()
            },
            UsageQuery {
                failed: Some(true),
                canceled: Some(false),
                ..UsageQuery::default()
            },
            UsageQuery {
                canceled: Some(true),
                ..UsageQuery::default()
            },
            UsageQuery {
                start: Some("2026-08-28T00:00:00Z".into()),
                ..UsageQuery::default()
            },
            UsageQuery {
                model: Some("not-present".into()),
                ..UsageQuery::default()
            },
        ];
        let canonical = |mut categories: Vec<UsageCategory>| {
            categories.sort_by(|left, right| left.key.cmp(&right.key));
            serde_json::to_value(categories).unwrap()
        };
        for query in queries {
            let actual = load_usage_analysis(&connection, &query, &config).unwrap();
            assert_eq!(
                canonical(actual.models),
                canonical(load_simple_categories(&connection, &query, "model", "unknown").unwrap())
            );
            assert_eq!(
                canonical(actual.providers),
                canonical(
                    load_simple_categories(&connection, &query, "provider", "Unknown provider")
                        .unwrap()
                )
            );
            assert_eq!(
                canonical(actual.sources),
                canonical(load_source_categories(&connection, &query, &config).unwrap())
            );
            assert_eq!(
                canonical(actual.api_keys),
                canonical(load_api_key_categories(&connection, &query).unwrap())
            );
        }
    }

    #[test]
    fn collector_resubscribes_only_when_port_or_management_key_changes() {
        let mut config = GuiConfigFile {
            port: 8317,
            management_secret_key: "wui-original".to_string(),
            ..GuiConfigFile::default()
        };
        let opened_with = (8317, "wui-original".to_string());

        assert!(!subscription_settings_changed(None, &config));
        assert!(!subscription_settings_changed(Some(&opened_with), &config));

        config.management_secret_key = "wui-rotated".to_string();
        assert!(subscription_settings_changed(Some(&opened_with), &config));

        config.management_secret_key = "wui-original".to_string();
        config.port = 8318;
        assert!(subscription_settings_changed(Some(&opened_with), &config));
    }

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "cpa-gui-usage-{name}-{}-{}",
            std::process::id(),
            unique_file_stamp()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn legacy_usage_storage_is_moved_with_nested_files() {
        let root = test_root("storage-location-migration");
        let source = root.join("legacy").join(USAGE_DIR_NAME);
        let target = root.join("application-support").join(USAGE_DIR_NAME);
        fs::create_dir_all(source.join(USAGE_BACKUP_DIR_NAME)).unwrap();
        fs::write(source.join(USAGE_DATABASE_FILE), b"database").unwrap();
        fs::write(
            source.join(USAGE_BACKUP_DIR_NAME).join("usage.db.backup"),
            b"backup",
        )
        .unwrap();

        migrate_usage_storage_directory(&source, &target).unwrap();

        assert!(!source.exists());
        assert_eq!(
            fs::read(target.join(USAGE_DATABASE_FILE)).unwrap(),
            b"database"
        );
        assert_eq!(
            fs::read(target.join(USAGE_BACKUP_DIR_NAME).join("usage.db.backup")).unwrap(),
            b"backup"
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn open_test_database(root: &Path) -> Connection {
        initialize_usage_storage_at(root).unwrap();
        open_usage_database_at(root).unwrap()
    }

    #[test]
    fn repairs_legacy_claude_input_tokens_on_demand() {
        let root = test_root("claude-input-migration");
        let connection = open_test_database(&root);
        connection
            .execute(
                r#"INSERT INTO usage_events (
                    event_key, timestamp, timestamp_ms, local_hour, provider,
                    executor_type, input_tokens, output_tokens, cache_read_tokens,
                    cache_creation_tokens, total_tokens, created_at
                ) VALUES ('legacy-claude', '2026-08-27T00:00:00Z', 1,
                          '2026-08-27T00', 'claude', 'ClaudeExecutor',
                          100, 20, 600, 20, 740, '2026-08-27T00:00:00Z')"#,
                [],
            )
            .unwrap();
        drop(connection);

        let result = repair_usage_cache_records_at(&root).unwrap();
        assert_eq!(result.scanned, 1);
        assert_eq!(result.repaired, 1);
        assert!(result.backup_path.is_some());
        let connection = open_usage_database_at(&root).unwrap();
        let row: (i64, i64, i64) = connection
            .query_row(
                "SELECT input_tokens, total_tokens, cached_tokens FROM usage_events WHERE event_key = 'legacy-claude'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, (720, 740, 620));
        drop(connection);

        let second = repair_usage_cache_records_at(&root).unwrap();
        assert_eq!(second.scanned, 0);
        assert_eq!(second.repaired, 0);
        let rerun_connection = open_usage_database_at(&root).unwrap();
        let rerun_input: i64 = rerun_connection
            .query_row(
                "SELECT input_tokens FROM usage_events WHERE event_key = 'legacy-claude'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(rerun_connection);
        assert_eq!(rerun_input, 720);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_repair_waits_for_the_write_in_progress() {
        let root = test_root("repair-waits");
        let connection = open_test_database(&root);
        connection
            .execute(
                "INSERT INTO usage_events (event_key, timestamp, timestamp_ms, local_hour, model, created_at) VALUES ('control', '2026-08-27T00:00:00Z', 1, '2026-08-27T00', 'unknown', '2026-08-27T00:00:00Z')",
                [],
            )
            .unwrap();
        drop(connection);

        let writing = lock_usage_writes();
        let (finished, repaired) = std::sync::mpsc::channel();
        let repair_root = root.clone();
        let repair = std::thread::spawn(move || {
            let result = repair_usage_cache_records_at(&repair_root);
            let _ = finished.send(());
            result
        });
        assert!(
            repaired.recv_timeout(Duration::from_millis(300)).is_err(),
            "the repair wrote while another write held the lock"
        );
        drop(writing);
        assert_eq!(repair.join().unwrap().unwrap().deleted, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_writer_can_open_usage_db_while_it_is_first_set_up() {
        // Compaction takes the write lock and then opens usage.db, so setting usage.db up mustn't take the write lock
        // while holding the lock every open waits on: a writer opening it meanwhile would stick fast with the setup, and
        // one opening a folder not yet set up would wait for itself.
        let root = test_root("writer-sets-up");
        let (finished, opened) = std::sync::mpsc::channel();
        let writer_root = root.clone();
        std::thread::spawn(move || {
            let _writing = lock_usage_writes();
            let _ = finished.send(open_usage_database_at(&writer_root).map(|_| ()));
        });
        opened
            .recv_timeout(Duration::from_secs(20))
            .expect("setting usage.db up waited for the writer's lock")
            .unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removes_historical_unknown_records_on_demand() {
        let root = test_root("unknown-repair");
        let connection = open_test_database(&root);
        for (key, index) in ["refresh-control", "support-refresh-control"]
            .iter()
            .zip([1_i64, 2_i64])
        {
            connection
                .execute(
                    "INSERT INTO usage_events (event_key, timestamp, timestamp_ms, local_hour, provider, model, request_id, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens, total_tokens, latency_ms, failed, canceled, generate, created_at) VALUES (?1, '2026-08-27T00:00:00Z', ?2, '2026-08-27T00', '', 'unknown', '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, '2026-08-27T00:00:00Z')",
                    params![key, index],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO usage_events (event_key, timestamp, timestamp_ms, local_hour, provider, model, request_id, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens, total_tokens, latency_ms, failed, canceled, generate, created_at) VALUES ('legitimate-unknown', '2026-08-27T00:00:00Z', 3, '2026-08-27T00', '', 'unknown', '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, '2026-08-27T00:00:00Z')",
                [],
            )
            .unwrap();
        drop(connection);

        let result = repair_usage_cache_records_at(&root).unwrap();
        assert_eq!(result.scanned, 3);
        assert_eq!(result.repaired, 0);
        assert_eq!(result.deleted, 3);
        let connection = open_usage_database_at(&root).unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_events WHERE model = 'unknown'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    fn create_legacy_v2_database(root: &Path) -> Connection {
        fs::create_dir_all(root).unwrap();
        let connection = connect_usage_database(root).unwrap();
        connection.execute_batch(schema::LEGACY_V2_SQL).unwrap();
        connection
    }

    #[test]
    fn analysis_counts_each_credential_by_its_auth_index_and_the_rest_by_source() {
        let mut connection = schema::test_database();
        let record = |id: &str, index: &str, source: &str, failed: bool| {
            let mut record = sample_record(id, "2026-08-27T00:00:00Z", "model");
            record.auth_index = index.to_string();
            record.source = source.to_string();
            record.failed = failed;
            record
        };
        insert_usage_records(
            &mut connection,
            &[
                // One email signed in twice (a Claude and a Codex credential) is two accounts.
                record("a", " claude-1 ", "sam@example.com", false),
                record("b", "claude-1", "sam@example.com", true),
                record("c", "codex-2", "sam@example.com", false),
                // Without an index there's only the source to go by; two sources stay two rows.
                record("d", "", "old@example.com", false),
                record("e", "", "other@example.com", false),
                record("f", "", "", false),
            ],
        )
        .unwrap();
        let analysis = load_usage_analysis(&connection, &UsageQuery::default(), &GuiConfigFile::default()).unwrap();
        let rows: Vec<_> = analysis
            .accounts
            .iter()
            .map(|account| (account.auth_index.as_str(), account.label.as_str(), account.requests, account.failures))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("claude-1", "sam@example.com", 2, 1),
                ("", "Unknown source", 1, 0),
                ("", "old@example.com", 1, 0),
                ("", "other@example.com", 1, 0),
                ("codex-2", "sam@example.com", 1, 0),
            ]
        );
        // The source list the Source filter reads is still one row per source.
        assert_eq!(analysis.sources.iter().find(|source| source.key == "sam@example.com").map(|source| source.requests), Some(3));
    }

    fn sample_record(id: &str, timestamp: &str, model: &str) -> UsageRecord {
        UsageRecord {
            id: id.to_string(),
            timestamp: timestamp.to_string(),
            latency_ms: 100,
            ttft_ms: Some(20),
            source: "source".to_string(),
            source_display: String::new(),
            auth_index: "auth".to_string(),
            failed: false,
            canceled: false,
            failure_status: 0,
            failure_body: String::new(),
            provider: "openai".to_string(),
            api_group_key: "hash".to_string(),
            model: model.to_string(),
            alias: String::new(),
            client_ip: None,
            machine: String::new(),
            pool: String::new(),
            x_forwarded_for: None,
            user_agent: None,
            reasoning_effort: "high".to_string(),
            service_tier: String::new(),
            response_service_tier: String::new(),
            executor_type: String::new(),
            endpoint: "POST /v1/responses".to_string(),
            auth_type: "oauth".to_string(),
            api_key_hash: "hash".to_string(),
            api_key_display: "12••••".to_string(),
            api_key_remark: "Built-in key".to_string(),
            request_id: id.to_string(),
            generate: true,
            cached_tokens: 2,
            collector_source: "test".to_string(),
            tokens: UsageTokenStats {
                input_tokens: 10,
                output_tokens: 20,
                reasoning_tokens: 5,
                cache_read_tokens: 2,
                cache_creation_tokens: 0,
                total_tokens: 30,
            },
            lineage: UsageLineage::default(),
        }
    }

    #[test]
    fn masks_api_keys_without_exposing_the_full_value() {
        assert_eq!(mask_api_key("123456"), "12••••");
        assert_eq!(mask_api_key("sk-1234567890"), "sk-1••••7890");
    }

    #[test]
    fn unrecorded_api_keys_have_an_english_label_and_filter_missing_keys() {
        let mut connection = schema::test_database();
        let records: Vec<_> = ["", " ", "known-hash"]
            .iter()
            .enumerate()
            .map(|(index, hash)| {
                let mut record = sample_record(
                    &format!("missing-key-{index}"),
                    "2026-08-27T00:00:00Z",
                    "model",
                );
                record.api_key_hash = hash.to_string();
                record.api_key_display.clear();
                record.api_key_remark.clear();
                record
            })
            .collect();
        insert_usage_records(&mut connection, &records).unwrap();
        let config = GuiConfigFile::default();
        let analysis = load_usage_analysis(&connection, &UsageQuery::default(), &config).unwrap();
        let missing = analysis
            .api_keys
            .iter()
            .find(|item| item.key == "__unrecorded_api_key__")
            .unwrap();
        assert_eq!(missing.label, "Unrecorded API key");
        assert_eq!(missing.requests, 2);
        let query = UsageQuery {
            api_key_hash: Some(missing.key.clone()),
            ..Default::default()
        };
        let page = load_usage_events(&connection, &query, &config).unwrap();
        assert_eq!(page.total, 2);
    }

    #[test]
    fn requests_order_by_a_column_either_way_and_fall_back_to_newest_first() {
        let mut connection = schema::test_database();
        // (request, time, total tokens, time to first token)
        let rows = [
            ("a", "2026-08-27T00:00:01Z", 300, Some(90)),
            ("b", "2026-08-27T00:00:02Z", 100, None),
            ("c", "2026-08-27T00:00:03Z", 300, Some(40)),
            ("d", "2026-08-27T00:00:04Z", 200, Some(60)),
        ];
        let records: Vec<_> = rows
            .iter()
            .map(|(id, time, total, ttft)| {
                let mut record = sample_record(id, time, "model");
                record.tokens.total_tokens = *total;
                record.ttft_ms = *ttft;
                record
            })
            .collect();
        insert_usage_records(&mut connection, &records).unwrap();
        let config = GuiConfigFile::default();
        let order = |order: Option<UsageRequestOrder>, page_size: usize, page: usize| {
            let query = UsageQuery {
                request_order: order,
                page_size: Some(page_size),
                page: Some(page),
                ..Default::default()
            };
            load_usage_events(&connection, &query, &config)
                .unwrap()
                .items
                .into_iter()
                .map(|item| item.request_id)
                .collect::<Vec<_>>()
        };
        let by = |by, descending| Some(UsageRequestOrder { by, descending });

        assert_eq!(order(None, 20, 1), ["d", "c", "b", "a"]);
        assert_eq!(order(by(UsageRequestSortKey::Time, false), 20, 1), ["a", "b", "c", "d"]);
        // Equal totals keep newest first, whichever way the column runs.
        assert_eq!(order(by(UsageRequestSortKey::Total, true), 20, 1), ["c", "a", "d", "b"]);
        assert_eq!(order(by(UsageRequestSortKey::Total, false), 20, 1), ["b", "d", "c", "a"]);
        // A request with no time to first token sits last both ways.
        assert_eq!(order(by(UsageRequestSortKey::Ttft, false), 20, 1), ["c", "d", "a", "b"]);
        assert_eq!(order(by(UsageRequestSortKey::Ttft, true), 20, 1), ["a", "d", "c", "b"]);
    }

    #[test]
    fn api_key_category_uses_either_remark_or_masked_key() {
        assert_eq!(
            api_key_category_label("Production".to_string(), "12••••".to_string()),
            "Production"
        );
        assert_eq!(
            api_key_category_label(String::new(), "123456".to_string()),
            "12••••"
        );
    }

    #[test]
    fn usage_source_prefers_api_access_remark_and_masks_secret_fallbacks() {
        let key = "sk-1234567890abcdefghijklmnopqrstuvwxyz";
        let mut config = GuiConfigFile::default();
        config.api_access_remarks.push(crate::GuiApiAccessRemark {
            provider_section: "codex-api-key".to_string(),
            api_key_hash: hash_text(key),
            remark: "Production".to_string(),
        });

        assert_eq!(usage_source_display(&config, "codex", key), "Production");
        assert_eq!(
            usage_source_display(&GuiConfigFile::default(), "codex", key),
            "sk-1••••wxyz"
        );
        assert_eq!(
            usage_source_display(&config, "codex", "account@example.com"),
            "account@example.com"
        );
    }

    #[test]
    fn normalizes_queue_records_without_persisting_secrets_or_headers() {
        let config = GuiConfigFile {
            port: 8317,
            allow_lan: false,
            host: "127.0.0.1".to_string(),
            run_on_startup: false,
            start_core_on_launch: true,
            silent_start: false,
            close_behavior: crate::WindowsCloseBehavior::Ask,
            window_width: None,
            window_height: None,
            zoom_step: 0,
            auth_dir: String::new(),
            api_keys: Vec::new(),
            paused_api_keys: Vec::new(),
            client_key_names: Vec::new(),
            api_access_remarks: Vec::new(),
            management_secret_key: "123456".to_string(),
            debug: false,
            commercial_mode: false,
            logging_to_file: false,
            logs_max_total_size_mb: crate::DEFAULT_LOGS_MAX_TOTAL_SIZE_MB,
            error_logs_max_files: crate::DEFAULT_ERROR_LOGS_MAX_FILES,
            usage_statistics_enabled: true,
            redis_usage_queue_retention_seconds: crate::DEFAULT_REDIS_USAGE_QUEUE_RETENTION_SECONDS,
            request_log: false,
            plugins_enabled: false,
            routing_strategy: "round-robin".to_string(),
            proxy_url: String::new(),
            routing_session_affinity: false,
            routing_session_affinity_ttl: String::new(),
            disable_cooling: crate::DEFAULT_DISABLE_COOLING,
            request_retry: crate::DEFAULT_REQUEST_RETRY,
            max_retry_credentials: crate::DEFAULT_MAX_RETRY_CREDENTIALS,
            max_retry_interval: crate::DEFAULT_MAX_RETRY_INTERVAL,
            streaming_bootstrap_retries: crate::DEFAULT_STREAMING_BOOTSTRAP_RETRIES,
            update_channel: crate::release_feed::UpdateChannel::Stable,
        };
        let record = normalize_usage_record(
            serde_json::json!({
                "timestamp": "2026-07-17T20:30:00+08:00",
                "request_id": "request-1",
                "api_key": "secret-client-key",
                "response_headers": { "authorization": ["secret-upstream-token"] },
                "model": "gpt-test",
                "tokens": {
                    "input_tokens": 10,
                    "output_tokens": 20,
                    "cached_tokens": 7,
                    "cache_read_tokens": 5,
                    "cache_creation_tokens": 2
                }
            }),
            &config,
        )
        .unwrap();
        let rendered = serde_json::to_string(&record).unwrap();

        assert!(!rendered.contains("secret-client-key"));
        assert!(!rendered.contains("secret-upstream-token"));
        assert_eq!(record.tokens.total_tokens, 30);
        assert_eq!(record.tokens.cache_read_tokens, 5);
        assert!(!record.api_key_hash.is_empty());
    }

    #[test]
    fn preserves_explicit_cache_read_and_only_backfills_missing_alias() {
        let config = GuiConfigFile::default();
        let explicit = normalize_usage_record(
            serde_json::json!({
                "request_id": "explicit-cache-read",
                "tokens": {
                    "input_tokens": 100,
                    "cached_tokens": 10,
                    "cache_read_tokens": 5,
                    "cache_creation_tokens": 2,
                    "total_tokens": 100
                }
            }),
            &config,
        )
        .unwrap();
        assert_eq!(explicit.tokens.cache_read_tokens, 5);

        let legacy = normalize_usage_record(
            serde_json::json!({
                "request_id": "legacy-cache-alias",
                "tokens": {
                    "input_tokens": 100,
                    "cached_tokens": 10,
                    "cache_creation_tokens": 2,
                    "total_tokens": 100
                }
            }),
            &config,
        )
        .unwrap();
        assert_eq!(legacy.tokens.cache_read_tokens, 10);
    }

    #[test]
    fn normalizes_claude_input_to_include_cache_tokens() {
        let record = normalize_usage_record(
            serde_json::json!({
                "executor_type": "ClaudeExecutor",
                "provider": "anthropic",
                "request_id": "claude-cache-rate",
                "tokens": {
                    "input_tokens": 100,
                    "output_tokens": 20,
                    "cache_read_tokens": 600,
                    "cache_creation_tokens": 20,
                    "total_tokens": 120
                }
            }),
            &GuiConfigFile::default(),
        )
        .unwrap();

        assert_eq!(record.tokens.input_tokens, 720);
        assert_eq!(record.tokens.total_tokens, 740);
        assert_eq!(record.tokens.cache_read_tokens, 600);
    }

    #[test]
    fn keeps_already_inclusive_claude_input_unchanged() {
        let record = normalize_usage_record(
            serde_json::json!({
                "provider": "anthropic",
                "request_id": "claude-inclusive",
                "tokens": {
                    "input_tokens": 720,
                    "output_tokens": 20,
                    "cache_read_tokens": 600,
                    "cache_creation_tokens": 20,
                    "total_tokens": 740
                }
            }),
            &GuiConfigFile::default(),
        )
        .unwrap();
        assert_eq!(record.tokens.input_tokens, 720);
        assert_eq!(record.tokens.total_tokens, 740);
    }

    #[test]
    fn enforces_cache_input_invariant_for_unknown_producers() {
        let record = normalize_usage_record(
            serde_json::json!({
                "provider": "custom",
                "request_id": "unknown-cache-shape",
                "tokens": {
                    "input_tokens": 100,
                    "output_tokens": 20,
                    "cache_read_tokens": 600,
                    "total_tokens": 120
                }
            }),
            &GuiConfigFile::default(),
        )
        .unwrap();
        assert_eq!(record.tokens.input_tokens, 700);
        assert_eq!(record.tokens.total_tokens, 720);
        assert!(record.tokens.cache_read_tokens <= record.tokens.input_tokens);
    }

    #[test]
    fn filters_usage_control_messages_before_inbox() {
        assert!(is_ignorable_usage_message(""));
        assert!(is_ignorable_usage_message("  null\n"));
        assert!(is_ignorable_usage_message(r#"{"refresh":true}"#));
        assert!(is_ignorable_usage_message(
            r#"{ "support_refresh" : true }"#
        ));
        assert!(!is_ignorable_usage_message(r#"{"refresh":false}"#));
        assert!(!is_ignorable_usage_message(
            r#"{"refresh":true,"request_id":"usage"}"#
        ));
        assert!(!is_ignorable_usage_message(r#"{"request_id":"usage"}"#));
        assert!(!is_ignorable_usage_message("not-json"));

        let root = test_root("usage-control-messages");
        initialize_usage_storage_at(&root).unwrap();
        let config = GuiConfigFile::default();
        let inserted = persist_queue_items(
            &root,
            vec![
                serde_json::json!({"refresh": true}),
                serde_json::json!({"support_refresh": true}),
                serde_json::json!({
                    "request_id": "real-usage",
                    "provider": "codex",
                    "model": "gpt-test"
                }),
            ],
            &config,
        )
        .unwrap();
        assert_eq!(inserted, 1);
        let connection = open_usage_database_at(&root).unwrap();
        let inbox_count = connection
            .query_row("SELECT COUNT(*) FROM usage_inbox", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        let event_count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(inbox_count, 1);
        assert_eq!(event_count, 1);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_usage_messages_without_request_id() {
        let root = test_root("usage-missing-request-id");
        initialize_usage_storage_at(&root).unwrap();
        let mut connection = open_usage_database_at(&root).unwrap();
        enqueue_usage_queue_items(
            &mut connection,
            "redis_subscribe:usage",
            vec![serde_json::json!({
                "provider": "codex",
                "model": "gpt-test"
            })],
        )
        .unwrap();
        let inserted = process_usage_inbox(&mut connection, &GuiConfigFile::default()).unwrap();
        let event_count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        let status = connection
            .query_row("SELECT status FROM usage_inbox", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap();
        assert_eq!(inserted, 0);
        assert_eq!(event_count, 0);
        assert_eq!(status, "decode_failed");
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persists_successful_health_checks_and_zero_token_websocket_events() {
        let root = test_root("queue-events-without-generation");
        initialize_usage_storage_at(&root).unwrap();
        let config = GuiConfigFile::default();
        let inserted = persist_queue_items(
            &root,
            vec![
                serde_json::json!({
                    "timestamp": "2026-07-29T10:00:00+08:00",
                    "request_id": "cherry-health-check",
                    "generate": false,
                    "failed": false,
                    "provider": "openai",
                    "model": "gpt-test",
                    "endpoint": "POST /v1/chat/completions",
                    "tokens": {
                        "input_tokens": 1,
                        "output_tokens": 1,
                        "total_tokens": 2
                    }
                }),
                serde_json::json!({
                    "timestamp": "2026-07-29T10:00:01+08:00",
                    "request_id": "websocket-zero-token",
                    "failed": false,
                    "provider": "codex",
                    "model": "gpt-test",
                    "executor_type": "CodexWebsocketsExecutor",
                    "tokens": {
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "total_tokens": 0
                    }
                }),
            ],
            &config,
        )
        .unwrap();
        let connection = open_usage_database_at(&root).unwrap();
        let events = load_usage_events(
            &connection,
            &UsageQuery {
                failed: Some(false),
                ..UsageQuery::default()
            },
            &config,
        )
        .unwrap();

        assert_eq!(inserted, 2);
        assert_eq!(events.total, 2);
        assert!(events.items.iter().all(|event| !event.failed));
        assert!(events
            .items
            .iter()
            .any(|event| event.request_id == "cherry-health-check"));
        assert!(events
            .items
            .iter()
            .any(|event| event.request_id == "websocket-zero-token"));
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persists_failure_details_and_excludes_client_cancellations_from_failures() {
        let root = test_root("usage-failure-details");
        initialize_usage_storage_at(&root).unwrap();
        let config = GuiConfigFile::default();
        persist_queue_items(
            &root,
            vec![
                serde_json::json!({
                    "timestamp": "2026-07-29T10:00:00+08:00",
                    "request_id": "success",
                    "failed": false,
                    "provider": "antigravity",
                    "model": "gemini-test"
                }),
                serde_json::json!({
                    "timestamp": "2026-07-29T10:00:01+08:00",
                    "request_id": "upstream-failure",
                    "failed": true,
                    "provider": "antigravity",
                    "model": "gemini-test",
                    "fail": {
                        "status_code": 429,
                        "body": { "error": { "message": "quota exhausted" } }
                    }
                }),
                serde_json::json!({
                    "timestamp": "2026-07-29T10:00:02+08:00",
                    "request_id": "client-canceled",
                    "failed": true,
                    "provider": "antigravity",
                    "model": "gemini-test",
                    "fail": {
                        "status_code": 499,
                        "body": "context canceled"
                    }
                }),
            ],
            &config,
        )
        .unwrap();

        let connection = open_usage_database_at(&root).unwrap();
        let overview = load_usage_overview(&connection, &UsageQuery::default()).unwrap();
        let failures = load_usage_events(
            &connection,
            &UsageQuery {
                failed: Some(true),
                ..UsageQuery::default()
            },
            &config,
        )
        .unwrap();
        let cancellations = load_usage_events(
            &connection,
            &UsageQuery {
                canceled: Some(true),
                ..UsageQuery::default()
            },
            &config,
        )
        .unwrap();

        assert_eq!(overview.total_requests, 3);
        assert_eq!(overview.success_count, 1);
        assert_eq!(overview.failure_count, 1);
        assert_eq!(overview.canceled_count, 1);
        assert_eq!(overview.success_rate, 50.0);
        assert_eq!(failures.total, 1);
        assert_eq!(failures.items[0].request_id, "upstream-failure");
        assert_eq!(failures.items[0].failure_status, 429);
        assert!(failures.items[0].failure_body.contains("quota exhausted"));
        assert_eq!(cancellations.total, 1);
        assert_eq!(cancellations.items[0].request_id, "client-canceled");
        assert!(cancellations.items[0].canceled);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn overview_timeline_reports_when_each_hour_started() {
        let root = test_root("timeline-first-timestamp");
        let connection = open_test_database(&root);
        // Hour labels as a Mac on UTC+8 wrote them. The first timestamp is real time, so the
        // chart can still place each hour after the Mac moves to another timezone.
        connection
            .execute_batch(
                "INSERT INTO usage_events (event_key, timestamp, timestamp_ms, local_hour, created_at) VALUES
                    ('late', '2026-07-17T20:40:00+08:00', 1784292000000, '2026-07-17-20', '2026-07-17T20:40:00+08:00'),
                    ('early', '2026-07-17T20:10:00+08:00', 1784290200000, '2026-07-17-20', '2026-07-17T20:10:00+08:00'),
                    ('next', '2026-07-17T21:05:00+08:00', 1784293500000, '2026-07-17-21', '2026-07-17T21:05:00+08:00'),
                    ('unknown-time', 'not a timestamp', 0, '2026-07-17-22', '2026-07-17T22:00:00+08:00');",
            )
            .unwrap();

        let overview = load_usage_overview(&connection, &UsageQuery::default()).unwrap();
        let timeline = overview
            .timeline
            .iter()
            .map(|point| (point.hour.as_str(), point.first_timestamp_ms, point.requests))
            .collect::<Vec<_>>();

        assert_eq!(
            timeline,
            [
                ("2026-07-17-20", Some(1_784_290_200_000), 2),
                ("2026-07-17-21", Some(1_784_293_500_000), 1),
                ("2026-07-17-22", None, 1),
            ]
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reopening_storage_drops_the_unused_api_group_index() {
        let root = test_root("api-group-index");
        let connection = open_test_database(&root);
        // Databases created before the index was dropped still carry it.
        connection
            .execute_batch(
                "CREATE INDEX idx_usage_events_api_group_timestamp ON usage_events(api_group_key, timestamp_ms DESC);",
            )
            .unwrap();
        // As a database from before the list of steps was.
        connection.pragma_update(None, "user_version", 6).unwrap();
        drop(connection);

        initialize_usage_storage_at(&root).unwrap();
        let connection = open_usage_database_at(&root).unwrap();
        let remaining = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_usage_events_api_group_timestamp'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();

        assert_eq!(remaining, 0);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_v2_database_is_backed_up_and_migrated_once() {
        let root = test_root("keeper-v3-migration");
        let connection = create_legacy_v2_database(&root);
        connection
            .execute(
                r#"
                INSERT INTO usage_events (
                    event_key, timestamp, timestamp_ms, local_hour, latency_ms, ttft_ms,
                    source, auth_index, failed, provider, model, alias, reasoning_effort,
                    service_tier, response_service_tier, executor_type, endpoint, auth_type,
                    api_key_hash, api_key_display, api_key_remark, request_id,
                    input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
                    cache_creation_tokens, total_tokens, created_at
                ) VALUES (
                    'request-1', '2026-07-17T20:30:00+08:00', 1784291400000,
                    '2026-07-17-20', 100, 20, 'source', 'auth', 0, 'openai',
                    'gpt-test', 'alias-test', 'high', '', '', '',
                    'POST /v1/responses', 'oauth', 'legacy-hash', '12••••',
                    'Old key', 'request-1', 10, 20, 5, 2, 3, 30,
                    '2026-07-17T20:30:01+08:00'
                )
                "#,
                [],
            )
            .unwrap();
        drop(connection);

        initialize_usage_storage_at(&root).unwrap();
        initialize_usage_storage_at(&root).unwrap();
        let connection = open_usage_database_at(&root).unwrap();
        let user_version = connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap();
        let migrated = connection
            .query_row(
                r#"
                SELECT COUNT(*), SUM(total_tokens), api_group_key, model_alias,
                       cached_tokens, collector_source
                FROM usage_events
                "#,
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .unwrap();
        let marker = connection
            .query_row(
                "SELECT value FROM usage_metadata WHERE key = ?1",
                params![USAGE_DATABASE_MIGRATION_KEY],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let backups = fs::read_dir(root.join(USAGE_BACKUP_DIR_NAME))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(user_version, LATEST);
        assert_eq!(migrated.0, 1);
        assert_eq!(migrated.1, 30);
        assert_eq!(migrated.2, "legacy-hash");
        assert_eq!(migrated.3.as_deref(), Some("alias-test"));
        assert_eq!(migrated.4, 5);
        assert_eq!(migrated.5, "legacy_migration");
        assert!(!marker.is_empty());
        assert_eq!(backups.len(), 1);

        let duplicate_inserted = connection
            .execute(
                r#"
                INSERT INTO usage_events (
                    event_key, timestamp, timestamp_ms, local_hour, created_at
                ) VALUES (
                    'request-1', '2026-07-17T20:31:00+08:00', 1784291460000,
                    '2026-07-17-20', '2026-07-17T20:31:01+08:00'
                )
                "#,
                [],
            )
            .unwrap();
        assert_eq!(duplicate_inserted, 1);
        let duplicate_count = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_events WHERE event_key = 'request-1'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(duplicate_count, 2);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failure_detail_migration_backfills_processed_inbox_rows_once() {
        let root = test_root("failure-detail-v4-migration");
        let mut connection = open_test_database(&root);
        let mut record = sample_record(
            "legacy-canceled",
            "2026-07-17T20:30:00+08:00",
            "gemini-test",
        );
        record.failed = true;
        insert_usage_records(&mut connection, &[record]).unwrap();
        connection
            .execute(
                r#"
                INSERT INTO usage_inbox (
                    source, message_hash, raw_message, status, attempt_count,
                    usage_event_key, received_at, processed_at, created_at, updated_at
                ) VALUES (
                    'test', 'legacy-canceled-hash', ?1, 'processed', 1,
                    'legacy-canceled', ?2, ?2, ?2, ?2
                )
                "#,
                params![
                    serde_json::json!({
                        "request_id": "legacy-canceled",
                        "failed": true,
                        "fail": {
                            "status_code": 499,
                            "body": "client closed request"
                        }
                    })
                    .to_string(),
                    Local::now().to_rfc3339(),
                ],
            )
            .unwrap();
        connection
            .execute(
                "DELETE FROM usage_metadata WHERE key = ?1",
                params![USAGE_FAILURE_MIGRATION_KEY],
            )
            .unwrap();
        // As a database from before the list of steps was.
        connection.pragma_update(None, "user_version", 6).unwrap();
        drop(connection);

        initialize_usage_storage_at(&root).unwrap();
        initialize_usage_storage_at(&root).unwrap();
        let connection = open_usage_database_at(&root).unwrap();
        let migrated = connection
            .query_row(
                r#"
                SELECT canceled, failure_status, failure_body
                FROM usage_events
                WHERE event_key = 'legacy-canceled'
                "#,
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        let markers = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_metadata WHERE key = ?1",
                params![USAGE_FAILURE_MIGRATION_KEY],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();

        assert_eq!(migrated.0, 1);
        assert_eq!(migrated.1, 499);
        assert_eq!(migrated.2, "client closed request");
        assert_eq!(markers, 1);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn durable_inbox_recovers_valid_rows_and_isolates_malformed_rows() {
        let root = test_root("durable-inbox");
        initialize_usage_storage_at(&root).unwrap();
        let mut connection = open_usage_database_at(&root).unwrap();
        enqueue_usage_queue_items(
            &mut connection,
            "http_pull",
            vec![
                serde_json::json!({
                    "timestamp": "2026-07-17T20:30:00+08:00",
                    "request_id": "request-1",
                    "model": "gpt-test",
                    "tokens": { "input_tokens": 10, "output_tokens": 20 }
                }),
                serde_json::json!("not-an-object"),
            ],
        )
        .unwrap();
        drop(connection);

        let mut connection = open_usage_database_at(&root).unwrap();
        let inserted = process_usage_inbox(&mut connection, &GuiConfigFile::default()).unwrap();
        let event_count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        let processed_count = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_inbox WHERE status = 'processed'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        let failed_count = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_inbox WHERE status = 'decode_failed'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();

        assert_eq!(inserted, 1);
        assert_eq!(event_count, 1);
        assert_eq!(processed_count, 1);
        assert_eq!(failed_count, 1);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn durable_inbox_preserves_multiple_events_with_same_request_id() {
        let root = test_root("durable-inbox-duplicate-request-id");
        initialize_usage_storage_at(&root).unwrap();
        let mut connection = open_usage_database_at(&root).unwrap();
        enqueue_usage_queue_items(
            &mut connection,
            "redis_subscribe:usage",
            vec![
                serde_json::json!({
                    "timestamp": "2026-07-17T20:30:00+08:00",
                    "request_id": "persistent-connection",
                    "model": "gpt-first",
                    "tokens": { "input_tokens": 10, "output_tokens": 20, "total_tokens": 30 }
                }),
                serde_json::json!({
                    "timestamp": "2026-07-17T20:31:00+08:00",
                    "request_id": "persistent-connection",
                    "model": "gpt-second",
                    "tokens": { "input_tokens": 30, "output_tokens": 40, "total_tokens": 70 }
                }),
            ],
        )
        .unwrap();

        let inserted = process_usage_inbox(&mut connection, &GuiConfigFile::default()).unwrap();
        assert_eq!(inserted, 2);
        let event_count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(event_count, 2);

        let rows = {
            let mut statement = connection
                .prepare("SELECT event_key, model, total_tokens FROM usage_events ORDER BY id")
                .unwrap();
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(
            rows,
            vec![
                (
                    "persistent-connection".to_string(),
                    "gpt-first".to_string(),
                    30
                ),
                (
                    "persistent-connection".to_string(),
                    "gpt-second".to_string(),
                    70
                ),
            ]
        );

        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inbox_cleanup_preserves_pending_and_recent_failure_rows() {
        let root = test_root("inbox-cleanup");
        let connection = open_test_database(&root);
        let now = Local::now();
        let old_processed = (now - chrono::Duration::days(1)).to_rfc3339();
        let recent_failure = (now - chrono::Duration::days(1)).to_rfc3339();
        let old_failure = (now - chrono::Duration::days(8)).to_rfc3339();
        for (status, processed_at, updated_at) in [
            (
                "processed",
                Some(old_processed.as_str()),
                old_processed.as_str(),
            ),
            ("pending", None, old_failure.as_str()),
            (
                "decode_failed",
                Some(recent_failure.as_str()),
                recent_failure.as_str(),
            ),
            (
                "discarded",
                Some(old_failure.as_str()),
                old_failure.as_str(),
            ),
        ] {
            connection
                .execute(
                    r#"
                    INSERT INTO usage_inbox (
                        source, message_hash, raw_message, status, attempt_count,
                        received_at, processed_at, created_at, updated_at
                    ) VALUES ('test', 'hash', '{}', ?1, 0, ?3, ?2, ?3, ?3)
                    "#,
                    params![status, processed_at, updated_at],
                )
                .unwrap();
        }

        cleanup_usage_inbox(&connection, now).unwrap();
        let statuses = {
            let mut statement = connection
                .prepare("SELECT status FROM usage_inbox ORDER BY id")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };

        assert_eq!(statuses, vec!["pending", "decode_failed"]);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn current_v3_database_migrates_unique_event_key_without_losing_rows() {
        let root = test_root("event-key-v5-migration");
        let mut connection = open_test_database(&root);
        let table_sql = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'usage_events'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let indexes = {
            let mut statement = connection
                .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_events'")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        for index in indexes {
            connection
                .execute(
                    &format!("DROP INDEX {}", quote_sqlite_identifier(&index)),
                    [],
                )
                .unwrap();
        }
        connection
            .execute(
                "ALTER TABLE usage_events RENAME TO usage_events_previous",
                [],
            )
            .unwrap();
        let unique_table_sql = replace_sql_fragment_case_insensitive(
            &table_sql,
            "event_key TEXT NOT NULL,",
            "event_key TEXT NOT NULL UNIQUE,",
        )
        .unwrap();
        connection.execute_batch(&unique_table_sql).unwrap();
        connection
            .execute("DROP TABLE usage_events_previous", [])
            .unwrap();

        // As a database from before the list of steps was.
        connection.pragma_update(None, "user_version", 6).unwrap();
        schema::migrate(&mut connection, &root).unwrap();
        connection
            .execute(
                "INSERT INTO usage_events (event_key, timestamp, timestamp_ms, local_hour, created_at) VALUES ('persistent', '2026-07-17T20:30:00+08:00', 1, '2026-07-17-20', '2026-07-17T20:30:00+08:00'), ('persistent', '2026-07-17T20:31:00+08:00', 2, '2026-07-17-20', '2026-07-17T20:31:00+08:00')",
                [],
            )
            .unwrap();
        let count = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_events WHERE event_key = 'persistent'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(count, 2);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM usage_metadata WHERE key = ?1",
                    params![USAGE_EVENT_KEY_MIGRATION_KEY],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_hour_and_inbox_json_are_migrated_once() {
        let root = test_root("legacy-migration");
        let events_dir = root.join(LEGACY_USAGE_EVENTS_DIR);
        let inbox_dir = root.join(LEGACY_USAGE_INBOX_DIR);
        fs::create_dir_all(&events_dir).unwrap();
        fs::create_dir_all(&inbox_dir).unwrap();
        let first = sample_record("request-1", "2026-07-17T20:30:00+08:00", "gpt-a");
        let second = sample_record("request-2", "2026-07-17T20:31:00+08:00", "gpt-b");
        fs::write(
            events_dir.join("2026-07-17-20.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": USAGE_SCHEMA_VERSION,
                "hour": "2026-07-17-20",
                "timezone": "+08:00",
                "records": [first]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            inbox_dir.join("pending.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": USAGE_SCHEMA_VERSION,
                "records": [second]
            }))
            .unwrap(),
        )
        .unwrap();

        initialize_usage_storage_at(&root).unwrap();
        initialize_usage_storage_at(&root).unwrap();
        let connection = open_usage_database_at(&root).unwrap();
        let count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        let marker = connection
            .query_row(
                "SELECT value FROM usage_metadata WHERE key = ?1",
                params![LEGACY_JSON_MIGRATION_KEY],
                |row| row.get::<_, String>(0),
            )
            .unwrap();

        assert_eq!(count, 2);
        assert_eq!(marker, "2");
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sqlite_queries_filter_aggregate_and_paginate() {
        let root = test_root("sqlite-query");
        let mut connection = open_test_database(&root);
        let success = sample_record("request-1", "2026-07-17T20:30:00+08:00", "gpt-a");
        let mut failed = sample_record("request-2", "2026-07-17T21:30:00+08:00", "gpt-5.6-terra");
        failed.failed = true;
        insert_usage_records(&mut connection, &[success, failed]).unwrap();
        let query = UsageQuery {
            model: Some("GPT-5.6-TERRA".to_string()),
            failed: Some(true),
            page_size: Some(20),
            ..UsageQuery::default()
        };

        let overview = load_usage_overview(&connection, &query).unwrap();
        let config = GuiConfigFile::default();
        let analysis = load_usage_analysis(&connection, &query, &config).unwrap();
        let events = load_usage_events(&connection, &query, &config).unwrap();

        assert_eq!(overview.total_requests, 1);
        assert_eq!(overview.failure_count, 1);
        assert_eq!(overview.tps, 0.0);
        assert_eq!(overview.tps_sample_count, 0);
        assert_eq!(overview.cache_hit_rate, 0.2);
        assert!((overview.estimated_cost - 0.0002564).abs() < 0.0000001);
        assert_eq!(overview.priced_requests, 1);
        assert_eq!(analysis.models[0].key, "gpt-5.6-terra");
        assert_eq!(events.total, 1);
        assert_eq!(events.items[0].id, "2");
        assert_eq!(events.items[0].request_id, "request-2");
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn overview_tps_uses_weighted_generation_time_and_ignores_invalid_records() {
        let root = test_root("tps-overview");
        let mut connection = open_test_database(&root);

        let mut first = sample_record("tps-1", "2026-07-17T20:30:00+08:00", "gpt-a");
        first.latency_ms = 1_000;
        first.ttft_ms = Some(200);
        first.tokens.output_tokens = 80;

        let mut second = sample_record("tps-2", "2026-07-17T20:31:00+08:00", "gpt-a");
        second.latency_ms = 2_000;
        second.ttft_ms = Some(1_000);
        second.tokens.output_tokens = 20;

        let mut missing_ttft = sample_record("tps-3", "2026-07-17T20:32:00+08:00", "gpt-a");
        missing_ttft.latency_ms = 500;
        missing_ttft.ttft_ms = None;
        missing_ttft.tokens.output_tokens = 100;

        let mut equal_latency = sample_record("tps-4", "2026-07-17T20:33:00+08:00", "gpt-a");
        equal_latency.latency_ms = 500;
        equal_latency.ttft_ms = Some(500);
        equal_latency.tokens.output_tokens = 100;

        let mut failed = sample_record("tps-5", "2026-07-17T20:34:00+08:00", "gpt-a");
        failed.failed = true;
        failed.tokens.output_tokens = 100;

        let mut canceled = sample_record("tps-6", "2026-07-17T20:35:00+08:00", "gpt-a");
        canceled.canceled = true;
        canceled.tokens.output_tokens = 100;

        let mut non_generation = sample_record("tps-7", "2026-07-17T20:36:00+08:00", "gpt-a");
        non_generation.generate = false;
        non_generation.tokens.output_tokens = 100;

        insert_usage_records(
            &mut connection,
            &[
                first,
                second,
                missing_ttft,
                equal_latency,
                failed,
                canceled,
                non_generation,
            ],
        )
        .unwrap();

        let overview = load_usage_overview(&connection, &UsageQuery::default()).unwrap();

        assert!((overview.tps - (100.0 * 1_000.0 / 1_800.0)).abs() < f64::EPSILON);
        assert_eq!(overview.tps_sample_count, 2);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn estimates_gpt56_cost_with_cache_and_service_tier_rules() {
        let terra = official_model_price("openai/gpt-5.6-terra").unwrap();
        let standard_tokens = CostTokens {
            input: 1_000_000,
            output: 1_000_000,
            cache_read: 200_000,
            cache_creation: 100_000,
            ..CostTokens::default()
        };
        let standard = cost_for_price("openai/gpt-5.6-terra", "default", &standard_tokens, &terra);
        assert!((standard - 13.69).abs() < 0.000001);

        let long_tokens = CostTokens {
            input: 300_000,
            output: 200_000,
            cache_read: 100_000,
            long_input: 300_000,
            long_output: 200_000,
            long_cache_read: 100_000,
            ..CostTokens::default()
        };
        let long_priority = cost_for_price("gpt-5.6-terra", "priority", &long_tokens, &terra);
        assert!((long_priority - 4.44).abs() < 0.000001);
        assert!(official_model_price("unpriced-model").is_none());
    }

    #[test]
    fn bundled_model_prices_are_available_offline_and_override_legacy_cloud_cache() {
        let root = test_root("bundled-pricing");
        let connection = open_test_database(&root);
        let bundled = bundled_model_prices().unwrap();
        assert!(bundled.len() >= 50);
        assert!(bundled.values().all(|price| price.source == "builtin"));
        assert_eq!(
            find_model_price(&bundled, "openai/gpt-5.6-terra-high")
                .unwrap()
                .prompt,
            2.0
        );

        upsert_model_price(
            &connection,
            &ModelPrice {
                model: "gpt-5.6-terra".to_string(),
                prompt: 999.0,
                completion: 999.0,
                prompt_configured: true,
                completion_configured: true,
                source: "litellm".to_string(),
                ..ModelPrice::default()
            },
        )
        .unwrap();
        let prices = load_model_prices(&connection).unwrap();
        assert_eq!(prices["gpt-5.6-terra"].prompt, 2.0);
        assert_eq!(prices["gpt-5.6-terra"].source, "builtin");
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manual_model_prices_drive_pricing_and_overview_cost() {
        let root = test_root("manual-pricing");
        let mut connection = open_test_database(&root);
        let record = sample_record("request-1", "2026-07-17T20:30:00+08:00", "custom-model");
        insert_usage_records(&mut connection, &[record]).unwrap();
        upsert_model_price(
            &connection,
            &ModelPrice {
                model: "custom-model".to_string(),
                prompt: 1.0,
                completion: 2.0,
                cache: 0.1,
                prompt_configured: true,
                completion_configured: true,
                source: "manual".to_string(),
                ..ModelPrice::default()
            },
        )
        .unwrap();

        let query = UsageQuery::default();
        let overview = load_usage_overview(&connection, &query).unwrap();
        let pricing = load_usage_pricing(&connection, &query).unwrap();

        assert!((overview.estimated_cost - 0.0000482).abs() < 0.0000001);
        assert_eq!(overview.priced_requests, 1);
        assert!((pricing.total_cost - overview.estimated_cost).abs() < f64::EPSILON);
        assert_eq!(pricing.rows[0].model, "custom-model");
        assert_eq!(
            pricing.saved_prices,
            bundled_model_prices().unwrap().len() + 1
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    fn test_price(model: &str, prompt: f64, source: &str) -> ModelPrice {
        ModelPrice {
            model: model.to_string(),
            prompt,
            completion: prompt * 5.0,
            prompt_configured: true,
            completion_configured: true,
            source: source.to_string(),
            ..ModelPrice::default()
        }
    }

    fn price_map(prices: impl IntoIterator<Item = ModelPrice>) -> HashMap<String, ModelPrice> {
        prices
            .into_iter()
            .map(|price| (price.model.clone(), price))
            .collect()
    }

    #[test]
    fn models_dev_prices_come_from_the_labs_only() {
        let catalog = r#"{
            "openrouter": { "models": { "gpt-6-sol": { "id": "openai/gpt-6-sol", "cost": { "input": 9, "output": 9 } } } },
            "openai": { "models": {
                "gpt-6-sol": { "id": "gpt-6-sol", "cost": { "input": 2, "output": 10, "cache_read": 0.2, "cache_write": 2.5 } },
                "gpt-free": { "id": "gpt-free", "cost": { "input": 0, "output": 0 } },
                "text-embedding-3-small": { "id": "text-embedding-3-small" }
            } },
            "anthropic": { "models": { "claude-opus-5-5": { "id": "claude-opus-5-5", "cost": { "input": 4, "output": 20, "cache_read": 0.2 } } } },
            "google": { "name": "Google" }
        }"#;
        let prices = parse_models_dev_prices(catalog, 7).unwrap();
        assert_eq!(
            prices.keys().map(String::as_str).collect::<BTreeSet<_>>(),
            BTreeSet::from(["claude-opus-5-5", "gpt-6-sol"])
        );
        let sol = &prices["gpt-6-sol"];
        assert_eq!(
            (sol.prompt, sol.completion, sol.cache_read, sol.cache_creation),
            (2.0, 10.0, 0.2, 2.5)
        );
        assert_eq!(
            (sol.source.as_str(), sol.source_model_id.as_str(), sol.updated_at_ms),
            ("models.dev", "openai/gpt-6-sol", 7)
        );
        let opus = &prices["claude-opus-5-5"];
        assert!(opus.cache_read_configured && !opus.cache_creation_configured);
        assert!(parse_models_dev_prices(r#"{ "openrouter": { "models": {} } }"#, 7).is_err());
        assert!(parse_models_dev_prices("not json", 7).is_err());
    }

    #[test]
    fn sync_fills_only_models_the_catalog_lacks_or_can_only_guess() {
        let curated = price_map([
            test_price("claude-opus-5", 5.0, "builtin"),
            test_price("claude-haiku-4-5", 1.0, "builtin"),
            test_price("custom-model", 3.0, "manual"),
        ]);
        let models_dev = price_map([
            test_price("claude-opus-5", 5.5, "models.dev"),
            test_price("claude-opus-5-5", 4.0, "models.dev"),
            test_price("claude-haiku-4-5", 1.5, "models.dev"),
            test_price("gpt-6-sol", 2.0, "models.dev"),
            test_price("custom-model", 9.0, "models.dev"),
        ]);
        let used = [
            "claude-opus-5",
            "claude-opus-5-5",
            "claude-opus-5-5-20261001",
            "claude-haiku-4-5-20251001",
            "gpt-6-sol",
            "custom-model",
            "codex-auto-review",
        ]
        .map(String::from)
        .into_iter()
        .collect::<BTreeSet<_>>();

        let fills = model_price_fills(&used, &curated, &models_dev);
        // Opus 5.5 was priced as Opus 5 before; its dated name finds the closer
        // match too. Haiku's dated name keeps the catalog's guess, since
        // models.dev can only make the same one.
        assert_eq!(
            fills
                .iter()
                .map(|price| (price.model.as_str(), price.prompt))
                .collect::<Vec<_>>(),
            vec![
                ("claude-opus-5-5", 4.0),
                ("claude-opus-5-5-20261001", 4.0),
                ("gpt-6-sol", 2.0)
            ]
        );
        assert!(fills.iter().all(|price| price.source == "models.dev"));
    }

    #[test]
    fn filled_prices_are_replaced_on_each_sync_and_never_beat_the_catalog() {
        let root = test_root("filled-pricing");
        let mut connection = open_test_database(&root);
        insert_usage_records(
            &mut connection,
            &[
                sample_record("request-1", "2026-09-23T10:00:00+10:00", "gpt-7-nova"),
                sample_record("request-2", "2026-09-23T10:01:00+10:00", "claude-opus-5"),
                sample_record("request-3", "2026-09-23T10:02:00+10:00", "custom-model"),
            ],
        )
        .unwrap();
        for price in [
            test_price("custom-model", 3.0, "manual"),
            test_price("retired-model", 1.0, "models.dev"),
            test_price("claude-opus-5", 99.0, "models.dev"),
        ] {
            upsert_model_price(&connection, &price).unwrap();
        }
        assert_eq!(load_model_prices(&connection).unwrap()["claude-opus-5"].prompt, 99.0);
        assert_eq!(
            load_saved_model_prices(&connection, false).unwrap()["claude-opus-5"].prompt,
            5.0
        );

        let models_dev = price_map([
            test_price("gpt-7-nova", 3.0, "models.dev"),
            test_price("claude-opus-5", 99.0, "models.dev"),
            test_price("custom-model", 99.0, "models.dev"),
        ]);
        assert_eq!(
            replace_filled_model_prices(&mut connection, &models_dev).unwrap(),
            vec!["gpt-7-nova".to_string()]
        );
        let prices = load_model_prices(&connection).unwrap();
        assert_eq!(
            (prices["gpt-7-nova"].prompt, prices["gpt-7-nova"].source.as_str()),
            (3.0, "models.dev")
        );
        assert_eq!(
            (prices["claude-opus-5"].prompt, prices["claude-opus-5"].source.as_str()),
            (5.0, "builtin")
        );
        assert_eq!(prices["custom-model"].source, "manual");
        assert!(!prices.contains_key("retired-model"));
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn new_models_are_priced_from_the_bundled_catalog() {
        let bundled = bundled_model_prices().unwrap();
        for (model, prompt, completion) in [
            ("gpt-6-sol", 2.0, 10.0),
            ("gpt-6-luna", 0.1, 0.5),
            ("claude-opus-5-5", 4.0, 20.0),
        ] {
            let (price, found) = match_model_price(&bundled, model).unwrap();
            assert_eq!(found, PriceMatch::Exact, "{model}");
            assert_eq!((price.prompt, price.completion), (prompt, completion), "{model}");
        }
        // The fast tier costs twice as much for the GPT-6 models.
        let tokens = CostTokens {
            input: 1_000_000,
            output: 1_000_000,
            ..CostTokens::default()
        };
        let sol = &bundled["gpt-6-sol"];
        assert!((cost_for_price("gpt-6-sol", "default", &tokens, sol) - 12.0).abs() < 0.000001);
        assert!((cost_for_price("gpt-6-sol", "priority", &tokens, sol) - 24.0).abs() < 0.000001);
    }

    #[test]
    fn long_context_rates_only_apply_to_the_models_that_charge_them() {
        let root = test_root("long-context-pricing");
        let mut connection = open_test_database(&root);
        let request = |id: &str, model: &str, input: u64| {
            let mut record = sample_record(id, "2026-09-24T10:00:00+10:00", model);
            record.tokens = UsageTokenStats {
                input_tokens: input,
                output_tokens: 1_000,
                total_tokens: input + 1_000,
                ..UsageTokenStats::default()
            };
            record.lineage.session_id = Some(format!("session-{id}"));
            record
        };
        insert_usage_records(
            &mut connection,
            &[
                // Claude 5 bills a request the same however long it is.
                request("opus", "claude-opus-5-5", 300_000),
                // GPT-6 bills 2× input and 1.5× output above 272k, and not below.
                request("sol-long", "gpt-6-sol", 300_000),
                request("sol-short", "gpt-6-sol", 250_000),
                // Sonnet 4.5's long-context rates start at 200k.
                request("sonnet", "claude-sonnet-4-5", 250_000),
                request("sonnet-1m", "claude-sonnet-4-5[1m]", 250_000),
            ],
        )
        .unwrap();

        let query = UsageQuery::default();
        let pricing = load_usage_pricing(&connection, &query).unwrap();
        let cost = |model: &str| {
            pricing
                .rows
                .iter()
                .find(|row| row.model == model)
                .unwrap()
                .estimated_cost
        };
        // 300k × $4 + 1k × $20
        assert!((cost("claude-opus-5-5") - 1.22).abs() < 0.000001);
        // 300k × $2 × 2 + 1k × $10 × 1.5, plus 250k × $2 + 1k × $10
        assert!((cost("gpt-6-sol") - (1.215 + 0.51)).abs() < 0.000001);
        // 250k × $3 × 2 + 1k × $15 × 1.5
        assert!((cost("claude-sonnet-4-5") - 1.5225).abs() < 0.000001);
        assert!((cost("claude-sonnet-4-5[1m]") - 1.5225).abs() < 0.000001);

        // Sessions read the same sums, after columns of their own.
        let sessions =
            load_usage_sessions(&connection, &query, &GuiConfigFile::default(), 0).unwrap();
        assert_eq!(sessions.summary.sessions, 5);
        assert!((sessions.summary.estimated_cost - pricing.total_cost).abs() < 0.000001);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    fn session_column_rows(connection: &Connection) -> Vec<(String, String, i64, Option<String>)> {
        let mut statement = connection
            .prepare(
                "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('usage_events')",
            )
            .unwrap();
        let columns = statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        USAGE_SESSION_COLUMNS
            .iter()
            .map(|(column, _)| {
                let matches = columns
                    .iter()
                    .filter(|(name, ..)| name == column)
                    .cloned()
                    .collect::<Vec<(String, String, i64, Option<String>)>>();
                assert_eq!(matches.len(), 1, "{column}");
                matches[0].clone()
            })
            .collect()
    }

    fn expected_session_columns() -> Vec<(String, String, i64, Option<String>)> {
        USAGE_SESSION_COLUMNS
            .iter()
            .map(|(column, definition)| (column.to_string(), definition.to_string(), 0, None))
            .collect()
    }

    #[test]
    fn normalizes_session_and_lineage_fields_without_exposing_them_to_the_ui() {
        let config = GuiConfigFile::default();
        let record = normalize_usage_record(
            serde_json::json!({
                "request_id": "lineage",
                "session_id": " 7a4be3a1-5c1f-4f0e-9d62-3c1d2f7e8a01 ",
                "parent_session_id": "7a4be3a1-5c1f-4f0e-9d62-3c1d2f7e8a00",
                "response_model": "gpt-5.6-terra-2026-09-01",
                "node_kind": "subagent",
                "is_fork": true,
                "is_compaction": false
            }),
            &config,
        )
        .unwrap();
        assert_eq!(
            record.lineage,
            UsageLineage {
                session_id: Some("7a4be3a1-5c1f-4f0e-9d62-3c1d2f7e8a01".to_string()),
                parent_session_id: Some("7a4be3a1-5c1f-4f0e-9d62-3c1d2f7e8a00".to_string()),
                response_model: Some("gpt-5.6-terra-2026-09-01".to_string()),
                node_kind: Some("subagent".to_string()),
                is_fork: Some(true),
                is_compaction: Some(false),
            }
        );
        let rendered = serde_json::to_value(&record).unwrap();
        for field in [
            "lineage",
            "session_id",
            "parent_session_id",
            "response_model",
            "node_kind",
            "is_fork",
            "is_compaction",
        ] {
            assert!(
                rendered.get(field).is_none(),
                "{field} reached the UI record"
            );
        }

        let blank = normalize_usage_record(
            serde_json::json!({
                "request_id": "blank-lineage",
                "session_id": "  ",
                "parent_session_id": "",
                "node_kind": null,
                "is_fork": "true"
            }),
            &config,
        )
        .unwrap();
        assert_eq!(blank.lineage, UsageLineage::default());
    }

    #[test]
    fn stores_session_and_lineage_fields_and_nulls_for_missing_ones() {
        let root = test_root("session-lineage-storage");
        initialize_usage_storage_at(&root).unwrap();
        let inserted = persist_queue_items(
            &root,
            vec![
                serde_json::json!({
                    "timestamp": "2026-09-22T10:00:00+10:00",
                    "request_id": "with-lineage",
                    "model": "gpt-test",
                    "session_id": "session-1",
                    "parent_session_id": "session-0",
                    "response_model": "gpt-test-2026-09-01",
                    "node_kind": "main",
                    "is_fork": true,
                    "is_compaction": false
                }),
                serde_json::json!({
                    "timestamp": "2026-09-22T10:00:01+10:00",
                    "request_id": "without-lineage",
                    "model": "gpt-test",
                    "session_id": "",
                    "response_model": " "
                }),
            ],
            &GuiConfigFile::default(),
        )
        .unwrap();
        assert_eq!(inserted, 2);

        type LineageRow = (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<i64>,
        );
        let connection = open_usage_database_at(&root).unwrap();
        let rows = {
            let mut statement = connection
                .prepare(
                    r#"
                    SELECT request_id, session_id, parent_session_id, response_model,
                           node_kind, is_fork, is_compaction
                    FROM usage_events ORDER BY request_id
                    "#,
                )
                .unwrap();
            statement
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<LineageRow>, _>>()
                .unwrap()
        };
        assert_eq!(
            rows,
            vec![
                (
                    "with-lineage".to_string(),
                    Some("session-1".to_string()),
                    Some("session-0".to_string()),
                    Some("gpt-test-2026-09-01".to_string()),
                    Some("main".to_string()),
                    Some(1),
                    Some(0),
                ),
                (
                    "without-lineage".to_string(),
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                ),
            ]
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_columns_migrate_idempotently_and_backfill_todays_inbox_once() {
        let root = test_root("session-lineage-migration");
        let mut connection = open_test_database(&root);
        assert_eq!(session_column_rows(&connection), expected_session_columns());
        insert_usage_records(
            &mut connection,
            &[
                sample_record("retried", "2026-09-22T10:00:00+10:00", "gpt-test"),
                sample_record("retried", "2026-09-22T10:00:05+10:00", "gpt-test"),
                sample_record("not-in-inbox", "2026-09-22T10:00:09+10:00", "gpt-test"),
            ],
        )
        .unwrap();
        let processed_at = Local::now().to_rfc3339();
        connection
            .execute(
                r#"
                INSERT INTO usage_inbox (
                    source, message_hash, raw_message, status, attempt_count,
                    usage_event_key, received_at, processed_at, created_at, updated_at
                ) VALUES ('test', 'hash', ?1, 'processed', 1, 'retried', ?2, ?2, ?2, ?2)
                "#,
                params![
                    serde_json::json!({
                        "timestamp": "2026-09-22T10:00:00+10:00",
                        "request_id": "retried",
                        "session_id": "session-1",
                        "is_compaction": true
                    })
                    .to_string(),
                    processed_at,
                ],
            )
            .unwrap();
        // Recreate a database from before the migration. SQLite refuses to drop
        // an indexed column, and those databases had no session indexes either.
        connection
            .execute_batch(
                "DROP INDEX idx_usage_events_session; DROP INDEX idx_usage_events_parent_session;",
            )
            .unwrap();
        for (column, _) in USAGE_SESSION_COLUMNS {
            connection
                .execute(
                    &format!("ALTER TABLE usage_events DROP COLUMN {column}"),
                    [],
                )
                .unwrap();
        }
        connection
            .execute(
                "DELETE FROM usage_metadata WHERE key = ?1",
                params![USAGE_SESSION_MIGRATION_KEY],
            )
            .unwrap();
        // As a database from before the list of steps was.
        connection.pragma_update(None, "user_version", 6).unwrap();
        drop(connection);

        initialize_usage_storage_at(&root).unwrap();
        let connection = open_usage_database_at(&root).unwrap();
        let lineage = |connection: &Connection| {
            let mut statement = connection
                .prepare(
                    "SELECT event_key, timestamp, session_id, is_compaction FROM usage_events ORDER BY id",
                )
                .unwrap();
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(session_column_rows(&connection), expected_session_columns());
        assert_eq!(session_index_rows(&connection).len(), 2);
        assert_eq!(
            lineage(&connection),
            vec![
                (
                    "retried".to_string(),
                    "2026-09-22T10:00:00+10:00".to_string(),
                    Some("session-1".to_string()),
                    Some(1),
                ),
                (
                    "retried".to_string(),
                    "2026-09-22T10:00:05+10:00".to_string(),
                    None,
                    None,
                ),
                (
                    "not-in-inbox".to_string(),
                    "2026-09-22T10:00:09+10:00".to_string(),
                    None,
                    None,
                ),
            ]
        );
        connection
            .execute(
                "UPDATE usage_events SET session_id = NULL, is_compaction = NULL",
                [],
            )
            .unwrap();
        // As a database from before the list of steps was.
        connection.pragma_update(None, "user_version", 6).unwrap();
        drop(connection);

        initialize_usage_storage_at(&root).unwrap();
        let connection = open_usage_database_at(&root).unwrap();
        assert_eq!(session_column_rows(&connection), expected_session_columns());
        assert!(lineage(&connection)
            .iter()
            .all(|(_, _, session_id, _)| session_id.is_none()));
        let (markers, user_version) = (
            connection
                .query_row(
                    "SELECT COUNT(*) FROM usage_metadata WHERE key = ?1",
                    params![USAGE_SESSION_MIGRATION_KEY],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
        );
        assert_eq!(markers, 1);
        assert_eq!(user_version, LATEST);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    fn session_index_rows(connection: &Connection) -> Vec<(String, String)> {
        let mut statement = connection
            .prepare(
                r#"
                SELECT name, sql FROM sqlite_master
                WHERE type = 'index'
                  AND name IN ('idx_usage_events_session', 'idx_usage_events_parent_session')
                ORDER BY name
                "#,
            )
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    // The id shapes core 7.3.15 sends: a Claude Code session is a v4 UUID and
    // its subagents are v8 UUIDs; Codex conversations are v7 UUIDs.
    const CLAUDE_MAIN: &str = "5f0c2a8e-3b1d-4c6f-9e2a-7d4b1c8e0f31";
    const CLAUDE_AGENT_A: &str = "5f0c2a8e-3b1d-8c6f-9e2a-7d4b1c8e0fa1";
    const CLAUDE_AGENT_B: &str = "5f0c2a8e-3b1d-8c6f-9e2a-7d4b1c8e0fb2";
    const CLAUDE_NESTED: &str = "5f0c2a8e-3b1d-8c6f-9e2a-7d4b1c8e0fc3";
    const CODEX_ROOT: &str = "01997a4e-6c2b-7d1e-8f3a-2b4c6d8e0a10";
    const CODEX_CHILD: &str = "01997a4e-6c2b-7d1e-8f3a-2b4c6d8e0a11";
    const CODEX_UNSEEN_PARENT: &str = "01997a4e-6c2b-7d1e-8f3a-2b4c6d8e0a00";
    const SESSION_T0: i64 = 1_790_000_000_000;

    #[derive(Clone)]
    struct SessionRow<'a> {
        session: Option<&'a str>,
        parent: Option<&'a str>,
        timestamp_ms: i64,
        latency_ms: i64,
        model: &'a str,
        provider: &'a str,
        service_tier: &'a str,
        response_service_tier: &'a str,
        input_tokens: i64,
        output_tokens: i64,
        reasoning_tokens: i64,
        cache_read_tokens: i64,
        cache_creation_tokens: i64,
        total_tokens: i64,
        failed: bool,
        canceled: bool,
        failure_status: i64,
        failure_body: &'a str,
        reasoning_effort: &'a str,
        user_agent: Option<&'a str>,
        api_key_hash: &'a str,
        auth_index: &'a str,
    }

    fn session_row<'a>(
        session: &'a str,
        parent: Option<&'a str>,
        timestamp_ms: i64,
    ) -> SessionRow<'a> {
        SessionRow {
            session: Some(session),
            parent,
            timestamp_ms,
            latency_ms: 1_000,
            model: "claude-opus-4-5",
            provider: "claude",
            service_tier: "",
            response_service_tier: "",
            input_tokens: 1_000,
            output_tokens: 100,
            reasoning_tokens: 10,
            cache_read_tokens: 400,
            cache_creation_tokens: 0,
            total_tokens: 1_100,
            failed: false,
            canceled: false,
            failure_status: 0,
            failure_body: "",
            reasoning_effort: "",
            user_agent: None,
            api_key_hash: "",
            auth_index: "",
        }
    }

    fn insert_session_rows(connection: &Connection, rows: &[SessionRow]) {
        for row in rows {
            connection
                .execute(
                    r#"
                    INSERT INTO usage_events (
                        event_key, timestamp, timestamp_ms, latency_ms, local_hour, created_at,
                        session_id, parent_session_id, model, provider, service_tier,
                        response_service_tier, input_tokens, output_tokens, reasoning_tokens,
                        cache_read_tokens, total_tokens, failed, canceled, user_agent,
                        api_key_hash, cache_creation_tokens, failure_status, failure_body,
                        reasoning_effort, auth_index
                    ) VALUES (
                        'session-row', '2026-09-22T00:00:00Z', ?1, ?2, '2026-09-22-00', 'now',
                        ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                        ?18, ?19, ?20, ?21, ?22
                    )
                    "#,
                    params![
                        row.timestamp_ms,
                        row.latency_ms,
                        row.session,
                        row.parent,
                        row.model,
                        row.provider,
                        row.service_tier,
                        row.response_service_tier,
                        row.input_tokens,
                        row.output_tokens,
                        row.reasoning_tokens,
                        row.cache_read_tokens,
                        row.total_tokens,
                        row.failed,
                        row.canceled,
                        row.user_agent,
                        row.api_key_hash,
                        row.cache_creation_tokens,
                        row.failure_status,
                        row.failure_body,
                        row.reasoning_effort,
                        row.auth_index,
                    ],
                )
                .unwrap();
        }
    }

    fn session_test_database(rows: &[SessionRow]) -> Connection {
        let connection = schema::test_database();
        insert_session_rows(&connection, rows);
        connection
    }

    /// A thread's peak context and compactions from its contexts alone, a minute apart, with no transcript.
    fn conversation_context_stats(contexts: &[u64]) -> (u64, usize) {
        let requests = contexts
            .iter()
            .enumerate()
            .map(|(index, &context)| session_read::ThreadRequest {
                timestamp_ms: index as i64 * 60_000,
                context,
                model: String::new(),
                user_agent: String::new(),
            })
            .collect::<Vec<_>>();
        session_read::thread_context(&requests, &[])
    }

    #[test]
    fn a_conversation_that_keeps_growing_is_never_compacted() {
        let steps = follow_conversation(&[30_000, 60_000, 120_000, 240_000, 250_000]);
        assert!(steps.iter().all(|step| *step == ContextStep::Conversation));
        assert_eq!(conversation_context_stats(&[30_000, 60_000, 240_000]), (240_000, 0));
    }

    #[test]
    fn a_sustained_drop_is_a_compaction_and_a_passing_one_a_side_request() {
        use ContextStep::{Compacted, Conversation, Side};
        let contexts = [
            100_000, 150_000, // the conversation
            7_000,            // a side request (a title, say)
            152_000, 160_000, // the conversation carries on
            20_000, 30_000,   // two side requests in a row
            162_000,          // and on again
            40_000,           // compacted: it never goes back up
            45_000, 50_000, 60_000, 70_000, 80_000, 90_000,
        ];
        assert_eq!(
            follow_conversation(&contexts),
            [
                Conversation, Conversation, Side, Conversation, Conversation, Side, Side,
                Conversation, Compacted, Conversation, Conversation, Conversation, Conversation,
                Conversation, Conversation,
            ]
        );
        // Side requests never set the peak, and compare against the conversation, not each other.
        assert_eq!(conversation_context_stats(&contexts), (162_000, 1));
    }

    #[test]
    fn small_contexts_and_a_final_drop_are_judged_on_what_is_known() {
        use ContextStep::{Compacted, Conversation};
        // Under COMPACTION_MIN_CONTEXT a drop is just a smaller request.
        assert_eq!(follow_conversation(&[19_000, 2_000, 3_000]), [Conversation; 3]);
        // A drop at the end has nothing after it to show it was a side request.
        assert_eq!(follow_conversation(&[300_000, 70_000]), [Conversation, Compacted]);
        // Exactly half isn't under half.
        assert_eq!(follow_conversation(&[100_000, 50_000]), [Conversation, Conversation]);
    }

    #[test]
    fn a_session_timeline_has_every_request_with_its_cost_and_step() {
        let root = "session-root";
        let child = "session-child";
        let request = |session: &'static str, parent: Option<&'static str>, minute: i64, input: i64| {
            let mut row = session_row(session, parent, SESSION_T0 + minute * 60_000);
            row.model = "claude-opus-5-5";
            row.input_tokens = input;
            row.cache_read_tokens = input / 2;
            row.cache_creation_tokens = input / 4;
            row.output_tokens = 1_000;
            row.total_tokens = input + 1_000;
            row.reasoning_effort = "xhigh";
            row
        };
        let overloaded = "overloaded ".repeat(100);
        let mut failed = request(root, None, 5, 0);
        failed.failed = true;
        failed.failure_status = 529;
        failed.failure_body = &overloaded;
        failed.output_tokens = 0;
        failed.total_tokens = 0;
        let mut side = request(root, None, 3, 8_000);
        side.reasoning_effort = "";
        let connection = session_test_database(&[
            request(root, None, 0, 100_000),
            request(root, None, 1, 200_000),
            request(root, None, 2, 300_000),
            side,
            request(root, None, 4, 310_000),
            failed,
            request(child, Some(root), 6, 50_000),
            request(root, None, 7, 60_000),
            request(root, None, 8, 70_000),
            request("another-session", None, 9, 70_000),
        ]);
        let now_ms = SESSION_T0 + 24 * 3_600_000;
        let timeline =
            load_usage_session_timeline(&connection, root, &GuiConfigFile::default(), now_ms).unwrap();

        assert!(!timeline.truncated);
        let steps = timeline
            .requests
            .iter()
            .map(|request| (request.thread_id.as_str(), request.step))
            .collect::<Vec<_>>();
        use ContextStep::{Compacted, Conversation, Side};
        assert_eq!(
            steps,
            [
                (root, Some(Conversation)),
                (root, Some(Conversation)),
                (root, Some(Conversation)),
                (root, Some(Side)),
                (root, Some(Conversation)),
                (root, None),
                (child, Some(Conversation)),
                (root, Some(Compacted)),
                (root, Some(Conversation)),
            ]
        );
        // 300k in: 75k uncached × $4, 150k read × $0.20, 75k written × $5; 1k out × $20.
        let cost = timeline.requests[2].cost.unwrap();
        assert!((cost.input - 0.3).abs() < 0.000001);
        assert!((cost.cache_read - 0.03).abs() < 0.000001);
        assert!((cost.cache_write - 0.375).abs() < 0.000001);
        assert!((cost.output - 0.02).abs() < 0.000001);
        assert_eq!(timeline.requests[2].reasoning_effort, "xhigh");
        // Claude 5 bills every size the same.
        assert!(timeline.requests.iter().all(|request| !request.long_context));
        assert!(timeline.long_context_thresholds.is_empty());
        let failure = &timeline.requests[5];
        assert!(failure.failed);
        assert_eq!(failure.failure_status, 529);
        assert_eq!(failure.failure.chars().count(), SESSION_TIMELINE_FAILURE_CHARS);
        assert!(timeline.requests[4].failure.is_empty());

        // The list's numbers for the same session.
        let session = timeline.session.unwrap();
        assert_eq!(session.root.id, root);
        assert_eq!((session.root.peak_context, session.root.compactions), (310_000, 1));
        let thread = session.threads.iter().find(|thread| thread.id == child).unwrap();
        assert_eq!((thread.peak_context, thread.compactions), (50_000, 0));
    }

    #[test]
    fn a_session_timeline_marks_requests_billed_at_long_context_rates() {
        let rows = [250_000, 300_000].map(|input| {
            let mut row = session_row("codex-session", None, SESSION_T0 + input);
            row.model = "gpt-6-sol";
            row.provider = "codex";
            row.input_tokens = input;
            row
        });
        let connection = session_test_database(&rows);
        let timeline = load_usage_session_timeline(
            &connection,
            "codex-session",
            &GuiConfigFile::default(),
            SESSION_T0,
        )
        .unwrap();
        let long = timeline
            .requests
            .iter()
            .map(|request| request.long_context)
            .collect::<Vec<_>>();
        assert_eq!(long, [false, true]);
        assert_eq!(
            timeline.long_context_thresholds,
            HashMap::from([("gpt-6-sol".to_string(), 272_000)])
        );
    }

    #[test]
    fn session_context_stats_ignore_the_list_filters() {
        let root = "session-root";
        let mut rows = [100_000, 200_000, 300_000, 60_000, 70_000]
            .into_iter()
            .enumerate()
            .map(|(minute, input)| {
                let mut row = session_row(root, None, SESSION_T0 + minute as i64 * 60_000);
                row.input_tokens = input;
                row
            })
            .collect::<Vec<_>>();
        rows[3].model = "claude-opus-5-5";
        let connection = session_test_database(&rows);
        // Filtered to the one model the compacted request used, the thread still
        // shows its real peak and its compaction.
        let page = load_test_sessions(
            &connection,
            UsageQuery {
                model: Some("claude-opus-5-5".to_string()),
                ..UsageQuery::default()
            },
        );
        assert_eq!(page.items.len(), 1);
        assert_eq!((page.items[0].root.peak_context, page.items[0].root.compactions), (300_000, 1));
    }

    fn load_test_sessions(connection: &Connection, query: UsageQuery) -> UsageSessionPage {
        let now_ms = SESSION_T0 + 24 * 3_600_000;
        load_usage_sessions(connection, &query, &GuiConfigFile::default(), now_ms).unwrap()
    }

    fn rfc3339_millis(timestamp_ms: i64) -> String {
        DateTime::<chrono::Utc>::from_timestamp_millis(timestamp_ms)
            .unwrap()
            .to_rfc3339()
    }

    fn thread_ids(session: &UsageSession) -> Vec<&str> {
        session
            .threads
            .iter()
            .map(|thread| thread.id.as_str())
            .collect()
    }

    fn thread_depths(session: &UsageSession) -> Vec<usize> {
        session.threads.iter().map(|thread| thread.depth).collect()
    }

    fn thread_parents(session: &UsageSession) -> Vec<Option<&str>> {
        session
            .threads
            .iter()
            .map(|thread| thread.parent_id.as_deref())
            .collect()
    }

    #[test]
    fn sessions_roll_subagents_up_under_their_main_session() {
        let main_row = SessionRow {
            user_agent: Some("claude-cli/2.1.0 (external, cli)"),
            api_key_hash: "mini-hash",
            ..session_row(CLAUDE_MAIN, None, SESSION_T0)
        };
        let agent_row = |id, parent, timestamp_ms| SessionRow {
            model: "claude-haiku-4-5",
            user_agent: Some("claude-cli/2.1.0 (subagent)"),
            ..session_row(id, Some(parent), timestamp_ms)
        };
        let connection = session_test_database(&[
            main_row.clone(),
            SessionRow {
                timestamp_ms: SESSION_T0 + 10_000,
                failed: true,
                ..main_row
            },
            agent_row(CLAUDE_AGENT_A, CLAUDE_MAIN, SESSION_T0 + 20_000),
            SessionRow {
                failed: true,
                canceled: true,
                ..agent_row(CLAUDE_AGENT_A, CLAUDE_MAIN, SESSION_T0 + 30_000)
            },
            agent_row(CLAUDE_AGENT_B, CLAUDE_MAIN, SESSION_T0 + 25_000),
            SessionRow {
                latency_ms: 5_000,
                ..agent_row(CLAUDE_NESTED, CLAUDE_AGENT_A, SESSION_T0 + 40_000)
            },
            session_row(CODEX_ROOT, None, SESSION_T0 + 5_000),
        ]);
        connection
            .execute(
                "INSERT INTO usage_machine_assignments VALUES ('mini-hash', 'mini', 'Mac Mini', 'Local')",
                [],
            )
            .unwrap();

        let page = load_test_sessions(&connection, UsageQuery::default());
        assert_eq!(
            (page.total, page.page, page.page_size, page.total_pages),
            (2, 1, 50, 1)
        );
        let main = &page.items[0];
        assert_eq!(main.root.id, CLAUDE_MAIN);
        assert_eq!(
            thread_ids(main),
            [CLAUDE_MAIN, CLAUDE_AGENT_A, CLAUDE_NESTED, CLAUDE_AGENT_B]
        );
        assert_eq!(thread_depths(main), [0, 1, 2, 1]);
        assert_eq!(
            thread_parents(main),
            [
                None,
                Some(CLAUDE_MAIN),
                Some(CLAUDE_AGENT_A),
                Some(CLAUDE_MAIN)
            ]
        );
        assert!(main.has_own_requests);
        assert_eq!(main.subagents, 3);
        assert_eq!((main.root.parent_id.as_deref(), main.root.depth), (None, 0));
        let totals = &main.root.totals;
        assert_eq!(
            (totals.requests, totals.failures, totals.canceled),
            (6, 1, 1)
        );
        assert_eq!(
            (
                totals.input_tokens,
                totals.output_tokens,
                totals.reasoning_tokens,
                totals.cache_read_tokens,
                totals.total_tokens
            ),
            (6_000, 600, 60, 2_400, 6_600)
        );
        assert_eq!(
            (totals.started_at_ms, totals.last_active_at_ms),
            (SESSION_T0, SESSION_T0 + 45_000)
        );
        assert_eq!(main.root.models, ["claude-haiku-4-5", "claude-opus-4-5"]);
        assert_eq!(main.root.providers, ["claude"]);
        assert_eq!(main.provider, "claude");
        assert_eq!(
            main.root.user_agent.as_deref(),
            Some("claude-cli/2.1.0 (external, cli)")
        );
        assert_eq!(
            (&*main.api_key_hash, &*main.machine, &*main.pool),
            ("mini-hash", "Mac Mini", "Local")
        );
        let agent_a = &main.threads[1];
        assert_eq!(agent_a.totals.requests, 2);
        assert_eq!(agent_a.models, ["claude-haiku-4-5"]);
        assert_eq!(
            (
                agent_a.totals.started_at_ms,
                agent_a.totals.last_active_at_ms
            ),
            (SESSION_T0 + 20_000, SESSION_T0 + 31_000)
        );
        assert_eq!(
            main.threads
                .iter()
                .map(|thread| thread.totals.total_tokens)
                .sum::<u64>(),
            totals.total_tokens
        );

        let codex = &page.items[1];
        assert_eq!(thread_ids(codex), [CODEX_ROOT]);
        assert_eq!(
            (codex.subagents, &*codex.machine, &*codex.pool),
            (0, "", "")
        );
        assert_eq!(
            (
                page.summary.sessions,
                page.summary.subagent_threads,
                page.summary.requests,
                page.summary.total_tokens,
                page.summary.untracked_requests
            ),
            (2, 3, 7, 7_700, 0)
        );

        let json = serde_json::to_value(&page).unwrap();
        let keys = |value: &Value| {
            let mut keys = value
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>();
            keys.sort();
            keys
        };
        let mut thread_keys = vec![
            "id",
            "parentId",
            "depth",
            "models",
            "providers",
            "userAgent",
            "startedAtMs",
            "lastActiveAtMs",
            "requests",
            "failures",
            "canceled",
            "inputTokens",
            "outputTokens",
            "reasoningTokens",
            "cacheReadTokens",
            "cacheCreationTokens",
            "totalTokens",
            "estimatedCost",
            "pricedRequests",
            "peakContext",
            "compactions",
        ];
        let mut session_keys = thread_keys.clone();
        session_keys.extend([
            "provider",
            "machine",
            "pool",
            "apiKeyHash",
            "active",
            "hasOwnRequests",
            "subagents",
            "threads",
            "transcript",
        ]);
        thread_keys.sort_unstable();
        session_keys.sort_unstable();
        assert_eq!(
            keys(&json),
            [
                "items",
                "page",
                "pageSize",
                "summary",
                "total",
                "totalPages"
            ]
        );
        assert_eq!(
            keys(&json["summary"]),
            [
                "active",
                "estimatedCost",
                "pricedRequests",
                "requests",
                "sessions",
                "subagentThreads",
                "totalTokens",
                "untrackedRequests"
            ]
        );
        assert_eq!(keys(&json["items"][0]), session_keys);
        assert_eq!(keys(&json["items"][0]["threads"][2]), thread_keys);
        assert!(json["items"][0]["parentId"].is_null());
        assert!(json["items"][0]["transcript"].is_null(), "no machine has found its transcript yet");
        assert!(json["items"][1]["userAgent"].is_null());
        assert_eq!(json["items"][0]["threads"][2]["parentId"], CLAUDE_AGENT_A);
        assert_eq!(json["items"][0]["threads"][2]["depth"], 2);
        assert_eq!(json["items"][0]["hasOwnRequests"], true);
    }

    #[test]
    fn sessions_carry_what_their_transcript_says() {
        let connection = session_test_database(&[session_row(CLAUDE_MAIN, None, SESSION_T0)]);
        connection
            .execute(
                "INSERT INTO usage_session_transcripts (session_id, machine, agent, file_size, read_at_ms, home, cwd, repo_root,
                     main_repo, branch, commit_hash, repository_url, title, title_source, pull_requests, lines_added, lines_removed, compactions)
                 VALUES (?1, 'mini', 'claude', 52000, 5, '/Users/casey', '/Users/casey/src/arbor', '/Users/casey/src/arbor',
                     '/Users/casey/src/arbor', 'main', '', '', 'Fix the login loop', 'ai', '[]', 210, 35, ?2)",
                rusqlite::params![
                    CLAUDE_MAIN,
                    r#"[{"atMs":1,"trigger":"auto","preTokens":360000,"postTokens":80000,"durationMs":40000},
                        {"atMs":2,"trigger":"manual","preTokens":null,"postTokens":null,"durationMs":null}]"#
                ],
            )
            .unwrap();
        let page = load_test_sessions(&connection, UsageQuery::default());
        assert_eq!(page.items[0].root.compactions, 2, "compactions the requests didn't show still count");
        let json = serde_json::to_value(&page.items[0]).unwrap();
        assert_eq!(json["transcript"]["title"], "Fix the login loop");
        assert_eq!(json["transcript"]["mainRepo"], "/Users/casey/src/arbor");
        assert_eq!(json["transcript"]["linesAdded"], 210);
        assert_eq!(json["transcript"]["compactions"][1]["trigger"], "manual");
        assert!(json["transcript"]["compactions"][1]["preTokens"].is_null());
    }

    #[test]
    fn sessions_can_be_searched_and_narrowed_by_what_they_are() {
        const SETTINGS: &str = "7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
        const EXEC: &str = "01997a4e-6c2b-7d1e-8f3a-2b4c6d8e0a99";
        let claude = Some("claude-cli/2.1.280 (external, cli)");
        let connection = session_test_database(&[
            SessionRow {
                user_agent: claude,
                api_key_hash: "mini-key",
                ..session_row(CLAUDE_MAIN, None, SESSION_T0)
            },
            SessionRow {
                user_agent: claude,
                api_key_hash: "mini-key",
                ..session_row(CLAUDE_AGENT_A, Some(CLAUDE_MAIN), SESSION_T0 + 1_000)
            },
            SessionRow {
                user_agent: Some("codex-tui/0.156.0 (Mac OS 26.0.0; arm64) iTerm.app/3.6.1 AcmeDesk/1.4.205"),
                model: "gpt-5.5-codex",
                provider: "codex",
                ..session_row(CODEX_ROOT, None, SESSION_T0 + 2_000)
            },
            SessionRow {
                user_agent: claude,
                ..session_row(SETTINGS, None, SESSION_T0 + 3_000)
            },
            SessionRow {
                user_agent: Some("codex_exec/0.156.0 (Mac OS 26.0.0; arm64) dumb"),
                provider: "codex",
                ..session_row(EXEC, None, SESSION_T0 + 4_000)
            },
            SessionRow {
                session: None,
                api_key_hash: "mini-key",
                ..session_row("", None, SESSION_T0 + 5_000)
            },
        ]);
        connection
            .execute(
                "INSERT INTO usage_machine_assignments (api_key_hash, label, machine, pool) VALUES ('mini-key', '', 'Mac Mini', '')",
                [],
            )
            .unwrap();
        for [id, machine, cwd, main_repo, branch, repository_url, title, pull_requests] in [
            [
                CLAUDE_MAIN,
                "Mac Mini",
                "/Users/casey/.t3/worktrees/arbor/login-loop",
                "/Users/casey/src/arbor",
                "fix/login-loop",
                "",
                "Fix the login redirect loop",
                r#"[{"number":412,"url":"https://github.com/acme/arbor/pull/412","repository":"acme/arbor"}]"#,
            ],
            [
                CODEX_ROOT,
                "studio",
                "/Users/casey/src/proxy",
                "/Users/casey/src/proxy",
                "main",
                "git@github.com:acme/proxy.git",
                "Rate limiter for the proxy",
                "[]",
            ],
            [
                SETTINGS,
                "Mac Mini",
                "/Users/casey/src/arbor",
                "/Users/casey/src/arbor",
                "main",
                "",
                "Tidy the settings page",
                "[]",
            ],
        ] {
            connection
                .execute(
                    "INSERT INTO usage_session_transcripts (session_id, machine, agent, file_size, read_at_ms, home, cwd, repo_root,
                         main_repo, branch, commit_hash, repository_url, title, title_source, pull_requests, lines_added, lines_removed, compactions)
                     VALUES (?1, ?2, 'claude', 1, 1, '/Users/casey', ?3, ?3, ?4, ?5, '', ?6, ?7, 'ai', ?8, NULL, NULL, '[]')",
                    rusqlite::params![id, machine, cwd, main_repo, branch, repository_url, title, pull_requests],
                )
                .unwrap();
        }
        let find = |query: UsageQuery| {
            let page = load_test_sessions(&connection, UsageQuery { sort: Some("recent".into()), ..query });
            let ids = page.items.iter().map(|session| session.root.id.clone()).collect::<Vec<_>>();
            (ids, page)
        };
        let search = |text: &str| {
            find(UsageQuery {
                search: Some(text.into()),
                ..UsageQuery::default()
            })
            .0
        };

        // Every word has to be there, in any case, in any of what a session is.
        assert_eq!(search("login"), [CLAUDE_MAIN]);
        assert_eq!(search("  LOOP   arbor "), [CLAUDE_MAIN]);
        assert_eq!(search("#412"), [CLAUDE_MAIN]);
        assert_eq!(search("acme/proxy"), [CODEX_ROOT]);
        assert_eq!(search(CLAUDE_AGENT_A), [CLAUDE_MAIN], "a subagent's id finds its session");
        assert_eq!(search("codex exec"), [EXEC]);
        assert_eq!(search("arbor studio"), Vec::<String>::new());
        assert_eq!(search("").len(), 4);

        let (arbor, page) = find(UsageQuery {
            project: Some("arbor".into()),
            facets: Some(true),
            ..UsageQuery::default()
        });
        assert_eq!(arbor, [SETTINGS, CLAUDE_MAIN], "a worktree is filed under its main checkout");
        assert_eq!((page.total, page.summary.sessions, page.summary.requests), (2, 2, 3));
        assert_eq!(page.summary.untracked_requests, 0, "nothing says which project those were for");
        let facets = serde_json::to_value(page.facets.as_ref().unwrap()).unwrap();
        assert_eq!(
            facets,
            serde_json::json!({
                // The project menu isn't narrowed by the project, and a session without a transcript has none.
                "projects": [{ "value": "arbor", "sessions": 2 }, { "value": "proxy", "sessions": 1 }],
                "branches": [{ "value": "fix/login-loop", "sessions": 1 }, { "value": "main", "sessions": 1 }],
                "clients": [{ "value": "Claude Code", "sessions": 2 }],
                "machines": [{ "value": "Mac Mini", "sessions": 2 }],
                "withPullRequests": 1,
                "withoutPullRequests": 1,
            })
        );

        let narrowed = |query: UsageQuery| find(query).0;
        let (on_main, page) = find(UsageQuery {
            project: Some("arbor".into()),
            branch: Some("main".into()),
            facets: Some(true),
            ..UsageQuery::default()
        });
        assert_eq!(on_main, [SETTINGS]);
        let facets = serde_json::to_value(page.facets.as_ref().unwrap()).unwrap();
        // Another project clears the branch, so the project menu isn't narrowed by it.
        assert_eq!(facets["projects"], serde_json::json!([{ "value": "arbor", "sessions": 2 }, { "value": "proxy", "sessions": 1 }]));
        assert_eq!(facets["branches"], serde_json::json!([{ "value": "fix/login-loop", "sessions": 1 }, { "value": "main", "sessions": 1 }]));
        assert_eq!(facets["clients"], serde_json::json!([{ "value": "Claude Code", "sessions": 1 }]));
        assert_eq!(
            narrowed(UsageQuery {
                client: Some("Codex CLI · AcmeDesk".into()),
                ..UsageQuery::default()
            }),
            [CODEX_ROOT]
        );
        assert_eq!(
            narrowed(UsageQuery {
                pull_requests: Some("with".into()),
                ..UsageQuery::default()
            }),
            [CLAUDE_MAIN]
        );
        assert_eq!(
            narrowed(UsageQuery {
                pull_requests: Some("without".into()),
                ..UsageQuery::default()
            }),
            [EXEC, SETTINGS, CODEX_ROOT]
        );

        // A session is on the machine its key is assigned to, else the one its transcript is on.
        let (mini, page) = find(UsageQuery {
            machine: Some("Mac Mini".into()),
            ..UsageQuery::default()
        });
        assert_eq!(mini, [SETTINGS, CLAUDE_MAIN]);
        assert_eq!(page.items[1].root.totals.requests, 2, "the whole session, subagent included");
        assert_eq!(page.summary.untracked_requests, 1, "a request's key says which machine sent it");
        assert!(page.facets.is_none());
        assert_eq!(
            narrowed(UsageQuery {
                machine: Some("studio".into()),
                ..UsageQuery::default()
            }),
            [CODEX_ROOT]
        );
        assert_eq!(
            narrowed(UsageQuery {
                machine: Some("__unassigned__".into()),
                ..UsageQuery::default()
            }),
            [EXEC]
        );
    }

    #[test]
    fn projects_add_up_their_sessions_and_share_them_out_between_pull_requests() {
        const SETTINGS: &str = "7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
        const PROXY: &str = "01997a4e-6c2b-7d1e-8f3a-2b4c6d8e0b20";
        const EXEC: &str = "01997a4e-6c2b-7d1e-8f3a-2b4c6d8e0a99";
        let codex = |row: SessionRow<'static>| SessionRow {
            model: "gpt-5.5-codex",
            provider: "codex",
            ..row
        };
        let mut connection = session_test_database(&[
            session_row(CLAUDE_MAIN, None, SESSION_T0),
            session_row(CLAUDE_AGENT_A, Some(CLAUDE_MAIN), SESSION_T0 + 1_000),
            codex(session_row(CODEX_ROOT, None, SESSION_T0 + 2_000)),
            session_row(SETTINGS, None, SESSION_T0 + 3_000),
            codex(session_row(PROXY, None, SESSION_T0 + 4_000)),
            codex(session_row(EXEC, None, SESSION_T0 + 5_000)),
        ]);
        for (id, agent, cwd, main_repo, branch, repository_url, pull_requests, lines) in [
            (
                CLAUDE_MAIN,
                "claude",
                "/Users/casey/.t3/worktrees/arbor/login-loop",
                "/Users/casey/src/arbor",
                "fix/login-loop",
                "",
                r#"[{"number":412,"url":"https://github.com/acme/arbor/pull/412","repository":"acme/arbor"}]"#,
                Some((210, 35)),
            ),
            // Codex carries on with the same branch, and its transcripts don't record pull requests.
            ("CODEX", "codex", "/Users/casey/src/arbor", "/Users/casey/src/arbor", "fix/login-loop", "git@github.com:acme/arbor.git", "[]", None),
            (
                SETTINGS,
                "claude",
                "/Users/casey/src/arbor",
                "/Users/casey/src/arbor",
                "main",
                "",
                r#"[{"number":413,"url":"https://github.com/acme/arbor/pull/413","repository":"acme/arbor"},
                    {"number":414,"url":"https://github.com/acme/arbor/pull/414","repository":""}]"#,
                Some((40, 10)),
            ),
            (PROXY, "codex", "/Users/casey/src/proxy", "/Users/casey/src/proxy", "main", "git@github.com:acme/proxy.git", "[]", None),
        ] {
            let id = if id == "CODEX" { CODEX_ROOT } else { id };
            connection
                .execute(
                    "INSERT INTO usage_session_transcripts (session_id, machine, agent, file_size, read_at_ms, home, cwd, repo_root,
                         main_repo, branch, commit_hash, repository_url, title, title_source, pull_requests, lines_added, lines_removed, compactions)
                     VALUES (?1, 'Mac Mini', ?2, 1, 1, '/Users/casey', ?3, ?3, ?4, ?5, '', ?6, '', '', ?7, ?8, ?9, '[]')",
                    rusqlite::params![
                        id,
                        agent,
                        cwd,
                        main_repo,
                        branch,
                        repository_url,
                        pull_requests,
                        lines.map(|(added, _)| added),
                        lines.map(|(_, removed)| removed),
                    ],
                )
                .unwrap();
        }
        let now_ms = SESSION_T0 + 24 * 3_600_000;
        let report = |connection: &Connection, query: UsageQuery, now_ms: i64| {
            projects::load_session_projects(connection, &query, &GuiConfigFile::default(), now_ms).unwrap()
        };
        let totals_of = |id: &str| {
            load_test_sessions(&connection, UsageQuery::default())
                .items
                .iter()
                .find(|session| session.root.id == id)
                .map(|session| (session.root.totals.estimated_cost, session.root.totals.priced_requests))
                .unwrap()
        };
        let [(main_cost, main_priced), (codex_cost, codex_priced), (settings_cost, settings_priced)] =
            [CLAUDE_MAIN, CODEX_ROOT, SETTINGS].map(totals_of);
        assert!(main_cost > 0.0 && codex_cost > 0.0 && settings_cost > 0.0);
        assert_eq!((main_priced, codex_priced, settings_priced), (2, 1, 1));
        let close = |value: &Value, expected: f64| (value.as_f64().unwrap() - expected).abs() < 1e-12;

        let first = report(&connection, UsageQuery::default(), now_ms);
        let json = serde_json::to_value(&first).unwrap();
        let arbor = &json["projects"][0];
        assert_eq!(
            (&arbor["name"], &arbor["repository"], &arbor["sessions"], &arbor["requests"]),
            (&serde_json::json!("arbor"), &serde_json::json!("acme/arbor"), &serde_json::json!(3), &serde_json::json!(4)),
            "a worktree is filed under its main checkout"
        );
        assert!(close(&arbor["estimatedCost"], main_cost + codex_cost + settings_cost));
        assert_eq!(
            (&arbor["linesAdded"], &arbor["linesRemoved"], &arbor["sessionsWithLines"]),
            (&serde_json::json!(250), &serde_json::json!(45), &serde_json::json!(2))
        );
        let branches = arbor["branches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|branch| (branch["name"].as_str().unwrap(), branch["sessions"].as_u64().unwrap()))
            .collect::<Vec<_>>();
        assert!(branches.contains(&("fix/login-loop", 2)) && branches.contains(&("main", 1)), "{branches:?}");
        assert_eq!(json["projects"][1]["name"], "proxy");
        assert_eq!(json["projects"][1]["repository"], "acme/proxy");
        assert_eq!(json["projects"].as_array().unwrap().len(), 2);
        assert_eq!(json["unplaced"]["sessions"], 1, "no transcript says where it ran");

        let numbers = |json: &Value| {
            json["pullRequests"]
                .as_array()
                .unwrap()
                .iter()
                .map(|pull_request| pull_request["number"].as_u64().unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(numbers(&json), [414, 413, 412], "the most recently worked on first");
        let [split_414, split_413, login] = [0, 1, 2].map(|index| json["pullRequests"][index].clone());
        assert_eq!(split_414["repository"], "acme/arbor", "a missing repository comes from the address");
        for split in [&split_414, &split_413] {
            assert!(close(&split["estimatedCost"], settings_cost / 2.0), "a session's cost is shared between its pull requests");
            assert_eq!(split["pricedRequests"], settings_priced, "but its priced requests count in full, like the session");
            assert_eq!((&split["sessions"], &split["linesAdded"], &split["linesRemoved"]), (&serde_json::json!(1), &serde_json::json!(20), &serde_json::json!(5)));
            assert_eq!(split["branch"], "main");
        }
        assert_eq!((&login["project"], &login["branch"], &login["sessions"]), (&serde_json::json!("arbor"), &serde_json::json!("fix/login-loop"), &serde_json::json!(1)));
        assert!(close(&login["estimatedCost"], main_cost), "until GitHub names its branch, only the session that named it counts");
        assert_eq!(login["pricedRequests"], main_priced);
        assert_eq!(login["github"], Value::Null);
        assert_eq!(first.due_pull_requests(), [("acme/arbor", 414), ("acme/arbor", 413), ("acme/arbor", 412)]);

        pull_requests::store_test_states(
            &mut connection,
            &[
                ("acme/arbor", 412, pull_requests::test_state("merged", "fix/login-loop", "main", now_ms - 1_000)),
                ("acme/arbor", 413, pull_requests::test_state("open", "settings", "main", now_ms - 1_000)),
                ("acme/arbor", 414, pull_requests::test_state("", "", "", now_ms)),
            ],
        );
        let checked = report(&connection, UsageQuery::default(), now_ms);
        let json = serde_json::to_value(&checked).unwrap();
        assert_eq!(numbers(&json), [414, 413, 412]);
        let login = &json["pullRequests"][2];
        assert_eq!(login["sessions"], 2, "the Codex session on its branch counts too");
        assert!(close(&login["estimatedCost"], main_cost + codex_cost));
        assert_eq!(login["pricedRequests"], main_priced + codex_priced);
        assert_eq!((&login["linesAdded"], &login["linesRemoved"]), (&serde_json::json!(210), &serde_json::json!(35)));
        assert_eq!(login["github"]["state"], "merged");
        assert!(login["github"].get("headBranch").is_none());
        assert_eq!(json["pullRequests"][1]["branch"], "settings", "GitHub's word for its branch");
        assert_eq!(json["pullRequests"][1]["sessions"], 1, "nothing ran on that branch but the session that named it");
        assert_eq!(json["pullRequests"][0]["github"]["state"], "", "GitHub couldn't find it");
        assert!(checked.due_pull_requests().is_empty());
        assert_eq!(
            report(&connection, UsageQuery::default(), now_ms + 16 * 60_000).due_pull_requests(),
            [("acme/arbor", 413)],
            "an open pull request is asked about again; a merged one never"
        );

        let proxy = serde_json::to_value(report(
            &connection,
            UsageQuery {
                project: Some("proxy".into()),
                facets: Some(true),
                ..UsageQuery::default()
            },
            now_ms,
        ))
        .unwrap();
        assert_eq!(proxy["projects"].as_array().unwrap().len(), 1);
        assert_eq!(proxy["pullRequests"], serde_json::json!([]));
        assert_eq!(proxy["unplaced"]["sessions"], 0);
        assert_eq!(proxy["facets"]["projects"][0], serde_json::json!({ "value": "arbor", "sessions": 3 }));
    }

    #[test]
    fn merged_pull_requests_add_up_as_the_all_time_projects_view_does() {
        const SETTINGS: &str = "7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
        const PROXY: &str = "01997a4e-6c2b-7d1e-8f3a-2b4c6d8e0b20";
        const EXEC: &str = "01997a4e-6c2b-7d1e-8f3a-2b4c6d8e0a99";
        const REOPENED: &str = "7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c40";
        const UNRELATED: &str = "7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c41";
        const DAY: i64 = 86_400_000;
        let (from_ms, to_ms) = (SESSION_T0 + 10 * DAY, SESSION_T0 + 17 * DAY);
        let now_ms = to_ms + DAY;
        let codex = |row: SessionRow<'static>| SessionRow { model: "gpt-5.5-codex", provider: "codex", ..row };
        let mut connection = session_test_database(&[
            // Started weeks before its pull request merged, with a subagent that started one of its own, and came
            // back to it.
            session_row(CLAUDE_MAIN, None, SESSION_T0),
            session_row(CLAUDE_AGENT_A, Some(CLAUDE_MAIN), SESSION_T0 + 1_000),
            SessionRow { output_tokens: 9_000, ..session_row(CLAUDE_NESTED, Some(CLAUDE_AGENT_A), SESSION_T0 + 2_000) },
            session_row(CLAUDE_MAIN, None, SESSION_T0 + 11 * DAY),
            codex(session_row(CODEX_ROOT, None, SESSION_T0 + 11 * DAY)),
            session_row(SETTINGS, None, SESSION_T0 + 2 * DAY),
            codex(session_row(PROXY, None, SESSION_T0 + 3 * DAY)),
            session_row(EXEC, None, SESSION_T0 + 12 * DAY),
            session_row(REOPENED, None, SESSION_T0 + 4 * DAY),
            session_row(UNRELATED, None, SESSION_T0 + 5 * DAY),
        ]);
        let link = |number: u64| format!(r#"{{"number":{number},"url":"https://github.com/acme/arbor/pull/{number}","repository":"acme/arbor"}}"#);
        for (id, cwd, branch, repository_url, pull_requests) in [
            (CLAUDE_MAIN, "/Users/casey/.t3/worktrees/arbor/login-loop", "fix/login-loop", "", format!("[{}]", link(412))),
            // On the merged one's branch without naming it: shared with the closed one from the same branch.
            (CODEX_ROOT, "/Users/casey/src/arbor", "fix/login-loop", "git@github.com:acme/arbor.git", "[]".to_string()),
            (REOPENED, "/Users/casey/src/arbor", "fix/login-loop", "", format!("[{}]", link(415))),
            // Shared between the merged one and one merged the week before.
            (EXEC, "/Users/casey/src/arbor", "fix/other", "", format!("[{},{}]", link(412), link(416))),
            (SETTINGS, "/Users/casey/src/arbor", "main", "", format!("[{},{}]", link(413), link(414))),
            // The same branch name in another project.
            (PROXY, "/Users/casey/src/proxy", "fix/login-loop", "git@github.com:acme/proxy.git", "[]".to_string()),
        ] {
            connection
                .execute(
                    "INSERT INTO usage_session_transcripts (session_id, machine, agent, file_size, read_at_ms, home, cwd, repo_root,
                         main_repo, branch, commit_hash, repository_url, title, title_source, pull_requests, lines_added, lines_removed, compactions)
                     VALUES (?1, 'Mac Mini', 'claude', 1, 1, '/Users/casey', ?2, ?2, '/Users/casey/src/' || ?3, ?4, '', ?5, '', '', ?6, 30, 5, '[]')",
                    rusqlite::params![id, cwd, if id == PROXY { "proxy" } else { "arbor" }, branch, repository_url, pull_requests],
                )
                .unwrap();
        }
        pull_requests::store_test_states(
            &mut connection,
            &[
                ("acme/arbor", 412, pull_requests::test_merged_state("fix/login-loop", "main", from_ms + DAY)),
                ("acme/arbor", 413, pull_requests::test_state("open", "settings", "main", now_ms - 2 * DAY)),
                ("acme/arbor", 415, pull_requests::test_state("closed", "fix/login-loop", "main", now_ms - 2 * DAY)),
                ("acme/arbor", 416, pull_requests::test_merged_state("fix/other", "main", from_ms - DAY)),
                // Merged in the week, but no session named it.
                ("acme/arbor", 418, pull_requests::test_merged_state("fix/unnamed", "main", from_ms + 2 * DAY)),
            ],
        );

        let config = GuiConfigFile::default();
        let merged = projects::load_merged_pull_requests(&connection, &config, from_ms, to_ms, now_ms).unwrap();
        let all_time = projects::load_session_projects(&connection, &UsageQuery::default(), &config, now_ms).unwrap();
        let in_week = serde_json::to_value(&all_time).unwrap()["pullRequests"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|pull_request| {
                pull_request["github"]["state"] == "merged"
                    && pull_request["github"]["mergedAtMs"].as_i64().is_some_and(|at| at >= from_ms && at < to_ms)
            })
            .cloned()
            .collect::<Vec<_>>();
        let json = serde_json::to_value(&merged).unwrap();
        assert_eq!(json["pullRequests"], Value::Array(in_week));
        let login = &json["pullRequests"][0];
        assert_eq!(json["pullRequests"].as_array().unwrap().len(), 1);
        assert_eq!((&login["number"], &login["sessions"]), (&serde_json::json!(412), &serde_json::json!(3)));
        assert_eq!(merged.due_pull_requests(), all_time.due_pull_requests());
        assert_eq!(merged.due_pull_requests(), [("acme/arbor", 415), ("acme/arbor", 414), ("acme/arbor", 413)]);

        // A week nothing merged in reads no sessions and still asks about the rest.
        let quiet = projects::load_merged_pull_requests(&connection, &config, to_ms, to_ms + 7 * DAY, now_ms).unwrap();
        assert_eq!(serde_json::to_value(&quiet).unwrap()["pullRequests"], serde_json::json!([]));
        assert_eq!(quiet.due_pull_requests(), all_time.due_pull_requests());
    }

    #[test]
    fn machines_list_the_sessions_that_ran_on_them() {
        const SETTINGS: &str = "7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
        const EXEC: &str = "01997a4e-6c2b-7d1e-8f3a-2b4c6d8e0a99";
        const MINUTE: i64 = 60_000;
        const HOUR: i64 = 60 * MINUTE;
        let now_ms = SESSION_T0 + 24 * HOUR;
        let older = (0..5).map(|index| format!("7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c{index:02}")).collect::<Vec<_>>();
        let mut rows = vec![
            // On its key's machine, whichever machine its transcript is on.
            SessionRow {
                api_key_hash: "mini-key",
                ..session_row(CLAUDE_MAIN, None, now_ms - 20 * MINUTE)
            },
            SessionRow {
                api_key_hash: "mini-key",
                ..session_row(CLAUDE_AGENT_A, Some(CLAUDE_MAIN), now_ms - 2 * MINUTE)
            },
            // Its key isn't assigned, so it's where its transcript is.
            session_row(SETTINGS, None, now_ms - 3 * HOUR),
            SessionRow {
                provider: "codex",
                ..session_row(CODEX_ROOT, None, now_ms - MINUTE)
            },
            // Nothing says where it ran.
            session_row(EXEC, None, now_ms - 2 * HOUR),
        ];
        rows.extend(older.iter().enumerate().map(|(index, id)| SessionRow {
            api_key_hash: "mini-key",
            ..session_row(id, None, now_ms - (10 + index as i64) * HOUR)
        }));
        let connection = session_test_database(&rows);
        connection
            .execute(
                "INSERT INTO usage_machine_assignments (api_key_hash, label, machine, pool) VALUES ('mini-key', '', 'Mac Mini', '')",
                [],
            )
            .unwrap();
        for (id, machine) in [(CLAUDE_MAIN, "studio"), (SETTINGS, "Mac Mini"), (CODEX_ROOT, "studio")] {
            connection
                .execute(
                    "INSERT INTO usage_session_transcripts (session_id, machine, agent, file_size, read_at_ms, home, cwd, repo_root,
                         main_repo, branch, commit_hash, repository_url, title, title_source, pull_requests, lines_added, lines_removed, compactions)
                     VALUES (?1, ?2, 'claude', 1, 1, '/Users/casey', '/Users/casey/src/arbor', '', '', 'main', '', '', '', '', '[]', NULL, NULL, '[]')",
                    rusqlite::params![id, machine],
                )
                .unwrap();
        }
        let load = |query: UsageQuery| {
            let machines = machine_sessions::load_machine_sessions(&connection, &query, &GuiConfigFile::default(), now_ms).unwrap();
            serde_json::to_value(&machines).unwrap()
        };
        let ids = |machine: &serde_json::Value| {
            machine["latest"].as_array().unwrap().iter().map(|session| session["id"].as_str().unwrap().to_string()).collect::<Vec<_>>()
        };

        let json = load(UsageQuery::default());
        let names = json.as_array().unwrap().iter().map(|machine| machine["machine"].as_str().unwrap()).collect::<Vec<_>>();
        assert_eq!(names, ["Mac Mini", "studio", ""], "by name, and the ones Arbor can't place last");
        let mini = &json[0];
        assert_eq!((mini["sessions"].as_u64(), mini["subagents"].as_u64(), mini["running"].as_u64()), (Some(7), Some(1), Some(1)));
        assert_eq!(mini["requests"], 8, "subagents' requests included");
        assert_eq!(mini["totalTokens"], 8 * 1_100);
        assert_eq!(mini["lastActiveAtMs"], now_ms - 2 * MINUTE + 1_000, "when its latest request finished");
        // The latest few, the running one first; the rest are only counted.
        assert_eq!(ids(mini), [CLAUDE_MAIN, SETTINGS, &older[0], &older[1], &older[2]]);
        assert_eq!(mini["latest"][0]["active"], true);
        assert_eq!((json[1]["sessions"].as_u64(), json[1]["running"].as_u64()), (Some(1), Some(1)));
        assert_eq!(ids(&json[1]), [CODEX_ROOT]);
        assert_eq!((json[2]["sessions"].as_u64(), json[2]["running"].as_u64()), (Some(1), Some(0)));
        assert_eq!(ids(&json[2]), [EXEC]);
        let cost = json.as_array().unwrap().iter().map(|machine| machine["estimatedCost"].as_f64().unwrap()).sum::<f64>();
        let page = load_usage_sessions(&connection, &UsageQuery::default(), &GuiConfigFile::default(), now_ms).unwrap();
        assert!((cost - page.summary.estimated_cost).abs() < 1e-9, "every session counted once");

        // The page's filters: the machine one as the Sessions page has it, the rest on requests.
        let studio = load(UsageQuery {
            machine: Some("studio".into()),
            ..UsageQuery::default()
        });
        assert_eq!(studio.as_array().unwrap().len(), 1);
        assert_eq!(ids(&studio[0]), [CODEX_ROOT]);
        let unassigned = load(UsageQuery {
            machine: Some("__unassigned__".into()),
            ..UsageQuery::default()
        });
        assert_eq!(unassigned[0]["machine"], "");
        assert_eq!(ids(&unassigned[0]), [EXEC]);
        let recent = load(UsageQuery {
            start: Some(rfc3339_millis(now_ms - HOUR)),
            ..UsageQuery::default()
        });
        let names = recent.as_array().unwrap().iter().map(|machine| machine["machine"].as_str().unwrap()).collect::<Vec<_>>();
        assert_eq!(names, ["Mac Mini", "studio"]);
        assert_eq!(recent[0]["sessions"], 1);
        let codex = load(UsageQuery {
            provider: Some("codex".into()),
            ..UsageQuery::default()
        });
        assert_eq!(ids(&codex[0]), [CODEX_ROOT]);
    }

    #[test]
    fn a_session_counts_its_compactions_the_same_on_every_screen() {
        const MINUTE: i64 = 60_000;
        let now_ms = SESSION_T0 + 24 * 3_600_000;
        let row = |minutes_ago: i64, context: i64| SessionRow {
            input_tokens: context,
            total_tokens: context + 100,
            ..session_row(CLAUDE_MAIN, None, now_ms - minutes_ago * MINUTE)
        };
        // Arbor sees it compact from 300K to 60K an hour and a half ago...
        let mut rows = vec![row(120, 200_000), row(100, 300_000)];
        rows.extend((0..10).map(|step| row(90 - step * 10, 60_000 + step * 10_000)));
        let connection = session_test_database(&rows);
        // ...and the transcript records another, half an hour ago, that the requests don't show.
        connection
            .execute(
                "INSERT INTO usage_session_transcripts (session_id, machine, agent, file_size, read_at_ms, home, cwd, repo_root,
                     main_repo, branch, commit_hash, repository_url, title, title_source, pull_requests, lines_added, lines_removed, compactions)
                 VALUES (?1, 'mini', 'claude', 52000, 5, '/Users/casey', '', '', '', '', '', '', '', '', '[]', 0, 0, ?2)",
                rusqlite::params![CLAUDE_MAIN, format!(r#"[{{"atMs":{},"trigger":"manual"}}]"#, now_ms - 30 * MINUTE)],
            )
            .unwrap();
        let config = GuiConfigFile::default();

        let list = load_usage_sessions(&connection, &UsageQuery::default(), &config, now_ms).unwrap().items[0].root.compactions;
        let live = live::load_live_sessions(&connection, &config, now_ms, &HashMap::new()).unwrap();
        let live = serde_json::to_value(&live).unwrap()["sessions"][0]["compactions"].as_u64().unwrap();
        let page = load_usage_session_timeline(&connection, CLAUDE_MAIN, &config, now_ms).unwrap().session.unwrap().root.compactions;
        // The list took the larger of the two counts and the live board only the drops, so both said 1.
        assert_eq!((list, live, page), (2, 2, 2));
    }

    #[test]
    fn live_sessions_are_the_running_ones_with_where_their_conversations_are_heading() {
        const FINISHED: &str = "7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3e";
        const MINUTE: i64 = 60_000;
        const CLAUDE_CODE: &str = "claude-cli/2.1.280 (external, cli)";
        let now_ms = SESSION_T0 + 24 * 3_600_000;
        let row = |session: &'static str, minutes_ago: i64, context: i64| SessionRow {
            input_tokens: context,
            total_tokens: context + 100,
            user_agent: Some(CLAUDE_CODE),
            ..session_row(session, None, now_ms - minutes_ago * MINUTE)
        };
        let mut rows = Vec::new();
        // Claude Code, up to 360K well over an hour ago, compacted to 80K half
        // an hour ago, and growing 5K a minute since.
        rows.extend((0..10).map(|step| row(CLAUDE_MAIN, 100 - step, 180_000 + step * 20_000)));
        rows.push(row(CLAUDE_MAIN, 30, 80_000));
        rows.extend((1..=29).map(|step| row(CLAUDE_MAIN, 30 - step, 80_000 + step * 5_000)));
        // Codex, for the last ten minutes.
        rows.extend((0..9).map(|step| SessionRow {
            model: "gpt-5.5-codex",
            provider: "codex",
            user_agent: Some("codex_cli_rs/0.156.0 (Mac OS 26.0.0; arm64) iTerm.app/3.6.1"),
            ..row(CODEX_ROOT, 10 - step, 50_000 + step * 5_000)
        }));
        // Finished twenty minutes ago, after compacting at 350K.
        rows.extend([300_000, 350_000, 70_000, 72_000, 74_000, 76_000, 78_000].iter().enumerate().map(|(step, &context)| row(FINISHED, 50 - step as i64, context)));
        rows.push(row(FINISHED, 20, 90_000));
        let connection = session_test_database(&rows);

        let learned = live::learn_compaction_points(&connection, now_ms - 30 * 24 * 3_600_000).unwrap();
        assert_eq!(
            learned,
            HashMap::from([(("Claude Code".to_string(), "claude-opus-4-5".to_string()), vec![360_000])])
        );

        let report = live::load_live_sessions(&connection, &GuiConfigFile::default(), now_ms, &learned).unwrap();
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["running"], 2);
        let ids = json["sessions"].as_array().unwrap().iter().map(|session| session["id"].as_str().unwrap()).collect::<Vec<_>>();
        assert_eq!(ids, [CLAUDE_MAIN, CODEX_ROOT]);
        let hour = |id: &str| {
            json["sessions"].as_array().unwrap().iter().find(|session| session["id"] == id).unwrap()["estimatedCost"].as_f64().unwrap()
        };
        assert!(hour(CLAUDE_MAIN) > 0.0);
        assert!((json["costPerHour"].as_f64().unwrap() - hour(CLAUDE_MAIN) - hour(CODEX_ROOT)).abs() < 1e-9);
        // The hour's requests only, but the whole conversation for where it is.
        let claude = &json["sessions"][0];
        assert_eq!(claude["requests"], 30);
        assert_eq!(claude["runningSinceMs"], now_ms - 100 * MINUTE);
        assert_eq!((claude["peakContext"].as_u64(), claude["compactions"].as_u64()), (Some(360_000), Some(1)));
        let context = &claude["context"];
        assert_eq!(context["tokens"], 225_000);
        assert_eq!((context["compactsAt"].as_u64(), context["basis"].as_str()), (Some(360_000), Some("session")));
        assert_eq!(context["growthPerMinute"].as_f64().map(f64::round), Some(5_000.0));
        // 135K to go at 5K a minute.
        assert_eq!(context["compactsInMs"], 27 * MINUTE);
        let codex = &json["sessions"][1]["context"];
        assert_eq!((codex["tokens"].as_u64(), codex["compactsAt"].as_u64(), codex["basis"].as_str()), (Some(90_000), None, Some("")));
    }

    #[test]
    fn cache_misses_add_up_over_every_thread_in_the_range() {
        const MINUTE: i64 = 60_000;
        let row = |session: &'static str, minute: i64, input: i64, cache_read: i64, cache_creation: i64| SessionRow {
            model: "claude-opus-5-5",
            input_tokens: input,
            cache_read_tokens: cache_read,
            cache_creation_tokens: cache_creation,
            output_tokens: 500,
            total_tokens: input + 500,
            ..session_row(session, None, SESSION_T0 + minute * MINUTE)
        };
        let warm = |session: &'static str, minute: i64, input: i64| row(session, minute, input, input * 9 / 10, input / 20);
        let connection = session_test_database(&[
            // Its request before the range isn't there to compare with.
            warm(CODEX_ROOT, -10, 100_000),
            row(CODEX_ROOT, 5, 105_000, 0, 105_000),
            // Went cold while it sat idle for an hour, then carried on warm.
            warm(CLAUDE_MAIN, 0, 100_000),
            warm(CLAUDE_MAIN, 1, 110_000),
            row(CLAUDE_MAIN, 70, 112_000, 2_000, 108_000),
            warm(CLAUDE_MAIN, 71, 114_000),
            // A subagent whose cache was dropped.
            warm(CLAUDE_AGENT_A, 2, 60_000),
            row(CLAUDE_AGENT_A, 3, 61_000, 0, 61_000),
            // After the range.
            row(CLAUDE_MAIN, 200, 116_000, 0, 116_000),
        ]);
        let at = |minute: i64| DateTime::<chrono::Utc>::from_timestamp_millis(SESSION_T0 + minute * MINUTE).map(|at| at.to_rfc3339());
        let query = UsageQuery { start: at(0), end: at(180), ..UsageQuery::default() };

        let misses = digest::load_cache_misses(&connection, &query).unwrap();
        assert_eq!((misses.requests, misses.tokens, misses.priced_requests), (2, 108_000 + 60_000, 2));
        // What the cache didn't cover: 2K uncached × $4 and 108K written × $5
        // a million, then 61K written.
        assert!((misses.cost - (0.008 + 0.54 + 0.305)).abs() < 1e-9, "{}", misses.cost);
    }

    #[test]
    fn sessions_keep_the_real_depth_when_an_intermediate_thread_is_filtered_out() {
        let deeper = "5f0c2a8e-3b1d-8c6f-9e2a-7d4b1c8e0fd4";
        let connection = session_test_database(&[
            session_row(CLAUDE_MAIN, None, SESSION_T0),
            SessionRow {
                model: "claude-haiku-4-5",
                ..session_row(CLAUDE_AGENT_A, Some(CLAUDE_MAIN), SESSION_T0 + 10_000)
            },
            session_row(CLAUDE_NESTED, Some(CLAUDE_AGENT_A), SESSION_T0 + 20_000),
            session_row(deeper, Some(CLAUDE_NESTED), SESSION_T0 + 30_000),
            session_row(CLAUDE_AGENT_B, Some(CLAUDE_MAIN), SESSION_T0 + 25_000),
        ]);
        let page = load_test_sessions(
            &connection,
            UsageQuery {
                model: Some("claude-opus-4-5".into()),
                ..UsageQuery::default()
            },
        );
        assert_eq!(page.total, 1);
        let main = &page.items[0];
        assert_eq!(main.root.id, CLAUDE_MAIN);
        // The nested thread sits directly under the root, as its parent has no
        // matching requests, but keeps its depth and parent id.
        assert_eq!(
            thread_ids(main),
            [CLAUDE_MAIN, CLAUDE_NESTED, deeper, CLAUDE_AGENT_B]
        );
        assert_eq!(thread_depths(main), [0, 2, 3, 1]);
        assert_eq!(
            thread_parents(main),
            [
                None,
                Some(CLAUDE_AGENT_A),
                Some(CLAUDE_NESTED),
                Some(CLAUDE_MAIN)
            ]
        );
        assert_eq!((main.subagents, main.root.totals.requests), (3, 4));
        assert_eq!(main.root.models, ["claude-opus-4-5"]);
    }

    #[test]
    fn sessions_group_children_under_a_root_outside_the_time_range() {
        let start = SESSION_T0 + 3_600_000;
        let connection = session_test_database(&[
            SessionRow {
                user_agent: Some("claude-cli/main"),
                api_key_hash: "main-hash",
                ..session_row(CLAUDE_MAIN, None, SESSION_T0)
            },
            SessionRow {
                user_agent: Some("claude-cli/agent-b"),
                api_key_hash: "agent-b-hash",
                ..session_row(CLAUDE_AGENT_B, Some(CLAUDE_MAIN), start + 15_000)
            },
            SessionRow {
                user_agent: Some("claude-cli/agent-a"),
                api_key_hash: "agent-a-hash",
                ..session_row(CLAUDE_AGENT_A, Some(CLAUDE_MAIN), start + 10_000)
            },
            session_row(CLAUDE_NESTED, Some(CLAUDE_AGENT_A), start + 20_000),
        ]);
        let page = load_test_sessions(
            &connection,
            UsageQuery {
                start: Some(rfc3339_millis(start)),
                ..UsageQuery::default()
            },
        );
        assert_eq!(page.total, 1);
        let session = &page.items[0];
        assert_eq!(session.root.id, CLAUDE_MAIN);
        assert!(!session.has_own_requests);
        assert_eq!(
            thread_ids(session),
            [CLAUDE_AGENT_A, CLAUDE_NESTED, CLAUDE_AGENT_B]
        );
        assert_eq!(thread_depths(session), [1, 2, 1]);
        assert_eq!((session.subagents, session.root.totals.requests), (3, 3));
        assert_eq!(session.root.totals.started_at_ms, start + 10_000);
        // With no requests of its own, the root takes these from its earliest thread.
        assert_eq!(
            session.root.user_agent.as_deref(),
            Some("claude-cli/agent-a")
        );
        assert_eq!(session.api_key_hash, "agent-a-hash");
        assert_eq!(page.summary.subagent_threads, 3);
    }

    #[test]
    fn sessions_turn_an_unseen_parent_into_a_placeholder_root() {
        let codex_row = |id, parent, timestamp_ms| SessionRow {
            model: "gpt-5.6-terra",
            provider: "codex",
            ..session_row(id, parent, timestamp_ms)
        };
        let connection = session_test_database(&[
            codex_row(CODEX_CHILD, Some(CODEX_UNSEEN_PARENT), SESSION_T0),
            codex_row(CODEX_CHILD, Some(CODEX_UNSEEN_PARENT), SESSION_T0 + 1_000),
            codex_row(CODEX_ROOT, None, SESSION_T0 + 500),
        ]);
        let page = load_test_sessions(
            &connection,
            UsageQuery {
                sort: Some("requests".into()),
                ..UsageQuery::default()
            },
        );
        assert_eq!(page.total, 2);
        let placeholder = &page.items[0];
        assert_eq!(placeholder.root.id, CODEX_UNSEEN_PARENT);
        assert!(!placeholder.has_own_requests);
        assert_eq!(thread_ids(placeholder), [CODEX_CHILD]);
        assert_eq!(thread_parents(placeholder), [Some(CODEX_UNSEEN_PARENT)]);
        assert_eq!(thread_depths(placeholder), [1]);
        assert_eq!(
            (placeholder.subagents, placeholder.root.totals.requests),
            (1, 2)
        );
        assert_eq!(placeholder.provider, "codex");
        assert_eq!(page.items[1].root.id, CODEX_ROOT);
        assert!(page.items[1].has_own_requests);
        assert_eq!(page.summary.subagent_threads, 1);
    }

    #[test]
    fn sessions_stop_at_cycles_in_parent_links() {
        let start = SESSION_T0 + 60_000;
        let connection = session_test_database(&[
            session_row("loop-a", Some("loop-b"), start),
            session_row("loop-b", Some("loop-a"), start + 1_000),
            session_row("own-parent", Some("own-parent"), start + 2_000),
            session_row("tail", Some("loop-a"), start + 3_000),
            // A cycle the unfiltered ancestor lookup has to walk into.
            session_row("outside-a", Some("outside-b"), SESSION_T0),
            session_row("outside-b", Some("outside-a"), SESSION_T0),
            session_row("inside", Some("outside-a"), start + 4_000),
        ]);
        let page = load_test_sessions(
            &connection,
            UsageQuery {
                start: Some(rfc3339_millis(start)),
                ..UsageQuery::default()
            },
        );
        let mut threads = page.items.iter().flat_map(thread_ids).collect::<Vec<_>>();
        threads.sort_unstable();
        assert_eq!(
            threads,
            ["inside", "loop-a", "loop-b", "own-parent", "tail"]
        );
        assert_eq!(page.summary.requests, 5);
        // Each session whose ancestry loops is its own root.
        assert!(page.items.iter().all(|session| {
            session.has_own_requests
                && thread_depths(session) == [0]
                && session.threads[0].parent_id.is_none()
        }));
    }

    #[test]
    fn sessions_count_requests_without_a_session_as_untracked() {
        let untracked = SessionRow {
            session: None,
            ..session_row("", None, SESSION_T0)
        };
        let connection = session_test_database(&[
            session_row(CLAUDE_MAIN, None, SESSION_T0),
            untracked.clone(),
            SessionRow {
                model: "claude-haiku-4-5",
                ..untracked.clone()
            },
            SessionRow {
                session: Some(""),
                ..untracked
            },
        ]);
        let page = load_test_sessions(&connection, UsageQuery::default());
        assert_eq!(page.total, 1);
        assert_eq!(
            (page.summary.requests, page.summary.untracked_requests),
            (1, 3)
        );
        let opus = load_test_sessions(
            &connection,
            UsageQuery {
                model: Some("claude-opus-4-5".into()),
                ..UsageQuery::default()
            },
        );
        assert_eq!(opus.summary.untracked_requests, 2);
    }

    #[test]
    fn sessions_sort_by_recent_cost_tokens_or_requests_and_paginate() {
        let connection = session_test_database(&[]);
        for (model, price) in [("cheap-model", 1.0), ("pricey-model", 100.0)] {
            upsert_model_price(
                &connection,
                &ModelPrice {
                    model: model.to_string(),
                    prompt: price,
                    completion: price,
                    prompt_configured: true,
                    completion_configured: true,
                    source: "manual".to_string(),
                    ..ModelPrice::default()
                },
            )
            .unwrap();
        }
        let row = |id, model, timestamp_ms, tokens| SessionRow {
            model,
            input_tokens: tokens,
            output_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: tokens,
            ..session_row(id, None, timestamp_ms)
        };
        insert_session_rows(
            &connection,
            &[
                row("a", "cheap-model", SESSION_T0, 1_000),
                row("a", "cheap-model", SESSION_T0, 1_000),
                row("a", "cheap-model", SESSION_T0 + 1_000, 1_000),
                row("b", "pricey-model", SESSION_T0 + 2_000, 500),
                row("c", "unpriced-model", SESSION_T0 + 2_500, 25_000),
                row("c", "unpriced-model", SESSION_T0 + 3_000, 25_000),
                row("d", "cheap-model", SESSION_T0 + 4_000, 10),
            ],
        );
        let order = |sort: Option<&str>| {
            load_test_sessions(
                &connection,
                UsageQuery {
                    sort: sort.map(str::to_string),
                    ..UsageQuery::default()
                },
            )
            .items
            .into_iter()
            .map(|session| session.root.id)
            .collect::<Vec<_>>()
        };
        assert_eq!(order(None), ["d", "c", "b", "a"]);
        assert_eq!(order(Some("recent")), ["d", "c", "b", "a"]);
        assert_eq!(order(Some("cost")), ["b", "a", "d", "c"]);
        assert_eq!(order(Some("tokens")), ["c", "a", "b", "d"]);
        // b and d tie on requests, so the more recent one comes first.
        assert_eq!(order(Some("requests")), ["a", "c", "d", "b"]);
        assert_eq!(order(Some("unknown")), ["d", "c", "b", "a"]);

        let empty = load_test_sessions(&session_test_database(&[]), UsageQuery::default());
        assert_eq!(
            (
                empty.items.len(),
                empty.total,
                empty.page,
                empty.total_pages
            ),
            (0, 0, 1, 1)
        );

        // Pairs of sessions share a last request, so ids break the tie.
        let ids = (0..25)
            .map(|index| format!("page-{index:02}"))
            .collect::<Vec<_>>();
        let connection = session_test_database(&[]);
        for (index, id) in ids.iter().enumerate() {
            insert_session_rows(
                &connection,
                &[session_row(
                    id,
                    None,
                    SESSION_T0 + (index as i64 / 2) * 1_000,
                )],
            );
        }
        let page = |page, page_size| {
            load_test_sessions(
                &connection,
                UsageQuery {
                    page,
                    page_size,
                    ..UsageQuery::default()
                },
            )
        };
        let page_ids = |page: &UsageSessionPage| {
            page.items
                .iter()
                .map(|session| session.root.id.clone())
                .collect::<Vec<_>>()
        };
        let last = page(Some(99), Some(1));
        assert_eq!(
            (last.total, last.page, last.page_size, last.total_pages),
            (25, 2, 20, 2)
        );
        assert_eq!(
            page_ids(&last),
            ["page-05", "page-02", "page-03", "page-00", "page-01"]
        );
        assert_eq!(last.summary.sessions, 25);
        let first = page(Some(0), Some(20));
        assert_eq!((first.page, first.items.len()), (1, 20));
        assert_eq!(page_ids(&first)[..3], ["page-24", "page-22", "page-23"]);
        let all = page(Some(5), Some(1_000));
        assert_eq!(
            (all.page, all.page_size, all.total_pages, all.items.len()),
            (1, 200, 1, 25)
        );
    }

    #[test]
    fn sessions_stay_active_for_five_minutes_after_their_last_request() {
        let now_ms = SESSION_T0 + 3_600_000;
        let window_start = now_ms - ACTIVE_SESSION_WINDOW_MS;
        let connection = session_test_database(&[
            // Last active exactly at the window start, counting latency.
            SessionRow {
                latency_ms: 2_000,
                ..session_row("edge", None, window_start - 2_000)
            },
            SessionRow {
                latency_ms: 0,
                ..session_row("stale", None, window_start - 1)
            },
            // An old main session stays active while a subagent is working.
            session_row(CLAUDE_MAIN, None, SESSION_T0),
            session_row(CLAUDE_AGENT_A, Some(CLAUDE_MAIN), now_ms - 1_000),
        ]);
        let page = load_usage_sessions(
            &connection,
            &UsageQuery::default(),
            &GuiConfigFile::default(),
            now_ms,
        )
        .unwrap();
        let active = page
            .items
            .iter()
            .map(|session| (session.root.id.as_str(), session.active))
            .collect::<HashMap<_, _>>();
        assert_eq!(
            active,
            HashMap::from([("edge", true), ("stale", false), (CLAUDE_MAIN, true)])
        );
        assert_eq!(page.summary.active, 2);
    }

    #[test]
    fn session_costs_match_the_usage_cost_of_the_same_requests() {
        let long_context = |row: SessionRow<'static>| SessionRow {
            input_tokens: 300_000,
            cache_read_tokens: 100_000,
            output_tokens: 2_000,
            total_tokens: 302_000,
            ..row
        };
        let codex_row = |id, parent, timestamp_ms| SessionRow {
            model: "gpt-5.6-terra",
            provider: "codex",
            service_tier: "priority",
            response_service_tier: "default",
            ..session_row(id, parent, timestamp_ms)
        };
        let connection = session_test_database(&[
            // Codex requests are priced at the tier they asked for.
            long_context(codex_row(CODEX_ROOT, None, SESSION_T0)),
            codex_row(CODEX_ROOT, None, SESSION_T0 + 1_000),
            // Other requests are priced at the tier the response reports.
            SessionRow {
                provider: "openai",
                response_service_tier: "flex",
                ..codex_row(CODEX_CHILD, Some(CODEX_ROOT), SESSION_T0 + 2_000)
            },
            SessionRow {
                model: "claude-haiku-4-5",
                ..session_row(CLAUDE_MAIN, None, SESSION_T0 + 3_000)
            },
            SessionRow {
                model: "claude-haiku-4-5",
                ..session_row(CLAUDE_AGENT_A, Some(CLAUDE_MAIN), SESSION_T0 + 4_000)
            },
            SessionRow {
                model: "mystery-model",
                ..session_row(CLAUDE_AGENT_A, Some(CLAUDE_MAIN), SESSION_T0 + 5_000)
            },
        ]);
        let prices = load_model_prices(&connection).unwrap();
        let usage_cost = |filter: UsageSqlFilter| {
            sum_usage_cost(
                &load_usage_cost_groups(&connection, &filter).unwrap(),
                &prices,
            )
        };
        let page = load_test_sessions(&connection, UsageQuery::default());
        assert_eq!(page.total, 2);
        for session in &page.items {
            let (cost, priced) = usage_cost(build_usage_filter(&UsageQuery {
                session: Some(session.root.id.clone()),
                ..UsageQuery::default()
            }));
            assert!(cost > 0.0);
            assert!(
                (session.root.totals.estimated_cost - cost).abs() < 1e-12,
                "{} {} {cost}",
                session.root.id,
                session.root.totals.estimated_cost
            );
            assert_eq!(session.root.totals.priced_requests, priced);
            for thread in &session.threads {
                let (cost, priced) = usage_cost(UsageSqlFilter {
                    clause: " WHERE session_id = ?".to_string(),
                    params: vec![SqlValue::Text(thread.id.clone())],
                });
                assert!(
                    (thread.totals.estimated_cost - cost).abs() < 1e-12,
                    "{} {} {cost}",
                    thread.id,
                    thread.totals.estimated_cost
                );
                assert_eq!(thread.totals.priced_requests, priced);
            }
        }
        let claude = page
            .items
            .iter()
            .find(|session| session.root.id == CLAUDE_MAIN)
            .unwrap();
        assert_eq!(
            (
                claude.root.totals.requests,
                claude.root.totals.priced_requests
            ),
            (3, 2)
        );
        let overview = load_usage_overview(&connection, &UsageQuery::default()).unwrap();
        assert!((page.summary.estimated_cost - overview.estimated_cost).abs() < 1e-12);
        assert_eq!(page.summary.priced_requests, overview.priced_requests);
    }

    #[test]
    fn session_filter_matches_a_session_and_all_of_its_descendants() {
        let connection = session_test_database(&[
            session_row(CLAUDE_MAIN, None, SESSION_T0),
            session_row(CLAUDE_MAIN, None, SESSION_T0 + 1_000),
            SessionRow {
                model: "claude-haiku-4-5",
                ..session_row(CLAUDE_AGENT_A, Some(CLAUDE_MAIN), SESSION_T0 + 2_000)
            },
            session_row(CLAUDE_NESTED, Some(CLAUDE_AGENT_A), SESSION_T0 + 3_000),
            session_row(CLAUDE_AGENT_B, Some(CLAUDE_MAIN), SESSION_T0 + 4_000),
            session_row(CODEX_ROOT, None, SESSION_T0 + 5_000),
            session_row("loop-a", Some("loop-b"), SESSION_T0 + 6_000),
            session_row("loop-b", Some("loop-a"), SESSION_T0 + 7_000),
            SessionRow {
                session: None,
                ..session_row("", None, SESSION_T0 + 8_000)
            },
        ]);
        let config = GuiConfigFile::default();
        let count = |session: &str, model: Option<&str>| {
            let query = UsageQuery {
                session: Some(session.to_string()),
                model: model.map(str::to_string),
                ..UsageQuery::default()
            };
            load_usage_events(&connection, &query, &config)
                .unwrap()
                .total
        };
        assert_eq!(count(CLAUDE_MAIN, None), 5);
        assert_eq!(count(&format!(" {CLAUDE_MAIN} "), None), 5);
        assert_eq!(count(CLAUDE_AGENT_A, None), 2);
        assert_eq!(count(CLAUDE_NESTED, None), 1);
        assert_eq!(count(CODEX_ROOT, None), 1);
        assert_eq!(count(CLAUDE_MAIN, Some("claude-haiku-4-5")), 1);
        assert_eq!(count("loop-a", None), 2);
        assert_eq!(count("missing", None), 0);
        assert_eq!(count("", None), 9);

        let main = UsageQuery {
            session: Some(CLAUDE_MAIN.to_string()),
            ..UsageQuery::default()
        };
        let overview = load_usage_overview(&connection, &main).unwrap();
        assert_eq!(overview.total_requests, 5);
        let machines = serde_json::to_value(&overview.machines).unwrap();
        assert_eq!(
            machines
                .as_array()
                .unwrap()
                .iter()
                .map(|machine| machine["requests"].as_u64().unwrap())
                .sum::<u64>(),
            5
        );
        let analysis = load_usage_analysis(&connection, &main, &config).unwrap();
        assert_eq!(
            analysis
                .models
                .iter()
                .map(|model| model.requests)
                .sum::<u64>(),
            5
        );

        // Filtering the sessions view to a subagent keeps it under its root.
        let page = load_test_sessions(
            &connection,
            UsageQuery {
                session: Some(CLAUDE_AGENT_A.to_string()),
                ..UsageQuery::default()
            },
        );
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].root.id, CLAUDE_MAIN);
        assert!(!page.items[0].has_own_requests);
        assert_eq!(thread_ids(&page.items[0]), [CLAUDE_AGENT_A, CLAUDE_NESTED]);
        assert_eq!(page.summary.untracked_requests, 0);
    }

    #[test]
    fn sessions_can_be_narrowed_to_one_account_and_one_model_family() {
        let connection = session_test_database(&[
            SessionRow {
                auth_index: "work",
                ..session_row(CLAUDE_MAIN, None, SESSION_T0)
            },
            SessionRow {
                auth_index: "work",
                model: "claude-sonnet-4-6",
                ..session_row(CLAUDE_MAIN, None, SESSION_T0 + 1_000)
            },
            SessionRow {
                auth_index: "home",
                ..session_row(CLAUDE_AGENT_A, Some(CLAUDE_MAIN), SESSION_T0 + 2_000)
            },
            SessionRow {
                auth_index: "work",
                model: "gpt-5.5-codex",
                provider: "codex",
                ..session_row(CODEX_ROOT, None, SESSION_T0 + 3_000)
            },
            SessionRow {
                session: None,
                auth_index: "work",
                ..session_row("", None, SESSION_T0 + 4_000)
            },
        ]);
        let sessions = |auth_index: &str, model_family: Option<&str>| {
            load_test_sessions(
                &connection,
                UsageQuery {
                    auth_index: Some(auth_index.to_string()),
                    model_family: model_family.map(str::to_string),
                    sort: Some("requests".to_string()),
                    ..UsageQuery::default()
                },
            )
        };

        let work = sessions("work", None);
        assert_eq!(
            work.items
                .iter()
                .map(|session| (session.root.id.as_str(), session.root.totals.requests))
                .collect::<Vec<_>>(),
            [(CLAUDE_MAIN, 2), (CODEX_ROOT, 1)]
        );
        // The subagent ran on another account, so it isn't part of this one's use.
        assert_eq!(work.items[0].subagents, 0);
        assert_eq!(work.summary.requests, 3);
        assert_eq!(work.summary.untracked_requests, 1);

        // A family matches any part of the model name, whatever its case.
        let opus = sessions("work", Some(" OPUS "));
        assert_eq!(opus.total, 1);
        assert_eq!(opus.items[0].root.id, CLAUDE_MAIN);
        assert_eq!(opus.items[0].root.totals.requests, 1);
        assert_eq!(opus.summary.untracked_requests, 1);

        let home = sessions("home", None);
        assert_eq!(home.total, 1);
        assert_eq!(home.items[0].root.id, CLAUDE_MAIN);
        assert!(!home.items[0].has_own_requests);
        assert_eq!(thread_ids(&home.items[0]), [CLAUDE_AGENT_A]);

        assert_eq!(sessions("elsewhere", None).total, 0);
    }

    #[test]
    fn session_filter_walks_the_tree_through_the_session_indexes() {
        let connection = session_test_database(&[]);
        let filter = build_usage_filter(&UsageQuery {
            session: Some(CLAUDE_MAIN.to_string()),
            ..UsageQuery::default()
        });
        let mut statement = connection
            .prepare(&format!(
                "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM usage_events{}",
                filter.clause
            ))
            .unwrap();
        let plan = statement
            .query_map(params_from_iter(filter.params.iter()), |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
            .join("\n");
        assert!(
            plan.contains("idx_usage_events_parent_session (parent_session_id=?)"),
            "{plan}"
        );
        assert!(
            plan.contains("idx_usage_events_session (session_id=?)"),
            "{plan}"
        );
        assert!(
            plan.lines()
                .all(|line| line != "SCAN e" && !line.starts_with("SCAN usage_events")),
            "{plan}"
        );
    }

    #[test]
    fn failures_filter_reads_only_the_failed_requests_index() {
        let connection = schema::test_database();
        let plan = |query: &UsageQuery, select: &str| {
            let filter = build_usage_filter(query);
            let mut statement = connection
                .prepare(&format!("EXPLAIN QUERY PLAN SELECT {select} FROM usage_events{} ORDER BY timestamp_ms DESC, id DESC", filter.clause))
                .unwrap();
            statement
                .query_map(params_from_iter(filter.params.iter()), |row| row.get::<_, String>(3))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .join("\n")
        };
        let failures = UsageQuery { failed: Some(true), ..UsageQuery::default() };
        for select in ["COUNT(*)", "id"] {
            let plan = plan(&failures, select);
            assert!(plan.contains("idx_usage_events_failures"), "{plan}");
            assert!(!plan.contains("TEMP B-TREE"), "{plan}");
        }
        let week = UsageQuery { start: Some("2026-09-19T00:00:00Z".into()), ..failures };
        let plan = plan(&week, "id");
        assert!(plan.contains("idx_usage_events_failures (timestamp_ms>?)"), "{plan}");

        // A canceled request marked failed isn't a failure.
        schema::insert_request(&connection, "failed, canceled, timestamp_ms", params![1, 0, 1]);
        schema::insert_request(&connection, "failed, canceled, timestamp_ms", params![1, 1, 2]);
        schema::insert_request(&connection, "failed, canceled, timestamp_ms", params![0, 0, 3]);
        let filter = build_usage_filter(&UsageQuery { failed: Some(true), ..UsageQuery::default() });
        let counted: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM usage_events{}", filter.clause), params_from_iter(filter.params.iter()), |row| row.get(0))
            .unwrap();
        assert_eq!(counted, 1);
    }

    #[test]
    fn model_families_match_as_the_lower_case_copy_did() {
        let copied = |model: &str, family: &str| {
            let normalized = model.trim().to_ascii_lowercase().rsplit('/').next().unwrap_or_default().to_string();
            normalized == family || normalized.starts_with(&format!("{family}-"))
        };
        let models = [
            "gpt-5.5", "GPT-5.5", " openai/gpt-5.5-codex ", "gpt-5.5x", "gpt-5", "gpt-5.5-", "claude-sonnet-4-5[1m]",
            "anthropic/Claude-Sonnet-4-5-20250929", "gemini-2.5-pro", "", "/", "gpt-5.5/", "Ünï/gpt-5.5", "gpt-5.5-ünï",
        ];
        for model in models {
            for family in ["gpt-5.5", "claude-sonnet-4-5", "gemini-2.5-pro", "gpt-5"] {
                assert_eq!(is_model_family(model, family), copied(model, family), "{model:?} {family:?}");
            }
        }
    }

    #[test]
    fn record_changes_are_announced_at_most_once_a_second() {
        let start = std::time::Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut gate = UsageEventGate { last_sent: None, due: false };
        assert_eq!(gate.pass(at(0)), UsageEventSend::Now);
        // A burst right after: one more goes out when the second is up, covering the lot.
        assert_eq!(gate.pass(at(100)), UsageEventSend::After(Duration::from_millis(900)));
        assert_eq!(gate.pass(at(200)), UsageEventSend::AlreadyDue);
        assert_eq!(gate.pass(at(950)), UsageEventSend::AlreadyDue);
        gate.sent_late(at(1_000));
        assert_eq!(gate.pass(at(1_400)), UsageEventSend::After(Duration::from_millis(600)));
        gate.sent_late(at(2_000));
        // After a quiet spell the next change goes out at once.
        assert_eq!(gate.pass(at(5_000)), UsageEventSend::Now);
    }
}

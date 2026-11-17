//! Compute: cloud sandboxes from a provider the user connects in Settings › Compute, shown on the Compute page with
//! their size, load, cost, auto-stop and what started them. Sandboxes are not machines: nothing here touches the
//! Machines list, Sync or host keys.
//!
//! Each provider is a first-party module behind [`ComputeProvider`], listed in [`PROVIDERS`], the way the automation
//! apps are. The trait only reads: a provider reaches its API through [`ComputeGet`], which Arbor hands it and which
//! can only GET a path on the provider's fixed base, so nothing a provider does can change anything there.
//!
//! What crosses to the webview is the normalized model below. A provider's free text (process command lines, error
//! reasons, who created a sandbox, its addresses and labels) stays in Rust: each is reduced to an enum, a yes/no or a
//! resolved machine and session before it gets here. The key never leaves Rust.

mod boat;
mod files;
#[cfg(test)]
mod tests;

use crate::command_error::CommandError;
use crate::usage::compute_lookup::{self, ComputeLookup, ListedMachine, SeenSession};
use files::{ComputeClaim, ComputeKey};
use futures_util::future::BoxFuture;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

/// Sent with the whole [`ComputeSnapshot`] after every round and after connect, disconnect, link and unlink. Never
/// sent while no provider is connected, except the one after a disconnect.
pub(crate) const COMPUTE_UPDATED_EVENT: &str = "compute-updated";

/// A provider Arbor can read sandboxes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ComputeProviderId {
    Boat,
}

/// Every connected provider's sandboxes and limits. A provider with no key saved isn't in it.
#[derive(Clone, Debug, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputeSnapshot {
    pub(crate) providers: Vec<ComputeProviderSnapshot>,
}

/// How the last round at a provider went.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ComputeProviderStatus {
    Ok,
    /// The provider refused the key (401, or 403 on the list): it was revoked or has expired.
    Refused,
    /// The list reads but the key can't read the limits.
    LimitsNeedScope,
    /// The provider couldn't be reached; the last good figures stay.
    Unreachable,
    /// The provider asked Arbor to slow down; the last good figures stay.
    RateLimited,
}

/// What the key can do at the provider, where the provider says.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ComputeKeyAccess {
    ReadOnly,
    /// It could change things there too; Arbor still only reads.
    CanWrite,
    Unknown,
}

/// What a provider can tell Arbor beyond its list.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputeCapabilities {
    pub(crate) limits: bool,
    /// CPU and memory for a running sandbox.
    pub(crate) load: bool,
    pub(crate) cost: bool,
    pub(crate) auto_stop: bool,
}

/// One provider in the snapshot. Times are unix ms.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputeProviderSnapshot {
    pub(crate) id: ComputeProviderId,
    pub(crate) status: ComputeProviderStatus,
    pub(crate) key_access: ComputeKeyAccess,
    #[ts(type = "number | null")]
    pub(crate) key_expires_at_ms: Option<i64>,
    /// The last round whose list succeeded; null before the first.
    #[ts(type = "number | null")]
    pub(crate) checked_at_ms: Option<i64>,
    pub(crate) capabilities: ComputeCapabilities,
    pub(crate) limits: Vec<ComputeLimit>,
    /// Whether the provider would let a sandbox start now; null when it doesn't say.
    pub(crate) can_start: Option<bool>,
    pub(crate) start_block: Option<ComputeStartBlock>,
    /// Plan hours used per hour at the current rate: the billing multipliers of the running sandboxes added up.
    pub(crate) plan_hours_per_hour: Option<f64>,
    /// When the plan hours run out at the current rate.
    #[ts(type = "number | null")]
    pub(crate) run_out_at_ms: Option<i64>,
    /// When the billing period ends and the plan hours reset.
    #[ts(type = "number | null")]
    pub(crate) period_end_ms: Option<i64>,
    /// The list stopped at Arbor's page cap, so it may be missing sandboxes (the oldest, as providers list newest
    /// first).
    pub(crate) list_partial: bool,
    pub(crate) sandboxes: Vec<ComputeSandbox>,
}

/// A limit on the account, with how much of it is used.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputeLimit {
    pub(crate) kind: ComputeLimitKind,
    pub(crate) used: f64,
    /// Null when there's no cap.
    pub(crate) max: Option<f64>,
    #[ts(type = "number | null")]
    pub(crate) resets_at_ms: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ComputeLimitKind {
    ActiveSandboxes,
    StartsPerMinute,
    StartsPerHour,
    StartsPerDay,
    PlanHours,
    /// Spend beyond the plan, in dollars.
    ExtraSpend,
}

/// Why the provider would refuse to start a sandbox now, from its own reason reduced to a kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ComputeStartBlock {
    PlanHoursGone,
    WalletEmpty,
    StartRate,
    ActiveMax,
    Other,
}

/// One sandbox. Its id, name and size name cross; nothing else of the provider's text does. Times are unix ms.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputeSandbox {
    pub(crate) id: String,
    pub(crate) name: String,
    /// The provider's name for its size or type.
    pub(crate) size: String,
    pub(crate) vcpus: u32,
    pub(crate) memory_gb: f64,
    /// Plan hours each hour running costs; null when the provider doesn't say.
    pub(crate) multiplier: Option<f64>,
    pub(crate) state: ComputeSandboxState,
    pub(crate) issue: Option<ComputeIssue>,
    /// When Arbor first saw the issue.
    #[ts(type = "number | null")]
    pub(crate) issue_since_ms: Option<i64>,
    #[ts(type = "number")]
    pub(crate) created_at_ms: i64,
    /// When its current run began: a resume starts a new run of the same sandbox. A sandbox still restoring counts as
    /// just started.
    #[ts(type = "number")]
    pub(crate) started_at_ms: i64,
    /// When it stops on its own.
    #[ts(type = "number | null")]
    pub(crate) stops_at_ms: Option<i64>,
    pub(crate) auto_stop_seconds: Option<u32>,
    /// Plan hours this month.
    pub(crate) month_hours: Option<f64>,
    pub(crate) month_dollars: Option<f64>,
    /// Made by the key's own user rather than a teammate. A teammate's is never linked and never forgotten.
    pub(crate) mine: bool,
    pub(crate) load: ComputeLoad,
    /// The latest 30 readings, oldest first, for the row's sparkline.
    pub(crate) points: Vec<ComputePoint>,
    /// The Arbor machine that started it, by a link Arbor recorded or the provider's label; only a name on the Machines list.
    pub(crate) machine: Option<String>,
    pub(crate) session: Option<ComputeSession>,
    /// Where the machine and session came from; only a link can be unlinked. Null when nothing names either.
    pub(crate) linked_by: Option<ComputeLinkedBy>,
    pub(crate) link_problem: Option<ComputeLinkProblem>,
    pub(crate) forgotten: Option<ComputeForgotten>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ComputeSandboxState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Error,
}

/// What's wrong with a sandbox, from the provider's health reason or error reduced to a kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ComputeIssue {
    DiskPressure,
    MemoryPressure,
    Crashed,
    SetupFailed,
    Other,
}

/// A sandbox's latest CPU and memory, or why there's none. Fractions are 0–1.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum ComputeLoad {
    Read {
        cpu: f64,
        memory: f64,
        #[ts(type = "number")]
        at_ms: i64,
    },
    NotReadYet,
    /// Monitoring is turned off for it at the provider.
    MonitoringOff,
    /// The provider won't give load to this key, so only another key shows it.
    KeyCantRead,
    /// No reading to give: the provider doesn't give one, the sandbox's agent has no current sample, or it isn't
    /// running.
    Unavailable,
}

/// The agent session that started a sandbox, by the id a link or label gave, matched exactly against the sessions
/// Arbor records.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputeSession {
    pub(crate) id: String,
    /// Arbor has seen this session. When it hasn't, the rest are empty and it never makes a sandbox forgotten.
    pub(crate) known: bool,
    /// Live by Arbor's own definition of a live session.
    pub(crate) live: bool,
    #[ts(type = "number | null")]
    pub(crate) ended_at_ms: Option<i64>,
    pub(crate) harness: Option<crate::usage::machine_health::harnesses::Harness>,
}

/// One CPU and memory reading. Fractions are 0–1.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputePoint {
    #[ts(type = "number")]
    pub(crate) at_ms: i64,
    pub(crate) cpu: f64,
    pub(crate) memory: f64,
}

/// What named a sandbox's machine and session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ComputeLinkedBy {
    /// `link_compute_sandbox`, which `unlink_compute_sandbox` undoes.
    Link,
    /// The provider's `arbor.machine` and `arbor.session` labels, which only change at the provider.
    Label,
}

/// Why an own sandbox shows no machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ComputeLinkProblem {
    /// No link or label names a machine.
    NotLinked,
    /// The machine named isn't on the Machines list.
    UnknownMachine,
}

/// Why a running sandbox of one's own looks forgotten.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ComputeForgotten {
    /// Its session ended a while ago and it won't stop by itself soon.
    SessionEnded,
    /// It has no auto-stop and has run for hours.
    NoAutoStop,
    /// It has run much longer than its auto-stop: something keeps extending it.
    KeptAlive,
}

// What follows is the provider's side, which never crosses to the webview.

/// An answer from the provider's API as it came. Only the provider reads the body, and only into the fields it binds.
pub(crate) struct ComputeReply {
    pub(crate) status: u16,
    /// From a 429's Retry-After.
    pub(crate) retry_after_secs: Option<u64>,
    pub(crate) body: String,
}

/// The one way a provider reaches its API: a GET of an allowed path (with its query) on the provider's fixed base,
/// with the key filled in by Arbor. An `Err` is a request that got no answer.
pub(crate) trait ComputeGet: Sync {
    fn get<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<ComputeReply, ComputeFailure>>;
}

/// Why a provider call failed, as a kind. Provider bodies and reasons never ride along.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ComputeFailure {
    /// 401: the key is refused or expired.
    Refused,
    /// 403: the key can't read this.
    Forbidden,
    /// Monitoring is off for this sandbox (Boat's 409 `monitoring_off`).
    MonitoringOff,
    /// The load sample isn't current: the sandbox stopped, or its agent is too old to report.
    NotLive,
    RateLimited { retry_after_secs: Option<u64> },
    /// No answer, or a server error.
    Unreachable,
    /// An answer Arbor can't read.
    Unexpected,
    /// The provider has no such call, or the path isn't on its allowlist.
    Unsupported,
}

/// A reply's body when it succeeded, or the kind of failure its status says. The body of a failure is never read
/// here, so a provider's words can't ride along.
pub(crate) fn reply_body(reply: ComputeReply) -> Result<String, ComputeFailure> {
    match reply.status {
        200..=299 => Ok(reply.body),
        401 => Err(ComputeFailure::Refused),
        403 => Err(ComputeFailure::Forbidden),
        429 => Err(ComputeFailure::RateLimited { retry_after_secs: reply.retry_after_secs }),
        408 | 500..=599 => Err(ComputeFailure::Unreachable),
        _ => Err(ComputeFailure::Unexpected),
    }
}

/// A sandbox as a provider lists it, before Arbor links it to a machine and session.
#[derive(Clone, Debug)]
pub(crate) struct ListedSandbox {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) size: String,
    pub(crate) vcpus: u32,
    pub(crate) memory_gb: f64,
    pub(crate) multiplier: Option<f64>,
    pub(crate) state: ComputeSandboxState,
    pub(crate) issue: Option<ComputeIssue>,
    /// When the provider says the issue began; Arbor uses when it first saw it otherwise.
    pub(crate) issue_since_ms: Option<i64>,
    pub(crate) created_at_ms: i64,
    /// When the current run began (a resume starts a new one); None while it's still restoring, which counts as just
    /// started.
    pub(crate) run_started_at_ms: Option<i64>,
    pub(crate) stops_at_ms: Option<i64>,
    pub(crate) auto_stop_seconds: Option<u32>,
    pub(crate) month_hours: Option<f64>,
    pub(crate) month_dollars: Option<f64>,
    pub(crate) mine: bool,
    /// Monitoring is off for it at the provider, so there's no load to ask for.
    pub(crate) monitoring_off: bool,
    /// The `arbor.machine` and `arbor.session` labels, where the provider lets them be set. Resolved, never shown.
    pub(crate) label_machine: Option<String>,
    pub(crate) label_session: Option<String>,
}

/// A provider's list of sandboxes.
#[derive(Clone, Debug, Default)]
pub(crate) struct ListedSandboxes {
    pub(crate) sandboxes: Vec<ListedSandbox>,
    /// It stopped at the page cap with more to come. Links are never pruned off a partial list.
    pub(crate) partial: bool,
}

/// The account's limits as a provider reads them.
#[derive(Clone, Debug)]
pub(crate) struct ListedLimits {
    pub(crate) limits: Vec<ComputeLimit>,
    pub(crate) can_start: Option<bool>,
    pub(crate) start_block: Option<ComputeStartBlock>,
    pub(crate) period_end_ms: Option<i64>,
}

/// One CPU and memory reading of a running sandbox, fractions 0–1.
#[derive(Clone, Copy, Debug)]
pub(crate) struct LoadSample {
    pub(crate) cpu: f64,
    pub(crate) memory: f64,
}

/// What the key can do and when it expires, where the provider says.
#[derive(Clone, Copy, Debug)]
pub(crate) struct KeyInfo {
    pub(crate) access: ComputeKeyAccess,
    pub(crate) expires_at_ms: Option<i64>,
}

/// A provider of sandboxes. Read-only: there is no call that changes anything at the provider.
pub(crate) trait ComputeProvider: Sync {
    fn id(&self) -> ComputeProviderId;
    /// Its name as shown ("Boat").
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> ComputeCapabilities;
    /// The fixed API base every [`ComputeGet`] path is on.
    fn api_base(&self) -> &'static str;
    /// Whether Arbor may GET this path (with its query) on the base. Everything a provider asks for is checked here
    /// before any request leaves.
    fn allows(&self, path: &str) -> bool;
    /// Whether text has the shape of this provider's sandbox ids, so one can go into a path or a link.
    fn sandbox_id_ok(&self, sandbox_id: &str) -> bool;
    /// The provider's own page for a sandbox, opened by "Open in <provider>".
    fn dashboard_url(&self, sandbox_id: &str) -> String;
    /// Every sandbox the key can see, all pages up to a cap, with cost where the provider gives it.
    fn list<'a>(&'a self, api: &'a dyn ComputeGet) -> BoxFuture<'a, Result<ListedSandboxes, ComputeFailure>>;
    fn limits<'a>(&'a self, _api: &'a dyn ComputeGet) -> BoxFuture<'a, Result<ListedLimits, ComputeFailure>> {
        Box::pin(async { Err(ComputeFailure::Unsupported) })
    }
    /// The latest CPU and memory of a running sandbox.
    fn load<'a>(&'a self, _api: &'a dyn ComputeGet, _sandbox: &'a ListedSandbox) -> BoxFuture<'a, Result<LoadSample, ComputeFailure>> {
        Box::pin(async { Err(ComputeFailure::Unsupported) })
    }
    fn key_check<'a>(&'a self, _api: &'a dyn ComputeGet) -> BoxFuture<'a, Result<KeyInfo, ComputeFailure>> {
        Box::pin(async { Err(ComputeFailure::Unsupported) })
    }
}

/// Every provider Arbor knows, one module each.
pub(crate) const PROVIDERS: &[&dyn ComputeProvider] = &[&boat::Boat];

fn provider_by_id(id: ComputeProviderId) -> Option<&'static dyn ComputeProvider> {
    PROVIDERS.iter().copied().find(|provider| provider.id() == id)
}

// Requests.

/// Sends a GET with the key as a bearer token. The only transport there is: nothing here can send another method.
/// Tests put canned answers behind it, so they never reach the network.
pub(crate) trait ComputeHttp: Sync {
    fn get<'a>(&'a self, url: &'a reqwest::Url, key: &'a ComputeKey) -> BoxFuture<'a, Result<ComputeReply, ComputeFailure>>;
}

/// The most of a body Arbor reads; a list of every sandbox is far smaller.
const MAX_BODY_BYTES: usize = 16 << 20;

struct ReqwestHttp(reqwest::Client);

impl ReqwestHttp {
    /// Redirects aren't followed, so the key never goes anywhere but the provider's own base. Through the core's proxy
    /// setting, like the app's other requests, under a plain client name.
    fn new(proxy_url: &str) -> Result<ReqwestHttp, String> {
        let builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .user_agent("Arbor");
        crate::core_runtime::build_http_client_with_proxy(builder, proxy_url, "Couldn't set up Compute's requests").map(ReqwestHttp)
    }
}

impl ComputeHttp for ReqwestHttp {
    fn get<'a>(&'a self, url: &'a reqwest::Url, key: &'a ComputeKey) -> BoxFuture<'a, Result<ComputeReply, ComputeFailure>> {
        Box::pin(async move {
            // reqwest's errors name the URL and the cause; neither is kept, only that there was no answer.
            let mut response = self
                .0
                .get(url.clone())
                .bearer_auth(key.expose())
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .await
                .map_err(|_| ComputeFailure::Unreachable)?;
            let status = response.status().as_u16();
            let retry_after_secs = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u64>().ok());
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| ComputeFailure::Unreachable)? {
                if body.len() + chunk.len() > MAX_BODY_BYTES {
                    return Err(ComputeFailure::Unexpected);
                }
                body.extend_from_slice(&chunk);
            }
            let body = String::from_utf8(body).map_err(|_| ComputeFailure::Unexpected)?;
            Ok(ComputeReply { status, retry_after_secs, body })
        })
    }
}

/// The full address for a path a provider asks for, when it's on the allowlist and stays on the provider's fixed
/// base: same scheme, host, port and path prefix, nothing a path could steer elsewhere.
fn request_url(provider: &dyn ComputeProvider, path: &str) -> Option<reqwest::Url> {
    if !path.starts_with('/') || path.starts_with("//") || !provider.allows(path) {
        return None;
    }
    let base = reqwest::Url::parse(provider.api_base()).ok()?;
    let url = reqwest::Url::parse(&format!("{}{path}", provider.api_base())).ok()?;
    let stays = url.scheme() == "https"
        && url.host_str() == base.host_str()
        && url.port() == base.port()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path().starts_with(&format!("{}/", base.path().trim_end_matches('/')));
    stays.then_some(url)
}

/// What a provider is handed: its key and the transport, behind the allowlist.
struct ProviderApi<'a> {
    provider: &'a dyn ComputeProvider,
    key: &'a ComputeKey,
    http: &'a dyn ComputeHttp,
}

impl ComputeGet for ProviderApi<'_> {
    fn get<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<ComputeReply, ComputeFailure>> {
        Box::pin(async move {
            let url = request_url(self.provider, path).ok_or(ComputeFailure::Unsupported)?;
            self.http.get(&url, self.key).await
        })
    }
}

// The round.

/// How often a connected provider is read.
const ROUND_EVERY: Duration = Duration::from_secs(60);
/// "Check now" right after a round returns that round.
const REFRESH_AT_MOST_EVERY: Duration = Duration::from_secs(10);
/// Repeated failures wait longer each time, up to this.
const MAX_BACKOFF_MS: i64 = 10 * 60_000;
/// A Retry-After longer than this is taken as this.
const MAX_RETRY_AFTER_MS: i64 = 60 * 60_000;
/// A round that starts this much early still counts as due, so a wait that lands a moment before isn't skipped.
const DUE_SLACK_MS: i64 = 5_000;
/// Running sandboxes whose load is read in one round, least recently read first, and how many at once.
const LOADS_PER_ROUND: usize = 24;
const LOADS_AT_ONCE: usize = 8;
/// About two hours of readings at one a minute.
const RING_POINTS: usize = 120;
/// What the row's sparkline gets.
const SPARK_POINTS: usize = 30;
/// A link to a sandbox the list doesn't have yet is kept this long: lists lag a little behind a create.
const CLAIM_GRACE_MS: i64 = 10 * 60_000;
const MAX_MACHINE_NAME: usize = 100;
const MAX_SESSION_ID: usize = 128;
const MAX_KEY_LEN: usize = 1024;

// When a running sandbox of one's own looks forgotten. Teammates' sandboxes never do.
/// Its linked session ended this long ago.
const FORGOTTEN_SESSION_ENDED_MS: i64 = 30 * 60_000;
/// It has no auto-stop and has run this long.
const FORGOTTEN_NO_AUTO_STOP_MS: i64 = 3 * 60 * 60_000;
/// It has run this many times its auto-stop: something keeps extending it.
const FORGOTTEN_KEPT_ALIVE_TIMES: i64 = 2;
/// An ended session doesn't make it forgotten when its auto-stop is due within this: it's about to stop by itself.
const FORGOTTEN_STOPS_SOON_MS: i64 = 30 * 60_000;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// What a link names for one of the user's own sandboxes, before it's checked against Arbor's machines and sessions.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Wanted {
    id: String,
    machine: Option<String>,
    session: Option<String>,
    by: ComputeLinkedBy,
}

/// A sandbox's machine and session as resolved.
#[derive(Clone, Debug, Default, PartialEq)]
struct Link {
    machine: Option<String>,
    session: Option<ComputeSession>,
    by: Option<ComputeLinkedBy>,
    problem: Option<ComputeLinkProblem>,
}

/// One connected provider: its key and what the rounds have read.
struct Live {
    key: ComputeKey,
    status: ComputeProviderStatus,
    key_access: ComputeKeyAccess,
    key_expires_at_ms: Option<i64>,
    checked_at_ms: Option<i64>,
    /// The last good list and limits; they stay while the provider can't be read.
    sandboxes: Vec<ListedSandbox>,
    list_partial: bool,
    limits: Option<ListedLimits>,
    loads: HashMap<String, ComputeLoad>,
    /// When each sandbox's load was last asked for, to read the longest-waiting first.
    load_read_at: HashMap<String, i64>,
    rings: HashMap<String, VecDeque<ComputePoint>>,
    issue_since: HashMap<String, (ComputeIssue, i64)>,
    links: HashMap<String, Link>,
    failures: u32,
    /// No automatic round before this, after failures.
    next_try_at_ms: i64,
    /// No round at all before this: the provider said so in a Retry-After.
    rate_limited_until_ms: i64,
}

impl Live {
    fn new(key: ComputeKey) -> Live {
        Live {
            key,
            status: ComputeProviderStatus::Ok,
            key_access: ComputeKeyAccess::Unknown,
            key_expires_at_ms: None,
            checked_at_ms: None,
            sandboxes: Vec::new(),
            list_partial: false,
            limits: None,
            loads: HashMap::new(),
            load_read_at: HashMap::new(),
            rings: HashMap::new(),
            issue_since: HashMap::new(),
            links: HashMap::new(),
            failures: 0,
            next_try_at_ms: 0,
            rate_limited_until_ms: 0,
        }
    }

    fn due(&self, now_ms: i64, manual: bool) -> bool {
        let after = if manual { self.rate_limited_until_ms } else { self.next_try_at_ms.max(self.rate_limited_until_ms) };
        now_ms + DUE_SLACK_MS >= after
    }
}

/// Everything one round read from a provider.
#[derive(Debug)]
struct ProviderRead {
    list: Result<ListedSandboxes, ComputeFailure>,
    limits: Option<Result<ListedLimits, ComputeFailure>>,
    key: Option<Result<KeyInfo, ComputeFailure>>,
    loads: Vec<(String, Result<LoadSample, ComputeFailure>)>,
}

/// The running sandboxes whose load this round reads: those read longest ago (or never) first, at most
/// [`LOADS_PER_ROUND`].
fn pick_for_load<'a>(sandboxes: &'a [ListedSandbox], read_at: &HashMap<String, i64>) -> Vec<&'a ListedSandbox> {
    let mut running: Vec<&ListedSandbox> =
        sandboxes.iter().filter(|sandbox| sandbox.state == ComputeSandboxState::Running && !sandbox.monitoring_off).collect();
    running.sort_by(|a, b| {
        let at = |sandbox: &ListedSandbox| read_at.get(&sandbox.id).copied().unwrap_or(i64::MIN);
        at(a).cmp(&at(b)).then_with(|| a.id.cmp(&b.id))
    });
    running.truncate(LOADS_PER_ROUND);
    running
}

/// Reads the list, then (when it worked) the limits, the key and the chosen sandboxes' load, at most
/// [`LOADS_AT_ONCE`] at a time. Once a load read is rate limited, the ones not yet sent aren't: they stay unread, so
/// they're first in line next round.
async fn read_provider(provider: &dyn ComputeProvider, api: &dyn ComputeGet, read_at: &HashMap<String, i64>) -> ProviderRead {
    let listed = match provider.list(api).await {
        Ok(listed) => listed,
        Err(failure) => return ProviderRead { list: Err(failure), limits: None, key: None, loads: Vec::new() },
    };
    let limits = Some(provider.limits(api).await);
    let key = Some(provider.key_check(api).await);
    let loads = if provider.capabilities().load {
        let slow_down = AtomicBool::new(false);
        let slow_down = &slow_down;
        // Boxed before they reach the stream: a closure there trips the compiler's proof that a round is Send.
        let reads: Vec<BoxFuture<'_, Option<(String, Result<LoadSample, ComputeFailure>)>>> = pick_for_load(&listed.sandboxes, read_at)
            .into_iter()
            .map(|sandbox| -> BoxFuture<'_, _> {
                Box::pin(async move {
                    if slow_down.load(Ordering::Relaxed) {
                        return None;
                    }
                    let result = provider.load(api, sandbox).await;
                    if matches!(result, Err(ComputeFailure::RateLimited { .. })) {
                        slow_down.store(true, Ordering::Relaxed);
                    }
                    Some((sandbox.id.clone(), result))
                })
            })
            .collect();
        futures_util::stream::iter(reads).buffer_unordered(LOADS_AT_ONCE).filter_map(std::future::ready).collect().await
    } else {
        Vec::new()
    };
    ProviderRead { list: Ok(listed), limits, key, loads }
}

/// How long to wait after the `failures`th failure in a row: a round's usual minute, doubling, up to ten minutes.
fn backoff_ms(failures: u32) -> i64 {
    let minute = ROUND_EVERY.as_millis() as i64;
    minute.saturating_mul(1_i64 << failures.saturating_sub(1).min(10)).min(MAX_BACKOFF_MS)
}

fn retry_after_ms(retry_after_secs: Option<u64>) -> i64 {
    retry_after_secs.map_or(ROUND_EVERY.as_millis() as i64, |secs| i64::try_from(secs).unwrap_or(i64::MAX).saturating_mul(1000)).min(MAX_RETRY_AFTER_MS)
}

fn push_point(ring: &mut VecDeque<ComputePoint>, point: ComputePoint) {
    ring.push_back(point);
    while ring.len() > RING_POINTS {
        ring.pop_front();
    }
}

/// Folds a round's read into what's kept. A failed list keeps the last good figures under the new status.
fn apply_read(live: &mut Live, read: ProviderRead, now_ms: i64) {
    let sandboxes = match read.list {
        Err(failure) => {
            live.failures = live.failures.saturating_add(1);
            live.next_try_at_ms = now_ms + backoff_ms(live.failures);
            live.status = match failure {
                ComputeFailure::Refused | ComputeFailure::Forbidden => ComputeProviderStatus::Refused,
                ComputeFailure::RateLimited { retry_after_secs } => {
                    live.rate_limited_until_ms = now_ms + retry_after_ms(retry_after_secs);
                    ComputeProviderStatus::RateLimited
                }
                _ => ComputeProviderStatus::Unreachable,
            };
            return;
        }
        Ok(listed) => listed,
    };
    let ListedSandboxes { sandboxes, partial } = sandboxes;
    live.failures = 0;
    live.next_try_at_ms = 0;
    live.checked_at_ms = Some(now_ms);
    let mut status = ComputeProviderStatus::Ok;
    match read.limits {
        Some(Ok(limits)) => live.limits = Some(limits),
        Some(Err(ComputeFailure::Refused | ComputeFailure::Forbidden)) => {
            live.limits = None;
            status = ComputeProviderStatus::LimitsNeedScope;
        }
        Some(Err(ComputeFailure::RateLimited { retry_after_secs })) => {
            live.rate_limited_until_ms = now_ms + retry_after_ms(retry_after_secs);
            status = ComputeProviderStatus::RateLimited;
        }
        Some(Err(ComputeFailure::Unsupported)) | None => live.limits = None,
        // A passing failure keeps the last limits.
        Some(Err(_)) => {}
    }
    match read.key {
        Some(Ok(info)) => {
            live.key_access = info.access;
            live.key_expires_at_ms = info.expires_at_ms;
        }
        Some(Err(ComputeFailure::Unsupported)) => {
            live.key_access = ComputeKeyAccess::Unknown;
            live.key_expires_at_ms = None;
        }
        _ => {}
    }
    for (id, result) in read.loads {
        live.load_read_at.insert(id.clone(), now_ms);
        match result {
            Err(ComputeFailure::RateLimited { retry_after_secs }) => {
                live.rate_limited_until_ms = live.rate_limited_until_ms.max(now_ms + retry_after_ms(retry_after_secs));
                if status == ComputeProviderStatus::Ok {
                    status = ComputeProviderStatus::RateLimited;
                }
            }
            // A running sandbox whose agent can't give a current sample: say there's none rather than "not read yet"
            // forever. The stale sample itself is never kept.
            Err(ComputeFailure::NotLive) => {
                if sandboxes.iter().any(|sandbox| sandbox.id == id && sandbox.state == ComputeSandboxState::Running) {
                    live.loads.insert(id, ComputeLoad::Unavailable);
                }
            }
            Ok(sample) => {
                let (cpu, memory) = (sample.cpu.clamp(0.0, 1.0), sample.memory.clamp(0.0, 1.0));
                live.loads.insert(id.clone(), ComputeLoad::Read { cpu, memory, at_ms: now_ms });
                push_point(live.rings.entry(id).or_default(), ComputePoint { at_ms: now_ms, cpu, memory });
            }
            Err(ComputeFailure::MonitoringOff) => {
                live.loads.insert(id, ComputeLoad::MonitoringOff);
            }
            // Told apart from a sandbox with no sample to give, so the window can say the key is what to change.
            Err(ComputeFailure::Forbidden) => {
                live.loads.insert(id, ComputeLoad::KeyCantRead);
            }
            Err(ComputeFailure::Refused | ComputeFailure::Unsupported) => {
                live.loads.insert(id, ComputeLoad::Unavailable);
            }
            // A passing failure keeps the last reading.
            Err(_) => {}
        }
    }
    for sandbox in &sandboxes {
        match sandbox.issue {
            Some(issue) => {
                let since = sandbox.issue_since_ms.unwrap_or_else(|| match live.issue_since.get(&sandbox.id) {
                    Some((seen, since)) if *seen == issue => *since,
                    _ => now_ms,
                });
                live.issue_since.insert(sandbox.id.clone(), (issue, since));
            }
            None => {
                live.issue_since.remove(&sandbox.id);
            }
        }
    }
    // A sandbox that left the list takes everything kept about it along.
    let ids: HashSet<&str> = sandboxes.iter().map(|sandbox| sandbox.id.as_str()).collect();
    live.loads.retain(|id, _| ids.contains(id.as_str()));
    live.load_read_at.retain(|id, _| ids.contains(id.as_str()));
    live.rings.retain(|id, _| ids.contains(id.as_str()));
    live.issue_since.retain(|id, _| ids.contains(id.as_str()));
    live.links.retain(|id, _| ids.contains(id.as_str()));
    live.sandboxes = sandboxes;
    live.list_partial = partial;
    live.status = status;
}

/// The ids a round's list can prune links against: only a whole list can say a sandbox is gone, so none from a failed
/// or partial one.
fn prunable_ids(read: &ProviderRead) -> Option<Vec<String>> {
    read.list
        .as_ref()
        .ok()
        .filter(|listed| !listed.partial)
        .map(|listed| listed.sandboxes.iter().map(|sandbox| sandbox.id.clone()).collect())
}

/// Drops links to sandboxes a full list no longer has, once they're old enough that the list isn't just lagging.
/// Says whether any went.
fn prune_claims(claims: &mut Vec<ComputeClaim>, provider: ComputeProviderId, listed: &HashSet<&str>, now_ms: i64) -> bool {
    let before = claims.len();
    claims.retain(|claim| claim.provider != provider || listed.contains(claim.sandbox_id.as_str()) || now_ms - claim.linked_at_ms < CLAIM_GRACE_MS);
    claims.len() != before
}

fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_SESSION_ID && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}

fn valid_machine_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= MAX_MACHINE_NAME && !name.chars().any(char::is_control)
}

/// What each of the user's own sandboxes is linked to: a link Arbor recorded wins over the provider's labels.
/// Teammates' sandboxes are never linked.
fn wanted_links(provider: ComputeProviderId, sandboxes: &[ListedSandbox], claims: &[ComputeClaim]) -> Vec<Wanted> {
    sandboxes
        .iter()
        .filter(|sandbox| sandbox.mine)
        .map(|sandbox| match claims.iter().find(|claim| claim.provider == provider && claim.sandbox_id == sandbox.id) {
            Some(claim) => Wanted {
                id: sandbox.id.clone(),
                machine: Some(claim.machine.clone()),
                session: claim.session.clone(),
                by: ComputeLinkedBy::Link,
            },
            None => Wanted {
                id: sandbox.id.clone(),
                machine: sandbox.label_machine.as_deref().map(str::trim).filter(|name| valid_machine_name(name)).map(String::from),
                session: sandbox.label_session.as_deref().map(str::trim).filter(|id| valid_session_id(id)).map(String::from),
                by: ComputeLinkedBy::Label,
            },
        })
        .collect()
}

fn session_of(id: &str, seen: Option<&SeenSession>, now_ms: i64) -> ComputeSession {
    match seen {
        Some(seen) => {
            let live = seen.live_at(now_ms);
            ComputeSession {
                id: id.to_string(),
                known: true,
                live,
                ended_at_ms: if live { None } else { seen.last_request_ms },
                harness: seen.harness,
            }
        }
        None => ComputeSession { id: id.to_string(), known: false, live: false, ended_at_ms: None, harness: None },
    }
}

/// Each wanted link checked: the machine only when it's exactly a name on the Machines list, the session by exact id.
fn resolve_links(wanted: &[Wanted], lookup: &ComputeLookup, now_ms: i64) -> HashMap<String, Link> {
    wanted
        .iter()
        .map(|wanted| {
            let (machine, problem) = match &wanted.machine {
                None => (None, Some(ComputeLinkProblem::NotLinked)),
                Some(machine) if lookup.machines.contains(machine) => (Some(machine.clone()), None),
                Some(_) => (None, Some(ComputeLinkProblem::UnknownMachine)),
            };
            let session = wanted.session.as_deref().map(|id| session_of(id, lookup.sessions.get(id), now_ms));
            let by = (wanted.machine.is_some() || wanted.session.is_some()).then_some(wanted.by);
            (wanted.id.clone(), Link { machine, session, by, problem })
        })
        .collect()
}

fn forgotten(sandbox: &ListedSandbox, session: Option<&ComputeSession>, now_ms: i64) -> Option<ComputeForgotten> {
    if !sandbox.mine || sandbox.state != ComputeSandboxState::Running {
        return None;
    }
    // A session Arbor hasn't seen has no end it could know, so it never counts here. One that's about to stop by
    // itself isn't forgotten for its session either.
    let stops_soon = sandbox.stops_at_ms.is_some_and(|at| at - now_ms <= FORGOTTEN_STOPS_SOON_MS);
    if !stops_soon
        && session.is_some_and(|session| {
            session.known && !session.live && session.ended_at_ms.is_some_and(|ended| now_ms - ended > FORGOTTEN_SESSION_ENDED_MS)
        })
    {
        return Some(ComputeForgotten::SessionEnded);
    }
    // The current run's age, not the sandbox's: a resume starts the clock again, and one still restoring has only
    // just started.
    let Some(started) = sandbox.run_started_at_ms.filter(|started| *started > 0) else {
        return None;
    };
    let age = now_ms - started;
    match sandbox.auto_stop_seconds {
        None if age > FORGOTTEN_NO_AUTO_STOP_MS => Some(ComputeForgotten::NoAutoStop),
        Some(seconds) if age > FORGOTTEN_KEPT_ALIVE_TIMES * i64::from(seconds) * 1000 => Some(ComputeForgotten::KeptAlive),
        _ => None,
    }
}

/// Plan hours used per hour now (the running sandboxes' multipliers added up) and when the plan's hours run out at
/// that rate.
fn burn(capabilities: ComputeCapabilities, sandboxes: &[ListedSandbox], limits: Option<&ListedLimits>, now_ms: i64) -> (Option<f64>, Option<i64>) {
    if !capabilities.cost {
        return (None, None);
    }
    let rate: f64 = sandboxes
        .iter()
        .filter(|sandbox| sandbox.state == ComputeSandboxState::Running)
        .filter_map(|sandbox| sandbox.multiplier)
        .sum();
    let left = limits
        .and_then(|limits| limits.limits.iter().find(|limit| limit.kind == ComputeLimitKind::PlanHours))
        .and_then(|limit| limit.max.map(|max| (max - limit.used).max(0.0)));
    let run_out = match left {
        Some(left) if rate > 0.0 => Some(now_ms + (left / rate * 3_600_000.0).round() as i64),
        _ => None,
    };
    (Some(rate), run_out)
}

fn load_shown(capabilities: ComputeCapabilities, live: &Live, sandbox: &ListedSandbox) -> ComputeLoad {
    if !capabilities.load {
        return ComputeLoad::Unavailable;
    }
    if sandbox.monitoring_off {
        return ComputeLoad::MonitoringOff;
    }
    let kept = live.loads.get(&sandbox.id).copied();
    match sandbox.state {
        ComputeSandboxState::Running => kept.unwrap_or(ComputeLoad::NotReadYet),
        ComputeSandboxState::Starting => ComputeLoad::NotReadYet,
        _ => match kept {
            Some(ComputeLoad::MonitoringOff) => ComputeLoad::MonitoringOff,
            _ => ComputeLoad::Unavailable,
        },
    }
}

fn provider_snapshot(provider: &dyn ComputeProvider, live: &Live, now_ms: i64) -> ComputeProviderSnapshot {
    let capabilities = provider.capabilities();
    let (plan_hours_per_hour, run_out_at_ms) = burn(capabilities, &live.sandboxes, live.limits.as_ref(), now_ms);
    let sandboxes = live
        .sandboxes
        .iter()
        .map(|sandbox| {
            let link = if sandbox.mine {
                live.links.get(&sandbox.id).cloned().unwrap_or(Link { problem: Some(ComputeLinkProblem::NotLinked), ..Link::default() })
            } else {
                Link::default()
            };
            let points = live
                .rings
                .get(&sandbox.id)
                .map(|ring| ring.iter().skip(ring.len().saturating_sub(SPARK_POINTS)).copied().collect())
                .unwrap_or_default();
            ComputeSandbox {
                id: sandbox.id.clone(),
                name: sandbox.name.clone(),
                size: sandbox.size.clone(),
                vcpus: sandbox.vcpus,
                memory_gb: sandbox.memory_gb,
                multiplier: sandbox.multiplier,
                state: sandbox.state,
                issue: sandbox.issue,
                issue_since_ms: sandbox.issue.and_then(|_| live.issue_since.get(&sandbox.id).map(|(_, since)| *since)),
                created_at_ms: sandbox.created_at_ms,
                started_at_ms: sandbox.run_started_at_ms.unwrap_or(now_ms),
                stops_at_ms: sandbox.stops_at_ms,
                auto_stop_seconds: sandbox.auto_stop_seconds,
                month_hours: sandbox.month_hours,
                month_dollars: sandbox.month_dollars,
                mine: sandbox.mine,
                load: load_shown(capabilities, live, sandbox),
                points,
                forgotten: forgotten(sandbox, link.session.as_ref(), now_ms),
                machine: link.machine,
                session: link.session,
                linked_by: link.by,
                link_problem: link.problem,
            }
        })
        .collect();
    ComputeProviderSnapshot {
        id: provider.id(),
        status: live.status,
        key_access: live.key_access,
        key_expires_at_ms: live.key_expires_at_ms,
        checked_at_ms: live.checked_at_ms,
        capabilities,
        limits: live.limits.as_ref().map(|limits| limits.limits.clone()).unwrap_or_default(),
        can_start: live.limits.as_ref().and_then(|limits| limits.can_start),
        start_block: live.limits.as_ref().and_then(|limits| limits.start_block),
        plan_hours_per_hour,
        run_out_at_ms,
        period_end_ms: live.limits.as_ref().and_then(|limits| limits.period_end_ms),
        list_partial: live.list_partial,
        sandboxes,
    }
}

// State, the loop and its rounds.

#[derive(Default)]
struct Inner {
    /// Connected providers only.
    providers: BTreeMap<ComputeProviderId, Live>,
    last_round: Option<Instant>,
    token: Option<CancellationToken>,
    /// Link refreshes run from rounds and from link and unlink at the same time. Each takes a ticket before it reads
    /// the links file, and only lands when no later ticket has, so links read from an older file never overwrite newer.
    links_ticket: u64,
    links_landed: u64,
}

impl Inner {
    fn take_links_ticket(&mut self) -> u64 {
        self.links_ticket += 1;
        self.links_ticket
    }

    /// Keeps links resolved under `ticket` unless a later ticket's already landed. Says whether they were kept.
    fn land_links(&mut self, ticket: u64, links: BTreeMap<ComputeProviderId, HashMap<String, Link>>) -> bool {
        if ticket <= self.links_landed {
            return false;
        }
        self.links_landed = ticket;
        for (id, links) in links {
            if let Some(live) = self.providers.get_mut(&id) {
                live.links = links;
            }
        }
        true
    }
}

/// Why a round was asked for. A round waits for the one before it, so whether it's still wanted is decided once it
/// has the lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RoundKind {
    /// The minute's timer.
    Timer,
    /// "Check now", from the window or `arbor`.
    Manual,
    /// A provider was just connected and has never been read.
    Connect,
}

impl RoundKind {
    /// Whether this round still runs, given how long ago the last one started.
    fn wanted(self, since_last: Option<Duration>) -> bool {
        let Some(since) = since_last else { return true };
        match self {
            RoundKind::Connect => true,
            RoundKind::Manual => since >= REFRESH_AT_MOST_EVERY,
            RoundKind::Timer => since.as_millis() as i64 + DUE_SLACK_MS >= ROUND_EVERY.as_millis() as i64,
        }
    }
}

/// Compute's live state: nothing about sandboxes is written anywhere but here.
#[derive(Default)]
pub(crate) struct ComputeState {
    inner: Mutex<Inner>,
    /// Wakes the loop after a connect or disconnect.
    wake: Notify,
    /// One round at a time, whoever starts it.
    rounds: tokio::sync::Mutex<()>,
}

impl ComputeState {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn snapshot(&self, now_ms: i64) -> ComputeSnapshot {
        let inner = self.lock();
        ComputeSnapshot {
            providers: PROVIDERS
                .iter()
                .filter_map(|provider| inner.providers.get(&provider.id()).map(|live| provider_snapshot(*provider, live, now_ms)))
                .collect(),
        }
    }

    fn connected(&self) -> bool {
        !self.lock().providers.is_empty()
    }

    /// Takes the keys saved at `path` as connected providers, not yet read. A missing file is no key and no work
    /// past one failed open.
    fn load_saved_keys(&self, path: &Path) -> Result<(), String> {
        let secrets = files::read_secrets(path)?;
        let mut inner = self.lock();
        for (id, key) in secrets.keys {
            if provider_by_id(id).is_some() {
                inner.providers.entry(id).or_insert_with(|| Live::new(key));
            }
        }
        Ok(())
    }
}

async fn blocking<T: Send + 'static>(task: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task).await.map_err(|error| error.to_string())?
}

fn emit_snapshot(app: &tauri::AppHandle) {
    let snapshot = app.state::<ComputeState>().snapshot(now_ms());
    let _ = app.emit(COMPUTE_UPDATED_EVENT, snapshot);
}

fn http_for(app: &tauri::AppHandle) -> Result<ReqwestHttp, String> {
    let proxy_url = app.state::<crate::GuiConfigState>().snapshot().map(|config| config.proxy_url).unwrap_or_default();
    ReqwestHttp::new(&proxy_url)
}

/// Links each of the user's own sandboxes to its machine and session again, from the links file, the labels and
/// usage.db. Keeps the old links when usage.db can't be read, rather than calling every machine unknown.
async fn refresh_links(app: &tauri::AppHandle) {
    let state = app.state::<ComputeState>();
    let ticket = state.lock().take_links_ticket();
    let claims = match blocking(|| files::read_claims(&files::claims_path()?)).await {
        Ok(claims) => claims,
        Err(error) => {
            eprintln!("{error}");
            Vec::new()
        }
    };
    let wanted: Vec<(ComputeProviderId, Vec<Wanted>)> = state
        .lock()
        .providers
        .iter()
        .map(|(id, live)| (*id, wanted_links(*id, &live.sandboxes, &claims)))
        .collect();
    let mut sessions: Vec<String> = wanted.iter().flat_map(|(_, wanted)| wanted.iter().filter_map(|wanted| wanted.session.clone())).collect();
    sessions.sort();
    sessions.dedup();
    let needs_lookup = wanted.iter().any(|(_, wanted)| wanted.iter().any(|wanted| wanted.machine.is_some() || wanted.session.is_some()));
    let lookup = if needs_lookup {
        match compute_lookup::lookup(sessions).await {
            Ok(lookup) => lookup,
            Err(error) => {
                eprintln!("Couldn't read the machines and sessions Compute links to: {error}");
                return;
            }
        }
    } else {
        ComputeLookup::default()
    };
    let now = now_ms();
    let links = wanted.into_iter().map(|(id, wanted)| (id, resolve_links(&wanted, &lookup, now))).collect();
    state.lock().land_links(ticket, links);
}

/// Reads every connected provider that's due (all of them on "Check now", apart from one that asked Arbor to wait),
/// then sends the snapshot. Does nothing when another round finished while this one waited for it.
async fn run_round(app: &tauri::AppHandle, kind: RoundKind) {
    let state = app.state::<ComputeState>();
    let _round = state.rounds.lock().await;
    let manual = kind != RoundKind::Timer;
    let now = now_ms();
    let due: Vec<(ComputeProviderId, ComputeKey, HashMap<String, i64>)> = {
        let mut inner = state.lock();
        if !kind.wanted(inner.last_round.map(|at| at.elapsed())) {
            return;
        }
        inner.last_round = Some(Instant::now());
        inner
            .providers
            .iter()
            .filter(|(_, live)| live.due(now, manual))
            .map(|(id, live)| (*id, live.key.clone(), live.load_read_at.clone()))
            .collect()
    };
    if !due.is_empty() {
        match http_for(app) {
            Ok(http) => {
                for (id, key, read_at) in due {
                    let Some(provider) = provider_by_id(id) else { continue };
                    let api = ProviderApi { provider, key: &key, http: &http };
                    let read = read_provider(provider, &api, &read_at).await;
                    let listed = prunable_ids(&read);
                    {
                        let mut inner = state.lock();
                        // Disconnected, or connected again with another key, while this round read.
                        match inner.providers.get_mut(&id) {
                            Some(live) if live.key == key => apply_read(live, read, now),
                            _ => continue,
                        }
                    }
                    if let Some(listed) = listed {
                        let pruned = blocking(move || {
                            let listed: HashSet<&str> = listed.iter().map(String::as_str).collect();
                            files::update_claims(&files::claims_path()?, |claims| prune_claims(claims, id, &listed, now))
                        })
                        .await;
                        if let Err(error) = pruned {
                            eprintln!("{error}");
                        }
                    }
                }
            }
            Err(error) => eprintln!("{error}"),
        }
    }
    refresh_links(app).await;
    if state.connected() {
        emit_snapshot(app);
    }
}

/// Reads the saved keys, before any command can ask what's connected, and starts the loop. With no key saved it waits
/// without timers, requests or events until a provider is connected.
pub(crate) fn start(app: tauri::AppHandle) {
    let token = {
        let state = app.state::<ComputeState>();
        let mut inner = state.lock();
        if inner.token.is_some() {
            return;
        }
        let token = CancellationToken::new();
        inner.token = Some(token.clone());
        token
    };
    // Here, not in the loop's task: the window's first `get_compute` can arrive before a spawned task runs, and a
    // snapshot without the saved providers then hides Compute for the whole session.
    if let Err(error) = files::secrets_path().and_then(|path| app.state::<ComputeState>().load_saved_keys(&path)) {
        eprintln!("{error}");
    }
    tauri::async_runtime::spawn(run_loop(app, token));
}

pub(crate) fn stop(app: &tauri::AppHandle) {
    let state = app.state::<ComputeState>();
    let token = state.lock().token.take();
    if let Some(token) = token {
        token.cancel();
    }
    state.wake.notify_one();
}

async fn run_loop(app: tauri::AppHandle, token: CancellationToken) {
    let state = app.state::<ComputeState>();
    loop {
        if token.is_cancelled() {
            return;
        }
        let (connected, since) = {
            let inner = state.lock();
            (!inner.providers.is_empty(), inner.last_round.map(|at| at.elapsed()))
        };
        if !connected {
            tokio::select! {
                _ = state.wake.notified() => {}
                _ = token.cancelled() => return,
            }
            continue;
        }
        if let Some(since) = since.filter(|since| *since < ROUND_EVERY) {
            tokio::select! {
                _ = tokio::time::sleep(ROUND_EVERY - since) => {}
                _ = state.wake.notified() => {}
                _ = token.cancelled() => return,
            }
            continue;
        }
        run_round(&app, RoundKind::Timer).await;
    }
}

// Commands.

fn unknown_provider() -> String {
    "Arbor doesn't know that provider.".into()
}

/// What connect says when the key didn't work, as a kind the window can act on. Nothing of the key or of the
/// provider's answer is in it.
fn connect_error(name: &str, failure: ComputeFailure) -> CommandError {
    match failure {
        ComputeFailure::Refused => {
            CommandError::refused(format!("{name} refused this key. Check you copied all of it, and that it hasn't expired or been revoked."))
        }
        ComputeFailure::Forbidden => {
            CommandError::refused(format!("This key can't list sandboxes at {name}. Make one that can read them, such as a read-only key."))
        }
        ComputeFailure::RateLimited { .. } => CommandError::unreachable(format!("{name} asked Arbor to slow down. Try again in a minute.")),
        ComputeFailure::Unreachable => CommandError::unreachable(format!("Couldn't reach {name}. Check your connection and try again.")),
        ComputeFailure::MonitoringOff | ComputeFailure::NotLive | ComputeFailure::Unexpected | ComputeFailure::Unsupported => {
            CommandError::failed(format!("{name} answered in a way Arbor can't read. Try again later."))
        }
    }
}

fn check_key_shape(key: &ComputeKey) -> Result<(), CommandError> {
    let key = key.expose();
    if key.is_empty() {
        return Err(CommandError::failed("Paste a key first."));
    }
    if key.len() > MAX_KEY_LEN || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(CommandError::refused("That doesn't look like an API key. Paste the key alone, with no spaces in it."));
    }
    Ok(())
}

/// Every connected provider's sandboxes, from memory; never reaches the network.
#[tauri::command]
pub(crate) fn get_compute(app: tauri::AppHandle) -> Result<ComputeSnapshot, String> {
    Ok(app.state::<ComputeState>().snapshot(now_ms()))
}

/// Reads every connected provider now (unless a round ran in the last 10 seconds) and returns the result.
#[tauri::command]
pub(crate) async fn refresh_compute(app: tauri::AppHandle) -> Result<ComputeSnapshot, String> {
    let state = app.state::<ComputeState>();
    let recent = {
        let inner = state.lock();
        inner.providers.is_empty() || inner.last_round.is_some_and(|at| at.elapsed() < REFRESH_AT_MOST_EVERY)
    };
    if !recent {
        run_round(&app, RoundKind::Manual).await;
    }
    Ok(state.snapshot(now_ms()))
}

/// Every CPU and memory reading Arbor holds for a sandbox, about two hours, oldest first.
#[tauri::command]
pub(crate) fn get_compute_sandbox_history(
    app: tauri::AppHandle,
    provider: ComputeProviderId,
    sandbox_id: String,
) -> Result<Vec<ComputePoint>, String> {
    let state = app.state::<ComputeState>();
    let inner = state.lock();
    Ok(inner
        .providers
        .get(&provider)
        .and_then(|live| live.rings.get(&sandbox_id))
        .map(|ring| ring.iter().copied().collect())
        .unwrap_or_default())
}

/// Checks a key by reading the provider's list, and saves it only when that works.
#[tauri::command]
pub(crate) async fn connect_compute_provider(
    app: tauri::AppHandle,
    provider: ComputeProviderId,
    key: String,
) -> Result<ComputeSnapshot, CommandError> {
    let source = provider_by_id(provider).ok_or_else(|| CommandError::failed(unknown_provider()))?;
    let key = ComputeKey::new(&key);
    check_key_shape(&key)?;
    let http = http_for(&app).map_err(CommandError::failed)?;
    source
        .list(&ProviderApi { provider: source, key: &key, http: &http })
        .await
        .map_err(|failure| connect_error(source.name(), failure))?;
    let saved = key.clone();
    blocking(move || files::save_key(&files::secrets_path()?, provider, Some(&saved))).await.map_err(CommandError::failed)?;
    let state = app.state::<ComputeState>();
    state.lock().providers.insert(provider, Live::new(key));
    run_round(&app, RoundKind::Connect).await;
    state.wake.notify_one();
    Ok(state.snapshot(now_ms()))
}

/// Forgets a provider's key and everything read from it. Links are kept.
#[tauri::command]
pub(crate) async fn disconnect_compute_provider(
    app: tauri::AppHandle,
    provider: ComputeProviderId,
) -> Result<ComputeSnapshot, String> {
    provider_by_id(provider).ok_or_else(unknown_provider)?;
    blocking(move || files::save_key(&files::secrets_path()?, provider, None)).await?;
    let state = app.state::<ComputeState>();
    let removed = state.lock().providers.remove(&provider).is_some();
    state.wake.notify_one();
    if removed {
        emit_snapshot(&app);
    }
    Ok(state.snapshot(now_ms()))
}

/// Opens a sandbox's page at its provider.
#[tauri::command]
pub(crate) fn open_compute_sandbox(app: tauri::AppHandle, provider: ComputeProviderId, sandbox_id: String) -> Result<(), String> {
    let source = provider_by_id(provider).ok_or_else(unknown_provider)?;
    let sandbox_id = sandbox_id.trim();
    if !source.sandbox_id_ok(sandbox_id) {
        return Err(format!("That isn't a {} sandbox id.", source.name()));
    }
    crate::system_open::open_with_system(&app, &source.dashboard_url(sandbox_id), None)
}

/// The link a command is asked to record, checked for shape: the id, the machine's name and the session id.
fn checked_link(
    source: &dyn ComputeProvider,
    sandbox_id: &str,
    machine: &str,
    session: Option<&str>,
) -> Result<(String, String, Option<String>), String> {
    let name = source.name();
    let sandbox_id = sandbox_id.trim();
    if !source.sandbox_id_ok(sandbox_id) {
        return Err(format!("“{sandbox_id}” isn't a {name} sandbox id. Use the id {name} gave when it made the sandbox."));
    }
    let machine = machine.trim();
    if machine.is_empty() {
        return Err("Name the machine that made it with machine=<name>, as Arbor's Machines list shows it.".into());
    }
    if !valid_machine_name(machine) {
        return Err("That machine name is too long. Use the name Arbor's Machines list shows.".into());
    }
    let session = session.map(str::trim).filter(|session| !session.is_empty());
    if session.is_some_and(|session| !valid_session_id(session)) {
        return Err(format!(
            "That session id isn't one Arbor can use. Pass the agent's own session id: up to {MAX_SESSION_ID} letters, digits, dashes, dots, colons or underscores."
        ));
    }
    Ok((sandbox_id.to_string(), machine.to_string(), session.map(String::from)))
}

fn unknown_machine(machine: &str) -> String {
    format!("Arbor has no machine called “{machine}”. Use its name or its SSH host from Arbor's Machines list (`arbor machines` lists them).")
}

fn several_machines(machine: &str, fits: &[String]) -> String {
    format!("“{machine}” fits more than one machine ({}). Use the name exactly as Arbor's Machines list shows it.", fits.join(", "))
}

/// Records that a machine (and an agent session there) started a sandbox, so Compute shows it; an agent runs it
/// right after making one. It wins over a provider's label. The machine must be on the Machines list, by its name or
/// its SSH host however typed; the sandbox needn't be listed yet. Not called a claim: `arbor` never offers a command by that name, which means spending a
/// quota reset there.
#[tauri::command]
pub(crate) async fn link_compute_sandbox(
    app: tauri::AppHandle,
    provider: ComputeProviderId,
    sandbox_id: String,
    machine: String,
    session: Option<String>,
) -> Result<(), String> {
    let source = provider_by_id(provider).ok_or_else(unknown_provider)?;
    let (sandbox_id, machine, session) = checked_link(source, &sandbox_id, &machine, session.as_deref())?;
    let machine = match compute_lookup::listed_machine(machine.clone()).await? {
        ListedMachine::Found(listed) => listed,
        ListedMachine::Several(fits) => return Err(several_machines(&machine, &fits)),
        ListedMachine::Unknown => return Err(unknown_machine(&machine)),
    };
    let claim = ComputeClaim { provider, sandbox_id, machine, session, linked_at_ms: now_ms() };
    blocking(move || {
        files::update_claims(&files::claims_path()?, |claims| {
            claims.retain(|kept| kept.provider != claim.provider || kept.sandbox_id != claim.sandbox_id);
            claims.push(claim);
            true
        })
    })
    .await?;
    refresh_links(&app).await;
    if app.state::<ComputeState>().connected() {
        emit_snapshot(&app);
    }
    Ok(())
}

/// Drops the link Arbor recorded for a sandbox. A provider's label, if any, still counts.
#[tauri::command]
pub(crate) async fn unlink_compute_sandbox(
    app: tauri::AppHandle,
    provider: ComputeProviderId,
    sandbox_id: String,
) -> Result<(), String> {
    provider_by_id(provider).ok_or_else(unknown_provider)?;
    let sandbox_id = sandbox_id.trim().to_string();
    let wanted = sandbox_id.clone();
    let removed = blocking(move || {
        let mut removed = false;
        files::update_claims(&files::claims_path()?, |claims| {
            let before = claims.len();
            claims.retain(|kept| kept.provider != provider || kept.sandbox_id != wanted);
            removed = claims.len() != before;
            removed
        })?;
        Ok(removed)
    })
    .await?;
    if !removed {
        return Err(format!("Arbor has no link for {sandbox_id}."));
    }
    refresh_links(&app).await;
    if app.state::<ComputeState>().connected() {
        emit_snapshot(&app);
    }
    Ok(())
}

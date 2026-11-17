//! Boat (boat.dev): its sandboxes, limits and each running sandbox's processes, read with the user's API key.
//!
//! The structs below bind only what Compute shows. Boat's sandbox also carries addresses, a desktop URL with a token
//! in it, who created it, its environment and free-text reasons, and its process list carries every command line
//! with whatever secrets were typed into it; serde skips every field not named here, so none of that is ever held.
//! Free-text reasons are reduced to a kind as they're read, and `access` to whether the sandbox is the key's own.

use super::{
    reply_body, ComputeCapabilities, ComputeFailure, ComputeGet, ComputeIssue, ComputeLimit, ComputeLimitKind,
    ComputeProvider, ComputeProviderId, ComputeSandboxState, ComputeStartBlock, ListedLimits, ListedSandbox,
    ListedSandboxes, LoadSample, ComputeReply,
};
use futures_util::future::BoxFuture;
use serde::de::IgnoredAny;
use serde::{Deserialize, Deserializer};

const API_BASE: &str = "https://boat.dev/api/v1";
/// Boat's dashboard has no documented page per sandbox; its Sandboxes tab with the id is the nearest fixed address.
const DASHBOARD_SANDBOX: &str = "https://boat.dev/dashboard?tab=sandboxes&sandbox=";
/// Boat's maximum page.
const PAGE_SIZE: u32 = 200;
/// 10,000 sandboxes. Boat keeps stopped sandboxes listed until they're deleted, so a busy account can pass it; the
/// list then stops here and says it's partial. Boat lists newest first, so what's running is on the pages read.
const MAX_PAGES: usize = 50;
/// The longest cursor Arbor sends back; Boat's are short opaque strings.
const MAX_CURSOR_LEN: usize = 512;

pub(crate) struct Boat;

/// Boat's sandbox ids: `bx_` and eight of its 31 characters.
pub(crate) fn is_sandbox_id(id: &str) -> bool {
    id.strip_prefix("bx_")
        .is_some_and(|rest| rest.len() == 8 && rest.bytes().all(|b| b"23456789abcdefghjkmnpqrstuvwxyz".contains(&b)))
}

fn cursor_ok(cursor: &str) -> bool {
    !cursor.is_empty()
        && cursor.len() <= MAX_CURSOR_LEN * 3
        && cursor.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'%'))
}

/// The cursor as a query value: everything but the unreserved characters percent-encoded.
fn encode_cursor(cursor: &str) -> String {
    cursor
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The paths Arbor may ask Boat for, with their queries. Everything else (conversations, events, history, AI usage,
/// files, commands, anything that changes something) is refused before a request is made.
pub(crate) fn allows(path: &str) -> bool {
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    match path {
        "/limits" => query.is_empty(),
        "/sandboxes" => query.split('&').all(|pair| match pair.split_once('=') {
            Some(("include", value)) => value == "cost",
            Some(("limit", value)) => !value.is_empty() && value.len() <= 3 && value.bytes().all(|b| b.is_ascii_digit()),
            Some(("cursor", value)) => cursor_ok(value),
            _ => false,
        }),
        _ => {
            query.is_empty()
                && path
                    .strip_prefix("/sandboxes/")
                    .and_then(|rest| rest.strip_suffix("/processes"))
                    .is_some_and(is_sandbox_id)
        }
    }
}

fn parse_time(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text.trim()).ok().map(|time| time.timestamp_millis())
}

fn time<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.as_deref().and_then(parse_time))
}

/// A health reason or error, as a kind; the words themselves are dropped here.
fn issue_kind(text: &str) -> ComputeIssue {
    let text = text.to_ascii_lowercase();
    if text.contains("disk") || text.contains("filesystem") || text.contains("no space") {
        ComputeIssue::DiskPressure
    } else if text.contains("memory") || text.contains("oom") {
        ComputeIssue::MemoryPressure
    } else if text.contains("setup") {
        ComputeIssue::SetupFailed
    } else if text.contains("crash") || text.contains("panic") {
        ComputeIssue::Crashed
    } else {
        ComputeIssue::Other
    }
}

fn issue_text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<ComputeIssue>, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.filter(|text| !text.trim().is_empty()).map(|text| issue_kind(&text)))
}

/// Why starts are blocked, as a kind; the words themselves are dropped here.
fn start_block_kind(text: &str) -> ComputeStartBlock {
    let text = text.to_ascii_lowercase();
    if ["wallet", "balance", "payment", "top-up", "funds"].iter().any(|word| text.contains(word)) {
        ComputeStartBlock::WalletEmpty
    } else if text.contains("credit") || (text.contains("hour") && ["plan", "vm", "included"].iter().any(|word| text.contains(word))) {
        ComputeStartBlock::PlanHoursGone
    } else if text.contains("active") || text.contains("concurrent") {
        ComputeStartBlock::ActiveMax
    } else if text.contains("start") || text.contains("rate") {
        ComputeStartBlock::StartRate
    } else {
        ComputeStartBlock::Other
    }
}

fn start_block_text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<ComputeStartBlock>, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.filter(|text| !text.trim().is_empty()).map(|text| start_block_kind(&text)))
}

/// Boat's state names, as the API gives them and as its CLI prints them; None for `cancelled`, which is dropped,
/// and for a state Arbor doesn't know.
fn state_of(state: &str) -> Option<ComputeSandboxState> {
    Some(match state {
        "init" | "provisioning" | "provisioned" | "cloning" => ComputeSandboxState::Starting,
        "ready" | "idle" | "running" => ComputeSandboxState::Running,
        "archiving" | "stopping" => ComputeSandboxState::Stopping,
        "archived" | "stopped" => ComputeSandboxState::Stopped,
        "error" => ComputeSandboxState::Error,
        _ => return None,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListPage {
    #[serde(default)]
    sandboxes: Vec<WireSandbox>,
    #[serde(default)]
    page_info: Option<PageInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    #[serde(default)]
    next_cursor: Option<String>,
    #[serde(default)]
    has_more: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireSandbox {
    id: String,
    #[serde(default)]
    name: Option<String>,
    state: String,
    #[serde(default, rename = "type")]
    size: Option<String>,
    #[serde(default)]
    vcpu: Option<f64>,
    #[serde(default, rename = "memoryGB")]
    memory_gb: Option<f64>,
    #[serde(default)]
    billing_multiplier: Option<f64>,
    #[serde(default)]
    health: Option<String>,
    #[serde(default, deserialize_with = "issue_text")]
    health_reason: Option<ComputeIssue>,
    #[serde(default, deserialize_with = "time")]
    degraded_since: Option<i64>,
    #[serde(default, deserialize_with = "issue_text")]
    error: Option<ComputeIssue>,
    #[serde(default)]
    setup_status: Option<String>,
    #[serde(default, deserialize_with = "time")]
    created_at: Option<i64>,
    /// False while a resume or fork is still copying files in; `hydrated_at` is then the last restore's.
    #[serde(default)]
    hydrated: Option<bool>,
    /// When the last resume or fork finished copying files in: where the current run began.
    #[serde(default, deserialize_with = "time")]
    hydrated_at: Option<i64>,
    /// False when it was made with monitoring off, so its processes can't be read.
    #[serde(default)]
    monitoring: Option<bool>,
    #[serde(default, deserialize_with = "time")]
    archive_after: Option<i64>,
    #[serde(default)]
    ttl_seconds: Option<f64>,
    #[serde(default)]
    access: Option<String>,
    #[serde(default)]
    labels: Option<WireLabels>,
    #[serde(default)]
    cost: Option<WireCost>,
}

/// Only Arbor's own two labels; any other label's value is skipped.
#[derive(Default, Deserialize)]
struct WireLabels {
    #[serde(default, rename = "arbor.machine")]
    machine: Option<String>,
    #[serde(default, rename = "arbor.session")]
    session: Option<String>,
}

#[derive(Deserialize)]
struct WireCost {
    #[serde(default)]
    seconds: Option<f64>,
    #[serde(default)]
    dollars: Option<f64>,
}

impl WireSandbox {
    fn listed(self) -> Option<ListedSandbox> {
        let state = state_of(&self.state)?;
        let degraded = self.health.as_deref() == Some("degraded");
        let issue = match state {
            // A stopped sandbox is never a problem.
            ComputeSandboxState::Stopped | ComputeSandboxState::Stopping => None,
            ComputeSandboxState::Error => Some(self.error.unwrap_or(ComputeIssue::Other)),
            _ if degraded => Some(self.health_reason.unwrap_or(ComputeIssue::Other)),
            _ if self.setup_status.as_deref() == Some("failed") => Some(ComputeIssue::SetupFailed),
            _ => None,
        };
        let issue_since_ms = if degraded && issue.is_some() { self.degraded_since } else { None };
        let running = state == ComputeSandboxState::Running;
        let labels = self.labels.unwrap_or_default();
        let created_at_ms = self.created_at.unwrap_or(0);
        // A resume keeps the id and `createdAt`; the run began when its files were back. While they're still coming,
        // the old `hydratedAt` is stale and it has only just started.
        let restoring = self.hydrated == Some(false) && matches!(state, ComputeSandboxState::Starting | ComputeSandboxState::Running);
        let run_started_at_ms = (!restoring).then(|| created_at_ms.max(self.hydrated_at.unwrap_or(0)));
        Some(ListedSandbox {
            name: self.name.unwrap_or_else(|| self.id.clone()),
            id: self.id,
            size: self.size.unwrap_or_default(),
            vcpus: self.vcpu.filter(|v| v.is_finite() && *v >= 0.0).map_or(0, |v| v.round().min(f64::from(u32::MAX)) as u32),
            memory_gb: self.memory_gb.filter(|m| m.is_finite() && *m >= 0.0).unwrap_or(0.0),
            multiplier: self.billing_multiplier.filter(|m| m.is_finite() && *m >= 0.0),
            state,
            issue,
            issue_since_ms,
            created_at_ms,
            run_started_at_ms,
            // Boat keeps the last auto-stop time on a stopped sandbox; it only means something while it runs.
            stops_at_ms: if running { self.archive_after } else { None },
            auto_stop_seconds: self.ttl_seconds.filter(|t| t.is_finite() && *t > 0.0).map(|t| t.round().min(f64::from(u32::MAX)) as u32),
            month_hours: self.cost.as_ref().and_then(|cost| cost.seconds).map(|seconds| seconds / 3600.0),
            month_dollars: self.cost.as_ref().and_then(|cost| cost.dollars),
            // A personal sandbox has no `access`; a teammate's says `use` or `view`.
            mine: self.access.as_deref().is_none_or(|access| access == "owner"),
            monitoring_off: self.monitoring == Some(false),
            label_machine: labels.machine,
            label_session: labels.session,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireLimits {
    #[serde(default)]
    can_start: Option<bool>,
    #[serde(default, deserialize_with = "start_block_text")]
    start_blocked_reason: Option<ComputeStartBlock>,
    #[serde(default, deserialize_with = "start_block_text")]
    blocked_reason: Option<ComputeStartBlock>,
    #[serde(default)]
    active_sandboxes: Option<f64>,
    #[serde(default)]
    max_active_sandboxes: Option<f64>,
    #[serde(default)]
    starts: Option<WireStarts>,
    #[serde(default)]
    plan_included: Option<WirePlan>,
    #[serde(default, deserialize_with = "time")]
    subscription_current_period_end: Option<i64>,
    #[serde(default)]
    wallet: Option<WireWallet>,
    #[serde(default)]
    keep_going: Option<WireKeepGoing>,
    /// A trial's lifetime allowance of VM time, and what's used of it; null once the account has paid.
    #[serde(default)]
    trial_compute_cap_seconds: Option<f64>,
    #[serde(default)]
    trial_compute_used_seconds: Option<f64>,
}

#[derive(Deserialize)]
struct WireStarts {
    #[serde(default)]
    minute: Option<WireWindow>,
    #[serde(default)]
    hour: Option<WireWindow>,
    #[serde(default)]
    day: Option<WireWindow>,
}

#[derive(Deserialize)]
struct WireWindow {
    #[serde(default)]
    limit: Option<f64>,
    #[serde(default)]
    used: Option<f64>,
    #[serde(default)]
    remaining: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirePlan {
    #[serde(default)]
    vm_hours: Option<f64>,
    #[serde(default)]
    vm_hours_remaining: Option<f64>,
    #[serde(default, deserialize_with = "time")]
    period_end: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireWallet {
    #[serde(default)]
    balance_dollars: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireKeepGoing {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    cap_dollars: Option<f64>,
    #[serde(default)]
    used_dollars: Option<f64>,
}

impl WireLimits {
    fn listed(self) -> ListedLimits {
        let mut limits = Vec::new();
        if let Some(used) = self.active_sandboxes {
            limits.push(ComputeLimit { kind: ComputeLimitKind::ActiveSandboxes, used, max: self.max_active_sandboxes, resets_at_ms: None });
        }
        let windows = self.starts.as_ref().map(|starts| {
            [
                (ComputeLimitKind::StartsPerMinute, &starts.minute),
                (ComputeLimitKind::StartsPerHour, &starts.hour),
                (ComputeLimitKind::StartsPerDay, &starts.day),
            ]
        });
        for (kind, window) in windows.into_iter().flatten() {
            if let Some(window) = window {
                if let Some(used) = window.used {
                    // Rolling windows: there's no one time they reset.
                    limits.push(ComputeLimit { kind, used, max: window.limit, resets_at_ms: None });
                }
            }
        }
        let period_end_ms = self.plan_included.as_ref().and_then(|plan| plan.period_end).or(self.subscription_current_period_end);
        let plan_left = self.plan_included.as_ref().and_then(|plan| plan.vm_hours_remaining);
        if let Some(plan) = &self.plan_included {
            if let (Some(hours), Some(left)) = (plan.vm_hours, plan.vm_hours_remaining) {
                limits.push(ComputeLimit {
                    kind: ComputeLimitKind::PlanHours,
                    used: (hours - left).max(0.0),
                    max: Some(hours),
                    resets_at_ms: period_end_ms,
                });
            }
        }
        // A trial has no plan hours but a lifetime allowance, which never resets.
        if !limits.iter().any(|limit| limit.kind == ComputeLimitKind::PlanHours) {
            if let Some(cap) = self.trial_compute_cap_seconds.filter(|cap| cap.is_finite() && *cap > 0.0) {
                let used = self.trial_compute_used_seconds.filter(|used| used.is_finite()).unwrap_or(0.0).max(0.0);
                limits.push(ComputeLimit { kind: ComputeLimitKind::PlanHours, used: used / 3600.0, max: Some(cap / 3600.0), resets_at_ms: None });
            }
        }
        if let Some(keep_going) = self.keep_going.as_ref().filter(|keep_going| keep_going.enabled == Some(true)) {
            limits.push(ComputeLimit {
                kind: ComputeLimitKind::ExtraSpend,
                used: keep_going.used_dollars.unwrap_or(0.0),
                max: keep_going.cap_dollars,
                resets_at_ms: period_end_ms,
            });
        }
        let start_block = match self.can_start {
            Some(false) => Some(
                self.start_blocked_reason
                    .or(self.blocked_reason)
                    .filter(|block| *block != ComputeStartBlock::Other)
                    .unwrap_or_else(|| {
                        let full = |used: Option<f64>, max: Option<f64>| matches!((used, max), (Some(used), Some(max)) if used >= max);
                        let starts_out = self.starts.as_ref().is_some_and(|starts| {
                            [&starts.minute, &starts.hour, &starts.day]
                                .into_iter()
                                .flatten()
                                .any(|window| window.remaining.is_some_and(|left| left <= 0.0))
                        });
                        let wallet_empty = self.wallet.as_ref().and_then(|wallet| wallet.balance_dollars).is_some_and(|balance| balance <= 0.0);
                        if full(self.active_sandboxes, self.max_active_sandboxes) {
                            ComputeStartBlock::ActiveMax
                        } else if starts_out {
                            ComputeStartBlock::StartRate
                        } else if plan_left.is_some_and(|left| left <= 0.0) {
                            if wallet_empty { ComputeStartBlock::WalletEmpty } else { ComputeStartBlock::PlanHoursGone }
                        } else {
                            ComputeStartBlock::Other
                        }
                    }),
            ),
            _ => None,
        };
        ListedLimits { limits, can_start: self.can_start, start_block, period_end_ms }
    }
}

#[derive(Deserialize)]
struct WireProcesses {
    #[serde(default)]
    live: bool,
    #[serde(default)]
    processes: Vec<WireProcess>,
}

/// Counts and times only: its CPU and memory numbers, when it started, and whether Boat's exec started it. A process's
/// `command` holds its whole command line, secrets and all, and is never read; `user`, `pid` and `parentPid` say
/// nothing Compute shows. None of them is bound.
#[derive(Deserialize)]
struct WireProcess {
    #[serde(default, rename = "cpuPercent")]
    cpu_percent: Option<f64>,
    #[serde(default, rename = "memoryMB")]
    memory_mb: Option<f64>,
    #[serde(default, rename = "startedAt", deserialize_with = "time")]
    started_at: Option<i64>,
    /// Present on a process Boat's exec started, null on its children and on the system's. Skipped as it's read, so
    /// the id's text is never held.
    #[serde(default, rename = "commandId")]
    command_id: Option<IgnoredAny>,
}

/// Only the error's code, to tell monitoring being off from other refusals; its message is never read.
#[derive(Deserialize)]
struct WireError {
    #[serde(default)]
    code: Option<String>,
}

fn fraction(value: f64) -> f64 {
    if value.is_finite() { value.clamp(0.0, 1.0) } else { 0.0 }
}

/// CPU as the processes' percentages over every vCPU's 100, memory as their resident MB over the sandbox's GB.
pub(crate) fn load_of(processes: &[(f64, f64)], vcpus: u32, memory_gb: f64) -> Option<LoadSample> {
    if vcpus == 0 || !(memory_gb > 0.0) {
        return None;
    }
    let (cpu, memory) = processes.iter().fold((0.0, 0.0), |(cpu, memory), (c, m)| {
        (cpu + if c.is_finite() { c.max(0.0) } else { 0.0 }, memory + if m.is_finite() { m.max(0.0) } else { 0.0 })
    });
    Some(LoadSample {
        cpu: fraction(cpu / (f64::from(vcpus) * 100.0)),
        memory: fraction(memory / (memory_gb * 1024.0)),
        commands: None,
        command_started_ms: None,
    })
}

/// How many processes Boat's exec started, and when the newest of them began.
fn commands_of(processes: &[WireProcess]) -> (u32, Option<i64>) {
    let started = processes.iter().filter(|process| process.command_id.is_some());
    let count = started.clone().count();
    (u32::try_from(count).unwrap_or(u32::MAX), started.filter_map(|process| process.started_at).max())
}

/// A live process list as a reading of the sandbox.
fn sample_of(processes: &[WireProcess], vcpus: u32, memory_gb: f64) -> Option<LoadSample> {
    let numbers: Vec<(f64, f64)> =
        processes.iter().map(|process| (process.cpu_percent.unwrap_or(0.0), process.memory_mb.unwrap_or(0.0))).collect();
    let (commands, command_started_ms) = commands_of(processes);
    load_of(&numbers, vcpus, memory_gb).map(|sample| LoadSample { commands: Some(commands), command_started_ms, ..sample })
}

fn error_code(reply: &ComputeReply) -> Option<String> {
    serde_json::from_str::<WireError>(&reply.body).ok().and_then(|error| error.code)
}

/// A reply's body, or its failure, with the error codes Boat types read: a 403 `api_key_expired` is the key refused,
/// not a key without the right scope.
fn boat_reply(reply: ComputeReply) -> Result<String, ComputeFailure> {
    if reply.status == 403 && error_code(&reply).as_deref() == Some("api_key_expired") {
        return Err(ComputeFailure::Refused);
    }
    reply_body(reply)
}

fn processes_reply(reply: ComputeReply) -> Result<String, ComputeFailure> {
    if reply.status == 409 && error_code(&reply).as_deref() == Some("monitoring_off") {
        return Err(ComputeFailure::MonitoringOff);
    }
    boat_reply(reply)
}

impl ComputeProvider for Boat {
    fn id(&self) -> ComputeProviderId {
        ComputeProviderId::Boat
    }

    fn name(&self) -> &'static str {
        "Boat"
    }

    fn capabilities(&self) -> ComputeCapabilities {
        ComputeCapabilities { limits: true, load: true, cost: true, auto_stop: true }
    }

    fn api_base(&self) -> &'static str {
        API_BASE
    }

    fn allows(&self, path: &str) -> bool {
        allows(path)
    }

    fn sandbox_id_ok(&self, sandbox_id: &str) -> bool {
        is_sandbox_id(sandbox_id)
    }

    fn dashboard_url(&self, sandbox_id: &str) -> String {
        format!("{DASHBOARD_SANDBOX}{sandbox_id}")
    }

    fn list<'a>(&'a self, api: &'a dyn ComputeGet) -> BoxFuture<'a, Result<ListedSandboxes, ComputeFailure>> {
        Box::pin(async move {
            let mut sandboxes = Vec::new();
            let mut cursor: Option<String> = None;
            for _ in 0..MAX_PAGES {
                let path = match &cursor {
                    None => format!("/sandboxes?include=cost&limit={PAGE_SIZE}"),
                    Some(cursor) => format!("/sandboxes?include=cost&limit={PAGE_SIZE}&cursor={}", encode_cursor(cursor)),
                };
                let body = boat_reply(api.get(&path).await?)?;
                let page: ListPage = serde_json::from_str(&body).map_err(|_| ComputeFailure::Unexpected)?;
                sandboxes.extend(page.sandboxes.into_iter().filter_map(WireSandbox::listed));
                match page.page_info {
                    Some(PageInfo { has_more: true, next_cursor: Some(next) }) => {
                        if next.is_empty() || next.len() > MAX_CURSOR_LEN || cursor.as_ref() == Some(&next) {
                            return Err(ComputeFailure::Unexpected);
                        }
                        cursor = Some(next);
                    }
                    _ => return Ok(ListedSandboxes { sandboxes, partial: false }),
                }
            }
            Ok(ListedSandboxes { sandboxes, partial: true })
        })
    }

    fn limits<'a>(&'a self, api: &'a dyn ComputeGet) -> BoxFuture<'a, Result<ListedLimits, ComputeFailure>> {
        Box::pin(async move {
            let body = boat_reply(api.get("/limits").await?)?;
            let limits: WireLimits = serde_json::from_str(&body).map_err(|_| ComputeFailure::Unexpected)?;
            Ok(limits.listed())
        })
    }

    fn load<'a>(&'a self, api: &'a dyn ComputeGet, sandbox: &'a ListedSandbox) -> BoxFuture<'a, Result<LoadSample, ComputeFailure>> {
        Box::pin(async move {
            if !is_sandbox_id(&sandbox.id) {
                return Err(ComputeFailure::Unexpected);
            }
            let body = processes_reply(api.get(&format!("/sandboxes/{}/processes", sandbox.id)).await?)?;
            let read: WireProcesses = serde_json::from_str(&body).map_err(|_| ComputeFailure::Unexpected)?;
            // A stored sample from before the sandbox stopped, or none from an agent too old to report, isn't how it is
            // now.
            if !read.live {
                return Err(ComputeFailure::NotLive);
            }
            sample_of(&read.processes, sandbox.vcpus, sandbox.memory_gb).ok_or(ComputeFailure::Unexpected)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_allowlist_takes_only_the_reads_compute_makes() {
        for path in [
            "/sandboxes?include=cost&limit=200",
            "/sandboxes?include=cost&limit=200&cursor=abc%3D%3D",
            "/limits",
            "/sandboxes/bx_23456789/processes",
        ] {
            assert!(allows(path), "{path}");
        }
        for path in [
            "/sandboxes/bx_23456789/conversations",
            "/sandboxes/bx_23456789/events",
            "/sandboxes/bx_23456789/command-history",
            "/sandboxes/bx_23456789/ai-usage",
            "/ai-usage",
            "/sandboxes/bx_23456789/files/list",
            "/sandboxes/bx_23456789/commands",
            "/sandboxes/bx_23456789/stop",
            "/sandboxes/bx_23456789",
            "/sandboxes/bx_2345678/processes",
            "/sandboxes/bx_23456789/processes?x=1",
            "/sandboxes/../api-keys/processes",
            "/sandboxes/bx_234567l9/processes",
            "/sandboxes?include=cost&state=running",
            "/sandboxes?include=cost,deletedCost",
            "/sandboxes?cursor=a/b",
            "/limits?org=personal",
            "/api-keys",
            "/telemetry",
            "/webhooks",
            "/me",
            "",
            "https://elsewhere.example/sandboxes",
            "//elsewhere.example/sandboxes",
        ] {
            assert!(!allows(path), "{path}");
        }
    }

    #[test]
    fn states_map_in_both_spellings_and_cancelled_is_dropped() {
        for (state, expected) in [
            ("init", Some(ComputeSandboxState::Starting)),
            ("provisioning", Some(ComputeSandboxState::Starting)),
            ("provisioned", Some(ComputeSandboxState::Starting)),
            ("cloning", Some(ComputeSandboxState::Starting)),
            ("ready", Some(ComputeSandboxState::Running)),
            ("idle", Some(ComputeSandboxState::Running)),
            ("running", Some(ComputeSandboxState::Running)),
            ("archiving", Some(ComputeSandboxState::Stopping)),
            ("stopping", Some(ComputeSandboxState::Stopping)),
            ("archived", Some(ComputeSandboxState::Stopped)),
            ("stopped", Some(ComputeSandboxState::Stopped)),
            ("error", Some(ComputeSandboxState::Error)),
            ("cancelled", None),
        ] {
            assert_eq!(state_of(state), expected, "{state}");
        }
    }

    #[test]
    fn load_is_the_processes_over_the_sandbox_and_clamped() {
        let sample = load_of(&[(150.0, 1024.0), (50.0, 1024.0)], 4, 8.0).unwrap();
        assert_eq!(sample.cpu, 0.5);
        assert_eq!(sample.memory, 0.25);
        let over = load_of(&[(900.0, 99_999.0), (-5.0, -1.0), (f64::NAN, f64::INFINITY)], 4, 8.0).unwrap();
        assert_eq!((over.cpu, over.memory), (1.0, 1.0));
        let idle = load_of(&[], 2, 4.0).unwrap();
        assert_eq!((idle.cpu, idle.memory), (0.0, 0.0));
        assert!(load_of(&[(10.0, 10.0)], 0, 8.0).is_none());
        assert!(load_of(&[(10.0, 10.0)], 2, 0.0).is_none());
    }

    #[test]
    fn free_text_reasons_become_kinds() {
        assert_eq!(issue_kind("Disk is 97% full"), ComputeIssue::DiskPressure);
        assert_eq!(issue_kind("OOM killer ran"), ComputeIssue::MemoryPressure);
        assert_eq!(issue_kind("setup script exited 1"), ComputeIssue::SetupFailed);
        assert_eq!(issue_kind("kernel panic"), ComputeIssue::Crashed);
        assert_eq!(issue_kind("tunnel blocked by firewall"), ComputeIssue::Other);
        assert_eq!(start_block_kind("Wallet balance is empty"), ComputeStartBlock::WalletEmpty);
        assert_eq!(start_block_kind("Included VM hours used up"), ComputeStartBlock::PlanHoursGone);
        assert_eq!(start_block_kind("Too many active sandboxes"), ComputeStartBlock::ActiveMax);
        assert_eq!(start_block_kind("start limit reached"), ComputeStartBlock::StartRate);
        assert_eq!(start_block_kind("contact support"), ComputeStartBlock::Other);
    }

    #[test]
    fn limits_read_into_their_kinds() {
        let limits: WireLimits = serde_json::from_str(
            r#"{"ok":true,"type":"limits.info","canStart":false,"startBlockedReason":null,"activeSandboxes":100,
                "maxActiveSandboxes":100,"starts":{"unlimited":false,"minute":{"limit":10,"used":3,"remaining":7},
                "hour":{"limit":50,"used":12,"remaining":38},"day":null},"wallet":{"balanceDollars":52.4},
                "planIncluded":{"vmHours":500,"vmHoursRemaining":200,"periodEnd":"2026-12-01T00:00:00.000Z"},
                "keepGoing":{"enabled":true,"capDollars":50,"usedDollars":12.5}}"#,
        )
        .unwrap();
        let listed = limits.listed();
        let period_end = parse_time("2026-12-01T00:00:00Z");
        assert_eq!(listed.period_end_ms, period_end);
        assert_eq!(listed.can_start, Some(false));
        assert_eq!(listed.start_block, Some(ComputeStartBlock::ActiveMax));
        assert_eq!(
            listed.limits,
            [
                ComputeLimit { kind: ComputeLimitKind::ActiveSandboxes, used: 100.0, max: Some(100.0), resets_at_ms: None },
                ComputeLimit { kind: ComputeLimitKind::StartsPerMinute, used: 3.0, max: Some(10.0), resets_at_ms: None },
                ComputeLimit { kind: ComputeLimitKind::StartsPerHour, used: 12.0, max: Some(50.0), resets_at_ms: None },
                ComputeLimit { kind: ComputeLimitKind::PlanHours, used: 300.0, max: Some(500.0), resets_at_ms: period_end },
                ComputeLimit { kind: ComputeLimitKind::ExtraSpend, used: 12.5, max: Some(50.0), resets_at_ms: period_end },
            ]
        );
        let open: WireLimits = serde_json::from_str(r#"{"canStart":true,"startBlockedReason":"ignored"}"#).unwrap();
        assert_eq!(open.listed().start_block, None);
    }

    #[test]
    fn a_trial_allowance_counts_as_plan_hours_that_never_reset() {
        let trial: WireLimits = serde_json::from_str(
            r#"{"canStart":true,"planIncluded":null,"trialComputeCapSeconds":90000,"trialComputeUsedSeconds":36000}"#,
        )
        .unwrap();
        assert_eq!(
            trial.listed().limits,
            [ComputeLimit { kind: ComputeLimitKind::PlanHours, used: 10.0, max: Some(25.0), resets_at_ms: None }]
        );
        // A plan's own hours win over a trial's.
        let paid: WireLimits = serde_json::from_str(
            r#"{"planIncluded":{"vmHours":100,"vmHoursRemaining":40},"trialComputeCapSeconds":90000,"trialComputeUsedSeconds":0}"#,
        )
        .unwrap();
        assert_eq!(paid.listed().limits[0].max, Some(100.0));
    }

    #[test]
    fn a_run_begins_at_the_last_resume_and_monitoring_off_is_read() {
        let wire: WireSandbox = serde_json::from_str(
            r#"{"id":"bx_23456789","state":"running","createdAt":"2026-11-14T09:00:00Z","hydrated":true,
                "hydratedAt":"2026-11-17T09:55:00Z","monitoring":false}"#,
        )
        .unwrap();
        let listed = wire.listed().unwrap();
        assert_eq!(listed.created_at_ms, parse_time("2026-11-14T09:00:00Z").unwrap());
        assert_eq!(listed.run_started_at_ms, parse_time("2026-11-17T09:55:00Z"));
        assert!(listed.monitoring_off);
        let restoring: WireSandbox = serde_json::from_str(
            r#"{"id":"bx_23456789","state":"running","createdAt":"2026-11-14T09:00:00Z","hydrated":false,
                "hydratedAt":"2026-11-15T09:00:00Z"}"#,
        )
        .unwrap();
        let restoring = restoring.listed().unwrap();
        assert_eq!(restoring.run_started_at_ms, None, "still restoring: its hydratedAt is the last restore's");
        assert!(!restoring.monitoring_off);
        let fresh: WireSandbox =
            serde_json::from_str(r#"{"id":"bx_23456789","state":"running","createdAt":"2026-11-17T09:00:00Z"}"#).unwrap();
        assert_eq!(fresh.listed().unwrap().run_started_at_ms, parse_time("2026-11-17T09:00:00Z"));
    }

    #[test]
    fn a_sandbox_binds_only_what_compute_shows() {
        let wire: WireSandbox = serde_json::from_str(
            r#"{"id":"bx_23456789","name":"cedar-02-feature","state":"idle","type":"large","vcpu":8,"memoryGB":16,
                "billingMultiplier":2,"health":"degraded","healthReason":"disk almost full at /home/someone",
                "degradedSince":"2026-11-17T10:00:00Z","createdAt":"2026-11-17T09:00:00Z",
                "archiveAfter":"2026-11-17T11:00:00Z","ttlSeconds":3600,"access":"view",
                "createdBy":"someone@example.com","desktopUrl":"https://desktop.example/?token=SECRET",
                "labels":{"arbor.machine":"cam-mbp","arbor.session":"s-1","other":"SECRET"},
                "cost":{"since":"2026-11-01T00:00:00Z","seconds":7200,"dollars":0.07}}"#,
        )
        .unwrap();
        let listed = wire.listed().unwrap();
        assert_eq!(listed.state, ComputeSandboxState::Running);
        assert_eq!(listed.issue, Some(ComputeIssue::DiskPressure));
        assert_eq!(listed.issue_since_ms, parse_time("2026-11-17T10:00:00Z"));
        assert_eq!((listed.vcpus, listed.memory_gb, listed.multiplier), (8, 16.0, Some(2.0)));
        assert_eq!(listed.month_hours, Some(2.0));
        assert_eq!(listed.auto_stop_seconds, Some(3600));
        assert_eq!(listed.stops_at_ms, parse_time("2026-11-17T11:00:00Z"));
        assert!(!listed.mine);
        assert_eq!(listed.label_machine.as_deref(), Some("cam-mbp"));
        assert!(!format!("{listed:?}").contains("SECRET"));
        assert!(!format!("{listed:?}").contains("someone"));
    }

    #[test]
    fn a_process_list_gives_its_commands_count_and_newest_start_and_never_its_command_lines() {
        let read: WireProcesses = serde_json::from_str(
            r#"{"live":true,"processes":[
                {"pid":1,"parentPid":0,"user":"root","command":"/sbin/init","cpuPercent":0,"memoryMB":10,
                 "startedAt":"2026-11-17T08:00:00Z","commandId":null},
                {"pid":40,"parentPid":1,"user":"cam","command":"bun dev --token SECRET_TOKEN","cpuPercent":100,
                 "memoryMB":1024,"startedAt":"2026-11-17T09:00:00Z","commandId":"cmd_SECRET_ID"},
                {"pid":41,"parentPid":40,"user":"cam","command":"node server.js SECRET_TOKEN","cpuPercent":50,
                 "memoryMB":512,"startedAt":"2026-11-17T09:30:00Z","commandId":null},
                {"pid":50,"parentPid":1,"user":"cam","command":"bun test SECRET_TOKEN","cpuPercent":10,
                 "memoryMB":0,"startedAt":"2026-11-17T09:10:00Z","commandId":"cmd_SECRET_ID_2"},
                {"pid":60,"parentPid":1,"command":"sleep 1","cpuPercent":0,"memoryMB":0,"commandId":"cmd_x"}
            ]}"#,
        )
        .unwrap();
        let sample = sample_of(&read.processes, 4, 8.0).unwrap();
        // Children (null commandId) aren't counted, and a command with no start time doesn't move the newest.
        assert_eq!(sample.commands, Some(3));
        assert_eq!(sample.command_started_ms, parse_time("2026-11-17T09:10:00Z"));
        assert_eq!(sample.cpu, 160.0 / 400.0);
        let shown = format!("{sample:?}");
        for secret in ["SECRET", "cmd_", "/sbin/init", "root", "cam"] {
            assert!(!shown.contains(secret), "{secret} in {shown}");
        }
        // No process from exec: none, and no start.
        let quiet: WireProcesses =
            serde_json::from_str(r#"{"live":true,"processes":[{"cpuPercent":1,"memoryMB":1,"startedAt":"2026-11-17T09:00:00Z"}]}"#)
                .unwrap();
        let quiet = sample_of(&quiet.processes, 4, 8.0).unwrap();
        assert_eq!((quiet.commands, quiet.command_started_ms), (Some(0), None));
    }
}

//! Harness runs: work started on a pool, handed to a harness on the machine the pool picks. Arbor
//! routes and records; T3 Code or Orca runs the agent where the person can open and follow it. The
//! agents' own command lines are the last resort, only when a run allows it and the machine has no
//! harness that could take it.
//!
//! A run is picked for the moment it starts: each member must have room (`pools.rs`) and the run's
//! harness running with the setup it names. When none does, the pool's own setting decides: the run
//! doesn't start, waits in the queue for a member to have room (tried again after every health
//! round, dropped after the pool's wait), or goes to another pool.
//!
//! The record keeps ids, the machine, the folder, times and how it went. The prompt is held in memory
//! only while a run waits, and goes into the script that hands it over; it's never stored or logged.

use super::agents::AgentKind;
use super::pools::{self, MachinePool, PoolWhenFull};
use super::shell::{run_checked, shell_quote};
use super::*;
use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex as StdMutex, OnceLock};

pub(crate) const HARNESS_RUNS_UPDATED_EVENT: &str = "harness-runs-updated";

/// How long handing a run over may take: T3 Code's server and Orca's app answer within seconds,
/// but adding a project or a worktree can take longer.
const HAND_OFF_TIMEOUT: Duration = Duration::from_secs(60);
/// How often a run on the command line is looked in on.
const CHECK_EVERY_MS: i64 = 60_000;
/// Runs listed, newest first.
const KEPT_RUNS: i64 = 500;

/// What runs the agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "RunHarness")]
pub(crate) enum Harness {
    T3,
    Orca,
    /// The agent's own command line, with no app to follow it in.
    Headless,
}

impl Harness {
    fn stored(self) -> &'static str {
        match self {
            Self::T3 => "t3",
            Self::Orca => "orca",
            Self::Headless => "headless",
        }
    }

    fn from_stored(text: &str) -> Self {
        match text {
            "t3" => Self::T3,
            "orca" => Self::Orca,
            _ => Self::Headless,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "RunState")]
pub(crate) enum RunState {
    /// Waiting for a member with room.
    Queued,
    /// Being handed over.
    Starting,
    /// The harness took it; it runs there.
    HandedOff,
    /// On the command line, still going.
    Running,
    /// On the command line, finished.
    Exited,
    Failed,
    /// Didn't start: nobody could take it and the pool doesn't wait.
    Refused,
    /// Waited longer than the pool allows.
    TimedOut,
}

impl RunState {
    fn stored(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Starting => "starting",
            Self::HandedOff => "handed_off",
            Self::Running => "running",
            Self::Exited => "exited",
            Self::Failed => "failed",
            Self::Refused => "refused",
            Self::TimedOut => "timed_out",
        }
    }

    fn from_stored(text: &str) -> Self {
        match text {
            "queued" => Self::Queued,
            "starting" => Self::Starting,
            "handed_off" => Self::HandedOff,
            "running" => Self::Running,
            "exited" => Self::Exited,
            "refused" => Self::Refused,
            "timed_out" => Self::TimedOut,
            _ => Self::Failed,
        }
    }
}

/// Why a run didn't start, or stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "RunReason")]
pub(crate) enum RunReason {
    NoPool,
    /// Every member was full, busy or unseen.
    NoRoom,
    /// Members had room, but none had the harness running with the setup.
    NoHarness,
    /// The folder isn't on the machine.
    NoFolder,
    /// T3 Code needs a model, and neither the run nor the project named one.
    NoModel,
    /// The harness refused it or couldn't be reached.
    HandOffFailed,
    /// Arbor quit while it waited, so its prompt was gone.
    ArborRestarted,
    /// Taken out of the queue by hand.
    Canceled,
    /// The agent on the command line exited with an error.
    AgentFailed,
}

impl RunReason {
    fn stored(self) -> &'static str {
        match self {
            Self::NoPool => "no_pool",
            Self::NoRoom => "no_room",
            Self::NoHarness => "no_harness",
            Self::NoFolder => "no_folder",
            Self::NoModel => "no_model",
            Self::HandOffFailed => "hand_off_failed",
            Self::ArborRestarted => "arbor_restarted",
            Self::Canceled => "canceled",
            Self::AgentFailed => "agent_failed",
        }
    }

    fn from_stored(text: &str) -> Option<Self> {
        Some(match text {
            "no_pool" => Self::NoPool,
            "no_room" => Self::NoRoom,
            "no_harness" => Self::NoHarness,
            "no_folder" => Self::NoFolder,
            "no_model" => Self::NoModel,
            "hand_off_failed" => Self::HandOffFailed,
            "arbor_restarted" => Self::ArborRestarted,
            "canceled" => Self::Canceled,
            "agent_failed" => Self::AgentFailed,
            _ => return None,
        })
    }
}

/// What to start. The prompt is used to hand the run over and then dropped.
#[derive(Clone, Debug, PartialEq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub(crate) struct RunRequest {
    pub(crate) pool: String,
    pub(crate) harness: Harness,
    /// T3 Code's setup id ("codex_work"), Orca's agent id ("codex"), or for the command line
    /// "claude" or "codex".
    pub(crate) setup: String,
    /// Where on the machine the agent works, from `~/` or `/`.
    pub(crate) folder: String,
    pub(crate) prompt: String,
    #[serde(default)]
    pub(crate) model: Option<String>,
    /// Start it on the command line when a member has room but not the harness.
    #[serde(default)]
    pub(crate) fallback: bool,
    /// What the harness calls it; the prompt's first line when left out.
    #[serde(default)]
    pub(crate) title: Option<String>,
    /// The trigger that started it.
    #[serde(default)]
    pub(crate) trigger: Option<String>,
}

/// What the harness gave back, to find the run in it later.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "RunHandle")]
pub(crate) struct RunHandle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    environment_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    thread_id: Option<String>,
    /// Orca's terminal handle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    terminal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pid: Option<u32>,
    /// The session id given to a Claude Code run on the command line, which Sessions finds it by.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    session_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessRun {
    id: String,
    trigger: Option<String>,
    pool: String,
    /// The pool it ran on, after any spill.
    ran_pool: Option<String>,
    machine: Option<String>,
    /// The harness asked for.
    harness: Harness,
    /// The harness it went to: the command line when it fell back.
    used: Option<Harness>,
    setup: String,
    folder: String,
    title: String,
    state: RunState,
    reason: Option<RunReason>,
    /// What the harness or the machine said when it failed.
    detail: Option<String>,
    handle: RunHandle,
    #[ts(type = "number")]
    queued_at_ms: i64,
    #[ts(type = "number | null")]
    started_at_ms: Option<i64>,
    #[ts(type = "number | null")]
    ended_at_ms: Option<i64>,
    /// How long it may wait in the queue, from the pool.
    #[ts(type = "number | null")]
    wait_until_ms: Option<i64>,
}

// ---------------------------------------------------------------------------
// Choosing a machine for a run
// ---------------------------------------------------------------------------

/// What a member offers a run with this harness and setup.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Offer {
    Harness,
    /// Only the command line, with this agent.
    Fallback(AgentKind),
    Nothing,
}

/// The agent a setup starts, for falling back to its command line.
fn agent_for(harness: Harness, setup: &str, driver: Option<&str>) -> Option<AgentKind> {
    let name = match harness {
        Harness::T3 => driver.unwrap_or(setup),
        Harness::Orca | Harness::Headless => setup,
    };
    match name {
        "claude" | "claudeAgent" => Some(AgentKind::Claude),
        "codex" => Some(AgentKind::Codex),
        _ => None,
    }
}

/// Whether a machine's last agents check found what a run needs.
fn offer(agents: &agents::MachineAgents, request: &RunRequest) -> Offer {
    let setup = request.setup.as_str();
    let (has, driver) = match request.harness {
        Harness::T3 => agents
            .t3()
            .filter(|t3| t3.is_running())
            .and_then(|t3| t3.setup(setup))
            .map_or((false, None), |found| (found.is_enabled(), Some(found.driver_name().to_string()))),
        Harness::Orca => (agents.orca().is_some_and(|orca| orca.is_running() && orca.can_start(setup)), None),
        Harness::Headless => (false, None),
    };
    if has {
        return Offer::Harness;
    }
    let driver = driver.or_else(|| agents.t3().and_then(|t3| t3.setup(setup)).map(|found| found.driver_name().to_string()));
    let agent = agent_for(request.harness, setup, driver.as_deref());
    match agent {
        Some(agent) if (request.fallback || request.harness == Harness::Headless) && agents.path_of(agent).is_some() => Offer::Fallback(agent),
        _ => Offer::Nothing,
    }
}

/// Where a run would go now, or why it can't: the pool's verdicts with members lacking the harness
/// marked, and the machine chosen from those left.
struct Placement {
    machine: Option<(Machine, Offer)>,
    reason: RunReason,
}

fn place(inner: &Inner, pool: &MachinePool, offer_for: &dyn Fn(&agents::MachineAgents) -> Offer, recent: &BTreeMap<String, u32>, roll: f64) -> Placement {
    let now_ms = Local::now().timestamp_millis();
    let offers: HashMap<String, Offer> = pool
        .members
        .iter()
        .map(|member| {
            let key = normalize_machine_name(&member.machine);
            let agents = inner.series.values().find(|series| normalize_machine_name(&series.host.machine) == key).map(|series| &series.agents);
            (key, agents.map_or(Offer::Nothing, offer_for))
        })
        .collect();
    let verdicts = pools::assess_with(pool, &pools::readings(inner), recent, now_ms, inner.interval_ms, |machine| {
        offers.get(&normalize_machine_name(machine)).is_some_and(|offer| *offer != Offer::Nothing)
    });
    let Some(chosen) = pools::choose(&verdicts, roll) else {
        let room = verdicts.iter().any(|verdict| verdict.kind() == pools::VerdictKind::NoHarness);
        return Placement { machine: None, reason: if room { RunReason::NoHarness } else { RunReason::NoRoom } };
    };
    let key = normalize_machine_name(chosen.machine());
    // A harness beats the command line whenever both are on offer.
    let offer = offers.get(&key).copied().unwrap_or(Offer::Nothing);
    let machine = inner
        .series
        .values()
        .find(|series| normalize_machine_name(&series.host.machine) == key)
        .map(Machine::listed)
        .or_else(|| this_machine_name(inner).filter(|name| normalize_machine_name(name) == key).map(|name| Machine::this_mac(&name)));
    Placement { machine: machine.map(|machine| (machine, offer)), reason: RunReason::NoRoom }
}

/// How long a queued automation waits between looks at its pool.
const POOL_RETRY: Duration = Duration::from_secs(15);

/// The machine an automation's run goes to when it names a pool: a member with room that has the
/// agent installed, following the pool's spill. A pool that queues is looked at again until the
/// pool's wait or the automation's grace runs out, whichever is first; Automations runs the agent
/// itself, so the harness a run would be handed to doesn't come into it.
pub(super) async fn pick_for_automation(app: &tauri::AppHandle, pool_id: &str, agent: Option<AgentKind>, grace_minutes: u32) -> Result<Machine, String> {
    let pools_saved = run_usage_task(|| pools::read_pools(&open_usage_database()?)).await?;
    let has_agent = |agents: &agents::MachineAgents| match agent {
        Some(agent) if agents.path_of(agent).is_none() => Offer::Nothing,
        Some(agent) => Offer::Fallback(agent),
        None => Offer::Harness,
    };
    let started = Instant::now();
    loop {
        let mut pool_id = pool_id.to_string();
        let mut visited = BTreeSet::new();
        let (pool, reason) = loop {
            let pool = pools_saved.iter().find(|pool| pool.id == pool_id).ok_or("The automation's pool was removed. Choose a pool or machine for it")?;
            visited.insert(pool.id.clone());
            let state = app.state::<MachineHealthState>();
            let since = Local::now().timestamp_millis() - state.lock().interval_ms as i64 * 2;
            let recent = recent_counts(since);
            let placement = place(&state.lock(), pool, &has_agent, &recent, roll());
            if let Some((machine, _)) = placement.machine {
                lock_held().recent.push((normalize_machine_name(machine.name()), Local::now().timestamp_millis()));
                return Ok(machine);
            }
            match (&pool.when_full, &pool.spill_pool) {
                (PoolWhenFull::Spill, Some(next)) if !visited.contains(next) => pool_id = next.clone(),
                _ => break (pool, placement.reason),
            }
        };
        let wait = Duration::from_secs(u64::from(pool.queue_timeout_min.min(grace_minutes)) * 60);
        if pool.when_full != PoolWhenFull::Queue || started.elapsed() + POOL_RETRY > wait {
            return Err(match reason {
                RunReason::NoHarness => format!("No member of {} with room has the agent installed", pool.name),
                _ => format!("Every member of {} was busy, unreachable or out of date", pool.name),
            });
        }
        tokio::time::sleep(POOL_RETRY).await;
    }
}

// ---------------------------------------------------------------------------
// Handing a run over
// ---------------------------------------------------------------------------

/// The folder as the script reads it: `~/` becomes the machine's home.
fn folder_line(folder: &str) -> String {
    if folder == "~" {
        return "folder=\"$HOME\"\n".into();
    }
    match folder.strip_prefix("~/") {
        Some(rest) => format!("folder=\"$HOME\"/{}\n", shell_quote(rest)),
        None => format!("folder={}\n", shell_quote(folder)),
    }
}

/// A folder a run may be given: from the home folder or the root, with no `..`.
fn checked_folder(folder: &str) -> Result<String, String> {
    let folder = folder.trim();
    let folder = if folder.len() > 1 { folder.trim_end_matches('/') } else { folder };
    let rooted = folder == "~" || folder.starts_with("~/") || folder.starts_with('/');
    if !rooted || folder.split('/').any(|part| part == "..") || folder.chars().any(char::is_control) {
        return Err("A run's folder starts with ~/ or / and has no .. in it.".into());
    }
    Ok(if folder.is_empty() { "/".into() } else { folder.to_string() })
}

/// The run's title: the one given, or the prompt's first line, short.
fn title_of(request: &RunRequest) -> String {
    let source = request.title.as_deref().filter(|title| !title.trim().is_empty()).unwrap_or_else(|| request.prompt.lines().find(|line| !line.trim().is_empty()).unwrap_or(""));
    let title: String = source.trim().chars().filter(|c| !c.is_control()).take(80).collect();
    if title.is_empty() { "Arbor run".into() } else { title }
}

/// A random v4 UUID, the shape Claude Code's `--session-id` and T3 Code's ids take.
fn new_uuid() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::fill(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// The agent's own command line with the prompt, and the session id a Claude Code run is given.
fn headless_command(agent: AgentKind, request: &RunRequest, session_id: &str) -> String {
    let model = request.model.as_deref().map(str::trim).filter(|model| !model.is_empty());
    let mut parts: Vec<String> = match agent {
        AgentKind::Claude => vec!["claude".into(), "-p".into(), "--session-id".into(), shell_quote(session_id)],
        AgentKind::Codex => vec!["codex".into(), "exec".into()],
    };
    if let Some(model) = model {
        parts.extend([if agent == AgentKind::Claude { "--model" } else { "-m" }.to_string(), shell_quote(model)]);
    }
    parts.push(shell_quote(&request.prompt));
    parts.join(" ")
}

/// Starts the agent's command line in the folder, detached, and leaves its exit code where a later
/// check finds it. What the agent prints goes nowhere: Arbor never reads a run's conversation.
fn headless_script(run_id: &str, agent: AgentKind, request: &RunRequest, session_id: &str) -> String {
    format!(
        "{env}{folder}if ! cd \"$folder\" 2>/dev/null; then printf 'no_folder\\n'; exit 0; fi
runs=\"$HOME/.arbor/runs\"
mkdir -p \"$runs\"
exit_file=\"$runs\"/{id}.exit
rm -f \"$exit_file\"
command={command}
nohup sh -c \"$command\"' </dev/null >/dev/null 2>&1; printf \"%s\\n\" \"$?\" > \"$1\"' arbor-run \"$exit_file\" </dev/null >/dev/null 2>&1 &
printf 'pid=%s\\n' \"$!\"
",
        env = agents::AGENT_ENV,
        folder = folder_line(&request.folder),
        id = shell_quote(run_id),
        command = shell_quote(&headless_command(agent, request, session_id)),
    )
}

/// How a hand-off came back: the handle, or why it didn't take with the script's failure code.
fn parse_hand_off(stdout: &str) -> Result<RunHandle, (RunReason, Option<String>)> {
    if stdout.lines().any(|line| line.trim() == "no_folder") {
        return Err((RunReason::NoFolder, None));
    }
    if let Some(code) = handoff::failure_line(stdout) {
        let reason = match code.as_str() {
            "no_model" => RunReason::NoModel,
            "no_folder" => RunReason::NoFolder,
            _ => RunReason::HandOffFailed,
        };
        return Err((reason, Some(code)));
    }
    let fields: HashMap<&str, &str> = stdout.lines().filter_map(|line| line.split_once('=')).map(|(key, value)| (key.trim(), value.trim())).collect();
    let text = |key: &str| fields.get(key).filter(|value| !value.is_empty()).map(|value| value.to_string());
    let handle = RunHandle {
        environment_id: text("environment_id"),
        project_id: text("project_id"),
        thread_id: text("thread_id"),
        terminal: text("terminal"),
        pid: fields.get("pid").and_then(|pid| pid.parse().ok()),
        session_id: None,
    };
    if handle == RunHandle::default() {
        return Err((RunReason::HandOffFailed, None));
    }
    Ok(handle)
}

async fn hand_off(machine: &Machine, offer: Offer, run_id: &str, request: &RunRequest) -> Result<(Harness, RunHandle), (RunReason, Option<String>)> {
    let title = title_of(request);
    let (harness, script, session_id) = match (offer, request.harness) {
        (Offer::Harness, Harness::T3) => (Harness::T3, handoff::t3_script(request, &title), None),
        (Offer::Harness, Harness::Orca) => (Harness::Orca, handoff::orca_script(run_id, request, &title), None),
        (Offer::Fallback(agent), _) => {
            let session_id = (agent == AgentKind::Claude).then(new_uuid);
            (Harness::Headless, headless_script(run_id, agent, request, session_id.as_deref().unwrap_or("")), session_id)
        }
        _ => return Err((RunReason::NoHarness, None)),
    };
    // The script holds the prompt, so a failure keeps only the code the script printed, never
    // what the machine wrote to stderr.
    let stdout = run_checked(machine, diagnostics::MachineOp::RunHandOff, &script, HAND_OFF_TIMEOUT)
        .await
        .map_err(|_| (RunReason::HandOffFailed, Some("unreachable".to_string())))?;
    let mut handle = parse_hand_off(&stdout)?;
    handle.session_id = session_id;
    Ok((harness, handle))
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

fn write_run(connection: &Connection, run: &HarnessRun) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO usage_runs (id, trigger_id, pool_id, ran_pool_id, machine, harness, used_harness, setup, folder, title,
                state, reason, detail, handle, queued_at_ms, started_at_ms, ended_at_ms, wait_until_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
             ON CONFLICT(id) DO UPDATE SET ran_pool_id = ?4, machine = ?5, used_harness = ?7, state = ?11, reason = ?12,
                detail = ?13, handle = ?14, started_at_ms = ?16, ended_at_ms = ?17, wait_until_ms = ?18",
            params![
                run.id,
                run.trigger,
                run.pool,
                run.ran_pool,
                run.machine,
                run.harness.stored(),
                run.used.map(Harness::stored),
                run.setup,
                run.folder,
                run.title,
                run.state.stored(),
                run.reason.map(RunReason::stored),
                run.detail,
                serde_json::to_string(&run.handle).unwrap_or_else(|_| "{}".into()),
                run.queued_at_ms,
                run.started_at_ms,
                run.ended_at_ms,
                run.wait_until_ms,
            ],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn read_runs(connection: &Connection, filter: &str) -> Result<Vec<HarnessRun>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT id, trigger_id, pool_id, ran_pool_id, machine, harness, used_harness, setup, folder, title, state, reason,
                detail, handle, queued_at_ms, started_at_ms, ended_at_ms, wait_until_ms
             FROM usage_runs {filter} ORDER BY queued_at_ms DESC LIMIT {KEPT_RUNS}"
        ))
        .map_err(|error| error.to_string())?;
    let runs = statement
        .query_map([], |row| {
            Ok(HarnessRun {
                id: row.get(0)?,
                trigger: row.get(1)?,
                pool: row.get(2)?,
                ran_pool: row.get(3)?,
                machine: row.get(4)?,
                harness: Harness::from_stored(&row.get::<_, String>(5)?),
                used: row.get::<_, Option<String>>(6)?.as_deref().map(Harness::from_stored),
                setup: row.get(7)?,
                folder: row.get(8)?,
                title: row.get(9)?,
                state: RunState::from_stored(&row.get::<_, String>(10)?),
                reason: row.get::<_, Option<String>>(11)?.as_deref().and_then(RunReason::from_stored),
                detail: row.get(12)?,
                handle: serde_json::from_str(&row.get::<_, String>(13)?).unwrap_or_default(),
                queued_at_ms: row.get(14)?,
                started_at_ms: row.get(15)?,
                ended_at_ms: row.get(16)?,
                wait_until_ms: row.get(17)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string());
    runs
}

// ---------------------------------------------------------------------------
// Starting, the queue, and checks
// ---------------------------------------------------------------------------

/// What's held in memory alone: queued runs' requests (their prompts), and runs just sent to each
/// machine, which count as running there until its next sample sees them.
#[derive(Default)]
struct Held {
    waiting: HashMap<String, RunRequest>,
    recent: Vec<(String, i64)>,
    last_check_ms: i64,
    /// Runs whose queue entries from before this launch were marked, once.
    swept: bool,
}

fn held() -> &'static StdMutex<Held> {
    static HELD: OnceLock<StdMutex<Held>> = OnceLock::new();
    HELD.get_or_init(Default::default)
}

fn lock_held() -> std::sync::MutexGuard<'static, Held> {
    held().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Runs sent to each machine since `since_ms`, by normalized name.
fn recent_counts(since_ms: i64) -> BTreeMap<String, u32> {
    let mut held = lock_held();
    held.recent.retain(|(_, at)| *at >= since_ms);
    let mut counts = BTreeMap::new();
    for (machine, _) in &held.recent {
        *counts.entry(machine.clone()).or_insert(0) += 1;
    }
    counts
}

fn roll() -> f64 {
    let mut bytes = [0u8; 8];
    let _ = getrandom::fill(&mut bytes);
    (u64::from_le_bytes(bytes) >> 11) as f64 / (1u64 << 53) as f64
}

fn publish(app: &tauri::AppHandle) {
    let _ = app.emit(HARNESS_RUNS_UPDATED_EVENT, ());
}

/// Tries to start a run on its pool, following spills; records how it went.
async fn attempt(app: &tauri::AppHandle, run: &mut HarnessRun, request: &RunRequest, pools_saved: &[MachinePool]) {
    let mut pool_id = run.pool.clone();
    let mut visited = BTreeSet::new();
    loop {
        let Some(pool) = pools_saved.iter().find(|pool| pool.id == pool_id) else {
            run.state = RunState::Refused;
            run.reason = Some(RunReason::NoPool);
            return;
        };
        visited.insert(pool.id.clone());
        let state = app.state::<MachineHealthState>();
        let since = Local::now().timestamp_millis() - state.lock().interval_ms as i64 * 2;
        let recent = recent_counts(since);
        let placement = place(&state.lock(), pool, &|agents| offer(agents, request), &recent, roll());
        match placement.machine {
            Some((machine, offer)) => {
                run.ran_pool = Some(pool.id.clone());
                run.machine = Some(machine.name().to_string());
                run.state = RunState::Starting;
                lock_held().recent.push((normalize_machine_name(machine.name()), Local::now().timestamp_millis()));
                match hand_off(&machine, offer, &run.id, request).await {
                    Ok((used, handle)) => {
                        run.used = Some(used);
                        run.handle = handle;
                        run.state = if used == Harness::Headless { RunState::Running } else { RunState::HandedOff };
                        run.reason = None;
                        run.detail = None;
                    }
                    Err((reason, detail)) => {
                        run.state = RunState::Failed;
                        run.reason = Some(reason);
                        run.detail = detail;
                        run.ended_at_ms = Some(Local::now().timestamp_millis());
                    }
                }
                run.started_at_ms = Some(Local::now().timestamp_millis());
                run.wait_until_ms = None;
                return;
            }
            None => match pool.when_full {
                PoolWhenFull::Spill if pool.spill_pool.as_ref().is_some_and(|next| !visited.contains(next)) => {
                    pool_id = pool.spill_pool.clone().unwrap_or_default();
                }
                PoolWhenFull::Queue => {
                    run.state = RunState::Queued;
                    run.reason = Some(placement.reason);
                    if run.wait_until_ms.is_none() {
                        run.wait_until_ms = Some(run.queued_at_ms + pool.queue_timeout_min as i64 * 60_000);
                    }
                    return;
                }
                _ => {
                    run.state = RunState::Refused;
                    run.reason = Some(placement.reason);
                    run.ended_at_ms = Some(Local::now().timestamp_millis());
                    return;
                }
            },
        }
    }
}

async fn save(run: HarnessRun) -> Result<(), String> {
    run_usage_task(move || write_run(&open_usage_database()?, &run)).await
}

/// Starts a run on a pool: the machine it picks gets it, handed to the harness named, or queued,
/// spilled or refused as the pool says when nobody can take it.
#[tauri::command]
pub(crate) async fn start_pool_run(app: tauri::AppHandle, request: RunRequest) -> Result<HarnessRun, String> {
    let folder = checked_folder(&request.folder)?;
    if request.prompt.trim().is_empty() {
        return Err("A run needs a prompt.".into());
    }
    if request.setup.trim().is_empty() {
        return Err("A run needs the setup or agent to start.".into());
    }
    let request = RunRequest { folder: folder.clone(), ..request };
    let pools_saved = run_usage_task(|| pools::read_pools(&open_usage_database()?)).await?;
    let mut run = HarnessRun {
        id: new_uuid(),
        trigger: request.trigger.clone(),
        pool: request.pool.clone(),
        ran_pool: None,
        machine: None,
        harness: request.harness,
        used: None,
        setup: request.setup.trim().to_string(),
        folder,
        title: title_of(&request),
        state: RunState::Starting,
        reason: None,
        detail: None,
        handle: RunHandle::default(),
        queued_at_ms: Local::now().timestamp_millis(),
        started_at_ms: None,
        ended_at_ms: None,
        wait_until_ms: None,
    };
    save(run.clone()).await?;
    publish(&app);
    attempt(&app, &mut run, &request, &pools_saved).await;
    if run.state == RunState::Queued {
        lock_held().waiting.insert(run.id.clone(), request);
    }
    save(run.clone()).await?;
    publish(&app);
    Ok(run)
}

#[tauri::command]
pub(crate) async fn get_runs() -> Result<Vec<HarnessRun>, String> {
    run_usage_task(|| read_runs(&open_usage_database()?, "")).await
}

/// Takes a waiting run out of the queue.
#[tauri::command]
pub(crate) async fn cancel_run(app: tauri::AppHandle, id: String) -> Result<Vec<HarnessRun>, String> {
    lock_held().waiting.remove(&id);
    let runs = run_usage_task(move || {
        let connection = open_usage_database()?;
        connection
            .execute(
                "UPDATE usage_runs SET state = 'refused', reason = 'canceled', ended_at_ms = ?2, wait_until_ms = NULL WHERE id = ?1 AND state = 'queued'",
                params![id, Local::now().timestamp_millis()],
            )
            .map_err(|error| error.to_string())?;
        read_runs(&connection, "")
    })
    .await?;
    publish(&app);
    Ok(runs)
}

/// Brings a run up where it runs, as far as its harness allows: Orca switches to the run's terminal
/// on its machine. T3 Code has no way to open one thread from outside, so its runs say where to look.
#[tauri::command]
pub(crate) async fn open_run(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let runs = run_usage_task(|| read_runs(&open_usage_database()?, "")).await?;
    let run = runs.into_iter().find(|run| run.id == id).ok_or("That run is no longer listed.")?;
    let (Some(machine), Some(terminal)) = (run.machine.as_deref(), run.handle.terminal.as_deref()) else {
        return Err("Only runs handed to Orca can be opened from Arbor.".into());
    };
    let machine = find_machine(&app.state::<MachineHealthState>().lock(), machine)?;
    let stdout = run_checked(&machine, diagnostics::MachineOp::RunOpen, &handoff::orca_open_script(terminal), Duration::from_secs(20)).await?;
    match handoff::failure_line(&stdout) {
        None => Ok(()),
        Some(_) => Err("Orca couldn't find the run's terminal. It may have been closed.".into()),
    }
}

/// After each health round: queued runs try again (or time out), and runs on the command line are
/// looked in on. Runs left queued by an earlier launch lost their prompts, so they're closed once.
pub(super) fn after_round(app: &tauri::AppHandle, now_ms: i64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = drain(&app, now_ms).await {
            eprintln!("Harness runs: {error}");
        }
    });
}

async fn drain(app: &tauri::AppHandle, now_ms: i64) -> Result<(), String> {
    let (sweep, check) = {
        let mut held = lock_held();
        let sweep = !held.swept;
        held.swept = true;
        let check = now_ms - held.last_check_ms >= CHECK_EVERY_MS;
        if check {
            held.last_check_ms = now_ms;
        }
        // Between checks, only a waiting run needs the database read.
        if !sweep && !check && held.waiting.is_empty() {
            return Ok(());
        }
        (sweep, check)
    };
    let open = run_usage_task(|| read_runs(&open_usage_database()?, "WHERE state IN ('queued', 'starting', 'running')")).await?;
    if open.is_empty() {
        return Ok(());
    }
    let pools_saved = run_usage_task(|| pools::read_pools(&open_usage_database()?)).await?;
    let mut changed = false;
    for mut run in open.iter().filter(|run| run.state == RunState::Queued || run.state == RunState::Starting).cloned() {
        let request = lock_held().waiting.get(&run.id).cloned();
        let Some(request) = request else {
            if sweep {
                run.state = RunState::Failed;
                run.reason = Some(RunReason::ArborRestarted);
                run.ended_at_ms = Some(now_ms);
                run.wait_until_ms = None;
                save(run).await?;
                changed = true;
            }
            continue;
        };
        if run.wait_until_ms.is_some_and(|until| now_ms > until) {
            lock_held().waiting.remove(&run.id);
            run.state = RunState::TimedOut;
            run.ended_at_ms = Some(now_ms);
            save(run).await?;
            changed = true;
            continue;
        }
        attempt(app, &mut run, &request, &pools_saved).await;
        if run.state != RunState::Queued {
            lock_held().waiting.remove(&run.id);
            save(run).await?;
            changed = true;
        }
    }
    if check {
        changed |= check_running(app, open.into_iter().filter(|run| run.state == RunState::Running).collect()).await?;
    }
    if changed {
        publish(app);
    }
    Ok(())
}

/// Looks in on runs on the command line, one script per machine.
async fn check_running(app: &tauri::AppHandle, running: Vec<HarnessRun>) -> Result<bool, String> {
    let mut by_machine: BTreeMap<String, Vec<HarnessRun>> = BTreeMap::new();
    for run in running {
        if let Some(machine) = run.machine.clone() {
            by_machine.entry(machine).or_default().push(run);
        }
    }
    let mut changed = false;
    for (name, runs) in by_machine {
        let machine = { find_machine(&app.state::<MachineHealthState>().lock(), &name) };
        let Ok(machine) = machine else { continue };
        let Ok(stdout) = run_checked(&machine, diagnostics::MachineOp::RunCheck, &check_script(&runs), Duration::from_secs(20)).await else {
            continue;
        };
        let now_ms = Local::now().timestamp_millis();
        for (mut run, outcome) in parse_checks(&stdout, runs) {
            match outcome {
                Checked::Running => continue,
                Checked::Exited(0) => run.state = RunState::Exited,
                Checked::Exited(_) | Checked::Gone => {
                    run.state = RunState::Failed;
                    run.reason = Some(RunReason::AgentFailed);
                }
            }
            run.ended_at_ms = Some(now_ms);
            save(run).await?;
            changed = true;
        }
    }
    Ok(changed)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Checked {
    Running,
    Exited(i32),
    /// No exit code and no process: the machine restarted, or the run was killed.
    Gone,
}

fn check_script(runs: &[HarnessRun]) -> String {
    let mut script = String::from("runs=\"$HOME/.arbor/runs\"\n");
    for run in runs {
        let pid = run.handle.pid.unwrap_or(0);
        script.push_str(&format!(
            "if [ -f \"$runs\"/{id}.exit ]; then printf '%s exit=%s\\n' {id} \"$(head -n 1 \"$runs\"/{id}.exit)\"; elif kill -0 {pid} 2>/dev/null; then printf '%s running\\n' {id}; else printf '%s gone\\n' {id}; fi\n",
            id = shell_quote(&run.id),
        ));
    }
    script
}

fn parse_checks(stdout: &str, runs: Vec<HarnessRun>) -> Vec<(HarnessRun, Checked)> {
    let found: HashMap<&str, &str> = stdout.lines().filter_map(|line| line.split_once(' ')).collect();
    runs.into_iter()
        .filter_map(|run| {
            let outcome = match found.get(run.id.as_str())?.trim() {
                "running" => Checked::Running,
                "gone" => Checked::Gone,
                other => Checked::Exited(other.strip_prefix("exit=").and_then(|code| code.trim().parse().ok()).unwrap_or(1)),
            };
            Some((run, outcome))
        })
        .collect()
}

#[path = "runs_handoff.rs"]
mod handoff;

#[cfg(test)]
mod tests;

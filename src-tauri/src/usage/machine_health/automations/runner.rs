//! Running Arbor's own automations, while Arbor is open. Every half minute the loop looks for automations that are
//! due. For each, one script on its machine goes to the project (or a new worktree of it), runs the precheck under its
//! time limit and, only when that exits 0, starts the agent detached, so the script ends at once and holds no slot.
//! The agent's run writes three small files into `~/.arbor/automation-runs/<run>/`: its `pid`, its `exit` code and,
//! for Codex, the `session` id from its first event. Nothing else of what it prints is kept anywhere: it goes to
//! /dev/null. Later rounds read those files to say how each run ended, then take the folder away, and a run's own
//! worktree when it's left clean.

use super::super::agents::AGENT_ENV;
use super::super::guarded_writes::STATE_FUNCTIONS;
use super::super::harnesses::Launcher;
use super::super::shell::{find_machine, run_checked, shell_quote, Machine};
use super::super::agent_homes::{self, HomeUse};
use super::proxy::{self, ProxySetup, FUNCTIONS};
use super::store::{self, StoredRun};
use super::*;
use crate::usage::diagnostics::MachineOp;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::collections::BTreeSet;
use tauri::{Emitter, Manager};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const TICK: Duration = Duration::from_secs(30);
/// How much of a precheck's output comes back, from its end.
const PRECHECK_KEPT: usize = 4 << 10;
const POLL_TIMEOUT: Duration = Duration::from_secs(30);

/// The only way Arbor's automation scripts delete a folder. A path built from an empty variable or a missing id must
/// never reach `rm -rf`, so this removes nothing but one named folder inside Arbor's own automation folders, and only
/// when HOME is a real folder.
pub(super) const REMOVE_FOLDER: &str = "arbor_remove() {\n\
 \x20 case \"$HOME\" in ''|/) return 0 ;; esac\n\
 \x20 case \"${1%/}\" in\n\
 \x20   */*/..|*/*/.|\"$HOME\"/.arbor/automation-runs/*/*|\"$HOME\"/.arbor/automations/*/*) return 0 ;;\n\
 \x20   \"$HOME\"/.arbor/automation-runs/?*|\"$HOME\"/.arbor/automations/?*) rm -rf -- \"${1%/}\" ;;\n\
 \x20 esac\n\
 }\n";
/// A run can't start late by less than a round, so that much is always allowed.
const SLACK_MS: i64 = 2 * TICK.as_millis() as i64;

/// Sent whenever an automation, a run or a machine's look changes, so the page reads the list again.
pub(crate) const AUTOMATIONS_UPDATED_EVENT: &str = "automations-updated";

pub(super) static WAKE: Notify = Notify::const_new();
/// Read the machines' background runs back on the next round, not when it's time: something there just changed.
pub(super) static SYNC_NOW: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Automations whose start script is out now, so one slow machine can't have the same run started twice.
static STARTING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

pub(super) fn emit(app: &tauri::AppHandle) {
    let _ = app.emit(AUTOMATIONS_UPDATED_EVENT, ());
}

/// What to do with an automation that's due.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Due {
    Start,
    /// Past its grace window: Arbor or the machine was away.
    Missed,
    /// Its last run is still going.
    Overlap,
}

pub(super) fn due(scheduled_at_ms: i64, grace_minutes: u32, now_ms: i64, still_running: bool) -> Due {
    if now_ms - scheduled_at_ms > i64::from(grace_minutes) * 60_000 + SLACK_MS {
        Due::Missed
    } else if still_running {
        Due::Overlap
    } else {
        Due::Start
    }
}

/// A new id for a run, or a Claude session: random, as a UUID.
pub(super) fn new_uuid() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::fill(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// A path as the script uses it: `~/` becomes the machine's home.
pub(super) fn path_word(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => format!("\"$HOME\"/{}", shell_quote(rest)),
        None if path == "~" => "\"$HOME\"".into(),
        None => shell_quote(path),
    }
}

/// What one run is to do, as the start script needs it.
pub(super) struct Start<'a> {
    pub(super) run_id: &'a str,
    pub(super) automation_id: &'a str,
    pub(super) input: &'a AutomationInput,
    /// Claude's preset session id, or the session to carry on.
    pub(super) session: Option<&'a str>,
    /// Carrying on `session` rather than starting it.
    pub(super) resume: bool,
    /// How the agent reaches Arbor's proxy, and the machine's `agent_homes` for the addresses its agents use; None
    /// for an agent that keeps its own setup.
    pub(super) proxy: Option<(&'a ProxySetup, &'a str)>,
}

/// The agent's command line, reading the prompt from `$dir/prompt` and working in `$work`.
fn agent_command(start: &Start) -> String {
    agent_command_for(start.input, start.session.map(shell_quote).as_deref(), start.resume)
}

/// `agent_command` with the session as a shell word, which can be a variable the script sets.
pub(super) fn agent_command_for(input: &AutomationInput, session: Option<&str>, resume: bool) -> String {
    let full = input.access == AutomationAccess::Full;
    let model = input.model.as_deref().filter(|model| !model.is_empty());
    let effort = input.effort.as_deref().filter(|effort| !effort.is_empty());
    match input.agent.spec().launcher {
        Some(Launcher::Claude) => {
            // The proxy's address and the Automations key for this run only; an API key the machine's environment
            // has would otherwise win over them.
            let mut command = String::from("ANTHROPIC_BASE_URL=\"$ARBOR_PROXY_URL\" ANTHROPIC_AUTH_TOKEN=\"$ARBOR_PROXY_KEY\" claude -p");
            match (session, resume) {
                (Some(session), true) => command.push_str(&format!(" --resume {session}")),
                (Some(session), false) => command.push_str(&format!(" --session-id {session}")),
                (None, _) => {}
            }
            if let Some(model) = model {
                command.push_str(&format!(" --model {}", shell_quote(model)));
            }
            if let Some(effort) = effort {
                command.push_str(&format!(" --effort {}", shell_quote(effort)));
            }
            command.push_str(if full { " --dangerously-skip-permissions" } else { " --permission-mode acceptEdits" });
            format!("{{ unset ANTHROPIC_API_KEY; {command} <\"$dir/prompt\" >/dev/null 2>&1; echo $? >\"$dir/code\"; }}")
        }
        Some(Launcher::Droid) => {
            let mut command = String::from("droid exec -f \"$dir/prompt\" --cwd \"$work\"");
            if let Some(model) = model {
                command.push_str(&format!(" -m {}", shell_quote(model)));
            }
            if let Some(effort) = effort {
                command.push_str(&format!(" -r {}", shell_quote(effort)));
            }
            // Low lets it edit files and nothing more, as Claude's acceptEdits does.
            command.push_str(if full { " --skip-permissions-unsafe" } else { " --auto low" });
            format!("{{ {command} </dev/null >/dev/null 2>&1; echo $? >\"$dir/code\"; }}")
        }
        // Saving made sure it has full access: it never asks before running a command.
        Some(Launcher::Pi { binary, cwd_flag, thinking }) => {
            let mut command = format!("{binary} -p");
            if cwd_flag {
                command.push_str(" --cwd \"$work\"");
            }
            if let Some(model) = model {
                command.push_str(&format!(" --model {}", shell_quote(model)));
            }
            if let (true, Some(effort)) = (thinking, effort) {
                command.push_str(&format!(" --thinking {}", shell_quote(effort)));
            }
            format!("{{ {command} -- \"$(cat \"$dir/prompt\")\" </dev/null >/dev/null 2>&1; echo $? >\"$dir/code\"; }}")
        }
        // Saving checks the agent can be started, so this is only an automation saved by a newer Arbor.
        None => String::from("{ echo 127 >\"$dir/code\"; }"),
        Some(Launcher::Codex) => {
            // A provider of Arbor's own for this run, so the machine's Codex login and provider don't matter. The key
            // comes from the environment by name.
            let mut options = String::from(
                "--json --skip-git-repo-check -c 'model_provider=\"arbor\"' \
                 -c \"model_providers.arbor={ name = \\\"Arbor\\\", base_url = \\\"$ARBOR_PROXY_URL/v1\\\", env_key = \\\"ARBOR_PROXY_KEY\\\", wire_api = \\\"responses\\\" }\"",
            );
            if let Some(model) = model {
                options.push_str(&format!(" -m {}", shell_quote(model)));
            }
            if let Some(effort) = effort {
                options.push_str(&format!(" -c {}", shell_quote(&format!("model_reasoning_effort=\"{effort}\""))));
            }
            let command = match (session, resume) {
                (Some(session), true) => {
                    let access = if full { " --dangerously-bypass-approvals-and-sandbox".to_string() } else { format!(" -c {}", shell_quote("sandbox_mode=\"workspace-write\"")) };
                    format!("codex exec resume {options}{access} {session} -")
                }
                _ => {
                    let access = if full { " --dangerously-bypass-approvals-and-sandbox" } else { " -s workspace-write" };
                    format!("codex exec {options}{access} -C \"$work\" -")
                }
            };
            // Only the thread id leaves the pipe; awk reads to the end so Codex never writes into a closed pipe.
            format!(
                "{{ {command} <\"$dir/prompt\" 2>/dev/null; echo $? >\"$dir/code\"; }} \
                 | awk '!found && /\"type\":\"thread.started\"/ {{ if (match($0, /\"thread_id\":\"[^\"]*\"/)) {{ print substr($0, RSTART + 13, RLENGTH - 14); found = 1; fflush() }} }}' >\"$dir/session\""
            )
        }
    }
}

// Lines out: `W worktree` when one was made, `P exit` and `O output` (base64) after a precheck, `S pid` once the agent
// started, or `E why` when the run couldn't go on. It always exits 0, so a failure here is the machine's or SSH's.
pub(super) fn start_script(start: &Start) -> String {
    let input = start.input;
    let run = shell_quote(start.run_id);
    let mut script = format!(
        "{AGENT_ENV}{STATE_FUNCTIONS}{REMOVE_FOLDER}\
         fail() {{ printf 'E\\t%s\\n' \"$1\"; exit 0; }}\n\
         dir=\"$HOME/.arbor/automation-runs/\"{run}\n\
         mkdir -p \"$dir\" || fail \"Couldn't make a folder for the run\"\n\
         work={project}\n\
         cd \"$work\" 2>/dev/null || fail \"The project folder isn't there\"\n",
        project = path_word(&input.project_path),
    );
    if input.workspace == AutomationWorkspace::NewWorktree {
        let folder: String = start.automation_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        script.push_str(&format!(
            "wt=\"$HOME/.arbor/automation-worktrees/\"{}/{run}\n\
             mkdir -p \"${{wt%/*}}\" && git worktree add --quiet --detach \"$wt\" HEAD </dev/null >/dev/null 2>&1 || fail \"Couldn't make a worktree\"\n\
             printf 'W\\t%s\\n' \"$wt\"\n\
             work=$wt\n\
             cd \"$work\" || fail \"Couldn't open the worktree\"\n",
            shell_quote(&folder)
        ));
    }
    script.push_str(&format!("printf '%s' {} | unbase >\"$dir/prompt\" || fail \"Couldn't write the prompt\"\n", shell_quote(&STANDARD.encode(&input.prompt))));
    if let Some(precheck) = input.precheck.as_deref().filter(|precheck| !precheck.trim().is_empty()) {
        // The watchdog's output goes nowhere, so a sleep it leaves behind can't hold the session open.
        script.push_str(&format!(
            "printf '%s' {} | unbase >\"$dir/precheck\"\n\
             sh \"$dir/precheck\" </dev/null >\"$dir/precheck.out\" 2>&1 &\n\
             check=$!\n\
             ( sleep {timeout}; kill \"$check\" 2>/dev/null ) </dev/null >/dev/null 2>&1 &\n\
             watchdog=$!\n\
             wait \"$check\"; code=$?\n\
             kill \"$watchdog\" 2>/dev/null\n\
             printf 'P\\t%s\\n' \"$code\"\n\
             printf 'O\\t%s\\n' \"$(tail -c {PRECHECK_KEPT} \"$dir/precheck.out\" | base64 | tr -d '\\n')\"\n\
             if [ \"$code\" -ne 0 ]; then arbor_remove \"$dir\"; exit 0; fi\n\
             if [ -s \"$dir/precheck.out\" ]; then {{ printf '\\n\\nThe precheck found:\\n'; tail -c {PRECHECK_KEPT} \"$dir/precheck.out\"; }} >>\"$dir/prompt\"; fi\n",
            shell_quote(&STANDARD.encode(precheck)),
            timeout = input.precheck_timeout_secs.clamp(1, 3600),
        ));
    }
    if let Some((proxy, homes)) = start.proxy {
        // The key goes in a file only the owner can read, is read back into the run's environment, and the file goes.
        script.push_str(&format!(
            "{homes}{FUNCTIONS}\
             command -v curl >/dev/null 2>&1 || fail \"curl isn't on this machine, and automations need it to reach your proxy\"\n\
             ( umask 077; printf '%s' {file} | unbase >\"$dir/proxy\" ) || fail \"Couldn't write the run's proxy settings\"\n\
             ARBOR_PROXY_URL=$(arbor_proxy_find \"$dir/proxy\")\n\
             ARBOR_PROXY_KEY=$(sed -n 's/^key=//p' \"$dir/proxy\" | head -n 1)\n\
             rm -f \"$dir/proxy\"\n\
             [ -n \"$ARBOR_PROXY_URL\" ] || fail {unreachable}\n\
             export ARBOR_PROXY_URL ARBOR_PROXY_KEY\n",
            file = shell_quote(&STANDARD.encode(proxy.file())),
            unreachable = shell_quote(proxy::UNREACHABLE),
        ));
    }
    if let (Harness::Claude, Some(session)) = (input.agent, start.session) {
        script.push_str(&format!("printf '%s' {} >\"$dir/session\"\n", shell_quote(session)));
    }
    script.push_str(&format!(
        "cat >\"$dir/run\" <<'ARBOR_RUN'\n\
         dir=$1; work=$2\n\
         cd \"$work\" || {{ echo 127 >\"$dir/exit\"; exit 0; }}\n\
         {command}\n\
         mv -f \"$dir/code\" \"$dir/exit\"\n\
         ARBOR_RUN\n\
         nohup sh \"$dir/run\" \"$dir\" \"$work\" </dev/null >/dev/null 2>&1 &\n\
         echo $! >\"$dir/pid\"\n\
         printf 'S\\t%s\\n' \"$!\"\n",
        command = agent_command(start),
    ));
    script
}

/// What a start script said.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Started {
    pub(super) worktree: Option<String>,
    pub(super) precheck_exit: Option<i32>,
    pub(super) precheck_output: Option<String>,
    pub(super) pid: Option<u32>,
    pub(super) error: Option<String>,
}

pub(super) fn parse_started(stdout: &str) -> Started {
    let mut started = Started::default();
    for line in stdout.lines() {
        let Some((tag, value)) = line.split_once('\t') else { continue };
        match tag {
            "W" => started.worktree = Some(value.to_string()),
            "P" => started.precheck_exit = value.trim().parse().ok(),
            "O" => {
                let text = String::from_utf8_lossy(&STANDARD.decode(value.trim()).unwrap_or_default()).trim_end().to_string();
                started.precheck_output = (!text.is_empty()).then_some(text);
            }
            "S" => started.pid = value.trim().parse().ok(),
            "E" => started.error = Some(value.to_string()),
            _ => {}
        }
    }
    started
}

/// The run as it stands after its start script, or after the machine couldn't be reached.
pub(super) fn after_start(mut run: AutomationRun, result: Result<Started, String>, now_ms: i64) -> (AutomationRun, Option<String>) {
    let started = match result {
        Ok(started) => started,
        Err(error) => {
            run.status = AutomationRunStatus::Unreachable;
            run.finished_at_ms = Some(now_ms);
            run.error = Some(error.lines().last().unwrap_or_default().chars().take(300).collect());
            return (run, None);
        }
    };
    run.precheck_exit = started.precheck_exit;
    run.precheck_output = started.precheck_output;
    if let Some(error) = started.error {
        run.status = AutomationRunStatus::Failed;
        run.finished_at_ms = Some(now_ms);
        run.error = Some(error);
    } else if started.precheck_exit.is_some_and(|code| code != 0) {
        run.status = AutomationRunStatus::Skipped;
        run.finished_at_ms = Some(now_ms);
    } else if started.pid.is_none() {
        run.status = AutomationRunStatus::Failed;
        run.finished_at_ms = Some(now_ms);
        run.error = Some("The agent didn't start".into());
    }
    (run, started.worktree)
}

// ── Polling ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// How a run looks on its machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Seen {
    Running { session: Option<String> },
    Ended { exit: Option<i32>, session: Option<String> },
    /// Neither going nor ended: its folder or process went away.
    Gone,
}

// Per run, `R id state exit session`. An ended run's folder goes, and its worktree when nothing in it changed.
pub(super) fn poll_script(runs: &[StoredRun]) -> String {
    let mut script = format!("set -u\n{REMOVE_FOLDER}");
    script.push_str(
        "look() {\n\
         \x20 d=\"$HOME/.arbor/automation-runs/$1\"\n\
         \x20 session=$(head -c 200 \"$d/session\" 2>/dev/null | head -n 1)\n\
         \x20 if [ -f \"$d/exit\" ]; then\n\
         \x20   printf 'R\\t%s\\tended\\t%s\\t%s\\n' \"$1\" \"$(head -c 20 \"$d/exit\" | tr -dc '0-9')\" \"$session\"\n\
         \x20   arbor_remove \"$d\"\n\
         \x20   if [ -n \"$2\" ] && [ -d \"$2\" ] && [ -z \"$(git -C \"$2\" status --porcelain 2>/dev/null)\" ]; then git -C \"$2\" worktree remove \"$2\" </dev/null >/dev/null 2>&1; fi\n\
         \x20 elif [ -f \"$d/pid\" ] && kill -0 \"$(cat \"$d/pid\")\" 2>/dev/null; then\n\
         \x20   printf 'R\\t%s\\trunning\\t\\t%s\\n' \"$1\" \"$session\"\n\
         \x20 else\n\
         \x20   printf 'R\\t%s\\tgone\\t\\t%s\\n' \"$1\" \"$session\"\n\
         \x20 fi\n\
         }\n",
    );
    for stored in runs {
        let worktree = stored.worktree.as_deref().map(path_word).unwrap_or_else(|| "''".into());
        script.push_str(&format!("look {} {worktree}\n", shell_quote(&stored.run.id)));
    }
    script
}

pub(super) fn parse_poll(stdout: &str) -> BTreeMap<String, Seen> {
    let mut seen = BTreeMap::new();
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        let ["R", id, state, exit, session] = fields.as_slice() else { continue };
        let session = Some(session.trim().to_string()).filter(|session| !session.is_empty());
        let state = match *state {
            "ended" => Seen::Ended { exit: exit.parse().ok(), session },
            "running" => Seen::Running { session },
            _ => Seen::Gone,
        };
        seen.insert(id.to_string(), state);
    }
    seen
}

/// A run with what its machine says applied; None when nothing changed.
pub(super) fn after_poll(run: &AutomationRun, seen: &Seen, now_ms: i64) -> Option<AutomationRun> {
    let mut next = run.clone();
    match seen {
        Seen::Running { session } => {
            next.session_id = session.clone().or(next.session_id);
        }
        Seen::Ended { exit, session } => {
            next.session_id = session.clone().or(next.session_id);
            next.exit_code = *exit;
            next.finished_at_ms = Some(now_ms);
            next.status = if *exit == Some(0) { AutomationRunStatus::Done } else { AutomationRunStatus::Failed };
            if *exit != Some(0) {
                next.error = Some(match exit {
                    Some(code) => format!("The agent exited with {code}"),
                    None => "The agent ended without an exit code".into(),
                });
            }
        }
        Seen::Gone => {
            next.status = AutomationRunStatus::Failed;
            next.finished_at_ms = Some(now_ms);
            next.error = Some("The run stopped without saying how it ended".into());
        }
    }
    (next != *run).then_some(next)
}

// ── Doing it ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// Where a run goes when it names a machine. A pool's member is picked by `pick_target`.
pub(super) fn pick_machine(inner: &Inner, target: &AutomationTarget) -> Result<Machine, String> {
    match target {
        AutomationTarget::Machine { name } => find_machine(inner, name),
        AutomationTarget::Pool { .. } => Err("A pool's member is picked when the run starts".into()),
        AutomationTarget::Best => Err("Arbor no longer picks a best machine on its own. Choose a machine or pool for this automation".into()),
    }
}

/// Where a run goes: the machine it names, or a member of its pool with room and the agent.
async fn pick_target(app: &tauri::AppHandle, input: &AutomationInput) -> Result<Machine, String> {
    match &input.target {
        AutomationTarget::Pool { id } => {
            let agent = match input.agent {
                Harness::Claude => Some(super::super::agents::AgentKind::Claude),
                Harness::Codex => Some(super::super::agents::AgentKind::Codex),
                _ => None,
            };
            super::super::runs::pick_for_automation(app, id, agent, input.grace_minutes).await
        }
        target => pick_machine(&app.state::<MachineHealthState>().lock(), target),
    }
}

pub(super) fn new_run(automation_id: &str, machine: Option<String>, scheduled_at_ms: i64, manual: bool) -> AutomationRun {
    AutomationRun {
        id: new_uuid(),
        automation_id: automation_id.to_string(),
        machine,
        status: AutomationRunStatus::Running,
        scheduled_at_ms,
        started_at_ms: None,
        finished_at_ms: None,
        manual,
        precheck_exit: None,
        precheck_output: None,
        exit_code: None,
        session_id: None,
        error: None,
    }
}

async fn save_run(stored: StoredRun) -> Result<(), String> {
    run_usage_task(move || {
        let connection = open_usage_database()?;
        let _guard = lock_usage_writes();
        store::write_run(&connection, &stored)?;
        store::prune_runs(&connection, &stored.run.automation_id)
    })
    .await
}

/// Starts one run of `record` and records how far it got. Returns the run as it was left.
pub(super) async fn start_run(app: &tauri::AppHandle, record: &store::Record, scheduled_at_ms: i64, manual: bool) -> Result<AutomationRun, String> {
    {
        let mut starting = STARTING.lock().map_err(|_| "Automations are stuck".to_string())?;
        if !starting.insert(record.id.clone()) {
            return Err("This automation is starting already".into());
        }
    }
    let result = start_run_inner(app, record, scheduled_at_ms, manual).await;
    if let Ok(mut starting) = STARTING.lock() {
        starting.remove(&record.id);
    }
    emit(app);
    result
}

async fn start_run_inner(app: &tauri::AppHandle, record: &store::Record, scheduled_at_ms: i64, manual: bool) -> Result<AutomationRun, String> {
    let now_ms = Local::now().timestamp_millis();
    let picked = pick_target(app, &record.input).await;
    let machine_name = match (&picked, &record.input.target) {
        (Ok(machine), _) => Some(machine.name().to_string()),
        (Err(_), AutomationTarget::Machine { name }) => Some(name.clone()),
        _ => None,
    };
    let mut run = new_run(&record.id, machine_name, scheduled_at_ms, manual);
    run.started_at_ms = Some(now_ms);
    let machine = match picked {
        Ok(machine) => machine,
        Err(error) => {
            run.status = AutomationRunStatus::Failed;
            run.finished_at_ms = Some(now_ms);
            run.error = Some(error);
            save_run(StoredRun { run: run.clone(), worktree: None }).await?;
            return Ok(run);
        }
    };
    let id = record.id.clone();
    let (session, resume) = match record.input.session {
        AutomationSession::Reuse => match run_usage_task(move || store::last_session(&open_usage_database()?, &id)).await? {
            Some(session) => (Some(session), true),
            None => (None, false),
        },
        AutomationSession::Fresh => (None, false),
    };
    let session = session.or_else(|| (record.input.agent == Harness::Claude).then(new_uuid));
    run.session_id = session.clone();
    save_run(StoredRun { run: run.clone(), worktree: None }).await?;
    let proxy = if proxy::routes(&record.input) {
        match proxy::setup(app, &machine).await {
            Ok(proxy) => Some((proxy, agent_homes::shell_function(machine.name(), HomeUse::Sync))),
            Err(error) => {
                let now_ms = Local::now().timestamp_millis();
                run.status = AutomationRunStatus::Failed;
                run.finished_at_ms = Some(now_ms);
                run.error = Some(error);
                save_run(StoredRun { run: run.clone(), worktree: None }).await?;
                return Ok(run);
            }
        }
    } else {
        None
    };
    let start = Start {
        run_id: &run.id,
        automation_id: &record.id,
        input: &record.input,
        session: session.as_deref(),
        resume,
        proxy: proxy.as_ref().map(|(proxy, homes)| (proxy, homes.as_str())),
    };
    let timeout = Duration::from_secs(u64::from(record.input.precheck_timeout_secs.clamp(1, 3600)) + 60);
    let result = run_checked(&machine, MachineOp::AutomationStart, &start_script(&start), timeout).await.map(|stdout| parse_started(&stdout));
    let (run, worktree) = after_start(run, result, Local::now().timestamp_millis());
    save_run(StoredRun { run: run.clone(), worktree }).await?;
    Ok(run)
}

/// Asks each machine with runs going how they are, and records what ended.
async fn poll_running(app: &tauri::AppHandle) -> Result<bool, String> {
    // A run on a machine's background runner is read back by `udian::sync`; there's no folder of Arbor's to look at.
    let running = run_usage_task(|| {
        let connection = open_usage_database()?;
        let elsewhere: BTreeSet<String> =
            store::records(&connection)?.iter().filter(|record| udian::wanted_machine(record).is_some()).map(|record| record.id.clone()).collect();
        Ok(store::running(&connection)?.into_iter().filter(|stored| !elsewhere.contains(&stored.run.automation_id)).collect::<Vec<_>>())
    })
    .await?;
    if running.is_empty() {
        return Ok(false);
    }
    let starting: BTreeSet<String> = STARTING.lock().map(|starting| starting.clone()).unwrap_or_default();
    let mut by_machine: BTreeMap<String, Vec<StoredRun>> = BTreeMap::new();
    for stored in running.into_iter().filter(|stored| !starting.contains(&stored.run.automation_id)) {
        if let Some(machine) = stored.run.machine.clone() {
            by_machine.entry(machine).or_default().push(stored);
        }
    }
    let mut changed = false;
    for (name, runs) in by_machine {
        let Ok(machine) = find_machine(&app.state::<MachineHealthState>().lock(), &name) else {
            continue;
        };
        // A machine that doesn't answer is asked again next round; its runs may well still be going.
        let Ok(stdout) = run_checked(&machine, MachineOp::AutomationPoll, &poll_script(&runs), POLL_TIMEOUT).await else {
            continue;
        };
        let seen = parse_poll(&stdout);
        let now_ms = Local::now().timestamp_millis();
        for stored in runs {
            let Some(next) = seen.get(&stored.run.id).and_then(|seen| after_poll(&stored.run, seen, now_ms)) else {
                continue;
            };
            save_run(StoredRun { run: next, worktree: stored.worktree }).await?;
            changed = true;
        }
    }
    Ok(changed)
}

/// Stops a run that's going: its process and what it started.
pub(super) async fn cancel(app: &tauri::AppHandle, run_id: &str) -> Result<(), String> {
    let id = run_id.to_string();
    let stored = run_usage_task(move || store::run(&open_usage_database()?, &id)).await?.ok_or("Arbor has no run with that id")?;
    if stored.run.status != AutomationRunStatus::Running {
        return Err("That run isn't going".into());
    }
    if let Some(name) = stored.run.machine.clone() {
        let machine = find_machine(&app.state::<MachineHealthState>().lock(), &name)?;
        let script = format!(
            "{REMOVE_FOLDER}d=\"$HOME/.arbor/automation-runs/\"{}\n\
             if [ -f \"$d/pid\" ]; then pid=$(cat \"$d/pid\"); pkill -TERM -P \"$pid\" 2>/dev/null; kill -TERM \"$pid\" 2>/dev/null; fi\n\
             arbor_remove \"$d\"\n",
            shell_quote(run_id)
        );
        run_checked(&machine, MachineOp::AutomationChange, &script, POLL_TIMEOUT).await?;
    }
    let mut run = stored.run;
    run.status = AutomationRunStatus::Canceled;
    run.finished_at_ms = Some(Local::now().timestamp_millis());
    save_run(StoredRun { run, worktree: stored.worktree }).await?;
    emit(app);
    Ok(())
}

/// Whether Arbor runs its automations: on unless Settings turned it off.
pub(super) fn running_on(connection: &rusqlite::Connection) -> Result<bool, String> {
    Ok(store::setting(connection, "running")?.as_deref() != Some("off"))
}

/// One round: what's due starts (or is marked missed or skipped), and running runs are asked about.
async fn round(app: &tauri::AppHandle) -> Result<bool, String> {
    let now_ms = Local::now().timestamp_millis();
    let mut changed = poll_running(app).await?;
    let (on, records, running) = run_usage_task(|| {
        let connection = open_usage_database()?;
        let running: BTreeSet<String> = store::running(&connection)?.into_iter().map(|stored| stored.run.automation_id).collect();
        Ok((running_on(&connection)?, store::records(&connection)?, running))
    })
    .await?;
    if !on {
        return Ok(changed);
    }
    for record in records.into_iter().filter(|record| record.enabled) {
        let Some(scheduled_at_ms) = record.next_run_at_ms.filter(|at| *at <= now_ms) else {
            continue;
        };
        let next = schedule::parse(&record.input.rrule).and_then(|rule| schedule::next_after(&rule, now_ms));
        let id = record.id.clone();
        run_usage_task(move || {
            let connection = open_usage_database()?;
            let _guard = lock_usage_writes();
            store::set_next_run(&connection, &id, next)
        })
        .await?;
        changed = true;
        // The machine's background runner starts it, and records it if it's missed or overlaps.
        if udian::wanted_machine(&record).is_some() {
            continue;
        }
        match due(scheduled_at_ms, record.input.grace_minutes, now_ms, running.contains(&record.id)) {
            Due::Start => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = start_run(&app, &record, scheduled_at_ms, false).await {
                        eprintln!("Failed to start automation {}: {error}", record.id);
                    }
                });
            }
            outcome => {
                let machine = match &record.input.target {
                    AutomationTarget::Machine { name } => Some(name.clone()),
                    AutomationTarget::Pool { .. } | AutomationTarget::Best => None,
                };
                let mut run = new_run(&record.id, machine, scheduled_at_ms, false);
                run.finished_at_ms = Some(now_ms);
                if outcome == Due::Missed {
                    run.status = AutomationRunStatus::Missed;
                } else {
                    run.status = AutomationRunStatus::Skipped;
                    run.error = Some("The last run was still going".into());
                }
                save_run(StoredRun { run, worktree: None }).await?;
            }
        }
    }
    Ok(changed)
}

pub(crate) async fn poll_loop(app: tauri::AppHandle, token: CancellationToken) {
    loop {
        match round(&app).await {
            Ok(true) => emit(&app),
            Ok(false) => {}
            Err(error) => eprintln!("Automations round failed: {error}"),
        }
        let placed = udian::reconcile(&app).await;
        let synced = udian::sync(&app, SYNC_NOW.swap(false, std::sync::atomic::Ordering::Relaxed)).await;
        match (placed, synced) {
            (Ok(placed), Ok(synced)) if placed || synced => emit(&app),
            (Err(error), _) | (_, Err(error)) => eprintln!("Background runner round failed: {error}"),
            _ => {}
        }
        discover::scan_due(&app, Local::now().timestamp_millis());
        tokio::select! {
            _ = tokio::time::sleep(TICK) => {},
            _ = WAKE.notified() => {},
            _ = token.cancelled() => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_remove_helper_only_deletes_one_named_automation_folder() {
        let home = std::env::temp_dir().join(format!("arbor-remove-{}-{}", std::process::id(), new_uuid()));
        let runs = home.join(".arbor/automation-runs");
        for dir in ["kept", "gone", "other/inner"] {
            std::fs::create_dir_all(runs.join(dir)).unwrap();
        }
        std::fs::create_dir_all(home.join(".arbor/automations/arbor-a")).unwrap();
        std::fs::write(home.join("precious"), "x").unwrap();
        let script = format!(
            "{REMOVE_FOLDER}r=\"$HOME/.arbor/automation-runs\"\n\
             arbor_remove \"$r/\"\n\
             arbor_remove \"$r\"\n\
             arbor_remove \"$r/..\"\n\
             arbor_remove \"$r/.\"\n\
             arbor_remove \"$r/other/inner\"\n\
             arbor_remove \"$HOME\"\n\
             arbor_remove \"$HOME/.arbor\"\n\
             arbor_remove \"\"\n\
             arbor_remove /\n\
             arbor_remove \"$r/gone/\"\n\
             HOME= arbor_remove \"/.arbor/automation-runs/kept\"\n"
        );
        for shell in ["sh", "dash"] {
            if shell == "dash" && std::process::Command::new("dash").arg("-c").arg("true").status().is_err() {
                continue;
            }
            let status = std::process::Command::new(shell).arg("-c").arg(&script).env("HOME", &home).status().unwrap();
            assert!(status.success());
        }
        assert!(home.join("precious").exists());
        assert!(runs.join("kept").exists());
        assert!(runs.join("other/inner").exists());
        assert!(home.join(".arbor/automations/arbor-a").exists());
        assert!(!runs.join("gone").exists());
        std::fs::remove_dir_all(&home).unwrap();
    }

    fn input(agent: Harness) -> AutomationInput {
        AutomationInput {
            id: None,
            name: "Sentry watch".into(),
            prompt: "Fix what's new in Sentry.".into(),
            agent,
            model: Some("gpt-6-sol".into()),
            effort: Some("low".into()),
            target: AutomationTarget::Machine { name: "cedar-02".into() },
            project_path: "~/code/billing".into(),
            workspace: AutomationWorkspace::Checkout,
            session: AutomationSession::Fresh,
            access: AutomationAccess::Edits,
            runs_on: AutomationRunsOn::App,
            rrule: "FREQ=HOURLY;BYMINUTE=0".into(),
            timezone: None,
            grace_minutes: 20,
            precheck: Some("gh issue list | grep -q .".into()),
            precheck_timeout_secs: 60,
            enabled: true,
        }
    }

    #[test]
    fn a_due_run_starts_waits_or_is_missed() {
        let hour = 3_600_000;
        assert_eq!(due(hour, 20, hour + 30_000, false), Due::Start);
        assert_eq!(due(hour, 20, hour + 30_000, true), Due::Overlap);
        assert_eq!(due(hour, 20, hour + 19 * 60_000, false), Due::Start);
        assert_eq!(due(hour, 20, hour + 23 * 60_000, false), Due::Missed);
        assert_eq!(due(hour, 0, hour + 50_000, false), Due::Start);
    }

    #[test]
    fn uuids_are_version_four() {
        let id = new_uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert_ne!(id, new_uuid());
    }

    #[test]
    fn the_start_script_checks_first_and_keeps_no_output() {
        let input = input(Harness::Codex);
        let start = Start { run_id: "run-1", automation_id: "a-1", input: &input, session: None, resume: false, proxy: None };
        let script = start_script(&start);
        assert!(script.contains("work=\"$HOME\"/'code/billing'"));
        assert!(script.contains("sleep 60"));
        assert!(script.contains("codex exec --json --skip-git-repo-check -c 'model_provider=\"arbor\"'"));
        assert!(script.contains("base_url = \\\"$ARBOR_PROXY_URL/v1\\\", env_key = \\\"ARBOR_PROXY_KEY\\\""), "{script}");
        assert!(script.contains("\" -m 'gpt-6-sol'"));
        assert!(script.contains(" -s workspace-write -C \"$work\" -"));
        assert!(!script.contains("dangerously"));
        assert!(script.contains(">\"$dir/session\""));
        assert!(!script.contains("Fix what's new"), "the prompt travels as base64");
        assert!(!script.contains("git worktree add"));
    }

    #[test]
    fn claude_gets_its_session_id_and_the_access_asked_for() {
        let mut input = input(Harness::Claude);
        input.access = AutomationAccess::Full;
        input.workspace = AutomationWorkspace::NewWorktree;
        let start = Start { run_id: "run-2", automation_id: "a-1", input: &input, session: Some("s-1"), resume: false, proxy: None };
        let script = start_script(&start);
        assert!(script.contains("{ unset ANTHROPIC_API_KEY; ANTHROPIC_BASE_URL=\"$ARBOR_PROXY_URL\" ANTHROPIC_AUTH_TOKEN=\"$ARBOR_PROXY_KEY\" claude -p --session-id 's-1' --model 'gpt-6-sol' --effort 'low' --dangerously-skip-permissions"));
        assert!(script.contains("git worktree add"));
        let resumed = Start { run_id: "run-3", automation_id: "a-1", input: &input, session: Some("s-1"), resume: true, proxy: None };
        assert!(start_script(&resumed).contains("claude -p --resume 's-1'"));
    }

    #[test]
    fn codex_carries_on_a_session_with_the_same_sandbox() {
        let input = input(Harness::Codex);
        let start = Start { run_id: "run-4", automation_id: "a-1", input: &input, session: Some("t-9"), resume: true, proxy: None };
        let script = start_script(&start);
        assert!(script.contains("codex exec resume --json --skip-git-repo-check -c 'model_provider=\"arbor\"'"));
        assert!(script.contains("sandbox_mode=\"workspace-write\"' 't-9' -"));
    }

    #[test]
    fn reads_what_the_start_script_said() {
        let output = STANDARD.encode("3 new issues\n");
        let started = parse_started(&format!("W\t/home/casey/.arbor/automation-worktrees/a/run\nP\t0\nO\t{output}\nS\t4242\n"));
        assert_eq!(started.precheck_exit, Some(0));
        assert_eq!(started.precheck_output.as_deref(), Some("3 new issues"));
        assert_eq!(started.pid, Some(4242));
        let run = new_run("a-1", Some("cedar-02".into()), 1, false);
        let (run, worktree) = after_start(run, Ok(started), 5);
        assert_eq!(run.status, AutomationRunStatus::Running);
        assert!(worktree.is_some());
    }

    #[test]
    fn a_failed_precheck_skips_and_a_machine_away_is_unreachable() {
        let skipped = after_start(new_run("a", None, 1, false), Ok(parse_started("P\t1\nO\t\n")), 5).0;
        assert_eq!(skipped.status, AutomationRunStatus::Skipped);
        assert_eq!(skipped.precheck_exit, Some(1));
        let away = after_start(new_run("a", None, 1, false), Err("ssh: connect to host cedar-02 port 22: Operation timed out".into()), 5).0;
        assert_eq!(away.status, AutomationRunStatus::Unreachable);
        let failed = after_start(new_run("a", None, 1, false), Ok(parse_started("E\tThe project folder isn't there\n")), 5).0;
        assert_eq!(failed.status, AutomationRunStatus::Failed);
        assert_eq!(failed.error.as_deref(), Some("The project folder isn't there"));
    }

    #[test]
    fn polling_ends_runs_by_their_exit_code() {
        let run = new_run("a", Some("cedar-02".into()), 1, false);
        let seen = parse_poll(&format!("R\t{}\tended\t0\tthread-7\nR\tother\tgone\t\t\n", run.id));
        let done = after_poll(&run, &seen[&run.id], 9).unwrap();
        assert_eq!(done.status, AutomationRunStatus::Done);
        assert_eq!(done.session_id.as_deref(), Some("thread-7"));
        assert_eq!(seen["other"], Seen::Gone);
        let failed = after_poll(&run, &Seen::Ended { exit: Some(2), session: None }, 9).unwrap();
        assert_eq!(failed.status, AutomationRunStatus::Failed);
        assert_eq!(after_poll(&run, &Seen::Running { session: None }, 9), None);
    }

    #[test]
    fn the_poll_script_names_each_run_and_its_worktree() {
        let run = new_run("a", Some("cedar-02".into()), 1, false);
        let stored = StoredRun { run: run.clone(), worktree: Some("/home/casey/.arbor/automation-worktrees/a/r".into()) };
        let script = poll_script(&[stored]);
        assert!(script.contains(&format!("look '{}' '/home/casey/.arbor/automation-worktrees/a/r'", run.id)));
    }

    #[test]
    fn the_best_machine_isnt_picked_yet() {
        let state = MachineHealthState::default();
        assert!(pick_machine(&state.lock(), &AutomationTarget::Best).unwrap_err().contains("machine or pool"));
    }

    /// The scripts as a machine runs them, under `sh` with a temp HOME and a stand-in `codex` that prints Codex's
    /// first event and the prompt it was given, which must go nowhere.
    #[test]
    fn a_run_starts_checks_and_ends_under_sh() {
        use std::io::Write;
        let home = std::env::temp_dir().join(format!("arbor-automation-run-{}-{}", std::process::id(), new_uuid()));
        let project = home.join("code/billing");
        let bin = home.join(".local/bin");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        let codex = bin.join("codex");
        std::fs::write(&codex, "#!/bin/sh\nprintf '%s %s' \"$ARBOR_PROXY_URL\" \"$ARBOR_PROXY_KEY\" >\"$HOME/env-seen\"\nprintf '%s' \"$*\" >\"$HOME/args-seen\"\nprintf '{\"type\":\"thread.started\",\"thread_id\":\"t-42\"}\\n'\ncat\nexit 3\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755)).unwrap();
        // A curl that answers 200 only at the test proxy and only with the key.
        std::fs::write(
            bin.join("curl"),
            "#!/bin/sh\nconfig=$(cat)\ncase $config in *sk-arbor-0123abcd*) ;; *) echo 401; exit 0 ;; esac\n\
             case \" $* \" in *' http://proxy.test:8443/v1/models '*) echo 200 ;; *) echo 000 ;; esac\n",
        )
        .unwrap();
        std::fs::set_permissions(bin.join("curl"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let proxy = ProxySetup { key: "sk-arbor-0123abcd".into(), first: vec!["http://nowhere.test:1".into()], last: vec!["http://proxy.test:8443".into()] };
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
        let sh = |script: &str| {
            let mut child = std::process::Command::new("sh")
                .env("HOME", &home)
                .env("PATH", &path)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
            String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap()
        };
        let mut input = input(Harness::Codex);
        input.precheck = Some("echo 2 new issues".into());
        let start = Start { run_id: "run-sh", automation_id: "arbor:a", input: &input, session: None, resume: false, proxy: Some((&proxy, "")) };
        assert!(!start_script(&start).contains("sk-arbor-0123abcd"), "the key travels encoded, never as a word");
        let started = parse_started(&sh(&start_script(&start)));
        assert_eq!(started.error, None);
        assert_eq!(started.precheck_exit, Some(0));
        assert_eq!(started.precheck_output.as_deref(), Some("2 new issues"));
        assert!(started.pid.is_some());
        let run = new_run("arbor:a", None, 1, false);
        let stored = StoredRun { run: AutomationRun { id: "run-sh".into(), ..run }, worktree: None };
        let mut seen = Seen::Gone;
        for _ in 0..100 {
            seen = parse_poll(&sh(&poll_script(std::slice::from_ref(&stored)))).remove("run-sh").unwrap();
            if matches!(seen, Seen::Ended { .. }) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(seen, Seen::Ended { exit: Some(3), session: Some("t-42".into()) });
        // Codex went through the first address that answered, with the key in its environment only.
        assert_eq!(std::fs::read_to_string(home.join("env-seen")).unwrap(), "http://proxy.test:8443 sk-arbor-0123abcd");
        assert!(!std::fs::read_to_string(home.join("args-seen")).unwrap().contains("sk-arbor"));
        assert!(!home.join(".arbor/automation-runs/run-sh").exists(), "an ended run's folder goes");

        input.precheck = Some("exit 1".into());
        let start = Start { run_id: "run-skip", automation_id: "arbor:a", input: &input, session: None, resume: false, proxy: Some((&proxy, "")) };
        let skipped = parse_started(&sh(&start_script(&start)));
        assert_eq!(skipped.precheck_exit, Some(1));
        assert_eq!(skipped.pid, None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn droid_and_pi_style_agents_get_the_prompt_and_their_own_flags_under_sh() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let home = std::env::temp_dir().join(format!("arbor-automation-harness-{}-{}", std::process::id(), new_uuid()));
        let project = home.join("code/billing");
        let bin = home.join(".local/bin");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        // Each stand-in writes the words it was given, one to a line, and the prompt file droid reads.
        for name in ["droid", "prime-agent"] {
            let path = bin.join(name);
            std::fs::write(&path, format!("#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done >\"$HOME/{name}.args\"\nexit 0\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let sh = |script: &str| {
            let mut child = std::process::Command::new("sh")
                .env("HOME", &home)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
            String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap()
        };
        let wait_for = |name: &str| {
            let path = home.join(format!("{name}.args"));
            for _ in 0..100 {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    if !text.is_empty() {
                        return text;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            panic!("{name} never ran");
        };

        let mut droid = input(Harness::Droid);
        droid.precheck = None;
        let start = Start { run_id: "run-droid", automation_id: "arbor:d", input: &droid, session: None, resume: false, proxy: None };
        assert_eq!(parse_started(&sh(&start_script(&start))).error, None);
        let args = wait_for("droid");
        let args: Vec<&str> = args.lines().collect();
        assert_eq!(args[..2], ["exec", "-f"]);
        assert!(args.windows(2).any(|pair| pair == ["--auto", "low"]), "{args:?}");
        assert!(args.windows(2).any(|pair| pair == ["-m", "gpt-6-sol"]), "{args:?}");
        assert!(args.windows(2).any(|pair| pair[0] == "--cwd" && pair[1].ends_with("code/billing")), "{args:?}");

        let mut prime = input(Harness::PrimeAgent);
        prime.precheck = None;
        prime.access = AutomationAccess::Full;
        prime.prompt = "- Fix what's new\n- Say what you did".into();
        let start = Start { run_id: "run-prime", automation_id: "arbor:p", input: &prime, session: None, resume: false, proxy: None };
        assert_eq!(parse_started(&sh(&start_script(&start))).error, None);
        let args = wait_for("prime-agent");
        assert!(args.starts_with("-p\n--cwd\n"), "{args}");
        assert!(args.contains("--model\ngpt-6-sol\n--thinking\nlow\n--\n"), "{args}");
        // The prompt arrives whole, as one message after `--`, even where it starts with a dash.
        assert!(args.ends_with("--\n- Fix what's new\n- Say what you did\n"), "{args}");
        let _ = std::fs::remove_dir_all(&home);
    }
}

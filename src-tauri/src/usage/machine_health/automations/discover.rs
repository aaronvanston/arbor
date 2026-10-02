//! Finding the automations other apps keep on a machine: the Codex app's in each Codex home's `automations` folder,
//! Claude's scheduled tasks in each Claude home's `scheduled-tasks` folder, and Orca's through its command line.
//!
//! What comes back is what the user wrote (name, prompt, schedule, precheck) and when each last ran. Orca's run
//! history carries each run's terminal output, so it's cut down on the machine, by Node, which Orca's command line
//! runs on, to each automation's last status and time before anything is sent back.

use super::super::agent_homes::{self, machines_to_scan, tilde, HomeUse};
use super::super::agents::AGENT_ENV;
use super::super::guarded_writes::{cksum, edit_call, edit_finish, edit_outcomes, edit_start, new_stamp, run_on, ChangeKind, Edit, EditFile, EditOutcome};
use super::super::shell::{find_machine, run_checked, shell_quote, Machine};
use super::*;
use crate::usage::diagnostics::MachineOp;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::Manager;

pub(super) const SCAN_TIMEOUT: Duration = Duration::from_secs(60);

/// Where a found automation is kept, for pausing it there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Keeper {
    /// The Codex app's file, as it was read, so a change is only made to the file as Arbor saw it.
    CodexFile { path: String, content: Vec<u8> },
    ClaudeFile,
    /// Orca's id for it, on the machine whose Orca was asked.
    Orca { id: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Found {
    pub(super) automation: Automation,
    /// The machine it was found on, whose app keeps it.
    pub(super) found_on: String,
    pub(super) keeper: Keeper,
}

/// One machine's last look.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct MachineFind {
    pub(super) scanned_at_ms: Option<i64>,
    pub(super) scanning: bool,
    pub(super) error: Option<String>,
    pub(super) orca: bool,
    pub(super) found: Vec<Found>,
}

// Lines out: `H home`, `C path base64` for each Codex automation, `S path base64` for each Claude task (its first
// 64 KB), and where Orca's command line is: `O list` (automations), `P projects`, `T hosts`, `R runs` (each
// automation's last run, cut down by Node), each base64. Nothing reads stdin: the script arrives on it.
const ORCA_SCRIPT: &str = r##"if command -v orca >/dev/null 2>&1; then
  printf 'O\t%s\n' "$(orca automations list --json </dev/null 2>/dev/null | base64 | tr -d '\n')"
  printf 'P\t%s\n' "$(orca project list --json </dev/null 2>/dev/null | base64 | tr -d '\n')"
  printf 'T\t%s\n' "$(orca host list --json </dev/null 2>/dev/null | base64 | tr -d '\n')"
  if command -v node >/dev/null 2>&1; then
    runs=$(orca automations runs --json </dev/null 2>/dev/null | node -e '
let text = "";
process.stdin.on("data", (chunk) => { text += chunk; });
process.stdin.on("end", () => {
  let runs = [];
  try { runs = JSON.parse(text).result.runs || []; } catch (error) { runs = []; }
  const last = {};
  for (const run of runs) {
    const at = run.startedAt || run.scheduledFor || 0;
    if (!last[run.automationId] || last[run.automationId].at < at) last[run.automationId] = { status: String(run.status || ""), at };
  }
  process.stdout.write(JSON.stringify(last));
});' 2>/dev/null)
    printf 'R\t%s\n' "$(printf '%s' "$runs" | base64 | tr -d '\n')"
  fi
fi
"##;

fn scan_script(machine: &str) -> String {
    format!(
        "{AGENT_ENV}{homes}\
         printf 'H\\t%s\\n' \"$HOME\"\n\
         homes=$(agent_homes)\n\
         while IFS=$tab read -r agent home; do\n\
         \x20 case $agent in\n\
         \x20   codex) for f in \"$home\"/automations/*/automation.toml; do [ -f \"$f\" ] || continue; printf 'C\\t%s\\t%s\\n' \"$f\" \"$(head -c 65536 \"$f\" | base64 | tr -d '\\n')\"; done ;;\n\
         \x20   claude) for f in \"$home\"/scheduled-tasks/*/SKILL.md; do [ -f \"$f\" ] || continue; printf 'S\\t%s\\t%s\\n' \"$f\" \"$(head -c 65536 \"$f\" | base64 | tr -d '\\n')\"; done ;;\n\
         \x20 esac\n\
         done <<ARBOR_HOMES\n$homes\nARBOR_HOMES\n\
         {ORCA_SCRIPT}",
        homes = agent_homes::shell_function(machine, HomeUse::Sync),
    )
}

pub(super) async fn scan(machine: &Machine) -> MachineFind {
    let scanned_at_ms = Local::now().timestamp_millis();
    match run_checked(machine, MachineOp::AutomationScan, &scan_script(machine.name()), SCAN_TIMEOUT).await {
        Ok(stdout) => {
            let (found, orca) = parse_scan(machine.name(), &stdout);
            MachineFind { scanned_at_ms: Some(scanned_at_ms), scanning: false, error: None, orca, found }
        }
        Err(error) => MachineFind { scanned_at_ms: Some(scanned_at_ms), scanning: false, error: Some(error), orca: false, found: Vec::new() },
    }
}

fn unbase(text: &str) -> Vec<u8> {
    STANDARD.decode(text.trim()).unwrap_or_default()
}

/// What a machine's scan found, and whether Orca's command line is there.
pub(super) fn parse_scan(machine: &str, stdout: &str) -> (Vec<Found>, bool) {
    let home = stdout.lines().find_map(|line| line.strip_prefix("H\t")).unwrap_or_default().to_string();
    let mut found = Vec::new();
    let mut orca = None;
    let (mut projects, mut hosts, mut last_runs) = (Vec::new(), Vec::new(), Vec::new());
    for line in stdout.lines() {
        let fields: Vec<&str> = line.splitn(3, '\t').collect();
        match fields.as_slice() {
            ["C", path, content] => found.extend(codex_automation(machine, &home, path, unbase(content))),
            ["S", path, content] => found.extend(claude_task(machine, &home, path, &unbase(content))),
            ["O", content] => orca = Some(unbase(content)),
            ["P", content] => projects = unbase(content),
            ["T", content] => hosts = unbase(content),
            ["R", content] => last_runs = unbase(content),
            _ => {}
        }
    }
    let has_orca = orca.is_some();
    if let Some(list) = orca {
        found.extend(orca_automations(machine, &list, &projects, &hosts, &last_runs));
    }
    (found, has_orca)
}

fn summary(id: String, source: AutomationSource, name: String, enabled: bool, machine: &str, abilities: AutomationAbilities) -> AutomationSummary {
    AutomationSummary {
        id,
        source,
        name,
        enabled,
        machine: Some(machine.to_string()),
        target: AutomationTarget::Machine { name: machine.to_string() },
        project: None,
        agent: None,
        schedule: ScheduleSummary::Elsewhere,
        next_run_at_ms: None,
        last_run: None,
        has_precheck: false,
        abilities,
    }
}

fn found_automation(summary: AutomationSummary, prompt: String, rrule: Option<String>) -> Automation {
    Automation {
        summary,
        prompt,
        rrule,
        timezone: None,
        project_path: None,
        workspace: AutomationWorkspace::Checkout,
        session: AutomationSession::Fresh,
        access: AutomationAccess::Edits,
        model: None,
        effort: None,
        precheck: None,
        precheck_timeout_secs: 0,
        grace_minutes: 0,
        source_path: None,
        created_at_ms: None,
        updated_at_ms: None,
    }
}

/// The folder an automation's file is in, which the apps name it by.
fn folder_name(path: &str) -> String {
    path.rsplit('/').nth(1).unwrap_or(path).to_string()
}

/// A Codex app automation: `name`, `prompt`, `rrule`, `status` (ACTIVE or PAUSED) and its times in ms.
fn codex_automation(machine: &str, home: &str, path: &str, content: Vec<u8>) -> Option<Found> {
    let text = String::from_utf8(content.clone()).ok()?;
    let table: toml::Table = text.parse().ok()?;
    let string = |key: &str| table.get(key).and_then(toml::Value::as_str).map(str::to_string);
    let number = |key: &str| table.get(key).and_then(toml::Value::as_integer);
    let folder = folder_name(path);
    let name = string("name").unwrap_or_else(|| folder.clone());
    let enabled = string("status").is_none_or(|status| status.eq_ignore_ascii_case("ACTIVE"));
    let rrule = string("rrule");
    let mut summary = summary(
        format!("codexApp:{machine}:{folder}"),
        AutomationSource::CodexApp,
        name,
        enabled,
        machine,
        AutomationAbilities { edit: false, pause: true, run_now: false, delete: false, copy: true },
    );
    summary.agent = Some(AutomationAgent::Codex);
    if let Some(rule) = &rrule {
        summary.schedule = schedule::summary(rule);
        if enabled {
            summary.next_run_at_ms = schedule::parse(rule).and_then(|rule| schedule::next_after(&rule, Local::now().timestamp_millis()));
        }
    }
    let mut automation = found_automation(summary, string("prompt").unwrap_or_default(), rrule);
    automation.source_path = Some(tilde(path, home));
    automation.created_at_ms = number("created_at");
    automation.updated_at_ms = number("updated_at");
    Some(Found { automation, found_on: machine.to_string(), keeper: Keeper::CodexFile { path: path.to_string(), content } })
}

/// A Claude scheduled task: its SKILL.md's `name` and `description`, and the rest as the prompt. Claude keeps its
/// schedule elsewhere.
fn claude_task(machine: &str, home: &str, path: &str, content: &[u8]) -> Option<Found> {
    let text = String::from_utf8_lossy(content);
    let (front, body) = match text.strip_prefix("---\n").and_then(|rest| rest.split_once("\n---")) {
        Some((front, body)) => (front.to_string(), body.trim_start_matches('-').trim().to_string()),
        None => (String::new(), text.trim().to_string()),
    };
    let field = |key: &str| {
        front.lines().find_map(|line| line.strip_prefix(&format!("{key}:")).map(|value| value.trim().trim_matches('"').to_string())).filter(|value| !value.is_empty())
    };
    let folder = folder_name(path);
    let name = field("description").filter(|description| description.len() <= 60).or_else(|| field("name")).unwrap_or_else(|| folder.clone());
    let mut summary = summary(
        format!("claudeDesktop:{machine}:{folder}"),
        AutomationSource::ClaudeDesktop,
        name,
        true,
        machine,
        AutomationAbilities { edit: false, pause: false, run_now: false, delete: false, copy: true },
    );
    summary.agent = Some(AutomationAgent::Claude);
    let mut automation = found_automation(summary, body, None);
    automation.source_path = Some(tilde(path, home));
    Some(Found { automation, found_on: machine.to_string(), keeper: Keeper::ClaudeFile })
}

/// The `result` of an Orca command's JSON, or what's under `key` in it.
fn orca_result(bytes: &[u8], key: &str) -> Vec<serde_json::Value> {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return Vec::new();
    };
    let result = value.get("result").unwrap_or(&value);
    result.get(key).or(Some(result)).and_then(serde_json::Value::as_array).cloned().unwrap_or_default()
}

fn orca_status(status: &str) -> AutomationRunStatus {
    match status {
        "completed" => AutomationRunStatus::Done,
        "running" | "dispatching" | "dispatched" => AutomationRunStatus::Running,
        "skipped_precheck" => AutomationRunStatus::Skipped,
        "skipped_unavailable" => AutomationRunStatus::Unreachable,
        "skipped_missed" => AutomationRunStatus::Missed,
        "canceled" | "cancelled" => AutomationRunStatus::Canceled,
        _ => AutomationRunStatus::Failed,
    }
}

fn orca_agent(agent: &str) -> AutomationAgent {
    match agent {
        "claude" => AutomationAgent::Claude,
        "codex" => AutomationAgent::Codex,
        "gemini" => AutomationAgent::Gemini,
        _ => AutomationAgent::Other,
    }
}

/// Orca's automations, with the project and host named as Orca names them. One on Orca's own machine is on `machine`;
/// one on an SSH host is on the machine of that name.
fn orca_automations(machine: &str, list: &[u8], projects: &[u8], hosts: &[u8], last_runs: &[u8]) -> Vec<Found> {
    let text = |value: &serde_json::Value, key: &str| value.get(key).and_then(serde_json::Value::as_str).map(str::to_string);
    let project_names: BTreeMap<String, String> =
        orca_result(projects, "projects").iter().filter_map(|project| Some((text(project, "id")?, text(project, "displayName")?))).collect();
    let host_names: BTreeMap<String, String> = orca_result(hosts, "hosts").iter().filter_map(|host| Some((text(host, "id")?, text(host, "name")?))).collect();
    let last: BTreeMap<String, serde_json::Value> = serde_json::from_slice(last_runs).unwrap_or_default();
    orca_result(list, "automations")
        .iter()
        .filter_map(|item| {
            let id = text(item, "id")?;
            let enabled = item.get("enabled").and_then(serde_json::Value::as_bool).unwrap_or(true);
            let on = match text(item, "executionTargetType").as_deref() {
                Some("ssh") => text(item, "executionTargetId").and_then(|target| host_names.get(&target).cloned()).unwrap_or_else(|| machine.to_string()),
                _ => machine.to_string(),
            };
            let mut summary = summary(
                format!("orca:{id}"),
                AutomationSource::Orca,
                text(item, "name").unwrap_or_else(|| id.clone()),
                enabled,
                &on,
                AutomationAbilities { edit: false, pause: true, run_now: true, delete: false, copy: true },
            );
            summary.project = text(item, "projectId").and_then(|project| project_names.get(&project).cloned());
            summary.agent = text(item, "agentId").map(|agent| orca_agent(&agent));
            let rrule = text(item, "rrule");
            summary.schedule = rrule.as_deref().map_or(ScheduleSummary::Custom, schedule::summary);
            summary.next_run_at_ms = item.get("nextRunAt").and_then(serde_json::Value::as_i64).filter(|_| enabled);
            let precheck = item.get("precheck").and_then(|precheck| precheck.get("command")).and_then(serde_json::Value::as_str).map(str::to_string);
            summary.has_precheck = precheck.is_some();
            summary.last_run = last.get(&id).and_then(|run| {
                Some(AutomationLastRun { status: orca_status(run.get("status")?.as_str()?), at_ms: run.get("at")?.as_i64()? })
            });
            let mut automation = found_automation(summary, text(item, "prompt").unwrap_or_default(), rrule);
            automation.timezone = text(item, "timezone");
            automation.workspace = if text(item, "workspaceMode").as_deref() == Some("new-per-run") { AutomationWorkspace::NewWorktree } else { AutomationWorkspace::Checkout };
            automation.session = if item.get("reuseSession").and_then(serde_json::Value::as_bool) == Some(true) { AutomationSession::Reuse } else { AutomationSession::Fresh };
            automation.precheck = precheck;
            automation.precheck_timeout_secs =
                item.get("precheck").and_then(|precheck| precheck.get("timeoutSeconds")).and_then(serde_json::Value::as_u64).unwrap_or(60) as u32;
            automation.grace_minutes = item.get("missedRunGraceMinutes").and_then(serde_json::Value::as_u64).unwrap_or(0) as u32;
            automation.created_at_ms = item.get("createdAt").and_then(serde_json::Value::as_i64);
            automation.updated_at_ms = item.get("updatedAt").and_then(serde_json::Value::as_i64);
            Some(Found { automation, found_on: machine.to_string(), keeper: Keeper::Orca { id } })
        })
        .collect()
}

/// A Codex app automation's file with its status set, every other line as it was.
pub(super) fn codex_with_status(content: &[u8], enabled: bool) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(content).ok()?;
    let status = if enabled { "ACTIVE" } else { "PAUSED" };
    let mut replaced = false;
    let mut lines: Vec<String> = text
        .lines()
        .map(|line| {
            if !replaced && line.trim_start().starts_with("status") && line.contains('=') {
                replaced = true;
                format!("status = \"{status}\"")
            } else {
                line.to_string()
            }
        })
        .collect();
    if !replaced {
        lines.push(format!("status = \"{status}\""));
    }
    let mut out = lines.join("\n");
    if text.ends_with('\n') {
        out.push('\n');
    }
    Some(out.into_bytes())
}

// ── What was found ───────────────────────────────────────────────────────────────────────────────────────────────

/// Each machine's last look, kept while Arbor is open. Nothing found is saved: it's the other apps' to keep.
pub(super) static FOUND: Mutex<BTreeMap<String, MachineFind>> = Mutex::new(BTreeMap::new());
/// How often each machine is looked at again in the background.
const RESCAN_MS: i64 = 30 * 60_000;

pub(super) fn found() -> BTreeMap<String, MachineFind> {
    FOUND.lock().map(|found| found.clone()).unwrap_or_default()
}

/// Looks on one machine and keeps what it found. Orca's automations can turn up on more than one machine, as Orca
/// on each runs its own list; the first machine's copy is kept.
pub(super) async fn scan_machine(app: &tauri::AppHandle, machine: Machine) {
    let name = machine.name().to_string();
    {
        let Ok(mut found) = FOUND.lock() else { return };
        let entry = found.entry(name.clone()).or_default();
        if entry.scanning {
            return;
        }
        entry.scanning = true;
    }
    runner::emit(app);
    let result = scan(&machine).await;
    if let Ok(mut found) = FOUND.lock() {
        found.insert(name, result);
    }
    runner::emit(app);
}

/// Looks on each machine not looked at for half an hour.
pub(super) fn scan_due(app: &tauri::AppHandle, now_ms: i64) {
    let machines = machines_to_scan(&app.state::<MachineHealthState>().lock());
    let found = found();
    for machine in machines {
        let fresh = found.get(machine.name()).is_some_and(|find| find.scanning || find.scanned_at_ms.is_some_and(|at| now_ms - at < RESCAN_MS));
        if fresh {
            continue;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move { scan_machine(&app, machine).await });
    }
}

/// Every found automation, an Orca one once.
pub(super) fn all_found(found: &BTreeMap<String, MachineFind>) -> Vec<Found> {
    let mut seen = std::collections::BTreeSet::new();
    found.values().flat_map(|find| find.found.iter()).filter(|item| seen.insert(item.automation.summary.id.clone())).cloned().collect()
}

pub(super) fn find(id: &str) -> Option<Found> {
    all_found(&found()).into_iter().find(|item| item.automation.summary.id == id)
}

/// Pauses or resumes a found automation in the app that keeps it: the Codex app's file through a guarded write, which
/// Sync › Arbor's changes can undo; Orca's through its command line.
pub(super) async fn set_enabled(app: &tauri::AppHandle, item: &Found, enabled: bool) -> Result<(), String> {
    let machine = find_machine(&app.state::<MachineHealthState>().lock(), &item.found_on)?;
    match &item.keeper {
        Keeper::CodexFile { path, content } => {
            let after = codex_with_status(content, enabled).ok_or("Arbor couldn't read that automation's file")?;
            let edit = Edit { file: EditFile::Path(path.clone()), before: cksum(content), content: after };
            let script = format!("{}{}{}", edit_start(&new_stamp(), ChangeKind::Automations), edit_call(0, &edit), edit_finish());
            let stdout = run_on(&machine, MachineOp::AutomationChange, &script).await?;
            match edit_outcomes(&stdout).get(&0) {
                Some(EditOutcome::Done) => {}
                Some(EditOutcome::Changed) => return Err("The Codex app changed this automation since Arbor looked. Refresh and try again".into()),
                _ => return Err("Arbor couldn't change the Codex app's file".into()),
            }
        }
        Keeper::Orca { id } => {
            let flag = if enabled { "--enabled" } else { "--disabled" };
            let script = format!("{AGENT_ENV}orca automations edit {} {flag} </dev/null >/dev/null
", shell_quote(id));
            run_checked(&machine, MachineOp::AutomationChange, &script, SCAN_TIMEOUT).await?;
        }
        Keeper::ClaudeFile => return Err("Claude keeps this task's schedule itself. Pause it in Claude".into()),
    }
    scan_machine(app, machine).await;
    Ok(())
}

/// Runs a found automation now, where its app can be asked to: Orca only.
pub(super) async fn run_now(app: &tauri::AppHandle, item: &Found) -> Result<(), String> {
    let Keeper::Orca { id } = &item.keeper else {
        return Err("Only Orca can be asked to run its automations from here".into());
    };
    let machine = find_machine(&app.state::<MachineHealthState>().lock(), &item.found_on)?;
    let script = format!("{AGENT_ENV}orca automations run --id {} </dev/null >/dev/null
", shell_quote(id));
    run_checked(&machine, MachineOp::AutomationChange, &script, SCAN_TIMEOUT).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(text: &str) -> String {
        STANDARD.encode(text)
    }

    const CODEX: &str = "version = 1\nid = \"inbox-triage\"\nkind = \"heartbeat\"\nname = \"Inbox triage\"\nprompt = \"Label new mail.\"\nstatus = \"PAUSED\"\nrrule = \"RRULE:FREQ=MINUTELY;INTERVAL=30\"\ntarget_thread_id = \"t-1\"\ncreated_at = 1783121815383\nupdated_at = 1784755440788\n";

    #[test]
    fn reads_codex_app_automations_and_claude_tasks() {
        let stdout = format!(
            "H\t/Users/casey\nC\t/Users/casey/.codex/automations/inbox-triage/automation.toml\t{}\nS\t/Users/casey/.claude/scheduled-tasks/notes/SKILL.md\t{}\n",
            b64(CODEX),
            b64("---\nname: notes\ndescription: Meeting notes to wiki\n---\n\nAdd the newest notes to the wiki.\n"),
        );
        let (found, orca) = parse_scan("casey-mbp", &stdout);
        assert!(!orca);
        assert_eq!(found.len(), 2);
        let codex = &found[0].automation;
        assert_eq!(codex.summary.id, "codexApp:casey-mbp:inbox-triage");
        assert_eq!(codex.summary.name, "Inbox triage");
        assert!(!codex.summary.enabled);
        assert_eq!(codex.summary.schedule, ScheduleSummary::EveryMinutes { minutes: 30 });
        assert_eq!(codex.summary.next_run_at_ms, None);
        assert_eq!(codex.prompt, "Label new mail.");
        assert_eq!(codex.source_path.as_deref(), Some("~/.codex/automations/inbox-triage/automation.toml"));
        assert_eq!(codex.created_at_ms, Some(1783121815383));
        let claude = &found[1].automation;
        assert_eq!(claude.summary.name, "Meeting notes to wiki");
        assert_eq!(claude.summary.schedule, ScheduleSummary::Elsewhere);
        assert_eq!(claude.prompt, "Add the newest notes to the wiki.");
    }

    #[test]
    fn reads_orca_with_its_projects_hosts_and_last_runs() {
        let list = r#"{"ok":true,"result":{"automations":[{"id":"a-1","name":"Repo audit","prompt":"Audit PRs.","rrule":"FREQ=HOURLY;BYMINUTE=0","enabled":true,"agentId":"codex","projectId":"p-1","executionTargetType":"ssh","executionTargetId":"ssh-9","workspaceMode":"existing","reuseSession":true,"nextRunAt":1790900000000,"missedRunGraceMinutes":720,"precheck":{"command":"gh pr list | grep -q .","timeoutSeconds":60}}]}}"#;
        let projects = r#"{"result":{"projects":[{"id":"p-1","displayName":"billing"}]}}"#;
        let hosts = r#"{"result":{"hosts":[{"id":"ssh-9","name":"cedar-02"}]}}"#;
        let runs = r#"{"a-1":{"status":"skipped_precheck","at":1790899506005}}"#;
        let stdout = format!("H\t/Users/casey\nO\t{}\nP\t{}\nT\t{}\nR\t{}\n", b64(list), b64(projects), b64(hosts), b64(runs));
        let (found, orca) = parse_scan("casey-mbp", &stdout);
        assert!(orca);
        let automation = &found[0].automation;
        assert_eq!(automation.summary.id, "orca:a-1");
        assert_eq!(automation.summary.machine.as_deref(), Some("cedar-02"));
        assert_eq!(automation.summary.project.as_deref(), Some("billing"));
        assert_eq!(automation.summary.agent, Some(AutomationAgent::Codex));
        assert_eq!(automation.summary.last_run, Some(AutomationLastRun { status: AutomationRunStatus::Skipped, at_ms: 1790899506005 }));
        assert!(automation.summary.has_precheck);
        assert_eq!(automation.session, AutomationSession::Reuse);
        assert_eq!(automation.grace_minutes, 720);
        assert_eq!(found[0].found_on, "casey-mbp");
        assert_eq!(found[0].keeper, Keeper::Orca { id: "a-1".into() });
    }

    #[test]
    fn an_orca_that_answers_badly_lists_nothing() {
        let stdout = format!("O\t{}\n", b64("not json"));
        let (found, orca) = parse_scan("casey-mbp", &stdout);
        assert!(orca);
        assert!(found.is_empty());
    }

    #[test]
    fn pauses_a_codex_automation_by_its_status_line_alone() {
        let paused = codex_with_status(CODEX.replace("PAUSED", "ACTIVE").as_bytes(), false).unwrap();
        assert_eq!(String::from_utf8(paused).unwrap(), CODEX);
        let resumed = String::from_utf8(codex_with_status(CODEX.as_bytes(), true).unwrap()).unwrap();
        assert!(resumed.contains("status = \"ACTIVE\"\n"));
        assert_eq!(resumed.lines().count(), CODEX.lines().count());
    }

    #[test]
    fn the_scan_reads_only_stdin_free_commands() {
        let script = scan_script("casey-mbp");
        assert!(script.contains("orca automations list --json </dev/null"));
        assert!(script.contains("automations/*/automation.toml"));
        assert!(script.contains("scheduled-tasks/*/SKILL.md"));
    }
}

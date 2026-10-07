//! The Automations page's commands.

use super::apps;
use super::discover::{self, Found, MachineFind};
use super::proxy;
use super::store::{self, Record};
use super::super::harnesses::{self, Launcher};
use super::super::shell::shell_quote;
use super::*;
use tauri::Manager;

/// What an Arbor automation lets the page do with it.
const ARBOR_ABILITIES: AutomationAbilities = AutomationAbilities { edit: true, pause: true, run_now: true, delete: true, copy: false };
const ARBOR_PREFIX: &str = "arbor:";

fn folder_name(path: &str) -> Option<String> {
    path.trim_end_matches('/').rsplit('/').next().filter(|name| !name.is_empty() && *name != "~").map(str::to_string)
}

fn target_machine(target: &AutomationTarget) -> Option<String> {
    match target {
        AutomationTarget::Machine { name } => Some(name.clone()),
        AutomationTarget::Pool { .. } | AutomationTarget::Best => None,
    }
}

fn arbor_summary(record: &Record, last_run: Option<AutomationLastRun>) -> AutomationSummary {
    let input = &record.input;
    AutomationSummary {
        id: record.id.clone(),
        source: AutomationSource::Arbor,
        name: input.name.clone(),
        enabled: record.enabled,
        machine: target_machine(&input.target),
        target: input.target.clone(),
        project: folder_name(&input.project_path),
        agent: Some(input.agent),
        model: input.model.clone(),
        schedule: schedule::summary(&input.rrule),
        next_run_at_ms: record.next_run_at_ms.filter(|_| record.enabled),
        last_run,
        has_precheck: input.precheck.as_deref().is_some_and(|precheck| !precheck.trim().is_empty()),
        abilities: ARBOR_ABILITIES,
        runs_on: input.runs_on,
    }
}

fn arbor_automation(record: &Record, last_run: Option<AutomationLastRun>) -> Automation {
    let input = &record.input;
    Automation {
        summary: arbor_summary(record, last_run),
        prompt: input.prompt.clone(),
        rrule: Some(input.rrule.clone()),
        timezone: input.timezone.clone(),
        project_path: Some(input.project_path.clone()),
        workspace: input.workspace,
        session: input.session,
        access: input.access,
        model: input.model.clone(),
        effort: input.effort.clone(),
        precheck: input.precheck.clone(),
        precheck_timeout_secs: input.precheck_timeout_secs,
        grace_minutes: input.grace_minutes,
        source_path: None,
        created_at_ms: Some(record.created_at_ms),
        updated_at_ms: Some(record.updated_at_ms),
    }
}

fn last_run(connection: &rusqlite::Connection, id: &str) -> Result<Option<AutomationLastRun>, String> {
    Ok(store::runs(connection, Some(id), 1)?.into_iter().next().map(|stored| AutomationLastRun {
        status: stored.run.status,
        at_ms: stored.run.started_at_ms.unwrap_or(stored.run.scheduled_at_ms),
    }))
}

/// The model a session asked for most, from the proxy's records of it.
fn session_model(connection: &rusqlite::Connection, session: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT model FROM usage_events WHERE session_id = ?1 AND COALESCE(model, '') <> ''
             GROUP BY model ORDER BY SUM(input_tokens) DESC, model LIMIT 1",
            [session],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read the session's model: {error}"))
}

/// An Arbor automation's summary, with the model its last run used when it isn't set to one.
fn arbor_summary_with_model(connection: &rusqlite::Connection, record: &Record, last: Option<AutomationLastRun>) -> Result<AutomationSummary, String> {
    let mut summary = arbor_summary(record, last);
    if summary.model.is_none() {
        if let Some(session) = store::last_session(connection, &record.id)? {
            summary.model = session_model(connection, &session)?;
        }
    }
    Ok(summary)
}

/// A found automation with its project and model filled in from the session it runs in, when its app names none: the
/// checkout that session's transcript recorded and the model the proxy saw it use, looked up by the id the app
/// stores, never guessed from names.
fn with_project(connection: &rusqlite::Connection, mut item: Found) -> Result<Found, String> {
    let Some(session) = item.session.clone() else { return Ok(item) };
    if item.automation.summary.model.is_none() {
        item.automation.summary.model = session_model(connection, &session)?;
    }
    if item.automation.project_path.is_some() {
        return Ok(item);
    }
    let session = session.as_str();
    let checkout: Option<String> = connection
        .query_row(
            "SELECT CASE WHEN main_repo <> '' THEN main_repo WHEN repo_root <> '' THEN repo_root ELSE cwd END
             FROM usage_session_transcripts WHERE session_id = ?1",
            [session],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read the session's project: {error}"))?;
    if let Some(checkout) = checkout.filter(|path| !path.is_empty()) {
        if item.automation.summary.project.is_none() {
            item.automation.summary.project = folder_name(&checkout);
        }
        item.automation.project_path = Some(checkout);
    }
    Ok(item)
}

/// The list as the page shows it, from what's saved and each machine's last look.
pub(super) fn list_from(
    connection: &rusqlite::Connection,
    found: &BTreeMap<String, MachineFind>,
    machines: &[String],
) -> Result<AutomationList, String> {
    let mut automations = Vec::new();
    for record in store::records(connection)? {
        let last = last_run(connection, &record.id)?;
        automations.push(arbor_summary_with_model(connection, &record, last)?);
    }
    let apps_off = store::apps_off(connection)?;
    for item in discover::all_found(found).into_iter().filter(|item| !apps_off.contains(&item.automation.summary.source)) {
        automations.push(with_project(connection, item)?.automation.summary);
    }
    let placing = udian::placing_errors();
    let mut scans: Vec<AutomationScan> = found
        .iter()
        .map(|(machine, find)| AutomationScan {
            machine: machine.clone(),
            scanned_at_ms: find.scanned_at_ms,
            scanning: find.scanning,
            error: find.error.clone(),
            apps: find.apps.clone(),
            udian: find.udian.clone(),
            placing_error: placing.get(machine).cloned(),
        })
        .collect();
    for machine in machines.iter().filter(|machine| !found.contains_key(*machine)) {
        scans.push(AutomationScan {
            machine: machine.clone(),
            scanned_at_ms: None,
            scanning: false,
            error: None,
            apps: Vec::new(),
            udian: None,
            placing_error: placing.get(machine).cloned(),
        });
    }
    scans.sort_by(|a, b| a.machine.cmp(&b.machine));
    Ok(AutomationList {
        automations,
        scans,
        running: runner::running_on(connection)?,
        draft_model: store::setting(connection, "draft_model")?.unwrap_or_else(|| draft::DEFAULT_MODEL.into()),
        draft_effort: store::setting(connection, "draft_effort")?.unwrap_or_else(|| draft::DEFAULT_EFFORT.into()),
        udian_bundled: udian::bundle().map(|bundle| bundle.version),
        udian_skill: udian::bundle().and_then(|bundle| bundle.skill()).map(|skill| super::super::guarded_writes::cksum(&skill)),
        agents: Harness::ALL.into_iter().filter(|harness| harness.launches()).collect(),
        // Whether the core still has the key, and which harnesses the machines have, need the app; `current_list` fills
        // them in.
        proxy_key: false,
        proxy_address: store::setting(connection, proxy::ADDRESS_SETTING)?.unwrap_or_default(),
        apps_off,
    })
}

fn machine_names(app: &tauri::AppHandle) -> Vec<String> {
    agent_homes::machines_to_scan(&app.state::<MachineHealthState>().lock()).iter().map(|machine| machine.name().to_string()).collect()
}

/// The harnesses Arbor can start that some machine has, for the agent pickers: one nobody installed isn't offered.
fn launchable(app: &tauri::AppHandle) -> Vec<Harness> {
    let found_on = super::super::setup::harnesses_found(&app.state::<MachineHealthState>().lock());
    Harness::ALL.into_iter().filter(|harness| harness.launches() && harnesses::is_found(*harness, &found_on)).collect()
}

async fn current_list(app: &tauri::AppHandle) -> Result<AutomationList, String> {
    let found = discover::found();
    let machines = machine_names(app);
    let agents = launchable(app);
    let (mut list, fingerprint) = run_usage_task(move || {
        let connection = open_usage_database()?;
        Ok((list_from(&connection, &found, &machines)?, store::setting(&connection, proxy::KEY_SETTING)?))
    })
    .await?;
    list.proxy_key = proxy::has_key(app, fingerprint.as_deref());
    list.agents = agents;
    Ok(list)
}

async fn arbor_record(id: &str) -> Result<Record, String> {
    let id = id.to_string();
    run_usage_task(move || store::record(&open_usage_database()?, &id)).await?.ok_or_else(|| "Arbor has no automation with that id".to_string())
}

fn found_or_error(id: &str) -> Result<Found, String> {
    discover::find(id).ok_or_else(|| "Arbor hasn't found that automation. Refresh and try again".to_string())
}

/// What's wrong with an automation as the dialog sent it, if anything.
pub(super) fn check_input(input: &AutomationInput) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("Give the automation a name".into());
    }
    if input.prompt.trim().is_empty() {
        return Err("Write what the agent should do".into());
    }
    let Some(launcher) = input.agent.spec().launcher else {
        return Err("Arbor can't start that agent yet. Pick another".into());
    };
    if input.access != AutomationAccess::Full && !launcher.limits_edits() {
        return Err("This agent doesn't ask before it runs commands, so it can only run with full access".into());
    }
    if input.session == AutomationSession::Reuse && !matches!(launcher, Launcher::Claude | Launcher::Codex) {
        return Err("This agent starts a fresh session each run".into());
    }
    match &input.target {
        AutomationTarget::Machine { name } if !name.trim().is_empty() => {}
        AutomationTarget::Pool { id } if !id.trim().is_empty() => {}
        _ => return Err("Choose the machine or pool it runs on".into()),
    }
    if input.project_path.trim().is_empty() {
        return Err("Choose the project it works in".into());
    }
    if schedule::parse(&input.rrule).is_none() {
        return Err("Arbor can't run that schedule. Pick one of the choices, or a rule of every few minutes, hours or days".into());
    }
    if !(1..=3600).contains(&input.precheck_timeout_secs) {
        return Err("The precheck's time limit is 1 second to an hour".into());
    }
    if input.runs_on == AutomationRunsOn::Machine {
        if let Some(why) = udian::unplaceable(input) {
            return Err(why.into());
        }
    }
    Ok(())
}

fn new_id() -> String {
    format!("{ARBOR_PREFIX}{}", runner::new_uuid())
}

fn next_run(input: &AutomationInput, enabled: bool, now_ms: i64) -> Option<i64> {
    enabled.then(|| schedule::parse(&input.rrule).and_then(|rule| schedule::next_after(&rule, now_ms))).flatten()
}

fn save_record(mut input: AutomationInput) -> Result<Record, String> {
    check_input(&input)?;
    let connection = open_usage_database()?;
    if let AutomationTarget::Pool { id } = &input.target {
        if !super::super::pools::read_pools(&connection)?.iter().any(|pool| &pool.id == id) {
            return Err("That pool isn't saved any more. Choose another".into());
        }
    }
    let _guard = lock_usage_writes();
    let now_ms = Local::now().timestamp_millis();
    let existing = match input.id.as_deref() {
        Some(id) => Some(store::record(&connection, id)?.ok_or("Arbor has no automation with that id")?),
        None => None,
    };
    let id = existing.as_ref().map(|record| record.id.clone()).unwrap_or_else(new_id);
    input.id = Some(id.clone());
    input.name = input.name.trim().to_string();
    input.project_path = input.project_path.trim().to_string();
    input.precheck = input.precheck.map(|precheck| precheck.trim().to_string()).filter(|precheck| !precheck.is_empty());
    let record = Record {
        id,
        enabled: input.enabled,
        next_run_at_ms: next_run(&input, input.enabled, now_ms),
        created_at_ms: existing.map_or(now_ms, |record| record.created_at_ms),
        updated_at_ms: now_ms,
        input,
    };
    store::write(&connection, &record)?;
    Ok(record)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn list_automations(app: tauri::AppHandle) -> Result<AutomationList, String> {
    current_list(&app).await
}

/// Looks again on one machine, or on all of them, and answers once the looks are done.
#[tauri::command]
pub(crate) async fn scan_automations(app: tauri::AppHandle, machine: Option<String>) -> Result<AutomationList, String> {
    let machines = agent_homes::machines_to_scan(&app.state::<MachineHealthState>().lock());
    let machines: Vec<_> = machines.into_iter().filter(|candidate| machine.as_deref().is_none_or(|name| candidate.name() == name)).collect();
    if machines.is_empty() {
        if let Some(name) = machine {
            return Err(shell::not_checked(&name));
        }
    }
    let scans = machines.into_iter().map(|machine| {
        let app = app.clone();
        async move { discover::scan_machine(&app, machine).await }
    });
    futures_join_all(scans).await;
    current_list(&app).await
}

/// Runs the futures side by side; each machine's look waits on its own SSH session.
async fn futures_join_all<F: std::future::Future<Output = ()> + Send + 'static>(futures: impl Iterator<Item = F>) {
    let handles: Vec<_> = futures.map(tauri::async_runtime::spawn).collect();
    for handle in handles {
        let _ = handle.await;
    }
}

#[tauri::command]
pub(crate) async fn get_automation(id: String) -> Result<Automation, String> {
    if id.starts_with(ARBOR_PREFIX) {
        let record = arbor_record(&id).await?;
        let record_id = record.id.clone();
        let summary = run_usage_task({
            let record = record.clone();
            move || {
                let connection = open_usage_database()?;
                let last = last_run(&connection, &record_id)?;
                arbor_summary_with_model(&connection, &record, last)
            }
        })
        .await?;
        return Ok(Automation { summary, ..arbor_automation(&record, None) });
    }
    let found = found_or_error(&id)?;
    run_usage_task(move || Ok(with_project(&open_usage_database()?, found)?.automation)).await
}

/// An automation's runs, or every automation's, newest first: Arbor's own, and the recent runs of a schedule someone
/// made in ultradian themselves, asked of its machine.
#[tauri::command]
pub(crate) async fn list_automation_runs(app: tauri::AppHandle, id: Option<String>, limit: Option<u32>) -> Result<Vec<AutomationRun>, String> {
    let limit = limit.unwrap_or(100) as usize;
    if let Some(item) = id.as_deref().and_then(discover::find).filter(|item| item.automation.summary.source == AutomationSource::Ultradian) {
        return udian::own_runs(&app, &item, limit).await;
    }
    run_usage_task(move || Ok(store::runs(&open_usage_database()?, id.as_deref(), limit)?.into_iter().map(|stored| stored.run).collect())).await
}

#[tauri::command]
pub(crate) async fn save_automation(app: tauri::AppHandle, input: AutomationInput) -> Result<Automation, String> {
    let record = run_usage_task(move || save_record(input)).await?;
    runner::WAKE.notify_one();
    runner::emit(&app);
    Ok(arbor_automation(&record, None))
}

#[tauri::command]
pub(crate) async fn delete_automation(app: tauri::AppHandle, id: String) -> Result<AutomationList, String> {
    if !id.starts_with(ARBOR_PREFIX) {
        return Err("Arbor can only delete its own automations. Delete this one in the app that keeps it".into());
    }
    run_usage_task(move || {
        let connection = open_usage_database()?;
        let _guard = lock_usage_writes();
        store::delete(&connection, &id)
    })
    .await?;
    runner::emit(&app);
    current_list(&app).await
}

/// Pauses or resumes an automation: Arbor's own here, another app's where that app keeps it.
#[tauri::command]
pub(crate) async fn set_automation_enabled(app: tauri::AppHandle, id: String, enabled: bool) -> Result<AutomationList, String> {
    if id.starts_with(ARBOR_PREFIX) {
        run_usage_task(move || {
            let connection = open_usage_database()?;
            let _guard = lock_usage_writes();
            let mut record = store::record(&connection, &id)?.ok_or("Arbor has no automation with that id")?;
            let now_ms = Local::now().timestamp_millis();
            record.enabled = enabled;
            record.input.enabled = enabled;
            record.next_run_at_ms = next_run(&record.input, enabled, now_ms);
            record.updated_at_ms = now_ms;
            store::write(&connection, &record)
        })
        .await?;
        runner::WAKE.notify_one();
        runner::emit(&app);
    } else {
        let item = found_or_error(&id)?;
        if !item.automation.summary.abilities.pause {
            return Err("This automation can only be paused in the app that keeps it".into());
        }
        discover::set_enabled(&app, &item, enabled).await?;
    }
    current_list(&app).await
}

/// Runs an automation now, precheck first, whatever its schedule.
#[tauri::command]
pub(crate) async fn run_automation_now(app: tauri::AppHandle, id: String) -> Result<AutomationRun, String> {
    if id.starts_with(ARBOR_PREFIX) {
        let record = arbor_record(&id).await?;
        if let Some(name) = udian::wanted_machine(&record).map(str::to_string) {
            return run_in_background_now(&app, &record, &name).await;
        }
        return runner::start_run(&app, &record, Local::now().timestamp_millis(), true).await;
    }
    let item = found_or_error(&id)?;
    discover::run_now(&app, &item).await?;
    let now_ms = Local::now().timestamp_millis();
    let mut run = runner::new_run(&id, item.automation.summary.machine.clone(), now_ms, true);
    run.started_at_ms = Some(now_ms);
    Ok(run)
}

/// Has the machine's background runner start the automation now; the run is read back as it goes.
async fn run_in_background_now(app: &tauri::AppHandle, record: &Record, machine_name: &str) -> Result<AutomationRun, String> {
    // A schedule just saved may not be on the machine yet.
    udian::reconcile(app).await?;
    let machine = shell::find_machine(&app.state::<MachineHealthState>().lock(), machine_name)?;
    let stdout = udian::call(&machine, &udian::run_now_script(&record.id)).await?;
    let answer: serde_json::Value = serde_json::from_str(stdout.trim()).map_err(|_| "The machine's background runner didn't say which run it started".to_string())?;
    let data = answer.get("data").unwrap_or(&answer);
    let run_id = data
        .get("run_id")
        .or_else(|| data.get("run").and_then(|run| run.get("run_id")))
        .and_then(serde_json::Value::as_str)
        .ok_or("The machine's background runner didn't say which run it started")?
        .to_string();
    let now_ms = Local::now().timestamp_millis();
    let mut run = runner::new_run(&record.id, Some(machine_name.to_string()), now_ms, true);
    run.id = run_id;
    run.started_at_ms = Some(now_ms);
    let stored = store::StoredRun { run: run.clone(), worktree: None };
    run_usage_task(move || {
        let connection = open_usage_database()?;
        let _guard = lock_usage_writes();
        store::write_run(&connection, &stored)
    })
    .await?;
    runner::SYNC_NOW.store(true, std::sync::atomic::Ordering::Relaxed);
    runner::WAKE.notify_one();
    runner::emit(app);
    Ok(run)
}

/// Stops a run on a machine's background runner, which ends its whole process group there.
async fn cancel_in_background(app: &tauri::AppHandle, stored: store::StoredRun) -> Result<(), String> {
    let name = stored.run.machine.clone().ok_or("Arbor doesn't know which machine that run is on")?;
    let machine = shell::find_machine(&app.state::<MachineHealthState>().lock(), &name)?;
    udian::call(&machine, &udian::cancel_script(&stored.run.id)).await?;
    let mut run = stored.run;
    run.status = AutomationRunStatus::Canceled;
    run.finished_at_ms = Some(Local::now().timestamp_millis());
    run_usage_task(move || {
        let connection = open_usage_database()?;
        let _guard = lock_usage_writes();
        store::write_run(&connection, &store::StoredRun { run, worktree: None })
    })
    .await?;
    runner::SYNC_NOW.store(true, std::sync::atomic::Ordering::Relaxed);
    runner::emit(app);
    Ok(())
}

#[tauri::command]
pub(crate) async fn cancel_automation_run(app: tauri::AppHandle, run_id: String) -> Result<AutomationRun, String> {
    let id = run_id.clone();
    let (stored, record) = run_usage_task(move || {
        let connection = open_usage_database()?;
        let stored = store::run(&connection, &id)?.ok_or("Arbor has no run with that id")?;
        let record = store::record(&connection, &stored.run.automation_id)?;
        Ok((stored, record))
    })
    .await?;
    if stored.run.status == AutomationRunStatus::Running && record.as_ref().and_then(udian::wanted_machine).is_some() {
        cancel_in_background(&app, stored).await?;
    } else {
        runner::cancel(&app, &run_id).await?;
    }
    let id = run_id.clone();
    run_usage_task(move || store::run(&open_usage_database()?, &id)).await?.map(|stored| stored.run).ok_or_else(|| "Arbor has no run with that id".to_string())
}

// ── Opening a run in Terminal ────────────────────────────────────────────────────────────────────────────────────

/// The shell line that picks up an Arbor automation's run where it left off: its agent resumed by the session id the
/// run stores, in the folder the run worked in, the run's own worktree while it's still there and the project's
/// checkout otherwise, since an agent looks for a session under the folder it ran in.
fn resume_line(record: &Record, stored: &store::StoredRun, program: &str) -> Result<String, String> {
    let session = stored.run.session_id.as_deref().ok_or("This run has no session to open")?;
    let resume = match record.input.agent.spec().launcher {
        Some(Launcher::Claude) => format!("exec {} --resume {}", shell_quote(program), shell_quote(session)),
        Some(Launcher::Codex) => format!("exec {} resume {}", shell_quote(program), shell_quote(session)),
        _ => return Err("Arbor can open Claude Code and Codex sessions in Terminal, not this agent's".into()),
    };
    let mut folders: Vec<String> = Vec::new();
    if let Some(worktree) = stored.worktree.as_deref().filter(|worktree| !worktree.is_empty()) {
        folders.push(runner::path_word(worktree));
    }
    // A run on the machine's background runner works in a worktree named for its schedule and run (`udian::run_script`).
    if record.input.workspace == AutomationWorkspace::NewWorktree && udian::wanted_machine(record).is_some() {
        folders.push(format!("\"$HOME/.arbor/automation-worktrees/\"{}/{}", shell_quote(&udian::schedule_name(&record.id)), shell_quote(&stored.run.id)));
    }
    if !record.input.project_path.is_empty() {
        folders.push(runner::path_word(&record.input.project_path));
    }
    let cd: String = folders.iter().map(|folder| format!("cd {folder} 2>/dev/null || ")).collect();
    Ok(if folders.is_empty() { resume } else { format!("{{ {cd}true; }} && {resume}") })
}

/// The shell line that picks up the agent session one of someone's own ultradian runs started, in the schedule's
/// folder, when its command starts an agent Arbor knows how to resume.
fn own_resume_line(agent: Option<Harness>, folder: Option<&str>, session: &str, program: &str) -> Option<String> {
    let resume = match agent?.spec().launcher {
        Some(Launcher::Claude) => format!("exec {} --resume {}", shell_quote(program), shell_quote(session)),
        Some(Launcher::Codex) => format!("exec {} resume {}", shell_quote(program), shell_quote(session)),
        _ => return None,
    };
    Some(match folder.filter(|folder| !folder.is_empty()) {
        Some(folder) => format!("{{ cd {} 2>/dev/null || true; }} && {resume}", runner::path_word(folder)),
        None => resume,
    })
}

/// The shell line that shows one of someone's own ultradian runs: udian's own log of it, which only they read.
fn udian_log_line(name: &str, run_id: &str) -> String {
    format!("exec {} logs {} --run {}", udian::BIN, shell_quote(name), shell_quote(run_id))
}

/// Opens a Terminal window on this Mac for an automation's run: its agent session resumed on the machine it ran on, or,
/// for one of someone's own ultradian runs that started none Arbor can resume, udian's log of it. Answers with the same
/// as one command to paste.
#[tauri::command]
pub(crate) async fn open_automation_run_in_terminal(app: tauri::AppHandle, automation_id: String, run_id: String) -> Result<String, String> {
    use super::super::agents::AgentKind;
    use super::super::fix_session::{self, agent_program, place_of, Launch};
    let launch = if automation_id.starts_with(ARBOR_PREFIX) {
        let record = arbor_record(&automation_id).await?;
        let stored = run_usage_task({
            let run_id = run_id.clone();
            move || store::run(&open_usage_database()?, &run_id)
        })
        .await?
        .filter(|stored| stored.run.automation_id == automation_id)
        .ok_or("Arbor has no run with that id for this automation")?;
        let machine = stored.run.machine.clone().ok_or("Arbor doesn't know which machine this run was on")?;
        let agent = match record.input.agent.spec().launcher {
            Some(Launcher::Claude) => AgentKind::Claude,
            Some(Launcher::Codex) => AgentKind::Codex,
            _ => return Err("Arbor can open Claude Code and Codex sessions in Terminal, not this agent's".into()),
        };
        let inner = app.state::<MachineHealthState>();
        let inner = inner.lock();
        Launch { place: place_of(&inner, &machine)?, line: resume_line(&record, &stored, &agent_program(&inner, &machine, agent))? }
    } else {
        let item = found_or_error(&automation_id)?;
        let discover::Keeper::Id(name) = &item.keeper else { return Err("Arbor can open only ultradian's runs in Terminal".into()) };
        if item.automation.summary.source != AutomationSource::Ultradian {
            return Err("Arbor can open only ultradian's runs in Terminal; open this one in the app that keeps it".into());
        }
        // The run's session comes from udian's own record of it, read again here rather than taken from the window.
        let session = udian::own_runs(&app, &item, 200).await.ok().and_then(|runs| runs.into_iter().find(|run| run.id == run_id)).and_then(|run| run.session_id);
        let inner = app.state::<MachineHealthState>();
        let inner = inner.lock();
        let place = place_of(&inner, &item.found_on)?;
        let agent = item.automation.summary.agent;
        let kind = match agent.and_then(|agent| agent.spec().launcher) {
            Some(Launcher::Claude) => Some(AgentKind::Claude),
            Some(Launcher::Codex) => Some(AgentKind::Codex),
            _ => None,
        };
        let resume = session.zip(kind).and_then(|(session, kind)| {
            own_resume_line(agent, item.automation.project_path.as_deref(), &session, &agent_program(&inner, &item.found_on, kind))
        });
        Launch { place, line: resume.unwrap_or_else(|| udian_log_line(name, &run_id)) }
    };
    fix_session::open_in_terminal(&app, &launch, "automation-run", "to open an automation's run")?;
    Ok(launch.typed())
}

/// What an Arbor automation copied from another app's starts as: its prompt and schedule, on the machine it was found
/// on, paused until the user picks a project. One whose schedule Arbor can't read (Claude keeps its tasks' schedules
/// itself) isn't copied as it is: a made-up schedule would read as the original's, so the window asks for one instead.
pub(super) fn copied_input(automation: &Automation) -> Result<AutomationInput, String> {
    let summary = &automation.summary;
    let rrule = automation
        .rrule
        .clone()
        .filter(|rule| schedule::parse(rule).is_some())
        .ok_or("Arbor can't read this automation's schedule, so it can't copy it as it is. Make a new automation from its prompt and pick a schedule")?;
    // A copy keeps its agent when Arbor can start it, with what that agent allows: one that can't be held to edits
    // runs with full access, as it did, and only Claude Code and Codex carry a session on.
    let agent = summary.agent.filter(|agent| agent.launches()).unwrap_or(Harness::Codex);
    let launcher = agent.spec().launcher;
    let limits_edits = launcher.is_none_or(Launcher::limits_edits);
    let carries_on = matches!(launcher, Some(Launcher::Claude | Launcher::Codex));
    Ok(AutomationInput {
        id: None,
        name: summary.name.clone(),
        prompt: automation.prompt.clone(),
        agent,
        model: None,
        effort: None,
        target: summary.target.clone(),
        project_path: automation.project_path.clone().unwrap_or_else(|| "~".into()),
        workspace: automation.workspace,
        session: if carries_on { automation.session } else { AutomationSession::Fresh },
        access: if limits_edits { AutomationAccess::Edits } else { AutomationAccess::Full },
        rrule: rrule.trim_start_matches("RRULE:").to_string(),
        timezone: automation.timezone.clone(),
        grace_minutes: automation.grace_minutes,
        precheck: automation.precheck.clone(),
        precheck_timeout_secs: automation.precheck_timeout_secs.clamp(1, 3600),
        runs_on: AutomationRunsOn::App,
        enabled: false,
    })
}

/// Puts the background runner Arbor carries on a machine, or updates an older one there, then looks at the machine
/// again so the page shows it ready.
#[tauri::command]
pub(crate) async fn install_background_runner(app: tauri::AppHandle, machine: String) -> Result<AutomationList, String> {
    let bundle = udian::bundle().ok_or("This build of Arbor doesn't carry the background runner")?;
    let there = discover::found()
        .get(&machine)
        .and_then(|find| find.udian.clone())
        .ok_or("Look for automations on this machine first, so Arbor knows its system")?;
    let found = shell::find_machine(&app.state::<MachineHealthState>().lock(), &machine)?;
    // A machine already on this build's runner or a newer one, with its daemon going, only needs the skill. A newer one
    // is never replaced, even stopped: an older runner refuses the database a newer one has moved on.
    let current = there.version.as_deref().is_some_and(|version| !udian::older_than_bundled(version, &bundle.version));
    if current && !there.live {
        return Err("The background runner on this machine is newer than the one Arbor carries and isn't running. Start it there with udian daemon restart".into());
    }
    if !current {
        let target = there.target.clone().ok_or("Arbor has no background runner for this machine's system")?;
        let archive = udian::archive(&bundle, &target)?;
        udian::install(&found, &archive).await?;
    }
    if let Some(skill) = bundle.skill().filter(|skill| there.skill.as_deref() != Some(super::super::guarded_writes::cksum(skill).as_str())) {
        udian::install_skill(&app, &found, &skill).await?;
    }
    discover::scan_machine(&app, found).await;
    runner::WAKE.notify_one();
    current_list(&app).await
}

#[tauri::command]
pub(crate) async fn copy_automation_into_arbor(app: tauri::AppHandle, id: String, pause_original: bool) -> Result<Automation, String> {
    let item = found_or_error(&id)?;
    if !item.automation.summary.abilities.copy {
        return Err("This automation can't be copied".into());
    }
    // A copy works where the original did, so the project Arbor can tell comes along.
    let lookup = item.clone();
    let record = run_usage_task(move || save_record(copied_input(&with_project(&open_usage_database()?, lookup)?.automation)?)).await?;
    if pause_original && item.automation.summary.enabled && item.automation.summary.abilities.pause {
        discover::set_enabled(&app, &item, false).await?;
    }
    runner::emit(&app);
    Ok(arbor_automation(&record, None))
}

/// Drafts an automation from a description with the model Settings names, through the proxy on this Mac.
#[tauri::command]
pub(crate) async fn draft_automation(
    app: tauri::AppHandle,
    input: AutomationDraftInput,
    gui_config_state: tauri::State<'_, crate::GuiConfigState>,
) -> Result<AutomationDraft, String> {
    let agents = launchable(&app);
    let config = gui_config_state.snapshot()?;
    let access = draft::CoreAccess {
        origin: crate::core_config::managed_core_loopback_origin(config.port),
        key: crate::core_config::effective_agent_api_key(&config).to_string(),
    };
    let (model, effort) = run_usage_task(|| {
        let connection = open_usage_database()?;
        Ok((store::setting(&connection, "draft_model")?, store::setting(&connection, "draft_effort")?))
    })
    .await?;
    let client = reqwest::Client::builder()
        // Loopback to the core, which a system proxy must never sit in front of.
        .no_proxy()
        .danger_accept_invalid_certs(crate::core_config::managed_core_tls_enabled())
        .build()
        .map_err(|error| format!("Couldn't set up the request: {error}"))?;
    draft::draft(
        &client,
        &access,
        model.as_deref().unwrap_or(draft::DEFAULT_MODEL),
        effort.as_deref().unwrap_or(draft::DEFAULT_EFFORT),
        &input,
        &agents,
    )
    .await
}

/// Turns running Arbor's automations on or off. Off leaves runs that are going alone.
#[tauri::command]
pub(crate) async fn set_automations_running(app: tauri::AppHandle, running: bool) -> Result<AutomationList, String> {
    run_usage_task(move || {
        let connection = open_usage_database()?;
        let _guard = lock_usage_writes();
        store::set_setting(&connection, "running", if running { "on" } else { "off" })
    })
    .await?;
    runner::WAKE.notify_one();
    runner::emit(&app);
    current_list(&app).await
}

/// Turns reading one other app's automations on or off. Off forgets what was found of it at once and leaves its part
/// out of every scan; on looks again everywhere.
#[tauri::command]
pub(crate) async fn set_automation_app_enabled(app: tauri::AppHandle, source: AutomationSource, enabled: bool) -> Result<AutomationList, String> {
    if apps::for_source(source).is_none() {
        return Err("Arbor's own automations can't be turned off here".into());
    }
    run_usage_task(move || {
        let connection = open_usage_database()?;
        let _guard = lock_usage_writes();
        store::set_app_off(&connection, source, !enabled)
    })
    .await?;
    if enabled {
        return scan_automations(app, None).await;
    }
    discover::forget_app(source);
    runner::emit(&app);
    current_list(&app).await
}

/// Sets the model that drafts automations, and its effort.
#[tauri::command]
pub(crate) async fn set_automation_draft_model(app: tauri::AppHandle, model: String, effort: String) -> Result<AutomationList, String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("Pick a model".into());
    }
    run_usage_task(move || {
        let connection = open_usage_database()?;
        let _guard = lock_usage_writes();
        store::set_setting(&connection, "draft_model", &model)?;
        store::set_setting(&connection, "draft_effort", effort.trim())
    })
    .await?;
    current_list(&app).await
}

/// Adds the client key every Claude and Codex automation reaches the proxy with, named so Usage shows their spend
/// apart. Only its fingerprint is kept here; the key itself stays in the core's list, where Settings can pause or
/// delete it. A key already there is kept.
#[tauri::command]
pub(crate) async fn add_automations_key(app: tauri::AppHandle) -> Result<AutomationList, String> {
    let fingerprint = run_usage_task(|| store::setting(&open_usage_database()?, proxy::KEY_SETTING)).await?;
    if !proxy::has_key(&app, fingerprint.as_deref()) {
        let key = proxy::new_key()?;
        crate::core_config::add_core_api_key(app.state::<crate::GuiConfigState>(), key.clone(), proxy::KEY_NAME.into())?;
        let fingerprint = crate::usage::hash_text(&key);
        run_usage_task(move || {
            let connection = open_usage_database()?;
            let _guard = lock_usage_writes();
            store::set_setting(&connection, proxy::KEY_SETTING, &fingerprint)
        })
        .await?;
    }
    // Automations placed without a key, or with an old one, are placed again with it.
    runner::WAKE.notify_one();
    runner::emit(&app);
    current_list(&app).await
}

/// Sets the address machines try first to reach the proxy, for one they can't find on their own; empty clears it.
#[tauri::command]
pub(crate) async fn set_automation_proxy_address(app: tauri::AppHandle, address: String) -> Result<AutomationList, String> {
    proxy::check_address(&address)?;
    let address = address.trim().trim_end_matches('/').to_string();
    run_usage_task(move || {
        let connection = open_usage_database()?;
        let _guard = lock_usage_writes();
        store::set_setting(&connection, proxy::ADDRESS_SETTING, &address)
    })
    .await?;
    runner::WAKE.notify_one();
    runner::emit(&app);
    current_list(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> AutomationInput {
        AutomationInput {
            id: None,
            name: "Sentry watch".into(),
            prompt: "Fix new issues.".into(),
            agent: Harness::Claude,
            model: None,
            effort: None,
            target: AutomationTarget::Machine { name: "cedar-02".into() },
            project_path: "~/code/billing".into(),
            workspace: AutomationWorkspace::Checkout,
            session: AutomationSession::Fresh,
            access: AutomationAccess::Edits,
            runs_on: AutomationRunsOn::App,
            rrule: "FREQ=HOURLY;BYMINUTE=0".into(),
            timezone: None,
            grace_minutes: 20,
            precheck: Some("true".into()),
            precheck_timeout_secs: 60,
            enabled: true,
        }
    }

    fn stored(session: Option<&str>, worktree: Option<&str>) -> store::StoredRun {
        let mut run = runner::new_run("arbor:a1", Some("cam-mbp".into()), 1, false);
        run.id = "run-1".into();
        run.session_id = session.map(str::to_string);
        store::StoredRun { run, worktree: worktree.map(str::to_string) }
    }

    fn record_with(input: AutomationInput) -> Record {
        Record { id: "arbor:a1".into(), input, enabled: true, next_run_at_ms: None, created_at_ms: 1, updated_at_ms: 1 }
    }

    #[test]
    fn a_run_resumes_in_its_worktree_then_its_checkout() {
        let mut input = input();
        input.project_path = "~/work/billing".into();
        let record = record_with(input.clone());
        let line = resume_line(&record, &stored(Some("abc-1"), Some("/tmp/wt 1")), "/opt/claude").unwrap();
        assert_eq!(line, "{ cd '/tmp/wt 1' 2>/dev/null || cd \"$HOME\"/'work/billing' 2>/dev/null || true; } && exec '/opt/claude' --resume 'abc-1'");
        assert_eq!(resume_line(&record, &stored(None, None), "claude").unwrap_err(), "This run has no session to open");

        input.agent = Harness::Codex;
        input.workspace = AutomationWorkspace::NewWorktree;
        input.runs_on = AutomationRunsOn::Machine;
        let record = record_with(input);
        let line = resume_line(&record, &stored(Some("s"), None), "codex").unwrap();
        assert!(line.contains("cd \"$HOME/.arbor/automation-worktrees/\"'arbor-a1'/'run-1' 2>/dev/null || cd \"$HOME\"/'work/billing'"), "{line}");
        assert!(line.ends_with("exec 'codex' resume 's'"));
    }

    #[test]
    fn an_ultradian_run_resumes_the_session_it_started_in_its_folder() {
        assert_eq!(
            own_resume_line(Some(Harness::Claude), Some("/home/cam/src/billing"), "6f2a1c9e", "claude").as_deref(),
            Some("{ cd '/home/cam/src/billing' 2>/dev/null || true; } && exec 'claude' --resume '6f2a1c9e'"),
        );
        assert_eq!(own_resume_line(Some(Harness::Codex), None, "019a", "/opt/codex").as_deref(), Some("exec '/opt/codex' resume '019a'"));
        assert_eq!(own_resume_line(None, None, "s", "x"), None, "a command that isn't an agent's has its log instead");
    }

    #[test]
    fn an_ultradian_run_opens_its_own_log() {
        assert_eq!(udian_log_line("it's", "run_1"), "exec \"$HOME/.ultradian/bin/udian\" logs 'it'\\''s' --run 'run_1'");
    }

    #[test]
    fn checks_what_the_dialog_sent() {
        assert!(check_input(&input()).is_ok());
        let mut best = input();
        best.target = AutomationTarget::Best;
        assert!(check_input(&best).unwrap_err().contains("machine"));
        let mut pooled = input();
        pooled.target = AutomationTarget::Pool { id: "builds".into() };
        assert!(check_input(&pooled).is_ok());
        pooled.target = AutomationTarget::Pool { id: " ".into() };
        assert!(check_input(&pooled).is_err());
        let mut monthly = input();
        monthly.rrule = "FREQ=MONTHLY;BYMONTHDAY=1".into();
        assert!(check_input(&monthly).is_err());
        let mut gemini = input();
        gemini.agent = Harness::Gemini;
        assert!(check_input(&gemini).is_err());
        // Pi never asks before a command, so it only runs with full access, and each run is fresh.
        let mut pi = input();
        pi.agent = Harness::Pi;
        pi.session = AutomationSession::Fresh;
        pi.access = AutomationAccess::Edits;
        assert!(check_input(&pi).unwrap_err().contains("full access"));
        pi.access = AutomationAccess::Full;
        assert!(check_input(&pi).is_ok());
        pi.session = AutomationSession::Reuse;
        assert!(check_input(&pi).unwrap_err().contains("fresh session"));
        let mut droid = input();
        droid.agent = Harness::Droid;
        droid.session = AutomationSession::Fresh;
        assert!(check_input(&droid).is_ok());
    }

    #[test]
    fn lists_arbor_automations_with_their_last_run_and_found_ones() {
        let connection = crate::usage::schema::test_database();
        let record = Record { id: "arbor:a".into(), input: input(), enabled: true, next_run_at_ms: Some(10), created_at_ms: 1, updated_at_ms: 1 };
        store::write(&connection, &record).unwrap();
        let mut run = runner::new_run("arbor:a", Some("cedar-02".into()), 5, false);
        run.status = AutomationRunStatus::Skipped;
        store::write_run(&connection, &store::StoredRun { run, worktree: None }).unwrap();
        let stdout = "H\t/Users/cam\nC\t/Users/cam/.codex/automations/x/automation.toml\tbmFtZSA9ICJYIgo=\n";
        let (found, _) = discover::parse_scan("cam-mbp", stdout);
        let finds = BTreeMap::from([("cam-mbp".to_string(), MachineFind { scanned_at_ms: Some(1), found, ..Default::default() })]);
        let list = list_from(&connection, &finds, &["cam-mbp".into(), "cedar-02".into()]).unwrap();
        assert_eq!(list.automations.len(), 2);
        let arbor = &list.automations[0];
        assert_eq!(arbor.project.as_deref(), Some("billing"));
        assert_eq!(arbor.last_run.as_ref().map(|run| run.status), Some(AutomationRunStatus::Skipped));
        assert_eq!(list.automations[1].source, AutomationSource::CodexApp);
        assert_eq!(list.scans.len(), 2);
        assert!(list.running);
        assert_eq!(list.draft_model, draft::DEFAULT_MODEL);
    }

    /// A proxy request of `session` to `model` with this many input tokens.
    fn request(connection: &rusqlite::Connection, key: &str, session: &str, model: &str, input_tokens: i64) {
        connection
            .execute(
                "INSERT INTO usage_events (event_key, timestamp, timestamp_ms, local_hour, model, session_id, input_tokens, created_at)
                 VALUES (?1, '2026-10-01T00:00:00Z', 1, '2026-10-01T00', ?2, ?3, ?4, '2026-10-01T00:00:00Z')",
                rusqlite::params![key, model, session, input_tokens],
            )
            .unwrap();
    }

    #[test]
    fn the_model_comes_from_the_setting_or_else_the_last_runs_session() {
        let connection = crate::usage::schema::test_database();
        let record = Record { id: "arbor:a".into(), input: input(), enabled: true, next_run_at_ms: None, created_at_ms: 1, updated_at_ms: 1 };
        store::write(&connection, &record).unwrap();
        assert_eq!(arbor_summary_with_model(&connection, &record, None).unwrap().model, None);
        let mut run = runner::new_run("arbor:a", Some("cedar-02".into()), 5, false);
        run.session_id = Some("s-1".into());
        store::write_run(&connection, &store::StoredRun { run, worktree: None }).unwrap();
        // The model the session spent most on, not a side call's.
        request(&connection, "e-1", "s-1", "gpt-5.6-sol", 90_000);
        request(&connection, "e-2", "s-1", "gpt-5.6-mini", 400);
        assert_eq!(arbor_summary_with_model(&connection, &record, None).unwrap().model.as_deref(), Some("gpt-5.6-sol"));
        let mut set = record.clone();
        set.input.model = Some("claude-opus-5".into());
        assert_eq!(arbor_summary_with_model(&connection, &set, None).unwrap().model.as_deref(), Some("claude-opus-5"));

        // A Codex app automation's model is its thread's.
        request(&connection, "e-3", "t-1", "gpt-5.6-sol", 10);
        let linked = "H\t/Users/cam\nC\t/Users/cam/.codex/automations/x/automation.toml\tbmFtZSA9ICJYIgp0YXJnZXRfdGhyZWFkX2lkID0gInQtMSIK\n";
        let (found, _) = discover::parse_scan("cam-mbp", linked);
        let item = with_project(&connection, found[0].clone()).unwrap();
        assert_eq!(item.automation.summary.model.as_deref(), Some("gpt-5.6-sol"));
    }

    #[test]
    fn a_copy_starts_paused_on_the_machine_it_was_found_on() {
        let stdout = "H\t/Users/cam\nC\t/Users/cam/.codex/automations/x/automation.toml\tbmFtZSA9ICJYIgpycnVsZSA9ICJSUlVMRTpGUkVRPUhPVVJMWTtJTlRFUlZBTD0yIgo=\n";
        let (found, _) = discover::parse_scan("cam-mbp", stdout);
        let copy = copied_input(&found[0].automation).unwrap();
        assert!(!copy.enabled);
        assert_eq!(copy.rrule, "FREQ=HOURLY;INTERVAL=2");
        assert_eq!(copy.target, AutomationTarget::Machine { name: "cam-mbp".into() });
        assert_eq!(copy.agent, Harness::Codex);
    }

    #[test]
    fn a_codex_app_automation_takes_its_project_from_the_thread_it_runs_in() {
        let connection = crate::usage::schema::test_database();
        connection
            .execute(
                "INSERT INTO usage_session_transcripts (session_id, machine, agent, repo_root, main_repo) VALUES ('t-1', 'cam-mbp', 'codex', '/Users/cam/code/billing-wt', '/Users/cam/code/billing')",
                [],
            )
            .unwrap();
        // `target_thread_id = "t-1"`, and one with a thread Arbor has no transcript for.
        let linked = "H\t/Users/cam\nC\t/Users/cam/.codex/automations/x/automation.toml\tbmFtZSA9ICJYIgp0YXJnZXRfdGhyZWFkX2lkID0gInQtMSIK\n";
        let unknown = "H\t/Users/cam\nC\t/Users/cam/.codex/automations/y/automation.toml\tbmFtZSA9ICJZIgp0YXJnZXRfdGhyZWFkX2lkID0gInQtOSIK\n";
        let (mut found, _) = discover::parse_scan("cam-mbp", linked);
        found.extend(discover::parse_scan("cam-mbp", unknown).0);
        let finds = BTreeMap::from([("cam-mbp".to_string(), MachineFind { scanned_at_ms: Some(1), found: found.clone(), ..Default::default() })]);
        let list = list_from(&connection, &finds, &["cam-mbp".into()]).unwrap();
        let projects: Vec<_> = list.automations.iter().map(|item| item.project.as_deref()).collect();
        assert_eq!(projects, [Some("billing"), None]);
        let item = with_project(&connection, found[0].clone()).unwrap();
        assert_eq!(item.automation.project_path.as_deref(), Some("/Users/cam/code/billing"));
        let mut scheduled = item.automation.clone();
        scheduled.rrule = Some("FREQ=DAILY;BYHOUR=9;BYMINUTE=0".into());
        assert_eq!(copied_input(&scheduled).unwrap().project_path, "/Users/cam/code/billing");
    }

    #[test]
    fn a_copy_never_makes_up_a_schedule_it_cant_read() {
        // A Claude scheduled task: Claude keeps its schedule, so there's none to read.
        let claude = "H\t/Users/cam\nS\t/Users/cam/.claude/scheduled-tasks/notes/SKILL.md\tLS0tCm5hbWU6IG5vdGVzCi0tLQpBZGQgdGhlIG5ld2VzdCBub3Rlcy4K\n";
        let (found, _) = discover::parse_scan("cam-mbp", claude);
        assert_eq!(found[0].automation.summary.source, AutomationSource::ClaudeDesktop);
        assert!(copied_input(&found[0].automation).is_err());

        // A rule Arbor can't follow is no better than none.
        let mut garbled = found[0].automation.clone();
        garbled.rrule = Some("FREQ=SOMETIMES".into());
        assert!(copied_input(&garbled).is_err());
    }
}

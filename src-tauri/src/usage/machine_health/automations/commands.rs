//! The Automations page's commands.

use super::discover::{self, Found, MachineFind};
use super::store::{self, Record};
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
        schedule: schedule::summary(&input.rrule),
        next_run_at_ms: record.next_run_at_ms.filter(|_| record.enabled),
        last_run,
        has_precheck: input.precheck.as_deref().is_some_and(|precheck| !precheck.trim().is_empty()),
        abilities: ARBOR_ABILITIES,
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

/// A found automation with its project filled in from the session it runs in, when its app names none: the checkout
/// that session's transcript recorded, looked up by the id the app stores, never guessed from names.
fn with_project(connection: &rusqlite::Connection, mut item: Found) -> Result<Found, String> {
    let Some(session) = item.session.as_deref().filter(|_| item.automation.project_path.is_none()) else { return Ok(item) };
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
        automations.push(arbor_summary(&record, last));
    }
    for item in discover::all_found(found) {
        automations.push(with_project(connection, item)?.automation.summary);
    }
    let mut scans: Vec<AutomationScan> = found
        .iter()
        .map(|(machine, find)| AutomationScan {
            machine: machine.clone(),
            scanned_at_ms: find.scanned_at_ms,
            scanning: find.scanning,
            error: find.error.clone(),
            orca: find.orca,
        })
        .collect();
    for machine in machines.iter().filter(|machine| !found.contains_key(*machine)) {
        scans.push(AutomationScan { machine: machine.clone(), scanned_at_ms: None, scanning: false, error: None, orca: false });
    }
    scans.sort_by(|a, b| a.machine.cmp(&b.machine));
    Ok(AutomationList {
        automations,
        scans,
        running: runner::running_on(connection)?,
        draft_model: store::setting(connection, "draft_model")?.unwrap_or_else(|| draft::DEFAULT_MODEL.into()),
        draft_effort: store::setting(connection, "draft_effort")?.unwrap_or_else(|| draft::DEFAULT_EFFORT.into()),
    })
}

fn machine_names(app: &tauri::AppHandle) -> Vec<String> {
    agent_homes::machines_to_scan(&app.state::<MachineHealthState>().lock()).iter().map(|machine| machine.name().to_string()).collect()
}

async fn current_list(app: &tauri::AppHandle) -> Result<AutomationList, String> {
    let found = discover::found();
    let machines = machine_names(app);
    run_usage_task(move || list_from(&open_usage_database()?, &found, &machines)).await
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
    if !matches!(input.agent, AutomationAgent::Claude | AutomationAgent::Codex) {
        return Err("Arbor runs Claude Code and Codex automations".into());
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
        let last = run_usage_task(move || last_run(&open_usage_database()?, &record_id)).await?;
        return Ok(arbor_automation(&record, last));
    }
    let found = found_or_error(&id)?;
    run_usage_task(move || Ok(with_project(&open_usage_database()?, found)?.automation)).await
}

/// An automation's runs, or every automation's, newest first. Only Arbor's own have runs here.
#[tauri::command]
pub(crate) async fn list_automation_runs(id: Option<String>, limit: Option<u32>) -> Result<Vec<AutomationRun>, String> {
    let limit = limit.unwrap_or(100) as usize;
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
        return runner::start_run(&app, &record, Local::now().timestamp_millis(), true).await;
    }
    let item = found_or_error(&id)?;
    discover::run_now(&app, &item).await?;
    let now_ms = Local::now().timestamp_millis();
    let mut run = runner::new_run(&id, item.automation.summary.machine.clone(), now_ms, true);
    run.started_at_ms = Some(now_ms);
    Ok(run)
}

#[tauri::command]
pub(crate) async fn cancel_automation_run(app: tauri::AppHandle, run_id: String) -> Result<AutomationRun, String> {
    runner::cancel(&app, &run_id).await?;
    let id = run_id.clone();
    run_usage_task(move || store::run(&open_usage_database()?, &id)).await?.map(|stored| stored.run).ok_or_else(|| "Arbor has no run with that id".to_string())
}

/// What an Arbor automation copied from another app's starts as: its prompt and schedule, on the machine it was found
/// on, paused until the user picks a project.
pub(super) fn copied_input(automation: &Automation) -> AutomationInput {
    let summary = &automation.summary;
    let rrule = automation.rrule.clone().filter(|rule| schedule::parse(rule).is_some()).unwrap_or_else(|| "FREQ=DAILY;BYHOUR=9;BYMINUTE=0".into());
    AutomationInput {
        id: None,
        name: summary.name.clone(),
        prompt: automation.prompt.clone(),
        agent: match summary.agent {
            Some(AutomationAgent::Claude) => AutomationAgent::Claude,
            _ => AutomationAgent::Codex,
        },
        model: None,
        effort: None,
        target: summary.target.clone(),
        project_path: automation.project_path.clone().unwrap_or_else(|| "~".into()),
        workspace: automation.workspace,
        session: automation.session,
        access: AutomationAccess::Edits,
        rrule: rrule.trim_start_matches("RRULE:").to_string(),
        timezone: automation.timezone.clone(),
        grace_minutes: automation.grace_minutes,
        precheck: automation.precheck.clone(),
        precheck_timeout_secs: automation.precheck_timeout_secs.clamp(1, 3600),
        enabled: false,
    }
}

#[tauri::command]
pub(crate) async fn copy_automation_into_arbor(app: tauri::AppHandle, id: String, pause_original: bool) -> Result<Automation, String> {
    let item = found_or_error(&id)?;
    if !item.automation.summary.abilities.copy {
        return Err("This automation can't be copied".into());
    }
    // A copy works where the original did, so the project Arbor can tell comes along.
    let lookup = item.clone();
    let record = run_usage_task(move || save_record(copied_input(&with_project(&open_usage_database()?, lookup)?.automation))).await?;
    if pause_original && item.automation.summary.enabled && item.automation.summary.abilities.pause {
        discover::set_enabled(&app, &item, false).await?;
    }
    runner::emit(&app);
    Ok(arbor_automation(&record, None))
}

/// Drafts an automation from a description with the model Settings names, through the proxy on this Mac.
#[tauri::command]
pub(crate) async fn draft_automation(
    input: AutomationDraftInput,
    gui_config_state: tauri::State<'_, crate::GuiConfigState>,
) -> Result<AutomationDraft, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> AutomationInput {
        AutomationInput {
            id: None,
            name: "Sentry watch".into(),
            prompt: "Fix new issues.".into(),
            agent: AutomationAgent::Claude,
            model: None,
            effort: None,
            target: AutomationTarget::Machine { name: "cedar-02".into() },
            project_path: "~/code/billing".into(),
            workspace: AutomationWorkspace::Checkout,
            session: AutomationSession::Fresh,
            access: AutomationAccess::Edits,
            rrule: "FREQ=HOURLY;BYMINUTE=0".into(),
            timezone: None,
            grace_minutes: 20,
            precheck: Some("true".into()),
            precheck_timeout_secs: 60,
            enabled: true,
        }
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
        gemini.agent = AutomationAgent::Gemini;
        assert!(check_input(&gemini).is_err());
    }

    #[test]
    fn lists_arbor_automations_with_their_last_run_and_found_ones() {
        let connection = crate::usage::schema::test_database();
        let record = Record { id: "arbor:a".into(), input: input(), enabled: true, next_run_at_ms: Some(10), created_at_ms: 1, updated_at_ms: 1 };
        store::write(&connection, &record).unwrap();
        let mut run = runner::new_run("arbor:a", Some("cedar-02".into()), 5, false);
        run.status = AutomationRunStatus::Skipped;
        store::write_run(&connection, &store::StoredRun { run, worktree: None }).unwrap();
        let stdout = "H\t/Users/casey\nC\t/Users/casey/.codex/automations/x/automation.toml\tbmFtZSA9ICJYIgo=\n";
        let (found, _) = discover::parse_scan("casey-mbp", stdout);
        let finds = BTreeMap::from([("casey-mbp".to_string(), MachineFind { scanned_at_ms: Some(1), found, ..Default::default() })]);
        let list = list_from(&connection, &finds, &["casey-mbp".into(), "cedar-02".into()]).unwrap();
        assert_eq!(list.automations.len(), 2);
        let arbor = &list.automations[0];
        assert_eq!(arbor.project.as_deref(), Some("billing"));
        assert_eq!(arbor.last_run.as_ref().map(|run| run.status), Some(AutomationRunStatus::Skipped));
        assert_eq!(list.automations[1].source, AutomationSource::CodexApp);
        assert_eq!(list.scans.len(), 2);
        assert!(list.running);
        assert_eq!(list.draft_model, draft::DEFAULT_MODEL);
    }

    #[test]
    fn a_copy_starts_paused_on_the_machine_it_was_found_on() {
        let stdout = "H\t/Users/casey\nC\t/Users/casey/.codex/automations/x/automation.toml\tbmFtZSA9ICJYIgpycnVsZSA9ICJSUlVMRTpGUkVRPUhPVVJMWTtJTlRFUlZBTD0yIgo=\n";
        let (found, _) = discover::parse_scan("casey-mbp", stdout);
        let copy = copied_input(&found[0].automation);
        assert!(!copy.enabled);
        assert_eq!(copy.rrule, "FREQ=HOURLY;INTERVAL=2");
        assert_eq!(copy.target, AutomationTarget::Machine { name: "casey-mbp".into() });
        assert_eq!(copy.agent, AutomationAgent::Codex);
    }

    #[test]
    fn a_codex_app_automation_takes_its_project_from_the_thread_it_runs_in() {
        let connection = crate::usage::schema::test_database();
        connection
            .execute(
                "INSERT INTO usage_session_transcripts (session_id, machine, agent, repo_root, main_repo) VALUES ('t-1', 'casey-mbp', 'codex', '/Users/casey/code/billing-wt', '/Users/casey/code/billing')",
                [],
            )
            .unwrap();
        // `target_thread_id = "t-1"`, and one with a thread Arbor has no transcript for.
        let linked = "H\t/Users/casey\nC\t/Users/casey/.codex/automations/x/automation.toml\tbmFtZSA9ICJYIgp0YXJnZXRfdGhyZWFkX2lkID0gInQtMSIK\n";
        let unknown = "H\t/Users/casey\nC\t/Users/casey/.codex/automations/y/automation.toml\tbmFtZSA9ICJZIgp0YXJnZXRfdGhyZWFkX2lkID0gInQtOSIK\n";
        let (mut found, _) = discover::parse_scan("casey-mbp", linked);
        found.extend(discover::parse_scan("casey-mbp", unknown).0);
        let finds = BTreeMap::from([("casey-mbp".to_string(), MachineFind { scanned_at_ms: Some(1), found: found.clone(), ..Default::default() })]);
        let list = list_from(&connection, &finds, &["casey-mbp".into()]).unwrap();
        let projects: Vec<_> = list.automations.iter().map(|item| item.project.as_deref()).collect();
        assert_eq!(projects, [Some("billing"), None]);
        let item = with_project(&connection, found[0].clone()).unwrap();
        assert_eq!(item.automation.project_path.as_deref(), Some("/Users/casey/code/billing"));
        assert_eq!(copied_input(&item.automation).project_path, "/Users/casey/code/billing");
    }
}

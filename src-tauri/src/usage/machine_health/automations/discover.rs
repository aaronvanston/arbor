//! Finding the automations other apps keep on a machine. Each app is a module in `apps`: its part of the one scan
//! script run on each machine, how its lines are read, and what it can be asked to do.
//!
//! What comes back is what the user wrote (name, prompt, schedule, precheck) and when each last ran, never a run's
//! output.

use super::super::agent_homes::{self, machines_to_scan, HomeUse};
use super::super::agents::AGENT_ENV;
use super::super::guarded_writes::{edit_call, edit_finish, edit_outcomes, edit_start, new_stamp, run_on, ChangeKind, EditOutcome};
use super::super::shell::{find_machine, run_checked, Machine};
use super::apps::{self, Change, ScanLines};
use super::*;
use crate::usage::diagnostics::MachineOp;
use tauri::Manager;

pub(super) const SCAN_TIMEOUT: Duration = Duration::from_secs(60);

/// Where a found automation is kept, for pausing it there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Keeper {
    /// The app's file, as it was read, so a change is only made to the file as Arbor saw it.
    File { path: String, content: Vec<u8> },
    /// The app's own id for it, which its command line takes on the machine whose app was asked.
    Id(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Found {
    pub(super) automation: Automation,
    /// The machine it was found on, whose app keeps it.
    pub(super) found_on: String,
    pub(super) keeper: Keeper,
    /// The session it runs in, when its app keeps one (a Codex app automation's thread), by the id its transcript
    /// stores. Its project comes from there.
    pub(super) session: Option<String>,
}

/// One machine's last look.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct MachineFind {
    pub(super) scanned_at_ms: Option<i64>,
    pub(super) scanning: bool,
    pub(super) error: Option<String>,
    /// The apps there: their command line answered, or their automations were found.
    pub(super) apps: Vec<AutomationSource>,
    pub(super) found: Vec<Found>,
    /// The background runner there, once a look got that far.
    pub(super) udian: Option<UdianOnMachine>,
}

// Lines out: `H home`, then each app's own, then the background runner's probe.
fn scan_script(machine: &str) -> String {
    let parts: String = apps::APPS.iter().map(|app| app.script()).collect();
    format!(
        "{AGENT_ENV}{homes}\
         printf 'H\\t%s\\n' \"$HOME\"\n\
         homes=$(agent_homes)\n\
         {parts}{probe}",
        probe = udian::PROBE_SCRIPT,
        homes = agent_homes::shell_function(machine, HomeUse::Sync),
    )
}

pub(super) async fn scan(machine: &Machine) -> MachineFind {
    let scanned_at_ms = Local::now().timestamp_millis();
    match run_checked(machine, MachineOp::AutomationScan, &scan_script(machine.name()), SCAN_TIMEOUT).await {
        Ok(stdout) => {
            let (found, apps) = parse_scan(machine.name(), &stdout);
            MachineFind { scanned_at_ms: Some(scanned_at_ms), scanning: false, error: None, apps, found, udian: udian::parse_probe(&stdout) }
        }
        Err(error) => MachineFind { scanned_at_ms: Some(scanned_at_ms), scanning: false, error: Some(error), ..Default::default() },
    }
}

/// What a machine's scan found, and the apps that are there.
pub(super) fn parse_scan(machine: &str, stdout: &str) -> (Vec<Found>, Vec<AutomationSource>) {
    let scan = ScanLines::new(machine, stdout);
    let mut found = Vec::new();
    let mut there = Vec::new();
    for app in apps::APPS {
        if let Some(items) = app.parse(&scan.only(app.tags())) {
            there.push(app.source());
            found.extend(items);
        }
    }
    (found, there)
}

// ── What was found ───────────────────────────────────────────────────────────────────────────────────────────────

/// Each machine's last look, kept while Arbor is open. Nothing found is saved: it's the other apps' to keep.
pub(super) static FOUND: Mutex<BTreeMap<String, MachineFind>> = Mutex::new(BTreeMap::new());
/// How often each machine is looked at again in the background.
const RESCAN_MS: i64 = 30 * 60_000;

pub(super) fn found() -> BTreeMap<String, MachineFind> {
    FOUND.lock().map(|found| found.clone()).unwrap_or_default()
}

/// Looks on one machine and keeps what it found.
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

/// Every found automation once. An app's command line on more than one machine can list the same automations (Orca's
/// without their runs or projects on another machine, Superset's for the whole organization on each), so of the
/// copies the one that knows most is kept.
pub(super) fn all_found(found: &BTreeMap<String, MachineFind>) -> Vec<Found> {
    let knows = |item: &Found| usize::from(item.automation.summary.last_run.is_some()) + usize::from(item.automation.summary.project.is_some());
    let mut order: Vec<String> = Vec::new();
    let mut best: BTreeMap<String, Found> = BTreeMap::new();
    for item in found.values().flat_map(|find| find.found.iter()) {
        let id = item.automation.summary.id.clone();
        match best.get(&id) {
            Some(kept) if knows(kept) >= knows(item) => {}
            Some(_) => {
                best.insert(id, item.clone());
            }
            None => {
                order.push(id.clone());
                best.insert(id, item.clone());
            }
        }
    }
    order.into_iter().filter_map(|id| best.remove(&id)).collect()
}

pub(super) fn find(id: &str) -> Option<Found> {
    all_found(&found()).into_iter().find(|item| item.automation.summary.id == id)
}

/// Pauses or resumes a found automation in the app that keeps it: a file through a guarded write, which Sync ›
/// Arbor's changes can undo, or the app's command line.
pub(super) async fn set_enabled(app: &tauri::AppHandle, item: &Found, enabled: bool) -> Result<(), String> {
    let keeper = apps::for_source(item.automation.summary.source).ok_or("Arbor keeps this automation itself")?;
    let machine = find_machine(&app.state::<MachineHealthState>().lock(), &item.found_on)?;
    match keeper.set_enabled(item, enabled)? {
        Change::Edit(edit) => {
            let script = format!("{}{}{}", edit_start(&new_stamp(), ChangeKind::Automations), edit_call(0, &edit), edit_finish());
            let stdout = run_on(&machine, MachineOp::AutomationChange, &script).await?;
            match edit_outcomes(&stdout).get(&0) {
                Some(EditOutcome::Done) => {}
                Some(EditOutcome::Changed) => return Err(format!("{} changed this automation since Arbor looked. Refresh and try again", capitalized(keeper.name()))),
                _ => return Err(format!("Arbor couldn't change {}'s file", keeper.name())),
            }
        }
        Change::Script(script) => {
            run_checked(&machine, MachineOp::AutomationChange, &script, SCAN_TIMEOUT).await?;
        }
    }
    scan_machine(app, machine).await;
    Ok(())
}

fn capitalized(name: &str) -> String {
    let mut chars = name.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// Runs a found automation now, where its app can be asked to.
pub(super) async fn run_now(app: &tauri::AppHandle, item: &Found) -> Result<(), String> {
    let keeper = apps::for_source(item.automation.summary.source).ok_or("Arbor keeps this automation itself")?;
    let script = keeper.run_now(item)?;
    let machine = find_machine(&app.state::<MachineHealthState>().lock(), &item.found_on)?;
    run_checked(&machine, MachineOp::AutomationChange, &script, SCAN_TIMEOUT).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    fn b64(text: &str) -> String {
        STANDARD.encode(text)
    }

    #[test]
    fn each_app_reads_its_own_lines_and_says_it_is_there() {
        let stdout = format!(
            "H\t/Users/casey\nC\t/Users/casey/.codex/automations/x/automation.toml\t{}\nS\t/Users/casey/.claude/scheduled-tasks/notes/SKILL.md\t{}\nSL\t{}\n",
            b64("name = \"X\"\n"),
            b64("Add the newest notes to the wiki.\n"),
            b64("[]"),
        );
        let (found, there) = parse_scan("casey-mbp", &stdout);
        assert_eq!(found.iter().map(|item| item.automation.summary.source).collect::<Vec<_>>(), [AutomationSource::CodexApp, AutomationSource::ClaudeDesktop]);
        assert_eq!(there, [AutomationSource::CodexApp, AutomationSource::ClaudeDesktop, AutomationSource::Superset]);
        assert_eq!(parse_scan("casey-mbp", "H\t/Users/casey\n"), (Vec::new(), Vec::new()));
    }

    #[test]
    fn of_two_machines_listing_one_orca_the_copy_with_runs_is_kept() {
        let list = r#"{"result":{"automations":[{"id":"a-1","name":"Repo audit","prompt":"p","rrule":"FREQ=HOURLY;BYMINUTE=0","enabled":true}]}}"#;
        let runs = r#"{"a-1":{"status":"completed","at":5}}"#;
        let bare = parse_scan("alpha-01", &format!("O\t{}\n", b64(list))).0;
        let full = parse_scan("zulu-02", &format!("O\t{}\nR\t{}\n", b64(list), b64(runs))).0;
        let finds = BTreeMap::from([
            ("alpha-01".to_string(), MachineFind { found: bare, ..Default::default() }),
            ("zulu-02".to_string(), MachineFind { found: full, ..Default::default() }),
        ]);
        let all = all_found(&finds);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].found_on, "zulu-02");
        assert!(all[0].automation.summary.last_run.is_some());
    }

    #[test]
    fn the_scan_holds_every_apps_part_and_the_probe() {
        let script = scan_script("casey-mbp");
        assert!(script.contains("orca automations list --json </dev/null"));
        assert!(script.contains("superset automations list --json </dev/null"));
        assert!(script.contains("automations/*/automation.toml"));
        assert!(script.contains("scheduled-tasks/*/SKILL.md"));
        assert!(script.contains(udian::PROBE_SCRIPT));
    }

    #[test]
    fn the_scan_runs_with_no_app_on_the_machine() {
        // Under sh, with the scan's own helpers and no apps' command lines, only the home line comes out.
        let parts: String = apps::APPS.iter().map(|app| app.script()).collect();
        let script = format!("tab=$(printf '\\t')\nhomes=$(printf 'codex\\t%s/none\\n' \"$HOME\")\nprintf 'H\\t%s\\n' \"$HOME\"\n{parts}");
        let output = std::process::Command::new("sh").arg("-c").arg(script).env_clear().env("HOME", "/nonexistent").env("PATH", "/usr/bin:/bin").output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(String::from_utf8_lossy(&output.stdout), "H\t/nonexistent\n");
    }
}

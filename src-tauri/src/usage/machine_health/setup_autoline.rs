//! Brings machines in line with the setup repo by themselves, for what can be undone and that nobody edited.
//!
//! After the repo is pulled, after a scan lands, and when a machine answers again after being away, each machine's
//! standing is looked at. Only an item the repo moved on (`Change::Update`, so the machine still has what it had when
//! the two last matched) and that Arbor backs up before changing is applied: a file, a skill in the store, the
//! machine's hooks with their scripts, or an MCP server that differs only in Codex homes (a guarded config.toml edit).
//! Everything else waits for the user and is said once per machine: an edit made on the machine, both sides changed,
//! something the repo removed or turned off everywhere, plugins, and an MCP server a Claude Code home differs on, which
//! change through the agents' own commands with no backup. An item with no base yet (`Unknown`) waits for one and
//! isn't said, since that's every item right after Arbor starts keeping bases. Projects are never touched.
//!
//! Each run is the same guarded apply a person makes, backed up and listed in History (marked automatic here, on this
//! Mac), then rescanned so the bases are recorded. At most one run per machine every five minutes, never two at once,
//! and as many machines at once as the SSH cap lets through. A run that fails stops runs on that machine, kept on this
//! Mac with its reason across restarts, until a person's apply works there or a scan finds it in step.
//!
//! The setting `autoLineUp` (Settings › Machines › Sync) turns it off for every machine, and a machine's own value of it
//! (Sync › Overview's machine menu) for one.

use super::guarded_writes::SyncOutcome;
use super::setup_repo_keeper::repo_folder;
use super::setup_standing::{is_checksum, standing_now, BehindItem, Change, ItemDrift, MachineState, StandingKind, SyncStanding};
use super::setup::MachineSetup;
use super::setup_mcp::{McpChange, McpRegistry};
use super::setup_sync::{SyncChange, SyncFileKind};
use super::*;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;
use ts_rs::TS;

/// One run per machine at most this often.
const DEBOUNCE_MS: i64 = 5 * 60 * 1000;
const PREFERENCES: &str = "arbor.preferences.v1";
const OVERRIDES: &str = "arbor.machine-overrides.v1";
const SETTING: &str = "autoLineUp";
pub(crate) const AUTOLINE_EVENT: &str = "setup-autoline";
/// Backups automatic runs made, kept on this Mac so History can say so. The newest are enough: machines keep 20.
#[cfg_attr(test, allow(dead_code))]
const AUTO_FILE: &str = "setup-auto.json";
const AUTO_KEPT: usize = 400;

/// What a run brought in line.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppliedCounts {
    files: u32,
    skills: u32,
    hooks: u32,
    mcp: u32,
}

/// One machine, as runs by themselves see it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutoMachine {
    machine: String,
    /// Its own value says not to, from Sync › Overview's machine menu.
    paused: bool,
    running: bool,
    last_run_ms: Option<i64>,
    last_applied: Option<AppliedCounts>,
    /// Why the last run failed, which stops runs here until a person's apply works or a scan finds it in step.
    stopped: Option<String>,
    /// How many changes on it wait for the user.
    waiting: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutoLine {
    enabled: bool,
    machines: Vec<AutoMachine>,
}

/// What the window hears after a run, or when what waits on a machine changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AutoLineKind {
    Applied,
    Failed,
    Waiting,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutoLineEvent {
    machine: String,
    kind: AutoLineKind,
    applied: AppliedCounts,
    error: Option<String>,
    waiting: u32,
}

#[derive(Default)]
struct Held {
    machines: BTreeMap<String, AutoMachine>,
    /// What waited on each machine when the user was last told, so the same list isn't said every round.
    told_waiting: BTreeMap<String, Vec<String>>,
    /// Machines with a run under way: an apply on one of them now is the run's own.
    running: BTreeSet<String>,
    auto_stamps: Option<Vec<String>>,
}

static HELD: LazyLock<std::sync::Mutex<Held>> = LazyLock::new(|| std::sync::Mutex::new(Held::default()));
/// One look over the machines at a time; each run on a machine goes on by itself.
static LOOKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn held() -> std::sync::MutexGuard<'static, Held> {
    HELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// What a run applies
// ---------------------------------------------------------------------------

/// A machine's items split three ways: what a run applies, what waits for the user, and the rest (no base yet, or a
/// project), which waits quietly.
#[derive(Debug, Default, PartialEq)]
pub(super) struct Selection<'a> {
    /// Files and skills, written by the repo's sync.
    pub(super) sync: Vec<&'a BehindItem>,
    /// The machine's hooks, written together, with their scripts.
    pub(super) hooks: Vec<&'a BehindItem>,
    /// MCP servers that differ only in Codex homes.
    pub(super) mcp: Vec<&'a BehindItem>,
    pub(super) waiting: Vec<&'a BehindItem>,
}

/// Which of a machine's items a run applies. A hook edited on the machine, or one with no base, holds all its hooks
/// back, since a machine's hooks are written together.
pub(super) fn select<'a>(items: &'a [BehindItem], codex_only: &dyn Fn(&str) -> bool) -> Selection<'a> {
    let mut selection = Selection::default();
    let hooks_held = items.iter().any(|item| item.kind() == StandingKind::Hook && item.change() != Change::Update);
    for item in items {
        let needs_user = matches!(item.change(), Change::EditedHere | Change::BothChanged);
        match (item.kind(), item.change(), item.drift()) {
            (StandingKind::Project, ..) => {}
            (_, Change::Unknown, _) => {}
            _ if needs_user => selection.waiting.push(item),
            // Taking something off a machine, the repo's word for every machine, is a person's to do.
            (_, _, ItemDrift::Remove) => selection.waiting.push(item),
            // A server only Codex homes differ on is a guarded config.toml edit; Claude Code's own command keeps no backup.
            (StandingKind::Mcp, ..) if codex_only(item.key()) => selection.mcp.push(item),
            // Changed through the agents' own commands, which keep no backup.
            (StandingKind::Plugin | StandingKind::Mcp, ..) => selection.waiting.push(item),
            (StandingKind::Hook, ..) if hooks_held => {}
            (StandingKind::Hook, ..) => selection.hooks.push(item),
            (StandingKind::File | StandingKind::Skill, ..) => selection.sync.push(item),
        }
    }
    selection
}

/// The path the repo's sync writes for an item: a file's own, or a skill's folder in the store.
fn sync_path(item: &BehindItem) -> Option<String> {
    if let Some(path) = item.key().strip_prefix("file:") {
        return Some(path.to_string());
    }
    item.key().strip_prefix("skill:").map(|name| format!("~/.agents/skills/{name}"))
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

fn saved(app: &tauri::AppHandle, name: &str) -> Option<serde_json::Value> {
    app.state::<crate::saved_store::SavedStoreState>().value(name).and_then(|text| serde_json::from_str(&text).ok())
}

/// On for every machine unless switched off.
fn enabled(app: &tauri::AppHandle) -> bool {
    saved(app, PREFERENCES).and_then(|preferences| preferences.get(SETTING)?.as_bool()).unwrap_or(true)
}

/// A machine's own value, when it has one: false pauses it.
fn paused(overrides: Option<&serde_json::Value>, machine: &str) -> bool {
    overrides
        .and_then(|overrides| overrides.get(normalize_machine_name(machine))?.get(SETTING)?.as_bool())
        .is_some_and(|on| !on)
}

/// Pauses or resumes runs on `machine` by its own value, as the window's machine menu does, and tells the window.
fn set_paused(app: &tauri::AppHandle, machine: &str, pause: bool) -> Result<(), String> {
    let mut overrides = saved(app, OVERRIDES).filter(serde_json::Value::is_object).unwrap_or_else(|| serde_json::json!({}));
    let key = normalize_machine_name(machine);
    let map = overrides.as_object_mut().ok_or("Arbor can't read the machines' own settings")?;
    let own = map.entry(key.clone()).or_insert_with(|| serde_json::json!({}));
    if let Some(own) = own.as_object_mut() {
        if pause {
            own.insert(SETTING.into(), serde_json::Value::Bool(false));
        } else {
            own.remove(SETTING);
        }
    }
    if map.get(&key).and_then(serde_json::Value::as_object).is_some_and(serde_json::Map::is_empty) {
        map.remove(&key);
    }
    crate::saved_store::saved_store_set(app.clone(), app.state(), OVERRIDES.into(), Some(overrides.to_string()))
}

// ---------------------------------------------------------------------------
// Which backups were automatic
// ---------------------------------------------------------------------------

#[cfg(not(test))]
fn auto_path() -> Option<PathBuf> {
    crate::core_base_dir().ok().map(|dir| dir.join(AUTO_FILE))
}

/// Tests never write Arbor's data folder.
#[cfg(test)]
fn auto_path() -> Option<PathBuf> {
    None
}

/// What's kept on this Mac about runs by themselves: the backups they made, and the machines a failure stopped, with why.
#[derive(Debug, Default, Deserialize, PartialEq, Serialize)]
struct Kept {
    stamps: Vec<String>,
    stopped: BTreeMap<String, String>,
}

fn read_kept(path: &Path) -> Kept {
    let Some(value) = fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok()) else {
        return Kept::default();
    };
    // Before stops were kept, the file was the list of stamps alone.
    match value {
        serde_json::Value::Array(_) => Kept { stamps: serde_json::from_value(value).unwrap_or_default(), stopped: BTreeMap::new() },
        value => serde_json::from_value(value).unwrap_or_default(),
    }
}

/// Puts back what was kept, once: the stamps, and each stopped machine's reason.
fn load(held: &mut Held) {
    if held.auto_stamps.is_some() {
        return;
    }
    let kept = auto_path().map(|path| read_kept(&path)).unwrap_or_default();
    for (machine, reason) in kept.stopped {
        held.machines.entry(machine.clone()).or_insert_with(|| AutoMachine { machine, ..AutoMachine::default() }).stopped.get_or_insert(reason);
    }
    held.auto_stamps = Some(kept.stamps);
}

fn stamps(held: &mut Held) -> &mut Vec<String> {
    load(held);
    held.auto_stamps.get_or_insert_with(Vec::new)
}

/// Writes what's kept now.
fn save(held: &Held) {
    let kept = Kept {
        stamps: held.auto_stamps.clone().unwrap_or_default(),
        stopped: held.machines.iter().filter_map(|(machine, entry)| Some((machine.clone(), entry.stopped.clone()?))).collect(),
    };
    if let (Some(path), Ok(text)) = (auto_path(), serde_json::to_vec(&kept)) {
        if let Err(error) = super::archive::store::write_atomic(&path, &text) {
            eprintln!("Couldn't keep what runs by themselves did: {error}");
        }
    }
}

/// Whether the backup with `id` was made by a run by itself.
pub(super) fn is_automatic(id: &str) -> bool {
    stamps(&mut held()).iter().any(|stamp| stamp == id)
}

/// Called after any guarded apply of the repo's files or hooks has worked on `machine`: one a run made marks its
/// backups automatic; one a person made lifts a stop on runs there.
pub(super) fn applied(machine: &str, backups: &[String]) {
    let mut held = held();
    load(&mut held);
    let changed = if held.running.contains(machine) {
        let kept = stamps(&mut held);
        kept.extend(backups.iter().cloned());
        let excess = kept.len().saturating_sub(AUTO_KEPT);
        kept.drain(..excess);
        !backups.is_empty()
    } else {
        held.machines.get_mut(machine).is_some_and(|entry| entry.stopped.take().is_some())
    };
    if changed {
        save(&held);
    }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/// Looks over `only`, or every machine, for one to bring in line by itself. Nothing when it's switched off or no setup
/// repo is named.
pub(crate) fn consider(app: &tauri::AppHandle, only: Option<String>) {
    if !enabled(app) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _looking = LOOKING.lock().await;
        let Some(repo) = repo_folder(&app) else { return };
        let standing = match standing_now(&app.state::<MachineHealthState>(), &repo).await {
            Ok(standing) => standing,
            Err(error) => {
                eprintln!("Couldn't look at the machines for Sync to bring in line: {error}");
                return;
            }
        };
        look(&app, &repo, &standing, only.as_deref());
    });
}

fn look(app: &tauri::AppHandle, repo: &str, standing: &SyncStanding, only: Option<&str>) {
    let overrides = saved(app, OVERRIDES);
    let now = Local::now().timestamp_millis();
    for machine in standing.machines() {
        let name = machine.machine();
        if only.is_some_and(|only| only != name) || matches!(machine.state(), MachineState::Unreachable | MachineState::NotScanned) {
            continue;
        }
        let setup = {
            let inner = app.state::<MachineHealthState>();
            let inner = inner.lock();
            super::setup::covered_machine(&inner, name).ok().map(|(_, setup)| setup.clone())
        };
        let codex_only = |key: &str| {
            let (Some(registry), Some(setup), Some(server)) = (standing.mcp(), setup.as_ref(), key.strip_prefix("mcp:")) else { return false };
            registry.codex_changes(name, setup, server).is_some()
        };
        let selection = select(machine.behind(), &codex_only);
        let waiting: Vec<String> = selection.waiting.iter().map(|item| item.key().to_string()).collect();
        let mut tell_waiting = false;
        let go = {
            let mut held = held();
            load(&mut held);
            let pause = paused(overrides.as_ref(), name);
            let busy = held.running.contains(name);
            let entry = held.machines.entry(name.to_string()).or_insert_with(|| AutoMachine { machine: name.to_string(), ..AutoMachine::default() });
            entry.paused = pause;
            entry.waiting = waiting.len() as u32;
            // In step again, by a person's hand or otherwise: a stopped machine is let go again.
            let unstopped = machine.state() == MachineState::InStep && entry.stopped.take().is_some();
            let due = entry.last_run_ms.is_none_or(|at| now - at >= DEBOUNCE_MS);
            let go = !pause && !busy && entry.stopped.is_none() && due && !(selection.sync.is_empty() && selection.hooks.is_empty() && selection.mcp.is_empty());
            if held.told_waiting.get(name) != Some(&waiting) {
                tell_waiting = !waiting.is_empty() && !pause;
                held.told_waiting.insert(name.to_string(), waiting.clone());
            }
            if unstopped {
                save(&held);
            }
            if go {
                held.running.insert(name.to_string());
                if let Some(entry) = held.machines.get_mut(name) {
                    entry.running = true;
                    entry.last_run_ms = Some(now);
                }
            }
            go
        };
        if tell_waiting {
            let _ = app.emit(AUTOLINE_EVENT, AutoLineEvent { machine: name.to_string(), kind: AutoLineKind::Waiting, applied: AppliedCounts::default(), error: None, waiting: waiting.len() as u32 });
        }
        if go {
            let plan = plan(standing, name, &selection, app, setup.as_ref());
            let (app, repo, name) = (app.clone(), repo.to_string(), name.to_string());
            tauri::async_runtime::spawn(async move { run(&app, &repo, &name, plan).await });
        }
    }
}

/// What a run on one machine writes: the changes for the repo's sync, and whether the hooks go too.
struct Plan {
    commit: Option<String>,
    hooks_commit: Option<String>,
    mcp_commit: Option<String>,
    changes: Vec<SyncChange>,
    mcp: Vec<McpChange>,
    counts: AppliedCounts,
}

fn plan(standing: &SyncStanding, machine: &str, selection: &Selection, _app: &tauri::AppHandle, setup: Option<&MachineSetup>) -> Plan {
    let sum = |path: &str| setup.and_then(|setup| setup.sum_at(path));
    let mut counts = AppliedCounts::default();
    let mut changes: Vec<SyncChange> = selection
        .sync
        .iter()
        .filter_map(|item| {
            let path = sync_path(item)?;
            if item.kind() == StandingKind::Skill { counts.skills += 1 } else { counts.files += 1 }
            Some(SyncChange::write(&path, sum(&path)))
        })
        .collect();
    if !selection.hooks.is_empty() {
        counts.hooks = selection.hooks.len() as u32;
        // A hook runs a script the repo's sync puts in ~/.agents/hooks, so the scripts that differ go first.
        for file in standing.repo().files().iter().filter(|file| file.kind() == SyncFileKind::HookScript) {
            let there = sum(file.path());
            if there.as_deref().is_none_or(|there| there != file.print(is_checksum(there))) {
                changes.push(SyncChange::write(file.path(), there));
            }
        }
    }
    let mcp: Vec<McpChange> = match (standing.mcp(), setup) {
        (Some(registry), Some(setup)) => selection
            .mcp
            .iter()
            .filter_map(|item| registry.codex_changes(machine, setup, item.key().strip_prefix("mcp:")?))
            .flatten()
            .collect(),
        _ => Vec::new(),
    };
    counts.mcp = selection.mcp.len() as u32;
    Plan {
        commit: standing.repo().head_sha().map(str::to_string),
        hooks_commit: (!selection.hooks.is_empty()).then(|| standing.hooks_commit().map(str::to_string)).flatten(),
        mcp_commit: (!mcp.is_empty()).then(|| standing.mcp().and_then(McpRegistry::commit).map(str::to_string)).flatten(),
        changes,
        mcp,
        counts,
    }
}

async fn run(app: &tauri::AppHandle, repo: &str, machine: &str, plan: Plan) {
    let mut error = None;
    if let (Some(commit), false) = (&plan.commit, plan.changes.is_empty()) {
        match super::setup_sync::apply_setup_sync(app.clone(), app.state(), repo.to_string(), commit.clone(), machine.to_string(), plan.changes).await {
            Ok(SyncOutcome { failed, .. }) if !failed.is_empty() => {
                error = Some(failed.iter().map(|failure| format!("{} {}", failure.path, failure.reason)).collect::<Vec<_>>().join(", "));
            }
            Ok(_) => {}
            Err(failure) => error = Some(failure),
        }
    }
    if let (Some(commit), None) = (&plan.hooks_commit, &error) {
        match super::setup_hooks::apply_hooks(app.clone(), app.state(), repo.to_string(), commit.clone(), machine.to_string()).await {
            Ok(edits) => error = edits.iter().find_map(|edit| edit.error.clone()),
            Err(failure) => error = Some(failure),
        }
    }
    // Files and hooks first, as Bring in line does; then the MCP servers, each checked again on the machine.
    if let (Some(commit), None, false) = (&plan.mcp_commit, &error, plan.mcp.is_empty()) {
        match super::setup_mcp::apply_mcp_changes(app.clone(), app.state(), repo.to_string(), commit.clone(), machine.to_string(), plan.mcp).await {
            Ok(results) => error = results.iter().find(|result| result.failed()).map(|result| result.describe()),
            Err(failure) => error = Some(failure),
        }
    }
    {
        let mut held = held();
        held.running.remove(machine);
        if let Some(entry) = held.machines.get_mut(machine) {
            entry.running = false;
            if error.is_some() {
                entry.stopped = error.clone();
            } else {
                entry.last_applied = Some(plan.counts);
            }
        }
        if error.is_some() {
            save(&held);
        }
    }
    let kind = if error.is_some() { AutoLineKind::Failed } else { AutoLineKind::Applied };
    let _ = app.emit(AUTOLINE_EVENT, AutoLineEvent { machine: machine.to_string(), kind, applied: plan.counts, error, waiting: 0 });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Each machine as runs by themselves see it, and whether they're on at all.
#[tauri::command]
pub(crate) async fn get_setup_autoline(app: tauri::AppHandle) -> Result<AutoLine, String> {
    let overrides = saved(&app, OVERRIDES);
    let machines = {
        let inner = app.state::<MachineHealthState>();
        let inner = inner.lock();
        super::setup::covered_machines(&inner).into_iter().map(|(machine, _, _)| machine).collect::<Vec<_>>()
    };
    let mut held = held();
    load(&mut held);
    Ok(AutoLine {
        enabled: enabled(&app),
        machines: machines
            .into_iter()
            .map(|machine| AutoMachine {
                paused: paused(overrides.as_ref(), &machine),
                ..held.machines.get(&machine).cloned().unwrap_or_else(|| AutoMachine { machine: machine.clone(), ..AutoMachine::default() })
            })
            .collect(),
    })
}

/// Pauses runs on `machine` by themselves, or resumes them, as Sync › Overview's machine menu does.
#[tauri::command]
pub(crate) async fn set_setup_autoline_paused(app: tauri::AppHandle, machine: String, paused: bool) -> Result<AutoLine, String> {
    set_paused(&app, &machine, paused)?;
    if !paused {
        consider(&app, Some(machine));
    }
    get_setup_autoline(app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(kind: StandingKind, key: &str, drift: ItemDrift, change: Change) -> BehindItem {
        BehindItem::for_test(kind, key, drift, change)
    }

    fn keys(items: &[&BehindItem]) -> Vec<String> {
        items.iter().map(|item| item.key().to_string()).collect()
    }

    #[test]
    fn a_run_applies_only_what_the_repo_moved_on_and_arbor_can_undo() {
        use {Change::{BothChanged, EditedHere, Unknown}, ItemDrift::{Add, Remove}, StandingKind::*};
        let items = [
            item(File, "file:~/.claude/CLAUDE.md", ItemDrift::Update, Change::Update),
            item(Skill, "skill:pdf", Add, Change::Update),
            item(File, "file:~/.claude/rules/mine.md", ItemDrift::Update, EditedHere),
            item(Skill, "skill:both", ItemDrift::Update, BothChanged),
            item(File, "file:~/.claude/rules/new.md", Add, Unknown),
            item(File, "file:~/.claude/rules/old.md", Remove, Change::Update),
            item(Plugin, "plugin:claude:paper@paper", ItemDrift::Update, Change::Update),
            item(Mcp, "mcp:linear", Add, Change::Update),
            item(Mcp, "mcp:codex-only", ItemDrift::Update, Change::Update),
            item(Hook, "hook:repo:guard", ItemDrift::Update, Change::Update),
            item(Project, "project:cam/arbor", ItemDrift::Update, Change::Update),
        ];
        let selection = select(&items, &|key| key == "mcp:codex-only");
        assert_eq!(keys(&selection.sync), ["file:~/.claude/CLAUDE.md", "skill:pdf"]);
        assert_eq!(keys(&selection.hooks), ["hook:repo:guard"]);
        assert_eq!(keys(&selection.mcp), ["mcp:codex-only"], "a server only Codex homes differ on is a guarded edit");
        assert_eq!(keys(&selection.waiting), ["file:~/.claude/rules/mine.md", "skill:both", "file:~/.claude/rules/old.md", "plugin:claude:paper@paper", "mcp:linear"]);
    }

    #[test]
    fn one_hook_edited_there_or_with_no_base_holds_back_the_machines_hooks() {
        use {ItemDrift::*, StandingKind::*};
        let edited = [item(Hook, "hook:repo:guard", Update, Change::Update), item(Hook, "hook:repo:notify", Update, Change::EditedHere)];
        let selection = select(&edited, &|_| false);
        assert!(selection.hooks.is_empty());
        assert_eq!(keys(&selection.waiting), ["hook:repo:notify"]);
        let unknown = [item(Hook, "hook:repo:guard", Update, Change::Update), item(Hook, "hook:repo:notify", Add, Change::Unknown)];
        let selection = select(&unknown, &|_| false);
        assert!(selection.hooks.is_empty() && selection.waiting.is_empty(), "no base yet waits quietly");
    }

    #[test]
    fn a_stop_and_its_reason_are_kept_and_an_older_file_of_stamps_still_reads() {
        let path = std::env::temp_dir().join(format!("arbor-setup-auto-{}.json", std::process::id()));
        let kept = Kept { stamps: vec!["20261008T010203Z-ab12".into()], stopped: BTreeMap::from([("cedar-02".to_string(), "~/.claude/CLAUDE.md changed".to_string())]) };
        fs::write(&path, serde_json::to_vec(&kept).unwrap()).unwrap();
        assert_eq!(read_kept(&path), kept);
        fs::write(&path, r#"["20261008T010203Z-ab12"]"#).unwrap();
        assert_eq!(read_kept(&path), Kept { stamps: vec!["20261008T010203Z-ab12".into()], stopped: BTreeMap::new() });
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_skill_goes_to_the_store_and_a_file_to_its_own_path() {
        assert_eq!(sync_path(&item(StandingKind::Skill, "skill:pdf", ItemDrift::Add, Change::Update)).as_deref(), Some("~/.agents/skills/pdf"));
        assert_eq!(sync_path(&item(StandingKind::File, "file:~/.codex/AGENTS.md", ItemDrift::Update, Change::Update)).as_deref(), Some("~/.codex/AGENTS.md"));
        assert_eq!(sync_path(&item(StandingKind::Hook, "hook:repo:guard", ItemDrift::Update, Change::Update)), None);
    }

    #[test]
    fn a_machines_own_value_pauses_it_and_a_run_marks_its_backups_automatic() {
        let overrides = serde_json::json!({ "cammbp": { "autoLineUp": false }, "ci01": { "autoLineUp": true } });
        assert!(paused(Some(&overrides), "cam-mbp"));
        assert!(!paused(Some(&overrides), "ci-01"));
        assert!(!paused(None, "cam-mbp"));

        let mut held = Held { auto_stamps: Some(Vec::new()), ..Held::default() };
        held.running.insert("cam-mbp".into());
        held.machines.insert("ci-01".into(), AutoMachine { machine: "ci-01".into(), stopped: Some("changed".into()), ..AutoMachine::default() });
        *HELD.lock().unwrap() = held;
        applied("cam-mbp", &["20261008T010203Z-ab12".into()]);
        assert!(is_automatic("20261008T010203Z-ab12"));
        // A person's apply on a stopped machine lets it go again, and isn't automatic.
        applied("ci-01", &["20261008T010204Z-cd34".into()]);
        assert!(!is_automatic("20261008T010204Z-cd34"));
        assert_eq!(HELD.lock().unwrap().machines["ci-01"].stopped, None);
    }
}

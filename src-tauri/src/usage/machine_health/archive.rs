//! The session archive: a byte-for-byte copy of every agent session
//! transcript, every version of it, kept in a store on another drive.
//!
//! The store (chunks, journal, growing tails) is a folder the user picks on
//! another drive. The index, archive.db, lives in the app's own folder with
//! the authoritative copies of the growing tails. Every few minutes a pass
//! lists this Mac's agent homes and keeps whatever changed, then does the same
//! for each machine on the Machines page over SSH (see `remote`). Nothing is written
//! to a store until its store.json, mount point and disk say it's the one
//! Arbor was set up with; while it's away, passes wait. After a pass has
//! kept everything, it takes in old backups the user chose (see `imports`)
//! and counts the tokens in what's new (see `tokens`).

pub(crate) mod chunker;
pub(crate) mod classify;
pub(crate) mod codec;
pub(crate) mod identity;
pub(crate) mod imports;
pub(crate) mod index;
pub(crate) mod ingest;
pub(crate) mod journal;
pub(crate) mod layouts;
pub(crate) mod lister;
pub(crate) mod recovered;
pub(crate) mod remote;
pub(crate) mod sha;
pub(crate) mod store;
pub(crate) mod tokens;

use super::*;
use std::collections::HashSet;
use ts_rs::TS;
use self::ingest::{PassOptions, PassReport, Places};
use self::store::{check_folder, FolderCheck, FolderKind, Store};
use tauri_plugin_opener::OpenerExt;

const INDEX_DIR_NAME: &str = "session-archive";
const FIRST_PASS_AFTER: Duration = Duration::from_secs(60);
const PASS_EVERY: Duration = Duration::from_secs(5 * 60);
/// When a pass stopped at its share, the next starts this soon.
const CATCH_UP_AFTER: Duration = Duration::from_secs(5);
const PASS_MAX_BYTES: u64 = 2 << 30;
const PASS_MAX_TIME: Duration = Duration::from_secs(3 * 60);
/// Each other machine's homes are kept after this Mac's, in a share of their own.
const FLEET_MAX_BYTES: u64 = 1 << 30;
const FLEET_MAX_TIME: Duration = Duration::from_secs(2 * 60);
/// Old backups are taken in, after the machines' homes, in shares of their own.
const IMPORT_MAX_BYTES: u64 = 2 << 30;
const IMPORT_MAX_TIME: Duration = Duration::from_secs(3 * 60);
/// Counting tokens reads back from the store, in shares of its own.
const COUNT_MAX_BYTES: u64 = 2 << 30;
const COUNT_MAX_TIME: Duration = Duration::from_secs(2 * 60);
const READ_RATE: u64 = 100_000_000;
const GENTLE_READ_RATE: u64 = 30_000_000;
const LIST_TIMEOUT: Duration = Duration::from_secs(120);
const RUNS_KEPT_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    root: Option<String>,
    mount_point: Option<String>,
    paused: bool,
    gentle: bool,
    /// Only this Mac's homes are kept, not the other machines': the All machines value, which a
    /// machine's own value below overrides.
    skip_other_machines: bool,
    /// Machines kept (true) or skipped (false) whatever All machines says, by normalized name.
    machines: BTreeMap<String, bool>,
    /// Projects kept or skipped whatever their machine says, by lowercase `owner/name`.
    projects: BTreeMap<String, ArchiveProjectKeep>,
}

/// A project's own values: on every machine, and on one machine (by normalized name), which wins.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ArchiveProjectKeep {
    all: Option<bool>,
    machines: BTreeMap<String, bool>,
}

impl ArchiveProjectKeep {
    fn at(&self, machine: &str) -> Option<bool> {
        self.machines.get(&normalize_machine_name(machine)).copied().or(self.all)
    }

    fn is_empty(&self) -> bool {
        self.all.is_none() && self.machines.is_empty()
    }
}

/// Which of a machine's sessions a pass keeps: all but `except`, or (when the machine itself isn't
/// kept) only `except`. A session whose project isn't known yet, and a home's other files, follow
/// the machine.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct SessionFilter {
    pub(crate) keep_rest: bool,
    pub(crate) except: HashSet<String>,
}

impl SessionFilter {
    pub(crate) fn everything() -> Self {
        Self { keep_rest: true, except: HashSet::new() }
    }

    pub(crate) fn keeps(&self, session_id: Option<&str>) -> bool {
        self.keep_rest != session_id.is_some_and(|id| self.except.contains(id))
    }
}

impl Settings {
    /// Whether another machine's homes are kept: its own value, else All machines'.
    fn keeps(&self, machine: &str) -> bool {
        self.machines.get(&normalize_machine_name(machine)).copied().unwrap_or(!self.skip_other_machines)
    }

    /// Whether any other machine could be kept, so a pass lists them at all.
    fn keeps_any(&self) -> bool {
        !self.skip_other_machines || self.machines.values().any(|keep| *keep) || self.projects.values().any(|project| project.all == Some(true) || project.machines.values().any(|keep| *keep))
    }

    /// Whether a pass lists `machine` at all: it's kept, or a project on it is.
    fn lists(&self, machine: &str) -> bool {
        self.keeps(machine) || self.projects.values().any(|project| project.at(machine) == Some(true))
    }

    /// Which of `machine`'s sessions are kept, from each session's repository as usage.db has it
    /// (`sessions`: session id, machine, `owner/name`). Nearest wins: the project on the machine,
    /// the project, then the machine (this Mac always).
    fn session_filter(&self, machine: &str, this_mac: bool, sessions: &[(String, String, String)]) -> SessionFilter {
        let keep_rest = this_mac || self.keeps(machine);
        if self.projects.is_empty() {
            return SessionFilter { keep_rest, except: HashSet::new() };
        }
        let key = normalize_machine_name(machine);
        let except = sessions
            .iter()
            .filter(|(_, on, _)| normalize_machine_name(on) == key)
            .filter(|(_, _, repository)| self.projects.get(&repository.to_ascii_lowercase()).and_then(|project| project.at(machine)).is_some_and(|keep| keep != keep_rest))
            .map(|(id, _, _)| id.to_ascii_lowercase())
            .collect();
        SessionFilter { keep_rest, except }
    }
}

/// Every session usage.db knows a repository for: its id, machine and `owner/name`. Only read when
/// a project has a value of its own.
fn project_sessions() -> Result<Vec<(String, String, String)>, String> {
    let db = crate::usage::open_usage_database()?;
    let mut statement = db
        .prepare("SELECT session_id, machine, repository_url FROM usage_session_transcripts WHERE repository_url != ''")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
        .map_err(|error| error.to_string())?;
    let mut sessions = Vec::new();
    for row in rows {
        let (id, machine, url) = row.map_err(|error| error.to_string())?;
        if let Some(repository) = super::transcripts::repository_name(&url) {
            sessions.push((id, machine, repository));
        }
    }
    Ok(sessions)
}

#[derive(Default)]
struct Runtime {
    running: bool,
    last_pass_at: Option<i64>,
    next_pass_at: Option<i64>,
    last_complete: bool,
    last_error: Option<String>,
    /// When passes started failing, for as long as they keep failing. Not kept across restarts.
    failing_since: Option<i64>,
}

#[derive(Default)]
pub(crate) struct ArchiveState {
    runtime: Mutex<Runtime>,
    wake: tokio::sync::Notify,
}

impl ArchiveState {
    fn runtime(&self) -> std::sync::MutexGuard<'_, Runtime> {
        self.runtime.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn index_dir() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join(INDEX_DIR_NAME))
}

fn make_private_dir(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().recursive(true).mode(0o700).create(path).map_err(|error| format!("Couldn't make {}: {error}", path.display()))
}

fn open_index(dir: &Path) -> Result<Connection, String> {
    make_private_dir(dir)?;
    make_private_dir(&dir.join("pending"))?;
    index::open(&dir.join("archive.db"))
}

fn settings(db: &Connection) -> Result<Settings, String> {
    Ok(index::get_meta(db, "settings")?.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default())
}

fn save_settings(db: &Connection, settings: &Settings) -> Result<(), String> {
    let _writes = index::lock_writes();
    index::set_meta(db, "settings", &serde_json::to_string(settings).map_err(|error| error.to_string())?)
}

fn device(path: &Path) -> Option<u64> {
    store::volume(path).dev
}

/// Why the store can't be written to right now, as the status names it.
#[derive(Debug, PartialEq, Eq)]
enum Away {
    Missing,
    Foreign,
}

/// Opens the store Arbor was set up with, after checking it is that store: the same archive,
/// on the same mount point, and not on the disk the index is on.
fn open_main(settings: &Settings, archive_id: &str, index_dev: Option<u64>) -> Result<Store, (Away, String)> {
    let root = settings.root.as_deref().map(PathBuf::from).ok_or((Away::Missing, "No archive folder is set".to_string()))?;
    let check = check_folder(&root, index_dev);
    match check.kind {
        FolderKind::Archive if check.archive_id.as_deref() == Some(archive_id) => {}
        FolderKind::Archive | FolderKind::NotEmpty => return Err((Away::Foreign, "The archive folder holds a different archive".into())),
        _ => return Err((Away::Missing, "The archive's drive isn't connected".into())),
    }
    if settings.mount_point.is_some() && check.mount_point != settings.mount_point {
        return Err((Away::Foreign, "A different drive is where the archive's drive was".into()));
    }
    if index_dev.is_some() && device(&root) == index_dev {
        return Err((Away::Foreign, "The archive folder is on this Mac's own disk".into()));
    }
    Store::open(&root, archive_id).map_err(|error| (Away::Foreign, error))
}

/// The name this Mac's sources are filed under, kept the same once chosen.
fn this_machine(app: &tauri::AppHandle, db: &Connection) -> Result<String, String> {
    if let Some(name) = index::get_meta(db, "thisMachine")? {
        return Ok(name);
    }
    let name = {
        let state = app.state::<MachineHealthState>();
        let inner = state.lock();
        inner.series.values().find(|series| series.local && series.host.enabled).map(|series| series.host.machine.clone()).or_else(|| inner.local_names.first().cloned()).unwrap_or_else(|| "this-mac".into())
    };
    let _writes = index::lock_writes();
    index::set_meta(db, "thisMachine", &name)?;
    Ok(name)
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "ArchiveStore")]
pub(crate) struct StoreStatus {
    root: String,
    /// The drive is plugged in and the folder holds this archive.
    connected: bool,
    mount_point: Option<String>,
    free_bytes: Option<u64>,
    /// The drive doesn't enforce owners and modes, so anyone on the Mac can read it.
    noowners: bool,
    /// The last time a pass reached the store, which says how long a missing drive has been away.
    last_seen_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "ArchiveSource")]
pub(crate) struct SourceStatus {
    machine: String,
    /// The agent home, with the home folder as `~`.
    label: String,
    agent: String,
    files: u64,
    kept: u64,
    gone: u64,
    /// Claude Code's cleanupPeriodDays for the home, when it sets one.
    retention_days: Option<u32>,
}

/// How keeping another machine's sessions went last time.
#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "ArchiveMachineRun")]
pub(crate) struct MachineRun {
    machine: String,
    at: i64,
    /// Everything it listed was kept.
    complete: bool,
    /// Why it couldn't be listed or read, when it couldn't.
    error: Option<String>,
    /// The last time it went without an error.
    last_ok_at: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "ArchiveTotals")]
pub(crate) struct Totals {
    sessions: u64,
    versions: u64,
    files: u64,
    stored_bytes: u64,
    raw_bytes: u64,
    growing: u64,
    pending_bytes: u64,
}

/// Where the archive stands, as the status names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ArchiveCondition {
    /// No archive is set up.
    Off,
    Ok,
    /// The last pass didn't get through everything.
    CatchingUp,
    Paused,
    MainMissing,
    Foreign,
    Error,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveStatus {
    state: ArchiveCondition,
    archive_id: Option<String>,
    main: Option<StoreStatus>,
    sources: Vec<SourceStatus>,
    /// The other machines' last passes.
    machines: Vec<MachineRun>,
    /// Old backups taken in, or being taken in.
    imports: Vec<imports::ImportStatus>,
    totals: Totals,
    running: bool,
    last_pass_at: Option<i64>,
    next_pass_at: Option<i64>,
    last_error: Option<String>,
    /// When passes started failing, while they still are; since Arbor started at the earliest.
    failing_since: Option<i64>,
    paused: bool,
    gentle: bool,
    /// The other machines on the Machines page are kept too: the All machines value.
    other_machines: bool,
    /// Machines with a value of their own, by normalized name: kept (true) or skipped (false).
    machine_overrides: BTreeMap<String, bool>,
    /// Projects with a value of their own, by lowercase `owner/name`.
    project_overrides: BTreeMap<String, ArchiveProjectKeep>,
    /// noowners: the drive doesn't enforce who can read the archive.
    warnings: Vec<&'static str>,
}

fn count(db: &Connection, sql: &str) -> Result<u64, String> {
    db.query_row(sql, [], |row| row.get::<_, Option<i64>>(0)).map(|value| value.unwrap_or(0).max(0) as u64).map_err(|error| error.to_string())
}

fn totals(db: &Connection) -> Result<Totals, String> {
    Ok(Totals {
        sessions: count(db, "SELECT COUNT(*) FROM sessions WHERE agent != 'side'")?,
        versions: count(db, "SELECT COUNT(*) FROM versions")?,
        files: count(db, "SELECT COUNT(*) FROM files WHERE version_id IS NOT NULL")?,
        stored_bytes: count(db, "SELECT SUM(zlen) FROM chunks")?,
        raw_bytes: count(db, "SELECT SUM(len) FROM chunks")?,
        growing: count(db, "SELECT COUNT(*) FROM versions WHERE state = 'growing'")?,
        pending_bytes: count(db, "SELECT SUM(tail_len) FROM versions WHERE state = 'growing'")?,
    })
}

fn sources(db: &Connection) -> Result<Vec<SourceStatus>, String> {
    let mut statement = db
        .prepare(
            "SELECT s.machine, s.label, s.agent, s.retention_days,
               COUNT(f.file_id) FILTER (WHERE f.state IN ('live', 'unreachable')),
               COUNT(f.file_id) FILTER (WHERE f.state IN ('live', 'unreachable') AND f.version_id IS NOT NULL),
               COUNT(f.file_id) FILTER (WHERE f.state = 'gone')
             FROM sources s LEFT JOIN files f USING (source_id) WHERE s.kind = 'home' GROUP BY s.source_id ORDER BY s.machine, s.label",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(SourceStatus {
                machine: row.get(0)?,
                label: row.get(1)?,
                agent: row.get(2)?,
                retention_days: row.get::<_, Option<i64>>(3)?.and_then(|days| u32::try_from(days).ok()),
                files: row.get::<_, i64>(4)? as u64,
                kept: row.get::<_, i64>(5)? as u64,
                gone: row.get::<_, i64>(6)? as u64,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|error| error.to_string())
}

/// Each machine's last pass, other than this Mac's, which the status row speaks for.
fn machine_runs(db: &Connection) -> Result<Vec<MachineRun>, String> {
    let this = index::get_meta(db, "thisMachine")?.unwrap_or_default();
    let mut statement = db
        .prepare(
            "SELECT r.machine, COALESCE(r.finished_at, r.started_at), COALESCE(r.complete, 0), r.error,
               (SELECT MAX(o.finished_at) FROM runs o WHERE o.machine = r.machine AND o.error IS NULL)
             FROM runs r WHERE r.run_id IN (SELECT MAX(run_id) FROM runs GROUP BY machine) AND r.machine != ?1 ORDER BY r.machine",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([this], |row| Ok(MachineRun { machine: row.get(0)?, at: row.get(1)?, complete: row.get::<_, i64>(2)? != 0, error: row.get(3)?, last_ok_at: row.get(4)? }))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|error| error.to_string())
}

fn main_last_seen(db: &Connection) -> Result<Option<i64>, String> {
    let Some(store_id) = index::get_meta(db, "mainStoreId")? else {
        return Ok(None);
    };
    db.query_row("SELECT last_seen_at FROM stores WHERE store_id = ?1", [store_id], |row| row.get::<_, Option<i64>>(0))
        .optional()
        .map(Option::flatten)
        .map_err(|error| error.to_string())
}

/// Notes that a pass reached the main store, so a missing drive can say since when.
fn saw_main(db: &Connection, store: &Store, at: i64) -> Result<(), String> {
    let _writes = index::lock_writes();
    db.execute("UPDATE stores SET last_seen_at = ?1 WHERE store_id = ?2", params![at, store.info().store_id])
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn status_from(db: &Connection, runtime: &Runtime, index_dev: Option<u64>) -> Result<ArchiveStatus, String> {
    let settings = settings(db)?;
    let archive_id = index::get_meta(db, "archiveId")?;
    let last_seen_at = main_last_seen(db)?;
    let main = settings.root.as_ref().map(|root| {
        let check = check_folder(Path::new(root), None);
        let connected = check.kind == FolderKind::Archive && check.archive_id.is_some() && check.archive_id == archive_id;
        StoreStatus {
            root: root.clone(),
            connected,
            mount_point: check.mount_point.filter(|_| connected),
            free_bytes: check.free_bytes.filter(|_| connected),
            noowners: check.noowners && connected,
            last_seen_at,
        }
    });
    let away = match (&settings.root, &archive_id) {
        (Some(_), Some(id)) => open_main_check(&settings, id, index_dev),
        _ => None,
    };
    let state = match (&main, away, settings.paused) {
        (None, _, _) => ArchiveCondition::Off,
        (Some(_), _, true) => ArchiveCondition::Paused,
        (Some(_), Some(Away::Missing), _) => ArchiveCondition::MainMissing,
        (Some(_), Some(Away::Foreign), _) => ArchiveCondition::Foreign,
        _ if runtime.last_error.is_some() => ArchiveCondition::Error,
        _ if !runtime.last_complete => ArchiveCondition::CatchingUp,
        _ => ArchiveCondition::Ok,
    };
    let warnings = if main.as_ref().is_some_and(|main| main.noowners) { vec!["noowners"] } else { Vec::new() };
    Ok(ArchiveStatus {
        state,
        archive_id,
        main,
        sources: sources(db)?,
        machines: machine_runs(db)?,
        imports: imports::statuses(db)?,
        totals: totals(db)?,
        running: runtime.running,
        last_pass_at: runtime.last_pass_at,
        next_pass_at: runtime.next_pass_at,
        last_error: runtime.last_error.clone(),
        failing_since: runtime.failing_since,
        paused: settings.paused,
        gentle: settings.gentle,
        other_machines: !settings.skip_other_machines,
        machine_overrides: settings.machines.clone(),
        project_overrides: settings.projects.clone(),
        warnings,
    })
}

/// The same checks as `open_main`, without taking the store's lock.
fn open_main_check(settings: &Settings, archive_id: &str, index_dev: Option<u64>) -> Option<Away> {
    let root = PathBuf::from(settings.root.as_deref()?);
    let check = check_folder(&root, index_dev);
    match check.kind {
        FolderKind::Archive if check.archive_id.as_deref() == Some(archive_id) => {}
        FolderKind::Archive | FolderKind::NotEmpty => return Some(Away::Foreign),
        _ => return Some(Away::Missing),
    }
    if settings.mount_point.is_some() && check.mount_point != settings.mount_point {
        return Some(Away::Foreign);
    }
    (index_dev.is_some() && device(&root) == index_dev).then_some(Away::Foreign)
}

async fn blocking<T: Send + 'static>(task: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task).await.map_err(|error| error.to_string())?
}

async fn current_status(app: &tauri::AppHandle) -> Result<ArchiveStatus, String> {
    let state = app.state::<ArchiveState>();
    let (running, last_pass_at, next_pass_at, last_complete, last_error, failing_since) = {
        let runtime = state.runtime();
        (runtime.running, runtime.last_pass_at, runtime.next_pass_at, runtime.last_complete, runtime.last_error.clone(), runtime.failing_since)
    };
    blocking(move || {
        let dir = index_dir()?;
        let db = open_index(&dir)?;
        let runtime = Runtime { running, last_pass_at, next_pass_at, last_complete, last_error, failing_since };
        status_from(&db, &runtime, device(&dir))
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_session_archive_status(app: tauri::AppHandle) -> Result<ArchiveStatus, String> {
    current_status(&app).await
}

/// Every token counted in the kept transcripts so far.
#[tauri::command]
pub(crate) async fn get_lifetime_tokens() -> Result<tokens::LifetimeTokens, String> {
    blocking(|| tokens::lifetime(&open_index(&index_dir()?)?)).await
}

/// The archive's own folders, which are never looked in for a backup to import.
fn archive_folders(db: &Connection, dir: &Path) -> Result<Vec<PathBuf>, String> {
    Ok([Some(dir.to_path_buf()), settings(db)?.root.map(PathBuf::from)].into_iter().flatten().collect())
}

/// Machines a backup could have come from: this Mac, then the others Arbor watches.
fn known_machines(app: &tauri::AppHandle, this: &str) -> Vec<String> {
    let mut names = vec![this.to_string()];
    let state = app.state::<MachineHealthState>();
    let inner = state.lock();
    for series in inner.series.values().filter(|series| series.host.enabled) {
        if !names.contains(&series.host.machine) {
            names.push(series.host.machine.clone());
        }
    }
    names
}

fn import_plan(app: &tauri::AppHandle, path: &str) -> Result<(imports::Plan, String), String> {
    let dir = index_dir()?;
    let db = open_index(&dir)?;
    if index::get_meta(&db, "archiveId")?.is_none() {
        return Err("Set up the archive first.".into());
    }
    let machine = this_machine(app, &db)?;
    let plan = imports::plan(&db, Path::new(path.trim()), &archive_folders(&db, &dir)?, &machine)?;
    Ok((plan, machine))
}

/// Looks in a folder for agent homes to import, and says what importing it would take in.
#[tauri::command]
pub(crate) async fn preview_session_import(app: tauri::AppHandle, path: String) -> Result<imports::ImportPreview, String> {
    let handle = app.clone();
    let (plan, machine) = blocking(move || import_plan(&handle, &path)).await?;
    let listing = list_import(&machine, plan.new_roots()).await?;
    let machines = known_machines(&app, &machine);
    blocking(move || imports::preview(&open_index(&index_dir()?)?, &plan, &listing, machines)).await
}

/// Imports the new agent homes in a folder, filed under the machine they came from.
#[tauri::command]
pub(crate) async fn add_session_import(app: tauri::AppHandle, path: String, machine: String) -> Result<ArchiveStatus, String> {
    let handle = app.clone();
    blocking(move || {
        let (plan, _) = import_plan(&handle, &path)?;
        imports::add(&open_index(&index_dir()?)?, &plan, &machine).map(|_| ())
    })
    .await?;
    app.state::<ArchiveState>().wake.notify_one();
    current_status(&app).await
}

/// Stops an import that hasn't finished; what it kept stays kept.
#[tauri::command]
pub(crate) async fn cancel_session_import(app: tauri::AppHandle, id: i64) -> Result<ArchiveStatus, String> {
    blocking(move || imports::cancel(&open_index(&index_dir()?)?, id)).await?;
    current_status(&app).await
}

#[tauri::command]
pub(crate) async fn check_session_archive_folder(path: String) -> Result<FolderCheck, String> {
    blocking(move || Ok(check_folder(Path::new(path.trim()), device(&index_dir()?)))).await
}

/// Makes a new archive in an empty folder on another drive, for an index that has none yet.
/// `index_dev` is the disk the index is on, where an archive isn't allowed.
fn create_in(dir: &Path, root: &Path, machine: &str, index_dev: Option<u64>) -> Result<(), String> {
    let db = open_index(dir)?;
    if index::get_meta(&db, "archiveId")?.is_some() {
        return Err("This Mac already keeps an archive. To move it, use the folder it's in now.".into());
    }
    let archive_id = store::random_id();
    let store = Store::create(root, &archive_id, machine, index_dev)?;
    register(&db, &store, &archive_id, machine)
}

/// Points the index at an archive that's already there: the one it was using, moved, or one
/// made before the index existed.
fn use_in(dir: &Path, root: &Path, machine: &str, index_dev: Option<u64>) -> Result<(), String> {
    let db = open_index(dir)?;
    let check = check_folder(root, index_dev);
    let Some(archive_id) = check.archive_id.filter(|_| check.kind == FolderKind::Archive) else {
        return Err("That folder isn't an archive.".into());
    };
    if index::get_meta(&db, "archiveId")?.is_some_and(|ours| ours != archive_id) {
        return Err("That's a different archive from the one this Mac keeps.".into());
    }
    if index_dev.is_some() && device(root) == index_dev {
        return Err("That folder is on this Mac's own disk. Choose one on another drive.".into());
    }
    let store = Store::open(root, &archive_id)?;
    register(&db, &store, &archive_id, machine)
}

fn register(db: &Connection, store: &Store, archive_id: &str, machine: &str) -> Result<(), String> {
    let volume = store::volume(store.root());
    let root = store.root().to_string_lossy().into_owned();
    let now = index::now_ms();
    {
        let _writes = index::lock_writes();
        let transaction = db.unchecked_transaction().map_err(|error| error.to_string())?;
        index::set_meta(&transaction, "archiveId", archive_id)?;
        index::set_meta(&transaction, "mainStoreId", &store.info().store_id)?;
        transaction
            .execute(
                "INSERT INTO stores(store_id, role, machine, root, mount_point, dev, added_at, last_seen_at) VALUES(?1, 'main', ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(store_id) DO UPDATE SET root = excluded.root, mount_point = excluded.mount_point, dev = excluded.dev, last_seen_at = excluded.last_seen_at",
                params![store.info().store_id, machine, root, volume.mount_point, volume.dev.map(|dev| dev as i64), now],
            )
            .map_err(|error| error.to_string())?;
        journal::emit(&transaction, serde_json::json!({"t": "open", "archive": archive_id, "store": store.info().store_id, "root": root}))?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let mut settings = settings(db)?;
    settings.root = Some(root);
    settings.mount_point = volume.mount_point;
    save_settings(db, &settings)?;
    journal::flush(db, store)?;
    Ok(())
}

fn set_up(app: &tauri::AppHandle, path: String, create: bool) -> Result<(), String> {
    let dir = index_dir()?;
    let root = PathBuf::from(path.trim());
    if !root.is_absolute() {
        return Err("Choose a folder.".into());
    }
    let machine = this_machine(app, &open_index(&dir)?)?;
    if create {
        create_in(&dir, &root, &machine, device(&dir))
    } else {
        use_in(&dir, &root, &machine, device(&dir))
    }
}

#[tauri::command]
pub(crate) async fn create_session_archive(app: tauri::AppHandle, path: String) -> Result<ArchiveStatus, String> {
    let handle = app.clone();
    blocking(move || set_up(&handle, path, true)).await?;
    app.state::<ArchiveState>().wake.notify_one();
    current_status(&app).await
}

#[tauri::command]
pub(crate) async fn use_session_archive(app: tauri::AppHandle, path: String) -> Result<ArchiveStatus, String> {
    let handle = app.clone();
    blocking(move || set_up(&handle, path, false)).await?;
    app.state::<ArchiveState>().wake.notify_one();
    current_status(&app).await
}

#[tauri::command]
pub(crate) async fn run_session_archive_now(app: tauri::AppHandle) -> Result<(), String> {
    app.state::<ArchiveState>().wake.notify_one();
    Ok(())
}

async fn change_settings(app: &tauri::AppHandle, change: impl FnOnce(&mut Settings) + Send + 'static) -> Result<ArchiveStatus, String> {
    blocking(move || {
        let db = open_index(&index_dir()?)?;
        let mut settings = settings(&db)?;
        change(&mut settings);
        save_settings(&db, &settings)
    })
    .await?;
    current_status(app).await
}

#[tauri::command]
pub(crate) async fn set_session_archive_paused(app: tauri::AppHandle, paused: bool) -> Result<ArchiveStatus, String> {
    let status = change_settings(&app, move |settings| settings.paused = paused).await?;
    if !paused {
        app.state::<ArchiveState>().wake.notify_one();
    }
    Ok(status)
}

#[tauri::command]
pub(crate) async fn save_session_archive_settings(app: tauri::AppHandle, gentle: bool, other_machines: bool) -> Result<ArchiveStatus, String> {
    let status = change_settings(&app, move |settings| {
        settings.gentle = gentle;
        settings.skip_other_machines = !other_machines;
    })
    .await?;
    if other_machines {
        app.state::<ArchiveState>().wake.notify_one();
    }
    Ok(status)
}

/// Gives one machine its own value, keeping its sessions (true) or not (false) whatever All
/// machines says, or with `None` puts it back on All machines' value.
#[tauri::command]
pub(crate) async fn set_session_archive_machine(app: tauri::AppHandle, machine: String, keep: Option<bool>) -> Result<ArchiveStatus, String> {
    let key = normalize_machine_name(&machine);
    if key.is_empty() {
        return Err("That machine has no name to keep it under".into());
    }
    let status = change_settings(&app, move |settings| match keep {
        Some(keep) => {
            settings.machines.insert(key, keep);
        }
        None => {
            settings.machines.remove(&key);
        }
    })
    .await?;
    if keep == Some(true) {
        app.state::<ArchiveState>().wake.notify_one();
    }
    Ok(status)
}

/// Gives a project its own value, on every machine (`machine` None) or on one: its sessions kept
/// (true) or not (false) whatever the machine says, or with `None` puts it back on what it
/// inherits. Not keeping them stops new copies; what's already kept stays.
#[tauri::command]
pub(crate) async fn set_session_archive_project(app: tauri::AppHandle, project: String, machine: Option<String>, keep: Option<bool>) -> Result<ArchiveStatus, String> {
    let key = project.trim().to_ascii_lowercase();
    if !key.contains('/') {
        return Err("That project has no owner/name to keep it under".into());
    }
    let machine = machine.map(|machine| normalize_machine_name(&machine));
    if machine.as_deref() == Some("") {
        return Err("That machine has no name to keep it under".into());
    }
    let status = change_settings(&app, move |settings| {
        let entry = settings.projects.entry(key.clone()).or_default();
        match (&machine, keep) {
            (Some(machine), Some(keep)) => {
                entry.machines.insert(machine.clone(), keep);
            }
            (Some(machine), None) => {
                entry.machines.remove(machine);
            }
            (None, keep) => entry.all = keep,
        }
        if entry.is_empty() {
            settings.projects.remove(&key);
        }
    })
    .await?;
    if keep == Some(true) {
        app.state::<ArchiveState>().wake.notify_one();
    }
    Ok(status)
}

#[tauri::command]
pub(crate) async fn reveal_session_archive(app: tauri::AppHandle) -> Result<(), String> {
    let root = blocking(|| settings(&open_index(&index_dir()?)?).map(|settings| settings.root)).await?.ok_or("There's no archive yet")?;
    if !Path::new(&root).is_dir() {
        return Err("The archive's drive isn't connected".into());
    }
    app.opener().reveal_item_in_dir(&root).map_err(|error| error.to_string())
}

/// Lists this Mac's agent homes, or the homes a script names, through the same script every machine uses.
async fn list_with(machine: &str, script: &str) -> Result<lister::Listing, String> {
    list_on(&Machine::this_mac(machine), script).await
}

/// Lists a machine's agent homes with a lister script.
async fn list_on(machine: &Machine, script: &str) -> Result<lister::Listing, String> {
    let stdout = run_checked(machine, MachineOp::ArchiveList, script, LIST_TIMEOUT)
        .await
        .map_err(|error| format!("Couldn't list the agent homes: {error}"))?;
    let listing = lister::parse(&stdout);
    if !listing.ended {
        return Err("The list of agent homes stopped short".into());
    }
    Ok(listing)
}

/// Lists an import's roots: copied homes through the script, other layouts here.
async fn list_import(machine: &str, roots: Vec<imports::ImportRoot>) -> Result<lister::Listing, String> {
    let homes = imports::home_roots(&roots);
    let mut listing = if homes.is_empty() { lister::Listing { ended: true, ..lister::Listing::default() } } else { list_with(machine, &lister::roots_script(&homes)).await? };
    blocking(move || {
        imports::list_layouts(&roots, &mut listing);
        Ok(listing)
    })
    .await
}

/// What a pass has to work through: this Mac's listing, each other machine's (or why it
/// couldn't be listed), and the old backups still being taken in.
struct PassInput {
    machine: String,
    listing: lister::Listing,
    fleet: Vec<(Machine, Result<lister::Listing, String>)>,
    imported: Vec<(imports::PendingImport, Result<lister::Listing, String>)>,
    /// Where the other machines' fetches run from the pass's thread.
    runtime: tokio::runtime::Handle,
}

/// Notes how a machine's pass went, for the status and to say since when a machine has failed.
fn note_run(db: &Connection, machine: &str, started: i64, result: &Result<PassReport, String>) {
    let finished = index::now_ms();
    let _writes = index::lock_writes();
    let (report, error) = match result {
        Ok(report) => (report.clone(), report.first_failure.clone()),
        Err(error) => (PassReport::default(), Some(error.clone())),
    };
    let _ = db.execute(
        "INSERT INTO runs(machine, started_at, finished_at, complete, files_listed, files_changed, bytes_read, bytes_new, error) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![machine, started, finished, report.complete, report.files_listed as i64, report.files_changed as i64, report.bytes_read as i64, report.bytes_new as i64, error],
    );
}

/// Keeps each other machine's sessions, one machine at a time, each in a share of its own. A
/// machine that couldn't be listed or stopped answering is noted in its own run and doesn't
/// hold up the rest, or make the archive look like it's failing. True when one has more to keep.
fn fleet_pass(db: &Connection, places: &Places, fleet: Vec<(Machine, Result<lister::Listing, String>)>, options: &PassOptions, filter: &dyn Fn(&str) -> SessionFilter, runtime: &tokio::runtime::Handle, stop: &dyn Fn() -> bool) -> bool {
    let mut left = false;
    for (machine, listed) in fleet {
        if stop() {
            return true;
        }
        let started = index::now_ms();
        let result = listed.and_then(|listing| {
            let mut fetch = remote::ShellFetch::on(machine.clone(), runtime.clone());
            let mut files = remote::RemoteFiles::new(&mut fetch, remote::SIZES, options.bytes_per_second);
            let machine_options = PassOptions {
                machine: machine.name().to_string(),
                user_home: listing.home.clone(),
                limits: options.limits,
                bytes_per_second: options.bytes_per_second,
                max_bytes: FLEET_MAX_BYTES,
                max_time: FLEET_MAX_TIME,
                import: false,
                sessions: filter(machine.name()),
            };
            ingest::run_pass_from(db, places, &listing, &machine_options, &mut files, stop)
        });
        // A machine that stopped answering is tried again at the next pass, not straight away.
        left |= result.as_ref().is_ok_and(|report| !report.complete && !report.lost);
        note_run(db, machine.name(), started, &result);
    }
    left
}

/// Runs the pass on a thread of its own at utility priority, so it gives way to everything
/// the user is doing.
fn run_pass_thread(input: PassInput, token: CancellationToken) -> Result<Option<PassReport>, String> {
    let PassInput { machine, listing, fleet, imported, runtime } = input;
    #[cfg(target_os = "macos")]
    unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
    }
    let dir = index_dir()?;
    let db = open_index(&dir)?;
    let settings = settings(&db)?;
    let Some(archive_id) = index::get_meta(&db, "archiveId")? else {
        return Ok(None);
    };
    if settings.paused || settings.root.is_none() {
        return Ok(None);
    }
    let store = open_main(&settings, &archive_id, device(&dir)).map_err(|(_, error)| error)?;
    saw_main(&db, &store, index::now_ms())?;
    let places = Places { store, pending_dir: dir.join("pending") };
    // Lines left from a pass that stopped before its flush go first.
    journal::flush(&db, &places.store)?;
    // A project the user chose to keep or leave out is found by its sessions' ids in usage.db. If
    // that can't be read, every session follows its machine: kept rather than lost.
    let sessions = if settings.projects.is_empty() { Vec::new() } else { project_sessions().unwrap_or_default() };
    let filter = |name: &str| settings.session_filter(name, name == machine, &sessions);
    let options = PassOptions {
        machine: machine.clone(),
        user_home: std::env::var("HOME").ok(),
        limits: classify::LIMITS,
        bytes_per_second: if settings.gentle { GENTLE_READ_RATE } else { READ_RATE },
        max_bytes: PASS_MAX_BYTES,
        max_time: PASS_MAX_TIME,
        import: false,
        sessions: filter(&machine),
    };
    let started = index::now_ms();
    let mut result = ingest::run_pass(&db, &places, &listing, &options, &|| token.is_cancelled());
    note_run(&db, &machine, started, &result);
    // The other machines, backups and counting wait until everything listed here is kept, so a
    // catch-up pass goes to this Mac's homes first.
    if let Some(report) = result.as_mut().ok().filter(|report| report.complete) {
        report.fleet_left = fleet_pass(&db, &places, fleet, &options, &filter, &runtime, &|| token.is_cancelled());
        // Old backups are taken in whole: their sessions aren't in usage.db to be told apart.
        let import_options = PassOptions { max_bytes: IMPORT_MAX_BYTES, max_time: IMPORT_MAX_TIME, sessions: SessionFilter::everything(), ..options };
        match imports::run(&db, &places, &imported, &import_options, &|| token.is_cancelled()) {
            Ok(left) => report.imports_left = left,
            Err(error) => {
                report.first_failure.get_or_insert(error);
            }
        }
        let count_options = tokens::CountOptions { bytes_per_second: options.bytes_per_second, max_bytes: COUNT_MAX_BYTES, max_time: COUNT_MAX_TIME };
        // A version that couldn't be counted is tried again next pass; it doesn't make the archive
        // itself look like it's failing.
        let counted = tokens::count_pass(&db, &places, &count_options, &|| token.is_cancelled());
        let failure = match &counted {
            Ok(count) => count.first_failure.clone(),
            Err(error) => Some(error.clone()),
        };
        let _ = tokens::note_failure(&db, failure.as_deref());
        report.counting_left = counted.is_ok_and(|count| !count.complete);
    }
    let flushed = journal::flush(&db, &places.store);
    {
        let _writes = index::lock_writes();
        let _ = db.execute("DELETE FROM runs WHERE started_at < ?1", [index::now_ms() - RUNS_KEPT_MS]);
        let _ = db.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
    }
    flushed?;
    result.map(Some)
}

async fn run_once(app: &tauri::AppHandle, token: &CancellationToken) -> Result<Option<PassReport>, String> {
    let machine = {
        let app = app.clone();
        blocking(move || this_machine(&app, &open_index(&index_dir()?)?)).await?
    };
    let ready = blocking(|| {
        let db = open_index(&index_dir()?)?;
        let settings = settings(&db)?;
        Ok((settings.root.is_some() && !settings.paused && index::get_meta(&db, "archiveId")?.is_some()).then_some(settings))
    })
    .await?;
    let Some(settings) = ready else {
        return Ok(None);
    };
    let this_mac = agent_homes::this_mac_name(&app.state::<MachineHealthState>().lock());
    // Until Arbor has looked for this Mac's homes, a pass would miss the ones it's about to find.
    if !agent_homes::looked_at(&this_mac) {
        return Ok(None);
    }
    let script = lister::list_script(&this_mac);
    let listing = list_with(&machine, &script).await?;
    let fleet = if settings.keeps_any() { other_machines_listed(app, &settings).await } else { Vec::new() };
    // A backup whose drive is unplugged waits for it.
    let pending = blocking(|| imports::pending(&open_index(&index_dir()?)?)).await?;
    let mut imported = Vec::new();
    for import in pending.into_iter().filter(|import| Path::new(&import.path).is_dir()) {
        let listed = list_import(&machine, import.roots.clone()).await;
        imported.push((import, listed));
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let token = token.clone();
    let input = PassInput { machine, listing, fleet, imported, runtime: tokio::runtime::Handle::current() };
    std::thread::Builder::new()
        .name("arbor-session-archive".into())
        .spawn(move || {
            let _ = sender.send(run_pass_thread(input, token));
        })
        .map_err(|error| format!("Couldn't start the archive pass: {error}"))?;
    receiver.await.map_err(|_| "The archive pass stopped unexpectedly".to_string())?
}

/// The machines on the Machines page other than this Mac that are kept, each listed with the
/// same script as this Mac, all at once.
async fn other_machines_listed(app: &tauri::AppHandle, settings: &Settings) -> Vec<(Machine, Result<lister::Listing, String>)> {
    let machines: Vec<Machine> = {
        let state = app.state::<MachineHealthState>();
        let inner = state.lock();
        inner
            .series
            .values()
            .filter(|series| !series.local && shell::runs_scripts(series) && settings.lists(&series.host.machine))
            .filter(|series| agent_homes::looked_at(&series.host.machine))
            .map(Machine::listed)
            .collect()
    };
    futures_util::future::join_all(machines.into_iter().map(|machine| async move {
        let listing = list_on(&machine, &lister::list_script(machine.name())).await;
        (machine, listing)
    }))
    .await
}

/// Keeps the archive current: a pass a minute after the app starts, then every five minutes,
/// sooner while catching up, and whenever the page asks.
pub(crate) async fn run_loop(app: tauri::AppHandle, token: CancellationToken) {
    let mut delay = FIRST_PASS_AFTER;
    loop {
        {
            let state = app.state::<ArchiveState>();
            state.runtime().next_pass_at = Some(index::now_ms() + delay.as_millis() as i64);
            tokio::select! {
                () = token.cancelled() => break,
                () = tokio::time::sleep(delay) => {}
                () = state.wake.notified() => {}
            }
            state.runtime().running = true;
        }
        let outcome = run_once(&app, &token).await;
        let state = app.state::<ArchiveState>();
        let catch_up = record_outcome(&mut state.runtime(), outcome, index::now_ms());
        delay = if catch_up && !token.is_cancelled() { CATCH_UP_AFTER } else { PASS_EVERY };
    }
}

/// Notes how a pass went, and whether the next should come straight away to carry on.
fn record_outcome(runtime: &mut Runtime, outcome: Result<Option<PassReport>, String>, now: i64) -> bool {
    runtime.running = false;
    let catch_up = match outcome {
        Ok(Some(report)) => {
            runtime.last_pass_at = Some(now);
            runtime.last_complete = report.complete;
            runtime.last_error = report.first_failure;
            !report.complete || report.counting_left || report.imports_left || report.fleet_left
        }
        Ok(None) => {
            runtime.last_error = None;
            false
        }
        Err(error) => {
            runtime.last_error = Some(error);
            false
        }
    };
    // The first failure in a row starts the clock; a pass without one stops it.
    runtime.failing_since = runtime.last_error.as_ref().map(|_| runtime.failing_since.unwrap_or(now));
    catch_up
}

#[cfg(test)]
mod tests {
    use super::store::tests::temp_dir;
    use super::*;

    #[test]
    fn a_machines_own_value_overrides_all_machines() {
        let mut settings = Settings { skip_other_machines: true, ..Settings::default() };
        assert!(!settings.keeps("cedar-02"));
        assert!(!settings.keeps_any());
        settings.machines.insert(normalize_machine_name("Cedar 02"), true);
        // Names compare loosely, as everywhere machines are matched.
        assert!(settings.keeps("cedar-02"));
        assert!(settings.keeps_any());
        assert!(!settings.keeps("ci-01"));
        settings.skip_other_machines = false;
        settings.machines.insert("ci01".into(), false);
        assert!(!settings.keeps("ci-01"));
        assert!(settings.keeps("lab-box"));
        // An archive saved before machines had values of their own reads as none.
        let old: Settings = serde_json::from_str(r#"{"root":"/Volumes/Archive","skipOtherMachines":true}"#).unwrap();
        assert!(old.machines.is_empty() && !old.keeps("ci-01"));
    }

    #[test]
    fn a_projects_own_value_wins_over_its_machine_nearest_first() {
        let sessions: Vec<(String, String, String)> = [("A1", "Cedar 02", "Casey/Arbor"), ("B1", "cedar-02", "acme/web"), ("A2", "ci-01", "casey/arbor"), ("C1", "mini", "acme/secret")]
            .iter()
            .map(|(id, machine, repository)| (id.to_string(), machine.to_string(), repository.to_string()))
            .collect();
        let mut settings = Settings::default();
        // No project values: every machine's sessions follow the machine, with nothing looked up.
        assert_eq!(settings.session_filter("cedar-02", false, &sessions), SessionFilter::everything());

        // A project left out everywhere: its sessions go, on every machine, this Mac's too.
        settings.projects.insert("acme/secret".into(), ArchiveProjectKeep { all: Some(false), ..Default::default() });
        let mini = settings.session_filter("mini", true, &sessions);
        assert!(!mini.keeps(Some("c1")) && mini.keeps(Some("a1")) && mini.keeps(None));

        // Kept everywhere but on one machine, where the machine's own value for the project wins.
        let arbor = ArchiveProjectKeep { all: Some(true), machines: BTreeMap::from([(normalize_machine_name("ci-01"), false)]) };
        settings.projects.insert("casey/arbor".into(), arbor);
        assert!(!settings.session_filter("ci-01", false, &sessions).keeps(Some("a2")));

        // A machine that isn't kept still lists, for a project kept on it, and keeps only that
        // project's sessions: not the rest, nor sessions whose project isn't known yet.
        settings.skip_other_machines = true;
        assert!(!settings.keeps("cedar-02") && settings.lists("cedar-02") && settings.keeps_any());
        let cedar = settings.session_filter("cedar-02", false, &sessions);
        assert!(cedar.keeps(Some("a1")) && !cedar.keeps(Some("b1")) && !cedar.keeps(Some("unknown")) && !cedar.keeps(None));

        // Saved settings from before projects had values read as none.
        let old: Settings = serde_json::from_str(r#"{"root":"/Volumes/Archive","machines":{"ci01":false}}"#).unwrap();
        assert!(old.projects.is_empty());
    }

    #[test]
    fn an_archive_is_made_once_and_then_only_used() {
        let base = temp_dir("archive-setup");
        let dir = base.join("app/session-archive");
        let root = base.join("drive/archive.noindex");
        fs::create_dir_all(root.parent().unwrap()).unwrap();
        create_in(&dir, &root, "mini", None).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let db = open_index(&dir).unwrap();
        let archive_id = index::get_meta(&db, "archiveId").unwrap().unwrap();
        let saved = settings(&db).unwrap();
        assert_eq!(saved.root.as_deref(), Some(root.to_string_lossy().as_ref()));
        // A second archive for the same index is refused.
        let other = base.join("drive/other.noindex");
        assert!(create_in(&dir, &other, "mini", None).is_err());
        // The same archive, moved, is used again.
        let moved = base.join("drive/moved.noindex");
        fs::rename(&root, &moved).unwrap();
        use_in(&dir, &moved, "mini", None).unwrap();
        assert_eq!(settings(&db).unwrap().root.as_deref(), Some(moved.to_string_lossy().as_ref()));
        assert_eq!(open_main(&settings(&db).unwrap(), &archive_id, None).map(|_| ()).map_err(|(away, _)| away), Ok(()));
        // Another archive isn't.
        let foreign_dir = base.join("app2");
        let foreign = base.join("drive/foreign.noindex");
        create_in(&foreign_dir, &foreign, "air", None).unwrap();
        assert!(use_in(&dir, &foreign, "mini", None).is_err());
        // Nor one on the index's own disk.
        assert!(use_in(&dir, &moved, "mini", device(&dir)).is_err());
        // Away: the folder gone is a missing drive; another archive in its place is foreign.
        let mut away = settings(&db).unwrap();
        away.root = Some(base.join("unplugged/archive.noindex").to_string_lossy().into_owned());
        assert_eq!(open_main_check(&away, &archive_id, None), Some(Away::Missing));
        away.root = Some(foreign.to_string_lossy().into_owned());
        assert_eq!(open_main_check(&away, &archive_id, None), Some(Away::Foreign));
        away.root = Some(moved.to_string_lossy().into_owned());
        away.mount_point = Some("/Volumes/somewhere-else".into());
        assert_eq!(open_main_check(&away, &archive_id, None), Some(Away::Foreign));
        // On the index's own disk, it's refused.
        away.mount_point = None;
        assert_eq!(open_main_check(&away, &archive_id, device(&dir)), Some(Away::Foreign));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn the_status_says_where_things_stand_and_nothing_a_session_says() {
        let base = temp_dir("archive-status");
        let dir = base.join("app/session-archive");
        let db = open_index(&dir).unwrap();
        let off = status_from(&db, &Runtime::default(), None).unwrap();
        assert_eq!((off.state, off.main.is_none()), (ArchiveCondition::Off, true));
        let root = base.join("drive/archive.noindex");
        fs::create_dir_all(root.parent().unwrap()).unwrap();
        create_in(&dir, &root, "mini", None).unwrap();
        let catching_up = status_from(&db, &Runtime::default(), None).unwrap();
        assert_eq!(catching_up.state, ArchiveCondition::CatchingUp);
        assert!(catching_up.main.as_ref().unwrap().connected);
        let ok = status_from(&db, &Runtime { last_complete: true, ..Runtime::default() }, None).unwrap();
        assert_eq!(ok.state, ArchiveCondition::Ok);
        let failing = status_from(&db, &Runtime { last_complete: true, last_error: Some("x".into()), ..Runtime::default() }, None).unwrap();
        assert_eq!(failing.state, ArchiveCondition::Error);
        let mut paused = settings(&db).unwrap();
        paused.paused = true;
        save_settings(&db, &paused).unwrap();
        assert_eq!(status_from(&db, &Runtime::default(), None).unwrap().state, ArchiveCondition::Paused);
        paused.paused = false;
        save_settings(&db, &paused).unwrap();
        // A pass that reaches the store notes when, so a missing drive can say how long it's been away.
        let registered = catching_up.main.as_ref().unwrap().last_seen_at.unwrap();
        let store = open_main(&settings(&db).unwrap(), &catching_up.archive_id.clone().unwrap(), None).unwrap();
        saw_main(&db, &store, registered + 60_000).unwrap();
        drop(store);
        fs::rename(&root, base.join("drive/elsewhere")).unwrap();
        let missing = status_from(&db, &Runtime::default(), None).unwrap();
        assert_eq!(missing.state, ArchiveCondition::MainMissing);
        let main = missing.main.unwrap();
        assert!(!main.connected);
        assert_eq!(main.last_seen_at, Some(registered + 60_000));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn each_other_machine_is_kept_on_its_own_and_says_how_it_went_without_a_word_of_a_session() {
        use super::ingest::tests::{walk, Fixture, SECRET_TEXT, SID};
        use super::lister::{list_script, parse, tests::run_list};
        let fixture = Fixture::new("fleet");
        fixture.write(&format!(".claude/projects/-home-me-app/{SID}.jsonl"), &format!("{{\"sessionId\":\"{SID}\",\"text\":\"{SECRET_TEXT}\"}}\n"));
        index::set_meta(&fixture.db, "thisMachine", "mini").unwrap();
        let listing = parse(&run_list("sh", &fixture.home, &list_script("")));
        assert!(!listing.roots.is_empty());
        let options = PassOptions {
            machine: "mini".into(),
            user_home: None,
            limits: classify::LIMITS,
            bytes_per_second: 1 << 40,
            max_bytes: 1 << 40,
            max_time: Duration::from_secs(600),
            import: false,
            sessions: SessionFilter::everything(),
        };
        // This Mac's own run is the status row's to report, not a machine's.
        note_run(&fixture.db, "mini", 1, &Err("The archive's drive isn't connected".into()));
        let runtime = remote::tests::runtime();
        // Both "machines" are this Mac's shell reading temp files; one couldn't be listed.
        let fleet = vec![(Machine::this_mac("air"), Err("ssh: connect to host air port 22: Operation timed out".to_string())), (Machine::this_mac("cedar"), Ok(listing))];
        assert!(!fleet_pass(&fixture.db, &fixture.places, fleet, &options, &|_| SessionFilter::everything(), runtime.handle(), &|| false), "nothing left to keep");
        journal::flush(&fixture.db, &fixture.places.store).unwrap();

        let status = status_from(&fixture.db, &Runtime::default(), None).unwrap();
        let machines: Vec<(&str, bool, Option<&str>, bool)> = status.machines.iter().map(|run| (run.machine.as_str(), run.complete, run.error.as_deref(), run.last_ok_at.is_some())).collect();
        assert_eq!(machines, [("air", false, Some("ssh: connect to host air port 22: Operation timed out"), false), ("cedar", true, None, true)]);
        let cedar: Vec<(&str, &str, u64)> = status.sources.iter().map(|source| (source.machine.as_str(), source.label.as_str(), source.kept)).collect();
        assert_eq!(cedar, [("cedar", "~/.claude", 1)]);

        // Of a session, only its bytes are kept, and only in the store's chunks and tails.
        let secret = SECRET_TEXT.as_bytes();
        let contains = |bytes: &[u8]| bytes.windows(secret.len()).any(|window| window == secret);
        assert!(!serde_json::to_string(&status).unwrap().contains(SECRET_TEXT));
        fixture.db.execute_batch("PRAGMA wal_checkpoint(PASSIVE);").unwrap();
        for path in [fixture.db_path.clone(), fixture.db_path.with_extension("db-wal")] {
            assert!(!fs::read(&path).is_ok_and(|bytes| contains(&bytes)), "{}", path.display());
        }
        for path in walk(&fixture.places.store.root().join("journal")) {
            assert!(!contains(&fs::read(&path).unwrap()), "{}", path.display());
        }
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn failing_is_timed_from_the_first_failure_in_a_row() {
        let mut runtime = Runtime::default();
        let finished = |complete| Ok(Some(PassReport { complete, ..PassReport::default() }));
        assert!(!record_outcome(&mut runtime, finished(true), 1_000));
        assert_eq!((runtime.last_pass_at, runtime.failing_since), (Some(1_000), None));
        assert!(!record_outcome(&mut runtime, Err("The archive's drive isn't connected".into()), 2_000));
        assert!(!record_outcome(&mut runtime, Err("The archive's drive isn't connected".into()), 3_000));
        assert_eq!((runtime.last_pass_at, runtime.failing_since), (Some(1_000), Some(2_000)));
        // A pass that kept going but couldn't read a file is still failing.
        let partial = Ok(Some(PassReport { complete: false, first_failure: Some("x".into()), ..PassReport::default() }));
        assert!(record_outcome(&mut runtime, partial, 4_000));
        assert_eq!(runtime.failing_since, Some(2_000));
        assert!(!record_outcome(&mut runtime, finished(true), 5_000));
        assert_eq!((runtime.last_error.as_deref(), runtime.failing_since), (None, None));
        // Tokens still to count bring the next pass forward, without looking like trouble.
        assert!(record_outcome(&mut runtime, Ok(Some(PassReport { complete: true, counting_left: true, ..PassReport::default() })), 5_500));
        assert_eq!((runtime.last_complete, runtime.failing_since), (true, None));
        // Paused or not set up: nothing's failing.
        record_outcome(&mut runtime, Err("x".into()), 6_000);
        record_outcome(&mut runtime, Ok(None), 7_000);
        assert_eq!(runtime.failing_since, None);
    }
}

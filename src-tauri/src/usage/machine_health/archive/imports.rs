//! Old backups brought into the archive. The user picks a folder (a copied ~/.claude, a
//! snapshot of a whole home, a folder of Codex rollouts), Arbor finds the agent homes in it,
//! and each is listed by the same script and kept the same way as a live home, filed under the
//! machine the user says it came from. A backup doesn't change, so its files settle straight
//! away, and once a pass has kept all of it the backup isn't listed again.
//!
//! Backups in other layouts (OpenClaw, Claude's desktop app) are found and listed by `layouts`.
//!
//! Finding homes looks at folder names only, and the preview names sessions from file names
//! as the agents do, so nothing in a transcript is read until the import keeps it.

use super::super::archive::SessionFilter;
use super::identity;
use super::index::{lock_writes, now_ms};
use super::ingest::{run_pass, PassOptions, Places};
use super::journal::emit;
use super::layouts::{self, LayoutRoot, HOME};
use super::lister::{allowed, Listing};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::json;
use ts_rs::TS;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How deep in the chosen folder homes are looked for: deep enough for one in a snapshot of a
/// whole machine (backups/b1/filesystem/Users/me/.skipper/profiles/x) chosen from the drive it's on.
const FIND_DEPTH: usize = 9;
/// Folders looked in, and for how long, before giving up, so choosing a whole drive can't take forever.
const FIND_MAX_DIRS: usize = 50_000;
const FIND_MAX_TIME: Duration = Duration::from_secs(20);
/// Folders never looked in: they hold no homes, or far too much else.
const NEVER_LOOK_IN: &[&str] = &[
    ".git", "node_modules", ".Trash", ".Trashes", ".Spotlight-V100", ".fseventsd", ".DocumentRevisions-V100", ".TemporaryItems",
    "Caches", "Containers", "Group Containers", ".cache", ".npm", ".cargo", ".rustup", ".bun", "target",
];
/// A folder chosen inside a home (its projects/ or sessions/) means the home, this many levels up at most.
const HOME_ABOVE: usize = 3;
const MACHINE_NAME_MAX: usize = 64;

fn db_error(error: rusqlite::Error) -> String {
    format!("The archive index failed: {error}")
}

/// What kind of agent home a folder is, if it is one. Claude Code files sessions in projects/,
/// in folders named from each project's path, which start with a dash; Codex keeps rollouts in
/// sessions/ (by date), archived_sessions/ or compacted-history/.
pub(crate) fn home_kind(dir: &Path) -> Option<&'static str> {
    if let Ok(entries) = fs::read_dir(dir.join("projects")) {
        if entries.flatten().any(|entry| entry.file_name().to_string_lossy().starts_with('-') && entry.path().is_dir()) {
            return Some("claude");
        }
    }
    ["sessions", "archived_sessions", "compacted-history"].iter().any(|sub| has_rollout(&dir.join(sub), 4)).then_some("codex")
}

fn has_rollout(dir: &Path, depth: usize) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    let mut below = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("rollout-") && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst")) {
            return true;
        }
        if depth > 0 && entry.path().is_dir() {
            below.push(entry.path());
        }
    }
    below.sort();
    below.iter().any(|dir| has_rollout(dir, depth - 1))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FoundHome {
    /// claude or codex for a home; the layout for anything else.
    pub(crate) agent: &'static str,
    pub(crate) root: PathBuf,
    pub(crate) layout: &'static str,
}

#[derive(Debug, Default)]
pub(crate) struct Found {
    pub(crate) homes: Vec<FoundHome>,
    /// The search stopped at its limit before looking everywhere.
    pub(crate) partial: bool,
}

/// The agent homes in a folder, nearest first, without looking inside one once it's found or
/// following links. `never` are folders not to look in, such as the archive itself.
pub(crate) fn find_homes(folder: &Path, never: &[PathBuf]) -> Found {
    let started = Instant::now();
    let mut found = Found::default();
    let mut queue = VecDeque::from([(folder.to_path_buf(), 0)]);
    let mut looked = 0;
    while let Some((dir, depth)) = queue.pop_front() {
        if never.contains(&dir) {
            continue;
        }
        if looked >= FIND_MAX_DIRS || started.elapsed() >= FIND_MAX_TIME {
            found.partial = true;
            break;
        }
        looked += 1;
        if let Some(agent) = home_kind(&dir) {
            found.homes.push(FoundHome { agent, root: dir, layout: HOME });
            continue;
        }
        if let Some(layout) = layouts::layout_at(&dir) {
            let inside = layouts::homes_inside(layout, &dir);
            found.homes.push(FoundHome { agent: layout, root: dir, layout });
            found.homes.extend(inside.into_iter().filter_map(|root| home_kind(&root).map(|agent| FoundHome { agent, root, layout: HOME })));
            continue;
        }
        if depth >= FIND_DEPTH {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut below: Vec<PathBuf> = entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .filter(|entry| !NEVER_LOOK_IN.contains(&entry.file_name().to_string_lossy().as_ref()))
            .map(|entry| entry.path())
            .collect();
        below.sort();
        queue.extend(below.into_iter().map(|dir| (dir, depth + 1)));
    }
    if found.homes.is_empty() {
        if let Some((agent, dir)) = folder.ancestors().skip(1).take(HOME_ABOVE).find_map(|dir| home_kind(dir).map(|agent| (agent, dir))) {
            found.homes.push(FoundHome { agent, root: dir.to_path_buf(), layout: HOME });
        }
    }
    found
}

/// A root an import keeps: a home, or a folder in another layout.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ImportRoot {
    pub(crate) agent: String,
    pub(crate) root: String,
    pub(crate) layout: String,
    /// Where its sessions came from, when that isn't the import's machine.
    pub(crate) machine: Option<String>,
}

impl ImportRoot {
    fn layout_root(&self) -> LayoutRoot {
        LayoutRoot { agent: self.agent.clone(), root: self.root.clone(), layout: self.layout.clone() }
    }
}

/// The copied homes among `roots`, for the shell script, by agent and path.
pub(crate) fn home_roots(roots: &[ImportRoot]) -> Vec<(String, String)> {
    roots.iter().filter(|root| root.layout == HOME).map(|root| (root.agent.clone(), root.root.clone())).collect()
}

/// Lists `roots` that aren't copied homes, and adds them to `listing`, the shell script's
/// listing of the rest.
pub(crate) fn list_layouts(roots: &[ImportRoot], listing: &mut Listing) {
    let others: Vec<LayoutRoot> = roots.iter().filter(|root| root.layout != HOME).map(ImportRoot::layout_root).collect();
    if others.is_empty() {
        return;
    }
    let listed = layouts::list(&others);
    listing.roots.extend(listed.roots);
    listing.ended &= listed.ended;
}

/// Where a home an import found stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ImportHomeState {
    /// To be imported.
    New,
    /// One of this Mac's homes, kept already.
    Live,
    /// In an earlier import.
    Imported,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PlannedHome {
    pub(crate) home: ImportRoot,
    pub(crate) state: ImportHomeState,
}

/// What importing a folder would take in.
#[derive(Clone, Debug)]
pub(crate) struct Plan {
    pub(crate) path: String,
    pub(crate) homes: Vec<PlannedHome>,
    pub(crate) partial: bool,
}

impl Plan {
    pub(crate) fn new_roots(&self) -> Vec<ImportRoot> {
        self.homes.iter().filter(|home| home.state == ImportHomeState::New).map(|home| home.home.clone()).collect()
    }

}

fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Finds the homes in `folder` and sorts out which are new. `never` are the archive's own
/// folders; `machine` is this Mac's name, whose live homes are kept already.
pub(crate) fn plan(db: &Connection, folder: &Path, never: &[PathBuf], machine: &str) -> Result<Plan, String> {
    let folder = fs::canonicalize(folder).ok().filter(|folder| folder.is_dir()).ok_or("That folder isn’t there.")?;
    let never: Vec<PathBuf> = never.iter().map(|path| canonical(path)).collect();
    if never.iter().any(|path| folder.starts_with(path)) {
        return Err("That folder is part of the archive itself.".into());
    }
    let found = find_homes(&folder, &never);
    let live: HashSet<PathBuf> = {
        let mut statement = db.prepare("SELECT root FROM sources WHERE kind = 'home' AND machine = ?1").map_err(db_error)?;
        let rows = statement.query_map([machine], |row| row.get::<_, String>(0)).map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)?.iter().map(|root| canonical(Path::new(root))).collect()
    };
    let mut imported = db.prepare("SELECT 1 FROM import_roots WHERE root = ?1").map_err(db_error)?;
    let mut roots = Vec::new();
    for home in found.homes {
        let live = home.layout == HOME && live.contains(&canonical(&home.root));
        let root = ImportRoot { agent: home.agent.into(), root: home.root.to_string_lossy().into_owned(), layout: home.layout.into(), machine: None };
        roots.push((root, live));
    }
    let mut homes = Vec::new();
    for (home, live) in roots {
        let state = if live {
            ImportHomeState::Live
        } else if imported.exists([&home.root]).map_err(db_error)? {
            ImportHomeState::Imported
        } else {
            ImportHomeState::New
        };
        homes.push(PlannedHome { home, state });
    }
    Ok(Plan { path: folder.to_string_lossy().into_owned(), homes, partial: found.partial })
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "ImportPreviewHome")]
pub(crate) struct PreviewHome {
    /// claude or codex for a home; the layout's own name for OpenClaw and Claude desktop sessions.
    agent: String,
    root: String,
    /// home: a copied agent home; otherwise openclaw or claude-desktop.
    layout: String,
    state: ImportHomeState,
    files: u64,
    bytes: u64,
    sessions: u64,
}

/// What the page shows before an import: paths, counts, sizes and file times, nothing a file says.
#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportPreview {
    path: String,
    homes: Vec<PreviewHome>,
    /// Sessions in the new homes, by the ids their file names carry, and how many the archive doesn't have.
    sessions: u64,
    new_sessions: u64,
    files: u64,
    bytes: u64,
    /// The oldest and newest session file, by when each was last changed.
    first_at: Option<i64>,
    last_at: Option<i64>,
    /// Arbor stopped looking before it had looked everywhere.
    partial: bool,
    /// Machines the backup could have come from, this Mac first.
    machines: Vec<String>,
}

/// Sums up a listing of the plan's new homes.
pub(crate) fn preview(db: &Connection, plan: &Plan, listing: &Listing, machines: Vec<String>) -> Result<ImportPreview, String> {
    let mut homes: Vec<PreviewHome> = plan
        .homes
        .iter()
        .map(|planned| PreviewHome {
            agent: planned.home.agent.clone(),
            root: planned.home.root.clone(),
            layout: planned.home.layout.clone(),
            state: planned.state,
            files: 0,
            bytes: 0,
            sessions: 0,
        })
        .collect();
    let at: HashMap<String, usize> = homes.iter().enumerate().filter(|(_, home)| home.state == ImportHomeState::New).map(|(index, home)| (home.root.clone(), index)).collect();
    let mut sessions: HashSet<(String, String)> = HashSet::new();
    let (mut first_at, mut last_at) = (None::<i64>, None::<i64>);
    for root in &listing.roots {
        let Some(home) = at.get(&root.home).and_then(|index| homes.get_mut(*index)) else {
            continue;
        };
        let mut own = HashSet::new();
        for file in root.files.iter().filter(|file| allowed(&root.agent, &file.rel_path)) {
            home.files += 1;
            home.bytes += file.size;
            // Named from the file name alone, as the agents name them; the import reads a rollout's own id.
            let key = identity::resolve(&root.agent, "", "", &file.rel_path, || None).filter(|key| key.agent != "side").map(|key| (key.agent, key.session_id));
            let Some(key) = key else {
                continue;
            };
            let at = file.mtime.saturating_mul(1000);
            first_at = Some(first_at.map_or(at, |first| first.min(at)));
            last_at = Some(last_at.map_or(at, |last| last.max(at)));
            own.insert(key);
        }
        home.sessions = own.len() as u64;
        sessions.extend(own);
    }
    let mut kept = db.prepare("SELECT 1 FROM sessions WHERE agent = ?1 AND session_id = ?2").map_err(db_error)?;
    let mut new_sessions = 0;
    for (agent, id) in &sessions {
        if !kept.exists(params![agent, id]).map_err(db_error)? {
            new_sessions += 1;
        }
    }
    let new = homes.iter().filter(|home| home.state == ImportHomeState::New);
    let (files, bytes) = new.fold((0, 0), |(files, bytes), home| (files + home.files, bytes + home.bytes));
    Ok(ImportPreview {
        path: plan.path.clone(),
        homes,
        sessions: sessions.len() as u64,
        new_sessions,
        files,
        bytes,
        first_at,
        last_at,
        partial: plan.partial,
        machines,
    })
}

fn machine_name(name: &str) -> Option<&str> {
    let name = name.trim();
    (!name.is_empty() && name.chars().count() <= MACHINE_NAME_MAX && !name.chars().any(char::is_control)).then_some(name)
}

/// Records an import of the plan's new homes, filed under `machine`. The next pass starts it.
pub(crate) fn add(db: &Connection, plan: &Plan, machine: &str) -> Result<i64, String> {
    let roots = plan.new_roots();
    if roots.is_empty() {
        return Err(if plan.homes.is_empty() { "There are no sessions in that folder that Arbor can import." } else { "Everything in that folder is kept already." }.into());
    }
    let machine = machine_name(machine).ok_or("Choose the machine the backup came from.")?.to_string();
    let now = now_ms();
    let _writes = lock_writes();
    let transaction = db.unchecked_transaction().map_err(db_error)?;
    transaction.execute("INSERT INTO imports(path, machine, added_at) VALUES(?1, ?2, ?3)", params![plan.path, machine, now]).map_err(db_error)?;
    let id = transaction.last_insert_rowid();
    for root in &roots {
        transaction
            .execute(
                "INSERT INTO import_roots(root, import_id, agent, layout, machine) VALUES(?1, ?2, ?3, ?4, ?5)",
                params![root.root, id, root.agent, root.layout, root.machine],
            )
            .map_err(db_error)?;
    }
    let listed: Vec<serde_json::Value> = roots
        .iter()
        .map(|root| json!({"agent": root.agent, "root": root.root, "layout": root.layout, "machine": root.machine}))
        .collect();
    emit(&transaction, json!({"t": "import", "id": id, "path": plan.path, "machine": machine, "roots": listed, "at": now}))?;
    transaction.commit().map_err(db_error)?;
    Ok(id)
}

/// Stops an import that hasn't finished. What it kept stays kept, and its homes can be imported again.
pub(crate) fn cancel(db: &Connection, id: i64) -> Result<(), String> {
    let _writes = lock_writes();
    let transaction = db.unchecked_transaction().map_err(db_error)?;
    if transaction.execute("DELETE FROM imports WHERE import_id = ?1 AND finished_at IS NULL", [id]).map_err(db_error)? == 0 {
        return Err("That import has finished already.".into());
    }
    emit(&transaction, json!({"t": "import-stopped", "id": id, "at": now_ms()}))?;
    transaction.commit().map_err(db_error)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PendingImport {
    pub(crate) id: i64,
    pub(crate) path: String,
    pub(crate) machine: String,
    pub(crate) roots: Vec<ImportRoot>,
}

/// Imports not finished yet, oldest first.
pub(crate) fn pending(db: &Connection) -> Result<Vec<PendingImport>, String> {
    let mut statement = db.prepare("SELECT import_id, path, machine FROM imports WHERE finished_at IS NULL ORDER BY import_id").map_err(db_error)?;
    let rows = statement.query_map([], |row| Ok(PendingImport { id: row.get(0)?, path: row.get(1)?, machine: row.get(2)?, roots: Vec::new() })).map_err(db_error)?;
    let mut imports: Vec<PendingImport> = rows.collect::<Result<_, _>>().map_err(db_error)?;
    let mut roots = db.prepare("SELECT agent, root, layout, machine FROM import_roots WHERE import_id = ?1 ORDER BY root").map_err(db_error)?;
    for import in &mut imports {
        import.roots = roots
            .query_map([import.id], |row| Ok(ImportRoot { agent: row.get(0)?, root: row.get(1)?, layout: row.get(2)?, machine: row.get(3)? }))
            .map_err(db_error)?
            .collect::<Result<_, _>>()
            .map_err(db_error)?;
    }
    Ok(imports)
}

/// Keeps what's in the listed imports, one after another, within `options`' share. Returns
/// whether one stopped at its share with more to read. An import whose pass kept everything
/// while its folder was still there is finished.
pub(crate) fn run(db: &Connection, places: &Places, listed: &[(PendingImport, Result<Listing, String>)], options: &PassOptions, stop: &dyn Fn() -> bool) -> Result<bool, String> {
    let started = Instant::now();
    let mut bytes_read = 0;
    for (import, listing) in listed {
        if options.max_bytes <= bytes_read || options.max_time <= started.elapsed() || stop() {
            return Ok(true);
        }
        let listing = match listing {
            Ok(listing) => listing,
            Err(error) => {
                note(db, import.id, None, 0, Some(error))?;
                continue;
            }
        };
        // Each machine's roots are a pass of their own, filed under that machine.
        let mut by_machine: BTreeMap<&str, Listing> = BTreeMap::new();
        for listed in &listing.roots {
            let machine = import.roots.iter().find(|root| root.root == listed.home).and_then(|root| root.machine.as_deref()).unwrap_or(&import.machine);
            by_machine.entry(machine).or_insert_with(|| Listing { ended: listing.ended, ..Listing::default() }).roots.push(listed.clone());
        }
        let (mut complete, mut failures, mut first_failure) = (true, 0, None);
        for (machine, part) in by_machine {
            let (Some(max_bytes), Some(max_time)) = (options.max_bytes.checked_sub(bytes_read).filter(|left| *left > 0), options.max_time.checked_sub(started.elapsed())) else {
                complete = false;
                break;
            };
            let import_options = PassOptions {
                machine: machine.to_string(),
                user_home: None,
                limits: options.limits,
                bytes_per_second: options.bytes_per_second,
                max_bytes,
                max_time,
                import: true,
                sessions: SessionFilter::everything(),
            };
            let report = run_pass(db, places, &part, &import_options, stop)?;
            bytes_read += report.bytes_read;
            failures += report.failures;
            first_failure = first_failure.or(report.first_failure);
            if !report.complete {
                complete = false;
                break;
            }
        }
        let whole = complete && listing.ended && Path::new(&import.path).is_dir();
        let unlisted = import.roots.iter().any(|root| !listing.roots.iter().any(|listed| listed.home == root.root && listed.complete));
        let error = first_failure.or_else(|| (whole && unlisted).then(|| "Some of its folders couldn’t be read.".to_string()));
        note(db, import.id, whole.then(now_ms), failures, error.as_deref())?;
        if !complete {
            return Ok(true);
        }
    }
    Ok(false)
}

fn note(db: &Connection, id: i64, finished_at: Option<i64>, failures: u64, error: Option<&str>) -> Result<(), String> {
    let _writes = lock_writes();
    let transaction = db.unchecked_transaction().map_err(db_error)?;
    transaction
        .execute("UPDATE imports SET finished_at = ?2, failures = ?3, error = ?4 WHERE import_id = ?1", params![id, finished_at, failures as i64, error])
        .map_err(db_error)?;
    if let Some(at) = finished_at {
        emit(&transaction, json!({"t": "imported", "id": id, "at": at}))?;
    }
    transaction.commit().map_err(db_error)
}

/// An old backup taken in, or being taken in. Its homes are kept like a live home's, filed under
/// `machine`.
#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "ArchiveImport")]
pub(crate) struct ImportStatus {
    id: i64,
    /// The folder the user chose.
    path: String,
    machine: String,
    /// Every machine its homes are filed under.
    machines: Vec<String>,
    homes: u64,
    /// Files listed in its homes so far, how many are kept, and the sessions they belong to.
    files: u64,
    kept: u64,
    sessions: u64,
    added_at: i64,
    finished_at: Option<i64>,
    /// Its folder is there to read, which it isn't while its drive is unplugged.
    connected: bool,
    failures: u64,
    error: Option<String>,
}

/// Every import, newest first.
pub(crate) fn statuses(db: &Connection) -> Result<Vec<ImportStatus>, String> {
    let mut statement = db
        .prepare(
            "SELECT i.import_id, i.path, i.machine, i.added_at, i.finished_at, i.failures, i.error,
               (SELECT COUNT(*) FROM import_roots r WHERE r.import_id = i.import_id),
               (SELECT COUNT(f.file_id) FROM import_roots r JOIN sources s ON s.machine = COALESCE(r.machine, i.machine) AND s.root = r.root
                  JOIN files f ON f.source_id = s.source_id WHERE r.import_id = i.import_id AND f.state IN ('live', 'unreachable', 'gone')),
               (SELECT COUNT(f.file_id) FROM import_roots r JOIN sources s ON s.machine = COALESCE(r.machine, i.machine) AND s.root = r.root
                  JOIN files f ON f.source_id = s.source_id WHERE r.import_id = i.import_id AND f.version_id IS NOT NULL),
               (SELECT COUNT(DISTINCT m.session_pk) FROM import_roots r JOIN sources s ON s.machine = COALESCE(r.machine, i.machine) AND s.root = r.root
                  JOIN files f ON f.source_id = s.source_id JOIN members m ON m.member_id = f.member_id
                  JOIN sessions n ON n.session_pk = m.session_pk WHERE r.import_id = i.import_id AND n.agent != 'side')
             FROM imports i ORDER BY i.import_id DESC",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            let path: String = row.get(1)?;
            Ok(ImportStatus {
                id: row.get(0)?,
                connected: Path::new(&path).is_dir(),
                path,
                machine: row.get(2)?,
                machines: Vec::new(),
                added_at: row.get(3)?,
                finished_at: row.get(4)?,
                failures: row.get::<_, i64>(5)?.max(0) as u64,
                error: row.get(6)?,
                homes: row.get::<_, i64>(7)? as u64,
                files: row.get::<_, i64>(8)? as u64,
                kept: row.get::<_, i64>(9)? as u64,
                sessions: row.get::<_, i64>(10)? as u64,
            })
        })
        .map_err(db_error)?;
    let mut imports: Vec<ImportStatus> = rows.collect::<Result<_, _>>().map_err(db_error)?;
    // Roots an older version filed under a machine of their own, as well as the import's.
    let mut roots = db.prepare("SELECT DISTINCT machine FROM import_roots WHERE import_id = ?1 AND machine IS NOT NULL").map_err(db_error)?;
    let mut others = db.prepare("SELECT 1 FROM import_roots WHERE import_id = ?1 AND machine IS NULL").map_err(db_error)?;
    for import in &mut imports {
        let mut machines: BTreeSet<String> = roots.query_map([import.id], |row| row.get(0)).map_err(db_error)?.collect::<Result<_, _>>().map_err(db_error)?;
        if machines.is_empty() || others.exists([import.id]).map_err(db_error)? {
            machines.insert(import.machine.clone());
        }
        import.machines = machines.into_iter().collect();
    }
    Ok(imports)
}

#[cfg(test)]
mod tests {
    use super::super::ingest::tests::{walk, Fixture, SECRET_TEXT, SID, THREAD};
    use super::super::lister::{parse, roots_script, tests::run_list};
    use super::super::{classify, journal, store::tests::temp_dir};
    use super::*;

    const SID2: &str = "0f8b5c2e-1111-4222-8333-777788889999";

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn claude_lines(sid: &str, count: usize) -> String {
        (0..count).map(|n| format!("{{\"type\":\"user\",\"sessionId\":\"{sid}\",\"n\":{n},\"text\":\"{SECRET_TEXT}\"}}\n")).collect()
    }

    fn rollout(thread: &str) -> String {
        format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{thread}\",\"instructions\":\"{SECRET_TEXT}\"}}}}\n")
    }

    fn roots(found: &Found, base: &Path) -> Vec<(&'static str, String)> {
        found.homes.iter().map(|home| (home.agent, home.root.strip_prefix(base).unwrap().to_string_lossy().into_owned())).collect()
    }

    #[test]
    fn finds_the_homes_in_a_backup_and_nothing_else() {
        let base = temp_dir("imports-find");
        let base = fs::canonicalize(&base).unwrap();
        write(&base.join(format!("Moved/dot-claude/projects/-Users-me-app/{SID}.jsonl")), "{}\n");
        let user = base.join("Codex Backups/b1/filesystem/Users/me");
        write(&user.join(format!(".codex/sessions/2026/01/02/rollout-2026-01-02T00-00-00-{THREAD}.jsonl")), "{}\n");
        write(&user.join(format!(".codex-2/archived_sessions/rollout-2026-01-02T00-00-00-{THREAD}.jsonl.zst")), "x");
        write(&user.join(format!(".t3/provider-homes/claude-proxy/projects/-x/{SID}.jsonl")), "{}\n");
        write(&user.join(format!(".skipper/profiles/work2/projects/-y/{SID}.jsonl")), "{}\n");
        write(&base.join(format!("orca/sessions/2026/07/rollout-2026-07-01T00-00-00-{THREAD}.jsonl")), "{}\n");
        // A projects folder that isn't Claude Code's, and homes where nobody keeps one.
        write(&base.join("notes/projects/readme.md"), "x");
        write(&base.join(format!("src/app/node_modules/pkg/projects/-z/{SID}.jsonl")), "{}\n");
        write(&base.join(format!("archive.noindex/projects/-a/{SID}.jsonl")), "{}\n");
        // A home inside a home is the outer one's business.
        write(&base.join(format!("Moved/dot-claude/backups/projects/-b/{SID}.jsonl")), "{}\n");

        let found = find_homes(&base, &[base.join("archive.noindex")]);
        assert!(!found.partial);
        assert_eq!(
            roots(&found, &base),
            [
                ("codex", "orca".to_string()),
                ("claude", "Moved/dot-claude".to_string()),
                ("codex", "Codex Backups/b1/filesystem/Users/me/.codex".to_string()),
                ("codex", "Codex Backups/b1/filesystem/Users/me/.codex-2".to_string()),
                ("claude", "Codex Backups/b1/filesystem/Users/me/.skipper/profiles/work2".to_string()),
                ("claude", "Codex Backups/b1/filesystem/Users/me/.t3/provider-homes/claude-proxy".to_string()),
            ]
        );
        // A folder chosen inside a home means the home.
        let inside = find_homes(&base.join("Moved/dot-claude/projects"), &[]);
        assert_eq!(roots(&inside, &base), [("claude", "Moved/dot-claude".to_string())]);
        assert!(find_homes(&base.join("notes"), &[]).homes.is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    fn listing(roots: &[ImportRoot]) -> Listing {
        let mut listed = parse(&run_list("sh", Path::new("/nonexistent-home"), &roots_script(&home_roots(roots))));
        list_layouts(roots, &mut listed);
        listed
    }

    fn options(max_bytes: u64) -> PassOptions {
        PassOptions {
            machine: "mini".into(),
            user_home: None,
            limits: classify::tests::SMALL,
            bytes_per_second: 1 << 40,
            max_bytes,
            max_time: Duration::from_secs(600),
            import: false,
            sessions: SessionFilter::everything(),
        }
    }

    /// Lists the pending imports and runs them, as a pass does. Returns whether one stopped at its share.
    fn run_imports(fixture: &Fixture, max_bytes: u64) -> bool {
        let listed: Vec<(PendingImport, Result<Listing, String>)> = pending(&fixture.db)
            .unwrap()
            .into_iter()
            .filter(|import| Path::new(&import.path).is_dir())
            .map(|import| {
                let listed = listing(&import.roots);
                (import, Ok(listed))
            })
            .collect();
        let left = run(&fixture.db, &fixture.places, &listed, &options(max_bytes), &|| false).unwrap();
        journal::flush(&fixture.db, &fixture.places.store).unwrap();
        left
    }

    /// A backup beside the fixture's home: an older copy of the live session, one only there, and a Codex home.
    fn backup(fixture: &Fixture) -> PathBuf {
        let backup = fs::canonicalize(&fixture.base).unwrap().join("drive/Moved");
        write(&backup.join(format!("dot-claude/projects/-Users-me-app/{SID}.jsonl")), &claude_lines(SID, 3));
        write(&backup.join(format!("dot-claude/projects/-Users-me-app/{SID2}.jsonl")), &claude_lines(SID2, 30));
        write(&backup.join("dot-claude/settings.json"), &format!("{{\"env\":{{\"TOKEN\":\"{SECRET_TEXT}\"}}}}"));
        write(&backup.join(format!("codex/sessions/2026/01/02/rollout-2026-01-02T00-00-00-{THREAD}.jsonl")), &rollout(THREAD));
        backup
    }

    #[test]
    fn an_import_keeps_a_backup_once_and_then_leaves_it_be() {
        let fixture = Fixture::new("imports");
        fixture.write(&format!(".claude/projects/-Users-me-app/{SID}.jsonl"), &claude_lines(SID, 10));
        fixture.pass();
        let backup = backup(&fixture);
        let never = [fixture.places.store.root().to_path_buf()];

        let plan = plan(&fixture.db, &backup, &never, "mac").unwrap();
        assert_eq!(plan.homes.iter().map(|home| (home.home.agent.as_str(), home.state)).collect::<Vec<_>>(), [("codex", ImportHomeState::New), ("claude", ImportHomeState::New)]);
        let shown = preview(&fixture.db, &plan, &listing(&plan.new_roots()), vec!["mac".into(), "cedar".into()]).unwrap();
        assert_eq!((shown.sessions, shown.new_sessions, shown.files), (3, 2, 3), "the live session is kept already; settings aren't sessions");
        assert!(shown.first_at.is_some() && shown.first_at <= shown.last_at);

        let id = add(&fixture.db, &plan, "mini").unwrap();
        assert!(add(&fixture.db, &super::plan(&fixture.db, &backup, &never, "mac").unwrap(), "mini").is_err(), "the same homes aren't imported twice");
        // A share too small for the whole backup stops, and the next carries on.
        assert!(run_imports(&fixture, 1));
        assert!(statuses(&fixture.db).unwrap()[0].finished_at.is_none());
        while run_imports(&fixture, 1) {}
        let status = &statuses(&fixture.db).unwrap()[0];
        assert_eq!((status.id, status.homes, status.files, status.kept, status.sessions, status.connected), (id, 2, 3, 3, 3, true));
        assert!(status.finished_at.is_some() && status.error.is_none());
        assert!(pending(&fixture.db).unwrap().is_empty(), "a finished backup isn't listed again");
        assert!(cancel(&fixture.db, id).is_err());

        // Filed under the machine it came from, settled, and the session in both is one session.
        assert_eq!(fixture.count("SELECT COUNT(*) FROM sources WHERE kind = 'import' AND machine = 'mini'"), 2);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM sessions WHERE agent != 'side'"), 3);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM versions WHERE state = 'growing'"), 1, "only the live session grows");
        assert_eq!(fixture.count("SELECT COUNT(*) FROM files WHERE rel_path LIKE '%settings%'"), 0);
        // Its homes are kept already, so choosing the folder again finds nothing new.
        let again = super::plan(&fixture.db, &backup, &never, "mac").unwrap();
        assert!(again.homes.iter().all(|home| home.state == ImportHomeState::Imported));
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn a_backup_on_an_unplugged_drive_waits_and_a_stopped_one_can_be_started_again() {
        let fixture = Fixture::new("imports-away");
        let backup = backup(&fixture);
        let never = [fixture.places.store.root().to_path_buf()];
        let first = add(&fixture.db, &plan(&fixture.db, &backup, &never, "mac").unwrap(), "mac").unwrap();
        let unplugged = backup.with_file_name("unplugged");
        fs::rename(&backup, &unplugged).unwrap();
        assert!(!run_imports(&fixture, 1 << 40), "nothing to do until it's back");
        let status = &statuses(&fixture.db).unwrap()[0];
        assert_eq!((status.connected, status.finished_at, status.files), (false, None, 0));
        // Unplugged partway through a pass: what was listed can't be read, so it isn't finished.
        fs::rename(&unplugged, &backup).unwrap();
        let listed: Vec<_> = pending(&fixture.db).unwrap().into_iter().map(|import| {
            let listed = listing(&import.roots);
            (import, Ok(listed))
        }).collect();
        fs::rename(&backup, &unplugged).unwrap();
        run(&fixture.db, &fixture.places, &listed, &options(1 << 40), &|| false).unwrap();
        assert!(statuses(&fixture.db).unwrap()[0].finished_at.is_none());
        fs::rename(&unplugged, &backup).unwrap();

        cancel(&fixture.db, first).unwrap();
        assert!(statuses(&fixture.db).unwrap().is_empty());
        assert!(cancel(&fixture.db, first).is_err());
        let second = add(&fixture.db, &plan(&fixture.db, &backup, &never, "mac").unwrap(), "mac").unwrap();
        assert!(!run_imports(&fixture, 1 << 40));
        assert!(statuses(&fixture.db).unwrap().iter().any(|status| status.id == second && status.finished_at.is_some()));
        assert!(plan(&fixture.db, &fixture.places.store.root().join("chunks"), &never, "mac").is_err(), "the archive can't import itself");
        assert!(add(&fixture.db, &plan(&fixture.db, &fixture.base.join("index"), &never, "mac").unwrap(), "mac").is_err(), "nothing to import");
        assert!(add(&fixture.db, &plan(&fixture.db, &backup, &never, "mac").unwrap(), " ").is_err());
        let _ = fs::remove_dir_all(&fixture.base);
    }

    const SID3: &str = "0f8b5c2e-1111-4222-8333-aaaabbbbcccc";
    const THREAD3: &str = "019a1b2c-3d4e-7f00-8111-88889999aaaa";
    /// What sign-ins and session settings hold, which is never kept, not even in the store's chunks.
    const SIGN_IN: &str = "SIGN-IN-9c2e-never-kept-anywhere";

    /// A drive with an OpenClaw agent and Claude's desktop app's local sessions, each with the sign-ins and settings
    /// kept beside them.
    fn other_layouts(fixture: &Fixture) -> PathBuf {
        let drive = fs::canonicalize(&fixture.base).unwrap().join("drive2");
        let claw = drive.join("openclaw-agents/main");
        write(&claw.join(format!("sessions/{SID2}.jsonl")), &claude_lines(SID2, 2));
        write(&claw.join("sessions/sessions.json"), "{}");
        write(&claw.join("agent/auth-profiles.json"), SIGN_IN);
        write(&claw.join(format!("agent/codex-home/sessions/2026/05/16/rollout-2026-05-16T00-00-00-{THREAD3}.jsonl")), &rollout(THREAD3));
        write(&claw.join("agent/codex-home/auth.json"), SIGN_IN);
        let desktop = drive.join("local-agent-mode-sessions/acct/org");
        write(&desktop.join(format!("local_{SID2}.json")), &format!("{{\"remoteMcpServersConfig\":\"{SIGN_IN}\"}}"));
        write(&desktop.join(format!("local_{SID2}/audit.jsonl")), &claude_lines(SID2, 1));
        write(&desktop.join(format!("local_{SID2}/.audit-key")), SIGN_IN);
        write(&desktop.join(format!("local_{SID2}/.claude/projects/-sessions-x/{SID3}.jsonl")), &claude_lines(SID3, 2));
        drive
    }

    #[test]
    fn backups_in_other_layouts_are_kept_without_what_sits_beside_them() {
        let fixture = Fixture::new("imports-layouts");
        let drive = other_layouts(&fixture);
        let never = [fixture.places.store.root().to_path_buf()];
        let plan = plan(&fixture.db, &drive, &never, "mac").unwrap();
        let names: Vec<(String, String, String)> = plan
            .homes
            .iter()
            .map(|home| (home.home.layout.clone(), home.home.agent.clone(), home.home.root.strip_prefix(&*drive.to_string_lossy()).unwrap().to_string()))
            .collect();
        let named = |layout: &str, agent: &str, root: &str| (layout.to_string(), agent.to_string(), root.to_string());
        assert_eq!(
            names,
            [
                named("openclaw", "openclaw", "/openclaw-agents/main"),
                named("home", "codex", "/openclaw-agents/main/agent/codex-home"),
                named("claude-desktop", "claude-desktop", "/local-agent-mode-sessions/acct/org"),
                named("home", "claude", &format!("/local-agent-mode-sessions/acct/org/local_{SID2}/.claude")),
            ]
        );
        let shown = preview(&fixture.db, &plan, &listing(&plan.new_roots()), vec!["mini".into()]).unwrap();
        // Claude SID3, Codex THREAD3, and OpenClaw's and the desktop app's sessions.
        assert_eq!((shown.sessions, shown.new_sessions), (4, 4));

        add(&fixture.db, &plan, "mini").unwrap();
        while run_imports(&fixture, 1 << 40) {}
        let status = &statuses(&fixture.db).unwrap()[0];
        assert!(status.finished_at.is_some() && status.error.is_none() && status.failures == 0, "{status:?}");
        assert_eq!((status.machines.clone(), status.homes), (vec!["mini".to_string()], 4));
        let agents: Vec<(String, i64)> = fixture
            .db
            .prepare("SELECT agent, COUNT(*) FROM sessions WHERE agent != 'side' GROUP BY agent ORDER BY agent")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let expected: Vec<(String, i64)> = [("claude", 1), ("claude-desktop", 1), ("codex", 1), ("openclaw", 1)].iter().map(|(agent, count)| (agent.to_string(), *count)).collect();
        assert_eq!(agents, expected);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM files WHERE rel_path LIKE '%auth%' OR rel_path LIKE '%.audit-key' OR rel_path LIKE 'local_%.json'"), 0);
        // Sign-ins and session settings aren't anywhere in the store, chunks included.
        let secret = SIGN_IN.as_bytes();
        for path in walk(fixture.places.store.root()) {
            let bytes = fs::read(&path).unwrap();
            let bytes = super::super::codec::decode(&bytes).unwrap_or(bytes);
            assert!(!bytes.windows(secret.len()).any(|window| window == secret), "{}", path.display());
        }
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn an_import_from_an_older_version_in_a_layout_no_longer_listed_still_finishes() {
        let fixture = Fixture::new("imports-legacy-layout");
        let drive = fs::canonicalize(&fixture.base).unwrap().join("drive4");
        fs::create_dir_all(drive.join("review-archive")).unwrap();
        let root = drive.join("review-archive").to_string_lossy().into_owned();
        fixture.db.execute("INSERT INTO imports(import_id, path, machine, added_at) VALUES(9, ?1, 'mini', 1)", [drive.to_string_lossy()]).unwrap();
        fixture.db.execute("INSERT INTO import_roots(root, import_id, agent, layout) VALUES(?1, 9, 'tilde', 'tilde')", [&root]).unwrap();
        while run_imports(&fixture, 1 << 40) {}
        let status = &statuses(&fixture.db).unwrap()[0];
        assert!(status.finished_at.is_some(), "{status:?}");
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn an_openclaw_backup_counts_its_own_calls_once() {
        use super::super::tokens::{count_pass, lifetime, tests::openclaw_line, CountOptions};
        let fixture = Fixture::new("imports-openclaw-tokens");
        let drive = fs::canonicalize(&fixture.base).unwrap().join("drive3");
        let sessions = drive.join("openclaw-agents/main/sessions");
        let at = "2026-05-02T01:00:00.000Z";
        let own = openclaw_line("e1", Some("resp_1"), false, at, (10, 0, 900, 50), SECRET_TEXT);
        write(&sessions.join(format!("{SID}.jsonl")), &[own.clone(), openclaw_line("e2", None, true, at, (1_000, 0, 9_000, 100), SECRET_TEXT)].concat());
        // The session again after a reset, and its trajectory, which repeats the call.
        write(&sessions.join(format!("{SID2}.jsonl")), &own);
        write(&sessions.join(format!("{SID}.trajectory.jsonl")), &own);
        write(&sessions.join("sessions.json"), "{}");
        fs::create_dir_all(drive.join("openclaw-agents/main/agent")).unwrap();
        let never = [fixture.places.store.root().to_path_buf()];
        add(&fixture.db, &plan(&fixture.db, &drive, &never, "mac").unwrap(), "mini").unwrap();
        while run_imports(&fixture, 1 << 40) {}
        let options = CountOptions { bytes_per_second: 1 << 40, max_bytes: 1 << 40, max_time: std::time::Duration::from_secs(600) };
        let report = count_pass(&fixture.db, &fixture.places, &options, &|| false).unwrap();
        assert!(report.complete && report.failures == 0, "{report:?}");
        let lifetime = serde_json::to_value(lifetime(&fixture.db).unwrap()).unwrap();
        let months = lifetime["months"].as_array().unwrap();
        let rows: Vec<String> = months.iter().map(|row| format!("{} {} {} {} {}", row["machine"], row["agent"], row["model"], row["calls"], row["input"].as_u64().unwrap() + row["cacheRead"].as_u64().unwrap() + row["output"].as_u64().unwrap())).collect();
        assert_eq!(rows, ["\"mini\" \"openclaw\" \"gpt-5.5\" 1 960"]);
        let json = lifetime.to_string();
        assert!(!json.contains(SECRET_TEXT) && !json.contains("resp_1"), "{json}");
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn importing_keeps_transcript_text_out_of_the_index_and_the_page() {
        let fixture = Fixture::new("imports-secret");
        let backup = backup(&fixture);
        let never = [fixture.places.store.root().to_path_buf()];
        let plan = plan(&fixture.db, &backup, &never, "mac").unwrap();
        let listed = listing(&plan.new_roots());
        let shown = preview(&fixture.db, &plan, &listed, vec!["mac".into()]).unwrap();
        add(&fixture.db, &plan, "mac").unwrap();
        run_imports(&fixture, 1 << 40);
        // And backups in every other layout, whose indexes and logs say things too.
        let drive = other_layouts(&fixture);
        let others = super::plan(&fixture.db, &drive, &never, "mac").unwrap();
        let others_shown = preview(&fixture.db, &others, &listing(&others.new_roots()), vec!["mac".into()]).unwrap();
        add(&fixture.db, &others, "mac").unwrap();
        while run_imports(&fixture, 1 << 40) {}
        let status = super::super::status_from(&fixture.db, &super::super::Runtime::default(), None).unwrap();
        let secret = SECRET_TEXT.as_bytes();
        let contains = |bytes: &[u8]| bytes.windows(secret.len()).any(|window| window == secret);
        assert_eq!(status.imports.len(), 2);
        assert!(status.imports.iter().all(|import| import.finished_at.is_some()));
        for json in [
            serde_json::to_string(&shown).unwrap(),
            serde_json::to_string(&others_shown).unwrap(),
            serde_json::to_string(&status).unwrap(),
            serde_json::to_string(&statuses(&fixture.db).unwrap()).unwrap(),
        ] {
            assert!(!contains(json.as_bytes()));
        }
        fixture.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        assert!(!contains(&fs::read(&fixture.db_path).unwrap()));
        for path in walk(&fixture.places.store.root().join("journal")) {
            assert!(!contains(&fs::read(&path).unwrap()), "{}", path.display());
        }
        let _ = fs::remove_dir_all(&fixture.base);
    }
}

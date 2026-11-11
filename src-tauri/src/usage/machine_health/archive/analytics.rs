//! Session analytics: the kept transcripts as tables, in the store's `analytics/` folder, for `arbor query`.
//!
//! The tables are made from `chunks/` and can be made again, so nothing here is the only copy of anything. Reading
//! a transcript's lines into rows is `session_tables`' work, and its alone: this file hands it bytes and never
//! looks at a line itself. Everything the tables need is inside `analytics/` (the Parquet files, their manifest,
//! and `state.db` with how far each version is read), so `archive.db` and the journal hold nothing of them, and
//! removing the folder starts them again.
//!
//! Rows are only added, so a version is read from where it was last read to. How far that is, is noted in
//! `state.db` in two steps around each write, so a pass stopped at any moment neither loses rows nor adds them twice:
//! what the write will have read is staged with the number the write takes, and becomes the progress once the tables
//! hold a write of that number.
//!
//! A session can be kept more than once: an earlier copy in a backup beside the finished one, or one that carried
//! on from another and copied its lines. `state.db` holds a short key for every line read and the version it was
//! first read from, and the same line met in another version is marked as a repeat. The keys are staged with the
//! progress, since a key says its line's rows are in the tables.
//!
//! The proxy's own requests are a table too, copied from usage.db in the order the proxy numbered them. How far
//! that has got is a cursor in `state.db`, staged around each write as the progress is.

use super::classify::{load_version, Blobs, Version};
use super::codec;
use super::ingest::Throttle;
use super::tokens::{pieces, read_piece, retry_wait, Piece};
use rusqlite::{params, Connection, OptionalExtension};
use session_tables::store::{Batch, Engine, Origin, Store as Tables, DUCKDB_ARCHIVES, DUCKDB_VERSION};
use session_tables::{Agent, At, Detail, Line, LineKey, Parser, ProxyRequest, PullRequestCheck, Rows, Seen, State, RULE};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The folder in a store.
pub(crate) const FOLDER: &str = "analytics";
/// A table's fresh files are folded into months once there are this many.
pub(crate) const MERGE_AT: usize = 8;
/// A write is made once this much is waiting.
const BATCH_BYTES: u64 = 64 << 20;
/// A version's rows wait in memory until it's read to its end, unless it has this much to read: then what's
/// waiting is written first, and the version's rows follow as they're read.
const HELD_BYTES: u64 = 64 << 20;
/// A longer line isn't read into rows: it's noted with its size.
const LONG_LINE: usize = 256 << 20;

/// The versions that are an agent's transcripts, newest first so the latest months fill in first.
/// The members are the ones token counting reads (`tokens::UNCOUNTED`).
const TRANSCRIPTS: &str = "SELECT v.version_id, s.agent, v.size, v.state,
       (SELECT o_s.machine FROM observations o JOIN files f USING (file_id) JOIN sources o_s USING (source_id)
         WHERE o.version_id = v.version_id ORDER BY o.first_at, o.file_id LIMIT 1)
     FROM versions v JOIN members m USING (member_id) JOIN sessions s USING (session_pk)
     WHERE v.encoding IN ('plain', 'zstd')
       AND ((s.agent = 'claude' AND (m.member = 'main' OR m.member LIKE 'main~%' OR (m.member LIKE 'subagents/%' AND m.member LIKE '%.jsonl')))
         OR (s.agent = 'codex' AND (m.member = 'rollout' OR m.member LIKE 'rollout/%' OR m.member LIKE 'original/%'))
         OR (s.agent IN ('openclaw', 'pi') AND m.member = 'main'))
     ORDER BY COALESCE(v.grew_at, v.created_at) DESC, v.version_id DESC";

const STATE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
-- read_len is where the last whole line read ends; seen_len is the size last read to; lines is how many lines that
-- was. done is set once a version that won't grow again has given up its last row. state is the parser's.
CREATE TABLE IF NOT EXISTS progress(
  version_id INTEGER PRIMARY KEY, read_len INTEGER NOT NULL, seen_len INTEGER NOT NULL, lines INTEGER NOT NULL,
  done INTEGER NOT NULL, state TEXT NOT NULL) STRICT;
-- What progress becomes once the tables hold write number `batch`.
CREATE TABLE IF NOT EXISTS staged(
  version_id INTEGER PRIMARY KEY, batch INTEGER NOT NULL, read_len INTEGER NOT NULL, seen_len INTEGER NOT NULL,
  lines INTEGER NOT NULL, done INTEGER NOT NULL, state TEXT NOT NULL) STRICT;
-- A key for every line read, with the version it was first read from. Keys wait in seen_staged, as progress does.
CREATE TABLE IF NOT EXISTS seen(key BLOB PRIMARY KEY, version_id INTEGER NOT NULL) WITHOUT ROWID, STRICT;
CREATE TABLE IF NOT EXISTS seen_staged(key BLOB PRIMARY KEY, version_id INTEGER NOT NULL, batch INTEGER NOT NULL) WITHOUT ROWID, STRICT;
-- How far a table that isn't read from transcripts has been copied. It waits in cursor_staged, as progress does.
CREATE TABLE IF NOT EXISTS cursor(name TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS cursor_staged(name TEXT PRIMARY KEY, value INTEGER NOT NULL, batch INTEGER NOT NULL) STRICT;
-- A version that couldn't be read: at what size, how many times running, and when it's tried again
-- (`tokens::retry_wait`).
CREATE TABLE IF NOT EXISTS failed(
  version_id INTEGER PRIMARY KEY, size INTEGER NOT NULL, tries INTEGER NOT NULL, retry_at INTEGER NOT NULL) STRICT;
";


pub(crate) struct ExtractOptions {
    pub(crate) detail: Detail,
    pub(crate) bytes_per_second: u64,
    /// Reading stops once it has read this much, or run this long, and carries on next pass.
    pub(crate) max_bytes: u64,
    pub(crate) max_time: Duration,
    /// A table's fresh files are folded into months once there are this many.
    pub(crate) merge_at: usize,
    /// The time, in seconds since 1970.
    pub(crate) now: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ExtractReport {
    /// Every version was read to its end.
    pub(crate) complete: bool,
    pub(crate) versions: u64,
    pub(crate) bytes_read: u64,
    pub(crate) rows: u64,
    pub(crate) failures: u64,
    pub(crate) first_failure: Option<String>,
    /// Kept transcripts with something still to read, once the pass ended.
    pub(crate) versions_left: u64,
    /// Kept transcripts that couldn't be read and aren't being tried for now.
    pub(crate) set_aside: u64,
    /// What the tables hold, once the pass ended.
    pub(crate) table_rows: u64,
    pub(crate) table_bytes: u64,
}

/// Where the engine is kept: beside Arbor's own data, never in a store.
fn engine_dir() -> Result<PathBuf, String> {
    Ok(crate::core_base_dir()?.join("query-engine"))
}

fn engine_folder() -> String {
    format!("duckdb-{DUCKDB_VERSION}")
}

/// DuckDB's program, which Arbor fetches when analytics is first turned on, if it's there.
pub(crate) fn engine() -> Option<Duck> {
    let path = engine_dir().ok()?.join(engine_folder()).join("duckdb");
    path.is_file().then_some(Duck(session_tables::store::Program { path }))
}

/// The pinned release's archive for this kind of machine: its name, SHA-256 and size.
fn pinned() -> Option<(&'static str, &'static str, u64)> {
    let system = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    DUCKDB_ARCHIVES.iter().find(|(target, ..)| *target == system).map(|(_, name, sha256, size)| (*name, *sha256, *size))
}

/// How much turning analytics on downloads, or nothing when there's no program for this kind of machine.
pub(crate) fn engine_download_bytes() -> Option<u64> {
    pinned().map(|(_, _, size)| size)
}

const WRONG_DOWNLOAD: &str = "The query engine download isn't the release Arbor expects, so it wasn't kept";
/// The most the program itself may unpack to. It is about 66 MB.
const ENGINE_MAX_BYTES: u64 = 512 << 20;

/// Fetches the pinned DuckDB program from its GitHub release, unless it's here already. Only the archive whose size
/// and SHA-256 are the pinned ones is unpacked, so nothing else is ever run.
pub(crate) async fn install_engine(client: &reqwest::Client) -> Result<(), String> {
    use futures_util::StreamExt;
    if engine().is_some() {
        return Ok(());
    }
    let (name, sha256, size) = pinned().ok_or("The query engine has no program for this kind of machine")?;
    let url = format!("https://github.com/duckdb/duckdb/releases/download/v{DUCKDB_VERSION}/{name}");
    let failed = |error: reqwest::Error| format!("Couldn't download the query engine: {error}");
    let response = client.get(&url).header(reqwest::header::USER_AGENT, crate::USER_AGENT).send().await.map_err(failed)?.error_for_status().map_err(failed)?;
    let mut archive: Vec<u8> = Vec::with_capacity(size as usize);
    let mut stream = response.bytes_stream();
    while let Some(piece) = stream.next().await {
        archive.extend_from_slice(&piece.map_err(failed)?);
        // A download that runs past the pinned size isn't the pinned archive, however it ends.
        if archive.len() as u64 > size {
            return Err(WRONG_DOWNLOAD.to_string());
        }
    }
    let dir = engine_dir()?;
    tauri::async_runtime::spawn_blocking(move || put_engine(&archive, sha256, size, &dir)).await.map_err(|error| error.to_string())?
}

/// Checks a downloaded archive against its pin and puts the program in it into place, then drops other releases'.
fn put_engine(archive: &[u8], sha256: &str, size: u64, dir: &Path) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let found: String = Sha256::digest(archive).iter().map(|byte| format!("{byte:02x}")).collect();
    if archive.len() as u64 != size || found != sha256 {
        return Err(WRONG_DOWNLOAD.to_string());
    }
    let folder = dir.join(engine_folder());
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&folder).map_err(|error| format!("Couldn't make {}: {error}", folder.display()))?;
    let unpacked = |error: std::io::Error| format!("Couldn't unpack the query engine: {error}");
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    let part = folder.join("duckdb.part");
    let mut placed = false;
    for entry in tar.entries().map_err(unpacked)? {
        let mut entry = entry.map_err(unpacked)?;
        // Only the program is taken, and only as a plain file: nothing in the archive chooses where it's written.
        if !entry.header().entry_type().is_file() || entry.path().map_err(unpacked)?.as_ref() != Path::new("duckdb") {
            continue;
        }
        let _ = std::fs::remove_file(&part);
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o700).open(&part).map_err(unpacked)?;
        let copied = std::io::copy(&mut (&mut entry).take(ENGINE_MAX_BYTES + 1), &mut file).map_err(unpacked)?;
        if copied > ENGINE_MAX_BYTES {
            let _ = std::fs::remove_file(&part);
            return Err(WRONG_DOWNLOAD.to_string());
        }
        file.sync_all().map_err(unpacked)?;
        std::fs::rename(&part, folder.join("duckdb")).map_err(unpacked)?;
        placed = true;
        break;
    }
    if !placed {
        return Err("The query engine download has no program in it".to_string());
    }
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if entry.path() != folder && entry.file_name().to_string_lossy().starts_with("duckdb-") {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

/// DuckDB, started the way every helper is: with none of Arbor's open files.
pub(crate) struct Duck(session_tables::store::Program);

impl Duck {
    pub(crate) fn program(&self) -> &session_tables::store::Program {
        &self.0
    }
}

impl Engine for Duck {
    fn run(&self, sql: &str) -> Result<String, String> {
        crate::keep_open_files_from_helpers();
        self.0.run(sql)
    }
}

/// What the last pass left the tables as, for the status to read without reaching for the store: counts, sizes and
/// an error with no row in it.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Standing {
    pub(crate) rows: u64,
    pub(crate) bytes: u64,
    /// Kept transcripts with something still to read.
    pub(crate) versions_left: u64,
    /// Kept transcripts that couldn't be read and aren't being tried for now.
    pub(crate) set_aside: u64,
    pub(crate) error: Option<String>,
}

/// Notes how a pass over the tables went. One that failed outright keeps the last counts, with its error.
pub(crate) fn note(db: &Connection, outcome: &Result<ExtractReport, String>) -> Result<(), String> {
    let standing = match outcome {
        Ok(report) => Standing { rows: report.table_rows, bytes: report.table_bytes, versions_left: report.versions_left, set_aside: report.set_aside, error: report.first_failure.clone() },
        Err(error) => Standing { error: Some(error.clone()), ..standing(db)?.unwrap_or_default() },
    };
    let _writes = super::index::lock_writes();
    super::index::set_meta(db, "analytics", &serde_json::to_string(&standing).map_err(|error| error.to_string())?)
}

/// What the last pass noted, or nothing when no pass has made tables.
pub(crate) fn standing(db: &Connection) -> Result<Option<Standing>, String> {
    Ok(super::index::get_meta(db, "analytics")?.and_then(|text| serde_json::from_str(&text).ok()))
}

/// Asks the next pass to remove the tables. A pass is what writes them, so a pass removes them: nothing else
/// touches the folder while one runs.
pub(crate) fn ask_reset(db: &Connection) -> Result<(), String> {
    let _writes = super::index::lock_writes();
    super::index::set_meta(db, "analyticsReset", "1")
}

/// Removes the tables if that was asked for. With analytics on, the pass then makes them again from the start.
pub(crate) fn reset_if_asked(db: &Connection, root: &Path) -> Result<(), String> {
    if super::index::get_meta(db, "analyticsReset")?.is_none() {
        return Ok(());
    }
    // A folder of the store's own, never a link to somewhere else.
    if std::fs::symlink_metadata(root).is_ok_and(|meta| meta.is_dir()) {
        std::fs::remove_dir_all(root).map_err(|error| format!("Couldn't remove {}: {error}", root.display()))?;
    }
    let _writes = super::index::lock_writes();
    db.execute("DELETE FROM meta WHERE key IN ('analyticsReset', 'analytics')", []).map(|_| ()).map_err(index_error)
}

fn state_error(error: rusqlite::Error) -> String {
    format!("The analytics progress file failed: {error}")
}

fn index_error(error: rusqlite::Error) -> String {
    format!("The archive index failed: {error}")
}

pub(crate) fn detail_name(detail: Detail) -> &'static str {
    match detail {
        Detail::Numbers => "numbers",
        Detail::Everything => "everything",
    }
}

/// How far a version is read.
#[derive(Clone, Debug, Default)]
struct Step {
    version_id: i64,
    read_len: u64,
    seen_len: u64,
    lines: u64,
    done: bool,
    state: State,
}

struct Todo {
    version_id: i64,
    agent: Agent,
    machine: Option<String>,
    size: u64,
    /// How many times running it couldn't be read.
    tries: u32,
}

/// The lines first read in rows that aren't in the tables yet.
#[derive(Default)]
struct Keys {
    /// From versions whose rows are waiting to be written, by version.
    waiting: HashMap<LineKey, i64>,
    /// From the version being read.
    reading: HashSet<LineKey>,
    error: Option<String>,
}

impl Keys {
    /// Whether a line was read before, and from which version. One met for the first time is remembered.
    fn seen(&mut self, state: &Connection, version_id: i64, key: LineKey) -> Seen {
        let from = |first: i64| if first == version_id { Seen::Here } else { Seen::Elsewhere };
        if self.reading.contains(&key) {
            return Seen::Here;
        }
        if let Some(first) = self.waiting.get(&key) {
            return from(*first);
        }
        let found = state.prepare_cached("SELECT version_id FROM seen WHERE key = ?1").and_then(|mut statement| statement.query_row([&key[..]], |row| row.get::<_, i64>(0)).optional());
        match found {
            Ok(Some(first)) => from(first),
            Ok(None) => {
                self.reading.insert(key);
                Seen::New
            }
            Err(error) => {
                self.error.get_or_insert(state_error(error));
                Seen::New
            }
        }
    }
}

fn open_state(root: &Path) -> Result<Connection, String> {
    let state = Connection::open(root.join("state.db")).map_err(state_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(root.join("state.db"), std::fs::Permissions::from_mode(0o600));
    }
    // Every line read is looked up among the keys, so more of them stay in memory than SQLite keeps by itself.
    state.execute_batch("PRAGMA cache_size = -65536;").map_err(state_error)?;
    state.execute_batch(STATE_SCHEMA).map_err(state_error)?;
    Ok(state)
}

fn meta(state: &Connection, key: &str) -> Result<Option<String>, String> {
    state.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| row.get(0)).optional().map_err(state_error)
}

/// Whether the tables in `root` are the ones this rule and detail make. Tables from before a change to either wait
/// for a pass to make them again, and until then lack what a query is told they have. Tables whose maker can't be
/// read are taken for current: the query then says what it finds.
pub(crate) fn current(root: &Path, detail: Detail) -> bool {
    let read = || -> rusqlite::Result<Option<String>> {
        let state = Connection::open_with_flags(root.join("state.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        state.busy_timeout(Duration::from_secs(2))?;
        state.query_row("SELECT value FROM meta WHERE key = 'madeBy'", [], |row| row.get(0)).optional()
    };
    read().map_or(true, |made_by| made_by.as_deref() == Some(format!("{RULE} {}", detail_name(detail)).as_str()))
}

/// Opens the tables as this rule and detail make them, starting them again when another rule or detail made them.
fn open(root: &Path, detail: Detail) -> Result<(Tables, Connection), String> {
    let tables = Tables::open(root)?;
    let state = open_state(root)?;
    let made_by = format!("{RULE} {}", detail_name(detail));
    if meta(&state, "madeBy")?.as_deref() == Some(made_by.as_str()) {
        return Ok((tables, state));
    }
    // Progress goes first: tables without progress are read into again, and never the other way round.
    state.execute_batch("DELETE FROM progress; DELETE FROM staged; DELETE FROM seen; DELETE FROM seen_staged; DELETE FROM failed; DELETE FROM cursor; DELETE FROM cursor_staged; DELETE FROM meta WHERE key = 'madeBy';").map_err(state_error)?;
    drop(tables);
    Tables::clear(root);
    let tables = Tables::open(root)?;
    state.execute("INSERT INTO meta(key, value) VALUES('madeBy', ?1)", [&made_by]).map_err(state_error)?;
    Ok((tables, state))
}

/// Settles what a pass that stopped mid-write left staged: progress if its write landed, nothing if it didn't.
fn settle(state: &Connection, tables: &Tables) -> Result<(), String> {
    let transaction = state.unchecked_transaction().map_err(state_error)?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO progress(version_id, read_len, seen_len, lines, done, state)
             SELECT version_id, read_len, seen_len, lines, done, state FROM staged WHERE batch < ?1",
            [tables.next() as i64],
        )
        .map_err(state_error)?;
    transaction.execute("DELETE FROM staged", []).map_err(state_error)?;
    transaction.execute("INSERT OR IGNORE INTO seen(key, version_id) SELECT key, version_id FROM seen_staged WHERE batch < ?1", [tables.next() as i64]).map_err(state_error)?;
    transaction.execute("DELETE FROM seen_staged", []).map_err(state_error)?;
    transaction.execute("INSERT OR REPLACE INTO cursor(name, value) SELECT name, value FROM cursor_staged WHERE batch < ?1", [tables.next() as i64]).map_err(state_error)?;
    transaction.execute("DELETE FROM cursor_staged", []).map_err(state_error)?;
    transaction.commit().map_err(state_error)
}

fn save(state: &Connection, steps: &[Step], keys: &HashMap<LineKey, i64>, batch: Option<u64>) -> Result<(), String> {
    let transaction = state.unchecked_transaction().map_err(state_error)?;
    {
        let mut add = transaction
            .prepare(match batch {
                Some(_) => "INSERT OR REPLACE INTO seen_staged(key, version_id, batch) VALUES(?1, ?2, ?3)",
                None => "INSERT OR IGNORE INTO seen(key, version_id) VALUES(?1, ?2)",
            })
            .map_err(state_error)?;
        for (key, version_id) in keys {
            match batch {
                Some(batch) => add.execute(params![&key[..], version_id, batch as i64]),
                None => add.execute(params![&key[..], version_id]),
            }
            .map_err(state_error)?;
        }
    }
    for step in steps {
        let parser = serde_json::to_string(&step.state).map_err(|error| error.to_string())?;
        let (read_len, seen_len, lines) = (step.read_len as i64, step.seen_len as i64, step.lines as i64);
        match batch {
            Some(batch) => transaction.execute(
                "INSERT OR REPLACE INTO staged(version_id, read_len, seen_len, lines, done, state, batch) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![step.version_id, read_len, seen_len, lines, step.done, parser, batch as i64],
            ),
            None => transaction.execute(
                "INSERT OR REPLACE INTO progress(version_id, read_len, seen_len, lines, done, state) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                params![step.version_id, read_len, seen_len, lines, step.done, parser],
            ),
        }
        .map_err(state_error)?;
    }
    transaction.commit().map_err(state_error)
}

/// The rows waiting to be written, and how far each version will be read once they are.
struct Writer<'a> {
    tables: Tables,
    state: &'a Connection,
    keys: &'a RefCell<Keys>,
    engine: &'a dyn Engine,
    batch: Batch,
    steps: Vec<Step>,
    rows: u64,
    /// The pull requests this pass has noted already.
    linked: HashSet<String>,
}

/// The cursor a linked pull request is kept under: 0 until what its host said has been copied, then when that
/// was asked. GitHub doesn't mind the case of a repository's name, so the name here is in lower case.
const LINK: &str = "pull_request:";

fn link_name(repository: &str, number: u64) -> String {
    format!("{LINK}{}#{number}", repository.to_ascii_lowercase())
}

impl Writer<'_> {
    /// Puts a version's rows with what's waiting, and notes the pull requests they link to: `pull_request_pass`
    /// copies in what a host said of those. A note for rows that are never written only asks about one more.
    fn add(&mut self, origin: &Origin, rows: &Rows) -> Result<(), String> {
        for link in &rows.pull_request_links {
            let (Some(repository), Some(number)) = (&link.repository, link.number) else { continue };
            let name = link_name(repository, number);
            if !self.linked.contains(&name) {
                self.state.execute("INSERT OR IGNORE INTO cursor(name, value) VALUES(?1, 0)", [&name]).map_err(state_error)?;
                self.linked.insert(name);
            }
        }
        self.batch.add(origin, rows)
    }

    fn write(&mut self) -> Result<(), String> {
        let batch = std::mem::replace(&mut self.batch, self.tables.batch()?);
        let steps = std::mem::take(&mut self.steps);
        // The version being read keeps its keys: its rows aren't in this write.
        let keys = std::mem::take(&mut self.keys.borrow_mut().waiting);
        if batch.bytes() == 0 {
            batch.discard();
            return save(self.state, &steps, &keys, None);
        }
        save(self.state, &steps, &keys, Some(self.tables.next()))?;
        self.rows += self.tables.write(batch, self.engine)?;
        settle(self.state, &self.tables)
    }

    /// Drops what's waiting. The versions in it are read again from where they were.
    fn forget(&mut self) -> Result<(), String> {
        std::mem::replace(&mut self.batch, self.tables.batch()?).discard();
        self.steps.clear();
        Ok(())
    }
}

/// Reads what's new in every kept transcript into the tables in `root`. `stop` is asked
/// between pieces.
pub(crate) fn extract_pass(db: &Connection, blobs: &dyn Blobs, root: &Path, engine: &dyn Engine, options: &ExtractOptions, stop: &dyn Fn() -> bool) -> Result<ExtractReport, String> {
    let started = Instant::now();
    let (tables, state) = open(root, options.detail)?;
    settle(&state, &tables)?;
    tables.sweep()?;
    let (waiting, _) = todo(db, &state, options.now)?;
    let batch = tables.batch()?;
    let keys = RefCell::new(Keys::default());
    let mut writer = Writer { tables, state: &state, keys: &keys, engine, batch, steps: Vec::new(), rows: 0, linked: HashSet::new() };
    let mut report = ExtractReport { complete: true, ..ExtractReport::default() };
    let mut throttle = Throttle::new(options.bytes_per_second);
    let out_of_time = |read: u64| stop() || read >= options.max_bytes || started.elapsed() >= options.max_time;
    for item in waiting {
        if out_of_time(report.bytes_read) {
            report.complete = false;
            break;
        }
        let mut read = report.bytes_read;
        let mut enough = |more: u64| {
            read += more;
            out_of_time(read)
        };
        let mut rows = Rows::default();
        let mut spilled = false;
        let source = item.version_id.to_string();
        let from = state_of(&state, item.version_id)?;
        let mut seen = |key: LineKey| keys.borrow_mut().seen(&state, item.version_id, key);
        let result = match &item.machine {
            None => Err("A kept version has no file it was seen in".to_string()),
            Some(machine) => {
                let origin = Origin { agent: item.agent, machine, source: &source };
                let mut spill = |rows: &mut Rows| -> Result<(), String> {
                    // What other versions left waiting is written first, so dropping this version's rows, should
                    // it fail further on, drops only its own.
                    if !spilled {
                        writer.write()?;
                        spilled = true;
                    }
                    // They wait there for the version's end: mid-version, nothing says how far it's read.
                    writer.add(&origin, rows)?;
                    *rows = Rows::default();
                    Ok(())
                };
                read_version(db, blobs, &item, &from, options.detail, &mut throttle, &mut enough, &mut seen, &mut rows, &mut spill).and_then(|done| {
                    writer.add(&origin, &rows)?;
                    Ok(done)
                })
            }
        };
        report.bytes_read = read;
        // Without the keys nothing says which lines are repeats, so the pass stops with what it has written.
        if let Some(error) = keys.borrow_mut().error.take() {
            return Err(error);
        }
        match result {
            Ok((step, finished)) => {
                {
                    let mut keys = keys.borrow_mut();
                    let read: Vec<LineKey> = keys.reading.drain().collect();
                    keys.waiting.extend(read.into_iter().map(|key| (key, item.version_id)));
                }
                if item.tries > 0 {
                    state.execute("DELETE FROM failed WHERE version_id = ?1", [item.version_id]).map_err(state_error)?;
                }
                writer.steps.push(step);
                report.versions += 1;
                if writer.batch.bytes() >= BATCH_BYTES || !finished {
                    writer.write()?;
                }
                if !finished {
                    report.complete = false;
                    break;
                }
            }
            // Read again later: soon the first time, then less and less often.
            Err(error) => {
                keys.borrow_mut().reading.clear();
                if spilled {
                    writer.forget()?;
                }
                state
                    .execute(
                        "INSERT OR REPLACE INTO failed(version_id, size, tries, retry_at) VALUES(?1, ?2, ?3, ?4)",
                        params![item.version_id, item.size as i64, item.tries + 1, options.now.saturating_add(retry_wait(item.tries)) as i64],
                    )
                    .map_err(state_error)?;
                report.failures += 1;
                report.first_failure.get_or_insert(error);
            }
        }
    }
    writer.write()?;
    writer.tables.merge(engine, options.merge_at)?;
    // The sweep takes the batch left open with nothing in it.
    writer.tables.sweep()?;
    report.rows = writer.rows;
    let (left, set_aside) = todo(db, &state, options.now)?;
    (report.versions_left, report.set_aside) = (left.len() as u64, set_aside);
    (report.table_rows, report.table_bytes) = writer.tables.size();
    Ok(report)
}

/// How many of the proxy's requests go into one write.
const PROXY_ROWS: u32 = 50_000;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ProxyReport {
    pub(crate) copied: u64,
    /// It reached the newest request.
    pub(crate) complete: bool,
    /// What the tables hold, once the copy ended.
    pub(crate) table_rows: u64,
    pub(crate) table_bytes: u64,
}

/// Copies the proxy's requests that aren't in the tables yet, lowest number first. `next` gives the requests
/// numbered above a given one, up to as many as it's asked for; `stop` is asked between writes.
pub(crate) fn proxy_pass(root: &Path, engine: &dyn Engine, detail: Detail, merge_at: usize, next: &mut dyn FnMut(u64, u32) -> Result<Vec<ProxyRequest>, String>, stop: &dyn Fn() -> bool) -> Result<ProxyReport, String> {
    let (mut tables, state) = open(root, detail)?;
    settle(&state, &tables)?;
    let mut report = ProxyReport::default();
    while !stop() {
        let after = state.query_row("SELECT value FROM cursor WHERE name = 'proxy_requests'", [], |row| row.get::<_, i64>(0)).optional().map_err(state_error)?.unwrap_or(0).max(0) as u64;
        let rows = next(after, PROXY_ROWS)?;
        let Some(last) = rows.last().map(|row| row.id) else {
            report.complete = true;
            break;
        };
        let mut batch = tables.batch()?;
        batch.add_proxy(&rows)?;
        state.execute("INSERT OR REPLACE INTO cursor_staged(name, value, batch) VALUES('proxy_requests', ?1, ?2)", params![last as i64, tables.next() as i64]).map_err(state_error)?;
        report.copied += tables.write(batch, engine)?;
        settle(&state, &tables)?;
    }
    tables.merge(engine, merge_at)?;
    tables.sweep()?;
    (report.table_rows, report.table_bytes) = tables.size();
    Ok(report)
}

/// The pull requests the tables' sessions link to, as `owner/name` in lower case and a number.
pub(crate) fn linked_pull_requests(root: &Path) -> Result<Vec<(String, u64)>, String> {
    Ok(links(&open_state(root)?)?.into_keys().filter_map(|name| name[LINK.len()..].rsplit_once('#').and_then(|(repository, number)| Some((repository.to_string(), number.parse().ok()?)))).collect())
}

/// Each linked pull request's cursor.
fn links(state: &Connection) -> Result<HashMap<String, i64>, String> {
    let mut statement = state.prepare("SELECT name, value FROM cursor WHERE name GLOB ?1").map_err(state_error)?;
    let rows = statement.query_map([format!("{LINK}*")], |row| Ok((row.get(0)?, row.get(1)?))).map_err(state_error)?;
    rows.collect::<Result<_, _>>().map_err(state_error)
}

/// Writes what a host said of the linked pull requests it has been asked about since their last row. `checks`
/// has each with when it was asked, in milliseconds. Gives what the tables hold afterwards: rows and bytes.
pub(crate) fn pull_request_pass(root: &Path, engine: &dyn Engine, detail: Detail, merge_at: usize, checks: &[(i64, PullRequestCheck)]) -> Result<(u64, u64), String> {
    let (mut tables, state) = open(root, detail)?;
    settle(&state, &tables)?;
    let copied = links(&state)?;
    let fresh: Vec<(String, i64, PullRequestCheck)> = checks
        .iter()
        .filter_map(|(at, check)| {
            let name = link_name(&check.repository, check.number);
            copied.get(&name).is_some_and(|copied| copied < at).then(|| (name, *at, check.clone()))
        })
        .collect();
    if !fresh.is_empty() {
        let mut batch = tables.batch()?;
        batch.add_pull_request_checks(&fresh.iter().map(|(.., check)| check.clone()).collect::<Vec<_>>())?;
        let staged = state.unchecked_transaction().map_err(state_error)?;
        for (name, at, _) in &fresh {
            staged.execute("INSERT OR REPLACE INTO cursor_staged(name, value, batch) VALUES(?1, ?2, ?3)", params![name, at, tables.next() as i64]).map_err(state_error)?;
        }
        staged.commit().map_err(state_error)?;
        tables.write(batch, engine)?;
        settle(&state, &tables)?;
    }
    tables.merge(engine, merge_at)?;
    tables.sweep()?;
    Ok(tables.size())
}

/// The versions with something left to read: ones that grew, and ones that have stopped growing since their last
/// row was held back for a line that never came. One that couldn't be read is left out until it's time to try it
/// again, or it has grown; how many those are comes back beside the list.
fn todo(db: &Connection, state: &Connection, now: u64) -> Result<(Vec<Todo>, u64), String> {
    let failed: HashMap<i64, (u64, u32, u64)> = {
        let mut statement = state.prepare("SELECT version_id, size, tries, retry_at FROM failed").map_err(state_error)?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, (row.get::<_, i64>(1)?.max(0) as u64, row.get::<_, u32>(2)?, row.get::<_, i64>(3)?.max(0) as u64)))).map_err(state_error)?;
        rows.collect::<Result<_, _>>().map_err(state_error)?
    };
    let mut set_aside = 0;
    let read: HashMap<i64, (u64, bool)> = {
        let mut statement = state.prepare("SELECT version_id, seen_len, done FROM progress").map_err(state_error)?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, (row.get::<_, i64>(1)?.max(0) as u64, row.get::<_, bool>(2)?)))).map_err(state_error)?;
        rows.collect::<Result<_, _>>().map_err(state_error)?
    };
    let mut statement = db.prepare(TRANSCRIPTS).map_err(index_error)?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?.max(0) as u64, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?)))
        .map_err(index_error)?;
    let mut todo = Vec::new();
    for row in rows {
        let (version_id, agent, size, version_state, machine) = row.map_err(index_error)?;
        let (seen_len, done) = read.get(&version_id).copied().unwrap_or((0, false));
        if seen_len < size || (!done && version_state != "growing") {
            let tries = match failed.get(&version_id) {
                Some((at_size, _, retry_at)) if *at_size == size && *retry_at > now => {
                    set_aside += 1;
                    continue;
                }
                Some((_, tries, _)) => *tries,
                None => 0,
            };
            // The query above names every agent it takes.
            let Some(agent) = Agent::named(&agent) else { continue };
            todo.push(Todo { version_id, agent, machine, size, tries });
        }
    }
    Ok((todo, set_aside))
}

fn state_of(state: &Connection, version_id: i64) -> Result<Step, String> {
    let found = state
        .query_row("SELECT read_len, lines, state FROM progress WHERE version_id = ?1", [version_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)))
        .optional()
        .map_err(state_error)?;
    Ok(match found {
        Some((read_len, lines, parser)) => Step { version_id, read_len: read_len.max(0) as u64, lines: lines.max(0) as u64, state: serde_json::from_str(&parser).map_err(|_| "The analytics progress file holds a state that can't be read".to_string())?, ..Step::default() },
        None => Step { version_id, ..Step::default() },
    })
}

/// Reads one version from where it was last read to, into `rows`. `enough` hears each piece's size and says when to
/// stop; `spill` takes the rows so far when a lot has been read. Returns how far the version is now read, and
/// whether that is its end.
#[allow(clippy::too_many_arguments)]
fn read_version(
    db: &Connection,
    blobs: &dyn Blobs,
    item: &Todo,
    from: &Step,
    detail: Detail,
    throttle: &mut Throttle,
    enough: &mut dyn FnMut(u64) -> bool,
    seen: &mut dyn FnMut(LineKey) -> Seen,
    rows: &mut Rows,
    spill: &mut dyn FnMut(&mut Rows) -> Result<(), String>,
) -> Result<(Step, bool), String> {
    let version: Version = load_version(db, item.version_id)?;
    let settled = version.state != "growing";
    let mut parser = Parser::new(item.agent, detail, from.state.clone());
    let mut held = 0u64;
    let mut finished = true;
    let mut lines;

    if version.encoding == "zstd" {
        // A compressed file is read from its start each time it changes; the lines read before are passed by.
        let mut frame = Vec::with_capacity(version.size as usize);
        for piece in pieces(&version, 0) {
            let bytes = read_piece(blobs, &version, &piece, throttle)?;
            frame.extend_from_slice(&bytes);
            enough(bytes.len() as u64);
        }
        let mut decoder = codec::transcript(&frame)?;
        lines = Lines::new(0, 0, from.lines);
        let mut buffer = vec![0u8; 1 << 20];
        loop {
            let read = decoder.read(&mut buffer).map_err(|error| format!("Couldn't decompress a kept file: {error}"))?;
            if read == 0 {
                break;
            }
            lines.feed(&buffer[..read], &mut |number, line| row(&mut parser, seen, rows, number, line));
            held += read as u64;
            if held >= HELD_BYTES {
                spill(rows)?;
                held = 0;
            }
        }
    } else {
        lines = Lines::new(from.read_len, from.lines, 0);
        let all = pieces(&version, from.read_len);
        let count = all.len();
        for (index, piece) in all.iter().enumerate() {
            let bytes = read_piece(blobs, &version, piece, throttle)?;
            let start = match piece {
                Piece::Chunk(_, off) | Piece::Pending(off) => *off,
            };
            let skip = from.read_len.saturating_sub(start) as usize;
            lines.feed(bytes.get(skip..).unwrap_or_default(), &mut |number, line| row(&mut parser, seen, rows, number, line));
            held += bytes.len() as u64;
            // Stopping saves where the last whole line ended, so it waits until one has.
            if enough(bytes.len() as u64) && index + 1 < count && lines.end > from.read_len {
                finished = false;
                break;
            }
            if held >= HELD_BYTES {
                spill(rows)?;
                held = 0;
            }
        }
    }
    // A version that won't grow again ends with its last line, newline or not, and gives up the row its parser was
    // holding for a line after it.
    let done = finished && settled;
    if done {
        lines.finish(&mut |number, line| row(&mut parser, seen, rows, number, line));
        parser.finish(rows);
    }
    let compressed = version.encoding == "zstd";
    let step = Step {
        version_id: version.id,
        // A growing version's last line may be half written: it's read again once the version grows.
        read_len: if done || compressed { version.size } else { lines.end },
        seen_len: if finished { version.size } else { lines.end },
        lines: lines.count,
        done,
        state: parser.state().clone(),
    };
    Ok((step, finished))
}

enum Found<'a> {
    Whole(&'a [u8]),
    /// A line too long to read, by its length.
    TooLong(u64),
}

fn row(parser: &mut Parser, seen: &mut dyn FnMut(LineKey) -> Seen, rows: &mut Rows, number: u64, line: Found<'_>) {
    match line {
        Found::Whole(line) => parser.line_once(number, line, seen, rows),
        Found::TooLong(bytes) => rows.lines.push(Line { at: At { line: number, ..At::default() }, kind: "too-long".into(), bytes, ..Line::default() }),
    }
}

/// Splits bytes that arrive in pieces into whole lines, numbering them and keeping track of where the last one ended.
struct Lines {
    /// Where the bytes after the last whole line start.
    end: u64,
    /// How many lines have ended.
    count: u64,
    /// Lines numbered below this were read before, and are passed by.
    skip: u64,
    /// A line longer than this isn't held to be read.
    longest: usize,
    partial: Vec<u8>,
    /// How much of a line too long to read has gone by.
    passing: Option<u64>,
}

impl Lines {
    /// For a file read from `end`, where `count` lines have ended, giving the lines from number `skip` on.
    fn new(end: u64, count: u64, skip: u64) -> Self {
        Lines { end, count, skip, longest: LONG_LINE, partial: Vec::new(), passing: None }
    }

    fn feed(&mut self, mut bytes: &[u8], each: &mut impl FnMut(u64, Found<'_>)) {
        while let Some(at) = memchr::memchr(b'\n', bytes) {
            let (line, rest) = (&bytes[..at], &bytes[at + 1..]);
            let length = self.partial.len() as u64 + line.len() as u64 + 1;
            if self.count >= self.skip {
                match self.passing {
                    Some(passed) => each(self.count, Found::TooLong(passed + line.len() as u64)),
                    None if self.partial.is_empty() => each(self.count, Found::Whole(line)),
                    None => {
                        self.partial.extend_from_slice(line);
                        each(self.count, Found::Whole(&self.partial));
                    }
                }
            }
            self.passing = None;
            self.end += length;
            self.count += 1;
            self.partial.clear();
            bytes = rest;
        }
        match &mut self.passing {
            Some(passed) => {
                *passed += bytes.len() as u64;
                self.end += bytes.len() as u64;
            }
            None => {
                self.partial.extend_from_slice(bytes);
                if self.partial.len() > self.longest {
                    self.end += self.partial.len() as u64;
                    self.passing = Some(self.partial.len() as u64);
                    self.partial = Vec::new();
                }
            }
        }
    }

    /// A settled file's last line, when it has no newline after it.
    fn finish(&mut self, each: &mut impl FnMut(u64, Found<'_>)) {
        let ended = match self.passing.take() {
            Some(passed) => Some(Found::TooLong(passed)),
            None if !self.partial.is_empty() => Some(Found::Whole(&self.partial)),
            None => None,
        };
        if let Some(line) = ended {
            if self.count >= self.skip {
                each(self.count, line);
            }
            self.count += 1;
        }
        self.end += self.partial.len() as u64;
        self.partial.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::super::store::{ChunkMeta, NewChunk};
    use super::super::ingest::tests::{walk, Fixture, SECRET_TEXT, SID, THREAD};
    use super::super::tokens::tests::{claude_line, codex_record, codex_turn, codex_usage, openclaw_line};
    use super::*;
    use serde_json::Value;
    use session_tables::store::Program;
    use std::cell::Cell;
    use std::fs;

    /// Stands in for DuckDB where a test only needs rows to land: each table's file is "written" as the JSON lines
    /// the engine was told to read, so a test reads rows back without one. It can't merge.
    struct Copier;

    impl Engine for Copier {
        fn run(&self, sql: &str) -> Result<String, String> {
            let between = |text: &str, start: &str| text.split_once(start).and_then(|(_, rest)| rest.split_once('\'')).map(|(found, _)| found.to_string());
            for line in sql.lines().filter(|line| line.starts_with("COPY (")) {
                let (from, to) = (between(line, "read_json('").unwrap(), between(line, ") TO '").unwrap());
                fs::copy(from, to).map_err(|error| format!("IO Error: {error}"))?;
            }
            Ok("[]".to_string())
        }
    }

    struct Broken;

    impl Engine for Broken {
        fn run(&self, _: &str) -> Result<String, String> {
            Err(format!("IO Error: no room for {SECRET_TEXT}"))
        }
    }

    /// A store whose `fails`th chunk read from now fails.
    struct Flaky<'a> {
        inner: &'a dyn Blobs,
        fails: Cell<i64>,
    }

    impl Blobs for Flaky<'_> {
        fn store_id(&self) -> &str {
            self.inner.store_id()
        }
        fn put_chunks(&self, chunks: &[NewChunk<'_>]) -> Result<Vec<ChunkMeta>, String> {
            self.inner.put_chunks(chunks)
        }
        fn read_chunk(&self, hash: &[u8; 32]) -> Result<Vec<u8>, String> {
            self.fails.set(self.fails.get() - 1);
            if self.fails.get() == 0 {
                return Err("A chunk couldn't be read".to_string());
            }
            self.inner.read_chunk(hash)
        }
        fn put_pending(&self, vk: &str, gen: i64, tail: &[u8]) -> Result<(), String> {
            self.inner.put_pending(vk, gen, tail)
        }
        fn read_pending(&self, vk: &str, gen: i64) -> Result<Vec<u8>, String> {
            self.inner.read_pending(vk, gen)
        }
        fn drop_pending(&self, vk: &str, keep: Option<i64>) {
            self.inner.drop_pending(vk, keep);
        }
    }

    /// What a write says when the engine fails, by way of a store of its own.
    fn session_tables_failure() -> String {
        let root = super::super::store::tests::temp_dir("analytics-failure");
        let mut tables = Tables::open(&root).unwrap();
        let mut batch = tables.batch().unwrap();
        batch.add(&Origin { agent: Agent::Claude, machine: "mac", source: "1" }, &Rows { lines: vec![Line::default()], ..Rows::default() }).unwrap();
        let error = tables.write(batch, &Broken).unwrap_err();
        let _ = fs::remove_dir_all(&root);
        error
    }

    fn everything() -> ExtractOptions {
        ExtractOptions { detail: Detail::Everything, bytes_per_second: 1 << 40, max_bytes: 1 << 40, max_time: Duration::from_secs(600), merge_at: usize::MAX, now: 1_800_000_000 }
    }

    fn root(fixture: &Fixture) -> PathBuf {
        fixture.places.store.root().join(FOLDER)
    }

    fn extract(fixture: &Fixture, options: &ExtractOptions) -> ExtractReport {
        extract_pass(&fixture.db, &fixture.places, &root(fixture), &Copier, options, &|| false).unwrap()
    }

    /// A table's rows as the Copier left them, in the order of their source and line.
    fn rows(fixture: &Fixture, table: &str) -> Vec<Value> {
        let tables = Tables::open(&root(fixture)).unwrap();
        let mut rows: Vec<Value> = tables.parts(table).iter().flat_map(|part| fs::read_to_string(root(fixture).join(&part.path)).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect::<Vec<Value>>()).collect();
        rows.sort_by_key(|row| (row["source"].as_str().unwrap_or_default().to_string(), row["line"].as_u64(), row["block"].as_u64()));
        rows
    }

    fn claude_session(replies: &[(&str, u64)]) -> String {
        let mut text = format!("{{\"type\":\"user\",\"sessionId\":\"{SID}\",\"timestamp\":\"2026-09-20T02:00:00.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"{SECRET_TEXT}\"}}}}\n");
        for (n, (id, output)) in replies.iter().enumerate() {
            text += &claude_line(id, "claude-opus-5-5", &format!("2026-09-20T02:{n:02}:30.000Z"), (10, 100, 1_000, *output), SECRET_TEXT);
        }
        text
    }

    fn codex_session(responses: &[&str]) -> String {
        let mut text = format!("{{\"timestamp\":\"2026-09-21T01:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{THREAD}\",\"instructions\":\"{SECRET_TEXT}\"}}}}\n");
        text += &codex_turn("2026-09-21T01:00:00.500Z", "gpt-6-sol", SECRET_TEXT);
        for (n, response) in responses.iter().enumerate() {
            let usage = codex_usage(2_000, 1_500, 100, 40);
            text += &codex_record(&format!("2026-09-21T01:{n:02}:01.000Z"), response, &usage, &usage);
        }
        text
    }

    const MAIN: &str = ".claude/projects/-Users-me-app/0f8b5c2e-1111-4222-8333-444455556666.jsonl";
    const CARRIED_ON: &str = ".claude/projects/-Users-me-app/7c1d9e4a-5555-4666-8777-888899990000.jsonl";
    const ROLLOUT: &str = ".codex/sessions/2026/09/21/rollout-2026-09-21T01-00-00-019a1b2c-3d4e-7f00-8111-222233334444.jsonl";

    fn holds(bytes: &[u8]) -> bool {
        memchr::memmem::find(bytes, SECRET_TEXT.as_bytes()).is_some()
    }

    #[test]
    fn kept_transcripts_become_rows_once_and_one_that_grows_adds_only_its_new_lines() {
        let fixture = Fixture::new("analytics-once");
        fixture.write(MAIN, &claude_session(&[("msg_1", 5), ("msg_2", 20)]));
        fixture.write(ROLLOUT, &codex_session(&["resp_1", "resp_2"]));
        assert!(fixture.pass().complete);
        let report = extract(&fixture, &everything());
        assert!(report.complete && report.failures == 0 && report.versions == 2, "{report:?}");
        let lines = rows(&fixture, "lines");
        assert_eq!(lines.len(), 3 + 4);
        assert_eq!(report.rows, ["lines", "messages", "requests", "tool_calls", "tool_results", "tool_io", "commands", "hooks", "prompts", "tool_defs", "context_use", "files_touched", "pull_request_links"].iter().map(|table| rows(&fixture, table).len() as u64).sum::<u64>());
        assert!(lines.iter().all(|line| line["machine"] == "mac"));
        let agents: Vec<&str> = lines.iter().map(|line| line["agent"].as_str().unwrap()).collect();
        assert_eq!(agents.iter().filter(|agent| **agent == "claude").count(), 3);
        assert_eq!(agents.iter().filter(|agent| **agent == "codex").count(), 4);
        assert!(rows(&fixture, "messages").iter().any(|message| message["text"].as_str().is_some_and(|text| text.contains(SECRET_TEXT))));
        // The file is still growing, so its last reply's request waits for a line after it.
        let requests = |fixture: &Fixture| -> Vec<(String, u64)> {
            rows(fixture, "requests").iter().filter(|row| row["agent"] == "claude").map(|row| (row["message_id"].as_str().unwrap().to_string(), row["output"].as_u64().unwrap())).collect()
        };
        assert_eq!(requests(&fixture), [("msg_1".to_string(), 5)]);

        // Nothing new: nothing's read.
        let again = extract(&fixture, &everything());
        assert_eq!((again.bytes_read, again.rows, again.versions), (0, 0, 0));

        // It grows: the reply streams on, and another follows it.
        fixture.write(MAIN, &claude_session(&[("msg_1", 5), ("msg_2", 20), ("msg_2", 300), ("msg_3", 7)]));
        assert!(fixture.pass().complete);
        let grown = extract(&fixture, &everything());
        assert_eq!(grown.versions, 1);
        let lines = rows(&fixture, "lines");
        let claude: Vec<u64> = lines.iter().filter(|line| line["agent"] == "claude").map(|line| line["line"].as_u64().unwrap()).collect();
        assert_eq!(claude, [0, 1, 2, 3, 4]);
        // A file read again from where it was is the same file: none of its lines is a repeat.
        assert!(lines.iter().all(|line| line["repeat"] == false));
        assert_eq!(requests(&fixture), [("msg_1".to_string(), 5), ("msg_2".to_string(), 300)]);

        // Once it has stopped growing, the request held back comes out, once.
        fixture.db.execute("UPDATE versions SET state = 'settled'", []).unwrap();
        let settled = extract(&fixture, &everything());
        assert!(settled.complete);
        assert_eq!(requests(&fixture), [("msg_1".to_string(), 5), ("msg_2".to_string(), 300), ("msg_3".to_string(), 7)]);
        assert_eq!(extract(&fixture, &everything()).versions, 0);
        assert_eq!(rows(&fixture, "lines").len(), 5 + 4);
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn reading_stops_at_its_share_and_carries_on_to_the_same_rows() {
        let whole = Fixture::new("analytics-whole");
        let parts = Fixture::new("analytics-parts");
        let replies: Vec<(String, u64)> = (0..30).map(|n| (format!("msg_{n}"), n)).collect();
        let replies: Vec<(&str, u64)> = replies.iter().map(|(id, output)| (id.as_str(), *output)).collect();
        for fixture in [&whole, &parts] {
            fixture.write(MAIN, &claude_session(&replies));
            fixture.write(ROLLOUT, &codex_session(&["resp_1", "resp_2", "resp_3"]));
            assert!(fixture.pass().complete);
            fixture.db.execute("UPDATE versions SET state = 'settled'", []).unwrap();
        }
        extract(&whole, &everything());
        // A share of one byte: a piece of one version each pass.
        let small = ExtractOptions { max_bytes: 1, ..everything() };
        let mut passes = 0;
        while !extract(&parts, &small).complete {
            passes += 1;
            assert!(passes < 2_000);
        }
        assert!(passes > 5, "{passes}");
        for table in ["lines", "messages", "requests"] {
            let (expected, found) = (rows(&whole, table), rows(&parts, table));
            assert!(!expected.is_empty());
            assert_eq!(found, expected, "{table}");
        }
        let _ = fs::remove_dir_all(&whole.base);
        let _ = fs::remove_dir_all(&parts.base);
    }

    #[test]
    fn a_pass_stopped_around_a_write_neither_loses_rows_nor_adds_them_twice() {
        let expected = {
            let fixture = Fixture::new("analytics-expected");
            fixture.write(MAIN, &claude_session(&[("msg_1", 5), ("msg_2", 20)]));
            assert!(fixture.pass().complete);
            extract(&fixture, &everything());
            let rows = rows(&fixture, "lines");
            let _ = fs::remove_dir_all(&fixture.base);
            rows
        };
        for landed in [false, true] {
            let fixture = Fixture::new("analytics-stopped");
            fixture.write(MAIN, &claude_session(&[("msg_1", 5), ("msg_2", 20)]));
            assert!(fixture.pass().complete);
            // What a pass does up to its write, and then no further.
            {
                let (mut tables, state) = open(&root(&fixture), Detail::Everything).unwrap();
                let item = todo(&fixture.db, &state, 0).unwrap().0.remove(0);
                let mut found = Rows::default();
                let (step, _) = read_version(&fixture.db, &fixture.places, &item, &Step::default(), Detail::Everything, &mut Throttle::new(1 << 40), &mut |_| false, &mut |_| Seen::New, &mut found, &mut |_| Ok(())).unwrap();
                let mut batch = tables.batch().unwrap();
                batch.add(&Origin { agent: item.agent, machine: "mac", source: &item.version_id.to_string() }, &found).unwrap();
                save(&state, &[step], &HashMap::new(), Some(tables.next())).unwrap();
                if landed {
                    tables.write(batch, &Copier).unwrap();
                }
            }
            let report = extract(&fixture, &everything());
            assert_eq!(report.versions, u64::from(!landed), "landed: {landed}");
            assert_eq!(rows(&fixture, "lines"), expected, "landed: {landed}");
            let _ = fs::remove_dir_all(&fixture.base);
        }

        // An engine that fails stops the pass, with nothing of what it said in the error; the next pass has it all.
        let fixture = Fixture::new("analytics-broken");
        fixture.write(MAIN, &claude_session(&[("msg_1", 5), ("msg_2", 20)]));
        assert!(fixture.pass().complete);
        let failed = extract_pass(&fixture.db, &fixture.places, &root(&fixture), &Broken, &everything(), &|| false).unwrap_err();
        assert_eq!(failed, "The query engine stopped while writing tables (IO Error)");
        assert_eq!(rows(&fixture, "lines").len(), 0);
        extract(&fixture, &everything());
        assert_eq!(rows(&fixture, "lines"), expected);
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn a_version_that_cannot_be_read_is_set_aside_for_longer_each_time_and_the_rest_are_read() {
        let fixture = Fixture::new("analytics-flaky");
        fixture.write(MAIN, &claude_session(&[("msg_1", 5), ("msg_2", 20)]));
        fixture.write(ROLLOUT, &codex_session(&["resp_1"]));
        assert!(fixture.pass().complete);
        fixture.db.execute("UPDATE versions SET state = 'settled'", []).unwrap();
        let flaky = Flaky { inner: &fixture.places, fails: Cell::new(1) };
        let report = extract_pass(&fixture.db, &flaky, &root(&fixture), &Copier, &everything(), &|| false).unwrap();
        assert_eq!((report.failures, report.versions, report.first_failure.as_deref()), (1, 1, Some("A chunk couldn't be read")));
        let agents = |fixture: &Fixture| -> Vec<String> {
            let mut agents: Vec<String> = rows(fixture, "lines").iter().map(|line| line["agent"].as_str().unwrap().to_string()).collect();
            agents.dedup();
            agents
        };
        assert_eq!(agents(&fixture).len(), 1);
        // It isn't waiting to be read: it's set aside, and a pass straight after leaves it alone.
        assert_eq!((report.versions_left, report.set_aside), (0, 1));
        let report = extract(&fixture, &everything());
        assert_eq!((report.failures, report.versions, report.bytes_read, report.set_aside), (0, 0, 0, 1));
        // A quarter of an hour on it's tried, fails again, and is left for an hour.
        let at = |seconds: u64| ExtractOptions { now: everything().now + seconds, ..everything() };
        let flaky = Flaky { inner: &fixture.places, fails: Cell::new(1) };
        let report = extract_pass(&fixture.db, &flaky, &root(&fixture), &Copier, &at(retry_wait(0)), &|| false).unwrap();
        assert_eq!((report.failures, report.set_aside), (1, 1));
        assert_eq!(extract(&fixture, &at(retry_wait(0) + retry_wait(1) - 1)).versions, 0);
        // Then it can be read, and nothing is set aside.
        let report = extract(&fixture, &at(retry_wait(0) + retry_wait(1)));
        assert_eq!((report.failures, report.versions, report.set_aside, report.versions_left), (0, 1, 0, 0));
        assert_eq!(agents(&fixture).len(), 2);
        assert_eq!(rows(&fixture, "lines").len(), 3 + 3);
        let state = open_state(&root(&fixture)).unwrap();
        assert_eq!(state.query_row("SELECT count(*) FROM failed", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn what_github_said_of_a_linked_pull_request_is_copied_once_each_time_it_was_asked() {
        let fixture = Fixture::new("analytics-pull-requests");
        let link = |number: u64| format!("{{\"type\":\"pr-link\",\"sessionId\":\"{SID}\",\"timestamp\":\"2026-09-20T02:00:0{number}.000Z\",\"prNumber\":{number},\"prUrl\":\"https://git.example/app/pull/{number}\",\"prRepository\":\"Example/App\"}}\n");
        fixture.write(MAIN, &(link(1) + &link(2) + &link(1)));
        assert!(fixture.pass().complete);
        assert!(extract(&fixture, &everything()).complete);
        assert_eq!(rows(&fixture, "pull_request_links").len(), 3);
        let mut linked = linked_pull_requests(&root(&fixture)).unwrap();
        linked.sort();
        assert_eq!(linked, [("example/app".to_string(), 1), ("example/app".to_string(), 2)]);
        let check = |at: i64, number: u64, state: &str| (at, PullRequestCheck { repository: "example/app".into(), number, state: Some(state.into()), title: Some(SECRET_TEXT.into()), ..PullRequestCheck::default() });
        let copy = |engine: &dyn Engine, checks: &[(i64, PullRequestCheck)]| pull_request_pass(&root(&fixture), engine, Detail::Everything, usize::MAX, checks);
        let states = |fixture: &Fixture| -> Vec<(u64, String)> {
            let mut states: Vec<_> = rows(fixture, "pull_request_checks").iter().map(|row| (row["number"].as_u64().unwrap(), row["state"].as_str().unwrap().to_string())).collect();
            states.sort();
            states
        };
        // One no session linked is left out. A write that fails leaves the next pass to copy the same ones, once.
        let first = [check(10, 1, "open"), check(10, 7, "open")];
        assert_eq!(copy(&Broken, &first).unwrap_err(), "The query engine stopped while writing tables (IO Error)");
        copy(&Copier, &first).unwrap();
        copy(&Copier, &first).unwrap();
        assert_eq!(states(&fixture), [(1, "open".to_string())]);
        // Asked again, it has a second row; one asked about for the first time has its first.
        copy(&Copier, &[check(20, 1, "merged"), check(20, 2, "closed")]).unwrap();
        assert_eq!(states(&fixture), [(1, "merged".to_string()), (1, "open".to_string()), (2, "closed".to_string())]);
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn the_proxys_requests_are_copied_once_each_however_a_pass_ends() {
        use crate::usage::proxy_rows::{proxy_requests, Pricer};
        let fixture = Fixture::new("analytics-proxy");
        let usage = crate::usage::schema::test_database();
        let add = |number: i64| {
            crate::usage::schema::insert_request(
                &usage,
                "timestamp_ms, latency_ms, ttft_ms, model, provider, auth_index, session_id, input_tokens, output_tokens, failure_body, source",
                params![1_790_000_000_000_i64 + number, 3000, 1000, "claude-opus-5-5", "claude", "a1", SID, 1000, 50 * number, SECRET_TEXT, "cam@example.com"],
            );
        };
        (1..=5).for_each(add);
        let mut pricer = Pricer::load(&usage).unwrap();
        let mut asked: Vec<u64> = Vec::new();
        let mut copy = |engine: &dyn Engine, asked: &mut Vec<u64>| {
            proxy_pass(&root(&fixture), engine, Detail::Everything, usize::MAX, &mut |after, limit| {
                asked.push(after);
                proxy_requests(&usage, &mut pricer, after, limit.min(2))
            }, &|| false)
        };
        // A write that fails leaves the cursor where it was, so the next pass copies the same requests, once.
        assert_eq!(copy(&Broken, &mut asked).unwrap_err(), "The query engine stopped while writing tables (IO Error)");
        let report = copy(&Copier, &mut asked).unwrap();
        assert_eq!((report.copied, report.complete, report.table_rows), (5, true, 5));
        assert_eq!(asked, [0, 0, 2, 4, 5]);
        let ids = |fixture: &Fixture| -> Vec<u64> {
            let mut ids: Vec<u64> = rows(fixture, "proxy_requests").iter().map(|row| row["id"].as_u64().unwrap()).collect();
            ids.sort_unstable();
            ids
        };
        assert_eq!(ids(&fixture), [1, 2, 3, 4, 5]);
        // Nothing new: nothing's written. One more request: it alone is copied.
        assert_eq!(copy(&Copier, &mut asked).unwrap().copied, 0);
        add(6);
        assert_eq!(copy(&Copier, &mut asked).unwrap().copied, 1);
        assert_eq!(ids(&fixture), [1, 2, 3, 4, 5, 6]);
        let copied = rows(&fixture, "proxy_requests");
        assert!(copied.iter().all(|row| row["session_id"] == SID && row["account"] == "a1" && row["cost"].as_f64().is_some_and(|cost| cost > 0.0)));
        // What a failed request answered with, and the account's name, are nowhere in the tables.
        let all = serde_json::to_string(&copied).unwrap();
        assert!(!all.contains(SECRET_TEXT) && !all.contains("cam@example.com"));
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn a_pi_or_openclaw_session_is_read_the_way_its_own_agent_writes_one() {
        let fixture = Fixture::new("analytics-pi");
        let at = "2026-09-20T02:00:02.000Z";
        let session = [
            format!("{{\"type\":\"session\",\"version\":3,\"id\":\"{SID}\",\"timestamp\":\"2026-09-20T02:00:00.000Z\",\"cwd\":\"/srv/app\"}}\n"),
            format!("{{\"type\":\"message\",\"id\":\"e0\",\"parentId\":null,\"timestamp\":\"2026-09-20T02:00:01.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"{SECRET_TEXT}\"}}}}\n"),
            openclaw_line("e1", Some("resp_1"), false, at, (10, 0, 900, 50), "a"),
            // A turn another harness ran, whose own transcript has it.
            openclaw_line("e2", None, true, at, (1_000, 0, 9_000, 100), "b"),
        ]
        .concat();
        fixture.write(MAIN, &session);
        assert!(fixture.pass().complete);
        // The fixture's homes are Claude Code's and Codex's, so the index is told whose this one is.
        for agent in ["pi", "openclaw"] {
            fixture.db.execute("UPDATE sessions SET agent = ?1", [agent]).unwrap();
            ask_reset(&fixture.db).unwrap();
            reset_if_asked(&fixture.db, &root(&fixture)).unwrap();
            let report = extract(&fixture, &everything());
            assert!(report.complete && report.failures == 0 && report.versions == 1, "{report:?}");
            let lines = rows(&fixture, "lines");
            assert_eq!(lines.iter().map(|line| (line["agent"].as_str().unwrap(), line["kind"].as_str().unwrap(), line["session_id"].as_str().unwrap())).collect::<Vec<_>>(), [(agent, "session", SID), (agent, "message", SID), (agent, "message", SID), (agent, "message", SID)]);
            let requests: Vec<_> = rows(&fixture, "requests").iter().map(|row| (row["model"].as_str().unwrap().to_string(), row["input"].as_u64().unwrap(), row["cache_read"].as_u64().unwrap(), row["output"].as_u64().unwrap(), row["repeat"].as_bool().unwrap())).collect();
            assert_eq!(requests, [("gpt-5.5".to_string(), 10, 900, 50, false), ("gpt-5.5".to_string(), 1_000, 9_000, 100, true)]);
        }
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn a_call_codex_wrote_again_into_a_rollout_that_grew_is_a_repeat() {
        let fixture = Fixture::new("analytics-again");
        let first = codex_session(&["resp_1", "resp_2"]);
        fixture.write(ROLLOUT, &first);
        assert!(fixture.pass().complete);
        extract(&fixture, &everything());
        // The session is carried on: the first call written again with the time of the rewrite, then a new one.
        let usage = codex_usage(2_000, 1_500, 100, 40);
        let more = [codex_record("2026-09-22T05:00:00.000Z", "resp_1", &usage, &usage), codex_record("2026-09-22T05:00:01.000Z", "resp_3", &usage, &usage)].concat();
        fixture.write(ROLLOUT, &(first + &more));
        assert!(fixture.pass().complete);
        extract(&fixture, &everything());
        let requests: Vec<(String, bool)> = rows(&fixture, "requests").iter().map(|row| (row["request_id"].as_str().unwrap().to_string(), row["repeat"].as_bool().unwrap())).collect();
        assert_eq!(requests, [("resp_1".to_string(), false), ("resp_2".to_string(), false), ("resp_1".to_string(), true), ("resp_3".to_string(), false)]);
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn a_line_kept_in_two_files_is_a_repeat_in_the_second() {
        let fixture = Fixture::new("analytics-repeat");
        let first = claude_session(&[("msg_1", 5), ("msg_2", 20)]);
        fixture.write(MAIN, &first);
        assert!(fixture.pass().complete);
        extract(&fixture, &everything());
        // The session carried on in another file, which opens with the first one's lines.
        fixture.write(CARRIED_ON, &(first + &claude_line("msg_3", "claude-opus-5-5", "2026-09-20T03:00:00.000Z", (10, 100, 1_000, 9), SECRET_TEXT)));
        assert!(fixture.pass().complete);
        fixture.db.execute("UPDATE versions SET state = 'settled'", []).unwrap();
        let report = extract(&fixture, &everything());
        assert_eq!(report.versions, 2);
        let lines = rows(&fixture, "lines");
        let repeats: Vec<bool> = lines.iter().map(|line| line["repeat"].as_bool().unwrap()).collect();
        assert_eq!(repeats, [false, false, false, true, true, true, false]);
        // Each reply is counted once: the first two from the first file, the third from the second.
        let requests: Vec<(String, bool)> = rows(&fixture, "requests").iter().map(|row| (row["message_id"].as_str().unwrap().to_string(), row["repeat"].as_bool().unwrap())).collect();
        assert_eq!(requests, [("msg_1".to_string(), false), ("msg_2".to_string(), false), ("msg_1".to_string(), true), ("msg_2".to_string(), true), ("msg_3".to_string(), false)]);
        let state = open_state(&root(&fixture)).unwrap();
        let count = |table: &str| state.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get::<_, i64>(0)).unwrap();
        assert_eq!((count("seen"), count("seen_staged")), (4, 0));
        // These are the tables this detail makes, and not the ones another would.
        assert!(current(&root(&fixture), Detail::Everything) && !current(&root(&fixture), Detail::Numbers));

        // A key counts once the write that holds its line has landed, and not before.
        let tables = Tables::open(&root(&fixture)).unwrap();
        let key: LineKey = [7; 12];
        save(&state, &[], &HashMap::from([(key, 1)]), Some(tables.next())).unwrap();
        settle(&state, &tables).unwrap();
        assert_eq!((count("seen"), count("seen_staged")), (4, 0));
        save(&state, &[], &HashMap::from([(key, 1)]), Some(tables.next() - 1)).unwrap();
        settle(&state, &tables).unwrap();
        assert_eq!(count("seen"), 5);

        // Making the tables again forgets every line.
        drop(state);
        extract(&fixture, &ExtractOptions { detail: Detail::Numbers, ..everything() });
        let state = open_state(&root(&fixture)).unwrap();
        assert_eq!(state.query_row("SELECT count(*) FROM seen", [], |row| row.get::<_, i64>(0)).unwrap(), 4);
        assert_eq!(rows(&fixture, "lines").iter().filter(|line| line["repeat"] == true).count(), 3);
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn what_was_said_is_in_the_tables_and_nowhere_else_and_numbers_only_keeps_it_out_of_them() {
        let fixture = Fixture::new("analytics-secret");
        fixture.write(MAIN, &claude_session(&[("msg_1", 5), ("msg_2", 20)]));
        fixture.write(ROLLOUT, &codex_session(&["resp_1"]));
        assert!(fixture.pass().complete);
        extract(&fixture, &everything());
        let store = fixture.places.store.root().to_path_buf();
        let analytics = root(&fixture);
        let with_secret = |dir: &Path| -> Vec<PathBuf> { walk(dir).into_iter().filter(|path| holds(&fs::read(path).unwrap())).collect() };

        // In the store it is in chunks/, pending/ and the tables, and in the tables only in their Parquet folder.
        let found = with_secret(&store);
        assert!(!found.is_empty());
        for path in &found {
            let inside = path.strip_prefix(&store).unwrap();
            assert!(inside.starts_with("chunks") || inside.starts_with("pending") || inside.starts_with("analytics/v1"), "{}", inside.display());
        }
        assert!(found.iter().any(|path| path.starts_with(analytics.join("v1"))));
        assert!(!holds(&fs::read(analytics.join("state.db")).unwrap()));
        assert!(!holds(&fs::read(analytics.join("manifest.json")).unwrap()));
        // Nothing of it reaches the index or the journal.
        fixture.db.execute_batch("PRAGMA wal_checkpoint(PASSIVE);").unwrap();
        for path in walk(fixture.db_path.parent().unwrap()) {
            assert!(!holds(&fs::read(&path).unwrap()), "{}", path.display());
        }

        // What the status says of the tables is counts, and a failure's kind with nothing of what the engine said.
        note(&fixture.db, &extract_pass(&fixture.db, &fixture.places, &analytics, &Copier, &everything(), &|| false)).unwrap();
        let settings = super::super::Settings { analytics: true, ..Default::default() };
        let said = |fixture: &Fixture| serde_json::to_string(&super::super::analytics_status(&fixture.db, &settings).unwrap()).unwrap();
        assert!(said(&fixture).contains("\"rows\":11,") && !said(&fixture).contains("SECRET"), "{}", said(&fixture));
        note(&fixture.db, &Err(session_tables_failure())).unwrap();
        assert!(said(&fixture).contains("\"lastError\":\"The query engine stopped while writing tables (IO Error)\"") && !said(&fixture).contains("SECRET"), "{}", said(&fixture));

        // Numbers only makes the tables again, with the same rows and none of the text.
        let lines = rows(&fixture, "lines").len();
        let report = extract(&fixture, &ExtractOptions { detail: Detail::Numbers, ..everything() });
        assert_eq!(report.versions, 2);
        assert_eq!(rows(&fixture, "lines").len(), lines);
        assert!(!rows(&fixture, "messages").is_empty());
        assert_eq!(with_secret(&analytics), Vec::<PathBuf>::new());
        // And the same detail again reads nothing.
        assert_eq!(extract(&fixture, &ExtractOptions { detail: Detail::Numbers, ..everything() }).versions, 0);
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn lines_are_numbered_across_pieces_and_one_too_long_to_read_is_noted_with_its_size() {
        let mut lines = Lines::new(0, 0, 0);
        lines.longest = 8;
        let mut found: Vec<(u64, String)> = Vec::new();
        let mut each = |number: u64, line: Found<'_>| {
            found.push((number, match line {
                Found::Whole(bytes) => String::from_utf8_lossy(bytes).into_owned(),
                Found::TooLong(bytes) => format!("<{bytes} bytes>"),
            }))
        };
        for piece in ["ab", "c\nde\n0123456", "789012345", "6789\nf\ngh"] {
            lines.feed(piece.as_bytes(), &mut each);
        }
        assert_eq!((lines.count, lines.end), (4, 4 + 3 + 21 + 2));
        lines.finish(&mut each);
        assert_eq!((lines.count, lines.end), (5, 4 + 3 + 21 + 2 + 2));
        assert_eq!(found, [(0, "abc".to_string()), (1, "de".to_string()), (2, "<20 bytes>".to_string()), (3, "f".to_string()), (4, "gh".to_string())]);

        // Read again from the start, the lines read before are passed by.
        let mut again = Lines::new(0, 0, 3);
        let mut found: Vec<u64> = Vec::new();
        again.feed(b"abc\nde\nxyz\nf\ngh\n", &mut |number, _| found.push(number));
        assert_eq!(found, [3, 4]);
    }

    #[test]
    fn only_the_pinned_download_is_unpacked_and_only_its_program() {
        use sha2::{Digest, Sha256};
        use std::os::unix::fs::PermissionsExt;
        let pack = |entries: &[(&str, &[u8])]| -> Vec<u8> {
            let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
            for (name, bytes) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                builder.append_data(&mut header, name, *bytes).unwrap();
            }
            builder.into_inner().unwrap().finish().unwrap()
        };
        let sha = |bytes: &[u8]| -> String { Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect() };
        let base = super::super::store::tests::temp_dir("analytics-engine-put");
        let dir = base.join("query-engine");
        let good = pack(&[("README", b"read me"), ("duckdb", b"#!/bin/sh\necho duck\n")]);

        // Another hash, or another size, is refused before anything is written.
        assert_eq!(put_engine(&good, &sha(b"something else"), good.len() as u64, &dir).unwrap_err(), WRONG_DOWNLOAD);
        assert_eq!(put_engine(&good, &sha(&good), good.len() as u64 + 1, &dir).unwrap_err(), WRONG_DOWNLOAD);
        assert!(!dir.exists());

        // An older release's folder goes once the pinned one is in.
        fs::create_dir_all(dir.join("duckdb-0.0.1")).unwrap();
        put_engine(&good, &sha(&good), good.len() as u64, &dir).unwrap();
        let program = dir.join(engine_folder()).join("duckdb");
        assert_eq!(fs::read(&program).unwrap(), b"#!/bin/sh\necho duck\n");
        assert_eq!(fs::metadata(&program).unwrap().permissions().mode() & 0o777, 0o700);
        let mut kept: Vec<String> = walk(&dir).iter().map(|path| path.strip_prefix(&dir).unwrap().to_string_lossy().into_owned()).collect();
        kept.sort();
        assert_eq!(kept, [format!("{}/duckdb", engine_folder())]);
        assert!(!dir.join("duckdb-0.0.1").exists());

        // An archive with no program in it, or with one tucked in a folder, isn't one.
        let empty = pack(&[("bin/duckdb", b"x"), ("README", b"read me")]);
        assert_eq!(put_engine(&empty, &sha(&empty), empty.len() as u64, &base.join("other")).unwrap_err(), "The query engine download has no program in it");
        // Every pin is a release archive's name, a SHA-256 and a size.
        assert!(DUCKDB_ARCHIVES.iter().all(|(_, name, sha256, size)| name.ends_with(".tar.gz") && sha256.len() == 64 && *size > 1 << 20));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_reset_that_was_asked_for_removes_the_tables_once_and_the_next_pass_makes_them_again() {
        let fixture = Fixture::new("analytics-reset");
        fixture.write(MAIN, &claude_session(&[("msg_1", 5), ("msg_2", 20)]));
        assert!(fixture.pass().complete);
        let outcome = Ok(extract(&fixture, &everything()));
        note(&fixture.db, &outcome).unwrap();
        let noted = standing(&fixture.db).unwrap().unwrap();
        assert_eq!((noted.rows, noted.versions_left, noted.error.as_deref()), (outcome.as_ref().unwrap().rows, 0, None));
        assert!(noted.bytes > 0);
        // A pass that fails keeps the counts and says why, with nothing of what was said.
        note(&fixture.db, &extract_pass(&fixture.db, &fixture.places, &root(&fixture), &Broken, &ExtractOptions { detail: Detail::Numbers, ..everything() }, &|| false)).unwrap();
        let failed = standing(&fixture.db).unwrap().unwrap();
        assert_eq!((failed.rows, failed.error.as_deref()), (noted.rows, Some("The query engine stopped while writing tables (IO Error)")));

        // Nothing asked: nothing removed.
        reset_if_asked(&fixture.db, &root(&fixture)).unwrap();
        assert!(root(&fixture).join("state.db").exists());
        ask_reset(&fixture.db).unwrap();
        reset_if_asked(&fixture.db, &root(&fixture)).unwrap();
        assert!(!root(&fixture).exists());
        assert_eq!(standing(&fixture.db).unwrap(), None);
        // Chunks are untouched, so the tables come back whole.
        assert_eq!(extract(&fixture, &everything()).rows, noted.rows);
        reset_if_asked(&fixture.db, &root(&fixture)).unwrap();
        assert!(root(&fixture).exists());

        // A link where the folder should be is left alone, and so is what it points at.
        fs::remove_dir_all(root(&fixture)).unwrap();
        let elsewhere = fixture.base.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("keep"), "x").unwrap();
        std::os::unix::fs::symlink(&elsewhere, root(&fixture)).unwrap();
        ask_reset(&fixture.db).unwrap();
        reset_if_asked(&fixture.db, &root(&fixture)).unwrap();
        assert!(elsewhere.join("keep").exists());
        let _ = fs::remove_dir_all(&fixture.base);
    }

    /// With DuckDB itself, when `SESSION_TABLES_DUCKDB` names its program (`scripts/check-query-engine.sh`).
    #[test]
    fn with_the_real_engine_the_tables_answer_a_query() {
        let Some(path) = std::env::var_os("SESSION_TABLES_DUCKDB").filter(|path| !path.is_empty()) else { return };
        let engine = Program { path: PathBuf::from(path) };
        let fixture = Fixture::new("analytics-engine");
        fixture.write(MAIN, &claude_session(&[("msg_1", 5), ("msg_2", 20)]));
        fixture.write(ROLLOUT, &codex_session(&["resp_1", "resp_2"]));
        assert!(fixture.pass().complete);
        fixture.db.execute("UPDATE versions SET state = 'settled'", []).unwrap();
        let report = extract_pass(&fixture.db, &fixture.places, &root(&fixture), &engine, &ExtractOptions { merge_at: 1, ..everything() }, &|| false).unwrap();
        assert!(report.complete && report.failures == 0, "{report:?}");
        let tables = Tables::open(&root(&fixture)).unwrap();
        assert!(tables.parts("lines").iter().all(|part| part.month.as_deref() == Some("2026-09")));
        let answer = engine.run(&format!("{}SELECT agent, count(*) AS requests, CAST(sum(output) AS BIGINT) AS output FROM requests GROUP BY ALL ORDER BY ALL;", tables.views())).unwrap();
        assert_eq!(serde_json::from_str::<Value>(answer.trim()).unwrap(), serde_json::json!([{ "agent": "claude", "requests": 2, "output": 25 }, { "agent": "codex", "requests": 2, "output": 200 }]));
        let _ = fs::remove_dir_all(&fixture.base);
    }
}

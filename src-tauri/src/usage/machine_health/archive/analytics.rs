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

use super::classify::{load_version, Blobs, Version};
use super::codec;
use super::ingest::Throttle;
use super::tokens::{pieces, read_piece, Piece};
use rusqlite::{params, Connection, OptionalExtension};
use session_tables::store::{Batch, Engine, Origin, Store as Tables};
use session_tables::{Agent, At, Detail, Line, Parser, Rows, State};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

/// The folder in a store.
pub(crate) const FOLDER: &str = "analytics";
/// A table's fresh files are folded into months once there are this many.
pub(crate) const MERGE_AT: usize = 8;
/// What a row is. Changing it makes the tables again.
const RULE: &str = "tables-v1";
/// A write is made once this much is waiting.
const BATCH_BYTES: u64 = 64 << 20;
/// A version's rows wait in memory until it's read to its end, unless it has this much to read: then what's
/// waiting is written first, and the version's rows follow as they're read.
const HELD_BYTES: u64 = 64 << 20;
/// A longer line isn't read into rows: it's noted with its size.
const LONG_LINE: usize = 256 << 20;

/// The versions that are Claude Code's or Codex's transcripts, newest first so the latest months fill in first.
/// The members are the ones token counting reads (`tokens::UNCOUNTED`).
const TRANSCRIPTS: &str = "SELECT v.version_id, s.agent, v.size, v.state,
       (SELECT o_s.machine FROM observations o JOIN files f USING (file_id) JOIN sources o_s USING (source_id)
         WHERE o.version_id = v.version_id ORDER BY o.first_at, o.file_id LIMIT 1)
     FROM versions v JOIN members m USING (member_id) JOIN sessions s USING (session_pk)
     WHERE v.encoding IN ('plain', 'zstd')
       AND ((s.agent = 'claude' AND (m.member = 'main' OR m.member LIKE 'main~%' OR (m.member LIKE 'subagents/%' AND m.member LIKE '%.jsonl')))
         OR (s.agent = 'codex' AND (m.member = 'rollout' OR m.member LIKE 'rollout/%' OR m.member LIKE 'original/%')))
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
";

pub(crate) struct ExtractOptions {
    pub(crate) detail: Detail,
    pub(crate) bytes_per_second: u64,
    /// Reading stops once it has read this much, or run this long, and carries on next pass.
    pub(crate) max_bytes: u64,
    pub(crate) max_time: Duration,
    /// A table's fresh files are folded into months once there are this many.
    pub(crate) merge_at: usize,
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
}

/// DuckDB's program, which Arbor fetches when analytics is first turned on, if it's there.
pub(crate) fn engine() -> Option<Duck> {
    let path = crate::core_base_dir().ok()?.join("query-engine").join(format!("duckdb-{}", session_tables::store::DUCKDB_VERSION)).join("duckdb");
    path.is_file().then_some(Duck(session_tables::store::Program { path }))
}

/// DuckDB, started the way every helper is: with none of Arbor's open files.
pub(crate) struct Duck(session_tables::store::Program);

impl Engine for Duck {
    fn run(&self, sql: &str) -> Result<String, String> {
        crate::keep_open_files_from_helpers();
        self.0.run(sql)
    }
}

/// Notes why the last pass couldn't make the tables, or that it could.
pub(crate) fn note_failure(db: &Connection, error: Option<&str>) -> Result<(), String> {
    let _writes = super::index::lock_writes();
    match error {
        Some(error) => super::index::set_meta(db, "analyticsError", error),
        None => db.execute("DELETE FROM meta WHERE key = 'analyticsError'", []).map(|_| ()).map_err(index_error),
    }
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
}

fn open_state(root: &Path) -> Result<Connection, String> {
    let state = Connection::open(root.join("state.db")).map_err(state_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(root.join("state.db"), std::fs::Permissions::from_mode(0o600));
    }
    state.execute_batch(STATE_SCHEMA).map_err(state_error)?;
    Ok(state)
}

fn meta(state: &Connection, key: &str) -> Result<Option<String>, String> {
    state.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| row.get(0)).optional().map_err(state_error)
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
    state.execute_batch("DELETE FROM progress; DELETE FROM staged; DELETE FROM meta WHERE key = 'madeBy';").map_err(state_error)?;
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
    transaction.commit().map_err(state_error)
}

fn save(state: &Connection, steps: &[Step], batch: Option<u64>) -> Result<(), String> {
    let transaction = state.unchecked_transaction().map_err(state_error)?;
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
    state: Connection,
    engine: &'a dyn Engine,
    batch: Batch,
    steps: Vec<Step>,
    rows: u64,
}

impl Writer<'_> {
    fn write(&mut self) -> Result<(), String> {
        let batch = std::mem::replace(&mut self.batch, self.tables.batch()?);
        let steps = std::mem::take(&mut self.steps);
        if batch.bytes() == 0 {
            batch.discard();
            return save(&self.state, &steps, None);
        }
        save(&self.state, &steps, Some(self.tables.next()))?;
        self.rows += self.tables.write(batch, self.engine)?;
        settle(&self.state, &self.tables)
    }

    /// Drops what's waiting. The versions in it are read again from where they were.
    fn forget(&mut self) -> Result<(), String> {
        std::mem::replace(&mut self.batch, self.tables.batch()?).discard();
        self.steps.clear();
        Ok(())
    }
}

/// Reads what's new in every kept Claude Code and Codex transcript into the tables in `root`. `stop` is asked
/// between pieces.
pub(crate) fn extract_pass(db: &Connection, blobs: &dyn Blobs, root: &Path, engine: &dyn Engine, options: &ExtractOptions, stop: &dyn Fn() -> bool) -> Result<ExtractReport, String> {
    let started = Instant::now();
    let (tables, state) = open(root, options.detail)?;
    settle(&state, &tables)?;
    tables.sweep()?;
    let todo = todo(db, &state)?;
    let batch = tables.batch()?;
    let mut writer = Writer { tables, state, engine, batch, steps: Vec::new(), rows: 0 };
    let mut report = ExtractReport { complete: true, ..ExtractReport::default() };
    let mut throttle = Throttle::new(options.bytes_per_second);
    let out_of_time = |read: u64| stop() || read >= options.max_bytes || started.elapsed() >= options.max_time;
    for item in todo {
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
        let from = state_of(&writer.state, item.version_id)?;
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
                    writer.batch.add(&origin, rows)?;
                    *rows = Rows::default();
                    Ok(())
                };
                read_version(db, blobs, &item, &from, options.detail, &mut throttle, &mut enough, &mut rows, &mut spill).and_then(|done| {
                    writer.batch.add(&origin, &rows)?;
                    Ok(done)
                })
            }
        };
        report.bytes_read = read;
        match result {
            Ok((step, finished)) => {
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
            // Read again next pass.
            Err(error) => {
                if spilled {
                    writer.forget()?;
                }
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
    Ok(report)
}

/// The versions with something left to read: ones that grew, and ones that have stopped growing since their last
/// row was held back for a line that never came.
fn todo(db: &Connection, state: &Connection) -> Result<Vec<Todo>, String> {
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
            todo.push(Todo { version_id, agent: if agent == "codex" { Agent::Codex } else { Agent::Claude }, machine });
        }
    }
    Ok(todo)
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
            lines.feed(&buffer[..read], &mut |number, line| row(&mut parser, rows, number, line));
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
            lines.feed(bytes.get(skip..).unwrap_or_default(), &mut |number, line| row(&mut parser, rows, number, line));
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
        lines.finish(&mut |number, line| row(&mut parser, rows, number, line));
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

fn row(parser: &mut Parser, rows: &mut Rows, number: u64, line: Found<'_>) {
    match line {
        Found::Whole(line) => parser.line(number, line, rows),
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
    use super::super::tokens::tests::{claude_line, codex_record, codex_turn, codex_usage};
    use super::*;
    use serde_json::Value;
    use session_tables::store::Program;
    use std::cell::Cell;
    use std::fs;
    use std::path::PathBuf;

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

    fn everything() -> ExtractOptions {
        ExtractOptions { detail: Detail::Everything, bytes_per_second: 1 << 40, max_bytes: 1 << 40, max_time: Duration::from_secs(600), merge_at: usize::MAX }
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
        assert_eq!(report.rows, ["lines", "messages", "requests", "tool_calls", "tool_results", "tool_io", "commands", "hooks", "prompts", "tool_defs", "context_use", "files_touched"].iter().map(|table| rows(&fixture, table).len() as u64).sum::<u64>());
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
                let item = todo(&fixture.db, &state).unwrap().remove(0);
                let mut found = Rows::default();
                let (step, _) = read_version(&fixture.db, &fixture.places, &item, &Step::default(), Detail::Everything, &mut Throttle::new(1 << 40), &mut |_| false, &mut found, &mut |_| Ok(())).unwrap();
                let mut batch = tables.batch().unwrap();
                batch.add(&Origin { agent: item.agent, machine: "mac", source: &item.version_id.to_string() }, &found).unwrap();
                save(&state, &[step], Some(tables.next())).unwrap();
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
    fn a_version_that_cannot_be_read_is_left_for_the_next_pass_and_the_rest_are_read() {
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
        let report = extract(&fixture, &everything());
        assert_eq!((report.failures, report.versions), (0, 1));
        assert_eq!(agents(&fixture).len(), 2);
        assert_eq!(rows(&fixture, "lines").len(), 3 + 3);
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

//! archive.db: the archive's index, on this Mac's own disk next to the
//! authoritative copies of growing tails. It holds ids, paths, sizes, hashes
//! and times, and token counts by model, never what a transcript says.
//! Everything in it can be rebuilt from a store's journal and chunks.

use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS stores(
  store_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('main','replica','spool','index')),
  machine TEXT NOT NULL, root TEXT NOT NULL, mount_point TEXT, dev INTEGER,
  added_at INTEGER NOT NULL, last_seen_at INTEGER, last_check_at INTEGER,
  journal_seq INTEGER NOT NULL DEFAULT 0, bytes_free INTEGER,
  state TEXT NOT NULL DEFAULT 'ok', detail TEXT) STRICT;
CREATE TABLE IF NOT EXISTS chunks(
  hash BLOB PRIMARY KEY CHECK(length(hash) = 32), len INTEGER NOT NULL, zlen INTEGER NOT NULL,
  zhash BLOB NOT NULL, mid_line INTEGER NOT NULL DEFAULT 0, first_at INTEGER NOT NULL) STRICT, WITHOUT ROWID;
-- state: 1 written and read back when written, 2 file hash checked, 3 contents checked, -1 missing, -2 damaged
CREATE TABLE IF NOT EXISTS chunk_copies(
  hash BLOB NOT NULL REFERENCES chunks(hash), store_id TEXT NOT NULL REFERENCES stores(store_id),
  state INTEGER NOT NULL, checked_at INTEGER NOT NULL, PRIMARY KEY(hash, store_id)) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sources(
  source_id INTEGER PRIMARY KEY, machine TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('home','import')),
  agent TEXT NOT NULL, root TEXT NOT NULL, label TEXT NOT NULL, retention_days INTEGER,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER, complete_lists INTEGER NOT NULL DEFAULT 0,
  UNIQUE(machine, root)) STRICT;
CREATE TABLE IF NOT EXISTS sessions(
  session_pk INTEGER PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL,
  project_key TEXT, first_seen_at INTEGER NOT NULL, UNIQUE(agent, session_id)) STRICT;
CREATE TABLE IF NOT EXISTS members(
  member_id INTEGER PRIMARY KEY, session_pk INTEGER NOT NULL REFERENCES sessions(session_pk),
  member TEXT NOT NULL, UNIQUE(session_pk, member)) STRICT;
-- committed_len is where the last whole chunk ends. The bytes after it, up to size, are the
-- tail: in pending/ while the version grows, and its last chunk once it has settled.
CREATE TABLE IF NOT EXISTS versions(
  version_id INTEGER PRIMARY KEY, vk TEXT NOT NULL UNIQUE, member_id INTEGER NOT NULL REFERENCES members(member_id),
  state TEXT NOT NULL CHECK(state IN ('growing','settled','lost-tail')),
  encoding TEXT NOT NULL DEFAULT 'plain' CHECK(encoding IN ('plain','zstd','sqlite')),
  committed_len INTEGER NOT NULL DEFAULT 0, committed_mid BLOB, committed_sha BLOB,
  head_sha BLOB, win_sha BLOB,
  tail_len INTEGER NOT NULL DEFAULT 0, tail_sha BLOB, pending_gen INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL, sha256 BLOB, has_ordinal INTEGER,
  created_at INTEGER NOT NULL, grew_at INTEGER, settled_at INTEGER) STRICT;
CREATE INDEX IF NOT EXISTS versions_member ON versions(member_id);
CREATE INDEX IF NOT EXISTS versions_growing ON versions(state) WHERE state = 'growing';
CREATE TABLE IF NOT EXISTS version_chunks(
  version_id INTEGER NOT NULL REFERENCES versions(version_id), ord INTEGER NOT NULL, off INTEGER NOT NULL,
  hash BLOB NOT NULL REFERENCES chunks(hash), len INTEGER NOT NULL, PRIMARY KEY(version_id, ord)) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS version_chunks_hash ON version_chunks(hash);
CREATE TABLE IF NOT EXISTS superseded(
  version_id INTEGER NOT NULL REFERENCES versions(version_id), off INTEGER NOT NULL,
  hash BLOB NOT NULL REFERENCES chunks(hash), len INTEGER NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY(version_id, off, hash)) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS files(
  file_id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(source_id), rel_path TEXT NOT NULL,
  member_id INTEGER REFERENCES members(member_id), via_link INTEGER NOT NULL DEFAULT 0,
  dev INTEGER, ino INTEGER, size INTEGER, mtime_ns INTEGER, ctime_ns INTEGER,
  version_id INTEGER REFERENCES versions(version_id), matched_len INTEGER,
  state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live','unreachable','gone','skipped')), skip_reason TEXT,
  missing_lists INTEGER NOT NULL DEFAULT 0, at_risk_at INTEGER, sample_rot INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, gone_at INTEGER,
  UNIQUE(source_id, rel_path)) STRICT;
CREATE INDEX IF NOT EXISTS files_version ON files(version_id);
-- One row for each file a version was seen in, kept current as the file grows.
CREATE TABLE IF NOT EXISTS observations(
  version_id INTEGER NOT NULL REFERENCES versions(version_id), file_id INTEGER NOT NULL REFERENCES files(file_id),
  len INTEGER NOT NULL, sha256 BLOB NOT NULL,
  how TEXT NOT NULL CHECK(how IN ('new','grew','identical','prefix','import')),
  mtime INTEGER, first_at INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(version_id, file_id)) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS relations(
  a INTEGER NOT NULL REFERENCES versions(version_id), b INTEGER NOT NULL REFERENCES versions(version_id),
  kind TEXT NOT NULL CHECK(kind IN ('rewritten','diverged','reshaped','decoded-from')),
  common_len INTEGER NOT NULL, PRIMARY KEY(a, b)) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS runs(
  run_id INTEGER PRIMARY KEY, machine TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
  complete INTEGER, files_listed INTEGER, files_changed INTEGER, bytes_read INTEGER, bytes_new INTEGER,
  error TEXT) STRICT;
-- AUTOINCREMENT so seqs keep counting up after the outbox is emptied.
CREATE TABLE IF NOT EXISTS journal_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, line TEXT NOT NULL) STRICT;
-- Old backups the user brought in, and the agent homes found in each. An import is listed and
-- kept until a pass has kept all of it, then finished_at is set and it isn't listed again.
-- A root's layout says how it's listed (see imports and layouts); machine, when set, is where
-- that root came from instead of the import's machine. store and device are kept for imports
-- recorded by older versions, and aren't read.
CREATE TABLE IF NOT EXISTS imports(
  import_id INTEGER PRIMARY KEY, path TEXT NOT NULL, machine TEXT NOT NULL, added_at INTEGER NOT NULL,
  finished_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, error TEXT) STRICT;
CREATE TABLE IF NOT EXISTS import_roots(
  root TEXT PRIMARY KEY, import_id INTEGER NOT NULL REFERENCES imports(import_id) ON DELETE CASCADE,
  agent TEXT NOT NULL, layout TEXT NOT NULL DEFAULT 'home', machine TEXT, store TEXT, device TEXT) STRICT;
-- Token counts for the all-time total, made from the kept transcripts: for each call a hashed
-- key and its output so far, totals by day, machine, agent and model, and how far each version
-- has been counted. The model and the counts are all a call gives up.
CREATE TABLE IF NOT EXISTS token_days(
  bucket_id INTEGER PRIMARY KEY, day INTEGER NOT NULL, source_id INTEGER NOT NULL REFERENCES sources(source_id),
  agent TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0, UNIQUE(day, source_id, agent, model)) STRICT;
CREATE TABLE IF NOT EXISTS token_calls(key INTEGER PRIMARY KEY, bucket INTEGER NOT NULL REFERENCES token_days(bucket_id), output INTEGER NOT NULL) STRICT;
-- counted_len is where the last whole line counted ends; seen_len is the size last counted.
CREATE TABLE IF NOT EXISTS token_progress(
  version_id INTEGER PRIMARY KEY REFERENCES versions(version_id), counted_len INTEGER NOT NULL, seen_len INTEGER NOT NULL,
  model TEXT, records INTEGER NOT NULL DEFAULT 0) STRICT;
-- Claude Code's own daily totals, from the stats-cache.json its homes keep: for each machine and
-- day, the most any kept copy gives for each model and for the sessions. Numbers and model names only.
CREATE TABLE IF NOT EXISTS recovered_tokens(
  machine TEXT NOT NULL, day INTEGER NOT NULL, model TEXT NOT NULL, tokens INTEGER NOT NULL,
  PRIMARY KEY(machine, day, model)) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS recovered_sessions(
  machine TEXT NOT NULL, day INTEGER NOT NULL, sessions INTEGER NOT NULL, PRIMARY KEY(machine, day)) STRICT, WITHOUT ROWID;
"#;

/// Columns added to a table after it was first made, which an index made before them gets here.
const ADDED_COLUMNS: &[(&str, &str, &str)] = &[
    ("import_roots", "layout", "TEXT NOT NULL DEFAULT 'home'"),
    ("import_roots", "machine", "TEXT"),
    ("import_roots", "store", "TEXT"),
    ("import_roots", "device", "TEXT"),
];

/// Writes to archive.db are made one at a time within the app.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn lock_writes() -> MutexGuard<'static, ()> {
    // The lock guards no data, so a poisoned one is fine to keep using.
    WRITE_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| format!("Couldn't open the archive index: {error}"))?;
    prepare(&connection)?;
    Ok(connection)
}

pub(crate) fn prepare(connection: &Connection) -> Result<(), String> {
    connection.busy_timeout(Duration::from_secs(5)).map_err(|error| error.to_string())?;
    connection
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;")
        .map_err(|error| format!("Couldn't set up the archive index: {error}"))?;
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if version > SCHEMA_VERSION {
        return Err("The archive index was made by a newer Arbor".into());
    }
    connection.execute_batch(SCHEMA).map_err(|error| format!("Couldn't set up the archive index: {error}"))?;
    for (table, column, kind) in ADDED_COLUMNS {
        let has: bool = connection
            .query_row("SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name = ?2", params![table, column], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if !has {
            connection.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {kind};")).map_err(|error| format!("Couldn't set up the archive index: {error}"))?;
        }
    }
    // Setting it takes the write lock, so an open that always set it waited behind whatever was writing, and
    // failed after the busy timeout. Everything above only reads when the tables are already there.
    if version != SCHEMA_VERSION {
        connection.pragma_update(None, "user_version", SCHEMA_VERSION).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn get_meta(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| row.get(0)).optional().map_err(|error| error.to_string())
}

pub(crate) fn set_meta(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute("INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value])
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
pub(crate) fn memory() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    prepare(&connection).unwrap();
    connection
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_index_made_before_a_column_gets_it() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE imports(import_id INTEGER PRIMARY KEY, path TEXT NOT NULL, machine TEXT NOT NULL, added_at INTEGER NOT NULL,
                   finished_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, error TEXT) STRICT;
                 CREATE TABLE import_roots(root TEXT PRIMARY KEY, import_id INTEGER NOT NULL REFERENCES imports(import_id) ON DELETE CASCADE, agent TEXT NOT NULL) STRICT;
                 INSERT INTO imports(import_id, path, machine, added_at) VALUES(1, '/b', 'mac', 0);
                 INSERT INTO import_roots(root, import_id, agent) VALUES('/b/.claude', 1, 'claude');
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        prepare(&connection).unwrap();
        // Twice, as every open does.
        prepare(&connection).unwrap();
        let row: (String, Option<String>, Option<String>, Option<String>) =
            connection.query_row("SELECT layout, machine, store, device FROM import_roots", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).unwrap();
        assert_eq!(row, ("home".to_string(), None, None, None));
    }

    #[test]
    fn opening_the_index_while_it_is_being_written_does_not_wait() {
        let dir = super::super::store::tests::temp_dir("index-open");
        let path = dir.join("archive.db");
        open(&path).unwrap();
        let writer = open(&path).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE; INSERT INTO meta(key, value) VALUES('held', '1');").unwrap();
        let reader = Connection::open(&path).unwrap();
        prepare(&reader).unwrap();
        reader.busy_timeout(Duration::ZERO).unwrap();
        assert_eq!(get_meta(&reader, "held").unwrap(), None);
        writer.execute_batch("COMMIT").unwrap();
        assert_eq!(get_meta(&reader, "held").unwrap().as_deref(), Some("1"));
        let _ = std::fs::remove_dir_all(dir);
    }
}

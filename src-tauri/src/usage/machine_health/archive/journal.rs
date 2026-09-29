//! Every change to the index is also written as a JSON line to the store's
//! journal, so the store alone can rebuild the index. A line goes into
//! journal_outbox in the same transaction as the change, then the flusher
//! appends it to journal/<first seq>.jsonl and deletes it from the outbox.
//! A crash between the two leaves a line written twice, which replay skips by
//! its seq. Lines hold ids, paths, sizes, hashes and times, never content.

use super::sha::{hex, sha256};
use super::store::Store;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// A segment this big is sealed and a new one started.
const SEGMENT_MAX: u64 = 64 << 20;

pub(crate) fn emit(connection: &Connection, event: Value) -> Result<(), String> {
    debug_assert!(event.get("t").is_some());
    connection.execute("INSERT INTO journal_outbox(line) VALUES(?1)", [event.to_string()]).map(|_| ()).map_err(|error| error.to_string())
}

fn segment_name(seq: i64) -> String {
    format!("{seq:012}.jsonl")
}

fn sealed(path: &Path) -> bool {
    path.with_extension("jsonl.sha256").exists()
}

/// The segment to append to: the newest, unless it's sealed or full.
fn active_segment(dir: &Path, first_seq: i64) -> Result<PathBuf, String> {
    let newest = fs::read_dir(dir)
        .map_err(|error| format!("Couldn't read the journal: {error}"))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .max();
    if let Some(path) = newest {
        if !sealed(&path) {
            let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            if size < SEGMENT_MAX {
                return Ok(path);
            }
            seal(&path)?;
        }
    }
    Ok(dir.join(segment_name(first_seq)))
}

/// Writes the segment's hash beside it, in the form `shasum -c` reads.
fn seal(path: &Path) -> Result<(), String> {
    let bytes = fs::read(path).map_err(|error| format!("Couldn't read a journal segment: {error}"))?;
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
    super::store::write_atomic(&path.with_extension("jsonl.sha256"), format!("{}  {name}\n", hex(&sha256(&bytes))).as_bytes())
}

/// Moves what's in the outbox to the store's journal. Returns how many lines went.
pub(crate) fn flush(connection: &Connection, store: &Store) -> Result<usize, String> {
    let rows: Vec<(i64, String)> = {
        let mut statement = connection.prepare("SELECT seq, line FROM journal_outbox ORDER BY seq").map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|error| error.to_string())?
    };
    let (Some((first, _)), Some((last, _))) = (rows.first(), rows.last()) else {
        return Ok(0);
    };
    let (first, last) = (*first, *last);
    let mut text = String::new();
    for (seq, line) in &rows {
        // The seq goes first in each line, so replay can skip what it has already applied.
        text.push_str(&format!("{{\"seq\":{seq},{}\n", line.strip_prefix('{').unwrap_or(line)));
    }
    let path = active_segment(&store.root().join("journal"), first)?;
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|error| format!("Couldn't open the journal: {error}"))?;
    file.write_all(text.as_bytes()).map_err(|error| format!("Couldn't write the journal: {error}"))?;
    file.sync_all().map_err(|error| format!("Couldn't flush the journal: {error}"))?;
    let transaction = connection.unchecked_transaction().map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM journal_outbox WHERE seq <= ?1", params![last]).map_err(|error| error.to_string())?;
    super::index::set_meta(&transaction, "journalSeqFlushed", &last.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(rows.len())
}

/// Every journal line in a store, in order, each seq once.
#[cfg(test)]
pub(crate) fn read_all(store_root: &Path) -> Vec<Value> {
    let mut names: Vec<PathBuf> = fs::read_dir(store_root.join("journal")).unwrap().flatten().map(|entry| entry.path()).filter(|path| path.extension().is_some_and(|ext| ext == "jsonl")).collect();
    names.sort();
    let mut last = 0;
    let mut out = Vec::new();
    for name in names {
        for line in fs::read_to_string(name).unwrap().lines() {
            let value: Value = serde_json::from_str(line).unwrap();
            let seq = value["seq"].as_i64().unwrap();
            if seq > last {
                last = seq;
                out.push(value);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::store::tests::temp_dir;
    use super::*;
    use serde_json::json;

    #[test]
    fn lines_reach_the_store_once_in_order() {
        let base = temp_dir("journal");
        let store = Store::create(&base.join("s"), "a1", "mac", None).unwrap();
        let connection = super::super::index::memory();
        emit(&connection, json!({"t": "session", "pk": 1, "agent": "claude", "id": "s1"})).unwrap();
        emit(&connection, json!({"t": "member", "id": 1, "session": 1, "member": "main"})).unwrap();
        assert_eq!(flush(&connection, &store).unwrap(), 2);
        assert_eq!(flush(&connection, &store).unwrap(), 0);
        emit(&connection, json!({"t": "version", "id": 1, "v": "k1", "member": 1, "encoding": "plain"})).unwrap();
        // A crash after the write but before the outbox was cleared writes a line twice.
        let line = connection.query_row("SELECT seq, line FROM journal_outbox", [], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))).unwrap();
        flush(&connection, &store).unwrap();
        let segment = fs::read_dir(base.join("s/journal")).unwrap().flatten().next().unwrap().path();
        let mut file = OpenOptions::new().append(true).open(&segment).unwrap();
        writeln!(file, "{{\"seq\":{},{}", line.0, line.1.strip_prefix('{').unwrap()).unwrap();
        let lines = read_all(&base.join("s"));
        assert_eq!(lines.iter().map(|line| line["seq"].as_i64().unwrap()).collect::<Vec<_>>(), [1, 2, 3]);
        assert_eq!(lines[2]["t"], "version");
        // Seqs carry on after the outbox empties.
        emit(&connection, json!({"t": "settle", "v": 1, "size": 0, "sha": ""})).unwrap();
        assert_eq!(connection.query_row("SELECT seq FROM journal_outbox", [], |row| row.get::<_, i64>(0)).unwrap(), 4);
        assert_eq!(super::super::index::get_meta(&connection, "journalSeqFlushed").unwrap().as_deref(), Some("3"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_full_segment_is_sealed_and_a_new_one_started() {
        let base = temp_dir("journal-seal");
        let dir = base.join("journal");
        fs::create_dir_all(&dir).unwrap();
        let full = dir.join(segment_name(1));
        fs::write(&full, vec![b'x'; SEGMENT_MAX as usize]).unwrap();
        assert_eq!(active_segment(&dir, 90).unwrap(), dir.join(segment_name(90)));
        let sidecar = fs::read_to_string(full.with_extension("jsonl.sha256")).unwrap();
        assert!(sidecar.ends_with("  000000000001.jsonl\n"));
        let _ = fs::remove_dir_all(&base);
    }
}

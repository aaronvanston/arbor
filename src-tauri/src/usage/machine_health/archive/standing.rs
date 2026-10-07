//! How much of an agent home's sessions the archive has safely, for the clean-up to say before a home is set
//! aside. Only counts and a time come out: never a path, an id or anything a session says.
//!
//! A session file counts as archived when the archive knows it under that home (the source with that machine and
//! root), it's still there to read, and its version has settled into the store: not growing with its tail only in
//! pending/, not skipped or unreachable, not a version whose tail was lost.

use rusqlite::{params, Connection, OptionalExtension};

/// The session files of one home as the archive knows them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct HomeCounts {
    /// Session files (`.jsonl`) the archive has listed under the home and not seen go.
    pub(crate) known: u64,
    /// Of those, the ones safely in a store.
    pub(crate) safe: u64,
    /// When the machine's last complete pass started: files written after it may not be listed yet.
    pub(crate) last_pass_ms: Option<i64>,
}

fn db_error(error: rusqlite::Error) -> String {
    format!("The archive index failed: {error}")
}

/// The counts for the home at `root` on `machine`, as its sources row names them; all zero for a home the archive
/// has never listed.
pub(crate) fn home_counts(db: &Connection, machine: &str, root: &str) -> Result<HomeCounts, String> {
    let (known, safe): (i64, i64) = db
        .query_row(
            "SELECT COUNT(f.file_id),
               COUNT(f.file_id) FILTER (WHERE f.state = 'live' AND f.version_id IS NOT NULL AND v.state = 'settled')
             FROM sources s JOIN files f ON f.source_id = s.source_id LEFT JOIN versions v ON v.version_id = f.version_id
             WHERE s.kind = 'home' AND s.machine = ?1 AND s.root = ?2 AND f.state != 'gone' AND f.rel_path LIKE '%.jsonl'",
            params![machine, root.trim_end_matches('/')],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(db_error)?;
    let last_pass_ms: Option<i64> = db
        .query_row("SELECT MAX(started_at) FROM runs WHERE machine = ?1 AND complete = 1", [machine], |row| row.get(0))
        .optional()
        .map_err(db_error)?
        .flatten();
    Ok(HomeCounts { known: known.max(0) as u64, safe: safe.max(0) as u64, last_pass_ms })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::machine_health::archive::index;

    const SECRET: &str = "sk-standing-SECRET-do-not-leak";

    fn fixture() -> Connection {
        let db = index::memory();
        db.execute_batch(&format!(
            "INSERT INTO sources(source_id, machine, kind, agent, root, label, first_seen_at) VALUES
               (1, 'cam-mbp', 'home', 'claude', '/Users/cam/.claude', '~/.claude', 0),
               (2, 'cam-mbp', 'home', 'claude', '/Users/cam/.agent-app/homes/a', '~/.agent-app/homes/a', 0),
               (3, 'ci-01', 'home', 'claude', '/Users/cam/.claude', '~/.claude', 0);
             INSERT INTO sessions(session_pk, agent, session_id, first_seen_at) VALUES(1, 'claude', 's', 0);
             INSERT INTO members(member_id, session_pk, member) VALUES(1, 1, 'main');
             INSERT INTO versions(version_id, vk, member_id, state, size, created_at) VALUES
               (1, 'a', 1, 'settled', 10, 0), (2, 'b', 1, 'growing', 10, 0), (3, 'c', 1, 'lost-tail', 10, 0);
             INSERT INTO files(source_id, rel_path, version_id, state, first_seen_at, last_seen_at) VALUES
               (1, 'projects/-src-{SECRET}/one.jsonl', 1, 'live', 0, 0),
               (1, 'projects/-src/two.jsonl', 2, 'live', 0, 0),
               (1, 'projects/-src/three.jsonl', 3, 'live', 0, 0),
               (1, 'projects/-src/four.jsonl', NULL, 'live', 0, 0),
               (1, 'projects/-src/five.jsonl', 1, 'skipped', 0, 0),
               (1, 'projects/-src/six.jsonl', 1, 'unreachable', 0, 0),
               (1, 'projects/-src/gone.jsonl', 1, 'gone', 0, 0),
               (1, 'history.txt', 1, 'live', 0, 0),
               (2, 'projects/-x/a.jsonl', 1, 'live', 0, 0),
               (3, 'projects/-x/a.jsonl', 1, 'live', 0, 0);
             INSERT INTO runs(machine, started_at, finished_at, complete) VALUES
               ('cam-mbp', 100, 150, 1), ('cam-mbp', 200, 250, 0), ('ci-01', 300, 350, 1);"
        ))
        .unwrap();
        db
    }

    #[test]
    fn only_settled_session_files_still_there_count_as_archived() {
        let db = fixture();
        // one settled; growing, lost-tail, never kept, skipped and unreachable aren't; gone and other files aren't counted.
        assert_eq!(home_counts(&db, "cam-mbp", "/Users/cam/.claude").unwrap(), HomeCounts { known: 6, safe: 1, last_pass_ms: Some(100) });
        assert_eq!(home_counts(&db, "cam-mbp", "/Users/cam/.claude/").unwrap().known, 6, "a trailing slash is the same home");
        assert_eq!(home_counts(&db, "ci-01", "/Users/cam/.claude").unwrap(), HomeCounts { known: 1, safe: 1, last_pass_ms: Some(300) }, "by machine and root");
        assert_eq!(home_counts(&db, "cedar-02", "/Users/cam/.claude").unwrap(), HomeCounts::default(), "a home never listed");
    }

    #[test]
    fn the_counts_never_carry_a_path_or_what_a_session_says() {
        let db = fixture();
        let counts = home_counts(&db, "cam-mbp", "/Users/cam/.claude").unwrap();
        assert!(!format!("{counts:?}").contains(SECRET));
        assert!(!format!("{counts:?}").contains("projects"));
    }
}

//! What Compute needs from usage.db to link a sandbox to what started it: the names on the Machines list, and for each
//! session id a link gave, whether Arbor has seen it and whether it's live. Sessions are matched by exact id only, and
//! live means what it means everywhere else in Arbor: a request in the last `ACTIVE_SESSION_WINDOW_MS`.

use super::machine_health::{harnesses::Harness, read_hosts};
use super::{open_usage_database, run_usage_task, ACTIVE_SESSION_WINDOW_MS};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{BTreeMap, BTreeSet};

/// A session as usage.db has it: its last request, and the agent whose transcript held it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SeenSession {
    pub(crate) last_request_ms: Option<i64>,
    pub(crate) harness: Option<Harness>,
}

impl SeenSession {
    /// Live by Arbor's own rule for a live session.
    pub(crate) fn live_at(&self, now_ms: i64) -> bool {
        self.last_request_ms.is_some_and(|at| at >= now_ms.saturating_sub(ACTIVE_SESSION_WINDOW_MS))
    }
}

/// The machines on the Machines list, and the sessions asked about that Arbor has seen.
#[derive(Clone, Debug, Default)]
pub(crate) struct ComputeLookup {
    pub(crate) machines: BTreeSet<String>,
    pub(crate) sessions: BTreeMap<String, SeenSession>,
}

/// One read of the Machines list and one indexed read per session, off the async runtime's workers.
pub(crate) async fn lookup(sessions: Vec<String>) -> Result<ComputeLookup, String> {
    run_usage_task(move || lookup_in(&open_usage_database()?, &sessions)).await
}

/// The names on the Machines list, for checking one a link names.
pub(crate) async fn machine_names() -> Result<BTreeSet<String>, String> {
    run_usage_task(|| Ok(lookup_in(&open_usage_database()?, &[])?.machines)).await
}

pub(super) fn lookup_in(connection: &Connection, sessions: &[String]) -> Result<ComputeLookup, String> {
    let machines = read_hosts(connection)?.into_iter().map(|host| host.machine).collect();
    // Both halves use an index: usage_events on (session_id, timestamp_ms), transcripts on their primary key.
    let mut statement = connection
        .prepare(
            "SELECT (SELECT MAX(timestamp_ms) FROM usage_events WHERE session_id = ?1),
                    (SELECT agent FROM usage_session_transcripts WHERE session_id = ?1)",
        )
        .map_err(|error| error.to_string())?;
    let mut seen = BTreeMap::new();
    for id in sessions {
        let row = statement
            .query_row(params![id], |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<String>>(1)?)))
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some((last_request_ms, agent)) = row {
            if last_request_ms.is_some() || agent.is_some() {
                let harness = agent.as_deref().map(Harness::from_id);
                seen.insert(id.clone(), SeenSession { last_request_ms, harness });
            }
        }
    }
    Ok(ComputeLookup { machines, sessions: seen })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::schema::{insert_request, test_database};

    #[test]
    fn finds_listed_machines_and_sessions_by_exact_id() {
        let connection = test_database();
        connection
            .execute(
                "INSERT INTO usage_machine_hosts(machine, endpoint, port, enabled, source) VALUES
                 ('cam-mbp', 'cam-mbp', 22, 1, 'manual'), ('ci-01', '', 22, 1, 'seed'), ('old-box', '', 22, 1, 'removed')",
                [],
            )
            .unwrap();
        insert_request(&connection, "timestamp_ms, session_id", params![1_000, "s-live"]);
        insert_request(&connection, "timestamp_ms, session_id", params![9_000, "s-live"]);
        connection
            .execute(
                "INSERT INTO usage_session_transcripts (session_id, machine, agent) VALUES ('s-live', 'cam-mbp', 'codex'), ('s-file', 'ci-01', 'claude')",
                [],
            )
            .unwrap();
        let asked = ["s-live", "s-file", "s-li", "nobody"].map(String::from);
        let found = lookup_in(&connection, &asked).unwrap();
        assert_eq!(found.machines.into_iter().collect::<Vec<_>>(), ["cam-mbp", "ci-01"]);
        assert_eq!(found.sessions.keys().collect::<Vec<_>>(), ["s-file", "s-live"]);
        let live = &found.sessions["s-live"];
        assert_eq!(live.last_request_ms, Some(9_000));
        assert_eq!(live.harness, Some(Harness::Codex));
        assert!(live.live_at(9_000 + ACTIVE_SESSION_WINDOW_MS));
        assert!(!live.live_at(9_001 + ACTIVE_SESSION_WINDOW_MS));
        let file_only = &found.sessions["s-file"];
        assert_eq!(file_only.last_request_ms, None);
        assert!(!file_only.live_at(9_000));
    }
}

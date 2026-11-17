//! What Compute needs from usage.db to link a sandbox to what started it: the names on the Machines list, and for each
//! session id a link gave, whether Arbor has seen it and whether it's live. Sessions are matched by exact id only, and
//! live means what it means everywhere else in Arbor: a request in the last `ACTIVE_SESSION_WINDOW_MS`.

use super::machine_health::{harnesses::Harness, read_hosts, MachineHost};
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

/// What a link's machine, as an agent typed it, comes to on the Machines list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ListedMachine {
    Found(String),
    /// It fits these machines and a link never picks between them.
    Several(Vec<String>),
    Unknown,
}

/// The machine on the Machines list a link means, from what an agent typed: its name, or failing that its name or its
/// SSH host in any case, with spaces, dashes or dots between words (`cam-dev-01` finds "Cam dev 01"), the way `arbor`
/// finds a machine. An agent knows its hostname, not the name Arbor shows.
pub(crate) async fn listed_machine(typed: String) -> Result<ListedMachine, String> {
    run_usage_task(move || Ok(matching_machine(&read_hosts(&open_usage_database()?)?, &typed))).await
}

/// How a name or host can be spelled: its letters and digits in lower case, and for a host with a domain, its first
/// label too, since `hostname` gives `cam-dev-01` where the list may hold `cam-dev-01.example.net` (or the reverse).
fn spellings(text: &str) -> Vec<String> {
    let loose = |text: &str| text.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect::<String>();
    let mut all = vec![loose(text)];
    if text.parse::<std::net::IpAddr>().is_err() {
        if let Some((first, _)) = text.split_once('.') {
            all.push(loose(first));
        }
    }
    all.retain(|spelling| !spelling.is_empty());
    all
}

/// An exact name wins. Otherwise names and hosts are weighed together, so a spelling that is one machine's name and
/// another's host is refused like any other that fits two: a link records a fact.
fn matching_machine(hosts: &[MachineHost], typed: &str) -> ListedMachine {
    if let Some(host) = hosts.iter().find(|host| host.machine == typed) {
        return ListedMachine::Found(host.machine.clone());
    }
    let wanted = spellings(typed);
    let fits = |text: &str| spellings(text).iter().any(|spelling| wanted.contains(spelling));
    // An SSH host may carry its user (`cam@cam-dev-01`), which is no part of the machine's hostname.
    let ssh_host = |endpoint: &str| endpoint.trim().rsplit('@').next().unwrap_or_default().to_string();
    let mut found: Vec<String> =
        hosts.iter().filter(|host| fits(&host.machine) || fits(&ssh_host(&host.endpoint))).map(|host| host.machine.clone()).collect();
    found.sort();
    found.dedup();
    match found.len() {
        0 => ListedMachine::Unknown,
        1 => ListedMachine::Found(found.remove(0)),
        _ => ListedMachine::Several(found),
    }
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

    #[test]
    fn a_link_finds_its_machine_by_name_or_host_and_never_picks_between_two() {
        let host = |machine: &str, endpoint: &str| MachineHost {
            machine: machine.into(),
            endpoint: endpoint.into(),
            port: 22,
            enabled: true,
            source: "manual".into(),
        };
        let hosts = [
            host("Cam dev 01", "cam-dev-01"),
            host("studio", "cam-studio.local"),
            host("Lab A", "shared"),
            host("lab-a", "shared"),
            host("CI 01", "10.0.0.7"),
            host("build", "ci-01"),
            host("Cam dev box", "cam@cam-dev-02"),
            host("far", "cam-far.example.net"),
            host("seeded", ""),
        ];
        let found = |typed: &str| matching_machine(&hosts, typed);
        let is = |name: &str| ListedMachine::Found(name.into());
        assert_eq!(found("Cam dev 01"), is("Cam dev 01"));
        assert_eq!(found("cam-dev-01"), is("Cam dev 01"));
        assert_eq!(found("STUDIO"), is("studio"));
        assert_eq!(found("cam-studio.local"), is("studio"));
        // A host saved with its user or its domain is found by the bare hostname, and a full hostname finds a bare one.
        assert_eq!(found("cam-dev-02"), is("Cam dev box"));
        assert_eq!(found("cam-far"), is("far"));
        assert_eq!(found("cam-dev-01.example.net"), is("Cam dev 01"));
        assert_eq!(found("10.0.0.7"), is("CI 01"));
        // An address is never cut at its first dot.
        assert_eq!(found("10.0.0.8"), ListedMachine::Unknown);
        // An exact name wins; a loose one that fits two, by name, by host or by one of each, finds neither.
        assert_eq!(found("lab-a"), is("lab-a"));
        assert_eq!(found("LAB A"), ListedMachine::Several(vec!["Lab A".into(), "lab-a".into()]));
        assert_eq!(found("shared"), ListedMachine::Several(vec!["Lab A".into(), "lab-a".into()]));
        assert_eq!(found("ci-01"), ListedMachine::Several(vec!["CI 01".into(), "build".into()]));
        assert_eq!(found("nowhere"), ListedMachine::Unknown);
        assert_eq!(found("--"), ListedMachine::Unknown);
        assert_eq!(found(""), ListedMachine::Unknown);
    }
}

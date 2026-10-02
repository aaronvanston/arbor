//! Arbor's own automations and every run of them, in usage.db.

use super::{AutomationInput, AutomationRun, AutomationRunStatus};
use rusqlite::{params, Connection, OptionalExtension};

/// An automation as it's kept.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Record {
    pub(super) id: String,
    pub(super) input: AutomationInput,
    pub(super) enabled: bool,
    pub(super) next_run_at_ms: Option<i64>,
    pub(super) created_at_ms: i64,
    pub(super) updated_at_ms: i64,
}

fn read_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, String, bool, Option<i64>, i64, i64)> {
    Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? != 0, row.get(3)?, row.get(4)?, row.get(5)?))
}

/// Every automation, oldest first. One whose saved form no longer reads is left out, so one bad row can't hide the rest.
pub(super) fn records(connection: &Connection) -> Result<Vec<Record>, String> {
    let mut statement = connection
        .prepare("SELECT id, input, enabled, next_run_at_ms, created_at_ms, updated_at_ms FROM usage_automations ORDER BY created_at_ms")
        .map_err(|error| error.to_string())?;
    let rows = statement.query_map([], read_record).map_err(|error| error.to_string())?;
    let mut records = Vec::new();
    for row in rows {
        let (id, input, enabled, next_run_at_ms, created_at_ms, updated_at_ms) = row.map_err(|error| error.to_string())?;
        let Ok(mut input) = serde_json::from_str::<AutomationInput>(&input) else {
            continue;
        };
        input.id = Some(id.clone());
        records.push(Record { id, input, enabled, next_run_at_ms, created_at_ms, updated_at_ms });
    }
    Ok(records)
}

pub(super) fn record(connection: &Connection, id: &str) -> Result<Option<Record>, String> {
    Ok(records(connection)?.into_iter().find(|record| record.id == id))
}

pub(super) fn write(connection: &Connection, record: &Record) -> Result<(), String> {
    let input = serde_json::to_string(&record.input).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO usage_automations(id, input, enabled, next_run_at_ms, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET input = excluded.input, enabled = excluded.enabled, next_run_at_ms = excluded.next_run_at_ms,
             updated_at_ms = excluded.updated_at_ms",
            params![record.id, input, record.enabled as i64, record.next_run_at_ms, record.created_at_ms, record.updated_at_ms],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// When it runs next, without touching what was saved.
pub(super) fn set_next_run(connection: &Connection, id: &str, next_run_at_ms: Option<i64>) -> Result<(), String> {
    connection
        .execute("UPDATE usage_automations SET next_run_at_ms = ?2 WHERE id = ?1", params![id, next_run_at_ms])
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Takes an automation off, with its runs.
pub(super) fn delete(connection: &Connection, id: &str) -> Result<(), String> {
    connection.execute("DELETE FROM usage_automation_runs WHERE automation_id = ?1", params![id]).map_err(|error| error.to_string())?;
    connection.execute("DELETE FROM usage_automations WHERE id = ?1", params![id]).map(|_| ()).map_err(|error| error.to_string())
}

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/// A run as it's kept: what the page shows, and the worktree a run made, for taking it away after.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct StoredRun {
    pub(super) run: AutomationRun,
    pub(super) worktree: Option<String>,
}

const RUN_COLUMNS: &str =
    "id, automation_id, machine, status, scheduled_at_ms, started_at_ms, finished_at_ms, manual, precheck_exit, precheck_output, exit_code, session_id, error, worktree";

fn status_name(status: AutomationRunStatus) -> &'static str {
    match status {
        AutomationRunStatus::Running => "running",
        AutomationRunStatus::Done => "done",
        AutomationRunStatus::Failed => "failed",
        AutomationRunStatus::Skipped => "skipped",
        AutomationRunStatus::Unreachable => "unreachable",
        AutomationRunStatus::Missed => "missed",
        AutomationRunStatus::Canceled => "canceled",
    }
}

fn status_named(name: &str) -> AutomationRunStatus {
    match name {
        "running" => AutomationRunStatus::Running,
        "done" => AutomationRunStatus::Done,
        "skipped" => AutomationRunStatus::Skipped,
        "unreachable" => AutomationRunStatus::Unreachable,
        "missed" => AutomationRunStatus::Missed,
        "canceled" => AutomationRunStatus::Canceled,
        _ => AutomationRunStatus::Failed,
    }
}

fn read_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRun> {
    Ok(StoredRun {
        run: AutomationRun {
            id: row.get(0)?,
            automation_id: row.get(1)?,
            machine: row.get(2)?,
            status: status_named(&row.get::<_, String>(3)?),
            scheduled_at_ms: row.get(4)?,
            started_at_ms: row.get(5)?,
            finished_at_ms: row.get(6)?,
            manual: row.get::<_, i64>(7)? != 0,
            precheck_exit: row.get(8)?,
            precheck_output: row.get(9)?,
            exit_code: row.get(10)?,
            session_id: row.get(11)?,
            error: row.get(12)?,
        },
        worktree: row.get(13)?,
    })
}

pub(super) fn write_run(connection: &Connection, stored: &StoredRun) -> Result<(), String> {
    let run = &stored.run;
    connection
        .execute(
            &format!(
                "INSERT INTO usage_automation_runs({RUN_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(id) DO UPDATE SET machine = excluded.machine, status = excluded.status, started_at_ms = excluded.started_at_ms,
                 finished_at_ms = excluded.finished_at_ms, precheck_exit = excluded.precheck_exit, precheck_output = excluded.precheck_output,
                 exit_code = excluded.exit_code, session_id = excluded.session_id, error = excluded.error, worktree = excluded.worktree"
            ),
            params![
                run.id,
                run.automation_id,
                run.machine,
                status_name(run.status),
                run.scheduled_at_ms,
                run.started_at_ms,
                run.finished_at_ms,
                run.manual as i64,
                run.precheck_exit,
                run.precheck_output,
                run.exit_code,
                run.session_id,
                run.error,
                stored.worktree,
            ],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// An automation's runs, or every automation's, newest first.
pub(super) fn runs(connection: &Connection, automation: Option<&str>, limit: usize) -> Result<Vec<StoredRun>, String> {
    let limit = limit.clamp(1, 1000) as i64;
    let mut statement = connection
        .prepare(&format!(
            "SELECT {RUN_COLUMNS} FROM usage_automation_runs WHERE (?1 IS NULL OR automation_id = ?1) ORDER BY scheduled_at_ms DESC, id DESC LIMIT ?2"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![automation, limit], read_run).map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub(super) fn run(connection: &Connection, id: &str) -> Result<Option<StoredRun>, String> {
    connection
        .query_row(&format!("SELECT {RUN_COLUMNS} FROM usage_automation_runs WHERE id = ?1"), params![id], read_run)
        .optional()
        .map_err(|error| error.to_string())
}

/// Runs still going, as far as Arbor last knew.
pub(super) fn running(connection: &Connection) -> Result<Vec<StoredRun>, String> {
    let mut statement = connection
        .prepare(&format!("SELECT {RUN_COLUMNS} FROM usage_automation_runs WHERE status = 'running' ORDER BY scheduled_at_ms"))
        .map_err(|error| error.to_string())?;
    let rows = statement.query_map([], read_run).map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

/// The last session a run of the automation ran in, for a run that carries it on.
pub(super) fn last_session(connection: &Connection, automation: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT session_id FROM usage_automation_runs WHERE automation_id = ?1 AND session_id IS NOT NULL ORDER BY scheduled_at_ms DESC LIMIT 1",
            params![automation],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

/// Runs kept for each automation; older ones go.
const RUNS_KEPT: i64 = 500;

pub(super) fn prune_runs(connection: &Connection, automation: &str) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM usage_automation_runs WHERE automation_id = ?1 AND status != 'running' AND id NOT IN
             (SELECT id FROM usage_automation_runs WHERE automation_id = ?1 ORDER BY scheduled_at_ms DESC LIMIT ?2)",
            params![automation, RUNS_KEPT],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

pub(super) fn setting(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row("SELECT value FROM usage_automation_settings WHERE key = ?1", params![key], |row| row.get(0))
        .optional()
        .map_err(|error| error.to_string())
}

pub(super) fn set_setting(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO usage_automation_settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::super::{AutomationAccess, AutomationAgent, AutomationSession, AutomationTarget, AutomationWorkspace};
    use super::*;
    use crate::usage::schema::test_database;

    fn input(name: &str) -> AutomationInput {
        AutomationInput {
            id: None,
            name: name.into(),
            prompt: "Check the build.".into(),
            agent: AutomationAgent::Claude,
            model: None,
            effort: None,
            target: AutomationTarget::Machine { name: "casey-mbp".into() },
            project_path: "~/src/arbor".into(),
            workspace: AutomationWorkspace::Checkout,
            session: AutomationSession::Fresh,
            access: AutomationAccess::Edits,
            rrule: "FREQ=HOURLY;INTERVAL=1".into(),
            timezone: None,
            grace_minutes: 60,
            precheck: None,
            precheck_timeout_secs: 60,
            enabled: true,
        }
    }

    fn run(id: &str, automation: &str, at: i64, status: AutomationRunStatus, session: Option<&str>) -> StoredRun {
        StoredRun {
            run: AutomationRun {
                id: id.into(),
                automation_id: automation.into(),
                machine: Some("casey-mbp".into()),
                status,
                scheduled_at_ms: at,
                started_at_ms: Some(at),
                finished_at_ms: None,
                manual: false,
                precheck_exit: None,
                precheck_output: None,
                exit_code: None,
                session_id: session.map(Into::into),
                error: None,
            },
            worktree: None,
        }
    }

    #[test]
    fn keeps_automations_and_their_runs() {
        let connection = test_database();
        let record = Record { id: "arbor:a1".into(), input: input("Changelog"), enabled: true, next_run_at_ms: Some(10), created_at_ms: 1, updated_at_ms: 1 };
        write(&connection, &record).unwrap();
        let read = records(&connection).unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].input.name, "Changelog");
        assert_eq!(read[0].input.id.as_deref(), Some("arbor:a1"));
        set_next_run(&connection, "arbor:a1", Some(20)).unwrap();
        assert_eq!(super::record(&connection, "arbor:a1").unwrap().unwrap().next_run_at_ms, Some(20));

        write_run(&connection, &run("r1", "arbor:a1", 100, AutomationRunStatus::Done, Some("s-1"))).unwrap();
        write_run(&connection, &run("r2", "arbor:a1", 200, AutomationRunStatus::Running, None)).unwrap();
        assert_eq!(runs(&connection, Some("arbor:a1"), 10).unwrap().iter().map(|stored| stored.run.id.as_str()).collect::<Vec<_>>(), ["r2", "r1"]);
        assert_eq!(running(&connection).unwrap().len(), 1);
        assert_eq!(last_session(&connection, "arbor:a1").unwrap().as_deref(), Some("s-1"));

        delete(&connection, "arbor:a1").unwrap();
        assert!(records(&connection).unwrap().is_empty());
        assert!(runs(&connection, None, 10).unwrap().is_empty());
    }

    #[test]
    fn keeps_settings() {
        let connection = test_database();
        assert_eq!(setting(&connection, "running").unwrap(), None);
        set_setting(&connection, "running", "0").unwrap();
        set_setting(&connection, "running", "1").unwrap();
        assert_eq!(setting(&connection, "running").unwrap().as_deref(), Some("1"));
    }
}

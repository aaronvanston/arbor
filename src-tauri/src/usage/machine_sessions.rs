//! The Machines page's sessions: for each machine, how many ran there in the
//! range, how many are running now, what they spent and the latest few. A
//! session is on its key's machine, else the one its transcript is on, as the
//! Sessions page's machine filter has it.

use super::session_filters::session_machine;
use ts_rs::TS;
use super::session_read::{self, SessionOrder, SessionSelect};
use super::*;

/// The most sessions a machine lists. The rest are only counted.
const LATEST_LISTED: usize = 5;

#[derive(Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineSessions {
    /// Empty for the sessions Arbor can't place on a machine.
    machine: String,
    sessions: usize,
    /// Their subagent threads.
    subagents: usize,
    /// Those that made a request in the last few minutes.
    running: usize,
    requests: u64,
    total_tokens: u64,
    estimated_cost: f64,
    /// Requests with a price. Without any, the cost isn't known.
    priced_requests: u64,
    last_active_at_ms: i64,
    /// The most recently active first, which puts the running ones first.
    /// Their peak context and compactions aren't worked out.
    latest: Vec<UsageSession>,
}

#[tauri::command]
pub(crate) async fn get_machine_sessions(
    query: UsageQuery,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<MachineSessions>, String> {
    let config = gui_config_state.snapshot()?;
    run_usage_task(move || {
        load_machine_sessions(
            &open_usage_database()?,
            &query,
            &config,
            Local::now().timestamp_millis(),
        )
    })
    .await
}

/// Every machine with a session in the query's requests, by name, and then
/// the sessions Arbor can't place on one.
pub(super) fn load_machine_sessions(
    connection: &Connection,
    query: &UsageQuery,
    config: &GuiConfigFile,
    now_ms: i64,
) -> Result<Vec<MachineSessions>, String> {
    // The page's machine filter, as the Sessions page applies it. A session's transcript can say where it ran.
    let sessions = session_read::select_sessions(
        connection,
        config,
        now_ms,
        &SessionSelect {
            query,
            only_active: false,
            order: SessionOrder::Recent,
            limit: None,
            transcripts: true,
        },
    )?
    .sessions;
    let mut machines = HashMap::<String, MachineSessions>::new();
    for session in sessions {
        let name = session_machine(&session).to_string();
        let machine = machines.entry(name.clone()).or_insert_with(|| MachineSessions {
            machine: name,
            ..MachineSessions::default()
        });
        let totals = &session.root.totals;
        machine.sessions += 1;
        machine.subagents += session.subagents;
        machine.running += usize::from(session.active);
        machine.requests = machine.requests.saturating_add(totals.requests);
        machine.total_tokens = machine.total_tokens.saturating_add(totals.total_tokens);
        machine.estimated_cost += totals.estimated_cost;
        machine.priced_requests = machine.priced_requests.saturating_add(totals.priced_requests);
        machine.last_active_at_ms = machine.last_active_at_ms.max(totals.last_active_at_ms);
        if machine.latest.len() < LATEST_LISTED {
            machine.latest.push(session);
        }
    }
    let mut machines = machines.into_values().collect::<Vec<_>>();
    machines.sort_by(|left, right| {
        left.machine
            .is_empty()
            .cmp(&right.machine.is_empty())
            .then_with(|| left.machine.to_lowercase().cmp(&right.machine.to_lowercase()))
            .then_with(|| left.machine.cmp(&right.machine))
    });
    Ok(machines)
}

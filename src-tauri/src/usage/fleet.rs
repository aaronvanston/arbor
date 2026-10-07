//! The live fleet board's sources, in one call: T3 Code's threads as last read, the waits Arbor's
//! reporters have said are unanswered, and the proxy sessions active in the last six hours. The
//! webview merges them into one row per session by the ids they store, never by time, title,
//! folder or machine.

use super::machine_health::attention::{self, AgentAttentionReport};
use ts_rs::TS;
use super::machine_health::t3_threads::{self, ArborSession, T3Channel};
use super::machine_health::MachineHealthState;
use super::*;

/// How far back a proxy session's requests put it on the board: the same six hours as a wait.
const WINDOW_MS: i64 = 6 * 60 * 60_000;
/// The most proxy sessions sent, the most recently active first. More than a board can show.
const SESSION_LIMIT: usize = 200;

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FleetSources {
    now_ms: i64,
    /// This Mac, as the Machines page names it.
    this_machine: String,
    /// T3 Code's threads are being read.
    t3_enabled: bool,
    /// Some machine has T3 Code, so its threads could be read. Without it the board never mentions T3 Code.
    t3_found: bool,
    t3: Vec<T3Channel>,
    attention: AgentAttentionReport,
    sessions: Vec<FleetProxySession>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FleetTrayCounts {
    waiting: u32,
}

/// A proxy session, over its requests in the window.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetProxySession {
    session: UsageSession,
    /// Its own thread's latest request failed, and wasn't canceled. A subagent's failure doesn't
    /// count: the session carries on without it.
    last_request_failed: bool,
}

#[tauri::command]
pub(crate) async fn get_fleet_sources(
    state: tauri::State<'_, MachineHealthState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<FleetSources, String> {
    let config = gui_config_state.snapshot()?;
    let waits = attention::pending_waits(&state);
    let t3 = t3_threads::snapshot(&state);
    let now_ms = Local::now().timestamp_millis();
    run_usage_task(move || fleet_sources(&open_usage_database()?, &config, waits, t3, now_ms)).await
}

pub(super) fn fleet_sources(
    connection: &Connection,
    config: &GuiConfigFile,
    waits: attention::PendingWaits,
    t3: t3_threads::T3Snapshot,
    now_ms: i64,
) -> Result<FleetSources, String> {
    let attention = attention::attention_report(connection, config, waits, now_ms)?;
    let sessions = recent_sessions(connection, config, now_ms)?;
    let mut channels = t3.channels;
    link_t3_threads(connection, &mut channels)?;
    Ok(FleetSources {
        now_ms,
        this_machine: t3.this_machine,
        t3_enabled: t3.enabled,
        t3_found: t3.found,
        t3: channels,
        attention,
        sessions,
    })
}

/// T3 Code's threads on one machine, each naming one of `agent_ids`, for the benchmark.
#[cfg(test)]
pub(super) fn bench_channels(agent_ids: &[String]) -> t3_threads::T3Snapshot {
    let threads = agent_ids
        .iter()
        .enumerate()
        .map(|(index, id)| t3_threads::T3Thread::for_test(&format!("thread-{index}"), Some(id)))
        .collect();
    t3_threads::T3Snapshot {
        enabled: true,
        found: true,
        this_machine: "cam-mbp".into(),
        channels: vec![T3Channel {
            machine: "cam-mbp".into(),
            channel: t3_threads::T3ChannelKind::Userdata,
            read_at_ms: 0,
            server_running: true,
            read_mode: t3_threads::ReadMode::Readonly,
            skipped: None,
            threads,
        }],
    }
}

/// The tray badge's one count, without reading proxy sessions or serializing
/// T3 threads. The full fleet source remains for the visible board.
#[tauri::command]
pub(crate) async fn get_fleet_tray_counts(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
) -> Result<FleetTrayCounts, String> {
    let now_ms = Local::now().timestamp_millis();
    let t3 = t3_threads::waiting_ids(&state, now_ms);
    let pending = attention::pending_waits(&state);
    let counts = run_usage_task(move || {
        let mut waiting = t3;
        waiting.extend(attention::pending_waiting_ids(&open_usage_database()?, pending, now_ms)?);
        Ok(FleetTrayCounts { waiting: waiting.len().min(u32::MAX as usize) as u32 })
    })
    .await?;
    crate::tray::set_tray_waiting(app, counts.waiting).await?;
    Ok(counts)
}

/// Each thread's latest request: when it was made, and whether it failed without being canceled. One statement for
/// them all rather than one per thread, each still a lookup on `idx_usage_events_session`, the ids compared as stored.
/// A thread without requests has no entry.
fn last_requests<'a>(
    connection: &Connection,
    sessions: impl IntoIterator<Item = &'a str>,
) -> Result<HashMap<String, (i64, bool)>, String> {
    let ids: HashSet<&str> = sessions.into_iter().collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let ids = serde_json::to_string(&ids).map_err(|error| format!("Failed to read the sessions' latest requests: {error}"))?;
    let mut statement = connection
        .prepare_cached(
            "SELECT j.value, e.timestamp_ms, e.failed, e.canceled FROM json_each(?1) j \
             JOIN usage_events e ON e.id = (SELECT id FROM usage_events WHERE session_id = j.value \
             ORDER BY timestamp_ms DESC, id DESC LIMIT 1)",
        )
        .map_err(|error| format!("Failed to read the sessions' latest requests: {error}"))?;
    let rows = statement
        .query_map([ids], |row| {
            Ok((row.get::<_, String>(0)?, (row.get::<_, i64>(1)?, row.get::<_, i64>(2)? != 0 && row.get::<_, i64>(3)? == 0)))
        })
        .map_err(|error| format!("Failed to read the sessions' latest requests: {error}"))?;
    rows.collect::<rusqlite::Result<_>>()
        .map_err(|error| format!("Failed to read the sessions' latest requests: {error}"))
}

/// The sessions with requests in the window, the most recently active first, with where each ran.
pub(super) fn recent_sessions(connection: &Connection, config: &GuiConfigFile, now_ms: i64) -> Result<Vec<FleetProxySession>, String> {
    let start = DateTime::<chrono::Utc>::from_timestamp_millis(now_ms - WINDOW_MS)
        .map(|start| start.to_rfc3339())
        .ok_or_else(|| "The fleet board's window is out of range.".to_string())?;
    let query = UsageQuery {
        start: Some(start),
        ..UsageQuery::default()
    };
    let sessions = session_read::select_sessions(
        connection,
        config,
        now_ms,
        &session_read::SessionSelect {
            query: &query,
            only_active: false,
            order: session_read::SessionOrder::Recent,
            limit: Some(SESSION_LIMIT),
            transcripts: true,
        },
    )?
    .sessions;
    let last = last_requests(connection, sessions.iter().map(|session| session.root.id.as_str()))?;
    Ok(sessions
        .into_iter()
        .map(|session| {
            let last_request_failed = last.get(&session.root.id).is_some_and(|(_, failed)| *failed);
            FleetProxySession { session, last_request_failed }
        })
        .collect())
}

/// Gives each T3 Code thread the proxy session whose id is the thread's agent session id, when
/// that session's requests came through Arbor, so its row can open the session's page.
fn link_t3_threads(connection: &Connection, channels: &mut [T3Channel]) -> Result<(), String> {
    let last = last_requests(
        connection,
        channels.iter().flat_map(|channel| channel.threads.iter()).filter_map(|thread| thread.agent_session_id.as_deref()),
    )?;
    for thread in channels.iter_mut().flat_map(|channel| channel.threads.iter_mut()) {
        let Some(id) = thread.agent_session_id.as_ref() else {
            continue;
        };
        thread.arbor_session = last
            .get(id)
            .map(|&(at_ms, failed)| ArborSession { id: id.clone(), last_active_at_ms: at_ms, last_request_failed: failed });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use t3_threads::T3Thread;

    const MINUTE: i64 = 60_000;
    const CLAUDE: &str = "a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7";
    const CODEX: &str = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";

    fn database() -> Connection {
        let connection = schema::test_database();
        connection
    }

    #[test]
    fn tray_counts_payload_is_only_the_count_it_shows() {
        let payload = serde_json::to_vec(&FleetTrayCounts { waiting: 7 }).unwrap();
        assert_eq!(payload, br#"{"waiting":7}"#);
        assert!(payload.len() < 32, "tray update read {} bytes", payload.len());
    }

    fn request(connection: &Connection, session: &str, parent: Option<&str>, at_ms: i64, failed: bool, canceled: bool) {
        let timestamp = DateTime::<chrono::Utc>::from_timestamp_millis(at_ms).unwrap().to_rfc3339();
        connection
            .execute(
                "INSERT INTO usage_events (event_key, timestamp, timestamp_ms, local_hour, created_at, session_id, \
                 parent_session_id, failed, canceled, provider, model, input_tokens, total_tokens) \
                 VALUES (?1, ?2, ?3, '2026-09-26T10', ?2, ?4, ?5, ?6, ?7, 'claude', 'claude-opus-5-5', 1000, 1000)",
                params![format!("{session}-{at_ms}"), timestamp, at_ms, session, parent, failed, canceled],
            )
            .unwrap();
    }

    fn channel(threads: Vec<T3Thread>) -> T3Channel {
        T3Channel {
            machine: "cam-mbp".into(),
            channel: t3_threads::T3ChannelKind::Userdata,
            read_at_ms: 0,
            server_running: true,
            read_mode: t3_threads::ReadMode::Readonly,
            skipped: None,
            threads,
        }
    }

    #[test]
    fn a_t3_thread_links_to_the_proxy_session_with_its_exact_agent_session_id() {
        let connection = database();
        let now = 1_790_000_000_000;
        request(&connection, CLAUDE, None, now - 5 * MINUTE, false, false);
        request(&connection, CLAUDE, None, now - MINUTE, true, false);
        request(&connection, CODEX, None, now - 2 * MINUTE, true, true);
        let mut channels = vec![channel(vec![
            T3Thread::for_test("thread-claude", Some(CLAUDE)),
            T3Thread::for_test("thread-codex", Some(CODEX)),
            // Two threads can name one session.
            T3Thread::for_test("thread-claude-fork", Some(CLAUDE)),
            // The same id in another case is another id.
            T3Thread::for_test("thread-upper", Some(&CLAUDE.to_uppercase())),
            T3Thread::for_test("thread-none", None),
            T3Thread::for_test("thread-no-requests", Some("0199ffff-0000-7000-8000-000000000000")),
        ])];
        link_t3_threads(&connection, &mut channels).unwrap();
        let linked = |id: &str| {
            channels[0]
                .threads
                .iter()
                .find(|thread| thread.thread_id == id)
                .and_then(|thread| thread.arbor_session.clone())
        };
        assert_eq!(
            linked("thread-claude"),
            Some(ArborSession { id: CLAUDE.into(), last_active_at_ms: now - MINUTE, last_request_failed: true })
        );
        assert_eq!(
            linked("thread-codex"),
            Some(ArborSession { id: CODEX.into(), last_active_at_ms: now - 2 * MINUTE, last_request_failed: false }),
            "a canceled request isn't a failure"
        );
        assert_eq!(linked("thread-claude-fork"), linked("thread-claude"));
        assert_eq!(linked("thread-upper"), None);
        assert_eq!(linked("thread-none"), None);
        assert_eq!(linked("thread-no-requests"), None);
    }

    #[test]
    fn sessions_active_in_the_window_come_newest_first_with_whether_their_own_last_request_failed() {
        let connection = database();
        let now = Local::now().timestamp_millis();
        // Failed last, then a subagent's failure after a good request, then a session from yesterday.
        request(&connection, "session-failed", None, now - 20 * MINUTE, false, false);
        request(&connection, "session-failed", None, now - 10 * MINUTE, true, false);
        request(&connection, "session-subagent", None, now - 8 * MINUTE, false, false);
        request(&connection, "subagent-1", Some("session-subagent"), now - 3 * MINUTE, true, false);
        request(&connection, "session-old", None, now - 26 * 60 * MINUTE, true, false);
        let sessions = recent_sessions(&connection, &GuiConfigFile::default(), now).unwrap();
        let listed: Vec<(&str, bool)> = sessions
            .iter()
            .map(|entry| (entry.session.root.id.as_str(), entry.last_request_failed))
            .collect();
        assert_eq!(listed, [("session-subagent", false), ("session-failed", true)]);
        assert_eq!(sessions[0].session.subagents, 1);
    }
}

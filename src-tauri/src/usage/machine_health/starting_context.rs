//! Starting context: how many tokens a session sent with its first request,
//! before anything was said. It's the agent's own prompt and tools, the
//! instructions and skill list its home loads, MCP tools, the project's
//! instructions and the first message, paid again by every session, so it's
//! worth watching per agent home.
//!
//! A session's first requests are read from the proxy's records, and its home
//! from the transcript scan, which links the two by session id. Claude Code
//! makes small side calls around its first request (a title, a check), so the
//! first request counted is the first by the session's main model: the one it
//! used most among its first few requests.

use super::*;
use ts_rs::TS;

/// How many of a session's first requests say which model is its main one.
const FIRST_REQUESTS: usize = 20;
/// Smaller than any real start: an agent's own prompt alone is several thousand
/// tokens. A request this small is a probe, such as the one-token check some
/// Claude Code versions send first with the main model.
const START_MIN_TOKENS: i64 = 1_000;
/// Enough for a month of sessions on a busy fleet, and still a small reply.
const SESSIONS_MAX: usize = 10_000;

/// One session's start.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionStart {
    session_id: String,
    machine: String,
    /// "claude" or "codex", as the transcript scan stored it.
    #[ts(type = r#""claude" | "codex""#)]
    agent: String,
    /// The agent home, with the machine's home as ~, as Setup writes it.
    home: String,
    /// The repository it ran in, or empty outside one.
    repo: String,
    model: String,
    tokens: i64,
    at_ms: i64,
}

#[derive(Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartingContext {
    /// Oldest first.
    sessions: Vec<SessionStart>,
    /// Sessions read in the window whose home a scan hasn't said yet.
    unplaced: u64,
    truncated: bool,
}

/// The first request by the most used model among these, which arrive in order:
/// (model, input tokens, when). Ties go to the model that sent more, since side
/// calls are the small ones.
fn first_main_request(requests: &[(String, i64, i64)]) -> Option<&(String, i64, i64)> {
    let mut models: Vec<(&str, usize, i64)> = Vec::new();
    for (model, tokens, _) in requests.iter().filter(|(_, tokens, _)| *tokens >= START_MIN_TOKENS) {
        match models.iter_mut().find(|(name, _, _)| name == model) {
            Some((_, count, most)) => {
                *count += 1;
                *most = (*most).max(*tokens);
            }
            None => models.push((model, 1, *tokens)),
        }
    }
    let main = models.iter().max_by_key(|(_, count, most)| (*count, *most))?.0;
    requests.iter().find(|(model, tokens, _)| model == main && *tokens >= START_MIN_TOKENS)
}

pub(in crate::usage) fn starting_context(connection: &Connection, from_ms: i64, to_ms: i64) -> Result<StartingContext, String> {
    // A session that started in the window was read after it started, so this finds every one of them.
    let mut sessions = connection
        .prepare(
            "SELECT session_id, machine, agent, agent_home, CASE WHEN main_repo <> '' THEN main_repo ELSE repo_root END
             FROM usage_session_transcripts WHERE read_at_ms >= ?1",
        )
        .map_err(|error| format!("Failed to prepare the sessions to look at: {error}"))?;
    let rows = sessions
        .query_map(params![from_ms], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?))
        })
        .map_err(|error| format!("Failed to read the sessions to look at: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read the sessions to look at: {error}"))?;
    let mut first = connection
        .prepare(&format!(
            "SELECT model, input_tokens, timestamp_ms FROM usage_events
             WHERE session_id = ?1 AND failed = 0 AND input_tokens > 0
             ORDER BY timestamp_ms, id LIMIT {FIRST_REQUESTS}"
        ))
        .map_err(|error| format!("Failed to prepare a session's first requests: {error}"))?;
    let mut context = StartingContext::default();
    for (session_id, machine, agent, home, repo) in rows {
        if home.is_empty() {
            context.unplaced += 1;
            continue;
        }
        let requests = first
            .query_map(params![session_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)))
            .map_err(|error| format!("Failed to read a session's first requests: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read a session's first requests: {error}"))?;
        // A session that began before the window isn't starting in it.
        if requests.first().is_none_or(|(_, _, at_ms)| *at_ms < from_ms || *at_ms >= to_ms) {
            continue;
        }
        let Some((model, tokens, at_ms)) = first_main_request(&requests).cloned() else {
            continue;
        };
        context.sessions.push(SessionStart { session_id, machine, agent, home, repo, model, tokens, at_ms });
    }
    context.sessions.sort_by(|a, b| a.at_ms.cmp(&b.at_ms).then_with(|| a.session_id.cmp(&b.session_id)));
    if context.sessions.len() > SESSIONS_MAX {
        context.sessions.drain(..context.sessions.len() - SESSIONS_MAX);
        context.truncated = true;
    }
    Ok(context)
}

/// Each session's starting context, for sessions that started in the window.
#[tauri::command]
pub(crate) async fn get_starting_context(from_ms: i64, to_ms: i64) -> Result<StartingContext, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open_usage_database()?;
        starting_context(&connection, from_ms, to_ms)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400_000;
    const NOW: i64 = 100 * DAY;

    fn database() -> Connection {
        crate::usage::schema::test_database()
    }

    fn session(connection: &Connection, id: &str, machine: &str, home: &str, repo: &str, requests: &[(i64, &str, i64, bool)]) {
        connection
            .execute(
                "INSERT INTO usage_session_transcripts (session_id, machine, agent, read_at_ms, main_repo, agent_home) VALUES (?1, ?2, 'claude', ?3, ?4, ?5)",
                params![id, machine, NOW, repo, home],
            )
            .unwrap();
        for (at_ms, model, tokens, failed) in requests {
            crate::usage::schema::insert_request(
                connection,
                "timestamp_ms, session_id, model, input_tokens, failed",
                params![at_ms, id, model, tokens, i64::from(*failed)],
            );
        }
    }

    #[test]
    fn the_first_request_by_the_main_model_is_the_start() {
        let requests = |rows: &[(&str, i64)]| rows.iter().enumerate().map(|(at, (model, tokens))| (model.to_string(), *tokens, at as i64)).collect::<Vec<_>>();
        // A title call and a probe come first; the main model's first real request is the start.
        let claude = requests(&[("claude-haiku-4-5", 1_200), ("claude-opus-5-5", 12), ("claude-opus-5-5", 31_000), ("claude-opus-5-5", 33_000), ("claude-haiku-4-5", 900)]);
        assert_eq!(first_main_request(&claude).map(|(model, tokens, _)| (model.as_str(), *tokens)), Some(("claude-opus-5-5", 31_000)));
        // Equal counts: the model that sent more is the main one.
        let tied = requests(&[("claude-haiku-4-5", 2_000), ("claude-sonnet-5", 18_000)]);
        assert_eq!(first_main_request(&tied).map(|(_, tokens, _)| *tokens), Some(18_000));
        assert_eq!(first_main_request(&requests(&[("claude-opus-5-5", 40)])), None, "nothing big enough to be a start");
        assert_eq!(first_main_request(&[]), None);
    }

    #[test]
    fn sessions_that_started_in_the_window_are_counted_by_home() {
        let connection = database();
        let a = "aaaaaaaa-0000-4000-8000-000000000001";
        let b = "aaaaaaaa-0000-4000-8000-000000000002";
        let early = "aaaaaaaa-0000-4000-8000-000000000003";
        let unplaced = "aaaaaaaa-0000-4000-8000-000000000004";
        let failed = "aaaaaaaa-0000-4000-8000-000000000005";
        session(&connection, a, "mbp", "~/.claude", "/Users/a/src/arbor", &[(NOW - 2 * DAY, "claude-opus-5-5", 24_000, false), (NOW - 2 * DAY + 1, "claude-opus-5-5", 26_000, false)]);
        session(&connection, b, "cedar", "~/.t3/provider-homes/claude-proxy", "", &[(NOW - DAY, "claude-haiku-4-5", 1_500, false), (NOW - DAY + 1, "claude-opus-5-5", 41_000, false)]);
        session(&connection, early, "mbp", "~/.claude", "", &[(NOW - 40 * DAY, "claude-opus-5-5", 22_000, false), (NOW - DAY, "claude-opus-5-5", 90_000, false)]);
        session(&connection, unplaced, "mbp", "", "", &[(NOW - DAY, "claude-opus-5-5", 30_000, false)]);
        // A failed first try sent nothing counted; the retry is the start.
        session(&connection, failed, "mbp", "~/.claude", "", &[(NOW - DAY, "claude-opus-5-5", 0, true), (NOW - DAY + 5, "claude-opus-5-5", 27_000, false)]);

        let context = starting_context(&connection, NOW - 28 * DAY, NOW).unwrap();
        let starts: Vec<(&str, &str, i64)> = context.sessions.iter().map(|start| (start.session_id.as_str(), start.home.as_str(), start.tokens)).collect();
        assert_eq!(starts, [(a, "~/.claude", 24_000), (b, "~/.t3/provider-homes/claude-proxy", 41_000), (failed, "~/.claude", 27_000)]);
        assert_eq!(context.sessions[0].repo, "/Users/a/src/arbor");
        assert_eq!(context.sessions[1].model, "claude-opus-5-5");
        assert_eq!(context.unplaced, 1);
        assert!(!context.truncated);
        assert!(starting_context(&connection, NOW - DAY / 2, NOW).unwrap().sessions.is_empty());
    }
}

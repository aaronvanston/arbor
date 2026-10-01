//! Home's live board and the tray: the sessions running now, what each spent
//! in the last hour, how full its conversation is, and when it's likely to
//! compact at the pace it has been growing.
//!
//! No request says where a conversation will compact. That depends on the
//! client and on the context window the model runs with: the same model
//! compacts at about 167K in a 200K window and about 365K in a larger one. So
//! a session's point is where it compacted by itself before, else the next
//! place above its context where sessions of the same client and model
//! compacted in the last 30 days.

use super::machine_health::transcripts::TranscriptCompaction;
use ts_rs::TS;
use super::session_filters::session_client_label;
use super::session_read::{self, SessionOrder, SessionSelect, ThreadRequest, COMPACTION_MATCH_MS};
use super::*;
use std::sync::Arc;

/// What a session spent in the last this long is its cost per hour.
const LIVE_WINDOW_MS: i64 = 60 * 60_000;
/// The most sessions the board lists. The rest are only counted.
const LIVE_SESSION_LIMIT: usize = 12;
/// A conversation's growth is measured over its requests in this long up to its latest.
const GROWTH_WINDOW_MS: i64 = 15 * 60_000;
/// Growth over less than this is too little to go on.
const GROWTH_MIN_SPAN_MS: i64 = 2 * 60_000;
/// A compaction further off than this at the current pace isn't forecast.
const FORECAST_MAX_MS: i64 = 6 * 60 * 60_000;
/// How far back compactions are learned from, and how often that's redone.
const LEARN_WINDOW_MS: i64 = 30 * 24 * 60 * 60_000;
const LEARN_INTERVAL_MS: i64 = 15 * 60_000;
/// Compaction sizes further apart than this, the larger over the smaller,
/// come from different context windows.
const POINT_GAP_RATIO: f64 = 1.25;
/// A size needs this many compactions, and this share of its client and
/// model's, to be a point. Compacting by hand happens anywhere, so it doesn't.
const POINT_MIN_COMPACTIONS: usize = 2;
const POINT_MIN_SHARE: f64 = 0.1;
/// A session this far past where it compacted before has moved on from that
/// point, as when it switched to a model with a larger window.
const SESSION_POINT_OVERSHOOT: f64 = 1.1;
/// Where Claude Code compacts in a large window, for when Arbor hasn't seen it
/// compact anywhere yet.
const CLAUDE_CODE_COMPACTS_AT: u64 = 350_000;

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LiveSessionsReport {
    /// The costliest in the last hour first.
    sessions: Vec<LiveSession>,
    /// Every running session, listed or not.
    running: usize,
    /// What they all spent in the last hour.
    cost_per_hour: f64,
    /// Their requests in the hour, and those with a price. Without any, the cost isn't known.
    requests: u64,
    priced_requests: u64,
    /// Every running session's User-Agent, empty when it sent none, so they can be counted by client.
    clients: Vec<String>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct LiveSession {
    /// The session's last hour.
    #[serde(flatten)]
    session: UsageSession,
    /// When its main conversation started, which can be long before the hour.
    running_since_ms: i64,
    context: LiveContext,
}

/// A running session's main conversation.
#[derive(Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(super) struct LiveContext {
    /// How much context it's at, in input tokens. 0 when the session's own
    /// thread has made no request.
    tokens: u64,
    /// The model of its latest request, which a learned point is for.
    model: String,
    /// Where it's likely to compact next.
    compacts_at: Option<u64>,
    /// What says so: `session` where it compacted by itself before, `learned`
    /// where sessions of its client and model have, `default` where Claude
    /// Code usually does. Empty without a point.
    basis: &'static str,
    /// How fast it has grown lately, in tokens a minute.
    growth_per_minute: Option<f64>,
    /// How long until it compacts at that pace, from its latest request. 0
    /// once it's at the point.
    compacts_in_ms: Option<i64>,
}

/// A compaction in a thread's conversation.
struct Compaction {
    /// The request the conversation was at before it. Its size is where the
    /// conversation compacted.
    before_index: usize,
    before: u64,
    /// The first request after it.
    index: usize,
}

/// The sizes compactions cluster at, smallest first, by client as the
/// Sessions page names it and model.
pub(super) type CompactionPoints = HashMap<(String, String), Vec<u64>>;

struct Learned {
    at_ms: i64,
    points: Arc<CompactionPoints>,
}

static LEARNED: Mutex<Option<Learned>> = Mutex::new(None);

#[tauri::command]
pub(crate) async fn get_live_sessions(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<LiveSessionsReport, String> {
    let config = gui_config_state.snapshot()?;
    let now_ms = Local::now().timestamp_millis();
    run_usage_task(move || {
        let connection = open_usage_database()?;
        let points = learned_points(&connection, now_ms)?;
        load_live_sessions(&connection, &config, now_ms, &points)
    })
    .await
}

/// Where compactions happen, relearned at most every LEARN_INTERVAL_MS.
fn learned_points(connection: &Connection, now_ms: i64) -> Result<Arc<CompactionPoints>, String> {
    let mut learned = LEARNED.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(learned) = learned
        .as_ref()
        .filter(|learned| now_ms - learned.at_ms < LEARN_INTERVAL_MS)
    {
        return Ok(learned.points.clone());
    }
    let points = Arc::new(learn_compaction_points(connection, now_ms - LEARN_WINDOW_MS)?);
    *learned = Some(Learned {
        at_ms: now_ms,
        points: points.clone(),
    });
    Ok(points)
}

pub(super) fn load_live_sessions(
    connection: &Connection,
    config: &GuiConfigFile,
    now_ms: i64,
    points: &CompactionPoints,
) -> Result<LiveSessionsReport, String> {
    let start = DateTime::<chrono::Utc>::from_timestamp_millis(now_ms - LIVE_WINDOW_MS)
        .map(|start| start.to_rfc3339())
        .ok_or_else(|| "The live session window is out of range.".to_string())?;
    let query = UsageQuery {
        start: Some(start),
        ..UsageQuery::default()
    };
    let mut sessions = session_read::select_sessions(
        connection,
        config,
        now_ms,
        &SessionSelect {
            query: &query,
            only_active: true,
            order: SessionOrder::CostThenOldest,
            limit: None,
            transcripts: false,
        },
    )?
    .sessions;
    let running = sessions.len();
    let cost_per_hour = sessions
        .iter()
        .map(|session| session.root.totals.estimated_cost)
        .sum();
    let requests = sessions.iter().map(|session| session.root.totals.requests).sum();
    let priced_requests = sessions
        .iter()
        .map(|session| session.root.totals.priced_requests)
        .sum();
    let clients = sessions
        .iter()
        .map(|session| session.root.user_agent.clone().unwrap_or_default())
        .collect();
    sessions.truncate(LIVE_SESSION_LIMIT);
    let mut requests_by_thread = session_read::complete_sessions(connection, &mut sessions)?;
    let sessions = sessions
        .into_iter()
        .map(|session| {
            let requests = requests_by_thread.remove(&session.root.id).unwrap_or_default();
            let recorded = session
                .transcript
                .as_ref()
                .map(|transcript| transcript.compactions())
                .unwrap_or_default();
            let context = live_context(&requests, recorded, points);
            let running_since_ms = requests
                .first()
                .map_or(session.root.totals.started_at_ms, |request| {
                    request.timestamp_ms.min(session.root.totals.started_at_ms)
                });
            LiveSession {
                session,
                running_since_ms,
                context,
            }
        })
        .collect();
    Ok(LiveSessionsReport {
        sessions,
        running,
        cost_per_hour,
        requests,
        priced_requests,
        clients,
    })
}

/// Where each client and model's conversations have compacted since `since_ms`.
pub(super) fn learn_compaction_points(connection: &Connection, since_ms: i64) -> Result<CompactionPoints, String> {
    let mut statement = connection
        .prepare(
            "SELECT session_id, timestamp_ms, input_tokens, COALESCE(model, ''), COALESCE(user_agent, '')
             FROM usage_events WHERE timestamp_ms >= ?1 AND session_id <> '' AND input_tokens > 0
             ORDER BY session_id, timestamp_ms, id",
        )
        .map_err(|error| format!("Failed to prepare the compaction query: {error}"))?;
    let mut rows = statement
        .query([since_ms])
        .map_err(|error| format!("Failed to query compactions: {error}"))?;
    let mut sizes = HashMap::<(String, String), Vec<u64>>::new();
    let mut thread = String::new();
    let mut requests = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("Failed to read compactions: {error}"))?
    {
        let read = || -> rusqlite::Result<(String, ThreadRequest)> {
            Ok((
                row.get(0)?,
                ThreadRequest {
                    timestamp_ms: row.get(1)?,
                    context: from_sql_i64(row.get(2)?),
                    model: row.get(3)?,
                    user_agent: row.get(4)?,
                },
            ))
        };
        let (id, request) = read().map_err(|error| format!("Failed to read compactions: {error}"))?;
        if id != thread {
            add_compaction_sizes(&requests, &mut sizes);
            requests.clear();
            thread = id;
        }
        requests.push(request);
    }
    add_compaction_sizes(&requests, &mut sizes);
    Ok(sizes
        .into_iter()
        .map(|(key, sizes)| (key, compaction_points(sizes)))
        .filter(|(_, points)| !points.is_empty())
        .collect())
}

/// Adds where one thread's conversation compacted, under the client and model
/// of the request it compacted at.
fn add_compaction_sizes(requests: &[ThreadRequest], sizes: &mut HashMap<(String, String), Vec<u64>>) {
    let contexts = requests.iter().map(|request| request.context).collect::<Vec<_>>();
    for compaction in compactions_in(&contexts, &settled_conversation(&contexts)) {
        let request = &requests[compaction.before_index];
        sizes
            .entry(point_key(request))
            .or_default()
            .push(compaction.before);
    }
}

fn point_key(request: &ThreadRequest) -> (String, String) {
    (
        session_client_label(&request.user_agent).unwrap_or_default(),
        request.model.clone(),
    )
}

/// Follows a thread's conversation like `follow_conversation`, up to a drop
/// too recent to tell from a side request: one without CONVERSATION_LOOKAHEAD
/// requests after it yet. Agents make side requests all the time, so until
/// those are in, the conversation is taken to be where it was.
fn settled_conversation(contexts: &[u64]) -> Vec<ContextStep> {
    let mut steps = follow_conversation(contexts);
    let settled = contexts.len().saturating_sub(CONVERSATION_LOOKAHEAD);
    if let Some(recent) = (settled..steps.len()).find(|&index| steps[index] == ContextStep::Compacted) {
        steps.truncate(recent);
    }
    steps
}

/// The compactions in a thread's conversation, from its contexts and steps.
fn compactions_in(contexts: &[u64], steps: &[ContextStep]) -> Vec<Compaction> {
    let mut found = Vec::new();
    let mut last = None;
    for (index, (&context, &step)) in contexts.iter().zip(steps).enumerate() {
        match step {
            ContextStep::Side => continue,
            ContextStep::Compacted => {
                if let Some((before_index, before)) = last {
                    found.push(Compaction {
                        before_index,
                        before,
                        index,
                    });
                }
            }
            ContextStep::Conversation => {}
        }
        last = Some((index, context));
    }
    found
}

/// The typical size of each cluster of compaction sizes, smallest first.
fn compaction_points(mut sizes: Vec<u64>) -> Vec<u64> {
    sizes.sort_unstable();
    let total = sizes.len();
    let mut points = Vec::new();
    let mut start = 0;
    for end in 1..=total {
        if end < total && sizes[end] as f64 <= sizes[end - 1] as f64 * POINT_GAP_RATIO {
            continue;
        }
        let cluster = &sizes[start..end];
        if cluster.len() >= POINT_MIN_COMPACTIONS && cluster.len() as f64 >= total as f64 * POINT_MIN_SHARE {
            points.push(cluster[cluster.len() / 2]);
        }
        start = end;
    }
    points
}

/// Where a running session's conversation is and where it's heading, from
/// its main thread's requests and the compactions its transcript records.
pub(super) fn live_context(
    requests: &[ThreadRequest],
    recorded: &[TranscriptCompaction],
    points: &CompactionPoints,
) -> LiveContext {
    let contexts = requests.iter().map(|request| request.context).collect::<Vec<_>>();
    let steps = settled_conversation(&contexts);
    let Some(latest) = steps.iter().rposition(|step| *step != ContextStep::Side) else {
        return LiveContext::default();
    };
    let tokens = contexts[latest];
    let compactions = compactions_in(&contexts, &steps);

    // Where it compacted by itself last, unless it has since gone well past there.
    let session_point = compactions
        .iter()
        .rev()
        .find(|compaction| !is_manual(recorded, requests[compaction.index].timestamp_ms))
        .map(|compaction| compaction.before)
        .filter(|&point| tokens as f64 <= point as f64 * SESSION_POINT_OVERSHOOT);
    let learned_point = || {
        points
            .get(&point_key(&requests[latest]))
            .and_then(|points| points.iter().copied().find(|&point| point > tokens))
    };
    let default_point = || {
        (requests[latest].user_agent.starts_with("claude-cli/") && tokens < CLAUDE_CODE_COMPACTS_AT)
            .then_some(CLAUDE_CODE_COMPACTS_AT)
    };
    let (compacts_at, basis) = session_point
        .map(|point| (point, "session"))
        .or_else(|| learned_point().map(|point| (point, "learned")))
        .or_else(|| default_point().map(|point| (point, "default")))
        .map_or((None, ""), |(point, basis)| (Some(point), basis));

    // How fast it has grown since it last compacted, over the last stretch.
    let since = compactions.last().map_or(0, |compaction| compaction.index);
    let latest_at = requests[latest].timestamp_ms;
    let first = (since..=latest).find(|&index| {
        steps[index] != ContextStep::Side && latest_at - requests[index].timestamp_ms <= GROWTH_WINDOW_MS
    });
    let growth_per_ms = first
        .map(|first| (latest_at - requests[first].timestamp_ms, contexts[first]))
        .filter(|&(span, _)| span >= GROWTH_MIN_SPAN_MS)
        .map(|(span, start)| (tokens as f64 - start as f64) / span as f64)
        .filter(|&growth| growth > 0.0);
    let compacts_in_ms = compacts_at.and_then(|point| {
        if tokens >= point {
            return Some(0);
        }
        growth_per_ms
            .map(|growth| ((point - tokens) as f64 / growth).round() as i64)
            .filter(|&eta| eta <= FORECAST_MAX_MS)
    });
    LiveContext {
        tokens,
        model: requests[latest].model.clone(),
        compacts_at,
        basis,
        growth_per_minute: growth_per_ms.map(|growth| growth * 60_000.0),
        compacts_in_ms,
    }
}

/// True when the transcript's closest record of a compaction at `at_ms` says
/// the user asked for it.
fn is_manual(recorded: &[TranscriptCompaction], at_ms: i64) -> bool {
    recorded
        .iter()
        .filter(|compaction| (compaction.at_ms() - at_ms).abs() <= COMPACTION_MATCH_MS)
        .min_by_key(|compaction| (compaction.at_ms() - at_ms).abs())
        .is_some_and(TranscriptCompaction::is_manual)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: i64 = 60_000;
    const CLAUDE_CODE: &str = "claude-cli/2.1.280 (external, cli)";
    const AGENT_SDK: &str = "claude-cli/2.1.280 (external, sdk-ts, agent-sdk/0.3.276)";
    const CODEX: &str = "codex_cli_rs/0.156.0 (Mac OS 26.0.0; arm64) iTerm.app/3.6.1";

    /// A request a minute, at these contexts.
    fn requests(agent: &str, contexts: &[u64]) -> Vec<ThreadRequest> {
        contexts
            .iter()
            .enumerate()
            .map(|(index, &context)| ThreadRequest {
                timestamp_ms: index as i64 * MINUTE,
                context,
                model: "claude-opus-5-5".into(),
                user_agent: agent.into(),
            })
            .collect()
    }

    fn recorded(at_ms: i64, trigger: &str) -> TranscriptCompaction {
        serde_json::from_value(serde_json::json!({ "atMs": at_ms, "trigger": trigger })).unwrap()
    }

    fn points(client: &str, sizes: &[u64]) -> CompactionPoints {
        HashMap::from([((client.to_string(), "claude-opus-5-5".to_string()), sizes.to_vec())])
    }

    fn growth(context: &LiveContext) -> Option<f64> {
        context.growth_per_minute.map(|growth| (growth * 1_000.0).round() / 1_000.0)
    }

    #[test]
    fn compactions_cluster_by_context_window_and_one_offs_are_left_out() {
        let mut sizes = vec![159_000, 162_000, 165_000, 166_000, 167_000, 167_000, 168_000];
        sizes.extend([363_000, 365_000, 366_000, 372_000]);
        // Compacted by hand, once.
        sizes.push(90_000);
        assert_eq!(compaction_points(sizes), [166_000, 366_000]);
        // One compaction among many elsewhere is too few to be a point.
        let mut sizes = vec![365_000; 30];
        sizes.extend([167_000, 168_000]);
        assert_eq!(compaction_points(sizes), [365_000]);
        assert!(compaction_points(Vec::new()).is_empty());
    }

    #[test]
    fn a_session_compacts_where_it_compacted_before_at_the_pace_it_grows() {
        // Up to 350K, compacted to 90K, then 6K a minute for ten minutes.
        let mut contexts = vec![300_000, 320_000, 350_000, 90_000];
        contexts.extend((1..=10).map(|minute| 90_000 + minute * 6_000));
        let requests = requests(CLAUDE_CODE, &contexts);
        let recorded = [recorded(3 * MINUTE, "auto")];
        let context = live_context(&requests, &recorded, &CompactionPoints::new());
        assert_eq!(context.tokens, 150_000);
        assert_eq!(context.compacts_at, Some(350_000));
        assert_eq!(context.basis, "session");
        assert_eq!(growth(&context), Some(6_000.0));
        // 200K to go at 6K a minute.
        assert_eq!(context.compacts_in_ms, Some(2_000_000));
    }

    #[test]
    fn compacting_by_hand_says_nothing_about_where_it_compacts_by_itself() {
        let mut contexts = vec![60_000, 80_000, 100_000, 30_000];
        contexts.extend((1..=5).map(|minute| 30_000 + minute * 5_000));
        let requests = requests(CLAUDE_CODE, &contexts);
        let manual = [recorded(3 * MINUTE + 20_000, "manual")];
        let context = live_context(&requests, &manual, &points("Claude Code", &[167_000, 365_000]));
        assert_eq!((context.compacts_at, context.basis), (Some(167_000), "learned"));
        // Without the transcript's word for it, the drop is where it compacted.
        let context = live_context(&requests, &[], &CompactionPoints::new());
        assert_eq!((context.compacts_at, context.basis), (Some(100_000), "session"));
    }

    #[test]
    fn a_session_that_never_compacted_heads_for_the_next_learned_point_above_it() {
        let learned = points("Claude Code", &[167_000, 365_000]);
        let context = live_context(&requests(CLAUDE_CODE, &[100_000, 120_000]), &[], &learned);
        assert_eq!((context.compacts_at, context.basis), (Some(167_000), "learned"));
        // Past 167K it must have the larger window.
        let context = live_context(&requests(CLAUDE_CODE, &[180_000, 200_000]), &[], &learned);
        assert_eq!((context.compacts_at, context.basis), (Some(365_000), "learned"));
        // Points are learned per client: the Agent SDK has none here, so Claude Code's usual point it is.
        let context = live_context(&requests(AGENT_SDK, &[180_000, 200_000]), &[], &learned);
        assert_eq!((context.compacts_at, context.basis), (Some(CLAUDE_CODE_COMPACTS_AT), "default"));
        // Past every point, nothing says where it'll compact.
        let context = live_context(&requests(CLAUDE_CODE, &[380_000, 390_000]), &[], &learned);
        assert_eq!((context.compacts_at, context.basis, context.compacts_in_ms), (None, "", None));
        // Codex has no usual point.
        let context = live_context(&requests(CODEX, &[100_000, 120_000]), &[], &CompactionPoints::new());
        assert_eq!((context.tokens, context.compacts_at), (120_000, None));
    }

    #[test]
    fn a_session_well_past_where_it_compacted_before_has_moved_on_from_there() {
        // Compacted at 167K, then went on to 250K: a larger window since.
        let compacted = [150_000, 167_000, 60_000, 70_000, 80_000, 90_000, 95_000, 99_000];
        let requests = requests(CLAUDE_CODE, &[&compacted[..], &[250_000]].concat());
        let context = live_context(&requests, &[], &points("Claude Code", &[167_000, 365_000]));
        assert_eq!((context.compacts_at, context.basis), (Some(365_000), "learned"));
        // Just past it, it's due.
        let requests = self::requests(CLAUDE_CODE, &[&compacted[..], &[170_000]].concat());
        let context = live_context(&requests, &[], &CompactionPoints::new());
        assert_eq!((context.compacts_at, context.basis, context.compacts_in_ms), (Some(167_000), "session", Some(0)));
    }

    #[test]
    fn growth_skips_side_requests_and_needs_a_few_minutes_to_go_on() {
        // A title request at the end doesn't set the context, even before
        // the requests after it show it was one.
        let requests = requests(CLAUDE_CODE, &[100_000, 110_000, 120_000, 5_000]);
        let context = live_context(&requests, &[], &CompactionPoints::new());
        assert_eq!(context.tokens, 120_000);
        assert_eq!(growth(&context), Some(10_000.0));
        // A minute of growth is too little to forecast from.
        let context = live_context(&self::requests(CLAUDE_CODE, &[100_000, 110_000]), &[], &CompactionPoints::new());
        assert_eq!((context.compacts_at, context.growth_per_minute, context.compacts_in_ms), (Some(350_000), None, None));
        // Only the last GROWTH_WINDOW_MS count: an hour of slow growth, then a fast stretch.
        let mut contexts = (0..45).map(|minute| 20_000 + minute * 100).collect::<Vec<_>>();
        contexts.extend((1..=15).map(|minute| 24_400 + minute * 2_000));
        let context = live_context(&self::requests(CLAUDE_CODE, &contexts), &[], &CompactionPoints::new());
        assert_eq!(growth(&context), Some(2_000.0));
        // Too slow to reach the point within FORECAST_MAX_MS.
        let context = live_context(&self::requests(CLAUDE_CODE, &[100_000, 100_100, 100_200]), &[], &CompactionPoints::new());
        assert_eq!((growth(&context), context.compacts_in_ms), (Some(100.0), None));
    }

    #[test]
    fn a_session_whose_own_thread_made_no_request_has_no_context() {
        assert_eq!(live_context(&[], &[], &CompactionPoints::new()), LiveContext::default());
    }
}

//! Reading sessions, for every screen that shows them. `select_sessions` groups the requests into sessions and
//! narrows, orders and cuts them; `complete_sessions` works out what's costly to (peak context and compactions) for
//! the ones a screen shows. Reading them all here keeps a session's numbers the same wherever it appears.

use super::machine_health::transcripts::{load_session_transcripts, TranscriptCompaction};
use super::session_filters::{self, SessionFacets, SessionFilters};
use super::*;

/// A compaction the transcript records this close to one in the requests is
/// the same one. Matches COMPACTION_MATCH_MS in sessionTimeline.ts.
pub(super) const COMPACTION_MATCH_MS: i64 = 10 * 60_000;

/// The order sessions come in.
#[derive(Clone, Copy)]
pub(super) enum SessionOrder {
    /// The most recently active first.
    Recent,
    /// The costliest first, then the most recently active.
    Cost,
    /// The most tokens first, then the most recently active.
    Tokens,
    /// The most requests first, then the most recently active.
    Requests,
    /// The costliest first, then the longest running: the live board's order.
    CostThenOldest,
}

impl SessionOrder {
    /// The Sessions list's sort, by the name the page sends.
    pub(super) fn named(sort: Option<&str>) -> Self {
        match sort.map(str::trim) {
            Some("cost") => Self::Cost,
            Some("tokens") => Self::Tokens,
            Some("requests") => Self::Requests,
            _ => Self::Recent,
        }
    }
}

/// Which sessions to read.
pub(super) struct SessionSelect<'a> {
    /// The requests, and the filters on what each session is.
    pub(super) query: &'a UsageQuery,
    /// Only those that made a request in the last few minutes.
    pub(super) only_active: bool,
    pub(super) order: SessionOrder,
    /// Keep only the first this many.
    pub(super) limit: Option<usize>,
    /// Give each one kept its transcript, even when no filter needed it.
    pub(super) transcripts: bool,
}

pub(super) struct SelectedSessions {
    pub(super) sessions: Vec<UsageSession>,
    /// When the query asked for them.
    pub(super) facets: Option<SessionFacets>,
}

/// One of a thread's requests, as far as its conversation goes.
pub(super) struct ThreadRequest {
    pub(super) timestamp_ms: i64,
    pub(super) context: u64,
    pub(super) model: String,
    pub(super) user_agent: String,
}

/// The sessions the query's requests belong to, each with the subagent threads descended from it, narrowed by what
/// each session is, then ordered and cut. Their peak context and compactions stay 0 until `complete_sessions`.
pub(super) fn select_sessions(
    connection: &Connection,
    config: &GuiConfigFile,
    now_ms: i64,
    select: &SessionSelect,
) -> Result<SelectedSessions, String> {
    let mut sessions = group_sessions(connection, select.query, None, config, now_ms)?;
    if select.only_active {
        sessions.retain(|session| session.active);
    }
    let filters = SessionFilters::from_query(select.query);
    let with_facets = select.query.facets == Some(true);
    // Filtering by what a session is needs every session's transcript, not only the ones kept.
    let facets = if with_facets || !filters.is_empty() {
        fill_missing_transcripts(connection, &mut sessions)?;
        session_filters::filter_sessions(&mut sessions, &filters, with_facets)
    } else {
        None
    };
    sort_sessions(&mut sessions, select.order);
    if let Some(limit) = select.limit {
        sessions.truncate(limit);
    }
    if select.transcripts {
        fill_missing_transcripts(connection, &mut sessions)?;
    }
    Ok(SelectedSessions { sessions, facets })
}

/// These sessions over all their requests, each with the subagent threads descended from it, the most recently
/// active first and with their transcripts: each as `select_sessions` reads it over all time, without reading every
/// other session too. An id that turns out to be another session's subagent is left out, as that list files it under
/// the other session.
pub(super) fn select_session_trees(
    connection: &Connection,
    config: &GuiConfigFile,
    now_ms: i64,
    roots: &[String],
) -> Result<Vec<UsageSession>, String> {
    if roots.is_empty() {
        return Ok(Vec::new());
    }
    let ids = serde_json::to_string(roots).map_err(|error| error.to_string())?;
    let mut sessions = group_sessions(connection, &UsageQuery::default(), Some(&ids), config, now_ms)?;
    let roots = roots.iter().map(String::as_str).collect::<HashSet<_>>();
    sessions.retain(|session| roots.contains(session.root.id.as_str()));
    sort_sessions(&mut sessions, SessionOrder::Recent);
    fill_missing_transcripts(connection, &mut sessions)?;
    Ok(sessions)
}

/// Works out the peak context and compactions of every thread of these sessions, from all of each thread's requests
/// (not only the query's), and gives each its transcript. Hands back each thread's requests, by thread id.
pub(super) fn complete_sessions(
    connection: &Connection,
    sessions: &mut [UsageSession],
) -> Result<HashMap<String, Vec<ThreadRequest>>, String> {
    fill_missing_transcripts(connection, sessions)?;
    let ids = sessions
        .iter()
        .flat_map(|session| std::iter::once(&session.root.id).chain(session.threads.iter().map(|thread| &thread.id)))
        .cloned()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let requests = load_thread_requests(connection, &ids)?;
    let of = |id: &str| requests.get(id).map(Vec::as_slice).unwrap_or_default();
    for session in sessions {
        let recorded = session.transcript.as_ref().map(|transcript| transcript.compactions()).unwrap_or_default();
        (session.root.peak_context, session.root.compactions) = thread_context(of(&session.root.id), recorded);
        // The transcript is the session's own, so it speaks for the main thread only.
        for thread in &mut session.threads {
            (thread.peak_context, thread.compactions) = thread_context(of(&thread.id), &[]);
        }
    }
    Ok(requests)
}

/// A thread's peak context and how many times its conversation compacted, from its requests in order and the
/// compactions its transcript records.
pub(super) fn thread_context(requests: &[ThreadRequest], recorded: &[TranscriptCompaction]) -> (u64, usize) {
    let contexts = requests.iter().map(|request| request.context).collect::<Vec<_>>();
    let mut peak = 0;
    let mut detected = Vec::new();
    for (request, step) in requests.iter().zip(follow_conversation(&contexts)) {
        match step {
            ContextStep::Side => continue,
            ContextStep::Compacted => detected.push(request.timestamp_ms),
            ContextStep::Conversation => {}
        }
        peak = peak.max(request.context);
    }
    (peak, compaction_count(&detected, recorded))
}

/// Every drop in context Arbor saw, and every compaction the transcript records that isn't one of them. Each drop, in
/// order, takes the closest record within COMPACTION_MATCH_MS still free, as the session page's timeline pairs them
/// (addRecordedCompactions in sessionTimeline.ts).
fn compaction_count(detected: &[i64], recorded: &[TranscriptCompaction]) -> usize {
    let mut unmatched = (0..recorded.len()).collect::<Vec<_>>();
    for &at_ms in detected {
        let closest = unmatched
            .iter()
            .enumerate()
            .map(|(slot, &index)| (slot, (recorded[index].at_ms() - at_ms).abs()))
            .filter(|&(_, gap)| gap <= COMPACTION_MATCH_MS)
            .min_by_key(|&(_, gap)| gap);
        if let Some((slot, _)) = closest {
            unmatched.remove(slot);
        }
    }
    detected.len() + unmatched.len()
}

/// The sessions the query's requests belong to, before the filters on what
/// each session is: where it ran is one, as its transcript can say.
/// `trees`, a JSON list of session ids, keeps to those sessions and the threads descended from them.
fn group_sessions(
    connection: &Connection,
    query: &UsageQuery,
    trees: Option<&str>,
    config: &GuiConfigFile,
    now_ms: i64,
) -> Result<Vec<UsageSession>, String> {
    let assignments = machines::load_assignments(connection, config)?;
    let prices = load_model_prices(connection)?;
    let filter = build_usage_filter(&UsageQuery {
        machine: None,
        ..query.clone()
    });
    let mut filter = usage_filter_and(&filter, "session_id <> ''");
    if let Some(ids) = trees {
        // Walked the way the one-session filter walks a tree: each step a lookup in idx_usage_events_parent_session.
        filter = usage_filter_and(
            &filter,
            "session_id IN (WITH RECURSIVE session_tree(id) AS (SELECT value FROM json_each(?) UNION SELECT e.session_id FROM usage_events e JOIN session_tree t ON e.parent_session_id = t.id WHERE e.session_id IS NOT NULL) SELECT id FROM session_tree)",
        );
        filter.params.push(SqlValue::Text(ids.to_string()));
    }
    let tallies = load_usage_session_tallies(connection, &filter, &prices)?;
    let parent_of = resolve_session_parents(connection, &tallies)?;
    let mut trees = HashMap::<&str, Vec<Vec<&str>>>::new();
    for id in tallies.keys() {
        let ancestry = session_ancestry(id, &parent_of);
        let root = ancestry.last().copied().unwrap_or(id.as_str());
        trees.entry(root).or_default().push(ancestry);
    }
    let active_since = now_ms.saturating_sub(ACTIVE_SESSION_WINDOW_MS);
    Ok(trees
        .into_iter()
        .map(|(root, ancestries)| {
            build_usage_session(
                root,
                &ancestries,
                &tallies,
                &parent_of,
                &assignments,
                active_since,
            )
        })
        .collect())
}

fn sort_sessions(sessions: &mut [UsageSession], order: SessionOrder) {
    let recent = |left: &UsageSession, right: &UsageSession| {
        right
            .root
            .totals
            .last_active_at_ms
            .cmp(&left.root.totals.last_active_at_ms)
            .then_with(|| left.root.id.cmp(&right.root.id))
    };
    match order {
        SessionOrder::Recent => sessions.sort_by(recent),
        SessionOrder::Cost => sessions.sort_by(|left, right| {
            right
                .root
                .totals
                .estimated_cost
                .total_cmp(&left.root.totals.estimated_cost)
                .then_with(|| recent(left, right))
        }),
        SessionOrder::Tokens => sessions.sort_by(|left, right| {
            right
                .root
                .totals
                .total_tokens
                .cmp(&left.root.totals.total_tokens)
                .then_with(|| recent(left, right))
        }),
        SessionOrder::Requests => sessions.sort_by(|left, right| {
            right
                .root
                .totals
                .requests
                .cmp(&left.root.totals.requests)
                .then_with(|| recent(left, right))
        }),
        SessionOrder::CostThenOldest => sessions.sort_by(|left, right| {
            right
                .root
                .totals
                .estimated_cost
                .total_cmp(&left.root.totals.estimated_cost)
                .then(left.root.totals.started_at_ms.cmp(&right.root.totals.started_at_ms))
                .then(left.root.id.cmp(&right.root.id))
        }),
    }
}

/// Gives each session without its transcript what its transcript says.
fn fill_missing_transcripts(connection: &Connection, sessions: &mut [UsageSession]) -> Result<(), String> {
    let ids = sessions
        .iter()
        .filter(|session| session.transcript.is_none())
        .map(|session| session.root.id.as_str())
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(());
    }
    let mut transcripts = load_session_transcripts(connection, &ids)?;
    for session in sessions.iter_mut().filter(|session| session.transcript.is_none()) {
        session.transcript = transcripts.remove(&session.root.id);
    }
    Ok(())
}

/// Every request with a context of each of these threads, in order.
fn load_thread_requests(connection: &Connection, ids: &[String]) -> Result<HashMap<String, Vec<ThreadRequest>>, String> {
    let mut requests = HashMap::<String, Vec<ThreadRequest>>::new();
    for batch in ids.chunks(SESSION_LOOKUP_BATCH_SIZE) {
        let sql = format!(
            "SELECT session_id, timestamp_ms, input_tokens, COALESCE(model, ''), COALESCE(user_agent, '')
             FROM usage_events WHERE session_id IN ({}) AND input_tokens > 0 ORDER BY session_id, timestamp_ms, id",
            vec!["?"; batch.len()].join(", ")
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("Failed to prepare the session conversation query: {error}"))?;
        let rows = statement
            .query_map(params_from_iter(batch.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    ThreadRequest {
                        timestamp_ms: row.get(1)?,
                        context: from_sql_i64(row.get(2)?),
                        model: row.get(3)?,
                        user_agent: row.get(4)?,
                    },
                ))
            })
            .map_err(|error| format!("Failed to query the session conversations: {error}"))?;
        for row in rows {
            let (id, request) = row.map_err(|error| format!("Failed to read the session conversations: {error}"))?;
            requests.entry(id).or_default().push(request);
        }
    }
    Ok(requests)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: i64 = 60_000;

    fn recorded(at_ms: &[i64]) -> Vec<TranscriptCompaction> {
        at_ms
            .iter()
            .map(|&at_ms| serde_json::from_value(serde_json::json!({ "atMs": at_ms })).unwrap())
            .collect()
    }

    #[test]
    fn a_compaction_seen_in_the_requests_and_recorded_in_the_transcript_counts_once() {
        assert_eq!(compaction_count(&[60 * MINUTE], &recorded(&[62 * MINUTE])), 1);
    }

    #[test]
    fn records_too_far_from_any_drop_count_on_their_own() {
        // The list counts as the session page does: 2 here, where taking the larger of the two counts would say 1.
        assert_eq!(compaction_count(&[60 * MINUTE], &recorded(&[120 * MINUTE])), 2);
        assert_eq!(compaction_count(&[], &recorded(&[MINUTE, 2 * MINUTE])), 2);
        assert_eq!(compaction_count(&[MINUTE, 90 * MINUTE], &[]), 2);
    }

    #[test]
    fn each_drop_takes_the_closest_free_record_in_order() {
        // The first drop takes the record at 58 (2 minutes off) over the one at 65; the second takes 65.
        assert_eq!(compaction_count(&[60 * MINUTE, 66 * MINUTE], &recorded(&[65 * MINUTE, 58 * MINUTE])), 2);
        // Two drops, one record: the record pairs with one of them only.
        assert_eq!(compaction_count(&[60 * MINUTE, 64 * MINUTE], &recorded(&[62 * MINUTE])), 2);
        // Exactly COMPACTION_MATCH_MS away still pairs.
        assert_eq!(compaction_count(&[60 * MINUTE], &recorded(&[70 * MINUTE])), 1);
    }
}

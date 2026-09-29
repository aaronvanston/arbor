//! Sums requests into cost groups in Rust. SQLite's GROUP BY on the seven
//! pricing columns sorts every request first, which over a long history takes
//! three or four times as long as reading the requests once.

use super::*;
use rusqlite::types::ValueRef;

/// What a cost row reads after the query's own key columns, in this order.
const COST_ROW_COLUMNS: &str = "model, alias, service_tier, response_service_tier, executor_type, provider, auth_type, \
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_tokens";
/// The pricing columns, USAGE_COST_GROUP_KEYS, at the start of COST_ROW_COLUMNS.
const COST_KEY_COUNT: usize = 7;
const COST_ROW_COLUMN_COUNT: usize = 12;

/// One group's requests: its own key columns, what they cost, and whatever else the caller sums.
pub(super) struct CostRowGroup<T> {
    pub(super) keys: Vec<String>,
    pub(super) cost: UsageCostGroup,
    pub(super) extra: T,
}

/// The sums SQL would make, kept signed until the end as SUM keeps them.
#[derive(Default)]
struct Sums {
    requests: i64,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_creation: i64,
    long: [i64; 4],
    total: i64,
}

struct Building<T> {
    keys: Vec<String>,
    names: [String; COST_KEY_COUNT],
    /// The long-context tier the group is billed at, found once rather than per request.
    tier: Option<usize>,
    sums: Sums,
    extra: T,
}

/// Reads `SELECT {keys}, COST_ROW_COLUMNS, {extra} FROM usage_events{filter}` and sums the requests by the key columns
/// and USAGE_COST_GROUP_KEYS, into the groups GROUP BY would make, ordered by those columns. `add` gets each request
/// with the index of its first `extra` column, to fold into its group's T.
pub(super) fn fold_cost_rows<T: Default>(
    connection: &Connection,
    keys: &[&str],
    extra: &str,
    filter: &UsageSqlFilter,
    add: impl FnMut(&mut T, &Row<'_>, usize) -> rusqlite::Result<()>,
) -> Result<Vec<CostRowGroup<T>>, String> {
    let columns = keys
        .iter()
        .copied()
        .chain(std::iter::once(COST_ROW_COLUMNS))
        .chain((!extra.is_empty()).then_some(extra))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT {columns} FROM usage_events{}", filter.clause);
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare usage cost query: {error}"))?;
    let mut rows = statement
        .query(params_from_iter(filter.params.iter()))
        .map_err(|error| format!("Failed to query usage costs: {error}"))?;
    let mut groups = read_groups(&mut rows, keys.len(), add).map_err(|error| format!("Failed to read usage costs: {error}"))?;
    groups.sort_by(|left, right| left.keys.cmp(&right.keys).then_with(|| left.names.cmp(&right.names)));
    Ok(groups
        .into_iter()
        .map(|group| {
            let [model, alias, service_tier, response_service_tier, executor_type, provider, auth_type] = group.names;
            let sums = group.sums;
            let long = |index: usize| if group.tier.is_some() { from_sql_i64(sums.long[index]) } else { 0 };
            CostRowGroup {
                keys: group.keys,
                cost: UsageCostGroup {
                    requests: from_sql_i64(sums.requests),
                    tokens: CostTokens {
                        input: from_sql_i64(sums.input),
                        output: from_sql_i64(sums.output),
                        cache_read: from_sql_i64(sums.cache_read),
                        cache_creation: from_sql_i64(sums.cache_creation),
                        long_input: long(0),
                        long_output: long(1),
                        long_cache_read: long(2),
                        long_cache_creation: long(3),
                    },
                    total_tokens: from_sql_i64(sums.total),
                    model,
                    alias,
                    service_tier,
                    response_service_tier,
                    executor_type,
                    provider,
                    auth_type,
                },
                extra: group.extra,
            }
        })
        .collect())
}

fn read_groups<T: Default>(
    rows: &mut rusqlite::Rows<'_>,
    lead: usize,
    mut add: impl FnMut(&mut T, &Row<'_>, usize) -> rusqlite::Result<()>,
) -> rusqlite::Result<Vec<Building<T>>> {
    let mut slots = HashMap::<Vec<u8>, usize>::new();
    let mut groups = Vec::<Building<T>>::new();
    // Each request's key is built in the same buffer, so only a new group allocates.
    let mut key = Vec::new();
    while let Some(row) = rows.next()? {
        key.clear();
        for column in 0..lead + COST_KEY_COUNT {
            push_key_part(&mut key, row.get_ref(column)?);
        }
        let slot = match slots.get(key.as_slice()) {
            Some(&slot) => slot,
            None => {
                let text = |column: usize| row.get::<_, String>(column);
                let names = [
                    text(lead)?,
                    text(lead + 1)?,
                    text(lead + 2)?,
                    text(lead + 3)?,
                    text(lead + 4)?,
                    text(lead + 5)?,
                    text(lead + 6)?,
                ];
                groups.push(Building {
                    keys: (0..lead).map(text).collect::<rusqlite::Result<_>>()?,
                    tier: billed_long_context_tier(&names[0], &names[1]),
                    names,
                    sums: Sums::default(),
                    extra: T::default(),
                });
                slots.insert(key.clone(), groups.len() - 1);
                groups.len() - 1
            }
        };
        let group = &mut groups[slot];
        let at = lead + COST_KEY_COUNT;
        let input: i64 = row.get(at)?;
        let tokens = [input, row.get(at + 1)?, row.get(at + 2)?, row.get(at + 3)?];
        let sums = &mut group.sums;
        sums.requests += 1;
        sums.input = sums.input.saturating_add(tokens[0]);
        sums.output = sums.output.saturating_add(tokens[1]);
        sums.cache_read = sums.cache_read.saturating_add(tokens[2]);
        sums.cache_creation = sums.cache_creation.saturating_add(tokens[3]);
        // Every token of a request above its tier's threshold is billed at the long-context rates.
        if group.tier.is_some_and(|tier| input > LONG_CONTEXT_THRESHOLDS[tier] as i64) {
            for (long, value) in sums.long.iter_mut().zip(tokens) {
                *long = long.saturating_add(value);
            }
        }
        sums.total = sums.total.saturating_add(row.get(at + 4)?);
        add(&mut group.extra, row, lead + COST_ROW_COLUMN_COUNT)?;
    }
    Ok(groups)
}

/// Adds a column's value to a group key: its type, then its length, then its bytes, so no two different sets of
/// values make the same key, and 1 and '1' stay apart as they do in GROUP BY.
fn push_key_part(key: &mut Vec<u8>, value: ValueRef<'_>) {
    let (kind, bytes): (u8, std::borrow::Cow<'_, [u8]>) = match value {
        ValueRef::Null => (0, (&[][..]).into()),
        ValueRef::Integer(number) => (1, number.to_le_bytes().to_vec().into()),
        ValueRef::Real(number) => (2, number.to_bits().to_le_bytes().to_vec().into()),
        ValueRef::Text(text) => (3, text.into()),
        ValueRef::Blob(blob) => (4, blob.into()),
    };
    key.push(kind);
    key.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
    key.extend_from_slice(&bytes);
}

/// The larger of a group's value so far and this request's, compared as MAX compares text, skipping NULL.
pub(super) fn keep_max_text(kept: &mut Option<String>, value: ValueRef<'_>) {
    if let ValueRef::Text(text) = value {
        if kept.as_deref().is_none_or(|kept| text > kept.as_bytes()) {
            *kept = Some(String::from_utf8_lossy(text).into_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODELS: [(&str, &str); 6] = [
        ("claude-opus-5-5", ""),
        ("claude-sonnet-4-5[1m]", ""),
        ("gpt-5.5", ""),
        ("gpt-5.5-codex-mini", "gpt-5.5"),
        ("custom-model", "claude-sonnet-4-5"),
        ("", "unknown"),
    ];

    /// Requests across every combination the groups split on, above and below both long-context thresholds.
    fn requests() -> Connection {
        let connection = schema::test_database();
        let mut number = 0_i64;
        for (model, alias) in MODELS {
            for tier in ["", "priority", "flex"] {
                for provider in ["claude", "codex"] {
                    for input in [1_000, 199_999, 200_001, 272_001, 400_000] {
                        number += 1;
                        let session = ["", "s-a", "s-b", "s-a/sub"][(number % 4) as usize];
                        let parent = (session == "s-a/sub").then_some("s-a");
                        let agent = [None, Some("claude-cli/2.1"), Some("codex_cli_rs/0.60"), Some("")][(number % 4) as usize];
                        schema::insert_request(
                            &connection,
                            "timestamp_ms, latency_ms, model, alias, service_tier, provider, input_tokens, output_tokens, cache_read_tokens, \
                             cache_creation_tokens, total_tokens, reasoning_tokens, failed, canceled, session_id, parent_session_id, user_agent, api_key_hash",
                            rusqlite::params![
                                number * 1_000, number % 7 * 100, model, alias, tier, provider, input, number * 3, input / 2, number, input + number * 3,
                                number % 5, number % 6 == 0, number % 11 == 0, session, parent, agent, format!("key-{}", number % 3)
                            ],
                        );
                    }
                }
            }
        }
        connection
    }

    type Snapshot = (Vec<String>, [String; COST_KEY_COUNT], [u64; 10]);

    fn snapshot(keys: Vec<String>, group: &UsageCostGroup) -> Snapshot {
        let tokens = &group.tokens;
        (
            keys,
            [
                group.model.clone(),
                group.alias.clone(),
                group.service_tier.clone(),
                group.response_service_tier.clone(),
                group.executor_type.clone(),
                group.provider.clone(),
                group.auth_type.clone(),
            ],
            [
                group.requests,
                tokens.input,
                tokens.output,
                tokens.cache_read,
                tokens.cache_creation,
                tokens.long_input,
                tokens.long_output,
                tokens.long_cache_read,
                tokens.long_cache_creation,
                group.total_tokens,
            ],
        )
    }

    /// The groups as GROUP BY made them before, with the long-context share of the tier each is billed at.
    fn grouped_in_sql(connection: &Connection, keys: &str, filter: &str) -> Vec<Snapshot> {
        let long = LONG_CONTEXT_THRESHOLDS
            .iter()
            .flat_map(|threshold| {
                ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"]
                    .map(|column| format!("SUM(CASE WHEN input_tokens > {threshold} THEN {column} ELSE 0 END)"))
            })
            .collect::<Vec<_>>()
            .join(", ");
        let lead = keys.split(',').filter(|key| !key.trim().is_empty()).count();
        let group_keys = format!("{keys}{}model, alias, service_tier, response_service_tier, executor_type, provider, auth_type", if lead > 0 { ", " } else { "" });
        let sql = format!(
            "SELECT {group_keys}, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens), \
             SUM(total_tokens), {long} FROM usage_events{filter} GROUP BY {group_keys} ORDER BY {group_keys}"
        );
        let mut statement = connection.prepare(&sql).unwrap();
        let rows = statement
            .query_map([], |row| {
                let text = |column: usize| row.get::<_, String>(column);
                let names = [text(lead)?, text(lead + 1)?, text(lead + 2)?, text(lead + 3)?, text(lead + 4)?, text(lead + 5)?, text(lead + 6)?];
                let number = |column: usize| row.get::<_, i64>(column).map(from_sql_i64);
                let at = lead + COST_KEY_COUNT;
                let tier = billed_long_context_tier(&names[0], &names[1]);
                let long = |offset: usize| tier.map_or(Ok(0), |tier| number(at + 6 + tier * 4 + offset));
                Ok((
                    (0..lead).map(text).collect::<rusqlite::Result<Vec<_>>>()?,
                    names,
                    [number(at)?, number(at + 1)?, number(at + 2)?, number(at + 3)?, number(at + 4)?, long(0)?, long(1)?, long(2)?, long(3)?, number(at + 5)?],
                ))
            })
            .unwrap();
        rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
    }

    #[test]
    fn folds_requests_into_the_groups_group_by_made() {
        let connection = requests();
        let filter = build_usage_filter(&UsageQuery::default());
        let folded = fold_cost_rows::<()>(&connection, &[], "", &filter, |_, _, _| Ok(())).unwrap();
        let folded = folded.into_iter().map(|group| snapshot(group.keys, &group.cost)).collect::<Vec<_>>();
        assert_eq!(folded, grouped_in_sql(&connection, "", ""));
        assert!(folded.iter().any(|(_, _, sums)| sums[5] > 0), "some groups billed at long-context rates");

        let by_session = fold_cost_rows::<()>(&connection, &["session_id"], "", &usage_filter_and(&filter, "session_id <> ''"), |_, _, _| Ok(())).unwrap();
        let by_session = by_session.into_iter().map(|group| snapshot(group.keys, &group.cost)).collect::<Vec<_>>();
        assert_eq!(by_session, grouped_in_sql(&connection, "session_id", " WHERE session_id <> ''"));
    }

    #[test]
    fn session_tallies_match_the_aggregates_sql_took() {
        let connection = requests();
        let filter = usage_filter_and(&build_usage_filter(&UsageQuery::default()), "session_id <> ''");
        let tallies = load_usage_session_tallies(&connection, &filter, &HashMap::new()).unwrap();
        let mut statement = connection
            .prepare(
                "SELECT session_id, MAX(parent_session_id), MIN(timestamp_ms), MAX(timestamp_ms + latency_ms),
                     SUM(failed != 0 AND canceled = 0), SUM(canceled != 0), SUM(reasoning_tokens), MAX(user_agent), MAX(api_key_hash), COUNT(*)
                 FROM usage_events WHERE session_id <> '' GROUP BY session_id",
            )
            .unwrap();
        let expected = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (
                        row.get::<_, Option<String>>(1)?.filter(|id| !id.is_empty()),
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        from_sql_i64(row.get(4)?),
                        from_sql_i64(row.get(5)?),
                        from_sql_i64(row.get(6)?),
                        row.get::<_, Option<String>>(7)?.filter(|agent| !agent.trim().is_empty()),
                        row.get::<_, String>(8)?,
                        from_sql_i64(row.get(9)?),
                    ),
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<HashMap<_, _>>>()
            .unwrap();
        assert_eq!(tallies.len(), expected.len());
        for (id, tally) in &tallies {
            let totals = &tally.totals;
            assert_eq!(
                (
                    tally.parent_id.clone(),
                    totals.started_at_ms,
                    totals.last_active_at_ms,
                    totals.failures,
                    totals.canceled,
                    totals.reasoning_tokens,
                    tally.user_agent.clone(),
                    tally.api_key_hash.clone(),
                    totals.requests,
                ),
                expected[id],
                "{id}"
            );
        }
    }

    #[test]
    fn the_overview_in_one_pass_adds_up_as_its_separate_queries_did() {
        let connection = requests();
        // Spread the requests over hours and give them first-token times on both sides of their latency.
        connection
            .execute_batch(
                "UPDATE usage_events SET
                     local_hour = '2026-09-2' || (id % 3) || 'T' || printf('%02d', id % 5),
                     timestamp = '2026-09-26T00:00:' || printf('%02d', id % 60) || 'Z',
                     ttft_ms = CASE id % 4 WHEN 0 THEN NULL WHEN 1 THEN 0 WHEN 2 THEN latency_ms / 2 ELSE latency_ms + 1 END,
                     generate = id % 9 != 0;
                 INSERT INTO usage_machine_assignments (api_key_hash, label, machine, pool) VALUES ('key-1', '', 'Mac Mini', 'Local');",
            )
            .unwrap();
        let overview = load_usage_overview(&connection, &UsageQuery::default()).unwrap();
        let summary = connection
            .query_row(
                "SELECT COUNT(*), SUM(failed = 0), SUM(failed != 0 AND canceled = 0), SUM(canceled != 0), SUM(input_tokens), SUM(output_tokens),
                     SUM(reasoning_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens), SUM(total_tokens),
                     COALESCE(SUM(CASE WHEN generate != 0 AND failed = 0 AND canceled = 0 AND output_tokens > 0 AND ttft_ms IS NOT NULL
                         AND ttft_ms > 0 AND latency_ms > ttft_ms THEN output_tokens ELSE 0 END) * 1000.0
                       / NULLIF(SUM(CASE WHEN generate != 0 AND failed = 0 AND canceled = 0 AND output_tokens > 0 AND ttft_ms IS NOT NULL
                         AND ttft_ms > 0 AND latency_ms > ttft_ms THEN latency_ms - ttft_ms ELSE 0 END), 0), 0.0),
                     SUM(generate != 0 AND failed = 0 AND canceled = 0 AND output_tokens > 0 AND ttft_ms IS NOT NULL AND ttft_ms > 0 AND latency_ms > ttft_ms),
                     SUM(latency_ms)
                 FROM usage_events",
                [],
                |row| {
                    Ok((
                        (0..10).map(|column| row.get::<_, i64>(column).map(from_sql_i64)).collect::<rusqlite::Result<Vec<_>>>()?,
                        row.get::<_, f64>(10)?,
                        from_sql_i64(row.get(11)?),
                        row.get::<_, i64>(12)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            vec![
                overview.total_requests,
                overview.success_count,
                overview.failure_count,
                overview.canceled_count,
                overview.input_tokens,
                overview.output_tokens,
                overview.reasoning_tokens,
                overview.cache_read_tokens,
                overview.cache_creation_tokens,
                overview.total_tokens,
            ],
            summary.0
        );
        assert!(summary.2 > 0, "some requests count toward output speed");
        assert_eq!((overview.tps, overview.tps_sample_count), (summary.1, summary.2));
        assert_eq!(overview.average_latency_ms, summary.3 as f64 / overview.total_requests as f64);
        let groups = grouped_in_sql(&connection, "", "");
        let prices = load_model_prices(&connection).unwrap();
        let folded = fold_cost_rows::<()>(&connection, &[], "", &build_usage_filter(&UsageQuery::default()), |_, _, _| Ok(())).unwrap();
        assert_eq!(folded.len(), groups.len());
        let (cost, priced) = sum_usage_cost(&folded.into_iter().map(|group| group.cost).collect::<Vec<_>>(), &prices);
        assert_eq!((overview.estimated_cost, overview.priced_requests), (cost, priced));

        let mut statement = connection
            .prepare(
                "SELECT local_hour, COUNT(*), SUM(failed = 0), SUM(failed != 0 AND canceled = 0), SUM(canceled != 0), SUM(total_tokens),
                     MIN(CASE WHEN timestamp_ms > 0 THEN timestamp_ms END)
                 FROM usage_events GROUP BY local_hour ORDER BY local_hour",
            )
            .unwrap();
        let hours = statement
            .query_map([], |row| {
                Ok(serde_json::json!({
                    "hour": row.get::<_, String>(0)?,
                    "firstTimestampMs": row.get::<_, Option<i64>>(6)?,
                    "requests": row.get::<_, i64>(1)?,
                    "success": row.get::<_, i64>(2)?,
                    "failure": row.get::<_, i64>(3)?,
                    "canceled": row.get::<_, i64>(4)?,
                    "tokens": row.get::<_, i64>(5)?,
                }))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(serde_json::to_value(&overview.timeline).unwrap(), serde_json::Value::Array(hours));

        let mut statement = connection
            .prepare(
                "SELECT COALESCE(a.machine, ''), COALESCE(a.pool, ''), COUNT(*), SUM(e.total_tokens), SUM(e.failed = 0),
                     SUM(e.failed != 0 AND e.canceled = 0), SUM(e.canceled != 0), MAX(e.timestamp)
                 FROM usage_events e LEFT JOIN usage_machine_assignments a ON e.api_key_hash = a.api_key_hash
                 GROUP BY 1, 2 ORDER BY SUM(e.total_tokens) DESC",
            )
            .unwrap();
        let machines = statement
            .query_map([], |row| {
                Ok(serde_json::json!({
                    "machine": row.get::<_, String>(0)?,
                    "pool": row.get::<_, String>(1)?,
                    "requests": row.get::<_, i64>(2)?,
                    "tokens": row.get::<_, i64>(3)?,
                    "success": row.get::<_, i64>(4)?,
                    "failures": row.get::<_, i64>(5)?,
                    "canceled": row.get::<_, i64>(6)?,
                    "lastRequest": row.get::<_, Option<String>>(7)?,
                }))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(machines.len(), 2, "one assigned machine and the rest");
        assert_eq!(serde_json::to_value(&overview.machines).unwrap(), serde_json::Value::Array(machines));
    }
}

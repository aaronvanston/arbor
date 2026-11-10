//! The proxy's requests as rows for the archive's analytics tables. A row is ids, names and numbers: who served a
//! request, how long it took and what it cost. What a failed request answered with, the client's address and
//! agent, and its key all stay in usage.db, and the account is the core's index for it, never its name.

use super::*;
use session_tables::ProxyRequest;

/// Prices, and each model's once it has been found: a run of requests repeats a few models, and finding a model's
/// price walks the price lists.
pub(crate) struct Pricer {
    prices: HashMap<String, ModelPrice>,
    priced: HashMap<(String, String), Option<ModelPrice>>,
}

impl Pricer {
    pub(crate) fn load(connection: &Connection) -> Result<Self, String> {
        Ok(Self { prices: load_model_prices(connection)?, priced: HashMap::new() })
    }
}

/// Up to `limit` requests numbered above `after`, lowest first, each with what it cost at today's prices the way the
/// Usage pages work it out.
pub(crate) fn proxy_requests(connection: &Connection, pricer: &mut Pricer, after: u64, limit: u32) -> Result<Vec<ProxyRequest>, String> {
    let failed = |error: rusqlite::Error| format!("Couldn't read the proxy's requests: {error}");
    let Pricer { prices, priced } = pricer;
    let mut statement = connection
        .prepare(
            "SELECT id, timestamp_ms, session_id, parent_session_id, request_id, provider, auth_index, model, response_model, alias,
                    reasoning_effort, service_tier, response_service_tier, executor_type, auth_type, endpoint, node_kind,
                    failed, canceled, failure_status, is_fork, is_compaction, latency_ms, ttft_ms,
                    input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens
             FROM usage_events WHERE id > ?1 ORDER BY id LIMIT ?2",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(rusqlite::params![after as i64, limit], |row| {
            // A column that says nothing is an empty string as often as it's missing.
            let text = |at: usize| row.get::<_, Option<String>>(at).map(|value| value.filter(|value| !value.is_empty()));
            let count = |at: usize| row.get::<_, Option<i64>>(at).map(|value| from_sql_i64(value.unwrap_or(0)));
            let flag = |at: usize| row.get::<_, Option<i64>>(at).map(|value| value.map(|value| value != 0));
            let (input, output, cache_read, cache_write) = (count(24)?, count(25)?, count(27)?, count(28)?);
            let group = UsageCostGroup {
                model: text(7)?.unwrap_or_default(),
                alias: text(9)?.unwrap_or_default(),
                service_tier: text(11)?.unwrap_or_default(),
                response_service_tier: text(12)?.unwrap_or_default(),
                executor_type: text(13)?.unwrap_or_default(),
                provider: text(5)?.unwrap_or_default(),
                auth_type: text(14)?.unwrap_or_default(),
                requests: 1,
                tokens: CostTokens::default(),
                total_tokens: 0,
            };
            let tokens = request_cost_tokens(&group.model, &group.alias, input, output, cache_read, cache_write);
            let cost = priced
                .entry((group.model.clone(), group.alias.clone()))
                .or_insert_with(|| resolve_model_price(&group.model, &group.alias, prices).map(|(model, price)| enriched_model_price(model, &price)))
                .as_ref()
                .map(|price| cost_parts_at_price(&group.model, billed_service_tier(&group), &tokens, price).total());
            let some = |text: String| Some(text).filter(|text| !text.is_empty());
            Ok(ProxyRequest {
                id: from_sql_i64(row.get(0)?),
                ts: chrono::DateTime::<chrono::Utc>::from_timestamp_millis(row.get(1)?).map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
                session_id: text(2)?,
                parent_session_id: text(3)?,
                request_id: text(4)?,
                account: text(6)?,
                response_model: text(8)?,
                effort: text(10)?,
                endpoint: text(15)?,
                kind: text(16)?,
                failed: flag(17)? == Some(true),
                canceled: flag(18)? == Some(true),
                status: row.get::<_, Option<i64>>(19)?.filter(|status| *status != 0),
                fork: flag(20)?,
                compaction: flag(21)?,
                latency_ms: row.get::<_, Option<i64>>(22)?.map(from_sql_i64),
                ttft_ms: row.get::<_, Option<i64>>(23)?.filter(|at| *at >= 0).map(from_sql_i64),
                // usage.db's input counts what was read from and written to the cache; a row's doesn't.
                input: input.saturating_sub(cache_read.saturating_add(cache_write)),
                output,
                thinking: count(26)?,
                cache_read,
                cache_write,
                cost,
                // The tier it was billed at, which is the one its cost is worked out from.
                service_tier: some(billed_service_tier(&group).to_string()),
                provider: some(group.provider),
                model: some(group.model),
                alias: some(group.alias),
            })
        })
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_is_a_row_of_ids_names_and_numbers_with_its_cost() {
        let connection = schema::test_database();
        for number in 1..=3_i64 {
            schema::insert_request(
                &connection,
                "timestamp_ms, latency_ms, ttft_ms, model, provider, auth_index, session_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, failed, failure_status, failure_body, client_ip, api_key_display, source",
                rusqlite::params![1_790_000_000_000_i64 + number, 3000, if number == 2 { -1 } else { 1000 }, if number == 3 { "made-up-model" } else { "claude-opus-5-5" }, "claude", "a1", "s-1", 1000, 50, 400, 100, number == 2, if number == 2 { 529 } else { 0 }, "what was said", "10.0.0.9", "sk-display", "cam@example.com"],
            );
        }
        let mut pricer = Pricer::load(&connection).unwrap();
        let rows = proxy_requests(&connection, &mut pricer, 0, 10).unwrap();
        assert_eq!(rows.iter().map(|row| row.id).collect::<Vec<_>>(), [1, 2, 3]);
        let first = &rows[0];
        assert_eq!((first.ts.as_deref(), first.session_id.as_deref(), first.account.as_deref()), (Some("2026-09-21T14:13:20.001Z"), Some("s-1"), Some("a1")));
        assert_eq!((first.input, first.cache_read, first.cache_write, first.output, first.ttft_ms, first.status, first.failed), (500, 400, 100, 50, Some(1000), None, false));
        assert!(first.cost.is_some_and(|cost| cost > 0.0));
        assert_eq!((rows[1].failed, rows[1].status, rows[1].ttft_ms), (true, Some(529), None));
        // A model with no price has no cost.
        assert_eq!(rows[2].cost, None);
        // The numbering carries on from where the last read ended.
        assert_eq!(proxy_requests(&connection, &mut pricer, 2, 10).unwrap().iter().map(|row| row.id).collect::<Vec<_>>(), [3]);
        let all = serde_json::to_string(&rows).unwrap();
        for kept_back in ["what was said", "10.0.0.9", "sk-display", "cam@example.com"] {
            assert!(!all.contains(kept_back), "{kept_back}");
        }
    }
}

//! The weekly digest's cache misses: requests that sent a conversation again
//! uncached, because the provider dropped its cache or it expired while the
//! thread sat idle. The Sessions page shows each one on a session's timeline;
//! the digest adds them up over a week. The rest of the digest comes from the
//! Usage page's other commands.

use super::*;
use ts_rs::TS;

/// Requests with less context than this carry too little for a missed cache
/// to matter. Matches CACHE_MISS_MIN_TOKENS in sessionTimeline.ts.
const CACHE_MISS_MIN_TOKENS: u64 = 20_000;

#[derive(Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CacheMisses {
    /// Requests that missed the cache.
    pub(super) requests: u64,
    /// The context they had to send again uncached.
    pub(super) tokens: u64,
    /// What those requests paid for input the cache didn't cover: uncached
    /// input and cache writes. Missed requests without a price add nothing.
    pub(super) cost: f64,
    /// Missed requests with a price. Without any, the cost isn't known.
    pub(super) priced_requests: u64,
}

#[tauri::command]
pub(crate) async fn get_cache_misses(query: UsageQuery) -> Result<CacheMisses, String> {
    run_usage_task(move || load_cache_misses(&open_usage_database()?, &query)).await
}

/// One request of a thread, with what it takes to price it.
struct ThreadRequest {
    input: u64,
    cache_read: u64,
    cache_creation: u64,
    cost: UsageCostGroup,
}

/// The cache misses of every thread's conversation in the query's requests.
/// A thread's first request in the range has nothing before it to compare.
pub(super) fn load_cache_misses(connection: &Connection, query: &UsageQuery) -> Result<CacheMisses, String> {
    let prices = load_model_prices(connection)?;
    let filter = usage_filter_and(&build_usage_filter(query), "session_id <> '' AND input_tokens > 0");
    // Read in whatever order the range comes and put each thread in order here. Ordering by thread in SQL had it walk
    // the session index through every request ever made, to find the range's.
    let sql = format!(
        "SELECT session_id, timestamp_ms, id, model, alias, service_tier, response_service_tier, executor_type, provider,
            auth_type, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
         FROM usage_events{}",
        filter.clause
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare the cache miss query: {error}"))?;
    let mut rows = statement
        .query(params_from_iter(filter.params.iter()))
        .map_err(|error| format!("Failed to query cache misses: {error}"))?;
    let mut threads = HashMap::<String, Vec<(Option<i64>, i64, ThreadRequest)>>::new();
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("Failed to read cache misses: {error}"))?
    {
        let read = || -> rusqlite::Result<(String, (Option<i64>, i64, ThreadRequest))> {
            let model: String = row.get::<_, Option<String>>(3)?.unwrap_or_default();
            let alias: String = row.get::<_, Option<String>>(4)?.unwrap_or_default();
            let input = from_sql_i64(row.get(10)?);
            let output = from_sql_i64(row.get(11)?);
            let cache_read = from_sql_i64(row.get(12)?);
            let cache_creation = from_sql_i64(row.get(13)?);
            let request = ThreadRequest {
                input,
                cache_read,
                cache_creation,
                cost: UsageCostGroup {
                    tokens: request_cost_tokens(&model, &alias, input, output, cache_read, cache_creation),
                    model,
                    alias,
                    service_tier: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    response_service_tier: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    executor_type: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                    provider: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                    auth_type: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
                    requests: 1,
                    total_tokens: 0,
                },
            };
            Ok((row.get(0)?, (row.get(1)?, row.get(2)?, request)))
        };
        let (thread, request) = read().map_err(|error| format!("Failed to read cache misses: {error}"))?;
        threads.entry(thread).or_default().push(request);
    }
    // Threads in id order and each thread's requests by time then id, as ORDER BY session_id, timestamp_ms, id had
    // them, so the cost adds up in the same order.
    let mut threads = threads.into_iter().collect::<Vec<_>>();
    threads.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    let mut misses = CacheMisses::default();
    for (_, mut requests) in threads {
        requests.sort_unstable_by_key(|(at, id, _)| (*at, *id));
        let requests = requests.into_iter().map(|(_, _, request)| request).collect::<Vec<_>>();
        add_thread_misses(&requests, &prices, &mut misses);
    }
    Ok(misses)
}

/// Checks each step of a thread's conversation against the one before, the
/// way the session timeline does: side requests are skipped, and a
/// compaction starts the conversation over.
fn add_thread_misses(requests: &[ThreadRequest], prices: &HashMap<String, ModelPrice>, misses: &mut CacheMisses) {
    let contexts = requests.iter().map(|request| request.input).collect::<Vec<_>>();
    let mut previous: Option<&ThreadRequest> = None;
    for (request, step) in requests.iter().zip(follow_conversation(&contexts)) {
        if step == ContextStep::Side {
            continue;
        }
        if let Some(previous) = previous.filter(|_| step == ContextStep::Conversation) {
            let missed = cache_miss_tokens(previous, request);
            if missed > 0 {
                misses.requests += 1;
                misses.tokens = misses.tokens.saturating_add(missed);
                if let Some(cost) = cost_parts_for_usage_group(&request.cost, prices) {
                    misses.cost += cost.input + cost.cache_write;
                    misses.priced_requests += 1;
                }
            }
        }
        previous = Some(request);
    }
}

/// How many tokens `request` had to send again uncached that `previous` had
/// in the cache. Zero when nothing worth noting was missed. Matches
/// cacheMissTokens in sessionTimeline.ts.
fn cache_miss_tokens(previous: &ThreadRequest, request: &ThreadRequest) -> u64 {
    // The conversation has to have kept most of its context, and have been cached before.
    if request.input.saturating_mul(10) < previous.input.saturating_mul(8) {
        return 0;
    }
    if previous.cache_read.saturating_add(previous.cache_creation).saturating_mul(2) < previous.input {
        return 0;
    }
    let carried = previous.input.min(request.input);
    let missed = carried.saturating_sub(request.cache_read);
    if carried < CACHE_MISS_MIN_TOKENS
        || missed < CACHE_MISS_MIN_TOKENS
        || request.cache_read.saturating_mul(2) >= carried
    {
        return 0;
    }
    missed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(input: u64, cache_read: u64, cache_creation: u64) -> ThreadRequest {
        ThreadRequest {
            input,
            cache_read,
            cache_creation,
            cost: UsageCostGroup {
                model: "claude-opus-5-5".to_string(),
                alias: String::new(),
                service_tier: String::new(),
                response_service_tier: String::new(),
                executor_type: String::new(),
                provider: "claude".to_string(),
                auth_type: String::new(),
                requests: 1,
                tokens: request_cost_tokens("claude-opus-5-5", "", input, 500, cache_read, cache_creation),
                total_tokens: 0,
            },
        }
    }

    /// Cached the way a warm conversation is: most of it read, a little written.
    fn warm(input: u64) -> ThreadRequest {
        request(input, input * 9 / 10, input / 20)
    }

    // The same cases as sessionTimeline.test.ts.
    #[test]
    fn a_cache_that_went_cold_or_was_dropped_is_a_miss() {
        let cold = request(110_000, 2_000, 108_000);
        assert_eq!(cache_miss_tokens(&warm(100_000), &cold), 98_000);
        let dropped = request(112_000, 0, 112_000);
        assert_eq!(cache_miss_tokens(&cold, &dropped), 110_000);
    }

    #[test]
    fn small_misses_and_conversations_never_cached_are_not() {
        let base = warm(100_000);
        assert_eq!(cache_miss_tokens(&base, &request(101_000, 95_000, 0)), 0);
        assert_eq!(cache_miss_tokens(&warm(15_000), &request(16_000, 0, 0)), 0);
        assert_eq!(cache_miss_tokens(&request(100_000, 0, 0), &request(101_000, 0, 0)), 0);
        // A context that shrank a lot is a different conversation, not a miss.
        assert_eq!(cache_miss_tokens(&base, &request(70_000, 0, 0)), 0);
    }

    #[test]
    fn a_thread_counts_its_misses_but_not_across_side_requests_or_compactions() {
        let prices = HashMap::new();
        let mut misses = CacheMisses::default();
        add_thread_misses(
            &[
                warm(100_000),
                request(110_000, 2_000, 108_000), // went cold
                request(8_000, 0, 0),             // a side request, never compared
                warm(112_000),
                request(30_000, 0, 30_000), // compacted: a new conversation, not a miss
                warm(35_000),
                warm(40_000),
                warm(45_000),
                warm(50_000),
                warm(55_000),
            ],
            &prices,
            &mut misses,
        );
        // Without prices the cost isn't known.
        assert_eq!(
            misses,
            CacheMisses {
                requests: 1,
                tokens: 98_000,
                cost: 0.0,
                priced_requests: 0,
            }
        );
    }

    #[test]
    fn threads_stored_out_of_order_are_put_back_in_order() {
        let connection = schema::test_database();
        let add = |thread: &str, at: i64, (input, cache_read, cache_creation): (u64, u64, u64)| {
            schema::insert_request(
                &connection,
                "session_id, timestamp_ms, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens",
                params![thread, at, "claude-opus-5-5", input as i64, 500, cache_read as i64, cache_creation as i64],
            );
        };
        // Two threads interleaved in time, stored in neither's order.
        add("b", 40, (205_000, 0, 205_000)); // dropped
        add("a", 30, (110_000, 2_000, 108_000)); // went cold
        add("a", 10, (100_000, 90_000, 5_000));
        add("b", 20, (200_000, 180_000, 10_000));
        add("a", 50, (112_000, 100_800, 5_600));
        add("", 60, (300_000, 0, 300_000)); // no thread, never compared
        let misses = load_cache_misses(&connection, &UsageQuery::default()).unwrap();
        assert_eq!((misses.requests, misses.tokens), (2, 98_000 + 200_000));
        assert_eq!(misses.priced_requests, 2);
        assert!(misses.cost > 0.0);
    }
}

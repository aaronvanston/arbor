//! The capacity report.
//!
//! Two things per subscription account: what its requests would have cost at
//! API prices over a period, and how much of a long limit window it used,
//! from the limit history in [`super::limit_history`]. The webview matches
//! both to accounts, adds what each plan costs and decides which accounts are
//! worth keeping.

use super::*;
use ts_rs::TS;
use std::collections::BTreeMap;

/// Readings with reset times this close belong to the same cycle. A countdown
/// drifts by seconds between refreshes; a new cycle moves the reset by hours.
const SAME_RESET_MS: i64 = 3_600_000;

// Every field has a default, so the webview sends only what it sets.
#[derive(Default, Deserialize, TS)]
#[ts(optional_fields)]
pub(crate) struct CapacityQuery {
    #[serde(default)]
    start: Option<String>,
    #[serde(default)]
    end: Option<String>,
    /// The limit windows to follow, usually each provider's headline window.
    #[serde(default)]
    #[ts(as = "Option<_>", optional)]
    windows: Vec<String>,
}

#[derive(Debug, Default, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapacityReport {
    /// Where the period starts: the range start, or the first recorded request
    /// when the range has no start. None when nothing is recorded.
    start_ms: Option<i64>,
    end_ms: i64,
    accounts: Vec<AccountValue>,
    coverage: Vec<LimitCoverage>,
    cycles: Vec<LimitCycle>,
    /// The first limit reading on record.
    history_since_ms: Option<i64>,
}

#[derive(Debug, Default, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
struct AccountValue {
    auth_index: String,
    provider: String,
    requests: u64,
    total_tokens: u64,
    /// What the account's requests in the period would have cost at API prices.
    estimated_cost: f64,
    priced_requests: u64,
    /// The account's first recorded request, in the period or before it.
    first_seen_ms: i64,
}

/// When one account's window was watched during the period: its first and
/// last reading, including readings while the window wasn't running.
#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
struct LimitCoverage {
    account: String,
    window: String,
    first_sampled_at_ms: i64,
    last_sampled_at_ms: i64,
}

/// One account's use of one limit window between two resets, as far as the
/// period's readings show it.
#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LimitCycle {
    account: String,
    auth_index: String,
    plan: String,
    window: String,
    reset_at_ms: i64,
    /// How much of the window was left at the first reading in the period.
    first_remaining_percent: f64,
    /// The least of the window left at any reading.
    min_remaining_percent: f64,
    first_sampled_at_ms: i64,
    last_sampled_at_ms: i64,
}

#[tauri::command]
pub(crate) async fn get_capacity_report(query: CapacityQuery) -> Result<CapacityReport, String> {
    run_usage_task(move || {
        let now_ms = Local::now().timestamp_millis();
        load_capacity_report(&open_usage_database()?, &query, now_ms)
    })
    .await
}

pub(super) fn load_capacity_report(connection: &Connection, query: &CapacityQuery, now_ms: i64) -> Result<CapacityReport, String> {
    let end_ms = query.end.as_deref().and_then(parse_timestamp_millis).unwrap_or(now_ms);
    let filter = build_usage_filter(&UsageQuery {
        start: query.start.clone(),
        end: query.end.clone(),
        ..UsageQuery::default()
    });
    let prices = load_model_prices(connection)?;
    let mut accounts = load_account_values(connection, &filter, &prices)?;
    let first_seen = load_first_seen(connection, end_ms)?;
    for account in &mut accounts {
        account.first_seen_ms = first_seen.get(&account.auth_index).copied().unwrap_or_default();
    }
    let start_ms = match query.start.as_deref().and_then(parse_timestamp_millis) {
        Some(start) => Some(start),
        None => connection
            .query_row("SELECT MIN(timestamp_ms) FROM usage_events", [], |row| row.get::<_, Option<i64>>(0))
            .map_err(|error| format!("Failed to read the first usage record: {error}"))?,
    };
    let mut report = CapacityReport { start_ms, end_ms, accounts, ..CapacityReport::default() };
    (report.coverage, report.cycles) = load_limit_history(connection, &query.windows, start_ms, end_ms)?;
    report.history_since_ms = connection
        .query_row("SELECT MIN(sampled_at_ms) FROM usage_limit_samples", [], |row| row.get::<_, Option<i64>>(0))
        .map_err(|error| format!("Failed to read limit history: {error}"))?;
    Ok(report)
}

/// Requests, tokens and API-price value per credential. Costs are worked out
/// per pricing group, the same way as everywhere else on the Usage page.
fn load_account_values(
    connection: &Connection,
    filter: &UsageSqlFilter,
    prices: &HashMap<String, ModelPrice>,
) -> Result<Vec<AccountValue>, String> {
    let filter = usage_filter_and(filter, "auth_index != ''");
    let groups = cost_groups::fold_cost_rows::<()>(connection, &["auth_index"], "", &filter, |_, _, _| Ok(()))?;
    let mut values = BTreeMap::<String, AccountValue>::new();
    for cost_groups::CostRowGroup { keys, cost: group, .. } in groups {
        let auth_index = keys.into_iter().next().unwrap_or_default();
        let cost = cost_for_usage_group(&group, prices);
        let value = values.entry(auth_index.clone()).or_insert_with(|| AccountValue {
            auth_index,
            provider: group.provider.clone(),
            ..AccountValue::default()
        });
        value.requests = value.requests.saturating_add(group.requests);
        value.total_tokens = value.total_tokens.saturating_add(group.total_tokens);
        if let Some(cost) = cost {
            value.estimated_cost += cost;
            value.priced_requests = value.priced_requests.saturating_add(group.requests);
        }
    }
    Ok(values.into_values().collect())
}

/// Each credential's first recorded request up to `end_ms`. A subscription
/// only costs money from then on, as far as the report can tell.
fn load_first_seen(connection: &Connection, end_ms: i64) -> Result<HashMap<String, i64>, String> {
    let mut statement = connection
        // Steps from credential to credential on idx_usage_events_auth_index_timestamp, one
        // lookup each for the first request, rather than grouping every request.
        .prepare(
            "WITH RECURSIVE credentials(auth_index) AS (
                 SELECT MIN(auth_index) FROM usage_events WHERE auth_index > ''
                 UNION ALL
                 SELECT (SELECT MIN(auth_index) FROM usage_events WHERE auth_index > credentials.auth_index)
                 FROM credentials WHERE auth_index IS NOT NULL
             )
             SELECT auth_index, first_ms FROM (
                 SELECT auth_index,
                     (SELECT MIN(timestamp_ms) FROM usage_events e WHERE e.auth_index = credentials.auth_index AND e.timestamp_ms <= ?1) AS first_ms
                 FROM credentials WHERE auth_index IS NOT NULL
             )
             WHERE first_ms IS NOT NULL",
        )
        .map_err(|error| format!("Failed to prepare first-seen query: {error}"))?;
    let rows = statement
        .query_map(params![end_ms], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|error| format!("Failed to query first-seen times: {error}"))?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| format!("Failed to read first-seen times: {error}"))?;
    Ok(rows)
}

struct Reading {
    account: String,
    auth_index: String,
    plan: String,
    window: String,
    remaining_percent: f64,
    reset_at_ms: Option<i64>,
    sampled_at_ms: i64,
}

/// Reads the given windows' readings taken during the period and folds them
/// into what was watched when, and cycles, one per account, window and reset.
fn load_limit_history(
    connection: &Connection,
    windows: &[String],
    start_ms: Option<i64>,
    end_ms: i64,
) -> Result<(Vec<LimitCoverage>, Vec<LimitCycle>), String> {
    let windows: Vec<&str> = windows.iter().map(|window| window.trim()).filter(|window| !window.is_empty()).collect();
    if windows.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let placeholders = vec!["?"; windows.len()].join(", ");
    let mut params: Vec<SqlValue> = windows.iter().map(|window| SqlValue::Text(window.to_string())).collect();
    params.push(SqlValue::Integer(start_ms.unwrap_or(i64::MIN)));
    params.push(SqlValue::Integer(end_ms));
    let readings = read_readings(
        connection,
        &format!("window_label IN ({placeholders}) AND sampled_at_ms >= ? AND sampled_at_ms <= ?"),
        &params,
    )?;
    Ok(fold_readings(readings))
}

/// How many of a window's latest cycles "What used this?" offers.
const RECENT_CYCLES: usize = 6;

/// One account's latest cycles of one limit window, newest first, so the
/// Accounts page can show what used a window that has already reset.
#[tauri::command]
pub(crate) async fn get_limit_cycles(account: String, window: String) -> Result<Vec<LimitCycle>, String> {
    run_usage_task(move || load_limit_cycles(&open_usage_database()?, &account, &window)).await
}

fn load_limit_cycles(connection: &Connection, account: &str, window: &str) -> Result<Vec<LimitCycle>, String> {
    let readings = read_readings(
        connection,
        "account = ? AND window_label = ?",
        &[SqlValue::Text(account.to_string()), SqlValue::Text(window.trim().to_string())],
    )?;
    let (_, mut cycles) = fold_readings(readings);
    cycles.reverse();
    cycles.truncate(RECENT_CYCLES);
    Ok(cycles)
}

/// The main-limit readings that meet `condition`, in the order
/// [`fold_readings`] needs them.
fn read_readings(connection: &Connection, condition: &str, params: &[SqlValue]) -> Result<Vec<Reading>, String> {
    let sql = format!(
        "SELECT account, auth_index, plan, window_label, remaining_percent, reset_at_ms, sampled_at_ms
         FROM usage_limit_samples
         WHERE extra = 0 AND remaining_percent IS NOT NULL AND {condition}
         ORDER BY account, window_label, sampled_at_ms"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare limit history query: {error}"))?;
    let readings = statement
        .query_map(params_from_iter(params.iter()), |row| {
            Ok(Reading {
                account: row.get(0)?,
                auth_index: row.get(1)?,
                plan: row.get(2)?,
                window: row.get(3)?,
                remaining_percent: row.get(4)?,
                reset_at_ms: row.get(5)?,
                sampled_at_ms: row.get(6)?,
            })
        })
        .map_err(|error| format!("Failed to query limit history: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read limit history: {error}"))?;
    Ok(readings)
}

/// Folds readings, sorted by account, window and time. A reading without a
/// reset time (a window that isn't running) counts toward the time watched
/// but belongs to no cycle.
fn fold_readings(readings: Vec<Reading>) -> (Vec<LimitCoverage>, Vec<LimitCycle>) {
    let mut coverage: Vec<LimitCoverage> = Vec::new();
    let mut cycles: Vec<LimitCycle> = Vec::new();
    for reading in readings {
        match coverage.last_mut() {
            Some(watched) if watched.account == reading.account && watched.window == reading.window => {
                watched.last_sampled_at_ms = reading.sampled_at_ms;
            }
            _ => coverage.push(LimitCoverage {
                account: reading.account.clone(),
                window: reading.window.clone(),
                first_sampled_at_ms: reading.sampled_at_ms,
                last_sampled_at_ms: reading.sampled_at_ms,
            }),
        }
        let Some(reset_at_ms) = reading.reset_at_ms else {
            continue;
        };
        match cycles.last_mut() {
            Some(cycle)
                if cycle.account == reading.account
                    && cycle.window == reading.window
                    && (reset_at_ms - cycle.reset_at_ms).abs() <= SAME_RESET_MS =>
            {
                cycle.min_remaining_percent = cycle.min_remaining_percent.min(reading.remaining_percent);
                cycle.last_sampled_at_ms = reading.sampled_at_ms;
                cycle.reset_at_ms = reset_at_ms;
                cycle.auth_index = reading.auth_index;
                if !reading.plan.is_empty() {
                    cycle.plan = reading.plan;
                }
            }
            _ => cycles.push(LimitCycle {
                account: reading.account,
                auth_index: reading.auth_index,
                plan: reading.plan,
                window: reading.window,
                reset_at_ms,
                first_remaining_percent: reading.remaining_percent,
                min_remaining_percent: reading.remaining_percent,
                first_sampled_at_ms: reading.sampled_at_ms,
                last_sampled_at_ms: reading.sampled_at_ms,
            }),
        }
    }
    (coverage, cycles)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::limit_history::{record_samples, LimitReading};
    use chrono::{TimeZone, Utc};

    const HOUR: i64 = 3_600_000;
    const DAY: i64 = 24 * HOUR;

    fn event(connection: &Connection, timestamp_ms: i64, auth_index: &str, provider: &str, input: i64, output: i64) {
        connection
            .execute(
                "INSERT INTO usage_events (
                    event_key, timestamp, timestamp_ms, local_hour, auth_index, provider,
                    model, input_tokens, output_tokens, total_tokens, created_at
                ) VALUES (?1, '', ?2, '', ?3, ?4, 'capacity-test-model', ?5, ?6, ?5 + ?6, '')",
                params![format!("{auth_index}-{timestamp_ms}"), timestamp_ms, auth_index, provider, input, output],
            )
            .unwrap();
    }

    fn reading(account: &str, window: &str, at: i64, remaining: f64, reset: Option<i64>) -> LimitReading {
        LimitReading {
            account: format!("{account}.json::{account}"),
            auth_index: account.into(),
            provider: "claude".into(),
            plan: "Max".into(),
            window: window.into(),
            remaining_percent: Some(remaining),
            reset_at_ms: reset,
            extra: false,
            sampled_at_ms: at,
        }
    }

    fn test_database() -> Connection {
        let connection = schema::test_database();
        upsert_model_price(
            &connection,
            &ModelPrice {
                model: "capacity-test-model".into(),
                prompt: 1.0,
                completion: 2.0,
                prompt_configured: true,
                completion_configured: true,
                source: "manual".into(),
                ..ModelPrice::default()
            },
        )
        .unwrap();
        connection
    }

    fn iso(ms: i64) -> String {
        Utc.timestamp_millis_opt(ms).unwrap().to_rfc3339()
    }

    #[test]
    fn values_each_account_in_the_period_and_knows_when_it_first_appeared() {
        let connection = test_database();
        let start = 100 * DAY;
        // `work` was in use before the period; `new` first appears inside it.
        // At $1 in and $2 out per million tokens.
        event(&connection, start - 3 * DAY, "work", "claude", 250_000, 0);
        event(&connection, start + HOUR, "work", "claude", 250_000, 125_000);
        event(&connection, start + 2 * HOUR, "work", "claude", 250_000, 0);
        event(&connection, start + 5 * DAY, "new", "codex", 0, 250_000);
        // No credential behind it (an API key), and after the period: both left out.
        event(&connection, start + HOUR, "", "openai", 250_000, 0);
        event(&connection, start + 8 * DAY, "work", "claude", 250_000, 0);

        let query = CapacityQuery { start: Some(iso(start)), end: Some(iso(start + 7 * DAY)), windows: Vec::new() };
        let report = load_capacity_report(&connection, &query, start + 9 * DAY).unwrap();
        assert_eq!(report.start_ms, Some(start));
        assert_eq!(report.end_ms, start + 7 * DAY);
        assert_eq!(
            report.accounts,
            vec![
                AccountValue { auth_index: "new".into(), provider: "codex".into(), requests: 1, total_tokens: 250_000, estimated_cost: 0.5, priced_requests: 1, first_seen_ms: start + 5 * DAY },
                AccountValue { auth_index: "work".into(), provider: "claude".into(), requests: 2, total_tokens: 625_000, estimated_cost: 0.75, priced_requests: 2, first_seen_ms: start - 3 * DAY },
            ]
        );
        // No limit readings yet.
        assert_eq!((report.coverage.len(), report.cycles.len(), report.history_since_ms), (0, 0, None));

        // An open range starts at the first recorded request.
        let open = load_capacity_report(&connection, &CapacityQuery::default(), start + 9 * DAY).unwrap();
        assert_eq!(open.start_ms, Some(start - 3 * DAY));
        assert_eq!(open.end_ms, start + 9 * DAY);
    }

    #[test]
    fn folds_the_period_readings_into_time_watched_and_cycles() {
        let mut connection = test_database();
        let weekly = "7-day window";
        let first_reset = 110 * DAY;
        let second_reset = first_reset + 7 * DAY;
        record_samples(
            &mut connection,
            &[
                // Before the period: left out.
                reading("work", weekly, 101 * DAY, 90.0, Some(first_reset)),
                reading("work", weekly, 104 * DAY, 70.0, Some(first_reset)),
                // The countdown drifted by seconds: still the same cycle.
                reading("work", weekly, 106 * DAY, 55.0, Some(first_reset + 20_000)),
                reading("work", weekly, 109 * DAY, 12.0, Some(first_reset - 5_000)),
                // The window reset and stayed idle for a day before the next cycle started.
                reading("work", weekly, 110 * DAY + HOUR, 100.0, None),
                reading("work", weekly, 111 * DAY, 97.0, Some(second_reset)),
                // Another window, and one nobody asked about.
                reading("work", "5-hour window", 111 * DAY, 40.0, Some(111 * DAY + 3 * HOUR)),
                reading("spare", weekly, 105 * DAY, 100.0, None),
                reading("spare", weekly, 108 * DAY, 100.0, None),
            ],
            120 * DAY,
        )
        .unwrap();

        let query = CapacityQuery {
            start: Some(iso(104 * DAY)),
            end: None,
            windows: vec![weekly.into(), " ".into()],
        };
        let report = load_capacity_report(&connection, &query, 112 * DAY).unwrap();
        let watched: Vec<_> = report
            .coverage
            .iter()
            .map(|watched| (watched.account.as_str(), watched.first_sampled_at_ms, watched.last_sampled_at_ms))
            .collect();
        assert_eq!(watched, vec![("spare.json::spare", 105 * DAY, 108 * DAY), ("work.json::work", 104 * DAY, 111 * DAY)]);
        let cycles: Vec<_> = report
            .cycles
            .iter()
            .map(|cycle| (cycle.auth_index.as_str(), cycle.reset_at_ms, cycle.first_remaining_percent, cycle.min_remaining_percent, cycle.first_sampled_at_ms, cycle.last_sampled_at_ms))
            .collect();
        assert_eq!(
            cycles,
            vec![
                ("work", first_reset - 5_000, 70.0, 12.0, 104 * DAY, 109 * DAY),
                ("work", second_reset, 97.0, 97.0, 111 * DAY, 111 * DAY),
            ]
        );
        assert_eq!(report.history_since_ms, Some(101 * DAY));
        assert_eq!(load_limit_history(&connection, &[], None, 112 * DAY).unwrap(), (Vec::new(), Vec::new()));
    }

    #[test]
    fn lists_an_accounts_latest_cycles_of_one_window_newest_first() {
        let mut connection = test_database();
        assert!(load_limit_cycles(&connection, "work.json::work", "5-hour window").unwrap().is_empty());

        let window = "5-hour window";
        let mut samples = Vec::new();
        for cycle in 0..8 {
            let reset = 100 * DAY + cycle * 6 * HOUR;
            samples.push(reading("work", window, reset - 4 * HOUR, 80.0, Some(reset)));
            samples.push(reading("work", window, reset - HOUR, 30.0 - cycle as f64, Some(reset)));
        }
        samples.push(reading("work", "7-day window", 100 * DAY, 50.0, Some(104 * DAY)));
        samples.push(reading("spare", window, 100 * DAY, 10.0, Some(100 * DAY + HOUR)));
        // A limit outside the main one, which "What used this?" doesn't cover.
        samples.push(LimitReading { extra: true, ..reading("work", window, 102 * DAY, 0.0, Some(102 * DAY + HOUR)) });
        record_samples(&mut connection, &samples, 103 * DAY).unwrap();

        let cycles = load_limit_cycles(&connection, "work.json::work", " 5-hour window ").unwrap();
        assert_eq!(cycles.len(), RECENT_CYCLES);
        assert_eq!(
            cycles.iter().map(|cycle| (cycle.reset_at_ms, cycle.min_remaining_percent)).collect::<Vec<_>>(),
            (2..8).rev().map(|cycle| (100 * DAY + cycle * 6 * HOUR, 30.0 - cycle as f64)).collect::<Vec<_>>()
        );
        assert!(cycles.iter().all(|cycle| cycle.auth_index == "work" && cycle.window == window));
        assert!(load_limit_cycles(&connection, "work.json::work", "Weekly limit").unwrap().is_empty());
    }
}

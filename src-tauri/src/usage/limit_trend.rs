//! Limit readings over time, for the forecast on Accounts › Limits.
//!
//! The capacity report folds the limit history into cycles; the forecast
//! needs the readings themselves, to draw the pool's trend and to measure how
//! fast it drains between resets. It asks after every refresh, for weeks of
//! every account, so the readings are thinned to about one an hour (every
//! reset kept) and sent as bare tuples grouped by account.

use super::*;
use ts_rs::TS;

/// The furthest back the forecast reads: four weeks give its hour-of-week
/// pattern several samples of every hour.
const MAX_LOOKBACK_MS: i64 = 28 * 86_400_000;
/// Readings closer together than this are thinned to the later one. Spend is
/// measured between readings, so what's dropped is only when within the hour
/// it happened.
const THIN_GAP_MS: i64 = 3_600_000;
/// A reset that moves further than this starts a new cycle, which is always kept.
const SAME_RESET_MS: i64 = 3_600_000;

/// One account's readings of one limit window, oldest first: when it was read,
/// the percent left, and when the window resets.
#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LimitTrendAccount {
    account: String,
    auth_index: String,
    readings: Vec<(i64, f64, Option<i64>)>,
}

/// Every account's readings of one provider's limit window since `since_ms`
/// (at most four weeks back), about one an hour.
#[tauri::command]
pub(crate) async fn get_limit_trend(provider: String, window: String, since_ms: i64) -> Result<Vec<LimitTrendAccount>, String> {
    run_usage_task(move || {
        let now_ms = Local::now().timestamp_millis();
        load_limit_trend(&open_usage_database()?, &provider, &window, since_ms, now_ms)
    })
    .await
}

pub(super) fn load_limit_trend(
    connection: &Connection,
    provider: &str,
    window: &str,
    since_ms: i64,
    now_ms: i64,
) -> Result<Vec<LimitTrendAccount>, String> {
    let since_ms = since_ms.max(now_ms - MAX_LOOKBACK_MS);
    let mut statement = connection
        .prepare(
            "SELECT account, auth_index, sampled_at_ms, remaining_percent, reset_at_ms
             FROM usage_limit_samples
             WHERE sampled_at_ms >= ?1 AND provider = ?2 AND window_label = ?3
               AND extra = 0 AND remaining_percent IS NOT NULL
             ORDER BY account, sampled_at_ms",
        )
        .map_err(|error| format!("Failed to prepare limit trend query: {error}"))?;
    let mut rows = statement
        .query(params![since_ms, provider.trim(), window.trim()])
        .map_err(|error| format!("Failed to query limit trend: {error}"))?;
    let mut accounts: Vec<LimitTrendAccount> = Vec::new();
    while let Some(row) = rows.next().map_err(|error| format!("Failed to read limit trend: {error}"))? {
        let failed = |error: rusqlite::Error| format!("Failed to read limit trend: {error}");
        let account: String = row.get(0).map_err(failed)?;
        let reading = (row.get(2).map_err(failed)?, row.get(3).map_err(failed)?, row.get(4).map_err(failed)?);
        match accounts.last_mut() {
            Some(current) if current.account == account => keep(&mut current.readings, reading),
            _ => accounts.push(LimitTrendAccount { account, auth_index: row.get(1).map_err(failed)?, readings: vec![reading] }),
        }
    }
    Ok(accounts)
}

/// Adds a reading, replacing the latest kept one when both fall within the
/// hour of the one before it and belong to the same cycle, so the first and
/// last of every stretch stay.
fn keep(readings: &mut Vec<(i64, f64, Option<i64>)>, reading: (i64, f64, Option<i64>)) {
    let same_cycle = |a: Option<i64>, b: Option<i64>| match (a, b) {
        (Some(a), Some(b)) => (a - b).abs() <= SAME_RESET_MS,
        (a, b) => a == b,
    };
    if let [.., before, latest] = readings.as_slice() {
        if reading.0 - before.0 < THIN_GAP_MS && same_cycle(before.2, latest.2) && same_cycle(latest.2, reading.2) {
            if let Some(last) = readings.last_mut() {
                *last = reading;
            }
            return;
        }
    }
    readings.push(reading);
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::limit_history::{record_samples, LimitReading};

    const NOW: i64 = 1_800_000_000_000;
    const HOUR: i64 = 3_600_000;
    const RESET: i64 = NOW + 48 * HOUR;

    fn reading(account: &str, window: &str, at: i64, remaining: Option<f64>, extra: bool) -> LimitReading {
        LimitReading {
            account: account.into(),
            auth_index: "idx".into(),
            provider: "claude".into(),
            plan: String::new(),
            window: window.into(),
            remaining_percent: remaining,
            reset_at_ms: Some(RESET),
            extra,
            sampled_at_ms: at,
        }
    }

    #[test]
    fn reads_one_window_by_account_then_time() {
        let mut connection = crate::usage::schema::test_database();
        record_samples(
            &mut connection,
            &[
                reading("b", "7-day", NOW - 2 * HOUR, Some(80.0), false),
                reading("a", "7-day", NOW - 3 * HOUR, Some(90.0), false),
                reading("a", "7-day", NOW - HOUR, Some(70.0), false),
                reading("a", "5-hour", NOW - HOUR, Some(10.0), false),
                reading("a", "7-day", NOW - 30 * 60_000, Some(60.0), true),
                reading("c", "7-day", NOW - HOUR, None, false),
            ],
            NOW,
        )
        .unwrap();
        let trend = load_limit_trend(&connection, "claude", "7-day", NOW - 10 * HOUR, NOW).unwrap();
        let seen: Vec<(&str, Vec<f64>)> = trend.iter().map(|item| (item.account.as_str(), item.readings.iter().map(|r| r.1).collect())).collect();
        assert_eq!(seen, vec![("a", vec![90.0, 70.0]), ("b", vec![80.0])]);
        assert!(load_limit_trend(&connection, "codex", "7-day", NOW - 10 * HOUR, NOW).unwrap().is_empty());
    }

    #[test]
    fn reads_no_further_back_than_four_weeks() {
        let mut connection = crate::usage::schema::test_database();
        record_samples(
            &mut connection,
            &[
                reading("a", "7-day", NOW - 40 * 24 * HOUR, Some(90.0), false),
                reading("a", "7-day", NOW - 20 * 24 * HOUR, Some(50.0), false),
            ],
            NOW,
        )
        .unwrap();
        let trend = load_limit_trend(&connection, "claude", "7-day", 0, NOW).unwrap();
        assert_eq!(trend[0].readings, vec![(NOW - 20 * 24 * HOUR, 50.0, Some(RESET))]);
    }

    #[test]
    fn thins_to_about_one_an_hour_but_keeps_every_reset() {
        let mut readings = Vec::new();
        // Every 15 minutes for two hours, then a reset.
        for step in 0..8 {
            keep(&mut readings, (step * 15 * 60_000, 100.0 - step as f64, Some(RESET)));
        }
        keep(&mut readings, (8 * 15 * 60_000, 100.0, Some(RESET + 168 * HOUR)));
        let times: Vec<i64> = readings.iter().map(|reading| reading.0 / 60_000).collect();
        assert_eq!(times, vec![0, 45, 90, 105, 120]);
        // The last reading before the reset and the first after both stay.
        assert_eq!(readings[3].1, 93.0);
        assert_eq!(readings[4].2, Some(RESET + 168 * HOUR));
    }
}

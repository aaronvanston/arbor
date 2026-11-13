//! Limit readings over time, for the forecast on Accounts › Limits.
//!
//! The capacity report folds the limit history into cycles; the forecast
//! needs the readings themselves, to draw the pool's trend and to measure how
//! fast it drains between resets. It asks after every refresh, for weeks of
//! every account, so the readings are thinned to about one an hour (every
//! reset and refill kept) and sent as bare tuples grouped by account.

use super::limit_history::ResetKind;
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
/// A rise this big is a refill, which the forecast marks (its
/// `EARLY_REFILL_MIN_PERCENT`): the readings either side of it stay, so it's
/// drawn when it happened and at its size. Anything less is thinned as before,
/// or a limit that wavers by a percent would keep every reading.
const REFILL_MIN_PERCENT: f64 = 5.0;

/// One account's readings of one limit window, oldest first: when it was read,
/// the percent left, and when the window resets.
#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LimitTrendAccount {
    account: String,
    auth_index: String,
    readings: Vec<(i64, f64, Option<i64>)>,
    /// The resets Arbor used that refill this window, oldest first: when the
    /// first reading after each was taken, and which reset it was. Left out
    /// when there are none, as for nearly every account.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    resets_used: Option<Vec<(i64, ResetKind)>>,
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
            "SELECT account, auth_index, sampled_at_ms, remaining_percent, reset_at_ms, reset_used
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
        let reading: (i64, f64, Option<i64>) = (row.get(2).map_err(failed)?, row.get(3).map_err(failed)?, row.get(4).map_err(failed)?);
        // A kind a later version stored reads as none, and the reading stays.
        let used = row.get::<_, Option<String>>(5).map_err(failed)?.as_deref().and_then(ResetKind::parse);
        if accounts.last().is_none_or(|current| current.account != account) {
            accounts.push(LimitTrendAccount { account, auth_index: row.get(1).map_err(failed)?, readings: Vec::new(), resets_used: None });
        }
        if let Some(current) = accounts.last_mut() {
            // Read before thinning, which may drop the reading that names it.
            if let Some(kind) = used {
                current.resets_used.get_or_insert_with(Vec::new).push((reading.0, kind));
            }
            keep(&mut current.readings, reading);
        }
    }
    Ok(accounts)
}

/// Adds a reading, replacing the latest kept one when both fall within the
/// hour of the one before it and belong to the same cycle, so the first and
/// last of every stretch stay. A refill ends a stretch as a reset does: the
/// last reading before it and the first after both stay.
fn keep(readings: &mut Vec<(i64, f64, Option<i64>)>, reading: (i64, f64, Option<i64>)) {
    let same_cycle = |a: Option<i64>, b: Option<i64>| match (a, b) {
        (Some(a), Some(b)) => (a - b).abs() <= SAME_RESET_MS,
        (a, b) => a == b,
    };
    if let [.., before, latest] = readings.as_slice() {
        let refill = reading.1 - latest.1 >= REFILL_MIN_PERCENT || latest.1 - before.1 >= REFILL_MIN_PERCENT;
        if !refill && reading.0 - before.0 < THIN_GAP_MS && same_cycle(before.2, latest.2) && same_cycle(latest.2, reading.2) {
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
            reset_used: None,
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

    #[test]
    fn keeps_the_readings_either_side_of_a_refill() {
        let mut readings = Vec::new();
        // Every 15 minutes: spent down, refilled in the same cycle, spent again.
        for (step, left) in [50.0, 45.0, 95.0, 94.0, 93.0, 92.0].into_iter().enumerate() {
            keep(&mut readings, (step as i64 * 15 * 60_000, left, Some(RESET)));
        }
        let kept: Vec<(i64, f64)> = readings.iter().map(|reading| (reading.0 / 60_000, reading.1)).collect();
        // The low before it and the high after it, where they were read; then thinned as before.
        assert_eq!(kept, vec![(0, 50.0), (15, 45.0), (30, 95.0), (75, 92.0)]);
    }

    #[test]
    fn a_limit_that_wavers_by_a_percent_is_still_thinned() {
        let mut readings = Vec::new();
        // A day of readings 15 minutes apart, up a percent and down again.
        for step in 0..96 {
            keep(&mut readings, (step * 15 * 60_000, 50.0 + (step % 2) as f64, Some(RESET)));
        }
        assert!(readings.len() <= 34, "{} readings kept", readings.len());
    }

    #[test]
    fn says_which_resets_were_used_even_when_their_reading_is_thinned_away() {
        let mut connection = crate::usage::schema::test_database();
        let used = |window: &str, at: i64, remaining: f64, kind: ResetKind| LimitReading { reset_used: Some(kind), ..reading("a", window, at, Some(remaining), false) };
        record_samples(
            &mut connection,
            &[
                reading("a", "7-day", NOW - 3 * HOUR, Some(90.0), false),
                // Nothing rose on this window, and the next reading within the hour replaces it.
                used("7-day", NOW - 3 * HOUR + 60_000, 90.0, ResetKind::Fable),
                reading("a", "7-day", NOW - 3 * HOUR + 20 * 60_000, Some(89.0), false),
                reading("a", "7-day", NOW - 2 * HOUR, Some(20.0), false),
                used("7-day", NOW - HOUR, 100.0, ResetKind::Weekly),
                reading("b", "7-day", NOW - HOUR, Some(80.0), false),
                // Another window's reset says nothing about this one.
                used("5-hour", NOW - HOUR, 100.0, ResetKind::Session),
            ],
            NOW,
        )
        .unwrap();
        connection
            .execute("UPDATE usage_limit_samples SET reset_used = 'later' WHERE account = 'b' AND window_label = '7-day'", [])
            .unwrap();
        let trend = load_limit_trend(&connection, "claude", "7-day", NOW - 10 * HOUR, NOW).unwrap();
        assert_eq!(trend[0].readings.iter().map(|reading| reading.1).collect::<Vec<_>>(), vec![90.0, 89.0, 20.0, 100.0]);
        assert_eq!(trend[0].resets_used, Some(vec![(NOW - 3 * HOUR + 60_000, ResetKind::Fable), (NOW - HOUR, ResetKind::Weekly)]));
        // A kind this version doesn't know is no kind, and its reading still counts.
        assert_eq!(trend[1].readings, vec![(NOW - HOUR, 80.0, Some(RESET))]);
        assert_eq!(trend[1].resets_used, None);
        let sent = serde_json::to_value(&trend).unwrap();
        assert_eq!(sent[0]["resetsUsed"], serde_json::json!([[NOW - 3 * HOUR + 60_000, "fable"], [NOW - HOUR, "weekly"]]));
        assert!(sent[1].get("resetsUsed").is_none());
    }
}

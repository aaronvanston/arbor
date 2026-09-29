//! Per-account limit history.
//!
//! The webview reports every account's limit windows after each quota
//! refresh, and the readings collect here so the capacity report can show how
//! much of each limit is used before it resets. A reading that hasn't changed
//! is kept at most once per [`UNCHANGED_GAP_MS`], and readings older than
//! [`RETENTION_MS`] are dropped.

use super::*;
use ts_rs::TS;
use std::sync::atomic::{AtomicI64, Ordering};

const RETENTION_MS: i64 = 180 * 86_400_000;
/// An unchanged reading is stored again only after this long.
const UNCHANGED_GAP_MS: i64 = 30 * 60_000;
/// Remaining-percent changes smaller than this count as unchanged.
const PERCENT_EPSILON: f64 = 0.5;
/// Reset times computed from a relative countdown drift by seconds between
/// refreshes; a real reset moves them by hours.
const RESET_DRIFT_MS: i64 = 5 * 60_000;
const PRUNE_EVERY_MS: i64 = 86_400_000;
static LAST_PRUNED_AT: AtomicI64 = AtomicI64::new(0);

/// One limit window of one account at one refresh, as the webview reports it.
/// These are kept for months, unlike the 24-hour pooled history behind the
/// sparklines, so the capacity report can show how much of each account's
/// limits gets used before they reset.
#[derive(Clone, Debug, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LimitReading {
    /// The account's app key: credential file name and auth index.
    pub account: String,
    #[serde(default)]
    pub auth_index: String,
    pub provider: String,
    #[serde(default)]
    pub plan: String,
    pub window: String,
    pub remaining_percent: Option<f64>,
    pub reset_at_ms: Option<i64>,
    #[serde(default)]
    pub extra: bool,
    pub sampled_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LimitAccountRename {
    pub from: String,
    pub to: String,
}

/// Drops readings that can't be stored: no account or window, a percentage
/// outside 0 to 100, or a time that isn't plausible.
fn sanitize(sample: &LimitReading, now_ms: i64) -> Option<LimitReading> {
    let account = sample.account.trim();
    let window = sample.window.trim();
    let provider = sample.provider.trim();
    if account.is_empty() || window.is_empty() || provider.is_empty() {
        return None;
    }
    if sample.sampled_at_ms <= 0 || sample.sampled_at_ms > now_ms + 60_000 {
        return None;
    }
    let remaining_percent = match sample.remaining_percent {
        Some(value) if value.is_finite() => Some(value.clamp(0.0, 100.0)),
        Some(_) => return None,
        None => None,
    };
    Some(LimitReading {
        account: account.to_string(),
        auth_index: sample.auth_index.trim().to_string(),
        provider: provider.to_string(),
        plan: sample.plan.trim().to_string(),
        window: window.to_string(),
        remaining_percent,
        reset_at_ms: sample.reset_at_ms.filter(|value| *value > 0),
        extra: sample.extra,
        sampled_at_ms: sample.sampled_at_ms,
    })
}

/// Whether a reading adds anything over the latest one stored for the same
/// account and window.
fn worth_storing(previous: (i64, Option<f64>, Option<i64>), sample: &LimitReading) -> bool {
    let (previous_at, previous_remaining, previous_reset) = previous;
    if sample.sampled_at_ms <= previous_at {
        return false;
    }
    let remaining_changed = match (previous_remaining, sample.remaining_percent) {
        (Some(before), Some(after)) => (before - after).abs() >= PERCENT_EPSILON,
        (None, None) => false,
        _ => true,
    };
    let reset_moved = match (previous_reset, sample.reset_at_ms) {
        (Some(before), Some(after)) => (before - after).abs() > RESET_DRIFT_MS,
        (None, None) => false,
        _ => true,
    };
    remaining_changed || reset_moved || sample.sampled_at_ms - previous_at >= UNCHANGED_GAP_MS
}

/// Stores the readings worth keeping and returns how many were stored.
pub(super) fn record_samples(connection: &mut Connection, samples: &[LimitReading], now_ms: i64) -> Result<usize, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start limit history write: {error}"))?;
    let mut stored = 0;
    {
        let mut latest = transaction
            .prepare(
                "SELECT sampled_at_ms, remaining_percent, reset_at_ms FROM usage_limit_samples
                 WHERE account = ?1 AND window_label = ?2 ORDER BY sampled_at_ms DESC LIMIT 1",
            )
            .map_err(|error| format!("Failed to read limit history: {error}"))?;
        let mut insert = transaction
            .prepare(
                "INSERT INTO usage_limit_samples
                 (sampled_at_ms, provider, account, auth_index, plan, window_label, remaining_percent, reset_at_ms, extra)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )
            .map_err(|error| format!("Failed to prepare limit history write: {error}"))?;
        for sample in samples.iter().filter_map(|sample| sanitize(sample, now_ms)) {
            let previous = latest
                .query_row(params![sample.account, sample.window], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Option<f64>>(1)?, row.get::<_, Option<i64>>(2)?))
                })
                .optional()
                .map_err(|error| format!("Failed to read limit history: {error}"))?;
            if previous.is_some_and(|previous| !worth_storing(previous, &sample)) {
                continue;
            }
            insert
                .execute(params![
                    sample.sampled_at_ms,
                    sample.provider,
                    sample.account,
                    sample.auth_index,
                    sample.plan,
                    sample.window,
                    sample.remaining_percent,
                    sample.reset_at_ms,
                    sample.extra,
                ])
                .map_err(|error| format!("Failed to store limit history: {error}"))?;
            stored += 1;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to store limit history: {error}"))?;
    Ok(stored)
}

/// Deletes readings past the retention window, at most once a day.
pub(super) fn prune_samples(connection: &Connection, now_ms: i64) -> Result<usize, String> {
    let last = LAST_PRUNED_AT.load(Ordering::Relaxed);
    if now_ms - last < PRUNE_EVERY_MS {
        return Ok(0);
    }
    LAST_PRUNED_AT.store(now_ms, Ordering::Relaxed);
    connection
        .execute("DELETE FROM usage_limit_samples WHERE sampled_at_ms < ?1", params![now_ms - RETENTION_MS])
        .map_err(|error| format!("Failed to prune limit history: {error}"))
}

/// Moves history to an account's new key after the core renames its credential file.
pub(super) fn rename_accounts(connection: &mut Connection, renames: &[LimitAccountRename]) -> Result<usize, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start limit history rename: {error}"))?;
    let mut moved = 0;
    for rename in renames {
        let (from, to) = (rename.from.trim(), rename.to.trim());
        if from.is_empty() || to.is_empty() || from == to {
            continue;
        }
        moved += transaction
            .execute("UPDATE usage_limit_samples SET account = ?2 WHERE account = ?1", params![from, to])
            .map_err(|error| format!("Failed to rename limit history: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to rename limit history: {error}"))?;
    Ok(moved)
}

#[tauri::command]
pub(crate) async fn record_limit_samples(samples: Vec<LimitReading>) -> Result<usize, String> {
    if samples.is_empty() {
        return Ok(0);
    }
    run_usage_task(move || {
        let now_ms = Local::now().timestamp_millis();
        let _write_guard = lock_usage_writes();
        let mut connection = open_usage_database()?;
        let stored = record_samples(&mut connection, &samples, now_ms)?;
        prune_samples(&connection, now_ms)?;
        Ok(stored)
    })
    .await
}

#[tauri::command]
pub(crate) async fn rename_limit_history_accounts(renames: Vec<LimitAccountRename>) -> Result<usize, String> {
    if renames.is_empty() {
        return Ok(0);
    }
    run_usage_task(move || {
        let _write_guard = lock_usage_writes();
        rename_accounts(&mut open_usage_database()?, &renames)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(at: i64, remaining: Option<f64>, reset: Option<i64>) -> LimitReading {
        LimitReading {
            account: "claude-a.json::abc123".into(),
            auth_index: "abc123".into(),
            provider: "claude".into(),
            plan: "max".into(),
            window: "7-day window".into(),
            remaining_percent: remaining,
            reset_at_ms: reset,
            extra: false,
            sampled_at_ms: at,
        }
    }

    fn rows(connection: &Connection) -> Vec<(i64, String, Option<f64>, Option<i64>)> {
        let mut statement = connection
            .prepare("SELECT sampled_at_ms, account, remaining_percent, reset_at_ms FROM usage_limit_samples ORDER BY id")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn unchanged_readings_are_thinned_but_changes_and_resets_are_kept() {
        let mut connection = crate::usage::schema::test_database();
        let minute = 60_000;
        let reset = 10 * 86_400_000;
        let now = reset;
        let batch = [
            sample(minute, Some(80.0), Some(reset)),
            // Same reading a few minutes later, and the reset drifting by seconds: skipped.
            sample(5 * minute, Some(80.2), Some(reset + 3_000)),
            // Usage moved: kept.
            sample(10 * minute, Some(71.0), Some(reset)),
            // Unchanged, but half an hour after the last stored reading: kept.
            sample(40 * minute, Some(71.0), Some(reset)),
            // An older reading arriving late: skipped.
            sample(20 * minute, Some(60.0), Some(reset)),
            // The window reset: the reset time jumps a week, kept even though it's soon after.
            sample(41 * minute, Some(71.0), Some(reset + 7 * 86_400_000)),
        ];
        assert_eq!(record_samples(&mut connection, &batch, now).unwrap(), 4);
        let stored: Vec<i64> = rows(&connection).into_iter().map(|row| row.0).collect();
        assert_eq!(stored, vec![minute, 10 * minute, 40 * minute, 41 * minute]);
    }

    #[test]
    fn bad_readings_are_dropped_and_percentages_clamped() {
        let mut connection = crate::usage::schema::test_database();
        let now = 1_000_000;
        let mut blank_account = sample(1_000, Some(50.0), None);
        blank_account.account = "  ".into();
        let mut blank_window = sample(1_000, Some(50.0), None);
        blank_window.window = String::new();
        let batch = [
            blank_account,
            blank_window,
            sample(now + 3_600_000, Some(50.0), None),
            sample(2_000, Some(f64::NAN), None),
            sample(3_000, Some(120.0), Some(-5)),
        ];
        assert_eq!(record_samples(&mut connection, &batch, now).unwrap(), 1);
        assert_eq!(rows(&connection), vec![(3_000, "claude-a.json::abc123".to_string(), Some(100.0), None)]);
    }

    #[test]
    fn renames_move_history_and_pruning_drops_old_readings() {
        let mut connection = crate::usage::schema::test_database();
        let now = RETENTION_MS + 10 * 86_400_000;
        record_samples(&mut connection, &[sample(1_000, Some(90.0), None), sample(now - 1_000, Some(40.0), None)], now).unwrap();
        let renamed = rename_accounts(
            &mut connection,
            &[LimitAccountRename { from: "claude-a.json::abc123".into(), to: "claude-b.json::def456".into() }],
        )
        .unwrap();
        assert_eq!(renamed, 2);
        LAST_PRUNED_AT.store(0, Ordering::Relaxed);
        assert_eq!(prune_samples(&connection, now).unwrap(), 1);
        assert_eq!(rows(&connection), vec![(now - 1_000, "claude-b.json::def456".to_string(), Some(40.0), None)]);
        // A second prune the same day does nothing.
        assert_eq!(prune_samples(&connection, now + 1_000).unwrap(), 0);
    }
}

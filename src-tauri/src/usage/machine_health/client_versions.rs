//! How each agent version's requests went through the proxy, so a new version
//! tried on one machine can be compared with the version the rest still run.
//! Every request records the client's User-Agent, which names the agent and
//! its version (`claude-cli/2.1.282 (external, cli)`, `codex_cli_rs/0.156.1
//! (…)`), and its API key, which names the machine it came from.
//!
//! Requests are counted by hour, machine and User-Agent; the webview reads the
//! versions out of the User-Agents and adds up whichever hours it compares.

use super::*;
use ts_rs::TS;

const HOUR_MS: i64 = 3_600_000;
/// Far more than a week of hours for a fleet's handful of agent versions.
const ROWS_MAX: usize = 50_000;

/// One hour of one client's requests from one machine.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientHour {
    /// The machine its API key is assigned to, or empty for a key that isn't.
    machine: String,
    user_agent: String,
    /// When the hour starts.
    hour_ms: i64,
    requests: u64,
    /// Failed requests, apart from those the client canceled.
    failed: u64,
    /// Of those, the ones refused for a rate limit.
    rate_limited: u64,
}

#[derive(Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientVersions {
    /// Oldest hour first.
    hours: Vec<ClientHour>,
    truncated: bool,
}

fn client_versions(connection: &Connection, from_ms: i64, to_ms: i64, rows_max: usize) -> Result<ClientVersions, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT COALESCE(a.machine, ''), e.user_agent, (e.timestamp_ms / {HOUR_MS}) * {HOUR_MS} AS hour_ms,
                    COUNT(*),
                    SUM(e.failed = 1 AND e.canceled = 0),
                    SUM(e.failed = 1 AND e.canceled = 0 AND e.failure_status = 429)
             FROM usage_events e LEFT JOIN usage_machine_assignments a ON a.api_key_hash = e.api_key_hash
             WHERE e.timestamp_ms >= ?1 AND e.timestamp_ms < ?2
               AND (e.user_agent LIKE 'claude-cli/%' OR e.user_agent LIKE 'codex%')
             GROUP BY 1, 2, 3
             ORDER BY hour_ms DESC
             LIMIT {}",
            rows_max + 1
        ))
        .map_err(|error| format!("Failed to prepare agent versions' requests: {error}"))?;
    let mut hours = statement
        .query_map(params![from_ms, to_ms], |row| {
            Ok(ClientHour {
                machine: row.get(0)?,
                user_agent: row.get(1)?,
                hour_ms: row.get(2)?,
                requests: row.get::<_, i64>(3)?.max(0) as u64,
                failed: row.get::<_, i64>(4)?.max(0) as u64,
                rate_limited: row.get::<_, i64>(5)?.max(0) as u64,
            })
        })
        .map_err(|error| format!("Failed to read agent versions' requests: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read agent versions' requests: {error}"))?;
    // Past the limit the latest hours are kept, since they say most about a new version, less the oldest one kept,
    // which may be missing some of its rows.
    let truncated = hours.len() > rows_max;
    if truncated {
        let oldest = hours.last().map_or(0, |hour| hour.hour_ms);
        hours.retain(|hour| hour.hour_ms > oldest);
    }
    hours.sort_by(|a, b| a.hour_ms.cmp(&b.hour_ms).then_with(|| a.machine.cmp(&b.machine)).then_with(|| a.user_agent.cmp(&b.user_agent)));
    Ok(ClientVersions { hours, truncated })
}

/// Agents' requests through the proxy in the window, by hour, machine and client.
#[tauri::command]
pub(crate) async fn get_client_versions(from_ms: i64, to_ms: i64) -> Result<ClientVersions, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open_usage_database()?;
        client_versions(&connection, from_ms, to_ms, ROWS_MAX)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::schema::insert_request;

    fn database() -> Connection {
        let connection = crate::usage::schema::test_database();
        connection
            .execute_batch("INSERT INTO usage_machine_assignments (api_key_hash, machine) VALUES ('k-mbp', 'mbp'), ('k-cedar', 'cedar');")
            .unwrap();
        connection
    }

    fn request(connection: &Connection, at_ms: i64, key: &str, user_agent: Option<&str>, status: i64, canceled: bool) {
        insert_request(
            connection,
            "timestamp_ms, api_key_hash, user_agent, failed, canceled, failure_status",
            params![at_ms, key, user_agent, i64::from(status != 0), i64::from(canceled), status],
        );
    }

    #[test]
    fn agents_requests_are_counted_by_hour_machine_and_client() {
        let connection = database();
        let new = "claude-cli/2.1.283 (external, cli)";
        let old = "claude-cli/2.1.282 (external, cli)";
        let codex = "codex_cli_rs/0.156.1 (Mac OS 26.0.0; arm64) iTerm.app/3.5";
        request(&connection, 10 * HOUR_MS + 5, "k-mbp", Some(new), 0, false);
        request(&connection, 10 * HOUR_MS + 9, "k-mbp", Some(new), 429, false);
        request(&connection, 10 * HOUR_MS + 20, "k-mbp", Some(new), 500, false);
        // Pressing Escape isn't the version's fault.
        request(&connection, 10 * HOUR_MS + 30, "k-mbp", Some(new), 499, true);
        request(&connection, 11 * HOUR_MS, "k-mbp", Some(new), 0, false);
        request(&connection, 10 * HOUR_MS + 1, "k-cedar", Some(old), 0, false);
        request(&connection, 10 * HOUR_MS + 2, "k-other", Some(codex), 0, false);
        // Not an agent's, and no User-Agent at all.
        request(&connection, 10 * HOUR_MS + 3, "k-mbp", Some("curl/8.7.1"), 0, false);
        request(&connection, 10 * HOUR_MS + 4, "k-mbp", None, 0, false);
        // Outside the window.
        request(&connection, 12 * HOUR_MS, "k-mbp", Some(new), 0, false);

        let versions = client_versions(&connection, 10 * HOUR_MS, 12 * HOUR_MS, ROWS_MAX).unwrap();
        let rows: Vec<(&str, &str, i64, u64, u64, u64)> = versions
            .hours
            .iter()
            .map(|hour| (hour.machine.as_str(), hour.user_agent.as_str(), hour.hour_ms / HOUR_MS, hour.requests, hour.failed, hour.rate_limited))
            .collect();
        assert_eq!(rows, [("", codex, 10, 1, 0, 0), ("cedar", old, 10, 1, 0, 0), ("mbp", new, 10, 4, 2, 1), ("mbp", new, 11, 1, 0, 0)]);
        assert!(!versions.truncated);
    }

    #[test]
    fn past_the_limit_the_latest_whole_hours_are_kept() {
        let connection = database();
        for hour in 0..4 {
            request(&connection, hour * HOUR_MS, "k-mbp", Some("claude-cli/2.1.283"), 0, false);
            request(&connection, hour * HOUR_MS, "k-cedar", Some("claude-cli/2.1.282"), 0, false);
        }
        // Five rows fit: hours 3 and 2 whole, and one of hour 1's two, which is dropped.
        let versions = client_versions(&connection, 0, 4 * HOUR_MS, 5).unwrap();
        let hours: Vec<(i64, &str)> = versions.hours.iter().map(|hour| (hour.hour_ms / HOUR_MS, hour.machine.as_str())).collect();
        assert_eq!(hours, [(2, "cedar"), (2, "mbp"), (3, "cedar"), (3, "mbp")]);
        assert!(versions.truncated);
    }
}

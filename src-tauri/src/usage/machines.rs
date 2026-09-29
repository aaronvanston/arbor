use super::*;
use ts_rs::TS;

#[derive(Clone, Serialize, Deserialize, TS)]
pub(crate) struct MachineAssignment {
    pub api_key_hash: String,
    pub label: String,
    pub machine: String,
    pub pool: String,
}

pub(super) fn load_assignments(
    connection: &Connection,
    config: &GuiConfigFile,
) -> Result<Vec<MachineAssignment>, String> {
    // Include retired keys so historical requests can still be attributed, each
    // named as its latest request was. Most reads start here, so it steps from
    // key to key on idx_usage_events_api_key_timestamp, two lookups a key,
    // instead of grouping every request.
    let mut keys = HashMap::new();
    let mut statement = connection
        .prepare(
            "WITH RECURSIVE keys(hash) AS (
                 SELECT MIN(api_key_hash) FROM usage_events WHERE api_key_hash > ''
                 UNION ALL
                 SELECT (SELECT MIN(api_key_hash) FROM usage_events WHERE api_key_hash > keys.hash) FROM keys WHERE hash IS NOT NULL
             )
             SELECT hash, (SELECT api_key_remark FROM usage_events WHERE api_key_hash = keys.hash ORDER BY timestamp_ms DESC LIMIT 1)
             FROM keys WHERE hash IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (hash, label) = row.map_err(|e| e.to_string())?;
        keys.insert(hash, label);
    }
    for entry in config.api_keys.iter().chain(&config.paused_api_keys) {
        keys.insert(hash_text(&entry.key), entry.remark.clone());
    }
    // Only a new key or a new name is written, so a read doesn't take the write lock from the collector.
    let assignments = read_assignments(connection)?;
    let known = assignments
        .iter()
        .map(|assignment| (assignment.api_key_hash.as_str(), assignment.label.as_str()))
        .collect::<HashMap<_, _>>();
    let changed = keys
        .into_iter()
        .filter(|(hash, label)| known.get(hash.as_str()) != Some(&label.as_str()))
        .collect::<Vec<_>>();
    if changed.is_empty() {
        return Ok(assignments);
    }
    // A new key starts with no machine or pool; they're set on the key.
    for (hash, label) in changed {
        connection.execute(
            "INSERT INTO usage_machine_assignments(api_key_hash,label,machine,pool) VALUES (?1,?2,'','') ON CONFLICT(api_key_hash) DO UPDATE SET label=excluded.label WHERE label != excluded.label",
            params![hash, label],
        ).map_err(|e| e.to_string())?;
    }
    read_assignments(connection)
}

/// Drops assignments for retired keys once retention has removed every request
/// they could attribute. Keys still in the config, paused ones included, keep
/// their row, so their machine and pool survive a quiet spell.
pub(super) fn remove_orphaned_assignments(
    connection: &Connection,
    config: &GuiConfigFile,
) -> Result<usize, String> {
    let configured: HashSet<String> = config
        .api_keys
        .iter()
        .chain(&config.paused_api_keys)
        .map(|entry| hash_text(&entry.key))
        .collect();
    let mut statement = connection.prepare("SELECT api_key_hash FROM usage_machine_assignments a WHERE NOT EXISTS (SELECT 1 FROM usage_events e WHERE e.api_key_hash = a.api_key_hash)").map_err(|e| e.to_string())?;
    let orphaned = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut removed = 0;
    for hash in orphaned.iter().filter(|hash| !configured.contains(*hash)) {
        removed += connection
            .execute(
                "DELETE FROM usage_machine_assignments WHERE api_key_hash = ?1",
                params![hash],
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(removed)
}

pub(super) fn read_assignments(connection: &Connection) -> Result<Vec<MachineAssignment>, String> {
    let mut statement = connection.prepare("SELECT api_key_hash,label,machine,pool FROM usage_machine_assignments ORDER BY label,api_key_hash").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |r| {
            Ok(MachineAssignment {
                api_key_hash: r.get(0)?,
                label: r.get(1)?,
                machine: r.get(2)?,
                pool: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn get_usage_machine_assignments(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<MachineAssignment>, String> {
    let config = gui_config_state.snapshot()?;
    run_usage_task(move || load_assignments(&open_usage_database()?, &config)).await
}

#[tauri::command]
pub(crate) async fn save_usage_machine_assignments(
    assignments: Vec<MachineAssignment>,
) -> Result<(), String> {
    run_usage_task(move || {
        let mut connection = open_usage_database()?;
        let transaction = connection.transaction().map_err(|e| e.to_string())?;
        for assignment in assignments {
            if assignment.machine.trim().len() > 100 || assignment.pool.trim().len() > 100 {
                return Err("Machine and pool names must be 100 bytes or fewer".into());
            }
            if assignment.machine.trim() == "__unassigned__"
                || assignment.pool.trim() == "__unassigned__"
            {
                return Err("That name is reserved for the unassigned filter".into());
            }
            let changed = transaction
                .execute(
                    "UPDATE usage_machine_assignments SET machine=?1,pool=?2 WHERE api_key_hash=?3",
                    params![
                        assignment.machine.trim(),
                        assignment.pool.trim(),
                        assignment.api_key_hash
                    ],
                )
                .map_err(|e| e.to_string())?;
            if changed != 1 {
                return Err("Unknown key assignment; refresh and try again".into());
            }
        }
        transaction.commit().map_err(|e| e.to_string())
    })
    .await
}

#[derive(Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineUsage {
    machine: String,
    pool: String,
    requests: u64,
    tokens: u64,
    success: u64,
    failures: u64,
    canceled: u64,
    last_request: Option<String>,
}

/// A key's requests, summed for the machine breakdown.
#[derive(Default)]
pub(super) struct KeyUsage {
    requests: i64,
    tokens: i64,
    success: i64,
    failures: i64,
    canceled: i64,
    last_request: Option<String>,
}

impl KeyUsage {
    pub(super) fn add(&mut self, tokens: i64, failed: bool, canceled: bool, timestamp: rusqlite::types::ValueRef<'_>) {
        self.requests += 1;
        self.tokens = self.tokens.saturating_add(tokens);
        self.success += i64::from(!failed);
        self.failures += i64::from(failed && !canceled);
        self.canceled += i64::from(canceled);
        cost_groups::keep_max_text(&mut self.last_request, timestamp);
    }
}

/// Adds a request to the sums of the key it was sent with.
pub(super) fn key_usage<'a>(by_key: &'a mut HashMap<String, KeyUsage>, hash: &str) -> &'a mut KeyUsage {
    if !by_key.contains_key(hash) {
        by_key.insert(hash.to_string(), KeyUsage::default());
    }
    by_key.get_mut(hash).expect("inserted above")
}

/// Each key's sums added up by the machine and pool it's assigned to, most
/// tokens first. Summing by key and then by machine is the same as grouping
/// the requests joined to their machines, without SQL sorting all of them.
pub(super) fn usage_by_machine(connection: &Connection, by_key: HashMap<String, KeyUsage>) -> Result<Vec<MachineUsage>, String> {
    let places = read_assignments(connection)?
        .into_iter()
        .map(|assignment| (assignment.api_key_hash, (assignment.machine, assignment.pool)))
        .collect::<HashMap<_, _>>();
    let mut machines = std::collections::BTreeMap::<(String, String), KeyUsage>::new();
    for (hash, sums) in by_key {
        let place = places.get(&hash).cloned().unwrap_or_default();
        let machine = machines.entry(place).or_default();
        machine.requests += sums.requests;
        machine.tokens = machine.tokens.saturating_add(sums.tokens);
        machine.success += sums.success;
        machine.failures += sums.failures;
        machine.canceled += sums.canceled;
        if sums.last_request > machine.last_request {
            machine.last_request = sums.last_request;
        }
    }
    let mut usage = machines
        .into_iter()
        .map(|((machine, pool), sums)| MachineUsage {
            machine,
            pool,
            requests: from_sql_i64(sums.requests),
            tokens: from_sql_i64(sums.tokens),
            success: from_sql_i64(sums.success),
            failures: from_sql_i64(sums.failures),
            canceled: from_sql_i64(sums.canceled),
            last_request: sums.last_request,
        })
        .collect::<Vec<_>>();
    // The sort keeps machines with the same count in name order.
    usage.sort_by(|left, right| right.tokens.cmp(&left.tokens));
    Ok(usage)
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineLive {
    machine: String,
    tokens: [u64; 12],
    requests: u64,
}

pub(super) fn live_usage(connection: &Connection, query: &UsageQuery, now_ms: i64) -> Result<Vec<MachineLive>, String> {
    let end = now_ms / 5000 * 5000;
    let start = end - 60_000;
    let mut live_query = query.clone();
    live_query.start = None;
    live_query.end = None;
    let mut filter = build_usage_filter(&live_query);
    filter.clause.push_str(if filter.clause.is_empty() { " WHERE " } else { " AND " });
    filter.clause.push_str("timestamp_ms + latency_ms >= ? AND timestamp_ms + latency_ms < ?");
    filter.params.push(SqlValue::Integer(start));
    filter.params.push(SqlValue::Integer(end));
    let sql = format!("SELECT COALESCE(a.machine,''), (e.timestamp_ms + e.latency_ms - {start}) / 5000, SUM(e.total_tokens), COUNT(*) FROM (SELECT * FROM usage_events{}) e LEFT JOIN usage_machine_assignments a ON e.api_key_hash=a.api_key_hash GROUP BY 1,2", filter.clause);
    let mut machines = std::collections::BTreeMap::<String, MachineLive>::new();
    for assignment in read_assignments(connection)? {
        if assignment.machine.is_empty() { continue; }
        if let Some(name) = query.machine.as_deref().filter(|v| !v.is_empty()) {
            if name != assignment.machine { continue; }
        }
        machines.entry(assignment.machine.clone()).or_insert(MachineLive { machine: assignment.machine, tokens: [0; 12], requests: 0 });
    }
    let mut statement = connection.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = statement.query_map(params_from_iter(filter.params.iter()), |r| Ok((r.get::<_,String>(0)?, r.get::<_,usize>(1)?, from_sql_i64(r.get(2)?), from_sql_i64(r.get(3)?)))).map_err(|e| e.to_string())?;
    for row in rows {
        let (machine, bucket, tokens, requests) = row.map_err(|e| e.to_string())?;
        let item = machines.entry(machine.clone()).or_insert(MachineLive { machine, tokens: [0; 12], requests: 0 });
        if bucket < 12 { item.tokens[bucket] = tokens; item.requests += requests; }
    }
    Ok(machines.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_throughput_uses_completion_time_and_fixed_buckets() {
        let connection = schema::test_database();
        connection.execute("INSERT INTO usage_machine_assignments VALUES ('a','one','Machine A',''),('b','two','Machine A',''),('c','idle','Machine B','')", []).unwrap();
        for (index, (hash, timestamp, latency, tokens)) in [
            ("a", 60_000, 0, 100), ("b", 119_999, 0, 200),
            ("a", 1_000, 60_000, 300), ("a", 59_999, 0, 900),
            ("a", 120_000, 0, 900),
        ].iter().enumerate() {
            connection.execute("INSERT INTO usage_events(event_key,timestamp,timestamp_ms,latency_ms,local_hour,created_at,api_key_hash,total_tokens) VALUES (?1,'1970-01-01T00:00:00Z',?2,?3,'hour','now',?4,?5)",params![index.to_string(),timestamp,latency,hash,tokens]).unwrap();
        }
        let query = UsageQuery { start: Some("2099-01-01T00:00:00Z".into()), end: Some("2099-01-02T00:00:00Z".into()), ..Default::default() };
        let live = live_usage(&connection, &query, 123_456).unwrap();
        assert_eq!(live.len(), 2);
        assert_eq!(live[0].tokens[0], 400);
        assert_eq!(live[0].tokens[11], 200);
        assert_eq!(live[0].tokens.iter().sum::<u64>(), 600);
        assert_eq!(live[0].requests, 3);
        assert_eq!(live[1].requests, 0);
        let filtered = live_usage(&connection, &UsageQuery { machine: Some("Machine B".into()), ..Default::default() }, 123_456).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].tokens, [0; 12]);
    }

    #[test]
    fn request_rows_keep_unique_ids_when_event_keys_repeat() {
        let connection = schema::test_database();
        for _ in 0..2 {
            connection.execute("INSERT INTO usage_events(event_key,timestamp,timestamp_ms,local_hour,created_at) VALUES ('repeated','2026-09-09T00:00:00Z',1,'2026-09-09-00','now')", []).unwrap();
        }
        let events = load_usage_events(&connection, &UsageQuery::default(), &GuiConfigFile::default()).unwrap();
        assert_eq!(events.items.len(), 2);
        assert_ne!(events.items[0].id, events.items[1].id);
    }

    #[test]
    fn machine_assignments_cover_history_and_filters_without_overwriting_edits() {
        let connection = schema::test_database();
        for (key, label, count) in [
            ("studio-hash", "codex-studio", 23),
            ("build-hash", "remote-build-box", 2),
            ("unknown-hash", "Other", 1),
            ("", "", 1),
        ] {
            for index in 0..count {
                connection.execute("INSERT INTO usage_events(event_key,timestamp,timestamp_ms,local_hour,created_at,api_key_hash,api_key_remark,total_tokens) VALUES (?1,'2026-09-09T00:00:00Z',1,'2026-09-09-00','now',?2,?3,100)",params![format!("{key}-{index}"),key,label]).unwrap();
            }
        }
        let config = GuiConfigFile::default();
        let initial = load_assignments(&connection, &config).unwrap();
        // A new key starts unassigned; its machine and pool are set on the key.
        assert!(initial.iter().all(|a| a.machine.is_empty() && a.pool.is_empty()));
        connection.execute("UPDATE usage_machine_assignments SET machine='Studio',pool='Local' WHERE api_key_hash='studio-hash'", []).unwrap();
        connection.execute("UPDATE usage_machine_assignments SET machine='Build box',pool='Remote' WHERE api_key_hash='build-hash'", []).unwrap();
        let query = UsageQuery {
            pool: Some("Local".into()),
            page_size: Some(1),
            ..Default::default()
        };
        let events = load_usage_events(&connection, &query, &config).unwrap();
        assert_eq!(events.total, 23);
        assert_eq!(events.items.len(), 20);
        assert_eq!(events.items[0].machine, "Studio");
        let filter = build_usage_filter(&query);
        let tokens: i64 = connection
            .query_row(
                &format!(
                    "SELECT SUM(total_tokens) FROM usage_events{}",
                    filter.clause
                ),
                params_from_iter(filter.params.iter()),
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tokens, 2300);
        let overview = load_usage_overview(&connection, &query).unwrap();
        assert_eq!(overview.machines.len(), 1);
        assert_eq!(overview.machines[0].tokens, 2300);
        assert_eq!(overview.machines[0].requests, 23);
        assert_eq!(overview.machines.iter().map(|m| m.tokens).sum::<u64>(), overview.total_tokens);
        let all = load_usage_overview(&connection, &UsageQuery::default()).unwrap();
        assert_eq!(all.machines.iter().map(|m| m.requests).sum::<u64>(), all.total_requests);
        assert_eq!(all.machines.len(), 3);

        connection.execute("UPDATE usage_machine_assignments SET machine='',pool='Shared' WHERE api_key_hash='studio-hash'",[]).unwrap();
        connection
            .execute(
                "UPDATE usage_events SET api_key_remark='renamed' WHERE api_key_hash='studio-hash'",
                [],
            )
            .unwrap();
        let refreshed = load_assignments(&connection, &config).unwrap();
        let studio = refreshed
            .iter()
            .find(|a| a.api_key_hash == "studio-hash")
            .unwrap();
        assert_eq!(
            (&*studio.machine, &*studio.pool, &*studio.label),
            ("", "Shared", "renamed")
        );
        let unknown = UsageQuery {
            machine: Some("__unassigned__".into()),
            ..Default::default()
        };
        assert_eq!(
            load_usage_events(&connection, &unknown, &config)
                .unwrap()
                .total,
            25
        );
        let shared = load_usage_overview(&connection, &unknown).unwrap();
        assert_eq!(shared.machines.iter().map(|m| m.requests).sum::<u64>(), 25);
        assert!(shared.machines.iter().all(|m| m.machine.is_empty()));
        let empty = load_usage_overview(&connection, &UsageQuery { pool: Some("Missing".into()), ..Default::default() }).unwrap();
        assert!(empty.machines.is_empty());
        let injection = UsageQuery {
            pool: Some("Shared' OR 1=1 --".into()),
            ..Default::default()
        };
        assert_eq!(
            load_usage_events(&connection, &injection, &config)
                .unwrap()
                .total,
            0
        );
    }

    #[test]
    fn assignments_name_each_key_as_its_latest_request_did_and_reading_them_again_writes_nothing() {
        let connection = schema::test_database();
        for (index, (key, remark, at_ms)) in [
            ("studio-hash", "zeta", 1),
            ("studio-hash", "codex-studio", 2),
            ("build-hash", "remote-build-box", 1),
            ("", "", 3),
        ]
        .iter()
        .enumerate()
        {
            connection.execute("INSERT INTO usage_events(event_key,timestamp,timestamp_ms,local_hour,created_at,api_key_hash,api_key_remark) VALUES (?1,'',?2,'','',?3,?4)", params![index.to_string(), at_ms, key, remark]).unwrap();
        }
        let config = GuiConfigFile::default();
        let first = load_assignments(&connection, &config).unwrap();
        // The default config's own key is listed too.
        let named = first
            .iter()
            .filter(|a| a.api_key_hash.ends_with("-hash"))
            .map(|a| (&*a.api_key_hash, &*a.label, &*a.machine))
            .collect::<Vec<_>>();
        // Renamed after its first request: the later name, not the one that sorts last.
        assert_eq!(named, [("studio-hash", "codex-studio", ""), ("build-hash", "remote-build-box", "")]);

        // Nothing new, so nothing to write: it reads even where writing isn't allowed.
        connection.pragma_update(None, "query_only", true).unwrap();
        let again = load_assignments(&connection, &config).unwrap();
        assert_eq!(again.len(), first.len());
    }
}

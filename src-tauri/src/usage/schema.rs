//! usage.db's tables, built by one ordered list of steps. `PRAGMA user_version`
//! is the last step a database has had, and the first time anything opens it in
//! a launch the rest run, in order (see `open_usage_database_at`). A new table,
//! column or index is a new step at the end of `STEPS`; nothing else creates or
//! alters a table.
//!
//! A step runs again if the app stops before its version is written, so each is
//! safe to repeat: tables and indexes `IF NOT EXISTS`, columns added only when
//! missing, backfills marked done in `usage_metadata`. Versions 1–6 came before
//! the list, when every launch set the records tables up again and each feature
//! made its own table the first time it was used, so the steps from 7 take
//! whatever shape those left. A database a newer Arbor has taken further is used
//! as it is, since steps only ever add.

use super::*;

pub(super) const USAGE_DATABASE_MIGRATION_KEY: &str = "keeper_v3";
pub(super) const USAGE_FAILURE_MIGRATION_KEY: &str = "failure_details_v4";
pub(super) const USAGE_EVENT_KEY_MIGRATION_KEY: &str = "event_key_v5";
pub(super) const USAGE_SESSION_MIGRATION_KEY: &str = "session_lineage_v6";

struct Step {
    version: i64,
    /// Says which step failed, when one does.
    name: &'static str,
    apply: fn(&mut Connection, &Path) -> Result<(), String>,
}

const STEPS: &[Step] = &[
    Step { version: 7, name: "usage records", apply: usage_records },
    Step { version: 8, name: "machine hosts", apply: machine_hosts },
    Step { version: 9, name: "limit history", apply: limit_history },
    Step { version: 10, name: "pull requests", apply: pull_requests },
    Step { version: 11, name: "session transcripts", apply: session_transcripts },
    Step { version: 12, name: "agent telemetry", apply: agent_telemetry },
    Step { version: 13, name: "diagnostics", apply: diagnostics },
    Step { version: 14, name: "credential index", apply: credential_index },
    Step { version: 15, name: "failures index", apply: failures_index },
    Step { version: 16, name: "agent homes", apply: agent_homes },
    Step { version: 17, name: "machine pools", apply: machine_pools },
    Step { version: 18, name: "automations", apply: automations },
    Step { version: 19, name: "harness runs", apply: harness_runs },
    Step { version: 20, name: "pool ssh names", apply: pool_ssh_names },
    Step { version: 21, name: "agent home roles", apply: agent_home_roles },
];

/// The version of a database that has had every step.
#[cfg(test)]
pub(super) const LATEST: i64 = STEPS[STEPS.len() - 1].version;

/// Runs the steps `connection` hasn't had, in order, noting each as it
/// finishes. `root` is where a step that rewrites the database first keeps a
/// copy of it.
pub(super) fn migrate(connection: &mut Connection, root: &Path) -> Result<(), String> {
    let had: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("Failed to read the usage history version: {error}"))?;
    for step in STEPS.iter().filter(|step| step.version > had) {
        (step.apply)(connection, root)
            .map_err(|error| format!("Failed to update usage history ({}): {error}", step.name))?;
        connection
            .pragma_update(None, "user_version", step.version)
            .map_err(|error| format!("Failed to update the usage history version: {error}"))?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UsageDatabaseLayout {
    Empty,
    LegacyV2,
    CurrentV3,
}

#[derive(Debug, Eq, PartialEq)]
struct UsageMigrationSnapshot {
    records: i64,
    input_tokens: i64,
    output_tokens: i64,
    reasoning_tokens: i64,
    cache_read_tokens: i64,
    cache_creation_tokens: i64,
    total_tokens: i64,
    successes: i64,
    failures: i64,
    first_timestamp: Option<String>,
    last_timestamp: Option<String>,
}

// ---------------------------------------------------------------------------
// Step 7: the records tables, from any shape Arbor or EasyCLIProxyAPI left them in
// ---------------------------------------------------------------------------

/// The records tables, from whichever layout the database is in.
fn usage_records(connection: &mut Connection, root: &Path) -> Result<(), String> {
    match detect_usage_database_layout(connection)? {
        UsageDatabaseLayout::Empty => initialize_usage_schema(connection),
        UsageDatabaseLayout::CurrentV3 => {
            initialize_usage_schema(connection)?;
            migrate_usage_event_key_uniqueness(connection)
        }
        UsageDatabaseLayout::LegacyV2 => {
            let backup_path = create_usage_migration_backup(connection, root)?;
            if let Err(error) = migrate_legacy_v2_usage_schema(connection) {
                return Err(format!(
                    "Failed to migrate legacy usage history database, backup retained at {}: {error}",
                    backup_path.display()
                ));
            }
            initialize_usage_schema(connection)
        }
    }
}

fn detect_usage_database_layout(connection: &Connection) -> Result<UsageDatabaseLayout, String> {
    if !usage_table_exists(connection, "usage_events")? {
        return Ok(UsageDatabaseLayout::Empty);
    }
    let columns = usage_table_columns(connection, "usage_events")?;
    let legacy_columns = [
        "event_key",
        "timestamp_ms",
        "local_hour",
        "api_key_hash",
        "api_key_display",
        "api_key_remark",
    ];
    if !legacy_columns
        .iter()
        .all(|column| columns.contains(*column))
    {
        return Err("Unrecognized usage history database schema, automatic migration refused".to_string());
    }
    let keeper_columns = [
        "api_group_key",
        "model_alias",
        "client_ip",
        "x_forwarded_for",
        "user_agent",
        "generate",
        "cached_tokens",
        "collector_source",
    ];
    let keeper_column_count = keeper_columns
        .iter()
        .filter(|column| columns.contains(**column))
        .count();
    if keeper_column_count == 0 && !usage_table_exists(connection, "usage_inbox")? {
        return Ok(UsageDatabaseLayout::LegacyV2);
    }
    if keeper_column_count == keeper_columns.len()
        && usage_table_exists(connection, "usage_inbox")?
        && usage_table_exists(connection, "usage_aggregation_checkpoints")?
    {
        return Ok(UsageDatabaseLayout::CurrentV3);
    }
    Err("Incomplete usage history database migration detected, further changes refused".to_string())
}

fn usage_table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            params![table],
            |row| row.get::<_, i64>(0),
        )
        .map(|exists| exists != 0)
        .map_err(|error| format!("Failed to check SQLite table {table}: {error}"))
}

fn usage_table_columns(connection: &Connection, table: &str) -> Result<HashSet<String>, String> {
    let mut statement = connection
        .prepare("SELECT name FROM pragma_table_info(?1)")
        .map_err(|error| format!("Failed to prepare to read SQLite table schema {table}: {error}"))?;
    let columns = statement
        .query_map(params![table], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Failed to read SQLite table schema {table}: {error}"))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("Failed to parse SQLite table schema {table}: {error}"))?;
    Ok(columns)
}

fn migrate_usage_event_key_uniqueness(connection: &mut Connection) -> Result<(), String> {
    let migrated = connection
        .query_row(
            "SELECT value FROM usage_metadata WHERE key = ?1",
            params![USAGE_EVENT_KEY_MIGRATION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("read usage event key migration state failed: {error}"))?;
    if migrated.is_some() {
        return Ok(());
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("begin usage event key migration failed: {error}"))?;
    make_usage_event_key_non_unique(&transaction)?;
    transaction
        .execute(
            "INSERT INTO usage_metadata (key, value) VALUES (?1, ?2)",
            params![USAGE_EVENT_KEY_MIGRATION_KEY, Local::now().to_rfc3339()],
        )
        .map_err(|error| format!("record usage event key migration state failed: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("commit usage event key migration failed: {error}"))
}

fn make_usage_event_key_non_unique(connection: &Connection) -> Result<(), String> {
    if !usage_table_exists(connection, "usage_events")? {
        return Ok(());
    }

    let unique_indexes = usage_event_key_unique_indexes(connection)?;
    if unique_indexes.is_empty() {
        create_usage_event_key_index(connection)?;
        return Ok(());
    }

    if unique_indexes
        .iter()
        .all(|(_, is_auto_index)| !is_auto_index)
    {
        for (index_name, _) in unique_indexes {
            connection
                .execute(
                    &format!(
                        "DROP INDEX IF EXISTS {}",
                        quote_sqlite_identifier(&index_name)
                    ),
                    [],
                )
                .map_err(|error| {
                    format!("drop unique usage event key index {index_name} failed: {error}")
                })?;
        }
        create_usage_event_key_index(connection)?;
        return Ok(());
    }

    rebuild_usage_events_without_event_key_unique(connection, &unique_indexes)
}

fn usage_event_key_unique_indexes(connection: &Connection) -> Result<Vec<(String, bool)>, String> {
    let index_names = {
        let mut statement = connection
            .prepare("SELECT name FROM pragma_index_list(?1) WHERE \"unique\" != 0 ORDER BY seq")
            .map_err(|error| format!("prepare usage event key index query failed: {error}"))?;
        let index_names = statement
            .query_map(params!["usage_events"], |row| row.get::<_, String>(0))
            .map_err(|error| format!("query usage event key indexes failed: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read usage event key indexes failed: {error}"))?;
        index_names
    };

    let mut matches = Vec::new();
    for index_name in index_names {
        let mut statement = connection
            .prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")
            .map_err(|error| format!("prepare usage event key index columns failed: {error}"))?;
        let columns = statement
            .query_map(params![index_name.as_str()], |row| row.get::<_, String>(0))
            .map_err(|error| format!("query usage event key index columns failed: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read usage event key index columns failed: {error}"))?;
        if columns.len() == 1 && columns[0] == "event_key" {
            matches.push((
                index_name.clone(),
                index_name.starts_with("sqlite_autoindex_"),
            ));
        }
    }
    Ok(matches)
}

fn rebuild_usage_events_without_event_key_unique(
    connection: &Connection,
    unique_indexes: &[(String, bool)],
) -> Result<(), String> {
    let table_sql = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params!["usage_events"],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("read usage events table schema failed: {error}"))?;
    let temporary_table = format!("usage_events_rebuild_{}", unique_file_stamp());
    let create_table_sql = replace_sql_fragment_case_insensitive(
        &table_sql,
        "create table usage_events",
        &format!("CREATE TABLE {temporary_table}"),
    )
    .or_else(|| {
        replace_sql_fragment_case_insensitive(
            &table_sql,
            "create table if not exists usage_events",
            &format!("CREATE TABLE {temporary_table}"),
        )
    })
    .ok_or_else(|| "usage events table schema has an unsupported CREATE TABLE form".to_string())?;
    let create_table_sql = replace_sql_fragment_case_insensitive(
        &create_table_sql,
        "event_key text not null unique",
        "event_key TEXT NOT NULL",
    )
    .ok_or_else(|| {
        "usage events table schema does not contain the expected unique event_key constraint"
            .to_string()
    })?;

    let unique_index_names = unique_indexes
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<HashSet<_>>();
    let index_sqls = {
        let mut statement = connection
            .prepare(
                "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?1 AND sql IS NOT NULL ORDER BY name",
            )
            .map_err(|error| format!("prepare usage event index schema query failed: {error}"))?;
        let index_sqls = statement
            .query_map(params!["usage_events"], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("query usage event index schemas failed: {error}"))?
            .filter_map(|row| match row {
                Ok((name, sql)) if !unique_index_names.contains(name.as_str()) => Some(Ok(sql)),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read usage event index schemas failed: {error}"))?;
        index_sqls
    };

    connection
        .execute_batch(&create_table_sql)
        .map_err(|error| format!("create rebuilt usage events table failed: {error}"))?;
    connection
        .execute(
            &format!(
                "INSERT INTO {} SELECT * FROM usage_events",
                quote_sqlite_identifier(&temporary_table)
            ),
            [],
        )
        .map_err(|error| format!("copy usage events during event key migration failed: {error}"))?;
    connection
        .execute("DROP TABLE usage_events", [])
        .map_err(|error| format!("drop old usage events table failed: {error}"))?;
    connection
        .execute(
            &format!(
                "ALTER TABLE {} RENAME TO usage_events",
                quote_sqlite_identifier(&temporary_table)
            ),
            [],
        )
        .map_err(|error| format!("rename rebuilt usage events table failed: {error}"))?;

    for index_sql in index_sqls {
        connection
            .execute_batch(&index_sql)
            .map_err(|error| format!("restore usage event index failed: {error}"))?;
    }
    create_usage_event_key_index(connection)
}

fn create_usage_event_key_index(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_events_event_key ON usage_events(event_key)",
            [],
        )
        .map(|_| ())
        .map_err(|error| format!("create usage event key index failed: {error}"))
}

pub(super) fn quote_sqlite_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub(super) fn replace_sql_fragment_case_insensitive(
    value: &str,
    needle: &str,
    replacement: &str,
) -> Option<String> {
    let value_lower = value.to_ascii_lowercase();
    let needle_lower = needle.to_ascii_lowercase();
    let start = value_lower.find(&needle_lower)?;
    let mut result = String::with_capacity(value.len() + replacement.len());
    result.push_str(&value[..start]);
    result.push_str(replacement);
    result.push_str(&value[start + needle.len()..]);
    Some(result)
}

fn create_usage_migration_backup(connection: &Connection, root: &Path) -> Result<PathBuf, String> {
    let backup_dir = root.join(USAGE_BACKUP_DIR_NAME);
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("Failed to create usage history backup directory: {error}"))?;
    let backup_path = backup_dir.join(format!("usage-before-keeper-v3-{}.db", unique_file_stamp()));
    connection
        .execute(
            "VACUUM INTO ?1",
            params![backup_path.to_string_lossy().to_string()],
        )
        .map_err(|error| format!("Failed to back up legacy usage history database: {error}"))?;
    Ok(backup_path)
}

fn migrate_legacy_v2_usage_schema(connection: &mut Connection) -> Result<(), String> {
    let before = load_usage_migration_snapshot(connection)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start usage history database migration transaction: {error}"))?;
    transaction
        .execute_batch(
            r#"
            ALTER TABLE usage_events ADD COLUMN api_group_key TEXT NOT NULL DEFAULT '';
            ALTER TABLE usage_events ADD COLUMN model_alias TEXT;
            ALTER TABLE usage_events ADD COLUMN client_ip TEXT;
            ALTER TABLE usage_events ADD COLUMN x_forwarded_for TEXT;
            ALTER TABLE usage_events ADD COLUMN user_agent TEXT;
            ALTER TABLE usage_events ADD COLUMN generate INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE usage_events ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE usage_events ADD COLUMN collector_source TEXT NOT NULL DEFAULT '';

            UPDATE usage_events
            SET api_group_key = CASE
                    WHEN api_key_hash != '' THEN api_key_hash
                    WHEN provider != '' THEN provider
                    WHEN endpoint != '' THEN endpoint
                    ELSE 'unknown'
                END,
                model_alias = NULLIF(alias, ''),
                generate = CASE
                    WHEN failed = 0
                         AND executor_type = 'CodexWebsocketsExecutor'
                         AND input_tokens = 0
                         AND output_tokens = 0
                         AND reasoning_tokens = 0
                         AND cache_read_tokens = 0
                         AND cache_creation_tokens = 0
                         AND total_tokens = 0
                    THEN 0 ELSE 1
                END,
                cached_tokens = cache_read_tokens + cache_creation_tokens,
                collector_source = 'legacy_migration';
            "#,
        )
        .map_err(|error| format!("Failed to convert legacy usage history fields: {error}"))?;
    let after = load_usage_migration_snapshot(&transaction)?;
    if before != after {
        return Err(format!(
            "Usage history migration validation mismatch, before {before:?}, after {after:?}"
        ));
    }
    initialize_usage_schema(&transaction)?;
    make_usage_event_key_non_unique(&transaction)?;
    transaction
        .execute(
            "INSERT INTO usage_metadata (key, value) VALUES (?1, ?2)",
            params![USAGE_EVENT_KEY_MIGRATION_KEY, Local::now().to_rfc3339()],
        )
        .map_err(|error| format!("record usage event key migration state failed: {error}"))?;
    transaction
        .execute(
            "INSERT INTO usage_metadata (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![USAGE_DATABASE_MIGRATION_KEY, Local::now().to_rfc3339()],
        )
        .map_err(|error| format!("Failed to write usage history migration marker: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit usage history database migration: {error}"))
}

fn load_usage_migration_snapshot(
    connection: &Connection,
) -> Result<UsageMigrationSnapshot, String> {
    connection
        .query_row(
            r#"
            SELECT
                COUNT(*),
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(reasoning_tokens), 0),
                COALESCE(SUM(cache_read_tokens), 0),
                COALESCE(SUM(cache_creation_tokens), 0),
                COALESCE(SUM(total_tokens), 0),
                COALESCE(SUM(CASE WHEN failed = 0 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN failed != 0 THEN 1 ELSE 0 END), 0),
                MIN(timestamp),
                MAX(timestamp)
            FROM usage_events
            "#,
            [],
            |row| {
                Ok(UsageMigrationSnapshot {
                    records: row.get(0)?,
                    input_tokens: row.get(1)?,
                    output_tokens: row.get(2)?,
                    reasoning_tokens: row.get(3)?,
                    cache_read_tokens: row.get(4)?,
                    cache_creation_tokens: row.get(5)?,
                    total_tokens: row.get(6)?,
                    successes: row.get(7)?,
                    failures: row.get(8)?,
                    first_timestamp: row.get(9)?,
                    last_timestamp: row.get(10)?,
                })
            },
        )
        .map_err(|error| format!("Failed to read usage history migration validation snapshot: {error}"))
}

fn initialize_usage_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS usage_metadata (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS usage_machine_assignments (
                api_key_hash TEXT PRIMARY KEY NOT NULL,
                label TEXT NOT NULL DEFAULT '',
                machine TEXT NOT NULL DEFAULT '',
                pool TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS usage_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_key TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                timestamp_ms INTEGER NOT NULL,
                local_hour TEXT NOT NULL,
                latency_ms INTEGER NOT NULL DEFAULT 0,
                ttft_ms INTEGER,
                source TEXT NOT NULL DEFAULT '',
                auth_index TEXT NOT NULL DEFAULT '',
                failed INTEGER NOT NULL DEFAULT 0,
                canceled INTEGER NOT NULL DEFAULT 0,
                failure_status INTEGER NOT NULL DEFAULT 0,
                failure_body TEXT NOT NULL DEFAULT '',
                provider TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                alias TEXT NOT NULL DEFAULT '',
                reasoning_effort TEXT NOT NULL DEFAULT '',
                service_tier TEXT NOT NULL DEFAULT '',
                response_service_tier TEXT NOT NULL DEFAULT '',
                executor_type TEXT NOT NULL DEFAULT '',
                endpoint TEXT NOT NULL DEFAULT '',
                auth_type TEXT NOT NULL DEFAULT '',
                api_key_hash TEXT NOT NULL DEFAULT '',
                api_key_display TEXT NOT NULL DEFAULT '',
                api_key_remark TEXT NOT NULL DEFAULT '',
                request_id TEXT NOT NULL DEFAULT '',
                api_group_key TEXT NOT NULL DEFAULT '',
                model_alias TEXT,
                client_ip TEXT,
                x_forwarded_for TEXT,
                user_agent TEXT,
                generate INTEGER NOT NULL DEFAULT 1,
                cached_tokens INTEGER NOT NULL DEFAULT 0,
                collector_source TEXT NOT NULL DEFAULT '',
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                reasoning_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                session_id TEXT,
                parent_session_id TEXT,
                response_model TEXT,
                node_kind TEXT,
                is_fork INTEGER,
                is_compaction INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_usage_events_completion ON usage_events(timestamp_ms + latency_ms);
            CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp
                ON usage_events(timestamp_ms DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_event_key
                ON usage_events(event_key);
            CREATE INDEX IF NOT EXISTS idx_usage_events_local_hour
                ON usage_events(local_hour, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_model_timestamp
                ON usage_events(model, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_provider_timestamp
                ON usage_events(provider, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_source_timestamp
                ON usage_events(source, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_api_key_timestamp
                ON usage_events(api_key_hash, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_failed_timestamp
                ON usage_events(failed, timestamp_ms DESC);
            -- Nothing filters or sorts on api_group_key, so this index only cost space (about
            -- 10% of the file) and insert time.
            DROP INDEX IF EXISTS idx_usage_events_api_group_timestamp;

            CREATE TABLE IF NOT EXISTS usage_inbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                message_hash TEXT NOT NULL,
                raw_message TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT NOT NULL DEFAULT '',
                usage_event_key TEXT NOT NULL DEFAULT '',
                received_at TEXT NOT NULL,
                processed_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_usage_inbox_status_id
                ON usage_inbox(status, id);

            CREATE TABLE IF NOT EXISTS usage_aggregation_checkpoints (
                name TEXT PRIMARY KEY NOT NULL,
                last_usage_event_id INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS model_prices (
                model TEXT PRIMARY KEY NOT NULL,
                prompt_per_1m REAL NOT NULL DEFAULT 0,
                completion_per_1m REAL NOT NULL DEFAULT 0,
                cache_per_1m REAL NOT NULL DEFAULT 0,
                cache_read_per_1m REAL NOT NULL DEFAULT 0,
                cache_creation_per_1m REAL NOT NULL DEFAULT 0,
                prompt_configured INTEGER NOT NULL DEFAULT 0,
                completion_configured INTEGER NOT NULL DEFAULT 0,
                cache_read_configured INTEGER NOT NULL DEFAULT 0,
                cache_creation_configured INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT '',
                source_model_id TEXT NOT NULL DEFAULT '',
                updated_at_ms INTEGER NOT NULL DEFAULT 0
            );
            "#,
        )
        .map_err(|error| format!("Failed to initialize SQLite usage history schema: {error}"))?;
    add_usage_failure_columns(connection)?;
    add_usage_session_columns(connection)?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_events_canceled_timestamp ON usage_events(canceled, timestamp_ms DESC)",
            [],
        )
        .map_err(|error| format!("Failed to create SQLite canceled records index: {error}"))?;
    // Created here rather than with the table because older databases only
    // gain the session columns in add_usage_session_columns.
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_id, timestamp_ms)",
            [],
        )
        .map_err(|error| format!("Failed to create SQLite session index: {error}"))?;
    // Partial, because most requests have no parent session.
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_events_parent_session ON usage_events(parent_session_id) WHERE parent_session_id IS NOT NULL",
            [],
        )
        .map_err(|error| format!("Failed to create SQLite parent session index: {error}"))?;
    Ok(())
}

fn add_usage_failure_columns(connection: &Connection) -> Result<(), String> {
    let mut columns = usage_table_columns(connection, "usage_events")?;
    for (column, definition) in [
        ("canceled", "INTEGER NOT NULL DEFAULT 0"),
        ("failure_status", "INTEGER NOT NULL DEFAULT 0"),
        ("failure_body", "TEXT NOT NULL DEFAULT ''"),
    ] {
        if columns.contains(column) {
            continue;
        }
        connection
            .execute(
                &format!("ALTER TABLE usage_events ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|error| format!("Failed to add SQLite usage history column {column}: {error}"))?;
        columns.insert(column.to_string());
    }
    backfill_usage_failure_details(connection)?;
    Ok(())
}

fn backfill_usage_failure_details(connection: &Connection) -> Result<(), String> {
    let migrated = connection
        .query_row(
            "SELECT value FROM usage_metadata WHERE key = ?1",
            params![USAGE_FAILURE_MIGRATION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read usage failure details migration status: {error}"))?;
    if migrated.is_some() {
        return Ok(());
    }

    if usage_table_exists(connection, "usage_inbox")? {
        let rows = {
            let mut statement = connection
                .prepare(
                    r#"
                    SELECT usage_event_key, raw_message
                    FROM usage_inbox
                    WHERE status = 'processed' AND usage_event_key != ''
                    "#,
                )
                .map_err(|error| format!("Failed to prepare usage failure details backfill: {error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| format!("Failed to query usage failure details: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Failed to read usage failure details: {error}"))?;
            rows
        };
        for (event_key, raw_message) in rows {
            let Some(object) = serde_json::from_str::<Value>(&raw_message)
                .ok()
                .and_then(|value| value.as_object().cloned())
            else {
                continue;
            };
            if !object
                .get("failed")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                continue;
            }
            let (failure_status, failure_body) = usage_failure_details(&object);
            let canceled = usage_failure_is_canceled(failure_status, &failure_body);
            connection
                .execute(
                    r#"
                    UPDATE usage_events
                    SET canceled = ?1, failure_status = ?2, failure_body = ?3
                    WHERE event_key = ?4
                    "#,
                    params![canceled, i64::from(failure_status), failure_body, event_key],
                )
                .map_err(|error| format!("Failed to backfill usage failure details: {error}"))?;
        }
    }

    connection
        .execute(
            "INSERT INTO usage_metadata (key, value) VALUES (?1, ?2)",
            params![USAGE_FAILURE_MIGRATION_KEY, Local::now().to_rfc3339()],
        )
        .map_err(|error| format!("Failed to record usage failure details migration status: {error}"))?;
    Ok(())
}

// Nullable so rows from older cores, and rows stored before this migration,
// read as NULL. ALTER TABLE ADD COLUMN only, so no table rewrite.
pub(super) const USAGE_SESSION_COLUMNS: [(&str, &str); 6] = [
    ("session_id", "TEXT"),
    ("parent_session_id", "TEXT"),
    ("response_model", "TEXT"),
    ("node_kind", "TEXT"),
    ("is_fork", "INTEGER"),
    ("is_compaction", "INTEGER"),
];

fn add_usage_session_columns(connection: &Connection) -> Result<(), String> {
    let columns = usage_table_columns(connection, "usage_events")?;
    for (column, definition) in USAGE_SESSION_COLUMNS {
        if columns.contains(column) {
            continue;
        }
        connection
            .execute(
                &format!("ALTER TABLE usage_events ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|error| {
                format!("Failed to add SQLite usage history column {column}: {error}")
            })?;
    }
    backfill_usage_session_fields(connection)
}

/// Recovers session fields for records stored before the columns existed, from
/// the processed inbox rows that have not been trimmed yet (today's). Matches
/// on the timestamp too because request ids repeat across retries.
fn backfill_usage_session_fields(connection: &Connection) -> Result<(), String> {
    let migrated = connection
        .query_row(
            "SELECT value FROM usage_metadata WHERE key = ?1",
            params![USAGE_SESSION_MIGRATION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| {
            format!("Failed to read usage session fields migration status: {error}")
        })?;
    if migrated.is_some() {
        return Ok(());
    }

    // A savepoint, because this also runs inside the legacy migration's
    // transaction. Either way the few thousand single-row updates commit
    // together, and a failed backfill leaves nothing half-applied for the retry.
    connection
        .execute_batch("SAVEPOINT usage_session_backfill")
        .map_err(|error| format!("Failed to start usage session fields backfill: {error}"))?;
    let result = write_usage_session_backfill(connection);
    let finish = if result.is_ok() {
        "RELEASE usage_session_backfill"
    } else {
        "ROLLBACK TO usage_session_backfill; RELEASE usage_session_backfill"
    };
    connection
        .execute_batch(finish)
        .map_err(|error| format!("Failed to finish usage session fields backfill: {error}"))?;
    result
}

fn write_usage_session_backfill(connection: &Connection) -> Result<(), String> {
    if usage_table_exists(connection, "usage_inbox")? {
        let rows = {
            let mut statement = connection
                .prepare(
                    r#"
                    SELECT usage_event_key, raw_message
                    FROM usage_inbox
                    WHERE status = 'processed' AND usage_event_key != ''
                    "#,
                )
                .map_err(|error| {
                    format!("Failed to prepare usage session fields backfill: {error}")
                })?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| format!("Failed to query usage session fields: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Failed to read usage session fields: {error}"))?;
            rows
        };
        for (event_key, raw_message) in rows {
            let Some(object) = serde_json::from_str::<Value>(&raw_message)
                .ok()
                .and_then(|value| value.as_object().cloned())
            else {
                continue;
            };
            let lineage = UsageLineage::from_record(&object);
            if lineage.is_empty() {
                continue;
            }
            let Some(timestamp) = usage_record_timestamp(&object) else {
                continue;
            };
            connection
                .execute(
                    r#"
                    UPDATE usage_events
                    SET session_id = ?1, parent_session_id = ?2, response_model = ?3,
                        node_kind = ?4, is_fork = ?5, is_compaction = ?6
                    WHERE event_key = ?7 AND timestamp = ?8
                      AND COALESCE(session_id, parent_session_id, response_model,
                                   node_kind, is_fork, is_compaction) IS NULL
                    "#,
                    params![
                        lineage.session_id,
                        lineage.parent_session_id,
                        lineage.response_model,
                        lineage.node_kind,
                        lineage.is_fork,
                        lineage.is_compaction,
                        event_key,
                        timestamp,
                    ],
                )
                .map_err(|error| format!("Failed to backfill usage session fields: {error}"))?;
        }
    }

    connection
        .execute(
            "INSERT INTO usage_metadata (key, value) VALUES (?1, ?2)",
            params![USAGE_SESSION_MIGRATION_KEY, Local::now().to_rfc3339()],
        )
        .map(|_| ())
        .map_err(|error| {
            format!("Failed to record usage session fields migration status: {error}")
        })
}

// ---------------------------------------------------------------------------
// Steps 8 on: the tables features keep beside the records
// ---------------------------------------------------------------------------

/// Adds whichever of `columns` the table doesn't have yet.
fn add_missing_columns(connection: &Connection, table: &str, columns: &[(&str, &str)]) -> Result<(), String> {
    let have = usage_table_columns(connection, table)?;
    for (column, definition) in columns {
        if !have.contains(*column) {
            connection
                .execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"), [])
                .map_err(|error| format!("Failed to add {column} to {table}: {error}"))?;
        }
    }
    Ok(())
}

/// Where each machine is reached over SSH.
fn machine_hosts(connection: &mut Connection, _: &Path) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS usage_machine_hosts (
                machine TEXT PRIMARY KEY NOT NULL,
                endpoint TEXT NOT NULL DEFAULT '',
                port INTEGER NOT NULL DEFAULT 22,
                enabled INTEGER NOT NULL DEFAULT 1,
                source TEXT NOT NULL DEFAULT ''
            )",
        )
        .map_err(|error| format!("Failed to prepare machine hosts table: {error}"))
}

/// Each account's limits, as they read over time.
fn limit_history(connection: &mut Connection, _: &Path) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS usage_limit_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sampled_at_ms INTEGER NOT NULL,
                provider TEXT NOT NULL,
                account TEXT NOT NULL,
                auth_index TEXT NOT NULL DEFAULT '',
                plan TEXT NOT NULL DEFAULT '',
                window_label TEXT NOT NULL,
                remaining_percent REAL,
                reset_at_ms INTEGER,
                extra INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS usage_limit_samples_account_window
                ON usage_limit_samples(account, window_label, sampled_at_ms);
            CREATE INDEX IF NOT EXISTS usage_limit_samples_sampled_at
                ON usage_limit_samples(sampled_at_ms);",
        )
        .map_err(|error| format!("Failed to prepare limit history table: {error}"))
}

/// The pull requests table as it was first made.
const FIRST_PULL_REQUESTS_TABLE: &str = "CREATE TABLE IF NOT EXISTS usage_pull_requests (
    repository TEXT NOT NULL COLLATE NOCASE,
    number INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT '',
    draft INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    head_branch TEXT NOT NULL DEFAULT '',
    base_branch TEXT NOT NULL DEFAULT '',
    merged_at_ms INTEGER,
    closed_at_ms INTEGER,
    checked_at_ms INTEGER NOT NULL,
    PRIMARY KEY (repository, number)
)";

/// Added after the table was first made. Rows from before say nothing about
/// checks, reviews or merging until they're asked about again.
const PULL_REQUEST_DETAILS: [(&str, &str); 7] = [
    ("mergeable", "TEXT NOT NULL DEFAULT ''"),
    ("review", "TEXT NOT NULL DEFAULT ''"),
    ("checks_rollup", "TEXT NOT NULL DEFAULT ''"),
    ("checks_passed", "INTEGER NOT NULL DEFAULT 0"),
    ("checks_failed", "INTEGER NOT NULL DEFAULT 0"),
    ("checks_pending", "INTEGER NOT NULL DEFAULT 0"),
    ("checks_total", "INTEGER NOT NULL DEFAULT 0"),
];

/// How the pull requests sessions link to last stood on GitHub.
fn pull_requests(connection: &mut Connection, _: &Path) -> Result<(), String> {
    connection
        .execute_batch(FIRST_PULL_REQUESTS_TABLE)
        .map_err(|error| format!("Failed to prepare pull requests table: {error}"))?;
    add_missing_columns(connection, "usage_pull_requests", &PULL_REQUEST_DETAILS)
}

/// The session transcripts table as it was first made.
const FIRST_TRANSCRIPTS_TABLE: &str = "CREATE TABLE IF NOT EXISTS usage_session_transcripts (
    session_id TEXT PRIMARY KEY NOT NULL,
    machine TEXT NOT NULL,
    agent TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    read_at_ms INTEGER NOT NULL DEFAULT 0,
    home TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL DEFAULT '',
    repo_root TEXT NOT NULL DEFAULT '',
    main_repo TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    commit_hash TEXT NOT NULL DEFAULT '',
    repository_url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    title_source TEXT NOT NULL DEFAULT '',
    pull_requests TEXT NOT NULL DEFAULT '[]',
    lines_added INTEGER,
    lines_removed INTEGER,
    compactions TEXT NOT NULL DEFAULT '[]'
)";

const TRANSCRIPT_ADDITIONS: [(&str, &str); 2] = [
    // NULL until the transcript has been read for its tool calls.
    ("tool_usage", "TEXT"),
    // The agent home the transcript is in, with the machine's home as ~, empty until a scan finds it.
    ("agent_home", "TEXT NOT NULL DEFAULT ''"),
];

/// What each session's transcript said about it, by the ids it stores.
fn session_transcripts(connection: &mut Connection, _: &Path) -> Result<(), String> {
    connection
        .execute_batch(FIRST_TRANSCRIPTS_TABLE)
        .map_err(|error| format!("Failed to prepare session transcripts table: {error}"))?;
    add_missing_columns(connection, "usage_session_transcripts", &TRANSCRIPT_ADDITIONS)
}

/// Claude Code's telemetry, summed by the hour.
fn agent_telemetry(connection: &mut Connection, _: &Path) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS usage_agent_telemetry (
                hour_ms INTEGER NOT NULL,
                machine TEXT NOT NULL,
                session_id TEXT NOT NULL,
                version TEXT NOT NULL,
                model TEXT NOT NULL,
                source TEXT NOT NULL,
                agent TEXT NOT NULL,
                skill TEXT NOT NULL,
                plugin TEXT NOT NULL,
                marketplace TEXT NOT NULL,
                mcp_server TEXT NOT NULL,
                cost REAL NOT NULL DEFAULT 0,
                input_tokens REAL NOT NULL DEFAULT 0,
                output_tokens REAL NOT NULL DEFAULT 0,
                cache_read_tokens REAL NOT NULL DEFAULT 0,
                cache_creation_tokens REAL NOT NULL DEFAULT 0,
                PRIMARY KEY (hour_ms, machine, session_id, version, model, source, agent, skill, plugin, marketplace, mcp_server)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS usage_agent_telemetry_machine ON usage_agent_telemetry(machine, hour_ms);",
        )
        .map_err(|error| format!("Failed to prepare the agent telemetry table: {error}"))
}

/// The calls Diagnostics lists, and its settings.
fn diagnostics(connection: &mut Connection, _: &Path) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS diagnostic_calls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at_ms INTEGER NOT NULL,
                kind TEXT NOT NULL,
                target TEXT NOT NULL,
                operation TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                code INTEGER,
                outcome TEXT NOT NULL,
                slow_after_ms INTEGER NOT NULL,
                slow INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS diagnostic_calls_at ON diagnostic_calls(at_ms);
            CREATE TABLE IF NOT EXISTS diagnostic_settings (
                key TEXT PRIMARY KEY NOT NULL,
                value INTEGER NOT NULL
            );",
        )
        .map_err(|error| format!("Failed to prepare the diagnostics table: {error}"))
}

/// Each credential's requests in time order, so the Capacity report finds when
/// each was first used with a lookup per credential instead of a pass over
/// every request.
fn credential_index(connection: &mut Connection, _: &Path) -> Result<(), String> {
    connection
        .execute_batch("CREATE INDEX IF NOT EXISTS idx_usage_events_auth_index_timestamp ON usage_events(auth_index, timestamp_ms)")
        .map_err(|error| format!("Failed to index requests by credential: {error}"))
}

/// The failed requests alone, newest first, so the Requests page's failures
/// filter counts and pages them without a pass over every request. Few
/// requests fail, so it stays small.
fn failures_index(connection: &mut Connection, _: &Path) -> Result<(), String> {
    connection
        .execute_batch("CREATE INDEX IF NOT EXISTS idx_usage_events_failures ON usage_events(timestamp_ms DESC, id DESC) WHERE failed != 0")
        .map_err(|error| format!("Failed to index failed requests: {error}"))
}

/// Where each machine's agents keep their homes, beyond the standard ones, and what each machine's last look for
/// homes found.
fn agent_homes(connection: &mut Connection, _: &Path) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS usage_agent_homes (
                machine TEXT NOT NULL,
                agent TEXT NOT NULL,
                path TEXT NOT NULL,
                source TEXT NOT NULL,
                sessions INTEGER NOT NULL DEFAULT 1,
                sync INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (machine, agent, path)
            );
            CREATE TABLE IF NOT EXISTS usage_agent_home_scans (
                machine TEXT PRIMARY KEY NOT NULL,
                scanned_at_ms INTEGER NOT NULL,
                found TEXT NOT NULL DEFAULT '[]',
                error TEXT NOT NULL DEFAULT '',
                filled INTEGER NOT NULL DEFAULT 0
            )",
        )
        .map_err(|error| format!("Failed to prepare the agent homes tables: {error}"))
}

/// Machine pools and their members (`machine_health/pools.rs`). Members keep the order they were
/// listed in; a machine is matched to the Machines page by its normalized name when read.
fn machine_pools(connection: &mut Connection, _: &Path) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS usage_pools (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                max_agents INTEGER NOT NULL DEFAULT 4,
                cpu_ceiling INTEGER NOT NULL DEFAULT 95,
                mem_floor INTEGER NOT NULL DEFAULT 5,
                when_full TEXT NOT NULL DEFAULT 'refuse',
                spill_pool TEXT,
                queue_timeout_min INTEGER NOT NULL DEFAULT 30
            );
            CREATE TABLE IF NOT EXISTS usage_pool_members (
                pool_id TEXT NOT NULL,
                machine TEXT NOT NULL,
                weight TEXT NOT NULL DEFAULT 'normal',
                position INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (pool_id, machine)
            )",
        )
        .map_err(|error| format!("Failed to prepare the machine pools tables: {error}"))
}

/// Arbor's own automations, each run of one, and the automations page's own settings. `input` is the automation as
/// the dialog saved it, as JSON, so a field added later needs no step of its own.
fn automations(connection: &mut Connection, _: &Path) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS usage_automations (
                id TEXT PRIMARY KEY NOT NULL,
                input TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                next_run_at_ms INTEGER,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS usage_automation_runs (
                id TEXT PRIMARY KEY NOT NULL,
                automation_id TEXT NOT NULL,
                machine TEXT,
                status TEXT NOT NULL,
                scheduled_at_ms INTEGER NOT NULL,
                started_at_ms INTEGER,
                finished_at_ms INTEGER,
                manual INTEGER NOT NULL DEFAULT 0,
                precheck_exit INTEGER,
                precheck_output TEXT,
                exit_code INTEGER,
                session_id TEXT,
                error TEXT,
                worktree TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_usage_automation_runs ON usage_automation_runs(automation_id, scheduled_at_ms DESC);
            CREATE TABLE IF NOT EXISTS usage_automation_settings (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            )",
        )
        .map_err(|error| format!("Failed to prepare the automations tables: {error}"))
}

/// Runs started on a pool (`machine_health/runs.rs`): where each went and how it went. A run's
/// prompt is never kept here; `handle` holds the ids the harness gave back, as JSON.
fn harness_runs(connection: &mut Connection, _: &Path) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS usage_runs (
                id TEXT PRIMARY KEY NOT NULL,
                trigger_id TEXT,
                pool_id TEXT NOT NULL,
                ran_pool_id TEXT,
                machine TEXT,
                harness TEXT NOT NULL,
                used_harness TEXT,
                setup TEXT NOT NULL,
                folder TEXT NOT NULL,
                title TEXT NOT NULL,
                state TEXT NOT NULL,
                reason TEXT,
                detail TEXT,
                handle TEXT NOT NULL DEFAULT '{}',
                queued_at_ms INTEGER NOT NULL,
                started_at_ms INTEGER,
                ended_at_ms INTEGER,
                wait_until_ms INTEGER
            );
            CREATE INDEX IF NOT EXISTS usage_runs_queued ON usage_runs (queued_at_ms DESC);
            CREATE INDEX IF NOT EXISTS usage_runs_state ON usage_runs (state)",
        )
        .map_err(|error| format!("Failed to prepare the harness runs table: {error}"))
}

/// Which machine each host name a pool was reached under over SSH (`machine_health/pool_ssh.rs`) is pinned to, so an
/// app that remembers a host by name finds its files on the same machine after Arbor restarts. `from_pool_id` is the
/// pool the machine was picked from: the one asked for, or one it spilled into.
fn pool_ssh_names(connection: &mut Connection, _: &Path) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS usage_pool_ssh_names (
                pool_id TEXT NOT NULL,
                name TEXT NOT NULL,
                from_pool_id TEXT NOT NULL,
                machine TEXT NOT NULL,
                picked_at_ms INTEGER NOT NULL,
                PRIMARY KEY (pool_id, name)
            )",
        )
        .map_err(|error| format!("Failed to prepare the pool SSH names table: {error}"))
}

/// Whether the user picked each home's role or it follows Arbor's guess, and which found folders each machine's last
/// look saw sessions in lately. The homes found before this start unpicked, so the next look sorts them; a standard
/// home switched on a machine was the user's own pick.
fn agent_home_roles(connection: &mut Connection, _: &Path) -> Result<(), String> {
    add_missing_columns(connection, "usage_agent_homes", &[("chosen", "INTEGER NOT NULL DEFAULT 0")])?;
    add_missing_columns(connection, "usage_agent_home_scans", &[("recent", "TEXT NOT NULL DEFAULT '[]'"), ("activity", "INTEGER NOT NULL DEFAULT 0")])?;
    connection
        .execute("UPDATE usage_agent_homes SET chosen = 1 WHERE source = 'standard'", [])
        .map(|_| ())
        .map_err(|error| format!("Failed to mark the standard agent homes: {error}"))
}

// ---------------------------------------------------------------------------
// For tests
// ---------------------------------------------------------------------------

/// A database in memory that has had every step, as the app's own has.
#[cfg(test)]
pub(super) fn test_database() -> Connection {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&mut connection, Path::new("")).unwrap();
    connection
}

/// Adds a request naming only `columns`, with the ones every record has left empty.
#[cfg(test)]
pub(super) fn insert_request(connection: &Connection, columns: &str, values: impl rusqlite::Params) {
    let placeholders = (1..=columns.split(',').count()).map(|n| format!("?{n}")).collect::<Vec<_>>().join(", ");
    connection
        .execute(
            &format!("INSERT INTO usage_events (event_key, timestamp, local_hour, created_at, {columns}) VALUES ('', '', '', '', {placeholders})"),
            values,
        )
        .unwrap();
}

/// usage.db as EasyCLIProxyAPI 0.2 left it, before the inbox and the columns Arbor keeps.
#[cfg(test)]
pub(super) const LEGACY_V2_SQL: &str = r#"
    CREATE TABLE usage_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
    );
    CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        local_hour TEXT NOT NULL,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        ttft_ms INTEGER,
        source TEXT NOT NULL DEFAULT '',
        auth_index TEXT NOT NULL DEFAULT '',
        failed INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        alias TEXT NOT NULL DEFAULT '',
        reasoning_effort TEXT NOT NULL DEFAULT '',
        service_tier TEXT NOT NULL DEFAULT '',
        response_service_tier TEXT NOT NULL DEFAULT '',
        executor_type TEXT NOT NULL DEFAULT '',
        endpoint TEXT NOT NULL DEFAULT '',
        auth_type TEXT NOT NULL DEFAULT '',
        api_key_hash TEXT NOT NULL DEFAULT '',
        api_key_display TEXT NOT NULL DEFAULT '',
        api_key_remark TEXT NOT NULL DEFAULT '',
        request_id TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    );
    PRAGMA user_version = 2;
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// Each table's columns, and each index, as the database has them.
    fn shape(connection: &Connection) -> BTreeMap<String, Vec<String>> {
        let entries = connection
            .prepare("SELECT type, name, tbl_name, COALESCE(sql, '') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
            .unwrap()
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let mut shape = BTreeMap::new();
        for (kind, name, table, sql) in entries {
            let described = if kind == "table" {
                let mut columns = connection
                    .prepare("SELECT name, type, \"notnull\", COALESCE(dflt_value, ''), pk FROM pragma_table_info(?1)")
                    .unwrap()
                    .query_map([&name], |row| {
                        Ok(format!(
                            "{} {} notnull={} default={} pk={}",
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, i64>(4)?
                        ))
                    })
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap();
                // A column added later comes last; where it sits doesn't matter.
                columns.sort();
                if sql.contains("WITHOUT ROWID") {
                    columns.push("without rowid".into());
                }
                columns
            } else {
                vec![format!("on {table}: {}", sql.split_whitespace().collect::<Vec<_>>().join(" "))]
            };
            shape.insert(format!("{kind} {name}"), described);
        }
        shape
    }

    fn version(connection: &Connection) -> i64 {
        connection.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap()
    }

    /// Where a step that rewrites a database leaves the copy it kept first.
    fn backups_root(name: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("arbor-schema-{name}-{}-{nanos}", std::process::id()))
    }

    /// EasyCLIProxyAPI 0.3's records: 0.2's with the inbox and the columns Arbor keeps, event keys still unique.
    const KEEPER_V3_SQL: &str = r#"
        ALTER TABLE usage_events ADD COLUMN api_group_key TEXT NOT NULL DEFAULT '';
        ALTER TABLE usage_events ADD COLUMN model_alias TEXT;
        ALTER TABLE usage_events ADD COLUMN client_ip TEXT;
        ALTER TABLE usage_events ADD COLUMN x_forwarded_for TEXT;
        ALTER TABLE usage_events ADD COLUMN user_agent TEXT;
        ALTER TABLE usage_events ADD COLUMN generate INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE usage_events ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE usage_events ADD COLUMN collector_source TEXT NOT NULL DEFAULT '';
        CREATE TABLE usage_inbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            message_hash TEXT NOT NULL,
            raw_message TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT NOT NULL DEFAULT '',
            usage_event_key TEXT NOT NULL DEFAULT '',
            received_at TEXT NOT NULL,
            processed_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE usage_aggregation_checkpoints (
            name TEXT PRIMARY KEY NOT NULL,
            last_usage_event_id INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 3;
    "#;

    /// Arbor before the list of steps: the records tables as they are now, at
    /// version 6, one feature's table as it was first made, one as it was
    /// before its latest column, and the rest not made yet.
    fn before_the_list() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        usage_records(&mut connection, Path::new("")).unwrap();
        connection.execute_batch(FIRST_PULL_REQUESTS_TABLE).unwrap();
        connection.execute_batch(FIRST_TRANSCRIPTS_TABLE).unwrap();
        connection.execute_batch("ALTER TABLE usage_session_transcripts ADD COLUMN tool_usage TEXT").unwrap();
        connection
            .execute_batch(
                "INSERT INTO usage_pull_requests (repository, number, state, checked_at_ms) VALUES ('acme/arbor', 412, 'open', 1);
                 INSERT INTO usage_session_transcripts (session_id, machine, agent, cwd) VALUES ('s-1', 'mini', 'claude', '/src/arbor');
                 PRAGMA user_version = 6;",
            )
            .unwrap();
        connection
    }

    #[test]
    fn every_database_arbor_has_known_ends_up_as_a_new_one_starts() {
        let new = shape(&test_database());
        assert!(new.contains_key("table usage_pull_requests") && new.contains_key("index diagnostic_calls_at"));
        let root = backups_root("upgrades");
        let legacy = || {
            let connection = Connection::open_in_memory().unwrap();
            connection.execute_batch(LEGACY_V2_SQL).unwrap();
            connection
        };
        let keeper = || {
            let connection = legacy();
            connection.execute_batch(KEEPER_V3_SQL).unwrap();
            connection
        };
        let olds: [(&str, Box<dyn Fn() -> Connection>); 3] =
            [("0.2", Box::new(legacy)), ("0.3", Box::new(keeper)), ("before the list", Box::new(before_the_list))];
        for (from, old) in olds {
            let mut connection = old();
            assert!(version(&connection) < 7, "{from}");
            migrate(&mut connection, &root).unwrap();
            assert_eq!(shape(&connection), new, "from {from}");
            assert_eq!(version(&connection), LATEST, "from {from}");
            // Once is enough: a second run finds nothing to do.
            migrate(&mut connection, &root).unwrap();
            assert_eq!(shape(&connection), new, "from {from}, again");
        }
        let _ = fs::remove_dir_all(root);

        // Rows kept in a table from before a column was added read the column empty.
        let mut connection = before_the_list();
        migrate(&mut connection, Path::new("")).unwrap();
        let kept = connection
            .query_row(
                "SELECT p.state, p.mergeable, p.checks_total, t.cwd, t.tool_usage, t.agent_home
                 FROM usage_pull_requests p, usage_session_transcripts t",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(kept, ("open".into(), String::new(), 0, "/src/arbor".into(), None, String::new()));
    }

    #[test]
    fn steps_follow_each_other_from_where_the_old_versions_stopped() {
        let versions = STEPS.iter().map(|step| step.version).collect::<Vec<_>>();
        assert_eq!(versions, (7..7 + STEPS.len() as i64).collect::<Vec<_>>());
    }

    #[test]
    fn a_database_a_newer_arbor_took_further_is_left_as_it_is() {
        let mut connection = test_database();
        connection
            .execute_batch("CREATE TABLE usage_from_later (id INTEGER PRIMARY KEY); PRAGMA user_version = 999;")
            .unwrap();
        let before = shape(&connection);
        migrate(&mut connection, Path::new("")).unwrap();
        assert_eq!((shape(&connection), version(&connection)), (before, 999));
    }

    #[test]
    fn a_step_that_fails_is_tried_again_next_time() {
        let mut connection = Connection::open_in_memory().unwrap();
        // Nothing Arbor or EasyCLIProxyAPI made, so the records step won't touch it.
        connection.execute_batch("CREATE TABLE usage_events (id INTEGER PRIMARY KEY, note TEXT)").unwrap();
        let error = migrate(&mut connection, Path::new("")).unwrap_err();
        assert!(error.contains("usage records") && error.contains("Unrecognized"), "{error}");
        assert_eq!(version(&connection), 0);
    }
}

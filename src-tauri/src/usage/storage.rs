//! Usage history retention, storage statistics and compaction.
//!
//! Retention is by age: `usage_retention_days` in `usage_metadata`, where 0 or
//! a missing value keeps history forever (the default). It is applied when the
//! collector starts, in the collector's hourly maintenance tick, and straight
//! away when the setting is saved. Expired events are deleted oldest first in
//! bounded batches, so the SQLite write lock is only ever held briefly.
//!
//! Nothing here vacuums automatically. SQLite reuses the pages retention frees,
//! so the file stops growing once the window is full; shrinking the file is
//! the explicit `compact_usage_database` command. VACUUM needs free disk space
//! for a temporary copy of the live data plus the rebuilt pages it writes to
//! the WAL, about twice the live data, and compaction refuses to start with
//! less than that available.

use super::*;
use ts_rs::TS;

const USAGE_RETENTION_DAYS_KEY: &str = "usage_retention_days";
const MAX_USAGE_RETENTION_DAYS: u32 = 3_650;
const USAGE_RETENTION_BATCH_SIZE: usize = 5_000;
// A short gap between batches gives waiting writers, the collector included, a turn.
const USAGE_RETENTION_BATCH_PAUSE: Duration = Duration::from_millis(20);
const MILLIS_PER_DAY: i64 = 24 * 60 * 60 * 1_000;
// Both statements are served by idx_usage_events_timestamp (timestamp_ms DESC,
// id DESC), with timestamp_ms in the same epoch milliseconds the queries use.
const EXPIRED_USAGE_COUNT_SQL: &str = "SELECT COUNT(*) FROM usage_events WHERE timestamp_ms < ?1";
const EXPIRED_USAGE_BATCH_DELETE_SQL: &str = r#"
    DELETE FROM usage_events
    WHERE id IN (
        SELECT id FROM usage_events
        WHERE timestamp_ms < ?1
        ORDER BY timestamp_ms ASC, id ASC
        LIMIT ?2
    )
"#;

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageStorageInfo {
    retention_days: u32,
    file_bytes: u64,
    wal_bytes: u64,
    free_bytes: u64,
    record_count: u64,
    oldest_timestamp: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageRetentionResult {
    retention_days: u32,
    records_affected: u64,
}

/// Database sizes around a compaction, each the file plus its write-ahead log as
/// `get_usage_storage_info` counts them.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageCompactionResult {
    bytes_before: u64,
    bytes_after: u64,
    /// True when a read kept the closing checkpoint from finishing. The rebuilt
    /// pages then wait in the write-ahead log until SQLite checkpoints as the last
    /// connection closes, and `bytes_after` is the size the file shrinks to then.
    shrink_pending: bool,
}

struct UsagePageCounts {
    page_size: u64,
    page_count: u64,
    free_pages: u64,
}

#[tauri::command]
pub(crate) async fn get_usage_storage_info() -> Result<UsageStorageInfo, String> {
    run_usage_task(|| load_usage_storage_info(&usage_root_dir()?)).await
}

/// Saves the retention window and prunes to it immediately. With `dry_run`
/// it only counts the records the window would remove, saving nothing.
#[tauri::command]
pub(crate) async fn set_usage_retention(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    retention_days: u32,
    dry_run: bool,
) -> Result<UsageRetentionResult, String> {
    let config = gui_config_state.snapshot()?;
    let result = run_usage_task(move || {
        set_usage_retention_at(
            &usage_root_dir()?,
            retention_days,
            dry_run,
            &config,
            Local::now(),
        )
    })
    .await?;
    if !dry_run {
        publish_pruned_records(&app, result.records_affected);
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn compact_usage_database() -> Result<UsageCompactionResult, String> {
    run_exclusive_usage_task(|| compact_usage_database_at(&usage_root_dir()?)).await
}

/// Applies the saved retention when the collector starts.
pub(super) fn apply_startup_usage_retention(app: &tauri::AppHandle) {
    let context =
        usage_root_dir().and_then(|root| Ok((root, app.state::<GuiConfigState>().snapshot()?)));
    match context {
        Ok((root, config)) => apply_usage_retention(app, &root, &config),
        Err(error) => eprintln!("Failed to apply usage history retention: {error}"),
    }
}

/// Applies the saved retention for the collector. Failures are logged and
/// retried on the next maintenance tick; they never stop collection.
pub(super) fn apply_usage_retention(app: &tauri::AppHandle, root: &Path, config: &GuiConfigFile) {
    match enforce_usage_retention_at(root, config, Local::now()) {
        Ok(removed) => publish_pruned_records(app, removed),
        Err(error) => eprintln!("Failed to apply usage history retention: {error}"),
    }
}

fn publish_pruned_records(app: &tauri::AppHandle, removed: u64) {
    publish_record_changes(app, RecordChanges { removed, ..RecordChanges::default() });
}

fn enforce_usage_retention_at(
    root: &Path,
    config: &GuiConfigFile,
    now: DateTime<Local>,
) -> Result<u64, String> {
    let connection = open_usage_database_at(root)?;
    let retention_days = load_usage_retention_days(&connection)?;
    prune_expired_usage_events(
        &connection,
        retention_days,
        config,
        now,
        USAGE_RETENTION_BATCH_SIZE,
    )
}

fn set_usage_retention_at(
    root: &Path,
    retention_days: u32,
    dry_run: bool,
    config: &GuiConfigFile,
    now: DateTime<Local>,
) -> Result<UsageRetentionResult, String> {
    validate_usage_retention_days(retention_days)?;
    let connection = open_usage_database_at(root)?;
    let records_affected = if dry_run {
        count_expired_usage_events(&connection, retention_days, now)?
    } else {
        save_usage_retention_days(&connection, retention_days)?;
        prune_expired_usage_events(
            &connection,
            retention_days,
            config,
            now,
            USAGE_RETENTION_BATCH_SIZE,
        )?
    };
    Ok(UsageRetentionResult {
        retention_days,
        records_affected,
    })
}

fn validate_usage_retention_days(retention_days: u32) -> Result<(), String> {
    if retention_days > MAX_USAGE_RETENTION_DAYS {
        return Err(format!(
            "Usage history retention must be 1 to {MAX_USAGE_RETENTION_DAYS} days, or 0 to keep it forever"
        ));
    }
    Ok(())
}

fn load_usage_retention_days(connection: &Connection) -> Result<u32, String> {
    let value = connection
        .query_row(
            "SELECT value FROM usage_metadata WHERE key = ?1",
            params![USAGE_RETENTION_DAYS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read usage history retention: {error}"))?;
    // An unreadable value keeps history forever, so a damaged setting can never delete records.
    Ok(value
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|days| *days <= MAX_USAGE_RETENTION_DAYS)
        .unwrap_or(0))
}

fn save_usage_retention_days(connection: &Connection, retention_days: u32) -> Result<(), String> {
    let _write_guard = lock_usage_writes();
    connection
        .execute(
            r#"INSERT INTO usage_metadata (key, value) VALUES (?1, ?2)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value"#,
            params![USAGE_RETENTION_DAYS_KEY, retention_days.to_string()],
        )
        .map(|_| ())
        .map_err(|error| format!("Failed to save usage history retention: {error}"))
}

/// Events stamped before this instant are expired; `None` keeps everything.
fn usage_retention_cutoff_ms(retention_days: u32, now: DateTime<Local>) -> Option<i64> {
    (retention_days > 0).then(|| {
        now.timestamp_millis()
            .saturating_sub(i64::from(retention_days) * MILLIS_PER_DAY)
    })
}

fn count_expired_usage_events(
    connection: &Connection,
    retention_days: u32,
    now: DateTime<Local>,
) -> Result<u64, String> {
    let Some(cutoff_ms) = usage_retention_cutoff_ms(retention_days, now) else {
        return Ok(0);
    };
    connection
        .query_row(EXPIRED_USAGE_COUNT_SQL, params![cutoff_ms], |row| {
            row.get::<_, i64>(0)
        })
        .map(from_sql_i64)
        .map_err(|error| format!("Failed to count expired usage records: {error}"))
}

/// Deletes events older than the retention window, one bounded batch per
/// statement. The write lock is taken per batch, so the collector can store
/// new records in between. A failure after some batches succeeded is logged
/// and the rows already removed are still reported, so the collector's count
/// stays exact; the next maintenance tick carries on from there.
fn prune_expired_usage_events(
    connection: &Connection,
    retention_days: u32,
    config: &GuiConfigFile,
    now: DateTime<Local>,
    batch_size: usize,
) -> Result<u64, String> {
    let Some(cutoff_ms) = usage_retention_cutoff_ms(retention_days, now) else {
        return Ok(0);
    };
    let batch_size = batch_size.max(1);
    let mut removed = 0_u64;
    loop {
        let deleted = {
            let _write_guard = lock_usage_writes();
            connection.execute(
                EXPIRED_USAGE_BATCH_DELETE_SQL,
                params![cutoff_ms, to_sql_i64(batch_size as u64)],
            )
        };
        let deleted = match deleted {
            Ok(deleted) => deleted,
            Err(error) if removed == 0 => {
                return Err(format!("Failed to delete expired usage records: {error}"));
            }
            Err(error) => {
                eprintln!("Stopped pruning usage history after {removed} records: {error}");
                break;
            }
        };
        removed = removed.saturating_add(deleted as u64);
        if deleted < batch_size {
            break;
        }
        std::thread::sleep(USAGE_RETENTION_BATCH_PAUSE);
    }
    if removed > 0 {
        let _write_guard = lock_usage_writes();
        if let Err(error) = machines::remove_orphaned_assignments(connection, config) {
            eprintln!("Failed to remove machine assignments for pruned API keys: {error}");
        }
    }
    Ok(removed)
}

fn load_usage_storage_info(root: &Path) -> Result<UsageStorageInfo, String> {
    let connection = open_usage_database_at(root)?;
    let retention_days = load_usage_retention_days(&connection)?;
    let pages = usage_page_counts(&connection)?;
    let record_count = connection
        .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
            row.get::<_, i64>(0)
        })
        .map(from_sql_i64)
        .map_err(|error| format!("Failed to count usage records: {error}"))?;
    let oldest_timestamp = connection
        .query_row(
            "SELECT timestamp FROM usage_events ORDER BY timestamp_ms ASC, id ASC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read the oldest usage record: {error}"))?;
    let database_path = root.join(USAGE_DATABASE_FILE);
    Ok(UsageStorageInfo {
        retention_days,
        file_bytes: file_size(&database_path)?,
        wal_bytes: file_size(&usage_wal_path(&database_path))?,
        free_bytes: pages.free_pages.saturating_mul(pages.page_size),
        record_count,
        oldest_timestamp,
    })
}

fn compact_usage_database_at(root: &Path) -> Result<UsageCompactionResult, String> {
    // Held throughout, so the collector waits rather than writing into the VACUUM.
    let _write_guard = lock_usage_writes();
    let connection = open_usage_database_at(root)?;
    let database_path = root.join(USAGE_DATABASE_FILE);
    let bytes_before = usage_database_bytes(&database_path)?;
    if !checkpoint_usage_wal(&connection)? {
        return Err("Usage history is busy. Try compacting again in a moment.".to_string());
    }
    let pages = usage_page_counts(&connection)?;
    let live_bytes = pages
        .page_count
        .saturating_sub(pages.free_pages)
        .saturating_mul(pages.page_size);
    ensure_vacuum_disk_space(live_bytes, available_disk_bytes(root))?;
    connection
        .execute_batch("VACUUM")
        .map_err(|error| format!("Failed to compact usage history: {error}"))?;
    // VACUUM writes the rebuilt pages to the WAL. Checkpointing moves them into
    // the database file, truncates it to the new size and empties the WAL.
    if checkpoint_usage_wal(&connection)? {
        return Ok(UsageCompactionResult {
            bytes_before,
            bytes_after: usage_database_bytes(&database_path)?,
            shrink_pending: false,
        });
    }
    eprintln!("Usage history compacted, but the WAL checkpoint was busy; the file shrinks at the next checkpoint");
    let pages = usage_page_counts(&connection)?;
    Ok(UsageCompactionResult {
        bytes_before,
        bytes_after: pages.page_count.saturating_mul(pages.page_size),
        shrink_pending: true,
    })
}

/// Runs a TRUNCATE checkpoint. Returns false when a reader kept it from
/// completing within the busy timeout.
fn checkpoint_usage_wal(connection: &Connection) -> Result<bool, String> {
    connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            row.get::<_, i64>(0)
        })
        .map(|busy| busy == 0)
        .map_err(|error| format!("Failed to checkpoint usage history: {error}"))
}

/// VACUUM copies the live data to a temporary database, then writes every
/// rebuilt page to the WAL, so it needs about twice the live data free.
fn ensure_vacuum_disk_space(live_bytes: u64, available_bytes: Option<u64>) -> Result<(), String> {
    let required_bytes = live_bytes.saturating_mul(2);
    match available_bytes {
        Some(available_bytes) if available_bytes < required_bytes => Err(format!(
            "Not enough free disk space to compact usage history: it needs about {} free, but only {} is available",
            format_megabytes(required_bytes),
            format_megabytes(available_bytes)
        )),
        _ => Ok(()),
    }
}

fn format_megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
}

fn available_disk_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `path` is NUL-terminated and `stats` is writable memory that
    // statfs fills in completely when it returns 0.
    if unsafe { libc::statfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: statfs returned 0, so `stats` is initialized.
    let stats = unsafe { stats.assume_init() };
    Some(stats.f_bavail.saturating_mul(u64::from(stats.f_bsize)))
}

fn usage_page_counts(connection: &Connection) -> Result<UsagePageCounts, String> {
    let read = |pragma: &str| {
        connection
            .query_row(&format!("PRAGMA {pragma}"), [], |row| row.get::<_, i64>(0))
            .map(from_sql_i64)
            .map_err(|error| format!("Failed to read SQLite {pragma}: {error}"))
    };
    Ok(UsagePageCounts {
        page_size: read("page_size")?,
        page_count: read("page_count")?,
        free_pages: read("freelist_count")?,
    })
}

fn usage_wal_path(database_path: &Path) -> PathBuf {
    let mut path = database_path.as_os_str().to_os_string();
    path.push("-wal");
    PathBuf::from(path)
}

/// The database file plus its WAL, which is what the database takes on disk.
fn usage_database_bytes(database_path: &Path) -> Result<u64, String> {
    Ok(file_size(database_path)?.saturating_add(file_size(&usage_wal_path(database_path))?))
}

/// The file's size, or 0 when it does not exist: SQLite deletes the WAL when
/// the last connection closes.
fn file_size(path: &Path) -> Result<u64, String> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(format!(
            "Failed to read the size of {}: {error}",
            path.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "arbor-usage-storage-{name}-{}-{}",
            std::process::id(),
            unique_file_stamp()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn open_test_database(root: &Path) -> Connection {
        initialize_usage_storage_at(root).unwrap();
        open_usage_database_at(root).unwrap()
    }

    fn fixed_now() -> DateTime<Local> {
        DateTime::from_timestamp_millis(1_790_000_000_000)
            .unwrap()
            .with_timezone(&Local)
    }

    fn insert_event(connection: &Connection, key: &str, timestamp_ms: i64, api_key_hash: &str) {
        let timestamp = DateTime::from_timestamp_millis(timestamp_ms)
            .unwrap()
            .to_rfc3339();
        connection
            .execute(
                r#"INSERT INTO usage_events (
                       event_key, timestamp, timestamp_ms, local_hour, api_key_hash, created_at
                   ) VALUES (?1, ?2, ?3, 'hour', ?4, ?2)"#,
                params![key, timestamp, timestamp_ms, api_key_hash],
            )
            .unwrap();
    }

    fn event_keys(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare("SELECT event_key FROM usage_events ORDER BY timestamp_ms, id")
            .unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    fn event_count(connection: &Connection) -> u64 {
        connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .map(from_sql_i64)
            .unwrap()
    }

    #[test]
    fn retention_setting_defaults_to_forever_persists_and_rejects_out_of_range_values() {
        let root = test_root("retention-setting");
        let connection = open_test_database(&root);
        assert_eq!(load_usage_retention_days(&connection).unwrap(), 0);
        drop(connection);

        let config = GuiConfigFile::default();
        let now = fixed_now();
        let saved = set_usage_retention_at(&root, 30, false, &config, now).unwrap();
        assert_eq!(saved.retention_days, 30);
        for invalid in [3_651, u32::MAX] {
            for dry_run in [true, false] {
                let error =
                    set_usage_retention_at(&root, invalid, dry_run, &config, now).unwrap_err();
                assert!(error.contains("3650"), "{error}");
            }
        }
        let connection = open_usage_database_at(&root).unwrap();
        assert_eq!(load_usage_retention_days(&connection).unwrap(), 30);
        drop(connection);
        assert_eq!(load_usage_storage_info(&root).unwrap().retention_days, 30);

        set_usage_retention_at(&root, MAX_USAGE_RETENTION_DAYS, false, &config, now).unwrap();
        assert_eq!(
            load_usage_storage_info(&root).unwrap().retention_days,
            MAX_USAGE_RETENTION_DAYS
        );
        set_usage_retention_at(&root, 0, false, &config, now).unwrap();
        assert_eq!(load_usage_storage_info(&root).unwrap().retention_days, 0);

        let connection = open_usage_database_at(&root).unwrap();
        for damaged in ["soon", "-7", "3651"] {
            connection
                .execute(
                    "UPDATE usage_metadata SET value = ?1 WHERE key = ?2",
                    params![damaged, USAGE_RETENTION_DAYS_KEY],
                )
                .unwrap();
            assert_eq!(load_usage_retention_days(&connection).unwrap(), 0);
        }
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retention_prunes_only_events_older_than_the_cutoff_in_bounded_batches() {
        let root = test_root("retention-prune");
        let connection = open_test_database(&root);
        let now = fixed_now();
        let cutoff = now.timestamp_millis() - 7 * MILLIS_PER_DAY;
        for index in 0..10 {
            insert_event(
                &connection,
                &format!("expired-{index}"),
                cutoff - 1 - index * 60_000,
                "hash",
            );
        }
        insert_event(&connection, "at-cutoff", cutoff, "hash");
        insert_event(&connection, "recent", now.timestamp_millis(), "hash");
        let config = GuiConfigFile::default();

        let removed = prune_expired_usage_events(&connection, 7, &config, now, 3).unwrap();

        assert_eq!(removed, 10);
        // 10 rows in batches of 3: the last DELETE removed only the remainder.
        assert_eq!(connection.changes(), 1);
        assert_eq!(event_keys(&connection), vec!["at-cutoff", "recent"]);
        assert_eq!(
            prune_expired_usage_events(&connection, 7, &config, now, 3).unwrap(),
            0
        );
        let far_future = now + chrono::Duration::days(365 * 100);
        assert_eq!(
            prune_expired_usage_events(&connection, 0, &config, far_future, 3).unwrap(),
            0
        );
        assert_eq!(event_count(&connection), 2);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retention_dry_run_counts_without_saving_or_deleting() {
        let root = test_root("retention-dry-run");
        let connection = open_test_database(&root);
        let now = fixed_now();
        for index in 0..4 {
            insert_event(
                &connection,
                &format!("old-{index}"),
                now.timestamp_millis() - (8 + index) * MILLIS_PER_DAY,
                "hash",
            );
        }
        for index in 0..2 {
            insert_event(
                &connection,
                &format!("new-{index}"),
                now.timestamp_millis() - index * MILLIS_PER_DAY,
                "hash",
            );
        }
        drop(connection);
        let config = GuiConfigFile::default();

        let preview = set_usage_retention_at(&root, 7, true, &config, now).unwrap();
        assert_eq!(preview.retention_days, 7);
        assert_eq!(preview.records_affected, 4);
        // The 10-day-old record sits exactly on this cutoff, so it is kept, as pruning keeps it.
        let wider = set_usage_retention_at(&root, 10, true, &config, now).unwrap();
        assert_eq!(wider.records_affected, 1);
        let forever = set_usage_retention_at(&root, 0, true, &config, now).unwrap();
        assert_eq!(forever.records_affected, 0);
        let info = load_usage_storage_info(&root).unwrap();
        assert_eq!(info.retention_days, 0);
        assert_eq!(info.record_count, 6);

        let applied = set_usage_retention_at(&root, 7, false, &config, now).unwrap();
        assert_eq!(applied.records_affected, preview.records_affected);
        let info = load_usage_storage_info(&root).unwrap();
        assert_eq!(info.retention_days, 7);
        assert_eq!(info.record_count, 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retention_statements_use_the_timestamp_index() {
        let connection = schema::test_database();
        for sql in [EXPIRED_USAGE_COUNT_SQL, EXPIRED_USAGE_BATCH_DELETE_SQL] {
            let mut statement = connection
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .unwrap();
            let values = [0_i64, 1_i64];
            let bound = &values[..statement.parameter_count()];
            let plan = statement
                .query_map(params_from_iter(bound), |row| row.get::<_, String>(3))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .join("\n");
            assert!(
                plan.contains("idx_usage_events_timestamp (timestamp_ms<?)"),
                "{sql}\n{plan}"
            );
            assert!(!plan.contains("TEMP B-TREE"), "{sql}\n{plan}");
        }
    }

    #[test]
    fn retention_keeps_the_collector_record_count_exact() {
        let root = test_root("retention-record-count");
        let connection = open_test_database(&root);
        let now = fixed_now();
        for index in 0..5 {
            insert_event(
                &connection,
                &format!("expired-{index}"),
                now.timestamp_millis() - 40 * MILLIS_PER_DAY,
                "hash",
            );
        }
        for index in 0..3 {
            insert_event(
                &connection,
                &format!("kept-{index}"),
                now.timestamp_millis(),
                "hash",
            );
        }
        save_usage_retention_days(&connection, 30).unwrap();
        let state = UsageCollectorState::default();
        state.set_total_records(event_count(&connection));
        drop(connection);

        let removed = enforce_usage_retention_at(&root, &GuiConfigFile::default(), now).unwrap();
        state.adjust_total_records(RecordChanges { removed, ..RecordChanges::default() });

        let connection = open_usage_database_at(&root).unwrap();
        assert_eq!(removed, 5);
        assert_eq!(
            state.status().unwrap().total_records,
            event_count(&connection)
        );
        state.adjust_total_records(RecordChanges { removed: 100, ..RecordChanges::default() });
        assert_eq!(state.status().unwrap().total_records, 0);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retention_drops_machine_assignments_only_for_retired_keys_it_emptied() {
        let root = test_root("retention-assignments");
        let connection = open_test_database(&root);
        let now = fixed_now();
        let expired = now.timestamp_millis() - 10 * MILLIS_PER_DAY;
        let config = GuiConfigFile {
            api_keys: vec![crate::GuiApiKeyEntry {
                key: "live-key".to_string(),
                remark: "Live".to_string(),
            }],
            ..Default::default()
        };
        let live_hash = hash_text("live-key");
        insert_event(&connection, "retired", expired, "retired-hash");
        insert_event(&connection, "live", expired, &live_hash);
        insert_event(&connection, "active-old", expired, "active-hash");
        insert_event(
            &connection,
            "active-new",
            now.timestamp_millis(),
            "active-hash",
        );
        machines::load_assignments(&connection, &config).unwrap();
        connection
            .execute(
                "UPDATE usage_machine_assignments SET machine = 'Mac Mini'",
                [],
            )
            .unwrap();

        let removed = prune_expired_usage_events(&connection, 7, &config, now, 100).unwrap();

        assert_eq!(removed, 3);
        let mut remaining = machines::read_assignments(&connection)
            .unwrap()
            .into_iter()
            .map(|assignment| (assignment.api_key_hash, assignment.machine))
            .collect::<Vec<_>>();
        remaining.sort();
        let mut expected = vec![
            ("active-hash".to_string(), "Mac Mini".to_string()),
            (live_hash, "Mac Mini".to_string()),
        ];
        expected.sort();
        assert_eq!(remaining, expected);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn storage_info_reports_sizes_counts_and_the_oldest_record() {
        let root = test_root("storage-info");
        let connection = open_test_database(&root);
        let empty = load_usage_storage_info(&root).unwrap();
        assert_eq!(empty.record_count, 0);
        assert_eq!(empty.oldest_timestamp, None);

        let now = fixed_now().timestamp_millis();
        insert_event(&connection, "middle", now - 60_000, "hash");
        insert_event(&connection, "oldest", now - 120_000, "hash");
        insert_event(&connection, "newest", now, "hash");
        let stored_oldest = connection
            .query_row(
                "SELECT timestamp FROM usage_events WHERE event_key = 'oldest'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();

        let info = load_usage_storage_info(&root).unwrap();
        let pages = usage_page_counts(&connection).unwrap();
        let database_path = root.join(USAGE_DATABASE_FILE);
        assert_eq!(info.retention_days, 0);
        assert_eq!(info.record_count, 3);
        assert_eq!(info.oldest_timestamp, Some(stored_oldest));
        assert_eq!(info.file_bytes, fs::metadata(&database_path).unwrap().len());
        assert!(info.file_bytes > 0);
        assert_eq!(
            info.wal_bytes,
            file_size(&usage_wal_path(&database_path)).unwrap()
        );
        assert_eq!(info.free_bytes, pages.free_pages * pages.page_size);
        drop(connection);
        assert_eq!(file_size(&root.join("missing.db")).unwrap(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compaction_reclaims_free_pages_and_empties_the_wal() {
        let root = test_root("compaction");
        let mut connection = open_test_database(&root);
        // Keeps these writes in the WAL while the connection stays open, so the
        // compaction starts with a WAL to count.
        connection
            .pragma_update(None, "wal_autocheckpoint", 0)
            .unwrap();
        let now = fixed_now();
        let payload = "x".repeat(4 * 1024);
        let transaction = connection.transaction().unwrap();
        for index in 0..400_i64 {
            let timestamp_ms = if index < 390 {
                now.timestamp_millis() - 30 * MILLIS_PER_DAY - index
            } else {
                now.timestamp_millis() - index
            };
            transaction
                .execute(
                    r#"INSERT INTO usage_events (
                           event_key, timestamp, timestamp_ms, local_hour, failure_body, created_at
                       ) VALUES (?1, '2026-09-01T00:00:00Z', ?2, 'hour', ?3, 'now')"#,
                    params![format!("compaction-{index}"), timestamp_ms, payload],
                )
                .unwrap();
        }
        transaction.commit().unwrap();
        assert_eq!(
            prune_expired_usage_events(&connection, 7, &GuiConfigFile::default(), now, 100)
                .unwrap(),
            390
        );
        let before = load_usage_storage_info(&root).unwrap();
        assert!(before.free_bytes > 1024 * 1024, "{before:?}");
        assert!(before.wal_bytes > 0, "{before:?}");

        let result = compact_usage_database_at(&root).unwrap();

        let after = load_usage_storage_info(&root).unwrap();
        assert!(!result.shrink_pending, "{result:?}");
        assert_eq!(result.bytes_before, before.file_bytes + before.wal_bytes);
        assert!(result.bytes_after < result.bytes_before, "{result:?}");
        assert_eq!(result.bytes_after, after.file_bytes + after.wal_bytes);
        assert_eq!(after.free_bytes, 0);
        assert_eq!(after.wal_bytes, 0);
        assert_eq!(after.record_count, 10);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compaction_needs_about_twice_the_live_data_free() {
        let error =
            ensure_vacuum_disk_space(100 * 1024 * 1024, Some(150 * 1024 * 1024)).unwrap_err();
        assert!(error.contains("200.0 MB"), "{error}");
        assert!(error.contains("150.0 MB"), "{error}");
        assert!(ensure_vacuum_disk_space(100, Some(200)).is_ok());
        assert!(ensure_vacuum_disk_space(100, None).is_ok());
        assert!(available_disk_bytes(&std::env::temp_dir()).is_some_and(|bytes| bytes > 0));
    }

    #[tokio::test]
    async fn exclusive_usage_tasks_run_alone() {
        let active = Arc::new(AtomicUsize::new(0));
        let mut jobs = Vec::new();
        for _ in 0..4 {
            let active = active.clone();
            jobs.push(tokio::spawn(run_usage_task(move || {
                active.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(15));
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(false)
            })));
        }
        let exclusive_active = active.clone();
        jobs.push(tokio::spawn(run_exclusive_usage_task(move || {
            let alone_at_start = exclusive_active.load(Ordering::SeqCst) == 0;
            std::thread::sleep(Duration::from_millis(15));
            Ok(alone_at_start && exclusive_active.load(Ordering::SeqCst) == 0)
        })));
        for _ in 0..4 {
            let active = active.clone();
            jobs.push(tokio::spawn(run_usage_task(move || {
                active.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(15));
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(false)
            })));
        }
        let mut exclusive_ran_alone = false;
        for job in jobs {
            exclusive_ran_alone |= job.await.unwrap().unwrap();
        }
        assert!(exclusive_ran_alone);
    }
}

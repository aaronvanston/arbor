//! Where usage.db lives and how it's opened: its folder, moving that from where older versions kept it, the one-time
//! import of the old JSON files, repairing cached records, and each connection's settings.

use super::*;

pub(super) const USAGE_DIR_NAME: &str = "usage-records";
pub(super) const USAGE_DATABASE_FILE: &str = "usage.db";
pub(super) const USAGE_BACKUP_DIR_NAME: &str = "backups";
pub(super) const LEGACY_USAGE_EVENTS_DIR: &str = "events";
pub(super) const LEGACY_USAGE_INBOX_DIR: &str = "inbox";
pub(super) const LEGACY_JSON_MIGRATION_KEY: &str = "legacy_json_v1";
pub(super) const USAGE_SCHEMA_VERSION: u8 = 1;
pub(super) const SQLITE_BUSY_TIMEOUT_SECONDS: u64 = 5;
/// SQLite's own ceiling for a mapping; the part of a bigger file past it is read as usual.
pub(super) const USAGE_DATABASE_MMAP_BYTES: i64 = 0x7fff_0000;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LegacyUsageHourFile {
    pub(super) schema_version: u8,
    pub(super) records: Vec<UsageRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LegacyUsageInboxFile {
    pub(super) schema_version: u8,
    pub(super) records: Vec<UsageRecord>,
}

#[derive(Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageRepairResult {
    pub(super) scanned: u64,
    pub(super) repaired: u64,
    pub(super) deleted: u64,
    pub(super) backup_path: Option<String>,
}

pub(crate) fn initialize_usage_storage() -> Result<(), String> {
    let root = usage_root_dir()?;
    migrate_legacy_usage_storage(&root)?;
    prepare_usage_storage(&root)
}

pub(super) fn migrate_legacy_usage_storage(target: &Path) -> Result<(), String> {
    let legacy = executable_dir()?.join(USAGE_DIR_NAME);
    migrate_usage_storage_directory(&legacy, target)
}

pub(super) fn migrate_usage_storage_directory(source: &Path, target: &Path) -> Result<(), String> {
    if source == target || !source.is_dir() || target.exists() {
        return Ok(());
    }
    let target_parent = target
        .parent()
        .ok_or_else(|| "Usage history destination has no parent directory".to_string())?;
    fs::create_dir_all(target_parent)
        .map_err(|error| format!("Failed to create usage history migration destination: {error}"))?;
    if fs::rename(source, target).is_ok() {
        return Ok(());
    }

    if let Err(error) = copy_usage_storage_directory(source, target) {
        let _ = fs::remove_dir_all(target);
        return Err(format!("Failed to migrate legacy usage history: {error}"));
    }
    if let Err(error) = fs::remove_dir_all(source) {
        eprintln!(
            "Legacy usage history copied, but failed to remove the original directory {}: {error}",
            source.display()
        );
    }
    Ok(())
}

pub(super) fn copy_usage_storage_directory(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("Failed to create usage history directory: {error}"))?;
    let entries = fs::read_dir(source).map_err(|error| format!("Failed to read legacy usage history: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read legacy usage history entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to read legacy usage history entry type: {error}"))?;
        let destination = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_usage_storage_directory(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &destination)
                .map_err(|error| format!("Failed to copy legacy usage history: {error}"))?;
        } else {
            return Err(format!(
                "Legacy usage history contains an unsupported file type: {}",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

pub(super) fn initialize_usage_storage_at(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| format!("Failed to create usage history directory: {error}"))?;
    let mut connection = connect_usage_database(root)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("Failed to enable SQLite WAL: {error}"))?;
    schema::migrate(&mut connection, root)?;
    migrate_legacy_json_storage(&mut connection, root)?;
    // Without the write lock: this runs holding PREPARED_USAGE_STORAGE, and a writer that took the write lock
    // before opening usage.db, as compaction does, waits for that. Nothing else has usage.db open until it's set up.
    delete_old_inbox_rows(&connection, Local::now())
}

#[tauri::command]
pub(crate) async fn repair_usage_cache_records(
    app: tauri::AppHandle,
) -> Result<UsageRepairResult, String> {
    let result = run_usage_task(|| repair_usage_cache_records_at(&usage_root_dir()?)).await?;
    publish_record_changes(
        &app,
        RecordChanges { removed: result.deleted, rewritten: result.repaired, ..RecordChanges::default() },
    );
    Ok(result)
}

pub(super) fn repair_usage_cache_records_at(root: &Path) -> Result<UsageRepairResult, String> {
    let mut connection = open_usage_database_at(root)?;
    // Like every other write, so the collector waits instead of failing busy.
    let _writes = lock_usage_writes();
    let candidate_count: i64 = connection
        .query_row(
            r#"SELECT COUNT(*) FROM usage_events
               WHERE lower(trim(model)) = 'unknown'
                  OR (input_tokens > 0
                      AND cache_read_tokens + cache_creation_tokens > input_tokens
                      AND (lower(executor_type) = 'claudeexecutor'
                           OR lower(provider) = 'claude'
                           OR lower(provider) LIKE '%anthropic%'))"#,
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to check historical usage records for invalid rows: {error}"))?;

    if candidate_count <= 0 {
        return Ok(UsageRepairResult::default());
    }

    let backup_path = {
        let backup_dir = root.join(USAGE_BACKUP_DIR_NAME);
        fs::create_dir_all(&backup_dir)
            .map_err(|error| format!("Failed to create Claude usage history migration backup directory: {error}"))?;
        let backup_path = backup_dir.join(format!(
            "usage-before-history-repair-v2-{}.db",
            unique_file_stamp()
        ));
        connection
            .execute(
                "VACUUM INTO ?1",
                params![backup_path.to_string_lossy().to_string()],
            )
            .map_err(|error| format!("Failed to back up Claude usage history: {error}"))?;
        backup_path.to_string_lossy().to_string()
    };

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start Claude usage history migration transaction: {error}"))?;
    let migrated = transaction
        .execute(
            r#"UPDATE usage_events
               SET input_tokens = input_tokens + cache_read_tokens + cache_creation_tokens,
                   total_tokens = CASE
                       WHEN total_tokens = 0
                            OR total_tokens = input_tokens + output_tokens
                       THEN input_tokens + cache_read_tokens + cache_creation_tokens + output_tokens
                       ELSE total_tokens
                   END,
                   cached_tokens = MAX(cached_tokens, cache_read_tokens + cache_creation_tokens)
               WHERE input_tokens > 0
                 AND cache_read_tokens + cache_creation_tokens > input_tokens
                 AND lower(trim(model)) <> 'unknown'
                 AND (lower(executor_type) = 'claudeexecutor'
                      OR lower(provider) = 'claude'
                      OR lower(provider) LIKE '%anthropic%')"#,
            [],
        )
        .map_err(|error| format!("Failed to migrate Claude usage history: {error}"))?;
    let deleted = transaction
        .execute(
            "DELETE FROM usage_events WHERE lower(trim(model)) = 'unknown'",
            [],
        )
        .map_err(|error| format!("Failed to delete historical unknown records: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit Claude usage history migration: {error}"))?;
    Ok(UsageRepairResult {
        scanned: candidate_count.max(0) as u64,
        repaired: migrated as u64,
        deleted: deleted as u64,
        backup_path: Some(backup_path),
    })
}

pub(super) fn open_usage_database() -> Result<Connection, String> {
    open_usage_database_at(&usage_root_dir()?)
}

/// The usage.db folders set up this launch.
pub(super) static PREPARED_USAGE_STORAGE: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Default::default);

/// Sets usage.db up once a launch, whoever asks first: startup, or a page that
/// opens it before startup gets there. Anyone else asking meanwhile waits, so
/// nothing finds a table missing.
pub(super) fn prepare_usage_storage(root: &Path) -> Result<(), String> {
    let mut prepared = PREPARED_USAGE_STORAGE
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if !prepared.contains(root) {
        initialize_usage_storage_at(root)?;
        prepared.insert(root.to_path_buf());
    }
    Ok(())
}

pub(super) fn open_usage_database_at(root: &Path) -> Result<Connection, String> {
    prepare_usage_storage(root)?;
    connect_usage_database(root)
}

/// Opens usage.db as it is, for setting it up.
pub(super) fn connect_usage_database(root: &Path) -> Result<Connection, String> {
    fs::create_dir_all(root).map_err(|error| format!("Failed to create usage history directory: {error}"))?;
    let path = root.join(USAGE_DATABASE_FILE);
    let connection = Connection::open(&path)
        .map_err(|error| format!("Failed to open SQLite usage history database {}: {error}", path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(SQLITE_BUSY_TIMEOUT_SECONDS))
        .map_err(|error| format!("Failed to set SQLite busy timeout: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("Failed to enable SQLite foreign keys: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| format!("Failed to set SQLite synchronous mode: {error}"))?;
    // Each read opens its own connection, so SQLite's page cache starts empty
    // every time. Mapped, the file is read straight from the system's cache,
    // which stays warm between reads. Sorting and grouping stay in memory too.
    connection
        .pragma_update(None, "mmap_size", USAGE_DATABASE_MMAP_BYTES)
        .map_err(|error| format!("Failed to map the SQLite usage history database: {error}"))?;
    connection
        .pragma_update(None, "temp_store", "MEMORY")
        .map_err(|error| format!("Failed to set SQLite temp store: {error}"))?;
    Ok(connection)
}

pub(super) fn migrate_legacy_json_storage(connection: &mut Connection, root: &Path) -> Result<(), String> {
    let migrated = connection
        .query_row(
            "SELECT value FROM usage_metadata WHERE key = ?1",
            params![LEGACY_JSON_MIGRATION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read legacy usage history migration status: {error}"))?
        .is_some();
    if migrated {
        return Ok(());
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start legacy usage history migration transaction: {error}"))?;
    let mut migrated_records = 0_usize;

    for path in sorted_json_files(&root.join(LEGACY_USAGE_EVENTS_DIR))? {
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read legacy usage history {}: {error}", path.display()))?;
        let file = serde_json::from_str::<LegacyUsageHourFile>(&content)
            .map_err(|error| format!("Failed to parse legacy usage history {}: {error}", path.display()))?;
        validate_legacy_schema(file.schema_version, &path)?;
        migrated_records = migrated_records.saturating_add(insert_usage_records_in_transaction(
            &transaction,
            &file.records,
        )?);
    }

    for path in sorted_json_files(&root.join(LEGACY_USAGE_INBOX_DIR))? {
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read legacy usage history inbox {}: {error}", path.display()))?;
        let file = serde_json::from_str::<LegacyUsageInboxFile>(&content)
            .map_err(|error| format!("Failed to parse legacy usage history inbox {}: {error}", path.display()))?;
        validate_legacy_schema(file.schema_version, &path)?;
        migrated_records = migrated_records.saturating_add(insert_usage_records_in_transaction(
            &transaction,
            &file.records,
        )?);
    }

    transaction
        .execute(
            "INSERT INTO usage_metadata (key, value) VALUES (?1, ?2)",
            params![LEGACY_JSON_MIGRATION_KEY, migrated_records.to_string()],
        )
        .map_err(|error| format!("Failed to record legacy usage history migration status: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit legacy usage history migration: {error}"))?;
    Ok(())
}

pub(super) fn sorted_json_files(directory: &Path) -> Result<Vec<PathBuf>, String> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut paths = fs::read_dir(directory)
        .map_err(|error| format!("Failed to read legacy usage history directory {}: {error}", directory.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

pub(super) fn validate_legacy_schema(version: u8, path: &Path) -> Result<(), String> {
    if version == USAGE_SCHEMA_VERSION {
        Ok(())
    } else {
        Err(format!(
            "Unsupported legacy usage history version {version}: {}",
            path.display()
        ))
    }
}

pub(super) fn usage_root_dir() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join(USAGE_DIR_NAME))
}

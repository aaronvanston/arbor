//! The usage collector: takes the core's usage queue (subscribed, or polled while a subscription can't be had),
//! keeps each message in the inbox table until it decodes, and writes the records into usage.db.

use super::*;

pub(super) const MAX_USAGE_FAILURE_BODY_CHARS: usize = 2_000;
pub(super) const USAGE_QUEUE_BATCH_SIZE: usize = 500;
pub(super) const USAGE_INBOX_PROCESS_LIMIT: usize = 500;
pub(super) const USAGE_INBOX_MAX_ATTEMPTS: i64 = 5;
pub(super) const USAGE_SUBSCRIBE_RETRY_SECONDS: u64 = 30;
/// Each batch is taken out of the inbox as it's saved, so the inbox only keeps records whose save failed or was cut
/// short. It's looked at on start, straight after a failed save, and otherwise this seldom.
pub(super) const USAGE_INBOX_RECOVERY_INTERVAL: Duration = Duration::from_secs(30);
/// Whether the core is up is read from its config, its port and the process list. Without the live subscription
/// that's checked often, to reconnect soon; with it, the subscription dropping says the core went, so seldom.
pub(super) const CORE_CHECK_INTERVAL: Duration = Duration::from_secs(2);
pub(super) const CORE_CHECK_INTERVAL_SUBSCRIBED: Duration = Duration::from_secs(30);
pub(crate) struct UsageCollectorState {
    pub(super) inner: Mutex<UsageCollectorInner>,
}

pub(super) struct UsageCollectorInner {
    pub(super) token: Option<CancellationToken>,
    pub(super) status: UsageCollectorStatus,
}

#[derive(Debug)]
pub(super) struct UsageInboxRow {
    pub(super) id: i64,
    pub(super) source: String,
    pub(super) raw_message: String,
    pub(super) attempt_count: i64,
}

impl Default for UsageCollectorState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(UsageCollectorInner {
                token: None,
                status: UsageCollectorStatus::waiting(),
            }),
        }
    }
}

/// Whether the core's requests are being copied into usage.db.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CollectorState {
    WaitingCore,
    Collecting,
    Error,
}

/// What `get_usage_collector_status` reports about copying the core's requests into the local database.
#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageCollectorStatus {
    pub(super) state: CollectorState,
    pub(super) message: String,
    pub(super) last_collected_at: Option<String>,
    pub(super) total_records: u64,
}

impl UsageCollectorStatus {
    pub(super) fn waiting() -> Self {
        Self {
            state: CollectorState::WaitingCore,
            message: "Waiting for core to start".to_string(),
            last_collected_at: None,
            total_records: 0,
        }
    }
}

impl UsageCollectorState {
    pub(super) fn start(&self) -> Option<CancellationToken> {
        let mut inner = self.inner.lock().ok()?;
        if inner.token.is_some() {
            return None;
        }
        let token = CancellationToken::new();
        inner.token = Some(token.clone());
        Some(token)
    }

    pub(super) fn stop(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(token) = inner.token.take() {
                token.cancel();
            }
        }
    }

    pub(super) fn set_status(&self, status: UsageCollectorStatus) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status = status;
        }
    }

    pub(super) fn set_total_records(&self, total_records: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status.total_records = total_records;
        }
    }

    /// Adjusting the running count, rather than recounting, cannot race a
    /// collector insert whose adjustment has not landed yet.
    pub(super) fn adjust_total_records(&self, changes: RecordChanges) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status.total_records = inner
                .status
                .total_records
                .saturating_add(changes.added)
                .saturating_sub(changes.removed);
        }
    }

    pub(super) fn status(&self) -> Result<UsageCollectorStatus, String> {
        self.inner
            .lock()
            .map(|inner| inner.status.clone())
            .map_err(|_| "Usage collector state lock is poisoned".to_string())
    }
}

pub(crate) fn start_usage_collector(app: tauri::AppHandle) {
    let state = app.state::<UsageCollectorState>();
    // Prune before counting, so the cached total starts out exact.
    storage::apply_startup_usage_retention(&app);
    if let Ok(total_records) = total_usage_records() {
        state.set_total_records(total_records);
    }
    let Some(token) = state.start() else {
        return;
    };
    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(usage_collector_loop(app, token));
    });
}

pub(crate) fn stop_usage_collector(app: &tauri::AppHandle) {
    app.state::<UsageCollectorState>().stop();
}

/// Whether the live subscription was opened with a port or management key that has since changed.
pub(super) fn subscription_settings_changed(
    opened_with: Option<&(u16, String)>,
    config: &GuiConfigFile,
) -> bool {
    opened_with.is_some_and(|(port, secret)| {
        *port != config.port || secret != &config.management_secret_key
    })
}

pub(super) async fn usage_collector_loop(app: tauri::AppHandle, token: CancellationToken) {
    let root = match usage_root_dir() {
        Ok(root) => root,
        Err(error) => {
            set_collector_error(&app, error);
            return;
        }
    };

    let mut retry_seconds = 1_u64;
    let mut subscription: Option<UsageSubscription> = None;
    // The port and management secret the live subscription was opened with.
    let mut subscription_config: Option<(u16, String)> = None;
    let mut subscribe_retry_at = tokio::time::Instant::now();
    let mut next_inbox_cleanup_at = tokio::time::Instant::now() + Duration::from_secs(60 * 60);
    let mut next_inbox_recovery_at = tokio::time::Instant::now();
    let mut next_core_check_at = tokio::time::Instant::now();
    let mut core_ready = false;
    loop {
        if token.is_cancelled() {
            return;
        }
        let config = match app.state::<GuiConfigState>().snapshot() {
            Ok(config) => config,
            Err(error) => {
                set_collector_error(&app, error);
                wait_or_cancel(&token, retry_seconds).await;
                retry_seconds = (retry_seconds * 2).min(10);
                continue;
            }
        };
        // A new port or rotated management key leaves the open subscription pointing at the old
        // endpoint or authenticated with the old key, so reconnect with the current settings.
        if subscription_settings_changed(subscription_config.as_ref(), &config) {
            subscription = None;
            subscription_config = None;
            subscribe_retry_at = tokio::time::Instant::now();
        }
        if tokio::time::Instant::now() >= next_inbox_cleanup_at {
            if let Err(error) = open_usage_database_at(&root)
                .and_then(|connection| cleanup_usage_inbox(&connection, Local::now()))
            {
                eprintln!("Failed to clean up usage history inbox: {error}");
            }
            storage::apply_usage_retention(&app, &root, &config);
            next_inbox_cleanup_at = tokio::time::Instant::now() + Duration::from_secs(60 * 60);
        }
        if tokio::time::Instant::now() >= next_inbox_recovery_at {
            let recovered = open_usage_database_at(&root)
                .and_then(|mut connection| process_usage_inbox(&mut connection, &config));
            match recovered {
                Ok(saved) if saved > 0 => {
                    set_collector_status(
                        &app,
                        CollectorState::Collecting,
                        &format!("Recovered {saved} pending records"),
                        Some(Local::now().to_rfc3339()),
                    );
                    publish_record_changes(&app, RecordChanges { added: saved as u64, ..RecordChanges::default() });
                    retry_seconds = 1;
                    continue;
                }
                Ok(_) => {
                    next_inbox_recovery_at = tokio::time::Instant::now() + USAGE_INBOX_RECOVERY_INTERVAL;
                }
                Err(error) => {
                    set_collector_error(&app, error);
                    wait_or_cancel(&token, retry_seconds).await;
                    retry_seconds = (retry_seconds * 2).min(10);
                    continue;
                }
            }
        }
        if tokio::time::Instant::now() >= next_core_check_at {
            let process_state = app.state::<CoreProcessState>();
            core_ready = current_core_status(Some(process_state.inner()), Some(config.port))
                .map(|status| status.ready)
                .unwrap_or(false);
            let interval = if subscription.is_some() { CORE_CHECK_INTERVAL_SUBSCRIBED } else { CORE_CHECK_INTERVAL };
            next_core_check_at = tokio::time::Instant::now() + interval;
        }
        if !core_ready {
            subscription = None;
            subscription_config = None;
            // Resubscribe as soon as the core is back rather than waiting out a retry delay left
            // over from before it went away.
            subscribe_retry_at = tokio::time::Instant::now();
            set_collector_status(&app, CollectorState::WaitingCore, "Waiting for core to start", None);
            retry_seconds = 1;
            wait_or_cancel(&token, 1).await;
            continue;
        }

        if subscription.is_none() && tokio::time::Instant::now() >= subscribe_retry_at {
            match UsageSubscription::connect(config.port, &config.management_secret_key).await {
                Ok(next_subscription) => {
                    subscription = Some(next_subscription);
                    subscription_config = Some((config.port, config.management_secret_key.clone()));
                    set_collector_status(&app, CollectorState::Collecting, "Connected to CPA usage live subscription", None);
                    match backfill_usage_queue(&root, &config).await {
                        Ok(saved) => {
                            publish_collected_records(
                                &app,
                                saved,
                                &format!("Live subscription connected, backfilled {saved} queued records"),
                            );
                            retry_seconds = 1;
                        }
                        Err(error) => {
                            set_collector_status(
                                &app,
                                CollectorState::Collecting,
                                &format!("Live subscription connected, failed to backfill historical queue: {error}"),
                                None,
                            );
                        }
                    }
                    continue;
                }
                Err(error) => {
                    subscribe_retry_at = tokio::time::Instant::now()
                        + Duration::from_secs(USAGE_SUBSCRIBE_RETRY_SECONDS);
                    set_collector_status(
                        &app,
                        CollectorState::Collecting,
                        &format!("Collecting in HTTP compatibility mode; live subscription unavailable: {error}"),
                        None,
                    );
                }
            }
        }

        if let Some(active_subscription) = subscription.as_mut() {
            let message = tokio::select! {
                _ = token.cancelled() => return,
                result = tokio::time::timeout(
                    Duration::from_secs(2),
                    active_subscription.next_message(),
                ) => result,
            };
            match message {
                Ok(Ok(payload)) => {
                    match persist_raw_usage_message_from_source(
                        &root,
                        "redis_subscribe:usage",
                        payload,
                        &config,
                    ) {
                        Ok(saved) => {
                            publish_collected_records(
                                &app,
                                saved,
                                &format!("Live subscription saved {saved} new records"),
                            );
                            retry_seconds = 1;
                        }
                        Err(error) => {
                            set_collector_error(&app, error);
                            next_inbox_recovery_at = tokio::time::Instant::now();
                            wait_or_cancel(&token, retry_seconds).await;
                            retry_seconds = (retry_seconds * 2).min(10);
                        }
                    }
                    continue;
                }
                Err(_) => {
                    set_collector_status(&app, CollectorState::Collecting, "Collecting from CPA usage live subscription", None);
                    retry_seconds = 1;
                    continue;
                }
                Ok(Err(error)) => {
                    subscription = None;
                    subscription_config = None;
                    subscribe_retry_at = tokio::time::Instant::now()
                        + Duration::from_secs(USAGE_SUBSCRIBE_RETRY_SECONDS);
                    // The stream usually drops because the core stopped or restarted. Check the
                    // core straight away: if it is down, the not-ready branch clears this delay,
                    // so the collector resubscribes once the core is back instead of staying in
                    // HTTP mode.
                    next_core_check_at = tokio::time::Instant::now();
                    set_collector_status(
                        &app,
                        CollectorState::Collecting,
                        &format!("Live subscription disconnected, switched to HTTP compatibility mode: {error}"),
                        None,
                    );
                }
            }
        }

        match fetch_usage_queue(&config).await {
            Ok(items) if items.is_empty() => {
                set_collector_status(&app, CollectorState::Collecting, "Collecting usage records", None);
                retry_seconds = 1;
                wait_or_cancel(&token, 1).await;
            }
            Ok(items) => match persist_queue_items(&root, items, &config) {
                Ok(saved) => {
                    publish_collected_records(
                        &app,
                        saved,
                        &format!("HTTP compatibility mode saved {saved} new records"),
                    );
                    retry_seconds = 1;
                }
                Err(error) => {
                    set_collector_error(&app, error);
                    next_inbox_recovery_at = tokio::time::Instant::now();
                    wait_or_cancel(&token, retry_seconds).await;
                    retry_seconds = (retry_seconds * 2).min(10);
                }
            },
            Err(error) => {
                set_collector_error(&app, error);
                wait_or_cancel(&token, retry_seconds).await;
                retry_seconds = (retry_seconds * 2).min(10);
            }
        }
    }
}

pub(super) async fn backfill_usage_queue(root: &Path, config: &GuiConfigFile) -> Result<usize, String> {
    let mut saved_total = 0_usize;
    loop {
        let items = fetch_usage_queue(config).await?;
        let fetched = items.len();
        if fetched == 0 {
            return Ok(saved_total);
        }
        saved_total = saved_total.saturating_add(persist_queue_items_from_source(
            root,
            "http_backfill",
            items,
            config,
        )?);
        if fetched < USAGE_QUEUE_BATCH_SIZE {
            return Ok(saved_total);
        }
    }
}

pub(super) fn publish_collected_records(app: &tauri::AppHandle, saved: usize, message: &str) {
    set_collector_status(
        app,
        CollectorState::Collecting,
        message,
        (saved > 0).then(|| Local::now().to_rfc3339()),
    );
    publish_record_changes(app, RecordChanges { added: saved as u64, ..RecordChanges::default() });
}

pub(super) async fn wait_or_cancel(token: &CancellationToken, seconds: u64) {
    tokio::select! {
        _ = token.cancelled() => {},
        _ = tokio::time::sleep(Duration::from_secs(seconds)) => {},
    }
}

pub(super) async fn fetch_usage_queue(config: &GuiConfigFile) -> Result<Vec<Value>, String> {
    let client = management_http_client()?;
    let response = send_management(
        client
            .get(management_endpoint(config, "usage-queue")?)
            .header("Authorization", management_authorization(config)?)
            .query(&[("count", USAGE_QUEUE_BATCH_SIZE)]),
    )
    .await
    .map_err(|error| format_management_request_error("Failed to read CPA usage queue", &error))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format_management_request_error("Failed to read CPA usage response", &error))?;
    if !status.is_success() {
        return Err(format!(
            "CPA usage queue returned HTTP {}: {}",
            status.as_u16(),
            text.trim()
        ));
    }
    serde_json::from_str::<Vec<Value>>(&text)
        .map_err(|error| format!("Failed to parse CPA usage records: {error}"))
}

pub(super) fn set_collector_error(app: &tauri::AppHandle, error: String) {
    set_collector_status(app, CollectorState::Error, &error, None);
}

pub(super) fn set_collector_status(
    app: &tauri::AppHandle,
    state_name: CollectorState,
    message: &str,
    last_collected_at: Option<String>,
) {
    let state = app.state::<UsageCollectorState>();
    let previous = state.status().ok();
    let total_records = previous
        .as_ref()
        .map(|value| value.total_records)
        .unwrap_or(0);
    state.set_status(UsageCollectorStatus {
        state: state_name,
        message: message.to_string(),
        last_collected_at: last_collected_at
            .or_else(|| previous.and_then(|value| value.last_collected_at)),
        total_records,
    });
}

pub(super) fn persist_queue_items(
    root: &Path,
    items: Vec<Value>,
    config: &GuiConfigFile,
) -> Result<usize, String> {
    persist_queue_items_from_source(root, "http_pull", items, config)
}

pub(super) fn persist_queue_items_from_source(
    root: &Path,
    source: &str,
    items: Vec<Value>,
    config: &GuiConfigFile,
) -> Result<usize, String> {
    let mut connection = open_usage_database_at(root)?;
    enqueue_usage_queue_items(&mut connection, source, items)?;
    process_usage_inbox(&mut connection, config)
}

pub(super) fn enqueue_usage_queue_items(
    connection: &mut Connection,
    source: &str,
    items: Vec<Value>,
) -> Result<usize, String> {
    let messages = items
        .into_iter()
        .map(|item| {
            serde_json::to_string(&item)
                .map_err(|error| format!("Failed to serialize CPA usage records: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    enqueue_usage_raw_messages(connection, source, messages)
}

pub(super) fn enqueue_usage_raw_messages(
    connection: &mut Connection,
    source: &str,
    messages: Vec<String>,
) -> Result<usize, String> {
    let messages = messages
        .into_iter()
        .filter(|message| !is_ignorable_usage_message(message))
        .collect::<Vec<_>>();
    if messages.is_empty() {
        return Ok(0);
    }
    let _write_guard = lock_usage_writes();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start SQLite usage inbox transaction: {error}"))?;
    let mut statement = transaction
        .prepare(
            r#"
            INSERT INTO usage_inbox (
                source, message_hash, raw_message, status, attempt_count,
                received_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, 'pending', 0, ?4, ?4, ?4)
            "#,
        )
        .map_err(|error| format!("Failed to prepare SQLite usage inbox write: {error}"))?;
    let received_at = Local::now().to_rfc3339();
    let mut inserted = 0_usize;
    for raw_message in messages {
        inserted = inserted.saturating_add(
            statement
                .execute(params![
                    source,
                    hash_text(&raw_message),
                    raw_message,
                    received_at,
                ])
                .map_err(|error| format!("Failed to write SQLite usage inbox: {error}"))?,
        );
    }
    drop(statement);
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit SQLite usage inbox: {error}"))?;
    Ok(inserted)
}

pub(super) fn is_ignorable_usage_message(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return true;
    }
    if trimmed.contains("\"request_id\"") {
        return false;
    }

    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return false;
    };
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.len() != 1 {
        return false;
    }
    object
        .get("refresh")
        .and_then(Value::as_bool)
        .is_some_and(|enabled| enabled)
        || object
            .get("support_refresh")
            .and_then(Value::as_bool)
            .is_some_and(|enabled| enabled)
}

pub(super) fn persist_raw_usage_message_from_source(
    root: &Path,
    source: &str,
    raw_message: String,
    config: &GuiConfigFile,
) -> Result<usize, String> {
    let mut connection = open_usage_database_at(root)?;
    enqueue_usage_raw_messages(&mut connection, source, vec![raw_message])?;
    process_usage_inbox(&mut connection, config)
}

pub(super) fn process_usage_inbox(
    connection: &mut Connection,
    config: &GuiConfigFile,
) -> Result<usize, String> {
    let _write_guard = lock_usage_writes();
    let rows = list_processable_usage_inbox(connection, USAGE_INBOX_PROCESS_LIMIT)?;
    if rows.is_empty() {
        return Ok(0);
    }
    let mut valid_rows = Vec::with_capacity(rows.len());
    let mut records = Vec::with_capacity(rows.len());
    for row in rows {
        let parsed = serde_json::from_str::<Value>(&row.raw_message)
            .map_err(|error| format!("Failed to parse inbox JSON: {error}"))
            .and_then(|value| normalize_usage_record(value, config));
        match parsed {
            Ok(mut record) => {
                record.collector_source = row.source.clone();
                valid_rows.push(row);
                records.push(record);
            }
            Err(error) => mark_usage_inbox_decode_failed(connection, row.id, &error)?,
        }
    }
    if records.is_empty() {
        return Ok(0);
    }

    let persist_result = (|| -> Result<usize, String> {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("Failed to start SQLite inbox processing transaction: {error}"))?;
        let inserted = insert_usage_records_in_transaction(&transaction, &records)?;
        let processed_at = Local::now().to_rfc3339();
        for (row, record) in valid_rows.iter().zip(records.iter()) {
            transaction
                .execute(
                    r#"
                    UPDATE usage_inbox
                    SET status = 'processed', attempt_count = attempt_count + 1,
                        last_error = '', usage_event_key = ?1,
                        processed_at = ?2, updated_at = ?2
                    WHERE id = ?3
                    "#,
                    params![record.id, processed_at, row.id],
                )
                .map_err(|error| format!("Failed to mark SQLite usage inbox as processed: {error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("Failed to commit SQLite inbox processing transaction: {error}"))?;
        Ok(inserted)
    })();
    match persist_result {
        Ok(inserted) => Ok(inserted),
        Err(error) => {
            mark_usage_inbox_process_failed(connection, &valid_rows, &error)?;
            Err(error)
        }
    }
}

pub(super) fn list_processable_usage_inbox(
    connection: &Connection,
    limit: usize,
) -> Result<Vec<UsageInboxRow>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, source, raw_message, attempt_count
            FROM usage_inbox
            WHERE status IN ('pending', 'process_failed')
              AND attempt_count < ?1
            ORDER BY id ASC
            LIMIT ?2
            "#,
        )
        .map_err(|error| format!("Failed to prepare to read SQLite usage inbox: {error}"))?;
    let rows = statement
        .query_map(
            params![
                USAGE_INBOX_MAX_ATTEMPTS,
                limit.min(i64::MAX as usize) as i64
            ],
            |row| {
                Ok(UsageInboxRow {
                    id: row.get(0)?,
                    source: row.get(1)?,
                    raw_message: row.get(2)?,
                    attempt_count: row.get(3)?,
                })
            },
        )
        .map_err(|error| format!("Failed to query SQLite usage inbox: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read SQLite usage inbox: {error}"))?;
    Ok(rows)
}

pub(super) fn mark_usage_inbox_decode_failed(
    connection: &Connection,
    id: i64,
    error: &str,
) -> Result<(), String> {
    let now = Local::now().to_rfc3339();
    connection
        .execute(
            r#"
            UPDATE usage_inbox
            SET status = 'decode_failed', attempt_count = attempt_count + 1,
                last_error = ?1, processed_at = ?2, updated_at = ?2
            WHERE id = ?3
            "#,
            params![bounded_usage_inbox_error(error), now, id],
        )
        .map(|_| ())
        .map_err(|update_error| {
            format!("Failed to mark SQLite usage inbox decoding failure: {update_error}")
        })
}

pub(super) fn mark_usage_inbox_process_failed(
    connection: &Connection,
    rows: &[UsageInboxRow],
    error: &str,
) -> Result<(), String> {
    let now = Local::now().to_rfc3339();
    let error = bounded_usage_inbox_error(error);
    for row in rows {
        let next_attempt = row.attempt_count.saturating_add(1);
        let status = if next_attempt >= USAGE_INBOX_MAX_ATTEMPTS {
            "discarded"
        } else {
            "process_failed"
        };
        connection
            .execute(
                r#"
                UPDATE usage_inbox
                SET status = ?1, attempt_count = ?2, last_error = ?3,
                    processed_at = CASE WHEN ?1 = 'discarded' THEN ?4 ELSE NULL END,
                    updated_at = ?4
                WHERE id = ?5
                "#,
                params![status, next_attempt, error, now, row.id],
            )
            .map_err(|update_error| {
                format!("Failed to mark SQLite usage inbox processing failure: {update_error}")
            })?;
    }
    Ok(())
}

pub(super) fn bounded_usage_inbox_error(error: &str) -> String {
    error.chars().take(1_000).collect()
}

pub(super) fn cleanup_usage_inbox(connection: &Connection, now: DateTime<Local>) -> Result<(), String> {
    let _write_guard = lock_usage_writes();
    delete_old_inbox_rows(connection, now)
}

/// Clears inbox rows done with: processed before today, and failed or discarded a week ago.
pub(super) fn delete_old_inbox_rows(connection: &Connection, now: DateTime<Local>) -> Result<(), String> {
    let processed_cutoff = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|value| value.and_local_timezone(Local).single())
        .unwrap_or(now)
        .to_rfc3339();
    let failed_cutoff = (now - chrono::Duration::days(7)).to_rfc3339();
    connection
        .execute(
            "DELETE FROM usage_inbox WHERE status = 'processed' AND processed_at < ?1",
            params![processed_cutoff],
        )
        .map_err(|error| format!("Failed to clean up processed usage inbox entries: {error}"))?;
    connection
        .execute(
            "DELETE FROM usage_inbox WHERE status IN ('decode_failed', 'discarded') AND updated_at < ?1",
            params![failed_cutoff],
        )
        .map_err(|error| format!("Failed to clean up failed usage inbox entries: {error}"))?;
    Ok(())
}

#[cfg(test)]
pub(super) fn insert_usage_records(
    connection: &mut Connection,
    records: &[UsageRecord],
) -> Result<usize, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start SQLite usage history transaction: {error}"))?;
    let inserted = insert_usage_records_in_transaction(&transaction, records)?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit SQLite usage history: {error}"))?;
    Ok(inserted)
}

pub(super) fn insert_usage_records_in_transaction(
    transaction: &Transaction<'_>,
    records: &[UsageRecord],
) -> Result<usize, String> {
    if records.is_empty() {
        return Ok(0);
    }
    let mut statement = transaction
        .prepare(
            r#"
            INSERT INTO usage_events (
                event_key, timestamp, timestamp_ms, local_hour, latency_ms, ttft_ms,
                source, auth_index, failed, provider, model, alias, reasoning_effort,
                service_tier, response_service_tier, executor_type, endpoint, auth_type,
                api_key_hash, api_key_display, api_key_remark, request_id,
                api_group_key, model_alias, client_ip, x_forwarded_for, user_agent,
                generate, cached_tokens, collector_source,
                input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
                cache_creation_tokens, total_tokens, canceled, failure_status,
                failure_body, created_at, session_id, parent_session_id,
                response_model, node_kind, is_fork, is_compaction
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30,
                ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40,
                ?41, ?42, ?43, ?44, ?45, ?46
            )
            "#,
        )
        .map_err(|error| format!("Failed to prepare SQLite usage history write: {error}"))?;
    let created_at = Local::now().to_rfc3339();
    let mut inserted = 0_usize;
    for record in records {
        let api_group_key = if !record.api_group_key.trim().is_empty() {
            record.api_group_key.as_str()
        } else if !record.api_key_hash.trim().is_empty() {
            record.api_key_hash.as_str()
        } else if !record.provider.trim().is_empty() {
            record.provider.as_str()
        } else if !record.endpoint.trim().is_empty() {
            record.endpoint.as_str()
        } else {
            "unknown"
        };
        let cache_components = record
            .tokens
            .cache_read_tokens
            .saturating_add(record.tokens.cache_creation_tokens);
        let input_before_invariant = record.tokens.input_tokens;
        let input_tokens = if cache_components > input_before_invariant {
            input_before_invariant.saturating_add(cache_components)
        } else {
            input_before_invariant
        };
        let total_tokens = if record.tokens.total_tokens == 0
            || record.tokens.total_tokens
                == input_before_invariant.saturating_add(record.tokens.output_tokens)
        {
            input_tokens.saturating_add(record.tokens.output_tokens)
        } else {
            record.tokens.total_tokens
        };
        let cached_tokens = record.cached_tokens.max(cache_components);
        let collector_source = if record.collector_source.trim().is_empty() {
            "legacy_json"
        } else {
            record.collector_source.as_str()
        };
        inserted = inserted.saturating_add(
            statement
                .execute(params![
                    record.id,
                    record.timestamp,
                    record_timestamp_millis(record),
                    record_local_hour(record),
                    to_sql_i64(record.latency_ms),
                    record.ttft_ms.map(to_sql_i64),
                    record.source,
                    record.auth_index,
                    record.failed,
                    record.provider,
                    record.model,
                    record.alias,
                    record.reasoning_effort,
                    record.service_tier,
                    record.response_service_tier,
                    record.executor_type,
                    record.endpoint,
                    record.auth_type,
                    record.api_key_hash,
                    record.api_key_display,
                    record.api_key_remark,
                    record.request_id,
                    api_group_key,
                    if record.alias.trim().is_empty() {
                        None::<&str>
                    } else {
                        Some(record.alias.as_str())
                    },
                    record.client_ip,
                    record.x_forwarded_for,
                    record.user_agent,
                    record.generate,
                    to_sql_i64(cached_tokens),
                    collector_source,
                    to_sql_i64(input_tokens),
                    to_sql_i64(record.tokens.output_tokens),
                    to_sql_i64(record.tokens.reasoning_tokens),
                    to_sql_i64(record.tokens.cache_read_tokens),
                    to_sql_i64(record.tokens.cache_creation_tokens),
                    to_sql_i64(total_tokens),
                    record.canceled,
                    i64::from(record.failure_status),
                    record.failure_body,
                    created_at,
                    record.lineage.session_id,
                    record.lineage.parent_session_id,
                    record.lineage.response_model,
                    record.lineage.node_kind,
                    record.lineage.is_fork,
                    record.lineage.is_compaction,
                ])
                .map_err(|error| format!("Failed to write SQLite usage history: {error}"))?,
        );
    }
    Ok(inserted)
}

pub(super) fn normalize_usage_record(value: Value, config: &GuiConfigFile) -> Result<UsageRecord, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "CPA usage record must be a JSON object".to_string())?;
    let timestamp = usage_record_timestamp(object).unwrap_or_else(|| Local::now().to_rfc3339());
    let request_id = string_field(object, "request_id")
        .ok_or_else(|| "CPA usage record must contain request_id".to_string())?;
    let api_key = string_field(object, "api_key").unwrap_or_default();
    let api_key_hash = hash_text(&api_key);
    let api_key_remark = config
        .api_keys
        .iter()
        .find(|entry| entry.key == api_key)
        .map(|entry| entry.remark.clone())
        .unwrap_or_default();
    let provider = string_field(object, "provider").unwrap_or_default();
    let executor_type = string_field(object, "executor_type").unwrap_or_default();
    let tokens_object = object.get("tokens").and_then(Value::as_object);
    let cache_read_present = tokens_object
        .and_then(|tokens| tokens.get("cache_read_tokens"))
        .is_some();
    let raw_cache_read_tokens = token_u64(tokens_object, "cache_read_tokens");
    let cache_creation_tokens = token_u64(tokens_object, "cache_creation_tokens");
    let raw_cached_tokens =
        token_u64(tokens_object, "cached_tokens").max(token_u64(tokens_object, "cache_tokens"));
    let normalized_cache_read_tokens = if cache_read_present {
        raw_cache_read_tokens
    } else {
        raw_cached_tokens
    };
    let raw_input_tokens = token_u64(tokens_object, "input_tokens");
    let mut tokens = UsageTokenStats {
        input_tokens: raw_input_tokens,
        output_tokens: token_u64(tokens_object, "output_tokens"),
        reasoning_tokens: token_u64(tokens_object, "reasoning_tokens"),
        cache_read_tokens: normalized_cache_read_tokens,
        cache_creation_tokens,
        total_tokens: token_u64(tokens_object, "total_tokens"),
    };

    let provider_lower = provider.to_ascii_lowercase();
    let is_claude_executor = executor_type.eq_ignore_ascii_case("ClaudeExecutor")
        || provider_lower == "claude"
        || provider_lower.contains("anthropic");
    let cache_components = tokens
        .cache_read_tokens
        .saturating_add(tokens.cache_creation_tokens);
    let raw_total_without_cache = raw_input_tokens.saturating_add(tokens.output_tokens);
    let raw_total_with_cache = raw_total_without_cache.saturating_add(cache_components);
    let claude_excludes_cache = is_claude_executor
        && cache_components > 0
        && (raw_input_tokens < cache_components || tokens.total_tokens == raw_total_with_cache);
    if claude_excludes_cache {
        tokens.input_tokens = raw_input_tokens
            .saturating_add(tokens.cache_read_tokens)
            .saturating_add(tokens.cache_creation_tokens);
    }
    let input_before_invariant = tokens.input_tokens;
    if cache_components > input_before_invariant {
        tokens.input_tokens = input_before_invariant.saturating_add(cache_components);
        if tokens.total_tokens == 0
            || tokens.total_tokens == input_before_invariant.saturating_add(tokens.output_tokens)
        {
            tokens.total_tokens = tokens.input_tokens.saturating_add(tokens.output_tokens);
        }
    }
    if tokens.total_tokens == 0
        || (claude_excludes_cache && tokens.total_tokens == raw_total_without_cache)
    {
        tokens.total_tokens = tokens.input_tokens.saturating_add(tokens.output_tokens);
    }
    let id = request_id.clone();
    let endpoint = string_field(object, "endpoint").unwrap_or_default();
    let failed = object
        .get("failed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let (failure_status, failure_body) = usage_failure_details(object);
    let canceled = failed && usage_failure_is_canceled(failure_status, &failure_body);
    let generate = object
        .get("generate")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            !(executor_type == "CodexWebsocketsExecutor"
                && !failed
                && tokens.input_tokens == 0
                && tokens.output_tokens == 0
                && tokens.reasoning_tokens == 0
                && tokens.cache_read_tokens == 0
                && tokens.cache_creation_tokens == 0
                && tokens.total_tokens == 0)
        });
    let api_group_key = if api_key_hash.is_empty() {
        if !provider.is_empty() {
            provider.clone()
        } else if !endpoint.is_empty() {
            endpoint.clone()
        } else {
            "unknown".to_string()
        }
    } else {
        api_key_hash.clone()
    };
    Ok(UsageRecord {
        id,
        timestamp,
        latency_ms: u64_field(object, "latency_ms"),
        ttft_ms: optional_u64_field(object, "ttft_ms"),
        source: string_field(object, "source").unwrap_or_default(),
        source_display: String::new(),
        auth_index: string_field(object, "auth_index").unwrap_or_default(),
        failed,
        canceled,
        failure_status,
        failure_body,
        provider,
        api_group_key,
        model: string_field(object, "model").unwrap_or_else(|| "unknown".to_string()),
        alias: string_field(object, "alias").unwrap_or_default(),
        client_ip: string_field(object, "client_ip"),
        machine: String::new(),
        pool: String::new(),
        x_forwarded_for: string_field(object, "x_forwarded_for"),
        user_agent: string_field(object, "user_agent"),
        reasoning_effort: string_field(object, "reasoning_effort").unwrap_or_default(),
        service_tier: string_field(object, "service_tier").unwrap_or_default(),
        response_service_tier: string_field(object, "response_service_tier").unwrap_or_default(),
        executor_type,
        endpoint,
        auth_type: string_field(object, "auth_type").unwrap_or_default(),
        api_key_hash,
        api_key_display: mask_api_key(&api_key),
        api_key_remark,
        request_id,
        generate,
        cached_tokens: raw_cached_tokens.max(
            tokens
                .cache_read_tokens
                .saturating_add(tokens.cache_creation_tokens),
        ),
        collector_source: "http_pull".to_string(),
        tokens,
        lineage: UsageLineage::from_record(object),
    })
}

/// The record's own timestamp as stored in `usage_events.timestamp`, when it
/// is valid RFC 3339.
pub(super) fn usage_record_timestamp(object: &serde_json::Map<String, Value>) -> Option<String> {
    string_field(object, "timestamp").filter(|value| DateTime::parse_from_rfc3339(value).is_ok())
}

pub(super) fn usage_failure_body(value: &Value) -> String {
    let body = match value {
        Value::String(value) => value.trim().to_string(),
        Value::Null => String::new(),
        value => serde_json::to_string(value).unwrap_or_default(),
    };
    if body.chars().count() <= MAX_USAGE_FAILURE_BODY_CHARS {
        body
    } else {
        let mut bounded = body
            .chars()
            .take(MAX_USAGE_FAILURE_BODY_CHARS)
            .collect::<String>();
        bounded.push('…');
        bounded
    }
}

pub(super) fn usage_failure_details(object: &serde_json::Map<String, Value>) -> (u16, String) {
    let failure = object.get("fail").and_then(Value::as_object);
    let status = failure
        .and_then(|value| value.get("status_code").or_else(|| value.get("statusCode")))
        .and_then(Value::as_u64)
        .unwrap_or_default()
        .min(u16::MAX as u64) as u16;
    let body = failure
        .and_then(|value| value.get("body"))
        .map(usage_failure_body)
        .unwrap_or_default();
    (status, body)
}

pub(super) fn usage_failure_is_canceled(status: u16, body: &str) -> bool {
    if status == 499 {
        return true;
    }
    let body = body.to_ascii_lowercase();
    body.contains("context canceled") || body.contains("client closed request")
}

pub(super) fn default_usage_generate() -> bool {
    true
}

#[tauri::command]
pub(crate) fn get_usage_collector_status(
    state: tauri::State<'_, UsageCollectorState>,
) -> Result<UsageCollectorStatus, String> {
    state.status()
}

use super::*;

pub(crate) fn validate_core_api_key(api_key: &str) -> Result<(), String> {
    if api_key.is_empty() {
        return Err("Authentication key cannot be empty".to_string());
    }
    if !api_key.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
        return Err("Authentication key must contain only visible ASCII characters without spaces".to_string());
    }
    if is_example_core_api_key(api_key) {
        return Err("Cannot use the example authentication key from the core template".to_string());
    }
    Ok(())
}

pub(crate) fn validate_api_key_remark(remark: &str) -> Result<(), String> {
    if remark.chars().count() > 80 {
        return Err("Key remark cannot exceed 80 characters".to_string());
    }
    if remark.chars().any(char::is_control) {
        return Err("Key remark cannot contain newlines or control characters".to_string());
    }
    Ok(())
}

pub(crate) fn validate_api_access_provider_section(section: &str) -> Result<(), String> {
    if matches!(
        section,
        "gemini-api-key" | "codex-api-key" | "claude-api-key" | "openai-compatibility"
    ) {
        Ok(())
    } else {
        Err("Invalid API access type".to_string())
    }
}

pub(crate) fn api_access_key_hash(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| sha256_bytes(value.as_bytes()))
}

pub(crate) fn usage_provider_section(provider: &str) -> Option<&'static str> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "codex" => Some("codex-api-key"),
        "claude" => Some("claude-api-key"),
        "gemini" | "aistudio" => Some("gemini-api-key"),
        "openai" | "openai-compatibility" => Some("openai-compatibility"),
        _ => None,
    }
}

impl GuiConfigFile {
    pub(crate) fn api_access_remark_for_source(
        &self,
        provider: &str,
        source: &str,
    ) -> Option<&str> {
        let hash = api_access_key_hash(source)?;
        let preferred_section = usage_provider_section(provider);
        self.api_access_remarks
            .iter()
            .find(|entry| {
                preferred_section == Some(entry.provider_section.as_str())
                    && entry.api_key_hash == hash
                    && !entry.remark.is_empty()
            })
            .or_else(|| {
                self.api_access_remarks
                    .iter()
                    .find(|entry| entry.api_key_hash == hash && !entry.remark.is_empty())
            })
            .map(|entry| entry.remark.as_str())
    }
}

pub(crate) fn validate_management_secret_key(secret_key: &str) -> Result<(), String> {
    if secret_key.chars().count() > 512 {
        return Err("Management key cannot exceed 512 characters".to_string());
    }
    if secret_key.chars().any(char::is_control) {
        return Err("Management key cannot contain control characters".to_string());
    }
    Ok(())
}

pub(crate) fn validate_strong_management_secret_key(secret_key: &str) -> Result<(), String> {
    validate_management_secret_key(secret_key)?;
    if secret_key.trim().is_empty() {
        return Err("WebUI key cannot be empty".to_string());
    }
    if secret_key.trim() == LEGACY_DEFAULT_MANAGEMENT_SECRET_KEY {
        return Err("The legacy default WebUI key 123456 can no longer be used".to_string());
    }
    if is_hashed_management_secret_key(secret_key) {
        return Err("GUI configuration must store a plaintext WebUI key for management API authentication".to_string());
    }
    Ok(())
}

pub(crate) fn generate_management_secret_key() -> Result<String, String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

    let mut random = [0_u8; 32];
    getrandom::fill(&mut random).map_err(|error| format!("Failed to generate a secure WebUI key: {error}"))?;
    Ok(format!("wui-Aa9_{}", URL_SAFE_NO_PAD.encode(random)))
}

pub(crate) fn management_secret_requires_rotation(secret_key: &str) -> bool {
    let secret_key = secret_key.trim();
    secret_key.is_empty()
        || secret_key == LEGACY_DEFAULT_MANAGEMENT_SECRET_KEY
        || is_hashed_management_secret_key(secret_key)
}

pub(crate) fn ensure_strong_management_secret(config: &mut GuiConfigFile) -> Result<bool, String> {
    if !management_secret_requires_rotation(&config.management_secret_key) {
        return Ok(false);
    }
    config.management_secret_key = generate_management_secret_key()?;
    Ok(true)
}

pub(crate) fn normalize_management_secret_key(secret_key: String) -> Result<String, String> {
    let secret_key = secret_key.trim().to_string();
    validate_strong_management_secret_key(&secret_key)?;
    Ok(secret_key)
}

pub(crate) fn is_example_core_api_key(api_key: &str) -> bool {
    let value = api_key.trim();
    value == "your-api-key" || value.starts_with("your-api-key-")
}

pub(crate) fn is_hashed_management_secret_key(secret_key: &str) -> bool {
    let value = secret_key.trim();
    value.starts_with("$2a$")
        || value.starts_with("$2b$")
        || value.starts_with("$2y$")
        || value.starts_with("$argon2")
        || value.starts_with("$scrypt$")
        || value.starts_with("bcrypt:")
        || value.starts_with("argon2:")
        || value.starts_with("argon2id:")
        || value.starts_with("sha256:")
        || value.starts_with("sha512:")
}

pub(crate) fn validate_routing_strategy(strategy: &str) -> Result<(), String> {
    if matches!(strategy, "round-robin" | "fill-first") {
        return Ok(());
    }
    Err("Routing strategy only supports round-robin or fill-first".to_string())
}

pub(crate) fn normalize_optional_config_string(
    value: String,
    field_name: &str,
) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.chars().any(char::is_control) {
        return Err(format!("{field_name} cannot contain control characters"));
    }
    Ok(value)
}

/// The session TTL as the core reads it: a Go duration above zero ("30m", "1h30m"), or blank for the core's default.
/// The core quietly uses its default for anything else, so a typo would look saved and do nothing.
pub(crate) fn normalize_session_affinity_ttl(value: String) -> Result<String, String> {
    let value = normalize_optional_config_string(value, "Session affinity TTL")?;
    if value.is_empty() || go_duration_nanos(&value).is_some_and(|nanos| nanos > 0.0 && nanos < i64::MAX as f64) {
        return Ok(value);
    }
    Err("Session affinity TTL must be a length of time such as 30m or 1h30m, or blank for the proxy's default".to_string())
}

/// What Go's `time.ParseDuration` makes of `text`, in nanoseconds, for the non-negative durations it accepts.
fn go_duration_nanos(text: &str) -> Option<f64> {
    const UNITS: [(&str, f64); 8] = [
        ("ns", 1.0),
        ("us", 1e3),
        ("µs", 1e3),
        ("μs", 1e3),
        ("ms", 1e6),
        ("s", 1e9),
        ("m", 60e9),
        ("h", 3600e9),
    ];
    let mut rest = text.strip_prefix('+').unwrap_or(text);
    match rest {
        "" => return None,
        "0" => return Some(0.0),
        _ => {}
    }
    let mut nanos = 0.0;
    while !rest.is_empty() {
        let number_end = rest.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(rest.len());
        let (number, after) = rest.split_at(number_end);
        if !number.chars().any(|c| c.is_ascii_digit()) || number.matches('.').count() > 1 {
            return None;
        }
        let (unit, scale) = UNITS.into_iter().find(|(unit, _)| after.starts_with(unit))?;
        nanos += number.parse::<f64>().ok()? * scale;
        rest = &after[unit.len()..];
    }
    Some(nanos)
}

pub(crate) fn normalize_core_tls_settings(
    settings: CoreTlsSettings,
) -> Result<CoreTlsSettings, String> {
    let cert = normalize_optional_config_string(settings.cert, "TLS certificate path")?;
    let key = normalize_optional_config_string(settings.key, "TLS private key path")?;
    if settings.enabled && (cert.is_empty() || key.is_empty()) {
        return Err(
            "TLS is enabled, so both the certificate and private key paths are required"
                .to_string(),
        );
    }
    Ok(CoreTlsSettings {
        enabled: settings.enabled,
        cert,
        key,
    })
}

#[cfg(test)]
pub(crate) fn core_loopback_origin(port: u16, tls_enabled: bool) -> String {
    core_origin("127.0.0.1", port, tls_enabled)
}

pub(crate) fn core_connect_host(listen_host: &str) -> String {
    let host = listen_host
        .trim()
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or_else(|| listen_host.trim());
    match host {
        "" | "0.0.0.0" => "127.0.0.1".to_string(),
        "::" => "::1".to_string(),
        _ => host.to_string(),
    }
}

pub(crate) fn core_origin(listen_host: &str, port: u16, tls_enabled: bool) -> String {
    let scheme = if tls_enabled { "https" } else { "http" };
    let host = core_connect_host(listen_host);
    let url_host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host
    };
    format!("{scheme}://{url_host}:{port}")
}

pub(crate) fn managed_core_tls_enabled() -> bool {
    #[cfg(test)]
    {
        false
    }
    #[cfg(not(test))]
    {
        current_core_tls_settings()
            .map(|settings| settings.enabled)
            .unwrap_or(false)
    }
}

pub(crate) fn managed_core_loopback_origin(port: u16) -> String {
    #[cfg(test)]
    {
        core_loopback_origin(port, false)
    }
    #[cfg(not(test))]
    {
        let host = read_installed_core_config_settings()
            .map(|settings| settings.host)
            .unwrap_or_else(|_| "127.0.0.1".to_string());
        core_origin(&host, port, managed_core_tls_enabled())
    }
}

pub(crate) fn config_update_error_with_rollback(
    error: String,
    rollback_error: Option<String>,
) -> String {
    match rollback_error {
        Some(rollback_error) => format!("{error}; failed to roll back core configuration as well: {rollback_error}"),
        None => error,
    }
}

/// The config.yaml the core starts on. A first one is the template with Arbor's first-run settings; one that's there
/// keeps its own, and only gets what the core needs for Arbor to reach it (see `keep_core_config_reachable`).
pub(crate) fn merge_core_config_yaml(
    template: &str,
    current: Option<&str>,
    config: &GuiConfigFile,
) -> Result<String, String> {
    match current.filter(|content| core_config_has_settings(content)) {
        Some(current) => keep_core_config_reachable(current, config),
        None => apply_gui_managed_settings(&merge_core_config_fields(template, None)?, config),
    }
}

/// Whether a config.yaml holds anything: an empty file, or one of only comments, is started over from the template.
/// One that won't parse is somebody's file all the same, and is left for the core to report on.
fn core_config_has_settings(content: &str) -> bool {
    match serde_norway::from_str::<serde_norway::Value>(content) {
        Ok(serde_norway::Value::Null) => false,
        Ok(serde_norway::Value::Mapping(mapping)) => !mapping.is_empty(),
        _ => true,
    }
}

pub(crate) fn merge_core_config_fields(
    template: &str,
    current: Option<&str>,
) -> Result<String, String> {
    let current_value = current
        .map(|current| {
            let current = serde_norway::from_str::<serde_norway::Value>(current)
                .map_err(|err| format!("Failed to parse existing core configuration; writing stopped to prevent configuration loss: {err}"))?;
            if !current.is_mapping() {
                return Err("Existing core configuration root must be a YAML mapping; writing stopped".to_string());
            }
            Ok(current)
        })
        .transpose()?;
    merge_core_config_value(template, current_value)
}

pub(crate) fn merge_core_config_value(
    template: &str,
    current: Option<serde_norway::Value>,
) -> Result<String, String> {
    let template_value = serde_norway::from_str::<serde_norway::Value>(template)
        .map_err(|err| format!("Failed to parse core configuration template: {err}"))?;
    if !template_value.is_mapping() {
        return Err("Core configuration template root must be a YAML mapping".to_string());
    }
    let mut merged = template_value.clone();

    if let Some(current) = current {
        merge_yaml_values(&mut merged, current);
    }

    let rendered = render_yaml_value_changes(template, &template_value, &merged)?;
    let rendered_value = serde_norway::from_str::<serde_norway::Value>(&rendered)
        .map_err(|err| format!("Failed to validate migrated core configuration: {err}"))?;
    if !rendered_value.is_mapping() {
        return Err("Migrated core configuration root must be a YAML mapping".to_string());
    }
    Ok(rendered)
}

pub(crate) fn patch_core_network_endpoint_yaml(
    content: &str,
    config: &GuiConfigFile,
) -> Result<Option<String>, String> {
    patch_core_yaml_document(content, |document| {
        let original = document.clone();
        apply_network_settings(document, config)?;
        set_core_yaml_schema_value(
            document,
            &["proxy-url"],
            &["requests", "proxy-url"],
            serde_norway::Value::String(config.proxy_url.clone()),
        )?;
        Ok(*document != original)
    })
}

pub(crate) fn patch_core_retry_yaml(
    content: &str,
    config: &GuiConfigFile,
) -> Result<Option<String>, String> {
    patch_core_yaml_document(content, |document| {
        let original = document.clone();
        set_core_yaml_schema_value(
            document,
            &["disable-cooling"],
            &["routing", "cooldown", "disable-cooling"],
            serde_norway::Value::Bool(config.disable_cooling),
        )?;
        set_core_yaml_schema_value(
            document,
            &["request-retry"],
            &["routing", "retry", "request-retry"],
            serde_norway::to_value(config.request_retry).map_err(|err| err.to_string())?,
        )?;
        set_core_yaml_schema_value(
            document,
            &["max-retry-credentials"],
            &["routing", "retry", "max-retry-credentials"],
            serde_norway::to_value(config.max_retry_credentials).map_err(|err| err.to_string())?,
        )?;
        set_core_yaml_schema_value(
            document,
            &["max-retry-interval"],
            &["routing", "retry", "max-retry-interval"],
            serde_norway::to_value(config.max_retry_interval).map_err(|err| err.to_string())?,
        )?;
        set_core_yaml_schema_value(
            document,
            &["streaming", "bootstrap-retries"],
            &["requests", "streaming", "bootstrap-retries"],
            serde_norway::to_value(config.streaming_bootstrap_retries)
                .map_err(|err| err.to_string())?,
        )?;
        Ok(*document != original)
    })
}

pub(crate) fn patch_core_session_routing_yaml(
    content: &str,
    config: &GuiConfigFile,
) -> Result<Option<String>, String> {
    patch_core_yaml_document(content, |document| {
        let original = document.clone();
        set_core_yaml_nested_value(
            document,
            "routing",
            "session-affinity",
            serde_norway::Value::Bool(config.routing_session_affinity),
        )?;
        set_core_yaml_nested_value(
            document,
            "routing",
            "session-affinity-ttl",
            serde_norway::Value::String(config.routing_session_affinity_ttl.clone()),
        )?;
        Ok(*document != original)
    })
}

pub(crate) fn merge_yaml_values(base: &mut serde_norway::Value, current: serde_norway::Value) {
    match (base, current) {
        (
            serde_norway::Value::Mapping(base_mapping),
            serde_norway::Value::Mapping(current_mapping),
        ) => {
            for (key, current_value) in current_mapping {
                if let Some(base_value) = base_mapping.get_mut(&key) {
                    merge_yaml_values(base_value, current_value);
                } else {
                    base_mapping.insert(key, current_value);
                }
            }
        }
        (base, current) => *base = current,
    }
}

pub(crate) fn apply_network_settings(
    document: &mut serde_norway::Value,
    config: &GuiConfigFile,
) -> Result<(), String> {
    let host = config.host.trim();
    set_core_yaml_schema_value(
        document,
        &["host"],
        &["server", "host"],
        serde_norway::Value::String(host.to_string()),
    )?;
    set_core_yaml_schema_value(
        document,
        &["port"],
        &["server", "port"],
        serde_norway::to_value(config.port).map_err(|err| format!("Failed to serialize core port: {err}"))?,
    )?;
    Ok(())
}

pub(crate) fn apply_gui_managed_settings(
    content: &str,
    config: &GuiConfigFile,
) -> Result<String, String> {
    let host = config.host.trim();
    let updated = patch_core_yaml_document(content, |document| {
        let mut changed = false;
        changed |= set_core_yaml_schema_value(
            document,
            &["host"],
            &["server", "host"],
            serde_norway::Value::String(host.to_string()),
        )?;
        changed |= set_core_yaml_schema_value(
            document,
            &["port"],
            &["server", "port"],
            serde_norway::to_value(config.port)
                .map_err(|err| format!("Failed to serialize core port: {err}"))?,
        )?;
        changed |= set_core_yaml_auth_dir(document, &config.auth_dir)?;
        changed |= set_core_yaml_schema_value(
            document,
            &["debug"],
            &["observability", "logs", "debug"],
            serde_norway::Value::Bool(config.debug),
        )?;
        changed |= set_core_yaml_schema_value(
            document,
            &["commercial-mode"],
            &["server", "commercial-mode"],
            serde_norway::Value::Bool(config.commercial_mode),
        )?;
        changed |= set_core_yaml_schema_value(
            document,
            &["logging-to-file"],
            &["observability", "logs", "logging-to-file"],
            serde_norway::Value::Bool(config.logging_to_file),
        )?;
        changed |= set_core_yaml_schema_value(
            document,
            &["logs-max-total-size-mb"],
            &["observability", "logs", "logs-max-total-size-mb"],
            serde_norway::to_value(config.logs_max_total_size_mb)
                .map_err(|err| format!("Failed to serialize log size limit: {err}"))?,
        )?;
        changed |= set_core_yaml_schema_value(
            document,
            &["error-logs-max-files"],
            &["observability", "logs", "error-logs-max-files"],
            serde_norway::to_value(config.error_logs_max_files)
                .map_err(|err| format!("Failed to serialize error log retention count: {err}"))?,
        )?;
        changed |= set_core_yaml_schema_value(
            document,
            &["usage-statistics-enabled"],
            &["observability", "usage", "usage-statistics-enabled"],
            serde_norway::Value::Bool(config.usage_statistics_enabled),
        )?;
        changed |= set_core_yaml_schema_value(
            document,
            &["redis-usage-queue-retention-seconds"],
            &["observability", "usage", "redis-usage-queue-retention-seconds"],
            serde_norway::to_value(config.redis_usage_queue_retention_seconds)
                .map_err(|err| format!("Failed to serialize Redis usage queue retention period: {err}"))?,
        )?;
        changed |= set_core_yaml_schema_value(
            document,
            &["request-log"],
            &["observability", "logs", "request-log"],
            serde_norway::Value::Bool(config.request_log),
        )?;
        changed |= set_core_yaml_schema_value(
            document,
            &["remote-management", "secret-key"],
            &["management", "secret-key"],
            serde_norway::Value::String(config.management_secret_key.clone()),
        )?;
        changed |= set_core_yaml_nested_value(
            document,
            "plugins",
            "enabled",
            serde_norway::Value::Bool(config.plugins_enabled),
        )?;
        changed |= set_core_yaml_nested_value(
            document,
            "routing",
            "strategy",
            serde_norway::Value::String(config.routing_strategy.clone()),
        )?;
        changed |= set_core_yaml_schema_value(
            document,
            &["proxy-url"],
            &["requests", "proxy-url"],
            serde_norway::Value::String(config.proxy_url.clone()),
        )?;
        changed |= set_core_yaml_nested_value(
            document,
            "routing",
            "session-affinity",
            serde_norway::Value::Bool(config.routing_session_affinity),
        )?;
        changed |= set_core_yaml_nested_value(
            document,
            "routing",
            "session-affinity-ttl",
            serde_norway::Value::String(config.routing_session_affinity_ttl.clone()),
        )?;
        changed |= set_core_yaml_schema_value(
            document,
            &["disable-cooling"],
            &["routing", "cooldown", "disable-cooling"],
            serde_norway::Value::Bool(config.disable_cooling),
        )?;
        changed |= set_core_yaml_schema_value(
            document,
            &["request-retry"],
            &["routing", "retry", "request-retry"],
            serde_norway::to_value(config.request_retry)
                .map_err(|err| format!("Failed to serialize request retry count: {err}"))?,
        )?;
        changed |= set_core_yaml_schema_value(
            document,
            &["max-retry-credentials"],
            &["routing", "retry", "max-retry-credentials"],
            serde_norway::to_value(config.max_retry_credentials)
                .map_err(|err| format!("Failed to serialize maximum retry credentials: {err}"))?,
        )?;
        changed |= set_core_yaml_schema_value(
            document,
            &["max-retry-interval"],
            &["routing", "retry", "max-retry-interval"],
            serde_norway::to_value(config.max_retry_interval)
                .map_err(|err| format!("Failed to serialize maximum retry wait time: {err}"))?,
        )?;
        changed |= set_core_yaml_schema_value(
            document,
            &["streaming", "bootstrap-retries"],
            &["requests", "streaming", "bootstrap-retries"],
            serde_norway::to_value(config.streaming_bootstrap_retries)
                .map_err(|err| format!("Failed to serialize streaming bootstrap retry count: {err}"))?,
        )?;
        Ok(changed)
    })?
    .unwrap_or_else(|| content.to_string());

    let updated = patch_core_api_keys_yaml(&updated, &gui_api_key_values(&config.api_keys))?;
    serde_norway::from_str::<serde_norway::Value>(&updated)
        .map_err(|err| format!("Failed to validate startup core configuration: {err}"))?;
    Ok(updated)
}

pub(crate) fn write_bytes_directly(path: &Path, content: &[u8]) -> Result<(), String> {
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(directory)
        .map_err(|error| format!("Failed to create configuration directory {}: {error}", path_to_string(directory)))?;

    let write_result = (|| -> io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(path)?;
        file.seek(SeekFrom::Start(0))?;
        file.write_all(content)?;
        file.set_len(content.len() as u64)?;
        file.sync_all()
    })();

    write_result.map_err(|error| format!("Failed to write configuration directly {}: {error}", path_to_string(path)))?;
    remember_software_write(path, content);
    Ok(())
}

pub(crate) fn write_bytes_atomically(path: &Path, content: &[u8]) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(directory)
        .map_err(|error| format!("Failed to create configuration directory {}: {error}", path_to_string(directory)))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config.yaml");
    let temporary_path = directory.join(format!(
        ".{file_name}.tmp.{}.{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));

    let write_result = (|| -> io::Result<()> {
        let mut file = File::create(&temporary_path)?;
        file.write_all(content)?;
        file.sync_all()?;
        // ReplaceFileW requires the replacement file handle to be closed.
        // Unix rename permits replacing an open file, so this otherwise only
        // surfaces on Windows as ERROR_SHARING_VIOLATION (os error 32).
        drop(file);
        replace_file_atomically(&temporary_path, path)
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!(
            "Failed to write configuration atomically {}: {error}",
            path_to_string(path)
        ));
    }

    remember_software_write(path, content);

    Ok(())
}

pub(crate) fn normalized_config_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub(crate) fn remember_software_write(path: &Path, content: &[u8]) {
    if let Ok(mut hashes) = CONFIG_WRITE_HASHES.lock() {
        hashes.insert(normalized_config_path(path), sha256_bytes(content));
    }
}

pub(crate) fn consume_software_write(path: &Path) -> bool {
    let Ok(content) = fs::read(path) else {
        return false;
    };
    let key = normalized_config_path(path);
    let hash = sha256_bytes(&content);
    let Ok(mut hashes) = CONFIG_WRITE_HASHES.lock() else {
        return false;
    };
    hashes
        .remove(&key)
        .is_some_and(|expected_hash| expected_hash == hash)
}

pub(crate) fn write_yaml_if_changed(path: &Path, content: &str) -> Result<bool, String> {
    let current = fs::read_to_string(path).ok();
    if current.as_deref() == Some(content) {
        return Ok(false);
    }
    if let Some(current) = current.as_deref() {
        back_up_old_layout_core_config(path, current)?;
    }

    write_bytes_atomically(path, content.as_bytes())?;

    Ok(true)
}

/// Keeps a config.yaml in the old, pre-v8 layout as it was, once, before Arbor first changes it: Arbor writes each
/// setting at its v8 path and takes the old spelling out, so the file moves over a setting at a time. A file the core
/// wrote itself is marked v8 and never gets here; an old one comes from a restored backup.
fn back_up_old_layout_core_config(path: &Path, current: &str) -> Result<(), String> {
    let old_layout = serde_norway::from_str::<serde_norway::Value>(current)
        .is_ok_and(|document| document.as_mapping().is_some_and(|root| !root.is_empty()) && !core_config_uses_v8(&document));
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return Ok(());
    };
    let backup = path.with_file_name(format!("{name}{OLD_LAYOUT_BACKUP_SUFFIX}"));
    if !old_layout || backup.exists() {
        return Ok(());
    }
    write_bytes_atomically(&backup, current.as_bytes())
        .map_err(|error| format!("Failed to back up the old-layout core configuration: {error}"))
}

pub(crate) const OLD_LAYOUT_BACKUP_SUFFIX: &str = ".pre-v8";

pub(crate) fn replace_file_atomically(
    temporary_path: &Path,
    destination_path: &Path,
) -> io::Result<()> {
    fs::rename(temporary_path, destination_path)
}

pub(crate) fn fixed_oauth_dir() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join(OAUTH_DIR_NAME))
}

pub(crate) fn auth_dir_path_for_core(auth_dir: &str, install_dir: &Path) -> PathBuf {
    if auth_dir.trim() == DEFAULT_AUTH_DIR {
        return install_dir
            .parent()
            .map(|parent| parent.join(OAUTH_DIR_NAME))
            .unwrap_or_else(|| install_dir.join(auth_dir));
    }
    // The core expands a leading "~" (the v8 template's default is "~/.cli-proxy-api"); joining it onto the
    // install folder would point Arbor at a literal "~" directory the core never uses.
    if let (Some(remainder), Some(home)) = (
        auth_dir.trim().strip_prefix('~'),
        env::var_os("HOME").filter(|home| !home.is_empty()),
    ) {
        if remainder.is_empty() || remainder.starts_with(['/', '\\']) {
            return PathBuf::from(home).join(remainder.trim_start_matches(['/', '\\']));
        }
    }
    let auth_dir = PathBuf::from(auth_dir);
    if auth_dir.is_absolute() {
        auth_dir
    } else {
        install_dir.join(auth_dir)
    }
}

pub(crate) fn core_logs_dir_path(auth_dir: &str, install_dir: &Path) -> PathBuf {
    auth_dir_path_for_core(auth_dir, install_dir).join("logs")
}

/// Where the core writes its own logs (main.log with logging to file on, request and error logs). It takes a `logs`
/// folder in its working folder, where Arbor starts it, only when that folder already exists and it can write there,
/// and otherwise the one beside its credentials, where Arbor keeps its output. Nothing here makes the folder, as that
/// would move the core's logs at its next start.
pub(crate) fn core_own_logs_dir_path(auth_dir: &str, install_dir: &Path) -> PathBuf {
    let beside_core = install_dir.join("logs");
    let writable = fs::metadata(&beside_core)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.permissions().readonly());
    if writable {
        beside_core
    } else {
        core_logs_dir_path(auth_dir, install_dir)
    }
}

fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                } else if !normalized.has_root() {
                    normalized.push(component.as_os_str());
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

pub(crate) fn auth_dir_is_inside_macos_app_bundle(path: &Path) -> bool {
    let normalized = normalize_path_lexically(path);
    let mut previous_component_was_app = false;
    for component in normalized.components() {
        let Component::Normal(name) = component else {
            previous_component_was_app = false;
            continue;
        };
        if previous_component_was_app && name == std::ffi::OsStr::new("Contents") {
            return true;
        }
        previous_component_was_app = Path::new(name)
            .extension()
            .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("app"));
    }
    false
}

fn copy_auth_file_atomically(source: &Path, destination: &Path) -> Result<(), String> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!(
                    "OAuth migration destination is not a regular file: {}",
                    path_to_string(destination)
                ));
            }
            let source_bytes = fs::read(source).map_err(|error| {
                format!("Failed to read legacy OAuth file {}: {error}", path_to_string(source))
            })?;
            let destination_bytes = fs::read(destination).map_err(|error| {
                format!(
                    "Failed to read existing OAuth file {}: {error}",
                    path_to_string(destination)
                )
            })?;
            if source_bytes == destination_bytes {
                return Ok(());
            }
            return Err(format!(
                "OAuth migration destination already contains different content; not overwritten: {}",
                path_to_string(destination)
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to inspect OAuth migration destination {}: {error}",
                path_to_string(destination)
            ));
        }
    }

    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let directory = destination.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(directory).map_err(|error| {
        format!(
            "Failed to create OAuth migration directory {}: {error}",
            path_to_string(directory)
        )
    })?;
    let file_name = destination
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "oauth".into());
    let temporary_path = directory.join(format!(
        ".{file_name}.migration.{}.{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));

    let copy_result = (|| -> io::Result<()> {
        fs::copy(source, &temporary_path)?;
        let temporary_file = fs::OpenOptions::new().write(true).open(&temporary_path)?;
        temporary_file.sync_all()?;
        drop(temporary_file);
        fs::rename(&temporary_path, destination)
    })();
    if let Err(error) = copy_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!(
            "Failed to copy OAuth file {} -> {}: {error}",
            path_to_string(source),
            path_to_string(destination)
        ));
    }
    Ok(())
}

fn copy_auth_directory(source: &Path, destination: &Path) -> Result<(), String> {
    let source_metadata = match fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return fs::create_dir_all(destination).map_err(|create_error| {
                format!(
                    "Failed to create OAuth directory {}: {create_error}",
                    path_to_string(destination)
                )
            });
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect legacy OAuth directory {}: {error}",
                path_to_string(source)
            ));
        }
    };
    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err(format!(
            "Legacy OAuth path is not a regular directory: {}",
            path_to_string(source)
        ));
    }

    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(format!(
                "OAuth migration destination is not a regular directory: {}",
                path_to_string(destination)
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(destination).map_err(|create_error| {
                format!(
                    "Failed to create OAuth migration directory {}: {create_error}",
                    path_to_string(destination)
                )
            })?;
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect OAuth migration directory {}: {error}",
                path_to_string(destination)
            ));
        }
    }

    for entry in fs::read_dir(source)
        .map_err(|error| format!("Failed to read legacy OAuth directory {}: {error}", path_to_string(source)))?
    {
        let entry = entry.map_err(|error| {
            format!(
                "Failed to read legacy OAuth directory entry {}: {error}",
                path_to_string(source)
            )
        })?;
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "Failed to inspect legacy OAuth directory entry {}: {error}",
                path_to_string(&entry.path())
            )
        })?;
        if file_type.is_symlink() {
            return Err(format!(
                "OAuth migration does not accept symbolic links: {}",
                path_to_string(&entry.path())
            ));
        }
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_auth_directory(&entry.path(), &target)?;
        } else if file_type.is_file() {
            copy_auth_file_atomically(&entry.path(), &target)?;
        } else {
            return Err(format!(
                "OAuth migration does not support this file type: {}",
                path_to_string(&entry.path())
            ));
        }
    }
    Ok(())
}

pub(crate) fn migrate_auth_dir_from_macos_app_bundle(
    config: &mut GuiConfigFile,
    install_dir: &Path,
    persistent_auth_dir: &Path,
) -> Result<bool, String> {
    let source = normalize_path_lexically(&auth_dir_path_for_core(&config.auth_dir, install_dir));
    if !auth_dir_is_inside_macos_app_bundle(&source) {
        return Ok(false);
    }
    let destination = normalize_path_lexically(persistent_auth_dir);
    if auth_dir_is_inside_macos_app_bundle(&destination) {
        return Err(format!(
            "Persistent OAuth directory cannot be inside a macOS application bundle: {}",
            path_to_string(&destination)
        ));
    }

    copy_auth_directory(&source, &destination)?;
    config.auth_dir = DEFAULT_AUTH_DIR.to_string();
    Ok(true)
}

/// Whether `path` holds a credential: a `.json` file, or a link to one (the core follows links). A folder that isn't
/// there holds none.
fn auth_directory_has_json_files(path: &Path) -> Result<bool, String> {
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!("Failed to read the credentials folder {}: {error}", path_to_string(path)));
        }
    };
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read the credentials folder: {error}"))?;
        let file_type = entry.file_type().map_err(|error| format!("Failed to read a credential's file type: {error}"))?;
        if (file_type.is_file() || file_type.is_symlink())
            && entry.path().extension().is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Points a config whose credentials folder resolves to the core's own `oauth` folder, beside its binary, back at
/// Arbor's `../oauth` when that one is empty and Arbor's holds the credentials. A config read without an auth-dir used
/// to come back as a bare "oauth", and the core then started with no accounts. Any spelling of the same folder
/// ("./oauth", "oauth/./", an absolute path) counts; one that only passes through it ("missing/../oauth") is the same
/// place too once resolved, which is what the core would use.
pub(crate) fn recover_relative_oauth_dir(
    config: &mut GuiConfigFile,
    install_dir: &Path,
    persistent_auth_dir: &Path,
) -> Result<bool, String> {
    let current = normalize_path_lexically(&auth_dir_path_for_core(&config.auth_dir, install_dir));
    if current != normalize_path_lexically(&install_dir.join(OAUTH_DIR_NAME)) {
        return Ok(false);
    }
    if auth_directory_has_json_files(&current)? || !auth_directory_has_json_files(persistent_auth_dir)? {
        return Ok(false);
    }
    config.auth_dir = DEFAULT_AUTH_DIR.to_string();
    Ok(true)
}

/// Moves the credentials folder where it belongs (out of a packaged app on the Mac, or back from the core's own
/// folder) on a copy of `config`, and only keeps the change once the core's config says the same, through `patch`.
pub(crate) fn migrate_auth_dir_at(
    config: &mut GuiConfigFile,
    install_dir: &Path,
    persistent_auth_dir: &Path,
    patch: impl FnOnce(&str) -> Result<(), String>,
) -> Result<bool, String> {
    let mut candidate = config.clone();
    let migrated = migrate_auth_dir_from_macos_app_bundle(&mut candidate, install_dir, persistent_auth_dir)?;
    let recovered = recover_relative_oauth_dir(&mut candidate, install_dir, persistent_auth_dir)?;
    if migrated || recovered {
        patch(&candidate.auth_dir).map_err(|error| format!("Failed to update the core's credentials folder: {error}"))?;
        *config = candidate;
    }
    Ok(migrated || recovered)
}

pub(crate) fn load_or_create_gui_config() -> Result<GuiConfigFile, String> {
    let config_path = gui_config_path()?;
    let legacy_config_path = legacy_gui_config_path()?;
    let gui_config_exists = config_path.is_file();
    let legacy_config_exists = legacy_config_path.is_file();
    let had_existing_gui_config = gui_config_exists || legacy_config_exists;

    let (mut config, presence, mut changed) = if gui_config_exists {
        let content = fs::read_to_string(&config_path)
            .map_err(|err| format!("Failed to read GUI configuration {}: {err}", path_to_string(&config_path)))?;
        match (
            toml::from_str::<GuiConfigFile>(&content),
            toml::from_str::<GuiConfigPresence>(&content),
        ) {
            (Ok(config), Ok(presence)) => {
                let mut changed = [
                    "codex-session-repair-on-launch",
                    "claude-code-working-directory",
                    "claude-code-working-directory-prompt-disabled",
                ]
                .iter()
                .any(|key| content.lines().any(|line| line.trim_start().starts_with(key)));
                // The copies of the core's settings go on the first write below. They were config.yaml's values (the
                // core ran from that file, not this one), but the file as it was is kept all the same.
                if gui_config_holds_core_settings(&content) {
                    if let Err(error) = back_up_gui_config_before_one_owner(&config_path) {
                        eprintln!("Dropping the copies of the core's settings from config.toml without a backup: {error}");
                    }
                    changed = true;
                }
                (config, presence, changed)
            }
            _ => (GuiConfigFile::default(), GuiConfigPresence::default(), true),
        }
    } else if legacy_config_exists {
        let content = fs::read_to_string(&legacy_config_path).map_err(|err| {
            format!(
                "Failed to read legacy GUI configuration {}: {err}",
                path_to_string(&legacy_config_path)
            )
        })?;
        let config = serde_yaml::from_str::<GuiConfigFile>(&content)
            .map_err(|err| format!("Failed to parse legacy GUI configuration: {err}"))?;
        let presence = serde_yaml::from_str::<GuiConfigPresence>(&content)
            .map_err(|err| format!("Failed to parse legacy GUI configuration fields: {err}"))?;
        (config, presence, true)
    } else {
        (GuiConfigFile::default(), GuiConfigPresence::default(), true)
    };

    // The core's settings are config.yaml's. Before the core has one, the defaults above are what its first one gets.
    let core_config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if core_config_path.is_file() {
        match read_installed_core_config_settings() {
            Ok(core_settings) => {
                take_core_settings_at_load(&mut config, presence.api_keys.is_some(), &core_settings);
            }
            Err(error) => eprintln!("Showing Arbor's last known core settings, as config.yaml can't be read: {error}"),
        }
    } else {
        changed |= ensure_first_client_key(&mut config)?;
    }
    if presence.management_secret_key.is_none()
        && (had_existing_gui_config || core_config_path.is_file())
    {
        config.management_secret_key = read_installed_core_config_settings()
            .ok()
            .and_then(|settings| settings.management_secret_key)
            .filter(|secret_key| !is_hashed_management_secret_key(secret_key))
            .unwrap_or_default();
        changed = true;
    }
    if presence.close_behavior.is_none() {
        changed = true;
    }
    if presence.start_core_on_launch.is_none() {
        changed = true;
    }
    if presence.silent_start.is_none() {
        changed = true;
    }
    // Written again without the download mirror settings older versions kept.
    if presence.has_retired_download_settings() {
        changed = true;
    }
    let management_secret_rotated = ensure_strong_management_secret(&mut config)?;
    changed |= management_secret_rotated;
    changed |= sanitize_gui_config(&mut config)?;
    validate_arbor_settings(&config)?;
    if changed {
        write_gui_config(&config)?;
    }
    if management_secret_rotated {
        if let Err(error) = patch_core_management_secret_key(&config.management_secret_key) {
            eprintln!("Failed to replace the old default management key; will retry on next core startup: {error}");
        }
    }
    if !config.auth_dir.trim().is_empty() {
        let install_dir = core_install_dir()?;
        let auth_dir = auth_dir_path_for_core(&config.auth_dir, &install_dir);
        fs::create_dir_all(&auth_dir)
            .map_err(|error| format!("Failed to create credentials directory {}: {error}", path_to_string(&auth_dir)))?;
    }
    Ok(config)
}

/// Copies the core's settings into Arbor's, keeping what Arbor alone knows: client key names (and the one a command
/// just added, and a returning key's from its fingerprint), and its own copy of the management secret once the core
/// has hashed it.
pub(crate) fn apply_core_settings_to_gui_config(
    config: &mut GuiConfigFile,
    core_settings: &CoreConfigSettings,
    added_api_key: Option<&GuiApiKeyEntry>,
) {
    config.host = core_settings.host.clone();
    config.port = core_settings.port;
    config.allow_lan = !is_loopback_host(&core_settings.host);
    config.auth_dir = core_settings.auth_dir.clone();
    let mut known = config.api_keys.clone();
    known.extend(added_api_key.cloned());
    config.api_keys =
        merge_core_api_keys_with_gui_metadata(&config.api_keys, &core_settings.api_keys, added_api_key);
    name_returning_client_keys(&mut config.api_keys, &known, &config.client_key_names);
    if let Some(secret_key) = core_settings
        .management_secret_key
        .as_deref()
        .filter(|secret_key| !is_hashed_management_secret_key(secret_key))
    {
        config.management_secret_key = secret_key.to_string();
    }
    config.debug = core_settings.debug;
    config.commercial_mode = core_settings.commercial_mode;
    config.logging_to_file = core_settings.logging_to_file;
    config.logs_max_total_size_mb = core_settings.logs_max_total_size_mb;
    config.error_logs_max_files = core_settings.error_logs_max_files;
    config.usage_statistics_enabled = core_settings.usage_statistics_enabled;
    config.redis_usage_queue_retention_seconds = core_settings.redis_usage_queue_retention_seconds;
    config.request_log = core_settings.request_log;
    config.plugins_enabled = core_settings.plugins_enabled;
    config.routing_strategy = core_settings.routing_strategy.clone();
    config.proxy_url = core_settings.proxy_url.clone();
    config.routing_session_affinity = core_settings.routing_session_affinity;
    config.routing_session_affinity_ttl = core_settings.routing_session_affinity_ttl.clone();
    config.disable_cooling = core_settings.disable_cooling;
    config.request_retry = core_settings.request_retry;
    config.max_retry_credentials = core_settings.max_retry_credentials;
    config.max_retry_interval = core_settings.max_retry_interval;
    config.streaming_bootstrap_retries = core_settings.streaming_bootstrap_retries;
}

/// `apply_core_settings_to_gui_config` for settings read back from config.yaml rather than ones an Arbor command just
/// wrote. Arbor shows the file as it is: an empty client key list is shown empty, and the proxy checks say what that
/// means, since nothing Arbor holds goes back into the file.
pub(crate) fn import_core_settings_to_gui_config(
    config: &mut GuiConfigFile,
    core_settings: &CoreConfigSettings,
) {
    apply_core_settings_to_gui_config(config, core_settings, None);
}

/// A new install's first client key: random, like the management key, so nobody can guess it.
pub(crate) fn new_default_api_key_entry() -> Result<GuiApiKeyEntry, String> {
    let mut random = [0_u8; 24];
    getrandom::fill(&mut random).map_err(|error| format!("Failed to generate a client key: {error}"))?;
    let hex: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(GuiApiKeyEntry { key: format!("sk-{hex}"), remark: DEFAULT_API_KEY_INITIAL_REMARK.to_string() })
}

/// Gives settings with no client key a random one, for a config.yaml the first start writes from them: with no key
/// the proxy would take requests from anyone who can reach it. Only for when there's no config.yaml yet, whose keys
/// are otherwise the ones that count.
pub(crate) fn ensure_first_client_key(config: &mut GuiConfigFile) -> Result<bool, String> {
    if !config.api_keys.is_empty() {
        return Ok(false);
    }
    let entry = new_default_api_key_entry()?;
    config.client_key_names = client_key_names_to_keep(std::slice::from_ref(&entry), &config.client_key_names);
    config.api_keys = vec![entry];
    Ok(true)
}

pub(crate) fn gui_api_key_values(entries: &[GuiApiKeyEntry]) -> Vec<String> {
    entries.iter().map(|entry| entry.key.clone()).collect()
}

/// The key Arbor asks its own proxy with. With no keys the proxy takes any, so the old default does as well as any.
pub(crate) fn effective_agent_api_key(config: &GuiConfigFile) -> &str {
    config
        .api_keys
        .iter()
        .map(|entry| entry.key.trim())
        .find(|key| !key.is_empty())
        .unwrap_or(LEGACY_DEFAULT_API_KEY)
}

pub(crate) fn merge_core_api_keys_with_gui_metadata(
    existing: &[GuiApiKeyEntry],
    core_api_keys: &[String],
    added_api_key: Option<&GuiApiKeyEntry>,
) -> Vec<GuiApiKeyEntry> {
    let mut merged: Vec<GuiApiKeyEntry> = Vec::new();

    for api_key in core_api_keys {
        let api_key = api_key.trim();
        if api_key.is_empty() || is_example_core_api_key(api_key) {
            continue;
        }
        if merged.iter().any(|entry| entry.key == api_key) {
            continue;
        }

        let remark = added_api_key
            .filter(|entry| entry.key == api_key)
            .map(|entry| entry.remark.clone())
            .or_else(|| {
                existing
                    .iter()
                    .find(|entry| entry.key == api_key)
                    .map(|entry| entry.remark.clone())
            })
            .unwrap_or_default();
        merged.push(GuiApiKeyEntry {
            key: api_key.to_string(),
            remark,
        });
    }

    merged
}

/// The paused keys worth keeping: trimmed, once each, and not also in the active list, since
/// a key that's back in the core (added again by hand, say) isn't paused any more.
pub(crate) fn paused_api_keys_outside(
    paused: &[GuiApiKeyEntry],
    active: &[GuiApiKeyEntry],
) -> Vec<GuiApiKeyEntry> {
    let mut kept: Vec<GuiApiKeyEntry> = Vec::new();
    for entry in paused {
        let key = entry.key.trim();
        if key.is_empty()
            || active.iter().any(|active| active.key == key)
            || kept.iter().any(|kept| kept.key == key)
        {
            continue;
        }
        kept.push(GuiApiKeyEntry {
            key: key.to_string(),
            remark: entry.remark.trim().to_string(),
        });
    }
    kept
}

pub(crate) fn normalized_saved_window_size(width: u32, height: u32) -> SavedWindowSize {
    SavedWindowSize {
        width: width.clamp(MIN_MAIN_WINDOW_WIDTH, MAX_SAVED_WINDOW_DIMENSION),
        height: height.clamp(MIN_MAIN_WINDOW_HEIGHT, MAX_SAVED_WINDOW_DIMENSION),
    }
}

pub(crate) fn configured_window_size(config: &GuiConfigFile) -> Option<SavedWindowSize> {
    match (config.window_width, config.window_height) {
        (Some(width), Some(height)) => Some(normalized_saved_window_size(width, height)),
        _ => None,
    }
}

pub(crate) fn logical_window_size_from_physical(
    physical_size: &tauri::PhysicalSize<u32>,
    scale_factor: f64,
) -> Option<SavedWindowSize> {
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return None;
    }

    let width = (f64::from(physical_size.width) / scale_factor).round() as u32;
    let height = (f64::from(physical_size.height) / scale_factor).round() as u32;
    if width < MIN_MAIN_WINDOW_WIDTH || height < MIN_MAIN_WINDOW_HEIGHT {
        return None;
    }

    Some(normalized_saved_window_size(width, height))
}

pub(crate) fn fit_window_size_to_current_monitor<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    saved_size: SavedWindowSize,
) -> SavedWindowSize {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return saved_size;
    };

    let scale_factor = monitor.scale_factor();
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return saved_size;
    }

    let (frame_width, frame_height) = window
        .outer_size()
        .ok()
        .zip(window.inner_size().ok())
        .map(|(outer, inner)| {
            (
                outer.width.saturating_sub(inner.width),
                outer.height.saturating_sub(inner.height),
            )
        })
        .unwrap_or_default();
    let work_area = monitor.work_area();
    let max_width =
        (f64::from(work_area.size.width.saturating_sub(frame_width)) / scale_factor).floor() as u32;
    let max_height = (f64::from(work_area.size.height.saturating_sub(frame_height)) / scale_factor)
        .floor() as u32;

    SavedWindowSize {
        width: saved_size.width.min(max_width.max(MIN_MAIN_WINDOW_WIDTH)),
        height: saved_size
            .height
            .min(max_height.max(MIN_MAIN_WINDOW_HEIGHT)),
    }
}

pub(crate) fn restore_main_window_size(app: &tauri::AppHandle) -> Result<(), String> {
    let window_size_state = app.state::<MainWindowSizeState>();
    let Some(saved_size) = window_size_state.snapshot()? else {
        return Ok(());
    };
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window does not exist; cannot restore window size".to_string())?;
    let restored_size = fit_window_size_to_current_monitor(&window, saved_size);

    window
        .set_size(LogicalSize::new(
            f64::from(restored_size.width),
            f64::from(restored_size.height),
        ))
        .map_err(|error| format!("Failed to restore main window size: {error}"))?;
    window_size_state.replace(restored_size)
}

pub(crate) fn persist_main_window_size(app: &tauri::AppHandle) -> Result<(), String> {
    let window_size_state = app.state::<MainWindowSizeState>();
    let saved_size = match window_size_state.snapshot()? {
        Some(size) => size,
        None => {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "Main window does not exist; cannot save window size".to_string())?;
            let physical_size = window
                .inner_size()
                .map_err(|error| format!("Failed to read main window size: {error}"))?;
            let scale_factor = window
                .scale_factor()
                .map_err(|error| format!("Failed to read main window scale factor: {error}"))?;
            logical_window_size_from_physical(&physical_size, scale_factor)
                .ok_or_else(|| "Invalid main window size; saving skipped".to_string())?
        }
    };

    app.state::<GuiConfigState>()
        .set_window_size(saved_size)
        .map(|_| ())
}

pub(crate) fn is_loopback_host(host: &str) -> bool {
    let host = host.trim();
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

pub(crate) fn sanitize_gui_config(config: &mut GuiConfigFile) -> Result<bool, String> {
    let mut changed = false;
    let host = config.host.trim();
    let host = if host.is_empty() {
        if config.allow_lan {
            "0.0.0.0"
        } else {
            "127.0.0.1"
        }
    } else {
        host
    };
    if config.host != host {
        config.host = host.to_string();
        changed = true;
    }
    let allow_lan = !is_loopback_host(&config.host);
    if config.allow_lan != allow_lan {
        config.allow_lan = allow_lan;
        changed = true;
    }
    let legacy_default_auth_dir = fixed_oauth_dir()?;
    // A folder that can't be read or a core config that can't be patched leaves the settings as they are: the rest of
    // them still load.
    match core_install_dir().and_then(|install_dir| migrate_auth_dir_at(config, &install_dir, &legacy_default_auth_dir, patch_core_auth_dir)) {
        Ok(moved) => changed |= moved,
        Err(error) => eprintln!("Keeping the credentials folder as it is: {error}"),
    }
    if config.auth_dir.trim().is_empty()
        || Path::new(config.auth_dir.trim()) == legacy_default_auth_dir
    {
        config.auth_dir = DEFAULT_AUTH_DIR.to_string();
        changed = true;
    }
    let original_api_keys = config.api_keys.clone();
    let configured_keys = config
        .api_keys
        .iter()
        .map(|entry| entry.key.trim().to_string())
        .collect::<Vec<_>>();
    config.api_keys =
        merge_core_api_keys_with_gui_metadata(&config.api_keys, &configured_keys, None);
    for entry in &mut config.api_keys {
        entry.key = entry.key.trim().to_string();
        entry.remark = entry.remark.trim().to_string();
    }
    if config.api_keys != original_api_keys {
        changed = true;
    }
    let paused_api_keys = paused_api_keys_outside(&config.paused_api_keys, &config.api_keys);
    if config.paused_api_keys != paused_api_keys {
        config.paused_api_keys = paused_api_keys;
        changed = true;
    }
    let client_key_names = client_key_names_to_keep(&config.api_keys, &config.client_key_names);
    if config.client_key_names != client_key_names {
        config.client_key_names = client_key_names;
        changed = true;
    }
    let proxy_url = config.proxy_url.trim().to_string();
    if config.proxy_url != proxy_url {
        config.proxy_url = proxy_url;
        changed = true;
    }
    let routing_session_affinity_ttl = config.routing_session_affinity_ttl.trim().to_string();
    if config.routing_session_affinity_ttl != routing_session_affinity_ttl {
        config.routing_session_affinity_ttl = routing_session_affinity_ttl;
        changed = true;
    }
    let window_size = configured_window_size(config).map(|size| {
        if size.width == LEGACY_DEFAULT_MAIN_WINDOW_WIDTH
            && size.height == LEGACY_DEFAULT_MAIN_WINDOW_HEIGHT
        {
            SavedWindowSize {
                width: DEFAULT_MAIN_WINDOW_WIDTH,
                height: DEFAULT_MAIN_WINDOW_HEIGHT,
            }
        } else {
            size
        }
    });
    let normalized_width = window_size.map(|size| size.width);
    let normalized_height = window_size.map(|size| size.height);
    if config.window_width != normalized_width || config.window_height != normalized_height {
        config.window_width = normalized_width;
        config.window_height = normalized_height;
        changed = true;
    }
    let zoom_step = crate::zoom::clamp_zoom_step(config.zoom_step);
    if config.zoom_step != zoom_step {
        config.zoom_step = zoom_step;
        changed = true;
    }
    Ok(changed)
}

pub(crate) fn write_gui_config(config: &GuiConfigFile) -> Result<(), String> {
    write_gui_config_to_path(config, &gui_config_path()?)
}

pub(crate) fn write_gui_config_to_path(
    config: &GuiConfigFile,
    config_path: &Path,
) -> Result<(), String> {
    use toml_edit::{value, Array, Document, InlineTable, Item, Value};

    validate_arbor_settings(config)?;
    let existing = fs::read_to_string(config_path).ok();
    let mut document = existing
        .as_deref()
        .filter(|content| !content.trim().is_empty())
        .and_then(|content| content.parse::<Document>().ok())
        .unwrap_or_default();
    let root = document.as_table_mut();
    for (key, item) in [
        ("run-on-startup", value(config.run_on_startup)),
        ("start-core-on-launch", value(config.start_core_on_launch)),
        ("silent-start", value(config.silent_start)),
        ("close-behavior", value(config.close_behavior.as_str())),
        ("zoom-step", value(i64::from(config.zoom_step))),
        (
            "management-secret-key",
            value(config.management_secret_key.as_str()),
        ),
        ("update-channel", value(config.update_channel.as_str())),
    ] {
        set_codex_table_item(root, key, item);
    }
    // config.yaml alone holds the core's settings; see core_config/ownership.rs.
    for key in [
        "codex-session-repair-on-launch",
        "claude-code-working-directory",
        "claude-code-working-directory-prompt-disabled",
        "default-terminal",
        // Downloads come from GitHub alone; versions with download mirrors kept these.
        "prefer-gitcode-downloads",
        "download-source",
        "custom-download-mirrors",
        "active-custom-download-mirror",
        // The UI is English only; versions with a language setting kept it here.
        "locale",
    ]
    .into_iter()
    .chain(CORE_OWNED_GUI_KEYS.iter().copied())
    {
        root.remove(key);
    }
    for (key, dimension) in [
        ("window-width", config.window_width),
        ("window-height", config.window_height),
    ] {
        if let Some(dimension) = dimension {
            set_codex_table_item(root, key, value(i64::from(dimension)));
        } else {
            root.remove(key);
        }
    }
    if config.client_key_names.is_empty() {
        root.remove(CLIENT_KEY_NAMES_GUI_KEY);
    } else {
        let mut client_key_names = Array::new();
        for name in &config.client_key_names {
            let mut table = InlineTable::new();
            table.insert("api-key-hash", Value::from(name.api_key_hash.as_str()));
            table.insert("remark", Value::from(name.remark.as_str()));
            client_key_names.push(Value::InlineTable(table));
        }
        set_codex_table_item(
            root,
            CLIENT_KEY_NAMES_GUI_KEY,
            Item::Value(Value::Array(client_key_names)),
        );
    }
    if config.paused_api_keys.is_empty() {
        root.remove("paused-api-keys");
    } else {
        let mut paused_api_keys = Array::new();
        for entry in &config.paused_api_keys {
            let mut table = InlineTable::new();
            table.insert("key", Value::from(entry.key.as_str()));
            table.insert("remark", Value::from(entry.remark.as_str()));
            paused_api_keys.push(Value::InlineTable(table));
        }
        set_codex_table_item(
            root,
            "paused-api-keys",
            Item::Value(Value::Array(paused_api_keys)),
        );
    }
    let mut api_access_remarks = Array::new();
    for entry in &config.api_access_remarks {
        let mut table = InlineTable::new();
        table.insert(
            "provider-section",
            Value::from(entry.provider_section.as_str()),
        );
        table.insert("api-key-hash", Value::from(entry.api_key_hash.as_str()));
        table.insert("remark", Value::from(entry.remark.as_str()));
        api_access_remarks.push(Value::InlineTable(table));
    }
    set_codex_table_item(
        root,
        "api-access-remarks",
        Item::Value(Value::Array(api_access_remarks)),
    );

    let content = document.to_string();
    toml::from_str::<GuiConfigFile>(&content)
        .map_err(|error| format!("Failed to validate GUI configuration: {error}"))?;
    if existing.as_deref() == Some(content.as_str()) {
        return Ok(());
    }
    write_bytes_directly(config_path, content.as_bytes())
}

/// Everything config.toml holds checked, and the core's settings too: for a save that writes them into config.yaml.
pub(crate) fn validate_gui_config(config: &GuiConfigFile) -> Result<(), String> {
    validate_arbor_settings(config)?;
    if config.port == 0 {
        return Err("GUI configuration port must be between 1 and 65535".to_string());
    }
    if config.host.trim().is_empty() || config.host.chars().any(char::is_control) {
        return Err("Invalid GUI configuration host".to_string());
    }
    if config.auth_dir.trim().is_empty() || config.auth_dir.chars().any(char::is_control) {
        return Err("Credentials directory cannot be empty or contain control characters".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        let auth_dir = auth_dir_path_for_core(&config.auth_dir, &core_install_dir()?);
        if auth_dir_is_inside_macos_app_bundle(&auth_dir) {
            return Err("OAuth credentials directory cannot be inside a macOS application bundle".to_string());
        }
    }
    for entry in &config.api_keys {
        validate_core_api_key(&entry.key)?;
    }
    validate_routing_strategy(config.routing_strategy.trim())?;
    if config.proxy_url.chars().any(char::is_control) {
        return Err("Proxy URL cannot contain control characters".to_string());
    }
    if config
        .routing_session_affinity_ttl
        .chars()
        .any(char::is_control)
    {
        return Err("Session affinity TTL cannot contain control characters".to_string());
    }
    if !(1..=3600).contains(&config.redis_usage_queue_retention_seconds) {
        return Err("Redis usage queue retention period must be between 1 and 3600 seconds".to_string());
    }
    Ok(())
}

/// What config.toml holds checked, and nothing of the core's: a config.yaml value Arbor wouldn't have written itself
/// (a strategy it doesn't offer, say) is still the core's to run, and mustn't stop Arbor loading or saving its own.
pub(crate) fn validate_arbor_settings(config: &GuiConfigFile) -> Result<(), String> {
    for entry in &config.paused_api_keys {
        validate_core_api_key(&entry.key)?;
        validate_api_key_remark(&entry.remark)?;
    }
    for entry in &config.api_keys {
        validate_api_key_remark(&entry.remark)?;
    }
    for name in &config.client_key_names {
        validate_key_fingerprint(&name.api_key_hash, "client key name")?;
        validate_api_key_remark(&name.remark)?;
    }
    for entry in &config.api_access_remarks {
        validate_api_access_provider_section(&entry.provider_section)?;
        validate_key_fingerprint(&entry.api_key_hash, "API access remark")?;
        validate_api_key_remark(&entry.remark)?;
    }
    validate_strong_management_secret_key(&config.management_secret_key)?;
    Ok(())
}

fn validate_key_fingerprint(hash: &str, what: &str) -> Result<(), String> {
    if hash.len() != 64 || !hash.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(format!("Invalid key fingerprint in {what}"));
    }
    Ok(())
}

pub(crate) fn gui_config_path() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join(GUI_CONFIG_FILE))
}

pub(crate) fn legacy_gui_config_path() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join(LEGACY_GUI_CONFIG_FILE))
}

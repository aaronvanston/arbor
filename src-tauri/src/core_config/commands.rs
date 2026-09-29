use super::*;

#[tauri::command]
pub(crate) fn get_core_tls_settings() -> Result<CoreTlsSettings, String> {
    current_core_tls_settings()
}

#[tauri::command]
pub(crate) fn save_core_tls_settings(
    settings: CoreTlsSettings,
) -> Result<CoreTlsSettings, String> {
    let settings = normalize_core_tls_settings(settings)?;
    patch_core_tls_settings(&settings)?;
    Ok(settings)
}

pub(crate) fn detect_lan_ipv4() -> Option<Ipv4Addr> {
    for target in ["192.0.2.1:80", "8.8.8.8:80"] {
        let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) else {
            continue;
        };
        if socket.connect(target).is_err() {
            continue;
        }
        let Ok(local_address) = socket.local_addr() else {
            continue;
        };
        let IpAddr::V4(address) = local_address.ip() else {
            continue;
        };
        if !address.is_unspecified() && !address.is_loopback() {
            return Some(address);
        }
    }
    None
}

#[tauri::command]
pub(crate) fn save_network_endpoint_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    settings: GuiNetworkEndpointSettings,
) -> Result<CoreConfigView, String> {
    if settings.port == 0 {
        return Err("Port must be between 1 and 65535".to_string());
    }
    let host = normalize_optional_config_string(settings.host, "Listen IP")?;
    if host.parse::<IpAddr>().is_err() {
        return Err("Listen IP must be a valid IPv4 or IPv6 address".to_string());
    }
    let proxy_url = normalize_optional_config_string(settings.proxy_url, "Proxy URL")?;
    let previous = gui_config_state.snapshot()?;
    let mut next = previous.clone();
    next.host = host;
    next.allow_lan = !is_loopback_host(&next.host);
    next.port = settings.port;
    next.proxy_url = proxy_url;
    validate_gui_config(&next)?;
    patch_core_network_endpoint_settings(&next)?;
    let config = match gui_config_state.update_network_endpoint(&next) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_network_endpoint_settings(&previous).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn save_retry_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    settings: GuiRetrySettings,
) -> Result<CoreConfigView, String> {
    let previous = gui_config_state.snapshot()?;
    let mut next = previous.clone();
    next.disable_cooling = settings.disable_cooling;
    next.request_retry = settings.request_retry;
    next.max_retry_credentials = settings.max_retry_credentials;
    next.max_retry_interval = settings.max_retry_interval;
    next.streaming_bootstrap_retries = settings.streaming_bootstrap_retries;
    patch_core_retry_settings(&next)?;
    let config = match gui_config_state.update_retry_settings(&next) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_retry_settings(&previous).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn save_session_routing_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    settings: GuiSessionRoutingSettings,
) -> Result<CoreConfigView, String> {
    let ttl = normalize_session_affinity_ttl(settings.routing_session_affinity_ttl)?;
    let previous = gui_config_state.snapshot()?;
    let mut next = previous.clone();
    next.routing_session_affinity = settings.routing_session_affinity;
    next.routing_session_affinity_ttl = ttl;
    patch_core_session_routing_settings(&next)?;
    let config = match gui_config_state.update_session_routing(&next) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_session_routing_settings(&previous).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn get_core_config_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreConfigView, String> {
    let settings = current_core_config_settings(gui_config_state.inner())?;
    // A refresh shows config.yaml as it is and writes nothing back into it.
    let config = gui_config_state.import_core_settings(&settings)?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn save_core_logging_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    settings: CoreLoggingSettingsInput,
) -> Result<CoreConfigView, String> {
    if !(1..=3600).contains(&settings.redis_usage_queue_retention_seconds) {
        return Err("Redis usage queue retention period must be between 1 and 3600 seconds".to_string());
    }

    let previous = current_core_config_settings(gui_config_state.inner())?;
    let mut next = previous.clone();
    next.debug = settings.debug;
    next.commercial_mode = settings.commercial_mode;
    next.logging_to_file = settings.logging_to_file;
    next.logs_max_total_size_mb = settings.logs_max_total_size_mb;
    next.error_logs_max_files = settings.error_logs_max_files;
    next.usage_statistics_enabled = settings.usage_statistics_enabled;
    next.redis_usage_queue_retention_seconds = settings.redis_usage_queue_retention_seconds;

    patch_core_logging_settings(&next)?;
    let config = match gui_config_state.sync_core_settings(&next) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_logging_settings(&previous).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

/// Turns usage statistics back on, as the proxy checks offer when the core has them off: without them the core sends
/// Arbor no usage records. The core picks the change up without a restart.
#[tauri::command]
pub(crate) fn turn_on_usage_statistics(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreConfigView, String> {
    let previous = current_core_config_settings(gui_config_state.inner())?;
    let mut next = previous.clone();
    next.usage_statistics_enabled = true;
    patch_core_logging_settings(&next)?;
    let config = match gui_config_state.sync_core_settings(&next) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_logging_settings(&previous).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn add_core_api_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    api_key: String,
    remark: String,
) -> Result<CoreConfigView, String> {
    let api_key = api_key.trim().to_string();
    let remark = remark.trim().to_string();
    validate_core_api_key(&api_key)?;
    validate_api_key_remark(&remark)?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    if settings
        .api_keys
        .iter()
        .any(|existing| existing == &api_key)
    {
        return Err("This authentication key already exists".to_string());
    }
    settings.api_keys.push(api_key);
    patch_core_api_keys(&settings.api_keys)?;
    let added_api_key = settings.api_keys.last().map(|key| GuiApiKeyEntry {
        key: key.clone(),
        remark,
    });
    let config = gui_config_state.sync_core_settings_with_api_key(&settings, added_api_key)?;
    Ok(CoreConfigView::from(&config))
}

pub(crate) fn replace_core_api_key_value(
    api_keys: &mut [String],
    original_api_key: &str,
    replacement_api_key: String,
) -> Result<(), String> {
    let index = api_keys
        .iter()
        .position(|existing| existing == original_api_key)
        .ok_or_else(|| "Authentication key to edit does not exist; refresh and try again".to_string())?;
    if replacement_api_key != original_api_key
        && api_keys
            .iter()
            .any(|existing| existing == &replacement_api_key)
    {
        return Err("This authentication key already exists".to_string());
    }
    api_keys[index] = replacement_api_key;
    Ok(())
}

pub(crate) fn remove_core_api_key_value(
    api_keys: &mut Vec<String>,
    api_key: &str,
) -> Result<(), String> {
    let index = api_keys
        .iter()
        .position(|existing| existing == api_key)
        .ok_or_else(|| "Authentication key to delete does not exist; refresh and try again".to_string())?;
    api_keys.remove(index);
    Ok(())
}

#[tauri::command]
pub(crate) fn update_core_api_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    original_api_key: String,
    api_key: String,
    remark: String,
) -> Result<CoreConfigView, String> {
    let original_api_key = original_api_key.trim();
    let api_key = api_key.trim().to_string();
    let remark = remark.trim().to_string();
    if original_api_key.is_empty() {
        return Err("Authentication key to edit cannot be empty".to_string());
    }
    validate_core_api_key(&api_key)?;
    validate_api_key_remark(&remark)?;

    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    replace_core_api_key_value(&mut settings.api_keys, original_api_key, api_key.clone())?;
    patch_core_api_keys(&settings.api_keys)?;
    let replaced = (api_key != original_api_key).then_some(original_api_key);
    let config = gui_config_state.sync_core_settings_then(
        &settings,
        Some(GuiApiKeyEntry {
            key: api_key,
            remark,
        }),
        |config| {
            if let Some(original_api_key) = replaced {
                forget_client_key_name(config, original_api_key);
            }
        },
    )?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn delete_core_api_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    api_key: String,
) -> Result<CoreConfigView, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("Authentication key to delete cannot be empty".to_string());
    }
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    remove_core_api_key_value(&mut settings.api_keys, api_key)?;
    patch_core_api_keys(&settings.api_keys)?;
    let config =
        gui_config_state.sync_core_settings_then(&settings, None, |config| forget_client_key_name(config, api_key))?;
    Ok(CoreConfigView::from(&config))
}

/// Takes the key with this hash out of the core's list and returns it. The last key stays:
/// with no keys the core accepts every request without one.
pub(crate) fn take_core_api_key_by_hash(
    api_keys: &mut Vec<String>,
    api_key_hash: &str,
) -> Result<String, String> {
    let index = api_keys
        .iter()
        .position(|key| usage::hash_text(key) == api_key_hash)
        .ok_or_else(|| "This key isn't in the core's list any more; refresh and try again".to_string())?;
    if api_keys.len() == 1 {
        return Err("This is the only authentication key. Without one the core lets any client in, so add another key before pausing this one".to_string());
    }
    Ok(api_keys.remove(index))
}

/// Pauses a client key: the core stops accepting it, and Arbor keeps it, with its remark,
/// so it can go back as it was. The core has no per-key switch, so this is the only way to
/// stop a client without deleting its key.
#[tauri::command]
pub(crate) fn pause_core_api_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    api_key_hash: String,
) -> Result<CoreConfigView, String> {
    let previous = gui_config_state.snapshot()?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    let previous_api_keys = settings.api_keys.clone();
    let api_key = take_core_api_key_by_hash(&mut settings.api_keys, api_key_hash.trim())?;
    let remark = previous
        .api_keys
        .iter()
        .find(|entry| entry.key == api_key)
        .map(|entry| entry.remark.clone())
        .unwrap_or_default();
    patch_core_api_keys(&settings.api_keys)?;
    let config = match gui_config_state.sync_core_settings_then(&settings, None, |config| {
        config.paused_api_keys.retain(|entry| entry.key != api_key);
        config.paused_api_keys.push(GuiApiKeyEntry {
            key: api_key.clone(),
            remark,
        });
    }) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_api_keys(&previous_api_keys).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

/// Puts a paused key back at the end of the core's list, with its remark.
#[tauri::command]
pub(crate) fn resume_core_api_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    api_key_hash: String,
) -> Result<CoreConfigView, String> {
    let api_key_hash = api_key_hash.trim();
    let entry = gui_config_state
        .snapshot()?
        .paused_api_keys
        .into_iter()
        .find(|entry| usage::hash_text(&entry.key) == api_key_hash)
        .ok_or_else(|| "This key isn't paused any more; refresh and try again".to_string())?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    let previous_api_keys = settings.api_keys.clone();
    let restored = !settings.api_keys.contains(&entry.key);
    if restored {
        settings.api_keys.push(entry.key.clone());
        patch_core_api_keys(&settings.api_keys)?;
    }
    let key = entry.key.clone();
    let config = match gui_config_state.sync_core_settings_then(
        &settings,
        restored.then_some(entry),
        |config| config.paused_api_keys.retain(|paused| paused.key != key),
    ) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = if restored {
                patch_core_api_keys(&previous_api_keys).err()
            } else {
                None
            };
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

/// Forgets a paused key for good. The core's list is untouched: the key is already out of it.
#[tauri::command]
pub(crate) fn delete_paused_core_api_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    api_key_hash: String,
) -> Result<CoreConfigView, String> {
    let api_key_hash = api_key_hash.trim();
    let config = gui_config_state.update(|config| {
        let before = config.paused_api_keys.len();
        config
            .paused_api_keys
            .retain(|entry| usage::hash_text(&entry.key) != api_key_hash);
        if config.paused_api_keys.len() == before {
            return Err("This key isn't paused any more; refresh and try again".to_string());
        }
        Ok(())
    })?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn set_core_management_secret_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    secret_key: String,
) -> Result<CoreConfigView, String> {
    let secret_key = normalize_management_secret_key(secret_key)?;
    let previous = gui_config_state.snapshot()?;
    patch_core_management_secret_key(&secret_key)?;
    let config = match gui_config_state.set_management_secret_key(secret_key) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error =
                patch_core_management_secret_key(&previous.management_secret_key).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn set_core_routing_strategy(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    strategy: String,
) -> Result<CoreConfigView, String> {
    validate_routing_strategy(&strategy)?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    settings.routing_strategy = strategy;
    patch_core_routing_strategy(&settings.routing_strategy)?;
    let config = gui_config_state.sync_core_settings(&settings)?;
    Ok(CoreConfigView::from(&config))
}


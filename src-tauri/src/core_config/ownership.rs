//! Which file owns what. The core's settings live in its config.yaml and nowhere else; config.toml holds Arbor's own
//! settings, the plaintext management key (the core keeps only a hash of it, and Arbor needs the key itself to call
//! the core), a name for each client key filed by the key's fingerprint, and paused keys (the core has no pause of its
//! own).

use super::*;

/// The keys a config.toml from older versions holds copies of the core's settings under. They're dropped on first
/// launch, after the old file is kept as config.toml.pre-one-owner.
pub(crate) const CORE_OWNED_GUI_KEYS: &[&str] = &[
    "port",
    "allow-lan",
    "host",
    "auth-dir",
    "api-keys",
    "debug",
    "commercial-mode",
    "logging-to-file",
    "logs-max-total-size-mb",
    "error-logs-max-files",
    "usage-statistics-enabled",
    "redis-usage-queue-retention-seconds",
    "request-log",
    "plugins-enabled",
    "routing-strategy",
    "proxy-url",
    "routing-session-affinity",
    "routing-session-affinity-ttl",
    "disable-cooling",
    "request-retry",
    "max-retry-credentials",
    "max-retry-interval",
    "streaming-bootstrap-retries",
];

pub(crate) const CLIENT_KEY_NAMES_GUI_KEY: &str = "client-key-names";
const ONE_OWNER_BACKUP_FILE: &str = "config.toml.pre-one-owner";

/// A client key's name, filed by the key's fingerprint so config.toml never holds a second copy of the key.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
pub(crate) struct GuiClientKeyName {
    pub(crate) api_key_hash: String,
    pub(crate) remark: String,
}

/// Whether config.toml still holds copies of the core's settings, as Arbor wrote it before config.yaml became their
/// only home.
pub(crate) fn gui_config_holds_core_settings(content: &str) -> bool {
    content
        .parse::<toml_edit::Document>()
        .is_ok_and(|document| CORE_OWNED_GUI_KEYS.iter().any(|key| document.contains_key(key)))
}

/// Keeps config.toml as it was before Arbor dropped its copies of the core's settings, once: a later downgrade and
/// upgrade leaves the first copy alone.
pub(crate) fn back_up_gui_config_before_one_owner(config_path: &Path) -> Result<(), String> {
    let backup = config_path.with_file_name(ONE_OWNER_BACKUP_FILE);
    if backup.exists() {
        return Ok(());
    }
    fs::copy(config_path, &backup).map(|_| ()).map_err(|error| {
        format!("Failed to back up the GUI configuration to {}: {error}", path_to_string(&backup))
    })
}

/// Takes config.yaml's settings into Arbor's as it loads. Only a config.toml from before config.yaml became their one
/// home has a key list of its own (`has_own_key_list`), whose names go with the keys; otherwise names come by
/// fingerprint, and the default key's first name mustn't stand in for one the user gave it.
pub(crate) fn take_core_settings_at_load(
    config: &mut GuiConfigFile,
    has_own_key_list: bool,
    core_settings: &CoreConfigSettings,
) {
    if !has_own_key_list {
        config.api_keys.clear();
    }
    apply_core_settings_to_gui_config(config, core_settings, None);
}

/// Gives each key Arbor didn't have a moment ago (one put back in config.yaml by hand, or every key as Arbor loads) the
/// name config.toml keeps for its fingerprint. A key it had, or one a command has just named, keeps the name it has,
/// no name included: that's how a name is cleared.
pub(crate) fn name_returning_client_keys(
    entries: &mut [GuiApiKeyEntry],
    known: &[GuiApiKeyEntry],
    names: &[GuiClientKeyName],
) {
    for entry in entries.iter_mut().filter(|entry| !known.iter().any(|known| known.key == entry.key)) {
        let hash = usage::hash_text(entry.key.trim());
        if let Some(name) = names.iter().find(|name| name.api_key_hash == hash) {
            entry.remark = name.remark.clone();
        }
    }
}

/// Forgets the name kept for a key that's gone for good: deleted, or changed to another.
pub(crate) fn forget_client_key_name(config: &mut GuiConfigFile, api_key: &str) {
    let hash = usage::hash_text(api_key.trim());
    config.client_key_names.retain(|name| name.api_key_hash != hash);
}

/// Gives each key the name config.toml keeps for its fingerprint, or none: for config.toml changed outside Arbor,
/// whose names are the ones that count.
pub(crate) fn rename_client_keys(entries: &mut [GuiApiKeyEntry], names: &[GuiClientKeyName]) {
    for entry in entries.iter_mut() {
        let hash = usage::hash_text(entry.key.trim());
        entry.remark = names
            .iter()
            .find(|name| name.api_key_hash == hash)
            .map(|name| name.remark.clone())
            .unwrap_or_default();
    }
}

/// The names config.toml keeps: one for each current key that has one, and those already kept for keys the core
/// doesn't list right now, so a key taken out by hand and put back, or a config.yaml Arbor couldn't read for a moment,
/// comes back with its name. A current key's own name always wins, so clearing it clears it.
pub(crate) fn client_key_names_to_keep(
    api_keys: &[GuiApiKeyEntry],
    kept: &[GuiClientKeyName],
) -> Vec<GuiClientKeyName> {
    let current: Vec<GuiClientKeyName> = api_keys
        .iter()
        .filter(|entry| !entry.key.trim().is_empty())
        .map(|entry| GuiClientKeyName {
            api_key_hash: usage::hash_text(entry.key.trim()),
            remark: entry.remark.trim().to_string(),
        })
        .collect();
    let mut names: Vec<GuiClientKeyName> = Vec::new();
    for name in kept.iter().filter(|name| !current.iter().any(|entry| entry.api_key_hash == name.api_key_hash)) {
        if !names.iter().any(|existing| existing.api_key_hash == name.api_key_hash) {
            names.push(name.clone());
        }
    }
    for name in current {
        if !name.remark.is_empty() && !names.iter().any(|existing| existing.api_key_hash == name.api_key_hash) {
            names.push(name);
        }
    }
    names.retain(|name| !name.remark.is_empty());
    names
}

/// Takes the core's settings from `from` into `into`, which has Arbor's own: how a config.toml changed outside Arbor
/// is taken in without its leftover copies of core settings counting for anything.
pub(crate) fn keep_core_settings(from: &GuiConfigFile, into: &mut GuiConfigFile) {
    into.port = from.port;
    into.allow_lan = from.allow_lan;
    into.host = from.host.clone();
    into.auth_dir = from.auth_dir.clone();
    into.api_keys = from.api_keys.clone();
    into.debug = from.debug;
    into.commercial_mode = from.commercial_mode;
    into.logging_to_file = from.logging_to_file;
    into.logs_max_total_size_mb = from.logs_max_total_size_mb;
    into.error_logs_max_files = from.error_logs_max_files;
    into.usage_statistics_enabled = from.usage_statistics_enabled;
    into.redis_usage_queue_retention_seconds = from.redis_usage_queue_retention_seconds;
    into.request_log = from.request_log;
    into.plugins_enabled = from.plugins_enabled;
    into.routing_strategy = from.routing_strategy.clone();
    into.proxy_url = from.proxy_url.clone();
    into.routing_session_affinity = from.routing_session_affinity;
    into.routing_session_affinity_ttl = from.routing_session_affinity_ttl.clone();
    into.disable_cooling = from.disable_cooling;
    into.request_retry = from.request_retry;
    into.max_retry_credentials = from.max_retry_credentials;
    into.max_retry_interval = from.max_retry_interval;
    into.streaming_bootstrap_retries = from.streaming_bootstrap_retries;
}

/// What an existing config.yaml needs before the core starts on it: Arbor's management key, which Arbor alone keeps
/// in plaintext, and a port, without which the core listens on a random one Arbor can't find. Nothing else is touched;
/// every other setting is the file's.
pub(crate) fn keep_core_config_reachable(content: &str, config: &GuiConfigFile) -> Result<String, String> {
    let has_port = serde_norway::from_str::<serde_norway::Value>(content)
        .ok()
        .and_then(|document| {
            let root = document.as_mapping()?.clone();
            nested_yaml_value(&root, &["server", "port"])
                .or_else(|| nested_yaml_value(&root, &["port"]))
                .map(|port| port.as_u64().is_some_and(|port| port > 0))
        })
        .unwrap_or(false);
    let updated = patch_core_yaml_document(content, |document| {
        let mut changed = set_core_yaml_schema_value(
            document,
            &["remote-management", "secret-key"],
            &["management", "secret-key"],
            serde_norway::Value::String(config.management_secret_key.clone()),
        )?;
        if !has_port {
            changed |= set_core_yaml_schema_value(
                document,
                &["port"],
                &["server", "port"],
                serde_norway::to_value(config.port).map_err(|err| format!("Failed to serialize core port: {err}"))?,
            )?;
        }
        Ok(changed)
    })?;
    Ok(updated.unwrap_or_else(|| content.to_string()))
}

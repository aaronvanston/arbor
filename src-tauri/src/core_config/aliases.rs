use super::*;
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct OAuthAliasChannel {
    pub(crate) key: &'static str,
    pub(crate) provider: &'static str,
    pub(crate) kind: &'static str,
    pub(crate) protocol: &'static str,
    pub(crate) supports_reasoning: bool,
    pub(crate) supports_fast: bool,
    pub(crate) force_mapping: bool,
}

pub(crate) const OAUTH_ALIAS_CHANNELS: [OAuthAliasChannel; 7] = [
    OAuthAliasChannel {
        key: "vertex",
        provider: "Vertex OAuth",
        kind: "vertex-oauth",
        protocol: "gemini",
        supports_reasoning: true,
        supports_fast: false,
        force_mapping: false,
    },
    OAuthAliasChannel {
        key: "aistudio",
        provider: "AI Studio OAuth",
        kind: "aistudio-oauth",
        protocol: "gemini",
        supports_reasoning: true,
        supports_fast: false,
        force_mapping: false,
    },
    OAuthAliasChannel {
        key: "antigravity",
        provider: "Antigravity OAuth",
        kind: "antigravity-oauth",
        protocol: "antigravity",
        supports_reasoning: true,
        supports_fast: false,
        force_mapping: true,
    },
    OAuthAliasChannel {
        key: "claude",
        provider: "Claude OAuth",
        kind: "claude-oauth",
        protocol: "claude",
        supports_reasoning: true,
        supports_fast: false,
        force_mapping: false,
    },
    OAuthAliasChannel {
        key: "codex",
        provider: "Codex OAuth",
        kind: "codex-oauth",
        protocol: "codex",
        supports_reasoning: true,
        supports_fast: true,
        force_mapping: false,
    },
    OAuthAliasChannel {
        key: "kimi",
        provider: "Kimi OAuth",
        kind: "kimi-oauth",
        protocol: "openai",
        supports_reasoning: true,
        supports_fast: false,
        force_mapping: false,
    },
    OAuthAliasChannel {
        key: "xai",
        provider: "xAI OAuth",
        kind: "xai-oauth",
        protocol: "codex",
        supports_reasoning: true,
        supports_fast: false,
        force_mapping: false,
    },
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OAuthModelDefinitions {
    pub(crate) channel: OAuthAliasChannel,
    pub(crate) models: Vec<CodexModelDefinition>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AliasSourceCapability {
    Base,
    Reasoning,
    Fast,
}

pub(crate) fn oauth_alias_channel(channel: &str) -> Option<OAuthAliasChannel> {
    OAUTH_ALIAS_CHANNELS
        .iter()
        .copied()
        .find(|candidate| candidate.key.eq_ignore_ascii_case(channel))
}

pub(crate) fn oauth_alias_channel_details(channel: &str) -> (String, String, String) {
    oauth_alias_channel(channel)
        .map(|details| {
            (
                details.provider.to_string(),
                details.kind.to_string(),
                details.protocol.to_string(),
            )
        })
        .unwrap_or_else(|| {
            let channel = channel.trim().to_ascii_lowercase();
            (
                format!("{channel} OAuth"),
                format!("{channel}-oauth"),
                channel,
            )
        })
}

pub(crate) fn normalize_oauth_alias_channel(value: &str) -> Option<&'static str> {
    let value = value.trim().to_ascii_lowercase().replace('_', "-");
    match value.as_str() {
        "vertex" | "vertex-ai" => Some("vertex"),
        "aistudio" | "ai-studio" | "gemini" | "gemini-cli" => Some("aistudio"),
        "antigravity" | "anti-gravity" => Some("antigravity"),
        "claude" | "anthropic" => Some("claude"),
        "codex" => Some("codex"),
        "kimi" | "moonshot" => Some("kimi"),
        "xai" | "x-ai" | "grok" => Some("xai"),
        _ => None,
    }
}

pub(crate) async fn fetch_active_oauth_alias_channels(
    config: &GuiConfigFile,
) -> Result<std::collections::HashSet<String>, String> {
    let client = management_http_client()?;
    let response = send_management(
        client
            .get(management_endpoint(config, "auth-files")?)
            .header("Authorization", management_authorization(config)?)
            .header(reqwest::header::ACCEPT, "application/json"),
    )
    .await
    .map_err(|error| format_management_request_error("Failed to read OAuth credential sources", &error))?;
    let payload = read_management_value(response).await?;
    let files = payload
        .get("files")
        .and_then(serde_json::Value::as_array)
        .or_else(|| payload.as_array())
        .ok_or_else(|| "OAuth credential sources response is missing the files array".to_string())?;
    Ok(files
        .iter()
        .filter(|file| {
            !file
                .get("disabled")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
                && !file
                    .get("unavailable")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
        })
        .filter_map(|file| {
            ["provider", "type"]
                .into_iter()
                .find_map(|key| {
                    file.get(key)
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                })
                .and_then(normalize_oauth_alias_channel)
        })
        .map(str::to_string)
        .collect())
}

/// Validates the name of an alias that already exists in the configuration.
/// Older configs can hold aliases with spaces (display names written as
/// aliases), and those must stay deletable.
pub(crate) fn existing_thinking_alias_model_id(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    if value.len() > 240 || value.chars().any(char::is_control) {
        return Err(format!("Invalid {label} format"));
    }
    Ok(value.to_string())
}

pub(crate) fn validate_thinking_alias_model_id(value: &str, label: &str) -> Result<String, String> {
    let value = existing_thinking_alias_model_id(value, label)?;
    if value
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(format!("Invalid {label} format; cannot contain whitespace"));
    }
    Ok(value)
}

pub(crate) fn validate_thinking_alias_effort(value: &str) -> Result<String, String> {
    let effort = value.trim().to_ascii_lowercase();
    if effort.is_empty() {
        return Err("Thinking effort cannot be empty".to_string());
    }
    if effort.chars().all(|character| character.is_ascii_digit()) {
        return Err("Fixed thinking aliases do not support numeric-only budgets; enter a thinking level name".to_string());
    }
    if effort.len() > 64
        || !effort.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("Invalid thinking effort format; only letters, digits, hyphens, underscores, and dots are supported".to_string());
    }
    Ok(effort)
}

/// The core's config.yaml as Arbor's alias and agent code reads it. A core v8 file comes back in the legacy
/// layout (see `core_v8_yaml_to_legacy_view`), so every reader keeps working on one shape.
/// Legacy top-level provider sections and the v8 `api-keys.<provider>` groups they became.
pub(crate) const V8_PROVIDER_FAMILIES: [(&str, &str); 8] = [
    ("gemini-api-key", "gemini"),
    ("interactions-api-key", "interactions"),
    ("vertex-api-key", "vertex"),
    ("codex-api-key", "codex"),
    ("claude-api-key", "claude"),
    ("xai-api-key", "xai"),
    ("meta-api-key", "meta"),
    ("openai-compatibility", "openai-compatibility"),
];

/// Legacy sections core v8 moved under a parent, as (legacy key, v8 path).
const V8_MOVED_SECTIONS: [(&str, [&str; 2]); 3] = [
    ("api-keys", ["access", "api-keys"]),
    ("oauth-model-alias", ["oauth", "model-alias"]),
    ("payload", ["requests", "payload"]),
];

/// Fields a v8 provider group shares with every key in it.
fn is_v8_shared_provider_field(field: &str) -> bool {
    matches!(
        field,
        "priority"
            | "prefix"
            | "proxy-url"
            | "headers"
            | "models"
            | "excluded-models"
            | "disable-cooling"
            | "request-retry"
            | "request-scoped-errors"
            | "base-url"
    )
}

/// Turns v8 provider groups into legacy records: one per key, carrying the group's shared fields with the key's
/// own non-null overrides on top. An OpenAI-compatible group stays one record, its keys as `api-key-entries`.
pub(crate) fn flatten_v8_provider_groups(
    provider: &str,
    groups: &serde_norway::Value,
) -> Result<serde_norway::Value, String> {
    if groups.is_null() {
        return Ok(serde_norway::Value::Sequence(Vec::new()));
    }
    let groups = groups
        .as_sequence()
        .ok_or_else(|| format!("api-keys.{provider} must be an array"))?;
    let mut records = Vec::new();
    for (group_index, group) in groups.iter().enumerate() {
        let group = group
            .as_mapping()
            .ok_or_else(|| format!("api-keys.{provider}[{group_index}] must be an object"))?;
        let keys = match yaml_mapping_value(group, "keys") {
            None | Some(serde_norway::Value::Null) => Vec::new(),
            Some(keys) => keys
                .as_sequence()
                .cloned()
                .ok_or_else(|| format!("api-keys.{provider}[{group_index}].keys must be an array"))?,
        };
        if provider == "openai-compatibility" {
            let mut record = group.clone();
            record.remove(yaml_key("keys"));
            if !keys.is_empty() {
                record.insert(yaml_key("api-key-entries"), serde_norway::Value::Sequence(keys));
            }
            records.push(serde_norway::Value::Mapping(record));
            continue;
        }
        for (key_index, key) in keys.iter().enumerate() {
            let key = key.as_mapping().ok_or_else(|| {
                format!("api-keys.{provider}[{group_index}].keys[{key_index}] must be an object")
            })?;
            let mut record = serde_norway::Mapping::new();
            for (field, value) in group {
                if field.as_str().is_some_and(is_v8_shared_provider_field) {
                    record.insert(field.clone(), value.clone());
                }
            }
            for (field, value) in key {
                if !value.is_null() {
                    record.insert(field.clone(), value.clone());
                }
            }
            records.push(serde_norway::Value::Mapping(record));
        }
    }
    Ok(serde_norway::Value::Sequence(records))
}

/// Builds v8 provider groups from legacy records, one group per record.
pub(crate) fn group_legacy_provider_records(
    provider: &str,
    records: &serde_norway::Value,
) -> Result<serde_norway::Value, String> {
    let records = records
        .as_sequence()
        .ok_or_else(|| format!("{provider} provider configuration must be an array"))?;
    let mut groups = Vec::new();
    for (index, record) in records.iter().enumerate() {
        let record = record
            .as_mapping()
            .ok_or_else(|| format!("{provider} provider entry {index} must be an object"))?;
        if provider == "openai-compatibility" {
            let mut group = record.clone();
            let keys = group
                .remove(yaml_key("api-key-entries"))
                .unwrap_or_else(|| serde_norway::Value::Sequence(Vec::new()));
            group.insert(yaml_key("keys"), keys);
            groups.push(serde_norway::Value::Mapping(group));
            continue;
        }
        let mut group = serde_norway::Mapping::new();
        group.insert(
            yaml_key("name"),
            serde_norway::Value::String(format!("{provider}-{}", index + 1)),
        );
        let mut key = serde_norway::Mapping::new();
        for (field, value) in record {
            if field.as_str().is_some_and(is_v8_shared_provider_field) {
                group.insert(field.clone(), value.clone());
            } else {
                key.insert(field.clone(), value.clone());
            }
        }
        group.insert(
            yaml_key("keys"),
            serde_norway::Value::Sequence(vec![serde_norway::Value::Mapping(key)]),
        );
        groups.push(serde_norway::Value::Mapping(group));
    }
    Ok(serde_norway::Value::Sequence(groups))
}

/// Puts edited legacy records back into the v8 groups they came from, keeping each group's name, key list, and
/// inheritance, so an alias edit to one record's `models` changes only that. A shared field that changed the same
/// way for every key in a group changes on the group; otherwise the changed keys get their own override. When
/// the records no longer line up with the groups (added or removed records), each record becomes its own group.
pub(crate) fn regroup_legacy_provider_records(
    provider: &str,
    original_groups: &serde_norway::Value,
    before: &serde_norway::Value,
    after: &serde_norway::Value,
) -> Result<serde_norway::Value, String> {
    let fallback = || group_legacy_provider_records(provider, after);
    if provider == "openai-compatibility" {
        return fallback();
    }
    let (Some(groups), Some(before_records), Some(after_records)) = (
        original_groups.as_sequence(),
        before.as_sequence(),
        after.as_sequence(),
    ) else {
        return fallback();
    };
    if before_records.len() != after_records.len()
        || flatten_v8_provider_groups(provider, original_groups).ok().as_ref() != Some(before)
    {
        return fallback();
    }
    let mut regrouped = Vec::new();
    let mut offset = 0;
    for group in groups {
        let Some(mut group) = group.as_mapping().cloned() else {
            return fallback();
        };
        let mut keys = match yaml_mapping_value(&group, "keys") {
            None | Some(serde_norway::Value::Null) => Vec::new(),
            Some(keys) => match keys.as_sequence() {
                Some(keys) => keys.clone(),
                None => return fallback(),
            },
        };
        let range = offset..offset + keys.len();
        offset += keys.len();
        let (Some(before_group), Some(after_group)) = (
            before_records.get(range.clone()),
            after_records.get(range),
        ) else {
            return fallback();
        };
        let record_field = |record: &serde_norway::Value, field: &serde_norway::Value| {
            record.as_mapping().and_then(|record| record.get(field)).cloned()
        };
        let mut fields: Vec<serde_norway::Value> = Vec::new();
        for record in before_group.iter().chain(after_group) {
            let Some(record) = record.as_mapping() else {
                return fallback();
            };
            for field in record.keys() {
                if !fields.contains(field) {
                    fields.push(field.clone());
                }
            }
        }
        for field in fields {
            let changed = before_group
                .iter()
                .zip(after_group)
                .map(|(before, after)| record_field(before, &field) != record_field(after, &field))
                .collect::<Vec<_>>();
            if !changed.contains(&true) {
                continue;
            }
            let shared = field.as_str().is_some_and(is_v8_shared_provider_field);
            let values = after_group
                .iter()
                .map(|record| record_field(record, &field))
                .collect::<Vec<_>>();
            let key_overrides = keys.iter().any(|key| {
                key.as_mapping()
                    .and_then(|key| key.get(&field))
                    .is_some_and(|value| !value.is_null())
            });
            if shared && !key_overrides && values.windows(2).all(|pair| pair[0] == pair[1]) {
                match values.first().cloned().flatten() {
                    Some(value) => {
                        group.insert(field.clone(), value);
                    }
                    None => {
                        group.remove(&field);
                    }
                }
                continue;
            }
            for ((key, changed), value) in keys.iter_mut().zip(changed).zip(values) {
                if !changed {
                    continue;
                }
                let Some(key) = key.as_mapping_mut() else {
                    return fallback();
                };
                match value {
                    Some(value) => {
                        key.insert(field.clone(), value);
                    }
                    // A key can't drop a field its group still sets; only a group of its own can.
                    None if shared && group.get(&field).is_some_and(|value| !value.is_null()) => {
                        return fallback();
                    }
                    None => {
                        key.remove(&field);
                    }
                }
            }
        }
        group.insert(yaml_key("keys"), serde_norway::Value::Sequence(keys));
        regrouped.push(serde_norway::Value::Mapping(group));
    }
    let regrouped = serde_norway::Value::Sequence(regrouped);
    if offset != after_records.len()
        || flatten_v8_provider_groups(provider, &regrouped).ok().as_ref() != Some(after)
    {
        return fallback();
    }
    Ok(regrouped)
}

/// Shows a core v8 config.yaml in the legacy layout Arbor's alias and agent code reads: client keys from
/// `access.api-keys` as top-level `api-keys`, `oauth.model-alias` as `oauth-model-alias`, `requests.payload` as
/// `payload`, and each `api-keys.<provider>` group list as its legacy provider section. A present v8 value wins
/// over a legacy one, as it does in the core. Other files are returned unchanged.
pub(crate) fn core_v8_yaml_to_legacy_view(content: &str) -> Result<String, String> {
    let mut document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?;
    if !core_config_uses_v8(&document) {
        return Ok(content.to_string());
    }
    let root = document
        .as_mapping_mut()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    let upstreams = yaml_mapping_value(root, "api-keys")
        .and_then(serde_norway::Value::as_mapping)
        .cloned();
    if upstreams.is_some() {
        root.remove(yaml_key("api-keys"));
    }
    for (legacy, [parent, child]) in V8_MOVED_SECTIONS {
        let Some(section) =
            yaml_mapping_value_mut(root, parent).and_then(serde_norway::Value::as_mapping_mut)
        else {
            continue;
        };
        let Some(value) = section.remove(yaml_key(child)) else {
            continue;
        };
        root.insert(yaml_key(legacy), value);
    }
    // An empty parent reads the same as a missing one, so a save that rolls back and leaves `requests: {}` behind
    // still matches the file it started from. Parents with anything else in them stay.
    for (_, [parent, _]) in V8_MOVED_SECTIONS {
        if yaml_mapping_value(root, parent).and_then(serde_norway::Value::as_mapping).is_some_and(serde_norway::Mapping::is_empty) {
            root.remove(yaml_key(parent));
        }
    }
    if let Some(upstreams) = upstreams {
        for (legacy, provider) in V8_PROVIDER_FAMILIES {
            if let Some(groups) = yaml_mapping_value(&upstreams, provider) {
                root.insert(yaml_key(legacy), flatten_v8_provider_groups(provider, groups)?);
            }
        }
    }
    serde_norway::to_string(&document)
        .map_err(|error| format!("Failed to serialize core YAML configuration: {error}"))
}

fn set_or_remove_core_yaml_path_value(
    document: &mut serde_norway::Value,
    path: &[&str],
    value: Option<&serde_norway::Value>,
) -> Result<(), String> {
    match value {
        Some(value) => set_core_yaml_path_value(document, path, value.clone()).map(|_| ()),
        None => {
            remove_core_yaml_path_value(document, path);
            Ok(())
        }
    }
}

/// Applies the difference between `file`'s legacy view and `updated_view` to `file`, a core v8 config.yaml, and
/// returns the file to save. Moved sections go back to wherever `file` keeps them (its v8 path, or a legacy key
/// the core still reads because no v8 value overrides it). The file's comments are kept where the change allows.
pub(crate) fn legacy_view_changes_to_core_v8_yaml(
    file: &str,
    updated_view: &str,
) -> Result<String, String> {
    let file_document = serde_norway::from_str::<serde_norway::Value>(file)
        .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?;
    if !core_config_uses_v8(&file_document) {
        return Ok(updated_view.to_string());
    }
    let parse_mapping = |content: &str| {
        serde_norway::from_str::<serde_norway::Value>(content)
            .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?
            .as_mapping()
            .cloned()
            .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())
    };
    let current = parse_mapping(&core_v8_yaml_to_legacy_view(file)?)?;
    let updated = parse_mapping(updated_view)?;
    let file_root = file_document
        .as_mapping()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    let mut document = file_document.clone();

    let mut keys: Vec<serde_norway::Value> = current.keys().cloned().collect();
    for key in updated.keys() {
        if !keys.contains(key) {
            keys.push(key.clone());
        }
    }
    for key in keys {
        let before = current.get(&key);
        let after = updated.get(&key);
        if before == after {
            continue;
        }
        let name = key
            .as_str()
            .ok_or_else(|| "Core configuration mapping keys must be strings".to_string())?;
        if let Some((legacy, v8_path)) = V8_MOVED_SECTIONS
            .iter()
            .find(|(legacy, _)| *legacy == name)
        {
            let legacy_in_use = nested_yaml_value(file_root, v8_path).is_none()
                && yaml_mapping_value(file_root, legacy).is_some_and(|value| {
                    *legacy != "api-keys" || !value.is_mapping()
                });
            let path: &[&str] = if legacy_in_use { &[legacy] } else { v8_path };
            set_or_remove_core_yaml_path_value(&mut document, path, after)?;
            continue;
        }
        if let Some((legacy, provider)) = V8_PROVIDER_FAMILIES
            .iter()
            .find(|(legacy, _)| *legacy == name)
        {
            let v8_path = ["api-keys", provider];
            let legacy_in_use = nested_yaml_value(file_root, &v8_path).is_none()
                && yaml_mapping_value(file_root, legacy).is_some();
            if legacy_in_use {
                set_or_remove_core_yaml_path_value(&mut document, &[legacy], after)?;
                continue;
            }
            let groups = match after {
                Some(records) => Some(regroup_legacy_provider_records(
                    provider,
                    nested_yaml_value(file_root, &v8_path)
                        .unwrap_or(&serde_norway::Value::Sequence(Vec::new())),
                    before.unwrap_or(&serde_norway::Value::Sequence(Vec::new())),
                    records,
                )?),
                None => None,
            };
            set_or_remove_core_yaml_path_value(&mut document, &v8_path, groups.as_ref())?;
            continue;
        }
        if matches!(name, "config-version" | "access" | "oauth" | "requests") {
            return Err(format!(
                "The update changed the core v8 section {name}, which Arbor does not edit here; write rejected"
            ));
        }
        set_or_remove_core_yaml_path_value(&mut document, &[name], after)?;
    }
    if document == file_document {
        return Ok(file.to_string());
    }
    // A save the comment-preserving writer can't place exactly is written plainly rather than not at all.
    render_yaml_value_changes(file, &file_document, &document).or_else(|_| {
        serde_norway::to_string(&document)
            .map_err(|error| format!("Failed to serialize core YAML configuration: {error}"))
    })
}

pub(crate) async fn fetch_oauth_channel_model_definitions(
    config: &GuiConfigFile,
    channel: &str,
) -> Result<Vec<CodexModelDefinition>, String> {
    let client = management_http_client()?;
    let response = send_management(
        client
            .get(management_endpoint(
                config,
                &format!("model-definitions/{channel}"),
            )?)
            .header("Authorization", management_authorization(config)?)
            .header(reqwest::header::ACCEPT, "application/json"),
    )
    .await
    .map_err(|error| {
        format_management_request_error(&format!("Failed to read {channel} OAuth model definitions"), &error)
    })?;
    let payload = read_management_value(response).await?;
    parse_codex_model_definitions(&payload)
}

pub(crate) async fn fetch_oauth_model_definitions(
    config: &GuiConfigFile,
) -> Vec<OAuthModelDefinitions> {
    let active_channels = fetch_active_oauth_alias_channels(config).await.ok();
    let mut definitions = Vec::new();
    for channel in OAUTH_ALIAS_CHANNELS {
        if active_channels
            .as_ref()
            .is_some_and(|active| !active.contains(channel.key))
        {
            continue;
        }
        if let Ok(models) = fetch_oauth_channel_model_definitions(config, channel.key).await {
            definitions.push(OAuthModelDefinitions { channel, models });
        }
    }
    definitions
}

#[cfg(test)]
pub(crate) fn resolved_thinking_alias_sources(
    content: &str,
    definitions: &[CodexModelDefinition],
    available_models: &[AgentModelOption],
) -> Result<Vec<ResolvedThinkingAliasSource>, String> {
    let definitions = codex_oauth_definition_set(definitions);
    resolved_oauth_alias_sources(
        content,
        &definitions,
        available_models,
        AliasSourceCapability::Reasoning,
    )
}

#[cfg(test)]
pub(crate) fn resolved_speed_alias_sources(
    content: &str,
    definitions: &[CodexModelDefinition],
    available_models: &[AgentModelOption],
) -> Result<Vec<ResolvedThinkingAliasSource>, String> {
    let definitions = codex_oauth_definition_set(definitions);
    resolved_oauth_alias_sources(
        content,
        &definitions,
        available_models,
        AliasSourceCapability::Fast,
    )
}

#[cfg(test)]
pub(crate) fn resolved_alias_sources(
    content: &str,
    definitions: &[CodexModelDefinition],
    available_models: &[AgentModelOption],
    require_reasoning_levels: bool,
) -> Result<Vec<ResolvedThinkingAliasSource>, String> {
    let definitions = codex_oauth_definition_set(definitions);
    resolved_oauth_alias_sources(
        content,
        &definitions,
        available_models,
        if require_reasoning_levels {
            AliasSourceCapability::Reasoning
        } else {
            AliasSourceCapability::Base
        },
    )
}

#[cfg(test)]
pub(crate) fn codex_oauth_definition_set(
    definitions: &[CodexModelDefinition],
) -> Vec<OAuthModelDefinitions> {
    vec![OAuthModelDefinitions {
        channel: OAUTH_ALIAS_CHANNELS
            .iter()
            .copied()
            .find(|channel| channel.key == "codex")
            .expect("codex OAuth alias channel must exist"),
        models: definitions.to_vec(),
    }]
}

pub(crate) fn resolved_oauth_alias_sources(
    content: &str,
    definition_sets: &[OAuthModelDefinitions],
    available_models: &[AgentModelOption],
    capability: AliasSourceCapability,
) -> Result<Vec<ResolvedThinkingAliasSource>, String> {
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    // A configured API-key model must win over a catalog entry with the same
    // name. `model-definitions/codex` describes the OAuth channel's capabilities;
    // it is not evidence that a model returned by /v1/models is using OAuth.
    // Otherwise a Codex API alias would be written to oauth-model-alias, which
    // CPA deliberately does not apply to codex-api-key credentials.
    let mut sources = Vec::new();
    collect_config_thinking_alias_sources(
        root,
        "codex-api-key",
        "Codex API",
        "codex-api",
        "codex",
        available_models,
        &mut sources,
    )?;
    collect_config_thinking_alias_sources(
        root,
        "openai-compatibility",
        "OpenAI compatible",
        "openai-compatible",
        "openai",
        available_models,
        &mut sources,
    )?;
    collect_config_thinking_alias_sources(
        root,
        "claude-api-key",
        "Claude API",
        "claude-api",
        "claude",
        available_models,
        &mut sources,
    )?;
    collect_config_thinking_alias_sources(
        root,
        "gemini-api-key",
        "Gemini API",
        "gemini-api",
        "gemini",
        available_models,
        &mut sources,
    )?;
    match capability {
        AliasSourceCapability::Reasoning => {
            sources.retain(|source| !source.source.reasoning_levels.is_empty())
        }
        AliasSourceCapability::Fast => sources.retain(alias_source_supports_fast),
        AliasSourceCapability::Base => {}
    }
    let configured_codex_api_models = sources
        .iter()
        .filter(|source| source.source.kind == "codex-api")
        .map(|source| source.source.model.to_ascii_lowercase())
        .collect::<std::collections::HashSet<_>>();
    for definition_set in definition_sets {
        let channel = definition_set.channel;
        let supports_capability = match capability {
            AliasSourceCapability::Base => true,
            AliasSourceCapability::Reasoning => channel.supports_reasoning,
            AliasSourceCapability::Fast => channel.supports_fast,
        };
        if !supports_capability {
            continue;
        }
        sources.extend(
            definition_set
                .models
                .iter()
                .filter(|definition| {
                    (capability != AliasSourceCapability::Reasoning
                        || !definition.reasoning_levels.is_empty())
                        && thinking_alias_model_is_available(available_models, &definition.id)
                        && (channel.key != "codex"
                            || !configured_codex_api_models
                                .contains(&definition.id.to_ascii_lowercase()))
                })
                .map(|definition| ResolvedThinkingAliasSource {
                    source: ThinkingAliasSource {
                        id: format!("{}:{}", channel.kind, definition.id),
                        model: definition.id.clone(),
                        display_name: definition.display_name.clone(),
                        provider: channel.provider.to_string(),
                        kind: channel.kind.to_string(),
                        protocol: channel.protocol.to_string(),
                        reasoning_levels: definition.reasoning_levels.clone(),
                    },
                    location: ThinkingAliasSourceLocation::Oauth {
                        channel: channel.key,
                        force_mapping: channel.force_mapping,
                    },
                }),
        );
    }
    Ok(sources)
}

pub(crate) fn thinking_alias_model_is_available(
    available_models: &[AgentModelOption],
    model: &str,
) -> bool {
    available_models
        .iter()
        .any(|available| available.name.eq_ignore_ascii_case(model))
}

pub(crate) fn alias_source_supports_fast(source: &ResolvedThinkingAliasSource) -> bool {
    match &source.location {
        ThinkingAliasSourceLocation::Oauth { channel, .. } => *channel == "codex",
        ThinkingAliasSourceLocation::ConfigModel { section, .. } => {
            matches!(*section, "codex-api-key" | "openai-compatibility")
        }
    }
}

pub(crate) fn collect_config_thinking_alias_sources(
    root: &serde_norway::Mapping,
    section: &'static str,
    fallback_provider: &str,
    kind: &str,
    protocol: &str,
    available_models: &[AgentModelOption],
    sources: &mut Vec<ResolvedThinkingAliasSource>,
) -> Result<(), String> {
    let Some(providers) = yaml_mapping_value(root, section) else {
        return Ok(());
    };
    let providers = providers
        .as_sequence()
        .ok_or_else(|| format!("{section} must be an array"))?;
    for (provider_index, provider) in providers.iter().enumerate() {
        let Some(provider) = provider.as_mapping() else {
            continue;
        };
        if matches!(
            yaml_mapping_value(provider, "disabled"),
            Some(serde_norway::Value::Bool(true))
        ) {
            continue;
        }
        let provider_name =
            thinking_alias_provider_name(provider, fallback_provider, provider_index);
        let provider_revision = config_provider_revision(provider)?;
        let Some(models) = yaml_mapping_value(provider, "models") else {
            continue;
        };
        let models = models
            .as_sequence()
            .ok_or_else(|| format!("{section}.models must be an array"))?;
        for (model_index, model) in models.iter().enumerate() {
            let Some((upstream_model, client_model, display_name)) =
                configured_model_identity(model)
            else {
                continue;
            };
            if !thinking_alias_model_is_available(available_models, &client_model) {
                continue;
            }
            if client_model != upstream_model
                && find_thinking_alias_effort(root, &client_model, protocol).is_some()
            {
                continue;
            }
            let reasoning_levels = configured_model_reasoning_levels(model, protocol);
            sources.push(ResolvedThinkingAliasSource {
                source: ThinkingAliasSource {
                    id: config_alias_source_id(
                        section,
                        provider_index,
                        model_index,
                        &provider_revision,
                    ),
                    model: client_model,
                    display_name,
                    provider: provider_name.clone(),
                    kind: kind.to_string(),
                    protocol: protocol.to_string(),
                    reasoning_levels,
                },
                location: ThinkingAliasSourceLocation::ConfigModel {
                    section,
                    provider_index,
                    model_index,
                },
            });
        }
    }
    Ok(())
}

/// Configured model sources are addressed by position, so their IDs also carry a
/// hash of the whole provider entry. An ID taken from an older snapshot then
/// stops resolving once the provider list or that provider's models shift,
/// instead of silently pointing at a different model.
fn config_provider_revision(provider: &serde_norway::Mapping) -> Result<String, String> {
    Ok(sha256_bytes(
        serde_norway::to_string(provider)
            .map_err(|error| format!("Failed to read model source configuration: {error}"))?
            .as_bytes(),
    ))
}

fn config_alias_source_id(
    section: &str,
    provider_index: usize,
    model_index: usize,
    provider_revision: &str,
) -> String {
    format!("{section}:{provider_index}:{model_index}:{provider_revision}")
}

pub(crate) fn configured_model_reasoning_levels(
    model: &serde_norway::Value,
    protocol: &str,
) -> Vec<String> {
    let mut levels = model
        .as_mapping()
        .and_then(|model| yaml_mapping_value(model, "thinking"))
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|thinking| yaml_mapping_value(thinking, "levels"))
        .and_then(serde_norway::Value::as_sequence)
        .into_iter()
        .flatten()
        .filter_map(serde_norway::Value::as_str)
        .map(str::trim)
        .filter(|level| !level.is_empty())
        .map(str::to_ascii_lowercase)
        .fold(Vec::new(), |mut result, level| {
            if !result.contains(&level) {
                result.push(level);
            }
            result
        });
    if levels.is_empty() && matches!(protocol, "codex" | "openai") {
        levels = ["low", "medium", "high", "xhigh", "max"]
            .into_iter()
            .map(str::to_string)
            .collect();
    }
    levels
}

pub(crate) fn thinking_alias_provider_name(
    provider: &serde_norway::Mapping,
    fallback: &str,
    index: usize,
) -> String {
    yaml_mapping_value(provider, "name")
        .or_else(|| yaml_mapping_value(provider, "base-url"))
        .and_then(serde_norway::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{fallback} {}", index + 1))
}

pub(crate) fn configured_model_identity(
    model: &serde_norway::Value,
) -> Option<(String, String, Option<String>)> {
    if let Some(name) = model
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        return Some((name.to_string(), name.to_string(), None));
    }
    let model = model.as_mapping()?;
    let name = yaml_mapping_value(model, "name")
        .and_then(serde_norway::Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    let alias = yaml_mapping_value(model, "alias")
        .and_then(serde_norway::Value::as_str)
        .map(str::trim)
        .filter(|alias| !alias.is_empty());
    let display_name = yaml_mapping_value(model, "display-name")
        .or_else(|| yaml_mapping_value(model, "display_name"))
        .and_then(serde_norway::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some((
        name.to_string(),
        alias.unwrap_or(name).to_string(),
        display_name,
    ))
}

pub(crate) fn thinking_aliases_from_yaml(content: &str) -> Result<Vec<ThinkingAliasEntry>, String> {
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?;
    thinking_aliases_from_value(&document)
}

pub(crate) fn thinking_aliases_from_value(
    document: &serde_norway::Value,
) -> Result<Vec<ThinkingAliasEntry>, String> {
    let root = document
        .as_mapping()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    let mut entries = Vec::new();
    if let Some(oauth_aliases) = yaml_mapping_value(root, "oauth-model-alias") {
        let oauth_aliases = oauth_aliases
            .as_mapping()
            .ok_or_else(|| "oauth-model-alias must be a YAML mapping".to_string())?;
        for (channel, channel_aliases) in oauth_aliases {
            let channel = channel.as_str().unwrap_or("unknown");
            let channel_aliases = channel_aliases
                .as_sequence()
                .ok_or_else(|| format!("oauth-model-alias.{channel} must be an array"))?;
            let (provider, kind, protocol) = oauth_alias_channel_details(channel);
            for entry in channel_aliases {
                let Some(mapping) = entry.as_mapping() else {
                    continue;
                };
                let Some(source_model) = yaml_mapping_value(mapping, "name")
                    .and_then(serde_norway::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                let Some(alias) = yaml_mapping_value(mapping, "alias")
                    .and_then(serde_norway::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                entries.push(ThinkingAliasEntry {
                    source_model: source_model.to_string(),
                    alias: alias.to_string(),
                    effort: find_thinking_alias_effort(root, alias, &protocol),
                    provider: provider.clone(),
                    kind: kind.clone(),
                    oauth_channel: Some(channel.to_string()),
                });
            }
        }
    }
    collect_config_thinking_alias_entries(
        root,
        "codex-api-key",
        "Codex API",
        "codex-api",
        "codex",
        &mut entries,
    )?;
    collect_config_thinking_alias_entries(
        root,
        "openai-compatibility",
        "OpenAI compatible",
        "openai-compatible",
        "openai",
        &mut entries,
    )?;
    collect_config_thinking_alias_entries(
        root,
        "claude-api-key",
        "Claude API",
        "claude-api",
        "claude",
        &mut entries,
    )?;
    collect_config_thinking_alias_entries(
        root,
        "gemini-api-key",
        "Gemini API",
        "gemini-api",
        "gemini",
        &mut entries,
    )?;
    entries.sort_by(|left, right| {
        left.provider
            .to_ascii_lowercase()
            .cmp(&right.provider.to_ascii_lowercase())
            .then_with(|| {
                left.alias
                    .to_ascii_lowercase()
                    .cmp(&right.alias.to_ascii_lowercase())
            })
    });
    Ok(entries)
}

pub(crate) fn speed_aliases_from_yaml(content: &str) -> Result<Vec<SpeedAliasEntry>, String> {
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?;
    speed_aliases_from_value(&document)
}

pub(crate) fn speed_aliases_from_value(
    document: &serde_norway::Value,
) -> Result<Vec<SpeedAliasEntry>, String> {
    let root = document
        .as_mapping()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    let mut entries = Vec::new();
    if let Some(oauth_aliases) = yaml_mapping_value(root, "oauth-model-alias") {
        let oauth_aliases = oauth_aliases
            .as_mapping()
            .ok_or_else(|| "oauth-model-alias must be a YAML mapping".to_string())?;
        for (channel, channel_aliases) in oauth_aliases {
            let channel = channel.as_str().unwrap_or("unknown");
            let channel_aliases = channel_aliases
                .as_sequence()
                .ok_or_else(|| format!("oauth-model-alias.{channel} must be an array"))?;
            let (provider, kind, protocol) = oauth_alias_channel_details(channel);
            for entry in channel_aliases {
                let Some(mapping) = entry.as_mapping() else {
                    continue;
                };
                let Some(source_model) = yaml_mapping_value(mapping, "name")
                    .and_then(serde_norway::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                let Some(alias) = yaml_mapping_value(mapping, "alias")
                    .and_then(serde_norway::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                let Some(service_tier) = find_speed_alias_service_tier(root, alias, &protocol)
                else {
                    continue;
                };
                entries.push(SpeedAliasEntry {
                    source_model: source_model.to_string(),
                    alias: alias.to_string(),
                    service_tier,
                    provider: provider.clone(),
                    kind: kind.clone(),
                    oauth_channel: Some(channel.to_string()),
                });
            }
        }
    }
    collect_config_speed_alias_entries(
        root,
        "codex-api-key",
        "Codex API",
        "codex-api",
        "codex",
        &mut entries,
    )?;
    collect_config_speed_alias_entries(
        root,
        "openai-compatibility",
        "OpenAI compatible",
        "openai-compatible",
        "openai",
        &mut entries,
    )?;
    entries.sort_by(|left, right| {
        left.provider
            .to_ascii_lowercase()
            .cmp(&right.provider.to_ascii_lowercase())
            .then_with(|| {
                left.alias
                    .to_ascii_lowercase()
                    .cmp(&right.alias.to_ascii_lowercase())
            })
    });
    Ok(entries)
}

pub(crate) fn collect_config_thinking_alias_entries(
    root: &serde_norway::Mapping,
    section: &str,
    fallback_provider: &str,
    kind: &str,
    protocol: &str,
    entries: &mut Vec<ThinkingAliasEntry>,
) -> Result<(), String> {
    let Some(providers) = yaml_mapping_value(root, section) else {
        return Ok(());
    };
    let providers = providers
        .as_sequence()
        .ok_or_else(|| format!("{section} must be an array"))?;
    for (provider_index, provider) in providers.iter().enumerate() {
        let Some(provider) = provider.as_mapping() else {
            continue;
        };
        let provider_name =
            thinking_alias_provider_name(provider, fallback_provider, provider_index);
        let Some(models) = yaml_mapping_value(provider, "models") else {
            continue;
        };
        let models = models
            .as_sequence()
            .ok_or_else(|| format!("{section}.models must be an array"))?;
        for model in models {
            let Some((source_model, alias, _)) = configured_model_identity(model) else {
                continue;
            };
            if source_model == alias {
                continue;
            }
            let effort = find_thinking_alias_effort(root, &alias, protocol);
            if effort.is_none() && find_speed_alias_service_tier(root, &alias, protocol).is_some() {
                continue;
            }
            entries.push(ThinkingAliasEntry {
                source_model,
                alias,
                effort,
                provider: provider_name.clone(),
                kind: kind.to_string(),
                oauth_channel: None,
            });
        }
    }
    Ok(())
}

pub(crate) fn collect_config_speed_alias_entries(
    root: &serde_norway::Mapping,
    section: &str,
    fallback_provider: &str,
    kind: &str,
    protocol: &str,
    entries: &mut Vec<SpeedAliasEntry>,
) -> Result<(), String> {
    let Some(providers) = yaml_mapping_value(root, section) else {
        return Ok(());
    };
    let providers = providers
        .as_sequence()
        .ok_or_else(|| format!("{section} must be an array"))?;
    for (provider_index, provider) in providers.iter().enumerate() {
        let Some(provider) = provider.as_mapping() else {
            continue;
        };
        let provider_name =
            thinking_alias_provider_name(provider, fallback_provider, provider_index);
        let Some(models) = yaml_mapping_value(provider, "models") else {
            continue;
        };
        let models = models
            .as_sequence()
            .ok_or_else(|| format!("{section}.models must be an array"))?;
        for model in models {
            let Some((source_model, alias, _)) = configured_model_identity(model) else {
                continue;
            };
            if source_model == alias {
                continue;
            }
            let Some(service_tier) = find_speed_alias_service_tier(root, &alias, protocol) else {
                continue;
            };
            entries.push(SpeedAliasEntry {
                source_model,
                alias,
                service_tier,
                provider: provider_name.clone(),
                kind: kind.to_string(),
                oauth_channel: None,
            });
        }
    }
    Ok(())
}

/// Params of the payload rules that apply to `alias`, in the order the core lets
/// them win: `override-raw` is applied after `override`, and a later rule
/// overwrites an earlier one. The flag is true for raw (JSON-encoded) params.
fn alias_override_params<'a>(
    root: &'a serde_norway::Mapping,
    alias: &'a str,
    protocol: &'a str,
) -> impl Iterator<Item = (&'a serde_norway::Mapping, bool)> {
    ["override-raw", "override"]
        .into_iter()
        .flat_map(move |section| {
            nested_yaml_value(root, &["payload", section])
                .and_then(serde_norway::Value::as_sequence)
                .into_iter()
                .flatten()
                .rev()
                .filter_map(move |rule| {
                    let rule = rule.as_mapping()?;
                    let models = yaml_mapping_value(rule, "models")?.as_sequence()?;
                    if !models
                        .iter()
                        .any(|model| thinking_payload_model_matches(model, alias, protocol))
                    {
                        return None;
                    }
                    Some((
                        yaml_mapping_value(rule, "params")?.as_mapping()?,
                        section == "override-raw",
                    ))
                })
        })
}

fn alias_payload_string(params: &serde_norway::Mapping, key: &str, raw: bool) -> Option<String> {
    let value = yaml_mapping_value(params, key)?.as_str()?;
    let decoded;
    let value = if raw {
        decoded = serde_json::from_str::<serde_json::Value>(value).ok()?;
        decoded.as_str()?
    } else {
        value
    };
    let value = value.trim().to_ascii_lowercase();
    (!value.is_empty()).then_some(value)
}

pub(crate) fn thinking_effort_from_params(
    params: &serde_norway::Mapping,
    protocol: &str,
    raw: bool,
) -> Option<String> {
    [
        "reasoning.effort",
        "reasoning_effort",
        "output_config.effort",
        "generationConfig.thinkingConfig.thinkingLevel",
        "thinking.effort",
    ]
    .into_iter()
    .find_map(|key| alias_payload_string(params, key, raw))
    .or_else(
        || match alias_payload_string(params, "thinking.type", raw)?.as_str() {
            "disabled" => Some("none".to_string()),
            "adaptive" if protocol.eq_ignore_ascii_case("claude") => Some("auto".to_string()),
            _ => None,
        },
    )
}

pub(crate) fn find_thinking_alias_effort(
    root: &serde_norway::Mapping,
    alias: &str,
    protocol: &str,
) -> Option<String> {
    alias_override_params(root, alias, protocol)
        .find_map(|(params, raw)| thinking_effort_from_params(params, protocol, raw))
}

pub(crate) fn find_speed_alias_service_tier(
    root: &serde_norway::Mapping,
    alias: &str,
    protocol: &str,
) -> Option<String> {
    alias_override_params(root, alias, protocol)
        .find_map(|(params, raw)| alias_payload_string(params, "service_tier", raw))
}

/// A payload model entry without a `protocol` applies to every protocol, which
/// is how the core matches it.
pub(crate) fn thinking_payload_model_matches(
    model: &serde_norway::Value,
    alias: &str,
    protocol: &str,
) -> bool {
    let Some(model) = model.as_mapping() else {
        return false;
    };
    let name_matches = yaml_mapping_value(model, "name")
        .and_then(serde_norway::Value::as_str)
        .is_some_and(|name| name.trim().eq_ignore_ascii_case(alias));
    let protocol_matches = yaml_mapping_value(model, "protocol").is_none_or(|value| {
        value.as_str().is_some_and(|value| {
            value.trim().is_empty() || value.trim().eq_ignore_ascii_case(protocol)
        })
    });
    name_matches && protocol_matches
}

pub(crate) fn thinking_payload_model_name_matches(
    model: &serde_norway::Value,
    alias: &str,
) -> bool {
    model
        .as_mapping()
        .and_then(|model| yaml_mapping_value(model, "name"))
        .and_then(serde_norway::Value::as_str)
        .is_some_and(|name| name.trim().eq_ignore_ascii_case(alias))
}

pub(crate) fn insert_thinking_effort_params(
    params: &mut serde_norway::Mapping,
    source: &ThinkingAliasSource,
    effort: &str,
) -> Result<(), String> {
    let insert = |params: &mut serde_norway::Mapping, key: &str, value: &str| {
        params.insert(
            yaml_key(key),
            serde_norway::Value::String(value.to_string()),
        );
    };
    match source.kind.as_str() {
        "claude-oauth" | "claude-api" => {
            if effort.eq_ignore_ascii_case("none") {
                insert(params, "thinking.type", "disabled");
            } else {
                insert(params, "thinking.type", "adaptive");
                if !effort.eq_ignore_ascii_case("auto") {
                    insert(params, "output_config.effort", effort);
                }
            }
        }
        "aistudio-oauth" | "vertex-oauth" | "gemini-api" => {
            insert(
                params,
                "generationConfig.thinkingConfig.thinkingLevel",
                effort,
            );
        }
        "antigravity-oauth" => {
            // Antigravity applies payload rules relative to its `request` object.
            insert(
                params,
                "generationConfig.thinkingConfig.thinkingLevel",
                effort,
            );
        }
        "kimi-oauth" => {
            if effort.eq_ignore_ascii_case("none") {
                insert(params, "thinking.type", "disabled");
            } else {
                insert(params, "thinking.type", "enabled");
                insert(params, "thinking.effort", effort);
            }
        }
        "codex-oauth" | "codex-api" | "xai-oauth" => {
            insert(params, "reasoning.effort", effort);
        }
        "openai-compatible" => {
            insert(params, "reasoning_effort", effort);
            if source.model.to_ascii_lowercase().starts_with("deepseek") {
                insert(params, "thinking.type", "enabled");
            }
        }
        _ => match source.protocol.as_str() {
            "codex" => insert(params, "reasoning.effort", effort),
            "openai" => insert(params, "reasoning_effort", effort),
            "claude" => {
                if effort.eq_ignore_ascii_case("none") {
                    insert(params, "thinking.type", "disabled");
                } else {
                    insert(params, "thinking.type", "adaptive");
                    if !effort.eq_ignore_ascii_case("auto") {
                        insert(params, "output_config.effort", effort);
                    }
                }
            }
            "gemini" | "antigravity" => insert(
                params,
                "generationConfig.thinkingConfig.thinkingLevel",
                effort,
            ),
            protocol => {
                return Err(format!("Overriding thinking effort for {protocol} sources is not yet supported"));
            }
        },
    }
    Ok(())
}

fn model_override_has_long_context(model: &str) -> bool {
    model.to_ascii_lowercase().ends_with("[1m]")
}

pub(crate) fn model_overrides_from_yaml(
    content: &str,
    definition_sets: &[OAuthModelDefinitions],
) -> Result<Vec<ModelOverrideEntry>, String> {
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    let mut overrides = Vec::new();
    let Some(channels) = yaml_mapping_value(root, "oauth-model-alias") else {
        return Ok(overrides);
    };
    let channels = channels
        .as_mapping()
        .ok_or_else(|| "oauth-model-alias must be a YAML mapping".to_string())?;
    for (channel, entries) in channels {
        let channel = channel.as_str().unwrap_or("unknown");
        let Some(definitions) = definition_sets
            .iter()
            .find(|set| set.channel.key.eq_ignore_ascii_case(channel))
        else {
            continue;
        };
        let entries = entries
            .as_sequence()
            .ok_or_else(|| format!("oauth-model-alias.{channel} must be an array"))?;
        let (provider, kind, _) = oauth_alias_channel_details(channel);
        for entry in entries {
            let Some(mapping) = entry.as_mapping() else {
                continue;
            };
            let Some(upstream) =
                yaml_mapping_value(mapping, "name").and_then(serde_norway::Value::as_str)
            else {
                continue;
            };
            let Some(requested) =
                yaml_mapping_value(mapping, "alias").and_then(serde_norway::Value::as_str)
            else {
                continue;
            };
            let long_context = model_override_has_long_context(requested);
            let catalog_id = if long_context {
                &requested[..requested.len() - 4]
            } else {
                requested
            };
            if !definitions
                .models
                .iter()
                .any(|model| model.id.eq_ignore_ascii_case(catalog_id))
            {
                continue;
            }
            overrides.push(ModelOverrideEntry {
                requested_model: requested.to_string(),
                upstream_model: upstream.to_string(),
                oauth_channel: channel.to_string(),
                provider: provider.clone(),
                kind: kind.clone(),
                force_mapping: yaml_mapping_value(mapping, "force-mapping")
                    .and_then(serde_norway::Value::as_bool)
                    .unwrap_or(false),
                long_context,
            });
        }
    }
    Ok(overrides)
}

/// The provider a requested model belongs to when it's another OAuth provider's than `channel`'s, by the
/// providers' own model lists: the core routes a request only within one provider, so such a route would never be
/// used. None when the name is unknown, or one of `channel`'s own.
pub(crate) fn other_provider_of(definitions: &[OAuthModelDefinitions], requested_model: &str, channel: &str) -> Option<&'static str> {
    let name = requested_model.strip_suffix("[1m]").or_else(|| requested_model.strip_suffix("[1M]")).unwrap_or(requested_model);
    let owners: Vec<&OAuthModelDefinitions> = definitions
        .iter()
        .filter(|set| set.models.iter().any(|model| model.id.eq_ignore_ascii_case(name)))
        .collect();
    if owners.iter().any(|set| set.channel.key == channel) {
        return None;
    }
    owners.first().map(|set| set.channel.provider)
}

pub(crate) fn add_model_override_to_yaml(
    content: &str,
    source: &ResolvedThinkingAliasSource,
    requested_model: &str,
    force_mapping: bool,
    include_long_context: bool,
) -> Result<String, String> {
    let ThinkingAliasSourceLocation::Oauth {
        channel,
        force_mapping: channel_force_mapping,
    } = &source.location
    else {
        return Err("Model overrides currently support OAuth model sources only".to_string());
    };
    let upstream = &source.source.model;
    if requested_model.eq_ignore_ascii_case(upstream) {
        return Err("The requested model cannot be the same as the upstream model".to_string());
    }
    let mut document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    let mut routes = vec![(requested_model.to_string(), upstream.clone())];
    if include_long_context && !model_override_has_long_context(requested_model) {
        routes.push((format!("{requested_model}[1m]"), format!("{upstream}[1m]")));
    }
    for (name, _) in &routes {
        if configured_model_alias_exists(root, name) {
            return Err(format!(
                "{name} is already routed or aliased; remove it first"
            ));
        }
    }
    for (requested, upstream) in routes {
        append_oauth_model_alias(
            root,
            channel,
            &upstream,
            &requested,
            force_mapping || *channel_force_mapping,
        )?;
    }
    render_updated_core_yaml(&mut document, updated)
}

pub(crate) fn remove_model_override_from_yaml(
    content: &str,
    requested_model: &str,
    oauth_channel: &str,
) -> Result<String, String> {
    let mut document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    let mut aliases = vec![requested_model.to_string()];
    if !model_override_has_long_context(requested_model) {
        aliases.push(format!("{requested_model}[1m]"));
    }
    // Overrides never write payload rules. Any rule naming the requested model
    // belongs to that real model, so it stays when the route is removed.
    let mut removed = false;
    for alias in aliases {
        removed |= remove_oauth_model_alias(root, &alias, Some(oauth_channel))?;
    }
    if !removed {
        return Err(format!(
            "Model override {requested_model} does not exist; refresh and try again"
        ));
    }
    render_updated_core_yaml(&mut document, updated)
}

pub(crate) fn add_model_alias_to_yaml(
    content: &str,
    source: &ResolvedThinkingAliasSource,
    alias: &str,
    effort: &str,
    fast: bool,
) -> Result<String, String> {
    if fast && !alias_source_supports_fast(source) {
        return Err("Fast only supports OpenAI compatible API, Codex API, or Codex OAuth model sources".to_string());
    }
    let mut document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;

    if configured_model_alias_exists(root, alias) {
        return Err(format!("Alias model {alias} already exists"));
    }

    match &source.location {
        ThinkingAliasSourceLocation::Oauth {
            channel,
            force_mapping,
        } => append_oauth_model_alias(root, channel, &source.source.model, alias, *force_mapping)?,
        ThinkingAliasSourceLocation::ConfigModel {
            section,
            provider_index,
            model_index,
        } => append_config_thinking_alias(
            root,
            section,
            *provider_index,
            *model_index,
            &source.source,
            alias,
            effort,
        )?,
    }

    let scope = AliasPayloadScope::for_protocol(&source.source.protocol);
    remove_alias_payload_options(root, alias, &scope)?;
    if !effort.is_empty() {
        let mut params_mapping = serde_norway::Mapping::new();
        insert_thinking_effort_params(&mut params_mapping, &source.source, effort)?;
        append_alias_payload_override(root, alias, &source.source.protocol, params_mapping)?;
    }
    if fast {
        let mut params_mapping = serde_norway::Mapping::new();
        params_mapping.insert(
            yaml_key("service_tier"),
            serde_norway::Value::String("priority".to_string()),
        );
        append_alias_payload_override(root, alias, &source.source.protocol, params_mapping)?;
    }

    render_updated_core_yaml(&mut document, updated)
}

pub(crate) fn append_alias_payload_override(
    root: &mut serde_norway::Mapping,
    alias: &str,
    protocol: &str,
    params_mapping: serde_norway::Mapping,
) -> Result<(), String> {
    if params_mapping.is_empty() {
        return Ok(());
    }
    let payload = root
        .entry(yaml_key("payload"))
        .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| "payload must be a YAML mapping".to_string())?;
    let override_rules = payload
        .entry(yaml_key("override"))
        .or_insert_with(|| serde_norway::Value::Sequence(Vec::new()))
        .as_sequence_mut()
        .ok_or_else(|| "payload.override must be an array".to_string())?;

    let mut model_mapping = serde_norway::Mapping::new();
    model_mapping.insert(
        yaml_key("name"),
        serde_norway::Value::String(alias.to_string()),
    );
    model_mapping.insert(
        yaml_key("protocol"),
        serde_norway::Value::String(protocol.to_string()),
    );
    let mut rule_mapping = serde_norway::Mapping::new();
    rule_mapping.insert(
        yaml_key("models"),
        serde_norway::Value::Sequence(vec![serde_norway::Value::Mapping(model_mapping)]),
    );
    rule_mapping.insert(
        yaml_key("params"),
        serde_norway::Value::Mapping(params_mapping),
    );
    override_rules.push(serde_norway::Value::Mapping(rule_mapping));
    Ok(())
}

pub(crate) fn add_speed_alias_to_yaml(
    content: &str,
    source: &ResolvedThinkingAliasSource,
    alias: &str,
) -> Result<String, String> {
    if !alias_source_supports_fast(source) {
        return Err("Fast only supports OpenAI compatible API, Codex API, or Codex OAuth model sources".to_string());
    }
    let mut document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;

    if configured_model_alias_exists(root, alias) {
        return Err(format!("Alias model {alias} already exists"));
    }

    match &source.location {
        ThinkingAliasSourceLocation::Oauth {
            channel,
            force_mapping,
        } => append_oauth_model_alias(root, channel, &source.source.model, alias, *force_mapping)?,
        ThinkingAliasSourceLocation::ConfigModel {
            section,
            provider_index,
            model_index,
        } => append_config_speed_alias(
            root,
            section,
            *provider_index,
            *model_index,
            &source.source,
            alias,
        )?,
    }

    remove_alias_payload_options(
        root,
        alias,
        &AliasPayloadScope::for_protocol(&source.source.protocol),
    )?;
    let mut params_mapping = serde_norway::Mapping::new();
    params_mapping.insert(
        yaml_key("service_tier"),
        serde_norway::Value::String("priority".to_string()),
    );
    append_alias_payload_override(root, alias, &source.source.protocol, params_mapping)?;

    render_updated_core_yaml(&mut document, updated)
}

pub(crate) fn append_oauth_model_alias(
    root: &mut serde_norway::Mapping,
    channel: &str,
    source_model: &str,
    alias: &str,
    force_mapping: bool,
) -> Result<(), String> {
    let oauth_aliases = root
        .entry(yaml_key("oauth-model-alias"))
        .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| "oauth-model-alias must be a YAML mapping".to_string())?;
    let channel_aliases = oauth_aliases
        .entry(yaml_key(channel))
        .or_insert_with(|| serde_norway::Value::Sequence(Vec::new()))
        .as_sequence_mut()
        .ok_or_else(|| format!("oauth-model-alias.{channel} must be an array"))?;
    let mut alias_mapping = serde_norway::Mapping::new();
    alias_mapping.insert(
        yaml_key("name"),
        serde_norway::Value::String(source_model.to_string()),
    );
    alias_mapping.insert(
        yaml_key("alias"),
        serde_norway::Value::String(alias.to_string()),
    );
    alias_mapping.insert(yaml_key("fork"), serde_norway::Value::Bool(true));
    if force_mapping {
        alias_mapping.insert(yaml_key("force-mapping"), serde_norway::Value::Bool(true));
    }
    channel_aliases.push(serde_norway::Value::Mapping(alias_mapping));
    Ok(())
}

pub(crate) fn append_config_thinking_alias(
    root: &mut serde_norway::Mapping,
    section: &str,
    provider_index: usize,
    model_index: usize,
    expected: &ThinkingAliasSource,
    alias: &str,
    effort: &str,
) -> Result<(), String> {
    let providers = yaml_mapping_value_mut(root, section)
        .and_then(serde_norway::Value::as_sequence_mut)
        .ok_or_else(|| format!("{section} must be an array"))?;
    let provider = providers
        .get_mut(provider_index)
        .and_then(serde_norway::Value::as_mapping_mut)
        .ok_or_else(|| "Model provider has changed; refresh and try again".to_string())?;
    // The source ID carries the provider revision, so a shifted provider list or
    // an edited provider can't bind the alias to a different model.
    let provider_revision = config_provider_revision(provider)?;
    if config_alias_source_id(section, provider_index, model_index, &provider_revision)
        != expected.id
    {
        return Err("Original model has changed; refresh and try again".to_string());
    }
    let models = yaml_mapping_value_mut(provider, "models")
        .and_then(serde_norway::Value::as_sequence_mut)
        .ok_or_else(|| format!("{section}.models must be an array"))?;
    let source = models
        .get(model_index)
        .cloned()
        .ok_or_else(|| "Original model has changed; refresh and try again".to_string())?;
    let (_, current_model, _) =
        configured_model_identity(&source).ok_or_else(|| "Invalid original model configuration format".to_string())?;
    if !current_model.eq_ignore_ascii_case(&expected.model) {
        return Err("Original model has changed; refresh and try again".to_string());
    }
    let mut alias_model = source.as_mapping().cloned().unwrap_or_else(|| {
        let mut mapping = serde_norway::Mapping::new();
        if let Some(name) = source.as_str() {
            mapping.insert(
                yaml_key("name"),
                serde_norway::Value::String(name.to_string()),
            );
        }
        mapping
    });
    alias_model.insert(
        yaml_key("alias"),
        serde_norway::Value::String(alias.to_string()),
    );
    if !effort.is_empty() {
        if let Some(display_name) = yaml_mapping_value(&alias_model, "display-name")
            .and_then(serde_norway::Value::as_str)
            .map(str::to_string)
        {
            alias_model.insert(
                yaml_key("display-name"),
                serde_norway::Value::String(format!("{display_name} ({effort})")),
            );
        }
    }
    models.push(serde_norway::Value::Mapping(alias_model));
    Ok(())
}

pub(crate) fn append_config_speed_alias(
    root: &mut serde_norway::Mapping,
    section: &str,
    provider_index: usize,
    model_index: usize,
    expected: &ThinkingAliasSource,
    alias: &str,
) -> Result<(), String> {
    let providers = yaml_mapping_value_mut(root, section)
        .and_then(serde_norway::Value::as_sequence_mut)
        .ok_or_else(|| format!("{section} must be an array"))?;
    let provider = providers
        .get_mut(provider_index)
        .and_then(serde_norway::Value::as_mapping_mut)
        .ok_or_else(|| "Model provider has changed; refresh and try again".to_string())?;
    // The source ID carries the provider revision, so a shifted provider list or
    // an edited provider can't bind the alias to a different model.
    let provider_revision = config_provider_revision(provider)?;
    if config_alias_source_id(section, provider_index, model_index, &provider_revision)
        != expected.id
    {
        return Err("Original model has changed; refresh and try again".to_string());
    }
    let models = yaml_mapping_value_mut(provider, "models")
        .and_then(serde_norway::Value::as_sequence_mut)
        .ok_or_else(|| format!("{section}.models must be an array"))?;
    let source = models
        .get(model_index)
        .cloned()
        .ok_or_else(|| "Original model has changed; refresh and try again".to_string())?;
    let (_, current_model, _) =
        configured_model_identity(&source).ok_or_else(|| "Invalid original model configuration format".to_string())?;
    if !current_model.eq_ignore_ascii_case(&expected.model) {
        return Err("Original model has changed; refresh and try again".to_string());
    }
    let mut alias_model = source.as_mapping().cloned().unwrap_or_else(|| {
        let mut mapping = serde_norway::Mapping::new();
        if let Some(name) = source.as_str() {
            mapping.insert(
                yaml_key("name"),
                serde_norway::Value::String(name.to_string()),
            );
        }
        mapping
    });
    alias_model.insert(
        yaml_key("alias"),
        serde_norway::Value::String(alias.to_string()),
    );
    if let Some(display_name) = yaml_mapping_value(&alias_model, "display-name")
        .and_then(serde_norway::Value::as_str)
        .map(str::to_string)
    {
        alias_model.insert(
            yaml_key("display-name"),
            serde_norway::Value::String(format!("{display_name} (Fast)")),
        );
    }
    models.push(serde_norway::Value::Mapping(alias_model));
    Ok(())
}

#[cfg(test)]
pub(crate) fn remove_thinking_alias_from_yaml(
    content: &str,
    alias: &str,
) -> Result<String, String> {
    remove_thinking_alias_from_yaml_for_channel(content, alias, None)
}

pub(crate) fn remove_thinking_alias_from_yaml_for_channel(
    content: &str,
    alias: &str,
    oauth_channel: Option<&str>,
) -> Result<String, String> {
    let mut document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    let mut removed = remove_oauth_model_alias(root, alias, oauth_channel)?;
    if oauth_channel.is_none() {
        removed |= remove_config_model_alias(root, "codex-api-key", alias)?;
        removed |= remove_config_model_alias(root, "openai-compatibility", alias)?;
        removed |= remove_config_model_alias(root, "claude-api-key", alias)?;
        removed |= remove_config_model_alias(root, "gemini-api-key", alias)?;
    }
    if !removed {
        return Err(format!("Alias model {alias} does not exist; refresh and try again"));
    }
    let scope = AliasPayloadScope::after_removal(root, alias, oauth_channel);
    remove_alias_payload_options(root, alias, &scope)?;
    render_updated_core_yaml(&mut document, updated)
}

#[cfg(test)]
pub(crate) fn remove_speed_alias_from_yaml(content: &str, alias: &str) -> Result<String, String> {
    remove_speed_alias_from_yaml_for_channel(content, alias, None)
}

pub(crate) fn remove_speed_alias_from_yaml_for_channel(
    content: &str,
    alias: &str,
    oauth_channel: Option<&str>,
) -> Result<String, String> {
    let mut document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    let mut removed = remove_oauth_model_alias(root, alias, oauth_channel)?;
    if oauth_channel.is_none() {
        removed |= remove_config_speed_alias(root, "codex-api-key", "codex", alias)?;
        removed |= remove_config_speed_alias(root, "openai-compatibility", "openai", alias)?;
    }
    if !removed {
        return Err(format!("Alias model {alias} does not exist; refresh and try again"));
    }
    let scope = AliasPayloadScope::after_removal(root, alias, oauth_channel);
    remove_alias_payload_options(root, alias, &scope)?;
    render_updated_core_yaml(&mut document, updated)
}

pub(crate) fn remove_oauth_model_alias(
    root: &mut serde_norway::Mapping,
    alias: &str,
    target_channel: Option<&str>,
) -> Result<bool, String> {
    let Some(oauth_aliases) = yaml_mapping_value_mut(root, "oauth-model-alias") else {
        return Ok(false);
    };
    let oauth_aliases = oauth_aliases
        .as_mapping_mut()
        .ok_or_else(|| "oauth-model-alias must be a YAML mapping".to_string())?;
    let mut removed = false;
    let mut empty_channels = Vec::new();
    for (channel, entries) in oauth_aliases.iter_mut() {
        let channel_name = channel.as_str().unwrap_or("unknown");
        if target_channel.is_some_and(|target| !target.eq_ignore_ascii_case(channel_name)) {
            continue;
        }
        let entries = entries
            .as_sequence_mut()
            .ok_or_else(|| format!("oauth-model-alias.{channel_name} must be an array"))?;
        entries.retain(|entry| {
            let matches = entry
                .as_mapping()
                .and_then(|mapping| yaml_mapping_value(mapping, "alias"))
                .and_then(serde_norway::Value::as_str)
                .is_some_and(|value| value.trim().eq_ignore_ascii_case(alias));
            removed |= matches;
            !matches
        });
        if entries.is_empty() {
            empty_channels.push(channel.clone());
        }
    }
    for channel in empty_channels {
        oauth_aliases.remove(&channel);
    }
    let remove_section = oauth_aliases.is_empty();
    if remove_section {
        root.remove(yaml_key("oauth-model-alias"));
    }
    Ok(removed)
}

pub(crate) fn configured_model_alias_exists(root: &serde_norway::Mapping, alias: &str) -> bool {
    let oauth_exists = yaml_mapping_value(root, "oauth-model-alias")
        .and_then(serde_norway::Value::as_mapping)
        .is_some_and(|channels| {
            channels.values().any(|entries| {
                entries.as_sequence().is_some_and(|entries| {
                    entries.iter().any(|entry| {
                        entry
                            .as_mapping()
                            .and_then(|mapping| yaml_mapping_value(mapping, "alias"))
                            .and_then(serde_norway::Value::as_str)
                            .is_some_and(|value| value.trim().eq_ignore_ascii_case(alias))
                    })
                })
            })
        });
    oauth_exists
        || MODEL_ALIAS_CONFIG_SECTIONS
            .into_iter()
            .filter_map(|section| yaml_mapping_value(root, section))
            .filter_map(serde_norway::Value::as_sequence)
            .flatten()
            .filter_map(serde_norway::Value::as_mapping)
            .filter_map(|provider| yaml_mapping_value(provider, "models"))
            .filter_map(serde_norway::Value::as_sequence)
            .flatten()
            .filter_map(|model| configured_model_identity(model).map(|(_, alias, _)| alias))
            .any(|value| value.eq_ignore_ascii_case(alias))
}

/// Removes alias entries from an API provider section. Only entries whose alias
/// differs from their name are aliases; a real model with the same name stays.
pub(crate) fn remove_config_model_alias(
    root: &mut serde_norway::Mapping,
    section: &str,
    alias: &str,
) -> Result<bool, String> {
    let Some(providers) = yaml_mapping_value_mut(root, section) else {
        return Ok(false);
    };
    let providers = providers
        .as_sequence_mut()
        .ok_or_else(|| format!("{section} must be an array"))?;
    let mut removed = false;
    for provider in providers {
        let Some(provider) = provider.as_mapping_mut() else {
            continue;
        };
        let Some(models) = yaml_mapping_value_mut(provider, "models") else {
            continue;
        };
        let models = models
            .as_sequence_mut()
            .ok_or_else(|| format!("{section}.models must be an array"))?;
        models.retain(|model| {
            let matches = configured_model_identity(model)
                .map(|(source, model_alias, _)| {
                    source != model_alias && model_alias.eq_ignore_ascii_case(alias)
                })
                .unwrap_or(false);
            removed |= matches;
            !matches
        });
    }
    Ok(removed)
}

pub(crate) fn remove_config_speed_alias(
    root: &mut serde_norway::Mapping,
    section: &str,
    protocol: &str,
    alias: &str,
) -> Result<bool, String> {
    if find_speed_alias_service_tier(root, alias, protocol).is_none() {
        return Ok(false);
    }
    let Some(providers) = yaml_mapping_value_mut(root, section) else {
        return Ok(false);
    };
    let providers = providers
        .as_sequence_mut()
        .ok_or_else(|| format!("{section} must be an array"))?;
    let mut removed = false;
    for provider in providers {
        let Some(provider) = provider.as_mapping_mut() else {
            continue;
        };
        let Some(models) = yaml_mapping_value_mut(provider, "models") else {
            continue;
        };
        let models = models
            .as_sequence_mut()
            .ok_or_else(|| format!("{section}.models must be an array"))?;
        models.retain(|model| {
            let matches = configured_model_identity(model)
                .map(|(source, model_alias, _)| {
                    source != model_alias && model_alias.eq_ignore_ascii_case(alias)
                })
                .unwrap_or(false);
            removed |= matches;
            !matches
        });
    }
    Ok(removed)
}

/// Payload params an alias owns besides `service_tier`: every key the effort
/// options write for any source protocol. Cleanup strips only these.
pub(crate) const ALIAS_EFFORT_KEYS: &[&str] = &[
    "reasoning.effort",
    "reasoning_effort",
    "output_config.effort",
    "generationConfig.thinkingConfig.thinkingLevel",
    "thinking.effort",
    "thinking.type",
];

/// Which payload model entries a cleanup may touch. `protocol` limits it to one
/// protocol (None means any). `preserved_protocols` lists protocols where the
/// alias name is still in use after a delete (another OAuth channel, an API
/// mapping or a real model), so their rules stay.
struct AliasPayloadScope {
    protocol: Option<String>,
    preserved_protocols: BTreeSet<String>,
}

impl AliasPayloadScope {
    fn for_protocol(protocol: &str) -> Self {
        Self {
            protocol: Some(protocol.to_string()),
            preserved_protocols: BTreeSet::new(),
        }
    }

    fn after_removal(root: &serde_norway::Mapping, alias: &str, channel: Option<&str>) -> Self {
        let mut preserved_protocols = BTreeSet::new();
        if let Some(channels) =
            yaml_mapping_value(root, "oauth-model-alias").and_then(serde_norway::Value::as_mapping)
        {
            for (channel, entries) in channels {
                let matches = entries.as_sequence().is_some_and(|entries| {
                    entries.iter().any(|entry| {
                        entry
                            .as_mapping()
                            .and_then(|entry| yaml_mapping_value(entry, "alias"))
                            .and_then(serde_norway::Value::as_str)
                            .is_some_and(|name| name.trim().eq_ignore_ascii_case(alias))
                    })
                });
                if matches {
                    preserved_protocols.insert(
                        oauth_alias_channel_details(channel.as_str().unwrap_or_default()).2,
                    );
                }
            }
        }
        for (section, protocol) in [
            ("codex-api-key", "codex"),
            ("openai-compatibility", "openai"),
            ("claude-api-key", "claude"),
            ("gemini-api-key", "gemini"),
        ] {
            let matches = yaml_mapping_value(root, section)
                .and_then(serde_norway::Value::as_sequence)
                .into_iter()
                .flatten()
                .filter_map(serde_norway::Value::as_mapping)
                .filter_map(|provider| yaml_mapping_value(provider, "models"))
                .filter_map(serde_norway::Value::as_sequence)
                .flatten()
                .filter_map(configured_model_identity)
                .any(|(_, name, _)| name.eq_ignore_ascii_case(alias));
            if matches {
                preserved_protocols.insert(protocol.to_string());
            }
        }
        Self {
            protocol: channel.map(|channel| oauth_alias_channel_details(channel).2),
            preserved_protocols,
        }
    }

    fn matches(&self, model: &serde_norway::Value, alias: &str) -> bool {
        if !thinking_payload_model_name_matches(model, alias) {
            return false;
        }
        let protocol = model
            .as_mapping()
            .and_then(|model| yaml_mapping_value(model, "protocol"))
            .and_then(serde_norway::Value::as_str)
            .map(str::trim)
            .filter(|protocol| !protocol.is_empty());
        match protocol {
            Some(protocol) => {
                self.protocol
                    .as_ref()
                    .is_none_or(|target| target.eq_ignore_ascii_case(protocol))
                    && !self
                        .preserved_protocols
                        .iter()
                        .any(|existing| existing.eq_ignore_ascii_case(protocol))
            }
            // A protocol-less entry applies everywhere, so it stays while any
            // mapping still uses the name.
            None => self.preserved_protocols.is_empty(),
        }
    }
}

/// Strips the alias's effort and `service_tier` params from `payload.override`
/// and `payload.override-raw`. Other models in a shared rule keep the original
/// rule, the alias keeps any unrelated params (with the rule's conditions), and
/// a rule is dropped only when nothing is left of it.
fn remove_alias_payload_options(
    root: &mut serde_norway::Mapping,
    alias: &str,
    scope: &AliasPayloadScope,
) -> Result<(), String> {
    let Some(payload) = yaml_mapping_value_mut(root, "payload") else {
        return Ok(());
    };
    let payload = payload
        .as_mapping_mut()
        .ok_or("payload must be a YAML mapping")?;
    for section in ["override", "override-raw"] {
        let Some(rules) = yaml_mapping_value_mut(payload, section) else {
            continue;
        };
        let rules = rules
            .as_sequence_mut()
            .ok_or_else(|| format!("payload.{section} must be an array"))?;
        let mut next = Vec::with_capacity(rules.len());
        for rule in rules.iter() {
            let Some(mapping) = rule.as_mapping() else {
                next.push(rule.clone());
                continue;
            };
            let Some(params) =
                yaml_mapping_value(mapping, "params").and_then(serde_norway::Value::as_mapping)
            else {
                next.push(rule.clone());
                continue;
            };
            let mut retained_params = params.clone();
            for key in ALIAS_EFFORT_KEYS.iter().copied().chain(["service_tier"]) {
                retained_params.remove(yaml_key(key));
            }
            if retained_params == *params {
                next.push(rule.clone());
                continue;
            }
            let Some(models) = yaml_mapping_value(mapping, "models") else {
                next.push(rule.clone());
                continue;
            };
            let models = models
                .as_sequence()
                .ok_or_else(|| format!("payload.{section}.models must be an array"))?;
            let (target, others): (Vec<_>, Vec<_>) = models
                .iter()
                .cloned()
                .partition(|model| scope.matches(model, alias));
            if target.is_empty() {
                next.push(rule.clone());
                continue;
            }
            if !others.is_empty() {
                let mut shared = mapping.clone();
                shared.insert(yaml_key("models"), serde_norway::Value::Sequence(others));
                next.push(serde_norway::Value::Mapping(shared));
            }
            if !retained_params.is_empty() {
                let mut retained = mapping.clone();
                retained.insert(yaml_key("models"), serde_norway::Value::Sequence(target));
                retained.insert(
                    yaml_key("params"),
                    serde_norway::Value::Mapping(retained_params),
                );
                next.push(serde_norway::Value::Mapping(retained));
            }
        }
        *rules = next;
        if rules.is_empty() {
            payload.remove(yaml_key(section));
        }
    }
    if payload.is_empty() {
        root.remove(yaml_key("payload"));
    }
    Ok(())
}

pub(crate) fn render_updated_core_yaml(
    document: &mut yaml_serde_edit::YamlValue,
    updated: serde_norway::Value,
) -> Result<String, String> {
    document.set(updated);
    let rendered = expand_top_level_flow_style_collections(&document.get_string(), document.get())?;
    let rendered = indent_indentationless_yaml_sequences(&rendered);
    ensure_rendered_core_yaml_matches(&rendered, document.get())?;
    Ok(rendered)
}

/// Parsing alone is not enough: the rendered text must read back as exactly the
/// value we meant to write, or a rendering slip could silently change the config.
pub(crate) fn ensure_rendered_core_yaml_matches(
    rendered: &str,
    expected: &serde_norway::Value,
) -> Result<(), String> {
    let validated = serde_norway::from_str::<serde_norway::Value>(rendered)
        .map_err(|error| format!("Failed to validate updated core configuration: {error}"))?;
    if &validated != expected {
        let path = first_yaml_mismatch_path(expected, &validated, &mut Vec::new())
            .unwrap_or_else(|| "<unknown>".to_string());
        return Err(format!(
            "Updated core configuration does not match expected values (path: {path}); write rejected"
        ));
    }
    Ok(())
}

pub(crate) fn expand_top_level_flow_style_collections(
    content: &str,
    document: &serde_norway::Value,
) -> Result<String, String> {
    let root = document
        .as_mapping()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    let mut rendered = content.to_string();
    for (key, value) in root {
        let Some(key) = key.as_str() else {
            continue;
        };
        let is_non_empty_collection = match value {
            serde_norway::Value::Mapping(mapping) => !mapping.is_empty(),
            serde_norway::Value::Sequence(sequence) => !sequence.is_empty(),
            _ => false,
        };
        if !is_non_empty_collection || !top_level_yaml_entry_uses_flow_style(&rendered, key) {
            continue;
        }
        let mut wrapper = serde_norway::Mapping::new();
        wrapper.insert(yaml_key(key), value.clone());
        let block = serde_norway::to_string(&serde_norway::Value::Mapping(wrapper))
            .map_err(|error| format!("Failed to format core YAML configuration: {error}"))?;
        rendered = replace_top_level_yaml_block(&rendered, key, &block);
    }
    Ok(rendered)
}

pub(crate) fn top_level_yaml_entry_uses_flow_style(content: &str, key: &str) -> bool {
    let prefix = format!("{key}:");
    yaml_line_ranges(content).into_iter().any(|range| {
        let line = yaml_line_content(content, range);
        if line.chars().next().is_some_and(char::is_whitespace) {
            return false;
        }
        line.strip_prefix(&prefix)
            .map(str::trim_start)
            .is_some_and(|value| value.starts_with('[') || value.starts_with('{'))
    })
}

pub(crate) fn indent_indentationless_yaml_sequences(content: &str) -> String {
    let mut lines = content
        .split_inclusive('\n')
        .map(str::to_string)
        .collect::<Vec<_>>();
    if !content.is_empty() && !content.ends_with('\n') && lines.is_empty() {
        lines.push(content.to_string());
    }

    loop {
        let block_scalar_content = yaml_block_scalar_content_lines(&lines);
        let mut range_to_indent = None;
        for key_index in 0..lines.len() {
            // Text inside a `|` or `>` block scalar can look like a key followed by a
            // list (`Steps:` then `- one`), but it is a string and must stay as written.
            if block_scalar_content[key_index] {
                continue;
            }
            let key_line = lines[key_index].trim_end_matches(['\r', '\n']);
            let key_trimmed = key_line.trim_start_matches(' ');
            if key_trimmed.is_empty()
                || key_trimmed.starts_with('#')
                || key_trimmed.starts_with('-')
                || !key_trimmed.ends_with(':')
            {
                continue;
            }
            let parent_indent = key_line.len() - key_trimmed.len();
            let Some(first_item) = ((key_index + 1)..lines.len()).find(|index| {
                let line = lines[*index].trim_end_matches(['\r', '\n']).trim();
                !line.is_empty() && !line.starts_with('#')
            }) else {
                continue;
            };
            let first_line = lines[first_item].trim_end_matches(['\r', '\n']);
            let first_trimmed = first_line.trim_start_matches(' ');
            let first_indent = first_line.len() - first_trimmed.len();
            if first_indent != parent_indent
                || !is_indentationless_yaml_sequence_item(first_trimmed)
            {
                continue;
            }

            let mut end = first_item;
            while end < lines.len() {
                let line = lines[end].trim_end_matches(['\r', '\n']);
                let trimmed = line.trim_start_matches(' ');
                if !trimmed.is_empty() {
                    let indent = line.len() - trimmed.len();
                    if indent < parent_indent
                        || (indent == parent_indent
                            && !is_indentationless_yaml_sequence_item(trimmed))
                    {
                        break;
                    }
                }
                end += 1;
            }
            range_to_indent = Some((first_item, end));
            break;
        }

        let Some((start, end)) = range_to_indent else {
            break;
        };
        for line in &mut lines[start..end] {
            if !line.trim().is_empty() {
                line.insert_str(0, "  ");
            }
        }
    }
    lines.concat()
}

/// Marks the lines that hold the content of a literal (`|`) or folded (`>`) block
/// scalar. A scalar runs until the first non-blank line that is not indented past
/// the key (or sequence dash) that opened it.
fn yaml_block_scalar_content_lines(lines: &[String]) -> Vec<bool> {
    let mut content = vec![false; lines.len()];
    let mut open_scalar_indent = None;
    for (index, line) in lines.iter().enumerate() {
        let line = line.trim_end_matches(['\r', '\n']);
        let trimmed = line.trim_start_matches(' ');
        let indent = line.len() - trimmed.len();
        if let Some(parent_indent) = open_scalar_indent {
            if trimmed.is_empty() || indent > parent_indent {
                content[index] = true;
                continue;
            }
        }
        open_scalar_indent = yaml_block_scalar_parent_indent(line);
    }
    content
}

/// The column of the key or sequence dash a line opens a block scalar for, if it
/// ends in a block scalar header such as `key: |`, `- key: >-` or `- |2`.
fn yaml_block_scalar_parent_indent(line: &str) -> Option<usize> {
    let trimmed = line.trim_start_matches(' ');
    let mut column = line.len() - trimmed.len();
    let mut rest = trimmed;
    while is_indentationless_yaml_sequence_item(rest) {
        let after_dash = &rest[1..];
        let value = after_dash.trim_start_matches([' ', '\t']);
        if is_yaml_block_scalar_header(value) {
            return Some(column);
        }
        column += after_dash.len() - value.len() + 1;
        rest = value;
    }
    let mut search_from = 0;
    while let Some(offset) = rest[search_from..].find(':') {
        let after_colon = &rest[search_from + offset + 1..];
        let value = after_colon.trim_start_matches([' ', '\t']);
        if value.len() < after_colon.len() && is_yaml_block_scalar_header(value) {
            return Some(column);
        }
        search_from += offset + 1;
    }
    None
}

/// `|` or `>`, optional chomping and indentation indicators, then nothing but an
/// optional comment.
fn is_yaml_block_scalar_header(value: &str) -> bool {
    let Some(indicators) = value.strip_prefix(['|', '>']) else {
        return false;
    };
    let tail = indicators.trim_start_matches(|character: char| {
        matches!(character, '-' | '+') || character.is_ascii_digit()
    });
    let comment = tail.trim_start_matches([' ', '\t']);
    comment.is_empty() || (comment.len() < tail.len() && comment.starts_with('#'))
}

pub(crate) fn truncate_for_error(value: &str) -> String {
    const LIMIT: usize = 240;
    let trimmed = value.trim();
    if trimmed.chars().count() <= LIMIT {
        return trimmed.to_string();
    }
    let shortened: String = trimmed.chars().take(LIMIT).collect();
    format!("{shortened}…")
}

pub(crate) fn open_external_url_inner(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("URL is empty".to_string());
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http/https URLs can be opened".to_string());
    }

    crate::system_open::open_with_system(app, url, None).map_err(|err| format!("Failed to open browser: {err}"))
}

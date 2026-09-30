use super::*;

pub(crate) fn merge_core_config_for_start(
    install_dir: &Path,
    gui_config: &GuiConfigFile,
) -> Result<PathBuf, String> {
    let _config_guard = lock_core_config_file();
    let config_path = install_dir.join(CORE_CONFIG_FILE);
    let example_config_path = install_dir.join(CORE_EXAMPLE_CONFIG_FILE);
    if !example_config_path.is_file() {
        return Err(format!(
            "Core configuration template not found: {}",
            path_to_string(&example_config_path)
        ));
    }

    let template = fs::read_to_string(&example_config_path).map_err(|err| {
        format!(
            "Failed to read core configuration template {}: {err}",
            path_to_string(&example_config_path)
        )
    })?;
    let current = if config_path.is_file() {
        Some(fs::read_to_string(&config_path).map_err(|err| {
            format!(
                "Failed to read existing core configuration {}: {err}",
                path_to_string(&config_path)
            )
        })?)
    } else {
        None
    };
    let merged = merge_core_config_yaml(&template, current.as_deref(), gui_config)?;
    write_yaml_if_changed(&config_path, &merged)?;

    Ok(config_path)
}

fn patch_installed_core_config_with(
    patch: impl FnOnce(&str) -> Result<Option<String>, String>,
) -> Result<(), String> {
    let _config_guard = lock_core_config_file();
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Ok(());
    }
    let content = fs::read_to_string(&config_path).map_err(|err| {
        format!(
            "Failed to read core configuration {}: {err}",
            path_to_string(&config_path)
        )
    })?;
    let Some(updated) = patch(&content)? else {
        return Ok(());
    };
    write_yaml_if_changed(&config_path, &updated).map(|_| ())
}

pub(crate) fn patch_core_network_endpoint_settings(config: &GuiConfigFile) -> Result<(), String> {
    patch_installed_core_config_with(|content| patch_core_network_endpoint_yaml(content, config))
}

pub(crate) fn patch_core_retry_settings(config: &GuiConfigFile) -> Result<(), String> {
    patch_installed_core_config_with(|content| patch_core_retry_yaml(content, config))
}

pub(crate) fn patch_core_session_routing_settings(config: &GuiConfigFile) -> Result<(), String> {
    patch_installed_core_config_with(|content| patch_core_session_routing_yaml(content, config))
}

pub(crate) fn lock_core_config_file() -> std::sync::MutexGuard<'static, ()> {
    // The lock guards no data, only the file, so a poisoned lock is safe to keep using; refusing would fail every
    // later save until Arbor restarts.
    CORE_CONFIG_FILE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) fn read_installed_core_config_settings() -> Result<CoreConfigSettings, String> {
    let _config_guard = lock_core_config_file();
    let (_, document) = read_core_config_document()?;
    core_config_settings_from_value(document.get())
}

pub(crate) fn current_core_config_settings(
    gui_config_state: &GuiConfigState,
) -> Result<CoreConfigSettings, String> {
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if config_path.is_file() {
        read_installed_core_config_settings()
    } else {
        let config = gui_config_state.snapshot()?;
        Ok(CoreConfigSettings::from(&config))
    }
}

pub(crate) fn current_core_tls_settings() -> Result<CoreTlsSettings, String> {
    let _config_guard = lock_core_config_file();
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Ok(CoreTlsSettings {
            enabled: false,
            cert: String::new(),
            key: String::new(),
        });
    }
    let content = fs::read_to_string(&config_path).map_err(|err| {
        format!(
            "Failed to read core configuration {}: {err}",
            path_to_string(&config_path)
        )
    })?;
    let document = serde_norway::from_str::<serde_norway::Value>(&content)
        .map_err(|err| format!("Failed to parse core configuration: {err}"))?;
    core_tls_settings_from_value(&document)
}

pub(crate) fn core_tls_settings_from_value(
    document: &serde_norway::Value,
) -> Result<CoreTlsSettings, String> {
    let root = document
        .as_mapping()
        .ok_or_else(|| "Core configuration must be a YAML mapping".to_string())?;
    // Core v8 keeps TLS under server.tls; a present v8 value wins over the legacy spelling.
    let tls = nested_yaml_value(root, &["server", "tls"])
        .or_else(|| yaml_mapping_value(root, "tls"))
        .and_then(serde_norway::Value::as_mapping);
    let enabled = tls
        .and_then(|mapping| yaml_mapping_value(mapping, "enable"))
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "tls.enable must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let string_value = |key: &str| -> Result<String, String> {
        tls.and_then(|mapping| yaml_mapping_value(mapping, key))
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("tls.{key} must be a string"))
            })
            .transpose()
            .map(Option::unwrap_or_default)
    };
    Ok(CoreTlsSettings {
        enabled,
        cert: string_value("cert")?,
        key: string_value("key")?,
    })
}

pub(crate) fn patch_core_tls_settings_yaml(
    content: &str,
    settings: &CoreTlsSettings,
) -> Result<Option<String>, String> {
    patch_core_yaml_document(content, |document| {
        let mut changed = false;
        for (key, value) in [
            ("enable", serde_norway::Value::Bool(settings.enabled)),
            ("cert", serde_norway::Value::String(settings.cert.clone())),
            ("key", serde_norway::Value::String(settings.key.clone())),
        ] {
            changed |= set_core_yaml_schema_value(document, &["tls", key], &["server", "tls", key], value)?;
        }
        Ok(changed)
    })
}

pub(crate) fn patch_core_tls_settings(settings: &CoreTlsSettings) -> Result<(), String> {
    let _config_guard = lock_core_config_file();
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Err("Core configuration has not been generated yet".to_string());
    }
    let content = fs::read_to_string(&config_path).map_err(|err| {
        format!(
            "Failed to read core configuration {}: {err}",
            path_to_string(&config_path)
        )
    })?;
    let Some(updated) = patch_core_tls_settings_yaml(&content, settings)? else {
        return Ok(());
    };
    write_yaml_if_changed(&config_path, &updated).map(|_| ())
}

pub(crate) fn patch_core_api_keys(api_keys: &[String]) -> Result<(), String> {
    let _config_guard = lock_core_config_file();
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Ok(());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("Failed to read core configuration {}: {err}", path_to_string(&config_path)))?;
    let updated = patch_core_api_keys_yaml(&content, api_keys)?;
    write_yaml_if_changed(&config_path, &updated)?;
    Ok(())
}

pub(crate) fn patch_core_management_secret_key(secret_key: &str) -> Result<(), String> {
    let secret_key = secret_key.to_string();
    patch_existing_core_config(move |document| {
        set_core_yaml_schema_value(
            document,
            &["remote-management", "secret-key"],
            &["management", "secret-key"],
            serde_norway::Value::String(secret_key),
        )
    })
}

pub(crate) fn patch_core_auth_dir(auth_dir: &str) -> Result<(), String> {
    let auth_dir = auth_dir.to_string();
    patch_existing_core_config(move |document| set_core_yaml_auth_dir(document, &auth_dir))
}

pub(crate) fn set_core_yaml_auth_dir(
    document: &mut serde_norway::Value,
    auth_dir: &str,
) -> Result<bool, String> {
    set_core_yaml_schema_value(
        document,
        &["auth-dir"],
        &["oauth", "auth-dir"],
        serde_norway::Value::String(auth_dir.to_string()),
    )
}

pub(crate) fn patch_core_logging_settings(settings: &CoreConfigSettings) -> Result<(), String> {
    patch_existing_core_config(|document| apply_core_logging_settings(document, settings))
}

pub(crate) fn apply_core_logging_settings(
    document: &mut serde_norway::Value,
    settings: &CoreConfigSettings,
) -> Result<bool, String> {
    let mut changed = false;
    for (key, value) in [
        ("debug", serde_norway::Value::Bool(settings.debug)),
        (
            "commercial-mode",
            serde_norway::Value::Bool(settings.commercial_mode),
        ),
        (
            "logging-to-file",
            serde_norway::Value::Bool(settings.logging_to_file),
        ),
        (
            "logs-max-total-size-mb",
            serde_norway::to_value(settings.logs_max_total_size_mb)
                .map_err(|err| format!("Failed to serialize log size limit: {err}"))?,
        ),
        (
            "error-logs-max-files",
            serde_norway::to_value(settings.error_logs_max_files)
                .map_err(|err| format!("Failed to serialize error log retention count: {err}"))?,
        ),
        (
            "usage-statistics-enabled",
            serde_norway::Value::Bool(settings.usage_statistics_enabled),
        ),
        (
            "redis-usage-queue-retention-seconds",
            serde_norway::to_value(settings.redis_usage_queue_retention_seconds)
                .map_err(|err| format!("Failed to serialize Redis usage queue retention period: {err}"))?,
        ),
    ] {
        let v8_path: &[&str] = match key {
            "commercial-mode" => &["server", "commercial-mode"],
            "usage-statistics-enabled" | "redis-usage-queue-retention-seconds" => {
                &["observability", "usage", key]
            }
            _ => &["observability", "logs", key],
        };
        changed |= set_core_yaml_schema_value(document, &[key], v8_path, value)?;
    }
    Ok(changed)
}

pub(crate) fn patch_core_routing_strategy(strategy: &str) -> Result<(), String> {
    let strategy = strategy.to_string();
    patch_existing_core_config(move |document| {
        set_core_yaml_nested_value(
            document,
            "routing",
            "strategy",
            serde_norway::Value::String(strategy),
        )
    })
}

pub(crate) fn patch_existing_core_config<F>(update: F) -> Result<(), String>
where
    F: FnOnce(&mut serde_norway::Value) -> Result<bool, String>,
{
    let _config_guard = lock_core_config_file();
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Ok(());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("Failed to read core configuration {}: {err}", path_to_string(&config_path)))?;
    let Some(updated) = patch_core_yaml_document(&content, update)? else {
        return Ok(());
    };

    write_yaml_if_changed(&config_path, &updated)?;

    Ok(())
}

pub(crate) fn patch_core_yaml_document<F>(
    content: &str,
    update: F,
) -> Result<Option<String>, String>
where
    F: FnOnce(&mut serde_norway::Value) -> Result<bool, String>,
{
    let original = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|err| format!("Failed to parse core configuration: {err}"))?;
    let mut updated = original.clone();
    if !update(&mut updated)? {
        return Ok(None);
    }
    render_yaml_value_changes(content, &original, &updated).map(Some)
}

pub(crate) struct YamlValueChange {
    path: Vec<String>,
    value: serde_norway::Value,
}

type MissingNestedYamlGroup = (Vec<String>, Vec<(String, serde_norway::Value)>);

pub(crate) fn render_yaml_value_changes(
    content: &str,
    original: &serde_norway::Value,
    updated: &serde_norway::Value,
) -> Result<String, String> {
    if original == updated {
        return Ok(content.to_string());
    }
    let mut editable_content = normalize_nested_yaml_comment_indentation(content);
    let mut changes = Vec::new();
    let mut removals = Vec::new();
    collect_yaml_value_changes(original, updated, &mut Vec::new(), &mut changes, &mut removals)?;
    // A removed block entry goes line by line where it can; yaml_edit, below, takes the rest.
    removals.retain(|path| match remove_yaml_block_entry_at_path(&editable_content, path) {
        Some(removed) => {
            editable_content = removed;
            false
        }
        None => true,
    });
    let mut remaining_changes = Vec::new();
    for change in changes {
        let sequence_length_changed = matches!(
            (yaml_value_at_path(original, &change.path), &change.value),
            (
                Some(serde_norway::Value::Sequence(original_values)),
                serde_norway::Value::Sequence(updated_values)
            ) if original_values.len() != updated_values.len()
        );
        if sequence_length_changed {
            editable_content =
                replace_yaml_sequence_value(&editable_content, &change.path, &change.value)?;
        } else {
            remaining_changes.push(change);
        }
    }
    let mut missing_nested_groups: Vec<MissingNestedYamlGroup> = Vec::new();
    let mut yaml_edit_changes = Vec::new();
    for change in remaining_changes {
        // A new top-level section is written as a block at the end of the file; yaml_edit would write it inline.
        let new_top_level_block = change.path.len() == 1
            && matches!(&change.value, serde_norway::Value::Mapping(values) if !values.is_empty());
        if (change.path.len() < 2 && !new_top_level_block)
            || yaml_value_at_path(original, &change.path).is_some()
            || yaml_value_at_path(original, &change.path[..change.path.len() - 1])
                .and_then(serde_norway::Value::as_mapping)
                .is_none()
        {
            yaml_edit_changes.push(change);
            continue;
        }
        let parent_path = change.path[..change.path.len() - 1].to_vec();
        let entry = (
            change.path.last().cloned().unwrap_or_default(),
            change.value,
        );
        if let Some((_, entries)) = missing_nested_groups
            .iter_mut()
            .find(|(existing, _)| existing == &parent_path)
        {
            entries.push(entry);
        } else {
            missing_nested_groups.push((parent_path, vec![entry]));
        }
    }
    for (parent_path, entries) in missing_nested_groups {
        if let Some(updated_content) =
            insert_yaml_block_mapping_values_at_path(&editable_content, &parent_path, &entries)?
        {
            editable_content = updated_content;
        } else {
            for (key, value) in entries {
                let mut path = parent_path.clone();
                path.push(key);
                yaml_edit_changes.push(YamlValueChange { path, value });
            }
        }
    }
    remaining_changes = yaml_edit_changes;
    let file = editable_content
        .parse::<yaml_edit::YamlFile>()
        .map_err(|err| format!("Failed to parse editable core configuration: {err}"))?;
    let document = file
        .document()
        .ok_or_else(|| "Core configuration has no YAML document".to_string())?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    for change in remaining_changes {
        set_yaml_edit_mapping_path(&root, &change.path, &change.value)?;
    }
    // The removals the lines couldn't take go last, so no edit above looks for a key that's already gone. The check
    // below catches a removal that took anything else with it.
    for path in removals {
        remove_yaml_edit_mapping_path(&root, &path)?;
    }
    let rendered = file.to_string();
    let validated = serde_norway::from_str::<serde_norway::Value>(&rendered)
        .map_err(|err| format!("Failed to validate updated core configuration: {err}"))?;
    if validated != *updated {
        let path = first_yaml_mismatch_path(updated, &validated, &mut Vec::new())
            .unwrap_or_else(|| "<unknown>".to_string());
        return Err(format!(
            "Updated core configuration does not match expected values (path: {path}); write rejected"
        ));
    }
    Ok(rendered)
}

pub(crate) fn first_yaml_mismatch_path(
    expected: &serde_norway::Value,
    actual: &serde_norway::Value,
    path: &mut Vec<String>,
) -> Option<String> {
    if expected == actual {
        return None;
    }
    match (expected, actual) {
        (
            serde_norway::Value::Mapping(expected_mapping),
            serde_norway::Value::Mapping(actual_mapping),
        ) => {
            for (key, expected_value) in expected_mapping {
                let key_name = key
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| "<non-string-key>".to_string());
                path.push(key_name);
                let mismatch = actual_mapping
                    .get(key)
                    .and_then(|actual_value| {
                        first_yaml_mismatch_path(expected_value, actual_value, path)
                    })
                    .or_else(|| (!actual_mapping.contains_key(key)).then(|| path.join(".")));
                path.pop();
                if mismatch.is_some() {
                    return mismatch;
                }
            }
            for key in actual_mapping.keys() {
                if !expected_mapping.contains_key(key) {
                    let key = key.as_str().unwrap_or("<non-string-key>");
                    return Some(if path.is_empty() {
                        key.to_string()
                    } else {
                        format!("{}.{}", path.join("."), key)
                    });
                }
            }
            Some(path.join("."))
        }
        (
            serde_norway::Value::Sequence(expected_values),
            serde_norway::Value::Sequence(actual_values),
        ) => {
            for (index, (expected_value, actual_value)) in
                expected_values.iter().zip(actual_values).enumerate()
            {
                path.push(format!("[{index}]"));
                let mismatch = first_yaml_mismatch_path(expected_value, actual_value, path);
                path.pop();
                if mismatch.is_some() {
                    return mismatch;
                }
            }
            Some(format!("{}[length]", path.join(".")))
        }
        _ => Some(path.join(".")),
    }
}

pub(crate) fn normalize_nested_yaml_comment_indentation(content: &str) -> String {
    let lines = content.split_inclusive('\n').collect::<Vec<_>>();
    let mut normalized = String::with_capacity(content.len());
    for (index, line) in lines.iter().enumerate() {
        let body = line.trim_end_matches(['\r', '\n']);
        let ending = &line[body.len()..];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let current_indent = body.len().saturating_sub(trimmed.len());
        if !trimmed.starts_with('#') {
            normalized.push_str(line);
            continue;
        }
        let next = lines.iter().skip(index + 1).find_map(|candidate| {
            let candidate = candidate.trim_end_matches(['\r', '\n']);
            let trimmed = candidate.trim_start_matches([' ', '\t']);
            if trimmed.is_empty() || trimmed.starts_with('#') {
                None
            } else {
                Some((candidate.len().saturating_sub(trimmed.len()), trimmed))
            }
        });
        let Some((next_indent, _)) = next else {
            normalized.push_str(line);
            continue;
        };
        let belongs_to_nested_mapping = current_indent < next_indent
            && lines[..index].iter().rev().any(|candidate| {
                let candidate = candidate.trim_end_matches(['\r', '\n']);
                let trimmed = candidate.trim_start_matches([' ', '\t']);
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    return false;
                }
                let indent = candidate.len().saturating_sub(trimmed.len());
                indent < next_indent && trimmed.ends_with(':')
            });
        if belongs_to_nested_mapping {
            normalized.push_str(&" ".repeat(next_indent));
            normalized.push_str(trimmed);
            normalized.push_str(ending);
        } else {
            normalized.push_str(line);
        }
    }
    normalized
}

pub(crate) fn collect_yaml_value_changes(
    original: &serde_norway::Value,
    updated: &serde_norway::Value,
    path: &mut Vec<String>,
    changes: &mut Vec<YamlValueChange>,
    removals: &mut Vec<Vec<String>>,
) -> Result<(), String> {
    if original == updated {
        return Ok(());
    }
    match (original, updated) {
        (
            serde_norway::Value::Mapping(original_mapping),
            serde_norway::Value::Mapping(updated_mapping),
        ) => {
            for key in original_mapping.keys() {
                if !updated_mapping.contains_key(key) {
                    let key = key
                        .as_str()
                        .ok_or_else(|| "Core configuration mapping keys must be strings".to_string())?;
                    let mut removed = path.clone();
                    removed.push(key.to_string());
                    removals.push(removed);
                }
            }
            for (key, updated_value) in updated_mapping {
                let key = key
                    .as_str()
                    .ok_or_else(|| "Core configuration mapping keys must be strings".to_string())?;
                path.push(key.to_string());
                if let Some(original_value) = original_mapping.get(yaml_key(key)) {
                    collect_yaml_value_changes(original_value, updated_value, path, changes, removals)?;
                } else {
                    changes.push(YamlValueChange {
                        path: path.clone(),
                        value: updated_value.clone(),
                    });
                }
                path.pop();
            }
            Ok(())
        }
        _ if path.is_empty() => Err("Core configuration top level must remain a YAML mapping".to_string()),
        _ => {
            changes.push(YamlValueChange {
                path: path.clone(),
                value: updated.clone(),
            });
            Ok(())
        }
    }
}

pub(crate) fn yaml_value_at_path<'a>(
    root: &'a serde_norway::Value,
    path: &[String],
) -> Option<&'a serde_norway::Value> {
    path.iter().try_fold(root, |current, key| {
        current.as_mapping()?.get(yaml_key(key))
    })
}

pub(crate) fn insert_yaml_block_mapping_values_at_path(
    content: &str,
    parent_path: &[String],
    entries: &[(String, serde_norway::Value)],
) -> Result<Option<String>, String> {
    let newline = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    if parent_path.is_empty() {
        let mut updated = content.to_string();
        if !updated.is_empty() && !updated.ends_with('\n') {
            updated.push_str(newline);
        }
        for (key, value) in entries {
            render_yaml_block_entry(key, value, 0, newline, &mut updated)?;
        }
        return Ok(Some(updated));
    }
    let mut offset = 0;
    let mut parent_end = None;
    let mut parent_indent = 0;
    let mut child_indent = None;
    let mut mapping_stack: Vec<(usize, String)> = Vec::new();
    for line in content.split_inclusive('\n') {
        let body = line.trim_end_matches(['\r', '\n']);
        let trimmed = body.trim_start_matches([' ', '\t']);
        let indent = body.len().saturating_sub(trimmed.len());
        if parent_end.is_none() {
            if let Some(key) = yaml_block_mapping_key(trimmed) {
                while mapping_stack
                    .last()
                    .is_some_and(|(ancestor_indent, _)| *ancestor_indent >= indent)
                {
                    mapping_stack.pop();
                }
                mapping_stack.push((indent, key));
                if mapping_stack.len() == parent_path.len()
                    && mapping_stack
                        .iter()
                        .zip(parent_path)
                        .all(|((_, actual), expected)| actual == expected)
                {
                    parent_end = Some(offset + line.len());
                    parent_indent = indent;
                }
            }
        } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
            if indent <= parent_indent {
                break;
            }
            child_indent.get_or_insert(indent);
        }
        offset += line.len();
    }
    let Some(parent_end) = parent_end else {
        return Ok(None);
    };
    let indent = child_indent.unwrap_or(parent_indent + 2);
    let mut insertion = String::new();
    for (key, value) in entries {
        render_yaml_block_entry(key, value, indent, newline, &mut insertion)?;
    }
    let mut updated = String::with_capacity(content.len() + insertion.len());
    updated.push_str(&content[..parent_end]);
    updated.push_str(&insertion);
    updated.push_str(&content[parent_end..]);
    Ok(Some(updated))
}

/// Takes the key at `path` out, with its value, when both are written as a block: the key on a line of its own and the
/// value on the lines under it. Comments and blank lines after the value stay, as they may be about what follows.
/// Returns nothing for a key written any other way, which is yaml_edit's to take out.
pub(crate) fn remove_yaml_block_mapping_entry(content: &str, path: &[&str]) -> Option<String> {
    let mut offset = 0;
    let mut mapping_stack: Vec<(usize, String)> = Vec::new();
    let mut entry: Option<(usize, usize, usize)> = None;
    for line in content.split_inclusive('\n') {
        let body = line.trim_end_matches(['\r', '\n']);
        let trimmed = body.trim_start_matches([' ', '\t']);
        let indent = body.len().saturating_sub(trimmed.len());
        match entry.as_mut() {
            None => {
                if let Some(key) = yaml_block_mapping_key(trimmed) {
                    while mapping_stack.last().is_some_and(|(ancestor_indent, _)| *ancestor_indent >= indent) {
                        mapping_stack.pop();
                    }
                    mapping_stack.push((indent, key));
                    if mapping_stack.len() == path.len()
                        && mapping_stack.iter().zip(path).all(|((_, actual), expected)| actual == expected)
                    {
                        entry = Some((offset, indent, offset + line.len()));
                    }
                }
            }
            Some((_, key_indent, end)) => {
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    // Belongs to the value only if more of it follows.
                } else if indent > *key_indent || (indent == *key_indent && trimmed.starts_with('-')) {
                    *end = offset + line.len();
                } else {
                    break;
                }
            }
        }
        offset += line.len();
    }
    let (start, _, end) = entry?;
    Some(format!("{}{}", &content[..start], &content[end..]))
}

/// Takes a block entry out of `content` by its lines: the key's line and every line under it, down to its last line of
/// content. Comments and blank lines after that stay where they are, as they head whatever follows; yaml_edit's own
/// removal leaves the entry's indentation in front of them, pushing the next comment in by a level. `None` when the
/// entry isn't one this finds, such as a key inside a flow mapping.
fn remove_yaml_block_entry_at_path(content: &str, path: &[String]) -> Option<String> {
    let lines = content.split_inclusive('\n').collect::<Vec<_>>();
    let content_line = |line: &str| {
        let body = line.trim_end_matches(['\r', '\n']);
        let trimmed = body.trim_start_matches(' ');
        (!trimmed.is_empty() && !trimmed.starts_with('#')).then(|| (body.len() - trimmed.len(), trimmed.to_string()))
    };
    let list_item = |trimmed: &str| trimmed == "-" || trimmed.starts_with("- ");
    // Each open mapping key above the current line, by indent. A list item's keys are on no mapping path, so an item
    // stands in the stack as None.
    let mut ancestors: Vec<(usize, Option<String>)> = Vec::new();
    let mut target = None;
    for (index, line) in lines.iter().enumerate() {
        let Some((indent, trimmed)) = content_line(line) else {
            continue;
        };
        while ancestors.last().is_some_and(|(ancestor, _)| *ancestor >= indent) {
            ancestors.pop();
        }
        if list_item(&trimmed) {
            ancestors.push((indent, None));
            continue;
        }
        let Some(key) = yaml_line_key(&trimmed) else {
            continue;
        };
        let on_path = ancestors.len() + 1 == path.len()
            && ancestors.iter().zip(path).all(|((_, ancestor), wanted)| ancestor.as_deref() == Some(wanted.as_str()))
            && path.last() == Some(&key);
        if on_path {
            target = Some((index, indent, yaml_block_mapping_key(&trimmed).is_some()));
            break;
        }
        ancestors.push((indent, Some(key)));
    }
    let (start, indent, header) = target?;
    let mut end = start;
    for (index, line) in lines.iter().enumerate().skip(start + 1) {
        let Some((line_indent, trimmed)) = content_line(line) else {
            continue;
        };
        // A header's list may sit at the header's own indent.
        let own_list_item = header && line_indent == indent && list_item(&trimmed);
        if line_indent <= indent && !own_list_item {
            break;
        }
        end = index;
    }
    Some(
        lines
            .iter()
            .enumerate()
            .filter(|(index, _)| !(start..=end).contains(index))
            .map(|(_, line)| *line)
            .collect(),
    )
}

/// The key a block mapping line starts with, as in `key:` or `key: value`.
fn yaml_line_key(line: &str) -> Option<String> {
    if let Some(key) = yaml_block_mapping_key(line) {
        return Some(key);
    }
    let (key, _) = line.split_once(": ")?;
    let key = key.trim_end();
    if key.is_empty() || key.starts_with(['{', '[', '&', '*', '!', '?']) {
        return None;
    }
    if key.starts_with('"') && key.ends_with('"') && key.len() >= 2 {
        return serde_json::from_str(key).ok();
    }
    if key.starts_with('\'') && key.ends_with('\'') && key.len() >= 2 {
        return Some(key[1..key.len() - 1].replace("''", "'"));
    }
    (!key.contains(['"', '\''])).then(|| key.to_string())
}

/// Writes a new key the way the rest of the file is written: a section as an indented block, a list of plain values or
/// of sections as a block list. Anything else is written inline, which is YAML too.
fn render_yaml_block_entry(
    key: &str,
    value: &serde_norway::Value,
    indent: usize,
    newline: &str,
    out: &mut String,
) -> Result<(), String> {
    let inline = |value: &serde_norway::Value| {
        serde_json::to_string(value).map_err(|error| format!("Failed to serialize core configuration value: {error}"))
    };
    let pad = " ".repeat(indent);
    out.push_str(&pad);
    out.push_str(&render_yaml_mapping_key(key));
    out.push(':');
    match value {
        serde_norway::Value::Mapping(values) if !values.is_empty() => {
            out.push_str(newline);
            for (child_key, child_value) in values {
                let child_key = child_key
                    .as_str()
                    .ok_or_else(|| "Core configuration mapping keys must be strings".to_string())?;
                render_yaml_block_entry(child_key, child_value, indent + 2, newline, out)?;
            }
        }
        serde_norway::Value::Sequence(values)
            if !values.is_empty()
                && values.iter().all(|value| {
                    matches!(
                        value,
                        serde_norway::Value::Bool(_) | serde_norway::Value::Number(_) | serde_norway::Value::String(_)
                    )
                }) =>
        {
            out.push_str(newline);
            for value in values {
                out.push_str(&pad);
                out.push_str("  - ");
                out.push_str(&inline(value)?);
                out.push_str(newline);
            }
        }
        serde_norway::Value::Sequence(values)
            if !values.is_empty()
                && values
                    .iter()
                    .all(|value| matches!(value, serde_norway::Value::Mapping(entries) if !entries.is_empty())) =>
        {
            out.push_str(newline);
            // Each item's keys line up after its "- ", the first on the dash's own line.
            let item_indent = indent + 4;
            for entries in values.iter().filter_map(serde_norway::Value::as_mapping) {
                for (index, (child_key, child_value)) in entries.iter().enumerate() {
                    let child_key = child_key
                        .as_str()
                        .ok_or_else(|| "Core configuration mapping keys must be strings".to_string())?;
                    let mut entry = String::new();
                    render_yaml_block_entry(child_key, child_value, item_indent, newline, &mut entry)?;
                    if index == 0 {
                        out.push_str(&pad);
                        out.push_str("  - ");
                        out.push_str(&entry[item_indent..]);
                    } else {
                        out.push_str(&entry);
                    }
                }
            }
        }
        _ => {
            out.push(' ');
            out.push_str(&inline(value)?);
            out.push_str(newline);
        }
    }
    Ok(())
}

pub(crate) fn yaml_block_mapping_key(line: &str) -> Option<String> {
    let header = line
        .split_once('#')
        .map(|(value, _)| value)
        .unwrap_or(line)
        .trim_end();
    let key = header.strip_suffix(':')?.trim_end();
    if key.is_empty() {
        return None;
    }
    if key.starts_with('"') && key.ends_with('"') {
        return serde_json::from_str(key).ok();
    }
    if key.starts_with('\'') && key.ends_with('\'') {
        return Some(key[1..key.len() - 1].replace("''", "'"));
    }
    Some(key.to_string())
}

pub(crate) fn render_yaml_mapping_key(key: &str) -> String {
    if !key.is_empty()
        && key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        key.to_string()
    } else {
        serde_json::to_string(key).unwrap_or_else(|_| key.to_string())
    }
}

pub(crate) fn replace_yaml_sequence_value(
    content: &str,
    path: &[String],
    value: &serde_norway::Value,
) -> Result<String, String> {
    let file = content
        .parse::<yaml_edit::YamlFile>()
        .map_err(|err| format!("Failed to parse editable core configuration: {err}"))?;
    let document = file
        .document()
        .ok_or_else(|| "Core configuration has no YAML document".to_string())?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    let node = yaml_edit_node_at_path(&root, path)
        .ok_or_else(|| format!("Core configuration sequence {} not found", path.join(".")))?;
    let sequence = node
        .as_sequence()
        .ok_or_else(|| format!("Core configuration field {} must be a YAML sequence", path.join(".")))?;
    let range = sequence.byte_range();
    let start = range.start as usize;
    let end = range.end as usize;
    let line_start = content[..start]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let prefix = &content[line_start..start];
    let original = &content[start..end];
    let trimmed_end = original.trim_end_matches(char::is_whitespace).len();
    let trailing = &original[trimmed_end..];

    let serialized = if prefix.trim().is_empty() {
        let serialized = serde_norway::to_string(value)
            .map_err(|err| format!("Failed to serialize core configuration sequence: {err}"))?;
        let serialized = serialized.trim_end_matches(['\r', '\n']);
        let mut indented = String::with_capacity(serialized.len() + prefix.len() * 2);
        for (index, line) in serialized.split('\n').enumerate() {
            if index > 0 {
                indented.push('\n');
                indented.push_str(prefix);
            }
            indented.push_str(line);
        }
        indented
    } else {
        serde_json::to_string(value).map_err(|err| format!("Failed to serialize core configuration sequence: {err}"))?
    };

    Ok(format!(
        "{}{}{}{}",
        &content[..start],
        serialized,
        trailing,
        &content[end..]
    ))
}

pub(crate) fn yaml_edit_node_at_path(
    mapping: &yaml_edit::Mapping,
    path: &[String],
) -> Option<yaml_edit::YamlNode> {
    let (key, remaining) = path.split_first()?;
    let node = mapping.get(key.as_str())?;
    if remaining.is_empty() {
        return Some(node);
    }
    let child = node.as_mapping()?;
    yaml_edit_node_at_path(child, remaining)
}

pub(crate) fn set_yaml_edit_mapping_path(
    mapping: &yaml_edit::Mapping,
    path: &[String],
    value: &serde_norway::Value,
) -> Result<(), String> {
    let Some((key, remaining)) = path.split_first() else {
        return Err("Core configuration update path cannot be empty".to_string());
    };
    if remaining.is_empty() {
        return set_yaml_edit_mapping_value(mapping, key, value);
    }
    if let Some(child) = mapping.get(key.as_str()) {
        let child = child
            .as_mapping()
            .ok_or_else(|| format!("Core configuration section {key} must be a YAML mapping"))?;
        return set_yaml_edit_mapping_path(child, remaining, value);
    }
    let nested_value = nested_yaml_value_for_path(remaining, value.clone());
    set_yaml_edit_mapping_value(mapping, key, &nested_value)
}

fn remove_yaml_edit_mapping_path(mapping: &yaml_edit::Mapping, path: &[String]) -> Result<(), String> {
    let missing = || format!("Core configuration has no {} to remove", path.join("."));
    match path {
        [] => Err("Core configuration update path cannot be empty".to_string()),
        [key] => mapping.remove(key.as_str()).map(|_| ()).ok_or_else(missing),
        [parent, rest @ ..] => {
            let child = mapping.get(parent.as_str()).ok_or_else(missing)?;
            let child = child
                .as_mapping()
                .ok_or_else(|| format!("Core configuration section {parent} must be a YAML mapping"))?;
            remove_yaml_edit_mapping_path(child, rest)
        }
    }
}

pub(crate) fn set_yaml_edit_mapping_value(
    mapping: &yaml_edit::Mapping,
    key: &str,
    value: &serde_norway::Value,
) -> Result<(), String> {
    match value {
        serde_norway::Value::String(value) => {
            mapping.set(key, value.as_str());
            return Ok(());
        }
        serde_norway::Value::Bool(value) => {
            mapping.set(key, *value);
            return Ok(());
        }
        serde_norway::Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                mapping.set(key, value);
                return Ok(());
            }
            if let Some(value) = value.as_u64() {
                mapping.set(key, value);
                return Ok(());
            }
            if let Some(value) = value.as_f64() {
                mapping.set(key, value);
                return Ok(());
            }
        }
        _ => {}
    }
    if let serde_norway::Value::Sequence(values) = value {
        if let Some(node) = mapping.get(key) {
            if let Some(sequence) = node.as_sequence() {
                if sequence.len() != values.len() {
                    return Err(format!("Length change in core configuration sequence {key} was not preprocessed"));
                }
                for (index, value) in values.iter().enumerate() {
                    let value = yaml_edit_node_from_value(value)?;
                    if !sequence.set(index, value) {
                        return Err(format!("Failed to update core configuration sequence {key}[{index}]"));
                    }
                }
                return Ok(());
            }
        }
    }
    match yaml_edit_node_from_value(value)? {
        yaml_edit::YamlNode::Scalar(node) => mapping.set(key, node),
        yaml_edit::YamlNode::Sequence(node) => mapping.set(key, node),
        yaml_edit::YamlNode::Mapping(node) => mapping.set(key, node),
        yaml_edit::YamlNode::Alias(node) => mapping.set(key, node),
        yaml_edit::YamlNode::TaggedNode(node) => mapping.set(key, node),
    }
    Ok(())
}

pub(crate) fn nested_yaml_value_for_path(
    path: &[String],
    value: serde_norway::Value,
) -> serde_norway::Value {
    path.iter().rev().fold(value, |nested, key| {
        let mut mapping = serde_norway::Mapping::new();
        mapping.insert(yaml_key(key), nested);
        serde_norway::Value::Mapping(mapping)
    })
}

pub(crate) fn yaml_edit_node_from_value(
    value: &serde_norway::Value,
) -> Result<yaml_edit::YamlNode, String> {
    const WRAPPER_KEY: &str = "__cpa_gui_value__";
    let value =
        serde_json::to_string(value).map_err(|err| format!("Failed to serialize core configuration value: {err}"))?;
    let serialized = format!("{WRAPPER_KEY}: {value}\n");
    let file = serialized
        .parse::<yaml_edit::YamlFile>()
        .map_err(|err| format!("Failed to parse core configuration value: {err}"))?;
    file.document()
        .and_then(|document| document.get(WRAPPER_KEY))
        .ok_or_else(|| "Cannot construct core configuration value".to_string())
}

#[cfg(test)]
pub(crate) fn set_core_yaml_top_level_value(
    document: &mut serde_norway::Value,
    key: &str,
    value: serde_norway::Value,
) -> Result<bool, String> {
    let root = document
        .as_mapping_mut()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    let key = yaml_key(key);
    if root.get(&key) == Some(&value) {
        return Ok(false);
    }
    root.insert(key, value);
    Ok(true)
}

pub(crate) fn set_core_yaml_nested_value(
    document: &mut serde_norway::Value,
    section: &str,
    key: &str,
    value: serde_norway::Value,
) -> Result<bool, String> {
    let root = document
        .as_mapping_mut()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    let section = root
        .entry(yaml_key(section))
        .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| "Core configuration section must be a YAML mapping".to_string())?;
    let key = yaml_key(key);
    if section.get(&key) == Some(&value) {
        return Ok(false);
    }
    section.insert(key, value);
    Ok(true)
}

/// Core v8 marks its nested layout with `config-version: 8`. Legacy files without the marker still load in v8,
/// so writers also look for the v8 path itself before falling back to the legacy spelling.
pub(crate) fn core_config_uses_v8(document: &serde_norway::Value) -> bool {
    document
        .as_mapping()
        .and_then(|root| yaml_mapping_value(root, "config-version"))
        .and_then(serde_norway::Value::as_u64)
        .is_some_and(|version| version >= 8)
}

pub(crate) fn set_core_yaml_path_value(
    document: &mut serde_norway::Value,
    path: &[&str],
    value: serde_norway::Value,
) -> Result<bool, String> {
    let Some((key, parents)) = path.split_last() else {
        return Err("Core configuration path cannot be empty".to_string());
    };
    let mut mapping = document
        .as_mapping_mut()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    for section in parents {
        mapping = mapping
            .entry(yaml_key(section))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
            .as_mapping_mut()
            .ok_or_else(|| format!("Core configuration section {section} must be a YAML mapping"))?;
    }
    let key = yaml_key(key);
    if mapping.get(&key) == Some(&value) {
        return Ok(false);
    }
    mapping.insert(key, value);
    Ok(true)
}

/// Writes a setting at its v8 path, which the core reads in any file ahead of the old spelling. An old spelling is
/// taken out in the same edit: left beside a v8 value, it's one the core deletes itself when it next loads the file,
/// rewriting all of it to do so.
pub(crate) fn set_core_yaml_schema_value(
    document: &mut serde_norway::Value,
    legacy_path: &[&str],
    v8_path: &[&str],
    value: serde_norway::Value,
) -> Result<bool, String> {
    let changed = set_core_yaml_path_value(document, v8_path, value)?;
    Ok(remove_core_yaml_path_value(document, legacy_path) || changed)
}

/// Takes the value at `path` out, and any mapping on the way that it leaves empty: an empty old-layout section beside
/// its v8 one is a conflict the core clears by rewriting the file. Says whether anything went.
pub(crate) fn remove_core_yaml_path_value(document: &mut serde_norway::Value, path: &[&str]) -> bool {
    fn remove(mapping: &mut serde_norway::Mapping, path: &[&str]) -> bool {
        match path {
            [] => false,
            [key] => mapping.remove(yaml_key(key)).is_some(),
            [parent, rest @ ..] => {
                let Some(child) = yaml_mapping_value_mut(mapping, parent).and_then(serde_norway::Value::as_mapping_mut)
                else {
                    return false;
                };
                let removed = remove(child, rest);
                if removed && child.is_empty() {
                    mapping.remove(yaml_key(parent));
                }
                removed
            }
        }
    }
    document.as_mapping_mut().is_some_and(|mapping| remove(mapping, path))
}

/// Writes the client keys at `access.api-keys`. The old top-level list goes in the same edit; in the v8 layout the
/// top-level `api-keys` holds upstream provider groups (a mapping), which are left alone.
pub(crate) fn patch_core_api_keys_yaml(
    content: &str,
    api_keys: &[String],
) -> Result<String, String> {
    let api_keys = serde_norway::Value::Sequence(
        api_keys.iter().cloned().map(serde_norway::Value::String).collect(),
    );
    patch_core_yaml_document(content, |document| {
        let mut changed = set_core_yaml_path_value(document, &["access", "api-keys"], api_keys)?;
        let root = document
            .as_mapping_mut()
            .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
        if yaml_mapping_value(root, "api-keys").is_some_and(serde_norway::Value::is_sequence) {
            changed |= root.remove(yaml_key("api-keys")).is_some();
        }
        // The oldest spelling of all, from before the old layout.
        for key in ["api-key-entries", "api-keys"] {
            changed |= remove_core_yaml_path_value(document, &["auth", "providers", "config-api-key", key]);
        }
        Ok(changed)
    })
    .map(|updated| updated.unwrap_or_else(|| content.to_string()))
}

pub(crate) fn replace_top_level_yaml_block(content: &str, key: &str, block: &str) -> String {
    let lines = yaml_line_ranges(content);
    let key_prefix = format!("{key}:");

    if let Some((line_index, (start, end))) =
        lines.iter().copied().enumerate().find(|(_, range)| {
            let line = yaml_line_content(content, *range);
            !line.chars().next().is_some_and(char::is_whitespace) && line.starts_with(&key_prefix)
        })
    {
        let line = yaml_line_content(content, (start, end));
        let value = line[key_prefix.len()..].trim();
        let mut replace_end = end;
        if value.is_empty() || value.starts_with('#') {
            for (next_start, next_end) in lines.iter().copied().skip(line_index + 1) {
                let next = yaml_line_content(content, (next_start, next_end));
                if next.chars().next().is_some_and(char::is_whitespace)
                    || is_indentationless_yaml_sequence_item(next)
                {
                    replace_end = next_end;
                } else {
                    break;
                }
            }
        }
        return replace_yaml_range(content, start, replace_end, block);
    }

    let insertion = lines
        .iter()
        .copied()
        .find(|range| yaml_line_content(content, *range).trim() == "# API keys for authentication")
        .map(|(_, end)| end)
        .or_else(|| {
            lines
                .iter()
                .copied()
                .find(|range| {
                    let line = yaml_line_content(content, *range);
                    !line.chars().next().is_some_and(char::is_whitespace)
                        && line.starts_with("auth-dir:")
                })
                .map(|(_, end)| end)
        })
        .unwrap_or(0);
    replace_yaml_range(content, insertion, insertion, block)
}

pub(crate) fn is_indentationless_yaml_sequence_item(line: &str) -> bool {
    let Some(rest) = line.strip_prefix('-') else {
        return false;
    };
    rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
}

pub(crate) fn yaml_line_ranges(content: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0;
    for (index, character) in content.char_indices() {
        if character == '\n' {
            ranges.push((start, index + 1));
            start = index + 1;
        }
    }
    if start < content.len() {
        ranges.push((start, content.len()));
    }
    ranges
}

pub(crate) fn yaml_line_content(content: &str, (start, end): (usize, usize)) -> &str {
    content[start..end].trim_end_matches(['\r', '\n'])
}

pub(crate) fn replace_yaml_range(content: &str, start: usize, end: usize, block: &str) -> String {
    let mut result = String::with_capacity(content.len() + block.len());
    result.push_str(&content[..start]);
    if !block.is_empty() {
        result.push_str(block);
        if !block.ends_with('\n') && (end < content.len() || content.ends_with('\n')) {
            result.push('\n');
        }
    }
    result.push_str(&content[end..]);
    result
}

#[cfg(test)]
pub(crate) fn set_yaml_edit_nested_value(
    document: &yaml_edit::Document,
    section: &str,
    key: &str,
    value: impl yaml_edit::AsYaml,
) -> bool {
    if let Some(node) = document.get(section) {
        if let Some(mapping) = node.as_mapping() {
            mapping.set(key, value);
            return true;
        }
    }
    false
}

pub(crate) fn read_core_config_document() -> Result<(PathBuf, yaml_serde_edit::YamlValue), String> {
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Err("The core's config.yaml hasn't been made yet. Start the core first.".to_string());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("Failed to read core configuration {}: {err}", path_to_string(&config_path)))?;
    let document = yaml_serde_edit::YamlValue::parse(&content)
        .map_err(|err| format!("Failed to parse core configuration: {err}"))?;
    Ok((config_path, document))
}

pub(crate) fn core_config_settings_from_value(
    document: &serde_norway::Value,
) -> Result<CoreConfigSettings, String> {
    let root = document
        .as_mapping()
        .ok_or_else(|| "Core configuration top level must be a YAML mapping".to_string())?;
    // v8 moved most settings into sections. A present v8 value wins, as it does in the core.
    let v8_or_legacy = |v8: &[&str], legacy: &[&str]| {
        nested_yaml_value(root, v8).or_else(|| nested_yaml_value(root, legacy))
    };
    let host = v8_or_legacy(&["server", "host"], &["host"])
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "host must be a string".to_string())
        })
        .transpose()?
        // The core listens on every interface without one, and the proxy checks should say so.
        .unwrap_or_default();
    let port = v8_or_legacy(&["server", "port"], &["port"])
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u16::try_from(value).ok())
                .filter(|value| *value != 0)
                .ok_or_else(|| "port must be an integer between 1 and 65535".to_string())
        })
        .transpose()?
        .unwrap_or(8317);
    let auth_dir = v8_or_legacy(&["oauth", "auth-dir"], &["auth-dir"])
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "auth-dir must be a string".to_string())
        })
        .transpose()?
        // Arbor's own folder: a bare "oauth" is the core's folder beside its binary, which holds no credentials.
        .unwrap_or_else(|| DEFAULT_AUTH_DIR.to_string());
    let debug = v8_or_legacy(&["observability", "logs", "debug"], &["debug"])
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "debug must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let commercial_mode = v8_or_legacy(&["server", "commercial-mode"], &["commercial-mode"])
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "commercial-mode must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let logging_to_file = v8_or_legacy(&["observability", "logs", "logging-to-file"], &["logging-to-file"])
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "logging-to-file must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let logs_max_total_size_mb = v8_or_legacy(
        &["observability", "logs", "logs-max-total-size-mb"],
        &["logs-max-total-size-mb"],
    )
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "logs-max-total-size-mb must be a non-negative integer".to_string())
        })
        .transpose()?
        .unwrap_or(DEFAULT_LOGS_MAX_TOTAL_SIZE_MB);
    let error_logs_max_files = v8_or_legacy(
        &["observability", "logs", "error-logs-max-files"],
        &["error-logs-max-files"],
    )
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "error-logs-max-files must be a non-negative integer".to_string())
        })
        .transpose()?
        .unwrap_or(DEFAULT_ERROR_LOGS_MAX_FILES);
    let usage_statistics_enabled = v8_or_legacy(
        &["observability", "usage", "usage-statistics-enabled"],
        &["usage-statistics-enabled"],
    )
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "usage-statistics-enabled must be a boolean".to_string())
        })
        .transpose()?
        // Left out, the core keeps usage statistics off (since 7.3.20), however much Arbor needs them on.
        .unwrap_or(false);
    let redis_usage_queue_retention_seconds =
        v8_or_legacy(
            &["observability", "usage", "redis-usage-queue-retention-seconds"],
            &["redis-usage-queue-retention-seconds"],
        )
            .map(|value| {
                value
                    .as_u64()
                    .and_then(|value| u32::try_from(value).ok())
                    .ok_or_else(|| "redis-usage-queue-retention-seconds must be a non-negative integer".to_string())
            })
            .transpose()?
            .unwrap_or(DEFAULT_REDIS_USAGE_QUEUE_RETENTION_SECONDS);
    let redis_usage_queue_retention_seconds = if redis_usage_queue_retention_seconds == 0 {
        DEFAULT_REDIS_USAGE_QUEUE_RETENTION_SECONDS
    } else {
        redis_usage_queue_retention_seconds.min(3600)
    };
    let request_log = v8_or_legacy(&["observability", "logs", "request-log"], &["request-log"])
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "request-log must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let api_keys = extract_core_api_keys(root)?
        .into_iter()
        .filter(|api_key| !is_example_core_api_key(api_key))
        .collect();
    let management_secret_key = extract_core_management_secret_key(root)?;
    let plugins_enabled = nested_yaml_value(root, &["plugins", "enabled"])
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "plugins.enabled must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let routing_strategy = nested_yaml_value(root, &["routing", "strategy"])
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "routing.strategy must be a string".to_string())
        })
        .transpose()?
        .unwrap_or_else(|| "round-robin".to_string());
    let proxy_url = v8_or_legacy(&["requests", "proxy-url"], &["proxy-url"])
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "proxy-url must be a string".to_string())
        })
        .transpose()?
        .unwrap_or_default();
    let routing_session_affinity = nested_yaml_value(root, &["routing", "session-affinity"])
        .or_else(|| nested_yaml_value(root, &["routing", "sessionAffinity"]))
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "routing.session-affinity must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let routing_session_affinity_ttl =
        nested_yaml_value(root, &["routing", "session-affinity-ttl"])
            .or_else(|| nested_yaml_value(root, &["routing", "sessionAffinityTTL"]))
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| "routing.session-affinity-ttl must be a string".to_string())
            })
            .transpose()?
            .unwrap_or_default();
    let disable_cooling = v8_or_legacy(&["routing", "cooldown", "disable-cooling"], &["disable-cooling"])
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "disable-cooling must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(DEFAULT_DISABLE_COOLING);
    let request_retry = v8_or_legacy(&["routing", "retry", "request-retry"], &["request-retry"])
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "request-retry must be a non-negative integer".to_string())
        })
        .transpose()?
        // A missing value is 0 to the core; the 3 in its example file, which Arbor starts new setups with, is only
        // what the example sets.
        .unwrap_or(0);
    let max_retry_credentials = v8_or_legacy(
        &["routing", "retry", "max-retry-credentials"],
        &["max-retry-credentials"],
    )
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "max-retry-credentials must be a non-negative integer".to_string())
        })
        .transpose()?
        .unwrap_or(DEFAULT_MAX_RETRY_CREDENTIALS);
    let max_retry_interval = v8_or_legacy(
        &["routing", "retry", "max-retry-interval"],
        &["max-retry-interval"],
    )
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "max-retry-interval must be a non-negative integer".to_string())
        })
        .transpose()?
        // Missing is 0 to the core too, not the example's 30.
        .unwrap_or(0);
    let streaming_bootstrap_retries = v8_or_legacy(
        &["requests", "streaming", "bootstrap-retries"],
        &["streaming", "bootstrap-retries"],
    )
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "streaming.bootstrap-retries must be a non-negative integer".to_string())
        })
        .transpose()?
        .unwrap_or(DEFAULT_STREAMING_BOOTSTRAP_RETRIES);

    Ok(CoreConfigSettings {
        host,
        port,
        auth_dir,
        api_keys,
        management_secret_configured: management_secret_key
            .as_deref()
            .is_some_and(|value| !value.is_empty()),
        debug,
        commercial_mode,
        logging_to_file,
        logs_max_total_size_mb,
        error_logs_max_files,
        usage_statistics_enabled,
        redis_usage_queue_retention_seconds,
        request_log,
        plugins_enabled,
        routing_strategy,
        proxy_url,
        routing_session_affinity,
        routing_session_affinity_ttl,
        disable_cooling,
        request_retry,
        max_retry_credentials,
        max_retry_interval,
        streaming_bootstrap_retries,
        management_secret_key,
    })
}

pub(crate) fn extract_core_api_keys(root: &serde_norway::Mapping) -> Result<Vec<String>, String> {
    if let Some(value) = nested_yaml_value(root, &["access", "api-keys"]) {
        return extract_api_key_sequence(value, "access.api-keys");
    }
    if let Some(value) = yaml_mapping_value(root, "api-keys") {
        // In v8 the top-level api-keys mapping holds upstream provider groups, not client keys.
        if value.is_mapping() {
            return Ok(Vec::new());
        }
        return extract_api_key_sequence(value, "api-keys");
    }

    let legacy = nested_yaml_value(root, &["auth", "providers", "config-api-key"])
        .and_then(serde_norway::Value::as_mapping);
    let Some(legacy) = legacy else {
        return Ok(Vec::new());
    };
    let value = yaml_mapping_value(legacy, "api-key-entries")
        .or_else(|| yaml_mapping_value(legacy, "api-keys"));
    value
        .map(|value| extract_api_key_sequence(value, "auth.providers.config-api-key"))
        .transpose()
        .map(Option::unwrap_or_default)
}

pub(crate) fn extract_api_key_sequence(
    value: &serde_norway::Value,
    field_name: &str,
) -> Result<Vec<String>, String> {
    if value.is_null() {
        return Ok(Vec::new());
    }

    let sequence = value
        .as_sequence()
        .ok_or_else(|| format!("{field_name} must be an array"))?;
    sequence
        .iter()
        .filter_map(extract_api_key_value)
        .collect::<Result<Vec<_>, _>>()
}

pub(crate) fn extract_api_key_value(value: &serde_norway::Value) -> Option<Result<String, String>> {
    if let Some(value) = value.as_str() {
        let value = value.trim();
        return (!value.is_empty()).then(|| Ok(value.to_string()));
    }

    let mapping = value.as_mapping()?;
    for key in ["api-key", "apiKey", "key", "Key"] {
        if let Some(value) = yaml_mapping_value(mapping, key).and_then(serde_norway::Value::as_str)
        {
            let value = value.trim();
            if !value.is_empty() {
                return Some(Ok(value.to_string()));
            }
        }
    }

    Some(Err(
        "Authentication key entry must be a string or a mapping containing a key field".to_string()
    ))
}

pub(crate) fn extract_core_management_secret_key(
    root: &serde_norway::Mapping,
) -> Result<Option<String>, String> {
    let Some(value) = nested_yaml_value(root, &["management", "secret-key"])
        .or_else(|| nested_yaml_value(root, &["remote-management", "secret-key"]))
    else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| "management.secret-key must be a string".to_string())?
        .trim()
        .to_string();
    if value.is_empty() {
        return Ok(None);
    }
    Ok(Some(value))
}

pub(crate) fn nested_yaml_value<'a>(
    root: &'a serde_norway::Mapping,
    path: &[&str],
) -> Option<&'a serde_norway::Value> {
    let (first, rest) = path.split_first()?;
    let mut value = yaml_mapping_value(root, first)?;
    for key in rest {
        value = yaml_mapping_value(value.as_mapping()?, key)?;
    }
    Some(value)
}

pub(crate) fn yaml_mapping_value<'a>(
    mapping: &'a serde_norway::Mapping,
    key: &str,
) -> Option<&'a serde_norway::Value> {
    mapping.get(yaml_key(key))
}

pub(crate) fn yaml_mapping_value_mut<'a>(
    mapping: &'a mut serde_norway::Mapping,
    key: &str,
) -> Option<&'a mut serde_norway::Value> {
    mapping.get_mut(yaml_key(key))
}

pub(crate) fn yaml_key(key: &str) -> serde_norway::Value {
    serde_norway::Value::String(key.to_string())
}

use super::*;

/// Whether two views of config.yaml hold the same configuration, whatever their formatting and comments.
fn same_configuration(left: &str, right: &str) -> Result<bool, String> {
    let parse = |content: &str| {
        serde_norway::from_str::<serde_norway::Value>(content)
            .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))
    };
    Ok(parse(left)? == parse(right)?)
}

/// An alias write may only change the `models` list of an API provider section.
/// Everything else in those sections (keys, base URLs, headers, proxies) is the
/// user's API access and must survive an alias save untouched.
pub(crate) fn validate_alias_api_access_preserved(
    current: &str,
    updated: &str,
) -> Result<(), String> {
    let parse = |content: &str| {
        serde_norway::from_str::<serde_norway::Value>(content)
            .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))
    };
    let current = parse(current)?;
    let updated = parse(updated)?;
    for section in MODEL_ALIAS_CONFIG_SECTIONS.iter().copied().chain([
        "vertex-api-key",
        "xai-api-key",
        "interactions-api-key",
    ]) {
        let without_models = |root: &serde_norway::Value| -> Result<_, String> {
            let mut value = root
                .get(section)
                .cloned()
                .unwrap_or(serde_norway::Value::Null);
            if value.is_null() {
                return Ok(serde_norway::Value::Sequence(Vec::new()));
            }
            let providers = value
                .as_sequence_mut()
                .ok_or_else(|| format!("{section} must be an array; alias save rejected"))?;
            if MODEL_ALIAS_CONFIG_SECTIONS.contains(&section) {
                for provider in providers {
                    if let Some(provider) = provider.as_mapping_mut() {
                        provider.remove(yaml_key("models"));
                    }
                }
            }
            Ok(value)
        };
        if without_models(&current)? != without_models(&updated)? {
            return Err(format!(
                "The alias update would change API access configuration ({section}); write rejected"
            ));
        }
    }
    Ok(())
}

/// config.yaml as the alias and agent code reads it; see `core_v8_yaml_to_legacy_view`.
pub(crate) fn read_core_config_view() -> Result<String, String> {
    let path = core_install_dir()?.join(CORE_CONFIG_FILE);
    let _config_guard = lock_core_config_file();
    let file = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read core configuration {}: {error}", path_to_string(&path)))?;
    core_v8_yaml_to_legacy_view(&file)
}

/// A change written into config.yaml (an alias, or the extra models): the file before and after, so a change the core
/// can't load can be taken back out.
#[derive(Debug)]
pub(crate) struct ConfigWrite {
    pub(crate) previous: String,
    pub(crate) written: String,
}

/// Writes an alias change into config.yaml at `path`: `updated` is `current`, the file as `read_core_config_view`
/// showed it, with the change made. It goes in under the lock every settings write takes, as one atomic replace, which
/// the core reloads like any edit, its model list included. A file that's changed since `current` was read is left
/// alone, since writing the change would undo whatever changed it. Returns nothing when there was nothing to write.
pub(crate) fn write_alias_config_changes_at(
    path: &Path,
    current: &str,
    updated: &str,
) -> Result<Option<ConfigWrite>, String> {
    validate_alias_api_access_preserved(current, updated)?;
    if same_configuration(current, updated)? {
        return Ok(None);
    }
    let _config_guard = lock_core_config_file();
    let previous = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read core configuration {}: {error}", path_to_string(path)))?;
    if !same_configuration(current, &core_v8_yaml_to_legacy_view(&previous)?)? {
        return Err("The core configuration changed while saving the alias; refresh and try again".to_string());
    }
    let written = legacy_view_changes_to_core_v8_yaml(&previous, updated)?;
    write_yaml_if_changed(path, &written)?;
    Ok(Some(ConfigWrite { previous, written }))
}

/// Puts config.yaml back as it was before `write`, if it's still as `write` left it.
pub(crate) fn undo_config_write_at(path: &Path, write: &ConfigWrite) -> Result<bool, String> {
    let _config_guard = lock_core_config_file();
    if fs::read_to_string(path).ok().as_deref() != Some(write.written.as_str()) {
        return Ok(false);
    }
    write_yaml_if_changed(path, &write.previous)?;
    Ok(true)
}

pub(crate) const CORE_RELOAD_WAIT: Duration = Duration::from_secs(3);
pub(crate) const CORE_RELOAD_POLL: Duration = Duration::from_millis(200);

/// Saves an alias change (see `write_alias_config_changes_at`) and, while the core runs, waits for it to reload the
/// file (see `await_core_reload`).
pub(crate) async fn save_alias_config_changes(
    config: &GuiConfigFile,
    current: &str,
    updated: &str,
) -> Result<(), String> {
    use crate::settings_in_effect::core_log_marks;

    let path = core_install_dir()?.join(CORE_CONFIG_FILE);
    let running = current_core_status(None, Some(config.port)).is_ok_and(|status| status.ready);
    let log_marks = core_log_marks(&config.auth_dir);
    let Some(write) = write_alias_config_changes_at(&path, current, updated)? else {
        return Ok(());
    };
    if !running {
        return Ok(());
    }
    await_core_reload(&path, &write, &log_marks).await
}

/// Waits for the running core to reload config.yaml after `write`, reading what it logged since `log_marks`. A change it
/// couldn't load is taken back out: the core keeps running what it had, but would fail to start on the file. One it
/// hasn't answered for within `CORE_RELOAD_WAIT` is left in.
pub(crate) async fn await_core_reload(
    path: &Path,
    write: &ConfigWrite,
    log_marks: &[(PathBuf, u64)],
) -> Result<(), String> {
    use crate::settings_in_effect::{core_log_since, reload_outcome, Reload};

    let deadline = Instant::now() + CORE_RELOAD_WAIT;
    while Instant::now() < deadline {
        tokio::time::sleep(CORE_RELOAD_POLL).await;
        match reload_outcome(&core_log_since(log_marks)) {
            Reload::Loaded => return Ok(()),
            Reload::Pending => {}
            Reload::Failed(line) => {
                let place = line.map(|line| format!(" (line {line} of its settings file)")).unwrap_or_default();
                return Err(if undo_config_write_at(path, write)? {
                    format!("The proxy couldn't load this change{place}, so it was taken back out. Nothing changed.")
                } else {
                    format!("The proxy couldn't load this change{place}, and its settings file has changed again since, so it was left as it is. Check the file before the proxy restarts.")
                });
            }
        }
    }
    Ok(())
}

//! Extra models: ones the core's built-in catalog doesn't have yet. The arbor-models core plugin (in
//! `core-plugins/`) adds them to every account of one provider, so Arbor installs a copy of it per provider, and lists
//! each provider's models in config.yaml under that copy's `plugins.configs.<id>`. A built-in model with the same id
//! always wins, so an extra goes quiet once the catalog catches up.

use super::*;

/// The providers extra models can be added to, by the core's key for their accounts, in the order the page shows them.
pub(crate) const EXTRA_MODEL_PROVIDERS: [&str; 7] = ["claude", "codex", "antigravity", "kimi", "xai", "vertex", "aistudio"];
const EXTRA_MODELS_LIMIT: usize = 100;
const PLUGIN_LOAD_WAIT: Duration = Duration::from_secs(3);

/// The core's key for a provider Arbor adds extra models to, from its key or a common name for it.
pub(crate) fn extra_models_provider(value: &str) -> Option<&'static str> {
    let value = value.trim().to_ascii_lowercase();
    let value = match value.as_str() {
        "anthropic" => "claude",
        "openai" => "codex",
        "grok" | "x-ai" => "xai",
        other => other,
    };
    EXTRA_MODEL_PROVIDERS.into_iter().find(|provider| *provider == value)
}

/// The plugin id, and so the file name, of a provider's copy of the plugin. Claude's keeps the name it had when it was
/// the only one.
pub(crate) fn extra_models_plugin_id(provider: &str) -> String {
    if provider == "claude" {
        "arbor-models".to_string()
    } else {
        format!("arbor-models-{provider}")
    }
}

pub(crate) fn extra_models_plugin_file(provider: &str) -> String {
    format!("{}.dylib", extra_models_plugin_id(provider))
}

/// One extra model, with the details the core would otherwise take from its catalog.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtraModel {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) display_name: Option<String>,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) context_length: Option<u32>,
    #[serde(default)]
    pub(crate) max_completion_tokens: Option<u32>,
    #[serde(default)]
    pub(crate) thinking: Option<ExtraModelThinking>,
    #[serde(default)]
    pub(crate) input_modalities: Vec<String>,
    #[serde(default)]
    pub(crate) output_modalities: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtraModelThinking {
    #[serde(default)]
    pub(crate) levels: Vec<String>,
    #[serde(default)]
    pub(crate) min: Option<u32>,
    #[serde(default)]
    pub(crate) max: Option<u32>,
    #[serde(default)]
    pub(crate) zero_allowed: bool,
    #[serde(default)]
    pub(crate) dynamic_allowed: bool,
}

/// What the Extra models page shows: each provider's list in config.yaml, and what the running core makes of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtraModelsView {
    /// The providers with an account in the core, or with extra models saved, in `EXTRA_MODEL_PROVIDERS` order.
    pub(crate) providers: Vec<ExtraModelsProvider>,
    /// The model ids the core serves right now, from every provider.
    pub(crate) served: Vec<String>,
    pub(crate) core_running: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtraModelsProvider {
    /// The core's key for the provider, such as `claude` or `codex`.
    pub(crate) provider: String,
    pub(crate) models: Vec<ExtraModel>,
    /// The core's built-in models for the provider, to fill a new extra in from and to tell when one has become
    /// built in.
    pub(crate) catalog: Vec<ExtraModel>,
    /// Whether the core has an account for the provider that's switched on. Not known while it's stopped.
    pub(crate) has_account: bool,
    pub(crate) plugin_installed: bool,
    pub(crate) plugin_loaded: bool,
}

/// An extra model as the plugin reads it from config.yaml.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
struct PluginModelEntry {
    #[serde(default)]
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_length: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_completion_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thinking: Option<PluginModelThinking>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    input_modalities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    output_modalities: Vec<String>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
struct PluginModelThinking {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    levels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    min: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max: Option<u32>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    zero_allowed: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    dynamic_allowed: bool,
}

impl From<PluginModelEntry> for ExtraModel {
    fn from(entry: PluginModelEntry) -> Self {
        ExtraModel {
            id: entry.id,
            display_name: entry.display_name,
            description: entry.description,
            context_length: entry.context_length,
            max_completion_tokens: entry.max_completion_tokens,
            thinking: entry.thinking.map(|thinking| ExtraModelThinking {
                levels: thinking.levels,
                min: thinking.min,
                max: thinking.max,
                zero_allowed: thinking.zero_allowed,
                dynamic_allowed: thinking.dynamic_allowed,
            }),
            input_modalities: entry.input_modalities,
            output_modalities: entry.output_modalities,
        }
    }
}

impl From<&ExtraModel> for PluginModelEntry {
    fn from(model: &ExtraModel) -> Self {
        PluginModelEntry {
            id: model.id.clone(),
            display_name: model.display_name.clone(),
            description: model.description.clone(),
            context_length: model.context_length,
            max_completion_tokens: model.max_completion_tokens,
            thinking: model.thinking.as_ref().map(|thinking| PluginModelThinking {
                levels: thinking.levels.clone(),
                min: thinking.min,
                max: thinking.max,
                zero_allowed: thinking.zero_allowed,
                dynamic_allowed: thinking.dynamic_allowed,
            }),
            input_modalities: model.input_modalities.clone(),
            output_modalities: model.output_modalities.clone(),
        }
    }
}

/// A provider's extra models in a config.yaml. A file without its copy's entry has none.
pub(crate) fn extra_models_from_yaml(content: &str, provider: &str) -> Result<Vec<ExtraModel>, String> {
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?;
    extra_models_in_document(&document, provider)
}

fn extra_models_in_document(document: &serde_norway::Value, provider: &str) -> Result<Vec<ExtraModel>, String> {
    let id = extra_models_plugin_id(provider);
    let Some(root) = document.as_mapping() else {
        return Ok(Vec::new());
    };
    let Some(models) = nested_yaml_value(root, &["plugins", "configs", &id, "models"]).filter(|models| !models.is_null())
    else {
        return Ok(Vec::new());
    };
    serde_norway::from_value::<Vec<PluginModelEntry>>(models.clone())
        .map(|entries| entries.into_iter().map(ExtraModel::from).collect())
        .map_err(|error| format!("plugins.configs.{id}.models in the proxy's settings isn't a list Arbor can read: {error}"))
}

/// Every provider's extra models in a config.yaml, for the providers that have any.
pub(crate) fn all_extra_models_from_yaml(content: &str) -> Result<Vec<(&'static str, Vec<ExtraModel>)>, String> {
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?;
    let mut saved = Vec::new();
    for provider in EXTRA_MODEL_PROVIDERS {
        let models = extra_models_in_document(&document, provider)?;
        if !models.is_empty() {
            saved.push((provider, models));
        }
    }
    Ok(saved)
}

/// config.yaml with `models` as `provider`'s extra models, comments and all. The first one turns plugins on and gives
/// the provider's copy its entry; taking the last one out leaves both, serving nothing. Returns nothing when nothing
/// changes.
pub(crate) fn patch_extra_models_yaml(
    content: &str,
    provider: &str,
    models: &[ExtraModel],
) -> Result<Option<String>, String> {
    let original = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("Failed to parse core configuration: {error}"))?;
    let id = extra_models_plugin_id(provider);
    let models_path = ["plugins", "configs", id.as_str(), "models"];
    let mut updated = original.clone();
    if !set_extra_models_in_document(&mut updated, provider, &id, models)? {
        return Ok(None);
    }
    // The list is Arbor's own, so it's written afresh: out first, then back in as a new key, which goes in as a block
    // list. Edited in place, a changed model would be written inline, which is where a file this can't do goes.
    let mut without_list = original.clone();
    let mut afresh = || {
        let content = if take_yaml_path_value(&mut without_list, &models_path) {
            match remove_yaml_block_mapping_entry(content, &models_path) {
                Some(removed) if serde_norway::from_str::<serde_norway::Value>(&removed).ok().as_ref() == Some(&without_list) => removed,
                _ => render_yaml_value_changes(content, &original, &without_list)?,
            }
        } else {
            content.to_string()
        };
        render_yaml_value_changes(&content, &without_list, &updated)
    };
    afresh()
        .or_else(|_| render_yaml_value_changes(content, &original, &updated))
        .map(Some)
}

fn set_extra_models_in_document(
    document: &mut serde_norway::Value,
    provider: &str,
    id: &str,
    models: &[ExtraModel],
) -> Result<bool, String> {
    let (plugins, configs) = ("plugins", "configs");
    let has_entry = document
        .as_mapping()
        .and_then(|root| nested_yaml_value(root, &[plugins, configs, id]))
        .is_some();
    if models.is_empty() && !has_entry {
        return Ok(false);
    }
    let entries = serde_norway::to_value(models.iter().map(PluginModelEntry::from).collect::<Vec<_>>())
        .map_err(|error| format!("Failed to serialize extra models: {error}"))?;
    let mut changed = set_core_yaml_path_value(document, &[plugins, configs, id, "models"], entries)?;
    if models.is_empty() {
        return Ok(changed);
    }
    changed |= set_core_yaml_path_value(document, &[plugins, "enabled"], serde_norway::Value::Bool(true))?;
    changed |= set_core_yaml_path_value(document, &[plugins, configs, id, "enabled"], serde_norway::Value::Bool(true))?;
    changed |= set_core_yaml_path_value(
        document,
        &[plugins, configs, id, "provider"],
        serde_norway::Value::String(provider.to_string()),
    )?;
    let has_priority = document
        .as_mapping()
        .and_then(|root| nested_yaml_value(root, &[plugins, configs, id, "priority"]))
        .is_some();
    if !has_priority {
        changed |= set_core_yaml_path_value(
            document,
            &[plugins, configs, id, "priority"],
            serde_norway::Value::Number(1.into()),
        )?;
    }
    Ok(changed)
}

/// Takes the value at `path` out, leaving the mappings around it even when that empties them.
fn take_yaml_path_value(document: &mut serde_norway::Value, path: &[&str]) -> bool {
    let Some((key, parents)) = path.split_last() else {
        return false;
    };
    let mut mapping = document.as_mapping_mut();
    for parent in parents {
        mapping = mapping
            .and_then(|mapping| yaml_mapping_value_mut(mapping, parent))
            .and_then(serde_norway::Value::as_mapping_mut);
    }
    mapping.is_some_and(|mapping| mapping.remove(yaml_key(key)).is_some())
}

/// Trims each model and checks the list is one the plugin can serve: every id is a single word, and no two are the
/// same.
pub(crate) fn validate_extra_models(models: Vec<ExtraModel>) -> Result<Vec<ExtraModel>, String> {
    if models.len() > EXTRA_MODELS_LIMIT {
        return Err(format!("Arbor keeps at most {EXTRA_MODELS_LIMIT} extra models"));
    }
    let trimmed = |value: Option<String>| value.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    let mut validated: Vec<ExtraModel> = Vec::with_capacity(models.len());
    for model in models {
        let id = validate_thinking_alias_model_id(&model.id, "Model ID")?;
        if validated.iter().any(|existing| existing.id.eq_ignore_ascii_case(&id)) {
            return Err(format!("{id} is listed twice"));
        }
        validated.push(ExtraModel {
            id,
            display_name: trimmed(model.display_name),
            description: trimmed(model.description),
            context_length: model.context_length.filter(|value| *value > 0),
            max_completion_tokens: model.max_completion_tokens.filter(|value| *value > 0),
            thinking: model.thinking,
            input_modalities: model.input_modalities,
            output_modalities: model.output_modalities,
        });
    }
    Ok(validated)
}

/// Writes `models` into config.yaml at `path` as `provider`'s extra models, under the lock every settings write takes.
/// `expected` is the list as the page last read it: one that's changed since is left alone, since saving over it would
/// undo whatever changed it. Returns nothing when there was nothing to write.
pub(crate) fn write_extra_models_at(
    path: &Path,
    provider: &str,
    expected: &[ExtraModel],
    models: &[ExtraModel],
) -> Result<Option<ConfigWrite>, String> {
    let _config_guard = lock_core_config_file();
    let previous = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read core configuration {}: {error}", path_to_string(path)))?;
    if extra_models_from_yaml(&previous, provider)? != expected {
        return Err("The extra models changed while saving; refresh and try again".to_string());
    }
    let Some(written) = patch_extra_models_yaml(&previous, provider, models)? else {
        return Ok(None);
    };
    write_yaml_if_changed(path, &written)?;
    Ok(Some(ConfigWrite { previous, written }))
}

/// The core's built-in models, from its `model-definitions` answer, as extra models to start a new one from.
pub(crate) fn catalog_models_from_definitions(payload: &serde_json::Value) -> Vec<ExtraModel> {
    #[derive(Deserialize)]
    struct CatalogModel {
        #[serde(default)]
        id: String,
        #[serde(default)]
        display_name: Option<String>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        context_length: Option<u32>,
        #[serde(default)]
        max_completion_tokens: Option<u32>,
        #[serde(default)]
        thinking: Option<CatalogThinking>,
        #[serde(default, rename = "supportedInputModalities")]
        input_modalities: Vec<String>,
        #[serde(default, rename = "supportedOutputModalities")]
        output_modalities: Vec<String>,
    }
    #[derive(Deserialize)]
    struct CatalogThinking {
        #[serde(default)]
        levels: Vec<String>,
        #[serde(default)]
        min: Option<u32>,
        #[serde(default)]
        max: Option<u32>,
        #[serde(default)]
        zero_allowed: bool,
        #[serde(default)]
        dynamic_allowed: bool,
    }
    let Some(models) = payload.get("models").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    models
        .iter()
        .filter_map(|model| serde_json::from_value::<CatalogModel>(model.clone()).ok())
        .filter(|model| !model.id.trim().is_empty())
        .map(|model| ExtraModel {
            id: model.id.trim().to_string(),
            display_name: model.display_name,
            description: model.description,
            context_length: model.context_length,
            max_completion_tokens: model.max_completion_tokens,
            thinking: model.thinking.map(|thinking| ExtraModelThinking {
                levels: thinking.levels,
                min: thinking.min,
                max: thinking.max,
                zero_allowed: thinking.zero_allowed,
                dynamic_allowed: thinking.dynamic_allowed,
            }),
            input_modalities: model.input_modalities,
            output_modalities: model.output_modalities,
        })
        .collect()
}

/// Whether the core's plugin list has the plugin `plugin_id` loaded and switched on.
pub(crate) fn extra_models_plugin_loaded(payload: &serde_json::Value, plugin_id: &str) -> bool {
    payload
        .get("plugins")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|plugins| {
            plugins.iter().any(|plugin| {
                plugin.get("id").and_then(serde_json::Value::as_str) == Some(plugin_id)
                    && plugin.get("effective_enabled").and_then(serde_json::Value::as_bool) == Some(true)
            })
        })
}

/// The providers the core's `auth-files` answer has an account for that's switched on. One that's cooling down or
/// needs signing in again still counts: extra models reach it once it's back.
pub(crate) fn extra_model_providers_with_accounts(payload: &serde_json::Value) -> Vec<&'static str> {
    let files = payload
        .get("files")
        .and_then(serde_json::Value::as_array)
        .or_else(|| payload.as_array())
        .map(Vec::as_slice)
        .unwrap_or_default();
    let with_accounts: Vec<&'static str> = files
        .iter()
        .filter(|file| !file.get("disabled").and_then(serde_json::Value::as_bool).unwrap_or(false))
        .filter_map(|file| {
            ["provider", "type"]
                .into_iter()
                .find_map(|key| file.get(key).and_then(serde_json::Value::as_str).filter(|value| !value.trim().is_empty()))
                .and_then(extra_models_provider)
        })
        .collect();
    EXTRA_MODEL_PROVIDERS
        .into_iter()
        .filter(|provider| with_accounts.contains(provider))
        .collect()
}

async fn fetch_management_json(config: &GuiConfigFile, path: &str, action: &str) -> Result<serde_json::Value, String> {
    let client = management_http_client()?;
    let response = send_management(
        client
            .get(management_endpoint(config, path)?)
            .header("Authorization", management_authorization(config)?)
            .header(reqwest::header::ACCEPT, "application/json"),
    )
    .await
    .map_err(|error| format_management_request_error(action, &error))?;
    read_management_value(response).await
}

async fn fetch_plugins(config: &GuiConfigFile) -> Option<serde_json::Value> {
    fetch_management_json(config, "plugins", "Failed to read the proxy's plugins").await.ok()
}

async fn extra_models_view(config: &GuiConfigFile) -> Result<ExtraModelsView, String> {
    let install_dir = core_install_dir()?;
    let path = install_dir.join(CORE_CONFIG_FILE);
    let saved = if path.is_file() {
        let _config_guard = lock_core_config_file();
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read core configuration {}: {error}", path_to_string(&path)))?;
        all_extra_models_from_yaml(&content)?
    } else {
        Vec::new()
    };
    let plugins_dir = install_dir.join("plugins");
    let core_running = current_core_status(None, Some(config.port)).is_ok_and(|status| status.ready);
    let with_accounts = if core_running {
        fetch_management_json(config, "auth-files", "Failed to read the proxy's accounts")
            .await
            .map(|payload| extra_model_providers_with_accounts(&payload))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let plugins = if core_running { fetch_plugins(config).await } else { None };
    let mut providers = Vec::new();
    for provider in EXTRA_MODEL_PROVIDERS {
        let models = saved
            .iter()
            .find(|(saved_provider, _)| *saved_provider == provider)
            .map(|(_, models)| models.clone())
            .unwrap_or_default();
        let has_account = with_accounts.contains(&provider);
        if models.is_empty() && !has_account {
            continue;
        }
        let catalog = if core_running {
            fetch_management_json(
                config,
                &format!("model-definitions/{provider}"),
                "Failed to read the proxy's built-in models",
            )
            .await
            .map(|payload| catalog_models_from_definitions(&payload))
            .unwrap_or_default()
        } else {
            Vec::new()
        };
        providers.push(ExtraModelsProvider {
            provider: provider.to_string(),
            models,
            catalog,
            has_account,
            plugin_installed: plugins_dir.join(extra_models_plugin_file(provider)).is_file(),
            plugin_loaded: plugins
                .as_ref()
                .is_some_and(|payload| extra_models_plugin_loaded(payload, &extra_models_plugin_id(provider))),
        });
    }
    let served = if core_running {
        fetch_agent_models(config.port, effective_agent_api_key(config))
            .await
            .map(|served| served.into_iter().filter(|model| !model.is_alias).map(|model| model.name).collect())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    Ok(ExtraModelsView { providers, served, core_running })
}

#[tauri::command]
pub(crate) async fn get_extra_models(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<ExtraModelsView, String> {
    let config = gui_config_state.snapshot()?;
    extra_models_view(&config).await
}

/// Saves `models` as `provider`'s extra models, in place of `expected`, the list as the page last read it. While the
/// core runs, the save waits for it to reload the file and to have the provider's copy of the plugin loaded; a change
/// it couldn't take is taken back out.
#[tauri::command]
pub(crate) async fn set_extra_models(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    provider: String,
    expected: Vec<ExtraModel>,
    models: Vec<ExtraModel>,
) -> Result<ExtraModelsView, String> {
    use crate::settings_in_effect::core_log_marks;

    let config = gui_config_state.snapshot()?;
    let provider = extra_models_provider(&provider)
        .ok_or_else(|| format!("Arbor can't add models to {}", provider.trim()))?;
    let models = validate_extra_models(models)?;
    if !models.is_empty() {
        install_extra_models_plugin(provider)?;
        if !core_install_dir()?.join("plugins").join(extra_models_plugin_file(provider)).is_file() {
            return Err("This copy of Arbor is missing its model plugin, so it can't add models. Reinstalling Arbor puts it back.".to_string());
        }
    }
    let path = core_install_dir()?.join(CORE_CONFIG_FILE);
    let running = current_core_status(None, Some(config.port)).is_ok_and(|status| status.ready);
    let log_marks = core_log_marks(&config.auth_dir);
    if let Some(write) = write_extra_models_at(&path, provider, &expected, &models)? {
        if running {
            await_core_reload(&path, &write, &log_marks).await?;
            if !models.is_empty() && !await_extra_models_plugin(&config, &extra_models_plugin_id(provider)).await {
                return Err(if undo_config_write_at(&path, &write)? {
                    "The proxy didn't load Arbor's model plugin, so the change was taken back out. Nothing changed.".to_string()
                } else {
                    "The proxy didn't load Arbor's model plugin, and its settings file has changed again since, so it was left as it is.".to_string()
                });
            }
        }
    }
    extra_models_view(&config).await
}

async fn await_extra_models_plugin(config: &GuiConfigFile, plugin_id: &str) -> bool {
    let deadline = Instant::now() + PLUGIN_LOAD_WAIT;
    loop {
        if fetch_plugins(config).await.is_some_and(|payload| extra_models_plugin_loaded(&payload, plugin_id)) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(CORE_RELOAD_POLL).await;
    }
}

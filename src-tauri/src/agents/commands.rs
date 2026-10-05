use super::*;

#[tauri::command]
pub(crate) async fn get_thinking_aliases() -> Result<Vec<ThinkingAliasEntry>, String> {
    let content = read_core_config_view()?;
    thinking_aliases_from_yaml(&content)
}

#[tauri::command]
pub(crate) async fn get_model_alias_sources(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<ThinkingAliasSource>, String> {
    let config = gui_config_state.snapshot()?;
    let content = read_core_config_view()?;
    let available_models =
        fetch_agent_models(config.port, effective_agent_api_key(&config)).await?;
    let definitions = fetch_oauth_model_definitions(&config).await;
    Ok(resolved_oauth_alias_sources(
        &content,
        &definitions,
        &available_models,
        AliasSourceCapability::Base,
    )?
    .into_iter()
    .map(|resolved| resolved.source)
    .collect())
}

#[tauri::command]
pub(crate) async fn get_thinking_alias_sources(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<ThinkingAliasSource>, String> {
    let config = gui_config_state.snapshot()?;
    let content = read_core_config_view()?;
    let available_models =
        fetch_agent_models(config.port, effective_agent_api_key(&config)).await?;
    let definitions = fetch_oauth_model_definitions(&config).await;
    Ok(resolved_oauth_alias_sources(
        &content,
        &definitions,
        &available_models,
        AliasSourceCapability::Reasoning,
    )?
    .into_iter()
    .map(|resolved| resolved.source)
    .collect())
}

#[tauri::command]
pub(crate) async fn create_thinking_alias(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    source_id: String,
    alias: String,
    effort: String,
    fast: Option<bool>,
) -> Result<Vec<ThinkingAliasEntry>, String> {
    let config = gui_config_state.snapshot()?;
    let source_id = source_id.trim().to_string();
    if source_id.is_empty() {
        return Err("Please select the original model first".to_string());
    }
    let alias = validate_thinking_alias_model_id(&alias, "Alias model")?;
    let effort = if effort.trim().is_empty() {
        String::new()
    } else {
        validate_thinking_alias_effort(&effort)?
    };
    let fast = fast.unwrap_or(false);
    let content = read_core_config_view()?;
    let available_models =
        fetch_agent_models(config.port, effective_agent_api_key(&config)).await?;
    let definitions = fetch_oauth_model_definitions(&config).await;
    let capability = if !effort.is_empty() {
        AliasSourceCapability::Reasoning
    } else if fast {
        AliasSourceCapability::Fast
    } else {
        AliasSourceCapability::Base
    };
    let sources =
        resolved_oauth_alias_sources(&content, &definitions, &available_models, capability)?;
    let source = sources
        .iter()
        .find(|source| source.source.id == source_id)
        .cloned()
        .ok_or_else(|| {
            "The original model is no longer available in the core, or its configuration source has changed, please refresh and select it again".to_string()
        })?;
    if fast && !alias_source_supports_fast(&source) {
        return Err("Fast only supports OpenAI-compatible API, Codex API or Codex OAuth model sources".to_string());
    }
    if !effort.is_empty()
        && !source
            .source
            .reasoning_levels
            .iter()
            .any(|level| level.eq_ignore_ascii_case(&effort))
    {
        return Err(format!(
            "Reasoning effort {effort} is not among the levels currently supported by model {}",
            source.source.model
        ));
    }
    if source.source.model.eq_ignore_ascii_case(&alias) {
        return Err("The alias model cannot be the same as the original model".to_string());
    }

    if available_models
        .iter()
        .any(|model| model.name.eq_ignore_ascii_case(&alias))
    {
        return Err(format!("{alias} is already an actual model ID and cannot be used as an alias"));
    }
    let document = serde_norway::from_str::<serde_norway::Value>(&content)
        .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "Core configuration root must be a YAML mapping".to_string())?;
    if configured_model_alias_exists(root, &alias) {
        return Err(format!("Alias model {alias} already exists"));
    }

    let updated = add_model_alias_to_yaml(&content, &source, &alias, &effort, fast)?;
    save_alias_config_changes(&config, &content, &updated).await?;
    thinking_aliases_from_yaml(&updated)
}

#[tauri::command]
pub(crate) async fn delete_thinking_alias(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    alias: String,
    oauth_channel: Option<String>,
) -> Result<Vec<ThinkingAliasEntry>, String> {
    let config = gui_config_state.snapshot()?;
    let alias = existing_thinking_alias_model_id(&alias, "Alias model")?;
    let content = read_core_config_view()?;
    let updated =
        remove_thinking_alias_from_yaml_for_channel(&content, &alias, oauth_channel.as_deref())?;
    save_alias_config_changes(&config, &content, &updated).await?;
    thinking_aliases_from_yaml(&updated)
}

#[tauri::command]
pub(crate) async fn get_speed_aliases() -> Result<Vec<SpeedAliasEntry>, String> {
    let content = read_core_config_view()?;
    speed_aliases_from_yaml(&content)
}

#[tauri::command]
pub(crate) async fn get_speed_alias_sources(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<ThinkingAliasSource>, String> {
    let config = gui_config_state.snapshot()?;
    let content = read_core_config_view()?;
    let available_models =
        fetch_agent_models(config.port, effective_agent_api_key(&config)).await?;
    let definitions = fetch_oauth_model_definitions(&config).await;
    Ok(resolved_oauth_alias_sources(
        &content,
        &definitions,
        &available_models,
        AliasSourceCapability::Fast,
    )?
    .into_iter()
    .map(|resolved| resolved.source)
    .collect())
}

#[tauri::command]
pub(crate) async fn create_speed_alias(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    source_id: String,
    alias: String,
) -> Result<Vec<SpeedAliasEntry>, String> {
    let config = gui_config_state.snapshot()?;
    let source_id = source_id.trim().to_string();
    if source_id.is_empty() {
        return Err("Please select the original model first".to_string());
    }
    let alias = validate_thinking_alias_model_id(&alias, "Alias model")?;
    let content = read_core_config_view()?;
    let available_models =
        fetch_agent_models(config.port, effective_agent_api_key(&config)).await?;
    let definitions = fetch_oauth_model_definitions(&config).await;
    let sources = resolved_oauth_alias_sources(
        &content,
        &definitions,
        &available_models,
        AliasSourceCapability::Fast,
    )?;
    let source = sources
        .iter()
        .find(|source| source.source.id == source_id)
        .cloned()
        .ok_or_else(|| {
            "The original model is no longer available in the core, or its configuration source has changed, please refresh and try again".to_string()
        })?;
    if source.source.model.eq_ignore_ascii_case(&alias) {
        return Err("The alias model cannot be the same as the original model".to_string());
    }
    if available_models
        .iter()
        .any(|model| model.name.eq_ignore_ascii_case(&alias))
    {
        return Err(format!("{alias} is already an actual model ID and cannot be used as an alias"));
    }
    let document = serde_norway::from_str::<serde_norway::Value>(&content)
        .map_err(|error| format!("Failed to parse core YAML configuration: {error}"))?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "Core configuration root must be a YAML mapping".to_string())?;
    if configured_model_alias_exists(root, &alias) {
        return Err(format!("Alias model {alias} already exists"));
    }

    let updated = add_speed_alias_to_yaml(&content, &source, &alias)?;
    save_alias_config_changes(&config, &content, &updated).await?;
    speed_aliases_from_yaml(&updated)
}

#[tauri::command]
pub(crate) async fn delete_speed_alias(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    alias: String,
    oauth_channel: Option<String>,
) -> Result<Vec<SpeedAliasEntry>, String> {
    let config = gui_config_state.snapshot()?;
    let alias = existing_thinking_alias_model_id(&alias, "Alias model")?;
    let content = read_core_config_view()?;
    let updated =
        remove_speed_alias_from_yaml_for_channel(&content, &alias, oauth_channel.as_deref())?;
    save_alias_config_changes(&config, &content, &updated).await?;
    speed_aliases_from_yaml(&updated)
}

#[tauri::command]
pub(crate) async fn get_model_overrides(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<ModelOverrideEntry>, String> {
    let config = gui_config_state.snapshot()?;
    let content = read_core_config_view()?;
    let definitions = fetch_oauth_model_definitions(&config).await;
    model_overrides_from_yaml(&content, &definitions)
}

#[tauri::command]
pub(crate) async fn create_model_override(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    requested_model: String,
    source_id: String,
    force_mapping: Option<bool>,
    include_long_context: Option<bool>,
) -> Result<Vec<ModelOverrideEntry>, String> {
    let config = gui_config_state.snapshot()?;
    let requested_model = validate_thinking_alias_model_id(&requested_model, "Requested model")?;
    let source_id = source_id.trim();
    if source_id.is_empty() {
        return Err("Please select the original model first".to_string());
    }
    let content = read_core_config_view()?;
    let available_models =
        fetch_agent_models(config.port, effective_agent_api_key(&config)).await?;
    let definitions = fetch_oauth_model_definitions(&config).await;
    let sources = resolved_oauth_alias_sources(
        &content,
        &definitions,
        &available_models,
        AliasSourceCapability::Base,
    )?;
    let source = sources.iter().find(|source| source.source.id == source_id)
        .ok_or_else(|| "The original model is no longer available in the core, or its configuration source has changed, please refresh and select it again".to_string())?;
    if let ThinkingAliasSourceLocation::Oauth { channel, .. } = &source.location {
        if let Some(provider) = other_provider_of(&definitions, &requested_model, channel) {
            return Err(format!("{requested_model} is a {provider} model. Pick one from the same provider to serve it."));
        }
    }
    let updated = add_model_override_to_yaml(
        &content,
        source,
        &requested_model,
        force_mapping.unwrap_or(true),
        include_long_context.unwrap_or(false),
    )?;
    save_alias_config_changes(&config, &content, &updated).await?;
    model_overrides_from_yaml(&updated, &definitions)
}

#[tauri::command]
pub(crate) async fn delete_model_override(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    requested_model: String,
    oauth_channel: String,
) -> Result<Vec<ModelOverrideEntry>, String> {
    let config = gui_config_state.snapshot()?;
    let requested_model = validate_thinking_alias_model_id(&requested_model, "Requested model")?;
    let content = read_core_config_view()?;
    let updated = remove_model_override_from_yaml(&content, &requested_model, &oauth_channel)?;
    save_alias_config_changes(&config, &content, &updated).await?;
    let definitions = fetch_oauth_model_definitions(&config).await;
    model_overrides_from_yaml(&updated, &definitions)
}

pub(crate) async fn fetch_agent_models(
    port: u16,
    api_key: &str,
) -> Result<Vec<AgentModelOption>, String> {
    if port == 0 {
        return Err("Invalid core port".to_string());
    }
    let tls_enabled = managed_core_tls_enabled();
    let client = reqwest::Client::builder()
        // The model list comes from the local core over loopback; a system proxy
        // must never sit in between.
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(15))
        .danger_accept_invalid_certs(tls_enabled)
        .build()
        .map_err(|error| format!("Failed to create model list client: {error}"))?;
    let base_url = managed_core_loopback_origin(port);
    let endpoints = [
        format!("{base_url}/v1/models"),
        format!("{base_url}/models"),
    ];

    for (index, endpoint) in endpoints.iter().enumerate() {
        let response = client
            .get(endpoint)
            .bearer_auth(api_key)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .send()
            .await
            .map_err(|error| format!("Failed to request local model list: {error}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| format!("Failed to read local model list: {error}"))?;
        if status.is_success() {
            let payload = serde_json::from_str::<serde_json::Value>(&body).map_err(|error| {
                format!(
                    "Failed to parse local model list: {error}; body={}",
                    truncate_for_error(&body)
                )
            })?;
            return parse_agent_model_options(&payload);
        }

        let can_try_legacy_path = index == 0 && matches!(status.as_u16(), 404 | 405);
        if !can_try_legacy_path {
            return Err(format_agent_models_error(status.as_u16(), &body));
        }
    }

    Err("The local core does not support the model list endpoint".to_string())
}

pub(crate) fn parse_agent_model_options(
    payload: &serde_json::Value,
) -> Result<Vec<AgentModelOption>, String> {
    let source = payload
        .as_array()
        .or_else(|| payload.get("data").and_then(serde_json::Value::as_array))
        .or_else(|| payload.get("models").and_then(serde_json::Value::as_array))
        .ok_or_else(|| "Local model list response is missing the data or models array".to_string())?;
    let mut models = Vec::new();
    for item in source {
        let name = if let Some(name) = item.as_str() {
            name.trim().to_string()
        } else {
            ["id", "name", "model", "value"]
                .into_iter()
                .find_map(|key| item.get(key).and_then(serde_json::Value::as_str))
                .unwrap_or_default()
                .trim()
                .to_string()
        };
        let display_name = ["display_name", "displayName"]
            .into_iter()
            .find_map(|key| item.get(key).and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case(&name))
            .map(str::to_string);
        let model_alias = item
            .get("alias")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case(&name))
            .map(str::to_string);
        let keep_original = item
            .get("fork")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let context_window = [
            "context_length",
            "contextLength",
            "ContextLength",
            "context_window",
            "contextWindow",
            "max_input_tokens",
            "maxInputTokens",
            "input_token_limit",
            "inputTokenLimit",
        ]
        .into_iter()
        .find_map(|key| item.get(key).and_then(json_positive_u64));

        if let Some(model_alias) = model_alias {
            if keep_original {
                append_agent_model_option(&mut models, &name, display_name, false, context_window);
            }
            append_agent_model_option(&mut models, &model_alias, Some(name), true, context_window);
        } else {
            append_agent_model_option(&mut models, &name, display_name, false, context_window);
        }
    }
    Ok(models)
}

pub(crate) fn append_agent_model_option(
    models: &mut Vec<AgentModelOption>,
    name: &str,
    alias: Option<String>,
    is_alias: bool,
    context_window: Option<u64>,
) {
    let name = name.trim();
    if name.is_empty()
        || models
            .iter()
            .any(|model| model.name.eq_ignore_ascii_case(name))
    {
        return;
    }
    let alias = alias
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case(name))
        .map(str::to_string);
    models.push(AgentModelOption {
        name: name.to_string(),
        alias,
        is_alias,
        context_window,
    });
}

pub(crate) fn parse_codex_model_definitions(
    payload: &serde_json::Value,
) -> Result<Vec<CodexModelDefinition>, String> {
    let source = payload
        .as_array()
        .or_else(|| payload.get("models").and_then(serde_json::Value::as_array))
        .or_else(|| payload.get("data").and_then(serde_json::Value::as_array))
        .ok_or_else(|| "Codex model definition response is missing the models or data array".to_string())?;
    let mut definitions = Vec::new();
    for item in source {
        let id = ["id", "ID", "name"]
            .into_iter()
            .find_map(|key| item.get(key).and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(id) = id else {
            continue;
        };
        if definitions
            .iter()
            .any(|definition: &CodexModelDefinition| definition.id.eq_ignore_ascii_case(id))
        {
            continue;
        }
        let display_name = ["display_name", "displayName", "DisplayName"]
            .into_iter()
            .find_map(|key| item.get(key).and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let description = item
            .get("description")
            .or_else(|| item.get("Description"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let context_window = ["context_length", "contextLength", "ContextLength"]
            .into_iter()
            .find_map(|key| item.get(key).and_then(json_positive_u64));
        let reasoning_levels = item
            .get("thinking")
            .or_else(|| item.get("Thinking"))
            .and_then(|thinking| thinking.get("levels").or_else(|| thinking.get("Levels")))
            .and_then(serde_json::Value::as_array)
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::trim)
                    .map(str::to_ascii_lowercase)
                    .filter(|level| is_codex_reasoning_level(level))
                    .fold(Vec::new(), |mut result, level| {
                        if !result.contains(&level) {
                            result.push(level);
                        }
                        result
                    })
            })
            .unwrap_or_default();
        let supports_tools = item
            .get("supported_parameters")
            .or_else(|| item.get("supportedParameters"))
            .or_else(|| item.get("SupportedParameters"))
            .and_then(serde_json::Value::as_array)
            .map(|parameters| {
                parameters.iter().any(|parameter| {
                    parameter
                        .as_str()
                        .is_some_and(|value| value.eq_ignore_ascii_case("tools"))
                })
            });
        definitions.push(CodexModelDefinition {
            id: id.to_string(),
            display_name,
            description,
            context_window,
            reasoning_levels,
            supports_tools,
        });
    }
    Ok(definitions)
}

pub(crate) fn json_positive_u64(value: &serde_json::Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
}

pub(crate) fn is_codex_reasoning_level(value: &str) -> bool {
    matches!(
        value,
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    )
}

pub(crate) fn format_agent_models_error(status: u16, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        let message = value
            .get("error")
            .and_then(|error| {
                error
                    .as_str()
                    .or_else(|| error.get("message").and_then(serde_json::Value::as_str))
            })
            .or_else(|| value.get("message").and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|message| !message.is_empty());
        if let Some(message) = message {
            return format!("Failed to fetch local model list ({status}): {message}");
        }
    }
    let body = body.trim();
    if body.is_empty() {
        format!("Failed to fetch local model list ({status})")
    } else {
        format!(
            "Failed to fetch local model list ({status}): {}",
            truncate_for_error(body)
        )
    }
}

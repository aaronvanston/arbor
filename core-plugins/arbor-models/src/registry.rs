use std::collections::HashSet;
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(crate) const PLUGIN_NAME: &str = "arbor-models";
const DEFAULT_PROVIDER: &str = "claude";

/// What Arbor writes under `plugins.configs.arbor-models` in the core's config.yaml.
/// The core adds its own `enabled` and `priority` keys to the same mapping, which
/// this ignores.
#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) struct PluginConfig {
    #[serde(default)]
    pub(crate) provider: Option<String>,
    #[serde(default)]
    pub(crate) models: Vec<ExtraModel>,
}

#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) struct ExtraModel {
    #[serde(default)]
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) display_name: Option<String>,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) context_length: Option<i64>,
    #[serde(default)]
    pub(crate) max_completion_tokens: Option<i64>,
    #[serde(default)]
    pub(crate) thinking: Option<Thinking>,
    #[serde(default)]
    pub(crate) input_modalities: Vec<String>,
    #[serde(default)]
    pub(crate) output_modalities: Vec<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) struct Thinking {
    #[serde(default)]
    pub(crate) levels: Vec<String>,
    /// Budget bounds, for the older models that take a thinking budget rather than a level.
    #[serde(default)]
    pub(crate) min: Option<i64>,
    #[serde(default)]
    pub(crate) max: Option<i64>,
    #[serde(default)]
    pub(crate) zero_allowed: bool,
    #[serde(default)]
    pub(crate) dynamic_allowed: bool,
}

/// The core's `pluginapi.ModelInfo`, which has no JSON tags and so uses Go's field
/// names on the wire.
#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
struct CoreModelInfo {
    #[serde(rename = "ID")]
    id: String,
    object: &'static str,
    owned_by: String,
    #[serde(rename = "Type")]
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_length: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_completion_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    supported_input_modalities: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    supported_output_modalities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<CoreThinking>,
    user_defined: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
struct CoreThinking {
    levels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    min: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max: Option<i64>,
    zero_allowed: bool,
    dynamic_allowed: bool,
}

static CONFIG: Mutex<Option<PluginConfig>> = Mutex::new(None);

pub(crate) fn handle(method: &str, request: &[u8]) -> String {
    match method {
        "plugin.register" | "plugin.reconfigure" => match lifecycle_config(request) {
            Ok(config) => {
                *CONFIG.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(config);
                ok_envelope(registration())
            }
            Err(message) => error_envelope("invalid_config", &message),
        },
        "model.register" => {
            let config = CONFIG
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
                .unwrap_or_default();
            ok_envelope(model_registration(&config))
        }
        _ => error_envelope("unknown_method", &format!("unknown method: {method}")),
    }
}

/// Only `model_registrar`: the core appends a registrar's models to every account of
/// its provider, after the built-in ones, and a built-in id wins. Declaring
/// `model_provider` instead would replace each account's whole list, losing the
/// catalog details the plugin API can't carry.
fn registration() -> Value {
    json!({
        "schema_version": 1,
        "metadata": {
            "Name": PLUGIN_NAME,
            "Version": env!("CARGO_PKG_VERSION"),
            "Author": "Arbor",
            "GitHubRepository": "https://github.com/aaronvanston/arbor",
            "ConfigFields": [],
        },
        "capabilities": { "model_registrar": true },
    })
}

fn lifecycle_config(request: &[u8]) -> Result<PluginConfig, String> {
    #[derive(Deserialize)]
    struct Lifecycle {
        #[serde(default)]
        config_yaml: Option<String>,
    }
    if request.is_empty() {
        return Ok(PluginConfig::default());
    }
    let lifecycle: Lifecycle =
        serde_json::from_slice(request).map_err(|error| format!("request: {error}"))?;
    // Go sends its []byte as base64.
    let yaml = match lifecycle.config_yaml.as_deref().map(str::trim) {
        None | Some("") => return Ok(PluginConfig::default()),
        Some(encoded) => base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| format!("config_yaml: {error}"))?,
    };
    parse_config(&yaml)
}

pub(crate) fn parse_config(yaml: &[u8]) -> Result<PluginConfig, String> {
    if yaml.iter().all(u8::is_ascii_whitespace) {
        return Ok(PluginConfig::default());
    }
    let config: Option<PluginConfig> =
        serde_norway::from_slice(yaml).map_err(|error| format!("config: {error}"))?;
    Ok(config.unwrap_or_default())
}

fn model_registration(config: &PluginConfig) -> Value {
    let provider = config
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|provider| !provider.is_empty())
        .unwrap_or(DEFAULT_PROVIDER)
        .to_ascii_lowercase();
    let (owned_by, kind) = owner_and_type(&provider);
    let mut seen = HashSet::new();
    let models: Vec<CoreModelInfo> = config
        .models
        .iter()
        .filter_map(|model| {
            let id = model.id.trim();
            (!id.is_empty() && seen.insert(id.to_string())).then(|| CoreModelInfo {
                id: id.to_string(),
                object: "model",
                owned_by: owned_by.clone(),
                kind: kind.clone(),
                display_name: non_blank(model.display_name.as_deref()),
                description: non_blank(model.description.as_deref()),
                context_length: model.context_length.filter(|value| *value > 0),
                max_completion_tokens: model.max_completion_tokens.filter(|value| *value > 0),
                supported_input_modalities: model.input_modalities.clone(),
                supported_output_modalities: model.output_modalities.clone(),
                thinking: model.thinking.as_ref().map(|thinking| CoreThinking {
                    levels: thinking.levels.clone(),
                    min: thinking.min.filter(|value| *value > 0),
                    max: thinking.max.filter(|value| *value > 0),
                    zero_allowed: thinking.zero_allowed,
                    dynamic_allowed: thinking.dynamic_allowed,
                }),
                user_defined: true,
            })
        })
        .collect();
    json!({ "Provider": provider, "Models": models })
}

/// Who owns a provider's models and their type, as the core's own catalog says for its
/// built-in ones. The type matters: the core checks a model's reasoning settings by it.
fn owner_and_type(provider: &str) -> (String, String) {
    let (owned_by, kind) = match provider {
        "claude" => ("anthropic", "claude"),
        "codex" => ("openai", "openai"),
        "gemini" | "gemini-interactions" | "vertex" | "aistudio" => ("google", "gemini"),
        "kimi" | "kimi-ai" => ("moonshot", "kimi"),
        other => (other, other),
    };
    (owned_by.to_string(), kind.to_string())
}

fn non_blank(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
}

fn ok_envelope(result: Value) -> String {
    json!({ "ok": true, "result": result }).to_string()
}

pub(crate) fn error_envelope(code: &str, message: &str) -> String {
    json!({ "ok": false, "error": { "code": code, "message": message } }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lifecycle_request(yaml: &str) -> Vec<u8> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(yaml);
        json!({ "config_yaml": encoded, "schema_version": 1 }).to_string().into_bytes()
    }

    fn parse(envelope: &str) -> Value {
        serde_json::from_str(envelope).expect("envelope is JSON")
    }

    // The tests share the plugin's one config, so they run as one sequence.
    #[test]
    fn registers_as_a_model_registrar_and_serves_the_configured_models() {
        let registered = parse(&handle(
            "plugin.register",
            &lifecycle_request(
                "enabled: true\npriority: 1\nprovider: claude\nmodels:\n  - id: claude-sonnet-5-5\n    display-name: Claude Sonnet 5.5\n    context-length: 1000000\n    max-completion-tokens: 128000\n    thinking:\n      levels: [low, high]\n      dynamic-allowed: true\n    input-modalities: [text, image]\n  - id: '  '\n  - id: claude-sonnet-5-5\n    display-name: Duplicate\n",
            ),
        ));
        assert_eq!(registered["ok"], true);
        let result = &registered["result"];
        assert_eq!(result["capabilities"], json!({ "model_registrar": true }));
        for field in ["Name", "Version", "Author", "GitHubRepository"] {
            assert!(result["metadata"][field].as_str().is_some_and(|value| !value.is_empty()), "{field}");
        }

        let models = parse(&handle("model.register", &[]));
        assert_eq!(models["ok"], true);
        assert_eq!(models["result"]["Provider"], "claude");
        assert_eq!(
            models["result"]["Models"],
            json!([{
                "ID": "claude-sonnet-5-5",
                "Object": "model",
                "OwnedBy": "anthropic",
                "Type": "claude",
                "DisplayName": "Claude Sonnet 5.5",
                "ContextLength": 1000000,
                "MaxCompletionTokens": 128000,
                "SupportedInputModalities": ["text", "image"],
                "Thinking": { "Levels": ["low", "high"], "ZeroAllowed": false, "DynamicAllowed": true },
                "UserDefined": true,
            }])
        );

        // A reload with the list emptied serves nothing, which the core accepts.
        let reconfigured = parse(&handle("plugin.reconfigure", &lifecycle_request("enabled: true\nmodels: []\n")));
        assert_eq!(reconfigured["ok"], true);
        assert_eq!(parse(&handle("model.register", &[]))["result"]["Models"], json!([]));

        // A bad config is refused and the last good one stays.
        handle("plugin.reconfigure", &lifecycle_request("models:\n  - id: claude-opus-6\n"));
        let refused = parse(&handle("plugin.reconfigure", &lifecycle_request("models: {not: [a list")));
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["error"]["code"], "invalid_config");
        assert_eq!(parse(&handle("model.register", &[]))["result"]["Models"][0]["ID"], "claude-opus-6");
    }

    #[test]
    fn thinking_budgets_are_passed_on() {
        let config = parse_config(b"models:\n  - id: claude-sonnet-4-9\n    thinking:\n      min: 1024\n      max: 128000\n      zero-allowed: true\n").expect("parses");
        assert_eq!(
            model_registration(&config)["Models"][0]["Thinking"],
            json!({ "Levels": [], "Min": 1024, "Max": 128000, "ZeroAllowed": true, "DynamicAllowed": false })
        );
    }

    #[test]
    fn another_provider_owns_its_models() {
        let config = parse_config(b"provider: Codex\nmodels:\n  - id: gpt-7\n").expect("parses");
        let registration = model_registration(&config);
        assert_eq!(registration["Provider"], "codex");
        assert_eq!(registration["Models"][0]["OwnedBy"], "openai");
        assert_eq!(registration["Models"][0]["Type"], "openai");

        let config = parse_config(b"provider: xai\nmodels:\n  - id: grok-9\n").expect("parses");
        let registration = model_registration(&config);
        assert_eq!(registration["Provider"], "xai");
        assert_eq!(registration["Models"][0]["OwnedBy"], "xai");
        assert_eq!(registration["Models"][0]["Type"], "xai");
    }

    #[test]
    fn an_empty_or_missing_config_serves_nothing() {
        assert_eq!(parse_config(b"").expect("empty"), PluginConfig::default());
        assert_eq!(parse_config(b"enabled: false\n").expect("no models"), PluginConfig::default());
        assert_eq!(model_registration(&PluginConfig::default())["Models"], json!([]));
    }

    #[test]
    fn unknown_methods_are_errors() {
        let envelope = parse(&handle("model.for_auth", &[]));
        assert_eq!(envelope["ok"], false);
        assert_eq!(envelope["error"]["code"], "unknown_method");
    }
}

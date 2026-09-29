use super::support::*;
use super::*;

#[test]
fn agent_model_list_parser_exposes_aliases_as_selectable_model_ids() {
    let models = parse_agent_model_options(&serde_json::json!({
            "object": "list",
            "data": [
                {"id": "gpt-5", "display_name": "GPT 5", "context_length": 272000},
                {"name": "claude-sonnet", "alias": "claude-sonnet-xhigh", "fork": true, "contextLength": "1000000"},
                {"name": "hidden-original", "alias": "visible-alias", "ContextLength": 128000},
                "deepseek-chat",
                {"id": "GPT-5"},
                {"id": ""}
            ]
        }))
        .unwrap();

    assert_eq!(
        models,
        vec![
            AgentModelOption {
                name: "gpt-5".to_string(),
                alias: Some("GPT 5".to_string()),
                is_alias: false,
                context_window: Some(272_000),
            },
            AgentModelOption {
                name: "claude-sonnet".to_string(),
                alias: None,
                is_alias: false,
                context_window: Some(1_000_000),
            },
            AgentModelOption {
                name: "claude-sonnet-xhigh".to_string(),
                alias: Some("claude-sonnet".to_string()),
                is_alias: true,
                context_window: Some(1_000_000),
            },
            AgentModelOption {
                name: "visible-alias".to_string(),
                alias: Some("hidden-original".to_string()),
                is_alias: true,
                context_window: Some(128_000),
            },
            AgentModelOption {
                name: "deepseek-chat".to_string(),
                alias: None,
                is_alias: false,
                context_window: None,
            },
        ]
    );
}

#[test]
fn agent_model_list_parser_rejects_unexpected_response_shape() {
    assert!(parse_agent_model_options(&serde_json::json!({"data": null})).is_err());
}

#[test]
fn thinking_alias_sources_only_include_current_core_models() {
    let input = "codex-api-key:\n  - name: Codex API\n    api-key: test\n    models:\n      - name: config-only\nopenai-compatibility:\n  - name: DeepSeek\n    base-url: https://api.deepseek.com\n    api-key-entries:\n      - api-key: test\n    models:\n      - name: DeepSeek-Chat\n";
    let definitions = parse_codex_model_definitions(&serde_json::json!({
        "models": [
            {
                "id": "gpt-runtime",
                "thinking": { "levels": ["low", "high"] }
            },
            {
                "id": "gpt-built-in-only",
                "thinking": { "levels": ["low", "high"] }
            }
        ]
    }))
    .unwrap();
    let available_models = test_agent_models(&["GPT-RUNTIME", "deepseek-chat"]);

    let sources = resolved_thinking_alias_sources(input, &definitions, &available_models).unwrap();
    let source_models = sources
        .iter()
        .map(|source| source.source.model.as_str())
        .collect::<Vec<_>>();

    assert_eq!(source_models, vec!["DeepSeek-Chat", "gpt-runtime"]);
    assert!(!source_models.contains(&"gpt-built-in-only"));
    assert!(!source_models.contains(&"config-only"));
}

#[test]
fn thinking_alias_prefers_codex_api_key_model_over_same_named_oauth_definition() {
    let input = "codex-api-key:\n  - name: CPA\n    api-key: test\n    models:\n      - name: gpt-5.6-luna\n";
    let definitions = parse_codex_model_definitions(&serde_json::json!({
        "models": [{
            "id": "gpt-5.6-luna",
            "thinking": { "levels": ["low", "high", "xhigh"] }
        }]
    }))
    .unwrap();
    let available_models = test_agent_models(&["gpt-5.6-luna"]);

    let sources = resolved_thinking_alias_sources(input, &definitions, &available_models).unwrap();

    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].source.model, "gpt-5.6-luna");
    assert_eq!(sources[0].source.kind, "codex-api");
    assert!(matches!(
        sources[0].location,
        ThinkingAliasSourceLocation::ConfigModel {
            section: "codex-api-key",
            ..
        }
    ));

    let rendered =
        add_model_alias_to_yaml(input, &sources[0], "gpt-5.6-luna-xhigh", "xhigh", false).unwrap();
    assert!(rendered.contains("alias: gpt-5.6-luna-xhigh"), "{rendered}");
    assert!(!rendered.contains("oauth-model-alias"), "{rendered}");
}

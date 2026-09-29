use super::support::*;
use super::*;

fn test_oauth_definition_set(channel: &str, models: &[&str]) -> OAuthModelDefinitions {
    OAuthModelDefinitions {
        channel: oauth_alias_channel(channel).unwrap(),
        models: models
            .iter()
            .map(|model| CodexModelDefinition {
                id: (*model).to_string(),
                display_name: None,
                description: None,
                context_window: None,
                reasoning_levels: Vec::new(),
                supports_tools: None,
            })
            .collect(),
    }
}

fn test_oauth_thinking_source(channel: &str, model: &str) -> ResolvedThinkingAliasSource {
    let channel = oauth_alias_channel(channel).unwrap();
    ResolvedThinkingAliasSource {
        source: ThinkingAliasSource {
            id: format!("{}:{model}", channel.kind),
            model: model.to_string(),
            display_name: None,
            provider: channel.provider.to_string(),
            kind: channel.kind.to_string(),
            protocol: channel.protocol.to_string(),
            reasoning_levels: vec!["low".to_string(), "high".to_string()],
        },
        location: ThinkingAliasSourceLocation::Oauth {
            channel: channel.key,
            force_mapping: channel.force_mapping,
        },
    }
}

#[test]
fn oauth_reasoning_sources_follow_each_model_definition() {
    let definition_sets = [
        "vertex",
        "aistudio",
        "antigravity",
        "claude",
        "codex",
        "kimi",
        "xai",
    ]
    .into_iter()
    .map(|channel| {
        let mut definitions = test_oauth_definition_set(channel, &[&format!("{channel}-model")]);
        definitions.models[0].reasoning_levels = vec!["low".to_string(), "high".to_string()];
        definitions
    })
    .collect::<Vec<_>>();
    let available = definition_sets
        .iter()
        .map(|definitions| definitions.models[0].id.as_str())
        .collect::<Vec<_>>();
    let sources = resolved_oauth_alias_sources(
        "{}\n",
        &definition_sets,
        &test_agent_models(&available),
        AliasSourceCapability::Reasoning,
    )
    .unwrap();

    assert_eq!(sources.len(), definition_sets.len());
    assert!(sources
        .iter()
        .all(|source| source.source.reasoning_levels == ["low", "high"]));
    assert_eq!(
        sources
            .iter()
            .find(|source| source.source.kind == "xai-oauth")
            .unwrap()
            .source
            .protocol,
        "codex"
    );
}

#[test]
fn thinking_alias_uses_source_native_override_parameters() {
    let cases = [
        (
            "codex",
            "gpt-5.6-sol",
            "high",
            &["reasoning.effort: high"][..],
        ),
        (
            "claude",
            "claude-opus-4-6",
            "high",
            &["thinking.type: adaptive", "output_config.effort: high"][..],
        ),
        (
            "claude",
            "claude-opus-4-6",
            "auto",
            &["thinking.type: adaptive"][..],
        ),
        (
            "claude",
            "claude-opus-4-6",
            "none",
            &["thinking.type: disabled"][..],
        ),
        (
            "aistudio",
            "gemini-3.1-pro",
            "high",
            &["generationConfig.thinkingConfig.thinkingLevel: high"][..],
        ),
        (
            "antigravity",
            "gemini-3.1-pro",
            "high",
            &["generationConfig.thinkingConfig.thinkingLevel: high"][..],
        ),
        (
            "kimi",
            "kimi-k2.5",
            "high",
            &["thinking.type: enabled", "thinking.effort: high"][..],
        ),
        (
            "kimi",
            "kimi-k2.5",
            "none",
            &["thinking.type: disabled"][..],
        ),
        ("xai", "grok-4", "high", &["reasoning.effort: high"][..]),
    ];

    for (channel, model, effort, expected) in cases {
        let source = test_oauth_thinking_source(channel, model);
        let alias = format!("{model}-{effort}");
        let rendered = add_model_alias_to_yaml("{}\n", &source, &alias, effort, false).unwrap();
        for parameter in expected {
            assert!(
                rendered.contains(parameter),
                "{channel}: missing {parameter}\n{rendered}"
            );
        }
        assert_eq!(
            thinking_aliases_from_yaml(&rendered).unwrap()[0]
                .effort
                .as_deref(),
            Some(effort)
        );
        let restored = remove_thinking_alias_from_yaml(&rendered, &alias).unwrap();
        assert!(!restored.contains(&alias), "{channel}: {restored}");
    }
}

#[test]
fn configured_claude_and_gemini_models_use_native_overrides() {
    let input = "claude-api-key:\n  - api-key: claude-key\n    models:\n      - name: claude-opus-4-6\n        thinking:\n          levels: [low, high]\ngemini-api-key:\n  - api-key: gemini-key\n    models:\n      - name: gemini-3.1-pro\n        thinking:\n          levels: [low, high]\n";
    let available_models = test_agent_models(&["claude-opus-4-6", "gemini-3.1-pro"]);
    let sources = resolved_oauth_alias_sources(
        input,
        &[],
        &available_models,
        AliasSourceCapability::Reasoning,
    )
    .unwrap();

    let claude = sources
        .iter()
        .find(|source| source.source.kind == "claude-api")
        .unwrap();
    let with_claude =
        add_model_alias_to_yaml(input, claude, "claude-fixed", "high", false).unwrap();
    assert!(
        with_claude.contains("output_config.effort: high"),
        "{with_claude}"
    );

    let sources = resolved_oauth_alias_sources(
        &with_claude,
        &[],
        &available_models,
        AliasSourceCapability::Reasoning,
    )
    .unwrap();
    let gemini = sources
        .iter()
        .find(|source| source.source.kind == "gemini-api")
        .unwrap();
    let rendered =
        add_model_alias_to_yaml(&with_claude, gemini, "gemini-fixed", "low", false).unwrap();
    assert!(
        rendered.contains("generationConfig.thinkingConfig.thinkingLevel: low"),
        "{rendered}"
    );
    assert!(thinking_aliases_from_yaml(&rendered)
        .unwrap()
        .iter()
        .any(|entry| entry.alias == "claude-fixed"));
    assert!(thinking_aliases_from_yaml(&rendered)
        .unwrap()
        .iter()
        .any(|entry| entry.alias == "gemini-fixed"));
    let document: serde_norway::Value = serde_norway::from_str(&rendered).unwrap();
    let root = document.as_mapping().unwrap();
    for (section, alias, protocol) in [
        ("claude-api-key", "claude-fixed", "claude"),
        ("gemini-api-key", "gemini-fixed", "gemini"),
    ] {
        let alias_model = yaml_mapping_value(root, section)
            .and_then(serde_norway::Value::as_sequence)
            .and_then(|providers| providers[0].as_mapping())
            .and_then(|provider| yaml_mapping_value(provider, "models"))
            .and_then(serde_norway::Value::as_sequence)
            .unwrap()
            .iter()
            .find(|model| {
                configured_model_identity(model)
                    .is_some_and(|(_, model_alias, _)| model_alias == alias)
            })
            .unwrap();
        assert_eq!(
            configured_model_reasoning_levels(alias_model, protocol),
            ["low", "high"]
        );
    }
}

#[test]
fn antigravity_alias_uses_its_own_oauth_channel_and_force_mapping() {
    let available_models = test_agent_models(&["gemini-pro-agent"]);
    let definitions = vec![test_oauth_definition_set(
        "antigravity",
        &["gemini-pro-agent"],
    )];
    let sources = resolved_oauth_alias_sources(
        "{}\n",
        &definitions,
        &available_models,
        AliasSourceCapability::Base,
    )
    .unwrap();

    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].source.kind, "antigravity-oauth");
    let rendered =
        add_model_alias_to_yaml("{}\n", &sources[0], "gemini-3.1-pro-preview", "", false).unwrap();

    assert!(rendered.contains("antigravity:"), "{rendered}");
    assert!(rendered.contains("name: gemini-pro-agent"), "{rendered}");
    assert!(
        rendered.contains("alias: gemini-3.1-pro-preview"),
        "{rendered}"
    );
    assert!(rendered.contains("force-mapping: true"), "{rendered}");
    assert!(!rendered.contains("codex:"), "{rendered}");
}

#[test]
fn oauth_alias_reader_and_delete_preserve_the_exact_channel() {
    let input = "oauth-model-alias:\n  antigravity:\n    - name: gemini-pro-agent\n      alias: shared-alias\n      force-mapping: true\n  codex:\n    - name: gpt-5.5\n      alias: shared-alias\n      fork: true\n";
    let entries = thinking_aliases_from_yaml(input).unwrap();

    assert_eq!(entries.len(), 2);
    assert!(entries.iter().any(|entry| {
        entry.oauth_channel.as_deref() == Some("antigravity") && entry.kind == "antigravity-oauth"
    }));
    let rendered =
        remove_thinking_alias_from_yaml_for_channel(input, "shared-alias", Some("antigravity"))
            .unwrap();

    assert!(!rendered.contains("antigravity:"), "{rendered}");
    assert!(rendered.contains("codex:"), "{rendered}");
    assert!(rendered.contains("name: gpt-5.5"), "{rendered}");
}

#[test]
fn fast_is_only_available_for_supported_model_sources() {
    let input = "openai-compatibility:\n  - name: Relay\n    base-url: https://example.com/v1\n    models:\n      - name: gpt-test\n      - name: deepseek-chat\n";
    let available_models = test_agent_models(&["gpt-test", "deepseek-chat"]);
    let sources =
        resolved_oauth_alias_sources(input, &[], &available_models, AliasSourceCapability::Fast)
            .unwrap();

    assert_eq!(sources.len(), 2);
    assert!(sources
        .iter()
        .any(|source| source.source.model == "gpt-test"));
    assert!(sources
        .iter()
        .any(|source| source.source.model == "deepseek-chat"));

    // API source IDs carry a revision of their provider entry, so use the
    // resolved source rather than a hand-built one.
    let deepseek_source = sources
        .iter()
        .find(|source| source.source.model == "deepseek-chat")
        .unwrap();
    let deepseek_fast = add_speed_alias_to_yaml(input, deepseek_source, "deepseek-fast").unwrap();
    assert!(
        deepseek_fast.contains("service_tier: priority"),
        "{deepseek_fast}"
    );

    let antigravity_source = ResolvedThinkingAliasSource {
        source: ThinkingAliasSource {
            id: "antigravity-oauth:gpt-test".to_string(),
            model: "gpt-test".to_string(),
            display_name: None,
            provider: "Antigravity OAuth".to_string(),
            kind: "antigravity-oauth".to_string(),
            protocol: "antigravity".to_string(),
            reasoning_levels: vec!["low".to_string(), "high".to_string()],
        },
        location: ThinkingAliasSourceLocation::Oauth {
            channel: "antigravity",
            force_mapping: true,
        },
    };
    let antigravity_fast_sources = resolved_oauth_alias_sources(
        "{}\n",
        &[test_oauth_definition_set("antigravity", &["gpt-test"])],
        &test_agent_models(&["gpt-test"]),
        AliasSourceCapability::Fast,
    )
    .unwrap();
    assert!(antigravity_fast_sources.is_empty());
    assert!(add_speed_alias_to_yaml("{}\n", &antigravity_source, "gpt-fast").is_err());
}

#[test]
fn thinking_alias_adds_fork_and_matching_payload_rule() {
    let input = "# Keep this comment\ndebug: true\npayload:\n  override:\n    - models:\n        - name: existing-fast\n          protocol: codex\n      params:\n        service_tier: priority\n";
    let source = test_codex_oauth_thinking_source("gpt-5.5");
    let rendered =
        add_model_alias_to_yaml(input, &source, "gpt-5.5-xhigh", "xhigh", false).unwrap();
    let aliases = thinking_aliases_from_yaml(&rendered).unwrap();

    assert!(rendered.contains("# Keep this comment"), "{rendered}");
    assert!(rendered.contains("service_tier: priority"), "{rendered}");
    assert_eq!(
        aliases,
        vec![ThinkingAliasEntry {
            source_model: "gpt-5.5".to_string(),
            alias: "gpt-5.5-xhigh".to_string(),
            effort: Some("xhigh".to_string()),
            provider: "Codex OAuth".to_string(),
            kind: "codex-oauth".to_string(),
            oauth_channel: Some("codex".to_string()),
        }]
    );
}

#[test]
fn model_alias_can_be_created_without_overrides() {
    let source = test_codex_oauth_thinking_source("gpt-5.5");
    let rendered = add_model_alias_to_yaml("{}\n", &source, "gpt-5.5-alias", "", false).unwrap();

    assert!(rendered.contains("alias: gpt-5.5-alias"), "{rendered}");
    assert!(!rendered.contains("payload:"), "{rendered}");
    assert_eq!(
        thinking_aliases_from_yaml(&rendered).unwrap(),
        vec![ThinkingAliasEntry {
            source_model: "gpt-5.5".to_string(),
            alias: "gpt-5.5-alias".to_string(),
            effort: None,
            provider: "Codex OAuth".to_string(),
            kind: "codex-oauth".to_string(),
            oauth_channel: Some("codex".to_string()),
        }]
    );
}

#[test]
fn configured_model_alias_can_be_created_without_overrides() {
    let input = "codex-api-key:\n  - api-key: test\n    base-url: https://example.com/v1\n    models:\n      - name: gpt-custom\n";
    let available_models = test_agent_models(&["gpt-custom"]);
    let sources = resolved_alias_sources(input, &[], &available_models, false).unwrap();
    let source = sources
        .iter()
        .find(|source| source.source.model == "gpt-custom")
        .unwrap();
    let rendered = add_model_alias_to_yaml(input, source, "gpt-custom-alias", "", false).unwrap();

    assert!(rendered.contains("alias: gpt-custom-alias"), "{rendered}");
    assert!(!rendered.contains("thinking:"), "{rendered}");
    assert!(!rendered.contains("payload:"), "{rendered}");
    let entries = thinking_aliases_from_yaml(&rendered).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].effort, None);
}

#[test]
fn thinking_alias_removal_cleans_legacy_combined_rules() {
    let legacy = "oauth-model-alias:\n  codex:\n    - name: gpt-5.6-sol\n      alias: legacy-combined\n      fork: true\npayload:\n  override:\n    - models:\n        - name: legacy-combined\n          protocol: codex\n      params:\n        reasoning.effort: high\n    - models:\n        - name: legacy-combined\n          protocol: codex\n      params:\n        service_tier: priority\n";
    let restored = remove_thinking_alias_from_yaml(legacy, "legacy-combined").unwrap();
    assert!(!restored.contains("legacy-combined"), "{restored}");
    assert!(!restored.contains("service_tier: priority"), "{restored}");
}

#[test]
fn model_alias_combines_reasoning_and_fast_as_independent_overrides() {
    let source = test_codex_oauth_thinking_source("gpt-5.6-sol");
    let alias = "gpt-5.6-sol-high-fast";
    let rendered = add_model_alias_to_yaml("{}\n", &source, alias, "high", true).unwrap();

    assert!(rendered.contains("reasoning.effort: high"), "{rendered}");
    assert!(rendered.contains("service_tier: priority"), "{rendered}");
    let document: serde_norway::Value = serde_norway::from_str(&rendered).unwrap();
    let root = document.as_mapping().unwrap();
    let rules = nested_yaml_value(root, &["payload", "override"])
        .and_then(serde_norway::Value::as_sequence)
        .unwrap();
    let alias_rules = rules
        .iter()
        .filter_map(serde_norway::Value::as_mapping)
        .filter(|rule| {
            yaml_mapping_value(rule, "models")
                .and_then(serde_norway::Value::as_sequence)
                .is_some_and(|models| {
                    models
                        .iter()
                        .any(|model| thinking_payload_model_matches(model, alias, "codex"))
                })
        })
        .collect::<Vec<_>>();

    assert_eq!(alias_rules.len(), 2, "{rendered}");
    assert!(alias_rules.iter().any(|rule| {
        yaml_mapping_value(rule, "params")
            .and_then(serde_norway::Value::as_mapping)
            .is_some_and(|params| {
                yaml_mapping_value(params, "reasoning.effort").is_some()
                    && yaml_mapping_value(params, "service_tier").is_none()
            })
    }));
    assert!(alias_rules.iter().any(|rule| {
        yaml_mapping_value(rule, "params")
            .and_then(serde_norway::Value::as_mapping)
            .is_some_and(|params| {
                yaml_mapping_value(params, "service_tier").is_some()
                    && yaml_mapping_value(params, "reasoning.effort").is_none()
            })
    }));
    assert_eq!(thinking_aliases_from_yaml(&rendered).unwrap().len(), 1);
    assert_eq!(speed_aliases_from_yaml(&rendered).unwrap().len(), 1);

    let restored = remove_thinking_alias_from_yaml(&rendered, alias).unwrap();
    assert!(!restored.contains(alias), "{restored}");
}

#[test]
fn speed_alias_adds_fast_service_tier_and_removes_only_its_rule() {
    let input = "payload:\n  override:\n    - models:\n        - name: existing-thinker\n          protocol: codex\n      params:\n        reasoning.effort: xhigh\n";
    let source = test_codex_oauth_thinking_source("gpt-5.6-sol");
    let rendered = add_speed_alias_to_yaml(input, &source, "gpt-5.6-sol-fast").unwrap();

    assert!(rendered.contains("alias: gpt-5.6-sol-fast"), "{rendered}");
    assert!(rendered.contains("service_tier: priority"), "{rendered}");
    assert!(!rendered.contains("reasoning.effort: fast"), "{rendered}");
    assert_eq!(
        speed_aliases_from_yaml(&rendered).unwrap(),
        vec![SpeedAliasEntry {
            source_model: "gpt-5.6-sol".to_string(),
            alias: "gpt-5.6-sol-fast".to_string(),
            service_tier: "priority".to_string(),
            provider: "Codex OAuth".to_string(),
            kind: "codex-oauth".to_string(),
            oauth_channel: Some("codex".to_string()),
        }]
    );

    let restored = remove_speed_alias_from_yaml(&rendered, "gpt-5.6-sol-fast").unwrap();
    assert!(!restored.contains("gpt-5.6-sol-fast"), "{restored}");
    assert!(restored.contains("reasoning.effort: xhigh"), "{restored}");
}

#[test]
fn speed_alias_supports_openai_compatible_model_entries() {
    let input = "openai-compatibility:\n  - name: Relay\n    base-url: https://example.com/v1\n    api-key-entries:\n      - api-key: test\n    models:\n      - name: gpt-5.6-terra\n        display-name: Terra\n";
    let available_models = test_agent_models(&["gpt-5.6-terra"]);
    let sources = resolved_thinking_alias_sources(input, &[], &available_models).unwrap();
    let source = sources
        .iter()
        .find(|source| source.source.model == "gpt-5.6-terra")
        .unwrap();
    let rendered = add_speed_alias_to_yaml(input, source, "gpt-5.6-terra-fast").unwrap();

    assert!(rendered.contains("alias: gpt-5.6-terra-fast"), "{rendered}");
    assert!(
        rendered.contains("display-name: Terra (Fast)"),
        "{rendered}"
    );
    assert!(rendered.contains("protocol: openai"), "{rendered}");
    assert!(rendered.contains("service_tier: priority"), "{rendered}");
    assert_eq!(speed_aliases_from_yaml(&rendered).unwrap().len(), 1);

    let restored = remove_speed_alias_from_yaml(&rendered, "gpt-5.6-terra-fast").unwrap();
    assert!(!restored.contains("gpt-5.6-terra-fast"), "{restored}");
}

#[test]
fn speed_alias_sources_include_codex_models_without_reasoning_levels() {
    let definitions = vec![CodexModelDefinition {
        id: "gpt-speed-only".to_string(),
        display_name: None,
        description: None,
        context_window: None,
        reasoning_levels: Vec::new(),
        supports_tools: None,
    }];
    let available_models = test_agent_models(&["gpt-speed-only"]);

    assert!(
        resolved_thinking_alias_sources("{}", &definitions, &available_models)
            .unwrap()
            .is_empty()
    );
    let sources = resolved_speed_alias_sources("{}", &definitions, &available_models).unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].source.model, "gpt-speed-only");
}

#[test]
fn thinking_alias_effort_accepts_provider_defined_levels() {
    assert_eq!(validate_thinking_alias_effort(" AUTO ").unwrap(), "auto");
    assert_eq!(validate_thinking_alias_effort("ultra").unwrap(), "ultra");
    assert_eq!(
        validate_thinking_alias_effort("vendor_level-2.1").unwrap(),
        "vendor_level-2.1"
    );
    assert!(validate_thinking_alias_effort("").is_err());
    assert!(validate_thinking_alias_effort("high value").is_err());
    assert!(validate_thinking_alias_effort("32768").is_err());
}

#[test]
fn existing_aliases_with_spaces_can_be_loaded_and_deleted() {
    assert_eq!(
        existing_thinking_alias_model_id(" Codex Auto Review ", "Alias model").unwrap(),
        "Codex Auto Review"
    );
    assert!(validate_thinking_alias_model_id("Codex Auto Review", "Alias model").is_err());
    assert_eq!(
        existing_thinking_alias_model_id(&"a".repeat(240), "Alias model").unwrap(),
        "a".repeat(240)
    );
    for invalid in ["  ", "line\nbreak", &"a".repeat(241)] {
        assert!(existing_thinking_alias_model_id(invalid, "Alias model").is_err());
    }
    let content = "codex-api-key:\n  - name: provider\n    base-url: https://example.test\n    models:\n      - name: codex-auto-review\n        alias: Codex Auto Review\n      - name: codex-auto-review\n        alias: Codex Fast Review\n      - name: keep-me\npayload:\n  override:\n    - models:\n        - name: Codex Fast Review\n          protocol: codex\n      params:\n        service_tier: priority\n";
    let entries = thinking_aliases_from_yaml(content).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].alias, "Codex Auto Review");
    assert_eq!(entries[0].source_model, "codex-auto-review");
    let deleted = remove_thinking_alias_from_yaml(content, "Codex Auto Review").unwrap();
    assert!(thinking_aliases_from_yaml(&deleted).unwrap().is_empty());
    assert!(deleted.contains("name: keep-me"));
    assert!(!deleted.contains("Codex Auto Review"));
    let speed_entries = speed_aliases_from_yaml(&deleted).unwrap();
    assert_eq!(speed_entries.len(), 1);
    assert_eq!(speed_entries[0].alias, "Codex Fast Review");
    let deleted = remove_speed_alias_from_yaml(&deleted, "Codex Fast Review").unwrap();
    assert!(speed_aliases_from_yaml(&deleted).unwrap().is_empty());
    assert!(!deleted.contains("Codex Fast Review"));
    assert!(!deleted.contains("payload:"), "{deleted}");
    assert!(deleted.contains("name: keep-me"));
}

#[test]
fn thinking_alias_removal_keeps_other_models_in_grouped_rule() {
    let input = "oauth-model-alias:\n  codex:\n    - name: gpt-5.5\n      alias: gpt-5.5-xhigh\n      fork: true\n    - name: gpt-5.4\n      alias: gpt-5.4-xhigh\n      fork: true\npayload:\n  override:\n    - models:\n        - name: gpt-5.5-xhigh\n          protocol: codex\n        - name: gpt-5.4-xhigh\n          protocol: codex\n      params:\n        reasoning.effort: xhigh\n";
    let rendered = remove_thinking_alias_from_yaml(input, "gpt-5.5-xhigh").unwrap();
    let aliases = thinking_aliases_from_yaml(&rendered).unwrap();

    assert_eq!(aliases.len(), 1);
    assert_eq!(aliases[0].alias, "gpt-5.4-xhigh");
    assert!(!rendered.contains("gpt-5.5-xhigh"), "{rendered}");
    assert!(rendered.contains("gpt-5.4-xhigh"), "{rendered}");
    assert!(rendered.contains("reasoning.effort: xhigh"), "{rendered}");
}

#[test]
fn thinking_alias_rejects_duplicate_client_visible_name() {
    let input = "oauth-model-alias:\n  codex:\n    - name: gpt-5.5\n      alias: gpt-5.5-high\n      fork: true\n";
    let source = test_codex_oauth_thinking_source("gpt-5.4");
    assert!(
        add_model_alias_to_yaml(input, &source, "GPT-5.5-HIGH", "high", false)
            .unwrap_err()
            .contains("already exists")
    );
}

#[test]
fn thinking_alias_supports_openai_compatible_model_entries() {
    let input = "openai-compatibility:\n  - name: DeepSeek\n    base-url: https://api.deepseek.com\n    api-key-entries:\n      - api-key: test\n    models:\n      - name: deepseek-chat\n        display-name: DeepSeek Chat\n        thinking:\n          levels: [low, medium, high]\n";
    let available_models = test_agent_models(&["deepseek-chat"]);
    let sources = resolved_thinking_alias_sources(input, &[], &available_models).unwrap();
    let source = sources
        .iter()
        .find(|source| source.source.model == "deepseek-chat")
        .unwrap();
    let rendered =
        add_model_alias_to_yaml(input, source, "deepseek-chat-high", "high", false).unwrap();
    let value: serde_norway::Value = serde_norway::from_str(&rendered).unwrap();
    let root = value.as_mapping().unwrap();
    let providers = yaml_mapping_value(root, "openai-compatibility")
        .and_then(serde_norway::Value::as_sequence)
        .unwrap();
    let models = yaml_mapping_value(providers[0].as_mapping().unwrap(), "models")
        .and_then(serde_norway::Value::as_sequence)
        .unwrap();
    let alias_model = models[1].as_mapping().unwrap();

    assert_eq!(models.len(), 2);
    assert_eq!(
        yaml_mapping_value(alias_model, "name").and_then(serde_norway::Value::as_str),
        Some("deepseek-chat")
    );
    assert_eq!(
        yaml_mapping_value(alias_model, "alias").and_then(serde_norway::Value::as_str),
        Some("deepseek-chat-high")
    );
    assert!(rendered.contains("protocol: openai"), "{rendered}");
    assert!(rendered.contains("reasoning_effort: high"), "{rendered}");
    assert!(rendered.contains("thinking.type: enabled"), "{rendered}");
    assert!(!rendered.contains("oauth-model-alias"), "{rendered}");

    let entries = thinking_aliases_from_yaml(&rendered).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].provider, "DeepSeek");
    assert_eq!(entries[0].kind, "openai-compatible");

    let restored = remove_thinking_alias_from_yaml(&rendered, "deepseek-chat-high").unwrap();
    assert!(!restored.contains("deepseek-chat-high"), "{restored}");
    assert!(!restored.contains("reasoning_effort"), "{restored}");
}

#[test]
fn thinking_alias_supports_codex_api_model_entries() {
    let input = "codex-api-key:\n  - api-key: test\n    base-url: https://example.com/v1\n    models:\n      - name: gpt-custom\n";
    let available_models = test_agent_models(&["gpt-custom"]);
    let sources = resolved_thinking_alias_sources(input, &[], &available_models).unwrap();
    let source = sources
        .iter()
        .find(|source| source.source.kind == "codex-api")
        .unwrap();
    let rendered =
        add_model_alias_to_yaml(input, source, "gpt-custom-xhigh", "xhigh", false).unwrap();

    assert!(rendered.contains("alias: gpt-custom-xhigh"), "{rendered}");
    assert!(rendered.contains("protocol: codex"), "{rendered}");
    assert!(rendered.contains("reasoning.effort: xhigh"), "{rendered}");
    assert!(!rendered.contains("oauth-model-alias"), "{rendered}");
    let entries = thinking_aliases_from_yaml(&rendered).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].kind, "codex-api");
}

#[test]
fn speed_alias_supports_codex_api_model_entries() {
    let input = "codex-api-key:\n  - api-key: test\n    base-url: https://example.com/v1\n    models:\n      - name: codex-custom\n";
    let available_models = test_agent_models(&["codex-custom"]);
    let sources = resolved_speed_alias_sources(input, &[], &available_models).unwrap();
    let source = sources
        .iter()
        .find(|source| source.source.kind == "codex-api")
        .unwrap();
    let rendered = add_speed_alias_to_yaml(input, source, "codex-custom-fast").unwrap();

    assert!(rendered.contains("alias: codex-custom-fast"), "{rendered}");
    assert!(rendered.contains("protocol: codex"), "{rendered}");
    assert!(rendered.contains("service_tier: priority"), "{rendered}");
    assert!(!rendered.contains("oauth-model-alias"), "{rendered}");
    let entries = speed_aliases_from_yaml(&rendered).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].kind, "codex-api");
}

#[test]
fn model_overrides_detect_only_channel_catalog_ids_in_yaml_order() {
    let input = "oauth-model-alias:\n  claude:\n    - name: claude-opus-5\n      alias: fable-max\n    - name: claude-opus-5[1m]\n      alias: claude-fable-5-1[1M]\n      force-mapping: true\n    - name: claude-opus-5\n      alias: claude-fable-5-1\n    - name: claude-opus-5\n      alias: gpt-test\n  codex:\n    - name: gpt-upstream\n      alias: gpt-test\n  kimi:\n    - name: kimi-upstream\n      alias: claude-fable-5-1\n";
    let definitions = [
        test_oauth_definition_set("claude", &["claude-fable-5-1", "claude-opus-5"]),
        test_oauth_definition_set("codex", &["gpt-test"]),
    ];
    let entries = model_overrides_from_yaml(input, &definitions).unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(
        entries[0],
        ModelOverrideEntry {
            requested_model: "claude-fable-5-1[1M]".to_string(),
            upstream_model: "claude-opus-5[1m]".to_string(),
            oauth_channel: "claude".to_string(),
            provider: "Claude OAuth".to_string(),
            kind: "claude-oauth".to_string(),
            force_mapping: true,
            long_context: true,
        }
    );
    assert_eq!(entries[1].requested_model, "claude-fable-5-1");
    assert!(!entries[1].force_mapping);
    assert!(!entries[1].long_context);
    assert_eq!(entries[2].oauth_channel, "codex");
    assert!(model_overrides_from_yaml(input, &[]).unwrap().is_empty());
}

#[test]
fn model_overrides_add_pair_without_payload_and_respect_force_mapping() {
    let source = test_oauth_thinking_source("claude", "claude-opus-5");
    let definitions = [test_oauth_definition_set("claude", &["claude-fable-5-1"])];
    let rendered = add_model_override_to_yaml(
        "# keep\ndebug: true\n",
        &source,
        "claude-fable-5-1",
        true,
        true,
    )
    .unwrap();
    let entries = model_overrides_from_yaml(&rendered, &definitions).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].upstream_model, "claude-opus-5");
    assert_eq!(entries[1].upstream_model, "claude-opus-5[1m]");
    assert_eq!(entries[1].requested_model, "claude-fable-5-1[1m]");
    assert!(entries.iter().all(|entry| entry.force_mapping));
    assert!(!rendered.contains("payload:"));
    assert!(rendered.contains("# keep"));
    let unforced =
        add_model_override_to_yaml("{}\n", &source, "claude-fable-5-1", false, false).unwrap();
    assert!(!unforced.contains("force-mapping"));
    assert_eq!(
        model_overrides_from_yaml(&unforced, &definitions)
            .unwrap()
            .len(),
        1
    );
    let suffixed =
        add_model_override_to_yaml("{}\n", &source, "claude-fable-5-1[1M]", false, true).unwrap();
    assert_eq!(
        model_overrides_from_yaml(&suffixed, &definitions)
            .unwrap()
            .len(),
        1
    );
    let forced_source = test_oauth_thinking_source("antigravity", "upstream");
    assert!(
        add_model_override_to_yaml("{}\n", &forced_source, "requested", false, false)
            .unwrap()
            .contains("force-mapping: true")
    );
}

#[test]
fn model_overrides_reject_same_model_duplicates_and_non_oauth_sources() {
    let mut source = test_oauth_thinking_source("claude", "claude-opus-5");
    assert_eq!(
        add_model_override_to_yaml("{}\n", &source, "CLAUDE-OPUS-5", true, false).unwrap_err(),
        "The requested model cannot be the same as the upstream model"
    );
    let rendered =
        add_model_override_to_yaml("{}\n", &source, "claude-fable-5-1", true, true).unwrap();
    assert_eq!(
        add_model_override_to_yaml(&rendered, &source, "CLAUDE-FABLE-5-1", false, false)
            .unwrap_err(),
        "CLAUDE-FABLE-5-1 is already routed or aliased; remove it first"
    );
    let twin_only =
        add_model_override_to_yaml("{}\n", &source, "claude-fable-5-1[1m]", false, false).unwrap();
    assert_eq!(
        add_model_override_to_yaml(&twin_only, &source, "claude-fable-5-1", false, true)
            .unwrap_err(),
        "claude-fable-5-1[1m] is already routed or aliased; remove it first"
    );
    source.location = ThinkingAliasSourceLocation::ConfigModel {
        section: "claude-api-key",
        provider_index: 0,
        model_index: 0,
    };
    assert_eq!(
        add_model_override_to_yaml("{}\n", &source, "requested", true, false).unwrap_err(),
        "Model overrides currently support OAuth model sources only"
    );
}

#[test]
fn model_overrides_remove_pair_and_keep_payload_rules() {
    let source = test_oauth_thinking_source("codex", "gpt-upstream");
    let input = "# keep\ndebug: true\npayload:\n  override:\n    - models:\n        - name: gpt-requested\n          protocol: codex\n        - name: keep-me\n          protocol: codex\n      params:\n        reasoning.effort: high\n    - models:\n        - name: gpt-requested[1m]\n          protocol: codex\n      params:\n        service_tier: priority\n";
    let rendered = add_model_override_to_yaml(input, &source, "gpt-requested", true, true).unwrap();
    let only_base =
        remove_model_override_from_yaml(&rendered, "gpt-requested[1M]", "codex").unwrap();
    let definitions = [test_oauth_definition_set("codex", &["gpt-requested"])];
    let entries = model_overrides_from_yaml(&only_base, &definitions).unwrap();
    assert_eq!(entries.len(), 1);
    assert!(!entries[0].long_context);
    assert!(remove_model_override_from_yaml(&rendered, "gpt-requested", "claude").is_err());
    let restored = remove_model_override_from_yaml(&rendered, "gpt-requested", "codex").unwrap();
    // Overrides never write payload rules, so rules naming the requested model
    // belong to that real model and survive the route's removal.
    let payload = |content: &str| {
        serde_norway::from_str::<serde_norway::Value>(content)
            .unwrap()
            .get("payload")
            .cloned()
            .unwrap()
    };
    assert_eq!(payload(&only_base), payload(input));
    assert_eq!(payload(&restored), payload(input));
    assert!(!restored.contains("oauth-model-alias"), "{restored}");
    assert!(model_overrides_from_yaml(&restored, &definitions)
        .unwrap()
        .is_empty());
    assert!(restored.contains("service_tier: priority"), "{restored}");
    assert!(restored.contains("keep-me"));
    assert!(restored.contains("# keep"));
    assert_eq!(
        remove_model_override_from_yaml(&restored, "gpt-requested", "codex").unwrap_err(),
        "Model override gpt-requested does not exist; refresh and try again"
    );
}

#[test]
fn api_source_ids_stop_resolving_when_their_provider_entry_changes() {
    let input = "openai-compatibility:\n  - name: relay\n    base-url: https://relay.test/v1\n    models:\n      - name: model-a\n";
    let models = test_agent_models(&["model-a"]);
    let source = resolved_alias_sources(input, &[], &models, false)
        .unwrap()
        .remove(0);
    assert!(source.source.id.starts_with("openai-compatibility:0:0:"));
    // Formatting and comments are not part of the revision.
    let reformatted = "# relay\nopenai-compatibility:\n- name: relay\n  base-url: https://relay.test/v1\n  models: [{name: model-a}]\n";
    assert_eq!(
        resolved_alias_sources(reformatted, &[], &models, false)
            .unwrap()
            .remove(0)
            .source
            .id,
        source.source.id
    );
    let shifted = "openai-compatibility:\n  - name: other\n    base-url: https://other.test/v1\n    models:\n      - name: model-a\n  - name: relay\n    base-url: https://relay.test/v1\n    models:\n      - name: model-a\n";
    let edited = input.replace("relay.test", "relay-new.test");
    for changed in [shifted, edited.as_str()] {
        assert!(resolved_alias_sources(changed, &[], &models, false)
            .unwrap()
            .iter()
            .all(|candidate| candidate.source.id != source.source.id));
        for result in [
            add_model_alias_to_yaml(changed, &source, "model-a-alias", "", false),
            add_model_alias_to_yaml(changed, &source, "model-a-alias", "high", true),
            add_speed_alias_to_yaml(changed, &source, "model-a-fast"),
        ] {
            assert_eq!(
                result.unwrap_err(),
                "Original model has changed; refresh and try again"
            );
        }
    }
    assert!(add_model_alias_to_yaml(reformatted, &source, "model-a-alias", "", false).is_ok());
}

#[test]
fn alias_options_are_read_from_raw_rules_in_core_precedence() {
    let input = "oauth-model-alias:\n  codex:\n    - name: gpt-test\n      alias: raw-alias\n      fork: true\n    - name: gpt-test\n      alias: layered-alias\n      fork: true\npayload:\n  override:\n    - models:\n        - name: layered-alias\n          protocol: codex\n      params:\n        reasoning.effort: low\n        service_tier: flex\n    - models:\n        - name: layered-alias\n          protocol: codex\n      params:\n        reasoning.effort: medium\n  override-raw:\n    - models:\n        - name: raw-alias\n          protocol: codex\n      params:\n        reasoning.effort: '\"high\"'\n        service_tier: '\"priority\"'\n    - models:\n        - name: layered-alias\n          protocol: codex\n      params:\n        service_tier: '\"priority\"'\n";
    let efforts = thinking_aliases_from_yaml(input)
        .unwrap()
        .into_iter()
        .map(|entry| (entry.alias, entry.effort))
        .collect::<Vec<_>>();
    assert_eq!(
        efforts,
        [
            ("layered-alias".to_string(), Some("medium".to_string())),
            ("raw-alias".to_string(), Some("high".to_string())),
        ]
    );
    // override-raw is applied after override, so its tier wins.
    let tiers = speed_aliases_from_yaml(input)
        .unwrap()
        .into_iter()
        .map(|entry| (entry.alias, entry.service_tier))
        .collect::<Vec<_>>();
    assert_eq!(
        tiers,
        [
            ("layered-alias".to_string(), "priority".to_string()),
            ("raw-alias".to_string(), "priority".to_string()),
        ]
    );
}

#[test]
fn protocol_less_payload_entries_apply_to_every_alias_protocol() {
    for protocol in ["", "\n          protocol: ''"] {
        let input = format!("oauth-model-alias:\n  codex:\n    - name: gpt-test\n      alias: shared\n      fork: true\npayload:\n  override:\n    - models:\n        - name: shared{protocol}\n      params:\n        reasoning.effort: high\n        service_tier: priority\n    - models:\n        - name: shared\n          protocol: claude\n      params:\n        reasoning.effort: low\n");
        let entries = thinking_aliases_from_yaml(&input).unwrap();
        assert_eq!(entries[0].effort.as_deref(), Some("high"), "{input}");
        assert_eq!(speed_aliases_from_yaml(&input).unwrap().len(), 1);
    }
}

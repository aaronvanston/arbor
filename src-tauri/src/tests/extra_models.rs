use super::support::*;
use super::*;

/// The plugins section as the core's own template has it.
const TEMPLATE: &str = r#"config-version: 8
# Where the proxy listens.
server:
  port: 8317

plugins:
  enabled: false
  dir: "plugins"
  # Additional plugin store registries. The built-in official registry is always included.
  # store-sources:
  #   - "https://example.com/cliproxy-plugins/registry.json"

  configs:
    example:
      enabled: true
      priority: 1
      config1: true
"#;

fn yaml_json(content: &str) -> serde_json::Value {
    serde_json::to_value(serde_norway::from_str::<serde_norway::Value>(content).unwrap()).unwrap()
}

fn core_file(name: &str, content: &str) -> (PathBuf, PathBuf) {
    let home = agent_test_home(name);
    let path = home.join("config.yaml");
    fs::write(&path, content).unwrap();
    (home, path)
}

fn sonnet() -> ExtraModel {
    ExtraModel {
        id: "claude-sonnet-5-5".to_string(),
        display_name: Some("Claude Sonnet 5.5".to_string()),
        context_length: Some(1_000_000),
        max_completion_tokens: Some(128_000),
        thinking: Some(ExtraModelThinking {
            levels: vec!["low".to_string(), "high".to_string()],
            zero_allowed: true,
            dynamic_allowed: true,
            ..ExtraModelThinking::default()
        }),
        input_modalities: vec!["text".to_string(), "image".to_string()],
        output_modalities: vec!["text".to_string()],
        ..ExtraModel::default()
    }
}

fn plain(id: &str) -> ExtraModel {
    ExtraModel { id: id.to_string(), ..ExtraModel::default() }
}

#[test]
fn the_first_extra_model_turns_plugins_on_and_keeps_the_file_as_it_was() {
    let (home, path) = core_file("extra-models-first", TEMPLATE);
    let write = write_extra_models_at(&path, "claude", &[], &[sonnet()]).unwrap().unwrap();
    assert_eq!(write.previous, TEMPLATE);
    let saved = fs::read_to_string(&path).unwrap();
    assert_eq!(saved, write.written);
    assert!(saved.contains("# Where the proxy listens."), "{saved}");
    assert!(saved.contains("# Additional plugin store registries."), "{saved}");
    let document = yaml_json(&saved);
    assert_eq!(document["plugins"]["enabled"], true);
    assert_eq!(document["plugins"]["dir"], "plugins");
    // The template's example is left as it was: with no file of its own, the core has nothing to load for it.
    assert_eq!(document["plugins"]["configs"]["example"], yaml_json(TEMPLATE)["plugins"]["configs"]["example"]);
    assert_eq!(
        document["plugins"]["configs"]["arbor-models"],
        serde_json::json!({
            "enabled": true,
            "priority": 1,
            "provider": "claude",
            "models": [{
                "id": "claude-sonnet-5-5",
                "display-name": "Claude Sonnet 5.5",
                "context-length": 1000000,
                "max-completion-tokens": 128000,
                "thinking": { "levels": ["low", "high"], "zero-allowed": true, "dynamic-allowed": true },
                "input-modalities": ["text", "image"],
                "output-modalities": ["text"],
            }],
        })
    );
    assert_eq!(extra_models_from_yaml(&saved, "claude").unwrap(), vec![sonnet()]);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn a_file_without_a_plugins_section_gets_one() {
    let file = "config-version: 8\nserver:\n  port: 8317\n";
    let (home, path) = core_file("extra-models-no-plugins", file);
    write_extra_models_at(&path, "claude", &[], &[plain("claude-opus-6")]).unwrap().unwrap();
    let document = yaml_json(&fs::read_to_string(&path).unwrap());
    assert_eq!(document["server"]["port"], 8317);
    assert_eq!(document["plugins"]["enabled"], true);
    assert_eq!(document["plugins"]["configs"]["arbor-models"]["models"], serde_json::json!([{ "id": "claude-opus-6" }]));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn extra_models_are_written_as_a_block_list_each_time() {
    let (home, path) = core_file("extra-models-block", TEMPLATE);
    write_extra_models_at(&path, "claude", &[], &[sonnet()]).unwrap().unwrap();
    // The same number of models, one of them changed.
    write_extra_models_at(&path, "claude", &[sonnet()], &[plain("claude-opus-6")]).unwrap().unwrap();
    write_extra_models_at(&path, "claude", &[plain("claude-opus-6")], &[plain("claude-opus-6"), sonnet()]).unwrap().unwrap();
    let saved = fs::read_to_string(&path).unwrap();
    let entry = saved.split("    arbor-models:\n").nth(1).unwrap();
    assert!(
        entry.starts_with("      models:\n        - id: \"claude-opus-6\"\n        - id: \"claude-sonnet-5-5\"\n          display-name: \"Claude Sonnet 5.5\"\n          context-length: 1000000\n"),
        "{saved}"
    );
    assert!(entry.contains("          thinking:\n            levels:\n              - \"low\"\n"), "{saved}");
    assert_eq!(extra_models_from_yaml(&saved, "claude").unwrap(), vec![plain("claude-opus-6"), sonnet()]);
    assert!(saved.contains("# Additional plugin store registries."), "{saved}");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn an_entry_of_only_models_is_edited_in_place() {
    let file = "plugins:\n  enabled: true\n  configs:\n    arbor-models:\n      models: [{id: claude-opus-6}]\n";
    let (home, path) = core_file("extra-models-only-list", file);
    write_extra_models_at(&path, "claude", &[plain("claude-opus-6")], &[plain("claude-opus-7")]).unwrap().unwrap();
    let saved = fs::read_to_string(&path).unwrap();
    assert_eq!(extra_models_from_yaml(&saved, "claude").unwrap(), vec![plain("claude-opus-7")]);
    assert_eq!(yaml_json(&saved)["plugins"]["configs"]["arbor-models"]["provider"], "claude");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn a_priority_the_owner_set_stays() {
    let file = "config-version: 8\nplugins:\n  enabled: true\n  configs:\n    arbor-models:\n      enabled: true\n      priority: 7\n      provider: claude\n      models: []\n";
    let (home, path) = core_file("extra-models-priority", file);
    write_extra_models_at(&path, "claude", &[], &[plain("claude-opus-6")]).unwrap().unwrap();
    assert_eq!(yaml_json(&fs::read_to_string(&path).unwrap())["plugins"]["configs"]["arbor-models"]["priority"], 7);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn taking_the_last_extra_model_out_leaves_the_plugin_serving_nothing() {
    let (home, path) = core_file("extra-models-last", TEMPLATE);
    write_extra_models_at(&path, "claude", &[], &[sonnet(), plain("claude-opus-6")]).unwrap().unwrap();
    write_extra_models_at(&path, "claude", &[sonnet(), plain("claude-opus-6")], &[plain("claude-opus-6")]).unwrap().unwrap();
    assert_eq!(extra_models_from_yaml(&fs::read_to_string(&path).unwrap(), "claude").unwrap(), vec![plain("claude-opus-6")]);
    write_extra_models_at(&path, "claude", &[plain("claude-opus-6")], &[]).unwrap().unwrap();
    let document = yaml_json(&fs::read_to_string(&path).unwrap());
    assert_eq!(document["plugins"]["enabled"], true);
    assert_eq!(document["plugins"]["configs"]["arbor-models"]["enabled"], true);
    assert_eq!(document["plugins"]["configs"]["arbor-models"]["models"], serde_json::json!([]));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn saving_no_extra_models_into_a_file_without_them_writes_nothing() {
    let (home, path) = core_file("extra-models-nothing", TEMPLATE);
    assert!(write_extra_models_at(&path, "claude", &[], &[]).unwrap().is_none());
    assert!(write_extra_models_at(&path, "claude", &[], &[]).unwrap().is_none());
    assert_eq!(fs::read_to_string(&path).unwrap(), TEMPLATE);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn extra_models_changed_since_the_page_read_them_are_left_alone() {
    let (home, path) = core_file("extra-models-stale", TEMPLATE);
    write_extra_models_at(&path, "claude", &[], &[plain("claude-opus-6")]).unwrap().unwrap();
    let saved = fs::read_to_string(&path).unwrap();
    let error = write_extra_models_at(&path, "claude", &[], &[sonnet()]).unwrap_err();
    assert!(error.contains("changed while saving"), "{error}");
    assert_eq!(fs::read_to_string(&path).unwrap(), saved);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn an_extra_models_write_can_be_taken_back_out() {
    let (home, path) = core_file("extra-models-undo", TEMPLATE);
    let write = write_extra_models_at(&path, "claude", &[], &[sonnet()]).unwrap().unwrap();
    assert!(undo_config_write_at(&path, &write).unwrap());
    assert_eq!(fs::read_to_string(&path).unwrap(), TEMPLATE);

    // Not once the file has changed again.
    let write = write_extra_models_at(&path, "claude", &[], &[sonnet()]).unwrap().unwrap();
    let edited = format!("{}# edited\n", write.written);
    fs::write(&path, &edited).unwrap();
    assert!(!undo_config_write_at(&path, &write).unwrap());
    assert_eq!(fs::read_to_string(&path).unwrap(), edited);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn extra_models_the_plugin_cant_read_are_an_error() {
    let file = "plugins:\n  configs:\n    arbor-models:\n      models: {id: claude-opus-6}\n";
    let error = extra_models_from_yaml(file, "claude").unwrap_err();
    assert!(error.contains("plugins.configs.arbor-models.models"), "{error}");
    assert_eq!(extra_models_from_yaml("plugins:\n  enabled: false\n", "claude").unwrap(), Vec::new());
    assert_eq!(extra_models_from_yaml("plugins:\n  configs:\n    arbor-models:\n      models:\n", "claude").unwrap(), Vec::new());
}

#[test]
fn extra_models_are_checked_before_they_are_saved() {
    let validated = validate_extra_models(vec![ExtraModel {
        id: "  claude-opus-6 ".to_string(),
        display_name: Some("  Claude Opus 6 ".to_string()),
        description: Some("   ".to_string()),
        context_length: Some(0),
        ..ExtraModel::default()
    }])
    .unwrap();
    assert_eq!(
        validated,
        vec![ExtraModel {
            id: "claude-opus-6".to_string(),
            display_name: Some("Claude Opus 6".to_string()),
            ..ExtraModel::default()
        }]
    );
    for (models, message) in [
        (vec![plain(" ")], "cannot be empty"),
        (vec![plain("claude opus")], "whitespace"),
        (vec![plain("claude-opus-6"), plain("Claude-Opus-6")], "listed twice"),
        (vec![plain("x"); 101], "at most"),
    ] {
        let error = validate_extra_models(models).unwrap_err();
        assert!(error.contains(message), "{error}");
    }
}

#[test]
fn the_catalog_comes_from_the_cores_model_definitions() {
    let payload = serde_json::json!({
        "channel": "claude",
        "models": [
            {
                "id": "claude-sonnet-5",
                "object": "model",
                "owned_by": "anthropic",
                "type": "claude",
                "display_name": "Claude Sonnet 5",
                "context_length": 1000000,
                "max_completion_tokens": 128000,
                "thinking": { "zero_allowed": true, "dynamic_allowed": true, "levels": ["low", "max"] },
                "supportedInputModalities": ["text", "image"],
                "supportedOutputModalities": ["text"],
            },
            {
                "id": "claude-sonnet-4-20250514",
                "display_name": "Claude 4 Sonnet",
                "context_length": 200000,
                "thinking": { "min": 1024, "max": 128000 },
            },
            { "id": "" },
            { "display_name": "No id" },
        ],
    });
    let catalog = catalog_models_from_definitions(&payload);
    assert_eq!(catalog.len(), 2);
    assert_eq!(
        catalog[0],
        ExtraModel {
            id: "claude-sonnet-5".to_string(),
            display_name: Some("Claude Sonnet 5".to_string()),
            context_length: Some(1_000_000),
            max_completion_tokens: Some(128_000),
            thinking: Some(ExtraModelThinking {
                levels: vec!["low".to_string(), "max".to_string()],
                zero_allowed: true,
                dynamic_allowed: true,
                ..ExtraModelThinking::default()
            }),
            input_modalities: vec!["text".to_string(), "image".to_string()],
            output_modalities: vec!["text".to_string()],
            ..ExtraModel::default()
        }
    );
    assert_eq!(catalog[1].thinking.as_ref().and_then(|thinking| thinking.min), Some(1024));
    assert!(catalog_models_from_definitions(&serde_json::json!({ "error": "unknown channel" })).is_empty());
}

#[test]
fn the_plugin_counts_as_loaded_only_when_the_core_runs_it() {
    let list = |entry: serde_json::Value| serde_json::json!({ "plugins_enabled": true, "plugins": [entry] });
    let loaded = list(serde_json::json!({
        "id": "arbor-models", "registered": true, "enabled": true, "effective_enabled": true,
    }));
    assert!(extra_models_plugin_loaded(&loaded, "arbor-models"));
    // Each provider's copy is its own plugin.
    assert!(!extra_models_plugin_loaded(&loaded, "arbor-models-codex"));
    for entry in [
        serde_json::json!({ "id": "arbor-models", "registered": false, "enabled": true, "effective_enabled": false }),
        serde_json::json!({ "id": "arbor-models", "registered": true, "enabled": false, "effective_enabled": false }),
        serde_json::json!({ "id": "example", "registered": true, "enabled": true, "effective_enabled": true }),
    ] {
        assert!(!extra_models_plugin_loaded(&list(entry), "arbor-models"));
    }
    assert!(!extra_models_plugin_loaded(&serde_json::json!({}), "arbor-models"));
}

#[test]
fn the_bundled_plugin_is_installed_only_when_it_changed() {
    let home = agent_test_home("extra-models-plugin-install");
    let plugins_dir = home.join("core").join("plugins");
    let missing = home.join("missing.dylib");
    let bundled = home.join("bundled.dylib");
    let file = EXTRA_MODELS_PLUGIN_FILE;
    assert!(!install_core_plugin_at(&[missing.clone(), bundled.clone()], &plugins_dir, file).unwrap());
    assert!(!plugins_dir.exists());

    fs::write(&bundled, b"plugin one").unwrap();
    assert!(install_core_plugin_at(&[missing.clone(), bundled.clone()], &plugins_dir, file).unwrap());
    let installed = plugins_dir.join(EXTRA_MODELS_PLUGIN_FILE);
    assert_eq!(fs::read(&installed).unwrap(), b"plugin one");
    assert!(!install_core_plugin_at(&[bundled.clone()], &plugins_dir, file).unwrap());

    fs::write(&bundled, b"plugin two").unwrap();
    assert!(install_core_plugin_at(&[bundled.clone()], &plugins_dir, file).unwrap());
    assert_eq!(fs::read(&installed).unwrap(), b"plugin two");
    // Only the plugin itself: no temporary copies left beside it.
    assert_eq!(fs::read_dir(&plugins_dir).unwrap().count(), 1);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn the_app_bundles_plugin_comes_before_a_source_tree_build() {
    let executable_dir = Path::new("/Applications/Arbor.app/Contents/MacOS");
    assert_eq!(
        bundled_core_plugin_locations(executable_dir),
        vec![PathBuf::from("/Applications/Arbor.app/Contents/Resources/core/plugins/arbor-models.dylib")]
    );
    let project_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let locations = bundled_core_plugin_locations(&project_root.join("src-tauri").join("target").join("debug"));
    assert_eq!(
        locations,
        vec![
            project_root.join("bundled-core/plugins/arbor-models.dylib"),
            project_root.join("core-plugins/arbor-models/target/release/libarbor_models.dylib"),
        ]
    );
}

#[test]
fn a_block_entry_comes_out_with_its_value_and_nothing_after_it() {
    let file = "plugins:\n  configs:\n    arbor-models:\n      enabled: true\n      models:\n      - id: a\n        # about a\n        thinking:\n          levels: [low]\n\n      - id: b\n\n      # About the provider.\n      provider: claude\n    example:\n      enabled: true\n";
    assert_eq!(
        remove_yaml_block_mapping_entry(file, &["plugins", "configs", "arbor-models", "models"]).as_deref(),
        Some("plugins:\n  configs:\n    arbor-models:\n      enabled: true\n\n      # About the provider.\n      provider: claude\n    example:\n      enabled: true\n")
    );
    // The same key under another section, and one written inline, aren't this one.
    assert_eq!(remove_yaml_block_mapping_entry(file, &["plugins", "configs", "example", "models"]), None);
    let inline = "plugins:\n  configs:\n    arbor-models:\n      models: []\n";
    assert_eq!(remove_yaml_block_mapping_entry(inline, &["plugins", "configs", "arbor-models", "models"]), None);
}

#[test]
fn each_provider_has_its_own_copy_of_the_plugin() {
    assert_eq!(extra_models_plugin_id("claude"), "arbor-models");
    assert_eq!(extra_models_plugin_id("codex"), "arbor-models-codex");
    assert_eq!(extra_models_plugin_file("codex"), "arbor-models-codex.dylib");
    // The core takes `-v` and a digit as a version, and none of these ids ends in one.
    for provider in EXTRA_MODEL_PROVIDERS {
        let id = extra_models_plugin_id(provider);
        assert!(!id.split('-').any(|part| part.starts_with('v') && part[1..].starts_with(|c: char| c.is_ascii_digit())), "{id}");
    }
    assert_eq!(extra_models_provider(" Codex "), Some("codex"));
    assert_eq!(extra_models_provider("openai"), Some("codex"));
    assert_eq!(extra_models_provider("anthropic"), Some("claude"));
    assert_eq!(extra_models_provider("grok"), Some("xai"));
    assert_eq!(extra_models_provider("openai-compatible-foo"), None);
    assert_eq!(extra_models_provider(""), None);
}

fn gpt() -> ExtraModel {
    ExtraModel {
        id: "gpt-6-nova".to_string(),
        display_name: Some("GPT-6-Nova".to_string()),
        context_length: Some(272_000),
        thinking: Some(ExtraModelThinking {
            levels: vec!["low".to_string(), "xhigh".to_string()],
            ..ExtraModelThinking::default()
        }),
        ..ExtraModel::default()
    }
}

#[test]
fn each_providers_models_go_under_its_own_copy() {
    let (home, path) = core_file("extra-models-providers", TEMPLATE);
    write_extra_models_at(&path, "claude", &[], &[sonnet()]).unwrap().unwrap();
    write_extra_models_at(&path, "codex", &[], &[gpt()]).unwrap().unwrap();
    let saved = fs::read_to_string(&path).unwrap();
    assert!(saved.contains("# Additional plugin store registries."), "{saved}");
    let document = yaml_json(&saved);
    assert_eq!(document["plugins"]["configs"]["arbor-models"]["provider"], "claude");
    assert_eq!(document["plugins"]["configs"]["arbor-models-codex"]["provider"], "codex");
    assert_eq!(document["plugins"]["configs"]["arbor-models-codex"]["enabled"], true);
    assert_eq!(document["plugins"]["configs"]["arbor-models-codex"]["priority"], 1);
    assert_eq!(extra_models_from_yaml(&saved, "claude").unwrap(), vec![sonnet()]);
    assert_eq!(extra_models_from_yaml(&saved, "codex").unwrap(), vec![gpt()]);
    assert_eq!(
        all_extra_models_from_yaml(&saved).unwrap(),
        vec![("claude", vec![sonnet()]), ("codex", vec![gpt()])]
    );

    // One provider's save checks and changes only its own list.
    let error = write_extra_models_at(&path, "codex", &[], &[plain("gpt-7")]).unwrap_err();
    assert!(error.contains("changed while saving"), "{error}");
    write_extra_models_at(&path, "codex", &[gpt()], &[]).unwrap().unwrap();
    let saved = fs::read_to_string(&path).unwrap();
    assert_eq!(extra_models_from_yaml(&saved, "claude").unwrap(), vec![sonnet()]);
    assert_eq!(all_extra_models_from_yaml(&saved).unwrap(), vec![("claude", vec![sonnet()])]);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn the_providers_are_the_ones_with_an_account_switched_on() {
    let payload = serde_json::json!({ "files": [
        { "name": "codex.json", "provider": "codex", "status": "active" },
        { "name": "claude.json", "type": "claude", "status": "error", "unavailable": true },
        { "name": "xai.json", "provider": "xai", "disabled": true },
        { "name": "kimi.json", "provider": "kimi" },
        { "name": "compat.json", "provider": "openai-compatible-foo" },
        { "name": "codex-2.json", "provider": "codex" },
    ]});
    assert_eq!(extra_model_providers_with_accounts(&payload), vec!["claude", "codex", "kimi"]);
    assert!(extra_model_providers_with_accounts(&serde_json::json!({})).is_empty());
}

#[test]
fn an_arbor_update_refreshes_every_providers_copy_already_there() {
    let home = agent_test_home("extra-models-plugin-refresh");
    let plugins_dir = home.join("core").join("plugins");
    let bundled = home.join("bundled.dylib");
    fs::write(&bundled, b"plugin two").unwrap();
    // Nothing installed yet: a provider's copy arrives with its first extra model.
    assert!(!refresh_installed_core_plugins_at(&[bundled.clone()], &plugins_dir).unwrap());
    assert!(!plugins_dir.exists());

    fs::create_dir_all(&plugins_dir).unwrap();
    for file in ["arbor-models.dylib", "arbor-models-codex.dylib", "other-plugin.dylib"] {
        fs::write(plugins_dir.join(file), b"plugin one").unwrap();
    }
    assert!(refresh_installed_core_plugins_at(&[bundled.clone()], &plugins_dir).unwrap());
    assert_eq!(fs::read(plugins_dir.join("arbor-models.dylib")).unwrap(), b"plugin two");
    assert_eq!(fs::read(plugins_dir.join("arbor-models-codex.dylib")).unwrap(), b"plugin two");
    assert_eq!(fs::read(plugins_dir.join("other-plugin.dylib")).unwrap(), b"plugin one");
    assert!(!plugins_dir.join("arbor-models-kimi.dylib").exists());
    assert!(!refresh_installed_core_plugins_at(&[bundled], &plugins_dir).unwrap());
    fs::remove_dir_all(home).unwrap();
}

use super::support::*;
use super::*;

#[test]
fn legacy_string_api_keys_keep_custom_keys_without_special_protection() {
    let legacy = "port = 8317\nallow-lan = false\nrun-on-startup = false\nauth-dir = \"/tmp/oauth\"\napi-keys = [\"123456\", \"custom-key\"]\nmanagement-secret-key = \"123456\"\nplugins-enabled = false\nrouting-strategy = \"round-robin\"\n";
    let mut config = toml::from_str::<GuiConfigFile>(legacy).unwrap();

    assert!(!sanitize_gui_config(&mut config).unwrap());
    assert_eq!(
        gui_api_key_values(&config.api_keys),
        vec!["123456", "custom-key"]
    );
    assert!(config.api_keys[0].remark.is_empty());
    assert!(config.api_keys[1].remark.is_empty());

    let serialized = toml::to_string_pretty(&config).unwrap();
    assert!(serialized.contains("[[api-keys]]"));
    let reparsed = toml::from_str::<GuiConfigFile>(&serialized).unwrap();
    assert_eq!(reparsed.api_keys, config.api_keys);
}

#[test]
fn a_config_saved_with_the_gitcode_mirror_loads_with_github() {
    let legacy = "download-source = \"gitcode\"\nprefer-gitcode-downloads = true\nsilent-start = true\nmanagement-secret-key = \"custom-secret\"\n";
    let config = toml::from_str::<GuiConfigFile>(legacy).unwrap();
    assert_eq!(config.download_source, VersionDownloadSource::Github);
    assert_eq!(
        config.selected_download_candidate(),
        VersionDownloadCandidate::builtin(VersionDownloadSource::Github)
    );
    // The rest of the file still loads.
    assert!(config.silent_start);
    let presence = toml::from_str::<GuiConfigPresence>(legacy).unwrap();
    assert_eq!(presence.download_source, Some(VersionDownloadSource::Github));
    assert_eq!(presence.prefer_gitcode_downloads, Some(true));

    let home = agent_test_home("gitcode-config");
    let path = home.join("config.toml");
    fs::write(&path, legacy).unwrap();
    write_gui_config_to_path(&config, &path).unwrap();
    let content = fs::read_to_string(&path).unwrap();
    assert!(content.contains("download-source = \"github\""), "{content}");
    assert!(!content.contains("gitcode"), "{content}");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn a_config_saved_with_a_language_setting_still_loads() {
    let legacy = "locale = \"zh-CN\"\nsilent-start = true\nmanagement-secret-key = \"custom-secret\"\n";
    let config = toml::from_str::<GuiConfigFile>(legacy).unwrap();
    assert!(config.silent_start);
    assert!(toml::from_str::<GuiConfigPresence>(legacy).is_ok());

    let home = agent_test_home("locale-config");
    let path = home.join("config.toml");
    fs::write(&path, legacy).unwrap();
    write_gui_config_to_path(&config, &path).unwrap();
    let content = fs::read_to_string(&path).unwrap();
    assert!(!content.contains("locale"), "{content}");
    assert!(content.contains("silent-start = true"), "{content}");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn api_key_remarks_follow_matching_core_keys() {
    let existing = vec![
        default_api_key_entry(),
        GuiApiKeyEntry {
            key: "custom-key".to_string(),
            remark: "Development".to_string(),
        },
    ];
    let core_keys = vec!["custom-key".to_string(), "new-key".to_string()];

    let merged = merge_core_api_keys_with_gui_metadata(&existing, &core_keys, None);

    assert_eq!(gui_api_key_values(&merged), vec!["custom-key", "new-key"]);
    assert_eq!(merged[0].remark, "Development");
    assert!(merged[1].remark.is_empty());
}

#[test]
fn a_key_a_command_just_added_keeps_its_remark_when_the_core_settings_come_back() {
    let mut config = GuiConfigFile {
        api_keys: vec![GuiApiKeyEntry {
            key: "desk-key".to_string(),
            remark: "Desk".to_string(),
        }],
        ..GuiConfigFile::default()
    };
    let core_settings = CoreConfigSettings {
        api_keys: vec!["desk-key".to_string(), "laptop-key".to_string()],
        ..CoreConfigSettings::from(&config)
    };
    let added = GuiApiKeyEntry {
        key: "laptop-key".to_string(),
        remark: "Laptop".to_string(),
    };

    apply_core_settings_to_gui_config(&mut config, &core_settings, Some(&added));

    assert_eq!(gui_api_key_values(&config.api_keys), vec!["desk-key", "laptop-key"]);
    assert_eq!(config.api_keys[0].remark, "Desk");
    assert_eq!(config.api_keys[1].remark, "Laptop");
}

#[test]
fn explicit_empty_api_key_list_stays_empty() {
    let existing = vec![default_api_key_entry()];
    assert!(merge_core_api_keys_with_gui_metadata(&existing, &[], None).is_empty());

    let mut config = GuiConfigFile {
        api_keys: Vec::new(),
        ..GuiConfigFile::default()
    };
    sanitize_gui_config(&mut config).unwrap();
    assert!(config.api_keys.is_empty());

    let content = toml::to_string_pretty(&config).unwrap();
    let restored = toml::from_str::<GuiConfigFile>(&content).unwrap();
    assert!(restored.api_keys.is_empty());
}

#[test]
fn initial_default_api_key_can_be_edited_and_deleted() {
    let mut api_keys = vec![DEFAULT_API_KEY.to_string()];

    replace_core_api_key_value(&mut api_keys, DEFAULT_API_KEY, "custom-key".to_string()).unwrap();
    assert_eq!(api_keys, vec!["custom-key"]);

    remove_core_api_key_value(&mut api_keys, "custom-key").unwrap();
    assert!(api_keys.is_empty());
}

#[test]
fn core_config_view_exposes_api_key_metadata_for_the_webview() {
    let mut config = GuiConfigFile::default();
    ensure_strong_management_secret(&mut config).unwrap();
    let view = serde_json::to_value(CoreConfigView::from(&config)).unwrap();

    assert_eq!(view["apiKeys"][0]["apiKey"], DEFAULT_API_KEY);
    assert_eq!(view["apiKeys"][0]["remark"], DEFAULT_API_KEY_INITIAL_REMARK);
    assert!(view["apiKeys"][0].get("builtIn").is_none());
    assert_eq!(view["managementSecretConfigured"], true);
    assert!(view.get("managementSecretKey").is_none());
}

#[test]
fn pausing_takes_a_key_out_by_its_hash_but_never_the_last_one() {
    let mut api_keys = vec!["laptop-key".to_string(), "runner-key".to_string()];

    let taken = take_core_api_key_by_hash(&mut api_keys, &usage::hash_text("runner-key")).unwrap();
    assert_eq!(taken, "runner-key");
    assert_eq!(api_keys, vec!["laptop-key"]);

    // An empty list would let any client in, so the last key stays.
    assert!(take_core_api_key_by_hash(&mut api_keys, &usage::hash_text("laptop-key")).is_err());
    assert_eq!(api_keys, vec!["laptop-key"]);

    assert!(take_core_api_key_by_hash(&mut api_keys, &usage::hash_text("unknown-key")).is_err());
    assert!(take_core_api_key_by_hash(&mut api_keys, "").is_err());
}

#[test]
fn paused_keys_are_kept_once_and_only_while_the_core_is_without_them() {
    let entry = |key: &str, remark: &str| GuiApiKeyEntry {
        key: key.to_string(),
        remark: remark.to_string(),
    };
    let mut config = GuiConfigFile {
        api_keys: vec![entry("laptop-key", "Laptop"), entry("runner-key", "Runner")],
        paused_api_keys: vec![
            entry(" paused-key ", " Cedar "),
            entry("paused-key", "Duplicate"),
            // Added back by hand, so it isn't paused any more.
            entry("runner-key", "Runner"),
            entry("  ", "Blank"),
        ],
        ..GuiConfigFile::default()
    };

    assert!(sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.paused_api_keys, vec![entry("paused-key", "Cedar")]);
    assert!(!sanitize_gui_config(&mut config).unwrap());

    // The core only ever gets the active keys; the paused one survives a round trip.
    assert_eq!(
        CoreConfigSettings::from(&config).api_keys,
        vec!["laptop-key", "runner-key"]
    );
    let restored = toml::from_str::<GuiConfigFile>(&toml::to_string_pretty(&config).unwrap()).unwrap();
    assert_eq!(restored.paused_api_keys, config.paused_api_keys);
    assert!(toml::from_str::<GuiConfigFile>("port = 8317\n").unwrap().paused_api_keys.is_empty());

    let view = serde_json::to_value(CoreConfigView::from(&config)).unwrap();
    assert_eq!(view["apiKeys"][1]["apiKeyHash"], usage::hash_text("runner-key"));
    assert_eq!(view["pausedApiKeys"][0]["apiKey"], "paused-key");
    assert_eq!(view["pausedApiKeys"][0]["apiKeyHash"], usage::hash_text("paused-key"));
    assert_eq!(view["pausedApiKeys"][0]["remark"], "Cedar");
}

#[test]
fn webui_management_secret_requires_a_non_empty_plaintext_value() {
    assert_eq!(
        normalize_management_secret_key("  new-webui-secret  ".to_string()).unwrap(),
        "new-webui-secret"
    );
    assert!(normalize_management_secret_key("   ".to_string()).is_err());
    assert!(normalize_management_secret_key(
        "$2a$10$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuu".to_string()
    )
    .is_err());
    assert!(normalize_management_secret_key("bad\nsecret".to_string()).is_err());
    assert!(normalize_management_secret_key("123456".to_string()).is_err());
}

#[test]
fn management_secret_rotation_replaces_legacy_values_and_preserves_custom_values() {
    let mut fresh = GuiConfigFile::default();
    assert!(ensure_strong_management_secret(&mut fresh).unwrap());
    assert!(fresh.management_secret_key.starts_with("wui-Aa9_"));
    assert!(fresh.management_secret_key.len() >= 50);
    assert!(!management_secret_requires_rotation(
        &fresh.management_secret_key
    ));

    let first_generated = fresh.management_secret_key.clone();
    let mut legacy = GuiConfigFile {
        management_secret_key: LEGACY_DEFAULT_MANAGEMENT_SECRET_KEY.to_string(),
        ..GuiConfigFile::default()
    };
    assert!(ensure_strong_management_secret(&mut legacy).unwrap());
    assert_ne!(
        legacy.management_secret_key,
        LEGACY_DEFAULT_MANAGEMENT_SECRET_KEY
    );
    assert_ne!(legacy.management_secret_key, first_generated);

    let mut hashed = GuiConfigFile {
        management_secret_key: "$2a$10$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuu"
            .to_string(),
        ..GuiConfigFile::default()
    };
    assert!(ensure_strong_management_secret(&mut hashed).unwrap());
    assert!(hashed.management_secret_key.starts_with("wui-Aa9_"));

    let mut custom = GuiConfigFile {
        management_secret_key: "user-selected-secret".to_string(),
        ..GuiConfigFile::default()
    };
    assert!(!ensure_strong_management_secret(&mut custom).unwrap());
    assert_eq!(custom.management_secret_key, "user-selected-secret");
}

#[test]
fn management_secret_key_is_preserved_and_written_to_core() {
    let mut config = GuiConfigFile {
        management_secret_key: "old-management-secret".to_string(),
        ..GuiConfigFile::default()
    };

    assert!(!sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.management_secret_key, "old-management-secret");

    let template = "remote-management:\n  secret-key: stale-secret\n";
    let merged = merge_core_config_yaml(template, None, &config).unwrap();
    let document = serde_norway::from_str::<serde_norway::Value>(&merged).unwrap();
    assert_eq!(document["management"]["secret-key"], "old-management-secret");
    assert!(document.get("remote-management").is_none(), "{merged}");
}

#[test]
fn custom_auth_directory_is_preserved_and_written_to_core_config() {
    let mut config = GuiConfigFile {
        auth_dir: "/tmp/user-selected-auth".to_string(),
        ..GuiConfigFile::default()
    };
    ensure_strong_management_secret(&mut config).unwrap();

    assert!(validate_gui_config(&config).is_ok());
    assert!(!sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.auth_dir, "/tmp/user-selected-auth");

    let merged = merge_core_config_yaml("auth-dir: ~/.cli-proxy-api\n", None, &config).unwrap();
    let document = serde_norway::from_str::<serde_norway::Value>(&merged).unwrap();
    assert_eq!(document["oauth"]["auth-dir"], config.auth_dir);
    assert!(document.get("auth-dir").is_none(), "{merged}");
}

#[test]
fn default_auth_directory_is_relative_and_legacy_absolute_value_is_migrated() {
    let base_dir = agent_test_home("relative-default-auth-dir");
    let install_dir = base_dir.join("cpa-core");
    assert_eq!(
        auth_dir_path_for_core(DEFAULT_AUTH_DIR, &install_dir),
        base_dir.join(OAUTH_DIR_NAME)
    );

    let mut config = GuiConfigFile {
        auth_dir: path_to_string(&fixed_oauth_dir().unwrap()),
        ..GuiConfigFile::default()
    };
    assert!(sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.auth_dir, DEFAULT_AUTH_DIR);
    fs::remove_dir_all(base_dir).unwrap();
}

#[test]
fn packaged_macos_auth_directory_is_copied_before_config_is_repointed() {
    let root = agent_test_home("packaged-macos-auth-migration");
    let contents_dir = root.join("EasyCLIProxyAPI.app").join("Contents");
    let source = contents_dir.join("MacOS").join("oauth");
    let configured_source = contents_dir
        .join("MacOS")
        .join("unused")
        .join("..")
        .join("oauth");
    let persistent_root = root
        .join("Library")
        .join("Application Support")
        .join("com.cpa.gui");
    let destination = persistent_root.join(OAUTH_DIR_NAME);
    let install_dir = persistent_root.join("cpa-core");
    fs::create_dir_all(source.join("nested")).unwrap();
    fs::write(source.join("account.json"), b"oauth-account").unwrap();
    fs::write(source.join("nested").join("token.json"), b"oauth-token").unwrap();
    let mut config = GuiConfigFile {
        auth_dir: path_to_string(&configured_source),
        ..GuiConfigFile::default()
    };

    assert!(auth_dir_is_inside_macos_app_bundle(&configured_source));
    assert!(
        migrate_auth_dir_from_macos_app_bundle(&mut config, &install_dir, &destination,).unwrap()
    );

    assert_eq!(config.auth_dir, DEFAULT_AUTH_DIR);
    assert_eq!(
        fs::read(destination.join("account.json")).unwrap(),
        b"oauth-account"
    );
    assert_eq!(
        fs::read(destination.join("nested").join("token.json")).unwrap(),
        b"oauth-token"
    );
    assert_eq!(
        fs::read(source.join("account.json")).unwrap(),
        b"oauth-account"
    );

    config.auth_dir = path_to_string(&configured_source);
    assert!(
        migrate_auth_dir_from_macos_app_bundle(&mut config, &install_dir, &destination).unwrap()
    );
    assert_eq!(config.auth_dir, DEFAULT_AUTH_DIR);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn packaged_macos_auth_migration_does_not_overwrite_conflicting_credentials() {
    let root = agent_test_home("packaged-macos-auth-conflict");
    let source = root
        .join("EasyCLIProxyAPI.app")
        .join("Contents")
        .join("MacOS")
        .join("oauth");
    let persistent_root = root.join("persistent");
    let destination = persistent_root.join(OAUTH_DIR_NAME);
    let install_dir = persistent_root.join("cpa-core");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&destination).unwrap();
    fs::write(source.join("account.json"), b"old-app-credential").unwrap();
    fs::write(destination.join("account.json"), b"persistent-credential").unwrap();
    let original_auth_dir = path_to_string(&source);
    let mut config = GuiConfigFile {
        auth_dir: original_auth_dir.clone(),
        ..GuiConfigFile::default()
    };

    let error = migrate_auth_dir_from_macos_app_bundle(&mut config, &install_dir, &destination)
        .unwrap_err();

    assert!(error.contains("not overwritten"), "{error}");
    assert_eq!(config.auth_dir, original_auth_dir);
    assert_eq!(
        fs::read(destination.join("account.json")).unwrap(),
        b"persistent-credential"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_packaged_macos_auth_directory_is_repointed_to_persistent_storage() {
    let root = agent_test_home("missing-packaged-macos-auth");
    let source = root
        .join("EasyCLIProxyAPI.app")
        .join("Contents")
        .join("MacOS")
        .join("oauth");
    let persistent_root = root.join("persistent");
    let destination = persistent_root.join(OAUTH_DIR_NAME);
    let install_dir = persistent_root.join("cpa-core");
    let mut config = GuiConfigFile {
        auth_dir: path_to_string(&source),
        ..GuiConfigFile::default()
    };

    assert!(
        migrate_auth_dir_from_macos_app_bundle(&mut config, &install_dir, &destination,).unwrap()
    );

    assert_eq!(config.auth_dir, DEFAULT_AUTH_DIR);
    assert!(destination.is_dir());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn external_custom_auth_directory_is_not_migrated() {
    let root = agent_test_home("external-custom-auth");
    let install_dir = root.join("cpa-core");
    let destination = root.join(OAUTH_DIR_NAME);
    let custom = root.join("custom-auth");
    let mut config = GuiConfigFile {
        auth_dir: path_to_string(&custom),
        ..GuiConfigFile::default()
    };

    assert!(
        !migrate_auth_dir_from_macos_app_bundle(&mut config, &install_dir, &destination,).unwrap()
    );
    assert_eq!(config.auth_dir, path_to_string(&custom));
    assert!(!destination.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_gui_config_can_seed_managed_core_settings() {
    let legacy = "port: 8317\nallow-lan: false\nrun-on-startup: true\n";
    let mut config = serde_yaml::from_str::<GuiConfigFile>(legacy).unwrap();
    let core_settings = CoreConfigSettings {
        host: "0.0.0.0".to_string(),
        port: 9000,
        auth_dir: "/tmp/external-auth".to_string(),
        api_keys: vec!["existing-key".to_string()],
        management_secret_configured: true,
        debug: true,
        commercial_mode: true,
        logging_to_file: true,
        logs_max_total_size_mb: 256,
        error_logs_max_files: 24,
        usage_statistics_enabled: false,
        redis_usage_queue_retention_seconds: 120,
        request_log: true,
        plugins_enabled: true,
        routing_strategy: "fill-first".to_string(),
        proxy_url: "http://127.0.0.1:8080".to_string(),
        routing_session_affinity: true,
        routing_session_affinity_ttl: "45m".to_string(),
        disable_cooling: true,
        request_retry: 1,
        max_retry_credentials: 2,
        max_retry_interval: 5,
        streaming_bootstrap_retries: 1,
        management_secret_key: Some("management-secret".to_string()),
    };

    apply_core_settings_to_gui_config(&mut config, &core_settings, None);

    assert_eq!(gui_api_key_values(&config.api_keys), vec!["existing-key"]);
    assert_eq!(config.management_secret_key, "management-secret");
    assert_eq!(config.host, "0.0.0.0");
    assert_eq!(config.port, 9000);
    assert!(config.disable_cooling);
    assert_eq!(config.auth_dir, "/tmp/external-auth");
    assert!(config.debug);
    assert!(config.commercial_mode);
    assert!(config.logging_to_file);
    assert_eq!(config.logs_max_total_size_mb, 256);
    assert_eq!(config.error_logs_max_files, 24);
    assert!(!config.usage_statistics_enabled);
    assert_eq!(config.redis_usage_queue_retention_seconds, 120);
    assert!(config.request_log);
    assert!(config.plugins_enabled);
    assert_eq!(config.routing_strategy, "fill-first");
    assert_eq!(config.proxy_url, "http://127.0.0.1:8080");
    assert!(config.routing_session_affinity);
    assert_eq!(config.routing_session_affinity_ttl, "45m");
    assert_eq!(config.request_retry, 1);
    assert_eq!(config.max_retry_credentials, 2);
    assert_eq!(config.max_retry_interval, 5);
    assert_eq!(config.streaming_bootstrap_retries, 1);
    assert!(config.run_on_startup);
}

#[test]
fn example_api_keys_are_not_persisted_as_gui_settings() {
    let input = "api-keys:\n  - your-api-key-1\n  - real-key\nremote-management:\n  secret-key: plain-management-secret\nplugins:\n  enabled: true\nrouting:\n  strategy: fill-first\n";
    let document = serde_norway::from_str::<serde_norway::Value>(input).unwrap();
    let core_settings = core_config_settings_from_value(&document).unwrap();
    let mut config = GuiConfigFile::default();

    apply_core_settings_to_gui_config(&mut config, &core_settings, None);

    assert_eq!(core_settings.api_keys, vec!["real-key"]);
    assert_eq!(gui_api_key_values(&config.api_keys), vec!["real-key"]);
    assert_eq!(
        core_settings.management_secret_key.as_deref(),
        Some("plain-management-secret")
    );
    assert_eq!(config.management_secret_key, "plain-management-secret");
    assert!(validate_core_api_key("your-api-key-3").is_err());
}

#[test]
fn hashed_management_secret_is_detected_without_replacing_known_plaintext() {
    let input = "remote-management:\n  secret-key: $2a$10$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuu\n";
    let document = serde_norway::from_str::<serde_norway::Value>(input).unwrap();
    let core_settings = core_config_settings_from_value(&document).unwrap();

    assert!(core_settings
        .management_secret_key
        .as_deref()
        .is_some_and(is_hashed_management_secret_key));
    assert!(core_settings.management_secret_configured);
    let mut config = GuiConfigFile {
        management_secret_key: "known-plaintext".to_string(),
        ..GuiConfigFile::default()
    };
    apply_core_settings_to_gui_config(&mut config, &core_settings, None);
    assert_eq!(config.management_secret_key, "known-plaintext");
}

#[test]
fn management_api_requires_an_available_plaintext_secret() {
    let mut config = GuiConfigFile {
        management_secret_key: String::new(),
        ..GuiConfigFile::default()
    };
    assert!(management_authorization(&config).is_err());

    config.management_secret_key =
        "$2a$10$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuu".to_string();
    assert!(management_authorization(&config).is_err());

    config.management_secret_key = "known-plaintext".to_string();
    assert_eq!(
        management_authorization(&config).unwrap(),
        "Bearer known-plaintext"
    );
}

#[test]
fn runtime_network_patch_preserves_comments_and_other_settings() {
    let config = GuiConfigFile {
        port: 9527,
        allow_lan: true,
        host: "0.0.0.0".to_string(),
        run_on_startup: false,
        ..GuiConfigFile::default()
    };
    let input = "config-version: 8\nserver:\n  # Bind address\n  host: 127.0.0.1 # local only\n\n  # Service port\n  port: 8317 # default\nrequests:\n  proxy-url: \"\"\ndebug: true\n";
    let updated = patch_core_network_endpoint_yaml(input, &config)
        .unwrap()
        .expect("network settings should change");

    assert_eq!(
            updated,
            "config-version: 8\nserver:\n  # Bind address\n  host: 0.0.0.0 # local only\n\n  # Service port\n  port: 9527 # default\nrequests:\n  proxy-url: \"\"\ndebug: true\n"
        );
    assert!(updated.contains("# Bind address"));
    assert!(updated.contains("# local only"));
    assert!(updated.contains("# Service port"));
    assert!(updated.contains("# default"));
    assert!(updated.contains("debug: true"));

    let document = serde_norway::from_str::<serde_norway::Value>(&updated).unwrap();
    assert_eq!(document["server"]["host"], "0.0.0.0");
    assert_eq!(document["server"]["port"], 9527);
}

#[test]
fn an_old_layout_file_moves_each_setting_arbor_saves_to_its_v8_path_after_one_backup() {
    let config = GuiConfigFile { port: 9527, host: "0.0.0.0".to_string(), ..GuiConfigFile::default() };
    let old = "# Bind address\nhost: 127.0.0.1 # local only\nport: 8317\nproxy-url: \"\"\ndebug: true\n";
    let moved = patch_core_network_endpoint_yaml(old, &config).unwrap().expect("the settings move");
    let document = serde_norway::from_str::<serde_norway::Value>(&moved).unwrap();
    assert_eq!(document["server"]["host"], "0.0.0.0");
    assert_eq!(document["server"]["port"], 9527);
    assert_eq!(document["requests"]["proxy-url"], "");
    for key in ["host", "port", "proxy-url"] {
        assert!(document.get(key).is_none(), "{moved}");
    }
    // What Arbor didn't save stays where it was, and the new section is written as a block.
    assert_eq!(document["debug"], true);
    assert!(moved.contains("server:\n  host: \"0.0.0.0\"\n  port: 9527\n"), "{moved}");

    let home = agent_test_home("old-layout-backup");
    let path = home.join("config.yaml");
    let backup = home.join("config.yaml.pre-v8");
    fs::write(&path, old).unwrap();
    assert!(write_yaml_if_changed(&path, &moved).unwrap());
    assert_eq!(fs::read_to_string(&backup).unwrap(), old);
    // Only the file as it first was is kept.
    fs::write(&path, "host: 10.0.0.1\n").unwrap();
    assert!(write_yaml_if_changed(&path, &moved).unwrap());
    assert_eq!(fs::read_to_string(&backup).unwrap(), old);

    // A v8 file is never backed up.
    fs::remove_file(&backup).unwrap();
    fs::write(&path, "config-version: 8\nserver:\n  port: 1\n").unwrap();
    assert!(write_yaml_if_changed(&path, "config-version: 8\nserver:\n  port: 2\n").unwrap());
    assert!(!backup.exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn removing_a_block_leaves_the_comments_after_it_where_they_were() {
    // An alias created and deleted again mustn't leave the next comment pushed in a level.
    let before = "# OAuth\noauth:\n  # Authentication directory\n  auth-dir: ../oauth\n  providers: {}\n# Client keys\napi-keys:\n- old-key\n# Enable debug logging\ndebug: false\n";
    let original = serde_norway::from_str::<serde_norway::Value>(before).unwrap();
    let mut with_alias = original.clone();
    with_alias["oauth"]["model-alias"] =
        serde_norway::from_str("claude:\n  - name: m\n    alias: m-alias\n    fork: true\n").unwrap();
    let created = render_yaml_value_changes(before, &original, &with_alias).unwrap();
    assert!(created.contains("  model-alias:\n    claude:\n      - name: \"m\"\n"), "{created}");
    assert_eq!(render_yaml_value_changes(&created, &with_alias, &original).unwrap(), before);

    // A list written at its key's own indent goes with the key; the comment under it stays.
    let mut without_keys = original.clone();
    without_keys.as_mapping_mut().unwrap().remove("api-keys");
    assert_eq!(
        render_yaml_value_changes(before, &original, &without_keys).unwrap(),
        "# OAuth\noauth:\n  # Authentication directory\n  auth-dir: ../oauth\n  providers: {}\n# Client keys\n# Enable debug logging\ndebug: false\n"
    );
}

#[test]
fn runtime_network_patch_skips_unchanged_yaml() {
    let config = GuiConfigFile::default();
    let input = "server:\n  host: 127.0.0.1\n  port: 8317\nrequests:\n  proxy-url: \"\"\n";

    assert!(patch_core_network_endpoint_yaml(input, &config).unwrap().is_none());
}

#[test]
fn independent_network_modules_only_patch_their_own_fields() {
    let config = GuiConfigFile {
        host: "192.168.1.20".to_string(),
        port: 9527,
        proxy_url: "socks5://127.0.0.1:7890".to_string(),
        routing_session_affinity: true,
        routing_session_affinity_ttl: "2h".to_string(),
        disable_cooling: true,
        request_retry: 7,
        max_retry_credentials: 8,
        max_retry_interval: 9,
        streaming_bootstrap_retries: 10,
        ..GuiConfigFile::default()
    };
    let input = "server:\n  host: 127.0.0.1\n  port: 8317\nrequests:\n  proxy-url: \"\"\n  streaming:\n    bootstrap-retries: 4\nrouting:\n  session-affinity: false\n  session-affinity-ttl: 1h\n  cooldown:\n    disable-cooling: false\n  retry:\n    request-retry: 1\n    max-retry-credentials: 2\n    max-retry-interval: 3\n";

    let network = patch_core_network_endpoint_yaml(input, &config)
        .unwrap()
        .expect("network endpoint should change");
    let network = serde_norway::from_str::<serde_norway::Value>(&network).unwrap();
    assert_eq!(network["server"]["host"], "192.168.1.20");
    assert_eq!(network["server"]["port"], 9527);
    assert_eq!(network["requests"]["proxy-url"], "socks5://127.0.0.1:7890");
    assert_eq!(network["routing"]["cooldown"]["disable-cooling"], false);
    assert_eq!(network["routing"]["retry"]["request-retry"], 1);
    assert_eq!(network["routing"]["session-affinity"], false);

    let retry = patch_core_retry_yaml(input, &config)
        .unwrap()
        .expect("retry settings should change");
    let retry = serde_norway::from_str::<serde_norway::Value>(&retry).unwrap();
    assert_eq!(retry["routing"]["cooldown"]["disable-cooling"], true);
    assert_eq!(retry["routing"]["retry"]["request-retry"], 7);
    assert_eq!(retry["routing"]["retry"]["max-retry-credentials"], 8);
    assert_eq!(retry["routing"]["retry"]["max-retry-interval"], 9);
    assert_eq!(retry["requests"]["streaming"]["bootstrap-retries"], 10);
    assert_eq!(retry["server"]["host"], "127.0.0.1");

    let routing = patch_core_session_routing_yaml(input, &config)
        .unwrap()
        .expect("session routing should change");
    let routing = serde_norway::from_str::<serde_norway::Value>(&routing).unwrap();
    assert_eq!(routing["routing"]["session-affinity"], true);
    assert_eq!(routing["routing"]["session-affinity-ttl"], "2h");
    assert_eq!(routing["routing"]["retry"]["request-retry"], 1);
}

#[test]
fn yaml_edit_runtime_patches_supported_fields_without_reflowing_yaml() {
    let input = "# Client authentication\napi-keys:\n  - old-key\n\n# Plugin runtime\nplugins:\n  enabled: false # global switch\n  dir: plugins\n\n# Credential routing\nrouting:\n  strategy: round-robin # current strategy\n  session-affinity: true\n\ndebug: true # untouched\n";
    let file = input.parse::<yaml_edit::YamlFile>().unwrap();
    let document = file.document().unwrap();

    assert!(set_yaml_edit_nested_value(
        &document, "plugins", "enabled", true
    ));
    assert!(set_yaml_edit_nested_value(
        &document,
        "routing",
        "strategy",
        "fill-first".to_string()
    ));

    let rendered = patch_core_api_keys_yaml(
        &file.to_string(),
        &["new-key".to_string(), "backup-key".to_string()],
    )
    .unwrap();
    assert!(rendered.contains("# Client authentication"));
    assert!(rendered.contains("# Plugin runtime"));
    assert!(rendered.contains("# global switch"));
    assert!(rendered.contains("# Credential routing"));
    assert!(rendered.contains("# current strategy"));
    assert!(rendered.contains("debug: true # untouched"));
    assert!(rendered.contains("dir: plugins"));
    assert!(rendered.contains("session-affinity: true"));

    let settings =
        core_config_settings_from_value(&serde_norway::from_str(&rendered).unwrap()).unwrap();
    assert_eq!(settings.api_keys, vec!["new-key", "backup-key"]);
    assert!(settings.plugins_enabled);
    assert_eq!(settings.routing_strategy, "fill-first");
}

#[test]
fn yaml_edit_sequence_shrink_keeps_following_top_level_key_valid() {
    let input = "# API keys for authentication\napi-keys:\n  - first-key\n  - second-key\n  - third-key\n\n# Enable debug logging\ndebug: false\n";
    let original = serde_norway::from_str::<serde_norway::Value>(input).unwrap();
    let mut updated = original.clone();
    updated["api-keys"] = serde_norway::Value::Sequence(vec!["first-key".into()]);

    let rendered = render_yaml_value_changes(input, &original, &updated)
        .unwrap_or_else(|error| panic!("sequence shrink failed: {error}"));
    let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered)
        .unwrap_or_else(|error| panic!("invalid YAML: {error}\n{rendered}"));

    assert_eq!(parsed["api-keys"][0], "first-key");
    assert_eq!(parsed["api-keys"].as_sequence().unwrap().len(), 1);
    assert_eq!(parsed["debug"], false);
    assert!(rendered.find("api-keys:").unwrap() < rendered.find("debug:").unwrap());
}

#[test]
fn runtime_yaml_ast_patch_handles_core_comments_around_nested_mapping() {
    let input = "host: 127.0.0.1\nremote-management:\n# Whether to allow remote access.\n  allow-remote: false\n# Management key.\n# All requests require this key.\n  secret-key: old\n# Disable panel.\n  disable-control-panel: false\nauth-dir: /tmp/old\napi-keys:\n  - old-key\n";
    let rendered = patch_core_yaml_document(input, |document| {
        let auth_changed = set_core_yaml_top_level_value(
            document,
            "auth-dir",
            serde_norway::Value::String("/tmp/new".to_string()),
        )?;
        let secret_changed = set_core_yaml_nested_value(
            document,
            "remote-management",
            "secret-key",
            serde_norway::Value::String("123456".to_string()),
        )?;
        Ok(auth_changed || secret_changed)
    })
    .unwrap()
    .unwrap();
    let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered)
        .unwrap_or_else(|error| panic!("invalid YAML: {error}\n{rendered}"));

    assert_eq!(parsed["auth-dir"], "/tmp/new");
    assert_eq!(parsed["remote-management"]["secret-key"], "123456");
    assert!(rendered.contains("# All requests require this key."));
    assert!(rendered.contains("disable-control-panel: false"));
}

#[test]
fn yaml_edit_runtime_patch_removes_empty_keys_and_skips_unsupported_sections() {
    let input = "# Client authentication\napi-keys:\n  - old-key\nplugins:\n  enabled: true\nrouting:\n  strategy: fill-first\n";
    let rendered = patch_core_api_keys_yaml(input, &[]).unwrap();
    let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered).unwrap();
    let root = parsed.as_mapping().unwrap();
    assert!(yaml_mapping_value(root, "api-keys").is_none(), "{rendered}");
    assert_eq!(
        core_config_settings_from_value(&parsed).unwrap().api_keys,
        Vec::<String>::new()
    );

    let missing_api_keys = "host: 127.0.0.1\nport: 8317\n";
    let rendered = patch_core_api_keys_yaml(
        missing_api_keys,
        &["new-key".to_string(), "backup-key".to_string()],
    )
    .unwrap();
    let settings =
        core_config_settings_from_value(&serde_norway::from_str(&rendered).unwrap()).unwrap();
    assert_eq!(settings.api_keys, vec!["new-key", "backup-key"]);
    assert!(rendered.contains("host: 127.0.0.1"));
    assert!(rendered.contains("port: 8317"));

    // Nested plugin/routing sections are still optional for comment-preserving
    // runtime patches; missing maps remain unsupported and stay untouched.
    let unsupported = "host: 127.0.0.1\nport: 8317\n";
    let file = unsupported.parse::<yaml_edit::YamlFile>().unwrap();
    let document = file.document().unwrap();
    assert!(!set_yaml_edit_nested_value(
        &document, "plugins", "enabled", true
    ));
    assert!(!set_yaml_edit_nested_value(
        &document,
        "routing",
        "strategy",
        "fill-first".to_string()
    ));
    assert_eq!(file.to_string(), unsupported);
}

#[test]
fn yaml_edit_runtime_patch_recreates_api_keys_after_delete_all() {
    let input = "# Client authentication\napi-keys:\n  - old-key\nplugins:\n  enabled: true\n";
    let cleared = patch_core_api_keys_yaml(input, &[]).unwrap();
    let rendered = patch_core_api_keys_yaml(&cleared, &["restored-key".to_string()]).unwrap();
    assert!(rendered.contains("# Client authentication"), "{rendered}");
    let settings =
        core_config_settings_from_value(&serde_norway::from_str(&rendered).unwrap()).unwrap();
    assert_eq!(settings.api_keys, vec!["restored-key"]);
}

#[test]
fn yaml_edit_runtime_patch_adds_api_keys_to_core_style_config() {
    let input = "host: 127.0.0.1\nremote-management:\n# nested setting comment\n  allow-remote: false\nauth-dir: /tmp/oauth\n# API keys for authentication\n# Enable debug logging\ndebug: false\n\n# Optional payload configuration\n# payload:\n#   filter:\n#     - models:\n#         - name: \"gemini-2.5-pro\"\n#       params:\n#         - \"generationConfig.responseJsonSchema\"\n";
    let rendered =
        patch_core_api_keys_yaml(input, &["new-key".to_string(), "backup-key".to_string()])
            .unwrap();
    let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered)
        .unwrap_or_else(|error| panic!("invalid YAML: {error}\n{rendered}"));
    let settings = core_config_settings_from_value(&parsed).unwrap();
    assert_eq!(settings.api_keys, vec!["new-key", "backup-key"]);
    assert!(rendered.contains("# Optional payload configuration"));
    assert!(rendered.contains("generationConfig.responseJsonSchema"));
    assert!(rendered.contains("access:\n  api-keys:\n    - \"new-key\"\n    - \"backup-key\"\n"), "{rendered}");
    assert!(rendered.contains("# nested setting comment"));
}

#[test]
fn yaml_edit_runtime_patch_updates_existing_real_core_config() {
    let input = "host: 0.0.0.0\nremote-management:\n# nested comment\n  allow-remote: false\nauth-dir: /tmp/oauth\n# API keys for authentication\napi-keys:\n  - '123456'\n# Enable debug logging\ndebug: false\n\n# payload:\n#   filter:\n#     - models:\n#         - name: gemini\n";
    let rendered =
        patch_core_api_keys_yaml(input, &[DEFAULT_API_KEY.to_string(), "new-key".to_string()])
            .unwrap();
    let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered)
        .unwrap_or_else(|error| panic!("invalid YAML: {error}\n{rendered}"));
    assert_eq!(
        core_config_settings_from_value(&parsed).unwrap().api_keys,
        vec![DEFAULT_API_KEY, "new-key"]
    );
}

#[test]
fn runtime_api_key_patch_replaces_indentationless_core_sequence() {
    let input =
        "host: 0.0.0.0\nport: 8317\nauth-dir: /tmp/oauth\napi-keys:\n- '123456'\ndebug: false\n";
    let rendered = patch_core_api_keys_yaml(input, &[DEFAULT_API_KEY.to_string()])
        .unwrap_or_else(|error| panic!("patch failed: {error}"));
    let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered)
        .unwrap_or_else(|error| panic!("invalid YAML: {error}\n{rendered}"));

    assert_eq!(
        core_config_settings_from_value(&parsed).unwrap().api_keys,
        vec![DEFAULT_API_KEY]
    );
    // The old top-level list moves to access.api-keys, in the same edit.
    assert!(!rendered.contains("- '123456'"), "{rendered}");
    assert_eq!(parsed["access"]["api-keys"][0], DEFAULT_API_KEY, "{rendered}");
    assert!(rendered.contains("debug: false"), "{rendered}");
}

#[test]
fn yaml_edit_runtime_patch_migrates_legacy_api_key_entries() {
    let input = "auth:\n  providers:\n    config-api-key:\n      api-key-entries:\n        - api-key: first-key\n        - key: second-key\nplugins:\n  enabled: false\n";
    let rendered = patch_core_api_keys_yaml(input, &["migrated-key".to_string()]).unwrap();
    let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered).unwrap();
    let settings = core_config_settings_from_value(&parsed).unwrap();
    assert_eq!(settings.api_keys, vec!["migrated-key"]);
    assert!(
        nested_yaml_value(
            parsed.as_mapping().unwrap(),
            &["auth", "providers", "config-api-key", "api-key-entries"]
        )
        .is_none(),
        "{rendered}"
    );
}

#[test]
fn core_config_reads_legacy_api_key_entries() {
    let input = "auth:\n  providers:\n    config-api-key:\n      api-key-entries:\n        - api-key: first-key\n        - key: second-key\nplugins:\n  enabled: false\nrouting:\n  strategy: round-robin\n";
    let document = serde_norway::from_str::<serde_norway::Value>(input).unwrap();
    let settings = core_config_settings_from_value(&document).unwrap();

    assert_eq!(settings.api_keys, vec!["first-key", "second-key"]);
    assert!(!settings.plugins_enabled);
    assert_eq!(settings.routing_strategy, "round-robin");
}

#[test]
fn core_config_reads_logging_settings_and_applies_defaults() {
    let configured = serde_norway::from_str::<serde_norway::Value>(
        "debug: true\ncommercial-mode: true\nlogging-to-file: true\nlogs-max-total-size-mb: 512\nerror-logs-max-files: 25\nusage-statistics-enabled: false\nredis-usage-queue-retention-seconds: 7200\nrequest-log: true\n",
    )
    .unwrap();
    let settings = core_config_settings_from_value(&configured).unwrap();

    assert!(settings.debug);
    assert!(settings.commercial_mode);
    assert!(settings.logging_to_file);
    assert_eq!(settings.logs_max_total_size_mb, 512);
    assert_eq!(settings.error_logs_max_files, 25);
    assert!(!settings.usage_statistics_enabled);
    assert_eq!(settings.redis_usage_queue_retention_seconds, 3600);
    assert!(settings.request_log);

    let defaults = core_config_settings_from_value(&serde_norway::from_str("{}").unwrap()).unwrap();
    assert!(!defaults.debug);
    assert!(!defaults.commercial_mode);
    assert!(!defaults.logging_to_file);
    assert_eq!(
        defaults.logs_max_total_size_mb,
        DEFAULT_LOGS_MAX_TOTAL_SIZE_MB
    );
    assert_eq!(defaults.error_logs_max_files, DEFAULT_ERROR_LOGS_MAX_FILES);
    // Left out, the core keeps usage statistics off, in either layout.
    assert!(!defaults.usage_statistics_enabled);
    let v8_defaults =
        core_config_settings_from_value(&serde_norway::from_str("config-version: 8
server:
  port: 8317
").unwrap()).unwrap();
    assert!(!v8_defaults.usage_statistics_enabled);
    assert_eq!(
        defaults.redis_usage_queue_retention_seconds,
        DEFAULT_REDIS_USAGE_QUEUE_RETENTION_SECONDS
    );
    assert!(!defaults.request_log);

    let zero_retention =
        serde_norway::from_str::<serde_norway::Value>("redis-usage-queue-retention-seconds: 0\n")
            .unwrap();
    assert_eq!(
        core_config_settings_from_value(&zero_retention)
            .unwrap()
            .redis_usage_queue_retention_seconds,
        DEFAULT_REDIS_USAGE_QUEUE_RETENTION_SECONDS
    );
}

#[test]
fn core_config_reads_proxy_and_session_affinity_fields() {
    let canonical = serde_norway::from_str::<serde_norway::Value>(
            "proxy-url: socks5://127.0.0.1:7890\nrouting:\n  session-affinity: true\n  session-affinity-ttl: 2h\n",
        )
        .unwrap();
    let settings = core_config_settings_from_value(&canonical).unwrap();
    assert_eq!(settings.proxy_url, "socks5://127.0.0.1:7890");
    assert!(settings.routing_session_affinity);
    assert_eq!(settings.routing_session_affinity_ttl, "2h");

    let aliases = serde_norway::from_str::<serde_norway::Value>(
        "routing:\n  sessionAffinity: true\n  sessionAffinityTTL: 30m\n",
    )
    .unwrap();
    let settings = core_config_settings_from_value(&aliases).unwrap();
    assert!(settings.routing_session_affinity);
    assert_eq!(settings.routing_session_affinity_ttl, "30m");

    let defaults = core_config_settings_from_value(&serde_norway::from_str("{}").unwrap()).unwrap();
    assert_eq!(defaults.proxy_url, "");
    assert!(!defaults.routing_session_affinity);
    assert_eq!(defaults.routing_session_affinity_ttl, "");
}

#[test]
fn core_config_reads_retry_fields_and_uses_core_defaults() {
    let document = serde_norway::from_str::<serde_norway::Value>(
        "disable-cooling: true\nrequest-retry: 1\nmax-retry-credentials: 2\nmax-retry-interval: 5\nstreaming:\n  bootstrap-retries: 4\n",
    )
    .unwrap();
    let settings = core_config_settings_from_value(&document).unwrap();

    assert!(settings.disable_cooling);
    assert_eq!(settings.request_retry, 1);
    assert_eq!(settings.max_retry_credentials, 2);
    assert_eq!(settings.max_retry_interval, 5);
    assert_eq!(settings.streaming_bootstrap_retries, 4);

    let defaults = core_config_settings_from_value(&serde_norway::from_str("{}").unwrap()).unwrap();
    assert_eq!(defaults.disable_cooling, DEFAULT_DISABLE_COOLING);
    // The core runs no retries and no wait for a missing key, whatever its example file suggests.
    assert_eq!(defaults.request_retry, 0);
    assert_eq!(
        defaults.max_retry_credentials,
        DEFAULT_MAX_RETRY_CREDENTIALS
    );
    assert_eq!(defaults.max_retry_interval, 0);
    assert_eq!(
        defaults.streaming_bootstrap_retries,
        DEFAULT_STREAMING_BOOTSTRAP_RETRIES
    );
}

#[test]
fn managed_session_settings_use_canonical_yaml_and_preserve_unrelated_content() {
    let input = "# global proxy\nproxy-url: old\n# routing options\nrouting:\n  strategy: round-robin\n  sessionAffinity: false\n  sessionAffinityTTL: 10m\n# unrelated option\nunrelated-option: true\ndebug: true\n";
    let config = GuiConfigFile {
        proxy_url: "http://127.0.0.1:8080".to_string(),
        routing_session_affinity: true,
        routing_session_affinity_ttl: "1h".to_string(),
        disable_cooling: true,
        request_retry: 1,
        max_retry_credentials: 2,
        max_retry_interval: 5,
        streaming_bootstrap_retries: 1,
        ..GuiConfigFile::default()
    };
    let rendered = apply_gui_managed_settings(input, &config).unwrap();
    let document = serde_norway::from_str::<serde_norway::Value>(&rendered).unwrap();

    assert_eq!(document["requests"]["proxy-url"], "http://127.0.0.1:8080");
    assert_eq!(document["routing"]["session-affinity"], true);
    assert_eq!(document["routing"]["session-affinity-ttl"], "1h");
    assert_eq!(document["routing"]["cooldown"]["disable-cooling"], true);
    assert_eq!(document["routing"]["retry"]["request-retry"], 1);
    assert_eq!(document["routing"]["retry"]["max-retry-credentials"], 2);
    assert_eq!(document["routing"]["retry"]["max-retry-interval"], 5);
    assert_eq!(document["requests"]["streaming"]["bootstrap-retries"], 1);
    assert!(rendered.contains("# routing options"));
    assert!(rendered.contains("# unrelated option"));
    assert_eq!(document["unrelated-option"], true);
    assert_eq!(document["observability"]["logs"]["debug"], false);
    assert!(document.get("proxy-url").is_none() && document.get("debug").is_none(), "{rendered}");
}

#[test]
fn optional_core_strings_are_trimmed_and_reject_control_characters() {
    assert_eq!(
        normalize_optional_config_string("  socks5://proxy:7890  ".to_string(), "Proxy URL")
            .unwrap(),
        "socks5://proxy:7890"
    );
    assert_eq!(
        normalize_optional_config_string(" 1h ".to_string(), "TTL").unwrap(),
        "1h"
    );
    assert!(normalize_optional_config_string("bad\nvalue".to_string(), "Proxy URL").is_err());
}

#[test]
fn a_session_ttl_saves_only_when_the_core_can_read_it() {
    // What Go's time.ParseDuration takes above zero; the core ignores anything else and keeps its default.
    for ttl in ["", " 1h ", "30m", "1h30m", "1.5h", ".5h", "+45s", "500ms", "90µs", "2h45m30.5s"] {
        assert_eq!(normalize_session_affinity_ttl(ttl.to_string()).unwrap(), ttl.trim(), "{ttl:?}");
    }
    for ttl in ["30", "30 min", "1 h", "0", "0s", "-5m", "+", "1h-5m", "5mx", "1..5h", "h", "1d", "9999999h"] {
        assert!(normalize_session_affinity_ttl(ttl.to_string()).is_err(), "{ttl:?}");
    }
}

#[test]
fn core_tls_settings_read_defaults_and_configured_values() {
    let defaults = serde_norway::from_str::<serde_norway::Value>("host: 127.0.0.1\n").unwrap();
    let configured = serde_norway::from_str::<serde_norway::Value>(
        "tls:\n  enable: true\n  cert: C:/certs/server.crt\n  key: C:/certs/server.key\n",
    )
    .unwrap();

    let defaults = core_tls_settings_from_value(&defaults).unwrap();
    assert!(!defaults.enabled);
    assert!(defaults.cert.is_empty());
    assert!(defaults.key.is_empty());

    let configured = core_tls_settings_from_value(&configured).unwrap();
    assert!(configured.enabled);
    assert_eq!(configured.cert, "C:/certs/server.crt");
    assert_eq!(configured.key, "C:/certs/server.key");
}

#[test]
fn tls_patch_preserves_unrelated_yaml_and_paths_when_disabled() {
    let input = "# server\nhost: 127.0.0.1\ntls:\n  enable: true\n  cert: old.crt\n  key: old.key\ncustom:\n  keep: true\n";
    let settings = CoreTlsSettings {
        enabled: false,
        cert: "new.crt".to_string(),
        key: "new.key".to_string(),
    };
    let patched = patch_core_tls_settings_yaml(input, &settings)
        .unwrap()
        .expect("TLS settings should change");
    let document = serde_norway::from_str::<serde_norway::Value>(&patched).unwrap();

    assert!(patched.contains("# server"));
    assert_eq!(document["server"]["tls"]["enable"], false);
    assert_eq!(document["server"]["tls"]["cert"], "new.crt");
    assert_eq!(document["server"]["tls"]["key"], "new.key");
    assert!(document.get("tls").is_none(), "{patched}");
    assert_eq!(document["host"], "127.0.0.1");
    assert_eq!(document["custom"]["keep"], true);
}

#[test]
fn enabled_tls_requires_both_paths() {
    let missing_key = CoreTlsSettings {
        enabled: true,
        cert: "server.crt".to_string(),
        key: String::new(),
    };
    assert!(normalize_core_tls_settings(missing_key).is_err());

    let disabled = CoreTlsSettings {
        enabled: false,
        cert: "  server.crt  ".to_string(),
        key: String::new(),
    };
    let disabled = normalize_core_tls_settings(disabled).unwrap();
    assert_eq!(disabled.cert, "server.crt");
    assert!(disabled.key.is_empty());
}

#[test]
fn core_origin_uses_connectable_custom_and_ipv6_hosts() {
    assert_eq!(
        core_origin("192.168.1.20", 9527, true),
        "https://192.168.1.20:9527"
    );
    assert_eq!(core_origin("0.0.0.0", 8317, false), "http://127.0.0.1:8317");
    assert_eq!(core_origin("::", 8317, false), "http://[::1]:8317");
    assert_eq!(
        core_origin("2001:db8::1", 8317, true),
        "https://[2001:db8::1]:8317"
    );
}

#[test]
fn configured_proxy_supports_http_and_socks5_urls() {
    for proxy_url in ["http://127.0.0.1:8080", "socks5://127.0.0.1:7890"] {
        apply_configured_proxy(reqwest::Client::builder(), proxy_url)
            .unwrap()
            .build()
            .unwrap();
    }
}

#[test]
fn core_config_validates_keys_and_routing_strategy() {
    assert!(validate_core_api_key("sk-valid_123").is_ok());
    assert!(validate_core_api_key("").is_err());
    assert!(validate_core_api_key("contains space").is_err());
    assert!(validate_routing_strategy("round-robin").is_ok());
    assert!(validate_routing_strategy("fill-first").is_ok());
    assert!(validate_routing_strategy("random").is_err());
}

#[test]
fn unchanged_yaml_is_not_written_again() {
    let path = std::env::temp_dir().join(format!(
        "cpa-gui-unchanged-yaml-{}-{}.yaml",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let content = "host: 127.0.0.1\nport: 8317\n";
    fs::write(&path, content).unwrap();

    assert!(!write_yaml_if_changed(&path, content).unwrap());
    assert_eq!(fs::read_to_string(&path).unwrap(), content);

    fs::remove_file(path).unwrap();
}

#[test]
fn startup_leaves_an_existing_config_yaml_as_it_is_apart_from_the_management_key() {
    let template = "# Current release template\nhost: \"\" # template bind address\nport: 8317\n\n# Client authentication\napi-keys:\n  - template-key\n\n# Plugin runtime\nplugins:\n  enabled: false # plugin switch\n\n# Credential routing\nrouting:\n  strategy: round-robin # routing switch\n\n# New release option\nnew-option: true\nnested:\n  # Nested template comment\n  keep: template\n  added: from-template\nlist:\n  - template-item\n";
    let current = "# User-edited configuration\nhost: 127.0.0.1\nport: 9000\n# User-owned nested values\nnested:\n  keep: current\n  current-only: retained\nlist:\n  - current-a\n  - current-b\nextra: true\ncustom-provider:\n  base-url: https://example.com/v1\n  headers:\n    X-Custom-Header: custom-value\n  models:\n    - name: custom-model\n      aliases: [custom-a, custom-b]\nplugins:\n  custom-runtime-options:\n    sandbox: strict\n    environment:\n      CUSTOM_FLAG: enabled\nrouting:\n  custom-rules:\n    - match: custom-*\n      target: custom-provider\nremote-management:\n  custom-dashboard-option: retained\n";
    let config = GuiConfigFile {
        port: 9527,
        allow_lan: true,
        host: "0.0.0.0".to_string(),
        run_on_startup: false,
        start_core_on_launch: true,
        silent_start: false,
        close_behavior: WindowsCloseBehavior::Ask,
        window_width: None,
        window_height: None,
        zoom_step: 0,
        auth_dir: path_to_string(&fixed_oauth_dir().unwrap()),
        api_keys: vec![
            default_api_key_entry(),
            GuiApiKeyEntry {
                key: "gui-key".to_string(),
                remark: "Test key".to_string(),
            },
        ],
        paused_api_keys: Vec::new(),
        client_key_names: Vec::new(),
        api_access_remarks: Vec::new(),
        management_secret_key: "startup-management-secret".to_string(),
        debug: true,
        commercial_mode: true,
        logging_to_file: true,
        logs_max_total_size_mb: 512,
        error_logs_max_files: 25,
        usage_statistics_enabled: false,
        redis_usage_queue_retention_seconds: 180,
        request_log: true,
        plugins_enabled: true,
        routing_strategy: "fill-first".to_string(),
        proxy_url: "socks5://127.0.0.1:7890".to_string(),
        download_source: VersionDownloadSource::Github,
        custom_download_mirrors: Vec::new(),
        active_custom_download_mirror: String::new(),
        routing_session_affinity: true,
        routing_session_affinity_ttl: "1h".to_string(),
        disable_cooling: true,
        request_retry: 1,
        max_retry_credentials: 2,
        max_retry_interval: 5,
        streaming_bootstrap_retries: 1,
    };
    let merged = merge_core_config_yaml(template, Some(current), &config).unwrap();
    let mut expected = serde_norway::from_str::<serde_norway::Value>(current).unwrap();
    expected["management"]["secret-key"] = serde_norway::Value::String("startup-management-secret".to_string());

    assert!(merged.contains("# User-edited configuration"));
    assert!(merged.contains("# User-owned nested values"));
    assert!(!merged.contains("# Current release template"));
    assert!(!merged.contains("# New release option"));
    // Arbor's own values for the core's settings (another host and port, fill-first, statistics off...) are not
    // pushed in: the file's are the ones the core runs.
    let document = serde_norway::from_str::<serde_norway::Value>(&merged).unwrap();
    assert_eq!(document, expected, "{merged}");
}

#[test]
fn startup_gives_a_config_yaml_without_a_port_arbors_so_the_core_does_not_pick_one_at_random() {
    let config = GuiConfigFile {
        port: 9527,
        management_secret_key: "startup-management-secret".to_string(),
        ..GuiConfigFile::default()
    };
    let legacy = "host: 127.0.0.1\nrouting:\n  strategy: fill-first\n";
    let document = serde_norway::from_str::<serde_norway::Value>(
        &merge_core_config_yaml("port: 8317\n", Some(legacy), &config).unwrap(),
    )
    .unwrap();
    assert_eq!(document["server"]["port"], 9527);
    assert_eq!(document["host"], "127.0.0.1");
    assert_eq!(document["routing"]["strategy"], "fill-first");

    let with_port = "host: 127.0.0.1\nport: 9000\n";
    let document = serde_norway::from_str::<serde_norway::Value>(
        &merge_core_config_yaml("port: 8317\n", Some(with_port), &config).unwrap(),
    )
    .unwrap();
    assert_eq!(document["port"], 9000);
}

#[test]
fn startup_starts_an_empty_config_yaml_over_from_the_template() {
    let template = "# Template\nhost: \"\"\nport: 9000\napi-keys:\n  - template-key\n";
    let mut config = GuiConfigFile::default();
    ensure_strong_management_secret(&mut config).unwrap();
    for empty in ["", "\n", "# nothing here yet\n"] {
        let merged = merge_core_config_yaml(template, Some(empty), &config).unwrap();
        let document = serde_norway::from_str::<serde_norway::Value>(&merged).unwrap();
        assert!(merged.contains("# Template"), "{empty:?}");
        assert_eq!(document["server"]["host"], "127.0.0.1", "{empty:?}");
        assert_eq!(document["access"]["api-keys"][0], DEFAULT_API_KEY, "{empty:?}");
    }
}

#[test]
fn startup_merge_preserves_plugin_store_config_written_by_core() {
    let template = "host: \"\"\nport: 8317\nauth-dir: ~/.cli-proxy-api\napi-keys:\n  - template-key\nremote-management:\n  secret-key: \"\"\nusage-statistics-enabled: true\nplugins:\n  enabled: false\n  dir: plugins\n  configs:\n    example:\n      enabled: true\n      priority: 1\nrouting:\n  strategy: round-robin\n  session-affinity: false\n  session-affinity-ttl: \"\"\nproxy-url: \"\"\ncommercial-mode: false\n";
    let current = "host: 127.0.0.1\nport: 8317\nauth-dir: ~/.cli-proxy-api\napi-keys:\n  - '123456'\nremote-management:\n  secret-key: \"\"\nusage-statistics-enabled: true\nplugins:\n  enabled: true\n  dir: plugins\n  configs:\n    model-fallback-router:\n      enabled: true\n      store:\n        id: model-fallback-router\n        name: Model Fallback Router\n        description: Retries matching model requests through configured fallback model names when the primary model fails with quota, rate-limit, transport, or configured HTTP status errors.\n        author: thebtf\n        version: 0.2.0\n        release-tag: v0.2.0\n        repository: https://github.com/thebtf/cpa-model-fallback-router\n        tags:\n          - Router\n          - Model Router\n          - Fallback\n        install:\n          type: github-release\nrouting:\n  strategy: round-robin\n  session-affinity: false\n  session-affinity-ttl: \"\"\nproxy-url: \"\"\n";
    let config = GuiConfigFile {
        host: "0.0.0.0".to_string(),
        allow_lan: true,
        plugins_enabled: true,
        ..GuiConfigFile::default()
    };

    let merged = merge_core_config_yaml(template, Some(current), &config)
        .unwrap_or_else(|error| panic!("plugin config merge failed: {error}"));
    let document = serde_norway::from_str::<serde_norway::Value>(&merged).unwrap();
    let current_document = serde_norway::from_str::<serde_norway::Value>(current).unwrap();

    assert_eq!(document["host"], "127.0.0.1");
    assert_eq!(
        document["plugins"]["configs"]["model-fallback-router"],
        current_document["plugins"]["configs"]["model-fallback-router"]
    );
    assert_eq!(
        document["plugins"]["configs"]["model-fallback-router"]["store"]["version"],
        "0.2.0"
    );
    assert_eq!(
        document["plugins"]["configs"]["model-fallback-router"]["store"]["install"]["type"],
        "github-release"
    );
    assert!(document.get("commercial-mode").is_none());
    assert!(document["plugins"]["configs"].get("example").is_none());
}

#[test]
fn startup_merge_without_current_config_uses_gui_defaults() {
    let template = "# Template\nhost: \"\"\nport: 9000\napi-keys:\n  - template-key\nplugins:\n  enabled: true\nrouting:\n  strategy: fill-first\ndebug: false\n";
    let mut config = GuiConfigFile::default();
    ensure_strong_management_secret(&mut config).unwrap();
    let merged = merge_core_config_yaml(template, None, &config).unwrap();
    let document = serde_norway::from_str::<serde_norway::Value>(&merged).unwrap();

    assert!(merged.contains("# Template"));
    assert_eq!(document["server"]["host"], "127.0.0.1");
    assert_eq!(document["server"]["port"], 8317);
    assert_eq!(document["access"]["api-keys"][0], DEFAULT_API_KEY, "{merged}");
    assert_eq!(document["plugins"]["enabled"], false);
    assert_eq!(document["routing"]["strategy"], "round-robin");
    assert_eq!(document["server"]["commercial-mode"], false);
    let logs = &document["observability"]["logs"];
    assert_eq!(logs["debug"], false);
    assert_eq!(logs["logging-to-file"], false);
    assert_eq!(logs["logs-max-total-size-mb"], 0);
    assert_eq!(logs["error-logs-max-files"], 10);
    assert_eq!(logs["request-log"], false);
    assert_eq!(document["observability"]["usage"]["usage-statistics-enabled"], true);
    assert_eq!(document["observability"]["usage"]["redis-usage-queue-retention-seconds"], 60);
    assert_eq!(document["management"]["secret-key"], config.management_secret_key);
    // Every one of them only at its v8 path.
    for key in ["host", "port", "api-keys", "debug", "commercial-mode", "remote-management"] {
        assert!(document.get(key).is_none(), "{key}: {merged}");
    }
}

#[test]
fn startup_merge_can_shrink_template_api_key_sequence() {
    let template = "host: \"\"\nport: 8317\nremote-management:\n  secret-key: \"\"\nauth-dir: ~/.cli-proxy-api\napi-keys:\n  - template-one\n  - template-two\n  - template-three\ndebug: false\nplugins:\n  enabled: false\nrouting:\n  strategy: round-robin\n";
    let mut config = GuiConfigFile::default();
    ensure_strong_management_secret(&mut config).unwrap();
    let merged = merge_core_config_yaml(template, None, &config).unwrap();
    let document = serde_norway::from_str::<serde_norway::Value>(&merged)
        .unwrap_or_else(|error| panic!("invalid YAML: {error}\n{merged}"));

    assert_eq!(document["access"]["api-keys"][0], DEFAULT_API_KEY);
    assert_eq!(document["access"]["api-keys"].as_sequence().unwrap().len(), 1);
    assert!(document.get("api-keys").is_none(), "{merged}");
    assert_eq!(document["observability"]["logs"]["debug"], false);
    assert_eq!(document["management"]["secret-key"], config.management_secret_key);
}

/// A trimmed core v8 config.yaml in the shape of CLIProxyAPI 8's config.example.yaml.
const V8_CONFIG: &str = r#"# Configuration template using the v8 layout.
config-version: 8

# Listener, TLS, network discovery, and server operation.
server:
  # Server host/interface to bind to.
  host: ""
  port: 8317
  tls:
    enable: false
    cert: ""
    key: ""
  commercial-mode: false

# Management API settings
management:
  allow-remote: false
  secret-key: ""

# Client authentication for the proxy API. These are not upstream provider keys.
access:
  # API keys for authentication
  api-keys:
    - "your-api-key-1"
    - "your-api-key-2"
    - "your-api-key-3"

routing:
  strategy: "round-robin"
  session-affinity: false
  session-affinity-ttl: "1h"
  retry:
    request-retry: 3
    max-retry-credentials: 0
    max-retry-interval: 30
  cooldown:
    disable-cooling: false

# Shared request/response behavior.
requests:
  proxy-url: ""

oauth:
  auth-dir: "~/.cli-proxy-api"

observability:
  logs:
    debug: false
    logging-to-file: false
    logs-max-total-size-mb: 0
    error-logs-max-files: 10
    request-log: false
  usage:
    usage-statistics-enabled: false
    redis-usage-queue-retention-seconds: 60

plugins:
  enabled: false
"#;

fn v8_test_gui_config() -> GuiConfigFile {
    GuiConfigFile {
        host: "127.0.0.1".to_string(),
        port: 9527,
        auth_dir: "/tmp/arbor-oauth".to_string(),
        api_keys: vec![
            GuiApiKeyEntry { key: "sk-arbor-one".to_string(), remark: "One".to_string() },
            GuiApiKeyEntry { key: "sk-arbor-two".to_string(), remark: String::new() },
        ],
        management_secret_key: "v8-management-secret".to_string(),
        debug: true,
        commercial_mode: true,
        logging_to_file: true,
        logs_max_total_size_mb: 512,
        error_logs_max_files: 25,
        usage_statistics_enabled: true,
        redis_usage_queue_retention_seconds: 180,
        request_log: true,
        proxy_url: "socks5://127.0.0.1:7890".to_string(),
        disable_cooling: true,
        request_retry: 1,
        max_retry_credentials: 2,
        max_retry_interval: 5,
        streaming_bootstrap_retries: 2,
        ..GuiConfigFile::default()
    }
}

#[test]
fn v8_config_gets_gui_settings_at_v8_paths_and_keeps_its_comments() {
    let config = v8_test_gui_config();

    let merged = apply_gui_managed_settings(V8_CONFIG, &config).unwrap();
    let document = serde_norway::from_str::<serde_norway::Value>(&merged).unwrap();

    assert!(merged.contains("# Client authentication for the proxy API"), "{merged}");
    assert!(merged.contains("  # API keys for authentication"), "{merged}");
    assert_eq!(document["config-version"], 8);
    assert_eq!(document["server"]["host"], "127.0.0.1");
    assert_eq!(document["server"]["port"], 9527);
    assert_eq!(document["server"]["commercial-mode"], true);
    assert_eq!(document["oauth"]["auth-dir"], "/tmp/arbor-oauth");
    assert_eq!(document["management"]["secret-key"], "v8-management-secret");
    assert_eq!(
        document["access"]["api-keys"],
        serde_norway::from_str::<serde_norway::Value>("[sk-arbor-one, sk-arbor-two]").unwrap(),
        "{merged}"
    );
    assert_eq!(document["observability"]["logs"]["debug"], true);
    assert_eq!(document["observability"]["logs"]["logging-to-file"], true);
    assert_eq!(document["observability"]["logs"]["logs-max-total-size-mb"], 512);
    assert_eq!(document["observability"]["logs"]["error-logs-max-files"], 25);
    assert_eq!(document["observability"]["logs"]["request-log"], true);
    assert_eq!(document["observability"]["usage"]["usage-statistics-enabled"], true);
    assert_eq!(document["observability"]["usage"]["redis-usage-queue-retention-seconds"], 180);
    assert_eq!(document["requests"]["proxy-url"], "socks5://127.0.0.1:7890");
    assert_eq!(document["requests"]["streaming"]["bootstrap-retries"], 2);
    assert_eq!(document["routing"]["cooldown"]["disable-cooling"], true);
    assert_eq!(document["routing"]["retry"]["request-retry"], 1);
    assert_eq!(document["routing"]["retry"]["max-retry-credentials"], 2);
    assert_eq!(document["routing"]["retry"]["max-retry-interval"], 5);
    // None of the legacy spellings, which core v8 would ignore or drop, are added.
    for legacy in [
        "host", "port", "auth-dir", "debug", "commercial-mode", "logging-to-file", "request-log",
        "usage-statistics-enabled", "proxy-url", "disable-cooling", "request-retry",
        "max-retry-credentials", "max-retry-interval", "streaming", "remote-management", "api-keys",
    ] {
        assert!(document.get(legacy).is_none(), "{legacy} was written at the top level:\n{merged}");
    }

    // Reading the file back yields what was written, and a second pass changes nothing.
    let settings = core_config_settings_from_value(&document).unwrap();
    assert_eq!(settings.api_keys, vec!["sk-arbor-one", "sk-arbor-two"]);
    assert_eq!(settings.management_secret_key.as_deref(), Some("v8-management-secret"));
    assert_eq!(settings.auth_dir, "/tmp/arbor-oauth");
    assert_eq!((settings.host.as_str(), settings.port), ("127.0.0.1", 9527));
    assert!(settings.debug && settings.request_log && settings.disable_cooling);
    assert_eq!(settings.streaming_bootstrap_retries, 2);
    assert_eq!(apply_gui_managed_settings(&merged, &config).unwrap(), merged);
}

#[test]
fn v8_settings_are_read_from_v8_paths() {
    let content = V8_CONFIG
        .replace("    - \"your-api-key-1\"\n    - \"your-api-key-2\"\n    - \"your-api-key-3\"\n", "    - live-key-1\n    - live-key-2\n")
        .replace("  secret-key: \"\"", "  secret-key: live-management-secret")
        .replace("auth-dir: \"~/.cli-proxy-api\"", "auth-dir: /Users/someone/oauth")
        .replace("  host: \"\"", "  host: 0.0.0.0")
        .replace("    enable: false\n    cert: \"\"", "    enable: true\n    cert: server.crt");
    let document = serde_norway::from_str::<serde_norway::Value>(&content).unwrap();

    let settings = core_config_settings_from_value(&document).unwrap();
    assert_eq!(settings.api_keys, vec!["live-key-1", "live-key-2"]);
    assert_eq!(settings.management_secret_key.as_deref(), Some("live-management-secret"));
    assert!(settings.management_secret_configured);
    assert_eq!(settings.auth_dir, "/Users/someone/oauth");
    assert_eq!(settings.host, "0.0.0.0");
    assert_eq!(settings.request_retry, 3);
    assert_eq!(settings.max_retry_interval, 30);
    assert!(!settings.usage_statistics_enabled);
    let tls = core_tls_settings_from_value(&document).unwrap();
    assert!(tls.enabled);
    assert_eq!(tls.cert, "server.crt");

    // The v8 template's example client keys are never taken as real ones.
    let template = serde_norway::from_str::<serde_norway::Value>(V8_CONFIG).unwrap();
    assert!(core_config_settings_from_value(&template).unwrap().api_keys.is_empty());
}

#[test]
fn v8_values_win_over_legacy_ones_and_provider_groups_are_not_client_keys() {
    let content = "config-version: 8\nhost: 10.0.0.1\nserver:\n  host: 127.0.0.1\nremote-management:\n  secret-key: legacy-secret\nmanagement:\n  secret-key: v8-secret\napi-keys:\n  codex:\n    - name: codex-1\n      keys:\n        - api-key: sk-upstream\n";
    let document = serde_norway::from_str::<serde_norway::Value>(content).unwrap();

    let settings = core_config_settings_from_value(&document).unwrap();
    assert_eq!(settings.host, "127.0.0.1");
    assert_eq!(settings.management_secret_key.as_deref(), Some("v8-secret"));
    assert!(settings.api_keys.is_empty(), "{:?}", settings.api_keys);

    // Writing client keys puts them under access and leaves the upstream groups alone.
    let updated = patch_core_api_keys_yaml(content, &["client-key".to_string()]).unwrap();
    let updated = serde_norway::from_str::<serde_norway::Value>(&updated).unwrap();
    assert_eq!(updated["access"]["api-keys"][0], "client-key");
    assert_eq!(updated["api-keys"]["codex"][0]["keys"][0]["api-key"], "sk-upstream");

    // A setting in both spellings is written at the v8 one, and the old one goes.
    let mut document = document;
    assert!(set_core_yaml_schema_value(
        &mut document,
        &["host"],
        &["server", "host"],
        serde_norway::Value::String("0.0.0.0".to_string()),
    )
    .unwrap());
    assert_eq!(document["server"]["host"], "0.0.0.0");
    assert!(document.get("host").is_none());
    // Taking out the last value of an old section takes the section too: left empty beside its v8 one, the core would
    // clear it by rewriting the file.
    assert!(set_core_yaml_schema_value(
        &mut document,
        &["remote-management", "secret-key"],
        &["management", "secret-key"],
        serde_norway::Value::String("v8-secret".to_string()),
    )
    .unwrap());
    assert!(document.get("remote-management").is_none());
}

#[test]
fn v8_fields_are_used_even_without_the_version_marker() {
    let content = "oauth:\n  auth-dir: /old\nserver:\n  tls:\n    enable: false\n    cert: ''\n    key: ''\n";
    let mut document = serde_norway::from_str::<serde_norway::Value>(content).unwrap();

    assert!(set_core_yaml_auth_dir(&mut document, "/new").unwrap());
    assert_eq!(document["oauth"]["auth-dir"], "/new");
    assert!(document.get("auth-dir").is_none());

    let tls = CoreTlsSettings { enabled: true, cert: "a.crt".to_string(), key: "a.key".to_string() };
    let patched = patch_core_tls_settings_yaml(content, &tls).unwrap().unwrap();
    let patched = serde_norway::from_str::<serde_norway::Value>(&patched).unwrap();
    assert_eq!(patched["server"]["tls"]["enable"], true);
    assert_eq!(patched["server"]["tls"]["cert"], "a.crt");
    assert!(patched.get("tls").is_none());
}

#[test]
fn v8_logging_settings_and_client_keys_are_patched_at_v8_paths() {
    let mut document = serde_norway::from_str::<serde_norway::Value>(V8_CONFIG).unwrap();
    let mut settings = core_config_settings_from_value(&document).unwrap();
    settings.debug = true;
    settings.commercial_mode = true;
    settings.usage_statistics_enabled = true;

    assert!(apply_core_logging_settings(&mut document, &settings).unwrap());
    assert_eq!(document["observability"]["logs"]["debug"], true);
    assert_eq!(document["server"]["commercial-mode"], true);
    assert_eq!(document["observability"]["usage"]["usage-statistics-enabled"], true);
    assert!(document.get("debug").is_none());

    let updated = patch_core_api_keys_yaml(V8_CONFIG, &["only-key".to_string()]).unwrap();
    assert!(updated.contains("  # API keys for authentication"), "{updated}");
    let updated = serde_norway::from_str::<serde_norway::Value>(&updated).unwrap();
    assert_eq!(
        updated["access"]["api-keys"],
        serde_norway::Value::Sequence(vec![serde_norway::Value::String("only-key".to_string())])
    );
    assert!(updated.get("api-keys").is_none());
}

#[test]
fn an_empty_key_list_in_config_yaml_is_shown_empty_and_a_returning_key_gets_its_name_back() {
    let document = serde_norway::from_str::<serde_norway::Value>(V8_CONFIG).unwrap();
    let mut core_settings = core_config_settings_from_value(&document).unwrap();
    let mut config = v8_test_gui_config();
    config.client_key_names = client_key_names_to_keep(&config.api_keys, &[]);

    // Nothing Arbor holds goes back into config.yaml, so it shows the file as it is.
    core_settings.api_keys.clear();
    import_core_settings_to_gui_config(&mut config, &core_settings);
    assert!(config.api_keys.is_empty());
    assert_eq!(config.port, 8317);
    config.client_key_names = client_key_names_to_keep(&config.api_keys, &config.client_key_names);

    // The names wait by fingerprint for their keys.
    core_settings.api_keys = vec!["sk-arbor-one".to_string(), "sk-new".to_string()];
    import_core_settings_to_gui_config(&mut config, &core_settings);
    assert_eq!(gui_api_key_values(&config.api_keys), vec!["sk-arbor-one", "sk-new"]);
    assert_eq!(config.api_keys[0].remark, "One");
    assert!(config.api_keys[1].remark.is_empty());
}

const V8_ALIAS_CONFIG: &str = r#"config-version: 8
access:
  # Client keys
  api-keys:
    - client-key
oauth:
  auth-dir: /tmp/oauth
  # Global OAuth model name aliases
  model-alias:
    codex:
      - name: gpt-5
        alias: g5
requests:
  proxy-url: ""
  payload:
    override:
      - models: [{name: g5, protocol: codex}]
        params: {reasoning.effort: high}
api-keys:
  codex:
    # The team's shared endpoint
    - name: team
      base-url: https://codex.example.com
      models:
        - name: gpt-5
          alias: team-gpt
      keys:
        - api-key: sk-one
        - api-key: sk-two
          weight: 2
"#;

#[test]
fn a_v8_config_is_viewed_in_the_legacy_layout() {
    let view = core_v8_yaml_to_legacy_view(V8_ALIAS_CONFIG).unwrap();
    let view = serde_norway::from_str::<serde_norway::Value>(&view).unwrap();

    assert_eq!(view["api-keys"][0], "client-key");
    assert_eq!(view["oauth-model-alias"]["codex"][0]["alias"], "g5");
    assert_eq!(view["payload"]["override"][0]["params"]["reasoning.effort"], "high");
    assert_eq!(view["oauth"]["auth-dir"], "/tmp/oauth");
    assert!(view["oauth"].get("model-alias").is_none());
    assert!(view.get("access").is_none());
    let codex = view["codex-api-key"].as_sequence().unwrap();
    assert_eq!(codex.len(), 2);
    assert_eq!(codex[0]["api-key"], "sk-one");
    assert_eq!(codex[1]["weight"], 2);
    assert_eq!(codex[1]["base-url"], "https://codex.example.com");
    assert_eq!(codex[1]["models"][0]["alias"], "team-gpt");
    assert!(view.get("gemini-api-key").is_none());

    // Thinking aliases read through the view see the v8 aliases.
    let aliases = thinking_aliases_from_yaml(&serde_norway::to_string(&view).unwrap()).unwrap();
    assert!(aliases.iter().any(|alias| alias.alias == "g5"), "{aliases:?}");

    // Legacy files are left exactly as they are.
    let legacy = "api-keys:\n  - key\noauth-model-alias: {}\n";
    assert_eq!(core_v8_yaml_to_legacy_view(legacy).unwrap(), legacy);
    assert_eq!(legacy_view_changes_to_core_v8_yaml(legacy, "api-keys: []\n").unwrap(), "api-keys: []\n");
}

#[test]
fn legacy_view_edits_go_back_to_their_v8_paths_and_keep_groups() {
    let view = core_v8_yaml_to_legacy_view(V8_ALIAS_CONFIG).unwrap();
    let mut edited = serde_norway::from_str::<serde_norway::Value>(&view).unwrap();
    edited["oauth-model-alias"]["codex"]
        .as_sequence_mut()
        .unwrap()
        .push(serde_norway::from_str("{name: gpt-5, alias: g5-fast, fork: true}").unwrap());
    edited["payload"]["override"][0]["params"]["reasoning.effort"] =
        serde_norway::Value::String("low".to_string());
    // An alias added to the group's shared model list, as every record of the group carries it.
    for record in edited["codex-api-key"].as_sequence_mut().unwrap() {
        record["models"]
            .as_sequence_mut()
            .unwrap()
            .push(serde_norway::from_str("{name: gpt-5, alias: team-fast}").unwrap());
    }
    let edited = serde_norway::to_string(&edited).unwrap();

    let saved = legacy_view_changes_to_core_v8_yaml(V8_ALIAS_CONFIG, &edited).unwrap();
    let document = serde_norway::from_str::<serde_norway::Value>(&saved).unwrap();

    assert!(saved.contains("# Global OAuth model name aliases"), "{saved}");
    assert!(saved.contains("# The team's shared endpoint"), "{saved}");
    assert_eq!(document["oauth"]["model-alias"]["codex"][1]["alias"], "g5-fast");
    assert_eq!(document["requests"]["payload"]["override"][0]["params"]["reasoning.effort"], "low");
    let groups = document["api-keys"]["codex"].as_sequence().unwrap();
    assert_eq!(groups.len(), 1, "{saved}");
    assert_eq!(groups[0]["name"], "team");
    assert_eq!(groups[0]["models"][1]["alias"], "team-fast");
    assert_eq!(groups[0]["keys"].as_sequence().unwrap().len(), 2);
    assert!(groups[0]["keys"][0].get("models").is_none(), "{saved}");
    assert_eq!(document["access"]["api-keys"][0], "client-key");
    for legacy in ["oauth-model-alias", "payload", "codex-api-key"] {
        assert!(document.get(legacy).is_none(), "{legacy} left at the top level:\n{saved}");
    }
    // Viewing the saved file gives back exactly the edited view.
    assert_eq!(
        serde_norway::from_str::<serde_norway::Value>(&core_v8_yaml_to_legacy_view(&saved).unwrap()).unwrap(),
        serde_norway::from_str::<serde_norway::Value>(&edited).unwrap()
    );

    // A change to one key's models becomes that key's own override.
    let mut one_key = serde_norway::from_str::<serde_norway::Value>(&view).unwrap();
    one_key["codex-api-key"][1]["models"] = serde_norway::from_str("[{name: gpt-5, alias: two-only}]").unwrap();
    let saved = legacy_view_changes_to_core_v8_yaml(
        V8_ALIAS_CONFIG,
        &serde_norway::to_string(&one_key).unwrap(),
    )
    .unwrap();
    let document = serde_norway::from_str::<serde_norway::Value>(&saved).unwrap();
    let group = &document["api-keys"]["codex"][0];
    assert_eq!(group["models"][0]["alias"], "team-gpt");
    assert!(group["keys"][0].get("models").is_none());
    assert_eq!(group["keys"][1]["models"][0]["alias"], "two-only");
}

#[test]
fn legacy_sections_in_a_v8_file_are_edited_where_they_are() {
    // An older Arbor merged legacy keys into the v8 template; the core still reads them while no v8 value
    // overrides them, so edits stay there rather than splitting one section across both spellings.
    let file = "config-version: 8\noauth:\n  auth-dir: /tmp/oauth\noauth-model-alias: {}\ncodex-api-key:\n  - api-key: sk-legacy\n    models: []\n";
    let mut edited = serde_norway::from_str::<serde_norway::Value>(&core_v8_yaml_to_legacy_view(file).unwrap()).unwrap();
    edited["oauth-model-alias"] = serde_norway::from_str("{codex: [{name: gpt-5, alias: g5}]}").unwrap();
    edited["codex-api-key"][0]["models"] = serde_norway::from_str("[{name: gpt-5, alias: legacy-alias}]").unwrap();

    let saved = legacy_view_changes_to_core_v8_yaml(file, &serde_norway::to_string(&edited).unwrap()).unwrap();
    let document = serde_norway::from_str::<serde_norway::Value>(&saved).unwrap();
    assert_eq!(document["oauth-model-alias"]["codex"][0]["alias"], "g5");
    assert_eq!(document["codex-api-key"][0]["models"][0]["alias"], "legacy-alias");
    assert!(document["oauth"].get("model-alias").is_none());
    assert!(document.get("api-keys").is_none());
}

/// Arbor's folders under one data root: the core beside `oauth`, which holds the credentials.
fn oauth_layout(name: &str) -> (PathBuf, PathBuf, PathBuf) {
    let root = agent_test_home(name);
    let install_dir = root.join("cpa-core");
    let persistent = root.join(OAUTH_DIR_NAME);
    fs::create_dir_all(&install_dir).unwrap();
    fs::create_dir_all(&persistent).unwrap();
    fs::write(persistent.join("claude-account.json"), b"{}").unwrap();
    (root, install_dir, persistent)
}

#[test]
fn relative_oauth_dir_recovers_existing_persistent_credentials() {
    let (root, install_dir, persistent) = oauth_layout("oauth-recover-relative");
    for spelling in ["oauth", "./oauth", "oauth/./", "../cpa-core/oauth"] {
        let mut config = GuiConfigFile { auth_dir: spelling.to_string(), ..GuiConfigFile::default() };
        assert!(recover_relative_oauth_dir(&mut config, &install_dir, &persistent).unwrap(), "{spelling}");
        assert_eq!(config.auth_dir, DEFAULT_AUTH_DIR);
    }
    let mut absolute = GuiConfigFile { auth_dir: path_to_string(&install_dir.join("oauth")), ..GuiConfigFile::default() };
    assert!(recover_relative_oauth_dir(&mut absolute, &install_dir, &persistent).unwrap());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn oauth_recovery_keeps_a_core_folder_that_holds_credentials_or_has_nothing_to_recover() {
    let (root, install_dir, persistent) = oauth_layout("oauth-recover-keep");
    // The core's own folder already has credentials: they're in use, so it stays.
    fs::create_dir_all(install_dir.join("oauth")).unwrap();
    fs::write(install_dir.join("oauth").join("codex.json"), b"{}").unwrap();
    let mut config = GuiConfigFile { auth_dir: "oauth".to_string(), ..GuiConfigFile::default() };
    assert!(!recover_relative_oauth_dir(&mut config, &install_dir, &persistent).unwrap());
    assert_eq!(config.auth_dir, "oauth");
    fs::remove_file(install_dir.join("oauth").join("codex.json")).unwrap();

    // Arbor's folder is empty: there's nothing to point back at.
    fs::remove_file(persistent.join("claude-account.json")).unwrap();
    assert!(!recover_relative_oauth_dir(&mut config, &install_dir, &persistent).unwrap());
    assert_eq!(config.auth_dir, "oauth");

    // A folder somewhere else is the user's choice.
    fs::write(persistent.join("claude-account.json"), b"{}").unwrap();
    let mut custom = GuiConfigFile { auth_dir: "/Volumes/keys/oauth".to_string(), ..GuiConfigFile::default() };
    assert!(!recover_relative_oauth_dir(&mut custom, &install_dir, &persistent).unwrap());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn oauth_recovery_counts_linked_credentials() {
    let (root, install_dir, persistent) = oauth_layout("oauth-recover-links");
    fs::remove_file(persistent.join("claude-account.json")).unwrap();
    let elsewhere = root.join("elsewhere.json");
    fs::write(&elsewhere, b"{}").unwrap();
    std::os::unix::fs::symlink(&elsewhere, persistent.join("linked.json")).unwrap();
    let mut config = GuiConfigFile { auth_dir: "oauth".to_string(), ..GuiConfigFile::default() };
    assert!(recover_relative_oauth_dir(&mut config, &install_dir, &persistent).unwrap());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn oauth_recovery_keeps_the_config_when_the_core_config_cannot_be_patched() {
    let (root, install_dir, persistent) = oauth_layout("oauth-recover-patch-fails");
    let mut config = GuiConfigFile { auth_dir: "oauth".to_string(), ..GuiConfigFile::default() };
    let error = migrate_auth_dir_at(&mut config, &install_dir, &persistent, |_| Err("read-only".to_string())).unwrap_err();
    assert!(error.contains("read-only"));
    assert_eq!(config.auth_dir, "oauth");

    let mut written = None;
    assert!(migrate_auth_dir_at(&mut config, &install_dir, &persistent, |dir| {
        written = Some(dir.to_string());
        Ok(())
    })
    .unwrap());
    assert_eq!(config.auth_dir, DEFAULT_AUTH_DIR);
    assert_eq!(written.as_deref(), Some(DEFAULT_AUTH_DIR));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn v8_alias_projection_normalizes_empty_parents_but_preserves_siblings() {
    let parse = |text: &str| serde_norway::from_str::<serde_norway::Value>(&core_v8_yaml_to_legacy_view(text).unwrap()).unwrap();
    // A rolled-back save can leave empty parents behind; they read as if they weren't there.
    assert_eq!(parse("config-version: 8\nport: 8317\n"), parse("config-version: 8\nport: 8317\noauth: {}\nrequests: {}\naccess: {}\n"));
    // A parent with other settings keeps them.
    let view = parse("config-version: 8\noauth:\n  auth-dir: ../oauth\n  model-alias: {}\nrequests:\n  payload: {}\n");
    assert_eq!(view["oauth"]["auth-dir"], serde_norway::Value::from("../oauth"));
    assert!(view.get("requests").is_none());
    assert!(view.get("payload").is_some());
}

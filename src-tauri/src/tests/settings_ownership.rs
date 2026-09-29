use super::support::*;
use super::*;

const OLD_GUI_CONFIG: &str = r#"# kept by hand
silent-start = true
port = 7000
allow-lan = true
host = "0.0.0.0"
auth-dir = "/tmp/old-oauth"
management-secret-key = "owner-management-secret"
usage-statistics-enabled = false
routing-strategy = "fill-first"
request-retry = 9
api-keys = [{ key = "desk-key", remark = "Desk" }, { key = "gone-key", remark = "Gone" }]
paused-api-keys = [{ key = "paused-key", remark = "Paused" }]
"#;

const CORE_CONFIG: &str = "host: 127.0.0.1\nport: 8317\nauth-dir: ../oauth\nusage-statistics-enabled: true\nrouting:\n  strategy: round-robin\napi-keys:\n  - desk-key\n  - new-key\n";

fn core_settings(yaml: &str) -> CoreConfigSettings {
    core_config_settings_from_value(&serde_norway::from_str::<serde_norway::Value>(yaml).unwrap()).unwrap()
}

#[test]
fn an_old_config_toml_takes_the_core_settings_from_config_yaml_and_keeps_its_key_names() {
    let home = agent_test_home("one-owner-move");
    let path = home.join("config.toml");
    fs::write(&path, OLD_GUI_CONFIG).unwrap();
    assert!(gui_config_holds_core_settings(OLD_GUI_CONFIG));

    let mut config = toml::from_str::<GuiConfigFile>(OLD_GUI_CONFIG).unwrap();
    let presence = toml::from_str::<GuiConfigPresence>(OLD_GUI_CONFIG).unwrap();
    take_core_settings_at_load(&mut config, presence.api_keys.is_some(), &core_settings(CORE_CONFIG));
    // config.yaml's values, not the copies.
    assert_eq!((config.host.as_str(), config.port), ("127.0.0.1", 8317));
    assert!(config.usage_statistics_enabled);
    assert_eq!(config.routing_strategy, "round-robin");
    assert_eq!(config.request_retry, 0);
    assert_eq!(gui_api_key_values(&config.api_keys), vec!["desk-key", "new-key"]);
    assert_eq!(config.api_keys[0].remark, "Desk");

    sanitize_gui_config(&mut config).unwrap();
    write_gui_config_to_path(&config, &path).unwrap();
    let content = fs::read_to_string(&path).unwrap();
    assert!(!gui_config_holds_core_settings(&content), "{content}");
    assert!(content.contains("# kept by hand"));
    assert!(content.contains("silent-start = true"));
    assert!(content.contains("management-secret-key = \"owner-management-secret\""));
    assert!(content.contains("paused-key"), "a paused key waits here, as the core has no pause");
    // A name is filed by the key's fingerprint, so the file holds no second copy of an active key.
    assert!(!content.contains("desk-key"), "{content}");
    assert!(content.contains(&usage::hash_text("desk-key")));

    // Loaded again, the name finds its key by fingerprint.
    let mut reloaded = toml::from_str::<GuiConfigFile>(&content).unwrap();
    let presence = toml::from_str::<GuiConfigPresence>(&content).unwrap();
    take_core_settings_at_load(&mut reloaded, presence.api_keys.is_some(), &core_settings(CORE_CONFIG));
    assert_eq!(reloaded.api_keys, config.api_keys);
    assert_eq!(reloaded.paused_api_keys, config.paused_api_keys);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn the_default_keys_first_name_does_not_stand_in_for_the_one_the_owner_gave_it() {
    let names = client_key_names_to_keep(
        &[GuiApiKeyEntry { key: DEFAULT_API_KEY.to_string(), remark: "Office".to_string() }],
        &[],
    );
    let mut config = GuiConfigFile { client_key_names: names, ..GuiConfigFile::default() };
    let yaml = format!("port: 8317\napi-keys:\n  - '{DEFAULT_API_KEY}'\n");
    take_core_settings_at_load(&mut config, false, &core_settings(&yaml));
    assert_eq!(config.api_keys[0].remark, "Office");
}

#[test]
fn the_old_config_toml_is_backed_up_once() {
    let home = agent_test_home("one-owner-backup");
    let path = home.join("config.toml");
    fs::write(&path, OLD_GUI_CONFIG).unwrap();
    back_up_gui_config_before_one_owner(&path).unwrap();
    let backup = home.join("config.toml.pre-one-owner");
    assert_eq!(fs::read_to_string(&backup).unwrap(), OLD_GUI_CONFIG);

    // A downgrade writes the copies back; the upgrade after it leaves the first backup alone.
    fs::write(&path, "port = 1\n").unwrap();
    back_up_gui_config_before_one_owner(&path).unwrap();
    assert_eq!(fs::read_to_string(&backup).unwrap(), OLD_GUI_CONFIG);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn client_key_names_follow_their_keys_by_fingerprint() {
    let entry = |key: &str, remark: &str| GuiApiKeyEntry { key: key.to_string(), remark: remark.to_string() };
    let name = |key: &str, remark: &str| GuiClientKeyName {
        api_key_hash: usage::hash_text(key),
        remark: remark.to_string(),
    };
    let kept = vec![name("away-key", "Away"), name("cleared-key", "Old name")];

    let names = client_key_names_to_keep(
        &[entry("named-key", " Named "), entry("cleared-key", ""), entry("plain-key", "")],
        &kept,
    );
    // A key the core doesn't list right now keeps its name; clearing a listed key's name clears it.
    assert_eq!(names, vec![name("away-key", "Away"), name("named-key", "Named")]);

    // Only a key Arbor didn't have gets its kept name back.
    let mut keys = vec![entry("away-key", ""), entry("named-key", "")];
    name_returning_client_keys(&mut keys, &[entry("named-key", "")], &names);
    assert_eq!(keys, vec![entry("away-key", "Away"), entry("named-key", "")]);

    // A config.toml changed outside Arbor gives the names that count.
    rename_client_keys(&mut keys, &[name("named-key", "Edited")]);
    assert_eq!(keys, vec![entry("away-key", ""), entry("named-key", "Edited")]);
}

#[test]
fn a_config_toml_changed_outside_arbor_keeps_config_yamls_core_settings() {
    let current = GuiConfigFile {
        port: 9000,
        routing_strategy: "fill-first".to_string(),
        usage_statistics_enabled: true,
        api_keys: vec![GuiApiKeyEntry { key: "desk-key".to_string(), remark: "Desk".to_string() }],
        ..GuiConfigFile::default()
    };
    let mut changed = toml::from_str::<GuiConfigFile>(OLD_GUI_CONFIG).unwrap();
    keep_core_settings(&current, &mut changed);
    assert_eq!(changed.port, 9000);
    assert_eq!(changed.host, "127.0.0.1");
    assert_eq!(changed.routing_strategy, "fill-first");
    assert!(changed.usage_statistics_enabled);
    assert_eq!(changed.api_keys, current.api_keys);
    // Arbor's own settings are the file's.
    assert!(changed.silent_start);
    assert_eq!(changed.management_secret_key, "owner-management-secret");
}

#[test]
fn a_config_yaml_value_arbor_does_not_offer_does_not_stop_arbor_saving_its_own() {
    let home = agent_test_home("one-owner-foreign-value");
    let config = GuiConfigFile {
        routing_strategy: "weighted-round-robin".to_string(),
        management_secret_key: "owner-management-secret".to_string(),
        ..GuiConfigFile::default()
    };
    assert!(validate_gui_config(&config).is_err());
    assert!(validate_arbor_settings(&config).is_ok());
    write_gui_config_to_path(&config, &home.join("config.toml")).unwrap();
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn a_running_core_keeps_arbor_on_its_host_and_port_until_it_restarts() {
    let state = GuiConfigState::new(GuiConfigFile {
        port: 9000,
        management_secret_key: "owner-management-secret".to_string(),
        ..GuiConfigFile::default()
    });
    let moved = core_settings("host: 0.0.0.0\nport: 8400\nrouting:\n  strategy: fill-first\n");

    let config = state.replace_core_settings_external(&moved, true).unwrap();
    assert_eq!((config.host.as_str(), config.port, config.allow_lan), ("127.0.0.1", 9000, false));
    assert_eq!(config.routing_strategy, "fill-first");

    let config = state.replace_core_settings_external(&moved, false).unwrap();
    assert_eq!((config.host.as_str(), config.port, config.allow_lan), ("0.0.0.0", 8400, true));
}

#[test]
fn a_missing_port_is_given_arbors_and_the_management_key_is_kept_in_step() {
    let config = GuiConfigFile {
        port: 9527,
        management_secret_key: "owner-management-secret".to_string(),
        ..GuiConfigFile::default()
    };
    let v8 = "config-version: 8\nserver:\n  host: 127.0.0.1\nmanagement:\n  secret-key: $2a$10$hashed\n";
    let document =
        serde_norway::from_str::<serde_norway::Value>(&keep_core_config_reachable(v8, &config).unwrap()).unwrap();
    assert_eq!(document["server"]["port"], 9527);
    assert_eq!(document["server"]["host"], "127.0.0.1");
    assert_eq!(document["management"]["secret-key"], "owner-management-secret");
    assert!(document.get("port").is_none());
}

#[test]
fn clearing_a_keys_name_keeps_it_cleared_and_a_deleted_keys_name_goes() {
    let named = GuiApiKeyEntry { key: "desk-key".to_string(), remark: "Desk".to_string() };
    let mut config = GuiConfigFile {
        api_keys: vec![named.clone()],
        client_key_names: client_key_names_to_keep(&[named], &[]),
        ..GuiConfigFile::default()
    };
    let settings = CoreConfigSettings { api_keys: vec!["desk-key".to_string()], ..CoreConfigSettings::from(&config) };
    let cleared = GuiApiKeyEntry { key: "desk-key".to_string(), remark: String::new() };
    apply_core_settings_to_gui_config(&mut config, &settings, Some(&cleared));
    assert!(config.api_keys[0].remark.is_empty());
    assert!(client_key_names_to_keep(&config.api_keys, &config.client_key_names).is_empty());

    config.client_key_names = client_key_names_to_keep(
        &[GuiApiKeyEntry { key: "desk-key".to_string(), remark: "Desk".to_string() }],
        &[],
    );
    forget_client_key_name(&mut config, " desk-key ");
    assert!(config.client_key_names.is_empty());
}

#[test]
fn a_config_yaml_without_a_host_is_read_as_every_interface_as_the_core_runs_it() {
    let mut config = GuiConfigFile {
        management_secret_key: "owner-management-secret".to_string(),
        ..GuiConfigFile::default()
    };
    let settings = core_settings("port: 8317\n");
    assert_eq!(settings.host, "");
    apply_core_settings_to_gui_config(&mut config, &settings, None);
    sanitize_gui_config(&mut config).unwrap();
    assert_eq!((config.host.as_str(), config.allow_lan), ("0.0.0.0", true));
}

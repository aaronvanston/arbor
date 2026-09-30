use super::*;

#[test]
fn agent_api_key_uses_first_configured_key_and_falls_back_when_empty() {
    let mut config = GuiConfigFile {
        api_keys: vec![GuiApiKeyEntry {
            key: "custom-agent-key".to_string(),
            remark: String::new(),
        }],
        ..GuiConfigFile::default()
    };
    assert_eq!(effective_agent_api_key(&config), "custom-agent-key");

    config.api_keys.clear();
    assert_eq!(effective_agent_api_key(&config), LEGACY_DEFAULT_API_KEY);
}

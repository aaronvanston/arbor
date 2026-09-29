use super::support::*;
use super::*;

#[test]
fn paused_api_keys_are_written_to_the_gui_config_and_read_back() {
    let home = agent_test_home("gui-paused-keys");
    let path = home.join("config.toml");
    let paused = GuiApiKeyEntry {
        key: "paused-key".to_string(),
        remark: "Cedar 01".to_string(),
    };
    let config = GuiConfigFile {
        auth_dir: path_to_string(&home.join("auth")),
        management_secret_key: "test-secret".to_string(),
        paused_api_keys: vec![paused.clone()],
        ..GuiConfigFile::default()
    };

    write_gui_config_to_path(&config, &path).unwrap();
    let content = fs::read_to_string(&path).unwrap();
    let written = toml::from_str::<GuiConfigFile>(&content).unwrap();
    assert_eq!(written.paused_api_keys, vec![paused]);
    // Active keys are config.yaml's alone.
    assert!(!content.lines().any(|line| line.starts_with("api-keys =")), "{content}");

    // Resuming the last one takes the entry out of the file again.
    write_gui_config_to_path(&GuiConfigFile { paused_api_keys: Vec::new(), ..config }, &path).unwrap();
    assert!(!fs::read_to_string(&path).unwrap().contains("paused-api-keys"));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn the_zoom_step_is_written_to_the_gui_config_and_read_back() {
    let home = agent_test_home("gui-zoom");
    let path = home.join("config.toml");
    let config = GuiConfigFile {
        auth_dir: path_to_string(&home.join("auth")),
        management_secret_key: "test-secret".to_string(),
        zoom_step: 3,
        ..GuiConfigFile::default()
    };

    write_gui_config_to_path(&config, &path).unwrap();
    let content = fs::read_to_string(&path).unwrap();
    assert!(content.contains("zoom-step = 3"));
    let written = toml::from_str::<GuiConfigFile>(&content).unwrap();
    assert_eq!(written.zoom_step, 3);

    // Back to actual size, and saved as that rather than left at the old step.
    write_gui_config_to_path(&GuiConfigFile { zoom_step: 0, ..config }, &path).unwrap();
    let written = toml::from_str::<GuiConfigFile>(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(written.zoom_step, 0);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn a_config_without_a_zoom_is_at_actual_size_and_one_out_of_range_is_brought_in() {
    assert_eq!(toml::from_str::<GuiConfigFile>("port = 8317\n").unwrap().zoom_step, 0);

    let mut config = toml::from_str::<GuiConfigFile>("zoom-step = 12\n").unwrap();
    assert!(sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.zoom_step, zoom::ZOOM_MAX_STEP);

    config.zoom_step = -40;
    assert!(sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.zoom_step, zoom::ZOOM_MIN_STEP);
    assert!(!sanitize_gui_config(&mut config).unwrap());
}

#[test]
fn a_settings_file_changed_outside_arbor_brings_its_zoom_in_and_hands_back_the_one_it_replaced() {
    let state = GuiConfigState::new(GuiConfigFile {
        zoom_step: 1,
        ..GuiConfigFile::default()
    });

    let replaced = state
        .replace_external(GuiConfigFile {
            zoom_step: 12,
            ..GuiConfigFile::default()
        })
        .unwrap();
    assert_eq!(replaced.zoom_step, 1);
    // Held within the range, so the next Zoom Out steps down from the largest rather than from 12.
    assert_eq!(state.snapshot().unwrap().zoom_step, zoom::ZOOM_MAX_STEP);

    let replaced = state
        .replace_external(GuiConfigFile {
            zoom_step: -1,
            ..GuiConfigFile::default()
        })
        .unwrap();
    assert_eq!(replaced.zoom_step, zoom::ZOOM_MAX_STEP);
    assert_eq!(state.snapshot().unwrap().zoom_step, -1);
}

#[test]
fn gui_field_edit_preserves_comments_and_unknown_configuration() {
    let home = agent_test_home("gui-field-edit");
    let path = home.join("config.toml");
    fs::write(
            &path,
            "# keep this comment\ncustom-option = \"keep\"\ncodex-session-repair-on-launch = true\nclaude-code-working-directory = \"legacy\"\nclaude-code-working-directory-prompt-disabled = true\ndefault-terminal = \"ghostty\"\nprefer-gitcode-downloads = true\nport = 7000\n\n[third-party]\nenabled = true\n",
        )
        .unwrap();
    let config = GuiConfigFile {
        port: 9527,
        host: "0.0.0.0".to_string(),
        allow_lan: true,
        silent_start: true,
        auth_dir: path_to_string(&home.join("custom-auth")),
        management_secret_key: "custom-secret".to_string(),
        usage_statistics_enabled: false,
        disable_cooling: true,
        download_source: VersionDownloadSource::GhFast,
        ..GuiConfigFile::default()
    };

    write_gui_config_to_path(&config, &path).unwrap();
    let content = fs::read_to_string(&path).unwrap();
    assert!(content.contains("# keep this comment"));
    assert!(content.contains("custom-option = \"keep\""));
    assert!(content.contains("[third-party]"));
    assert!(content.contains("silent-start = true"));
    assert!(content.contains("management-secret-key = \"custom-secret\""));
    assert!(content.contains("download-source = \"gh-fast\""));
    assert!(!content.contains("prefer-gitcode-downloads"));
    assert!(!content.contains("codex-session-repair-on-launch"));
    assert!(!content.contains("claude-code-working-directory"));
    assert!(!content.contains("default-terminal"));
    // The core's settings are config.yaml's, and an old copy of one goes too.
    for key in CORE_OWNED_GUI_KEYS {
        assert!(
            !content.lines().any(|line| line.starts_with(&format!("{key} ="))),
            "{key}: {content}"
        );
    }
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn software_write_hash_suppresses_only_the_matching_file_content() {
    let home = agent_test_home("write-hash");
    let path = home.join("config.toml");
    write_bytes_directly(&path, b"port = 8317\n").unwrap();
    assert!(consume_software_write(&path));
    assert!(!consume_software_write(&path));
    write_bytes_directly(&path, b"port = 8317\n").unwrap();
    fs::write(&path, b"port = 9000\n").unwrap();
    assert!(!consume_software_write(&path));
    fs::write(&path, b"port = 8317\n").unwrap();
    assert!(!consume_software_write(&path));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn configuration_watcher_uses_the_nearest_existing_parent() {
    let home = agent_test_home("watch-parent");
    let target = home.join("nested/client/config.json");

    assert_eq!(
        nearest_existing_watch_directory(&target),
        Some(home.clone())
    );
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    assert_eq!(
        nearest_existing_watch_directory(&target),
        target.parent().map(Path::to_path_buf)
    );

    fs::remove_dir_all(home).unwrap();
}

#[test]
fn silent_start_defaults_off_and_requires_tray_support() {
    let legacy = toml::from_str::<GuiConfigFile>("port = 8317\n").unwrap();
    assert!(legacy.start_core_on_launch);
    assert!(!legacy.silent_start);
    assert!(!should_start_hidden(&legacy));

    let enabled = GuiConfigFile {
        silent_start: true,
        ..GuiConfigFile::default()
    };
    assert!(should_start_hidden(&enabled));
}

#[test]
fn gui_window_size_is_clamped_and_requires_both_dimensions() {
    let mut config = GuiConfigFile {
        window_width: Some(320),
        window_height: Some(30_000),
        ..GuiConfigFile::default()
    };

    assert!(sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.window_width, Some(MIN_MAIN_WINDOW_WIDTH));
    assert_eq!(config.window_height, Some(MAX_SAVED_WINDOW_DIMENSION));

    config.window_height = None;
    assert!(sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.window_width, None);
    assert_eq!(config.window_height, None);
}

#[test]
fn legacy_default_window_size_migrates_to_current_default() {
    let mut config = GuiConfigFile {
        window_width: Some(LEGACY_DEFAULT_MAIN_WINDOW_WIDTH),
        window_height: Some(LEGACY_DEFAULT_MAIN_WINDOW_HEIGHT),
        ..GuiConfigFile::default()
    };

    assert!(sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.window_width, Some(DEFAULT_MAIN_WINDOW_WIDTH));
    assert_eq!(config.window_height, Some(DEFAULT_MAIN_WINDOW_HEIGHT));
}

#[test]
fn physical_window_size_uses_display_scale_and_ignores_minimized_sizes() {
    let physical_size = tauri::PhysicalSize::new(1500, 1000);
    assert_eq!(
        logical_window_size_from_physical(&physical_size, 1.25),
        Some(SavedWindowSize {
            width: 1200,
            height: 800,
        })
    );
    assert!(logical_window_size_from_physical(&tauri::PhysicalSize::new(0, 0), 1.0).is_none());
    assert!(logical_window_size_from_physical(&physical_size, 0.0).is_none());
}

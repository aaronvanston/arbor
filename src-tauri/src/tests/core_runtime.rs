use super::support::*;
use super::*;

#[test]
fn executable_path_matching_keeps_core_instances_directory_scoped() {
    let root = agent_test_home("core-process-path-scope");
    let first_dir = root.join("first").join("core");
    let second_dir = root.join("second").join("core");
    fs::create_dir_all(&first_dir).unwrap();
    fs::create_dir_all(&second_dir).unwrap();
    let first_binary = first_dir.join(core_binary_name());
    let second_binary = second_dir.join(core_binary_name());
    fs::write(&first_binary, b"first").unwrap();
    fs::write(&second_binary, b"second").unwrap();

    assert!(executable_paths_match(&first_binary, &first_binary));
    assert!(!executable_paths_match(&first_binary, &second_binary));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn core_process_discovery_sleep_helper() {
    if env::var_os("EASYCLIPROXYAPI_PROCESS_DISCOVERY_TEST_HELPER").is_some() {
        thread::sleep(Duration::from_secs(10));
    }
}

fn core_child_sleep_command() -> Command {
    let mut command = Command::new(env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "tests::core_runtime::core_process_discovery_sleep_helper",
            "--nocapture",
        ])
        .env("EASYCLIPROXYAPI_PROCESS_DISCOVERY_TEST_HELPER", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_background_command(&mut command);
    command
}

fn assert_core_child_survives(mut child: Child) {
    thread::sleep(Duration::from_millis(200));
    let status = child.try_wait();
    let _ = child.kill();
    let _ = child.wait();
    assert!(status.unwrap().is_none(), "core exited with its launcher");
}

#[test]
fn core_child_survives_launcher_thread_exit() {
    let child = thread::spawn(|| spawn_core_child(core_child_sleep_command()).unwrap())
        .join()
        .unwrap();
    assert_core_child_survives(child);
}

#[test]
fn core_child_survives_blocking_runtime_shutdown() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let child = runtime
        .block_on(runtime.spawn_blocking(|| spawn_core_child(core_child_sleep_command()).unwrap()))
        .unwrap();
    drop(runtime);
    assert_core_child_survives(child);
}

#[test]
fn running_core_process_discovery_ignores_the_same_binary_name_in_another_directory() {
    let root = agent_test_home("running-core-process-scope");
    let first_dir = root.join("first").join("core");
    let second_dir = root.join("second").join("core");
    fs::create_dir_all(&first_dir).unwrap();
    fs::create_dir_all(&second_dir).unwrap();
    let first_binary = first_dir.join(core_binary_name());
    let second_binary = second_dir.join(core_binary_name());

    let source_binary = env::current_exe().unwrap();
    fs::copy(&source_binary, &first_binary).unwrap();
    fs::copy(&source_binary, &second_binary).unwrap();
    let arguments = [
        "--exact",
        "tests::core_runtime::core_process_discovery_sleep_helper",
        "--nocapture",
    ];
    let mut first = Command::new(&first_binary)
        .args(&arguments)
        .env("EASYCLIPROXYAPI_PROCESS_DISCOVERY_TEST_HELPER", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut second = Command::new(&second_binary)
        .args(&arguments)
        .env("EASYCLIPROXYAPI_PROCESS_DISCOVERY_TEST_HELPER", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    thread::sleep(Duration::from_millis(200));

    let first_running = first.try_wait().unwrap().is_none();
    let second_running = second.try_wait().unwrap().is_none();
    let candidate_process_ids = find_candidate_core_process_ids();
    let first_actual_path = process_executable_path(first.id());
    let second_actual_path = process_executable_path(second.id());
    let first_matches = find_core_process_ids(&first_binary);
    let second_matches = find_core_process_ids(&second_binary);

    let _ = first.kill();
    let _ = second.kill();
    let _ = first.wait();
    let _ = second.wait();
    assert_eq!(
        first_matches,
        vec![first.id()],
        "running={first_running}, candidate={}, actual={first_actual_path:?}, expected={first_binary:?}",
        candidate_process_ids.contains(&first.id())
    );
    assert_eq!(
        second_matches,
        vec![second.id()],
        "running={second_running}, candidate={}, actual={second_actual_path:?}, expected={second_binary:?}",
        candidate_process_ids.contains(&second.id())
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn current_process_executable_path_can_be_resolved() {
    let expected = env::current_exe().unwrap();
    let actual = process_executable_path(std::process::id()).unwrap();
    assert!(executable_paths_match(&expected, &actual));
}

#[test]
fn core_process_state_tracks_and_releases_adopted_processes() {
    let state = CoreProcessState::new(false);
    let binary_path = env::current_exe().unwrap();
    state
        .adopt_process_ids(&binary_path, vec![std::process::id(), std::process::id()])
        .unwrap();

    assert_eq!(state.managed_pid(), Some(std::process::id()));
    assert_eq!(
        state
            .take_adopted_processes()
            .into_iter()
            .map(|process| process.process_id)
            .collect::<Vec<_>>(),
        vec![std::process::id()]
    );
    assert_eq!(state.managed_pid(), None);
}

#[test]
fn quitting_stops_the_core_unless_an_app_update_keeps_it() {
    let kept = CoreProcessState::new(false);
    let kept_id = kept
        .store_child(spawn_core_child(core_child_sleep_command()).unwrap())
        .unwrap();
    kept.keep_through_exit();
    stop_core_for_exit(&kept);
    let survived = is_process_alive(kept_id);
    let _ = stop_core_process_inner(&kept);
    assert!(survived, "an app update's exit stopped the core");

    let quit = CoreProcessState::new(false);
    let quit_id = quit
        .store_child(spawn_core_child(core_child_sleep_command()).unwrap())
        .unwrap();
    stop_core_for_exit(&quit);
    assert!(!is_process_alive(quit_id), "quitting left the core running");
}

#[test]
fn tracked_core_stays_running_when_a_management_port_probe_misses() {
    let state = CoreProcessState::new(false);
    let binary_path = env::current_exe().unwrap();
    let process_id = std::process::id();
    state
        .adopt_process_ids(&binary_path, vec![process_id])
        .unwrap();

    // Port zero cannot be the configured management endpoint. This models a
    // transient failed health probe while the tracked process is still alive.
    let status = current_core_status(Some(&state), Some(0)).unwrap();
    state.clear_adopted_processes().unwrap();

    assert!(status.running);
    assert!(!status.ready);
    assert_eq!(status.process_id, Some(process_id));
}

#[test]
fn tracked_core_is_ready_when_its_management_port_accepts_connections() {
    let state = CoreProcessState::new(false);
    let binary_path = env::current_exe().unwrap();
    let process_id = std::process::id();
    state
        .adopt_process_ids(&binary_path, vec![process_id])
        .unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    let status = current_core_status(Some(&state), Some(port)).unwrap();
    state.clear_adopted_processes().unwrap();

    assert!(status.running);
    assert!(status.ready);
    assert_eq!(status.process_id, Some(process_id));
}

#[test]
fn successful_core_install_remains_successful_when_restart_succeeds() {
    let result = combine_install_and_restart_results(Ok("installed"), Ok(()));
    assert_eq!(result.unwrap(), "installed");
}

#[test]
fn successful_core_install_reports_automatic_restart_failure() {
    let result = combine_install_and_restart_results(Ok("installed"), Err("port busy".into()));
    assert_eq!(
        result.unwrap_err(),
        "Core installed, but failed to automatically resume running: port busy"
    );
}

#[test]
fn failed_core_install_keeps_the_install_error_after_runtime_is_restored() {
    let result =
        combine_install_and_restart_results::<()>(Err("download canceled".into()), Ok(()));
    assert_eq!(result.unwrap_err(), "download canceled");
}

#[test]
fn failed_core_install_reports_restart_failure_too() {
    let result = combine_install_and_restart_results::<()>(
        Err("checksum mismatch".into()),
        Err("port busy".into()),
    );
    assert_eq!(
        result.unwrap_err(),
        "checksum mismatch; also failed to restore the original core running state: port busy"
    );
}

#[test]
fn replacing_a_core_preserves_only_regular_bundled_assets() {
    let root = agent_test_home("bundled-assets");
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    fs::write(
        source.join("CLIProxyAPI_7.2.83_linux_amd64.tar.gz"),
        b"archive",
    )
    .unwrap();
    fs::write(
        source.join("CLIProxyAPI_7.2.83_linux_amd64_no-plugin.tar.gz"),
        b"portable",
    )
    .unwrap();
    fs::write(source.join(CORE_CHECKSUMS_FILE), b"checksums").unwrap();

    preserve_bundled_core_assets(&source, &target).unwrap();

    assert!(target
        .join("CLIProxyAPI_7.2.83_linux_amd64.tar.gz")
        .is_file());
    assert!(!target
        .join("CLIProxyAPI_7.2.83_linux_amd64_no-plugin.tar.gz")
        .exists());
    assert!(target.join(CORE_CHECKSUMS_FILE).is_file());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn overlaying_a_core_updates_packaged_files_and_preserves_plugins() {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;

    let root = agent_test_home("core-overlay-preserves-plugins");
    let install_dir = root.join("core");
    let staging_dir = root.join("core.staging");
    fs::create_dir_all(install_dir.join("plugins/custom-router")).unwrap();
    fs::create_dir_all(staging_dir.join("plugins/bundled-router")).unwrap();
    fs::create_dir_all(staging_dir.join("runtime")).unwrap();
    fs::write(install_dir.join(core_binary_name()), b"old core").unwrap();
    fs::write(install_dir.join("README.md"), b"old readme").unwrap();
    fs::write(install_dir.join("user-data.json"), b"user data").unwrap();
    fs::write(
        install_dir.join("plugins/custom-router/plugin.js"),
        b"custom plugin",
    )
    .unwrap();
    fs::write(staging_dir.join(core_binary_name()), b"new core").unwrap();
    fs::write(staging_dir.join("README.md"), b"new readme").unwrap();
    fs::write(
        staging_dir.join("plugins/bundled-router/plugin.js"),
        b"bundled plugin",
    )
    .unwrap();
    fs::write(staging_dir.join("runtime/default.json"), b"new runtime").unwrap();
    #[cfg(unix)]
    let original_binary_inode = fs::metadata(install_dir.join(core_binary_name()))
        .unwrap()
        .ino();

    overlay_install_dir(&install_dir, &staging_dir).unwrap();

    assert_eq!(
        fs::read(install_dir.join(core_binary_name())).unwrap(),
        b"new core"
    );
    assert_eq!(
        fs::read(install_dir.join("README.md")).unwrap(),
        b"new readme"
    );
    assert_eq!(
        fs::read(install_dir.join("runtime/default.json")).unwrap(),
        b"new runtime"
    );
    assert_eq!(
        fs::read(install_dir.join("plugins/custom-router/plugin.js")).unwrap(),
        b"custom plugin"
    );
    assert_eq!(
        fs::read(install_dir.join("plugins/bundled-router/plugin.js")).unwrap(),
        b"bundled plugin"
    );
    assert_eq!(
        fs::read(install_dir.join("user-data.json")).unwrap(),
        b"user data"
    );
    #[cfg(unix)]
    assert_ne!(
        fs::metadata(install_dir.join(core_binary_name()))
            .unwrap()
            .ino(),
        original_binary_inode,
        "The updated core must use a new inode"
    );
    assert!(!staging_dir.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn installing_a_core_into_a_missing_directory_moves_the_complete_staging_tree() {
    let root = agent_test_home("core-overlay-first-install");
    let install_dir = root.join("core");
    let staging_dir = root.join("core.staging");
    fs::create_dir_all(&staging_dir).unwrap();
    fs::write(staging_dir.join(core_binary_name()), b"new core").unwrap();
    fs::write(staging_dir.join(CORE_EXAMPLE_CONFIG_FILE), b"port: 8317\n").unwrap();

    overlay_install_dir(&install_dir, &staging_dir).unwrap();

    assert_eq!(
        fs::read(install_dir.join(core_binary_name())).unwrap(),
        b"new core"
    );
    assert!(install_dir.join(CORE_EXAMPLE_CONFIG_FILE).is_file());
    assert!(!staging_dir.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn replacing_a_core_keeps_the_config_exactly_as_it_is() {
    let root = agent_test_home("core-config-migrate");
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    let old_config = "# Old comment\nhost: 127.0.0.1\nport: 9527\nnested:\n  keep: old\n  old-only: retained\nlist:\n  - old-a\n  - old-b\nextra: true\n";
    let new_template = "# New template\nhost: \"\"\nport: 8317\nnested:\n  keep: new-default\n  added: new-field\nlist:\n  - new-default\nnew-option: true\n";
    fs::write(source.join(CORE_CONFIG_FILE), old_config).unwrap();
    fs::write(target.join(CORE_EXAMPLE_CONFIG_FILE), new_template).unwrap();

    migrate_core_config_for_update(&source, &target).unwrap();

    // Nothing from the template comes along: the core uses its own defaults for what the file leaves out.
    assert_eq!(fs::read_to_string(target.join(CORE_CONFIG_FILE)).unwrap(), old_config);
    assert_eq!(
        fs::read_to_string(target.join(CORE_EXAMPLE_CONFIG_FILE)).unwrap(),
        new_template
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn swapping_in_a_staged_core_keeps_config_changes_made_while_it_waited() {
    let root = agent_test_home("core-staged-swap");
    let install_dir = root.join("core");
    let staging_dir = root.join("core.staging");
    let download_dir = root.join("core.download");
    for dir in [&install_dir, &staging_dir, &download_dir] {
        fs::create_dir_all(dir).unwrap();
    }
    fs::write(install_dir.join(core_binary_name()), b"old core").unwrap();
    fs::write(install_dir.join("plugin.txt"), b"kept").unwrap();
    fs::write(install_dir.join(CORE_CONFIG_FILE), "port: 9527\napi-keys:\n  - before\n").unwrap();
    fs::write(staging_dir.join(core_binary_name()), b"new core").unwrap();
    fs::write(
        staging_dir.join(CORE_EXAMPLE_CONFIG_FILE),
        "# New template\nport: 8317\napi-keys:\n  - your-api-key-1\nnew-option: true\n",
    )
    .unwrap();
    migrate_core_config_for_update(&install_dir, &staging_dir).unwrap();

    // The running core's config changes while the new core waits in staging.
    fs::write(install_dir.join(CORE_CONFIG_FILE), "port: 9527\napi-keys:\n  - after\n").unwrap();
    let staged = StagedCore {
        version: "v7.3.18".to_string(),
        asset_name: "core.tar.gz".to_string(),
        binary_relative_path: PathBuf::from(core_binary_name()),
        bundled: true,
        download_dir: Some(download_dir.clone()),
    };
    let result = swap_in_staged_core(&install_dir, &staging_dir, &staged).unwrap();

    let config = serde_norway::from_str::<serde_norway::Value>(
        &fs::read_to_string(install_dir.join(CORE_CONFIG_FILE)).unwrap(),
    )
    .unwrap();
    assert_eq!(config["api-keys"][0], "after");
    assert!(config.get("new-option").is_none(), "the template's example settings stay out of the config");
    assert_eq!(fs::read(install_dir.join(core_binary_name())).unwrap(), b"new core");
    assert_eq!(fs::read(install_dir.join("plugin.txt")).unwrap(), b"kept");
    assert!(!staging_dir.exists() && !download_dir.exists());
    assert!(!core_needs_bundled_install(&install_dir, "v7.3.18"));
    assert_eq!(
        result.binary_path,
        Some(path_to_string(&install_dir.join(core_binary_name())))
    );
    fs::remove_dir_all(root).unwrap();
}

fn core_update_dirs(name: &str) -> (PathBuf, PathBuf, PathBuf) {
    let root = agent_test_home(name);
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    fs::write(
        target.join(CORE_EXAMPLE_CONFIG_FILE),
        "# New template\nport: 8317\napi-keys:\n  - your-api-key-1\n",
    )
    .unwrap();
    fs::write(target.join(CORE_CONFIG_FILE), "staged: untouched\n").unwrap();
    (root, source, target)
}

#[test]
fn replacing_a_core_cancels_on_invalid_config_and_names_the_file_to_fix() {
    let (root, source, target) = core_update_dirs("core-config-invalid-message");
    let config_path = source.join(CORE_CONFIG_FILE);
    let original =
        "api-keys:\n  - live-key\noauth-model-alias:\n  claude: [broken\npayload:\n  default: []\n";
    fs::write(&config_path, original).unwrap();

    let error = migrate_core_config_for_update(&source, &target).unwrap_err();

    assert!(error.contains(&path_to_string(&config_path)), "{error}");
    assert!(
        error.contains("Fix config.yaml and try the update again"),
        "{error}"
    );
    assert_eq!(fs::read_to_string(&config_path).unwrap(), original);
    assert_eq!(
        fs::read_to_string(target.join(CORE_CONFIG_FILE)).unwrap(),
        "staged: untouched\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn replacing_a_core_cancels_when_the_config_root_is_not_a_mapping() {
    for (index, content) in ["- api-keys\n- payload\n", "just a string\n", "42\n"]
        .into_iter()
        .enumerate()
    {
        let (root, source, target) = core_update_dirs(&format!("core-config-not-mapping-{index}"));
        let config_path = source.join(CORE_CONFIG_FILE);
        fs::write(&config_path, content).unwrap();

        let error = migrate_core_config_for_update(&source, &target).unwrap_err();

        assert!(error.contains("not a YAML mapping"), "{content:?}: {error}");
        assert!(error.contains(&path_to_string(&config_path)), "{error}");
        assert_eq!(fs::read_to_string(&config_path).unwrap(), content);
        assert_eq!(
            fs::read_to_string(target.join(CORE_CONFIG_FILE)).unwrap(),
            "staged: untouched\n"
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn replacing_a_core_cancels_on_non_utf8_config_instead_of_rewriting_it_lossily() {
    let (root, source, target) = core_update_dirs("core-config-non-utf8");
    let config_path = source.join(CORE_CONFIG_FILE);
    let original = b"port: 9527\napi-keys:\n  - caf\xe9-key\n".to_vec();
    fs::write(&config_path, &original).unwrap();

    let error = migrate_core_config_for_update(&source, &target).unwrap_err();

    assert!(error.contains(&path_to_string(&config_path)), "{error}");
    assert_eq!(fs::read(&config_path).unwrap(), original);
    assert_eq!(
        fs::read_to_string(target.join(CORE_CONFIG_FILE)).unwrap(),
        "staged: untouched\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn replacing_a_core_cancels_when_the_config_cannot_be_read() {
    let (root, source, target) = core_update_dirs("core-config-unreadable");
    // A directory in place of config.yaml fails to read without depending on file permissions.
    fs::create_dir_all(source.join(CORE_CONFIG_FILE)).unwrap();

    assert!(
        migrate_core_config_for_update(&source, &target).is_err(),
        "an unreadable configuration must cancel the update rather than fall back to defaults"
    );
    assert!(source.join(CORE_CONFIG_FILE).is_dir());
    assert_eq!(
        fs::read_to_string(target.join(CORE_CONFIG_FILE)).unwrap(),
        "staged: untouched\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn replacing_a_core_uses_the_template_for_an_empty_or_comment_only_config() {
    for (index, content) in ["", "\n\n", "# Only comments here\n# port: 9527\n", "---\n"]
        .into_iter()
        .enumerate()
    {
        let (root, source, target) = core_update_dirs(&format!("core-config-empty-{index}"));
        let config_path = source.join(CORE_CONFIG_FILE);
        fs::write(&config_path, content).unwrap();

        migrate_core_config_for_update(&source, &target).unwrap();

        assert_eq!(
            fs::read_to_string(target.join(CORE_CONFIG_FILE)).unwrap(),
            fs::read_to_string(target.join(CORE_EXAMPLE_CONFIG_FILE)).unwrap(),
            "{content:?} should fall back to the new template"
        );
        assert_eq!(fs::read_to_string(&config_path).unwrap(), content);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn replacing_a_core_without_a_config_leaves_the_staged_files_alone() {
    let (root, source, target) = core_update_dirs("core-config-missing");

    migrate_core_config_for_update(&source, &target).unwrap();

    assert_eq!(
        fs::read_to_string(target.join(CORE_CONFIG_FILE)).unwrap(),
        "staged: untouched\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn bundled_core_install_handles_missing_and_unversioned_binaries() {
    let root = agent_test_home("bundled-bootstrap-detection");
    let install_dir = root.join("core");

    assert!(core_needs_bundled_install(&install_dir, "v7.3.17"));

    let existing_version = install_dir.join("existing-version");
    fs::create_dir_all(&existing_version).unwrap();
    fs::write(existing_version.join(core_binary_name()), b"existing core").unwrap();

    assert!(core_needs_bundled_install(&install_dir, "v7.3.17"));
    assert!(!core_needs_bundled_install(&install_dir, "invalid"));
    fs::remove_dir_all(root).unwrap();
}

fn installed_core(install_dir: &Path, version: &str) {
    write_core_metadata(
        install_dir,
        &CoreMetadata { version: version.to_string(), asset_name: "installed-core.zip".to_string(), installed_at_unix: 0 },
    )
    .unwrap();
}

#[test]
fn a_core_folder_from_1_0_moves_to_core_once_its_core_is_stopped_and_keeps_its_old_name_as_a_link() {
    let root = agent_test_home("legacy-core-folder");
    let legacy = root.join("cpa-core");
    let current = root.join("core");
    fs::create_dir_all(&legacy).unwrap();
    fs::write(legacy.join(core_binary_name()), b"installed core").unwrap();
    fs::write(legacy.join("cpa-gui-meta.json"), r#"{"version":"v7.3.17","assetName":"a.zip","installedAtUnix":0}"#).unwrap();

    // Until it moves, everything uses the old folder, and reads the version file under its old name.
    assert_eq!(core_install_dir_in(&root), legacy);
    assert_eq!(read_core_metadata(&legacy).map(|metadata| metadata.version), Some("v7.3.17".to_string()));

    // A core kept running through the app update has its files open there, so the folder waits.
    let running = legacy.join(core_binary_name());
    assert_eq!(move_legacy_core_folder(&root, |binary| binary == running), Ok(false));
    assert!(fs::symlink_metadata(&legacy).unwrap().is_dir());

    assert_eq!(move_legacy_core_folder(&root, |_| false), Ok(true));
    assert_eq!(core_install_dir_in(&root), current);
    assert_eq!(fs::read_link(&legacy).unwrap(), Path::new("core"));
    // Paths saved with the old name, in config.yaml or by an older version, still reach it.
    assert_eq!(fs::read(legacy.join(core_binary_name())).unwrap(), b"installed core");
    assert_eq!(move_legacy_core_folder(&root, |_| false), Ok(false));

    // The next write gives the version file its new name.
    installed_core(&current, "v7.3.18");
    assert!(!current.join("cpa-gui-meta.json").exists());
    assert_eq!(read_core_metadata(&current).map(|metadata| metadata.version), Some("v7.3.18".to_string()));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn only_a_lone_core_folder_from_1_0_moves() {
    let root = agent_test_home("legacy-core-folder-left");
    // A new install has neither.
    assert_eq!(move_legacy_core_folder(&root, |_| false), Ok(false));
    assert_eq!(core_install_dir_in(&root), root.join("core"));

    // Beside a `core` folder the old one is left as it is.
    fs::create_dir_all(root.join("core")).unwrap();
    fs::create_dir_all(root.join("cpa-core")).unwrap();
    assert_eq!(move_legacy_core_folder(&root, |_| false), Ok(false));
    assert_eq!(core_install_dir_in(&root), root.join("core"));
    assert!(root.join("cpa-core").is_dir() && fs::read_link(root.join("cpa-core")).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_newer_bundled_core_replaces_an_older_install_but_never_downgrades() {
    let root = agent_test_home("bundled-upgrade-detection");
    let install_dir = root.join("core");
    fs::create_dir_all(&install_dir).unwrap();
    fs::write(install_dir.join(core_binary_name()), b"installed core").unwrap();

    for (installed, bundled, should_install) in [
        ("v7.3.9", "v7.3.17", true),
        ("7.3.15", "v7.3.17", true),
        ("v7.3.17-beta.1", "v7.3.17", true),
        ("v7.3.17", "7.3.17", false),
        ("v7.3.18", "v7.3.17", false),
        ("unknown", "v7.3.17", true),
        ("v7.3.15", "invalid", false),
    ] {
        installed_core(&install_dir, installed);
        assert_eq!(core_needs_bundled_install(&install_dir, bundled), should_install, "installed {installed}, bundled {bundled}");
    }

    fs::remove_file(install_dir.join(core_binary_name())).unwrap();
    assert!(core_needs_bundled_install(&install_dir, "v7.3.17"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_core_rolled_back_by_hand_stays_put_on_the_next_launch() {
    let root = agent_test_home("bundled-manual-rollback");
    let install_dir = root.join("core");
    fs::create_dir_all(&install_dir).unwrap();
    let binary = install_dir.join(core_binary_name());
    fs::write(&binary, b"installed core").unwrap();
    installed_core(&install_dir, "v7.3.15");

    // An older core doesn't count as dealing with the bundled one.
    assert!(core_needs_bundled_install(&install_dir, "v7.3.17"));
    remember_bundled_core_when_up_to_date(&install_dir, "v7.3.17").unwrap();
    assert!(core_needs_bundled_install(&install_dir, "v7.3.17"));

    // Once installed, going back to 7.3.15 by hand is left alone; a later bundled version still installs.
    mark_bundled_core_version_handled(&install_dir, "v7.3.17").unwrap();
    assert!(!core_needs_bundled_install(&install_dir, "v7.3.17"));
    assert!(core_needs_bundled_install(&install_dir, "v7.3.18"));

    fs::remove_file(binary).unwrap();
    assert!(core_needs_bundled_install(&install_dir, "v7.3.17"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_core_already_newer_than_the_bundle_counts_as_dealing_with_it() {
    let root = agent_test_home("bundled-newer-manual-rollback");
    let install_dir = root.join("core");
    fs::create_dir_all(&install_dir).unwrap();
    fs::write(install_dir.join(core_binary_name()), b"installed core").unwrap();
    installed_core(&install_dir, "v7.3.18");

    assert!(!core_needs_bundled_install(&install_dir, "v7.3.17"));
    remember_bundled_core_when_up_to_date(&install_dir, "v7.3.17").unwrap();
    installed_core(&install_dir, "v7.3.15");
    assert!(!core_needs_bundled_install(&install_dir, "v7.3.17"));
    assert!(core_needs_bundled_install(&install_dir, "v7.3.19"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn bundled_core_locations_include_macos_app_resources() {
    let contents_dir = agent_test_home("bundled-macos-resources")
        .join("Arbor.app")
        .join("Contents");
    let executable_dir = contents_dir.join("MacOS");
    let base_dir = agent_test_home("bundled-macos-data");
    let resource_location = (
        contents_dir.join("Resources").join(CORE_VERSION_FILE),
        contents_dir.join("Resources").join("core"),
    );

    assert_eq!(
        macos_app_resources_dir(&executable_dir),
        Some(contents_dir.join("Resources"))
    );
    // The app's own Resources win over a stray core-version.txt in the data folder.
    assert_eq!(bundled_core_locations(&base_dir, &executable_dir).first(), Some(&resource_location));
}

#[test]
fn source_project_root_is_detected_from_the_portable_development_directory() {
    let root = agent_test_home("bundled-source-root");
    fs::create_dir_all(root.join("src-tauri")).unwrap();
    fs::create_dir_all(root.join("bin-work")).unwrap();
    fs::write(root.join("package.json"), b"{}").unwrap();

    assert_eq!(
        source_project_root(&root.join("bin-work")),
        Some(root.clone())
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn selected_source_archive_and_checksums_are_copied_into_the_installation() {
    let root = agent_test_home("selected-bundled-asset");
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    let archive = source.join("CLIProxyAPI_7.2.83_linux_amd64.tar.gz");
    fs::write(&archive, b"archive").unwrap();
    fs::write(source.join(CORE_CHECKSUMS_FILE), b"checksums").unwrap();

    preserve_selected_bundled_core_asset(&archive, &target).unwrap();

    assert_eq!(
        fs::read(target.join("CLIProxyAPI_7.2.83_linux_amd64.tar.gz")).unwrap(),
        b"archive"
    );
    assert_eq!(
        fs::read(target.join(CORE_CHECKSUMS_FILE)).unwrap(),
        b"checksums"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rematerializing_core_binary_preserves_bytes_and_cleans_up_temporary_file() {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;

    let root = agent_test_home("core-rematerialize");
    fs::create_dir_all(&root).unwrap();
    let binary_path = root.join(core_binary_name());
    fs::write(&binary_path, b"signed core bytes").unwrap();
    #[cfg(unix)]
    let original_inode = fs::metadata(&binary_path).unwrap().ino();

    rematerialize_core_binary(&binary_path).unwrap();

    assert_eq!(fs::read(&binary_path).unwrap(), b"signed core bytes");
    #[cfg(unix)]
    assert_ne!(fs::metadata(&binary_path).unwrap().ino(), original_inode);
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn core_start_output_helper() {
    if env::var_os("EASYCLIPROXYAPI_CORE_OUTPUT_TEST_HELPER").is_none() {
        return;
    }
    println!("core stdout marker");
    eprintln!("core stderr marker");
}

#[test]
fn core_start_log_captures_stdout_and_stderr() {
    let root = agent_test_home("core-start-output");
    let log_path = root.join("logs").join("core-start-output.log");
    fs::create_dir_all(log_path.parent().unwrap()).unwrap();
    fs::write(&log_path, "stale startup output").unwrap();
    let (stdout, stderr) = core_start_stdio(&log_path).unwrap();
    let mut command = Command::new(env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "tests::core_runtime::core_start_output_helper",
            "--nocapture",
        ])
        .env("EASYCLIPROXYAPI_CORE_OUTPUT_TEST_HELPER", "1")
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    configure_background_command(&mut command);

    assert!(command.status().unwrap().success());

    let output = fs::read_to_string(&log_path).unwrap();
    assert!(output.contains("===== CPA core startup"));
    assert!(output.contains("core stdout marker"));
    assert!(output.contains("core stderr marker"));
    assert!(!output.contains("stale startup output"));
    fs::remove_dir_all(root).unwrap();
}

const V8_TEMPLATE: &str = "# Configuration template using the v8 layout.\nconfig-version: 8\nserver:\n  host: \"\"\n  port: 8317\nmanagement:\n  secret-key: \"\"\naccess:\n  api-keys:\n    - \"your-api-key-1\"\noauth:\n  auth-dir: \"~/.cli-proxy-api\"\n";

#[test]
fn updating_to_a_v8_core_keeps_a_legacy_config_as_it_is() {
    let (root, source, target) = core_update_dirs("core-config-v7-to-v8");
    fs::write(target.join(CORE_EXAMPLE_CONFIG_FILE), V8_TEMPLATE).unwrap();
    let old_config = "# My settings\nhost: 127.0.0.1\nport: 9527\nauth-dir: /Users/someone/oauth\napi-keys:\n  - sk-live-one\n  - sk-live-two\nremote-management:\n  secret-key: live-management-secret\noauth-model-alias:\n  codex:\n    - name: gpt-5\n      alias: g5\n";
    fs::write(source.join(CORE_CONFIG_FILE), old_config).unwrap();

    migrate_core_config_for_update(&source, &target).unwrap();

    // The core migrates a legacy-only file itself; merged into the template, its example values would win.
    let migrated = fs::read_to_string(target.join(CORE_CONFIG_FILE)).unwrap();
    assert_eq!(migrated, old_config);
    let settings =
        core_config_settings_from_value(&serde_norway::from_str(&migrated).unwrap()).unwrap();
    assert_eq!(settings.api_keys, vec!["sk-live-one", "sk-live-two"]);
    assert_eq!(settings.management_secret_key.as_deref(), Some("live-management-secret"));
    assert_eq!(settings.auth_dir, "/Users/someone/oauth");
    assert_eq!(settings.port, 9527);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn updating_between_v8_cores_keeps_the_config_as_it_is() {
    let (root, source, target) = core_update_dirs("core-config-v8-to-v8");
    fs::write(
        target.join(CORE_EXAMPLE_CONFIG_FILE),
        format!("{V8_TEMPLATE}new-section:\n  added: true\n"),
    )
    .unwrap();
    let old_config = "config-version: 8\nserver:\n  host: 127.0.0.1\n  port: 9527\nmanagement:\n  secret-key: live-management-secret\naccess:\n  api-keys:\n    - sk-live\noauth:\n  auth-dir: /Users/someone/oauth\n";
    fs::write(source.join(CORE_CONFIG_FILE), old_config).unwrap();

    migrate_core_config_for_update(&source, &target).unwrap();

    let migrated = fs::read_to_string(target.join(CORE_CONFIG_FILE)).unwrap();
    assert_eq!(migrated, old_config);
    let settings = core_config_settings_from_value(&serde_norway::from_str(&migrated).unwrap()).unwrap();
    assert_eq!(settings.api_keys, vec!["sk-live"]);
    assert_eq!(settings.management_secret_key.as_deref(), Some("live-management-secret"));
    assert_eq!(settings.auth_dir, "/Users/someone/oauth");
    assert_eq!((settings.host.as_str(), settings.port), ("127.0.0.1", 9527));
    fs::remove_dir_all(root).unwrap();
}

/// A new core's template values never win over settings the old file kept elsewhere (or left to the core's default):
/// core 8.0.2's template has usage statistics off and the proxy listening on every interface.
#[test]
fn updating_a_core_never_takes_the_templates_usage_or_host_values() {
    let (root, source, target) = core_update_dirs("core-config-template-values");
    fs::write(
        target.join(CORE_EXAMPLE_CONFIG_FILE),
        format!("{V8_TEMPLATE}observability:\n  usage:\n    usage-statistics-enabled: false\nplugins:\n  configs:\n    example:\n      enabled: true\n"),
    )
    .unwrap();
    for (name, old_config) in [
        ("legacy", "host: 127.0.0.1\nusage-statistics-enabled: true\n"),
        ("v8", "config-version: 8\nserver:\n  host: 127.0.0.1\nobservability:\n  usage:\n    usage-statistics-enabled: true\n"),
    ] {
        fs::write(source.join(CORE_CONFIG_FILE), old_config).unwrap();

        migrate_core_config_for_update(&source, &target).unwrap();

        let migrated = fs::read_to_string(target.join(CORE_CONFIG_FILE)).unwrap();
        assert_eq!(migrated, old_config, "{name}");
        let settings = core_config_settings_from_value(&serde_norway::from_str(&migrated).unwrap()).unwrap();
        assert_eq!(settings.host, "127.0.0.1", "{name}");
        assert!(settings.usage_statistics_enabled, "{name}");
        assert!(!migrated.contains("example"), "{name}");
    }
    fs::remove_dir_all(root).unwrap();
}

/// A copy of an open file with close-on-exec off, as Apple's frameworks leave the files they open, numbered past the
/// ones a shell opens for itself.
#[cfg(target_os = "macos")]
fn inheritable_file() -> libc::c_int {
    use std::os::fd::AsRawFd;

    let file = fs::File::open("/dev/null").unwrap();
    let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD, 100) };
    assert!(fd >= 100);
    fd
}

#[cfg(target_os = "macos")]
fn closes_on_exec(fd: libc::c_int) -> bool {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    flags & libc::FD_CLOEXEC != 0
}

#[cfg(target_os = "macos")]
#[test]
fn keeping_open_files_from_helpers_marks_every_file_but_stdio() {
    let fd = inheritable_file();
    assert!(!closes_on_exec(fd));
    let stdio = [0, 1, 2].map(closes_on_exec);
    keep_open_files_from_helpers();
    assert!(closes_on_exec(fd));
    assert_eq!([0, 1, 2].map(closes_on_exec), stdio, "stdin, stdout and stderr stay as they were");
    unsafe { libc::close(fd) };
}

#[cfg(target_os = "macos")]
#[test]
fn a_background_helper_gets_none_of_arbors_open_files() {
    let mut command = Command::new("/bin/sh");
    configure_background_command(&mut command);
    // Opened after the command was readied, as by another thread while it starts: the mark in the new process
    // catches it.
    let fd = inheritable_file();
    let output = command
        .arg("-c")
        .arg(format!("[ -e /dev/fd/{fd} ] && echo open || echo closed"))
        .stdin(Stdio::null())
        .output()
        .unwrap();
    unsafe { libc::close(fd) };
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "closed");
}

#[cfg(unix)]
#[test]
fn a_helper_left_to_run_on_its_own_is_reaped_once_done() {
    let child = Command::new("/usr/bin/true").spawn().unwrap();
    let pid = child.id() as libc::pid_t;
    crate::system_open::reap_when_done(child);
    let deadline = Instant::now() + Duration::from_secs(5);
    // A zombie still takes signal 0; once reaped, the process is gone.
    while unsafe { libc::kill(pid, 0) } == 0 {
        assert!(Instant::now() < deadline, "the helper was never reaped");
        thread::sleep(Duration::from_millis(20));
    }
}

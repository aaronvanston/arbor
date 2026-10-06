use super::support::*;
use super::*;

#[test]
fn app_update_comparison_uses_semantic_versions() {
    assert!(is_app_update_available("v0.1.9", "v0.2.0").unwrap());
    assert!(is_app_update_available("v0.2.0-beta.1", "v0.2.0").unwrap());
    assert!(!is_app_update_available("v0.2.0", "v0.2.0").unwrap());
    assert!(!is_app_update_available("v0.2.0", "v0.1.9").unwrap());
}

#[test]
fn portable_update_helper_writes_a_distinct_startup_ack() {
    let work_dir = agent_test_home("portable-update-helper-ack");
    acknowledge_portable_update_helper_start(&work_dir).unwrap();

    let ack_path = portable_update_helper_ack_path(&work_dir);
    assert_eq!(
        ack_path.file_name().and_then(|value| value.to_str()),
        Some(PORTABLE_UPDATE_HELPER_ACK_FILE)
    );
    assert_eq!(
        fs::read_to_string(&ack_path).unwrap(),
        std::process::id().to_string()
    );
    assert_ne!(ack_path.file_name().unwrap(), "update-started.ack");
    fs::remove_dir_all(work_dir).unwrap();
}

fn portable_update_test_asset(version: &str, arch: &str) -> PortableUpdateAsset {
    PortableUpdateAsset {
        url: format!("https://github.com/aaronvanston/arbor/releases/download/arbor-v{version}/Arbor-v{version}-Darwin-{arch}.dmg"),
        fallback_urls: Vec::new(),
        sha256: "ab".repeat(32),
        size_bytes: 1024,
    }
}

#[test]
fn portable_update_state_supports_cancellation_and_snapshot_recovery() {
    let state = AppUpdateState::default();
    let pending = PendingAppUpdate {
        version: "1.2.3".to_string(),
        asset: portable_update_test_asset("1.2.3", "amd64"),
        arch: "amd64".to_string(),
        local_file: None,
    };
    state.set_available(AppUpdateTask {
        phase: AppUpdatePhase::Available,
        target_version: Some("1.2.3".to_string()),
        ..AppUpdateTask::default()
    });

    let token = CancellationToken::new();
    state.start(token.clone()).unwrap();
    assert_eq!(state.snapshot().phase, AppUpdatePhase::Checking);
    assert!(state.start(CancellationToken::new()).is_err());
    state.start_download(&pending).unwrap();
    let recovered = state.snapshot();
    assert!(recovered.running);
    assert!(recovered.cancelable);
    assert_eq!(recovered.phase, AppUpdatePhase::Downloading);

    state.cancel();
    assert!(token.is_cancelled());
    let finished = state.finish(AppUpdatePhase::Canceled, Some("canceled".to_string()));
    assert!(!finished.running);
    assert!(!finished.cancelable);
    assert_eq!(state.snapshot().phase, AppUpdatePhase::Canceled);
}

fn pending_app_update(version: &str) -> PendingAppUpdate {
    PendingAppUpdate {
        version: format!("v{version}"),
        asset: portable_update_test_asset(version, "amd64"),
        arch: "amd64".to_string(),
        local_file: None,
    }
}

fn app_update_offer(state: &AppUpdateState, version: &str) {
    state.set_available(AppUpdateTask {
        phase: AppUpdatePhase::Available,
        target_version: Some(format!("v{version}")),
        total_bytes: Some(1),
        ..AppUpdateTask::default()
    });
}

#[test]
fn installing_downloads_what_the_feed_has_now_not_the_earlier_offer() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let state = AppUpdateState::default();
    app_update_offer(&state, "0.3.2");

    let token = CancellationToken::new();
    state.start(token.clone()).unwrap();
    let mut newer = pending_app_update("0.3.3");
    newer.asset.size_bytes = 4096;
    let pending = runtime
        .block_on(refresh_app_update_for_install(&state, &token, async { Ok(newer) }))
        .unwrap();

    assert_eq!(pending.version, "v0.3.3");
    let task = state.snapshot();
    assert_eq!(task.phase, AppUpdatePhase::Downloading);
    assert_eq!(task.target_version.as_deref(), Some("v0.3.3"));
    assert_eq!(task.total_bytes, Some(4096));
    // A background check landing mid-install doesn't overwrite the running task.
    state.set_available(AppUpdateTask::default());
    assert_eq!(state.snapshot().target_version.as_deref(), Some("v0.3.3"));
}

#[test]
fn a_dev_build_is_copied_with_no_download_progress_to_show() {
    let state = AppUpdateState::default();
    state.start(CancellationToken::new()).unwrap();
    let mut dev_build = pending_app_update("0.3.3");
    dev_build.local_file = Some(PathBuf::from("/tmp/arbor-dev-feed/Arbor.dmg"));
    state.start_download(&dev_build).unwrap();

    let task = state.snapshot();
    assert!(task.from_this_mac);
    assert_eq!(task.percent, None);

    let state = AppUpdateState::default();
    state.start(CancellationToken::new()).unwrap();
    state.start_download(&pending_app_update("0.3.3")).unwrap();
    let task = state.snapshot();
    assert!(!task.from_this_mac);
    assert_eq!(task.percent, Some(0.0));
}

#[test]
fn a_failed_or_canceled_check_never_downloads_the_earlier_offer() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let state = AppUpdateState::default();
    app_update_offer(&state, "0.3.2");

    let token = CancellationToken::new();
    state.start(token.clone()).unwrap();
    let result = runtime.block_on(refresh_app_update_for_install(&state, &token, async {
        Err("version check failed".to_string())
    }));
    assert_eq!(result.err().as_deref(), Some("version check failed"));
    assert_eq!(state.snapshot().phase, AppUpdatePhase::Checking);
    assert!(state.snapshot().target_version.is_none());
    state.finish(AppUpdatePhase::Failed, None);

    let token = CancellationToken::new();
    state.start(token.clone()).unwrap();
    let result = runtime.block_on(async {
        let refresh =
            refresh_app_update_for_install(&state, &token, std::future::pending::<Result<PendingAppUpdate, String>>());
        let (result, _) = tokio::join!(refresh, async { state.cancel() });
        result
    });
    assert_eq!(result.err().as_deref(), Some("Application update download canceled"));
    assert!(state.snapshot().target_version.is_none());
    assert!(state.start_download(&pending_app_update("0.3.3")).is_err());
}

#[test]
fn sha256_file_hashes_exact_portable_asset_bytes() {
    let root = agent_test_home("portable-sha256");
    let asset = root.join("update.zip");
    fs::write(&asset, b"EasyCLIProxyAPI portable update").unwrap();

    assert_eq!(
        sha256_file(&asset).unwrap(),
        "ade7a05bacf7c9144319c0f0cf431700a8883d3f6effd3613c60749dfba1eb52"
    );
    fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn macos_update_descriptor_is_confined_to_the_app_and_temp_directories() {
    // Versions up to 1.0 named their work folder after the upstream app and ran as cpa-gui; the update they hand over
    // to must still accept both.
    for work_dir_name in ["Arbor-update-1.2.3-1-1", "EasyCLIProxyAPI-update-1.2.3-1-1"] {
    let root = agent_test_home("portable-macos-descriptor");
    let work_dir = root.join(work_dir_name);
    let current_app = root
        .join("Applications")
        .join("Arbor.app");
    let executable_relative_path = PathBuf::from("Contents/MacOS/cpa-gui");
    let current_exe = current_app.join(&executable_relative_path);
    let staged_app = work_dir
        .join("staging")
        .join("Arbor.app");
    let staged_exe = staged_app.join(&executable_relative_path);
    fs::create_dir_all(current_exe.parent().unwrap()).unwrap();
    fs::create_dir_all(staged_exe.parent().unwrap()).unwrap();
    fs::write(&current_exe, b"old").unwrap();
    fs::write(&staged_exe, b"new").unwrap();
    let descriptor = MacosUpdateDescriptor {
        parent_pid: 1,
        current_app: current_app.clone(),
        staged_app,
        backup_app: current_app
            .parent()
            .unwrap()
            .join(".Arbor.app.update-backup"),
        executable_relative_path,
        ack_path: work_dir.join("update-started.ack"),
        work_dir: work_dir.clone(),
        target_version: "1.2.3".to_string(),
    };
    fs::create_dir_all(&work_dir).unwrap();
    let descriptor_path = work_dir.join("update-descriptor.json");
    fs::write(
        &descriptor_path,
        serde_json::to_vec_pretty(&descriptor).unwrap(),
    )
    .unwrap();
    assert!(validate_macos_update_descriptor(&descriptor_path, &descriptor).is_ok(), "{work_dir_name}");
    assert_eq!(
        macos_application_bundle_from_executable(&current_exe).unwrap(),
        current_app
    );
    fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(target_os = "macos")]
#[test]
fn a_busy_update_image_is_ejected_again_then_forced() {
    let mount_dir = Path::new("/private/tmp/update with spaces/mount");
    // (times diskutil reports busy, whether the forced unmount works) -> diskutil tries, hdiutil tries, result
    for (busy, force_works) in [(0, true), (2, true), (3, true), (3, false)] {
        let (mut ejects, mut forced, mut waits) = (0, 0, Vec::new());
        let result = eject_macos_update_dmg_with_commands(
            mount_dir,
            |command, _| {
                let args = command.get_args().collect::<Vec<_>>();
                if command.get_program() == "diskutil" {
                    assert_eq!(args, [std::ffi::OsStr::new("eject"), mount_dir.as_os_str()]);
                    ejects += 1;
                    return if ejects <= busy { Err("diskutil: Resource busy".to_string()) } else { Ok(()) };
                }
                assert_eq!(command.get_program(), "hdiutil");
                assert_eq!(args, [std::ffi::OsStr::new("detach"), std::ffi::OsStr::new("-force"), mount_dir.as_os_str()]);
                forced += 1;
                if force_works { Ok(()) } else { Err("hdiutil: Resource busy".to_string()) }
            },
            |duration| waits.push(duration),
        );
        assert_eq!(ejects, (busy + 1).min(3), "busy {busy}");
        assert_eq!(forced, usize::from(busy >= 3), "busy {busy}");
        assert_eq!(waits, vec![Duration::from_millis(500); busy.min(2)], "busy {busy}");
        match result {
            Ok(()) => assert!(force_works),
            Err(error) => {
                assert!(!force_works);
                assert!(error.contains("diskutil: Resource busy") && error.contains("hdiutil: Resource busy"));
            }
        }
    }
}

#[cfg(target_os = "macos")]
#[test]
fn an_image_macos_still_holds_never_fails_a_verified_update_but_a_failed_check_still_does() {
    for failure in [None, Some("ditto"), Some("codesign")] {
        let root = agent_test_home("macos-dmg-stage-busy");
        let source_app = root.join("mount").join("Arbor.app");
        let staged_app = root.join("staging/Arbor.app");
        fs::create_dir_all(&source_app).unwrap();
        fs::write(source_app.join("payload"), b"application").unwrap();
        let (mut steps, mut ejects) = (Vec::new(), 0);
        let result = stage_macos_application_from_dmg_with_commands(
            &root.join("update.dmg"),
            &root,
            &staged_app,
            |command, _| {
                let program = command.get_program().to_str().unwrap().to_string();
                let args = command.get_args().collect::<Vec<_>>();
                if program == "diskutil" || args.first().is_some_and(|arg| *arg == "detach") {
                    ejects += 1;
                    return Err("Resource busy".to_string());
                }
                steps.push(program.clone());
                if failure == Some(program.as_str()) {
                    return Err(format!("{program} failed"));
                }
                if program == "ditto" {
                    fs::create_dir_all(&staged_app).unwrap();
                    fs::copy(source_app.join("payload"), staged_app.join("payload")).unwrap();
                }
                Ok(())
            },
            |_| {},
        );
        // Every path tries to eject: three times, then the forced unmount.
        assert_eq!(ejects, 4);
        match failure {
            Some(failure) => {
                assert_eq!(result.unwrap_err(), format!("{failure} failed"));
                assert_eq!(steps.last().map(String::as_str), Some(failure));
            }
            None => {
                result.unwrap();
                assert_eq!(steps, ["hdiutil", "ditto", "codesign"]);
                assert_eq!(fs::read(staged_app.join("payload")).unwrap(), b"application");
            }
        }
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(target_os = "macos")]
#[test]
fn cleanup_leaves_an_image_that_wont_eject_and_removes_it_once_it_does() {
    let root = agent_test_home("macos-dmg-cleanup");
    let mount_dir = root.join("mount");
    let image = root.join("update.dmg");
    let mounted_file = mount_dir.join("mounted-file");
    fs::create_dir_all(&mount_dir).unwrap();
    fs::write(&image, b"disk image").unwrap();
    fs::write(&mounted_file, b"mounted contents").unwrap();

    cleanup_macos_update_dmg_with_commands(&root, |_, _| Err("Resource busy".to_string()), |_| {});
    assert_eq!(fs::read(&image).unwrap(), b"disk image");
    assert_eq!(fs::read(&mounted_file).unwrap(), b"mounted contents");

    cleanup_macos_update_dmg_with_commands(
        &root,
        |command, _| {
            assert_eq!(command.get_program(), "diskutil");
            // An eject takes the mounted contents with it.
            fs::remove_file(&mounted_file).unwrap();
            Ok(())
        },
        |_| panic!("an image that ejects at once isn't waited on"),
    );
    assert!(!image.exists() && !mount_dir.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn synthetic_release_uses_official_asset_names_and_urls() {
    let release = release_from_tag("7.2.80");
    let platform = CorePlatform {
        os: "linux".to_string(),
        arch: "x86_64".to_string(),
        asset_os: "linux".to_string(),
        asset_arch: "amd64".to_string(),
        archive_kind: "tar.gz".to_string(),
    };
    let asset = select_release_asset(&release, &platform).unwrap();

    assert_eq!(release.tag_name, "v7.2.80");
    assert_eq!(asset.name, "CLIProxyAPI_7.2.80_linux_amd64.tar.gz");
    assert_eq!(
            asset.browser_download_url,
            "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.80/CLIProxyAPI_7.2.80_linux_amd64.tar.gz"
        );
    // The checksums come from the same GitHub release, never from where else the archive might be served.
    assert_eq!(
        release_checksum_url("7.2.80"),
        "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.80/checksums.txt"
    );
}

#[test]
fn release_downloads_follow_redirects_only_to_github_over_https() {
    let follows = |url: &str| is_github_release_redirect(&reqwest::Url::parse(url).unwrap());
    for trusted in [
        "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.80/checksums.txt",
        "https://objects.githubusercontent.com/github-production-release-asset/1",
        "https://release-assets.githubusercontent.com/github-production-release-asset/1",
    ] {
        assert!(follows(trusted), "{trusted}");
    }
    for untrusted in [
        // The third-party mirrors older versions fell back to.
        "https://gh-proxy.com/https://github.com/router-for-me/CLIProxyAPI/releases/latest",
        "https://ghfast.top/https://github.com/router-for-me/CLIProxyAPI/releases/latest",
        "https://github.com.example.com/releases/latest",
        "http://github.com/router-for-me/CLIProxyAPI/releases/latest",
        "https://github.com:8443/router-for-me/CLIProxyAPI/releases/latest",
        "https://user:secret@github.com/router-for-me/CLIProxyAPI/releases/latest",
    ] {
        assert!(!follows(untrusted), "{untrusted}");
    }
}

#[test]
fn release_checksum_reads_the_archive_line_from_checksums_txt() {
    let upper = "A".repeat(64);
    let checksums = format!(
        "{}  CLIProxyAPI_7.3.14_darwin_amd64.tar.gz\n{} *CLIProxyAPI_7.3.14_darwin_aarch64.tar.gz\n{}  CLIProxyAPI_7.3.14_linux_amd64.tar.gz\n",
        "1".repeat(64),
        upper,
        "2".repeat(64),
    );

    assert_eq!(
        release_checksum_for(&checksums, "CLIProxyAPI_7.3.14_darwin_amd64.tar.gz"),
        Some("1".repeat(64))
    );
    // The binary-mode marker is ignored and digests are compared in lowercase.
    assert_eq!(
        release_checksum_for(&checksums, "CLIProxyAPI_7.3.14_darwin_aarch64.tar.gz"),
        Some("a".repeat(64))
    );
    assert_eq!(
        release_checksum_for(&checksums, "CLIProxyAPI_7.3.14_windows_amd64.zip"),
        None
    );
    // A name only matches whole, and a line without a 64-digit hex digest never matches.
    assert_eq!(
        release_checksum_for(&checksums, "CLIProxyAPI_7.3.14_darwin"),
        None
    );
    let malformed = format!(
        "{}  CLIProxyAPI_7.3.14_darwin_amd64.tar.gz\nnot-a-digest  CLIProxyAPI_7.3.14_linux_amd64.tar.gz\n",
        "g".repeat(64)
    );
    for archive in [
        "CLIProxyAPI_7.3.14_darwin_amd64.tar.gz",
        "CLIProxyAPI_7.3.14_linux_amd64.tar.gz",
    ] {
        assert_eq!(release_checksum_for(&malformed, archive), None);
    }
}

/// Serves fixed bodies by path on a loopback port until `requests` connections have been answered.
fn serve_release_files(files: Vec<(&'static str, u16, Vec<u8>)>, requests: usize) -> u16 {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for stream in listener.incoming().take(requests) {
            let mut stream = stream.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            let request = String::from_utf8_lossy(&request);
            let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
            let (status, body) = files
                .iter()
                .find(|(file, _, _)| *file == path)
                .map(|(_, status, body)| (*status, body.clone()))
                .unwrap_or((404, b"not found".to_vec()));
            let head = format!(
                "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&body);
        }
    });
    port
}

#[test]
fn release_checksum_fetch_needs_a_readable_checksum_file_that_lists_the_archive() {
    let asset = "CLIProxyAPI_7.3.14_darwin_aarch64.tar.gz";
    let digest = "c".repeat(64);
    let other = format!("{}  CLIProxyAPI_7.3.14_linux_amd64.tar.gz\n", "d".repeat(64));
    let listed = format!("{other}{digest}  {asset}\n").into_bytes();
    let unlisted = other.into_bytes();
    let port = serve_release_files(
        vec![
            ("/listed", 200, listed),
            ("/unlisted", 200, unlisted),
            ("/huge", 200, vec![b'a'; 300 * 1024]),
        ],
        4,
    );
    // A port nothing listens on: connections are refused.
    let closed = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let url = |path: &str| format!("http://127.0.0.1:{port}{path}");
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let token = CancellationToken::new();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();

    assert_eq!(
        runtime.block_on(fetch_release_checksum(&client, &url("/listed"), asset, &token)),
        Ok(digest)
    );

    // A file that doesn't list the archive can't vouch for it.
    let error = runtime
        .block_on(fetch_release_checksum(&client, &url("/unlisted"), asset, &token))
        .unwrap_err();
    assert!(error.contains("has no SHA-256"), "{error}");

    // Unreachable, missing and oversized files leave the download unverified too.
    for unreadable in [format!("http://127.0.0.1:{closed}/checksums.txt"), url("/missing"), url("/huge")] {
        let error = runtime
            .block_on(fetch_release_checksum(&client, &unreadable, asset, &token))
            .unwrap_err();
        assert!(error.contains("couldn't fetch"), "{unreadable}: {error}");
    }
}

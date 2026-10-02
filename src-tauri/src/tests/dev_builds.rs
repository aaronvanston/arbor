use super::support::*;
use super::*;
use crate::dev_builds::*;
use base64::Engine as _;
use ring::signature::KeyPair as _;

const REPOSITORY: &str = "aaronvanston/arbor";
const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
const VERSION: &str = "1.0.27-dev.4123";

/// A throwaway key, so the test signs its own lists the way scripts/release-signing.mjs does.
fn test_key() -> (ring::signature::Ed25519KeyPair, String) {
    let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
    let pair = ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
    let public = base64::engine::general_purpose::STANDARD.encode(pair.public_key().as_ref());
    (pair, public)
}

fn sign(pair: &ring::signature::Ed25519KeyPair, manifest: &serde_json::Value) -> Vec<u8> {
    let manifest = manifest.to_string();
    let mut signed = b"Arbor update feed v1\n".to_vec();
    signed.extend_from_slice(manifest.as_bytes());
    let signature = base64::engine::general_purpose::STANDARD.encode(pair.sign(&signed).as_ref());
    serde_json::to_vec(&serde_json::json!({ "schemaVersion": 1, "manifest": manifest, "signature": signature })).unwrap()
}

fn dmg_name(version: &str) -> String {
    format!("Arbor-v{version}-Darwin-aarch64.dmg")
}

fn manifest(version: &str, dmg: &[u8]) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "version": version,
        "publishedAt": "2026-10-02T03:04:05Z",
        "releaseUrl": format!("https://github.com/{REPOSITORY}/commit/{COMMIT}"),
        "assets": { "darwin-aarch64": {
            "url": dmg_name(version),
            "sha256": format!("{:x}", sha2::Sha256::digest(dmg)),
            "sizeBytes": dmg.len(),
        } },
        "releases": [{ "version": version, "summary": "Main at 0123456.", "changes": ["Fix a thing"] }],
    })
}

fn feed_folder(name: &str, pair: &ring::signature::Ed25519KeyPair, manifest: &serde_json::Value, dmg: &[u8]) -> PathBuf {
    let dir = agent_test_home(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(dmg_name(manifest["version"].as_str().unwrap())), dmg).unwrap();
    fs::write(dir.join(DEV_FEED_FILE), sign(pair, manifest)).unwrap();
    dir
}

#[test]
fn a_dev_build_is_read_from_the_folder_once_its_list_is_signed_and_matches() {
    let (pair, public) = test_key();
    let dmg = b"not really a disk image";
    let dir = feed_folder("dev-feed-ok", &pair, &manifest(VERSION, dmg), dmg);

    let read = read_dev_feed(&dir, &public, REPOSITORY).unwrap();
    assert_eq!(read.version, VERSION);
    let asset = &read.assets["darwin-aarch64"];
    assert_eq!(PathBuf::from(&asset.url), dir.canonicalize().unwrap().join(dmg_name(VERSION)));
    assert_eq!(release_notes_from_manifest(read.releases.as_ref())[0].changes, vec!["Fix a thing".to_string()]);

    // Another key's list is ignored.
    let (_, other) = test_key();
    assert!(read_dev_feed(&dir, &other, REPOSITORY).unwrap_err().contains("isn't signed"));

    // A DMG that changed size since the list was signed is refused.
    fs::write(dir.join(dmg_name(VERSION)), b"a longer file than the one signed").unwrap();
    assert!(read_dev_feed(&dir, &public, REPOSITORY).unwrap_err().contains("doesn't match"));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_dev_list_names_only_its_own_dmg_beside_it() {
    let (pair, public) = test_key();
    let dmg = b"dmg";
    let mut escaping = manifest(VERSION, dmg);
    escaping["assets"]["darwin-aarch64"]["url"] = "../Arbor-v1.0.27-dev.4123-Darwin-aarch64.dmg".into();
    let dir = feed_folder("dev-feed-escape", &pair, &escaping, dmg);
    assert!(read_dev_feed(&dir, &public, REPOSITORY).unwrap_err().contains("doesn't match its version"));
    fs::remove_dir_all(dir).unwrap();

    let parse = |value: serde_json::Value| serde_json::from_value::<PortableUpdateManifest>(value).unwrap();
    assert!(validate_dev_feed_manifest(&parse(manifest(VERSION, dmg)), REPOSITORY).is_ok());
    // Only dev versions: a stable or nightly number can't come from this folder.
    assert!(validate_dev_feed_manifest(&parse(manifest("1.0.27", dmg)), REPOSITORY).is_err());
    assert!(validate_dev_feed_manifest(&parse(manifest("1.0.27-nightly.20261002.4", dmg)), REPOSITORY).is_err());
    // It names the commit on Arbor's repository.
    let mut elsewhere = manifest(VERSION, dmg);
    elsewhere["releaseUrl"] = format!("https://github.com/someone/else/commit/{COMMIT}").into();
    assert!(validate_dev_feed_manifest(&parse(elsewhere), REPOSITORY).is_err());
    let mut fallback = manifest(VERSION, dmg);
    fallback["assets"]["darwin-aarch64"]["fallbackUrls"] = serde_json::json!(["https://example.com/a.dmg"]);
    assert!(validate_dev_feed_manifest(&parse(fallback), REPOSITORY).is_err());
}

#[test]
fn no_dev_list_yet_says_so() {
    let dir = agent_test_home("dev-feed-none");
    fs::create_dir_all(&dir).unwrap();
    assert!(read_dev_feed(&dir, "key", REPOSITORY).unwrap_err().contains("hasn't built main yet"));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn the_dev_channel_takes_any_other_build_of_main_but_not_one_from_before_a_release() {
    assert!(is_dev_update_available("1.0.26", "1.0.27-dev.4123").unwrap());
    assert!(is_dev_update_available("1.0.27-dev.4100", "1.0.27-dev.4123").unwrap());
    // -dev sorts below -nightly, but a dev build of main is still newer than the nightly running.
    assert!(is_dev_update_available("1.0.27-nightly.20261002.4", "1.0.27-dev.4123").unwrap());
    assert!(!is_dev_update_available("1.0.27-dev.4123", "1.0.27-dev.4123").unwrap());
    // The builder stopped before 1.0.27 came out: its 1.0.27 dev build is older than 1.0.28's nightly.
    assert!(!is_dev_update_available("1.0.28-nightly.20261003.1", "1.0.27-dev.4123").unwrap());
}

#[test]
fn the_builders_status_is_read_leniently_and_its_log_stays_in_its_folder() {
    let dir = agent_test_home("dev-status");
    fs::create_dir_all(dir.join("logs")).unwrap();
    fs::write(dir.join("logs").join("build.log"), "log").unwrap();
    fs::write(
        dir.join("status.json"),
        serde_json::json!({
            "state": "building", "step": "installing", "commit": COMMIT, "log": "build.log",
            "builtVersion": VERSION, "builtCommit": "not-a-commit", "somethingNew": 1,
        })
        .to_string(),
    )
    .unwrap();
    let status = read_dev_build_status(&dir, true);
    assert!(status.installed);
    assert_eq!(status.state, DevBuildState::Building);
    assert_eq!(status.step, Some(DevBuildStep::Installing));
    assert_eq!(status.commit.as_deref(), Some(COMMIT));
    assert_eq!(status.built_version.as_deref(), Some(VERSION));
    assert_eq!(status.built_commit, None);
    assert!(status.has_log);
    assert!(!status.requested);

    // A state or step this version doesn't know, and a log outside the folder, are left out.
    fs::write(dir.join("status.json"), r#"{"state":"paused","step":"notarizing","log":"../secret.log"}"#).unwrap();
    fs::write(dir.join("build-now"), "").unwrap();
    let status = read_dev_build_status(&dir, false);
    assert_eq!(status.state, DevBuildState::Idle);
    assert_eq!(status.step, None);
    assert!(!status.has_log);
    assert!(status.requested);

    // When the wait for main to settle ends is only read while the builder is waiting.
    let settles = "2026-10-02T01:32:07Z";
    fs::write(dir.join("status.json"), serde_json::json!({ "state": "waiting", "commit": COMMIT, "settlesAt": settles }).to_string()).unwrap();
    assert_eq!(read_dev_build_status(&dir, true).settles_at.as_deref(), Some(settles));
    fs::write(dir.join("status.json"), serde_json::json!({ "state": "building", "settlesAt": settles }).to_string()).unwrap();
    assert_eq!(read_dev_build_status(&dir, true).settles_at, None);

    // No builder at all reads as idle with nothing built.
    assert_eq!(read_dev_build_status(&dir.join("missing"), false), DevBuildStatus::default());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_dev_build_copy_that_comes_out_a_different_size_fails() {
    let dir = agent_test_home("dev-copy");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("a.dmg"), b"12345").unwrap();
    copy_dev_build(&dir.join("a.dmg"), &dir.join("b.dmg"), 5).unwrap();
    assert!(copy_dev_build(&dir.join("a.dmg"), &dir.join("c.dmg"), 6).is_err());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn the_builder_remembers_its_repository_only_while_it_still_has_the_installer() {
    let dir = agent_test_home("dev-repository");
    let repository = dir.join("arbor");
    fs::create_dir_all(repository.join(".git")).unwrap();
    fs::create_dir_all(repository.join("scripts")).unwrap();
    assert!(dev_installer(&repository).unwrap_err().contains("isn't a copy of Arbor's repository"));
    fs::write(repository.join("scripts/install-dev-builds.sh"), "#!/bin/bash\n").unwrap();
    assert_eq!(dev_installer(&repository).unwrap(), repository.join("scripts/install-dev-builds.sh"));
    // A relative folder is never taken: the installer runs from the app, whose working folder means nothing.
    assert!(dev_installer(Path::new("arbor")).is_err());

    let feed = dir.join("feed");
    fs::create_dir_all(&feed).unwrap();
    assert_eq!(read_dev_build_status(&feed, true).repository, None);
    fs::write(feed.join("repository"), format!("{}\n", repository.display())).unwrap();
    assert_eq!(read_dev_build_status(&feed, true).repository.as_deref(), Some(repository.to_str().unwrap()));
    fs::remove_file(repository.join("scripts/install-dev-builds.sh")).unwrap();
    assert_eq!(read_dev_build_status(&feed, true).repository, None);
    fs::remove_dir_all(dir).unwrap();
}

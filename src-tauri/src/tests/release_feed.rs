use super::*;
use crate::release_feed::*;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

/// Signed by scripts/release-signing.mjs with a throwaway key; the TypeScript tests check the same file.
const FIXTURE: &str = include_str!("../../../tests/fixtures/signed-update-feed.json");
const REPOSITORY: &str = "aaronvanston/arbor";

fn fixture() -> (String, serde_json::Value) {
    let fixture = serde_json::from_str::<serde_json::Value>(FIXTURE).unwrap();
    (fixture["publicKey"].as_str().unwrap().to_string(), fixture["feed"].clone())
}

fn signed_bytes(feed: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(feed).unwrap()
}

fn fixture_manifest() -> PortableUpdateManifest {
    let (key, feed) = fixture();
    verify_signed_feed(&signed_bytes(&feed), &key).unwrap()
}

#[test]
fn a_signed_list_is_read_only_with_the_release_key_and_unchanged() {
    let (key, feed) = fixture();
    let manifest = verify_signed_feed(&signed_bytes(&feed), &key).unwrap();
    assert_eq!(manifest.version, "0.3.200");
    assert_eq!(manifest.core_version.as_deref(), Some("8.0.3"));

    let mut changed = feed.clone();
    changed["manifest"] = feed["manifest"].as_str().unwrap().replace("0.3.200", "0.3.201").into();
    assert!(verify_signed_feed(&signed_bytes(&changed), &key).unwrap_err().contains("isn't signed"));

    let mut resigned = feed.clone();
    resigned["signature"] = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [7u8; 64]).into();
    assert!(verify_signed_feed(&signed_bytes(&resigned), &key).is_err());

    // Arbor's own key didn't sign the test list.
    assert!(verify_signed_feed(&signed_bytes(&feed), ARBOR_RELEASE_FEED.public_key).is_err());

    let unsigned = feed["manifest"].as_str().unwrap().as_bytes().to_vec();
    assert!(verify_signed_feed(&unsigned, &key).is_err());
}

#[test]
fn the_release_key_compiled_in_is_a_32_byte_ed25519_key() {
    let key = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, ARBOR_RELEASE_FEED.public_key.trim()).unwrap();
    assert_eq!(key.len(), 32);
}

#[test]
fn a_signed_list_must_describe_the_release_it_came_with() {
    let manifest = fixture_manifest();
    assert_eq!(validate_release_feed_manifest(&manifest, "arbor-v0.3.200", REPOSITORY), Ok(()));
    // An older list re-attached to a newer release, or a list from another repository.
    assert!(validate_release_feed_manifest(&manifest, "arbor-v0.3.201", REPOSITORY).is_err());
    assert!(validate_release_feed_manifest(&manifest, "arbor-v0.3.200", "someone/else").is_err());

    let with = |change: fn(&mut PortableUpdateManifest)| {
        let mut manifest = fixture_manifest();
        change(&mut manifest);
        validate_release_feed_manifest(&manifest, "arbor-v0.3.200", REPOSITORY)
    };
    assert!(with(|manifest| manifest.release_url = "https://github.com/aaronvanston/arbor/releases".into()).is_err());
    assert!(with(|manifest| manifest.published_at = "yesterday".into()).is_err());
    assert!(with(|manifest| manifest.assets.get_mut("darwin-aarch64").unwrap().url =
        "https://github.com/aaronvanston/arbor/releases/download/arbor-v0.3.200/Other.dmg".into()).is_err());
    assert!(with(|manifest| manifest.assets.get_mut("darwin-aarch64").unwrap().fallback_urls =
        vec!["https://example.com/Arbor.dmg".into()]).is_err());
    assert!(with(|manifest| manifest.assets.get_mut("darwin-aarch64").unwrap().sha256 = "nope".into()).is_err());
    assert!(with(|manifest| manifest.full_assets = Some(Default::default())).is_err());
    assert!(with(|manifest| {
        let asset = manifest.assets.remove("darwin-aarch64").unwrap();
        manifest.assets.insert("windows-aarch64".into(), asset);
    })
    .is_err());
}

#[test]
fn only_the_repositorys_own_release_files_are_downloaded() {
    let source = &ARBOR_RELEASE_FEED;
    assert!(is_release_asset_api_url(source, "https://api.github.com/repos/aaronvanston/arbor/releases/assets/596315131"));
    assert!(!is_release_asset_api_url(source, "https://api.github.com/repos/someone/arbor/releases/assets/1"));
    assert!(!is_release_asset_api_url(source, "https://api.github.com/repos/aaronvanston/arbor/releases/assets/"));
    assert!(!is_release_asset_api_url(source, "https://api.github.com/repos/aaronvanston/arbor/releases/assets/1?x=1"));
    assert!(!is_release_asset_api_url(source, "http://127.0.0.1:8321/Arbor-v0.3.200-Darwin-aarch64.dmg"));

    let asset = PortableUpdateAsset {
        url: "https://api.github.com/repos/aaronvanston/arbor/releases/assets/2".into(),
        fallback_urls: Vec::new(),
        sha256: "ab".repeat(32),
        size_bytes: 1024,
    };
    assert_eq!(validate_portable_update_asset(&asset), Ok(()));
    let local = PortableUpdateAsset { url: "http://127.0.0.1:8321/Arbor-v0.3.200-Darwin-aarch64.dmg".into(), ..asset };
    assert!(validate_portable_update_asset(&local).is_err());
}

type Route = Box<dyn Fn(&str) -> (u16, Vec<(String, String)>, Vec<u8>) + Send + Sync>;

/// Answers `requests` connections by path, noting each path and the Authorization header it came with.
fn serve_github(route: Route, requests: usize) -> (String, Arc<Mutex<Vec<(String, Option<String>)>>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let noted = seen.clone();
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
            let request = String::from_utf8_lossy(&request).to_string();
            let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
            let authorization = request
                .lines()
                .find_map(|line| line.split_once(':').filter(|(name, _)| name.eq_ignore_ascii_case("authorization")))
                .map(|(_, value)| value.trim().to_string());
            noted.lock().unwrap().push((path.clone(), authorization));
            let (status, headers, body) = route(&path);
            let mut head = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
            for (name, value) in headers {
                head.push_str(&format!("{name}: {value}\r\n"));
            }
            head.push_str("\r\n");
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&body);
        }
    });
    (origin, seen)
}

fn release_json(api: &str, feed_size: usize) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "tag_name": "arbor-v0.3.200",
        "assets": [
            { "name": SIGNED_FEED_ASSET, "url": format!("{api}/repos/{REPOSITORY}/releases/assets/1"), "size": feed_size },
            { "name": "Arbor-v0.3.200-Darwin-aarch64.dmg", "url": format!("{api}/repos/{REPOSITORY}/releases/assets/2"), "size": 36_000_000 },
        ],
    }))
    .unwrap()
}

fn no_redirects() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap()
}

#[test]
fn the_feed_is_read_through_the_api_and_the_sign_in_never_leaves_it() {
    let (public_key, feed) = fixture();
    let signed = signed_bytes(&feed);
    let feed_size = signed.len();
    let origin_cell = Arc::new(Mutex::new(String::new()));
    let origin_for_route = origin_cell.clone();
    let (origin, seen) = serve_github(
        Box::new(move |path| {
            let origin = origin_for_route.lock().unwrap().clone();
            match path {
                "/repos/aaronvanston/arbor/releases/latest" => (200, Vec::new(), release_json(&origin, feed_size)),
                "/repos/aaronvanston/arbor/releases/assets/1" => {
                    (302, vec![("Location".into(), format!("{origin}/storage/feed?signed=1"))], Vec::new())
                }
                "/storage/feed?signed=1" => (200, Vec::new(), signed.clone()),
                _ => (404, Vec::new(), b"not found".to_vec()),
            }
        }),
        3,
    );
    *origin_cell.lock().unwrap() = origin.clone();
    let origins = [origin.as_str()];
    let source = ReleaseFeedSource { api: &origin, download_origins: &origins, repository: REPOSITORY, public_key: &public_key };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

    let manifest = runtime.block_on(fetch_release_feed(&no_redirects(), &source, Some("gho_test"))).unwrap();
    assert_eq!(manifest.version, "0.3.200");
    // The DMG is downloaded through the API address of the same release's file.
    assert_eq!(manifest.assets["darwin-aarch64"].url, format!("{origin}/repos/{REPOSITORY}/releases/assets/2"));

    let seen = seen.lock().unwrap().clone();
    assert_eq!(
        seen,
        vec![
            ("/repos/aaronvanston/arbor/releases/latest".to_string(), Some("Bearer gho_test".to_string())),
            ("/repos/aaronvanston/arbor/releases/assets/1".to_string(), Some("Bearer gho_test".to_string())),
            ("/storage/feed?signed=1".to_string(), None),
        ]
    );
}

#[test]
fn a_private_feed_asks_for_a_sign_in_and_a_stray_download_is_refused() {
    let (public_key, _) = fixture();
    let (origin, _) = serve_github(
        Box::new(|path| match path {
            "/repos/aaronvanston/arbor/releases/assets/9" => {
                (302, vec![("Location".into(), "https://example.com/Arbor.dmg".into())], Vec::new())
            }
            _ => (404, Vec::new(), b"not found".to_vec()),
        }),
        3,
    );
    let origins = [origin.as_str()];
    let source = ReleaseFeedSource { api: &origin, download_origins: &origins, repository: REPOSITORY, public_key: &public_key };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

    let signed_out = runtime.block_on(fetch_release_feed(&no_redirects(), &source, None)).unwrap_err();
    assert!(signed_out.contains("gh auth login"), "{signed_out}");
    let no_access = runtime.block_on(fetch_release_feed(&no_redirects(), &source, Some("gho_test"))).unwrap_err();
    assert!(no_access.contains("can't see"), "{no_access}");

    let asset = format!("{origin}/repos/{REPOSITORY}/releases/assets/9");
    let stray = runtime
        .block_on(release_asset_download_location(&no_redirects(), &source, Some("gho_test"), &asset))
        .unwrap_err();
    assert!(stray.contains("somewhere unexpected"), "{stray}");
}


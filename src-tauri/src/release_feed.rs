//! Arbor's own update feed on macOS: the newest release on Arbor's GitHub repository, stable or, on the nightly channel,
//! whichever is newer of that and the prereleases built from main. Each release carries its update
//! list signed with Arbor's release key (scripts/release-signing.mjs), and nothing is offered
//! or downloaded unless that signature checks out, so write access to the releases alone can't ship an update. When
//! the repository is private, requests to GitHub's API carry the GitHub CLI's sign-in; a public one needs none. The
//! sign-in goes to the API only, never to the storage host a download is redirected to.

use super::*;
use base64::Engine as _;

/// The signed update list each release carries, beside its DMG.
pub(crate) const SIGNED_FEED_ASSET: &str = "arbor-update-darwin.json";
/// Signed ahead of the list; scripts/release-signing.mjs signs the same bytes.
const FEED_SIGNING_CONTEXT: &[u8] = b"Arbor update feed v1\n";
const SIGNED_FEED_MAX_BYTES: u64 = 1024 * 1024;
const GH_TOKEN_TIMEOUT: Duration = Duration::from_secs(5);
/// How many of the newest releases the nightly channel looks through; nightlies come at most every half hour.
const NIGHTLY_RELEASES_PAGE: usize = 30;

/// Which releases the app updates to. Stable is the release GitHub marks as the latest. Nightly also takes the
/// prereleases built from main, `X.Y.Z-nightly.YYYYMMDD.N`, and moves to a stable release once one is newer.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UpdateChannel {
    #[default]
    Stable,
    Nightly,
}

impl UpdateChannel {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Nightly => "nightly",
        }
    }
}

/// config.toml's channel. A value this version doesn't know, as from a newer version an update rolled back from, reads
/// as stable rather than failing the whole file.
pub(crate) fn deserialize_update_channel<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<UpdateChannel, D::Error> {
    Ok(match String::deserialize(deserializer)?.trim() {
        "nightly" => UpdateChannel::Nightly,
        _ => UpdateChannel::Stable,
    })
}

/// Where Arbor's releases are and which key signs their update lists. Tests point one at a loopback server.
pub(crate) struct ReleaseFeedSource<'a> {
    /// GitHub's API, without a trailing slash.
    pub(crate) api: &'a str,
    /// Where GitHub sends a release download: only these origins are fetched, and never with the sign-in.
    pub(crate) download_origins: &'a [&'a str],
    pub(crate) repository: &'a str,
    /// The raw Ed25519 public key, base64.
    pub(crate) public_key: &'a str,
}

pub(crate) const ARBOR_RELEASE_FEED: ReleaseFeedSource<'static> = ReleaseFeedSource {
    api: "https://api.github.com",
    download_origins: &["https://release-assets.githubusercontent.com", "https://objects.githubusercontent.com"],
    repository: "aaronvanston/arbor",
    public_key: include_str!("../release-signing.pub"),
};

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubReleaseAsset {
    name: String,
    /// The API address that serves the file, e.g. https://api.github.com/repos/o/r/releases/assets/1.
    url: String,
    size: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedFeed {
    schema_version: u32,
    manifest: String,
    signature: String,
}

/// The GitHub CLI's token for github.com, when it's installed and signed in. Asked for at each check and never kept.
pub(crate) async fn github_cli_token() -> Option<String> {
    let cli = crate::usage::pull_requests::gh_cli()?;
    let mut command = tokio::process::Command::new(cli);
    command
        .args(["auth", "token", "--hostname", "github.com"])
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    crate::usage::machine_health::shell::configure_helper_command(&mut command);
    let output = tokio::time::timeout(GH_TOKEN_TIMEOUT, command.output()).await.ok()?.ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!token.is_empty() && token.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')).then_some(token)
}

/// The newest release's update list on `channel`, once its signature and contents check out, with each DMG's `url`
/// swapped for the API address that serves that file in the same release.
pub(crate) async fn fetch_release_feed(
    client: &reqwest::Client,
    source: &ReleaseFeedSource<'_>,
    token: Option<&str>,
    channel: UpdateChannel,
) -> Result<PortableUpdateManifest, String> {
    let release = match channel {
        UpdateChannel::Stable => {
            let latest = format!("{}/repos/{}/releases/latest", source.api, source.repository);
            fetch_api_json::<GithubRelease>(client, source, token, &latest).await?
        }
        UpdateChannel::Nightly => {
            let page = format!("{}/repos/{}/releases?per_page={NIGHTLY_RELEASES_PAGE}", source.api, source.repository);
            newest_release(fetch_api_json::<Vec<GithubRelease>>(client, source, token, &page).await?)
                .ok_or_else(|| "Arbor has no releases yet".to_string())?
        }
    };
    let feed_asset = release
        .assets
        .iter()
        .find(|asset| asset.name == SIGNED_FEED_ASSET)
        .ok_or_else(|| format!("Arbor's newest release ({}) has no signed update list", release.tag_name))?;
    if feed_asset.size > SIGNED_FEED_MAX_BYTES {
        return Err("Arbor's update list is too large".to_string());
    }
    let signed = download_small_asset(client, source, token, &feed_asset.url).await?;
    let mut manifest = verify_signed_feed(&signed, source.public_key)?;
    validate_release_feed_manifest(&manifest, &release.tag_name, source.repository)?;
    for asset in manifest.assets.values_mut() {
        let name = asset.url.rsplit('/').next().unwrap_or_default();
        let served = release
            .assets
            .iter()
            .find(|candidate| candidate.name == name)
            .ok_or_else(|| format!("Arbor's newest release ({}) is missing {name}", release.tag_name))?;
        if served.size != asset.size_bytes || !is_release_asset_api_url(source, &served.url) {
            return Err(format!("{name} in Arbor's newest release doesn't match its update list"));
        }
        asset.url = served.url.clone();
    }
    Ok(manifest)
}

async fn fetch_api_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    source: &ReleaseFeedSource<'_>,
    token: Option<&str>,
    url: &str,
) -> Result<T, String> {
    let response = api_request(client, url, token, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("Couldn't reach GitHub to check for updates: {error}"))?;
    if !response.status().is_success() {
        return Err(api_status_error(response.status(), token.is_some(), source.repository));
    }
    response
        .json::<T>()
        .await
        .map_err(|error| format!("Couldn't read Arbor's newest release: {error}"))
}

/// The release with the highest version among Arbor's own tags, stable or nightly. Drafts and other tags don't count.
fn newest_release(releases: Vec<GithubRelease>) -> Option<GithubRelease> {
    releases
        .into_iter()
        .filter(|release| !release.draft)
        .filter_map(|release| {
            let version = semver::Version::parse(release.tag_name.strip_prefix("arbor-v")?).ok()?;
            Some((version, release))
        })
        .max_by(|(left, _), (right, _)| left.cmp(right))
        .map(|(_, release)| release)
}

/// The manifest inside a signed update list, when it's signed by `public_key`.
pub(crate) fn verify_signed_feed(bytes: &[u8], public_key: &str) -> Result<PortableUpdateManifest, String> {
    let feed = serde_json::from_slice::<SignedFeed>(bytes).map_err(|_| "Arbor's update list isn't a signed list".to_string())?;
    if feed.schema_version != 1 {
        return Err(format!("Unsupported update list version: {}", feed.schema_version));
    }
    let engine = base64::engine::general_purpose::STANDARD;
    let key = engine
        .decode(public_key.trim())
        .map_err(|_| "This build's release signing key is unreadable".to_string())?;
    let signature = engine
        .decode(feed.signature.trim())
        .map_err(|_| "The update list's signature is unreadable".to_string())?;
    let mut signed = FEED_SIGNING_CONTEXT.to_vec();
    signed.extend_from_slice(feed.manifest.as_bytes());
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(&signed, &signature)
        .map_err(|_| "The update list isn't signed with Arbor's release key, so it was ignored".to_string())?;
    serde_json::from_str::<PortableUpdateManifest>(&feed.manifest)
        .map_err(|error| format!("Couldn't read Arbor's update list: {error}"))
}

/// A signed list still has to describe the release it came with: its version and tag, and DMGs at that tag's address
/// on the configured repository.
pub(crate) fn validate_release_feed_manifest(
    manifest: &PortableUpdateManifest,
    tag: &str,
    repository: &str,
) -> Result<(), String> {
    if manifest.schema_version != 1 {
        return Err(format!("Unsupported application update manifest version: {}", manifest.schema_version));
    }
    let version = manifest.version.trim();
    semver::Version::parse(version).map_err(|error| format!("Invalid application update version: {error}"))?;
    chrono::DateTime::parse_from_rfc3339(manifest.published_at.trim())
        .map_err(|error| format!("Invalid application update release time: {error}"))?;
    let expected_tag = format!("arbor-v{version}");
    if tag != expected_tag {
        return Err(format!("The update list is for {expected_tag}, but it came with {tag}"));
    }
    if manifest.release_url != format!("https://github.com/{repository}/releases/tag/{tag}") {
        return Err("Untrusted application update release URL".to_string());
    }
    if manifest.full_assets.is_some() || manifest.assets.is_empty() {
        return Err("The update list must name each Mac DMG once".to_string());
    }
    for (key, asset) in &manifest.assets {
        let arch = match key.as_str() {
            "darwin-aarch64" => "aarch64",
            "darwin-amd64" => "amd64",
            _ => return Err(format!("Unexpected update list entry: {key}")),
        };
        let expected = format!("https://github.com/{repository}/releases/download/{tag}/Arbor-v{version}-Darwin-{arch}.dmg");
        if asset.url != expected || !asset.fallback_urls.is_empty() {
            return Err(format!("The update list's {key} download doesn't match its release"));
        }
        validate_portable_update_asset_digest(asset)?;
    }
    Ok(())
}

/// Whether `url` is where the API serves a file from the source's releases.
pub(crate) fn is_release_asset_api_url(source: &ReleaseFeedSource<'_>, url: &str) -> bool {
    url.strip_prefix(&format!("{}/repos/{}/releases/assets/", source.api, source.repository))
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()))
}

/// Where GitHub serves a release file for download: the API answers with a short-lived address on its storage host.
pub(crate) async fn release_asset_download_location(
    client: &reqwest::Client,
    source: &ReleaseFeedSource<'_>,
    token: Option<&str>,
    asset_url: &str,
) -> Result<String, String> {
    if !is_release_asset_api_url(source, asset_url) {
        return Err("Untrusted application update download URL".to_string());
    }
    let response = api_request(client, asset_url, token, "application/octet-stream")
        .send()
        .await
        .map_err(|error| format!("Couldn't reach GitHub for the download: {error}"))?;
    if !response.status().is_redirection() {
        return Err(api_status_error(response.status(), token.is_some(), source.repository));
    }
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let trusted = source
        .download_origins
        .iter()
        .any(|origin| location.strip_prefix(origin).is_some_and(|rest| rest.starts_with('/')));
    if !trusted {
        return Err("GitHub sent the download somewhere unexpected".to_string());
    }
    Ok(location)
}

/// A small release file, read whole, capped at the update list's size limit.
async fn download_small_asset(
    client: &reqwest::Client,
    source: &ReleaseFeedSource<'_>,
    token: Option<&str>,
    asset_url: &str,
) -> Result<Vec<u8>, String> {
    let location = release_asset_download_location(client, source, token, asset_url).await?;
    let mut response = client
        .get(&location)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| format!("Couldn't download Arbor's update list: {error}"))?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Couldn't download Arbor's update list: {error}"))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 > SIGNED_FEED_MAX_BYTES {
            return Err("Arbor's update list is too large".to_string());
        }
    }
    Ok(bytes)
}

fn api_request(client: &reqwest::Client, url: &str, token: Option<&str>, accept: &str) -> reqwest::RequestBuilder {
    let request = client
        .get(url)
        .header(reqwest::header::ACCEPT, accept)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header("X-GitHub-Api-Version", "2022-11-28");
    match token {
        Some(token) => request.bearer_auth(token),
        None => request,
    }
}

/// What a refused API request means for someone checking for updates.
fn api_status_error(status: reqwest::StatusCode, signed_in: bool, repository: &str) -> String {
    match status.as_u16() {
        404 if signed_in => format!("Your GitHub sign-in can't see {repository}'s releases"),
        404 | 401 if !signed_in => format!(
            "{repository}'s releases are private. Sign in with the GitHub CLI (gh auth login) as an account that can see them"
        ),
        401 => "GitHub refused the GitHub CLI's sign-in; run gh auth login again".to_string(),
        403 | 429 => "GitHub is limiting requests for now; Arbor checks again later".to_string(),
        _ => format!("GitHub answered the update check with {status}"),
    }
}

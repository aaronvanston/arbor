//! What's out for the agents Arbor updates: the latest Claude Code and Codex on
//! npm, and which of their versions T3 Code's model manifest says don't work
//! with it. The Mac asks, never the machines. An answer is kept for an hour; a
//! failed ask is kept for five minutes and reads as unknown, never as an
//! error, since the page works without either.

use super::agents::AgentKind;
use ts_rs::TS;
use super::*;

const NPM_REGISTRY: &str = "https://registry.npmjs.org";
/// The file T3 Code refreshes its compatibility policy from every hour (its `ModelManifest.ts`).
const T3_MANIFEST_URL: &str = "https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/server/src/provider/model-manifest.json";
const FRESH: Duration = Duration::from_secs(60 * 60);
const RETRY: Duration = Duration::from_secs(5 * 60);
/// The manifest is tens of KB; anything this big isn't it.
const BODY_MAX_BYTES: usize = 4 * 1024 * 1024;
const STATUSES: [&str; 5] = ["unknown", "supported", "graceful", "unsupported", "broken"];

/// Each agent's `latest` on npm, or None when npm couldn't be asked.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
pub(crate) struct LatestVersions {
    claude: Option<String>,
    codex: Option<String>,
}

/// One of T3 Code's compatibility policies: for T3 Code versions in `t3_code_range`, what it makes
/// of each range of the agent's versions.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct T3Policy {
    agent: AgentKind,
    t3_code_range: String,
    recommended_range: Option<String>,
    recommended_version: Option<String>,
    ranges: Vec<T3Range>,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub(crate) struct T3Range {
    range: String,
    /// `unknown`, `supported`, `graceful`, `unsupported` or `broken`.
    status: String,
}

/// A version as a registry states it: digits and dots, maybe a pre-release, nothing a command could trip on.
fn plain_version(version: &str) -> Option<String> {
    let version = version.trim();
    (version.starts_with(|c: char| c.is_ascii_digit())
        && version.contains('.')
        && version.len() <= 64
        && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')))
    .then(|| version.to_string())
}

/// The version in npm's answer for a package's `latest` tag.
pub(super) fn parse_npm_latest(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    plain_version(value.get("version")?.as_str()?)
}

/// One comparator of T3 Code's range syntax: an optional `^`, `>=`, `>`, `<=`, `<` or `=`, then up to
/// three numbers.
fn valid_comparator(token: &str) -> bool {
    let rest = ["^", ">=", "<=", ">", "<", "="].iter().find_map(|op| token.strip_prefix(op)).unwrap_or(token);
    let rest = rest.strip_prefix('v').unwrap_or(rest);
    let parts: Vec<&str> = rest.split('.').collect();
    (1..=3).contains(&parts.len()) && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

/// Comparators separated by spaces, in groups joined by `||`.
fn valid_range(range: &str) -> bool {
    range.split("||").all(|group| {
        let tokens: Vec<&str> = group.split_whitespace().collect();
        !tokens.is_empty() && tokens.iter().all(|token| valid_comparator(token))
    })
}

/// A field that may be left out, but must read right when it's there.
fn optional(policy: &Value, key: &str, valid: impl Fn(&str) -> bool) -> Option<Option<String>> {
    match policy.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(value) => value.as_str().map(str::trim).filter(|text| valid(text)).map(|text| Some(text.to_string())),
    }
}

fn parse_policy(agent: AgentKind, policy: &Value) -> Option<T3Policy> {
    let t3_code_range = policy.get("t3CodeRange")?.as_str()?.trim();
    if !valid_range(t3_code_range) {
        return None;
    }
    let ranges = policy
        .get("ranges")?
        .as_array()?
        .iter()
        .map(|entry| {
            let range = entry.get("range")?.as_str()?.trim();
            let status = entry.get("status")?.as_str()?;
            (valid_range(range) && STATUSES.contains(&status)).then(|| T3Range { range: range.to_string(), status: status.to_string() })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(T3Policy {
        agent,
        t3_code_range: t3_code_range.to_string(),
        recommended_range: optional(policy, "recommendedRange", valid_range)?,
        recommended_version: optional(policy, "recommendedVersion", |version| {
            version.split('.').count() == 3 && version.split('.').all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        })?,
        ranges,
    })
}

/// Claude Code's and Codex's policies in T3 Code's model manifest. None when it isn't a manifest
/// Arbor can read, or one of those policies isn't: then nothing is shown rather than a guess.
pub(super) fn parse_t3_manifest(body: &str) -> Option<Vec<T3Policy>> {
    let value: Value = serde_json::from_str(body).ok()?;
    if value.get("version")?.as_u64()? != 1 {
        return None;
    }
    value
        .get("compatibility")?
        .as_array()?
        .iter()
        .filter_map(|policy| {
            let agent = match policy.get("driver").and_then(Value::as_str)? {
                "claudeAgent" => AgentKind::Claude,
                "codex" => AgentKind::Codex,
                _ => return None,
            };
            Some(parse_policy(agent, policy))
        })
        .collect()
}

/// What was last heard, and when. A failure is asked again sooner than an answer.
type Heard<T> = (Instant, Option<T>);

fn still_fresh<T: Clone>(heard: Option<&Heard<T>>, now: Instant) -> Option<Option<T>> {
    let (at, value) = heard?;
    let keep = if value.is_some() { FRESH } else { RETRY };
    (now.saturating_duration_since(*at) < keep).then(|| value.clone())
}

static LATEST: LazyLock<Mutex<HashMap<AgentKind, Heard<String>>>> = LazyLock::new(Default::default);
static T3_POLICIES: LazyLock<Mutex<Option<Heard<Vec<T3Policy>>>>> = LazyLock::new(Default::default);

fn client(gui_config_state: &GuiConfigState) -> Option<reqwest::Client> {
    let proxy_url = gui_config_state.snapshot().ok()?.proxy_url;
    crate::core_runtime::build_http_client_with_proxy(
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .user_agent(concat!("Arbor/", env!("CARGO_PKG_VERSION"))),
        &proxy_url,
        "Arbor couldn't set up a connection",
    )
    .ok()
}

async fn fetch(client: &reqwest::Client, url: &str) -> Option<String> {
    let response = client.get(url).header(reqwest::header::ACCEPT, "application/json").send().await.ok()?;
    if !response.status().is_success() || response.content_length().is_some_and(|length| length as usize > BODY_MAX_BYTES) {
        return None;
    }
    let body = response.bytes().await.ok()?;
    (body.len() <= BODY_MAX_BYTES).then(|| String::from_utf8_lossy(&body).into_owned())
}

async fn latest_of(client: Option<&reqwest::Client>, agent: AgentKind) -> Option<String> {
    if let Some(known) = still_fresh(LATEST.lock().unwrap_or_else(PoisonError::into_inner).get(&agent), Instant::now()) {
        return known;
    }
    // A scoped package's name goes in the path with its slash encoded.
    let url = format!("{NPM_REGISTRY}/{}/latest", agent.package().replace('/', "%2F"));
    let version = match client {
        Some(client) => fetch(client, &url).await.and_then(|body| parse_npm_latest(&body)),
        None => None,
    };
    LATEST.lock().unwrap_or_else(PoisonError::into_inner).insert(agent, (Instant::now(), version.clone()));
    version
}

/// Claude Code's and Codex's latest releases on npm, each None when npm couldn't be asked.
#[tauri::command]
pub(crate) async fn get_agent_latest_versions(gui_config_state: tauri::State<'_, GuiConfigState>) -> Result<LatestVersions, String> {
    let client = client(&gui_config_state);
    Ok(LatestVersions {
        claude: latest_of(client.as_ref(), AgentKind::Claude).await,
        codex: latest_of(client.as_ref(), AgentKind::Codex).await,
    })
}

/// T3 Code's compatibility policies for Claude Code and Codex, or None when its manifest couldn't
/// be fetched or read.
#[tauri::command]
pub(crate) async fn get_t3_compatibility(gui_config_state: tauri::State<'_, GuiConfigState>) -> Result<Option<Vec<T3Policy>>, String> {
    if let Some(known) = still_fresh(T3_POLICIES.lock().unwrap_or_else(PoisonError::into_inner).as_ref(), Instant::now()) {
        return Ok(known);
    }
    let policies = match client(&gui_config_state) {
        Some(client) => fetch(&client, T3_MANIFEST_URL).await.and_then(|body| parse_t3_manifest(&body)),
        None => None,
    };
    *T3_POLICIES.lock().unwrap_or_else(PoisonError::into_inner) = Some((Instant::now(), policies.clone()));
    Ok(policies)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_latest_is_the_version_the_registry_names() {
        let body = r#"{"name":"@openai/codex","version":"0.157.0","bin":{"codex":"bin/codex.js"},"dist":{"tarball":"https://registry.npmjs.org/@openai/codex/-/codex-0.157.0.tgz"}}"#;
        assert_eq!(parse_npm_latest(body).as_deref(), Some("0.157.0"));
        assert_eq!(parse_npm_latest(r#"{"version":"2.1.283"}"#).as_deref(), Some("2.1.283"));
        assert_eq!(parse_npm_latest(r#"{"version":"0.47.0-alpha.3"}"#).as_deref(), Some("0.47.0-alpha.3"));
        for bad in [r#"{"error":"Not found"}"#, r#"{"version":"latest"}"#, r#"{"version":"1.0.0; rm -rf ~"}"#, r#"{"version":7}"#, "<html>", ""] {
            assert_eq!(parse_npm_latest(bad), None, "{bad}");
        }
    }

    const MANIFEST: &str = r#"{
      "version": 1,
      "updatedAt": "2026-09-24T18:40:00Z",
      "compatibility": [
        { "driver": "codex", "t3CodeRange": ">=0.0.42", "recommendedRange": ">=0.156.0",
          "ranges": [ { "range": ">=0.156.0", "status": "supported" }, { "range": ">=0.149.0 <0.156.0", "status": "unsupported" }, { "range": "<0.149.0", "status": "broken" } ] },
        { "driver": "claudeAgent", "t3CodeRange": ">=0.0.42", "recommendedRange": ">=2.1.280",
          "ranges": [ { "range": ">=2.1.280", "status": "supported" }, { "range": ">=2.1.111 <2.1.280", "status": "graceful" }, { "range": "<2.1.111", "status": "unsupported" } ] },
        { "driver": "cursor", "t3CodeRange": ">=0.0.42", "ranges": [ { "range": ">=2026.05.09", "status": "someday" } ] }
      ],
      "currentModels": { "codex": ["gpt-5.5"] }
    }"#;

    #[test]
    fn t3_codes_manifest_gives_each_agents_policy() {
        let policies = parse_t3_manifest(MANIFEST).expect("readable");
        assert_eq!(policies.len(), 2, "other drivers are left out, however they read");
        let codex = &policies[0];
        assert_eq!((codex.agent, codex.t3_code_range.as_str(), codex.recommended_range.as_deref(), codex.recommended_version.as_deref()), (AgentKind::Codex, ">=0.0.42", Some(">=0.156.0"), None));
        assert_eq!(codex.ranges[1], T3Range { range: ">=0.149.0 <0.156.0".into(), status: "unsupported".into() });
        assert_eq!(policies[1].agent, AgentKind::Claude);
        assert_eq!(parse_t3_manifest(r#"{"version":1,"compatibility":[],"currentModels":{}}"#), Some(vec![]));
    }

    #[test]
    fn a_manifest_that_doesnt_read_right_gives_nothing() {
        let broken = |from: &str, to: &str| {
            let changed = MANIFEST.replacen(from, to, 1);
            assert_ne!(changed, MANIFEST, "{from}");
            parse_t3_manifest(&changed)
        };
        assert_eq!(broken("\"version\": 1", "\"version\": 2"), None);
        assert_eq!(broken(">=0.149.0 <0.156.0", ">=0.149.0 && <0.156.0"), None);
        assert_eq!(broken("\"status\": \"broken\"", "\"status\": \"bad\""), None);
        assert_eq!(broken("\"recommendedRange\": \">=0.156.0\"", "\"recommendedRange\": 156"), None);
        assert_eq!(broken("\"compatibility\"", "\"compat\""), None);
        assert_eq!(parse_t3_manifest("404: Not Found"), None);
        assert!(valid_range("^1.2 || >=2.0.0 <3 || =v4.0.1"));
        assert!(!valid_range("") && !valid_range(">=1.2.3.4") && !valid_range("~1.2.3") && !valid_range(">=1.x"));
    }

    #[test]
    fn answers_are_kept_an_hour_and_failures_five_minutes() {
        let at = Instant::now();
        let after = |minutes: u64| at + Duration::from_secs(minutes * 60);
        let answer: Heard<String> = (at, Some("0.157.0".into()));
        assert_eq!(still_fresh(Some(&answer), after(59)), Some(Some("0.157.0".into())));
        assert_eq!(still_fresh(Some(&answer), after(61)), None);
        let failure: Heard<String> = (at, None);
        assert_eq!(still_fresh(Some(&failure), after(4)), Some(None));
        assert_eq!(still_fresh(Some(&failure), after(6)), None);
        assert_eq!(still_fresh::<String>(None, at), None);
    }
}

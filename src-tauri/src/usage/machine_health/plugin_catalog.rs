//! What a plugin marketplace offers, for Sync › Library's directory: the list its GitHub repository publishes, read
//! from GitHub without an account. Claude Code's marketplaces keep it in .claude-plugin/marketplace.json; Codex reads
//! the same file, or its own under .agents/plugins. Only names, descriptions and the like are kept, and what GitHub
//! said is used again for 15 minutes, as skill sources' checks are. Nothing on a machine is read or changed.

use super::setup_plugins::is_github_repo;
use super::setup_repo_skills::github_client;
use super::*;
use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use ts_rs::TS;

/// Where a marketplace's repository may keep its list, the first found wins.
const CATALOG_PATHS: [&str; 2] = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"];
/// How long what GitHub said is used again.
const FRESH: Duration = Duration::from_secs(15 * 60);
/// A list bigger than this isn't one Arbor reads.
const MOST_BYTES: usize = 2 * 1024 * 1024;
/// The most plugins kept from one list.
const MOST_PLUGINS: usize = 500;
/// The longest a description is kept.
const MOST_DESCRIPTION: usize = 300;

/// One plugin a marketplace offers.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogPlugin {
    name: String,
    description: Option<String>,
    version: Option<String>,
    category: Option<String>,
}

/// What a marketplace offers: its name as the list gives it (what plugins' ids end with), and its plugins.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarketplaceCatalog {
    /// `owner/repo` on GitHub.
    source: String,
    name: String,
    plugins: Vec<CatalogPlugin>,
    /// When GitHub was asked, in ms.
    read_at_ms: i64,
}

/// A short text field of an entry, trimmed and cut to `most` characters.
fn text(entry: &Value, key: &str, most: usize) -> Option<String> {
    let value = entry.get(key)?.as_str()?.trim();
    (!value.is_empty()).then(|| value.chars().filter(|c| !c.is_control()).take(most).collect())
}

/// A plugin's or marketplace's name, as Claude Code and Codex allow them.
fn is_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 100 && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// A marketplace's list as its file has it, keeping only plugins with a name Arbor can install by.
pub(super) fn parse_catalog(source: &str, bytes: &[u8], read_at_ms: i64) -> Result<MarketplaceCatalog, String> {
    let root: Value = serde_json::from_slice(bytes).map_err(|_| format!("{source}'s plugin list isn't JSON Arbor can read"))?;
    let name = text(&root, "name", 100).filter(|name| is_name(name)).ok_or_else(|| format!("{source}'s plugin list doesn't name its marketplace"))?;
    let mut plugins: Vec<CatalogPlugin> = root
        .get("plugins")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let name = text(entry, "name", 100).filter(|name| is_name(name))?;
                    Some(CatalogPlugin {
                        name,
                        description: text(entry, "description", MOST_DESCRIPTION),
                        version: text(entry, "version", 40),
                        category: text(entry, "category", 40),
                    })
                })
                .take(MOST_PLUGINS)
                .collect()
        })
        .unwrap_or_default();
    plugins.sort_by(|a, b| a.name.cmp(&b.name));
    plugins.dedup_by(|a, b| a.name == b.name);
    Ok(MarketplaceCatalog { source: source.to_string(), name, plugins, read_at_ms })
}

type Cache = Mutex<HashMap<String, (Instant, Result<MarketplaceCatalog, String>)>>;
static CACHE: std::sync::LazyLock<Cache> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

async fn fetch(client: &reqwest::Client, raw: &str, source: &str) -> Result<MarketplaceCatalog, String> {
    for path in CATALOG_PATHS {
        let url = format!("{raw}/{source}/HEAD/{path}");
        let response = client.get(&url).send().await.map_err(|error| format!("Arbor couldn't reach GitHub: {error}"))?;
        let status = response.status();
        if status.as_u16() == 404 {
            continue;
        }
        if !status.is_success() {
            return Err(format!("GitHub answered {} for {source}", status.as_u16()));
        }
        let bytes = response.bytes().await.map_err(|error| format!("GitHub's answer broke off: {error}"))?;
        if bytes.len() > MOST_BYTES {
            return Err(format!("{source}'s plugin list is too big for Arbor to read"));
        }
        return parse_catalog(source, &bytes, chrono::Utc::now().timestamp_millis());
    }
    Err(format!("{source} has no plugin list Arbor knows, or GitHub can't show it without an account"))
}

/// What the marketplace at `source` (`owner/repo` on GitHub) offers. What GitHub said in the last 15 minutes is used
/// again, unless `force`.
#[tauri::command]
pub(crate) async fn get_marketplace_catalog(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    source: String,
    force: bool,
) -> Result<MarketplaceCatalog, String> {
    if !is_github_repo(&source) {
        return Err("A marketplace is browsed by its GitHub repository, like owner/repo".into());
    }
    let key = source.to_ascii_lowercase();
    if !force {
        let cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((at, answer)) = cache.get(&key) {
            if at.elapsed() < FRESH {
                return answer.clone();
            }
        }
    }
    let client = github_client(&gui_config_state)?;
    let answer = fetch(&client, "https://raw.githubusercontent.com", &source).await;
    CACHE.lock().unwrap_or_else(PoisonError::into_inner).insert(key, (Instant::now(), answer.clone()));
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_marketplace_list_keeps_installable_plugins_and_their_words_only() {
        let file = serde_json::json!({
            "name": "acme-tools",
            "owner": { "name": "Acme", "email": "tools@example.com" },
            "plugins": [
                { "name": "review", "description": "  Review a diff\u{0007}  ", "version": "1.4.0", "category": "development", "source": "./plugins/review" },
                { "name": "release", "source": { "source": "github", "repo": "acme/release" } },
                { "name": "../escape", "description": "not a name" },
                { "name": "review", "description": "a duplicate" },
                { "description": "no name" },
            ],
        });
        let catalog = parse_catalog("acme/agent-tools", file.to_string().as_bytes(), 5).unwrap();
        assert_eq!(catalog.name, "acme-tools");
        assert_eq!(catalog.read_at_ms, 5);
        assert_eq!(
            catalog.plugins,
            vec![
                CatalogPlugin { name: "release".into(), description: None, version: None, category: None },
                CatalogPlugin { name: "review".into(), description: Some("Review a diff".into()), version: Some("1.4.0".into()), category: Some("development".into()) },
            ]
        );
        let long = "x".repeat(400);
        let cut = parse_catalog("a/b", serde_json::json!({ "name": "m", "plugins": [{ "name": "p", "description": long }] }).to_string().as_bytes(), 0).unwrap();
        assert_eq!(cut.plugins[0].description.as_deref().map(str::len), Some(MOST_DESCRIPTION));
    }

    #[test]
    fn a_list_without_a_marketplace_name_or_json_is_refused() {
        assert!(parse_catalog("a/b", b"not json", 0).is_err());
        assert!(parse_catalog("a/b", br#"{"plugins":[]}"#, 0).is_err());
        assert!(parse_catalog("a/b", br#"{"name":"../x","plugins":[]}"#, 0).is_err());
        assert_eq!(parse_catalog("a/b", br#"{"name":"m"}"#, 0).unwrap().plugins, vec![]);
    }
}

//! What a plugin marketplace offers, for Sync › Library's directory: the list its GitHub repository publishes, read
//! from GitHub without an account. Claude Code's marketplaces keep it in .claude-plugin/marketplace.json; Codex reads
//! its own under .agents/plugins (OpenAI's official one, openai/plugins, among them), whose entries leave the words to
//! each plugin's .codex-plugin/plugin.json, read a few at a time. Only names, descriptions and the like are kept, and
//! what GitHub said is used again for 15 minutes, as skill sources' checks are. Nothing on a machine is read or changed.

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
/// The most plugin.json files read for one list's words, and how many at once.
const MOST_DETAILS: usize = 150;
const DETAILS_AT_ONCE: usize = 8;

/// One plugin a marketplace offers.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogPlugin {
    name: String,
    /// How the marketplace shows its name, when that isn't the name.
    display_name: Option<String>,
    description: Option<String>,
    version: Option<String>,
    category: Option<String>,
    /// Installing it asks its user to sign in to something on that machine (Codex's `authentication: ON_INSTALL`).
    signs_in: bool,
    /// The marketplace lets it be installed (Codex's `installation: AVAILABLE`, or no policy at all).
    installable: bool,
    /// Its folder in the marketplace's repository, for its own plugin.json; never sent to the window.
    #[serde(skip)]
    #[ts(skip)]
    folder: Option<String>,
}

/// What a marketplace offers: its name as the list gives it (what plugins' ids end with), and its plugins.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarketplaceCatalog {
    /// `owner/repo` on GitHub.
    source: String,
    name: String,
    /// How the marketplace shows its name ("Codex official"), when it gives one.
    display_name: Option<String>,
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
                    let policy = entry.get("policy");
                    let folder = entry.get("source").and_then(|source| match source {
                        Value::String(path) => Some(path.as_str()),
                        Value::Object(_) if source.get("source").and_then(Value::as_str) == Some("local") => source.get("path").and_then(Value::as_str),
                        _ => None,
                    });
                    Some(CatalogPlugin {
                        name,
                        display_name: text(entry, "displayName", 100),
                        description: text(entry, "description", MOST_DESCRIPTION),
                        version: text(entry, "version", 40),
                        category: text(entry, "category", 40),
                        signs_in: policy.and_then(|policy| policy.get("authentication")).and_then(Value::as_str) == Some("ON_INSTALL"),
                        installable: policy.and_then(|policy| policy.get("installation")).and_then(Value::as_str).is_none_or(|value| value == "AVAILABLE"),
                        folder: folder.and_then(safe_folder),
                    })
                })
                .take(MOST_PLUGINS)
                .collect()
        })
        .unwrap_or_default();
    plugins.sort_by(|a, b| a.name.cmp(&b.name));
    plugins.dedup_by(|a, b| a.name == b.name);
    let display_name = root.get("interface").and_then(|interface| text(interface, "displayName", 100));
    Ok(MarketplaceCatalog { source: source.to_string(), name, display_name, plugins, read_at_ms })
}

/// A plugin's folder as the list gives it (./plugins/github), kept only when it stays inside the repository.
fn safe_folder(path: &str) -> Option<String> {
    let path = path.trim().trim_start_matches("./").trim_end_matches('/');
    let fine = !path.is_empty()
        && path.len() <= 200
        && path.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != ".." && segment.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')));
    fine.then(|| path.to_string())
}

/// A plugin's description from its own .codex-plugin/plugin.json, when the list left it out.
fn plugin_description(bytes: &[u8]) -> Option<String> {
    let manifest: Value = serde_json::from_slice(bytes).ok()?;
    text(&manifest, "description", MOST_DESCRIPTION).or_else(|| manifest.get("interface").and_then(|interface| text(interface, "shortDescription", MOST_DESCRIPTION)))
}

/// Reads the words of plugins whose list entry has none from their own plugin.json, a few at a time; one that can't be
/// read just stays without.
async fn fill_descriptions(client: &reqwest::Client, raw: &str, source: &str, catalog: &mut MarketplaceCatalog) {
    use futures_util::stream::{self, StreamExt};
    let wanted: Vec<(usize, String)> = catalog
        .plugins
        .iter()
        .enumerate()
        .filter(|(_, plugin)| plugin.description.is_none())
        .filter_map(|(index, plugin)| plugin.folder.clone().map(|folder| (index, folder)))
        .take(MOST_DETAILS)
        .collect();
    let found: Vec<(usize, Option<String>)> = stream::iter(wanted)
        .map(|(index, folder)| async move {
            let url = format!("{raw}/{source}/HEAD/{folder}/.codex-plugin/plugin.json");
            let bytes = match client.get(&url).send().await {
                Ok(response) if response.status().is_success() => response.bytes().await.ok(),
                _ => None,
            };
            (index, bytes.filter(|bytes| bytes.len() <= MOST_BYTES).and_then(|bytes| plugin_description(&bytes)))
        })
        .buffer_unordered(DETAILS_AT_ONCE)
        .collect()
        .await;
    for (index, description) in found {
        if let (Some(plugin), Some(description)) = (catalog.plugins.get_mut(index), description) {
            plugin.description = Some(description);
        }
    }
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
        let mut catalog = parse_catalog(source, &bytes, chrono::Utc::now().timestamp_millis())?;
        fill_descriptions(client, raw, source, &mut catalog).await;
        return Ok(catalog);
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
        let plain = |name: &str| CatalogPlugin { name: name.into(), display_name: None, description: None, version: None, category: None, signs_in: false, installable: true, folder: None };
        assert_eq!(
            catalog.plugins,
            vec![
                plain("release"),
                CatalogPlugin {
                    description: Some("Review a diff".into()),
                    version: Some("1.4.0".into()),
                    category: Some("development".into()),
                    folder: Some("plugins/review".into()),
                    ..plain("review")
                },
            ]
        );
        let long = "x".repeat(400);
        let cut = parse_catalog("a/b", serde_json::json!({ "name": "m", "plugins": [{ "name": "p", "description": long }] }).to_string().as_bytes(), 0).unwrap();
        assert_eq!(cut.plugins[0].description.as_deref().map(str::len), Some(MOST_DESCRIPTION));
    }

    #[test]
    fn a_codex_list_gives_policies_and_folders_and_leaves_the_words_to_each_plugin() {
        let file = serde_json::json!({
            "name": "openai-curated",
            "interface": { "displayName": "Codex official" },
            "plugins": [
                { "name": "linear", "category": "Productivity", "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" }, "source": { "source": "local", "path": "./plugins/linear" } },
                { "name": "notes", "policy": { "installation": "NOT_AVAILABLE", "authentication": "ON_USE" }, "source": { "source": "local", "path": "../outside" } },
                { "name": "remote", "source": { "source": "url", "url": "https://example.com/x.git" } },
            ],
        });
        let catalog = parse_catalog("openai/plugins", file.to_string().as_bytes(), 0).unwrap();
        assert_eq!(catalog.display_name.as_deref(), Some("Codex official"));
        let by = |name: &str| catalog.plugins.iter().find(|plugin| plugin.name == name).unwrap();
        assert!(by("linear").signs_in && by("linear").installable);
        assert_eq!(by("linear").folder.as_deref(), Some("plugins/linear"));
        assert!(!by("notes").signs_in && !by("notes").installable);
        assert_eq!(by("notes").folder, None, "a folder outside the repository isn't read");
        assert_eq!(by("remote").folder, None);
        assert_eq!(plugin_description(br#"{"name":"linear","description":"Plan and track work"}"#).as_deref(), Some("Plan and track work"));
        assert_eq!(plugin_description(br#"{"interface":{"shortDescription":"Short words"}}"#).as_deref(), Some("Short words"));
        assert_eq!(plugin_description(b"nope"), None);
    }

    #[test]
    fn a_list_without_a_marketplace_name_or_json_is_refused() {
        assert!(parse_catalog("a/b", b"not json", 0).is_err());
        assert!(parse_catalog("a/b", br#"{"plugins":[]}"#, 0).is_err());
        assert!(parse_catalog("a/b", br#"{"name":"../x","plugins":[]}"#, 0).is_err());
        assert_eq!(parse_catalog("a/b", br#"{"name":"m"}"#, 0).unwrap().plugins, vec![]);
    }
}

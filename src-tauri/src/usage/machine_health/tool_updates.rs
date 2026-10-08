//! Who installed each tool a machine's shell finds first, and what that installer says is newer.
//!
//! An owner is proven from where the binary really is, the way `agent_install` proves an agent's: Homebrew's Cellar
//! under the prefix `brew --prefix` gives, the tool mise says gives a shim, npm's global layout naming the package,
//! rustup's proxies beside rustup. Nothing is ever guessed from a package manager merely being on the machine, so an
//! installer is never run against a tool it didn't put there. A tool with no proven owner shows no update and is
//! left to an agent.
//!
//! The update check is kept apart from the scan, which stays offline: it asks each installer the machine has
//! (`brew outdated`, `mise outdated`, `npm outdated -g`, `rustup check`) and, for tools that update themselves or a
//! Node version manager's Node, reads the tool's release feed on this Mac as `agent_releases` does for the agents.

use super::agent_install::{homebrew_keg, is_bun, is_mise_shim, is_pnpm, npm_prefix, plain_name, shell_word};
use super::agent_releases::{client, fetch, parse_npm_latest};
use super::agents::AGENT_ENV;
use super::guarded_writes::{new_stamp, prune_backups, ChangeKind};
use super::setup::covered_machine;
use super::setup_sync::read_repo;
use super::setup_tools::{matches_pin, RepoTools, ToolWanted};
use super::setup_toolchain::{MachineToolchain, ToolFound, SETUP_TOOLCHAIN_UPDATED_EVENT, SYSTEM_PATHS, TOOL_ENV};
use super::shell::shell_quote;
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::cmp::Ordering;
use ts_rs::TS;

/// The installer that put a tool where the shell finds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OwnerKind {
    Brew,
    Mise,
    /// A global npm package, under the prefix it names.
    Npm,
    /// Node's corepack, which keeps pnpm and yarn.
    Corepack,
    /// Bun's own installer, which `bun upgrade` updates.
    Bun,
    /// Deno's own installer, which `deno upgrade` updates.
    Deno,
    /// uv's standalone installer, which `uv self update` updates.
    Uv,
    Rustup,
    Nvm,
    Fnm,
    Asdf,
    Volta,
    /// The system's packages (apt, dnf and the like, or macOS's own), which need sudo.
    System,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolOwner {
    kind: OwnerKind,
    /// Homebrew's formula, mise's tool, npm's package, or the system's package manager.
    name: Option<String>,
    /// npm's global prefix, or the Node whose corepack it is.
    prefix: Option<String>,
}

impl ToolOwner {
    fn new(kind: OwnerKind) -> Self {
        Self { kind, name: None, prefix: None }
    }

    fn named(kind: OwnerKind, name: &str) -> Self {
        Self { kind, name: Some(name.to_string()), prefix: None }
    }

    #[cfg(test)]
    pub(super) fn kind(&self) -> OwnerKind {
        self.kind
    }

    #[cfg(test)]
    pub(super) fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }
}

/// What a scan learned beside the tools' own paths.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct OwnerFacts {
    /// `brew --prefix`, with links resolved.
    pub(super) brew_prefix: Option<String>,
    pub(super) mise: Option<String>,
    pub(super) rustup: Option<String>,
    pub(super) uv_receipt: bool,
    /// apt-get, dnf and the like.
    pub(super) system: Option<String>,
}

impl OwnerFacts {
    /// Takes in one `B` line of the scan.
    pub(super) fn read(&mut self, key: &str, value: &str) {
        let path = || Some(value.to_string()).filter(|value| value.starts_with('/'));
        match key {
            "brew" => self.brew_prefix = path(),
            "mise" => self.mise = path(),
            "rustup" => self.rustup = path(),
            "uv-receipt" => self.uv_receipt = value == "1",
            "system" if plain_name(value, &[]) => self.system = Some(value.to_string()),
            _ => {}
        }
    }
}

/// The npm package a tool is, when it's installed as one.
fn npm_package(tool: &str) -> Option<&'static str> {
    Some(match tool {
        "npm" => "npm",
        "pnpm" => "pnpm",
        "yarn" => "yarn",
        "bun" => "bun",
        _ => return None,
    })
}

fn lower(path: &str) -> String {
    path.to_ascii_lowercase()
}

fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

/// Who installed the tool the shell finds at `path`, which really is `real`; `plugin` is the tool mise names for one of
/// its shims or installs. None when nothing proves it.
pub(super) fn prove_owner(tool: &str, path: &str, real: &str, plugin: &str, facts: &OwnerFacts) -> Option<ToolOwner> {
    let paths = [path, real];
    let lowered = lower(real);
    // mise gives the binary: its own tool, unless it's a global under mise's Node, which is npm's (or corepack's).
    if paths.iter().any(|path| is_mise_shim(path) || lower(path).contains("/mise/installs/")) {
        let plugin = plugin.trim();
        let node = matches!(plugin, "node" | "core:node");
        if plugin.is_empty() || !plain_name(plugin, &['/', ':']) {
            return None;
        }
        if !node || tool == "node" {
            return Some(ToolOwner::named(OwnerKind::Mise, plugin));
        }
    }
    if let Some(at) = lowered.find("/lib/node_modules/corepack/").filter(|_| matches!(tool, "pnpm" | "yarn")) {
        // The Node whose corepack it is: its `bin/corepack` is what changes it.
        return Some(ToolOwner { kind: OwnerKind::Corepack, name: None, prefix: Some(real[..at].to_string()).filter(|prefix| !prefix.is_empty()) });
    }
    if let Some(prefix) = npm_package(tool).and_then(|package| npm_prefix(real, package)) {
        // Bun's and pnpm's global folders lay packages out like npm's, but aren't npm's to update.
        if !is_bun(real) && !is_pnpm(real) {
            return Some(ToolOwner { kind: OwnerKind::Npm, name: npm_package(tool).map(str::to_string), prefix: Some(prefix) });
        }
    }
    match tool {
        "bun" if lowered.contains("/.bun/bin/") => return Some(ToolOwner::new(OwnerKind::Bun)),
        "deno" if lowered.contains("/.deno/bin/") => return Some(ToolOwner::new(OwnerKind::Deno)),
        "uv" if facts.uv_receipt && (lowered.ends_with("/.local/bin/uv") || lowered.ends_with("/.cargo/bin/uv")) => return Some(ToolOwner::new(OwnerKind::Uv)),
        // rustc and cargo in ~/.cargo/bin are rustup's proxies when rustup sits beside them.
        "rust" | "cargo" if path.contains("/.cargo/bin/") && facts.rustup.as_deref().is_some_and(|rustup| dir_of(rustup) == dir_of(path)) => {
            return Some(ToolOwner::new(OwnerKind::Rustup));
        }
        "node" => {
            let kind = if lowered.contains("/.nvm/versions/node/") {
                Some(OwnerKind::Nvm)
            } else if paths.iter().any(|path| lower(path).contains("fnm")) {
                Some(OwnerKind::Fnm)
            } else if paths.iter().any(|path| lower(path).contains("/.asdf/")) {
                Some(OwnerKind::Asdf)
            } else if paths.iter().any(|path| lower(path).contains("/.volta/")) {
                Some(OwnerKind::Volta)
            } else {
                None
            };
            if let Some(kind) = kind {
                return Some(ToolOwner::new(kind));
            }
        }
        _ => {}
    }
    if let Some((prefix, false, formula)) = homebrew_keg(real) {
        let owns = facts.brew_prefix.as_deref().is_some_and(|brew| brew.eq_ignore_ascii_case(&prefix));
        if owns && plain_name(&formula, &[]) {
            return Some(ToolOwner::named(OwnerKind::Brew, &formula));
        }
    }
    // What the system put in /usr/bin needs sudo to change, so it's only named, for an agent to be told.
    if ["/usr/bin/", "/bin/", "/usr/sbin/"].iter().any(|dir| real.starts_with(dir)) {
        let manager = facts.system.clone().unwrap_or_else(|| "system".into());
        return Some(ToolOwner { kind: OwnerKind::System, name: Some(manager), prefix: None });
    }
    None
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/// The numbers and pre-release tag of a version like `22.17.0`, `v1.90.0-nightly` or `3.14.0rc1`.
fn version_parts(version: &str) -> Option<(Vec<u64>, String)> {
    let version = version.trim().trim_start_matches('v');
    let end = version.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(version.len());
    let numbers = version[..end].trim_end_matches('.');
    if numbers.is_empty() {
        return None;
    }
    let nums = numbers.split('.').map(str::parse).collect::<Result<Vec<u64>, _>>().ok()?;
    let pre = version[end..].trim_start_matches('-');
    // Homebrew's `_1` is a rebuild of the same version, and `+build` says nothing about order.
    let pre = if pre.starts_with('_') || pre.starts_with('+') { "" } else { pre };
    Some((nums, pre.to_string()))
}

/// Which of two versions is newer: a release comes after its pre-releases.
pub(super) fn compare_versions(a: &str, b: &str) -> Ordering {
    let (Some((left, left_pre)), Some((right, right_pre))) = (version_parts(a), version_parts(b)) else { return a.cmp(b) };
    for index in 0..left.len().max(right.len()) {
        let order = left.get(index).unwrap_or(&0).cmp(right.get(index).unwrap_or(&0));
        if order != Ordering::Equal {
            return order;
        }
    }
    match (left_pre.is_empty(), right_pre.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => left_pre.cmp(&right_pre),
    }
}

/// A version as an installer states it: digits and dots, maybe a pre-release, nothing a command could trip on.
pub(super) fn plain_version(version: &str) -> Option<String> {
    let version = version.trim().trim_start_matches('v');
    (version.starts_with(|c: char| c.is_ascii_digit()) && version.len() <= 40 && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_')))
        .then(|| version.to_string())
}

fn major(version: &str) -> Option<u64> {
    version_parts(version).and_then(|(nums, _)| nums.first().copied())
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

/// The newest release of a tool its installer offers, as the last check found it.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolLatest {
    tool: String,
    version: String,
}

/// What a machine's last update check found.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolUpdates {
    checked_at: i64,
    /// The tools whose installer answered; the version is the one there when it's the newest.
    latest: Vec<ToolLatest>,
    /// The installers that didn't answer, each with the last thing it said.
    problems: Vec<String>,
}

impl ToolUpdates {
    pub(super) fn checked_at(&self) -> i64 {
        self.checked_at
    }

    pub(super) fn latest(&self) -> Vec<(&str, &str)> {
        self.latest.iter().map(|entry| (entry.tool.as_str(), entry.version.as_str())).collect()
    }
}

/// How long one installer's check gets on the machine.
const CHECK_S: u32 = 120;
const CHECK_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Homebrew's own list of formulae is refreshed only when the user asks, as it downloads it.
const BREW_UPDATE_S: u32 = 300;
/// What one check may send back; Homebrew's answer for a big install is tens of KB.
const CHECK_BYTES: u32 = 1024 * 1024;

const NODE_INDEX_URL: &str = "https://nodejs.org/dist/index.json";
const DENO_LATEST_URL: &str = "https://dl.deno.land/release-latest.txt";
const UV_PYPI_URL: &str = "https://pypi.org/pypi/uv/json";
const NPM_REGISTRY: &str = "https://registry.npmjs.org";

// Follows TOOL_ENV, with network allowed. `S check key status base64|- last-line` for each check: what it wrote to
// its output, and the last thing it said, from its errors when it wrote any.
const CHECK_HEAD: &str = r##"export HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_INSTALL_CLEANUP=1 NONINTERACTIVE=1
last_of() { tr -d '\r' < "$1" | grep -v '^[[:space:]]*$' | tail -n 1 | tr '\t' ' ' | cut -c 1-300; }
check() {
  kind=$1; key=$2; secs=$3; shift 3
  probes=$((probes + 1))
  out="$work/out.$probes"
  ( exec "$@" </dev/null >"$out" 2>"$out.err" ) &
  pid=$!
  ( sleep "$secs"; kill -9 "$pid" ) </dev/null >/dev/null 2>&1 &
  dog=$!
  wait "$pid" 2>/dev/null
  status=$?
  kill "$dog" 2>/dev/null
  wait "$dog" 2>/dev/null
  body=-
  if [ "$b64" = 1 ] && [ -s "$out" ]; then body=$(head -c "$most" "$out" | base64 | tr -d '\n\r'); fi
  last=$(last_of "$out.err")
  [ -n "$last" ] || last=$(last_of "$out")
  printf 'S\t%s\t%s\t%s\t%s\t%s\n' "$kind" "$key" "$status" "${body:--}" "$last"
}
"##;

/// One installer's check, as it runs on the machine.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Check {
    BrewUpdate,
    Brew,
    Mise,
    /// npm's global packages under a prefix.
    Npm(String),
    /// rustup's toolchains, with rustup where the scan found it.
    Rustup(String),
}

/// The checks a machine needs for the owners its tools have.
fn checks_for(tools: &[ToolFound], facts_rustup: Option<&str>, refresh: bool) -> Vec<Check> {
    let mut checks = Vec::new();
    let mut add = |check: Check| {
        if !checks.contains(&check) {
            checks.push(check);
        }
    };
    for found in tools {
        let Some(owner) = found.owner() else { continue };
        match owner.kind {
            OwnerKind::Brew => {
                if refresh {
                    add(Check::BrewUpdate);
                }
                add(Check::Brew);
            }
            OwnerKind::Mise => add(Check::Mise),
            OwnerKind::Npm => {
                if let Some(prefix) = owner.prefix.as_deref().filter(|prefix| prefix.starts_with('/')) {
                    add(Check::Npm(prefix.to_string()));
                }
            }
            OwnerKind::Rustup => {
                if let Some(rustup) = facts_rustup {
                    add(Check::Rustup(rustup.to_string()));
                }
            }
            _ => {}
        }
    }
    checks
}

fn check_script(checks: &[Check]) -> String {
    let mut script = format!("set -u\n{AGENT_ENV}{SYSTEM_PATHS}{TOOL_ENV}most={CHECK_BYTES}\n{CHECK_HEAD}");
    for check in checks {
        let line = match check {
            Check::BrewUpdate => format!("check brew-update - {BREW_UPDATE_S} brew update --quiet"),
            Check::Brew => format!("check brew - {CHECK_S} brew outdated --json=v2 --formula"),
            Check::Mise => format!("check mise - {CHECK_S} mise outdated --json"),
            Check::Npm(prefix) => {
                let quoted = shell_quote(prefix);
                let npm = shell_quote(&format!("{prefix}/bin/npm"));
                format!("npm_at={npm}\n[ -x \"$npm_at\" ] || npm_at=npm\ncheck npm {quoted} {CHECK_S} \"$npm_at\" outdated -g --json --prefix {quoted}")
            }
            Check::Rustup(rustup) => format!("check rustup - {CHECK_S} {} check", shell_quote(rustup)),
        };
        script.push_str(&line);
        script.push('\n');
    }
    script
}

/// One installer's answer.
#[derive(Clone, Debug, Default, PartialEq)]
struct Answer {
    kind: String,
    key: String,
    ok: bool,
    body: String,
    last: String,
}

fn parse_answers(stdout: &str) -> Vec<Answer> {
    stdout
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.splitn(6, '\t').collect();
            let ["S", kind, key, status, body, last] = fields.as_slice() else { return None };
            let body = (*body != "-").then(|| STANDARD.decode(body.trim()).ok()).flatten().map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or_default();
            // npm says some are out of date by stopping with 1, and Homebrew may too.
            let ok = *status == "0" || (*status == "1" && matches!(*kind, "npm" | "brew") && body.trim_start().starts_with('{'));
            Some(Answer { kind: kind.to_string(), key: key.to_string(), ok, body, last: last.trim().to_string() })
        })
        .collect()
}

/// Homebrew's out-of-date formulae: each name with the version it would upgrade to.
fn parse_brew_outdated(body: &str) -> Option<HashMap<String, String>> {
    let value: Value = serde_json::from_str(body).ok()?;
    let formulae = value.get("formulae")?.as_array()?;
    Some(
        formulae
            .iter()
            .filter_map(|formula| Some((formula.get("name")?.as_str()?.to_string(), plain_version(formula.get("current_version")?.as_str()?)?)))
            .collect(),
    )
}

/// mise's out-of-date tools, each with the newest version its request allows. mise has given both an object keyed by
/// tool and a list.
fn parse_mise_outdated(body: &str) -> Option<HashMap<String, String>> {
    let value: Value = serde_json::from_str(body.trim().is_empty().then_some("{}").unwrap_or(body)).ok()?;
    let entries: Vec<(Option<&str>, &Value)> = match &value {
        Value::Object(map) => map.iter().map(|(key, entry)| (Some(key.as_str()), entry)).collect(),
        Value::Array(list) => list.iter().map(|entry| (None, entry)).collect(),
        _ => return None,
    };
    Some(
        entries
            .into_iter()
            .filter_map(|(key, entry)| {
                let name = entry.get("name").and_then(Value::as_str).or(key)?;
                Some((name.to_string(), plain_version(entry.get("latest")?.as_str()?)?))
            })
            .collect(),
    )
}

/// npm's out-of-date global packages, each with its `latest`.
fn parse_npm_outdated(body: &str) -> Option<HashMap<String, String>> {
    let value: Value = serde_json::from_str(if body.trim().is_empty() { "{}" } else { body }).ok()?;
    Some(
        value
            .as_object()?
            .iter()
            .filter_map(|(name, entry)| Some((name.clone(), plain_version(entry.get("latest")?.as_str()?)?)))
            .collect(),
    )
}

/// rustup's toolchains with their version now and the one an update brings: `stable-… - Update available : 1.88.0
/// (…) -> 1.89.0 (…)` or `stable-… - Up to date : 1.89.0 (…)`.
fn parse_rustup_check(body: &str) -> Vec<(String, String, String)> {
    body.lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once(" - ")?;
            let (_, versions) = rest.split_once(':')?;
            let (now, next) = match versions.split_once("->") {
                Some((now, next)) => (super::setup_toolchain::version_in(now)?, super::setup_toolchain::version_in(next)?),
                None => {
                    let now = super::setup_toolchain::version_in(versions)?;
                    (now.clone(), now)
                }
            };
            (name.trim() != "rustup").then(|| (name.trim().to_string(), now, next))
        })
        .collect()
}

/// The newest Node on the same major line as `version`, from nodejs.org's index.
fn parse_node_index(body: &str, version: &str) -> Option<String> {
    let line = major(version)?;
    let list: Vec<Value> = serde_json::from_str(body).ok()?;
    list.iter()
        .filter_map(|entry| plain_version(entry.get("version")?.as_str()?))
        .filter(|candidate| major(candidate) == Some(line) && version_parts(candidate).is_some_and(|(_, pre)| pre.is_empty()))
        .max_by(|a, b| compare_versions(a, b))
}

fn parse_pypi_latest(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    plain_version(value.get("info")?.get("version")?.as_str()?)
}

/// What the machine's installers said, as the newest release of each tool they own.
fn latest_from_answers(tools: &[ToolFound], answers: &[Answer]) -> (Vec<ToolLatest>, Vec<String>) {
    let mut latest = Vec::new();
    let mut problems = Vec::new();
    let find = |kind: &str, key: &str| answers.iter().find(|answer| answer.kind == kind && answer.key == key);
    let brew = find("brew", "-").filter(|answer| answer.ok).and_then(|answer| parse_brew_outdated(&answer.body));
    let mise = find("mise", "-").filter(|answer| answer.ok).and_then(|answer| parse_mise_outdated(&answer.body));
    let rustup = find("rustup", "-").filter(|answer| answer.ok).map(|answer| parse_rustup_check(&answer.body));
    for answer in answers {
        let read = match answer.kind.as_str() {
            "brew" => brew.is_some(),
            "mise" => mise.is_some(),
            "rustup" => rustup.is_some(),
            "npm" => answer.ok && parse_npm_outdated(&answer.body).is_some(),
            _ => answer.ok,
        };
        if !read {
            let said = if answer.last.is_empty() { "it didn't answer".to_string() } else { answer.last.clone() };
            problems.push(format!("{}: {said}", answer.kind));
        }
    }
    for found in tools {
        let (Some(owner), Some(have)) = (found.owner(), found.version()) else { continue };
        let newest = match owner.kind {
            OwnerKind::Brew => brew.as_ref().map(|outdated| owner.name.as_ref().and_then(|name| outdated.get(name)).cloned()),
            OwnerKind::Mise => mise.as_ref().map(|outdated| owner.name.as_ref().and_then(|name| outdated.get(name.trim_start_matches("core:"))).cloned()),
            OwnerKind::Npm => owner.prefix.as_deref().and_then(|prefix| find("npm", prefix)).filter(|answer| answer.ok).and_then(|answer| parse_npm_outdated(&answer.body)).map(|outdated| {
                owner.name.as_ref().and_then(|name| outdated.get(name)).cloned()
            }),
            OwnerKind::Rustup => rustup.as_ref().map(|toolchains| {
                // The toolchain the shell's rustc is, else stable.
                toolchains
                    .iter()
                    .find(|(_, now, _)| now == have)
                    .or_else(|| toolchains.iter().find(|(name, _, _)| name.starts_with("stable")))
                    .map(|(_, _, next)| next.clone())
            }),
            _ => continue,
        };
        // An installer that answered without naming the tool has nothing newer for it.
        if let Some(newest) = newest {
            let version = newest.filter(|newest| compare_versions(newest, have) == Ordering::Greater).unwrap_or_else(|| have.to_string());
            latest.push(ToolLatest { tool: found.tool().to_string(), version });
        }
    }
    (latest, problems)
}

/// A feed's answer, kept a while so a page of machines asks once.
type Heard = (Instant, Option<String>);
static FEEDS: LazyLock<Mutex<HashMap<String, Heard>>> = LazyLock::new(Default::default);
const FEED_FRESH: Duration = Duration::from_secs(60 * 60);
const FEED_RETRY: Duration = Duration::from_secs(5 * 60);

async fn feed(client: Option<&reqwest::Client>, url: &str, fresh: bool) -> Option<String> {
    if !fresh {
        let feeds = FEEDS.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((at, body)) = feeds.get(url) {
            let keep = if body.is_some() { FEED_FRESH } else { FEED_RETRY };
            if at.elapsed() < keep {
                return body.clone();
            }
        }
    }
    let body = match client {
        Some(client) => fetch(client, url).await,
        None => None,
    };
    FEEDS.lock().unwrap_or_else(PoisonError::into_inner).insert(url.to_string(), (Instant::now(), body.clone()));
    body
}

/// The newest release of the tools no installer on the machine answers for, from their feeds, read on this Mac.
async fn latest_from_feeds(client: Option<&reqwest::Client>, tools: &[ToolFound], fresh: bool) -> Vec<ToolLatest> {
    let mut latest = Vec::new();
    for found in tools {
        let (Some(owner), Some(have)) = (found.owner(), found.version()) else { continue };
        let newest = match (owner.kind, found.tool()) {
            (OwnerKind::Corepack, "pnpm") => feed(client, &format!("{NPM_REGISTRY}/pnpm/latest"), fresh).await.and_then(|body| parse_npm_latest(&body)),
            // Yarn 1 and Yarn 2 and later are different packages.
            (OwnerKind::Corepack, "yarn") if major(have) == Some(1) => feed(client, &format!("{NPM_REGISTRY}/yarn/latest"), fresh).await.and_then(|body| parse_npm_latest(&body)),
            (OwnerKind::Corepack, "yarn") => feed(client, &format!("{NPM_REGISTRY}/@yarnpkg%2Fcli-dist/latest"), fresh).await.and_then(|body| parse_npm_latest(&body)),
            (OwnerKind::Bun, _) => feed(client, &format!("{NPM_REGISTRY}/bun/latest"), fresh).await.and_then(|body| parse_npm_latest(&body)),
            (OwnerKind::Deno, _) => feed(client, DENO_LATEST_URL, fresh).await.and_then(|body| plain_version(body.lines().next().unwrap_or_default())),
            (OwnerKind::Uv, _) => feed(client, UV_PYPI_URL, fresh).await.and_then(|body| parse_pypi_latest(&body)),
            (OwnerKind::Nvm | OwnerKind::Fnm | OwnerKind::Asdf | OwnerKind::Volta, "node") => feed(client, NODE_INDEX_URL, fresh).await.and_then(|body| parse_node_index(&body, have)),
            _ => continue,
        };
        if let Some(newest) = newest {
            let version = if compare_versions(&newest, have) == Ordering::Greater { newest } else { have.to_string() };
            latest.push(ToolLatest { tool: found.tool().to_string(), version });
        }
    }
    latest
}

/// A machine's installers are asked again by itself after a scan once their last answer is this old.
const CHECK_FRESH_MS: i64 = 6 * 60 * 60 * 1000;

/// Whether a machine's last update check is old enough that a scan should ask again.
pub(super) fn check_due(toolchain: &MachineToolchain, now_ms: i64) -> bool {
    !toolchain.checking() && toolchain.updates_checked_at().is_none_or(|at| now_ms - at > CHECK_FRESH_MS)
}

/// Asks each installer that owns a tool on the machine what's newer, and keeps the answer beside its last scan.
/// `refresh` has Homebrew fetch its list of formulae first and reads the feeds again, for when the user asks.
pub(super) async fn run_check(app: &tauri::AppHandle, machine: &str, refresh: bool) -> Result<MachineToolchain, String> {
    let state = app.state::<MachineHealthState>();
    let (target, tools, rustup) = {
        let mut inner = state.lock();
        let target = covered_machine(&inner, machine)?.0;
        let scan = inner.toolchain.get_mut(machine).filter(|scan| scan.scanned_at().is_some()).ok_or_else(|| format!("Look at the tools on {machine} first"))?;
        if scan.checking() {
            return Err(format!("Arbor is already checking for updates on {machine}"));
        }
        scan.set_checking(true);
        (target, scan.tools().to_vec(), scan.facts().rustup.clone())
    };
    let _ = app.emit(SETUP_TOOLCHAIN_UPDATED_EVENT, Local::now().timestamp_millis());
    let checks = checks_for(&tools, rustup.as_deref(), refresh);
    let mut result: Result<ToolUpdates, String> = Ok(ToolUpdates::default());
    if !checks.is_empty() {
        result = match run_on_machine(&target, MachineOp::ToolCheck, &check_script(&checks), CHECK_TIMEOUT).await {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let answers = parse_answers(&stdout);
                if answers.is_empty() {
                    Err(failure_detail(&output))
                } else {
                    let (latest, problems) = latest_from_answers(&tools, &answers);
                    Ok(ToolUpdates { latest, problems, ..ToolUpdates::default() })
                }
            }
            Err(error) => Err(error),
        };
    }
    if let Ok(updates) = result.as_mut() {
        let client = client(&app.state::<GuiConfigState>());
        updates.latest.extend(latest_from_feeds(client.as_ref(), &tools, refresh).await);
        updates.checked_at = Local::now().timestamp_millis();
    }
    let failure = result.as_ref().err().cloned();
    let toolchain = {
        let mut inner = state.lock();
        let entry = inner.toolchain.get_mut(machine).ok_or_else(|| format!("Look at the tools on {machine} first"))?;
        entry.set_checking(false);
        match result {
            Ok(updates) => entry.set_updates(updates),
            Err(error) => entry.set_check_error(error),
        }
        entry.clone()
    };
    let _ = app.emit(SETUP_TOOLCHAIN_UPDATED_EVENT, Local::now().timestamp_millis());
    match failure {
        Some(error) => Err(error),
        None => Ok(toolchain),
    }
}

/// Asks each installer that owns a tool on the machine what's newer. A scan does this by itself when the last answer
/// is old; this is for when the user asks, or after an update.
#[tauri::command]
pub(crate) async fn check_tool_updates(app: tauri::AppHandle, machine: String, refresh: bool) -> Result<MachineToolchain, String> {
    run_check(&app, &machine, refresh).await
}

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

/// Installs download, so they get longer.
const CHANGE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const MOST_TOOL_CHANGES: usize = 16;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ToolAction {
    /// A tool the machine hasn't got, with the installer `via` names.
    Install,
    /// To the version given, or the newest its installer has.
    Update,
    Remove,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolChange {
    tool: String,
    action: ToolAction,
    /// For an install or update, the version to go to; none for the newest its installer has. A Node version manager's
    /// Node needs one, as it keeps each version apart.
    version: Option<String>,
    /// For an install, the installer to use: brew, mise or npm.
    via: Option<OwnerKind>,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolResult {
    tool: String,
    action: ToolAction,
    ok: bool,
    /// The last thing the installer said, when it failed.
    message: Option<String>,
}

/// One change as it runs: the command, and how History names it.
#[derive(Clone, Debug, PartialEq)]
struct Planned {
    command: String,
    what: String,
    removes: bool,
}

fn owner_label(owner: &ToolOwner) -> &'static str {
    match owner.kind {
        OwnerKind::Brew => "Homebrew",
        OwnerKind::Mise => "mise",
        OwnerKind::Npm => "npm",
        OwnerKind::Corepack => "corepack",
        OwnerKind::Bun => "bun upgrade",
        OwnerKind::Deno => "deno upgrade",
        OwnerKind::Uv => "uv self update",
        OwnerKind::Rustup => "rustup",
        OwnerKind::Nvm => "nvm",
        OwnerKind::Fnm => "fnm",
        OwnerKind::Asdf => "asdf",
        OwnerKind::Volta => "Volta",
        OwnerKind::System => "the system",
    }
}

/// The command that makes one change with the installer that owns the tool, or why Arbor won't make it.
fn tool_command(found: &ToolFound, owner: &ToolOwner, facts: &OwnerFacts, change: &ToolChange) -> Result<String, String> {
    let tool = found.tool();
    let q = shell_word;
    let version = change.version.as_deref();
    let name = owner.name.as_deref().filter(|name| plain_name(name, &['/', ':'])).ok_or_else(|| format!("Arbor can't tell which of {}'s packages {tool} is", owner_label(owner)));
    let no_version = |what: &str| match version {
        Some(_) => Err(format!("{what} only updates {tool} to its newest release")),
        None => Ok(()),
    };
    let update = change.action == ToolAction::Update;
    Ok(match owner.kind {
        OwnerKind::System => return Err(format!("{tool} came with the system, and changing it needs sudo: hand it to an agent")),
        OwnerKind::Brew => {
            let brew = facts.brew_prefix.as_deref().map(|prefix| q(&format!("{prefix}/bin/brew"))).ok_or("Homebrew wasn't found on the last scan")?;
            if update {
                no_version("Homebrew")?;
                format!("{brew} upgrade --formula {}", q(name?))
            } else {
                format!("{brew} uninstall --formula {}", q(name?))
            }
        }
        OwnerKind::Mise => {
            let mise = facts.mise.as_deref().map(q).ok_or("mise wasn't found on the last scan")?;
            let name = name?;
            match (update, version) {
                (true, Some(version)) => format!("{mise} use -g {}", q(&format!("{name}@{version}"))),
                (true, None) => format!("{mise} upgrade {}", q(name)),
                (false, _) => format!("{mise} use -g --remove {name} >/dev/null 2>&1; {mise} uninstall --all {}", q(name), name = q(name)),
            }
        }
        OwnerKind::Npm => {
            let prefix = owner.prefix.as_deref().filter(|prefix| prefix.starts_with('/')).ok_or("npm's prefix wasn't found on the last scan")?;
            let name = name?;
            if !update && tool == "npm" {
                return Err("npm came with its Node, which needs it: remove that Node instead".into());
            }
            let npm = format!("npm_at={}; [ -x \"$npm_at\" ] || npm_at=npm; \"$npm_at\"", q(&format!("{prefix}/bin/npm")));
            if update {
                format!("{npm} install -g --prefix {} {}", q(prefix), q(&format!("{name}@{}", version.unwrap_or("latest"))))
            } else {
                format!("{npm} uninstall -g --prefix {} {}", q(prefix), q(name))
            }
        }
        OwnerKind::Corepack => {
            let corepack = owner.prefix.as_deref().map(|prefix| q(&format!("{prefix}/bin/corepack"))).unwrap_or_else(|| "corepack".into());
            if update {
                format!("{corepack} install -g {}", q(&format!("{tool}@{}", version.unwrap_or("latest"))))
            } else {
                format!("{corepack} disable {}", q(tool))
            }
        }
        OwnerKind::Bun | OwnerKind::Deno | OwnerKind::Uv | OwnerKind::Rustup if !update => {
            return Err(format!("{tool} came from its own installer, which has no command to take it off: hand it to an agent"));
        }
        OwnerKind::Bun => {
            no_version("bun upgrade")?;
            format!("{} upgrade", q(found.path()))
        }
        OwnerKind::Deno => match version {
            Some(version) => format!("{} upgrade --version {}", q(found.path()), q(version)),
            None => format!("{} upgrade", q(found.path())),
        },
        OwnerKind::Uv => match version {
            Some(version) => format!("{} self update {}", q(found.path()), q(version)),
            None => format!("{} self update", q(found.path())),
        },
        OwnerKind::Rustup => {
            no_version("rustup")?;
            let rustup = facts.rustup.as_deref().map(q).ok_or("rustup wasn't found on the last scan")?;
            format!("{rustup} update")
        }
        OwnerKind::Nvm | OwnerKind::Fnm | OwnerKind::Asdf | OwnerKind::Volta => {
            if !update {
                return Err("Take a Node version off with Node's versions, from its cell".into());
            }
            let version = version.ok_or("Say which Node version to move to")?;
            let manager = match owner.kind {
                OwnerKind::Nvm => "nvm",
                OwnerKind::Fnm => "fnm",
                OwnerKind::Asdf => "asdf",
                _ => "volta",
            };
            super::setup_toolchain::node_update_command(manager, version)
        }
    })
}

/// Homebrew's formula for a tool. Cargo comes with Rust, and npm with Node.
fn brew_formula(tool: &str) -> Option<&'static str> {
    Some(match tool {
        "node" => "node",
        "pnpm" => "pnpm",
        "yarn" => "yarn",
        "bun" => "oven-sh/bun/bun",
        "deno" => "deno",
        "python" => "python",
        "uv" => "uv",
        "go" => "go",
        "rust" => "rust",
        "git" => "git",
        "gh" => "gh",
        "jq" => "jq",
        "rg" => "ripgrep",
        _ => return None,
    })
}

/// mise's name for a tool.
fn mise_name(tool: &str) -> Option<&'static str> {
    Some(match tool {
        "node" => "node",
        "pnpm" => "pnpm",
        "yarn" => "yarn",
        "bun" => "bun",
        "deno" => "deno",
        "python" => "python",
        "uv" => "uv",
        "go" => "go",
        "rust" => "rust",
        "gh" => "gh",
        "jq" => "jq",
        "rg" => "ripgrep",
        _ => return None,
    })
}

/// The installers on the machine, as its last scan found them.
pub(super) fn installers_on(scan: &MachineToolchain) -> Vec<OwnerKind> {
    let mut found = Vec::new();
    if scan.facts().brew_prefix.is_some() {
        found.push(OwnerKind::Brew);
    }
    if scan.facts().mise.is_some() {
        found.push(OwnerKind::Mise);
    }
    if scan.tools().iter().any(|tool| tool.tool() == "npm") {
        found.push(OwnerKind::Npm);
    }
    found
}

/// The command that installs a tool the machine hasn't got, with `via`, or why that installer can't.
fn install_command(scan: &MachineToolchain, tool: &str, via: OwnerKind, version: Option<&str>) -> Result<String, String> {
    let q = shell_word;
    let facts = scan.facts();
    match via {
        OwnerKind::Brew => {
            let formula = brew_formula(tool).ok_or_else(|| format!("Arbor doesn't install {tool} with Homebrew"))?;
            if version.is_some() {
                return Err(format!("Homebrew installs only the newest {tool}"));
            }
            let brew = facts.brew_prefix.as_deref().map(|prefix| q(&format!("{prefix}/bin/brew"))).ok_or("Homebrew wasn't found on the last scan")?;
            Ok(format!("{brew} install --formula {}", q(formula)))
        }
        OwnerKind::Mise => {
            let name = mise_name(tool).ok_or_else(|| format!("Arbor doesn't install {tool} with mise"))?;
            let mise = facts.mise.as_deref().map(q).ok_or("mise wasn't found on the last scan")?;
            Ok(format!("{mise} use -g {}", q(&format!("{name}@{}", version.unwrap_or("latest")))))
        }
        OwnerKind::Npm => {
            let package = npm_package(tool).filter(|package| *package != "npm").ok_or_else(|| format!("Arbor doesn't install {tool} with npm"))?;
            let npm = scan.tools().iter().find(|found| found.tool() == "npm").map(|found| q(found.path())).ok_or("npm wasn't found on the last scan")?;
            Ok(format!("{npm} install -g {}", q(&format!("{package}@{}", version.unwrap_or("latest")))))
        }
        _ => Err(format!("Arbor installs tools only with Homebrew, mise or npm, not {}", owner_label(&ToolOwner::new(via)))),
    }
}

/// The first installer in `order` the machine has that can give it `tool` at `version`.
pub(super) fn installer_for(scan: &MachineToolchain, order: &[OwnerKind], tool: &str, version: Option<&str>) -> Option<OwnerKind> {
    let here = installers_on(scan);
    order.iter().copied().find(|via| here.contains(via) && install_command(scan, tool, *via, version).is_ok())
}

/// Checks one change against the machine's last scan: a tool it has, with an owner Arbor proved (or one it hasn't, for
/// an install), and a version passed on only as plain numbers.
fn plan_one(scan: &MachineToolchain, change: &ToolChange) -> Result<Planned, String> {
    if let Some(version) = change.version.as_deref() {
        if plain_version(version).as_deref() != Some(version.trim_start_matches('v')) || change.action == ToolAction::Remove {
            return Err(format!("{version} isn't a version Arbor passes on: use numbers like 22 or 0.9.1"));
        }
    }
    let found = scan.tools().iter().find(|found| found.tool() == change.tool);
    if change.action == ToolAction::Install {
        if found.is_some() {
            return Err(format!("{} is on {} already", change.tool, scan.machine()));
        }
        let via = change.via.ok_or_else(|| format!("No installer Arbor uses on {} can give it {}: hand it to an agent", scan.machine(), change.tool))?;
        let command = install_command(scan, &change.tool, via, change.version.as_deref())?;
        let what = format!("{} {} ({})", change.tool, change.version.as_deref().unwrap_or("latest"), owner_label(&ToolOwner::new(via)));
        return Ok(Planned { command, what, removes: false });
    }
    let found = found.ok_or_else(|| format!("{} isn't on {} as its last scan found. Scan again.", change.tool, scan.machine()))?;
    let owner = found.owner().ok_or_else(|| format!("Arbor can't tell how {} got onto {}, so it leaves it to an agent", change.tool, scan.machine()))?;
    let command = tool_command(found, owner, scan.facts(), change)?;
    let have = found.version().unwrap_or("?");
    Ok(Planned { command, what: format!("{} {have} ({})", change.tool, owner_label(owner)), removes: change.action == ToolAction::Remove })
}

/// Checks each change against the machine's last scan, as `plan_one` does, with each tool once.
fn plan_tool_changes(scan: &MachineToolchain, changes: &[ToolChange]) -> Result<Vec<Planned>, String> {
    if changes.is_empty() {
        return Err("There's nothing to change".into());
    }
    if changes.len() > MOST_TOOL_CHANGES {
        return Err(format!("Arbor makes at most {MOST_TOOL_CHANGES} changes to tools at once"));
    }
    let mut planned = Vec::new();
    for (index, change) in changes.iter().enumerate() {
        if changes[..index].iter().any(|earlier| earlier.tool == change.tool) {
            return Err(format!("{} is in the list twice", change.tool));
        }
        planned.push(plan_one(scan, change)?);
    }
    Ok(planned)
}

/// Makes each change in turn, each in its own shell with stdin closed and whatever the one before did, and says how
/// each went: `R index status last-line`. What worked goes in History, as a change nothing can undo.
fn change_script(planned: &[Planned], stamp: &str) -> String {
    let mut script = format!(
        "set -u\n{AGENT_ENV}{SYSTEM_PATHS}PATH=\"$HOME/.cargo/bin:$HOME/.deno/bin:$HOME/.local/share/fnm:$HOME/.fnm:$HOME/.asdf/bin:$HOME/.asdf/shims:$PATH\"\nexport PATH\n\
         export NO_UPDATE_NOTIFIER=1 npm_config_update_notifier=false HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ENV_HINTS=1 NONINTERACTIVE=1 MISE_YES=1 \\\n  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 DENO_NO_UPDATE_CHECK=1\n\
         cd \"$HOME\" || exit 3\nout=$(mktemp \"${{TMPDIR:-/tmp}}/arbor-tools.XXXXXX\") || exit 1\ntrap 'rm -f \"$out\"' EXIT\nnl='\n'\nlisted=\nstamp={}\n",
        shell_quote(stamp)
    );
    for (index, plan) in planned.iter().enumerate() {
        let change = if plan.removes { "removed" } else { "changed" };
        script.push_str(&format!(
            "( {} ) </dev/null >\"$out\" 2>&1\nstatus=$?\nprintf 'R\\t{index}\\t%s\\t%s\\n' \"$status\" \"$(tr -d '\\r' < \"$out\" | grep -v '^[[:space:]]*$' | tail -n 1 | tr '\\t' ' ' | cut -c 1-300)\"\n\
             if [ \"$status\" = 0 ]; then listed=\"${{listed}}T\t\"{}\"\t{change}$nl\"; fi\n",
            plan.command,
            shell_quote(&plan.what.replace(['\t', '\n', '\r'], " "))
        ));
    }
    script.push_str(&format!(
        "if [ -n \"$listed\" ]; then\n\
         \x20 root=\"$HOME/.arbor/setup-backups\"\n\
         \x20 if (umask 077 && mkdir -p \"$root/$stamp\") && chmod 700 \"$root\" && printf 'what\\t{}\\n%s' \"$listed\" > \"$root/$stamp/manifest\"; then\n\
         \x20   printf 'K\\t%s\\n' \"$stamp\"\n\
         \x20 fi\n\
         {}fi\n",
        ChangeKind::Tools.name(),
        prune_backups()
    ));
    script
}

fn parse_tool_results(stdout: &str, changes: &[ToolChange]) -> Vec<ToolResult> {
    let mut results: Vec<ToolResult> =
        changes.iter().map(|change| ToolResult { tool: change.tool.clone(), action: change.action, ok: false, message: Some("It didn't run".into()) }).collect();
    for line in stdout.lines() {
        let mut fields = line.splitn(4, '\t');
        if fields.next() != Some("R") {
            continue;
        }
        let (Some(Ok(index)), Some(status)) = (fields.next().map(str::parse::<usize>), fields.next()) else { continue };
        let said = fields.next().map(str::trim).filter(|said| !said.is_empty()).map(str::to_string);
        if let Some(result) = results.get_mut(index) {
            result.ok = status == "0";
            result.message = if result.ok { None } else { said.or_else(|| Some(format!("It stopped with status {status}"))) };
        }
    }
    results
}

/// Runs planned changes on a machine and reads how each went.
async fn run_planned(target: &Machine, planned: &[Planned], changes: &[ToolChange]) -> Result<Vec<ToolResult>, String> {
    let output = run_on_machine(target, MachineOp::ToolChange, &change_script(planned, &new_stamp()), CHANGE_TIMEOUT).await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !stdout.lines().any(|line| line.starts_with("R\t")) {
        return Err(failure_detail(&output));
    }
    Ok(parse_tool_results(&stdout, changes))
}

/// Updates or removes tools on a machine with the installers that put them there, each change on its own, so one that
/// fails doesn't stop the rest. The page looks at the machine's tools again after.
#[tauri::command]
pub(crate) async fn change_tools(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    changes: Vec<ToolChange>,
) -> Result<Vec<ToolResult>, String> {
    let (target, planned) = {
        let inner = state.lock();
        let target = covered_machine(&inner, &machine)?.0;
        let scan = inner.toolchain.get(&machine).filter(|scan| scan.scanned_at().is_some()).ok_or_else(|| format!("Look at the tools on {machine} first"))?;
        if scan.is_scanning() {
            return Err(format!("Arbor is looking at the tools on {machine}. Try again once it's done."));
        }
        (target, plan_tool_changes(scan, &changes)?)
    };
    let results = run_planned(&target, &planned, &changes).await?;
    let _ = app.emit(SETUP_TOOLCHAIN_UPDATED_EVENT, Local::now().timestamp_millis());
    Ok(results)
}

/// What bringing a machine's tools in line with the setup repo changes, from its last look and the newest its
/// installers had at the last check. A tool it hasn't got is installed with the first installer the repo's order for
/// its OS names that it has and that can give it.
pub(super) fn repo_changes(scan: &MachineToolchain, tools: &RepoTools, role: Option<&str>) -> Vec<ToolChange> {
    let key = normalize_machine_name(scan.machine());
    let order = tools.installers_for(scan.os());
    let latest = scan.latest();
    let newer = |tool: &str, have: &str| latest.iter().any(|(name, version)| *name == tool && compare_versions(version, have) == Ordering::Greater);
    tools
        .tools()
        .iter()
        .filter_map(|listed| {
            let tool = listed.tool();
            let found = scan.tools().iter().find(|found| found.tool() == tool);
            let change = |action, version: Option<&str>, via| ToolChange { tool: tool.to_string(), action, version: version.map(str::to_string), via };
            match (listed.wanted_on(&key, role), found) {
                (ToolWanted::Own, _) | (ToolWanted::Removed, None) => None,
                (ToolWanted::Removed, Some(_)) => Some(change(ToolAction::Remove, None, None)),
                (ToolWanted::Latest, None) => Some(change(ToolAction::Install, None, installer_for(scan, order, tool, None))),
                (ToolWanted::Version(pin), None) => Some(change(ToolAction::Install, Some(&pin), installer_for(scan, order, tool, Some(&pin)))),
                (ToolWanted::Latest, Some(found)) => {
                    let have = found.version()?;
                    newer(tool, have).then(|| change(ToolAction::Update, None, None))
                }
                (ToolWanted::Version(pin), Some(found)) => {
                    let have = found.version()?;
                    (!matches_pin(have, &pin)).then(|| change(ToolAction::Update, Some(&pin), None))
                }
            }
        })
        .collect()
}

/// Brings a machine's tools in line with the setup repo's .agents/tools.json, each change on its own, then looks at the
/// machine's tools again and asks its installers what's newer, so Sync's standing says what's left.
#[tauri::command]
pub(crate) async fn apply_repo_tools(app: tauri::AppHandle, repo: String, machine: String) -> Result<Vec<ToolResult>, String> {
    let found = read_repo(Path::new(&repo)).await?;
    let role = found.layers().role_of(&machine).map(str::to_string);
    let (target, changes, plans) = {
        let state = app.state::<MachineHealthState>();
        let inner = state.lock();
        let target = covered_machine(&inner, &machine)?.0;
        let scan = inner.toolchain.get(&machine).filter(|scan| scan.scanned_at().is_some()).ok_or_else(|| format!("Look at the tools on {machine} first"))?;
        if scan.is_scanning() {
            return Err(format!("Arbor is looking at the tools on {machine}. Try again once it's done."));
        }
        let changes = repo_changes(scan, found.tools(), role.as_deref());
        let plans: Vec<Result<Planned, String>> = changes.iter().map(|change| plan_one(scan, change)).collect();
        (target, changes, plans)
    };
    let mut results: Vec<ToolResult> = changes
        .iter()
        .zip(&plans)
        .map(|(change, plan)| ToolResult { tool: change.tool.clone(), action: change.action, ok: false, message: plan.as_ref().err().cloned() })
        .collect();
    let runnable: Vec<(usize, Planned)> = plans.into_iter().enumerate().filter_map(|(index, plan)| Some((index, plan.ok()?))).collect();
    if !runnable.is_empty() {
        let planned: Vec<Planned> = runnable.iter().map(|(_, plan)| plan.clone()).collect();
        let ran: Vec<ToolChange> = runnable.iter().filter_map(|(index, _)| changes.get(*index).cloned()).collect();
        let outcome = run_planned(&target, &planned, &ran).await;
        for (slot, (index, _)) in runnable.iter().enumerate() {
            if let Some(result) = results.get_mut(*index) {
                match &outcome {
                    Ok(outcomes) => *result = outcomes.get(slot).cloned().unwrap_or_else(|| result.clone()),
                    Err(error) => result.message = Some(error.clone()),
                }
            }
        }
        let _ = super::setup_toolchain::scan_toolchain(app.clone(), app.state(), machine.clone()).await;
        let _ = run_check(&app, &machine, false).await;
    }
    super::setup_standing::refresh(&app).await;
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> OwnerFacts {
        OwnerFacts {
            brew_prefix: Some("/opt/homebrew".into()),
            mise: Some("/Users/a/.local/bin/mise".into()),
            rustup: Some("/Users/a/.cargo/bin/rustup".into()),
            uv_receipt: true,
            system: Some("apt-get".into()),
        }
    }

    fn owner(tool: &str, path: &str, real: &str, plugin: &str) -> Option<(OwnerKind, Option<String>, Option<String>)> {
        prove_owner(tool, path, real, plugin, &facts()).map(|owner| (owner.kind, owner.name, owner.prefix))
    }

    #[test]
    fn each_owner_is_proven_from_where_the_binary_really_is() {
        let kind = |tool: &str, path: &str, real: &str, plugin: &str| owner(tool, path, real, plugin).map(|owner| owner.0);
        assert_eq!(owner("uv", "/opt/homebrew/bin/uv", "/opt/homebrew/Cellar/uv/0.8.3/bin/uv", ""), Some((OwnerKind::Brew, Some("uv".into()), None)));
        assert_eq!(owner("rg", "/home/linuxbrew/.linuxbrew/bin/rg", "/home/linuxbrew/.linuxbrew/Cellar/ripgrep/14.1.1/bin/rg", ""), None, "another Homebrew's keg isn't this one's");
        assert_eq!(owner("python", "/Users/a/.local/share/mise/shims/python3", "/Users/a/.local/share/mise/installs/python/3.12.4/bin/python3", "python"), Some((OwnerKind::Mise, Some("python".into()), None)));
        assert_eq!(kind("python", "/Users/a/.local/share/mise/shims/python3", "/Users/a/.local/bin/mise", ""), None, "a shim mise doesn't name is unproven");
        assert_eq!(kind("gh", "/Users/a/.local/share/mise/shims/gh", "/x/mise/installs/gh/2.74.0/gh", "aqua:cli/cli"), Some(OwnerKind::Mise));
        // A global under mise's Node is npm's.
        assert_eq!(
            owner("pnpm", "/Users/a/.local/share/mise/shims/pnpm", "/Users/a/.local/share/mise/installs/node/22.1.0/lib/node_modules/pnpm/bin/pnpm.cjs", "node"),
            Some((OwnerKind::Npm, Some("pnpm".into()), Some("/Users/a/.local/share/mise/installs/node/22.1.0".into())))
        );
        assert_eq!(kind("node", "/Users/a/.local/share/mise/shims/node", "/Users/a/.local/share/mise/installs/node/22.1.0/bin/node", "node"), Some(OwnerKind::Mise));
        assert_eq!(
            owner("npm", "/Users/a/.nvm/versions/node/v22.17.0/bin/npm", "/Users/a/.nvm/versions/node/v22.17.0/lib/node_modules/npm/bin/npm-cli.js", ""),
            Some((OwnerKind::Npm, Some("npm".into()), Some("/Users/a/.nvm/versions/node/v22.17.0".into())))
        );
        assert_eq!(owner("pnpm", "/usr/local/bin/pnpm", "/usr/local/lib/node_modules/corepack/dist/pnpm.js", ""), Some((OwnerKind::Corepack, None, Some("/usr/local".into()))));
        assert_eq!(kind("pnpm", "/Users/a/Library/pnpm/pnpm", "/Users/a/Library/pnpm/global/5/node_modules/pnpm/bin/pnpm.cjs", ""), None, "pnpm's own global folder isn't npm's");
        assert_eq!(kind("bun", "/Users/a/.bun/bin/bun", "/Users/a/.bun/bin/bun", ""), Some(OwnerKind::Bun));
        assert_eq!(kind("deno", "/Users/a/.deno/bin/deno", "/Users/a/.deno/bin/deno", ""), Some(OwnerKind::Deno));
        assert_eq!(kind("uv", "/home/a/.local/bin/uv", "/home/a/.local/bin/uv", ""), Some(OwnerKind::Uv));
        let without_receipt = OwnerFacts { uv_receipt: false, ..facts() };
        assert_eq!(prove_owner("uv", "/home/a/.local/bin/uv", "/home/a/.local/bin/uv", "", &without_receipt), None, "pipx puts uv there too");
        assert_eq!(kind("rust", "/Users/a/.cargo/bin/rustc", "/Users/a/.cargo/bin/rustup", ""), Some(OwnerKind::Rustup));
        assert_eq!(kind("cargo", "/home/b/.cargo/bin/cargo", "/home/b/.cargo/bin/cargo", ""), None, "rustup isn't beside it");
        assert_eq!(kind("node", "/Users/a/.nvm/versions/node/v22.17.0/bin/node", "/Users/a/.nvm/versions/node/v22.17.0/bin/node", ""), Some(OwnerKind::Nvm));
        assert_eq!(kind("node", "/Users/a/.local/share/fnm/aliases/default/bin/node", "/Users/a/.local/share/fnm/node-versions/v22.1.0/installation/bin/node", ""), Some(OwnerKind::Fnm));
        assert_eq!(kind("node", "/Users/a/.volta/bin/node", "/Users/a/.volta/bin/volta-shim", ""), Some(OwnerKind::Volta));
        assert_eq!(owner("git", "/usr/bin/git", "/usr/bin/git", ""), Some((OwnerKind::System, Some("apt-get".into()), None)));
        assert_eq!(kind("docker", "/usr/local/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker", ""), None);
        assert_eq!(kind("jq", "/usr/local/bin/jq", "/usr/local/bin/jq", ""), None, "a binary someone put there by hand is nobody's");
    }

    #[test]
    fn versions_compare_by_their_numbers() {
        assert_eq!(compare_versions("0.12.0", "0.11.29"), Ordering::Greater);
        assert_eq!(compare_versions("v22.17.0", "22.17.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.90.0-nightly", "1.90.0"), Ordering::Less);
        assert_eq!(compare_versions("3.13.5_1", "3.13.5"), Ordering::Equal);
        assert_eq!(compare_versions("1.10", "1.9.9"), Ordering::Greater);
        assert_eq!(plain_version("v2.4.0").as_deref(), Some("2.4.0"));
        assert_eq!(plain_version("1.0; rm -rf ~"), None);
    }

    #[test]
    fn each_installer_says_what_is_newer() {
        let brew = r#"{"formulae":[{"name":"uv","installed_versions":["0.8.3"],"current_version":"0.9.1","pinned":false},{"name":"bad","current_version":"$(x)"}],"casks":[]}"#;
        assert_eq!(parse_brew_outdated(brew), Some(HashMap::from([("uv".to_string(), "0.9.1".to_string())])));
        assert_eq!(parse_brew_outdated("Error: no"), None);
        let mise = r#"{"node":{"name":"node","requested":"22","current":"22.1.0","latest":"22.2.0"}}"#;
        assert_eq!(parse_mise_outdated(mise), Some(HashMap::from([("node".to_string(), "22.2.0".to_string())])));
        assert_eq!(parse_mise_outdated(r#"[{"name":"go","current":"1.24.0","latest":"1.24.4"}]"#), Some(HashMap::from([("go".to_string(), "1.24.4".to_string())])));
        assert_eq!(parse_mise_outdated(""), Some(HashMap::new()));
        let npm = r#"{"pnpm":{"current":"9.0.0","wanted":"10.2.0","latest":"10.2.0","location":"/x"}}"#;
        assert_eq!(parse_npm_outdated(npm), Some(HashMap::from([("pnpm".to_string(), "10.2.0".to_string())])));
        let rustup = "stable-aarch64-apple-darwin - Update available : 1.88.0 (6b00bc388 2026-06-23) -> 1.89.0 (29483883e 2026-08-04)\nnightly-2026-09-01-aarch64-apple-darwin - Up to date : 1.90.0-nightly (abc 2026-08-31)\nrustup - Up to date : 1.28.2\n";
        assert_eq!(
            parse_rustup_check(rustup),
            vec![
                ("stable-aarch64-apple-darwin".to_string(), "1.88.0".to_string(), "1.89.0".to_string()),
                ("nightly-2026-09-01-aarch64-apple-darwin".to_string(), "1.90.0-nightly".to_string(), "1.90.0-nightly".to_string()),
            ]
        );
        let index = r#"[{"version":"v24.3.0","lts":false},{"version":"v22.18.0","lts":"Jod"},{"version":"v22.17.1","lts":"Jod"},{"version":"v23.0.0-rc.1"}]"#;
        assert_eq!(parse_node_index(index, "22.17.0").as_deref(), Some("22.18.0"), "Node stays on its line");
        assert_eq!(parse_node_index(index, "20.1.0"), None);
        assert_eq!(parse_pypi_latest(r#"{"info":{"version":"0.9.2"}}"#).as_deref(), Some("0.9.2"));
    }

    fn found(tool: &str, version: &str, owner: Option<ToolOwner>) -> ToolFound {
        ToolFound::for_test(tool, "/x", Some(version), owner)
    }

    #[test]
    fn answers_become_each_tools_newest_and_say_which_installer_failed() {
        let tools = vec![
            found("uv", "0.8.3", Some(ToolOwner::named(OwnerKind::Brew, "uv"))),
            found("gh", "2.74.0", Some(ToolOwner::named(OwnerKind::Brew, "gh"))),
            found("pnpm", "9.0.0", Some(ToolOwner { kind: OwnerKind::Npm, name: Some("pnpm".into()), prefix: Some("/p".into()) })),
            found("rust", "1.88.0", Some(ToolOwner::new(OwnerKind::Rustup))),
            found("go", "1.24.0", Some(ToolOwner::named(OwnerKind::Mise, "go"))),
            found("git", "2.43.0", Some(ToolOwner::named(OwnerKind::System, "apt-get"))),
        ];
        let answer = |kind: &str, key: &str, status: &str, body: &str, last: &str| format!("S\t{kind}\t{key}\t{status}\t{}\t{last}", STANDARD.encode(body));
        let stdout = [
            answer("brew", "-", "0", r#"{"formulae":[{"name":"uv","current_version":"0.9.1"}]}"#, ""),
            answer("npm", "/p", "1", r#"{"pnpm":{"latest":"10.2.0"}}"#, ""),
            answer("rustup", "-", "0", "stable-x86_64-unknown-linux-gnu - Update available : 1.88.0 (a) -> 1.89.0 (b)\n", ""),
            answer("mise", "-", "127", "", "sh: mise: not found"),
        ]
        .join("\n");
        let answers = parse_answers(&stdout);
        let (latest, problems) = latest_from_answers(&tools, &answers);
        let pairs: Vec<(&str, &str)> = latest.iter().map(|entry| (entry.tool.as_str(), entry.version.as_str())).collect();
        assert_eq!(pairs, vec![("uv", "0.9.1"), ("gh", "2.74.0"), ("pnpm", "10.2.0"), ("rust", "1.89.0")]);
        assert_eq!(problems, vec!["mise: sh: mise: not found".to_string()]);
    }

    #[test]
    fn checks_run_only_for_the_installers_a_machine_has() {
        let tools = vec![
            found("uv", "0.8.3", Some(ToolOwner::named(OwnerKind::Brew, "uv"))),
            found("gh", "2.74.0", Some(ToolOwner::named(OwnerKind::Brew, "gh"))),
            found("pnpm", "9.0.0", Some(ToolOwner { kind: OwnerKind::Npm, name: Some("pnpm".into()), prefix: Some("/p q".into()) })),
            found("bun", "1.3.0", Some(ToolOwner::new(OwnerKind::Bun))),
        ];
        assert_eq!(checks_for(&tools, None, false), vec![Check::Brew, Check::Npm("/p q".into())]);
        assert_eq!(checks_for(&tools, None, true), vec![Check::BrewUpdate, Check::Brew, Check::Npm("/p q".into())]);
        let script = check_script(&checks_for(&tools, None, false));
        assert!(script.contains("check npm '/p q' 120 \"$npm_at\" outdated -g --json --prefix '/p q'"), "{script}");
        assert!(!script.contains("brew update"));
    }

    #[cfg(unix)]
    #[test]
    fn the_check_script_asks_each_installer_and_reports_each_answer() {
        for shell in shells() {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let home = std::env::temp_dir().join(format!("arbor-tool-check-{shell}-{}-{stamp}", std::process::id()));
            let bin = home.join(".local/bin");
            fs::create_dir_all(&bin).unwrap();
            let fake = |name: &str, body: &str| {
                let path = bin.join(name);
                fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
                fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
            };
            // Each reads stdin to show it gets nothing, and says what it was asked.
            fake("brew", "cat >/dev/null; echo \"brew $*\" >> \"$HOME/ran\"; echo '{\"formulae\":[{\"name\":\"uv\",\"current_version\":\"0.9.1\"}]}'");
            fake("mise", "echo 'mise ERROR boom' >&2; exit 2");
            let checks = vec![Check::BrewUpdate, Check::Brew, Check::Mise];
            let mut command = tokio::process::Command::new(shell);
            command.env_clear().env("HOME", &home).env("PATH", "/usr/bin:/bin").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
            let output = tokio::runtime::Runtime::new().unwrap().block_on(run_script(command, &check_script(&checks), Duration::from_secs(60))).unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            let answers = parse_answers(&stdout);
            assert_eq!(answers.iter().map(|answer| (answer.kind.as_str(), answer.ok)).collect::<Vec<_>>(), vec![("brew-update", true), ("brew", true), ("mise", false)], "{shell}: {stdout}");
            assert_eq!(parse_brew_outdated(&answers[1].body).and_then(|outdated| outdated.get("uv").cloned()).as_deref(), Some("0.9.1"));
            assert_eq!(answers[2].last, "mise ERROR boom");
            assert_eq!(fs::read_to_string(home.join("ran")).unwrap(), "brew update --quiet\nbrew outdated --json=v2 --formula\n", "{shell}");
            fs::remove_dir_all(&home).ok();
        }
    }

    fn change(tool: &str, action: ToolAction, version: Option<&str>) -> ToolChange {
        ToolChange { tool: tool.into(), action, version: version.map(str::to_string), via: None }
    }

    fn machine_with(tools: Vec<ToolFound>, facts: OwnerFacts) -> MachineToolchain {
        MachineToolchain::for_test("cedar", tools, facts)
    }

    #[test]
    fn a_scan_asks_the_installers_again_only_once_their_answer_is_old() {
        let mut scan = machine_with(vec![], facts());
        assert!(check_due(&scan, 1_000), "never asked");
        scan.set_updates(ToolUpdates { checked_at: 1_000, ..ToolUpdates::default() });
        assert!(!check_due(&scan, 1_000 + CHECK_FRESH_MS));
        assert!(check_due(&scan, 1_001 + CHECK_FRESH_MS));
        scan.set_checking(true);
        assert!(!check_due(&scan, i64::MAX), "not while it's asking");
    }

    #[test]
    fn tool_changes_are_checked_against_the_last_scan() {
        let scan = machine_with(
            vec![
                found("uv", "0.8.3", Some(ToolOwner::named(OwnerKind::Brew, "uv"))),
                found("git", "2.43.0", Some(ToolOwner::named(OwnerKind::System, "apt-get"))),
                found("jq", "1.7.1", None),
                found("bun", "1.3.0", Some(ToolOwner::new(OwnerKind::Bun))),
                found("node", "22.17.0", Some(ToolOwner::new(OwnerKind::Nvm))),
                found("npm", "10.9.2", Some(ToolOwner { kind: OwnerKind::Npm, name: Some("npm".into()), prefix: Some("/n".into()) })),
                found("go", "1.24.0", Some(ToolOwner::named(OwnerKind::Mise, "go"))),
            ],
            facts(),
        );
        let planned = plan_tool_changes(&scan, &[change("uv", ToolAction::Update, None), change("go", ToolAction::Update, Some("1.25.1")), change("node", ToolAction::Update, Some("22.18.0"))]).unwrap();
        let commands: Vec<&str> = planned.iter().map(|plan| plan.command.as_str()).collect();
        assert_eq!(commands[0], "/opt/homebrew/bin/brew upgrade --formula uv");
        assert_eq!(commands[1], "/Users/a/.local/bin/mise use -g go@1.25.1");
        assert!(commands[2].contains("nvm install '22.18.0'") && commands[2].contains("nvm alias default '22.18.0'"), "{}", commands[2]);
        assert_eq!(planned[0].what, "uv 0.8.3 (Homebrew)");
        let refused = |changes: &[ToolChange]| plan_tool_changes(&scan, changes).unwrap_err();
        assert!(refused(&[change("git", ToolAction::Update, None)]).contains("sudo"));
        assert!(refused(&[change("jq", ToolAction::Update, None)]).contains("agent"));
        assert!(refused(&[change("deno", ToolAction::Update, None)]).contains("Scan again"));
        assert!(refused(&[change("bun", ToolAction::Remove, None)]).contains("agent"));
        assert!(refused(&[change("bun", ToolAction::Update, Some("1.3.1"))]).contains("newest"));
        assert!(refused(&[change("uv", ToolAction::Update, Some("1; rm -rf ~"))]).contains("isn't a version"));
        assert!(refused(&[change("node", ToolAction::Update, None)]).contains("which Node version"));
        assert!(refused(&[change("npm", ToolAction::Remove, None)]).contains("came with its Node"));
        assert!(refused(&[change("uv", ToolAction::Update, None), change("uv", ToolAction::Remove, None)]).contains("twice"));
        assert!(refused(&[]).contains("nothing"));
    }

    #[test]
    fn the_repo_says_what_to_install_update_and_remove_and_with_which_installer() {
        use super::super::setup_tools::RepoTool;
        let mut scan = machine_with(
            vec![
                found("node", "24.1.0", Some(ToolOwner::new(OwnerKind::Nvm))),
                found("uv", "0.8.3", Some(ToolOwner::named(OwnerKind::Brew, "uv"))),
                found("deno", "2.4.0", Some(ToolOwner::new(OwnerKind::Deno))),
                found("pnpm", "10.1.0", None),
            ],
            facts(),
        );
        scan.set_updates(ToolUpdates { latest: vec![ToolLatest { tool: "uv".into(), version: "0.9.1".into() }], ..ToolUpdates::default() });
        let tools = RepoTools::for_test(vec![
            RepoTool::for_test("node", "22", &[]),
            RepoTool::for_test("uv", "latest", &[]),
            RepoTool::for_test("deno", "removed", &[]),
            RepoTool::for_test("go", "latest", &[]),
            RepoTool::for_test("jq", "1.7", &[]),
            RepoTool::for_test("rg", "latest", &[("cedar", "own")]),
            RepoTool::for_test("docker", "latest", &[]),
            RepoTool::for_test("pnpm", "10", &[]),
        ]);
        let changes = repo_changes(&scan, &tools, None);
        let summary: Vec<(&str, ToolAction, Option<&str>, Option<OwnerKind>)> =
            changes.iter().map(|change| (change.tool.as_str(), change.action, change.version.as_deref(), change.via)).collect();
        // Linux tries mise first; Homebrew can't give jq at 1.7, and nothing Arbor uses gives Docker.
        assert_eq!(summary, [
            ("node", ToolAction::Update, Some("22"), None),
            ("uv", ToolAction::Update, None, None),
            ("deno", ToolAction::Remove, None, None),
            ("go", ToolAction::Install, None, Some(OwnerKind::Mise)),
            ("jq", ToolAction::Install, Some("1.7"), Some(OwnerKind::Mise)),
            ("docker", ToolAction::Install, None, None),
        ]);
        let plans: Vec<Result<String, String>> = changes.iter().map(|change| plan_one(&scan, change).map(|plan| plan.command)).collect();
        assert!(plans[0].as_ref().unwrap().contains("nvm install '22'"));
        assert_eq!(plans[1].as_deref(), Ok("/opt/homebrew/bin/brew upgrade --formula uv"));
        assert!(plans[2].as_ref().unwrap_err().contains("agent"));
        assert_eq!(plans[3].as_deref(), Ok("/Users/a/.local/bin/mise use -g go@latest"));
        assert_eq!(plans[4].as_deref(), Ok("/Users/a/.local/bin/mise use -g jq@1.7"));
        assert!(plans[5].as_ref().unwrap_err().contains("No installer"));
        // A Mac tries Homebrew first, and a pin skips it for the next.
        let mac = RepoTools::for_test(vec![RepoTool::for_test("go", "latest", &[]), RepoTool::for_test("node", "20", &[])]);
        let order = mac.installers_for("Darwin");
        assert_eq!(installer_for(&scan, order, "go", None), Some(OwnerKind::Brew));
        assert_eq!(installer_for(&scan, order, "node", Some("20")), Some(OwnerKind::Mise));
        assert_eq!(installer_for(&scan, order, "cargo", None), None, "cargo comes with Rust");
        assert!(plan_one(&scan, &ToolChange { tool: "uv".into(), action: ToolAction::Install, version: None, via: Some(OwnerKind::Brew) }).unwrap_err().contains("already"));
    }

    #[cfg(unix)]
    #[test]
    fn tool_changes_run_each_on_its_own_and_go_in_history() {
        for shell in shells() {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let home = std::env::temp_dir().join(format!("arbor-tool-change-{shell}-{}-{stamp}", std::process::id()));
            let fake = |path: &std::path::Path, body: &str| {
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
                fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
            };
            let brew = home.join("brew");
            let prefix = home.join("node");
            fake(&brew.join("bin/brew"), "cat >/dev/null; echo \"brew $*\" >> \"$HOME/ran\"");
            fake(&home.join(".local/bin/mise"), "echo \"mise $*\" >> \"$HOME/ran\"; echo 'mise ERROR no such version' >&2; exit 1");
            fake(&prefix.join("bin/npm"), "echo \"npm $*\" >> \"$HOME/ran\"");
            let facts = OwnerFacts {
                brew_prefix: Some(brew.display().to_string()),
                mise: Some(home.join(".local/bin/mise").display().to_string()),
                ..OwnerFacts::default()
            };
            let scan = machine_with(
                vec![
                    found("uv", "0.8.3", Some(ToolOwner::named(OwnerKind::Brew, "uv"))),
                    found("go", "1.24.0", Some(ToolOwner::named(OwnerKind::Mise, "go"))),
                    found("pnpm", "9.0.0", Some(ToolOwner { kind: OwnerKind::Npm, name: Some("pnpm".into()), prefix: Some(prefix.display().to_string()) })),
                ],
                facts,
            );
            let changes = [change("uv", ToolAction::Update, None), change("go", ToolAction::Update, Some("1.25.1")), change("pnpm", ToolAction::Remove, None)];
            let planned = plan_tool_changes(&scan, &changes).unwrap();
            let mut command = tokio::process::Command::new(shell);
            command.env_clear().env("HOME", &home).env("PATH", "/usr/bin:/bin").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
            let script = change_script(&planned, "20261008T120000Z-abcd");
            let output = tokio::runtime::Runtime::new().unwrap().block_on(run_script(command, &script, Duration::from_secs(60))).unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            let results = parse_tool_results(&stdout, &changes);
            assert_eq!(results.iter().map(|result| result.ok).collect::<Vec<_>>(), [true, false, true], "{shell}: {stdout}");
            assert_eq!(results[1].message.as_deref(), Some("mise ERROR no such version"));
            let ran = fs::read_to_string(home.join("ran")).unwrap();
            assert_eq!(ran, format!("brew upgrade --formula uv\nmise use -g go@1.25.1\nnpm uninstall -g --prefix {} pnpm\n", prefix.display()), "{shell}");
            assert!(stdout.contains("K\t20261008T120000Z-abcd"), "{shell}: {stdout}");
            let manifest = fs::read_to_string(home.join(".arbor/setup-backups/20261008T120000Z-abcd/manifest")).unwrap();
            assert_eq!(manifest, "what\ttools\nT\tuv 0.8.3 (Homebrew)\tchanged\nT\tpnpm 9.0.0 (npm)\tremoved\n", "{shell}: only what worked is listed");
            let listed = super::super::setup_sync::parse_backups(&format!("H\t{}\nV\t20261008T120000Z-abcd\t-\n{manifest}", home.display()));
            let listed = serde_json::to_value(&listed).unwrap();
            assert_eq!(listed[0]["what"], "tools");
            assert_eq!(listed[0]["files"][1], serde_json::json!({ "path": "pnpm 9.0.0 (npm)", "change": "removed", "skill": false }));
            fs::remove_dir_all(&home).ok();
        }
    }
}

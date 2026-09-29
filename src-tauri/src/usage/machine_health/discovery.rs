//! Machines this Mac already knows how to reach, offered when a machine is added:
//! the `Host` entries in ~/.ssh/config (and the files it includes), the hosts in
//! ~/.ssh/known_hosts, and the peers on its tailnet.
//!
//! Only names, addresses, users and ports are read. `IdentityFile` and every other
//! setting are passed over without keeping their values, and nothing is opened
//! under ~/.ssh but `config`, `known_hosts` and the files `config` includes, so
//! no key is ever read. Hashed known_hosts entries can't be read back, and are
//! skipped. Tailscale's status comes from the sampler's cached read, so offering
//! peers never adds a read of its own within the minute.
//!
//! The ssh_config reading follows OpenSSH's: the first value found for a setting
//! wins, a `Host` block applies when one of its patterns matches the alias and
//! none of its negated ones do, and an `Include` inside a block only applies
//! when that block does. Adapted in part from T3 Code's `packages/ssh/src/config.ts`.

use super::*;
use ts_rs::TS;
use std::net::IpAddr;

/// OpenSSH's own limit on nested includes; also what stops an include cycle.
const INCLUDE_DEPTH_MAX: usize = 16;
/// Bigger than any real ssh_config or known_hosts; anything larger isn't read.
const FILE_BYTES_MAX: u64 = 4 * 1024 * 1024;
/// More than anyone picks from; keeps a huge known_hosts from flooding the dialog.
const SUGGESTIONS_MAX: usize = 200;

/// Git hosts that people keep keys and config for, which are never machines to watch.
const GIT_HOSTS: &[&str] = &[
    "github.com",
    "gitlab.com",
    "bitbucket.org",
    "codeberg.org",
    "git.sr.ht",
    "ssh.dev.azure.com",
    "vs-ssh.visualstudio.com",
    "source.developers.google.com",
    "heroku.com",
];

/// Tailscale's names for devices no one signs in to over SSH.
const NO_SSH_OS: &[&str] = &["ios", "android", "tvos"];

/// Where the ssh files are read from: the disk, or samples in tests.
pub(super) trait SshFiles {
    fn read(&self, path: &Path) -> Option<String>;
    /// The names in a folder, for an `Include` with a wildcard.
    fn list(&self, dir: &Path) -> Vec<String>;
}

struct DiskFiles;

impl SshFiles for DiskFiles {
    fn read(&self, path: &Path) -> Option<String> {
        let metadata = fs::metadata(path).ok()?;
        if !metadata.is_file() || metadata.len() > FILE_BYTES_MAX {
            return None;
        }
        fs::read_to_string(path).ok()
    }

    fn list(&self, dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// When a setting applies: under a `Host` line's patterns, or never (a `Match`,
/// whose criteria Arbor doesn't evaluate).
#[derive(Clone, Debug, PartialEq)]
enum Condition {
    Hosts(Vec<String>),
    Never,
}

impl Condition {
    fn matches(&self, alias: &str) -> bool {
        match self {
            Self::Hosts(patterns) => host_matches(patterns, alias),
            Self::Never => false,
        }
    }
}

#[derive(Clone, Debug)]
struct Setting {
    /// Every block it sits in, the including file's first.
    conditions: Vec<Condition>,
    /// `hostname`, `user` or `port`; nothing else is kept.
    key: &'static str,
    value: String,
}

#[derive(Debug, Default)]
pub(super) struct SshConfig {
    /// The concrete names on `Host` lines, in the order they first appear.
    aliases: Vec<String>,
    settings: Vec<Setting>,
}

/// What an alias resolves to.
#[derive(Clone, Debug, Default, PartialEq)]
struct Resolved {
    host_name: Option<String>,
    user: Option<String>,
    port: Option<u16>,
}

impl SshConfig {
    fn resolve(&self, alias: &str) -> Resolved {
        let lowered = alias.to_ascii_lowercase();
        let mut resolved = Resolved::default();
        for setting in &self.settings {
            if !setting.conditions.iter().all(|condition| condition.matches(&lowered)) {
                continue;
            }
            match setting.key {
                "hostname" if resolved.host_name.is_none() => {
                    resolved.host_name = Some(setting.value.replace("%h", alias).replace("%%", "%"));
                }
                "user" if resolved.user.is_none() => resolved.user = Some(setting.value.clone()),
                "port" if resolved.port.is_none() => {
                    resolved.port = Some(setting.value.parse::<u16>().ok().filter(|port| *port > 0).unwrap_or(22));
                }
                _ => {}
            }
        }
        resolved
    }
}

/// A config line split into its keyword and arguments. Keywords are separated
/// from their arguments by spaces or one `=`; arguments may be double-quoted;
/// a `#` starting an argument starts a comment.
fn config_line(line: &str) -> Option<(String, Vec<String>)> {
    let line = line.trim_start();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(line.len());
    let keyword = line[..end].to_ascii_lowercase();
    let mut rest = line[end..].trim_start();
    if let Some(stripped) = rest.strip_prefix('=') {
        rest = stripped.trim_start();
    }
    let mut args = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut quoted = false;
    for c in rest.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            c if c.is_whitespace() && !quoted => {
                if started {
                    args.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            '#' if !quoted && !started => break,
            c => {
                current.push(c);
                started = true;
            }
        }
    }
    if started {
        args.push(current);
    }
    Some((keyword, args))
}

fn has_wildcard(pattern: &str) -> bool {
    pattern.contains('*') || pattern.contains('?') || pattern.starts_with('!')
}

/// OpenSSH's pattern match: `*` for any run of characters, `?` for any one.
fn glob(pattern: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some((p, t));
            p += 1;
        } else if let Some((star_p, star_t)) = star {
            p = star_p + 1;
            t = star_t + 1;
            star = Some((star_p, star_t + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|&c| c == b'*')
}

/// Whether a `Host` line's patterns take in an alias: one matches, and no negated one does.
fn host_matches(patterns: &[String], alias: &str) -> bool {
    let mut matched = false;
    for pattern in patterns {
        let pattern = pattern.to_ascii_lowercase();
        if let Some(negated) = pattern.strip_prefix('!') {
            if glob(negated.as_bytes(), alias.as_bytes()) {
                return false;
            }
        } else if glob(pattern.as_bytes(), alias.as_bytes()) {
            matched = true;
        }
    }
    matched
}

fn expand_home(path: &str, home: &Path) -> PathBuf {
    match path.strip_prefix('~') {
        Some("") => home.to_path_buf(),
        Some(rest) if rest.starts_with('/') => home.join(rest.trim_start_matches('/')),
        _ => PathBuf::from(path),
    }
}

/// The files an `Include` names. Relative paths are in ~/.ssh, as for the user's
/// own config; a wildcard is allowed in the file name, and matches are read in order.
fn include_paths(files: &impl SshFiles, pattern: &str, home: &Path) -> Vec<PathBuf> {
    let expanded = expand_home(pattern, home);
    let path = if expanded.is_absolute() { expanded } else { home.join(".ssh").join(expanded) };
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if !name.contains('*') && !name.contains('?') {
        return vec![path];
    }
    let Some(dir) = path.parent() else {
        return Vec::new();
    };
    let mut names: Vec<String> = files
        .list(dir)
        .into_iter()
        .filter(|entry| !entry.starts_with('.') && glob(name.as_bytes(), entry.as_bytes()))
        .collect();
    names.sort();
    names.into_iter().map(|entry| dir.join(entry)).collect()
}

fn read_config_file(
    files: &impl SshFiles,
    home: &Path,
    path: &Path,
    outer: &[Condition],
    chain: &mut Vec<PathBuf>,
    config: &mut SshConfig,
) {
    if chain.len() >= INCLUDE_DEPTH_MAX || chain.iter().any(|seen| seen == path) {
        return;
    }
    let Some(text) = files.read(path) else {
        return;
    };
    chain.push(path.to_path_buf());
    // Until its first `Host` or `Match`, an included file is under the block it was included from.
    let mut block: Option<Condition> = None;
    for line in text.lines() {
        let Some((keyword, args)) = config_line(line) else {
            continue;
        };
        let conditions = || outer.iter().cloned().chain(block.clone()).collect::<Vec<_>>();
        match keyword.as_str() {
            "host" => {
                for alias in args.iter().filter(|alias| !alias.is_empty() && !has_wildcard(alias)) {
                    if !config.aliases.iter().any(|seen| seen.eq_ignore_ascii_case(alias)) {
                        config.aliases.push(alias.clone());
                    }
                }
                block = Some(Condition::Hosts(args));
            }
            "match" => {
                let all = args.len() == 1 && args[0].eq_ignore_ascii_case("all");
                block = Some(if all { Condition::Hosts(vec!["*".into()]) } else { Condition::Never });
            }
            "include" => {
                let conditions = conditions();
                for pattern in &args {
                    for included in include_paths(files, pattern, home) {
                        read_config_file(files, home, &included, &conditions, chain, config);
                    }
                }
            }
            "hostname" | "user" | "port" => {
                let key = match keyword.as_str() {
                    "hostname" => "hostname",
                    "user" => "user",
                    _ => "port",
                };
                if let Some(value) = args.into_iter().next() {
                    config.settings.push(Setting { conditions: conditions(), key, value });
                }
            }
            // IdentityFile, ProxyCommand and the rest aren't kept.
            _ => {}
        }
    }
    chain.pop();
}

pub(super) fn read_ssh_config(files: &impl SshFiles, home: &Path) -> SshConfig {
    let mut config = SshConfig::default();
    read_config_file(files, home, &home.join(".ssh").join("config"), &[], &mut Vec::new(), &mut config);
    config
}

/// One known_hosts line's names, and the port they were reached on.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct KnownHost {
    names: Vec<String>,
    port: u16,
}

/// The hosts in a known_hosts file. Hashed entries (`|1|…`) can't be read back and
/// are skipped, as are wildcard patterns and `@revoked` and `@cert-authority` lines,
/// which are about keys rather than machines.
pub(super) fn parse_known_hosts(text: &str) -> Vec<KnownHost> {
    let mut hosts = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('@') {
            continue;
        }
        let field = line.split_whitespace().next().unwrap_or("");
        if field.starts_with('|') {
            continue;
        }
        let mut port = None;
        let mut names = Vec::new();
        for entry in field.split(',') {
            let (name, entry_port) = match entry.strip_prefix('[').and_then(|rest| rest.split_once("]:")) {
                Some((name, digits)) => (name, digits.parse::<u16>().ok().filter(|port| *port > 0)),
                None => (entry, Some(22)),
            };
            let Some(entry_port) = entry_port else {
                continue;
            };
            if name.is_empty() || has_wildcard(name) || port.is_some_and(|port| port != entry_port) {
                continue;
            }
            port = Some(entry_port);
            let name = name.to_ascii_lowercase();
            if !names.contains(&name) {
                names.push(name);
            }
        }
        if let Some(port) = port {
            hosts.push(KnownHost { names, port });
        }
    }
    hosts
}

/// A peer on this Mac's tailnet.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TailscalePeer {
    host_name: String,
    /// Its MagicDNS name, without the trailing dot; empty when it has none.
    dns_name: String,
    addresses: Vec<IpAddr>,
    os: String,
    online: bool,
}

/// The peers in `tailscale status --json`, apart from phones and TVs and Mullvad's exit nodes.
/// This Mac itself is `Self`, not a peer. Only these fields are read.
pub(crate) fn peers_from_status(status: &Value) -> Vec<TailscalePeer> {
    let peers = status.get("Peer").and_then(Value::as_object).into_iter().flat_map(|peers| peers.values());
    let mut found: Vec<TailscalePeer> = peers
        .filter_map(|peer| {
            let text = |key: &str| peer.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string();
            let os = text("OS");
            let dns_name = text("DNSName").trim_end_matches('.').to_ascii_lowercase();
            if NO_SSH_OS.contains(&os.to_ascii_lowercase().as_str()) || dns_name.ends_with(".mullvad.ts.net") {
                return None;
            }
            let addresses: Vec<IpAddr> = peer
                .get("TailscaleIPs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(|address| address.parse().ok())
                .collect();
            if dns_name.is_empty() && addresses.is_empty() {
                return None;
            }
            Some(TailscalePeer {
                host_name: text("HostName"),
                dns_name,
                addresses,
                os,
                online: peer.get("Online").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect();
    found.sort_by(|a, b| a.dns_name.cmp(&b.dns_name));
    found
}

/// Where a machine was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DiscoverySource {
    SshConfig,
    KnownHosts,
    Tailscale,
}

/// A machine to offer in the Add machine dialog.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveredHost {
    /// What to call it: the ssh_config alias, the peer's tailnet name, or the first part of a
    /// known host's name. Empty when it's only known by its address.
    name: String,
    /// What goes in the SSH host field. An ssh_config alias stays the alias, so ssh applies the
    /// rest of its settings.
    endpoint: String,
    port: u16,
    /// Where the alias leads, when ssh_config says.
    host_name: Option<String>,
    user: Option<String>,
    /// Every name and address it's known by, lowercased, to match against machines already added.
    addresses: Vec<String>,
    /// Where it was found.
    sources: Vec<DiscoverySource>,
    /// The OS Tailscale reports for it.
    os: Option<String>,
    /// Whether it's online on the tailnet.
    online: Option<bool>,
}

impl DiscoveredHost {
    fn knows_any(&self, names: &[String]) -> bool {
        names.iter().any(|name| self.addresses.contains(name))
    }

    fn add(&mut self, source: DiscoverySource, names: &[String]) {
        if !self.sources.contains(&source) {
            self.sources.push(source);
        }
        for name in names {
            if !self.addresses.contains(name) {
                self.addresses.push(name.clone());
            }
        }
    }
}

fn is_git_host(name: &str) -> bool {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    GIT_HOSTS.iter().any(|host| name == *host || name.ends_with(&format!(".{host}")))
}

fn is_loopback(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == "localhost" || name.ends_with(".localhost") || name.parse::<IpAddr>().is_ok_and(|address| address.is_loopback())
}

/// A short name for a host: the first label of a DNS name, nothing for an address.
fn short_name(name: &str) -> String {
    if name.parse::<IpAddr>().is_ok() {
        return String::new();
    }
    name.split('.').next().unwrap_or(name).to_string()
}

pub(super) fn discovered_hosts(config: &SshConfig, known: &[KnownHost], peers: &[TailscalePeer]) -> Vec<DiscoveredHost> {
    let mut found: Vec<DiscoveredHost> = Vec::new();
    for alias in &config.aliases {
        let resolved = config.resolve(alias);
        let target = resolved.host_name.clone().unwrap_or_else(|| alias.clone());
        let user_is_git = resolved.user.as_deref() == Some("git");
        if user_is_git || is_git_host(alias) || is_git_host(&target) || is_loopback(&target) {
            continue;
        }
        let mut addresses = vec![alias.to_ascii_lowercase()];
        let host_name = resolved.host_name.filter(|name| !name.eq_ignore_ascii_case(alias));
        if let Some(name) = &host_name {
            addresses.push(name.trim_end_matches('.').to_ascii_lowercase());
        }
        found.push(DiscoveredHost {
            name: alias.clone(),
            endpoint: alias.clone(),
            port: resolved.port.unwrap_or(22),
            host_name,
            user: resolved.user,
            addresses,
            sources: vec![DiscoverySource::SshConfig],
            os: None,
            online: None,
        });
    }
    for peer in peers {
        let short = short_name(&peer.dns_name);
        let mut names: Vec<String> = [peer.dns_name.clone(), short.clone(), peer.host_name.to_ascii_lowercase()]
            .into_iter()
            .filter(|name| !name.is_empty())
            .collect();
        names.extend(peer.addresses.iter().map(IpAddr::to_string));
        names.dedup();
        if let Some(existing) = found.iter_mut().find(|host| host.knows_any(&names)) {
            existing.add(DiscoverySource::Tailscale, &names);
            existing.os = Some(peer.os.clone()).filter(|os| !os.is_empty());
            existing.online = Some(peer.online);
            continue;
        }
        let endpoint = if peer.dns_name.is_empty() {
            let address = peer.addresses.iter().find(|address| address.is_ipv4()).or(peer.addresses.first());
            address.map(IpAddr::to_string).unwrap_or_default()
        } else {
            peer.dns_name.clone()
        };
        let name = if short.is_empty() { peer.host_name.clone() } else { short };
        found.push(DiscoveredHost {
            name,
            endpoint,
            port: 22,
            host_name: None,
            user: None,
            addresses: names,
            sources: vec![DiscoverySource::Tailscale],
            os: Some(peer.os.clone()).filter(|os| !os.is_empty()),
            online: Some(peer.online),
        });
    }
    for entry in known {
        let Some(first) = entry.names.first() else {
            continue;
        };
        if entry.names.iter().any(|name| is_git_host(name) || is_loopback(name)) {
            continue;
        }
        if let Some(existing) = found.iter_mut().find(|host| host.knows_any(&entry.names)) {
            existing.add(DiscoverySource::KnownHosts, &entry.names);
            continue;
        }
        let name = entry.names.iter().map(|name| short_name(name)).find(|name| !name.is_empty()).unwrap_or_default();
        let endpoint = entry.names.iter().find(|name| name.parse::<IpAddr>().is_err()).unwrap_or(first).clone();
        found.push(DiscoveredHost {
            name,
            endpoint,
            port: entry.port,
            host_name: None,
            user: None,
            addresses: entry.names.clone(),
            sources: vec![DiscoverySource::KnownHosts],
            os: None,
            online: None,
        });
    }
    // Named ones first, alphabetically; ones known only by their address after.
    found.sort_by(|a, b| {
        (a.name.is_empty(), a.name.to_ascii_lowercase(), &a.endpoint).cmp(&(b.name.is_empty(), b.name.to_ascii_lowercase(), &b.endpoint))
    });
    found.truncate(SUGGESTIONS_MAX);
    found
}

/// Suggestions for the Add machine dialog. Reads this Mac's ~/.ssh/config and
/// known_hosts, and the peers from Tailscale's cached status.
#[tauri::command]
pub(crate) async fn discover_machine_hosts(state: tauri::State<'_, MachineHealthState>) -> Result<Vec<DiscoveredHost>, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Arbor couldn't find your home folder".to_string())?;
    let (config, known) = tokio::task::spawn_blocking(move || {
        let files = DiskFiles;
        let known = files
            .read(&home.join(".ssh").join("known_hosts"))
            .map(|text| parse_known_hosts(&text))
            .unwrap_or_default();
        (read_ssh_config(&files, &home), known)
    })
    .await
    .map_err(|error| format!("Arbor couldn't read ~/.ssh: {error}"))?;
    let peers = state.tailscale_status().await.map(|status| status.peers).unwrap_or_default();
    Ok(discovered_hosts(&config, &known, &peers))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Sample files, and every path that was asked for.
    struct Samples {
        files: HashMap<PathBuf, String>,
        asked: RefCell<Vec<PathBuf>>,
    }

    impl Samples {
        fn new(files: &[(&str, &str)]) -> Self {
            Self {
                files: files.iter().map(|(path, text)| (PathBuf::from(path), (*text).to_string())).collect(),
                asked: RefCell::new(Vec::new()),
            }
        }
    }

    impl SshFiles for Samples {
        fn read(&self, path: &Path) -> Option<String> {
            self.asked.borrow_mut().push(path.to_path_buf());
            self.files.get(path).cloned()
        }

        fn list(&self, dir: &Path) -> Vec<String> {
            self.files
                .keys()
                .filter(|path| path.parent() == Some(dir))
                .filter_map(|path| path.file_name()?.to_str().map(str::to_string))
                .collect()
        }
    }

    const HOME: &str = "/Users/casey";

    const CONFIG: &str = r#"# Everything first-match-wins, as ssh reads it.
Include config.d/*
Include ~/.orbstack/ssh/config

Host cedar-01 cedar-02
    HostName %h.tailc0ffee.ts.net
    User casey
    IdentityFile ~/.ssh/id_ed25519_cedar

Host build-arm
    HostName=10.0.4.21
    User ubuntu
    Port 2200
    IdentityFile "~/.ssh/keys/build arm"

Host github.com github-work
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_work

Host gitlab
    HostName gitlab.com

Host *.internal !secret.internal
    User ops

Host bastion # the way in
    Port 2222
    Include bastion.conf

Match host nas exec "true"
    User nobody

Host nas
    HostName nas.local

Host *
    User fallback
    Port 22
    ServerAliveInterval 30
"#;

    fn samples() -> Samples {
        Samples::new(&[
            ("/Users/casey/.ssh/config", CONFIG),
            ("/Users/casey/.ssh/config.d/10-lab", "Host lab-box\n  HostName lab-box.local\n  Port 2222\n"),
            ("/Users/casey/.ssh/config.d/20-loop", "Include config\nHost loopback\n  HostName 127.0.0.1\n"),
            ("/Users/casey/.ssh/config.d/.hidden", "Host hidden\n"),
            ("/Users/casey/.orbstack/ssh/config", "Host orb\n  HostName localhost\n  Port 32222\n"),
            ("/Users/casey/.ssh/bastion.conf", "User jump\nHost behind-bastion\n  User inner\n"),
        ])
    }

    #[test]
    fn ssh_config_lists_concrete_hosts_through_includes() {
        let files = samples();
        let config = read_ssh_config(&files, Path::new(HOME));
        assert_eq!(
            config.aliases,
            ["lab-box", "loopback", "orb", "cedar-01", "cedar-02", "build-arm", "github.com", "github-work", "gitlab", "bastion", "behind-bastion", "nas"],
            "wildcards, negations and dot-files in an included folder aren't hosts",
        );
        // Only config files were opened: never a key, whatever IdentityFile names.
        let asked: Vec<String> = files.asked.borrow().iter().map(|path| path.display().to_string()).collect();
        assert!(asked.iter().all(|path| !path.contains("id_") && !path.contains("keys")), "{asked:?}");
        assert_eq!(asked.iter().filter(|path| path.ends_with("/.ssh/config")).count(), 1, "an include cycle is read once");
    }

    #[test]
    fn ssh_config_settings_resolve_first_match_wins() {
        let config = read_ssh_config(&samples(), Path::new(HOME));
        let resolved = |alias: &str| config.resolve(alias);
        assert_eq!(
            resolved("cedar-02"),
            Resolved { host_name: Some("cedar-02.tailc0ffee.ts.net".into()), user: Some("casey".into()), port: Some(22) },
            "%h is the alias, and Host * fills in what's left",
        );
        assert_eq!(resolved("build-arm"), Resolved { host_name: Some("10.0.4.21".into()), user: Some("ubuntu".into()), port: Some(2200) });
        assert_eq!(resolved("lab-box").port, Some(2222), "included files are read where they're included");
        assert_eq!(resolved("web.internal").user.as_deref(), Some("ops"));
        assert_eq!(resolved("secret.internal").user.as_deref(), Some("fallback"), "a negated pattern keeps the block out");
        assert_eq!(resolved("nas").user.as_deref(), Some("fallback"), "a Match block isn't guessed at");
        assert_eq!(resolved("bastion").user.as_deref(), Some("jump"), "an include in a block applies with it");
        assert_eq!(resolved("bastion").port, Some(2222));
        assert_eq!(resolved("behind-bastion").user.as_deref(), Some("fallback"), "a block included under another needs both to match");
        assert_eq!(resolved("CEDAR-01").user.as_deref(), Some("casey"), "hosts match without regard to case");
    }

    #[test]
    fn config_lines_split_like_ssh_splits_them() {
        assert_eq!(config_line("  HostName=cedar.local"), Some(("hostname".into(), vec!["cedar.local".into()])));
        assert_eq!(config_line("Port = 2222"), Some(("port".into(), vec!["2222".into()])));
        assert_eq!(config_line("Host a b # comment"), Some(("host".into(), vec!["a".into(), "b".into()])));
        assert_eq!(config_line(r#"IdentityFile "~/my keys/id""#), Some(("identityfile".into(), vec!["~/my keys/id".into()])));
        assert_eq!(config_line("# only a comment"), None);
        assert_eq!(config_line("   "), None);
    }

    #[test]
    fn patterns_match_like_ssh() {
        assert!(glob(b"*.internal", b"web.internal"));
        assert!(glob(b"cedar-0?", b"cedar-01"));
        assert!(!glob(b"cedar-0?", b"cedar-010"));
        assert!(glob(b"*", b""));
        assert!(glob(b"a*b*c", b"aXXbYYc"));
        assert!(!glob(b"a*b*c", b"aXXbYY"));
        assert!(host_matches(&["*".into(), "!nas".into()], "cedar"));
        assert!(!host_matches(&["*".into(), "!nas".into()], "nas"));
        assert!(!host_matches(&["!nas".into()], "cedar"), "a negation alone matches nothing");
    }

    const KNOWN_HOSTS: &str = "\
cedar-02.tailc0ffee.ts.net,100.64.0.23 ssh-ed25519 AAAAC3Nza1
[nas.local]:2222 ssh-ed25519 AAAAC3Nza2
|1|JfKTdBh7rNbXkVAQCRp4OQoPfmI=|USECr3SWf1JUPsms5AqfD5QfxkM= ssh-ed25519 AAAAC3Nza3
@revoked old-box ssh-rsa AAAAB3Nza4
@cert-authority *.example.com ssh-rsa AAAAB3Nza5
*.lab,!secret.lab ssh-ed25519 AAAAC3Nza6
github.com ssh-ed25519 AAAAC3Nza7
192.168.1.77 ecdsa-sha2-nistp256 AAAAE2Vj8
localhost ssh-ed25519 AAAAC3Nza9
[bad]:port ssh-ed25519 AAAAC3Nza10
# a comment

";

    #[test]
    fn known_hosts_names_hosts_and_skips_hashed_ones() {
        assert_eq!(
            parse_known_hosts(KNOWN_HOSTS),
            vec![
                KnownHost { names: vec!["cedar-02.tailc0ffee.ts.net".into(), "100.64.0.23".into()], port: 22 },
                KnownHost { names: vec!["nas.local".into()], port: 2222 },
                KnownHost { names: vec!["github.com".into()], port: 22 },
                KnownHost { names: vec!["192.168.1.77".into()], port: 22 },
                KnownHost { names: vec!["localhost".into()], port: 22 },
            ],
        );
    }

    fn status() -> Value {
        serde_json::json!({
            "Self": { "HostName": "Caseys-MacBook-Pro", "DNSName": "caseys-macbook-pro.tailc0ffee.ts.net.", "OS": "macOS", "TailscaleIPs": ["100.64.0.1"] },
            "User": { "123": { "LoginName": "casey@example.com" } },
            "Peer": {
                "nodekey:1": { "HostName": "cedar-02", "DNSName": "cedar-02.tailc0ffee.ts.net.", "OS": "linux", "TailscaleIPs": ["100.64.0.23", "fd7a:115c:a1e0::1"], "Online": true, "PublicKey": "nodekey:secret" },
                "nodekey:2": { "HostName": "Mac-Studio", "DNSName": "mac-studio.tailc0ffee.ts.net.", "OS": "macOS", "TailscaleIPs": ["100.64.0.7"], "Online": false },
                "nodekey:3": { "HostName": "Casey's iPhone", "DNSName": "caseys-iphone.tailc0ffee.ts.net.", "OS": "iOS", "TailscaleIPs": ["100.64.0.8"], "Online": true },
                "nodekey:4": { "HostName": "au-syd-wg-001", "DNSName": "au-syd-wg-001.mullvad.ts.net.", "OS": "linux", "TailscaleIPs": ["100.64.0.9"], "Online": true },
                "nodekey:5": { "HostName": "cedar-01", "DNSName": "cedar-01.tailc0ffee.ts.net.", "OS": "linux", "TailscaleIPs": ["100.64.0.21"], "Online": true },
                "nodekey:6": { "HostName": "", "DNSName": "", "OS": "linux", "TailscaleIPs": [], "Online": true }
            }
        })
    }

    #[test]
    fn tailscale_peers_leave_out_phones_exit_nodes_and_this_mac() {
        let peers = peers_from_status(&status());
        let names: Vec<&str> = peers.iter().map(|peer| peer.dns_name.as_str()).collect();
        assert_eq!(names, ["cedar-01.tailc0ffee.ts.net", "cedar-02.tailc0ffee.ts.net", "mac-studio.tailc0ffee.ts.net"]);
        let studio = peers.iter().find(|peer| peer.host_name == "Mac-Studio").unwrap();
        assert_eq!(studio.os, "macOS");
        assert!(!studio.online);
        assert!(peers_from_status(&serde_json::json!({ "BackendState": "Stopped" })).is_empty());
    }

    #[test]
    fn suggestions_merge_what_each_source_knows_about_one_machine() {
        let config = read_ssh_config(&samples(), Path::new(HOME));
        let found = discovered_hosts(&config, &parse_known_hosts(KNOWN_HOSTS), &peers_from_status(&status()));
        let summary: Vec<(String, String, u16, Vec<DiscoverySource>)> =
            found.iter().map(|host| (host.name.clone(), host.endpoint.clone(), host.port, host.sources.clone())).collect();
        assert_eq!(
            summary,
            [
                ("bastion".to_string(), "bastion".to_string(), 2222, vec![DiscoverySource::SshConfig]),
                ("behind-bastion".into(), "behind-bastion".into(), 22, vec![DiscoverySource::SshConfig]),
                ("build-arm".into(), "build-arm".into(), 2200, vec![DiscoverySource::SshConfig]),
                ("cedar-01".into(), "cedar-01".into(), 22, vec![DiscoverySource::SshConfig, DiscoverySource::Tailscale]),
                ("cedar-02".into(), "cedar-02".into(), 22, vec![DiscoverySource::SshConfig, DiscoverySource::Tailscale, DiscoverySource::KnownHosts]),
                ("lab-box".into(), "lab-box".into(), 2222, vec![DiscoverySource::SshConfig]),
                ("mac-studio".into(), "mac-studio.tailc0ffee.ts.net".into(), 22, vec![DiscoverySource::Tailscale]),
                ("nas".into(), "nas".into(), 22, vec![DiscoverySource::SshConfig, DiscoverySource::KnownHosts]),
                (String::new(), "192.168.1.77".into(), 22, vec![DiscoverySource::KnownHosts]),
            ],
            "git hosts, loopback addresses and hosts only reachable locally are left out",
        );
        let cedar = &found[4];
        assert_eq!(cedar.host_name.as_deref(), Some("cedar-02.tailc0ffee.ts.net"));
        assert_eq!(cedar.user.as_deref(), Some("casey"));
        assert_eq!(cedar.os.as_deref(), Some("linux"));
        assert_eq!(cedar.online, Some(true));
        assert!(cedar.addresses.contains(&"100.64.0.23".to_string()));
        assert_eq!(found[7].port, 22, "nas's known port is 2222, but its alias is what gets used");
    }

    #[test]
    fn suggestions_never_carry_keys_or_their_paths() {
        let config = read_ssh_config(&samples(), Path::new(HOME));
        let found = discovered_hosts(&config, &parse_known_hosts(KNOWN_HOSTS), &peers_from_status(&status()));
        let json = serde_json::to_string(&found).unwrap();
        for secret in ["id_ed25519", "id_work", "keys/build", "AAAA", "nodekey", "casey@example.com", "JfKTdBh7"] {
            assert!(!json.contains(secret), "{secret} leaked into {json}");
        }
    }

    #[test]
    fn peers_known_only_by_address_are_offered_by_address() {
        let peers = peers_from_status(&serde_json::json!({
            "Peer": { "a": { "HostName": "pi", "DNSName": "", "OS": "linux", "TailscaleIPs": ["fd7a:115c:a1e0::5", "100.64.0.5"], "Online": true } }
        }));
        let found = discovered_hosts(&SshConfig::default(), &[], &peers);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "pi");
        assert_eq!(found[0].endpoint, "100.64.0.5", "an IPv4 address reads more easily");
    }
}

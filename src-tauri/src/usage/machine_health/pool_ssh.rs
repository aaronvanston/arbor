//! Pools as SSH hosts. `ssh arbor-<pool>` reaches one of the pool's members: Arbor's own SSH config gives each pool a
//! host whose ProxyCommand is `arbor pools connect`, which asks the app for a member and carries the connection to its
//! sshd. Any app that connects to SSH hosts (an editor, an agent app, plain ssh) can open a pool that way unchanged.
//!
//! The first connection under a host name picks a member, and the name is pinned to it from then on, saved in usage.db:
//! apps open several connections (a control connection, file sync, forwarded ports) that have to land on one machine,
//! and apps that remember a host by name (its folders, its threads, a server they installed there) have to find the
//! same machine next week. A member getting busy never moves a pin; only one that's off, gone or failing its health
//! check is replaced, on the next connection, and the person can forget a name on the pool's page. Each name is pinned
//! on its own (`arbor-builds`, `arbor-builds-b`), so two workspaces can spread out.
//!
//! Host keys are only ever ones the person's own known_hosts already trusts for a member. Arbor copies them under one
//! alias into a file of its own, so ssh accepts whichever member answers, and never scans for new ones. A member
//! without a saved key, or reached as another user than the pool's, isn't picked, and neither is this Mac, where the
//! ProxyCommand runs: an app would only be connected back to itself.
//!
//! The files live in ~/.arbor/ssh and are Arbor's alone, rewritten whenever pools or their members change. The person's
//! own ~/.ssh/config gets one Include line, added only when asked, through a guarded write they can undo.

use super::guarded_writes::{cksum, edit_call, edit_finish, edit_outcomes, edit_start, new_stamp, run_on, ChangeKind, Edit, EditFile, EditOutcome};
use super::pools::{self, MachinePool, VerdictKind};
use super::runs;
use super::*;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex as StdMutex, OnceLock};

pub(crate) const POOL_SSH_UPDATED_EVENT: &str = "pool-ssh-updated";

/// The one name every member's host key is filed under in Arbor's known_hosts.
const HOST_KEY_ALIAS: &str = "arbor-pools";
/// How long a member's SSH settings and host keys are taken as read; connecting reads them, so a burst of connections
/// doesn't start dozens of helpers.
const RESOLVED_FOR: Duration = Duration::from_secs(60);
const HELPER_TIMEOUT: Duration = Duration::from_secs(5);
/// Where Arbor's SSH files live, in the home folder; no spaces, so ssh's config needs no quoting for them.
const SSH_DIR: &str = ".arbor/ssh";
const CONFIG_FILE: &str = "pools.conf";
const KNOWN_HOSTS_FILE: &str = "pools_known_hosts";
pub(crate) const INCLUDE_LINE: &str = "Include ~/.arbor/ssh/pools.conf";

// ---------------------------------------------------------------------------
// What a member's SSH looks like
// ---------------------------------------------------------------------------

/// What `ssh -G` says about a member's host.
#[derive(Clone, Debug, Default, PartialEq)]
struct SshSettings {
    hostname: String,
    port: u16,
    user: String,
    host_key_alias: Option<String>,
    /// A jump host or proxy command sits in between, so it can't be reached straight over TCP.
    proxied: bool,
    known_hosts_files: Vec<String>,
    identity_files: Vec<String>,
    identity_agent: Option<String>,
}

fn parse_ssh_settings(text: &str) -> Option<SshSettings> {
    let mut settings = SshSettings { port: 22, ..SshSettings::default() };
    for line in text.lines() {
        let Some((key, value)) = line.trim().split_once(' ') else { continue };
        let value = value.trim();
        match key {
            "hostname" => settings.hostname = value.to_string(),
            "port" => settings.port = value.parse().ok()?,
            "user" => settings.user = value.to_string(),
            "hostkeyalias" if value != "none" => settings.host_key_alias = Some(value.to_string()),
            "proxyjump" | "proxycommand" if value != "none" => settings.proxied = true,
            "userknownhostsfile" | "globalknownhostsfile" => settings.known_hosts_files.extend(value.split_whitespace().map(str::to_string)),
            "identityfile" => settings.identity_files.push(value.to_string()),
            "identityagent" if value != "none" && value != "SSH_AUTH_SOCK" => settings.identity_agent = Some(value.to_string()),
            _ => {}
        }
    }
    let usable = |text: &str| !text.is_empty() && !text.starts_with('-') && !text.chars().any(|c| c.is_whitespace() || c.is_control());
    (usable(&settings.hostname) && usable(&settings.user)).then_some(settings)
}

/// The names a member's key is saved under in known_hosts, the way ssh looks it up: its HostKeyAlias alone when it has
/// one, otherwise the host name and the endpoint's host, with the port when it isn't 22.
fn key_names(settings: &SshSettings, endpoint: &str) -> Vec<String> {
    let with_port = |name: &str| if settings.port == 22 { name.to_string() } else { format!("[{name}]:{}", settings.port) };
    if let Some(alias) = &settings.host_key_alias {
        return vec![with_port(alias)];
    }
    let typed = endpoint.trim().rsplit('@').next().unwrap_or_default();
    let mut names = vec![with_port(&settings.hostname)];
    if !typed.is_empty() && typed != settings.hostname {
        names.push(with_port(typed));
    }
    names
}

/// The keys `ssh-keygen -F` found, as `type key`. Revoked keys and certificate authorities are left out: neither
/// vouches for a member on its own.
fn parse_found_keys(text: &str) -> Vec<String> {
    let base64 = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='));
    let kind = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'@'));
    text.lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            match fields.as_slice() {
                [first, ..] if first.starts_with('@') => None,
                [_, key_type, key, ..] if kind(key_type) && base64(key) => Some(format!("{key_type} {key}")),
                _ => None,
            }
        })
        .collect()
}

/// A member's SSH, as far as connecting to it through a pool goes.
#[derive(Clone, Debug, Default, PartialEq)]
struct MemberSsh {
    /// None when `ssh -G` couldn't say where it is.
    settings: Option<SshSettings>,
    keys: Vec<String>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn expand_home(path: &str, home: &Path) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    }
}

async fn helper_output(program: &str, args: &[&str]) -> Option<String> {
    let mut command = tokio::process::Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    configure_helper_command(&mut command);
    let output = tokio::time::timeout(HELPER_TIMEOUT, command.output()).await.ok()?.ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn resolve_member(host: &MachineHost) -> MemberSsh {
    let port = host.port.to_string();
    let Some(settings) = helper_output("ssh", &["-G", "-p", &port, "--", host.endpoint.trim()]).await.and_then(|text| parse_ssh_settings(&text)) else {
        return MemberSsh::default();
    };
    let mut keys = Vec::new();
    if let Some(home) = home_dir() {
        for file in &settings.known_hosts_files {
            let file = expand_home(file, &home);
            if !file.is_file() {
                continue;
            }
            let file = file.to_string_lossy();
            for name in key_names(&settings, &host.endpoint) {
                if let Some(found) = helper_output("ssh-keygen", &["-F", &name, "-f", &file]).await {
                    keys.extend(parse_found_keys(&found));
                }
            }
        }
    }
    keys.sort();
    keys.dedup();
    MemberSsh { settings: Some(settings), keys }
}

fn resolved_cache() -> &'static StdMutex<HashMap<String, (MachineHost, MemberSsh, Instant)>> {
    static CACHE: OnceLock<StdMutex<HashMap<String, (MachineHost, MemberSsh, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Each member's SSH by normalized name, read again once RESOLVED_FOR has passed or its host has changed.
async fn resolve_members(hosts: Vec<(String, MachineHost)>) -> BTreeMap<String, MemberSsh> {
    let mut known = BTreeMap::new();
    let mut wanted = Vec::new();
    {
        let cache = resolved_cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for (key, host) in hosts {
            match cache.get(&key) {
                Some((cached, member, at)) if *cached == host && at.elapsed() < RESOLVED_FOR => {
                    known.insert(key, member.clone());
                }
                _ => wanted.push((key, host)),
            }
        }
    }
    let answers = futures_util::future::join_all(wanted.into_iter().map(|(key, host)| async move {
        let member = resolve_member(&host).await;
        (key, host, member)
    }))
    .await;
    let mut cache = resolved_cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    for (key, host, member) in answers {
        cache.insert(key.clone(), (host, member.clone(), Instant::now()));
        known.insert(key, member);
    }
    known
}

/// Every pool member's host, by normalized name.
fn member_hosts(inner: &Inner, pools_saved: &[MachinePool]) -> Vec<(String, MachineHost)> {
    let keys: BTreeSet<String> = pools_saved.iter().flat_map(|pool| pool.members.iter().map(|member| normalize_machine_name(&member.machine))).collect();
    keys.into_iter().filter_map(|key| runs::machine_named(inner, &key).map(|machine| (key, machine.host().clone()))).collect()
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/// Whether a member can take a connection through its pool's host.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "PoolSshReadiness")]
pub(crate) enum Readiness {
    Ready,
    /// Arbor can't tell where it is: it's not on the Machines page, or ssh can't read its settings.
    NoAddress,
    /// This Mac has never saved its host key, so ssh couldn't tell it from an impostor.
    NoHostKey,
    /// Reached as another user than the pool's host connects as.
    OtherUser,
    /// The Mac the host is opened from: a connection would come back to the apps already running here.
    ThisMac,
}

fn readiness(member: Option<&MemberSsh>, user: Option<&str>) -> Readiness {
    let Some(settings) = member.and_then(|member| member.settings.as_ref()) else { return Readiness::NoAddress };
    if member.is_none_or(|member| member.keys.is_empty()) {
        Readiness::NoHostKey
    } else if user.is_some_and(|user| user != settings.user) {
        Readiness::OtherUser
    } else {
        Readiness::Ready
    }
}

/// The members that are this Mac. The pool host's ProxyCommand always runs here, so picking one of them would
/// connect an app back to itself (T3 Code to its own server, Orca to its own folders).
fn this_mac_members(inner: &Inner) -> BTreeSet<String> {
    inner
        .series
        .values()
        .filter(|series| series.local)
        .map(|series| normalize_machine_name(&series.host.machine))
        .chain(shell::this_machine_name(inner).map(|name| normalize_machine_name(&name)))
        .collect()
}

/// A member's readiness for its pool's host, this Mac never ready.
fn member_readiness(this_mac: &BTreeSet<String>, resolved: &BTreeMap<String, MemberSsh>, user: Option<&str>, machine: &str) -> Readiness {
    let key = normalize_machine_name(machine);
    if this_mac.contains(&key) {
        return Readiness::ThisMac;
    }
    readiness(resolved.get(&key), user)
}

/// The user a pool's host connects as: the one most of its members with a saved key are reached as, the first
/// member's on a tie.
fn pool_user(pool: &MachinePool, resolved: &BTreeMap<String, MemberSsh>) -> Option<String> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for member in &pool.members {
        let Some(found) = resolved.get(&normalize_machine_name(&member.machine)) else { continue };
        let Some(settings) = found.settings.as_ref().filter(|_| !found.keys.is_empty()) else { continue };
        match counts.iter_mut().find(|(user, _)| *user == settings.user) {
            Some((_, count)) => *count += 1,
            None => counts.push((settings.user.clone(), 1)),
        }
    }
    let most = counts.iter().map(|(_, count)| *count).max()?;
    counts.into_iter().find(|(_, count)| *count == most).map(|(user, _)| user)
}

// ---------------------------------------------------------------------------
// Arbor's SSH files
// ---------------------------------------------------------------------------

/// Each pool's host name, `arbor-` and its name in lowercase words; a clash takes a number.
fn host_names(pools_saved: &[MachinePool]) -> BTreeMap<String, String> {
    let mut taken = BTreeSet::new();
    let mut names = BTreeMap::new();
    for pool in pools_saved {
        let mut slug = String::new();
        for c in pool.name.chars() {
            if c.is_ascii_alphanumeric() {
                slug.push(c.to_ascii_lowercase());
            } else if !slug.is_empty() && !slug.ends_with('-') {
                slug.push('-');
            }
        }
        let slug = match slug.trim_end_matches('-') {
            "" => "pool".to_string(),
            slug => slug.to_string(),
        };
        let mut name = format!("arbor-{slug}");
        let mut n = 2;
        while taken.contains(&name) {
            name = format!("arbor-{slug}-{n}");
            n += 1;
        }
        taken.insert(name.clone());
        names.insert(pool.id.clone(), name);
    }
    names
}

/// A value ssh's config can hold in double quotes.
fn quotable(text: &str) -> bool {
    !text.is_empty() && !text.chars().any(|c| matches!(c, '"' | '\\' | '%' | '$' | '`') || c.is_control())
}

/// One pool's block in Arbor's SSH config.
struct HostBlock {
    host: String,
    pool_id: String,
    user: Option<String>,
    identity_files: Vec<String>,
    identity_agent: Option<String>,
}

fn host_blocks(pools_saved: &[MachinePool], resolved: &BTreeMap<String, MemberSsh>) -> Vec<HostBlock> {
    let names = host_names(pools_saved);
    let mut blocks: Vec<HostBlock> = pools_saved
        .iter()
        .filter(|pool| !pool.members.is_empty())
        .filter_map(|pool| {
            let user = pool_user(pool, resolved);
            let ready: Vec<&SshSettings> = pool
                .members
                .iter()
                .filter_map(|member| resolved.get(&normalize_machine_name(&member.machine)))
                .filter(|member| readiness(Some(member), user.as_deref()) == Readiness::Ready)
                .filter_map(|member| member.settings.as_ref())
                .collect();
            let mut identity_files: Vec<String> = Vec::new();
            for file in ready.iter().flat_map(|settings| &settings.identity_files) {
                if quotable(file) && !identity_files.contains(file) {
                    identity_files.push(file.clone());
                }
            }
            // An agent socket only when every ready member uses the same one; otherwise ssh's own setting stands.
            let agents: BTreeSet<Option<&String>> = ready.iter().map(|settings| settings.identity_agent.as_ref()).collect();
            let identity_agent = match agents.into_iter().collect::<Vec<_>>().as_slice() {
                [Some(agent)] if quotable(agent) => Some((*agent).clone()),
                _ => None,
            };
            Some(HostBlock { host: names.get(&pool.id)?.clone(), pool_id: pool.id.clone(), user, identity_files, identity_agent })
        })
        .collect();
    // ssh takes each setting from the first block that matches, and `arbor-builds-*` matches `arbor-builds-2`, so a
    // longer name goes first.
    blocks.sort_by(|a, b| b.host.len().cmp(&a.host.len()).then_with(|| a.host.cmp(&b.host)));
    blocks
}

fn render_config(blocks: &[HostBlock], arbor: Option<&str>) -> String {
    let mut text = String::from("# Arbor's machine pools, written by Arbor; changes here are replaced.\n# Edit pools in Arbor's Settings › Pools.\n");
    let Some(arbor) = arbor.filter(|path| quotable(path)) else {
        text.push_str("# Install the arbor command in Arbor's Settings › App to connect to pools.\n");
        return text;
    };
    for block in blocks {
        text.push_str(&format!("\nHost {0} {0}-*\n", block.host));
        // %h is the name as typed, since the block sets no HostName; apps that run a ProxyCommand themselves (Orca)
        // fill in %h, %p and %r but not %n.
        text.push_str(&format!("  ProxyCommand \"{arbor}\" pools connect {} %h\n", block.pool_id));
        text.push_str(&format!("  HostKeyAlias {HOST_KEY_ALIAS}\n"));
        text.push_str(&format!("  UserKnownHostsFile ~/{SSH_DIR}/{KNOWN_HOSTS_FILE}\n"));
        text.push_str("  StrictHostKeyChecking yes\n  UpdateHostKeys no\n");
        if let Some(user) = &block.user {
            text.push_str(&format!("  User {user}\n"));
        }
        for file in &block.identity_files {
            text.push_str(&format!("  IdentityFile \"{file}\"\n"));
        }
        if let Some(agent) = &block.identity_agent {
            text.push_str(&format!("  IdentityAgent \"{agent}\"\n"));
        }
    }
    text
}

fn render_known_hosts(resolved: &BTreeMap<String, MemberSsh>) -> String {
    let keys: BTreeSet<&String> = resolved.values().flat_map(|member| &member.keys).collect();
    let mut text = String::from("# Host keys of Arbor's pool members, copied from your known_hosts by Arbor; changes here are replaced.\n");
    for key in keys {
        text.push_str(&format!("{HOST_KEY_ALIAS} {key}\n"));
    }
    text
}

/// Writes one of Arbor's files when it says something new: beside it first, then moved into place, private to the user.
fn write_private(path: &Path, text: &str) -> Result<bool, String> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    if std::fs::read_to_string(path).is_ok_and(|current| current == text) {
        return Ok(false);
    }
    if let Some(dir) = path.parent() {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|error| format!("Couldn't make {}: {error}", dir.display()))?;
    }
    let tmp = path.with_extension("arbor-tmp");
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .and_then(|mut file| std::io::Write::write_all(&mut file, text.as_bytes()))
        .and_then(|()| std::fs::rename(&tmp, path));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Couldn't write {}: {error}", path.display()));
    }
    Ok(true)
}

/// The `arbor` link ssh runs, when it's installed and runs an Arbor.
fn arbor_command() -> Option<String> {
    use crate::cli::settings::{install_status, linkable_executable, InstallState};
    let install = install_status(&home_dir()?, linkable_executable().as_deref());
    matches!(install.state, InstallState::Installed | InstallState::Elsewhere).then_some(install.link_path)
}

/// Rewrites Arbor's SSH config and known_hosts for the pools as they are.
fn write_files(pools_saved: &[MachinePool], resolved: &BTreeMap<String, MemberSsh>) -> Result<(), String> {
    let dir = home_dir().ok_or("Can't find your home folder")?.join(SSH_DIR);
    write_private(&dir.join(KNOWN_HOSTS_FILE), &render_known_hosts(resolved))?;
    write_private(&dir.join(CONFIG_FILE), &render_config(&host_blocks(pools_saved, resolved), arbor_command().as_deref()))?;
    Ok(())
}

/// Reads the pools and their members' SSH, and brings Arbor's files up to date.
async fn current(app: &tauri::AppHandle) -> Result<(Vec<MachinePool>, BTreeMap<String, MemberSsh>), String> {
    let pools_saved = run_usage_task(|| pools::read_pools(&open_usage_database()?)).await?;
    let hosts = member_hosts(&app.state::<MachineHealthState>().lock(), &pools_saved);
    let resolved = resolve_members(hosts).await;
    write_files(&pools_saved, &resolved)?;
    Ok((pools_saved, resolved))
}

/// Brings Arbor's SSH files up to date in the background, after pools change.
pub(super) fn refresh_soon(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = current(&app).await {
            eprintln!("Arbor couldn't update its SSH files for pools: {error}");
        }
        let _ = app.emit(POOL_SSH_UPDATED_EVENT, ());
    });
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
struct Pin {
    /// The pool the member was picked from: the one asked for, or one it spilled into.
    pool_id: String,
    /// The member, by normalized name.
    machine: String,
    picked_at_ms: i64,
}

/// A pool asked for and the host name it was asked under.
type PinKey = (String, String);

/// The saved pins, read from usage.db once, and the connections open under each name now, which only this run of Arbor
/// knows.
#[derive(Default)]
struct Pins {
    loaded: bool,
    saved: HashMap<PinKey, Pin>,
    open: HashMap<PinKey, u32>,
}

fn pins() -> &'static StdMutex<Pins> {
    static PINS: OnceLock<StdMutex<Pins>> = OnceLock::new();
    PINS.get_or_init(Default::default)
}

fn lock_pins() -> std::sync::MutexGuard<'static, Pins> {
    pins().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_pins(connection: &Connection) -> Result<HashMap<PinKey, Pin>, String> {
    let mut statement = connection
        .prepare("SELECT pool_id, name, from_pool_id, machine, picked_at_ms FROM usage_pool_ssh_names")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| Ok(((row.get(0)?, row.get(1)?), Pin { pool_id: row.get(2)?, machine: row.get(3)?, picked_at_ms: row.get(4)? })))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|error| error.to_string())
}

fn save_pin(connection: &Connection, key: &PinKey, pin: &Pin) -> Result<(), String> {
    connection
        .execute(
            "INSERT OR REPLACE INTO usage_pool_ssh_names (pool_id, name, from_pool_id, machine, picked_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![key.0, key.1, pin.pool_id, pin.machine, pin.picked_at_ms],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Takes a pool's pins off usage.db with the pool, inside its removal.
pub(super) fn delete_pool_pins(connection: &Connection, pool_id: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM usage_pool_ssh_names WHERE pool_id = ?1 OR from_pool_id = ?1", params![pool_id])
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Drops a removed pool's pins from memory too.
pub(super) fn forget_pool_pins(pool_id: &str) {
    lock_pins().saved.retain(|key, pin| key.0 != pool_id && pin.pool_id != pool_id);
}

async fn load_pins() -> Result<(), String> {
    if lock_pins().loaded {
        return Ok(());
    }
    let saved = run_usage_task(|| read_pins(&open_usage_database()?)).await?;
    let mut pins = lock_pins();
    if !pins.loaded {
        for (key, pin) in saved {
            pins.saved.entry(key).or_insert(pin);
        }
        pins.loaded = true;
    }
    Ok(())
}

/// Whether a pinned member keeps its pin. Only one known to be gone loses it: switched off, failing its health check,
/// or taken off the Machines page. Being busy never does, nor an old reading (Arbor may have been asleep), since moving
/// would leave the app looking for its files on another machine.
fn keeps_pin(kind: VerdictKind) -> bool {
    !matches!(kind, VerdictKind::NotListed | VerdictKind::Off | VerdictKind::Unreachable)
}

fn pin_holds(inner: &Inner, pools_saved: &[MachinePool], pin: &Pin, ready: &dyn Fn(&str) -> bool) -> Result<bool, String> {
    let Some(pool) = pools_saved.iter().find(|pool| pool.id == pin.pool_id) else { return Ok(false) };
    let now_ms = Local::now().timestamp_millis();
    let Some(verdict) = pools::assess_with(pool, &pools::readings(inner), &BTreeMap::new(), now_ms, inner.interval_ms, |_| true)
        .into_iter()
        .find(|verdict| normalize_machine_name(verdict.machine()) == pin.machine)
    else {
        return Ok(false);
    };
    // Just after Arbor starts, no machine is listed yet: that says nothing about this one.
    if verdict.kind() == VerdictKind::NotListed && inner.series.is_empty() {
        return Err("Arbor is still loading its machines. Try again in a moment".into());
    }
    Ok(keeps_pin(verdict.kind()) && ready(verdict.machine()))
}

/// The member a connection under `key` goes to, counted as open: the pinned one while it holds, otherwise a fresh
/// pick, given back to be saved.
fn take_pin(inner: &Inner, pools_saved: &[MachinePool], pins: &mut Pins, key: &PinKey, ready: &dyn Fn(&str) -> bool) -> Result<(Machine, Option<Pin>), String> {
    let kept = match pins.saved.get(key) {
        Some(pin) if pin_holds(inner, pools_saved, pin, ready)? => runs::machine_named(inner, &pin.machine),
        _ => None,
    };
    let (machine, picked) = match kept {
        Some(machine) => (machine, None),
        None => {
            let (from, machine) = runs::pick_for_connection(inner, pools_saved, &key.0, ready)?;
            let pin = Pin { pool_id: from, machine: normalize_machine_name(machine.name()), picked_at_ms: Local::now().timestamp_millis() };
            pins.saved.insert(key.clone(), pin.clone());
            (machine, Some(pin))
        }
    };
    *pins.open.entry(key.clone()).or_default() += 1;
    Ok((machine, picked))
}

/// Where `arbor pools connect` sends a connection.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "how")]
pub(crate) enum ConnectTarget {
    /// Straight to its sshd.
    Direct { machine: String, host: String, port: u16 },
    /// Through ssh to the machine itself, which then opens its own sshd: the way to one behind a jump host or proxy
    /// command, which ssh's own config already knows how to reach.
    Via { machine: String, endpoint: String, port: u16 },
}

/// Counts a connection as open under its host name until it ends.
pub(crate) struct PinHold {
    key: PinKey,
    app: tauri::AppHandle,
}

impl Drop for PinHold {
    fn drop(&mut self) {
        {
            let mut pins = lock_pins();
            if let Some(open) = pins.open.get_mut(&self.key) {
                *open = open.saturating_sub(1);
                if *open == 0 {
                    pins.open.remove(&self.key);
                }
            }
        }
        let _ = self.app.emit(POOL_SSH_UPDATED_EVENT, ());
    }
}

/// The pool `wanted` names: its id, its host name, or its name in any case.
fn find_pool<'a>(pools_saved: &'a [MachinePool], wanted: &str) -> Option<&'a MachinePool> {
    let names = host_names(pools_saved);
    let loose = normalize_machine_name(wanted);
    pools_saved
        .iter()
        .find(|pool| pool.id == wanted)
        .or_else(|| pools_saved.iter().find(|pool| names.get(&pool.id).is_some_and(|name| name == wanted)))
        .or_else(|| pools_saved.iter().find(|pool| normalize_machine_name(&pool.name) == loose))
}

/// Picks the member a connection to a pool under host name `name` goes to: the one that name is pinned to while it can
/// still be reached, otherwise a fresh pick, pinned from then on. Holds its place until the connection ends.
pub(crate) async fn open_connection(app: &tauri::AppHandle, pool: &str, name: &str) -> Result<(ConnectTarget, PinHold), String> {
    let (pools_saved, resolved) = current(app).await?;
    load_pins().await?;
    let pool = find_pool(&pools_saved, pool).ok_or_else(|| format!("Arbor has no pool called {pool}."))?;
    let user = pool_user(pool, &resolved);
    let this_mac = this_mac_members(&app.state::<MachineHealthState>().lock());
    let ready = |machine: &str| member_readiness(&this_mac, &resolved, user.as_deref(), machine) == Readiness::Ready;
    // A token the app running ssh left unexpanded is taken as no name: the pool's own host.
    let name = match name.trim() {
        "" => host_names(&pools_saved).get(&pool.id).cloned().unwrap_or_default(),
        typed if typed.starts_with('%') => host_names(&pools_saved).get(&pool.id).cloned().unwrap_or_default(),
        typed => typed.to_ascii_lowercase(),
    };
    let key = (pool.id.clone(), name);
    let (machine, host, picked) = {
        let state = app.state::<MachineHealthState>();
        let (machine, picked) = take_pin(&state.lock(), &pools_saved, &mut lock_pins(), &key, &ready)?;
        (machine.name().to_string(), machine.host().clone(), picked)
    };
    let hold = PinHold { key: key.clone(), app: app.clone() };
    if let Some(pin) = picked {
        // The connection goes ahead either way; only the pin would be forgotten when Arbor restarts.
        if let Err(error) = run_usage_task(move || save_pin(&open_usage_database()?, &key, &pin)).await {
            eprintln!("Arbor couldn't save which machine a pool's SSH host name is pinned to: {error}");
        }
    }
    let _ = app.emit(POOL_SSH_UPDATED_EVENT, ());
    let settings = resolved.get(&normalize_machine_name(&machine)).and_then(|member| member.settings.clone()).ok_or("Arbor lost track of where that machine is")?;
    Ok((target_for(&machine, &host, &settings), hold))
}

fn target_for(machine: &str, host: &MachineHost, settings: &SshSettings) -> ConnectTarget {
    if settings.proxied {
        ConnectTarget::Via { machine: machine.to_string(), endpoint: host.endpoint.trim().to_string(), port: settings.port }
    } else {
        ConnectTarget::Direct { machine: machine.to_string(), host: settings.hostname.clone(), port: settings.port }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PoolSshMember {
    machine: String,
    readiness: Readiness,
}

/// A host name the pool has been reached under, and the member it's pinned to.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PoolSshConnection {
    name: String,
    machine: String,
    /// Connections open now.
    open: u32,
    /// When it was pinned to the member.
    #[ts(type = "number")]
    picked_at_ms: i64,
}

/// Connecting to a pool over SSH, for its page.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PoolSsh {
    /// The pool's host name, as `ssh` takes it.
    host: String,
    /// Whether the arbor command ssh runs is installed.
    command_ready: bool,
    /// The line ~/.ssh/config needs for the pool hosts.
    include_line: String,
    /// Whether ~/.ssh/config has it.
    included: bool,
    /// The user its host connects as.
    user: Option<String>,
    members: Vec<PoolSshMember>,
    connections: Vec<PoolSshConnection>,
}

fn ssh_config_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".ssh/config"))
}

/// Whether an SSH config already brings in Arbor's pool hosts.
fn includes_pools(config: &str) -> bool {
    config.lines().any(|line| {
        let line = line.trim();
        line.get(..7).is_some_and(|word| word.eq_ignore_ascii_case("include")) && line.contains(&format!("{SSH_DIR}/{CONFIG_FILE}"))
    })
}

/// How to connect to a pool over SSH: its host name, which members can take a connection and why the others can't,
/// and which host names are pinned to which member.
#[tauri::command]
pub(crate) async fn get_pool_ssh(app: tauri::AppHandle, pool_id: String) -> Result<PoolSsh, String> {
    let (pools_saved, resolved) = current(&app).await?;
    let pool = pools_saved.iter().find(|pool| pool.id == pool_id).ok_or("That pool was removed")?;
    let user = pool_user(pool, &resolved);
    let this_mac = this_mac_members(&app.state::<MachineHealthState>().lock());
    let members = pool
        .members
        .iter()
        .map(|member| PoolSshMember {
            machine: member.machine.clone(),
            readiness: member_readiness(&this_mac, &resolved, user.as_deref(), &member.machine),
        })
        .collect();
    let display: BTreeMap<String, String> = app
        .state::<MachineHealthState>()
        .lock()
        .series
        .values()
        .map(|series| (normalize_machine_name(&series.host.machine), series.host.machine.clone()))
        .collect();
    load_pins().await?;
    let mut connections: Vec<PoolSshConnection> = {
        let pins = lock_pins();
        pins.saved
            .iter()
            .filter(|((pool, _), _)| *pool == pool_id)
            .map(|(key, pin)| PoolSshConnection {
                name: key.1.clone(),
                machine: display.get(&pin.machine).cloned().unwrap_or_else(|| pin.machine.clone()),
                open: pins.open.get(key).copied().unwrap_or(0),
                picked_at_ms: pin.picked_at_ms,
            })
            .collect()
    };
    connections.sort_by(|a, b| a.name.cmp(&b.name));
    let included = ssh_config_path().and_then(|path| std::fs::read_to_string(path).ok()).is_some_and(|config| includes_pools(&config));
    Ok(PoolSsh {
        host: host_names(&pools_saved).get(&pool.id).cloned().unwrap_or_default(),
        command_ready: arbor_command().is_some(),
        include_line: INCLUDE_LINE.into(),
        included,
        user,
        members,
        connections,
    })
}

/// ~/.ssh/config with Arbor's Include line on top, where ssh reads it for every host.
fn with_include(config: Option<&[u8]>) -> Vec<u8> {
    let mut text = format!("# Machine pools from Arbor\n{INCLUDE_LINE}\n").into_bytes();
    if let Some(config) = config.filter(|config| !config.is_empty()) {
        text.push(b'\n');
        text.extend_from_slice(config);
    }
    text
}

/// Adds the line that brings Arbor's pool hosts into ~/.ssh/config, backed up so Sync › Repo › History can undo it.
#[tauri::command]
pub(crate) async fn add_pool_ssh_include(app: tauri::AppHandle) -> Result<(), String> {
    let path = ssh_config_path().ok_or("Can't find your home folder")?;
    let config = match std::fs::read(&path) {
        Ok(config) => Some(config),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Couldn't read ~/.ssh/config: {error}")),
    };
    if config.as_deref().is_some_and(|config| includes_pools(&String::from_utf8_lossy(config))) {
        return Ok(());
    }
    current(&app).await?;
    let edit = Edit { file: EditFile::InHome(".ssh/config".into()), before: config.as_deref().map_or_else(|| "-".to_string(), cksum), content: with_include(config.as_deref()) };
    let target = {
        let state = app.state::<MachineHealthState>();
        let inner = state.lock();
        let name = agent_homes::this_mac_name(&inner);
        agent_homes::machines_to_scan(&inner).into_iter().find(Machine::is_local).unwrap_or_else(|| Machine::this_mac(&name))
    };
    let script = format!(
        "[ -d \"$HOME/.ssh\" ] || (umask 077 && mkdir -p \"$HOME/.ssh\") || exit 5\n{}{}{}",
        edit_start(&new_stamp(), ChangeKind::Ssh),
        edit_call(0, &edit),
        edit_finish()
    );
    let stdout = run_on(&target, MachineOp::SshConfigWrite, &script).await?;
    let _ = app.emit(POOL_SSH_UPDATED_EVENT, ());
    match edit_outcomes(&stdout).get(&0) {
        Some(EditOutcome::Done) => Ok(()),
        Some(EditOutcome::Changed) => Err("~/.ssh/config changed while Arbor was adding the line, so it left it alone. Try again".into()),
        _ => Err("Arbor couldn't add the line to ~/.ssh/config".into()),
    }
}

/// Unpins a host name, so its next connection picks a member afresh. Refused while it has connections open, which
/// would be left on one machine with the next on another.
#[tauri::command]
pub(crate) async fn forget_pool_ssh_name(app: tauri::AppHandle, pool_id: String, name: String) -> Result<(), String> {
    load_pins().await?;
    let key = (pool_id, name);
    if lock_pins().open.get(&key).is_some_and(|open| *open > 0) {
        return Err(format!("{} has connections open. Close them, then forget it", key.1));
    }
    let row = key.clone();
    run_usage_task(move || {
        open_usage_database()?
            .execute("DELETE FROM usage_pool_ssh_names WHERE pool_id = ?1 AND name = ?2", params![row.0, row.1])
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
    .await?;
    lock_pins().saved.remove(&key);
    let _ = app.emit(POOL_SSH_UPDATED_EVENT, ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::pools::{PoolMember, PoolWeight, PoolWhenFull};

    const SSH_G: &str = "host cam-mbp\nhostname cam-mbp.tail1234.ts.net\nport 22\nuser cam\nproxyjump none\n\
                         userknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\nglobalknownhostsfile /etc/ssh/ssh_known_hosts\n\
                         identityfile ~/.ssh/id_ed25519\nidentityfile ~/.ssh/id_rsa\nidentityagent SSH_AUTH_SOCK\n";

    fn settings(user: &str) -> SshSettings {
        SshSettings { hostname: format!("{user}-host"), port: 22, user: user.into(), ..SshSettings::default() }
    }

    fn member(user: &str, keys: &[&str]) -> MemberSsh {
        MemberSsh { settings: Some(settings(user)), keys: keys.iter().map(|key| key.to_string()).collect() }
    }

    fn pool(id: &str, name: &str, members: &[&str]) -> MachinePool {
        MachinePool {
            id: id.into(),
            name: name.into(),
            members: members.iter().map(|machine| PoolMember { machine: (*machine).into(), weight: PoolWeight::Normal }).collect(),
            max_agents: None,
            cpu_ceiling: None,
            mem_floor: None,
            when_full: PoolWhenFull::Refuse,
            spill_pool: None,
            queue_timeout_min: 30,
        }
    }

    #[test]
    fn ssh_settings_are_read_from_ssh_g() {
        let parsed = parse_ssh_settings(SSH_G).unwrap();
        assert_eq!(parsed.hostname, "cam-mbp.tail1234.ts.net");
        assert_eq!(parsed.user, "cam");
        assert!(!parsed.proxied);
        assert_eq!(parsed.known_hosts_files, ["~/.ssh/known_hosts", "~/.ssh/known_hosts2", "/etc/ssh/ssh_known_hosts"]);
        assert_eq!(parsed.identity_files, ["~/.ssh/id_ed25519", "~/.ssh/id_rsa"]);
        assert_eq!(parsed.identity_agent, None, "ssh's default agent isn't copied");
        let jumped = parse_ssh_settings(&SSH_G.replace("proxyjump none", "proxyjump bastion")).unwrap();
        assert!(jumped.proxied);
        assert!(parse_ssh_settings("hostname -oProxyCommand=x\nuser cam\n").is_none(), "a host that reads as a flag is refused");
    }

    #[test]
    fn keys_are_looked_up_the_way_ssh_saves_them() {
        let mut found = parse_ssh_settings(SSH_G).unwrap();
        assert_eq!(key_names(&found, "cam@cam-mbp"), ["cam-mbp.tail1234.ts.net", "cam-mbp"]);
        found.port = 2222;
        assert_eq!(key_names(&found, "cam-mbp"), ["[cam-mbp.tail1234.ts.net]:2222", "[cam-mbp]:2222"]);
        found.host_key_alias = Some("mbp".into());
        assert_eq!(key_names(&found, "cam-mbp"), ["[mbp]:2222"]);
    }

    #[test]
    fn found_keys_keep_type_and_key_and_skip_revoked_ones() {
        let output = "# Host cam-mbp found: line 4\n|1|abc=|def= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB comment\n\
                      @revoked cam-mbp ssh-rsa AAAAB3Nza\n@cert-authority * ssh-ed25519 AAAAC3Nz\ncam-mbp ssh-rsa AAAA;rm\n";
        assert_eq!(parse_found_keys(output), ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB"]);
    }

    #[test]
    fn a_member_is_ready_with_a_saved_key_and_the_pools_user_unless_its_this_mac() {
        assert_eq!(readiness(None, Some("cam")), Readiness::NoAddress);
        assert_eq!(readiness(Some(&MemberSsh::default()), Some("cam")), Readiness::NoAddress);
        assert_eq!(readiness(Some(&member("cam", &[])), Some("cam")), Readiness::NoHostKey);
        assert_eq!(readiness(Some(&member("cam", &["ssh-ed25519 AAAA"])), Some("ops")), Readiness::OtherUser);
        assert_eq!(readiness(Some(&member("cam", &["ssh-ed25519 AAAA"])), Some("cam")), Readiness::Ready);
        let resolved = BTreeMap::from([("cammbp".to_string(), member("cam", &["ssh-ed25519 AAAA"])), ("labbox".to_string(), member("cam", &["ssh-ed25519 BBBB"]))]);
        let this_mac = BTreeSet::from(["cammbp".to_string()]);
        assert_eq!(member_readiness(&this_mac, &resolved, Some("cam"), "Cam MBP"), Readiness::ThisMac, "the Mac the host is opened from is never picked");
        assert_eq!(member_readiness(&this_mac, &resolved, Some("cam"), "lab-box"), Readiness::Ready);
    }

    #[test]
    fn the_pools_user_is_the_one_most_members_use() {
        let resolved = BTreeMap::from([
            ("a".to_string(), member("ops", &["k1"])),
            ("b".to_string(), member("cam", &["k2"])),
            ("c".to_string(), member("cam", &["k3"])),
            ("d".to_string(), member("root", &[])),
        ]);
        assert_eq!(pool_user(&pool("p", "Builds", &["a", "b", "c", "d"]), &resolved).as_deref(), Some("cam"));
        assert_eq!(pool_user(&pool("p", "Builds", &["a", "b"]), &resolved).as_deref(), Some("ops"), "a tie goes to the first member");
        assert_eq!(pool_user(&pool("p", "Builds", &["d"]), &resolved), None, "a member without a key doesn't count");
    }

    #[test]
    fn host_names_are_lowercase_words_and_never_clash() {
        let pools = [pool("1", "Fast builds!", &[]), pool("2", "fast  builds", &[]), pool("3", "  ", &[])];
        let names = host_names(&pools);
        assert_eq!(names["1"], "arbor-fast-builds");
        assert_eq!(names["2"], "arbor-fast-builds-2");
        assert_eq!(names["3"], "arbor-pool");
        assert_eq!(find_pool(&pools, "arbor-fast-builds-2").map(|pool| pool.id.as_str()), Some("2"));
        assert_eq!(find_pool(&pools, "FAST BUILDS!").map(|pool| pool.id.as_str()), Some("1"));
    }

    #[test]
    fn the_config_routes_each_pool_through_arbor_and_its_own_known_hosts() {
        let resolved = BTreeMap::from([("a".to_string(), member("cam", &["ssh-ed25519 AAAA"])), ("b".to_string(), member("cam", &["ssh-rsa BBBB"]))]);
        let pools = [pool("p1", "Builds", &["a"]), pool("p2", "Builds 2", &["a", "b"]), pool("p3", "Empty", &[])];
        let config = render_config(&host_blocks(&pools, &resolved), Some("/Users/cam/.local/bin/arbor"));
        assert!(config.contains("\nHost arbor-builds arbor-builds-*\n  ProxyCommand \"/Users/cam/.local/bin/arbor\" pools connect p1 %h\n"), "{config}");
        assert!(config.find("Host arbor-builds-2").unwrap() < config.find("Host arbor-builds ").unwrap(), "the longer name matches first");
        assert!(config.contains("  HostKeyAlias arbor-pools\n  UserKnownHostsFile ~/.arbor/ssh/pools_known_hosts\n  StrictHostKeyChecking yes\n"));
        assert!(config.contains("  User cam\n"));
        assert!(!config.contains("arbor-empty"), "a pool with no members gets no host");
        let without = render_config(&host_blocks(&pools, &resolved), None);
        assert!(!without.contains("Host "), "nothing to run without the arbor command");
        let known = render_known_hosts(&resolved);
        assert!(known.ends_with("arbor-pools ssh-ed25519 AAAA\narbor-pools ssh-rsa BBBB\n"), "{known}");
    }

    #[test]
    fn only_a_member_known_to_be_gone_loses_its_pin() {
        for kind in [VerdictKind::Eligible, VerdictKind::AgentsFull, VerdictKind::CpuHigh, VerdictKind::MemoryLow, VerdictKind::NoReading, VerdictKind::Stale] {
            assert!(keeps_pin(kind), "{kind:?}");
        }
        for kind in [VerdictKind::NotListed, VerdictKind::Off, VerdictKind::Unreachable] {
            assert!(!keeps_pin(kind), "{kind:?}");
        }
    }

    #[test]
    fn pins_are_saved_and_go_with_their_pool() {
        let connection = super::super::super::schema::test_database();
        let pin = |pool_id: &str, machine: &str| Pin { pool_id: pool_id.into(), machine: machine.into(), picked_at_ms: 7 };
        save_pin(&connection, &("p1".into(), "arbor-builds".into()), &pin("p1", "cam-mbp")).unwrap();
        save_pin(&connection, &("p1".into(), "arbor-builds".into()), &pin("p1", "lab-box")).unwrap();
        save_pin(&connection, &("p1".into(), "arbor-builds-b".into()), &pin("p2", "cedar-02")).unwrap();
        save_pin(&connection, &("p3".into(), "arbor-docs".into()), &pin("p3", "cam-mbp")).unwrap();
        let saved = read_pins(&connection).unwrap();
        assert_eq!(saved.len(), 3);
        assert_eq!(saved[&("p1".to_string(), "arbor-builds".to_string())], pin("p1", "lab-box"), "a new pick replaces the old");
        delete_pool_pins(&connection, "p2").unwrap();
        let mut left: Vec<String> = read_pins(&connection).unwrap().into_keys().map(|(_, name)| name).collect();
        left.sort();
        assert_eq!(left, ["arbor-builds", "arbor-docs"], "a pin spilled into a removed pool goes with it");
    }

    /// Machines answering now, with the pool's limits in reach of `working` sessions.
    fn state_with(machines: &[&str]) -> MachineHealthState {
        let state = MachineHealthState::default();
        let now = Local::now().timestamp_millis();
        {
            let mut inner = state.lock();
            for machine in machines {
                let host = MachineHost { machine: (*machine).into(), endpoint: (*machine).into(), port: 22, enabled: true, source: String::new() };
                let mut series = MachineSeries::new(host, false);
                series.last_ok_at = Some(now);
                inner.series.insert((*machine).into(), series);
            }
            inner.working_sessions = Some(BTreeMap::new());
        }
        state
    }

    fn key(name: &str) -> PinKey {
        ("p1".into(), name.into())
    }

    fn take(state: &MachineHealthState, pools: &[MachinePool], pins: &mut Pins, name: &str, ready: &dyn Fn(&str) -> bool) -> Result<(String, Option<Pin>), String> {
        take_pin(&state.lock(), pools, pins, &key(name), ready).map(|(machine, picked)| (machine.name().to_string(), picked))
    }

    // Picks count as runs just sent, in memory every test shares, so each test has machines of its own.
    #[test]
    fn a_host_name_stays_on_its_member_even_when_it_gets_busy() {
        let state = state_with(&["pin-mbp", "pin-mini"]);
        let mut builds = pool("p1", "Builds", &["pin-mbp", "pin-mini"]);
        builds.max_agents = Some(2);
        let pools = [builds];
        let mut pins = Pins::default();
        let (first, picked) = take(&state, &pools, &mut pins, "arbor-builds", &|_| true).unwrap();
        assert_eq!(picked.map(|pin| pin.machine), Some(normalize_machine_name(&first)), "a fresh pick is given back to be saved");
        state.lock().working_sessions = Some(BTreeMap::from([(normalize_machine_name(&first), 5)]));
        for _ in 0..5 {
            let (again, picked) = take(&state, &pools, &mut pins, "arbor-builds", &|_| true).unwrap();
            assert_eq!(again, first, "a full member keeps the connections it has");
            assert_eq!(picked, None, "nothing new to save");
        }
        assert_eq!(pins.open[&key("arbor-builds")], 6);
        let (other, _) = take(&state, &pools, &mut pins, "arbor-builds-b", &|_| true).unwrap();
        assert_ne!(other, first, "a new host name goes to a member with room");
    }

    #[test]
    fn a_pin_survives_a_restart_and_an_old_reading_but_not_a_failed_check() {
        let state = state_with(&["drop-mbp", "drop-mini"]);
        let pools = [pool("p1", "Builds", &["drop-mbp", "drop-mini"])];
        // As Arbor finds it after a restart: the pin saved, nothing open.
        let mut pins = Pins { loaded: true, saved: HashMap::from([(key("arbor-builds"), Pin { pool_id: "p1".into(), machine: "dropmini".into(), picked_at_ms: 1 })]), open: HashMap::new() };
        state.lock().series.get_mut("drop-mini").unwrap().last_ok_at = Some(1);
        assert_eq!(take(&state, &pools, &mut pins, "arbor-builds", &|_| true).unwrap(), ("drop-mini".to_string(), None), "an old reading keeps it");
        state.lock().series.get_mut("drop-mini").unwrap().error = Some("timed out".into());
        let (next, picked) = take(&state, &pools, &mut pins, "arbor-builds", &|_| true).unwrap();
        assert_eq!(next, "drop-mbp");
        assert_eq!(picked.map(|pin| pin.machine), Some("dropmbp".to_string()), "the new member is saved in its place");
        {
            let mut inner = state.lock();
            let mini = inner.series.get_mut("drop-mini").unwrap();
            mini.error = None;
            mini.last_ok_at = Some(Local::now().timestamp_millis());
        }
        let (back, _) = take(&state, &pools, &mut pins, "arbor-builds", &|machine| machine != "drop-mbp").unwrap();
        assert_eq!(back, "drop-mini", "a member no longer ready for SSH loses it too");
    }

    #[test]
    fn a_pin_waits_for_arbor_to_load_its_machines() {
        let state = MachineHealthState::default();
        let pools = [pool("p1", "Builds", &["load-mbp"])];
        let mut pins = Pins { loaded: true, saved: HashMap::from([(key("arbor-builds"), Pin { pool_id: "p1".into(), machine: "loadmbp".into(), picked_at_ms: 1 })]), open: HashMap::new() };
        let error = take(&state, &pools, &mut pins, "arbor-builds", &|_| true).unwrap_err();
        assert!(error.contains("still loading"), "{error}");
        assert_eq!(pins.saved[&key("arbor-builds")].machine, "loadmbp", "and isn't moved meanwhile");
    }

    #[test]
    fn a_full_pool_spills_or_refuses_and_never_picks_a_member_not_ready() {
        let state = state_with(&["spill-mbp", "spill-mini"]);
        let mut builds = pool("p1", "Builds", &["spill-mbp"]);
        let overflow = pool("p2", "Overflow", &["spill-mini"]);
        let not_mbp = |machine: &str| machine != "spill-mbp";
        let refused = take(&state, &[builds.clone(), overflow.clone()], &mut Pins::default(), "arbor-builds", &not_mbp).unwrap_err();
        assert!(refused.contains("ready for SSH"), "{refused}");
        builds.when_full = PoolWhenFull::Queue;
        assert!(take(&state, &[builds.clone(), overflow.clone()], &mut Pins::default(), "arbor-builds", &not_mbp).is_err(), "ssh can't wait in a queue");
        builds.when_full = PoolWhenFull::Spill;
        builds.spill_pool = Some("p2".into());
        let mut pins = Pins::default();
        let (spilled, _) = take(&state, &[builds, overflow], &mut pins, "arbor-builds", &not_mbp).unwrap();
        assert_eq!(spilled, "spill-mini");
        assert_eq!(pins.saved[&key("arbor-builds")].pool_id, "p2", "the pin is held against the pool it came from");
    }

    #[test]
    fn a_proxied_member_is_reached_through_ssh_and_the_rest_directly() {
        let host = MachineHost { machine: "cam-mbp".into(), endpoint: " cam-mbp ".into(), port: 22, enabled: true, source: String::new() };
        let mut found = parse_ssh_settings(SSH_G).unwrap();
        assert_eq!(target_for("cam-mbp", &host, &found), ConnectTarget::Direct { machine: "cam-mbp".into(), host: "cam-mbp.tail1234.ts.net".into(), port: 22 });
        found.proxied = true;
        assert_eq!(target_for("cam-mbp", &host, &found), ConnectTarget::Via { machine: "cam-mbp".into(), endpoint: "cam-mbp".into(), port: 22 });
    }

    #[test]
    fn the_include_goes_on_top_once() {
        assert!(includes_pools("Host *\n  ForwardAgent no\ninclude   ~/.arbor/ssh/pools.conf\n"));
        assert!(!includes_pools("Host arbor\n  HostName arbor.example\n"));
        assert_eq!(with_include(None), b"# Machine pools from Arbor\nInclude ~/.arbor/ssh/pools.conf\n");
        let added = String::from_utf8(with_include(Some(b"Host cam-mbp\n  User cam\n".as_slice()))).unwrap();
        assert_eq!(added, "# Machine pools from Arbor\nInclude ~/.arbor/ssh/pools.conf\n\nHost cam-mbp\n  User cam\n");
        assert!(includes_pools(&added));
    }

    #[test]
    fn arbors_files_are_private_and_only_rewritten_when_they_change() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::cli::test_dir("poolssh");
        let path = dir.join("ssh").join("pools.conf");
        assert!(write_private(&path, "one\n").unwrap());
        assert!(!write_private(&path, "one\n").unwrap());
        assert!(write_private(&path, "two\n").unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two\n");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    }
}

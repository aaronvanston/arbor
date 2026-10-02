//! Pools as SSH hosts. `ssh arbor-<pool>` reaches one of the pool's members: Arbor's own SSH config gives each pool a
//! host whose ProxyCommand is `arbor pools connect`, which asks the app for a member and carries the connection to its
//! sshd. Any app that connects to SSH hosts (an editor, an agent app, plain ssh) can open a pool that way unchanged.
//!
//! A pick is per connection, and sticky: every connection under one host name goes to the same member while any is
//! open and for LEASE_GRACE_MS after the last closes, since apps open several (a control connection, file sync,
//! forwarded ports) and they all have to land on one machine. A member getting busy never moves a lease, which would
//! split one workspace across machines; only one that's off, gone or not answering is replaced, on the next
//! connection. Each name is its own lease (`arbor-builds`, `arbor-builds-b`), so two workspaces can spread out.
//!
//! Host keys are only ever ones the person's own known_hosts already trusts for a member. Arbor copies them under one
//! alias into a file of its own, so ssh accepts whichever member answers, and never scans for new ones. A member
//! without a saved key, or reached as another user than the pool's, isn't picked.
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
/// How long a host name keeps its member after its last connection closes, so an app reconnecting lands back on it.
const LEASE_GRACE_MS: i64 = 10 * 60_000;
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
// Leases
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
struct Lease {
    /// The pool the member was picked from: the one asked for, or one it spilled into.
    pool_id: String,
    /// The member, by normalized name.
    machine: String,
    open: u32,
    last_closed_ms: Option<i64>,
}

/// Leases by the pool asked for and the host name it was asked under.
type Leases = HashMap<(String, String), Lease>;

fn leases() -> &'static StdMutex<Leases> {
    static LEASES: OnceLock<StdMutex<Leases>> = OnceLock::new();
    LEASES.get_or_init(Default::default)
}

fn lock_leases() -> std::sync::MutexGuard<'static, Leases> {
    leases().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn prune(leases: &mut Leases, now_ms: i64) {
    leases.retain(|_, lease| lease.open > 0 || lease.last_closed_ms.is_none_or(|closed| now_ms - closed < LEASE_GRACE_MS));
}

/// Whether a member keeps its lease: only one the pool can't reach any more loses it. Being busy never does.
fn keeps_lease(kind: VerdictKind) -> bool {
    !matches!(kind, VerdictKind::NotListed | VerdictKind::Off | VerdictKind::Unreachable | VerdictKind::Stale)
}

fn lease_holds(inner: &Inner, pools_saved: &[MachinePool], lease: &Lease, ready: &dyn Fn(&str) -> bool) -> bool {
    let Some(pool) = pools_saved.iter().find(|pool| pool.id == lease.pool_id) else { return false };
    let now_ms = Local::now().timestamp_millis();
    pools::assess_with(pool, &pools::readings(inner), &BTreeMap::new(), now_ms, inner.interval_ms, |_| true)
        .iter()
        .find(|verdict| normalize_machine_name(verdict.machine()) == lease.machine)
        .is_some_and(|verdict| keeps_lease(verdict.kind()) && ready(verdict.machine()))
}

/// The member a connection under `key` (the pool asked for, the host name) goes to, counted as open on its lease: the
/// lease's member while it holds, otherwise a fresh pick.
fn take_lease(inner: &Inner, pools_saved: &[MachinePool], leases: &mut Leases, key: &(String, String), ready: &dyn Fn(&str) -> bool) -> Result<Machine, String> {
    prune(leases, Local::now().timestamp_millis());
    let kept = leases.get(key).filter(|lease| lease_holds(inner, pools_saved, lease, ready)).and_then(|lease| runs::machine_named(inner, &lease.machine));
    let machine = match kept {
        Some(machine) => machine,
        None => {
            let (from, machine) = runs::pick_for_connection(inner, pools_saved, &key.0, ready)?;
            leases.insert(key.clone(), Lease { pool_id: from, machine: normalize_machine_name(machine.name()), open: 0, last_closed_ms: None });
            machine
        }
    };
    if let Some(lease) = leases.get_mut(key) {
        lease.open += 1;
    }
    Ok(machine)
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

/// Holds a connection's place on its lease; dropping it, when the connection ends, starts the lease's grace.
pub(crate) struct LeaseHold {
    key: (String, String),
    app: tauri::AppHandle,
}

impl Drop for LeaseHold {
    fn drop(&mut self) {
        if let Some(lease) = lock_leases().get_mut(&self.key) {
            lease.open = lease.open.saturating_sub(1);
            if lease.open == 0 {
                lease.last_closed_ms = Some(Local::now().timestamp_millis());
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

/// Picks the member a connection to a pool under host name `name` goes to, keeping the one it went to last time
/// while that one can still be reached, and holds its place until the connection ends.
pub(crate) async fn open_connection(app: &tauri::AppHandle, pool: &str, name: &str) -> Result<(ConnectTarget, LeaseHold), String> {
    let (pools_saved, resolved) = current(app).await?;
    let pool = find_pool(&pools_saved, pool).ok_or_else(|| format!("Arbor has no pool called {pool}."))?;
    let user = pool_user(pool, &resolved);
    let ready = |machine: &str| readiness(resolved.get(&normalize_machine_name(machine)), user.as_deref()) == Readiness::Ready;
    // A token the app running ssh left unexpanded is taken as no name: the pool's own host.
    let name = match name.trim() {
        "" => host_names(&pools_saved).get(&pool.id).cloned().unwrap_or_default(),
        typed if typed.starts_with('%') => host_names(&pools_saved).get(&pool.id).cloned().unwrap_or_default(),
        typed => typed.to_ascii_lowercase(),
    };
    let key = (pool.id.clone(), name);
    let (machine, host) = {
        let state = app.state::<MachineHealthState>();
        let machine = take_lease(&state.lock(), &pools_saved, &mut lock_leases(), &key, &ready)?;
        (machine.name().to_string(), machine.host().clone())
    };
    let hold = LeaseHold { key, app: app.clone() };
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

/// A host name connected to the pool lately, and the member it goes to.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PoolSshConnection {
    name: String,
    machine: String,
    /// Connections open now.
    open: u32,
    /// When the last one closed, while none is open; it keeps its member until LEASE_GRACE_MS after.
    #[ts(type = "number | null")]
    idle_since_ms: Option<i64>,
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
/// and which host names are on which member now.
#[tauri::command]
pub(crate) async fn get_pool_ssh(app: tauri::AppHandle, pool_id: String) -> Result<PoolSsh, String> {
    let (pools_saved, resolved) = current(&app).await?;
    let pool = pools_saved.iter().find(|pool| pool.id == pool_id).ok_or("That pool was removed")?;
    let user = pool_user(pool, &resolved);
    let members = pool
        .members
        .iter()
        .map(|member| PoolSshMember {
            machine: member.machine.clone(),
            readiness: readiness(resolved.get(&normalize_machine_name(&member.machine)), user.as_deref()),
        })
        .collect();
    let display: BTreeMap<String, String> = app
        .state::<MachineHealthState>()
        .lock()
        .series
        .values()
        .map(|series| (normalize_machine_name(&series.host.machine), series.host.machine.clone()))
        .collect();
    let mut connections: Vec<PoolSshConnection> = {
        let mut leases = lock_leases();
        prune(&mut leases, Local::now().timestamp_millis());
        leases
            .iter()
            .filter(|((pool, _), _)| *pool == pool_id)
            .map(|((_, name), lease)| PoolSshConnection {
                name: name.clone(),
                machine: display.get(&lease.machine).cloned().unwrap_or_else(|| lease.machine.clone()),
                open: lease.open,
                idle_since_ms: if lease.open == 0 { lease.last_closed_ms } else { None },
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

/// Adds the line that brings Arbor's pool hosts into ~/.ssh/config, backed up so Sync › Arbor's changes can undo it.
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

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::pools::{PoolMember, PoolWeight, PoolWhenFull};

    const SSH_G: &str = "host casey-mbp\nhostname casey-mbp.tail1234.ts.net\nport 22\nuser casey\nproxyjump none\n\
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
        assert_eq!(parsed.hostname, "casey-mbp.tail1234.ts.net");
        assert_eq!(parsed.user, "casey");
        assert!(!parsed.proxied);
        assert_eq!(parsed.known_hosts_files, ["~/.ssh/known_hosts", "~/.ssh/known_hosts2", "/etc/ssh/ssh_known_hosts"]);
        assert_eq!(parsed.identity_files, ["~/.ssh/id_ed25519", "~/.ssh/id_rsa"]);
        assert_eq!(parsed.identity_agent, None, "ssh's default agent isn't copied");
        let jumped = parse_ssh_settings(&SSH_G.replace("proxyjump none", "proxyjump bastion")).unwrap();
        assert!(jumped.proxied);
        assert!(parse_ssh_settings("hostname -oProxyCommand=x\nuser casey\n").is_none(), "a host that reads as a flag is refused");
    }

    #[test]
    fn keys_are_looked_up_the_way_ssh_saves_them() {
        let mut found = parse_ssh_settings(SSH_G).unwrap();
        assert_eq!(key_names(&found, "casey@casey-mbp"), ["casey-mbp.tail1234.ts.net", "casey-mbp"]);
        found.port = 2222;
        assert_eq!(key_names(&found, "casey-mbp"), ["[casey-mbp.tail1234.ts.net]:2222", "[casey-mbp]:2222"]);
        found.host_key_alias = Some("mbp".into());
        assert_eq!(key_names(&found, "casey-mbp"), ["[mbp]:2222"]);
    }

    #[test]
    fn found_keys_keep_type_and_key_and_skip_revoked_ones() {
        let output = "# Host casey-mbp found: line 4\n|1|abc=|def= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB comment\n\
                      @revoked casey-mbp ssh-rsa AAAAB3Nza\n@cert-authority * ssh-ed25519 AAAAC3Nz\ncasey-mbp ssh-rsa AAAA;rm\n";
        assert_eq!(parse_found_keys(output), ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB"]);
    }

    #[test]
    fn a_member_is_ready_with_a_saved_key_and_the_pools_user() {
        assert_eq!(readiness(None, Some("casey")), Readiness::NoAddress);
        assert_eq!(readiness(Some(&MemberSsh::default()), Some("casey")), Readiness::NoAddress);
        assert_eq!(readiness(Some(&member("casey", &[])), Some("casey")), Readiness::NoHostKey);
        assert_eq!(readiness(Some(&member("casey", &["ssh-ed25519 AAAA"])), Some("ops")), Readiness::OtherUser);
        assert_eq!(readiness(Some(&member("casey", &["ssh-ed25519 AAAA"])), Some("casey")), Readiness::Ready);
    }

    #[test]
    fn the_pools_user_is_the_one_most_members_use() {
        let resolved = BTreeMap::from([
            ("a".to_string(), member("ops", &["k1"])),
            ("b".to_string(), member("casey", &["k2"])),
            ("c".to_string(), member("casey", &["k3"])),
            ("d".to_string(), member("root", &[])),
        ]);
        assert_eq!(pool_user(&pool("p", "Builds", &["a", "b", "c", "d"]), &resolved).as_deref(), Some("casey"));
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
        let resolved = BTreeMap::from([("a".to_string(), member("casey", &["ssh-ed25519 AAAA"])), ("b".to_string(), member("casey", &["ssh-rsa BBBB"]))]);
        let pools = [pool("p1", "Builds", &["a"]), pool("p2", "Builds 2", &["a", "b"]), pool("p3", "Empty", &[])];
        let config = render_config(&host_blocks(&pools, &resolved), Some("/Users/casey/.local/bin/arbor"));
        assert!(config.contains("\nHost arbor-builds arbor-builds-*\n  ProxyCommand \"/Users/casey/.local/bin/arbor\" pools connect p1 %h\n"), "{config}");
        assert!(config.find("Host arbor-builds-2").unwrap() < config.find("Host arbor-builds ").unwrap(), "the longer name matches first");
        assert!(config.contains("  HostKeyAlias arbor-pools\n  UserKnownHostsFile ~/.arbor/ssh/pools_known_hosts\n  StrictHostKeyChecking yes\n"));
        assert!(config.contains("  User casey\n"));
        assert!(!config.contains("arbor-empty"), "a pool with no members gets no host");
        let without = render_config(&host_blocks(&pools, &resolved), None);
        assert!(!without.contains("Host "), "nothing to run without the arbor command");
        let known = render_known_hosts(&resolved);
        assert!(known.ends_with("arbor-pools ssh-ed25519 AAAA\narbor-pools ssh-rsa BBBB\n"), "{known}");
    }

    #[test]
    fn only_a_member_that_can_no_longer_be_reached_loses_its_lease() {
        for kind in [VerdictKind::Eligible, VerdictKind::AgentsFull, VerdictKind::CpuHigh, VerdictKind::MemoryLow, VerdictKind::NoReading] {
            assert!(keeps_lease(kind), "{kind:?}");
        }
        for kind in [VerdictKind::NotListed, VerdictKind::Off, VerdictKind::Unreachable, VerdictKind::Stale] {
            assert!(!keeps_lease(kind), "{kind:?}");
        }
    }

    #[test]
    fn a_lease_is_kept_while_open_and_for_its_grace_after() {
        let lease = |open, last_closed_ms| Lease { pool_id: "p".into(), machine: "a".into(), open, last_closed_ms };
        let mut held: Leases = HashMap::from([
            (("p".into(), "open".into()), lease(2, Some(0))),
            (("p".into(), "recent".into()), lease(0, Some(1_000_000 - LEASE_GRACE_MS + 1))),
            (("p".into(), "old".into()), lease(0, Some(1_000_000 - LEASE_GRACE_MS))),
        ]);
        prune(&mut held, 1_000_000);
        let mut kept: Vec<&str> = held.keys().map(|(_, name)| name.as_str()).collect();
        kept.sort();
        assert_eq!(kept, ["open", "recent"]);
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

    fn key(name: &str) -> (String, String) {
        ("p1".into(), name.into())
    }

    // Picks count as runs just sent, in memory every test shares, so each test has machines of its own.
    #[test]
    fn a_host_name_stays_on_its_member_even_when_it_gets_busy() {
        let state = state_with(&["lease-mbp", "lease-mini"]);
        let mut builds = pool("p1", "Builds", &["lease-mbp", "lease-mini"]);
        builds.max_agents = Some(2);
        let pools = [builds];
        let mut leases = Leases::new();
        let first = take_lease(&state.lock(), &pools, &mut leases, &key("arbor-builds"), &|_| true).unwrap().name().to_string();
        state.lock().working_sessions = Some(BTreeMap::from([(normalize_machine_name(&first), 5)]));
        for _ in 0..5 {
            let again = take_lease(&state.lock(), &pools, &mut leases, &key("arbor-builds"), &|_| true).unwrap();
            assert_eq!(again.name(), first, "a full member keeps the connections it has");
        }
        assert_eq!(leases[&key("arbor-builds")].open, 6);
        let other = take_lease(&state.lock(), &pools, &mut leases, &key("arbor-builds-b"), &|_| true).unwrap();
        assert_ne!(other.name(), first, "a new host name goes to a member with room");
    }

    #[test]
    fn a_member_that_stops_answering_is_replaced_on_the_next_connection() {
        let state = state_with(&["drop-mbp", "drop-mini"]);
        let pools = [pool("p1", "Builds", &["drop-mbp", "drop-mini"])];
        let mut leases = Leases::new();
        let first = take_lease(&state.lock(), &pools, &mut leases, &key("arbor-builds"), &|_| true).unwrap().name().to_string();
        state.lock().series.get_mut(&first).unwrap().error = Some("timed out".into());
        let next = take_lease(&state.lock(), &pools, &mut leases, &key("arbor-builds"), &|_| true).unwrap();
        assert_ne!(next.name(), first);
        assert_eq!(leases[&key("arbor-builds")].open, 1, "the new lease counts only its own connection");
    }

    #[test]
    fn a_full_pool_spills_or_refuses_and_never_picks_a_member_not_ready() {
        let state = state_with(&["spill-mbp", "spill-mini"]);
        let mut builds = pool("p1", "Builds", &["spill-mbp"]);
        let overflow = pool("p2", "Overflow", &["spill-mini"]);
        let not_mbp = |machine: &str| machine != "spill-mbp";
        let refused = take_lease(&state.lock(), &[builds.clone(), overflow.clone()], &mut Leases::new(), &key("arbor-builds"), &not_mbp).unwrap_err();
        assert!(refused.contains("ready for SSH"), "{refused}");
        builds.when_full = PoolWhenFull::Queue;
        assert!(take_lease(&state.lock(), &[builds.clone(), overflow.clone()], &mut Leases::new(), &key("arbor-builds"), &not_mbp).is_err(), "ssh can't wait in a queue");
        builds.when_full = PoolWhenFull::Spill;
        builds.spill_pool = Some("p2".into());
        let mut leases = Leases::new();
        let spilled = take_lease(&state.lock(), &[builds, overflow], &mut leases, &key("arbor-builds"), &not_mbp).unwrap();
        assert_eq!(spilled.name(), "spill-mini");
        assert_eq!(leases[&key("arbor-builds")].pool_id, "p2", "the lease is held against the pool it came from");
    }

    #[test]
    fn a_proxied_member_is_reached_through_ssh_and_the_rest_directly() {
        let host = MachineHost { machine: "casey-mbp".into(), endpoint: " casey-mbp ".into(), port: 22, enabled: true, source: String::new() };
        let mut found = parse_ssh_settings(SSH_G).unwrap();
        assert_eq!(target_for("casey-mbp", &host, &found), ConnectTarget::Direct { machine: "casey-mbp".into(), host: "casey-mbp.tail1234.ts.net".into(), port: 22 });
        found.proxied = true;
        assert_eq!(target_for("casey-mbp", &host, &found), ConnectTarget::Via { machine: "casey-mbp".into(), endpoint: "casey-mbp".into(), port: 22 });
    }

    #[test]
    fn the_include_goes_on_top_once() {
        assert!(includes_pools("Host *\n  ForwardAgent no\ninclude   ~/.arbor/ssh/pools.conf\n"));
        assert!(!includes_pools("Host arbor\n  HostName arbor.example\n"));
        assert_eq!(with_include(None), b"# Machine pools from Arbor\nInclude ~/.arbor/ssh/pools.conf\n");
        let added = String::from_utf8(with_include(Some(b"Host casey-mbp\n  User casey\n".as_slice()))).unwrap();
        assert_eq!(added, "# Machine pools from Arbor\nInclude ~/.arbor/ssh/pools.conf\n\nHost casey-mbp\n  User casey\n");
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

//! Machines' SSH host keys. Every run to a machine checks its host key strictly and never takes a new one on its own:
//! accepting the first key that answers would hand scripts, setup files and keys to whatever sat on the path the first
//! time. A key is trusted when the user's own known_hosts (or the system's) already has it, or when the user compared its
//! fingerprint on the Machines page and trusted it there.
//!
//! The keys trusted from Arbor live in a file of its own, `~/.arbor/ssh/machines_known_hosts`, which runs add as an
//! extra global known-hosts file. That leaves the user's UserKnownHostsFile setting and their known_hosts alone, and
//! with strict checking ssh never writes to any of them. The file has a block per machine, so removing the machine
//! drops its keys.
//!
//! Trusting is two steps. The scan connects once with a known-hosts file of its own, so ssh records whatever key the
//! machine offers there before it signs in (whether signing in works doesn't matter); only fingerprints go to the
//! window, and the lines wait here. Trust writes them only when the window sends back the fingerprints the user saw.

use super::pool_ssh::{home_dir, write_private_with_mode, SSH_DIR};
use super::shell::{configure_helper_command, failure_detail, find_machine, run_in_slot, shell_quote, ssh_sharing_options, Machine};
use super::{MachineHealthState, MachineHost};
use crate::command_error::CommandError;
use crate::usage::diagnostics::MachineOp;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use ts_rs::TS;

const KNOWN_HOSTS_FILE: &str = "machines_known_hosts";
/// ssh's own global files, which a GlobalKnownHostsFile option would otherwise replace.
const SYSTEM_KNOWN_HOSTS: [&str; 2] = ["/etc/ssh/ssh_known_hosts", "/etc/ssh/ssh_known_hosts2"];
/// The script Grove's runs go through (see `grove_ssh_command`).
const GROVE_SSH_FILE: &str = "grove-ssh";
/// What starts each machine's block in Arbor's file.
const MACHINE_MARK: &str = "# machine ";
const FILE_HEADER: &str = "# Host keys Arbor trusts for its machines, each added when you compared its fingerprint and trusted it.\n\
# ssh reads this file beside your own known_hosts. Arbor rewrites it, so changes here may be replaced.\n";
/// How long a scanned key waits to be trusted.
const HELD_FOR: Duration = Duration::from_secs(15 * 60);
const SCAN_TIMEOUT: Duration = Duration::from_secs(20);
const HELPER_TIMEOUT: Duration = Duration::from_secs(5);

/// ssh's last line when a host key doesn't verify, whether the machine's key is unknown or has changed.
pub(super) const HOST_KEY_FAILED: &str = "Host key verification failed.";

// ---------------------------------------------------------------------------
// The options every run passes
// ---------------------------------------------------------------------------

/// Arbor's own known-hosts file for machines, on this Mac.
pub(super) fn known_hosts_path() -> Option<PathBuf> {
    home_dir().map(|home| known_hosts_path_in(&home))
}

fn known_hosts_path_in(home: &Path) -> PathBuf {
    home.join(SSH_DIR).join(KNOWN_HOSTS_FILE)
}

/// One file in an ssh option that lists several: ssh splits the value at whitespace and reads a double-quoted word as
/// one, with a backslash before a quote or backslash inside it.
fn option_word(path: &str) -> String {
    if path.contains(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '\\') {
        format!("\"{}\"", path.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        path.to_string()
    }
}

/// ssh's global files and Arbor's after them. Global rather than the user's, so their own setting and file stay theirs.
fn global_known_hosts(arbor: Option<&Path>) -> String {
    let mut files: Vec<String> = SYSTEM_KNOWN_HOSTS.iter().map(|file| (*file).to_string()).collect();
    files.extend(arbor.map(|path| option_word(&path.to_string_lossy())));
    format!("GlobalKnownHostsFile={}", files.join(" "))
}

fn strict_options_with(arbor: Option<&Path>) -> Vec<String> {
    vec!["-o".into(), "StrictHostKeyChecking=yes".into(), "-o".into(), global_known_hosts(arbor)]
}

/// The host-key options for every run to a machine: strict checking, and Arbor's trusted keys read beside the user's.
/// On the command line they come before anything a config file says, as ssh keeps the first value it reads.
pub(crate) fn strict_options() -> Vec<String> {
    strict_options_with(known_hosts_path().as_deref())
}

/// `GIT_SSH_COMMAND` for git run on this Mac against a machine, which git runs through a shell.
pub(super) fn git_ssh_command() -> String {
    git_ssh_command_with(known_hosts_path().as_deref())
}

fn git_ssh_command_with(arbor: Option<&Path>) -> String {
    let strict: Vec<String> = strict_options_with(arbor).iter().map(|word| shell_quote(word)).collect();
    format!("ssh -o BatchMode=yes -o ConnectTimeout=10 {} -o ServerAliveInterval=15", strict.join(" "))
}

/// `GROVE_SSH_COMMAND`: Grove splits it at whitespace and puts the words before its own options. The known-hosts
/// option can't be written without spaces, so it names a small script of Arbor's that runs ssh with Arbor's options in
/// front. Where the script's own path has a space, Grove gets strict checking alone, and the connection sharing when that
/// fits; it never falls back to accepting a new key, which is Grove's own default.
pub(super) fn grove_ssh_command() -> String {
    static SCRIPT: OnceLock<Option<String>> = OnceLock::new();
    let script = SCRIPT.get_or_init(|| {
        // Tests run Grove stand-ins, and never write in the real home folder.
        if cfg!(test) {
            return None;
        }
        let home = home_dir()?;
        let path = home.join(SSH_DIR).join(GROVE_SSH_FILE);
        let path_text = path.to_str()?.to_string();
        (!path_text.contains(char::is_whitespace)).then_some(path_text)
    });
    if let Some(path) = script {
        let text = grove_ssh_script(&strict_options(), &ssh_sharing_options());
        // Written each time it's asked for only when it differs, so a script removed while Arbor runs comes back.
        if write_private_with_mode(Path::new(path), &text, 0o700).is_ok() {
            return path.clone();
        }
    }
    let sharing = ssh_sharing_options();
    let mut words = vec!["ssh".to_string(), "-o".into(), "StrictHostKeyChecking=yes".into()];
    if !sharing.iter().any(|word| word.contains(char::is_whitespace)) {
        words.extend(sharing);
    }
    words.join(" ")
}

fn grove_ssh_script(strict: &[String], sharing: &[String]) -> String {
    let words: Vec<String> = strict.iter().chain(sharing).map(|word| shell_quote(word)).collect();
    format!("#!/bin/sh\n# Written by Arbor: how Grove's runs reach your machines. Arbor rewrites it.\nexec ssh {} \"$@\"\n", words.join(" "))
}

// ---------------------------------------------------------------------------
// What ssh said
// ---------------------------------------------------------------------------

/// ssh's line saying why a host key didn't verify, which comes just before `HOST_KEY_FAILED`: no key is known for the
/// host, or the one known has changed.
pub(super) fn is_host_key_cause(line: &str) -> bool {
    (line.starts_with("No ") && line.contains(" host key is known for ")) || (line.starts_with("Host key for ") && line.contains(" has changed"))
}

/// A failure that only says a host key didn't verify, as Grove gives it (it keeps ssh's last line), so Arbor asks ssh
/// itself which it was.
pub(super) fn is_bare_host_key_failure(error: &str) -> bool {
    error.trim() == HOST_KEY_FAILED
}

fn says_key_changed(stderr: &str) -> bool {
    stderr.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") || stderr.lines().any(|line| line.trim().starts_with("Host key for ") && line.contains(" has changed"))
}

/// Fingerprints from `ssh-keygen -l -E sha256 -f`, as the key's type and its SHA-256 fingerprint ("ED25519 SHA256:…"),
/// each once. The host names on the lines, and anything else, are left out.
fn parse_fingerprints(text: &str) -> Vec<String> {
    let mut found: Vec<String> = text
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let fingerprint = *fields.get(1)?;
            let digest = fingerprint.strip_prefix("SHA256:")?;
            let kind = fields.last()?.strip_prefix('(')?.strip_suffix(')')?;
            let plain = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'@'));
            let base64 = !digest.is_empty() && digest.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='));
            (plain(kind) && base64).then(|| format!("{kind} {fingerprint}"))
        })
        .collect();
    found.sort();
    found.dedup();
    found
}

/// The known_hosts lines ssh wrote: a host and a key on each, never a marker or a comment.
fn known_host_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with('@') && line.split_whitespace().count() >= 3)
        .map(str::to_string)
        .collect()
}

/// The user's own known-hosts files for a host, from `ssh -G`, so the scan reads them too and a key they already have
/// isn't offered again (or a changed one offered as new).
fn user_known_hosts(config: &str) -> Vec<String> {
    config
        .lines()
        .find_map(|line| line.trim().strip_prefix("userknownhostsfile "))
        .map(|value| value.split_whitespace().map(str::to_string).collect())
        .unwrap_or_else(|| vec!["~/.ssh/known_hosts".into(), "~/.ssh/known_hosts2".into()])
}

// ---------------------------------------------------------------------------
// Arbor's file
// ---------------------------------------------------------------------------

/// A machine's name as its block's mark, on one line.
fn mark_name(machine: &str) -> String {
    machine.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().to_string()
}

/// Arbor's file without the blocks of `machines`, and with `add`'s block last when given.
fn rewrite(current: &str, machines: &[&str], add: Option<(&str, &[String])>) -> String {
    let dropped: Vec<String> = machines.iter().map(|machine| mark_name(machine)).collect();
    let mut text = String::from(FILE_HEADER);
    let mut keeping = false;
    for line in current.lines() {
        if let Some(name) = line.strip_prefix(MACHINE_MARK) {
            keeping = !dropped.iter().any(|dropped| dropped == name.trim());
            if keeping {
                text.push_str(line);
                text.push('\n');
            }
        } else if keeping && !line.trim().is_empty() {
            text.push_str(line);
            text.push('\n');
        }
    }
    if let Some((machine, lines)) = add {
        text.push_str(MACHINE_MARK);
        text.push_str(&mark_name(machine));
        text.push('\n');
        for line in lines {
            text.push_str(line);
            text.push('\n');
        }
    }
    text
}

fn file_lock() -> &'static StdMutex<()> {
    static LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
    LOCK.get_or_init(Default::default)
}

fn change_file(path: &Path, machines: &[&str], add: Option<(&str, &[String])>) -> Result<(), String> {
    let _held = file_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let current = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if add.is_none() {
                return Ok(());
            }
            String::new()
        }
        Err(error) => return Err(format!("Couldn't read {}: {error}", path.display())),
    };
    write_private_with_mode(path, &rewrite(&current, machines, add), 0o600).map(|_| ())
}

/// Drops the keys trusted for machines taken off the list. Undoing the removal brings the machine back without them, and
/// its card offers Connect again.
pub(super) fn forget_machines(machines: &[String]) {
    let Some(path) = known_hosts_path() else { return };
    let names: Vec<&str> = machines.iter().map(String::as_str).collect();
    if let Err(error) = change_file(&path, &names, None) {
        eprintln!("Couldn't drop removed machines' host keys: {error}");
    }
}

// ---------------------------------------------------------------------------
// Scanning and trusting
// ---------------------------------------------------------------------------

/// A scanned key waiting for the user: the lines ssh wrote and their fingerprints, and where it was read from.
#[derive(Clone, Debug)]
struct Held {
    endpoint: String,
    port: u16,
    lines: Vec<String>,
    fingerprints: Vec<String>,
    at: Instant,
}

fn held() -> &'static StdMutex<HashMap<String, Held>> {
    static HELD: OnceLock<StdMutex<HashMap<String, Held>>> = OnceLock::new();
    HELD.get_or_init(Default::default)
}

/// What a machine's host key check found.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineHostKeyScan {
    /// Each key the machine offered, as its type and SHA-256 fingerprint ("ED25519 SHA256:…"); never the key itself.
    fingerprints: Vec<String>,
    /// ssh already trusts the machine's key, so there's nothing to trust.
    already_trusted: bool,
}

/// Why Trust didn't write: nothing scanned for the machine, or not the keys the user saw.
fn not_as_scanned(machine: &str) -> CommandError {
    CommandError::changed(format!("{machine}'s host key isn't the one you checked, so nothing was trusted. Check it again."))
}

/// Puts what a scan found in front of the user, or holds nothing when ssh already trusts the key.
fn read_scan(machine: &str, host: &MachineHost, written: &str, fingerprints: &str, output: &std::process::Output) -> Result<MachineHostKeyScan, CommandError> {
    let lines = known_host_lines(written);
    let mut waiting = held().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    waiting.remove(machine);
    if !lines.is_empty() {
        let fingerprints = parse_fingerprints(fingerprints);
        if fingerprints.is_empty() {
            return Err(CommandError::failed(format!("Arbor couldn't read the fingerprint of {machine}'s host key")));
        }
        waiting.insert(machine.to_string(), Held { endpoint: host.endpoint.trim().to_string(), port: host.port, lines, fingerprints: fingerprints.clone(), at: Instant::now() });
        return Ok(MachineHostKeyScan { fingerprints, already_trusted: false });
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    // A key that verified gets as far as signing in, where a turned-down login still means the key was fine.
    if !says_key_changed(&stderr) && (output.status.success() || stderr.contains("Permission denied")) {
        return Ok(MachineHostKeyScan { fingerprints: Vec::new(), already_trusted: true });
    }
    Err(CommandError::failed(failure_detail(output)))
}

async fn helper_output(program: &str, args: &[&str]) -> Option<String> {
    let mut command = tokio::process::Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    configure_helper_command(&mut command);
    let output = tokio::time::timeout(HELPER_TIMEOUT, command.output()).await.ok()?.ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// A folder of the scan's own for the key ssh writes, private to the user.
fn scan_dir() -> Result<PathBuf, String> {
    use std::os::unix::fs::DirBuilderExt;
    static COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |at| at.as_nanos());
    let count = COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("arbor-host-key-{}-{stamp}-{count}", std::process::id()));
    fs::DirBuilder::new().mode(0o700).create(&dir).map_err(|error| format!("Couldn't make a folder for the scan: {error}"))?;
    Ok(dir)
}

/// The ssh that reads a machine's host key: the user's config as every run has it, the key it offers written to
/// `scanned`, the user's own files read so a key they have isn't new, nothing shared with another connection, and `true`
/// as the only thing it would run.
fn scan_command(host: &MachineHost, scanned: &Path, user_files: &[String]) -> tokio::process::Command {
    let mut files = vec![option_word(&scanned.to_string_lossy())];
    files.extend(user_files.iter().map(|file| option_word(file)));
    let mut command = tokio::process::Command::new("ssh");
    command
        .arg("-p")
        .arg(host.port.to_string())
        .arg("-T")
        .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"])
        .arg("-o")
        .arg(format!("UserKnownHostsFile={}", files.join(" ")))
        .arg("-o")
        .arg(global_known_hosts(known_hosts_path().as_deref()))
        .args(["-o", "CheckHostIP=no", "-o", "UpdateHostKeys=no", "-o", "ControlMaster=no", "-o", "ControlPath=none"])
        .arg("--")
        .arg(host.endpoint.trim())
        .arg("true")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_helper_command(&mut command);
    command
}

async fn scan(machine: &str, target: &Machine) -> Result<MachineHostKeyScan, CommandError> {
    let dir = scan_dir()?;
    let result = scan_into(machine, target.host(), &dir.join("known_hosts")).await;
    let _ = fs::remove_dir_all(&dir);
    result
}

async fn scan_into(machine: &str, host: &MachineHost, scanned: &Path) -> Result<MachineHostKeyScan, CommandError> {
    let port = host.port.to_string();
    let config = helper_output("ssh", &["-G", "-p", &port, "--", host.endpoint.trim()]).await.unwrap_or_default();
    let output = run_in_slot(machine, MachineOp::HostKeyScan, scan_command(host, scanned, &user_known_hosts(&config)), SCAN_TIMEOUT).await?;
    let written = fs::read_to_string(scanned).unwrap_or_default();
    let fingerprints = if written.trim().is_empty() {
        String::new()
    } else {
        let file = scanned.to_string_lossy();
        helper_output("ssh-keygen", &["-l", "-E", "sha256", "-f", &file]).await.unwrap_or_default()
    };
    read_scan(machine, host, &written, &fingerprints, &output)
}

/// Connects to a machine once to read the host key it offers, for the user to compare before trusting it. Nothing is
/// sent but `true`, and only if the machine already lets this Mac sign in; the key is read before that either way.
#[tauri::command]
pub(crate) async fn scan_machine_host_key(state: tauri::State<'_, MachineHealthState>, machine: String) -> Result<MachineHostKeyScan, CommandError> {
    let target = find_machine(&state.lock(), &machine)?;
    if target.is_local() {
        return Err(CommandError::failed(format!("{machine} is this Mac, which Arbor reaches without SSH")));
    }
    scan(&machine, &target).await
}

/// Takes the lines held for `machine` when they're the keys the user saw, from the endpoint the machine still has.
fn take_held(machine: &str, host: &MachineHost, fingerprints: &[String]) -> Result<Vec<String>, CommandError> {
    let held = held().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(machine).ok_or_else(|| not_as_scanned(machine))?;
    let mut seen = fingerprints.to_vec();
    seen.sort();
    seen.dedup();
    let same_place = held.endpoint == host.endpoint.trim() && held.port == host.port;
    if seen != held.fingerprints || !same_place || held.at.elapsed() > HELD_FOR {
        return Err(not_as_scanned(machine));
    }
    Ok(held.lines)
}

fn trust_into(path: &Path, machine: &str, host: &MachineHost, fingerprints: &[String]) -> Result<(), CommandError> {
    let lines = take_held(machine, host, fingerprints)?;
    change_file(path, &[machine], Some((machine, &lines))).map_err(CommandError::failed)
}

/// Trusts the host key a scan found for `machine`, when `fingerprints` are the ones it found (what the user compared
/// is what gets trusted), and checks the machine again.
#[tauri::command]
pub(crate) async fn trust_machine_host_key(state: tauri::State<'_, MachineHealthState>, machine: String, fingerprints: Vec<String>) -> Result<(), CommandError> {
    let target = find_machine(&state.lock(), &machine)?;
    let path = known_hosts_path().ok_or_else(|| CommandError::failed("Arbor couldn't find your home folder"))?;
    trust_into(&path, &machine, target.host(), &fingerprints)?;
    state.request_reload();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn host(endpoint: &str) -> MachineHost {
        MachineHost { machine: "cam-mbp".into(), endpoint: endpoint.into(), port: 22, enabled: true, source: String::new() }
    }

    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("arbor-host-keys-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn output(code: i32, stderr: &str) -> std::process::Output {
        use std::os::unix::process::ExitStatusExt;
        std::process::Output { status: std::process::ExitStatus::from_raw(code << 8), stdout: Vec::new(), stderr: stderr.as_bytes().to_vec() }
    }

    const KEY_LINE: &str = "cam-mbp ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMadeUpKeyForTestsOnlyAAAAAAAAAAAAAAAAAAAA";
    const KEYGEN: &str = "256 SHA256:Zm9ydGVzdHNvbmx5bWFkZXVwZmluZ2VycHJpbnQxMjM cam-mbp (ED25519)\n";
    const FINGERPRINT: &str = "ED25519 SHA256:Zm9ydGVzdHNvbmx5bWFkZXVwZmluZ2VycHJpbnQxMjM";

    #[test]
    fn routine_runs_check_host_keys_strictly_and_read_arbors_file_beside_the_users() {
        let options = strict_options_with(Some(Path::new("/Users/cam/.arbor/ssh/machines_known_hosts")));
        assert_eq!(
            options,
            ["-o", "StrictHostKeyChecking=yes", "-o", "GlobalKnownHostsFile=/etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2 /Users/cam/.arbor/ssh/machines_known_hosts"]
        );
        assert!(!options.iter().any(|word| word.contains("accept-new") || word.starts_with("UserKnownHostsFile")));
        // A home folder with a space is quoted the way ssh reads it.
        assert_eq!(
            global_known_hosts(Some(Path::new("/Users/Cam Lee/.arbor/ssh/machines_known_hosts"))),
            "GlobalKnownHostsFile=/etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2 \"/Users/Cam Lee/.arbor/ssh/machines_known_hosts\""
        );
        assert_eq!(global_known_hosts(None), "GlobalKnownHostsFile=/etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2");
    }

    #[test]
    fn git_and_grove_reach_machines_with_the_same_strict_options() {
        let git = git_ssh_command_with(Some(Path::new("/Users/cam/.arbor/ssh/machines_known_hosts")));
        assert_eq!(
            git,
            "ssh -o BatchMode=yes -o ConnectTimeout=10 '-o' 'StrictHostKeyChecking=yes' '-o' 'GlobalKnownHostsFile=/etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2 /Users/cam/.arbor/ssh/machines_known_hosts' -o ServerAliveInterval=15"
        );
        assert!(!git.contains("accept-new"));
        let script = grove_ssh_script(&strict_options_with(Some(Path::new("/Users/cam/.arbor/ssh/machines_known_hosts"))), &["-o".into(), "ControlPersist=120".into()]);
        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.ends_with("exec ssh '-o' 'StrictHostKeyChecking=yes' '-o' 'GlobalKnownHostsFile=/etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2 /Users/cam/.arbor/ssh/machines_known_hosts' '-o' 'ControlPersist=120' \"$@\"\n"));
        assert!(!script.contains("accept-new"));
    }

    #[test]
    fn grove_s_script_runs_ssh_with_arbors_options_before_grove_s_own() {
        let dir = temp_home("grove-script");
        let bin = dir.join("bin");
        fs::create_dir_all(&bin).unwrap();
        // A stand-in ssh that prints the words it was given, one to a line, so nothing reaches a real machine.
        fs::write(bin.join("ssh"), "#!/bin/sh\nfor word in \"$@\"; do echo \"$word\"; done\n").unwrap();
        fs::set_permissions(bin.join("ssh"), fs::Permissions::from_mode(0o755)).unwrap();
        let script = dir.join("grove-ssh");
        let text = grove_ssh_script(&strict_options_with(Some(Path::new("/Users/Cam Lee/.arbor/ssh/machines_known_hosts"))), &[]);
        write_private_with_mode(&script, &text, 0o700).unwrap();
        assert_eq!(fs::metadata(&script).unwrap().permissions().mode() & 0o777, 0o700);
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
        // Through sh, as running a file just written can find it still busy while another test starts a process.
        let ran = std::process::Command::new("sh").arg(&script).args(["-o", "StrictHostKeyChecking=accept-new", "cam-mbp", "sh"]).env("PATH", path).output().unwrap();
        let words: Vec<String> = String::from_utf8_lossy(&ran.stdout).lines().map(str::to_string).collect();
        assert_eq!(
            words,
            [
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "GlobalKnownHostsFile=/etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2 \"/Users/Cam Lee/.arbor/ssh/machines_known_hosts\"",
                "-o",
                "StrictHostKeyChecking=accept-new",
                "cam-mbp",
                "sh"
            ]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_scan_writes_only_to_its_own_file_and_runs_nothing_but_true() {
        let command = scan_command(&host("cam-mbp"), Path::new("/tmp/arbor-host-key-1/known_hosts"), &["~/.ssh/known_hosts".into(), "~/My Keys/hosts".into()]);
        let args: Vec<String> = command.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert!(args.contains(&"UserKnownHostsFile=/tmp/arbor-host-key-1/known_hosts ~/.ssh/known_hosts \"~/My Keys/hosts\"".to_string()));
        assert!(args.contains(&"StrictHostKeyChecking=accept-new".to_string()));
        assert!(args.contains(&"ControlPath=none".to_string()) && args.contains(&"UpdateHostKeys=no".to_string()));
        assert_eq!(args[args.len() - 3..], ["--", "cam-mbp", "true"]);
    }

    #[test]
    fn the_users_own_known_hosts_files_come_from_ssh_g() {
        assert_eq!(user_known_hosts("user cam\nuserknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\n"), ["~/.ssh/known_hosts", "~/.ssh/known_hosts2"]);
        assert_eq!(user_known_hosts("userknownhostsfile /etc/team_hosts\n"), ["/etc/team_hosts"]);
        assert_eq!(user_known_hosts(""), ["~/.ssh/known_hosts", "~/.ssh/known_hosts2"]);
    }

    #[test]
    fn fingerprints_are_the_keys_type_and_sha256_and_never_the_key_or_host() {
        let text = "256 SHA256:Zm9ydGVzdHNvbmx5bWFkZXVwZmluZ2VycHJpbnQxMjM cam-mbp (ED25519)\n\
                    3072 SHA256:b3RoZXJtYWRldXBmaW5nZXJwcmludGZvcnRlc3RzNDU2 |1|c2FsdA==|aGFzaA== (RSA)\n\
                    256 SHA256:Zm9ydGVzdHNvbmx5bWFkZXVwZmluZ2VycHJpbnQxMjM [cam-mbp]:2222 (ED25519)\n\
                    not a fingerprint line\n\
                    256 MD5:aa:bb cam-mbp (ED25519)\n";
        let found = parse_fingerprints(text);
        assert_eq!(found, [FINGERPRINT, "RSA SHA256:b3RoZXJtYWRldXBmaW5nZXJwcmludGZvcnRlc3RzNDU2"]);
        assert!(found.iter().all(|fingerprint| !fingerprint.contains("AAAA") && !fingerprint.contains("cam-mbp")));
    }

    #[test]
    fn a_scan_holds_the_lines_and_shows_only_fingerprints() {
        let machine = "scan-held";
        let scan = read_scan(machine, &host("cam-mbp"), &format!("{KEY_LINE}\n"), KEYGEN, &output(255, "Permission denied (publickey).\n")).unwrap();
        assert_eq!(scan, MachineHostKeyScan { fingerprints: vec![FINGERPRINT.into()], already_trusted: false });
        let json = serde_json::to_string(&scan).unwrap();
        assert!(!json.contains("AAAA") && !json.contains("ssh-ed25519"), "no key material reaches the window: {json}");
        assert!(held().lock().unwrap().contains_key(machine));
    }

    #[test]
    fn a_scan_with_nothing_new_says_whether_the_key_verified() {
        let empty = |stderr: &str, code: i32| read_scan("scan-empty", &host("cam-mbp"), "", "", &output(code, stderr));
        assert_eq!(empty("", 0).unwrap(), MachineHostKeyScan { fingerprints: vec![], already_trusted: true });
        assert!(empty("cam@cam-mbp: Permission denied (publickey).\n", 255).unwrap().already_trusted);
        let changed = empty(
            "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n\
             Host key for cam-mbp has changed and you have requested strict checking.\nHost key verification failed.\n",
            255,
        )
        .unwrap_err();
        assert_eq!((changed.kind, changed.message.as_str()), (crate::command_error::CommandErrorKind::Failed, "Host key for cam-mbp has changed and you have requested strict checking."));
        let refused = empty("ssh: connect to host cam-mbp port 22: Connection refused\n", 255).unwrap_err();
        assert_eq!(refused.message, "ssh: connect to host cam-mbp port 22: Connection refused");
    }

    #[test]
    fn trust_writes_only_the_keys_the_user_saw_into_a_private_file() {
        let home = temp_home("trust");
        let path = known_hosts_path_in(&home);
        let machine = "trust-cam";
        let cam = host("cam-mbp");
        // Nothing scanned yet.
        let error = trust_into(&path, machine, &cam, &[FINGERPRINT.into()]).unwrap_err();
        assert_eq!(error.kind, crate::command_error::CommandErrorKind::Changed);
        assert!(!path.exists());

        // Fingerprints other than the ones found trust nothing, and the scan has to be done again.
        read_scan(machine, &cam, KEY_LINE, KEYGEN, &output(255, "")).unwrap();
        assert_eq!(trust_into(&path, machine, &cam, &["ED25519 SHA256:c29tZXRoaW5nZWxzZQ".into()]).unwrap_err().kind, crate::command_error::CommandErrorKind::Changed);
        assert!(!path.exists());
        assert_eq!(trust_into(&path, machine, &cam, &[FINGERPRINT.into()]).unwrap_err().kind, crate::command_error::CommandErrorKind::Changed);

        // Nor does a scan of the machine at another address.
        read_scan(machine, &cam, KEY_LINE, KEYGEN, &output(255, "")).unwrap();
        assert!(trust_into(&path, machine, &host("cam-mbp.lan"), &[FINGERPRINT.into()]).is_err());

        read_scan(machine, &cam, KEY_LINE, KEYGEN, &output(255, "")).unwrap();
        trust_into(&path, machine, &cam, &[FINGERPRINT.into()]).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text, format!("{FILE_HEADER}# machine trust-cam\n{KEY_LINE}\n"));
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        // Trusted once: the held lines are gone.
        assert!(trust_into(&path, machine, &cam, &[FINGERPRINT.into()]).is_err());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn each_machine_has_one_block_that_trusting_again_replaces_and_removal_drops() {
        let other = "cedar-02 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherMadeUpKeyForTests".to_string();
        let first = rewrite("", &["cedar-02"], Some(("cedar-02", std::slice::from_ref(&other))));
        let both = rewrite(&first, &["cam-mbp"], Some(("cam-mbp", &[KEY_LINE.to_string()])));
        assert_eq!(both, format!("{FILE_HEADER}# machine cedar-02\n{other}\n# machine cam-mbp\n{KEY_LINE}\n"));
        let again = rewrite(&both, &["cedar-02"], Some(("cedar-02", &["cedar-02 ssh-ed25519 AAAANew".to_string()])));
        assert_eq!(again, format!("{FILE_HEADER}# machine cam-mbp\n{KEY_LINE}\n# machine cedar-02\ncedar-02 ssh-ed25519 AAAANew\n"));
        assert_eq!(rewrite(&again, &["cedar-02"], None), format!("{FILE_HEADER}# machine cam-mbp\n{KEY_LINE}\n"));
        // A name can't start a line of its own.
        assert_eq!(mark_name("cam\nmbp"), "cam mbp");

        let home = temp_home("forget");
        let path = known_hosts_path_in(&home);
        change_file(&path, &[], Some(("cam-mbp", &[KEY_LINE.to_string()]))).unwrap();
        change_file(&path, &["cam-mbp"], None).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), FILE_HEADER);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn only_a_bare_host_key_failure_is_asked_about_again() {
        assert!(is_bare_host_key_failure("Host key verification failed."));
        assert!(!is_bare_host_key_failure("No ED25519 host key is known for cam-mbp and you have requested strict checking."));
        assert!(is_host_key_cause("No ED25519 host key is known for cam-mbp and you have requested strict checking."));
        assert!(is_host_key_cause("Host key for cam-mbp has changed and you have requested strict checking."));
        assert!(!is_host_key_cause("Permission denied (publickey)."));
    }
}

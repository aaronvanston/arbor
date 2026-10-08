//! Grove, the machine-health sampler Arbor carries: `grove`, which runs on this Mac and reads every machine, and
//! `grove-probe`, a small resident sampler Arbor installs on a machine when the user asks.
//!
//! The release is pinned in `grove-version.txt` and fetched by the release build into `bundled-grove/` (the app's
//! `Resources/grove/`): the macOS builds of `grove` and every system's `grove-probe`, each checked against the
//! release's SHA256SUMS, which goes in beside them.
//!
//! Arbor's machine list stays the source of truth. Grove keeps its own registry in `GROVE_HOME`, a folder in Arbor's
//! data folder that nothing else uses, and each round Arbor's list is reconciled into it under slug names (`grove add`,
//! `grove rm`); the names people see stay in Arbor. A machine with a probe is followed through `grove stream <slug>
//! --jsonl`, one long-lived process each, up to `MAX_STREAMS` of them: they never take one of the eight script slots,
//! which are for short runs. Every other machine is read with one `grove sample` a round, which does hold a slot.
//! Grove's runs reach machines through Arbor's own SSH connections and host key checks (`GROVE_SSH_COMMAND`).

use super::diagnostics::{self, MachineOp};
use super::probe_updates::{self, Next};
use super::shell::{configure_helper_command, failure_detail, run_in_slot, shell_quote, Machine};
use super::shell::not_checked;
use super::{HealthMetric, HealthPoint, HealthReason, MachineFacts, MachineHealthState};
use serde::Serialize;
use ts_rs::TS;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::AsyncBufReadExt;
use tauri::Manager;
use tokio_util::sync::CancellationToken;

const VERSION_FILE: &str = "grove-version.txt";
/// In the app's Resources, and in a checkout for a dev build.
const RESOURCES_FOLDER: &str = "grove";
const SOURCE_FOLDER: &str = "bundled-grove";
const SUMS_FILE: &str = "SHA256SUMS";

/// The Grove release in this build: its version and the folder with its archives and their checksums.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Bundle {
    pub(crate) version: String,
    pub(crate) dir: PathBuf,
}

/// Which of the release's two programs an archive holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Program {
    /// The command line, run on this Mac.
    Grove,
    /// The resident sampler, run on a machine.
    Probe,
}

impl Program {
    fn name(self) -> &'static str {
        match self {
            Self::Grove => "grove",
            Self::Probe => "grove-probe",
        }
    }
}

fn bundle_in(version_file: &Path, dir: &Path) -> Option<Bundle> {
    let version = std::fs::read_to_string(version_file).ok()?.trim().trim_start_matches('v').to_string();
    (!version.is_empty() && dir.is_dir()).then(|| Bundle { version, dir: dir.to_path_buf() })
}

/// The release this build carries: the app's own Resources, or a checkout's `bundled-grove/` for a dev build.
pub(crate) fn bundle() -> Option<Bundle> {
    let executable_dir = crate::core_runtime::executable_dir().ok()?;
    if let Some(resources) = crate::core_runtime::macos_app_resources_dir(&executable_dir) {
        if let Some(bundle) = bundle_in(&resources.join(VERSION_FILE), &resources.join(RESOURCES_FOLDER)) {
            return Some(bundle);
        }
    }
    let root = crate::core_runtime::source_project_root(&executable_dir)?;
    bundle_in(&root.join(VERSION_FILE), &root.join(SOURCE_FOLDER))
}

pub(crate) fn asset_name(program: Program, version: &str, target: &str) -> String {
    format!("{}-{version}-{target}.tar.gz", program.name())
}

/// One archive, read only when it matches the checksum the release lists for it.
pub(crate) fn archive(bundle: &Bundle, program: Program, target: &str) -> Result<Vec<u8>, String> {
    let name = asset_name(program, &bundle.version, target);
    let sums = std::fs::read_to_string(bundle.dir.join(SUMS_FILE)).map_err(|_| "This build of Arbor has no checksums for Grove".to_string())?;
    let expected = sums
        .lines()
        .find_map(|line| {
            let (hash, file) = line.split_once(char::is_whitespace)?;
            (file.trim().trim_start_matches('*') == name).then(|| hash.trim().to_ascii_lowercase())
        })
        .ok_or_else(|| format!("This build of Arbor has no {} for {target}", program.name()))?;
    let bytes = std::fs::read(bundle.dir.join(&name)).map_err(|_| format!("This build of Arbor has no {} for {target}", program.name()))?;
    let actual: String = Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect();
    if actual != expected {
        return Err(format!("The {} Arbor carries doesn't match its checksum", program.name()));
    }
    Ok(bytes)
}

/// The build this Mac runs `grove` from.
fn this_mac_target() -> Option<&'static str> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    match std::env::consts::ARCH {
        "aarch64" => Some("darwin-arm64"),
        "x86_64" => Some("darwin-x64"),
        _ => None,
    }
}

// ── Running grove ────────────────────────────────────────────────────────────────────────────────────────────────

/// The envelopes this build reads (`schemaVersion` in each).
const SCHEMA_VERSION: u64 = 1;
/// How long a quick local call (list, add, rm, show, graph) may take.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);

/// Grove unpacked on this Mac and answering as the version this build carries.
#[derive(Clone, Debug)]
pub(crate) struct Grove {
    bin: PathBuf,
    home: PathBuf,
    pub(crate) bundle: Bundle,
}

impl Grove {
    /// A run of grove with its home and Arbor's SSH connections, its output read and nothing on stdin.
    pub(crate) fn command<S: AsRef<std::ffi::OsStr>>(&self, args: impl IntoIterator<Item = S>) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(&self.bin);
        command
            .args(args)
            .env("GROVE_HOME", &self.home)
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command.env("GROVE_SSH_COMMAND", super::host_keys::grove_ssh_command());
        configure_helper_command(&mut command);
        command
    }

    /// A quick call's `data`, or why it failed.
    pub(crate) async fn call(&self, args: &[&str]) -> Result<Value, String> {
        let command = self.command(args);
        let output = run_quick(command, CALL_TIMEOUT).await?;
        envelope_data(&output)
    }
}

async fn run_quick(mut command: tokio::process::Command, timeout: Duration) -> Result<std::process::Output, String> {
    #[cfg(target_os = "macos")]
    crate::keep_open_files_from_helpers();
    match tokio::time::timeout(timeout, command.output()).await {
        Err(_) => Err(format!("Grove didn't answer within {}s", timeout.as_secs())),
        Ok(Err(error)) => Err(format!("Could not start Grove: {error}")),
        Ok(Ok(output)) => Ok(output),
    }
}

/// The `data` of grove's JSON answer, or the message of its error envelope, or the end of what it wrote to stderr.
pub(crate) fn envelope_data(output: &std::process::Output) -> Result<Value, String> {
    if let Ok(envelope) = serde_json::from_slice::<Value>(&output.stdout) {
        if envelope.get("ok") == Some(&Value::Bool(true)) {
            if envelope.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
                return Err("Grove answered in a shape this build of Arbor doesn't read".into());
            }
            return Ok(envelope.get("data").cloned().unwrap_or(Value::Null));
        }
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = stderr
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .find_map(|error| error.pointer("/error/message").and_then(Value::as_str).map(str::to_string));
    Err(message.unwrap_or_else(|| failure_detail(output)))
}

/// Where grove keeps its registry, its readings and its history: a folder of Arbor's own.
pub(crate) fn home() -> Result<PathBuf, String> {
    Ok(crate::core_base_dir()?.join("grove"))
}

/// Grove ready to run, or why not, in words for the Machines page. The `grove` this build carries is unpacked into
/// `home/bin` once, checked against the release's checksum first, and must answer `version --json` as the version
/// pinned, in the envelope this build reads.
pub(crate) fn prepare(bundle: Option<Bundle>, home: &Path) -> Result<Grove, String> {
    let bundle = bundle.ok_or("This build of Arbor doesn't carry Grove")?;
    let target = this_mac_target().ok_or("Grove isn't built for this Mac")?;
    let bin_dir = home.join("bin");
    let bin = bin_dir.join(format!("grove-{}", bundle.version));
    let grove = Grove { bin: bin.clone(), home: home.to_path_buf(), bundle };
    if check_version(&grove).is_ok() {
        return Ok(grove);
    }
    std::fs::create_dir_all(&bin_dir).map_err(|error| format!("Could not make Grove's folder: {error}"))?;
    let archive = archive(&grove.bundle, Program::Grove, target)?;
    let unpacked = unpack(&archive, Program::Grove.name())?;
    let partial = bin_dir.join(format!(".grove-{}.new", std::process::id()));
    std::fs::write(&partial, unpacked).map_err(|error| format!("Could not unpack Grove: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o755));
    }
    std::fs::rename(&partial, &bin).map_err(|error| format!("Could not unpack Grove: {error}"))?;
    // Earlier versions this folder unpacked are Arbor's own copies; nothing else puts files here.
    if let Ok(entries) = std::fs::read_dir(&bin_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("grove-") && entry.path() != bin {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    check_version(&grove)?;
    Ok(grove)
}

/// One file out of a `.tar.gz` archive.
fn unpack(archive: &[u8], file: &str) -> Result<Vec<u8>, String> {
    use std::io::Write;
    let mut tar = std::process::Command::new("tar")
        .args(["-xzOf", "-", file])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not unpack Grove: {error}"))?;
    let mut stdin = tar.stdin.take().ok_or("Could not unpack Grove")?;
    let bytes = archive.to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&bytes));
    let output = tar.wait_with_output().map_err(|error| format!("Could not unpack Grove: {error}"))?;
    let _ = writer.join();
    if !output.status.success() || output.stdout.is_empty() {
        return Err("Could not unpack Grove from the archive Arbor carries".into());
    }
    Ok(output.stdout)
}

fn check_version(grove: &Grove) -> Result<(), String> {
    if !grove.bin.is_file() {
        return Err("Grove isn't unpacked yet".into());
    }
    let output = std::process::Command::new(&grove.bin)
        .args(["version", "--json"])
        .env("GROVE_HOME", &grove.home)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("Could not start Grove: {error}"))?;
    version_matches(&envelope_data(&output)?, &grove.bundle.version)
}

fn version_matches(data: &Value, wanted: &str) -> Result<(), String> {
    let name = data.get("name").and_then(Value::as_str);
    let version = data.get("version").and_then(Value::as_str).map(|version| version.trim_start_matches('v'));
    if name != Some("grove") || version != Some(wanted) {
        return Err(format!("Grove answered as {} where this build of Arbor expects {wanted}", version.unwrap_or("an unknown version")));
    }
    Ok(())
}

// ── The registry ─────────────────────────────────────────────────────────────────────────────────────────────────

/// A machine as grove's registry holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Entry {
    pub(crate) name: String,
    pub(crate) endpoint: String,
    pub(crate) port: u16,
}

/// A machine grove has, and the folder of its probe when it has one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Registered {
    pub(crate) entry: Entry,
    pub(crate) probe: Option<String>,
}

/// The name grove knows a machine by: Arbor's name loosely, as Arbor compares names, which grove always accepts. None
/// for a name with no letters or digits, which Arbor then samples itself.
pub(crate) fn slug(machine: &str) -> Option<String> {
    Some(super::normalize_machine_name(machine)).filter(|slug| !slug.is_empty())
}

/// What `grove list --json` holds.
pub(crate) fn parse_list(data: &Value) -> Vec<Registered> {
    data.as_array()
        .into_iter()
        .flatten()
        .filter_map(|machine| {
            let entry = Entry {
                name: machine.get("name")?.as_str()?.to_string(),
                endpoint: machine.get("endpoint")?.as_str()?.to_string(),
                port: machine.get("port").and_then(Value::as_u64).and_then(|port| u16::try_from(port).ok()).unwrap_or(22),
            };
            let probe = machine.pointer("/probe/dir").and_then(Value::as_str).map(str::to_string);
            Some(Registered { entry, probe })
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Change {
    Add(Entry),
    Remove(String),
}

/// What brings grove's registry in line with the machines Arbor samples. A machine whose endpoint or port changed is
/// removed and added again, as a different target is a different history in Arbor too. One Arbor no longer lists is
/// removed unless it has a probe: that one stays, unread, so taking a machine off the list and undoing it keeps its
/// probe, and Arbor never forgets a probe it put on a machine.
pub(crate) fn reconcile_plan(wanted: &[Entry], have: &[Registered]) -> Vec<Change> {
    let mut changes = Vec::new();
    let have_by_name: HashMap<&str, &Registered> = have.iter().map(|registered| (registered.entry.name.as_str(), registered)).collect();
    let wanted_names: BTreeSet<&str> = wanted.iter().map(|entry| entry.name.as_str()).collect();
    for registered in have {
        if !wanted_names.contains(registered.entry.name.as_str()) && registered.probe.is_none() {
            changes.push(Change::Remove(registered.entry.name.clone()));
        }
    }
    for entry in wanted {
        match have_by_name.get(entry.name.as_str()) {
            Some(registered) if registered.entry == *entry => {}
            Some(_) => {
                changes.push(Change::Remove(entry.name.clone()));
                changes.push(Change::Add(entry.clone()));
            }
            None => changes.push(Change::Add(entry.clone())),
        }
    }
    changes
}

/// Brings grove's registry in line with `wanted` and reads it back.
pub(crate) async fn reconcile(grove: &Grove, wanted: &[Entry]) -> Result<Vec<Registered>, String> {
    let have = parse_list(&grove.call(&["list", "--json"]).await?);
    let changes = reconcile_plan(wanted, &have);
    if changes.is_empty() {
        return Ok(have);
    }
    for change in changes {
        match change {
            Change::Remove(name) => grove.call(&["rm", "--yes", "--json", "--", &name]).await.map(drop)?,
            Change::Add(entry) => {
                let port = entry.port.to_string();
                grove.call(&["add", "--port", &port, "--json", "--", &entry.name, &entry.endpoint]).await.map(drop)?
            }
        }
    }
    Ok(parse_list(&grove.call(&["list", "--json"]).await?))
}

// ── Streams ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// Probes followed at once. Each is a grove process and one SSH session that stay open, so they have this allowance
/// of their own rather than the script slots; a machine past it is read one round at a time instead.
pub(crate) const MAX_STREAMS: usize = 12;
/// A streamed machine whose newest reading is older than this is unreachable. Its probe reads every two seconds and
/// grove passes on what's new once a second.
const STREAM_STALE_MS: i64 = 20_000;
/// A stream that has never delivered is waited on this long before it counts as failing.
const STREAM_FIRST_MS: i64 = 20_000;
const STREAM_BACKOFF_MAX: Duration = Duration::from_secs(60);
/// How long a stopped stream is given to close its SSH sessions before it's killed.
const STREAM_STOP_GRACE: Duration = Duration::from_secs(3);

/// What one machine's stream has said.
#[derive(Clone, Debug, Default)]
pub(crate) struct Feed {
    /// The newest reading, as `grove sample` gives one, and when it arrived.
    reading: Option<(i64, Value)>,
    /// Why the stream last dropped, until a reading comes again.
    error: Option<String>,
    started_ms: i64,
    /// The running probe's release, from its facts; None from a probe too old to say.
    probe_version: Option<String>,
}

/// What a round can use from a stream.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum StreamRead {
    Fresh(Value),
    /// Started, with nothing yet.
    Waiting,
    Failed(String),
}

impl Feed {
    pub(crate) fn read(&self, now_ms: i64) -> StreamRead {
        match &self.reading {
            Some((at, reading)) if now_ms - at <= STREAM_STALE_MS => StreamRead::Fresh(reading.clone()),
            None if now_ms - self.started_ms <= STREAM_FIRST_MS => StreamRead::Waiting,
            last => StreamRead::Failed(self.error.clone().unwrap_or_else(|| {
                let since = last.as_ref().map_or(self.started_ms, |(at, _)| *at);
                format!("No reading from its probe for {}s", ((now_ms - since) / 1000).max(1))
            })),
        }
    }

    /// Takes in one line of `grove stream --jsonl`. The reason a stream dropped is kept for Diagnostics.
    pub(crate) fn apply(&mut self, line: &str, now_ms: i64) -> Option<String> {
        let event: Value = serde_json::from_str(line).ok()?;
        if event.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
            return None;
        }
        match event.get("type").and_then(Value::as_str) {
            Some("reading") => {
                let reading = event.pointer("/data/reading")?.clone();
                self.reading = Some((now_ms, reading));
                self.error = None;
                None
            }
            Some("facts") => {
                self.probe_version = event.pointer("/data/probe_version").and_then(Value::as_str).filter(|version| !version.is_empty()).map(str::to_string);
                None
            }
            Some("disconnected") => {
                let error = event.pointer("/data/error").and_then(Value::as_str).unwrap_or("The stream ended").to_string();
                let error = stream_error(&error);
                self.error = Some(error.clone());
                Some(error)
            }
            _ => None,
        }
    }
}

/// Grove's reason a stream dropped, as a sentence.
fn stream_error(error: &str) -> String {
    let error = error.trim();
    let mut sentence: String = error.chars().take(1).flat_map(char::to_uppercase).chain(error.chars().skip(1)).collect();
    if sentence.is_empty() {
        sentence = "The stream ended".into();
    }
    sentence
}

/// The probes being followed, by slug.
#[derive(Default)]
pub(crate) struct Streams {
    feeds: Arc<Mutex<HashMap<String, Feed>>>,
    running: Mutex<BTreeMap<String, CancellationToken>>,
}

impl Streams {
    fn feeds(&self) -> std::sync::MutexGuard<'_, HashMap<String, Feed>> {
        self.feeds.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn running(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, CancellationToken>> {
        self.running.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Follows exactly `wanted` (slug, then the machine's name for Diagnostics), the first `MAX_STREAMS` of them,
    /// and stops the rest. Returns the slugs being followed.
    pub(crate) fn sync(&self, grove: &Grove, wanted: &[(String, String)], parent: &CancellationToken) -> BTreeSet<String> {
        let keep: BTreeMap<&str, &str> = wanted.iter().take(MAX_STREAMS).map(|(slug, machine)| (slug.as_str(), machine.as_str())).collect();
        let mut running = self.running();
        running.retain(|slug, token| {
            let stays = keep.contains_key(slug.as_str()) && !token.is_cancelled();
            if !stays {
                token.cancel();
            }
            stays
        });
        self.feeds().retain(|slug, _| keep.contains_key(slug.as_str()));
        let now = chrono::Local::now().timestamp_millis();
        for (slug, machine) in keep {
            if running.contains_key(slug) {
                continue;
            }
            let token = parent.child_token();
            running.insert(slug.to_string(), token.clone());
            self.feeds().insert(slug.to_string(), Feed { started_ms: now, ..Feed::default() });
            tauri::async_runtime::spawn(follow(grove.clone(), slug.to_string(), machine.to_string(), self.feeds.clone(), token));
        }
        running.keys().cloned().collect()
    }

    pub(crate) fn read(&self, slug: &str, now_ms: i64) -> Option<StreamRead> {
        self.feeds().get(slug).map(|feed| feed.read(now_ms))
    }

    /// The release a followed probe said it is.
    pub(crate) fn probe_version(&self, slug: &str) -> Option<String> {
        self.feeds().get(slug).and_then(|feed| feed.probe_version.clone())
    }

    /// Stops following one probe, as before it's taken off its machine.
    pub(crate) fn stop(&self, slug: &str) {
        if let Some(token) = self.running().remove(slug) {
            token.cancel();
        }
        self.feeds().remove(slug);
    }

    pub(crate) fn stop_all(&self) {
        for (_, token) in std::mem::take(&mut *self.running()) {
            token.cancel();
        }
        self.feeds().clear();
    }
}

/// Keeps `grove stream <slug> --jsonl` running until `token` is cancelled, starting it again when it exits. Grove
/// itself reconnects to the machine after a gap and catches up from the probe's ring, so a restart here is only for
/// grove stopping. On the way out it's asked to stop, so it closes its SSH sessions, and then killed.
async fn follow(grove: Grove, slug: String, machine: String, feeds: Arc<Mutex<HashMap<String, Feed>>>, token: CancellationToken) {
    let mut backoff = Duration::from_secs(1);
    while !token.is_cancelled() {
        let started = Instant::now();
        let mut command = grove.command(["stream", "--jsonl", "--", &slug]);
        #[cfg(target_os = "macos")]
        crate::keep_open_files_from_helpers();
        let ended = match command.spawn() {
            Err(error) => format!("Could not start Grove: {error}"),
            Ok(mut child) => {
                let stdout = child.stdout.take();
                let mut lines = stdout.map(|stdout| tokio::io::BufReader::new(stdout).lines());
                let mut connected = Instant::now();
                loop {
                    let next = async {
                        match lines.as_mut() {
                            Some(lines) => lines.next_line().await,
                            None => Ok(None),
                        }
                    };
                    tokio::select! {
                        _ = token.cancelled() => break,
                        line = next => match line {
                            Ok(Some(line)) => {
                                let now = chrono::Local::now().timestamp_millis();
                                let dropped = feeds.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get_mut(&slug).and_then(|feed| feed.apply(&line, now));
                                if let Some(error) = dropped {
                                    let failed: Result<std::process::Output, String> = Err(error);
                                    diagnostics::record(diagnostics::machine_call(&machine, MachineOp::HealthStream, connected.elapsed(), Some(&failed)));
                                    connected = Instant::now();
                                }
                            }
                            _ => break,
                        },
                    }
                }
                stop_child(&mut child).await;
                let output = child.wait_with_output().await.ok();
                output.filter(|output| !output.stderr.is_empty()).map_or_else(|| "Grove's stream stopped".to_string(), |output| failure_detail(&output))
            }
        };
        if token.is_cancelled() {
            break;
        }
        if let Some(feed) = feeds.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get_mut(&slug) {
            feed.error = Some(ended);
        }
        if started.elapsed() > STREAM_BACKOFF_MAX {
            backoff = Duration::from_secs(1);
        }
        tokio::select! {
            _ = token.cancelled() => break,
            _ = tokio::time::sleep(backoff) => {}
        }
        backoff = (backoff * 2).min(STREAM_BACKOFF_MAX);
    }
}

/// Asks grove to stop (it ends its SSH sessions on SIGTERM), then kills it if it hasn't within the grace.
async fn stop_child(child: &mut tokio::process::Child) {
    if let Ok(Some(_)) = child.try_wait() {
        return;
    }
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: signals only the grove process this task started and still holds.
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
        if tokio::time::timeout(STREAM_STOP_GRACE, child.wait()).await.is_ok() {
            return;
        }
    }
    let _ = child.start_kill();
}

// ── One-shot readings ────────────────────────────────────────────────────────────────────────────────────────────

/// How long one machine's `grove sample` may take over SSH, and the run as a whole.
const SAMPLE_TIMEOUT_MS: u64 = 12_000;
const SAMPLE_RUN_TIMEOUT: Duration = Duration::from_secs(16);

/// One reading of a machine with no probe being followed: `grove sample`, which holds one of the script slots while
/// it reaches the machine. Grove stores one a minute at most, for the long history.
pub(crate) async fn sample_once(grove: &Grove, machine: &str, slug: &str) -> Result<Value, String> {
    let timeout = SAMPLE_TIMEOUT_MS.to_string();
    let command = grove.command(["sample", "--json", "--min-store-interval", "55s", "--timeout", &timeout, "--", slug]);
    let output = run_in_slot(machine, MachineOp::HealthCheck, command, SAMPLE_RUN_TIMEOUT).await?;
    sample_result(&envelope_data(&output)?)
}

/// The one machine's reading out of `grove sample --json`'s answer, or why there isn't one.
fn sample_result(data: &Value) -> Result<Value, String> {
    let machine = data.pointer("/machines/0").ok_or("Grove returned no reading")?;
    if machine.get("ok") == Some(&Value::Bool(true)) {
        return machine.get("sample").filter(|sample| sample.is_object()).cloned().ok_or_else(|| "Grove returned no reading".to_string());
    }
    Err(machine.get("error").and_then(Value::as_str).map(stream_error).unwrap_or_else(|| "The machine couldn't be read".into()))
}

/// What grove knows of a machine that changes rarely (its model, chip, OS version, address), from `grove show`.
pub(crate) async fn machine_facts(grove: &Grove, slug: &str) -> Result<Value, String> {
    let data = grove.call(&["show", "--json", "--", slug]).await?;
    data.get("machine").cloned().ok_or_else(|| "Grove returned nothing for the machine".into())
}

// ── Readings as Arbor's points ───────────────────────────────────────────────────────────────────────────────────

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn text(value: Option<&Value>, key: &str) -> String {
    value.and_then(|value| value.get(key)).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

fn metric(name: &str) -> Option<HealthMetric> {
    Some(match name {
        "cpu" => HealthMetric::Cpu,
        "mem" | "memory" => HealthMetric::Memory,
        "swap" => HealthMetric::Swap,
        "disk" => HealthMetric::Disk,
        "load" => HealthMetric::Load,
        "cpu_temp" => HealthMetric::CpuTemp,
        "gpu_temp" => HealthMetric::GpuTemp,
        _ => return None,
    })
}

/// A grove reading as Arbor's facts, point and reason. `facts` is grove's record of the machine, for what readings
/// don't carry. The point is stamped with the round's time, as every point is.
pub(crate) fn point_from(reading: &Value, facts: Option<&Value>, at_ms: i64) -> Result<(MachineFacts, HealthPoint, Option<HealthReason>), String> {
    let required = |key: &str| number(reading, key).ok_or_else(|| format!("Grove returned an unreadable reading (missing {key})"));
    let score = reading.pointer("/health/score").and_then(Value::as_f64).ok_or("Grove returned a reading with no health score")?;
    let mem_total_kb = required("mem_total_kb")? as u64;
    let mem_available_kb = required("mem_available_kb")? as u64;
    let disk_total_kb = required("disk_total_kb")? as u64;
    let disk_used_kb = required("disk_used_kb")? as u64;
    let load1 = required("load1")? as f32;
    let swap_total_kb = number(reading, "swap_total_kb").map(|kb| kb as u64).filter(|kb| *kb > 0);
    let small = |key: &str| number(reading, key).map(|value| value as f32);
    let count = |key: &str| reading.pointer(key).and_then(Value::as_f64).map(|value| value as u32);
    let reason = reading
        .pointer("/health/reason")
        .and_then(|reason| Some(HealthReason { metric: metric(reason.get("metric")?.as_str()?)?, value: reason.get("value")?.as_f64()? as f32 }));
    let point = HealthPoint {
        t: at_ms,
        score: score.clamp(0.0, 100.0).round() as u8,
        cpu: small("cpu_pct"),
        mem: required("mem_used_pct")? as f32,
        mem_used_kb: mem_total_kb.saturating_sub(mem_available_kb),
        swap: swap_total_kb.and_then(|_| small("swap_used_pct")),
        swap_used_kb: swap_total_kb.and_then(|_| number(reading, "swap_used_kb")).map(|kb| kb as u64),
        disk: required("disk_used_pct")? as f32,
        disk_free_kb: disk_total_kb.saturating_sub(disk_used_kb),
        load1,
        load5: small("load5").unwrap_or(load1),
        load15: small("load15").unwrap_or(load1),
        rx_bps: number(reading, "net_rx_bps"),
        tx_bps: number(reading, "net_tx_bps"),
        latency_ms: small("latency_ms"),
        cpu_temp: small("cpu_temp_c"),
        gpu_temp: small("gpu_temp_c"),
        gpu_util: small("gpu_util_pct"),
        gpu_mem_used_mb: number(reading, "gpu_mem_used_mb").map(|mb| mb as u64),
        claude_running: count("/agents/claude"),
        codex_running: count("/agents/codex"),
    };
    let facts = MachineFacts {
        hostname: text(Some(reading), "hostname"),
        os: text(Some(reading), "os"),
        os_version: text(facts, "os_version"),
        arch: text(Some(reading), "arch"),
        model: text(facts, "model"),
        product_name: text(facts, "product_name"),
        chip: text(facts, "chip"),
        gpu: text(facts, "gpu"),
        cores: number(reading, "cores").map_or(1, |cores| (cores as u32).max(1)),
        mem_total_kb,
        disk_total_kb,
        swap_total_kb,
        gpu_mem_total_mb: facts.and_then(|facts| number(facts, "gpu_mem_total_mb")).map(|mb| mb as u64),
        ip: text(facts, "ip"),
        uptime_s: number(reading, "uptime_s").map(|seconds| seconds as u64),
        battery_pct: small("battery_pct"),
        battery_state: text(Some(reading), "battery_state"),
    };
    Ok((facts, point, reason))
}

/// Where grove's pings went, for the Tailscale path: the address they reached.
pub(crate) fn ping_address(reading: &Value) -> Option<std::net::IpAddr> {
    reading.get("address").and_then(Value::as_str).and_then(|address| address.parse().ok())
}

// ── Probes ───────────────────────────────────────────────────────────────────────────────────────────────────────

/// How long installing or removing a probe may take: the archive goes over SSH and the service manager starts it.
const PROBE_TIMEOUT: Duration = Duration::from_secs(300);

/// Which machines have Grove's probe, for the machine page and Settings › Machines.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineProbes {
    /// The Grove release this build carries, and installs on machines; None when it carries none.
    version: Option<String>,
    /// Why machine health isn't read through Grove right now; None while it is.
    unavailable: Option<String>,
    /// The machines Grove reads, by Arbor's name.
    machines: Vec<MachineProbe>,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineProbe {
    machine: String,
    /// It has a probe Arbor knows of.
    installed: bool,
    /// Its probe is being followed now; installed and not followed is starting, or past the streams' allowance.
    streaming: bool,
    /// The probe's release, as it last said; None until it's known.
    version: Option<String>,
    /// Arbor is updating it to the release it carries now.
    updating: bool,
    /// Why Arbor's last update of it failed. The old probe is left as it was, and Arbor tries again later.
    update_error: Option<String>,
}

fn probes_of(state: &MachineHealthState) -> MachineProbes {
    let version = state.grove.ready.get().and_then(|ready| ready.as_ref().ok()).map(|grove| grove.bundle.version.clone()).or_else(|| bundle().map(|bundle| bundle.version));
    let (unavailable, listed) = {
        let inner = state.lock();
        let view = &inner.grove;
        let listed: Vec<(String, String, bool, bool)> =
            view.slugs.iter().map(|(machine, slug)| (machine.clone(), slug.clone(), view.probes.contains_key(slug), view.streaming.contains(slug))).collect();
        (view.unavailable.clone(), listed)
    };
    let streamed: HashMap<String, Option<String>> = listed.iter().map(|(_, slug, ..)| (slug.clone(), state.grove.streams.probe_version(slug))).collect();
    let upkeep = state.grove.upkeep();
    let machines = listed
        .into_iter()
        .map(|(machine, slug, installed, streaming)| {
            let failed = upkeep.attempts.get(&slug).filter(|attempt| !attempt.done && version.as_deref() == Some(attempt.bundled.as_str()));
            MachineProbe {
                machine,
                installed,
                streaming,
                version: installed.then(|| upkeep.installed(&slug, streamed.get(&slug).cloned().flatten())).flatten(),
                updating: upkeep.busy.as_deref() == Some(slug.as_str()) && upkeep.updating,
                update_error: failed.and_then(|attempt| attempt.error.clone()),
            }
        })
        .collect();
    MachineProbes { version, unavailable, machines }
}

/// Grove and the machine's slug, or why a probe can't be put on or taken off it.
async fn grove_for(state: &MachineHealthState, machine: &str) -> Result<(Grove, String), String> {
    let grove = state.grove().await.cloned().ok_or_else(|| state.lock().grove.unavailable.clone().unwrap_or_else(|| "Grove isn't available".into()))?;
    let slug = state.lock().grove.slugs.get(machine).cloned().ok_or_else(|| not_checked(machine))?;
    Ok((grove, slug))
}

/// Which machines have Grove's probe and which are followed now, each probe's release and why Arbor's own update of it
/// failed, and why Grove isn't read when it isn't.
#[tauri::command]
pub(crate) async fn get_machine_probes(state: tauri::State<'_, MachineHealthState>) -> Result<MachineProbes, String> {
    Ok(probes_of(&state))
}

/// Puts the probe Arbor carries on a machine, or updates the one there, under launchd or a systemd user unit, so it
/// keeps reading the machine every two seconds and Arbor follows it.
#[tauri::command]
pub(crate) async fn install_machine_probe(state: tauri::State<'_, MachineHealthState>, machine: String) -> Result<MachineProbes, String> {
    install_probe(&state, &machine).await
}

async fn install_probe(state: &MachineHealthState, machine: &str) -> Result<MachineProbes, String> {
    put_probe(state, machine, MachineOp::ProbeInstall).await?;
    Ok(probes_of(state))
}

/// Puts the carried probe on a machine with `grove probe install`, which checks each archive against its checksums
/// and swaps the program in only once it runs. When that updated a probe already there, the update is listed among
/// Arbor's changes on the machine, and the stream starts again so the new release follows it.
async fn put_probe(state: &MachineHealthState, machine: &str, op: MachineOp) -> Result<(), String> {
    let (grove, slug) = grove_for(state, machine).await?;
    let had = state.lock().grove.probes.contains_key(&slug);
    let streamed = state.grove.streams.probe_version(&slug);
    let was = state.grove.upkeep().installed(&slug, streamed);
    let from = grove.bundle.dir.display().to_string();
    let command = grove.command(["probe", "install", "--from", from.as_str(), "--json", "--", slug.as_str()]);
    let data = envelope_data(&run_in_slot(machine, op, command, PROBE_TIMEOUT).await?)?;
    let dir = data.get("dir").and_then(Value::as_str).unwrap_or_default().to_string();
    let bundled = grove.bundle.version.clone();
    state.lock().grove.probes.insert(slug.clone(), dir.clone());
    {
        let now = chrono::Local::now().timestamp_millis();
        let mut upkeep = state.grove.upkeep();
        upkeep.read.insert(slug.clone(), (now, Some(bundled.clone())));
        let done = probe_updates::record(upkeep.attempts.get(&slug), &bundled, now, Ok(()));
        upkeep.attempts.insert(slug.clone(), done);
    }
    if had {
        // The follower already running is the old release, which doesn't answer the stream's echoes.
        state.grove.streams.stop(&slug);
        note_update(state, machine, &dir, was.as_deref(), &bundled).await;
    }
    // The next round reads the registry again and starts following it.
    state.request_reload();
    Ok(())
}

/// Lists a probe update among Arbor's changes on its machine, with nothing to undo: Arbor never puts an older probe
/// back. A failure here leaves the update done and is only logged.
async fn note_update(state: &MachineHealthState, machine: &str, dir: &str, from: Option<&str>, to: &str) {
    let Some(target) = state.lock().series.get(machine).map(Machine::listed) else {
        return;
    };
    let script = probe_change_script(&super::guarded_writes::new_stamp(), dir, from.unwrap_or("-"), to);
    if let Err(error) = super::guarded_writes::run_on(&target, MachineOp::ProbeUpdate, &script).await {
        eprintln!("The probe update on {machine} wasn't listed among Arbor's changes: {error}");
    }
}

/// Writes a change's manifest for a probe update: `what probe`, then `P dir from to`. Older changes aren't pruned for
/// it, so it never pushes out a backup that Undo needs.
pub(crate) fn probe_change_script(stamp: &str, dir: &str, from: &str, to: &str) -> String {
    let word = |value: &str| shell_quote(&value.chars().filter(|c| !c.is_control()).collect::<String>());
    format!(
        "root=\"$HOME/.arbor/setup-backups\"\n\
         (umask 077 && mkdir -p \"$root\"/{stamp}) && chmod 700 \"$root\" && printf 'what\\tprobe\\nP\\t%s\\t%s\\t%s\\n' {dir} {from} {to} > \"$root\"/{stamp}/manifest\n",
        stamp = word(stamp),
        dir = word(dir),
        from = word(from),
        to = word(to),
    )
}

// ── Probe releases and updates ───────────────────────────────────────────────────────────────────────────────────

/// A probe whose release isn't known (one too old to say over its stream) is asked again this often.
const VERSION_RECHECK_MS: i64 = 60 * 60 * 1000;
/// How long asking a probe its release may take.
const VERSION_TIMEOUT: Duration = Duration::from_secs(30);

/// What Arbor knows of each probe's release and of updating it, by slug.
#[derive(Default)]
pub(crate) struct ProbeUpkeep {
    /// Each probe's release as `grove probe status` last read it, and when; None when it couldn't be read.
    read: HashMap<String, (i64, Option<String>)>,
    attempts: HashMap<String, probe_updates::Attempt>,
    /// The probe being asked its release or updated: one at a time, so it never crowds the round.
    busy: Option<String>,
    /// Updating rather than asking.
    updating: bool,
}

impl ProbeUpkeep {
    /// A probe's release: what its stream says, else what it said when asked.
    fn installed(&self, slug: &str, streamed: Option<String>) -> Option<String> {
        streamed.or_else(|| self.read.get(slug).and_then(|(_, version)| version.clone()))
    }
}

/// The release `grove probe status --json` says one probe is.
pub(crate) fn parse_probe_version(data: &Value) -> Option<String> {
    data.pointer("/0/version").and_then(Value::as_str).filter(|version| !version.is_empty()).map(str::to_string)
}

/// After each round: asks a probe its release where that isn't known, or updates one older than the release Arbor
/// carries, by itself and through the same checked install as Update probe. Only a machine that already has a probe is
/// updated, never to an older release, once per carried release, with backoff after a failure.
pub(crate) fn upkeep_probes(app: &tauri::AppHandle, state: &MachineHealthState, now_ms: i64) {
    let Some(Ok(grove)) = state.grove.ready.get() else {
        return;
    };
    let probed: Vec<(String, String)> = {
        let inner = state.lock();
        inner.grove.slugs.iter().filter(|(_, slug)| inner.grove.probes.contains_key(*slug)).map(|(machine, slug)| (machine.clone(), slug.clone())).collect()
    };
    let streamed: Vec<Option<String>> = probed.iter().map(|(_, slug)| state.grove.streams.probe_version(slug)).collect();
    let mut upkeep = state.grove.upkeep();
    if upkeep.busy.is_some() {
        return;
    }
    for ((machine, slug), streamed) in probed.into_iter().zip(streamed) {
        let installed = upkeep.installed(&slug, streamed);
        let ask = installed.is_none() && upkeep.read.get(&slug).is_none_or(|(at, _)| now_ms - at >= VERSION_RECHECK_MS);
        let update = probe_updates::next(installed.as_deref(), &grove.bundle.version, upkeep.attempts.get(&slug), now_ms) == Next::Update;
        if !ask && !update {
            continue;
        }
        upkeep.busy = Some(slug.clone());
        upkeep.updating = update;
        let (app, grove) = (app.clone(), grove.clone());
        tauri::async_runtime::spawn(async move {
            let state = app.state::<MachineHealthState>();
            if update {
                let result = put_probe(&state, &machine, MachineOp::ProbeUpdate).await;
                let mut upkeep = state.grove.upkeep();
                if let Err(error) = result {
                    let failed = probe_updates::record(upkeep.attempts.get(&slug), &grove.bundle.version, chrono::Local::now().timestamp_millis(), Err(error));
                    upkeep.attempts.insert(slug, failed);
                }
                upkeep.busy = None;
            } else {
                let command = grove.command(["probe", "status", "--json", "--", slug.as_str()]);
                let version = run_in_slot(&machine, MachineOp::ProbeCheck, command, VERSION_TIMEOUT).await.and_then(|output| envelope_data(&output)).ok().as_ref().and_then(parse_probe_version);
                let mut upkeep = state.grove.upkeep();
                upkeep.read.insert(slug, (chrono::Local::now().timestamp_millis(), version));
                upkeep.busy = None;
            }
        });
        return;
    }
}

/// Stops a machine's probe and takes it off the machine, with its folder; the history Arbor's Grove kept stays.
#[tauri::command]
pub(crate) async fn uninstall_machine_probe(state: tauri::State<'_, MachineHealthState>, machine: String) -> Result<MachineProbes, String> {
    uninstall_probe(&state, &machine).await
}

async fn uninstall_probe(state: &MachineHealthState, machine: &str) -> Result<MachineProbes, String> {
    let (grove, slug) = grove_for(state, machine).await?;
    state.grove.streams.stop(&slug);
    let command = grove.command(["probe", "uninstall", "--json", "--", slug.as_str()]);
    let removed = run_in_slot(machine, MachineOp::ProbeUninstall, command, PROBE_TIMEOUT).await.and_then(|output| envelope_data(&output));
    {
        let mut inner = state.lock();
        if removed.is_ok() {
            inner.grove.probes.remove(&slug);
        }
        inner.grove.streaming.remove(&slug);
    }
    state.request_reload();
    removed?;
    Ok(probes_of(state))
}

// ── Long history ─────────────────────────────────────────────────────────────────────────────────────────────────

/// Buckets a long window is drawn in: Grove's widest chart.
const HISTORY_BUCKETS: &str = "200";
/// The longest window asked of Grove, which keeps 90 days.
const HISTORY_MAX_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// A machine's readings over a window longer than the hour Arbor keeps, from what Grove stored: one value a bucket,
/// the bucket's mean, null where nothing was stored (the machine was off or unread), so gaps show as gaps.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineHistory {
    machine: String,
    /// When the first bucket starts, and each one's length.
    since: i64,
    bucket_ms: i64,
    /// Stored samples in the window; none yet when Grove only just started reading the machine.
    samples: u64,
    cpu: Vec<Option<f32>>,
    mem: Vec<Option<f32>>,
    disk: Vec<Option<f32>>,
    swap: Vec<Option<f32>>,
    load1: Vec<Option<f32>>,
    cpu_temp: Vec<Option<f32>>,
    gpu_temp: Vec<Option<f32>>,
    rx_bps: Vec<Option<f64>>,
    tx_bps: Vec<Option<f64>>,
    agents: Vec<Option<f32>>,
}

/// `grove graph --json`'s buckets as Arbor's history.
pub(crate) fn parse_graph(machine: &str, data: &Value) -> Result<MachineHistory, String> {
    let since = data
        .get("since")
        .and_then(Value::as_str)
        .and_then(|since| chrono::DateTime::parse_from_rfc3339(since).ok())
        .map(|since| since.timestamp_millis())
        .ok_or("Grove returned a history with no start")?;
    let bucket_ms = data.get("bucket_ms").and_then(Value::as_i64).filter(|ms| *ms > 0).ok_or("Grove returned a history with no buckets")?;
    let metrics: HashMap<&str, &Vec<Value>> = data
        .get("metrics")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|metric| Some((metric.get("metric")?.as_str()?, metric.get("points")?.as_array()?)))
        .collect();
    let wide = |name: &str| metrics.get(name).map(|points| points.iter().map(Value::as_f64).collect::<Vec<_>>()).unwrap_or_default();
    let narrow = |name: &str| wide(name).into_iter().map(|value| value.map(|value| value as f32)).collect::<Vec<_>>();
    Ok(MachineHistory {
        machine: machine.to_string(),
        since,
        bucket_ms,
        samples: data.get("samples").and_then(Value::as_u64).unwrap_or(0),
        cpu: narrow("cpu_pct"),
        mem: narrow("mem_used_pct"),
        disk: narrow("disk_used_pct"),
        swap: narrow("swap_used_pct"),
        load1: narrow("load1"),
        cpu_temp: narrow("cpu_temp_c"),
        gpu_temp: narrow("gpu_temp_c"),
        rx_bps: wide("net_rx_bps"),
        tx_bps: wide("net_tx_bps"),
        agents: narrow("agent_sessions"),
    })
}

/// A machine's history over `window_ms` (beyond the hour the page keeps itself), from what Grove stored on this Mac:
/// nothing reaches the machine.
#[tauri::command]
pub(crate) async fn get_machine_history(state: tauri::State<'_, MachineHealthState>, machine: String, window_ms: i64) -> Result<MachineHistory, String> {
    let (grove, slug) = grove_for(&state, &machine).await?;
    let minutes = (window_ms.clamp(60 * 60 * 1000, HISTORY_MAX_MS) / 60_000).to_string() + "m";
    let data = grove.call(&["graph", "--since", &minutes, "--width", HISTORY_BUCKETS, "--json", "--", &slug]).await?;
    parse_graph(&machine, &data)
}

// ── Filling the hour ─────────────────────────────────────────────────────────────────────────────────────────────

/// Stored samples a fill reads. Grove keeps about one a minute (a probe's minute, or a `grove sample` that stores one
/// at most every 55 s), so this covers the hour with room to spare.
const FILL_SAMPLES: &str = "90";

/// Fills each machine's hour that has a gap (after Arbor starts, or after the Mac slept or the machine was away) from
/// the samples Grove stored on this Mac, so the charts don't start empty. Nothing reaches the machine. True when any
/// series took in older points.
pub(crate) async fn fill_history(state: &MachineHealthState, now_ms: i64) -> bool {
    let due: Vec<(String, String)> = {
        let inner = state.lock();
        if inner.grove.unavailable.is_some() {
            return false;
        }
        inner
            .series
            .values()
            .filter(|series| series.fill_due && !series.points.is_empty())
            .filter_map(|series| Some((series.host.machine.clone(), inner.grove.slugs.get(&series.host.machine)?.clone())))
            .collect()
    };
    if due.is_empty() {
        return false;
    }
    let Some(grove) = state.grove().await else {
        return false;
    };
    let read = futures_util::future::join_all(due.into_iter().map(|(machine, slug)| async move {
        let stored = grove.call(&["history", "--limit", FILL_SAMPLES, "--json", "--", &slug]).await.map(|data| parse_history(&data));
        (machine, stored)
    }))
    .await;
    let mut inner = state.lock();
    let mut filled = false;
    for (machine, stored) in read {
        let Some(series) = inner.series.get_mut(&machine) else { continue };
        // A failed read waits for the next gap: the charts fill from live readings meanwhile, as they always did.
        series.fill_due = false;
        match stored {
            Ok(points) => filled |= series.fill(points, now_ms),
            Err(error) => eprintln!("Could not read {machine}'s stored health from Grove: {error}"),
        }
    }
    filled
}

/// `grove history --json`'s samples as points, each at the time it was taken. A sample stores the same fields as a
/// reading, so it's read the same way; one that can't be read whole is left out.
pub(crate) fn parse_history(data: &Value) -> Vec<HealthPoint> {
    data.get("samples")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|sample| {
            let taken_at = sample.get("taken_at").and_then(Value::as_str).and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())?;
            point_from(sample, None, taken_at.timestamp_millis()).ok().map(|(_, point, _)| point)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("arbor-grove-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_archive_is_read_only_when_it_matches_its_checksum() {
        let dir = temp_dir("sums");
        std::fs::write(dir.join("grove-probe-0.1.1-linux-x64.tar.gz"), b"probe").unwrap();
        std::fs::write(dir.join("grove-0.1.1-darwin-arm64.tar.gz"), b"tampered").unwrap();
        let sum = |bytes: &[u8]| Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        std::fs::write(
            dir.join(SUMS_FILE),
            format!("{}  grove-probe-0.1.1-linux-x64.tar.gz\n{}  grove-0.1.1-darwin-arm64.tar.gz\n", sum(b"probe"), sum(b"grove")),
        )
        .unwrap();
        let bundle = Bundle { version: "0.1.1".into(), dir: dir.clone() };
        assert_eq!(archive(&bundle, Program::Probe, "linux-x64").unwrap(), b"probe");
        assert!(archive(&bundle, Program::Grove, "darwin-arm64").unwrap_err().contains("doesn't match"));
        assert!(archive(&bundle, Program::Probe, "linux-arm64").unwrap_err().contains("no grove-probe for linux-arm64"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A reading as grove 0.1.1 gave it for a Mac, trimmed to what Arbor reads.
    const READING: &str = r#"{"address":"100.64.0.7","agent_sessions":3,"agents":{"claude":2,"codex":1,"cpu_pct":null,"rss_mb":null},
        "arch":"arm64","battery_pct":null,"battery_state":null,"cores":12,"cpu_pct":35.1,"cpu_temp_c":72,
        "disk_total_kb":482797652,"disk_used_kb":462205888,"disk_used_pct":95.7,"gpu_mem_used_mb":null,"gpu_temp_c":63,
        "gpu_util_pct":70.8,"health":{"score":58,"status":"degraded","reason":{"metric":"disk","value":95.7}},
        "hostname":"cam-mini.local","latency_ms":4.2,"load1":12.94,"load15":28.24,"load5":22.8,"mem_available_kb":25958240,
        "mem_total_kb":67108864,"mem_used_pct":61.3,"net_rx_bytes":515124200620,"net_tx_bytes":1500504627865,"os":"Darwin",
        "ping_target":"cam-mini","swap_total_kb":7340032,"swap_used_kb":6016317,"swap_used_pct":82,
        "taken_at":"2026-10-07T10:17:06.513Z","uptime_s":735265,"net_rx_bps":146224,"net_tx_bps":null}"#;
    const MACHINE: &str = r#"{"chip":"Apple M4 Pro","gpu":"Apple M4 Pro","gpu_mem_total_mb":null,"ip":"192.0.2.10",
        "model":"Mac16,11","name":"cammini","os_version":"27.0","product_name":"Mac mini (2024)","probe":null}"#;

    #[test]
    fn a_grove_reading_becomes_arbor_s_point_and_facts() {
        let reading: Value = serde_json::from_str(READING).unwrap();
        let machine: Value = serde_json::from_str(MACHINE).unwrap();
        let (facts, point, reason) = point_from(&reading, Some(&machine), 5_000).unwrap();
        assert_eq!((point.t, point.score, point.cpu, point.mem, point.disk), (5_000, 58, Some(35.1), 61.3, 95.7));
        assert_eq!(point.mem_used_kb, 67108864 - 25958240);
        assert_eq!(point.disk_free_kb, 482797652 - 462205888);
        assert_eq!((point.swap, point.swap_used_kb), (Some(82.0), Some(6016317)));
        assert_eq!((point.load5, point.load15), (22.8, 28.24));
        assert_eq!((point.rx_bps, point.tx_bps), (Some(146224.0), None));
        assert_eq!((point.cpu_temp, point.gpu_temp, point.gpu_util), (Some(72.0), Some(63.0), Some(70.8)));
        assert_eq!((point.claude_running, point.codex_running), (Some(2), Some(1)));
        assert_eq!(reason, Some(HealthReason { metric: HealthMetric::Disk, value: 95.7 }));
        assert_eq!((facts.cores, facts.chip.as_str(), facts.product_name.as_str(), facts.os_version.as_str()), (12, "Apple M4 Pro", "Mac mini (2024)", "27.0"));
        assert_eq!((facts.hostname.as_str(), facts.ip.as_str(), facts.swap_total_kb), ("cam-mini.local", "192.0.2.10", Some(7340032)));
        assert_eq!(ping_address(&reading), Some("100.64.0.7".parse().unwrap()));
        // Without grove's record of the machine, only what the reading carries.
        let (bare, _, _) = point_from(&reading, None, 5_000).unwrap();
        assert_eq!((bare.chip.as_str(), bare.os.as_str()), ("", "Darwin"));
    }

    #[test]
    fn a_reading_with_no_swap_or_score_is_read_as_such() {
        let mut reading: Value = serde_json::from_str(READING).unwrap();
        reading["swap_total_kb"] = Value::from(0);
        let (facts, point, _) = point_from(&reading, None, 1).unwrap();
        assert_eq!((facts.swap_total_kb, point.swap, point.swap_used_kb), (None, None, None));
        reading["health"] = serde_json::json!({ "score": null, "status": "pending", "reason": null });
        assert!(point_from(&reading, None, 1).unwrap_err().contains("no health score"));
        reading.as_object_mut().unwrap().remove("mem_total_kb");
        reading["health"] = serde_json::json!({ "score": 90 });
        assert!(point_from(&reading, None, 1).unwrap_err().contains("mem_total_kb"));
    }

    fn output(code: i32, stdout: &str, stderr: &str) -> std::process::Output {
        use std::os::unix::process::ExitStatusExt;
        std::process::Output { status: std::process::ExitStatus::from_raw(code << 8), stdout: stdout.into(), stderr: stderr.into() }
    }

    #[test]
    fn grove_s_envelopes_give_their_data_or_their_error() {
        assert_eq!(envelope_data(&output(0, r#"{"command":"list","data":[],"ok":true,"schemaVersion":1}"#, "")).unwrap(), serde_json::json!([]));
        assert!(envelope_data(&output(0, r#"{"data":[],"ok":true,"schemaVersion":2}"#, "")).unwrap_err().contains("shape"));
        let refused = r#"{"error":{"code":"machine_not_found","message":"No machine named \"cedar01\"."},"ok":false,"schemaVersion":1}"#;
        assert_eq!(envelope_data(&output(1, "", refused)).unwrap_err(), "No machine named \"cedar01\".");
        assert_eq!(envelope_data(&output(127, "", "sh: grove: not found\n")).unwrap_err(), "sh: grove: not found");
        assert!(version_matches(&serde_json::json!({ "name": "grove", "version": "0.1.2" }), "0.1.2").is_ok());
        assert!(version_matches(&serde_json::json!({ "name": "grove", "version": "0.1.1" }), "0.1.2").unwrap_err().contains("0.1.1"));
    }

    #[test]
    fn one_sample_s_answer_is_the_machine_s_reading_or_why_not() {
        let ok = serde_json::json!({ "machines": [{ "name": "cedar01", "ok": true, "sample": { "cpu_pct": 4.0 } }] });
        assert_eq!(sample_result(&ok).unwrap()["cpu_pct"], 4.0);
        let down = serde_json::json!({ "machines": [{ "name": "cedar01", "ok": false, "error": "ssh: connect to host cedar-01 port 22: Operation timed out" }] });
        assert_eq!(sample_result(&down).unwrap_err(), "Ssh: connect to host cedar-01 port 22: Operation timed out");
        assert!(sample_result(&serde_json::json!({ "machines": [] })).is_err());
    }

    fn entry(name: &str, endpoint: &str, port: u16) -> Entry {
        Entry { name: name.into(), endpoint: endpoint.into(), port }
    }

    #[test]
    fn the_registry_follows_arbor_s_list_and_keeps_machines_with_probes() {
        assert_eq!(slug("Build Box"), Some("buildbox".into()));
        assert_eq!(slug("--"), None);
        let have = vec![
            Registered { entry: entry("cedar01", "cedar-01.lan", 22), probe: None },
            Registered { entry: entry("cammbp", "cam-mbp.local", 22), probe: None },
            Registered { entry: entry("oldbox", "old-box", 22), probe: None },
            Registered { entry: entry("parked", "parked.lan", 22), probe: Some("/home/cam/.grove-probe".into()) },
        ];
        let wanted = vec![entry("cedar01", "cedar-01.lan", 22), entry("cammbp", "cam-mbp.local", 2222), entry("here", "localhost", 22)];
        assert_eq!(
            reconcile_plan(&wanted, &have),
            vec![
                Change::Remove("oldbox".into()),
                Change::Remove("cammbp".into()),
                Change::Add(entry("cammbp", "cam-mbp.local", 2222)),
                Change::Add(entry("here", "localhost", 22)),
            ]
        );
        assert!(reconcile_plan(&wanted[..1], &have[..1]).is_empty());
        let listed = parse_list(&serde_json::json!([
            { "name": "cedar01", "endpoint": "cedar-01.lan", "port": 22, "probe": { "dir": "/home/cam/.grove-probe" } },
            { "name": "here", "endpoint": "localhost", "port": 22, "probe": null },
        ]));
        assert_eq!(listed[0].probe.as_deref(), Some("/home/cam/.grove-probe"));
        assert_eq!(listed[1], Registered { entry: entry("here", "localhost", 22), probe: None });
    }

    #[test]
    fn a_stream_s_lines_keep_the_newest_reading_and_why_it_dropped() {
        let mut feed = Feed { started_ms: 1_000, ..Feed::default() };
        assert_eq!(feed.read(5_000), StreamRead::Waiting);
        assert!(matches!(feed.read(30_000), StreamRead::Failed(error) if error == "No reading from its probe for 29s"));
        let reading = r#"{"data":{"machine":"cedar01","reading":{"cpu_pct":4.0}},"schemaVersion":1,"timestamp":"2026-10-07T10:17:06.513Z","type":"reading"}"#;
        assert_eq!(feed.apply(reading, 40_000), None);
        assert!(matches!(feed.read(45_000), StreamRead::Fresh(value) if value["cpu_pct"] == 4.0));
        let dropped = r#"{"data":{"error":"the stream ended","machine":"cedar01"},"schemaVersion":1,"timestamp":"x","type":"disconnected"}"#;
        assert_eq!(feed.apply(dropped, 46_000).as_deref(), Some("The stream ended"));
        // The last reading stands until it's stale; then the drop is why.
        assert!(matches!(feed.read(50_000), StreamRead::Fresh(_)));
        assert_eq!(feed.read(70_000), StreamRead::Failed("The stream ended".into()));
        let facts = r#"{"data":{"machine":"cedar01","probe_version":"0.1.3"},"schemaVersion":1,"timestamp":"x","type":"facts"}"#;
        assert_eq!(feed.apply(facts, 47_000), None);
        assert_eq!(feed.probe_version.as_deref(), Some("0.1.3"), "the release the probe says it is");
        assert_eq!(feed.apply("not json", 1), None);
        assert_eq!(feed.apply(&reading.replace("\"schemaVersion\":1", "\"schemaVersion\":2"), 80_000), None);
        assert_eq!(feed.read(80_000), StreamRead::Failed("The stream ended".into()));
    }

    /// A stand-in grove that answers a stream with one reading and then waits, as a real one does between readings.
    #[tokio::test]
    async fn a_followed_probe_s_readings_reach_the_round_and_stopping_ends_the_stream() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("stream");
        let bin = dir.join("grove");
        std::fs::write(
            &bin,
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$GROVE_HOME/calls\"\n\
             echo '{\"data\":{\"machine\":\"cedar01\"},\"schemaVersion\":1,\"type\":\"connected\"}'\n\
             echo '{\"data\":{\"machine\":\"cedar01\",\"reading\":{\"cpu_pct\":7.5}},\"schemaVersion\":1,\"type\":\"reading\"}'\n\
             exec sleep 30\n",
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let grove = Grove { bin, home: dir.clone(), bundle: Bundle { version: "0.1.2".into(), dir: dir.clone() } };
        let streams = Streams::default();
        let parent = CancellationToken::new();
        let wanted = vec![("cedar01".to_string(), "cedar-01".to_string())];
        assert_eq!(streams.sync(&grove, &wanted, &parent), BTreeSet::from(["cedar01".to_string()]));
        let mut seen = None;
        for _ in 0..50 {
            if let Some(StreamRead::Fresh(reading)) = streams.read("cedar01", chrono::Local::now().timestamp_millis()) {
                seen = Some(reading);
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(seen.expect("the reading arrived")["cpu_pct"], 7.5);
        assert_eq!(std::fs::read_to_string(dir.join("calls")).unwrap().trim(), "stream --jsonl -- cedar01");
        // Syncing again starts nothing new; leaving it out stops it.
        streams.sync(&grove, &wanted, &parent);
        assert!(streams.sync(&grove, &[], &parent).is_empty());
        assert_eq!(streams.read("cedar01", 0), None);
        parent.cancel();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Installing and removing go through grove's own probe commands with the carried archives, and the list says so
    /// at once; a failure comes back in grove's words and leaves the probe as it was. A stand-in grove answers.
    #[tokio::test]
    async fn a_probe_is_installed_from_the_carried_release_and_removed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("install");
        let bin = dir.join("grove");
        std::fs::write(
            &bin,
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$GROVE_HOME/calls\"\n\
             case \"$*\" in\n\
             \x20 *'-- elm02') echo '{\"error\":{\"code\":\"probe_install_failed\",\"message\":\"No probe build for SunOS i86pc.\"},\"ok\":false,\"schemaVersion\":1}' >&2; exit 1 ;;\n\
             \x20 'probe install'*) echo '{\"command\":\"probe install\",\"data\":{\"dir\":\"/home/cam/.grove-probe\"},\"ok\":true,\"schemaVersion\":1}' ;;\n\
             \x20 *) echo '{\"command\":\"probe uninstall\",\"data\":{\"removed\":true},\"ok\":true,\"schemaVersion\":1}' ;;\n\
             esac\n",
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let state = MachineHealthState::default();
        let grove = Grove { bin, home: dir.clone(), bundle: Bundle { version: "0.1.2".into(), dir: PathBuf::from("/Applications/Arbor.app/Contents/Resources/grove") } };
        assert!(state.grove.ready.set(Ok(grove)).is_ok());
        {
            let mut inner = state.lock();
            inner.grove.slugs.insert("cedar-01".into(), "cedar01".into());
            inner.grove.slugs.insert("elm-02".into(), "elm02".into());
        }
        let probe = |probes: &MachineProbes, machine: &str| probes.machines.iter().find(|probe| probe.machine == machine).map(|probe| probe.installed);
        let installed = install_probe(&state, "cedar-01").await.unwrap();
        assert_eq!((probe(&installed, "cedar-01"), installed.version.as_deref()), (Some(true), Some("0.1.2")));
        let shown = installed.machines.iter().find(|probe| probe.machine == "cedar-01").unwrap();
        assert_eq!((shown.version.as_deref(), shown.updating, shown.update_error.as_deref()), (Some("0.1.2"), false, None), "it's the carried release now");
        assert!(install_probe(&state, "elm-02").await.unwrap_err().contains("No probe build for SunOS"));
        assert!(install_probe(&state, "oak-03").await.unwrap_err().contains("oak-03"));
        let removed = uninstall_probe(&state, "cedar-01").await.unwrap();
        assert_eq!(probe(&removed, "cedar-01"), Some(false));
        let calls = std::fs::read_to_string(dir.join("calls")).unwrap();
        assert_eq!(
            calls.lines().collect::<Vec<_>>(),
            [
                "probe install --from /Applications/Arbor.app/Contents/Resources/grove --json -- cedar01",
                "probe install --from /Applications/Arbor.app/Contents/Resources/grove --json -- elm02",
                "probe uninstall --json -- cedar01",
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `grove probe status` names each probe's release, older ones included; one it couldn't reach has none.
    #[test]
    fn a_probe_s_release_is_read_from_its_status() {
        let status = serde_json::json!([{ "name": "cedar01", "running": true, "version": "0.1.2", "dir": "/home/cam/.grove-probe" }]);
        assert_eq!(parse_probe_version(&status).as_deref(), Some("0.1.2"));
        assert_eq!(parse_probe_version(&serde_json::json!([{ "name": "cedar01", "running": false, "version": null }])), None);
        assert_eq!(parse_probe_version(&serde_json::json!([])), None);
    }

    /// An update is listed among Arbor's changes on the machine, under sh and dash, with its probe's path and nothing
    /// to undo, and without pruning the backups Undo needs.
    #[test]
    fn a_probe_update_is_listed_among_arbor_s_changes() {
        use super::super::{guarded_writes, setup_sync};
        for shell in super::super::shell::shells() {
            let home = temp_dir(&format!("probe-change-{shell}"));
            std::fs::create_dir_all(&home).unwrap();
            let dir = home.join(".grove-probe").display().to_string();
            let run = |script: &str| {
                let output = std::process::Command::new(shell).arg("-c").arg(script).env("HOME", &home).output().unwrap();
                assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
                String::from_utf8(output.stdout).unwrap()
            };
            run(&probe_change_script("20261008T010203Z-0b01", &dir, "0.1.2", "0.1.3"));
            let listed = setup_sync::parse_backups(&run(&format!("set -u\nexport LC_ALL=C\n{}", guarded_writes::BACKUPS_SCRIPT)));
            assert_eq!(listed.len(), 1, "{shell}");
            let entry = serde_json::to_value(&listed[0]).unwrap();
            assert_eq!((&entry["what"], &entry["files"][0]["path"]), (&serde_json::json!("probe"), &serde_json::json!("~/.grove-probe/grove-probe")), "{shell}");
            let mode = std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(home.join(".arbor/setup-backups")).unwrap().permissions());
            assert_eq!(mode & 0o777, 0o700, "{shell}");
            let _ = std::fs::remove_dir_all(&home);
        }
    }

    #[test]
    fn streams_past_their_allowance_are_left_to_one_shot_samples() {
        let dir = temp_dir("cap");
        let grove = Grove { bin: dir.join("missing"), home: dir.clone(), bundle: Bundle { version: "0.1.2".into(), dir: dir.clone() } };
        let wanted: Vec<(String, String)> = (0..MAX_STREAMS + 3).map(|index| (format!("box{index:02}"), format!("box-{index:02}"))).collect();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _guard = runtime.enter();
        let streams = Streams::default();
        let parent = CancellationToken::new();
        let following = streams.sync(&grove, &wanted, &parent);
        assert_eq!(following.len(), MAX_STREAMS);
        assert!(!following.contains(&format!("box{:02}", MAX_STREAMS)));
        parent.cancel();
        streams.stop_all();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn grove_s_graph_becomes_the_page_s_long_history() {
        // As grove 0.1.1 gave it, cut to three buckets.
        let data = serde_json::json!({
            "bucket_ms": 360000, "machine": "cedar01", "samples": 2,
            "since": "2026-10-07T09:17:22.513Z", "until": "2026-10-07T10:17:22.513Z",
            "metrics": [
                { "metric": "cpu_pct", "unit": "%", "points": [null, 37.6, 12] },
                { "metric": "mem_used_pct", "unit": "%", "points": [null, 61.1, 60] },
                { "metric": "net_rx_bps", "unit": "B/s", "points": [null, 727916.7, null] },
                { "metric": "battery_pct", "unit": "%", "points": [null, null, null] },
            ],
        });
        let history = parse_graph("cedar-01", &data).unwrap();
        assert_eq!((history.since, history.bucket_ms, history.samples), (chrono::DateTime::parse_from_rfc3339("2026-10-07T09:17:22.513Z").unwrap().timestamp_millis(), 360_000, 2));
        assert_eq!(history.cpu, [None, Some(37.6), Some(12.0)]);
        assert_eq!(history.rx_bps, [None, Some(727916.7), None]);
        assert!(history.gpu_temp.is_empty(), "a metric grove didn't send is empty");
        assert!(parse_graph("cedar-01", &serde_json::json!({ "metrics": [] })).is_err());
    }

    #[test]
    fn grove_s_stored_samples_become_points_at_the_time_they_were_taken() {
        // As grove 0.1.4's `history --json` gives them, cut to what a reading needs; the second lacks memory.
        let sample = |taken_at: &str, cpu: f64| serde_json::json!({
            "taken_at": taken_at, "health": { "score": 91 }, "cpu_pct": cpu, "mem_total_kb": 1000, "mem_available_kb": 400,
            "mem_used_pct": 60, "disk_total_kb": 2000, "disk_used_kb": 500, "disk_used_pct": 25, "load1": 0.5,
            "net_rx_bps": 1200.5, "net_tx_bps": null,
        });
        let mut broken = sample("2026-10-07T10:16:00.000Z", 9.0);
        broken.as_object_mut().unwrap().remove("mem_total_kb");
        let data = serde_json::json!({ "machine": "cedar01", "samples": [sample("2026-10-07T10:17:00.000Z", 22.5), broken] });
        let points = parse_history(&data);
        assert_eq!(points.len(), 1, "a sample missing a reading is left out");
        let point = points[0];
        assert_eq!(point.t, chrono::DateTime::parse_from_rfc3339("2026-10-07T10:17:00.000Z").unwrap().timestamp_millis());
        assert_eq!((point.score, point.cpu, point.mem_used_kb, point.rx_bps, point.tx_bps), (91, Some(22.5), 600, Some(1200.5), None));
        assert!(parse_history(&serde_json::json!({})).is_empty());
    }

    /// The pinned Grove unpacks from the checkout's bundle into a throwaway home and answers as its version. Ignored
    /// because it needs `scripts/build-release.sh`'s fetch first.
    #[test]
    #[ignore]
    fn the_pinned_grove_unpacks_and_answers_as_its_version() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let bundle = bundle_in(&root.join(VERSION_FILE), &root.join(SOURCE_FOLDER)).expect("grove-version.txt names a release");
        let home = temp_dir("prepare");
        let grove = prepare(Some(bundle.clone()), &home).unwrap();
        assert!(grove.bin.starts_with(&home));
        // A second start reuses what's unpacked.
        assert_eq!(prepare(Some(bundle), &home).unwrap().bin, grove.bin);
        assert!(prepare(None, &home).unwrap_err().contains("doesn't carry Grove"));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The checkout's pinned release, as `scripts/build-release.sh` fetches it into `bundled-grove/`: both macOS
    /// builds of `grove` and every system's `grove-probe` are there, match their checksums and hold the one program
    /// each names. Ignored because it needs that fetch first.
    #[test]
    #[ignore]
    fn the_pinned_release_is_bundled_for_every_system() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let bundle = bundle_in(&root.join(VERSION_FILE), &root.join(SOURCE_FOLDER)).expect("grove-version.txt names a release");
        let wanted = [
            (Program::Grove, "darwin-arm64"),
            (Program::Grove, "darwin-x64"),
            (Program::Probe, "darwin-arm64"),
            (Program::Probe, "darwin-x64"),
            (Program::Probe, "linux-x64"),
            (Program::Probe, "linux-arm64"),
        ];
        for (program, target) in wanted {
            let bytes = archive(&bundle, program, target).unwrap();
            let mut tar = std::process::Command::new("tar").args(["-tzf", "-"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
            std::io::Write::write_all(&mut tar.stdin.take().unwrap(), &bytes).unwrap();
            let listing = String::from_utf8(tar.wait_with_output().unwrap().stdout).unwrap();
            assert_eq!(listing.trim(), program.name(), "{target}");
        }
    }
}

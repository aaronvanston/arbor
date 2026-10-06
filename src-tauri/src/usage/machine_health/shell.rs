//! Running scripts on machines. A caller names a machine and passes a script: this module
//! finds the machine (one the Machines page lists, reached over SSH or through `sh` when it's
//! this Mac, or this Mac when the page doesn't list it), waits for one of SCRIPT_SLOTS, runs
//! the script, notes the run in Diagnostics, and hands back what it printed or why it failed.

use super::*;
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

/// Scripts running on machines at once, all of them together, so a burst of scans and changes
/// can't open dozens of SSH sessions.
static SCRIPT_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);
#[cfg(test)]
static SCRIPT_ACTIVE: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
static SCRIPT_PEAK: AtomicUsize = AtomicUsize::new(0);

/// Streaming runs at once. They're long copies, so they have slots of their own and never keep
/// a scan waiting.
static STREAM_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// How much of what a streaming script wrote to stderr is kept, to say why it failed.
const STDERR_KEPT: usize = 4 << 10;

/// A machine scripts can run on.
#[derive(Clone, Debug)]
pub(in crate::usage) struct Machine {
    host: MachineHost,
    local: bool,
    /// On the Machines page, rather than this Mac when the page doesn't list it.
    listed: bool,
}

impl Machine {
    /// One the Machines page lists.
    pub(super) fn listed(series: &MachineSeries) -> Self {
        Self { host: series.host.clone(), local: series.local, listed: true }
    }

    /// This Mac when the Machines page doesn't list it, under the name its sessions and setup
    /// are filed under.
    pub(in crate::usage) fn this_mac(name: &str) -> Self {
        let host = MachineHost { machine: name.to_string(), endpoint: "localhost".into(), port: 22, enabled: true, source: String::new() };
        Self { host, local: true, listed: false }
    }

    #[cfg(test)]
    pub(in crate::usage) fn for_test(host: MachineHost) -> Self {
        Self { host, local: false, listed: true }
    }

    pub(in crate::usage) fn name(&self) -> &str {
        &self.host.machine
    }

    pub(in crate::usage) fn host(&self) -> &MachineHost {
        &self.host
    }

    /// This Mac, listed or not: its scripts run through `sh` rather than SSH.
    pub(in crate::usage) fn is_local(&self) -> bool {
        self.local
    }

    pub(in crate::usage) fn is_listed(&self) -> bool {
        self.listed
    }
}

impl From<&Machine> for MachineCommand {
    fn from(machine: &Machine) -> Self {
        machine_command(&machine.host, machine.local)
    }
}

/// Whether scripts can run on a machine the Machines page lists: it's on and it has somewhere to
/// reach it.
pub(super) fn runs_scripts(series: &MachineSeries) -> bool {
    series.host.enabled && !series.host.endpoint.trim().is_empty()
}

/// The machine called `name`: one the Machines page lists, or this Mac when the page doesn't
/// list it.
pub(super) fn find_machine(inner: &Inner, name: &str) -> Result<Machine, String> {
    match inner.series.get(name).filter(|series| runs_scripts(series)) {
        Some(series) => Ok(Machine::listed(series)),
        None if this_machine_name(inner).as_deref() == Some(name) => Ok(Machine::this_mac(name)),
        None => Err(not_checked(name)),
    }
}

/// What a caller says when it can't find a machine by its name.
pub(in crate::usage) fn not_checked(name: &str) -> String {
    format!("Arbor isn't checking a machine called {name}")
}

/// The name this machine's transcripts and setup are stored under when the Machines page doesn't
/// list it, or None when it does.
pub(super) fn this_machine_name(inner: &Inner) -> Option<String> {
    let listed = inner.series.values().any(|series| series.local && series.host.enabled);
    (!listed).then(|| inner.local_names.first().cloned().unwrap_or_else(|| "localhost".into()))
}

fn control_socket_dir() -> Option<PathBuf> {
    // Unix sockets cap paths near 104 bytes, so the control directory has to
    // stay short: the app data directory under Application Support is too long.
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let dir = home.join(".cache").join("arbor");
    fs::create_dir_all(&dir).ok()?;
    // Versions before 0.3.200 kept these sockets under the upstream app's name. Nothing reads the old folder now, and
    // an SSH connection still using a socket there carries on until it times out.
    static OLD_DIR_REMOVED: std::sync::Once = std::sync::Once::new();
    OLD_DIR_REMOVED.call_once(|| {
        let _ = fs::remove_dir_all(home.join(".cache").join("cpa-gui"));
    });
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Some(dir)
}

/// A script's way onto one machine: SSH for a remote one, `sh` for this Mac. It carries the
/// machine's name so Diagnostics can say where each run went. A bare shell command, as tests
/// use, has none, and its runs aren't noted.
pub(in crate::usage) struct MachineCommand {
    command: tokio::process::Command,
    machine: Option<String>,
}

impl MachineCommand {
    /// The machine it runs on, or empty for a bare shell command, which reads the homes every machine has.
    pub(in crate::usage) fn machine_name(&self) -> &str {
        self.machine.as_deref().unwrap_or_default()
    }

    #[cfg(test)]
    pub(in crate::usage) fn named(command: tokio::process::Command, machine: &str) -> Self {
        Self { command, machine: Some(machine.to_string()) }
    }
}

impl From<tokio::process::Command> for MachineCommand {
    fn from(command: tokio::process::Command) -> Self {
        Self { command, machine: None }
    }
}

fn machine_command(host: &MachineHost, local: bool) -> MachineCommand {
    let mut command = if local {
        tokio::process::Command::new("sh")
    } else {
        let mut command = tokio::process::Command::new("ssh");
        command
            .arg("-p")
            .arg(host.port.to_string())
            .arg("-T")
            .arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("ConnectTimeout=5")
            .arg("-o")
            .arg("StrictHostKeyChecking=accept-new")
            .arg("-o")
            .arg("ServerAliveInterval=15");
        #[cfg(unix)]
        if let Some(dir) = control_socket_dir() {
            command
                .arg("-o")
                .arg("ControlMaster=auto")
                .arg("-o")
                .arg(format!("ControlPath={}", dir.join("cm-%C").display()))
                .arg("-o")
                .arg("ControlPersist=120");
        }
        command.arg("--").arg(host.endpoint.trim()).arg("sh");
        command
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_helper_command(&mut command);
    MachineCommand { command, machine: Some(host.machine.clone()) }
}

/// Readies a quick helper process: none of Arbor's open files, marked in Arbor only so it still starts the quick way
/// (see `keep_open_files_from_helpers`).
pub(crate) fn configure_helper_command(command: &mut tokio::process::Command) {
    // Nothing is set on the command itself: the marks are on Arbor's own files.
    let _ = command;
    crate::keep_open_files_from_helpers();
}

/// Runs a script on a machine once one of SCRIPT_SLOTS is free, and notes in Diagnostics how
/// long it took and how it ended. Only the machine's name, the operation's name, the time and
/// the exit status are noted: never the script or what it printed. For a script that reports
/// how each of its items went, which the caller reads whatever the exit status; `run_checked`
/// is for the rest.
pub(in crate::usage) async fn run_on_machine(
    target: impl Into<MachineCommand>,
    op: MachineOp,
    script: &str,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let MachineCommand { command, machine } = target.into();
    let _slot = SCRIPT_SLOTS.acquire().await.map_err(|error| error.to_string())?;
    #[cfg(test)]
    let _active = ScriptActiveGuard::new();
    let started = Instant::now();
    let finished = run_script_within(command, script, timeout).await;
    if let Some(machine) = machine {
        diagnostics::record(diagnostics::machine_call(&machine, op, started.elapsed(), finished.as_ref()));
    }
    finished.unwrap_or_else(|| Err(timed_out(timeout)))
}

#[cfg(test)]
struct ScriptActiveGuard;

#[cfg(test)]
impl ScriptActiveGuard {
    fn new() -> Self {
        let active = SCRIPT_ACTIVE.fetch_add(1, Ordering::SeqCst) + 1;
        SCRIPT_PEAK.fetch_max(active, Ordering::SeqCst);
        Self
    }
}

#[cfg(test)]
impl Drop for ScriptActiveGuard {
    fn drop(&mut self) {
        SCRIPT_ACTIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

/// `run_on_machine` for a script whose exit status says whether it worked: what it printed, or
/// why it failed.
pub(in crate::usage) async fn run_checked(
    target: impl Into<MachineCommand>,
    op: MachineOp,
    script: &str,
    timeout: Duration,
) -> Result<String, String> {
    let output = run_on_machine(target, op, script, timeout).await?;
    if !output.status.success() {
        return Err(failure_detail(&output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn timed_out(timeout: Duration) -> String {
    format!("Timed out after {}s", timeout.as_secs())
}

/// Runs a script on a machine and hands what it prints to `sink` as it arrives, for output too
/// big to hold whole or too slow to wait for: it's only given up on when it prints nothing for
/// `idle`. It waits for one of STREAM_SLOTS, not SCRIPT_SLOTS, and Diagnostics notes it like any
/// other run. An error from `sink` stops the script. Ok once the script has exited cleanly.
pub(in crate::usage) async fn run_streaming(
    target: impl Into<MachineCommand>,
    op: MachineOp,
    script: &str,
    idle: Duration,
    sink: &mut dyn FnMut(&[u8]) -> Result<(), String>,
) -> Result<(), String> {
    let MachineCommand { mut command, machine } = target.into();
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let _slot = STREAM_SLOTS.acquire().await.map_err(|error| error.to_string())?;
    let started = Instant::now();
    let finished = stream_script(command, script, idle, sink).await;
    if let Some(machine) = machine {
        diagnostics::record(diagnostics::machine_call(&machine, op, started.elapsed(), finished.as_ref()));
    }
    match finished {
        None => Err(format!("Nothing arrived for {}s", idle.as_secs())),
        Some(Err(error)) => Err(error),
        Some(Ok(output)) if !output.status.success() => Err(failure_detail(&output)),
        Some(Ok(_)) => Ok(()),
    }
}

/// `run_streaming`'s run, with None when the script went quiet for too long. The output it
/// gives has the exit status and the end of stderr; stdout has gone to `sink`.
async fn stream_script(
    mut command: tokio::process::Command,
    script: &str,
    idle: Duration,
    sink: &mut dyn FnMut(&[u8]) -> Result<(), String>,
) -> Option<Result<std::process::Output, String>> {
    use tokio::io::AsyncReadExt;
    let program = command.as_std().get_program().to_string_lossy().into_owned();
    // Marked again: waiting for a slot, Arbor may have opened files since the command was made.
    #[cfg(target_os = "macos")]
    crate::keep_open_files_from_helpers();
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return Some(Err(format!("Could not start {program}: {error}"))),
    };
    let (Some(mut stdin), Some(mut stdout), Some(mut stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
        return Some(Err(format!("Could not talk to {program}")));
    };
    // The script goes in while its output comes out: a long script can start printing before
    // it has all been read, and waiting to finish sending it could leave both sides stuck.
    let script = script.to_owned();
    let sending = tokio::spawn(async move {
        let sent = stdin.write_all(script.as_bytes()).await;
        drop(stdin);
        sent
    });
    let errors = tokio::spawn(async move {
        let mut kept = Vec::new();
        let mut buf = [0u8; 4096];
        while let Ok(read) = stderr.read(&mut buf).await {
            if read == 0 {
                break;
            }
            kept.extend_from_slice(&buf[..read]);
            if kept.len() > STDERR_KEPT {
                kept.drain(..kept.len() - STDERR_KEPT);
            }
        }
        kept
    });
    let mut buf = vec![0u8; 256 << 10];
    loop {
        match tokio::time::timeout(idle, stdout.read(&mut buf)).await {
            Err(_) => return None,
            Ok(Err(error)) => return Some(Err(format!("Couldn't read what the script printed: {error}"))),
            Ok(Ok(0)) => break,
            Ok(Ok(read)) => {
                if let Err(error) = sink(&buf[..read]) {
                    return Some(Err(error));
                }
            }
        }
    }
    let status = match tokio::time::timeout(idle, child.wait()).await {
        Err(_) => return None,
        Ok(Err(error)) => return Some(Err(format!("The script failed: {error}"))),
        Ok(Ok(status)) => status,
    };
    if let Ok(Err(error)) = sending.await {
        if !status.success() {
            return Some(Err(format!("Could not send the script: {error}")));
        }
    }
    let stderr = errors.await.unwrap_or_default();
    Some(Ok(std::process::Output { status, stdout: Vec::new(), stderr }))
}

/// Feeds a script to a shell command and waits for it to finish, up to `timeout`, for tests
/// that run a feature's scripts in a local shell against a temp HOME.
#[cfg(test)]
pub(in crate::usage) async fn run_script(
    command: tokio::process::Command,
    script: &str,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    run_script_within(command, script, timeout)
        .await
        .unwrap_or_else(|| Err(timed_out(timeout)))
}

/// `run_script`, with None when the script ran out of time.
async fn run_script_within(
    mut command: tokio::process::Command,
    script: &str,
    timeout: Duration,
) -> Option<Result<std::process::Output, String>> {
    let program = command.as_std().get_program().to_string_lossy().into_owned();
    // Marked again: waiting for a slot, Arbor may have opened files since the command was made.
    #[cfg(target_os = "macos")]
    crate::keep_open_files_from_helpers();
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return Some(Err(format!("Could not start {program}: {error}"))),
    };
    let run = async {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(script.as_bytes())
                .await
                .map_err(|error| format!("Could not send the script: {error}"))?;
            drop(stdin);
        }
        child
            .wait_with_output()
            .await
            .map_err(|error| format!("The script failed: {error}"))
    };
    tokio::time::timeout(timeout, run).await.ok()
}

/// `value` as one word in a script, whatever it holds.
pub(in crate::usage) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Why a script failed: the last thing it (or SSH) wrote to stderr.
pub(in crate::usage) fn failure_detail(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .last()
        .map_or_else(|| format!("Exited with {}", output.status), str::to_string)
}

/// The shells a feature's scripts are tested under: `sh`, and `dash` where it's installed, as
/// Debian and Ubuntu machines run `sh` scripts with it.
#[cfg(test)]
pub(in crate::usage) fn shells() -> Vec<&'static str> {
    ["sh", "dash"].into_iter().filter(|shell| *shell == "sh" || Path::new("/bin/dash").exists()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(name: &str, enabled: bool) -> MachineHost {
        MachineHost { machine: name.into(), endpoint: format!("{name}.local"), port: 22, enabled, source: String::new() }
    }

    #[test]
    fn a_machine_is_found_on_the_machines_page_or_as_this_mac_when_the_page_leaves_it_off() {
        let state = MachineHealthState::default();
        state.lock().local_names = vec!["mini".into()];
        apply_hosts(&state, vec![host("cedar", true), host("off", false)]);
        let inner = state.lock();
        let cedar = find_machine(&inner, "cedar").unwrap();
        assert!(cedar.is_listed() && !cedar.is_local());
        assert_eq!(cedar.host().endpoint, "cedar.local");
        assert_eq!(find_machine(&inner, "off").unwrap_err(), not_checked("off"), "a machine that's turned off isn't run on");
        assert!(find_machine(&inner, "elsewhere").is_err());
        let mini = find_machine(&inner, "mini").unwrap();
        assert!(!mini.is_listed() && mini.is_local());
        drop(inner);

        // Once the page lists this Mac, it goes by the name the page gives it.
        state.lock().series.get_mut("cedar").unwrap().local = true;
        let inner = state.lock();
        assert!(find_machine(&inner, "mini").is_err());
        assert!(find_machine(&inner, "cedar").unwrap().is_local());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_script_gets_none_of_arbors_open_files() {
        use std::os::fd::AsRawFd;

        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let command = machine_command(&host("mini", true), true).command;
        // Opened after the command was made, as while it waits for a slot, and left inheritable, as Apple's frameworks
        // leave theirs; numbered past the ones a shell opens for itself.
        let file = fs::File::open("/dev/null").unwrap();
        let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD, 100) };
        assert!(fd >= 100);
        let script = format!("[ -e /dev/fd/{fd} ] && echo open || echo closed\n");
        let output = runtime.block_on(run_script(command, &script, Duration::from_secs(10)));
        unsafe { libc::close(fd) };
        assert_eq!(String::from_utf8_lossy(&output.unwrap().stdout).trim(), "closed");
    }

    #[test]
    fn a_checked_run_gives_what_the_script_printed_or_the_last_thing_it_said_went_wrong() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let here = Machine::this_mac("shell-test");
        let run = |script: &str| runtime.block_on(run_checked(&here, MachineOp::SetupScan, script, Duration::from_secs(10)));
        assert_eq!(run("echo one\necho two\n").unwrap(), "one\ntwo\n");
        assert_eq!(run("echo partial\necho 'first problem' >&2\necho 'last problem' >&2\nexit 3\n").unwrap_err(), "last problem");
        assert!(run("exit 4\n").unwrap_err().contains('4'), "a script that says nothing still gives its exit status");
        // A reporting script's output is read whatever its exit status.
        let output = runtime.block_on(run_on_machine(&here, MachineOp::PluginApply, "echo 'R\t0\tok'\nexit 1\n", Duration::from_secs(10))).unwrap();
        assert_eq!((output.status.code(), String::from_utf8_lossy(&output.stdout).as_ref()), (Some(1), "R\t0\tok\n"));
    }

    #[test]
    fn concurrent_script_peak_stays_at_the_shared_limit() {
        SCRIPT_ACTIVE.store(0, Ordering::SeqCst);
        SCRIPT_PEAK.store(0, Ordering::SeqCst);
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().unwrap();
        let target = Machine::this_mac("shell-test");
        runtime.block_on(async {
            let runs = (0..16).map(|_| {
                let target = target.clone();
                tokio::spawn(async move { run_on_machine(&target, MachineOp::SetupScan, "sleep 0.02", Duration::from_secs(2)).await })
            });
            for run in runs { run.await.unwrap().unwrap(); }
        });
        assert!(SCRIPT_PEAK.load(Ordering::SeqCst) <= 8);
    }

    #[test]
    fn a_streaming_run_hands_over_its_output_as_it_comes_and_stops_when_told_or_when_it_goes_quiet() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let here = Machine::this_mac("shell-test");
        let stream = |script: &str, idle: u64, limit: usize| {
            let mut got = Vec::new();
            let result = runtime.block_on(run_streaming(&here, MachineOp::ArchiveRead, script, Duration::from_secs(idle), &mut |bytes| {
                got.extend_from_slice(bytes);
                if got.len() > limit { Err("enough".to_string()) } else { Ok(()) }
            }));
            (result, got)
        };
        // More than a pipe holds, from a script longer than one, so neither side can wait on the other.
        let long = format!("{}head -c 3000000 /dev/zero\n", ": padding line for a long script\n".repeat(4_000));
        let (result, got) = stream(&long, 10, usize::MAX);
        assert_eq!((result, got.len()), (Ok(()), 3_000_000));
        assert_eq!(stream("echo out\necho 'what went wrong' >&2\nexit 2\n", 10, usize::MAX), (Err("what went wrong".into()), b"out\n".to_vec()));
        let (result, got) = stream("while :; do echo more; done\n", 10, 1 << 20);
        assert_eq!(result, Err("enough".into()));
        assert!(got.len() > 1 << 20);
        let (result, _) = stream("echo start\nsleep 5\necho late\n", 1, usize::MAX);
        assert_eq!(result, Err("Nothing arrived for 1s".into()));
    }
}

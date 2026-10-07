//! Opening a Terminal window on this Mac with an agent's own interactive session: Claude Code or Codex started on a
//! problem Arbor found, or an automation's run picked up where it left off. On the machine itself over SSH, or on this
//! Mac. Its user sees and approves each step; Arbor only starts it. The window runs a `.command` file that deletes
//! itself as it starts; ones that never ran are swept after a day.

use super::agents::AgentKind;
use super::shell::{find_machine, shell_quote};
use super::*;
use base64::Engine as _;

/// `.command` files older than this were never opened, so they're cleared away.
const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

/// Where a session starts: here, or on a machine reached over SSH.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Place {
    Local,
    Remote { endpoint: String, port: u16 },
}

/// How a session starts: where, and the shell line that starts it there, its words already quoted.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Launch {
    pub(super) place: Place,
    pub(super) line: String,
}

impl Launch {
    /// The same as one command to paste into a terminal on this Mac.
    pub(super) fn typed(&self) -> String {
        match &self.place {
            Place::Local => self.line.clone(),
            Place::Remote { endpoint, port } => {
                let port = if *port == 22 { String::new() } else { format!(" -p {port}") };
                format!("ssh -t{port} {} {}", shell_quote(endpoint.trim()), shell_quote(&self.line))
            }
        }
    }
}

/// The `.command` file Terminal runs. A remote machine's login shell may not be `sh` (fish quotes differently), so
/// the script it runs crosses as base64 piped into `sh`, and that script reads from the terminal again so the agent
/// is interactive. Through a bash, zsh or ksh login shell, the agent finds the PATH its user's shell sets up.
fn session_script(launch: &Launch, why: &str) -> String {
    let head = format!("#!/bin/sh\n# Opened by Arbor {why}. It deletes itself as it starts.\nrm -f -- \"$0\"\n");
    match &launch.place {
        Place::Local => format!("{head}{}\n", launch.line),
        Place::Remote { endpoint, port } => {
            let remote = format!(
                "exec </dev/tty\ncase \"${{SHELL##*/}}\" in\n  bash|zsh|ksh) exec \"$SHELL\" -lc {quoted} ;;\nesac\n{line}\n",
                quoted = shell_quote(&launch.line),
                line = launch.line,
            );
            let encoded = base64::engine::general_purpose::STANDARD.encode(remote);
            format!(
                "{head}exec ssh -t -p {port} -- {} {}\n",
                shell_quote(endpoint.trim()),
                shell_quote(&format!("echo {encoded} | base64 -d | sh")),
            )
        }
    }
}

/// Where a session on `machine` starts: here when it's this Mac, over SSH otherwise.
pub(super) fn place_of(inner: &Inner, machine: &str) -> Result<Place, String> {
    let target = find_machine(inner, machine)?;
    if target.is_local() {
        return Ok(Place::Local);
    }
    let host = target.host();
    Ok(Place::Remote { endpoint: host.endpoint.clone(), port: host.port })
}

/// The agent's program on `machine` as its last agents check found it, or its name.
pub(super) fn agent_program(inner: &Inner, machine: &str, agent: AgentKind) -> String {
    inner.series.get(machine).and_then(|series| series.agents.path_of(agent)).unwrap_or(agent.command()).to_string()
}

/// Where the session starts. `on_machine` is where the webview's prompt says it runs; on the machine it needs the
/// agent installed there, and elsewhere it runs on this Mac with the agent this Mac's checks found, or by its name.
fn plan_launch(inner: &Inner, machine: &str, agent: AgentKind, prompt: &str, on_machine: bool) -> Result<Launch, String> {
    let line = |program: &str| format!("exec {} {}", shell_quote(program), shell_quote(prompt));
    let local = || {
        let program = inner
            .series
            .values()
            .find(|series| series.local && series.host.enabled)
            .and_then(|series| series.agents.path_of(agent))
            .unwrap_or(agent.command());
        Launch { place: Place::Local, line: line(program) }
    };
    if !on_machine {
        return Ok(local());
    }
    let place = place_of(inner, machine)?;
    if place == Place::Local {
        return Ok(local());
    }
    let program = inner
        .series
        .get(machine)
        .and_then(|series| series.agents.path_of(agent))
        .ok_or_else(|| format!("{} isn't installed on {machine}", agent.label()))?;
    Ok(Launch { place, line: line(program) })
}

fn sessions_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("HOME isn't set")?;
    let dir = home.join(".cache").join("arbor").join("fix-sessions");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

fn sweep_stale(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > STALE_AFTER);
        if old && entry.path().extension().is_some_and(|extension| extension == "command") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// What a window shows when macOS wouldn't start Terminal.
const TERMINAL_FAILED: &str = "macOS wouldn’t start Terminal. Check that Terminal is in Applications › Utilities, then try again.";

/// Opens a Terminal window on this Mac running `launch`. `name` goes in the file's name and `why` in its comment.
pub(super) fn open_in_terminal(app: &tauri::AppHandle, launch: &Launch, name: &str, why: &str) -> Result<(), String> {
    let dir = sessions_dir()?;
    sweep_stale(&dir);
    let path = dir.join(format!("{name}-{}.command", Local::now().timestamp_millis()));
    {
        use std::io::Write as _;
        #[cfg(unix)]
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o700);
        let mut file = options.open(&path).map_err(|error| error.to_string())?;
        file.write_all(session_script(launch, why).as_bytes()).map_err(|error| error.to_string())?;
    }
    // The OS's own words ("no application can open the file") say nothing a person can act on, so they go to the log
    // and the window gets what to check.
    crate::system_open::open_with_system(app, &path.to_string_lossy(), Some("Terminal")).map_err(|error| {
        eprintln!("Couldn't open Terminal: {error}");
        TERMINAL_FAILED.to_string()
    })
}

/// Opens Terminal with `agent` started on `prompt`, on the machine when `on_machine` and on this Mac otherwise.
#[tauri::command]
pub(crate) fn open_fix_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    agent: AgentKind,
    prompt: String,
    on_machine: bool,
) -> Result<(), String> {
    let launch = plan_launch(&state.lock(), &machine, agent, &prompt, on_machine)?;
    open_in_terminal(&app, &launch, &format!("fix-{}", agent.command()), "to fix a problem it found on a machine")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decoded_remote(script: &str) -> String {
        let encoded = script.split("echo ").nth(1).and_then(|rest| rest.split(' ').next()).unwrap();
        String::from_utf8(base64::engine::general_purpose::STANDARD.decode(encoded).unwrap()).unwrap()
    }

    fn launch(place: Place, program: &str, prompt: &str) -> Launch {
        Launch { place, line: format!("exec {} {}", shell_quote(program), shell_quote(prompt)) }
    }

    fn sh(script: &str) -> String {
        String::from_utf8_lossy(&std::process::Command::new("sh").arg("-c").arg(script).output().unwrap().stdout).into_owned()
    }

    #[test]
    fn a_local_session_runs_the_agent_with_the_prompt_as_one_word() {
        let script = session_script(&launch(Place::Local, "/opt/agents/claude", "Fix it's swap"), "to fix it");
        assert!(script.starts_with("#!/bin/sh\n# Opened by Arbor to fix it."));
        assert!(script.contains("rm -f -- \"$0\"\n"));
        assert!(script.ends_with("exec '/opt/agents/claude' 'Fix it'\\''s swap'\n"));
    }

    #[test]
    fn a_remote_session_crosses_as_base64_and_reads_the_terminal() {
        let place = Place::Remote { endpoint: " cam@cam-mbp ".into(), port: 2222 };
        let script = session_script(&launch(place, "~/bin/codex", "Look at \"$HOME\" and `disk`"), "to fix it");
        assert!(script.contains("exec ssh -t -p 2222 -- 'cam@cam-mbp' 'echo "));
        assert!(script.contains(" | base64 -d | sh'\n"));
        let remote = decoded_remote(&script);
        assert!(remote.starts_with("exec </dev/tty\n"));
        assert!(remote.contains("  bash|zsh|ksh) exec \"$SHELL\" -lc '"), "{remote}");
        assert!(remote.ends_with("exec '~/bin/codex' 'Look at \"$HOME\" and `disk`'\n"));
    }

    #[test]
    fn the_remote_script_runs_under_sh_and_a_login_shell() {
        let place = Place::Remote { endpoint: "cam-mbp".into(), port: 22 };
        let remote = decoded_remote(&session_script(&launch(place, "/bin/echo", "it's \"fine\""), "to fix it"));
        // Without the terminal and login shell: the rest of the script, as the far side's sh reads it.
        let body = remote.lines().skip(4).collect::<Vec<_>>().join("\n");
        assert_eq!(sh(&body), "it's \"fine\"\n");
        // And the line a bash or zsh login shell is handed with -lc.
        let quoted = remote.lines().nth(2).unwrap().split("-lc ").nth(1).unwrap().trim_end_matches(" ;;");
        assert_eq!(sh(&format!("sh -c {quoted}")), "it's \"fine\"\n");
    }

    #[test]
    fn a_launch_typed_out_is_one_line_for_this_mac() {
        assert_eq!(launch(Place::Local, "claude", "hi").typed(), "exec 'claude' 'hi'");
        let remote = launch(Place::Remote { endpoint: " cam@cam-mbp ".into(), port: 2222 }, "/bin/echo", "it's");
        let typed = remote.typed();
        assert!(typed.starts_with("ssh -t -p 2222 'cam@cam-mbp' "), "{typed}");
        // What ssh would hand the far side's shell is the line itself.
        let handed = typed.trim_start_matches("ssh -t -p 2222 'cam@cam-mbp' ");
        assert_eq!(sh(&format!("printf '%s' {handed}")), remote.line);
        assert!(!launch(Place::Remote { endpoint: "cam-mbp".into(), port: 22 }, "a", "b").typed().contains("-p 22"));
    }

    fn state_with(machine: &str, endpoint: &str, local: bool) -> MachineHealthState {
        let state = MachineHealthState::default();
        let host = MachineHost { machine: machine.into(), endpoint: endpoint.into(), port: 22, enabled: true, source: String::new() };
        state.lock().series.insert(machine.into(), MachineSeries::new(host, local));
        state
    }

    #[test]
    fn a_session_on_a_machine_needs_its_agent_there() {
        let state = state_with("cam-mbp", "cam-mbp", false);
        let inner = state.lock();
        let error = plan_launch(&inner, "cam-mbp", AgentKind::Claude, "p", true).unwrap_err();
        assert_eq!(error, "Claude Code isn't installed on cam-mbp");
        assert!(plan_launch(&inner, "nobody", AgentKind::Claude, "p", true).is_err());
        assert_eq!(place_of(&inner, "cam-mbp").unwrap(), Place::Remote { endpoint: "cam-mbp".into(), port: 22 });
        assert_eq!(agent_program(&inner, "cam-mbp", AgentKind::Codex), "codex");
    }

    #[test]
    fn a_session_off_the_machine_runs_here_by_the_agents_name() {
        let state = state_with("cam-mbp", "cam-mbp", false);
        assert_eq!(plan_launch(&state.lock(), "cam-mbp", AgentKind::Codex, "p", false).unwrap(), launch(Place::Local, "codex", "p"));
        let local = state_with("this-mac", "localhost", true);
        assert_eq!(plan_launch(&local.lock(), "this-mac", AgentKind::Claude, "p", true).unwrap(), launch(Place::Local, "claude", "p"));
        assert_eq!(place_of(&local.lock(), "this-mac").unwrap(), Place::Local);
    }
}

//! Opening a Terminal window on this Mac with Claude Code or Codex started on a problem Arbor found: on the machine
//! itself over SSH, or on this Mac when the machine can't be reached or lacks the agent. The session is the agent's own
//! interactive one, so its user sees and approves each step; Arbor only starts it. The window runs a `.command` file
//! that deletes itself as it starts; ones that never ran are swept after a day.

use super::agents::AgentKind;
use super::shell::{find_machine, shell_quote};
use super::*;
use base64::Engine as _;

/// `.command` files older than this were never opened, so they're cleared away.
const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

/// How the session starts: the agent run here, or on a machine reached over SSH.
#[derive(Debug, PartialEq, Eq)]
enum Launch {
    Local { program: String },
    Remote { endpoint: String, port: u16, program: String },
}

/// The `.command` file Terminal runs. A remote machine's login shell may not be `sh` (fish quotes differently), so
/// the script it runs crosses as base64 piped into `sh`, and that script reads from the terminal again so the agent
/// is interactive. Through a bash, zsh or ksh login shell, the agent finds the PATH its user's shell sets up.
fn session_script(launch: &Launch, prompt: &str) -> String {
    let head = "#!/bin/sh\n# Opened by Arbor to fix a problem it found on a machine. It deletes itself as it starts.\nrm -f -- \"$0\"\n";
    match launch {
        Launch::Local { program } => format!("{head}exec {} {}\n", shell_quote(program), shell_quote(prompt)),
        Launch::Remote { endpoint, port, program } => {
            let remote = format!(
                "exec </dev/tty\ncase \"${{SHELL##*/}}\" in\n  bash|zsh|ksh) exec \"$SHELL\" -lc 'exec \"$0\" \"$1\"' {program} {prompt} ;;\nesac\nexec {program} {prompt}\n",
                program = shell_quote(program),
                prompt = shell_quote(prompt),
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

/// Where the session starts. `on_machine` is where the webview's prompt says it runs; on the machine it needs the
/// agent installed there, and elsewhere it runs on this Mac with the agent this Mac's checks found, or by its name.
fn plan_launch(inner: &Inner, machine: &str, agent: AgentKind, on_machine: bool) -> Result<Launch, String> {
    let local_program = || {
        inner
            .series
            .values()
            .find(|series| series.local && series.host.enabled)
            .and_then(|series| series.agents.path_of(agent))
            .unwrap_or(agent.command())
            .to_string()
    };
    if !on_machine {
        return Ok(Launch::Local { program: local_program() });
    }
    let target = find_machine(inner, machine)?;
    if target.is_local() {
        return Ok(Launch::Local { program: local_program() });
    }
    let program = inner
        .series
        .get(machine)
        .and_then(|series| series.agents.path_of(agent))
        .ok_or_else(|| format!("{} isn't installed on {machine}", agent.label()))?;
    let host = target.host();
    Ok(Launch::Remote { endpoint: host.endpoint.clone(), port: host.port, program: program.to_string() })
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
    let launch = plan_launch(&state.lock(), &machine, agent, on_machine)?;
    let dir = sessions_dir()?;
    sweep_stale(&dir);
    let path = dir.join(format!("fix-{}-{}.command", agent.command(), Local::now().timestamp_millis()));
    {
        use std::io::Write as _;
        #[cfg(unix)]
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o700);
        let mut file = options.open(&path).map_err(|error| error.to_string())?;
        file.write_all(session_script(&launch, &prompt).as_bytes()).map_err(|error| error.to_string())?;
    }
    crate::system_open::open_with_system(&app, &path.to_string_lossy(), Some("Terminal"))
        .map_err(|error| format!("Couldn't open Terminal: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decoded_remote(script: &str) -> String {
        let encoded = script.split("echo ").nth(1).and_then(|rest| rest.split(' ').next()).unwrap();
        String::from_utf8(base64::engine::general_purpose::STANDARD.decode(encoded).unwrap()).unwrap()
    }

    #[test]
    fn a_local_session_runs_the_agent_with_the_prompt_as_one_word() {
        let script = session_script(&Launch::Local { program: "/opt/agents/claude".into() }, "Fix it's swap");
        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.contains("rm -f -- \"$0\"\n"));
        assert!(script.ends_with("exec '/opt/agents/claude' 'Fix it'\\''s swap'\n"));
    }

    #[test]
    fn a_remote_session_crosses_as_base64_and_reads_the_terminal() {
        let launch = Launch::Remote { endpoint: " casey@casey-mbp ".into(), port: 2222, program: "~/bin/codex".into() };
        let script = session_script(&launch, "Look at \"$HOME\" and `disk`");
        assert!(script.contains("exec ssh -t -p 2222 -- 'casey@casey-mbp' 'echo "));
        assert!(script.contains(" | base64 -d | sh'\n"));
        let remote = decoded_remote(&script);
        assert!(remote.starts_with("exec </dev/tty\n"));
        assert!(remote.contains("exec \"$SHELL\" -lc 'exec \"$0\" \"$1\"' '~/bin/codex' 'Look at \"$HOME\" and `disk`' ;;"));
        assert!(remote.ends_with("exec '~/bin/codex' 'Look at \"$HOME\" and `disk`'\n"));
    }

    #[test]
    fn the_remote_script_runs_under_sh() {
        let launch = Launch::Remote { endpoint: "casey-mbp".into(), port: 22, program: "/bin/echo".into() };
        let remote = decoded_remote(&session_script(&launch, "it's fine"));
        // Without the terminal and login shell: the rest of the script, as the far side's sh reads it.
        let body = remote.lines().skip(4).collect::<Vec<_>>().join("\n");
        let output = std::process::Command::new("sh").arg("-c").arg(&body).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), "it's fine\n");
    }

    fn state_with(machine: &str, endpoint: &str, local: bool) -> MachineHealthState {
        let state = MachineHealthState::default();
        let host = MachineHost { machine: machine.into(), endpoint: endpoint.into(), port: 22, enabled: true, source: String::new() };
        state.lock().series.insert(machine.into(), MachineSeries::new(host, local));
        state
    }

    #[test]
    fn a_session_on_a_machine_needs_its_agent_there() {
        let state = state_with("casey-mbp", "casey-mbp", false);
        let inner = state.lock();
        let error = plan_launch(&inner, "casey-mbp", AgentKind::Claude, true).unwrap_err();
        assert_eq!(error, "Claude Code isn't installed on casey-mbp");
        assert!(plan_launch(&inner, "nobody", AgentKind::Claude, true).is_err());
    }

    #[test]
    fn a_session_off_the_machine_runs_here_by_the_agents_name() {
        let state = state_with("casey-mbp", "casey-mbp", false);
        assert_eq!(plan_launch(&state.lock(), "casey-mbp", AgentKind::Codex, false).unwrap(), Launch::Local { program: "codex".into() });
        let local = state_with("this-mac", "localhost", true);
        assert_eq!(plan_launch(&local.lock(), "this-mac", AgentKind::Claude, true).unwrap(), Launch::Local { program: "claude".into() });
    }
}

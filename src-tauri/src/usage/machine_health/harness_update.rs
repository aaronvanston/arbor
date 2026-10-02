//! Updating a harness other than Claude Code and Codex on a machine with its own update command (`pi update`,
//! `opencode upgrade`…), which the catalog names. Claude Code and Codex update by how they were installed, in
//! `agents`; these update themselves however they were installed, so there's nothing to work out first.

use super::agents::{output_tail, AGENT_ENV};
use super::harnesses::Harness;
use super::*;
use std::collections::BTreeSet;
use std::sync::{LazyLock, Mutex};
use ts_rs::TS;

const UPDATE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// The (machine, harness) pairs being updated, so one isn't started twice.
static UPDATING: LazyLock<Mutex<BTreeSet<(String, Harness)>>> = LazyLock::new(Default::default);

// Expects `agent` (the command), `word` (its update command) and `version` (what prints its version). An agent
// without the update command would take the word as a prompt and start working on it, so its help has to list the
// word as a command first. Lines out: `arbor_before=` and `arbor_after=` with what the version command printed,
// around what the update printed; it exits as the update did.
const UPDATE_SCRIPT: &str = r##"bin=$(command -v "$agent" 2>/dev/null || true)
case "$bin" in
  /*) ;;
  *) printf '%s is not installed where Arbor looks for it\n' "$agent" >&2; exit 127 ;;
esac
real=$(realpath "$bin" 2>/dev/null || readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")
case "$real" in
  */lib/node_modules/*) PATH="${real%%/lib/node_modules/*}/bin:$PATH"; export PATH ;;
esac
if ! "$bin" --help </dev/null 2>/dev/null | grep -Eq "^[[:space:]]+($agent[[:space:]]+)?$word([[:space:]|,<\[]|\$)"; then
  printf 'This version of %s has no %s command. Update it the way it was installed.\n' "$agent" "$word" >&2
  exit 2
fi
printf 'arbor_before=%s\n' "$("$bin" $version </dev/null 2>/dev/null | head -n 1)"
"$bin" "$word" </dev/null 2>&1
status=$?
printf 'arbor_after=%s\n' "$("$bin" $version </dev/null 2>/dev/null | head -n 1)"
exit $status
"##;

/// The command that updates a harness, as the page shows it and its user says yes to.
pub(super) fn update_command(harness: Harness) -> Option<String> {
    let spec = harness.spec();
    spec.update_arg.map(|word| format!("{} {word}", spec.binary))
}

/// The update, without the agents' usual folders put on PATH first.
fn update_body(harness: Harness) -> Option<String> {
    let spec = harness.spec();
    let word = spec.update_arg?;
    Some(format!("agent={}\nword={word}\nversion={}\n{UPDATE_SCRIPT}", spec.binary, spec.version_arg))
}

fn update_script(harness: Harness) -> Option<String> {
    update_body(harness).map(|body| format!("{AGENT_ENV}{body}"))
}

/// What an update did, for the page.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessUpdate {
    before: Option<String>,
    after: Option<String>,
    /// The end of what the update printed.
    output: String,
}

/// The versions before and after, and what the update printed in between.
fn read_update(stdout: &str) -> (Option<String>, Option<String>, String) {
    let (mut before, mut after) = (None, None);
    let mut printed = String::new();
    for line in stdout.lines() {
        if let Some(found) = line.strip_prefix("arbor_before=") {
            before = agents::parse_version(found);
        } else if let Some(found) = line.strip_prefix("arbor_after=") {
            after = agents::parse_version(found);
        } else {
            printed.push_str(line);
            printed.push('\n');
        }
    }
    (before, after, output_tail(&printed))
}

/// Updates a harness on the machine with its own update command. `command` is what its user was shown, and
/// nothing runs if the harness now updates another way. The page scans the machine again afterwards for the
/// version it ended up on.
#[tauri::command]
pub(crate) async fn update_machine_harness(
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    harness: Harness,
    command: String,
) -> Result<HarnessUpdate, String> {
    let label = harness.spec().id;
    let (Some(expected), Some(script)) = (update_command(harness), update_script(harness)) else {
        return Err(format!("Arbor doesn't update {label}"));
    };
    if command != expected {
        return Err(format!("{label} now updates with {expected} instead. Look at it again, then update."));
    }
    let target = find_machine(&state.lock(), &machine)?;
    let key = (machine.clone(), harness);
    if !UPDATING.lock().map_err(|error| error.to_string())?.insert(key.clone()) {
        return Err(format!("{label} is already being updated on {machine}"));
    }
    let ran = run_on_machine(&target, MachineOp::AgentUpdate, &script, UPDATE_TIMEOUT).await;
    if let Ok(mut updating) = UPDATING.lock() {
        updating.remove(&key);
    }
    let output = ran?;
    let (before, after, printed) = read_update(&String::from_utf8_lossy(&output.stdout));
    if output.status.success() {
        Ok(HarnessUpdate { before, after, output: printed })
    } else if printed.is_empty() {
        Err(failure_detail(&output))
    } else {
        Err(printed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    #[test]
    fn each_harness_updates_with_its_own_command() {
        assert_eq!(update_command(Harness::Pi).as_deref(), Some("pi update"));
        assert_eq!(update_command(Harness::OpenCode).as_deref(), Some("opencode upgrade"));
        assert_eq!(update_command(Harness::Amp).as_deref(), Some("amp update"));
        assert_eq!(update_command(Harness::Claude), None, "Claude Code updates by how it was installed");
        assert_eq!(update_command(Harness::Gemini), None);
    }

    #[test]
    fn the_versions_come_apart_from_what_it_printed() {
        let (before, after, printed) = read_update("arbor_before=0.70.2\nUpdating pi…\nDone\narbor_after=pi 0.71.0\n");
        assert_eq!((before.as_deref(), after.as_deref(), printed.as_str()), (Some("0.70.2"), Some("0.71.0"), "Updating pi…\nDone"));
    }

    /// Runs the update against a stand-in for the agent in a temporary home. Without AGENT_ENV, whose folders come
    /// first, so a real agent on this Mac is never found and run.
    fn run(home: &Path, harness: Harness) -> std::process::Output {
        Command::new("sh")
            .arg("-c")
            .arg(update_body(harness).unwrap())
            .env_clear()
            .env("HOME", home)
            .env("PATH", format!("{}:/usr/bin:/bin", home.join("bin").display()))
            .output()
            .unwrap()
    }

    fn stand_in(home: &Path, name: &str, script: &str) {
        let path = home.join("bin").join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    }

    #[test]
    fn it_updates_only_an_agent_whose_help_lists_the_command() {
        let home = std::env::temp_dir().join(format!("arbor-harness-update-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let ran = home.join("ran");
        // Its help lists `upgrade`, and it notes every time it's asked to do anything but print help or its version.
        stand_in(&home, "opencode", &format!(
            "#!/bin/sh\ncase \"$1\" in\n  --help) printf 'Commands:\\n  opencode upgrade [target]  upgrade opencode\\n' ;;\n  --version) cat \"{0}.v\" 2>/dev/null || echo 0.15.3 ;;\n  *) echo \"$1\" >> \"{0}\"; echo 0.16.0 > \"{0}.v\"; echo Upgraded ;;\nesac\n",
            ran.display()
        ));
        let output = run(&home, Harness::OpenCode);
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let (before, after, printed) = read_update(&String::from_utf8_lossy(&output.stdout));
        assert_eq!((before.as_deref(), after.as_deref(), printed.as_str()), (Some("0.15.3"), Some("0.16.0"), "Upgraded"));
        assert_eq!(fs::read_to_string(&ran).unwrap(), "upgrade\n");

        // One whose help doesn't list it would take the word as a prompt, so it's never run.
        stand_in(&home, "pi", &format!("#!/bin/sh\ncase \"$1\" in\n  --help) echo 'Usage: pi [message]' ;;\n  *) echo \"$1\" >> \"{}\" ;;\nesac\n", ran.display()));
        let output = run(&home, Harness::Pi);
        assert_eq!(output.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&output.stderr).contains("has no update command"));
        assert_eq!(fs::read_to_string(&ran).unwrap(), "upgrade\n", "pi was never given the word");

        // One that isn't installed.
        let output = run(&home, Harness::Amp);
        assert_eq!(output.status.code(), Some(127));
        let _ = fs::remove_dir_all(&home);
    }
}

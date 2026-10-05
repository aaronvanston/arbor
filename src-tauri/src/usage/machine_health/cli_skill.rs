//! Puts the `arbor` skill, which teaches agents the command line, into this Mac's agent homes: the store,
//! ~/.agents/skills, which Codex loads, and each Claude Code home with Sync on, which loads only its own skills
//! folder. `arbor` only reaches the Arbor running on this Mac, so the skill goes nowhere else.
//!
//! Each copy is written the way every change to a machine's files is (`guarded_writes`): backed up first, so the
//! whole install is one entry in Sync › Repo › Arbor's changes and can be undone. A home whose skills folder leads to the
//! store gets the store's copy, written once.

use super::agent_homes::{machines_to_scan, this_mac_name, tilde, HomeUse};
use super::guarded_writes::{base64_lines, cksum, edit_finish, edit_start, new_stamp, run_on, ChangeKind};
use super::setup::rescan;
use super::*;
use ts_rs::TS;

/// Where the store keeps it, from the home folder.
const STORE_FILE: &str = ".agents/skills/arbor/SKILL.md";

/// What installing the skill did, each place with the home folder as ~.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CliSkillInstall {
    pub(crate) written: Vec<String>,
    /// Already the skill as this Arbor has it.
    pub(crate) already: Vec<String>,
    pub(crate) failed: Vec<String>,
}

/// Whether the store holds the skill, and whether it's this Arbor's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CliSkillState {
    Missing,
    Current,
    /// An older Arbor's, or changed since.
    Outdated,
}

pub(crate) fn skill_state(home: &Path) -> CliSkillState {
    match fs::read(home.join(STORE_FILE)) {
        Ok(bytes) if bytes == crate::cli::SKILL.as_bytes() => CliSkillState::Current,
        Ok(_) => CliSkillState::Outdated,
        Err(_) => CliSkillState::Missing,
    }
}

// Lines out: `H home`, then for each place `P n path` and `E n how`, where how is edit's (ok, changed, failed) or
// `same` when it's the skill already. The store comes first; a place that resolves to one already written is skipped.
fn install_script(machine: &str, stamp: &str, skill: &[u8]) -> String {
    format!(
        "set -u\nexport LC_ALL=C\n{homes}{edits}\
         printf 'H\\t%s\\n' \"$HOME\"\n\
         payload=$(mktemp \"${{TMPDIR:-/tmp}}/arbor-skill.XXXXXX\") || exit 1\n\
         trap 'rm -f \"$payload\"' EXIT\n\
         cat > \"$payload\" <<'ARBOR_EOF'\n{base64}ARBOR_EOF\n\
         sum={sum}\n\
         n=0\n\
         seen=\n\
         place() {{\n\
         \x20 printf 'P\\t%s\\t%s\\n' \"$n\" \"$1\"\n\
         \x20 if ! mkdir -p \"${{1%/*}}\" 2>/dev/null; then printf 'E\\t%s\\tfailed\\n' \"$n\"; failed=1; n=$((n + 1)); return 0; fi\n\
         \x20 real=\"$(cd \"${{1%/*}}\" && pwd -P)/SKILL.md\"\n\
         \x20 case \"$seen\" in *\"|$real|\"*) printf 'E\\t%s\\tsame\\n' \"$n\"; n=$((n + 1)); return 0 ;; esac\n\
         \x20 seen=\"$seen|$real|\"\n\
         \x20 before=$(state_of \"$real\")\n\
         \x20 if [ \"$before\" = \"$sum\" ]; then printf 'E\\t%s\\tsame\\n' \"$n\"; else edit \"$n\" \"$real\" \"$before\" \"$sum\" < \"$payload\"; fi\n\
         \x20 n=$((n + 1))\n\
         }}\n\
         place \"$HOME/{STORE_FILE}\"\n\
         homes=$(agent_homes)\n\
         while IFS=$tab read -r agent home; do\n\
         \x20 [ \"$agent\" = claude ] && place \"$home/skills/arbor/SKILL.md\"\n\
         done <<ARBOR_HOMES\n$homes\nARBOR_HOMES\n\
         {finish}",
        homes = agent_homes::shell_function(machine, HomeUse::Sync),
        edits = edit_start(stamp, ChangeKind::Skills),
        base64 = base64_lines(skill),
        sum = shell::shell_quote(&cksum(skill)),
        finish = edit_finish(),
    )
}

fn parse_install(stdout: &str) -> CliSkillInstall {
    let home = stdout.lines().find_map(|line| line.strip_prefix("H\t")).unwrap_or_default();
    let mut paths = BTreeMap::new();
    let mut result = CliSkillInstall::default();
    for line in stdout.lines() {
        match line.split('\t').collect::<Vec<_>>().as_slice() {
            ["P", n, path] => {
                paths.insert(n.to_string(), tilde(path, home));
            }
            ["E", n, how] => {
                let Some(path) = paths.get(*n).cloned() else { continue };
                match *how {
                    "ok" => result.written.push(path),
                    "same" => result.already.push(path),
                    _ => result.failed.push(path),
                }
            }
            _ => {}
        }
    }
    result
}

/// Puts the skill in this Mac's store and its Claude Code homes, backed up so Sync › Repo › Arbor's changes can undo it.
#[tauri::command]
pub(crate) async fn install_cli_skill(app: tauri::AppHandle, state: tauri::State<'_, MachineHealthState>) -> Result<CliSkillInstall, String> {
    let target = {
        let inner = state.lock();
        let name = this_mac_name(&inner);
        machines_to_scan(&inner).into_iter().find(Machine::is_local).unwrap_or_else(|| Machine::this_mac(&name))
    };
    let stdout = run_on(&target, MachineOp::SkillsApply, &install_script(target.name(), &new_stamp(), crate::cli::SKILL.as_bytes())).await?;
    rescan(&app, target.name());
    let result = parse_install(&stdout);
    if result.written.is_empty() && result.already.is_empty() {
        return Err("Arbor couldn't write the skill anywhere on this Mac.".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_place_is_reported_by_what_happened_there() {
        let stdout = "H\t/Users/casey\nP\t0\t/Users/casey/.agents/skills/arbor/SKILL.md\nE\t0\tok\n\
                      P\t1\t/Users/casey/.claude/skills/arbor/SKILL.md\nE\t1\tsame\n\
                      P\t2\t/Users/casey/.agent-app/homes/work/skills/arbor/SKILL.md\nE\t2\tchanged\nK\tstamp\n";
        assert_eq!(
            parse_install(stdout),
            CliSkillInstall {
                written: vec!["~/.agents/skills/arbor/SKILL.md".into()],
                already: vec!["~/.claude/skills/arbor/SKILL.md".into()],
                failed: vec!["~/.agent-app/homes/work/skills/arbor/SKILL.md".into()],
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_skill_goes_in_the_store_and_each_claude_home_once_backed_up() {
        use std::os::unix::fs::symlink;
        let home = crate::cli::test_dir("skill");
        let home = fs::canonicalize(&home).unwrap();
        fs::create_dir_all(home.join(".claude")).unwrap();
        // A `*` only takes folders that look like a Claude Code home.
        fs::create_dir_all(home.join(".agent-app/homes/work/projects")).unwrap();
        fs::create_dir_all(home.join(".agents/skills")).unwrap();
        // A home whose skills folder is the store's gets the store's copy, written once.
        fs::create_dir_all(home.join(".agent-app/homes/linked/projects")).unwrap();
        symlink(home.join(".agents/skills"), home.join(".agent-app/homes/linked/skills")).unwrap();
        use agent_homes::{tests::{home as saved_home, save_on_this_thread}, AgentHomeKind};
        save_on_this_thread(vec![
            saved_home("casey-mbp", AgentHomeKind::Claude, "~/.claude", true, true),
            saved_home("casey-mbp", AgentHomeKind::Claude, "~/.agent-app/homes/*", true, true),
            saved_home("casey-mbp", AgentHomeKind::Codex, "~/.codex", true, true),
        ]);
        let script = install_script("casey-mbp", "20261002T000000Z-0001", b"# arbor\n");
        // A clean environment, so no CLAUDE_CONFIG_DIR or CODEX_HOME of whoever runs the tests is a home here; and
        // under dash as well as sh, since machines run either.
        let run = |shell: &str, script: &str| {
            let output = std::process::Command::new(shell)
                .arg("-c")
                .arg(script)
                .env_clear()
                .env("HOME", &home)
                .env("PATH", "/usr/bin:/bin")
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout).into_owned()
        };
        let first = parse_install(&run("sh", &script));
        assert_eq!(first.written, ["~/.agents/skills/arbor/SKILL.md", "~/.claude/skills/arbor/SKILL.md", "~/.agent-app/homes/work/skills/arbor/SKILL.md"]);
        assert_eq!(first.already, ["~/.agent-app/homes/linked/skills/arbor/SKILL.md"]);
        assert!(first.failed.is_empty());
        assert_eq!(fs::read_to_string(home.join(".claude/skills/arbor/SKILL.md")).unwrap(), "# arbor\n");
        assert!(!home.join(".codex/skills").exists(), "Codex loads the store");
        let backups: Vec<_> = fs::read_dir(home.join(".arbor/setup-backups")).unwrap().collect();
        assert_eq!(backups.len(), 1, "one change to undo");
        let again = parse_install(&run("sh", &script));
        if std::path::Path::new("/bin/dash").exists() {
            let dash = parse_install(&run("/bin/dash", &script));
            assert!(dash.written.is_empty() && dash.already.len() == 4, "{dash:?}");
        }
        assert!(again.written.is_empty() && again.already.len() == 4, "{again:?}");
    }
}

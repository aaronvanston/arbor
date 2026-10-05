//! Claude Code deletes a home's sessions once nobody has touched them for
//! cleanupPeriodDays, 30 by default: every time it starts, it removes the
//! transcripts, subagents, tool results and file history older than that. A
//! home that doesn't set it (an app's own home, a fresh machine) loses
//! its history a month at a time, before anything can keep a copy.
//!
//! Keeping a home's sessions sets cleanupPeriodDays in its settings.json, the
//! same careful way the reporter's hooks go in: read, changed here, written
//! back only if nothing changed it in between, with the copy before kept as a
//! change on the Setup page's list, which can undo it. Nothing else in the file
//! changes.

use super::attention::{edit_claude_settings, set_claude_setting, SettingsEdit};
use super::guarded_writes::ChangeKind;
use super::setup::{covered_machine, rescan, HomeAgent, ItemKind};
use super::*;

/// What a home is set to keep sessions for: about a hundred years.
const KEEP_DAYS: u64 = 36_500;
/// A home set to at least this many days is left as it is. The Setup page's check uses the same line.
const KEEP_AT_LEAST_DAYS: u64 = 3_650;

fn keep_every_session(content: Option<&str>) -> Result<Option<String>, String> {
    set_claude_setting(content, "cleanupPeriodDays", KEEP_DAYS.into(), |current| {
        current.and_then(Value::as_u64).is_some_and(|days| days >= KEEP_AT_LEAST_DAYS)
    })
}

/// Makes Claude Code keep every session in the given homes on a machine (named
/// as the Setup scan names them), then scans the machine again.
#[tauri::command]
pub(crate) async fn keep_claude_sessions(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    homes: Vec<String>,
) -> Result<Vec<SettingsEdit>, String> {
    let target = {
        let inner = state.lock();
        let (target, setup) = covered_machine(&inner, &machine)?;
        let known = setup.agent_homes();
        if let Some(home) = homes.iter().find(|home| !known.iter().any(|(agent, path)| *agent == HomeAgent::Claude && path == home)) {
            return Err(format!("Arbor hasn't found a Claude Code home at {home} on {machine}"));
        }
        setup.leave_to_policy(&machine, ItemKind::Setting, &["cleanupPeriodDays"])?;
        target
    };
    if homes.is_empty() {
        return Ok(Vec::new());
    }
    let result = edit_claude_settings(|| &target, &homes, ChangeKind::KeepSessions, keep_every_session, true).await;
    rescan(&app, &machine);
    result
}

#[cfg(test)]
mod tests {
    use super::super::attention::FileChange;
    use super::*;

    #[test]
    fn a_home_that_would_delete_sessions_is_set_to_keep_them_and_nothing_else_changes() {
        let settings = "{\n  \"model\": \"opus\",\n  \"cleanupPeriodDays\": 30,\n  \"hooks\": {}\n}\n";
        let kept = keep_every_session(Some(settings)).unwrap().unwrap();
        assert_eq!(kept, "{\n  \"model\": \"opus\",\n  \"cleanupPeriodDays\": 36500,\n  \"hooks\": {}\n}\n");
        assert_eq!(keep_every_session(None).unwrap().unwrap(), "{\n  \"cleanupPeriodDays\": 36500\n}\n");
        assert_eq!(keep_every_session(Some("\u{feff}{\"theme\":\"dark\"}")).unwrap().unwrap(), "\u{feff}{\n  \"theme\": \"dark\",\n  \"cleanupPeriodDays\": 36500\n}\n");
        // 0 once turned saving off altogether, and a word isn't a number of days.
        for odd in ["0", "\"30\"", "null"] {
            assert!(keep_every_session(Some(&format!("{{\"cleanupPeriodDays\":{odd}}}"))).unwrap().unwrap().contains("36500"), "{odd}");
        }
    }

    #[test]
    fn a_home_that_keeps_sessions_for_years_is_left_alone() {
        for days in [3_650, 36_500, 99_999] {
            assert_eq!(keep_every_session(Some(&format!("{{\"cleanupPeriodDays\":{days}}}"))).unwrap(), None);
        }
        assert!(keep_every_session(Some("[1]")).is_err());
        assert!(keep_every_session(Some("{not json")).is_err());
    }

    #[cfg(unix)]
    mod on_disk {
        use super::*;

        fn temp_home(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let home = std::env::temp_dir().join(format!("arbor-keep-{name}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&home).unwrap();
            fs::canonicalize(&home).unwrap()
        }

        fn shell(home: &Path) -> tokio::process::Command {
            let mut command = tokio::process::Command::new("sh");
            command
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            command
        }

        fn keep(home: &Path, homes: &[&str]) -> Result<Vec<SettingsEdit>, String> {
            let homes: Vec<String> = homes.iter().map(|home| home.to_string()).collect();
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(edit_claude_settings(|| shell(home), &homes, ChangeKind::KeepSessions, keep_every_session, true))
        }

        #[test]
        fn each_home_asked_for_is_kept_with_the_file_before_in_the_list_of_changes() {
            let home = temp_home("homes");
            let claude = home.join(".claude");
            agent_homes::tests::save_on_this_thread(vec![
                agent_homes::tests::home("", agent_homes::AgentHomeKind::Claude, "~/.agent-app/homes/*", true, true),
                agent_homes::tests::home("", agent_homes::AgentHomeKind::Codex, "~/.agent-app/homes/*", true, true),
            ]);
            let proxy = home.join(".agent-app/homes/claude-other");
            fs::create_dir_all(&claude).unwrap();
            fs::create_dir_all(proxy.join("projects")).unwrap();
            fs::create_dir_all(home.join(".codex")).unwrap();
            let before = "{\n  \"hooks\": {}\n}\n";
            fs::write(proxy.join("settings.json"), before).unwrap();

            let edits = keep(&home, &["~/.claude", "~/.agent-app/homes/claude-other"]).unwrap();
            let changes: Vec<(&str, FileChange, bool)> = edits.iter().map(|edit| (edit.home.as_str(), edit.change, edit.written)).collect();
            assert_eq!(changes, [("~/.claude", FileChange::Create, true), ("~/.agent-app/homes/claude-other", FileChange::Edit, true)]);
            assert_eq!(fs::read_to_string(claude.join("settings.json")).unwrap(), "{\n  \"cleanupPeriodDays\": 36500\n}\n");
            assert_eq!(fs::read_to_string(proxy.join("settings.json")).unwrap(), "{\n  \"hooks\": {},\n  \"cleanupPeriodDays\": 36500\n}\n");
            let backups = home.join(".arbor/setup-backups");
            let backup = fs::read_dir(&backups).unwrap().next().unwrap().unwrap().path();
            assert!(fs::read_to_string(backup.join("manifest")).unwrap().starts_with("what\tkeep-sessions\n"));
            assert_eq!(fs::read_to_string(backup.join("edits/1")).unwrap(), before);
            assert!(!home.join(".codex/config.toml").exists(), "Codex's home isn't touched");

            // Asking again changes nothing.
            let again = keep(&home, &["~/.agent-app/homes/claude-other"]).unwrap();
            assert_eq!(again.iter().map(|edit| (edit.change, edit.written)).collect::<Vec<_>>(), [(FileChange::Unchanged, false)]);
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn a_home_that_isnt_there_or_cant_be_read_is_said_so() {
            let home = temp_home("odd");
            fs::create_dir_all(home.join(".claude")).unwrap();
            fs::write(home.join(".claude/settings.json"), "{ broken").unwrap();
            let edits = keep(&home, &["~/.claude"]).unwrap();
            assert!(edits[0].error.as_deref().is_some_and(|error| error.contains("isn't valid JSON")), "{edits:?}");
            assert_eq!(fs::read_to_string(home.join(".claude/settings.json")).unwrap(), "{ broken");
            assert!(keep(&home, &["~/.agent-app/homes/claude-other"]).is_err());
            let _ = fs::remove_dir_all(&home);
        }
    }
}

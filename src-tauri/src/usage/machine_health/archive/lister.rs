//! Lists the session files in every agent home on a machine, for the archive.
//! One POSIX sh script does it everywhere, run through `sh` here and over
//! SSH on the others, so every machine is listed the same way. It prints
//! only paths and stat numbers, never what's in a file, and never reads
//! stdin after the script, so dash reading ahead can't swallow anything.
//!
//! Lines out, tab-separated:
//!   H os zstd sha free home   facts about the machine, and its $HOME
//!   R index agent days home   a home, with Claude Code's cleanupPeriodDays or -
//!   F index dev ino size mtime ctime path   a file, stat'ed through links
//!   L index path              that path is a link
//!   D index path              a link that leads nowhere
//!   K index count             names with a newline or tab in them, not listed
//!   O index / P index codes   the home was listed completely / only partly
//!   E                         the end
//!
//! Rust keeps only paths the allowlist below says are sessions, so a bug in
//! the script can never bring in settings or credentials.

use super::super::agent_homes::{self, HomeUse};
use super::super::attention::shell_quote;

pub(crate) const LIST_BODY: &str = r##"set -u
export LC_ALL=C
umask 077
renice -n 10 $$ >/dev/null 2>&1
command -v ionice >/dev/null 2>&1 && ionice -c 3 -p $$ >/dev/null 2>&1
work=$(mktemp -d "${TMPDIR:-/tmp}/arbor-archive.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT
nl='
'
if stat -L -c %s / >/dev/null 2>&1; then sf=-c; fmt='%d %i %s %Y %Z %n'; else sf=-f; fmt='%d %i %z %m %c %N'; fi
has() { command -v "$1" >/dev/null 2>&1; }
sha=none; if has sha256sum; then sha=sha256sum; elif has shasum; then sha=shasum; fi
printf 'H\t%s\t%s\t%s\t%s\t%s\n' "$(uname -s)" "$(has zstd && echo 1 || echo 0)" "$sha" "$(df -kP "$HOME" 2>/dev/null | awk 'NR==2{print $4}')" "$HOME"
retention() {
  d=$(grep -o '"cleanupPeriodDays"[[:space:]]*:[[:space:]]*[0-9][0-9]*' "$1/settings.json" 2>/dev/null | tail -n 1 | grep -o '[0-9][0-9]*$')
  printf '%s' "${d:--}"
}
walk1() {
  p=$2
  { [ -e "$p" ] || [ -L "$p" ]; } || return 0
  { find -L "$p" \( -name .git -o -name node_modules \) -prune -o -type f ! -path "*${nl}*" ! -path "*${tab}*" -exec stat -L $sf "$fmt" {} + 2>/dev/null; echo $? >> "$work/rc$1"; } | sed "s/^/F${tab}$1${tab}/"
  find -H "$p" -type l ! -path "*${nl}*" ! -path "*${tab}*" 2>/dev/null | sed "s/^/L${tab}$1${tab}/"
  find -L "$p" -type l ! -path "*${nl}*" ! -path "*${tab}*" 2>/dev/null | sed "s/^/D${tab}$1${tab}/"
  n=$(find -L "$p" \( -path "*${nl}*" -o -path "*${tab}*" \) -print 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" != 0 ]; then printf 'K\t%s\t%s\n' "$1" "$n"; fi
}
subs() {
  case $1 in
    claude) echo "projects file-history plans todos history.jsonl stats-cache.json" ;;
    codex) echo "sessions archived_sessions compacted-history session_index.jsonl history.jsonl" ;;
    # Only each local session's audit log: the sign-ins and settings beside it aren't looked at.
    claude-desktop) for a in "$2"/local_*/audit.jsonl; do if [ -f "$a" ]; then printf '%s\n' "${a#"$2"/}"; fi; done ;;
    *) echo "." ;;
  esac
}
list_homes | awk -F"$tab" '!seen[$2]++' > "$work/homes"
i=0
while IFS=$tab read -r agent home; do
  i=$((i + 1))
  printf 'R\t%s\t%s\t%s\t%s\n' "$i" "$agent" "$(retention "$home")" "$home"
  : > "$work/rc$i"
  for s in $(subs "$agent" "$home"); do walk1 "$i" "$home/$s"; done
  if [ -z "$(grep -v '^0$' "$work/rc$i")" ]; then printf 'O\t%s\n' "$i"; else printf 'P\t%s\t%s\n' "$i" "$(tr '\n' ' ' < "$work/rc$i")"; fi
done < "$work/homes"
printf 'E\n'
"##;

/// The script for `machine`'s agent homes with Sessions on.
pub(crate) fn list_script(machine: &str) -> String {
    homes_script(&agent_homes::shell_function(machine, HomeUse::Archive))
}

/// The script for the homes an `agent_homes` shell function lists.
fn homes_script(agent_homes: &str) -> String {
    format!("{agent_homes}list_homes() {{\n  agent_homes\n}}\n{LIST_BODY}")
}

/// The script for the given homes (agent and path each) and no others, such as the homes in an old backup.
pub(crate) fn roots_script(roots: &[(String, String)]) -> String {
    let mut homes = String::from("list_homes() {\n  :\n");
    for (agent, path) in roots {
        homes.push_str(&format!("  [ -d {path} ] && printf '%s\\t%s\\n' {agent} {path}\n", path = shell_quote(path), agent = shell_quote(agent)));
    }
    homes.push_str("}\n");
    format!("{}{homes}{LIST_BODY}", agent_homes::helpers())
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Listing {
    pub(crate) os: String,
    pub(crate) has_zstd: bool,
    pub(crate) sha_tool: String,
    pub(crate) free_kb: Option<u64>,
    /// The machine's home folder, which home labels are written from as `~`.
    pub(crate) home: Option<String>,
    pub(crate) roots: Vec<ListedRoot>,
    /// The script got to its end.
    pub(crate) ended: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ListedRoot {
    pub(crate) agent: String,
    pub(crate) home: String,
    /// Claude Code's cleanupPeriodDays, when the home sets it.
    pub(crate) retention_days: Option<u32>,
    pub(crate) files: Vec<ListedFile>,
    /// Links that lead nowhere, by path relative to the home.
    pub(crate) dangling: Vec<String>,
    pub(crate) unlistable: u64,
    pub(crate) complete: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ListedFile {
    /// Relative to the home.
    pub(crate) rel_path: String,
    pub(crate) dev: u64,
    pub(crate) ino: u64,
    pub(crate) size: u64,
    /// Seconds, from stat; this Mac re-reads nanoseconds itself.
    pub(crate) mtime: i64,
    pub(crate) ctime: i64,
    pub(crate) via_link: bool,
}

fn relative(home: &str, path: &str) -> Option<String> {
    let rest = path.strip_prefix(home)?.strip_prefix('/')?;
    // A home walked whole, as Pi's is, is walked from `.`.
    let rest = rest.strip_prefix("./").unwrap_or(rest);
    (!rest.is_empty() && rest != ".").then(|| rest.to_string())
}

pub(crate) fn parse(stdout: &str) -> Listing {
    let mut listing = Listing::default();
    let mut links: Vec<(usize, String)> = Vec::new();
    for line in stdout.lines() {
        let mut fields = line.splitn(2, '\t');
        let kind = fields.next().unwrap_or("");
        let rest = fields.next().unwrap_or("");
        match kind {
            "H" => {
                let parts: Vec<&str> = rest.splitn(5, '\t').collect();
                listing.os = parts.first().unwrap_or(&"").to_string();
                listing.has_zstd = parts.get(1) == Some(&"1");
                listing.sha_tool = parts.get(2).unwrap_or(&"").to_string();
                listing.free_kb = parts.get(3).and_then(|free| free.parse().ok());
                listing.home = parts.get(4).filter(|home| home.starts_with('/')).map(|home| home.to_string());
            }
            "R" => {
                let parts: Vec<&str> = rest.splitn(4, '\t').collect();
                if let [_, agent, days, home] = parts[..] {
                    listing.roots.push(ListedRoot { agent: agent.into(), home: home.into(), retention_days: days.parse().ok(), ..ListedRoot::default() });
                }
            }
            "F" | "L" | "D" | "K" | "O" | "P" => {
                let mut parts = rest.splitn(2, '\t');
                let Some(index) = parts.next().and_then(|index| index.parse::<usize>().ok()).and_then(|index| index.checked_sub(1)) else {
                    continue;
                };
                let value = parts.next().unwrap_or("");
                let Some(root) = listing.roots.get_mut(index) else {
                    continue;
                };
                match kind {
                    "F" => {
                        let numbers: Vec<&str> = value.splitn(6, ' ').collect();
                        if let [dev, ino, size, mtime, ctime, path] = numbers[..] {
                            let (Ok(dev), Ok(ino), Ok(size), Ok(mtime), Ok(ctime)) = (dev.parse(), ino.parse(), size.parse(), mtime.parse(), ctime.parse()) else {
                                continue;
                            };
                            if let Some(rel_path) = relative(&root.home, path) {
                                root.files.push(ListedFile { rel_path, dev, ino, size, mtime, ctime, via_link: false });
                            }
                        }
                    }
                    "L" => {
                        if let Some(rel) = relative(&root.home, value) {
                            links.push((index, rel));
                        }
                    }
                    "D" => root.dangling.extend(relative(&root.home, value)),
                    "K" => root.unlistable += value.trim().parse::<u64>().unwrap_or(0),
                    "O" => root.complete = true,
                    _ => root.complete = false,
                }
            }
            "E" => listing.ended = true,
            _ => {}
        }
    }
    for (index, rel) in links {
        if let Some(file) = listing.roots.get_mut(index).and_then(|root| root.files.iter_mut().find(|file| file.rel_path == rel)) {
            file.via_link = true;
        }
    }
    // A home listed more than once (a link and where it leads, say) keeps its first listing.
    listing
}

/// Whether a path in a home is one the archive keeps. Settings, credentials, caches and
/// anything else that can hold a secret or an environment are never kept, whatever lists them.
pub(crate) fn allowed(agent: &str, rel_path: &str) -> bool {
    let name = rel_path.rsplit('/').next().unwrap_or(rel_path);
    let never = ["auth.json", ".credentials.json", ".claude.json", "config.toml", ".env"];
    if never.contains(&name) || (name.starts_with("settings") && name.ends_with(".json")) || rel_path.split('/').any(|part| part == ".git" || part == "node_modules") {
        return false;
    }
    match agent {
        "claude" => {
            let top = rel_path.split('/').next().unwrap_or("");
            match top {
                "projects" | "file-history" | "plans" | "todos" => rel_path.contains('/'),
                _ => matches!(rel_path, "history.jsonl" | "stats-cache.json"),
            }
        }
        "codex" => {
            let top = rel_path.split('/').next().unwrap_or("");
            match top {
                "sessions" | "archived_sessions" => name.starts_with("rollout-") && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst")),
                "compacted-history" => rel_path.contains('/'),
                _ => matches!(rel_path, "session_index.jsonl" | "history.jsonl"),
            }
        }
        // Backups in other layouts (see `layouts`): their session files and nothing beside them.
        "openclaw" => matches!(rel_path.split('/').collect::<Vec<_>>()[..], ["sessions", name] if name.contains(".json")),
        // A Pi home is its sessions folder, one folder in it for each place Pi ran.
        "pi" => name.ends_with(".jsonl"),
        "claude-desktop" => matches!(rel_path.split('/').collect::<Vec<_>>()[..], [dir, "audit.jsonl"] if dir.starts_with("local_")),
        _ => false,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::ingest::tests::SECRET_TEXT;
    use super::super::store::tests::temp_dir;
    use super::super::super::agent_homes::{AgentHome, AgentHomeKind};
    use super::*;
    use std::fs;
    use std::path::Path;

    pub(crate) fn run_list(shell: &str, home: &Path, script: &str) -> String {
        let output = std::process::Command::new(shell)
            .env_clear()
            .env("HOME", home)
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                child.stdin.take().unwrap().write_all(script.as_bytes())?;
                child.wait_with_output()
            })
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8(output.stdout).unwrap()
    }

    /// The script for these homes, as though the list held them.
    pub(crate) fn list_script_with(saved: &[AgentHome]) -> String {
        homes_script(&agent_homes::shell_function_for(saved, "", HomeUse::Archive))
    }

    /// Homes a scan would have added: another app's homes for each agent, a desktop app's local sessions with a
    /// Claude Code home in each, and a third app's Claude Code home.
    pub(crate) fn scanned_homes() -> Vec<AgentHome> {
        use agent_homes::tests::home;
        use agent_homes::AgentHomeKind::{Claude, ClaudeDesktop, Codex};
        let desktop = "~/Library/Application Support/Claude/local-agent-mode-sessions/*/*";
        vec![
            home("", Claude, "~/.agent-app/homes/*", true, false),
            home("", Codex, "~/.agent-app/homes/*", true, false),
            home("", ClaudeDesktop, desktop, true, false),
            home("", Claude, &format!("{desktop}/local_*/.claude"), true, false),
            home("", Claude, "~/Library/Application Support/AcmeCode/claude", true, false),
        ]
    }

    fn shells() -> Vec<&'static str> {
        ["sh", "dash"].into_iter().filter(|shell| *shell == "sh" || Path::new("/bin/dash").exists()).collect()
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn lists_every_home_through_links_and_nothing_it_shouldnt() {
        let home = temp_dir("lister");
        let elsewhere = temp_dir("lister-elsewhere");
        let sid = "0f8b5c2e-1111-4222-8333-444455556666";
        write(&home.join(format!(".claude/projects/-Users-me-src-app/{sid}.jsonl")), "{}\n");
        write(&home.join(format!(".claude/projects/-Users-me-src-app/{sid}/subagents/agent-a1.jsonl")), "{}\n");
        write(&home.join(".claude/projects/-Users-me-src-app/with space.jsonl"), "{}\n");
        write(&home.join(".claude/settings.json"), "{\"cleanupPeriodDays\": 36500}\n");
        write(&home.join(".claude/.credentials.json"), "{}");
        write(&home.join(".claude/history.jsonl"), "{}\n");
        write(&home.join(".claude/shell-snapshots/snap.sh"), "export X=1\n");
        write(&home.join(".codex/sessions/2026/09/25/rollout-2026-09-25T10-00-00-thread1.jsonl"), "{}\n");
        write(&home.join(".codex/auth.json"), "{}");
        write(&home.join(".agent-app/homes/claude-other/projects/-x/b.jsonl"), "{}\n");
        write(&home.join(".agent-tool/profiles/work2/projects/-y/c.jsonl"), "{}\n");
        // A folder a pattern matches that doesn't look like a home isn't one.
        write(&home.join(".agent-tool/profiles/notes/todo.md"), "- x\n");
        write(&home.join(".pi/agent/sessions/--Users-me-src-app--/2026-07-19T07-00-00-000Z_s1.jsonl"), "{}\n");
        write(&home.join(".pi/agent/auth.json"), "{}");
        // A rollout moved to another disk and linked back, and a link to one that's gone.
        write(&elsewhere.join("rollout-2026-01-01T00-00-00-moved.jsonl"), "{}\n{}\n");
        let day = home.join(".codex/sessions/2026/01/01");
        fs::create_dir_all(&day).unwrap();
        std::os::unix::fs::symlink(elsewhere.join("rollout-2026-01-01T00-00-00-moved.jsonl"), day.join("rollout-2026-01-01T00-00-00-moved.jsonl")).unwrap();
        std::os::unix::fs::symlink(elsewhere.join("gone.jsonl"), day.join("rollout-2026-01-01T00-00-00-gone.jsonl")).unwrap();

        let mut homes = scanned_homes();
        homes.push(agent_homes::tests::home("", AgentHomeKind::Claude, "~/.agent-tool/profiles/*", true, false));
        homes.push(agent_homes::tests::home("", AgentHomeKind::Claude, &elsewhere.to_string_lossy(), true, false));
        let script = list_script_with(&homes);
        let mut outputs = Vec::new();
        for shell in shells() {
            let stdout = run_list(shell, &home, &script);
            assert!(!stdout.contains("cleanupPeriodDays\""), "no file text is printed");
            outputs.push(stdout);
        }
        // Every shell prints the same, but for the free space, which other tests change.
        let steady = |text: &str| text.lines().filter(|line| !line.starts_with("H\t")).collect::<Vec<_>>().join("\n");
        for pair in outputs.windows(2) {
            assert_eq!(steady(&pair[0]), steady(&pair[1]));
        }
        let listing = parse(&outputs[0]);
        assert!(listing.ended);
        assert!(!listing.sha_tool.is_empty());
        assert_eq!(listing.home.as_deref(), Some(home.to_string_lossy().as_ref()));
        let homes: Vec<(&str, &str)> = listing.roots.iter().map(|root| (root.agent.as_str(), root.home.as_str())).collect();
        let home_text = home.to_string_lossy();
        assert_eq!(
            homes,
            [
                ("claude", format!("{home_text}/.claude").as_str()),
                ("codex", format!("{home_text}/.codex").as_str()),
                ("pi", format!("{home_text}/.pi/agent/sessions").as_str()),
                ("claude", format!("{home_text}/.agent-app/homes/claude-other").as_str()),
                ("claude", format!("{home_text}/.agent-tool/profiles/work2").as_str()),
                ("claude", elsewhere.to_string_lossy().as_ref()),
            ]
        );
        let claude = &listing.roots[0];
        assert_eq!(claude.retention_days, Some(36_500));
        assert!(claude.complete);
        let mut kept: Vec<&str> = claude.files.iter().filter(|file| allowed("claude", &file.rel_path)).map(|file| file.rel_path.as_str()).collect();
        kept.sort();
        assert_eq!(
            kept,
            [
                "history.jsonl".to_string(),
                format!("projects/-Users-me-src-app/{sid}.jsonl"),
                format!("projects/-Users-me-src-app/{sid}/subagents/agent-a1.jsonl"),
                "projects/-Users-me-src-app/with space.jsonl".to_string(),
            ]
        );
        assert!(claude.files.iter().all(|file| !file.rel_path.contains("settings") && !file.rel_path.contains("credentials") && !file.rel_path.contains("shell-snapshots")));
        let codex = &listing.roots[1];
        assert_eq!(codex.retention_days, None);
        let moved = codex.files.iter().find(|file| file.rel_path.ends_with("moved.jsonl")).unwrap();
        assert!(moved.via_link);
        assert_eq!(moved.size, 6, "the size is where the link leads");
        assert_eq!(codex.dangling, ["sessions/2026/01/01/rollout-2026-01-01T00-00-00-gone.jsonl"]);
        assert!(codex.complete, "a link that leads nowhere doesn't make the listing partial");
        assert!(codex.files.iter().all(|file| allowed("codex", &file.rel_path)));
        // Pi's home is its sessions folder, so its sign-ins beside it aren't listed.
        let pi: Vec<&str> = listing.roots[2].files.iter().map(|file| file.rel_path.as_str()).collect();
        assert_eq!(pi, ["--Users-me-src-app--/2026-07-19T07-00-00-000Z_s1.jsonl"]);
        assert!(allowed("pi", pi[0]) && !allowed("pi", "auth.json") && !allowed("pi", "--a--/notes.md"));
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn lists_a_desktop_apps_local_sessions_and_the_homes_in_them() {
        let home = temp_dir("lister-desktop");
        let local = "local_0f8b5c2e-1111-4222-8333-444455556666";
        let sid = "1a2b3c4d-1111-4222-8333-444455556666";
        let org = home.join("Library/Application Support/Claude/local-agent-mode-sessions/acct/org");
        write(&org.join(format!("{local}/audit.jsonl")), "{}\n");
        write(&org.join(format!("{local}.json")), &format!("{{\"remoteMcpServersConfig\":\"{SECRET_TEXT}\"}}"));
        write(&org.join(format!("{local}/.audit-key")), SECRET_TEXT);
        write(&org.join(format!("{local}/outputs/report.py")), "print(1)\n");
        write(&org.join(format!("{local}/.claude/projects/-sessions-x/{sid}.jsonl")), "{}\n");
        write(&org.join(format!("{local}/.claude/.credentials.json")), SECRET_TEXT);
        // A session the app hasn't written an audit log for yet, and an account with no sessions.
        write(&org.join("local_2b2b3c4d-1111-4222-8333-444455556666/.claude/settings.json"), "{}\n");
        fs::create_dir_all(org.parent().unwrap().parent().unwrap().join("empty/org")).unwrap();
        let other = home.join("Library/Application Support/AcmeCode/claude");
        write(&other.join(format!("projects/-Users-me-app/{sid}.jsonl")), "{}\n");

        let script = list_script_with(&scanned_homes());
        let outputs: Vec<String> = shells().into_iter().map(|shell| run_list(shell, &home, &script)).collect();
        for stdout in &outputs {
            assert!(!stdout.contains(SECRET_TEXT) && !stdout.contains(".audit-key") && !stdout.contains("report.py"), "only audit logs are listed beside the sessions");
        }
        let listing = parse(&outputs[0]);
        let org_text = org.to_string_lossy();
        let homes: Vec<(&str, &str)> = listing.roots.iter().map(|root| (root.agent.as_str(), root.home.as_str())).collect();
        assert_eq!(
            homes,
            [
                ("claude-desktop", org_text.as_ref()),
                ("claude", format!("{org_text}/{local}/.claude").as_str()),
                ("claude", other.to_string_lossy().as_ref()),
            ]
        );
        let names = |index: usize| -> Vec<String> { listing.roots[index].files.iter().map(|file| file.rel_path.clone()).collect() };
        assert_eq!(names(0), [format!("{local}/audit.jsonl")]);
        assert!(names(0).iter().all(|rel| allowed("claude-desktop", rel)));
        assert_eq!(names(1), [format!("projects/-sessions-x/{sid}.jsonl")]);
        assert_eq!(names(2), [format!("projects/-Users-me-app/{sid}.jsonl")]);
        assert!(listing.roots.iter().all(|root| root.complete));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_roots_script_lists_only_the_homes_it_is_given() {
        let home = temp_dir("lister-roots");
        let backup = temp_dir("lister-backup");
        write(&home.join(".claude/projects/-a/x.jsonl"), "{}\n");
        write(&home.join(".codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-a.jsonl"), "{}\n");
        write(&backup.join("dot-claude/projects/-b/y.jsonl"), "{}\n");
        let root = backup.join("dot-claude").to_string_lossy().into_owned();
        let gone = backup.join("unplugged").to_string_lossy().into_owned();
        let script = roots_script(&[("claude".into(), root.clone()), ("codex".into(), gone)]);
        for shell in shells() {
            let listing = parse(&run_list(shell, &home, &script));
            assert!(listing.ended);
            let homes: Vec<(&str, &str)> = listing.roots.iter().map(|root| (root.agent.as_str(), root.home.as_str())).collect();
            assert_eq!(homes, [("claude", root.as_str())], "a home that isn't there isn't listed");
            assert_eq!(listing.roots[0].files.iter().map(|file| file.rel_path.as_str()).collect::<Vec<_>>(), ["projects/-b/y.jsonl"]);
        }
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&backup);
    }

    #[test]
    fn the_allowlist_keeps_sessions_and_nothing_that_can_hold_a_secret() {
        for path in ["projects/-a/x.jsonl", "projects/-a/x/tool-results/t.txt", "file-history/x/abc@v1", "todos/x.json", "plans/p.md", "history.jsonl", "stats-cache.json"] {
            assert!(allowed("claude", path), "{path}");
        }
        for path in ["settings.json", "settings.local.json", ".credentials.json", ".claude.json", "projects", "debug/log.txt", "shell-snapshots/s.sh", "projects/-a/.git/config", "projects/-a/settings.json", "session-env/x"] {
            assert!(!allowed("claude", path), "{path}");
        }
        for path in ["sessions/2026/09/25/rollout-x.jsonl", "archived_sessions/rollout-x.jsonl.zst", "compacted-history/x.jsonl", "session_index.jsonl", "history.jsonl"] {
            assert!(allowed("codex", path), "{path}");
        }
        for path in ["auth.json", "config.toml", "sessions/2026/x.json", "logs_2.sqlite", "state_5.sqlite", "sessions/auth.json"] {
            assert!(!allowed("codex", path), "{path}");
        }
        assert!(!allowed("other", "anything.jsonl"));
    }

    #[test]
    fn parses_what_the_script_prints() {
        let text = "H\tDarwin\t1\tshasum\t12345\t/Users/me\nR\t1\tclaude\t30\t/h/.claude\nF\t1\t16777232 99 10 1700000000 1700000001 /h/.claude/projects/-a/x y.jsonl\nL\t1\t/h/.claude/projects/-a/x y.jsonl\nK\t1\t2\nP\t1\t1 0\nF\t9\t1 2 3 4 5 /nowhere\nE\n";
        let listing = parse(text);
        assert_eq!((listing.os.as_str(), listing.has_zstd, listing.free_kb, listing.home.as_deref()), ("Darwin", true, Some(12345), Some("/Users/me")));
        let root = &listing.roots[0];
        assert_eq!(root.retention_days, Some(30));
        assert_eq!(root.files, [ListedFile { rel_path: "projects/-a/x y.jsonl".into(), dev: 16777232, ino: 99, size: 10, mtime: 1700000000, ctime: 1700000001, via_link: true }]);
        assert_eq!(root.unlistable, 2);
        assert!(!root.complete);
        assert!(listing.ended);
        assert!(!parse("H\tLinux\t0\tnone\t1\n").ended);
    }
}

//! Backups that aren't a copied agent home, found by their names and listed here rather than by
//! the shell script, since a backup is only ever on this Mac:
//!
//! - An OpenClaw agent folder: its own session files, and the Codex home it ran Codex in.
//! - Claude's desktop app's local sessions (Cowork): an audit log for each, and the Claude Code
//!   home each ran in.
//!
//! Only session files are listed. OpenClaw keeps its sign-ins beside its sessions, and the desktop
//! app keeps each session's settings (MCP servers and their headers among them) and an audit key
//! beside its log; none of those is ever kept.

use super::imports::home_kind;
use super::lister::{allowed, ListedFile, ListedRoot, Listing};
use std::fs;
use std::path::{Path, PathBuf};

/// A copied agent home, listed by the shell script like a live one.
pub(crate) const HOME: &str = "home";
pub(crate) const OPENCLAW: &str = "openclaw";
pub(crate) const CLAUDE_DESKTOP: &str = "claude-desktop";

fn is_uuid(text: &str) -> bool {
    text.len() == 36 && text.char_indices().all(|(at, char)| if matches!(at, 8 | 13 | 18 | 23) { char == '-' } else { char.is_ascii_hexdigit() })
}

fn dirs_in(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut dirs: Vec<(String, PathBuf)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| (entry.file_name().to_string_lossy().into_owned(), entry.path()))
        .collect();
    dirs.sort();
    dirs
}

/// The layout a folder is, if it's one of those above, from its names alone.
pub(crate) fn layout_at(dir: &Path) -> Option<&'static str> {
    if dir.join("sessions/sessions.json").is_file() && dir.join("agent").is_dir() {
        return Some(OPENCLAW);
    }
    if desktop_sessions(dir).next().is_some() {
        return Some(CLAUDE_DESKTOP);
    }
    None
}

/// The local_<id> folders with an audit log in them.
fn desktop_sessions(dir: &Path) -> impl Iterator<Item = PathBuf> {
    dirs_in(dir).into_iter().filter(|(name, path)| name.strip_prefix("local_").is_some_and(is_uuid) && path.join("audit.jsonl").is_file()).map(|(_, path)| path)
}

/// Agent homes a layout keeps inside it, which are imported as homes of their own.
pub(crate) fn homes_inside(layout: &str, dir: &Path) -> Vec<PathBuf> {
    let candidates: Vec<PathBuf> = match layout {
        OPENCLAW => vec![dir.join("agent/codex-home")],
        CLAUDE_DESKTOP => desktop_sessions(dir).map(|session| session.join(".claude")).collect(),
        _ => Vec::new(),
    };
    candidates.into_iter().filter(|home| home_kind(home).is_some()).collect()
}

/// A root to list, as the import recorded it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LayoutRoot {
    pub(crate) agent: String,
    pub(crate) root: String,
    pub(crate) layout: String,
}

fn stat_file(path: &Path, rel_path: String) -> Option<ListedFile> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::metadata(path).ok().filter(fs::Metadata::is_file)?;
    Some(ListedFile { rel_path, dev: meta.dev(), ino: meta.ino(), size: meta.size(), mtime: meta.mtime(), ctime: meta.ctime(), via_link: false })
}

/// Which folders are looked in for each layout's session files, by their path in the root.
fn looks_in(layout: &str, parts: &[&str]) -> bool {
    match layout {
        OPENCLAW => matches!(parts, ["sessions"]),
        CLAUDE_DESKTOP => matches!(parts, [dir] if dir.starts_with("local_")),
        _ => false,
    }
}

/// Lists a root folder by folder, only where its layout keeps sessions and without following links
/// to folders. A folder that can't be read leaves the listing incomplete.
fn list_folder(root: &LayoutRoot) -> ListedRoot {
    let mut listed = ListedRoot { agent: root.agent.clone(), home: root.root.clone(), complete: true, ..ListedRoot::default() };
    let mut queue = vec![(PathBuf::from(&root.root), String::new())];
    while let Some((dir, rel)) = queue.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            listed.complete = false;
            continue;
        };
        for entry in entries {
            let Ok(entry) = entry else {
                listed.complete = false;
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.contains(['\n', '\t']) {
                listed.unlistable += 1;
                continue;
            }
            let path_in = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            let Ok(kind) = entry.file_type() else {
                listed.complete = false;
                continue;
            };
            if kind.is_dir() {
                if looks_in(&root.layout, &path_in.split('/').collect::<Vec<_>>()) {
                    queue.push((entry.path(), path_in));
                }
            } else if allowed(&root.agent, &path_in) {
                match stat_file(&entry.path(), path_in.clone()) {
                    Some(file) => listed.files.push(file),
                    None if kind.is_symlink() => listed.dangling.push(path_in),
                    None => listed.complete = false,
                }
            }
        }
    }
    listed.files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    listed
}

/// Lists the roots that aren't copied homes. A root in a layout this build doesn't list, recorded by an older
/// version's import, is left out; what that import kept stays kept.
pub(crate) fn list(roots: &[LayoutRoot]) -> Listing {
    let mut listing = Listing { ended: true, ..Listing::default() };
    for root in roots {
        if matches!(root.layout.as_str(), OPENCLAW | CLAUDE_DESKTOP) {
            listing.roots.push(list_folder(root));
        }
    }
    listing
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::ingest::tests::{SECRET_TEXT, SID, THREAD};
    use super::super::store::tests::temp_dir;
    use super::*;

    pub(crate) fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn other_layouts_list_their_session_files_and_nothing_beside_them() {
        let base = fs::canonicalize(temp_dir("layouts-folders")).unwrap();
        let claw = base.join("openclaw-agents/main");
        write(&claw.join(format!("sessions/{SID}.jsonl")), "{}\n");
        write(&claw.join(format!("sessions/{SID}.trajectory.jsonl")), "{}\n");
        write(&claw.join("sessions/sessions.json"), "{}");
        write(&claw.join("agent/auth-profiles.json"), SECRET_TEXT);
        write(&claw.join("agent/auth.json"), SECRET_TEXT);
        write(&claw.join(format!("agent/codex-home/sessions/2026/05/16/rollout-2026-05-16T00-00-00-{THREAD}.jsonl")), "{}\n");
        write(&claw.join("agent/codex-home/auth.json"), SECRET_TEXT);
        write(&claw.join(format!("qmd/sessions/{SID}.md")), "x");

        let desktop = base.join("local-agent-mode-sessions/acct/org");
        let session = desktop.join(format!("local_{SID}"));
        write(&desktop.join(format!("local_{SID}.json")), &format!("{{\"remoteMcpServersConfig\":\"{SECRET_TEXT}\"}}"));
        write(&session.join("audit.jsonl"), "{}\n");
        write(&session.join(".audit-key"), SECRET_TEXT);
        write(&session.join("uploads/SKILL.md"), "x");
        write(&session.join(format!(".claude/projects/-sessions-x/{SID}.jsonl")), "{}\n");

        assert_eq!([layout_at(&claw), layout_at(&desktop)], [Some(OPENCLAW), Some(CLAUDE_DESKTOP)]);
        assert_eq!(layout_at(&base), None);
        assert_eq!(homes_inside(OPENCLAW, &claw), [claw.join("agent/codex-home")]);
        assert_eq!(homes_inside(CLAUDE_DESKTOP, &desktop), [session.join(".claude")]);

        let mut roots: Vec<LayoutRoot> = [(OPENCLAW, &claw), (CLAUDE_DESKTOP, &desktop)]
            .iter()
            .map(|(layout, dir)| LayoutRoot { agent: layout.to_string(), root: dir.to_string_lossy().into_owned(), layout: layout.to_string() })
            .collect();
        // A root an older version recorded in a layout this one doesn't list.
        roots.push(LayoutRoot { agent: "tilde".into(), root: base.to_string_lossy().into_owned(), layout: "tilde".into() });
        let listing = list(&roots);
        assert_eq!(listing.roots.len(), 2);
        let names = |at: usize| listing.roots[at].files.iter().map(|file| file.rel_path.clone()).collect::<Vec<_>>();
        assert_eq!(names(0), [format!("sessions/{SID}.jsonl"), format!("sessions/{SID}.trajectory.jsonl"), "sessions/sessions.json".into()]);
        assert_eq!(names(1), [format!("local_{SID}/audit.jsonl")]);
        assert!(listing.roots.iter().all(|root| root.complete));
        let _ = fs::remove_dir_all(&base);
    }
}

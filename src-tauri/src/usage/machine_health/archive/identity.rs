//! Which session, and which of its files, a path in an agent home is. Only
//! the ids the agents store are used: Claude Code's file names, and the id in
//! a Codex rollout's first line (or, failing that, its file name). Nothing is
//! ever matched on times, sizes or what a session says.
//!
//! Files that belong to a home rather than a session (history.jsonl, plans,
//! project memory) go to a "side" session named after the machine and home.
//! When these rules come to know a file kept as a home's own for a session's,
//! `RULE` changes and `ingest::refile` moves it.
//!
//! Backups in other layouts (see `layouts`) are named the same way: an
//! OpenClaw session and a Claude desktop session by the id their app puts in
//! the file's name. A Pi session is named by the id in its first line, or else
//! its file's name.

use serde::Deserialize;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MemberKey {
    pub(crate) agent: String,
    pub(crate) session_id: String,
    pub(crate) member: String,
    /// Where Claude Code filed the session (the project folder's name), kept for showing only.
    pub(crate) project_key: Option<String>,
    pub(crate) encoding: &'static str,
    /// Codex: whether the first line carries an `ordinal`, as paginated rollouts do.
    pub(crate) has_ordinal: Option<bool>,
}

/// How much of a rollout is read for its first line.
pub(crate) const HEAD_LIMIT: usize = 256 << 10;

/// Changes whenever a file an earlier version of these rules left to a home's side session would now
/// belong to a session, so the files already kept are filed again.
pub(crate) const RULE: &str = "identity-v2";

fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.char_indices().all(|(at, char)| if matches!(at, 8 | 13 | 18 | 23) { char == '-' } else { char.is_ascii_hexdigit() })
}

fn side(machine: &str, home_label: &str, member: String) -> MemberKey {
    MemberKey { agent: "side".into(), session_id: format!("{machine}:{home_label}"), member, project_key: None, encoding: "plain", has_ordinal: None }
}

fn claude(session_id: &str, member: String, project_key: Option<&str>) -> MemberKey {
    MemberKey { agent: "claude".into(), session_id: session_id.to_ascii_lowercase(), member, project_key: project_key.map(str::to_string), encoding: "plain", has_ordinal: None }
}

/// `head` gives the start of the file (decompressed, for a .zst), and is only asked for when
/// the file name isn't enough.
pub(crate) fn resolve(agent: &str, machine: &str, home_label: &str, rel_path: &str, head: impl FnOnce() -> Option<Vec<u8>>) -> Option<MemberKey> {
    match agent {
        "claude" => Some(resolve_claude(machine, home_label, rel_path)),
        "codex" => Some(resolve_codex(machine, home_label, rel_path, head)),
        "openclaw" => Some(resolve_openclaw(machine, home_label, rel_path)),
        "claude-desktop" => Some(resolve_claude_desktop(machine, home_label, rel_path)),
        "pi" => Some(resolve_pi(machine, home_label, rel_path, head)),
        _ => None,
    }
}

/// The session a file belongs to, from its path alone, for Claude Code and Codex: what a pass
/// checks before reading or fetching it. A Codex rollout's first line can name another session,
/// which only the full `resolve` sees.
pub(crate) fn session_hint(agent: &str, rel_path: &str) -> Option<String> {
    let parts: Vec<&str> = rel_path.split('/').collect();
    match (agent, &parts[..]) {
        ("claude", ["projects", _, name]) => name.strip_suffix(".jsonl").map(|stem| stem.split('.').next().unwrap_or(stem)).filter(|sid| is_uuid(sid)).map(str::to_ascii_lowercase),
        ("claude", ["projects", _, sid, _, ..] | ["file-history", sid, _, ..]) if is_uuid(sid) => Some(sid.to_ascii_lowercase()),
        ("claude", ["todos", name]) => name.get(..36).filter(|sid| is_uuid(sid)).map(str::to_ascii_lowercase),
        ("codex", [top, .., name]) if matches!(*top, "sessions" | "archived_sessions" | "compacted-history") => codex_path_ids(top, name).map(|(thread, _)| thread.to_ascii_lowercase()),
        _ => None,
    }
}

fn resolve_claude(machine: &str, home_label: &str, rel_path: &str) -> MemberKey {
    let parts: Vec<&str> = rel_path.split('/').collect();
    match parts[..] {
        ["projects", slug, name] => {
            if let Some(stem) = name.strip_suffix(".jsonl") {
                // <sid>.jsonl, and the copies Claude Code sets aside: <sid>.orphaned-<n>.jsonl.
                let (sid, suffix) = stem.split_once('.').unwrap_or((stem, ""));
                if is_uuid(sid) {
                    let member = if suffix.is_empty() { "main".to_string() } else { format!("main~{suffix}") };
                    return claude(sid, member, Some(slug));
                }
            }
            side(machine, home_label, format!("files/{rel_path}"))
        }
        ["projects", slug, "memory", ..] => side(machine, home_label, format!("memory/{slug}/{}", parts[3..].join("/"))),
        ["projects", slug, sid, kind, ..] if is_uuid(sid) => {
            let rest = parts[4..].join("/");
            let member = match kind {
                "subagents" | "tool-results" if !rest.is_empty() => format!("{kind}/{rest}"),
                _ => format!("files/{}", parts[3..].join("/")),
            };
            claude(sid, member, Some(slug))
        }
        ["file-history", sid, ..] if is_uuid(sid) && parts.len() > 2 => claude(sid, format!("file-history/{}", parts[2..].join("/")), None),
        ["todos", name] if name.get(..36).is_some_and(is_uuid) => claude(&name[..36], format!("todos/{name}"), None),
        _ => side(machine, home_label, format!("files/{rel_path}")),
    }
}

#[derive(Deserialize)]
struct CodexFirstLine {
    #[serde(default)]
    ordinal: Option<serde::de::IgnoredAny>,
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    payload: Option<CodexMeta>,
}

#[derive(Deserialize)]
struct CodexMeta {
    #[serde(default)]
    id: Option<String>,
}

/// The thread and rollout ids in a rollout's file name, as Codex itself reads them:
/// rollout-<19 character time>-<thread>[_<rollout>].jsonl[.zst].
fn codex_name_ids(name: &str) -> Option<(&str, Option<&str>)> {
    let core = name.strip_suffix(".zst").unwrap_or(name).strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let ids = core.get(20..).filter(|_| core.get(19..20) == Some("-"))?;
    match ids.split_once('_') {
        Some((thread, rollout)) if thread != rollout => Some((thread, Some(rollout))),
        Some((thread, _)) => Some((thread, None)),
        None => Some((ids, None)),
    }
}

/// The ids in the name of a file in one of Codex's session folders. A rollout set aside under
/// compacted-history before it was compacted keeps its name, or is
/// originals/<its folder, / as __>__<its name>.<16 hex>.zst.
fn codex_path_ids<'a>(top: &str, name: &'a str) -> Option<(&'a str, Option<&'a str>)> {
    if top != "compacted-history" {
        return codex_name_ids(name);
    }
    let stem = name.strip_suffix(".zst").unwrap_or(name);
    let stem = match stem.rsplit_once('.') {
        Some((rest, hash)) if hash.len() == 16 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) => rest,
        _ => stem,
    };
    codex_name_ids(stem.rsplit_once("__").map_or(stem, |(_, name)| name))
}

/// A rollout's first line: the session id it names, and whether it carries an ordinal.
fn codex_first_line(head: impl FnOnce() -> Option<Vec<u8>>) -> (Option<String>, Option<bool>) {
    let first = head().and_then(|bytes| {
        let line = bytes.split(|byte| *byte == b'\n').next()?.to_vec();
        serde_json::from_slice::<CodexFirstLine>(&line).ok()
    });
    let has_ordinal = first.as_ref().map(|line| line.ordinal.is_some());
    let stored = first.filter(|line| line.kind == "session_meta").and_then(|line| line.payload?.id).filter(|id| !id.is_empty() && id.len() <= 100);
    (stored.map(|id| id.to_ascii_lowercase()), has_ordinal)
}

fn resolve_codex(machine: &str, home_label: &str, rel_path: &str, head: impl FnOnce() -> Option<Vec<u8>>) -> MemberKey {
    let name = rel_path.rsplit('/').next().unwrap_or(rel_path);
    let top = rel_path.split('/').next().unwrap_or("");
    let Some((thread, rollout)) = codex_path_ids(top, name).filter(|_| matches!(top, "sessions" | "archived_sessions" | "compacted-history")) else {
        return side(machine, home_label, format!("files/{rel_path}"));
    };
    let (stored, has_ordinal) = codex_first_line(head);
    let session_id = stored.unwrap_or_else(|| thread.to_ascii_lowercase());
    let member = if top == "compacted-history" {
        format!("original/{name}")
    } else {
        rollout.map_or_else(|| "rollout".to_string(), |rollout| format!("rollout/{}", rollout.to_ascii_lowercase()))
    };
    let encoding = if name.ends_with(".zst") { "zstd" } else { "plain" };
    MemberKey { agent: "codex".into(), session_id, member, project_key: None, encoding, has_ordinal }
}

/// OpenClaw names a session's files after its id: <id>.jsonl, <id>.trajectory.jsonl, and copies
/// and notes beside them (<id>.jsonl.bak-…, <id>.jsonl.codex-app-server.json). sessions.json is
/// its list of them.
fn resolve_openclaw(machine: &str, home_label: &str, rel_path: &str) -> MemberKey {
    let name = match rel_path.split('/').collect::<Vec<_>>()[..] {
        ["sessions", name] => name,
        _ => return side(machine, home_label, format!("files/{rel_path}")),
    };
    let stem = name.split('.').next().unwrap_or("");
    if stem.is_empty() || stem == "sessions" || stem.len() > 100 {
        return side(machine, home_label, format!("files/{rel_path}"));
    }
    let member = match &name[stem.len()..] {
        ".jsonl" => "main".to_string(),
        ".trajectory.jsonl" => "trajectory".to_string(),
        _ => format!("files/{name}"),
    };
    let session_id = if is_uuid(stem) { stem.to_ascii_lowercase() } else { stem.to_string() };
    MemberKey { agent: "openclaw".into(), session_id, member, project_key: None, encoding: "plain", has_ordinal: None }
}

/// Claude's desktop app keeps a local session's audit log as local_<id>/audit.jsonl.
fn resolve_claude_desktop(machine: &str, home_label: &str, rel_path: &str) -> MemberKey {
    match rel_path.split('/').collect::<Vec<_>>()[..] {
        [dir, "audit.jsonl"] if dir.strip_prefix("local_").is_some_and(is_uuid) => {
            MemberKey { agent: "claude-desktop".into(), session_id: dir.to_ascii_lowercase(), member: "audit".into(), project_key: None, encoding: "plain", has_ordinal: None }
        }
        _ => side(machine, home_label, format!("files/{rel_path}")),
    }
}

#[derive(Deserialize)]
struct PiHeader {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    id: Option<String>,
}

/// Pi writes a session as <place>/<time>_<id>.jsonl, and its first line, the session's header,
/// holds the id.
fn resolve_pi(machine: &str, home_label: &str, rel_path: &str, head: impl FnOnce() -> Option<Vec<u8>>) -> MemberKey {
    let name = rel_path.rsplit('/').next().unwrap_or(rel_path);
    let Some(stem) = name.strip_suffix(".jsonl").filter(|stem| !stem.is_empty()) else {
        return side(machine, home_label, format!("files/{rel_path}"));
    };
    let stored = head()
        .and_then(|bytes| serde_json::from_slice::<PiHeader>(bytes.split(|byte| *byte == b'\n').next()?).ok())
        .filter(|header| header.kind == "session")
        .and_then(|header| header.id)
        .filter(|id| !id.is_empty() && id.len() <= 100);
    let named = stem.rsplit_once('_').map_or(stem, |(_, id)| id);
    let session_id = stored.unwrap_or_else(|| named.to_string());
    let session_id = if is_uuid(&session_id) { session_id.to_ascii_lowercase() } else { session_id };
    MemberKey { agent: "pi".into(), session_id, member: "main".into(), project_key: None, encoding: "plain", has_ordinal: None }
}

/// A home's name in side sessions: its path, with the home folder as `~`.
pub(crate) fn home_label(home: &str, user_home: Option<&str>) -> String {
    match user_home.and_then(|user_home| home.strip_prefix(user_home)) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("~{rest}"),
        _ => home.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "0f8b5c2e-1111-4222-8333-444455556666";
    const THREAD: &str = "019a1b2c-3d4e-7f00-8111-222233334444";

    fn claude_member(rel: &str) -> (String, String, String) {
        let key = resolve("claude", "mini", "~/.claude", rel, || panic!("Claude files are named by id")).unwrap();
        (key.agent, key.session_id, key.member)
    }

    #[test]
    fn claude_files_belong_to_the_session_their_name_says() {
        let main = resolve("claude", "mini", "~/.claude", &format!("projects/-Users-me-app/{SID}.jsonl"), || None).unwrap();
        assert_eq!((main.session_id.as_str(), main.member.as_str(), main.project_key.as_deref()), (SID, "main", Some("-Users-me-app")));
        assert_eq!(claude_member(&format!("projects/-a/{}.jsonl", SID.to_uppercase())).1, SID);
        assert_eq!(claude_member(&format!("projects/-a/{SID}.orphaned-2.jsonl")).2, "main~orphaned-2");
        assert_eq!(claude_member(&format!("projects/-a/{SID}/subagents/agent-a1.jsonl")).2, "subagents/agent-a1.jsonl");
        assert_eq!(claude_member(&format!("projects/-a/{SID}/subagents/workflows/wf_1/agent-b.jsonl")).2, "subagents/workflows/wf_1/agent-b.jsonl");
        assert_eq!(claude_member(&format!("projects/-a/{SID}/tool-results/t1.txt")).2, "tool-results/t1.txt");
        assert_eq!(claude_member(&format!("projects/-a/{SID}/notes/x.md")).2, "files/notes/x.md");
        assert_eq!(claude_member(&format!("file-history/{SID}/abc@v2")).2, "file-history/abc@v2");
        assert_eq!(claude_member(&format!("todos/{SID}-agent-{SID}.json")), ("claude".into(), SID.into(), format!("todos/{SID}-agent-{SID}.json")));
        // The same session filed under another project or home is the same session.
        assert_eq!(claude_member(&format!("projects/-Users-me-other/{SID}.jsonl")).1, SID);
        // Files of the home itself go to its side session.
        assert_eq!(claude_member("history.jsonl"), ("side".into(), "mini:~/.claude".into(), "files/history.jsonl".into()));
        assert_eq!(claude_member("projects/-a/memory/MEMORY.md").2, "memory/-a/MEMORY.md");
        assert_eq!(claude_member("projects/-a/not-a-session.jsonl").0, "side");
        // The session a path names, before anything is read, matches what resolving the file gives.
        for path in [format!("projects/-a/{SID}.jsonl"), format!("projects/-a/{SID}.orphaned-2.jsonl"), format!("projects/-a/{SID}/subagents/agent-a1.jsonl"), format!("file-history/{SID}/x@v1"), format!("todos/{SID}-agent-{SID}.json")] {
            assert_eq!(session_hint("claude", &path).as_deref(), Some(SID), "{path}");
        }
        assert_eq!(session_hint("claude", "projects/-a/memory/MEMORY.md"), None);
        assert_eq!(session_hint("claude", "projects/-a/not-a-session.jsonl"), None);
        assert_eq!(claude_member("plans/quiet-river.md").2, "files/plans/quiet-river.md");
    }

    #[test]
    fn codex_rollouts_use_the_id_in_their_first_line() {
        let name = format!("sessions/2026/09/25/rollout-2026-09-25T10-00-00-{THREAD}.jsonl");
        let first = format!("{{\"timestamp\":\"t\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{SID}\",\"instructions\":\"long\"}}}}\nnext\n");
        let key = resolve("codex", "mini", "~/.codex", &name, || Some(first.clone().into_bytes())).unwrap();
        assert_eq!((key.session_id.as_str(), key.member.as_str(), key.encoding, key.has_ordinal), (SID, "rollout", "plain", Some(false)));
        // Paginated rollouts carry an ordinal on every line.
        let paginated = format!("{{\"timestamp\":\"t\",\"ordinal\":0,\"type\":\"session_meta\",\"payload\":{{\"id\":\"{SID}\"}}}}\n");
        assert_eq!(resolve("codex", "m", "h", &name, || Some(paginated.into_bytes())).unwrap().has_ordinal, Some(true));
        // With no readable first line, the thread id in the name.
        let key = resolve("codex", "m", "h", &format!("archived_sessions/rollout-2026-01-01T00-00-00-{THREAD}.jsonl.zst"), || None).unwrap();
        assert_eq!((key.session_id.as_str(), key.encoding, key.has_ordinal), (THREAD, "zstd", None));
        // A reverted thread's rollout is its own member.
        let reverted = format!("sessions/2026/01/01/rollout-2026-01-01T00-00-00-{THREAD}_{SID}.jsonl");
        assert_eq!(resolve("codex", "m", "h", &reverted, || None).unwrap().member, format!("rollout/{SID}"));
        let same = format!("sessions/2026/01/01/rollout-2026-01-01T00-00-00-{THREAD}_{THREAD}.jsonl");
        assert_eq!(resolve("codex", "m", "h", &same, || None).unwrap().member, "rollout");
        assert_eq!(resolve("codex", "m", "h", &format!("compacted-history/rollout-2026-01-01T00-00-00-{THREAD}.jsonl"), || None).unwrap().member, format!("original/rollout-2026-01-01T00-00-00-{THREAD}.jsonl"));
        // An original set aside with its folder in its name and a hash after it.
        for folder in ["archived_sessions", "sessions__2026__01__01"] {
            let name = format!("{folder}__rollout-2026-01-01T00-00-00-{THREAD}.jsonl.f4eafffbb20827c7.zst");
            let path = format!("compacted-history/originals/{name}");
            let key = resolve("codex", "m", "h", &path, || Some(first.clone().into_bytes())).unwrap();
            assert_eq!((key.agent.as_str(), key.session_id.as_str(), key.member.as_str(), key.encoding), ("codex", SID, format!("original/{name}").as_str(), "zstd"));
            assert_eq!(resolve("codex", "m", "h", &path, || None).unwrap().session_id, THREAD);
            assert_eq!(session_hint("codex", &path).as_deref(), Some(THREAD));
        }
        // The other things set aside there are the home's.
        for path in ["compacted-history/originals/sqlite__logs_2.sqlite.32382beaf53f8c22.zst", "compacted-history/reports/2026-07-04T00-41-44-711Z.json"] {
            assert_eq!(resolve("codex", "m", "h", path, || panic!("not a rollout")).unwrap().agent, "side", "{path}");
        }
        // Only there is a name read that way.
        assert_eq!(resolve("codex", "m", "h", &format!("sessions/archived_sessions__rollout-2026-01-01T00-00-00-{THREAD}.jsonl"), || None).unwrap().agent, "side");
        assert_eq!(resolve("codex", "m", "h", "session_index.jsonl", || None).unwrap().member, "files/session_index.jsonl");
        assert_eq!(resolve("codex", "m", "h", "sessions/rollout-bad.jsonl", || None).unwrap().agent, "side");
        assert!(resolve("other", "m", "h", "x", || None).is_none());
    }

    #[test]
    fn backups_in_other_layouts_use_the_ids_their_apps_store() {
        let claw = |name: &str| {
            let key = resolve("openclaw", "m", "/o", &format!("sessions/{name}"), || panic!("named by id")).unwrap();
            (key.agent, key.session_id, key.member)
        };
        assert_eq!(claw(&format!("{SID}.jsonl")), ("openclaw".into(), SID.into(), "main".into()));
        assert_eq!(claw(&format!("{SID}.trajectory.jsonl")).2, "trajectory");
        assert_eq!(claw(&format!("{SID}.jsonl.bak-1-2")).2, format!("files/{SID}.jsonl.bak-1-2"));
        assert_eq!(claw("codex-auth-smoke-1.jsonl").1, "codex-auth-smoke-1");
        assert_eq!(claw("sessions.json").0, "side");

        let header = format!("{{\"type\":\"session\",\"version\":3,\"id\":\"{}\",\"cwd\":\"/w\"}}\nnext\n", SID.to_uppercase());
        let pi = resolve("pi", "m", "~/.pi/agent/sessions", &format!("--Users-me-app--/2026-07-19T07-00-00-000Z_{THREAD}.jsonl"), || Some(header.into_bytes())).unwrap();
        assert_eq!((pi.agent.as_str(), pi.session_id.as_str(), pi.member.as_str()), ("pi", SID, "main"));
        assert_eq!(resolve("pi", "m", "h", &format!("--a--/2026-07-19T07-00-00-000Z_{THREAD}.jsonl"), || None).unwrap().session_id, THREAD);
        assert_eq!(resolve("pi", "m", "h", "--a--/notes.md", || panic!("not a session")).unwrap().agent, "side");

        let desktop = resolve("claude-desktop", "m", "/d", &format!("local_{SID}/audit.jsonl"), || None).unwrap();
        assert_eq!((desktop.agent.as_str(), desktop.session_id.as_str(), desktop.member.as_str()), ("claude-desktop", format!("local_{SID}").as_str(), "audit"));
        assert_eq!(resolve("claude-desktop", "m", "/d", "local_x/audit.jsonl", || None).unwrap().agent, "side");
    }

    #[test]
    fn homes_are_named_from_the_home_folder() {
        assert_eq!(home_label("/Users/me/.claude", Some("/Users/me")), "~/.claude");
        assert_eq!(home_label("/Users/meg/.claude", Some("/Users/me")), "/Users/meg/.claude");
        assert_eq!(home_label("/Volumes/Backup/codex", Some("/Users/me")), "/Volumes/Backup/codex");
    }
}

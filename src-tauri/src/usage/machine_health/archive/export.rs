//! Puts kept sessions back together in a folder the user names: one folder per session, holding
//! its files as the agent wrote them and a session.json naming its machine, project and branch.
//!
//! This is the one way an archive's bytes leave its store, and only into a folder the user asked
//! for. Everything else keeps the archive's edges: it only reads archive.db, the chunks and the
//! tails, takes no lock (chunks never change, and a tail that moves on is read again), and its
//! answer holds ids, paths, counts and times. A session's project and branch come from usage.db,
//! linked by the session's id.

use super::classify::{load_version, Version};
use super::codec;
use super::store::{read_chunk_in, read_pending_in, FINDER_FILES};
use super::tokens::{pieces, Piece};
use chrono::{Local, TimeZone};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use ts_rs::TS;

/// A growing version whose tail moved on while it was read is read again this many times.
const READ_TRIES: usize = 3;
/// Folder and file names are kept to this many bytes, under every file system's limit.
const NAME_MAX: usize = 120;

/// Which sessions to export, and where to.
#[derive(Clone, Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ArchiveExportRequest {
    /// A full path to a folder that's missing or empty.
    pub(crate) out: String,
    /// The repository as `owner/name` or just its name, or the name of the checkout's folder.
    pub(crate) project: Option<String>,
    /// Only sessions kept from this machine.
    pub(crate) machine: Option<String>,
    /// Only sessions active since this time, in ms.
    pub(crate) since: Option<i64>,
    /// Every version each file has had, not only the newest.
    pub(crate) all_versions: bool,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveExport {
    pub(crate) out: String,
    pub(crate) sessions: u64,
    pub(crate) files: u64,
    pub(crate) bytes: u64,
    /// The repositories the project matched, as `owner/name`, or checkout folders for one with no remote.
    pub(crate) projects: Vec<String>,
    /// Sessions that couldn't be put back together, and why. What they had that could be read is in their folder.
    pub(crate) failed: Vec<ArchiveExportFailure>,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveExportFailure {
    pub(crate) session_id: String,
    pub(crate) error: String,
}

/// What usage.db knows about a session from its transcript: where it ran and what it worked on.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct SessionTags {
    pub(crate) branch: String,
    pub(crate) commit: String,
    /// `owner/name`, from the checkout's remote.
    pub(crate) repository: Option<String>,
    /// The main checkout's folder, for the worktree the session ran in.
    pub(crate) checkout: String,
    pub(crate) cwd: String,
}

impl SessionTags {
    /// The project a session is filed under: its repository, or its checkout's folder name.
    fn project(&self) -> Option<String> {
        self.repository.clone().or_else(|| folder_name(&self.checkout))
    }

    /// Whether a session worked on the project typed: its repository in full or by name, or its checkout's folder.
    fn matches(&self, typed: &str) -> bool {
        let typed = typed.trim().trim_end_matches(".git").trim_matches('/').to_ascii_lowercase();
        if typed.is_empty() {
            return false;
        }
        let repository = self.repository.as_deref().map(str::to_ascii_lowercase);
        if let Some(repository) = &repository {
            if *repository == typed || (!typed.contains('/') && repository.rsplit('/').next() == Some(typed.as_str())) {
                return true;
            }
        }
        !typed.contains('/') && folder_name(&self.checkout).is_some_and(|name| name.to_ascii_lowercase() == typed)
    }
}

fn folder_name(path: &str) -> Option<String> {
    Path::new(path.trim()).file_name().map(|name| name.to_string_lossy().into_owned()).filter(|name| !name.is_empty())
}

/// Every session usage.db has read a transcript of, by lowercase id.
pub(crate) fn session_tags(usage: &Connection) -> Result<HashMap<String, SessionTags>, String> {
    let mut statement = usage
        .prepare("SELECT session_id, branch, commit_hash, repository_url, main_repo, repo_root, cwd FROM usage_session_transcripts")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let main_repo: String = row.get(4)?;
            let repo_root: String = row.get(5)?;
            Ok((
                row.get::<_, String>(0)?.to_ascii_lowercase(),
                SessionTags {
                    branch: row.get(1)?,
                    commit: row.get(2)?,
                    // Only owner/name: a remote's address can carry a token.
                    repository: super::super::transcripts::repository_name(&row.get::<_, String>(3)?),
                    checkout: if main_repo.is_empty() { repo_root } else { main_repo },
                    cwd: row.get(6)?,
                },
            ))
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|error| error.to_string())
}

/// Where kept bytes are read from: the store's chunks, and growing tails from the index's own
/// copies first, as a pass reads them.
pub(crate) struct Reader {
    pub(crate) store_root: PathBuf,
    pub(crate) pending_dir: PathBuf,
}

impl Reader {
    fn pending(&self, vk: &str, gen: i64) -> Result<Vec<u8>, String> {
        match fs::read(self.pending_dir.join(format!("{vk}.{gen}.zst"))).map_err(|error| error.to_string()).and_then(|frame| codec::decode(&frame)) {
            Ok(bytes) => Ok(bytes),
            Err(_) => read_pending_in(&self.store_root, vk, gen),
        }
    }

    /// A version's bytes as its file held them, checked against the size and hash the index has.
    fn version(&self, version: &Version) -> Result<Vec<u8>, String> {
        let mut bytes = Vec::with_capacity(usize::try_from(version.size).unwrap_or(0));
        for piece in pieces(version, 0) {
            match piece {
                Piece::Chunk(hash, _) => bytes.extend(read_chunk_in(&self.store_root, &hash)?),
                Piece::Pending(_) => bytes.extend(self.pending(&version.vk, version.pending_gen)?),
            }
        }
        // A version whose tail was lost has only its whole chunks.
        let expected = if version.state == "lost-tail" { version.committed_len } else { version.size };
        if bytes.len() as u64 != expected {
            return Err(format!("A kept file came back {} bytes long, not {expected}", bytes.len()));
        }
        if let (Some(sha), "settled") = (version.sha256, version.state.as_str()) {
            if super::sha::sha256(&bytes) != sha {
                return Err("A kept file doesn't hold what the index says".into());
            }
        }
        Ok(bytes)
    }

    /// Reads a version, loading it again when a pass moved its tail on in the meantime.
    fn read(&self, db: &Connection, version_id: i64) -> Result<(Version, Vec<u8>), String> {
        let mut last = String::new();
        for _ in 0..READ_TRIES {
            let version = load_version(db, version_id)?;
            match self.version(&version) {
                Ok(bytes) => return Ok((version, bytes)),
                Err(error) if version.state == "growing" => last = error,
                Err(error) => return Err(error),
            }
        }
        Err(last)
    }
}

/// A kept session the request picked.
struct Picked {
    pk: i64,
    agent: String,
    id: String,
    last_active: i64,
    /// The machines it was kept from, the one it was last seen on first.
    machines: Vec<String>,
}

fn db_error(error: rusqlite::Error) -> String {
    format!("The archive index failed: {error}")
}

/// Every kept session with when it was last active (its files' newest modified time, or when one
/// was last seen) and the machines it was kept from, newest first.
fn kept_sessions(db: &Connection) -> Result<Vec<Picked>, String> {
    let mut statement = db
        .prepare(
            "SELECT s.session_pk, s.agent, s.session_id, MAX(COALESCE(o.mtime, o.at)), src.machine, MAX(o.at)
             FROM sessions s JOIN members m USING (session_pk) JOIN versions v USING (member_id)
               JOIN observations o USING (version_id) JOIN files f USING (file_id) JOIN sources src USING (source_id)
             WHERE s.agent != 'side'
             GROUP BY s.session_pk, src.machine",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?, row.get::<_, String>(4)?, row.get::<_, i64>(5)?)))
        .map_err(db_error)?;
    let mut by_session: BTreeMap<i64, (Picked, Vec<(i64, String)>)> = BTreeMap::new();
    for row in rows {
        let (pk, agent, id, active, machine, seen) = row.map_err(db_error)?;
        let entry = by_session.entry(pk).or_insert_with(|| (Picked { pk, agent, id, last_active: active, machines: Vec::new() }, Vec::new()));
        entry.0.last_active = entry.0.last_active.max(active);
        entry.1.push((seen, machine));
    }
    let mut sessions: Vec<Picked> = by_session
        .into_values()
        .map(|(mut picked, mut seen)| {
            seen.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
            picked.machines = seen.into_iter().map(|(_, machine)| machine).collect();
            picked
        })
        .collect();
    sessions.sort_by(|a, b| b.last_active.cmp(&a.last_active).then_with(|| a.id.cmp(&b.id)));
    Ok(sessions)
}

/// Makes the folder an export goes in: a full path, missing or empty, and nowhere in the archive.
fn prepare_out(out: &str, guarded: &[PathBuf]) -> Result<PathBuf, String> {
    let out = PathBuf::from(out.trim());
    if !out.is_absolute() || out.components().any(|part| part == Component::ParentDir) {
        return Err("Give the folder to export to as a full path.".into());
    }
    let resolved = resolve(&out);
    for place in guarded {
        let place = resolve(place);
        if resolved.starts_with(&place) || place.starts_with(&resolved) {
            return Err("Export to a folder outside the archive.".into());
        }
    }
    match fs::symlink_metadata(&out) {
        Ok(meta) if !meta.is_dir() => return Err("There's a file where that folder would go. Choose another.".into()),
        Ok(_) => {
            let busy = fs::read_dir(&out)
                .map_err(|error| format!("Couldn't read {}: {error}", out.display()))?
                .flatten()
                .any(|entry| !FINDER_FILES.iter().any(|name| entry.file_name() == *name));
            if busy {
                return Err("That folder has things in it. Export to a new or empty one.".into());
            }
        }
        Err(_) => {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().recursive(true).mode(0o700).create(&out).map_err(|error| format!("Couldn't make {}: {error}", out.display()))?;
        }
    }
    Ok(out)
}

/// The path with its nearest existing folder's links followed, so a link can't hide where it points.
fn resolve(path: &Path) -> PathBuf {
    for ancestor in path.ancestors() {
        if let Ok(real) = fs::canonicalize(ancestor) {
            return real.join(path.strip_prefix(ancestor).unwrap_or(Path::new("")));
        }
    }
    path.to_path_buf()
}

/// One part of a name from another machine, made safe to write anywhere: no folders, no hidden
/// names, nothing a file system would refuse.
fn safe_part(text: &str) -> String {
    let mut out: String = text
        .chars()
        .map(|char| if char.is_ascii_alphanumeric() || matches!(char, '-' | '_' | '.' | '@' | '~' | '+' | '=') { char } else { '_' })
        .collect();
    while out.starts_with('.') {
        out.replace_range(..1, "_");
    }
    if out.len() > NAME_MAX {
        out.truncate(NAME_MAX);
    }
    if out.is_empty() { "_".into() } else { out }
}

/// Where a session's file goes in its folder, from the name the archive filed it under. The
/// transcripts themselves (`main`, `rollout`, …) get `.jsonl`; a compressed one is written plain.
fn member_path(member: &str, encoding: &str) -> PathBuf {
    let mut parts: Vec<String> = member.split('/').filter(|part| !part.is_empty()).map(safe_part).collect();
    let transcript = (parts.len() == 1 && !member.contains('.')) || member.starts_with("rollout/");
    if let Some(last) = parts.last_mut() {
        if encoding == "zstd" {
            if let Some(plain) = last.strip_suffix(".zst") {
                *last = plain.to_string();
            }
        }
        if transcript && !last.ends_with(".jsonl") {
            last.push_str(".jsonl");
        }
    }
    if parts.is_empty() {
        parts.push("_".into());
    }
    parts.iter().collect()
}

/// An older version's file beside the newest: `main.v12.jsonl`.
fn version_path(path: &Path, version_id: i64) -> PathBuf {
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let named = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => format!("{stem}.v{version_id}.{extension}"),
        _ => format!("{name}.v{version_id}"),
    };
    path.with_file_name(named)
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    if let Some(dir) = path.parent() {
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|error| format!("Couldn't make {}: {error}", dir.display()))?;
    }
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(path).map_err(|error| format!("Couldn't write {}: {error}", path.display()))?;
    file.write_all(bytes).map_err(|error| format!("Couldn't write {}: {error}", path.display()))
}

fn iso(ms: i64) -> String {
    Local.timestamp_millis_opt(ms).single().map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, false)).unwrap_or_default()
}

/// The session's folder name: when it was last active, its machine, branch, agent and id.
fn session_folder(session: &Picked, tags: Option<&SessionTags>) -> String {
    let day = Local.timestamp_millis_opt(session.last_active).single().map(|at| at.format("%Y-%m-%d").to_string()).unwrap_or_else(|| "undated".into());
    let machine = session.machines.first().map_or("unknown", String::as_str);
    let branch = tags.map(|tags| tags.branch.as_str()).filter(|branch| !branch.is_empty()).unwrap_or("no-branch");
    let id = session.id.chars().take(64).collect::<String>();
    safe_part(&format!("{day}_{}_{}_{}-{}", safe_part(machine), safe_part(branch), session.agent, id)).chars().take(NAME_MAX * 2).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportedFile {
    path: String,
    member: String,
    version_id: i64,
    newest: bool,
    state: String,
    bytes: u64,
}

/// Writes one session's folder. Files that couldn't be read are left out and the first reason is
/// given back; what could be read is still written.
fn export_session(db: &Connection, reader: &Reader, session: &Picked, tags: Option<&SessionTags>, folder: &Path, all_versions: bool, report: &mut ArchiveExport) -> Result<(), String> {
    let members: Vec<(i64, String)> = {
        let mut statement = db.prepare("SELECT member_id, member FROM members WHERE session_pk = ?1 ORDER BY member").map_err(db_error)?;
        let rows = statement.query_map([session.pk], |row| Ok((row.get(0)?, row.get(1)?))).map_err(db_error)?;
        rows.collect::<Result<_, _>>().map_err(db_error)?
    };
    let mut files = Vec::new();
    let mut taken: HashSet<PathBuf> = HashSet::new();
    let mut first_error = None;
    for (member_id, member) in members {
        // Newest first: the one made or grown last.
        let versions: Vec<(i64, String)> = {
            let mut statement = db
                .prepare("SELECT version_id, encoding FROM versions WHERE member_id = ?1 ORDER BY MAX(created_at, COALESCE(grew_at, 0), COALESCE(settled_at, 0)) DESC, version_id DESC")
                .map_err(db_error)?;
            let rows = statement.query_map([member_id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(db_error)?;
            rows.collect::<Result<_, _>>().map_err(db_error)?
        };
        for (index, (version_id, encoding)) in versions.into_iter().enumerate() {
            if index > 0 && !all_versions {
                break;
            }
            let newest = member_path(&member, &encoding);
            let mut path = if index == 0 { newest } else { version_path(&newest, version_id) };
            // Two names made safe the same way keep apart by their version.
            if !taken.insert(path.clone()) {
                path = version_path(&path, version_id);
                taken.insert(path.clone());
            }
            let read = reader.read(db, version_id).and_then(|(version, bytes)| {
                let bytes = if version.encoding == "zstd" { codec::decode(&bytes)? } else { bytes };
                write_new(&folder.join(&path), &bytes)?;
                Ok((version.state, bytes.len() as u64))
            });
            match read {
                Ok((state, bytes)) => {
                    report.files += 1;
                    report.bytes += bytes;
                    files.push(ExportedFile { path: path.to_string_lossy().into_owned(), member: member.clone(), version_id, newest: index == 0, state, bytes });
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
    }
    let about = serde_json::json!({
        "agent": session.agent,
        "sessionId": session.id,
        "machine": session.machines.first(),
        "machines": session.machines,
        "lastActiveAt": iso(session.last_active),
        "project": tags.and_then(SessionTags::project),
        "repository": tags.and_then(|tags| tags.repository.clone()),
        "branch": tags.map(|tags| tags.branch.clone()).filter(|branch| !branch.is_empty()),
        "commit": tags.map(|tags| tags.commit.clone()).filter(|commit| !commit.is_empty()),
        "cwd": tags.map(|tags| tags.cwd.clone()).filter(|cwd| !cwd.is_empty()),
        "files": files,
    });
    let json = serde_json::to_vec_pretty(&about).map_err(|error| error.to_string())?;
    write_new(&folder.join("session.json"), &json)?;
    first_error.map_or(Ok(()), Err)
}

/// Exports the sessions the request picks into `request.out`. `guarded` are the archive's own
/// folders, which an export never goes in.
pub(crate) fn run(db: &Connection, reader: &Reader, tags: &HashMap<String, SessionTags>, request: &ArchiveExportRequest, guarded: &[PathBuf]) -> Result<ArchiveExport, String> {
    let project = request.project.as_deref().map(str::trim).filter(|project| !project.is_empty());
    let machine = request.machine.as_deref().map(super::super::normalize_machine_name).filter(|machine| !machine.is_empty());
    let sessions: Vec<Picked> = kept_sessions(db)?
        .into_iter()
        .filter(|session| request.since.is_none_or(|since| session.last_active >= since))
        .filter(|session| machine.as_ref().is_none_or(|wanted| session.machines.iter().any(|on| super::super::normalize_machine_name(on) == *wanted)))
        .filter(|session| project.is_none_or(|typed| tags.get(&session.id.to_ascii_lowercase()).is_some_and(|tags| tags.matches(typed))))
        .collect();
    if sessions.is_empty() {
        return Err(match project {
            Some(project) => format!("The archive has no sessions for {project} that match. A session's project is known once Arbor has read its transcript."),
            None => "The archive has no sessions that match.".into(),
        });
    }
    let out = prepare_out(&request.out, guarded)?;
    let mut report = ArchiveExport { out: out.to_string_lossy().into_owned(), ..ArchiveExport::default() };
    let mut projects = BTreeSet::new();
    let mut listed = Vec::new();
    let mut used: HashSet<String> = HashSet::new();
    for session in &sessions {
        let tags = tags.get(&session.id.to_ascii_lowercase());
        if let Some(project) = tags.and_then(SessionTags::project).filter(|_| project.is_some()) {
            projects.insert(project);
        }
        let mut name = session_folder(session, tags);
        if !used.insert(name.clone()) {
            name = format!("{name}_{}", session.pk);
            used.insert(name.clone());
        }
        let folder = out.join(&name);
        match export_session(db, reader, session, tags, &folder, request.all_versions, &mut report) {
            Ok(()) => {}
            Err(error) => report.failed.push(ArchiveExportFailure { session_id: session.id.clone(), error }),
        }
        report.sessions += 1;
        listed.push(serde_json::json!({ "folder": name, "agent": session.agent, "sessionId": session.id, "machine": session.machines.first(), "lastActiveAt": iso(session.last_active) }));
    }
    report.projects = projects.into_iter().collect();
    let summary = serde_json::json!({
        "exportedAt": iso(super::index::now_ms()),
        "project": project,
        "machine": request.machine,
        "since": request.since.map(iso),
        "allVersions": request.all_versions,
        "sessions": listed,
    });
    write_new(&out.join("export.json"), &serde_json::to_vec_pretty(&summary).map_err(|error| error.to_string())?)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::super::ingest::tests::{walk, Fixture, SECRET_TEXT, SID};
    use super::super::store::tests::temp_dir;
    use super::*;

    const OTHER: &str = "1a2b3c4d-5555-4666-8777-888899990000";

    fn reader(fixture: &Fixture) -> Reader {
        Reader { store_root: fixture.places.store.root().to_path_buf(), pending_dir: fixture.base.join("index/pending") }
    }

    fn tags(branch: &str, remote: &str, checkout: &str) -> SessionTags {
        SessionTags {
            branch: branch.into(),
            commit: "abc123".into(),
            repository: super::super::transcripts::repository_name(remote),
            checkout: checkout.into(),
            cwd: format!("{checkout}/.worktrees/x"),
        }
    }

    fn lines(count: usize, session: &str) -> String {
        (0..count).map(|n| format!("{{\"type\":\"user\",\"sessionId\":\"{session}\",\"n\":{n},\"text\":\"{SECRET_TEXT}\"}}\n")).collect()
    }

    /// Two Claude sessions on two projects, one with a subagent, kept by one pass.
    fn kept() -> (Fixture, HashMap<String, SessionTags>) {
        let fixture = Fixture::new("export");
        fixture.write(&format!(".claude/projects/-Users-cam-src-ledger/{SID}.jsonl"), &lines(40, SID));
        fixture.write(&format!(".claude/projects/-Users-cam-src-ledger/{SID}/subagents/agent-a1.jsonl"), &lines(3, SID));
        fixture.write(&format!(".claude/projects/-Users-cam-src-site/{OTHER}.jsonl"), &lines(2, OTHER));
        assert!(fixture.pass().complete);
        let tags = HashMap::from([
            (SID.to_string(), tags("feature/upload", "git@github.com:acme/ledger.git", "/Users/cam/src/ledger")),
            (OTHER.to_string(), tags("main", "", "/Users/cam/src/site")),
        ]);
        (fixture, tags)
    }

    fn request(out: &Path) -> ArchiveExportRequest {
        ArchiveExportRequest { out: out.to_string_lossy().into_owned(), ..ArchiveExportRequest::default() }
    }

    #[test]
    fn a_projects_sessions_come_back_byte_for_byte_tagged_with_machine_and_branch() {
        let (fixture, tags) = kept();
        let out = fixture.base.join("exported");
        let report = run(&fixture.db, &reader(&fixture), &tags, &ArchiveExportRequest { project: Some("Ledger".into()), ..request(&out) }, &[]).unwrap();
        assert_eq!((report.sessions, report.files, report.failed.len()), (1, 2, 0), "{report:?}");
        assert_eq!(report.projects, ["acme/ledger"]);

        let folders: Vec<String> = fs::read_dir(&out).unwrap().flatten().filter(|entry| entry.path().is_dir()).map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
        let [folder] = &folders[..] else { panic!("{folders:?}") };
        assert!(folder.contains("_mac_feature_upload_claude-") && folder.ends_with(SID), "{folder}");
        let session = out.join(folder);
        assert_eq!(fs::read_to_string(session.join("main.jsonl")).unwrap(), lines(40, SID));
        assert_eq!(fs::read_to_string(session.join("subagents/agent-a1.jsonl")).unwrap(), lines(3, SID));
        let about: serde_json::Value = serde_json::from_slice(&fs::read(session.join("session.json")).unwrap()).unwrap();
        assert_eq!((about["machine"].as_str(), about["branch"].as_str(), about["project"].as_str()), (Some("mac"), Some("feature/upload"), Some("acme/ledger")));
        let summary: serde_json::Value = serde_json::from_slice(&fs::read(out.join("export.json")).unwrap()).unwrap();
        assert_eq!(summary["sessions"].as_array().unwrap().len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&out).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(fs::metadata(session.join("main.jsonl")).unwrap().permissions().mode() & 0o777, 0o600);
        }

        // A project with no remote is found by its checkout's folder; owner/name has to match in full.
        let site = run(&fixture.db, &reader(&fixture), &tags, &ArchiveExportRequest { project: Some("site".into()), ..request(&fixture.base.join("site")) }, &[]).unwrap();
        assert_eq!((site.sessions, site.projects.clone()), (1, vec!["site".to_string()]));
        assert!(run(&fixture.db, &reader(&fixture), &tags, &ArchiveExportRequest { project: Some("other/ledger".into()), ..request(&fixture.base.join("none")) }, &[]).is_err());
        assert!(!fixture.base.join("none").exists(), "nothing is made when nothing matches");

        // The answer, the index and the journal hold no word of a session; only the export does.
        assert!(!serde_json::to_string(&report).unwrap().contains(SECRET_TEXT));
        fixture.db.execute_batch("PRAGMA wal_checkpoint(PASSIVE);").unwrap();
        let secret = SECRET_TEXT.as_bytes();
        for path in [fixture.db_path.clone(), fixture.db_path.with_extension("db-wal")].into_iter().chain(walk(&fixture.places.store.root().join("journal"))) {
            assert!(!fs::read(&path).is_ok_and(|bytes| bytes.windows(secret.len()).any(|window| window == secret)), "{}", path.display());
        }
        assert!(!fs::read_to_string(session.join("session.json")).unwrap().contains(SECRET_TEXT));
        assert!(!fs::read_to_string(out.join("export.json")).unwrap().contains(SECRET_TEXT));
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn since_and_machine_narrow_it_and_a_growing_file_comes_back_whole() {
        let (fixture, tags) = kept();
        // The ledger session grows after it was kept: its tail is read back from pending.
        let path = fixture.home.join(format!(".claude/projects/-Users-cam-src-ledger/{SID}.jsonl"));
        let mut grown = lines(40, SID);
        grown.push_str("{\"type\":\"assistant\",\"half\":");
        fs::write(&path, &grown).unwrap();
        assert!(fixture.pass().complete);
        assert!(fixture.count("SELECT COUNT(*) FROM versions WHERE state = 'growing' AND tail_len > 0") > 0, "the half line waits in a tail");
        let all = run(&fixture.db, &reader(&fixture), &tags, &request(&fixture.base.join("all")), &[]).unwrap();
        assert_eq!((all.sessions, all.failed.len()), (2, 0), "{all:?}");
        assert!(all.projects.is_empty(), "projects are only named when one was asked for");
        let ledger = fs::read_dir(fixture.base.join("all")).unwrap().flatten().find(|entry| entry.file_name().to_string_lossy().ends_with(SID)).unwrap().path();
        assert_eq!(fs::read_to_string(ledger.join("main.jsonl")).unwrap(), grown);

        let future = index_now() + 60_000;
        assert!(run(&fixture.db, &reader(&fixture), &tags, &ArchiveExportRequest { since: Some(future), ..request(&fixture.base.join("later")) }, &[]).is_err());
        assert!(run(&fixture.db, &reader(&fixture), &tags, &ArchiveExportRequest { machine: Some("cedar-02".into()), ..request(&fixture.base.join("cedar")) }, &[]).is_err());
        let mac = run(&fixture.db, &reader(&fixture), &tags, &ArchiveExportRequest { machine: Some("MAC".into()), since: Some(0), ..request(&fixture.base.join("mac")) }, &[]).unwrap();
        assert_eq!(mac.sessions, 2);
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn every_version_comes_back_when_asked() {
        let (fixture, tags) = kept();
        // Rewritten from the start, as compaction does: a second version of the same file.
        let path = fixture.home.join(format!(".claude/projects/-Users-cam-src-ledger/{SID}.jsonl"));
        fs::write(&path, lines(1, SID).replace("\"n\":0", "\"n\":99")).unwrap();
        assert!(fixture.pass().complete);
        let out = fixture.base.join("versions");
        let report = run(&fixture.db, &reader(&fixture), &tags, &ArchiveExportRequest { project: Some("acme/ledger".into()), all_versions: true, ..request(&out) }, &[]).unwrap();
        assert_eq!((report.files, report.failed.len()), (3, 0), "{report:?}");
        let session = fs::read_dir(&out).unwrap().flatten().find(|entry| entry.path().is_dir()).unwrap().path();
        assert!(fs::read_to_string(session.join("main.jsonl")).unwrap().contains("\"n\":99"), "the newest has the plain name");
        let older: Vec<String> = fs::read_dir(&session).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).filter(|name| name.starts_with("main.v")).collect();
        let [older] = &older[..] else { panic!("{older:?}") };
        assert_eq!(fs::read_to_string(session.join(older)).unwrap(), lines(40, SID));
        let _ = fs::remove_dir_all(&fixture.base);
    }

    fn index_now() -> i64 {
        super::super::index::now_ms()
    }

    #[test]
    fn it_only_writes_to_a_new_or_empty_folder_outside_the_archive() {
        let base = temp_dir("export-out");
        let store = base.join("drive/archive.noindex");
        fs::create_dir_all(&store).unwrap();
        assert!(prepare_out("relative/out", &[]).is_err());
        assert!(prepare_out(&format!("{}/a/../b", base.display()), &[]).is_err());
        assert!(prepare_out(&store.join("exports").to_string_lossy(), std::slice::from_ref(&store)).is_err());
        assert!(prepare_out(&base.join("drive").to_string_lossy(), std::slice::from_ref(&store)).is_err());
        let busy = base.join("busy");
        fs::create_dir_all(&busy).unwrap();
        fs::write(busy.join("notes.md"), "x").unwrap();
        assert!(prepare_out(&busy.to_string_lossy(), &[]).is_err());
        assert!(prepare_out(&busy.join("notes.md").to_string_lossy(), &[]).is_err());
        let finder = base.join("finder");
        fs::create_dir_all(&finder).unwrap();
        fs::write(finder.join(".DS_Store"), "x").unwrap();
        assert!(prepare_out(&finder.to_string_lossy(), &[]).is_ok());
        assert!(prepare_out(&base.join("new/deeper").to_string_lossy(), &[]).unwrap().is_dir());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn names_from_other_machines_stay_inside_the_session_folder() {
        assert_eq!(member_path("main", "plain"), PathBuf::from("main.jsonl"));
        assert_eq!(member_path("main~orphaned-1", "plain"), PathBuf::from("main~orphaned-1.jsonl"));
        assert_eq!(member_path("rollout/0f8b5c2e", "plain"), PathBuf::from("rollout/0f8b5c2e.jsonl"));
        assert_eq!(member_path("original/rollout-x.jsonl.zst", "zstd"), PathBuf::from("original/rollout-x.jsonl"));
        assert_eq!(member_path("subagents/agent-a1.jsonl", "plain"), PathBuf::from("subagents/agent-a1.jsonl"));
        assert_eq!(member_path("file-history/abc@v2", "plain"), PathBuf::from("file-history/abc@v2"));
        for hostile in ["../../etc/passwd", "/abs/path", "files/../../x", "..", "a/./b", ".hidden/.x", "con\u{0}trol"] {
            let path = member_path(hostile, "plain");
            assert!(path.components().all(|part| matches!(part, Component::Normal(name) if !name.to_string_lossy().starts_with('.'))), "{hostile} → {}", path.display());
        }
        assert_eq!(version_path(Path::new("main.jsonl"), 12), PathBuf::from("main.v12.jsonl"));
        assert_eq!(version_path(Path::new("file-history/abc@v2"), 3), PathBuf::from("file-history/abc@v2.v3"));
        let picked = Picked { pk: 1, agent: "codex".into(), id: "x/../y".into(), last_active: 0, machines: vec!["cam mbp/..".into()] };
        let name = session_folder(&picked, Some(&tags("feat/../../x", "", "")));
        assert!(!name.contains('/') && !name.starts_with('.'), "{name}");
    }
}

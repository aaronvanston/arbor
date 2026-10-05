//! The setup repo's own files, for Sync › Repo's browser: every file in the
//! folder and how it stands against the last commit, each one's text, edits
//! that wait in the folder until they're committed together, and what each
//! commit changed.
//!
//! Paths are the folder's own and stay inside it: never in git's folder, never
//! through a link, and never a file whose name says it may hold a secret, which
//! is listed but never read, written or committed. A save only lands when the
//! file is still as it was read, so an edit made outside Arbor since is never
//! overwritten.

use super::project_instructions as instructions;
use super::setup::looks_secret;
use super::setup_hooks::HOOKS_FILE;
use super::setup_mcp::MCP_FILE;
use super::setup_repo_skills::{SKILLS_DIR, SOURCES_FILE};
use super::setup_sync::{blobs, git, git_out, is_commit, managed, parse_commit, read_repo, sha256_hex, RepoCommit, SetupRepo, SyncFileKind, FILE_MAX_BYTES, GIT_TIMEOUT};
use super::setup_wanted::{MACHINES_FILE, PLUGINS_FILE};
use super::*;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use ts_rs::TS;

/// The most files the browser lists; a repo with more says it was cut short.
const TREE_MAX: usize = 5_000;
/// The most text one look at the changes carries; files past it are left out as too large.
const CHANGES_TEXT_MAX: usize = 8 * 1024 * 1024;
/// How far into a file git looks for a zero byte to call it binary, and so does Arbor.
const BINARY_SNIFF: usize = 8_000;
/// The records Arbor keeps in the repo about what it syncs.
const RECORDS: [&str; 5] = [MCP_FILE, HOOKS_FILE, MACHINES_FILE, PLUGINS_FILE, SOURCES_FILE];

/// What a file in the repo is to Arbor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RepoRole {
    /// CLAUDE.md or AGENTS.md, which go to each machine's home.
    Instructions,
    Rule,
    Subagent,
    Command,
    HookScript,
    /// A file in a skill's folder under .agents/skills.
    Skill,
    /// A project's own instructions under .agents/projects.
    ProjectInstructions,
    /// One of the records Arbor keeps: which machines get what, MCP servers, hooks, plugins, skill sources.
    Record,
    /// Anything else, which stays in the repo.
    Other,
}

impl From<SyncFileKind> for RepoRole {
    fn from(kind: SyncFileKind) -> Self {
        match kind {
            SyncFileKind::Instructions => Self::Instructions,
            SyncFileKind::Rule => Self::Rule,
            SyncFileKind::Subagent => Self::Subagent,
            SyncFileKind::Command => Self::Command,
            SyncFileKind::HookScript => Self::HookScript,
        }
    }
}

/// How a file in the folder stands against the last commit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RepoStatus {
    Same,
    Modified,
    /// Not in the last commit.
    Added,
    /// In the last commit, gone from the folder.
    Deleted,
}

/// Why Arbor doesn't show a file's text: its name says it may hold a secret, it's over 1 MB, it isn't text, or it's a
/// link or a submodule.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "RepoFileProblem")]
pub(crate) enum FileProblem {
    Secret,
    Large,
    Binary,
    Link,
}

/// A file in the setup repo's folder, as the browser lists it.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoEntry {
    /// Within the folder: .claude/CLAUDE.md.
    path: String,
    role: RepoRole,
    status: RepoStatus,
    /// The folder's copy's size, or the last commit's for a file that's gone.
    size: u64,
    /// Why Arbor won't open it, when it won't.
    problem: Option<FileProblem>,
}

/// Every file in the setup repo's folder, committed or not.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoTree {
    entries: Vec<RepoEntry>,
    /// More files than the browser lists.
    truncated: bool,
}

/// A file's text, with its SHA-256 to save against; neither when there's no file there or Arbor doesn't show it.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoText {
    content: Option<String>,
    sum: Option<String>,
    problem: Option<FileProblem>,
}

/// A file's two copies; a missing side hasn't the file, or isn't shown when there's a problem.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoChange {
    path: String,
    status: RepoStatus,
    before: Option<String>,
    after: Option<String>,
    problem: Option<FileProblem>,
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// A path in the folder as the browser names one, when it stays inside: no empty, `.` or `..` parts, nothing in git's
/// own folder, and nothing git would read as an option.
fn safe_rel(rel: &str) -> Result<&str, String> {
    let inside = !rel.is_empty()
        && rel.len() <= 1_024
        && !rel.starts_with('/')
        && !rel.contains(['\\', '\0'])
        && rel.split('/').all(|part| !part.is_empty() && part != "." && part != ".." && !part.eq_ignore_ascii_case(".git"));
    if inside {
        Ok(rel)
    } else {
        Err(format!("{rel} isn't a path inside the repo"))
    }
}

/// What's at a path in the folder. A link on the way there counts as a link, since what it leads to is elsewhere.
#[derive(Debug, PartialEq)]
enum OnDisk {
    Missing,
    File(u64),
    Folder,
    Link,
}

fn on_disk(folder: &Path, rel: &str) -> OnDisk {
    let parts: Vec<&str> = rel.split('/').collect();
    let mut at = folder.to_path_buf();
    for (n, part) in parts.iter().enumerate() {
        at.push(part);
        match fs::symlink_metadata(&at) {
            Err(_) => return OnDisk::Missing,
            Ok(meta) if meta.file_type().is_symlink() => return OnDisk::Link,
            Ok(meta) if n + 1 == parts.len() => return if meta.is_file() { OnDisk::File(meta.len()) } else { OnDisk::Folder },
            Ok(meta) if !meta.is_dir() => return OnDisk::Missing,
            Ok(_) => {}
        }
    }
    OnDisk::Missing
}

/// Refuses a new path whose folders are a link or a file; the folders that aren't there yet are made when it's written.
fn check_the_way(folder: &Path, rel: &str) -> Result<(), String> {
    let mut at = folder.to_path_buf();
    let mut walked = Vec::new();
    for part in rel.split('/').collect::<Vec<_>>().split_last().map_or(&[][..], |(_, parents)| parents) {
        at.push(part);
        walked.push(*part);
        match fs::symlink_metadata(&at) {
            Err(_) => return Ok(()),
            Ok(meta) if meta.file_type().is_symlink() => return Err(format!("{} is a link, which Arbor leaves alone", walked.join("/"))),
            Ok(meta) if !meta.is_dir() => return Err(format!("There's already a file at {}", walked.join("/"))),
            Ok(_) => {}
        }
    }
    Ok(())
}

/// What a file in the repo is to Arbor, from its path.
fn role_of(rel: &str) -> RepoRole {
    if let Some(kind) = managed(rel) {
        return kind.into();
    }
    let skill = rel
        .strip_prefix(SKILLS_DIR)
        .and_then(|rest| rest.strip_prefix('/'))
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(name, within)| !name.is_empty() && !within.is_empty());
    if skill {
        RepoRole::Skill
    } else if instructions::instructions_file(rel).is_some() {
        RepoRole::ProjectInstructions
    } else if RECORDS.contains(&rel) {
        RepoRole::Record
    } else {
        RepoRole::Other
    }
}

/// Whether bytes aren't text: a zero byte early on, as git judges, or not UTF-8.
fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF).any(|byte| *byte == 0) || std::str::from_utf8(bytes).is_err()
}

/// Whether a file starts like one that isn't text, read no further than git would look.
fn starts_binary(path: &Path) -> bool {
    let Ok(file) = fs::File::open(path) else { return false };
    let mut start = Vec::with_capacity(BINARY_SNIFF);
    file.take(BINARY_SNIFF as u64).read_to_end(&mut start).is_ok() && start.contains(&0)
}

/// Bytes as the browser shows them: the text and its fingerprint, or why not.
fn text_of(bytes: Vec<u8>) -> RepoText {
    if bytes.len() as u64 > FILE_MAX_BYTES {
        return RepoText { content: None, sum: None, problem: Some(FileProblem::Large) };
    }
    if is_binary(&bytes) {
        return RepoText { content: None, sum: None, problem: Some(FileProblem::Binary) };
    }
    let sum = sha256_hex(&bytes);
    RepoText { content: String::from_utf8(bytes).ok(), sum: Some(sum), problem: None }
}

const NOTHING: RepoText = RepoText { content: None, sum: None, problem: None };

fn problem_text(problem: FileProblem) -> RepoText {
    RepoText { content: None, sum: None, problem: Some(problem) }
}

// ---------------------------------------------------------------------------
// The repo
// ---------------------------------------------------------------------------

/// The folder's place in its repo, as git names paths from the top: `dotfiles/agents/`, or nothing at the top.
async fn prefix_of(folder: &Path) -> Result<String, String> {
    if !folder.is_dir() {
        return Err(format!("Arbor can't find {}", folder.display()));
    }
    let inside = git(folder, &["rev-parse", "--is-inside-work-tree", "--show-prefix"], GIT_TIMEOUT).await?;
    let found = String::from_utf8_lossy(&inside.stdout);
    let mut lines = found.lines();
    if !inside.status.success() || lines.next() != Some("true") {
        return Err(format!("{} isn't in a git repo", folder.display()));
    }
    Ok(lines.next().unwrap_or_default().to_string())
}

/// The last commit, or None before the first.
async fn head_commit(folder: &Path) -> Option<String> {
    let output = git(folder, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], GIT_TIMEOUT).await.ok()?;
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && is_commit(&sha)).then_some(sha)
}

/// A file as a commit has it.
struct Committed {
    mode: String,
    object: String,
    size: u64,
}

impl Committed {
    /// A link or a submodule, which isn't a file in the folder.
    fn is_link(&self) -> bool {
        self.mode == "120000" || self.mode == "160000"
    }

    /// Why its text isn't shown, before reading it.
    fn problem(&self) -> Option<FileProblem> {
        if self.is_link() {
            Some(FileProblem::Link)
        } else if self.size > FILE_MAX_BYTES {
            Some(FileProblem::Large)
        } else {
            None
        }
    }
}

/// Every file `commit` holds under the folder, by its path in the folder.
async fn commit_files(folder: &Path, prefix: &str, commit: &str) -> Result<BTreeMap<String, Committed>, String> {
    let listing = git_out(folder, &["ls-tree", "-r", "-l", "-z", "--full-name", commit, "--", "."]).await?;
    let mut files = BTreeMap::new();
    for entry in listing.split('\0') {
        let Some((meta, full)) = entry.split_once('\t') else { continue };
        let Some(rel) = full.strip_prefix(prefix) else { continue };
        let fields: Vec<&str> = meta.split_whitespace().collect();
        let [mode, _, object, size] = fields.as_slice() else { continue };
        let size = size.parse().unwrap_or(0);
        files.insert(rel.to_string(), Committed { mode: mode.to_string(), object: object.to_string(), size });
    }
    Ok(files)
}

/// Every file in the folder git tracks or would: what's in the index, and what isn't ignored.
async fn folder_files(folder: &Path, prefix: &str) -> Result<BTreeSet<String>, String> {
    let listed = git_out(folder, &["ls-files", "-z", "--full-name", "--cached", "--others", "--exclude-standard", "--", "."]).await?;
    Ok(listed.split('\0').filter_map(|full| full.strip_prefix(prefix)).filter(|rel| !rel.is_empty()).map(str::to_string).collect())
}

/// The files git says differ from the last commit, in the index or the folder.
async fn changed_paths(folder: &Path, prefix: &str) -> Result<BTreeSet<String>, String> {
    let status = git_out(folder, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "."]).await?;
    Ok(status.split('\0').filter_map(|entry| entry.get(3..)).filter_map(|full| full.strip_prefix(prefix)).map(str::to_string).collect())
}

async fn list_tree(folder: &Path) -> Result<RepoTree, String> {
    let prefix = prefix_of(folder).await?;
    let committed = match head_commit(folder).await {
        Some(head) => commit_files(folder, &prefix, &head).await?,
        None => BTreeMap::new(),
    };
    let listed = folder_files(folder, &prefix).await?;
    let changed = changed_paths(folder, &prefix).await?;
    let mut paths: BTreeSet<&str> = committed.keys().map(String::as_str).collect();
    paths.extend(listed.iter().map(String::as_str));
    let mut entries = Vec::new();
    let mut truncated = false;
    for rel in paths {
        if safe_rel(rel).is_err() {
            continue;
        }
        if entries.len() == TREE_MAX {
            truncated = true;
            break;
        }
        let was = committed.get(rel);
        let disk = on_disk(folder, rel);
        let status = match (&disk, was) {
            // Only in the index, or a folder where git lists a file (a submodule's checkout).
            (OnDisk::Missing, None) | (OnDisk::Folder, None) => continue,
            (OnDisk::Missing, Some(_)) => RepoStatus::Deleted,
            (_, None) => RepoStatus::Added,
            (_, Some(_)) if changed.contains(rel) => RepoStatus::Modified,
            (_, Some(_)) => RepoStatus::Same,
        };
        let size = match disk {
            OnDisk::File(size) => size,
            _ => was.map_or(0, |was| was.size),
        };
        let problem = if looks_secret(rel) {
            Some(FileProblem::Secret)
        } else if matches!(disk, OnDisk::Link | OnDisk::Folder) || was.is_some_and(Committed::is_link) {
            Some(FileProblem::Link)
        } else if size > FILE_MAX_BYTES {
            Some(FileProblem::Large)
        } else if matches!(disk, OnDisk::File(_)) && starts_binary(&folder.join(rel)) {
            Some(FileProblem::Binary)
        } else {
            None
        };
        entries.push(RepoEntry { path: rel.to_string(), role: role_of(rel), status, size, problem });
    }
    Ok(RepoTree { entries, truncated })
}

/// A file's text as `commit` has it, or as the folder has it now.
async fn read_text(folder: &Path, rel: &str, commit: Option<&str>) -> Result<RepoText, String> {
    let rel = safe_rel(rel)?;
    let prefix = prefix_of(folder).await?;
    if looks_secret(rel) {
        return Ok(problem_text(FileProblem::Secret));
    }
    let Some(commit) = commit else {
        return match on_disk(folder, rel) {
            OnDisk::Missing => Ok(NOTHING),
            OnDisk::Link => Ok(problem_text(FileProblem::Link)),
            OnDisk::Folder => Err(format!("{rel} is a folder")),
            OnDisk::File(size) if size > FILE_MAX_BYTES => Ok(problem_text(FileProblem::Large)),
            OnDisk::File(_) => fs::read(folder.join(rel)).map(text_of).map_err(|error| format!("Arbor couldn't read {rel}: {error}")),
        };
    };
    if !is_commit(commit) {
        return Err("That isn't a commit".into());
    }
    let listing = git_out(folder, &["--literal-pathspecs", "ls-tree", "-l", "-z", "--full-name", commit, "--", &format!("./{rel}")]).await?;
    let found = listing.split('\0').find_map(|entry| {
        let (meta, full) = entry.split_once('\t')?;
        let fields: Vec<&str> = meta.split_whitespace().collect();
        let [mode, kind, object, size] = fields.as_slice() else { return None };
        (full.strip_prefix(prefix.as_str()) == Some(rel)).then(|| (mode.to_string(), kind.to_string(), object.to_string(), size.parse::<u64>().unwrap_or(0)))
    });
    let Some((mode, kind, object, size)) = found else { return Ok(NOTHING) };
    if kind != "blob" || mode == "120000" {
        return Ok(problem_text(FileProblem::Link));
    }
    if size > FILE_MAX_BYTES {
        return Ok(problem_text(FileProblem::Large));
    }
    let bytes = blobs(folder, &[object.as_str()]).await?.into_iter().next().unwrap_or_default();
    Ok(text_of(bytes))
}

/// Writes `bytes` beside the file, then moves it into place, keeping the file's permissions.
fn write_beside(path: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let temp = path.with_file_name(format!(".{name}.arbor-{}.tmp", std::process::id()));
    let failed = |error: std::io::Error| format!("Arbor couldn't write {rel}: {error}");
    fs::write(&temp, bytes).map_err(failed)?;
    if let Ok(meta) = fs::metadata(path) {
        let _ = fs::set_permissions(&temp, meta.permissions());
    }
    fs::rename(&temp, path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        failed(error)
    })
}

/// Saves a file's text in the folder when it still has the fingerprint `expected` (None: when there's no file there).
async fn write_text(folder: &Path, rel: &str, content: &str, expected: Option<&str>) -> Result<(), String> {
    let rel = safe_rel(rel)?;
    prefix_of(folder).await?;
    if looks_secret(rel) {
        return Err(format!("{rel}'s name says it may hold a secret, so Arbor doesn't write it"));
    }
    if content.len() as u64 > FILE_MAX_BYTES {
        return Err("Keep a file in the repo under 1 MB".into());
    }
    if content.contains('\0') {
        return Err("The text has a character a text file can't hold".into());
    }
    let path = folder.join(rel);
    let now = match on_disk(folder, rel) {
        OnDisk::Missing => None,
        OnDisk::Link => return Err(format!("{rel} is a link, which Arbor leaves alone")),
        OnDisk::Folder => return Err(format!("{rel} is a folder")),
        OnDisk::File(size) if size > FILE_MAX_BYTES => return Err(format!("{rel} is over 1 MB, so Arbor doesn't edit it")),
        OnDisk::File(_) => {
            let bytes = fs::read(&path).map_err(|error| format!("Arbor couldn't read {rel}: {error}"))?;
            if is_binary(&bytes) {
                return Err(format!("{rel} isn't text, so Arbor doesn't edit it"));
            }
            Some(sha256_hex(&bytes))
        }
    };
    if now.as_deref() != expected {
        return Err(match now {
            Some(_) if expected.is_none() => format!("There's already a file at {rel}"),
            Some(_) => format!("{rel} changed since Arbor read it. Read it again, then make the edit."),
            None => format!("{rel} is gone since Arbor read it"),
        });
    }
    check_the_way(folder, rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Arbor couldn't make the folder for {rel}: {error}"))?;
    }
    write_beside(&path, rel, content.as_bytes())
}

/// Renames a file or folder in the folder.
async fn move_path(folder: &Path, from: &str, to: &str) -> Result<(), String> {
    let (from, to) = (safe_rel(from)?, safe_rel(to)?);
    prefix_of(folder).await?;
    if from == to {
        return Ok(());
    }
    if to.starts_with(&format!("{from}/")) {
        return Err(format!("Arbor can't move {from} inside itself"));
    }
    if looks_secret(to) {
        return Err(format!("{to}'s name says it may hold a secret, so Arbor doesn't make it"));
    }
    match on_disk(folder, from) {
        OnDisk::Missing => return Err(format!("The repo has no {from}")),
        OnDisk::Link => return Err(format!("{from} is a link, which Arbor leaves alone")),
        OnDisk::File(_) | OnDisk::Folder => {}
    }
    check_the_way(folder, to)?;
    if on_disk(folder, to) != OnDisk::Missing {
        return Err(format!("There's already something at {to}"));
    }
    let target = folder.join(to);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Arbor couldn't make the folder for {to}: {error}"))?;
    }
    fs::rename(folder.join(from), &target).map_err(|error| format!("Arbor couldn't move {from}: {error}"))
}

/// Deletes a file or a folder and everything in it.
async fn delete_path(folder: &Path, rel: &str) -> Result<(), String> {
    let rel = safe_rel(rel)?;
    prefix_of(folder).await?;
    let path = folder.join(rel);
    let removed = match on_disk(folder, rel) {
        OnDisk::Missing => return Err(format!("The repo has no {rel}")),
        OnDisk::Link => return Err(format!("{rel} is a link, which Arbor leaves alone")),
        OnDisk::File(_) => fs::remove_file(&path),
        OnDisk::Folder => fs::remove_dir_all(&path),
    };
    removed.map_err(|error| format!("Arbor couldn't delete {rel}: {error}"))
}

/// Puts files back as the last commit has them. Files git knows go back to the commit's copy, or go when the commit
/// hasn't one; files it doesn't know yet are deleted. Ignored files stay.
async fn discard(folder: &Path, paths: &[String]) -> Result<(), String> {
    let prefix = prefix_of(folder).await?;
    let rels = paths.iter().map(|rel| safe_rel(rel)).collect::<Result<Vec<_>, _>>()?;
    let head = head_commit(folder).await;
    for rel in rels {
        let spec = format!("./{rel}");
        let in_head = match &head {
            Some(head) => !git_out(folder, &["--literal-pathspecs", "ls-tree", "-r", "--name-only", head, "--", &spec]).await?.is_empty(),
            None => false,
        };
        let in_index = !git_out(folder, &["--literal-pathspecs", "ls-files", "-z", "--cached", "--", &spec]).await?.is_empty();
        if head.is_some() && (in_head || in_index) {
            git_out(folder, &["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", &spec]).await?;
        } else if in_index {
            git_out(folder, &["--literal-pathspecs", "rm", "-r", "--cached", "--quiet", "--", &spec]).await?;
        }
        let others = git_out(folder, &["--literal-pathspecs", "ls-files", "-z", "--full-name", "--others", "--exclude-standard", "--", &spec]).await?;
        for file in others.split('\0').filter_map(|full| full.strip_prefix(prefix.as_str())) {
            if safe_rel(file).is_ok() && matches!(on_disk(folder, file), OnDisk::File(_)) {
                fs::remove_file(folder.join(file)).map_err(|error| format!("Arbor couldn't delete {file}: {error}"))?;
            }
        }
    }
    Ok(())
}

/// Each changed file's two copies, sharing out at most CHANGES_TEXT_MAX of text.
struct Budget(usize);

impl Budget {
    /// The text, when there's room for it.
    fn take(&mut self, text: RepoText) -> Result<Option<String>, FileProblem> {
        if let Some(problem) = text.problem {
            return Err(problem);
        }
        let Some(content) = text.content else { return Ok(None) };
        if content.len() > self.0 {
            return Err(FileProblem::Large);
        }
        self.0 -= content.len();
        Ok(Some(content))
    }

    fn pair(&mut self, path: String, status: RepoStatus, before: RepoText, after: RepoText) -> RepoChange {
        let shown = self.take(before).and_then(|before| Ok((before, self.take(after)?)));
        match shown {
            Ok((before, after)) => RepoChange { path, status, before, after, problem: None },
            Err(problem) => RepoChange { path, status, before: None, after: None, problem: Some(problem) },
        }
    }
}

/// The changes not committed yet.
async fn folder_changes(folder: &Path) -> Result<Vec<RepoChange>, String> {
    let prefix = prefix_of(folder).await?;
    let tree = list_tree(folder).await?;
    let committed = match head_commit(folder).await {
        Some(head) => commit_files(folder, &prefix, &head).await?,
        None => BTreeMap::new(),
    };
    let mut budget = Budget(CHANGES_TEXT_MAX);
    let mut changes = Vec::new();
    for entry in tree.entries.into_iter().filter(|entry| entry.status != RepoStatus::Same) {
        if let Some(problem) = entry.problem {
            changes.push(RepoChange { path: entry.path, status: entry.status, before: None, after: None, problem: Some(problem) });
            continue;
        }
        let before = match committed.get(&entry.path) {
            Some(was) => match was.problem() {
                Some(problem) => problem_text(problem),
                None => text_of(blobs(folder, &[was.object.as_str()]).await?.into_iter().next().unwrap_or_default()),
            },
            None => NOTHING,
        };
        let after = if entry.status == RepoStatus::Deleted { NOTHING } else { read_text(folder, &entry.path, None).await? };
        changes.push(budget.pair(entry.path, entry.status, before, after));
    }
    Ok(changes)
}

/// What `commit` changed under the folder, against its first parent.
async fn commit_changes(folder: &Path, commit: &str) -> Result<Vec<RepoChange>, String> {
    if !is_commit(commit) {
        return Err("That isn't a commit".into());
    }
    let prefix = prefix_of(folder).await?;
    let parent = git(folder, &["rev-parse", "--verify", "--quiet", &format!("{commit}^1^{{commit}}")], GIT_TIMEOUT).await?;
    let parent = String::from_utf8_lossy(&parent.stdout).trim().to_string();
    let parent = is_commit(&parent).then_some(parent);
    let now = commit_files(folder, &prefix, commit).await?;
    let was = match &parent {
        Some(parent) => commit_files(folder, &prefix, parent).await?,
        None => BTreeMap::new(),
    };
    let paths: BTreeSet<&String> = now.keys().chain(was.keys()).collect();
    // Each changed file, with where its two copies are in `wanted`, or why they aren't shown.
    let mut wanted: Vec<String> = Vec::new();
    let mut listed = Vec::new();
    for rel in paths {
        let (before, after) = (was.get(rel), now.get(rel));
        if before.map(|file| (&file.mode, &file.object)) == after.map(|file| (&file.mode, &file.object)) || safe_rel(rel).is_err() {
            continue;
        }
        let status = match (before, after) {
            (None, _) => RepoStatus::Added,
            (_, None) => RepoStatus::Deleted,
            _ => RepoStatus::Modified,
        };
        let problem = if looks_secret(rel) { Some(FileProblem::Secret) } else { before.into_iter().chain(after).find_map(Committed::problem) };
        let mut at = |file: Option<&Committed>| {
            let file = file.filter(|_| problem.is_none())?;
            wanted.push(file.object.clone());
            Some(wanted.len() - 1)
        };
        let (before_at, after_at) = (at(before), at(after));
        listed.push((rel.clone(), status, before_at, after_at, problem));
    }
    let objects: Vec<&str> = wanted.iter().map(String::as_str).collect();
    let mut contents: Vec<Option<Vec<u8>>> = blobs(folder, &objects).await?.into_iter().map(Some).collect();
    let mut text = |at: Option<usize>| at.and_then(|at| contents.get_mut(at).and_then(Option::take)).map_or(NOTHING, text_of);
    let mut budget = Budget(CHANGES_TEXT_MAX);
    Ok(listed
        .into_iter()
        .map(|(path, status, before, after, problem)| match problem {
            Some(problem) => RepoChange { path, status, before: None, after: None, problem: Some(problem) },
            None => {
                let (before, after) = (text(before), text(after));
                budget.pair(path, status, before, after)
            }
        })
        .collect())
}

/// The latest commits that changed something in the folder, newest first.
async fn log(folder: &Path, limit: u32) -> Result<Vec<RepoCommit>, String> {
    prefix_of(folder).await?;
    let count = format!("-n{}", limit.clamp(1, 500));
    let output = git(folder, &["log", &count, "--format=%H%x00%s%x00%ct%x1e", "--", "."], GIT_TIMEOUT).await?;
    // Before the first commit there's nothing to list.
    if !output.status.success() {
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout).split('\x1e').filter_map(|line| parse_commit(line.trim_start_matches('\n'))).collect())
}

/// Commits the changes to `paths`, and nothing else staged, with `message`; `git_config` is set for each git command.
async fn commit_paths(folder: &Path, paths: &[String], message: &str, git_config: &[&str]) -> Result<(), String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Write a message for the commit".into());
    }
    if message.contains('\0') {
        return Err("The message has a character git can't keep".into());
    }
    if paths.is_empty() {
        return Err("Choose the files to commit".into());
    }
    let prefix = prefix_of(folder).await?;
    let specs = paths.iter().map(|rel| safe_rel(rel).map(|rel| format!("./{rel}"))).collect::<Result<Vec<_>, _>>()?;
    let with = |args: &[&str]| -> Vec<String> {
        git_config.iter().chain(["--literal-pathspecs"].iter()).chain(args).map(|arg| arg.to_string()).chain(specs.iter().cloned()).collect()
    };
    let run = |args: Vec<String>| async move {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        git_out(folder, &args).await
    };
    // A file whose name says it may hold a secret never goes into a commit, even inside a folder chosen whole.
    let going = run(with(&["ls-files", "-z", "--full-name", "--cached", "--others", "--exclude-standard", "--"])).await?;
    if let Some(secret) = going.split('\0').filter_map(|full| full.strip_prefix(prefix.as_str())).find(|rel| looks_secret(rel)) {
        return Err(format!("{secret}'s name says it may hold a secret, so Arbor doesn't commit it"));
    }
    run(with(&["add", "-A", "--"])).await?;
    let staged = {
        let args = with(&["diff", "--cached", "--quiet", "--"]);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        git(folder, &args, GIT_TIMEOUT).await?
    };
    // `diff --quiet` fails before the first commit too, when there's no HEAD to compare with.
    if staged.status.success() && head_commit(folder).await.is_some() {
        return Err("Those files have no changes to commit".into());
    }
    run(with(&["commit", "--quiet", "-m", message, "--"])).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Every file in the setup repo's folder, committed or not, and how each stands against the last commit.
#[tauri::command]
pub(crate) async fn list_setup_repo_tree(repo: String) -> Result<RepoTree, String> {
    list_tree(Path::new(&repo)).await
}

/// A file's text as the folder has it, or with `commit` as that commit had it.
#[tauri::command]
pub(crate) async fn read_setup_repo_text(repo: String, path: String, commit: Option<String>) -> Result<RepoText, String> {
    read_text(Path::new(&repo), &path, commit.as_deref()).await
}

/// Saves a file in the folder without committing it, when it still has the fingerprint `expected`.
#[tauri::command]
pub(crate) async fn write_setup_repo_text(repo: String, path: String, content: String, expected: Option<String>) -> Result<RepoTree, String> {
    let folder = Path::new(&repo);
    write_text(folder, &path, &content, expected.as_deref()).await?;
    list_tree(folder).await
}

/// Renames a file or folder in the folder, without committing it.
#[tauri::command]
pub(crate) async fn move_setup_repo_path(repo: String, from: String, to: String) -> Result<RepoTree, String> {
    let folder = Path::new(&repo);
    move_path(folder, &from, &to).await?;
    list_tree(folder).await
}

/// Deletes a file or folder in the folder, without committing it.
#[tauri::command]
pub(crate) async fn delete_setup_repo_path(repo: String, path: String) -> Result<RepoTree, String> {
    let folder = Path::new(&repo);
    delete_path(folder, &path).await?;
    list_tree(folder).await
}

/// Puts files back as the last commit has them.
#[tauri::command]
pub(crate) async fn discard_setup_repo_changes(repo: String, paths: Vec<String>) -> Result<RepoTree, String> {
    let folder = Path::new(&repo);
    discard(folder, &paths).await?;
    list_tree(folder).await
}

/// The changes not committed yet, or with `commit` what that commit changed.
#[tauri::command]
pub(crate) async fn get_setup_repo_changes(repo: String, commit: Option<String>) -> Result<Vec<RepoChange>, String> {
    let folder = Path::new(&repo);
    match commit {
        Some(commit) => commit_changes(folder, &commit).await,
        None => folder_changes(folder).await,
    }
}

/// The latest commits that changed the folder, newest first.
#[tauri::command]
pub(crate) async fn get_setup_repo_log(repo: String, limit: u32) -> Result<Vec<RepoCommit>, String> {
    log(Path::new(&repo), limit).await
}

/// Commits the changes to the files named, and nothing else, with the message.
#[tauri::command]
pub(crate) async fn commit_setup_repo(repo: String, paths: Vec<String>, message: String) -> Result<SetupRepo, String> {
    let folder = Path::new(&repo);
    commit_paths(folder, &paths, &message, &[]).await?;
    read_repo(folder).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_inside_the_folder() {
        for outside in ["", "/etc/hosts", "a//b", "./a", "a/../b", "..", ".git/config", "x/.GIT/HEAD", "a\\b", "a\0b", "a/"] {
            assert!(safe_rel(outside).is_err(), "{outside:?}");
        }
        assert_eq!(safe_rel(".claude/CLAUDE.md"), Ok(".claude/CLAUDE.md"));
        assert_eq!(safe_rel("-rf"), Ok("-rf"), "git only ever gets it after ./");
    }

    #[test]
    fn each_file_says_what_arbor_does_with_it() {
        assert_eq!(role_of(".claude/CLAUDE.md"), RepoRole::Instructions);
        assert_eq!(role_of(".codex/prompts/review.md"), RepoRole::Command);
        assert_eq!(role_of(".agents/hooks/guard.sh"), RepoRole::HookScript);
        assert_eq!(role_of(".agents/skills/pdf/SKILL.md"), RepoRole::Skill);
        assert_eq!(role_of(".agents/skills/pdf/scripts/run.py"), RepoRole::Skill);
        assert_eq!(role_of(".agents/skills/pdf"), RepoRole::Other, "a file named like a skill's folder isn't a skill");
        assert_eq!(role_of(".agents/projects/cam/arbor/instructions.md"), RepoRole::ProjectInstructions);
        assert_eq!(role_of(".agents/projects/cam/arbor/machines/ci01.md"), RepoRole::ProjectInstructions);
        assert_eq!(role_of(".agents/machines.json"), RepoRole::Record);
        assert_eq!(role_of(".agents/skill-sources.json"), RepoRole::Record);
        assert_eq!(role_of(".claude/settings.json"), RepoRole::Other);
        assert_eq!(role_of(".claude/rules/api-token.md"), RepoRole::Other, "a secret-looking rule isn't synced");
        assert_eq!(role_of("README.md"), RepoRole::Other);
    }

    #[test]
    fn text_is_shown_and_anything_else_says_why_not() {
        assert_eq!(text_of(b"# Hi\n".to_vec()), RepoText { content: Some("# Hi\n".into()), sum: Some(sha256_hex(b"# Hi\n")), problem: None });
        assert_eq!(text_of(vec![0x89, b'P', b'N', b'G', 0, 1]).problem, Some(FileProblem::Binary));
        assert_eq!(text_of(vec![0xff, 0xfe, b'a']).problem, Some(FileProblem::Binary), "not UTF-8");
        assert_eq!(text_of(vec![b'a'; FILE_MAX_BYTES as usize + 1]).problem, Some(FileProblem::Large));
    }

    #[cfg(unix)]
    mod on_disk {
        use super::*;

        fn temp_dir(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("arbor-browse-{name}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            fs::canonicalize(&dir).unwrap()
        }

        fn write(path: &Path, content: &[u8]) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
            tokio::runtime::Runtime::new().unwrap().block_on(future)
        }

        const IDENTITY: [&str; 6] = ["-c", "user.name=Arbor Test", "-c", "user.email=arbor@example.com", "-c", "commit.gpgsign=false"];

        fn git_in(folder: &Path, args: &[&str]) -> String {
            let mut all: Vec<&str> = IDENTITY.to_vec();
            all.extend(args);
            block_on(git_out(folder, &all)).unwrap()
        }

        fn entry<'a>(tree: &'a RepoTree, path: &str) -> Option<&'a RepoEntry> {
            tree.entries.iter().find(|entry| entry.path == path)
        }

        /// A dotfiles repo with the setup folder inside it, committed once.
        fn dotfiles(name: &str) -> (PathBuf, PathBuf) {
            let root = temp_dir(name);
            let folder = root.join("agents");
            write(&root.join("outside.md"), b"# Not the setup folder's\n");
            write(&root.join(".gitignore"), b".DS_Store\n");
            write(&folder.join("README.md"), b"# Agent setup\n");
            write(&folder.join(".claude/CLAUDE.md"), b"# Working agreement\n");
            write(&folder.join(".claude/rules/testing.md"), b"# Testing\n");
            write(&folder.join(".agents/skills/pdf/SKILL.md"), b"---\nname: pdf\n---\n");
            write(&folder.join(".agents/skills/pdf/.env"), b"TOKEN=SECRET-VALUE-1\n");
            write(&folder.join(".agents/skills/pdf/logo.png"), &[0x89, b'P', b'N', b'G', 0, 0, 1]);
            write(&folder.join(".agents/projects/cam/arbor/instructions.md"), b"# Arbor\n");
            write(&folder.join(".agents/machines.json"), b"{}\n");
            std::os::unix::fs::symlink(root.join("outside.md"), folder.join(".claude/agents-link.md")).unwrap();
            git_in(&root, &["init", "--quiet"]);
            git_in(&root, &["add", "-A"]);
            git_in(&root, &["commit", "--quiet", "-m", "Start"]);
            (root, folder)
        }

        #[test]
        fn the_folder_is_listed_with_how_each_file_stands() {
            let (root, folder) = dotfiles("tree");
            write(&folder.join(".claude/CLAUDE.md"), b"# Working agreement\n\n- Ship small.\n");
            fs::remove_file(folder.join(".claude/rules/testing.md")).unwrap();
            write(&folder.join(".claude/commands/ship.md"), b"Run the tests.\n");
            write(&folder.join(".DS_Store"), b"ignored");
            write(&folder.join("notes/big.txt"), &vec![b'a'; FILE_MAX_BYTES as usize + 10]);

            let tree = block_on(list_tree(&folder)).unwrap();
            assert!(!tree.truncated);
            assert!(entry(&tree, "outside.md").is_none() && entry(&tree, "../outside.md").is_none(), "only the folder's files");
            assert!(entry(&tree, ".DS_Store").is_none(), "ignored files stay out");
            let look = |path: &str| entry(&tree, path).map(|entry| (entry.status, entry.role, entry.problem));
            assert_eq!(look("README.md"), Some((RepoStatus::Same, RepoRole::Other, None)));
            assert_eq!(look(".claude/CLAUDE.md"), Some((RepoStatus::Modified, RepoRole::Instructions, None)));
            assert_eq!(look(".claude/rules/testing.md"), Some((RepoStatus::Deleted, RepoRole::Rule, None)));
            assert_eq!(look(".claude/commands/ship.md"), Some((RepoStatus::Added, RepoRole::Command, None)));
            assert_eq!(look(".agents/skills/pdf/SKILL.md"), Some((RepoStatus::Same, RepoRole::Skill, None)));
            assert_eq!(look(".agents/skills/pdf/.env"), Some((RepoStatus::Same, RepoRole::Skill, Some(FileProblem::Secret))));
            assert_eq!(look(".agents/skills/pdf/logo.png"), Some((RepoStatus::Same, RepoRole::Skill, Some(FileProblem::Binary))));
            assert_eq!(look(".agents/projects/cam/arbor/instructions.md"), Some((RepoStatus::Same, RepoRole::ProjectInstructions, None)));
            assert_eq!(look(".agents/machines.json"), Some((RepoStatus::Same, RepoRole::Record, None)));
            assert_eq!(look(".claude/agents-link.md").map(|(_, _, problem)| problem), Some(Some(FileProblem::Link)));
            assert_eq!(look("notes/big.txt"), Some((RepoStatus::Added, RepoRole::Other, Some(FileProblem::Large))));
            assert_eq!(entry(&tree, ".claude/rules/testing.md").map(|entry| entry.size), Some(10), "a deleted file keeps the commit's size");

            // Reading: the folder's copy, a commit's, and never a secret, a link, a binary or a large file's text.
            let read = |path: &str, commit: Option<&str>| block_on(read_text(&folder, path, commit)).unwrap();
            let now = read(".claude/CLAUDE.md", None);
            assert_eq!(now.content.as_deref(), Some("# Working agreement\n\n- Ship small.\n"));
            assert_eq!(now.sum, Some(sha256_hex(b"# Working agreement\n\n- Ship small.\n")));
            let head = block_on(head_commit(&folder)).unwrap();
            assert_eq!(read(".claude/CLAUDE.md", Some(&head)).content.as_deref(), Some("# Working agreement\n"));
            assert_eq!(read(".claude/rules/testing.md", Some(&head)).content.as_deref(), Some("# Testing\n"));
            assert_eq!(read(".claude/rules/testing.md", None), NOTHING);
            assert_eq!(read(".agents/skills/pdf/.env", None), problem_text(FileProblem::Secret));
            assert_eq!(read(".agents/skills/pdf/.env", Some(&head)), problem_text(FileProblem::Secret));
            assert_eq!(read(".agents/skills/pdf/logo.png", None).problem, Some(FileProblem::Binary));
            assert_eq!(read(".claude/agents-link.md", None), problem_text(FileProblem::Link));
            assert_eq!(read(".claude/agents-link.md", Some(&head)), problem_text(FileProblem::Link));
            assert_eq!(read("notes/big.txt", None), problem_text(FileProblem::Large));
            assert!(block_on(read_text(&folder, "../outside.md", None)).is_err());
            assert!(block_on(read_text(&folder, ".git/config", None)).is_err());
            assert!(block_on(read_text(&folder, "README.md", Some("HEAD"))).is_err(), "only a commit's own name");

            // The changes show both copies, and nothing of a secret.
            write(&folder.join(".agents/skills/pdf/.env"), b"TOKEN=SECRET-VALUE-2\n");
            let changes = block_on(folder_changes(&folder)).unwrap();
            let shown = serde_json::to_string(&changes).unwrap();
            assert!(!shown.contains("SECRET-VALUE"), "{shown}");
            let change = |path: &str| changes.iter().find(|change| change.path == path).unwrap();
            assert_eq!(change(".claude/CLAUDE.md").before.as_deref(), Some("# Working agreement\n"));
            assert_eq!(change(".claude/CLAUDE.md").after.as_deref(), Some("# Working agreement\n\n- Ship small.\n"));
            assert_eq!((change(".claude/rules/testing.md").status, change(".claude/rules/testing.md").after.as_deref()), (RepoStatus::Deleted, None));
            assert_eq!(change(".claude/commands/ship.md").status, RepoStatus::Added);
            assert_eq!(change(".agents/skills/pdf/.env").problem, Some(FileProblem::Secret));
            assert!(changes.iter().all(|change| change.path != "README.md"));
            let _ = fs::remove_dir_all(&root);
        }

        #[test]
        fn edits_wait_in_the_folder_until_the_chosen_ones_are_committed() {
            let (root, folder) = dotfiles("edits");
            let sum = |path: &str| block_on(read_text(&folder, path, None)).unwrap().sum;

            // A save lands only on the file as it was read.
            block_on(write_text(&folder, ".claude/rules/naming.md", "# Naming\n", None)).unwrap();
            assert!(block_on(write_text(&folder, ".claude/rules/naming.md", "# Again\n", None)).unwrap_err().contains("already a file"));
            let read = sum(".claude/CLAUDE.md");
            write(&folder.join(".claude/CLAUDE.md"), b"# Changed outside Arbor\n");
            assert!(block_on(write_text(&folder, ".claude/CLAUDE.md", "# Mine\n", read.as_deref())).unwrap_err().contains("changed since"));
            assert_eq!(fs::read(folder.join(".claude/CLAUDE.md")).unwrap(), b"# Changed outside Arbor\n");
            block_on(write_text(&folder, ".claude/CLAUDE.md", "# Mine\n", sum(".claude/CLAUDE.md").as_deref())).unwrap();
            assert_eq!(fs::read(folder.join(".claude/CLAUDE.md")).unwrap(), b"# Mine\n");

            // Nothing secret, nothing through a link, nothing outside, nothing over a file.
            assert!(block_on(write_text(&folder, ".agents/skills/pdf/.env", "X=1\n", None)).unwrap_err().contains("secret"));
            let elsewhere = temp_dir("elsewhere");
            std::os::unix::fs::symlink(&elsewhere, folder.join("linked")).unwrap();
            assert!(block_on(write_text(&folder, "linked/x.md", "# x\n", None)).unwrap_err().contains("link"));
            assert!(!elsewhere.join("x.md").exists());
            assert!(block_on(write_text(&folder, "README.md/x.md", "# x\n", None)).unwrap_err().contains("already a file"));
            assert!(block_on(write_text(&folder, "../escape.md", "# x\n", None)).is_err());
            assert!(!root.join("escape.md").exists());
            assert!(block_on(write_text(&folder, ".agents/skills/pdf/logo.png", "text", None)).is_err());

            // Renames and deletes stay in the folder too.
            block_on(move_path(&folder, ".claude/rules/naming.md", ".claude/rules/style/naming.md")).unwrap();
            assert!(folder.join(".claude/rules/style/naming.md").exists() && !folder.join(".claude/rules/naming.md").exists());
            assert!(block_on(move_path(&folder, "README.md", ".claude/CLAUDE.md")).unwrap_err().contains("already something"));
            assert!(block_on(move_path(&folder, ".claude", ".claude/inner")).unwrap_err().contains("inside itself"));
            assert!(block_on(move_path(&folder, "README.md", "id_rsa")).unwrap_err().contains("secret"));
            assert!(block_on(delete_path(&folder, "linked")).unwrap_err().contains("link"));
            assert!(elsewhere.exists());
            fs::remove_file(folder.join("linked")).unwrap();
            block_on(delete_path(&folder, ".agents/projects")).unwrap();
            assert!(!folder.join(".agents/projects").exists());

            // Discarding puts back what the commit has and drops what it hasn't.
            write(&folder.join("scratch.md"), b"# Scratch\n");
            write(&folder.join("staged.md"), b"# Staged\n");
            git_in(&folder, &["add", "--", "staged.md"]);
            block_on(discard(&folder, &[".agents/projects".into(), "scratch.md".into(), "staged.md".into()])).unwrap();
            assert_eq!(fs::read(folder.join(".agents/projects/cam/arbor/instructions.md")).unwrap(), b"# Arbor\n");
            assert!(!folder.join("scratch.md").exists() && !folder.join("staged.md").exists());

            // A commit takes the chosen files and leaves the rest waiting.
            let tree = block_on(list_tree(&folder)).unwrap();
            let waiting: Vec<&str> = tree.entries.iter().filter(|entry| entry.status != RepoStatus::Same).map(|entry| entry.path.as_str()).collect();
            assert_eq!(waiting, [".claude/CLAUDE.md", ".claude/rules/style/naming.md"]);
            assert!(block_on(commit_paths(&folder, &[".claude/CLAUDE.md".into()], "  ", &IDENTITY)).unwrap_err().contains("message"));
            block_on(commit_paths(&folder, &[".claude/CLAUDE.md".into()], "Tighten the agreement\n", &IDENTITY)).unwrap();
            let tree = block_on(list_tree(&folder)).unwrap();
            assert_eq!(entry(&tree, ".claude/CLAUDE.md").map(|entry| entry.status), Some(RepoStatus::Same));
            assert_eq!(entry(&tree, ".claude/rules/style/naming.md").map(|entry| entry.status), Some(RepoStatus::Added));
            assert!(block_on(commit_paths(&folder, &["README.md".into()], "Nothing", &IDENTITY)).unwrap_err().contains("no changes"));

            // A file whose name says it may hold a secret never goes in, even in a folder chosen whole.
            write(&folder.join(".agents/skills/pdf/api-token.txt"), b"SECRET\n");
            assert!(block_on(commit_paths(&folder, &[".agents/skills/pdf".into()], "Add the token", &IDENTITY)).unwrap_err().contains("secret"));

            // History lists the folder's commits, newest first, and what each changed.
            let commits = block_on(log(&folder, 10)).unwrap();
            assert_eq!(commits.iter().map(|commit| serde_json::to_value(commit).unwrap()["subject"].clone()).collect::<Vec<_>>(), ["Tighten the agreement", "Start"]);
            let head = block_on(head_commit(&folder)).unwrap();
            let changed = block_on(commit_changes(&folder, &head)).unwrap();
            assert_eq!(changed.len(), 1);
            assert_eq!((changed[0].path.as_str(), changed[0].status), (".claude/CLAUDE.md", RepoStatus::Modified));
            assert_eq!((changed[0].before.as_deref(), changed[0].after.as_deref()), (Some("# Working agreement\n"), Some("# Mine\n")));
            let first = serde_json::to_value(&commits[1]).unwrap()["sha"].as_str().unwrap().to_string();
            let started = block_on(commit_changes(&folder, &first)).unwrap();
            assert!(started.iter().all(|change| change.status == RepoStatus::Added));
            assert!(started.iter().all(|change| !change.path.starts_with("..") && change.path != "outside.md"));
            let env = started.iter().find(|change| change.path == ".agents/skills/pdf/.env").unwrap();
            assert_eq!((env.after.as_deref(), env.problem), (None, Some(FileProblem::Secret)));
            assert!(!serde_json::to_string(&started).unwrap().contains("SECRET-VALUE"));
            let _ = fs::remove_dir_all(&root);
            let _ = fs::remove_dir_all(&elsewhere);
        }

        #[test]
        fn a_repo_with_no_commits_lists_its_files_as_added() {
            let root = temp_dir("fresh");
            write(&root.join(".claude/CLAUDE.md"), b"# New\n");
            git_in(&root, &["init", "--quiet"]);
            let tree = block_on(list_tree(&root)).unwrap();
            assert_eq!(entry(&tree, ".claude/CLAUDE.md").map(|entry| entry.status), Some(RepoStatus::Added));
            assert!(block_on(log(&root, 10)).unwrap().is_empty());
            block_on(commit_paths(&root, &[".claude/CLAUDE.md".into()], "First", &IDENTITY)).unwrap();
            assert_eq!(block_on(log(&root, 10)).unwrap().len(), 1);
            let _ = fs::remove_dir_all(&root);
        }
    }
}

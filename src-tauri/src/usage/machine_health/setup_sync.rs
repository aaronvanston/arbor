//! Setup sync: a git repo on this Mac holds the instructions, rules, subagents
//! and commands the agents should load, each where it goes in a home folder:
//! .claude/CLAUDE.md, .claude/rules/, .claude/agents/ and .claude/commands/,
//! .codex/AGENTS.md and .codex/prompts/, and the AGENTS.md each other harness reads
//! in its own home (`harnesses::repo_instructions`). CLAUDE.md and AGENTS.md stay separate
//! files. The repo can be a folder in a larger one, like a dotfiles repo.
//!
//! A machine is brought in step with the repo's last commit only after the page
//! has shown what will change, and then carefully:
//! - nothing is written or removed unless every file is still what the last
//!   scan found, so a change made since is never overwritten;
//! - each file that's replaced or removed is first copied to
//!   ~/.arbor/setup-backups/<when>/, with a list of what changed, so the change
//!   can be undone for as long as those files stay as Arbor left them (see
//!   guarded_writes, which the settings edits other features make share; the
//!   list and undo here cover them all);
//! - each file is written beside itself, checked, then moved into place.
//!
//! A machine's copy of a file can also be taken into the repo, as a commit of
//! that file alone. Links are left alone, since what they lead to is kept
//! elsewhere. Skills in the repo's .agents/skills are synced the same way, a
//! folder at a time, into each machine's ~/.agents/skills (see
//! setup_repo_skills). MCP servers are kept in .agents/mcp-servers.json and set
//! up through each agent (see setup_mcp). The scripts hooks run sync from
//! .agents/hooks into each machine's ~/.agents/hooks, made runnable, and the
//! hooks themselves are kept in .agents/hooks.json (see setup_hooks). Settings
//! and plugins aren't synced.

use super::shell::shell_quote;
use ts_rs::TS;
use super::setup::{covered_machine, is_script_name, looks_secret, read_text, rescan, scanned_item, SetupText, HELPERS, TEXT_KINDS};
use super::setup_mcp::{holds_secret, MCP_FILE};
use super::setup_hooks::HOOKS_FILE;
use super::project_instructions as instructions;
use super::setup_wanted::{self as wanted, RepoPlugin, SkillMachines, SkillProjects, MACHINES_FILE, PLUGINS_FILE};
use super::setup_repo_skills::{self as repo_skills, RepoSkill, SkillEntry, SkillFiles, SKILLS_DIR, SOURCES_FILE};
use super::guarded_writes::{
    base64_lines, cksum, is_stamp, new_stamp, parse_outcome, prune_backups, record_backup, run_on, stamp_ms, start_backup, BackupEdit,
    undo_edit_actions, undo_edit_checks, ChangeKind, SyncOutcome, BACKUPS_SCRIPT, STATE_FUNCTIONS,
};
use super::harnesses;
use super::setup_skills::{self, BackupSkill};
use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub(super) const GIT_TIMEOUT: Duration = Duration::from_secs(20);
/// For pulling and pushing, which wait on the network.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(90);
/// The largest file the repo syncs.
pub(super) const FILE_MAX_BYTES: u64 = 1024 * 1024;
/// Files in these folders that the repo doesn't sync are listed, so it's clear they aren't: Claude Code's, Codex's and
/// the store's, and the other harnesses' homes.
fn agent_folders() -> Vec<String> {
    [".claude/", ".codex/", ".agents/"].into_iter().map(str::to_string).chain(harnesses::repo_homes()).collect()
}

const README: &str = "# Agent setup\n\n\
Arbor keeps each machine's Claude Code and Codex setup in step with this repo.\n\
Each file sits where it goes in the home folder:\n\n\
- `.claude/CLAUDE.md`, and `.claude/rules/`, `.claude/agents/` and `.claude/commands/`\n\
- `.codex/AGENTS.md` and `.codex/prompts/`\n\
- the `AGENTS.md` other agents read, in each one's folder: `.pi/agent/`, `.factory/` and the like\n\
- `.agents/skills/`, a folder for each skill, which goes into each machine's `~/.agents/skills`\n\n\
`.agents/skill-sources.json` records where skills came from, so Arbor can\n\
update them from GitHub. `.agents/mcp-servers.json` defines the MCP servers each\n\
machine's Claude Code and Codex homes get, naming secrets as variables rather\n\
than holding them. Arbor syncs what's committed. Commit a change, then review what it changes on\n\
each machine on Arbor's Sync page.\n";

/// The kind of file a path in the home folder is, when the repo syncs it:
/// A kind of file the setup repo syncs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SyncFileKind {
    Instructions,
    Rule,
    Subagent,
    Command,
    /// A script the repo's hooks run, in ~/.agents/hooks.
    HookScript,
}

/// Claude Code's CLAUDE.md, rules, subagents and commands, Codex's AGENTS.md
/// and prompts, and the scripts hooks run, where the scans look for them.
pub(super) fn managed(rel: &str) -> Option<SyncFileKind> {
    if rel.contains('\\') || rel.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return None;
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let markdown = name.len() > 3 && name.ends_with(".md") && !looks_secret(rel);
    if harnesses::repo_instructions().any(|path| path == rel) {
        return Some(SyncFileKind::Instructions);
    }
    let (home, rest) = rel.split_once('/')?;
    let (folder, within) = rest.split_once('/').unwrap_or(("", rest));
    match (home, folder) {
        (".claude", "") if rest == "CLAUDE.md" => Some(SyncFileKind::Instructions),
        (".codex", "") if rest == "AGENTS.md" => Some(SyncFileKind::Instructions),
        (".claude", "rules") if markdown => Some(SyncFileKind::Rule),
        (".claude", "agents") if markdown && !within.contains('/') => Some(SyncFileKind::Subagent),
        (".claude", "commands") | (".codex", "prompts") if markdown => Some(SyncFileKind::Command),
        (".agents", "hooks") if is_script_name(within) && !looks_secret(rel) => Some(SyncFileKind::HookScript),
        _ => None,
    }
}

/// A path as the scan names it (~/.claude/CLAUDE.md), as a path in the home folder, when the repo syncs it.
fn home_relative(path: &str) -> Result<&str, String> {
    path.strip_prefix("~/")
        .filter(|rel| managed(rel).is_some())
        .ok_or_else(|| format!("Arbor doesn't sync {path}"))
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// A commit named the way git names one: 40 or 64 hex digits.
pub(super) fn is_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// A fingerprint as the scan gives one: a SHA-256, or `cksum`'s checksum and length after a c.
fn is_sum(value: &str) -> bool {
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        || value.strip_prefix('c').and_then(|rest| rest.split_once('-')).is_some_and(|(crc, len)| {
            !crc.is_empty() && !len.is_empty() && crc.bytes().chain(len.bytes()).all(|byte| byte.is_ascii_digit())
        })
}

// ---------------------------------------------------------------------------
// The repo
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoCommit {
    sha: String,
    subject: String,
    at_ms: i64,
}

#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoUpstream {
    name: String,
    /// Commits here that the upstream hasn't got, and the other way round, as of the last fetch.
    ahead: u32,
    behind: u32,
}

/// A file the repo syncs, as its last commit has it.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "SetupRepoFile")]
pub(crate) struct RepoFile {
    /// Where it goes, as the scan names it: ~/.claude/CLAUDE.md.
    path: String,
    kind: SyncFileKind,
    /// Its SHA-256, and its checksum for machines that fingerprint with `cksum`.
    sum: String,
    ck: String,
    size: u64,
}

#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupRepo {
    /// The folder, as it was chosen.
    path: String,
    /// None when no branch is checked out.
    branch: Option<String>,
    /// None until something is committed.
    head: Option<RepoCommit>,
    upstream: Option<RepoUpstream>,
    /// Files it syncs that have changes not committed, which aren't synced until they are.
    uncommitted: Vec<String>,
    files: Vec<RepoFile>,
    /// The skills it syncs into each machine's store, ~/.agents/skills.
    skills: Vec<RepoSkill>,
    /// Other files under .claude, .codex or .agents, which it doesn't sync.
    ignored: Vec<String>,
    /// Machines with a value of their own for a skill, from .agents/machines.json: skill → normalized machine → value.
    skill_machines: SkillMachines,
    /// Skills the repo has taken off every machine (.agents/machines.json), which each machine's store has no more
    /// business keeping. A skill back in the repo isn't listed.
    removed_skills: Vec<String>,
    /// Rules, subagents and commands the repo has taken off every machine, as the scan names them. A file back in the
    /// repo isn't listed.
    removed_files: Vec<String>,
    /// Skills the repo keeps but has turned off on every machine (.agents/machines.json), so each machine's store copy
    /// is the repo's to take out until they're turned on again.
    off_skills: Vec<String>,
    /// Rules, subagents and commands the repo keeps but has turned off on every machine, as the scan names them.
    off_files: Vec<String>,
    /// Machines with a value of their own for a rule, subagent or command, from .agents/machines.json: path as the scan
    /// names it → normalized machine → value.
    file_machines: SkillMachines,
    /// Projects with a value of their own for a skill, from .agents/machines.json: skill → project → value.
    skill_projects: SkillProjects,
    /// Projects with a value of their own for an MCP server, from .agents/machines.json: server → project → value.
    mcp_projects: SkillProjects,
    /// The plugins .agents/plugins.json lists, with each one's value for every machine and the machines' own.
    plugins: Vec<RepoPlugin>,
    /// The Codex plugins .agents/plugins.json lists under `codex`, with each one's value for every machine and the
    /// machines' own. Codex's plugins and marketplaces aren't Claude Code's, so they're never compared.
    codex_plugins: Vec<RepoPlugin>,
    /// Projects' own instructions, for every machine and for one, under .agents/projects.
    instructions: Vec<instructions::RepoInstructions>,
}

pub(super) async fn git(folder: &Path, args: &[&str], timeout: Duration) -> Result<std::process::Output, String> {
    let mut command = tokio::process::Command::new("git");
    command
        .arg("-C")
        .arg(folder)
        .args(args)
        // Never wait on a password prompt nobody can see.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_helper_command(&mut command);
    let child = command.spawn().map_err(|error| format!("Could not run git: {error}"))?;
    tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| format!("git timed out after {}s", timeout.as_secs()))?
        .map_err(|error| format!("git failed: {error}"))
}

/// What a git command printed, or why it failed.
/// The last thing git said went wrong, without the hints it adds after.
fn git_failure(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("hint:"))
        .last()
        .map_or_else(|| format!("git exited with {}", output.status), str::to_string)
}

pub(super) async fn git_out(folder: &Path, args: &[&str]) -> Result<String, String> {
    let output = git(folder, args, GIT_TIMEOUT).await?;
    if !output.status.success() {
        return Err(git_failure(&output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The content of each object named, in order.
pub(super) async fn blobs(folder: &Path, objects: &[&str]) -> Result<Vec<Vec<u8>>, String> {
    if objects.is_empty() {
        return Ok(Vec::new());
    }
    let mut command = tokio::process::Command::new("git");
    command
        .arg("-C")
        .arg(folder)
        .args(["cat-file", "--batch"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_helper_command(&mut command);
    let mut child = command.spawn().map_err(|error| format!("Could not run git: {error}"))?;
    let input = format!("{}\n", objects.join("\n"));
    let mut stdin = child.stdin.take().ok_or("Could not talk to git")?;
    // Written while the output is read, so neither side waits on the other.
    let feed = async move {
        let _ = stdin.write_all(input.as_bytes()).await;
    };
    let (_, output) = tokio::time::timeout(GIT_TIMEOUT, async { tokio::join!(feed, child.wait_with_output()) })
        .await
        .map_err(|_| format!("git timed out after {}s", GIT_TIMEOUT.as_secs()))?;
    let output = output.map_err(|error| format!("git failed: {error}"))?;
    if !output.status.success() {
        return Err(git_failure(&output));
    }
    let mut rest = output.stdout.as_slice();
    let mut contents = Vec::with_capacity(objects.len());
    for object in objects {
        let broken = || format!("git sent back {object} incomplete");
        let end = rest.iter().position(|byte| *byte == b'\n').ok_or_else(broken)?;
        let header = String::from_utf8_lossy(&rest[..end]);
        let size: usize = header.rsplit(' ').next().and_then(|size| size.parse().ok()).ok_or_else(broken)?;
        let body = rest.get(end + 1..end + 1 + size).ok_or_else(broken)?;
        contents.push(body.to_vec());
        rest = rest.get(end + 2 + size..).unwrap_or_default();
    }
    Ok(contents)
}

pub(super) fn parse_commit(line: &str) -> Option<RepoCommit> {
    let mut fields = line.trim_end_matches('\n').split('\0');
    let sha = fields.next().filter(|sha| is_commit(sha))?.to_string();
    let subject = fields.next().unwrap_or_default().to_string();
    let at_ms = fields.next().and_then(|seconds| seconds.trim().parse::<i64>().ok()).map_or(0, |seconds| seconds * 1000);
    Some(RepoCommit { sha, subject, at_ms })
}

async fn upstream(folder: &Path) -> Option<RepoUpstream> {
    let name = git_out(folder, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).await.ok()?;
    let counts = git_out(folder, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]).await.ok()?;
    let (behind, ahead) = counts.trim().split_once('\t')?;
    Some(RepoUpstream { name: name.trim().to_string(), ahead: ahead.parse().ok()?, behind: behind.parse().ok()? })
}

/// The synced files and skills under the folder with changes that aren't committed, as the scan names them.
async fn uncommitted(folder: &Path, prefix: &str) -> Result<Vec<String>, String> {
    let status = git_out(folder, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]).await?;
    let mut paths = BTreeSet::new();
    let mut entries = status.split('\0');
    while let Some(entry) = entries.next() {
        let (Some(code), Some(path)) = (entry.get(..2), entry.get(3..)) else { continue };
        // A rename or copy is followed by the path it came from.
        if code.contains('R') || code.contains('C') {
            entries.next();
        }
        let Some(rel) = path.strip_prefix(prefix) else { continue };
        if managed(rel).is_some() {
            paths.insert(format!("~/{rel}"));
        } else if let Some(entry) = SkillEntry::parse(rel, "", "", "", "") {
            paths.insert(format!("~/{SKILLS_DIR}/{}", entry.name()));
        }
    }
    Ok(paths.into_iter().collect())
}

/// The files and skills the repo syncs as `commit` has them, and the others it holds under the agents' folders.
/// What a commit's tree holds: files, skills, what's ignored, the machines' values and removed marks, what's off
/// everywhere, projects' values and plugins.
type Tree = (Vec<RepoFile>, Vec<RepoSkill>, Vec<String>, (SkillMachines, Vec<String>, Vec<String>, SkillMachines), (Vec<String>, Vec<String>), (SkillProjects, SkillProjects), (Vec<RepoPlugin>, Vec<RepoPlugin>));

async fn tree(folder: &Path, prefix: &str, commit: &str) -> Result<Tree, String> {
    let listing = git_out(folder, &["ls-tree", "-r", "-l", "-z", "--full-name", commit, "--", "."]).await?;
    let mut synced: Vec<(String, SyncFileKind, String)> = Vec::new();
    let mut skills = Vec::new();
    let mut sources = None;
    let mut machines_file = None;
    let mut plugins_file = None;
    let mut ignored = Vec::new();
    for entry in listing.split('\0') {
        let Some((meta, full)) = entry.split_once('\t') else { continue };
        let Some(rel) = full.strip_prefix(prefix) else { continue };
        let fields: Vec<&str> = meta.split_whitespace().collect();
        let [mode, kind, object, size] = fields.as_slice() else { continue };
        if let Some(entry) = SkillEntry::parse(rel, mode, kind, object, size) {
            skills.push(entry);
            continue;
        }
        let file = *kind == "blob" && matches!(*mode, "100644" | "100755");
        if rel == SOURCES_FILE && file {
            sources = Some(object.to_string());
            continue;
        }
        if (rel == MCP_FILE || rel == HOOKS_FILE) && file {
            continue;
        }
        if file && instructions::instructions_file(rel).is_some() {
            continue;
        }
        if rel == MACHINES_FILE && file {
            machines_file = Some(object.to_string());
            continue;
        }
        if rel == PLUGINS_FILE && file {
            plugins_file = Some(object.to_string());
            continue;
        }
        match managed(rel) {
            Some(kind) if file && size.parse::<u64>().is_ok_and(|size| size <= FILE_MAX_BYTES) => {
                synced.push((rel.to_string(), kind, object.to_string()));
            }
            _ if agent_folders().iter().any(|folder| rel.starts_with(folder.as_str())) => ignored.push(rel.to_string()),
            _ => {}
        }
    }
    let objects: Vec<&str> = synced.iter().map(|(_, _, object)| object.as_str()).collect();
    let contents = blobs(folder, &objects).await?;
    let files: Vec<RepoFile> = synced
        .into_iter()
        .zip(contents)
        .map(|((rel, kind, _), bytes)| RepoFile {
            path: format!("~/{rel}"),
            kind,
            sum: sha256_hex(&bytes),
            ck: cksum(&bytes),
            size: bytes.len() as u64,
        })
        .collect();
    let skills = repo_skills::read_skills(folder, skills, sources.as_deref()).await?;
    let machines_bytes = match machines_file {
        Some(object) => blobs(folder, &[object.as_str()]).await?.into_iter().next(),
        None => None,
    };
    let skill_machines = machines_bytes.as_deref().map(wanted::parse).unwrap_or_default();
    // A skill taken back into the repo is its again, whatever the mark says.
    let removed_skills: Vec<String> = machines_bytes
        .as_deref()
        .map(wanted::parse_removed)
        .unwrap_or_default()
        .into_iter()
        .filter(|name| !skills.iter().any(|skill| skill.name() == name))
        .collect();
    let removed_files: Vec<String> = machines_bytes
        .as_deref()
        .map(wanted::parse_removed_files)
        .unwrap_or_default()
        .into_iter()
        .filter(|path| !files.iter().any(|file| &file.path == path))
        .collect();
    let file_machines = machines_bytes.as_deref().map(wanted::parse_file_machines).unwrap_or_default();
    // Only what the repo has can be off; a mark left on one it no longer has says nothing.
    let off_skills: Vec<String> =
        machines_bytes.as_deref().map(wanted::parse_off).unwrap_or_default().into_iter().filter(|name| skills.iter().any(|skill| skill.name() == name)).collect();
    let off_files: Vec<String> =
        machines_bytes.as_deref().map(wanted::parse_off_files).unwrap_or_default().into_iter().filter(|path| files.iter().any(|file| &file.path == path)).collect();
    let skill_projects = machines_bytes.as_deref().map(|bytes| wanted::parse_projects(bytes, wanted::SKILLS_SECTION)).unwrap_or_default();
    let mcp_projects = machines_bytes.as_deref().map(|bytes| wanted::parse_projects(bytes, wanted::MCP_SECTION)).unwrap_or_default();
    let plugins_bytes = match plugins_file {
        Some(object) => blobs(folder, &[object.as_str()]).await?.into_iter().next(),
        None => None,
    };
    let plugins = plugins_bytes.as_deref().map(wanted::parse_plugins).unwrap_or_default();
    let codex_plugins = plugins_bytes.as_deref().map(wanted::parse_codex_plugins).unwrap_or_default();
    Ok((files, skills, ignored, (skill_machines, removed_skills, removed_files, file_machines), (off_skills, off_files), (skill_projects, mcp_projects), (plugins, codex_plugins)))
}

/// What the repo in `folder` holds and where its branch stands.
pub(super) async fn read_repo(folder: &Path) -> Result<SetupRepo, String> {
    if !folder.is_dir() {
        return Err(format!("Arbor can't find {}", folder.display()));
    }
    let inside = git(folder, &["rev-parse", "--is-inside-work-tree", "--show-prefix"], GIT_TIMEOUT).await?;
    let found = String::from_utf8_lossy(&inside.stdout);
    let mut lines = found.lines();
    if !inside.status.success() || lines.next() != Some("true") {
        return Err(format!("{} isn't in a git repo", folder.display()));
    }
    let prefix = lines.next().unwrap_or_default().to_string();
    let branch = git_out(folder, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await
        .ok()
        .map(|branch| branch.trim().to_string())
        .filter(|branch| !branch.is_empty());
    let last = git(folder, &["log", "-1", "--format=%H%x00%s%x00%ct"], GIT_TIMEOUT).await?;
    let head = last.status.success().then(|| parse_commit(&String::from_utf8_lossy(&last.stdout))).flatten();
    let (files, skills, ignored, (skill_machines, removed_skills, removed_files, file_machines), (off_skills, off_files), (skill_projects, mcp_projects), (plugins, codex_plugins)) = match &head {
        Some(head) => tree(folder, &prefix, &head.sha).await?,
        None => (
            Vec::new(),
            Vec::new(),
            Vec::new(),
            (SkillMachines::new(), Vec::new(), Vec::new(), SkillMachines::new()),
            (Vec::new(), Vec::new()),
            (SkillProjects::new(), SkillProjects::new()),
            (Vec::new(), Vec::new()),
        ),
    };
    let instructions = match &head {
        Some(head) => instructions::list(folder, &prefix, &head.sha).await?,
        None => Vec::new(),
    };
    Ok(SetupRepo {
        path: folder.display().to_string(),
        branch,
        upstream: if head.is_some() { upstream(folder).await } else { None },
        head,
        uncommitted: uncommitted(folder, &prefix).await?,
        files,
        skills,
        ignored,
        skill_machines,
        removed_skills,
        removed_files,
        off_skills,
        off_files,
        file_machines,
        skill_projects,
        mcp_projects,
        plugins,
        codex_plugins,
        instructions,
    })
}

/// The content of a synced file as `commit` has it.
pub(super) async fn repo_file(folder: &Path, commit: &str, rel: &str) -> Result<Vec<u8>, String> {
    if !is_commit(commit) {
        return Err("That isn't a commit".into());
    }
    let output = git(folder, &["cat-file", "blob", &format!("{commit}:./{rel}")], GIT_TIMEOUT).await?;
    if !output.status.success() {
        return Err(format!("The repo's commit has no {rel}"));
    }
    Ok(output.stdout)
}

/// This Mac's files that the repo would sync, each as a path in the home folder with its content.
fn home_files(home: &Path) -> Vec<(String, Vec<u8>)> {
    fn add(home: &Path, rel: String, files: &mut Vec<(String, Vec<u8>)>) {
        let path = home.join(&rel);
        let Ok(meta) = fs::metadata(&path) else { return };
        if meta.is_file() && meta.len() <= FILE_MAX_BYTES && managed(&rel).is_some() {
            if let Ok(bytes) = fs::read(&path) {
                files.push((rel, bytes));
            }
        }
    }
    fn walk(home: &Path, rel: &str, depth: usize, files: &mut Vec<(String, Vec<u8>)>) {
        let Ok(entries) = fs::read_dir(home.join(rel)) else { return };
        for entry in entries.flatten() {
            let within = format!("{rel}/{}", entry.file_name().to_string_lossy());
            if entry.path().is_dir() {
                if depth < 8 {
                    walk(home, &within, depth + 1, files);
                }
            } else {
                add(home, within, files);
            }
        }
    }
    let mut files = Vec::new();
    for rel in [".claude/CLAUDE.md", ".codex/AGENTS.md"].into_iter().chain(harnesses::repo_instructions()) {
        add(home, rel.to_string(), &mut files);
    }
    for rel in [".claude/rules", ".claude/agents", ".claude/commands", ".codex/prompts"] {
        walk(home, rel, 0, &mut files);
    }
    files.sort();
    files
}

/// Starts a repo in `folder` with this Mac's files and store skills from `home`, as one commit. A
/// folder in a repo already gets the commit there; `git_config` is set for each git command.
async fn start_repo(folder: &Path, home: &Path, machine: &str, git_config: &[&str]) -> Result<SetupRepo, String> {
    if agent_folders().iter().any(|name| folder.join(name.trim_end_matches('/')).exists()) {
        return Err(format!("{} already has agent files in it. Choose it as the repo instead.", folder.display()));
    }
    fs::create_dir_all(folder).map_err(|error| format!("Arbor couldn't make {}: {error}", folder.display()))?;
    let empty = fs::read_dir(folder).map_err(|error| error.to_string())?.next().is_none();
    let files = home_files(home);
    for (rel, bytes) in &files {
        let path = folder.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&path, bytes).map_err(|error| format!("Arbor couldn't write {rel}: {error}"))?;
    }
    let mut added: Vec<String> = files.iter().map(|(rel, _)| rel.clone()).collect();
    let (skills, sources) = repo_skills::local_skills(&home.join(SKILLS_DIR), &home.join(".agents/.skill-lock.json"));
    for (name, files) in &skills {
        let rel = format!("{SKILLS_DIR}/{name}");
        repo_skills::put_files(&folder.join(&rel), &rel, files)?;
        added.extend(files.iter().map(|file| format!("{rel}/{}", file.rel)));
    }
    if !sources.is_empty() && repo_skills::record_sources(folder, &sources)? {
        added.push(SOURCES_FILE.into());
    }
    if empty {
        fs::write(folder.join("README.md"), README).map_err(|error| error.to_string())?;
        added.push("README.md".into());
    }
    let command = |args: &[&str]| -> Vec<String> {
        git_config.iter().chain(["--literal-pathspecs"].iter()).chain(args).map(|arg| arg.to_string()).collect()
    };
    let run = |args: Vec<String>| async move {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        git_out(folder, &args).await
    };
    let inside = git(folder, &["rev-parse", "--is-inside-work-tree"], GIT_TIMEOUT).await?;
    if !inside.status.success() {
        run(command(&["init", "--quiet"])).await?;
    }
    if !added.is_empty() {
        let mut add = command(&["add", "-f", "--"]);
        add.extend(added.iter().map(|rel| format!("./{rel}")));
        run(add).await?;
        let message = format!("Start from {machine}");
        let mut commit = command(&["commit", "--quiet", "-m", &message, "--"]);
        commit.extend(added.iter().map(|rel| format!("./{rel}")));
        run(commit).await?;
    }
    read_repo(folder).await
}

/// Commits `content` as the repo's copy of `rel`, and nothing else.
pub(super) async fn take_into_repo(folder: &Path, rel: &str, content: &[u8], message: &str, git_config: &[&str]) -> Result<(), String> {
    if managed(rel).is_none() && rel != MCP_FILE && rel != HOOKS_FILE && rel != MACHINES_FILE && rel != PLUGINS_FILE && instructions::instructions_file(rel).is_none() {
        return Err(format!("Arbor doesn't sync {rel}"));
    }
    let pathspec = format!("./{rel}");
    let changes = git_out(folder, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", &pathspec]).await?;
    if !changes.is_empty() {
        return Err(format!("{rel} has changes in the repo that aren't committed. Commit or drop them, then try again."));
    }
    let path = folder.join(rel);
    if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(format!("{rel} is a link in the repo, which Arbor leaves alone"));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, content).map_err(|error| format!("Arbor couldn't write {rel}: {error}"))?;
    let with = |args: &[&str]| -> Vec<String> { git_config.iter().chain(args).map(|arg| arg.to_string()).collect() };
    let add = with(&["add", "--", &pathspec]);
    git_out(folder, &add.iter().map(String::as_str).collect::<Vec<_>>()).await?;
    // Nothing to commit when the copy is the repo's already.
    let staged = git(folder, &["diff", "--cached", "--quiet", "--", &pathspec], GIT_TIMEOUT).await?;
    if staged.status.success() {
        return Ok(());
    }
    let commit = with(&["commit", "--quiet", "-m", message, "--", &pathspec]);
    git_out(folder, &commit.iter().map(String::as_str).collect::<Vec<_>>()).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------

/// A file or skill to write on a machine, or to remove from it, as the page asks.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncChange {
    /// As the scan names it: ~/.claude/CLAUDE.md, or ~/.agents/skills/pdf for a skill.
    path: String,
    /// Remove the machine's copy, rather than write the repo's.
    remove: bool,
    /// Its fingerprint on the machine as the last scan found it, or None when it wasn't there.
    before: Option<String>,
}

/// What a change writes.
enum Content {
    File(Vec<u8>),
    /// A skill's folder, whole.
    Skill(SkillFiles),
}

/// A change as the script makes it.
struct Planned {
    rel: String,
    /// The fingerprint it must have before it's changed: what the last scan found, `-` for nothing.
    /// A skill's folder has a D before its fingerprint, as `place` gives it.
    before: String,
    /// What to write, or None to remove it.
    content: Option<Content>,
    /// A skill's folder rather than a file.
    folder: bool,
}

// Follows HELPERS and STATE_FUNCTIONS. `now` prints a file's fingerprint as
// the scan gives it: `-` when nothing's there, `L` for a link and `?` for
// anything else. `expect` notes each file that isn't as planned, and `put`
// writes base64 from its input beside a file, checks it, then moves it into
// place.
const CHANGE_FUNCTIONS: &str = r##"now() {
  f="$HOME/$1"
  if [ -L "$f" ]; then printf L
  elif [ -f "$f" ]; then sum_in < "$f" || printf '?'
  elif [ -e "$f" ]; then printf '?'
  else printf -
  fi
}
changed=0
failed=0
expect() {
  if [ "$(now "$1")" != "$2" ]; then printf 'X\t%s\tchanged\n' "$1"; changed=1; fi
}
pick() {
  if [ "$hashed" = sha ]; then printf '%s' "$1"; else printf '%s' "$2"; fi
}
put() {
  f="$HOME/$1"; tmp="$f.arbor-tmp"
  if mkdir -p "$(dirname "$f")" && rm -f "$tmp" && { [ ! -f "$f" ] || cp -p "$f" "$tmp"; } && unbase > "$tmp" \
    && [ "$(sum_in < "$tmp")" = "$(pick "$2" "$3")" ] && { case "$1" in .agents/hooks/*) chmod +x "$tmp" ;; esac; } && mv -f "$tmp" "$f"; then
    printf 'W\t%s\n' "$1"
  else
    rm -f "$tmp"; printf 'X\t%s\tfailed\n' "$1"; failed=1
  fi
}
drop() {
  if rm -f "$HOME/$1"; then printf 'D\t%s\n' "$1"; else printf 'X\t%s\tfailed\n' "$1"; failed=1; fi
}
"##;

// Follows CHANGE_FUNCTIONS and SKILL_FUNCTIONS, once the backup `$dir` is
// made. A skill's folder is written in the backup, at `$dir/new/<index>`, a
// file at a time (`wf`, x to make it runnable), then `fold` checks it's the
// repo's copy and swaps it in, moving the machine's aside to
// `$dir/folders/<index>`. `unfold` moves a folder aside instead, and `refold`
// undoes either, moving what the change left aside to `$dir/undone/<index>`.
// Nothing is removed: whatever's replaced stays in the backup.
const FOLDER_FUNCTIONS: &str = r##"wf() {
  mkdir -p "$(dirname "$1/$2")" && unbase > "$1/$2" && { [ "$3" = - ] || chmod +x "$1/$2"; }
}
fold() {
  f="$home/$1"; n="$dir/new/$2"; o="$dir/folders/$2"
  if [ "$(place "$n")" = "D$(pick "$3" "$4")" ] && mkdir -p "$dir/folders" "${f%/*}"; then
    if ! there "$f" || mv "$f" "$o"; then
      if mv "$n" "$f"; then printf 'W\t%s\n' "$1"; return 0; fi
      if there "$o"; then mv "$o" "$f"; fi
    fi
  fi
  printf 'X\t%s\tfailed\n' "$1"; failed=1
}
unfold() {
  if mkdir -p "$dir/folders" && mv "$home/$1" "$dir/folders/$2"; then printf 'D\t%s\n' "$1"; else printf 'X\t%s\tfailed\n' "$1"; failed=1; fi
}
refold() {
  f="$home/$1"; o="$dir/folders/$2"; u="$dir/undone/$2"
  if there "$f"; then
    if ! mkdir -p "$dir/undone" || ! mv "$f" "$u"; then printf 'X\t%s\tfailed\n' "$1"; failed=1; return 0; fi
  fi
  if ! there "$o"; then printf 'D\t%s\n' "$1"; return 0; fi
  if mkdir -p "${f%/*}" && mv "$o" "$f"; then printf 'W\t%s\n' "$1"; return 0; fi
  if there "$u"; then mv "$u" "$f"; fi
  printf 'X\t%s\tfailed\n' "$1"; failed=1
}
"##;

/// Makes the changes on a machine, all or none: every file and skill is checked
/// first, then the files there now are copied to the backup `stamp`, with a list
/// of what changes and to what, then each is written or removed. Lines out: `X
/// file why` for one that wasn't changed, `K stamp` once the backup is made,
/// then `W file` or `D file` for each written or removed.
fn apply_script(stamp: &str, commit: &str, changes: &[Planned]) -> String {
    let mut script = format!("set -u\nexport LC_ALL=C\n{HELPERS}{STATE_FUNCTIONS}{CHANGE_FUNCTIONS}{}{FOLDER_FUNCTIONS}", setup_skills::SKILL_FUNCTIONS);
    for change in changes {
        let (rel, before) = (shell_quote(&change.rel), shell_quote(&change.before));
        if change.folder {
            script.push_str(&format!("check \"$home/\"{rel} {before} {rel}\n"));
        } else {
            script.push_str(&format!("expect {rel} {before}\n"));
        }
    }
    script.push_str("[ \"$changed\" = 0 ] || exit 0\n");
    script.push_str(&start_backup(stamp, "files"));
    script.push_str(
        "keep() {\n\
         \x20 [ -f \"$HOME/$1\" ] || return 0\n\
         \x20 mkdir -p \"$dir/files/$(dirname \"$1\")\" && cp -p \"$HOME/$1\" \"$dir/files/$1\" \\\n\
         \x20   || { echo \"Arbor couldn't back up ~/$1, so it changed nothing\" >&2; rm -rf \"$dir\"; exit 5; }\n\
         }\n",
    );
    let mut manifest = format!("commit\t{commit}\n");
    for change in changes {
        if !change.folder {
            script.push_str(&format!("keep {}\n", shell_quote(&change.rel)));
        }
        let (rel, before) = (&change.rel, &change.before);
        manifest.push_str(&match &change.content {
            Some(Content::File(bytes)) => format!("F\t{rel}\t{before}\t{}\t{}\n", sha256_hex(bytes), cksum(bytes)),
            Some(Content::Skill(skill)) => format!("P\t{rel}\t{before}\t{}\t{}\n", skill.sum, skill.ck),
            None if change.folder => format!("P\t{rel}\t{before}\t-\t-\n"),
            None => format!("D\t{rel}\t{before}\t-\t-\n"),
        });
    }
    script.push_str(&record_backup(stamp, ChangeKind::Sync, &manifest));
    for (index, change) in changes.iter().enumerate() {
        let rel = shell_quote(&change.rel);
        match &change.content {
            Some(Content::File(bytes)) => script.push_str(&format!(
                "put {rel} {} {} <<'ARBOR_EOF'\n{}ARBOR_EOF\n",
                shell_quote(&sha256_hex(bytes)),
                shell_quote(&cksum(bytes)),
                base64_lines(bytes)
            )),
            Some(Content::Skill(skill)) => {
                for file in &skill.files {
                    script.push_str(&format!(
                        "wf \"$dir/new/{index}\" {} {} <<'ARBOR_EOF'\n{}ARBOR_EOF\n",
                        shell_quote(&file.rel),
                        if file.exec { "x" } else { "-" },
                        base64_lines(&file.bytes)
                    ));
                }
                script.push_str(&format!("fold {rel} {index} {} {}\n", shell_quote(&skill.sum), shell_quote(&skill.ck)));
            }
            None if change.folder => script.push_str(&format!("unfold {rel} {index}\n")),
            None => script.push_str(&format!("drop {rel}\n")),
        }
    }
    script.push_str(&prune_backups());
    script
}

/// One file or skill a change wrote or removed.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupFile {
    /// As the scan names it.
    path: String,
    /// `added` (it wasn't there before), `changed` or `removed`.
    change: &'static str,
    /// A skill's folder in the store, rather than a file.
    skill: bool,
    /// A settings file another feature changed on its own, which `edits` has.
    #[serde(skip)]
    edit: bool,
    #[serde(skip)]
    rel: String,
    #[serde(skip)]
    before: String,
    #[serde(skip)]
    after_sum: String,
    #[serde(skip)]
    after_ck: String,
}

/// A change Arbor made on a machine, from the backup it made first.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupBackup {
    id: String,
    at_ms: i64,
    /// What made it.
    what: ChangeKind,
    /// The repo's commit it came from.
    commit: Option<String>,
    pub(super) undone_at_ms: Option<i64>,
    /// Files, and skills' folders in the store.
    files: Vec<BackupFile>,
    /// What a change to skills did in each home.
    pub(super) skills: Vec<BackupSkill>,
    #[serde(skip)]
    edits: Vec<BackupEdit>,
}

/// The backups a machine has, newest first. Files a list names that Arbor wouldn't sync are left out.
pub(super) fn parse_backups(stdout: &str) -> Vec<SetupBackup> {
    let mut backups: Vec<SetupBackup> = Vec::new();
    let mut home = "";
    // What made each backup, where it says.
    let mut made_by: Vec<Option<ChangeKind>> = Vec::new();
    // Lines after a backup that isn't Arbor's belong to it, not the one before.
    let mut current: Option<usize> = None;
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["H", path] => home = path,
            ["V", id, undone] => {
                current = stamp_ms(id).filter(|_| is_stamp(id)).map(|at_ms| {
                    backups.push(SetupBackup {
                        id: id.to_string(),
                        at_ms,
                        what: ChangeKind::Sync,
                        commit: None,
                        undone_at_ms: undone.parse::<i64>().ok().map(|seconds| seconds * 1000),
                        files: Vec::new(),
                        skills: Vec::new(),
                        edits: Vec::new(),
                    });
                    made_by.push(None);
                    backups.len() - 1
                });
            }
            ["what", kind] => {
                if let Some(slot) = current.and_then(|index| made_by.get_mut(index)) {
                    *slot = ChangeKind::named(kind);
                }
            }
            ["E", ..] => {
                if let (Some(backup), Some(edit)) = (current.and_then(|index| backups.get_mut(index)), BackupEdit::parse(&fields)) {
                    backup.edits.push(edit);
                }
            }
            ["commit", sha] => {
                if let Some(backup) = current.and_then(|index| backups.get_mut(index)) {
                    backup.commit = is_commit(sha).then(|| sha.to_string());
                }
            }
            [kind @ ("F" | "D"), rel, before, after_sum, after_ck] if managed(rel).is_some() => {
                if let Some(backup) = current.and_then(|index| backups.get_mut(index)) {
                    let change = match (*kind, *before) {
                        ("D", _) => "removed",
                        (_, "-") => "added",
                        _ => "changed",
                    };
                    backup.files.push(BackupFile {
                        path: format!("~/{rel}"),
                        change,
                        skill: false,
                        edit: false,
                        rel: rel.to_string(),
                        before: before.to_string(),
                        after_sum: after_sum.to_string(),
                        after_ck: after_ck.to_string(),
                    });
                }
            }
            ["P", rel, before, after_sum, after_ck] if repo_skills::store_rel(rel) && [*before, *after_sum, *after_ck].iter().all(|field| !field.is_empty()) => {
                if let Some(backup) = current.and_then(|index| backups.get_mut(index)) {
                    let change = match (*before, *after_sum) {
                        (_, "-") => "removed",
                        ("-", _) => "added",
                        _ => "changed",
                    };
                    backup.files.push(BackupFile {
                        path: format!("~/{rel}"),
                        change,
                        skill: true,
                        edit: false,
                        rel: rel.to_string(),
                        before: before.to_string(),
                        after_sum: after_sum.to_string(),
                        after_ck: after_ck.to_string(),
                    });
                }
            }
            ["S", ..] => {
                if let (Some(backup), Some(skill)) = (current.and_then(|index| backups.get_mut(index)), BackupSkill::parse(&fields)) {
                    backup.skills.push(skill);
                }
            }
            _ => {}
        }
    }
    for (backup, made_by) in backups.iter_mut().zip(made_by) {
        // Backups from before they said what made them: the Skills tab's hold skills, and the rest are setup sync's.
        backup.what = made_by.unwrap_or(if backup.skills.is_empty() { ChangeKind::Sync } else { ChangeKind::Skills });
        // Listed after the files, whose places undoing a skill's folder goes by.
        let edited = backup.edits.iter().map(|edit| BackupFile {
            path: agent_homes::tilde(&edit.path, home),
            change: if edit.before == "-" { "added" } else { "changed" },
            skill: false,
            edit: true,
            rel: String::new(),
            before: String::new(),
            after_sum: String::new(),
            after_ck: String::new(),
        });
        let edited: Vec<BackupFile> = edited.collect();
        backup.files.extend(edited);
    }
    backups.sort_by(|a, b| b.id.cmp(&a.id));
    backups
}

/// Puts back what `backup` replaced, all or none: every file must still be as
/// the change left it, or as it was before where the change couldn't write it,
/// which is left alone. Lines out as `apply_script`'s, without `K`.
pub(super) fn undo_script(backup: &SetupBackup) -> String {
    let mut script = format!(
        "set -u\nexport LC_ALL=C\n{HELPERS}{STATE_FUNCTIONS}{CHANGE_FUNCTIONS}{}{FOLDER_FUNCTIONS}dir=\"$HOME/.arbor/setup-backups\"/{}\n\
         [ -f \"$dir/manifest\" ] || {{ echo \"That change's backup isn't on this machine any more.\" >&2; exit 4; }}\n\
         [ ! -f \"$dir/undone\" ] || {{ echo \"That change was undone already.\" >&2; exit 4; }}\n",
        setup_skills::SKILL_FUNCTIONS,
        shell_quote(&backup.id)
    );
    let files = || backup.files.iter().enumerate().filter(|(_, file)| !file.edit);
    for (index, file) in files() {
        let rel = shell_quote(&file.rel);
        let (read, mark) = if file.skill { (format!("place \"$home/\"{rel}"), "D") } else { (format!("now {rel}"), "") };
        let after = if file.change == "removed" {
            "-".to_string()
        } else {
            format!("\"{mark}$(pick {} {})\"", shell_quote(&file.after_sum), shell_quote(&file.after_ck))
        };
        script.push_str(&format!(
            "was{index}=$({read})\n\
             if [ \"$was{index}\" != {after} ] && [ \"$was{index}\" != {before} ]; then printf 'X\\t%s\\tchanged\\n' {rel}; changed=1; fi\n",
            before = shell_quote(&file.before)
        ));
    }
    script.push_str(&setup_skills::undo_checks(&backup.skills));
    script.push_str(&undo_edit_checks(&backup.edits));
    script.push_str(
        "[ \"$changed\" = 0 ] || exit 0\n\
         back() {\n\
         \x20 f=\"$HOME/$1\"; tmp=\"$f.arbor-tmp\"\n\
         \x20 if mkdir -p \"$(dirname \"$f\")\" && cp -p \"$dir/files/$1\" \"$tmp\" && mv -f \"$tmp\" \"$f\"; then printf 'W\\t%s\\n' \"$1\"\n\
         \x20 else rm -f \"$tmp\"; printf 'X\\t%s\\tfailed\\n' \"$1\"; failed=1; fi\n\
         }\n",
    );
    for (index, file) in files() {
        let (before, rel) = (shell_quote(&file.before), shell_quote(&file.rel));
        if file.skill {
            script.push_str(&format!("[ \"$was{index}\" = {before} ] || refold {rel} {index}\n"));
        } else {
            let action = if file.before == "-" { "drop" } else { "back" };
            script.push_str(&format!("[ \"$was{index}\" = {before} ] || {action} {rel}\n"));
        }
    }
    script.push_str(&setup_skills::undo_actions(&backup.skills));
    script.push_str(&undo_edit_actions(&backup.edits));
    script.push_str("[ \"$failed\" = 0 ] && date +%s > \"$dir/undone\"\nexit 0\n");
    script
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// What the setup repo in `repo` holds.
#[tauri::command]
pub(crate) async fn get_setup_repo(repo: String) -> Result<SetupRepo, String> {
    read_repo(Path::new(&repo)).await
}

/// A synced file's content as `commit` has it, for comparing with a machine's copy.
#[tauri::command]
pub(crate) async fn read_setup_repo_file(repo: String, commit: String, path: String) -> Result<SetupText, String> {
    let rel = home_relative(&path)?;
    let bytes = repo_file(Path::new(&repo), &commit, rel).await?;
    let size = bytes.len() as u64;
    let content = if size > 256 * 1024 { None } else { String::from_utf8(bytes).ok() };
    Ok(SetupText { content, size })
}

/// Starts a setup repo in `repo` with this Mac's instructions, rules, subagents and commands.
#[tauri::command]
pub(crate) async fn start_setup_repo(state: tauri::State<'_, MachineHealthState>, repo: String) -> Result<SetupRepo, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("Arbor can't tell where your home folder is")?;
    let machine = this_machine_name(&state.lock()).unwrap_or_else(|| "this Mac".into());
    start_repo(Path::new(&repo), &home, &machine, &[]).await
}

/// Commits a machine's copy of a file as the repo's.
#[tauri::command]
pub(crate) async fn take_setup_file(
    state: tauri::State<'_, MachineHealthState>,
    repo: String,
    machine: String,
    path: String,
) -> Result<SetupRepo, String> {
    let rel = home_relative(&path)?.to_string();
    let (target, absolute) = scanned_item(&state.lock(), &machine, &path, &TEXT_KINDS)?;
    let text = read_text(&target, &absolute).await?;
    let content = text.content.ok_or_else(|| format!("{path} on {machine} is too large or isn't text"))?;
    // A hook script runs as it is, so the repo mustn't hold one with a secret in it.
    if managed(&rel) == Some(SyncFileKind::HookScript) && holds_secret(&content) {
        return Err(format!("Arbor didn't take {path}: it looks like it holds a secret, and the repo mustn't hold one. Have it read the secret from a variable, then take it again."));
    }
    let folder = Path::new(&repo);
    take_into_repo(folder, &rel, content.as_bytes(), &format!("Take {path} from {machine}"), &[]).await?;
    read_repo(folder).await
}

/// Takes the rule, subagent or command at `path` off every machine in one commit: out of the repo, and marked in
/// .agents/machines.json so each machine's copy is the repo's to remove. With `removed` false, the mark goes and the file
/// comes back as it was before the commit that took it out, when the repo hasn't got it again already. Nothing is
/// written while the file or the machines file has changes that aren't committed.
pub(super) async fn remove_file(folder: &Path, path: &str, removed: bool, git_config: &[&str]) -> Result<(), String> {
    let rel = home_relative(path)?;
    if !wanted::removable_file(rel) {
        return Err(format!("{path} is every machine's own, so Arbor changes it rather than removing it"));
    }
    let spec = format!("./{rel}");
    let machines_spec = format!("./{MACHINES_FILE}");
    for step in [rel, MACHINES_FILE] {
        if fs::symlink_metadata(folder.join(step)).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(format!("{step} is a link in the repo, which Arbor leaves alone"));
        }
    }
    let changes = git_out(folder, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", &spec, &machines_spec]).await?;
    if !changes.is_empty() {
        return Err(format!("{rel} or {MACHINES_FILE} has changes in the repo that aren't committed. Commit or drop them, then try again."));
    }
    let machines_path = folder.join(MACHINES_FILE);
    let before = match fs::read(&machines_path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Arbor couldn't read {MACHINES_FILE}: {error}")),
    };
    let marked = wanted::with_file_removed(before.as_deref(), rel, removed)?;
    let with = |args: &[&str]| -> Vec<String> { git_config.iter().chain(args).map(|arg| arg.to_string()).collect() };
    let run = |args: Vec<String>| async move { git_out(folder, &args.iter().map(String::as_str).collect::<Vec<_>>()).await };
    let tracked = !git_out(folder, &["--literal-pathspecs", "ls-files", "-z", "--", &spec]).await?.is_empty();
    let mut paths = vec![machines_spec.clone()];
    if removed && tracked {
        run(with(&["rm", "-q", "--", &spec])).await?;
        paths.push(spec.clone());
    } else if !removed && !tracked {
        // The last commit to touch the file is the one that took it out; the one before it had it.
        let last = git_out(folder, &["log", "-1", "--format=%H", "--", &spec]).await?;
        let last = last.trim();
        if is_commit(last) {
            run(with(&["checkout", &format!("{last}^"), "--", &spec])).await?;
            paths.push(spec.clone());
        }
    }
    if let Some(parent) = machines_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&machines_path, marked).map_err(|error| format!("Arbor couldn't write {MACHINES_FILE}: {error}"))?;
    run(with(&["add", "--", &machines_spec])).await?;
    let mut staged = vec!["--literal-pathspecs", "diff", "--cached", "--quiet", "--"];
    staged.extend(paths.iter().map(String::as_str));
    if git(folder, &staged, GIT_TIMEOUT).await?.status.success() {
        return Ok(());
    }
    let message = if removed { format!("Remove {path} from every machine") } else { format!("Put {path} back on every machine") };
    let mut commit = vec!["commit", "--quiet", "-m", message.as_str(), "--"];
    commit.extend(paths.iter().map(String::as_str));
    run(with(&commit)).await?;
    Ok(())
}

/// Turns a skill the repo has off on every machine, keeping it in the repo, or on again, and commits .agents/machines.json
/// alone. Each machine's store copy goes with its review, as a removed skill's does, and comes back the same way.
#[tauri::command]
pub(crate) async fn set_setup_skill_off(repo: String, skill: String, off: bool) -> Result<SetupRepo, String> {
    let folder = Path::new(&repo);
    if !wanted::is_skill_name(&skill) {
        return Err("Arbor keeps skills named with letters, digits, ., - and _".into());
    }
    let current = read_repo(folder).await?;
    if off && !current.skills.iter().any(|entry| entry.name() == skill) {
        return Err(format!("The repo hasn't got {skill}"));
    }
    let message = if off { format!("Turn skill {skill} off on all machines") } else { format!("Turn skill {skill} on for all machines") };
    let marked = wanted::with_skill_off(machines_file_now(folder)?.as_deref(), &skill, off)?;
    take_into_repo(folder, MACHINES_FILE, marked.as_bytes(), &message, &[]).await?;
    read_repo(folder).await
}

/// Turns a rule, subagent or command the repo has off on every machine, keeping it in the repo, or on again, and
/// commits .agents/machines.json alone. Instructions are every machine's own, so they're never off.
#[tauri::command]
pub(crate) async fn set_setup_file_off(repo: String, path: String, off: bool) -> Result<SetupRepo, String> {
    let folder = Path::new(&repo);
    let rel = home_relative(&path)?;
    if !wanted::removable_file(rel) {
        return Err(format!("{path} is every machine's own, so Arbor changes it rather than turning it off"));
    }
    let current = read_repo(folder).await?;
    if off && !current.files.iter().any(|file| file.path == path) {
        return Err(format!("The repo hasn't got {path}"));
    }
    let message = if off { format!("Turn {rel} off on all machines") } else { format!("Turn {rel} on for all machines") };
    let marked = wanted::with_file_off(machines_file_now(folder)?.as_deref(), rel, off)?;
    take_into_repo(folder, MACHINES_FILE, marked.as_bytes(), &message, &[]).await?;
    read_repo(folder).await
}

/// .agents/machines.json as it is in the repo's folder, or None before it's there.
fn machines_file_now(folder: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(folder.join(MACHINES_FILE)) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Arbor couldn't read {MACHINES_FILE}: {error}")),
    }
}

/// Takes a rule, subagent or command off every machine in the repo, or puts it back, and commits it (see
/// `remove_file`).
#[tauri::command]
pub(crate) async fn set_setup_file_removed(repo: String, path: String, removed: bool) -> Result<SetupRepo, String> {
    let folder = Path::new(&repo);
    remove_file(folder, &path, removed, &[]).await?;
    read_repo(folder).await
}

/// Why git refused a pull or push, in words where it's that the branch and its upstream have moved apart.
async fn refusal(folder: &Path, output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !["[rejected]", "fast-forward", "fetch first"].iter().any(|sign| stderr.contains(sign)) {
        return git_failure(output);
    }
    match upstream(folder).await {
        Some(up) if up.ahead > 0 && up.behind > 0 => {
            format!("This repo and {} each have commits the other hasn't. Merge or rebase them in a terminal, then read the repo again.", up.name)
        }
        Some(up) => format!("{} has commits this repo hasn't. Pull them first.", up.name),
        None => git_failure(output),
    }
}

/// Brings the repo's branch up to date with its upstream, when that needs no merge.
#[tauri::command]
pub(crate) async fn pull_setup_repo(repo: String) -> Result<SetupRepo, String> {
    let folder = Path::new(&repo);
    let output = git(folder, &["pull", "--ff-only", "--no-rebase", "--quiet"], NETWORK_TIMEOUT).await?;
    if !output.status.success() {
        return Err(refusal(folder, &output).await);
    }
    read_repo(folder).await
}

/// Sends the repo's commits to its upstream.
#[tauri::command]
pub(crate) async fn push_setup_repo(repo: String) -> Result<SetupRepo, String> {
    let folder = Path::new(&repo);
    let output = git(folder, &["push", "--quiet"], NETWORK_TIMEOUT).await?;
    if !output.status.success() {
        return Err(refusal(folder, &output).await);
    }
    read_repo(folder).await
}

/// Writes the repo's copy of each file at `commit` to `machine`, or removes the machine's, after
/// backing up what's there. Nothing changes unless every file is what the last scan found.
#[tauri::command]
pub(crate) async fn apply_setup_sync(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    repo: String,
    commit: String,
    machine: String,
    changes: Vec<SyncChange>,
) -> Result<SyncOutcome, String> {
    if changes.is_empty() {
        return Err("There's nothing to change".into());
    }
    if !is_commit(&commit) {
        return Err("That isn't a commit".into());
    }
    let target = covered_machine(&state.lock(), &machine)?.0;
    let folder = Path::new(&repo);
    let mut seen = BTreeSet::new();
    let mut planned = Vec::with_capacity(changes.len());
    for change in changes {
        let skill = repo_skills::store_skill(&change.path);
        let rel = match skill {
            Some(name) => format!("{SKILLS_DIR}/{name}"),
            None => home_relative(&change.path)?.to_string(),
        };
        if !seen.insert(rel.clone()) {
            return Err(format!("{} is in the changes twice", change.path));
        }
        let before = change.before.unwrap_or_else(|| "-".into());
        if before.is_empty() || before.contains(['\t', '\n']) || (skill.is_some() && before != "-" && !is_sum(&before)) {
            return Err(format!("Arbor can't tell what {} was", change.path));
        }
        if change.remove && before == "-" {
            return Err(format!("{} isn't there to remove", change.path));
        }
        planned.push(match skill {
            Some(name) => Planned {
                before: if before == "-" { before } else { format!("D{before}") },
                content: if change.remove { None } else { Some(Content::Skill(repo_skills::repo_skill(folder, &commit, name).await?)) },
                rel,
                folder: true,
            },
            None => Planned {
                content: if change.remove { None } else { Some(Content::File(repo_file(folder, &commit, &rel).await?)) },
                rel,
                before,
                folder: false,
            },
        });
    }
    let stdout = run_on(&target, MachineOp::SetupApply, &apply_script(&new_stamp(), &commit, &planned)).await;
    rescan(&app, &machine);
    Ok(parse_outcome(&stdout?))
}

async fn backups(machine: &Machine) -> Result<Vec<SetupBackup>, String> {
    let stdout = run_on(machine, MachineOp::SetupBackups, &format!("set -u\nexport LC_ALL=C\n{BACKUPS_SCRIPT}")).await?;
    Ok(parse_backups(&stdout))
}

/// The changes Arbor has made on a machine, newest first.
#[tauri::command]
pub(crate) async fn list_setup_backups(state: tauri::State<'_, MachineHealthState>, machine: String) -> Result<Vec<SetupBackup>, String> {
    let target = covered_machine(&state.lock(), &machine)?.0;
    backups(&target).await
}

/// Puts back what one change on a machine replaced.
#[tauri::command]
pub(crate) async fn undo_setup_sync(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    backup: String,
) -> Result<SyncOutcome, String> {
    let target = covered_machine(&state.lock(), &machine)?.0;
    let found = backups(&target)
        .await?
        .into_iter()
        .find(|entry| entry.id == backup)
        .ok_or("That change's backup isn't on this machine any more.")?;
    if found.undone_at_ms.is_some() {
        return Err("That change was undone already.".into());
    }
    let stdout = run_on(&target, MachineOp::SetupUndo, &undo_script(&found)).await;
    rescan(&app, &machine);
    if found.what == ChangeKind::Reporter {
        // So the page shows where the reporter runs now.
        agents::recheck(&app, &state, &target).await;
    }
    Ok(parse_outcome(&stdout?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::machine_health::guarded_writes::{SyncFailure, BACKUPS_KEPT};

    #[test]
    fn only_the_files_the_agents_load_are_synced() {
        assert_eq!(managed(".claude/CLAUDE.md"), Some(SyncFileKind::Instructions));
        assert_eq!(managed(".codex/AGENTS.md"), Some(SyncFileKind::Instructions));
        assert_eq!(managed(".pi/agent/AGENTS.md"), Some(SyncFileKind::Instructions));
        assert_eq!(managed(".factory/AGENTS.md"), Some(SyncFileKind::Instructions));
        assert_eq!(managed(".config/opencode/AGENTS.md"), Some(SyncFileKind::Instructions));
        assert_eq!(managed(".pi/agent/settings.json"), None);
        assert_eq!(managed(".pi/AGENTS.md"), None);
        assert_eq!(managed(".claude/rules/web/react.md"), Some(SyncFileKind::Rule));
        assert_eq!(managed(".claude/agents/reviewer.md"), Some(SyncFileKind::Subagent));
        assert_eq!(managed(".claude/agents/team/reviewer.md"), None, "Claude Code only reads subagents at the top");
        assert_eq!(managed(".claude/commands/git/ship.md"), Some(SyncFileKind::Command));
        assert_eq!(managed(".codex/prompts/review.md"), Some(SyncFileKind::Command));
        assert_eq!(managed(".agents/hooks/guard.sh"), Some(SyncFileKind::HookScript));
        assert_eq!(managed(".agents/hooks.json"), None);
        assert_eq!(managed(".agents/hooks/lib/util.sh"), None, "Hooks run scripts at the top of the folder");
        assert_eq!(managed(".agents/hooks/.env"), None);
        for other in [
            ".claude/settings.json",
            ".claude/skills/pdf/SKILL.md",
            ".codex/AGENTS.override.md",
            ".codex/rules/default.rules",
            ".codex/config.toml",
            "CLAUDE.md",
            ".claude/rules/.md",
            ".claude/rules/api-token.md",
            ".claude/rules/../CLAUDE.md",
            ".claude//CLAUDE.md",
            "/.claude/CLAUDE.md",
            ".agent-app/homes/x/CLAUDE.md",
        ] {
            assert_eq!(managed(other), None, "{other}");
        }
        assert_eq!(home_relative("~/.claude/CLAUDE.md"), Ok(".claude/CLAUDE.md"));
        assert!(home_relative("~/.claude/settings.json").is_err());
        assert!(home_relative("/Users/a/.claude/CLAUDE.md").is_err());
    }

    #[test]
    fn stamps_name_when_a_backup_was_made() {
        let stamp = new_stamp();
        assert!(is_stamp(&stamp), "{stamp}");
        assert_eq!(stamp_ms("20260925T140233Z-1a2b"), Some(1_790_344_953_000));
        assert!(!is_stamp("20260925T140233Z-1a2b/../../x"));
        assert!(!is_stamp("latest"));
        assert!(is_commit(&"a".repeat(40)) && !is_commit("--output=x") && !is_commit("HEAD"));
    }

    #[test]
    fn what_a_change_did_is_read_from_its_output() {
        let outcome = parse_outcome("K\t20260925T140233Z-1a2b\nW\t.claude/CLAUDE.md\nD\t.claude/commands/old.md\nX\t.codex/AGENTS.md\tfailed\n");
        assert_eq!(outcome.backup.as_deref(), Some("20260925T140233Z-1a2b"));
        assert_eq!(outcome.done, ["~/.claude/CLAUDE.md", "~/.claude/commands/old.md"]);
        assert_eq!(outcome.failed, [SyncFailure { path: "~/.codex/AGENTS.md".into(), reason: "failed" }]);
        let refused = parse_outcome("X\t.claude/CLAUDE.md\tchanged\n");
        assert_eq!((refused.backup, refused.failed[0].reason), (None, "changed"));
    }

    #[test]
    fn backup_lists_leave_out_what_arbor_wouldnt_have_written() {
        let commit = "b".repeat(40);
        let stdout = format!(
            "V\t20260924T090000Z-0001\t1790300000\ncommit\t{commit}\nF\t.claude/CLAUDE.md\tabc\tdef\tc1-2\n\
             V\t20260925T090000Z-0002\t-\ncommit\t{commit}\nF\t.claude/agents/new.md\t-\tdef\tc1-2\nD\t.claude/commands/old.md\tabc\t-\t-\n\
             F\t../../etc/passwd\tabc\tdef\tc1-2\nV\tnot-a-stamp\t-\nF\t.claude/CLAUDE.md\tabc\tdef\tc1-2\n"
        );
        let backups = parse_backups(&stdout);
        assert_eq!(backups.iter().map(|backup| backup.id.as_str()).collect::<Vec<_>>(), ["20260925T090000Z-0002", "20260924T090000Z-0001"]);
        assert_eq!(backups[1].undone_at_ms, Some(1_790_300_000_000));
        assert_eq!(backups[0].commit.as_deref(), Some(commit.as_str()));
        assert_eq!(
            backups[0].files.iter().map(|file| (file.path.as_str(), file.change)).collect::<Vec<_>>(),
            [("~/.claude/agents/new.md", "added"), ("~/.claude/commands/old.md", "removed")],
        );
        assert_eq!(backups[1].files[0].change, "changed");
    }

    #[cfg(unix)]
    mod on_disk {
        use super::*;
        use crate::usage::machine_health::setup_repo_skills::SkillFile;
        use std::os::unix::fs::PermissionsExt;

        fn temp_dir(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("arbor-sync-{name}-{}-{stamp}", std::process::id()));
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

        const IDENTITY: [&str; 4] = ["-c", "user.name=Arbor Test", "-c", "user.email=arbor@example.com"];

        fn git_in(folder: &Path, args: &[&str]) -> String {
            let mut all: Vec<&str> = IDENTITY.to_vec();
            all.extend(args);
            block_on(git_out(folder, &all)).unwrap()
        }

        fn run_in(shell: &str, home: &Path, script: &str) -> std::process::Output {
            let mut command = tokio::process::Command::new(shell);
            command
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            block_on(run_script(command, script, Duration::from_secs(30))).unwrap()
        }

        fn sum_of(home: &Path, rel: &str) -> String {
            sha256_hex(&fs::read(home.join(rel)).unwrap())
        }

        #[test]
        fn a_settings_edit_is_on_the_list_and_undoing_it_puts_the_files_back() {
            use crate::usage::machine_health::guarded_writes::{edit_call, edit_finish, edit_start, Edit, EditFile};
            for shell in shells() {
                let home = temp_dir(&format!("edit-undo-{shell}"));
                let settings = home.join(".claude/settings.json");
                let before = b"{\"env\":{\"TOKEN\":\"sk-SECRET\"}}\n";
                write(&settings, before);
                let created = home.join(".agent-app/homes/claude/settings.json");
                fs::create_dir_all(created.parent().unwrap()).unwrap();
                let edits = [
                    Edit { file: EditFile::Path(settings.display().to_string()), before: cksum(before), content: b"{}\n".to_vec() },
                    Edit { file: EditFile::Path(created.display().to_string()), before: "-".into(), content: b"{\"a\":1}\n".to_vec() },
                ];
                let mut script = format!("set -u\nexport LC_ALL=C\n{}", edit_start("20260926T020000Z-0001", ChangeKind::Telemetry));
                for (n, edit) in edits.iter().enumerate() {
                    script.push_str(&edit_call(n, edit));
                }
                script.push_str(&edit_finish());
                assert!(run_in(shell, &home, &script).status.success(), "{shell}");

                let listed = run_in(shell, &home, &format!("set -u\n{BACKUPS_SCRIPT}"));
                let stdout = String::from_utf8_lossy(&listed.stdout).into_owned();
                assert!(!stdout.contains("SECRET"), "{shell}: the list holds paths and fingerprints, never what a file says");
                let backups = parse_backups(&stdout);
                let [backup] = backups.as_slice() else { panic!("{shell}: {backups:?}") };
                let shown = serde_json::to_value(backup).unwrap();
                assert_eq!(shown["what"], "telemetry");
                assert_eq!(
                    shown["files"],
                    serde_json::json!([
                        { "path": "~/.claude/settings.json", "change": "changed", "skill": false },
                        { "path": "~/.agent-app/homes/claude/settings.json", "change": "added", "skill": false },
                    ])
                );

                // Nothing is put back while a file isn't as the change left it.
                write(&created, b"{\"b\":2}\n");
                let blocked = parse_outcome(&String::from_utf8_lossy(&run_in(shell, &home, &undo_script(backup)).stdout));
                assert_eq!(blocked.failed, [SyncFailure { path: "~/.agent-app/homes/claude/settings.json".into(), reason: "changed" }], "{shell}");
                assert_eq!(fs::read(&settings).unwrap(), b"{}\n");

                write(&created, b"{\"a\":1}\n");
                let undone = parse_outcome(&String::from_utf8_lossy(&run_in(shell, &home, &undo_script(backup)).stdout));
                assert!(undone.failed.is_empty(), "{shell}: {undone:?}");
                assert_eq!(undone.done, ["~/.claude/settings.json", "~/.agent-app/homes/claude/settings.json"]);
                assert_eq!(fs::read(&settings).unwrap(), before);
                assert!(!created.exists(), "{shell}: a file the change made goes");
                let listed = run_in(shell, &home, &format!("set -u\n{BACKUPS_SCRIPT}"));
                assert!(parse_backups(&String::from_utf8_lossy(&listed.stdout))[0].undone_at_ms.is_some());
                let _ = fs::remove_dir_all(&home);
            }
        }

        #[test]
        fn a_file_removed_from_every_machine_leaves_the_repo_and_comes_back() {
            let root = temp_dir("removed-file");
            git_in(&root, &["init", "--quiet"]);
            block_on(take_into_repo(&root, ".claude/agents/old.md", b"# Old\n", "Take", &IDENTITY)).unwrap();
            block_on(take_into_repo(&root, ".claude/CLAUDE.md", b"# Mine\n", "Take", &IDENTITY)).unwrap();
            let log = || git_in(&root, &["log", "--format=%s"]).lines().map(str::to_string).collect::<Vec<_>>();

            block_on(remove_file(&root, "~/.claude/agents/old.md", true, &IDENTITY)).unwrap();
            assert_eq!(log()[0], "Remove ~/.claude/agents/old.md from every machine");
            assert!(!root.join(".claude/agents/old.md").exists());
            let repo = serde_json::to_value(block_on(read_repo(&root)).unwrap()).unwrap();
            assert_eq!(repo["removedFiles"], serde_json::json!(["~/.claude/agents/old.md"]));
            assert_eq!(repo["files"].as_array().unwrap().len(), 1);
            assert!(git_in(&root, &["status", "--porcelain"]).is_empty());

            block_on(remove_file(&root, "~/.claude/agents/old.md", false, &IDENTITY)).unwrap();
            assert_eq!(log()[0], "Put ~/.claude/agents/old.md back on every machine");
            assert_eq!(fs::read(root.join(".claude/agents/old.md")).unwrap(), b"# Old\n");
            let repo = serde_json::to_value(block_on(read_repo(&root)).unwrap()).unwrap();
            assert_eq!(repo["removedFiles"], serde_json::json!([]));
            assert!(git_in(&root, &["status", "--porcelain"]).is_empty());

            // A file only machines have is marked, and nothing else changes.
            block_on(remove_file(&root, "~/.claude/commands/loose.md", true, &IDENTITY)).unwrap();
            let repo = serde_json::to_value(block_on(read_repo(&root)).unwrap()).unwrap();
            assert_eq!(repo["removedFiles"], serde_json::json!(["~/.claude/commands/loose.md"]));
            // Instructions and what the repo doesn't sync aren't removed.
            assert!(block_on(remove_file(&root, "~/.claude/CLAUDE.md", true, &IDENTITY)).unwrap_err().contains("every machine's own"));
            assert!(block_on(remove_file(&root, "~/.claude/settings.json", true, &IDENTITY)).is_err());
            write(&root.join(".claude/CLAUDE.md"), b"edited\n");
            write(&root.join(".agents/machines.json"), b"{}");
            assert!(block_on(remove_file(&root, "~/.claude/agents/old.md", true, &IDENTITY)).unwrap_err().contains("aren't committed"));
            let _ = fs::remove_dir_all(&root);
        }

        #[test]
        fn a_projects_instructions_are_listed_by_fingerprint_and_not_as_ignored() {
            let root = temp_dir("instructions");
            git_in(&root, &["init", "--quiet"]);
            write(&root.join("README.md"), b"# Dotfiles\n");
            git_in(&root, &["add", "--all"]);
            git_in(&root, &["commit", "--quiet", "-m", "First"]);
            let every = ".agents/projects/casey/arbor/instructions.md";
            let one = ".agents/projects/casey/arbor/machines/macmini.md";
            block_on(take_into_repo(&root, every, b"Use the mock.\n", "Set", &IDENTITY)).unwrap();
            block_on(take_into_repo(&root, one, b"Mini only.\n", "Set", &IDENTITY)).unwrap();
            assert!(block_on(take_into_repo(&root, ".agents/projects/casey/arbor/notes.md", b"x", "Set", &IDENTITY)).is_err());
            let repo = block_on(read_repo(&root)).unwrap();
            assert!(repo.ignored.is_empty(), "{:?}", repo.ignored);
            let listed: Vec<(Option<&str>, &str)> = repo.instructions.iter().map(|found| (found.machine(), found.hash())).collect();
            assert_eq!(listed, [(None, instructions::text_hash(b"Use the mock.\n").as_str()), (Some("macmini"), instructions::text_hash(b"Mini only.\n").as_str())]);
            let _ = fs::remove_dir_all(&root);
        }

        #[test]
        fn a_repo_lists_what_it_syncs_as_committed() {
            let root = temp_dir("repo");
            git_in(&root, &["init", "--quiet"]);
            write(&root.join("README.md"), b"# Dotfiles\n");
            let folder = root.join("agents");
            write(&folder.join(".claude/CLAUDE.md"), b"# Agreement\n");
            write(&folder.join(".claude/agents/reviewer.md"), b"Review it.\n");
            write(&folder.join(".claude/agents/team/lead.md"), b"Lead it.\n");
            write(&folder.join(".claude/settings.json"), b"{}\n");
            write(&folder.join(".codex/AGENTS.md"), b"Be brief.");
            write(&folder.join(".codex/prompts/review.md"), b"");
            git_in(&root, &["add", "--all"]);
            git_in(&root, &["commit", "--quiet", "-m", "Add agents"]);
            write(&folder.join(".claude/CLAUDE.md"), b"# Agreement, edited\n");
            write(&folder.join(".claude/rules/new.md"), b"New.\n");

            let repo = block_on(read_repo(&folder)).unwrap();
            assert_eq!(repo.head.as_ref().map(|head| head.subject.as_str()), Some("Add agents"));
            assert!(repo.upstream.is_none());
            assert_eq!(
                repo.files.iter().map(|file| (file.path.as_str(), file.kind)).collect::<Vec<_>>(),
                [
                    ("~/.claude/CLAUDE.md", SyncFileKind::Instructions),
                    ("~/.claude/agents/reviewer.md", SyncFileKind::Subagent),
                    ("~/.codex/AGENTS.md", SyncFileKind::Instructions),
                    ("~/.codex/prompts/review.md", SyncFileKind::Command),
                ],
            );
            let claude = &repo.files[0];
            assert_eq!((claude.sum.as_str(), claude.size), (sha256_hex(b"# Agreement\n").as_str(), 12), "the commit's copy, not the edit");
            assert_eq!(repo.files[2].ck, cksum(b"Be brief."));
            assert_eq!(repo.ignored, [".claude/agents/team/lead.md", ".claude/settings.json"]);
            assert_eq!(repo.uncommitted, ["~/.claude/CLAUDE.md", "~/.claude/rules/new.md"]);

            let head = repo.head.unwrap().sha;
            assert_eq!(block_on(repo_file(&folder, &head, ".codex/AGENTS.md")).unwrap(), b"Be brief.");
            assert!(block_on(repo_file(&folder, "HEAD", ".codex/AGENTS.md")).is_err());

            let empty = temp_dir("empty");
            git_in(&empty, &["init", "--quiet"]);
            let fresh = block_on(read_repo(&empty)).unwrap();
            assert_eq!((fresh.head, fresh.files.len()), (None, 0));
            assert!(block_on(read_repo(&temp_dir("plain"))).unwrap_err().contains("isn't in a git repo"));
            let _ = fs::remove_dir_all(&root);
            let _ = fs::remove_dir_all(&empty);
        }

        #[test]
        fn a_repo_starts_from_this_macs_files_and_takes_a_machines_copy() {
            let home = temp_dir("home");
            write(&home.join(".claude/CLAUDE.md"), b"# Mine\n");
            write(&home.join(".claude/commands/git/ship.md"), b"Ship it.\n");
            write(&home.join(".claude/commands/api-token.md"), b"SECRET\n");
            write(&home.join(".claude/settings.json"), b"{\"env\":{\"TOKEN\":\"SECRET\"}}\n");
            write(&home.join(".codex/AGENTS.md"), b"Codex.\n");
            write(&home.join(".codex/rules/default.rules"), b"prefix_rule()\n");
            write(&home.join(".agents/skills/pdf/SKILL.md"), b"---\nname: pdf\n---\n");
            write(&home.join(".agents/skills/pdf/scripts/[odd] *name*.py"), b"print(1)\n");
            write(&home.join(".agents/skills/leaky/SKILL.md"), b"Leaky.\n");
            write(&home.join(".agents/skills/leaky/.env"), b"SECRET\n");
            write(&home.join(".agents/.skill-lock.json"), br#"{"version":3,"skills":{"pdf":{"source":"acme/skills","sourceType":"github","skillPath":"skills/pdf/SKILL.md"},"leaky":{"source":"acme/leaky","sourceType":"github"}}}"#);
            let folder = temp_dir("start").join("setup");

            let repo = block_on(start_repo(&folder, &home, "casey-mbp", &IDENTITY)).unwrap();
            assert_eq!(repo.head.as_ref().map(|head| head.subject.as_str()), Some("Start from casey-mbp"));
            assert_eq!(
                repo.files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(),
                ["~/.claude/CLAUDE.md", "~/.claude/commands/git/ship.md", "~/.codex/AGENTS.md"],
            );
            assert!(folder.join("README.md").exists());
            assert!(!folder.join(".claude/settings.json").exists() && !folder.join(".codex/rules").exists());
            let started = serde_json::to_value(&repo).unwrap();
            assert_eq!(started["skills"].as_array().map(Vec::len), Some(1), "the skill with a secret-looking file stays out");
            assert_eq!((&started["skills"][0]["name"], &started["skills"][0]["files"]), (&Value::from("pdf"), &Value::from(2)));
            assert_eq!(started["skills"][0]["source"]["source"], "acme/skills");
            assert!(!folder.join(".agents/skills/leaky").exists());
            assert!(block_on(start_repo(&folder, &home, "casey-mbp", &IDENTITY)).unwrap_err().contains("already has agent files"));

            block_on(take_into_repo(&folder, ".claude/CLAUDE.md", b"# From ci-01\n", "Take ~/.claude/CLAUDE.md from ci-01", &IDENTITY)).unwrap();
            let taken = block_on(read_repo(&folder)).unwrap();
            assert_eq!(taken.head.as_ref().map(|head| head.subject.as_str()), Some("Take ~/.claude/CLAUDE.md from ci-01"));
            assert_eq!(taken.files[0].sum, sha256_hex(b"# From ci-01\n"));
            // The same again has nothing to commit.
            block_on(take_into_repo(&folder, ".claude/CLAUDE.md", b"# From ci-01\n", "Again", &IDENTITY)).unwrap();
            assert_eq!(block_on(read_repo(&folder)).unwrap().head, taken.head);

            write(&folder.join(".codex/AGENTS.md"), b"Edited here.\n");
            let refused = block_on(take_into_repo(&folder, ".codex/AGENTS.md", b"Theirs.\n", "Take", &IDENTITY)).unwrap_err();
            assert!(refused.contains("aren't committed"), "{refused}");
            assert!(block_on(take_into_repo(&folder, ".claude/settings.json", b"{}", "Take", &IDENTITY)).is_err());
            let _ = fs::remove_dir_all(&home);
            let _ = fs::remove_dir_all(folder.parent().unwrap());
        }

        fn planned(rel: &str, before: &str, content: Option<&[u8]>) -> Planned {
            Planned { rel: rel.into(), before: before.into(), content: content.map(|bytes| Content::File(bytes.to_vec())), folder: false }
        }

        fn planned_skill(name: &str, before: &str, files: Option<&[(&str, &[u8], bool)]>) -> Planned {
            let files = files.map(|files| {
                let files = files.iter().map(|(rel, bytes, exec)| SkillFile { rel: rel.to_string(), bytes: bytes.to_vec(), exec: *exec }).collect();
                Content::Skill(SkillFiles::of(files))
            });
            Planned { rel: format!("{SKILLS_DIR}/{name}"), before: before.into(), content: files, folder: true }
        }

        /// How a skill's folder stands, as the scan and the checks give it.
        fn place_of(shell: &str, home: &Path, rel: &str) -> String {
            let script = format!("set -u\nexport LC_ALL=C\n{HELPERS}{}place \"$home/\"{}\n", setup_skills::SKILL_FUNCTIONS, shell_quote(rel));
            String::from_utf8_lossy(&run_in(shell, home, &script).stdout).into_owned()
        }

        #[test]
        fn changes_are_all_or_nothing_backed_up_and_undone() {
            let commit = "c".repeat(40);
            for shell in shells() {
                let home = temp_dir(&format!("apply-{shell}"));
                write(&home.join(".claude/CLAUDE.md"), b"old\n");
                write(&home.join(".claude/commands/gone.md"), b"bye\n");
                let old = sum_of(&home, ".claude/CLAUDE.md");
                let gone = sum_of(&home, ".claude/commands/gone.md");
                let new_content = "new – “exact”, no line break at the end".as_bytes();

                // A file that changed since the scan stops everything.
                let refused = run_in(shell, &home, &apply_script("20260925T090000Z-0001", &commit, &[
                    planned(".claude/CLAUDE.md", "not-what-it-is", Some(b"x\n")),
                    planned(".claude/agents/new.md", "-", Some(b"agent\n")),
                ]));
                assert!(refused.status.success(), "{shell}: {}", String::from_utf8_lossy(&refused.stderr));
                let outcome = parse_outcome(&String::from_utf8_lossy(&refused.stdout));
                assert_eq!((outcome.backup.as_deref(), outcome.done.len()), (None, 0), "{shell}");
                assert_eq!(outcome.failed, [SyncFailure { path: "~/.claude/CLAUDE.md".into(), reason: "changed" }]);
                assert!(!home.join(".claude/agents").exists() && !home.join(".arbor").exists(), "{shell}: nothing written");

                let changes = [
                    planned(".claude/CLAUDE.md", &old, Some(new_content)),
                    planned(".claude/agents/new.md", "-", Some(b"")),
                    planned(".claude/commands/gone.md", &gone, None),
                ];
                let applied = run_in(shell, &home, &apply_script("20260925T090000Z-0002", &commit, &changes));
                assert!(applied.status.success(), "{shell}: {}", String::from_utf8_lossy(&applied.stderr));
                let outcome = parse_outcome(&String::from_utf8_lossy(&applied.stdout));
                assert_eq!(outcome.backup.as_deref(), Some("20260925T090000Z-0002"), "{shell}");
                assert_eq!(outcome.done, ["~/.claude/CLAUDE.md", "~/.claude/agents/new.md", "~/.claude/commands/gone.md"], "{shell}");
                assert!(outcome.failed.is_empty(), "{shell}: {:?}", outcome.failed);
                assert_eq!(fs::read(home.join(".claude/CLAUDE.md")).unwrap(), new_content, "{shell}: byte for byte");
                assert_eq!(fs::read(home.join(".claude/agents/new.md")).unwrap(), b"", "{shell}");
                assert!(!home.join(".claude/commands/gone.md").exists(), "{shell}");
                let kept = home.join(".arbor/setup-backups/20260925T090000Z-0002");
                assert_eq!(fs::read(kept.join("files/.claude/CLAUDE.md")).unwrap(), b"old\n", "{shell}");
                assert_eq!(fs::read(kept.join("files/.claude/commands/gone.md")).unwrap(), b"bye\n", "{shell}");
                assert!(!kept.join("files/.claude/agents/new.md").exists(), "{shell}: nothing to keep of a new file");

                let listed = run_in(shell, &home, &format!("set -u\n{BACKUPS_SCRIPT}"));
                let found = parse_backups(&String::from_utf8_lossy(&listed.stdout));
                assert_eq!(found.len(), 1, "{shell}");
                assert_eq!(found[0].commit.as_deref(), Some(commit.as_str()));
                assert_eq!(
                    found[0].files.iter().map(|file| (file.path.as_str(), file.change)).collect::<Vec<_>>(),
                    [("~/.claude/CLAUDE.md", "changed"), ("~/.claude/agents/new.md", "added"), ("~/.claude/commands/gone.md", "removed")],
                );

                // Undoing waits until every file is as the change left it.
                write(&home.join(".claude/agents/new.md"), b"edited since\n");
                let blocked = run_in(shell, &home, &undo_script(&found[0]));
                let outcome = parse_outcome(&String::from_utf8_lossy(&blocked.stdout));
                assert_eq!(outcome.failed, [SyncFailure { path: "~/.claude/agents/new.md".into(), reason: "changed" }], "{shell}");
                assert_eq!(fs::read(home.join(".claude/CLAUDE.md")).unwrap(), new_content, "{shell}: nothing undone");

                fs::write(home.join(".claude/agents/new.md"), b"").unwrap();
                let undone = run_in(shell, &home, &undo_script(&found[0]));
                assert!(undone.status.success(), "{shell}: {}", String::from_utf8_lossy(&undone.stderr));
                let outcome = parse_outcome(&String::from_utf8_lossy(&undone.stdout));
                assert!(outcome.failed.is_empty(), "{shell}: {:?}", outcome.failed);
                assert_eq!(fs::read(home.join(".claude/CLAUDE.md")).unwrap(), b"old\n", "{shell}");
                assert!(!home.join(".claude/agents/new.md").exists(), "{shell}");
                assert_eq!(fs::read(home.join(".claude/commands/gone.md")).unwrap(), b"bye\n", "{shell}");
                let listed = run_in(shell, &home, &format!("set -u\n{BACKUPS_SCRIPT}"));
                assert!(parse_backups(&String::from_utf8_lossy(&listed.stdout))[0].undone_at_ms.is_some(), "{shell}");
                let again = run_in(shell, &home, &undo_script(&found[0]));
                assert!(!again.status.success() && String::from_utf8_lossy(&again.stderr).contains("undone already"), "{shell}");

                // A link is never written through.
                std::os::unix::fs::symlink(home.join(".claude/CLAUDE.md"), home.join(".claude/agents/linked.md")).unwrap();
                let linked = run_in(shell, &home, &apply_script("20260925T090000Z-0003", &commit, &[
                    planned(".claude/agents/linked.md", &old, Some(b"x\n")),
                ]));
                assert_eq!(parse_outcome(&String::from_utf8_lossy(&linked.stdout)).failed[0].reason, "changed", "{shell}");
                assert_eq!(fs::read(home.join(".claude/CLAUDE.md")).unwrap(), b"old\n", "{shell}");
                let _ = fs::remove_dir_all(&home);
            }
        }

        #[test]
        fn pulling_and_pushing_say_when_the_repo_and_its_upstream_moved_apart() {
            let root = temp_dir("upstream");
            git_in(&root, &["init", "--quiet", "--bare", "remote.git"]);
            git_in(&root, &["clone", "--quiet", "remote.git", "mine"]);
            let (mine, theirs) = (root.join("mine"), root.join("theirs"));
            write(&mine.join(".claude/CLAUDE.md"), b"# Mine\n");
            git_in(&mine, &["add", "--all"]);
            git_in(&mine, &["commit", "--quiet", "-m", "Start"]);
            git_in(&mine, &["push", "--quiet", "-u", "origin", "HEAD"]);
            git_in(&root, &["clone", "--quiet", "remote.git", "theirs"]);

            // Their commit lands first, so pulling it in needs no merge.
            write(&theirs.join(".codex/AGENTS.md"), b"Codex.\n");
            git_in(&theirs, &["add", "--all"]);
            git_in(&theirs, &["commit", "--quiet", "-m", "Theirs"]);
            let pushed = block_on(push_setup_repo(theirs.display().to_string())).unwrap();
            assert_eq!(pushed.upstream.map(|up| (up.ahead, up.behind)), Some((0, 0)));
            let pulled = block_on(pull_setup_repo(mine.display().to_string())).unwrap();
            assert_eq!(pulled.files.len(), 2);

            // Then each commits: pushing is refused until theirs is in, and pulling it needs a merge.
            write(&theirs.join(".claude/rules/a.md"), b"A\n");
            git_in(&theirs, &["add", "--all"]);
            git_in(&theirs, &["commit", "--quiet", "-m", "Theirs again"]);
            block_on(push_setup_repo(theirs.display().to_string())).unwrap();
            write(&mine.join(".claude/rules/b.md"), b"B\n");
            git_in(&mine, &["add", "--all"]);
            git_in(&mine, &["commit", "--quiet", "-m", "Mine again"]);
            let push = block_on(push_setup_repo(mine.display().to_string())).unwrap_err();
            assert!(push.contains("has commits this repo hasn't. Pull them first."), "{push}");
            let pull = block_on(pull_setup_repo(mine.display().to_string())).unwrap_err();
            assert!(pull.contains("each have commits the other hasn't"), "{pull}");
            let _ = fs::remove_dir_all(&root);
        }

        #[test]
        fn a_file_that_cant_be_written_is_left_and_the_rest_undone() {
            let commit = "e".repeat(40);
            for shell in shells() {
                let home = temp_dir(&format!("partial-{shell}"));
                write(&home.join(".claude/CLAUDE.md"), b"old\n");
                // A file where the commands folder goes, so nothing can be written in it.
                write(&home.join(".claude/commands"), b"not a folder\n");
                let old = sum_of(&home, ".claude/CLAUDE.md");
                let applied = run_in(shell, &home, &apply_script("20260925T100000Z-0001", &commit, &[
                    planned(".claude/CLAUDE.md", &old, Some(b"new\n")),
                    planned(".claude/commands/ship.md", "-", Some(b"ship\n")),
                ]));
                assert!(applied.status.success(), "{shell}: {}", String::from_utf8_lossy(&applied.stderr));
                let outcome = parse_outcome(&String::from_utf8_lossy(&applied.stdout));
                assert_eq!(outcome.done, ["~/.claude/CLAUDE.md"], "{shell}");
                assert_eq!(outcome.failed, [SyncFailure { path: "~/.claude/commands/ship.md".into(), reason: "failed" }], "{shell}");

                let listed = run_in(shell, &home, &format!("set -u\n{BACKUPS_SCRIPT}"));
                let found = parse_backups(&String::from_utf8_lossy(&listed.stdout));
                let undone = run_in(shell, &home, &undo_script(&found[0]));
                assert!(undone.status.success(), "{shell}: {}", String::from_utf8_lossy(&undone.stderr));
                let outcome = parse_outcome(&String::from_utf8_lossy(&undone.stdout));
                assert!(outcome.failed.is_empty(), "{shell}: {:?}", outcome.failed);
                assert_eq!(outcome.done, ["~/.claude/CLAUDE.md"], "{shell}: only what was written is put back");
                assert_eq!(fs::read(home.join(".claude/CLAUDE.md")).unwrap(), b"old\n", "{shell}");
                assert_eq!(fs::read(home.join(".claude/commands")).unwrap(), b"not a folder\n", "{shell}");
                let _ = fs::remove_dir_all(&home);
            }
        }

        #[test]
        fn skill_folders_are_swapped_in_whole_backed_up_and_undone() {
            let commit = "f".repeat(40);
            for shell in shells() {
                let home = temp_dir(&format!("folders-{shell}"));
                let store = home.join(".agents/skills");
                write(&store.join("pdf/SKILL.md"), b"old pdf\n");
                write(&store.join("pdf/stale.md"), b"only in the old one\n");
                write(&store.join("old/SKILL.md"), b"old\n");
                write(&home.join("src/elsewhere/SKILL.md"), b"linked\n");
                std::os::unix::fs::symlink(home.join("src/elsewhere"), store.join("linked")).unwrap();
                let (pdf, old) = (place_of(shell, &home, ".agents/skills/pdf"), place_of(shell, &home, ".agents/skills/old"));
                assert!(pdf.starts_with('D') && pdf.len() == 65, "{shell}: {pdf}");
                let new_pdf: &[(&str, &[u8], bool)] = &[("SKILL.md", b"new pdf\n", false), ("scripts/run.sh", b"echo hi\n", true)];
                let fresh: &[(&str, &[u8], bool)] = &[("SKILL.md", b"fresh\n", false)];

                // One that changed since the scan stops everything, and a link is never written through.
                let refused = run_in(shell, &home, &apply_script("20260925T120000Z-0001", &commit, &[
                    planned_skill("pdf", "Dnot-what-it-is", Some(new_pdf)),
                    planned_skill("linked", &pdf, Some(fresh)),
                ]));
                let outcome = parse_outcome(&String::from_utf8_lossy(&refused.stdout));
                assert_eq!(
                    outcome.failed.iter().map(|failure| (failure.path.as_str(), failure.reason)).collect::<Vec<_>>(),
                    [("~/.agents/skills/pdf", "changed"), ("~/.agents/skills/linked", "changed")],
                    "{shell}"
                );
                assert!(!home.join(".arbor").exists(), "{shell}: nothing written");

                let changes = [
                    planned_skill("pdf", &pdf, Some(new_pdf)),
                    planned_skill("fresh", "-", Some(fresh)),
                    planned_skill("old", &old, None),
                    planned(".claude/CLAUDE.md", "-", Some(b"# New\n")),
                ];
                let expected = match &changes[0].content {
                    Some(Content::Skill(skill)) => format!("D{}", skill.sum),
                    _ => unreachable!(),
                };
                let applied = run_in(shell, &home, &apply_script("20260925T120000Z-0002", &commit, &changes));
                assert!(applied.status.success(), "{shell}: {}", String::from_utf8_lossy(&applied.stderr));
                let outcome = parse_outcome(&String::from_utf8_lossy(&applied.stdout));
                assert!(outcome.failed.is_empty(), "{shell}: {:?}", outcome.failed);
                assert_eq!(outcome.done, ["~/.agents/skills/pdf", "~/.agents/skills/fresh", "~/.agents/skills/old", "~/.claude/CLAUDE.md"], "{shell}");
                assert_eq!(place_of(shell, &home, ".agents/skills/pdf"), expected, "{shell}: the repo's copy, whole");
                assert!(!store.join("pdf/stale.md").exists(), "{shell}");
                assert!(fs::metadata(store.join("pdf/scripts/run.sh")).unwrap().permissions().mode() & 0o111 != 0, "{shell}: still runnable");
                assert_eq!(fs::read(store.join("fresh/SKILL.md")).unwrap(), b"fresh\n", "{shell}");
                assert!(!store.join("old").exists(), "{shell}");
                let kept = home.join(".arbor/setup-backups/20260925T120000Z-0002");
                assert_eq!(fs::read(kept.join("folders/0/stale.md")).unwrap(), b"only in the old one\n", "{shell}: the old copy is kept whole");
                assert_eq!(fs::read(kept.join("folders/2/SKILL.md")).unwrap(), b"old\n", "{shell}: and the removed one");

                let listed = run_in(shell, &home, &format!("set -u\n{BACKUPS_SCRIPT}"));
                let found = parse_backups(&String::from_utf8_lossy(&listed.stdout));
                assert_eq!(
                    found[0].files.iter().map(|file| (file.path.as_str(), file.change, file.skill)).collect::<Vec<_>>(),
                    [
                        ("~/.agents/skills/pdf", "changed", true),
                        ("~/.agents/skills/fresh", "added", true),
                        ("~/.agents/skills/old", "removed", true),
                        ("~/.claude/CLAUDE.md", "added", false),
                    ],
                    "{shell}"
                );

                // Undoing waits until each is as the change left it.
                write(&store.join("pdf/SKILL.md"), b"edited since\n");
                let blocked = run_in(shell, &home, &undo_script(&found[0]));
                let outcome = parse_outcome(&String::from_utf8_lossy(&blocked.stdout));
                assert_eq!(outcome.failed, [SyncFailure { path: "~/.agents/skills/pdf".into(), reason: "changed" }], "{shell}");
                assert!(store.join("fresh").exists(), "{shell}: nothing undone");

                write(&store.join("pdf/SKILL.md"), b"new pdf\n");
                let undone = run_in(shell, &home, &undo_script(&found[0]));
                assert!(undone.status.success(), "{shell}: {}", String::from_utf8_lossy(&undone.stderr));
                let outcome = parse_outcome(&String::from_utf8_lossy(&undone.stdout));
                assert!(outcome.failed.is_empty(), "{shell}: {:?}", outcome.failed);
                assert_eq!(place_of(shell, &home, ".agents/skills/pdf"), pdf, "{shell}");
                assert_eq!(place_of(shell, &home, ".agents/skills/old"), old, "{shell}");
                assert_eq!(place_of(shell, &home, ".agents/skills/fresh"), "-", "{shell}");
                assert!(!home.join(".claude/CLAUDE.md").exists(), "{shell}");
                assert_eq!(fs::read(kept.join("undone/1/SKILL.md")).unwrap(), b"fresh\n", "{shell}: moved aside, not removed");
                let _ = fs::remove_dir_all(&home);
            }
        }

        #[test]
        fn only_the_newest_backups_are_kept() {
            let home = temp_dir("prune");
            let root = home.join(".arbor/setup-backups");
            for day in 1..=22 {
                write(&root.join(format!("202609{day:02}T090000Z-0000/manifest")), b"commit\tx\n");
            }
            write(&root.join("keep-me/manifest"), b"not Arbor's\n");
            write(&home.join(".claude/CLAUDE.md"), b"old\n");
            let old = sum_of(&home, ".claude/CLAUDE.md");
            let output = run_in("sh", &home, &apply_script("20260930T090000Z-0000", &"d".repeat(40), &[planned(".claude/CLAUDE.md", &old, Some(b"new\n"))]));
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            let mut left: Vec<String> = fs::read_dir(&root).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
            left.sort();
            assert_eq!(left.len(), BACKUPS_KEPT + 1, "{left:?}");
            assert_eq!(left.first().map(String::as_str), Some("20260904T090000Z-0000"));
            assert!(left.contains(&"keep-me".to_string()) && left.contains(&"20260930T090000Z-0000".to_string()));
            let _ = fs::remove_dir_all(&home);
        }
    }
}

//! Skills in the setup repo. Each folder in the repo's .agents/skills is a
//! skill, synced whole into each machine's store, ~/.agents/skills, which Codex
//! loads and the Skills tab links into Claude Code homes. The repo's copy is
//! fingerprinted the way a machine's scan fingerprints its folder, so the two
//! compare without either leaving where it is.
//!
//! .agents/skill-sources.json records where each skill came from, the way
//! `npx skills` records it in its lock: a repo on GitHub, the path to the
//! skill's SKILL.md there, and the git tree its folder was. Arbor asks GitHub
//! whether that folder has changed since, without an account, and an update is
//! a commit to the repo, each file checked against GitHub's own hash of it.
//! Machines only get an update the way they get everything else in the repo:
//! reviewed, one machine first, with backups.

use super::shell::shell_quote;
use ts_rs::TS;
use super::setup::{scanned_item, HiddenReason, ItemKind, SetupSkillFile, HELPERS};
use super::setup_skills::is_skill_name;
use super::setup_wanted::MACHINES_FILE;
use super::guarded_writes::{cksum, run_on};
use super::setup_sync::{blobs, git, git_out, is_commit, read_repo, repo_file, sha256_hex, SetupRepo, FILE_MAX_BYTES, GIT_TIMEOUT};
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::stream::{self, StreamExt, TryStreamExt};
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, PoisonError};

/// Where the repo keeps skills, as each machine keeps its store in its home folder.
pub(super) const SKILLS_DIR: &str = ".agents/skills";
/// Where the repo records where each skill came from. It's never synced to a machine.
pub(super) const SOURCES_FILE: &str = ".agents/skill-sources.json";
/// The most a skill can hold and still be synced.
const SKILL_MAX_BYTES: u64 = 4 * 1024 * 1024;
const SKILL_MAX_FILES: usize = 400;
/// How long what GitHub said about a source is used before asking again, and after it failed.
const TREE_FRESH: Duration = Duration::from_secs(15 * 60);
const FAILURE_FRESH: Duration = Duration::from_secs(60);

/// Parts of a path a machine's scan leaves out of a skill's fingerprint (see `dir_listing`), which
/// aren't synced either.
fn left_out(rel: &str) -> bool {
    rel == "-" || rel.split('/').any(|part| matches!(part, ".git" | "node_modules" | "__pycache__" | ".DS_Store"))
}

/// What `npx skills` leaves out when it installs a skill, as well: metadata.json files and Python's
/// package folders.
fn left_out_of_install(rel: &str) -> bool {
    left_out(rel) || rel.rsplit('/').next() == Some("metadata.json") || rel.split('/').any(|part| part == "__pypackages__")
}

/// A path in a skill Arbor can sync: relative, with no . or .. in it, and nothing a machine's tools
/// would print differently.
fn plain_path(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.contains(['\\', '\u{FFFD}'])
        && !rel.chars().any(char::is_control)
        && rel.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

/// A file in a skill whose path says it may hold a secret, as a machine's read of a skill judges it.
fn secret_path(rel: &str) -> bool {
    let lower = format!("/{}", rel.to_ascii_lowercase());
    lower.contains("/.env")
        || lower.contains("/id_rsa")
        || lower.contains("/id_ed25519")
        || lower.ends_with("/auth.json")
        || lower.ends_with("/.netrc")
        || [".pem", ".key", ".p12", ".pfx"].iter().any(|end| lower.ends_with(end))
        || ["credential", "secret", "token"].iter().any(|word| lower.contains(word))
}

/// A path as a machine's scan names a skill in its store, ~/.agents/skills/pdf, when it names one.
pub(super) fn store_skill(path: &str) -> Option<&str> {
    path.strip_prefix("~/.agents/skills/").filter(|name| is_skill_name(name))
}

/// A folder in the home folder, as a backup's list names it, when it's a skill in the store.
pub(super) fn store_rel(rel: &str) -> bool {
    rel.strip_prefix(".agents/skills/").is_some_and(is_skill_name)
}

/// Says why a skill can't be synced, after its name.
fn problem_text(problem: &str) -> &'static str {
    match problem {
        "link" => "has a link or a submodule in it, which Arbor doesn't sync",
        "name" => "has a file whose name Arbor can't sync",
        "secret" => "has a file whose name says it may hold a secret, which Arbor doesn't sync",
        "large" => "is too large to sync: over 4 MB or 400 files, or with a file over 1 MB",
        _ => "has no SKILL.md, so the agents wouldn't load it",
    }
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/// What a file's content fingerprints to, with SHA-256 and with `cksum`.
#[derive(Clone, Debug)]
struct Sums {
    sum: String,
    ck: String,
}

impl Sums {
    fn of(bytes: &[u8]) -> Self {
        Self { sum: sha256_hex(bytes), ck: cksum(bytes) }
    }
}

/// A skill's fingerprint as a machine's scan gives it for the same files: each file's path and
/// fingerprint on a line, in byte order, fingerprinted in turn. With SHA-256 and with `cksum`.
fn folder_sums<'a>(files: impl IntoIterator<Item = (&'a str, &'a Sums)>) -> (String, String) {
    let mut files: Vec<(&str, &Sums)> = files.into_iter().collect();
    files.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let (mut sha, mut ck) = (String::new(), String::new());
    for (rel, sums) in files {
        sha.push_str(&format!("{rel}\t{}\n", sums.sum));
        ck.push_str(&format!("{rel}\t{}\n", sums.ck));
    }
    (sha256_hex(sha.as_bytes()), cksum(ck.as_bytes()))
}

/// What each blob fingerprints to, by its object id, which never names anything else.
static BLOB_SUMS: LazyLock<Mutex<HashMap<String, Sums>>> = LazyLock::new(Default::default);

/// The fingerprints of each object named, read from the repo only where they aren't known yet.
async fn blob_sums(folder: &Path, objects: &[&str]) -> Result<HashMap<String, Sums>, String> {
    let mut found = HashMap::new();
    let mut missing: Vec<&str> = Vec::new();
    {
        let known = BLOB_SUMS.lock().unwrap_or_else(PoisonError::into_inner);
        for object in objects {
            match known.get(*object) {
                Some(sums) => {
                    found.insert(object.to_string(), sums.clone());
                }
                None => missing.push(object),
            }
        }
    }
    missing.sort_unstable();
    missing.dedup();
    for chunk in missing.chunks(64) {
        let contents = blobs(folder, chunk).await?;
        let mut known = BLOB_SUMS.lock().unwrap_or_else(PoisonError::into_inner);
        if known.len() > 50_000 {
            known.clear();
        }
        for (object, bytes) in chunk.iter().zip(contents) {
            let sums = Sums::of(&bytes);
            known.insert(object.to_string(), sums.clone());
            found.insert(object.to_string(), sums);
        }
    }
    Ok(found)
}

// ---------------------------------------------------------------------------
// Skills as the repo has them
// ---------------------------------------------------------------------------

/// Where a skill came from, as `npx skills` records it: a repo, the path to its SKILL.md there, and
/// the git tree its folder was when it was installed or last updated.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillSource {
    /// "owner/repo" for one on GitHub.
    source: String,
    source_type: String,
    source_url: Option<String>,
    /// The branch or tag it follows, when it's not the repo's default.
    #[serde(rename = "ref")]
    reference: Option<String>,
    skill_path: Option<String>,
    skill_folder_hash: Option<String>,
}

impl SkillSource {
    /// From an entry of .agents/skill-sources.json or of `npx skills`' lock; None without a source.
    fn read(value: &Value) -> Option<Self> {
        let text = |key: &str| {
            value.get(key).and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()).map(str::to_string)
        };
        Some(Self {
            source: text("source")?,
            source_type: text("sourceType").unwrap_or_default(),
            source_url: text("sourceUrl"),
            reference: text("ref"),
            skill_path: text("skillPath"),
            skill_folder_hash: text("skillFolderHash"),
        })
    }

    /// As the sources file keeps it.
    fn entry(&self) -> Value {
        let mut entry = serde_json::Map::new();
        entry.insert("source".into(), self.source.clone().into());
        if !self.source_type.is_empty() {
            entry.insert("sourceType".into(), self.source_type.clone().into());
        }
        for (key, value) in [
            ("sourceUrl", &self.source_url),
            ("ref", &self.reference),
            ("skillPath", &self.skill_path),
            ("skillFolderHash", &self.skill_folder_hash),
        ] {
            if let Some(value) = value {
                entry.insert(key.into(), value.clone().into());
            }
        }
        Value::Object(entry)
    }

    /// The repo on GitHub, as "owner/repo", when it's one Arbor can ask about.
    fn github(&self) -> Option<&str> {
        let part = |part: Option<&str>| {
            part.is_some_and(|part| {
                !part.is_empty()
                    && part.len() <= 100
                    && part != "."
                    && part != ".."
                    && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
            })
        };
        let mut parts = self.source.split('/');
        (self.source_type == "github" && part(parts.next()) && part(parts.next()) && parts.next().is_none()).then_some(self.source.as_str())
    }

    /// The skill's folder in its repo, where its SKILL.md is: "" for the repo's top.
    fn folder(&self) -> Option<String> {
        let path = self.skill_path.as_deref()?.replace('\\', "/");
        let lower = path.to_ascii_lowercase();
        let folder = if lower == "skill.md" {
            ""
        } else if lower.ends_with("/skill.md") {
            &path[..path.len() - 9]
        } else {
            return None;
        };
        let folder = folder.trim_matches('/');
        (folder.is_empty() || plain_path(folder)).then(|| folder.to_string())
    }

    /// The git tree the skill's folder was when it was taken, when that's recorded.
    fn recorded(&self) -> Option<&str> {
        self.skill_folder_hash.as_deref().filter(|hash| hash.len() == 40 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
    }
}

/// The skills a sources file or a lock names, each with where it came from.
fn parse_sources(bytes: &[u8]) -> BTreeMap<String, SkillSource> {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else { return BTreeMap::new() };
    value
        .get("skills")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(name, _)| is_skill_name(name))
        .filter_map(|(name, entry)| Some((name.clone(), SkillSource::read(entry)?)))
        .collect()
}

/// A skill the repo syncs into each machine's store, as its last commit has it.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "SetupRepoSkill")]
pub(crate) struct RepoSkill {
    name: String,
    /// Where it goes, as a machine's scan names it: ~/.agents/skills/pdf.
    path: String,
    /// Its fingerprint as a machine's scan gives it, and as a machine without a SHA-256 tool does.
    /// None when it can't be synced.
    sum: Option<String>,
    ck: Option<String>,
    files: u32,
    size: u64,
    /// Why it can't be synced: `link` (a link or submodule in it), `name` (a file name the
    /// machines' tools would print differently), `secret` (a file whose name says it may hold one),
    /// `large` (a file over 1 MB, or over 4 MB or 400 files in all) or `noDoc` (no SKILL.md). The
    /// same words a machine sends back when it refuses a skill, so they stay text.
    #[ts(type = r#""link" | "name" | "secret" | "large" | "noDoc" | null"#)]
    problem: Option<&'static str>,
    /// Where it came from, from .agents/skill-sources.json.
    source: Option<SkillSource>,
}

impl RepoSkill {
    pub(super) fn name(&self) -> &str {
        &self.name
    }
}

/// A file or link in a skill, as a commit lists it.
#[derive(Clone, Debug)]
pub(super) struct SkillEntry {
    name: String,
    /// Within the skill's folder.
    rel: String,
    mode: String,
    kind: String,
    object: String,
    size: Option<u64>,
}

impl SkillEntry {
    /// An entry of `git ls-tree -r -l` at `path`, when that's in a skill: .agents/skills/<name>/<rel>.
    pub(super) fn parse(path: &str, mode: &str, kind: &str, object: &str, size: &str) -> Option<Self> {
        let (name, rel) = path.strip_prefix(".agents/skills/")?.split_once('/')?;
        is_skill_name(name).then(|| Self {
            name: name.to_string(),
            rel: rel.to_string(),
            mode: mode.to_string(),
            kind: kind.to_string(),
            object: object.to_string(),
            size: size.parse().ok(),
        })
    }

    pub(super) fn name(&self) -> &str {
        &self.name
    }

    fn is_file(&self) -> bool {
        self.kind == "blob" && matches!(self.mode.as_str(), "100644" | "100755")
    }
}

/// Why a skill with these entries can't be synced, or None when it can.
fn problem(entries: &[SkillEntry]) -> Option<&'static str> {
    let kept: Vec<&SkillEntry> = entries.iter().filter(|entry| !left_out(&entry.rel)).collect();
    if kept.iter().any(|entry| !entry.is_file()) {
        return Some("link");
    }
    if kept.iter().any(|entry| !plain_path(&entry.rel)) {
        return Some("name");
    }
    if kept.iter().any(|entry| secret_path(&entry.rel)) {
        return Some("secret");
    }
    let sizes: Option<Vec<u64>> = kept.iter().map(|entry| entry.size).collect();
    let too_large = sizes.is_none_or(|sizes| {
        sizes.iter().any(|size| *size > FILE_MAX_BYTES) || sizes.iter().sum::<u64>() > SKILL_MAX_BYTES
    });
    if too_large || kept.len() > SKILL_MAX_FILES {
        return Some("large");
    }
    if !kept.iter().any(|entry| entry.rel == "SKILL.md") {
        return Some("noDoc");
    }
    None
}

/// The skills a commit holds, from its entries under .agents/skills, and the object of its sources
/// file when it has one.
pub(super) async fn read_skills(folder: &Path, entries: Vec<SkillEntry>, sources: Option<&str>) -> Result<Vec<RepoSkill>, String> {
    let mut by_name: BTreeMap<String, Vec<SkillEntry>> = BTreeMap::new();
    for entry in entries {
        by_name.entry(entry.name.clone()).or_default().push(entry);
    }
    let sources = match sources {
        Some(object) => parse_sources(&blobs(folder, &[object]).await?.pop().unwrap_or_default()),
        None => BTreeMap::new(),
    };
    let wanted: Vec<&str> = by_name
        .values()
        .filter(|entries| problem(entries).is_none())
        .flatten()
        .filter(|entry| !left_out(&entry.rel))
        .map(|entry| entry.object.as_str())
        .collect();
    let sums = blob_sums(folder, &wanted).await?;
    let mut skills = Vec::with_capacity(by_name.len());
    for (name, entries) in by_name {
        let problem = problem(&entries);
        let kept: Vec<&SkillEntry> = entries.iter().filter(|entry| !left_out(&entry.rel)).collect();
        let (sum, ck) = if problem.is_none() {
            let mut files = Vec::with_capacity(kept.len());
            for entry in &kept {
                let sums = sums.get(&entry.object).ok_or_else(|| format!("git didn't send back {}", entry.object))?;
                files.push((entry.rel.as_str(), sums));
            }
            let (sum, ck) = folder_sums(files);
            (Some(sum), Some(ck))
        } else {
            (None, None)
        };
        skills.push(RepoSkill {
            path: format!("~/{SKILLS_DIR}/{name}"),
            sum,
            ck,
            files: kept.len() as u32,
            size: kept.iter().filter_map(|entry| entry.size).sum(),
            problem,
            source: sources.get(&name).cloned(),
            name,
        });
    }
    Ok(skills)
}

/// The entries of skill `name` as `commit` has them.
async fn skill_entries(folder: &Path, commit: &str, name: &str) -> Result<Vec<SkillEntry>, String> {
    if !is_commit(commit) {
        return Err("That isn't a commit".into());
    }
    if !is_skill_name(name) {
        return Err(format!("Arbor doesn't sync a skill called {name}"));
    }
    // Paths come back as they are from `folder`, which may be inside the repo.
    let pathspec = format!("./{SKILLS_DIR}/{name}");
    let listing = git_out(folder, &["--literal-pathspecs", "ls-tree", "-r", "-l", "-z", commit, "--", &pathspec]).await?;
    Ok(listing
        .split('\0')
        .filter_map(|entry| {
            let (meta, path) = entry.split_once('\t')?;
            let fields: Vec<&str> = meta.split_whitespace().collect();
            let [mode, kind, object, size] = fields.as_slice() else { return None };
            SkillEntry::parse(path, mode, kind, object, size).filter(|entry| entry.name == name)
        })
        .collect())
}

/// A file of a skill, to write.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct SkillFile {
    /// Within the skill's folder.
    pub(super) rel: String,
    pub(super) bytes: Vec<u8>,
    /// It can be run.
    pub(super) exec: bool,
}

/// A skill's files, with the fingerprint a machine's scan will find for them.
#[derive(Debug)]
pub(super) struct SkillFiles {
    pub(super) files: Vec<SkillFile>,
    pub(super) sum: String,
    pub(super) ck: String,
}

impl SkillFiles {
    pub(super) fn of(files: Vec<SkillFile>) -> Self {
        let sums: Vec<Sums> = files.iter().map(|file| Sums::of(&file.bytes)).collect();
        let (sum, ck) = folder_sums(files.iter().map(|file| file.rel.as_str()).zip(&sums));
        Self { files, sum, ck }
    }
}

/// Skill `name` as `commit` has it, to write on a machine.
pub(super) async fn repo_skill(folder: &Path, commit: &str, name: &str) -> Result<SkillFiles, String> {
    let entries = skill_entries(folder, commit, name).await?;
    if entries.is_empty() {
        return Err(format!("The repo's commit has no {name} skill"));
    }
    if let Some(problem) = problem(&entries) {
        return Err(format!("{name} {}", problem_text(problem)));
    }
    let kept: Vec<&SkillEntry> = entries.iter().filter(|entry| !left_out(&entry.rel)).collect();
    let objects: Vec<&str> = kept.iter().map(|entry| entry.object.as_str()).collect();
    let contents = blobs(folder, &objects).await?;
    let files = kept
        .iter()
        .zip(contents)
        .map(|(entry, bytes)| SkillFile { rel: entry.rel.clone(), bytes, exec: entry.mode == "100755" })
        .collect();
    Ok(SkillFiles::of(files))
}

// ---------------------------------------------------------------------------
// Writing skills into the repo
// ---------------------------------------------------------------------------

fn with_config(git_config: &[&str], args: &[&str]) -> Vec<String> {
    git_config.iter().chain(["--literal-pathspecs"].iter()).chain(args).map(|arg| arg.to_string()).collect()
}

async fn run_git(folder: &Path, args: Vec<String>) -> Result<String, String> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    git_out(folder, &args).await
}

/// Makes the repo's working copy of skill `name` hold exactly `files`. What git has of the old copy
/// goes first, links included, so nothing is written through one; files git ignores stay.
async fn write_skill(folder: &Path, name: &str, files: &[SkillFile]) -> Result<(), String> {
    let rel = format!("{SKILLS_DIR}/{name}");
    for step in [".agents", SKILLS_DIR, rel.as_str()] {
        if fs::symlink_metadata(folder.join(step)).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(format!("{step} is a link in the repo, so Arbor leaves it alone"));
        }
    }
    let root = folder.join(&rel);
    let tracked = git_out(folder, &["--literal-pathspecs", "ls-files", "-z", "--", &format!("./{rel}")]).await?;
    let mut emptied = BTreeSet::new();
    for path in tracked.split('\0').filter(|path| !path.is_empty()) {
        let target = folder.join(path);
        if fs::symlink_metadata(&target).is_ok_and(|meta| !meta.is_dir()) {
            fs::remove_file(&target).map_err(|error| format!("Arbor couldn't replace {path}: {error}"))?;
        }
        let mut parent = target.parent();
        while let Some(dir) = parent.filter(|dir| dir.starts_with(&root) && *dir != root) {
            emptied.insert(dir.to_path_buf());
            parent = dir.parent();
        }
    }
    // Deepest first, and only those left empty.
    for dir in emptied.iter().rev() {
        let _ = fs::remove_dir(dir);
    }
    put_files(&root, &rel, files)
}

/// Writes each file into the skill's folder at `root`, `rel` in the repo, never through a link.
pub(super) fn put_files(root: &Path, rel: &str, files: &[SkillFile]) -> Result<(), String> {
    for file in files {
        let target = root.join(&file.rel);
        let mut at = root.to_path_buf();
        for part in file.rel.split('/') {
            at.push(part);
            match fs::symlink_metadata(&at) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(format!("{rel}/{} has a link in the way, which git ignores", file.rel));
                }
                Ok(meta) if at != target && !meta.is_dir() => {
                    return Err(format!("{rel}/{} has a file in the way, which git ignores", file.rel));
                }
                _ => {}
            }
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("Arbor couldn't write {rel}/{}: {error}", file.rel))?;
        }
        fs::write(&target, &file.bytes).map_err(|error| format!("Arbor couldn't write {rel}/{}: {error}", file.rel))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if file.exec { 0o755 } else { 0o644 };
            fs::set_permissions(&target, fs::Permissions::from_mode(mode)).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Records where skills came from in the sources file, keeping what else it records. Whether it changed.
pub(super) fn record_sources(folder: &Path, sources: &BTreeMap<String, SkillSource>) -> Result<bool, String> {
    match sources_text(folder, sources)? {
        Some(text) => {
            let path = folder.join(SOURCES_FILE);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(&path, text).map_err(|error| format!("Arbor couldn't write {SOURCES_FILE}: {error}"))?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// The sources file with where each of `sources` came from, or None when it records that already.
fn sources_text(folder: &Path, sources: &BTreeMap<String, SkillSource>) -> Result<Option<String>, String> {
    let path = folder.join(SOURCES_FILE);
    if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(format!("{SOURCES_FILE} is a link in the repo, so Arbor leaves it alone"));
    }
    let before = match fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Arbor couldn't read {SOURCES_FILE}: {error}")),
    };
    let mut root = match &before {
        Some(bytes) => serde_json::from_slice::<Value>(bytes)
            .ok()
            .filter(Value::is_object)
            .ok_or_else(|| format!("{SOURCES_FILE} isn't JSON Arbor can read. Fix it, then try again."))?,
        None => serde_json::json!({ "version": 1, "skills": {} }),
    };
    let Some(skills) = root.as_object_mut().map(|root| root.entry("skills").or_insert_with(|| serde_json::json!({}))) else {
        return Err(format!("{SOURCES_FILE} isn't JSON Arbor can read"));
    };
    let skills = skills.as_object_mut().ok_or_else(|| format!("{SOURCES_FILE} has skills Arbor can't read. Fix it, then try again."))?;
    for (name, source) in sources {
        skills.insert(name.clone(), source.entry());
    }
    let text = format!("{}\n", serde_json::to_string_pretty(&root).map_err(|error| error.to_string())?);
    Ok((before.as_deref() != Some(text.as_bytes())).then_some(text))
}

/// Commits each skill's files as the repo's copy of it, with where they came from, and nothing else.
/// Nothing is written while any of them has changes in the repo that aren't committed.
pub(super) async fn commit_skills(
    folder: &Path,
    skills: &[(String, Vec<SkillFile>)],
    sources: &BTreeMap<String, SkillSource>,
    message: &str,
    git_config: &[&str],
) -> Result<(), String> {
    let mut pathspecs: Vec<String> = skills.iter().map(|(name, _)| format!("./{SKILLS_DIR}/{name}")).collect();
    let sources_spec = format!("./{SOURCES_FILE}");
    let mut checked = pathspecs.clone();
    checked.push(sources_spec.clone());
    let mut status = vec!["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"];
    status.extend(checked.iter().map(String::as_str));
    let changes = run_git(folder, with_config(&[], &status)).await?;
    if !changes.is_empty() {
        let mut dirty: BTreeSet<String> = BTreeSet::new();
        for entry in changes.split('\0').filter_map(|entry| entry.get(3..)) {
            if let Some(name) = entry.split("/.agents/skills/").nth(1).or_else(|| entry.strip_prefix(".agents/skills/")) {
                dirty.insert(name.split('/').next().unwrap_or(name).to_string());
            } else if entry.ends_with(SOURCES_FILE) {
                dirty.insert(SOURCES_FILE.to_string());
            }
        }
        let list: Vec<String> = dirty.into_iter().collect();
        let what = if list.is_empty() { "those skills".to_string() } else { list.join(", ") };
        return Err(format!("The repo has changes to {what} that aren't committed. Commit or drop them, then try again."));
    }
    // Read before anything's written, so a sources file Arbor can't read stops it all.
    let recorded = if sources.is_empty() { None } else { sources_text(folder, sources)? };
    for (name, files) in skills {
        write_skill(folder, name, files).await?;
    }
    let mut add: Vec<String> = vec!["add".into(), "-f".into(), "--".into()];
    for (name, files) in skills {
        add.extend(files.iter().map(|file| format!("./{SKILLS_DIR}/{name}/{}", file.rel)));
    }
    if let Some(text) = recorded {
        fs::write(folder.join(SOURCES_FILE), text).map_err(|error| format!("Arbor couldn't write {SOURCES_FILE}: {error}"))?;
        add.push(sources_spec.clone());
        pathspecs.push(sources_spec);
    }
    let add: Vec<&str> = add.iter().map(String::as_str).collect();
    run_git(folder, with_config(git_config, &add)).await?;
    let mut removed = vec!["add", "-u", "--"];
    removed.extend(pathspecs.iter().map(String::as_str));
    run_git(folder, with_config(git_config, &removed)).await?;
    // Nothing to commit when each copy is the repo's already.
    let mut staged = vec!["--literal-pathspecs", "diff", "--cached", "--quiet", "--"];
    staged.extend(pathspecs.iter().map(String::as_str));
    if git(folder, &staged, GIT_TIMEOUT).await?.status.success() {
        return Ok(());
    }
    let mut commit = vec!["commit", "--quiet", "-m", message, "--"];
    commit.extend(pathspecs.iter().map(String::as_str));
    run_git(folder, with_config(git_config, &commit)).await?;
    Ok(())
}

/// The sources file without skills `names`, or None when it records none of them.
fn sources_without(folder: &Path, names: &[&str]) -> Result<Option<String>, String> {
    let path = folder.join(SOURCES_FILE);
    if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(format!("{SOURCES_FILE} is a link in the repo, so Arbor leaves it alone"));
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Arbor couldn't read {SOURCES_FILE}: {error}")),
    };
    let mut root = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| format!("{SOURCES_FILE} isn't JSON Arbor can read. Fix it, then try again."))?;
    let Some(skills) = root.get_mut("skills").and_then(Value::as_object_mut) else { return Ok(None) };
    let gone = names.iter().filter(|name| skills.remove(**name).is_some()).count();
    if gone == 0 {
        return Ok(None);
    }
    Ok(Some(format!("{}\n", serde_json::to_string_pretty(&root).map_err(|error| error.to_string())?)))
}

/// Takes skill `name` off every machine in one commit: its folder out of the repo, where it came from out of the
/// sources file, and the mark in .agents/machines.json that has each machine's store copy removed. With `removed`
/// false, the mark goes and the folder, with where it came from, comes back as it was before the commit that took it
/// out, when the repo hasn't got it again already. Nothing is written while any of those has changes that aren't
/// committed.
pub(super) async fn remove_skill(folder: &Path, name: &str, removed: bool, git_config: &[&str]) -> Result<(), String> {
    if !is_skill_name(name) {
        return Err("That isn't a skill's name".into());
    }
    let skill_spec = format!("./{SKILLS_DIR}/{name}");
    let sources_spec = format!("./{SOURCES_FILE}");
    let machines_spec = format!("./{MACHINES_FILE}");
    for step in [".agents", SKILLS_DIR, MACHINES_FILE] {
        if fs::symlink_metadata(folder.join(step)).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(format!("{step} is a link in the repo, so Arbor leaves it alone"));
        }
    }
    let status = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", skill_spec.as_str(), sources_spec.as_str(), machines_spec.as_str()];
    if !run_git(folder, with_config(&[], &status)).await?.is_empty() {
        return Err(format!("The repo has changes to {name}, {SOURCES_FILE} or {MACHINES_FILE} that aren't committed. Commit or drop them, then try again."));
    }
    // Everything is read before anything is written, so a file Arbor can't read stops it all.
    let machines_path = folder.join(MACHINES_FILE);
    let machines_text = match fs::read(&machines_path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Arbor couldn't read {MACHINES_FILE}: {error}")),
    };
    let marked = super::setup_wanted::with_skill_removed(machines_text.as_deref(), name, removed)?;
    let mut paths = vec![machines_spec.clone()];
    let tracked = run_git(folder, with_config(&[], &["--literal-pathspecs", "ls-files", "-z", "--", &skill_spec])).await?;
    let message;
    if removed {
        let sources = sources_without(folder, &[name])?;
        if !tracked.is_empty() {
            run_git(folder, with_config(git_config, &["rm", "-r", "-q", "--", &skill_spec])).await?;
            paths.push(skill_spec.clone());
        }
        if let Some(text) = sources {
            fs::write(folder.join(SOURCES_FILE), text).map_err(|error| format!("Arbor couldn't write {SOURCES_FILE}: {error}"))?;
            paths.push(sources_spec.clone());
        }
        message = format!("Remove skill {name} from every machine");
    } else {
        if tracked.is_empty() {
            // The last commit to touch the folder is the one that took it out; the one before it had it.
            let last = run_git(folder, with_config(&[], &["log", "-1", "--format=%H", "--", &skill_spec])).await?;
            let last = last.trim();
            if is_commit(last) {
                let before = format!("{last}^");
                run_git(folder, with_config(git_config, &["checkout", &before, "--", &skill_spec])).await?;
                paths.push(skill_spec.clone());
                let old = git(folder, &["show", &format!("{before}:{sources_spec}")], GIT_TIMEOUT).await?;
                let source = old.status.success().then(|| parse_sources(&old.stdout).remove(name)).flatten();
                if let Some(source) = source {
                    if record_sources(folder, &BTreeMap::from([(name.to_string(), source)]))? {
                        paths.push(sources_spec.clone());
                    }
                }
            }
        }
        message = format!("Put skill {name} back on every machine");
    }
    fs::write(&machines_path, marked).map_err(|error| format!("Arbor couldn't write {MACHINES_FILE}: {error}"))?;
    let mut add = vec!["add", "--"];
    add.extend(paths.iter().map(String::as_str).filter(|spec| *spec != skill_spec));
    run_git(folder, with_config(git_config, &add)).await?;
    let mut staged = vec!["--literal-pathspecs", "diff", "--cached", "--quiet", "--"];
    staged.extend(paths.iter().map(String::as_str));
    if git(folder, &staged, GIT_TIMEOUT).await?.status.success() {
        return Ok(());
    }
    let mut commit = vec!["commit", "--quiet", "-m", message.as_str(), "--"];
    commit.extend(paths.iter().map(String::as_str));
    run_git(folder, with_config(git_config, &commit)).await?;
    Ok(())
}

/// Takes skills back out of the repo in one commit, as if they'd never been put in: their folders and where they came
/// from go, and nothing is marked removed, so machines keep their copies. Undoes putting skills in the repo. Nothing is
/// written while any of them has changes that aren't committed.
pub(super) async fn drop_skills(folder: &Path, names: &[String], git_config: &[&str]) -> Result<(), String> {
    if names.is_empty() {
        return Err("There's nothing to take out".into());
    }
    if names.len() > 200 {
        return Err("That's too many skills to take out at once".into());
    }
    let mut seen = BTreeSet::new();
    for name in names {
        if !is_skill_name(name) {
            return Err("That isn't a skill's name".into());
        }
        if !seen.insert(name.as_str()) {
            return Err(format!("{name} is in the list twice"));
        }
    }
    for step in [".agents", SKILLS_DIR] {
        if fs::symlink_metadata(folder.join(step)).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(format!("{step} is a link in the repo, so Arbor leaves it alone"));
        }
    }
    let skill_specs: Vec<String> = names.iter().map(|name| format!("./{SKILLS_DIR}/{name}")).collect();
    let sources_spec = format!("./{SOURCES_FILE}");
    let mut status = vec!["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", sources_spec.as_str()];
    status.extend(skill_specs.iter().map(String::as_str));
    if !run_git(folder, with_config(&[], &status)).await?.is_empty() {
        return Err(format!("The repo has changes to {} or {SOURCES_FILE} that aren't committed. Commit or drop them, then try again.", names.join(", ")));
    }
    // Read before anything's written, so a sources file Arbor can't read stops it all.
    let listed: Vec<&str> = names.iter().map(String::as_str).collect();
    let sources = sources_without(folder, &listed)?;
    let mut paths = Vec::new();
    for spec in &skill_specs {
        if !run_git(folder, with_config(&[], &["--literal-pathspecs", "ls-files", "-z", "--", spec])).await?.is_empty() {
            run_git(folder, with_config(git_config, &["rm", "-r", "-q", "--", spec])).await?;
            paths.push(spec.clone());
        }
    }
    if let Some(text) = sources {
        fs::write(folder.join(SOURCES_FILE), text).map_err(|error| format!("Arbor couldn't write {SOURCES_FILE}: {error}"))?;
        run_git(folder, with_config(git_config, &["add", "--", &sources_spec])).await?;
        paths.push(sources_spec);
    }
    // Nothing to commit when the repo hasn't got any of them.
    if paths.is_empty() {
        return Ok(());
    }
    let message = match names {
        [name] => format!("Take the {name} skill back out of the repo"),
        _ => format!("Take {} skills back out of the repo\n\n{}", names.len(), names.join("\n")),
    };
    let mut commit = vec!["commit", "--quiet", "-m", message.as_str(), "--"];
    commit.extend(paths.iter().map(String::as_str));
    run_git(folder, with_config(git_config, &commit)).await?;
    Ok(())
}

/// Takes skills back out of the repo, undoing putting them in (see `drop_skills`).
#[tauri::command]
pub(crate) async fn drop_setup_skills(repo: String, skills: Vec<String>) -> Result<SetupRepo, String> {
    let folder = Path::new(&repo);
    drop_skills(folder, &skills, &[]).await?;
    read_repo(folder).await
}

/// Takes a skill off every machine in the repo, or puts it back, and commits it (see `remove_skill`).
#[tauri::command]
pub(crate) async fn set_setup_skill_removed(repo: String, skill: String, removed: bool) -> Result<SetupRepo, String> {
    let folder = Path::new(&repo);
    remove_skill(folder, &skill, removed, &[]).await?;
    read_repo(folder).await
}

/// Each skill in a machine's store at `store`, as a folder of its own with a SKILL.md, whole, and
/// where `npx skills` says each came from. Skills that couldn't be synced are left out.
pub(super) fn local_skills(store: &Path, lock: &Path) -> (Vec<(String, Vec<SkillFile>)>, BTreeMap<String, SkillSource>) {
    fn walk(root: &Path, rel: &str, depth: usize, files: &mut Vec<SkillFile>, total: &mut u64) -> bool {
        if depth > 16 {
            return false;
        }
        // A folder in it that can't be read is passed over, as the scan passes over it.
        let Ok(entries) = fs::read_dir(root.join(rel)) else { return depth > 0 };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let within = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            if left_out(&within) {
                continue;
            }
            // Followed where it's a link, as the scan's `find -L` follows it.
            let Ok(meta) = fs::metadata(root.join(&within)) else { continue };
            if meta.is_dir() {
                if !walk(root, &within, depth + 1, files, total) {
                    return false;
                }
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            *total += meta.len();
            if !plain_path(&within) || secret_path(&within) || meta.len() > FILE_MAX_BYTES || *total > SKILL_MAX_BYTES || files.len() >= SKILL_MAX_FILES {
                return false;
            }
            let Ok(bytes) = fs::read(root.join(&within)) else { return false };
            let exec = {
                use std::os::unix::fs::PermissionsExt;
                meta.permissions().mode() & 0o111 != 0
            };
            files.push(SkillFile { rel: within, bytes, exec });
        }
        true
    }
    let mut skills = Vec::new();
    let mut entries: Vec<_> = fs::read_dir(store).into_iter().flatten().flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        // A link is another folder's skill, which the scan leaves to it.
        let own = fs::symlink_metadata(entry.path()).is_ok_and(|meta| meta.is_dir());
        if !is_skill_name(&name) || !own || !entry.path().join("SKILL.md").is_file() {
            continue;
        }
        let (mut files, mut total) = (Vec::new(), 0);
        if walk(&entry.path(), "", 0, &mut files, &mut total) && files.iter().any(|file| file.rel == "SKILL.md") {
            files.sort_by(|a, b| a.rel.cmp(&b.rel));
            skills.push((name, files));
        }
    }
    let locked = fs::read(lock).map(|bytes| parse_sources(&bytes)).unwrap_or_default();
    let sources = skills.iter().filter_map(|(name, _)| Some((name.clone(), locked.get(name)?.clone()))).collect();
    (skills, sources)
}

// ---------------------------------------------------------------------------
// Taking a machine's skills into the repo
// ---------------------------------------------------------------------------

// Follows HELPERS. `take index folder` sends a skill's files, those its
// fingerprint covers: `G index`, then for each file `C index path size x` (x is
// 1 when it can be run) with its content in base64 and a line with a dot, or
// stops at `N index path why` for a file that can't be taken: `secret` by its
// name, `large`, `name` where the path can't be read back, or `toomuch` once
// the skills together pass 16 MB. `gone` means the folder or its SKILL.md isn't
// there. Then `J size`, with `npx skills`' lock in base64 and a dot, when it's there.
const TAKE_SCRIPT: &str = r##"tab=$(printf '\t')
all=0
take() {
  printf 'G\t%s\n' "$1"
  if [ ! -d "$2" ] || [ ! -f "$2/SKILL.md" ]; then printf 'N\t%s\t-\tgone\n' "$1"; return 0; fi
  listing=$(dir_listing "$2")
  count=0; total=0
  while IFS=$tab read -r path sum; do
    [ -n "$path" ] || continue
    f="$2/$path"
    if [ ! -f "$f" ]; then printf 'N\t%s\t%s\tname\n' "$1" "$path"; return 0; fi
    lower=$(printf '%s' "/$path" | tr '[:upper:]' '[:lower:]')
    case "$lower" in
      */.env*|*.pem|*.key|*.p12|*.pfx|*credential*|*secret*|*token*|*/auth.json|*/.netrc|*/id_rsa*|*/id_ed25519*)
        printf 'N\t%s\t%s\tsecret\n' "$1" "$path"; return 0 ;;
    esac
    size=$(wc -c < "$f" | tr -d ' ')
    count=$((count + 1)); total=$((total + size)); all=$((all + size))
    if [ "$size" -gt 1048576 ] || [ "$total" -gt 4194304 ] || [ "$count" -gt 400 ]; then printf 'N\t%s\t%s\tlarge\n' "$1" "$path"; return 0; fi
    if [ "$all" -gt 16777216 ]; then printf 'N\t%s\t%s\ttoomuch\n' "$1" "$path"; return 0; fi
    x=0
    if [ -x "$f" ]; then x=1; fi
    printf 'C\t%s\t%s\t%s\t%s\n' "$1" "$path" "$size" "$x"
    base64 < "$f"
    printf '.\n'
  done <<ARBOR_LIST
$listing
ARBOR_LIST
}
"##;

const LOCK_SCRIPT: &str = r##"lock="$HOME/.agents/.skill-lock.json"
if [ -f "$lock" ]; then
  size=$(wc -c < "$lock" | tr -d ' ')
  if [ "$size" -le 1048576 ]; then printf 'J\t%s\n' "$size"; base64 < "$lock"; printf '.\n'; fi
fi
"##;

fn take_script(folders: &[String]) -> String {
    let mut script = format!("set -u\nexport LC_ALL=C\n{HELPERS}{TAKE_SCRIPT}");
    for (index, folder) in folders.iter().enumerate() {
        script.push_str(&format!("take {index} {}\n", shell_quote(folder)));
    }
    script.push_str(LOCK_SCRIPT);
    script
}

/// A skill as a machine sent it, or why it can't be taken.
#[derive(Debug, Default, PartialEq)]
struct Taken {
    files: Vec<SkillFile>,
    refused: Option<(String, String)>,
}

/// What `take_script` sent back: each skill in order, and the lock.
fn parse_taken(stdout: &str, count: usize) -> Result<(Vec<Taken>, Option<Vec<u8>>), String> {
    /// The base64 lines up to a dot, when they come to `size` bytes.
    fn body(lines: &mut std::str::Lines<'_>, size: &str) -> Option<Vec<u8>> {
        let mut encoded = String::new();
        for line in lines.by_ref() {
            if line == "." {
                break;
            }
            encoded.push_str(line.trim());
        }
        STANDARD.decode(encoded.as_bytes()).ok().filter(|bytes| size.parse::<usize>().ok() == Some(bytes.len()))
    }
    let mut taken: Vec<Taken> = (0..count).map(|_| Taken::default()).collect();
    let mut lock = None;
    let mut lines = stdout.lines();
    while let Some(line) = lines.next() {
        let fields: Vec<&str> = line.split('\t').collect();
        let at = |index: &str| index.parse::<usize>().ok().filter(|index| *index < count);
        match fields.as_slice() {
            ["C", index, path, size, exec] => {
                let index = at(index).ok_or("The machine sent back something Arbor couldn't read")?;
                let bytes = body(&mut lines, size).ok_or_else(|| format!("{path} came back incomplete"))?;
                if !plain_path(path) || left_out(path) {
                    taken[index].refused.get_or_insert_with(|| (path.to_string(), "name".into()));
                    continue;
                }
                taken[index].files.push(SkillFile { rel: path.to_string(), bytes, exec: *exec == "1" });
            }
            ["N", index, path, why] => {
                let index = at(index).ok_or("The machine sent back something Arbor couldn't read")?;
                taken[index].refused.get_or_insert_with(|| (path.to_string(), why.to_string()));
            }
            ["J", size] => lock = body(&mut lines, size),
            _ => {}
        }
    }
    Ok((taken, lock))
}

/// Why a skill a machine sent can't be taken, in a sentence, when it can't.
fn refusal(name: &str, machine: &str, taken: &Taken) -> Option<String> {
    let reason = match &taken.refused {
        Some((_, why)) if why == "gone" => format!("{name} isn't on {machine} any more. Scan it again."),
        Some((_, why)) if why == "toomuch" => "Those skills come to more than 16 MB. Take them a few at a time.".into(),
        Some((path, why)) => format!("{name} {} ({path})", problem_text(why)),
        None if !taken.files.iter().any(|file| file.rel == "SKILL.md") => format!("{name} {}", problem_text("noDoc")),
        None => return None,
    };
    Some(reason)
}

/// Commits a machine's copy of each skill as the repo's, recording where `npx skills` on that
/// machine says it came from. A skill can be the machine's store's or a home's own copy.
#[tauri::command]
pub(crate) async fn take_setup_skills(
    state: tauri::State<'_, MachineHealthState>,
    repo: String,
    machine: String,
    paths: Vec<String>,
) -> Result<SetupRepo, String> {
    if paths.is_empty() {
        return Err("There's nothing to take".into());
    }
    if paths.len() > 200 {
        return Err("That's too many skills to take at once".into());
    }
    let mut names: Vec<String> = Vec::with_capacity(paths.len());
    let mut folders = Vec::with_capacity(paths.len());
    let target = {
        let inner = state.lock();
        let mut reach = None;
        for path in &paths {
            let name = path.rsplit('/').next().filter(|name| is_skill_name(name)).ok_or_else(|| format!("Arbor doesn't sync {path}"))?;
            if names.iter().any(|taken| taken == name) {
                return Err(format!("{name} is in the list twice"));
            }
            let (target, absolute) = scanned_item(&inner, &machine, path, &[ItemKind::Skill])?;
            names.push(name.to_string());
            folders.push(absolute);
            reach = Some(target);
        }
        reach.ok_or("There's nothing to take")?
    };
    let stdout = run_on(&target, MachineOp::SkillsTake, &take_script(&folders)).await?;
    let (taken, lock) = parse_taken(&stdout, names.len())?;
    if let Some(reason) = names.iter().zip(&taken).find_map(|(name, taken)| refusal(name, &machine, taken)) {
        return Err(reason);
    }
    let locked = lock.map(|lock| parse_sources(&lock)).unwrap_or_default();
    let sources: BTreeMap<String, SkillSource> = names.iter().filter_map(|name| Some((name.clone(), locked.get(name)?.clone()))).collect();
    let message = match names.as_slice() {
        [name] => format!("Take the {name} skill from {machine}"),
        _ => format!("Take {} skills from {machine}\n\n{}", names.len(), names.join("\n")),
    };
    let skills: Vec<(String, Vec<SkillFile>)> = names.into_iter().zip(taken).map(|(name, taken)| (name, taken.files)).collect();
    let folder = Path::new(&repo);
    commit_skills(folder, &skills, &sources, &message, &[]).await?;
    read_repo(folder).await
}

/// The repo's copy of a skill at `commit`, file by file, with the content of those that can be
/// shown, for comparing with a machine's copy. Each file's fingerprint is its `cksum` when `ck`,
/// as a machine without a SHA-256 tool gives it.
#[tauri::command]
pub(crate) async fn read_setup_repo_skill(repo: String, commit: String, name: String, ck: bool) -> Result<Vec<SetupSkillFile>, String> {
    let folder = Path::new(&repo);
    let entries = skill_entries(folder, &commit, &name).await?;
    if problem(&entries) == Some("large") {
        return Err("It's too large to compare here.".into());
    }
    let kept: Vec<&SkillEntry> = entries.iter().filter(|entry| !left_out(&entry.rel) && entry.is_file()).collect();
    let objects: Vec<&str> = kept.iter().map(|entry| entry.object.as_str()).collect();
    let sums = blob_sums(folder, &objects).await?;
    // Shown as a machine's read of a skill shows them: none whose name says it may hold a secret,
    // none over 128 KB, and no more once 1 MB has been.
    let mut shown = 0u64;
    let mut read = Vec::new();
    let mut files = Vec::with_capacity(kept.len());
    for entry in &kept {
        let size = entry.size.unwrap_or(0);
        let sums = sums.get(&entry.object).ok_or_else(|| format!("git didn't send back {}", entry.rel))?;
        let hidden = if secret_path(&entry.rel) {
            Some(HiddenReason::Secret)
        } else if size > 128 * 1024 || shown + size > 1024 * 1024 {
            Some(HiddenReason::Large)
        } else {
            shown += size;
            read.push(files.len());
            None
        };
        files.push(SetupSkillFile {
            path: entry.rel.clone(),
            sum: if ck { sums.ck.clone() } else { sums.sum.clone() },
            size,
            content: None,
            hidden,
        });
    }
    let wanted: Vec<&str> = read.iter().map(|index| kept[*index].object.as_str()).collect();
    for (index, bytes) in read.into_iter().zip(blobs(folder, &wanted).await?) {
        match String::from_utf8(bytes) {
            Ok(text) => files[index].content = Some(text),
            Err(_) => files[index].hidden = Some(HiddenReason::Binary),
        }
    }
    Ok(files)
}

// ---------------------------------------------------------------------------
// Sources on GitHub
// ---------------------------------------------------------------------------

/// Where GitHub's API and its raw files are, which tests point elsewhere.
#[derive(Clone, Copy)]
struct GithubApis<'a> {
    api: &'a str,
    raw: &'a str,
}

const GITHUB: GithubApis<'static> = GithubApis { api: "https://api.github.com", raw: "https://raw.githubusercontent.com" };

#[derive(Clone, Debug, Deserialize)]
struct UpstreamEntry {
    path: String,
    mode: String,
    #[serde(rename = "type")]
    kind: String,
    sha: String,
    #[serde(default)]
    size: Option<u64>,
}

/// A commit's files as GitHub lists them.
#[derive(Clone, Debug, Deserialize)]
struct UpstreamTree {
    sha: String,
    #[serde(default)]
    tree: Vec<UpstreamEntry>,
    /// GitHub lists at most so many, and then says it cut the list short.
    #[serde(default)]
    truncated: bool,
}

impl UpstreamTree {
    /// The git tree of the folder at `folder`, "" being the top.
    fn folder(&self, folder: &str) -> Option<&str> {
        if folder.is_empty() {
            return Some(&self.sha);
        }
        self.tree.iter().find(|entry| entry.kind == "tree" && entry.path == folder).map(|entry| entry.sha.as_str())
    }

    /// Each file and link in the folder at `folder` that an install keeps, by its path in the folder.
    fn files(&self, folder: &str) -> BTreeMap<&str, &UpstreamEntry> {
        self.tree
            .iter()
            .filter(|entry| entry.kind != "tree")
            .filter_map(|entry| {
                let rel = if folder.is_empty() { Some(entry.path.as_str()) } else { entry.path.strip_prefix(folder)?.strip_prefix('/') };
                rel.filter(|rel| !left_out_of_install(rel)).map(|rel| (rel, entry))
            })
            .collect()
    }
}

/// A path segment as a URL has it.
fn encode_segment(segment: &str) -> String {
    segment
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

/// Why GitHub didn't answer, in a sentence.
fn github_refusal(status: reqwest::StatusCode, headers: &reqwest::header::HeaderMap, what: &str) -> String {
    let remaining = headers.get("x-ratelimit-remaining").and_then(|value| value.to_str().ok());
    if matches!(status.as_u16(), 403 | 429) && remaining == Some("0") {
        let reset = headers
            .get("x-ratelimit-reset")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<i64>().ok())
            .and_then(|seconds| chrono::DateTime::from_timestamp(seconds, 0))
            .map(|when| when.with_timezone(&Local).format("%H:%M").to_string());
        return match reset {
            Some(time) => format!("GitHub's limit on checks without an account is used up until {time}"),
            None => "GitHub's limit on checks without an account is used up for now. Try again within the hour.".into(),
        };
    }
    format!("GitHub answered {} for {what}", status.as_u16())
}

enum Answer<T> {
    Found(T),
    /// GitHub has no such repo, branch or commit, or can't show it without an account.
    Missing,
}

/// A GET to GitHub's API, as JSON or as text.
async fn ask(client: &reqwest::Client, url: &str, accept: &str, what: &str) -> Result<Answer<reqwest::Response>, String> {
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, accept)
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| format!("Arbor couldn't reach GitHub: {error}"))?;
    let status = response.status();
    if status.is_success() {
        return Ok(Answer::Found(response));
    }
    if matches!(status.as_u16(), 404 | 409 | 422) {
        return Ok(Answer::Missing);
    }
    Err(github_refusal(status, response.headers(), what))
}

/// The files of `repo` at `reference`, a branch, tag or commit.
async fn fetch_tree(client: &reqwest::Client, apis: GithubApis<'_>, repo: &str, reference: &str) -> Result<Answer<UpstreamTree>, String> {
    let url = format!("{}/repos/{repo}/git/trees/{}?recursive=1", apis.api, encode_segment(reference));
    match ask(client, &url, "application/vnd.github+json", repo).await? {
        Answer::Found(response) => {
            let tree = response.json::<UpstreamTree>().await.map_err(|_| "GitHub sent back something Arbor couldn't read".to_string())?;
            Ok(Answer::Found(tree))
        }
        Answer::Missing => Ok(Answer::Missing),
    }
}

/// Where a source's skills are looked for: the branch or tag it follows, or else its default branch,
/// as `npx skills` looks.
fn references(reference: Option<&str>) -> Vec<&str> {
    match reference {
        Some(reference) => vec![reference],
        None => vec!["HEAD", "main", "master"],
    }
}

fn not_found(repo: &str) -> String {
    format!("GitHub has no {repo}, or it's private")
}

/// What GitHub last said about each source, by repo and branch, and when.
static TREES: LazyLock<Mutex<HashMap<(String, String), (Instant, Result<Arc<UpstreamTree>, String>)>>> = LazyLock::new(Default::default);

/// The files of `repo` where its skills are looked for, from what GitHub said lately where that's
/// fresh enough, unless `force`.
async fn source_tree(client: &reqwest::Client, apis: GithubApis<'_>, repo: &str, reference: Option<&str>, force: bool) -> (Instant, Result<Arc<UpstreamTree>, String>) {
    let key = (repo.to_string(), reference.unwrap_or_default().to_string());
    if !force {
        let known = TREES.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((at, tree)) = known.get(&key) {
            let fresh = if tree.is_ok() { TREE_FRESH } else { FAILURE_FRESH };
            if at.elapsed() < fresh {
                return (*at, tree.clone());
            }
        }
    }
    let mut result = Err(not_found(repo));
    for candidate in references(reference) {
        match fetch_tree(client, apis, repo, candidate).await {
            Ok(Answer::Found(tree)) => {
                result = Ok(Arc::new(tree));
                break;
            }
            Ok(Answer::Missing) => {}
            Err(error) => {
                result = Err(error);
                break;
            }
        }
    }
    let at = Instant::now();
    TREES.lock().unwrap_or_else(PoisonError::into_inner).insert(key, (at, result.clone()));
    (at, result)
}

/// How the repo's copy of a skill stands against its source.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SourceState {
    /// The repo's copy is its source's.
    Current,
    /// Its source has changed since it was taken.
    Update,
    /// The repo's copy was changed, and its source hasn't been.
    ChangedHere,
    /// Its source hasn't got it any more.
    Gone,
    /// It isn't from GitHub, or doesn't say where in its repo it is.
    Unchecked,
    Error,
}

/// How a skill in the repo stands against its source.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceCheck {
    name: String,
    source: String,
    #[serde(rename = "ref")]
    reference: Option<String>,
    state: SourceState,
    /// Why it's unchecked or couldn't be checked.
    detail: Option<String>,
    /// When GitHub was asked.
    checked_at_ms: Option<i64>,
}

/// How the repo's copy of a skill, file by file, stands against its source's files.
fn judge(source: &SkillSource, ours: &BTreeMap<String, String>, tree: &UpstreamTree) -> (SourceState, Option<String>) {
    let Some(folder) = source.folder() else {
        return (SourceState::Unchecked, Some("Its source doesn't say where in the repo it is".into()));
    };
    if tree.truncated {
        return (SourceState::Error, Some(format!("{} is too large for GitHub to list", source.source)));
    }
    let Some(hash) = tree.folder(&folder) else { return (SourceState::Gone, None) };
    let theirs: BTreeMap<&str, &str> = tree.files(&folder).into_iter().map(|(rel, entry)| (rel, entry.sha.as_str())).collect();
    let same = theirs.len() == ours.len() && ours.iter().all(|(rel, sha)| theirs.get(rel.as_str()) == Some(&sha.as_str()));
    if same {
        (SourceState::Current, None)
    } else if source.recorded() == Some(hash) {
        (SourceState::ChangedHere, None)
    } else {
        (SourceState::Update, None)
    }
}

/// The repo's last commit, when it has one.
async fn head(folder: &Path) -> Result<Option<String>, String> {
    let output = git(folder, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], GIT_TIMEOUT).await?;
    Ok(output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string()).filter(|sha| is_commit(sha)))
}

/// Each skill's files at `commit`, by path in its folder, as git names their content. What an
/// install leaves out is left out.
async fn skill_objects(folder: &Path, commit: &str) -> Result<BTreeMap<String, BTreeMap<String, String>>, String> {
    let pathspec = format!("./{SKILLS_DIR}");
    let listing = git_out(folder, &["--literal-pathspecs", "ls-tree", "-r", "-l", "-z", commit, "--", &pathspec]).await?;
    let mut skills: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for entry in listing.split('\0') {
        let Some((meta, path)) = entry.split_once('\t') else { continue };
        let fields: Vec<&str> = meta.split_whitespace().collect();
        let [mode, kind, object, size] = fields.as_slice() else { continue };
        if let Some(entry) = SkillEntry::parse(path, mode, kind, object, size).filter(|entry| !left_out_of_install(&entry.rel)) {
            skills.entry(entry.name).or_default().insert(entry.rel, entry.object);
        }
    }
    Ok(skills)
}

/// Where the repo's skills came from, as its last commit records it.
async fn committed_sources(folder: &Path, commit: &str) -> BTreeMap<String, SkillSource> {
    repo_file(folder, commit, SOURCES_FILE).await.map(|bytes| parse_sources(&bytes)).unwrap_or_default()
}

async fn check_sources(folder: &Path, client: &reqwest::Client, apis: GithubApis<'_>, force: bool) -> Result<Vec<SourceCheck>, String> {
    let Some(commit) = head(folder).await? else { return Ok(Vec::new()) };
    let sources = committed_sources(folder, &commit).await;
    let skills = skill_objects(folder, &commit).await?;
    let now_ms = Local::now().timestamp_millis();
    let now = Instant::now();
    let mut trees: HashMap<(String, Option<String>), (Instant, Result<Arc<UpstreamTree>, String>)> = HashMap::new();
    let mut checks = Vec::new();
    for (name, source) in &sources {
        let Some(ours) = skills.get(name) else { continue };
        let mut check = SourceCheck {
            name: name.clone(),
            source: source.source.clone(),
            reference: source.reference.clone(),
            state: SourceState::Unchecked,
            detail: None,
            checked_at_ms: None,
        };
        let Some(repo) = source.github() else {
            check.detail = Some("Arbor can check skills from GitHub only".into());
            checks.push(check);
            continue;
        };
        let key = (repo.to_string(), source.reference.clone());
        if !trees.contains_key(&key) {
            let tree = source_tree(client, apis, repo, source.reference.as_deref(), force).await;
            trees.insert(key.clone(), tree);
        }
        let (at, tree) = &trees[&key];
        check.checked_at_ms = Some(now_ms - now.saturating_duration_since(*at).as_millis() as i64);
        match tree {
            Ok(tree) => (check.state, check.detail) = judge(source, ours, tree),
            Err(error) => (check.state, check.detail) = (SourceState::Error, Some(error.clone())),
        }
        checks.push(check);
    }
    Ok(checks)
}

fn github_client(gui_config_state: &GuiConfigState) -> Result<reqwest::Client, String> {
    let proxy_url = gui_config_state.snapshot()?.proxy_url;
    crate::core_runtime::build_http_client_with_proxy(
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .user_agent(concat!("Arbor/", env!("CARGO_PKG_VERSION"))),
        &proxy_url,
        "Arbor couldn't set up a connection to GitHub",
    )
}

/// How each of the repo's skills with a recorded source stands against it on GitHub. What GitHub
/// said in the last 15 minutes is used again, unless `force`.
#[tauri::command]
pub(crate) async fn check_setup_skill_sources(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    repo: String,
    force: bool,
) -> Result<Vec<SourceCheck>, String> {
    let client = github_client(&gui_config_state)?;
    check_sources(Path::new(&repo), &client, GITHUB, force).await
}

/// The commit `reference` names in `repo`, or its default branch's last.
async fn resolve_commit(client: &reqwest::Client, apis: GithubApis<'_>, repo: &str, reference: Option<&str>) -> Result<String, String> {
    for candidate in references(reference) {
        let url = format!("{}/repos/{repo}/commits/{}", apis.api, encode_segment(candidate));
        if let Answer::Found(response) = ask(client, &url, "application/vnd.github.sha", repo).await? {
            let sha = response.text().await.map_err(|error| format!("GitHub's answer broke off: {error}"))?;
            let sha = sha.trim();
            return if sha.len() == 40 && sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                Ok(sha.to_ascii_lowercase())
            } else {
                Err("GitHub sent back something Arbor couldn't read".into())
            };
        }
    }
    Err(not_found(repo))
}

/// The name git gives a file's content.
fn git_blob_sha(bytes: &[u8]) -> String {
    let mut hasher = sha1::Sha1::new();
    hasher.update(format!("blob {}\0", bytes.len()).as_bytes());
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Each file, from GitHub's raw files at `commit`, checked against the name git gives its content.
async fn download(client: &reqwest::Client, apis: GithubApis<'_>, repo: &str, commit: &str, files: Vec<(String, UpstreamEntry)>) -> Result<Vec<SkillFile>, String> {
    let mut downloaded: Vec<SkillFile> = stream::iter(files)
        .map(|(rel, entry)| async move {
            let path: Vec<String> = entry.path.split('/').map(encode_segment).collect();
            let url = format!("{}/{repo}/{commit}/{}", apis.raw, path.join("/"));
            let mut response = client.get(&url).send().await.map_err(|error| format!("Arbor couldn't download {rel}: {error}"))?;
            if !response.status().is_success() {
                return Err(format!("GitHub answered {} for {rel}", response.status().as_u16()));
            }
            let expected = entry.size.unwrap_or(FILE_MAX_BYTES);
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| format!("{rel} broke off: {error}"))? {
                bytes.extend_from_slice(&chunk);
                if bytes.len() as u64 > expected {
                    return Err(format!("{rel} came back larger than GitHub lists it"));
                }
            }
            if git_blob_sha(&bytes) != entry.sha.to_ascii_lowercase() {
                return Err(format!("{rel} came back different from what GitHub lists"));
            }
            Ok(SkillFile { rel, bytes, exec: entry.mode == "100755" })
        })
        .buffer_unordered(8)
        .try_collect()
        .await?;
    downloaded.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(downloaded)
}

/// Replaces the repo's copy of skill `name` with its source's latest, as one commit that records the
/// source's new tree for it.
async fn update_skill(folder: &Path, name: &str, client: &reqwest::Client, apis: GithubApis<'_>, git_config: &[&str]) -> Result<(), String> {
    let commit = head(folder).await?.ok_or("Nothing is committed in the repo yet")?;
    let sources = committed_sources(folder, &commit).await;
    let source = sources.get(name).ok_or_else(|| format!("The repo doesn't record where {name} came from"))?;
    let repo = source.github().ok_or("Arbor can update skills from GitHub only")?;
    let place = source.folder().ok_or_else(|| format!("The repo's record of {name} doesn't say where in {repo} it is"))?;
    let upstream = resolve_commit(client, apis, repo, source.reference.as_deref()).await?;
    let tree = match fetch_tree(client, apis, repo, &upstream).await? {
        Answer::Found(tree) => tree,
        Answer::Missing => return Err(not_found(repo)),
    };
    if tree.truncated {
        return Err(format!("{repo} is too large for GitHub to list"));
    }
    let hash = tree.folder(&place).ok_or_else(|| format!("{repo} hasn't got {name} any more"))?.to_string();
    let files: Vec<(String, UpstreamEntry)> = tree.files(&place).into_iter().map(|(rel, entry)| (rel.to_string(), entry.clone())).collect();
    if files.iter().any(|(_, entry)| entry.kind != "blob" || !matches!(entry.mode.as_str(), "100644" | "100755")) {
        return Err(format!("{name} in {repo} {}", problem_text("link")));
    }
    let problem = if files.iter().any(|(rel, _)| !plain_path(rel)) {
        Some("name")
    } else if files.iter().any(|(rel, _)| secret_path(rel)) {
        Some("secret")
    } else if files.len() > SKILL_MAX_FILES
        || files.iter().any(|(_, entry)| entry.size.is_none_or(|size| size > FILE_MAX_BYTES))
        || files.iter().filter_map(|(_, entry)| entry.size).sum::<u64>() > SKILL_MAX_BYTES
    {
        Some("large")
    } else if !files.iter().any(|(rel, _)| rel == "SKILL.md") {
        Some("noDoc")
    } else {
        None
    };
    if let Some(problem) = problem {
        return Err(format!("{name} in {repo} {}", problem_text(problem)));
    }
    let downloaded = download(client, apis, repo, &upstream, files).await?;
    let mut updated = source.clone();
    updated.skill_folder_hash = Some(hash);
    let sources = BTreeMap::from([(name.to_string(), updated)]);
    commit_skills(folder, &[(name.to_string(), downloaded)], &sources, &format!("Update {name} from {repo}"), git_config).await?;
    // A check after this compares with what was just taken.
    let key = (repo.to_string(), source.reference.clone().unwrap_or_default());
    TREES.lock().unwrap_or_else(PoisonError::into_inner).insert(key, (Instant::now(), Ok(Arc::new(tree))));
    Ok(())
}

/// Replaces the repo's copy of a skill with its source's latest on GitHub, as a commit. Machines get
/// it once they're brought in step.
#[tauri::command]
pub(crate) async fn update_setup_skill(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    repo: String,
    name: String,
) -> Result<SetupRepo, String> {
    if !is_skill_name(&name) {
        return Err(format!("Arbor doesn't sync a skill called {name}"));
    }
    let client = github_client(&gui_config_state)?;
    let folder = Path::new(&repo);
    update_skill(folder, &name, &client, GITHUB, &[]).await?;
    read_repo(folder).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_judged_as_the_machines_judge_them() {
        for kept in ["SKILL.md", "scripts/run.py", "a b/c – “d”.md", "tokenless/../x"] {
            assert!(!left_out(kept), "{kept}");
        }
        for out in ["node_modules/x/index.js", ".DS_Store", "a/.DS_Store", "__pycache__/x.pyc", ".git", "-"] {
            assert!(left_out(out), "{out}");
        }
        assert!(left_out_of_install("metadata.json") && left_out_of_install("a/metadata.json") && left_out_of_install("__pypackages__/x"));
        assert!(!left_out_of_install("metadata.json.md"));
        for bad in ["", "a\\b", "a\tb", "a//b", "./a", "a/../b", "/a", "a/"] {
            assert!(!plain_path(bad), "{bad:?}");
        }
        for secret in [".env", "config/.env.local", "certs/server.PEM", "api-token.md", "My Secrets/x.md", "auth.json", "keys/id_ed25519.pub"] {
            assert!(secret_path(secret), "{secret}");
        }
        for plain in ["SKILL.md", "reference/environment.md", "keys.md", "authors.json"] {
            assert!(!secret_path(plain), "{plain}");
        }
        assert_eq!(store_skill("~/.agents/skills/pdf"), Some("pdf"));
        for other in ["~/.agents/skills/.hidden", "~/.agents/skills/a/b", "~/.claude/skills/pdf", "~/.agents/skills/"] {
            assert_eq!(store_skill(other), None, "{other}");
        }
        assert!(store_rel(".agents/skills/pdf") && !store_rel(".agents/skills/../x") && !store_rel(".claude/CLAUDE.md"));
    }

    #[test]
    fn sources_read_as_npx_skills_writes_them() {
        let lock = br#"{"version":3,"skills":{
            "pdf":{"source":"anthropics/skills","sourceType":"github","sourceUrl":"https://github.com/anthropics/skills.git","skillPath":"skills/pdf/SKILL.md","skillFolderHash":"0123456789abcdef0123456789abcdef01234567","installedAt":"2026-09-01T00:00:00Z"},
            "solo":{"source":"me/solo","sourceType":"github","ref":"v2","skillPath":"SKILL.md"},
            "mine":{"source":"/Users/a/src/mine","sourceType":"local"},
            "../x":{"source":"a/b","sourceType":"github"},
            "empty":{"sourceType":"github"}
        }}"#;
        let sources = parse_sources(lock);
        assert_eq!(sources.keys().map(String::as_str).collect::<Vec<_>>(), ["mine", "pdf", "solo"]);
        let pdf = &sources["pdf"];
        assert_eq!((pdf.github(), pdf.folder().as_deref(), pdf.recorded()), (Some("anthropics/skills"), Some("skills/pdf"), Some("0123456789abcdef0123456789abcdef01234567")));
        assert_eq!(pdf.entry().get("installedAt"), None, "only where it came from is kept");
        let solo = &sources["solo"];
        assert_eq!((solo.folder().as_deref(), solo.reference.as_deref(), solo.recorded()), (Some(""), Some("v2"), None));
        assert_eq!(sources["mine"].github(), None);
        for bad in ["a", "a/b/c", "a/..", "a b/c", "a/b?x"] {
            let source = SkillSource { source: bad.into(), source_type: "github".into(), ..SkillSource::default() };
            assert_eq!(source.github(), None, "{bad}");
        }
        assert_eq!(parse_sources(b"not json"), BTreeMap::new());
    }

    #[test]
    fn the_last_folder_of_a_tree_is_found_and_its_install_listed() {
        let entry = |path: &str, kind: &str, sha: &str| UpstreamEntry { path: path.into(), mode: if kind == "tree" { "040000".into() } else { "100644".into() }, kind: kind.into(), sha: sha.into(), size: Some(1) };
        let tree = UpstreamTree {
            sha: "root".into(),
            truncated: false,
            tree: vec![
                entry("README.md", "blob", "r"),
                entry("skills", "tree", "t0"),
                entry("skills/pdf", "tree", "t1"),
                entry("skills/pdf/SKILL.md", "blob", "s1"),
                entry("skills/pdf/metadata.json", "blob", "m1"),
                entry("skills/pdf-extra/SKILL.md", "blob", "s2"),
            ],
        };
        assert_eq!((tree.folder("skills/pdf"), tree.folder(""), tree.folder("skills/nope")), (Some("t1"), Some("root"), None));
        assert_eq!(tree.files("skills/pdf").keys().copied().collect::<Vec<_>>(), ["SKILL.md"], "not its neighbor, nor what an install leaves out");
        assert_eq!(tree.files("").len(), 3);
        assert_eq!(encode_segment("release/1.0 é"), "release%2F1.0%20%C3%A9");
        assert_eq!(git_blob_sha(b"hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a", "as `git hash-object` names it");
    }

    #[cfg(unix)]
    mod on_disk {
        use super::*;
        use std::io::{Read, Write};
        use std::os::unix::fs::{symlink, PermissionsExt};

        fn temp_dir(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("arbor-repo-skills-{name}-{}-{stamp}", std::process::id()));
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

        fn run(home: &Path, script: &str) -> std::process::Output {
            std::process::Command::new("sh")
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
                .arg("-c")
                .arg(script)
                .output()
                .unwrap()
        }

        /// How a skill's folder stands, as a machine's scan and its checks give it; with `cksum`'s
        /// fingerprints when `ck`, as a machine without a SHA-256 tool gives them.
        fn machine_place(home: &Path, rel: &str, ck: bool) -> String {
            let checksums = if ck {
                "sum_in() { s=$(cksum) && printf 'c%s' \"$(printf '%s' \"$s\" | tr ' ' '-')\"; }\nhash_each() { xargs -0 cksum; }\nhashed=ck\n"
            } else {
                ""
            };
            let script = format!(
                "set -u\nexport LC_ALL=C\n{HELPERS}{checksums}{}place \"$home/\"{}\n",
                super::super::setup_skills::SKILL_FUNCTIONS,
                shell_quote(rel)
            );
            String::from_utf8_lossy(&run(home, &script).stdout).into_owned()
        }

        /// A skill with the kinds of files and names the fingerprint has to order and leave out alike.
        fn tricky_skill(folder: &Path) {
            write(&folder.join("SKILL.md"), b"---\nname: pdf\ndescription: Read PDFs.\n---\n");
            write(&folder.join("scripts/run.py"), b"print('hi')\n");
            fs::set_permissions(folder.join("scripts/run.py"), fs::Permissions::from_mode(0o755)).unwrap();
            write(&folder.join("reference/notes – “quoted”.md"), "Naïve.\n".as_bytes());
            for name in ["a b/c.txt", "a-b.md", "a.b.md", "a/x.md", "ab.md"] {
                write(&folder.join(name), name.as_bytes());
            }
            write(&folder.join("empty.md"), b"");
            write(&folder.join("-"), b"a file called -\n");
            write(&folder.join(".DS_Store"), b"finder\n");
            write(&folder.join("reference/.DS_Store"), b"finder\n");
            write(&folder.join("__pycache__/run.cpython-312.pyc"), b"\x00\x01");
            write(&folder.join("node_modules/left/index.js"), b"module.exports = 1;\n");
        }

        fn repo_with(root: &Path, setup: &Path) -> SetupRepo {
            git_in(root, &["add", "--all"]);
            git_in(root, &["commit", "--quiet", "-m", "Skills"]);
            block_on(read_repo(setup)).unwrap()
        }

        #[test]
        fn a_repo_skill_fingerprints_as_the_machines_copy_does() {
            let root = temp_dir("fingerprint");
            git_in(&root, &["init", "--quiet"]);
            let setup = root.join("agents");
            tricky_skill(&setup.join(".agents/skills/pdf"));
            let home = temp_dir("fingerprint-home");
            tricky_skill(&home.join(".agents/skills/pdf"));

            let repo = repo_with(&root, &setup);
            let skill = serde_json::to_value(&repo).unwrap()["skills"][0].clone();
            assert_eq!(skill["name"], "pdf");
            assert_eq!(skill["problem"], Value::Null);
            assert_eq!(skill["files"], 9, "{skill}");
            assert_eq!(format!("D{}", skill["sum"].as_str().unwrap()), machine_place(&home, ".agents/skills/pdf", false));
            assert_eq!(format!("D{}", skill["ck"].as_str().unwrap()), machine_place(&home, ".agents/skills/pdf", true));

            // The files a machine gets are those the fingerprint covers, and fingerprint the same.
            let head = repo_head(&setup);
            let files = block_on(repo_skill(&setup, &head, "pdf")).unwrap();
            assert_eq!(Some(files.sum.as_str()), skill["sum"].as_str());
            assert!(!files.files.iter().any(|file| left_out(&file.rel)));
            assert!(files.files.iter().find(|file| file.rel == "scripts/run.py").is_some_and(|file| file.exec));
            let _ = fs::remove_dir_all(&root);
            let _ = fs::remove_dir_all(&home);
        }

        fn repo_head(folder: &Path) -> String {
            block_on(head(folder)).unwrap().unwrap()
        }

        #[test]
        fn skills_that_cant_be_synced_say_why_and_the_rest_is_listed_as_before() {
            let root = temp_dir("problems");
            git_in(&root, &["init", "--quiet"]);
            let skills = root.join(".agents/skills");
            write(&skills.join("fine/SKILL.md"), b"Fine.\n");
            write(&skills.join("linked/SKILL.md"), b"Linked.\n");
            symlink("SKILL.md", skills.join("linked/README.md")).unwrap();
            write(&skills.join("leaky/SKILL.md"), b"Leaky.\n");
            write(&skills.join("leaky/config/api-token.txt"), b"SECRET\n");
            write(&skills.join("big/SKILL.md"), b"Big.\n");
            write(&skills.join("big/data.bin"), &vec![7u8; FILE_MAX_BYTES as usize + 1]);
            write(&skills.join("nodoc/README.md"), b"No SKILL.md.\n");
            write(&skills.join("odd/SKILL.md"), b"Odd.\n");
            write(&skills.join("odd/a\\b.md"), b"A backslash.\n");
            write(&skills.join("README.md"), b"Not a skill.\n");
            write(&skills.join(".hidden/SKILL.md"), b"Hidden.\n");
            write(&root.join(".agents/.skill-lock.json"), b"{}\n");
            write(&root.join(SOURCES_FILE), br#"{"version":1,"skills":{"fine":{"source":"acme/skills","sourceType":"github","skillPath":"skills/fine/SKILL.md"}}}"#);
            let repo = repo_with(&root, &root);
            let value = serde_json::to_value(&repo).unwrap();
            let problems: Vec<(&str, &Value)> = value["skills"].as_array().unwrap().iter().map(|skill| (skill["name"].as_str().unwrap(), &skill["problem"])).collect();
            assert_eq!(
                problems,
                [
                    ("big", &Value::from("large")),
                    ("fine", &Value::Null),
                    ("leaky", &Value::from("secret")),
                    ("linked", &Value::from("link")),
                    ("nodoc", &Value::from("noDoc")),
                    ("odd", &Value::from("name")),
                ]
            );
            assert_eq!(value["skills"][1]["source"]["source"], "acme/skills");
            assert_eq!(value["skills"][0]["sum"], Value::Null, "only what can be synced is fingerprinted");
            assert_eq!(value["ignored"], serde_json::json!([".agents/.skill-lock.json", ".agents/skills/.hidden/SKILL.md", ".agents/skills/README.md"]));

            // A skill with changes that aren't committed is named once.
            write(&skills.join("fine/SKILL.md"), b"Fine, edited.\n");
            write(&skills.join("fine/new.md"), b"New.\n");
            let again = serde_json::to_value(block_on(read_repo(&root)).unwrap()).unwrap();
            assert_eq!(again["uncommitted"], serde_json::json!(["~/.agents/skills/fine"]));
            let _ = fs::remove_dir_all(&root);
        }

        fn file(rel: &str, content: &str, exec: bool) -> SkillFile {
            SkillFile { rel: rel.into(), bytes: content.as_bytes().to_vec(), exec }
        }

        fn log(folder: &Path) -> Vec<String> {
            git_in(folder, &["log", "--format=%s"]).lines().map(str::to_string).collect()
        }

        fn committed(folder: &Path, name: &str) -> Vec<String> {
            let listing = git_in(folder, &["ls-tree", "-r", "HEAD", "--", &format!("./{SKILLS_DIR}/{name}")]);
            listing.lines().map(|line| {
                let (meta, path) = line.split_once('\t').unwrap();
                format!("{} {}", meta.split(' ').next().unwrap(), path.rsplit_once(&format!("{name}/")).unwrap().1)
            }).collect()
        }

        #[test]
        fn skills_are_committed_whole_with_where_they_came_from() {
            let root = temp_dir("commit");
            git_in(&root, &["init", "--quiet"]);
            write(&root.join("README.md"), b"# Dotfiles\n");
            git_in(&root, &["add", "--all"]);
            git_in(&root, &["commit", "--quiet", "-m", "Start"]);
            let setup = root.join("setup");
            fs::create_dir_all(&setup).unwrap();
            let source = SkillSource {
                source: "acme/skills".into(),
                source_type: "github".into(),
                skill_path: Some("skills/pdf/SKILL.md".into()),
                skill_folder_hash: Some("a".repeat(40)),
                ..SkillSource::default()
            };
            let first = vec![file("SKILL.md", "v1\n", false), file("scripts/run.py", "print(1)\n", true), file("old.md", "Old.\n", false)];
            let sources = BTreeMap::from([("pdf".to_string(), source.clone())]);
            block_on(commit_skills(&setup, &[("pdf".into(), first.clone())], &sources, "Take the pdf skill from mac", &IDENTITY)).unwrap();
            assert_eq!(log(&setup)[0], "Take the pdf skill from mac");
            assert_eq!(committed(&setup, "pdf"), ["100644 SKILL.md", "100644 old.md", "100755 scripts/run.py"]);
            let recorded = parse_sources(&fs::read(setup.join(SOURCES_FILE)).unwrap());
            assert_eq!(recorded["pdf"], source);

            // Taken again: what the new copy hasn't got goes, a link in the old one is replaced rather
            // than written through, and a file git ignores is left.
            let outside = temp_dir("commit-outside");
            write(&outside.join("target.md"), b"Outside.\n");
            symlink(outside.join("target.md"), setup.join(".agents/skills/pdf/linked.md")).unwrap();
            git_in(&setup, &["add", "--all"]);
            git_in(&setup, &["commit", "--quiet", "-m", "Link"]);
            write(&root.join(".gitignore"), b".DS_Store\n");
            git_in(&root, &["add", ".gitignore"]);
            git_in(&root, &["commit", "--quiet", "-m", "Ignore"]);
            write(&setup.join(".agents/skills/pdf/.DS_Store"), b"finder\n");
            let second = vec![file("SKILL.md", "v2\n", false), file("linked.md", "Mine now.\n", false), file("scripts/run.py", "print(2)\n", false)];
            block_on(commit_skills(&setup, &[("pdf".into(), second.clone())], &BTreeMap::new(), "Take it again", &IDENTITY)).unwrap();
            assert_eq!(committed(&setup, "pdf"), ["100644 SKILL.md", "100644 linked.md", "100644 scripts/run.py"]);
            assert_eq!(fs::read(outside.join("target.md")).unwrap(), b"Outside.\n");
            assert!(setup.join(".agents/skills/pdf/.DS_Store").exists());
            assert_eq!(parse_sources(&fs::read(setup.join(SOURCES_FILE)).unwrap())["pdf"], source, "a source is kept when none is given");

            // The same again has nothing to commit.
            let before = log(&setup);
            block_on(commit_skills(&setup, &[("pdf".into(), second.clone())], &BTreeMap::new(), "Again", &IDENTITY)).unwrap();
            assert_eq!(log(&setup), before);

            // Changes that aren't committed stop it, and so does a sources file Arbor can't read,
            // before anything's written.
            write(&setup.join(".agents/skills/pdf/SKILL.md"), b"Edited here.\n");
            let refused = block_on(commit_skills(&setup, &[("pdf".into(), first.clone())], &BTreeMap::new(), "Take", &IDENTITY)).unwrap_err();
            assert!(refused.contains("pdf that aren't committed"), "{refused}");
            git_in(&setup, &["checkout", "--", "."]);
            write(&setup.join(SOURCES_FILE), b"{ not json");
            git_in(&setup, &["add", "--all"]);
            git_in(&setup, &["commit", "--quiet", "-m", "Break the sources"]);
            let refused = block_on(commit_skills(&setup, &[("pdf".into(), first)], &sources, "Take", &IDENTITY)).unwrap_err();
            assert!(refused.contains("isn't JSON"), "{refused}");
            assert_eq!(fs::read(setup.join(".agents/skills/pdf/SKILL.md")).unwrap(), b"v2\n", "nothing written");
            let _ = fs::remove_dir_all(&root);
            let _ = fs::remove_dir_all(&outside);
        }

        #[test]
        fn a_machines_skills_are_read_whole_with_its_lock() {
            let home = temp_dir("take");
            tricky_skill(&home.join(".agents/skills/pdf"));
            write(&home.join(".claude/skills/own/SKILL.md"), b"Own.\n");
            write(&home.join(".agents/skills/leaky/SKILL.md"), b"Leaky.\n");
            write(&home.join(".agents/skills/leaky/config/api-token.txt"), b"SECRET\n");
            write(&home.join(".agents/.skill-lock.json"), br#"{"version":3,"skills":{"pdf":{"source":"acme/skills","sourceType":"github","skillPath":"skills/pdf/SKILL.md"}}}"#);
            let at = |rel: &str| home.join(rel).display().to_string();
            let output = run(&home, &take_script(&[at(".agents/skills/pdf"), at(".claude/skills/own"), at(".agents/skills/leaky"), at(".agents/skills/gone")]));
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(!stdout.contains("SECRET") && !stdout.contains(&STANDARD.encode("SECRET\n")), "a secret's content never leaves the machine");
            let (taken, lock) = parse_taken(&stdout, 4).unwrap();
            let pdf = &taken[0];
            assert_eq!(refusal("pdf", "mac", pdf), None);
            assert_eq!(SkillFiles::of(pdf.files.clone()).sum, machine_place(&home, ".agents/skills/pdf", false).trim_start_matches('D'));
            assert!(pdf.files.iter().find(|file| file.rel == "scripts/run.py").is_some_and(|file| file.exec));
            assert_eq!(taken[1].files.iter().map(|file| file.rel.as_str()).collect::<Vec<_>>(), ["SKILL.md"]);
            assert!(refusal("leaky", "mac", &taken[2]).is_some_and(|why| why.contains("secret") && why.contains("config/api-token.txt")));
            assert!(refusal("gone", "mac", &taken[3]).is_some_and(|why| why.contains("isn't on mac any more")));
            assert_eq!(parse_sources(&lock.unwrap())["pdf"].source, "acme/skills");

            // And this Mac's own store, read here, for starting a repo.
            let (skills, sources) = local_skills(&home.join(".agents/skills"), &home.join(".agents/.skill-lock.json"));
            assert_eq!(skills.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), ["pdf"], "the leaky one stays out");
            assert_eq!(SkillFiles::of(skills[0].1.clone()).sum, SkillFiles::of(pdf.files.clone()).sum);
            assert_eq!(sources.keys().collect::<Vec<_>>(), ["pdf"]);
            let _ = fs::remove_dir_all(&home);
        }

        type Routes = Arc<Mutex<HashMap<String, (u16, Vec<(&'static str, String)>, Vec<u8>)>>>;

        /// A stand-in for GitHub: answers each path from `routes`, one connection at a time.
        fn serve(routes: Routes) -> String {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let mut data = Vec::new();
                    let mut buffer = [0; 4096];
                    while !data.windows(4).any(|window| window == b"\r\n\r\n") {
                        match stream.read(&mut buffer) {
                            Ok(0) | Err(_) => break,
                            Ok(read) => data.extend_from_slice(&buffer[..read]),
                        }
                    }
                    let head = String::from_utf8_lossy(&data).into_owned();
                    let path = head.split_whitespace().nth(1).unwrap_or_default().to_string();
                    let (status, headers, body) = routes.lock().unwrap().get(&path).cloned().unwrap_or((404, Vec::new(), b"{}".to_vec()));
                    let mut reply = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
                    for (name, value) in headers {
                        reply.push_str(&format!("{name}: {value}\r\n"));
                    }
                    reply.push_str("\r\n");
                    let _ = stream.write_all(reply.as_bytes());
                    let _ = stream.write_all(&body);
                }
            });
            base
        }

        fn tree_json(root: &str, entries: &[(&str, &str, &str, &[u8])]) -> Vec<u8> {
            let tree: Vec<Value> = entries
                .iter()
                .map(|(path, mode, sha, content)| {
                    if *mode == "040000" {
                        serde_json::json!({ "path": path, "mode": mode, "type": "tree", "sha": sha })
                    } else {
                        serde_json::json!({ "path": path, "mode": mode, "type": "blob", "sha": git_blob_sha(content), "size": content.len() })
                    }
                })
                .collect();
            serde_json::to_vec(&serde_json::json!({ "sha": root, "tree": tree, "truncated": false })).unwrap()
        }

        #[test]
        fn a_skill_removed_from_every_machine_leaves_the_repo_and_comes_back() {
            let root = temp_dir("removed");
            git_in(&root, &["init", "--quiet"]);
            let setup = root.join("agents");
            fs::create_dir_all(&setup).unwrap();
            let source = SkillSource { source: "acme/skills".into(), source_type: "github".into(), skill_path: Some("skills/pdf/SKILL.md".into()), ..SkillSource::default() };
            let other = SkillSource { source: "acme/other".into(), source_type: "github".into(), ..SkillSource::default() };
            let skills: Vec<(String, Vec<SkillFile>)> = vec![
                ("pdf".into(), vec![file("SKILL.md", "pdf\n", false), file("scripts/run.sh", "echo\n", true)]),
                ("sketch".into(), vec![file("SKILL.md", "sketch\n", false)]),
            ];
            let sources = BTreeMap::from([("pdf".to_string(), source), ("sketch".to_string(), other)]);
            block_on(commit_skills(&setup, &skills, &sources, "Take 2 skills", &IDENTITY)).unwrap();
            write(&setup.join(MACHINES_FILE), br#"{"version":1,"skills":{"pdf":{"machines":{"cedar":"own"}}}}"#);
            git_in(&setup, &["add", "--", "."]);
            git_in(&setup, &["commit", "--quiet", "-m", "Cedar keeps its own pdf"]);

            block_on(remove_skill(&setup, "pdf", true, &IDENTITY)).unwrap();
            assert_eq!(log(&setup)[0], "Remove skill pdf from every machine");
            assert!(committed(&setup, "pdf").is_empty());
            assert!(!setup.join(".agents/skills/pdf").exists());
            let recorded = parse_sources(&fs::read(setup.join(SOURCES_FILE)).unwrap());
            assert_eq!(recorded.keys().collect::<Vec<_>>(), ["sketch"], "only its own source goes");
            let repo = serde_json::to_value(block_on(read_repo(&setup)).unwrap()).unwrap();
            assert_eq!(repo["removedSkills"], serde_json::json!(["pdf"]));
            assert_eq!(repo["skillMachines"]["pdf"]["cedar"], "own", "a machine's own value stays");
            assert_eq!(repo["skills"].as_array().unwrap().len(), 1);
            assert!(git_in(&setup, &["status", "--porcelain"]).is_empty(), "everything's committed");
            // Again is nothing new.
            block_on(remove_skill(&setup, "pdf", true, &IDENTITY)).unwrap();
            assert_eq!(log(&setup).len(), 3);

            // A change not committed stops it.
            write(&setup.join(".agents/skills/sketch/SKILL.md"), b"edited\n");
            assert!(block_on(remove_skill(&setup, "sketch", true, &IDENTITY)).unwrap_err().contains("aren't committed"));
            git_in(&setup, &["checkout", "--", "."]);

            block_on(remove_skill(&setup, "pdf", false, &IDENTITY)).unwrap();
            assert_eq!(log(&setup)[0], "Put skill pdf back on every machine");
            assert_eq!(committed(&setup, "pdf"), ["100644 SKILL.md", "100755 scripts/run.sh"]);
            let recorded = parse_sources(&fs::read(setup.join(SOURCES_FILE)).unwrap());
            assert_eq!(recorded["pdf"].source, "acme/skills", "where it came from comes back too");
            let repo = serde_json::to_value(block_on(read_repo(&setup)).unwrap()).unwrap();
            assert_eq!(repo["removedSkills"], serde_json::json!([]));
            assert_eq!(repo["skills"].as_array().unwrap().len(), 2);
            assert!(git_in(&setup, &["status", "--porcelain"]).is_empty());

            // A skill only machines have can be marked removed too: nothing leaves the repo but the mark goes in.
            block_on(remove_skill(&setup, "loose", true, &IDENTITY)).unwrap();
            let repo = serde_json::to_value(block_on(read_repo(&setup)).unwrap()).unwrap();
            assert_eq!(repo["removedSkills"], serde_json::json!(["loose"]));
            assert!(block_on(remove_skill(&setup, "../x", true, &IDENTITY)).is_err());
            let _ = fs::remove_dir_all(&root);
        }

        #[test]
        fn skills_put_in_the_repo_come_back_out_without_a_removed_mark() {
            let root = temp_dir("dropped");
            git_in(&root, &["init", "--quiet"]);
            let setup = root.join("agents");
            fs::create_dir_all(&setup).unwrap();
            let source = SkillSource { source: "acme/skills".into(), source_type: "github".into(), ..SkillSource::default() };
            let skills: Vec<(String, Vec<SkillFile>)> = vec![
                ("pdf".into(), vec![file("SKILL.md", "pdf\n", false)]),
                ("sketch".into(), vec![file("SKILL.md", "sketch\n", false)]),
                ("notes".into(), vec![file("SKILL.md", "notes\n", false)]),
            ];
            block_on(commit_skills(&setup, &skills, &BTreeMap::from([("pdf".to_string(), source)]), "Take 3 skills", &IDENTITY)).unwrap();

            block_on(drop_skills(&setup, &["pdf".into(), "sketch".into()], &IDENTITY)).unwrap();
            assert_eq!(log(&setup)[0], "Take 2 skills back out of the repo");
            assert!(committed(&setup, "pdf").is_empty() && committed(&setup, "sketch").is_empty());
            assert_eq!(committed(&setup, "notes"), ["100644 SKILL.md"], "the rest stay");
            assert!(parse_sources(&fs::read(setup.join(SOURCES_FILE)).unwrap()).is_empty(), "where it came from goes too");
            let repo = serde_json::to_value(block_on(read_repo(&setup)).unwrap()).unwrap();
            assert_eq!(repo["removedSkills"], serde_json::json!([]), "nothing is marked removed, so machines keep theirs");
            assert!(git_in(&setup, &["status", "--porcelain"]).is_empty());
            // One the repo hasn't got is nothing to commit.
            block_on(drop_skills(&setup, &["pdf".into()], &IDENTITY)).unwrap();
            assert_eq!(log(&setup).len(), 2);

            write(&setup.join(".agents/skills/notes/SKILL.md"), b"edited\n");
            assert!(block_on(drop_skills(&setup, &["notes".into()], &IDENTITY)).unwrap_err().contains("aren't committed"));
            git_in(&setup, &["checkout", "--", "."]);
            assert!(block_on(drop_skills(&setup, &["notes".into(), "notes".into()], &IDENTITY)).unwrap_err().contains("twice"));
            assert!(block_on(drop_skills(&setup, &["../x".into()], &IDENTITY)).is_err());
            assert!(block_on(drop_skills(&setup, &[], &IDENTITY)).is_err());
            let _ = fs::remove_dir_all(&root);
        }

        #[test]
        fn a_skill_is_checked_against_github_and_updated_from_it() {
            let setup = temp_dir("github");
            git_in(&setup, &["init", "--quiet"]);
            let repo_name = format!("acme/skills-{}", std::process::id());
            let (t1, t2, commit) = ("1".repeat(40), "2".repeat(40), "c".repeat(40));
            let source = |name: &str, hash: &str| SkillSource {
                source: repo_name.clone(),
                source_type: "github".into(),
                skill_path: Some(format!("skills/{name}/SKILL.md")),
                skill_folder_hash: Some(hash.into()),
                ..SkillSource::default()
            };
            let local = SkillSource { source: "/Users/a/src/mine".into(), source_type: "local".into(), ..SkillSource::default() };
            let sources = BTreeMap::from([
                ("pdf".to_string(), source("pdf", &t1)),
                ("gone".to_string(), source("gone", &t1)),
                ("mine".to_string(), local),
            ]);
            let skills: Vec<(String, Vec<SkillFile>)> = ["pdf", "gone", "mine"].iter().map(|name| (name.to_string(), vec![file("SKILL.md", "v1\n", false)])).collect();
            block_on(commit_skills(&setup, &skills, &sources, "Take 3 skills", &IDENTITY)).unwrap();

            let (skill, script, metadata) = (b"v2\n".as_slice(), b"print(2)\n".as_slice(), b"{}".as_slice());
            let entries: &[(&str, &str, &str, &[u8])] = &[
                ("README.md", "100644", "", b"# Skills\n"),
                ("skills", "040000", "0000000000000000000000000000000000000000", b""),
                ("skills/pdf", "040000", &t2, b""),
                ("skills/pdf/SKILL.md", "100644", "", skill),
                ("skills/pdf/metadata.json", "100644", "", metadata),
                ("skills/pdf/scripts", "040000", "3333333333333333333333333333333333333333", b""),
                ("skills/pdf/scripts/run.py", "100755", "", script),
            ];
            let tree = tree_json("r".repeat(40).as_str(), entries);
            let routes: Routes = Arc::default();
            {
                let mut routes = routes.lock().unwrap();
                routes.insert(format!("/repos/{repo_name}/git/trees/HEAD?recursive=1"), (200, Vec::new(), tree.clone()));
                routes.insert(format!("/repos/{repo_name}/git/trees/{commit}?recursive=1"), (200, Vec::new(), tree));
                routes.insert(format!("/repos/{repo_name}/commits/HEAD"), (200, Vec::new(), format!("{commit}\n").into_bytes()));
                routes.insert(format!("/{repo_name}/{commit}/skills/pdf/SKILL.md"), (200, Vec::new(), skill.to_vec()));
                routes.insert(format!("/{repo_name}/{commit}/skills/pdf/scripts/run.py"), (200, Vec::new(), script.to_vec()));
            }
            let base = serve(routes.clone());
            let apis = GithubApis { api: &base, raw: &base };
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let states = |force: bool| -> Vec<(String, SourceState)> {
                block_on(check_sources(&setup, &client, apis, force)).unwrap().into_iter().map(|check| (check.name, check.state)).collect()
            };
            assert_eq!(states(true), [("gone".into(), SourceState::Gone), ("mine".into(), SourceState::Unchecked), ("pdf".into(), SourceState::Update)]);

            block_on(update_skill(&setup, "pdf", &client, apis, &IDENTITY)).unwrap();
            assert_eq!(log(&setup)[0], format!("Update pdf from {repo_name}"));
            assert_eq!(committed(&setup, "pdf"), ["100644 SKILL.md", "100755 scripts/run.py"], "metadata.json stays out, as an install leaves it");
            assert_eq!(fs::read(setup.join(".agents/skills/pdf/SKILL.md")).unwrap(), skill);
            let recorded = parse_sources(&fs::read(setup.join(SOURCES_FILE)).unwrap());
            assert_eq!(recorded["pdf"].recorded(), Some(t2.as_str()));
            assert_eq!(recorded["gone"].recorded(), Some(t1.as_str()), "the others' records are kept");
            assert_eq!(states(false)[2], ("pdf".into(), SourceState::Current));

            // Changed in the repo since, with nothing new at its source.
            block_on(commit_skills(&setup, &[("pdf".into(), vec![file("SKILL.md", "Mine.\n", false), file("scripts/run.py", "print(2)\n", true)])], &BTreeMap::new(), "Edit", &IDENTITY)).unwrap();
            assert_eq!(states(false)[2], ("pdf".into(), SourceState::ChangedHere));

            // A file that doesn't come back as GitHub lists it stops the update.
            routes.lock().unwrap().insert(format!("/{repo_name}/{commit}/skills/pdf/SKILL.md"), (200, Vec::new(), b"tampered\n".to_vec()));
            let refused = block_on(update_skill(&setup, "pdf", &client, apis, &IDENTITY)).unwrap_err();
            assert!(refused.contains("SKILL.md came back"), "{refused}");
            assert_eq!(fs::read(setup.join(".agents/skills/pdf/SKILL.md")).unwrap(), b"Mine.\n");

            // Out of checks without an account.
            let reset = (Local::now().timestamp() + 600).to_string();
            routes.lock().unwrap().insert(
                format!("/repos/{repo_name}/git/trees/HEAD?recursive=1"),
                (403, vec![("x-ratelimit-remaining", "0".into()), ("x-ratelimit-reset", reset)], b"{}".to_vec()),
            );
            let checks = block_on(check_sources(&setup, &client, apis, true)).unwrap();
            assert_eq!(checks[2].state, SourceState::Error);
            assert!(checks[2].detail.as_deref().is_some_and(|detail| detail.contains("used up until")), "{:?}", checks[2].detail);
            let _ = fs::remove_dir_all(&setup);
        }
    }
}

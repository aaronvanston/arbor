//! The git checkouts on each machine, for the Projects tab on Setup: every repo a session has
//! worked in there, with its worktrees, their branches, how far they are from upstream, what's
//! uncommitted, which ones are merged and can go, how much disk they take, and the instruction
//! files each checkout keeps.
//!
//! The repos to look at come from the sessions Arbor already knows about (the checkout each
//! transcript says it ran in), so nothing on the machine is searched. A scan only reads: git runs
//! with optional locks off, so even `git status` doesn't rewrite an index. It fetches only when
//! asked to. A remote's address leaves the machine without the user name and password in it, and
//! is kept as `host/owner/name`. Instruction files leave as a checksum and a size, and their text
//! is read only when someone asks to compare them. Scans are kept in memory, not stored.
//!
//! Removing a worktree is `git worktree remove` without `--force`, for worktrees the last scan
//! found clean, merged or with their upstream branch deleted, and not used lately. The machine
//! checks each one again first. A merged branch is deleted with `git branch -d`, which refuses an
//! unmerged one; a branch whose upstream is gone is kept.

use super::shell::shell_quote;
use ts_rs::TS;
use super::setup::{covered_machine, parse_overrides, read_text_after, OverrideState, SetupText, HELPERS};
use super::setup_plugins::message;
use super::*;

pub(crate) const SETUP_PROJECTS_UPDATED_EVENT: &str = "setup-projects-updated";

/// The most repos looked at on a machine, the most recently used first.
const MOST_REPOS: usize = 100;
/// How long a scan keeps going before it stops where it is and says so, in seconds.
const SCAN_BUDGET_S: u32 = 150;
const FETCH_BUDGET_S: u32 = 480;
const MEASURE_BUDGET_S: u32 = 240;
const SCAN_TIMEOUT: Duration = Duration::from_secs(200);
const FETCH_TIMEOUT: Duration = Duration::from_secs(600);
const MEASURE_TIMEOUT: Duration = Duration::from_secs(300);
/// Removals stop being started after this long, so a big batch reports what it did.
const REMOVE_BUDGET_S: u32 = 120;
const REMOVE_TIMEOUT: Duration = Duration::from_secs(600);
/// A worktree used or touched this recently is left alone.
const RECENT_MS: i64 = 60 * 60 * 1000;
/// Removals are only planned from a scan this fresh.
const PLAN_FRESH_MS: i64 = 30 * 60 * 1000;
const MOST_REMOVALS: usize = 50;
/// The ignored files and folders listed for each worktree; the rest are counted.
const IGNORED_SHOWN: usize = 20;
const PATH_CHARS: usize = 4_096;
const NAME_CHARS: usize = 255;

/// The instruction files looked for at the top of each checkout.
pub(crate) const INSTRUCTION_FILES: [&str; 3] = [".claude/CLAUDE.md", "CLAUDE.md", "AGENTS.md"];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RepoState {
    #[default]
    Ok,
    /// The folder isn't there any more.
    Missing,
    /// The folder is there but isn't the top of a git checkout.
    NotGit,
}

/// Why a worktree can't be removed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Blocker {
    Main,
    Locked,
    /// Another checkout is inside its folder, and would go with it.
    Nested,
    /// Git still lists it, but its folder is gone.
    Missing,
    /// Arbor couldn't read its state.
    Unknown,
    Dirty,
    /// Git is told not to check some of its files for changes, so edits to them wouldn't show.
    Hidden,
    /// A rebase, merge, cherry-pick, revert or bisect is under way in it.
    Midway,
    /// Its own history of HEAD holds commits nothing else has.
    Unreachable,
    /// Something is running in it.
    Open,
    Recent,
    DefaultBranch,
    NotMerged,
}

impl Blocker {
    fn text(self) -> &'static str {
        match self {
            Self::Main => "it's the main checkout",
            Self::Locked => "it's locked",
            Self::Nested => "another checkout is inside it",
            Self::Missing => "its folder is gone",
            Self::Unknown => "Arbor couldn't read it",
            Self::Dirty => "it has changes",
            Self::Hidden => "git is told not to check some of its files for changes",
            Self::Midway => "a rebase, merge or bisect is under way in it",
            Self::Unreachable => "it has commits only its own history remembers",
            Self::Open => "something is running in it",
            Self::Recent => "it was used in the last hour",
            Self::DefaultBranch => "it's on the default branch",
            Self::NotMerged => "its work isn't merged",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectWorktree {
    path: String,
    main: bool,
    head: Option<String>,
    /// None when it's detached.
    branch: Option<String>,
    locked: bool,
    prunable: bool,
    /// Changed tracked files, and untracked ones; None when `git status` failed.
    changed: Option<u32>,
    untracked: Option<u32>,
    upstream: Option<String>,
    ahead: Option<u32>,
    behind: Option<u32>,
    /// Its upstream branch was deleted, as a merged pull request's usually is.
    gone: bool,
    /// Its commit is in the default branch.
    merged: bool,
    committed_at: Option<i64>,
    /// When git last wrote its index or HEAD.
    touched_at: Option<i64>,
    /// Something on the machine is running in it.
    open: bool,
    /// Files git is told not to check for changes.
    hidden: u32,
    /// Another git checkout is inside its folder.
    nested: bool,
    /// A rebase, merge, cherry-pick, revert or bisect is under way.
    midway: bool,
    /// Commits only its own history of HEAD holds.
    unreachable: u32,
    /// Its folder with links resolved, which sessions may have recorded instead.
    #[serde(skip)]
    real: Option<String>,
    /// The last request of a session that ran in it.
    last_used_ms: Option<i64>,
    /// Ignored files and folders, which go with it: names only.
    ignored: Vec<String>,
    ignored_more: u32,
    size_kb: Option<u64>,
    blocker: Option<Blocker>,
    /// Plugins its own Claude Code settings turn on or off: .claude/settings.local.json (local,
    /// git-ignored, where Arbor sets a project's value) and .claude/settings.json (checked in).
    plugins: Vec<CheckoutPlugin>,
    /// Skills those files' skillOverrides turn on or off, or change how they're offered.
    skills: Vec<CheckoutSkill>,
    /// Those files whose skillOverrides Claude Code ignores altogether, as one of the values isn't
    /// one it knows: `settings.local.json` or `settings.json`.
    ignored_overrides: Vec<String>,
    /// It has no settings.local.json, and Git wouldn't ignore a new one, so Arbor won't create it.
    local_seen: bool,
    /// MCP servers those files deny by name, which nothing turns back on.
    mcp_denied: Vec<CheckoutMcpDeny>,
    /// From the machine's ~/.claude.json, by name only: servers set up for this checkout alone
    /// (Claude Code's local scope), and servers turned off here with /mcp.
    mcp_local: Vec<String>,
    mcp_disabled: Vec<String>,
    /// The project instruction files Arbor writes in it, as the scan found them.
    instructions: Vec<CheckoutInstructions>,
    /// Its AGENTS.md's fingerprint, as cksum gives it, when it has one.
    agents_md: Option<String>,
    /// It has a CLAUDE.md or .claude/CLAUDE.md, so Claude Code reads that rather than AGENTS.md.
    claude_md: bool,
    /// The project skill folders Arbor wrote in it, with their fingerprints, and (`!` first) ones it left as the
    /// project's own.
    #[serde(skip)]
    arbor_skills: Vec<(String, String)>,
}

/// A project instruction file Arbor writes in a checkout.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum InstructionFile {
    /// CLAUDE.local.md, which Claude Code reads beside the project's own instructions.
    ClaudeLocal,
    /// AGENTS.override.md, which Codex reads in place of AGENTS.md.
    AgentsOverride,
}

impl InstructionFile {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::ClaudeLocal => "CLAUDE.local.md",
            Self::AgentsOverride => "AGENTS.override.md",
        }
    }
}

/// How a checkout has one of those files.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LocalFileState {
    /// Not there, and Git ignores one there.
    None,
    /// Not there, and Git would see a new one.
    Seen,
    /// There, and not Arbor's: someone's own, or a link.
    Own,
    /// Arbor wrote it.
    Arbor,
}

/// One of the instruction files in a checkout, with what Arbor's first line says it holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckoutInstructions {
    file: InstructionFile,
    state: LocalFileState,
    /// The fingerprint of the project's text it holds.
    text: Option<String>,
    /// CLAUDE.local.md: it imports AGENTS.md first.
    import: Option<bool>,
    /// AGENTS.override.md: the fingerprint of the AGENTS.md it copied, `-` for none.
    agents: Option<String>,
}

/// The fields in Arbor's first line: `<!-- arbor: … text=… import=1 agents=… -->`, as `key=value` words.
pub(crate) fn marker_field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    line.split_whitespace().find_map(|word| word.strip_prefix(key)?.strip_prefix('=')).filter(|value| !value.is_empty() && value.len() <= 80)
}

/// An MCP server a checkout's settings deny, by name, and nothing else of the entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckoutMcpDeny {
    name: String,
    /// From settings.local.json rather than the checked-in settings.json.
    local: bool,
}

/// A skill a checkout's settings name in skillOverrides: its name and the state, nothing else.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckoutSkill {
    name: String,
    state: OverrideState,
    /// From settings.local.json rather than the checked-in settings.json.
    local: bool,
}

/// A plugin a checkout's settings name in enabledPlugins. Only the id and whether it's on leave the
/// scan; the rest of those files never does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckoutPlugin {
    id: String,
    on: bool,
    /// From settings.local.json rather than the checked-in settings.json.
    local: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectFile {
    name: String,
    sum: String,
    size: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectRepo {
    /// The main checkout, or a bare repo.
    path: String,
    state: RepoState,
    bare: bool,
    /// `host/owner/name`, without credentials.
    remote: Option<String>,
    /// The branch merges are checked against, like `origin/main`.
    default_branch: Option<String>,
    fetched_at: Option<i64>,
    /// The fetch Arbor asked for didn't work.
    fetch_failed: bool,
    last_used_ms: Option<i64>,
    worktrees: Vec<ProjectWorktree>,
    files: Vec<ProjectFile>,
}

/// What's at a place the setup repo wants a project.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PlaceKind {
    /// Nothing there.
    #[default]
    Missing,
    /// A link to nothing.
    Broken,
    File,
    /// An empty folder, which a clone can fill.
    Empty,
    /// A folder that isn't the top of a checkout.
    Other,
    Checkout,
}

/// How a main checkout stands: what Sync › Projects needs to say whether it's up to date and safe to move.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckoutStatus {
    /// None when no branch is checked out.
    pub(super) branch: Option<String>,
    /// Changed tracked files, and untracked ones; None when `git status` failed.
    pub(super) changed: Option<u32>,
    pub(super) untracked: Option<u32>,
    pub(super) upstream: Option<String>,
    pub(super) ahead: Option<u32>,
    pub(super) behind: Option<u32>,
    /// The remote's default branch, like `origin/main`.
    pub(super) default_branch: Option<String>,
    pub(super) fetched_at: Option<i64>,
    /// The fetch Arbor asked for didn't work.
    pub(super) fetch_failed: bool,
    /// Its linked worktrees, which a move would have to repair.
    pub(super) worktrees: u32,
}

/// A place the setup repo wants a project, as the last scan found it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FoundPlace {
    /// As the repo gives it: `~/…` or absolute.
    pub(super) path: String,
    pub(super) kind: PlaceKind,
    /// Where it leads, when it's a link.
    pub(super) link: Option<String>,
    /// The folder it is, links followed.
    pub(super) real: Option<String>,
    /// A checkout's origin as `host/owner/name`.
    pub(super) remote: Option<String>,
    #[serde(flatten)]
    pub(super) status: CheckoutStatus,
}

/// A main checkout the last scan found from sessions, as Sync › Projects compares it.
pub(super) struct FoundCheckout {
    pub(super) path: String,
    /// With links followed, where the scan knew.
    pub(super) real: Option<String>,
    pub(super) remote: Option<String>,
    pub(super) status: CheckoutStatus,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineProjects {
    machine: String,
    home_dir: String,
    scanned_at: Option<i64>,
    /// The scan ran out of time before it reached every repo.
    partial: bool,
    /// When the last scan fetched first.
    fetched_at: Option<i64>,
    measured_at: Option<i64>,
    scanning: bool,
    measuring: bool,
    removing: bool,
    error: Option<String>,
    repos: Vec<ProjectRepo>,
    /// The places the setup repo wants its projects here, from the same scan.
    places: Vec<FoundPlace>,
}

/// A remote as compared: any case, with or without `.git`.
fn same_remote(remote: &str) -> String {
    remote.trim().trim_end_matches('/').trim_end_matches(".git").to_ascii_lowercase()
}

/// The places a scan script finds, run under `shell` with HOME `home`: for tests elsewhere.
#[cfg(all(test, unix))]
pub(super) fn places_found(shell: &str, home: &Path, places: &[String]) -> Vec<FoundPlace> {
    let mut command = tokio::process::Command::new(shell);
    command
        .env_clear()
        .env("HOME", home)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::runtime::Runtime::new().unwrap().block_on(super::shell::run_script(command, &scan_script(&[], places, false), Duration::from_secs(60))).unwrap();
    parse_scan(&String::from_utf8_lossy(&output.stdout), &HashMap::new(), 0).places
}

impl MachineProjects {
    /// A machine's projects as a scan printing `stdout` would leave them.
    #[cfg(test)]
    pub(super) fn from_scan(machine: &str, stdout: &str) -> Self {
        let scanned = parse_scan(stdout, &HashMap::new(), 0);
        MachineProjects { machine: machine.into(), home_dir: scanned.home_dir, scanned_at: Some(1), repos: scanned.repos, places: scanned.places, ..MachineProjects::default() }
    }
}

impl MachineProjects {
    pub(super) fn places(&self) -> &[FoundPlace] {
        &self.places
    }

    pub(super) fn scanned_at(&self) -> Option<i64> {
        self.scanned_at
    }

    pub(super) fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub(super) fn is_scanning(&self) -> bool {
        self.scanning
    }

    /// Every checkout and worktree of the repo whose remote is `remote` (`host/owner/name`, compared loosely), and the
    /// place the setup repo wants it when that's a checkout of it the sessions haven't led to: where a project's own
    /// skills go.
    pub(super) fn project_worktrees(&self, remote: Option<&str>, place: Option<&str>) -> Vec<String> {
        let mut paths: Vec<String> = Vec::new();
        if let Some(wanted) = remote.map(same_remote) {
            for repo in self.repos.iter().filter(|repo| repo.state == RepoState::Ok && !repo.bare && repo.remote.as_deref().is_some_and(|found| same_remote(found) == wanted)) {
                for worktree in repo.worktrees.iter().filter(|worktree| !worktree.prunable) {
                    paths.push(worktree.real.clone().unwrap_or_else(|| worktree.path.clone()));
                }
            }
        }
        if let Some(place) = place.filter(|place| !paths.iter().any(|path| path == place)) {
            paths.push(place.to_string());
        }
        paths
    }

    /// The project skill folders Arbor wrote in the worktree at `path`, as its last scan found them.
    pub(super) fn arbor_skills(&self, path: &str) -> &[(String, String)] {
        self.repos
            .iter()
            .flat_map(|repo| &repo.worktrees)
            .find(|worktree| worktree.path == path || worktree.real.as_deref() == Some(path))
            .map_or(&[], |worktree| worktree.arbor_skills.as_slice())
    }

    /// The main checkouts the last scan found, most recently used first, each with how it stands.
    pub(super) fn main_checkouts(&self) -> Vec<FoundCheckout> {
        self.repos
            .iter()
            .filter(|repo| repo.state == RepoState::Ok && !repo.bare)
            .map(|repo| {
                let main = repo.worktrees.iter().find(|worktree| worktree.main);
                FoundCheckout {
                    path: repo.path.clone(),
                    real: main.and_then(|main| main.real.clone()),
                    remote: repo.remote.clone(),
                    status: CheckoutStatus {
                        branch: main.and_then(|main| main.branch.clone()),
                        changed: main.and_then(|main| main.changed),
                        untracked: main.and_then(|main| main.untracked),
                        upstream: main.and_then(|main| main.upstream.clone()),
                        ahead: main.and_then(|main| main.ahead),
                        behind: main.and_then(|main| main.behind),
                        default_branch: repo.default_branch.clone(),
                        fetched_at: repo.fetched_at,
                        fetch_failed: repo.fetch_failed,
                        worktrees: repo.worktrees.iter().filter(|worktree| !worktree.main).count() as u32,
                    },
                }
            })
            .collect()
    }

    /// The project (lowercase `owner/name`) of the checkout at `path`, from its repo's remote, when the last scan found it.
    pub(crate) fn checkout_project(&self, path: &str) -> Option<String> {
        let repo = self.repos.iter().find(|repo| repo.worktrees.iter().any(|worktree| worktree.path == path))?;
        let remote = repo.remote.as_deref()?;
        let mut parts = remote.rsplitn(3, '/');
        let name = parts.next()?.trim_end_matches(".git");
        let owner = parts.next()?;
        Some(format!("{owner}/{name}").to_ascii_lowercase())
    }

    /// Whether a scan has finished here, so a repo missing from it isn't on the machine as far as sessions show.
    pub(crate) fn scanned(&self) -> bool {
        self.scanned_at.is_some()
    }

    /// The main checkout of the repo whose remote is `remote` (`host/owner/name`), when the last scan found one.
    pub(crate) fn repo_path(&self, remote: &str) -> Option<&str> {
        let wanted = same_remote(remote);
        self.repos
            .iter()
            .filter(|repo| repo.state == RepoState::Ok && !repo.bare)
            .find(|repo| repo.remote.as_deref().is_some_and(|found| same_remote(found) == wanted))
            .map(|repo| repo.path.as_str())
    }

    /// Every checkout the last scan found: each repo's worktrees, the main one included.
    pub(crate) fn checkout_paths(&self) -> Vec<String> {
        self.repos.iter().flat_map(|repo| repo.worktrees.iter().map(|worktree| worktree.path.clone())).collect()
    }

    /// How the last scan found MCP server `name` in the checkout at `path`, when it found the checkout.
    pub(crate) fn checkout_mcp(&self, path: &str, name: &str) -> Option<CheckoutMcpState> {
        let worktree = self.repos.iter().flat_map(|repo| &repo.worktrees).find(|worktree| worktree.path == path)?;
        let has = |names: &[String]| names.iter().any(|entry| entry == name);
        Some(CheckoutMcpState {
            local: has(&worktree.mcp_local),
            disabled: has(&worktree.mcp_disabled),
            denied_shared: worktree.mcp_denied.iter().any(|entry| !entry.local && entry.name == name),
        })
    }
}

/// An MCP server in one checkout, as the last Projects scan found it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CheckoutMcpState {
    /// Set up for this checkout alone, in Claude Code's local scope.
    pub(crate) local: bool,
    /// Turned off here with /mcp.
    pub(crate) disabled: bool,
    /// Denied by the checked-in settings.json.
    pub(crate) denied_shared: bool,
}

// ---------------------------------------------------------------------------
// Where each machine's checkouts are
// ---------------------------------------------------------------------------

/// The checkouts sessions ran in on one machine.
#[derive(Debug, Default, PartialEq)]
pub(super) struct Checkouts {
    /// Main checkouts, the most recently used first.
    pub(super) repos: Vec<String>,
    /// The last request of any session in each checkout, main or linked.
    pub(super) used: HashMap<String, i64>,
}

pub(super) fn load_checkouts(connection: &Connection, machine: &str) -> Result<Checkouts, String> {
    let mut statement = connection
        .prepare(
            "SELECT repo_root, main_repo, MAX(last_ms) FROM (
                SELECT t.repo_root, t.main_repo,
                    (SELECT MAX(e.timestamp_ms) FROM usage_events e WHERE e.session_id = t.session_id) AS last_ms
                FROM usage_session_transcripts t WHERE t.machine = ?1 AND t.repo_root <> ''
            ) GROUP BY repo_root, main_repo",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![machine], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i64>>(2)?)))
        .map_err(|error| error.to_string())?;
    let mut used: HashMap<String, i64> = HashMap::new();
    let mut mains: HashMap<String, Option<i64>> = HashMap::new();
    for row in rows {
        let (root, main, last) = row.map_err(|error| error.to_string())?;
        let main = if main.is_empty() { root.clone() } else { main };
        if !is_path(&main) {
            continue;
        }
        if let Some(last) = last {
            for path in [&root, &main] {
                let entry = used.entry(path.clone()).or_insert(last);
                *entry = (*entry).max(last);
            }
        }
        let entry = mains.entry(main).or_insert(last);
        *entry = (*entry).max(last);
    }
    let mut repos: Vec<(String, Option<i64>)> = mains.into_iter().collect();
    repos.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    repos.truncate(MOST_REPOS);
    Ok(Checkouts { repos: repos.into_iter().map(|(path, _)| path).collect(), used })
}

/// An absolute path that fits on one line of a script.
pub(super) fn is_path(path: &str) -> bool {
    path.starts_with('/') && path.len() <= PATH_CHARS && !path.chars().any(char::is_control)
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

// Helpers the scan and removal share.
pub(super) const CHECKS: &str = r##"cwds() {
  if [ -d /proc/self ]; then
    for p in /proc/[0-9]*; do readlink "$p/cwd" 2>/dev/null; done
  elif command -v lsof >/dev/null 2>&1; then
    lsof -a -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'
  fi
  return 0
}
# Whether a process runs in $A or $B (the same folder with links resolved), or under it.
open_in() {
  awk 'BEGIN { a = ENVIRON["A"]; b = ENVIRON["B"] }
    $0 == a || $0 == b || index($0, a "/") == 1 || index($0, b "/") == 1 { found = 1 }
    END { exit !found }' "$work/cwds"
}
# When git last wrote the index or HEAD in the git folder $1, in seconds.
touched() {
  [ -n "$1" ] || return 0
  for f in "$1/index" "$1/HEAD"; do [ -f "$f" ] && date -r "$f" +%s 2>/dev/null; done | sort -n | tail -n 1
}
# How many files in worktree $1 git is told not to check for changes (assume-unchanged, or
# skip-worktree outside a sparse checkout), since `git status` can't see edits to them.
hidden_in() {
  sparse=$(git -C "$1" config --bool core.sparseCheckout 2>/dev/null || true)
  git -C "$1" ls-files -v 2>/dev/null | awk -v sparse="$sparse" '{ t = substr($0, 1, 1) } t ~ /[a-z]/ || (t == "S" && sparse != "true") { n++ } END { print n + 0 }'
}
# 1 when another git checkout is inside worktree $1, which would go with it.
nested_in() {
  (cd "$1" 2>/dev/null && find . \( -path ./.git -o -name node_modules \) -prune -o -name .git -print 2>/dev/null) | head -n 1 | awk 'END { print (NR ? 1 : 0) }'
}
# 1 when a rebase, merge, cherry-pick, revert or bisect is under way in the git folder $1.
midway() {
  for x in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
    if [ -e "$1/$x" ]; then echo 1; return 0; fi
  done
  echo 0
}
# How many commits worktree $1's own history of HEAD holds that no branch, tag or remote has.
# That history goes with the worktree.
unreachable_in() {
  hashes=$(git -C "$1" log -g --format=%H -n 100 HEAD 2>/dev/null | sort -u | tr '\n' ' ')
  if [ -z "$hashes" ]; then echo 0; return 0; fi
  git -C "$1" rev-list $hashes --not --all 2>/dev/null | awk 'END { print NR }'
}
"##;

// The file $2 in checkout $1 with links followed, when it's a regular file inside the checkout.
pub(super) const INSIDE_REPO: &str = r##"inside_repo() {
  top=$(cd "$1" 2>/dev/null && pwd -P) || return 1
  f="$1/$2"; hops=0
  while [ -L "$f" ]; do
    hops=$((hops + 1)); [ "$hops" -le 8 ] || return 1
    t=$(readlink "$f") || return 1
    case "$t" in /*) f=$t ;; *) f="$(dirname "$f")/$t" ;; esac
  done
  [ -f "$f" ] || return 1
  d=$(cd "$(dirname "$f")" 2>/dev/null && pwd -P) || return 1
  case "$d/" in "$top"/*) printf '%s/%s\n' "$d" "$(basename "$f")" ;; *) return 1 ;; esac
}
"##;

// The origin of checkout $1 without the user name, password or query in its address.
pub(super) const ORIGIN_URL: &str = r##"origin_url() {
  git -C "$1" config --get remote.origin.url 2>/dev/null | head -n 1 | sed -e 's#^\([A-Za-z][A-Za-z0-9+.-]*://\)[^/]*@#\1#' -e 's#^[^@/:]*@\([^:/]*:\)#\1#' -e 's|[?#].*$||' || true
}
"##;

pub(super) const GIT_ENV: &str = r##"set -u
export LC_ALL=C GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY 2>/dev/null
command -v git >/dev/null 2>&1 || { echo "git isn't installed on this machine" >&2; exit 3; }
cd / || exit 3
renice -n 10 $$ >/dev/null 2>&1
tab=$(printf '\t')
work=$(mktemp -d "${TMPDIR:-/tmp}/arbor-projects.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT
"##;

// Follows GIT_ENV, CHECKS, INSIDE_REPO, `fetch` and `budget`, and the repos in a heredoc Rust puts
// between the halves. Each repo, and each worktree in it, is looked at with stdin closed, so nothing
// can read the list. Lines out, tab-separated:
//   H home                          the machine's home folder
//   R path state                    a repo: ok, missing or notgit
//   O url                           its origin, without user name, password or query
//   E                               the fetch Arbor asked for failed
//   D ref                           the branch merges are checked against
//   F seconds                       when it was last fetched
//   B ref upstream track            each branch, its upstream and how far apart they are
//   T path head branch flags main   a worktree; "-" where there's nothing
//   S changed untracked merged committed touched open hidden nested midway unreachable real
//                                   the worktree before it
//   I entry                         an ignored file or folder in it
//   J count                         how many more there are
//   C name sum size                 an instruction file at the top of the checkout
//   P file                          Claude Code settings in the worktree before it, in base64 on the
//                                   lines up to a "." line: only its enabledPlugins is kept
//   Q                               the scan ran out of time here
// Then each place the setup repo wants one of its projects (setup_layers), from a second heredoc:
//   K path kind link real           kind: missing, broken (a link to nothing), file, empty, other or
//                                   checkout; link is where a link leads, real the folder with links followed
//   KO url                          a checkout's origin
//   KE                              the fetch Arbor asked for failed
//   KS branch changed untracked upstream track default fetched worktrees
//                                   a checkout's branch and status, its upstream and how far apart they
//                                   are, the remote's default branch, when it was last fetched, and how
//                                   many linked worktrees it has
const SCAN_HEAD: &str = r##"cat > "$work/repos" <<'ARBOR_REPOS'
"##;

const SCAN_BODY: &str = r##"ARBOR_REPOS
cwds > "$work/cwds"
printf 'H\t%s\n' "$HOME"
# Fetches origin into $1 when Arbor asked, printing $2 when that fails.
fetch_origin() {
  [ "$fetch" = 1 ] || return 0
  if [ -z "$(git -C "$1" config --get core.sshCommand 2>/dev/null || true)" ]; then
    GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2'
    export GIT_SSH_COMMAND
  else
    unset GIT_SSH_COMMAND
  fi
  # Nothing may ask for a password: a fetch that needs one fails instead.
  GCM_INTERACTIVE=never GIT_ASKPASS=false SSH_ASKPASS_REQUIRE=never \
    git -C "$1" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 -c gc.auto=0 -c maintenance.auto=false \
    fetch --quiet --prune --no-tags --no-recurse-submodules origin >/dev/null 2>&1 || printf '%s\n' "$2"
}
scan_repo() {
  if [ ! -d "$repo" ]; then printf 'R\t%s\tmissing\n' "$repo"; return 0; fi
  real=$(cd "$repo" 2>/dev/null && pwd -P || true)
  bare=$(git -C "$repo" rev-parse --is-bare-repository 2>/dev/null || true)
  if [ "$bare" = true ]; then
    top=$(git -C "$repo" rev-parse --absolute-git-dir 2>/dev/null || true)
  else
    top=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null || true)
  fi
  if [ -z "$top" ] || { [ "$top" != "$repo" ] && [ "$top" != "$real" ]; }; then printf 'R\t%s\tnotgit\n' "$repo"; return 0; fi
  printf 'R\t%s\tok\n' "$repo"
  url=$(origin_url "$repo")
  if [ -n "$url" ]; then
    printf 'O\t%s\n' "$url"
    fetch_origin "$repo" E
  fi
  def=$(git -C "$repo" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)
  if [ -z "$def" ]; then
    for ref in refs/remotes/origin/main refs/remotes/origin/master refs/heads/main refs/heads/master; do
      if git -C "$repo" show-ref --verify --quiet "$ref"; then def=$ref; break; fi
    done
  fi
  [ -n "$def" ] && printf 'D\t%s\n' "$def"
  common=$(git -C "$repo" rev-parse --git-common-dir 2>/dev/null || true)
  case "$common" in /*) ;; ?*) common="$repo/$common" ;; esac
  if [ -n "$common" ] && [ -f "$common/FETCH_HEAD" ]; then
    at=$(date -r "$common/FETCH_HEAD" +%s 2>/dev/null || true)
    [ -n "$at" ] && printf 'F\t%s\n' "$at"
  fi
  git -C "$repo" for-each-ref --format='B%09%(refname)%09%(upstream:short)%09%(upstream:track)' refs/heads 2>/dev/null
  git -C "$repo" worktree list --porcelain 2>/dev/null | awk '
    function out() {
      if (path != "") printf "%s\t%s\t%s\t%s\n", path, (head == "" ? "-" : head), (branch == "" ? "-" : branch), (flags == "" ? "-" : flags)
      path = ""; head = ""; branch = ""; flags = ""
    }
    /^worktree / { out(); path = substr($0, 10); next }
    /^HEAD / { head = substr($0, 6); next }
    /^branch / { branch = substr($0, 8); sub(/^refs\/heads\//, "", branch); next }
    /^bare$/ { flags = flags "bare,"; next }
    /^detached$/ { flags = flags "detached,"; next }
    /^locked/ { flags = flags "locked,"; next }
    /^prunable/ { flags = flags "prunable,"; next }
    END { out() }' > "$work/wts"
  main=1
  while IFS="$tab" read -r wt head branch flags <&4; do
    scan_worktree
  done 4< "$work/wts"
  if [ "$bare" != true ]; then
    for name in .claude/CLAUDE.md CLAUDE.md AGENTS.md; do
      if found=$(inside_repo "$repo" "$name"); then
        printf 'C\t%s\t%s\n' "$name" "$(cksum < "$found" | awk '{ printf "%s\t%s", $1, $2 }')"
      fi
    done
  fi
}
scan_worktree() {
  printf 'T\t%s\t%s\t%s\t%s\t%s\n' "$wt" "$head" "$branch" "$flags" "$main"
  this=$main; main=0
  case "$flags" in *bare,*|*prunable,*) return 0 ;; esac
  [ -d "$wt" ] || return 0
  if git -C "$wt" status --porcelain --untracked-files=normal --ignore-submodules=none > "$work/st" 2>/dev/null; then
    counts=$(awk '/^\?\? / { u++; next } { c++ } END { printf "%d\t%d", c, u }' "$work/st")
  else
    counts="-$tab-"
  fi
  merged=0
  if [ -n "$def" ] && [ "$head" != "-" ] && git -C "$repo" merge-base --is-ancestor "$head" "$def" 2>/dev/null; then merged=1; fi
  committed=-
  [ "$head" != "-" ] && committed=$(git -C "$repo" show -s --format=%ct "$head" 2>/dev/null || echo -)
  gitdir=$(git -C "$wt" rev-parse --absolute-git-dir 2>/dev/null || true)
  t=$(touched "$gitdir")
  wreal=$(cd "$wt" 2>/dev/null && pwd -P || true)
  open=0; hidden=0; nested=0; mid=0; lost=0
  if [ "$this" = 0 ]; then
    if A="$wt" B="$wreal" open_in; then open=1; fi
    hidden=$(hidden_in "$wt")
    nested=$(nested_in "$wt")
    lost=$(unreachable_in "$wt")
    [ -n "$gitdir" ] && mid=$(midway "$gitdir")
  fi
  printf 'S\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$counts" "$merged" "${committed:--}" "${t:--}" "$open" "$hidden" "$nested" "$mid" "$lost" "${wreal:--}"
  for name in .claude/settings.local.json .claude/settings.json; do
    if found=$(inside_repo "$wt" "$name") && [ "$(wc -c < "$found" | tr -d ' ')" -le 262144 ]; then
      printf 'P\t%s\n' "$name"; base64 < "$found"; printf '.\n'
    fi
  done
  # No local settings yet, and Git wouldn't ignore one: Arbor won't create it there.
  if [ ! -e "$wt/.claude/settings.local.json" ] && [ ! -L "$wt/.claude/settings.local.json" ] && ! git -C "$wt" check-ignore -q .claude/settings.local.json 2>/dev/null; then
    printf 'G\n'
  fi
  # The project instruction files Arbor writes: missing (and whether Git ignores one), Arbor's by its first line, or
  # someone's own. Then the checkout's AGENTS.md fingerprint and whether it has a CLAUDE.md.
  for f in CLAUDE.local.md AGENTS.override.md; do
    if [ -L "$wt/$f" ]; then printf 'L\t%s\town\n' "$f"
    elif [ -f "$wt/$f" ]; then
      first=$(head -n 1 "$wt/$f" 2>/dev/null | tr -d '\t\r' | cut -c 1-300)
      case "$first" in
        "<!-- arbor: "*) printf 'L\t%s\tarbor\t%s\n' "$f" "$first" ;;
        *) printf 'L\t%s\town\n' "$f" ;;
      esac
    elif [ -e "$wt/$f" ]; then printf 'L\t%s\town\n' "$f"
    elif git -C "$wt" check-ignore -q "$f" 2>/dev/null; then printf 'L\t%s\tnone\n' "$f"
    else printf 'L\t%s\tseen\n' "$f"; fi
  done
  agents=-
  if [ -f "$wt/AGENTS.md" ]; then agents=$(cksum < "$wt/AGENTS.md" 2>/dev/null | awk '{ printf "c%s-%s", $1, $2 }'); fi
  claude=0
  if [ -e "$wt/CLAUDE.md" ] || [ -e "$wt/.claude/CLAUDE.md" ]; then claude=1; fi
  # The project skill folders Arbor wrote here (project_skills), each with its fingerprint; `!` marks one left
  # alone as the project's own.
  if [ -n "$gitdir" ] && [ -f "$gitdir/arbor-skills" ]; then
    while IFS= read -r rel; do
      case "$rel" in ''|*"$tab"*) continue ;; '!'*) printf 'Y\t%s\t-\n' "$rel" ;; *) printf 'Y\t%s\t%s\n' "$rel" "$(folder_print "$wt/$rel")" ;; esac
    done < "$gitdir/arbor-skills"
  fi
  printf 'W\t%s\t%s\n' "${agents:--}" "$claude"
  if [ "$this" = 0 ]; then
    git -C "$wt" ls-files --others --ignored --exclude-standard --directory > "$work/ign" 2>/dev/null || : > "$work/ign"
    n=$(awk 'END { print NR }' "$work/ign")
    head -n 20 "$work/ign" | while IFS= read -r entry; do printf 'I\t%s\n' "$entry"; done
    [ "$n" -gt 20 ] && printf 'J\t%s\n' $((n - 20))
  fi
  return 0
}
# Of Claude Code's .claude.json, for each project path only the names of its own MCP servers and of
# those turned off there with /mcp, read out on the machine: M path local|off name.
cj="$HOME/.claude.json"
[ -f "$HOME/.claude/.claude.json" ] && cj="$HOME/.claude/.claude.json"
if [ -f "$cj" ] && [ ! -L "$cj" ]; then
  awk '
    function put(kind, name) { if (path != "" && name != "" && name !~ /\t/) printf "M\t%s\t%s\t%s\n", path, kind, name }
    { n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (instr) {
          if (esc) { esc = 0; s = s c; continue }
          if (c == "\\") { esc = 1; odd = 1; continue }
          if (c == "\"") {
            instr = 0; last = s; lastodd = odd; have = 1
            if (depth == 4 && type[4] == "[" && key[1] == "projects" && key[3] == "disabledMcpServers" && !odd) put("off", s)
            continue
          }
          s = s c; continue
        }
        if (c == "\"") { instr = 1; s = ""; odd = 0; continue }
        if (c == ":") {
          if (have) {
            key[depth] = last
            if (depth == 2 && key[1] == "projects") path = lastodd ? "" : last
            if (depth == 4 && key[1] == "projects" && key[3] == "mcpServers" && !lastodd) put("local", last)
          }
          have = 0; continue
        }
        if (c == "{" || c == "[") { depth++; type[depth] = c; key[depth] = ""; have = 0; continue }
        if (c == "}" || c == "]" || c == ",") { if (c != ",") depth--; have = 0; continue }
      }
    }' "$cj" 2>/dev/null || :
fi
start=$(date +%s)
while IFS= read -r repo <&3; do
  [ -n "$repo" ] || continue
  if [ $(( $(date +%s) - start )) -ge "$budget" ]; then printf 'Q\n'; break; fi
  scan_repo </dev/null
done 3< "$work/repos"
"##;

// Follows SCAN_BODY, with the places in a heredoc Rust puts before it, ending ARBOR_PLACES.
const PLACES_BODY: &str = r##"ARBOR_PLACES
scan_place() {
  case "$p" in "~") at=$HOME ;; "~/"*) at="$HOME/${p#\~/}" ;; *) at=$p ;; esac
  link=-
  [ -L "$at" ] && link=$(readlink "$at" 2>/dev/null | tr -d '\t' || true)
  if [ ! -e "$at" ]; then
    if [ -L "$at" ]; then printf 'K\t%s\tbroken\t%s\t-\n' "$p" "${link:--}"; else printf 'K\t%s\tmissing\t-\t-\n' "$p"; fi
    return 0
  fi
  if [ ! -d "$at" ]; then printf 'K\t%s\tfile\t%s\t-\n' "$p" "${link:--}"; return 0; fi
  real=$(cd "$at" 2>/dev/null && pwd -P || true)
  top=$(git -C "$at" rev-parse --show-toplevel 2>/dev/null || true)
  if [ -z "$top" ] || [ "$top" != "$real" ]; then
    kind=other
    [ -z "$(ls -A "$at" 2>/dev/null | head -n 1)" ] && kind=empty
    printf 'K\t%s\t%s\t%s\t%s\n' "$p" "$kind" "${link:--}" "${real:--}"
    return 0
  fi
  printf 'K\t%s\tcheckout\t%s\t%s\n' "$p" "${link:--}" "$real"
  url=$(origin_url "$at")
  if [ -n "$url" ]; then
    printf 'KO\t%s\n' "$url"
    # A checkout the repos above have fetched already isn't fetched twice.
    grep -Fqx "$real" "$work/repos" 2>/dev/null || fetch_origin "$at" KE
  fi
  branch=$(git -C "$at" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
  if git -C "$at" status --porcelain --untracked-files=normal > "$work/pst" 2>/dev/null; then
    counts=$(awk '/^\?\? / { u++; next } { c++ } END { printf "%d\t%d", c, u }' "$work/pst")
  else
    counts="-$tab-"
  fi
  track="-$tab-"
  if [ -n "$branch" ]; then
    track=$(git -C "$at" for-each-ref --format='%(upstream:short)%09%(upstream:track)' "refs/heads/$branch" 2>/dev/null | head -n 1)
    case "$track" in *"$tab"*) ;; *) track="-$tab-" ;; esac
    # A checkout with no remote is kept in step through Arbor's hub, whose branches it has as arbor/<branch>.
    up=${track%%"$tab"*}
    if [ -z "$url" ] && { [ -z "$up" ] || [ "$up" = - ]; }; then
      if lr=$(git -C "$at" rev-list --left-right --count "refs/heads/$branch...refs/remotes/arbor/$branch" 2>/dev/null); then
        set -- $lr
        track="arbor/$branch$tab[ahead $1, behind $2]"
      fi
    fi
  fi
  def=$(git -C "$at" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
  common=$(git -C "$at" rev-parse --git-common-dir 2>/dev/null || true)
  case "$common" in /*) ;; ?*) common="$at/$common" ;; esac
  at_s=-
  if [ -n "$common" ] && [ -f "$common/FETCH_HEAD" ]; then at_s=$(date -r "$common/FETCH_HEAD" +%s 2>/dev/null || echo -); fi
  # The first entry is the checkout itself; the rest are its linked worktrees.
  wts=$(git -C "$at" worktree list --porcelain 2>/dev/null | grep -c '^worktree ' || true)
  [ "${wts:-0}" -gt 0 ] 2>/dev/null && wts=$((wts - 1)) || wts=0
  printf 'KS\t%s\t%s\t%s\t%s\t%s\t%s\n' "${branch:--}" "$counts" "$track" "${def:--}" "$at_s" "$wts"
}
# The places run even when the repos above used up the time: they're few, and what Sync › Projects shows.
while IFS= read -r p <&3; do
  [ -n "$p" ] || continue
  scan_place </dev/null
done 3< "$work/places"
"##;

// A skill folder's fingerprint as setup_skills' `place` gives one (after HELPERS), or - for none.
pub(super) const FOLDER_PRINT: &str = r##"folder_print() {
  if [ -d "$1" ] && [ ! -L "$1" ] && [ -f "$1/SKILL.md" ]; then
    l=$(dir_listing "$1"); if [ -n "$l" ]; then printf D; printf '%s\n' "$l" | sum_in; return 0; fi
  fi
  printf -
}
"##;

fn scan_script(repos: &[String], places: &[String], fetch: bool) -> String {
    let budget = if fetch { FETCH_BUDGET_S } else { SCAN_BUDGET_S };
    let mut script = format!("{GIT_ENV}{CHECKS}{INSIDE_REPO}{ORIGIN_URL}{HELPERS}{FOLDER_PRINT}fetch={}\nbudget={budget}\n{SCAN_HEAD}", u8::from(fetch));
    for repo in repos.iter().filter(|repo| is_path(repo)) {
        script.push_str(repo);
        script.push('\n');
    }
    script.push_str(SCAN_BODY);
    script.push_str("cat > \"$work/places\" <<'ARBOR_PLACES'\n");
    for place in places.iter().filter(|place| super::setup_layers::is_layer_path(place) && !place.contains('\n')) {
        script.push_str(place);
        script.push('\n');
    }
    script.push_str(PLACES_BODY);
    script
}

/// `host/owner/name` for a remote's address: no scheme, user, port, query or `.git`. A folder
/// on the machine stays a path.
pub(super) fn normalize_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let url = url.split(['?', '#']).next().unwrap_or_default();
    if url.is_empty() || url.chars().any(char::is_control) {
        return None;
    }
    let trim = |path: &str| {
        let path = path.trim_matches('/');
        path.strip_suffix(".git").unwrap_or(path).trim_end_matches('/').to_string()
    };
    if url.starts_with('/') || url.starts_with('.') || url.starts_with('~') {
        return Some(trim(url)).filter(|path| !path.is_empty()).map(|path| if url.starts_with('/') { format!("/{path}") } else { path });
    }
    let (host, path) = match url.split_once("://") {
        Some((scheme, rest)) => {
            if scheme.eq_ignore_ascii_case("file") {
                return Some(format!("/{}", trim(rest)));
            }
            let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
            let host = authority.rsplit('@').next().unwrap_or(authority);
            let host = host.split(':').next().unwrap_or(host);
            (host, path)
        }
        None => {
            let (authority, path) = url.split_once(':')?;
            (authority.rsplit('@').next().unwrap_or(authority), path)
        }
    };
    let path = trim(path);
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("{host}/{path}").to_lowercase())
}

/// Ahead and behind counts, and whether the upstream is gone, from `%(upstream:track)`.
fn parse_track(track: &str) -> (u32, u32, bool) {
    let track = track.trim().trim_start_matches('[').trim_end_matches(']');
    let mut ahead = 0;
    let mut behind = 0;
    for part in track.split(',').map(str::trim) {
        if let Some(count) = part.strip_prefix("ahead ") {
            ahead = count.trim().parse().unwrap_or(0);
        } else if let Some(count) = part.strip_prefix("behind ") {
            behind = count.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind, track == "gone")
}

fn field(value: &str) -> Option<&str> {
    Some(value.trim()).filter(|value| !value.is_empty() && *value != "-")
}

fn seconds(value: &str) -> Option<i64> {
    field(value).and_then(|value| value.parse::<i64>().ok()).filter(|at| *at > 0).map(|at| at * 1000)
}

/// What a scan found: the machine's home folder, its repos, and whether it stopped early.
#[derive(Debug, Default, PartialEq)]
struct Scanned {
    home_dir: String,
    repos: Vec<ProjectRepo>,
    places: Vec<FoundPlace>,
    partial: bool,
}

fn parse_scan(stdout: &str, used: &HashMap<String, i64>, now_ms: i64) -> Scanned {
    let mut scanned = Scanned::default();
    // S, I and J lines belong to the worktree just read, and to nothing when its line was unreadable.
    let mut attach = false;
    let mut tracking: HashMap<String, (String, String)> = HashMap::new();
    let finish = |repo: &mut ProjectRepo, tracking: &mut HashMap<String, (String, String)>| {
        for worktree in &mut repo.worktrees {
            if let Some((upstream, track)) = worktree.branch.as_ref().and_then(|branch| tracking.get(branch)) {
                if !upstream.is_empty() {
                    let (ahead, behind, gone) = parse_track(track);
                    worktree.upstream = Some(upstream.clone());
                    worktree.gone = gone;
                    if !gone {
                        worktree.ahead = Some(ahead);
                        worktree.behind = Some(behind);
                    }
                }
            }
            let real = worktree.real.as_ref().and_then(|real| used.get(real));
            worktree.last_used_ms = used.get(&worktree.path).or(real).copied();
        }
        tracking.clear();
    };
    // The settings file being read, as (local, its base64 so far).
    let mut settings: Option<(bool, String)> = None;
    // Each project path's own MCP servers and ones turned off there, from .claude.json; only checkouts' are kept.
    let mut mcp_here: HashMap<String, (Vec<String>, Vec<String>)> = HashMap::new();
    for line in stdout.lines() {
        if let Some((local, text)) = settings.as_mut() {
            if line != "." {
                text.push_str(line.trim());
                continue;
            }
            let (plugins, skills, denied) = checkout_settings(text, *local);
            let local = *local;
            settings = None;
            if let Some(worktree) = scanned.repos.last_mut().and_then(|repo| repo.worktrees.last_mut()).filter(|_| attach) {
                worktree.plugins.extend(plugins);
                worktree.mcp_denied.extend(denied.into_iter().map(|name| CheckoutMcpDeny { name, local }));
                match skills {
                    Some(skills) => worktree.skills.extend(skills.into_iter().map(|(name, state)| CheckoutSkill { name, state, local })),
                    None => worktree.ignored_overrides.push(if local { "settings.local.json" } else { "settings.json" }.to_string()),
                }
            }
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        let repo = scanned.repos.last_mut();
        match (fields.as_slice(), repo) {
            (["H", home], _) => scanned.home_dir = home.to_string(),
            (["M", path, kind, name], _) => {
                if name.len() <= NAME_CHARS && !name.chars().any(char::is_control) {
                    let entry = mcp_here.entry(path.to_string()).or_default();
                    match *kind {
                        "local" => entry.0.push(name.to_string()),
                        "off" => entry.1.push(name.to_string()),
                        _ => {}
                    }
                }
            }
            (["Q"], _) => scanned.partial = true,
            (["K", path, kind, link, real], _) => {
                let kind = match *kind {
                    "broken" => PlaceKind::Broken,
                    "file" => PlaceKind::File,
                    "empty" => PlaceKind::Empty,
                    "other" => PlaceKind::Other,
                    "checkout" => PlaceKind::Checkout,
                    _ => PlaceKind::Missing,
                };
                scanned.places.push(FoundPlace { path: path.to_string(), kind, link: field(link).map(str::to_string), real: field(real).map(str::to_string), ..FoundPlace::default() });
            }
            (["KO", url], _) => {
                if let Some(place) = scanned.places.last_mut() {
                    place.remote = normalize_remote(url);
                }
            }
            (["KE"], _) => {
                if let Some(place) = scanned.places.last_mut() {
                    place.status.fetch_failed = true;
                }
            }
            (["KS", branch, changed, untracked, upstream, track, default, fetched, worktrees], _) => {
                if let Some(place) = scanned.places.last_mut() {
                    let status = &mut place.status;
                    status.branch = field(branch).map(str::to_string);
                    status.changed = field(changed).and_then(|count| count.parse().ok());
                    status.untracked = field(untracked).and_then(|count| count.parse().ok());
                    status.upstream = field(upstream).map(str::to_string);
                    if status.upstream.is_some() {
                        let (ahead, behind, gone) = parse_track(track);
                        if !gone {
                            status.ahead = Some(ahead);
                            status.behind = Some(behind);
                        }
                    }
                    status.default_branch = field(default).map(str::to_string);
                    status.fetched_at = seconds(fetched);
                    status.worktrees = worktrees.trim().parse().unwrap_or(0);
                }
            }
            (["R", path, state], last) => {
                attach = false;
                if let Some(last) = last {
                    finish(last, &mut tracking);
                }
                let state = match *state {
                    "ok" => RepoState::Ok,
                    "missing" => RepoState::Missing,
                    _ => RepoState::NotGit,
                };
                scanned.repos.push(ProjectRepo { path: path.to_string(), state, last_used_ms: used.get(*path).copied(), ..ProjectRepo::default() });
            }
            (["O", url], Some(repo)) => repo.remote = normalize_remote(url),
            (["E"], Some(repo)) => repo.fetch_failed = true,
            (["D", reference], Some(repo)) => {
                let short = reference.strip_prefix("refs/remotes/").or_else(|| reference.strip_prefix("refs/heads/"));
                repo.default_branch = short.filter(|short| !short.is_empty()).map(str::to_string);
            }
            (["F", at], Some(repo)) => repo.fetched_at = seconds(at),
            (["B", reference, upstream, track], Some(_)) => {
                if let Some(branch) = reference.strip_prefix("refs/heads/") {
                    tracking.insert(branch.to_string(), (upstream.to_string(), track.to_string()));
                }
            }
            (["T", path, head, branch, flags, main], Some(repo)) => {
                let flags: Vec<&str> = flags.split(',').collect();
                attach = false;
                if flags.contains(&"bare") {
                    repo.bare = true;
                    continue;
                }
                attach = true;
                repo.worktrees.push(ProjectWorktree {
                    path: path.to_string(),
                    main: *main == "1",
                    head: field(head).map(str::to_string),
                    branch: field(branch).map(str::to_string),
                    locked: flags.contains(&"locked"),
                    prunable: flags.contains(&"prunable"),
                    ..ProjectWorktree::default()
                });
            }
            (["T", ..], _) => attach = false,
            (["S", changed, untracked, merged, committed, touched, open, hidden, nested, midway, unreachable, real], Some(repo)) if attach => {
                if let Some(worktree) = repo.worktrees.last_mut() {
                    worktree.changed = field(changed).and_then(|count| count.parse().ok());
                    worktree.untracked = field(untracked).and_then(|count| count.parse().ok());
                    worktree.merged = *merged == "1";
                    worktree.committed_at = seconds(committed);
                    worktree.touched_at = seconds(touched);
                    worktree.open = *open == "1";
                    // A count that didn't come back is taken as the worst.
                    worktree.hidden = hidden.trim().parse().unwrap_or(1);
                    worktree.nested = *nested != "0";
                    worktree.midway = *midway != "0";
                    worktree.unreachable = unreachable.trim().parse().unwrap_or(1);
                    worktree.real = field(real).map(str::to_string);
                }
            }
            (["Y", rel, print], Some(repo)) if attach => {
                if let Some(worktree) = repo.worktrees.last_mut() {
                    if rel.len() <= 300 && worktree.arbor_skills.len() < 200 {
                        worktree.arbor_skills.push((rel.to_string(), print.to_string()));
                    }
                }
            }
            (["I", entry], Some(repo)) if attach => {
                if let Some(worktree) = repo.worktrees.last_mut() {
                    if worktree.ignored.len() < IGNORED_SHOWN && !entry.is_empty() {
                        worktree.ignored.push(entry.chars().take(NAME_CHARS).collect());
                    }
                }
            }
            (["J", more], Some(repo)) if attach => {
                if let Some(worktree) = repo.worktrees.last_mut() {
                    worktree.ignored_more = more.trim().parse().unwrap_or(0);
                }
            }
            (["P", name], _) => settings = Some((*name == ".claude/settings.local.json", String::new())),
            (["L", file, state, rest @ ..], Some(repo)) if attach && rest.len() <= 1 => {
                let file = match *file {
                    "CLAUDE.local.md" => InstructionFile::ClaudeLocal,
                    "AGENTS.override.md" => InstructionFile::AgentsOverride,
                    _ => continue,
                };
                let state = match *state {
                    "none" => LocalFileState::None,
                    "seen" => LocalFileState::Seen,
                    "arbor" => LocalFileState::Arbor,
                    _ => LocalFileState::Own,
                };
                let first = rest.first().copied().unwrap_or_default();
                let arbor = state == LocalFileState::Arbor;
                if let Some(worktree) = repo.worktrees.last_mut() {
                    worktree.instructions.push(CheckoutInstructions {
                        file,
                        state,
                        text: marker_field(first, "text").filter(|_| arbor).map(str::to_string),
                        import: marker_field(first, "import").filter(|_| arbor).map(|value| value == "1"),
                        agents: marker_field(first, "agents").filter(|_| arbor).map(str::to_string),
                    });
                }
            }
            (["W", agents, claude], Some(repo)) if attach => {
                if let Some(worktree) = repo.worktrees.last_mut() {
                    worktree.agents_md = field(agents).filter(|sum| sum.starts_with('c') && sum.len() <= 40).map(str::to_string);
                    worktree.claude_md = *claude == "1";
                }
            }
            (["G"], Some(repo)) if attach => {
                if let Some(worktree) = repo.worktrees.last_mut() {
                    worktree.local_seen = true;
                }
            }
            (["C", name, sum, size], Some(repo)) => {
                if INSTRUCTION_FILES.contains(name) && !repo.files.iter().any(|file| file.name == *name) {
                    repo.files.push(ProjectFile { name: name.to_string(), sum: sum.to_string(), size: size.trim().parse().unwrap_or(0) });
                }
            }
            _ => {}
        }
    }
    if let Some(last) = scanned.repos.last_mut() {
        finish(last, &mut tracking);
    }
    for worktree in scanned.repos.iter_mut().flat_map(|repo| repo.worktrees.iter_mut()) {
        // Claude Code keys a project by the folder it started in, which may be the path with links resolved.
        let found = mcp_here.get(&worktree.path).or_else(|| worktree.real.as_ref().and_then(|real| mcp_here.get(real)));
        if let Some((local, off)) = found {
            worktree.mcp_local = local.clone();
            worktree.mcp_disabled = off.clone();
        }
    }
    let blockers: Vec<Vec<Option<Blocker>>> = scanned
        .repos
        .iter()
        .map(|repo| {
            repo.worktrees
                .iter()
                .map(|worktree| blocker(repo.state, repo.default_branch.as_deref(), worktree, nested_in(&scanned.repos, &worktree.path), now_ms))
                .collect()
        })
        .collect();
    for (repo, blockers) in scanned.repos.iter_mut().zip(blockers) {
        for (worktree, blocker) in repo.worktrees.iter_mut().zip(blockers) {
            worktree.blocker = blocker;
        }
    }
    scanned
}

/// The plugins a checkout's settings file turns on or off and its skill overrides (None when Claude Code ignores
/// them), from its base64, and nothing else of it.
fn checkout_settings(base64: &str, local: bool) -> (Vec<CheckoutPlugin>, Option<Vec<(String, OverrideState)>>, Vec<String>) {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let Some(Value::Object(root)) = STANDARD.decode(base64).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()) else {
        return (Vec::new(), Some(Vec::new()), Vec::new());
    };
    let plugins = match root.get("enabledPlugins") {
        Some(Value::Object(enabled)) => enabled
            .iter()
            .filter(|(id, _)| id.len() <= NAME_CHARS && id.contains('@') && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_.@".contains(&byte)))
            .filter_map(|(id, on)| Some(CheckoutPlugin { id: id.clone(), on: on.as_bool()?, local }))
            .collect(),
        _ => Vec::new(),
    };
    let skills = match root.get("skillOverrides") {
        Some(value) => parse_overrides(value).map(|overrides| overrides.into_iter().filter(|(name, _)| name.len() <= NAME_CHARS).collect()),
        None => Some(Vec::new()),
    };
    let denied = root.get("deniedMcpServers").map(super::setup::denied_mcp_names).unwrap_or_default().into_iter().filter(|name| name.len() <= NAME_CHARS).collect();
    (plugins, skills, denied)
}

/// Whether another checkout the scan found is inside the folder at `path`.
fn nested_in(repos: &[ProjectRepo], path: &str) -> bool {
    let inside = format!("{path}/");
    repos
        .iter()
        .flat_map(|repo| std::iter::once(repo.path.as_str()).chain(repo.worktrees.iter().map(|worktree| worktree.path.as_str())))
        .any(|other| other.starts_with(&inside))
}

/// Why a worktree can't be removed now, or None when it can.
fn blocker(state: RepoState, default: Option<&str>, worktree: &ProjectWorktree, nested: bool, now_ms: i64) -> Option<Blocker> {
    if worktree.main {
        return Some(Blocker::Main);
    }
    if worktree.prunable {
        return Some(Blocker::Missing);
    }
    if worktree.locked {
        return Some(Blocker::Locked);
    }
    if nested || worktree.nested {
        return Some(Blocker::Nested);
    }
    let (Some(changed), Some(untracked), Some(_), Some(_), RepoState::Ok) = (worktree.changed, worktree.untracked, &worktree.head, worktree.touched_at, state) else {
        return Some(Blocker::Unknown);
    };
    if changed + untracked > 0 {
        return Some(Blocker::Dirty);
    }
    if worktree.hidden > 0 {
        return Some(Blocker::Hidden);
    }
    if worktree.midway {
        return Some(Blocker::Midway);
    }
    if worktree.unreachable > 0 {
        return Some(Blocker::Unreachable);
    }
    if worktree.open {
        return Some(Blocker::Open);
    }
    if [worktree.last_used_ms, worktree.touched_at].into_iter().flatten().any(|at| at > now_ms - RECENT_MS) {
        return Some(Blocker::Recent);
    }
    let default_name = default.map(|default| default.split_once('/').map_or(default, |(_, name)| name));
    if worktree.branch.is_some() && worktree.branch.as_deref() == default_name {
        return Some(Blocker::DefaultBranch);
    }
    if !(worktree.merged || (worktree.gone && worktree.branch.is_some())) {
        return Some(Blocker::NotMerged);
    }
    None
}

/// Every machine's projects Arbor has looked at, as the page shows them.
#[tauri::command]
pub(crate) fn get_projects(state: tauri::State<'_, MachineHealthState>) -> Vec<MachineProjects> {
    state.lock().projects.values().cloned().collect()
}

#[derive(Clone, Copy, PartialEq)]
enum Work {
    Scan,
    Measure,
    Remove,
}

impl MachineProjects {
    fn busy(&self) -> bool {
        self.scanning || self.measuring || self.removing
    }
}

/// Marks a machine's projects as being scanned, measured or cleaned up, when nothing else is
/// being done to them, and hands back how to reach the machine and what its projects were.
fn claim(state: &MachineHealthState, machine: &str, work: Work) -> Result<(Machine, MachineProjects), String> {
    let mut inner = state.lock();
    let target = covered_machine(&inner, machine)?.0;
    let entry = inner.projects.entry(machine.to_string()).or_insert_with(|| MachineProjects { machine: machine.to_string(), ..MachineProjects::default() });
    if entry.busy() {
        return Err(format!("Arbor is already looking at the projects on {machine}"));
    }
    let before = entry.clone();
    match work {
        Work::Scan => entry.scanning = true,
        Work::Measure => entry.measuring = true,
        Work::Remove => entry.removing = true,
    }
    Ok((target, before))
}

fn release(app: &tauri::AppHandle, machine: &str, update: impl FnOnce(&mut MachineProjects)) -> MachineProjects {
    let state = app.state::<MachineHealthState>();
    let projects = {
        let mut inner = state.lock();
        let entry = inner.projects.entry(machine.to_string()).or_insert_with(|| MachineProjects { machine: machine.to_string(), ..MachineProjects::default() });
        entry.scanning = false;
        entry.measuring = false;
        entry.removing = false;
        update(entry);
        entry.clone()
    };
    let _ = app.emit(SETUP_PROJECTS_UPDATED_EVENT, Local::now().timestamp_millis());
    projects
}

/// Fetches the checkouts at the places the setup repo wants its projects on `machine`, and looks at them again, leaving
/// the checkouts sessions point at as the last scan found them: the background round that keeps Sync › Projects'
/// behind counts true. Nothing to do before the window has named a setup repo, or for a machine with no projects.
pub(super) async fn fetch_places(app: &tauri::AppHandle, machine: &str) -> Result<(), String> {
    let state = app.state::<MachineHealthState>();
    // After a restart the window hasn't named the repo yet; the setting it saves does.
    let saved = state.lock().setup_repo.is_none().then(|| app.state::<crate::saved_store::SavedStoreState>().value(super::setup_layers::SETUP_REPO_SETTING)).flatten().filter(|repo| !repo.is_empty());
    let places = super::setup_layers::places_on(&state, saved, machine).await;
    if places.is_empty() {
        return Ok(());
    }
    let (target, _) = claim(&state, machine, Work::Scan)?;
    let found = run_checked(&target, MachineOp::ProjectsScan, &scan_script(&[], &places, true), FETCH_TIMEOUT).await;
    let failure = found.as_ref().err().cloned();
    release(app, machine, |entry| {
        if let Ok(stdout) = found {
            entry.places = parse_scan(&stdout, &HashMap::new(), Local::now().timestamp_millis()).places;
        }
    });
    failure.map_or(Ok(()), Err)
}

/// Looks at every repo sessions have worked in on a machine, and each place the setup repo `repo` (else the last one
/// named) wants a project there, fetching each first when `fetch`.
#[tauri::command]
pub(crate) async fn scan_projects(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    fetch: Option<bool>,
    repo: Option<String>,
) -> Result<MachineProjects, String> {
    let fetch = fetch == Some(true);
    let places = super::setup_layers::places_on(&state, repo, &machine).await;
    let (target, _) = claim(&state, &machine, Work::Scan)?;
    let _ = app.emit(SETUP_PROJECTS_UPDATED_EVENT, Local::now().timestamp_millis());
    let result = async {
        let name = machine.clone();
        let checkouts = run_usage_task(move || load_checkouts(&open_usage_database()?, &name)).await?;
        let timeout = if fetch { FETCH_TIMEOUT } else { SCAN_TIMEOUT };
        let stdout = run_checked(&target, MachineOp::ProjectsScan, &scan_script(&checkouts.repos, &places, fetch), timeout).await?;
        Ok(parse_scan(&stdout, &checkouts.used, Local::now().timestamp_millis()))
    }
    .await;
    let failure = result.as_ref().err().cloned();
    let projects = release(&app, &machine, |entry| match result {
        Ok(scanned) => {
            let now_ms = Local::now().timestamp_millis();
            let sizes: HashMap<String, u64> = entry
                .repos
                .iter()
                .flat_map(|repo| &repo.worktrees)
                .filter_map(|worktree| worktree.size_kb.map(|size| (worktree.path.clone(), size)))
                .collect();
            entry.repos = scanned.repos;
            entry.places = scanned.places;
            for worktree in entry.repos.iter_mut().flat_map(|repo| &mut repo.worktrees) {
                worktree.size_kb = sizes.get(&worktree.path).copied();
            }
            entry.home_dir = scanned.home_dir;
            entry.partial = scanned.partial;
            entry.scanned_at = Some(now_ms);
            if fetch {
                entry.fetched_at = Some(now_ms);
            }
            entry.error = None;
        }
        Err(error) => entry.error = Some(error),
    });
    match failure {
        Some(error) => Err(error),
        None => Ok(projects),
    }
}

// Follows GIT_ENV and `budget`, with the folders in a heredoc Rust adds. Lines out:
//   Z path kilobytes
//   Q          ran out of time here
const MEASURE_BODY: &str = r##"start=$(date +%s)
while IFS= read -r p; do
  [ -n "$p" ] || continue
  if [ $(( $(date +%s) - start )) -ge "$budget" ]; then printf 'Q\n'; break; fi
  [ -d "$p" ] || continue
  kb=$(du -sk "$p" 2>/dev/null | tail -n 1 | awk '{ print $1 }')
  [ -n "$kb" ] && printf 'Z\t%s\t%s\n' "$p" "$kb"
done <<'ARBOR_PATHS'
"##;

fn measure_script(paths: &[String]) -> String {
    let mut script = format!("{GIT_ENV}budget={MEASURE_BUDGET_S}\n{MEASURE_BODY}");
    for path in paths.iter().filter(|path| is_path(path)) {
        script.push_str(path);
        script.push('\n');
    }
    script.push_str("ARBOR_PATHS\n");
    script
}

fn parse_sizes(stdout: &str) -> HashMap<String, u64> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            match (fields.next(), fields.next(), fields.next(), fields.next()) {
                (Some("Z"), Some(path), Some(size), None) => size.trim().parse().ok().map(|size| (path.to_string(), size)),
                _ => None,
            }
        })
        .collect()
}

/// How much disk each checkout the last scan found takes, with `du`.
#[tauri::command]
pub(crate) async fn measure_projects(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
) -> Result<MachineProjects, String> {
    if state.lock().projects.get(&machine).is_none_or(|projects| projects.scanned_at.is_none()) {
        return Err("Scan this machine's projects first".into());
    }
    let (target, projects) = claim(&state, &machine, Work::Measure)?;
    let paths: Vec<String> = projects
        .repos
        .iter()
        .flat_map(|repo| &repo.worktrees)
        .filter(|worktree| !worktree.prunable)
        .map(|worktree| worktree.path.clone())
        .collect();
    let _ = app.emit(SETUP_PROJECTS_UPDATED_EVENT, Local::now().timestamp_millis());
    let result = async {
        Ok(parse_sizes(&run_checked(&target, MachineOp::ProjectsMeasure, &measure_script(&paths), MEASURE_TIMEOUT).await?))
    }
    .await;
    let failure = result.as_ref().err().cloned();
    let projects = release(&app, &machine, |entry| match result {
        Ok(sizes) => {
            for worktree in entry.repos.iter_mut().flat_map(|repo| &mut repo.worktrees) {
                if let Some(size) = sizes.get(&worktree.path) {
                    worktree.size_kb = Some(*size);
                }
            }
            entry.measured_at = Some(Local::now().timestamp_millis());
            entry.error = None;
        }
        Err(error) => entry.error = Some(error),
    });
    match failure {
        Some(error) => Err(error),
        None => Ok(projects),
    }
}

/// The text of an instruction file at the top of a checkout the last scan found it in.
#[tauri::command]
pub(crate) async fn read_project_file(
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    repo: String,
    name: String,
) -> Result<SetupText, String> {
    let target = {
        let inner = state.lock();
        let target = covered_machine(&inner, &machine)?.0;
        let found = inner
            .projects
            .get(&machine)
            .and_then(|projects| projects.repos.iter().find(|entry| entry.path == repo))
            .is_some_and(|entry| entry.files.iter().any(|file| file.name == name));
        if !found || !INSTRUCTION_FILES.contains(&name.as_str()) {
            return Err("Arbor can only show what its last scan of this machine found. Scan again.".into());
        }
        target
    };
    // A link is followed only while it stays inside the checkout.
    let prelude = format!(
        "repo={}\nname={}\n{INSIDE_REPO}f=$(inside_repo \"$repo\" \"$name\") || {{ echo \"That file isn't inside the checkout\" >&2; exit 3; }}\n",
        shell_quote(&repo),
        shell_quote(&name)
    );
    read_text_after(&target, &prelude).await
}

// ---------------------------------------------------------------------------
// Removing worktrees
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeRemoval {
    repo: String,
    path: String,
    /// The commit the page showed, which must still be checked out.
    head: String,
}

#[derive(Debug, PartialEq)]
struct PlannedRemoval {
    main: String,
    path: String,
    head: String,
    branch: Option<String>,
    delete_branch: bool,
}

fn plan_removals(projects: &MachineProjects, removals: Vec<WorktreeRemoval>, now_ms: i64) -> Result<Vec<PlannedRemoval>, String> {
    if removals.is_empty() {
        return Err("There's nothing to remove".into());
    }
    if removals.len() > MOST_REMOVALS {
        return Err(format!("Arbor removes at most {MOST_REMOVALS} worktrees at a time"));
    }
    if projects.scanned_at.is_none_or(|at| now_ms - at > PLAN_FRESH_MS) {
        return Err("Scan this machine's projects again first".into());
    }
    let mut planned: Vec<PlannedRemoval> = Vec::new();
    for removal in removals {
        if planned.iter().any(|entry| entry.path == removal.path) {
            continue;
        }
        let repo = projects.repos.iter().find(|repo| repo.path == removal.repo).ok_or_else(|| format!("The last scan didn't find {}", removal.repo))?;
        let worktree = repo
            .worktrees
            .iter()
            .find(|worktree| worktree.path == removal.path)
            .ok_or_else(|| format!("The last scan didn't find {}", removal.path))?;
        if worktree.head.as_deref() != Some(removal.head.as_str()) {
            return Err(format!("{} has moved since the last scan. Scan again.", removal.path));
        }
        if let Some(reason) = blocker(repo.state, repo.default_branch.as_deref(), worktree, nested_in(&projects.repos, &worktree.path), now_ms) {
            return Err(format!("{} can't be removed: {}", removal.path, reason.text()));
        }
        if !is_path(&repo.path) || !is_path(&worktree.path) || worktree.branch.as_deref().is_some_and(|branch| branch.chars().any(char::is_control)) {
            return Err(format!("Arbor can't remove {}", removal.path));
        }
        planned.push(PlannedRemoval {
            main: repo.path.clone(),
            path: worktree.path.clone(),
            head: removal.head,
            branch: worktree.branch.clone(),
            delete_branch: worktree.branch.is_some() && worktree.merged,
        });
    }
    Ok(planned)
}

// Follows GIT_ENV, CHECKS, `budget` and the list Rust writes to $work/list: one
// "main worktree head branch delete" line per removal. Each worktree is checked again, with stdin
// closed, before it goes. Lines out:
//   X path outcome branch detail
const REMOVE_BODY: &str = r##"cwds > "$work/cwds"
now=$(date +%s)
said() { printf 'X\t%s\t%s\t%s\t%s\n' "$wt" "$1" "$2" "$3"; }
remove_one() {
  if [ ! -e "$wt" ]; then said gone - ""; return 0; fi
  git -C "$main" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' > "$work/listed"
  if ! grep -Fqx -e "$wt" "$work/listed"; then said changed - "It isn't a worktree of that checkout any more"; return 0; fi
  if W="$wt" awk 'BEGIN { w = ENVIRON["W"] "/" } index($0, w) == 1 { found = 1 } END { exit !found }' "$work/listed"; then said busy - "Another worktree is inside it"; return 0; fi
  cur=$(git -C "$wt" rev-parse --verify --quiet HEAD 2>/dev/null || true)
  on=$(git -C "$wt" symbolic-ref --quiet HEAD 2>/dev/null || true)
  on=${on#refs/heads/}
  [ -n "$on" ] || on=-
  if [ "$cur" != "$head" ] || [ "$on" != "$branch" ]; then said changed - "Its commit or branch has moved"; return 0; fi
  if ! git -C "$wt" status --porcelain --untracked-files=normal --ignore-submodules=none > "$work/st" 2>/dev/null; then said failed - "git status didn't work there"; return 0; fi
  if [ -s "$work/st" ]; then said changed - "It has changes now"; return 0; fi
  if [ "$(hidden_in "$wt")" != 0 ]; then said changed - "Git is told not to check some of its files for changes"; return 0; fi
  gitdir=$(git -C "$wt" rev-parse --absolute-git-dir 2>/dev/null || true)
  if [ -z "$gitdir" ]; then said failed - "Arbor couldn't find its git folder"; return 0; fi
  if [ "$(midway "$gitdir")" != 0 ]; then said changed - "A rebase, merge or bisect is under way in it"; return 0; fi
  if [ "$(unreachable_in "$wt")" != 0 ]; then said changed - "It has commits only its own history remembers"; return 0; fi
  if [ "$(nested_in "$wt")" != 0 ]; then said busy - "Another git checkout is inside it"; return 0; fi
  if A="$wt" B="$(cd "$wt" 2>/dev/null && pwd -P || true)" open_in; then said busy - "Something is running in it"; return 0; fi
  t=$(touched "$gitdir")
  if [ -z "$t" ]; then said busy - "Arbor couldn't tell when it was last used"; return 0; fi
  if [ $((now - t)) -lt 3600 ]; then said busy - "It was used in the last hour"; return 0; fi
  if ! out=$(git -C "$main" worktree remove "$wt" 2>&1); then said failed - "$(printf '%s' "$out" | tr '\t\n' '  ' | cut -c 1-300)"; return 0; fi
  b=-
  if [ "$branch" != "-" ]; then
    b=kept
    if [ "$del" = 1 ] && git -C "$main" branch -d "$branch" >/dev/null 2>&1; then b=deleted; fi
  fi
  said removed "$b" ""
}
start=$(date +%s)
while IFS="$tab" read -r main wt head branch del <&3; do
  [ -n "$wt" ] || continue
  if [ $(( $(date +%s) - start )) -ge "$budget" ]; then said skipped - "Arbor ran out of time before this one"; continue; fi
  remove_one </dev/null
done 3< "$work/list"
"##;

fn remove_script(planned: &[PlannedRemoval]) -> String {
    let mut script = format!("{GIT_ENV}{CHECKS}budget={REMOVE_BUDGET_S}\ncat > \"$work/list\" <<'ARBOR_REMOVALS'\n");
    for removal in planned {
        script.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\n",
            removal.main,
            removal.path,
            removal.head,
            removal.branch.as_deref().unwrap_or("-"),
            u8::from(removal.delete_branch)
        ));
    }
    script.push_str("ARBOR_REMOVALS\n");
    script.push_str(REMOVE_BODY);
    script
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RemovalOutcome {
    Removed,
    /// Its folder was already gone.
    Gone,
    /// It changed since the scan, so it was left.
    Changed,
    /// Something is running in it, or it was used lately.
    Busy,
    /// Arbor ran out of time before it got to this one.
    Skipped,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BranchOutcome {
    Deleted,
    Kept,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemovalResult {
    path: String,
    outcome: RemovalOutcome,
    branch: Option<BranchOutcome>,
    message: String,
}

fn parse_removals(stdout: &str, planned: &[PlannedRemoval]) -> Vec<RemovalResult> {
    let mut heard: HashMap<&str, RemovalResult> = HashMap::new();
    for line in stdout.lines() {
        let fields: Vec<&str> = line.splitn(5, '\t').collect();
        let ["X", path, outcome, branch, detail] = fields.as_slice() else {
            continue;
        };
        let Some(removal) = planned.iter().find(|removal| removal.path == *path) else {
            continue;
        };
        let outcome = match *outcome {
            "removed" => RemovalOutcome::Removed,
            "gone" => RemovalOutcome::Gone,
            "changed" => RemovalOutcome::Changed,
            "busy" => RemovalOutcome::Busy,
            "skipped" => RemovalOutcome::Skipped,
            _ => RemovalOutcome::Failed,
        };
        let branch = match *branch {
            "deleted" => Some(BranchOutcome::Deleted),
            "kept" => Some(BranchOutcome::Kept),
            _ => None,
        };
        heard.insert(&removal.path, RemovalResult { path: removal.path.clone(), outcome, branch, message: message(detail) });
    }
    planned
        .iter()
        .map(|removal| {
            heard.remove(removal.path.as_str()).unwrap_or_else(|| RemovalResult {
                path: removal.path.clone(),
                outcome: RemovalOutcome::Failed,
                branch: None,
                message: "Arbor didn't hear how this one went".into(),
            })
        })
        .collect()
}

/// Removes worktrees the last scan found could go, after the machine checks each one again.
#[tauri::command]
pub(crate) async fn remove_worktrees(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    removals: Vec<WorktreeRemoval>,
) -> Result<Vec<RemovalResult>, String> {
    if !state.lock().projects.contains_key(&machine) {
        return Err("Scan this machine's projects first".into());
    }
    let (target, projects) = claim(&state, &machine, Work::Remove)?;
    let planned = match plan_removals(&projects, removals, Local::now().timestamp_millis()) {
        Ok(planned) => planned,
        Err(error) => {
            release(&app, &machine, |_| {});
            return Err(error);
        }
    };
    let _ = app.emit(SETUP_PROJECTS_UPDATED_EVENT, Local::now().timestamp_millis());
    // Each worktree reports its own line, so a script that stopped part way still says what it did.
    let result = run_on_machine(&target, MachineOp::WorktreeRemoval, &remove_script(&planned), REMOVE_TIMEOUT).await.and_then(|output| {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !output.status.success() && !stdout.lines().any(|line| line.starts_with("X\t")) {
            return Err(failure_detail(&output));
        }
        Ok(parse_removals(&stdout, &planned))
    });
    release(&app, &machine, |entry| {
        if let Ok(results) = &result {
            for repo in &mut entry.repos {
                repo.worktrees.retain(|worktree| {
                    !results.iter().any(|result| result.path == worktree.path && matches!(result.outcome, RemovalOutcome::Removed | RemovalOutcome::Gone))
                });
            }
        }
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn a_runs_repo_is_found_by_its_remote_in_any_case_with_or_without_git() {
        let repo = |path: &str, remote: Option<&str>, state: RepoState| ProjectRepo { path: path.into(), remote: remote.map(Into::into), state, ..ProjectRepo::default() };
        let projects = MachineProjects {
            scanned_at: Some(NOW),
            repos: vec![
                repo("/home/cam/old/storefront", Some("github.com/acme/storefront"), RepoState::Missing),
                repo("/home/cam/src/storefront", Some("github.com/Acme/storefront.git"), RepoState::Ok),
                repo("/home/cam/src/docs", None, RepoState::Ok),
            ],
            ..MachineProjects::default()
        };
        assert!(projects.scanned());
        // A checkout that's gone is passed over for one that's there.
        assert_eq!(projects.repo_path("github.com/acme/storefront"), Some("/home/cam/src/storefront"));
        assert_eq!(projects.repo_path("github.com/acme/storefront.git/"), Some("/home/cam/src/storefront"));
        assert_eq!(projects.repo_path("github.com/acme/docs"), None);
        assert!(!MachineProjects::default().scanned());
    }

    fn worktree(path: &str) -> ProjectWorktree {
        ProjectWorktree {
            path: path.into(),
            head: Some("abc".into()),
            branch: Some("feature".into()),
            changed: Some(0),
            untracked: Some(0),
            merged: true,
            touched_at: Some(NOW - 2 * RECENT_MS),
            ..ProjectWorktree::default()
        }
    }

    #[test]
    fn remotes_are_kept_as_host_owner_and_name_without_credentials() {
        for (url, expected) in [
            ("git@github.com:Owner/Repo.git", Some("github.com/owner/repo")),
            ("github.com:owner/repo", Some("github.com/owner/repo")),
            ("https://github.com/owner/repo", Some("github.com/owner/repo")),
            ("https://user:ghp_secret@github.com/owner/repo.git/", Some("github.com/owner/repo")),
            ("ssh://git@gitlab.example.com:2222/group/sub/repo.git", Some("gitlab.example.com/group/sub/repo")),
            ("https://host/owner/repo.git?token=abc#x", Some("host/owner/repo")),
            ("/srv/git/tools.git", Some("/srv/git/tools")),
            ("file:///srv/git/tools.git", Some("/srv/git/tools")),
            ("", None),
            ("https://host/", None),
        ] {
            assert_eq!(normalize_remote(url).as_deref(), expected, "{url}");
        }
    }

    #[test]
    fn tracking_says_how_far_a_branch_is_from_its_upstream() {
        assert_eq!(parse_track("[ahead 2, behind 13]"), (2, 13, false));
        assert_eq!(parse_track("[behind 1]"), (0, 1, false));
        assert_eq!(parse_track(""), (0, 0, false));
        assert_eq!(parse_track("[gone]"), (0, 0, true));
    }

    #[test]
    fn a_worktree_can_go_only_when_nothing_would_be_lost() {
        let check = |worktree: &ProjectWorktree| blocker(RepoState::Ok, Some("origin/main"), worktree, false, NOW);
        assert_eq!(check(&worktree("/r/wt")), None);
        assert_eq!(check(&ProjectWorktree { main: true, ..worktree("/r") }), Some(Blocker::Main));
        assert_eq!(check(&ProjectWorktree { prunable: true, ..worktree("/r/wt") }), Some(Blocker::Missing));
        assert_eq!(check(&ProjectWorktree { locked: true, ..worktree("/r/wt") }), Some(Blocker::Locked));
        assert_eq!(check(&ProjectWorktree { changed: None, ..worktree("/r/wt") }), Some(Blocker::Unknown));
        assert_eq!(check(&ProjectWorktree { head: None, ..worktree("/r/wt") }), Some(Blocker::Unknown));
        assert_eq!(check(&ProjectWorktree { untracked: Some(1), ..worktree("/r/wt") }), Some(Blocker::Dirty));
        // When git last touched it can't be told, it may be in use.
        assert_eq!(check(&ProjectWorktree { touched_at: None, ..worktree("/r/wt") }), Some(Blocker::Unknown));
        assert_eq!(check(&ProjectWorktree { hidden: 1, ..worktree("/r/wt") }), Some(Blocker::Hidden));
        assert_eq!(check(&ProjectWorktree { midway: true, ..worktree("/r/wt") }), Some(Blocker::Midway));
        assert_eq!(check(&ProjectWorktree { unreachable: 2, ..worktree("/r/wt") }), Some(Blocker::Unreachable));
        assert_eq!(check(&ProjectWorktree { nested: true, ..worktree("/r/wt") }), Some(Blocker::Nested));
        assert_eq!(check(&ProjectWorktree { open: true, ..worktree("/r/wt") }), Some(Blocker::Open));
        assert_eq!(check(&ProjectWorktree { last_used_ms: Some(NOW - 60_000), ..worktree("/r/wt") }), Some(Blocker::Recent));
        assert_eq!(check(&ProjectWorktree { touched_at: Some(NOW - 60_000), ..worktree("/r/wt") }), Some(Blocker::Recent));
        assert_eq!(check(&ProjectWorktree { last_used_ms: Some(NOW - 2 * RECENT_MS), ..worktree("/r/wt") }), None);
        assert_eq!(check(&ProjectWorktree { branch: Some("main".into()), ..worktree("/r/wt") }), Some(Blocker::DefaultBranch));
        assert_eq!(check(&ProjectWorktree { merged: false, ..worktree("/r/wt") }), Some(Blocker::NotMerged));
        // A squash-merged pull request: not in main, but its branch was deleted upstream and stays here.
        assert_eq!(check(&ProjectWorktree { merged: false, gone: true, ..worktree("/r/wt") }), None);
        // A detached one only when its commit is merged, since nothing else keeps it.
        assert_eq!(check(&ProjectWorktree { merged: false, gone: true, branch: None, ..worktree("/r/wt") }), Some(Blocker::NotMerged));
        assert_eq!(blocker(RepoState::Missing, None, &worktree("/r/wt"), false, NOW), Some(Blocker::Unknown));
        assert_eq!(blocker(RepoState::Ok, None, &worktree("/r/wt"), true, NOW), Some(Blocker::Nested));
    }

    #[test]
    fn a_scan_reads_each_repo_its_worktrees_and_files() {
        let stdout = "H\t/home/cam\n\
            R\t/home/cam/src/app\tok\n\
            O\tgithub.com:cam/app.git\n\
            D\trefs/remotes/origin/main\n\
            F\t1700000000\n\
            B\trefs/heads/main\torigin/main\t[behind 3]\n\
            B\trefs/heads/fix\torigin/fix\t[gone]\n\
            B\trefs/heads/wip\t\t\n\
            T\t/home/cam/src/app\tabc\tmain\t-\t1\n\
            S\t2\t1\t1\t1700000100\t1700000200\t0\t0\t0\t0\t0\t/home/cam/src/app\n\
            T\t/home/cam/.agent-app/worktrees/app/fix\tdef\tfix\t-\t0\n\
            S\t0\t0\t0\t1700000100\t1700000200\t0\t0\t0\t0\t0\t/real/fix\n\
            I\t.env.local\n\
            I\tnode_modules/\n\
            J\t4\n\
            T\t/home/cam/src/app/.claude/worktrees/wip\t123\twip\tlocked,\t0\n\
            S\t-\t-\t0\t-\t-\t1\t0\t0\t0\t0\t-\n\
            T\t/with\ttab\t999\tx\t-\t0\n\
            S\t9\t9\t0\t-\t-\t0\t0\t0\t0\t0\t-\n\
            I\tstray\n\
            T\t/gone/wt\t456\t-\tdetached,prunable,\t0\n\
            C\tAGENTS.md\t123\t45\n\
            C\tsecret.txt\t1\t1\n\
            R\t/home/cam/src/old\tmissing\n\
            R\t/srv/git/tools.git\tok\n\
            T\t/srv/git/tools.git\t-\t-\tbare,\t1\n\
            T\t/home/cam/tools\t789\tmain\t-\t0\n\
            S\t0\t0\t1\t-\t-\t0\tx\t0\t0\t0\t-\n\
            Q\n";
        // The fix worktree's sessions recorded its folder with links resolved.
        let used = HashMap::from([("/home/cam/src/app".to_string(), NOW - 10), ("/real/fix".to_string(), NOW - 2 * RECENT_MS)]);
        let scanned = parse_scan(stdout, &used, NOW);
        assert_eq!(scanned.home_dir, "/home/cam");
        assert!(scanned.partial);
        let [app, old, tools] = scanned.repos.as_slice() else { panic!("three repos: {:?}", scanned.repos) };
        assert_eq!((app.remote.as_deref(), app.default_branch.as_deref(), app.fetched_at), (Some("github.com/cam/app"), Some("origin/main"), Some(1_700_000_000_000)));
        assert_eq!(app.last_used_ms, Some(NOW - 10));
        assert_eq!(app.files, vec![ProjectFile { name: "AGENTS.md".into(), sum: "123".into(), size: 45 }]);
        let [main, fix, wip, gone] = app.worktrees.as_slice() else { panic!("four worktrees") };
        assert!(main.main);
        assert_eq!((main.changed, main.untracked, main.ahead, main.behind, main.blocker), (Some(2), Some(1), Some(0), Some(3), Some(Blocker::Main)));
        assert_eq!((fix.gone, fix.ahead, fix.merged, fix.blocker), (true, None, false, None));
        assert_eq!(fix.last_used_ms, Some(NOW - 2 * RECENT_MS));
        assert_eq!((fix.ignored.as_slice(), fix.ignored_more), ([".env.local".to_string(), "node_modules/".to_string()].as_slice(), 4));
        assert_eq!((wip.upstream.as_deref(), wip.locked, wip.open, wip.blocker), (None, true, true, Some(Blocker::Locked)));
        // Lines after a worktree line Arbor couldn't read belong to nothing.
        assert_eq!((wip.changed, wip.ignored.len()), (None, 0));
        assert_eq!((gone.branch.as_deref(), gone.prunable, gone.blocker), (None, true, Some(Blocker::Missing)));
        assert_eq!(old.state, RepoState::Missing);
        assert!(tools.bare);
        assert_eq!(tools.worktrees.len(), 1);
        // A count that didn't come back counts against it.
        assert_eq!(tools.worktrees.first().map(|worktree| worktree.hidden), Some(1));
        assert_eq!(tools.default_branch, None);
    }

    #[test]
    fn a_checkouts_plugin_settings_leave_as_ids_and_values_only() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let local = STANDARD.encode(r#"{"env":{"API_KEY":"SECRET-TOKEN-123"},"enabledPlugins":{"context7@official":false,"bad id@x":true,"odd@m":"yes"}}"#);
        let shared = STANDARD.encode(r#"{"enabledPlugins":{"superpowers@official":true}}"#);
        // base64 wraps at 76 on most machines; the lines are joined back.
        let (a, b) = local.split_at(40);
        let stdout = format!(
            "H\t/home/cam\nR\t/home/cam/src/app\tok\nT\t/home/cam/src/app\tabc\tmain\t-\t1\n\
             S\t0\t0\t1\t-\t-\t0\t0\t0\t0\t0\t-\nP\t.claude/settings.local.json\n{a}\n{b}\n.\nP\t.claude/settings.json\n{shared}\n.\n\
             T\t/with\ttab\t999\tx\t-\t0\nP\t.claude/settings.json\n{shared}\n.\n"
        );
        let scanned = parse_scan(&stdout, &HashMap::new(), NOW);
        let [repo] = scanned.repos.as_slice() else { panic!("one repo") };
        let [main] = repo.worktrees.as_slice() else { panic!("one worktree") };
        assert_eq!(
            main.plugins,
            [
                CheckoutPlugin { id: "context7@official".into(), on: false, local: true },
                CheckoutPlugin { id: "superpowers@official".into(), on: true, local: false },
            ]
        );
        assert!(!serde_json::to_string(&scanned.repos).unwrap().contains("SECRET-TOKEN-123"));
    }

    #[test]
    fn a_checkouts_skill_overrides_leave_as_names_and_states_only() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let local = STANDARD.encode(r#"{"env":{"API_KEY":"SECRET-TOKEN-123"},"skillOverrides":{"pdf":"off","frontend-design":"name-only"}}"#);
        // One value Claude Code doesn't know and it ignores the whole map, so none of it counts.
        let shared = STANDARD.encode(r#"{"skillOverrides":{"pdf":"on","review":"sometimes"}}"#);
        let stdout = format!(
            "H\t/home/cam\nR\t/home/cam/src/app\tok\nT\t/home/cam/src/app\tabc\tmain\t-\t1\n\
             S\t0\t0\t1\t-\t-\t0\t0\t0\t0\t0\t-\nP\t.claude/settings.local.json\n{local}\n.\nP\t.claude/settings.json\n{shared}\n.\n"
        );
        let scanned = parse_scan(&stdout, &HashMap::new(), NOW);
        let [repo] = scanned.repos.as_slice() else { panic!("one repo") };
        let [main] = repo.worktrees.as_slice() else { panic!("one worktree") };
        assert_eq!(
            main.skills,
            [
                CheckoutSkill { name: "frontend-design".into(), state: OverrideState::NameOnly, local: true },
                CheckoutSkill { name: "pdf".into(), state: OverrideState::Off, local: true },
            ]
        );
        assert_eq!(main.ignored_overrides, ["settings.json"]);
        assert!(!main.local_seen);
        assert!(!serde_json::to_string(&scanned.repos).unwrap().contains("SECRET-TOKEN-123"));
    }

    #[test]
    fn a_checkouts_denied_mcp_servers_leave_as_names_only() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let local = STANDARD.encode(r#"{"deniedMcpServers":[{"serverName":"linear"},{"serverUrl":"https://secret.example.com/*"}]}"#);
        let shared = STANDARD.encode(r#"{"deniedMcpServers":[{"serverName":"sentry"}]}"#);
        let stdout = format!(
            "H\t/home/cam\nR\t/home/cam/src/app\tok\nT\t/home/cam/src/app\tabc\tmain\t-\t1\n\
             S\t0\t0\t1\t-\t-\t0\t0\t0\t0\t0\t-\nP\t.claude/settings.local.json\n{local}\n.\nP\t.claude/settings.json\n{shared}\n.\n"
        );
        let scanned = parse_scan(&stdout, &HashMap::new(), NOW);
        let main = &scanned.repos[0].worktrees[0];
        assert_eq!(main.mcp_denied, [CheckoutMcpDeny { name: "linear".into(), local: true }, CheckoutMcpDeny { name: "sentry".into(), local: false }]);
        assert!(!serde_json::to_string(&scanned.repos).unwrap().contains("secret.example.com"));
        let projects = MachineProjects { repos: scanned.repos.clone(), ..MachineProjects::default() };
        assert_eq!(projects.checkout_mcp("/home/cam/src/app", "sentry"), Some(CheckoutMcpState { local: false, disabled: false, denied_shared: true }));
        assert_eq!(projects.checkout_mcp("/home/cam/src/app", "linear").map(|state| state.denied_shared), Some(false));
        assert_eq!(projects.checkout_mcp("/elsewhere", "linear"), None);
    }

    #[test]
    fn a_checkout_where_git_would_see_new_local_settings_says_so() {
        let stdout = "H\t/home/cam\nR\t/home/cam/src/app\tok\nT\t/home/cam/src/app\tabc\tmain\t-\t1\n\
                      S\t0\t0\t1\t-\t-\t0\t0\t0\t0\t0\t-\nG\n";
        let scanned = parse_scan(stdout, &HashMap::new(), NOW);
        let [repo] = scanned.repos.as_slice() else { panic!("one repo") };
        let [main] = repo.worktrees.as_slice() else { panic!("one worktree") };
        assert!(main.local_seen);
    }

    #[test]
    fn checkouts_come_from_the_sessions_that_ran_on_the_machine() {
        let connection = crate::usage::schema::test_database();
        for (id, machine, root, main) in [
            ("a", "mini", "/src/app", "/src/app"),
            ("b", "mini", "/src/app/.claude/worktrees/x", "/src/app"),
            ("c", "mini", "/src/old", ""),
            ("d", "mini", "", ""),
            ("e", "studio", "/src/other", "/src/other"),
            ("f", "mini", "/src/bad\npath", "/src/bad\npath"),
        ] {
            connection
                .execute("INSERT INTO usage_session_transcripts (session_id, machine, agent, repo_root, main_repo) VALUES (?1, ?2, 'claude', ?3, ?4)", params![id, machine, root, main])
                .unwrap();
        }
        for (id, at) in [("a", 100), ("a", 300), ("b", 500), ("c", 50), ("e", 900)] {
            crate::usage::schema::insert_request(&connection, "session_id, timestamp_ms", params![id, at]);
        }
        let checkouts = load_checkouts(&connection, "mini").unwrap();
        assert_eq!(checkouts.repos, vec!["/src/app".to_string(), "/src/old".to_string()]);
        assert_eq!(checkouts.used.get("/src/app"), Some(&500));
        assert_eq!(checkouts.used.get("/src/app/.claude/worktrees/x"), Some(&500));
        assert_eq!(checkouts.used.get("/src/old"), Some(&50));
        assert!(!checkouts.used.contains_key("/src/other"));
    }

    fn projects() -> MachineProjects {
        MachineProjects {
            machine: "mini".into(),
            scanned_at: Some(NOW - 60_000),
            repos: vec![ProjectRepo {
                path: "/src/app".into(),
                default_branch: Some("origin/main".into()),
                worktrees: vec![
                    ProjectWorktree { main: true, ..worktree("/src/app") },
                    worktree("/src/app/.claude/worktrees/done"),
                    ProjectWorktree { merged: false, gone: true, ..worktree("/wt/squashed") },
                    ProjectWorktree { untracked: Some(3), ..worktree("/wt/dirty") },
                    worktree("/wt/outer"),
                    worktree("/wt/outer/.claude/worktrees/inner"),
                ],
                ..ProjectRepo::default()
            }],
            ..MachineProjects::default()
        }
    }

    fn removal(path: &str, head: &str) -> WorktreeRemoval {
        WorktreeRemoval { repo: "/src/app".into(), path: path.into(), head: head.into() }
    }

    #[test]
    fn removals_are_checked_against_the_last_scan() {
        let planned = plan_removals(&projects(), vec![removal("/src/app/.claude/worktrees/done", "abc"), removal("/wt/squashed", "abc"), removal("/wt/squashed", "abc")], NOW).unwrap();
        assert_eq!(
            planned,
            vec![
                PlannedRemoval { main: "/src/app".into(), path: "/src/app/.claude/worktrees/done".into(), head: "abc".into(), branch: Some("feature".into()), delete_branch: true },
                PlannedRemoval { main: "/src/app".into(), path: "/wt/squashed".into(), head: "abc".into(), branch: Some("feature".into()), delete_branch: false },
            ]
        );
        assert!(plan_removals(&projects(), vec![removal("/src/app", "abc")], NOW).unwrap_err().contains("main checkout"));
        assert!(plan_removals(&projects(), vec![removal("/wt/dirty", "abc")], NOW).unwrap_err().contains("has changes"));
        assert!(plan_removals(&projects(), vec![removal("/wt/outer", "abc")], NOW).unwrap_err().contains("inside it"));
        assert!(plan_removals(&projects(), vec![removal("/wt/outer/.claude/worktrees/inner", "abc")], NOW).is_ok());
        assert!(plan_removals(&projects(), vec![removal("/wt/squashed", "zzz")], NOW).unwrap_err().contains("moved"));
        assert!(plan_removals(&projects(), vec![removal("/elsewhere", "abc")], NOW).unwrap_err().contains("didn't find"));
        assert!(plan_removals(&projects(), Vec::new(), NOW).is_err());
        let stale = MachineProjects { scanned_at: Some(NOW - PLAN_FRESH_MS - 1), ..projects() };
        assert!(plan_removals(&stale, vec![removal("/wt/squashed", "abc")], NOW).unwrap_err().contains("again"));
    }

    #[test]
    fn removal_results_cover_every_worktree_asked_about() {
        let planned = plan_removals(&projects(), vec![removal("/src/app/.claude/worktrees/done", "abc"), removal("/wt/squashed", "abc")], NOW).unwrap();
        let results = parse_removals("X\t/src/app/.claude/worktrees/done\tremoved\tdeleted\t\nX\t/not/asked\tremoved\t-\t\n", &planned);
        assert_eq!(
            results,
            vec![
                RemovalResult { path: "/src/app/.claude/worktrees/done".into(), outcome: RemovalOutcome::Removed, branch: Some(BranchOutcome::Deleted), message: String::new() },
                RemovalResult { path: "/wt/squashed".into(), outcome: RemovalOutcome::Failed, branch: None, message: "Arbor didn't hear how this one went".into() },
            ]
        );
    }

    #[cfg(unix)]
    mod scripts {
        use super::*;

        fn temp_dir(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("arbor-projects-{name}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            // Paths as git reports them, with /tmp's link resolved on macOS.
            dir.canonicalize().unwrap()
        }

        fn git(home: &Path, dir: &Path, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .args(["-c", "user.name=Arbor", "-c", "user.email=arbor@example.com", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
                .args(args)
                .current_dir(dir)
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }

        fn run(shell: &str, home: &Path, script: &str) -> std::process::Output {
            let mut command = tokio::process::Command::new(shell);
            command
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin")
                .env("GIT_DIR", "/somewhere/else")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            tokio::runtime::Runtime::new().unwrap().block_on(run_script(command, script, Duration::from_secs(60))).unwrap()
        }

        /// An upstream, a checkout of it with a merged worktree, a squash-merged one whose branch
        /// was deleted upstream, one with work in it and one with nothing merged.
        fn fixture(root: &Path) -> (PathBuf, PathBuf) {
            let home = root.join("home");
            let upstream = root.join("upstream.git");
            let app = root.join("app");
            fs::create_dir_all(&home).unwrap();
            fs::create_dir_all(&app).unwrap();
            git(&home, root, &["init", "--bare", "-q", upstream.to_str().unwrap()]);
            git(&home, &app, &["init", "-q"]);
            fs::create_dir_all(app.join(".claude")).unwrap();
            fs::write(app.join(".claude/CLAUDE.md"), "# app\n").unwrap();
            fs::write(app.join("AGENTS.md"), "agents\n").unwrap();
            fs::write(app.join(".gitignore"), ".env*\nnode_modules/\n.claude/worktrees/\n").unwrap();
            git(&home, &app, &["add", "."]);
            git(&home, &app, &["commit", "-qm", "first"]);
            git(&home, &app, &["remote", "add", "origin", &format!("file://{}", upstream.display())]);
            git(&home, &app, &["push", "-q", "-u", "origin", "main"]);
            git(&home, &app, &["remote", "set-head", "origin", "main"]);
            for (name, branch) in [("done", "done"), ("squashed", "squashed"), ("busy", "busy"), ("unmerged", "unmerged")] {
                git(&home, &app, &["worktree", "add", "-q", "-b", branch, root.join(name).to_str().unwrap()]);
            }
            // done: merged into main.
            fs::write(root.join("done/done.txt"), "done\n").unwrap();
            git(&home, &root.join("done"), &["add", "."]);
            git(&home, &root.join("done"), &["commit", "-qm", "done"]);
            git(&home, &app, &["merge", "-q", "--ff-only", "done"]);
            git(&home, &app, &["push", "-q", "origin", "main"]);
            fs::write(root.join("done/.env.local"), "SECRET=1\n").unwrap();
            // squashed: pushed, then deleted upstream the way a merged pull request's is.
            fs::write(root.join("squashed/s.txt"), "s\n").unwrap();
            git(&home, &root.join("squashed"), &["add", "."]);
            git(&home, &root.join("squashed"), &["commit", "-qm", "squashed"]);
            git(&home, &root.join("squashed"), &["push", "-q", "-u", "origin", "squashed"]);
            git(&home, &app, &["push", "-q", "origin", "--delete", "squashed"]);
            git(&home, &app, &["fetch", "-q", "--prune", "origin"]);
            // busy: an untracked file.
            fs::write(root.join("busy/notes.txt"), "wip\n").unwrap();
            // unmerged: a commit nowhere else.
            fs::write(root.join("unmerged/u.txt"), "u\n").unwrap();
            git(&home, &root.join("unmerged"), &["add", "."]);
            git(&home, &root.join("unmerged"), &["commit", "-qm", "unmerged"]);
            (home, app)
        }

        /// Makes git's own files look untouched for a day, so the worktrees aren't recent.
        fn age(root: &Path) {
            let old = std::time::SystemTime::now() - Duration::from_secs(86_400);
            let mut stack = vec![root.join("app/.git")];
            while let Some(dir) = stack.pop() {
                for entry in fs::read_dir(&dir).unwrap().flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        stack.push(path);
                    } else if matches!(path.file_name().and_then(|name| name.to_str()), Some("index" | "HEAD")) {
                        fs::File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
                    }
                }
            }
        }

        #[test]
        fn a_scan_reads_each_worktree_without_changing_anything() {
            for shell in shells() {
                scan_in(shell);
            }
        }

        #[test]
        fn each_place_the_repo_wants_is_read_as_a_checkout_a_link_or_whats_in_the_way() {
            for shell in shells() {
                let root = temp_dir("places");
                let (home, app) = fixture(&root);
                let code = home.join("code");
                fs::create_dir_all(code.join("cam/empty")).unwrap();
                fs::create_dir_all(code.join("cam/stuff")).unwrap();
                fs::write(code.join("cam/stuff/notes.txt"), "x").unwrap();
                fs::write(code.join("cam/file"), "x").unwrap();
                std::os::unix::fs::symlink(&app, code.join("cam/app")).unwrap();
                std::os::unix::fs::symlink(root.join("gone"), code.join("cam/broken")).unwrap();
                fs::write(app.join("new.txt"), "x").unwrap();
                let places: Vec<String> = ["~/code/cam/app", "~/code/cam/missing", "~/code/cam/empty", "~/code/cam/stuff", "~/code/cam/file", "~/code/cam/broken"]
                    .into_iter()
                    .map(String::from)
                    .chain([app.display().to_string()])
                    .collect();
                let output = run(shell, &home, &scan_script(&[], &places, false));
                let stdout = String::from_utf8_lossy(&output.stdout);
                assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
                let found = parse_scan(&stdout, &HashMap::new(), 0).places;
                let kinds: Vec<(&str, PlaceKind)> = found.iter().map(|place| (place.path.as_str(), place.kind)).collect();
                assert_eq!(
                    kinds,
                    [
                        ("~/code/cam/app", PlaceKind::Checkout),
                        ("~/code/cam/missing", PlaceKind::Missing),
                        ("~/code/cam/empty", PlaceKind::Empty),
                        ("~/code/cam/stuff", PlaceKind::Other),
                        ("~/code/cam/file", PlaceKind::File),
                        ("~/code/cam/broken", PlaceKind::Broken),
                        (app.to_str().unwrap(), PlaceKind::Checkout),
                    ],
                    "{shell}: {stdout}"
                );
                let linked = &found[0];
                assert_eq!(linked.link.as_deref(), Some(app.to_str().unwrap()), "{shell}");
                assert_eq!(linked.real.as_deref(), Some(app.to_str().unwrap()), "{shell}");
                assert!(linked.remote.as_deref().is_some_and(|remote| remote.ends_with("upstream")), "{shell}: {:?}", linked.remote);
                let status = &linked.status;
                assert_eq!((status.branch.as_deref(), status.changed, status.untracked), (Some("main"), Some(0), Some(1)), "{shell}");
                assert_eq!((status.upstream.as_deref(), status.ahead, status.behind), (Some("origin/main"), Some(0), Some(0)), "{shell}");
                assert_eq!((status.default_branch.as_deref(), status.worktrees), (Some("origin/main"), 4), "{shell}");
                assert!(found[6].link.is_none(), "{shell}");
                let _ = fs::remove_dir_all(&root);
            }
        }

        #[test]
        fn a_checkouts_own_mcp_servers_come_from_claude_json_by_name_only() {
            for shell in shells() {
                let root = temp_dir("mcp");
                let (home, app) = fixture(&root);
                let real = app.canonicalize().unwrap().display().to_string();
                // SECRET: a local server's env and headers stay on the machine; only names and project paths leave.
                let json = serde_json::json!({
                    "mcpServers": { "fs": { "command": "npx" } },
                    "oauthAccount": { "emailAddress": "someone@example.com" },
                    "projects": {
                        real.clone(): {
                            "allowedTools": [],
                            "mcpServers": {
                                "linear": { "type": "http", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer SECRET-TOKEN-123" } },
                                "odd\"name": { "command": "x" },
                            },
                            "disabledMcpServers": ["sentry", "claude.ai Slack"],
                            "enabledMcpServers": ["computer-use"],
                        },
                        "/somewhere/else": { "mcpServers": { "elsewhere": {} }, "disabledMcpServers": ["notion"] },
                    },
                });
                fs::write(home.join(".claude.json"), serde_json::to_string_pretty(&json).unwrap()).unwrap();
                let output = run(shell, &home, &scan_script(&[app.display().to_string()], &[], false));
                let stdout = String::from_utf8_lossy(&output.stdout);
                assert!(!stdout.contains("SECRET-TOKEN-123") && !stdout.contains("someone@example.com"), "{shell}: {stdout}");
                let scanned = parse_scan(&stdout, &HashMap::new(), Local::now().timestamp_millis());
                let main = scanned.repos[0].worktrees.iter().find(|worktree| worktree.main).unwrap();
                assert_eq!(main.mcp_local, ["linear"], "{shell}");
                assert_eq!(main.mcp_disabled, ["sentry", "claude.ai Slack"], "{shell}");
                // Paths that aren't one of the scan's checkouts are dropped.
                assert!(!serde_json::to_string(&scanned.repos).unwrap().contains("/somewhere/else"));
                let _ = fs::remove_dir_all(&root);
            }
        }

        #[test]
        fn a_checkouts_instruction_files_leave_as_arbors_first_line_or_nothing() {
            for shell in shells() {
                let root = temp_dir("instructions");
                let (home, app) = fixture(&root);
                // SECRET: someone's own CLAUDE.local.md stays on the machine; Arbor's is known by its first line alone.
                fs::write(app.join(".git/info/exclude"), "CLAUDE.local.md\n").unwrap();
                fs::write(app.join("CLAUDE.local.md"), "<!-- arbor: x text=abc123 import=0 -->\n\nPRIVATE-NOTE-1\n").unwrap();
                fs::write(root.join("busy/CLAUDE.local.md"), "PRIVATE-NOTE-2\n").unwrap();
                let output = run(shell, &home, &scan_script(&[app.display().to_string()], &[], false));
                let stdout = String::from_utf8_lossy(&output.stdout);
                assert!(!stdout.contains("PRIVATE-NOTE"), "{shell}: {stdout}");
                let scanned = parse_scan(&stdout, &HashMap::new(), Local::now().timestamp_millis());
                let find = |name: &str| scanned.repos[0].worktrees.iter().find(|worktree| worktree.path.ends_with(&format!("/{name}"))).unwrap();
                let main = find("app");
                let local = main.instructions.iter().find(|file| file.file == InstructionFile::ClaudeLocal).unwrap();
                assert_eq!((local.state, local.text.as_deref(), local.import), (LocalFileState::Arbor, Some("abc123"), Some(false)), "{shell}");
                let codex = main.instructions.iter().find(|file| file.file == InstructionFile::AgentsOverride).unwrap();
                assert_eq!(codex.state, LocalFileState::Seen, "{shell}");
                assert!(main.agents_md.as_deref().is_some_and(|sum| sum.starts_with('c')) && main.claude_md, "{shell}");
                let busy = find("busy");
                assert_eq!(busy.instructions.iter().find(|file| file.file == InstructionFile::ClaudeLocal).map(|file| file.state), Some(LocalFileState::Own), "{shell}");
                let _ = fs::remove_dir_all(&root);
            }
        }

        fn scan_in(shell: &str) {
            let root = temp_dir("scan");
            let (home, app) = fixture(&root);
            age(&root);
            let status_before = git(&home, &app, &["status", "--porcelain"]);
            let repos = vec![app.display().to_string(), root.join("gone").display().to_string(), root.display().to_string()];
            let output = run(shell, &home, &scan_script(&repos, &[], false));
            assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
            let scanned = parse_scan(&String::from_utf8_lossy(&output.stdout), &HashMap::new(), Local::now().timestamp_millis());
            assert_eq!(scanned.home_dir, home.display().to_string());
            let [repo, gone, plain] = scanned.repos.as_slice() else { panic!("{shell}: {:?}", scanned.repos) };
            assert_eq!((gone.state, plain.state), (RepoState::Missing, RepoState::NotGit));
            assert_eq!(repo.state, RepoState::Ok);
            assert_eq!(repo.remote.as_deref(), Some(format!("{}", root.join("upstream").display()).as_str()));
            assert_eq!(repo.default_branch.as_deref(), Some("origin/main"));
            assert!(repo.fetched_at.is_some());
            assert_eq!(repo.files.iter().map(|file| file.name.as_str()).collect::<Vec<_>>(), vec![".claude/CLAUDE.md", "AGENTS.md"]);
            let find = |name: &str| repo.worktrees.iter().find(|worktree| worktree.path.ends_with(&format!("/{name}"))).unwrap_or_else(|| panic!("{shell}: {name}"));
            let main = find("app");
            assert!(main.main);
            assert_eq!((main.branch.as_deref(), main.ahead, main.behind, main.changed), (Some("main"), Some(0), Some(0), Some(0)));
            let done = find("done");
            assert_eq!((done.merged, done.blocker), (true, None), "{shell}");
            assert_eq!(done.ignored, vec![".env.local".to_string()]);
            let squashed = find("squashed");
            assert_eq!((squashed.merged, squashed.gone, squashed.blocker), (false, true, None), "{shell}");
            assert_eq!(find("busy").blocker, Some(Blocker::Dirty));
            assert_eq!(find("busy").untracked, Some(1));
            assert_eq!(find("unmerged").blocker, Some(Blocker::NotMerged));
            assert!(repo.worktrees.iter().all(|worktree| worktree.committed_at.is_some()));
            assert_eq!(git(&home, &app, &["status", "--porcelain"]), status_before);
            // A remote's user name, password and query never leave the machine.
            git(&home, &app, &["remote", "set-url", "origin", "https://cam:ghp_secret@Example.com/Owner/App.git?token=x"]);
            let output = run(shell, &home, &scan_script(&repos[..1], &[], false));
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(!stdout.contains("ghp_secret") && !stdout.contains("token=x"), "{shell}: {stdout}");
            let scanned = parse_scan(&stdout, &HashMap::new(), Local::now().timestamp_millis());
            assert_eq!(scanned.repos.first().and_then(|repo| repo.remote.as_deref()), Some("example.com/owner/app"));
            let _ = fs::remove_dir_all(&root);
        }

        #[test]
        fn removing_takes_only_what_is_still_safe_and_keeps_unmerged_branches() {
            for shell in shells() {
                remove_in(shell);
            }
        }

        fn remove_in(shell: &str) {
            let root = temp_dir("remove");
            let (home, app) = fixture(&root);
            age(&root);
            let repos = vec![app.display().to_string()];
            let output = run(shell, &home, &scan_script(&repos, &[], false));
            let now_ms = Local::now().timestamp_millis();
            let scanned = parse_scan(&String::from_utf8_lossy(&output.stdout), &HashMap::new(), now_ms);
            let projects = MachineProjects { scanned_at: Some(now_ms), repos: scanned.repos, ..MachineProjects::default() };
            let path = |name: &str| root.join(name).display().to_string();
            let head = |name: &str| git(&home, &root.join(name), &["rev-parse", "HEAD"]);
            let removals = ["done", "squashed", "moved"]
                .into_iter()
                .filter(|name| *name != "moved")
                .map(|name| WorktreeRemoval { repo: app.display().to_string(), path: path(name), head: head(name) })
                .collect();
            let mut planned = plan_removals(&projects, removals, now_ms).unwrap();
            // A worktree that gained a file after the scan is left where it is.
            fs::write(root.join("squashed/late.txt"), "late\n").unwrap();
            planned.push(PlannedRemoval { main: app.display().to_string(), path: path("unmerged"), head: "0".repeat(40), branch: Some("unmerged".into()), delete_branch: false });
            // One with another worktree inside it, which the scan never offers, is refused there too.
            git(&home, &app, &["worktree", "add", "-q", "-b", "outer", &path("outer")]);
            git(&home, &app, &["worktree", "add", "-q", "-b", "inner", &path("outer/.claude/worktrees/inner")]);
            age(&root);
            planned.push(PlannedRemoval { main: app.display().to_string(), path: path("outer"), head: head("outer"), branch: Some("outer".into()), delete_branch: true });
            let output = run(shell, &home, &remove_script(&planned));
            assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
            let results = parse_removals(&String::from_utf8_lossy(&output.stdout), &planned);
            let outcomes: Vec<(RemovalOutcome, Option<BranchOutcome>)> = results.iter().map(|result| (result.outcome, result.branch)).collect();
            assert_eq!(
                outcomes,
                vec![(RemovalOutcome::Removed, Some(BranchOutcome::Deleted)), (RemovalOutcome::Changed, None), (RemovalOutcome::Changed, None), (RemovalOutcome::Busy, None)],
                "{shell}: {results:?}"
            );
            assert!(!root.join("done").exists());
            assert!(root.join("squashed/late.txt").exists());
            assert!(root.join("unmerged/u.txt").exists());
            assert!(root.join("outer/.claude/worktrees/inner").exists());
            let branches = git(&home, &app, &["branch", "--format=%(refname:short)"]);
            assert!(!branches.lines().any(|branch| branch == "done"), "{shell}: {branches}");
            assert!(branches.lines().any(|branch| branch == "squashed"));
            assert!(branches.lines().any(|branch| branch == "unmerged"));
            let _ = fs::remove_dir_all(&root);
        }

        /// Merged, clean-looking worktrees that would still lose something: an edit git is told
        /// not to look at, a repo cloned into an ignored folder, a bisect under way, and a commit only
        /// the worktree's own history remembers. And a harmless one whose branch shares a tag's name.
        fn risky(root: &Path, home: &Path, app: &Path) {
            let path = |name: &str| root.join(name).display().to_string();
            for (name, branch) in [("hidden", "hidden"), ("vendored", "vendored"), ("bisect", "bisect"), ("tagged", "tagged")] {
                git(home, app, &["worktree", "add", "-q", "-b", branch, &path(name)]);
            }
            git(home, app, &["worktree", "add", "-q", "--detach", &path("reflog"), "main"]);
            git(home, &root.join("hidden"), &["update-index", "--assume-unchanged", "AGENTS.md"]);
            fs::write(root.join("hidden/AGENTS.md"), "edited\n").unwrap();
            fs::write(app.join(".git/info/exclude"), "vendor/\n").unwrap();
            fs::create_dir_all(root.join("vendored/vendor/lib")).unwrap();
            git(home, &root.join("vendored/vendor/lib"), &["init", "-q"]);
            fs::write(root.join("vendored/vendor/lib/work.txt"), "work\n").unwrap();
            git(home, &root.join("bisect"), &["bisect", "start"]);
            fs::write(root.join("reflog/try.txt"), "try\n").unwrap();
            git(home, &root.join("reflog"), &["add", "."]);
            git(home, &root.join("reflog"), &["commit", "-qm", "try"]);
            git(home, &root.join("reflog"), &["checkout", "-q", "--detach", "main"]);
            git(home, app, &["tag", "tagged"]);
        }

        #[test]
        fn worktrees_that_would_lose_something_are_never_offered_or_removed() {
            for shell in shells() {
                risky_in(shell);
            }
        }

        fn risky_in(shell: &str) {
            let root = temp_dir("risky");
            let (home, app) = fixture(&root);
            risky(&root, &home, &app);
            age(&root);
            let output = run(shell, &home, &scan_script(&[app.display().to_string()], &[], false));
            assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
            let scanned = parse_scan(&String::from_utf8_lossy(&output.stdout), &HashMap::new(), Local::now().timestamp_millis());
            let repo = scanned.repos.first().unwrap();
            let blocker_of = |name: &str| repo.worktrees.iter().find(|worktree| worktree.path.ends_with(&format!("/{name}"))).map(|worktree| worktree.blocker);
            assert_eq!(blocker_of("hidden"), Some(Some(Blocker::Hidden)), "{shell}");
            assert_eq!(blocker_of("vendored"), Some(Some(Blocker::Nested)), "{shell}");
            assert_eq!(blocker_of("bisect"), Some(Some(Blocker::Midway)), "{shell}");
            assert_eq!(blocker_of("reflog"), Some(Some(Blocker::Unreachable)), "{shell}");
            assert_eq!(blocker_of("tagged"), Some(None), "{shell}");
            // Asked to anyway, the machine refuses each one but the harmless one.
            let head = |name: &str| git(&home, &root.join(name), &["rev-parse", "HEAD"]);
            let planned: Vec<PlannedRemoval> = [("hidden", Some("hidden")), ("vendored", Some("vendored")), ("bisect", Some("bisect")), ("reflog", None), ("tagged", Some("tagged"))]
                .into_iter()
                .map(|(name, branch)| PlannedRemoval {
                    main: app.display().to_string(),
                    path: root.join(name).display().to_string(),
                    head: head(name),
                    branch: branch.map(str::to_string),
                    delete_branch: branch.is_some(),
                })
                .collect();
            let output = run(shell, &home, &remove_script(&planned));
            let results = parse_removals(&String::from_utf8_lossy(&output.stdout), &planned);
            let outcomes: Vec<RemovalOutcome> = results.iter().map(|result| result.outcome).collect();
            assert_eq!(
                outcomes,
                vec![RemovalOutcome::Changed, RemovalOutcome::Busy, RemovalOutcome::Changed, RemovalOutcome::Changed, RemovalOutcome::Removed],
                "{shell}: {results:?}"
            );
            assert_eq!(fs::read_to_string(root.join("hidden/AGENTS.md")).unwrap(), "edited\n");
            assert!(root.join("vendored/vendor/lib/work.txt").exists());
            assert!(root.join("bisect").exists() && root.join("reflog/.git").exists());
            assert!(!root.join("tagged").exists());
            let _ = fs::remove_dir_all(&root);
        }

        #[test]
        fn instruction_files_are_read_only_inside_their_checkout() {
            let root = temp_dir("inside");
            let repo = root.join("repo");
            fs::create_dir_all(repo.join("docs")).unwrap();
            fs::create_dir_all(root.join("outside/.claude")).unwrap();
            fs::write(repo.join("docs/AGENTS.md"), "a\n").unwrap();
            fs::write(root.join("secret.txt"), "s\n").unwrap();
            fs::write(root.join("outside/.claude/CLAUDE.md"), "s\n").unwrap();
            std::os::unix::fs::symlink("docs/AGENTS.md", repo.join("AGENTS.md")).unwrap();
            std::os::unix::fs::symlink("../secret.txt", repo.join("CLAUDE.md")).unwrap();
            std::os::unix::fs::symlink("../outside/.claude", repo.join(".claude")).unwrap();
            let script = format!(
                "{INSIDE_REPO}for name in AGENTS.md CLAUDE.md .claude/CLAUDE.md; do if found=$(inside_repo {} \"$name\"); then printf 'yes %s %s\\n' \"$name\" \"$found\"; else printf 'no %s\\n' \"$name\"; fi; done\n",
                shell_quote(&repo.display().to_string())
            );
            for shell in shells() {
                let output = run(shell, &root, &script);
                let stdout = String::from_utf8_lossy(&output.stdout);
                assert_eq!(
                    stdout.lines().collect::<Vec<_>>(),
                    vec![format!("yes AGENTS.md {}/docs/AGENTS.md", repo.display()).as_str(), "no CLAUDE.md", "no .claude/CLAUDE.md"],
                    "{shell}"
                );
            }
            let _ = fs::remove_dir_all(&root);
        }

        #[test]
        fn measuring_counts_each_folder() {
            let root = temp_dir("measure");
            fs::create_dir_all(root.join("a")).unwrap();
            fs::write(root.join("a/file"), vec![0u8; 64 * 1024]).unwrap();
            for shell in shells() {
                let output = run(shell, &root, &measure_script(&[root.join("a").display().to_string(), root.join("nope").display().to_string()]));
                let sizes = parse_sizes(&String::from_utf8_lossy(&output.stdout));
                assert_eq!(sizes.len(), 1, "{shell}");
                assert!(sizes.get(&root.join("a").display().to_string()).is_some_and(|size| *size >= 64), "{shell}: {sizes:?}");
            }
            let _ = fs::remove_dir_all(&root);
        }
    }
}

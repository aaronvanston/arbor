//! Keeps the setup repo on this Mac in step with its remote, so a change made on another computer reaches the machines
//! and Arbor's own commits reach the remote without anyone pressing Pull or Push.
//!
//! A round fetches, then fast-forwards when the repo is only behind and the files it syncs have no changes waiting,
//! and pushes when it's only ahead. Nothing else is ever done to the repo: never a merge, a rebase or a force. A repo
//! ahead and behind at once, synced files changed and not committed, or a fetch or push the remote refused is left as
//! it is and said, so the user can sort it out with the Pull and Push buttons or a terminal.
//!
//! Rounds run a minute after launch, every 15 minutes, after Arbor commits to the repo itself, and when the window comes
//! back to the front after five minutes or more. Only a repo whose branch follows a remote branch takes part, and the
//! setting `KEEP_SETTING` (Settings › Machines › Sync) turns all of it off.

use super::setup_layers::SETUP_REPO_SETTING;
use super::setup_sync::{git, read_repo, GIT_TIMEOUT};
use super::*;
use std::sync::LazyLock;
use tokio::sync::Notify;
use ts_rs::TS;

/// The window's switch: "false" turns the keeper off; anything else, or nothing saved yet, leaves it on.
pub(super) const KEEP_SETTING: &str = "arbor.setup.keepInStep.v1";
pub(crate) const REPO_KEEPER_EVENT: &str = "setup-repo-keeper";
/// Sent when a round fast-forwarded the repo, so pages read it and the machines' standing again.
pub(crate) const SETUP_REPO_UPDATED_EVENT: &str = "setup-repo-updated";

const FIRST_ROUND: Duration = Duration::from_secs(60);
const ROUND_EVERY: Duration = Duration::from_secs(15 * 60);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(90);

/// Why a round left the repo as it was.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum KeepProblem {
    /// The repo and its remote each have commits the other hasn't.
    Diverged,
    /// Synced files have changes that aren't committed, so pulling could lose them.
    Dirty,
    /// The remote turned down the sign-in, or asked for one nobody could give.
    Auth,
    /// The remote couldn't be reached.
    Network,
    /// Git said something else went wrong; `detail` has its words.
    Failed,
}

/// How the keeper last found the repo.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoKeeper {
    /// Keeping in step is switched on.
    enabled: bool,
    /// The repo's folder, once the window has named one.
    repo: Option<String>,
    /// The remote branch it follows, like `origin/main`; None when it follows none, which leaves it to the buttons.
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    last_fetch_ms: Option<i64>,
    last_pull_ms: Option<i64>,
    last_push_ms: Option<i64>,
    /// When the last round finished.
    checked_ms: Option<i64>,
    problem: Option<KeepProblem>,
    /// Git's own words for a problem, when they say more than the kind does.
    detail: Option<String>,
    /// A round is under way.
    running: bool,
}

static STATE: LazyLock<std::sync::Mutex<RepoKeeper>> = LazyLock::new(|| std::sync::Mutex::new(RepoKeeper { enabled: true, ..RepoKeeper::default() }));
/// Wakes the loop for a round now: Arbor committed to the repo, or the window asked.
static WAKE: LazyLock<Notify> = LazyLock::new(Notify::new);
/// One round at a time.
static ROUND: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn state() -> std::sync::MutexGuard<'static, RepoKeeper> {
    STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Called by `setup_sync::git` after any commit it made: one in the setup repo wakes a round to push it, and one in any
/// other repo (a hub, a project) is none of the keeper's business. Before the first round names the repo, the round a
/// minute after launch pushes it anyway.
pub(super) fn committed(folder: &Path) {
    let repo = state().repo.clone();
    if repo.is_some_and(|repo| same_folder(Path::new(&repo), folder)) {
        WAKE.notify_one();
    }
}

fn same_folder(a: &Path, b: &Path) -> bool {
    a == b || matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(a), Ok(b)) if a == b)
}

/// Pushes, never forced. When the remote turned it down for having moved since the fetch, fetches once more and tries
/// again if the repo is still only ahead; otherwise they've diverged.
async fn push(folder: &Path) -> Result<(), (KeepProblem, Option<String>)> {
    for attempt in 0..2 {
        let output = git(folder, &["push", "--quiet"], NETWORK_TIMEOUT).await.map_err(|error| (KeepProblem::Network, Some(error)))?;
        if output.status.success() {
            return Ok(());
        }
        let detail = complaint(&output);
        let said = String::from_utf8_lossy(&output.stderr);
        if !["rejected", "fetch first", "non-fast-forward"].iter().any(|sign| said.contains(sign)) {
            return Err((classify(&detail), Some(detail)));
        }
        let fetched = git(folder, &["fetch", "--quiet"], NETWORK_TIMEOUT).await.is_ok_and(|output| output.status.success());
        let still_ahead_only = fetched && counts(folder).await.is_some_and(|(behind, ahead)| behind == 0 && ahead > 0);
        if attempt == 1 || !still_ahead_only {
            return Err((KeepProblem::Diverged, Some(detail)));
        }
    }
    Err((KeepProblem::Diverged, None))
}

/// What git's words for a failed fetch or push mean. They're another program's text, so matching on them is the only way.
fn classify(stderr: &str) -> KeepProblem {
    let text = stderr.to_ascii_lowercase();
    let auth = ["authentication failed", "permission denied", "could not read username", "terminal prompts disabled", "access denied", "403", "401"];
    let network = ["could not resolve host", "unable to access", "connection refused", "connection timed out", "timed out", "network is unreachable", "could not read from remote"];
    if auth.iter().any(|sign| text.contains(sign)) {
        KeepProblem::Auth
    } else if network.iter().any(|sign| text.contains(sign)) {
        KeepProblem::Network
    } else {
        KeepProblem::Failed
    }
}

/// Git's last line of complaint, without its hints.
fn complaint(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("hint:"))
        .last()
        .map_or_else(|| format!("git exited with {}", output.status), str::to_string)
}

async fn git_text(folder: &Path, args: &[&str]) -> Option<String> {
    let output = git(folder, args, GIT_TIMEOUT).await.ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The repo's branch against the remote branch it follows: (behind, ahead), as of the last fetch.
async fn counts(folder: &Path) -> Option<(u32, u32)> {
    let text = git_text(folder, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]).await?;
    let (behind, ahead) = text.split_once('\t')?;
    Some((behind.parse().ok()?, ahead.parse().ok()?))
}

/// One round on the repo in `folder`, from what was known before (`last`): fetch, then fast-forward or push when
/// that's all it takes, else say why not.
pub(super) async fn round(folder: &Path, last: &RepoKeeper, now_ms: i64) -> (RepoKeeper, bool) {
    let mut next = RepoKeeper { enabled: true, repo: Some(folder.display().to_string()), running: false, problem: None, detail: None, checked_ms: Some(now_ms), ..last.clone() };
    let Some(upstream) = git_text(folder, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).await.filter(|name| !name.is_empty()) else {
        return (RepoKeeper { upstream: None, ahead: 0, behind: 0, ..next }, false);
    };
    next.upstream = Some(upstream);
    let fail = |mut next: RepoKeeper, problem: KeepProblem, detail: Option<String>| {
        next.problem = Some(problem);
        next.detail = detail;
        next
    };
    match git(folder, &["fetch", "--quiet"], NETWORK_TIMEOUT).await {
        Ok(output) if output.status.success() => next.last_fetch_ms = Some(now_ms),
        Ok(output) => {
            let detail = complaint(&output);
            return (fail(next, classify(&detail), Some(detail)), false);
        }
        Err(error) => return (fail(next, KeepProblem::Network, Some(error)), false),
    }
    let Some((behind, ahead)) = counts(folder).await else { return (fail(next, KeepProblem::Failed, None), false) };
    (next.behind, next.ahead) = (behind, ahead);
    if ahead > 0 && behind > 0 {
        return (fail(next, KeepProblem::Diverged, None), false);
    }
    if behind > 0 {
        let dirty = read_repo(folder).await.map(|repo| !repo.uncommitted_files().is_empty()).unwrap_or(true);
        if dirty {
            return (fail(next, KeepProblem::Dirty, None), false);
        }
        return match git(folder, &["merge", "--ff-only", "--quiet", "@{u}"], GIT_TIMEOUT).await {
            Ok(output) if output.status.success() => (RepoKeeper { behind: 0, last_pull_ms: Some(now_ms), ..next }, true),
            Ok(output) => {
                let detail = complaint(&output);
                let problem = if detail.contains("overwritten") || detail.contains("uncommitted") { KeepProblem::Dirty } else { KeepProblem::Failed };
                (fail(next, problem, Some(detail)), false)
            }
            Err(error) => (fail(next, KeepProblem::Failed, Some(error)), false),
        };
    }
    if ahead > 0 {
        return match push(folder).await {
            Ok(()) => (RepoKeeper { ahead: 0, last_push_ms: Some(now_ms), ..next }, false),
            Err((problem, detail)) => {
                let (behind, ahead) = counts(folder).await.unwrap_or((next.behind, next.ahead));
                (fail(RepoKeeper { behind, ahead, ..next }, problem, detail), false)
            }
        };
    }
    (next, false)
}

/// Whether the window's switch leaves keeping in step on.
fn enabled(app: &tauri::AppHandle) -> bool {
    app.state::<crate::saved_store::SavedStoreState>().value(KEEP_SETTING).is_none_or(|value| value.trim() != "false")
}

/// The setup repo: the one the window last named, else the one its saved setting names.
fn repo_folder(app: &tauri::AppHandle) -> Option<String> {
    let named = app.state::<MachineHealthState>().lock().setup_repo.clone();
    named.or_else(|| app.state::<crate::saved_store::SavedStoreState>().value(SETUP_REPO_SETTING)).filter(|repo| !repo.is_empty())
}

/// Runs a round now, unless one is under way or it's switched off, and tells the window how it went.
async fn run(app: &tauri::AppHandle) -> RepoKeeper {
    let Ok(_round) = ROUND.try_lock() else { return state().clone() };
    if !enabled(app) {
        let off = RepoKeeper { enabled: false, repo: repo_folder(app), ..state().clone() };
        *state() = off.clone();
        let _ = app.emit(REPO_KEEPER_EVENT, &off);
        return off;
    }
    let Some(folder) = repo_folder(app) else { return state().clone() };
    let last = {
        let mut held = state();
        held.running = true;
        held.enabled = true;
        held.clone()
    };
    let _ = app.emit(REPO_KEEPER_EVENT, &last);
    let (next, pulled) = round(Path::new(&folder), &last, Local::now().timestamp_millis()).await;
    *state() = next.clone();
    let _ = app.emit(REPO_KEEPER_EVENT, &next);
    if pulled {
        let _ = app.emit(SETUP_REPO_UPDATED_EVENT, Local::now().timestamp_millis());
        // The machines are behind the repo now, and their bases are worth recording without the window.
        super::setup_standing::refresh(app).await;
    }
    next
}

/// Starts the rounds: a minute after launch, every 15 minutes, and whenever Arbor commits to the repo.
pub(crate) fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_ROUND).await;
        loop {
            run(&app).await;
            tokio::select! {
                _ = tokio::time::sleep(ROUND_EVERY) => {}
                _ = WAKE.notified() => {}
            }
        }
    });
}

/// How the keeper last found the setup repo.
#[tauri::command]
pub(crate) async fn get_setup_repo_keeper(app: tauri::AppHandle) -> Result<RepoKeeper, String> {
    let mut found = state().clone();
    found.enabled = enabled(&app);
    if found.repo.is_none() {
        found.repo = repo_folder(&app);
    }
    Ok(found)
}

/// A round now: always when `older_than_ms` is none, else only when the last fetch is older than that (the window
/// coming back to the front passes five minutes). Turning the switch on asks for one too.
#[tauri::command]
pub(crate) async fn keep_setup_repo_now(app: tauri::AppHandle, older_than_ms: Option<i64>) -> Result<RepoKeeper, String> {
    let age = older_than_ms.unwrap_or(0).max(0);
    let last = state().last_fetch_ms;
    if age > 0 && last.is_some_and(|at| Local::now().timestamp_millis() - at < age) {
        return get_setup_repo_keeper(app).await;
    }
    Ok(run(&app).await)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Command;

    fn temp(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("arbor-keeper-{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git_in(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=Cam", "-c", "user.email=cam@example.com", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    fn write(dir: &Path, rel: &str, text: &str) {
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// A bare remote on disk, this Mac's clone of it, and another computer's clone that pushes to it. Never the network.
    fn three() -> (PathBuf, PathBuf, PathBuf) {
        let root = temp("repos");
        let (remote, mine, theirs) = (root.join("remote.git"), root.join("mine"), root.join("theirs"));
        git_in(&root, &["init", "--quiet", "--bare", remote.to_str().unwrap()]);
        fs::create_dir_all(&mine).unwrap();
        git_in(&mine, &["init", "--quiet"]);
        git_in(&mine, &["remote", "add", "origin", remote.to_str().unwrap()]);
        write(&mine, ".claude/CLAUDE.md", "start\n");
        git_in(&mine, &["add", "-A"]);
        git_in(&mine, &["commit", "--quiet", "-m", "Start"]);
        git_in(&mine, &["push", "--quiet", "-u", "origin", "HEAD:main"]);
        git_in(&root, &["clone", "--quiet", remote.to_str().unwrap(), theirs.to_str().unwrap()]);
        (remote, mine, theirs)
    }

    fn commit(dir: &Path, rel: &str, text: &str, message: &str) {
        write(dir, rel, text);
        git_in(dir, &["add", "-A"]);
        git_in(dir, &["commit", "--quiet", "-m", message]);
    }

    fn head(dir: &Path) -> String {
        String::from_utf8(Command::new("git").arg("-C").arg(dir).args(["rev-parse", "HEAD"]).output().unwrap().stdout).unwrap().trim().to_string()
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn a_repo_only_behind_fast_forwards_and_one_only_ahead_pushes() {
        let (remote, mine, theirs) = three();
        commit(&theirs, ".claude/CLAUDE.md", "theirs\n", "From the other computer");
        git_in(&theirs, &["push", "--quiet"]);
        let (found, pulled) = block_on(round(&mine, &RepoKeeper::default(), 10));
        assert!(pulled);
        assert_eq!((found.problem, found.behind, found.last_fetch_ms, found.last_pull_ms), (None, 0, Some(10), Some(10)));
        assert_eq!(found.upstream.as_deref(), Some("origin/main"));
        assert_eq!(head(&mine), head(&theirs));

        commit(&mine, ".claude/rules/style.md", "mine\n", "Arbor's switch");
        let (pushed, pulled) = block_on(round(&mine, &found, 20));
        assert!(!pulled);
        assert_eq!((pushed.problem, pushed.ahead, pushed.last_push_ms), (None, 0, Some(20)));
        assert_eq!(head(&remote), head(&mine));
    }

    #[test]
    fn diverged_or_dirty_is_left_alone_and_said() {
        let (_remote, mine, theirs) = three();
        commit(&theirs, ".claude/CLAUDE.md", "theirs\n", "Theirs");
        git_in(&theirs, &["push", "--quiet"]);
        // Synced files changed and not committed: a pull could lose them.
        write(&mine, ".claude/CLAUDE.md", "edited, not committed\n");
        let before = head(&mine);
        let (dirty, pulled) = block_on(round(&mine, &RepoKeeper::default(), 1));
        assert_eq!((dirty.problem, dirty.behind, pulled), (Some(KeepProblem::Dirty), 1, false));
        assert_eq!(head(&mine), before);

        git_in(&mine, &["checkout", "--quiet", "--", "."]);
        commit(&mine, ".claude/rules/mine.md", "mine\n", "Mine");
        let mine_head = head(&mine);
        let (diverged, _) = block_on(round(&mine, &dirty, 2));
        assert_eq!((diverged.problem, diverged.ahead, diverged.behind), (Some(KeepProblem::Diverged), 1, 1));
        assert_eq!(head(&mine), mine_head, "never merged or rebased");
        // What was known before stays known: the last fetch is this round's, the last pull nobody's.
        assert_eq!((diverged.last_fetch_ms, diverged.last_pull_ms), (Some(2), None));
    }

    #[test]
    fn a_push_the_remote_turns_down_fetches_once_and_says_diverged_when_it_still_cant_fast_forward() {
        let (_remote, mine, theirs) = three();
        commit(&mine, ".claude/rules/mine.md", "mine\n", "Mine");
        // The other computer pushes after this Mac's fetch: the push is turned down.
        commit(&theirs, ".claude/CLAUDE.md", "theirs\n", "Theirs");
        git_in(&theirs, &["push", "--quiet"]);
        let result = block_on(push(&mine));
        assert!(matches!(result, Err((KeepProblem::Diverged, Some(_)))), "{result:?}");
        assert_eq!(block_on(counts(&mine)), Some((1, 1)), "it fetched again to see why");
    }

    #[test]
    fn only_a_commit_in_the_setup_repo_wakes_a_round() {
        let (_remote, mine, theirs) = three();
        state().repo = Some(mine.display().to_string());
        assert!(same_folder(&mine, &mine.join(".")));
        assert!(!same_folder(&mine, &theirs));
    }

    #[test]
    fn a_repo_with_no_remote_branch_is_left_to_the_buttons_and_a_failed_fetch_says_why() {
        let lone = temp("lone");
        git_in(&lone, &["init", "--quiet"]);
        commit(&lone, ".claude/CLAUDE.md", "x\n", "Start");
        let (found, _) = block_on(round(&lone, &RepoKeeper::default(), 1));
        assert_eq!((found.upstream, found.problem, found.last_fetch_ms), (None, None, None));

        let (remote, mine, _) = three();
        fs::remove_dir_all(&remote).unwrap();
        let (failed, _) = block_on(round(&mine, &RepoKeeper::default(), 3));
        assert!(matches!(failed.problem, Some(KeepProblem::Failed | KeepProblem::Network)), "{failed:?}");
        assert!(failed.detail.is_some() && failed.last_fetch_ms.is_none());
    }

    #[test]
    fn gits_words_are_read_as_sign_in_or_network_trouble() {
        assert_eq!(classify("fatal: Authentication failed for 'https://github.com/cam/agent-setup.git/'"), KeepProblem::Auth);
        assert_eq!(classify("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), KeepProblem::Auth);
        assert_eq!(classify("ssh: Could not resolve host github.com"), KeepProblem::Network);
        assert_eq!(classify("error: something else"), KeepProblem::Failed);
    }
}

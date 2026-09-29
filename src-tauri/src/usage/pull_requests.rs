//! Whether the pull requests sessions worked on have merged, and for open ones
//! how their checks, reviews and merging stand, from GitHub through the GitHub
//! CLI when it's installed and signed in. Only each pull request's repository
//! and number go to GitHub, in one GraphQL query for all of them. The answers
//! are kept in usage.db, so a merged pull request is asked about once and an
//! open one every so often.

use super::machine_health::transcripts::PullRequestLink;
use ts_rs::TS;
use super::*;
use std::process::Stdio;

/// How long an open pull request's state is trusted before it's asked about again.
const OPEN_RECHECK_MS: i64 = 15 * 60_000;
/// A closed pull request can reopen, and one GitHub couldn't find may be in a
/// repository the CLI can see later: both are asked about again daily.
const SETTLED_RECHECK_MS: i64 = 86_400_000;
/// At most this many pull requests are asked about at once.
const CHECK_LIMIT: usize = 100;
/// After a check, the next one waits this long unless it's asked for.
const CHECK_INTERVAL_MS: i64 = 30_000;
/// After the CLI fails, the next check waits this long unless it's asked for.
const FAILURE_BACKOFF_MS: i64 = 10 * 60_000;
const GH_TIMEOUT: Duration = Duration::from_secs(20);
const TITLE_CHARS: usize = 300;
const BRANCH_CHARS: usize = 255;
const MESSAGE_CHARS: usize = 300;

/// A pull request to ask GitHub about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct PullRequestRef {
    /// "owner/name".
    pub(super) repository: String,
    pub(super) number: u64,
}

/// What GitHub last said about a pull request.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequestState {
    /// "open", "merged" or "closed". Empty when GitHub couldn't find it.
    #[ts(type = r#""" | "open" | "merged" | "closed""#)]
    state: String,
    draft: bool,
    title: String,
    /// The branch it merges from, and the one it merges into.
    #[serde(skip)]
    head_branch: String,
    base_branch: String,
    merged_at_ms: Option<i64>,
    closed_at_ms: Option<i64>,
    /// "mergeable" or "conflicting". Empty while GitHub is still working it
    /// out, and when it didn't say.
    #[ts(type = r#""" | "mergeable" | "conflicting""#)]
    mergeable: String,
    /// "approved", "changesRequested" or "reviewRequired". Empty when there's
    /// no verdict and none is required. An approval counts even when the
    /// branch's rules don't.
    #[ts(type = r#""" | "approved" | "changesRequested" | "reviewRequired""#)]
    review: String,
    /// The checks on its latest commit. None without any, or when GitHub didn't say.
    checks: Option<PullRequestChecks>,
    checked_at_ms: i64,
}

/// The checks on a pull request's latest commit: check runs and commit
/// statuses together.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequestChecks {
    /// GitHub's word for them all: "success", "failure", "error", "pending"
    /// or "expected". Empty when it gave none.
    #[ts(type = r#""" | "success" | "failure" | "error" | "pending" | "expected""#)]
    rollup: String,
    passed: u32,
    /// Failed, errored, timed out or canceled.
    failed: u32,
    /// Queued, running, or waiting for someone.
    pending: u32,
    /// All of them, skipped and neutral ones too. 0 when GitHub didn't count them.
    total: u32,
}

impl PullRequestChecks {
    /// Whether GitHub said anything about them: a commit without checks has neither.
    fn is_known(&self) -> bool {
        !self.rollup.is_empty() || self.total > 0
    }
}

impl PullRequestState {
    /// The branch its work was done on, when GitHub says and it isn't the
    /// branch it merges into, as a pull request from a fork's main would be.
    pub(super) fn work_branch(&self) -> Option<&str> {
        (!self.head_branch.is_empty() && self.head_branch != self.base_branch)
            .then_some(self.head_branch.as_str())
    }

    /// When it merged, if GitHub has said it has.
    pub(super) fn merged_at_ms(&self) -> Option<i64> {
        self.merged_at_ms.filter(|_| self.state == "merged")
    }
}

/// The key pull request states are kept under: GitHub doesn't mind the case of
/// a repository's name.
pub(super) fn state_key(repository: &str, number: u64) -> (String, u64) {
    (repository.to_ascii_lowercase(), number)
}

/// Whether a pull request should be asked about, given what was said last.
pub(super) fn is_due(state: Option<&PullRequestState>, now_ms: i64) -> bool {
    let Some(state) = state else {
        return true;
    };
    let age = now_ms.saturating_sub(state.checked_at_ms);
    match state.state.as_str() {
        "merged" => false,
        "open" => age >= OPEN_RECHECK_MS,
        _ => age >= SETTLED_RECHECK_MS,
    }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// Every pull request state on record, by `state_key`.
pub(super) fn load_states(connection: &Connection) -> Result<HashMap<(String, u64), PullRequestState>, String> {
    let mut statement = connection
        .prepare(
            "SELECT repository, number, state, draft, title, head_branch, base_branch, merged_at_ms, closed_at_ms, checked_at_ms,
                mergeable, review, checks_rollup, checks_passed, checks_failed, checks_pending, checks_total
             FROM usage_pull_requests",
        )
        .map_err(|error| format!("Failed to read pull requests: {error}"))?;
    let count = |value: i64| u32::try_from(value.max(0)).unwrap_or(u32::MAX);
    let rows = statement
        .query_map([], |row| {
            let checks = PullRequestChecks {
                rollup: row.get(12)?,
                passed: count(row.get(13)?),
                failed: count(row.get(14)?),
                pending: count(row.get(15)?),
                total: count(row.get(16)?),
            };
            Ok((
                state_key(&row.get::<_, String>(0)?, u64::try_from(row.get::<_, i64>(1)?).unwrap_or(0)),
                PullRequestState {
                    state: row.get(2)?,
                    draft: row.get(3)?,
                    title: row.get(4)?,
                    head_branch: row.get(5)?,
                    base_branch: row.get(6)?,
                    merged_at_ms: row.get(7)?,
                    closed_at_ms: row.get(8)?,
                    mergeable: row.get(10)?,
                    review: row.get(11)?,
                    checks: checks.is_known().then_some(checks),
                    checked_at_ms: row.get(9)?,
                },
            ))
        })
        .map_err(|error| format!("Failed to read pull requests: {error}"))?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| format!("Failed to read pull requests: {error}"))
}

fn store_states(connection: &mut Connection, states: &[(PullRequestRef, PullRequestState)]) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start pull request write: {error}"))?;
    {
        let mut upsert = transaction
            .prepare(
                "INSERT INTO usage_pull_requests
                 (repository, number, state, draft, title, head_branch, base_branch, merged_at_ms, closed_at_ms, checked_at_ms,
                  mergeable, review, checks_rollup, checks_passed, checks_failed, checks_pending, checks_total)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                 ON CONFLICT(repository, number) DO UPDATE SET
                    state = excluded.state, draft = excluded.draft, title = excluded.title,
                    head_branch = excluded.head_branch, base_branch = excluded.base_branch,
                    merged_at_ms = excluded.merged_at_ms, closed_at_ms = excluded.closed_at_ms,
                    checked_at_ms = excluded.checked_at_ms, mergeable = excluded.mergeable, review = excluded.review,
                    checks_rollup = excluded.checks_rollup, checks_passed = excluded.checks_passed,
                    checks_failed = excluded.checks_failed, checks_pending = excluded.checks_pending,
                    checks_total = excluded.checks_total",
            )
            .map_err(|error| format!("Failed to prepare pull request write: {error}"))?;
        for (pull_request, state) in states {
            let checks = state.checks.clone().unwrap_or_default();
            upsert
                .execute(params![
                    pull_request.repository,
                    i64::try_from(pull_request.number).unwrap_or(i64::MAX),
                    state.state,
                    state.draft,
                    state.title,
                    state.head_branch,
                    state.base_branch,
                    state.merged_at_ms,
                    state.closed_at_ms,
                    state.checked_at_ms,
                    state.mergeable,
                    state.review,
                    checks.rollup,
                    checks.passed,
                    checks.failed,
                    checks.pending,
                    checks.total,
                ])
                .map_err(|error| format!("Failed to store a pull request: {error}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to store pull requests: {error}"))
}

// ---------------------------------------------------------------------------
// Asking GitHub
// ---------------------------------------------------------------------------

/// How the checks with GitHub are going, for the Projects view.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GithubStatus {
    /// True while pull requests are being asked about.
    checking: bool,
    /// How the last check went: "ok", "missing" when the GitHub CLI isn't
    /// installed, "signedOut", or "failed". Empty before the first.
    last: String,
    /// What went wrong, for "failed".
    message: String,
    /// Why GitHub didn't say how checks, reviews and merging stand, when it
    /// turned down asking and answered only whether they merged.
    detail_error: String,
    /// When the last check finished.
    at_ms: Option<i64>,
}

struct Checks {
    running: bool,
    started_at_ms: i64,
    last: GithubStatus,
}

static CHECKS: Mutex<Checks> = Mutex::new(Checks {
    running: false,
    started_at_ms: 0,
    last: GithubStatus {
        checking: false,
        last: String::new(),
        message: String::new(),
        detail_error: String::new(),
        at_ms: None,
    },
});

fn lock_checks() -> MutexGuard<'static, Checks> {
    CHECKS.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(super) fn github_status() -> GithubStatus {
    let checks = lock_checks();
    GithubStatus {
        checking: checks.running,
        ..checks.last.clone()
    }
}

/// A pull request a session named, with what GitHub said about it last.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NamedPullRequest {
    url: String,
    /// None until GitHub has been asked about it.
    github: Option<PullRequestState>,
}

#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NamedPullRequests {
    /// In the order they were asked for.
    pull_requests: Vec<NamedPullRequest>,
    github: GithubStatus,
}

/// What GitHub last said about the pull requests a session named, for its
/// page. Those due are asked about again in the background, as the Projects
/// view would.
#[tauri::command]
pub(crate) async fn get_pull_request_states(pull_requests: Vec<PullRequestLink>) -> Result<NamedPullRequests, String> {
    let now_ms = Local::now().timestamp_millis();
    let (named, due) = run_usage_task(move || {
        let states = load_states(&open_usage_database()?)?;
        Ok(named_pull_requests(&pull_requests, &states, now_ms))
    })
    .await?;
    start_check(due, false, now_ms);
    Ok(NamedPullRequests {
        pull_requests: named,
        github: github_status(),
    })
}

/// Each pull request with its state on record, and those GitHub should be asked about.
fn named_pull_requests(
    links: &[PullRequestLink],
    states: &HashMap<(String, u64), PullRequestState>,
    now_ms: i64,
) -> (Vec<NamedPullRequest>, Vec<PullRequestRef>) {
    let mut due = Vec::new();
    let named = links
        .iter()
        .map(|link| {
            let repository = link.repository();
            let github = repository
                .as_ref()
                .and_then(|repository| states.get(&state_key(repository, link.number())))
                .cloned();
            if let Some(repository) = repository {
                if link.url().starts_with("https://github.com/") && is_due(github.as_ref(), now_ms) {
                    due.push(PullRequestRef {
                        repository,
                        number: link.number(),
                    });
                }
            }
            NamedPullRequest {
                url: link.url().to_string(),
                github,
            }
        })
        .collect();
    (named, due)
}

/// Asks GitHub about these pull requests in the background, unless a check is
/// running or the last one was too recent. `now` doesn't wait.
pub(super) fn start_check(pull_requests: Vec<PullRequestRef>, now: bool, now_ms: i64) {
    if pull_requests.is_empty() {
        return;
    }
    {
        let mut checks = lock_checks();
        let wait = if checks.last.last.is_empty() || checks.last.last == "ok" {
            CHECK_INTERVAL_MS
        } else {
            FAILURE_BACKOFF_MS
        };
        if checks.running || (!now && checks.started_at_ms > 0 && now_ms - checks.started_at_ms < wait) {
            return;
        }
        checks.running = true;
        checks.started_at_ms = now_ms;
    }
    tauri::async_runtime::spawn(async move {
        let outcome = check_with_github(pull_requests).await;
        let mut checks = lock_checks();
        checks.running = false;
        checks.last = GithubStatus {
            checking: false,
            last: outcome.last.to_string(),
            message: outcome.message,
            detail_error: outcome.detail_error,
            at_ms: Some(Local::now().timestamp_millis()),
        };
    });
}

/// Where the GitHub CLI is: on the PATH, else where its installers put it. An
/// app opened from the Dock gets a short PATH, so those places are looked in too.
pub(crate) fn gh_cli() -> Option<PathBuf> {
    let name = "gh";
    let path = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    path.into_iter()
        .chain(
            [
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/run/current-system/sw/bin",
                r"C:\Program Files\GitHub CLI",
            ]
            .map(PathBuf::from),
        )
        .chain(home.iter().flat_map(|home| [home.join(".local/bin"), home.join(".nix-profile/bin"), home.join("bin")]))
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}

/// How a check with GitHub went, as `GithubStatus` tells it.
struct Outcome {
    last: &'static str,
    message: String,
    detail_error: String,
}

impl Outcome {
    fn new(last: &'static str, message: String) -> Self {
        Self {
            last,
            message,
            detail_error: String::new(),
        }
    }
}

/// What one run of the GitHub CLI came back with.
enum Answer {
    States(Vec<(PullRequestRef, PullRequestState)>),
    /// GitHub turned the query down whole, with this for its first reason.
    Refused(String),
    /// The CLI couldn't ask, as `GithubStatus::last` and what went wrong.
    Failed(&'static str, String),
}

/// Asks GitHub about the pull requests and stores what it says.
async fn check_with_github(pull_requests: Vec<PullRequestRef>) -> Outcome {
    let Some(cli) = gh_cli() else {
        return Outcome::new("missing", String::new());
    };
    let plan = query_plan(&pull_requests);
    if plan.is_empty() {
        return Outcome::new("ok", String::new());
    }
    let (states, detail_error) = match ask_github(&cli, &plan, true).await {
        Answer::States(states) => (states, String::new()),
        // GitHub's schema can drop or rename a field, and each field more is
        // something a query can fail on. Whether they merged is what the
        // Projects view is built on, so that's asked again on its own.
        Answer::Refused(reason) => match ask_github(&cli, &plan, false).await {
            Answer::States(states) => (states, reason),
            Answer::Refused(reason) => return Outcome::new("failed", reason),
            Answer::Failed(last, message) => return Outcome::new(last, message),
        },
        Answer::Failed(last, message) => return Outcome::new(last, message),
    };
    let stored = run_usage_task(move || {
        let _write_guard = lock_usage_writes();
        store_states(&mut open_usage_database()?, &states)
    })
    .await;
    match stored {
        Ok(()) => Outcome {
            last: "ok",
            message: String::new(),
            detail_error,
        },
        Err(error) => Outcome::new("failed", capped(&error, MESSAGE_CHARS)),
    }
}

/// One run of `gh api graphql` for every pull request in the plan, with or
/// without their checks, reviews and merging.
async fn ask_github(cli: &Path, plan: &[(String, Vec<u64>)], details: bool) -> Answer {
    let mut command = tokio::process::Command::new(cli);
    command
        .args(["api", "--hostname", "github.com", "graphql", "-f"])
        .arg(format!("query={}", graphql_query(plan, details)))
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    machine_health::shell::configure_helper_command(&mut command);
    let output = match tokio::time::timeout(GH_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Answer::Failed("failed", capped(&error.to_string(), MESSAGE_CHARS)),
        Err(_) => return Answer::Failed("failed", "GitHub didn't answer in time.".into()),
    };
    let now_ms = Local::now().timestamp_millis();
    let stdout = String::from_utf8_lossy(&output.stdout);
    // A pull request GitHub can't find is an error beside the others' answers, so
    // what's printed is read whatever the exit status.
    if let Some(states) = parse_response(plan, &stdout, now_ms) {
        return Answer::States(states);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if signed_out(output.status.code(), &stderr) {
        return Answer::Failed("signedOut", String::new());
    }
    if let Some(reason) = refusal(&stdout) {
        return Answer::Refused(reason);
    }
    let message = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.strip_prefix("gh: ").unwrap_or(line).to_string())
        .unwrap_or_else(|| output.status.to_string());
    Answer::Failed("failed", capped(&message, MESSAGE_CHARS))
}

/// GitHub's first reason, when it answered with errors and no data at all: it
/// turned the whole query down, as it does for a field its schema doesn't
/// have, rather than failing to find some of what was asked.
fn refusal(stdout: &str) -> Option<String> {
    let response = serde_json::from_str::<Value>(stdout).ok()?;
    if response.get("data").is_some_and(|data| !data.is_null()) {
        return None;
    }
    let message = response
        .get("errors")?
        .as_array()?
        .iter()
        .find_map(|error| error.get("message").and_then(Value::as_str))?;
    Some(capped(message, MESSAGE_CHARS))
}

/// The GitHub CLI exits with 4 when it needs `gh auth login`.
fn signed_out(code: Option<i32>, stderr: &str) -> bool {
    code == Some(4) || stderr.contains("gh auth login")
}

/// "owner/name" split in two, when both are names GitHub allows, which is
/// what lets them go into a query as they are.
fn split_repository(repository: &str) -> Option<(&str, &str)> {
    let (owner, name) = repository.split_once('/')?;
    let allowed = |part: &str| {
        !part.is_empty()
            && part.len() <= 100
            && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    (allowed(owner) && allowed(name)).then_some((owner, name))
}

/// The pull requests to ask about, by repository, in the order given, up to CHECK_LIMIT.
fn query_plan(pull_requests: &[PullRequestRef]) -> Vec<(String, Vec<u64>)> {
    let mut plan = Vec::<(String, Vec<u64>)>::new();
    let usable = pull_requests.iter().filter(|pull_request| {
        // GraphQL numbers are 32-bit.
        split_repository(&pull_request.repository).is_some() && (1..=i32::MAX as u64).contains(&pull_request.number)
    });
    let mut asked = 0;
    for pull_request in usable {
        if asked == CHECK_LIMIT {
            break;
        }
        let numbers = match plan
            .iter_mut()
            .find(|(repository, _)| repository.eq_ignore_ascii_case(&pull_request.repository))
        {
            Some((_, numbers)) => numbers,
            None => {
                plan.push((pull_request.repository.clone(), Vec::new()));
                &mut plan.last_mut().expect("just pushed").1
            }
        };
        if !numbers.contains(&pull_request.number) {
            numbers.push(pull_request.number);
            asked += 1;
        }
    }
    plan
}

/// What's asked about each pull request, whatever its state.
const STATE_FIELDS: &str = "state isDraft title mergedAt closedAt headRefName baseRefName";

/// How an open pull request stands: whether it merges cleanly, the verdict on
/// its reviews with each reviewer's latest review for when GitHub gives none,
/// and the checks on its latest commit, as GitHub rolls them up and counts
/// them by state rather than one by one. The counts are on the connection, so
/// one context is enough of a page for GitHub, which wants a size on each.
/// Picked as T3 Code picks them (apps/server/src/pullRequest/gitHubPullRequestJson.ts).
/// `mergeStateStatus` isn't asked: it's behind a preview header that older
/// CLIs don't send, and `mergeable` already says whether it conflicts.
const DETAIL_FIELDS: &str = "mergeable reviewDecision latestReviews(first: 20) { nodes { state } } \
    commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 1) { \
    checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }";

/// One query for every pull request in the plan: the repositories are
/// `r0`, `r1`… and each pull request is `p` and its number.
fn graphql_query(plan: &[(String, Vec<u64>)], details: bool) -> String {
    let mut query = String::from("query {");
    for (index, (repository, numbers)) in plan.iter().enumerate() {
        let Some((owner, name)) = split_repository(repository) else {
            continue;
        };
        query.push_str(&format!(" r{index}: repository(owner: \"{owner}\", name: \"{name}\") {{"));
        for number in numbers {
            query.push_str(&format!(" p{number}: pullRequest(number: {number}) {{ ...pr }}"));
        }
        query.push_str(" }");
    }
    query.push_str(&format!(" }} fragment pr on PullRequest {{ {STATE_FIELDS}"));
    if details {
        query.push(' ');
        query.push_str(DETAIL_FIELDS);
    }
    query.push_str(" }");
    query
}

/// What GitHub said about each pull request in the plan. One it couldn't find,
/// or whose repository it couldn't, gets an empty state. None when the answer
/// has no data at all, as when the CLI couldn't ask.
fn parse_response(
    plan: &[(String, Vec<u64>)],
    stdout: &str,
    now_ms: i64,
) -> Option<Vec<(PullRequestRef, PullRequestState)>> {
    let response = serde_json::from_str::<Value>(stdout).ok()?;
    let data = response.get("data")?.as_object()?;
    let errors = response.get("errors").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    // A pull request is null when GitHub couldn't find it, and also when one of
    // the fields it must have failed inside it; the error for that one names a
    // path into it.
    let failed_inside = |repository: &str, pull_request: &str| {
        errors.iter().any(|error| match error.get("path").and_then(Value::as_array).map(Vec::as_slice) {
            Some([first, second, _, ..]) => first.as_str() == Some(repository) && second.as_str() == Some(pull_request),
            _ => false,
        })
    };
    let mut states = Vec::new();
    for (index, (repository, numbers)) in plan.iter().enumerate() {
        let alias = format!("r{index}");
        // Left out of the answer, a repository is asked about again next time.
        let Some(found) = data.get(&alias) else {
            continue;
        };
        for &number in numbers {
            let key = format!("p{number}");
            let state = match found.get(&key).filter(|value| value.is_object()) {
                Some(pull_request) => read_state(pull_request, now_ms),
                // Not taken for missing: it's asked about again next time.
                None if failed_inside(&alias, &key) => continue,
                None => PullRequestState {
                    checked_at_ms: now_ms,
                    ..PullRequestState::default()
                },
            };
            states.push((
                PullRequestRef {
                    repository: repository.clone(),
                    number,
                },
                state,
            ));
        }
    }
    Some(states)
}

fn read_state(pull_request: &Value, now_ms: i64) -> PullRequestState {
    let text = |field: &str| pull_request.get(field).and_then(Value::as_str).unwrap_or_default();
    let time = |field: &str| {
        DateTime::parse_from_rfc3339(text(field))
            .ok()
            .map(|time| time.timestamp_millis())
    };
    PullRequestState {
        state: match text("state") {
            "MERGED" => "merged",
            "OPEN" => "open",
            "CLOSED" => "closed",
            _ => "",
        }
        .to_string(),
        draft: pull_request.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        title: capped(text("title"), TITLE_CHARS),
        head_branch: capped(text("headRefName"), BRANCH_CHARS),
        base_branch: capped(text("baseRefName"), BRANCH_CHARS),
        merged_at_ms: time("mergedAt"),
        closed_at_ms: time("closedAt"),
        mergeable: match text("mergeable") {
            "MERGEABLE" => "mergeable",
            "CONFLICTING" => "conflicting",
            _ => "",
        }
        .to_string(),
        review: read_review(pull_request).to_string(),
        checks: read_checks(pull_request),
        checked_at_ms: now_ms,
    }
}

/// The verdict on a pull request's reviews. GitHub's own counts only the
/// reviews its branch rules do, so an approval from someone they don't count,
/// or on a repository without rules, leaves it empty. Then each reviewer's
/// latest review decides, changes requested before approval, as T3 Code's
/// `toReviewDecisionWithReviews` has it.
fn read_review(pull_request: &Value) -> &'static str {
    let decision = match pull_request.get("reviewDecision").and_then(Value::as_str) {
        Some("APPROVED") => "approved",
        Some("CHANGES_REQUESTED") => "changesRequested",
        Some("REVIEW_REQUIRED") => "reviewRequired",
        _ => "",
    };
    if matches!(decision, "approved" | "changesRequested") {
        return decision;
    }
    let reviews = pull_request
        .pointer("/latestReviews/nodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let said = |verdict: &str| reviews.iter().any(|review| review.get("state").and_then(Value::as_str) == Some(verdict));
    if said("CHANGES_REQUESTED") {
        "changesRequested"
    } else if said("APPROVED") {
        "approved"
    } else {
        decision
    }
}

/// The checks on a pull request's latest commit, counted into passed, failed
/// and pending the way T3 Code's `toCheckStatus` sorts one check. None when
/// the commit has none, or GitHub didn't say.
fn read_checks(pull_request: &Value) -> Option<PullRequestChecks> {
    let rollup = pull_request
        .pointer("/commits/nodes/0/commit/statusCheckRollup")
        .filter(|value| value.is_object())?;
    let mut checks = PullRequestChecks {
        rollup: match rollup.get("state").and_then(Value::as_str) {
            Some(state @ ("SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED")) => state.to_ascii_lowercase(),
            _ => String::new(),
        },
        ..PullRequestChecks::default()
    };
    let contexts = rollup.get("contexts");
    // Check runs (Actions and apps) and commit statuses are counted apart.
    for field in ["checkRunCountsByState", "statusContextCountsByState"] {
        let counts = contexts.and_then(|contexts| contexts.get(field)).and_then(Value::as_array);
        for entry in counts.into_iter().flatten() {
            let count = entry
                .get("count")
                .and_then(Value::as_u64)
                .map_or(0, |count| u32::try_from(count).unwrap_or(u32::MAX));
            let bucket = match entry.get("state").and_then(Value::as_str).unwrap_or_default() {
                "SUCCESS" => Some(&mut checks.passed),
                "FAILURE" | "ERROR" | "TIMED_OUT" | "STARTUP_FAILURE" | "CANCELLED" => Some(&mut checks.failed),
                "PENDING" | "EXPECTED" | "QUEUED" | "IN_PROGRESS" | "WAITING" | "REQUESTED" | "ACTION_REQUIRED" => {
                    Some(&mut checks.pending)
                }
                // Skipped, neutral and stale ones say nothing either way.
                _ => None,
            };
            if let Some(bucket) = bucket {
                *bucket = bucket.saturating_add(count);
            }
            checks.total = checks.total.saturating_add(count);
        }
    }
    checks.is_known().then_some(checks)
}

fn capped(value: &str, chars: usize) -> String {
    value.chars().take(chars).collect()
}

#[cfg(test)]
pub(super) fn test_state(state: &str, head_branch: &str, base_branch: &str, checked_at_ms: i64) -> PullRequestState {
    PullRequestState {
        state: state.into(),
        head_branch: head_branch.into(),
        base_branch: base_branch.into(),
        checked_at_ms,
        ..PullRequestState::default()
    }
}

#[cfg(test)]
pub(super) fn test_merged_state(head_branch: &str, base_branch: &str, merged_at_ms: i64) -> PullRequestState {
    PullRequestState {
        merged_at_ms: Some(merged_at_ms),
        ..test_state("merged", head_branch, base_branch, merged_at_ms)
    }
}

#[cfg(test)]
pub(super) fn store_test_states(connection: &mut Connection, states: &[(&str, u64, PullRequestState)]) {
    let states = states
        .iter()
        .map(|(repository, number, state)| {
            (
                PullRequestRef {
                    repository: repository.to_string(),
                    number: *number,
                },
                state.clone(),
            )
        })
        .collect::<Vec<_>>();
    store_states(connection, &states).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000;

    fn reference(repository: &str, number: u64) -> PullRequestRef {
        PullRequestRef {
            repository: repository.into(),
            number,
        }
    }

    #[test]
    fn one_query_asks_about_every_pull_request_by_repository() {
        let plan = query_plan(&[
            reference("acme/arbor", 412),
            reference("acme/proxy", 7),
            reference("Acme/Arbor", 413),
            reference("acme/arbor", 412),
            reference("acme/ar\"bor", 1),
            reference("acme/arbor/extra", 2),
            reference("acme/arbor", 0),
            reference("acme/arbor", u64::MAX),
        ]);
        assert_eq!(
            plan,
            [
                ("acme/arbor".to_string(), vec![412, 413]),
                ("acme/proxy".to_string(), vec![7]),
            ],
            "the same repository in another case is asked about once; names a query can't hold are left out"
        );
        assert_eq!(
            graphql_query(&plan, false),
            "query { r0: repository(owner: \"acme\", name: \"arbor\") { p412: pullRequest(number: 412) { ...pr } \
             p413: pullRequest(number: 413) { ...pr } } r1: repository(owner: \"acme\", name: \"proxy\") { \
             p7: pullRequest(number: 7) { ...pr } } } fragment pr on PullRequest { state isDraft title mergedAt \
             closedAt headRefName baseRefName }"
        );
        assert_eq!(
            graphql_query(&plan, true),
            "query { r0: repository(owner: \"acme\", name: \"arbor\") { p412: pullRequest(number: 412) { ...pr } \
             p413: pullRequest(number: 413) { ...pr } } r1: repository(owner: \"acme\", name: \"proxy\") { \
             p7: pullRequest(number: 7) { ...pr } } } fragment pr on PullRequest { state isDraft title mergedAt \
             closedAt headRefName baseRefName mergeable reviewDecision latestReviews(first: 20) { nodes { state } } \
             commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 1) { \
             checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } } }",
            "still one query, with how each one stands"
        );

        let many = (1..=150).map(|number| reference("acme/arbor", number)).collect::<Vec<_>>();
        assert_eq!(query_plan(&many)[0].1.len(), CHECK_LIMIT);
    }

    #[test]
    fn answers_are_read_even_beside_errors() {
        let plan = vec![
            ("acme/arbor".to_string(), vec![412, 413, 999]),
            ("acme/gone".to_string(), vec![5]),
            ("acme/skipped".to_string(), vec![6]),
        ];
        // What `gh api graphql` prints when one pull request and one repository
        // can't be found: the rest still come back.
        let stdout = r#"{
            "data": {
                "r0": {
                    "p412": {"state": "MERGED", "isDraft": false, "title": "Fix the login loop", "mergedAt": "2026-09-20T01:02:03Z",
                             "closedAt": "2026-09-20T01:02:03Z", "headRefName": "fix/login-loop", "baseRefName": "main"},
                    "p413": {"state": "OPEN", "isDraft": true, "title": "Settings", "mergedAt": null, "closedAt": null,
                             "headRefName": "settings", "baseRefName": "main"},
                    "p999": null
                },
                "r1": null
            },
            "errors": [
                {"type": "NOT_FOUND", "path": ["r0", "p999"], "message": "Could not resolve to a PullRequest with the number of 999."},
                {"type": "NOT_FOUND", "path": ["r1"], "message": "Could not resolve to a Repository with the name 'acme/gone'."}
            ]
        }"#;
        let states = parse_response(&plan, stdout, NOW).unwrap();
        let find = |repository: &str, number: u64| {
            states
                .iter()
                .find(|(pull_request, _)| pull_request.repository == repository && pull_request.number == number)
                .map(|(_, state)| state.clone())
        };
        let merged = find("acme/arbor", 412).unwrap();
        assert_eq!(merged.state, "merged");
        assert_eq!(merged.title, "Fix the login loop");
        assert_eq!(merged.merged_at_ms, Some(1_789_866_123_000));
        assert_eq!(merged.work_branch(), Some("fix/login-loop"));
        let open = find("acme/arbor", 413).unwrap();
        assert_eq!((open.state.as_str(), open.draft, open.merged_at_ms), ("open", true, None));
        assert_eq!(
            (open.mergeable.as_str(), open.review.as_str(), &open.checks),
            ("", "", &None),
            "an answer without checks, reviews or merging says nothing about them"
        );
        for (repository, number) in [("acme/arbor", 999), ("acme/gone", 5)] {
            let unknown = find(repository, number).unwrap();
            assert_eq!((unknown.state.as_str(), unknown.checked_at_ms), ("", NOW), "{repository}#{number}");
        }
        assert_eq!(find("acme/skipped", 6), None, "left out of the answer, it's asked about again");

        for stdout in ["", "not json", r#"{"data": null, "errors": [{"message": "Bad credentials"}]}"#] {
            assert_eq!(parse_response(&plan, stdout, NOW), None, "{stdout}");
        }
    }

    fn checks(rollup: &str, passed: u32, failed: u32, pending: u32, total: u32) -> Option<PullRequestChecks> {
        Some(PullRequestChecks {
            rollup: rollup.into(),
            passed,
            failed,
            pending,
            total,
        })
    }

    #[test]
    fn how_open_pull_requests_stand_is_read_from_the_answer() {
        let plan = vec![("acme/arbor".to_string(), vec![1, 2, 3, 4, 5, 6, 7])];
        // As `gh api graphql` prints the detailed query's answer, trimmed to the fields that matter.
        let stdout = r#"{
            "data": {
                "r0": {
                    "p1": {"state": "OPEN", "isDraft": false, "baseRefName": "main", "mergeable": "CONFLICTING",
                           "reviewDecision": "CHANGES_REQUESTED", "latestReviews": {"nodes": [{"state": "APPROVED"}]},
                           "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "FAILURE", "contexts": {
                               "checkRunCountsByState": [{"state": "SUCCESS", "count": 4}, {"state": "FAILURE", "count": 1},
                                   {"state": "SKIPPED", "count": 2}, {"state": "IN_PROGRESS", "count": 1}],
                               "statusContextCountsByState": [{"state": "SUCCESS", "count": 1}, {"state": "ERROR", "count": 1}]}}}}]}},
                    "p2": {"state": "OPEN", "isDraft": false, "mergeable": "UNKNOWN", "reviewDecision": "REVIEW_REQUIRED",
                           "latestReviews": {"nodes": [{"state": "COMMENTED"}]},
                           "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "PENDING", "contexts": {
                               "checkRunCountsByState": [{"state": "QUEUED", "count": 2}, {"state": "SUCCESS", "count": 3},
                                   {"state": "ACTION_REQUIRED", "count": 1}],
                               "statusContextCountsByState": [{"state": "EXPECTED", "count": 1}]}}}}]}},
                    "p3": {"state": "OPEN", "isDraft": false, "mergeable": "MERGEABLE", "reviewDecision": null,
                           "latestReviews": {"nodes": [{"state": "COMMENTED"}, {"state": "APPROVED"}]},
                           "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "SUCCESS", "contexts": {
                               "checkRunCountsByState": [{"state": "SUCCESS", "count": 6}, {"state": "NEUTRAL", "count": 1}],
                               "statusContextCountsByState": []}}}}]}},
                    "p4": {"state": "OPEN", "isDraft": true, "mergeable": "MERGEABLE", "reviewDecision": null,
                           "latestReviews": {"nodes": [{"state": "APPROVED"}, {"state": "CHANGES_REQUESTED"}]},
                           "commits": {"nodes": [{"commit": {"statusCheckRollup": null}}]}},
                    "p5": {"state": "OPEN", "isDraft": false, "mergeable": "MERGEABLE",
                           "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "SUCCESS", "contexts": null}}}]}},
                    "p6": {"state": "MERGED", "isDraft": false, "mergeable": "UNKNOWN", "reviewDecision": "APPROVED",
                           "latestReviews": {"nodes": [{"state": "CHANGES_REQUESTED"}]}, "commits": {"nodes": []}},
                    "p7": null
                }
            },
            "errors": [{"path": ["r0", "p7", "commits", "nodes", 0, "commit"], "message": "Something went wrong while executing your query."}]
        }"#;
        let states = parse_response(&plan, stdout, NOW).unwrap();
        let find = |number: u64| {
            states
                .iter()
                .find(|(pull_request, _)| pull_request.number == number)
                .map(|(_, state)| (state.mergeable.as_str(), state.review.as_str(), state.checks.clone()))
        };
        assert_eq!(
            find(1),
            Some(("conflicting", "changesRequested", checks("failure", 5, 2, 1, 10))),
            "check runs and commit statuses count together; skipped ones only in the total"
        );
        assert_eq!(
            find(2),
            Some(("", "reviewRequired", checks("pending", 3, 0, 4, 7))),
            "queued, waiting for approval and expected are all pending; GitHub still working out conflicts says nothing"
        );
        assert_eq!(
            find(3),
            Some(("mergeable", "approved", checks("success", 6, 0, 0, 7))),
            "without GitHub's verdict, an approval still counts"
        );
        assert_eq!(find(4), Some(("mergeable", "changesRequested", None)), "changes requested outranks approval; no checks is none");
        assert_eq!(find(5), Some(("mergeable", "", checks("success", 0, 0, 0, 0))), "without counts, GitHub's word for them");
        assert_eq!(find(6), Some(("", "approved", None)), "GitHub's own verdict stands");
        assert_eq!(find(7), None, "one that failed inside isn't taken for missing: it's asked about again");
        let base = &states.iter().find(|(pull_request, _)| pull_request.number == 1).unwrap().1.base_branch;
        assert_eq!(base, "main");
    }

    #[test]
    fn a_query_github_turns_down_is_told_from_one_it_answers() {
        // What GitHub says when the query names a field its schema doesn't have: errors and no data.
        let refused = r#"{"errors": [{"path": ["fragment pr", "commits"], "extensions": {"code": "undefinedField",
            "typeName": "StatusCheckRollupContextConnection", "fieldName": "checkRunCountsByState"}, "locations": [{"line": 1, "column": 40}],
            "message": "Field 'checkRunCountsByState' doesn't exist on type 'StatusCheckRollupContextConnection'"}]}"#;
        assert_eq!(parse_response(&[("acme/arbor".to_string(), vec![1])], refused, NOW), None);
        assert_eq!(
            refusal(refused).as_deref(),
            Some("Field 'checkRunCountsByState' doesn't exist on type 'StatusCheckRollupContextConnection'")
        );
        assert_eq!(refusal(r#"{"data": null, "errors": [{"message": "Something went wrong"}]}"#).as_deref(), Some("Something went wrong"));
        for answered in [
            r#"{"data": {"r0": null}, "errors": [{"type": "NOT_FOUND", "message": "Could not resolve to a Repository"}]}"#,
            r#"{"message": "Bad credentials", "documentation_url": "https://docs.github.com/graphql"}"#,
            r#"{"errors": []}"#,
            "",
        ] {
            assert_eq!(refusal(answered), None, "{answered}");
        }
    }

    #[test]
    fn a_pull_request_from_a_forks_main_has_no_branch_to_follow() {
        assert_eq!(test_state("open", "main", "main", NOW).work_branch(), None);
        assert_eq!(test_state("", "", "", NOW).work_branch(), None);
        assert_eq!(test_state("merged", "feature", "main", NOW).work_branch(), Some("feature"));
    }

    #[test]
    fn merged_is_final_and_the_rest_are_asked_about_again() {
        assert!(is_due(None, NOW));
        let at = |state: &str, age: i64| is_due(Some(&test_state(state, "", "", NOW - age)), NOW);
        assert!(!at("merged", 365 * 86_400_000));
        assert!(!at("open", OPEN_RECHECK_MS - 1));
        assert!(at("open", OPEN_RECHECK_MS));
        assert!(!at("closed", OPEN_RECHECK_MS));
        assert!(at("closed", SETTLED_RECHECK_MS));
        assert!(!at("", SETTLED_RECHECK_MS - 1));
        assert!(at("", SETTLED_RECHECK_MS));
    }

    #[test]
    fn states_are_kept_whatever_the_case_of_the_repository() {
        let mut connection = crate::usage::schema::test_database();
        store_test_states(
            &mut connection,
            &[
                ("acme/arbor", 412, test_state("open", "fix/login-loop", "main", NOW - 1_000)),
                ("acme/proxy", 7, test_state("closed", "limits", "main", NOW - 1_000)),
            ],
        );
        store_test_states(&mut connection, &[("Acme/Arbor", 412, test_state("merged", "fix/login-loop", "main", NOW))]);
        let states = load_states(&connection).unwrap();
        assert_eq!(states.len(), 2, "a second answer replaces the first");
        assert_eq!(states[&state_key("ACME/arbor", 412)], test_state("merged", "fix/login-loop", "main", NOW));
        assert_eq!(states[&state_key("acme/proxy", 7)].state, "closed");
    }

    #[test]
    fn how_they_stand_is_kept() {
        let mut connection = crate::usage::schema::test_database();
        connection
            .execute(
                "INSERT INTO usage_pull_requests (repository, number, state, checked_at_ms) VALUES ('acme/arbor', 412, 'open', ?1)",
                params![NOW - 1_000],
            )
            .unwrap();
        let before = load_states(&connection).unwrap();
        assert_eq!(before[&state_key("acme/arbor", 412)], test_state("open", "", "", NOW - 1_000));

        let standing = PullRequestState {
            mergeable: "conflicting".into(),
            review: "changesRequested".into(),
            checks: checks("failure", 5, 2, 1, 10),
            ..test_state("open", "fix/login-loop", "main", NOW)
        };
        let unchecked = PullRequestState {
            mergeable: "mergeable".into(),
            ..test_state("open", "settings", "main", NOW)
        };
        store_test_states(&mut connection, &[("acme/arbor", 412, standing.clone()), ("acme/arbor", 413, unchecked.clone())]);
        let after = load_states(&connection).unwrap();
        assert_eq!(after[&state_key("acme/arbor", 412)], standing);
        assert_eq!(after[&state_key("acme/arbor", 413)], unchecked, "no checks stays no checks");

        let json = serde_json::to_value(&standing).unwrap();
        assert_eq!(json["checks"], serde_json::json!({ "rollup": "failure", "passed": 5, "failed": 2, "pending": 1, "total": 10 }));
        assert_eq!((&json["review"], &json["mergeable"], &json["baseBranch"]), (&serde_json::json!("changesRequested"), &serde_json::json!("conflicting"), &serde_json::json!("main")));
        assert_eq!(serde_json::to_value(&unchecked).unwrap()["checks"], Value::Null);
    }

    #[test]
    fn a_sessions_pull_requests_come_with_what_github_said_last() {
        let links: Vec<PullRequestLink> = serde_json::from_value(serde_json::json!([
            { "number": 412, "url": "https://github.com/acme/arbor/pull/412", "repository": "acme/arbor" },
            { "number": 57, "url": "https://github.com/Acme/Proxy/pull/57", "repository": "" },
            { "number": 9, "url": "https://github.com/acme/arbor/pull/9", "repository": "acme/arbor" },
            { "number": 3, "url": "https://git.example.com/acme/arbor/pull/3", "repository": "acme/arbor" },
        ]))
        .unwrap();
        let states = HashMap::from([
            (state_key("acme/arbor", 412), test_state("merged", "fix/login-loop", "main", NOW - 1_000)),
            (state_key("acme/proxy", 57), test_state("open", "limits", "main", NOW - OPEN_RECHECK_MS)),
        ]);
        let (named, due) = named_pull_requests(&links, &states, NOW);
        let json = serde_json::to_value(&named).unwrap();
        assert_eq!(json[0]["url"], "https://github.com/acme/arbor/pull/412");
        assert_eq!(json[0]["github"]["state"], "merged");
        assert_eq!(json[1]["github"]["state"], "open", "the repository comes from the address, whatever its case");
        assert_eq!((&json[2]["github"], &json[3]["github"]), (&Value::Null, &Value::Null));
        assert_eq!(
            due,
            [reference("Acme/Proxy", 57), reference("acme/arbor", 9)],
            "an open one gone stale and one never asked are due; merged is final, and only GitHub's own are asked about"
        );
    }

    #[test]
    fn the_cli_asks_to_be_signed_in() {
        assert!(signed_out(Some(4), ""));
        assert!(signed_out(
            Some(1),
            "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable"
        ));
        assert!(!signed_out(Some(1), "gh: Could not resolve to a Repository with the name 'acme/gone'."));
    }
}

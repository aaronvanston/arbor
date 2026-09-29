//! The Projects view of the Sessions page: the sessions the list would show,
//! added up by project and branch, and the pull requests they worked on with
//! what each one cost. A session's cost goes to the pull requests it opened or
//! worked on, split evenly between them. Once GitHub has said which branch a
//! pull request came from, the sessions on that branch that name no pull
//! request count toward it too, which is how Codex's work gets counted: its
//! transcripts don't record pull requests.

use super::machine_health::transcripts::{load_linked_transcripts, SessionTranscript};
use super::pull_requests::{self, PullRequestRef, PullRequestState};
use ts_rs::TS;
use super::*;
use std::collections::{BTreeMap, BTreeSet};

/// What a set of sessions adds up to.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectTotals {
    sessions: usize,
    active: usize,
    requests: u64,
    total_tokens: u64,
    estimated_cost: f64,
    /// Requests with a price. Without any, the cost isn't known.
    priced_requests: u64,
    lines_added: u64,
    lines_removed: u64,
    /// The sessions whose transcripts count the lines they changed: Claude
    /// Code's do, Codex's don't.
    sessions_with_lines: usize,
    last_active_at_ms: i64,
}

impl ProjectTotals {
    fn add(&mut self, session: &UsageSession) {
        let totals = &session.root.totals;
        self.sessions += 1;
        self.active += usize::from(session.active);
        self.requests = self.requests.saturating_add(totals.requests);
        self.total_tokens = self.total_tokens.saturating_add(totals.total_tokens);
        self.estimated_cost += totals.estimated_cost;
        self.priced_requests = self.priced_requests.saturating_add(totals.priced_requests);
        if let Some((added, removed)) = session.transcript.as_ref().and_then(|transcript| transcript.lines()) {
            self.lines_added = self.lines_added.saturating_add(added);
            self.lines_removed = self.lines_removed.saturating_add(removed);
            self.sessions_with_lines += 1;
        }
        self.last_active_at_ms = self.last_active_at_ms.max(totals.last_active_at_ms);
    }
}

#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectBranch {
    /// Empty for sessions outside git, or on no branch.
    name: String,
    #[serde(flatten)]
    totals: ProjectTotals,
}

#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionProject {
    /// As the Sessions page names it.
    name: String,
    /// "owner/name", when its sessions' remote or pull requests say.
    repository: Option<String>,
    #[serde(flatten)]
    totals: ProjectTotals,
    branches: Vec<ProjectBranch>,
}

#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectPullRequest {
    repository: String,
    number: u64,
    url: String,
    /// The project of the last session that named it.
    project: String,
    /// The branch it came from: GitHub's word for it, else the branch that
    /// session was on.
    branch: String,
    /// The sessions behind it. Each counts once however many pull requests it
    /// worked on; its cost and lines are shared out between them.
    sessions: usize,
    estimated_cost: f64,
    /// Its sessions' requests with a price, each session's counted in full
    /// like `sessions`. Without any, the cost isn't known.
    priced_requests: u64,
    lines_added: u64,
    lines_removed: u64,
    last_active_at_ms: i64,
    /// What GitHub said about it last. None until it's been asked.
    github: Option<PullRequestState>,
}

#[derive(Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionProjectsReport {
    /// The costliest first.
    projects: Vec<SessionProject>,
    /// The most recently worked on first.
    pull_requests: Vec<ProjectPullRequest>,
    /// Sessions without a project: no transcript says where they ran.
    unplaced: ProjectTotals,
    github: pull_requests::GithubStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    facets: Option<session_filters::SessionFacets>,
    /// The pull requests GitHub should be asked about, most recently worked on first.
    #[serde(skip)]
    due: Vec<PullRequestRef>,
}

#[cfg(test)]
impl SessionProjectsReport {
    pub(super) fn due_pull_requests(&self) -> Vec<(&str, u64)> {
        self.due.iter().map(|pull_request| (pull_request.repository.as_str(), pull_request.number)).collect()
    }
}

#[tauri::command]
pub(crate) async fn get_session_projects(
    query: UsageQuery,
    check_now: Option<bool>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<SessionProjectsReport, String> {
    let config = gui_config_state.snapshot()?;
    let now_ms = Local::now().timestamp_millis();
    let mut report = run_usage_task(move || {
        load_session_projects(&open_usage_database()?, &query, &config, now_ms)
    })
    .await?;
    pull_requests::start_check(std::mem::take(&mut report.due), check_now == Some(true), now_ms);
    report.github = pull_requests::github_status();
    Ok(report)
}

/// The sessions the Sessions list would show for the query, by project, with
/// their pull requests.
pub(super) fn load_session_projects(
    connection: &Connection,
    query: &UsageQuery,
    config: &GuiConfigFile,
    now_ms: i64,
) -> Result<SessionProjectsReport, String> {
    // A session's project comes from its transcript.
    let session_read::SelectedSessions { sessions, facets } = session_read::select_sessions(
        connection,
        config,
        now_ms,
        &session_read::SessionSelect {
            query,
            only_active: false,
            order: session_read::SessionOrder::Recent,
            limit: None,
            transcripts: true,
        },
    )?;
    let states = pull_requests::load_states(connection)?;
    Ok(SessionProjectsReport {
        facets,
        ..projects_report(&sessions, &states, now_ms)
    })
}

/// The pull requests merged in a window, for the weekly digest.
#[derive(Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MergedPullRequests {
    /// The most recently worked on first.
    pull_requests: Vec<ProjectPullRequest>,
    /// The pull requests GitHub should be asked about, most recently worked on first.
    #[serde(skip)]
    due: Vec<PullRequestRef>,
}

#[cfg(test)]
impl MergedPullRequests {
    pub(super) fn due_pull_requests(&self) -> Vec<(&str, u64)> {
        self.due.iter().map(|pull_request| (pull_request.repository.as_str(), pull_request.number)).collect()
    }
}

/// The pull requests GitHub has said merged from `from_ms` up to `to_ms`, each
/// with every session behind it. Like the Projects view, it asks GitHub about
/// the pull requests sessions have named that it hasn't heard the last of,
/// which is how an older one that merged in the window gets found.
#[tauri::command]
pub(crate) async fn get_merged_pull_requests(
    from_ms: i64,
    to_ms: i64,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<MergedPullRequests, String> {
    let config = gui_config_state.snapshot()?;
    let now_ms = Local::now().timestamp_millis();
    let mut merged = run_usage_task(move || {
        load_merged_pull_requests(&open_usage_database()?, &config, from_ms, to_ms, now_ms)
    })
    .await?;
    pull_requests::start_check(std::mem::take(&mut merged.due), false, now_ms);
    Ok(merged)
}

/// The pull requests merged from `from_ms` up to `to_ms` as the all-time
/// Projects view counts them, and the ones it would ask GitHub about. Instead
/// of every session ever, it reads only those that can count toward them: the
/// sessions that name them, those that name none and ran on their branches,
/// and those naming any other pull request from those branches, which the
/// unnamed ones are shared out with.
pub(super) fn load_merged_pull_requests(
    connection: &Connection,
    config: &GuiConfigFile,
    from_ms: i64,
    to_ms: i64,
    now_ms: i64,
) -> Result<MergedPullRequests, String> {
    let states = pull_requests::load_states(connection)?;
    let merged = states
        .iter()
        .filter(|(_, state)| state.merged_at_ms().is_some_and(|at| at >= from_ms && at < to_ms))
        .map(|(key, _)| key.clone())
        .collect::<HashSet<_>>();
    let branches = merged
        .iter()
        .filter_map(|key| states.get(key)?.work_branch())
        .collect::<BTreeSet<_>>();
    let related = states
        .iter()
        .filter(|(key, state)| merged.contains(*key) || state.work_branch().is_some_and(|branch| branches.contains(branch)))
        .map(|(key, _)| key)
        .collect::<HashSet<_>>();
    let transcripts = load_linked_transcripts(connection, &branches.iter().copied().collect::<Vec<_>>())?;
    let mut roots = transcripts
        .iter()
        .filter(|(_, transcript)| {
            let mut named = transcript
                .pull_requests()
                .iter()
                .filter_map(|link| Some(pull_requests::state_key(&link.repository()?, link.number())))
                .peekable();
            if named.peek().is_none() {
                branches.contains(transcript.branch())
            } else {
                named.any(|key| related.contains(&key))
            }
        })
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    roots.sort();
    let sessions = session_read::select_session_trees(connection, config, now_ms, &roots)?;
    let pull_requests = projects_report(&sessions, &states, now_ms)
        .pull_requests
        .into_iter()
        .filter(|pull_request| merged.contains(&pull_requests::state_key(&pull_request.repository, pull_request.number)))
        .collect();
    Ok(MergedPullRequests {
        pull_requests,
        due: due_pull_requests(connection, &transcripts, &states, now_ms)?,
    })
}

/// The pull requests on github.com that sessions have named and GitHub hasn't
/// said the last of, the most recently worked on first, as the all-time
/// Projects view would ask about them. That view goes by every session behind
/// a pull request; this goes by the ones naming it, which can only change the
/// order of those past the check limit.
fn due_pull_requests(
    connection: &Connection,
    transcripts: &HashMap<String, SessionTranscript>,
    states: &HashMap<(String, u64), PullRequestState>,
    now_ms: i64,
) -> Result<Vec<PullRequestRef>, String> {
    let mut last_request = connection
        .prepare(
            "SELECT MAX(at) FROM (
                 SELECT MAX(timestamp_ms) AS at FROM usage_events WHERE session_id = ?1
                 UNION ALL SELECT MAX(timestamp_ms) FROM usage_events WHERE parent_session_id = ?1
             )",
        )
        .map_err(|error| format!("Failed to prepare the pull request query: {error}"))?;
    let mut due = HashMap::<(String, u64), (i64, PullRequestRef)>::new();
    for (id, transcript) in transcripts {
        // The view leaves out the sessions it can't place.
        if transcript.project().is_none() {
            continue;
        }
        let links = transcript
            .pull_requests()
            .iter()
            .filter_map(|link| {
                let repository = link.repository()?;
                let key = pull_requests::state_key(&repository, link.number());
                (link.url().starts_with("https://github.com/") && pull_requests::is_due(states.get(&key), now_ms))
                    .then(|| (key, PullRequestRef { repository, number: link.number() }))
            })
            .collect::<Vec<_>>();
        if links.is_empty() {
            continue;
        }
        // Nor does it have the sessions whose requests have all been cleared away.
        let Some(at) = last_request
            .query_row([id], |row| row.get::<_, Option<i64>>(0))
            .map_err(|error| format!("Failed to read when a session was last active: {error}"))?
        else {
            continue;
        };
        for (key, pull_request) in links {
            let entry = due.entry(key).or_insert((at, pull_request));
            entry.0 = entry.0.max(at);
        }
    }
    let mut due = due.into_values().collect::<Vec<_>>();
    due.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.repository.cmp(&right.1.repository))
            .then_with(|| right.1.number.cmp(&left.1.number))
    });
    Ok(due.into_iter().map(|(_, pull_request)| pull_request).collect())
}

#[derive(Default)]
struct ProjectBuilder {
    totals: ProjectTotals,
    branches: BTreeMap<String, ProjectTotals>,
    /// How many of its sessions name each repository.
    repositories: BTreeMap<String, usize>,
}

struct PullRequestBuilder {
    repository: String,
    number: u64,
    url: String,
    /// The last session to name it: its project and branch are the pull request's.
    latest: Option<(i64, String, String)>,
    sessions: usize,
    estimated_cost: f64,
    priced_requests: u64,
    lines_added: f64,
    lines_removed: f64,
    last_active_at_ms: i64,
}

fn projects_report(
    sessions: &[UsageSession],
    states: &HashMap<(String, u64), PullRequestState>,
    now_ms: i64,
) -> SessionProjectsReport {
    let mut projects = BTreeMap::<String, ProjectBuilder>::new();
    let mut unplaced = ProjectTotals::default();
    let mut pull_requests = Vec::<PullRequestBuilder>::new();
    let mut found = HashMap::<(String, u64), usize>::new();
    // Each placed session: its project, branch and the pull requests it names.
    let mut placed = Vec::<(&UsageSession, String, &str, BTreeSet<usize>)>::new();

    for session in sessions {
        let Some((transcript, project)) = session
            .transcript
            .as_ref()
            .and_then(|transcript| Some((transcript, transcript.project()?)))
        else {
            unplaced.add(session);
            continue;
        };
        let builder = projects.entry(project.clone()).or_default();
        builder.totals.add(session);
        builder.branches.entry(transcript.branch().to_string()).or_default().add(session);
        if let Some(repository) = transcript.repository() {
            *builder.repositories.entry(repository).or_default() += 1;
        }
        let mut named = BTreeSet::new();
        for link in transcript.pull_requests() {
            let Some(repository) = link.repository() else {
                continue;
            };
            let index = *found
                .entry(pull_requests::state_key(&repository, link.number()))
                .or_insert_with(|| {
                    pull_requests.push(PullRequestBuilder {
                        repository,
                        number: link.number(),
                        url: link.url().to_string(),
                        latest: None,
                        sessions: 0,
                        estimated_cost: 0.0,
                        priced_requests: 0,
                        lines_added: 0.0,
                        lines_removed: 0.0,
                        last_active_at_ms: 0,
                    });
                    pull_requests.len() - 1
                });
            let last_active = session.root.totals.last_active_at_ms;
            let pull_request = &mut pull_requests[index];
            if pull_request.latest.as_ref().is_none_or(|(at, _, _)| last_active > *at) {
                pull_request.latest = Some((last_active, project.clone(), transcript.branch().to_string()));
            }
            named.insert(index);
        }
        placed.push((session, project, transcript.branch(), named));
    }

    // The pull requests each project's branches were for, as GitHub says.
    let mut on_branch = HashMap::<(String, String), Vec<usize>>::new();
    for (index, pull_request) in pull_requests.iter().enumerate() {
        let state = states.get(&pull_requests::state_key(&pull_request.repository, pull_request.number));
        let (Some(branch), Some((_, project, _))) = (state.and_then(PullRequestState::work_branch), &pull_request.latest)
        else {
            continue;
        };
        on_branch.entry((project.clone(), branch.to_string())).or_default().push(index);
    }
    for (session, project, branch, named) in &placed {
        let shares = if !named.is_empty() {
            named.iter().copied().collect()
        } else if branch.is_empty() {
            continue;
        } else {
            match on_branch.get(&(project.clone(), branch.to_string())) {
                Some(indexes) => indexes.clone(),
                None => continue,
            }
        };
        let totals = &session.root.totals;
        let share = 1.0 / shares.len() as f64;
        let lines = session.transcript.as_ref().and_then(|transcript| transcript.lines());
        for index in shares {
            let pull_request = &mut pull_requests[index];
            pull_request.sessions += 1;
            pull_request.estimated_cost += totals.estimated_cost * share;
            pull_request.priced_requests = pull_request.priced_requests.saturating_add(totals.priced_requests);
            if let Some((added, removed)) = lines {
                pull_request.lines_added += added as f64 * share;
                pull_request.lines_removed += removed as f64 * share;
            }
            pull_request.last_active_at_ms = pull_request.last_active_at_ms.max(totals.last_active_at_ms);
        }
    }

    let mut report_pull_requests = pull_requests
        .into_iter()
        .map(|pull_request| {
            let github = states
                .get(&pull_requests::state_key(&pull_request.repository, pull_request.number))
                .cloned();
            let (project, session_branch) = pull_request
                .latest
                .map(|(_, project, branch)| (project, branch))
                .unwrap_or_default();
            ProjectPullRequest {
                branch: github
                    .as_ref()
                    .and_then(PullRequestState::work_branch)
                    .map(str::to_string)
                    .unwrap_or(session_branch),
                repository: pull_request.repository,
                number: pull_request.number,
                url: pull_request.url,
                project,
                sessions: pull_request.sessions,
                estimated_cost: pull_request.estimated_cost,
                priced_requests: pull_request.priced_requests,
                lines_added: pull_request.lines_added.round() as u64,
                lines_removed: pull_request.lines_removed.round() as u64,
                last_active_at_ms: pull_request.last_active_at_ms,
                github,
            }
        })
        .collect::<Vec<_>>();
    report_pull_requests.sort_by(|left, right| {
        right
            .last_active_at_ms
            .cmp(&left.last_active_at_ms)
            .then_with(|| left.repository.cmp(&right.repository))
            .then_with(|| right.number.cmp(&left.number))
    });
    let due = report_pull_requests
        .iter()
        .filter(|pull_request| {
            pull_request.url.starts_with("https://github.com/")
                && pull_requests::is_due(pull_request.github.as_ref(), now_ms)
        })
        .map(|pull_request| PullRequestRef {
            repository: pull_request.repository.clone(),
            number: pull_request.number,
        })
        .collect();

    let costliest = |left: &ProjectTotals, right: &ProjectTotals| {
        right
            .estimated_cost
            .total_cmp(&left.estimated_cost)
            .then_with(|| right.last_active_at_ms.cmp(&left.last_active_at_ms))
    };
    let mut report_projects = projects
        .into_iter()
        .map(|(name, builder)| {
            let mut branches = builder
                .branches
                .into_iter()
                .map(|(name, totals)| ProjectBranch { name, totals })
                .collect::<Vec<_>>();
            branches.sort_by(|left, right| costliest(&left.totals, &right.totals).then_with(|| left.name.cmp(&right.name)));
            // The repository most of its sessions name; the first in order on a tie.
            let repository = builder
                .repositories
                .into_iter()
                .fold(None::<(String, usize)>, |best, (repository, count)| match best {
                    Some((_, most)) if most >= count => best,
                    _ => Some((repository, count)),
                })
                .map(|(repository, _)| repository);
            SessionProject {
                name,
                repository,
                totals: builder.totals,
                branches,
            }
        })
        .collect::<Vec<_>>();
    report_projects.sort_by(|left, right| costliest(&left.totals, &right.totals).then_with(|| left.name.cmp(&right.name)));

    SessionProjectsReport {
        projects: report_projects,
        pull_requests: report_pull_requests,
        unplaced,
        due,
        ..SessionProjectsReport::default()
    }
}

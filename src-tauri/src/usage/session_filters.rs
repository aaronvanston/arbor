//! Narrowing the Sessions list by what each session is rather than by its
//! requests: words to search for, its project and branch, the client and the
//! machine it ran on, and whether it worked on a pull request. Most of that
//! comes from the session's transcript, so these apply after the requests are
//! grouped into sessions. Each filter menu also gets the number of sessions
//! behind each of its choices.

use super::*;
use ts_rs::TS;

/// The machine filter's choice for sessions Arbor can't place on a machine.
const UNASSIGNED_MACHINE: &str = "__unassigned__";

#[derive(Default)]
pub(super) struct SessionFilters {
    /// Lowercased search words; a session has to contain every one.
    terms: Vec<String>,
    project: Option<String>,
    branch: Option<String>,
    client: Option<String>,
    machine: Option<String>,
    pull_requests: Option<bool>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Facet {
    Project,
    Branch,
    Client,
    Machine,
    PullRequests,
}

/// What the filters look at in one session.
struct SessionFacts {
    project: Option<String>,
    branch: String,
    client: Option<String>,
    /// Where the session ran: its key's machine, else where its transcript is.
    machine: String,
    pull_requests: bool,
    /// Everything search looks through, lowercased.
    text: String,
}

/// How many sessions one choice in a filter menu would show, given the other filters.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(super) struct FacetCount {
    value: String,
    sessions: usize,
}

/// How many sessions each choice in the filter menus would show. Each menu
/// counts the sessions matching every other filter.
#[derive(Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionFacets {
    /// Most sessions first, like the other menus.
    projects: Vec<FacetCount>,
    /// The chosen project's branches; none until a project is chosen.
    branches: Vec<FacetCount>,
    /// Clients as the list names them without their version, like "Claude Code" or "Codex CLI · AcmeDesk".
    clients: Vec<FacetCount>,
    /// Where sessions ran: their key's machine, else the one their transcript is on.
    machines: Vec<FacetCount>,
    with_pull_requests: usize,
    without_pull_requests: usize,
}

impl SessionFilters {
    pub(super) fn from_query(query: &UsageQuery) -> Self {
        let text = |value: &Option<String>| {
            value
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        Self {
            terms: query
                .search
                .as_deref()
                .unwrap_or_default()
                .split_whitespace()
                .map(str::to_lowercase)
                .collect(),
            project: text(&query.project),
            branch: text(&query.branch),
            client: text(&query.client),
            machine: text(&query.machine),
            pull_requests: match query.pull_requests.as_deref().map(str::trim) {
                Some("with") => Some(true),
                Some("without") => Some(false),
                _ => None,
            },
        }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.machine.is_none() && !self.narrows_beyond_requests()
    }

    /// True when a filter needs more than a request to decide on, so requests
    /// without a session can't be said to match it. The machine can: a
    /// request's key is assigned to one.
    pub(super) fn narrows_beyond_requests(&self) -> bool {
        !self.terms.is_empty()
            || self.project.is_some()
            || self.branch.is_some()
            || self.client.is_some()
            || self.pull_requests.is_some()
    }

    fn matches(&self, facts: &SessionFacts, except: Option<Facet>) -> bool {
        // Picking another project clears the branch, so the project menu counts without it.
        let applies = |facet: Facet| {
            except != Some(facet) && !(except == Some(Facet::Project) && facet == Facet::Branch)
        };
        self.terms.iter().all(|term| facts.text.contains(term.as_str()))
            && (!applies(Facet::Project)
                || self
                    .project
                    .as_ref()
                    .is_none_or(|project| facts.project.as_ref() == Some(project)))
            && (!applies(Facet::Branch) || self.branch.as_ref().is_none_or(|branch| &facts.branch == branch))
            && (!applies(Facet::Client)
                || self
                    .client
                    .as_ref()
                    .is_none_or(|client| facts.client.as_ref() == Some(client)))
            && (!applies(Facet::Machine)
                || self.machine.as_deref().is_none_or(|machine| {
                    if machine == UNASSIGNED_MACHINE {
                        facts.machine.is_empty()
                    } else {
                        facts.machine == machine
                    }
                }))
            && (!applies(Facet::PullRequests)
                || self
                    .pull_requests
                    .is_none_or(|wanted| facts.pull_requests == wanted))
    }
}

/// Drops the sessions the filters leave out, and with `facets`, counts the
/// sessions behind each choice in the filter menus first. Sessions need their
/// transcripts by now.
pub(super) fn filter_sessions(
    sessions: &mut Vec<UsageSession>,
    filters: &SessionFilters,
    facets: bool,
) -> Option<SessionFacets> {
    let facts = sessions.iter().map(session_facts).collect::<Vec<_>>();
    let counted = facets.then(|| count_facets(&facts, filters));
    // `retain` visits the sessions once each, in order.
    let mut keep = facts.iter().map(|facts| filters.matches(facts, None));
    sessions.retain(|_| keep.next().unwrap_or(false));
    counted
}

fn session_facts(session: &UsageSession) -> SessionFacts {
    let transcript = session.transcript.as_ref();
    let user_agent = session.root.user_agent.as_deref().unwrap_or_default();
    let project = transcript.and_then(|transcript| transcript.project());
    let client = session_client_label(user_agent);
    let machine = session_machine(session).to_string();
    let mut text = [
        project.as_deref().unwrap_or_default(),
        client.as_deref().unwrap_or_default(),
        user_agent,
        machine.as_str(),
        session.provider.as_str(),
    ]
    .join("\n");
    for model in &session.root.models {
        text.push('\n');
        text.push_str(model);
    }
    // An id finds its session, a subagent's included.
    for id in std::iter::once(&session.root.id).chain(session.threads.iter().map(|thread| &thread.id)) {
        text.push('\n');
        text.push_str(id);
    }
    if let Some(transcript) = transcript {
        text.push('\n');
        text.push_str(&transcript.search_text());
    }
    SessionFacts {
        branch: transcript.map(|transcript| transcript.branch().to_string()).unwrap_or_default(),
        pull_requests: transcript.is_some_and(|transcript| transcript.has_pull_requests()),
        project,
        client,
        machine,
        text: text.to_lowercase(),
    }
}

/// Where a session ran: its key's machine, else the one its transcript is on.
/// Empty when neither says.
pub(super) fn session_machine(session: &UsageSession) -> &str {
    if session.machine.is_empty() {
        session.transcript.as_ref().map_or("", |transcript| transcript.machine())
    } else {
        &session.machine
    }
}

fn count_facets(facts: &[SessionFacts], filters: &SessionFilters) -> SessionFacets {
    let mut projects = HashMap::<&str, usize>::new();
    let mut branches = HashMap::<&str, usize>::new();
    let mut clients = HashMap::<&str, usize>::new();
    let mut machines = HashMap::<&str, usize>::new();
    let mut facets = SessionFacets::default();
    for facts in facts {
        if let Some(project) = facts.project.as_deref() {
            if filters.matches(facts, Some(Facet::Project)) {
                *projects.entry(project).or_default() += 1;
            }
        }
        if filters.project.is_some() && !facts.branch.is_empty() && filters.matches(facts, Some(Facet::Branch)) {
            *branches.entry(facts.branch.as_str()).or_default() += 1;
        }
        if let Some(client) = facts.client.as_deref() {
            if filters.matches(facts, Some(Facet::Client)) {
                *clients.entry(client).or_default() += 1;
            }
        }
        if !facts.machine.is_empty() && filters.matches(facts, Some(Facet::Machine)) {
            *machines.entry(facts.machine.as_str()).or_default() += 1;
        }
        if filters.matches(facts, Some(Facet::PullRequests)) {
            if facts.pull_requests {
                facets.with_pull_requests += 1;
            } else {
                facets.without_pull_requests += 1;
            }
        }
    }
    facets.projects = ranked(projects);
    facets.branches = ranked(branches);
    facets.clients = ranked(clients);
    facets.machines = ranked(machines);
    facets
}

/// The most sessions first, then by name.
fn ranked(counts: HashMap<&str, usize>) -> Vec<FacetCount> {
    let mut ranked = counts
        .into_iter()
        .map(|(value, sessions)| FacetCount { value: value.to_string(), sessions })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| right.sessions.cmp(&left.sessions).then_with(|| left.value.cmp(&right.value)));
    ranked
}

/// The client behind a session, as the Sessions page names it but without its
/// version: "Claude Code", "codex exec", "Claude Code · AcmeDesk". Follows
/// `sessionClient` in usageSessions.ts.
pub(super) fn session_client_label(user_agent: &str) -> Option<String> {
    let agent = user_agent.trim();
    if agent.is_empty() {
        return None;
    }
    // ASCII only, so positions in it are positions in `agent`.
    let lower = agent.to_ascii_lowercase();
    let name = client_name(agent, &lower);
    Some(match client_host(agent, &lower) {
        Some(host) => format!("{name} · {host}"),
        None => name,
    })
}

/// The app hosting the client, as the User-Agent itself names it, never from a list of known apps: a `Name/version`
/// token after Claude Code's brackets or Codex's terminal, the client app the Agent SDK lists after its own version,
/// or the client in the brackets Codex ends with when another app starts it.
fn client_host(agent: &str, lower: &str) -> Option<String> {
    let (surface, rest) = product_and_rest(agent, lower)?;
    if surface == "claude-cli" {
        let trimmed = rest.trim_start();
        let (inside, after) = trimmed
            .strip_prefix('(')
            .and_then(|inner| inner.split_once(')'))
            .unwrap_or(("", rest));
        if let Some(host) = host_token(after) {
            return Some(host);
        }
        let parts = inside.split(',').map(str::trim).collect::<Vec<_>>();
        let sdk_at = parts.iter().position(|part| part.to_ascii_lowercase().starts_with("agent-sdk/"))?;
        return parts.get(sdk_at + 1).filter(|part| !part.is_empty()).map(|part| part.to_string());
    }
    let is_codex = surface == "codex desktop"
        || surface
            .strip_prefix("codex")
            .and_then(|tail| tail.strip_prefix(&['-', '_'][..]))
            .is_some_and(|tail| !tail.is_empty() && tail.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
    if !is_codex {
        return None;
    }
    // Codex follows its platform with the terminal, then anything the app running it adds.
    let trimmed = rest.trim_start();
    let after_platform = trimmed
        .strip_prefix('(')
        .and_then(|inner| inner.split_once(')'))
        .map_or(rest, |(_, after)| after);
    let words = without_brackets(after_platform);
    let after_terminal = words.split_whitespace().skip(1).collect::<Vec<_>>().join(" ");
    if let Some(host) = host_token(&after_terminal) {
        return Some(host);
    }
    // `(client; version)` at the end names the client, which is Codex's own name for `codex exec`.
    let inner = after_platform.trim_end().strip_suffix(')')?;
    let open = inner.rfind('(')?;
    let (client, _) = inner[open + 1..].split_once(';')?;
    let client = client.trim();
    (!client.is_empty() && !client.contains(')') && client.to_ascii_lowercase() != surface).then(|| client.to_string())
}

/// The product token in lower case (`claude-cli`, `codex_exec`) and what follows its version, for a User-Agent that
/// starts `product/version`.
fn product_and_rest<'a>(agent: &'a str, lower: &'a str) -> Option<(&'a str, &'a str)> {
    let slash = lower.find('/')?;
    let after = &agent[slash + 1..];
    let version_end = after.find(char::is_whitespace).unwrap_or(after.len());
    (version_end > 0).then(|| (&lower[..slash], &after[version_end..]))
}

/// `text` with each bracketed group taken out.
fn without_brackets(text: &str) -> String {
    let mut depth = 0_usize;
    text.chars()
        .map(|c| match c {
            '(' => {
                depth += 1;
                ' '
            }
            ')' => {
                depth = depth.saturating_sub(1);
                ' '
            }
            _ if depth > 0 => ' ',
            _ => c,
        })
        .collect()
}

/// The name in the first `Name/version` token of `text`, outside brackets.
fn host_token(text: &str) -> Option<String> {
    without_brackets(text).split_whitespace().find_map(|word| {
        let (name, version) = word.split_once('/')?;
        (!name.is_empty() && !version.is_empty()).then(|| name.to_string())
    })
}

/// True when `rest` starts with a slash and something other than a space.
fn slash_and_version(rest: &str) -> bool {
    rest.strip_prefix('/')
        .is_some_and(|version| version.starts_with(|c: char| !c.is_whitespace()))
}

fn client_name(agent: &str, lower: &str) -> String {
    // Claude Code: `claude-cli/VERSION (how, it, was, started)`.
    if let Some(rest) = lower.strip_prefix("claude-cli/") {
        let version_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        if version_end > 0 {
            let started = rest[version_end..]
                .trim_start()
                .strip_prefix('(')
                .and_then(|inner| inner.split_once(')'))
                .map(|(inner, _)| inner)
                .unwrap_or_default();
            let parts = started.split(',').map(str::trim).collect::<Vec<_>>();
            let name = if parts.iter().any(|part| part.starts_with("agent-sdk/")) {
                "Claude Agent SDK"
            } else if parts.contains(&"sdk-cli") {
                "claude -p"
            } else {
                "Claude Code"
            };
            return name.to_string();
        }
    }
    // Codex names its surface in the product token.
    if lower
        .strip_prefix("codex desktop")
        .is_some_and(slash_and_version)
    {
        return "Codex app".to_string();
    }
    if let Some(surface) = lower.strip_prefix("codex").and_then(|rest| rest.strip_prefix(&['-', '_'][..])) {
        let end = surface
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            .unwrap_or(surface.len());
        if end > 0 && slash_and_version(&surface[end..]) {
            let name = if &lower[..6 + end] == "codex_exec" { "codex exec" } else { "Codex CLI" };
            return name.to_string();
        }
    }
    // Anything else by its product name.
    let product_end = agent
        .find(|c: char| c.is_whitespace() || c == '/')
        .unwrap_or(agent.len());
    if product_end > 0 && slash_and_version(&agent[product_end..]) {
        return agent[..product_end].to_string();
    }
    agent.split(char::is_whitespace).next().unwrap_or(agent).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clients_are_named_like_the_sessions_page_names_them() {
        // The same cases as usageSessions.test.ts, so the filter's names match the list's.
        for (agent, label) in [
            ("claude-cli/2.1.280 (external, cli)", Some("Claude Code")),
            ("claude-cli/2.1.280 (external, sdk-cli)", Some("claude -p")),
            ("claude-cli/2.1.280 (external, sdk-ts, agent-sdk/0.3.276)", Some("Claude Agent SDK")),
            ("claude-cli/2.1.280 (external, sdk-ts, agent-sdk/0.3.276, acmedesk)", Some("Claude Agent SDK · acmedesk")),
            ("claude-cli/2.1.280 (external, cli) AcmeDesk/1.4.205", Some("Claude Code · AcmeDesk")),
            ("codex-tui/0.156.0 (Mac OS 26.0.0; arm64) iTerm.app/3.6.1 AcmeDesk/1.4.205", Some("Codex CLI · AcmeDesk")),
            ("codex_cli_rs/0.156.0 (Mac OS 26.0.0; arm64) unknown (acme_desktop; 0.0.42)", Some("Codex CLI · acme_desktop")),
            ("codex_exec/0.156.0 (Mac OS 26.0.0; arm64) dumb", Some("codex exec")),
            ("Codex_Exec/0.156.0", Some("codex exec")),
            ("codex_cli_rs/0.156.0 (Mac OS 26.0.0; arm64)", Some("Codex CLI")),
            ("Codex Desktop/0.156.0 (Mac OS 26.0.0; arm64)", Some("Codex app")),
            ("codex_exec_beta/1.0", Some("Codex CLI")),
            ("python-requests/2.32", Some("python-requests")),
            ("TinyAgent/1.0 curl", Some("TinyAgent")),
            ("claude-cli/ (cli)", Some("claude-cli/")),
            ("curl", Some("curl")),
            ("   ", None),
        ] {
            assert_eq!(session_client_label(agent).as_deref(), label, "{agent}");
        }
    }
}

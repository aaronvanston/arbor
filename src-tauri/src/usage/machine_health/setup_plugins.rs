//! Plugins and MCP servers. Claude Code's plugins are installed, updated,
//! turned on or off and removed with its own `plugin` command, run on the
//! machine for one home at a time, so Claude Code keeps its records as it
//! would for a person there. Marketplaces are refreshed and added the same way.
//! Nothing is accepted on anyone's behalf: a plugin whose install runs a command
//! its marketplace declares is left for someone at the machine.
//!
//! MCP servers are checked with `claude mcp list`, which connects to each one.
//! Only each server's name and how it answered leave the machine, never the
//! command line or address it printed between them, which can hold a secret.

use super::agents::{strip_terminal_codes, AGENT_ENV};
use ts_rs::TS;
use super::shell::shell_quote;
use super::setup::{covered_machine, home_agent, home_extensions, rescan, HomeAgent, ItemKind, MachineSetup};
use super::setup_skills::home_place;
use super::*;
use std::collections::BTreeSet;

/// An install downloads the plugin, and adding a marketplace clones it.
const APPLY_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// `claude mcp list` waits on each server that's slow to answer.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2 * 60);
/// The most changes one apply makes.
const MOST_CHANGES: usize = 50;
/// How much of what Claude Code said about a change the page gets.
const MESSAGE_CHARS: usize = 600;

/// What a change does. An apply makes them in this order.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PluginAction {
    /// Adds a marketplace from its GitHub repository, as another home has it.
    AddMarketplace,
    /// Fetches a marketplace's listing again, for its plugins' newer versions.
    Refresh,
    Install,
    Update,
    Enable,
    Disable,
    /// Removes a plugin, keeping the data it saved.
    Uninstall,
    /// Removes a marketplace no plugin in the home is installed from, once this apply's removals are made.
    RemoveMarketplace,
}

impl PluginAction {
    fn verb(self) -> &'static str {
        match self {
            Self::AddMarketplace => "add",
            Self::Refresh => "refresh",
            Self::Install => "install",
            Self::Update => "update",
            Self::Enable => "turn on",
            Self::Disable => "turn off",
            Self::Uninstall | Self::RemoveMarketplace => "remove",
        }
    }

    fn is_marketplace(self) -> bool {
        matches!(self, Self::AddMarketplace | Self::Refresh | Self::RemoveMarketplace)
    }
}

/// A change in one Claude Code home, as the page asks for it.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginChange {
    /// The home, as the scan names it: ~/.claude.
    home: String,
    action: PluginAction,
    /// A plugin as `name@marketplace`, or a marketplace's name.
    target: String,
    /// Where a marketplace being added comes from: `owner/repo` on GitHub.
    #[serde(default)]
    #[ts(optional)]
    source: Option<String>,
    /// A checkout the last Projects scan found, to turn the plugin on or off in its own local
    /// settings (Claude Code's local scope) rather than the home's.
    #[serde(default)]
    #[ts(optional)]
    checkout: Option<String>,
}

/// How a change went.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PluginOutcome {
    Done,
    /// It was already so.
    Already,
    /// Its install runs a command its marketplace declares, which someone at the machine has to accept.
    NeedsYou,
    Failed,
    /// Not tried, because the marketplace it's from couldn't be added.
    Skipped,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginResult {
    home: String,
    action: PluginAction,
    target: String,
    /// The checkout it was made in, for a project's value.
    checkout: Option<String>,
    outcome: PluginOutcome,
    /// What Claude Code said, without anything like a password in an address.
    message: String,
}

/// A change as it's made.
#[derive(Debug, PartialEq)]
struct Planned {
    home: String,
    /// The home's folder under the machine's home folder, or None for ~/.claude, which Claude
    /// Code uses when it isn't told another.
    config_dir: Option<String>,
    action: PluginAction,
    target: String,
    source: Option<String>,
    /// The change this one needs to have worked first: the adding of its marketplace.
    after: Option<usize>,
    /// Made in this checkout's local settings.
    checkout: Option<String>,
}

/// A plugin's or marketplace's name, as Claude Code gives them.
fn is_name(value: &str) -> bool {
    value.len() <= 128
        && value.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// A plugin, `name@marketplace`, and its marketplace.
fn plugin_marketplace(id: &str) -> Option<&str> {
    let (name, marketplace) = id.split_once('@')?;
    (is_name(name) && is_name(marketplace)).then_some(marketplace)
}

/// A GitHub repository as `owner/repo`.
fn is_github_repo(value: &str) -> bool {
    let Some((owner, repo)) = value.split_once('/') else {
        return false;
    };
    owner.len() <= 39
        && owner.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && owner.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && repo.len() <= 100
        && repo.as_bytes().first().is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
        && repo.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// The home's folder to give Claude Code, as `home_place` has it, or None for its own ~/.claude.
fn config_dir(home: &str) -> Option<String> {
    home_place(home).filter(|place| *place != ".claude").map(str::to_string)
}

/// A Claude Code home the machine's last scan found.
fn claude_home(setup: &MachineSetup, home: &str) -> Result<(), String> {
    match (home_place(home), home_agent(setup, home)) {
        (Some(_), Some(HomeAgent::Claude)) => Ok(()),
        _ => Err(format!("{home} isn't a Claude Code home on this machine")),
    }
}

/// Checks each change against what the last scan found, and puts them in order.
fn plan(setup: &MachineSetup, changes: Vec<PluginChange>, checkouts: &[String]) -> Result<Vec<Planned>, String> {
    if changes.is_empty() {
        return Err("There's nothing to change".into());
    }
    if changes.len() > MOST_CHANGES {
        return Err(format!("Arbor makes at most {MOST_CHANGES} changes at a time"));
    }
    let adding: BTreeSet<(&str, &str)> = changes
        .iter()
        .filter(|change| change.action == PluginAction::AddMarketplace)
        .map(|change| (change.home.as_str(), change.target.as_str()))
        .collect();
    let removing: BTreeSet<(&str, &str)> = changes
        .iter()
        .filter(|change| change.action == PluginAction::Uninstall && change.checkout.is_none())
        .map(|change| (change.home.as_str(), change.target.as_str()))
        .collect();
    let mut seen = BTreeSet::new();
    let mut planned = Vec::with_capacity(changes.len());
    for change in &changes {
        claude_home(setup, &change.home)?;
        let what = match &change.checkout {
            Some(checkout) => format!("{} in {checkout}", change.target),
            None => format!("{} in {}", change.target, change.home),
        };
        if !seen.insert((change.checkout.as_ref().unwrap_or(&change.home), change.action.is_marketplace(), &change.target)) {
            return Err(format!("{what} is in the changes twice"));
        }
        let marketplaces = home_extensions(setup, &change.home, ItemKind::Marketplace);
        let known = |name: &str| marketplaces.iter().any(|(known, ..)| known == name);
        if let Some(checkout) = &change.checkout {
            // A project's value only turns an installed plugin on or off, in a checkout the scan found.
            if !checkouts.contains(checkout) {
                return Err(format!("Arbor doesn't know a checkout at {checkout} on this machine; scan its projects first"));
            }
            if !matches!(change.action, PluginAction::Enable | PluginAction::Disable) || plugin_marketplace(&change.target).is_none() {
                return Err(format!("Arbor can only turn {what} on or off"));
            }
            if setup.policy_sets(ItemKind::Plugin, &change.target) {
                return Err(format!("The managed settings policy on this machine sets {what}, so Arbor leaves it as the policy has it"));
            }
            let installed = home_extensions(setup, &change.home, ItemKind::Plugin).iter().any(|(id, version, _)| *id == change.target && version.is_some());
            if change.action == PluginAction::Enable && !installed {
                return Err(format!("{} isn't installed in {}, so a checkout can't turn it on", change.target, change.home));
            }
            planned.push(Planned {
                home: change.home.clone(),
                config_dir: config_dir(&change.home),
                action: change.action,
                target: change.target.clone(),
                source: None,
                after: None,
                checkout: Some(checkout.clone()),
            });
            continue;
        }
        let fits = if change.action.is_marketplace() {
            if !is_name(&change.target) {
                return Err(format!("Arbor doesn't change a marketplace called {}", change.target));
            }
            match change.action {
                PluginAction::AddMarketplace => !known(&change.target) && change.source.as_deref().is_some_and(is_github_repo),
                PluginAction::RemoveMarketplace => {
                    // Claude Code would take its plugins with it, so every one installed from it has to be going too.
                    let left: Vec<String> = home_extensions(setup, &change.home, ItemKind::Plugin)
                        .into_iter()
                        .filter(|(id, version, _)| version.is_some() && plugin_marketplace(id) == Some(change.target.as_str()))
                        .filter(|(id, ..)| !removing.contains(&(change.home.as_str(), id.as_str())))
                        .map(|(id, ..)| id)
                        .collect();
                    if !left.is_empty() {
                        return Err(format!("{} still has {} installed from {}; remove those first", change.home, left.join(", "), change.target));
                    }
                    known(&change.target)
                }
                _ => known(&change.target),
            }
        } else {
            let Some(marketplace) = plugin_marketplace(&change.target) else {
                return Err(format!("Arbor doesn't change a plugin called {}", change.target));
            };
            // Each of these writes the plugin into the home's enabledPlugins, which the policy decides when it names it.
            if change.action != PluginAction::Update && setup.policy_sets(ItemKind::Plugin, &change.target) {
                return Err(format!("The managed settings policy on this machine sets {what}, so Arbor leaves it as the policy has it"));
            }
            let plugins = home_extensions(setup, &change.home, ItemKind::Plugin);
            let found = plugins.iter().find(|(id, ..)| *id == change.target);
            let installed = found.is_some_and(|(_, version, _)| version.is_some());
            let on = found.and_then(|(.., enabled)| *enabled);
            match change.action {
                PluginAction::Install => !installed && (known(marketplace) || adding.contains(&(change.home.as_str(), marketplace))),
                PluginAction::Enable => installed && on != Some(true),
                PluginAction::Disable => installed && on != Some(false),
                _ => installed,
            }
        };
        if !fits {
            return Err(format!("Arbor can't {} {what} as it is", change.action.verb()));
        }
        planned.push(Planned {
            home: change.home.clone(),
            config_dir: config_dir(&change.home),
            action: change.action,
            target: change.target.clone(),
            source: change.source.clone().filter(|_| change.action == PluginAction::AddMarketplace),
            after: None,
            checkout: None,
        });
    }
    planned.sort_by_key(|change| change.action);
    for index in 0..planned.len() {
        if planned[index].action != PluginAction::Install {
            continue;
        }
        let marketplace = plugin_marketplace(&planned[index].target).unwrap_or_default();
        let after = planned
            .iter()
            .position(|add| add.action == PluginAction::AddMarketplace && add.home == planned[index].home && add.target == marketplace);
        planned[index].after = after;
    }
    Ok(planned)
}

// Follows AGENT_ENV. Claude Code runs where no project's settings or servers
// are, and never with a terminal to ask on, so it can't be waiting on a person
// or take the change's words as a prompt: one too old to have these commands is
// refused before anything runs. `change` runs one change: its number, its home's
// folder under $HOME or whole (empty for ~/.claude), then the words for Claude Code. It
// gives the last line Claude Code printed, which with --json is the result, or
// for a command that failed without one, the last it printed as an error.
const APPLY_FUNCTIONS: &str = r##"export GIT_TERMINAL_PROMPT=0 DISABLE_AUTOUPDATER=1
unset CLAUDE_CONFIG_DIR
bin=$(command -v claude 2>/dev/null || true)
case "$bin" in
  /*) ;;
  *) echo "Claude Code isn't installed where Arbor looks for it" >&2; exit 127 ;;
esac
if ! "$bin" plugin --help </dev/null 2>/dev/null | grep -Eq '^[[:space:]]+marketplace([[:space:]|,]|$)' ||
  ! "$bin" plugin install --help </dev/null 2>/dev/null | grep -q -e '--json'; then
  echo "This version of Claude Code can't change plugins for Arbor. Update it first." >&2
  exit 2
fi
keep=
if "$bin" plugin uninstall --help </dev/null 2>/dev/null | grep -q -e '--keep-data'; then keep=--keep-data; fi
cd / || exit 3
out=$(mktemp "${TMPDIR:-/tmp}/arbor-plugins.XXXXXX") || exit 3
err=$(mktemp "${TMPDIR:-/tmp}/arbor-plugins.XXXXXX") || { rm -f "$out"; exit 3; }
trap 'rm -f "$out" "$err"' EXIT
change() {
  n=$1; dir=$2; shift 2
  case $dir in /* | '') ;; *) dir=$HOME/$dir ;; esac
  if [ -n "$dir" ]; then
    CLAUDE_CONFIG_DIR="$dir" "$bin" "$@" </dev/null >"$out" 2>"$err"
  else
    "$bin" "$@" </dev/null >"$out" 2>"$err"
  fi
  code=$?
  if [ "$code" -eq 0 ]; then eval "ok_$n=1"; fi
  last=$(grep -v '^[[:space:]]*$' "$out" | tail -n 1)
  case "$last" in
    "{"*) ;;
    *)
      if [ "$code" -ne 0 ] || [ -z "$last" ]; then
        said=$(grep -v '^[[:space:]]*$' "$err" | tail -n 1)
        if [ -n "$said" ]; then last=$said; fi
      fi
      ;;
  esac
  printf 'R\t%s\t%s\t%s\n' "$n" "$code" "$(printf '%s' "$last" | tr '\t\r' '  ' | cut -c 1-4000)"
}
"##;

/// Claude Code's words for a change, quoted for the shell.
fn command_words(change: &Planned) -> String {
    let target = shell_quote(&change.target);
    // A checkout's own value, which Claude Code keeps in its .claude/settings.local.json.
    if change.checkout.is_some() {
        let verb = if change.action == PluginAction::Enable { "enable" } else { "disable" };
        return format!("plugin {verb} {target} --scope local --json");
    }
    match change.action {
        PluginAction::AddMarketplace => format!("plugin marketplace add {} --scope user", shell_quote(change.source.as_deref().unwrap_or_default())),
        PluginAction::Refresh => format!("plugin marketplace update {target}"),
        PluginAction::RemoveMarketplace => format!("plugin marketplace remove {target}"),
        PluginAction::Install => format!("plugin install {target} --scope user --json"),
        PluginAction::Update => format!("plugin update {target} --scope user --json"),
        PluginAction::Enable => format!("plugin enable {target} --scope user --json"),
        PluginAction::Disable => format!("plugin disable {target} --scope user --json"),
        PluginAction::Uninstall => format!("plugin uninstall {target} --scope user --json $keep"),
    }
}

fn apply_script(planned: &[Planned]) -> String {
    let mut script = format!("{AGENT_ENV}{APPLY_FUNCTIONS}");
    for (index, change) in planned.iter().enumerate() {
        let mut run = format!("change {index} {} {}", shell_quote(change.config_dir.as_deref().unwrap_or_default()), command_words(change));
        if let Some(checkout) = &change.checkout {
            // Claude Code finds the project's settings from where it runs.
            run = format!(
                "if cd -- {} 2>/dev/null; then {run}; cd /; else printf 'R\\t{index}\\t1\\t%s\\n' 'The checkout isn'\\''t there any more'; fi",
                shell_quote(checkout)
            );
        }
        match change.after {
            Some(after) => script.push_str(&format!("if [ \"${{ok_{after}:-}}\" = 1 ]; then {run}; else printf 'S\\t{index}\\n'; fi\n")),
            None => script.push_str(&format!("{run}\n")),
        }
    }
    script
}

/// `text` without the user name and password an address can carry: `https://user:token@host`
/// gives `https://host`.
fn without_credentials(text: &str) -> String {
    let mut clean = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let (before, after) = rest.split_at(at + 3);
        clean.push_str(before);
        let end = after
            .find(|c: char| c.is_whitespace() || matches!(c, '/' | '"' | '\'' | '`' | ')' | '>' | ',' | ';'))
            .unwrap_or(after.len());
        let authority = &after[..end];
        clean.push_str(authority.rfind('@').map_or(authority, |at| &authority[at + 1..]));
        rest = &after[end..];
    }
    clean.push_str(rest);
    clean
}

/// What Claude Code said, fit for the page.
pub(super) fn message(text: &str) -> String {
    let plain = without_credentials(strip_terminal_codes(text).trim());
    match plain.char_indices().nth(MESSAGE_CHARS) {
        Some((end, _)) => format!("{}…", &plain[..end]),
        None => plain,
    }
}

/// How a change went, from Claude Code's exit code and the last line it printed.
fn outcome(code: Option<i32>, last: &str) -> (PluginOutcome, String) {
    let result = serde_json::from_str::<Value>(last.trim()).ok().filter(|result| result.get("outcome").is_some_and(Value::is_string));
    if let Some(result) = result {
        let said = result.get("message").and_then(Value::as_str).unwrap_or_default();
        let outcome = if result.get("alreadyInGoalState").and_then(Value::as_bool) == Some(true)
            || result.get("failureCode").and_then(Value::as_str) == Some("already_in_goal_state")
        {
            PluginOutcome::Already
        } else if result.get("outcome").and_then(Value::as_str) == Some("ok") {
            PluginOutcome::Done
        } else if result.get("shownCommand").is_some() {
            PluginOutcome::NeedsYou
        } else {
            PluginOutcome::Failed
        };
        return (outcome, message(said));
    }
    // The marketplace commands say how they went in words.
    let outcome = match code {
        Some(0) if last.contains("already") => PluginOutcome::Already,
        Some(0) => PluginOutcome::Done,
        _ => PluginOutcome::Failed,
    };
    (outcome, message(last))
}

/// Each change's result, from what the apply printed.
fn parse_results(stdout: &str, planned: &[Planned]) -> Vec<PluginResult> {
    let mut outcomes: Vec<Option<(PluginOutcome, String)>> = vec![None; planned.len()];
    for line in stdout.lines() {
        let mut fields = line.splitn(4, '\t');
        let (kind, index) = (fields.next(), fields.next().and_then(|index| index.parse::<usize>().ok()));
        let Some(slot) = index.and_then(|index| outcomes.get_mut(index)) else {
            continue;
        };
        match kind {
            Some("R") => {
                let code = fields.next().and_then(|code| code.parse::<i32>().ok());
                *slot = Some(outcome(code, fields.next().unwrap_or_default()));
            }
            Some("S") => *slot = Some((PluginOutcome::Skipped, "Its marketplace couldn't be added".into())),
            _ => {}
        }
    }
    planned
        .iter()
        .zip(outcomes)
        .map(|(change, outcome)| {
            let (outcome, message) = outcome.unwrap_or_else(|| (PluginOutcome::Failed, "Arbor didn't hear how this went".into()));
            PluginResult { home: change.home.clone(), action: change.action, target: change.target.clone(), checkout: change.checkout.clone(), outcome, message }
        })
        .collect()
}

/// Makes the changes in a machine's Claude Code homes with Claude Code's own `plugin` command,
/// then scans the machine again.
#[tauri::command]
pub(crate) async fn apply_plugin_changes(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    changes: Vec<PluginChange>,
) -> Result<Vec<PluginResult>, String> {
    let (target, planned) = {
        let inner = state.lock();
        let (target, setup) = covered_machine(&inner, &machine)?;
        let checkouts: Vec<String> = inner.projects.get(&machine).map(|projects| projects.checkout_paths()).unwrap_or_default();
        (target, plan(setup, changes, &checkouts)?)
    };
    // Each change reports its own line, so a script that stopped part way still says what it did.
    let output = run_on_machine(&target, MachineOp::PluginApply, &apply_script(&planned), APPLY_TIMEOUT).await;
    rescan(&app, &machine);
    let output = output?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() && !stdout.lines().any(|line| line.starts_with("R\t")) {
        return Err(failure_detail(&output));
    }
    Ok(parse_results(&stdout, &planned))
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

/// How an MCP server answered `claude mcp list`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum McpStatus {
    Connected,
    /// It needs someone to sign in to it on that machine.
    NeedsAuth,
    Failed,
    /// A project's server nobody has approved yet.
    Pending,
    Disabled,
}

impl McpStatus {
    fn parse(code: &str) -> Option<Self> {
        match code {
            "ok" => Some(Self::Connected),
            "auth" => Some(Self::NeedsAuth),
            "failed" => Some(Self::Failed),
            "pending" => Some(Self::Pending),
            "off" => Some(Self::Disabled),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerHealth {
    /// As Claude Code lists it: a plugin's servers go by `plugin:<plugin>:<server>`.
    name: String,
    status: McpStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpHealth {
    home: String,
    checked_at: i64,
    servers: Vec<McpServerHealth>,
}

// Follows AGENT_ENV and `dir`, the home's folder under $HOME or whole (empty for
// ~/.claude). What `claude mcp list` prints goes straight into awk on the
// machine, which keeps each server's name and a word for how it answered.
const HEALTH_SCRIPT: &str = r##"unset CLAUDE_CONFIG_DIR
case $dir in /* | '') ;; *) dir=$HOME/$dir ;; esac
if [ -n "$dir" ]; then CLAUDE_CONFIG_DIR=$dir; export CLAUDE_CONFIG_DIR; fi
bin=$(command -v claude 2>/dev/null || true)
case "$bin" in
  /*) ;;
  *) echo "Claude Code isn't installed where Arbor looks for it" >&2; exit 127 ;;
esac
if ! "$bin" mcp --help </dev/null 2>/dev/null | grep -Eq '^[[:space:]]+list([[:space:]|,]|$)'; then
  echo "This version of Claude Code can't list its MCP servers" >&2
  exit 2
fi
cd / || exit 3
{ "$bin" mcp list </dev/null 2>/dev/null; printf '\n@@arbor-exit %s\n' "$?"; } | awk '
  /^@@arbor-exit / { printf "X\t%s\n", $2; next }
  {
    i = index($0, ": ")
    if (i < 2) next
    name = substr($0, 1, i - 1)
    if (length(name) > 120 || name ~ /[^A-Za-z0-9_.:@ -]/) next
    rest = $0; found = 0
    while ((k = index(rest, " - ")) > 0) { rest = substr(rest, k + 3); found = 1 }
    if (!found) next
    if (rest ~ /Connected/) status = "ok"
    else if (rest ~ /[Nn]eeds [Aa]uth/) status = "auth"
    else if (rest ~ /[Ff]ailed/) status = "failed"
    else if (rest ~ /[Pp]ending/) status = "pending"
    else if (rest ~ /[Dd]isabled/) status = "off"
    else next
    printf "M\t%s\t%s\n", name, status
  }'
"##;

fn health_script(dir: Option<&str>) -> String {
    format!("{AGENT_ENV}dir={}\n{HEALTH_SCRIPT}", shell_quote(dir.unwrap_or_default()))
}

/// A server's name as `claude mcp list` gives it.
fn is_server_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 120 && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.:@ -".contains(&byte))
}

fn parse_health(stdout: &str) -> Result<Vec<McpServerHealth>, String> {
    let mut servers: Vec<McpServerHealth> = Vec::new();
    let mut code = None;
    for line in stdout.lines() {
        let mut fields = line.split('\t');
        match (fields.next(), fields.next(), fields.next()) {
            (Some("M"), Some(name), Some(status)) if is_server_name(name) => {
                if let Some(status) = McpStatus::parse(status) {
                    if !servers.iter().any(|server| server.name == name) {
                        servers.push(McpServerHealth { name: name.to_string(), status });
                    }
                }
            }
            (Some("X"), Some(exit), None) => code = exit.trim().parse::<i32>().ok(),
            _ => {}
        }
    }
    match code {
        Some(0) => Ok(servers),
        Some(code) => Err(format!("claude mcp list stopped with code {code} there")),
        None => Err("Arbor couldn't tell how claude mcp list went there".into()),
    }
}

/// Connects to each MCP server a Claude Code home has, on its machine, the way `claude mcp list`
/// does, and says how each answered.
#[tauri::command]
pub(crate) async fn check_mcp_health(state: tauri::State<'_, MachineHealthState>, machine: String, home: String) -> Result<McpHealth, String> {
    let target = {
        let inner = state.lock();
        let (target, setup) = covered_machine(&inner, &machine)?;
        claude_home(setup, &home)?;
        target
    };
    let servers = parse_health(&run_checked(&target, MachineOp::McpHealth, &health_script(config_dir(&home).as_deref()), HEALTH_TIMEOUT).await?)?;
    Ok(McpHealth { home, checked_at: Local::now().timestamp_millis(), servers })
}

// ---------------------------------------------------------------------------
// Token cost
// ---------------------------------------------------------------------------

/// `claude plugin details` runs once per plugin, each a Claude Code start.
const COST_TIMEOUT: Duration = Duration::from_secs(3 * 60);
/// More plugins than any home has; the rest wait for another measure.
const COST_PLUGINS_MAX: usize = 60;

/// Claude Code's estimate of some tokens, rounded as it prints them.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TokenEstimate {
    tokens: u32,
    /// It only said there are fewer than `tokens`.
    under: bool,
}

/// One of a plugin's skills, commands or agents: what its listing adds to every session, and what
/// it adds again each time it's used.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComponentCost {
    name: String,
    always_on: Option<TokenEstimate>,
    on_invoke: Option<TokenEstimate>,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginCost {
    id: String,
    /// Added to every session in the home while the plugin is on.
    always_on: Option<TokenEstimate>,
    components: Vec<ComponentCost>,
    /// What it brings, as Claude Code counts it: `skills`, `agents`, `hooks`, `mcpServers`, `lspServers`.
    counts: BTreeMap<String, u32>,
    /// Why Claude Code couldn't say.
    error: Option<String>,
}

/// What `claude plugin details` said about each plugin installed in one Claude Code home.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginCosts {
    home: String,
    measured_at: i64,
    plugins: Vec<PluginCost>,
}

// Follows AGENT_ENV, `dir` (as for the health check) and the plugins' ids as
// the script's arguments. What `claude plugin details` prints goes straight
// into awk on the machine, which keeps the numbers and the components' names,
// never the plugin's description or anything its MCP servers run.
const COST_SCRIPT: &str = r##"unset CLAUDE_CONFIG_DIR
case $dir in /* | '') ;; *) dir=$HOME/$dir ;; esac
if [ -n "$dir" ]; then CLAUDE_CONFIG_DIR=$dir; export CLAUDE_CONFIG_DIR; fi
bin=$(command -v claude 2>/dev/null || true)
case "$bin" in
  /*) ;;
  *) echo "Claude Code isn't installed where Arbor looks for it" >&2; exit 127 ;;
esac
if ! "$bin" plugin --help </dev/null 2>/dev/null | grep -Eq '^[[:space:]]+details([[:space:]]|$)'; then
  echo "This version of Claude Code can't say what a plugin costs. Update it first." >&2
  exit 2
fi
cd / || exit 3
for id in "$@"; do
  { "$bin" plugin details "$id" </dev/null 2>/dev/null; printf '\n@@arbor-exit %s\n' "$?"; } | awk -v id="$id" '
    function amount(text) {
      gsub(/^[[:space:]]+/, "", text)
      under = ""
      if (substr(text, 1, 1) == "<") { under = "<"; text = substr(text, 2); gsub(/^[[:space:]]+/, "", text) }
      if (substr(text, 1, 1) == "~") text = substr(text, 2)
      n = text; sub(/[^0-9.,kK].*$/, "", n)
      if (n == "" || n !~ /^[0-9]/) return "-"
      return under n
    }
    function name_ok(text) { return length(text) > 0 && length(text) <= 120 && text !~ /[^A-Za-z0-9_.:@-]/ }
    /^@@arbor-exit / { printf "X\t%s\t%s\n", id, $2; next }
    /^Component inventory/ { part = "inventory"; next }
    /^Projected token cost/ { part = "cost"; next }
    /^Per-component/ { part = "components"; next }
    /^[^[:space:]]/ { part = ""; next }
    /^[[:space:]]*$/ { if (part == "components" && rows) part = ""; next }
    part == "inventory" {
      line = $0; gsub(/^[[:space:]]+/, "", line)
      open = index(line, " ("); shut = index(line, ")")
      if (open < 2 || shut < open) next
      kind = substr(line, 1, open - 1); count = substr(line, open + 2, shut - open - 2)
      if (kind ~ /^(Skills|Agents|Hooks|MCP servers|LSP servers)$/ && count ~ /^[0-9]+$/) printf "K\t%s\t%s\t%s\n", id, kind, count
      next
    }
    part == "cost" && /^[[:space:]]*Always-on:/ {
      rest = $0; sub(/^[[:space:]]*Always-on:/, "", rest)
      printf "A\t%s\t%s\n", id, amount(rest)
      next
    }
    part == "components" && NF >= 3 && $1 != "component" && $1 != "On-invoke" && $1 != "Token" {
      if (!name_ok($1)) next
      rest = $0; sub(/^[[:space:]]*[^[:space:]]+/, "", rest)
      # Two amounts, each "~30", "< 20" or a bare number, a run of spaces apart.
      gsub(/<[[:space:]]+/, "<", rest)
      cellCount = split(rest, cells, /[[:space:]]+/)
      found = 0; first = "-"; second = "-"
      for (i = 1; i <= cellCount; i++) {
        if (cells[i] == "") continue
        found++
        if (found == 1) first = amount(cells[i]); else if (found == 2) second = amount(cells[i])
      }
      if (found == 2 && first != "-" && second != "-") { rows++; printf "C\t%s\t%s\t%s\t%s\n", id, $1, first, second }
    }'
done
"##;

fn cost_script(dir: Option<&str>, ids: &[String]) -> String {
    let ids: Vec<String> = ids.iter().map(|id| shell_quote(id)).collect();
    format!("{AGENT_ENV}dir={}\nset -- {}\n{COST_SCRIPT}", shell_quote(dir.unwrap_or_default()), ids.join(" "))
}

/// An amount as the script passes it on: `57`, `<20`, `1,234` or `1.2k`, or `-` for none.
fn token_estimate(text: &str) -> Option<TokenEstimate> {
    let (under, number) = match text.strip_prefix('<') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let number = number.replace(',', "");
    let tokens = match number.strip_suffix(['k', 'K']) {
        Some(thousands) => thousands.parse::<f64>().ok().map(|value| (value * 1_000.0).round()),
        None => number.parse::<f64>().ok(),
    }?;
    (tokens.is_finite() && (0.0..=u32::MAX as f64).contains(&tokens)).then_some(TokenEstimate { tokens: tokens as u32, under })
}

fn count_key(kind: &str) -> Option<&'static str> {
    match kind {
        "Skills" => Some("skills"),
        "Agents" => Some("agents"),
        "Hooks" => Some("hooks"),
        "MCP servers" => Some("mcpServers"),
        "LSP servers" => Some("lspServers"),
        _ => None,
    }
}

fn parse_costs(stdout: &str, ids: &[String]) -> Vec<PluginCost> {
    let mut costs: Vec<PluginCost> =
        ids.iter().map(|id| PluginCost { id: id.clone(), always_on: None, components: Vec::new(), counts: BTreeMap::new(), error: None }).collect();
    let mut exits: BTreeMap<String, i32> = BTreeMap::new();
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        let Some(cost) = fields.get(1).and_then(|id| costs.iter_mut().find(|cost| cost.id == *id)) else {
            continue;
        };
        match fields.as_slice() {
            ["A", _, amount] => cost.always_on = token_estimate(amount),
            ["K", _, kind, count] => {
                if let (Some(key), Ok(count)) = (count_key(kind), count.parse::<u32>()) {
                    cost.counts.insert(key.to_string(), count);
                }
            }
            ["C", _, name, always, invoke] if cost.components.len() < 200 => {
                cost.components.push(ComponentCost { name: name.to_string(), always_on: token_estimate(always), on_invoke: token_estimate(invoke) })
            }
            ["X", id, code] => {
                exits.insert(id.to_string(), code.trim().parse().unwrap_or(-1));
            }
            _ => {}
        }
    }
    for cost in &mut costs {
        match exits.get(&cost.id) {
            None => cost.error = Some("Arbor couldn't tell how claude plugin details went there".into()),
            Some(code) if *code != 0 => cost.error = Some(format!("claude plugin details stopped with code {code} there")),
            Some(_) if cost.always_on.is_none() => cost.error = Some("Claude Code didn't say what it costs".into()),
            Some(_) => {}
        }
    }
    costs
}

/// What each plugin installed in a Claude Code home adds to its sessions, as Claude Code
/// estimates it there with `claude plugin details`.
#[tauri::command]
pub(crate) async fn measure_plugin_costs(state: tauri::State<'_, MachineHealthState>, machine: String, home: String) -> Result<PluginCosts, String> {
    let (target, ids) = {
        let inner = state.lock();
        let (target, setup) = covered_machine(&inner, &machine)?;
        claude_home(setup, &home)?;
        let ids: Vec<String> = home_extensions(setup, &home, ItemKind::Plugin)
            .into_iter()
            .filter(|(id, version, _)| version.is_some() && plugin_marketplace(id).is_some())
            .map(|(id, _, _)| id)
            .take(COST_PLUGINS_MAX)
            .collect();
        (target, ids)
    };
    if ids.is_empty() {
        return Ok(PluginCosts { home, measured_at: Local::now().timestamp_millis(), plugins: Vec::new() });
    }
    let plugins = parse_costs(&run_checked(&target, MachineOp::PluginCost, &cost_script(config_dir(&home).as_deref(), &ids), COST_TIMEOUT).await?, &ids);
    Ok(PluginCosts { home, measured_at: Local::now().timestamp_millis(), plugins })
}

// ---------------------------------------------------------------------------
// Leftovers
// ---------------------------------------------------------------------------

/// A plugin a Claude Code home's settings.json still names in enabledPlugins though it isn't installed there, which
/// Claude Code leaves behind when a plugin goes.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginLeftover {
    home: String,
    plugin: String,
}

/// The leftovers by home, once the machine's last scan agrees each one is named there and not installed, and the
/// managed settings policy doesn't name it.
fn leftovers_by_home(setup: &MachineSetup, leftovers: &[PluginLeftover]) -> Result<BTreeMap<String, Vec<String>>, String> {
    if leftovers.is_empty() {
        return Err("There's nothing to clean up".into());
    }
    let mut homes: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for leftover in leftovers {
        if home_agent(setup, &leftover.home) != Some(HomeAgent::Claude) {
            return Err(format!("{} isn't a Claude Code home on this machine", leftover.home));
        }
        let found = home_extensions(setup, &leftover.home, ItemKind::Plugin).into_iter().find(|(id, ..)| *id == leftover.plugin);
        match found {
            Some((_, None, _)) => {}
            Some(_) => return Err(format!("{} is installed in {}, so its setting isn't a leftover", leftover.plugin, leftover.home)),
            None => return Err(format!("{} doesn't name {} as the last scan found it. Scan again.", leftover.home, leftover.plugin)),
        }
        if setup.policy_sets(ItemKind::Plugin, &leftover.plugin) {
            return Err(format!("The managed settings policy on this machine names {}, so Arbor leaves it", leftover.plugin));
        }
        let entry = homes.entry(leftover.home.clone()).or_default();
        if !entry.contains(&leftover.plugin) {
            entry.push(leftover.plugin.clone());
        }
    }
    Ok(homes)
}

/// Takes plugins that are gone out of the settings that still name them, home by home, the careful way: only while
/// each file is as read, backed up first, and on Sync › Repo › Arbor's changes to undo. Then the machine is read again.
#[tauri::command]
pub(crate) async fn forget_plugin_leftovers(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    leftovers: Vec<PluginLeftover>,
) -> Result<Vec<super::attention::SettingsEdit>, String> {
    let (target, homes) = {
        let inner = state.lock();
        let (target, setup) = covered_machine(&inner, &machine)?;
        (target, leftovers_by_home(setup, &leftovers)?)
    };
    let mut edits = Vec::new();
    for (home, plugins) in &homes {
        let names: Vec<&str> = plugins.iter().map(String::as_str).collect();
        let edit = |content: Option<&str>| super::attention::drop_claude_setting_entries(content, "enabledPlugins", &names);
        edits.extend(super::attention::edit_claude_settings(|| &target, std::slice::from_ref(home), super::guarded_writes::ChangeKind::Plugins, edit, true).await?);
    }
    rescan(&app, &machine);
    Ok(edits)
}

// ---------------------------------------------------------------------------
// Codex plugins
// ---------------------------------------------------------------------------

/// Marketplaces the Codex app keeps for itself, from folders it manages. Arbor never changes their plugins.
const CODEX_OWN_MARKETPLACES: [&str; 2] = ["openai-bundled", "openai-primary-runtime"];

pub(super) fn is_codex_own_marketplace(marketplace: &str) -> bool {
    CODEX_OWN_MARKETPLACES.contains(&marketplace)
}

/// A change to a plugin in one Codex home.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexPluginChange {
    /// The home, as the scan names it: ~/.codex.
    home: String,
    /// AddMarketplace, Install, Enable, Disable or Uninstall.
    action: PluginAction,
    /// `name@marketplace`, or a marketplace's name to add.
    target: String,
    /// The GitHub repository a marketplace is added from.
    #[serde(default)]
    #[ts(optional)]
    source: Option<String>,
}

/// A Codex change as it's made: its home's folder under the machine's home folder, or None for ~/.codex, which
/// Codex uses when it isn't told another.
#[derive(Debug, PartialEq)]
struct CodexPlanned {
    home: String,
    codex_home: Option<String>,
    action: PluginAction,
    target: String,
    source: Option<String>,
}

/// Checks each Codex change against what the last scan found. A marketplace a plugin needs is added first, then
/// installs and removals, all with Codex's own `plugin` command, then turning plugins on and off, which is its
/// config.toml's `enabled`. A plugin can be installed from a marketplace the same changes add.
fn codex_plan(setup: &MachineSetup, changes: Vec<CodexPluginChange>) -> Result<Vec<CodexPlanned>, String> {
    if changes.is_empty() {
        return Err("There's nothing to change".into());
    }
    if changes.len() > MOST_CHANGES {
        return Err(format!("Arbor makes at most {MOST_CHANGES} changes at a time"));
    }
    let mut seen = BTreeSet::new();
    let mut planned = Vec::with_capacity(changes.len());
    let known = |home: &str, marketplace: &str| home_extensions(setup, home, ItemKind::Marketplace).iter().any(|(name, ..)| name == marketplace);
    let adding: BTreeSet<(String, String)> =
        changes.iter().filter(|change| change.action == PluginAction::AddMarketplace).map(|change| (change.home.clone(), change.target.clone())).collect();
    for change in changes {
        let rel = match (home_place(&change.home), home_agent(setup, &change.home)) {
            (Some(place), Some(HomeAgent::Codex)) => place.to_string(),
            _ => return Err(format!("{} isn't a Codex home on this machine", change.home)),
        };
        let what = format!("{} in {}", change.target, change.home);
        if !seen.insert((change.home.clone(), change.target.clone())) {
            return Err(format!("{what} is in the changes twice"));
        }
        if change.action == PluginAction::AddMarketplace {
            let name = &change.target;
            if CODEX_OWN_MARKETPLACES.contains(&name.as_str()) {
                return Err(format!("{name} is the Codex app's own, so Arbor leaves it as the app has it"));
            }
            if !is_name(name) {
                return Err(format!("Arbor doesn't add a marketplace called {name}"));
            }
            if !change.source.as_deref().is_some_and(is_github_repo) {
                return Err(format!("Arbor adds {name} only from a GitHub repository, owner/name"));
            }
            if known(&change.home, name) {
                return Err(format!("{what} is there already"));
            }
            planned.push(CodexPlanned { home: change.home, codex_home: (rel != ".codex").then_some(rel), action: change.action, target: change.target, source: change.source });
            continue;
        }
        let Some(marketplace) = plugin_marketplace(&change.target) else {
            return Err(format!("Arbor doesn't change a plugin called {}", change.target));
        };
        if CODEX_OWN_MARKETPLACES.contains(&marketplace) {
            return Err(format!("{marketplace} is the Codex app's own, so Arbor leaves its plugins as the app has them"));
        }
        // Codex lists a plugin in its config once it's installed, and its scan item is that listing.
        let found = home_extensions(setup, &change.home, ItemKind::Plugin).into_iter().find(|(id, ..)| *id == change.target);
        let on = found.as_ref().map(|(.., enabled)| enabled.unwrap_or(true));
        let fits = match change.action {
            PluginAction::Install => found.is_none() && (known(&change.home, marketplace) || adding.contains(&(change.home.clone(), marketplace.to_string()))),
            PluginAction::Enable => on == Some(false),
            PluginAction::Disable => on == Some(true),
            PluginAction::Uninstall => found.is_some(),
            _ => false,
        };
        if !fits {
            return Err(format!("Arbor can't {} {what} as it is", change.action.verb()));
        }
        planned.push(CodexPlanned {
            home: change.home,
            codex_home: (rel != ".codex").then_some(rel),
            action: change.action,
            target: change.target,
            source: None,
        });
    }
    planned.sort_by_key(|change| match change.action {
        PluginAction::AddMarketplace => 0,
        PluginAction::Install | PluginAction::Uninstall => 1,
        _ => 2,
    });
    Ok(planned)
}

// Follows AGENT_ENV. Codex runs away from any project and without a terminal. One too old to install with --json is
// refused before anything runs. `change` runs one change: its number, its home's folder under $HOME or whole (empty for
// ~/.codex), then the words for Codex. It gives what Codex printed on one line: the result with --json, or the last
// line it printed as an error.
const CODEX_APPLY_FUNCTIONS: &str = r##"export GIT_TERMINAL_PROMPT=0
unset CODEX_HOME
bin=$(command -v codex 2>/dev/null || true)
case "$bin" in
  /*) ;;
  *) echo "Codex isn't installed where Arbor looks for it" >&2; exit 127 ;;
esac
if ! "$bin" plugin add --help </dev/null 2>/dev/null | grep -q -e '--json' ||
  ! "$bin" plugin remove --help </dev/null 2>/dev/null | grep -q -e '--json' ||
  ! "$bin" plugin marketplace add --help </dev/null 2>/dev/null | grep -q -e '--json'; then
  echo "This version of Codex can't change plugins for Arbor. Update it first." >&2
  exit 2
fi
cd / || exit 3
out=$(mktemp "${TMPDIR:-/tmp}/arbor-plugins.XXXXXX") || exit 3
err=$(mktemp "${TMPDIR:-/tmp}/arbor-plugins.XXXXXX") || { rm -f "$out"; exit 3; }
trap 'rm -f "$out" "$err"' EXIT
change() {
  n=$1; dir=$2; shift 2
  case $dir in /* | '') ;; *) dir=$HOME/$dir ;; esac
  if [ -n "$dir" ]; then
    CODEX_HOME="$dir" "$bin" "$@" </dev/null >"$out" 2>"$err"
  else
    "$bin" "$@" </dev/null >"$out" 2>"$err"
  fi
  code=$?
  said=$(tr '\t\r\n' '   ' <"$out" | cut -c 1-4000)
  if [ "$code" -ne 0 ]; then said=$(grep -v '^[[:space:]]*$' "$err" | tail -n 1 | tr '\t\r' '  ' | cut -c 1-4000); fi
  printf 'R\t%s\t%s\t%s\n' "$n" "$code" "$said"
}
"##;

fn codex_apply_script(planned: &[CodexPlanned]) -> String {
    let mut script = format!("{AGENT_ENV}{CODEX_APPLY_FUNCTIONS}");
    for (index, change) in planned.iter().enumerate() {
        let words = match (change.action, change.source.as_deref()) {
            (PluginAction::AddMarketplace, Some(source)) => format!("marketplace add {}", shell_quote(source)),
            (PluginAction::Install, _) => format!("add {}", shell_quote(&change.target)),
            (PluginAction::Uninstall, _) => format!("remove {}", shell_quote(&change.target)),
            _ => continue,
        };
        script.push_str(&format!("change {index} {} plugin {words} --json\n", shell_quote(change.codex_home.as_deref().unwrap_or_default())));
    }
    script
}

/// How a Codex change went: it prints the plugin, or the marketplace, as JSON when it's done, and `Error: …` when it
/// isn't. A marketplace is named by its own files, so one that came in under another name than the repo gives says so.
fn codex_outcome(change: &CodexPlanned, code: Option<i32>, said: &str) -> (PluginOutcome, String) {
    match code {
        Some(0) => {
            let result = serde_json::from_str::<Value>(said.trim()).ok();
            if change.action == PluginAction::AddMarketplace {
                let name = result.as_ref().and_then(|result| result.get("marketplaceName")).and_then(Value::as_str);
                let already = result.as_ref().and_then(|result| result.get("alreadyAdded")).and_then(Value::as_bool) == Some(true);
                return match name {
                    Some(name) if name == change.target => (if already { PluginOutcome::Already } else { PluginOutcome::Done }, String::new()),
                    Some(name) => (PluginOutcome::Failed, message(&format!("It came in as {name}, not {}", change.target))),
                    None => (PluginOutcome::Done, message(said)),
                };
            }
            let done = result.is_some_and(|result| result.get("pluginId").is_some_and(Value::is_string));
            (PluginOutcome::Done, if done { String::new() } else { message(said) })
        }
        _ => (PluginOutcome::Failed, message(said.trim().strip_prefix("Error:").unwrap_or(said).trim())),
    }
}

/// Codex's config with a plugin turned on or off, leaving the rest of the file as it was. None when it's so already.
fn set_codex_plugin_enabled(content: Option<&str>, id: &str, on: bool) -> Result<Option<String>, String> {
    let text = content.ok_or("This home has no config.toml")?;
    let mut document = text.parse::<toml_edit::Document>().map_err(|_| "Its config.toml isn't TOML Arbor can edit".to_string())?;
    let plugin = document
        .get_mut("plugins")
        .and_then(toml_edit::Item::as_table_like_mut)
        .and_then(|plugins| plugins.get_mut(id))
        .and_then(toml_edit::Item::as_table_like_mut)
        .ok_or_else(|| format!("Its config.toml doesn't list {id}"))?;
    if plugin.get("enabled").and_then(toml_edit::Item::as_bool).unwrap_or(true) == on {
        return Ok(None);
    }
    match plugin.get_mut("enabled").and_then(toml_edit::Item::as_value_mut) {
        // In place, so a comment after it stays.
        Some(value) => {
            let decor = value.decor().clone();
            *value = toml_edit::Value::from(on);
            *value.decor_mut() = decor;
        }
        None => {
            plugin.insert("enabled", toml_edit::value(on));
        }
    }
    Ok(Some(document.to_string()))
}

/// Makes the changes in a machine's Codex homes: installs and removals with Codex's own `plugin` command, so Codex
/// keeps its records and cache as it would for a person there, then turning plugins on and off in each config.toml
/// the careful way, only while it's as read, backed up first and on Sync › Repo › Arbor's changes to undo. The Codex app's
/// own marketplaces are left alone. Then the machine is read again.
#[tauri::command]
pub(crate) async fn apply_codex_plugin_changes(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    changes: Vec<CodexPluginChange>,
) -> Result<Vec<PluginResult>, String> {
    let (target, planned) = {
        let inner = state.lock();
        let (target, setup) = covered_machine(&inner, &machine)?;
        (target, codex_plan(setup, changes)?)
    };
    let mut results = Vec::with_capacity(planned.len());
    let result = |change: &CodexPlanned, (outcome, message): (PluginOutcome, String)| PluginResult {
        home: change.home.clone(),
        action: change.action,
        target: change.target.clone(),
        checkout: None,
        outcome,
        message,
    };
    let by_command = |change: &CodexPlanned| matches!(change.action, PluginAction::AddMarketplace | PluginAction::Install | PluginAction::Uninstall);
    let commands: Vec<&CodexPlanned> = planned.iter().filter(|change| by_command(change)).collect();
    if !commands.is_empty() {
        // Each change reports its own line, so a script that stopped part way still says what it did.
        let output = match run_on_machine(&target, MachineOp::CodexPluginApply, &codex_apply_script(&planned), APPLY_TIMEOUT).await {
            Ok(output) => output,
            Err(error) => {
                rescan(&app, &machine);
                return Err(error);
            }
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !output.status.success() && !stdout.lines().any(|line| line.starts_with("R\t")) {
            rescan(&app, &machine);
            return Err(failure_detail(&output));
        }
        let mut heard: BTreeMap<usize, (PluginOutcome, String)> = BTreeMap::new();
        for line in stdout.lines() {
            let mut fields = line.splitn(4, '\t');
            if fields.next() != Some("R") {
                continue;
            }
            let (Some(index), code) = (fields.next().and_then(|index| index.parse::<usize>().ok()), fields.next().and_then(|code| code.parse::<i32>().ok())) else { continue };
            let Some(change) = planned.get(index) else { continue };
            heard.insert(index, codex_outcome(change, code, fields.next().unwrap_or_default()));
        }
        for (index, change) in planned.iter().enumerate() {
            if by_command(change) {
                results.push(result(change, heard.remove(&index).unwrap_or_else(|| (PluginOutcome::Failed, "Arbor didn't hear how this went".into()))));
            }
        }
    }
    for change in planned.iter().filter(|change| matches!(change.action, PluginAction::Enable | PluginAction::Disable)) {
        let on = change.action == PluginAction::Enable;
        let edit = |content: Option<&str>| set_codex_plugin_enabled(content, &change.target, on);
        let edits = super::attention::edit_codex_config(|| &target, std::slice::from_ref(&change.home), super::guarded_writes::ChangeKind::Plugins, edit, true).await;
        let outcome = match edits.as_ref().map(|edits| edits.first()) {
            Ok(Some(edit)) if edit.written => (PluginOutcome::Done, String::new()),
            Ok(Some(edit)) if edit.error.is_none() => (PluginOutcome::Already, String::new()),
            Ok(Some(edit)) => (PluginOutcome::Failed, edit.error.clone().unwrap_or_default()),
            Ok(None) => (PluginOutcome::Failed, "Arbor didn't hear how this went".into()),
            Err(error) => (PluginOutcome::Failed, message(error)),
        };
        results.push(result(change, outcome));
    }
    rescan(&app, &machine);
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(home: &str, action: PluginAction, target: &str) -> PluginChange {
        PluginChange { home: home.into(), action, target: target.into(), source: None, checkout: None }
    }

    fn setup() -> MachineSetup {
        MachineSetup::with_homes(&[(HomeAgent::Claude, "~/.claude"), (HomeAgent::Claude, "~/.claude-work"), (HomeAgent::Codex, "~/.codex")])
            .with_item("~/.claude", ItemKind::Marketplace, "official", None, Some(true))
            .with_item("~/.claude", ItemKind::Plugin, "context7@official", Some("1.0.0"), Some(true))
            .with_item("~/.claude", ItemKind::Plugin, "paper@official", Some("0.2.0"), Some(false))
            .with_item("~/.claude", ItemKind::Plugin, "ghost@official", None, Some(true))
            .with_item("~/.claude-work", ItemKind::Marketplace, "official", None, None)
    }

    #[test]
    fn a_codex_change_fits_the_home_as_scanned_and_leaves_the_apps_own_plugins_alone() {
        let setup = MachineSetup::with_homes(&[(HomeAgent::Codex, "~/.codex"), (HomeAgent::Codex, "~/.agent-app/codex"), (HomeAgent::Claude, "~/.claude")])
            .with_item("~/.codex", ItemKind::Marketplace, "tools", None, None)
            .with_item("~/.codex", ItemKind::Marketplace, "openai-bundled", None, None)
            .with_item("~/.codex", ItemKind::Plugin, "lint@tools", None, Some(true))
            .with_item("~/.codex", ItemKind::Plugin, "paper@tools", None, Some(false))
            .with_item("~/.codex", ItemKind::Plugin, "chrome@openai-bundled", None, Some(true))
            .with_item("~/.agent-app/codex", ItemKind::Marketplace, "tools", None, None);
        let change = |home: &str, action: PluginAction, target: &str| CodexPluginChange { home: home.into(), action, target: target.into(), source: None };
        let planned = codex_plan(&setup, vec![
            change("~/.codex", PluginAction::Enable, "paper@tools"),
            change("~/.agent-app/codex", PluginAction::Install, "lint@tools"),
            change("~/.codex", PluginAction::Uninstall, "lint@tools"),
        ])
        .unwrap();
        // Codex's own command runs first; turning on is a config edit after it.
        assert_eq!(
            planned.iter().map(|change| (change.action, change.codex_home.as_deref())).collect::<Vec<_>>(),
            [(PluginAction::Install, Some(".agent-app/codex")), (PluginAction::Uninstall, None), (PluginAction::Enable, None)]
        );
        let script = codex_apply_script(&planned);
        assert!(script.contains("change 0 '.agent-app/codex' plugin add 'lint@tools' --json") && script.contains("change 1 '' plugin remove 'lint@tools' --json"));
        assert!(!script.contains("paper"), "turning on isn't a command");

        let refused = |action: PluginAction, home: &str, target: &str| codex_plan(&setup, vec![change(home, action, target)]).unwrap_err();
        assert!(refused(PluginAction::Disable, "~/.codex", "chrome@openai-bundled").contains("app's own"));
        assert!(refused(PluginAction::Install, "~/.codex", "lint@tools").contains("can't install"));
        assert!(refused(PluginAction::Enable, "~/.codex", "lint@tools").contains("can't turn on"));
        assert!(refused(PluginAction::Install, "~/.agent-app/codex", "x@elsewhere").contains("can't install"));
        assert!(refused(PluginAction::Update, "~/.codex", "lint@tools").contains("can't update"));
        assert!(refused(PluginAction::Uninstall, "~/.claude", "lint@tools").contains("isn't a Codex home"));
        assert!(codex_plan(&setup, vec![change("~/.codex", PluginAction::Disable, "lint@tools"), change("~/.codex", PluginAction::Uninstall, "lint@tools")]).unwrap_err().contains("twice"));

        // A home without the marketplace gets it first, from its GitHub repository, then the plugin from it.
        let add = |home: &str, name: &str, source: Option<&str>| CodexPluginChange { home: home.into(), action: PluginAction::AddMarketplace, target: name.into(), source: source.map(Into::into) };
        let planned = codex_plan(&setup, vec![change("~/.agent-app/codex", PluginAction::Install, "sketch@team"), add("~/.agent-app/codex", "team", Some("acme/codex-plugins"))]).unwrap();
        assert_eq!(planned.iter().map(|change| change.action).collect::<Vec<_>>(), [PluginAction::AddMarketplace, PluginAction::Install]);
        assert!(codex_apply_script(&planned).contains("change 0 '.agent-app/codex' plugin marketplace add 'acme/codex-plugins' --json\nchange 1 '.agent-app/codex' plugin add 'sketch@team' --json"));
        assert!(codex_plan(&setup, vec![add("~/.codex", "tools", Some("acme/tools"))]).unwrap_err().contains("there already"));
        assert!(codex_plan(&setup, vec![add("~/.agent-app/codex", "team", Some("https://example.com/x.git"))]).unwrap_err().contains("GitHub"));
        assert!(codex_plan(&setup, vec![add("~/.agent-app/codex", "team", None)]).unwrap_err().contains("GitHub"));
        assert!(codex_plan(&setup, vec![add("~/.agent-app/codex", "openai-bundled", Some("acme/x"))]).unwrap_err().contains("app's own"));
        assert!(codex_plan(&setup, vec![add("~/.agent-app/codex", "-x", Some("acme/x"))]).is_err());
    }

    #[test]
    fn a_codex_plugin_is_turned_on_or_off_in_its_config_and_nothing_else_moves() {
        let config = "# mine\nmodel = \"gpt-6\"\n\n[plugins.\"lint@tools\"]\nenabled = true # keep\n\n[plugins.\"paper@tools\"]\n";
        let off = set_codex_plugin_enabled(Some(config), "lint@tools", false).unwrap().unwrap();
        assert_eq!(off, config.replace("enabled = true # keep", "enabled = false # keep"));
        assert_eq!(set_codex_plugin_enabled(Some(&off), "lint@tools", false).unwrap(), None);
        // Without `enabled`, Codex has it on.
        assert_eq!(set_codex_plugin_enabled(Some(config), "paper@tools", true).unwrap(), None);
        assert!(set_codex_plugin_enabled(Some(config), "paper@tools", false).unwrap().unwrap().contains("[plugins.\"paper@tools\"]\nenabled = false"));
        assert!(set_codex_plugin_enabled(Some(config), "other@tools", false).is_err());
        assert!(set_codex_plugin_enabled(None, "lint@tools", false).is_err());

        let install = CodexPlanned { home: "~/.codex".into(), codex_home: None, action: PluginAction::Install, target: "lint@tools".into(), source: None };
        let pretty = r#"{   "pluginId": "lint@tools",   "name": "lint",   "marketplaceName": "tools" }"#;
        assert_eq!(codex_outcome(&install, Some(0), pretty), (PluginOutcome::Done, String::new()));
        assert_eq!(codex_outcome(&install, Some(1), "Error: plugin `nope` was not found in marketplace `tools`"), (PluginOutcome::Failed, "plugin `nope` was not found in marketplace `tools`".into()));
        assert_eq!(codex_outcome(&install, Some(1), "Error: fetch https://me:tok@host/x failed").1, "fetch https://host/x failed");
        // A marketplace is named by its own files: added under the name the repo gives, there already, or under another.
        let add = CodexPlanned { action: PluginAction::AddMarketplace, target: "tools".into(), source: Some("acme/tools".into()), ..install };
        let added = |name: &str, already: bool| format!(r#"{{ "marketplaceName": "{name}", "installedRoot": "/x", "alreadyAdded": {already} }}"#);
        assert_eq!(codex_outcome(&add, Some(0), &added("tools", false)).0, PluginOutcome::Done);
        assert_eq!(codex_outcome(&add, Some(0), &added("tools", true)).0, PluginOutcome::Already);
        assert_eq!(codex_outcome(&add, Some(0), &added("other", false)), (PluginOutcome::Failed, "It came in as other, not tools".into()));
    }

    #[test]
    fn only_a_plugin_a_home_names_but_hasnt_installed_is_a_leftover() {
        let leftover = |home: &str, plugin: &str| PluginLeftover { home: home.into(), plugin: plugin.into() };
        let setup = setup();
        let homes = leftovers_by_home(&setup, &[leftover("~/.claude", "ghost@official"), leftover("~/.claude", "ghost@official")]).unwrap();
        assert_eq!(homes, BTreeMap::from([("~/.claude".to_string(), vec!["ghost@official".to_string()])]));
        assert!(leftovers_by_home(&setup, &[leftover("~/.claude", "context7@official")]).unwrap_err().contains("installed"));
        assert!(leftovers_by_home(&setup, &[leftover("~/.claude", "other@official")]).unwrap_err().contains("Scan again"));
        assert!(leftovers_by_home(&setup, &[leftover("~/.codex", "ghost@official")]).is_err());
        assert!(leftovers_by_home(&setup, &[]).is_err());
        let policy = setup.with_policy(&[(ItemKind::Plugin, "ghost@official")]);
        assert!(leftovers_by_home(&policy, &[leftover("~/.claude", "ghost@official")]).unwrap_err().contains("policy"));
    }

    #[test]
    fn a_leftover_leaves_settings_json_with_only_its_own_entry_gone() {
        let text = "{\n  \"model\": \"opus\",\n  \"enabledPlugins\": {\"ghost@official\": false, \"context7@official\": true}\n}\n";
        let next = super::super::attention::drop_claude_setting_entries(Some(text), "enabledPlugins", &["ghost@official"]).unwrap().unwrap();
        let value: serde_json::Value = serde_json::from_str(&next).unwrap();
        assert_eq!(value["enabledPlugins"], serde_json::json!({ "context7@official": true }));
        assert!(next.find("model").unwrap() < next.find("enabledPlugins").unwrap());
        assert_eq!(super::super::attention::drop_claude_setting_entries(Some(&next), "enabledPlugins", &["ghost@official"]).unwrap(), None);
        assert_eq!(super::super::attention::drop_claude_setting_entries(None, "enabledPlugins", &["ghost@official"]).unwrap(), None);
    }

    #[test]
    fn token_amounts_read_as_claude_code_rounds_them() {
        let estimate = |text: &str| token_estimate(text).map(|estimate| (estimate.tokens, estimate.under));
        assert_eq!(estimate("57"), Some((57, false)));
        assert_eq!(estimate("<20"), Some((20, true)));
        assert_eq!(estimate("1,234"), Some((1_234, false)));
        assert_eq!(estimate("1.2k"), Some((1_200, false)));
        assert_eq!(estimate("-"), None);
        assert_eq!(estimate("lots"), None);
    }

    fn planned(changes: Vec<PluginChange>) -> Result<Vec<(String, PluginAction, String, Option<usize>)>, String> {
        plan(&setup(), changes, &[]).map(|planned| {
            planned.into_iter().map(|change| (change.home, change.action, change.target, change.after)).collect()
        })
    }

    #[test]
    fn a_projects_value_turns_a_plugin_on_or_off_in_a_known_checkout_only() {
        let checkouts = ["/home/casey/src/app".to_string()];
        let in_checkout = |action, target: &str, checkout: &str| PluginChange { checkout: Some(checkout.into()), ..change("~/.claude", action, target) };
        // An installed plugin that's on in the home can still be turned off, or on, in a checkout.
        let planned = plan(&setup(), vec![in_checkout(PluginAction::Disable, "context7@official", "/home/casey/src/app"), in_checkout(PluginAction::Enable, "paper@official", "/home/casey/src/app")], &checkouts).unwrap();
        assert!(planned.iter().all(|change| change.checkout.as_deref() == Some("/home/casey/src/app")));
        let script = apply_script(&planned);
        assert!(script.contains("if cd -- '/home/casey/src/app' 2>/dev/null; then change 1 '' plugin disable 'context7@official' --scope local --json; cd /;"), "{script}");
        assert!(script.contains("plugin enable 'paper@official' --scope local --json"));
        assert!(script.contains(r#"else printf 'R\t1\t1\t%s\n' 'The checkout isn'\''t there any more'; fi"#), "{script}");
        // Not a checkout the scan found, not turning on or off, or not installed to turn on.
        assert!(plan(&setup(), vec![in_checkout(PluginAction::Disable, "context7@official", "/tmp/elsewhere")], &checkouts).is_err());
        assert!(plan(&setup(), vec![in_checkout(PluginAction::Uninstall, "context7@official", "/home/casey/src/app")], &checkouts).is_err());
        assert!(plan(&setup(), vec![in_checkout(PluginAction::Enable, "ghost@official", "/home/casey/src/app")], &checkouts).is_err());
        // The same plugin in the home and in a checkout are two changes, not one twice.
        assert!(plan(&setup(), vec![change("~/.claude", PluginAction::Disable, "context7@official"), in_checkout(PluginAction::Disable, "context7@official", "/home/casey/src/app")], &checkouts).is_ok());
        // A checkout gone since the scan says so, for that change alone.
        let results = parse_results("R\t0\t1\tThe checkout isn't there any more\n", &planned[..1]);
        assert_eq!((results[0].outcome, results[0].checkout.as_deref()), (PluginOutcome::Failed, Some("/home/casey/src/app")));
    }

    #[test]
    fn a_plan_is_checked_against_the_last_scan_and_put_in_order() {
        let mut add = change("~/.claude-work", PluginAction::AddMarketplace, "team");
        add.source = Some("acme/claude-plugins".into());
        let plan = planned(vec![
            change("~/.claude", PluginAction::Uninstall, "paper@official"),
            change("~/.claude-work", PluginAction::Install, "helper@team"),
            change("~/.claude", PluginAction::Update, "context7@official"),
            change("~/.claude-work", PluginAction::Install, "context7@official"),
            add,
            change("~/.claude", PluginAction::Refresh, "official"),
        ])
        .unwrap();
        assert_eq!(
            plan,
            [
                ("~/.claude-work".into(), PluginAction::AddMarketplace, "team".into(), None),
                ("~/.claude".into(), PluginAction::Refresh, "official".into(), None),
                ("~/.claude-work".into(), PluginAction::Install, "helper@team".into(), Some(0)),
                ("~/.claude-work".into(), PluginAction::Install, "context7@official".into(), None),
                ("~/.claude".into(), PluginAction::Update, "context7@official".into(), None),
                ("~/.claude".into(), PluginAction::Uninstall, "paper@official".into(), None),
            ],
            "marketplaces come first, and an install from one being added waits on it"
        );

        let refused = |changes: Vec<PluginChange>| planned(changes).unwrap_err();
        assert_eq!(refused(vec![]), "There's nothing to change");
        assert_eq!(refused(vec![change("~/.codex", PluginAction::Install, "x@official")]), "~/.codex isn't a Claude Code home on this machine");
        assert_eq!(refused(vec![change("~/.claude/../x", PluginAction::Refresh, "official")]), "~/.claude/../x isn't a Claude Code home on this machine");
        assert_eq!(refused(vec![change("~/.claude", PluginAction::Install, "context7@official")]), "Arbor can't install context7@official in ~/.claude as it is");
        assert_eq!(refused(vec![change("~/.claude", PluginAction::Install, "helper@team")]), "Arbor can't install helper@team in ~/.claude as it is", "a marketplace it hasn't got");
        assert_eq!(refused(vec![change("~/.claude", PluginAction::Update, "ghost@official")]), "Arbor can't update ghost@official in ~/.claude as it is", "turned on but not installed");
        assert_eq!(refused(vec![change("~/.claude", PluginAction::Enable, "context7@official")]), "Arbor can't turn on context7@official in ~/.claude as it is");
        assert_eq!(refused(vec![change("~/.claude", PluginAction::Disable, "paper@official")]), "Arbor can't turn off paper@official in ~/.claude as it is");
        assert_eq!(refused(vec![change("~/.claude", PluginAction::Update, "context7")]), "Arbor doesn't change a plugin called context7");
        assert_eq!(refused(vec![change("~/.claude", PluginAction::Update, "x@official; rm -rf ~")]), "Arbor doesn't change a plugin called x@official; rm -rf ~");
        assert_eq!(refused(vec![change("~/.claude", PluginAction::Refresh, "-h")]), "Arbor doesn't change a marketplace called -h");
        assert_eq!(refused(vec![change("~/.claude", PluginAction::Refresh, "team")]), "Arbor can't refresh team in ~/.claude as it is");
        assert_eq!(
            refused(vec![change("~/.claude", PluginAction::Update, "context7@official"), change("~/.claude", PluginAction::Uninstall, "context7@official")]),
            "context7@official in ~/.claude is in the changes twice"
        );
        let mut bare = change("~/.claude", PluginAction::AddMarketplace, "team");
        assert_eq!(refused(vec![bare]), "Arbor can't add team in ~/.claude as it is", "it needs a GitHub repository");
        for source in ["acme", "acme/../x", "-acme/x", "acme/x y", "https://github.com/acme/x", "git@github.com:acme/x.git"] {
            bare = change("~/.claude", PluginAction::AddMarketplace, "team");
            bare.source = Some(source.into());
            assert!(planned(vec![bare]).is_err(), "{source}");
        }
        bare = change("~/.claude", PluginAction::AddMarketplace, "official");
        bare.source = Some("anthropics/claude-plugins-official".into());
        assert_eq!(refused(vec![bare]), "Arbor can't add official in ~/.claude as it is", "it's there already");
        let many = (0..=MOST_CHANGES).map(|n| change("~/.claude", PluginAction::Refresh, &format!("m{n}"))).collect();
        assert_eq!(refused(many), "Arbor makes at most 50 changes at a time");
    }

    #[test]
    fn a_marketplace_is_removed_last_and_only_once_nothing_is_installed_from_it() {
        let refused = |changes: Vec<PluginChange>| planned(changes).unwrap_err();
        // ~/.claude has context7 and paper installed from official; ghost is only named in its settings.
        assert_eq!(
            refused(vec![change("~/.claude", PluginAction::RemoveMarketplace, "official")]),
            "~/.claude still has context7@official, paper@official installed from official; remove those first"
        );
        assert_eq!(
            refused(vec![change("~/.claude", PluginAction::Uninstall, "paper@official"), change("~/.claude", PluginAction::RemoveMarketplace, "official")]),
            "~/.claude still has context7@official installed from official; remove those first"
        );
        assert_eq!(refused(vec![change("~/.claude", PluginAction::RemoveMarketplace, "team")]), "Arbor can't remove team in ~/.claude as it is", "a marketplace it hasn't got");
        let order = planned(vec![
            change("~/.claude", PluginAction::RemoveMarketplace, "official"),
            change("~/.claude", PluginAction::Uninstall, "context7@official"),
            change("~/.claude", PluginAction::Uninstall, "paper@official"),
            change("~/.claude-work", PluginAction::RemoveMarketplace, "official"),
        ])
        .unwrap();
        assert_eq!(order.iter().map(|(home, action, ..)| (home.as_str(), *action)).collect::<Vec<_>>(), [
            ("~/.claude", PluginAction::Uninstall),
            ("~/.claude", PluginAction::Uninstall),
            ("~/.claude", PluginAction::RemoveMarketplace),
            ("~/.claude-work", PluginAction::RemoveMarketplace),
        ]);
        let script = apply_script(&plan(&setup(), vec![change("~/.claude-work", PluginAction::RemoveMarketplace, "official")], &[]).unwrap());
        assert!(script.contains("change 0 '.claude-work' plugin marketplace remove 'official'"), "{script}");
    }

    #[test]
    fn plugins_the_policy_sets_are_only_ever_updated() {
        let setup = setup().with_policy(&[(ItemKind::Plugin, "paper@official"), (ItemKind::Plugin, "context7@official")]);
        for action in [PluginAction::Enable, PluginAction::Uninstall] {
            assert_eq!(
                plan(&setup, vec![change("~/.claude", action, "paper@official")], &[]).unwrap_err(),
                "The managed settings policy on this machine sets paper@official in ~/.claude, so Arbor leaves it as the policy has it",
            );
        }
        assert!(plan(&setup, vec![change("~/.claude-work", PluginAction::Install, "context7@official")], &[]).is_err());
        assert!(plan(&setup, vec![change("~/.claude", PluginAction::Update, "context7@official")], &[]).is_ok(), "an update doesn't touch enabledPlugins");
    }

    #[test]
    fn results_say_how_each_change_went_without_credentials() {
        let mut add = change("~/.claude", PluginAction::AddMarketplace, "team");
        add.source = Some("acme/claude-plugins".into());
        // In order: the add, the refresh, both installs, the update, then turning paper on.
        let planned = plan(
            &setup(),
            vec![
                add,
                change("~/.claude", PluginAction::Install, "helper@team"),
                change("~/.claude", PluginAction::Refresh, "official"),
                change("~/.claude", PluginAction::Update, "context7@official"),
                change("~/.claude", PluginAction::Enable, "paper@official"),
                change("~/.claude-work", PluginAction::Install, "context7@official"),
            ],
            &[],
        )
        .unwrap();
        let stdout = [
            "R\t0\t1\tFailed to clone https://x-access-token:ghp_SECRET123@github.com/acme/claude-plugins.git: not found",
            "R\t1\t0\tSuccessfully updated marketplace: official",
            "S\t2",
            r#"R\t4\t0\t{"command":"update","outcome":"ok","message":"Updated context7 from 1.0.0 to 1.1.0","pluginId":"context7@official"}"#,
            r#"R\t5\t1\t{"command":"enable","outcome":"failed","message":"Plugin \"paper\" is already enabled","failureCode":"already_in_goal_state","alreadyInGoalState":true}"#,
            "R\t9\t0\tnot a change",
        ]
        .join("\n");
        let results = parse_results(&stdout.replace("\\t", "\t"), &planned);
        let outcomes: Vec<(&str, PluginOutcome, &str)> = results.iter().map(|result| (result.target.as_str(), result.outcome, result.message.as_str())).collect();
        assert_eq!(
            outcomes,
            [
                ("team", PluginOutcome::Failed, "Failed to clone https://github.com/acme/claude-plugins.git: not found"),
                ("official", PluginOutcome::Done, "Successfully updated marketplace: official"),
                ("helper@team", PluginOutcome::Skipped, "Its marketplace couldn't be added"),
                ("context7@official", PluginOutcome::Failed, "Arbor didn't hear how this went"),
                ("context7@official", PluginOutcome::Done, "Updated context7 from 1.0.0 to 1.1.0"),
                ("paper@official", PluginOutcome::Already, "Plugin \"paper\" is already enabled"),
            ]
        );
        assert!(!format!("{results:?}").contains("SECRET"));

        let shown = r#"{"command":"install","outcome":"failed","message":"The install command was only displayed","shownCommand":{"command":"make install","sha256":"ab12"}}"#;
        assert_eq!(outcome(Some(1), shown), (PluginOutcome::NeedsYou, "The install command was only displayed".into()));
        assert_eq!(outcome(Some(0), "Marketplace 'official' already on disk — declared in user settings").0, PluginOutcome::Already);
        assert_eq!(outcome(Some(1), "\u{1b}[31merror: unknown option '--json'\u{1b}[0m"), (PluginOutcome::Failed, "error: unknown option '--json'".into()));
        assert_eq!(without_credentials("see https://user:pw@host.example/x and ssh://git@host:22/y, http://plain.example"), "see https://host.example/x and ssh://host:22/y, http://plain.example");
        assert_eq!(message(&"x".repeat(MESSAGE_CHARS + 10)).chars().count(), MESSAGE_CHARS + 1);
    }

    #[test]
    fn health_keeps_only_names_and_how_they_answered() {
        let stdout = "M\tgithub\tok\nM\tlinear\tauth\nM\tplugin:context7:context7\tfailed\nM\tbad name!\tok\nM\tgithub\tfailed\nM\tx\tweird\nX\t0\n";
        let servers = parse_health(stdout).unwrap();
        let found: Vec<(&str, McpStatus)> = servers.iter().map(|server| (server.name.as_str(), server.status)).collect();
        assert_eq!(found, [("github", McpStatus::Connected), ("linear", McpStatus::NeedsAuth), ("plugin:context7:context7", McpStatus::Failed)]);
        assert_eq!(parse_health("M\tgithub\tok\nX\t1\n").unwrap_err(), "claude mcp list stopped with code 1 there");
        assert!(parse_health("M\tgithub\tok\n").is_err());
    }

    #[cfg(unix)]
    mod scripts {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn temp_home(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let home = std::env::temp_dir().join(format!("arbor-plugins-{name}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&home).unwrap();
            home
        }

        /// A stand-in for Claude Code in ~/.local/bin, which comes first on the scripts' PATH, so the
        /// real one is never reached.
        fn fake_claude(home: &Path, body: &str) {
            let path = home.join(".local/bin/claude");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }

        fn run(shell: &str, home: &Path, script: &str) -> std::process::Output {
            let mut command = tokio::process::Command::new(shell);
            command
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin")
                .env("CLAUDE_CONFIG_DIR", "/somewhere/else")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            tokio::runtime::Runtime::new().unwrap().block_on(run_script(command, script, Duration::from_secs(20))).unwrap()
        }

        // Answers --help as a current Claude Code does, and notes each other call: where
        // it ran, the home it was given and its words.
        const CURRENT: &str = r#"case "$*" in
  "plugin --help") printf 'Commands:\n  install|i [options] <plugin>  Install a plugin\n  marketplace  Manage marketplaces\n'; exit 0 ;;
  "plugin install --help") printf 'Options:\n  --json  Print the result as JSON\n'; exit 0 ;;
  "plugin uninstall --help") printf 'Options:\n  --keep-data  Keep its data\n'; exit 0 ;;
esac
printf '%s|%s|%s\n' "$PWD" "${CLAUDE_CONFIG_DIR:-}" "$*" >> "$HOME/calls"
case "$*" in
  "plugin marketplace add"*) echo 'Cloning...'; echo 'fatal: repository not found' >&2; exit 1 ;;
  "plugin marketplace update"*) echo 'Successfully updated marketplace: official'; exit 0 ;;
  "plugin update"*) echo 'Checking for updates...'; printf '{"command":"update","outcome":"ok","message":"Updated"}\n'; exit 0 ;;
  *) printf '{"command":"%s","outcome":"ok","message":"Done"}\n' "$2"; exit 0 ;;
esac"#;

        #[test]
        fn changes_run_through_claude_codes_own_command_in_each_home() {
            for shell in shells() {
                changes_run_in(shell);
            }
        }

        fn changes_run_in(shell: &str) {
            let home = temp_home(&format!("apply-{shell}"));
            fake_claude(&home, CURRENT);
            let mut add = change("~/.claude-work", PluginAction::AddMarketplace, "team");
            add.source = Some("acme/claude-plugins".into());
            let planned = plan(
                &setup(),
                vec![
                    add,
                    change("~/.claude-work", PluginAction::Install, "helper@team"),
                    change("~/.claude", PluginAction::Refresh, "official"),
                    change("~/.claude", PluginAction::Update, "context7@official"),
                    change("~/.claude-work", PluginAction::Install, "context7@official"),
                    change("~/.claude", PluginAction::Uninstall, "paper@official"),
                ],
                &[],
            )
            .unwrap();
            let output = run(shell, &home, &apply_script(&planned));
            assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
            let results = parse_results(&String::from_utf8_lossy(&output.stdout), &planned);
            let outcomes: Vec<(&str, PluginOutcome, &str)> = results.iter().map(|result| (result.target.as_str(), result.outcome, result.message.as_str())).collect();
            assert_eq!(
                outcomes,
                [
                    ("team", PluginOutcome::Failed, "fatal: repository not found"),
                    ("official", PluginOutcome::Done, "Successfully updated marketplace: official"),
                    ("helper@team", PluginOutcome::Skipped, "Its marketplace couldn't be added"),
                    ("context7@official", PluginOutcome::Done, "Done"),
                    ("context7@official", PluginOutcome::Done, "Updated"),
                    ("paper@official", PluginOutcome::Done, "Done"),
                ]
            );
            let work = home.join(".claude-work").display().to_string();
            let calls = fs::read_to_string(home.join("calls")).unwrap();
            assert_eq!(
                calls.lines().collect::<Vec<_>>(),
                [
                    format!("/|{work}|plugin marketplace add acme/claude-plugins --scope user"),
                    "/||plugin marketplace update official".to_string(),
                    format!("/|{work}|plugin install context7@official --scope user --json"),
                    "/||plugin update context7@official --scope user --json".to_string(),
                    "/||plugin uninstall paper@official --scope user --json --keep-data".to_string(),
                ],
                "~/.claude is Claude Code's own, so it's given no other; nothing is ever accepted with -y"
            );
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn a_claude_code_without_the_commands_is_never_given_them() {
            for shell in shells() {
                let home = temp_home(&format!("old-{shell}"));
                fake_claude(&home, r#"printf '%s\n' "$*" >> "$HOME/calls"; printf 'Usage: claude [options] [prompt]\n'"#);
                let planned = plan(&setup(), vec![change("~/.claude", PluginAction::Update, "context7@official")], &[]).unwrap();
                let output = run(shell, &home, &apply_script(&planned));
                assert_eq!(output.status.code(), Some(2), "{shell}");
                assert_eq!(failure_detail(&output), "This version of Claude Code can't change plugins for Arbor. Update it first.");
                let calls = fs::read_to_string(home.join("calls")).unwrap();
                assert!(calls.lines().all(|line| line.ends_with("--help")), "{shell}: {calls}");
                let _ = fs::remove_dir_all(&home);
            }
        }

        /// A stand-in for Codex beside the Claude Code one.
        fn fake_codex(home: &Path, body: &str) {
            let path = home.join(".local/bin/codex");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }

        #[test]
        fn codex_changes_each_home_it_is_pointed_at_and_an_old_codex_is_never_given_them() {
            // The second home is kept outside the home folder, so it's given whole.
            let setup = MachineSetup::with_homes(&[(HomeAgent::Codex, "~/.codex"), (HomeAgent::Codex, "/srv/agents/codex")])
                .with_item("~/.codex", ItemKind::Plugin, "lint@tools", None, Some(true))
                .with_item("/srv/agents/codex", ItemKind::Marketplace, "tools", None, None);
            let planned = codex_plan(&setup, vec![
                CodexPluginChange { home: "/srv/agents/codex".into(), action: PluginAction::Install, target: "lint@tools".into(), source: None },
                CodexPluginChange { home: "~/.codex".into(), action: PluginAction::Uninstall, target: "lint@tools".into(), source: None },
                CodexPluginChange { home: "~/.codex".into(), action: PluginAction::AddMarketplace, target: "team".into(), source: Some("acme/team".into()) },
            ])
            .unwrap();
            for shell in shells() {
                let home = temp_home(&format!("codex-{shell}"));
                fake_codex(
                    &home,
                    r#"printf '%s|%s\n' "${CODEX_HOME:-}" "$*" >> "$HOME/calls"
case "$*" in
  *--help) printf '      --json\n          Output result as JSON\n' ;;
  "plugin add lint@tools --json") printf '{\n  "pluginId": "lint@tools",\n  "name": "lint"\n}\n' ;;
  "plugin marketplace add acme/team --json") printf '{\n  "marketplaceName": "team",\n  "alreadyAdded": false\n}\n' ;;
  *) printf 'Error: plugin `lint` is busy\n' >&2; exit 1 ;;
esac"#,
                );
                let output = run(shell, &home, &codex_apply_script(&planned));
                let stdout = String::from_utf8_lossy(&output.stdout);
                let lines: Vec<&str> = stdout.lines().collect();
                assert_eq!(lines.len(), 3, "{shell}: {stdout}");
                let heard = |line: &str| {
                    let fields: Vec<&str> = line.splitn(4, '\t').collect();
                    codex_outcome(&planned[fields[1].parse::<usize>().unwrap()], fields[2].parse().ok(), fields[3])
                };
                // The marketplace is added before anything is installed.
                assert_eq!(heard(lines[0]), (PluginOutcome::Done, String::new()), "{shell}");
                assert_eq!(heard(lines[1]).0, PluginOutcome::Done, "{shell}");
                assert_eq!(heard(lines[2]), (PluginOutcome::Failed, "plugin `lint` is busy".into()), "{shell}");
                let calls = fs::read_to_string(home.join("calls")).unwrap();
                assert!(calls.contains("/srv/agents/codex|plugin add lint@tools --json"), "{shell}: {calls}");
                assert!(calls.contains("\n|plugin remove lint@tools --json"), "~/.codex is Codex's own default: {calls}");
                assert!(calls.contains("\n|plugin marketplace add acme/team --json"), "{calls}");

                // Too old to answer in JSON: only asked for its help.
                fs::remove_file(home.join("calls")).unwrap();
                fake_codex(&home, r#"printf '%s\n' "$*" >> "$HOME/calls"; printf 'Usage: codex plugin add <PLUGIN>\n'"#);
                let output = run(shell, &home, &codex_apply_script(&planned));
                assert_eq!(output.status.code(), Some(2), "{shell}");
                assert_eq!(failure_detail(&output), "This version of Codex can't change plugins for Arbor. Update it first.");
                assert!(fs::read_to_string(home.join("calls")).unwrap().lines().all(|line| line.ends_with("--help")));
                let _ = fs::remove_dir_all(&home);
            }
        }

        #[test]
        fn a_health_check_brings_back_names_and_states_but_never_what_they_run() {
            for shell in shells() {
                health_in(shell);
            }
        }

        fn health_in(shell: &str) {
            let home = temp_home(&format!("health-{shell}"));
            fake_claude(
                &home,
                r#"case "$*" in
  "mcp --help") printf 'Commands:\n  add-json <name> <json>  Add a server\n  list  List configured MCP servers\n' ;;
  "mcp list")
    printf '%s\n' "$PWD|${CLAUDE_CONFIG_DIR:-}" > "$HOME/where"
    printf 'Checking MCP server health...\n\n'
    printf 'github: npx -y server-github --token=ghp_SECRET1 - \342\234\224 Connected\n'
    printf 'linear: https://mcp.linear.app/mcp?key=SECRET2 (HTTP) - ! Needs authentication\n'
    printf 'plugin:context7:context7: npx -y @upstash/context7-mcp - \342\234\230 Failed to connect\n'
    printf 'claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ! Needs authentication\n'
    printf 'odd$(name): x - \342\234\224 Connected\n'
    printf 'Warning: something went sideways\n'
    ;;
esac"#,
            );
            let output = run(shell, &home, &health_script(None));
            assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(!stdout.contains("SECRET") && !stdout.contains("npx") && !stdout.contains("https"), "{stdout}");
            let servers = parse_health(&stdout).unwrap();
            let found: Vec<(&str, McpStatus)> = servers.iter().map(|server| (server.name.as_str(), server.status)).collect();
            assert_eq!(
                found,
                [
                    ("github", McpStatus::Connected),
                    ("linear", McpStatus::NeedsAuth),
                    ("plugin:context7:context7", McpStatus::Failed),
                    ("claude.ai Gmail", McpStatus::NeedsAuth),
                ]
            );
            assert_eq!(fs::read_to_string(home.join("where")).unwrap(), "/|\n", "run for ~/.claude, away from any project");

            let output = run(shell, &home, &health_script(Some(".agent-app/homes/claude-proxy")));
            assert!(output.status.success());
            assert_eq!(fs::read_to_string(home.join("where")).unwrap(), format!("/|{}\n", home.join(".agent-app/homes/claude-proxy").display()));
            let output = run(shell, &home, &health_script(config_dir("/srv/agents/claude").as_deref()));
            assert!(output.status.success());
            assert_eq!(fs::read_to_string(home.join("where")).unwrap(), "/|/srv/agents/claude\n", "a home kept elsewhere is given whole");
            let _ = fs::remove_dir_all(&home);
        }

        // What `claude plugin details` printed for a sample plugin, with a secret where a
        // description and an MCP server's command could hold one.
        const DETAILS: &str = r#"case "$*" in
  "plugin --help") printf 'Commands:\n  details [options] <name>  Show a plugin'"'"'s component inventory and projected token cost\n  install|i [options] <plugin>  Install a plugin\n'; exit 0 ;;
  "plugin details sample@team")
    printf '%s\n' "$PWD|${CLAUDE_CONFIG_DIR:-}" > "$HOME/where"
    cat <<'EOF'
sample 1.2.0
  Description: Reads PDFs with token ghp_SECRET1
  Source: sample@team

Component inventory
  Skills (2)  pdf, review
  Agents (1)  checker
  Hooks (1)  Stop  (harness-only — no model context cost)
  MCP servers (1)  sample-server --token=SECRET2  (tool schemas resolved at runtime; not counted)
  LSP servers (0)

Projected token cost
  Always-on:   ~1,057 tok   added to every session

Per-component (rounded)
  component  always-on  on-invoke
  pdf              ~1k        ~2.4k
  checker         < 20       < 20
  bad$(name)       ~30        ~30
  review          < 20       < 20

  On-invoke cost is paid each time a skill or agent fires.
  Token counts are estimates and may differ from actual usage.
EOF
    exit 0 ;;
  "plugin details"*) echo "Plugin \"$3\" not found."; exit 1 ;;
esac"#;

        #[test]
        fn plugin_costs_bring_back_numbers_and_names_but_never_descriptions_or_commands() {
            for shell in shells() {
                costs_in(shell);
            }
        }

        fn costs_in(shell: &str) {
            let home = temp_home(&format!("costs-{shell}"));
            fake_claude(&home, DETAILS);
            let ids = vec!["sample@team".to_string(), "gone@team".to_string()];
            let output = run(shell, &home, &cost_script(Some(".claude-work"), &ids));
            assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(!stdout.contains("SECRET") && !stdout.contains("Reads PDFs") && !stdout.contains("bad$"), "{shell}: {stdout}");
            let costs = parse_costs(&stdout, &ids);
            let sample = &costs[0];
            assert_eq!(sample.always_on, Some(TokenEstimate { tokens: 1_057, under: false }), "{shell}: {stdout}");
            let components: Vec<(&str, Option<(u32, bool)>, Option<(u32, bool)>)> = sample
                .components
                .iter()
                .map(|component| (component.name.as_str(), component.always_on.map(|e| (e.tokens, e.under)), component.on_invoke.map(|e| (e.tokens, e.under))))
                .collect();
            assert_eq!(
                components,
                [("pdf", Some((1_000, false)), Some((2_400, false))), ("checker", Some((20, true)), Some((20, true))), ("review", Some((20, true)), Some((20, true)))]
            );
            let counts: Vec<(&str, u32)> = sample.counts.iter().map(|(kind, count)| (kind.as_str(), *count)).collect();
            assert_eq!(counts, [("agents", 1), ("hooks", 1), ("lspServers", 0), ("mcpServers", 1), ("skills", 2)]);
            assert_eq!(sample.error, None);
            assert_eq!(costs[1].error.as_deref(), Some("claude plugin details stopped with code 1 there"));
            assert_eq!(fs::read_to_string(home.join("where")).unwrap(), format!("/|{}\n", home.join(".claude-work").display()), "{shell}");
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn a_claude_code_that_cant_say_what_plugins_cost_is_never_asked() {
            for shell in shells() {
                let home = temp_home(&format!("old-costs-{shell}"));
                fake_claude(&home, r#"printf '%s\n' "$*" >> "$HOME/calls"; printf 'Commands:\n  install|i [options] <plugin>  Install a plugin\n'"#);
                let output = run(shell, &home, &cost_script(None, &["sample@team".to_string()]));
                assert_eq!(output.status.code(), Some(2), "{shell}");
                assert_eq!(failure_detail(&output), "This version of Claude Code can't say what a plugin costs. Update it first.");
                let calls = fs::read_to_string(home.join("calls")).unwrap();
                assert!(calls.lines().all(|line| line.ends_with("--help")), "{shell}: {calls}");
                let _ = fs::remove_dir_all(&home);
            }
        }
    }
}

//! Hooks kept in the setup repo, in .agents/hooks.json: each hook's event,
//! matcher and command, by a name the repo gives it. A repo hook only runs a
//! script the repo keeps in .agents/hooks, which syncs into each machine's
//! ~/.agents/hooks like any other file (see setup_sync), so every hook Arbor
//! places runs something that was reviewed in the repo. That's also how a
//! home's hooks are told apart: one running a script in ~/.agents/hooks is the
//! repo's, and every other hook is the home's own, which Arbor never changes and
//! only counts. Claude Code keeps a home's hooks in its settings.json and Codex
//! in its hooks.json, in the same shape.
//!
//! A hook goes in every home of the agents it lists, Claude Code's alone unless
//! it says otherwise: Codex asks its user to review a new or changed hook before
//! running it, and names its tools differently, so a hook goes to Codex only
//! when the repo says so. Arbor never answers that review for Codex. A hook can
//! list the homes it goes in, and it can be kept off a machine or removed from
//! every one. Each home's hooks
//! are compared with the repo's by fingerprint, as the scan took them. Commands
//! are kept free of secrets: one that looks like it holds a secret is refused
//! and never shown, and a script is checked the same way before it's taken in.
//!
//! A machine's hook that runs a script in ~/.agents/hooks can be taken into the
//! repo, which is the one time its command is read from the machine: it's asked
//! for, it's that one hook, and it's checked before anything is committed.

use super::guarded_writes::run_on;
use super::setup::{covered_machine, home_agent, rescan, hook_script, hook_sum, is_script_name, read_text, scanned_item, scanned_machines, HomeAgent, ItemKind, MachineSetup, EMIT_FUNCTIONS, HELPERS, HOOK_RUNNERS};
use super::agents::AgentKind;
use super::setup_mcp::{holds_secret, read_blocks};
use super::setup_skills::{home_place, place_words};
use super::setup_sync::{git, git_out, is_commit, repo_file, take_into_repo, GIT_TIMEOUT};
use super::*;
use std::collections::BTreeSet;
use ts_rs::TS;

/// Where the repo keeps its hooks, and the scripts they run.
pub(super) const HOOKS_FILE: &str = ".agents/hooks.json";
const SCRIPTS_DIR: &str = ".agents/hooks";
const FILE_VERSION: u64 = 1;
/// The longest a hook may run, in seconds, as a repo hook sets it.
const MOST_SECONDS: u64 = 3600;

/// A hook's name in the repo: letters, digits, - and _, starting with a letter or digit.
fn is_hook_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().next().is_some_and(|byte| byte.is_ascii_alphanumeric())
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// An event as Claude Code names one: PreToolUse, Stop.
fn is_event(event: &str) -> bool {
    !event.is_empty() && event.len() <= 40 && event.bytes().all(|byte| byte.is_ascii_alphabetic())
}

/// The script a repo hook's command runs: its path is ~/.agents/hooks/<script>, alone or after one of `HOOK_RUNNERS`.
fn repo_script(command: &str) -> Option<&str> {
    let mut rest = command.trim_start();
    if let Some((first, after)) = rest.split_once(' ') {
        if HOOK_RUNNERS.contains(&first) {
            rest = after.trim_start();
        }
    }
    rest.split_whitespace().next()?.strip_prefix("~/.agents/hooks/").filter(|script| is_script_name(script))
}

/// A machine's command with its home folder written as ~, the way the repo keeps it.
fn as_repo_command(command: &str, home_dir: &str) -> String {
    let mut command = command.to_string();
    for from in [format!("{home_dir}/.agents/hooks/"), "${HOME}/.agents/hooks/".to_string(), "$HOME/.agents/hooks/".to_string()] {
        if !home_dir.is_empty() || !from.starts_with('/') {
            command = command.replace(&from, "~/.agents/hooks/");
        }
    }
    command
}

#[derive(Clone, Debug, PartialEq)]
struct Hook {
    name: String,
    event: String,
    matcher: Option<String>,
    command: String,
    timeout: Option<u64>,
    /// The agents whose homes it goes in: Claude Code's alone unless the repo lists them.
    agents: Vec<AgentKind>,
    /// The homes it goes in, as the scan names them; every home of its agents when None.
    homes: Option<Vec<String>>,
    /// Taken off every machine: each home's copy is the repo's to remove.
    removed: bool,
    /// Turned off on every machine (`"all": "off"`), kept in the repo: each home's copy is the repo's to remove until
    /// it's turned on again.
    off_everywhere: bool,
    /// Machines it's kept off, as the file spells them; names compare loosely, as plugins.json's do.
    off: BTreeSet<String>,
    problems: Vec<String>,
}

impl Hook {
    fn script(&self) -> Option<&str> {
        repo_script(&self.command)
    }

    /// The handler Arbor writes for it, in the group that gives its matcher.
    fn handler(&self) -> Value {
        let mut handler = serde_json::json!({ "type": "command", "command": self.command });
        if let Some(timeout) = self.timeout {
            handler["timeout"] = Value::from(timeout);
        }
        handler
    }

    fn is_off(&self, machine: &str) -> bool {
        let key = normalize_machine_name(machine);
        self.off.iter().any(|listed| normalize_machine_name(listed) == key)
    }

    /// Whether `agent`'s home at `home` on `machine` should have it.
    fn wanted(&self, machine: &str, agent: AgentKind, home: &str) -> bool {
        !self.removed
            && !self.off_everywhere
            && !self.is_off(machine)
            && self.agents.contains(&agent)
            && self.homes.as_ref().is_none_or(|homes| homes.iter().any(|listed| listed == home))
    }
}

#[derive(Debug, Default, PartialEq)]
struct Registry {
    hooks: Vec<Hook>,
    /// What's wrong with the file as a whole.
    problems: Vec<String>,
}

impl Registry {
    #[cfg(test)]
    fn hook(&self, name: &str) -> Option<&Hook> {
        self.hooks.iter().find(|hook| hook.name == name)
    }
}

/// A key the file has that Arbor doesn't read, shortened to something safe to show.
fn shown_key(key: &str) -> String {
    let clean: String = key.chars().filter(|c| !c.is_control()).take(40).collect();
    if clean.len() < key.len() {
        format!("{clean}…")
    } else {
        clean
    }
}

fn read_hook(name: &str, entry: &Value, scripts: &BTreeSet<String>) -> Hook {
    let mut hook = Hook {
        name: name.to_string(),
        event: String::new(),
        matcher: None,
        command: String::new(),
        timeout: None,
        agents: vec![AgentKind::Claude],
        homes: None,
        removed: false,
        off_everywhere: false,
        off: BTreeSet::new(),
        problems: Vec::new(),
    };
    if !is_hook_name(name) {
        hook.problems.push("Arbor keeps hooks named with letters, digits, - and _, starting with a letter or digit, up to 64 long".into());
    }
    let Some(fields) = entry.as_object() else {
        hook.problems.push("It should be an object".into());
        return hook;
    };
    for (key, value) in fields {
        match key.as_str() {
            "event" => match value.as_str().filter(|event| is_event(event)) {
                Some(event) => hook.event = event.to_string(),
                None => hook.problems.push("event should be an event as the agents name it, like \"PreToolUse\"".into()),
            },
            "matcher" => match value {
                Value::Null => {}
                Value::String(matcher) if matcher.len() <= 200 && !matcher.chars().any(char::is_control) => hook.matcher = Some(matcher.clone()),
                _ => hook.problems.push("matcher should be text, up to 200 long".into()),
            },
            "command" => match value.as_str() {
                Some(command) => hook.command = command.to_string(),
                None => hook.problems.push("command should be text".into()),
            },
            "timeout" => match value.as_u64().filter(|seconds| (1..=MOST_SECONDS).contains(seconds)) {
                Some(seconds) => hook.timeout = Some(seconds),
                None => hook.problems.push(format!("timeout should be seconds, from 1 to {MOST_SECONDS}")),
            },
            "agents" => {
                let agents: Option<Vec<AgentKind>> = value.as_array().and_then(|agents| agents.iter().map(|agent| serde_json::from_value(agent.clone()).ok()).collect());
                match agents {
                    Some(mut agents) if !agents.is_empty() => {
                        agents.sort_by_key(|agent| *agent == AgentKind::Codex);
                        agents.dedup();
                        hook.agents = agents;
                    }
                    _ => hook.problems.push("agents should list \"claude\", \"codex\" or both".into()),
                }
            }
            "homes" => {
                let homes: Option<Vec<String>> = value
                    .as_array()
                    .and_then(|homes| homes.iter().map(|home| home.as_str().filter(|home| home_place(home).is_some()).map(str::to_string)).collect());
                match homes {
                    Some(homes) => hook.homes = Some(homes),
                    None => hook.problems.push("homes should list agent homes, like \"~/.claude\" or \"/srv/agents/claude\"".into()),
                }
            }
            "removed" => match value.as_bool() {
                Some(removed) => hook.removed = removed,
                None => hook.problems.push("removed should be true or false".into()),
            },
            "all" => match value.as_str() {
                Some("off") => hook.off_everywhere = true,
                _ => hook.problems.push("all should be \"off\", or left out for on".into()),
            },
            "machines" => {
                let Some(machines) = value.as_object() else {
                    hook.problems.push("machines should be an object of machine names".into());
                    continue;
                };
                for (machine, choice) in machines {
                    if choice.as_str() == Some("off") {
                        hook.off.insert(machine.clone());
                    } else {
                        hook.problems.push(format!("machines.{} should be \"off\"", shown_key(machine)));
                    }
                }
            }
            other => hook.problems.push(format!("Arbor doesn't know {}", shown_key(other))),
        }
    }
    if hook.event.is_empty() && !fields.contains_key("event") {
        hook.problems.push("It needs an event".into());
    }
    if hook.command.is_empty() && !fields.contains_key("command") {
        hook.problems.push("It needs a command".into());
    } else if !hook.command.is_empty() {
        match repo_script(&hook.command) {
            None => hook.problems.push(format!("Its command should run a script in ~/{SCRIPTS_DIR}, which the repo keeps in {SCRIPTS_DIR}")),
            Some(script) if !scripts.contains(script) => hook.problems.push(format!("The repo has no {SCRIPTS_DIR}/{script}")),
            Some(_) => {}
        }
        if holds_secret(&hook.command) {
            hook.problems.push("Its command looks like it holds a secret, which the repo mustn't. Have the script read it from a variable.".into());
        }
    }
    hook
}

fn read_registry(bytes: &[u8], scripts: &BTreeSet<String>) -> Registry {
    let mut registry = Registry::default();
    let Some(file) = serde_json::from_slice::<Value>(bytes).ok().filter(Value::is_object) else {
        registry.problems.push(format!("{HOOKS_FILE} isn't a JSON object Arbor can read"));
        return registry;
    };
    if file.get("version").is_some_and(|version| version.as_u64() != Some(FILE_VERSION)) {
        registry.problems.push(format!("{HOOKS_FILE} is a version this Arbor doesn't read. Update Arbor."));
        return registry;
    }
    for key in file.as_object().into_iter().flatten().map(|(key, _)| key) {
        if key != "version" && key != "hooks" {
            registry.problems.push(format!("Arbor doesn't know {} in {HOOKS_FILE}", shown_key(key)));
        }
    }
    match file.get("hooks") {
        None => {}
        Some(Value::Object(hooks)) => registry.hooks = hooks.iter().map(|(name, entry)| read_hook(name, entry, scripts)).collect(),
        Some(_) => registry.problems.push(format!("hooks in {HOOKS_FILE} should be an object of hook names")),
    }
    // A home's hook is found by its event and script, so two hooks can't share both.
    let mut seen: BTreeMap<(String, String), String> = BTreeMap::new();
    for hook in &mut registry.hooks {
        let Some(script) = repo_script(&hook.command).map(str::to_string) else { continue };
        if hook.event.is_empty() {
            continue;
        }
        if let Some(first) = seen.get(&(hook.event.clone(), script.clone())) {
            hook.problems.push(format!("{first} runs {script} on {} too; give each script one hook an event", hook.event));
        } else {
            seen.insert((hook.event.clone(), script), hook.name.clone());
        }
    }
    registry
}

// ---------------------------------------------------------------------------
// Comparing with the machines
// ---------------------------------------------------------------------------

/// How a home's hook stands against the repo.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HookState {
    /// It's as the repo has it.
    Same,
    /// The repo has it for this home, which hasn't got it.
    Add,
    /// The home has it, set up differently.
    Update,
    /// The home has it and the repo doesn't have it here: removed, kept off the machine, or not in the repo.
    Extra,
}

/// Why Arbor won't change a home's hook.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HookBlock {
    /// The repo's hook has problems.
    Broken,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HookCell {
    machine: String,
    agent: AgentKind,
    /// As the scan names it.
    home: String,
    /// The repo's name for it; None for a hook the repo hasn't got.
    name: Option<String>,
    event: String,
    /// The script it runs, in ~/.agents/hooks.
    script: String,
    state: HookState,
    blocked: Option<HookBlock>,
}

/// The agent whose hooks a home keeps, for the homes that keep any.
fn hook_agent(agent: HomeAgent) -> Option<AgentKind> {
    match agent {
        HomeAgent::Claude => Some(AgentKind::Claude),
        HomeAgent::Codex => Some(AgentKind::Codex),
        HomeAgent::Shared => None,
    }
}

/// How each repo hook stands in each of a machine's Claude Code and Codex homes, with the hooks there that run a
/// repo script the repo has no hook for.
fn machine_cells(registry: &Registry, machine: &str, setup: &MachineSetup) -> Vec<HookCell> {
    let mut cells = Vec::new();
    for (agent, home) in setup.agent_homes() {
        let Some(agent) = hook_agent(agent) else { continue };
        let found = setup.home_hooks(home);
        for hook in &registry.hooks {
            let Some(script) = hook.script() else { continue };
            let there: Vec<&str> = found.iter().filter(|found| found.event == hook.event && found.script == script).map(|found| found.sum.as_str()).collect();
            let state = match (hook.wanted(machine, agent, home), there.as_slice()) {
                (true, []) => HookState::Add,
                (true, [sum]) if *sum == hook_sum(hook.matcher.as_deref(), &hook.handler(), setup.home_dir()) => HookState::Same,
                (true, _) => HookState::Update,
                (false, []) => continue,
                (false, _) => HookState::Extra,
            };
            let blocked = (!hook.problems.is_empty()).then_some(HookBlock::Broken);
            cells.push(HookCell { machine: machine.to_string(), agent, home: home.to_string(), name: Some(hook.name.clone()), event: hook.event.clone(), script: script.to_string(), state, blocked });
        }
        let mut listed = BTreeSet::new();
        for found in &found {
            let known = registry.hooks.iter().any(|hook| hook.event == found.event && hook.script() == Some(found.script.as_str()));
            if known || !listed.insert((found.event.as_str(), found.script.as_str())) {
                continue;
            }
            cells.push(HookCell {
                machine: machine.to_string(),
                agent,
                home: home.to_string(),
                name: None,
                event: found.event.clone(),
                script: found.script.clone(),
                state: HookState::Extra,
                blocked: None,
            });
        }
    }
    cells
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HookView {
    name: String,
    event: String,
    matcher: Option<String>,
    /// As the repo has it; None when it looks like it holds a secret, which is never shown.
    command: Option<String>,
    script: Option<String>,
    timeout: Option<u64>,
    agents: Vec<AgentKind>,
    homes: Option<Vec<String>>,
    removed: bool,
    /// Turned off on every machine, kept in the repo.
    all_off: bool,
    /// Machines it's kept off.
    off: Vec<String>,
    problems: Vec<String>,
}

/// The repo's hooks and how every machine's Claude Code and Codex homes stand against them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HookRegistry {
    /// The commit they're read from, the repo's last. None before anything's committed.
    commit: Option<String>,
    /// The file is in that commit.
    found: bool,
    /// The file has changes that aren't committed, which count once they are.
    uncommitted: bool,
    problems: Vec<String>,
    hooks: Vec<HookView>,
    cells: Vec<HookCell>,
}

fn registry_view(commit: Option<String>, found: bool, uncommitted: bool, registry: &Registry, machines: &[(String, MachineSetup)]) -> HookRegistry {
    let hooks = registry
        .hooks
        .iter()
        .map(|hook| HookView {
            name: hook.name.clone(),
            event: hook.event.clone(),
            matcher: hook.matcher.clone(),
            command: (!hook.command.is_empty() && !holds_secret(&hook.command)).then(|| hook.command.clone()),
            script: hook.script().map(str::to_string),
            timeout: hook.timeout,
            agents: hook.agents.clone(),
            homes: hook.homes.clone(),
            removed: hook.removed,
            all_off: hook.off_everywhere,
            // As the scan names them, so the page finds each machine's choice however the file spells it.
            off: hook
                .off
                .iter()
                .map(|listed| {
                    let key = normalize_machine_name(listed);
                    machines.iter().find(|(machine, _)| normalize_machine_name(machine) == key).map_or_else(|| listed.clone(), |(machine, _)| machine.clone())
                })
                .collect(),
            problems: hook.problems.clone(),
        })
        .collect();
    // A file Arbor can't read says nothing about what each home should have.
    let cells = if registry.problems.is_empty() { machines.iter().flat_map(|(machine, setup)| machine_cells(registry, machine, setup)).collect() } else { Vec::new() };
    HookRegistry { commit, found, uncommitted, problems: registry.problems.clone(), hooks, cells }
}

// ---------------------------------------------------------------------------
// Reading the repo
// ---------------------------------------------------------------------------

/// The repo's last commit, or `commit`, and its hooks: whether the file is there, and whether it has changes that
/// aren't committed.
async fn load_registry(folder: &Path, commit: Option<&str>) -> Result<(Option<String>, bool, bool, Registry), String> {
    if !folder.is_dir() {
        return Err(format!("Arbor can't find {}", folder.display()));
    }
    let inside = git(folder, &["rev-parse", "--is-inside-work-tree"], GIT_TIMEOUT).await?;
    if !inside.status.success() || String::from_utf8_lossy(&inside.stdout).trim() != "true" {
        return Err(format!("{} isn't in a git repo", folder.display()));
    }
    let pathspec = format!("./{HOOKS_FILE}");
    let uncommitted = !git_out(folder, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", &pathspec]).await?.is_empty();
    let commit = match commit {
        Some(commit) if is_commit(commit) => commit.to_string(),
        Some(_) => return Err("That isn't a commit".into()),
        None => {
            let head = git(folder, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], GIT_TIMEOUT).await?;
            if !head.status.success() {
                return Ok((None, false, uncommitted, Registry::default()));
            }
            String::from_utf8_lossy(&head.stdout).trim().to_string()
        }
    };
    let scripts_spec = format!("./{SCRIPTS_DIR}/");
    let listed = git_out(folder, &["ls-tree", "-z", &commit, "--", &pathspec, &scripts_spec]).await?;
    let mut mode = None;
    let mut scripts = BTreeSet::new();
    for entry in listed.split('\0') {
        let Some((meta, path)) = entry.split_once('\t') else { continue };
        let fields: Vec<&str> = meta.split_whitespace().collect();
        let [entry_mode, "blob", _] = fields.as_slice() else { continue };
        if path.ends_with(HOOKS_FILE) {
            mode = Some(entry_mode.to_string());
        } else if let Some(script) = path.rsplit_once(&format!("{SCRIPTS_DIR}/")).map(|(_, script)| script) {
            if matches!(*entry_mode, "100644" | "100755") && is_script_name(script) {
                scripts.insert(script.to_string());
            }
        }
    }
    let registry = match mode.as_deref() {
        Some("100644" | "100755") => read_registry(&repo_file(folder, &commit, HOOKS_FILE).await?, &scripts),
        Some(_) => Registry { hooks: Vec::new(), problems: vec![format!("{HOOKS_FILE} is a link in the repo, which Arbor doesn't follow")] },
        None => Registry::default(),
    };
    Ok((Some(commit), mode.is_some(), uncommitted, registry))
}

async fn view(state: &MachineHealthState, folder: &Path) -> Result<HookRegistry, String> {
    let machines = scanned_machines(&state.lock());
    registry_for(folder, &machines).await
}

/// The repo's hooks at its last commit against `machines`' last scans.
pub(super) async fn registry_for(folder: &Path, machines: &[(String, MachineSetup)]) -> Result<HookRegistry, String> {
    let (commit, found, uncommitted, registry) = load_registry(folder, None).await?;
    Ok(registry_view(commit, found, uncommitted, &registry, machines))
}

impl HookRegistry {
    /// Each repo hook a home of `machine` doesn't have as the repo has it, by its name: one to add, change or take
    /// out there. A hook the repo hasn't got is the machine's own business.
    pub(super) fn behind_on<'a>(&'a self, machine: &'a str) -> impl Iterator<Item = (&'a str, HookState)> + 'a {
        self.cells.iter().filter(move |cell| cell.machine == machine && cell.state != HookState::Same).filter_map(|cell| Some((cell.name.as_deref()?, cell.state)))
    }

    /// The repo hooks that run `script`, from ~/.agents/hooks, and aren't removed.
    pub(super) fn running(&self, script: &str) -> Vec<&str> {
        self.hooks.iter().filter(|hook| !hook.removed && hook.script.as_deref() == Some(script)).map(|hook| hook.name.as_str()).collect()
    }

    #[cfg(test)]
    pub(super) fn for_test(hooks: &[(&str, &str)], cells: &[(&str, &str, HookState)]) -> Self {
        Self {
            commit: Some("a".repeat(40)),
            found: true,
            hooks: hooks
                .iter()
                .map(|(name, script)| HookView {
                    name: name.to_string(),
                    event: "Stop".into(),
                    matcher: None,
                    command: None,
                    script: Some(script.to_string()),
                    timeout: None,
                    agents: vec![AgentKind::Claude],
                    homes: None,
                    removed: false,
                    all_off: false,
                    off: Vec::new(),
                    problems: Vec::new(),
                })
                .collect(),
            cells: cells
                .iter()
                .map(|(machine, name, state)| HookCell {
                    machine: machine.to_string(),
                    agent: AgentKind::Claude,
                    home: "~/.claude".into(),
                    name: Some(name.to_string()),
                    event: "Stop".into(),
                    script: String::new(),
                    state: *state,
                    blocked: None,
                })
                .collect(),
            ..Self::default()
        }
    }
}

/// The repo's hooks, and how every machine's Claude Code and Codex homes stand against them as their last scans
/// found them.
#[tauri::command]
pub(crate) async fn get_hook_registry(state: tauri::State<'_, MachineHealthState>, repo: String) -> Result<HookRegistry, String> {
    view(&state, Path::new(&repo)).await
}

// ---------------------------------------------------------------------------
// Changing the repo
// ---------------------------------------------------------------------------

fn unreadable() -> String {
    format!("{HOOKS_FILE} isn't JSON Arbor can read. Fix it, then try again.")
}

/// The repo's file as it is in the folder, to change and commit alone: refused while it has changes that aren't
/// committed, which the commit would take along, or when it's a link.
async fn read_file_to_change(folder: &Path) -> Result<Value, String> {
    let pathspec = format!("./{HOOKS_FILE}");
    if !git_out(folder, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", &pathspec]).await?.is_empty() {
        return Err(format!("{HOOKS_FILE} has changes in the repo that aren't committed. Commit or drop them, then try again."));
    }
    let path = folder.join(HOOKS_FILE);
    if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(format!("{HOOKS_FILE} is a link in the repo, which Arbor leaves alone"));
    }
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok().filter(Value::is_object).ok_or_else(unreadable),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({ "version": FILE_VERSION, "hooks": {} })),
        Err(error) => Err(format!("Arbor couldn't read {HOOKS_FILE}: {error}")),
    }
}

fn hooks_of(file: &mut Value) -> Result<&mut serde_json::Map<String, Value>, String> {
    let root = file.as_object_mut().ok_or_else(unreadable)?;
    root.entry("version").or_insert(Value::from(FILE_VERSION));
    root.entry("hooks").or_insert_with(|| serde_json::json!({})).as_object_mut().ok_or_else(unreadable)
}

/// What the repo wants of a hook, for every machine or one.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HookWanted {
    /// As every machine has it: for one machine, no longer kept off it; for every machine, back from being removed or
    /// turned off.
    Default,
    /// One machine: kept off it, so its homes' copies are the repo's to remove. Every machine: turned off everywhere,
    /// kept in the repo, so every home's copy is the repo's to remove until it's turned on again.
    Off,
    /// Every machine: the repo keeps the hook but marks it removed, so every home's copy is the repo's to remove.
    Removed,
}

/// Changes a hook's value in `file`: for every machine when `machine` is None, or for that machine.
fn set_wanted(file: &mut Value, name: &str, machine: Option<&str>, wanted: HookWanted) -> Result<(), String> {
    let hook = hooks_of(file)?.get_mut(name).and_then(Value::as_object_mut).ok_or_else(|| format!("The repo hasn't got {name}"))?;
    match (machine, wanted) {
        (None, HookWanted::Removed) => {
            hook.insert("removed".into(), Value::Bool(true));
        }
        (None, HookWanted::Default) => {
            hook.remove("removed");
            hook.remove("all");
        }
        (None, HookWanted::Off) => {
            if hook.get("removed").and_then(Value::as_bool) == Some(true) {
                return Err(format!("{name} is removed from every machine. Put it back first."));
            }
            hook.insert("all".into(), Value::from("off"));
        }
        (Some(_), HookWanted::Removed) => return Err("A hook is removed from every machine, or kept off one".into()),
        (Some(machine), wanted) => {
            let machines = hook.entry("machines").or_insert_with(|| serde_json::json!({}));
            if !machines.is_object() {
                *machines = serde_json::json!({});
            }
            let machines = machines.as_object_mut().ok_or_else(unreadable)?;
            // The file's own spelling of the machine stays, so a hand-written "cedar-dev-01" isn't joined by "Cedar dev 01".
            let key = normalize_machine_name(machine);
            let listed = machines.keys().find(|listed| normalize_machine_name(listed) == key).cloned();
            if wanted == HookWanted::Off {
                machines.insert(listed.unwrap_or_else(|| machine.to_string()), Value::from("off"));
            } else if let Some(listed) = listed {
                machines.remove(&listed);
            }
            if machines.is_empty() {
                hook.remove("machines");
            }
        }
    }
    Ok(())
}

async fn commit_file(folder: &Path, file: &Value, message: &str) -> Result<(), String> {
    let text = serde_json::to_string_pretty(file).map_err(|error| error.to_string())? + "\n";
    take_into_repo(folder, HOOKS_FILE, text.as_bytes(), message, &[]).await
}

/// Sets what the repo wants of a hook, for every machine or one, and commits the file alone.
#[tauri::command]
pub(crate) async fn set_hook_wanted(
    state: tauri::State<'_, MachineHealthState>,
    repo: String,
    name: String,
    machine: Option<String>,
    wanted: HookWanted,
) -> Result<HookRegistry, String> {
    if !is_hook_name(&name) {
        return Err("Arbor only changes hooks named with letters, digits, - and _".into());
    }
    let folder = Path::new(&repo);
    let mut file = read_file_to_change(folder).await?;
    set_wanted(&mut file, &name, machine.as_deref(), wanted)?;
    let message = match (&machine, wanted) {
        (None, HookWanted::Removed) => format!("Remove hook {name} from all machines"),
        (None, HookWanted::Off) => format!("Turn hook {name} off on all machines"),
        (None, _) => format!("Put hook {name} back on all machines"),
        (Some(machine), HookWanted::Off) => format!("Keep hook {name} off {machine}"),
        (Some(machine), _) => format!("Give {machine} hook {name} as every machine has it"),
    };
    commit_file(folder, &file, &message).await?;
    view(&state, folder).await
}

/// Sets the agents whose homes a hook goes in, leaving the file without `agents` when it's Claude Code's alone.
fn set_agents(file: &mut Value, name: &str, agents: &[AgentKind]) -> Result<Vec<AgentKind>, String> {
    let hook = hooks_of(file)?.get_mut(name).and_then(Value::as_object_mut).ok_or_else(|| format!("The repo hasn't got {name}"))?;
    let mut agents = agents.to_vec();
    agents.sort_by_key(|agent| *agent == AgentKind::Codex);
    agents.dedup();
    match agents.as_slice() {
        [] => return Err("A hook goes to Claude Code, Codex or both".into()),
        [AgentKind::Claude] => {
            hook.remove("agents");
        }
        agents => {
            hook.insert("agents".into(), serde_json::to_value(agents).map_err(|error| error.to_string())?);
        }
    }
    Ok(agents)
}

/// Sets the agents whose homes a hook goes in, and commits the file alone.
#[tauri::command]
pub(crate) async fn set_hook_agents(state: tauri::State<'_, MachineHealthState>, repo: String, name: String, agents: Vec<AgentKind>) -> Result<HookRegistry, String> {
    if !is_hook_name(&name) {
        return Err("Arbor only changes hooks named with letters, digits, - and _".into());
    }
    let folder = Path::new(&repo);
    let mut file = read_file_to_change(folder).await?;
    let which = match set_agents(&mut file, &name, &agents)?.as_slice() {
        [AgentKind::Codex] => "Codex",
        [AgentKind::Claude] => "Claude Code",
        _ => "Claude Code and Codex",
    };
    commit_file(folder, &file, &format!("Give hook {name} to {which}")).await?;
    view(&state, folder).await
}

/// The hook in a Claude Code settings file, or Codex's hooks.json, that runs `script` on `event`: its group's matcher and its handler.
fn find_handler(settings: &Value, event: &str, script: &str, home_dir: &str) -> Option<(Option<String>, Value)> {
    settings.get("hooks")?.get(event)?.as_array()?.iter().find_map(|group| {
        let handler = group
            .get("hooks")?
            .as_array()?
            .iter()
            .find(|handler| handler.get("command").and_then(Value::as_str).and_then(|command| hook_script(command, home_dir)) == Some(script))?;
        Some((group.get("matcher").and_then(Value::as_str).map(str::to_string), handler.clone()))
    })
}

/// A name for a hook taken from a machine that the repo hasn't used: its script's, before the first dot, then with
/// its event after it.
fn new_name(file: &Value, script: &str, event: &str) -> String {
    let taken = |name: &str| file.get("hooks").and_then(|hooks| hooks.get(name)).is_some();
    let stem: String = script.split('.').next().unwrap_or(script).chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')).take(40).collect();
    let stem = if stem.is_empty() || !is_hook_name(&stem) { "hook".to_string() } else { stem };
    if !taken(&stem) {
        return stem;
    }
    let with_event = format!("{stem}-{}", event.to_ascii_lowercase());
    (1..).map(|n| if n == 1 { with_event.clone() } else { format!("{with_event}-{n}") }).find(|name| !taken(name)).unwrap_or(with_event)
}

/// Takes a hook from a machine's Claude Code or Codex home into the repo, with its script when the repo hasn't got
/// it, once neither holds anything that looks like a secret. The hook is the repo's for that agent on every machine
/// from then on.
#[tauri::command]
pub(crate) async fn take_hook(
    state: tauri::State<'_, MachineHealthState>,
    repo: String,
    machine: String,
    home: String,
    event: String,
    script: String,
) -> Result<HookRegistry, String> {
    if !is_event(&event) || !is_script_name(&script) {
        return Err("Arbor can only take a hook its last scan of this machine found. Scan again.".into());
    }
    let (target, agent, rel, home_dir) = {
        let inner = state.lock();
        let (target, setup) = covered_machine(&inner, &machine)?;
        let (Some(agent), Some(rel)) = (home_agent(setup, &home).and_then(hook_agent), home_place(&home)) else {
            return Err(format!("{home} isn't a Claude Code or Codex home Arbor changes on this machine"));
        };
        if !setup.home_hooks(&home).iter().any(|found| found.event == event && found.script == script) {
            return Err("Arbor can only take a hook its last scan of this machine found. Scan again.".into());
        }
        (target, agent, rel.to_string(), setup.home_dir().to_string())
    };
    let (op, file_name) = match agent {
        AgentKind::Claude => (MachineOp::ClaudeSettingsRead, "settings.json"),
        AgentKind::Codex => (MachineOp::CodexSettingsRead, "hooks.json"),
    };
    let read = format!("set -u\nexport LC_ALL=C\n{HELPERS}{EMIT_FUNCTIONS}printf 'N\\t0\\n'\nemit_data settings {}\nprintf 'E\\n'\n", place_words(&rel, file_name));
    let files = read_blocks(&run_on(&target, op, &read).await?)?;
    let settings = files.get(&0).and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok()).ok_or_else(|| format!("Arbor couldn't read {home}/{file_name} on {machine}"))?;
    let (matcher, handler) = find_handler(&settings, &event, &script, &home_dir).ok_or_else(|| format!("That hook isn't in {home} on {machine} any more. Scan again."))?;
    let command = as_repo_command(handler.get("command").and_then(Value::as_str).unwrap_or_default(), &home_dir);
    if holds_secret(&command) {
        return Err("Arbor didn't take the hook: its command looks like it holds a secret, and the repo mustn't hold one. Have the script read it from a variable, then take it again.".into());
    }
    if repo_script(&command) != Some(script.as_str()) {
        return Err(format!("Arbor only takes a hook whose command runs its script from ~/{SCRIPTS_DIR}"));
    }
    let folder = Path::new(&repo);
    let (commit, _, _, _) = load_registry(folder, None).await?;
    let script_rel = format!("{SCRIPTS_DIR}/{script}");
    let has_script = match &commit {
        Some(commit) => repo_file(folder, commit, &script_rel).await.is_ok(),
        None => false,
    };
    if !has_script {
        let path = format!("~/{script_rel}");
        let (target, absolute) = scanned_item(&state.lock(), &machine, &path, &[ItemKind::Hook])?;
        let text = read_text(&target, &absolute).await?;
        let content = text.content.ok_or_else(|| format!("{path} on {machine} is too large or isn't text"))?;
        if holds_secret(&content) {
            return Err(format!("Arbor didn't take the hook: {path} looks like it holds a secret, and the repo mustn't hold one. Have it read the secret from a variable, then take it again."));
        }
        take_into_repo(folder, &script_rel, content.as_bytes(), &format!("Take hook script {script} from {machine}"), &[]).await?;
    }
    let mut file = read_file_to_change(folder).await?;
    let name = new_name(&file, &script, &event);
    let mut entry = serde_json::json!({ "event": event, "command": command });
    if let Some(matcher) = matcher.filter(|matcher| !matcher.is_empty()) {
        entry["matcher"] = Value::from(matcher);
    }
    if let Some(timeout) = handler.get("timeout").and_then(Value::as_u64).filter(|seconds| (1..=MOST_SECONDS).contains(seconds)) {
        entry["timeout"] = Value::from(timeout);
    }
    // Claude Code's is the default, so only a hook taken from Codex says which agent it's for.
    if agent == AgentKind::Codex {
        entry["agents"] = serde_json::json!(["codex"]);
    }
    hooks_of(&mut file)?.insert(name.clone(), entry);
    commit_file(folder, &file, &format!("Take hook {name} from {machine}")).await?;
    view(&state, folder).await
}

// ---------------------------------------------------------------------------
// Changing a machine
// ---------------------------------------------------------------------------

/// A home to bring in step: its agent, the home, and the repo's hooks it should have, each an event, a matcher and a
/// handler.
type HomePlan = (AgentKind, String, Vec<(String, Option<String>, Value)>);

/// What each of a machine's Claude Code and Codex homes that isn't in step gets. Refused while the repo's hooks have
/// problems, or while a script a hook runs isn't on the machine yet, since the hook would run nothing.
fn machine_plan(registry: &Registry, machine: &str, setup: &MachineSetup) -> Result<Vec<HomePlan>, String> {
    if let Some(problem) = registry.problems.first() {
        return Err(problem.clone());
    }
    let broken: Vec<&str> = registry.hooks.iter().filter(|hook| !hook.problems.is_empty()).map(|hook| hook.name.as_str()).collect();
    if !broken.is_empty() {
        return Err(format!("Fix the repo's hooks first: {}", broken.join(", ")));
    }
    let cells = machine_cells(registry, machine, setup);
    let mut homes = Vec::new();
    for (agent, home) in setup.agent_homes() {
        let Some(agent) = hook_agent(agent) else { continue };
        if home_place(home).is_none() {
            continue;
        }
        if cells.iter().filter(|cell| cell.home == home).all(|cell| cell.state == HookState::Same) {
            continue;
        }
        let wanted: Vec<&Hook> = registry.hooks.iter().filter(|hook| hook.wanted(machine, agent, home)).collect();
        let missing: Vec<String> = wanted
            .iter()
            .filter_map(|hook| hook.script())
            .filter(|script| !setup.has_hook_script(script))
            .map(|script| format!("~/{SCRIPTS_DIR}/{script}"))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        if !missing.is_empty() {
            return Err(format!("{machine} hasn't got {} yet. Bring its files in step with the repo first, then its hooks.", missing.join(", ")));
        }
        homes.push((agent, home.to_string(), wanted.iter().map(|hook| (hook.event.clone(), hook.matcher.clone(), hook.handler())).collect()));
    }
    Ok(homes)
}

/// Puts the repo's hooks, as `commit` has them, in each of a machine's Claude Code and Codex homes that isn't in
/// step: hooks that run a script in ~/.agents/hooks are replaced with the repo's for that home, and every other hook
/// is left as it is. Each settings.json or hooks.json is changed the careful way, only while it's as read, backed up
/// first and on Sync › Repo › History to undo. Codex then asks for a review of each hook that's new or changed
/// before it runs it, which is left to its user. Then the machine is read again.
#[tauri::command]
pub(crate) async fn apply_hooks(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    repo: String,
    commit: String,
    machine: String,
) -> Result<Vec<super::attention::SettingsEdit>, String> {
    let (_, _, _, registry) = load_registry(Path::new(&repo), Some(&commit)).await?;
    let (target, homes, home_dir) = {
        let inner = state.lock();
        let (target, setup) = covered_machine(&inner, &machine)?;
        (target, machine_plan(&registry, &machine, setup)?, setup.home_dir().to_string())
    };
    if homes.is_empty() {
        return Err(format!("{machine}'s hooks are in step with the repo already"));
    }
    let mut edits = Vec::new();
    for (agent, home, wanted) in &homes {
        let edit = |content: Option<&str>| super::attention::set_repo_hooks(content, wanted, |command| hook_script(command, &home_dir).is_some());
        let home = std::slice::from_ref(home);
        let kind = super::guarded_writes::ChangeKind::Hooks;
        edits.extend(match agent {
            AgentKind::Claude => super::attention::edit_claude_settings(|| &target, home, kind, edit, true).await?,
            AgentKind::Codex => super::attention::edit_codex_hooks(|| &target, home, kind, edit, true).await?,
        });
    }
    rescan(&app, &machine);
    Ok(edits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::setup::FoundHook;
    use serde_json::json;

    fn scripts(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    fn registry(file: Value) -> Registry {
        read_registry(file.to_string().as_bytes(), &scripts(&["guard.sh", "notify.py"]))
    }

    #[test]
    fn a_repo_hook_runs_a_script_the_repo_keeps_and_holds_no_secret() {
        let read = registry(json!({ "version": 1, "hooks": {
            "guard": { "event": "PreToolUse", "matcher": "Bash", "command": "~/.agents/hooks/guard.sh", "timeout": 30 },
            "ping": { "event": "Stop", "command": "python3 ~/.agents/hooks/notify.py --quiet" },
            "anywhere": { "event": "Stop", "command": "/usr/local/bin/say done" },
            "missing": { "event": "Stop", "command": "~/.agents/hooks/gone.sh" },
            "leaky": { "event": "SessionStart", "command": "~/.agents/hooks/notify.py --token ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
            "twice": { "event": "PreToolUse", "command": "bash ~/.agents/hooks/guard.sh" },
            "odd": { "event": "Pre Tool", "command": "~/.agents/hooks/guard.sh", "color": "red" },
        } }));
        let problems = |name: &str| read.hook(name).unwrap().problems.len();
        assert_eq!((problems("guard"), problems("ping")), (0, 0));
        assert_eq!(read.hook("ping").unwrap().script(), Some("notify.py"));
        for broken in ["anywhere", "missing", "leaky", "twice", "odd"] {
            assert!(problems(broken) > 0, "{broken}");
        }
        // The leaky command is never shown.
        let shown = registry_view(None, true, false, &read, &[]);
        assert!(shown.hooks.iter().find(|hook| hook.name == "leaky").unwrap().command.is_none());
        assert!(!serde_json::to_string(&shown).unwrap().contains("ghp_"));
        assert!(!read_registry(b"[]", &scripts(&[])).problems.is_empty());
    }

    #[test]
    fn each_home_stands_against_the_repo_by_fingerprint() {
        let read = registry(json!({ "version": 1, "hooks": {
            "guard": { "event": "PreToolUse", "matcher": "Bash", "command": "~/.agents/hooks/guard.sh", "timeout": 30 },
            "ping": { "event": "Stop", "command": "python3 ~/.agents/hooks/notify.py", "machines": { "ci-01": "off" } },
        } }));
        let guard = read.hook("guard").unwrap();
        let same = hook_sum(Some("Bash"), &guard.handler(), "/Users/a");
        let found = |event: &str, script: &str, sum: &str| FoundHook { event: event.into(), script: script.into(), sum: sum.into() };
        let mut setup = MachineSetup::with_homes(&[(HomeAgent::Claude, "~/.claude"), (HomeAgent::Codex, "~/.codex")]).with_home_dir("/Users/a");
        setup.set_home_hooks("~/.claude", vec![found("PreToolUse", "guard.sh", &same), found("Stop", "notify.py", "other"), found("Stop", "old.sh", "x")]);
        let states = |machine: &str, setup: &MachineSetup| -> Vec<(Option<String>, String, HookState)> {
            machine_cells(&read, machine, setup).into_iter().map(|cell| (cell.name, cell.script, cell.state)).collect()
        };
        assert_eq!(
            states("mac", &setup),
            [
                (Some("guard".into()), "guard.sh".into(), HookState::Same),
                (Some("ping".into()), "notify.py".into(), HookState::Update),
                (None, "old.sh".into(), HookState::Extra),
            ]
        );
        // Kept off ci-01, where its copy is the repo's to remove.
        assert_eq!(itemize(&states("ci-01", &setup))[1], (Some("ping".into()), HookState::Extra));
        setup.set_home_hooks("~/.claude", Vec::new());
        assert_eq!(states("mac", &setup).iter().map(|(_, _, state)| *state).collect::<Vec<_>>(), [HookState::Add, HookState::Add]);
    }

    fn itemize(states: &[(Option<String>, String, HookState)]) -> Vec<(Option<String>, HookState)> {
        states.iter().map(|(name, _, state)| (name.clone(), *state)).collect()
    }

    #[test]
    fn a_hook_is_kept_off_a_machine_or_removed_from_every_one() {
        let mut file = json!({ "version": 1, "hooks": { "guard": { "event": "PreToolUse", "command": "~/.agents/hooks/guard.sh" } } });
        set_wanted(&mut file, "guard", Some("ci-01"), HookWanted::Off).unwrap();
        assert_eq!(file["hooks"]["guard"]["machines"], json!({ "ci-01": "off" }));
        assert!(!registry(file.clone()).hook("guard").unwrap().wanted("ci-01", AgentKind::Claude, "~/.claude"));
        set_wanted(&mut file, "guard", Some("ci-01"), HookWanted::Default).unwrap();
        assert!(file["hooks"]["guard"].get("machines").is_none());
        // Machine names compare loosely, and the file keeps its own spelling.
        file["hooks"]["guard"]["machines"] = json!({ "build-box": "off" });
        assert!(!registry(file.clone()).hook("guard").unwrap().wanted("Build Box", AgentKind::Claude, "~/.claude"));
        set_wanted(&mut file, "guard", Some("Build Box"), HookWanted::Off).unwrap();
        assert_eq!(file["hooks"]["guard"]["machines"], json!({ "build-box": "off" }));
        set_wanted(&mut file, "guard", Some("Build Box"), HookWanted::Default).unwrap();
        assert!(file["hooks"]["guard"].get("machines").is_none());
        set_wanted(&mut file, "guard", None, HookWanted::Removed).unwrap();
        assert!(!registry(file.clone()).hook("guard").unwrap().wanted("mac", AgentKind::Claude, "~/.claude"));
        set_wanted(&mut file, "guard", None, HookWanted::Default).unwrap();
        assert!(registry(file.clone()).hook("guard").unwrap().wanted("mac", AgentKind::Claude, "~/.claude"));
        // Off everywhere keeps it in the repo, on no machine, until it's turned on again.
        set_wanted(&mut file, "guard", None, HookWanted::Off).unwrap();
        assert_eq!(file["hooks"]["guard"]["all"], "off");
        let off = registry(file.clone());
        assert!(off.hook("guard").unwrap().problems.is_empty());
        assert!(!off.hook("guard").unwrap().wanted("mac", AgentKind::Claude, "~/.claude"));
        set_wanted(&mut file, "guard", None, HookWanted::Default).unwrap();
        assert!(file["hooks"]["guard"].get("all").is_none());
        assert!(registry(file.clone()).hook("guard").unwrap().wanted("mac", AgentKind::Claude, "~/.claude"));
        // A removed hook is put back before it's turned off.
        set_wanted(&mut file, "guard", None, HookWanted::Removed).unwrap();
        assert!(set_wanted(&mut file, "guard", None, HookWanted::Off).is_err());
        set_wanted(&mut file, "guard", None, HookWanted::Default).unwrap();
        assert!(set_wanted(&mut file, "guard", Some("mac"), HookWanted::Removed).is_err());
        assert!(set_wanted(&mut file, "other", Some("mac"), HookWanted::Off).is_err());
    }

    #[test]
    fn a_home_gets_the_repos_hooks_and_keeps_its_own() {
        let settings = r#"{
  "model": "opus",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "mine.sh" }, { "type": "command", "command": "~/.agents/hooks/old.sh" }] }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "$HOME/.agents/hooks/gone.sh" }] }]
  }
}
"#;
        let is_repo = |command: &str| hook_script(command, "/Users/a").is_some();
        let wanted = vec![("PreToolUse".to_string(), Some("Bash".to_string()), json!({ "type": "command", "command": "~/.agents/hooks/guard.sh", "timeout": 30 }))];
        let next = super::super::attention::set_repo_hooks(Some(settings), &wanted, is_repo).unwrap().unwrap();
        let value: Value = serde_json::from_str(&next).unwrap();
        assert_eq!(value["model"], "opus");
        assert_eq!(
            value["hooks"],
            json!({ "PreToolUse": [
                { "matcher": "Bash", "hooks": [{ "type": "command", "command": "mine.sh" }] },
                { "matcher": "Bash", "hooks": [{ "type": "command", "command": "~/.agents/hooks/guard.sh", "timeout": 30 }] },
            ] }),
            "the home's own hook stays; the repo's are replaced; an event left empty goes"
        );
        // Once in step, nothing changes.
        assert_eq!(super::super::attention::set_repo_hooks(Some(&next), &wanted, is_repo).unwrap(), None);
        // Nothing wanted and no hooks at all: nothing is added.
        assert_eq!(super::super::attention::set_repo_hooks(Some("{\"model\":\"opus\"}"), &[], is_repo).unwrap(), None);
        let emptied: Value = serde_json::from_str(&super::super::attention::set_repo_hooks(Some(&next), &[], is_repo).unwrap().unwrap()).unwrap();
        assert_eq!(emptied["hooks"], json!({ "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "mine.sh" }] }] }));
    }

    #[test]
    fn a_machine_is_brought_in_step_only_with_its_scripts_there_and_the_repo_sound() {
        let read = registry(json!({ "version": 1, "hooks": {
            "guard": { "event": "PreToolUse", "matcher": "Bash", "command": "~/.agents/hooks/guard.sh" },
            "ping": { "event": "Stop", "command": "python3 ~/.agents/hooks/notify.py", "homes": ["~/.claude"] },
        } }));
        let homes = [(HomeAgent::Claude, "~/.claude"), (HomeAgent::Claude, "~/.agent-app/claude"), (HomeAgent::Shared, "~/.agents")];
        let setup = MachineSetup::with_homes(&homes).with_home_dir("/Users/a");
        assert!(machine_plan(&read, "mac", &setup).unwrap_err().contains("~/.agents/hooks/guard.sh, ~/.agents/hooks/notify.py"));
        let setup = setup.with_hook_script("guard.sh").with_hook_script("notify.py");
        let plan = machine_plan(&read, "mac", &setup).unwrap();
        let events = |home: &str| -> Vec<String> { plan.iter().find(|(_, path, _)| path == home).unwrap().2.iter().map(|(event, _, _)| event.clone()).collect() };
        assert_eq!((events("~/.claude"), events("~/.agent-app/claude")), (vec!["PreToolUse".to_string(), "Stop".to_string()], vec!["PreToolUse".to_string()]));
        // Kept off, it's nothing to do while no home has it.
        let mut off = registry(json!({ "version": 1, "hooks": { "guard": { "event": "PreToolUse", "command": "~/.agents/hooks/guard.sh", "machines": { "mac": "off" } } } }));
        assert!(machine_plan(&off, "mac", &setup).unwrap().is_empty());
        off.hooks[0].problems.push("broken".into());
        assert!(machine_plan(&off, "mac", &setup).unwrap_err().contains("guard"));
    }

    #[test]
    fn a_hook_goes_to_codex_only_when_the_repo_says_so() {
        let read = registry(json!({ "version": 1, "hooks": {
            "guard": { "event": "PreToolUse", "command": "~/.agents/hooks/guard.sh" },
            "ping": { "event": "Stop", "command": "~/.agents/hooks/notify.py", "agents": ["codex", "claude", "codex"] },
            "odd": { "event": "Stop", "command": "~/.agents/hooks/guard.sh", "agents": ["cursor"] },
            "none": { "event": "SessionEnd", "command": "~/.agents/hooks/guard.sh", "agents": [] },
        } }));
        assert_eq!(read.hook("ping").unwrap().agents, [AgentKind::Claude, AgentKind::Codex]);
        assert!(!read.hook("odd").unwrap().problems.is_empty() && !read.hook("none").unwrap().problems.is_empty());
        let homes = [(HomeAgent::Claude, "~/.claude"), (HomeAgent::Codex, "~/.codex"), (HomeAgent::Shared, "~/.agents")];
        let setup = MachineSetup::with_homes(&homes).with_home_dir("/Users/a").with_hook_script("guard.sh").with_hook_script("notify.py");
        let sound = Registry { hooks: read.hooks.iter().filter(|hook| hook.problems.is_empty()).cloned().collect(), problems: Vec::new() };
        let cells: Vec<(AgentKind, Option<String>)> = machine_cells(&sound, "mac", &setup).into_iter().map(|cell| (cell.agent, cell.name)).collect();
        assert_eq!(cells, [(AgentKind::Claude, Some("guard".into())), (AgentKind::Claude, Some("ping".into())), (AgentKind::Codex, Some("ping".into()))]);
        let plan = machine_plan(&sound, "mac", &setup).unwrap();
        assert_eq!(plan.iter().map(|(agent, home, wanted)| (*agent, home.as_str(), wanted.len())).collect::<Vec<_>>(), [(AgentKind::Claude, "~/.claude", 2), (AgentKind::Codex, "~/.codex", 1)]);

        // The file only says which agents when it isn't Claude Code's alone.
        let mut file = json!({ "version": 1, "hooks": { "guard": { "event": "PreToolUse", "command": "~/.agents/hooks/guard.sh" } } });
        assert_eq!(set_agents(&mut file, "guard", &[AgentKind::Codex, AgentKind::Claude]).unwrap(), [AgentKind::Claude, AgentKind::Codex]);
        assert_eq!(file["hooks"]["guard"]["agents"], json!(["claude", "codex"]));
        set_agents(&mut file, "guard", &[AgentKind::Claude]).unwrap();
        assert!(file["hooks"]["guard"].get("agents").is_none());
        assert!(set_agents(&mut file, "guard", &[]).is_err());
    }

    #[test]
    fn a_machines_hook_is_found_and_named_the_way_the_repo_keeps_it() {
        let settings = json!({ "hooks": { "PreToolUse": [
            { "matcher": "Bash", "hooks": [{ "type": "command", "command": "~/.arbor/bin/arbor-agent-event pre" }, { "type": "command", "command": "bash /Users/a/.agents/hooks/guard.sh", "timeout": 10 }] },
        ] } });
        let (matcher, handler) = find_handler(&settings, "PreToolUse", "guard.sh", "/Users/a").unwrap();
        assert_eq!(matcher.as_deref(), Some("Bash"));
        assert_eq!(as_repo_command(handler["command"].as_str().unwrap(), "/Users/a"), "bash ~/.agents/hooks/guard.sh");
        assert_eq!(as_repo_command("$HOME/.agents/hooks/x.sh", "/Users/a"), "~/.agents/hooks/x.sh");
        assert!(find_handler(&settings, "Stop", "guard.sh", "/Users/a").is_none());
        let file = json!({ "hooks": { "guard": {} } });
        assert_eq!(new_name(&file, "notify.py", "Stop"), "notify");
        assert_eq!(new_name(&file, "guard.sh", "PreToolUse"), "guard-pretooluse");
    }
}

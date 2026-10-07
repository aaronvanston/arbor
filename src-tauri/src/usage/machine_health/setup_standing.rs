//! Sync's one answer to "is this machine in step with the setup repo?": for each machine, every item the repo lists
//! that the machine doesn't have as the repo's last commit has it, over every kind Sync keeps (instruction files,
//! rules, subagents and commands, skills, MCP servers, hooks and their scripts, Claude Code's and Codex's plugins) and
//! the projects the repo puts on it.
//!
//! This is the only place "in step" is decided. Overview, the Repo strip, the Library's "behind", the sidebar badge and
//! `arbor sync` all read it, so they can't disagree; the webview only renders it. What the repo doesn't list is each
//! machine's own business and never counts.
//!
//! Each item says what bringing the machine in line would do (add, update or take it out: `ItemDrift`) and who moved
//! since the two sides last matched (`Change`). That comes from a base per machine and item: both sides' fingerprints
//! the last time the machine had it as the repo did, kept on this Mac. The repo moving on is an update; the machine
//! moving is an edit made there, which Arbor never overwrites without being asked.

use super::harnesses;
use super::project_places::{drift, ProjectsDrift};
use super::setup::{covered_machines, scanned_machines, HomeAgent, ItemKind, MachineSetup, SetupItem};
use super::setup_hooks::{self, HookRegistry, HookState};
use super::setup_layers::arbor_machines;
use super::setup_mcp::{self, McpRegistry, RegistryState};
use super::setup_sync::{managed, read_repo, SetupRepo, SyncFileKind};
use super::setup_wanted::{PluginWanted, SkillWanted};
use super::*;
use std::collections::{BTreeMap, BTreeSet};
use ts_rs::TS;

/// The kind of thing a machine can be behind on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum StandingKind {
    /// An instruction file, rule, subagent or command.
    File,
    Skill,
    Mcp,
    /// A hook, or the script it runs.
    Hook,
    Plugin,
    Project,
}

/// What bringing the machine in line would do to an item.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ItemDrift {
    /// The repo has it for the machine, which hasn't got it.
    Add,
    /// The machine has it differently.
    Update,
    /// The machine has it where the repo keeps it off or took it out.
    Remove,
}

/// One item a machine is behind on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BehindItem {
    kind: StandingKind,
    /// The Library row's key (`file:~/.claude/CLAUDE.md`, `skill:pdf`, `mcp:linear`, `hook:repo:guard`,
    /// `plugin:claude:paper@paper`), or `project:owner/name`.
    key: String,
    name: String,
    drift: ItemDrift,
    change: Change,
}

/// Where a machine stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MachineState {
    InStep,
    Behind,
    /// Not answering. What it's behind on is from its last scan.
    Unreachable,
    /// Never scanned, so nothing can be said.
    NotScanned,
}

/// How many items a machine is behind on, by kind.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KindCounts {
    files: u32,
    skills: u32,
    mcp: u32,
    hooks: u32,
    plugins: u32,
    projects: u32,
    /// Of all of them, those edited on the machine (alone or with the repo), which wait for the user's decision.
    decide: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineStanding {
    machine: String,
    state: MachineState,
    reachable: bool,
    behind: Vec<BehindItem>,
    counts: KindCounts,
}

/// Every machine's standing against the repo, with what it was worked out from, so a page needn't read the repo again.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncStanding {
    repo: SetupRepo,
    /// The repo's MCP servers against the machines, or why they couldn't be read (then they aren't counted).
    mcp: Option<McpRegistry>,
    mcp_error: Option<String>,
    hooks: Option<HookRegistry>,
    hooks_error: Option<String>,
    machines: Vec<MachineStanding>,
    /// Of the machines read at least once, how many are in step.
    in_step: u32,
    read: u32,
}

// ---------------------------------------------------------------------------
// Files and skills
// ---------------------------------------------------------------------------

/// A machine with no SHA-256 tool fingerprints with `cksum`: c, its checksum, a dash and the length.
fn is_checksum(sum: &str) -> bool {
    sum.strip_prefix('c').and_then(|rest| rest.split_once('-')).is_some_and(|(crc, len)| {
        !crc.is_empty() && !len.is_empty() && crc.bytes().chain(len.bytes()).all(|byte| byte.is_ascii_digit())
    })
}

/// A skill in a machine's store, as the scan names it: ~/.agents/skills/<name>.
fn is_store_skill(path: &str) -> bool {
    path.strip_prefix("~/.agents/skills/").is_some_and(|name| !name.is_empty() && !name.starts_with('.') && !name.contains('/'))
}

fn regular(item: &SetupItem) -> bool {
    !item.is_link() && item.sum().is_some()
}

/// One item the repo lists, as compared on a machine: what bringing it in line would do (None while it's in step), and
/// both sides' fingerprints, each as the repo and the scan give them so a later look compares like with like. Only what
/// was actually compared is here: an item a machine keeps as its own, keeps off, has as a link, or has no home for
/// isn't, so it never gets a base it didn't earn.
#[derive(Clone, Debug, PartialEq)]
struct Compared {
    kind: StandingKind,
    key: String,
    name: String,
    drift: Option<ItemDrift>,
    repo: String,
    machine: String,
}

fn compared(kind: StandingKind, key: String, name: String, drift: Option<ItemDrift>, repo: impl Into<String>, machine: impl Into<String>) -> Compared {
    Compared { kind, key, name, drift, repo: repo.into(), machine: machine.into() }
}

/// What the machine has at a path: its fingerprint, or "-" when it hasn't got it.
fn machine_print(item: Option<&SetupItem>) -> String {
    item.and_then(SetupItem::sum).unwrap_or("-").to_string()
}

/// The repo's files and skills against one machine's scan, as the Repo review would compare them. Hook scripts come
/// back keyed `script:<name>`, for the hooks that run them to take in.
fn file_items(repo: &SetupRepo, machine: &str, setup: &MachineSetup) -> Vec<Compared> {
    let key = normalize_machine_name(machine);
    let harness_homes: BTreeSet<String> = harnesses::repo_homes().collect();
    let is_harness_home = |path: &str| path.strip_prefix("~/").is_some_and(|rel| harness_homes.contains(&format!("{rel}/")));
    let is_sync_home = |agent: HomeAgent, path: &str| matches!((agent, path), (HomeAgent::Claude, "~/.claude") | (HomeAgent::Codex, "~/.codex"));
    let synced = |path: &str| path.strip_prefix("~/").and_then(managed);

    let mut homes: BTreeSet<&str> = setup.homes().iter().filter(|home| is_sync_home(home.agent(), home.path())).map(|home| home.path()).collect();
    let mut present: BTreeMap<&str, &SetupItem> = BTreeMap::new();
    for home in setup.harness_homes().iter().filter(|home| is_harness_home(home.path())) {
        homes.insert(home.path());
        for item in home.items().iter().filter(|item| item.kind() == ItemKind::Instructions) {
            if let Some(path) = item.path().filter(|path| synced(path).is_some()) {
                present.insert(path, item);
            }
        }
    }
    const SYNC_KINDS: [ItemKind; 5] = [ItemKind::Instructions, ItemKind::Rule, ItemKind::Subagent, ItemKind::Command, ItemKind::Hook];
    for home in setup.homes().iter().filter(|home| is_sync_home(home.agent(), home.path()) || home.agent() == HomeAgent::Shared) {
        for item in home.items().iter().filter(|item| SYNC_KINDS.contains(&item.kind())) {
            if let Some(path) = item.path().filter(|path| synced(path).is_some()) {
                present.insert(path, item);
            }
        }
    }

    let mut items = Vec::new();
    let mut push = |kind: StandingKind, path: &str, drift: Option<ItemDrift>, repo: &str, machine: String| {
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        let key = match kind {
            StandingKind::Skill => format!("skill:{name}"),
            StandingKind::Hook => format!("script:{name}"),
            _ => format!("file:{path}"),
        };
        items.push(compared(kind, key, name, drift, repo, machine));
    };
    let file_wanted = |path: &str| repo.file_machines().get(path).and_then(|machines| machines.get(&key)).copied();
    for file in repo.files() {
        let item = present.get(file.path()).copied();
        let kind = if file.kind() == SyncFileKind::HookScript { StandingKind::Hook } else { StandingKind::File };
        // A file for a home the machine hasn't got: the agent isn't set up there. Hook scripts go in ~/.agents, which is
        // made where there isn't one.
        let home_ok = file.kind() == SyncFileKind::HookScript || homes.iter().any(|home| file.path().starts_with(&format!("{home}/")));
        let wanted = file_wanted(file.path());
        if repo.off_files().iter().any(|path| path == file.path()) && wanted != Some(SkillWanted::Own) {
            let there = item.filter(|item| regular(item));
            push(kind, file.path(), there.map(|_| ItemDrift::Remove), "off", machine_print(there));
        } else if wanted == Some(SkillWanted::Off) || (wanted == Some(SkillWanted::Own) && item.is_some_and(regular)) || !home_ok {
            continue;
        } else {
            match item {
                None => push(kind, file.path(), Some(ItemDrift::Add), file.print(false), "-".into()),
                Some(item) if !regular(item) => continue,
                Some(item) => {
                    let sum = item.sum().unwrap_or_default();
                    let drift = (sum != file.print(is_checksum(sum))).then_some(ItemDrift::Update);
                    push(kind, file.path(), drift, file.print(false), sum.to_string());
                }
            }
        }
    }
    for (path, item) in &present {
        if regular(item) && !repo.files().iter().any(|file| file.path() == *path) && repo.removed_files().iter().any(|removed| removed == path) {
            push(StandingKind::File, path, Some(ItemDrift::Remove), "removed", machine_print(Some(item)));
        }
    }

    // Skills go into the store, which is made where there isn't one, so every machine has somewhere for them.
    let store: BTreeMap<&str, &SetupItem> = setup
        .homes()
        .iter()
        .filter(|home| home.agent() == HomeAgent::Shared)
        .flat_map(|home| home.items())
        .filter(|item| item.kind() == ItemKind::Skill)
        .filter_map(|item| Some((item.path().filter(|path| is_store_skill(path))?, item)))
        .collect();
    let skill_wanted = |name: &str| repo.skill_machines().get(name).and_then(|machines| machines.get(&key)).copied();
    for skill in repo.skills() {
        let item = store.get(skill.path()).copied();
        let wanted = skill_wanted(skill.name());
        let repo_print = skill.print(false).unwrap_or("?");
        if repo.off_skills().iter().any(|name| name == skill.name()) && wanted != Some(SkillWanted::Own) {
            let there = item.filter(|item| regular(item) && item.has_doc());
            push(StandingKind::Skill, skill.path(), there.map(|_| ItemDrift::Remove), "off", machine_print(there));
        } else if wanted == Some(SkillWanted::Off) || (wanted == Some(SkillWanted::Own) && item.is_some_and(regular)) || skill.problem().is_some() {
            continue;
        } else {
            match item {
                None => push(StandingKind::Skill, skill.path(), Some(ItemDrift::Add), repo_print, "-".into()),
                Some(item) if item.is_link() || item.sum().is_none() || !item.has_doc() => continue,
                Some(item) => {
                    let sum = item.sum().unwrap_or_default();
                    let drift = (Some(sum) != skill.print(is_checksum(sum))).then_some(ItemDrift::Update);
                    push(StandingKind::Skill, skill.path(), drift, repo_print, sum.to_string());
                }
            }
        }
    }
    for (path, item) in &store {
        let name = path.rsplit('/').next().unwrap_or(path);
        let gone = repo.removed_skills().iter().any(|removed| removed == name) && skill_wanted(name) != Some(SkillWanted::Own);
        if gone && regular(item) && item.has_doc() && !repo.skills().iter().any(|skill| skill.path() == *path) {
            push(StandingKind::Skill, path, Some(ItemDrift::Remove), "removed", machine_print(Some(item)));
        }
    }
    items
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/// How a plugin is in one home: installed and on or off, turned on without being installed (`missing`), or not there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Place {
    On,
    Off,
    Missing,
    None,
}

fn place(item: Option<&SetupItem>, codex: bool) -> Place {
    match item {
        None => Place::None,
        // Codex's config names only what's installed.
        Some(item) if codex => if item.enabled() == Some(false) { Place::Off } else { Place::On },
        Some(item) if item.value().is_none() => if item.enabled() == Some(true) { Place::Missing } else { Place::None },
        Some(item) if item.enabled() == Some(false) => Place::Off,
        Some(_) => Place::On,
    }
}

/// What bringing a home in line does, when it isn't as wanted. A plugin turned on but not installed doesn't load, so
/// it's already off; a machine keeping its own is never out of step.
fn plugin_drift(place: Place, wanted: PluginWanted) -> Option<ItemDrift> {
    match (wanted, place) {
        (PluginWanted::On, Place::On) | (PluginWanted::Own, _) => None,
        (PluginWanted::On, Place::Off) => Some(ItemDrift::Update),
        (PluginWanted::On, _) => Some(ItemDrift::Add),
        (PluginWanted::Off, Place::On) => Some(ItemDrift::Update),
        (PluginWanted::Off, _) => None,
        (PluginWanted::Removed, Place::On | Place::Off) => Some(ItemDrift::Remove),
        (PluginWanted::Removed, _) => None,
    }
}

/// The plugins the repo lists against the machine's Claude Code (or Codex) homes. A plugin has no fingerprint of its
/// own (its version moves by itself), so each side is what it is: the repo's word, and on, off or not there per home.
fn plugin_items(repo: &SetupRepo, machine: &str, setup: &MachineSetup, codex: bool) -> Vec<Compared> {
    let agent = if codex { HomeAgent::Codex } else { HomeAgent::Claude };
    // A shadow home's config.toml is the home it shares's, so its plugins are that home's.
    let homes: Vec<_> = setup.homes().iter().filter(|home| home.agent() == agent && !(codex && setup.shares(home.path(), "config.toml"))).collect();
    if homes.is_empty() {
        return Vec::new();
    }
    let listed = if codex { repo.codex_plugins() } else { repo.plugins() };
    listed
        .iter()
        .filter(|plugin| plugin.wanted_on(machine) != PluginWanted::Own)
        .map(|plugin| {
            let id = plugin.id();
            let wanted = plugin.wanted_on(machine);
            let places: Vec<(&str, Place)> = homes
                .iter()
                .map(|home| (home.path(), place(home.items().iter().find(|item| item.kind() == ItemKind::Plugin && item.name() == id), codex)))
                .collect();
            let drift = places.iter().find_map(|(_, place)| plugin_drift(*place, wanted));
            let machine_side = places.iter().map(|(home, place)| format!("{home}={place:?}")).collect::<Vec<_>>().join(" ");
            let name = id.rsplit_once('@').map_or(id, |(name, _)| name).to_string();
            compared(StandingKind::Plugin, format!("plugin:{}:{id}", if codex { "codex" } else { "claude" }), name, drift, format!("{wanted:?}"), machine_side)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Every kind
// ---------------------------------------------------------------------------

fn registry_drift(state: RegistryState) -> Option<ItemDrift> {
    match state {
        RegistryState::Same => None,
        RegistryState::Add => Some(ItemDrift::Add),
        RegistryState::Extra => Some(ItemDrift::Remove),
        RegistryState::Update => Some(ItemDrift::Update),
    }
}

fn hook_drift(state: HookState) -> Option<ItemDrift> {
    match state {
        HookState::Same => None,
        HookState::Add => Some(ItemDrift::Add),
        HookState::Extra => Some(ItemDrift::Remove),
        HookState::Update => Some(ItemDrift::Update),
    }
}

/// Folds an item's homes into one: behind if any home is, each side's fingerprints listed home by home.
fn by_home(kind: StandingKind, key: String, name: &str, cells: &[(&str, Option<ItemDrift>, &str, &str)]) -> Compared {
    let drift = cells.iter().find_map(|(_, drift, _, _)| *drift);
    let repo = cells.iter().map(|cell| format!("{}={}", cell.0, cell.2)).collect::<Vec<_>>().join(" ");
    let machine = cells.iter().map(|cell| format!("{}={}", cell.0, cell.3)).collect::<Vec<_>>().join(" ");
    compared(kind, key, name.to_string(), drift, repo, machine)
}

/// Every item the repo lists as compared on one machine, each once, in kind order.
fn compare(repo: &SetupRepo, mcp: Option<&McpRegistry>, hooks: Option<&HookRegistry>, projects: &ProjectsDrift, machine: &str, setup: &MachineSetup) -> Vec<Compared> {
    let mut items = Vec::new();
    let mut scripts = Vec::new();
    for item in file_items(repo, machine, setup) {
        if item.kind == StandingKind::Hook { scripts.push(item) } else { items.push(item) }
    }
    if let Some(mcp) = mcp {
        let mut servers: BTreeMap<&str, Vec<(&str, Option<ItemDrift>, &str, &str)>> = BTreeMap::new();
        for (name, home, state, repo_side, machine_side) in mcp.compared_on(machine, setup) {
            servers.entry(name).or_default().push((home, registry_drift(state), repo_side, machine_side));
        }
        items.extend(servers.iter().map(|(name, cells)| by_home(StandingKind::Mcp, format!("mcp:{name}"), name, cells)));
    }
    let mut hook_items: BTreeMap<String, Compared> = BTreeMap::new();
    if let Some(hooks) = hooks {
        let mut found: BTreeMap<&str, Vec<(&str, Option<ItemDrift>, &str, &str)>> = BTreeMap::new();
        for (name, home, state, repo_side, machine_side) in hooks.compared_on(machine) {
            found.entry(name).or_default().push((home, hook_drift(state), repo_side, machine_side));
        }
        for (name, cells) in &found {
            hook_items.insert(name.to_string(), by_home(StandingKind::Hook, format!("hook:repo:{name}"), name, cells));
        }
        // A hook's script is part of it: bringing the hook in line writes the script, and an edit to it is an edit here.
        for script in &scripts {
            for name in hooks.running(&script.name) {
                let entry = hook_items.entry(name.to_string()).or_insert_with(|| compared(StandingKind::Hook, format!("hook:repo:{name}"), name.to_string(), None, "", ""));
                entry.drift = entry.drift.or(script.drift.map(|_| ItemDrift::Update));
                entry.repo = format!("{} {}={}", entry.repo, script.name, script.repo).trim().to_string();
                entry.machine = format!("{} {}={}", entry.machine, script.name, script.machine).trim().to_string();
            }
        }
    }
    items.extend(hook_items.into_values());
    items.extend(plugin_items(repo, machine, setup, false));
    items.extend(plugin_items(repo, machine, setup, true));
    items.extend(projects.behind_on(machine).into_iter().map(|project| {
        compared(StandingKind::Project, format!("project:{project}"), project.strip_prefix("_local/").unwrap_or(project).to_string(), Some(ItemDrift::Update), "", "")
    }));
    let mut seen = BTreeSet::new();
    items.retain(|item| seen.insert(item.key.clone()));
    items.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.cmp(&b.name)));
    items
}

// ---------------------------------------------------------------------------
// A base per machine
// ---------------------------------------------------------------------------

/// Both sides of an item on a machine the last time they matched: the repo's commit then, and each side's fingerprint.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub(super) struct Base {
    commit: String,
    repo: String,
    machine: String,
}

/// Who moved since the base: the repo alone (`update`), the machine alone (`editedHere`), both (`bothChanged`), or
/// can't tell (`unknown`: no base yet, or neither side moved yet they differ, as after a machine's own value is lifted).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Change {
    Update,
    EditedHere,
    BothChanged,
    Unknown,
}

impl Change {
    /// Bringing in line may apply it: the repo moved on, or nobody can say otherwise. An edit here waits for the user.
    fn applies(self) -> bool {
        matches!(self, Self::Update | Self::Unknown)
    }
}

fn classify(item: &Compared, base: Option<&Base>) -> Change {
    // A project's checkout isn't edited the way a file is: behind is the remote moving on.
    if item.kind == StandingKind::Project {
        return Change::Update;
    }
    let Some(base) = base else { return Change::Unknown };
    match (base.repo != item.repo, base.machine != item.machine) {
        (true, false) => Change::Update,
        (false, true) => Change::EditedHere,
        (true, true) => Change::BothChanged,
        (false, false) => Change::Unknown,
    }
}

/// Takes in one machine's comparison: each item in step becomes its base (at `commit`), each behind is classified
/// against its base. True when a base changed, so the bases are saved.
fn settle(bases: &mut BTreeMap<String, Base>, items: Vec<Compared>, commit: &str) -> (Vec<BehindItem>, bool) {
    let mut changed = false;
    let mut behind = Vec::new();
    for item in items {
        match item.drift {
            None => {
                let base = Base { commit: commit.to_string(), repo: item.repo, machine: item.machine };
                // The commit alone moving isn't worth a save: what a base compares is the two sides.
                if bases.get(&item.key).is_none_or(|old| old.repo != base.repo || old.machine != base.machine) {
                    bases.insert(item.key, base);
                    changed = true;
                }
            }
            Some(drift) => {
                let change = classify(&item, bases.get(&item.key));
                behind.push(BehindItem { kind: item.kind, key: item.key, name: item.name, drift, change });
            }
        }
    }
    (behind, changed)
}

/// Every machine's bases, by normalized name, as kept in Arbor's data folder (`setup-bases.json`). A file beside the
/// saved scans rather than usage.db: it's a small map rewritten whole, of the same fingerprints as those scans, and
/// usage.db is history that only grows.
#[derive(Debug, Default, Deserialize, PartialEq, Serialize)]
pub(super) struct Bases {
    version: u32,
    /// Which salt the MCP server and hook fingerprints were made with (a hash of it, never the salt). Under another,
    /// they'd all look edited, so their bases are dropped.
    salt: String,
    machines: BTreeMap<String, BTreeMap<String, Base>>,
}

const BASES_FILE: &str = "setup-bases.json";
const BASES_VERSION: u32 = 1;
static BASES: std::sync::Mutex<Option<Bases>> = std::sync::Mutex::new(None);
static SAVING_BASES: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Kinds whose fingerprints are salted.
fn salted(key: &str) -> bool {
    key.starts_with("mcp:") || key.starts_with("hook:")
}

fn read_bases(path: &Path, salt_check: &str) -> Bases {
    let fresh = Bases { version: BASES_VERSION, salt: salt_check.to_string(), machines: BTreeMap::new() };
    let Some(mut kept) = fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<Bases>(&bytes).ok()).filter(|kept| kept.version == BASES_VERSION) else {
        return fresh;
    };
    if kept.salt != salt_check {
        for items in kept.machines.values_mut() {
            items.retain(|key, _| !salted(key));
        }
        kept.salt = salt_check.to_string();
    }
    kept
}

fn write_bases(path: &Path, bases: &Bases) -> Result<(), String> {
    super::archive::store::write_atomic(path, &serde_json::to_vec(bases).map_err(|error| error.to_string())?)
}

fn bases_path() -> Option<PathBuf> {
    crate::core_base_dir().ok().map(|dir| dir.join(BASES_FILE))
}

// ---------------------------------------------------------------------------
// The standing
// ---------------------------------------------------------------------------

fn counts(items: &[BehindItem]) -> KindCounts {
    let mut counts = KindCounts::default();
    for item in items {
        let slot = match item.kind {
            StandingKind::File => &mut counts.files,
            StandingKind::Skill => &mut counts.skills,
            StandingKind::Mcp => &mut counts.mcp,
            StandingKind::Hook => &mut counts.hooks,
            StandingKind::Plugin => &mut counts.plugins,
            StandingKind::Project => &mut counts.projects,
        };
        *slot += 1;
        if !item.change.applies() {
            counts.decide += 1;
        }
    }
    counts
}

/// Each machine Sync covers (`machines`: name, answering, last scan) against the repo and what was read with it, each
/// difference classified against `bases`, which take in every item found in step. True when a base changed.
fn standing(
    repo: SetupRepo,
    mcp: Result<McpRegistry, String>,
    hooks: Result<HookRegistry, String>,
    projects: &ProjectsDrift,
    machines: &[(String, bool, MachineSetup)],
    bases: &mut BTreeMap<String, BTreeMap<String, Base>>,
) -> (SyncStanding, bool) {
    let (mcp, mcp_error) = match mcp {
        Ok(registry) => (Some(registry), None),
        Err(error) => (None, Some(error)),
    };
    let (hooks, hooks_error) = match hooks {
        Ok(registry) => (Some(registry), None),
        Err(error) => (None, Some(error)),
    };
    let commit = repo.head_sha().unwrap_or_default().to_string();
    let mut saved = false;
    let machines: Vec<MachineStanding> = machines
        .iter()
        .map(|(machine, reachable, setup)| {
            let read = setup.is_read();
            let items = if read {
                let found = compare(&repo, mcp.as_ref(), hooks.as_ref(), projects, machine, setup);
                let (items, changed) = settle(bases.entry(normalize_machine_name(machine)).or_default(), found, &commit);
                saved |= changed;
                items
            } else {
                Vec::new()
            };
            let state = match (read, *reachable, items.is_empty()) {
                (false, _, _) => MachineState::NotScanned,
                (true, false, _) => MachineState::Unreachable,
                (true, true, true) => MachineState::InStep,
                (true, true, false) => MachineState::Behind,
            };
            MachineStanding { machine: machine.clone(), state, reachable: *reachable, counts: counts(&items), behind: items }
        })
        .collect();
    let read = machines.iter().filter(|machine| machine.state != MachineState::NotScanned).count() as u32;
    let in_step = machines.iter().filter(|machine| machine.state == MachineState::InStep).count() as u32;
    (SyncStanding { repo, mcp, mcp_error, hooks, hooks_error, machines, in_step, read }, saved)
}

/// Where every machine stands against the setup repo's last commit, from the machines' last scans, with the repo,
/// its MCP servers and hooks as they were read for it. Remembers `repo` as the one the window names.
///
/// It's also where each machine's base is kept: every item it finds in step, after a change Arbor made and the rescan
/// that follows it as much as a machine that was in step already, is recorded as the two sides then. The window reads
/// this after every scan lands, and so does `arbor sync`.
#[tauri::command]
pub(crate) async fn get_sync_standing(state: tauri::State<'_, MachineHealthState>, repo: String) -> Result<SyncStanding, String> {
    state.lock().setup_repo = Some(repo.clone());
    let folder = Path::new(&repo);
    let found = read_repo(folder).await?;
    let scanned = scanned_machines(&state.lock());
    let (mcp, hooks) = tokio::join!(setup_mcp::registry_for(folder, &scanned), setup_hooks::registry_for(folder, &scanned));
    let (projects, machines) = {
        let inner = state.lock();
        (drift(found.layers(), &arbor_machines(&inner), &inner.projects), covered_machines(&inner))
    };
    let path = bases_path();
    let salt_check = super::setup::salt_check();
    let (standing, snapshot) = {
        let mut held = BASES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let bases = held.get_or_insert_with(|| path.as_deref().map_or_else(Bases::default, |path| read_bases(path, &salt_check)));
        let (standing, changed) = standing(found, mcp, hooks, &projects, &machines, &mut bases.machines);
        (standing, changed.then(|| Bases { version: BASES_VERSION, salt: salt_check.clone(), machines: bases.machines.clone() }))
    };
    if let (Some(path), Some(bases)) = (path, snapshot) {
        tauri::async_runtime::spawn_blocking(move || {
            let _saving = SAVING_BASES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Err(error) = write_bases(&path, &bases) {
                eprintln!("Couldn't keep Sync's bases: {error}");
            }
        });
    }
    Ok(standing)
}

/// The fingerprints a registry test cell has, by its state: the repo's and the home's the same when it's in step.
#[cfg(test)]
pub(super) fn test_prints(extra: bool, add: bool, same: bool) -> (String, String) {
    let (repo, machine) = if extra { ("-", "b") } else if add { ("a", "-") } else if same { ("a", "a") } else { ("a", "b") };
    (repo.to_string(), machine.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::setup_repo_skills::RepoSkill;
    use super::super::setup_wanted::RepoPlugin;

    const SUM: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const OTHER: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn machine() -> MachineSetup {
        MachineSetup::with_homes(&[(HomeAgent::Claude, "~/.claude"), (HomeAgent::Codex, "~/.codex"), (HomeAgent::Shared, "~/.agents")]).with_home_dir("/home/cam")
    }

    fn keys(items: &[BehindItem]) -> Vec<(&str, ItemDrift)> {
        items.iter().map(|item| (item.key.as_str(), item.drift)).collect()
    }

    fn no_projects() -> ProjectsDrift {
        drift(&Default::default(), &[], &BTreeMap::new())
    }

    fn one_with(repo: SetupRepo, mcp: Option<McpRegistry>, hooks: Option<HookRegistry>, setup: MachineSetup, bases: &mut BTreeMap<String, BTreeMap<String, Base>>) -> MachineStanding {
        let (found, _) = standing(repo, mcp.ok_or_else(|| "unread".to_string()), hooks.ok_or_else(|| "unread".to_string()), &no_projects(), &[("cam-mbp".into(), true, setup)], bases);
        found.machines.into_iter().next().unwrap()
    }

    fn one(repo: SetupRepo, mcp: Option<McpRegistry>, hooks: Option<HookRegistry>, setup: MachineSetup) -> MachineStanding {
        one_with(repo, mcp, hooks, setup, &mut BTreeMap::new())
    }

    fn changes(found: &MachineStanding) -> Vec<(&str, Change)> {
        found.behind.iter().map(|item| (item.key.as_str(), item.change)).collect()
    }

    #[test]
    fn files_and_skills_are_behind_where_the_repo_would_add_change_or_take_them_out() {
        let repo = SetupRepo::for_test()
            .with_file("~/.claude/CLAUDE.md", SUM)
            .with_file("~/.claude/rules/style.md", SUM)
            .with_file("~/.codex/AGENTS.md", SUM)
            .with_skill(RepoSkill::for_test("pdf", SUM))
            .with_skill(RepoSkill::for_test("grill-me", SUM))
            .with_marks(&["~/.claude/rules/old.md"], &["gone"], &[]);
        let setup = machine()
            .with_file("~/.claude", ItemKind::Instructions, "~/.claude/CLAUDE.md", Some(SUM))
            .with_file("~/.claude", ItemKind::Rule, "~/.claude/rules/style.md", Some(OTHER))
            .with_file("~/.claude", ItemKind::Rule, "~/.claude/rules/old.md", Some(SUM))
            // A cksum machine's fingerprint compares with the repo's checksum.
            .with_file("~/.codex", ItemKind::Instructions, "~/.codex/AGENTS.md", Some("c1-1"))
            .with_file("~/.agents", ItemKind::Skill, "~/.agents/skills/pdf", Some(SUM))
            .with_file("~/.agents", ItemKind::Skill, "~/.agents/skills/gone", Some(SUM))
            // Only the machine has it, and the repo never had it: the machine's own.
            .with_file("~/.agents", ItemKind::Skill, "~/.agents/skills/mine", Some(SUM));
        let found = one(repo, None, None, setup);
        assert_eq!(found.state, MachineState::Behind);
        assert_eq!(keys(&found.behind), [
            ("file:~/.claude/rules/old.md", ItemDrift::Remove),
            ("file:~/.claude/rules/style.md", ItemDrift::Update),
            ("skill:gone", ItemDrift::Remove),
            ("skill:grill-me", ItemDrift::Add),
        ]);
        assert_eq!((found.counts.files, found.counts.skills), (2, 2));
    }

    #[test]
    fn a_machine_keeping_its_own_or_kept_off_is_never_behind_and_a_link_is_left_alone() {
        let mut repo = SetupRepo::for_test().with_skill(RepoSkill::for_test("pdf", SUM)).with_skill(RepoSkill::for_test("linked", SUM));
        repo = repo.with_marks(&[], &[], &[]);
        let setup = machine().with_file("~/.agents", ItemKind::Skill, "~/.agents/skills/linked", None).with_file("~/.agents", ItemKind::Skill, "~/.agents/skills/pdf", Some(OTHER));
        let found = one(repo, None, None, setup.clone());
        assert_eq!(keys(&found.behind), [("skill:pdf", ItemDrift::Update)]);
        // Off everywhere: the store copy is the repo's to take out.
        let off = SetupRepo::for_test().with_skill(RepoSkill::for_test("pdf", SUM)).with_marks(&[], &[], &["pdf"]);
        assert_eq!(keys(&one(off, None, None, setup).behind), [("skill:pdf", ItemDrift::Remove)]);
    }

    #[test]
    fn a_machine_behind_only_on_a_plugin_is_behind() {
        let repo = SetupRepo::for_test()
            .with_plugin(RepoPlugin::for_test("paper@paper", PluginWanted::On, &[("cam-mbp", PluginWanted::On)]), false)
            .with_plugin(RepoPlugin::for_test("ghost@nowhere", PluginWanted::Removed, &[]), false)
            .with_plugin(RepoPlugin::for_test("mine@team", PluginWanted::On, &[("Cam MBP", PluginWanted::Own)]), false)
            .with_plugin(RepoPlugin::for_test("linear@tools", PluginWanted::Off, &[]), true);
        let setup = machine()
            .with_item("~/.claude", ItemKind::Plugin, "paper@paper", Some("1.0.0"), Some(false))
            .with_item("~/.claude", ItemKind::Plugin, "ghost@nowhere", Some("0.1.0"), Some(true))
            .with_item("~/.codex", ItemKind::Plugin, "linear@tools", None, Some(true));
        let found = one(repo, None, None, setup);
        assert_eq!(keys(&found.behind), [
            ("plugin:claude:ghost@nowhere", ItemDrift::Remove),
            ("plugin:codex:linear@tools", ItemDrift::Update),
            ("plugin:claude:paper@paper", ItemDrift::Update),
        ]);
        assert_eq!(found.counts, KindCounts { plugins: 3, ..KindCounts::default() });
    }

    #[test]
    fn mcp_servers_and_hooks_count_from_their_registries_and_a_hook_script_puts_its_hooks_behind() {
        let repo = SetupRepo::for_test().with_file("~/.agents/hooks/guard.sh", SUM);
        let setup = machine().with_file("~/.agents", ItemKind::Hook, "~/.agents/hooks/guard.sh", Some(OTHER));
        let mcp = McpRegistry::for_test(&["linear"], &[
            ("cam-mbp", "~/.claude", "linear", RegistryState::Add),
            ("cam-mbp", "~/.codex", "linear", RegistryState::Same),
            // A server the repo doesn't list is the machine's own.
            ("cam-mbp", "~/.claude", "mine", RegistryState::Extra),
            ("other", "~/.claude", "linear", RegistryState::Update),
        ]);
        let hooks = HookRegistry::for_test(&[("guard", "guard.sh"), ("notify", "notify.sh")], &[("cam-mbp", "notify", HookState::Extra)]);
        let found = one(repo, Some(mcp), Some(hooks), setup);
        assert_eq!(keys(&found.behind), [
            ("mcp:linear", ItemDrift::Add),
            ("hook:repo:guard", ItemDrift::Update),
            ("hook:repo:notify", ItemDrift::Remove),
        ]);
    }

    #[test]
    fn a_project_cell_needs_its_place_then_an_up_to_date_checkout_and_a_scan_alone_is_not_behind() {
        use super::super::project_places::{cell_needs, CellNeed, PlaceState, ProjectCell};
        use super::super::setup_projects::CheckoutStatus;
        let status = |behind: u32, upstream: &str, fetch_failed: bool| CheckoutStatus {
            branch: Some("main".into()),
            upstream: Some(upstream.into()),
            behind: Some(behind),
            default_branch: Some("origin/main".into()),
            fetch_failed,
            ..CheckoutStatus::default()
        };
        let needs = |state, status| cell_needs(&ProjectCell::for_test(state, "~/code/cam/arbor", None, status));
        assert_eq!(needs(PlaceState::InPlace, Some(status(0, "origin/main", false))), []);
        assert_eq!(needs(PlaceState::Elsewhere, Some(status(2, "origin/main", true))), [CellNeed::Link, CellNeed::Fetch, CellNeed::Pull]);
        // Behind on another branch isn't Sync's to fix.
        assert_eq!(needs(PlaceState::Linked, Some(status(2, "origin/topic", false))), []);
        assert_eq!(needs(PlaceState::Missing, None), [CellNeed::Clone]);
        assert_eq!(needs(PlaceState::NotScanned, None), [CellNeed::Scan]);
    }

    #[test]
    fn unread_and_unanswering_machines_say_so_and_only_read_ones_count() {
        let repo = SetupRepo::for_test().with_file("~/.claude/CLAUDE.md", SUM);
        let in_step = machine().with_file("~/.claude", ItemKind::Instructions, "~/.claude/CLAUDE.md", Some(SUM));
        let behind = machine();
        let (found, _) = standing(repo, Err("unread".into()), Ok(HookRegistry::default()), &no_projects(), &[
            ("a".into(), true, in_step),
            ("b".into(), false, behind.clone()),
            ("c".into(), true, MachineSetup::default()),
            ("d".into(), true, behind),
        ], &mut BTreeMap::new());
        let states: Vec<_> = found.machines.iter().map(|machine| (machine.machine.as_str(), machine.state)).collect();
        assert_eq!(states, [("a", MachineState::InStep), ("b", MachineState::Unreachable), ("c", MachineState::NotScanned), ("d", MachineState::Behind)]);
        assert_eq!((found.in_step, found.read), (1, 3));
        assert_eq!(found.mcp_error.as_deref(), Some("unread"), "a registry that couldn't be read says why");
        assert_eq!(keys(&found.machines[1].behind), [("file:~/.claude/CLAUDE.md", ItemDrift::Add)], "an unanswering machine keeps what its last scan says");
    }

    #[test]
    fn a_base_tells_the_repo_moving_on_from_an_edit_on_the_machine() {
        const THIRD: &str = "3333333333333333333333333333333333333333333333333333333333333333";
        let repo = |sum: &str| SetupRepo::for_test().with_file("~/.claude/CLAUDE.md", sum);
        let machine_with = |sum: &str| machine().with_file("~/.claude", ItemKind::Instructions, "~/.claude/CLAUDE.md", Some(sum));
        let key = "file:~/.claude/CLAUDE.md";

        // No base yet: it can't say who moved, and the item may still be brought in line.
        assert_eq!(changes(&one(repo(SUM), None, None, machine_with(OTHER))), [(key, Change::Unknown)]);

        // In step once: that's the base, kept per machine.
        let mut bases = BTreeMap::new();
        assert!(one_with(repo(SUM), None, None, machine_with(SUM), &mut bases).behind.is_empty());
        assert_eq!(bases["cammbp"][key].repo, SUM);
        assert_eq!(changes(&one_with(repo(OTHER), None, None, machine_with(SUM), &mut bases.clone())), [(key, Change::Update)]);
        let edited = one_with(repo(SUM), None, None, machine_with(OTHER), &mut bases.clone());
        assert_eq!(changes(&edited), [(key, Change::EditedHere)]);
        assert_eq!(edited.counts.decide, 1, "an edit here waits for a decision");
        assert_eq!(changes(&one_with(repo(OTHER), None, None, machine_with(THIRD), &mut bases.clone())), [(key, Change::BothChanged)]);
        // The machine taking the edit away again is the same as deleting it there.
        assert_eq!(changes(&one_with(repo(SUM), None, None, machine(), &mut bases.clone())), [(key, Change::EditedHere)]);
        // A cksum machine's base is its own checksum, compared with what it reports next time.
        let mut ck = BTreeMap::new();
        one_with(repo(SUM), None, None, machine_with("c1-1"), &mut ck);
        assert_eq!(changes(&one_with(repo(OTHER), None, None, machine_with("c1-1"), &mut ck)), [(key, Change::Update)]);
    }

    #[test]
    fn salted_kinds_and_plugins_keep_a_base_too() {
        let mut bases = BTreeMap::new();
        let same = McpRegistry::for_test(&["linear"], &[("cam-mbp", "~/.claude", "linear", RegistryState::Same)]);
        let hooks = HookRegistry::for_test(&[("notify", "notify.sh")], &[("cam-mbp", "notify", HookState::Same)]);
        let paper = |wanted| SetupRepo::for_test().with_plugin(RepoPlugin::for_test("paper@paper", wanted, &[]), false);
        let on = machine().with_item("~/.claude", ItemKind::Plugin, "paper@paper", Some("1.0.0"), Some(true));
        assert!(one_with(paper(PluginWanted::On), Some(same), Some(hooks), on.clone(), &mut bases).behind.is_empty());
        let edited = McpRegistry::for_test(&["linear"], &[("cam-mbp", "~/.claude", "linear", RegistryState::Update)]);
        let hook_edited = HookRegistry::for_test(&[("notify", "notify.sh")], &[("cam-mbp", "notify", HookState::Update)]);
        let off = machine().with_item("~/.claude", ItemKind::Plugin, "paper@paper", Some("1.0.0"), Some(false));
        let found = one_with(paper(PluginWanted::On), Some(edited), Some(hook_edited), off, &mut bases.clone());
        assert_eq!(changes(&found), [("mcp:linear", Change::EditedHere), ("hook:repo:notify", Change::EditedHere), ("plugin:claude:paper@paper", Change::EditedHere)]);
        // The repo turning it off is the repo moving on.
        assert_eq!(changes(&one_with(paper(PluginWanted::Off), None, None, on, &mut bases)), [("plugin:claude:paper@paper", Change::Update)]);
    }

    #[test]
    fn kept_bases_come_back_and_salted_ones_go_under_another_salt() {
        let path = std::env::temp_dir().join(format!("arbor-setup-bases-{}.json", std::process::id()));
        let base = Base { commit: "a".repeat(40), repo: "r".into(), machine: "m".into() };
        let items = BTreeMap::from([("file:~/.claude/CLAUDE.md".to_string(), base.clone()), ("mcp:linear".to_string(), base.clone())]);
        let bases = Bases { version: BASES_VERSION, salt: "s1".into(), machines: BTreeMap::from([("cammbp".to_string(), items.clone())]) };
        write_bases(&path, &bases).unwrap();
        assert_eq!(read_bases(&path, "s1"), bases);
        let resalted = read_bases(&path, "s2");
        assert_eq!(resalted.machines["cammbp"].keys().collect::<Vec<_>>(), ["file:~/.claude/CLAUDE.md"]);
        fs::write(&path, "{").unwrap();
        assert!(read_bases(&path, "s1").machines.is_empty());
        let _ = fs::remove_file(&path);
        // The kept file holds fingerprints and commits, nothing else.
        assert!(!serde_json::to_string(&bases).unwrap().contains("salt\":\"0"));
    }
}

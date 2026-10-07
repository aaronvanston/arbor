//! Sync's one answer to "is this machine in step with the setup repo?": for each machine, every item the repo lists
//! that the machine doesn't have as the repo's last commit has it, over every kind Sync keeps (instruction files,
//! rules, subagents and commands, skills, MCP servers, hooks and their scripts, Claude Code's and Codex's plugins) and
//! the projects the repo puts on it.
//!
//! This is the only place "in step" is decided. Overview, the Repo strip, the Library's "behind", the sidebar badge and
//! `arbor sync` all read it, so they can't disagree; the webview only renders it. What the repo doesn't list is each
//! machine's own business and never counts.
//!
//! Each item is compared with the repo's HEAD alone, so it can only say what bringing the machine in line would do:
//! add it, update it or take it out (`ItemDrift`). Telling "the repo moved on" from "someone edited the machine"
//! needs a record of what was last applied there; that comes as more `ItemDrift`s, not another definition.

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
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineStanding {
    machine: String,
    state: MachineState,
    reachable: bool,
    scanned_at: Option<i64>,
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

/// The repo's files and skills against one machine's scan: each one bringing the machine in line would add, update
/// or take out, as the Repo review lists them.
fn file_items(repo: &SetupRepo, machine: &str, setup: &MachineSetup) -> Vec<BehindItem> {
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
    let mut push = |kind: StandingKind, path: &str, drift: ItemDrift| {
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        let key = match kind {
            StandingKind::Skill => format!("skill:{name}"),
            _ => format!("file:{path}"),
        };
        items.push(BehindItem { kind, key, name, drift });
    };
    let file_wanted = |path: &str| repo.file_machines().get(path).and_then(|machines| machines.get(&key)).copied();
    for file in repo.files() {
        let item = present.get(file.path()).copied();
        // A file for a home the machine hasn't got: the agent isn't set up there. Hook scripts go in ~/.agents, which is
        // made where there isn't one.
        let home_ok = file.kind() == SyncFileKind::HookScript || homes.iter().any(|home| file.path().starts_with(&format!("{home}/")));
        let wanted = file_wanted(file.path());
        let drift = if repo.off_files().iter().any(|path| path == file.path()) && wanted != Some(SkillWanted::Own) {
            item.filter(|item| regular(item)).map(|_| ItemDrift::Remove)
        } else if wanted == Some(SkillWanted::Off) || (wanted == Some(SkillWanted::Own) && item.is_some_and(regular)) || !home_ok {
            None
        } else {
            match item {
                None => Some(ItemDrift::Add),
                Some(item) if !regular(item) => None,
                Some(item) => {
                    let sum = item.sum().unwrap_or_default();
                    (sum != file.print(is_checksum(sum))).then_some(ItemDrift::Update)
                }
            }
        };
        if let Some(drift) = drift {
            push(if file.kind() == SyncFileKind::HookScript { StandingKind::Hook } else { StandingKind::File }, file.path(), drift);
        }
    }
    for (path, item) in &present {
        if regular(item) && !repo.files().iter().any(|file| file.path() == *path) && repo.removed_files().iter().any(|removed| removed == path) {
            push(StandingKind::File, path, ItemDrift::Remove);
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
        let drift = if repo.off_skills().iter().any(|name| name == skill.name()) && wanted != Some(SkillWanted::Own) {
            item.filter(|item| regular(item) && item.has_doc()).map(|_| ItemDrift::Remove)
        } else if wanted == Some(SkillWanted::Off) || (wanted == Some(SkillWanted::Own) && item.is_some_and(regular)) || skill.problem().is_some() {
            None
        } else {
            match item {
                None => Some(ItemDrift::Add),
                Some(item) if item.is_link() || item.sum().is_none() || !item.has_doc() => None,
                Some(item) => {
                    let sum = item.sum().unwrap_or_default();
                    (Some(sum) != skill.print(is_checksum(sum))).then_some(ItemDrift::Update)
                }
            }
        };
        if let Some(drift) = drift {
            push(StandingKind::Skill, skill.path(), drift);
        }
    }
    for (path, item) in &store {
        let name = path.rsplit('/').next().unwrap_or(path);
        let gone = repo.removed_skills().iter().any(|removed| removed == name) && skill_wanted(name) != Some(SkillWanted::Own);
        if gone && regular(item) && item.has_doc() && !repo.skills().iter().any(|skill| skill.path() == *path) {
            push(StandingKind::Skill, path, ItemDrift::Remove);
        }
    }
    items
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/// How a plugin is in one home: installed and on or off, turned on without being installed (`missing`), or not there.
#[derive(Clone, Copy, PartialEq, Eq)]
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

/// The plugins the repo lists that one of the machine's Claude Code (or Codex) homes doesn't have as wanted.
fn plugin_items(repo: &SetupRepo, machine: &str, setup: &MachineSetup, codex: bool) -> Vec<BehindItem> {
    let agent = if codex { HomeAgent::Codex } else { HomeAgent::Claude };
    // A shadow home's config.toml is the home it shares's, so its plugins are that home's.
    let homes: Vec<_> = setup.homes().iter().filter(|home| home.agent() == agent && !(codex && setup.shares(home.path(), "config.toml"))).collect();
    let listed = if codex { repo.codex_plugins() } else { repo.plugins() };
    listed
        .iter()
        .filter_map(|plugin| {
            let id = plugin.id();
            let wanted = plugin.wanted_on(machine);
            let drift = homes.iter().find_map(|home| {
                let item = home.items().iter().find(|item| item.kind() == ItemKind::Plugin && item.name() == id);
                plugin_drift(place(item, codex), wanted)
            })?;
            let name = id.rsplit_once('@').map_or(id, |(name, _)| name).to_string();
            Some(BehindItem { kind: StandingKind::Plugin, key: format!("plugin:{}:{id}", if codex { "codex" } else { "claude" }), name, drift })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Every kind
// ---------------------------------------------------------------------------

fn registry_drift(state: RegistryState) -> ItemDrift {
    match state {
        RegistryState::Add => ItemDrift::Add,
        RegistryState::Extra => ItemDrift::Remove,
        _ => ItemDrift::Update,
    }
}

fn hook_drift(state: HookState) -> ItemDrift {
    match state {
        HookState::Add => ItemDrift::Add,
        HookState::Extra => ItemDrift::Remove,
        _ => ItemDrift::Update,
    }
}

/// Everything one machine is behind on, each item once, in kind order.
fn behind(repo: &SetupRepo, mcp: Option<&McpRegistry>, hooks: Option<&HookRegistry>, projects: &ProjectsDrift, machine: &str, setup: &MachineSetup) -> Vec<BehindItem> {
    let mut items = Vec::new();
    for item in file_items(repo, machine, setup) {
        // A hook script that differs puts the hooks that run it behind, since bringing them in line writes it.
        if item.kind == StandingKind::Hook {
            let running = hooks.map(|hooks| hooks.running(&item.name)).unwrap_or_default();
            items.extend(running.into_iter().map(|name| BehindItem { kind: StandingKind::Hook, key: format!("hook:repo:{name}"), name: name.to_string(), drift: ItemDrift::Update }));
        } else {
            items.push(item);
        }
    }
    if let Some(mcp) = mcp {
        items.extend(mcp.behind_on(machine, setup).map(|(name, state)| BehindItem { kind: StandingKind::Mcp, key: format!("mcp:{name}"), name: name.to_string(), drift: registry_drift(state) }));
    }
    if let Some(hooks) = hooks {
        items.extend(hooks.behind_on(machine).map(|(name, state)| BehindItem { kind: StandingKind::Hook, key: format!("hook:repo:{name}"), name: name.to_string(), drift: hook_drift(state) }));
    }
    items.extend(plugin_items(repo, machine, setup, false));
    items.extend(plugin_items(repo, machine, setup, true));
    items.extend(projects.behind_on(machine).into_iter().map(|project| BehindItem {
        kind: StandingKind::Project,
        key: format!("project:{project}"),
        name: project.strip_prefix("_local/").unwrap_or(project).to_string(),
        drift: ItemDrift::Update,
    }));
    let mut seen = BTreeSet::new();
    items.retain(|item| seen.insert(item.key.clone()));
    items.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.cmp(&b.name)));
    items
}

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
    }
    counts
}

/// Each machine Sync covers (`machines`: name, answering, last scan) against the repo and what was read with it.
fn standing(
    repo: SetupRepo,
    mcp: Result<McpRegistry, String>,
    hooks: Result<HookRegistry, String>,
    projects: &ProjectsDrift,
    machines: &[(String, bool, MachineSetup)],
) -> SyncStanding {
    let (mcp, mcp_error) = match mcp {
        Ok(registry) => (Some(registry), None),
        Err(error) => (None, Some(error)),
    };
    let (hooks, hooks_error) = match hooks {
        Ok(registry) => (Some(registry), None),
        Err(error) => (None, Some(error)),
    };
    let machines: Vec<MachineStanding> = machines
        .iter()
        .map(|(machine, reachable, setup)| {
            let read = setup.is_read();
            let items = if read { behind(&repo, mcp.as_ref(), hooks.as_ref(), projects, machine, setup) } else { Vec::new() };
            let state = match (read, *reachable, items.is_empty()) {
                (false, _, _) => MachineState::NotScanned,
                (true, false, _) => MachineState::Unreachable,
                (true, true, true) => MachineState::InStep,
                (true, true, false) => MachineState::Behind,
            };
            MachineStanding { machine: machine.clone(), state, reachable: *reachable, scanned_at: setup.scanned_at(), counts: counts(&items), behind: items }
        })
        .collect();
    let read = machines.iter().filter(|machine| machine.state != MachineState::NotScanned).count() as u32;
    let in_step = machines.iter().filter(|machine| machine.state == MachineState::InStep).count() as u32;
    SyncStanding { repo, mcp, mcp_error, hooks, hooks_error, machines, in_step, read }
}

/// Where every machine stands against the setup repo's last commit, from the machines' last scans, with the repo,
/// its MCP servers and hooks as they were read for it. Remembers `repo` as the one the window names.
#[tauri::command]
pub(crate) async fn get_sync_standing(state: tauri::State<'_, MachineHealthState>, repo: String) -> Result<SyncStanding, String> {
    state.lock().setup_repo = Some(repo.clone());
    let folder = Path::new(&repo);
    let found = read_repo(folder).await?;
    let scanned = scanned_machines(&state.lock());
    let (mcp, hooks) = tokio::join!(setup_mcp::registry_for(folder, &scanned), setup_hooks::registry_for(folder, &scanned));
    let inner = state.lock();
    let projects = drift(found.layers(), &arbor_machines(&inner), &inner.projects);
    let machines = covered_machines(&inner);
    drop(inner);
    Ok(standing(found, mcp, hooks, &projects, &machines))
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

    fn one(repo: SetupRepo, mcp: Option<McpRegistry>, hooks: Option<HookRegistry>, setup: MachineSetup) -> MachineStanding {
        let found = standing(repo, mcp.ok_or_else(|| "unread".to_string()), hooks.ok_or_else(|| "unread".to_string()), &no_projects(), &[("cam-mbp".into(), true, setup)]);
        found.machines.into_iter().next().unwrap()
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
        let found = standing(repo, Err("unread".into()), Ok(HookRegistry::default()), &no_projects(), &[
            ("a".into(), true, in_step),
            ("b".into(), false, behind.clone()),
            ("c".into(), true, MachineSetup::default()),
            ("d".into(), true, behind),
        ]);
        let states: Vec<_> = found.machines.iter().map(|machine| (machine.machine.as_str(), machine.state)).collect();
        assert_eq!(states, [("a", MachineState::InStep), ("b", MachineState::Unreachable), ("c", MachineState::NotScanned), ("d", MachineState::Behind)]);
        assert_eq!((found.in_step, found.read), (1, 3));
        assert_eq!(found.mcp_error.as_deref(), Some("unread"), "a registry that couldn't be read says why");
        assert_eq!(keys(&found.machines[1].behind), [("file:~/.claude/CLAUDE.md", ItemDrift::Add)], "an unanswering machine keeps what its last scan says");
    }
}

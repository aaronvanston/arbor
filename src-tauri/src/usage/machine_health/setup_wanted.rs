//! What each machine wants of the setup repo where it differs from every machine: a skill kept
//! off one machine, or a machine keeping its own copy of one. The repo's .agents/machines.json
//! holds it, beside mcp-servers.json, whose per-machine values work the same way:
//!
//! ```json
//! {"version": 1, "skills": {"pdf": {"machines": {"ci-01": "off", "cedar": "own"}}}}
//! ```
//!
//! A skill a machine doesn't name is wanted as the repo has it, the All machines value. Machines
//! are named as the Machines page names them and compare loosely, as everywhere in Arbor.
//!
//! A skill, or a plugin, can also have a value for a project (`"projects": {"owner/name": {"all": "off",
//! "machines": {"ci-01": "on"}}}`), on or off only, which each of the project's checkouts gets in
//! Claude Code's local scope, its git-ignored .claude/settings.local.json, winning over the machine's.
//! An MCP server's project values sit under `"mcp"` the same way (`{"mcp": {"linear": {"projects": …}}}`):
//! off denies it in each checkout's settings.local.json, on sets it up in Claude Code's local scope there.
//!
//! Plugins have no files in the repo to be the All machines value, so .agents/plugins.json lists
//! them, each with its value for every machine and the machines with their own, and the
//! marketplaces they come from, so a machine without one can add it:
//!
//! ```json
//! {"version": 1, "marketplaces": {"claude-plugins-official": "anthropics/claude-plugins-official"},
//!  "plugins": {"context7@claude-plugins-official": {"all": "on", "machines": {"ci-01": "off"}}}}
//! ```
//!
//! Only Claude Code's own plugin command changes a machine's plugins, through the plugin review,
//! and "off" turns a plugin off rather than removing it.
//!
//! Codex's plugins sit apart under `"codex"`, since its plugins and marketplaces aren't Claude Code's, with the
//! GitHub repositories of the marketplaces they come from, so a machine without one can add it. They have no
//! projects, and the Codex app's own (openai-bundled, openai-primary-runtime) are never listed:
//!
//! ```json
//! {"codex": {"marketplaces": {"my-tools": "acme/codex-tools"},
//!            "plugins": {"linear@my-tools": {"all": "on", "machines": {"ci-01": "removed"}}}}}
//! ```

use super::normalize_machine_name;
use super::setup_sync::{read_repo, take_into_repo, SetupRepo};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use ts_rs::TS;

pub(super) const MACHINES_FILE: &str = ".agents/machines.json";
pub(super) const PLUGINS_FILE: &str = ".agents/plugins.json";
const FILE_VERSION: u64 = 1;

/// A machine's own value for a skill.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SkillWanted {
    /// Kept off the machine: never added there, and a copy it has isn't the repo's to remove.
    Off,
    /// The machine keeps its own copy, which isn't replaced by the repo's.
    Own,
}

/// How a plugin is wanted on a machine.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PluginWanted {
    /// Installed and turned on.
    On,
    /// Turned off, or not installed.
    Off,
    /// Left as the machine has it. Only ever a machine's own value.
    Own,
    /// Uninstalled wherever it's found, and never installed. Never a project's value: a checkout can only turn on or
    /// off what its machine has.
    Removed,
}

/// A plugin the repo lists.
#[derive(Clone, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoPlugin {
    /// `name@marketplace`, as Claude Code names it.
    id: String,
    /// Its marketplace's GitHub repository, when the file gives one.
    source: Option<String>,
    /// The All machines value: on or off.
    all: PluginWanted,
    /// Machines with a value of their own, by normalized name.
    machines: BTreeMap<String, PluginWanted>,
    /// Projects with a value of their own, by lowercase `owner/name`: applied to each of the
    /// project's checkouts in Claude Code's local scope, which wins over the machine's.
    projects: BTreeMap<String, ProjectValue>,
}

/// A project's value for a plugin or a skill: on every machine, and on one (by normalized name), which wins.
/// Only on or off; a project without one follows its machine.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "RepoProjectValue")]
pub(crate) struct ProjectValue {
    all: Option<PluginWanted>,
    machines: BTreeMap<String, PluginWanted>,
}

impl ProjectValue {
    pub(super) fn set_all(&mut self, wanted: PluginWanted) {
        self.all = Some(wanted);
    }

    pub(super) fn set_machine(&mut self, machine: &str, wanted: PluginWanted) {
        self.machines.insert(machine.to_string(), wanted);
    }

    #[cfg(test)]
    pub(super) fn all(&self) -> Option<PluginWanted> {
        self.all
    }

    /// Lays `value` over this one: its values win, and this one's stand where it has none.
    pub(super) fn overlay(&mut self, value: ProjectValue) {
        if value.all.is_some() {
            self.all = value.all;
        }
        self.machines.extend(value.machines);
    }

    #[cfg(test)]
    pub(super) fn machine(&self, machine: &str) -> Option<PluginWanted> {
        self.machines.get(machine).copied()
    }
}

impl RepoPlugin {
    pub(super) fn id(&self) -> &str {
        &self.id
    }

    /// Sets a machine's own value (by normalized name), as a machine file in the repo gives it.
    pub(super) fn set_machine(&mut self, machine: &str, wanted: PluginWanted) {
        self.machines.insert(machine.to_string(), wanted);
    }

    /// Sets a project's values, as its project file gives them, over any .agents/plugins.json has.
    pub(super) fn set_project(&mut self, project: &str, value: ProjectValue) {
        self.projects.entry(project.to_string()).or_default().overlay(value);
    }

    #[cfg(test)]
    pub(super) fn machine_value(&self, machine: &str) -> Option<PluginWanted> {
        self.machines.get(machine).copied()
    }

    #[cfg(test)]
    pub(super) fn project_value(&self, project: &str) -> Option<&ProjectValue> {
        self.projects.get(project)
    }
}

/// Each skill's projects with a value of their own, by lowercase `owner/name`.
pub(super) type SkillProjects = BTreeMap<String, BTreeMap<String, ProjectValue>>;

/// The projects' values in an entry's `projects`, skipping what isn't one: a key that isn't `owner/name`, or a value
/// other than on or off.
fn project_values(entry: &Value) -> BTreeMap<String, ProjectValue> {
    let on_off = |value: &Value| serde_json::from_value::<PluginWanted>(value.clone()).ok().filter(|wanted| matches!(wanted, PluginWanted::On | PluginWanted::Off));
    entry
        .get("projects")
        .and_then(Value::as_object)
        .map(|projects| {
            projects
                .iter()
                .filter(|(project, _)| is_project(project))
                .filter_map(|(project, value)| {
                    let all = value.get("all").and_then(on_off);
                    let machines: BTreeMap<String, PluginWanted> = value
                        .get("machines")
                        .and_then(Value::as_object)
                        .map(|machines| {
                            machines
                                .iter()
                                .filter_map(|(machine, value)| Some((normalize_machine_name(machine), on_off(value)?)))
                                .filter(|(key, _)| !key.is_empty())
                                .collect()
                        })
                        .unwrap_or_default();
                    (all.is_some() || !machines.is_empty()).then(|| (project.to_ascii_lowercase(), ProjectValue { all, machines }))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Where .agents/machines.json keeps skills' values, and MCP servers' project values.
pub(super) const SKILLS_SECTION: &str = "skills";
pub(super) const MCP_SECTION: &str = "mcp";

/// The project values of the skills, or the MCP servers, in .agents/machines.json, skipping what isn't one, as `parse`
/// does.
pub(super) fn parse_projects(bytes: &[u8], section: &str) -> SkillProjects {
    let Ok(Value::Object(root)) = serde_json::from_slice::<Value>(bytes) else {
        return SkillProjects::new();
    };
    let Some(Value::Object(skills)) = root.get(section) else {
        return SkillProjects::new();
    };
    skills
        .iter()
        .filter(|(skill, _)| is_skill_name(skill))
        .filter_map(|(skill, entry)| {
            let projects = project_values(entry);
            (!projects.is_empty()).then(|| (skill.clone(), projects))
        })
        .collect()
}

/// Each skill's machines with a value of their own, by normalized machine name.
pub(super) type SkillMachines = BTreeMap<String, BTreeMap<String, SkillWanted>>;

/// The skills' per-machine values in `bytes`, skipping what isn't one, so a hand edit Arbor can't
/// read leaves every machine on the repo's value rather than failing the whole repo.
pub(super) fn parse(bytes: &[u8]) -> SkillMachines {
    parse_machines(bytes, SKILLS_SECTION)
}

/// The rules', subagents' and commands' per-machine values, by the path the scan names them by (~/.claude/agents/x.md).
pub(super) fn parse_file_machines(bytes: &[u8]) -> SkillMachines {
    parse_machines(bytes, FILES_SECTION)
        .into_iter()
        .filter(|(rel, _)| removable_file(rel))
        .map(|(rel, machines)| (format!("~/{rel}"), machines))
        .collect()
}

/// Each name's machines with a value of their own in `section`, as `parse` reads skills'.
fn parse_machines(bytes: &[u8], section: &str) -> SkillMachines {
    let Ok(Value::Object(root)) = serde_json::from_slice::<Value>(bytes) else {
        return SkillMachines::new();
    };
    let Some(Value::Object(skills)) = root.get(section) else {
        return SkillMachines::new();
    };
    skills
        .iter()
        .filter_map(|(skill, entry)| {
            let machines = entry.get("machines")?.as_object()?;
            let wanted: BTreeMap<String, SkillWanted> = machines
                .iter()
                .filter_map(|(machine, value)| {
                    let wanted = serde_json::from_value::<SkillWanted>(value.clone()).ok()?;
                    let key = normalize_machine_name(machine);
                    (!key.is_empty()).then_some((key, wanted))
                })
                .collect();
            (!wanted.is_empty()).then(|| (skill.clone(), wanted))
        })
        .collect()
}

/// Skills the repo has taken off every machine, `"all": "removed"` in their entry: their folders are gone from the
/// repo, and each machine's copy in its store is the repo's to remove.
pub(super) fn parse_removed(bytes: &[u8]) -> Vec<String> {
    let Ok(Value::Object(root)) = serde_json::from_slice::<Value>(bytes) else {
        return Vec::new();
    };
    let Some(Value::Object(skills)) = root.get(SKILLS_SECTION) else {
        return Vec::new();
    };
    skills
        .iter()
        .filter(|(skill, entry)| is_skill_name(skill) && entry.get("all").and_then(Value::as_str) == Some("removed"))
        .map(|(skill, _)| skill.clone())
        .collect()
}

/// Skills turned off on every machine, `"all": "off"` in their entry: the repo keeps their folders, and each machine's
/// copy in its store is the repo's to take out until they're turned on again.
pub(super) fn parse_off(bytes: &[u8]) -> Vec<String> {
    marked(bytes, SKILLS_SECTION, "off").into_iter().filter(|skill| is_skill_name(skill)).collect()
}

/// The rules, subagents and commands turned off on every machine, as the scan names them (~/.claude/agents/old.md).
pub(super) fn parse_off_files(bytes: &[u8]) -> Vec<String> {
    marked(bytes, FILES_SECTION, "off").into_iter().filter(|rel| removable_file(rel)).map(|rel| format!("~/{rel}")).collect()
}

/// The names in `section` whose every-machine value (`"all"`) is `mark`.
fn marked(bytes: &[u8], section: &str, mark: &str) -> Vec<String> {
    let Ok(Value::Object(root)) = serde_json::from_slice::<Value>(bytes) else {
        return Vec::new();
    };
    let Some(Value::Object(names)) = root.get(section) else {
        return Vec::new();
    };
    names.iter().filter(|(_, entry)| entry.get("all").and_then(Value::as_str) == Some(mark)).map(|(name, _)| name.clone()).collect()
}

/// `text` with `skill` turned off on every machine, or on again, keeping whatever else the file holds.
pub(super) fn with_skill_off(text: Option<&[u8]>, skill: &str, off: bool) -> Result<String, String> {
    with_all_mark(text, SKILLS_SECTION, skill, off.then_some("off"))
}

/// `text` with the file at `rel` turned off on every machine, or on again, keeping the rest.
pub(super) fn with_file_off(text: Option<&[u8]>, rel: &str, off: bool) -> Result<String, String> {
    with_all_mark(text, FILES_SECTION, rel, off.then_some("off"))
}

/// `text` with `skill` marked removed from every machine, or the mark taken out, keeping whatever else the file holds.
pub(super) fn with_skill_removed(text: Option<&[u8]>, skill: &str, removed: bool) -> Result<String, String> {
    with_removed_mark(text, SKILLS_SECTION, skill, removed)
}

/// Where .agents/machines.json marks the rules, subagents and commands the repo has taken off every machine, by their
/// path in the home folder: `{"files": {".claude/agents/old.md": {"all": "removed"}}}`.
pub(super) const FILES_SECTION: &str = "files";

/// A synced file that can be removed from every machine: a rule, subagent or command. Instructions are every agent's
/// own, so they're changed rather than taken away.
pub(super) fn removable_file(rel: &str) -> bool {
    matches!(super::setup_sync::managed(rel), Some(kind) if kind != super::setup_sync::SyncFileKind::Instructions)
}

/// The files the repo has taken off every machine, as the scan names them (~/.claude/agents/old.md).
pub(super) fn parse_removed_files(bytes: &[u8]) -> Vec<String> {
    let Ok(Value::Object(root)) = serde_json::from_slice::<Value>(bytes) else {
        return Vec::new();
    };
    let Some(Value::Object(files)) = root.get(FILES_SECTION) else {
        return Vec::new();
    };
    files
        .iter()
        .filter(|(rel, entry)| removable_file(rel) && entry.get("all").and_then(Value::as_str) == Some("removed"))
        .map(|(rel, _)| format!("~/{rel}"))
        .collect()
}

/// `text` with the file at `rel` marked removed from every machine, or the mark taken out, keeping the rest.
pub(super) fn with_file_removed(text: Option<&[u8]>, rel: &str, removed: bool) -> Result<String, String> {
    with_removed_mark(text, FILES_SECTION, rel, removed)
}

/// `text` with `name` in `section` marked removed from every machine, or the mark taken out, keeping whatever else the
/// file holds. A machine's own values for it stay, so one keeping its own copy still keeps it.
fn with_removed_mark(text: Option<&[u8]>, section: &str, name: &str, removed: bool) -> Result<String, String> {
    with_all_mark(text, section, name, removed.then_some("removed"))
}

/// `text` with `name`'s every-machine value in `section` set to `mark` (removed or off), or taken out for as the repo
/// has it, keeping the machines' own values and whatever else the file holds.
fn with_all_mark(text: Option<&[u8]>, section: &str, name: &str, mark: Option<&str>) -> Result<String, String> {
    let unreadable = || format!("{MACHINES_FILE} isn't JSON Arbor can read. Fix it, then try again.");
    let mut file = match text {
        Some(bytes) => serde_json::from_slice::<Value>(bytes).ok().filter(Value::is_object).ok_or_else(unreadable)?,
        None => serde_json::json!({ "version": FILE_VERSION }),
    };
    let root = file.as_object_mut().ok_or_else(unreadable)?;
    root.entry("version").or_insert(Value::from(FILE_VERSION));
    let names = object_at(root, section);
    let entry = object_at(names, name);
    if let Some(mark) = mark {
        entry.insert("all".into(), Value::from(mark));
    } else {
        entry.remove("all");
    }
    if entry.is_empty() {
        names.remove(name);
    }
    if names.is_empty() {
        root.remove(section);
    }
    Ok(serde_json::to_string_pretty(&file).map_err(|error| error.to_string())? + "\n")
}

/// The plugins `bytes` lists, skipping what isn't one, as `parse` does for skills.
pub(super) fn parse_plugins(bytes: &[u8]) -> Vec<RepoPlugin> {
    let Ok(root) = serde_json::from_slice::<Value>(bytes) else {
        return Vec::new();
    };
    let sources = marketplace_sources(&root);
    let Some(Value::Object(plugins)) = root.get("plugins") else {
        return Vec::new();
    };
    plugins
        .iter()
        .filter(|(id, _)| is_plugin_id(id))
        .filter_map(|(id, entry)| {
            let (all, machines) = plugin_values(entry)?;
            let projects = project_values(entry);
            let marketplace = id.rsplit_once('@').map(|(_, marketplace)| marketplace).unwrap_or_default();
            Some(RepoPlugin { id: id.clone(), source: sources.get(marketplace).map(|source| source.to_string()), all, machines, projects })
        })
        .collect()
}

/// The GitHub repository of each marketplace in a section's `marketplaces`, skipping any other source.
fn marketplace_sources(section: &Value) -> BTreeMap<String, String> {
    section
        .get("marketplaces")
        .and_then(Value::as_object)
        .map(|found| found.iter().filter_map(|(name, source)| Some((name.clone(), source.as_str()?.to_string()))).filter(|(_, source)| is_github(source)).collect())
        .unwrap_or_default()
}

/// A listed plugin's All machines value, which is never "own", and the machines' own, skipping what isn't one.
fn plugin_values(entry: &Value) -> Option<(PluginWanted, BTreeMap<String, PluginWanted>)> {
    let all = serde_json::from_value::<PluginWanted>(entry.get("all")?.clone()).ok().filter(|all| *all != PluginWanted::Own)?;
    let machines = entry
        .get("machines")
        .and_then(Value::as_object)
        .map(|machines| {
            machines
                .iter()
                .filter_map(|(machine, value)| {
                    let wanted = serde_json::from_value::<PluginWanted>(value.clone()).ok()?;
                    let key = normalize_machine_name(machine);
                    (!key.is_empty()).then_some((key, wanted))
                })
                .collect()
        })
        .unwrap_or_default();
    Some((all, machines))
}

/// The Codex plugins `bytes` lists under `codex`, skipping what isn't one and the Codex app's own.
pub(super) fn parse_codex_plugins(bytes: &[u8]) -> Vec<RepoPlugin> {
    let Ok(root) = serde_json::from_slice::<Value>(bytes) else {
        return Vec::new();
    };
    let Some(codex) = root.get("codex") else {
        return Vec::new();
    };
    let sources = marketplace_sources(codex);
    let Some(Value::Object(plugins)) = codex.get("plugins") else {
        return Vec::new();
    };
    plugins
        .iter()
        .filter(|(id, _)| is_codex_plugin_id(id))
        .filter_map(|(id, entry)| {
            let (all, machines) = plugin_values(entry)?;
            let marketplace = id.rsplit_once('@').map(|(_, marketplace)| marketplace).unwrap_or_default();
            Some(RepoPlugin { id: id.clone(), source: sources.get(marketplace).map(|source| source.to_string()), all, machines, projects: BTreeMap::new() })
        })
        .collect()
}

/// A JSON object at `key` in `parent`, made one if it's missing or something else.
fn object_at<'a>(parent: &'a mut serde_json::Map<String, Value>, key: &str) -> &'a mut serde_json::Map<String, Value> {
    let slot = parent.entry(key).or_insert_with(|| serde_json::json!({}));
    if !slot.is_object() {
        *slot = serde_json::json!({});
    }
    match slot {
        Value::Object(map) => map,
        // Made an object just above.
        _ => unreachable!(),
    }
}

/// `text` with `plugin`'s All machines value set (`machine` None) or a machine's, or taken out with `wanted` None: the
/// whole plugin for All machines, only the machine's own value otherwise. `source` records its marketplace's
/// repository when the file hasn't one.
fn with_plugin(text: Option<&[u8]>, plugin: &str, source: Option<&str>, machine: Option<&str>, wanted: Option<PluginWanted>) -> Result<String, String> {
    let unreadable = || format!("{PLUGINS_FILE} isn't JSON Arbor can read. Fix it, then try again.");
    let mut file = match text {
        Some(bytes) => serde_json::from_slice::<Value>(bytes).ok().filter(Value::is_object).ok_or_else(unreadable)?,
        None => serde_json::json!({ "version": FILE_VERSION }),
    };
    let root = file.as_object_mut().ok_or_else(unreadable)?;
    root.entry("version").or_insert(Value::from(FILE_VERSION));
    set_plugin_value(object_at(root, "plugins"), plugin, machine, wanted)?;
    keep_marketplace(root, plugin, source);
    Ok(serde_json::to_string_pretty(&file).map_err(|error| error.to_string())? + "\n")
}

/// Sets `plugin`'s All machines value in `plugins` (`machine` None) or a machine's, or takes it out with `wanted` None:
/// the whole plugin for All machines, only the machine's own value otherwise.
fn set_plugin_value(plugins: &mut serde_json::Map<String, Value>, plugin: &str, machine: Option<&str>, wanted: Option<PluginWanted>) -> Result<(), String> {
    match (machine, wanted) {
        (None, Some(PluginWanted::Own)) => return Err("Every machine can't keep its own; take the plugin out of the repo instead".into()),
        (None, Some(all)) => {
            object_at(plugins, plugin).insert("all".into(), serde_json::to_value(all).map_err(|error| error.to_string())?);
        }
        (None, None) => {
            plugins.remove(plugin);
        }
        (Some(machine), wanted) => {
            let entry = plugins.get_mut(plugin).and_then(Value::as_object_mut).ok_or("The repo doesn't list that plugin yet. Add it for All machines first.")?;
            let machines = object_at(entry, "machines");
            // Whatever spelling the file already uses for the machine is the one kept.
            let key = normalize_machine_name(machine);
            let listed = machines.keys().find(|listed| normalize_machine_name(listed) == key).cloned();
            match wanted {
                Some(wanted) => {
                    machines.insert(listed.unwrap_or_else(|| machine.to_string()), serde_json::to_value(wanted).map_err(|error| error.to_string())?);
                }
                None => {
                    if let Some(listed) = listed {
                        machines.remove(&listed);
                    }
                }
            }
            if machines.is_empty() {
                entry.remove("machines");
            }
        }
    }
    Ok(())
}

/// Records the repository of `plugin`'s marketplace in `section`'s `marketplaces` when it has none yet, and takes the
/// marketplace out once no plugin in `section` comes from it any more.
fn keep_marketplace(section: &mut serde_json::Map<String, Value>, plugin: &str, source: Option<&str>) {
    let marketplace = plugin.rsplit_once('@').map(|(_, marketplace)| marketplace.to_string()).unwrap_or_default();
    let used = section.get("plugins").and_then(Value::as_object).is_some_and(|plugins| plugins.keys().any(|id| id.rsplit_once('@').is_some_and(|(_, from)| from == marketplace)));
    let marketplaces = object_at(section, "marketplaces");
    match source {
        Some(source) if used && !marketplaces.contains_key(&marketplace) => {
            marketplaces.insert(marketplace, Value::from(source));
        }
        _ if !used => {
            marketplaces.remove(&marketplace);
        }
        _ => {}
    }
}

/// `text` with a Codex `plugin`'s All machines value set (`machine` None) or a machine's, or taken out with `wanted`
/// None, under `codex`, which goes with its last plugin. `source` records its marketplace's repository when the file
/// hasn't one. The rest of the file, Claude Code's plugins included, stays.
fn with_codex_plugin(text: Option<&[u8]>, plugin: &str, source: Option<&str>, machine: Option<&str>, wanted: Option<PluginWanted>) -> Result<String, String> {
    let unreadable = || format!("{PLUGINS_FILE} isn't JSON Arbor can read. Fix it, then try again.");
    let mut file = match text {
        Some(bytes) => serde_json::from_slice::<Value>(bytes).ok().filter(Value::is_object).ok_or_else(unreadable)?,
        None => serde_json::json!({ "version": FILE_VERSION }),
    };
    let root = file.as_object_mut().ok_or_else(unreadable)?;
    root.entry("version").or_insert(Value::from(FILE_VERSION));
    let codex = object_at(root, "codex");
    set_plugin_value(object_at(codex, "plugins"), plugin, machine, wanted)?;
    keep_marketplace(codex, plugin, source);
    for key in ["plugins", "marketplaces"] {
        if codex.get(key).and_then(Value::as_object).is_some_and(serde_json::Map::is_empty) {
            codex.remove(key);
        }
    }
    if codex.is_empty() {
        root.remove("codex");
    }
    Ok(serde_json::to_string_pretty(&file).map_err(|error| error.to_string())? + "\n")
}

/// `text` with `project`'s value for a listed `plugin` set, on every machine (`machine` None) or on one, or taken out
/// with `None`. Only on or off: a project without a value follows its machine.
fn with_plugin_project(text: Option<&[u8]>, plugin: &str, project: &str, machine: Option<&str>, wanted: Option<PluginWanted>) -> Result<String, String> {
    let unreadable = || format!("{PLUGINS_FILE} isn't JSON Arbor can read. Fix it, then try again.");
    if matches!(wanted, Some(PluginWanted::Own | PluginWanted::Removed)) {
        return Err("A project either turns a plugin on or off; without a value it follows its machine".into());
    }
    let mut file = text.and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok()).filter(Value::is_object).ok_or_else(unreadable)?;
    let root = file.as_object_mut().ok_or_else(unreadable)?;
    let entry = root
        .get_mut("plugins")
        .and_then(Value::as_object_mut)
        .and_then(|plugins| plugins.get_mut(plugin))
        .and_then(Value::as_object_mut)
        .ok_or("The repo doesn't list that plugin yet. Add it for All machines first.")?;
    set_project_value(entry, project, machine, wanted)?;
    Ok(serde_json::to_string_pretty(&file).map_err(|error| error.to_string())? + "\n")
}

/// Sets `project`'s value in an entry's `projects`, on every machine (`machine` None) or on one, or takes it out with
/// `None`, dropping whatever that leaves empty. Whatever spelling the file already uses for the project, and the
/// machine, is the one kept.
fn set_project_value(entry: &mut serde_json::Map<String, Value>, project: &str, machine: Option<&str>, wanted: Option<PluginWanted>) -> Result<(), String> {
    if matches!(wanted, Some(PluginWanted::Own | PluginWanted::Removed)) {
        return Err("A project either turns it on or off; without a value it follows its machine".into());
    }
    let projects = object_at(entry, "projects");
    let listed = projects.keys().find(|listed| listed.eq_ignore_ascii_case(project)).cloned().unwrap_or_else(|| project.to_ascii_lowercase());
    let own = object_at(projects, &listed);
    match (machine, wanted) {
        (None, Some(wanted)) => {
            own.insert("all".into(), serde_json::to_value(wanted).map_err(|error| error.to_string())?);
        }
        (None, None) => {
            own.remove("all");
        }
        (Some(machine), wanted) => {
            let machines = object_at(own, "machines");
            let key = normalize_machine_name(machine);
            let named = machines.keys().find(|named| normalize_machine_name(named) == key).cloned();
            match wanted {
                Some(wanted) => {
                    machines.insert(named.unwrap_or_else(|| machine.to_string()), serde_json::to_value(wanted).map_err(|error| error.to_string())?);
                }
                None => {
                    if let Some(named) = named {
                        machines.remove(&named);
                    }
                }
            }
            if machines.is_empty() {
                own.remove("machines");
            }
        }
    }
    if own.is_empty() {
        projects.remove(&listed);
    }
    if projects.is_empty() {
        entry.remove("projects");
    }
    Ok(())
}

/// A project as the repo keys it: `owner/name`.
pub(super) fn is_project(project: &str) -> bool {
    project.len() <= 200 && is_github(project)
}

fn is_plugin_id(id: &str) -> bool {
    id.split_once('@').is_some_and(|(name, marketplace)| is_skill_name(name) && is_skill_name(marketplace) && !marketplace.contains('@'))
}

/// A Codex plugin the repo may list: `name@marketplace`, from a marketplace other than the Codex app's own.
fn is_codex_plugin_id(id: &str) -> bool {
    is_plugin_id(id) && id.rsplit_once('@').is_some_and(|(_, marketplace)| !super::setup_plugins::is_codex_own_marketplace(marketplace))
}

fn is_github(source: &str) -> bool {
    source.split_once('/').is_some_and(|(owner, name)| {
        !owner.is_empty() && owner.len() <= 39 && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !owner.starts_with('-')
            && !name.is_empty() && name.len() <= 100 && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) && !name.starts_with('.')
    })
}

/// `text` with `machine`'s value for `skill` set, or taken out with `None`, keeping whatever else
/// the file holds as it was.
fn with_skill_machine(text: Option<&[u8]>, skill: &str, machine: &str, wanted: Option<SkillWanted>) -> Result<String, String> {
    with_machine_value(text, SKILLS_SECTION, skill, machine, wanted)
}

/// `text` with `machine`'s value for `name` in `section` set, or taken out with `None`, as `with_skill_machine` does.
fn with_machine_value(text: Option<&[u8]>, section: &str, skill: &str, machine: &str, wanted: Option<SkillWanted>) -> Result<String, String> {
    let unreadable = || format!("{MACHINES_FILE} isn't JSON Arbor can read. Fix it, then try again.");
    let mut file = match text {
        Some(bytes) => serde_json::from_slice::<Value>(bytes).ok().filter(Value::is_object).ok_or_else(unreadable)?,
        None => serde_json::json!({ "version": FILE_VERSION }),
    };
    let root = file.as_object_mut().ok_or_else(unreadable)?;
    root.entry("version").or_insert(Value::from(FILE_VERSION));
    let skills = root.entry(section).or_insert_with(|| serde_json::json!({}));
    if !skills.is_object() {
        *skills = serde_json::json!({});
    }
    let skills = skills.as_object_mut().ok_or_else(unreadable)?;
    let entry = skills.entry(skill).or_insert_with(|| serde_json::json!({}));
    if !entry.is_object() {
        *entry = serde_json::json!({});
    }
    let entry = entry.as_object_mut().ok_or_else(unreadable)?;
    let machines = entry.entry("machines").or_insert_with(|| serde_json::json!({}));
    if !machines.is_object() {
        *machines = serde_json::json!({});
    }
    let machines = machines.as_object_mut().ok_or_else(unreadable)?;
    // Whatever spelling the file already uses for the machine is the one kept.
    let key = normalize_machine_name(machine);
    let listed = machines.keys().find(|listed| normalize_machine_name(listed) == key).cloned();
    match wanted {
        Some(wanted) => {
            machines.insert(listed.unwrap_or_else(|| machine.to_string()), serde_json::to_value(wanted).map_err(|error| error.to_string())?);
        }
        None => {
            if let Some(listed) = listed {
                machines.remove(&listed);
            }
        }
    }
    if machines.is_empty() {
        entry.remove("machines");
    }
    if entry.is_empty() {
        skills.remove(skill);
    }
    Ok(serde_json::to_string_pretty(&file).map_err(|error| error.to_string())? + "\n")
}

pub(super) fn is_skill_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128 && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) && !name.starts_with('.')
}

/// Gives `machine` its own value for the rule, subagent or command at `path` (~/.claude/agents/x.md): kept off it, or
/// its own copy kept; with `None` it's back on every machine's. Commits .agents/machines.json alone.
#[tauri::command]
pub(crate) async fn set_setup_file_machine(repo: String, path: String, machine: String, wanted: Option<SkillWanted>) -> Result<SetupRepo, String> {
    let rel = path.strip_prefix("~/").filter(|rel| removable_file(rel)).ok_or_else(|| format!("Arbor doesn't keep {path} off a machine"))?;
    if normalize_machine_name(&machine).is_empty() {
        return Err("That machine has no name to keep it under".into());
    }
    let folder = Path::new(&repo);
    let text = match fs::read(folder.join(MACHINES_FILE)) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Arbor couldn't read {MACHINES_FILE}: {error}")),
    };
    let next = with_machine_value(text.as_deref(), FILES_SECTION, rel, &machine, wanted)?;
    let message = match wanted {
        Some(SkillWanted::Off) => format!("Keep {path} off {machine}"),
        Some(SkillWanted::Own) => format!("Let {machine} keep its own {path}"),
        None => format!("Give {machine} the repo's {path}"),
    };
    take_into_repo(folder, MACHINES_FILE, next.as_bytes(), &message, &[]).await?;
    read_repo(folder).await
}

/// Gives `machine` its own value for `skill` in the repo, or with `None` puts it back on every
/// machine's, and commits .agents/machines.json alone.
#[tauri::command]
pub(crate) async fn set_setup_skill_machine(repo: String, skill: String, machine: String, wanted: Option<SkillWanted>) -> Result<SetupRepo, String> {
    if !is_skill_name(&skill) {
        return Err("That isn't a skill's name".into());
    }
    if normalize_machine_name(&machine).is_empty() {
        return Err("That machine has no name to keep it under".into());
    }
    let folder = Path::new(&repo);
    let path = folder.join(MACHINES_FILE);
    let text = match fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Arbor couldn't read {MACHINES_FILE}: {error}")),
    };
    let next = with_skill_machine(text.as_deref(), &skill, &machine, wanted)?;
    let message = match wanted {
        Some(SkillWanted::Off) => format!("Keep skill {skill} off {machine}"),
        Some(SkillWanted::Own) => format!("Let {machine} keep its own skill {skill}"),
        None => format!("Give {machine} the repo's skill {skill}"),
    };
    take_into_repo(folder, MACHINES_FILE, next.as_bytes(), &message, &[]).await?;
    read_repo(folder).await
}

/// `text` with `project`'s value for `skill` set, on every machine (`machine` None) or on one, or taken out with
/// `None`, keeping whatever else the file holds as it was.
fn with_skill_project(text: Option<&[u8]>, skill: &str, project: &str, machine: Option<&str>, wanted: Option<PluginWanted>) -> Result<String, String> {
    with_project_value(text, SKILLS_SECTION, skill, project, machine, wanted)
}

/// `text` with `project`'s value for `name` in `section` (skills or MCP servers) set, as `with_skill_project` does.
fn with_project_value(text: Option<&[u8]>, section: &str, name: &str, project: &str, machine: Option<&str>, wanted: Option<PluginWanted>) -> Result<String, String> {
    let unreadable = || format!("{MACHINES_FILE} isn't JSON Arbor can read. Fix it, then try again.");
    let mut file = match text {
        Some(bytes) => serde_json::from_slice::<Value>(bytes).ok().filter(Value::is_object).ok_or_else(unreadable)?,
        None => serde_json::json!({ "version": FILE_VERSION }),
    };
    let root = file.as_object_mut().ok_or_else(unreadable)?;
    root.entry("version").or_insert(Value::from(FILE_VERSION));
    let names = object_at(root, section);
    let entry = object_at(names, name);
    set_project_value(entry, project, machine, wanted)?;
    if entry.is_empty() {
        names.remove(name);
    }
    if names.is_empty() {
        root.remove(section);
    }
    Ok(serde_json::to_string_pretty(&file).map_err(|error| error.to_string())? + "\n")
}

/// Gives `project` a value for `skill` on every machine or on one, or with `wanted` None lets it follow its machine,
/// and commits .agents/machines.json alone.
#[tauri::command]
pub(crate) async fn set_setup_skill_project(repo: String, skill: String, project: String, machine: Option<String>, wanted: Option<PluginWanted>) -> Result<SetupRepo, String> {
    if !is_skill_name(&skill) {
        return Err("That isn't a skill's name".into());
    }
    if !is_project(&project) {
        return Err("That isn't a project Arbor knows".into());
    }
    if machine.as_deref().is_some_and(|machine| normalize_machine_name(machine).is_empty()) {
        return Err("That machine has no name to keep it under".into());
    }
    let folder = Path::new(&repo);
    let text = match fs::read(folder.join(MACHINES_FILE)) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Arbor couldn't read {MACHINES_FILE}: {error}")),
    };
    let next = with_skill_project(text.as_deref(), &skill, &project, machine.as_deref(), wanted)?;
    let place = match &machine {
        Some(machine) => format!("{project} on {machine}"),
        None => project.clone(),
    };
    let message = match wanted {
        Some(PluginWanted::On) => format!("Turn skill {skill} on in {place}"),
        Some(_) => format!("Turn skill {skill} off in {place}"),
        None => format!("Let {place} follow its machine for skill {skill}"),
    };
    take_into_repo(folder, MACHINES_FILE, next.as_bytes(), &message, &[]).await?;
    read_repo(folder).await
}

/// Gives `project` a value for MCP server `server` on every machine or on one, or with `wanted` None lets it follow its
/// machine, and commits .agents/machines.json alone. Off denies the server in each checkout; on sets it up there.
#[tauri::command]
pub(crate) async fn set_setup_mcp_project(repo: String, server: String, project: String, machine: Option<String>, wanted: Option<PluginWanted>) -> Result<SetupRepo, String> {
    if !is_skill_name(&server) {
        return Err("That isn't an MCP server's name".into());
    }
    if !is_project(&project) {
        return Err("That isn't a project Arbor knows".into());
    }
    if machine.as_deref().is_some_and(|machine| normalize_machine_name(machine).is_empty()) {
        return Err("That machine has no name to keep it under".into());
    }
    let folder = Path::new(&repo);
    let text = match fs::read(folder.join(MACHINES_FILE)) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Arbor couldn't read {MACHINES_FILE}: {error}")),
    };
    let next = with_project_value(text.as_deref(), MCP_SECTION, &server, &project, machine.as_deref(), wanted)?;
    let place = match &machine {
        Some(machine) => format!("{project} on {machine}"),
        None => project.clone(),
    };
    let message = match wanted {
        Some(PluginWanted::On) => format!("Turn MCP server {server} on in {place}"),
        Some(_) => format!("Turn MCP server {server} off in {place}"),
        None => format!("Let {place} follow its machine for MCP server {server}"),
    };
    take_into_repo(folder, MACHINES_FILE, next.as_bytes(), &message, &[]).await?;
    read_repo(folder).await
}

/// Lists `plugin` in the repo with a value for All machines, gives `machine` its own, or with `wanted` None takes the
/// machine's own value out (or the plugin, for All machines), and commits .agents/plugins.json alone.
#[tauri::command]
pub(crate) async fn set_setup_plugin(repo: String, plugin: String, source: Option<String>, project: Option<String>, machine: Option<String>, wanted: Option<PluginWanted>) -> Result<SetupRepo, String> {
    if !is_plugin_id(&plugin) {
        return Err("That isn't a plugin's name".into());
    }
    if source.as_deref().is_some_and(|source| !is_github(source)) {
        return Err("A marketplace's source has to be a GitHub repository, owner/name".into());
    }
    if machine.as_deref().is_some_and(|machine| normalize_machine_name(machine).is_empty()) {
        return Err("That machine has no name to keep it under".into());
    }
    let folder = Path::new(&repo);
    let path = folder.join(PLUGINS_FILE);
    let text = match fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Arbor couldn't read {PLUGINS_FILE}: {error}")),
    };
    if let Some(project) = project.as_deref() {
        if !is_project(project) {
            return Err("That project has no owner/name to keep it under".into());
        }
        let next = with_plugin_project(text.as_deref(), &plugin, project, machine.as_deref(), wanted)?;
        let place = machine.as_deref().map_or_else(|| project.to_string(), |machine| format!("{project} on {machine}"));
        let message = match wanted {
            Some(PluginWanted::On) => format!("Turn plugin {plugin} on in {place}"),
            Some(_) => format!("Turn plugin {plugin} off in {place}"),
            None => format!("Let {place} follow its machine for plugin {plugin}"),
        };
        take_into_repo(folder, PLUGINS_FILE, next.as_bytes(), &message, &[]).await?;
        return read_repo(folder).await;
    }
    let next = with_plugin(text.as_deref(), &plugin, source.as_deref(), machine.as_deref(), wanted)?;
    let message = match (machine.as_deref(), wanted) {
        (None, Some(PluginWanted::On)) => format!("Turn plugin {plugin} on for all machines"),
        (None, Some(PluginWanted::Removed)) => format!("Remove plugin {plugin} from all machines"),
        (None, Some(_)) => format!("Turn plugin {plugin} off for all machines"),
        (None, None) => format!("Stop listing plugin {plugin}"),
        (Some(machine), Some(PluginWanted::On)) => format!("Turn plugin {plugin} on for {machine}"),
        (Some(machine), Some(PluginWanted::Off)) => format!("Turn plugin {plugin} off for {machine}"),
        (Some(machine), Some(PluginWanted::Own)) => format!("Let {machine} keep its own plugin {plugin}"),
        (Some(machine), Some(PluginWanted::Removed)) => format!("Remove plugin {plugin} from {machine}"),
        (Some(machine), None) => format!("Give {machine} every machine's plugin {plugin}"),
    };
    take_into_repo(folder, PLUGINS_FILE, next.as_bytes(), &message, &[]).await?;
    read_repo(folder).await
}

/// Lists a Codex `plugin` in the repo with a value for All machines, gives `machine` its own, or with `wanted` None
/// takes the machine's own value out (or the plugin, for All machines), and commits .agents/plugins.json alone.
#[tauri::command]
pub(crate) async fn set_setup_codex_plugin(repo: String, plugin: String, source: Option<String>, machine: Option<String>, wanted: Option<PluginWanted>) -> Result<SetupRepo, String> {
    if !is_plugin_id(&plugin) {
        return Err("That isn't a plugin's name".into());
    }
    if source.as_deref().is_some_and(|source| !is_github(source)) {
        return Err("A marketplace's source has to be a GitHub repository, owner/name".into());
    }
    if !is_codex_plugin_id(&plugin) {
        return Err("The Codex app keeps that plugin itself, so the repo doesn't list it".into());
    }
    if machine.as_deref().is_some_and(|machine| normalize_machine_name(machine).is_empty()) {
        return Err("That machine has no name to keep it under".into());
    }
    let folder = Path::new(&repo);
    let path = folder.join(PLUGINS_FILE);
    let text = match fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Arbor couldn't read {PLUGINS_FILE}: {error}")),
    };
    let next = with_codex_plugin(text.as_deref(), &plugin, source.as_deref(), machine.as_deref(), wanted)?;
    let message = match (machine.as_deref(), wanted) {
        (None, Some(PluginWanted::On)) => format!("Turn Codex plugin {plugin} on for all machines"),
        (None, Some(PluginWanted::Removed)) => format!("Remove Codex plugin {plugin} from all machines"),
        (None, Some(_)) => format!("Turn Codex plugin {plugin} off for all machines"),
        (None, None) => format!("Stop listing Codex plugin {plugin}"),
        (Some(machine), Some(PluginWanted::On)) => format!("Turn Codex plugin {plugin} on for {machine}"),
        (Some(machine), Some(PluginWanted::Off)) => format!("Turn Codex plugin {plugin} off for {machine}"),
        (Some(machine), Some(PluginWanted::Own)) => format!("Let {machine} keep its own Codex plugin {plugin}"),
        (Some(machine), Some(PluginWanted::Removed)) => format!("Remove Codex plugin {plugin} from {machine}"),
        (Some(machine), None) => format!("Give {machine} every machine's Codex plugin {plugin}"),
    };
    take_into_repo(folder, PLUGINS_FILE, next.as_bytes(), &message, &[]).await?;
    read_repo(folder).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machines_compare_loosely_and_junk_is_skipped() {
        let parsed = parse(br#"{"version":1,"skills":{"pdf":{"machines":{"CI 01":"off","cedar":"own","lab":"maybe"}},"x":7}}"#);
        assert_eq!(parsed.get("pdf").and_then(|machines| machines.get("ci01")), Some(&SkillWanted::Off));
        assert_eq!(parsed.get("pdf").and_then(|machines| machines.get("cedar")), Some(&SkillWanted::Own));
        assert_eq!(parsed.get("pdf").map(BTreeMap::len), Some(2));
        assert!(!parsed.contains_key("x"));
        assert!(parse(b"not json").is_empty());
    }

    #[test]
    fn setting_and_clearing_keeps_the_rest_of_the_file() {
        let start = br#"{"version":1,"skills":{"pdf":{"machines":{"CI 01":"off"}}},"note":"kept"}"#;
        let set = with_skill_machine(Some(start), "pdf", "cedar", Some(SkillWanted::Own)).unwrap();
        let value: Value = serde_json::from_str(&set).unwrap();
        assert_eq!(value["skills"]["pdf"]["machines"]["cedar"], "own");
        assert_eq!(value["note"], "kept");
        // The file's own spelling of a machine is the one changed.
        let cleared = with_skill_machine(Some(set.as_bytes()), "pdf", "ci-01", None).unwrap();
        let cleared = with_skill_machine(Some(cleared.as_bytes()), "pdf", "cedar", None).unwrap();
        let value: Value = serde_json::from_str(&cleared).unwrap();
        assert!(value["skills"].as_object().unwrap().is_empty());
        let fresh = with_skill_machine(None, "pdf", "ci-01", Some(SkillWanted::Off)).unwrap();
        assert_eq!(parse(fresh.as_bytes()).get("pdf").and_then(|machines| machines.get("ci01")), Some(&SkillWanted::Off));
    }

    #[test]
    fn a_file_is_kept_off_a_machine_beside_its_removed_mark() {
        let marked = with_file_removed(None, ".claude/commands/old.md", true).unwrap();
        let off = with_machine_value(Some(marked.as_bytes()), FILES_SECTION, ".claude/agents/x.md", "CI 01", Some(SkillWanted::Off)).unwrap();
        let machines = parse_file_machines(off.as_bytes());
        assert_eq!(machines.get("~/.claude/agents/x.md").and_then(|found| found.get("ci01")), Some(&SkillWanted::Off));
        assert_eq!(parse_removed_files(off.as_bytes()), vec!["~/.claude/commands/old.md".to_string()]);
        // Skills' values are their own.
        assert!(parse(off.as_bytes()).is_empty());
        // What the repo doesn't sync is skipped.
        assert!(parse_file_machines(br#"{"files":{".claude/CLAUDE.md":{"machines":{"ci":"off"}}}}"#).is_empty());
    }

    #[test]
    fn a_skill_or_file_turned_off_everywhere_is_marked_apart_from_removed_and_turned_on_again() {
        let off = with_skill_off(Some(br#"{"version":1,"skills":{"pdf":{"machines":{"ci01":"own"}}}}"#), "pdf", true).unwrap();
        let value: Value = serde_json::from_str(&off).unwrap();
        assert_eq!(value["skills"]["pdf"], serde_json::json!({ "all": "off", "machines": { "ci01": "own" } }));
        assert_eq!(parse_off(off.as_bytes()), vec!["pdf".to_string()]);
        assert!(parse_removed(off.as_bytes()).is_empty(), "off isn't removed");
        let on = with_skill_off(Some(off.as_bytes()), "pdf", false).unwrap();
        assert!(parse_off(on.as_bytes()).is_empty());
        assert_eq!(serde_json::from_str::<Value>(&on).unwrap()["skills"]["pdf"], serde_json::json!({ "machines": { "ci01": "own" } }));
        let file = with_file_off(None, ".claude/commands/review.md", true).unwrap();
        assert_eq!(parse_off_files(file.as_bytes()), vec!["~/.claude/commands/review.md".to_string()]);
        assert!(parse_removed_files(file.as_bytes()).is_empty());
        // Instructions are every machine's own, so they're never off everywhere.
        assert!(parse_off_files(br#"{"files":{".claude/CLAUDE.md":{"all":"off"}}}"#).is_empty());
    }

    #[test]
    fn a_skill_removed_everywhere_is_marked_and_the_mark_taken_out() {
        let start = br#"{"version":1,"skills":{"pdf":{"machines":{"cedar":"own"}}},"note":"kept"}"#;
        let marked = with_skill_removed(Some(start), "pdf", true).unwrap();
        let value: Value = serde_json::from_str(&marked).unwrap();
        assert_eq!(value["skills"]["pdf"]["all"], "removed");
        assert_eq!(value["skills"]["pdf"]["machines"]["cedar"], "own", "a machine's own value stays");
        assert_eq!(value["note"], "kept");
        assert_eq!(parse_removed(marked.as_bytes()), vec!["pdf".to_string()]);
        // The machine's value still reads as it did.
        assert_eq!(parse(marked.as_bytes()).get("pdf").and_then(|machines| machines.get("cedar")), Some(&SkillWanted::Own));
        let fresh = with_skill_removed(None, "sketch", true).unwrap();
        assert_eq!(parse_removed(fresh.as_bytes()), vec!["sketch".to_string()]);
        let cleared = with_skill_removed(Some(fresh.as_bytes()), "sketch", false).unwrap();
        let value: Value = serde_json::from_str(&cleared).unwrap();
        assert!(value.get("skills").is_none(), "{cleared}");
        assert!(parse_removed(br#"{"skills":{"pdf":{"all":"off"},"../x":{"all":"removed"}}}"#).is_empty());
        assert!(with_skill_removed(Some(b"[1]"), "pdf", true).is_err());
    }

    #[test]
    fn plugins_parse_with_their_marketplace_and_skip_junk() {
        let parsed = parse_plugins(
            br#"{"version":1,"marketplaces":{"official":"anthropics/claude-plugins-official","bad":"https://x"},
                "plugins":{"context7@official":{"all":"on","machines":{"CI 01":"off","cedar":"own","lab":"maybe"}},
                "odd@bad":{"all":"off"},"mine":{"all":"on"},"own@official":{"all":"own"}}}"#,
        );
        assert_eq!(parsed.len(), 2);
        let context7 = parsed.iter().find(|plugin| plugin.id == "context7@official").unwrap();
        assert_eq!(context7.source.as_deref(), Some("anthropics/claude-plugins-official"));
        assert_eq!(context7.all, PluginWanted::On);
        assert_eq!(context7.machines.get("ci01"), Some(&PluginWanted::Off));
        assert_eq!(context7.machines.len(), 2);
        // A marketplace that isn't a GitHub repository gives no source.
        assert_eq!(parsed.iter().find(|plugin| plugin.id == "odd@bad").unwrap().source, None);
    }

    #[test]
    fn plugins_are_listed_changed_per_machine_and_taken_out() {
        let listed = with_plugin(None, "context7@official", Some("anthropics/claude-plugins-official"), None, Some(PluginWanted::On)).unwrap();
        let own = with_plugin(Some(listed.as_bytes()), "context7@official", None, Some("CI 01"), Some(PluginWanted::Off)).unwrap();
        let value: Value = serde_json::from_str(&own).unwrap();
        assert_eq!(value["marketplaces"]["official"], "anthropics/claude-plugins-official");
        assert_eq!(value["plugins"]["context7@official"]["machines"]["CI 01"], "off");
        // The file's own spelling of a machine is the one cleared.
        let cleared = with_plugin(Some(own.as_bytes()), "context7@official", None, Some("ci-01"), None).unwrap();
        let value: Value = serde_json::from_str(&cleared).unwrap();
        assert!(value["plugins"]["context7@official"].get("machines").is_none());
        assert!(with_plugin(Some(cleared.as_bytes()), "context7@official", None, None, Some(PluginWanted::Own)).is_err());
        assert!(with_plugin(Some(cleared.as_bytes()), "other@official", None, Some("cedar"), Some(PluginWanted::Off)).is_err());
        // Its marketplace goes with its last plugin.
        let gone = with_plugin(Some(cleared.as_bytes()), "context7@official", None, None, None).unwrap();
        let value: Value = serde_json::from_str(&gone).unwrap();
        assert!(value["plugins"].as_object().unwrap().is_empty());
        assert!(value["marketplaces"].as_object().unwrap().is_empty());
    }

    #[test]
    fn codex_plugins_sit_apart_from_claude_codes_and_never_include_the_apps_own() {
        let claude = with_plugin(None, "context7@official", Some("anthropics/claude-plugins-official"), None, Some(PluginWanted::On)).unwrap();
        let listed = with_codex_plugin(Some(claude.as_bytes()), "linear@my-tools", Some("acme/codex-tools"), None, Some(PluginWanted::On)).unwrap();
        let own = with_codex_plugin(Some(listed.as_bytes()), "linear@my-tools", None, Some("CI 01"), Some(PluginWanted::Removed)).unwrap();
        assert_eq!(parse_plugins(own.as_bytes()).len(), 1);
        let codex = parse_codex_plugins(own.as_bytes());
        assert_eq!(codex.len(), 1);
        assert_eq!((codex[0].id.as_str(), codex[0].all, codex[0].machines.get("ci01")), ("linear@my-tools", PluginWanted::On, Some(&PluginWanted::Removed)));
        assert_eq!(codex[0].source.as_deref(), Some("acme/codex-tools"));
        // Claude Code's marketplaces are its own: the Codex one isn't among them.
        assert!(serde_json::from_str::<Value>(&own).unwrap()["marketplaces"].get("my-tools").is_none());
        // The codex section goes with its last plugin, its marketplace with it, and Claude Code's plugins stay as they were.
        let gone = with_codex_plugin(Some(own.as_bytes()), "linear@my-tools", None, None, None).unwrap();
        let value: Value = serde_json::from_str(&gone).unwrap();
        assert!(value.get("codex").is_none());
        assert_eq!(value["plugins"]["context7@official"]["all"], "on");
        assert!(with_codex_plugin(Some(gone.as_bytes()), "linear@my-tools", None, Some("cedar"), Some(PluginWanted::Off)).is_err());
        let odd = parse_codex_plugins(br#"{"codex":{"plugins":{"browser@openai-bundled":{"all":"off"},"x@m":{"all":"own"},"y@m":{"all":"off"}}}}"#);
        assert_eq!(odd.iter().map(|plugin| plugin.id.as_str()).collect::<Vec<_>>(), ["y@m"]);
    }

    #[test]
    fn a_plugin_can_be_wanted_removed_everywhere_or_on_one_machine_but_never_by_a_project() {
        let removed = with_plugin(None, "agency@agency-skills", None, None, Some(PluginWanted::Removed)).unwrap();
        let value: Value = serde_json::from_str(&removed).unwrap();
        assert_eq!(value["plugins"]["agency@agency-skills"]["all"], "removed");
        let kept = with_plugin(Some(removed.as_bytes()), "agency@agency-skills", None, Some("cedar-air-01"), Some(PluginWanted::Own)).unwrap();
        let parsed = parse_plugins(kept.as_bytes());
        assert_eq!((parsed[0].all, parsed[0].machines.get("cedarair01")), (PluginWanted::Removed, Some(&PluginWanted::Own)));
        let on = with_plugin(None, "context7@official", None, None, Some(PluginWanted::On)).unwrap();
        let gone_here = with_plugin(Some(on.as_bytes()), "context7@official", None, Some("CI 01"), Some(PluginWanted::Removed)).unwrap();
        assert_eq!(parse_plugins(gone_here.as_bytes())[0].machines.get("ci01"), Some(&PluginWanted::Removed));
        assert!(with_plugin_project(Some(on.as_bytes()), "context7@official", "cam/arbor", None, Some(PluginWanted::Removed)).is_err());
        // A project value of "removed" in the file is skipped when read.
        let odd = parse_plugins(br#"{"plugins":{"x@m":{"all":"on","projects":{"a/b":{"all":"removed"}}}}}"#);
        assert!(odd[0].projects.is_empty());
    }

    #[test]
    fn a_project_turns_a_listed_plugin_on_or_off_everywhere_or_on_one_machine() {
        let listed = with_plugin(None, "context7@official", None, None, Some(PluginWanted::On)).unwrap();
        assert!(with_plugin_project(Some(listed.as_bytes()), "other@official", "cam/arbor", None, Some(PluginWanted::Off)).is_err(), "only a listed plugin");
        assert!(with_plugin_project(Some(listed.as_bytes()), "context7@official", "cam/arbor", None, Some(PluginWanted::Own)).is_err());
        let off = with_plugin_project(Some(listed.as_bytes()), "context7@official", "Cam/Arbor", None, Some(PluginWanted::Off)).unwrap();
        let on_ci = with_plugin_project(Some(off.as_bytes()), "context7@official", "cam/arbor", Some("CI 01"), Some(PluginWanted::On)).unwrap();
        let parsed = parse_plugins(on_ci.as_bytes());
        let project = &parsed[0].projects["cam/arbor"];
        assert_eq!((project.all, project.machines.get("ci01")), (Some(PluginWanted::Off), Some(&PluginWanted::On)));
        // Taking both values out takes the project out, and the plugin's projects with it.
        let cleared = with_plugin_project(Some(on_ci.as_bytes()), "context7@official", "cam/arbor", Some("ci-01"), None).unwrap();
        let cleared = with_plugin_project(Some(cleared.as_bytes()), "context7@official", "cam/arbor", None, None).unwrap();
        let value: Value = serde_json::from_str(&cleared).unwrap();
        assert!(value["plugins"]["context7@official"].get("projects").is_none());
        // A project value of "own", or a key that isn't owner/name, is skipped when read.
        let odd = parse_plugins(br#"{"plugins":{"x@m":{"all":"on","projects":{"a/b":{"all":"own"},"nope":{"all":"off"},"c/d":{"machines":{"cedar":"off"}}}}}}"#);
        assert_eq!(odd[0].projects.keys().collect::<Vec<_>>(), ["c/d"]);
    }

    #[test]
    fn a_project_turns_a_skill_on_or_off_beside_the_machines_own_values() {
        let machines = with_skill_machine(None, "pdf", "ci-01", Some(SkillWanted::Off)).unwrap();
        let off = with_skill_project(Some(machines.as_bytes()), "pdf", "Cam/Arbor", None, Some(PluginWanted::Off)).unwrap();
        let on_cedar = with_skill_project(Some(off.as_bytes()), "pdf", "cam/arbor", Some("Cedar"), Some(PluginWanted::On)).unwrap();
        // A skill the file doesn't name yet gets an entry of its own.
        let other = with_skill_project(Some(on_cedar.as_bytes()), "frontend-design", "cam/api", None, Some(PluginWanted::On)).unwrap();
        assert!(with_skill_project(Some(other.as_bytes()), "pdf", "cam/arbor", None, Some(PluginWanted::Own)).is_err());
        let projects = parse_projects(other.as_bytes(), SKILLS_SECTION);
        let arbor = &projects["pdf"]["cam/arbor"];
        assert_eq!((arbor.all, arbor.machines.get("cedar")), (Some(PluginWanted::Off), Some(&PluginWanted::On)));
        assert_eq!(projects["frontend-design"]["cam/api"].all, Some(PluginWanted::On));
        // The machines' own values are read as before, beside the projects'.
        assert_eq!(parse(other.as_bytes())["pdf"].get("ci01"), Some(&SkillWanted::Off));
        // Clearing the project's values leaves the machine's alone, and a skill with nothing left goes.
        let cleared = with_skill_project(Some(other.as_bytes()), "pdf", "cam/arbor", Some("cedar"), None).unwrap();
        let cleared = with_skill_project(Some(cleared.as_bytes()), "pdf", "cam/arbor", None, None).unwrap();
        let cleared = with_skill_project(Some(cleared.as_bytes()), "frontend-design", "cam/api", None, None).unwrap();
        let value: Value = serde_json::from_str(&cleared).unwrap();
        assert_eq!(value["skills"], serde_json::json!({ "pdf": { "machines": { "ci-01": "off" } } }));
        assert!(parse_projects(cleared.as_bytes(), SKILLS_SECTION).is_empty());
    }

    #[test]
    fn a_projects_mcp_servers_sit_beside_its_skills_and_go_when_cleared() {
        let skills = with_skill_project(None, "pdf", "cam/arbor", None, Some(PluginWanted::Off)).unwrap();
        let mcp = with_project_value(Some(skills.as_bytes()), MCP_SECTION, "linear", "cam/arbor", Some("mac-mini"), Some(PluginWanted::Off)).unwrap();
        assert_eq!(parse_projects(mcp.as_bytes(), MCP_SECTION)["linear"]["cam/arbor"].machines.get("macmini"), Some(&PluginWanted::Off));
        // Skills and servers don't read each other's values.
        assert!(!parse_projects(mcp.as_bytes(), SKILLS_SECTION).contains_key("linear"));
        assert!(!parse_projects(mcp.as_bytes(), MCP_SECTION).contains_key("pdf"));
        let cleared = with_project_value(Some(mcp.as_bytes()), MCP_SECTION, "linear", "cam/arbor", Some("mac-mini"), None).unwrap();
        let value: Value = serde_json::from_str(&cleared).unwrap();
        assert!(value.get("mcp").is_none());
        assert_eq!(value["skills"]["pdf"]["projects"]["cam/arbor"]["all"], "off");
    }
}

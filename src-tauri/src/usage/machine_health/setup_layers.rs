//! The setup repo's machine and project layers, over its global .claude, .codex and .agents files:
//!
//! ```text
//! machines/<machine>.json            one machine: SSH host, role, code root, its own values
//! machines/_archive/<machine>.json
//! projects/<owner>/<name>/project.json  remote, path, branch, its machines, its own values
//! projects/_local/<name>/project.json   a project with no remote
//! projects/_archive/<owner>/<name>/…    and _archive/_local/<name>/…
//! schema/                            JSON Schemas for editors, Arbor's own
//! ```
//!
//! Values go global → machine → project → project on a machine, the later winning. The global layer is
//! .agents/machines.json and plugins.json; their per-machine and per-project values are still read, and a
//! machine or project file's value wins over them (`merge`). A file Arbor can't read, or a value in one, is
//! skipped and listed as a problem, so one bad edit never stops the rest of the repo syncing.
//!
//! A project lists its machines, by name (compared loosely, as everywhere), by `@role` or as `"all"`, so
//! where a project lives reads in one place. Each one gets the project at one path: the machine's own path
//! for it, else the project's, else `<codeRoot>/<owner>/<name>` (`<codeRoot>/_local/<name>` for a local
//! one), which is what lets someone move to another machine for a project and find it where they left it.
//! Archived machines and projects stay on record and are planned for no more. See
//! docs/internals/projects-and-machines.md.

use super::setup_wanted::{is_project, PluginWanted, ProjectValue, RepoPlugin, SkillMachines, SkillProjects, SkillWanted};
use super::setup_projects::normalize_remote;
use super::shell::{runs_scripts, this_machine_name};
use super::*;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use ts_rs::TS;

pub(super) const MACHINES_DIR: &str = "machines/";
pub(super) const PROJECTS_DIR: &str = "projects/";
pub(super) const SCHEMA_DIR: &str = "schema/";
const ARCHIVE: &str = "_archive";
const LOCAL: &str = "_local";
const PROJECT_FILE: &str = "project.json";
/// Where projects go on a machine whose file doesn't say.
pub(super) const DEFAULT_CODE_ROOT: &str = "~/code";
/// Larger than any machine or project file should be.
pub(super) const LAYER_FILE_MAX_BYTES: u64 = 64 * 1024;

/// The schemas for machine and project files, which editors check them against. Arbor's own; it reads the files
/// with its own parser and puts these in the repo for people editing them by hand.
pub(super) const SCHEMAS: [(&str, &str); 2] = [
    ("schema/machine.schema.json", include_str!("schema/machine.schema.json")),
    ("schema/project.schema.json", include_str!("schema/project.schema.json")),
];

/// A file Arbor may commit for the layers: a machine or project file, or a schema.
pub(super) fn is_layer_file(rel: &str) -> bool {
    matches!(layer_path(rel), Some(LayerPath::Machine { .. } | LayerPath::Project { .. })) || SCHEMAS.iter().any(|(path, _)| *path == rel)
}

/// A machine as its file in the repo describes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoMachine {
    /// Its normalized name, from the file's name.
    key: String,
    /// The file, from the repo's root.
    file: String,
    archived: bool,
    /// How the file names it; the file's name when it doesn't.
    name: String,
    /// The SSH host the file gives. Arbor connects with its own list; this only offers a missing one.
    host: Option<String>,
    role: Option<String>,
    /// Where its projects go, `~/…` or absolute.
    code_root: String,
    skills: BTreeMap<String, SkillWanted>,
    plugins: BTreeMap<String, PluginWanted>,
    /// Kept for the MCP registry; on or off.
    mcp: BTreeMap<String, PluginWanted>,
}

/// Which machines a project is on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub(crate) enum Assignment {
    /// Every machine Arbor watches that isn't archived.
    All,
    /// By normalized name, or `@role` (lowercase), each with its values there.
    Some { machines: BTreeMap<String, ProjectOnMachine> },
}

/// A project's values on one machine, or on each machine of a role.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectOnMachine {
    path: Option<String>,
    skills: BTreeMap<String, PluginWanted>,
    plugins: BTreeMap<String, PluginWanted>,
    mcp: BTreeMap<String, PluginWanted>,
}

/// A project as its folder in the repo describes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoProject {
    /// Lowercase `owner/name`, or `_local/<name>` for one with no remote.
    key: String,
    /// Its folder, from the repo's root.
    folder: String,
    archived: bool,
    local: bool,
    /// As the file writes it, which is what a clone uses.
    remote: Option<String>,
    path: Option<String>,
    /// None for the remote's default.
    branch: Option<String>,
    machines: Assignment,
    /// On or off in every checkout.
    skills: BTreeMap<String, PluginWanted>,
    plugins: BTreeMap<String, PluginWanted>,
    mcp: BTreeMap<String, PluginWanted>,
    /// The skills only its checkouts get, from its skills folder.
    own_skills: Vec<String>,
}

/// A layer file Arbor skipped, or a value in one, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LayerProblem {
    file: String,
    problem: String,
}

/// The repo's machines and projects, as its last commit has them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupLayers {
    machines: Vec<RepoMachine>,
    projects: Vec<RepoProject>,
    problems: Vec<LayerProblem>,
}

/// What a path in the repo is to the layers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum LayerPath {
    Machine { key: String, stem: String, archived: bool },
    Project { key: String, folder: String, archived: bool },
    /// A file in one of a project's own skills.
    ProjectSkill { folder: String, skill: String },
    Schema,
}

/// What `rel` is to the layers, when it's one of their files.
pub(super) fn layer_path(rel: &str) -> Option<LayerPath> {
    if rel.contains('\\') || rel.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return None;
    }
    if let Some(rest) = rel.strip_prefix(SCHEMA_DIR) {
        return (!rest.contains('/')).then_some(LayerPath::Schema);
    }
    if let Some(rest) = rel.strip_prefix(MACHINES_DIR) {
        let (archived, file) = match rest.split_once('/') {
            Some((ARCHIVE, file)) => (true, file),
            Some(_) => return None,
            None => (false, rest),
        };
        let stem = file.strip_suffix(".json").filter(|stem| !file.contains('/') && !stem.starts_with('_') && !stem.starts_with('.'))?;
        let key = normalize_machine_name(stem);
        return (!key.is_empty()).then(|| LayerPath::Machine { key, stem: stem.to_string(), archived });
    }
    let rest = rel.strip_prefix(PROJECTS_DIR)?;
    let (archived, rest) = match rest.strip_prefix(&format!("{ARCHIVE}/")) {
        Some(rest) => (true, rest),
        None => (false, rest),
    };
    let parts: Vec<&str> = rest.split('/').collect();
    let (owner, name, within) = match parts.as_slice() {
        [owner, name, within @ ..] if !within.is_empty() => (*owner, *name, within),
        _ => return None,
    };
    let key = project_key(owner, name)?;
    let folder = format!("{PROJECTS_DIR}{}{owner}/{name}", if archived { "_archive/" } else { "" });
    match within {
        [file] if *file == PROJECT_FILE => Some(LayerPath::Project { key, folder, archived }),
        ["skills", skill, _, ..] if is_skill_folder(skill) => Some(LayerPath::ProjectSkill { folder, skill: skill.to_string() }),
        _ => None,
    }
}

/// A project's key from its folder: lowercase `owner/name`, or `_local/<name>`.
fn project_key(owner: &str, name: &str) -> Option<String> {
    if owner == LOCAL {
        return is_skill_folder(name).then(|| format!("{LOCAL}/{}", name.to_ascii_lowercase()));
    }
    let project = format!("{owner}/{name}");
    is_project(&project).then(|| project.to_ascii_lowercase())
}

fn is_skill_folder(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128 && !name.starts_with('.') && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// A path a layer may give: `~/…` or absolute, with nothing that climbs out or isn't plainly a path.
pub(super) fn is_layer_path(path: &str) -> bool {
    if path == "~" || path == "/" {
        return true;
    }
    let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix('/')) else {
        return false;
    };
    path.len() <= 1024 && !path.chars().any(|c| c.is_control() || c == '\\') && rest.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Problems found while reading one file.
struct Problems<'a> {
    file: &'a str,
    found: &'a mut Vec<LayerProblem>,
}

impl Problems<'_> {
    fn add(&mut self, problem: String) {
        self.found.push(LayerProblem { file: self.file.to_string(), problem });
    }
}

/// The string at `key` in `object`, noting anything else that's there.
fn string_at(object: &Map<String, Value>, key: &str, problems: &mut Problems) -> Option<String> {
    match object.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if !value.trim().is_empty() && !value.chars().any(char::is_control) => Some(value.trim().to_string()),
        Some(_) => {
            problems.add(format!("\"{key}\" isn't a line of text, so it's left out"));
            None
        }
    }
}

/// A path at `key`, noting one that isn't `~/…` or absolute.
fn path_at(object: &Map<String, Value>, key: &str, problems: &mut Problems) -> Option<String> {
    let path = string_at(object, key, problems)?;
    if is_layer_path(&path) {
        Some(path)
    } else {
        problems.add(format!("\"{key}\" has to start with ~/ or /, without .. in it, so {path} is left out"));
        None
    }
}

/// The values in `object[key]`, each read by `read`, noting those it can't.
fn values_at<T>(object: &Map<String, Value>, key: &str, valid_name: fn(&str) -> bool, read: fn(&str) -> Option<T>, allowed: &str, problems: &mut Problems) -> BTreeMap<String, T> {
    let mut values = BTreeMap::new();
    match object.get(key) {
        None | Some(Value::Null) => {}
        Some(Value::Object(found)) => {
            for (name, value) in found {
                match value.as_str().and_then(read) {
                    Some(value) if valid_name(name) => {
                        values.insert(name.clone(), value);
                    }
                    _ => problems.add(format!("{key}.{name} has to be {allowed}, so it's left out")),
                }
            }
        }
        Some(_) => problems.add(format!("\"{key}\" isn't an object, so it's left out")),
    }
    values
}

fn on_off(value: &str) -> Option<PluginWanted> {
    match value {
        "on" => Some(PluginWanted::On),
        "off" => Some(PluginWanted::Off),
        _ => None,
    }
}

fn plugin_value(value: &str) -> Option<PluginWanted> {
    serde_json::from_value(Value::from(value)).ok()
}

fn skill_value(value: &str) -> Option<SkillWanted> {
    serde_json::from_value(Value::from(value)).ok()
}

fn is_name(name: &str) -> bool {
    is_skill_folder(name)
}

fn is_plugin(name: &str) -> bool {
    name.split_once('@').is_some_and(|(plugin, marketplace)| is_skill_folder(plugin) && is_skill_folder(marketplace))
}

/// The object `bytes` holds, noting when it isn't one.
fn object_of(bytes: &[u8], problems: &mut Problems) -> Option<Map<String, Value>> {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(object)) => Some(object),
        Ok(_) => {
            problems.add("isn't a JSON object, so Arbor skips it".into());
            None
        }
        Err(error) => {
            problems.add(format!("isn't JSON Arbor can read ({error}), so it skips it"));
            None
        }
    }
}

/// A machine file's contents, or None when it isn't one Arbor can read.
pub(super) fn parse_machine(file: &str, key: &str, stem: &str, archived: bool, bytes: &[u8], found: &mut Vec<LayerProblem>) -> Option<RepoMachine> {
    let mut problems = Problems { file, found };
    let object = object_of(bytes, &mut problems)?;
    let name = string_at(&object, "name", &mut problems).unwrap_or_else(|| stem.to_string());
    if normalize_machine_name(&name) != key {
        problems.add(format!("is named {name}, but its file name says {stem}. The file name is what counts"));
    }
    Some(RepoMachine {
        key: key.to_string(),
        file: file.to_string(),
        archived,
        name,
        host: string_at(&object, "host", &mut problems).filter(|host| !host.starts_with('-') && !host.contains(char::is_whitespace)),
        role: string_at(&object, "role", &mut problems).map(|role| role.to_ascii_lowercase()),
        code_root: path_at(&object, "codeRoot", &mut problems).unwrap_or_else(|| DEFAULT_CODE_ROOT.to_string()),
        skills: values_at(&object, "skills", is_name, skill_value, "off or own", &mut problems),
        plugins: values_at(&object, "plugins", is_plugin, plugin_value, "on, off, own or removed", &mut problems),
        mcp: values_at(&object, "mcp", is_name, on_off, "on or off", &mut problems),
    })
}

/// The values a project file gives for every checkout, or for one machine's, from `object`.
fn project_values(object: &Map<String, Value>, problems: &mut Problems) -> (BTreeMap<String, PluginWanted>, BTreeMap<String, PluginWanted>, BTreeMap<String, PluginWanted>) {
    (
        values_at(object, "skills", is_name, on_off, "on or off", problems),
        values_at(object, "plugins", is_plugin, on_off, "on or off", problems),
        values_at(object, "mcp", is_name, on_off, "on or off", problems),
    )
}

/// A project file's contents, or None when it isn't one Arbor can read.
pub(super) fn parse_project(file: &str, key: &str, folder: &str, archived: bool, bytes: &[u8], found: &mut Vec<LayerProblem>) -> Option<RepoProject> {
    let mut problems = Problems { file, found };
    let object = object_of(bytes, &mut problems)?;
    let local = key.starts_with(&format!("{LOCAL}/"));
    let remote = string_at(&object, "remote", &mut problems);
    if object.get("local").and_then(Value::as_bool).is_some_and(|said| said != local) {
        problems.add(format!("says \"local\" is {}, but its folder says otherwise. The folder is what counts", !local));
    }
    let remote = match (local, remote) {
        (true, Some(remote)) => {
            problems.add(format!("is in {LOCAL}, so its remote {remote} is left out. Move its folder to projects/<owner>/<name> to use it"));
            None
        }
        (false, None) => {
            problems.add("has no remote, so Arbor can't clone it anywhere".into());
            None
        }
        (false, Some(remote)) => match normalize_remote(&remote) {
            // host/owner/name: its last two parts have to be the folder's.
            Some(normal) if !normal.starts_with('/') => {
                let named: Vec<&str> = normal.rsplitn(3, '/').collect();
                if let [name, owner, _] = named.as_slice() {
                    if format!("{owner}/{name}") != key {
                        problems.add(format!("has the remote {remote}, which isn't {key}, its folder"));
                    }
                }
                Some(remote)
            }
            _ => {
                problems.add(format!("has {remote} as its remote, which Arbor can't read as one"));
                None
            }
        },
        (true, None) => None,
    };
    let branch = string_at(&object, "branch", &mut problems).filter(|branch| {
        let fine = branch.len() <= 255 && !branch.starts_with('-') && !branch.contains(char::is_whitespace) && !branch.contains("..");
        if !fine {
            problems.add(format!("has {branch} as its branch, which isn't one, so it's left out"));
        }
        fine
    });
    let machines = match object.get("machines") {
        None | Some(Value::Null) => Assignment::Some { machines: BTreeMap::new() },
        Some(Value::String(all)) if all == "all" => Assignment::All,
        Some(Value::Object(listed)) => {
            let mut machines = BTreeMap::new();
            for (name, value) in listed {
                let key = match name.strip_prefix('@') {
                    Some(role) if !role.trim().is_empty() => format!("@{}", role.trim().to_ascii_lowercase()),
                    Some(_) => String::new(),
                    None => normalize_machine_name(name),
                };
                let Some(object) = value.as_object().filter(|_| key != "@" && !key.is_empty()) else {
                    problems.add(format!("machines.{name} has to be a machine or @role with an object, so it's left out"));
                    continue;
                };
                let path = path_at(object, "path", &mut problems);
                let (skills, plugins, mcp) = project_values(object, &mut problems);
                machines.insert(key, ProjectOnMachine { path, skills, plugins, mcp });
            }
            Assignment::Some { machines }
        }
        Some(_) => {
            problems.add("\"machines\" has to be \"all\" or an object, so it's on no machine".into());
            Assignment::Some { machines: BTreeMap::new() }
        }
    };
    let path = path_at(&object, "path", &mut problems);
    let (skills, plugins, mcp) = project_values(&object, &mut problems);
    Some(RepoProject {
        key: key.to_string(),
        folder: folder.to_string(),
        archived,
        local,
        remote,
        path,
        branch,
        machines,
        skills,
        plugins,
        mcp,
        own_skills: Vec::new(),
    })
}

/// The layers from the repo's layer files, each with its blob's contents, and the skills folders under its projects.
pub(super) fn read_layers(files: Vec<(String, LayerPath, Vec<u8>)>, project_skills: &[(String, String)]) -> SetupLayers {
    let mut layers = SetupLayers::default();
    let mut seen_machines: BTreeMap<String, String> = BTreeMap::new();
    let mut seen_projects: BTreeMap<String, String> = BTreeMap::new();
    for (rel, path, bytes) in files {
        match path {
            LayerPath::Machine { key, stem, archived } => {
                // Two files for one machine (eden-dev-01.json and eden_dev_01.json): neither is the one.
                if let Some(other) = seen_machines.insert(key.clone(), rel.clone()) {
                    layers.problems.push(LayerProblem { file: rel, problem: format!("is the same machine as {other}, so both are skipped") });
                    layers.machines.retain(|machine| machine.key != key);
                    continue;
                }
                if let Some(machine) = parse_machine(&rel, &key, &stem, archived, &bytes, &mut layers.problems) {
                    layers.machines.push(machine);
                }
            }
            LayerPath::Project { key, folder, archived } => {
                if let Some(other) = seen_projects.insert(key.clone(), rel.clone()) {
                    layers.problems.push(LayerProblem { file: rel, problem: format!("is the same project as {other}, so both are skipped") });
                    layers.projects.retain(|project| project.key != key);
                    continue;
                }
                if let Some(mut project) = parse_project(&rel, &key, &folder, archived, &bytes, &mut layers.problems) {
                    project.own_skills = project_skills.iter().filter(|(folder, _)| *folder == project.folder).map(|(_, skill)| skill.clone()).collect::<BTreeSet<_>>().into_iter().collect();
                    layers.projects.push(project);
                }
            }
            LayerPath::ProjectSkill { .. } | LayerPath::Schema => {}
        }
    }
    // A role no machine file has means the project is on none of those machines, which is likely a typo. A machine
    // name without a file is fine: Arbor may watch it, and if not, `places` says so.
    let roles: BTreeSet<String> = layers.machines.iter().filter_map(|machine| machine.role.as_ref().map(|role| format!("@{role}"))).collect();
    for project in &layers.projects {
        if let Assignment::Some { machines: listed } = &project.machines {
            for key in listed.keys().filter(|key| key.starts_with('@') && !roles.contains(*key)) {
                layers.problems.push(LayerProblem { file: format!("{}/{PROJECT_FILE}", project.folder), problem: format!("lists {key}, but no machine file has that role") });
            }
        }
    }
    layers
}

impl SetupLayers {
    fn machine(&self, key: &str) -> Option<&RepoMachine> {
        self.machines.iter().find(|machine| machine.key == key)
    }

    /// The entries in `project`'s machines that name `machine` (normalized), by role first, so its own entry, applied
    /// last, wins.
    fn entries_for<'a>(&self, project: &'a RepoProject, machine: &str) -> Vec<&'a ProjectOnMachine> {
        let Assignment::Some { machines } = &project.machines else {
            return Vec::new();
        };
        let role = self.machine(machine).and_then(|found| found.role.as_ref()).map(|role| format!("@{role}"));
        let by_role = role.and_then(|role| machines.get(&role));
        by_role.into_iter().chain(machines.get(machine)).collect()
    }

    /// Merges the machine and project files' values into those .agents/machines.json and plugins.json give, the
    /// files' winning, so everything that reads per-machine and per-project values reads the layers too.
    pub(super) fn merge(&self, skill_machines: &mut SkillMachines, plugins: &mut [RepoPlugin], skill_projects: &mut SkillProjects, mcp_projects: &mut SkillProjects) {
        for machine in self.machines.iter().filter(|machine| !machine.archived) {
            for (skill, wanted) in &machine.skills {
                skill_machines.entry(skill.clone()).or_default().insert(machine.key.clone(), *wanted);
            }
            for plugin in plugins.iter_mut() {
                if let Some(wanted) = machine.plugins.get(plugin.id()) {
                    plugin.set_machine(&machine.key, *wanted);
                }
            }
        }
        for project in self.projects.iter().filter(|project| !project.archived && !project.local) {
            let on_machines: Vec<(String, Vec<&ProjectOnMachine>)> = self.machine_keys(project).into_iter().map(|key| {
                let entries = self.entries_for(project, &key);
                (key, entries)
            }).collect();
            let pick = |all: &BTreeMap<String, PluginWanted>, each: fn(&ProjectOnMachine) -> &BTreeMap<String, PluginWanted>| -> BTreeMap<String, ProjectValue> {
                let mut values: BTreeMap<String, ProjectValue> = BTreeMap::new();
                for (name, wanted) in all {
                    values.entry(name.clone()).or_default().set_all(*wanted);
                }
                for (machine, entries) in &on_machines {
                    for entry in entries {
                        for (name, wanted) in each(entry) {
                            values.entry(name.clone()).or_default().set_machine(machine, *wanted);
                        }
                    }
                }
                values
            };
            for (skill, value) in pick(&project.skills, |entry| &entry.skills) {
                skill_projects.entry(skill).or_default().entry(project.key.clone()).or_default().overlay(value);
            }
            for (server, value) in pick(&project.mcp, |entry| &entry.mcp) {
                mcp_projects.entry(server).or_default().entry(project.key.clone()).or_default().overlay(value);
            }
            let plugin_values = pick(&project.plugins, |entry| &entry.plugins);
            for plugin in plugins.iter_mut() {
                if let Some(value) = plugin_values.get(plugin.id()) {
                    plugin.set_project(&project.key, value.clone());
                }
            }
        }
    }

    /// The machines a project's own entries can mean: those it names, and those with a role it names.
    fn machine_keys(&self, project: &RepoProject) -> BTreeSet<String> {
        let Assignment::Some { machines } = &project.machines else {
            return BTreeSet::new();
        };
        let mut keys: BTreeSet<String> = machines.keys().filter(|key| !key.starts_with('@')).cloned().collect();
        for machine in &self.machines {
            if machine.role.as_ref().is_some_and(|role| machines.contains_key(&format!("@{role}"))) {
                keys.insert(machine.key.clone());
            }
        }
        keys
    }

    /// Where each project not archived goes on each of `machines` (Arbor's names) it's on, and the names it lists that
    /// aren't one of them.
    pub(super) fn places(&self, machines: &[String]) -> Vec<ProjectPlaces> {
        self.projects
            .iter()
            .map(|project| {
                let mut places = Vec::new();
                let mut unknown = Vec::new();
                if !project.archived {
                    for machine in machines {
                        let key = normalize_machine_name(machine);
                        let file = self.machine(&key);
                        if file.is_some_and(|file| file.archived) {
                            continue;
                        }
                        let entries = self.entries_for(project, &key);
                        if !matches!(project.machines, Assignment::All) && entries.is_empty() {
                            continue;
                        }
                        let code_root = file.map_or(DEFAULT_CODE_ROOT, |file| file.code_root.as_str());
                        let path = entries
                            .iter()
                            .rev()
                            .find_map(|entry| entry.path.clone())
                            .or_else(|| project.path.clone())
                            .unwrap_or_else(|| format!("{}/{}", code_root.trim_end_matches('/'), project.key));
                        places.push(Place { machine: machine.clone(), path });
                    }
                    if let Assignment::Some { machines: listed } = &project.machines {
                        let known: BTreeSet<String> = machines.iter().map(|machine| normalize_machine_name(machine)).collect();
                        unknown = listed
                            .keys()
                            .filter(|key| !key.starts_with('@') && !known.contains(*key) && !self.machine(key).is_some_and(|file| file.archived))
                            .map(|key| self.machine(key).map_or_else(|| key.clone(), |file| file.name.clone()))
                            .collect();
                    }
                }
                ProjectPlaces {
                    project: project.key.clone(),
                    local: project.local,
                    archived: project.archived,
                    remote: project.remote.clone(),
                    branch: project.branch.clone(),
                    places,
                    unknown,
                }
            })
            .collect()
    }
}

/// Where a project goes on one machine.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Place {
    /// As Arbor names it.
    pub(super) machine: String,
    /// `~/…` or absolute.
    pub(super) path: String,
}

/// Where a project goes on each machine it's on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectPlaces {
    pub(super) project: String,
    pub(super) local: bool,
    pub(super) archived: bool,
    pub(super) remote: Option<String>,
    pub(super) branch: Option<String>,
    pub(super) places: Vec<Place>,
    /// Machines it lists that Arbor doesn't watch, as the repo names them.
    pub(super) unknown: Vec<String>,
}

/// Every machine Arbor runs scripts on, this Mac included, as it names them.
pub(super) fn arbor_machines(inner: &Inner) -> Vec<String> {
    let mut machines: Vec<String> = inner.series.values().filter(|series| runs_scripts(series)).map(|series| series.host.machine.clone()).collect();
    if let Some(name) = this_machine_name(inner) {
        machines.push(name);
    }
    machines.sort();
    machines.dedup();
    machines
}

/// The places the setup repo wants projects on `machine`, remembering `repo`, when given, as the one the window names.
/// None when there's no repo yet, or it can't be read: the scan then looks only where sessions point.
pub(super) async fn places_on(state: &MachineHealthState, repo: Option<String>, machine: &str) -> Vec<String> {
    let (repo, machines) = {
        let mut inner = state.lock();
        if let Some(repo) = repo {
            inner.setup_repo = Some(repo);
        }
        (inner.setup_repo.clone(), arbor_machines(&inner))
    };
    let Some(repo) = repo else { return Vec::new() };
    let Ok(found) = super::setup_sync::read_repo(Path::new(&repo)).await else { return Vec::new() };
    found.layers().places(&machines).into_iter().flat_map(|project| project.places).filter(|place| place.machine == machine).map(|place| place.path).collect()
}

/// Puts Arbor's schemas for machine and project files in the repo, or brings them up to date, each a commit of its own.
#[tauri::command]
pub(crate) async fn add_setup_schemas(repo: String) -> Result<super::setup_sync::SetupRepo, String> {
    let folder = Path::new(&repo);
    for (rel, text) in SCHEMAS {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        super::setup_sync::take_into_repo(folder, rel, text.as_bytes(), &format!("Add Arbor's {name}"), &[]).await?;
    }
    super::setup_sync::read_repo(folder).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layers(files: &[(&str, &str)]) -> SetupLayers {
        let files = files
            .iter()
            .map(|(rel, text)| (rel.to_string(), layer_path(rel).expect(rel), text.as_bytes().to_vec()))
            .collect();
        read_layers(files, &[("projects/cam/arbor".into(), "release-notes".into())])
    }

    fn names(machines: &[&str]) -> Vec<String> {
        machines.iter().map(|machine| machine.to_string()).collect()
    }

    #[test]
    fn layer_paths_are_told_apart_and_anything_else_is_not_one() {
        assert_eq!(layer_path("machines/ci-01.json"), Some(LayerPath::Machine { key: "ci01".into(), stem: "ci-01".into(), archived: false }));
        assert_eq!(layer_path("machines/_archive/old-box.json"), Some(LayerPath::Machine { key: "oldbox".into(), stem: "old-box".into(), archived: true }));
        assert_eq!(layer_path("projects/Cam/Arbor/project.json"), Some(LayerPath::Project { key: "cam/arbor".into(), folder: "projects/Cam/Arbor".into(), archived: false }));
        assert_eq!(layer_path("projects/_local/idler/project.json"), Some(LayerPath::Project { key: "_local/idler".into(), folder: "projects/_local/idler".into(), archived: false }));
        assert_eq!(
            layer_path("projects/_archive/_local/idler/project.json"),
            Some(LayerPath::Project { key: "_local/idler".into(), folder: "projects/_archive/_local/idler".into(), archived: true })
        );
        assert_eq!(layer_path("projects/cam/arbor/skills/notes/SKILL.md"), Some(LayerPath::ProjectSkill { folder: "projects/cam/arbor".into(), skill: "notes".into() }));
        assert_eq!(layer_path("schema/project.schema.json"), Some(LayerPath::Schema));
        for other in ["machines/notes.md", "machines/_template.json", "machines/a/b.json", "projects/cam/project.json", "projects/cam/arbor/../x/project.json", "projects/-x/arbor/project.json", "projects/cam/arbor/skills/notes"] {
            assert_eq!(layer_path(other), None, "{other}");
        }
    }

    #[test]
    fn paths_are_home_or_absolute_and_never_climb() {
        for fine in ["~/code", "~/code/cam/arbor", "/srv/code", "~"] {
            assert!(is_layer_path(fine), "{fine}");
        }
        for not in ["code", "~cam/code", "~/code/../etc", "~/code/", "/a//b", "~/a/./b", "", "~/a\nb"] {
            assert!(!is_layer_path(not), "{not}");
        }
    }

    #[test]
    fn a_project_goes_under_each_machines_code_root_unless_a_path_says_otherwise() {
        let found = layers(&[
            ("machines/ci-01.json", r#"{"name": "CI 01", "role": "Devbox", "codeRoot": "~/work"}"#),
            ("machines/cedar-02.json", r#"{"role": "devbox"}"#),
            ("projects/cam/arbor/project.json", r#"{"remote": "git@github.com:cam/arbor.git", "machines": {"@devbox": {}, "cam-mbp": {"path": "~/src/arbor"}}}"#),
            ("projects/cam/site/project.json", r#"{"remote": "https://github.com/cam/site", "path": "/srv/site", "machines": {"cedar-02": {}}}"#),
            ("projects/_local/idler/project.json", r#"{"local": true, "machines": {"cam-mbp": {}}}"#),
        ]);
        assert_eq!(found.problems, vec![]);
        let places = found.places(&names(&["cam-mbp", "CI 01", "cedar-02", "lab-box"]));
        let at = |project: &str| -> Vec<(String, String)> {
            places.iter().find(|places| places.project == project).unwrap().places.iter().map(|place| (place.machine.clone(), place.path.clone())).collect()
        };
        assert_eq!(
            at("cam/arbor"),
            vec![("cam-mbp".into(), "~/src/arbor".into()), ("CI 01".into(), "~/work/cam/arbor".into()), ("cedar-02".into(), "~/code/cam/arbor".into())]
        );
        assert_eq!(at("cam/site"), vec![("cedar-02".into(), "/srv/site".into())]);
        assert_eq!(at("_local/idler"), vec![("cam-mbp".into(), "~/code/_local/idler".into())]);
    }

    #[test]
    fn all_means_every_machine_but_archived_ones_and_archived_projects_go_nowhere() {
        let found = layers(&[
            ("machines/_archive/lab-box.json", "{}"),
            ("projects/cam/arbor/project.json", r#"{"remote": "https://github.com/cam/arbor.git", "machines": "all"}"#),
            ("projects/_archive/cam/old/project.json", r#"{"remote": "https://github.com/cam/old.git", "machines": "all"}"#),
        ]);
        let places = found.places(&names(&["cam-mbp", "lab-box"]));
        let arbor = places.iter().find(|places| places.project == "cam/arbor").unwrap();
        assert_eq!(arbor.places.iter().map(|place| place.machine.as_str()).collect::<Vec<_>>(), vec!["cam-mbp"]);
        let old = places.iter().find(|places| places.project == "cam/old").unwrap();
        assert!(old.archived && old.places.is_empty());
    }

    #[test]
    fn a_machine_it_lists_that_arbor_doesnt_watch_is_named() {
        let found = layers(&[
            ("machines/studio.json", r#"{"name": "Studio"}"#),
            ("projects/cam/arbor/project.json", r#"{"remote": "https://github.com/cam/arbor.git", "machines": {"studio": {}, "ci-01": {}}}"#),
        ]);
        let places = found.places(&names(&["ci-01"]));
        assert_eq!(places[0].unknown, vec!["Studio".to_string()]);
    }

    #[test]
    fn bad_values_are_skipped_and_said_while_the_rest_is_read() {
        let found = layers(&[
            ("machines/ci-01.json", r#"{"codeRoot": "code", "skills": {"pdf": "on", "grill-me": "off"}, "plugins": {"x@y": "removed", "nope": "on"}}"#),
            ("machines/cedar.json", "not json"),
            ("projects/cam/arbor/project.json", r#"{"remote": "https://github.com/cam/other.git", "branch": "--force", "machines": {"@": {}, "ci-01": {"path": "../x"}}}"#),
            ("projects/cam/site/project.json", r#"{"machines": {"@studio": {}}}"#),
            ("projects/_local/idler/project.json", r#"{"remote": "https://github.com/cam/idler.git"}"#),
        ]);
        let problems: Vec<String> = found.problems.iter().map(|problem| format!("{}: {}", problem.file, problem.problem)).collect();
        let has = |part: &str| assert!(problems.iter().any(|problem| problem.contains(part)), "{part} in {problems:#?}");
        has("machines/ci-01.json: \"codeRoot\" has to start with ~/");
        has("skills.pdf has to be off or own");
        has("plugins.nope has to be");
        has("machines/cedar.json: isn't JSON");
        has("which isn't cam/arbor, its folder");
        has("--force as its branch");
        has("machines.@ has to be");
        has("\"path\" has to start");
        has("cam/site/project.json: has no remote");
        has("lists @studio, but no machine file has that role");
        has("its remote https://github.com/cam/idler.git is left out");
        let ci = found.machine("ci01").unwrap();
        assert_eq!(ci.code_root, DEFAULT_CODE_ROOT);
        assert_eq!(ci.skills, BTreeMap::from([("grill-me".to_string(), SkillWanted::Off)]));
        assert_eq!(ci.plugins, BTreeMap::from([("x@y".to_string(), PluginWanted::Removed)]));
        assert_eq!(found.projects.len(), 3);
        assert_eq!(found.projects.iter().find(|project| project.key == "cam/arbor").unwrap().own_skills, vec!["release-notes".to_string()]);
    }

    #[test]
    fn two_files_for_one_machine_or_project_are_both_skipped() {
        let found = layers(&[("machines/ci-01.json", "{}"), ("machines/ci_01.json", "{}"), ("projects/cam/arbor/project.json", r#"{"remote": "https://github.com/cam/arbor.git"}"#), ("projects/_archive/cam/arbor/project.json", r#"{"remote": "https://github.com/cam/arbor.git"}"#)]);
        assert!(found.machines.is_empty() && found.projects.is_empty());
        assert_eq!(found.problems.len(), 2);
    }

    #[test]
    fn the_files_values_win_over_the_old_ones_project_on_a_machine_last() {
        let found = layers(&[
            ("machines/ci-01.json", r#"{"role": "devbox", "skills": {"pdf": "own"}, "plugins": {"ctx@mkt": "off"}}"#),
            ("machines/_archive/lab.json", r#"{"skills": {"pdf": "off"}}"#),
            (
                "projects/cam/arbor/project.json",
                r#"{"remote": "https://github.com/cam/arbor.git", "skills": {"pdf": "off"}, "mcp": {"linear": "on"}, "plugins": {"ctx@mkt": "on"},
                   "machines": {"@devbox": {"skills": {"pdf": "on", "tdd": "off"}}, "ci-01": {"skills": {"tdd": "on"}}}}"#,
            ),
        ]);
        let mut skill_machines = SkillMachines::from([("pdf".to_string(), BTreeMap::from([("ci01".to_string(), SkillWanted::Off)]))]);
        let mut plugins = super::super::setup_wanted::parse_plugins(br#"{"plugins": {"ctx@mkt": {"all": "on", "machines": {"ci-01": "on"}}}}"#);
        let mut skill_projects = SkillProjects::new();
        let mut mcp_projects = SkillProjects::new();
        found.merge(&mut skill_machines, &mut plugins, &mut skill_projects, &mut mcp_projects);
        assert_eq!(skill_machines["pdf"], BTreeMap::from([("ci01".to_string(), SkillWanted::Own)]));
        assert_eq!(plugins[0].machine_value("ci01"), Some(PluginWanted::Off));
        let pdf = &skill_projects["pdf"]["cam/arbor"];
        assert_eq!((pdf.all(), pdf.machine("ci01")), (Some(PluginWanted::Off), Some(PluginWanted::On)));
        // The machine's own entry is applied after its role's.
        assert_eq!(skill_projects["tdd"]["cam/arbor"].machine("ci01"), Some(PluginWanted::On));
        assert_eq!(mcp_projects["linear"]["cam/arbor"].all(), Some(PluginWanted::On));
        assert_eq!(plugins[0].project_value("cam/arbor").and_then(ProjectValue::all), Some(PluginWanted::On));
    }

    #[test]
    fn the_schemas_name_what_the_parser_reads() {
        let keys = |text: &str| -> BTreeSet<String> {
            let schema: Value = serde_json::from_str(text).unwrap();
            schema["properties"].as_object().unwrap().keys().filter(|key| *key != "$schema").cloned().collect()
        };
        let [(machine_rel, machine), (project_rel, project)] = SCHEMAS;
        assert!(is_layer_file(machine_rel) && is_layer_file(project_rel));
        assert_eq!(keys(machine), BTreeSet::from(["name", "host", "role", "codeRoot", "skills", "plugins", "mcp"].map(String::from)));
        assert_eq!(keys(project), BTreeSet::from(["remote", "local", "path", "branch", "machines", "skills", "plugins", "mcp"].map(String::from)));
    }
}

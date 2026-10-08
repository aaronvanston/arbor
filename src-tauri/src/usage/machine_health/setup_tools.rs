//! The tools the setup repo puts on every machine, from .agents/tools.json, so one commit can roll a tool out, pin
//! it, or take it off everywhere:
//!
//! ```json
//! {"version": 1,
//!  "installers": {"mac": ["brew", "mise", "npm"], "linux": ["mise", "brew", "npm"]},
//!  "tools": {
//!    "node": {"all": "22"},
//!    "uv":   {"all": "latest", "machines": {"ci-01": "own"}},
//!    "pnpm": {"all": "latest", "machines": {"@devbox": "10"}},
//!    "deno": {"all": "removed"}}}
//! ```
//!
//! A tool's value is `latest` (the newest its installer has), a version or the start of one (`22`, `1.26`, `0.9.1`:
//! a version that starts with it), `own` (the machine's business, never counted), or `removed`. A machine named in
//! `machines` gets its own value, else one its role names (`@role`, from its machine file), else `all`. A machine
//! file's `"tools"` wins over all of them, as its other values do.
//!
//! A tool a machine hasn't got is installed with the first installer in `installers` for its OS that the machine has
//! and that can give it; a tool it has is changed only with the installer that put it there (`tool_updates`). Nothing
//! here is ever applied by itself: an install can't be backed up the way a file can, so Sync lists the difference and
//! waits for the user.

use super::normalize_machine_name;
use super::setup_sync::{read_repo, take_into_repo, SetupRepo};
use super::setup_toolchain::is_tool;
use super::tool_updates::OwnerKind;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use ts_rs::TS;

pub(super) const TOOLS_FILE: &str = ".agents/tools.json";
const FILE_VERSION: u64 = 1;
/// The installers Arbor installs a missing tool with, in the order it tries them when the repo doesn't say.
const MAC_INSTALLERS: [OwnerKind; 3] = [OwnerKind::Brew, OwnerKind::Mise, OwnerKind::Npm];
const LINUX_INSTALLERS: [OwnerKind; 3] = [OwnerKind::Mise, OwnerKind::Brew, OwnerKind::Npm];

/// What the repo wants of a tool on one machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ToolWanted {
    Latest,
    /// A version, or the start of one.
    Version(String),
    Own,
    Removed,
}

impl ToolWanted {
    pub(super) fn read(value: &str) -> Option<Self> {
        let value = value.trim();
        Some(match value {
            "latest" => Self::Latest,
            "own" => Self::Own,
            "removed" => Self::Removed,
            _ => {
                let bare = value.strip_prefix('v').unwrap_or(value);
                let parts: Vec<&str> = bare.split('.').collect();
                let plain = bare.len() <= 20 && (1..=3).contains(&parts.len()) && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));
                if !plain {
                    return None;
                }
                Self::Version(bare.to_string())
            }
        })
    }
}

/// A tool the repo lists.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoTool {
    /// As Sync › Software names it: node, pnpm, uv, rust…
    tool: String,
    /// Every machine's value: `latest`, a version like `22`, `own` or `removed`.
    all: String,
    /// Machines' own values, by normalized name, and roles' as `@role`.
    machines: BTreeMap<String, String>,
}

impl RepoTool {
    pub(super) fn tool(&self) -> &str {
        &self.tool
    }

    /// What the repo wants of it on `machine` (normalized), whose role is `role`.
    pub(super) fn wanted_on(&self, machine: &str, role: Option<&str>) -> ToolWanted {
        let role = role.map(|role| format!("@{}", normalize_machine_name(role)));
        self.machines
            .get(machine)
            .or_else(|| role.as_ref().and_then(|role| self.machines.get(role)))
            .and_then(|value| ToolWanted::read(value))
            .or_else(|| ToolWanted::read(&self.all))
            .unwrap_or(ToolWanted::Own)
    }

    pub(super) fn set_machine(&mut self, machine: &str, value: &str) {
        self.machines.insert(machine.to_string(), value.to_string());
    }

    #[cfg(test)]
    pub(super) fn for_test(tool: &str, all: &str, machines: &[(&str, &str)]) -> Self {
        Self { tool: tool.into(), all: all.into(), machines: machines.iter().map(|(machine, value)| (machine.to_string(), value.to_string())).collect() }
    }
}

/// What .agents/tools.json says.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoTools {
    tools: Vec<RepoTool>,
    /// The installers a Mac tries for a tool it hasn't got, in order.
    mac: Vec<OwnerKind>,
    linux: Vec<OwnerKind>,
    /// What Arbor couldn't read in it and left out.
    problems: Vec<String>,
}

impl RepoTools {
    pub(super) fn tools(&self) -> &[RepoTool] {
        &self.tools
    }

    pub(super) fn tools_mut(&mut self) -> &mut Vec<RepoTool> {
        &mut self.tools
    }

    /// The installers to try on a machine whose `uname` says `os`.
    pub(super) fn installers_for(&self, os: &str) -> &[OwnerKind] {
        if os == "Darwin" { &self.mac } else { &self.linux }
    }

    /// A tool no file gives every machine a value for, which only machines naming it get.
    pub(super) fn own_tool(tool: &str) -> RepoTool {
        RepoTool { tool: tool.to_string(), all: "own".into(), machines: BTreeMap::new() }
    }

    pub(super) fn none() -> Self {
        Self { mac: MAC_INSTALLERS.to_vec(), linux: LINUX_INSTALLERS.to_vec(), ..Self::default() }
    }

    #[cfg(test)]
    pub(super) fn for_test(tools: Vec<RepoTool>) -> Self {
        Self { tools, ..Self::none() }
    }
}

/// Whether `version` is what a pin like `22`, `1.26` or `0.9.1` asks for: it starts with the pin's numbers.
pub(super) fn matches_pin(version: &str, pin: &str) -> bool {
    let numbers: Vec<&str> = version.trim_start_matches('v').split(|c: char| !c.is_ascii_digit()).collect();
    pin.split('.').enumerate().all(|(index, part)| numbers.get(index).is_some_and(|number| number.parse::<u64>().ok() == part.parse::<u64>().ok()))
}

/// What a machine's last toolchain scan and update check say about its tools, for Sync's standing.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct MachineTools {
    /// Each tool the shell finds, with its version when it said one.
    found: BTreeMap<String, Option<String>>,
    /// The newest each installer had at the last check.
    latest: BTreeMap<String, String>,
}

impl MachineTools {
    /// None for a machine whose tools were never looked at.
    pub(super) fn of(toolchain: &super::setup_toolchain::MachineToolchain) -> Option<Self> {
        toolchain.scanned_at()?;
        Some(Self {
            found: toolchain.tools().iter().map(|found| (found.tool().to_string(), found.version().map(str::to_string))).collect(),
            latest: toolchain.latest().iter().map(|(tool, version)| (tool.to_string(), version.to_string())).collect(),
        })
    }

    /// Whether the machine has the tool (and its version, when it said one).
    pub(super) fn version_of(&self, tool: &str) -> Option<Option<&str>> {
        self.found.get(tool).map(Option::as_deref)
    }

    /// Whether the tool's installer had something newer than `version` at the last check.
    pub(super) fn newer(&self, tool: &str, version: &str) -> bool {
        self.latest.get(tool).is_some_and(|latest| super::tool_updates::compare_versions(latest, version) == std::cmp::Ordering::Greater)
    }

    #[cfg(test)]
    pub(super) fn for_test(found: &[(&str, Option<&str>)], latest: &[(&str, &str)]) -> Self {
        Self {
            found: found.iter().map(|(tool, version)| (tool.to_string(), version.map(str::to_string))).collect(),
            latest: latest.iter().map(|(tool, version)| (tool.to_string(), version.to_string())).collect(),
        }
    }
}

/// A machine or role key as tools.json may name it.
fn machine_key(name: &str) -> Option<String> {
    let key = match name.strip_prefix('@') {
        Some(role) => format!("@{}", normalize_machine_name(role)),
        None => normalize_machine_name(name),
    };
    (key.len() > 1 || (!key.is_empty() && !key.starts_with('@'))).then_some(key)
}

fn installers_at(object: Option<&Value>, os: &str, problems: &mut Vec<String>) -> Option<Vec<OwnerKind>> {
    let list = object?.get(os)?;
    let Some(list) = list.as_array() else {
        problems.push(format!("installers.{os} isn't a list, so Arbor uses its own order"));
        return None;
    };
    let mut found = Vec::new();
    for entry in list {
        match entry.as_str() {
            Some("brew") => found.push(OwnerKind::Brew),
            Some("mise") => found.push(OwnerKind::Mise),
            Some("npm") => found.push(OwnerKind::Npm),
            _ => problems.push(format!("installers.{os} has {entry}, which Arbor doesn't install with: brew, mise or npm")),
        }
    }
    found.dedup();
    Some(found)
}

/// What .agents/tools.json lists, skipping and noting what isn't a tool or a value Arbor knows.
pub(super) fn parse_tools(bytes: &[u8]) -> RepoTools {
    let mut tools = RepoTools::none();
    let root = match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(root)) => root,
        _ => {
            tools.problems.push(format!("{TOOLS_FILE} isn't a JSON object Arbor can read, so it lists no tools"));
            return tools;
        }
    };
    let installers = root.get("installers");
    if let Some(mac) = installers_at(installers, "mac", &mut tools.problems) {
        tools.mac = mac;
    }
    if let Some(linux) = installers_at(installers, "linux", &mut tools.problems) {
        tools.linux = linux;
    }
    let Some(listed) = root.get("tools").and_then(Value::as_object) else { return tools };
    for (tool, entry) in listed {
        if !is_tool(tool) {
            tools.problems.push(format!("tools.{tool} isn't a tool Arbor knows, so it's left out"));
            continue;
        }
        let Some(all) = entry.get("all").and_then(Value::as_str).filter(|all| ToolWanted::read(all).is_some()) else {
            tools.problems.push(format!("tools.{tool}.all has to be latest, a version like 22, own or removed, so it's left out"));
            continue;
        };
        let mut machines = BTreeMap::new();
        for (name, value) in entry.get("machines").and_then(Value::as_object).into_iter().flatten() {
            match (machine_key(name), value.as_str().filter(|value| ToolWanted::read(value).is_some())) {
                (Some(key), Some(value)) => {
                    machines.insert(key, value.trim().to_string());
                }
                _ => tools.problems.push(format!("tools.{tool}.machines.{name} has to be latest, a version like 22, own or removed, so it's left out")),
            }
        }
        tools.tools.push(RepoTool { tool: tool.clone(), all: all.trim().to_string(), machines });
    }
    tools
}

/// tools.json with `tool` given `value` for every machine, or for `machine`, or taken out with None (the tool itself,
/// for every machine), keeping the rest of the file as it is.
pub(super) fn with_tool(text: Option<&[u8]>, tool: &str, machine: Option<&str>, value: Option<&str>) -> Result<String, String> {
    let unreadable = || format!("{TOOLS_FILE} isn't JSON Arbor can read. Fix it, then try again.");
    let mut root: Value = match text {
        Some(bytes) => serde_json::from_slice(bytes).map_err(|_| unreadable())?,
        None => serde_json::json!({ "version": FILE_VERSION, "tools": {} }),
    };
    let object = root.as_object_mut().ok_or_else(unreadable)?;
    let tools = object.entry("tools").or_insert_with(|| Value::Object(Map::new()));
    if !tools.is_object() {
        *tools = Value::Object(Map::new());
    }
    let tools = tools.as_object_mut().ok_or_else(unreadable)?;
    match (machine, value) {
        (None, Some(value)) => {
            let entry = tools.entry(tool).or_insert_with(|| Value::Object(Map::new()));
            if !entry.is_object() {
                *entry = Value::Object(Map::new());
            }
            if let Some(entry) = entry.as_object_mut() {
                entry.insert("all".into(), Value::from(value));
            }
        }
        (None, None) => {
            tools.remove(tool);
        }
        (Some(machine), value) => {
            let key = machine_key(machine).ok_or("That machine has no name to keep it under")?;
            let Some(entry) = tools.get_mut(tool).and_then(Value::as_object_mut) else {
                return Err(format!("The repo doesn't list {tool}. Give it a value for every machine first."));
            };
            let machines = entry.entry("machines").or_insert_with(|| Value::Object(Map::new()));
            if !machines.is_object() {
                *machines = Value::Object(Map::new());
            }
            let machines = machines.as_object_mut().ok_or_else(unreadable)?;
            // A machine named another way in the file is the same machine.
            let existing = machines.keys().find(|name| machine_key(name).as_deref() == Some(key.as_str())).cloned();
            match value {
                Some(value) => {
                    machines.insert(existing.unwrap_or_else(|| machine.to_string()), Value::from(value));
                }
                None => {
                    if let Some(existing) = existing {
                        machines.remove(&existing);
                    }
                    if machines.is_empty() {
                        entry.remove("machines");
                    }
                }
            }
        }
    }
    Ok(serde_json::to_string_pretty(&root).map_err(|error| error.to_string())? + "\n")
}

/// Lists `tool` in the repo with `value` for every machine, gives `machine` its own, or with `value` None takes the
/// machine's own value out (or the tool, for every machine), and commits .agents/tools.json alone.
#[tauri::command]
pub(crate) async fn set_setup_tool(repo: String, tool: String, machine: Option<String>, value: Option<String>) -> Result<SetupRepo, String> {
    if !is_tool(&tool) {
        return Err(format!("{tool} isn't a tool Arbor knows"));
    }
    if value.as_deref().is_some_and(|value| ToolWanted::read(value).is_none()) {
        return Err("A tool's value is latest, a version like 22, own or removed".into());
    }
    if machine.is_none() && value.as_deref() == Some("own") {
        return Err("Every machine can't keep its own: leave the tool out of the repo instead".into());
    }
    let folder = Path::new(&repo);
    let text = match fs::read(folder.join(TOOLS_FILE)) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Arbor couldn't read {TOOLS_FILE}: {error}")),
    };
    let next = with_tool(text.as_deref(), &tool, machine.as_deref(), value.as_deref())?;
    let message = match (machine.as_deref(), value.as_deref()) {
        (None, Some("latest")) => format!("Keep {tool} at its newest on every machine"),
        (None, Some("removed")) => format!("Remove {tool} from every machine"),
        (None, Some(version)) => format!("Keep {tool} at {version} on every machine"),
        (None, None) => format!("Stop listing {tool}"),
        (Some(machine), Some("latest")) => format!("Keep {tool} at its newest on {machine}"),
        (Some(machine), Some("removed")) => format!("Remove {tool} from {machine}"),
        (Some(machine), Some("own")) => format!("Let {machine} keep its own {tool}"),
        (Some(machine), Some(version)) => format!("Keep {tool} at {version} on {machine}"),
        (Some(machine), None) => format!("Give {machine} every machine's {tool}"),
    };
    take_into_repo(folder, TOOLS_FILE, next.as_bytes(), &message, &[]).await?;
    read_repo(folder).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_are_latest_a_version_own_or_removed() {
        assert_eq!(ToolWanted::read("latest"), Some(ToolWanted::Latest));
        assert_eq!(ToolWanted::read("v22"), Some(ToolWanted::Version("22".into())));
        assert_eq!(ToolWanted::read("0.9.1"), Some(ToolWanted::Version("0.9.1".into())));
        assert_eq!(ToolWanted::read("own"), Some(ToolWanted::Own));
        assert_eq!(ToolWanted::read("removed"), Some(ToolWanted::Removed));
        for bad in ["", "lts", "22.x", "1.2.3.4", "22; rm -rf ~", "^22"] {
            assert_eq!(ToolWanted::read(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_file_gives_each_tools_value_and_notes_what_it_skips() {
        let tools = parse_tools(
            br#"{"version": 1,
                 "installers": {"mac": ["mise", "brew", "apt"], "linux": "mise"},
                 "tools": {
                   "node": {"all": "22", "machines": {"CI-01": "own", "@DevBox": "24", "": "latest"}},
                   "uv": {"all": "latest"},
                   "ruby": {"all": "latest"},
                   "deno": {"all": "removed", "machines": {"cedar": "maybe"}},
                   "go": {"machines": {}}}}"#,
        );
        assert_eq!(tools.mac, vec![OwnerKind::Mise, OwnerKind::Brew]);
        assert_eq!(tools.linux, LINUX_INSTALLERS.to_vec(), "a list that isn't one leaves Arbor's own order");
        let mut names: Vec<&str> = tools.tools.iter().map(|tool| tool.tool.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["deno", "node", "uv"]);
        let tool = |name: &str| tools.tools.iter().find(|tool| tool.tool == name).unwrap();
        let node = tool("node");
        assert_eq!(node.wanted_on("ci01", None), ToolWanted::Own);
        assert_eq!(node.wanted_on("cedar", Some("devbox")), ToolWanted::Version("24".into()));
        assert_eq!(node.wanted_on("cedar", None), ToolWanted::Version("22".into()));
        assert_eq!(tool("deno").wanted_on("cedar", None), ToolWanted::Removed, "a value Arbor can't read is left out");
        assert_eq!(tools.problems.len(), 6, "{:?}", tools.problems);
        assert!(parse_tools(b"[1]").problems[0].contains("isn't a JSON object"));
    }

    #[test]
    fn a_pin_matches_the_versions_that_start_with_it() {
        assert!(matches_pin("22.17.0", "22") && matches_pin("v22.17.0", "22.17") && matches_pin("1.26.1", "1.26"));
        assert!(!matches_pin("24.1.0", "22") && !matches_pin("1.2.0", "1.26") && !matches_pin("0.9", "0.9.1"));
        assert!(matches_pin("1.90.0-nightly", "1.90"));
    }

    #[test]
    fn a_tool_is_listed_given_a_machines_own_and_taken_out() {
        let listed = with_tool(None, "uv", None, Some("latest")).unwrap();
        let pinned = with_tool(Some(listed.as_bytes()), "node", None, Some("22")).unwrap();
        let own = with_tool(Some(pinned.as_bytes()), "node", Some("ci-01"), Some("own")).unwrap();
        let tools = parse_tools(own.as_bytes());
        assert_eq!(tools.tools.iter().find(|tool| tool.tool == "node").unwrap().wanted_on("ci01", None), ToolWanted::Own);
        // The same machine named another way is the same entry.
        let back = with_tool(Some(own.as_bytes()), "node", Some("CI 01"), None).unwrap();
        assert_eq!(back, pinned);
        let gone = with_tool(Some(back.as_bytes()), "node", None, None).unwrap();
        assert_eq!(gone, listed);
        assert!(with_tool(Some(listed.as_bytes()), "go", Some("ci-01"), Some("own")).unwrap_err().contains("doesn't list go"));
        assert!(with_tool(Some(b"not json"), "go", None, Some("latest")).unwrap_err().contains("isn't JSON"));
    }
}

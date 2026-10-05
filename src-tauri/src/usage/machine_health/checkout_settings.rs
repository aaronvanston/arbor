//! Claude Code settings Arbor sets in a project's checkouts, for the setup repo's project values:
//! a skill turned on or off in one project, in each checkout's own .claude/settings.local.json, and
//! an MCP server kept out of one (denied there by name) or set up for it alone, with Claude Code's
//! own `claude mcp add-json --scope local` run in the checkout. That keeps the server in
//! ~/.claude.json the way Claude Code would for a person there; Arbor never writes that file.
//!
//! That file is Claude Code's local scope. Git doesn't see it (Claude Code puts it in the global
//! excludes the first time it writes one), and it wins over the machine's settings and the project's
//! checked-in .claude/settings.json, which Arbor never writes. A checkout where Git would see a new
//! file is left alone. Each file is changed the careful way (guarded_writes): only while it's as
//! Arbor read it, backed up first, and listed on Sync › Repo › History to undo.

use super::guarded_writes::{edit_call, edit_finish, edit_outcomes, edit_start, new_stamp, run_on, ChangeKind, Edit, EditFile, EditOutcome};
use super::setup::covered_machine;
use super::shell::shell_quote;
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ts_rs::TS;

/// The file in a checkout Arbor writes.
const LOCAL_SETTINGS: &str = ".claude/settings.local.json";
/// Larger than any settings file Arbor would write into.
const SETTINGS_MAX_BYTES: usize = 262_144;

/// A skill to turn on or off in one checkout.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckoutSkillChange {
    checkout: String,
    skill: String,
    on: bool,
}

/// How a checkout change went.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CheckoutOutcome {
    Done,
    /// The checkout already had it so.
    Already,
    /// The file changed while Arbor was writing, so nothing was.
    Changed,
    /// The checkout has no settings.local.json yet and Git would see a new one, so Arbor left it alone.
    NotIgnored,
    /// Its settings.local.json isn't a file Arbor writes: a link, too large, or not JSON with an object.
    Unusable,
    /// Claude Code ignores that file's skillOverrides already, as one value isn't one it knows.
    Ignored,
    /// The checkout isn't there any more.
    Missing,
    /// The checkout's checked-in settings, the machine's settings or its policy deny the server, which nothing
    /// turns back on.
    Denied,
    /// Someone turned the server off in this checkout with /mcp, which only /mcp there turns back on.
    Toggled,
    /// The repo doesn't set the server up for this machine's Claude Code, so there's nothing to set up.
    NoDefinition,
    /// The checkout has an instruction file of someone's own there, which Arbor leaves alone.
    Own,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckoutSkillResult {
    checkout: String,
    skill: String,
    outcome: CheckoutOutcome,
}

// Lines out, for checkout n (its path given as `checkout n path` lines on the way in):
//   C n missing|link          no folder there, or its .claude is a link, so nothing's written
//   F n sum                   its settings.local.json: `sum` as cksum says it, then its base64 and a `.` line
//   F n link|large            one Arbor won't read or write
//   N n ignored|seen          no file yet: whether Git ignores one there
fn read_script(checkouts: &[&str]) -> String {
    let mut script = String::from(
        "set -u\nexport LC_ALL=C\n\
         command -v base64 >/dev/null 2>&1 || { echo \"base64 isn't installed on this machine\" >&2; exit 3; }\n\
         checkout() {\n\
         \x20 n=$1; d=$2; f=\"$d/.claude/settings.local.json\"\n\
         \x20 if [ ! -d \"$d\" ]; then printf 'C\\t%s\\tmissing\\n' \"$n\"; return 0; fi\n\
         \x20 if [ -L \"$d/.claude\" ]; then printf 'C\\t%s\\tlink\\n' \"$n\"; return 0; fi\n\
         \x20 if [ -L \"$f\" ]; then printf 'F\\t%s\\tlink\\n' \"$n\"; return 0; fi\n\
         \x20 if [ -f \"$f\" ]; then\n\
         \x20   if [ \"$(wc -c < \"$f\" | tr -d ' ')\" -gt ",
    );
    script.push_str(&format!(
        "{SETTINGS_MAX_BYTES} ]; then printf 'F\\t%s\\tlarge\\n' \"$n\"; return 0; fi\n\
         \x20   printf 'F\\t%s\\t%s\\n' \"$n\" \"$(cksum < \"$f\" | awk '{{ printf \"c%s-%s\", $1, $2 }}')\"\n\
         \x20   base64 < \"$f\"; printf '.\\n'\n\
         \x20 elif git -C \"$d\" check-ignore -q .claude/settings.local.json 2>/dev/null; then printf 'N\\t%s\\tignored\\n' \"$n\"\n\
         \x20 else printf 'N\\t%s\\tseen\\n' \"$n\"; fi\n\
         }}\n"
    ));
    for (n, path) in checkouts.iter().enumerate() {
        script.push_str(&format!("checkout {n} {}\n", shell_quote(path)));
    }
    script
}

/// What the read found in a checkout.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Found {
    /// A settings.local.json Arbor can write: its fingerprint and content.
    File { sum: String, content: String },
    /// No file, and Git ignores one there.
    NoFile,
    Missing,
    NotIgnored,
    Unusable,
}

fn parse_read(stdout: &str, count: usize) -> Vec<Found> {
    let mut found = vec![Found::Missing; count];
    let mut lines = stdout.lines();
    while let Some(line) = lines.next() {
        let fields: Vec<&str> = line.split('\t').collect();
        let (tag, n, what) = match fields.as_slice() {
            [tag, n, what] => (*tag, *n, *what),
            _ => continue,
        };
        let Some(slot) = n.parse::<usize>().ok().and_then(|n| found.get_mut(n)) else { continue };
        *slot = match (tag, what) {
            ("C", "missing") => Found::Missing,
            ("C", _) | ("F", "link") | ("F", "large") => Found::Unusable,
            ("N", "ignored") => Found::NoFile,
            ("N", _) => Found::NotIgnored,
            ("F", sum) => {
                let mut encoded = String::new();
                for line in lines.by_ref() {
                    if line == "." {
                        break;
                    }
                    encoded.push_str(line.trim());
                }
                match STANDARD.decode(encoded.as_bytes()).ok().and_then(|bytes| String::from_utf8(bytes).ok()) {
                    Some(content) if is_fingerprint(sum) => Found::File { sum: sum.to_string(), content },
                    _ => Found::Unusable,
                }
            }
            _ => continue,
        };
    }
    found
}

fn is_fingerprint(sum: &str) -> bool {
    sum.strip_prefix('c').and_then(|rest| rest.split_once('-')).is_some_and(|(crc, size)| {
        !crc.is_empty() && !size.is_empty() && crc.bytes().all(|byte| byte.is_ascii_digit()) && size.bytes().all(|byte| byte.is_ascii_digit())
    })
}

/// The file's content with each skill in `wanted` overridden on or off, or the outcome that stops it: Ignored when
/// the file's skillOverrides are ones Claude Code already ignores, Already when nothing would change.
fn with_overrides(content: Option<&str>, wanted: &[(&str, bool)]) -> Result<String, CheckoutOutcome> {
    let current = match content.map(|text| text.trim_start_matches('\u{feff}')).filter(|text| !text.trim().is_empty()) {
        Some(text) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(root)) => root.get("skillOverrides").cloned(),
            _ => return Err(CheckoutOutcome::Unusable),
        },
        None => None,
    };
    let mut overrides = match &current {
        Some(value) => match (value.as_object(), super::setup::parse_overrides(value)) {
            (Some(map), Some(_)) => map.clone(),
            _ => return Err(CheckoutOutcome::Ignored),
        },
        None => serde_json::Map::new(),
    };
    for (skill, on) in wanted {
        overrides.insert(skill.to_string(), Value::from(if *on { "on" } else { "off" }));
    }
    let next = Value::Object(overrides);
    match super::attention::set_claude_setting(content, "skillOverrides", next.clone(), |now| now == Some(&next)) {
        Ok(Some(text)) => Ok(text),
        Ok(None) => Err(CheckoutOutcome::Already),
        Err(_) => Err(CheckoutOutcome::Unusable),
    }
}

/// The file's content with each server in `wanted` denied by name (off) or its name entries taken out (on), or the
/// outcome that stops it: Already when nothing would change. Entries by URL or command are left as they are.
fn with_denied(content: Option<&str>, wanted: &[(&str, bool)]) -> Result<String, CheckoutOutcome> {
    let current = match content.map(|text| text.trim_start_matches('\u{feff}')).filter(|text| !text.trim().is_empty()) {
        Some(text) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(root)) => root.get("deniedMcpServers").cloned(),
            _ => return Err(CheckoutOutcome::Unusable),
        },
        None => None,
    };
    let mut entries = match current {
        Some(Value::Array(entries)) => entries,
        Some(_) => return Err(CheckoutOutcome::Unusable),
        None => Vec::new(),
    };
    let named = |entry: &Value, name: &str| entry.get("serverName").and_then(Value::as_str) == Some(name);
    for (name, on) in wanted {
        if *on {
            entries.retain(|entry| !named(entry, name));
        } else if !entries.iter().any(|entry| named(entry, name)) {
            entries.push(serde_json::json!({ "serverName": name }));
        }
    }
    let next = Value::Array(entries);
    let unchanged = |now: Option<&Value>| now == Some(&next) || (now.is_none() && next.as_array().is_some_and(Vec::is_empty));
    match super::attention::set_claude_setting(content, "deniedMcpServers", next.clone(), unchanged) {
        Ok(Some(text)) => Ok(text),
        Ok(None) => Err(CheckoutOutcome::Already),
        Err(_) => Err(CheckoutOutcome::Unusable),
    }
}

/// Turns skills on or off in checkouts of a project on `machine`, each in its own settings.local.json. Only
/// checkouts the machine's last Projects scan found are changed.
#[tauri::command]
pub(crate) async fn apply_checkout_skills(
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    changes: Vec<CheckoutSkillChange>,
) -> Result<Vec<CheckoutSkillResult>, String> {
    if changes.is_empty() {
        return Err("There's nothing to change".into());
    }
    if let Some(change) = changes.iter().find(|change| !is_skill_name(&change.skill)) {
        return Err(format!("{} isn't a skill's name", change.skill));
    }
    let (target, known) = {
        let inner = state.lock();
        let (target, _) = covered_machine(&inner, &machine)?;
        (target, inner.projects.get(&machine).map(|projects| projects.checkout_paths()).unwrap_or_default())
    };
    if let Some(change) = changes.iter().find(|change| !known.contains(&change.checkout)) {
        return Err(format!("Arbor hasn't found {} on {machine}. Scan its projects again.", change.checkout));
    }
    let checkouts: Vec<&str> = {
        let mut seen: Vec<&str> = Vec::new();
        for change in &changes {
            if !seen.contains(&change.checkout.as_str()) {
                seen.push(&change.checkout);
            }
        }
        seen
    };
    let found = parse_read(&run_on(&target, MachineOp::ClaudeSettingsRead, &read_script(&checkouts)).await?, checkouts.len());
    let mut outcomes: Vec<(usize, CheckoutOutcome)> = Vec::new();
    let mut edits: Vec<(usize, Edit, bool)> = Vec::new();
    for (index, (checkout, found)) in checkouts.iter().zip(&found).enumerate() {
        let wanted: Vec<(&str, bool)> = changes.iter().filter(|change| change.checkout == *checkout).map(|change| (change.skill.as_str(), change.on)).collect();
        let (content, before) = match found {
            Found::File { sum, content } => (Some(content.as_str()), sum.clone()),
            Found::NoFile => (None, "-".to_string()),
            Found::Missing => { outcomes.push((index, CheckoutOutcome::Missing)); continue; }
            Found::NotIgnored => { outcomes.push((index, CheckoutOutcome::NotIgnored)); continue; }
            Found::Unusable => { outcomes.push((index, CheckoutOutcome::Unusable)); continue; }
        };
        match with_overrides(content, &wanted) {
            Ok(text) => edits.push((
                index,
                Edit { file: EditFile::Path(format!("{checkout}/{LOCAL_SETTINGS}")), before, content: text.into_bytes() },
                content.is_none(),
            )),
            Err(outcome) => outcomes.push((index, outcome)),
        }
    }
    if !edits.is_empty() {
        let mut script = format!("set -u\nexport LC_ALL=C\n{}", edit_start(&new_stamp(), ChangeKind::Checkouts));
        for (n, (index, edit, new)) in edits.iter().enumerate() {
            if *new {
                // A new file needs its folder; the read found no link there.
                script.push_str(&format!("mkdir -p {}/.claude\n", shell_quote(checkouts[*index])));
            }
            script.push_str(&edit_call(n, edit));
        }
        script.push_str(&edit_finish());
        let written = edit_outcomes(&run_on(&target, MachineOp::ClaudeSettingsWrite, &script).await?);
        for (n, (index, _, _)) in edits.iter().enumerate() {
            let outcome = match written.get(&n) {
                Some(EditOutcome::Done) => CheckoutOutcome::Done,
                Some(EditOutcome::Changed) => CheckoutOutcome::Changed,
                _ => CheckoutOutcome::Failed,
            };
            outcomes.push((*index, outcome));
        }
    }
    Ok(changes
        .iter()
        .map(|change| {
            let index = checkouts.iter().position(|checkout| *checkout == change.checkout).unwrap_or_default();
            let outcome = outcomes.iter().find(|(at, _)| *at == index).map(|(_, outcome)| *outcome).unwrap_or(CheckoutOutcome::Failed);
            CheckoutSkillResult { checkout: change.checkout.clone(), skill: change.skill.clone(), outcome }
        })
        .collect())
}

/// An MCP server to keep out of one checkout, or have there.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckoutMcpChange {
    checkout: String,
    server: String,
    on: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckoutMcpResult {
    checkout: String,
    server: String,
    outcome: CheckoutOutcome,
}

/// A checkout's deny list edited, then the server set up there when it's to be on and the checkout doesn't have it.
struct McpPlan {
    checkout: String,
    server: String,
    /// The repo's definition, when Claude Code's local scope is to get it.
    add: Option<Value>,
}

// Each add says how it went: R n code add last-line, as setup_mcp's `said` does.
fn local_add_script(adds: &[(usize, &str, &str, &Value)]) -> String {
    let mut script = format!("{}{}{}", super::agents::AGENT_ENV, super::setup_mcp::APPLY_START, super::setup_mcp::CLAUDE_FUNCTIONS);
    for (n, checkout, name, definition) in adds {
        script.push_str(&format!(
            "if cd {} 2>/dev/null; then claude_run '' mcp add-json --scope local {} {}; said {n} add; else printf 'R\t%s\t1\tadd\tmissing\n' {n}; fi\ncd /\n",
            shell_quote(checkout),
            shell_quote(name),
            shell_quote(&definition.to_string()),
        ));
    }
    script
}

/// How each local add went, by its number: Done, Already when Claude Code says the checkout has it, Missing when the
/// folder's gone, Failed otherwise.
fn parse_adds(stdout: &str) -> BTreeMap<usize, CheckoutOutcome> {
    stdout
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.splitn(5, '\t').collect();
            let [tag, n, code, _, last] = fields.as_slice() else { return None };
            if *tag != "R" {
                return None;
            }
            let outcome = match (*code, *last) {
                ("0", _) => CheckoutOutcome::Done,
                (_, "missing") => CheckoutOutcome::Missing,
                // Claude Code's own words for a name the checkout already has.
                (_, last) if last.contains("already exists") => CheckoutOutcome::Already,
                _ => CheckoutOutcome::Failed,
            };
            Some((n.parse().ok()?, outcome))
        })
        .collect()
}

/// Keeps MCP servers out of checkouts of a project on `machine`, or has them there, as the setup repo's last commit
/// defines them. Only checkouts the machine's last Projects scan found are changed.
#[tauri::command]
pub(crate) async fn apply_checkout_mcp(
    state: tauri::State<'_, MachineHealthState>,
    repo: String,
    machine: String,
    changes: Vec<CheckoutMcpChange>,
) -> Result<Vec<CheckoutMcpResult>, String> {
    if changes.is_empty() {
        return Err("There's nothing to change".into());
    }
    if let Some(change) = changes.iter().find(|change| !is_skill_name(&change.server)) {
        return Err(format!("{} isn't an MCP server's name", change.server));
    }
    let registry = super::setup_mcp::latest_registry(Path::new(&repo)).await?;
    let mut results: Vec<CheckoutMcpResult> = Vec::new();
    let mut plans: Vec<McpPlan> = Vec::new();
    let target = {
        let inner = state.lock();
        let (target, setup) = covered_machine(&inner, &machine)?;
        let projects = inner.projects.get(&machine);
        for change in &changes {
            let Some(found) = projects.and_then(|projects| projects.checkout_mcp(&change.checkout, &change.server)) else {
                return Err(format!("Arbor hasn't found {} on {machine}. Scan its projects again.", change.checkout));
            };
            let result = |outcome| CheckoutMcpResult { checkout: change.checkout.clone(), server: change.server.clone(), outcome };
            if change.on && (found.denied_shared || setup.home_denies("~/.claude", &change.server)) {
                results.push(result(CheckoutOutcome::Denied));
                continue;
            }
            if change.on && found.disabled {
                results.push(result(CheckoutOutcome::Toggled));
                continue;
            }
            let there = found.local || setup.home_servers("~/.claude").contains_key(change.server.as_str());
            let add = if change.on && !there {
                match registry.checkout_definition(&machine, setup.home_dir(), &change.server)? {
                    Some(definition) => Some(definition),
                    None => {
                        results.push(result(CheckoutOutcome::NoDefinition));
                        continue;
                    }
                }
            } else {
                None
            };
            plans.push(McpPlan { checkout: change.checkout.clone(), server: change.server.clone(), add });
        }
        target
    };
    if plans.is_empty() {
        return Ok(results);
    }
    let checkouts: Vec<&str> = {
        let mut seen: Vec<&str> = Vec::new();
        for plan in &plans {
            if !seen.contains(&plan.checkout.as_str()) {
                seen.push(&plan.checkout);
            }
        }
        seen
    };
    let found = parse_read(&run_on(&target, MachineOp::ClaudeSettingsRead, &read_script(&checkouts)).await?, checkouts.len());
    // Each checkout's file outcome; None when its deny list needed nothing.
    let mut files: Vec<Option<CheckoutOutcome>> = vec![None; checkouts.len()];
    let mut edits: Vec<(usize, Edit, bool)> = Vec::new();
    for (index, (checkout, found)) in checkouts.iter().zip(&found).enumerate() {
        let wanted: Vec<(&str, bool)> = plans.iter().filter(|plan| plan.checkout == *checkout).map(|plan| (plan.server.as_str(), plan.add.is_some() || changes.iter().any(|change| change.checkout == plan.checkout && change.server == plan.server && change.on))).collect();
        let (content, before) = match found {
            Found::File { sum, content } => (Some(content.as_str()), sum.clone()),
            // Nothing to take out of a file that isn't there; turning off needs one, which Git has to ignore.
            Found::NoFile | Found::NotIgnored if wanted.iter().all(|(_, on)| *on) => continue,
            Found::NoFile => (None, "-".to_string()),
            Found::Missing => { files[index] = Some(CheckoutOutcome::Missing); continue; }
            Found::NotIgnored => { files[index] = Some(CheckoutOutcome::NotIgnored); continue; }
            Found::Unusable => { files[index] = Some(CheckoutOutcome::Unusable); continue; }
        };
        match with_denied(content, &wanted) {
            Ok(text) => edits.push((index, Edit { file: EditFile::Path(format!("{checkout}/{LOCAL_SETTINGS}")), before, content: text.into_bytes() }, content.is_none())),
            Err(CheckoutOutcome::Already) => {}
            Err(outcome) => files[index] = Some(outcome),
        }
    }
    if !edits.is_empty() {
        let mut script = format!("set -u\nexport LC_ALL=C\n{}", edit_start(&new_stamp(), ChangeKind::Checkouts));
        for (n, (index, edit, new)) in edits.iter().enumerate() {
            if *new {
                script.push_str(&format!("mkdir -p {}/.claude\n", shell_quote(checkouts[*index])));
            }
            script.push_str(&edit_call(n, edit));
        }
        script.push_str(&edit_finish());
        let written = edit_outcomes(&run_on(&target, MachineOp::ClaudeSettingsWrite, &script).await?);
        for (n, (index, _, _)) in edits.iter().enumerate() {
            files[*index] = Some(match written.get(&n) {
                Some(EditOutcome::Done) => CheckoutOutcome::Done,
                Some(EditOutcome::Changed) => CheckoutOutcome::Changed,
                _ => CheckoutOutcome::Failed,
            });
        }
    }
    let file_of = |checkout: &str| checkouts.iter().position(|entry| *entry == checkout).and_then(|index| files.get(index).copied().flatten());
    // A server is only set up where the deny list went as it should.
    let adds: Vec<(usize, &str, &str, &Value)> = plans
        .iter()
        .enumerate()
        .filter(|(_, plan)| matches!(file_of(&plan.checkout), None | Some(CheckoutOutcome::Done)))
        .filter_map(|(n, plan)| Some((n, plan.checkout.as_str(), plan.server.as_str(), plan.add.as_ref()?)))
        .collect();
    let added = if adds.is_empty() {
        BTreeMap::new()
    } else {
        // The Projects scan the card runs next finds each server in its checkout.
        let output = run_on_machine(&target, MachineOp::McpApply, &local_add_script(&adds), LOCAL_ADD_TIMEOUT).await?;
        parse_adds(&String::from_utf8_lossy(&output.stdout))
    };
    for (n, plan) in plans.iter().enumerate() {
        let file = file_of(&plan.checkout);
        let outcome = match (plan.add.is_some(), file) {
            (_, Some(outcome)) if outcome != CheckoutOutcome::Done => outcome,
            (true, _) => added.get(&n).copied().unwrap_or(CheckoutOutcome::Failed),
            (false, Some(outcome)) => outcome,
            (false, None) => CheckoutOutcome::Already,
        };
        results.push(CheckoutMcpResult { checkout: plan.checkout.clone(), server: plan.server.clone(), outcome });
    }
    Ok(results)
}

/// Claude Code starts once for each server it sets up.
const LOCAL_ADD_TIMEOUT: Duration = Duration::from_secs(5 * 60);

fn is_skill_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128 && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) && !name.starts_with('.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_checkouts_overrides_are_set_beside_whatever_else_the_file_holds() {
        let text = "{\n  \"enabledPlugins\": {\"a@b\": true},\n  \"skillOverrides\": {\"pdf\": \"name-only\"}\n}\n";
        let next = with_overrides(Some(text), &[("frontend-design", false), ("pdf", true)]).unwrap();
        let value: Value = serde_json::from_str(&next).unwrap();
        assert_eq!(value["enabledPlugins"]["a@b"], Value::Bool(true));
        assert_eq!(value["skillOverrides"]["pdf"], "on");
        assert_eq!(value["skillOverrides"]["frontend-design"], "off");
        // Keys keep their order.
        assert!(next.find("enabledPlugins").unwrap() < next.find("skillOverrides").unwrap());
        assert_eq!(with_overrides(Some(&next), &[("pdf", true)]), Err(CheckoutOutcome::Already));
        let fresh: Value = serde_json::from_str(&with_overrides(None, &[("pdf", false)]).unwrap()).unwrap();
        assert_eq!(fresh, serde_json::json!({ "skillOverrides": { "pdf": "off" } }));
    }

    #[test]
    fn a_file_claude_code_already_ignores_or_cant_read_is_left_alone() {
        assert_eq!(with_overrides(Some("{\"skillOverrides\": {\"pdf\": \"sometimes\"}}"), &[("pdf", false)]), Err(CheckoutOutcome::Ignored));
        assert_eq!(with_overrides(Some("[1, 2]"), &[("pdf", false)]), Err(CheckoutOutcome::Unusable));
        assert_eq!(with_overrides(Some("{not json"), &[("pdf", false)]), Err(CheckoutOutcome::Unusable));
    }

    #[test]
    fn the_read_says_which_checkouts_can_take_a_new_file() {
        let body = STANDARD.encode("{}");
        let stdout = format!("F\t0\tc123-2\n{body}\n.\nN\t1\tignored\nN\t2\tseen\nC\t3\tlink\nF\t4\tlarge\n");
        let found = parse_read(&stdout, 6);
        assert_eq!(found[0], Found::File { sum: "c123-2".into(), content: "{}".into() });
        assert_eq!(found[1..], [Found::NoFile, Found::NotIgnored, Found::Unusable, Found::Unusable, Found::Missing]);
    }

    #[cfg(unix)]
    #[test]
    fn the_read_script_finds_files_ignored_folders_and_links_on_disk() {
        use std::process::Command;
        let root = std::env::temp_dir().join(format!("arbor-checkout-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (ignored, seen, linked) = (root.join("ignored"), root.join("seen"), root.join("linked"));
        for dir in [&ignored, &seen, &linked] {
            std::fs::create_dir_all(dir).unwrap();
            assert!(Command::new("git").args(["init", "-q"]).current_dir(dir).status().unwrap().success());
        }
        std::fs::write(ignored.join(".git/info/exclude"), ".claude/settings.local.json\n").unwrap();
        std::fs::create_dir_all(root.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(root.join("elsewhere"), linked.join(".claude")).unwrap();
        let paths: Vec<String> = [&ignored, &seen, &linked].iter().map(|dir| dir.display().to_string()).chain([root.join("gone").display().to_string()]).collect();
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        for shell in ["sh", "dash"] {
            let Ok(output) = Command::new(shell).arg("-c").arg(read_script(&refs)).env("HOME", &root).env("XDG_CONFIG_HOME", root.join("config")).env("GIT_CONFIG_GLOBAL", "/dev/null").output() else { continue };
            let found = parse_read(&String::from_utf8_lossy(&output.stdout), refs.len());
            assert_eq!(found, [Found::NoFile, Found::NotIgnored, Found::Unusable, Found::Missing], "{shell}");
        }
        std::fs::create_dir_all(ignored.join(".claude")).unwrap();
        std::fs::write(ignored.join(".claude/settings.local.json"), "{\"model\": \"x\"}").unwrap();
        let output = Command::new("sh").arg("-c").arg(read_script(&refs[..1])).env("HOME", &root).output().unwrap();
        assert!(matches!(&parse_read(&String::from_utf8_lossy(&output.stdout), 1)[0], Found::File { content, .. } if content == "{\"model\": \"x\"}"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_checkout_denies_a_server_by_name_and_on_takes_only_that_name_out() {
        let text = "{\n  \"deniedMcpServers\": [{\"serverUrl\": \"https://x.example.com/*\"}, {\"serverName\": \"sentry\"}]\n}\n";
        let off: Value = serde_json::from_str(&with_denied(Some(text), &[("linear", false)]).unwrap()).unwrap();
        assert_eq!(off["deniedMcpServers"], serde_json::json!([{ "serverUrl": "https://x.example.com/*" }, { "serverName": "sentry" }, { "serverName": "linear" }]));
        assert_eq!(with_denied(Some(&off.to_string()), &[("linear", false)]), Err(CheckoutOutcome::Already));
        let on: Value = serde_json::from_str(&with_denied(Some(&off.to_string()), &[("sentry", true)]).unwrap()).unwrap();
        // Entries by URL stay; only the name Arbor was asked about goes.
        assert_eq!(on["deniedMcpServers"], serde_json::json!([{ "serverUrl": "https://x.example.com/*" }, { "serverName": "linear" }]));
        assert_eq!(with_denied(None, &[("linear", true)]), Err(CheckoutOutcome::Already));
        assert_eq!(serde_json::from_str::<Value>(&with_denied(None, &[("linear", false)]).unwrap()).unwrap(), serde_json::json!({ "deniedMcpServers": [{ "serverName": "linear" }] }));
        assert_eq!(with_denied(Some("{\"deniedMcpServers\": \"linear\"}"), &[("linear", false)]), Err(CheckoutOutcome::Unusable));
    }

    #[test]
    fn each_local_add_says_how_it_went() {
        let stdout = "R\t0\t0\tadd\tAdded stdio MCP server linear to local config\nR\t1\t1\tadd\tMCP server linear already exists in local config\nR\t2\t1\tadd\tmissing\nR\t3\t1\tadd\tError: Invalid configuration\n";
        let added = parse_adds(stdout);
        assert_eq!(added.values().copied().collect::<Vec<_>>(), [CheckoutOutcome::Done, CheckoutOutcome::Already, CheckoutOutcome::Missing, CheckoutOutcome::Failed]);
        let definition = serde_json::json!({ "type": "http", "url": "https://mcp.linear.app/mcp" });
        let script = local_add_script(&[(0, "/src/it's here", "linear", &definition)]);
        assert!(script.contains("mcp add-json --scope local 'linear'"));
        assert!(script.contains("cd '/src/it'\\''s here'"));
    }

    #[test]
    fn nothing_but_the_outcome_leaves_the_checkout_mcp_command() {
        // SECRET: the definition set up and the checkout's settings hold secrets; the results say which checkout, which server and how.
        let result = CheckoutMcpResult { checkout: "/src/a".into(), server: "linear".into(), outcome: CheckoutOutcome::Toggled };
        assert_eq!(serde_json::to_string(&result).unwrap(), "{\"checkout\":\"/src/a\",\"server\":\"linear\",\"outcome\":\"toggled\"}");
        let secret = "{\"env\": {\"API_TOKEN\": \"SECRET-123\"}}";
        assert!(with_denied(Some(secret), &[("linear", false)]).unwrap().contains("SECRET-123"));
    }

    #[test]
    fn nothing_but_the_outcome_leaves_the_command() {
        // SECRET: a checkout's settings may hold env values; the results say only which checkout, which skill and how.
        let result = CheckoutSkillResult { checkout: "/src/a".into(), skill: "pdf".into(), outcome: CheckoutOutcome::Done };
        let text = serde_json::to_string(&result).unwrap();
        assert_eq!(text, "{\"checkout\":\"/src/a\",\"skill\":\"pdf\",\"outcome\":\"done\"}");
        let secret = "{\"env\": {\"API_TOKEN\": \"SECRET-123\"}, \"skillOverrides\": {}}";
        let next = with_overrides(Some(secret), &[("pdf", false)]).unwrap();
        // The file keeps its own values, and nothing of them is reported.
        assert!(next.contains("SECRET-123"));
        assert!(!text.contains("SECRET"));
    }
}

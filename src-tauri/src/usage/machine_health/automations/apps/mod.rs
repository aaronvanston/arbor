//! The apps whose automations Arbor finds on a machine, one module each behind [`App`]: how its part of the scan
//! looks for it, how its lines are read, and what Arbor can ask of it (pause, run now). Adding an app is a module
//! here, its entry in [`APPS`] and a source in `AutomationSource`; the webview gives it a name, a mark and a note.

mod claude;
mod codex;
mod orca;
mod superset;
pub(super) mod ultradian;

use super::discover::Found;
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};

use super::super::guarded_writes::Edit;

/// How Arbor pauses, resumes or starts one of an app's automations.
pub(super) enum Change {
    /// A script run on the machine that keeps it.
    Script(String),
    /// A guarded write of the app's own file, which Sync › Repo › History can undo.
    Edit(Edit),
}

pub(super) trait App: Sync {
    fn source(&self) -> AutomationSource;
    /// The app as the errors name it ("the Codex app").
    fn name(&self) -> &'static str;
    /// The tags the lines of its part of the scan start with. No two apps, nor the scan's own `H` and the background
    /// runner's probe, share one.
    fn tags(&self) -> &'static [&'static str];
    /// Its part of the scan. `$homes` holds the machine's agent homes, one `agent<tab>home` a line, and `$tab` a tab.
    /// Nothing may read stdin: the script arrives on it.
    fn script(&self) -> &'static str;
    /// What it keeps on the machine, or None when it isn't there.
    fn parse(&self, scan: &ScanLines) -> Option<Vec<Found>>;
    fn set_enabled(&self, item: &Found, enabled: bool) -> Result<Change, String>;
    /// The script that starts a run now, where the app can be asked to.
    fn run_now(&self, _item: &Found) -> Result<String, String> {
        Err(format!("Only Orca and Superset can be asked to run their automations from here, not {}", self.name()))
    }
}

pub(super) const APPS: &[&dyn App] = &[&codex::CodexApp, &claude::Claude, &orca::Orca, &superset::Superset, &ultradian::Ultradian];

pub(super) fn for_source(source: AutomationSource) -> Option<&'static dyn App> {
    APPS.iter().copied().find(|app| app.source() == source)
}

/// A machine's scan, split into its tagged lines.
pub(super) struct ScanLines<'a> {
    pub(super) machine: &'a str,
    /// The machine's `$HOME`, for showing a path under it as `~`.
    pub(super) home: &'a str,
    lines: Vec<Vec<&'a str>>,
}

impl<'a> ScanLines<'a> {
    pub(super) fn new(machine: &'a str, stdout: &'a str) -> Self {
        let home = stdout.lines().find_map(|line| line.strip_prefix("H\t")).unwrap_or_default();
        ScanLines { machine, home, lines: stdout.lines().map(|line| line.split('\t').collect()).collect() }
    }

    /// Only the lines with these tags, so each app reads its own and no other's.
    pub(super) fn only(&self, tags: &[&str]) -> ScanLines<'a> {
        let lines = self.lines.iter().filter(|fields| fields.first().is_some_and(|tag| tags.contains(tag))).cloned().collect();
        ScanLines { machine: self.machine, home: self.home, lines }
    }

    /// The fields after the tag of each line with this tag.
    pub(super) fn tagged<'s>(&'s self, tag: &'s str) -> impl Iterator<Item = &'s [&'a str]> + 's {
        self.lines.iter().filter_map(move |fields| match fields.split_first() {
            Some((first, rest)) if *first == tag => Some(rest),
            _ => None,
        })
    }

    /// The first field of the first line with this tag.
    pub(super) fn first(&self, tag: &str) -> Option<&'a str> {
        self.tagged(tag).next().and_then(|fields| fields.first().copied())
    }
}

pub(super) fn unbase(text: &str) -> Vec<u8> {
    STANDARD.decode(text.trim()).unwrap_or_default()
}

pub(super) fn summary(id: String, source: AutomationSource, name: String, enabled: bool, machine: &str, abilities: AutomationAbilities) -> AutomationSummary {
    AutomationSummary {
        id,
        source,
        name,
        enabled,
        machine: Some(machine.to_string()),
        target: AutomationTarget::Machine { name: machine.to_string() },
        project: None,
        agent: None,
        model: None,
        schedule: ScheduleSummary::Elsewhere,
        next_run_at_ms: None,
        last_run: None,
        has_precheck: false,
        abilities,
        runs_on: AutomationRunsOn::App,
    }
}

pub(super) fn found_automation(summary: AutomationSummary, prompt: String, rrule: Option<String>) -> Automation {
    Automation {
        summary,
        prompt,
        rrule,
        timezone: None,
        project_path: None,
        workspace: AutomationWorkspace::Checkout,
        session: AutomationSession::Fresh,
        access: AutomationAccess::Edits,
        model: None,
        effort: None,
        precheck: None,
        precheck_timeout_secs: 0,
        grace_minutes: 0,
        source_path: None,
        created_at_ms: None,
        updated_at_ms: None,
    }
}

/// The folder an automation's file is in, which the apps name it by.
pub(super) fn folder_name(path: &str) -> String {
    path.rsplit('/').nth(1).unwrap_or(path).to_string()
}

/// A string field of a JSON object.
pub(super) fn text(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key).and_then(serde_json::Value::as_str).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn no_two_apps_print_the_same_tag() {
        // The scan's own home line, and the background runner's probe (`udian::PROBE_SCRIPT`).
        let mut seen: BTreeSet<&str> = ["H", "U", "V", "D", "W"].into();
        for app in APPS {
            for tag in app.tags() {
                assert!(seen.insert(tag), "{tag} is printed by more than one part of the scan");
            }
        }
    }

    #[test]
    fn each_app_prints_only_its_own_tags_and_reads_no_stdin() {
        for app in APPS {
            let script = app.script();
            for printed in script.split("printf '").skip(1) {
                let tag = printed.split("\\t").next().unwrap_or_default();
                // A format that isn't a tagged line (`printf '%s' "$runs"`).
                if !tag.chars().all(|char| char.is_ascii_uppercase()) {
                    continue;
                }
                assert!(app.tags().contains(&tag), "{} prints {tag}, which isn't one of its tags", app.name());
            }
            for line in script.lines().filter(|line| line.contains("orca ") || line.contains("superset ")) {
                assert!(line.contains("</dev/null") || !line.contains("--json") && !line.contains("--quiet"), "{line}");
            }
        }
    }

    #[test]
    fn every_source_but_arbors_has_an_app() {
        for source in [AutomationSource::CodexApp, AutomationSource::ClaudeDesktop, AutomationSource::Orca, AutomationSource::Superset, AutomationSource::Ultradian] {
            assert_eq!(for_source(source).map(|app| app.source()), Some(source));
        }
        assert!(for_source(AutomationSource::Arbor).is_none());
    }
}

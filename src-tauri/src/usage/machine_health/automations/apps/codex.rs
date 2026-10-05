//! The Codex app's automations: one `automation.toml` in each Codex home's `automations` folder. Pausing one sets
//! its `status` line through a guarded write.

use super::super::super::agent_homes::tilde;
use super::super::super::guarded_writes::{cksum, Edit, EditFile};
use super::super::discover::{Found, Keeper};
use super::*;

pub(super) struct CodexApp;

// `C path base64` for each automation (its first 64 KB).
const SCRIPT: &str = r#"while IFS=$tab read -r agent home; do
  [ "$agent" = codex ] || continue
  for f in "$home"/automations/*/automation.toml; do [ -f "$f" ] || continue; printf 'C\t%s\t%s\n' "$f" "$(head -c 65536 "$f" | base64 | tr -d '\n')"; done
done <<ARBOR_HOMES
$homes
ARBOR_HOMES
"#;

impl App for CodexApp {
    fn source(&self) -> AutomationSource {
        AutomationSource::CodexApp
    }

    fn name(&self) -> &'static str {
        "the Codex app"
    }

    fn tags(&self) -> &'static [&'static str] {
        &["C"]
    }

    fn script(&self) -> &'static str {
        SCRIPT
    }

    fn parse(&self, scan: &ScanLines) -> Option<Vec<Found>> {
        let found: Vec<Found> = scan
            .tagged("C")
            .filter_map(|fields| match fields {
                [path, content] => automation(scan.machine, scan.home, path, unbase(content)),
                _ => None,
            })
            .collect();
        (!found.is_empty()).then_some(found)
    }

    fn set_enabled(&self, item: &Found, enabled: bool) -> Result<Change, String> {
        let Keeper::File { path, content } = &item.keeper else {
            return Err("Arbor couldn't read that automation's file".into());
        };
        let after = codex_with_status(content, enabled).ok_or("Arbor couldn't read that automation's file")?;
        Ok(Change::Edit(Edit { file: EditFile::Path(path.clone()), before: cksum(content), content: after }))
    }
}

/// A Codex app automation: `name`, `prompt`, `rrule`, `status` (ACTIVE or PAUSED) and its times in ms.
fn automation(machine: &str, home: &str, path: &str, content: Vec<u8>) -> Option<Found> {
    let text = String::from_utf8(content.clone()).ok()?;
    let table: toml::Table = text.parse().ok()?;
    let string = |key: &str| table.get(key).and_then(toml::Value::as_str).map(str::to_string);
    let number = |key: &str| table.get(key).and_then(toml::Value::as_integer);
    let folder = folder_name(path);
    let name = string("name").unwrap_or_else(|| folder.clone());
    let enabled = string("status").is_none_or(|status| status.eq_ignore_ascii_case("ACTIVE"));
    let rrule = string("rrule");
    let mut summary = summary(
        format!("codexApp:{machine}:{folder}"),
        AutomationSource::CodexApp,
        name,
        enabled,
        machine,
        AutomationAbilities { edit: false, pause: true, run_now: false, delete: false, copy: true },
    );
    summary.agent = Some(Harness::Codex);
    if let Some(rule) = &rrule {
        summary.schedule = schedule::summary(rule);
        if enabled {
            summary.next_run_at_ms = schedule::parse(rule).and_then(|rule| schedule::next_after(&rule, Local::now().timestamp_millis()));
        }
    }
    let mut automation = found_automation(summary, string("prompt").unwrap_or_default(), rrule);
    automation.source_path = Some(tilde(path, home));
    automation.created_at_ms = number("created_at");
    automation.updated_at_ms = number("updated_at");
    Some(Found { automation, found_on: machine.to_string(), keeper: Keeper::File { path: path.to_string(), content }, session: string("target_thread_id") })
}

/// A Codex app automation's file with its status set, every other line as it was.
fn codex_with_status(content: &[u8], enabled: bool) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(content).ok()?;
    let status = if enabled { "ACTIVE" } else { "PAUSED" };
    let mut replaced = false;
    let mut lines: Vec<String> = text
        .lines()
        .map(|line| {
            if !replaced && line.trim_start().starts_with("status") && line.contains('=') {
                replaced = true;
                format!("status = \"{status}\"")
            } else {
                line.to_string()
            }
        })
        .collect();
    if !replaced {
        lines.push(format!("status = \"{status}\""));
    }
    let mut out = lines.join("\n");
    if text.ends_with('\n') {
        out.push('\n');
    }
    Some(out.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODEX: &str = "version = 1\nid = \"inbox-triage\"\nkind = \"heartbeat\"\nname = \"Inbox triage\"\nprompt = \"Label new mail.\"\nstatus = \"PAUSED\"\nrrule = \"RRULE:FREQ=MINUTELY;INTERVAL=30\"\ntarget_thread_id = \"t-1\"\ncreated_at = 1783121815383\nupdated_at = 1784755440788\n";

    #[test]
    fn reads_an_automation_with_its_schedule_status_and_thread() {
        let stdout = format!("H\t/Users/cam\nC\t/Users/cam/.codex/automations/inbox-triage/automation.toml\t{}\n", STANDARD.encode(CODEX));
        let found = CodexApp.parse(&ScanLines::new("cam-mbp", &stdout)).unwrap();
        let codex = &found[0].automation;
        assert_eq!(codex.summary.id, "codexApp:cam-mbp:inbox-triage");
        assert_eq!(codex.summary.name, "Inbox triage");
        assert!(!codex.summary.enabled);
        assert_eq!(codex.summary.schedule, ScheduleSummary::EveryMinutes { minutes: 30 });
        assert_eq!(codex.summary.next_run_at_ms, None);
        assert_eq!(codex.prompt, "Label new mail.");
        assert_eq!(codex.source_path.as_deref(), Some("~/.codex/automations/inbox-triage/automation.toml"));
        assert_eq!(codex.created_at_ms, Some(1783121815383));
        assert_eq!(found[0].session.as_deref(), Some("t-1"));
        assert!(CodexApp.parse(&ScanLines::new("cam-mbp", "H\t/Users/cam\n")).is_none(), "none found, so not listed as there");
    }

    #[test]
    fn pauses_by_its_status_line_alone() {
        let paused = codex_with_status(CODEX.replace("PAUSED", "ACTIVE").as_bytes(), false).unwrap();
        assert_eq!(String::from_utf8(paused).unwrap(), CODEX);
        let resumed = String::from_utf8(codex_with_status(CODEX.as_bytes(), true).unwrap()).unwrap();
        assert!(resumed.contains("status = \"ACTIVE\"\n"));
        assert_eq!(resumed.lines().count(), CODEX.lines().count());
    }
}

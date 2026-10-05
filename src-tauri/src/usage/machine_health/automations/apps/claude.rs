//! Claude's scheduled tasks: a `SKILL.md` in each Claude home's `scheduled-tasks` folder. Claude keeps their
//! schedules itself, so Arbor only shows them and copies them.

use super::super::super::agent_homes::tilde;
use super::super::discover::{Found, Keeper};
use super::*;

pub(super) struct Claude;

// `S path base64` for each task (its first 64 KB).
const SCRIPT: &str = r#"while IFS=$tab read -r agent home; do
  [ "$agent" = claude ] || continue
  for f in "$home"/scheduled-tasks/*/SKILL.md; do [ -f "$f" ] || continue; printf 'S\t%s\t%s\n' "$f" "$(head -c 65536 "$f" | base64 | tr -d '\n')"; done
done <<ARBOR_HOMES
$homes
ARBOR_HOMES
"#;

impl App for Claude {
    fn source(&self) -> AutomationSource {
        AutomationSource::ClaudeDesktop
    }

    fn name(&self) -> &'static str {
        "Claude"
    }

    fn tags(&self) -> &'static [&'static str] {
        &["S"]
    }

    fn script(&self) -> &'static str {
        SCRIPT
    }

    fn parse(&self, scan: &ScanLines) -> Option<Vec<Found>> {
        let found: Vec<Found> = scan
            .tagged("S")
            .filter_map(|fields| match fields {
                [path, content] => Some(task(scan.machine, scan.home, path, unbase(content))),
                _ => None,
            })
            .collect();
        (!found.is_empty()).then_some(found)
    }

    fn set_enabled(&self, _item: &Found, _enabled: bool) -> Result<Change, String> {
        Err("Claude keeps this task's schedule itself. Pause it in Claude".into())
    }
}

/// A scheduled task: its SKILL.md's `name` and `description`, and the rest as the prompt.
fn task(machine: &str, home: &str, path: &str, content: Vec<u8>) -> Found {
    let text = String::from_utf8_lossy(&content);
    let (front, body) = match text.strip_prefix("---\n").and_then(|rest| rest.split_once("\n---")) {
        Some((front, body)) => (front.to_string(), body.trim_start_matches('-').trim().to_string()),
        None => (String::new(), text.trim().to_string()),
    };
    let field = |key: &str| {
        front.lines().find_map(|line| line.strip_prefix(&format!("{key}:")).map(|value| value.trim().trim_matches('"').to_string())).filter(|value| !value.is_empty())
    };
    let folder = folder_name(path);
    let name = field("description").filter(|description| description.len() <= 60).or_else(|| field("name")).unwrap_or_else(|| folder.clone());
    let mut summary = summary(
        format!("claudeDesktop:{machine}:{folder}"),
        AutomationSource::ClaudeDesktop,
        name,
        true,
        machine,
        AutomationAbilities { edit: false, pause: false, run_now: false, delete: false, copy: true },
    );
    summary.agent = Some(Harness::Claude);
    let mut automation = found_automation(summary, body, None);
    automation.source_path = Some(tilde(path, home));
    Found { automation, found_on: machine.to_string(), keeper: Keeper::File { path: path.to_string(), content: Vec::new() }, session: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_task_by_its_description_and_body() {
        let stdout = format!(
            "H\t/Users/cam\nS\t/Users/cam/.claude/scheduled-tasks/notes/SKILL.md\t{}\n",
            STANDARD.encode("---\nname: notes\ndescription: Meeting notes to wiki\n---\n\nAdd the newest notes to the wiki.\n"),
        );
        let found = Claude.parse(&ScanLines::new("cam-mbp", &stdout)).unwrap();
        let claude = &found[0].automation;
        assert_eq!(claude.summary.id, "claudeDesktop:cam-mbp:notes");
        assert_eq!(claude.summary.name, "Meeting notes to wiki");
        assert_eq!(claude.summary.schedule, ScheduleSummary::Elsewhere);
        assert_eq!(claude.prompt, "Add the newest notes to the wiki.");
        assert_eq!(claude.source_path.as_deref(), Some("~/.claude/scheduled-tasks/notes/SKILL.md"));
        assert!(!claude.summary.abilities.pause);
    }
}

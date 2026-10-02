//! Superset's automations, through its command line. Superset keeps them in its cloud for the whole organization, so
//! every machine signed in lists the same ones; `all_found` keeps one of each. Each runs on a host Superset names, or
//! in a Superset cloud workspace.
//!
//! Its list leaves out the prompts, so each automation's is asked for on its own, and its run history carries each
//! run's title, so only the last run's status and time are kept, picked out on the machine before anything is sent
//! back. The command line prints JSON two spaces deep, one field to a line, and a JSON string can't span lines, so a
//! field's line can't be faked by another field's text.

use super::super::super::agents::AGENT_ENV;
use super::super::super::shell::shell_quote;
use super::super::discover::{Found, Keeper};
use super::*;

pub(super) struct Superset;

// Where Superset's command line answers: `SL list` and `SH hosts`, each base64, then for the first 20 automations
// (each is a call of its own, and a big organization mustn't run the scan past its time; ids that aren't plain are
// skipped) `SP id prompt`, base64, and `SR id status createdAt`. A `superset` that isn't Superset's (Apache
// Superset's has the same name) prints no JSON list, which `parse` takes as no Superset.
const SCRIPT: &str = r##"if command -v superset >/dev/null 2>&1; then
  printf 'SL\t%s\n' "$(superset automations list --json </dev/null 2>/dev/null | base64 | tr -d '\n')"
  printf 'SH\t%s\n' "$(superset hosts list --json </dev/null 2>/dev/null | base64 | tr -d '\n')"
  n=0
  for id in $(superset automations list --quiet </dev/null 2>/dev/null); do
    case $id in ''|*[!A-Za-z0-9_-]*) continue ;; esac
    n=$((n + 1))
    [ "$n" -le 20 ] || break
    printf 'SP\t%s\t%s\n' "$id" "$(superset automations prompt get "$id" --json </dev/null 2>/dev/null | base64 | tr -d '\n')"
    run=$(superset automations logs "$id" --limit 1 --json </dev/null 2>/dev/null | grep -E '^    "(status|createdAt)": "')
    status=$(printf '%s\n' "$run" | sed -n 's/^    "status": "\([a-z_]*\)".*/\1/p' | head -n 1)
    at=$(printf '%s\n' "$run" | sed -n 's/^    "createdAt": "\([0-9TZ:.+-]*\)".*/\1/p' | head -n 1)
    if [ -n "$status" ]; then printf 'SR\t%s\t%s\t%s\n' "$id" "$status" "$at"; fi
  done
fi
"##;

impl App for Superset {
    fn source(&self) -> AutomationSource {
        AutomationSource::Superset
    }

    fn name(&self) -> &'static str {
        "Superset"
    }

    fn tags(&self) -> &'static [&'static str] {
        &["SL", "SH", "SP", "SR"]
    }

    fn script(&self) -> &'static str {
        SCRIPT
    }

    fn parse(&self, scan: &ScanLines) -> Option<Vec<Found>> {
        let list: Vec<serde_json::Value> = serde_json::from_slice(&unbase(scan.first("SL")?)).ok()?;
        let hosts: BTreeMap<String, String> = serde_json::from_slice::<Vec<serde_json::Value>>(&scan.first("SH").map(unbase).unwrap_or_default())
            .unwrap_or_default()
            .iter()
            .filter_map(|host| Some((text(host, "id")?, text(host, "name")?)))
            .collect();
        let prompts: BTreeMap<&str, String> = scan
            .tagged("SP")
            .filter_map(|fields| match fields {
                [id, content] => Some((*id, text(&serde_json::from_slice(&unbase(content)).ok()?, "prompt")?)),
                _ => None,
            })
            .collect();
        let runs: BTreeMap<&str, AutomationLastRun> = scan
            .tagged("SR")
            .filter_map(|fields| match fields {
                [id, status, at] => Some((*id, AutomationLastRun { status: run_status(status), at_ms: millis(at)? })),
                _ => None,
            })
            .collect();
        Some(list.iter().filter_map(|item| automation(scan.machine, item, &hosts, &prompts, &runs)).collect())
    }

    fn set_enabled(&self, item: &Found, enabled: bool) -> Result<Change, String> {
        let id = id(item)?;
        let verb = if enabled { "resume" } else { "pause" };
        Ok(Change::Script(format!("{AGENT_ENV}superset automations {verb} {} </dev/null >/dev/null\n", shell_quote(id))))
    }

    fn run_now(&self, item: &Found) -> Result<String, String> {
        Ok(format!("{AGENT_ENV}superset automations run {} </dev/null >/dev/null\n", shell_quote(id(item)?)))
    }
}

fn id(item: &Found) -> Result<&str, String> {
    match &item.keeper {
        Keeper::Id(id) => Ok(id),
        Keeper::File { .. } => Err("Arbor doesn't know Superset's id for this automation".into()),
    }
}

/// An ISO time, as Superset's JSON writes them, in ms.
fn millis(at: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(at).ok().map(|at| at.timestamp_millis())
}

/// A run's status. Superset's runs end once the session is handed to the host; what the agent does there is the
/// host's.
fn run_status(status: &str) -> AutomationRunStatus {
    match status {
        "dispatched" => AutomationRunStatus::Done,
        "dispatching" => AutomationRunStatus::Running,
        "skipped_offline" => AutomationRunStatus::Unreachable,
        "debounced" => AutomationRunStatus::Skipped,
        _ => AutomationRunStatus::Failed,
    }
}

fn automation(
    machine: &str,
    item: &serde_json::Value,
    hosts: &BTreeMap<String, String>,
    prompts: &BTreeMap<&str, String>,
    runs: &BTreeMap<&str, AutomationLastRun>,
) -> Option<Found> {
    let id = text(item, "id")?;
    let enabled = item.get("enabled").and_then(serde_json::Value::as_bool).unwrap_or(true);
    let prompt = prompts.get(id.as_str()).cloned();
    let mut summary = summary(
        format!("superset:{id}"),
        AutomationSource::Superset,
        text(item, "name").unwrap_or_else(|| id.clone()),
        enabled,
        machine,
        // A copy needs the prompt, which only the first automations' are asked for.
        AutomationAbilities { edit: false, pause: true, run_now: true, delete: false, copy: prompt.is_some() },
    );
    // On a host Superset knows by name, or in its cloud, which is no machine of Arbor's.
    summary.machine = text(item, "targetHostId").and_then(|host| hosts.get(&host).cloned());
    if let Some(name) = &summary.machine {
        summary.target = AutomationTarget::Machine { name: name.clone() };
    }
    summary.agent = text(item, "agent").map(|agent| Harness::from_id(&agent));
    let rrule = text(item, "rrule");
    summary.schedule = rrule.as_deref().map_or(ScheduleSummary::Custom, schedule::summary);
    summary.next_run_at_ms = text(item, "nextRunAt").and_then(|at| millis(&at)).filter(|_| enabled);
    summary.last_run = runs.get(id.as_str()).cloned();
    let mut automation = found_automation(summary, prompt.unwrap_or_default(), rrule);
    automation.timezone = text(item, "timezone");
    automation.session = if item.get("continueAgentSession").and_then(serde_json::Value::as_bool) == Some(true) { AutomationSession::Reuse } else { AutomationSession::Fresh };
    automation.created_at_ms = text(item, "createdAt").and_then(|at| millis(&at));
    automation.updated_at_ms = text(item, "updatedAt").and_then(|at| millis(&at));
    Some(Found { automation, found_on: machine.to_string(), keeper: Keeper::Id(id), session: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    fn b64(text: &str) -> String {
        STANDARD.encode(text)
    }

    const LIST: &str = r#"[
  {
    "id": "6f1c0d2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
    "organizationId": "org-1",
    "name": "Nightly triage",
    "agent": "claude",
    "targetHostId": "host-7",
    "v2ProjectId": "proj-1",
    "cloudWorkspaceId": null,
    "continueAgentSession": true,
    "enabled": true,
    "createdAt": "2026-09-30T08:00:00.000Z",
    "updatedAt": "2026-10-01T08:00:00.000Z",
    "rrule": "FREQ=DAILY;BYHOUR=2;BYMINUTE=0",
    "timezone": "Australia/Melbourne",
    "nextRunAt": "2026-10-03T16:00:00.000Z",
    "scheduleText": "Every day at 2:00 AM"
  },
  {
    "id": "cloud-1",
    "name": "Cloud docs",
    "agent": "codex",
    "targetHostId": null,
    "cloudWorkspaceId": "cw-1",
    "enabled": false,
    "rrule": null,
    "nextRunAt": "2026-10-03T16:00:00.000Z"
  }
]"#;

    fn scan() -> String {
        let id = "6f1c0d2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
        format!(
            "H\t/Users/casey\nSL\t{}\nSH\t{}\nSP\t{id}\t{}\nSR\t{id}\tskipped_offline\t2026-10-02T16:00:00.000Z\nSR\tcloud-1\tdispatched\t2026-10-01T16:00:00.000Z\n",
            b64(LIST),
            b64(r#"[{"id":"host-7","name":"cedar-02","online":"yes"}]"#),
            b64(&format!(r#"{{"id":"{id}","prompt":"Triage the new issues."}}"#)),
        )
    }

    #[test]
    fn reads_its_automations_with_hosts_prompts_and_last_runs() {
        let stdout = scan();
        let found = Superset.parse(&ScanLines::new("casey-mbp", &stdout)).unwrap();
        assert_eq!(found.len(), 2);
        let triage = &found[0].automation;
        assert_eq!(triage.summary.id, "superset:6f1c0d2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f");
        assert_eq!(triage.summary.machine.as_deref(), Some("cedar-02"));
        assert_eq!(triage.summary.target, AutomationTarget::Machine { name: "cedar-02".into() });
        assert_eq!(triage.summary.agent, Some(Harness::Claude));
        assert_eq!(triage.summary.schedule, schedule::summary("FREQ=DAILY;BYHOUR=2;BYMINUTE=0"));
        assert_eq!(triage.summary.next_run_at_ms, millis("2026-10-03T16:00:00.000Z"));
        assert_eq!(triage.summary.last_run.as_ref().map(|run| run.status), Some(AutomationRunStatus::Unreachable));
        assert!(triage.summary.abilities.copy && triage.summary.abilities.pause && triage.summary.abilities.run_now);
        assert_eq!(triage.prompt, "Triage the new issues.");
        assert_eq!(triage.session, AutomationSession::Reuse);
        assert_eq!(triage.timezone.as_deref(), Some("Australia/Melbourne"));
        assert_eq!(found[0].keeper, Keeper::Id("6f1c0d2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f".into()));

        // In Superset's cloud: no machine, paused so no next run, and no prompt asked for, so it can't be copied.
        let cloud = &found[1].automation;
        assert_eq!(cloud.summary.machine, None);
        assert_eq!(cloud.summary.target, AutomationTarget::Machine { name: "casey-mbp".into() });
        assert_eq!(cloud.summary.next_run_at_ms, None);
        assert_eq!(cloud.summary.schedule, ScheduleSummary::Custom);
        assert_eq!(cloud.summary.last_run.as_ref().map(|run| run.status), Some(AutomationRunStatus::Done));
        assert!(!cloud.summary.abilities.copy);
    }

    #[test]
    fn another_programs_superset_is_no_superset() {
        assert_eq!(Superset.parse(&ScanLines::new("casey-mbp", "SL\t\nSH\t\n")), None);
        assert_eq!(Superset.parse(&ScanLines::new("casey-mbp", &format!("SL\t{}\n", b64("Usage: superset [OPTIONS]")))), None);
        assert_eq!(Superset.parse(&ScanLines::new("casey-mbp", &format!("SL\t{}\n", b64("[]")))), Some(Vec::new()));
    }

    #[test]
    fn pauses_resumes_and_runs_by_its_id_quoted() {
        let stdout = scan();
        let found = Superset.parse(&ScanLines::new("casey-mbp", &stdout)).unwrap();
        let Ok(Change::Script(pause)) = Superset.set_enabled(&found[1], false) else { panic!("a script") };
        assert!(pause.ends_with("superset automations pause 'cloud-1' </dev/null >/dev/null\n"), "{pause}");
        let Ok(Change::Script(resume)) = Superset.set_enabled(&found[1], true) else { panic!("a script") };
        assert!(resume.contains("superset automations resume 'cloud-1'"));
        assert!(Superset.run_now(&found[1]).unwrap().contains("superset automations run 'cloud-1' </dev/null"));
    }

    /// Runs the scan against a stand-in `superset` in a temporary home, whose run history has a title made to look
    /// like a status line.
    #[test]
    fn the_scan_keeps_only_the_last_runs_status_and_time() {
        let home = std::env::temp_dir().join(format!("arbor-superset-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let stand_in = r#"#!/bin/sh
case "$1 $2" in
  "automations list") if [ "$3" = --quiet ]; then printf 'a-1\nbad;id\n'; else printf '[\n  {\n    "id": "a-1"\n  }\n]\n'; fi ;;
  "hosts list") printf '[]\n' ;;
  "automations prompt") printf '{\n  "id": "a-1",\n  "prompt": "Do it."\n}\n' ;;
  "automations logs") printf '[\n  {\n    "id": "r-1",\n    "title": "x\\n    \\"status\\": \\"rejected\\",",\n    "status": "dispatched",\n    "createdAt": "2026-10-02T16:00:00.000Z"\n  }\n]\n' ;;
esac
"#;
        let path = bin.join("superset");
        fs::write(&path, stand_in).unwrap();
        fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let output = run(&home, SCRIPT);
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let runs: Vec<&str> = stdout.lines().filter(|line| line.starts_with("SR\t")).collect();
        assert_eq!(runs, ["SR\ta-1\tdispatched\t2026-10-02T16:00:00.000Z"]);
        assert_eq!(stdout.lines().filter(|line| line.starts_with("SP\t")).count(), 1, "the id that isn't plain is skipped");
        assert!(!stdout.contains("title"));
        let found = Superset.parse(&ScanLines::new("casey-mbp", &stdout)).unwrap();
        assert_eq!(found[0].automation.prompt, "Do it.");
        let _ = fs::remove_dir_all(&home);
    }

    /// Without AGENT_ENV, whose folders come first, so a real `superset` on this Mac is never found and run.
    fn run(home: &Path, script: &str) -> std::process::Output {
        Command::new("sh")
            .arg("-c")
            .arg(script)
            .env_clear()
            .env("HOME", home)
            .env("PATH", format!("{}:/usr/bin:/bin", home.join("bin").display()))
            .output()
            .unwrap()
    }
}

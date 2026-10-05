//! Orca's automations, through its command line. Its run history carries each run's terminal output, so it's cut
//! down on the machine, by Node, which Orca's command line runs on, to each automation's last status, time and model
//! before anything is sent back.

use super::super::super::shell::shell_quote;
use super::super::super::agents::AGENT_ENV;
use super::super::discover::{Found, Keeper};
use super::*;

pub(super) struct Orca;

// Where Orca's command line is: `O list` (automations), `P projects`, `T hosts`, `R runs` (each automation's last
// run, cut down by Node), each base64.
const SCRIPT: &str = r##"if command -v orca >/dev/null 2>&1; then
  printf 'O\t%s\n' "$(orca automations list --json </dev/null 2>/dev/null | base64 | tr -d '\n')"
  printf 'P\t%s\n' "$(orca project list --json </dev/null 2>/dev/null | base64 | tr -d '\n')"
  printf 'T\t%s\n' "$(orca host list --json </dev/null 2>/dev/null | base64 | tr -d '\n')"
  if command -v node >/dev/null 2>&1; then
    runs=$(orca automations runs --json </dev/null 2>/dev/null | node -e '
let text = "";
process.stdin.on("data", (chunk) => { text += chunk; });
process.stdin.on("end", () => {
  let runs = [];
  try { runs = JSON.parse(text).result.runs || []; } catch (error) { runs = []; }
  const last = {};
  for (const run of runs) {
    const at = run.startedAt || run.scheduledFor || 0;
    if (!last[run.automationId] || last[run.automationId].at < at) last[run.automationId] = { status: String(run.status || ""), at, model: String((run.usage && run.usage.model) || "") };
  }
  process.stdout.write(JSON.stringify(last));
});' 2>/dev/null)
    printf 'R\t%s\n' "$(printf '%s' "$runs" | base64 | tr -d '\n')"
  fi
fi
"##;

impl App for Orca {
    fn source(&self) -> AutomationSource {
        AutomationSource::Orca
    }

    fn name(&self) -> &'static str {
        "Orca"
    }

    fn tags(&self) -> &'static [&'static str] {
        &["O", "P", "T", "R"]
    }

    fn script(&self) -> &'static str {
        SCRIPT
    }

    /// Orca's there when its command line is, even with nothing to list.
    fn parse(&self, scan: &ScanLines) -> Option<Vec<Found>> {
        let list = unbase(scan.first("O")?);
        let part = |tag: &str| scan.first(tag).map(unbase).unwrap_or_default();
        Some(automations(scan.machine, &list, &part("P"), &part("T"), &part("R")))
    }

    fn set_enabled(&self, item: &Found, enabled: bool) -> Result<Change, String> {
        let Keeper::Id(id) = &item.keeper else { return Err("Arbor doesn't know Orca's id for this automation".into()) };
        let flag = if enabled { "--enabled" } else { "--disabled" };
        Ok(Change::Script(format!("{AGENT_ENV}orca automations edit {} {flag} </dev/null >/dev/null\n", shell_quote(id))))
    }

    fn run_now(&self, item: &Found) -> Result<String, String> {
        let Keeper::Id(id) = &item.keeper else { return Err("Arbor doesn't know Orca's id for this automation".into()) };
        Ok(format!("{AGENT_ENV}orca automations run --id {} </dev/null >/dev/null\n", shell_quote(id)))
    }
}

/// The `result` of an Orca command's JSON, or what's under `key` in it.
fn result(bytes: &[u8], key: &str) -> Vec<serde_json::Value> {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return Vec::new();
    };
    let result = value.get("result").unwrap_or(&value);
    result.get(key).or(Some(result)).and_then(serde_json::Value::as_array).cloned().unwrap_or_default()
}

fn run_status(status: &str) -> AutomationRunStatus {
    match status {
        "completed" => AutomationRunStatus::Done,
        "running" | "dispatching" | "dispatched" => AutomationRunStatus::Running,
        "skipped_precheck" => AutomationRunStatus::Skipped,
        "skipped_unavailable" => AutomationRunStatus::Unreachable,
        "skipped_missed" => AutomationRunStatus::Missed,
        "canceled" | "cancelled" => AutomationRunStatus::Canceled,
        _ => AutomationRunStatus::Failed,
    }
}

/// Orca's automations, with the project and host named as Orca names them. One on Orca's own machine is on `machine`;
/// one on an SSH host is on the machine of that name.
fn automations(machine: &str, list: &[u8], projects: &[u8], hosts: &[u8], last_runs: &[u8]) -> Vec<Found> {
    // An automation names its project by one of the project's repositories, which Orca lists in `sourceRepoIds`.
    let mut project_names: BTreeMap<String, String> = BTreeMap::new();
    for project in result(projects, "projects") {
        let Some(name) = text(&project, "displayName") else { continue };
        let repos = project.get("sourceRepoIds").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
        for id in text(&project, "id").into_iter().chain(repos.iter().filter_map(|id| id.as_str().map(str::to_string))) {
            project_names.insert(id, name.clone());
        }
    }
    let host_names: BTreeMap<String, String> = result(hosts, "hosts").iter().filter_map(|host| Some((text(host, "id")?, text(host, "name")?))).collect();
    let last: BTreeMap<String, serde_json::Value> = serde_json::from_slice(last_runs).unwrap_or_default();
    result(list, "automations")
        .iter()
        .filter_map(|item| {
            let id = text(item, "id")?;
            let enabled = item.get("enabled").and_then(serde_json::Value::as_bool).unwrap_or(true);
            let on = match text(item, "executionTargetType").as_deref() {
                Some("ssh") => text(item, "executionTargetId").and_then(|target| host_names.get(&target).cloned()).unwrap_or_else(|| machine.to_string()),
                _ => machine.to_string(),
            };
            let mut summary = summary(
                format!("orca:{id}"),
                AutomationSource::Orca,
                text(item, "name").unwrap_or_else(|| id.clone()),
                enabled,
                &on,
                AutomationAbilities { edit: false, pause: true, run_now: true, delete: false, copy: true },
            );
            summary.project = text(item, "projectId").and_then(|project| project_names.get(&project).cloned());
            summary.agent = text(item, "agentId").map(|agent| Harness::from_id(&agent));
            let rrule = text(item, "rrule");
            summary.schedule = rrule.as_deref().map_or(ScheduleSummary::Custom, schedule::summary);
            summary.next_run_at_ms = item.get("nextRunAt").and_then(serde_json::Value::as_i64).filter(|_| enabled);
            let precheck = item.get("precheck").and_then(|precheck| precheck.get("command")).and_then(serde_json::Value::as_str).map(str::to_string);
            summary.has_precheck = precheck.is_some();
            summary.model = last.get(&id).and_then(|run| run.get("model")?.as_str().filter(|model| !model.is_empty()).map(str::to_string));
            summary.last_run = last.get(&id).and_then(|run| Some(AutomationLastRun { status: run_status(run.get("status")?.as_str()?), at_ms: run.get("at")?.as_i64()? }));
            let mut automation = found_automation(summary, text(item, "prompt").unwrap_or_default(), rrule);
            automation.timezone = text(item, "timezone");
            automation.workspace = if text(item, "workspaceMode").as_deref() == Some("new-per-run") { AutomationWorkspace::NewWorktree } else { AutomationWorkspace::Checkout };
            automation.session = if item.get("reuseSession").and_then(serde_json::Value::as_bool) == Some(true) { AutomationSession::Reuse } else { AutomationSession::Fresh };
            automation.precheck = precheck;
            automation.precheck_timeout_secs =
                item.get("precheck").and_then(|precheck| precheck.get("timeoutSeconds")).and_then(serde_json::Value::as_u64).unwrap_or(60) as u32;
            automation.grace_minutes = item.get("missedRunGraceMinutes").and_then(serde_json::Value::as_u64).unwrap_or(0) as u32;
            automation.created_at_ms = item.get("createdAt").and_then(serde_json::Value::as_i64);
            automation.updated_at_ms = item.get("updatedAt").and_then(serde_json::Value::as_i64);
            Some(Found { automation, found_on: machine.to_string(), keeper: Keeper::Id(id), session: None })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(text: &str) -> String {
        STANDARD.encode(text)
    }

    #[test]
    fn reads_orca_with_its_projects_hosts_and_last_runs() {
        let list = r#"{"ok":true,"result":{"automations":[{"id":"a-1","name":"Repo audit","prompt":"Audit PRs.","rrule":"FREQ=HOURLY;BYMINUTE=0","enabled":true,"agentId":"codex","projectId":"p-1","executionTargetType":"ssh","executionTargetId":"ssh-9","workspaceMode":"existing","reuseSession":true,"nextRunAt":1790900000000,"missedRunGraceMinutes":720,"precheck":{"command":"gh pr list | grep -q .","timeoutSeconds":60}}]}}"#;
        let projects = r#"{"result":{"projects":[{"id":"github:cam/billing","displayName":"billing","sourceRepoIds":["r-0","p-1"]}]}}"#;
        let hosts = r#"{"result":{"hosts":[{"id":"ssh-9","name":"cedar-02"}]}}"#;
        let runs = r#"{"a-1":{"status":"skipped_precheck","at":1790899506005,"model":"claude-opus-5"}}"#;
        let stdout = format!("H\t/Users/cam\nO\t{}\nP\t{}\nT\t{}\nR\t{}\n", b64(list), b64(projects), b64(hosts), b64(runs));
        let found = Orca.parse(&ScanLines::new("cam-mbp", &stdout)).unwrap();
        let automation = &found[0].automation;
        assert_eq!(automation.summary.id, "orca:a-1");
        assert_eq!(automation.summary.machine.as_deref(), Some("cedar-02"));
        assert_eq!(automation.summary.project.as_deref(), Some("billing"));
        assert_eq!(automation.summary.agent, Some(Harness::Codex));
        assert_eq!(automation.summary.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(automation.summary.last_run, Some(AutomationLastRun { status: AutomationRunStatus::Skipped, at_ms: 1790899506005 }));
        assert!(automation.summary.has_precheck);
        assert_eq!(automation.session, AutomationSession::Reuse);
        assert_eq!(automation.grace_minutes, 720);
        assert_eq!(found[0].found_on, "cam-mbp");
        assert_eq!(found[0].keeper, Keeper::Id("a-1".into()));
    }

    #[test]
    fn an_orca_that_answers_badly_is_there_with_nothing_listed() {
        let stdout = format!("O\t{}\n", b64("not json"));
        assert_eq!(Orca.parse(&ScanLines::new("cam-mbp", &stdout)), Some(Vec::new()));
        assert_eq!(Orca.parse(&ScanLines::new("cam-mbp", "H\t/Users/cam\n")), None);
    }

    #[test]
    fn pauses_and_runs_by_its_id_quoted() {
        let item = Found {
            automation: found_automation(summary("orca:a 1".into(), AutomationSource::Orca, "A".into(), true, "cam-mbp", AutomationAbilities::default()), String::new(), None),
            found_on: "cam-mbp".into(),
            keeper: Keeper::Id("a 1".into()),
            session: None,
        };
        let Ok(Change::Script(script)) = Orca.set_enabled(&item, false) else { panic!("a script") };
        assert!(script.ends_with("orca automations edit 'a 1' --disabled </dev/null >/dev/null\n"), "{script}");
        assert!(Orca.run_now(&item).unwrap().ends_with("orca automations run --id 'a 1' </dev/null >/dev/null\n"));
    }
}

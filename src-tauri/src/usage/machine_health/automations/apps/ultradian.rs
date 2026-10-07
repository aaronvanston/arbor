//! The schedules someone made in ultradian themselves (`udian add`), on a machine where the background runner Arbor
//! installs is: its own schedules, which Arbor places under `arbor-` names in the `arbor` group, are left to `udian.rs`.
//! ultradian runs a command, not a prompt, so the command is what's shown for it; its runs come from udian's own run
//! records (`runs`), never its logs.

use super::super::super::shell::shell_quote;
use super::super::discover::{Found, Keeper};
use super::super::udian::{is_arbors, BIN};
use super::*;

pub(super) struct Ultradian;

// `Y list`, base64 of `udian list --json`, from the build Arbor installs, where Arbor can also pause and start them.
const SCRIPT: &str = r##"if [ -x "$HOME/.ultradian/bin/udian" ]; then
  printf 'Y\t%s\n' "$("$HOME/.ultradian/bin/udian" list --json </dev/null 2>/dev/null | base64 | tr -d '\n')"
fi
"##;

impl App for Ultradian {
    fn source(&self) -> AutomationSource {
        AutomationSource::Ultradian
    }

    fn name(&self) -> &'static str {
        "ultradian"
    }

    fn tags(&self) -> &'static [&'static str] {
        &["Y"]
    }

    fn script(&self) -> &'static str {
        SCRIPT
    }

    fn parse(&self, scan: &ScanLines) -> Option<Vec<Found>> {
        let list = unbase(scan.first("Y")?);
        Some(schedules(scan.machine, scan.home, &list))
    }

    /// udian pauses a schedule in its own database; resuming it there is the undo.
    fn set_enabled(&self, item: &Found, enabled: bool) -> Result<Change, String> {
        let Keeper::Id(name) = &item.keeper else { return Err("Arbor doesn't know ultradian's name for this schedule".into()) };
        let verb = if enabled { "resume" } else { "pause" };
        Ok(Change::Script(format!("{BIN} {verb} {} --json </dev/null >/dev/null\n", shell_quote(name))))
    }

    /// Queued for the daemon, so it runs through the schedule's gate as a due fire would.
    fn run_now(&self, item: &Found) -> Result<String, String> {
        let Keeper::Id(name) = &item.keeper else { return Err("Arbor doesn't know ultradian's name for this schedule".into()) };
        Ok(format!("{BIN} run {} --detach --json </dev/null >/dev/null\n", shell_quote(name)))
    }
}

/// The automation's id: a schedule's name is only unique on its own machine.
pub(in super::super) fn automation_id(machine: &str, name: &str) -> String {
    format!("ultradian:{machine}:{name}")
}

/// The schedule's name in udian, from an id `automation_id` made.
pub(in super::super) fn schedule_of(id: &str, machine: &str) -> Option<String> {
    id.strip_prefix(&format!("ultradian:{machine}:")).map(str::to_string)
}

/// How a run of udian's ended, as Arbor says it.
pub(in super::super) fn run_status(status: &str) -> AutomationRunStatus {
    match status {
        "running" | "queued" => AutomationRunStatus::Running,
        "succeeded" => AutomationRunStatus::Done,
        "clean" | "gate_failed" | "skipped" => AutomationRunStatus::Skipped,
        "missed" => AutomationRunStatus::Missed,
        "canceled" | "cancelled" => AutomationRunStatus::Canceled,
        _ => AutomationRunStatus::Failed,
    }
}

/// When udian fires a cron line, as the schedule words Arbor has; the rest are custom.
fn cron_summary(expression: &str) -> ScheduleSummary {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    let number = |text: &str, below: u32| text.parse::<u32>().ok().filter(|value| *value < below);
    match fields.as_slice() {
        [minute, "*", "*", "*", "*"] => match (minute.strip_prefix("*/").and_then(|every| number(every, 61)), number(minute, 60)) {
            (Some(minutes), _) if minutes > 0 => ScheduleSummary::EveryMinutes { minutes },
            (_, Some(minute)) => ScheduleSummary::EveryHours { hours: 1, minute },
            _ => ScheduleSummary::Custom,
        },
        [minute, hour, "*", "*", days] => {
            let Some(minute) = number(minute, 60) else { return ScheduleSummary::Custom };
            if let Some(hours) = hour.strip_prefix("*/").and_then(|every| number(every, 25)).filter(|hours| *hours > 0) {
                return if *days == "*" { ScheduleSummary::EveryHours { hours, minute } } else { ScheduleSummary::Custom };
            }
            let Some(hour) = number(hour, 24) else { return ScheduleSummary::Custom };
            match *days {
                "*" => ScheduleSummary::Daily { hour, minute },
                "1-5" => ScheduleSummary::Weekdays { hour, minute },
                list => {
                    let days: Option<Vec<u8>> = list.split(',').map(|day| number(day, 8).map(|day| (day % 7) as u8)).collect();
                    match days {
                        Some(mut days) if !days.is_empty() => {
                            days.sort_unstable();
                            days.dedup();
                            ScheduleSummary::Weekly { days, hour, minute }
                        }
                        _ => ScheduleSummary::Custom,
                    }
                }
            }
        }
        _ => ScheduleSummary::Custom,
    }
}

fn trigger_summary(trigger: &serde_json::Value) -> (ScheduleSummary, Option<String>) {
    match trigger.get("kind").and_then(serde_json::Value::as_str) {
        Some("cron") => (trigger.get("expression").and_then(serde_json::Value::as_str).map_or(ScheduleSummary::Custom, cron_summary), text(trigger, "timezone")),
        Some("every") => {
            let minutes = trigger.get("seconds").and_then(serde_json::Value::as_i64).unwrap_or_default() / 60;
            let summary = match u32::try_from(minutes) {
                Ok(minutes) if minutes > 0 && minutes % 60 == 0 => ScheduleSummary::EveryHours { hours: minutes / 60, minute: 0 },
                Ok(minutes) if minutes > 0 => ScheduleSummary::EveryMinutes { minutes },
                _ => ScheduleSummary::Custom,
            };
            (summary, None)
        }
        Some("manual") => (ScheduleSummary::Manual, None),
        _ => (ScheduleSummary::Custom, None),
    }
}

/// The agent a schedule starts, when its command is one by name, and the model it names with `--model`.
fn agent_and_model(command: &[String]) -> (Option<Harness>, Option<String>) {
    let program = command.first().map(|program| program.rsplit('/').next().unwrap_or(program)).unwrap_or_default();
    let agent = Some(Harness::from_id(program)).filter(|agent| *agent != Harness::Other);
    let model = agent.and_then(|_| {
        command.iter().enumerate().find_map(|(index, word)| match word.strip_prefix("--model=") {
            Some(model) => Some(model.to_string()),
            None if word == "--model" => command.get(index + 1).cloned(),
            None => None,
        })
    });
    (agent, model.filter(|model| !model.is_empty()))
}

fn time_ms(value: Option<&serde_json::Value>) -> Option<i64> {
    value?.as_str().and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok()).map(|time| time.timestamp_millis())
}

/// udian's schedules on `machine`, but Arbor's own.
fn schedules(machine: &str, home: &str, list: &[u8]) -> Vec<Found> {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(list) else { return Vec::new() };
    let entries = value.get("data").unwrap_or(&value).as_array().cloned().unwrap_or_default();
    entries
        .iter()
        .filter_map(|entry| {
            let schedule = entry.get("schedule")?;
            let name = text(schedule, "name")?;
            if is_arbors(&name, text(schedule, "group").as_deref()) {
                return None;
            }
            let enabled = schedule.get("active").and_then(serde_json::Value::as_bool).unwrap_or(true);
            let command: Vec<String> = schedule.get("command").and_then(serde_json::Value::as_array).map(|words| words.iter().filter_map(|word| word.as_str().map(str::to_string)).collect()).unwrap_or_default();
            let cwd = text(schedule, "cwd").unwrap_or_default();
            let (agent, model) = agent_and_model(&command);
            let mut summary = summary(
                automation_id(machine, &name),
                AutomationSource::Ultradian,
                name.clone(),
                enabled,
                machine,
                AutomationAbilities { edit: false, pause: true, run_now: true, delete: false, copy: false },
            );
            // The project is the folder it runs in, unless that's just the home folder.
            summary.project = Some(folder_name(&format!("{}/", cwd.trim_end_matches('/')))).filter(|name| !name.is_empty() && cwd.trim_end_matches('/') != home.trim_end_matches('/'));
            summary.agent = agent;
            summary.model = model;
            let (schedule_summary, timezone) = schedule.get("trigger").map(trigger_summary).unwrap_or((ScheduleSummary::Custom, None));
            summary.schedule = schedule_summary;
            summary.next_run_at_ms = time_ms(schedule.get("next_fire_at")).filter(|_| enabled);
            summary.last_run = entry.get("last_status").and_then(serde_json::Value::as_str).and_then(|status| {
                Some(AutomationLastRun { status: run_status(status), at_ms: time_ms(entry.get("last_finished_at"))? })
            });
            summary.has_precheck = schedule.get("gate").is_some_and(|gate| gate.as_str().is_some_and(|gate| !gate.trim().is_empty()));
            summary.runs_on = AutomationRunsOn::Machine;
            let shown: Vec<String> = command.iter().map(|word| if word.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c)) { word.clone() } else { shell_quote(word) }).collect();
            let mut automation = found_automation(summary, shown.join(" "), None);
            automation.timezone = timezone;
            automation.precheck = text(schedule, "gate").filter(|gate| !gate.trim().is_empty());
            automation.precheck_timeout_secs = schedule.get("timeout_seconds").and_then(serde_json::Value::as_f64).map_or(0, |seconds| seconds as u32);
            automation.grace_minutes = schedule.get("catch_up_seconds").and_then(serde_json::Value::as_f64).map_or(0, |seconds| (seconds / 60.0) as u32);
            automation.project_path = Some(cwd).filter(|cwd| !cwd.is_empty());
            automation.created_at_ms = time_ms(schedule.get("created_at"));
            automation.updated_at_ms = time_ms(schedule.get("updated_at"));
            Some(Found { automation, found_on: machine.to_string(), keeper: Keeper::Id(name), session: None })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = r#"{"schema_version":2,"data":[
      {"last_finished_at":"2026-10-07T03:40:00.000Z","last_status":"clean","total_runs":12,"schedule":{"active":true,"catch_up_seconds":600,"command":["claude","-p","Triage what's on stdin","--model","opus-5"],"created_at":"2026-10-01T00:00:00.000Z","cwd":"/home/cam/work/billing","gate":"bun check.ts","gate_mode":"output","group":null,"id":"sch_1","name":"triage","next_fire_at":"2026-10-07T04:00:00.000Z","timeout_seconds":3600,"trigger":{"expression":"0 * * * *","kind":"cron","timezone":null},"updated_at":"2026-10-02T00:00:00.000Z"}},
      {"last_finished_at":null,"last_status":null,"total_runs":0,"schedule":{"active":false,"catch_up_seconds":0,"command":["./backup.sh"],"created_at":"2026-10-01T00:00:00.000Z","cwd":"/home/cam","gate":null,"gate_mode":"output","group":null,"id":"sch_2","name":"backup","next_fire_at":null,"timeout_seconds":null,"trigger":{"kind":"every","seconds":7200},"updated_at":"2026-10-01T00:00:00.000Z"}},
      {"last_finished_at":null,"last_status":null,"total_runs":0,"schedule":{"active":true,"catch_up_seconds":0,"command":["/bin/sh","run.sh"],"created_at":"2026-10-01T00:00:00.000Z","cwd":"/home/cam/.arbor/automations/arbor-x","gate":null,"gate_mode":"output","group":"arbor","id":"sch_3","name":"arbor-x","next_fire_at":null,"timeout_seconds":null,"trigger":{"kind":"manual"},"updated_at":"2026-10-01T00:00:00.000Z"}}
    ]}"#;

    fn scan(list: &str) -> String {
        format!("H\t/home/cam\nY\t{}\n", STANDARD.encode(list))
    }

    #[test]
    fn lists_someone_s_own_schedules_but_not_arbor_s() {
        let stdout = scan(LIST);
        let found = Ultradian.parse(&ScanLines::new("cam-mbp", &stdout)).unwrap();
        assert_eq!(found.len(), 2);
        let triage = &found[0].automation;
        assert_eq!(triage.summary.id, "ultradian:cam-mbp:triage");
        assert_eq!(triage.summary.source, AutomationSource::Ultradian);
        assert_eq!(triage.summary.runs_on, AutomationRunsOn::Machine);
        assert_eq!(triage.summary.project.as_deref(), Some("billing"));
        assert_eq!(triage.summary.agent, Some(Harness::Claude));
        assert_eq!(triage.summary.model.as_deref(), Some("opus-5"));
        assert_eq!(triage.summary.schedule, ScheduleSummary::EveryHours { hours: 1, minute: 0 });
        assert_eq!(triage.summary.last_run, Some(AutomationLastRun { status: AutomationRunStatus::Skipped, at_ms: 1_791_344_400_000 }));
        assert!(triage.summary.next_run_at_ms.is_some());
        assert!(triage.summary.has_precheck);
        assert!(triage.summary.abilities.pause && triage.summary.abilities.run_now && !triage.summary.abilities.delete);
        assert_eq!(triage.prompt, "claude -p 'Triage what'\\''s on stdin' --model opus-5");
        assert_eq!(triage.grace_minutes, 10);
        assert_eq!(found[0].keeper, Keeper::Id("triage".into()));

        let backup = &found[1].automation;
        assert!(!backup.summary.enabled);
        assert_eq!(backup.summary.project, None, "the home folder isn't a project");
        assert_eq!(backup.summary.agent, None);
        assert_eq!(backup.summary.schedule, ScheduleSummary::EveryHours { hours: 2, minute: 0 });
    }

    #[test]
    fn no_runner_or_a_bad_answer() {
        assert_eq!(Ultradian.parse(&ScanLines::new("cam-mbp", "H\t/home/cam\n")), None);
        assert_eq!(Ultradian.parse(&ScanLines::new("cam-mbp", &scan("not json"))), Some(Vec::new()));
    }

    #[test]
    fn reads_the_usual_cron_lines_as_words() {
        assert_eq!(cron_summary("*/15 * * * *"), ScheduleSummary::EveryMinutes { minutes: 15 });
        assert_eq!(cron_summary("5 */3 * * *"), ScheduleSummary::EveryHours { hours: 3, minute: 5 });
        assert_eq!(cron_summary("0 9 * * *"), ScheduleSummary::Daily { hour: 9, minute: 0 });
        assert_eq!(cron_summary("30 8 * * 1-5"), ScheduleSummary::Weekdays { hour: 8, minute: 30 });
        assert_eq!(cron_summary("0 3 * * 7,0,3"), ScheduleSummary::Weekly { days: vec![0, 3], hour: 3, minute: 0 });
        assert_eq!(cron_summary("0 3 1 * *"), ScheduleSummary::Custom);
        assert_eq!(cron_summary("nonsense"), ScheduleSummary::Custom);
    }

    #[test]
    fn pauses_resumes_and_starts_by_its_name_quoted() {
        let stdout = scan(LIST);
        let found = Ultradian.parse(&ScanLines::new("cam-mbp", &stdout)).unwrap();
        let mut item = found[0].clone();
        item.keeper = Keeper::Id("it's".into());
        let Ok(Change::Script(pause)) = Ultradian.set_enabled(&item, false) else { panic!("a script") };
        assert_eq!(pause, "\"$HOME/.ultradian/bin/udian\" pause 'it'\\''s' --json </dev/null >/dev/null\n");
        let Ok(Change::Script(resume)) = Ultradian.set_enabled(&item, true) else { panic!("a script") };
        assert!(resume.contains(" resume 'it'\\''s' "));
        assert_eq!(Ultradian.run_now(&item).unwrap(), "\"$HOME/.ultradian/bin/udian\" run 'it'\\''s' --detach --json </dev/null >/dev/null\n");
        assert_eq!(schedule_of(&automation_id("cam-mbp", "a:b"), "cam-mbp").as_deref(), Some("a:b"));
    }
}

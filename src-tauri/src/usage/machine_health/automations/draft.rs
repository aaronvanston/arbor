//! Drafting an automation from a sentence: the description goes to a small model through the user's own proxy, which
//! answers in a fixed JSON shape with a name, a schedule, a precheck and the prompt. The dialog fills itself in from
//! it and the user checks it before anything is saved. Nothing else is sent: no files, no other automations.

use super::schedule;
use super::{Harness, AutomationDraft, AutomationDraftInput, AutomationSession};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

/// The model asked when Settings names none: small and quick, as a draft is a few hundred tokens.
pub(crate) const DEFAULT_MODEL: &str = "gpt-6-luna";
pub(crate) const DEFAULT_EFFORT: &str = "low";
const TIMEOUT: Duration = Duration::from_secs(90);

/// Where the request goes: the core's own address on this Mac, and a client key it takes.
pub(crate) struct CoreAccess {
    pub(crate) origin: String,
    pub(crate) key: String,
}

const INSTRUCTIONS: &str = "You set up scheduled coding-agent runs. From the user's description, write:\n\
- name: a short title in sentence case, at most 6 words.\n\
- prompt: what the agent is told each run, written to the agent in the second person, complete and specific. \
It starts in the project's folder. Keep the user's intent; add the steps a careful engineer would take.\n\
- rrule: an iCalendar RRULE without the RRULE: prefix, using only FREQ (MINUTELY, HOURLY, DAILY or WEEKLY), \
INTERVAL, BYDAY, BYHOUR and BYMINUTE. Hourly is FREQ=HOURLY;BYMINUTE=0. Daily at 9 is FREQ=DAILY;BYHOUR=9;BYMINUTE=0. \
Weekdays at 9 is FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0.\n\
- precheck: a POSIX shell command run in the project's folder before the agent that exits 0 only when there is work \
to do, so a run with nothing to do costs nothing. Use read-only commands (gh, git, curl, test, grep). Print what it \
found; the agent is given that output. Null when every run has work.\n\
- precheckTimeoutSecs: 10 to 300.\n\
- agent: the harness id; codex unless the user names another.\n\
- session: fresh, or reuse when each run should carry on from the last.\n\
- graceMinutes: how late a missed run may still start, 0 to 1440; about a third of the interval.\n\
- note: one plain sentence on anything the user must fill in or check (a token, a project, a command that may not \
be installed), or null.";

/// The ids of the harnesses Arbor can start, for the model to pick from.
fn launchable_ids() -> Vec<&'static str> {
    Harness::ALL.into_iter().filter(|harness| harness.launches()).map(|harness| harness.spec().id).collect()
}

fn schema() -> serde_json::Value {
    let nullable = |kind: &str| json!({ "type": [kind, "null"] });
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "prompt", "rrule", "precheck", "precheckTimeoutSecs", "agent", "session", "graceMinutes", "note"],
        "properties": {
            "name": { "type": "string" },
            "prompt": { "type": "string" },
            "rrule": { "type": "string" },
            "precheck": nullable("string"),
            "precheckTimeoutSecs": { "type": "integer" },
            "agent": { "type": "string", "enum": launchable_ids() },
            "session": { "type": "string", "enum": ["fresh", "reuse"] },
            "graceMinutes": { "type": "integer" },
            "note": nullable("string"),
        },
    })
}

fn user_text(input: &AutomationDraftInput) -> String {
    let mut text = format!("Description: {}", input.description.trim());
    if let Some(machine) = input.machine.as_deref().filter(|machine| !machine.is_empty()) {
        text.push_str(&format!("\nMachine: {machine}"));
    }
    if let Some(project) = input.project_path.as_deref().filter(|project| !project.is_empty()) {
        text.push_str(&format!("\nProject folder: {project}"));
    }
    text
}

pub(super) fn request_body(model: &str, effort: &str, input: &AutomationDraftInput) -> serde_json::Value {
    json!({
        "model": model,
        "instructions": INSTRUCTIONS,
        "input": user_text(input),
        "reasoning": { "effort": effort },
        "store": false,
        "text": { "format": { "type": "json_schema", "name": "automation_draft", "strict": true, "schema": schema() } },
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw {
    name: String,
    prompt: String,
    rrule: String,
    precheck: Option<String>,
    precheck_timeout_secs: i64,
    agent: String,
    session: String,
    grace_minutes: i64,
    note: Option<String>,
}

/// The text a Responses answer gave: its `output_text`, or its messages' text parts.
fn answer_text(body: &serde_json::Value) -> Option<String> {
    if let Some(text) = body.get("output_text").and_then(serde_json::Value::as_str) {
        return Some(text.to_string());
    }
    let text: String = body
        .get("output")?
        .as_array()?
        .iter()
        .filter(|item| item.get("type").and_then(serde_json::Value::as_str) == Some("message"))
        .flat_map(|item| item.get("content").and_then(serde_json::Value::as_array).cloned().unwrap_or_default())
        .filter(|part| part.get("type").and_then(serde_json::Value::as_str) == Some("output_text"))
        .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str).map(str::to_string))
        .collect();
    (!text.is_empty()).then_some(text)
}

/// The draft in a Responses answer, kept to what Arbor can run: a schedule of another shape becomes hourly, with a
/// note saying so.
pub(super) fn parse_answer(body: &serde_json::Value) -> Result<AutomationDraft, String> {
    let text = answer_text(body).ok_or("The model didn't answer with a draft")?;
    let raw: Raw = serde_json::from_str(text.trim()).map_err(|_| "The model's draft wasn't in the expected shape".to_string())?;
    let mut note = raw.note.map(|note| note.trim().to_string()).filter(|note| !note.is_empty());
    let rrule = raw.rrule.trim().trim_start_matches("RRULE:").to_string();
    let rrule = if schedule::parse(&rrule).is_some() {
        rrule
    } else {
        note = Some(format!("The model suggested a schedule Arbor can't run ({rrule}), so it's hourly for now."));
        "FREQ=HOURLY;BYMINUTE=0".to_string()
    };
    Ok(AutomationDraft {
        name: raw.name.trim().chars().take(80).collect(),
        prompt: raw.prompt.trim().to_string(),
        rrule,
        precheck: raw.precheck.map(|precheck| precheck.trim().to_string()).filter(|precheck| !precheck.is_empty()),
        precheck_timeout_secs: raw.precheck_timeout_secs.clamp(10, 300) as u32,
        agent: Some(Harness::from_id(&raw.agent)).filter(|harness| harness.launches()).unwrap_or(Harness::Codex),
        session: if raw.session == "reuse" { AutomationSession::Reuse } else { AutomationSession::Fresh },
        grace_minutes: raw.grace_minutes.clamp(0, 1440) as u32,
        note,
    })
}

/// Asks the model for a draft. Errors say what to do; none carries the key.
pub(crate) async fn draft(
    client: &reqwest::Client,
    access: &CoreAccess,
    model: &str,
    effort: &str,
    input: &AutomationDraftInput,
) -> Result<AutomationDraft, String> {
    if input.description.trim().is_empty() {
        return Err("Describe the automation first".into());
    }
    let response = client
        .post(format!("{}/v1/responses", access.origin.trim_end_matches('/')))
        .bearer_auth(&access.key)
        .timeout(TIMEOUT)
        .json(&request_body(model, effort, input))
        .send()
        .await
        .map_err(|_| "Couldn't reach the proxy. Start it on Home, then try again".to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("The proxy answered {} for {model}. Pick another drafting model in Settings › Automations", status.as_u16()));
    }
    let body: serde_json::Value = response.json().await.map_err(|_| "The proxy's answer wasn't JSON".to_string())?;
    parse_answer(&body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn input() -> AutomationDraftInput {
        AutomationDraftInput { description: "Hourly check of Sentry issues, fix what needs it".into(), machine: Some("cam-mbp".into()), project_path: None }
    }

    fn answer(draft: serde_json::Value) -> serde_json::Value {
        json!({ "output": [{ "type": "reasoning" }, { "type": "message", "content": [{ "type": "output_text", "text": draft.to_string() }] }] })
    }

    fn draft_json(rrule: &str) -> serde_json::Value {
        json!({
            "name": "Sentry triage", "prompt": "Look at new Sentry issues.", "rrule": rrule, "precheck": "sentry-cli issues list | grep -q .",
            "precheckTimeoutSecs": 1000, "agent": "codex", "session": "fresh", "graceMinutes": 20, "note": null
        })
    }

    #[test]
    fn reads_a_draft_from_the_answer() {
        let draft = parse_answer(&answer(draft_json("RRULE:FREQ=HOURLY;BYMINUTE=0"))).unwrap();
        assert_eq!(draft.name, "Sentry triage");
        assert_eq!(draft.rrule, "FREQ=HOURLY;BYMINUTE=0");
        assert_eq!(draft.precheck_timeout_secs, 300);
        assert_eq!(draft.agent, Harness::Codex);
        assert_eq!(draft.note, None);
    }

    #[test]
    fn a_schedule_arbor_cant_run_becomes_hourly_with_a_note() {
        let draft = parse_answer(&answer(draft_json("FREQ=MONTHLY;BYMONTHDAY=1"))).unwrap();
        assert_eq!(draft.rrule, "FREQ=HOURLY;BYMINUTE=0");
        assert!(draft.note.unwrap().contains("FREQ=MONTHLY"));
    }

    #[test]
    fn the_request_names_the_model_and_a_strict_schema() {
        let body = request_body("gpt-6-luna", "low", &input());
        assert_eq!(body["model"], "gpt-6-luna");
        assert_eq!(body["reasoning"]["effort"], "low");
        assert_eq!(body["text"]["format"]["strict"], true);
        assert!(body["input"].as_str().unwrap().contains("Machine: cam-mbp"));
    }

    #[test]
    fn asks_the_proxy_with_the_client_key() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let body = answer(draft_json("FREQ=DAILY;BYHOUR=9;BYMINUTE=0")).to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 8192];
            loop {
                let read = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&request);
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length: ").map(|n| n.trim().parse::<usize>().unwrap())).unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let head = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            stream.write_all(head.as_bytes()).unwrap();
            stream.write_all(body.as_bytes()).unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let access = CoreAccess { origin, key: "sk-test-key".into() };
        let draft = runtime.block_on(draft(&reqwest::Client::new(), &access, "gpt-6-luna", "low", &input())).unwrap();
        assert_eq!(draft.rrule, "FREQ=DAILY;BYHOUR=9;BYMINUTE=0");
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/responses"));
        assert!(request.to_ascii_lowercase().contains("authorization: bearer sk-test-key"));
    }

    #[test]
    fn a_proxy_that_isnt_there_says_so_without_the_key() {
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let access = CoreAccess { origin: format!("http://127.0.0.1:{port}"), key: "sk-secret".into() };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let error = runtime.block_on(draft(&reqwest::Client::new(), &access, "gpt-6-luna", "low", &input())).unwrap_err();
        assert!(error.starts_with("Couldn't reach the proxy"));
        assert!(!error.contains("sk-secret"));
    }
}

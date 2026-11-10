//! Codex's rollouts: `sessions/<date>/rollout-<time>-<thread>.jsonl`. Each line is a time, a `type` and a `payload`.
//! The format has changed more than once, so every reader here takes what it finds and leaves the rest in place.

use crate::claude::{command_row, file_touched, prompt, tool_def};
use crate::json::{self, Fields};
use crate::{At, ContextUse, Line, Message, Parser, Request, Rows, ToolCall, ToolIo, ToolResult};
use serde_json::Value;

pub(crate) fn line(parser: &mut Parser, number: u64, bytes: u64, mut fields: Fields, rows: &mut Rows) {
    let kind = json::string(&mut fields, "type").unwrap_or_default();
    let ts = json::string(&mut fields, "timestamp");
    let id = json::number(&mut fields, "ordinal").map(|ordinal| ordinal.to_string());
    let mut payload = json::object(&mut fields, "payload").unwrap_or_default();
    let subkind = json::string(&mut payload, "type");
    let mut row = Line { id, bytes, ..Line::default() };
    if kind == "session_meta" {
        session_meta(parser, &mut payload, &mut row);
    }
    let at = parser.at(number, ts, parser.state.session_id.clone());
    match (kind.as_str(), subkind.as_deref()) {
        ("session_meta", _) => instructions(parser, &at, &mut payload, rows),
        ("turn_context", _) => turn_context(parser, &mut payload, &mut row),
        ("token_usage_record", _) => {
            parser.state.records = true;
            let request_id = json::string(&mut payload, "response_id");
            let turn_id = json::string(&mut payload, "turn_id");
            if let Some(usage) = json::object(&mut payload, "usage") {
                rows.requests.push(request(parser, &at, usage, (request_id, turn_id), &mut payload));
            }
        }
        ("event_msg", Some("token_count")) => token_count(parser, &at, &mut payload, rows),
        ("event_msg", Some("item_completed")) => item(parser, &at, &mut payload, rows),
        ("response_item", Some("message")) => message(parser, &at, &mut payload, rows),
        ("response_item", Some("reasoning")) => reasoning(parser, &at, &mut payload, rows),
        ("response_item", Some("function_call" | "custom_tool_call" | "local_shell_call")) => tool_call(parser, &at, subkind.as_deref().unwrap_or_default(), &mut payload, rows),
        ("response_item", Some("function_call_output" | "custom_tool_call_output")) => tool_output(parser, &at, &mut payload, rows),
        ("response_item", Some("additional_tools")) => {
            let mut tool_hashes = Vec::new();
            tool_defs(parser, json::array(&mut payload, "tools").unwrap_or_default(), &mut tool_hashes, rows);
            rows.context_use.push(ContextUse { at: at.clone(), prompt_hash: None, tool_hashes });
        }
        _ => {}
    }
    json::put_back(&mut fields, "payload", payload);
    row.at = at;
    row.kind = kind;
    row.subkind = subkind;
    row.rest = parser.rest(fields);
    rows.lines.push(row);
}

/// A rollout's first line: which session it is, and where it ran.
fn session_meta(parser: &mut Parser, payload: &mut Fields, row: &mut Line) {
    // `id` is the thread, which is how a rollout's file is named and how sessions are told apart.
    let id = json::string(payload, "id");
    parser.state.session_id = id.or_else(|| json::string(payload, "session_id")).or(parser.state.session_id.take());
    row.parent_session_id = json::string(payload, "parent_thread_id").or_else(|| json::string(payload, "forked_from_id"));
    row.agent_version = json::string(payload, "cli_version");
    row.entrypoint = json::string(payload, "originator");
    row.cwd = json::string(payload, "cwd");
    parser.state.cwd = row.cwd.clone();
    if let Some(mut git) = json::object(payload, "git") {
        row.branch = json::string(&mut git, "branch");
        json::put_back(payload, "git", git);
    }
}

/// The instructions a session opened with, as its system prompt.
fn instructions(parser: &Parser, at: &At, payload: &mut Fields, rows: &mut Rows) {
    let text = match json::object(payload, "base_instructions") {
        Some(mut held) => {
            let text = json::string(&mut held, "text");
            json::put_back(payload, "base_instructions", held);
            text
        }
        None => json::string(payload, "base_instructions"),
    };
    if let Some(text) = text {
        let prompt_hash = Some(prompt(parser, text, rows));
        rows.context_use.push(ContextUse { at: at.clone(), prompt_hash, tool_hashes: Vec::new() });
    }
}

/// What holds for the turn that follows: the model, how hard it thinks, and the folder.
fn turn_context(parser: &mut Parser, payload: &mut Fields, row: &mut Line) {
    let state = &mut parser.state;
    state.model = json::string(payload, "model").or(state.model.take());
    state.effort = json::string(payload, "effort").or(state.effort.take());
    state.cwd = json::string(payload, "cwd").or(state.cwd.take());
    state.turn_id = json::string(payload, "turn_id").or(state.turn_id.take());
    (row.model, row.cwd) = (state.model.clone(), state.cwd.clone());
}

/// A call's tokens. Codex's input counts what was read from and written to the cache, so those come off it.
fn request(parser: &Parser, at: &At, mut usage: Fields, (request_id, turn_id): (Option<String>, Option<String>), from: &mut Fields) -> Request {
    let cache_read = json::number(&mut usage, "cached_input_tokens").unwrap_or(0);
    let cache_write = json::number(&mut usage, "cache_write_input_tokens").unwrap_or(0);
    let request = Request {
        at: at.clone(),
        request_id,
        turn_id: turn_id.or_else(|| parser.state.turn_id.clone()),
        model: parser.state.model.clone(),
        effort: parser.state.effort.clone(),
        input: json::number(&mut usage, "input_tokens").unwrap_or(0).saturating_sub(cache_read).saturating_sub(cache_write),
        output: json::number(&mut usage, "output_tokens").unwrap_or(0),
        thinking: json::number(&mut usage, "reasoning_output_tokens"),
        cache_read,
        cache_write,
        ..Request::default()
    };
    json::put_back(from, "usage", usage);
    request
}

/// A rollout from before `token_usage_record` lines: each call's tokens are in the event after it. The same event
/// can be written twice, so one with the thread's total unchanged is a repeat.
fn token_count(parser: &mut Parser, at: &At, payload: &mut Fields, rows: &mut Rows) {
    if parser.state.records {
        return;
    }
    let Some(mut info) = json::object(payload, "info") else {
        return;
    };
    let total = info.get("total_token_usage").map(Value::to_string);
    if let Some(last) = json::object(&mut info, "last_token_usage").filter(|_| total.is_some() && total != parser.state.last_total) {
        let mut made = request(parser, at, last, (None, None), &mut info);
        made.context_window = info.get("model_context_window").and_then(Value::as_u64);
        rows.requests.push(made);
        // What's left of the call's numbers goes back under the name it had.
        if let Some(left) = info.remove("usage") {
            info.insert("last_token_usage".into(), left);
        }
        parser.state.last_total = total;
    }
    json::put_back(payload, "info", info);
}

fn message(parser: &Parser, at: &At, payload: &mut Fields, rows: &mut Rows) {
    let role = json::string(payload, "role").unwrap_or_default();
    let mut content = json::array(payload, "content").unwrap_or_default();
    let text = json::texts(&mut content).unwrap_or_default();
    if !content.is_empty() {
        payload.insert("content".into(), Value::Array(content));
    }
    let kind = match role.as_str() {
        "user" => "prompt",
        "assistant" => "text",
        _ => "instructions",
    };
    rows.messages.push(Message {
        at: at.clone(),
        kind: kind.into(),
        block: 0,
        message_id: json::string(payload, "id"),
        request_id: None,
        model: if role == "assistant" { parser.state.model.clone() } else { None },
        meta: None,
        chars: json::chars(&text),
        text: parser.text(text),
        role,
    });
}

/// The model's thinking. Codex keeps a summary in the open and the thinking itself encrypted, so that part is a size.
fn reasoning(parser: &Parser, at: &At, payload: &mut Fields, rows: &mut Rows) {
    let mut parts = Vec::new();
    for key in ["summary", "content"] {
        if let Some(mut items) = json::array(payload, key) {
            parts.extend(json::texts(&mut items));
            if !items.is_empty() {
                payload.insert(key.into(), Value::Array(items));
            }
        }
    }
    let text = parts.join("\n");
    rows.messages.push(Message {
        at: at.clone(),
        role: "assistant".into(),
        kind: "thinking".into(),
        block: 0,
        message_id: json::string(payload, "id"),
        request_id: None,
        model: parser.state.model.clone(),
        meta: None,
        chars: json::chars(&text),
        text: parser.text(text),
    });
}

/// A command as a shell would be given it: `["bash", "-lc", "<command>"]` is its command, anything else its words.
fn shell_command(command: &Value) -> Option<String> {
    match command {
        Value::String(text) => Some(text.clone()),
        Value::Array(words) => {
            let words: Vec<&str> = words.iter().filter_map(Value::as_str).collect();
            match words.as_slice() {
                [shell, flag, command] if matches!(shell.rsplit('/').next(), Some("bash" | "sh" | "zsh")) && matches!(*flag, "-lc" | "-c") => Some((*command).to_string()),
                [] => None,
                words => Some(words.join(" ")),
            }
        }
        _ => None,
    }
}

fn tool_call(parser: &Parser, at: &At, kind: &str, payload: &mut Fields, rows: &mut Rows) {
    let tool_use_id = json::string(payload, "call_id");
    let tool = json::string(payload, "name").unwrap_or_else(|| kind.trim_end_matches("_call").to_string());
    // A function's arguments are JSON in a string, a custom tool's input is plain text, and the older shell call
    // holds its command as `action`.
    let (input_text, input) = match kind {
        "function_call" => {
            let text = json::string(payload, "arguments").unwrap_or_default();
            let parsed = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
            (text, parsed)
        }
        "custom_tool_call" => (json::string(payload, "input").unwrap_or_default(), Value::Null),
        _ => {
            let action = payload.remove("action").unwrap_or(Value::Null);
            (serde_json::to_string(&action).unwrap_or_default(), action)
        }
    };
    let field = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_string);
    if let Some(command) = input.get("command").or_else(|| input.get("cmd")).and_then(shell_command) {
        let cwd = field("workdir").or_else(|| field("cwd")).or_else(|| parser.state.cwd.clone());
        rows.commands.push(command_row(parser, at, tool_use_id.clone(), cwd, command));
    }
    if tool == "apply_patch" {
        patched_files(at, &tool_use_id, &input_text, rows);
    }
    let mcp = tool.strip_prefix("mcp__").and_then(|name| name.split_once("__"));
    rows.tool_calls.push(ToolCall {
        at: at.clone(),
        tool_use_id: tool_use_id.clone(),
        namespace: json::string(payload, "namespace"),
        mcp_server: mcp.map(|(server, _)| server.to_string()),
        mcp_tool: mcp.map(|(_, name)| name.to_string()),
        caller: None,
        message_id: json::string(payload, "id"),
        request_id: None,
        subagent_type: field("agent_type"),
        skill: None,
        background: None,
        timeout_ms: input.get("timeout_ms").and_then(Value::as_u64),
        input_chars: json::chars(&input_text),
        tool,
    });
    if let Some(text) = parser.text(input_text) {
        rows.tool_io.push(ToolIo { at: at.clone(), tool_use_id, part: "input".into(), text });
    }
}

/// The files a patch names, and how many lines it adds to and takes from each.
fn patched_files(at: &At, tool_use_id: &Option<String>, patch: &str, rows: &mut Rows) {
    let mut open: Option<(String, &str, u64, u64)> = None;
    let mut close = |open: &mut Option<(String, &str, u64, u64)>| {
        if let Some((path, op, added, removed)) = open.take() {
            rows.files_touched.push(file_touched(at, tool_use_id.clone(), path, op, (Some(added), Some(removed))));
        }
    };
    for line in patch.lines() {
        let header = [("*** Update File: ", "edit"), ("*** Add File: ", "add"), ("*** Delete File: ", "delete")].into_iter().find_map(|(mark, op)| Some((line.strip_prefix(mark)?, op)));
        match (header, &mut open) {
            (Some((path, op)), _) => {
                close(&mut open);
                open = Some((path.trim().to_string(), op, 0, 0));
            }
            (None, Some((_, _, added, _))) if line.starts_with('+') => *added += 1,
            (None, Some((_, _, _, removed))) if line.starts_with('-') => *removed += 1,
            _ => {}
        }
    }
    close(&mut open);
}

fn tool_output(parser: &Parser, at: &At, payload: &mut Fields, rows: &mut Rows) {
    let tool_use_id = json::string(payload, "call_id");
    let mut row = ToolResult { at: at.clone(), tool_use_id: tool_use_id.clone(), ..ToolResult::default() };
    let output = match payload.remove("output") {
        // Older rollouts wrap a command's output in JSON, with how it ended beside it.
        Some(Value::String(text)) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(mut wrapped)) if wrapped.get("output").is_some_and(Value::is_string) => {
                if let Some(mut how) = json::object(&mut wrapped, "metadata") {
                    row.exit_code = json::signed(&mut how, "exit_code");
                    row.duration_ms = how.get("duration_seconds").and_then(Value::as_f64).map(|seconds| (seconds * 1000.0).round() as u64);
                }
                json::string(&mut wrapped, "output")
            }
            _ => Some(text),
        },
        Some(Value::Array(mut items)) => {
            let text = json::texts(&mut items);
            if !items.is_empty() {
                payload.insert("output".into(), Value::Array(items));
            }
            text
        }
        Some(Value::Object(mut held)) => {
            row.is_error = json::boolean(&mut held, "success").map(|worked| !worked);
            let text = match json::array(&mut held, "content") {
                Some(mut items) => json::texts(&mut items),
                None => json::string(&mut held, "content"),
            };
            json::put_back(payload, "output", held);
            text
        }
        Some(other) => {
            payload.insert("output".into(), other);
            None
        }
        None => None,
    };
    let said = output.as_deref().map(ended).unwrap_or_default();
    row.exit_code = row.exit_code.or(said.exit_code);
    row.duration_ms = row.duration_ms.or(said.duration_ms);
    row.is_error = row.is_error.or(said.failed).or(row.exit_code.map(|code| code != 0));
    row.output_chars = output.as_deref().map_or(0, json::chars);
    rows.tool_results.push(row);
    if let Some(text) = output.and_then(|text| parser.text(text)) {
        rows.tool_io.push(ToolIo { at: at.clone(), tool_use_id, part: "output".into(), text });
    }
}

/// How a tool's run ended, as its output's first lines say it.
#[derive(Default)]
struct Ended {
    exit_code: Option<i64>,
    duration_ms: Option<u64>,
    failed: Option<bool>,
}

/// Newer rollouts open a tool's output with a few lines about its run, then `Output:`. A shell command says
/// `Exit code: 1` or `Process exited with code 1`, a script `Script completed` or `Script failed`, and both how
/// long it took as `Wall time: 0.5 seconds`. An output that opens any other way says nothing.
fn ended(output: &str) -> Ended {
    let mut ended = Ended::default();
    for line in output.lines().take(6) {
        let number = |rest: &str| rest.trim_start_matches(':').split_whitespace().next().map(str::to_string);
        if line == "Output:" {
            break;
        } else if let Some(rest) = line.strip_prefix("Exit code").or_else(|| line.strip_prefix("Process exited with code")) {
            ended.exit_code = number(rest).and_then(|code| code.parse().ok());
        } else if let Some(rest) = line.strip_prefix("Wall time") {
            ended.duration_ms = number(rest).and_then(|seconds| seconds.parse::<f64>().ok()).filter(|seconds| seconds.is_finite() && *seconds >= 0.0).map(|seconds| (seconds * 1000.0).round() as u64);
        } else if line == "Script completed" {
            ended.failed = Some(false);
        } else if matches!(line, "Script failed" | "Script terminated") {
            ended.failed = Some(true);
        }
    }
    ended
}

/// Something a turn finished. A command it ran is a row, with how it ended; the others repeat what `response_item`
/// lines already say, and stay in `rest`.
fn item(parser: &Parser, at: &At, payload: &mut Fields, rows: &mut Rows) {
    let Some(mut item) = json::object(payload, "item") else {
        return;
    };
    if item.get("type").and_then(Value::as_str) == Some("CommandExecution") {
        if let Some(command) = item.remove("command").as_ref().and_then(shell_command) {
            let id = json::string(&mut item, "id");
            let output = json::string(&mut item, "aggregated_output");
            let mut row = command_row(parser, at, id.clone(), json::string(&mut item, "cwd"), command);
            row.exit_code = json::signed(&mut item, "exit_code");
            row.duration_ms = json::object(&mut item, "duration").map(|took| took.get("secs").and_then(Value::as_u64).unwrap_or(0) * 1000 + took.get("nanos").and_then(Value::as_u64).unwrap_or(0) / 1_000_000);
            row.output_chars = output.as_deref().map(json::chars);
            // What Codex itself made of the command: the files it read or searched.
            for parsed in item.get("parsed_cmd").and_then(Value::as_array).into_iter().flatten() {
                let (Some(op @ ("read" | "search")), Some(path)) = (parsed.get("type").and_then(Value::as_str), parsed.get("path").and_then(Value::as_str)) else {
                    continue;
                };
                rows.files_touched.push(file_touched(at, id.clone(), path.to_string(), op, (None, None)));
            }
            rows.commands.push(row);
            if let Some(text) = output.and_then(|text| parser.text(text)) {
                rows.tool_io.push(ToolIo { at: at.clone(), tool_use_id: id, part: "output".into(), text });
            }
        }
    }
    json::put_back(payload, "item", item);
}

/// Tools come one by one or grouped under a name.
fn tool_defs(parser: &Parser, tools: Vec<Value>, hashes: &mut Vec<String>, rows: &mut Rows) {
    for mut tool in tools {
        match tool.as_object_mut().and_then(|fields| json::array(fields, "tools")) {
            Some(group) => tool_defs(parser, group, hashes, rows),
            None => hashes.extend(tool_def(parser, tool, rows)),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use crate::tests::{parse, SECRET};
    use crate::{Agent, Detail};
    use serde_json::{json, Value};

    fn line(ordinal: u64, kind: &str, payload: Value) -> String {
        json!({ "timestamp": format!("2026-10-02T09:00:{ordinal:02}.000Z"), "ordinal": ordinal, "type": kind, "payload": payload }).to_string()
    }

    fn usage(input: u64, cached: u64, output: u64) -> Value {
        json!({ "input_tokens": input, "cached_input_tokens": cached, "cache_write_input_tokens": 10, "output_tokens": output, "reasoning_output_tokens": 4, "total_tokens": input + output })
    }

    /// A short made-up rollout in today's shape.
    pub(crate) fn session() -> Vec<String> {
        vec![
            line(0, "session_meta", json!({ "id": "t-1", "session_id": "t-1", "parent_thread_id": "t-0", "cwd": "/srv/app", "cli_version": "0.99.0", "originator": "codex_cli", "git": { "branch": "main", "commit_hash": "abc123" }, "base_instructions": { "text": format!("You are a test. {SECRET}"), "provenance": { "type": "default" } } })),
            line(1, "turn_context", json!({ "turn_id": "turn-1", "cwd": "/srv/app", "model": "gpt-test-1", "effort": "high", "approval_policy": "never" })),
            line(2, "response_item", json!({ "type": "additional_tools", "id": "at_1", "role": "developer", "tools": [{ "name": "collaboration", "description": "Group", "tools": [{ "type": "function", "name": "spawn_agent", "description": format!("Starts an agent. {SECRET}"), "parameters": { "type": "object" } }] }] })),
            line(3, "response_item", json!({ "type": "message", "id": "m_1", "role": "user", "content": [{ "type": "input_text", "text": format!("Fix the build. {SECRET}") }] })),
            line(4, "response_item", json!({ "type": "reasoning", "id": "r_1", "summary": [{ "type": "summary_text", "text": format!("Checking the log. {SECRET}") }], "encrypted_content": "ZW5jcnlwdGVk" })),
            line(5, "response_item", json!({ "type": "function_call", "id": "fc_1", "status": "completed", "name": "shell", "call_id": "call_1", "arguments": json!({ "command": ["bash", "-lc", format!("rg -n TODO src | head -3 # {SECRET}")], "workdir": "/srv/app/web", "timeout_ms": 5000 }).to_string() })),
            line(6, "response_item", json!({ "type": "function_call_output", "id": "fo_1", "call_id": "call_1", "output": json!({ "output": format!("src/a.rs:1 {SECRET}"), "metadata": { "exit_code": 1, "duration_seconds": 0.25 } }).to_string() })),
            line(7, "response_item", json!({ "type": "custom_tool_call", "id": "ct_1", "status": "completed", "call_id": "call_2", "name": "apply_patch", "input": format!("*** Begin Patch\n*** Update File: src/a.rs\n@@\n-old\n+new {SECRET}\n+more\n*** Add File: docs/b.md\n+hello\n*** End Patch") })),
            line(8, "response_item", json!({ "type": "custom_tool_call_output", "id": "co_1", "call_id": "call_2", "output": [{ "type": "input_text", "text": format!("Done. {SECRET}") }] })),
            line(9, "event_msg", json!({ "type": "item_completed", "thread_id": "t-1", "turn_id": "turn-1", "started_at_ms": 1, "completed_at_ms": 2, "item": { "type": "CommandExecution", "id": "item_1", "process_id": "p1", "command": ["/bin/zsh", "-lc", format!("cat src/a.rs # {SECRET}")], "cwd": "/srv/app", "parsed_cmd": [{ "type": "read", "cmd": format!("cat src/a.rs {SECRET}"), "name": "a.rs", "path": "src/a.rs" }], "source": "agent", "status": "completed", "aggregated_output": format!("fn a() {{}} {SECRET}"), "exit_code": 0, "duration": { "secs": 1, "nanos": 500_000_000 } } })),
            line(10, "token_usage_record", json!({ "thread_id": "t-1", "turn_id": "turn-1", "response_id": "resp_1", "usage": usage(1000, 700, 50), "turn_token_usage": usage(1000, 700, 50), "thread_token_usage": usage(1000, 700, 50) })),
            line(11, "event_msg", json!({ "type": "token_count", "info": { "total_token_usage": usage(1000, 700, 50), "last_token_usage": usage(1000, 700, 50), "model_context_window": 272000 }, "rate_limits": { "primary": { "used_percent": 12.5 } } })),
            line(12, "response_item", json!({ "type": "message", "id": "m_2", "role": "assistant", "content": [{ "type": "output_text", "text": format!("Fixed. {SECRET}") }], "phase": "final" })),
            line(13, "event_msg", json!({ "type": "task_complete", "turn_id": "turn-1", "duration_ms": 9000, "time_to_first_token_ms": 400, "last_agent_message": format!("Fixed. {SECRET}") })),
        ]
    }

    #[test]
    fn a_rollouts_first_lines_say_which_session_it_is_and_the_model_in_force() {
        let rows = parse(Agent::Codex, Detail::Everything, &session());
        assert_eq!(rows.lines.len(), session().len());
        assert!(rows.lines.iter().all(|line| line.at.session_id.as_deref() == Some("t-1")));
        let first = &rows.lines[0];
        assert_eq!((first.parent_session_id.as_deref(), first.agent_version.as_deref(), first.branch.as_deref(), first.cwd.as_deref(), first.entrypoint.as_deref()), (Some("t-0"), Some("0.99.0"), Some("main"), Some("/srv/app"), Some("codex_cli")));
        assert_eq!((rows.lines[1].model.as_deref(), rows.lines[9].kind.as_str(), rows.lines[9].subkind.as_deref(), rows.lines[9].id.as_deref()), (Some("gpt-test-1"), "event_msg", Some("item_completed"), Some("9")));
        assert_eq!((rows.prompts.len(), rows.context_use[0].prompt_hash.as_deref()), (1, Some(rows.prompts[0].hash.as_str())));
        assert_eq!(rows.tool_defs.iter().map(|tool| tool.name.as_str()).collect::<Vec<_>>(), ["spawn_agent"]);
        assert_eq!(rows.context_use[1].tool_hashes, [rows.tool_defs[0].hash.clone()]);
    }

    #[test]
    fn prompts_replies_and_thinking_are_messages() {
        let rows = parse(Agent::Codex, Detail::Everything, &session());
        let messages: Vec<_> = rows.messages.iter().map(|message| (message.at.line, message.role.as_str(), message.kind.as_str(), message.model.as_deref())).collect();
        assert_eq!(messages, [(3, "user", "prompt", None), (4, "assistant", "thinking", Some("gpt-test-1")), (12, "assistant", "text", Some("gpt-test-1"))]);
        assert_eq!(rows.messages[2].text.as_deref(), Some(format!("Fixed. {SECRET}").as_str()));
        let all = serde_json::to_string(&rows).unwrap();
        assert!(!all.contains("ZW5jcnlwdGVk"), "encrypted thinking");
        let thought = serde_json::from_str::<Value>(rows.lines[4].rest.as_deref().unwrap()).unwrap();
        assert_eq!(thought["payload"]["encrypted_content_size"]["bytes"], json!(12));
    }

    #[test]
    fn a_shell_call_is_a_tool_call_a_command_and_a_result() {
        let rows = parse(Agent::Codex, Detail::Everything, &session());
        let call = &rows.tool_calls[0];
        assert_eq!((call.tool.as_str(), call.tool_use_id.as_deref(), call.timeout_ms, call.message_id.as_deref()), ("shell", Some("call_1"), Some(5000), Some("fc_1")));
        let command = &rows.commands[0];
        assert_eq!((command.program.as_deref(), command.uses_rg, command.pipes_to_head_tail, command.cwd.as_deref()), (Some("rg"), true, true, Some("/srv/app/web")));
        assert_eq!(command.command.as_deref(), Some(format!("rg -n TODO src | head -3 # {SECRET}").as_str()));
        let result = &rows.tool_results[0];
        assert_eq!((result.tool_use_id.as_deref(), result.exit_code, result.duration_ms, result.is_error, result.output_chars), (Some("call_1"), Some(1), Some(250), Some(true), 11 + SECRET.len() as u64));
    }

    #[test]
    fn an_outputs_first_lines_say_how_the_run_ended() {
        let said = |output: Value| {
            let lines = [line(0, "session_meta", json!({ "id": "t-1" })), line(1, "response_item", json!({ "type": "function_call_output", "call_id": "call_1", "output": output }))];
            let result = parse(Agent::Codex, Detail::Everything, &lines).tool_results.remove(0);
            (result.exit_code, result.duration_ms, result.is_error)
        };
        assert_eq!(said(json!("Chunk ID: ab12\nWall time: 0.25 seconds\nProcess exited with code 3\nOriginal token count: 4\nOutput:\nboom")), (Some(3), Some(250), Some(true)));
        assert_eq!(said(json!("Exit code: 0\nWall time: 1.5 seconds\nOutput:\nok")), (Some(0), Some(1500), Some(false)));
        assert_eq!(said(json!([{ "type": "input_text", "text": "Script failed\nWall time 2 seconds\nOutput:\n" }, { "type": "input_text", "text": "Error: boom" }])), (None, Some(2000), Some(true)));
        // What comes after `Output:` is the tool's own, whatever it looks like.
        assert_eq!(said(json!("Script completed\nWall time 0.1 seconds\nOutput:\nExit code: 7")), (None, Some(100), Some(false)));
        assert_eq!(said(json!("Chunk ID: ab12\nWall time: 10 seconds\nProcess running with session ID 4\nOutput:\n")), (None, Some(10000), None));
        assert_eq!(said(json!(format!("All good. {SECRET}"))), (None, None, None));
    }

    #[test]
    fn a_patch_names_the_files_it_changes() {
        let rows = parse(Agent::Codex, Detail::Numbers, &session());
        let files: Vec<_> = rows.files_touched.iter().map(|file| (file.path.as_str(), file.op.as_str(), file.lines_added, file.lines_removed, file.language.as_deref())).collect();
        assert_eq!(files, [("src/a.rs", "edit", Some(2), Some(1), Some("Rust")), ("docs/b.md", "add", Some(1), Some(0), Some("Markdown")), ("src/a.rs", "read", None, None, Some("Rust"))]);
        assert_eq!((rows.tool_calls[1].tool.as_str(), rows.tool_results[1].output_chars), ("apply_patch", 6 + SECRET.len() as u64));
    }

    #[test]
    fn a_command_a_turn_ran_says_how_it_ended() {
        let rows = parse(Agent::Codex, Detail::Everything, &session());
        let command = &rows.commands[1];
        assert_eq!((command.tool_use_id.as_deref(), command.program.as_deref(), command.exit_code, command.duration_ms, command.output_chars), (Some("item_1"), Some("cat"), Some(0), Some(1500), Some(10 + SECRET.len() as u64)));
        assert_eq!(rows.tool_io.last().map(|io| (io.tool_use_id.as_deref(), io.part.as_str())), Some((Some("item_1"), "output")));
    }

    #[test]
    fn a_call_is_counted_from_its_record_and_not_again_from_the_event_after_it() {
        let rows = parse(Agent::Codex, Detail::Everything, &session());
        assert_eq!(rows.requests.len(), 1);
        let request = &rows.requests[0];
        assert_eq!((request.request_id.as_deref(), request.turn_id.as_deref(), request.model.as_deref(), request.effort.as_deref()), (Some("resp_1"), Some("turn-1"), Some("gpt-test-1"), Some("high")));
        assert_eq!((request.input, request.cache_read, request.cache_write, request.output, request.thinking), (290, 700, 10, 50, Some(4)));
    }

    #[test]
    fn an_older_rollout_counts_each_event_once() {
        let event = |ordinal: u64, total: u64| line(ordinal, "event_msg", json!({ "type": "token_count", "info": { "total_token_usage": usage(total, 0, 5), "last_token_usage": usage(100, 0, 5), "model_context_window": 272000 } }));
        let lines = vec![line(0, "turn_context", json!({ "model": "gpt-test-0" })), event(1, 100), event(2, 100), line(3, "event_msg", json!({ "type": "token_count", "info": null })), event(4, 200)];
        let rows = parse(Agent::Codex, Detail::Everything, &lines);
        assert_eq!(rows.requests.iter().map(|request| (request.at.line, request.input, request.context_window)).collect::<Vec<_>>(), [(1, 90, Some(272000)), (4, 90, Some(272000))]);
        let left = serde_json::from_str::<Value>(rows.lines[1].rest.as_deref().unwrap()).unwrap();
        assert_eq!(left["payload"]["info"]["last_token_usage"], json!({ "total_tokens": 105 }));
    }

    #[test]
    fn what_no_column_took_stays_in_rest() {
        let rows = parse(Agent::Codex, Detail::Everything, &session());
        let rest = |line: usize| serde_json::from_str::<Value>(rows.lines[line].rest.as_deref().unwrap_or("{}")).unwrap();
        assert_eq!(rest(0), json!({ "payload": { "session_id": "t-1", "git": { "commit_hash": "abc123" }, "base_instructions": { "provenance": { "type": "default" } } } }));
        assert_eq!(rest(1), json!({ "payload": { "approval_policy": "never" } }));
        assert_eq!(rest(12), json!({ "payload": { "phase": "final" } }));
        assert_eq!(rest(13)["payload"]["time_to_first_token_ms"], json!(400));
        let numbers = parse(Agent::Codex, Detail::Numbers, &session());
        assert_eq!(numbers.lines[13].rest.as_deref(), Some(r#"{"payload":{"duration_ms":9000,"time_to_first_token_ms":400}}"#));
        assert_eq!(numbers.lines[11].rest.as_deref().map(|rest| rest.contains("12.5")), Some(true));
    }
}

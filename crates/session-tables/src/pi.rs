//! Pi's sessions, `sessions/--<folder>--/<time>_<id>.jsonl`, and OpenClaw's, which are written the same way. The
//! first line is the session's header; every other is an entry with an `id`, a `parentId` and a time, and most hold
//! a `message` whose `role` says what it is. Pi documents the format as `session-format.md` and `message-types.md`.

use crate::claude::{command_row, file_touched, prompt, tool_def};
use crate::json::{self, Fields};
use crate::{At, Command, ContextUse, Line, Message, Parser, Request, Rows, ToolCall, ToolIo, ToolResult};
use serde_json::Value;

/// What a line is known by, where it's more than its bytes: a reply by its response's id, which stays the same when
/// a session is copied into another and its entries are given new ids.
pub(crate) fn key(agent: &[u8], fields: &Fields) -> Option<crate::LineKey> {
    let id = fields.get("message")?.get("responseId")?.as_str().filter(|id| !id.is_empty())?;
    Some(json::key(&[agent, b"response", id.as_bytes()]))
}

pub(crate) fn line(parser: &mut Parser, number: u64, bytes: u64, mut fields: Fields, rows: &mut Rows) {
    let kind = json::string(&mut fields, "type").unwrap_or_default();
    let mut row = Line { bytes, ..Line::default() };
    if kind == "session" {
        header(parser, &mut fields, &mut row);
    } else {
        row.id = json::string(&mut fields, "id");
        row.parent_id = json::string(&mut fields, "parentId");
    }
    let mut message = json::object(&mut fields, "message");
    // OpenClaw marks a turn it copied from the harness that ran it, which has the turn in a transcript of its own.
    if message.as_ref().and_then(|message| message.get("__openclaw")).is_some_and(|marks| marks.get("mirrorIdentity").is_some()) {
        parser.repeat = true;
    }
    let at = parser.at(number, json::string(&mut fields, "timestamp"), parser.state.session_id.clone());
    match kind.as_str() {
        "message" => {
            if let Some(message) = message.as_mut() {
                row.subkind = json::string(message, "role");
                // The message's own time is the entry's again, as a number.
                message.remove("timestamp");
                row.model = said(parser, &at, row.subkind.as_deref().unwrap_or_default(), row.id.as_ref(), message, rows);
            }
        }
        "model_change" => {
            parser.state.model = json::string(&mut fields, "modelId").or(parser.state.model.take());
            row.model.clone_from(&parser.state.model);
        }
        "thinking_level_change" => parser.state.effort = json::string(&mut fields, "thinkingLevel").or(parser.state.effort.take()),
        "usage" => {
            row.subkind = json::string(&mut fields, "kind");
            row.model = json::string(&mut fields, "model");
            usage(&at, &mut fields, (row.id.clone(), None, row.model.clone(), None), rows);
        }
        "compaction" | "branch_summary" => {
            let summary = json::string(&mut fields, "summary").unwrap_or_default();
            let kind = if kind == "compaction" { "compact_summary" } else { "branch_summary" };
            rows.messages.push(text(parser, &at, "user", kind, 0, row.id.as_ref(), None, summary));
            usage(&at, &mut fields, (row.id.clone(), None, parser.state.model.clone(), None), rows);
            if let Some(mut system) = json::object(&mut fields, "systemMessage") {
                context(parser, &at, &mut system, rows);
                json::put_back(&mut fields, "systemMessage", system);
            }
        }
        "custom_message" => {
            row.subkind = json::string(&mut fields, "customType");
            for (block, said) in content(&mut fields) {
                rows.messages.push(text(parser, &at, "custom", "custom", block, row.id.as_ref(), None, said));
            }
        }
        "custom" => row.subkind = json::string(&mut fields, "customType"),
        _ => {}
    }
    json::put_back(&mut fields, "message", message.unwrap_or_default());
    row.at = at;
    row.kind = kind;
    row.rest = parser.rest(fields);
    rows.lines.push(row);
}

/// A session's first line: which session it is, where it ran, and the session it was forked from.
fn header(parser: &mut Parser, fields: &mut Fields, row: &mut Line) {
    parser.state.session_id = json::string(fields, "id").or(parser.state.session_id.take());
    row.cwd = json::string(fields, "cwd");
    parser.state.cwd.clone_from(&row.cwd);
    row.agent_version = json::number(fields, "version").map(|version| version.to_string());
    // The parent is named by its file, `<time>_<id>.jsonl`.
    row.parent_session_id = fields.get("parentSession").and_then(Value::as_str).and_then(|path| {
        let stem = path.rsplit(['/', '\\']).next()?.strip_suffix(".jsonl")?;
        Some(stem.rsplit_once('_').map_or(stem, |(_, id)| id).to_string())
    });
}

fn text(parser: &Parser, at: &At, role: &str, kind: &str, block: u32, message_id: Option<&String>, model: Option<&String>, said: String) -> Message {
    Message { at: at.clone(), role: role.into(), kind: kind.into(), block, message_id: message_id.cloned(), request_id: None, model: model.cloned(), meta: None, chars: json::chars(&said), text: parser.text(said) }
}

/// What a message's `content` says, as each text's place in it and the text. Content is a string or a list of
/// blocks; a block that isn't text stays, an image as its size and hash.
fn content(from: &mut Fields) -> Vec<(u32, String)> {
    if let Some(said) = json::string(from, "content") {
        return vec![(0, said)];
    }
    let mut found = Vec::new();
    let mut left = Vec::new();
    for (index, block) in json::array(from, "content").unwrap_or_default().into_iter().enumerate() {
        match block {
            Value::Object(mut block) if block.get("type").and_then(Value::as_str) == Some("text") => {
                found.push((index as u32, json::string(&mut block, "text").unwrap_or_default()));
                // What a provider needs to take its own text back: opaque.
                block.remove("textSignature");
                left.extend(unused(block, index));
            }
            Value::Object(mut block) => {
                image(&mut block);
                left.push(Value::Object(block));
            }
            other => left.push(other),
        }
    }
    if !left.is_empty() {
        from.insert("content".into(), Value::Array(left));
    }
    found
}

/// An image block's bytes, as their size and hash.
fn image(block: &mut Fields) {
    if block.get("type").and_then(Value::as_str) == Some("image") {
        if let Some(data) = json::string(block, "data") {
            block.insert("data_size".into(), json::sized(&data));
        }
    }
}

/// What's left of a block a column was made from, with its place in the message, or nothing when all of it was used.
fn unused(mut block: Fields, index: usize) -> Option<Value> {
    let kind = block.remove("type");
    if block.is_empty() {
        return None;
    }
    block.extend(kind.map(|kind| ("type".to_string(), kind)));
    block.insert("block".into(), Value::from(index));
    Some(Value::Object(block))
}

/// A message, by its role. Gives the model of a reply.
fn said(parser: &mut Parser, at: &At, role: &str, id: Option<&String>, message: &mut Fields, rows: &mut Rows) -> Option<String> {
    match role {
        "assistant" => return Some(reply(parser, at, id, message, rows)).flatten(),
        "toolResult" => tool_result(parser, at, message, rows),
        "system" => context(parser, at, message, rows),
        "bashExecution" => {
            // A command the person ran themselves, with how it ended.
            if let Some(command) = json::string(message, "command") {
                let output = message.get("output").and_then(Value::as_str).map(json::chars);
                let ran = Command { exit_code: json::signed(message, "exitCode"), output_chars: output, ..command_row(parser, at, None, parser.state.cwd.clone(), command) };
                rows.commands.push(ran);
            }
        }
        "branchSummary" | "compactionSummary" => {
            let summary = json::string(message, "summary").unwrap_or_default();
            rows.messages.push(text(parser, at, role, "summary", 0, id, None, summary));
        }
        _ => {
            let kind = if role == "user" { "prompt" } else { "custom" };
            for (block, said) in content(message) {
                rows.messages.push(text(parser, at, role, kind, block, id, None, said));
            }
        }
    }
    None
}

/// The prompt and tools in force. A session's first system message has all of them, and a later one only what
/// changed, so each is kept as what it says and no more.
fn context(parser: &Parser, at: &At, message: &mut Fields, rows: &mut Rows) {
    let mut parts: Vec<String> = content(message).into_iter().map(|(_, said)| said).filter(|said| !said.is_empty()).collect();
    if let Some(mut sections) = json::object(message, "sections") {
        // In the order of their names, whatever order they were written in, so the same prompt has the same hash.
        let mut names: Vec<String> = sections.keys().cloned().collect();
        names.sort();
        for name in names {
            // A section set to nothing is one taken away, which stays as it's written.
            parts.extend(json::string(&mut sections, &name));
        }
        json::put_back(message, "sections", sections);
    }
    let prompt_hash = (!parts.is_empty()).then(|| prompt(parser, parts.join("\n\n"), rows));
    let tool_hashes: Vec<String> = json::array(message, "toolsAdded").unwrap_or_default().into_iter().filter_map(|tool| tool_def(parser, tool, rows)).collect();
    if prompt_hash.is_some() || !tool_hashes.is_empty() {
        rows.context_use.push(ContextUse { at: at.clone(), prompt_hash, tool_hashes });
    }
}

/// Tokens a model call used, where an entry or a message has them. Pi's input already leaves out what was read from
/// and written to the cache, and its output already counts the thinking.
fn usage(at: &At, from: &mut Fields, (message_id, request_id, model, stop_reason): (Option<String>, Option<String>, Option<String>, Option<String>), rows: &mut Rows) {
    let Some(mut usage) = json::object(from, "usage") else {
        return;
    };
    let cache_write_1h = json::number(&mut usage, "cacheWrite1h");
    rows.requests.push(Request {
        at: at.clone(),
        message_id,
        request_id,
        model,
        stop_reason,
        input: json::number(&mut usage, "input").unwrap_or(0),
        output: json::number(&mut usage, "output").unwrap_or(0),
        thinking: json::number(&mut usage, "reasoning"),
        cache_read: json::number(&mut usage, "cacheRead").unwrap_or(0),
        cache_write: json::number(&mut usage, "cacheWrite").unwrap_or(0),
        cache_write_1h,
        ..Request::default()
    });
    // The total is the sum of the numbers above; what each cost stays.
    usage.remove("totalTokens");
    json::put_back(from, "usage", usage);
}

/// A reply: its text, thinking and tool calls, and the call that made it.
fn reply(parser: &mut Parser, at: &At, id: Option<&String>, message: &mut Fields, rows: &mut Rows) -> Option<String> {
    let model = json::string(message, "model").or_else(|| parser.state.model.clone());
    let request_id = json::string(message, "responseId");
    let stop_reason = json::string(message, "stopReason");
    let before = rows.requests.len();
    usage(at, message, (id.cloned(), request_id.clone(), model.clone(), stop_reason), rows);
    let effort = json::string(message, "thinkingLevel").or_else(|| parser.state.effort.clone());
    if let Some(request) = rows.requests.get_mut(before) {
        request.effort = effort;
    }
    let mut left = Vec::new();
    for (index, block) in json::array(message, "content").unwrap_or_default().into_iter().enumerate() {
        let Value::Object(mut block) = block else {
            left.push(block);
            continue;
        };
        let part = |kind: &str, said: String| Message { request_id: request_id.clone(), ..text(parser, at, "assistant", kind, index as u32, id, model.as_ref(), said) };
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                rows.messages.push(part("text", json::string(&mut block, "text").unwrap_or_default()));
                block.remove("textSignature");
            }
            Some("thinking") => {
                let thought = json::string(&mut block, "thinking").unwrap_or_default();
                // What proves the thinking is the model's own, and holds it when it's hidden: opaque either way.
                let hidden = json::string(&mut block, "thinkingSignature").unwrap_or_default();
                if json::boolean(&mut block, "redacted") == Some(true) {
                    rows.messages.push(Message { text: None, ..part("redacted_thinking", hidden) });
                } else {
                    rows.messages.push(part("thinking", thought));
                }
            }
            Some("toolCall") => {
                block.remove("thoughtSignature");
                tool_call(parser, at, &mut block, (id, &request_id), rows);
            }
            _ => {
                left.push(Value::Object(block));
                continue;
            }
        }
        left.extend(unused(block, index));
    }
    if !left.is_empty() {
        message.insert("content".into(), Value::Array(left));
    }
    model
}

fn tool_call(parser: &Parser, at: &At, block: &mut Fields, (message_id, request_id): (Option<&String>, &Option<String>), rows: &mut Rows) {
    let tool_use_id = json::string(block, "id");
    let tool = json::string(block, "name").unwrap_or_default();
    let input = block.remove("arguments").unwrap_or(Value::Null);
    let input_text = serde_json::to_string(&input).unwrap_or_default();
    let field = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_string);
    if tool == "bash" {
        if let Some(command) = field("command") {
            rows.commands.push(command_row(parser, at, tool_use_id.clone(), parser.state.cwd.clone(), command));
        }
    }
    let op = match tool.as_str() {
        "read" => Some("read"),
        "edit" => Some("edit"),
        "write" => Some("write"),
        _ => None,
    };
    if let (Some(op), Some(path)) = (op, field("path").or_else(|| field("file_path"))) {
        rows.files_touched.push(file_touched(at, tool_use_id.clone(), path, op, (None, None)));
    }
    let mcp = tool.strip_prefix("mcp__").and_then(|name| name.split_once("__"));
    rows.tool_calls.push(ToolCall {
        at: at.clone(),
        tool_use_id: tool_use_id.clone(),
        namespace: json::string(block, "namespace"),
        mcp_server: mcp.map(|(server, _)| server.to_string()),
        mcp_tool: mcp.map(|(_, name)| name.to_string()),
        caller: None,
        message_id: message_id.cloned(),
        request_id: request_id.clone(),
        subagent_type: None,
        skill: None,
        background: None,
        // Pi's shell takes its limit in seconds.
        timeout_ms: input.get("timeout").and_then(Value::as_u64).filter(|_| tool == "bash").map(|seconds| seconds.saturating_mul(1000)),
        input_chars: json::chars(&input_text),
        tool,
    });
    if let Some(text) = parser.text(input_text) {
        rows.tool_io.push(ToolIo { at: at.clone(), tool_use_id, part: "input".into(), text });
    }
}

fn tool_result(parser: &Parser, at: &At, message: &mut Fields, rows: &mut Rows) {
    let tool_use_id = json::string(message, "toolCallId");
    let shell = message.get("toolName").and_then(Value::as_str) == Some("bash");
    let said: Vec<String> = content(message).into_iter().map(|(_, said)| said).collect();
    let output = (!said.is_empty()).then(|| said.join("\n"));
    let mut row = ToolResult { at: at.clone(), tool_use_id: tool_use_id.clone(), is_error: json::boolean(message, "isError"), output_chars: output.as_deref().map_or(0, json::chars), ..ToolResult::default() };
    if let Some(mut details) = json::object(message, "details") {
        row.truncated = details.get("truncation").and_then(|cut| cut.get("truncated")).and_then(Value::as_bool).filter(|cut| *cut);
        // An edit's result holds its diff, a line each for what it added and took away.
        if let Some(Value::String(diff)) = details.get("diff") {
            let changed = |mark: char| diff.lines().filter(|line| line.starts_with(mark)).count() as u64;
            (row.lines_added, row.lines_removed) = (Some(changed('+')), Some(changed('-')));
        }
        row.duration_ms = json::number(&mut details, "durationMs");
        json::put_back(message, "details", details);
    }
    if shell {
        // A command that failed ends its output with how: `Command exited with code 2`. One that worked says nothing.
        let ended = output.as_deref().and_then(|text| text.rsplit_once("exited with code ")).and_then(|(_, code)| code.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok());
        row.exit_code = ended.or((row.is_error == Some(false)).then_some(0));
    }
    rows.tool_results.push(row);
    if let Some(text) = output.and_then(|text| parser.text(text)) {
        rows.tool_io.push(ToolIo { at: at.clone(), tool_use_id, part: "output".into(), text });
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use crate::tests::{parse, SECRET};
    use crate::{Agent, Detail};
    use serde_json::{json, Value};

    fn entry(at: u64, kind: &str, more: Value) -> String {
        let mut line = json!({ "type": kind, "id": format!("e{at:07}"), "parentId": if at > 1 { Value::from(format!("e{:07}", at - 1)) } else { Value::Null }, "timestamp": format!("2026-10-03T08:00:{at:02}.000Z") });
        line.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
        line.to_string()
    }

    fn message(at: u64, message: Value) -> String {
        entry(at, "message", json!({ "message": message }))
    }

    fn usage(input: u64, output: u64) -> Value {
        json!({ "input": input, "output": output, "cacheRead": 900, "cacheWrite": 40, "cacheWrite1h": 40, "reasoning": 7, "totalTokens": input + output + 940, "cost": { "input": 0.01, "output": 0.02, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.03 } })
    }

    /// A short made-up session with each kind of entry the parser gives columns to.
    pub(crate) fn session() -> Vec<String> {
        let reply = |at: u64, output: u64, stop: &str, content: Value| message(at, json!({ "role": "assistant", "content": content, "api": "test-messages", "provider": "test", "model": "pi-test-1", "responseId": format!("resp_{at}"), "thinkingLevel": "high", "usage": usage(3, output), "stopReason": stop, "timestamp": 1 }));
        vec![
            json!({ "type": "session", "version": 3, "id": "p-1", "timestamp": "2026-10-03T08:00:00.000Z", "cwd": "/srv/app", "parentSession": "/home/cam/.agent-app/sessions/--srv-app--/2026-10-02T08-00-00-000Z_p-0.jsonl" }).to_string(),
            message(1, json!({ "role": "system", "content": "", "sections": { "preamble": format!("You are a test. {SECRET}"), "cwd": "/srv/app" }, "toolsAdded": [{ "name": "bash", "description": format!("Runs a command. {SECRET}"), "parameters": { "type": "object" } }], "timestamp": 1 })),
            message(2, json!({ "role": "user", "content": [{ "type": "text", "text": format!("Fix the build. {SECRET}") }, { "type": "image", "data": "aGVsbG8=", "mimeType": "image/png" }], "timestamp": 1 })),
            reply(3, 60, "toolUse", json!([{ "type": "thinking", "thinking": format!("Look at the log. {SECRET}"), "thinkingSignature": "c2lnbmF0dXJl" }, { "type": "toolCall", "id": "call_1", "name": "bash", "arguments": { "command": format!("cargo test 2>&1 | tail -20 # {SECRET}"), "timeout": 60 } }, { "type": "toolCall", "id": "call_2", "name": "edit", "arguments": { "path": "src/main.rs", "oldText": "a", "newText": format!("b {SECRET}") } }])),
            message(4, json!({ "role": "toolResult", "toolCallId": "call_1", "toolName": "bash", "content": [{ "type": "text", "text": format!("2 failed {SECRET}\n\nCommand exited with code 101") }], "details": { "truncation": { "truncated": true, "totalLines": 4000 } }, "isError": true, "timestamp": 1 })),
            message(5, json!({ "role": "toolResult", "toolCallId": "call_2", "toolName": "edit", "content": [{ "type": "text", "text": "Edited." }], "details": { "diff": format!("-1 a\n+1 b {SECRET}\n+2 c\n 3 d"), "firstChangedLine": 1 }, "isError": false, "timestamp": 1 })),
            entry(6, "model_change", json!({ "provider": "test", "modelId": "pi-test-2" })),
            entry(7, "thinking_level_change", json!({ "thinkingLevel": "low" })),
            reply(8, 12, "stop", json!([{ "type": "text", "text": format!("Fixed. {SECRET}"), "textSignature": "c2ln" }])),
            message(9, json!({ "role": "bashExecution", "command": format!("git status # {SECRET}"), "output": format!("clean {SECRET}"), "exitCode": 0, "cancelled": false, "truncated": false, "timestamp": 1 })),
            entry(10, "usage", json!({ "kind": "cache_warm", "provider": "test", "model": "pi-test-1", "usage": usage(0, 0) })),
            entry(11, "compaction", json!({ "summary": format!("They fixed the build. {SECRET}"), "firstKeptEntryId": "e0000008", "tokensBefore": 50000, "usage": usage(100, 30) })),
            entry(12, "custom_message", json!({ "customType": "notes", "content": format!("A note. {SECRET}"), "display": true })),
            entry(13, "session_info", json!({ "name": format!("Build fix {SECRET}") })),
        ]
    }

    #[test]
    fn a_session_becomes_rows_in_every_table_it_has_something_for() {
        let rows = parse(Agent::Pi, Detail::Everything, &session());
        assert_eq!(rows.lines.len(), 14);
        assert!(rows.lines.iter().all(|line| line.at.session_id.as_deref() == Some("p-1")));
        let header = &rows.lines[0];
        assert_eq!((header.kind.as_str(), header.cwd.as_deref(), header.parent_session_id.as_deref(), header.agent_version.as_deref()), ("session", Some("/srv/app"), Some("p-0"), Some("3")));
        assert_eq!((rows.lines[3].id.as_deref(), rows.lines[3].parent_id.as_deref(), rows.lines[3].subkind.as_deref(), rows.lines[3].model.as_deref()), (Some("e0000003"), Some("e0000002"), Some("assistant"), Some("pi-test-1")));
        let said: Vec<_> = rows.messages.iter().map(|message| (message.role.as_str(), message.kind.as_str(), message.at.line)).collect();
        assert_eq!(said, [("user", "prompt", 2), ("assistant", "thinking", 3), ("assistant", "text", 8), ("user", "compact_summary", 11), ("custom", "custom", 12)]);
        // A reply, a call that isn't a reply, and a summary's own call.
        let calls: Vec<_> = rows.requests.iter().map(|request| (request.at.line, request.model.as_deref(), request.effort.as_deref(), request.input, request.output, request.cache_read, request.cache_write, request.cache_write_1h, request.thinking)).collect();
        assert_eq!(calls[0], (3, Some("pi-test-1"), Some("high"), 3, 60, 900, 40, Some(40), Some(7)));
        assert_eq!(calls.iter().map(|call| call.0).collect::<Vec<_>>(), [3, 8, 10, 11]);
        assert_eq!((rows.requests[0].request_id.as_deref(), rows.requests[0].stop_reason.as_deref(), rows.requests[0].message_id.as_deref()), (Some("resp_3"), Some("toolUse"), Some("e0000003")));
        // The summary's call has no model of its own, so it's the one chosen before it.
        assert_eq!(rows.requests[3].model.as_deref(), Some("pi-test-2"));
        let tools: Vec<_> = rows.tool_calls.iter().map(|call| (call.tool.as_str(), call.tool_use_id.as_deref(), call.timeout_ms)).collect();
        assert_eq!(tools, [("bash", Some("call_1"), Some(60_000)), ("edit", Some("call_2"), None)]);
        let results: Vec<_> = rows.tool_results.iter().map(|result| (result.tool_use_id.as_deref(), result.is_error, result.exit_code, result.truncated, result.lines_added, result.lines_removed)).collect();
        assert_eq!(results, [(Some("call_1"), Some(true), Some(101), Some(true), None, None), (Some("call_2"), Some(false), None, None, Some(2), Some(1))]);
        // The model's command, and the one the person ran, which says how it ended itself.
        let commands: Vec<_> = rows.commands.iter().map(|command| (command.program.as_deref(), command.tool_use_id.as_deref(), command.exit_code, command.pipes_to_head_tail)).collect();
        assert_eq!(commands, [(Some("cargo"), Some("call_1"), None, true), (Some("git"), None, Some(0), false)]);
        assert_eq!(rows.files_touched.iter().map(|file| (file.path.as_str(), file.op.as_str(), file.language.as_deref())).collect::<Vec<_>>(), [("src/main.rs", "edit", Some("Rust"))]);
        assert_eq!((rows.prompts.len(), rows.tool_defs.len(), rows.context_use.len()), (1, 1, 1));
        assert_eq!(rows.prompts[0].text.as_deref(), Some(format!("/srv/app\n\nYou are a test. {SECRET}").as_str()));
        assert_eq!(rows.tool_io.iter().map(|io| io.part.as_str()).collect::<Vec<_>>(), ["input", "input", "output", "output"]);
    }

    #[test]
    fn what_no_column_holds_stays_and_what_is_opaque_is_a_size() {
        let rows = parse(Agent::Pi, Detail::Everything, &session());
        let rest = |line: usize| serde_json::from_str::<Value>(rows.lines[line].rest.as_deref().unwrap_or("null")).unwrap();
        // An image is its size and hash, and a signature is gone.
        assert_eq!(rest(2)["message"]["content"][0]["data_size"]["bytes"], 8);
        assert_eq!(rest(2)["message"]["content"][0].get("data"), None);
        let all = serde_json::to_string(&rows).unwrap();
        assert!(!all.contains("c2lnbmF0dXJl") && !all.contains("c2ln\""));
        // What a call cost, who served it and what its tool said of the run are kept.
        assert_eq!(rest(3)["message"]["usage"]["cost"]["total"], 0.03);
        assert_eq!(rest(3)["message"]["provider"], "test");
        assert_eq!(rest(4)["message"]["details"]["truncation"]["totalLines"], 4000);
        assert_eq!(rest(11)["tokensBefore"], 50000);
        assert_eq!(rest(13)["name"], format!("Build fix {SECRET}"));
        // With numbers only, a name is text like any other.
        let numbers = parse(Agent::Pi, Detail::Numbers, &session());
        assert_eq!(numbers.lines[13].rest, None);
    }

    #[test]
    fn a_turn_copied_from_the_harness_that_ran_it_is_a_repeat() {
        let copied = message(1, json!({ "role": "assistant", "content": [{ "type": "text", "text": "Done." }], "model": "gpt-test-1", "usage": usage(3, 9), "stopReason": "stop", "__openclaw": { "mirrorIdentity": "m1" } }));
        let own = message(2, json!({ "role": "assistant", "content": [{ "type": "text", "text": "Done." }], "model": "gpt-test-1", "usage": usage(3, 9), "stopReason": "stop" }));
        let rows = parse(Agent::OpenClaw, Detail::Everything, &[copied, own]);
        assert_eq!(rows.requests.iter().map(|request| request.at.repeat).collect::<Vec<_>>(), [true, false]);
        assert_eq!(rows.lines.iter().map(|line| line.at.repeat).collect::<Vec<_>>(), [true, false]);
    }

    #[test]
    fn a_reply_carried_into_another_session_under_a_new_entry_is_a_repeat() {
        let reply = |at: u64, response: &str| message(at, json!({ "role": "assistant", "content": [{ "type": "text", "text": "Done." }], "model": "pi-test-1", "responseId": response, "usage": usage(3, 9), "stopReason": "stop" }));
        let files = crate::tests::parse_files(Agent::OpenClaw, &[vec![reply(1, "resp_1")], vec![reply(7, "resp_1"), reply(8, "resp_2")]]);
        assert_eq!(files[0].requests.iter().map(|request| request.at.repeat).collect::<Vec<_>>(), [false]);
        assert_eq!(files[1].requests.iter().map(|request| request.at.repeat).collect::<Vec<_>>(), [true, false]);
    }
}

//! Claude Code's transcripts: `projects/<folder>/<session>.jsonl` and the subagents' files beside them.

use crate::json::{self, Fields};
use crate::{shell, At, Command, ContextUse, FileTouched, Hook, Line, Message, Parser, Prompt, Request, Rows, ToolCall, ToolDef, ToolIo, ToolResult};
use serde_json::Value;

pub(crate) fn line(parser: &mut Parser, number: u64, bytes: u64, mut fields: Fields, rows: &mut Rows) {
    let kind = json::string(&mut fields, "type").unwrap_or_default();
    let session_id = json::string(&mut fields, "sessionId");
    // Newer lines say the session twice.
    let session_id = match json::string(&mut fields, "session_id") {
        Some(other) => session_id.or(Some(other)),
        None => session_id,
    };
    let at = parser.at(number, json::string(&mut fields, "timestamp"), session_id);
    let mut row = Line {
        at: at.clone(),
        id: json::string(&mut fields, "uuid"),
        parent_id: json::string(&mut fields, "parentUuid"),
        sidechain: json::boolean(&mut fields, "isSidechain"),
        cwd: json::string(&mut fields, "cwd"),
        branch: json::string(&mut fields, "gitBranch"),
        agent_version: json::string(&mut fields, "version"),
        entrypoint: json::string(&mut fields, "entrypoint"),
        user_type: json::string(&mut fields, "userType"),
        slug: json::string(&mut fields, "slug"),
        bytes,
        ..Line::default()
    };
    match kind.as_str() {
        "assistant" => row.model = assistant(parser, &at, &mut fields, rows),
        "user" => user(parser, &at, &mut fields, rows),
        "attachment" => row.subkind = attachment(parser, &at, &mut fields, rows),
        "system" => row.subkind = json::string(&mut fields, "subtype"),
        _ => {}
    }
    row.kind = kind;
    row.rest = parser.rest(fields);
    rows.lines.push(row);
}

/// A reply's line: one block of it, with the request's usage so far. Gives the model.
fn assistant(parser: &mut Parser, at: &At, fields: &mut Fields, rows: &mut Rows) -> Option<String> {
    let mut message = json::object(fields, "message")?;
    let request_id = json::string(fields, "requestId");
    let message_id = json::string(&mut message, "id");
    let model = json::string(&mut message, "model");
    json::string(&mut message, "role");
    json::string(&mut message, "type");

    if let Some(mut usage) = json::object(&mut message, "usage") {
        let mut cache = json::object(&mut usage, "cache_creation").unwrap_or_default();
        let mut server = json::object(&mut usage, "server_tool_use").unwrap_or_default();
        let mut details = json::object(&mut usage, "output_tokens_details").unwrap_or_default();
        let mut diagnostics = json::object(&mut message, "diagnostics").unwrap_or_default();
        let mut miss = json::object(&mut diagnostics, "cache_miss_reason").unwrap_or_default();
        let request = Request {
            at: at.clone(),
            message_id: message_id.clone(),
            request_id: request_id.clone(),
            turn_id: None,
            model: model.clone(),
            effort: json::string(fields, "effort"),
            service_tier: json::string(&mut usage, "service_tier"),
            speed: json::string(&mut usage, "speed"),
            stop_reason: json::string(&mut message, "stop_reason"),
            input: json::number(&mut usage, "input_tokens").unwrap_or(0),
            output: json::number(&mut usage, "output_tokens").unwrap_or(0),
            thinking: json::number(&mut details, "thinking_tokens"),
            cache_read: json::number(&mut usage, "cache_read_input_tokens").unwrap_or(0),
            cache_write: json::number(&mut usage, "cache_creation_input_tokens").unwrap_or(0),
            cache_write_5m: json::number(&mut cache, "ephemeral_5m_input_tokens"),
            cache_write_1h: json::number(&mut cache, "ephemeral_1h_input_tokens"),
            web_searches: json::number(&mut server, "web_search_requests"),
            web_fetches: json::number(&mut server, "web_fetch_requests"),
            cache_miss_reason: json::string(&mut miss, "type"),
            cache_missed_tokens: json::number(&mut miss, "cache_missed_input_tokens"),
            context_window: None,
        };
        json::put_back(&mut usage, "cache_creation", cache);
        json::put_back(&mut usage, "server_tool_use", server);
        json::put_back(&mut usage, "output_tokens_details", details);
        json::put_back(&mut diagnostics, "cache_miss_reason", miss);
        json::put_back(&mut message, "diagnostics", diagnostics);
        json::put_back(&mut message, "usage", usage);
        hold(parser, request, rows);
    }

    let mut left = Vec::new();
    for (index, block) in json::array(&mut message, "content").unwrap_or_default().into_iter().enumerate() {
        let Value::Object(mut block) = block else {
            left.push(block);
            continue;
        };
        let reply = |kind: &str, text: String| Message {
            at: at.clone(),
            role: "assistant".into(),
            kind: kind.into(),
            block: index as u32,
            message_id: message_id.clone(),
            request_id: request_id.clone(),
            model: model.clone(),
            meta: None,
            chars: json::chars(&text),
            text: parser.text(text),
        };
        match block.get("type").and_then(Value::as_str) {
            Some("text") => rows.messages.push(reply("text", json::string(&mut block, "text").unwrap_or_default())),
            Some("thinking") => {
                rows.messages.push(reply("thinking", json::string(&mut block, "thinking").unwrap_or_default()));
                // What proves the thinking is the model's own: opaque, and no use without the API.
                block.remove("signature");
            }
            Some("redacted_thinking") => {
                let hidden = json::string(&mut block, "data").unwrap_or_default();
                rows.messages.push(Message { text: None, ..reply("redacted_thinking", hidden) });
            }
            Some("tool_use") => tool_use(parser, at, &mut block, (&message_id, &request_id), rows),
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
    json::put_back(fields, "message", message);
    model
}

/// Holds a reply's request until a different reply starts, keeping the largest of each number seen for it.
fn hold(parser: &mut Parser, request: Request, rows: &mut Rows) {
    match &mut parser.state.pending {
        Some(held) if held.message_id.is_some() && held.message_id == request.message_id => {
            held.input = held.input.max(request.input);
            held.output = held.output.max(request.output);
            held.thinking = held.thinking.max(request.thinking);
            held.cache_read = held.cache_read.max(request.cache_read);
            held.cache_write = held.cache_write.max(request.cache_write);
            held.cache_write_5m = held.cache_write_5m.max(request.cache_write_5m);
            held.cache_write_1h = held.cache_write_1h.max(request.cache_write_1h);
            held.web_searches = held.web_searches.max(request.web_searches);
            held.web_fetches = held.web_fetches.max(request.web_fetches);
            // The last block's line is the one that says why the reply ended.
            held.stop_reason = request.stop_reason.or(held.stop_reason.take());
            held.cache_miss_reason = request.cache_miss_reason.or(held.cache_miss_reason.take());
            held.cache_missed_tokens = request.cache_missed_tokens.or(held.cache_missed_tokens);
        }
        held => rows.requests.extend(held.replace(request)),
    }
}

/// What's left of a block a column was made from, with its place in the line, or nothing when all of it was used.
fn unused(mut block: Fields, index: usize) -> Option<Value> {
    let kind = block.remove("type");
    if block.is_empty() {
        return None;
    }
    block.extend(kind.map(|kind| ("type".to_string(), kind)));
    block.insert("block".into(), Value::from(index));
    Some(Value::Object(block))
}

fn tool_use(parser: &Parser, at: &At, block: &mut Fields, (message_id, request_id): (&Option<String>, &Option<String>), rows: &mut Rows) {
    let tool_use_id = json::string(block, "id");
    let tool = json::string(block, "name").unwrap_or_default();
    let caller = json::object(block, "caller").and_then(|mut caller| {
        let kind = json::string(&mut caller, "type");
        json::put_back(block, "caller", caller);
        kind
    });
    let input = block.remove("input").unwrap_or(Value::Null);
    let input_text = serde_json::to_string(&input).unwrap_or_default();
    let field = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_string);
    // An MCP tool is named `mcp__<server>__<tool>`.
    let mcp = tool.strip_prefix("mcp__").and_then(|name| name.split_once("__"));

    if tool == "Bash" {
        if let Some(command) = field("command") {
            rows.commands.push(command_row(parser, at, tool_use_id.clone(), None, command));
        }
    }
    let op = match tool.as_str() {
        "Read" => Some("read"),
        "Edit" | "MultiEdit" | "NotebookEdit" => Some("edit"),
        "Write" => Some("write"),
        _ => None,
    };
    if let (Some(op), Some(path)) = (op, field("file_path").or_else(|| field("notebook_path"))) {
        rows.files_touched.push(file_touched(at, tool_use_id.clone(), path, op, (None, None)));
    }
    rows.tool_calls.push(ToolCall {
        at: at.clone(),
        tool_use_id: tool_use_id.clone(),
        namespace: None,
        mcp_server: mcp.map(|(server, _)| server.to_string()),
        mcp_tool: mcp.map(|(_, name)| name.to_string()),
        caller,
        message_id: message_id.clone(),
        request_id: request_id.clone(),
        subagent_type: field("subagent_type"),
        skill: if tool == "Skill" { field("skill") } else { None },
        background: input.get("run_in_background").and_then(Value::as_bool),
        timeout_ms: input.get("timeout").and_then(Value::as_u64),
        input_chars: json::chars(&input_text),
        tool,
    });
    if let Some(text) = parser.text(input_text) {
        rows.tool_io.push(ToolIo { at: at.clone(), tool_use_id, part: "input".into(), text });
    }
}

pub(crate) fn command_row(parser: &Parser, at: &At, tool_use_id: Option<String>, cwd: Option<String>, command: String) -> Command {
    let read = shell::read(&command);
    Command {
        at: at.clone(),
        tool_use_id,
        cwd,
        command_chars: json::chars(&command),
        command: parser.text(command),
        program: read.program,
        programs: read.programs,
        pipes_to_head_tail: read.pipes_to_head_tail,
        uses_grep: read.uses_grep,
        uses_rg: read.uses_rg,
        inline_script: read.inline_script,
        script_language: read.script_language,
        exit_code: None,
        duration_ms: None,
        output_chars: None,
    }
}

pub(crate) fn file_touched(at: &At, tool_use_id: Option<String>, path: String, op: &str, (lines_added, lines_removed): (Option<u64>, Option<u64>)) -> FileTouched {
    let (ext, language) = shell::language(&path);
    FileTouched { at: at.clone(), tool_use_id, path, ext, language, op: op.into(), lines_added, lines_removed }
}

/// A line from the person, or one carrying tools' results back to the model.
fn user(parser: &Parser, at: &At, fields: &mut Fields, rows: &mut Rows) {
    let Some(mut message) = json::object(fields, "message") else {
        return;
    };
    json::string(&mut message, "role");
    let meta = json::boolean(fields, "isMeta");
    let summary = json::boolean(fields, "isCompactSummary") == Some(true);
    let prompt = |block: u32, text: String| Message {
        at: at.clone(),
        role: "user".into(),
        kind: if summary { "compact_summary" } else { "prompt" }.into(),
        block,
        message_id: None,
        request_id: None,
        model: None,
        meta,
        chars: json::chars(&text),
        text: parser.text(text),
    };
    if let Some(text) = json::string(&mut message, "content") {
        rows.messages.push(prompt(0, text));
    }
    // What the tool said of its own run, beside the result the model was given.
    let mut ran = json::object(fields, "toolUseResult");
    let mut left = Vec::new();
    for (index, block) in json::array(&mut message, "content").unwrap_or_default().into_iter().enumerate() {
        let Value::Object(mut block) = block else {
            left.push(block);
            continue;
        };
        match block.get("type").and_then(Value::as_str) {
            Some("text") => rows.messages.push(prompt(index as u32, json::string(&mut block, "text").unwrap_or_default())),
            Some("tool_result") => tool_result(parser, at, &mut block, ran.as_mut(), rows),
            _ => {
                left.push(Value::Object(block));
                continue;
            }
        }
        // A result's images stay with it.
        left.extend(unused(block, index));
    }
    if !left.is_empty() {
        message.insert("content".into(), Value::Array(left));
    }
    json::put_back(fields, "message", message);
    json::put_back(fields, "toolUseResult", ran.unwrap_or_default());
}

fn tool_result(parser: &Parser, at: &At, block: &mut Fields, ran: Option<&mut Fields>, rows: &mut Rows) {
    let tool_use_id = json::string(block, "tool_use_id");
    // Only a shell command's result has an output of its own beside the result.
    let shell = ran.as_ref().is_some_and(|ran| ran.contains_key("stdout"));
    let output = match json::string(block, "content") {
        Some(text) => Some(text),
        None => json::array(block, "content").and_then(|mut items| {
            let text = json::texts(&mut items);
            if !items.is_empty() {
                block.insert("content".into(), Value::Array(items));
            }
            text
        }),
    };
    // A result says `is_error` only when it failed, so one that doesn't say worked.
    let mut row = ToolResult { at: at.clone(), tool_use_id: tool_use_id.clone(), is_error: json::boolean(block, "is_error").or(Some(false)), output_chars: output.as_deref().map_or(0, json::chars), ..ToolResult::default() };
    if let Some(ran) = ran {
        row.interrupted = json::boolean(ran, "interrupted");
        row.user_modified = json::boolean(ran, "userModified");
        row.duration_ms = json::number(ran, "durationMs");
        row.status_code = json::signed(ran, "code");
        row.exit_code = json::signed(ran, "exitCode");
        row.timed_out = ran.contains_key("timedOutAfterMs").then_some(true);
        row.background = ran.contains_key("backgroundTaskId").then_some(true);
        row.truncated = ran.contains_key("persistedOutputPath").then_some(true);
        // The result above is these two put together, so their sizes are enough.
        if output.is_some() {
            row.stdout_chars = json::string(ran, "stdout").as_deref().map(json::chars);
            row.stderr_chars = json::string(ran, "stderr").as_deref().map(json::chars);
        }
        if let Some(Value::Array(hunks)) = ran.get("structuredPatch") {
            let changed = |mark: char| hunks.iter().filter_map(|hunk| hunk.get("lines")?.as_array()).flatten().filter(|line| line.as_str().is_some_and(|line| line.starts_with(mark))).count() as u64;
            (row.lines_added, row.lines_removed) = (Some(changed('+')), Some(changed('-')));
        }
        // The whole file from before an edit: its size and hash, since every edit of a file would hold another copy.
        if let Some(before) = json::string(ran, "originalFile") {
            ran.insert("originalFile_size".into(), json::sized(&before));
        }
    }
    // A command that failed says how in its result's first words, `Exit code 2`; one that worked says nothing.
    let said = output.as_deref().and_then(|text| text.strip_prefix("Exit code ")).and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok());
    let worked = shell && row.is_error == Some(false) && row.interrupted != Some(true) && row.background.is_none();
    row.exit_code = row.exit_code.or(said).or(worked.then_some(0));
    rows.tool_results.push(row);
    if let Some(text) = output.and_then(|text| parser.text(text)) {
        rows.tool_io.push(ToolIo { at: at.clone(), tool_use_id, part: "output".into(), text });
    }
}

/// Something Claude Code added to the conversation itself: a hook's run, the prompt and tools in force, a reminder.
/// Gives the attachment's own type.
fn attachment(parser: &Parser, at: &At, fields: &mut Fields, rows: &mut Rows) -> Option<String> {
    let mut held = json::object(fields, "attachment")?;
    let kind = json::string(&mut held, "type");
    if held.contains_key("hookName") {
        let stdout = json::string(&mut held, "stdout").unwrap_or_default();
        let stderr = json::string(&mut held, "stderr").unwrap_or_default();
        rows.hooks.push(Hook {
            at: at.clone(),
            event: json::string(&mut held, "hookEvent"),
            name: json::string(&mut held, "hookName"),
            tool_use_id: json::string(&mut held, "toolUseID"),
            duration_ms: json::number(&mut held, "durationMs"),
            exit_code: json::signed(&mut held, "exitCode"),
            stdout_chars: json::chars(&stdout),
            stderr_chars: json::chars(&stderr),
            command: json::string(&mut held, "command").and_then(|command| parser.text(command)),
            stdout: parser.text(stdout),
            stderr: parser.text(stderr),
        });
    }
    if kind.as_deref() == Some("prompt_snapshot") {
        let prompt_hash = match held.remove("systemPrompt") {
            Some(Value::String(text)) => Some(text),
            Some(Value::Array(mut parts)) => json::texts(&mut parts),
            _ => None,
        }
        .map(|text| prompt(parser, text, rows));
        let tool_hashes = json::array(&mut held, "tools").unwrap_or_default().into_iter().filter_map(|tool| tool_def(parser, tool, rows)).collect();
        rows.context_use.push(ContextUse { at: at.clone(), prompt_hash, tool_hashes });
    }
    json::put_back(fields, "attachment", held);
    kind
}

/// Adds a system prompt and gives its hash.
pub(crate) fn prompt(parser: &Parser, text: String, rows: &mut Rows) -> String {
    let hash = json::hash(&[&text]);
    rows.prompts.push(Prompt { hash: hash.clone(), chars: json::chars(&text), text: parser.text(text) });
    hash
}

/// Adds a tool's definition and gives its hash. Claude Code keeps the description and schema under `schema`; Codex
/// keeps them on the tool, the schema as `parameters`.
pub(crate) fn tool_def(parser: &Parser, tool: Value, rows: &mut Rows) -> Option<String> {
    let Value::Object(mut tool) = tool else {
        return None;
    };
    let name = json::string(&mut tool, "name")?;
    let mut inner = json::object(&mut tool, "schema").unwrap_or_default();
    let description = json::string(&mut tool, "description").or_else(|| json::string(&mut inner, "description")).unwrap_or_default();
    let schema = if inner.is_empty() { tool.remove("parameters").or_else(|| tool.remove("input_schema")) } else { Some(Value::Object(inner)) };
    let schema = schema.map(|schema| serde_json::to_string(&schema).unwrap_or_default()).unwrap_or_default();
    let hash = json::hash(&[&name, &description, &schema]);
    rows.tool_defs.push(ToolDef {
        hash: hash.clone(),
        name,
        chars: json::chars(&description) + json::chars(&schema),
        description: parser.text(description),
        schema: parser.text(schema),
    });
    Some(hash)
}

#[cfg(test)]
pub(crate) mod tests {
    use crate::tests::{parse, SECRET};
    use crate::{Agent, Detail};
    use serde_json::{json, Value};

    pub(crate) fn base(kind: &str, at: &str, more: Value) -> String {
        let mut line = json!({ "type": kind, "uuid": format!("u-{at}"), "parentUuid": null, "isSidechain": false, "timestamp": format!("2026-10-01T10:00:{at}.000Z"), "sessionId": "s-1", "cwd": "/srv/app", "gitBranch": "main", "version": "9.1.0", "entrypoint": "cli", "userType": "external" });
        line.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
        line.to_string()
    }

    pub(crate) fn reply(at: &str, id: &str, output: u64, stop: Option<&str>, block: Value) -> String {
        let usage = json!({ "input_tokens": 3, "output_tokens": output, "cache_read_input_tokens": 900, "cache_creation_input_tokens": 40, "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 40 }, "service_tier": "standard", "speed": "standard", "output_tokens_details": { "thinking_tokens": 7 }, "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 1 }, "inference_geo": "us" });
        base("assistant", at, json!({ "requestId": format!("req-{id}"), "effort": "high", "message": { "id": id, "type": "message", "role": "assistant", "model": "claude-test-1", "stop_reason": stop, "usage": usage, "content": [block] } }))
    }

    /// A short made-up session with each kind of line the parser gives columns to.
    pub(crate) fn session() -> Vec<String> {
        vec![
            base("attachment", "01", json!({ "attachment": { "type": "prompt_snapshot", "systemPrompt": [format!("You are a test. {SECRET}")], "tools": [{ "name": "Bash", "description": format!("Runs a command. {SECRET}"), "schema": { "name": "Bash", "input_schema": { "type": "object" } } }] } })),
            base("user", "02", json!({ "promptId": "p-1", "permissionMode": "default", "message": { "role": "user", "content": format!("Fix the build. {SECRET}") } })),
            reply("03", "msg_1", 5, None, json!({ "type": "thinking", "thinking": format!("Look at the log. {SECRET}"), "signature": "c2lnbmF0dXJl" })),
            reply("04", "msg_1", 60, Some("tool_use"), json!({ "type": "tool_use", "id": "toolu_1", "name": "Bash", "caller": { "type": "direct" }, "input": { "command": format!("cargo test 2>&1 | tail -20 # {SECRET}"), "description": "Run the tests", "timeout": 60000 } })),
            base("attachment", "05", json!({ "attachment": { "type": "hook_success", "hookName": "PreToolUse:Bash", "hookEvent": "PreToolUse", "toolUseID": "toolu_1", "command": format!("check.sh {SECRET}"), "stdout": format!("ok {SECRET}"), "stderr": "", "exitCode": 0, "durationMs": 12, "content": "" } })),
            base("user", "06", json!({ "sourceToolAssistantUUID": "u-04", "toolUseResult": { "stdout": format!("2 failed {SECRET}"), "stderr": "", "interrupted": false, "isImage": false }, "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_1", "is_error": true, "content": format!("2 failed {SECRET}") }] } })),
            reply("07", "msg_2", 30, Some("tool_use"), json!({ "type": "tool_use", "id": "toolu_2", "name": "Edit", "input": { "file_path": "/srv/app/src/main.rs", "old_string": "a", "new_string": format!("b {SECRET}") } })),
            base("user", "08", json!({ "toolUseResult": { "filePath": "/srv/app/src/main.rs", "originalFile": format!("fn main() {{}} {SECRET}"), "userModified": false, "structuredPatch": [{ "oldStart": 1, "lines": ["-a", format!("+b {SECRET}"), "+c", " d"] }] }, "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_2", "content": [{ "type": "text", "text": "Edited." }, { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "aGVsbG8=" } }] }] } })),
            reply("09", "msg_3", 12, Some("end_turn"), json!({ "type": "text", "text": format!("Fixed. {SECRET}") })),
            base("system", "10", json!({ "subtype": "turn_duration", "durationMs": 8000, "messageCount": 9, "isMeta": true })),
            json!({ "type": "pr-link", "sessionId": "s-1", "prNumber": 12, "prUrl": "https://git.example/app/pull/12", "prRepository": "example/app", "timestamp": "2026-10-01T10:00:11.000Z" }).to_string(),
            reply("12", "msg_4", 4, Some("tool_use"), json!({ "type": "tool_use", "id": "toolu_3", "name": "mcp__tracker__get_issue", "input": { "id": 7 } })),
        ]
    }

    #[test]
    fn a_reply_written_over_several_lines_is_one_request_with_its_largest_numbers() {
        let rows = parse(Agent::Claude, Detail::Everything, &session());
        let requests: Vec<_> = rows.requests.iter().map(|request| (request.message_id.as_deref().unwrap(), request.at.line, request.output, request.stop_reason.as_deref())).collect();
        assert_eq!(requests, [("msg_1", 2, 60, Some("tool_use")), ("msg_2", 6, 30, Some("tool_use")), ("msg_3", 8, 12, Some("end_turn")), ("msg_4", 11, 4, Some("tool_use"))]);
        let first = &rows.requests[0];
        assert_eq!((first.input, first.cache_read, first.cache_write, first.cache_write_1h, first.thinking, first.web_fetches), (3, 900, 40, Some(40), Some(7), Some(1)));
        assert_eq!((first.model.as_deref(), first.effort.as_deref(), first.request_id.as_deref()), (Some("claude-test-1"), Some("high"), Some("req-msg_1")));
    }

    #[test]
    fn each_block_of_a_conversation_is_a_message() {
        let rows = parse(Agent::Claude, Detail::Everything, &session());
        let messages: Vec<_> = rows.messages.iter().map(|message| (message.at.line, message.role.as_str(), message.kind.as_str())).collect();
        assert_eq!(messages, [(1, "user", "prompt"), (2, "assistant", "thinking"), (8, "assistant", "text")]);
        assert_eq!(rows.messages[0].text.as_deref(), Some(format!("Fix the build. {SECRET}").as_str()));
        assert_eq!(rows.messages[1].message_id.as_deref(), Some("msg_1"));
    }

    #[test]
    fn a_tool_call_and_its_result_are_rows_joined_by_the_calls_id() {
        let rows = parse(Agent::Claude, Detail::Everything, &session());
        let calls: Vec<_> = rows.tool_calls.iter().map(|call| (call.tool.as_str(), call.tool_use_id.as_deref().unwrap(), call.mcp_server.as_deref(), call.mcp_tool.as_deref())).collect();
        assert_eq!(calls, [("Bash", "toolu_1", None, None), ("Edit", "toolu_2", None, None), ("mcp__tracker__get_issue", "toolu_3", Some("tracker"), Some("get_issue"))]);
        assert_eq!((rows.tool_calls[0].timeout_ms, rows.tool_calls[0].caller.as_deref()), (Some(60000), Some("direct")));

        let failed = &rows.tool_results[0];
        assert_eq!((failed.tool_use_id.as_deref(), failed.is_error, failed.interrupted), (Some("toolu_1"), Some(true), Some(false)));
        assert_eq!((failed.output_chars, failed.stdout_chars, failed.stderr_chars), (9 + SECRET.len() as u64, Some(9 + SECRET.len() as u64), Some(0)));
        let edited = &rows.tool_results[1];
        assert_eq!((edited.lines_added, edited.lines_removed, edited.user_modified, edited.output_chars, edited.is_error), (Some(2), Some(1), Some(false), 7, Some(false)));

        let io: Vec<_> = rows.tool_io.iter().map(|io| (io.tool_use_id.as_deref().unwrap(), io.part.as_str())).collect();
        assert_eq!(io, [("toolu_1", "input"), ("toolu_1", "output"), ("toolu_2", "input"), ("toolu_2", "output"), ("toolu_3", "input")]);
    }

    /// A command that failed and one that worked, after the lines of `session`, and a line with no time.
    pub(crate) fn commands() -> Vec<String> {
        let call = |at: &str, id: &str| reply(at, &format!("msg_{at}"), 9, Some("tool_use"), json!({ "type": "tool_use", "id": id, "name": "Bash", "input": { "command": "ls missing", "run_in_background": id == "toolu_11" } }));
        let result = |at: &str, id: &str, ran: Value, failed: bool, said: &str| base("user", at, json!({ "toolUseResult": ran, "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": id, "is_error": failed, "content": said }] } }));
        vec![
            call("20", "toolu_8"),
            result("22", "toolu_8", json!("Error: Exit code 2"), true, "Exit code 2\nls: missing: No such file"),
            json!({ "type": "mode", "mode": "default", "sessionId": "s-1" }).to_string(),
            call("23", "toolu_9"),
            result("24", "toolu_9", json!({ "stdout": "a.rs", "stderr": "", "interrupted": false }), false, "a.rs"),
            // As a subagent's file has them: the result alone. One worked, and one was sent to the background.
            call("25", "toolu_10"),
            result("26", "toolu_10", Value::Null, false, "ok"),
            call("27", "toolu_11"),
            result("28", "toolu_11", Value::Null, false, "Started"),
        ]
    }

    #[test]
    fn a_shell_result_says_its_exit_code_in_its_first_words_and_one_that_worked_is_zero() {
        let rows = parse(Agent::Claude, Detail::Everything, &[session(), commands()].concat());
        let ended: Vec<_> = rows.tool_results.iter().map(|result| (result.tool_use_id.as_deref().unwrap(), result.is_error, result.exit_code)).collect();
        // The first failed without saying how, and an edit has no exit code.
        assert_eq!(ended, [("toolu_1", Some(true), None), ("toolu_2", Some(false), None), ("toolu_8", Some(true), Some(2)), ("toolu_9", Some(false), Some(0)), ("toolu_10", Some(false), None), ("toolu_11", Some(false), None)]);
    }

    #[test]
    fn a_shell_command_and_a_file_tool_say_what_they_touched() {
        let rows = parse(Agent::Claude, Detail::Numbers, &session());
        let command = &rows.commands[0];
        assert_eq!((command.program.as_deref(), command.programs.as_slice(), command.pipes_to_head_tail, command.command.as_deref()), (Some("cargo"), ["cargo".to_string(), "tail".to_string()].as_slice(), true, None));
        let file = &rows.files_touched[0];
        assert_eq!((file.path.as_str(), file.op.as_str(), file.language.as_deref(), file.tool_use_id.as_deref()), ("/srv/app/src/main.rs", "edit", Some("Rust"), Some("toolu_2")));
    }

    #[test]
    fn a_hook_and_the_prompt_in_force_are_rows() {
        let rows = parse(Agent::Claude, Detail::Everything, &session());
        let hook = &rows.hooks[0];
        assert_eq!((hook.name.as_deref(), hook.event.as_deref(), hook.tool_use_id.as_deref(), hook.duration_ms, hook.exit_code), (Some("PreToolUse:Bash"), Some("PreToolUse"), Some("toolu_1"), Some(12), Some(0)));
        assert_eq!((rows.prompts.len(), rows.tool_defs.len()), (1, 1));
        assert_eq!(rows.tool_defs[0].schema.as_deref(), Some(r#"{"input_schema":{"type":"object"},"name":"Bash"}"#));
        assert_eq!(rows.context_use[0].prompt_hash.as_deref(), Some(rows.prompts[0].hash.as_str()));
        assert_eq!(rows.context_use[0].tool_hashes, [rows.tool_defs[0].hash.clone()]);
    }

    #[test]
    fn every_line_is_a_row_and_what_no_column_took_is_in_its_rest() {
        let rows = parse(Agent::Claude, Detail::Everything, &session());
        assert_eq!(rows.lines.len(), session().len());
        let kinds: Vec<_> = rows.lines.iter().map(|line| (line.kind.as_str(), line.subkind.as_deref())).collect();
        assert_eq!(&kinds[..2], [("attachment", Some("prompt_snapshot")), ("user", None)]);
        assert_eq!((kinds[9], kinds[10]), (("system", Some("turn_duration")), ("pr-link", None)));
        let first = &rows.lines[1];
        assert_eq!((first.cwd.as_deref(), first.branch.as_deref(), first.agent_version.as_deref(), first.at.session_id.as_deref()), (Some("/srv/app"), Some("main"), Some("9.1.0"), Some("s-1")));
        assert_eq!(rows.lines[3].model.as_deref(), Some("claude-test-1"));

        let rest = |line: usize| serde_json::from_str::<Value>(rows.lines[line].rest.as_deref().unwrap_or("{}")).unwrap();
        assert_eq!(rest(1), json!({ "promptId": "p-1", "permissionMode": "default" }));
        assert_eq!(rest(9), json!({ "durationMs": 8000, "messageCount": 9, "isMeta": true }));
        assert_eq!(rest(10), json!({ "prNumber": 12, "prUrl": "https://git.example/app/pull/12", "prRepository": "example/app" }));
        // A reply's line keeps the usage fields no column holds.
        assert_eq!(rest(2), json!({ "message": { "usage": { "inference_geo": "us" } } }));
    }

    #[test]
    fn the_four_bulky_things_are_left_as_sizes() {
        let rows = parse(Agent::Claude, Detail::Everything, &session());
        let all = serde_json::to_string(&rows).unwrap();
        assert!(!all.contains("c2lnbmF0dXJl"), "a thinking signature");
        assert!(!all.contains("aGVsbG8="), "an image");
        assert!(!all.contains("fn main()"), "a file from before an edit");
        let edit = serde_json::from_str::<Value>(rows.lines[7].rest.as_deref().unwrap()).unwrap();
        assert_eq!(edit["toolUseResult"]["originalFile_size"]["bytes"], json!(13 + SECRET.len()));
        assert_eq!(edit["message"]["content"][0]["content"][0]["source"]["data_size"]["bytes"], json!(8));
    }
}

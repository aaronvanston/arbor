//! `arbor mcp`: Arbor as an MCP server over stdio, for Claude Code, Codex or any agent that speaks MCP. Each command
//! and window action the app lists is a tool. A change that asks first in the app answers with its plan until the
//! agent calls it again with `confirm: true`, so the agent shows the person what it's about to do. `--read-only`
//! offers only the tools that look.

use super::client::{Answer, Client, Failure};
use serde_json::{json, Map, Value};
use std::{
    io::{BufRead, Write},
    time::Duration,
};

const SERVER_NAME: &str = "arbor";
/// The MCP version answered when the agent doesn't name one.
const MCP_VERSION: &str = "2025-06-18";

/// MCP tool names allow letters, digits, `_` and `-`; a window action's dot becomes `__`.
fn tool_name(method: &str) -> String {
    method.replace('.', "__")
}

fn method_name(tool: &str) -> String {
    tool.replace("__", ".")
}

/// A TypeScript type from the command table as a JSON Schema, as closely as plain types allow; anything richer is an
/// object or a list the agent fills from the description.
fn schema_for(ts_type: &str) -> Value {
    let base = ts_type.trim_end_matches(" | null").trim();
    let kind = match base {
        "string" => json!({ "type": "string" }),
        "number" => json!({ "type": "number" }),
        "boolean" => json!({ "type": "boolean" }),
        "JsonValue" => json!({}),
        _ if base.starts_with("Array<") => json!({ "type": "array" }),
        _ if base.starts_with('"') => json!({ "type": "string", "enum": base.split(" | ").map(|value| value.trim_matches('"')).collect::<Vec<_>>() }),
        _ => json!({ "type": "object" }),
    };
    let mut schema = kind;
    if let Some(fields) = schema.as_object_mut() {
        fields.insert("description".into(), Value::String(format!("TypeScript type {ts_type}, as in Arbor's src/native/types.ts")));
    }
    schema
}

/// The tools for everything `hello` listed.
pub(crate) fn tools(hello: &Value, read_only: bool) -> Vec<Value> {
    let methods = hello.get("methods").unwrap_or(&Value::Null);
    let listed = ["commands", "windowActions"]
        .iter()
        .flat_map(|group| methods.get(*group).and_then(Value::as_array).cloned().unwrap_or_default());
    listed
        .filter_map(|method| {
            let name = method.get("name")?.as_str()?.to_string();
            let access = method.get("access").and_then(Value::as_str).unwrap_or("write");
            if read_only && access != "read" {
                return None;
            }
            let mut properties = Map::new();
            let mut required = Vec::new();
            for arg in method.get("args").and_then(Value::as_array).into_iter().flatten() {
                let Some(arg_name) = arg.get("name").and_then(Value::as_str) else { continue };
                properties.insert(arg_name.into(), schema_for(arg.get("tsType").and_then(Value::as_str).unwrap_or("JsonValue")));
                if arg.get("optional") != Some(&Value::Bool(true)) {
                    required.push(Value::String(arg_name.into()));
                }
            }
            let mut description = method.get("summary").and_then(Value::as_str).unwrap_or_default().trim_end_matches('.').to_string();
            description.push('.');
            if access == "confirm" {
                properties.insert(
                    "confirm".into(),
                    json!({ "type": "boolean", "description": "Set only after showing the person the plan this tool answers with first, and they agreed." }),
                );
                description.push_str(" Asks first: without confirm it only answers with what it would do.");
            }
            Some(json!({
                "name": tool_name(&name),
                "description": description,
                "inputSchema": { "type": "object", "properties": properties, "required": required },
                "annotations": { "readOnlyHint": access == "read", "destructiveHint": access == "confirm" },
            }))
        })
        .collect()
}

fn text_result(text: String, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

/// Runs one tool call against the app.
fn call_tool(client: &mut Client, read_only: bool, params: &Value) -> Value {
    let tool = params.get("name").and_then(Value::as_str).unwrap_or_default();
    let mut args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let confirm = args.as_object_mut().and_then(|fields| fields.remove("confirm")).and_then(|value| value.as_bool()).unwrap_or(false);
    let method = method_name(tool);
    if read_only && !tools(&client.hello, true).iter().any(|listed| listed.get("name").and_then(Value::as_str) == Some(tool)) {
        return text_result(format!("{tool} isn't available: this server only offers tools that look."), true);
    }
    match client.ask(&method, args, confirm) {
        Ok(Answer::Ok(value)) => text_result(serde_json::to_string_pretty(&value).unwrap_or_default(), false),
        Ok(Answer::Plan(plan)) => text_result(
            format!(
                "Nothing has changed yet. Show the person this plan, and call {tool} again with confirm: true only if they agree.\n{}",
                serde_json::to_string_pretty(&plan).unwrap_or_default()
            ),
            false,
        ),
        Err(failure) => text_result(failure.message, true),
    }
}

fn reply(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn reply_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Answers one JSON-RPC message; None for a notification, which gets no answer.
fn answer(client: &mut Result<Client, Failure>, connect: &dyn Fn() -> Result<Client, Failure>, read_only: bool, message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let method = message.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    // The app may have quit and come back since the last call; one fresh connection is tried before giving up.
    let ready = |client: &mut Result<Client, Failure>| -> Result<(), String> {
        if client.is_err() {
            *client = connect();
        }
        client.as_ref().map(|_| ()).map_err(|failure| failure.message.clone())
    };
    Some(match method {
        "initialize" => {
            let version = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(MCP_VERSION);
            reply(
                &id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
                    "instructions": "Arbor runs the proxy that shares this person's AI accounts across their machines. Tools that change things and ask first answer with a plan; show it and only call again with confirm: true when the person agrees.",
                }),
            )
        }
        "ping" => reply(&id, json!({})),
        "tools/list" => match ready(client) {
            Ok(()) => {
                let hello = client.as_ref().map(|client| client.hello.clone()).unwrap_or_default();
                reply(&id, json!({ "tools": tools(&hello, read_only) }))
            }
            Err(message) => reply_error(&id, -32000, &message),
        },
        "tools/call" => match ready(client) {
            Ok(()) => {
                let Ok(connected) = client.as_mut() else { return Some(reply_error(&id, -32000, "Arbor isn't reachable")) };
                let result = call_tool(connected, read_only, &params);
                // A dropped connection is reopened on the next call.
                if result.get("isError") == Some(&Value::Bool(true)) && connected.ask("hello", json!({ "client": "mcp" }), false).is_err() {
                    *client = Err(Failure { code: 69, message: String::new() });
                }
                reply(&id, result)
            }
            Err(message) => reply(&id, text_result(message, true)),
        },
        _ => reply_error(&id, -32601, &format!("Arbor's MCP server doesn't handle {method}")),
    })
}

/// Serves MCP on stdin and stdout until stdin closes.
pub(crate) fn serve(read_only: bool, launch: bool, timeout: Duration) -> Result<(), Failure> {
    let connect = move || Client::connect("mcp", launch, timeout);
    let mut client = connect();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(message) => answer(&mut client, &connect, read_only, &message),
            Err(_) => Some(reply_error(&Value::Null, -32700, "That message isn't JSON")),
        };
        if let Some(response) = response {
            if writeln!(stdout, "{response}").and_then(|()| stdout.flush()).is_err() {
                break;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello() -> Value {
        json!({ "methods": {
            "commands": [
                { "name": "get_machine_health", "access": "read", "summary": "Every machine's health",
                  "args": [{ "name": "passive", "tsType": "boolean | null", "optional": true }] },
                { "name": "stop_core_process", "access": "confirm", "summary": "Stops the proxy", "args": [] },
            ],
            "windowActions": [
                { "name": "limits.read", "access": "read", "summary": "Account limits", "args": [] },
            ],
        }})
    }

    #[test]
    fn every_method_is_a_tool_and_changes_that_ask_take_confirm() {
        let listed = tools(&hello(), false);
        let names: Vec<&str> = listed.iter().filter_map(|tool| tool["name"].as_str()).collect();
        assert_eq!(names, ["get_machine_health", "stop_core_process", "limits__read"]);
        assert_eq!(listed[0]["inputSchema"]["properties"]["passive"]["type"], "boolean");
        assert_eq!(listed[0]["inputSchema"]["required"], json!([]));
        assert_eq!(listed[1]["inputSchema"]["properties"]["confirm"]["type"], "boolean");
        assert_eq!(listed[1]["annotations"]["destructiveHint"], true);
        assert_eq!(method_name("limits__read"), "limits.read");
    }

    #[test]
    fn read_only_offers_only_what_looks() {
        let names: Vec<String> = tools(&hello(), true).iter().filter_map(|tool| tool["name"].as_str().map(String::from)).collect();
        assert_eq!(names, ["get_machine_health", "limits__read"]);
    }

    #[test]
    fn it_introduces_itself_without_reaching_arbor() {
        let unreachable = || Err(Failure { code: 69, message: "Arbor isn't running.".into() });
        let mut client = unreachable();
        let message = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } });
        let response = answer(&mut client, &unreachable, false, &message).unwrap();
        assert_eq!(response["result"]["protocolVersion"], "2025-03-26");
        assert!(answer(&mut client, &unreachable, false, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        let listed = answer(&mut client, &unreachable, false, &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).unwrap();
        assert_eq!(listed["error"]["message"], "Arbor isn't running.");
    }

    #[test]
    fn types_become_schemas() {
        assert_eq!(schema_for("string | null")["type"], "string");
        assert_eq!(schema_for("Array<MachineHost>")["type"], "array");
        assert_eq!(schema_for("UsageQuery")["type"], "object");
        assert_eq!(schema_for("\"claude\" | \"codex\"")["enum"], json!(["claude", "codex"]));
    }
}

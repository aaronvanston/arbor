//! Printing the app's answers for a person: aligned tables and short summaries. `--json` skips all of this and prints
//! the answer as the app gave it.

use serde_json::Value;

/// Columns padded to their widest cell, with a header row.
pub(crate) fn table(headers: &[&str], rows: &[Vec<String>]) -> String {
    let mut widths: Vec<usize> = headers.iter().map(|header| header.chars().count()).collect();
    for row in rows {
        for (index, cell) in row.iter().enumerate() {
            if let Some(width) = widths.get_mut(index) {
                *width = (*width).max(cell.chars().count());
            }
        }
    }
    let line = |cells: Vec<&str>| {
        let padded: Vec<String> = cells
            .iter()
            .enumerate()
            .map(|(index, cell)| {
                let width = widths.get(index).copied().unwrap_or(0);
                if index + 1 == cells.len() {
                    cell.to_string()
                } else {
                    format!("{cell:<width$}")
                }
            })
            .collect();
        padded.join("  ").trim_end().to_string()
    };
    let mut out = vec![line(headers.to_vec())];
    out.extend(rows.iter().map(|row| line(row.iter().map(String::as_str).collect())));
    out.join("\n")
}

/// A field as text: strings as they are, numbers and the rest as JSON, nothing as a dash.
pub(crate) fn text(value: &Value) -> String {
    match value {
        Value::Null => "–".into(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

pub(crate) fn field(value: &Value, name: &str) -> String {
    text(value.get(name).unwrap_or(&Value::Null))
}

/// 1234567 as 1.2M.
pub(crate) fn count(value: &Value) -> String {
    let Some(number) = value.as_f64() else {
        return text(value);
    };
    let (scaled, unit) = match number.abs() {
        n if n >= 1e9 => (number / 1e9, "B"),
        n if n >= 1e6 => (number / 1e6, "M"),
        n if n >= 1e3 => (number / 1e3, "K"),
        _ => return format!("{number:.0}"),
    };
    format!("{scaled:.1}{unit}")
}

pub(crate) fn dollars(value: &Value) -> String {
    value.as_f64().map_or_else(|| text(value), |amount| format!("${amount:.2}"))
}

/// A time in ms since the epoch as how long ago it was.
pub(crate) fn ago(value: &Value, now_ms: i64) -> String {
    let Some(at) = value.as_i64().or_else(|| value.as_f64().map(|at| at as i64)) else {
        return "–".into();
    };
    let seconds = (now_ms - at).max(0) / 1000;
    match seconds {
        0..=59 => "just now".into(),
        60..=3599 => format!("{}m ago", seconds / 60),
        3600..=86_399 => format!("{}h ago", seconds / 3600),
        _ => format!("{}d ago", seconds / 86_400),
    }
}

pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(crate) fn items<'a>(value: &'a Value, name: &str) -> &'a [Value] {
    value.get(name).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// The machines from `get_machine_health`.
pub(crate) fn machines(snapshot: &Value) -> String {
    let now = now_ms();
    let rows: Vec<Vec<String>> = items(snapshot, "machines")
        .iter()
        .map(|machine| {
            let name = field(machine, "machine");
            let local = if machine.get("local") == Some(&Value::Bool(true)) { " (this Mac)" } else { "" };
            vec![
                format!("{name}{local}"),
                field(machine, "status"),
                field(machine, "score"),
                ago(machine.get("lastOkAt").unwrap_or(&Value::Null), now),
                machine.get("error").filter(|error| !error.is_null()).map(text).unwrap_or_default(),
            ]
        })
        .collect();
    if rows.is_empty() {
        return "No machines yet. Add them in Arbor's Settings › Machines.".into();
    }
    table(&["MACHINE", "STATUS", "SCORE", "LAST OK", "PROBLEM"], &rows)
}

/// Why a run didn't start or stopped, from its reason and the code its harness or machine gave.
fn run_reason(run: &Value) -> String {
    let detail = field(run, "detail");
    match field(run, "reason").as_str() {
        "noPool" => "the pool was removed".into(),
        "noRoom" => "every member was busy, unreachable or out of date".into(),
        "noHarness" => "members had room, but none had the harness running with that agent".into(),
        "noFolder" if run.get("detail").is_some_and(|detail| !detail.is_null()) => format!("no member that could take it has the folder (looked on {detail})"),
        "noFolder" => "the folder isn't on the machine it went to".into(),
        "noModel" => "T3 Code needs a model".into(),
        "handOffFailed" => format!("the harness didn't take it ({detail})"),
        "arborRestarted" => "Arbor quit while it was waiting".into(),
        "canceled" => "it was taken out of the queue".into(),
        "agentFailed" => "the agent stopped with an error".into(),
        _ => "it didn't start".into(),
    }
}

/// Where a session went and what it works in, for the line that says it started.
fn run_place(run: &Value) -> String {
    let harness = match field(run, "used").as_str() {
        "orca" => "Orca",
        "headless" => "the command line",
        "t3" => "T3 Code",
        _ => "the harness",
    };
    let worktree = run.pointer("/handle/worktree").and_then(Value::as_str).map(|name| format!(", in its own worktree {name}")).unwrap_or_default();
    format!("{} on {}: {}{worktree}", harness, field(run, "machine"), field(run, "folder"))
}

/// `start_pool_run`'s answer, worded: where the session went, that it waits, or why it didn't start (an error, so the
/// exit code says so too).
pub(crate) fn run_started(run: &Value) -> Result<String, String> {
    match field(run, "state").as_str() {
        "handedOff" | "running" => Ok(format!("Started in {}.", run_place(run))),
        "queued" => Ok(format!("Waiting in the pool's queue: {}. It starts once a member has room.", run_reason(run))),
        _ => Err(format!("The session didn't start: {}.", run_reason(run))),
    }
}

/// What `arbor pools start` would do, in a line, for the person to agree to before it runs with --yes. The prompt
/// isn't repeated: they just wrote it.
pub(crate) fn session_plan(request: &Value, pool: &str) -> String {
    let runs_in = if field(request, "harness") == "headless" { "on its own command line" } else { "in Orca" };
    let worktree = if request.get("worktree") == Some(&Value::Bool(true)) { ", in a worktree of its own" } else { "" };
    let start = match request.get("repo").and_then(Value::as_str) {
        Some(repo) => format!("{runs_in} on whichever member of {pool} has room and a checkout of {repo}{worktree}"),
        None => format!("{runs_in} in {}{worktree}, on whichever member of {pool} has room", field(request, "folder")),
    };
    format!("This would start {} {start}.\nNothing has changed. Run it again with --yes to go ahead.", field(request, "setup"))
}

/// The latest sessions started on pools (`get_runs`), newest first, narrowed to one pool when `pool` is its id.
pub(crate) fn recent_runs(runs: &Value, pool: Option<&str>) -> String {
    let now = now_ms();
    let rows: Vec<Vec<String>> = runs
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|run| pool.is_none_or(|pool| field(run, "pool") == pool || field(run, "ranPool") == pool))
        .take(20)
        .map(|run| {
            let place = match run.get("repo").and_then(Value::as_str) {
                Some(repo) if field(run, "machine") == "–" => repo.to_string(),
                _ => field(run, "folder"),
            };
            vec![field(run, "state"), field(run, "title"), field(run, "machine"), place, ago(run.get("queuedAtMs").unwrap_or(&Value::Null), now)]
        })
        .collect();
    if rows.is_empty() {
        return "No sessions started on a pool yet. Start one with arbor pools start.".into();
    }
    table(&["STATE", "TITLE", "MACHINE", "WHERE", "STARTED"], &rows)
}

/// Each pool from `get_pools`, with who would take its next run and how each member stands, from `preview_pools`.
pub(crate) fn pools(value: &Value) -> String {
    let pools = items(value, "pools");
    if pools.is_empty() {
        return "No machine pools yet. Make one in Arbor's Settings › Pools.".into();
    }
    let previews = items(value, "previews");
    pools
        .iter()
        .map(|pool| {
            let id = field(pool, "id");
            let preview = previews.iter().find(|preview| field(preview, "pool") == id);
            let next = match preview.and_then(|preview| preview.get("likely")).and_then(Value::as_str) {
                Some(machine) => format!("next run most likely on {machine}"),
                None => match field(pool, "whenFull").as_str() {
                    "queue" => format!("no member has room; a run would wait up to {} min", field(pool, "queueTimeoutMin")),
                    "spill" => "no member has room; a run would go to its overflow pool".into(),
                    _ => "no member has room; a run wouldn't start".into(),
                },
            };
            let rows: Vec<Vec<String>> = items(pool, "members")
                .iter()
                .map(|member| {
                    let machine = field(member, "machine");
                    let verdict = preview.and_then(|preview| items(preview, "members").iter().find(|entry| field(entry, "machine") == machine).cloned());
                    let share = verdict.as_ref().and_then(|verdict| verdict.get("share")).and_then(Value::as_f64).unwrap_or(0.0);
                    vec![
                        machine,
                        field(member, "weight"),
                        verdict.as_ref().map(|verdict| field(verdict, "kind")).unwrap_or_default(),
                        if share > 0.0 { format!("{:.0}%", share * 100.0) } else { "-".into() },
                    ]
                })
                .collect();
            let members = if rows.is_empty() { "  No machines yet.".into() } else { table(&["MACHINE", "WEIGHT", "NOW", "NEXT RUN"], &rows) };
            format!("{} ({next})\n{members}", field(pool, "name"))
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Sessions from `get_live_sessions` or a page of `get_usage_sessions`.
pub(crate) fn sessions(sessions: &[Value]) -> String {
    let now = now_ms();
    let rows: Vec<Vec<String>> = sessions
        .iter()
        .map(|session| {
            let models = items(session, "models").iter().map(text).collect::<Vec<_>>().join(", ");
            vec![
                field(session, "machine"),
                field(session, "provider"),
                models,
                count(session.get("requests").unwrap_or(&Value::Null)),
                count(session.get("totalTokens").unwrap_or(&Value::Null)),
                dollars(session.get("estimatedCost").unwrap_or(&Value::Null)),
                ago(session.get("lastActiveAtMs").unwrap_or(&Value::Null), now),
                field(session, "id"),
            ]
        })
        .collect();
    if rows.is_empty() {
        return "No sessions.".into();
    }
    table(&["MACHINE", "PROVIDER", "MODELS", "REQUESTS", "TOKENS", "COST", "LAST ACTIVE", "ID"], &rows)
}

/// The totals from `get_usage_overview`.
pub(crate) fn usage(overview: &Value, range: &str) -> String {
    let get = |name: &str| overview.get(name).unwrap_or(&Value::Null);
    let rate = get("successRate").as_f64().map_or("–".into(), |rate| format!("{rate:.1}%"));
    let mut out = vec![
        format!("Usage, {range}"),
        format!("  Requests      {} ({rate} succeeded)", count(get("totalRequests"))),
        format!("  Tokens        {}", count(get("totalTokens"))),
        format!("  Cost          {}", dollars(get("estimatedCost"))),
        format!("  Avg latency   {} ms", get("averageLatencyMs").as_f64().map_or("–".into(), |ms| format!("{ms:.0}"))),
    ];
    let machines: Vec<Vec<String>> = items(overview, "machines")
        .iter()
        .map(|machine| vec![field(machine, "machine"), count(get_in(machine, "requests")), count(get_in(machine, "tokens"))])
        .collect();
    if !machines.is_empty() {
        out.push(String::new());
        out.push(table(&["MACHINE", "REQUESTS", "TOKENS"], &machines));
    }
    out.join("\n")
}

fn get_in<'a>(value: &'a Value, name: &str) -> &'a Value {
    value.get(name).unwrap_or(&Value::Null)
}

/// `get_core_status` in a line.
pub(crate) fn core(status: &Value) -> String {
    let version = status.get("currentVersion").and_then(Value::as_str).unwrap_or("not installed");
    let state = match (status.get("running"), status.get("ready")) {
        (Some(Value::Bool(true)), Some(Value::Bool(true))) => "running",
        (Some(Value::Bool(true)), _) => "starting",
        _ => "stopped",
    };
    format!("Proxy core {version}: {state}")
}

/// `accounts.list` from the window.
pub(crate) fn accounts(answer: &Value) -> String {
    let now = now_ms();
    let rows: Vec<Vec<String>> = items(answer, "accounts")
        .iter()
        .map(|account| {
            let limits: Vec<String> = items(account, "limits")
                .iter()
                .map(|limit| {
                    let left = limit.get("remainingPercent").and_then(Value::as_f64).map_or("–".into(), |left| format!("{left:.0}%"));
                    format!("{} {left}", field(limit, "label"))
                })
                .collect();
            let easing = account.get("easing") == Some(&Value::Bool(true));
            let cap = account.get("cap").and_then(Value::as_f64).map_or(String::new(), |cap| format!("{cap:.0}%{}", if easing { " easing" } else { "" }));
            vec![
                field(account, "id"),
                field(account, "name"),
                field(account, "provider"),
                field(account, "state"),
                if limits.is_empty() { "–".into() } else { limits.join(" · ") },
                cap,
                ago(account.get("checkedAtMs").unwrap_or(&Value::Null), now),
            ]
        })
        .collect();
    if rows.is_empty() {
        return "No accounts yet. Add one in Arbor's Accounts › Sign-ins.".into();
    }
    table(&["ID", "ACCOUNT", "PROVIDER", "STATE", "LIMITS LEFT", "CAP", "CHECKED"], &rows)
}

/// `alerts.list` from the window.
pub(crate) fn alerts(answer: &Value) -> String {
    let now = now_ms();
    let rows: Vec<Vec<String>> = items(answer, "alerts")
        .iter()
        .map(|alert| {
            let unread = if alert.get("unread") == Some(&Value::Bool(true)) { "•" } else { "" };
            vec![unread.into(), ago(alert.get("atMs").unwrap_or(&Value::Null), now), field(alert, "kind"), field(alert, "title"), field(alert, "body")]
        })
        .collect();
    if rows.is_empty() {
        return "No alerts.".into();
    }
    table(&["", "WHEN", "KIND", "TITLE", "DETAIL"], &rows)
}

/// `sync.status` from the window.
pub(crate) fn sync_status(answer: &Value) -> String {
    let commit: String = field(answer, "commit").chars().take(7).collect();
    const KINDS: [&str; 6] = ["files", "skills", "mcp", "hooks", "plugins", "projects"];
    let rows: Vec<Vec<String>> = items(answer, "machines")
        .iter()
        .map(|machine| {
            let counts = machine.get("counts").unwrap_or(&Value::Null);
            let state = match field(machine, "state").as_str() {
                "inStep" => "in step",
                "behind" => "behind",
                "unreachable" => "not answering",
                _ => "not scanned",
            };
            let mut row = vec![field(machine, "machine"), state.into()];
            row.extend(KINDS.iter().map(|kind| match counts.get(*kind).and_then(Value::as_u64).unwrap_or(0) {
                0 => String::new(),
                count => count.to_string(),
            }));
            row
        })
        .collect();
    let in_step = answer.get("inStep").and_then(Value::as_u64).unwrap_or(0);
    let read = answer.get("read").and_then(Value::as_u64).unwrap_or(0);
    let mut out = vec![format!("Setup repo {} at {commit}: {in_step} of {read} machines in step", field(answer, "repo"))];
    out.push(table(&["MACHINE", "STATE", "FILES", "SKILLS", "MCP", "HOOKS", "PLUGINS", "PROJECTS"], &rows));
    for problem in items(answer, "problems") {
        if let Some(text) = problem.as_str() {
            out.push(format!("Not counted: {text}"));
        }
    }
    out.join("\n")
}

/// `sync.plan` from the window.
pub(crate) fn sync_plan(answer: &Value) -> String {
    let rows: Vec<Vec<String>> = items(answer, "files")
        .iter()
        .map(|file| {
            let applies = if file.get("changes") == Some(&Value::Bool(true)) { "yes" } else { "" };
            vec![field(file, "state"), field(file, "kind"), field(file, "path"), applies.into()]
        })
        .collect();
    if rows.is_empty() {
        return format!("{} is in step with the setup repo.", field(answer, "machine"));
    }
    table(&["STATE", "KIND", "PATH", "APPLY CHANGES"], &rows)
}

/// Everything there is to call, from `hello`.
pub(crate) fn commands(hello: &Value, filter: Option<&str>) -> String {
    let methods = hello.get("methods").unwrap_or(&Value::Null);
    let listed = items(methods, "commands").iter().chain(items(methods, "windowActions"));
    let rows: Vec<Vec<String>> = listed
        .filter(|method| filter.is_none_or(|filter| field(method, "name").contains(filter)))
        .map(|method| {
            let args: Vec<String> = items(method, "args")
                .iter()
                .map(|arg| {
                    let optional = if arg.get("optional") == Some(&Value::Bool(true)) { "?" } else { "" };
                    format!("{}{optional}", field(arg, "name"))
                })
                .collect();
            let access = match field(method, "access").as_str() {
                "confirm" => "asks",
                "write" => "changes",
                _ => "reads",
            };
            vec![field(method, "name").replace('_', "-"), access.into(), args.join(" "), field(method, "summary")]
        })
        .collect();
    table(&["COMMAND", "DOES", "ARGUMENTS", "WHAT IT IS"], &rows)
}

/// A change that needs `--yes`, as what it would do.
pub(crate) fn plan(plan: &Value) -> String {
    let args = plan.get("args").filter(|args| args.as_object().is_some_and(|fields| !fields.is_empty()));
    let mut out = vec![format!("This would: {}", field(plan, "summary").trim_end_matches('.'))];
    if let Some(args) = args {
        out.push(format!("With: {args}"));
    }
    out.push("Nothing has changed. Run it again with --yes to go ahead.".into());
    out.join("\n")
}

/// Where `arbor skill install` put the skill, where it was already, and where it couldn't go.
pub(crate) fn skill_install(answer: &Value) -> String {
    let mut out = Vec::new();
    for (label, field) in [("Added the arbor skill to", "written"), ("Already there", "already"), ("Couldn't write", "failed")] {
        let places: Vec<String> = items(answer, field).iter().map(text).collect();
        if !places.is_empty() {
            out.push(format!("{label}:"));
            out.extend(places.iter().map(|place| format!("  {place}")));
        }
    }
    if !items(answer, "written").is_empty() {
        out.push("Undo it in Sync › Repo › History.".into());
    }
    out.join("\n")
}

/// What `arbor archive export` wrote, and the sessions it couldn't put back together.
pub(crate) fn archive_export(report: &Value) -> String {
    let megabytes = report.get("bytes").and_then(Value::as_f64).map_or("–".into(), |bytes| format!("{:.1} MB", bytes / 1e6));
    let sessions = report.get("sessions").and_then(Value::as_u64).unwrap_or(0);
    let mut out = vec![format!(
        "Exported {sessions} session{} ({} files, {megabytes}) to {}",
        if sessions == 1 { "" } else { "s" },
        count(report.get("files").unwrap_or(&Value::Null)),
        field(report, "out"),
    )];
    let projects: Vec<String> = items(report, "projects").iter().map(text).collect();
    if !projects.is_empty() {
        out.push(format!("Projects: {}", projects.join(", ")));
    }
    let failed = items(report, "failed");
    if !failed.is_empty() {
        out.push(format!("{} couldn't be read in full; what could be read is in their folders:", failed.len()));
        out.extend(failed.iter().map(|failure| format!("  {}  {}", field(failure, "sessionId"), field(failure, "error"))));
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_archive_export_says_where_it_went_and_what_it_missed() {
        let done = json!({ "out": "/Users/cam/exports", "sessions": 1, "files": 3, "bytes": 2_500_000, "projects": ["acme/ledger"], "failed": [] });
        assert_eq!(archive_export(&done), "Exported 1 session (3 files, 2.5 MB) to /Users/cam/exports\nProjects: acme/ledger");
        let partly = json!({ "out": "/x", "sessions": 2, "files": 1, "bytes": 10, "projects": [], "failed": [{ "sessionId": "0f8b", "error": "Couldn't read chunk 1a2b3c4d5e6f" }] });
        let text = archive_export(&partly);
        assert!(text.starts_with("Exported 2 sessions") && text.contains("  0f8b  Couldn't read chunk"), "{text}");
    }

    #[test]
    fn a_pool_session_says_where_it_went_that_it_waits_or_why_it_didnt_start() {
        let started = json!({ "state": "handedOff", "used": "orca", "machine": "cedar-02", "folder": "/home/cam/storefront", "handle": { "worktree": "arbor-5e1f0a2b" } });
        assert_eq!(run_started(&started).unwrap(), "Started in Orca on cedar-02: /home/cam/storefront, in its own worktree arbor-5e1f0a2b.");
        assert!(run_started(&json!({ "state": "queued", "reason": "noRoom" })).unwrap().starts_with("Waiting in the pool's queue: every member was busy"));
        let refused = json!({ "state": "refused", "reason": "noFolder", "detail": "cedar-02, ci-01" });
        assert_eq!(run_started(&refused).unwrap_err(), "The session didn't start: no member that could take it has the folder (looked on cedar-02, ci-01).");
        let runs = json!([
            { "state": "handedOff", "title": "Fix it", "pool": "p1", "machine": "cedar-02", "folder": "/home/cam/storefront", "repo": "github.com/acme/storefront", "queuedAtMs": 0 },
            { "state": "refused", "title": "Elsewhere", "pool": "p2", "machine": null, "folder": "", "repo": "github.com/acme/uploads", "queuedAtMs": 0 },
        ]);
        let all = recent_runs(&runs, None);
        assert!(all.contains("/home/cam/storefront") && all.contains("github.com/acme/uploads"), "{all}");
        assert!(!recent_runs(&runs, Some("p1")).contains("Elsewhere"));
        assert!(recent_runs(&json!([]), None).starts_with("No sessions"));
        let request = json!({ "harness": "orca", "setup": "claude", "repo": "github.com/acme/storefront", "worktree": true, "prompt": "secret plan" });
        let plan = session_plan(&request, "Builds");
        assert!(plan.starts_with("This would start claude in Orca on whichever member of Builds has room and a checkout of github.com/acme/storefront, in a worktree of its own."), "{plan}");
        assert!(!plan.contains("secret plan"));
    }

    #[test]
    fn sync_status_says_each_machines_standing_by_kind_and_what_wasnt_counted() {
        let answer = json!({
            "repo": "/Users/cam/agent-setup", "commit": "a1b2c3d4e5f6", "inStep": 1, "read": 2,
            "machines": [
                { "machine": "cam-mbp", "state": "inStep", "counts": { "files": 0, "skills": 0, "mcp": 0, "hooks": 0, "plugins": 0, "projects": 0 } },
                { "machine": "ci-01", "state": "behind", "counts": { "files": 0, "skills": 0, "mcp": 0, "hooks": 0, "plugins": 2, "projects": 1 } },
                { "machine": "lab-box", "state": "notScanned", "counts": {} },
            ],
            "problems": [".agents/hooks.json isn't JSON Arbor can read"],
        });
        let shown = sync_status(&answer);
        assert!(shown.starts_with("Setup repo /Users/cam/agent-setup at a1b2c3d: 1 of 2 machines in step\n"), "{shown}");
        assert!(shown.contains("ci-01    behind") && shown.contains("2        1"), "{shown}");
        assert!(shown.contains("lab-box  not scanned"), "{shown}");
        assert!(shown.ends_with("Not counted: .agents/hooks.json isn't JSON Arbor can read"), "{shown}");
    }

    #[test]
    fn a_table_lines_up_and_leaves_no_trailing_space() {
        let shown = table(&["A", "B"], &[vec!["long cell".into(), "x".into()], vec!["s".into(), "".into()]]);
        assert_eq!(shown, "A          B\nlong cell  x\ns");
    }

    #[test]
    fn the_success_rate_arrives_as_a_percent() {
        let shown = usage(&json!({ "successRate": 98.25, "totalRequests": 400 }), "today");
        assert!(shown.contains("(98.2% succeeded)") || shown.contains("(98.3% succeeded)"), "{shown}");
    }

    #[test]
    fn numbers_read_as_a_person_would_say_them() {
        assert_eq!(count(&json!(1_234_567)), "1.2M");
        assert_eq!(count(&json!(950)), "950");
        assert_eq!(dollars(&json!(3.456)), "$3.46");
        assert_eq!(ago(&json!(1_000), 1_000 + 3 * 3_600_000), "3h ago");
        assert_eq!(ago(&Value::Null, 0), "–");
    }

    #[test]
    fn machines_and_the_core_read_plainly() {
        let snapshot = json!({ "machines": [
            { "machine": "cam-mbp", "local": true, "status": "healthy", "score": 98, "lastOkAt": null, "error": null },
        ]});
        assert!(machines(&snapshot).contains("cam-mbp (this Mac)  healthy"));
        assert_eq!(machines(&json!({ "machines": [] })), "No machines yet. Add them in Arbor's Settings › Machines.");
        let pools_out = pools(&json!({
            "pools": [{ "id": "p1", "name": "Builds", "whenFull": "queue", "queueTimeoutMin": 30, "members": [
                { "machine": "cam-mbp", "weight": "prefer" }, { "machine": "ci-01", "weight": "less" },
            ]}],
            "previews": [{ "pool": "p1", "likely": null, "members": [
                { "machine": "cam-mbp", "kind": "agentsFull", "share": 0.0 }, { "machine": "ci-01", "kind": "cpuHigh", "share": 0.0 },
            ]}],
        }));
        assert!(pools_out.starts_with("Builds (no member has room; a run would wait up to 30 min)"));
        assert!(pools_out.contains("agentsFull"));
        assert_eq!(core(&json!({ "running": true, "ready": true, "currentVersion": "8.0.4" })), "Proxy core 8.0.4: running");
    }

    #[test]
    fn a_plan_says_nothing_changed_yet() {
        let shown = plan(&json!({ "summary": "Restart core process", "args": {} }));
        assert_eq!(shown, "This would: Restart core process\nNothing has changed. Run it again with --yes to go ahead.");
    }
}

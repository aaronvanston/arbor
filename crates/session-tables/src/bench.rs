//! Fills the tables with made-up sessions by the million rows, and times making them and asking of them. Ignored in
//! the normal run: it needs the engine, and release, where the parsers are compiled optimized:
//!
//! ```sh
//! SESSION_TABLES_DUCKDB=<duckdb> cargo test --release bench -- --ignored --nocapture
//! ```
//!
//! `SESSION_TABLES_BENCH_TURNS` (default 100,000, about 5 million rows) sizes it. `SESSION_TABLES_BENCH_DIR` makes
//! the tables in a folder of your choosing and keeps them, so a query can be timed again without making them.
//!
//! The sessions are shaped like real ones: a prompt, a few rounds of thinking and tool calls with their results, a
//! reply; shell commands of the kinds agents run; now and then a tool output megabytes long, which is what a merge's
//! memory is sized for; and one session in twenty carried on in a second file that repeats the first.

use crate::store::{Engine, Origin, Program, Store};
use crate::{Agent, Detail, LineKey, Parser, ProxyRequest, Rows, State};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// What Arbor writes a batch at, and merges at.
const BATCH_BYTES: u64 = 64 << 20;
const MERGE_AT: usize = 8;
/// The longest a query may take at the default size. Arbor stops one at 30 seconds.
const SLOWEST: Duration = Duration::from_secs(10);

/// 2026-11-01, the day after the last made-up session.
const END_MS: i64 = 1_793_491_200_000;
const DAYS: u64 = 180;
const MACHINES: [&str; 3] = ["cam-mbp", "cedar-1", "cedar-2"];
const CLAUDE_MODELS: [&str; 3] = ["claude-test-large", "claude-test-medium", "claude-test-small"];
const CODEX_MODELS: [&str; 2] = ["gpt-test-large", "gpt-test-small"];
const FOLDERS: [&str; 6] = ["/srv/app", "/srv/app/web", "/srv/tools", "/home/cam/notes", "/srv/api", "/srv/api/server"];
const FILES: [&str; 12] = ["src/main.rs", "src/store.rs", "web/src/App.tsx", "web/src/index.css", "scripts/build.sh", "docs/readme.md", "server/app.py", "server/models.py", "pkg/run/run.go", "Cargo.toml", "package.json", "tests/store.test.ts"];
const COMMANDS: [&str; 16] = [
    "cargo test 2>&1 | tail -20",
    "rg -n TODO src | head -5",
    "grep -rn 'fn main' src",
    "git status --short",
    "git diff --stat | tail -3",
    "cd web && bun run build",
    "ls -la src",
    "sed -n 1,80p src/main.rs",
    "bun test tests/store.test.ts",
    "python3 - <<'PY'\nimport json\nprint(json.dumps({'ok': True}))\nPY",
    "node -e \"console.log(process.version)\"",
    "cat package.json | head -40",
    "find . -name '*.rs' | wc -l",
    "cargo clippy --all-targets -- -D warnings",
    "git log --oneline -5",
    "curl -s http://127.0.0.1:1420/ | head -c 200",
];
const WORDS: [&str; 48] = [
    "the", "build", "fails", "when", "store", "opens", "a", "file", "that", "is", "missing", "so", "check", "its", "path", "before", "reading", "and", "return", "an", "error", "with", "name", "test", "passes", "now", "but", "merge",
    "still", "needs", "sorting", "by", "month", "each", "row", "has", "session", "id", "which", "joins", "tables", "together", "for", "queries", "over", "many", "days", "fn",
];

/// A small deterministic generator, so every run makes the same sessions.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound.max(1)
    }

    fn between(&mut self, least: u64, most: u64) -> u64 {
        least + self.below(most - least + 1)
    }

    fn pick<'a>(&mut self, from: &[&'a str]) -> &'a str {
        from[self.below(from.len() as u64) as usize]
    }

    fn id(&mut self) -> String {
        format!("{:016x}-{:04x}-4{:03x}-{:016x}", self.next(), self.below(0x10000), self.below(0x1000), self.next())
    }

    /// About `chars` of words, with numbers among them so it compresses as text does and not as one repeated line.
    fn text(&mut self, chars: u64) -> String {
        let mut text = String::with_capacity(chars as usize + 16);
        while (text.len() as u64) < chars {
            if self.below(9) == 0 {
                text.push_str(&format!("{} ", self.below(100_000)));
            } else {
                text.push_str(self.pick(&WORDS));
                text.push(if self.below(14) == 0 { '\n' } else { ' ' });
            }
        }
        text
    }

    /// A tool's output: short, or a screen or two, or once in a few thousand megabytes long.
    fn output(&mut self) -> String {
        match self.below(3000) {
            0 => {
                let chars = self.between(1 << 20, 3 << 20);
                self.text(chars)
            }
            n if n < 600 => {
                let chars = self.between(2000, 12_000);
                self.text(chars)
            }
            _ => {
                let chars = self.between(20, 900);
                self.text(chars)
            }
        }
    }
}

fn env_number(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|value| value.parse().ok()).unwrap_or(default)
}

/// A time in milliseconds as a transcript writes it.
fn stamp(ms: i64) -> String {
    let (days, rest) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let shifted = days + 719_468;
    let (era, day_of_era) = (shifted.div_euclid(146_097), shifted.rem_euclid(146_097));
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rest / 3_600_000, rest / 60_000 % 60, rest / 1000 % 60, rest % 1000)
}

/// A session being made up: its lines so far, and the requests a proxy would have seen for them.
struct Session {
    id: String,
    cwd: &'static str,
    model: &'static str,
    at: i64,
    lines: Vec<String>,
    requests: Vec<ProxyRequest>,
}

impl Session {
    fn new(rng: &mut Rng, models: &[&'static str]) -> Self {
        let at = END_MS - (rng.below(DAYS * 86_400_000) as i64) - 86_400_000;
        Self { id: rng.id(), cwd: rng.pick(&FOLDERS), model: rng.pick(models), at, lines: Vec::new(), requests: Vec::new() }
    }

    fn tick(&mut self, rng: &mut Rng) -> String {
        self.at += rng.between(40, 4000) as i64;
        stamp(self.at)
    }

    fn proxied(&mut self, rng: &mut Rng, output: u64, cache_read: u64) {
        let ttft = rng.between(300, 4000);
        self.requests.push(ProxyRequest {
            ts: Some(stamp(self.at)),
            session_id: Some(self.id.clone()),
            provider: Some(if self.model.starts_with("claude") { "claude" } else { "codex" }.into()),
            account: Some(format!("a{}", rng.below(4))),
            model: Some(self.model.into()),
            failed: rng.below(200) == 0,
            latency_ms: Some(ttft + output * 1000 / rng.between(30, 140)),
            ttft_ms: Some(ttft),
            input: rng.between(3, 4000),
            output,
            cache_read,
            cost: Some(output as f64 * 0.000_025 + cache_read as f64 * 0.000_000_5),
            ..ProxyRequest::default()
        });
    }
}

fn claude_line(kind: &str, more: Value, session: &mut Session, rng: &mut Rng) {
    let mut line = json!({ "type": kind, "uuid": rng.id(), "parentUuid": null, "isSidechain": false, "timestamp": session.tick(rng), "sessionId": session.id, "cwd": session.cwd, "gitBranch": "main", "version": "9.1.0", "entrypoint": "cli", "userType": "external" });
    line.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
    session.lines.push(line.to_string());
}

fn claude_reply(message: &str, usage: &Value, stop: &str, block: Value, session: &mut Session, rng: &mut Rng) {
    let more = json!({ "requestId": format!("req-{message}"), "message": { "id": message, "type": "message", "role": "assistant", "model": session.model, "stop_reason": stop, "usage": usage, "content": [block] } });
    claude_line("assistant", more, session, rng);
}

/// One reply's usage, and the request a proxy would have seen for it.
fn claude_usage(session: &mut Session, rng: &mut Rng) -> Value {
    let (output, cache_read) = (rng.between(20, 3000), rng.between(5000, 150_000));
    session.proxied(rng, output, cache_read);
    json!({ "input_tokens": rng.between(3, 400), "output_tokens": output, "cache_read_input_tokens": cache_read, "cache_creation_input_tokens": 400, "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 400 }, "service_tier": "standard", "output_tokens_details": { "thinking_tokens": output / 4 } })
}

fn claude_start(session: &mut Session, rng: &mut Rng) {
    // A handful of system prompts and tool lists, shared by every session, as a release of an agent shares its own.
    let release = rng.below(5);
    let tools: Vec<Value> = ["Bash", "Read", "Edit", "Grep", "Write", "Task"].iter().map(|name| json!({ "name": name, "description": format!("{name}, as release {release} describes it."), "schema": { "name": name, "input_schema": { "type": "object" } } })).collect();
    let mut prompt = Rng(release + 1).text(18_000);
    prompt.push_str(&format!(" release {release}"));
    claude_line("attachment", json!({ "attachment": { "type": "prompt_snapshot", "systemPrompt": [prompt], "tools": tools } }), session, rng);
}

fn claude_turn(session: &mut Session, rng: &mut Rng) {
    let prompt = rng.between(40, 700);
    claude_line("user", json!({ "promptId": rng.id(), "permissionMode": "default", "message": { "role": "user", "content": rng.text(prompt) } }), session, rng);
    for _ in 0..rng.between(1, 4) {
        let message = format!("msg_{:012x}", rng.below(1 << 48));
        let usage = claude_usage(session, rng);
        let thinking = rng.between(150, 2500);
        claude_reply(&message, &usage, "tool_use", json!({ "type": "thinking", "thinking": rng.text(thinking), "signature": "c2lnbmF0dXJl" }), session, rng);
        let mut calls = Vec::new();
        for _ in 0..rng.between(1, 3) {
            let id = format!("toolu_{:016x}", rng.next());
            let file = format!("{}/{}", session.cwd, rng.pick(&FILES));
            let (tool, input) = match rng.below(20) {
                0..=10 => ("Bash", json!({ "command": rng.pick(&COMMANDS), "description": "Run it", "timeout": 60_000 })),
                11..=14 => ("Read", json!({ "file_path": file })),
                15..=17 => ("Edit", json!({ "file_path": file, "old_string": rng.text(60), "new_string": rng.text(90) })),
                18 => ("Grep", json!({ "pattern": rng.pick(&WORDS), "path": session.cwd })),
                _ => ("mcp__tracker__get_issue", json!({ "id": rng.below(900) })),
            };
            claude_reply(&message, &usage, "tool_use", json!({ "type": "tool_use", "id": id, "name": tool, "input": input }), session, rng);
            // A hook runs before some calls, as a formatter or a check does.
            if rng.below(6) == 0 {
                let hook = json!({ "type": "hook_success", "hookName": format!("PreToolUse:{tool}"), "hookEvent": "PreToolUse", "toolUseID": id, "command": "check.sh", "stdout": "ok", "stderr": "", "exitCode": u64::from(rng.below(40) == 0), "durationMs": rng.between(3, 400) });
                claude_line("attachment", json!({ "attachment": hook }), session, rng);
            }
            calls.push((id, tool, file));
        }
        for (id, tool, file) in calls {
            let failed = rng.below(12) == 0;
            let output = if failed { format!("Exit code 1\n{}", rng.text(200)) } else { rng.output() };
            let ran = match tool {
                "Bash" => json!({ "stdout": output, "stderr": "", "interrupted": false, "isImage": false }),
                "Edit" => json!({ "filePath": file, "originalFile": rng.text(6000), "userModified": false, "structuredPatch": [{ "oldStart": 1, "lines": ["-a", "+b", "+c", " d"] }] }),
                _ => json!({ "durationMs": rng.between(5, 900) }),
            };
            claude_line("user", json!({ "toolUseResult": ran, "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": id, "is_error": failed, "content": output }] } }), session, rng);
        }
    }
    let message = format!("msg_{:012x}", rng.below(1 << 48));
    let usage = claude_usage(session, rng);
    let reply = rng.between(80, 1800);
    claude_reply(&message, &usage, "end_turn", json!({ "type": "text", "text": rng.text(reply) }), session, rng);
    claude_line("system", json!({ "subtype": "turn_duration", "durationMs": rng.between(2000, 90_000), "isMeta": true }), session, rng);
    // Now and then a turn ends with a pull request.
    if rng.below(40) == 0 {
        let number = rng.below(900);
        let link = json!({ "type": "pr-link", "sessionId": session.id, "prNumber": number, "prUrl": format!("https://git.example/app/pull/{number}"), "prRepository": "example/app", "timestamp": session.tick(rng) });
        session.lines.push(link.to_string());
    }
}

fn codex_line(kind: &str, payload: Value, session: &mut Session, rng: &mut Rng) {
    let line = json!({ "timestamp": session.tick(rng), "type": kind, "payload": payload });
    session.lines.push(line.to_string());
}

fn codex_start(session: &mut Session, rng: &mut Rng) {
    let release = rng.below(5);
    let mut prompt = Rng(release + 11).text(14_000);
    prompt.push_str(&format!(" release {release}"));
    codex_line("session_meta", json!({ "id": session.id, "session_id": session.id, "cwd": session.cwd, "cli_version": "0.99.0", "originator": "codex_cli", "git": { "branch": "main", "commit_hash": "abc123" }, "base_instructions": { "text": prompt } }), session, rng);
}

fn codex_turn(session: &mut Session, rng: &mut Rng, total: &mut (u64, u64, u64)) {
    let turn = rng.id();
    codex_line("turn_context", json!({ "turn_id": turn, "cwd": session.cwd, "model": session.model, "effort": "high", "approval_policy": "never" }), session, rng);
    let prompt = rng.between(40, 700);
    codex_line("response_item", json!({ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": rng.text(prompt) }] }), session, rng);
    for _ in 0..rng.between(2, 7) {
        let summary = rng.between(60, 500);
        codex_line("response_item", json!({ "type": "reasoning", "summary": [{ "type": "summary_text", "text": rng.text(summary) }], "encrypted_content": "ZW5jcnlwdGVk" }), session, rng);
        let call = format!("call_{:016x}", rng.next());
        if rng.below(8) == 0 {
            let patch = format!("*** Begin Patch\n*** Update File: {}\n@@\n-{}\n+{}\n+{}\n*** End Patch", rng.pick(&FILES), rng.text(50), rng.text(70), rng.text(40));
            codex_line("response_item", json!({ "type": "custom_tool_call", "status": "completed", "call_id": call, "name": "apply_patch", "input": patch }), session, rng);
            codex_line("response_item", json!({ "type": "custom_tool_call_output", "call_id": call, "output": [{ "type": "input_text", "text": "Done." }] }), session, rng);
        } else {
            let arguments = json!({ "cmd": rng.pick(&COMMANDS), "workdir": session.cwd, "yield_time_ms": 1000 }).to_string();
            codex_line("response_item", json!({ "type": "function_call", "status": "completed", "name": "exec_command", "call_id": call, "arguments": arguments }), session, rng);
            let output = format!("Chunk ID: {:06x}\nWall time: 0.{:02} seconds\nProcess exited with code {}\nOriginal token count: 40\nOutput:\n{}", rng.below(1 << 24), rng.below(100), u64::from(rng.below(13) == 0), rng.output());
            codex_line("response_item", json!({ "type": "function_call_output", "call_id": call, "output": output }), session, rng);
        }
        let (input, cached, output) = (rng.between(4000, 150_000), rng.between(2000, 4000), rng.between(20, 2500));
        *total = (total.0 + input, total.1 + cached, total.2 + output);
        session.proxied(rng, output, cached);
        let usage = |(input, cached, output): (u64, u64, u64)| json!({ "input_tokens": input, "cached_input_tokens": cached, "output_tokens": output, "reasoning_output_tokens": output / 5, "total_tokens": input + output });
        codex_line("token_usage_record", json!({ "thread_id": session.id, "turn_id": turn, "response_id": format!("resp_{:012x}", rng.below(1 << 48)), "usage": usage((input, cached, output)), "thread_token_usage": usage(*total) }), session, rng);
    }
    let reply = rng.between(80, 1800);
    codex_line("response_item", json!({ "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": rng.text(reply) }], "phase": "final" }), session, rng);
    codex_line("event_msg", json!({ "type": "task_complete", "turn_id": turn, "duration_ms": rng.between(2000, 90_000), "time_to_first_token_ms": rng.between(200, 3000) }), session, rng);
}

/// How many rows went to each table that keeps every row it's given.
#[derive(Default)]
struct Made {
    lines: u64,
    bytes: u64,
    repeats: u64,
    rows: u64,
    files: u64,
    sessions: u64,
    proxied: u64,
    parsing: Duration,
    writing: Duration,
    merging: Duration,
}

fn fill(store: &mut Store, engine: &Program, turns: u64) -> Made {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut made = Made::default();
    let mut earlier: HashSet<LineKey> = HashSet::new();
    let mut batch = store.batch().unwrap();
    let mut waiting: Vec<ProxyRequest> = Vec::new();
    let mut left = turns;
    while left > 0 {
        let agent = if rng.below(20) < 11 { Agent::Claude } else { Agent::Codex };
        let mut session = Session::new(&mut rng, if agent == Agent::Claude { &CLAUDE_MODELS } else { &CODEX_MODELS });
        let machine = rng.pick(&MACHINES);
        let mut total = (0, 0, 0);
        match agent {
            Agent::Claude => claude_start(&mut session, &mut rng),
            _ => codex_start(&mut session, &mut rng),
        }
        // Most sessions are short and a few are very long.
        let length = if rng.below(25) == 0 { rng.between(60, 400) } else { rng.between(1, 30) }.min(left);
        left -= length;
        // One in twenty is carried on in a second file, which starts with all of the first.
        let carried_on = rng.below(20) == 0;
        let cut = if carried_on { length / 2 } else { length };
        for file in 0..=u64::from(carried_on) {
            for _ in if file == 0 { 0..cut } else { cut..length } {
                match agent {
                    Agent::Claude => claude_turn(&mut session, &mut rng),
                    _ => codex_turn(&mut session, &mut rng, &mut total),
                }
            }
            let started = Instant::now();
            let mut parser = Parser::new(agent, Detail::Everything, State::default());
            let mut rows = Rows::default();
            let mut mine: Vec<LineKey> = Vec::with_capacity(session.lines.len());
            for (number, line) in session.lines.iter().enumerate() {
                let mut seen = |key: LineKey| {
                    mine.push(key);
                    earlier.contains(&key)
                };
                parser.line_once(number as u64, line.as_bytes(), &mut seen, &mut rows);
                made.bytes += line.len() as u64 + 1;
            }
            parser.finish(&mut rows);
            earlier.extend(mine);
            made.lines += rows.lines.len() as u64;
            made.repeats += rows.lines.iter().filter(|line| line.at.repeat).count() as u64;
            made.rows += [rows.lines.len(), rows.messages.len(), rows.requests.len(), rows.tool_calls.len(), rows.tool_results.len(), rows.tool_io.len(), rows.commands.len(), rows.hooks.len(), rows.context_use.len(), rows.files_touched.len()].iter().sum::<usize>() as u64;
            made.files += 1;
            batch.add(&Origin { agent, machine, source: &format!("{}-{file}", session.id) }, &rows).unwrap();
            made.parsing += started.elapsed();
        }
        made.sessions += 1;
        for (number, request) in session.requests.iter_mut().enumerate() {
            request.id = made.proxied + number as u64 + 1;
        }
        made.proxied += session.requests.len() as u64;
        waiting.append(&mut session.requests);
        if batch.bytes() >= BATCH_BYTES || left == 0 {
            let started = Instant::now();
            batch.add_proxy(&waiting).unwrap();
            waiting.clear();
            store.write(std::mem::replace(&mut batch, store.batch().unwrap()), engine).unwrap();
            made.writing += started.elapsed();
            let started = Instant::now();
            store.merge(engine, MERGE_AT).unwrap();
            made.merging += started.elapsed();
        }
    }
    batch.discard();
    made
}

/// Runs a query three times the way `arbor query` gives one to the engine, and gives the middle time and the rows.
fn time(engine: &Program, store: &Store, sql: &str) -> (Duration, usize) {
    let script = format!("SET TimeZone = 'UTC';\nSET memory_limit = '2GB';\nSET threads = 4;\n{}{sql};", store.views());
    let mut times = Vec::new();
    let mut rows = 0;
    for _ in 0..3 {
        let started = Instant::now();
        let answer = engine.run(&script).unwrap_or_else(|error| panic!("{sql}: {error}"));
        times.push(started.elapsed());
        rows = serde_json::from_str::<Vec<Value>>(answer.trim()).map_or(0, |rows| rows.len());
    }
    times.sort();
    (times[1], rows)
}

fn number(engine: &Program, store: &Store, sql: &str) -> u64 {
    let answer = engine.run(&format!("SET TimeZone = 'UTC';\n{}{sql};", store.views())).unwrap();
    serde_json::from_str::<Vec<Value>>(answer.trim()).unwrap()[0]["n"].as_u64().unwrap()
}

#[test]
#[ignore = "needs the engine and takes minutes; run it in release"]
fn tables_at_volume() {
    let path = std::env::var_os("SESSION_TABLES_DUCKDB").filter(|path| !path.is_empty()).expect("SESSION_TABLES_DUCKDB names the engine");
    let engine = Program { path: PathBuf::from(path) };
    let turns = env_number("SESSION_TABLES_BENCH_TURNS", 100_000);
    let kept = std::env::var_os("SESSION_TABLES_BENCH_DIR").map(PathBuf::from);
    let root = kept.clone().unwrap_or_else(|| std::env::temp_dir().join(format!("session-tables-bench-{}", std::process::id())));
    std::fs::create_dir_all(&root).unwrap();
    let mut store = Store::open(&root).unwrap();

    if store.size().0 == 0 {
        let started = Instant::now();
        let made = fill(&mut store, &engine, turns);
        let megabytes = made.bytes as f64 / f64::from(1 << 20);
        println!("made {} sessions in {} files: {} lines, {megabytes:.0} MB, in {:.1}s", made.sessions, made.files, made.lines, started.elapsed().as_secs_f64());
        println!("  reading lines into rows  {:>7.1}s   {:>6.0} MB/s", made.parsing.as_secs_f64(), megabytes / made.parsing.as_secs_f64());
        println!("  writing fresh files      {:>7.1}s   {:>6.0} MB/s", made.writing.as_secs_f64(), megabytes / made.writing.as_secs_f64());
        println!("  merging into months      {:>7.1}s", made.merging.as_secs_f64());
        // Every row made is in a table, once, and a repeated line is out of sight.
        let placed: u64 = ["lines", "messages", "requests", "tool_calls", "tool_results", "tool_io", "commands", "hooks", "context_use", "files_touched"].iter().map(|table| store.parts(table).iter().map(|part| part.rows).sum::<u64>()).sum();
        assert_eq!(placed, made.rows);
        assert_eq!(number(&engine, &store, "SELECT count(*) AS n FROM lines_all"), made.lines);
        assert_eq!(number(&engine, &store, "SELECT count(*) AS n FROM lines"), made.lines - made.repeats);
        assert_eq!(number(&engine, &store, "SELECT count(*) AS n FROM proxy_requests"), made.proxied);
        assert!(made.repeats > 0);
        // Each system prompt and tool is kept once, however many sessions had it.
        assert_eq!(number(&engine, &store, "SELECT count(*) AS n FROM prompts"), 10);
    }

    let (rows, bytes) = store.size();
    println!("tables: {rows} rows in {:.0} MB", bytes as f64 / f64::from(1 << 20));
    for table in &crate::tables::TABLES {
        let parts = store.parts(table.name);
        let (rows, bytes) = parts.iter().fold((0, 0), |(rows, bytes), part| (rows + part.rows, bytes + part.bytes));
        println!("  {:<16} {rows:>11} rows {:>8.1} MB in {} files", table.name, bytes as f64 / f64::from(1 << 20), parts.len());
    }

    let own: [(&str, &str); 6] = [
        ("count of lines", "SELECT count(*) AS n FROM lines"),
        ("one day of tool calls", "SELECT tool, count(*) AS calls FROM tool_calls WHERE day = DATE '2026-10-15' GROUP BY tool"),
        ("one session's lines", "SELECT kind, count(*) AS n FROM lines WHERE session_id = (SELECT min(session_id) FROM requests WHERE day = DATE '2026-10-15') GROUP BY kind"),
        ("text search of tool output", "SELECT count(*) AS n FROM tool_io WHERE part = 'output' AND text LIKE '%sorting by month 4242%'"),
        ("every session", "SELECT agent, count(*) AS sessions, sum(requests) AS requests, round(sum(cost), 2) AS cost FROM sessions GROUP BY agent"),
        ("commands with how they ended", "SELECT program, count(*) AS runs, count(*) FILTER (WHERE exit_code <> 0) AS failed FROM commands GROUP BY program ORDER BY runs DESC LIMIT 10"),
    ];
    let saved = crate::cookbook::SAVED.iter().map(|saved| (saved.name, saved.sql));
    let mut slowest = Duration::ZERO;
    for (name, sql) in own.into_iter().chain(saved) {
        let (took, rows) = time(&engine, &store, sql);
        println!("  {name:<30} {:>8.0} ms   {rows:>4} rows", took.as_secs_f64() * 1000.0);
        slowest = slowest.max(took);
    }
    if kept.is_none() {
        std::fs::remove_dir_all(&root).unwrap();
    }
    if turns <= 100_000 {
        assert!(slowest < SLOWEST, "the slowest query took {slowest:?}");
    }
}

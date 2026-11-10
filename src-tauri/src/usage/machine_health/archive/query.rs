//! `arbor query`: one `SELECT` over the analytics tables, answered as rows.
//!
//! The answer can hold what was said in a session, so this is the command line's alone: the window never asks, and
//! nothing here is logged. A query is only ever run when DuckDB's own parser says it is exactly one `SELECT`, and it
//! runs in a process that can read the tables' folder and nothing else:
//!
//! 1. **Vetted.** The query goes to `json_serialize_sql` as a string, which parses it without running it and refuses
//!    anything but `SELECT`. What comes back is the parsed statement as JSON.
//! 2. **Run from what was vetted.** `json_execute_serialized_sql` runs that JSON, so the text someone typed is never
//!    read as SQL a second time, or as a line of the engine's shell.
//! 3. **Locked down first.** Before it runs, the process is confined to the tables' folder, extensions can't be
//!    fetched or loaded, and the configuration is locked. It starts with an empty environment.
//! 4. **Bounded.** Rows, the length of a cell, the size of the answer and the time it may take all have ceilings: an
//!    agent's context, or an MCP client's, is somewhere a runaway answer would stay.

use crate::cli::redact;
use serde::Serialize;
use serde_json::Value;
use session_tables::store::{Program, Store as Tables};
use session_tables::tables::{shown, Kind};
use std::io::{Read, Write};
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};
use ts_rs::TS;

pub(crate) const DEFAULT_ROWS: u32 = 200;
pub(crate) const MAX_ROWS: u32 = 10_000;
/// A text cell longer than this is cut, unless the whole of it was asked for.
const CELL_CHARS: usize = 2_000;
const FULL_CELL_CHARS: usize = 200_000;
/// The most an answer's rows may come to, as JSON. Past it, rows are left off the end.
const ANSWER_BYTES: usize = 4 << 20;
/// The most the engine may print before it's stopped: `MAX_ROWS` of very long cells.
const OUTPUT_BYTES: usize = 256 << 20;
const QUERY_BYTES: usize = 100_000;
const TIME: Duration = Duration::from_secs(30);

/// A column of an analytics table, or of a query's answer.
#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnalyticsColumn {
    name: String,
    kind: String,
}

/// What a query over the analytics tables found.
#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnalyticsAnswer {
    columns: Vec<AnalyticsColumn>,
    /// Each row's values, in the columns' order.
    #[ts(type = "Array<Array<unknown>>")]
    rows: Vec<Vec<Value>>,
    /// More rows matched than are here: the limit or the answer's size cut them off.
    truncated: bool,
    /// Text cells were cut short. Asking with `full` gives them whole.
    cut_cells: u64,
    elapsed_ms: u64,
}

/// An analytics table and its columns.
#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnalyticsTable {
    name: &'static str,
    columns: Vec<AnalyticsColumn>,
}

/// Everything a query can name, with its columns: each table as it's read, and the views worked out from them.
pub(crate) fn tables() -> Vec<AnalyticsTable> {
    let kind = |kind: Kind| match kind {
        Kind::Text => "text",
        Kind::Count | Kind::Number => "number",
        Kind::Flag => "true or false",
        Kind::Texts => "list of text",
        Kind::Time => "time",
        Kind::Day => "day",
    };
    shown().into_iter().map(|table| AnalyticsTable { name: table.name, columns: table.columns.into_iter().map(|(name, column)| AnalyticsColumn { name: name.to_string(), kind: kind(column).to_string() }).collect() }).collect()
}

/// A string as a SQL literal.
fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// What the engine said went wrong, without the lines that point into the SQL this file wrote around the query.
fn engine_error(stderr: &str) -> String {
    let message = stderr.split("\nLINE ").next().unwrap_or(stderr).trim();
    let message = if message.is_empty() { "The query engine stopped without saying why" } else { message };
    redact::masked(message)
}

enum Stopped {
    Failed(String),
    TooLong,
    TooMuch,
}

/// Runs a script through the engine with an empty environment, and gives back what it printed. It's stopped when it
/// runs past `time` or prints more than `OUTPUT_BYTES`.
fn run(program: &Program, script: String, time: Duration) -> Result<String, Stopped> {
    crate::keep_open_files_from_helpers();
    let failed = |error: std::io::Error| Stopped::Failed(format!("Couldn't run the query engine: {error}"));
    let mut child = program.command().env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(failed)?;
    let (mut input, output, errors) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let writer = std::thread::spawn(move || {
        if let Some(input) = input.as_mut() {
            let _ = input.write_all(script.as_bytes());
        }
    });
    // Each reads one byte past its ceiling, so "more than the ceiling" can be told from "exactly it".
    let read = |stream: Option<std::process::ChildStdout>, most: usize| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(stream) = stream {
                let _ = stream.take(most as u64 + 1).read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let printed = read(output, OUTPUT_BYTES);
    let said = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(errors) = errors {
            let _ = errors.take(64 << 10).read_to_end(&mut bytes);
        }
        bytes
    });
    let deadline = Instant::now() + time;
    let status = loop {
        match child.try_wait().map_err(failed)? {
            Some(status) => break Some(status),
            // Its output is read as it goes, so a full pipe never holds it past the deadline unseen.
            None if Instant::now() >= deadline || printed.is_finished() => break None,
            None => std::thread::sleep(Duration::from_millis(15)),
        }
    };
    let status = match status {
        Some(status) => Some(status),
        None => {
            // Either it ran out of time, or its output closed: at its ceiling, or because it's about to exit.
            let late = Instant::now() >= deadline;
            let exited = if late { None } else { wait_briefly(&mut child) };
            if exited.is_none() {
                let _ = child.kill();
                let _ = child.wait();
            }
            if late {
                let _ = writer.join();
                return Err(Stopped::TooLong);
            }
            exited
        }
    };
    let _ = writer.join();
    let printed = printed.join().unwrap_or_default();
    let said = said.join().unwrap_or_default();
    if printed.len() > OUTPUT_BYTES {
        return Err(Stopped::TooMuch);
    }
    match status {
        Some(status) if status.success() => String::from_utf8(printed).map_err(|_| Stopped::Failed("The query engine printed something that isn't text".into())),
        _ => Err(Stopped::Failed(engine_error(&String::from_utf8_lossy(&said)))),
    }
}

/// Waits a moment for a process whose output has closed to exit by itself.
fn wait_briefly(child: &mut std::process::Child) -> Option<std::process::ExitStatus> {
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(15)),
            _ => return None,
        }
    }
}

fn stopped(stopped: Stopped) -> String {
    match stopped {
        Stopped::Failed(error) => error,
        Stopped::TooLong => format!("The query ran longer than {} seconds, so it was stopped. Narrow it by day, or count instead of listing", TIME.as_secs()),
        Stopped::TooMuch => "The query's answer was too large to read, so it was stopped. Select fewer or shorter columns".into(),
    }
}

/// The parsed statement, as the engine's own JSON, when `sql` is exactly one `SELECT`.
fn vet(program: &Program, sql: &str) -> Result<String, String> {
    if sql.len() > QUERY_BYTES || sql.contains('\0') {
        return Err("That query is too long to run".into());
    }
    let printed = run(program, format!("SELECT CAST(json_serialize_sql({}) AS VARCHAR) AS statement;\n", literal(sql)), TIME).map_err(stopped)?;
    let unreadable = || "The query engine's answer couldn't be read".to_string();
    let rows: Vec<Value> = serde_json::from_str(printed.trim()).map_err(|_| unreadable())?;
    let serialized = rows.first().and_then(|row| row.get("statement")).and_then(Value::as_str).ok_or_else(unreadable)?;
    let parsed: Value = serde_json::from_str(serialized).map_err(|_| unreadable())?;
    if parsed.get("error").and_then(Value::as_bool) != Some(false) {
        let message = parsed.get("error_message").and_then(Value::as_str).unwrap_or("it couldn't be read as SQL");
        // The engine's words for "not a SELECT" name its own function.
        return Err(if message.contains("Only SELECT") { "Only a SELECT can be run: the tables are read, never changed".into() } else { format!("That query couldn't be read: {}", redact::masked(message)) });
    }
    match parsed.get("statements").and_then(Value::as_array).map(Vec::len) {
        Some(1) => Ok(serialized.to_string()),
        Some(0) => Err("There's no query to run".into()),
        _ => Err("One query at a time: that was more than one statement".into()),
    }
}

/// What confines a query's process to the tables: set before the query, and locked.
fn lockdown(root: &Path) -> String {
    let dir = |name: &str| literal(&format!("{}/", root.join(name).to_string_lossy()));
    format!(
        "SET temp_directory = {scratch};\nSET allowed_directories = [{tables}, {scratch}];\nSET enable_external_access = false;\nSET autoinstall_known_extensions = false;\nSET autoload_known_extensions = false;\nSET allow_community_extensions = false;\nSET memory_limit = '2GB';\nSET threads = 4;\nSET max_temp_directory_size = '4GB';\nSET lock_configuration = true;\n",
        scratch = dir("scratch"),
        tables = dir("v1"),
    )
}

/// Runs one `SELECT` over the tables in `root` and gives back at most `limit` rows.
pub(crate) fn ask(root: &Path, program: &Program, sql: &str, limit: Option<u32>, full: bool) -> Result<AnalyticsAnswer, String> {
    let started = Instant::now();
    let limit = limit.unwrap_or(DEFAULT_ROWS).clamp(1, MAX_ROWS) as usize;
    if !root.join("manifest.json").is_file() {
        return Err("There are no analytics tables yet. They fill in at the archive's next check once analytics is on".into());
    }
    let statement = literal(&vet(program, sql)?);
    let tables = Tables::open(root)?;
    let scratch = root.join("scratch");
    {
        use std::os::unix::fs::DirBuilderExt;
        match std::fs::DirBuilder::new().mode(0o700).create(&scratch) {
            Err(error) if error.kind() != std::io::ErrorKind::AlreadyExists => return Err(format!("Couldn't make {}: {error}", scratch.display())),
            _ if !std::fs::symlink_metadata(&scratch).is_ok_and(|meta| meta.is_dir()) => return Err(format!("{} isn't a folder of the tables' own", scratch.display())),
            _ => {}
        }
    }
    // One row more than asked for says whether there were more.
    let script = format!(
        "SET TimeZone = 'UTC';\n{}{}DESCRIBE SELECT * FROM json_execute_serialized_sql({statement});\nSELECT * FROM json_execute_serialized_sql({statement}) LIMIT {};\n",
        tables.views(),
        lockdown(root),
        limit + 1
    );
    let printed = run(program, script, TIME.saturating_sub(started.elapsed()).max(Duration::from_secs(1))).map_err(stopped)?;
    let mut answers = serde_json::Deserializer::from_str(&printed).into_iter::<Vec<Value>>();
    let unreadable = || "The query engine's answer couldn't be read".to_string();
    let described = answers.next().and_then(Result::ok).ok_or_else(unreadable)?;
    // A query with no rows prints nothing after its columns.
    let found = match answers.next() {
        Some(rows) => rows.map_err(|_| unreadable())?,
        None => Vec::new(),
    };
    let text_of = |row: &Value, field: &str| row.get(field).and_then(Value::as_str).unwrap_or_default().to_string();
    let columns: Vec<AnalyticsColumn> = described.iter().map(|row| AnalyticsColumn { name: text_of(row, "column_name"), kind: text_of(row, "column_type") }).collect();
    let mut answer = AnalyticsAnswer { columns, rows: Vec::new(), truncated: found.len() > limit, cut_cells: 0, elapsed_ms: 0 };
    let cell_chars = if full { FULL_CELL_CHARS } else { CELL_CHARS };
    let mut bytes = 0;
    for mut row in found.into_iter().take(limit) {
        let mut values: Vec<Value> = answer.columns.iter().map(|column| row.get_mut(&column.name).map(Value::take).unwrap_or(Value::Null)).collect();
        values.iter_mut().for_each(|value| answer.cut_cells += shorten(value, cell_chars));
        bytes += serde_json::to_string(&values).map_or(0, |text| text.len());
        if bytes > ANSWER_BYTES && !answer.rows.is_empty() {
            answer.truncated = true;
            break;
        }
        answer.rows.push(values);
    }
    answer.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(answer)
}

/// Hides what looks like a key inside a cell's text and cuts text past `most` characters, wherever in the cell it
/// sits. Returns how many texts were cut.
fn shorten(value: &mut Value, most: usize) -> u64 {
    match value {
        Value::String(text) => {
            // Hidden first, so a cut never leaves the start of a key showing.
            *text = redact::masked(text);
            let Some((end, _)) = text.char_indices().nth(most) else { return 0 };
            let left = text[end..].chars().count();
            text.truncate(end);
            text.push_str(&format!("… [{left} more characters]"));
            1
        }
        Value::Array(items) => items.iter_mut().map(|item| shorten(item, most)).sum(),
        Value::Object(fields) => fields.values_mut().map(|field| shorten(field, most)).sum(),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::super::analytics::{extract_pass, ExtractOptions, FOLDER};
    use super::super::ingest::tests::{Fixture, SECRET_TEXT, SID};
    use super::super::tokens::tests::claude_line;
    use super::*;
    use serde_json::json;
    use session_tables::Detail;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn every_table_says_its_columns() {
        let tables = tables();
        assert_eq!(tables.len(), shown().len());
        let requests = tables.iter().find(|table| table.name == "requests").unwrap();
        assert!(requests.columns.contains(&AnalyticsColumn { name: "day".into(), kind: "day".into() }));
        assert!(requests.columns.contains(&AnalyticsColumn { name: "output".into(), kind: "number".into() }));
    }

    #[test]
    fn a_long_cell_is_cut_and_a_key_inside_text_is_hidden() {
        let mut row = json!(["short", "x".repeat(30), ["nested ".repeat(10), 7], "export KEY=sk-proj-abcdefghijklmnopqrstu and more"]);
        assert_eq!(shorten(&mut row, 20), 3);
        assert_eq!(row[0], "short");
        assert_eq!(row[1], format!("{}… [10 more characters]", "x".repeat(20)));
        assert_eq!(row[2][1], 7);
        assert_eq!(row[3], "export KEY=[hidden] … [8 more characters]");
        let mut whole = json!("export KEY=sk-proj-abcdefghijklmnopqrstu and more");
        assert_eq!(shorten(&mut whole, 200), 0);
        assert_eq!(whole, "export KEY=[hidden] and more");
    }

    #[test]
    fn an_engine_error_loses_the_lines_that_point_into_arbors_own_sql() {
        assert_eq!(engine_error("Binder Error: Referenced column \"nope\" not found\n\nLINE 1: SELECT * FROM json_execute_serialized_sql('{…}')\n   ^"), "Binder Error: Referenced column \"nope\" not found");
        assert_eq!(engine_error(""), "The query engine stopped without saying why");
    }

    /// With DuckDB itself, when `SESSION_TABLES_DUCKDB` names its program (`scripts/check-query-engine.sh`).
    #[test]
    fn with_the_real_engine_one_select_is_answered_and_nothing_else_runs_or_reaches_outside_the_tables() {
        let Some(path) = std::env::var_os("SESSION_TABLES_DUCKDB").filter(|path| !path.is_empty()) else { return };
        let program = Program { path: PathBuf::from(path) };
        let fixture = Fixture::new("analytics-query");
        let root = fixture.places.store.root().join(FOLDER);
        assert!(ask(&root, &program, "SELECT 1", None, false).unwrap_err().contains("no analytics tables yet"));

        let mut session = format!("{{\"type\":\"user\",\"sessionId\":\"{SID}\",\"timestamp\":\"2026-09-20T02:00:00.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"{SECRET_TEXT} token sk-proj-abcdefghijklmnopqrstu\"}}}}\n");
        for n in 0..5 {
            session += &claude_line(&format!("msg_{n}"), "claude-opus-5-5", &format!("2026-09-20T02:{n:02}:30.000Z"), (10, 100, 1_000, n + 1), &"long ".repeat(600));
        }
        fixture.write(&format!(".claude/projects/-Users-me-app/{SID}.jsonl"), &session);
        assert!(fixture.pass().complete);
        fixture.db.execute("UPDATE versions SET state = 'settled'", []).unwrap();
        let options = ExtractOptions { detail: Detail::Everything, bytes_per_second: 1 << 40, max_bytes: 1 << 40, max_time: Duration::from_secs(600), merge_at: 1, now: 1_800_000_000 };
        extract_pass(&fixture.db, &fixture.places, &root, &program, &options, &|| false).unwrap();

        // Numbers come back as rows in the columns' order, with their types.
        let answer = ask(&root, &program, "SELECT model, count(*) AS calls, CAST(sum(output) AS BIGINT) AS output FROM requests GROUP BY ALL", None, false).unwrap();
        assert_eq!(answer.columns.iter().map(|column| (column.name.as_str(), column.kind.as_str())).collect::<Vec<_>>(), [("model", "VARCHAR"), ("calls", "BIGINT"), ("output", "BIGINT")]);
        assert_eq!(answer.rows, [vec![json!("claude-opus-5-5"), json!(5), json!(15)]]);
        assert!(!answer.truncated && answer.cut_cells == 0);

        // Text is only in an answer that selects it; long text is cut unless asked for whole, and a key in it is hidden.
        let texts = ask(&root, &program, "SELECT kind, text FROM messages ORDER BY line, block", Some(3), false).unwrap();
        assert_eq!((texts.rows.len(), texts.truncated, texts.cut_cells), (3, true, 2));
        let prompt = texts.rows[0][1].as_str().unwrap();
        assert!(prompt.contains(SECRET_TEXT) && prompt.ends_with("token [hidden]"), "{prompt}");
        assert!(texts.rows[1][1].as_str().unwrap().ends_with("more characters]"));
        let whole = ask(&root, &program, "SELECT text FROM messages WHERE role = 'assistant' LIMIT 1", None, true).unwrap();
        assert_eq!((whole.rows[0][0].as_str().unwrap().len(), whole.cut_cells), (3_000, 0));
        // No rows is an answer too, with its columns.
        let none = ask(&root, &program, "SELECT tool FROM tool_calls WHERE tool = 'nope'", None, false).unwrap();
        assert_eq!((none.columns.len(), none.rows.len(), none.truncated), (1, 0, false));
        // A table with nothing in it yet can still be named.
        assert_eq!(ask(&root, &program, "SELECT count(*) AS n FROM hooks", None, false).unwrap().rows, [vec![json!(0)]]);

        // Only one SELECT is ever run.
        let outside = fixture.base.join("outside.csv");
        let refused = |sql: &str| ask(&root, &program, sql, None, false).unwrap_err();
        assert_eq!(refused(&format!("COPY (SELECT 1) TO '{}'", outside.display())), "Only a SELECT can be run: the tables are read, never changed");
        assert_eq!(refused("DROP VIEW messages"), "Only a SELECT can be run: the tables are read, never changed");
        assert_eq!(refused("SET enable_external_access = true"), "Only a SELECT can be run: the tables are read, never changed");
        assert_eq!(refused("INSTALL httpfs"), "Only a SELECT can be run: the tables are read, never changed");
        assert_eq!(refused(&format!("SELECT 1; COPY (SELECT 1) TO '{}'", outside.display())), "Only a SELECT can be run: the tables are read, never changed");
        assert_eq!(refused("SELECT 1; SELECT 2"), "One query at a time: that was more than one statement");
        assert_eq!(refused(""), "There's no query to run");
        assert_eq!(refused("SELEC 1"), "That query couldn't be read: syntax error at or near \"1\"");
        // A line that would be a command to the engine's shell is only ever text in a query.
        assert!(refused("SELECT 1\n.shell touch /tmp/arbor-query-test-should-not-exist").starts_with("That query couldn't be read: syntax error"));
        assert_eq!(ask(&root, &program, "SELECT '\n.shell touch /tmp/arbor-query-test-should-not-exist\n' AS a", None, false).unwrap().rows.len(), 1);
        assert!(!Path::new("/tmp/arbor-query-test-should-not-exist").exists());

        // A SELECT reaches the tables' folder and nothing else: no other file, no environment, no settings.
        fs::write(&outside, "a\n1\n").unwrap();
        for sql in [
            format!("SELECT * FROM read_csv('{}')", outside.display()),
            format!("SELECT * FROM read_text('{}')", outside.display()),
            format!("SELECT * FROM read_text('{}/v1/../../chunks/*')", root.display()),
            format!("SELECT * FROM glob('{}/*')", fixture.base.display()),
            format!("SELECT * FROM read_parquet('{}/state.db')", root.display()),
        ] {
            assert!(refused(&sql).starts_with("Permission Error"), "{sql}: {}", refused(&sql));
        }
        assert!(refused("SELECT getenv('HOME')").contains("getenv is disabled"));
        // What an error says of a query is the engine's words for it, not Arbor's SQL around it.
        let unknown = refused("SELECT nope FROM requests");
        assert!(unknown.starts_with("Binder Error") && !unknown.contains("json_execute_serialized_sql"), "{unknown}");
        // The tables are as they were.
        assert_eq!(ask(&root, &program, "SELECT count(*) AS n FROM requests", None, false).unwrap().rows, [vec![json!(5)]]);
        assert!(!outside.with_extension("parquet").exists());
        let _ = fs::remove_dir_all(&fixture.base);
    }
}

//! Coding agents' session transcripts as rows.
//!
//! A transcript is a file of JSON lines. [`Parser::line`] takes one line and adds what it holds to [`Rows`]: a list
//! per table, a struct per row. The parser opens no files, so it serves an archive, a folder on disk or a test alike.
//! [`tables`] lists each table's columns, [`store`] keeps rows as Parquet files in a folder, and [`cookbook`] has
//! questions worth asking of them.
//!
//! A session can be kept in more than one file, and an agent that carries a session on writes what came before
//! again. [`Parser::line_once`] gives each line a short key and asks its caller whether a line with that key was
//! read before; the rows of one that was are marked `repeat`, and a table is read without them.
//!
//! Lines are read in order and never again. Whatever a later line needs from an earlier one is in [`State`], which
//! can be saved between runs to carry on from where a growing file was last read.
//!
//! Every line becomes one `lines` row, and every field of it either fills a column or stays in that row's `rest`,
//! so a field this crate doesn't know is kept. Four things are left out for their size: thinking signatures, and,
//! with their size and hash in their place, encrypted thinking, images, and a file's contents from before an edit.

#[cfg(test)]
mod bench;
mod claude;
mod codex;
pub mod cookbook;
mod json;
pub mod local;
mod pi;
mod rows;
mod shell;
pub mod store;
pub mod tables;

pub use rows::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What a row is. Whoever keeps tables notes it beside them, and makes them again when it changes: raise it with
/// any change to the rows a line gives.
pub const RULE: &str = "tables-v6";

/// Whose transcript a file is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agent {
    Claude,
    Codex,
    Pi,
    OpenClaw,
}

impl Agent {
    /// The agent as rows name it.
    pub fn name(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
            Agent::Pi => "pi",
            Agent::OpenClaw => "openclaw",
        }
    }

    /// The agent rows name this way.
    pub fn named(name: &str) -> Option<Self> {
        [Agent::Claude, Agent::Codex, Agent::Pi, Agent::OpenClaw].into_iter().find(|agent| agent.name() == name)
    }
}

/// How much of a session's text the rows hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detail {
    /// Names, ids, counts, sizes and times. No prompt, reply, thinking, command, tool input or output, and `rest`
    /// keeps only numbers and yes-or-no values.
    Numbers,
    /// All of it.
    Everything,
}

/// What tells a line from every other, short enough to keep one for each line ever read. Two files that hold the
/// same line give the same key.
pub type LineKey = [u8; 12];

/// What whoever reads the files knows of a line's key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seen {
    /// No line read before had it.
    New,
    /// An earlier line of this file had it.
    Here,
    /// A line of another file had it first.
    Elsewhere,
}

/// What reading a file so far leaves for its next line.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    session_id: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    cwd: Option<String>,
    turn_id: Option<String>,
    service_tier: Option<String>,
    /// What Codex says started the turn being read, and whether another turn did.
    trigger: Option<String>,
    child: bool,
    /// What kind of thread a Codex rollout is (`user`, `subagent`, `automation`) and how it was run (`exec`, `cli`).
    thread: Option<String>,
    run: Option<String>,
    /// A Codex file has `token_usage_record` lines, so its `token_count` events repeat them.
    records: bool,
    /// The thread's running total at the last `token_count` event counted, to tell a repeated event from a new call.
    last_total: Option<String>,
    /// A Claude reply is written a block a line, each with the reply's usage so far. Its request is held until the
    /// next reply starts, and goes out once with the largest numbers.
    pending: Option<Request>,
    /// The time of the last line that had one.
    last_ts: Option<String>,
}

pub struct Parser {
    agent: Agent,
    detail: Detail,
    state: State,
    /// Whether the line being read was read before, from another file.
    repeat: bool,
}

impl Parser {
    pub fn new(agent: Agent, detail: Detail, state: State) -> Self {
        Self { agent, detail, state, repeat: false }
    }

    /// Adds one line's rows. `number` is the line's place in its file, from 0. A line that isn't a JSON object is
    /// still a `lines` row, of kind `unreadable`.
    pub fn line(&mut self, number: u64, line: &[u8], rows: &mut Rows) {
        self.line_once(number, line, &mut |_| Seen::New, rows);
    }

    /// The same, for whoever reads more than one file: `seen` is asked whether a line with this key was read
    /// before, and the rows of one that was are marked as repeats.
    ///
    /// A line is known by what it is, where it says: a Claude line by its own id, a Codex item by its id or its
    /// call's, a Codex count of tokens by the thread's running total, a Pi reply by its response's id. Codex writes
    /// a session's items again, with new times, when it carries the session on, and those ids are what stays the
    /// same. Any other line is known by its bytes, which hold its time to the millisecond.
    ///
    /// The one line that can be in a file twice over and mean it is a Claude line with no id and no time, such as a
    /// change of mode, so that one is a repeat only when another file had it first.
    pub fn line_once(&mut self, number: u64, line: &[u8], seen: &mut dyn FnMut(LineKey) -> Seen, rows: &mut Rows) {
        let bytes = line.len() as u64;
        let agent = self.agent.name().as_bytes();
        let Ok(Value::Object(fields)) = serde_json::from_slice::<Value>(line) else {
            if !line.iter().all(u8::is_ascii_whitespace) {
                self.repeat = seen(json::key(&[agent, line])) != Seen::New;
                let at = self.at(number, None, None);
                rows.lines.push(Line { at, kind: "unreadable".into(), bytes, ..Line::default() });
            }
            return;
        };
        let text = |key: &str| fields.get(key).and_then(Value::as_str).unwrap_or_default().as_bytes();
        let own = match self.agent {
            Agent::Claude => Some(text("uuid")).filter(|id| !id.is_empty()).map(|id| json::key(&[agent, b"id", id])),
            Agent::Codex => codex::key(&fields),
            Agent::Pi | Agent::OpenClaw => pi::key(agent, &fields),
        };
        self.repeat = match own {
            Some(key) => seen(key) != Seen::New,
            None if self.agent == Agent::Claude => seen(json::key(&[agent, text("sessionId"), line])) == Seen::Elsewhere,
            None => seen(json::key(&[agent, line])) != Seen::New,
        };
        match self.agent {
            Agent::Claude => claude::line(self, number, bytes, fields, rows),
            Agent::Codex => codex::line(self, number, bytes, fields, rows),
            Agent::Pi | Agent::OpenClaw => pi::line(self, number, bytes, fields, rows),
        }
    }

    /// Adds what was being held for a next line. Call it when a file has no more lines to come.
    pub fn finish(&mut self, rows: &mut Rows) {
        rows.requests.extend(self.state.pending.take());
    }

    pub fn state(&self) -> &State {
        &self.state
    }

    /// Where the line being read puts its rows. A line with no time is near the last one that had a time.
    fn at(&mut self, line: u64, ts: Option<String>, session_id: Option<String>) -> At {
        let near = match &ts {
            Some(_) => {
                self.state.last_ts.clone_from(&ts);
                None
            }
            None => self.state.last_ts.clone(),
        };
        At { line, ts, near, session_id, repeat: self.repeat }
    }

    /// Text a row may hold, at this parser's detail.
    fn text(&self, text: String) -> Option<String> {
        (self.detail == Detail::Everything).then_some(text)
    }

    /// What's left of a line as `rest`.
    fn rest(&self, fields: serde_json::Map<String, Value>) -> Option<String> {
        json::rest(self.detail, Value::Object(fields))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for conversation text, to follow where text goes.
    pub(crate) const SECRET: &str = "SECRET-91c4-only-with-everything";

    pub(crate) fn parse(agent: Agent, detail: Detail, lines: &[String]) -> Rows {
        let mut parser = Parser::new(agent, detail, State::default());
        let mut rows = Rows::default();
        for (number, line) in lines.iter().enumerate() {
            parser.line(number as u64, line.as_bytes(), &mut rows);
        }
        parser.finish(&mut rows);
        rows
    }

    /// Reads files one after another, the way whoever keeps every line's key does.
    pub(crate) fn parse_files(agent: Agent, files: &[Vec<String>]) -> Vec<Rows> {
        let mut first: std::collections::HashMap<LineKey, usize> = std::collections::HashMap::new();
        let mut read = Vec::new();
        for (file, lines) in files.iter().enumerate() {
            let mut parser = Parser::new(agent, Detail::Everything, State::default());
            let mut rows = Rows::default();
            for (number, line) in lines.iter().enumerate() {
                let mut seen = |key| match first.get(&key) {
                    None => {
                        first.insert(key, file);
                        Seen::New
                    }
                    Some(had) if *had == file => Seen::Here,
                    Some(_) => Seen::Elsewhere,
                };
                parser.line_once(number as u64, line.as_bytes(), &mut seen, &mut rows);
            }
            parser.finish(&mut rows);
            read.push(rows);
        }
        read
    }

    #[test]
    fn a_line_that_is_not_json_is_kept_as_unreadable_and_a_blank_one_is_nothing() {
        let rows = parse(Agent::Claude, Detail::Everything, &["{\"type\":".to_string(), "  ".to_string(), "[1]".to_string()]);
        assert_eq!(rows.lines.iter().map(|line| (line.at.line, line.kind.as_str(), line.bytes)).collect::<Vec<_>>(), [(0, "unreadable", 8), (2, "unreadable", 3)]);
    }

    #[test]
    fn reading_can_stop_between_any_two_lines_and_carry_on_from_its_state() {
        for (agent, lines) in [(Agent::Claude, claude::tests::session()), (Agent::Codex, codex::tests::session()), (Agent::Pi, pi::tests::session())] {
            let whole = parse(agent, Detail::Everything, &lines);
            for cut in 0..=lines.len() {
                let mut rows = Rows::default();
                let mut first = Parser::new(agent, Detail::Everything, State::default());
                for (number, line) in lines.iter().enumerate().take(cut) {
                    first.line(number as u64, line.as_bytes(), &mut rows);
                }
                // The state goes through JSON, as it does when it's saved between runs.
                let saved: State = serde_json::from_str(&serde_json::to_string(first.state()).unwrap()).unwrap();
                let mut second = Parser::new(agent, Detail::Everything, saved);
                for (number, line) in lines.iter().enumerate().skip(cut) {
                    second.line(number as u64, line.as_bytes(), &mut rows);
                }
                second.finish(&mut rows);
                assert_eq!(rows, whole, "cut at line {cut}");
            }
        }
    }

    #[test]
    fn a_line_with_no_time_is_near_the_last_line_that_had_one() {
        let untimed = r#"{"type":"mode","mode":"default","sessionId":"s-1"}"#.to_string();
        let mut lines = claude::tests::session();
        lines.insert(0, untimed.clone());
        lines.insert(3, untimed);
        let rows = parse(Agent::Claude, Detail::Everything, &lines);
        let near: Vec<_> = rows.lines.iter().take(5).map(|line| (line.at.ts.is_some(), line.at.near.as_deref())).collect();
        // Nothing came before the first, and a line with a time needs no other.
        assert_eq!(near, [(false, None), (true, None), (true, None), (false, Some("2026-10-01T10:00:02.000Z")), (true, None)]);
    }

    #[test]
    fn a_line_read_before_from_another_file_marks_every_row_it_gives_as_a_repeat() {
        for (agent, lines) in [(Agent::Claude, claude::tests::session()), (Agent::Codex, codex::tests::session()), (Agent::Pi, pi::tests::session())] {
            // Who reads the files says which file had a line first.
            let mut first: std::collections::HashMap<LineKey, u32> = std::collections::HashMap::new();
            let mut read = |file: u32, lines: &[String]| {
                let mut parser = Parser::new(agent, Detail::Everything, State::default());
                let mut rows = Rows::default();
                for (number, line) in lines.iter().enumerate() {
                    let mut seen = |key| match first.get(&key) {
                        None => {
                            first.insert(key, file);
                            Seen::New
                        }
                        Some(had) if *had == file => Seen::Here,
                        Some(_) => Seen::Elsewhere,
                    };
                    parser.line_once(number as u64, line.as_bytes(), &mut seen, &mut rows);
                }
                parser.finish(&mut rows);
                serde_json::to_value(&rows).unwrap()
            };
            let repeats = |rows: &Value| -> (usize, usize) {
                let placed = rows.as_object().unwrap().iter().filter(|(table, _)| !matches!(table.as_str(), "prompts" | "tool_defs"));
                placed.fold((0, 0), |(count, marked), (_, rows)| (count + rows.as_array().unwrap().len(), marked + rows.as_array().unwrap().iter().filter(|row| row["repeat"] == true).count()))
            };
            // A file that holds its lines twice over, as one an agent wrote its session into again: the second of
            // each is a repeat. All but the Claude line with no id of its own, a pull request's link, which a file can hold twice
            // and mean: the line's row and the link's.
            let (rows, marked) = repeats(&read(1, &[lines.clone(), lines.clone()].concat()));
            assert_eq!(rows - marked * 2, if agent == Agent::Claude { 4 } else { 0 }, "{agent:?}");
            // A second file with the first's lines and one more: every row but that line's is a repeat.
            let mut longer = lines.clone();
            longer.push(lines[1].replace("\"type\"", "\"extra\":1,\"type\""));
            let copy = read(2, &longer);
            let (rows, marked) = repeats(&copy);
            assert!(marked > 10 && (marked < rows) == (agent != Agent::Claude), "{agent:?}: {marked} of {rows}");
            let new: Vec<u64> = copy["lines"].as_array().unwrap().iter().filter(|line| line["repeat"] == false).map(|line| line["line"].as_u64().unwrap()).collect();
            // A Claude line is known by its id, so the changed copy of line 1 is still line 1.
            assert_eq!(new, if agent == Agent::Claude { vec![] } else { vec![lines.len() as u64] }, "{agent:?}");
        }
    }

    #[test]
    fn numbers_detail_holds_no_text_and_everything_holds_it() {
        for (agent, lines) in [(Agent::Claude, claude::tests::session()), (Agent::Codex, codex::tests::session()), (Agent::Pi, pi::tests::session())] {
            assert!(lines.iter().filter(|line| line.contains(SECRET)).count() > 5);
            let numbers = serde_json::to_string(&parse(agent, Detail::Numbers, &lines)).unwrap();
            assert!(!numbers.contains("SECRET"), "{agent:?}: {numbers}");
            let everything = serde_json::to_string(&parse(agent, Detail::Everything, &lines)).unwrap();
            assert!(everything.contains(SECRET));
            // The two differ in text only: the same rows, in the same tables.
            let (numbers, everything) = (parse(agent, Detail::Numbers, &lines), parse(agent, Detail::Everything, &lines));
            assert_eq!(numbers.messages.len(), everything.messages.len());
            assert_eq!(numbers.tool_calls, everything.tool_calls);
            assert_eq!(numbers.tool_results, everything.tool_results);
            assert_eq!(numbers.requests, everything.requests);
            assert!(numbers.tool_io.is_empty() && !everything.tool_io.is_empty());
        }
    }
}

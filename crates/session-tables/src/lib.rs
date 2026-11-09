//! Coding agents' session transcripts as rows.
//!
//! A transcript is a file of JSON lines. [`Parser::line`] takes one line and adds what it holds to [`Rows`]: a list
//! per table, a struct per row. The parser opens no files, so it serves an archive, a folder on disk or a test alike.
//! [`tables`] lists each table's columns, and [`store`] keeps rows as Parquet files in a folder.
//!
//! Lines are read in order and never again. Whatever a later line needs from an earlier one is in [`State`], which
//! can be saved between runs to carry on from where a growing file was last read.
//!
//! Every line becomes one `lines` row, and every field of it either fills a column or stays in that row's `rest`,
//! so a field this crate doesn't know is kept. Four things are left out for their size: thinking signatures, and,
//! with their size and hash in their place, encrypted thinking, images, and a file's contents from before an edit.

mod claude;
mod codex;
mod json;
mod rows;
mod shell;
pub mod store;
pub mod tables;

pub use rows::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Whose transcript a file is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agent {
    Claude,
    Codex,
}

impl Agent {
    /// The agent as rows name it.
    pub fn name(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
        }
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

/// What reading a file so far leaves for its next line.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct State {
    session_id: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    cwd: Option<String>,
    turn_id: Option<String>,
    /// A Codex file has `token_usage_record` lines, so its `token_count` events repeat them.
    records: bool,
    /// The thread's running total at the last `token_count` event counted, to tell a repeated event from a new call.
    last_total: Option<String>,
    /// A Claude reply is written a block a line, each with the reply's usage so far. Its request is held until the
    /// next reply starts, and goes out once with the largest numbers.
    pending: Option<Request>,
}

pub struct Parser {
    agent: Agent,
    detail: Detail,
    state: State,
}

impl Parser {
    pub fn new(agent: Agent, detail: Detail, state: State) -> Self {
        Self { agent, detail, state }
    }

    /// Adds one line's rows. `number` is the line's place in its file, from 0. A line that isn't a JSON object is
    /// still a `lines` row, of kind `unreadable`.
    pub fn line(&mut self, number: u64, line: &[u8], rows: &mut Rows) {
        let bytes = line.len() as u64;
        let Ok(Value::Object(fields)) = serde_json::from_slice::<Value>(line) else {
            if !line.iter().all(u8::is_ascii_whitespace) {
                rows.lines.push(Line { at: At { line: number, ..At::default() }, kind: "unreadable".into(), bytes, ..Line::default() });
            }
            return;
        };
        match self.agent {
            Agent::Claude => claude::line(self, number, bytes, fields, rows),
            Agent::Codex => codex::line(self, number, bytes, fields, rows),
        }
    }

    /// Adds what was being held for a next line. Call it when a file has no more lines to come.
    pub fn finish(&mut self, rows: &mut Rows) {
        rows.requests.extend(self.state.pending.take());
    }

    pub fn state(&self) -> &State {
        &self.state
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

    #[test]
    fn a_line_that_is_not_json_is_kept_as_unreadable_and_a_blank_one_is_nothing() {
        let rows = parse(Agent::Claude, Detail::Everything, &["{\"type\":".to_string(), "  ".to_string(), "[1]".to_string()]);
        assert_eq!(rows.lines.iter().map(|line| (line.at.line, line.kind.as_str(), line.bytes)).collect::<Vec<_>>(), [(0, "unreadable", 8), (2, "unreadable", 3)]);
    }

    #[test]
    fn reading_can_stop_between_any_two_lines_and_carry_on_from_its_state() {
        for (agent, lines) in [(Agent::Claude, claude::tests::session()), (Agent::Codex, codex::tests::session())] {
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
    fn numbers_detail_holds_no_text_and_everything_holds_it() {
        for (agent, lines) in [(Agent::Claude, claude::tests::session()), (Agent::Codex, codex::tests::session())] {
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

//! Token counts for every call in the transcripts the archive keeps, for an
//! all-time total. archive.db gets a key for each call, its day, machine,
//! model and token counts; nothing a session says.
//!
//! A call is counted once, however many copies of it the archive has (a
//! session in two homes, a fork, a backup, a rollout Codex rewrote):
//! - Claude, by message id. A message is written again as it streams with
//!   only its output growing, so its largest output counts.
//! - Codex, by response id from token_usage_record lines, which come before
//!   their token_count event. Files from before those lines existed have only
//!   token_count events, counted by the thread's running total after the
//!   call, which a fork or a backup copies unchanged.
//! - OpenClaw and Pi, which write the same entries, by the response id of a
//!   call (the same key as Codex's records, as a response has one id wherever
//!   it's written down), or else the entry's id and time, as a copy of a
//!   session carries both unchanged. The turns OpenClaw copies from a Codex
//!   harness are counted from that harness's rollout, so its copies are
//!   passed over.
//!
//! Counting reads the store's chunks, so it follows everything kept however
//! it arrived, and a change of rule counts it all again.

use super::classify::{load_version, Blobs, Version};
use super::recovered::{self, RecoveredDay, RecoveredOverlap};
use super::index::{get_meta, lock_writes, set_meta};
use super::ingest::{self, Throttle};
use super::sha::sha256;
use chrono::{DateTime, Datelike, Local, TimeZone};
use memchr::memmem;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Read;
use std::time::{Duration, Instant};

/// What counts as a call. Changing it clears the counts, and they're counted again.
const RULE: &str = "tokens-v1";
/// A line this long is a tool's output or a file, never a call's usage, so it's passed over.
const LONG_LINE: usize = 64 << 20;

/// The versions whose bytes are transcripts and have grown since they were last counted.
const UNCOUNTED: &str = "FROM versions v JOIN members m USING (member_id) JOIN sessions s USING (session_pk)
       LEFT JOIN token_progress p USING (version_id)
     WHERE v.encoding IN ('plain', 'zstd') AND COALESCE(p.seen_len, 0) < v.size
       AND ((s.agent = 'claude' AND (m.member = 'main' OR m.member LIKE 'main~%' OR (m.member LIKE 'subagents/%' AND m.member LIKE '%.jsonl')))
         OR (s.agent = 'codex' AND (m.member = 'rollout' OR m.member LIKE 'rollout/%' OR m.member LIKE 'original/%'))
         OR (s.agent IN ('openclaw', 'pi') AND m.member = 'main'))";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Usage {
    pub(crate) input: u64,
    pub(crate) cache_write: u64,
    pub(crate) cache_read: u64,
    pub(crate) output: u64,
    /// Part of output, for Codex.
    pub(crate) reasoning: u64,
}

impl Usage {
    fn is_empty(&self) -> bool {
        self.input + self.cache_write + self.cache_read + self.output == 0
    }

    fn max(self, other: Usage) -> Usage {
        Usage {
            input: self.input.max(other.input),
            cache_write: self.cache_write.max(other.cache_write),
            cache_read: self.cache_read.max(other.cache_read),
            output: self.output.max(other.output),
            reasoning: self.reasoning.max(other.reasoning),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Call {
    pub(crate) key: i64,
    /// yyyymmdd, on this Mac's clock.
    pub(crate) day: i64,
    pub(crate) model: String,
    pub(crate) usage: Usage,
}

/// What a Codex file said before the bytes being read: the model its last turn used, and
/// whether it has token_usage_record lines, after which its token_count events are repeats.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Carry {
    pub(crate) model: Option<String>,
    pub(crate) records: bool,
}

fn key(kind: &str, id: &str) -> i64 {
    let hash = sha256(format!("{kind}:{id}").as_bytes());
    i64::from_be_bytes(hash[..8].try_into().unwrap_or_default())
}

fn day_of(timestamp: &str) -> Option<i64> {
    let at = DateTime::parse_from_rfc3339(timestamp).ok()?.with_timezone(&Local);
    Some(i64::from(at.year()) * 10_000 + i64::from(at.month()) * 100 + i64::from(at.day()))
}

fn day_of_ms(ms: i64) -> i64 {
    Local.timestamp_millis_opt(ms).single().map_or(0, |at| i64::from(at.year()) * 10_000 + i64::from(at.month()) * 100 + i64::from(at.day()))
}

#[derive(Deserialize)]
struct ClaudeLine<'a> {
    #[serde(rename = "type", borrow, default)]
    kind: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    timestamp: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    message: Option<ClaudeMessage<'a>>,
}

#[derive(Deserialize)]
struct ClaudeMessage<'a> {
    #[serde(borrow, default)]
    id: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    model: Option<Cow<'a, str>>,
    #[serde(default)]
    usage: Option<ClaudeUsage>,
}

#[derive(Deserialize)]
struct ClaudeUsage {
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    cache_read_input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct CodexLine<'a> {
    #[serde(rename = "type", borrow, default)]
    kind: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    timestamp: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    payload: Option<CodexPayload<'a>>,
}

#[derive(Deserialize)]
struct CodexPayload<'a> {
    #[serde(rename = "type", borrow, default)]
    kind: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    model: Option<Cow<'a, str>>,
    #[serde(default)]
    info: Option<CodexInfo>,
    #[serde(borrow, default)]
    response_id: Option<Cow<'a, str>>,
    #[serde(default)]
    usage: Option<CodexUsage>,
    #[serde(default)]
    thread_token_usage: Option<CodexUsage>,
}

#[derive(Deserialize)]
struct CodexInfo {
    #[serde(default)]
    total_token_usage: Option<CodexUsage>,
    #[serde(default)]
    last_token_usage: Option<CodexUsage>,
}

#[derive(Deserialize)]
struct CodexUsage {
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    cached_input_tokens: Option<u64>,
    #[serde(default)]
    cache_write_input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
    #[serde(default)]
    reasoning_output_tokens: Option<u64>,
}

impl CodexUsage {
    /// Codex's input includes what was read from and written to the cache.
    fn usage(&self) -> Usage {
        let cache_read = self.cached_input_tokens.unwrap_or(0);
        let cache_write = self.cache_write_input_tokens.unwrap_or(0);
        Usage {
            input: self.input_tokens.unwrap_or(0).saturating_sub(cache_read).saturating_sub(cache_write),
            cache_write,
            cache_read,
            output: self.output_tokens.unwrap_or(0),
            reasoning: self.reasoning_output_tokens.unwrap_or(0),
        }
    }

    /// The thread's running total, which names the call that brought it there.
    fn running_total(&self) -> String {
        let field = |value: Option<u64>| value.unwrap_or(0);
        format!(
            "{} {} {} {} {}",
            field(self.input_tokens),
            field(self.cached_input_tokens),
            field(self.cache_write_input_tokens),
            field(self.output_tokens),
            field(self.reasoning_output_tokens)
        )
    }
}

/// An entry in an OpenClaw or Pi session.
#[derive(Deserialize)]
struct EntryLine<'a> {
    #[serde(rename = "type", borrow, default)]
    kind: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    id: Option<Cow<'a, str>>,
    /// A model_change entry's model, which the calls after it use when they don't name one.
    #[serde(rename = "modelId", borrow, default)]
    model_id: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    timestamp: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    message: Option<EntryMessage<'a>>,
}

#[derive(Deserialize)]
struct EntryMessage<'a> {
    #[serde(borrow, default)]
    role: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    model: Option<Cow<'a, str>>,
    #[serde(rename = "responseId", borrow, default)]
    response_id: Option<Cow<'a, str>>,
    #[serde(default)]
    usage: Option<EntryUsage>,
    #[serde(rename = "__openclaw", default)]
    marks: Option<OpenClawMarks>,
}

#[derive(Deserialize)]
struct OpenClawMarks {
    /// Set on a turn OpenClaw copied from the harness that ran it.
    #[serde(rename = "mirrorIdentity", default)]
    mirror: Option<serde::de::IgnoredAny>,
}

/// Its input leaves out what was read from and written to the cache.
#[derive(Deserialize)]
struct EntryUsage {
    #[serde(default)]
    input: Option<u64>,
    #[serde(rename = "cacheWrite", default)]
    cache_write: Option<u64>,
    #[serde(rename = "cacheRead", default)]
    cache_read: Option<u64>,
    #[serde(default)]
    output: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Agent {
    Claude,
    Codex,
    OpenClaw,
    Pi,
}

impl Agent {
    fn from_name(name: &str) -> Self {
        match name {
            "codex" => Agent::Codex,
            "openclaw" => Agent::OpenClaw,
            "pi" => Agent::Pi,
            _ => Agent::Claude,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
            Agent::OpenClaw => "openclaw",
            Agent::Pi => "pi",
        }
    }
}

/// Turns a version's lines into its calls, a copy of a call merged into the first.
pub(crate) struct Parser {
    agent: Agent,
    carry: Carry,
    fallback_day: i64,
    calls: HashMap<i64, Call>,
    usage_finder: memmem::Finder<'static>,
    assistant_finder: memmem::Finder<'static>,
    codex_finders: [memmem::Finder<'static>; 3],
    model_change_finder: memmem::Finder<'static>,
}

impl Parser {
    pub(crate) fn new(agent: Agent, carry: Carry, fallback_day: i64) -> Self {
        Parser {
            agent,
            carry,
            fallback_day,
            calls: HashMap::new(),
            usage_finder: memmem::Finder::new(b"\"usage\""),
            assistant_finder: memmem::Finder::new(b"\"assistant\""),
            codex_finders: [memmem::Finder::new(b"token_usage_record"), memmem::Finder::new(b"token_count"), memmem::Finder::new(b"turn_context")],
            model_change_finder: memmem::Finder::new(b"\"model_change\""),
        }
    }

    fn add(&mut self, key: i64, timestamp: Option<&str>, model: &str, usage: Usage) {
        if usage.is_empty() {
            return;
        }
        let day = timestamp.and_then(day_of).unwrap_or(self.fallback_day);
        self.calls
            .entry(key)
            .and_modify(|call| call.usage = call.usage.max(usage))
            .or_insert_with(|| Call { key, day, model: model.to_string(), usage });
    }

    pub(crate) fn line(&mut self, line: &[u8]) {
        match self.agent {
            Agent::Claude => self.claude(line),
            Agent::Codex => self.codex(line),
            Agent::OpenClaw | Agent::Pi => self.entry(line),
        }
    }

    /// An OpenClaw or Pi entry.
    fn entry(&mut self, line: &[u8]) {
        let is_call = self.usage_finder.find(line).is_some() && self.assistant_finder.find(line).is_some();
        if !is_call && self.model_change_finder.find(line).is_none() {
            return;
        }
        let Ok(parsed) = serde_json::from_slice::<EntryLine<'_>>(line) else {
            return;
        };
        if parsed.kind.as_deref() == Some("model_change") {
            if let Some(model) = parsed.model_id.filter(|model| !model.is_empty()) {
                self.carry.model = Some(model.into_owned());
            }
            return;
        }
        let copied = |message: &EntryMessage<'_>| message.marks.as_ref().is_some_and(|marks| marks.mirror.is_some());
        let Some(message) = parsed.message.filter(|message| message.role.as_deref() == Some("assistant") && !copied(message)) else {
            return;
        };
        // An entry's id is a few characters, so only with its time does it name one call.
        let key = match (message.response_id, parsed.id, parsed.timestamp.as_deref()) {
            (Some(id), _, _) => key("codex-r", &id),
            (None, Some(id), Some(at)) => key(self.agent.name(), &format!("{id} {at}")),
            _ => return,
        };
        let Some(usage) = message.usage else {
            return;
        };
        let usage = Usage {
            input: usage.input.unwrap_or(0),
            cache_write: usage.cache_write.unwrap_or(0),
            cache_read: usage.cache_read.unwrap_or(0),
            output: usage.output.unwrap_or(0),
            reasoning: 0,
        };
        let model = message.model.map(Cow::into_owned).or_else(|| self.carry.model.clone()).unwrap_or_default();
        self.add(key, parsed.timestamp.as_deref(), &model, usage);
    }

    fn claude(&mut self, line: &[u8]) {
        if self.usage_finder.find(line).is_none() || self.assistant_finder.find(line).is_none() {
            return;
        }
        let Ok(parsed) = serde_json::from_slice::<ClaudeLine<'_>>(line) else {
            return;
        };
        let (Some("assistant"), Some(message)) = (parsed.kind.as_deref(), parsed.message) else {
            return;
        };
        let (Some(id), Some(usage)) = (message.id, message.usage) else {
            return;
        };
        let model = message.model.unwrap_or_default();
        // Claude Code's own stand-in replies, which no model made.
        if model == "<synthetic>" {
            return;
        }
        let usage = Usage {
            input: usage.input_tokens.unwrap_or(0),
            cache_write: usage.cache_creation_input_tokens.unwrap_or(0),
            cache_read: usage.cache_read_input_tokens.unwrap_or(0),
            output: usage.output_tokens.unwrap_or(0),
            reasoning: 0,
        };
        self.add(key("claude", &id), parsed.timestamp.as_deref(), &model, usage);
    }

    fn codex(&mut self, line: &[u8]) {
        if !self.codex_finders.iter().any(|finder| finder.find(line).is_some()) {
            return;
        }
        let Ok(parsed) = serde_json::from_slice::<CodexLine<'_>>(line) else {
            return;
        };
        let (Some(kind), Some(payload)) = (parsed.kind.as_deref(), parsed.payload) else {
            return;
        };
        let timestamp = parsed.timestamp.as_deref();
        let model = self.carry.model.clone().unwrap_or_default();
        match kind {
            "turn_context" => {
                if let Some(model) = payload.model.filter(|model| !model.is_empty()) {
                    self.carry.model = Some(model.into_owned());
                }
            }
            "token_usage_record" => {
                self.carry.records = true;
                let Some(usage) = payload.usage else {
                    return;
                };
                let key = match (payload.response_id, payload.thread_token_usage) {
                    (Some(id), _) => key("codex-r", &id),
                    (None, Some(total)) => key("codex-t", &total.running_total()),
                    (None, None) => return,
                };
                self.add(key, timestamp, &model, usage.usage());
            }
            "event_msg" if payload.kind.as_deref() == Some("token_count") && !self.carry.records => {
                let Some(CodexInfo { total_token_usage: Some(total), last_token_usage: Some(last) }) = payload.info else {
                    return;
                };
                self.add(key("codex-t", &total.running_total()), timestamp, &model, last.usage());
            }
            _ => {}
        }
    }

    pub(crate) fn into_calls(self) -> (Vec<Call>, Carry) {
        (self.calls.into_values().collect(), self.carry)
    }
}

/// Splits bytes that arrive in pieces into whole lines, keeping track of where the last one ended.
struct Lines {
    /// Where the bytes after the last whole line start.
    end: u64,
    partial: Vec<u8>,
    /// The line being read is too long to be one that counts.
    passing_over: bool,
}

impl Lines {
    fn new(start: u64) -> Self {
        Lines { end: start, partial: Vec::new(), passing_over: false }
    }

    fn feed(&mut self, mut bytes: &[u8], each: &mut impl FnMut(&[u8])) {
        while let Some(at) = memchr::memchr(b'\n', bytes) {
            let (line, rest) = (&bytes[..at], &bytes[at + 1..]);
            let length = self.partial.len() as u64 + line.len() as u64 + 1;
            if self.passing_over {
                self.passing_over = false;
            } else if self.partial.is_empty() {
                each(line);
            } else {
                self.partial.extend_from_slice(line);
                each(&self.partial);
            }
            self.end += length;
            self.partial.clear();
            bytes = rest;
        }
        if self.passing_over {
            self.end += bytes.len() as u64;
        } else {
            self.partial.extend_from_slice(bytes);
            if self.partial.len() > LONG_LINE {
                self.end += self.partial.len() as u64;
                self.partial = Vec::new();
                self.passing_over = true;
            }
        }
    }

    /// A settled file's last line, when it has no newline after it.
    fn finish(&mut self, each: &mut impl FnMut(&[u8])) {
        if !self.passing_over && !self.partial.is_empty() {
            each(&self.partial);
        }
        self.end += self.partial.len() as u64;
        self.partial.clear();
        self.passing_over = false;
    }
}

pub(crate) struct CountOptions {
    pub(crate) bytes_per_second: u64,
    /// Counting stops once it has read this much, or run this long, and carries on next pass.
    pub(crate) max_bytes: u64,
    pub(crate) max_time: Duration,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct CountReport {
    /// Every version was counted to its end.
    pub(crate) complete: bool,
    pub(crate) versions: u64,
    pub(crate) bytes_read: u64,
    pub(crate) calls: u64,
    pub(crate) failures: u64,
    pub(crate) first_failure: Option<String>,
}

fn db_error(error: rusqlite::Error) -> String {
    format!("The archive index failed: {error}")
}

/// Clears the counts when they were made by another rule.
fn check_rule(db: &Connection) -> Result<(), String> {
    if get_meta(db, "tokenRule")?.as_deref() == Some(RULE) {
        return Ok(());
    }
    let _writes = lock_writes();
    let transaction = db.unchecked_transaction().map_err(db_error)?;
    transaction.execute_batch("DELETE FROM token_calls; DELETE FROM token_days; DELETE FROM token_progress;").map_err(db_error)?;
    set_meta(&transaction, "tokenRule", RULE)?;
    transaction.commit().map_err(db_error)
}

struct Progress {
    version_id: i64,
    agent: Agent,
    counted_len: u64,
    carry: Carry,
}

/// Counts what's new in every kept transcript. `stop` is asked between pieces.
pub(crate) fn count_pass(db: &Connection, blobs: &dyn Blobs, options: &CountOptions, stop: &dyn Fn() -> bool) -> Result<CountReport, String> {
    let started = Instant::now();
    check_rule(db)?;
    let mut report = CountReport { complete: true, ..CountReport::default() };
    let mut throttle = Throttle::new(options.bytes_per_second);
    // Transcripts kept as a home's own before the archive knew them for a session's are filed
    // with it first, so they're counted this pass.
    if let Err(error) = ingest::refile(db, blobs, &mut throttle) {
        report.failures += 1;
        report.first_failure.get_or_insert(error);
    }
    let todo: Vec<Progress> = {
        let mut statement = db
            .prepare(&format!("SELECT v.version_id, s.agent, COALESCE(p.counted_len, 0), p.model, COALESCE(p.records, 0) {UNCOUNTED} ORDER BY v.version_id"))
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(Progress {
                    version_id: row.get(0)?,
                    agent: Agent::from_name(&row.get::<_, String>(1)?),
                    counted_len: row.get::<_, i64>(2)?.max(0) as u64,
                    carry: Carry { model: row.get(3)?, records: row.get::<_, i64>(4)? != 0 },
                })
            })
            .map_err(db_error)?;
        rows.collect::<Result<_, _>>().map_err(db_error)?
    };
    // Claude Code's own figures come from a few small files, read again only when a copy is new.
    if let Err(error) = recovered::recover(db, blobs, &mut throttle) {
        report.failures += 1;
        report.first_failure.get_or_insert(error);
    }
    let out_of_time = |report: &CountReport| stop() || report.bytes_read >= options.max_bytes || started.elapsed() >= options.max_time;
    for progress in todo {
        if out_of_time(&report) {
            report.complete = false;
            break;
        }
        let mut enough = |read: u64| {
            report.bytes_read += read;
            out_of_time(&report)
        };
        match count_version(db, blobs, progress, &mut throttle, &mut enough) {
            Ok((calls, finished)) => {
                report.versions += 1;
                report.calls += calls;
                if !finished {
                    report.complete = false;
                    break;
                }
            }
            // Counted again next pass.
            Err(error) => {
                report.failures += 1;
                report.first_failure.get_or_insert(error);
            }
        }
    }
    Ok(report)
}

/// Where each piece of a version's bytes is, from `from` on.
pub(super) enum Piece {
    Chunk([u8; 32], u64),
    Pending(u64),
}

pub(super) fn pieces(version: &Version, from: u64) -> Vec<Piece> {
    let mut out: Vec<Piece> = version.chunks.iter().filter(|(off, _, len)| off + len > from).map(|(off, hash, _)| Piece::Chunk(*hash, *off)).collect();
    if version.state == "growing" && version.tail_len > 0 && version.committed_len + version.tail_len > from {
        out.push(Piece::Pending(version.committed_len));
    }
    out
}

/// Counts one version from where counting last stopped. `enough` hears each piece's size and
/// says when to stop. Returns the calls counted and whether the version was counted to its end.
fn count_version(db: &Connection, blobs: &dyn Blobs, progress: Progress, throttle: &mut Throttle, enough: &mut dyn FnMut(u64) -> bool) -> Result<(u64, bool), String> {
    let version = load_version(db, progress.version_id)?;
    let (source_id, created_at): (Option<i64>, i64) = db
        .query_row(
            "SELECT (SELECT f.source_id FROM observations o JOIN files f USING (file_id) WHERE o.version_id = v.version_id ORDER BY o.first_at, o.file_id LIMIT 1), v.created_at
             FROM versions v WHERE v.version_id = ?1",
            [version.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(db_error)?;
    let source_id = source_id.ok_or("A kept version has no file it was seen in")?;
    let agent_name = progress.agent.name();
    let fallback_day = day_of_ms(created_at);

    if version.encoding == "zstd" {
        // A compressed file is read from its start each time it changes; its calls already
        // counted are the same calls.
        let mut frame = Vec::with_capacity(version.size as usize);
        for piece in pieces(&version, 0) {
            let bytes = read_piece(blobs, &version, &piece, throttle)?;
            frame.extend_from_slice(&bytes);
            enough(bytes.len() as u64);
        }
        let mut parser = Parser::new(progress.agent, Carry::default(), fallback_day);
        let mut decoder = zstd::stream::Decoder::new(&frame[..]).map_err(|error| format!("Couldn't decompress a kept file: {error}"))?;
        let mut lines = Lines::new(0);
        let mut buffer = vec![0u8; 1 << 20];
        loop {
            let read = decoder.read(&mut buffer).map_err(|error| format!("Couldn't decompress a kept file: {error}"))?;
            if read == 0 {
                break;
            }
            lines.feed(&buffer[..read], &mut |line| parser.line(line));
        }
        lines.finish(&mut |line| parser.line(line));
        let (calls, carry) = parser.into_calls();
        let counted = save(db, version.id, source_id, agent_name, (version.size, version.size), &carry, &calls)?;
        return Ok((counted, true));
    }

    let mut parser = Parser::new(progress.agent, progress.carry, fallback_day);
    let mut lines = Lines::new(progress.counted_len);
    let mut finished = true;
    let all = pieces(&version, progress.counted_len);
    let count = all.len();
    for (index, piece) in all.iter().enumerate() {
        let bytes = read_piece(blobs, &version, piece, throttle)?;
        let start = match piece {
            Piece::Chunk(_, off) | Piece::Pending(off) => *off,
        };
        let skip = progress.counted_len.saturating_sub(start) as usize;
        lines.feed(bytes.get(skip..).unwrap_or_default(), &mut |line| parser.line(line));
        // Stopping saves where the last whole line ended, so it waits until one has.
        if enough(bytes.len() as u64) && index + 1 < count && lines.end > progress.counted_len {
            finished = false;
            break;
        }
    }
    // A version that won't grow again ends with its last line, newline or not.
    if finished && version.state != "growing" {
        lines.finish(&mut |line| parser.line(line));
    }
    // A growing version's last line may be half written: it's read again once the version grows.
    let counted_len = if finished && version.state != "growing" { version.size } else { lines.end };
    let seen_len = if finished { version.size } else { lines.end };
    let (calls, carry) = parser.into_calls();
    let counted = save(db, version.id, source_id, agent_name, (counted_len, seen_len), &carry, &calls)?;
    Ok((counted, finished))
}

pub(super) fn read_piece(blobs: &dyn Blobs, version: &Version, piece: &Piece, throttle: &mut Throttle) -> Result<Vec<u8>, String> {
    let bytes = match piece {
        Piece::Chunk(hash, _) => blobs.read_chunk(hash)?,
        Piece::Pending(_) => blobs.read_pending(&version.vk, version.pending_gen)?,
    };
    throttle.take(bytes.len() as u64);
    Ok(bytes)
}

/// Adds a version's calls that weren't counted before, and the output a streamed message
/// gained since, and notes how far the version is counted. Returns the calls new to the count.
fn save(db: &Connection, version_id: i64, source_id: i64, agent: &str, (counted_len, seen_len): (u64, u64), carry: &Carry, calls: &[Call]) -> Result<u64, String> {
    let _writes = lock_writes();
    let transaction = db.unchecked_transaction().map_err(db_error)?;
    let mut buckets: HashMap<(i64, &str), i64> = HashMap::new();
    let mut added: HashMap<i64, (u64, Usage)> = HashMap::new();
    let mut new_calls = 0;
    {
        let mut existing = transaction.prepare_cached("SELECT bucket, output FROM token_calls WHERE key = ?1").map_err(db_error)?;
        let mut insert = transaction.prepare_cached("INSERT INTO token_calls(key, bucket, output) VALUES(?1, ?2, ?3)").map_err(db_error)?;
        let mut grow = transaction.prepare_cached("UPDATE token_calls SET output = ?2 WHERE key = ?1").map_err(db_error)?;
        let mut bucket = transaction
            .prepare_cached(
                "INSERT INTO token_days(day, source_id, agent, model) VALUES(?1, ?2, ?3, ?4)
                 ON CONFLICT(day, source_id, agent, model) DO UPDATE SET day = excluded.day RETURNING bucket_id",
            )
            .map_err(db_error)?;
        for call in calls {
            let seen: Option<(i64, i64)> = existing.query_row([call.key], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(db_error)?;
            match seen {
                None => {
                    let bucket_id = match buckets.get(&(call.day, call.model.as_str())) {
                        Some(id) => *id,
                        None => {
                            let id: i64 = bucket.query_row(params![call.day, source_id, agent, call.model], |row| row.get(0)).map_err(db_error)?;
                            buckets.insert((call.day, call.model.as_str()), id);
                            id
                        }
                    };
                    insert.execute(params![call.key, bucket_id, call.usage.output as i64]).map_err(db_error)?;
                    let entry = added.entry(bucket_id).or_default();
                    entry.0 += 1;
                    entry.1.input += call.usage.input;
                    entry.1.cache_write += call.usage.cache_write;
                    entry.1.cache_read += call.usage.cache_read;
                    entry.1.output += call.usage.output;
                    entry.1.reasoning += call.usage.reasoning;
                    new_calls += 1;
                }
                Some((bucket_id, output)) if call.usage.output as i64 > output => {
                    grow.execute(params![call.key, call.usage.output as i64]).map_err(db_error)?;
                    added.entry(bucket_id).or_default().1.output += call.usage.output - output.max(0) as u64;
                }
                Some(_) => {}
            }
        }
        let mut apply = transaction
            .prepare_cached(
                "UPDATE token_days SET calls = calls + ?2, input = input + ?3, cache_write = cache_write + ?4, cache_read = cache_read + ?5,
                   output = output + ?6, reasoning = reasoning + ?7 WHERE bucket_id = ?1",
            )
            .map_err(db_error)?;
        for (bucket_id, (calls, usage)) in &added {
            apply
                .execute(params![bucket_id, *calls as i64, usage.input as i64, usage.cache_write as i64, usage.cache_read as i64, usage.output as i64, usage.reasoning as i64])
                .map_err(db_error)?;
        }
    }
    transaction
        .execute(
            "INSERT INTO token_progress(version_id, counted_len, seen_len, model, records) VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(version_id) DO UPDATE SET counted_len = excluded.counted_len, seen_len = excluded.seen_len, model = excluded.model, records = excluded.records",
            params![version_id, counted_len as i64, seen_len as i64, carry.model, carry.records],
        )
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    Ok(new_calls)
}

pub(crate) fn note_failure(db: &Connection, error: Option<&str>) -> Result<(), String> {
    let _writes = lock_writes();
    match error {
        Some(error) => set_meta(db, "tokenError", error),
        None => db.execute("DELETE FROM meta WHERE key = 'tokenError'", []).map(|_| ()).map_err(db_error),
    }
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Counts {
    calls: u64,
    input: u64,
    cache_write: u64,
    cache_read: u64,
    output: u64,
    reasoning: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MonthRow {
    /// yyyy-mm
    month: String,
    machine: String,
    home: String,
    agent: String,
    model: String,
    #[serde(flatten)]
    counts: Counts,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DayRow {
    /// yyyy-mm-dd
    day: String,
    #[serde(flatten)]
    counts: Counts,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CountedSource {
    machine: String,
    home: String,
    agent: String,
    kind: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LifetimeTokens {
    /// An archive has been set up, so there's something to count.
    archived: bool,
    months: Vec<MonthRow>,
    days: Vec<DayRow>,
    /// The homes whose sessions are kept, and so counted.
    sources: Vec<CountedSource>,
    /// Claude Code's own daily totals on days no Claude transcript was counted for on that machine.
    /// It counts more than the transcripts hold, so these are in none of the rows above.
    recovered: Vec<RecoveredDay>,
    recovered_overlap: RecoveredOverlap,
    /// Kept transcripts not yet counted to their end.
    versions_left: u64,
    bytes_left: u64,
    last_error: Option<String>,
}

fn counts(row: &rusqlite::Row<'_>, first: usize) -> rusqlite::Result<Counts> {
    let field = |at: usize| row.get::<_, Option<i64>>(first + at).map(|value| value.unwrap_or(0).max(0) as u64);
    Ok(Counts { calls: field(0)?, input: field(1)?, cache_write: field(2)?, cache_read: field(3)?, output: field(4)?, reasoning: field(5)? })
}

const SUMS: &str = "SUM(d.calls), SUM(d.input), SUM(d.cache_write), SUM(d.cache_read), SUM(d.output), SUM(d.reasoning)";

/// What's been counted so far, by month, machine, home, agent and model, and by day.
pub(crate) fn lifetime(db: &Connection) -> Result<LifetimeTokens, String> {
    let months = {
        let mut statement = db
            .prepare(&format!(
                "SELECT d.day / 100, s.machine, s.label, d.agent, d.model, {SUMS} FROM token_days d JOIN sources s USING (source_id)
                 GROUP BY d.day / 100, s.machine, s.label, d.agent, d.model ORDER BY d.day / 100, s.machine, s.label, d.agent, d.model"
            ))
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                let month: i64 = row.get(0)?;
                Ok(MonthRow {
                    month: format!("{:04}-{:02}", month / 100, month % 100),
                    machine: row.get(1)?,
                    home: row.get(2)?,
                    agent: row.get(3)?,
                    model: row.get(4)?,
                    counts: counts(row, 5)?,
                })
            })
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    let days = {
        let mut statement = db.prepare(&format!("SELECT d.day, {SUMS} FROM token_days d GROUP BY d.day ORDER BY d.day")).map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                let day: i64 = row.get(0)?;
                Ok(DayRow { day: format!("{:04}-{:02}-{:02}", day / 10_000, day / 100 % 100, day % 100), counts: counts(row, 1)? })
            })
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    let sources = {
        let mut statement = db.prepare("SELECT machine, label, agent, kind FROM sources WHERE agent IN ('claude', 'codex') OR source_id IN (SELECT source_id FROM token_days) ORDER BY machine, label").map_err(db_error)?;
        let rows = statement.query_map([], |row| Ok(CountedSource { machine: row.get(0)?, home: row.get(1)?, agent: row.get(2)?, kind: row.get(3)? })).map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    let (versions_left, bytes_left): (i64, Option<i64>) =
        db.query_row(&format!("SELECT COUNT(*), SUM(v.size - COALESCE(p.counted_len, 0)) {UNCOUNTED}"), [], |row| Ok((row.get(0)?, row.get(1)?))).map_err(db_error)?;
    let (recovered, recovered_overlap) = recovered::days(db)?;
    Ok(LifetimeTokens {
        archived: get_meta(db, "archiveId")?.is_some(),
        months,
        days,
        sources,
        recovered,
        recovered_overlap,
        versions_left: versions_left.max(0) as u64,
        bytes_left: bytes_left.unwrap_or(0).max(0) as u64,
        last_error: get_meta(db, "tokenError")?,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn parse(agent: Agent, text: &str) -> (Vec<Call>, Carry) {
        let mut parser = Parser::new(agent, Carry::default(), 20260101);
        let mut lines = Lines::new(0);
        lines.feed(text.as_bytes(), &mut |line| parser.line(line));
        lines.finish(&mut |line| parser.line(line));
        let (mut calls, carry) = parser.into_calls();
        calls.sort_by_key(|call| (call.day, call.usage.output));
        (calls, carry)
    }

    pub(crate) fn claude_line(id: &str, model: &str, at: &str, usage: (u64, u64, u64, u64), text: &str) -> String {
        format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"{at}\",\"requestId\":\"req\",\"message\":{{\"id\":\"{id}\",\"model\":\"{model}\",\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{text}\"}}],\"usage\":{{\"input_tokens\":{},\"cache_creation_input_tokens\":{},\"cache_read_input_tokens\":{},\"output_tokens\":{},\"cache_creation\":{{\"ephemeral_5m_input_tokens\":0}}}}}}}}\n",
            usage.0, usage.1, usage.2, usage.3
        )
    }

    pub(crate) fn codex_usage(input: u64, cached: u64, output: u64, reasoning: u64) -> String {
        format!("{{\"input_tokens\":{input},\"cached_input_tokens\":{cached},\"cache_write_input_tokens\":0,\"output_tokens\":{output},\"reasoning_output_tokens\":{reasoning},\"total_tokens\":{}}}", input + output)
    }

    pub(crate) fn codex_event(at: &str, total: &str, last: &str) -> String {
        format!("{{\"timestamp\":\"{at}\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",\"info\":{{\"total_token_usage\":{total},\"last_token_usage\":{last},\"model_context_window\":272000}},\"rate_limits\":null}}}}\n")
    }

    pub(crate) fn codex_record(at: &str, response: &str, usage: &str, total: &str) -> String {
        format!("{{\"timestamp\":\"{at}\",\"type\":\"token_usage_record\",\"payload\":{{\"response_id\":\"{response}\",\"thread_id\":\"t\",\"turn_id\":\"u\",\"usage\":{usage},\"thread_token_usage\":{total},\"turn_token_usage\":{usage}}}}}\n")
    }

    pub(crate) fn codex_turn(at: &str, model: &str, text: &str) -> String {
        format!("{{\"timestamp\":\"{at}\",\"type\":\"turn_context\",\"payload\":{{\"model\":\"{model}\",\"cwd\":\"/x\",\"user_instructions\":\"{text}\"}}}}\n")
    }

    /// An OpenClaw entry for a call: its own with a response id, or one it copied from a harness.
    pub(crate) fn openclaw_line(id: &str, response: Option<&str>, copied: bool, at: &str, usage: (u64, u64, u64, u64), text: &str) -> String {
        let response = response.map(|response| format!(",\"responseId\":\"{response}\"")).unwrap_or_default();
        let marks = if copied { ",\"__openclaw\":{\"mirrorIdentity\":\"m1\"}" } else { "" };
        let (input, cache_write, cache_read, output) = usage;
        format!(
            "{{\"type\":\"message\",\"id\":\"{id}\",\"parentId\":\"p\",\"timestamp\":\"{at}\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{text}\"}}],\"api\":\"openai-codex-responses\",\"provider\":\"openai-codex\",\"model\":\"gpt-5.5\"{response}{marks},\"usage\":{{\"input\":{input},\"output\":{output},\"cacheRead\":{cache_read},\"cacheWrite\":{cache_write},\"totalTokens\":{},\"cost\":{{\"total\":0.1}}}},\"stopReason\":\"stop\",\"timestamp\":1778000000000}}}}\n",
            input + cache_write + cache_read + output
        )
    }

    #[test]
    fn openclaw_counts_its_own_calls_and_leaves_the_turns_it_copied_to_their_harness() {
        let at = "2026-05-02T01:00:00.000Z";
        let text = [
            "{\"type\":\"session\",\"id\":\"s\",\"timestamp\":\"2026-05-02T00:59:00.000Z\"}\n".to_string(),
            "{\"type\":\"message\",\"id\":\"e0\",\"timestamp\":\"2026-05-02T01:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"assistant usage\"}}\n".to_string(),
            openclaw_line("e1", Some("resp_1"), false, at, (10, 0, 900, 50), "a"),
            // A copy of the same call, as a reset session carries it over.
            openclaw_line("e9", Some("resp_1"), false, at, (10, 0, 900, 50), "a"),
            openclaw_line("e2", None, false, at, (5, 20, 300, 7), "b"),
            // Turns a Codex harness ran, whose rollout has them.
            openclaw_line("e3", None, true, at, (1_000, 0, 9_000, 100), "c"),
            // A failed call.
            openclaw_line("e4", Some("resp_2"), false, at, (0, 0, 0, 0), "d"),
        ]
        .concat();
        let (calls, _) = parse(Agent::OpenClaw, &text);
        assert_eq!(calls.len(), 2);
        let own = calls.iter().find(|call| call.key == key("codex-r", "resp_1")).unwrap();
        assert_eq!((own.day, own.model.as_str(), own.usage), (day_of(at).unwrap(), "gpt-5.5", Usage { input: 10, cache_write: 0, cache_read: 900, output: 50, reasoning: 0 }));
        assert_eq!(calls.iter().find(|call| call.key == key("openclaw", &format!("e2 {at}"))).unwrap().usage, Usage { input: 5, cache_write: 20, cache_read: 300, output: 7, reasoning: 0 });
    }

    #[test]
    fn a_pi_call_without_a_model_uses_the_last_model_change() {
        let at = "2026-07-19T07:00:05Z";
        let call = |id: &str, at: &str| format!("{{\"type\":\"message\",\"id\":\"{id}\",\"parentId\":\"p\",\"timestamp\":\"{at}\",\"message\":{{\"role\":\"assistant\",\"content\":\"hi\",\"usage\":{{\"input\":100,\"output\":40,\"cacheRead\":10,\"cacheWrite\":2}}}}}}\n");
        let text = [
            "{\"type\":\"session\",\"version\":3,\"id\":\"s1\",\"timestamp\":\"2026-07-19T07:00:00Z\",\"cwd\":\"/w\"}\n".to_string(),
            "{\"type\":\"model_change\",\"id\":\"a1\",\"provider\":\"anthropic\",\"modelId\":\"claude-sonnet-5\",\"timestamp\":\"2026-07-19T07:00:01Z\"}\n".to_string(),
            call("a2", at),
            // Another call that happens to get the same short id.
            call("a2", "2026-07-19T07:03:00Z"),
            "{\"type\":\"model_change\",\"id\":\"a3\",\"provider\":\"openai-codex\",\"modelId\":\"gpt-6-sol\",\"timestamp\":\"2026-07-19T07:05:00Z\"}\n".to_string(),
            call("a4", "2026-07-19T07:05:05Z"),
        ]
        .concat();
        let (calls, carry) = parse(Agent::Pi, &text);
        let mut models: Vec<&str> = calls.iter().map(|call| call.model.as_str()).collect();
        models.sort_unstable();
        assert_eq!(models, ["claude-sonnet-5", "claude-sonnet-5", "gpt-6-sol"]);
        assert!(calls.iter().any(|call| call.key == key("pi", &format!("a2 {at}"))));
        assert_eq!(carry.model.as_deref(), Some("gpt-6-sol"));
    }

    #[test]
    fn a_streamed_claude_message_counts_once_with_its_largest_output() {
        let text = [
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi usage assistant\"}}\n".to_string(),
            claude_line("msg_1", "claude-opus-5-5", "2026-09-20T02:00:00.000Z", (3, 100, 2_000, 1), "a"),
            claude_line("msg_1", "claude-opus-5-5", "2026-09-20T02:00:01.000Z", (3, 100, 2_000, 250), "b"),
            claude_line("msg_2", "claude-opus-5-5", "2026-09-20T02:01:00.000Z", (5, 0, 2_100, 40), "c"),
            claude_line("msg_3", "<synthetic>", "2026-09-20T02:02:00.000Z", (0, 0, 0, 9), "d"),
            "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_4\",\"usage\":\"not usage\"}}\n".to_string(),
            "not json but has \"usage\" and \"assistant\"\n".to_string(),
        ]
        .concat();
        let (calls, _) = parse(Agent::Claude, &text);
        assert_eq!(calls.len(), 2);
        let day = day_of("2026-09-20T02:00:00.000Z").unwrap();
        assert_eq!(calls[1], Call { key: key("claude", "msg_1"), day, model: "claude-opus-5-5".into(), usage: Usage { input: 3, cache_write: 100, cache_read: 2_000, output: 250, reasoning: 0 } });
        assert_eq!(calls[0].usage.output, 40);
    }

    #[test]
    fn codex_records_are_counted_and_their_events_are_not() {
        let text = [
            codex_turn("2026-09-21T01:00:00.000Z", "gpt-6-sol", "secret"),
            codex_record("2026-09-21T01:00:01.000Z", "resp_1", &codex_usage(1_000, 800, 50, 20), &codex_usage(1_000, 800, 50, 20)),
            codex_event("2026-09-21T01:00:01.100Z", &codex_usage(1_000, 800, 50, 20), &codex_usage(1_000, 800, 50, 20)),
            // A call with a record and no event of its own.
            codex_record("2026-09-21T01:00:02.000Z", "resp_2", &codex_usage(300, 0, 10, 0), &codex_usage(1_000, 800, 50, 20)),
            codex_record("2026-09-21T01:00:03.000Z", "resp_3", &codex_usage(1_200, 1_000, 60, 30), &codex_usage(2_200, 1_800, 110, 50)),
            codex_event("2026-09-21T01:00:03.100Z", &codex_usage(2_200, 1_800, 110, 50), &codex_usage(1_200, 1_000, 60, 30)),
        ]
        .concat();
        let (calls, carry) = parse(Agent::Codex, &text);
        assert_eq!(carry, Carry { model: Some("gpt-6-sol".into()), records: true });
        assert_eq!(calls.len(), 3);
        let total: u64 = calls.iter().map(|call| call.usage.input + call.usage.cache_read + call.usage.output).sum();
        assert_eq!(total, 1_050 + 310 + 1_260);
        let first = calls.iter().find(|call| call.key == key("codex-r", "resp_1")).unwrap();
        assert_eq!(first.usage, Usage { input: 200, cache_write: 0, cache_read: 800, output: 50, reasoning: 20 });
        assert!(calls.iter().all(|call| call.model == "gpt-6-sol"));
    }

    #[test]
    fn older_codex_files_count_each_token_count_event_once() {
        let first = codex_usage(1_000, 0, 50, 0);
        let second_total = codex_usage(2_500, 900, 90, 0);
        let text = [
            codex_turn("2026-03-01T01:00:00.000Z", "gpt-5", "x"),
            codex_event("2026-03-01T01:00:01.000Z", &first, &first),
            // Sent again with only the rate limits changed.
            codex_event("2026-03-01T01:00:01.500Z", &first, &first),
            "{\"timestamp\":\"2026-03-01T01:00:01.600Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":null}}\n".to_string(),
            codex_event("2026-03-01T01:00:02.000Z", &second_total, &codex_usage(1_500, 900, 40, 0)),
        ]
        .concat();
        let (calls, carry) = parse(Agent::Codex, &text);
        assert!(!carry.records);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls.iter().map(|call| call.usage.input + call.usage.cache_read + call.usage.output).sum::<u64>(), 1_050 + 1_540);
        // A fork or backup holds the same events, so the same keys.
        let (fork, _) = parse(Agent::Codex, &[codex_event("2026-03-02T01:00:00.000Z", &first, &first)].concat());
        assert_eq!(fork[0].key, calls.iter().find(|call| call.usage.output == 50).unwrap().key);
        // Once a file has records, its events are repeats of them.
        let mut parser = Parser::new(Agent::Codex, Carry { model: Some("gpt-6".into()), records: true }, 0);
        parser.line(codex_event("2026-03-01T01:00:01.000Z", &first, &first).trim_end().as_bytes());
        assert!(parser.into_calls().0.is_empty());
    }

    #[test]
    fn lines_are_split_across_pieces_and_counted_up_to_the_last_whole_one() {
        let mut seen: Vec<String> = Vec::new();
        let mut lines = Lines::new(10);
        let mut each = |line: &[u8]| seen.push(String::from_utf8_lossy(line).into_owned());
        lines.feed(b"ab", &mut each);
        lines.feed(b"c\nde", &mut each);
        lines.feed(b"f\ng", &mut each);
        assert_eq!(lines.end, 10 + 4 + 4);
        lines.finish(&mut each);
        assert_eq!(lines.end, 10 + 4 + 4 + 1);
        assert_eq!(seen, ["abc", "def", "g"]);
    }

    use super::super::identity::MemberKey;
    use super::super::ingest::tests::{walk, Fixture, SECRET_TEXT, SID, THREAD};
    use super::super::ingest::{ensure_member, refile};
    use std::fs;

    const FORK: &str = "019a1b2c-3d4e-7f00-8111-999988887777";

    fn everything() -> CountOptions {
        CountOptions { bytes_per_second: 1 << 40, max_bytes: 1 << 40, max_time: Duration::from_secs(600) }
    }

    fn count(fixture: &Fixture, options: &CountOptions) -> CountReport {
        count_pass(&fixture.db, &fixture.places, options, &|| false).unwrap()
    }

    /// calls, and every token of every kind.
    fn totals(fixture: &Fixture) -> (u64, u64) {
        let lifetime = lifetime(&fixture.db).unwrap();
        lifetime.months.iter().fold((0, 0), |(calls, tokens), row| (calls + row.counts.calls, tokens + row.counts.input + row.counts.cache_write + row.counts.cache_read + row.counts.output))
    }

    fn claude_session(outputs: &[(&str, u64)]) -> String {
        let mut text = format!("{{\"type\":\"user\",\"sessionId\":\"{SID}\",\"message\":{{\"role\":\"user\",\"content\":\"{SECRET_TEXT}\"}}}}\n");
        for (n, (id, output)) in outputs.iter().enumerate() {
            text += &claude_line(id, "claude-opus-5-5", &format!("2026-09-20T02:{n:02}:00.000Z"), (10, 100, 1_000, *output), SECRET_TEXT);
        }
        text
    }

    fn codex_session(thread: &str, responses: &[&str]) -> String {
        let mut text = format!("{{\"timestamp\":\"2026-09-21T01:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{thread}\",\"instructions\":\"{SECRET_TEXT}\"}}}}\n");
        text += &codex_turn("2026-09-21T01:00:00.500Z", "gpt-6-sol", SECRET_TEXT);
        for (n, response) in responses.iter().enumerate() {
            let usage = codex_usage(2_000, 1_500, 100, 40);
            let at = format!("2026-09-21T01:{n:02}:01.000Z");
            text += &codex_record(&at, response, &usage, &usage);
            text += &codex_event(&at, &usage, &usage);
        }
        text
    }

    #[test]
    fn every_call_kept_is_counted_once_however_many_copies_there_are() {
        let fixture = Fixture::new("tokens-copies");
        let main = format!(".claude/projects/-Users-me-app/{SID}.jsonl");
        fixture.write(&main, &claude_session(&[("msg_1", 1), ("msg_2", 20)]));
        // The same session in another home, and a subagent that repeats one of its messages.
        fixture.write(&format!(".agent-app/homes/claude-proxy/projects/-Users-me-app/{SID}.jsonl"), &claude_session(&[("msg_1", 1), ("msg_2", 20)]));
        fixture.write(&format!(".claude/projects/-Users-me-app/{SID}/subagents/agent-a1.jsonl"), &claude_session(&[("msg_2", 20), ("msg_3", 5)]));
        fixture.write(&format!(".codex/sessions/2026/09/21/rollout-2026-09-21T01-00-00-{THREAD}.jsonl"), &codex_session(THREAD, &["resp_1", "resp_2"]));
        // A fork carries its parent's calls over, then makes its own.
        fixture.write(&format!(".codex/sessions/2026/09/22/rollout-2026-09-22T01-00-00-{FORK}.jsonl"), &codex_session(FORK, &["resp_1", "resp_2", "resp_3"]));
        assert!(fixture.pass().complete);
        let report = count(&fixture, &everything());
        assert!(report.complete && report.failures == 0, "{report:?}");
        let claude_call = 10 + 100 + 1_000;
        let codex_call = 500 + 1_500 + 100;
        assert_eq!(totals(&fixture), (6, 3 * claude_call + 1 + 20 + 5 + 3 * codex_call));
        let lifetime = lifetime(&fixture.db).unwrap();
        assert_eq!(lifetime.versions_left, 0);
        let models: std::collections::BTreeSet<&str> = lifetime.months.iter().map(|row| row.model.as_str()).collect();
        assert_eq!(models.into_iter().collect::<Vec<_>>(), ["claude-opus-5-5", "gpt-6-sol"]);
        let codex = lifetime.months.iter().filter(|row| row.agent == "codex").fold(0, |sum, row| sum + row.counts.reasoning);
        assert_eq!(codex, 3 * 40);
        assert!(lifetime.months.iter().all(|row| row.machine == "mac" && row.month == "2026-09"));

        // Nothing new: nothing's read.
        assert_eq!(count(&fixture, &everything()).bytes_read, 0);

        // The session grows: a message streams on and a new one arrives.
        fixture.write(&main, &claude_session(&[("msg_1", 1), ("msg_2", 20), ("msg_1", 300), ("msg_4", 7)]));
        assert!(fixture.pass().complete);
        count(&fixture, &everything());
        assert_eq!(totals(&fixture), (7, 4 * claude_call + 300 + 20 + 5 + 7 + 3 * codex_call));

        // A new rule counts everything again, to the same total.
        let before = totals(&fixture);
        set_meta(&fixture.db, "tokenRule", "tokens-v0").unwrap();
        count(&fixture, &everything());
        assert_eq!(totals(&fixture), before);
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn counting_stops_at_its_share_and_carries_on_to_the_same_total() {
        let whole = Fixture::new("tokens-whole");
        let shares = Fixture::new("tokens-shares");
        for fixture in [&whole, &shares] {
            fixture.write(&format!(".claude/projects/-a/{SID}.jsonl"), &claude_session(&[("msg_1", 1), ("msg_2", 2), ("msg_1", 30), ("msg_3", 4)]));
            fixture.write(&format!(".codex/sessions/2026/09/21/rollout-2026-09-21T01-00-00-{THREAD}.jsonl"), &codex_session(THREAD, &["resp_1", "resp_2", "resp_3"]));
            assert!(fixture.pass().complete);
        }
        count(&whole, &everything());
        // The fixture's chunks are tiny, so one byte of share is a piece at a time.
        let small = CountOptions { max_bytes: 1, ..everything() };
        let mut passes = 0;
        loop {
            passes += 1;
            let report = count(&shares, &small);
            assert_eq!(report.failures, 0);
            if report.complete {
                break;
            }
            assert!(lifetime(&shares.db).unwrap().versions_left > 0);
        }
        assert!(passes > 10, "{passes}");
        assert_eq!(totals(&shares), totals(&whole));
        for fixture in [whole, shares] {
            let _ = fs::remove_dir_all(&fixture.base);
        }
    }

    #[test]
    fn a_compressed_rollout_is_counted_like_its_plain_copy() {
        let fixture = Fixture::new("tokens-zstd");
        let text = codex_session(THREAD, &["resp_1", "resp_2"]);
        let archived = fixture.home.join(format!(".codex/archived_sessions/rollout-2026-09-21T01-00-00-{THREAD}.jsonl.zst"));
        fs::create_dir_all(archived.parent().unwrap()).unwrap();
        fs::write(&archived, zstd::encode_all(text.as_bytes(), 3).unwrap()).unwrap();
        assert!(fixture.pass().complete);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM versions WHERE encoding = 'zstd'"), 1);
        assert!(count(&fixture, &everything()).complete);
        assert_eq!(totals(&fixture), (2, 2 * (500 + 1_500 + 100)));
        fixture.write(&format!(".codex/sessions/2026/09/21/rollout-2026-09-21T01-00-00-{THREAD}.jsonl"), &codex_session(THREAD, &["resp_1", "resp_2", "resp_3"]));
        assert!(fixture.pass().complete);
        count(&fixture, &everything());
        assert_eq!(totals(&fixture), (3, 3 * (500 + 1_500 + 100)));
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn a_rollout_kept_as_a_homes_own_is_filed_with_its_session_and_counted() {
        let fixture = Fixture::new("tokens-refile");
        let name = format!("archived_sessions__rollout-2026-09-21T01-00-00-{THREAD}.jsonl.f4eafffbb20827c7.zst");
        let original = fixture.home.join(format!(".codex/compacted-history/originals/{name}"));
        let frame = zstd::encode_all(codex_session(THREAD, &["resp_1", "resp_2"]).as_bytes(), 3).unwrap();
        fs::create_dir_all(original.parent().unwrap()).unwrap();
        fs::write(&original, &frame).unwrap();
        // The compacted rollout kept only the last call.
        fixture.write(&format!(".codex/archived_sessions/rollout-2026-09-21T01-00-00-{THREAD}.jsonl"), &codex_session(THREAD, &["resp_2"]));
        assert!(fixture.pass().complete);
        let member = format!("original/{name}");
        let filed = "SELECT COUNT(*) FROM members m JOIN sessions s USING (session_pk) JOIN versions v USING (member_id)";
        assert_eq!(fixture.count(&format!("{filed} WHERE s.agent = 'codex' AND s.session_id = '{THREAD}' AND m.member = '{member}' AND v.encoding = 'zstd'")), 1);

        // As the rules before this one filed it: the home's own, kept as it is.
        let side = MemberKey { agent: "side".into(), session_id: "mac:~/.codex".into(), member: format!("files/compacted-history/originals/{name}"), project_key: None, encoding: "plain", has_ordinal: None };
        let side_id = ensure_member(&fixture.db, &side, 0).unwrap();
        let own: i64 = fixture.db.query_row("SELECT member_id FROM members WHERE member = ?1", [&member], |row| row.get(0)).unwrap();
        fixture
            .db
            .execute_batch(&format!(
                "UPDATE versions SET member_id = {side_id}, encoding = 'plain', has_ordinal = NULL WHERE member_id = {own};
                 UPDATE files SET member_id = {side_id} WHERE member_id = {own};
                 DELETE FROM members WHERE member_id = {own};"
            ))
            .unwrap();
        assert!(count(&fixture, &everything()).complete);
        assert_eq!(fixture.count(&format!("{filed} WHERE s.agent = 'codex' AND m.member = '{member}' AND v.encoding = 'zstd' AND v.has_ordinal = 0")), 1);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM members WHERE member LIKE 'files/compacted-history/%'"), 0);
        // Its calls count once with the compacted rollout's.
        assert_eq!(totals(&fixture), (2, 2 * (500 + 1_500 + 100)));

        // Once is enough, and a later pass leaves it where it is, even when the file is written again.
        let mut throttle = Throttle::new(1 << 40);
        assert_eq!(refile(&fixture.db, &fixture.places, &mut throttle).unwrap(), 0);
        fs::write(&original, &frame).unwrap();
        assert!(fixture.pass().complete);
        count(&fixture, &everything());
        assert_eq!(fixture.count(&format!("{filed} WHERE m.member = '{member}'")), 1);
        assert_eq!(totals(&fixture), (2, 2 * (500 + 1_500 + 100)));

        // What it was filed by is read from its first line, which stays in the store.
        let secret = SECRET_TEXT.as_bytes();
        let contains = |bytes: &[u8]| bytes.windows(secret.len()).any(|window| window == secret);
        fixture.db.execute_batch("PRAGMA wal_checkpoint(PASSIVE);").unwrap();
        for path in [fixture.db_path.clone(), fixture.db_path.with_extension("db-wal")] {
            if let Ok(bytes) = fs::read(&path) {
                assert!(!contains(&bytes), "{}", path.display());
            }
        }
        let journal: Vec<u8> = walk(&fixture.places.store.root().join("journal")).iter().flat_map(|path| fs::read(path).unwrap()).collect();
        assert!(!contains(&journal));
        assert!(memmem::find(&journal, b"\"t\":\"refile\"").is_some());
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn a_pi_home_is_kept_and_counted_without_what_sits_beside_its_sessions() {
        let fixture = Fixture::new("tokens-pi");
        let header = format!("{{\"type\":\"session\",\"version\":3,\"id\":\"{SID}\",\"timestamp\":\"2026-07-19T07:00:00Z\",\"cwd\":\"/w\"}}\n");
        let at = "2026-07-19T07:00:05.000Z";
        let session = format!("{header}{}", openclaw_line("a1", None, false, at, (100, 2, 10, 40), SECRET_TEXT));
        fixture.write(&format!(".pi/agent/sessions/--Users-me-app--/2026-07-19T07-00-00-000Z_{SID}.jsonl"), &session);
        // A branch of it, which carries the same entry over.
        fixture.write(&format!(".pi/agent/sessions/--Users-me-app--/2026-07-19T08-00-00-000Z_{THREAD}.jsonl"), &session);
        fixture.write(".pi/agent/auth.json", SECRET_TEXT);
        fixture.write(".pi/agent/settings.json", SECRET_TEXT);
        assert!(fixture.pass().complete);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM sources WHERE agent = 'pi'"), 1);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM sessions WHERE agent = 'pi'"), 1);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM files WHERE rel_path LIKE '%.json'"), 0);
        assert!(count(&fixture, &everything()).complete);
        let lifetime = lifetime(&fixture.db).unwrap();
        let rows: Vec<(&str, &str, &str, u64)> = lifetime.months.iter().map(|row| (row.home.as_str(), row.agent.as_str(), row.model.as_str(), row.counts.calls)).collect();
        assert_eq!(rows, [("~/.pi/agent/sessions", "pi", "gpt-5.5", 1)]);
        assert_eq!(totals(&fixture), (1, 100 + 2 + 10 + 40));
        let secret = SECRET_TEXT.as_bytes();
        let contains = |bytes: &[u8]| bytes.windows(secret.len()).any(|window| window == secret);
        fixture.db.execute_batch("PRAGMA wal_checkpoint(PASSIVE);").unwrap();
        for path in [fixture.db_path.clone(), fixture.db_path.with_extension("db-wal")].into_iter().chain(walk(&fixture.places.store.root().join("journal"))) {
            assert!(!fs::read(&path).is_ok_and(|bytes| contains(&bytes)), "{}", path.display());
        }
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn counting_keeps_transcript_text_out_of_the_index_and_the_page() {
        let fixture = Fixture::new("tokens-secret");
        fixture.write(&format!(".claude/projects/-a/{SID}.jsonl"), &claude_session(&[("msg_1", 1), ("msg_2", 2)]));
        fixture.write(&format!(".codex/sessions/2026/09/21/rollout-2026-09-21T01-00-00-{THREAD}.jsonl"), &codex_session(THREAD, &["resp_1"]));
        fixture.pass();
        count(&fixture, &everything());
        // A half-written line is left for when the file grows.
        fixture.write(&format!(".claude/projects/-a/{SID}.jsonl"), &format!("{}{{\"type\":\"assistant\",\"message\":{{\"content\":\"{SECRET_TEXT}", claude_session(&[("msg_1", 1), ("msg_2", 2)])));
        fixture.pass();
        count(&fixture, &everything());
        assert_eq!(totals(&fixture).0, 3);
        let secret = SECRET_TEXT.as_bytes();
        let contains = |bytes: &[u8]| bytes.windows(secret.len()).any(|window| window == secret);
        fixture.db.execute_batch("PRAGMA wal_checkpoint(PASSIVE);").unwrap();
        for path in [fixture.db_path.clone(), fixture.db_path.with_extension("db-wal")] {
            if let Ok(bytes) = fs::read(&path) {
                assert!(!contains(&bytes), "{}", path.display());
            }
        }
        for path in walk(&fixture.places.store.root().join("journal")) {
            assert!(!contains(&fs::read(&path).unwrap()), "{}", path.display());
        }
        let json = serde_json::to_string(&lifetime(&fixture.db).unwrap()).unwrap();
        assert!(!json.contains(SECRET_TEXT) && !json.contains("msg_1") && !json.contains("resp_1"), "{json}");
        let _ = fs::remove_dir_all(&fixture.base);
    }
}

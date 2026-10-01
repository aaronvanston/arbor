//! A record of what the command line and agents asked the app to do, shown in Settings › App › Command line.
//! It keeps the method, who asked and how it went; never the arguments, which can hold names, paths or text the
//! person wouldn't want written down.

use super::dispatch::Access;
use super::protocol::Response;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use ts_rs::TS;

const LOG_FILE: &str = "activity.jsonl";
const OLD_LOG_FILE: &str = "activity.1.jsonl";
/// Past this the log starts over, keeping one older file.
const MAX_LOG_BYTES: u64 = 1024 * 1024;
/// How many entries Settings shows.
pub(crate) const RECENT: usize = 50;

/// One request from the command line.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "CliActivity")]
pub(crate) struct Entry {
    /// When it was asked, in ms since the epoch.
    pub(crate) at: i64,
    /// `arbor` or `arbor mcp`.
    #[ts(type = "\"cli\" | \"mcp\"")]
    pub(crate) client: String,
    pub(crate) method: String,
    /// What the method does; none when there was no such method.
    pub(crate) access: Option<Access>,
    /// ok, plan (it needed confirming), or the failure's kind.
    #[ts(type = "\"ok\" | \"plan\" | \"failed\" | \"canceled\" | \"core\" | \"unsupported\" | \"unavailable\"")]
    pub(crate) outcome: String,
    pub(crate) ms: u64,
}

impl Entry {
    pub(crate) fn new(client: &str, method: &str, access: Option<Access>, response: &Response, took: Duration) -> Self {
        Self {
            at: chrono::Utc::now().timestamp_millis(),
            client: if client == "mcp" { "mcp" } else { "cli" }.into(),
            method: method.chars().take(120).collect(),
            access,
            outcome: response.outcome().into(),
            ms: u64::try_from(took.as_millis()).unwrap_or(u64::MAX),
        }
    }
}

fn log_path(dir: &Path) -> PathBuf {
    dir.join(LOG_FILE)
}

/// Adds an entry; a log that can't be written loses the entry rather than the answer.
pub(crate) fn record(entry: &Entry) {
    if let Ok(dir) = super::cli_dir() {
        let _ = append(&dir, entry);
    }
}

fn append(dir: &Path, entry: &Entry) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let path = log_path(dir);
    if fs::metadata(&path).is_ok_and(|meta| meta.len() > MAX_LOG_BYTES) {
        fs::rename(&path, dir.join(OLD_LOG_FILE))?;
    }
    let mut file = fs::OpenOptions::new().create(true).append(true).open(&path)?;
    let line = serde_json::to_string(entry).map_err(std::io::Error::other)?;
    writeln!(file, "{line}")
}

/// The latest entries, newest first.
pub(crate) fn recent(dir: &Path, count: usize) -> Vec<Entry> {
    let text = fs::read_to_string(log_path(dir)).unwrap_or_default();
    text.lines().rev().filter_map(|line| serde_json::from_str(line).ok()).take(count).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(method: &str) -> Entry {
        let response = Response::ok("1", json!(null));
        Entry::new("cli", method, Some(Access::Read), &response, Duration::from_millis(4))
    }

    #[test]
    fn entries_read_back_newest_first() {
        let dir = super::super::test_dir("audit-order");
        append(&dir, &entry("get_core_status")).unwrap();
        append(&dir, &entry("get_machine_health")).unwrap();
        let read: Vec<String> = recent(&dir, 10).into_iter().map(|entry| entry.method).collect();
        assert_eq!(read, ["get_machine_health", "get_core_status"]);
        assert_eq!(recent(&dir, 1).len(), 1);
    }

    #[test]
    fn a_full_log_starts_over_and_keeps_one_older_file() {
        let dir = super::super::test_dir("audit-full");
        fs::write(log_path(&dir), vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).unwrap();
        append(&dir, &entry("get_core_status")).unwrap();
        assert!(dir.join(OLD_LOG_FILE).exists());
        assert_eq!(recent(&dir, 10).len(), 1);
    }
}

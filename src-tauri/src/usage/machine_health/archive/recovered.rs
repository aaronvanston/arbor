//! Claude Code's own daily totals, from the stats-cache.json each Claude home keeps, for the
//! days whose transcripts are gone. It counts more than the transcripts hold, so its figures
//! stay apart from the all-time total and are shown as its count. archive.db gets each
//! machine's days with their model names, token counts and session counts; the file's other
//! fields are passed over unread.

use super::classify::{load_version, Blobs};
use super::index::{get_meta, lock_writes, set_meta};
use super::ingest::Throttle;
use super::tokens::{pieces, read_piece};
use chrono::NaiveDate;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use ts_rs::TS;

/// How the files are read. Changing it reads them all again.
const RULE: &str = "recovered-v1";
/// The file is tens of kilobytes; a copy far bigger than that isn't one to read.
const LARGEST: u64 = 16 << 20;

/// Every kept copy of a Claude home's stats-cache.json.
const COPIES: &str = "FROM versions v JOIN members m USING (member_id) JOIN sessions s USING (session_pk)
     WHERE s.agent = 'side' AND m.member = 'files/stats-cache.json' AND v.encoding = 'plain'";

fn db_error(error: rusqlite::Error) -> String {
    format!("The archive index failed: {error}")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatsCache {
    #[serde(default)]
    daily_model_tokens: Vec<ModelTokens>,
    #[serde(default)]
    daily_activity: Vec<Activity>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelTokens {
    date: String,
    #[serde(default)]
    tokens_by_model: HashMap<String, u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Activity {
    date: String,
    #[serde(default)]
    session_count: u64,
}

/// yyyymmdd from Claude Code's yyyy-mm-dd, a day on the machine's own clock.
fn day(date: &str) -> Option<i64> {
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    date.format("%Y%m%d").to_string().parse().ok()
}

/// A machine's days: the most any copy gives for each day's models, and for its sessions.
#[derive(Default)]
struct Machine {
    tokens: HashMap<(i64, String), u64>,
    sessions: HashMap<i64, u64>,
}

impl Machine {
    /// Adds one copy. A copy caught mid-write, or in a shape this doesn't know, gives nothing.
    fn add(&mut self, bytes: &[u8]) {
        let Ok(stats) = serde_json::from_slice::<StatsCache>(bytes) else {
            return;
        };
        for entry in stats.daily_model_tokens {
            let Some(day) = day(&entry.date) else { continue };
            for (model, tokens) in entry.tokens_by_model {
                // Claude Code's own stand-in replies, which no model made.
                if tokens == 0 || model == "<synthetic>" {
                    continue;
                }
                let most = self.tokens.entry((day, model)).or_default();
                *most = (*most).max(tokens);
            }
        }
        for entry in stats.daily_activity {
            let Some(day) = day(&entry.date) else { continue };
            if entry.session_count > 0 {
                let most = self.sessions.entry(day).or_default();
                *most = (*most).max(entry.session_count);
            }
        }
    }
}

/// Reads every copy of Claude Code's stats again when a copy has been kept since last time.
/// Copies on one machine are the same home's figures over time, or a backup of them, so a day
/// takes the most any of them gives rather than their sum. Returns whether it read them.
pub(crate) fn recover(db: &Connection, blobs: &dyn Blobs, throttle: &mut Throttle) -> Result<bool, String> {
    let (copies, last, size): (i64, i64, i64) =
        db.query_row(&format!("SELECT COUNT(*), COALESCE(MAX(v.version_id), 0), COALESCE(SUM(v.size), 0) {COPIES}"), [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(db_error)?;
    let fingerprint = format!("{RULE}:{copies}:{last}:{size}");
    if get_meta(db, "recoveredFrom")?.as_deref() == Some(fingerprint.as_str()) {
        return Ok(false);
    }
    // Each copy belongs to the machine it was first seen on, as its transcripts' calls do.
    let found: Vec<(i64, String)> = {
        let mut statement = db
            .prepare(&format!(
                "SELECT v.version_id, (SELECT src.machine FROM observations o JOIN files f USING (file_id) JOIN sources src USING (source_id)
                   WHERE o.version_id = v.version_id AND src.agent = 'claude' ORDER BY o.first_at, o.file_id LIMIT 1) AS machine
                 {COPIES} AND machine IS NOT NULL AND v.size <= ?1 ORDER BY v.version_id"
            ))
            .map_err(db_error)?;
        let rows = statement.query_map([LARGEST as i64], |row| Ok((row.get(0)?, row.get(1)?))).map_err(db_error)?;
        rows.collect::<Result<_, _>>().map_err(db_error)?
    };
    let mut machines: BTreeMap<String, Machine> = BTreeMap::new();
    for (version_id, machine) in found {
        let version = load_version(db, version_id)?;
        let mut bytes = Vec::with_capacity(version.size as usize);
        for piece in pieces(&version, 0) {
            bytes.extend_from_slice(&read_piece(blobs, &version, &piece, throttle)?);
        }
        machines.entry(machine).or_default().add(&bytes);
    }
    let _writes = lock_writes();
    let transaction = db.unchecked_transaction().map_err(db_error)?;
    transaction.execute_batch("DELETE FROM recovered_tokens; DELETE FROM recovered_sessions;").map_err(db_error)?;
    {
        let mut tokens = transaction.prepare("INSERT INTO recovered_tokens(machine, day, model, tokens) VALUES(?1, ?2, ?3, ?4)").map_err(db_error)?;
        let mut sessions = transaction.prepare("INSERT INTO recovered_sessions(machine, day, sessions) VALUES(?1, ?2, ?3)").map_err(db_error)?;
        for (name, machine) in &machines {
            for ((day, model), count) in &machine.tokens {
                tokens.execute(params![name, day, model, *count as i64]).map_err(db_error)?;
            }
            for (day, count) in &machine.sessions {
                sessions.execute(params![name, day, *count as i64]).map_err(db_error)?;
            }
        }
    }
    set_meta(&transaction, "recoveredFrom", &fingerprint)?;
    transaction.commit().map_err(db_error)?;
    Ok(true)
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveredDay {
    /// yyyy-mm-dd
    day: String,
    machine: String,
    /// Every token Claude Code counted that day, of every kind; 0 when it kept only how many sessions there were.
    tokens: u64,
    sessions: u64,
}

/// Both counts, added up over the days a machine has both, to show how far apart they run.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveredOverlap {
    claude_code: u64,
    transcripts: u64,
}

/// Claude Code's days on each machine that no Claude transcript was counted for, oldest first.
pub(crate) fn days(db: &Connection) -> Result<(Vec<RecoveredDay>, RecoveredOverlap), String> {
    let counted: HashMap<(String, i64), i64> = {
        let mut statement = db
            .prepare(
                "SELECT s.machine, d.day, SUM(d.input + d.cache_write + d.cache_read + d.output) FROM token_days d JOIN sources s USING (source_id)
                 WHERE d.agent = 'claude' GROUP BY s.machine, d.day",
            )
            .map_err(db_error)?;
        let rows = statement.query_map([], |row| Ok(((row.get(0)?, row.get(1)?), row.get(2)?))).map_err(db_error)?;
        rows.collect::<Result<_, _>>().map_err(db_error)?
    };
    let mut own: BTreeMap<(i64, String), (u64, u64)> = BTreeMap::new();
    {
        let mut statement = db.prepare("SELECT day, machine, SUM(tokens) FROM recovered_tokens GROUP BY day, machine").map_err(db_error)?;
        let rows = statement.query_map([], |row| Ok(((row.get::<_, i64>(0)?, row.get::<_, String>(1)?), row.get::<_, i64>(2)?))).map_err(db_error)?;
        for row in rows {
            let (key, tokens) = row.map_err(db_error)?;
            own.entry(key).or_default().0 = tokens.max(0) as u64;
        }
        let mut statement = db.prepare("SELECT day, machine, sessions FROM recovered_sessions").map_err(db_error)?;
        let rows = statement.query_map([], |row| Ok(((row.get::<_, i64>(0)?, row.get::<_, String>(1)?), row.get::<_, i64>(2)?))).map_err(db_error)?;
        for row in rows {
            let (key, sessions) = row.map_err(db_error)?;
            own.entry(key).or_default().1 = sessions.max(0) as u64;
        }
    }
    let mut days = Vec::new();
    let mut overlap = RecoveredOverlap::default();
    for ((day, machine), (tokens, sessions)) in own {
        match counted.get(&(machine.clone(), day)).copied().filter(|counted| *counted > 0) {
            Some(counted) => {
                if tokens > 0 {
                    overlap.claude_code += tokens;
                    overlap.transcripts += counted as u64;
                }
            }
            None => days.push(RecoveredDay { day: format!("{:04}-{:02}-{:02}", day / 10_000, day / 100 % 100, day % 100), machine, tokens, sessions }),
        }
    }
    Ok((days, overlap))
}

#[cfg(test)]
mod tests {
    use super::super::ingest::tests::{walk, Fixture, SECRET_TEXT, SID};
    use super::super::tokens::tests::claude_line;
    use super::super::tokens::{count_pass, lifetime, CountOptions};
    use super::*;
    use std::fs;
    use std::time::Duration;

    fn everything() -> CountOptions {
        CountOptions { bytes_per_second: 1 << 40, max_bytes: 1 << 40, max_time: Duration::from_secs(600) }
    }

    /// Claude Code's stats for `days` of (date, [(model, tokens)], sessions), with the fields beside them it also keeps.
    fn stats(days: &[(&str, &[(&str, u64)], u64)]) -> String {
        let tokens: Vec<String> = days
            .iter()
            .filter(|(_, models, _)| !models.is_empty())
            .map(|(date, models, _)| {
                let models: Vec<String> = models.iter().map(|(model, tokens)| format!("\"{model}\":{tokens}")).collect();
                format!("{{\"date\":\"{date}\",\"tokensByModel\":{{{}}}}}", models.join(","))
            })
            .collect();
        let activity: Vec<String> = days.iter().map(|(date, _, sessions)| format!("{{\"date\":\"{date}\",\"messageCount\":40,\"sessionCount\":{sessions},\"toolCallCount\":9}}")).collect();
        format!(
            "{{\"version\":5,\"lastComputedDate\":\"2026-09-27\",\"dailyActivity\":[{}],\"dailyModelTokens\":[{}],\"dailyModelTokensVersion\":2,\
             \"modelUsage\":{{\"claude-opus-5-5\":{{\"inputTokens\":1,\"outputTokens\":2}}}},\"totalSessions\":3,\"totalMessages\":4,\
             \"longestSession\":{{\"sessionId\":\"{SID}\",\"note\":\"{SECRET_TEXT}\"}},\"firstSessionDate\":\"2026-01-13T05:57:05.144Z\",\"hourCounts\":{{\"9\":2}}}}",
            activity.join(","),
            tokens.join(",")
        )
    }

    /// The day a transcript line written at `at` is counted on, as yyyy-mm-dd.
    fn local(at: &str) -> String {
        let day = chrono::DateTime::parse_from_rfc3339(at).unwrap().with_timezone(&chrono::Local).date_naive();
        day.format("%Y-%m-%d").to_string()
    }

    fn recovered(fixture: &Fixture) -> (Vec<(String, u64, u64)>, RecoveredOverlap) {
        let (days, overlap) = days(&fixture.db).unwrap();
        (days.into_iter().map(|day| (day.day, day.tokens, day.sessions)).collect(), overlap)
    }

    #[test]
    fn claude_codes_own_count_fills_the_days_whose_transcripts_are_gone() {
        let fixture = Fixture::new("recovered-days");
        let at = "2026-09-20T02:00:00.000Z";
        let kept = local(at);
        fixture.write(&format!(".claude/projects/-a/{SID}.jsonl"), &claude_line("msg_1", "claude-opus-5-5", at, (10, 100, 1_000, 40), SECRET_TEXT));
        // The day with a transcript, two whose transcripts are gone, one with a count of sessions only, and a stand-in reply's.
        fixture.write(
            ".claude/stats-cache.json",
            &stats(&[
                ("2026-03-02", &[], 4),
                ("2026-08-02", &[("claude-opus-5-5", 9_000), ("claude-haiku-4-5", 500), ("<synthetic>", 7)], 2),
                ("2026-08-03", &[("claude-opus-5-5", 3_000)], 1),
                (&kept, &[("claude-opus-5-5", 2_300)], 1),
                ("not a date", &[("claude-opus-5-5", 1)], 1),
            ]),
        );
        // Another home's older copy has less for one day, and more for another: each day takes the most.
        fixture.write(".agent-app/homes/claude-proxy/.claude.json", "{}");
        fixture.write(".agent-app/homes/claude-proxy/stats-cache.json", &stats(&[("2026-08-02", &[("claude-opus-5-5", 8_000)], 3), ("2026-08-03", &[("claude-opus-5-5", 3_500)], 1)]));
        assert!(fixture.pass().complete);
        let report = count_pass(&fixture.db, &fixture.places, &everything(), &|| false).unwrap();
        assert!(report.complete && report.failures == 0, "{report:?}");

        let (days, overlap) = recovered(&fixture);
        assert_eq!(days, [("2026-03-02".to_string(), 0, 4), ("2026-08-02".to_string(), 9_500, 3), ("2026-08-03".to_string(), 3_500, 1)]);
        assert_eq!(overlap, RecoveredOverlap { claude_code: 2_300, transcripts: 10 + 100 + 1_000 + 40 });
        // The transcripts' count is untouched by it.
        let lifetime = serde_json::to_value(lifetime(&fixture.db).unwrap()).unwrap();
        assert_eq!(lifetime["months"].as_array().map(Vec::len), Some(1));
        assert_eq!(lifetime["days"].as_array().map(Vec::len), Some(1));
        assert_eq!(lifetime["recovered"].as_array().map(Vec::len), Some(3));
        assert_eq!(lifetime["recoveredOverlap"]["claudeCode"], 2_300);

        // Nothing new kept: nothing read again.
        let mut throttle = Throttle::new(1 << 40);
        assert!(!recover(&fixture.db, &fixture.places, &mut throttle).unwrap());
        // Claude Code adds a day, and a later pass reads the new copy.
        fixture.write(".claude/stats-cache.json", &stats(&[("2026-08-02", &[("claude-opus-5-5", 9_100)], 2), ("2026-08-04", &[("claude-opus-5-5", 600)], 1)]));
        assert!(fixture.pass().complete);
        count_pass(&fixture.db, &fixture.places, &everything(), &|| false).unwrap();
        let (days, _) = recovered(&fixture);
        // The old copy is kept too, so the days only it gives stay.
        assert_eq!(
            days,
            [("2026-03-02".to_string(), 0, 4), ("2026-08-02".to_string(), 9_600, 3), ("2026-08-03".to_string(), 3_500, 1), ("2026-08-04".to_string(), 600, 1)]
        );
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn a_day_is_filled_only_on_the_machine_whose_transcripts_are_gone() {
        let fixture = Fixture::new("recovered-machines");
        fixture.write(".claude/stats-cache.json", &stats(&[("2026-08-02", &[("claude-opus-5-5", 9_000)], 2)]));
        assert!(fixture.pass().complete);
        count_pass(&fixture.db, &fixture.places, &everything(), &|| false).unwrap();
        assert_eq!(recovered(&fixture).0.len(), 1);
        // Another machine's transcripts that day don't stand for this one's.
        fixture.db.execute("INSERT INTO sources(source_id, machine, kind, agent, root, label, first_seen_at) VALUES(90, 'cedar', 'home', 'claude', '/e', '~/.claude', 0)", []).unwrap();
        fixture.db.execute("INSERT INTO token_days(day, source_id, agent, model, calls, cache_read) VALUES(20260802, 90, 'claude', 'claude-opus-5-5', 1, 5000)", []).unwrap();
        assert_eq!(recovered(&fixture).0.len(), 1);
        // Nor do Codex's on this one.
        let own: i64 = fixture.db.query_row("SELECT source_id FROM sources WHERE agent = 'claude' AND machine = 'mac' LIMIT 1", [], |row| row.get(0)).unwrap();
        fixture.db.execute("INSERT INTO token_days(day, source_id, agent, model, calls, cache_read) VALUES(20260802, ?1, 'codex', 'gpt-6-sol', 1, 5000)", [own]).unwrap();
        assert_eq!(recovered(&fixture).0.len(), 1);
        fixture.db.execute("INSERT INTO token_days(day, source_id, agent, model, calls, cache_read) VALUES(20260802, ?1, 'claude', 'claude-opus-5-5', 1, 4000)", [own]).unwrap();
        let (days, overlap) = recovered(&fixture);
        assert!(days.is_empty());
        assert_eq!(overlap, RecoveredOverlap { claude_code: 9_000, transcripts: 4_000 });
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn a_copy_that_is_not_claude_codes_stats_gives_nothing() {
        let mut machine = Machine::default();
        machine.add(b"{\"dailyModelTokens\":[{\"date\":\"2026-08-02\",\"tokensByModel\":{\"claude-opus-5-5\":9");
        machine.add(b"[1,2,3]");
        machine.add(b"{\"dailyModelTokens\":\"soon\"}");
        assert!(machine.tokens.is_empty() && machine.sessions.is_empty());
        machine.add(b"{\"dailyActivity\":[{\"date\":\"2026-08-02\",\"sessionCount\":2}]}");
        assert_eq!(machine.sessions.get(&20260802), Some(&2));
    }

    #[test]
    fn recovering_keeps_only_days_models_and_numbers() {
        let fixture = Fixture::new("recovered-secret");
        fixture.write(".claude/stats-cache.json", &stats(&[("2026-08-02", &[("claude-opus-5-5", 9_000)], 2)]));
        fixture.pass();
        count_pass(&fixture.db, &fixture.places, &everything(), &|| false).unwrap();
        assert_eq!(recovered(&fixture).0.len(), 1);
        let secret = SECRET_TEXT.as_bytes();
        let contains = |bytes: &[u8]| bytes.windows(secret.len()).any(|window| window == secret) || bytes.windows(SID.len()).any(|window| window == SID.as_bytes());
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
        assert!(!json.contains(SECRET_TEXT) && !json.contains(SID), "{json}");
        let _ = fs::remove_dir_all(&fixture.base);
    }
}

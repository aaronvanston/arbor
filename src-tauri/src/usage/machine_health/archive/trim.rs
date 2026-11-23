//! Trimming local session history once the archive holds it.
//!
//! Claude Code deletes a home's sessions nobody has touched for cleanupPeriodDays each time it starts. Keeping
//! sessions sets that to a hundred years, so a machine's homes only grow. With trimming on (Settings › Session
//! Archive, off by default), Arbor sets each Claude Code home it keeps to the chosen days, but only while it can
//! confirm the archive holds every file Claude Code could delete within [`MARGIN_DAYS`]: the machine's last pass
//! finished without a failure within [`FRESH_RUN_MS`], and every file the archive lists there whose last change is
//! older than the days less the margin is safely in a store. Whenever that isn't so, the home goes back to keeping
//! everything. Arbor never deletes a session itself; Claude Code does, by its own rule.
//!
//! Only a home Arbor manages is changed: one that doesn't set the days, keeps sessions for years, or holds the days
//! Arbor last set there (`sources.trim_days`). A home set to its own number by hand is left as it is, and said so.
//! Turning trimming off puts each home Arbor trimmed back to keeping everything.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use ts_rs::TS;

/// What keeping every session sets cleanupPeriodDays to: about a hundred years.
pub(crate) const KEEP_DAYS: u32 = 36_500;
/// A home set to at least this many days keeps its sessions, and the Setup page's check says nothing of it.
pub(crate) const KEEP_AT_LEAST_DAYS: u32 = 3_650;
/// How far ahead the archive must hold what Claude Code could delete: a week in which Arbor can't reach a machine
/// still loses nothing it hasn't kept.
pub(crate) const MARGIN_DAYS: u32 = 7;
/// The days a home can be trimmed to.
pub(crate) const TRIM_DAYS_RANGE: std::ops::RangeInclusive<u32> = 14..=365;
/// A machine's last finished pass must be this recent for its homes to stay trimmed. Every file old enough to matter
/// was listed by a pass this recent.
pub(crate) const FRESH_RUN_MS: i64 = 24 * 60 * 60 * 1000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Where a Claude Code home stands with trimming on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(rename = "ArchiveHomeTrim")]
pub(crate) enum HomeTrim {
    /// Claude Code deletes its sessions after these days, and the archive holds every one old enough to go.
    Trimmed { days: u32 },
    /// It keeps everything until the archive holds these files, which are old enough to be deleted soon.
    Waiting { unkept: u64 },
    /// The machine's sessions haven't been kept lately (it's left out, the archive is paused, or its last pass
    /// failed or is a day old), so it keeps everything.
    Unconfirmed,
    /// It sets its own days, which Arbor leaves alone.
    ByHand { days: u32 },
}

/// What Arbor writes to a home's cleanupPeriodDays.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Want {
    Trim(u32),
    Keep,
}

impl Want {
    pub(crate) fn days(self) -> u32 {
        match self {
            Self::Trim(days) => days,
            Self::Keep => KEEP_DAYS,
        }
    }
}

/// A Claude Code home as the archive knows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Home {
    pub(crate) source_id: i64,
    pub(crate) machine: String,
    /// With the machine's home as `~`, as the setup scan names it.
    pub(crate) label: String,
    /// cleanupPeriodDays as the last listing read it.
    pub(crate) retention: Option<u32>,
    /// The days Arbor last trimmed it to.
    pub(crate) trimmed: Option<u32>,
}

impl Home {
    /// Whether Arbor may change its days: it doesn't set them, keeps sessions for years, or has the days Arbor set.
    pub(crate) fn managed(&self) -> bool {
        self.retention.is_none_or(|days| days >= KEEP_AT_LEAST_DAYS || Some(days) == self.trimmed)
    }
}

/// How a machine's sessions are being kept, for its homes' trimming.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MachineKept {
    /// Its last pass finished, without a failure, recently enough, and the archive keeps it.
    pub(crate) confirmed: bool,
    /// Its last pass reached it, so a write there is worth trying.
    pub(crate) reachable: bool,
}

/// A home's standing and what, if anything, to write there. `trim_days` is the setting, None when it's off;
/// `unkept` is how many of its files old enough to matter aren't safely kept.
pub(crate) fn plan(home: &Home, trim_days: Option<u32>, kept: MachineKept, unkept: u64) -> (Option<HomeTrim>, Option<Want>) {
    let ours = home.trimmed.is_some() && home.retention == home.trimmed;
    let Some(days) = trim_days else {
        // Off: what Arbor trimmed goes back to keeping everything.
        return (None, (ours && kept.reachable).then_some(Want::Keep));
    };
    if !home.managed() {
        return (home.retention.map(|days| HomeTrim::ByHand { days }), None);
    }
    // A home that would delete sessions now (Claude Code's own 30 days when it says nothing, or Arbor's days) is set
    // back to keeping everything while the archive can't vouch for it.
    let deletes = home.retention.is_none_or(|days| days < KEEP_AT_LEAST_DAYS);
    if !kept.confirmed {
        return (Some(HomeTrim::Unconfirmed), (deletes && kept.reachable).then_some(Want::Keep));
    }
    if unkept > 0 {
        return (Some(HomeTrim::Waiting { unkept }), deletes.then_some(Want::Keep));
    }
    (Some(HomeTrim::Trimmed { days }), (home.retention != Some(days)).then_some(Want::Trim(days)))
}

fn db_error(error: rusqlite::Error) -> String {
    format!("The archive index failed: {error}")
}

/// Every Claude Code home the archive lists.
pub(crate) fn homes(db: &Connection) -> Result<Vec<Home>, String> {
    let mut statement = db
        .prepare("SELECT source_id, machine, label, retention_days, trim_days FROM sources WHERE kind = 'home' AND agent = 'claude' ORDER BY machine, label")
        .map_err(db_error)?;
    let days = |value: Option<i64>| value.and_then(|days| u32::try_from(days).ok());
    let rows = statement
        .query_map([], |row| {
            Ok(Home { source_id: row.get(0)?, machine: row.get(1)?, label: row.get(2)?, retention: days(row.get(3)?), trimmed: days(row.get(4)?) })
        })
        .map_err(db_error)?;
    rows.collect::<Result<_, _>>().map_err(db_error)
}

/// How a machine's last pass went, for trimming: whether it finished without a failure since `fresh_after`, and
/// whether it reached the machine at all.
pub(crate) fn machine_kept(db: &Connection, machine: &str, kept_by_archive: bool, fresh_after: i64) -> Result<MachineKept, String> {
    let last: Option<(i64, Option<i64>, Option<String>)> = db
        .query_row(
            "SELECT COALESCE(finished_at, started_at), complete, error FROM runs WHERE machine = ?1 ORDER BY run_id DESC LIMIT 1",
            [machine],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(db_error)?;
    let Some((at, complete, error)) = last else {
        return Ok(MachineKept { confirmed: false, reachable: false });
    };
    let reachable = error.is_none();
    Ok(MachineKept { confirmed: kept_by_archive && reachable && complete == Some(1) && at >= fresh_after, reachable })
}

/// The files of a home whose last change is before `before_ms` that aren't safely kept: still there, in a version
/// that has settled into the store. A file never stat'ed counts as old.
pub(crate) fn unkept_before(db: &Connection, source_id: i64, before_ms: i64) -> Result<u64, String> {
    let before_ns = before_ms.saturating_mul(1_000_000);
    db.query_row(
        "SELECT COUNT(*) FROM files f LEFT JOIN versions v ON v.version_id = f.version_id
         WHERE f.source_id = ?1 AND f.state != 'gone' AND (f.mtime_ns IS NULL OR f.mtime_ns < ?2)
           AND NOT (f.state = 'live' AND f.version_id IS NOT NULL AND v.state = 'settled')",
        params![source_id, before_ns],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count.max(0) as u64)
    .map_err(db_error)
}

/// The last change before which every file must be kept for a home to be trimmed to `days` at `now_ms`.
pub(crate) fn must_be_kept_before(days: u32, now_ms: i64) -> i64 {
    now_ms - i64::from(days.saturating_sub(MARGIN_DAYS)) * DAY_MS
}

/// Notes the days Arbor set in a home, or that it set it back to keeping everything.
pub(crate) fn note_written(db: &Connection, source_id: i64, want: Want) -> Result<(), String> {
    let trimmed = match want {
        Want::Trim(days) => Some(i64::from(days)),
        Want::Keep => None,
    };
    let _writes = super::index::lock_writes();
    db.execute("UPDATE sources SET trim_days = ?2 WHERE source_id = ?1", params![source_id, trimmed]).map(|_| ()).map_err(db_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::machine_health::archive::index;

    const SECRET: &str = "sk-trim-SECRET-do-not-leak";
    const DAY: i64 = DAY_MS;
    const OK: MachineKept = MachineKept { confirmed: true, reachable: true };

    fn home(retention: Option<u32>, trimmed: Option<u32>) -> Home {
        Home { source_id: 1, machine: "cam-mbp".into(), label: "~/.claude".into(), retention, trimmed }
    }

    #[test]
    fn a_home_is_trimmed_only_once_everything_old_enough_to_go_is_kept() {
        // Keeping everything, all kept: trimmed to the setting.
        assert_eq!(plan(&home(Some(36_500), None), Some(30), OK, 0), (Some(HomeTrim::Trimmed { days: 30 }), Some(Want::Trim(30))));
        // Saying nothing, Claude Code's own 30 days: Arbor says the days itself.
        assert_eq!(plan(&home(None, None), Some(30), OK, 0).1, Some(Want::Trim(30)));
        // Already trimmed: nothing to write.
        assert_eq!(plan(&home(Some(30), Some(30)), Some(30), OK, 0), (Some(HomeTrim::Trimmed { days: 30 }), None));
        // A new setting moves a home Arbor trimmed.
        assert_eq!(plan(&home(Some(30), Some(30)), Some(60), OK, 0).1, Some(Want::Trim(60)));
    }

    #[test]
    fn a_home_keeps_everything_while_the_archive_cant_vouch_for_it() {
        // Files old enough to go aren't kept yet: a trimmed home goes back to keeping everything, one keeping stays.
        assert_eq!(plan(&home(Some(30), Some(30)), Some(30), OK, 3), (Some(HomeTrim::Waiting { unkept: 3 }), Some(Want::Keep)));
        assert_eq!(plan(&home(Some(36_500), None), Some(30), OK, 3), (Some(HomeTrim::Waiting { unkept: 3 }), None));
        assert_eq!(plan(&home(None, None), Some(30), OK, 3).1, Some(Want::Keep), "Claude Code's own 30 days would delete them");
        // A machine whose last pass is old or failed, or that's left out, isn't confirmed.
        let stale = MachineKept { confirmed: false, reachable: true };
        assert_eq!(plan(&home(Some(30), Some(30)), Some(30), stale, 0), (Some(HomeTrim::Unconfirmed), Some(Want::Keep)));
        // One that can't be reached can't be written to.
        let away = MachineKept { confirmed: false, reachable: false };
        assert_eq!(plan(&home(Some(30), Some(30)), Some(30), away, 0), (Some(HomeTrim::Unconfirmed), None));
    }

    #[test]
    fn a_home_set_by_hand_is_left_alone_and_turning_trimming_off_undoes_only_arbors() {
        assert_eq!(plan(&home(Some(90), None), Some(30), OK, 0), (Some(HomeTrim::ByHand { days: 90 }), None));
        // Arbor trimmed it to 30, then someone set 45: theirs now.
        assert_eq!(plan(&home(Some(45), Some(30)), Some(30), OK, 0), (Some(HomeTrim::ByHand { days: 45 }), None));
        // Off: Arbor's own goes back to keeping everything; nothing else is touched or said.
        assert_eq!(plan(&home(Some(30), Some(30)), None, OK, 0), (None, Some(Want::Keep)));
        assert_eq!(plan(&home(Some(36_500), None), None, OK, 0), (None, None));
        assert_eq!(plan(&home(Some(90), None), None, OK, 0), (None, None));
        assert_eq!(plan(&home(None, None), None, OK, 0), (None, None));
        assert_eq!(plan(&home(Some(30), Some(30)), None, MachineKept { confirmed: false, reachable: false }, 0), (None, None));
    }

    #[test]
    fn the_margin_is_a_week_ahead_of_the_days() {
        assert_eq!(must_be_kept_before(30, 100 * DAY), 77 * DAY);
        assert_eq!(must_be_kept_before(5, 100 * DAY), 100 * DAY, "fewer days than the margin: everything must be kept");
    }

    fn fixture() -> Connection {
        let db = index::memory();
        let ns = |days: i64| days * DAY * 1_000_000;
        db.execute_batch(&format!(
            "INSERT INTO sources(source_id, machine, kind, agent, root, label, retention_days, trim_days, first_seen_at) VALUES
               (1, 'cam-mbp', 'home', 'claude', '/Users/cam/.claude', '~/.claude', 30, 30, 0),
               (2, 'cam-mbp', 'home', 'codex', '/Users/cam/.codex', '~/.codex', NULL, NULL, 0),
               (3, 'ci-01', 'home', 'claude', '/home/ci/.claude', '~/.claude', 36500, NULL, 0);
             INSERT INTO sessions(session_pk, agent, session_id, first_seen_at) VALUES(1, 'claude', 's', 0);
             INSERT INTO members(member_id, session_pk, member) VALUES(1, 1, 'main');
             INSERT INTO versions(version_id, vk, member_id, state, size, created_at) VALUES
               (1, 'a', 1, 'settled', 10, 0), (2, 'b', 1, 'growing', 10, 0), (3, 'c', 1, 'lost-tail', 10, 0);
             INSERT INTO files(source_id, rel_path, version_id, state, mtime_ns, first_seen_at, last_seen_at) VALUES
               (1, 'projects/-src-{SECRET}/old-kept.jsonl', 1, 'live', {old}, 0, 0),
               (1, 'projects/-src/old-growing.jsonl', 2, 'live', {old}, 0, 0),
               (1, 'projects/-src/old-lost.jsonl', 3, 'live', {old}, 0, 0),
               (1, 'projects/-src/old-never.jsonl', NULL, 'live', {old}, 0, 0),
               (1, 'projects/-src/no-time.jsonl', NULL, 'live', NULL, 0, 0),
               (1, 'projects/-src/old-gone.jsonl', NULL, 'gone', {old}, 0, 0),
               (1, 'projects/-src/new.jsonl', NULL, 'live', {new}, 0, 0);
             INSERT INTO runs(machine, started_at, finished_at, complete, error) VALUES
               ('cam-mbp', 100, 150, 1, NULL), ('ci-01', 100, 150, 1, NULL), ('ci-01', 200, 250, 0, 'Timed out after 120s');",
            old = ns(60),
            new = ns(95),
        ))
        .unwrap();
        db
    }

    #[test]
    fn only_settled_files_still_there_count_as_kept_and_a_new_one_doesnt_matter_yet() {
        let db = fixture();
        // Growing, lost-tail, never kept and never stat'ed aren't kept; gone and new ones don't count.
        // Trimmed to 30 days on day 100, every file last changed before day 77 must be kept.
        assert_eq!(unkept_before(&db, 1, must_be_kept_before(30, 100 * DAY)).unwrap(), 4);
        // Trimmed to 60, only the file with no time is old enough to matter.
        assert_eq!(unkept_before(&db, 1, must_be_kept_before(60, 100 * DAY)).unwrap(), 1);
        let homes = homes(&db).unwrap();
        assert_eq!(homes.iter().map(|home| (home.machine.as_str(), home.retention, home.trimmed)).collect::<Vec<_>>(), [("cam-mbp", Some(30), Some(30)), ("ci-01", Some(36_500), None)]);
        assert!(!format!("{homes:?}").contains(SECRET));
    }

    #[test]
    fn a_machine_is_confirmed_by_a_recent_finished_pass_without_a_failure() {
        let db = fixture();
        assert_eq!(machine_kept(&db, "cam-mbp", true, 100).unwrap(), MachineKept { confirmed: true, reachable: true });
        assert_eq!(machine_kept(&db, "cam-mbp", true, 200).unwrap().confirmed, false, "too old");
        assert_eq!(machine_kept(&db, "cam-mbp", false, 100).unwrap().confirmed, false, "left out");
        assert_eq!(machine_kept(&db, "ci-01", true, 0).unwrap(), MachineKept { confirmed: false, reachable: false }, "its last pass failed");
        assert_eq!(machine_kept(&db, "cedar-02", true, 0).unwrap(), MachineKept { confirmed: false, reachable: false });
        note_written(&db, 3, Want::Trim(30)).unwrap();
        note_written(&db, 1, Want::Keep).unwrap();
        let trimmed: Vec<Option<u32>> = homes(&db).unwrap().iter().map(|home| home.trimmed).collect();
        assert_eq!(trimmed, [None, Some(30)]);
    }
}

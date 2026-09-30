//! One pass over a machine's listing: every session file that changed is
//! sorted into its versions, files missing from two whole listings in a row
//! are marked gone, and versions that stopped growing are settled.
//!
//! Reads are paced so a pass never hogs the disk, and a pass stops between
//! files once it has read its share, leaving the rest for a catch-up pass.

use super::classify::{self, Blobs, Cx, Limits, Seen, Source, Target, CHANGED};
use super::codec;
use super::identity::{self, MemberKey};
use super::index::{get_meta, lock_writes, set_meta};
use super::journal::emit;
use super::lister::{allowed, ListedFile, ListedRoot, Listing};
use super::super::archive::SessionFilter;
use super::store::{drop_pending_in, write_atomic, ChunkMeta, NewChunk, Store};
use super::tokens::{pieces, read_piece};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// A version that hasn't grown for this long is settled.
const SETTLE_AFTER_MS: i64 = DAY_MS;
/// Growing tails are kept on this Mac's disk; past this much in all, the oldest settle.
const PENDING_MAX: i64 = 256 << 20;
/// A file is at risk this long before its home's cleanup would delete it.
const AT_RISK_DAYS: i64 = 7;
/// Homes that keep sessions at least this long aren't treated as deleting them.
const LONG_RETENTION_DAYS: i64 = 3_650;
/// What Claude Code keeps sessions for when a home doesn't say.
const CLAUDE_DEFAULT_RETENTION_DAYS: i64 = 30;

/// Chunks go to the store, and growing tails to this Mac's disk with a copy in the store.
pub(crate) struct Places {
    pub(crate) store: Store,
    pub(crate) pending_dir: PathBuf,
}

impl Places {
    fn pending_path(&self, vk: &str, gen: i64) -> PathBuf {
        self.pending_dir.join(format!("{vk}.{gen}.zst"))
    }
}

impl Blobs for Places {
    fn store_id(&self) -> &str {
        &self.store.info().store_id
    }

    fn put_chunks(&self, chunks: &[NewChunk<'_>]) -> Result<Vec<ChunkMeta>, String> {
        self.store.put_chunks(chunks)
    }

    fn read_chunk(&self, hash: &[u8; 32]) -> Result<Vec<u8>, String> {
        self.store.read_chunk(hash)
    }

    fn put_pending(&self, vk: &str, gen: i64, tail: &[u8]) -> Result<(), String> {
        let frame = codec::encode(tail)?;
        write_atomic(&self.pending_path(vk, gen), &frame)?;
        self.store.put_pending(vk, gen, &frame)
    }

    fn read_pending(&self, vk: &str, gen: i64) -> Result<Vec<u8>, String> {
        match std::fs::read(self.pending_path(vk, gen)).map_err(|error| error.to_string()).and_then(|frame| codec::decode(&frame)) {
            Ok(bytes) => Ok(bytes),
            Err(_) => self.store.read_pending(vk, gen),
        }
    }

    fn drop_pending(&self, vk: &str, keep: Option<i64>) {
        drop_pending_in(&self.pending_dir, vk, keep);
        self.store.drop_pending(vk, keep);
    }
}

/// Paces reads to a number of bytes a second, across every file in a pass.
pub(crate) struct Throttle {
    bytes_per_second: u64,
    started: Instant,
    bytes: u64,
}

impl Throttle {
    pub(crate) fn new(bytes_per_second: u64) -> Self {
        Throttle { bytes_per_second: bytes_per_second.max(1), started: Instant::now(), bytes: 0 }
    }

    pub(crate) fn take(&mut self, bytes: u64) {
        self.bytes += bytes;
        let due = Duration::from_secs_f64(self.bytes as f64 / self.bytes_per_second as f64);
        if let Some(wait) = due.checked_sub(self.started.elapsed()) {
            std::thread::sleep(wait);
        }
    }
}

/// A pass found a file gone when it came to read it. It isn't a failure: a later listing
/// without it marks it gone.
pub(crate) const GONE: &str = "The file was gone when it was read.";

/// Where a pass reads the files its listing names: this Mac's disk, or another machine's
/// over SSH (see `remote`). Reads are paced by the reader.
pub(crate) trait Files {
    /// What a listed file is like now, or None when it isn't there.
    fn stat(&mut self, path: &Path, listed: &ListedFile) -> Option<Seen>;
    /// The files the pass will read, in the order it reads them, before it reads any.
    fn plan(&mut self, _files: &[(PathBuf, u64)]) {}
    /// Gets a file ready to be read, `size` bytes of it: CHANGED or GONE when it can't be.
    fn ready(&mut self, _path: &Path, _size: u64) -> Result<(), String> {
        Ok(())
    }
    /// The start of a file, decompressed for a .zst, for reading the ids at its top.
    fn head(&mut self, path: &Path, size: u64) -> Option<Vec<u8>>;
    /// The file's first `size` bytes, read by position.
    fn open(&mut self, path: &Path, size: u64) -> Result<Box<dyn Source + '_>, String>;
    /// The machine stopped answering, so every file after would fail the same way.
    fn lost(&self) -> bool {
        false
    }
}

/// This Mac's disk.
pub(crate) struct LocalFiles {
    throttle: Throttle,
}

impl LocalFiles {
    pub(crate) fn new(bytes_per_second: u64) -> Self {
        LocalFiles { throttle: Throttle::new(bytes_per_second) }
    }
}

impl Files for LocalFiles {
    fn stat(&mut self, path: &Path, _listed: &ListedFile) -> Option<Seen> {
        stat(path)
    }

    fn head(&mut self, path: &Path, _size: u64) -> Option<Vec<u8>> {
        head(path)
    }

    fn open(&mut self, path: &Path, _size: u64) -> Result<Box<dyn Source + '_>, String> {
        let file = File::open(path).map_err(|error| format!("Couldn't open a session file: {error}"))?;
        Ok(Box::new(LocalFile { file, throttle: &mut self.throttle }))
    }
}

struct LocalFile<'a> {
    file: File,
    throttle: &'a mut Throttle,
}

impl Source for LocalFile<'_> {
    fn read_exact_at(&mut self, off: u64, buf: &mut [u8]) -> Result<(), String> {
        use std::os::unix::fs::FileExt;
        self.throttle.take(buf.len() as u64);
        self.file.read_exact_at(buf, off).map_err(|error| if error.kind() == std::io::ErrorKind::UnexpectedEof { CHANGED.to_string() } else { format!("Couldn't read a session file: {error}") })
    }
}

pub(crate) struct PassOptions {
    pub(crate) machine: String,
    pub(crate) user_home: Option<String>,
    pub(crate) limits: Limits,
    pub(crate) bytes_per_second: u64,
    /// A pass stops between files once it has read this much, or run this long.
    pub(crate) max_bytes: u64,
    pub(crate) max_time: Duration,
    /// The homes are in an old backup (see `imports`): nothing in one grows or is cleaned up.
    pub(crate) import: bool,
    /// Which sessions are kept, by the projects the user chose; a file left out isn't read,
    /// fetched or noted as changed, so it's taken as soon as its session is kept again.
    pub(crate) sessions: SessionFilter,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PassReport {
    /// Every changed file was read.
    pub(crate) complete: bool,
    pub(crate) files_listed: u64,
    /// Files of sessions whose project isn't kept.
    pub(crate) files_left_out: u64,
    pub(crate) files_changed: u64,
    pub(crate) bytes_read: u64,
    pub(crate) bytes_new: u64,
    pub(crate) failures: u64,
    pub(crate) first_failure: Option<String>,
    /// Token counting stopped at its share, with kept transcripts still to count.
    pub(crate) counting_left: bool,
    /// An old backup's import stopped at its share, with more of it to keep.
    pub(crate) imports_left: bool,
    /// Another machine's pass stopped at its share, with more of that machine to keep.
    pub(crate) fleet_left: bool,
    /// The machine stopped answering partway, and the rest was left for another pass.
    pub(crate) lost: bool,
}

fn db_error(error: rusqlite::Error) -> String {
    format!("The archive index failed: {error}")
}

fn ensure_source(db: &Connection, machine: &str, root: &ListedRoot, label: &str, kind: &str, now: i64) -> Result<i64, String> {
    let _writes = lock_writes();
    let existing: Option<i64> = db.query_row("SELECT source_id FROM sources WHERE machine = ?1 AND root = ?2", params![machine, root.home], |row| row.get(0)).optional().map_err(db_error)?;
    if let Some(source_id) = existing {
        db.execute("UPDATE sources SET last_seen_at = ?2, retention_days = ?3, agent = ?4 WHERE source_id = ?1", params![source_id, now, root.retention_days, root.agent]).map_err(db_error)?;
        return Ok(source_id);
    }
    let transaction = db.unchecked_transaction().map_err(db_error)?;
    transaction
        .execute(
            "INSERT INTO sources(machine, kind, agent, root, label, retention_days, first_seen_at, last_seen_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![machine, kind, root.agent, root.home, label, root.retention_days, now],
        )
        .map_err(db_error)?;
    let source_id = transaction.last_insert_rowid();
    emit(&transaction, json!({"t": "source", "id": source_id, "machine": machine, "kind": kind, "agent": root.agent, "root": root.home, "label": label}))?;
    transaction.commit().map_err(db_error)?;
    Ok(source_id)
}

pub(crate) fn ensure_member(db: &Connection, key: &MemberKey, now: i64) -> Result<i64, String> {
    let transaction = db.unchecked_transaction().map_err(db_error)?;
    let session: Option<i64> = transaction.query_row("SELECT session_pk FROM sessions WHERE agent = ?1 AND session_id = ?2", params![key.agent, key.session_id], |row| row.get(0)).optional().map_err(db_error)?;
    let session_pk = match session {
        Some(pk) => pk,
        None => {
            transaction
                .execute("INSERT INTO sessions(agent, session_id, project_key, first_seen_at) VALUES(?1, ?2, ?3, ?4)", params![key.agent, key.session_id, key.project_key, now])
                .map_err(db_error)?;
            let pk = transaction.last_insert_rowid();
            emit(&transaction, json!({"t": "session", "pk": pk, "agent": key.agent, "id": key.session_id, "project": key.project_key}))?;
            pk
        }
    };
    let member: Option<i64> = transaction.query_row("SELECT member_id FROM members WHERE session_pk = ?1 AND member = ?2", params![session_pk, key.member], |row| row.get(0)).optional().map_err(db_error)?;
    let member_id = match member {
        Some(id) => id,
        None => {
            transaction.execute("INSERT INTO members(session_pk, member) VALUES(?1, ?2)", params![session_pk, key.member]).map_err(db_error)?;
            let id = transaction.last_insert_rowid();
            emit(&transaction, json!({"t": "member", "id": id, "session": session_pk, "member": key.member}))?;
            id
        }
    };
    transaction.commit().map_err(db_error)?;
    Ok(member_id)
}

/// A zstd frame whose first this many bytes give up no first line is left to its file name.
const KEPT_HEAD_MAX: usize = 16 << 20;

/// Files kept as a home's own that the naming rules now give to a session move to it: each such
/// member's versions go to the member resolving its path gives now, to be read the way that
/// member's files are. Their bytes stay where they are. Done once for each `identity::RULE`, and
/// only Codex homes are looked at, as only their naming has changed. Returns how many moved.
pub(crate) fn refile(db: &Connection, blobs: &dyn Blobs, throttle: &mut Throttle) -> Result<u64, String> {
    if get_meta(db, "identityRule")?.as_deref() == Some(identity::RULE) {
        return Ok(0);
    }
    let found: Vec<(i64, String, String, String, i64)> = {
        let mut statement = db
            .prepare(
                "SELECT kept.member_id, kept.member, src.machine, src.label, kept.first FROM (
                   SELECT m.member_id, m.member,
                     (SELECT f.source_id FROM versions v JOIN observations o USING (version_id) JOIN files f USING (file_id)
                        WHERE v.member_id = m.member_id ORDER BY o.first_at, o.file_id LIMIT 1) AS source_id,
                     (SELECT MIN(v.version_id) FROM versions v WHERE v.member_id = m.member_id) AS first
                   FROM members m JOIN sessions s USING (session_pk) WHERE s.agent = 'side' AND m.member LIKE 'files/%') AS kept
                 JOIN sources src USING (source_id) WHERE src.agent = 'codex' ORDER BY kept.member_id",
            )
            .map_err(db_error)?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).map_err(db_error)?;
        rows.collect::<Result<_, _>>().map_err(db_error)?
    };
    let mut moved = 0;
    for (member_id, member, machine, label, first) in found {
        let Some(rel_path) = member.strip_prefix("files/") else {
            continue;
        };
        // A store that can't be read is tried again next pass, rather than filing by the name alone.
        let mut failed = None;
        let key = identity::resolve("codex", &machine, &label, rel_path, || {
            kept_head(db, blobs, first, rel_path.ends_with(".zst"), throttle).unwrap_or_else(|error| {
                failed = Some(error);
                None
            })
        });
        if let Some(error) = failed {
            return Err(error);
        }
        let Some(key) = key.filter(|key| key.agent != "side") else {
            continue;
        };
        let _writes = lock_writes();
        let to = ensure_member(db, &key, super::index::now_ms())?;
        let transaction = db.unchecked_transaction().map_err(db_error)?;
        transaction
            .execute(
                "UPDATE versions SET member_id = ?2, encoding = ?3, has_ordinal = COALESCE(has_ordinal, ?4) WHERE member_id = ?1",
                params![member_id, to, key.encoding, key.has_ordinal],
            )
            .map_err(db_error)?;
        transaction.execute("UPDATE files SET member_id = ?2 WHERE member_id = ?1", params![member_id, to]).map_err(db_error)?;
        transaction.execute("DELETE FROM members WHERE member_id = ?1", [member_id]).map_err(db_error)?;
        emit(&transaction, json!({"t": "refile", "member": member_id, "to": to, "encoding": key.encoding}))?;
        transaction.commit().map_err(db_error)?;
        moved += 1;
    }
    let _writes = lock_writes();
    set_meta(db, "identityRule", identity::RULE)?;
    Ok(moved)
}

/// The start of a kept version, decompressed for a .zst, as `head` reads a file's: None when it
/// won't decompress.
fn kept_head(db: &Connection, blobs: &dyn Blobs, version_id: i64, zst: bool, throttle: &mut Throttle) -> Result<Option<Vec<u8>>, String> {
    let version = classify::load_version(db, version_id)?;
    let mut bytes = Vec::new();
    for piece in pieces(&version, 0) {
        bytes.extend_from_slice(&read_piece(blobs, &version, &piece, throttle)?);
        if !zst && bytes.len() >= identity::HEAD_LIMIT {
            break;
        }
        // Part of a frame decompresses once it holds as much as is wanted.
        if zst {
            if let Ok(head) = codec::decode_head(&bytes[..], identity::HEAD_LIMIT) {
                return Ok(Some(head));
            }
            if bytes.len() >= KEPT_HEAD_MAX {
                return Ok(None);
            }
        }
    }
    if zst {
        return Ok(None);
    }
    bytes.truncate(identity::HEAD_LIMIT);
    Ok(Some(bytes))
}

/// A file to read this pass.
struct Work {
    file_id: i64,
    rel_path: String,
    path: PathBuf,
    seen: Seen,
    agent: String,
    label: String,
    at_risk: bool,
    never: bool,
}

fn stat(path: &Path) -> Option<Seen> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path).ok()?;
    meta.is_file().then(|| Seen {
        dev: meta.dev(),
        ino: meta.ino(),
        size: meta.len(),
        mtime_ns: meta.mtime().saturating_mul(1_000_000_000).saturating_add(meta.mtime_nsec()),
        ctime_ns: meta.ctime().saturating_mul(1_000_000_000).saturating_add(meta.ctime_nsec()),
    })
}

/// The start of a file, decompressed for a .zst, for reading the ids at its top.
fn head(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let file = File::open(path).ok()?;
    if path.extension().is_some_and(|ext| ext == "zst") {
        return codec::decode_head(file, identity::HEAD_LIMIT).ok();
    }
    let mut out = Vec::new();
    file.take(identity::HEAD_LIMIT as u64).read_to_end(&mut out).ok()?;
    Some(out)
}

/// Runs one pass of this Mac's listing. `stop` is asked between files.
pub(crate) fn run_pass(db: &Connection, places: &Places, listing: &Listing, options: &PassOptions, stop: &dyn Fn() -> bool) -> Result<PassReport, String> {
    run_pass_from(db, places, listing, options, &mut LocalFiles::new(options.bytes_per_second), stop)
}

/// Runs one pass of a machine's listing, reading its files from `files`.
pub(crate) fn run_pass_from(db: &Connection, places: &Places, listing: &Listing, options: &PassOptions, files: &mut dyn Files, stop: &dyn Fn() -> bool) -> Result<PassReport, String> {
    let started = Instant::now();
    let now = super::index::now_ms();
    let mut report = PassReport { complete: true, ..PassReport::default() };
    let mut work: Vec<Work> = Vec::new();
    let mut complete_sources: Vec<i64> = Vec::new();
    for root in &listing.roots {
        let label = identity::home_label(&root.home, options.user_home.as_deref());
        let source_id = ensure_source(db, &options.machine, root, &label, if options.import { "import" } else { "home" }, now)?;
        // A backup is listed until it's all kept, and never again after, so nothing in it is ever gone.
        if root.complete && listing.ended && !options.import {
            complete_sources.push(source_id);
        }
        let _writes = lock_writes();
        let transaction = db.unchecked_transaction().map_err(db_error)?;
        for dangling in &root.dangling {
            transaction.execute("UPDATE files SET state = 'unreachable', last_seen_at = ?3, missing_lists = 0 WHERE source_id = ?1 AND rel_path = ?2", params![source_id, dangling, now]).map_err(db_error)?;
        }
        for file in root.files.iter().filter(|file| allowed(&root.agent, &file.rel_path)) {
            report.files_listed += 1;
            let row: (i64, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, String) = transaction
                .query_row(
                    "INSERT INTO files(source_id, rel_path, via_link, first_seen_at, last_seen_at) VALUES(?1, ?2, ?3, ?4, ?4)
                     ON CONFLICT(source_id, rel_path) DO UPDATE SET via_link = excluded.via_link, last_seen_at = excluded.last_seen_at, missing_lists = 0,
                       state = CASE WHEN files.state = 'skipped' THEN 'skipped' ELSE 'live' END, gone_at = NULL
                     RETURNING file_id, version_id, dev, ino, size, mtime_ns, ctime_ns, state",
                    params![source_id, file.rel_path, file.via_link, now],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
                )
                .map_err(db_error)?;
            let (file_id, version_id, dev, ino, size, mtime_ns, ctime_ns, state) = row;
            if state == "skipped" {
                continue;
            }
            // Still seen, so it isn't taken for gone, but not read.
            if !options.sessions.keeps(identity::session_hint(&root.agent, &file.rel_path).as_deref()) {
                report.files_left_out += 1;
                continue;
            }
            let path = Path::new(&root.home).join(&file.rel_path);
            let Some(seen) = files.stat(&path, file) else {
                continue;
            };
            if version_id.is_some() && (dev, ino, size, mtime_ns, ctime_ns) == (Some(seen.dev as i64), Some(seen.ino as i64), Some(seen.size as i64), Some(seen.mtime_ns), Some(seen.ctime_ns)) {
                continue;
            }
            let retention = root.retention_days.map(i64::from).or((root.agent == "claude").then_some(CLAUDE_DEFAULT_RETENTION_DAYS)).filter(|_| !options.import);
            let at_risk_at = retention.filter(|days| *days < LONG_RETENTION_DAYS).map(|days| seen.mtime_ns / 1_000_000 + (days - AT_RISK_DAYS) * DAY_MS);
            transaction.execute("UPDATE files SET at_risk_at = ?2 WHERE file_id = ?1", params![file_id, at_risk_at]).map_err(db_error)?;
            work.push(Work {
                file_id,
                rel_path: file.rel_path.clone(),
                path,
                seen,
                agent: root.agent.clone(),
                label: label.clone(),
                at_risk: at_risk_at.is_some_and(|at| at <= now),
                never: version_id.is_none(),
            });
        }
        transaction.commit().map_err(db_error)?;
    }

    // Files about to be cleaned up first, then ones never kept (oldest first), then the rest.
    work.sort_by(|a, b| b.at_risk.cmp(&a.at_risk).then(b.never.cmp(&a.never)).then(a.seen.mtime_ns.cmp(&b.seen.mtime_ns)));
    files.plan(&work.iter().map(|item| (item.path.clone(), item.seen.size)).collect::<Vec<_>>());
    for item in work {
        if stop() || report.bytes_read >= options.max_bytes || started.elapsed() >= options.max_time {
            report.complete = false;
            break;
        }
        report.files_changed += 1;
        match take_file(db, places, options, &item, files, now) {
            Ok(observed) => {
                report.bytes_read += observed.bytes_read;
                report.bytes_new += observed.bytes_new;
            }
            // Read again next pass.
            Err(error) if error == CHANGED => report.complete = false,
            Err(error) if error == GONE => {}
            Err(error) => {
                report.failures += 1;
                report.first_failure.get_or_insert(error);
                if files.lost() {
                    report.complete = false;
                    report.lost = true;
                    break;
                }
            }
        }
    }

    for source_id in complete_sources {
        mark_gone(db, places, source_id, now, options.limits)?;
    }
    settle_idle(db, places, now, options.limits)?;
    Ok(report)
}

fn take_file(db: &Connection, places: &Places, options: &PassOptions, item: &Work, files: &mut dyn Files, now: i64) -> Result<classify::Observed, String> {
    // Nothing is noted for a file that's gone or changed before it could be read.
    files.ready(&item.path, item.seen.size)?;
    let key = identity::resolve(&item.agent, &options.machine, &item.label, &item.rel_path, || files.head(&item.path, item.seen.size));
    let _writes = lock_writes();
    let Some(key) = key else {
        db.execute("UPDATE files SET state = 'skipped', skip_reason = 'unknown agent' WHERE file_id = ?1", [item.file_id]).map_err(db_error)?;
        return Err("A file in a home of an unknown kind was skipped".into());
    };
    let member_id = ensure_member(db, &key, now)?;
    let mut source = files.open(&item.path, item.seen.size)?;
    let cx = Cx { db, blobs: places, limits: options.limits, now };
    let settle = options.import || now - item.seen.mtime_ns / 1_000_000 > SETTLE_AFTER_MS;
    let target = Target { file_id: item.file_id, member_id, agent: &key.agent, encoding: key.encoding, has_ordinal: key.has_ordinal, settle };
    classify::observe(&cx, &target, item.seen, source.as_mut())
}

/// Files a complete listing didn't have, twice running, are gone. A version one of them was
/// the growing end of settles.
fn mark_gone(db: &Connection, places: &Places, source_id: i64, now: i64, limits: Limits) -> Result<(), String> {
    let _writes = lock_writes();
    let transaction = db.unchecked_transaction().map_err(db_error)?;
    transaction.execute("UPDATE sources SET complete_lists = complete_lists + 1 WHERE source_id = ?1", [source_id]).map_err(db_error)?;
    transaction.execute("UPDATE files SET missing_lists = missing_lists + 1 WHERE source_id = ?1 AND state = 'live' AND last_seen_at < ?2", params![source_id, now]).map_err(db_error)?;
    let gone: Vec<(i64, String, Option<i64>, Option<i64>)> = {
        let mut statement = transaction.prepare("SELECT file_id, rel_path, version_id, matched_len FROM files WHERE source_id = ?1 AND state = 'live' AND missing_lists >= 2").map_err(db_error)?;
        let rows = statement.query_map([source_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).map_err(db_error)?;
        rows.collect::<Result<_, _>>().map_err(db_error)?
    };
    for (file_id, path, _, _) in &gone {
        transaction.execute("UPDATE files SET state = 'gone', gone_at = ?2 WHERE file_id = ?1", params![file_id, now]).map_err(db_error)?;
        emit(&transaction, json!({"t": "gone", "src": source_id, "path": path, "at": now}))?;
    }
    transaction.commit().map_err(db_error)?;
    let cx = Cx { db, blobs: places, limits, now };
    for (_, _, version_id, matched) in gone {
        let (Some(version_id), Some(matched)) = (version_id, matched) else {
            continue;
        };
        let version = classify::load_version(db, version_id)?;
        if version.state == "growing" && version.size as i64 == matched {
            classify::settle(&cx, &version)?;
        }
    }
    Ok(())
}

/// Settles versions that stopped growing a day ago, and the oldest tails when they take too
/// much room on this Mac.
fn settle_idle(db: &Connection, places: &Places, now: i64, limits: Limits) -> Result<(), String> {
    let _writes = lock_writes();
    let growing: Vec<(i64, i64, i64)> = {
        let mut statement = db.prepare("SELECT version_id, COALESCE(grew_at, created_at), tail_len FROM versions WHERE state = 'growing' ORDER BY COALESCE(grew_at, created_at)").map_err(db_error)?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(db_error)?;
        rows.collect::<Result<_, _>>().map_err(db_error)?
    };
    let mut pending: i64 = growing.iter().map(|(_, _, tail)| tail).sum();
    let cx = Cx { db, blobs: places, limits, now };
    for (version_id, grew_at, tail) in growing {
        if now - grew_at > SETTLE_AFTER_MS || pending > PENDING_MAX {
            classify::settle(&cx, &classify::load_version(db, version_id)?)?;
            pending -= tail;
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::classify::tests::SMALL;
    use super::super::lister::{parse, tests::{list_script_with, run_list, scanned_homes}};
    use super::super::store::tests::temp_dir;
    use super::super::{index, journal};
    use super::*;
    use std::collections::HashSet;
    use std::fs;

    pub(crate) const SECRET_TEXT: &str = "SECRET-7f3a-do-not-keep-outside-chunks";
    pub(crate) const SID: &str = "0f8b5c2e-1111-4222-8333-444455556666";
    pub(crate) const THREAD: &str = "019a1b2c-3d4e-7f00-8111-222233334444";

    pub(crate) struct Fixture {
        pub(crate) base: PathBuf,
        pub(crate) home: PathBuf,
        pub(crate) db_path: PathBuf,
        pub(crate) db: Connection,
        pub(crate) places: Places,
    }

    impl Fixture {
        pub(crate) fn new(name: &str) -> Self {
            let base = temp_dir(name);
            let home = base.join("home");
            fs::create_dir_all(&home).unwrap();
            let store = Store::create(&base.join("store"), "a1", "mac", None).unwrap();
            let db_path = base.join("index/archive.db");
            fs::create_dir_all(db_path.parent().unwrap()).unwrap();
            let db = index::open(&db_path).unwrap();
            db.execute("INSERT INTO stores(store_id, role, machine, root, added_at) VALUES(?1, 'main', 'mac', ?2, 0)", params![store.info().store_id, store.root().to_string_lossy()]).unwrap();
            let pending_dir = base.join("index/pending");
            fs::create_dir_all(&pending_dir).unwrap();
            Fixture { base, home, db_path, db, places: Places { store, pending_dir } }
        }

        pub(crate) fn write(&self, rel: &str, text: &str) {
            let path = self.home.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }

        fn list(&self) -> (String, Listing) {
            let stdout = run_list("sh", &self.home, &list_script_with(&scanned_homes()));
            let listing = parse(&stdout);
            (stdout, listing)
        }

        pub(crate) fn pass(&self) -> PassReport {
            self.pass_keeping(SessionFilter::everything())
        }

        pub(crate) fn pass_keeping(&self, sessions: SessionFilter) -> PassReport {
            let (_, listing) = self.list();
            let options = PassOptions {
                machine: "mac".into(),
                user_home: Some(self.home.to_string_lossy().into_owned()),
                limits: SMALL,
                bytes_per_second: 1 << 40,
                max_bytes: 1 << 40,
                max_time: Duration::from_secs(600),
                import: false,
                sessions,
            };
            let report = run_pass(&self.db, &self.places, &listing, &options, &|| false).unwrap();
            journal::flush(&self.db, &self.places.store).unwrap();
            report
        }

        pub(crate) fn count(&self, sql: &str) -> i64 {
            self.db.query_row(sql, [], |row| row.get(0)).unwrap()
        }
    }

    fn claude_lines(count: usize) -> String {
        (0..count).map(|n| format!("{{\"type\":\"user\",\"sessionId\":\"{SID}\",\"n\":{n},\"text\":\"{SECRET_TEXT}\"}}\n")).collect()
    }

    #[test]
    fn a_session_whose_project_is_left_out_is_not_read_and_is_taken_once_kept_again() {
        let fixture = Fixture::new("left-out");
        fixture.write(&format!(".claude/projects/-Users-me-app/{SID}.jsonl"), &claude_lines(3));
        fixture.write(&format!(".claude/projects/-Users-me-app/{SID}/subagents/agent-a1.jsonl"), &claude_lines(1));
        let first_line = format!("{{\"timestamp\":\"t\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{THREAD}\"}}}}\n");
        fixture.write(&format!(".codex/sessions/2026/09/25/rollout-2026-09-25T10-00-00-{THREAD}.jsonl"), &first_line);
        let without_claude = SessionFilter { keep_rest: true, except: HashSet::from([SID.to_string()]) };

        // Three passes, so a file that's only left out would be taken for gone if it weren't still seen.
        for changed in [1, 0, 0] {
            let report = fixture.pass_keeping(without_claude.clone());
            assert!(report.complete, "{report:?}");
            assert_eq!((report.files_left_out, report.files_changed), (2, changed));
        }
        assert_eq!(fixture.count("SELECT COUNT(*) FROM sessions WHERE agent = 'claude'"), 0);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM sessions WHERE agent = 'codex'"), 1);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM files WHERE state != 'live'"), 0);
        // Of a session left out, nothing but its paths is noted: no text reaches the index or the store.
        fixture.db.execute_batch("PRAGMA wal_checkpoint(PASSIVE);").unwrap();
        let secret = SECRET_TEXT.as_bytes();
        for path in [fixture.db_path.clone(), fixture.db_path.with_extension("db-wal")].into_iter().chain(walk(fixture.places.store.root())) {
            assert!(!fs::read(&path).is_ok_and(|bytes| bytes.windows(secret.len()).any(|window| window == secret)), "{}", path.display());
        }

        // Kept again: its files are read at the next pass, as if new.
        let report = fixture.pass();
        assert_eq!((report.files_left_out, report.files_changed), (0, 2));
        assert_eq!(fixture.count("SELECT COUNT(*) FROM sessions WHERE agent = 'claude'"), 1);

        // Keeping only one session keeps nothing else, however it's filed.
        let only_codex = SessionFilter { keep_rest: false, except: HashSet::from([THREAD.to_string()]) };
        fixture.write(&format!(".claude/projects/-Users-me-app/{SID}.jsonl"), &claude_lines(9));
        let report = fixture.pass_keeping(only_codex);
        assert_eq!((report.files_left_out, report.files_changed), (2, 0));
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn keeps_a_desktop_apps_local_sessions_but_not_the_sign_ins_beside_them() {
        let fixture = Fixture::new("desktop");
        let org = "Library/Application Support/Claude/local-agent-mode-sessions/acct/org";
        let local = format!("local_{THREAD}");
        fixture.write(&format!("{org}/{local}/audit.jsonl"), "{\"type\":\"audit\"}\n");
        fixture.write(&format!("{org}/{local}.json"), &format!("{{\"remoteMcpServersConfig\":\"{SECRET_TEXT}\"}}"));
        fixture.write(&format!("{org}/{local}/.audit-key"), SECRET_TEXT);
        fixture.write(&format!("{org}/{local}/.claude/.credentials.json"), SECRET_TEXT);
        fixture.write(&format!("{org}/{local}/.claude/projects/-sessions-x/{SID}.jsonl"), &format!("{{\"type\":\"user\",\"sessionId\":\"{SID}\"}}\n"));
        let other = "1a2b3c4d-1111-4222-8333-444455556666";
        fixture.write(&format!("Library/Application Support/AcmeCode/claude/projects/-Users-me-app/{other}.jsonl"), &format!("{{\"type\":\"user\",\"sessionId\":\"{other}\"}}\n"));

        let report = fixture.pass();
        assert!(report.complete, "{report:?}");
        assert_eq!((report.files_changed, report.failures), (3, 0));
        assert_eq!(fixture.count("SELECT COUNT(*) FROM sessions WHERE agent = 'claude-desktop'"), 1);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM sessions WHERE agent = 'claude'"), 2);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM sources WHERE kind = 'home'"), 3);
        // The sign-ins and settings beside a session are never read, so they're nowhere: not in
        // the index, the journal or the store's chunks.
        fixture.db.execute_batch("PRAGMA wal_checkpoint(PASSIVE);").unwrap();
        let secret = SECRET_TEXT.as_bytes();
        for path in [fixture.db_path.clone(), fixture.db_path.with_extension("db-wal")].into_iter().chain(walk(fixture.places.store.root())) {
            assert!(!fs::read(&path).is_ok_and(|bytes| bytes.windows(secret.len()).any(|window| window == secret)), "{}", path.display());
        }
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn keeps_every_session_file_once_and_follows_it_as_it_grows() {
        let fixture = Fixture::new("ingest");
        let main = format!(".claude/projects/-Users-me-app/{SID}.jsonl");
        fixture.write(&main, &claude_lines(3));
        // The same session in a second home is the same session, stored once.
        fixture.write(&format!(".agent-app/homes/claude-proxy/projects/-Users-me-app/{SID}.jsonl"), &claude_lines(3));
        fixture.write(&format!(".claude/projects/-Users-me-app/{SID}/subagents/agent-a1.jsonl"), &claude_lines(1));
        fixture.write(".claude/history.jsonl", &format!("{{\"display\":\"{SECRET_TEXT}\"}}\n"));
        fixture.write(".claude/settings.json", "{\"env\":{\"TOKEN\":\"not-a-session\"}}");
        let first_line = format!("{{\"timestamp\":\"t\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{THREAD}\",\"instructions\":\"{SECRET_TEXT}\"}}}}\n");
        fixture.write(&format!(".codex/sessions/2026/09/25/rollout-2026-09-25T10-00-00-{THREAD}.jsonl"), &first_line);

        let report = fixture.pass();
        assert!(report.complete, "{report:?}");
        assert_eq!((report.files_listed, report.files_changed, report.failures), (5, 5, 0));
        assert_eq!(fixture.count("SELECT COUNT(*) FROM sessions WHERE agent = 'claude'"), 1);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM sessions WHERE agent = 'codex'"), 1);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM versions"), 4);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM observations"), 5);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM files WHERE rel_path LIKE '%settings%'"), 0);

        // Nothing changed: nothing is read.
        let again = fixture.pass();
        assert_eq!((again.files_changed, again.bytes_read), (0, 0));

        // The session grew in one home: its version carries on.
        fixture.write(&main, &claude_lines(40));
        let grew = fixture.pass();
        assert_eq!(grew.files_changed, 1);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM versions"), 4);
        let size: i64 = fixture.count("SELECT MAX(size) FROM versions");
        assert_eq!(size as usize, claude_lines(40).len());

        // Deleted: gone only after two whole listings without it, and its version settles.
        fs::remove_file(fixture.home.join(&main)).unwrap();
        fixture.pass();
        assert_eq!(fixture.count("SELECT COUNT(*) FROM files WHERE state = 'gone'"), 0);
        fixture.pass();
        assert_eq!(fixture.count("SELECT COUNT(*) FROM files WHERE state = 'gone'"), 1);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM versions WHERE state = 'growing' AND size = (SELECT MAX(size) FROM versions)"), 0);

        // Every version can be put back together from the store's journal and chunks alone.
        let lines = journal::read_all(fixture.places.store.root());
        let mut chunks: std::collections::HashMap<i64, Vec<(String, u64)>> = Default::default();
        for line in &lines {
            match line["t"].as_str().unwrap() {
                "grow" => {
                    let entry = chunks.entry(line["v"].as_i64().unwrap()).or_default();
                    let off = line["off"].as_u64().unwrap();
                    let mut at: u64 = 0;
                    entry.retain(|(_, len)| {
                        at += len;
                        at <= off
                    });
                    entry.extend(line["chunks"].as_array().unwrap().iter().map(|chunk| (chunk[0].as_str().unwrap().to_string(), chunk[1].as_u64().unwrap())));
                }
                "resume" => {
                    let off = line["off"].as_u64().unwrap();
                    let entry = chunks.entry(line["v"].as_i64().unwrap()).or_default();
                    let mut at: u64 = 0;
                    entry.retain(|(_, len)| {
                        at += len;
                        at <= off
                    });
                }
                _ => {}
            }
        }
        let biggest = chunks.values().max_by_key(|list| list.iter().map(|(_, len)| len).sum::<u64>()).unwrap();
        let rebuilt: Vec<u8> = biggest.iter().flat_map(|(hash, _)| fixture.places.store.read_chunk(&super::super::sha::unhex(hash).unwrap().try_into().unwrap()).unwrap()).collect();
        assert_eq!(rebuilt, claude_lines(40).into_bytes());
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn transcript_text_is_only_ever_in_the_stores_chunks() {
        let fixture = Fixture::new("secret");
        fixture.write(&format!(".claude/projects/-Users-me-app/{SID}.jsonl"), &claude_lines(30));
        fixture.write(".claude/history.jsonl", &format!("{{\"display\":\"{SECRET_TEXT}\"}}\n"));
        fixture.write(&format!(".codex/sessions/2026/09/25/rollout-2026-09-25T10-00-00-{THREAD}.jsonl"), &format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{THREAD}\",\"instructions\":\"{SECRET_TEXT}\"}}}}\n"));
        let (stdout, _) = fixture.list();
        assert!(!stdout.contains(SECRET_TEXT));
        fixture.pass();
        // Growing tails are kept too, compressed; grow a file so one exists.
        fixture.write(&format!(".claude/projects/-Users-me-app/{SID}.jsonl"), &format!("{}{{\"partial\":\"{SECRET_TEXT}", claude_lines(31)));
        fixture.pass();
        let secret = SECRET_TEXT.as_bytes();
        let contains = |bytes: &[u8]| bytes.windows(secret.len()).any(|window| window == secret);
        fixture.db.execute_batch("PRAGMA wal_checkpoint(PASSIVE);").unwrap();
        let mut checked = 0;
        for path in [fixture.db_path.clone(), fixture.db_path.with_extension("db-wal")] {
            if let Ok(bytes) = fs::read(&path) {
                checked += 1;
                assert!(!contains(&bytes), "{}", path.display());
            }
        }
        assert!(checked >= 1);
        for entry in fs::read_dir(fixture.places.store.root().join("journal")).unwrap().flatten() {
            assert!(!contains(&fs::read(entry.path()).unwrap()));
        }
        for dir in ["index", "tmp", "quarantine"] {
            for entry in walk(&fixture.places.store.root().join(dir)) {
                assert!(!contains(&fs::read(&entry).unwrap()), "{}", entry.display());
            }
        }
        for name in ["store.json", "README.txt"] {
            assert!(!contains(&fs::read(fixture.places.store.root().join(name)).unwrap()));
        }
        // It's in the chunks and growing tails, where transcripts belong: every version put back
        // together from them holds it.
        let ids: Vec<i64> = fixture.db.prepare("SELECT version_id FROM versions").unwrap().query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(ids.len(), 3);
        // Nor in what the archive's commands send the page.
        let status = super::super::status_from(&fixture.db, &super::super::Runtime::default(), None).unwrap();
        let folder = super::super::store::check_folder(fixture.places.store.root(), None);
        for json in [serde_json::to_string(&status).unwrap(), serde_json::to_string(&folder).unwrap()] {
            assert!(!json.contains(SECRET_TEXT));
        }
        assert!(status.totals.versions == 3 && status.sources.len() == 2);
        for id in ids {
            let version = classify::load_version(&fixture.db, id).unwrap();
            let mut bytes: Vec<u8> = version.chunks.iter().flat_map(|(_, hash, _)| fixture.places.read_chunk(hash).unwrap()).collect();
            if version.state == "growing" && version.tail_len > 0 {
                bytes.extend(fixture.places.read_pending(&version.vk, version.pending_gen).unwrap());
            }
            assert!(contains(&bytes), "version {id}");
        }
        let _ = fs::remove_dir_all(&fixture.base);
    }

    pub(crate) fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(walk(&path));
            } else {
                out.push(path);
            }
        }
        out
    }

    #[test]
    fn a_pass_stops_at_its_share_and_the_next_carries_on() {
        let fixture = Fixture::new("budget");
        for n in 0..4 {
            fixture.write(&format!(".claude/projects/-a/0f8b5c2e-1111-4222-8333-44445555666{n}.jsonl"), &claude_lines(20));
        }
        let (_, listing) = fixture.list();
        let options = PassOptions {
            machine: "mac".into(),
            user_home: None,
            limits: SMALL,
            bytes_per_second: 1 << 40,
            max_bytes: 1,
            max_time: Duration::from_secs(600),
            import: false,
            sessions: SessionFilter::everything(),
        };
        let first = run_pass(&fixture.db, &fixture.places, &listing, &options, &|| false).unwrap();
        assert!(!first.complete);
        assert_eq!(first.files_changed, 1);
        let mut passes = 1;
        loop {
            passes += 1;
            if run_pass(&fixture.db, &fixture.places, &listing, &options, &|| false).unwrap().complete {
                break;
            }
        }
        assert_eq!(passes, 4);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM sessions"), 4);
        let _ = fs::remove_dir_all(&fixture.base);
    }
}

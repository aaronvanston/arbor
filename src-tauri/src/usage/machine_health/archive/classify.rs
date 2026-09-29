//! Sorts one file, as it is now, into its member's versions.
//!
//! A version is one distinct run of bytes a member has had. No version is
//! ever the start of another: a file that's the start of a version is noted
//! against it, one that carries a version on grows it, and anything else is
//! a new version. So the versions kept are the longest contents ever seen,
//! whatever order the files turned up in.
//!
//! Step 0: the file's stat is unchanged, so nothing is read.
//! Step 1: a big file that only grew is read from where it was, once its
//!         start, its old end, its tail and a few of its chunks still match.
//! Step 2: anything else is read whole and compared by chunk hashes:
//!         identical, the start of a version, a version carried on, or new.

use super::chunker::{LineCut, Rule, LINECUT_V1};
use super::journal::emit;
use super::sha::{hex, sha256, Midstate, Sha};
use super::store::{random_id, ChunkMeta, NewChunk};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::json;

pub(crate) const CHANGED: &str = "The file changed while it was read. It'll be read again next time.";

/// Where chunks and growing tails are kept.
pub(crate) trait Blobs {
    fn store_id(&self) -> &str;
    fn put_chunks(&self, chunks: &[NewChunk<'_>]) -> Result<Vec<ChunkMeta>, String>;
    fn read_chunk(&self, hash: &[u8; 32]) -> Result<Vec<u8>, String>;
    fn put_pending(&self, vk: &str, gen: i64, tail: &[u8]) -> Result<(), String>;
    fn read_pending(&self, vk: &str, gen: i64) -> Result<Vec<u8>, String>;
    fn drop_pending(&self, vk: &str, keep: Option<i64>);
}

/// A file's bytes, read by position.
pub(crate) trait Source {
    fn read_exact_at(&mut self, off: u64, buf: &mut [u8]) -> Result<(), String>;
}

impl Source for &[u8] {
    fn read_exact_at(&mut self, off: u64, buf: &mut [u8]) -> Result<(), String> {
        let start = usize::try_from(off).map_err(|_| CHANGED.to_string())?;
        let bytes = start.checked_add(buf.len()).and_then(|end| self.get(start..end)).ok_or_else(|| CHANGED.to_string())?;
        buf.copy_from_slice(bytes);
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    pub(crate) rule: Rule,
    /// A changed file up to this size is read whole, which checks every byte already kept.
    pub(crate) full_check_max: u64,
    /// A file up to this size is kept in memory between hashing it and storing it.
    pub(crate) keep_max: u64,
    /// Chunks are stored this many bytes at a time.
    pub(crate) batch: usize,
    /// Files are read this many bytes at a time.
    pub(crate) piece: usize,
    /// Chunks re-hashed when a big file grows, a different few each time.
    pub(crate) samples: usize,
    /// How much of a file's start, and of the bytes before its old end, is hashed to check
    /// it's still the same file.
    pub(crate) anchor: u64,
}

pub(crate) const LIMITS: Limits = Limits { rule: LINECUT_V1, full_check_max: 64 << 20, keep_max: 8 << 20, batch: 64 << 20, piece: 4 << 20, samples: 4, anchor: 64 << 10 };

pub(crate) struct Cx<'a> {
    pub(crate) db: &'a Connection,
    pub(crate) blobs: &'a dyn Blobs,
    pub(crate) limits: Limits,
    pub(crate) now: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Seen {
    pub(crate) dev: u64,
    pub(crate) ino: u64,
    pub(crate) size: u64,
    pub(crate) mtime_ns: i64,
    pub(crate) ctime_ns: i64,
}

/// The file being sorted, and what it's a file of.
pub(crate) struct Target<'a> {
    pub(crate) file_id: i64,
    pub(crate) member_id: i64,
    pub(crate) agent: &'a str,
    pub(crate) encoding: &'a str,
    pub(crate) has_ordinal: Option<bool>,
    /// The file stopped changing long ago, so what's read is final.
    pub(crate) settle: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Unchanged,
    Identical,
    Prefix,
    Grew,
    New,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Observed {
    pub(crate) outcome: Outcome,
    pub(crate) version_id: i64,
    pub(crate) bytes_read: u64,
    /// Bytes of chunks the store didn't have.
    pub(crate) bytes_new: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct Version {
    pub(crate) id: i64,
    pub(crate) vk: String,
    pub(crate) state: String,
    pub(crate) encoding: String,
    pub(crate) committed_len: u64,
    committed_mid: Option<Midstate>,
    committed_sha: Option<[u8; 32]>,
    head_sha: Option<[u8; 32]>,
    win_sha: Option<[u8; 32]>,
    pub(crate) tail_len: u64,
    tail_sha: Option<[u8; 32]>,
    pub(crate) pending_gen: i64,
    pub(crate) size: u64,
    pub(crate) sha256: Option<[u8; 32]>,
    has_ordinal: Option<bool>,
    /// (offset, hash, length): the whole chunks, then the tail's chunk once settled.
    pub(crate) chunks: Vec<(u64, [u8; 32], u64)>,
}

impl Version {
    /// The chunks cut at line ends, which a longer file with the same start shares.
    fn whole_chunks(&self) -> &[(u64, [u8; 32], u64)] {
        let count = self.chunks.iter().take_while(|chunk| chunk.0 < self.committed_len).count();
        &self.chunks[..count]
    }

    fn fresh(vk: String, encoding: &str, has_ordinal: Option<bool>) -> Self {
        Version {
            id: 0,
            vk,
            state: "growing".into(),
            encoding: encoding.into(),
            committed_len: 0,
            committed_mid: None,
            committed_sha: None,
            head_sha: None,
            win_sha: None,
            tail_len: 0,
            tail_sha: None,
            pending_gen: 0,
            size: 0,
            sha256: None,
            has_ordinal,
            chunks: Vec::new(),
        }
    }
}

fn db_error(error: rusqlite::Error) -> String {
    format!("The archive index failed: {error}")
}

fn hash32(bytes: Option<Vec<u8>>) -> Option<[u8; 32]> {
    bytes.and_then(|bytes| bytes.try_into().ok())
}

const VERSION_COLUMNS: &str =
    "version_id, vk, state, encoding, committed_len, committed_mid, committed_sha, head_sha, win_sha, tail_len, tail_sha, pending_gen, size, sha256, has_ordinal";

fn version_from(row: &Row<'_>) -> rusqlite::Result<Version> {
    Ok(Version {
        id: row.get(0)?,
        vk: row.get(1)?,
        state: row.get(2)?,
        encoding: row.get(3)?,
        committed_len: row.get::<_, i64>(4)? as u64,
        committed_mid: row.get::<_, Option<Vec<u8>>>(5)?.and_then(|bytes| Midstate::decode(&bytes)),
        committed_sha: hash32(row.get(6)?),
        head_sha: hash32(row.get(7)?),
        win_sha: hash32(row.get(8)?),
        tail_len: row.get::<_, i64>(9)? as u64,
        tail_sha: hash32(row.get(10)?),
        pending_gen: row.get(11)?,
        size: row.get::<_, i64>(12)? as u64,
        sha256: hash32(row.get(13)?),
        has_ordinal: row.get::<_, Option<i64>>(14)?.map(|value| value != 0),
        chunks: Vec::new(),
    })
}

fn with_chunks(db: &Connection, mut version: Version) -> Result<Version, String> {
    let mut statement = db.prepare_cached("SELECT off, hash, len FROM version_chunks WHERE version_id = ?1 ORDER BY ord").map_err(db_error)?;
    let rows = statement.query_map([version.id], |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, Vec<u8>>(1)?, row.get::<_, i64>(2)? as u64))).map_err(db_error)?;
    for row in rows {
        let (off, hash, len) = row.map_err(db_error)?;
        let hash = hash.try_into().map_err(|_| "A chunk hash in the index is the wrong length".to_string())?;
        version.chunks.push((off, hash, len));
    }
    Ok(version)
}

pub(crate) fn load_version(db: &Connection, id: i64) -> Result<Version, String> {
    let version = db.query_row(&format!("SELECT {VERSION_COLUMNS} FROM versions WHERE version_id = ?1"), [id], version_from).map_err(db_error)?;
    with_chunks(db, version)
}

fn member_versions(db: &Connection, member_id: i64, encoding: &str) -> Result<Vec<Version>, String> {
    let versions: Vec<Version> = {
        let mut statement = db.prepare_cached(&format!("SELECT {VERSION_COLUMNS} FROM versions WHERE member_id = ?1 AND encoding = ?2 ORDER BY version_id")).map_err(db_error)?;
        let rows = statement.query_map(params![member_id, encoding], version_from).map_err(db_error)?;
        rows.collect::<Result<_, _>>().map_err(db_error)?
    };
    versions.into_iter().map(|version| with_chunks(db, version)).collect()
}

#[derive(Debug, Default)]
struct FileRow {
    version_id: Option<i64>,
    matched_len: Option<u64>,
    dev: Option<i64>,
    ino: Option<i64>,
    size: Option<i64>,
    mtime_ns: Option<i64>,
    ctime_ns: Option<i64>,
    sample_rot: i64,
}

impl FileRow {
    fn same_as(&self, seen: Seen) -> bool {
        self.dev == Some(seen.dev as i64) && self.ino == Some(seen.ino as i64) && self.size == Some(seen.size as i64) && self.mtime_ns == Some(seen.mtime_ns) && self.ctime_ns == Some(seen.ctime_ns)
    }

    /// Codex rewrites a rollout in place and keeps its modified time.
    fn rewritten(&self, seen: Seen) -> bool {
        self.mtime_ns == Some(seen.mtime_ns) && (self.size != Some(seen.size as i64) || self.ctime_ns != Some(seen.ctime_ns))
    }
}

fn load_file(db: &Connection, file_id: i64) -> Result<FileRow, String> {
    db.query_row("SELECT version_id, matched_len, dev, ino, size, mtime_ns, ctime_ns, sample_rot FROM files WHERE file_id = ?1", [file_id], |row| {
        Ok(FileRow {
            version_id: row.get(0)?,
            matched_len: row.get::<_, Option<i64>>(1)?.map(|len| len as u64),
            dev: row.get(2)?,
            ino: row.get(3)?,
            size: row.get(4)?,
            mtime_ns: row.get(5)?,
            ctime_ns: row.get(6)?,
            sample_rot: row.get(7)?,
        })
    })
    .map_err(db_error)
}

fn range_sha(source: &mut dyn Source, off: u64, len: u64) -> Result<[u8; 32], String> {
    let mut buf = vec![0u8; len as usize];
    source.read_exact_at(off, &mut buf)?;
    Ok(sha256(&buf))
}

/// Sorts the file into its member's versions and notes where it was seen.
pub(crate) fn observe(cx: &Cx<'_>, target: &Target<'_>, seen: Seen, source: &mut dyn Source) -> Result<Observed, String> {
    let file = load_file(cx.db, target.file_id)?;
    if let Some(version_id) = file.version_id {
        if file.same_as(seen) {
            return Ok(Observed { outcome: Outcome::Unchanged, version_id, bytes_read: 0, bytes_new: 0 });
        }
    }
    if let Some(done) = append_path(cx, target, &file, seen, source)? {
        return Ok(done);
    }
    full_pass(cx, target, &file, seen, source)
}

/// Step 1: a big file that grew is read from its old end, after spot checks that what was
/// kept of it is still what it holds.
fn append_path(cx: &Cx<'_>, target: &Target<'_>, file: &FileRow, seen: Seen, source: &mut dyn Source) -> Result<Option<Observed>, String> {
    let (Some(version_id), Some(matched)) = (file.version_id, file.matched_len) else {
        return Ok(None);
    };
    if seen.size <= cx.limits.full_check_max || file.ino != Some(seen.ino as i64) || seen.size <= matched || file.rewritten(seen) {
        return Ok(None);
    }
    let version = load_version(cx.db, version_id)?;
    if version.size != matched || version.encoding != target.encoding || version.state == "lost-tail" {
        return Ok(None);
    }
    let mut checks: Vec<(u64, u64, Option<[u8; 32]>)> = Vec::new();
    let head = cx.limits.anchor.min(matched);
    checks.push((0, head, version.head_sha));
    checks.push((matched - head, head, version.win_sha));
    if version.tail_len > 0 {
        checks.push((version.committed_len, version.tail_len, version.tail_sha));
    }
    let whole = version.whole_chunks();
    if !whole.is_empty() {
        let first = (file.sample_rot.max(0) as usize).wrapping_mul(cx.limits.samples);
        for step in 0..cx.limits.samples.min(whole.len()) {
            let (off, hash, len) = whole[(first + step) % whole.len()];
            checks.push((off, len, Some(hash)));
        }
    }
    let mut read = 0;
    for (off, len, want) in checks {
        read += len;
        if want.is_none() || range_sha(source, off, len).ok() != want {
            return Ok(None);
        }
    }
    let grown = grow(cx, &version, None, source, seen.size, target.settle, None)?;
    record(cx, target, grown.version_id, seen.size, grown.sha, "grew", seen)?;
    cx.db.execute("UPDATE files SET sample_rot = sample_rot + 1 WHERE file_id = ?1", [target.file_id]).map_err(db_error)?;
    Ok(Some(Observed { outcome: Outcome::Grew, version_id: grown.version_id, bytes_read: read + grown.read, bytes_new: grown.new_bytes }))
}

/// What reading a whole file found, before anything is written.
struct Scan {
    len: u64,
    sha: [u8; 32],
    /// Its chunks cut at line ends, and what's after the last.
    chunks: Vec<([u8; 32], u64)>,
    tail: Vec<u8>,
    /// The file itself, when it's small enough to keep.
    data: Option<Vec<u8>>,
    /// Versions whose tail the file holds where the version's last chunk ended.
    tail_hits: Vec<i64>,
}

/// A version's tail, looked for in a file that might carry the version on.
struct Probe {
    version_id: i64,
    start: u64,
    len: u64,
    sha: Option<[u8; 32]>,
}

fn check_probes(probes: &[Probe], off: u64, bytes: &[u8], hits: &mut Vec<i64>) {
    for probe in probes.iter().filter(|probe| probe.start == off && probe.len as usize <= bytes.len()) {
        if Some(sha256(&bytes[..probe.len as usize])) == probe.sha {
            hits.push(probe.version_id);
        }
    }
}

fn scan(limits: Limits, source: &mut dyn Source, size: u64, probes: &[Probe]) -> Result<Scan, String> {
    use sha2::Digest;
    let mut data = (size <= limits.keep_max).then(|| Vec::with_capacity(size as usize));
    let mut whole = sha2::Sha256::new();
    let mut cutter = LineCut::new(limits.rule);
    let mut out = Vec::new();
    let mut chunks = Vec::new();
    let mut tail_hits = Vec::new();
    let mut off = 0u64;
    let mut buf = vec![0u8; (limits.piece as u64).min(size).max(1) as usize];
    let mut pos = 0u64;
    while pos < size {
        let n = (size - pos).min(buf.len() as u64) as usize;
        source.read_exact_at(pos, &mut buf[..n])?;
        whole.update(&buf[..n]);
        if let Some(data) = data.as_mut() {
            data.extend_from_slice(&buf[..n]);
        }
        cutter.push(&buf[..n], &mut out);
        for chunk in out.drain(..) {
            check_probes(probes, off, &chunk.data, &mut tail_hits);
            chunks.push((sha256(&chunk.data), chunk.data.len() as u64));
            off += chunk.data.len() as u64;
        }
        pos += n as u64;
    }
    let tail = cutter.into_tail();
    check_probes(probes, off, &tail, &mut tail_hits);
    Ok(Scan { len: size, sha: whole.finalize().into(), chunks, tail, data, tail_hits })
}

/// The bytes after a version's last whole chunk.
fn tail_bytes(cx: &Cx<'_>, version: &Version) -> Result<Vec<u8>, String> {
    if version.tail_len == 0 {
        return Ok(Vec::new());
    }
    if version.state == "growing" {
        let bytes = cx.blobs.read_pending(&version.vk, version.pending_gen)?;
        if Some(sha256(&bytes)) != version.tail_sha {
            return Err("A kept tail doesn't match the index".into());
        }
        return Ok(bytes);
    }
    match version.chunks.last() {
        Some((off, hash, _)) if *off == version.committed_len => cx.blobs.read_chunk(hash),
        _ => Ok(Vec::new()),
    }
}

/// Whether the scanned file is the start of `version`.
fn is_start_of(cx: &Cx<'_>, scan: &Scan, version: &Version) -> Result<bool, String> {
    let whole = version.whole_chunks();
    let count = scan.chunks.len();
    if count > whole.len() || scan.chunks.iter().zip(whole).any(|(ours, theirs)| ours.0 != theirs.1) {
        return Ok(false);
    }
    if scan.tail.is_empty() {
        return Ok(true);
    }
    // What's after the shared chunks is inside the version's next chunk, or its tail.
    let next = match whole.get(count) {
        Some((_, hash, _)) => cx.blobs.read_chunk(hash)?,
        None => tail_bytes(cx, version)?,
    };
    Ok(next.starts_with(&scan.tail))
}

/// Whether the scanned file carries `version` on.
fn carries_on(scan: &Scan, version: &Version) -> bool {
    let whole = version.whole_chunks();
    version.size < scan.len
        && whole.len() <= scan.chunks.len()
        && whole.iter().zip(&scan.chunks).all(|(theirs, ours)| theirs.1 == ours.0)
        && (version.tail_len == 0 || scan.tail_hits.contains(&version.id))
}

/// Step 2.
fn full_pass(cx: &Cx<'_>, target: &Target<'_>, file: &FileRow, seen: Seen, source: &mut dyn Source) -> Result<Observed, String> {
    let versions = member_versions(cx.db, target.member_id, target.encoding)?;
    let probes: Vec<Probe> = versions
        .iter()
        .filter(|version| version.size < seen.size && version.tail_len > 0)
        .map(|version| Probe { version_id: version.id, start: version.committed_len, len: version.tail_len, sha: version.tail_sha })
        .collect();
    let scan = scan(cx.limits, source, seen.size, &probes)?;
    let read = scan.len;
    let observed = |outcome, version_id, bytes_new| Observed { outcome, version_id, bytes_read: read, bytes_new };

    if let Some(version) = versions.iter().find(|version| version.size == scan.len && version.sha256 == Some(scan.sha)) {
        settle_left_behind(cx, file, version.id)?;
        record(cx, target, version.id, scan.len, scan.sha, "identical", seen)?;
        return Ok(observed(Outcome::Identical, version.id, 0));
    }

    let mut starts: Vec<i64> = Vec::new();
    for version in versions.iter().filter(|version| version.size > scan.len) {
        if is_start_of(cx, &scan, version)? {
            starts.push(version.id);
        }
    }
    if let Some(&first) = starts.first() {
        settle_left_behind(cx, file, first)?;
        // Noted against every version it starts, so which arrived first doesn't matter.
        for &version_id in starts.iter().rev() {
            record(cx, target, version_id, scan.len, scan.sha, "prefix", seen)?;
        }
        return Ok(observed(Outcome::Prefix, first, 0));
    }

    let mut kept = scan.data.as_deref();
    let reread: &mut dyn Source = match kept.as_mut() {
        Some(bytes) => bytes,
        None => source,
    };
    if let Some(version) = versions.iter().find(|version| carries_on(&scan, version)) {
        settle_left_behind(cx, file, version.id)?;
        let grown = grow(cx, version, None, reread, scan.len, target.settle, Some(scan.sha))?;
        record(cx, target, grown.version_id, scan.len, scan.sha, "grew", seen)?;
        return Ok(observed(Outcome::Grew, grown.version_id, grown.new_bytes));
    }

    // Compared before the file's old version settles: settling takes its tail out of pending,
    // and `versions` still has it growing.
    let shared = versions.iter().map(|version| shared_start(cx, &scan, version, reread)).collect::<Result<Vec<_>, _>>()?;
    settle_left_behind(cx, file, 0)?;
    let fresh = Version::fresh(random_id(), target.encoding, target.has_ordinal);
    let grown = grow(cx, &fresh, Some(target.member_id), reread, scan.len, target.settle, Some(scan.sha))?;
    let nearest = versions.iter().zip(&shared).max_by(|(a, (a_line, _)), (b, (b_line, _))| a_line.cmp(b_line).then(b.id.cmp(&a.id)));
    if let Some((version, (line, _))) = nearest {
        let kind = match (version.has_ordinal, target.has_ordinal) {
            (Some(old), Some(new)) if target.agent == "codex" && old != new => "reshaped",
            _ if *line == 0 => "rewritten",
            _ => "diverged",
        };
        let transaction = cx.db.unchecked_transaction().map_err(db_error)?;
        transaction.execute("INSERT OR IGNORE INTO relations(a, b, kind, common_len) VALUES(?1, ?2, ?3, ?4)", params![version.id, grown.version_id, kind, *line as i64]).map_err(db_error)?;
        emit(&transaction, json!({"t": "rel", "a": version.id, "b": grown.version_id, "kind": kind, "common": line}))?;
        transaction.commit().map_err(db_error)?;
    }
    record(cx, target, grown.version_id, scan.len, scan.sha, "new", seen)?;
    // Other files seen as the start of an older version may be the start of this one too.
    for (version, (_, exact)) in versions.iter().zip(&shared) {
        carry_starts(cx, version.id, grown.version_id, *exact)?;
    }
    Ok(observed(Outcome::New, grown.version_id, grown.new_bytes))
}

/// How much the file and `version` share from the start: exactly, and cut back to a line start.
fn shared_start(cx: &Cx<'_>, scan: &Scan, version: &Version, source: &mut dyn Source) -> Result<(u64, u64), String> {
    let mut count = 0;
    while count < scan.chunks.len() && count < version.chunks.len() && scan.chunks[count].0 == version.chunks[count].1 {
        count += 1;
    }
    let off: u64 = scan.chunks[..count].iter().map(|chunk| chunk.1).sum();
    let ours = match scan.chunks.get(count) {
        Some((_, len)) => {
            let mut buf = vec![0u8; *len as usize];
            source.read_exact_at(off, &mut buf)?;
            buf
        }
        None => scan.tail.clone(),
    };
    let theirs = match version.chunks.get(count) {
        Some((_, hash, _)) => cx.blobs.read_chunk(hash)?,
        None if version.state == "growing" => tail_bytes(cx, version)?,
        None => Vec::new(),
    };
    let same = ours.iter().zip(&theirs).take_while(|(a, b)| a == b).count();
    let line = ours[..same].iter().rposition(|byte| *byte == b'\n').map_or(off, |at| off + at as u64 + 1);
    Ok((line, off + same as u64))
}

/// Notes against `to` every file seen as the start of `from` that's also the start of `to`.
fn carry_starts(cx: &Cx<'_>, from: i64, to: i64, shared: u64) -> Result<(), String> {
    let rows: Vec<(i64, i64, Vec<u8>, Option<i64>)> = {
        let mut statement = cx.db.prepare("SELECT file_id, len, sha256, mtime FROM observations WHERE version_id = ?1 AND len <= ?2").map_err(db_error)?;
        let rows = statement.query_map(params![from, shared as i64], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).map_err(db_error)?;
        rows.collect::<Result<_, _>>().map_err(db_error)?
    };
    for (file_id, len, sha, mtime) in rows {
        let transaction = cx.db.unchecked_transaction().map_err(db_error)?;
        let added = transaction
            .execute(
                "INSERT OR IGNORE INTO observations(version_id, file_id, len, sha256, how, mtime, first_at, at) VALUES(?1, ?2, ?3, ?4, 'prefix', ?5, ?6, ?6)",
                params![to, file_id, len, sha, mtime, cx.now],
            )
            .map_err(db_error)?;
        if added > 0 {
            emit(&transaction, json!({"t": "obs", "v": to, "file": file_id, "len": len, "sha": hex(&sha), "how": "prefix", "at": cx.now}))?;
        }
        transaction.commit().map_err(db_error)?;
    }
    Ok(())
}

/// A file that was the growing end of a version, and isn't any more, leaves that version to settle.
fn settle_left_behind(cx: &Cx<'_>, file: &FileRow, now_on: i64) -> Result<(), String> {
    let (Some(previous), Some(matched)) = (file.version_id, file.matched_len) else {
        return Ok(());
    };
    if previous == now_on {
        return Ok(());
    }
    let version = load_version(cx.db, previous)?;
    if version.state == "growing" && version.size == matched {
        settle(cx, &version)?;
    }
    Ok(())
}

/// Notes the file as seen holding `len` bytes of the version, and what its stat was.
fn record(cx: &Cx<'_>, target: &Target<'_>, version_id: i64, len: u64, sha: [u8; 32], how: &str, seen: Seen) -> Result<(), String> {
    let transaction = cx.db.unchecked_transaction().map_err(db_error)?;
    let mtime_ms = seen.mtime_ns / 1_000_000;
    let known: bool = transaction.query_row("SELECT 1 FROM observations WHERE version_id = ?1 AND file_id = ?2", params![version_id, target.file_id], |_| Ok(())).optional().map_err(db_error)?.is_some();
    transaction
        .execute(
            "INSERT INTO observations(version_id, file_id, len, sha256, how, mtime, first_at, at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(version_id, file_id) DO UPDATE SET len = excluded.len, sha256 = excluded.sha256, how = excluded.how, mtime = excluded.mtime, at = excluded.at",
            params![version_id, target.file_id, len as i64, sha.to_vec(), how, mtime_ms, cx.now],
        )
        .map_err(db_error)?;
    if !known {
        let (source_id, path): (i64, String) = transaction.query_row("SELECT source_id, rel_path FROM files WHERE file_id = ?1", [target.file_id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(db_error)?;
        emit(&transaction, json!({"t": "obs", "v": version_id, "file": target.file_id, "src": source_id, "path": path, "len": len, "sha": hex(&sha), "how": how, "mtime": mtime_ms, "at": cx.now}))?;
    }
    transaction
        .execute(
            "UPDATE files SET version_id = ?2, matched_len = ?3, member_id = ?4, dev = ?5, ino = ?6, size = ?7, mtime_ns = ?8, ctime_ns = ?9 WHERE file_id = ?1",
            params![target.file_id, version_id, len as i64, target.member_id, seen.dev as i64, seen.ino as i64, seen.size as i64, seen.mtime_ns, seen.ctime_ns],
        )
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)
}

struct Grown {
    version_id: i64,
    sha: [u8; 32],
    read: u64,
    new_bytes: u64,
}

fn put(cx: &Cx<'_>, batch: &[([u8; 32], Vec<u8>, bool)]) -> Result<Vec<ChunkMeta>, String> {
    let chunks: Vec<NewChunk<'_>> = batch.iter().map(|(hash, data, mid_line)| NewChunk { hash: *hash, data, mid_line: *mid_line }).collect();
    cx.blobs.put_chunks(&chunks)
}

/// Records stored chunks in the index. Returns the bytes of those it hadn't seen.
fn add_chunks(cx: &Cx<'_>, db: &Connection, metas: &[ChunkMeta]) -> Result<u64, String> {
    let mut new_bytes = 0;
    for meta in metas {
        let added = db
            .execute(
                "INSERT OR IGNORE INTO chunks(hash, len, zlen, zhash, mid_line, first_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                params![meta.hash.to_vec(), meta.len as i64, meta.zlen as i64, meta.zhash.to_vec(), meta.mid_line, cx.now],
            )
            .map_err(db_error)?;
        if added > 0 {
            new_bytes += meta.len;
            emit(db, json!({"t": "chunk", "h": hex(&meta.hash), "len": meta.len, "zlen": meta.zlen, "zhash": hex(&meta.zhash), "mid": meta.mid_line}))?;
        }
        db.execute("INSERT OR IGNORE INTO chunk_copies(hash, store_id, state, checked_at) VALUES(?1, ?2, 1, ?3)", params![meta.hash.to_vec(), cx.blobs.store_id(), cx.now]).map_err(db_error)?;
    }
    Ok(new_bytes)
}

/// Reads `version` on from its last whole chunk up to `to`, stores the chunks that makes, and
/// keeps the rest as its tail, or as its last chunk when `settle`. A settled version that grows
/// sets its old last chunk aside and carries on from where its whole chunks ended, so its
/// chunks come out the same as if it had never stopped. `new_member` makes `version` a new one.
fn grow(cx: &Cx<'_>, version: &Version, new_member: Option<i64>, source: &mut dyn Source, to: u64, settle: bool, expect: Option<[u8; 32]>) -> Result<Grown, String> {
    let limits = cx.limits;
    let start = version.committed_len;
    let (mut sha, hashed) = match version.committed_mid {
        Some(mid) if mid.len() == start / 64 * 64 => (Sha::resume(mid), mid.len()),
        _ => (Sha::new(), 0),
    };
    let mut read = start - hashed;
    if read > 0 {
        let mut before = vec![0u8; read as usize];
        source.read_exact_at(hashed, &mut before)?;
        sha.update(&before);
    }
    let mut cutter = LineCut::new(limits.rule);
    let mut out = Vec::new();
    let mut batch: Vec<([u8; 32], Vec<u8>, bool)> = Vec::new();
    let mut batch_bytes = 0;
    let mut metas = Vec::new();
    let mut rows: Vec<(u64, [u8; 32], u64)> = Vec::new();
    let (mut committed, mut mid, mut committed_sha) = (start, version.committed_mid, version.committed_sha);
    let mut buf = vec![0u8; (limits.piece as u64).min(to.saturating_sub(start)).max(1) as usize];
    let mut pos = start;
    while pos < to {
        let n = (to - pos).min(buf.len() as u64) as usize;
        source.read_exact_at(pos, &mut buf[..n])?;
        read += n as u64;
        pos += n as u64;
        cutter.push(&buf[..n], &mut out);
        for chunk in out.drain(..) {
            sha.update(&chunk.data);
            let hash = sha256(&chunk.data);
            let len = chunk.data.len() as u64;
            rows.push((committed, hash, len));
            committed += len;
            mid = Some(sha.midstate());
            committed_sha = Some(sha.finish());
            batch_bytes += chunk.data.len();
            batch.push((hash, chunk.data, chunk.mid_line));
            if batch_bytes >= limits.batch {
                metas.extend(put(cx, &batch)?);
                batch.clear();
                batch_bytes = 0;
            }
        }
    }
    let tail = cutter.into_tail();
    sha.update(&tail);
    let whole = sha.finish();
    if expect.is_some_and(|want| want != whole) {
        return Err(CHANGED.into());
    }
    let tail_sha = (!tail.is_empty()).then(|| sha256(&tail));
    if let Some(hash) = tail_sha.filter(|_| settle) {
        rows.push((committed, hash, tail.len() as u64));
        batch.push((hash, tail.clone(), !tail.ends_with(b"\n")));
    }
    if !batch.is_empty() {
        metas.extend(put(cx, &batch)?);
    }
    let anchor = limits.anchor.min(to);
    let head = range_sha(source, 0, anchor)?;
    let window = range_sha(source, to - anchor, anchor)?;
    read += anchor * 2;
    let gen = version.pending_gen + 1;
    if !settle && !tail.is_empty() {
        cx.blobs.put_pending(&version.vk, gen, &tail)?;
    }

    let transaction = cx.db.unchecked_transaction().map_err(db_error)?;
    let version_id = match new_member {
        Some(member_id) => {
            transaction
                .execute(
                    "INSERT INTO versions(vk, member_id, state, encoding, size, has_ordinal, created_at) VALUES(?1, ?2, 'growing', ?3, 0, ?4, ?5)",
                    params![version.vk, member_id, version.encoding, version.has_ordinal, cx.now],
                )
                .map_err(db_error)?;
            let id = transaction.last_insert_rowid();
            emit(&transaction, json!({"t": "version", "id": id, "v": version.vk, "member": member_id, "encoding": version.encoding}))?;
            id
        }
        None => version.id,
    };
    if new_member.is_none() && version.state != "growing" {
        transaction
            .execute(
                "INSERT OR IGNORE INTO superseded(version_id, off, hash, len, at) SELECT version_id, off, hash, len, ?3 FROM version_chunks WHERE version_id = ?1 AND off >= ?2",
                params![version_id, start as i64, cx.now],
            )
            .map_err(db_error)?;
        transaction.execute("DELETE FROM version_chunks WHERE version_id = ?1 AND off >= ?2", params![version_id, start as i64]).map_err(db_error)?;
        emit(&transaction, json!({"t": "resume", "v": version_id, "off": start}))?;
    }
    let new_bytes = add_chunks(cx, &transaction, &metas)?;
    let first_ord: i64 = transaction.query_row("SELECT COUNT(*) FROM version_chunks WHERE version_id = ?1", [version_id], |row| row.get(0)).map_err(db_error)?;
    for (index, (off, hash, len)) in rows.iter().enumerate() {
        transaction
            .execute("INSERT INTO version_chunks(version_id, ord, off, hash, len) VALUES(?1, ?2, ?3, ?4, ?5)", params![version_id, first_ord + index as i64, *off as i64, hash.to_vec(), *len as i64])
            .map_err(db_error)?;
    }
    if !rows.is_empty() {
        let listed: Vec<(String, u64)> = rows.iter().map(|(_, hash, len)| (hex(hash), *len)).collect();
        emit(&transaction, json!({"t": "grow", "v": version_id, "off": start, "chunks": listed}))?;
    }
    transaction
        .execute(
            "UPDATE versions SET state = ?2, committed_len = ?3, committed_mid = ?4, committed_sha = ?5, head_sha = ?6, win_sha = ?7, tail_len = ?8, tail_sha = ?9,
               pending_gen = ?10, size = ?11, sha256 = ?12, grew_at = ?13, settled_at = ?14 WHERE version_id = ?1",
            params![
                version_id,
                if settle { "settled" } else { "growing" },
                committed as i64,
                mid.map(|mid| mid.encode()),
                committed_sha.map(|sha| sha.to_vec()),
                head.to_vec(),
                window.to_vec(),
                tail.len() as i64,
                tail_sha.map(|sha| sha.to_vec()),
                gen,
                to as i64,
                whole.to_vec(),
                cx.now,
                settle.then_some(cx.now),
            ],
        )
        .map_err(db_error)?;
    if settle {
        emit(&transaction, json!({"t": "settle", "v": version_id, "size": to, "sha": hex(&whole)}))?;
    } else {
        emit(&transaction, json!({"t": "tail", "v": version_id, "off": committed, "len": tail.len(), "sha": tail_sha.map(|sha| hex(&sha)), "gen": gen}))?;
    }
    transaction.commit().map_err(db_error)?;
    cx.blobs.drop_pending(&version.vk, (!settle && !tail.is_empty()).then_some(gen));
    Ok(Grown { version_id, sha: whole, read, new_bytes })
}

/// Stops a version growing: its tail becomes its last chunk. A tail that can't be read back
/// is lost, and the version ends at its last whole chunk.
pub(crate) fn settle(cx: &Cx<'_>, version: &Version) -> Result<(), String> {
    if version.state != "growing" {
        return Ok(());
    }
    let tail = match tail_bytes(cx, version) {
        Ok(bytes) if bytes.len() as u64 == version.tail_len => Some(bytes),
        _ => None,
    };
    let transaction;
    match tail {
        Some(bytes) => {
            let metas = if bytes.is_empty() { Vec::new() } else { put(cx, &[(sha256(&bytes), bytes.clone(), !bytes.ends_with(b"\n"))])? };
            transaction = cx.db.unchecked_transaction().map_err(db_error)?;
            add_chunks(cx, &transaction, &metas)?;
            if let Some(meta) = metas.first() {
                let ord: i64 = transaction.query_row("SELECT COUNT(*) FROM version_chunks WHERE version_id = ?1", [version.id], |row| row.get(0)).map_err(db_error)?;
                transaction
                    .execute("INSERT INTO version_chunks(version_id, ord, off, hash, len) VALUES(?1, ?2, ?3, ?4, ?5)", params![version.id, ord, version.committed_len as i64, meta.hash.to_vec(), meta.len as i64])
                    .map_err(db_error)?;
                emit(&transaction, json!({"t": "grow", "v": version.id, "off": version.committed_len, "chunks": [[hex(&meta.hash), meta.len]]}))?;
            }
            transaction.execute("UPDATE versions SET state = 'settled', settled_at = ?2 WHERE version_id = ?1", params![version.id, cx.now]).map_err(db_error)?;
            emit(&transaction, json!({"t": "settle", "v": version.id, "size": version.size, "sha": version.sha256.map(|sha| hex(&sha))}))?;
        }
        None => {
            transaction = cx.db.unchecked_transaction().map_err(db_error)?;
            transaction
                .execute(
                    "UPDATE versions SET state = 'lost-tail', size = committed_len, sha256 = committed_sha, tail_len = 0, tail_sha = NULL, settled_at = ?2 WHERE version_id = ?1",
                    params![version.id, cx.now],
                )
                .map_err(db_error)?;
            emit(&transaction, json!({"t": "settle", "v": version.id, "size": version.committed_len, "sha": version.committed_sha.map(|sha| hex(&sha)), "lost": true}))?;
        }
    }
    transaction.commit().map_err(db_error)?;
    cx.blobs.drop_pending(&version.vk, None);
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::chunker::tests::Rng;
    use super::super::index;
    use super::*;
    use std::cell::RefCell;
    use std::collections::{BTreeSet, HashMap};

    /// Chunks and tails kept in memory.
    #[derive(Default)]
    pub(crate) struct MemBlobs {
        pub(crate) chunks: RefCell<HashMap<[u8; 32], Vec<u8>>>,
        pub(crate) pending: RefCell<HashMap<(String, i64), Vec<u8>>>,
    }

    impl Blobs for MemBlobs {
        fn store_id(&self) -> &str {
            "mem"
        }
        fn put_chunks(&self, chunks: &[NewChunk<'_>]) -> Result<Vec<ChunkMeta>, String> {
            Ok(chunks
                .iter()
                .map(|chunk| {
                    assert_eq!(sha256(chunk.data), chunk.hash);
                    self.chunks.borrow_mut().insert(chunk.hash, chunk.data.to_vec());
                    ChunkMeta { hash: chunk.hash, len: chunk.data.len() as u64, zlen: chunk.data.len() as u64, zhash: chunk.hash, mid_line: chunk.mid_line }
                })
                .collect())
        }
        fn read_chunk(&self, hash: &[u8; 32]) -> Result<Vec<u8>, String> {
            self.chunks.borrow().get(hash).cloned().ok_or_else(|| "no such chunk".into())
        }
        fn put_pending(&self, vk: &str, gen: i64, tail: &[u8]) -> Result<(), String> {
            self.pending.borrow_mut().insert((vk.into(), gen), tail.to_vec());
            Ok(())
        }
        fn read_pending(&self, vk: &str, gen: i64) -> Result<Vec<u8>, String> {
            self.pending.borrow().get(&(vk.to_string(), gen)).cloned().ok_or_else(|| "no such tail".into())
        }
        fn drop_pending(&self, vk: &str, keep: Option<i64>) {
            self.pending.borrow_mut().retain(|(key, gen), _| key != vk || Some(*gen) == keep);
        }
    }

    pub(crate) const SMALL: Limits = Limits { rule: Rule { target: 16, max: 48 }, full_check_max: 1 << 30, keep_max: 1 << 20, batch: 64, piece: 7, samples: 2, anchor: 8 };

    pub(crate) struct World {
        pub(crate) db: Connection,
        pub(crate) blobs: MemBlobs,
        pub(crate) limits: Limits,
        pub(crate) member: i64,
        pub(crate) now: i64,
    }

    impl World {
        pub(crate) fn new(limits: Limits) -> Self {
            let db = index::memory();
            db.execute_batch(
                "INSERT INTO stores(store_id, role, machine, root, added_at) VALUES('mem', 'main', 'mac', '/s', 0);
                 INSERT INTO sources(source_id, machine, kind, agent, root, label, first_seen_at) VALUES(1, 'mac', 'home', 'codex', '/h', '~', 0);
                 INSERT INTO sessions(session_pk, agent, session_id, first_seen_at) VALUES(1, 'codex', 's1', 0);
                 INSERT INTO members(member_id, session_pk, member) VALUES(1, 1, 'rollout');",
            )
            .unwrap();
            World { db, blobs: MemBlobs::default(), limits, member: 1, now: 1_000 }
        }

        pub(crate) fn file(&self, id: i64) -> i64 {
            self.db.execute("INSERT OR IGNORE INTO files(file_id, source_id, rel_path, first_seen_at, last_seen_at) VALUES(?1, 1, ?2, 0, 0)", params![id, format!("f{id}")]).unwrap();
            id
        }

        pub(crate) fn see(&self, file: i64, bytes: &[u8], stat: (u64, i64, i64), settle: bool, ordinal: Option<bool>) -> Observed {
            let cx = Cx { db: &self.db, blobs: &self.blobs, limits: self.limits, now: self.now };
            let target = Target { file_id: self.file(file), member_id: self.member, agent: "codex", encoding: "plain", has_ordinal: ordinal, settle };
            let seen = Seen { dev: 1, ino: stat.0, size: bytes.len() as u64, mtime_ns: stat.1, ctime_ns: stat.2 };
            observe(&cx, &target, seen, &mut &bytes[..]).unwrap()
        }

        fn cx(&self) -> Cx<'_> {
            Cx { db: &self.db, blobs: &self.blobs, limits: self.limits, now: self.now }
        }

        /// Every version's bytes, put back together from what was stored.
        pub(crate) fn contents(&self) -> Vec<(i64, Vec<u8>)> {
            let ids: Vec<i64> = self.db.prepare("SELECT version_id FROM versions ORDER BY version_id").unwrap().query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
            ids.into_iter()
                .map(|id| {
                    let version = load_version(&self.db, id).unwrap();
                    let mut bytes: Vec<u8> = version.chunks.iter().flat_map(|(_, hash, _)| self.blobs.read_chunk(hash).unwrap()).collect();
                    if version.state == "growing" {
                        bytes.extend(tail_bytes(&self.cx(), &version).unwrap());
                    }
                    assert_eq!(bytes.len() as u64, version.size, "version {id}");
                    assert_eq!(Some(sha256(&bytes)), version.sha256, "version {id}");
                    (id, bytes)
                })
                .collect()
        }

        fn relations(&self) -> Vec<(i64, i64, String, i64)> {
            self.db.prepare("SELECT a, b, kind, common_len FROM relations ORDER BY a, b").unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).unwrap().map(Result::unwrap).collect()
        }
    }

    fn lines(text: &[&str]) -> Vec<u8> {
        text.iter().flat_map(|line| format!("{line}\n").into_bytes()).collect()
    }

    #[test]
    fn sorts_a_file_as_identical_a_start_a_carrying_on_or_new() {
        let world = World::new(SMALL);
        let full = lines(&["{\"a\":1}", "{\"b\":22222222222}", "{\"c\":3}", "{\"d\":4444444444444444444}", "{\"e\":5}"]);
        let first = world.see(1, &full[..30], (1, 1, 1), false, None);
        assert_eq!(first.outcome, Outcome::New);
        // The same bytes somewhere else take no room.
        let copy = world.see(2, &full[..30], (2, 1, 1), false, None);
        assert_eq!((copy.outcome, copy.version_id, copy.bytes_new), (Outcome::Identical, first.version_id, 0));
        // Unchanged since last time: nothing is read.
        assert_eq!(world.see(2, &full[..30], (2, 1, 1), false, None).outcome, Outcome::Unchanged);
        // The file grew: the same version carries on.
        let grew = world.see(1, &full, (1, 2, 2), false, None);
        assert_eq!((grew.outcome, grew.version_id), (Outcome::Grew, first.version_id));
        // The old copy is the start of it now.
        assert_eq!(world.see(2, &full[..20], (2, 3, 3), false, None).outcome, Outcome::Prefix);
        // Something else entirely is a new version.
        let other = lines(&["{\"a\":1}", "{\"x\":9}"]);
        let new = world.see(3, &other, (3, 1, 1), false, None);
        assert_eq!(new.outcome, Outcome::New);
        let contents = world.contents();
        assert_eq!(contents, [(first.version_id, full.clone()), (new.version_id, other)]);
        assert_eq!(world.relations(), [(first.version_id, new.version_id, "diverged".into(), 8)]);
    }

    #[test]
    fn a_new_version_says_how_it_differs() {
        let world = World::new(SMALL);
        let legacy = lines(&["{\"type\":\"session_meta\",\"id\":\"s1\"}", "{\"turn\":1}"]);
        let original = world.see(1, &legacy, (1, 1, 1), true, Some(false)).version_id;
        // The first line differs: rewritten.
        let rewritten = world.see(2, &lines(&["{\"type\":\"session_meta\",\"id\":\"s1\",\"x\":1}", "{\"turn\":1}"]), (2, 1, 1), true, Some(false)).version_id;
        // Codex's newer format numbers every line: reshaped.
        let reshaped = world.see(3, &lines(&["{\"ordinal\":0,\"type\":\"session_meta\",\"id\":\"s1\"}", "{\"ordinal\":1,\"turn\":1}"]), (3, 1, 1), true, Some(true)).version_id;
        let relations = world.relations();
        assert_eq!(relations[0], (original, rewritten, "rewritten".into(), 0));
        assert_eq!(relations[1].1, reshaped);
        assert_eq!(relations[1].2, "reshaped");
    }

    #[test]
    fn the_versions_kept_dont_depend_on_the_order_files_arrive_in() {
        let base = lines(&["{\"one\":1}", "{\"two\":22222}", "{\"three\":3}", "{\"four\":44444444}", "{\"five\":5}", "{\"six\":666666666666}"]);
        let mut longer = base.clone();
        longer.extend(lines(&["{\"seven\":7}"]));
        let mut branch = base[..33].to_vec();
        branch.extend(lines(&["{\"other\":0}", "{\"more\":1}"]));
        let mut rewritten = base.clone();
        rewritten[2] = b'O';
        let files: Vec<Vec<u8>> = vec![base[..12].to_vec(), base[..40].to_vec(), base.clone(), longer, branch, rewritten];
        let mut expected: Option<(BTreeSet<(Vec<u8>, usize)>, BTreeSet<(Vec<u8>, i64, i64)>)> = None;
        let mut order: Vec<usize> = (0..files.len()).collect();
        let mut count = 0;
        permute(&mut order, 0, &mut |order| {
            count += 1;
            let world = World::new(SMALL);
            for (step, &index) in order.iter().enumerate() {
                world.see(index as i64 + 1, &files[index], (index as u64 + 1, 1, 1), step % 2 == 0, None);
            }
            let versions: BTreeSet<(Vec<u8>, usize)> = world.contents().into_iter().map(|(_, bytes)| (sha256(&bytes).to_vec(), bytes.len())).collect();
            let seen: BTreeSet<(Vec<u8>, i64, i64)> = world
                .db
                .prepare("SELECT v.sha256, o.file_id, o.len FROM observations o JOIN versions v USING (version_id)")
                .unwrap()
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            match &expected {
                None => expected = Some((versions, seen)),
                Some((want_versions, want_seen)) => {
                    assert_eq!(&versions, want_versions, "{order:?}");
                    assert_eq!(&seen, want_seen, "{order:?}");
                }
            }
        });
        assert_eq!(count, 720);
        let (versions, seen) = expected.unwrap();
        // The longest of the straight line, the branch, and the rewrite.
        assert_eq!(versions.len(), 3);
        // Each start is noted against every version it starts: the shortest starts two.
        assert_eq!(seen.len(), 2 + 1 + 1 + 1 + 1 + 1);
    }

    fn permute(items: &mut Vec<usize>, from: usize, visit: &mut dyn FnMut(&[usize])) {
        if from == items.len() {
            visit(items);
            return;
        }
        for index in from..items.len() {
            items.swap(from, index);
            permute(items, from + 1, visit);
            items.swap(from, index);
        }
    }

    #[test]
    fn a_settled_version_that_grows_again_comes_out_as_if_it_never_stopped() {
        let mut rng = Rng(5);
        let mut data = rng.lines(40, 20);
        data.extend(b"{\"unfinished\":");
        let steady = World::new(SMALL);
        let stopped = World::new(SMALL);
        let cuts = [37, 110, 111, 300, data.len()];
        for (step, &cut) in cuts.iter().enumerate() {
            steady.see(1, &data[..cut], (1, step as i64, step as i64), false, None);
            stopped.see(1, &data[..cut], (1, step as i64, step as i64), true, None);
        }
        let chunk_list = |world: &World| world.db.prepare("SELECT off, hash, len FROM version_chunks ORDER BY ord").unwrap().query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?, row.get::<_, i64>(2)?))).unwrap().map(Result::unwrap).collect::<Vec<_>>();
        let mut settled = chunk_list(&stopped);
        let last = settled.pop().unwrap();
        // The steady one's tail is pending; the stopped one's is its last chunk.
        assert_eq!(chunk_list(&steady), settled);
        assert_eq!(last.0, settled.iter().map(|chunk| chunk.2).sum::<i64>());
        assert_eq!(steady.contents()[0].1, data);
        assert_eq!(stopped.contents()[0].1, data);
        // The old last chunks were set aside, not lost.
        let aside: i64 = stopped.db.query_row("SELECT COUNT(*) FROM superseded", [], |row| row.get(0)).unwrap();
        assert!(aside > 0);
        // Settling the steady one gives the same list as the stopped one.
        let version = load_version(&steady.db, 1).unwrap();
        settle(&steady.cx(), &version).unwrap();
        assert_eq!(chunk_list(&steady).len(), settled.len() + 1);
        assert!(steady.blobs.pending.borrow().is_empty());
        assert_eq!(steady.contents()[0].1, data);
    }

    #[test]
    fn a_file_that_no_longer_carries_its_tail_on_is_a_new_version() {
        let world = World::new(SMALL);
        let data = lines(&["{\"a\":1111111111}", "{\"b\":2}", "{\"c\":3333}"]);
        let first = world.see(1, &data, (1, 1, 1), false, None).version_id;
        // The end was changed and more added: the old version stops, a new one starts.
        let mut spliced = data[..data.len() - 3].to_vec();
        spliced.extend(b"99}\n{\"d\":4}\n");
        let second = world.see(1, &spliced, (1, 2, 2), false, None);
        assert_eq!(second.outcome, Outcome::New);
        let state: String = world.db.query_row("SELECT state FROM versions WHERE version_id = ?1", [first], |row| row.get(0)).unwrap();
        assert_eq!(state, "settled");
        assert_eq!(world.contents(), [(first, data), (second.version_id, spliced)]);
    }

    #[test]
    fn a_file_smaller_than_a_chunk_rewritten_in_place_is_a_new_version() {
        // Like a memory note edited by an agent: the whole file is its growing tail.
        let world = World::new(SMALL);
        let data = b"a\nbb\n".to_vec();
        let first = world.see(1, &data, (1, 1, 1), false, None).version_id;
        let committed: i64 = world.db.query_row("SELECT committed_len FROM versions WHERE version_id = ?1", [first], |row| row.get(0)).unwrap();
        assert_eq!(committed, 0);
        let edited = b"a\nbc\nd\n".to_vec();
        let second = world.see(1, &edited, (1, 2, 2), false, None);
        assert_eq!(second.outcome, Outcome::New);
        assert_eq!(world.contents(), [(first, data), (second.version_id, edited)]);
        assert_eq!(world.relations(), [(first, second.version_id, "diverged".into(), 2)]);
    }

    #[test]
    fn a_big_file_that_grew_is_only_spot_checked_and_a_rewrite_is_read_whole() {
        let limits = Limits { full_check_max: 0, ..SMALL };
        let world = World::new(limits);
        let mut rng = Rng(9);
        let mut data = rng.lines(30, 20);
        world.see(1, &data, (1, 1, 1), false, None);
        let more = rng.lines(5, 20);
        let mut grown = data.clone();
        grown.extend(&more);
        let observed = world.see(1, &grown, (1, 2, 2), false, None);
        assert_eq!(observed.outcome, Outcome::Grew);
        assert!(observed.bytes_read < grown.len() as u64, "only the new end and a few checks are read");
        assert_eq!(world.contents()[0].1, grown);
        // An edit in the middle that the spot checks see is read whole, and is a new version.
        data = grown.clone();
        let middle = data.len() / 2;
        data[middle] = if data[middle] == b'q' { b'r' } else { b'q' };
        let mut edited = data.clone();
        edited.extend(rng.lines(2, 20));
        let mut caught = false;
        for step in 0..60 {
            // Spot checks rotate, so a later growth checks other chunks.
            let observed = world.see(1, &edited, (1, 3 + step, 3 + step), false, None);
            if observed.outcome == Outcome::New {
                caught = true;
                break;
            }
            edited.extend(rng.lines(1, 20));
        }
        assert!(caught);
        // The same modified time with a different size is Codex rewriting in place: read whole.
        let world = World::new(limits);
        world.see(1, &grown, (1, 5, 5), false, None);
        let mut rewrite = grown.clone();
        rewrite[0] = b'[';
        rewrite.extend(b"x\n");
        assert_eq!(world.see(1, &rewrite, (1, 5, 5), false, None).outcome, Outcome::New);
    }

    #[test]
    fn a_small_file_changed_in_the_middle_is_always_caught() {
        let world = World::new(SMALL);
        let mut rng = Rng(3);
        let data = rng.lines(30, 20);
        world.see(1, &data, (1, 1, 1), false, None);
        let mut edited = data.clone();
        edited[data.len() / 3] ^= 1;
        edited.extend(b"more\n");
        assert_eq!(world.see(1, &edited, (1, 2, 2), false, None).outcome, Outcome::New);
    }
}

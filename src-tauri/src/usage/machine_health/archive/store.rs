//! A session archive store: a folder of chunks named by the SHA-256 of what
//! they hold, each one zstd frame, plus the journal and the growing tails.
//!
//! <root>/store.json   what this store is, written once
//!        README.txt   how to read it back without Arbor
//!        LOCK         held by the one Arbor writing to it
//!        chunks/<hh>/<sha256>.zst
//!        pending/<version key>.<gen>.zst   copies of growing versions' tails
//!        journal/<first seq>.jsonl         every change to the index, in order
//!        index/  quarantine/  tmp/
//!
//! Nothing in chunks/ is ever deleted or rewritten, except a file proven not
//! to hold what its name says, which goes to quarantine/ first. A store is
//! never made implicitly, and one is only written to after its store.json,
//! mount point and disk say it's the store Arbor was set up with.

use super::codec;
use super::sha::{hex, sha256};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub(crate) const FORMAT: &str = "arbor-session-archive";
const FORMAT_VERSION: u32 = 1;
const STORE_FILE: &str = "store.json";
const README_FILE: &str = "README.txt";
const LOCK_FILE: &str = "LOCK";
const DIRS: [&str; 6] = ["chunks", "pending", "journal", "index", "quarantine", "tmp"];
/// Scratch left behind by a writer that stopped is cleared after this long.
const TMP_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// Files the Finder leaves in any folder it has shown, which don't make a folder "not empty".
pub(crate) const FINDER_FILES: [&str; 2] = [".DS_Store", ".localized"];
/// MNT_IGNORE_OWNERSHIP: the volume doesn't enforce owners or modes.
#[cfg(target_os = "macos")]
const IGNORE_OWNERSHIP: u32 = 0x0020_0000;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoreInfo {
    pub(crate) format: String,
    pub(crate) format_version: u32,
    pub(crate) archive_id: String,
    pub(crate) store_id: String,
    pub(crate) role: String,
    pub(crate) chunking: Chunking,
    pub(crate) codec: Codec,
    pub(crate) hash: String,
    pub(crate) created_at: String,
    pub(crate) created_by: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct Chunking {
    pub(crate) id: String,
    pub(crate) target: u64,
    pub(crate) max: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct Codec {
    pub(crate) id: String,
    pub(crate) level: u32,
    pub(crate) frame: String,
}

/// What a folder is, before an archive is made or used there.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderCheck {
    pub(crate) kind: FolderKind,
    /// On this Mac's own disk, where Arbor keeps the index: an archive there doesn't outlive the disk it backs up.
    pub(crate) own_disk: bool,
    pub(crate) free_bytes: Option<u64>,
    pub(crate) mount_point: Option<String>,
    pub(crate) noowners: bool,
    pub(crate) archive_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum FolderKind {
    /// Not there yet, in a folder that is: an archive can be made here.
    Empty,
    /// An archive, the one Arbor already uses or another.
    Archive,
    /// Something else is in it.
    NotEmpty,
    /// Neither it nor the folder it would go in is there.
    Missing,
    NotWritable,
}

/// Where a folder is mounted, how much room it has and whether its disk enforces owners.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Volume {
    pub(crate) dev: Option<u64>,
    pub(crate) mount_point: Option<String>,
    pub(crate) free_bytes: Option<u64>,
    pub(crate) noowners: bool,
}

pub(crate) fn volume(path: &Path) -> Volume {
    let dev = device(path);
    #[cfg(target_os = "macos")]
    {
        use std::ffi::{CStr, CString};
        use std::os::unix::ffi::OsStrExt;
        if let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) {
            let mut stats: libc::statfs = unsafe { std::mem::zeroed() };
            if unsafe { libc::statfs(c_path.as_ptr(), &mut stats) } == 0 {
                let mount_point = unsafe { CStr::from_ptr(stats.f_mntonname.as_ptr()) }.to_string_lossy().into_owned();
                return Volume {
                    dev,
                    mount_point: Some(mount_point),
                    free_bytes: Some(stats.f_bavail.saturating_mul(u64::from(stats.f_bsize))),
                    noowners: ignores_ownership(stats.f_flags),
                };
            }
        }
    }
    Volume { dev, ..Volume::default() }
}

#[cfg(target_os = "macos")]
fn ignores_ownership(flags: u32) -> bool {
    flags & IGNORE_OWNERSHIP != 0
}

fn device(path: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path).ok().map(|meta| meta.dev())
}

/// The nearest folder that's there, for a store that isn't made yet.
fn existing_ancestor(path: &Path) -> Option<&Path> {
    path.ancestors().find(|ancestor| ancestor.is_dir())
}

fn read_info(root: &Path) -> Option<Result<StoreInfo, String>> {
    let text = match fs::read_to_string(root.join(STORE_FILE)) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => return Some(Err(format!("Couldn't read {STORE_FILE}: {error}"))),
    };
    Some(serde_json::from_str::<StoreInfo>(&text).map_err(|error| format!("{STORE_FILE} isn't an archive's: {error}")).and_then(|info| {
        if info.format == FORMAT {
            Ok(info)
        } else {
            Err(format!("{STORE_FILE} belongs to something else"))
        }
    }))
}

/// Says what `root` is. `index_dev` is the disk Arbor keeps its index on; a store there
/// wouldn't survive the disk it's meant to back up, which the check says so the user can choose.
pub(crate) fn check_folder(root: &Path, index_dev: Option<u64>) -> FolderCheck {
    let on = existing_ancestor(root).map(volume).unwrap_or_default();
    let own_disk = index_dev.is_some() && on.dev == index_dev;
    let mut check = FolderCheck { kind: FolderKind::Missing, own_disk, free_bytes: on.free_bytes, mount_point: on.mount_point.clone(), noowners: on.noowners, archive_id: None };
    if !root.is_absolute() {
        return check;
    }
    if let Some(info) = read_info(root) {
        check.kind = FolderKind::Archive;
        check.archive_id = info.ok().map(|info| info.archive_id);
        if check.archive_id.is_none() {
            check.kind = FolderKind::NotEmpty;
        }
        return check;
    }
    check.kind = if root.is_dir() {
        match fs::read_dir(root) {
            Ok(entries) => {
                let others = entries.flatten().any(|entry| !FINDER_FILES.iter().any(|name| entry.file_name() == *name));
                if others { FolderKind::NotEmpty } else { FolderKind::Empty }
            }
            Err(_) => FolderKind::NotWritable,
        }
    } else if root.exists() {
        FolderKind::NotEmpty
    } else if root.parent().is_some_and(Path::is_dir) {
        FolderKind::Empty
    } else {
        FolderKind::Missing
    };
    if check.kind == FolderKind::Empty && !writable(existing_ancestor(root).unwrap_or(root)) {
        check.kind = FolderKind::NotWritable;
    }
    check
}

fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".arbor-write-check-{}", std::process::id()));
    let ok = File::create(&probe).is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

pub(crate) fn random_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |time| time.as_nanos());
        bytes = (nanos ^ u128::from(std::process::id())).to_le_bytes();
    }
    hex(&bytes)
}

/// Whether `path` is a folder itself, not a link to one.
fn real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

/// Makes one of the store's own folders. One that's there already has to be a folder and not a
/// link: a store is on a drive others may write to, and a link would send writes and the
/// clearing of tmp/ somewhere outside it.
fn make_dir(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && real_dir(path) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(format!("{} isn't a folder of the archive's own, so Arbor won't write through it", path.display())),
        Err(error) => Err(format!("Couldn't make {}: {error}", path.display())),
    }
}

fn new_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|error| format!("Couldn't write {}: {error}", path.display()))
}

/// Flushes a folder's list of names to disk, after a rename into it.
fn sync_dir(dir: &Path) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    let handle = File::open(dir).map_err(|error| format!("Couldn't open {}: {error}", dir.display()))?;
    if unsafe { libc::fsync(handle.as_raw_fd()) } != 0 {
        return Err(format!("Couldn't flush {}: {}", dir.display(), std::io::Error::last_os_error()));
    }
    Ok(())
}

/// Writes a whole file beside where it goes, flushes it, then moves it into place.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| format!("{} has no folder", path.display()))?;
    let temp = dir.join(format!(".{}.{}.tmp", path.file_name().and_then(|name| name.to_str()).unwrap_or("file"), random_id()));
    let result = (|| {
        let mut file = new_file(&temp)?;
        file.write_all(bytes).map_err(|error| format!("Couldn't write {}: {error}", temp.display()))?;
        file.sync_all().map_err(|error| format!("Couldn't flush {}: {error}", temp.display()))?;
        fs::rename(&temp, path).map_err(|error| format!("Couldn't put {} in place: {error}", path.display()))?;
        sync_dir(dir)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// A stored chunk's facts, as the index keeps them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ChunkMeta {
    pub(crate) hash: [u8; 32],
    pub(crate) len: u64,
    pub(crate) zlen: u64,
    pub(crate) zhash: [u8; 32],
    pub(crate) mid_line: bool,
}

pub(crate) struct NewChunk<'a> {
    pub(crate) hash: [u8; 32],
    pub(crate) data: &'a [u8],
    pub(crate) mid_line: bool,
}

pub(crate) struct Store {
    root: PathBuf,
    info: StoreInfo,
    _lock: File,
}

impl Store {
    /// Makes a new store at `root`, which must be missing or empty, and opens it.
    pub(crate) fn create(root: &Path, archive_id: &str, machine: &str, index_dev: Option<u64>) -> Result<Store, String> {
        let check = check_folder(root, index_dev);
        match check.kind {
            FolderKind::Empty => {}
            FolderKind::Archive => return Err("There's already an archive there. Use it instead.".into()),
            FolderKind::NotEmpty => return Err("That folder has other things in it. Choose an empty one.".into()),
            FolderKind::Missing => return Err("That folder isn't there.".into()),
            FolderKind::NotWritable => return Err("Arbor can't write to that folder.".into()),
        }
        // The folder the user picked may be reached through a link; only what's made in it is held to `make_dir`.
        if !root.is_dir() {
            make_dir(root)?;
        }
        for dir in DIRS {
            make_dir(&root.join(dir))?;
        }
        let info = StoreInfo {
            format: FORMAT.into(),
            format_version: FORMAT_VERSION,
            archive_id: archive_id.into(),
            store_id: random_id(),
            role: "main".into(),
            chunking: Chunking { id: "linecut-v1".into(), target: super::chunker::TARGET as u64, max: super::chunker::MAX as u64 },
            codec: Codec { id: "zstd".into(), level: 6, frame: "checksum+contentsize".into() },
            hash: "sha256".into(),
            created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            created_by: machine.into(),
        };
        write_atomic(&root.join(README_FILE), README.as_bytes())?;
        let json = serde_json::to_vec_pretty(&info).map_err(|error| error.to_string())?;
        write_atomic(&root.join(STORE_FILE), &json)?;
        Store::open(root, archive_id)
    }

    /// Opens the store at `root` for writing, if it's the archive `archive_id`.
    pub(crate) fn open(root: &Path, archive_id: &str) -> Result<Store, String> {
        let info = match read_info(root) {
            None => return Err(format!("There's no archive at {}", root.display())),
            Some(info) => info?,
        };
        if info.archive_id != archive_id {
            return Err(format!("The archive at {} is a different one", root.display()));
        }
        if info.format_version > FORMAT_VERSION {
            return Err("That archive was made by a newer Arbor".into());
        }
        for dir in DIRS {
            make_dir(&root.join(dir))?;
        }
        let lock = lock(&root.join(LOCK_FILE))?;
        clear_old_tmp(&root.join("tmp"));
        Ok(Store { root: root.to_path_buf(), info, _lock: lock })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn info(&self) -> &StoreInfo {
        &self.info
    }

    fn chunk_path(&self, hash: &[u8; 32]) -> PathBuf {
        chunk_path_in(&self.root, hash)
    }

    /// Reads a chunk back and checks it holds what its name says.
    pub(crate) fn read_chunk(&self, hash: &[u8; 32]) -> Result<Vec<u8>, String> {
        read_chunk_in(&self.root, hash)
    }

    /// Stores each chunk not already here, checked, flushed and moved into place, and gives
    /// back every chunk's facts. Nothing is referenced from the index until this returns.
    pub(crate) fn put_chunks(&self, chunks: &[NewChunk<'_>]) -> Result<Vec<ChunkMeta>, String> {
        let scratch = self.root.join("tmp").join(format!("{}-{}", std::process::id(), random_id()));
        make_dir(&scratch)?;
        let result = self.put_in(&scratch, chunks);
        let _ = fs::remove_dir_all(&scratch);
        result
    }

    fn put_in(&self, scratch: &Path, chunks: &[NewChunk<'_>]) -> Result<Vec<ChunkMeta>, String> {
        let mut metas = Vec::with_capacity(chunks.len());
        let mut moves: Vec<(PathBuf, PathBuf)> = Vec::new();
        for chunk in chunks {
            if sha256(chunk.data) != chunk.hash {
                return Err("A chunk changed while it was being stored".into());
            }
            let path = self.chunk_path(&chunk.hash);
            if let Some(meta) = self.existing(&path, chunk)? {
                metas.push(meta);
                continue;
            }
            if moves.iter().any(|(_, to)| *to == path) {
                let first = metas.iter().find(|meta| meta.hash == chunk.hash).cloned();
                metas.extend(first);
                continue;
            }
            let frame = codec::encode(chunk.data)?;
            if codec::decode(&frame)? != chunk.data {
                return Err("zstd didn't give back what it was given".into());
            }
            let temp = scratch.join(path.file_name().unwrap_or_default());
            let mut file = new_file(&temp)?;
            file.write_all(&frame).map_err(|error| format!("Couldn't write a chunk: {error}"))?;
            flush(&file)?;
            metas.push(ChunkMeta { hash: chunk.hash, len: chunk.data.len() as u64, zlen: frame.len() as u64, zhash: sha256(&frame), mid_line: chunk.mid_line });
            moves.push((temp, path));
        }
        let mut dirs: Vec<PathBuf> = Vec::new();
        for (from, to) in &moves {
            let dir = to.parent().unwrap_or(&self.root).to_path_buf();
            make_dir(&dir)?;
            fs::rename(from, to).map_err(|error| format!("Couldn't put a chunk in place: {error}"))?;
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
        for dir in &dirs {
            sync_dir(dir)?;
        }
        if !moves.is_empty() {
            // One full flush makes everything above durable on macOS, where fsync alone doesn't.
            File::open(self.root.join(STORE_FILE)).and_then(|file| file.sync_all()).map_err(|error| format!("Couldn't flush the archive: {error}"))?;
        }
        Ok(metas)
    }

    /// A chunk already stored under its name, if it holds what the name says. One that doesn't
    /// goes to quarantine so a good copy can take its place.
    fn existing(&self, path: &Path, chunk: &NewChunk<'_>) -> Result<Option<ChunkMeta>, String> {
        let Ok(frame) = fs::read(path) else {
            return Ok(None);
        };
        if codec::decode(&frame).is_ok_and(|plain| plain == chunk.data) {
            return Ok(Some(ChunkMeta { hash: chunk.hash, len: chunk.data.len() as u64, zlen: frame.len() as u64, zhash: sha256(&frame), mid_line: chunk.mid_line }));
        }
        let aside = self.root.join("quarantine").join(format!("{}.{}", path.file_name().and_then(|name| name.to_str()).unwrap_or("chunk"), random_id()));
        fs::rename(path, &aside).map_err(|error| format!("Couldn't set a damaged chunk aside: {error}"))?;
        Ok(None)
    }

    /// Keeps a copy of a growing version's tail beside the chunks. The one before stays until
    /// the index has moved on to this one.
    pub(crate) fn put_pending(&self, key: &str, gen: i64, frame: &[u8]) -> Result<(), String> {
        write_atomic(&self.root.join("pending").join(format!("{key}.{gen}.zst")), frame)
    }

    pub(crate) fn read_pending(&self, key: &str, gen: i64) -> Result<Vec<u8>, String> {
        read_pending_in(&self.root, key, gen)
    }

    /// Removes the copies of a version's tail, except `keep`.
    pub(crate) fn drop_pending(&self, key: &str, keep: Option<i64>) {
        drop_pending_in(&self.root.join("pending"), key, keep);
    }
}

fn chunk_path_in(root: &Path, hash: &[u8; 32]) -> PathBuf {
    let name = hex(hash);
    root.join("chunks").join(&name[..2]).join(format!("{name}.zst"))
}

/// Reads a chunk from the store at `root` and checks it holds what its name says. Chunks never change, so this
/// needs no lock and reads beside a pass that's writing.
pub(crate) fn read_chunk_in(root: &Path, hash: &[u8; 32]) -> Result<Vec<u8>, String> {
    let frame = fs::read(chunk_path_in(root, hash)).map_err(|error| format!("Couldn't read chunk {}: {error}", &hex(hash)[..12]))?;
    let plain = codec::decode(&frame)?;
    if sha256(&plain) != *hash {
        return Err(format!("Chunk {} doesn't hold what its name says", &hex(hash)[..12]));
    }
    Ok(plain)
}

pub(crate) fn read_pending_in(root: &Path, key: &str, gen: i64) -> Result<Vec<u8>, String> {
    let frame = fs::read(root.join("pending").join(format!("{key}.{gen}.zst"))).map_err(|error| format!("Couldn't read a kept tail: {error}"))?;
    codec::decode(&frame)
}

pub(crate) fn drop_pending_in(dir: &Path, key: &str, keep: Option<i64>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let prefix = format!("{key}.");
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(gen) = name.strip_prefix(&prefix).and_then(|rest| rest.strip_suffix(".zst")) else {
            continue;
        };
        if keep.is_none_or(|keep| gen != keep.to_string()) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn flush(file: &File) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::fsync(file.as_raw_fd()) } != 0 {
        return Err(format!("Couldn't flush a chunk: {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

fn lock(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path).map_err(|error| format!("Couldn't open the archive's lock: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // A process forked just as the lock was let go holds it until it execs, so a busy lock
        // is tried a few more times before it counts as another writer's.
        let mut tries = 0;
        while unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            tries += 1;
            if tries >= 10 {
                return Err("Another Arbor is writing to that archive".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    Ok(file)
}

fn clear_old_tmp(dir: &Path) {
    // Checked again right before clearing, so a tmp/ swapped for a link since never has its target cleared.
    if !real_dir(dir) {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry.metadata().and_then(|meta| meta.modified()).ok().and_then(|at| at.elapsed().ok()).is_some_and(|age| age > TMP_MAX_AGE);
        if old {
            let _ = fs::remove_dir_all(entry.path()).or_else(|_| fs::remove_file(entry.path()));
        }
    }
}

const README: &str = r#"Arbor session archive
=====================

Arbor keeps a byte-for-byte copy of every Claude Code and Codex session
transcript it finds here, including every version a file has had, so a
session that's since been deleted, rewritten or compacted can still be read.

Nothing here is encrypted. Treat it like the transcripts themselves.

What's here
-----------
store.json   Which archive this is. Written once.
chunks/      The transcripts, cut into pieces at line ends, each piece stored
             as one zstd frame and named by the SHA-256 of what it holds:
             chunks/<first two hex digits>/<sha256>.zst. `zstd -dc` reads one.
             Nothing in chunks/ is ever changed or deleted.
journal/     Every change to Arbor's index, one JSON object per line, in the
             order they happened. It names sessions, versions and chunks by
             id and hash, and holds no transcript text. From it and chunks/
             alone every version of every file can be put back together.
pending/     The newest end of files still growing, which haven't been cut
             into a chunk yet: pending/<version key>.<gen>.zst.
index/       Copies of Arbor's index database, when there are any.
quarantine/  Any chunk found not to hold what its name says, set aside.
tmp/         Scratch space while writing.

Putting files back together without Arbor
-----------------------------------------
Each journal line has "t" for its type. The ones that matter here:
  session  {"pk", "agent", "id"}                a session, by the agent's own id
  member   {"id", "session", "member"}          one of its files, like "main"
  version  {"id", "v", "member", "encoding"}    one distinct content of a member
  grow     {"v", "off", "chunks": [[sha256, length], ...]}  chunks added at off
  resume   {"v", "off"}                         drop chunks from off on (the old
                                                end of a file that grew again)
  tail     {"v", "off", "len", "sha", "gen"}    the growing end, in pending/
  settle   {"v", "size", "sha"}                 the version stopped growing

This python3 script rebuilds every version into a folder (it needs `zstd`):

  import json, os, subprocess, sys, glob
  store, out = sys.argv[1], sys.argv[2]
  sessions, members, versions = {}, {}, {}
  def unz(path): return subprocess.run(["zstd", "-dc", path], check=True, capture_output=True).stdout
  for name in sorted(glob.glob(os.path.join(store, "journal", "*.jsonl"))):
      for line in open(name):
          e = json.loads(line); t = e["t"]
          if t == "session": sessions[e["pk"]] = (e["agent"], e["id"])
          elif t == "member": members[e["id"]] = (e["session"], e["member"])
          elif t == "version": versions[e["id"]] = {"key": e["v"], "member": e["member"], "chunks": [], "tail": None, "settled": False}
          elif t == "resume": v = versions[e["v"]]; v["chunks"] = [c for c in v["chunks"] if c[2] < e["off"]]; v["settled"] = False
          elif t == "grow":
              v = versions[e["v"]]; off = e["off"]
              for h, n in e["chunks"]: v["chunks"].append((h, n, off)); off += n
          elif t == "tail": versions[e["v"]]["tail"] = e
          elif t == "settle": versions[e["v"]]["settled"] = True
  for vid, v in versions.items():
      pk, member = members[v["member"]]; agent, sid = sessions[pk]
      data = b"".join(unz(os.path.join(store, "chunks", h[:2], h + ".zst")) for h, _, _ in v["chunks"])
      if not v["settled"] and v["tail"] and v["tail"]["len"]:
          data += unz(os.path.join(store, "pending", "%s.%s.zst" % (v["key"], v["tail"]["gen"])))
      path = os.path.join(out, agent, sid, member.replace("/", "__") + ".v%d" % vid)
      os.makedirs(os.path.dirname(path), exist_ok=True)
      open(path, "wb").write(data)
"#;

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("arbor-archive-{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn made_only_in_an_empty_folder_and_opened_only_as_itself() {
        let base = temp_dir("create");
        let root = base.join("archive.noindex");
        assert_eq!(check_folder(&root, None).kind, FolderKind::Empty);
        assert_eq!(check_folder(&base.join("no/such/place"), None).kind, FolderKind::Missing);
        assert_eq!(check_folder(Path::new("relative"), None).kind, FolderKind::Missing);
        // A folder on the disk the index is on can hold one, and the check says where it is.
        let own = check_folder(&root, device(&base));
        assert_eq!((own.kind, own.own_disk), (FolderKind::Empty, true));
        assert!(!check_folder(&root, None).own_disk);

        let store = Store::create(&root, "a1", "mac", None).unwrap();
        assert_eq!(store.info().archive_id, "a1");
        let check = check_folder(&root, None);
        assert_eq!((check.kind, check.archive_id.as_deref()), (FolderKind::Archive, Some("a1")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(fs::metadata(root.join("chunks")).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(fs::metadata(root.join(STORE_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Only one writer at a time, and only the archive it was made as.
        assert!(Store::open(&root, "a1").is_err());
        drop(store);
        assert!(Store::open(&root, "other").is_err());
        if let Err(error) = Store::open(&root, "a1") {
            panic!("{error}");
        }
        assert!(Store::create(&root, "a2", "mac", None).is_err());

        // A folder with anything but the Finder's files in it is left alone.
        let busy = base.join("busy");
        fs::create_dir_all(&busy).unwrap();
        fs::write(busy.join(".DS_Store"), b"x").unwrap();
        assert_eq!(check_folder(&busy, None).kind, FolderKind::Empty);
        fs::write(busy.join("photo.jpg"), b"x").unwrap();
        assert_eq!(check_folder(&busy, None).kind, FolderKind::NotEmpty);
        assert!(Store::create(&busy, "a3", "mac", None).is_err());
        let foreign = base.join("foreign");
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join(STORE_FILE), br#"{"format":"something-else"}"#).unwrap();
        assert_eq!(check_folder(&foreign, None).kind, FolderKind::NotEmpty);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn chunks_are_stored_once_checked_and_read_back() {
        let base = temp_dir("chunks");
        let store = Store::create(&base.join("s"), "a1", "mac", None).unwrap();
        let one = b"line one\n".repeat(100);
        let two = b"line two\n".to_vec();
        let metas = store
            .put_chunks(&[
                NewChunk { hash: sha256(&one), data: &one, mid_line: false },
                NewChunk { hash: sha256(&two), data: &two, mid_line: true },
                NewChunk { hash: sha256(&one), data: &one, mid_line: false },
            ])
            .unwrap();
        assert_eq!(metas.len(), 3);
        assert_eq!(metas[0], metas[2]);
        assert!(metas[1].mid_line);
        assert_eq!(store.read_chunk(&sha256(&one)).unwrap(), one);
        let path = store.chunk_path(&sha256(&two));
        assert_eq!(sha256(&fs::read(&path).unwrap()), metas[1].zhash);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Stored again, nothing changes.
        let again = store.put_chunks(&[NewChunk { hash: sha256(&one), data: &one, mid_line: false }]).unwrap();
        assert_eq!(again[0], metas[0]);
        // A chunk given with the wrong name is refused before anything is written.
        assert!(store.put_chunks(&[NewChunk { hash: sha256(b"x"), data: b"y", mid_line: false }]).is_err());
        // One damaged on disk is caught on reading, and set aside when stored again.
        fs::write(&path, codec::encode(b"something else").unwrap()).unwrap();
        assert!(store.read_chunk(&sha256(&two)).is_err());
        store.put_chunks(&[NewChunk { hash: sha256(&two), data: &two, mid_line: true }]).unwrap();
        assert_eq!(store.read_chunk(&sha256(&two)).unwrap(), two);
        assert_eq!(fs::read_dir(base.join("s/quarantine")).unwrap().count(), 1);
        // Scratch is cleaned up.
        assert_eq!(fs::read_dir(base.join("s/tmp")).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn pending_copies_keep_only_the_newest() {
        let base = temp_dir("pending");
        let store = Store::create(&base.join("s"), "a1", "mac", None).unwrap();
        store.put_pending("vk1", 1, &codec::encode(b"one").unwrap()).unwrap();
        store.put_pending("vk1", 2, &codec::encode(b"two").unwrap()).unwrap();
        store.put_pending("vk10", 1, &codec::encode(b"other").unwrap()).unwrap();
        assert_eq!(store.read_pending("vk1", 2).unwrap(), b"two");
        store.drop_pending("vk1", Some(2));
        let mut names: Vec<String> = fs::read_dir(base.join("s/pending")).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["vk1.2.zst", "vk10.1.zst"]);
        store.drop_pending("vk1", None);
        assert_eq!(fs::read_dir(base.join("s/pending")).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_store_whose_own_folders_are_links_is_never_written_through() {
        let base = temp_dir("store-links");
        let root = base.join("s");
        drop(Store::create(&root, "a1", "mac", None).unwrap());
        // Someone else's folder, with a day-old file in it that clearing tmp/ would take.
        let victim = base.join("victim");
        fs::create_dir_all(&victim).unwrap();
        let old = victim.join("thesis.txt");
        fs::write(&old, b"mine").unwrap();
        File::options().write(true).open(&old).unwrap().set_modified(SystemTime::now() - TMP_MAX_AGE * 2).unwrap();
        for dir in DIRS {
            let moved = base.join(format!("{dir}.real"));
            fs::rename(root.join(dir), &moved).unwrap();
            std::os::unix::fs::symlink(&victim, root.join(dir)).unwrap();
            assert!(Store::open(&root, "a1").is_err(), "{dir}/ as a link is refused");
            fs::remove_file(root.join(dir)).unwrap();
            fs::rename(&moved, root.join(dir)).unwrap();
        }
        // A file where a folder goes is refused too.
        fs::rename(root.join("tmp"), base.join("tmp.real")).unwrap();
        fs::write(root.join("tmp"), b"x").unwrap();
        assert!(Store::open(&root, "a1").is_err());
        fs::remove_file(root.join("tmp")).unwrap();
        fs::rename(base.join("tmp.real"), root.join("tmp")).unwrap();

        // A chunk folder swapped for a link once the store is open gets nothing written through it.
        let store = Store::open(&root, "a1").unwrap();
        let data = b"line\n".to_vec();
        let hash = sha256(&data);
        let shard = store.chunk_path(&hash).parent().unwrap().to_path_buf();
        let _ = fs::remove_dir(&shard);
        std::os::unix::fs::symlink(&victim, &shard).unwrap();
        assert!(store.put_chunks(&[NewChunk { hash, data: &data, mid_line: false }]).is_err());
        // Nor is a tmp/ swapped for one cleared through.
        fs::remove_dir(root.join("tmp")).unwrap();
        std::os::unix::fs::symlink(&victim, root.join("tmp")).unwrap();
        clear_old_tmp(&root.join("tmp"));
        let left: Vec<String> = fs::read_dir(&victim).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, ["thesis.txt"], "nothing outside the store is written or cleared");
        drop(store);
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_volume_that_ignores_owners_is_noticed() {
        assert!(ignores_ownership(0x0020_1000));
        assert!(!ignores_ownership(0x0000_1000));
        let here = volume(&std::env::temp_dir());
        assert!(here.mount_point.is_some() && here.free_bytes.is_some() && here.dev.is_some());
    }
}

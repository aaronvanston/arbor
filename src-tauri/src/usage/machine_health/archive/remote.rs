//! Reading another machine's session files over SSH, for a pass over that machine's homes.
//!
//! One script prints the byte ranges asked for, each framed so it comes back whole or not at
//! all, and compressed on the wire with zstd or gzip when the machine has one. Small files are
//! fetched whole, many to a run; bigger ones in windows as the pass reads them. The bytes only
//! ever sit in memory on their way to the store: nothing is written to a file on either
//! machine. The machine's own `stat` numbers come from its listing.
//!
//! Lines out, tab-separated, after a first line naming the compression (zstd, gzip or none):
//!   B index      the range's bytes follow, exactly as many as asked for
//!   Y index      ...and they're the file's: it didn't shrink while it was read
//!   X index      ...but they aren't: it shrank, or a read fell short
//!   C index      the file is shorter than the range: it changed
//!   G index      the file is gone
//!   N index      the file is there but can't be read
//!   E            the end

use crate::usage::diagnostics::MachineOp;
use super::super::shell::{run_streaming, shell_quote, Machine, MachineCommand};
use super::classify::{Seen, Source, CHANGED};
use super::codec;
use super::identity::HEAD_LIMIT;
use super::ingest::{Files, Throttle, GONE};
use super::lister::ListedFile;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A fetch is given up on after this long without a byte.
const IDLE: Duration = Duration::from_secs(60);
/// Compressions a machine is asked for, in order of preference.
const CODECS: [&str; 2] = ["zstd", "gzip"];
/// The longest line a reply has, but for the bytes it carries.
const LINE_MAX: usize = 64;

const FETCH_BODY: &str = r##"set -u
export LC_ALL=C
renice -n 10 $$ >/dev/null 2>&1
command -v ionice >/dev/null 2>&1 && ionice -c 3 -p $$ >/dev/null 2>&1
if stat -L -c %s / >/dev/null 2>&1; then size() { stat -L -c %s "$1" 2>/dev/null; }; else size() { stat -L -f %z "$1" 2>/dev/null; }; fi
r() {
  if [ ! -e "$4" ]; then printf 'G\t%s\n' "$1"; return 0; fi
  n=$(size "$4")
  case $n in ''|*[!0-9]*) printf 'N\t%s\n' "$1"; return 0 ;; esac
  if [ ! -f "$4" ] || [ ! -r "$4" ]; then printf 'N\t%s\n' "$1"; return 0; fi
  if [ "$n" -lt $(($2 + $3)) ]; then printf 'C\t%s\n' "$1"; return 0; fi
  printf 'B\t%s\n' "$1"
  c=$(tail -c +$(($2 + 1)) "$4" 2>/dev/null | head -c "$3" | tee /dev/fd/3 | wc -c | tr -d ' ')
  case $c in ''|*[!0-9]*) c=0 ;; esac
  if [ "$c" -lt "$3" ]; then head -c $(($3 - c)) /dev/zero; fi
  n=$(size "$4")
  case $n in ''|*[!0-9]*) n=0 ;; esac
  if [ "$c" -eq "$3" ] && [ "$n" -ge $(($2 + $3)) ]; then printf 'Y\t%s\n' "$1"; else printf 'X\t%s\n' "$1"; fi
}
"##;

/// Bytes wanted from a file on the machine: `len` of them from `off`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Range {
    pub(crate) path: String,
    pub(crate) off: u64,
    pub(crate) len: u64,
}

/// What came back for a range.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Piece {
    Bytes(Vec<u8>),
    /// The file is shorter than the range, or shrank while it was read.
    Changed,
    Gone,
    /// The file is there but couldn't be read.
    Unreadable,
}

impl Piece {
    fn error(&self) -> String {
        match self {
            Piece::Bytes(_) | Piece::Changed => CHANGED.to_string(),
            Piece::Gone => GONE.to_string(),
            Piece::Unreadable => "Couldn't read a session file".to_string(),
        }
    }
}

/// Gets ranges of files from a machine.
pub(crate) trait Fetch {
    /// A piece for each range, in order; an error when the machine couldn't be asked.
    fn fetch(&mut self, ranges: &[Range]) -> Result<Vec<Piece>, String>;
}

/// The script that prints `ranges`, compressed with the first of `codecs` the machine has.
pub(crate) fn fetch_script(ranges: &[Range], codecs: &[&str]) -> String {
    let mut script = String::from(FETCH_BODY);
    // Every range's bytes go through fd 3 as well as being counted, so a short read shows.
    script.push_str("body() {\n  exec 3>&1\n");
    for (index, range) in ranges.iter().enumerate() {
        script.push_str(&format!("  r {} {} {} {}\n", index + 1, range.off, range.len, shell_quote(&range.path)));
    }
    script.push_str("  printf 'E\\n'\n}\n");
    for (at, codec) in codecs.iter().enumerate() {
        let level = if *codec == "zstd" { "-q -1 -c" } else { "-1 -c" };
        let test = if at == 0 { "if" } else { "elif" };
        script.push_str(&format!("{test} command -v {codec} >/dev/null 2>&1; then printf '{codec}\\n'; body | {codec} {level}\n"));
    }
    if codecs.is_empty() {
        script.push_str("printf 'none\\n'; body\n");
    } else {
        script.push_str("else printf 'none\\n'; body\nfi\n");
    }
    script
}

fn garbled() -> std::io::Error {
    std::io::Error::other("The copy came back garbled")
}

/// Sorts what the script prints, once decompressed, into its pieces.
struct Frames {
    lens: Vec<u64>,
    pieces: Vec<Option<Piece>>,
    line: Vec<u8>,
    /// The range whose bytes are arriving, and those so far.
    body: Option<(usize, Vec<u8>)>,
    /// A range whose bytes have all come, waiting for the line that says they're whole.
    done: Option<(usize, Vec<u8>)>,
    ended: bool,
}

impl Frames {
    fn new(lens: Vec<u64>) -> Self {
        let pieces = vec![None; lens.len()];
        Frames { lens, pieces, line: Vec::new(), body: None, done: None, ended: false }
    }

    fn header(&mut self, line: &[u8]) -> std::io::Result<()> {
        let text = std::str::from_utf8(line).map_err(|_| garbled())?;
        if self.ended || self.done.as_ref().is_some_and(|_| !matches!(text.as_bytes().first(), Some(b'Y' | b'X'))) {
            return Err(garbled());
        }
        if text == "E" {
            self.ended = true;
            return Ok(());
        }
        let (kind, index) = text.split_once('\t').ok_or_else(garbled)?;
        let index = index.parse::<usize>().ok().and_then(|index| index.checked_sub(1)).filter(|index| *index < self.lens.len()).ok_or_else(garbled)?;
        if self.pieces[index].is_some() {
            return Err(garbled());
        }
        let piece = match kind {
            "B" if self.done.is_none() => {
                let len = usize::try_from(self.lens[index]).map_err(|_| garbled())?;
                if len == 0 {
                    self.done = Some((index, Vec::new()));
                } else {
                    self.body = Some((index, Vec::with_capacity(len)));
                }
                return Ok(());
            }
            "Y" | "X" => {
                let (_, bytes) = self.done.take().filter(|(at, _)| *at == index).ok_or_else(garbled)?;
                if kind == "Y" { Piece::Bytes(bytes) } else { Piece::Changed }
            }
            "C" => Piece::Changed,
            "G" => Piece::Gone,
            "N" => Piece::Unreadable,
            _ => return Err(garbled()),
        };
        self.pieces[index] = Some(piece);
        Ok(())
    }

    fn finish(self) -> Result<Vec<Piece>, String> {
        if !self.ended || self.body.is_some() || self.done.is_some() || !self.line.is_empty() {
            return Err("The copy stopped short".into());
        }
        self.pieces.into_iter().map(|piece| piece.ok_or_else(|| "The copy stopped short".to_string())).collect()
    }
}

impl Write for Frames {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let mut rest = bytes;
        while !rest.is_empty() {
            if let Some((index, body)) = self.body.as_mut() {
                let want = self.lens[*index] as usize - body.len();
                let take = want.min(rest.len());
                body.extend_from_slice(&rest[..take]);
                rest = &rest[take..];
                if body.len() as u64 == self.lens[*index] {
                    self.done = self.body.take();
                }
                continue;
            }
            match rest.iter().position(|byte| *byte == b'\n') {
                Some(at) => {
                    self.line.extend_from_slice(&rest[..at]);
                    rest = &rest[at + 1..];
                    let line = std::mem::take(&mut self.line);
                    self.header(&line)?;
                }
                None => {
                    self.line.extend_from_slice(rest);
                    rest = &[];
                }
            }
            if self.line.len() > LINE_MAX {
                return Err(garbled());
            }
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// How a reply is coming in: its first line, then decompressed as that line says.
enum Wire {
    Start(Vec<u8>, Frames),
    Plain(Frames),
    Zstd(zstd::stream::write::Decoder<'static, Frames>),
    Gzip(flate2::write::GzDecoder<Frames>),
}

/// A fetch's reply, taken in as it arrives.
pub(crate) struct Reply {
    wire: Option<Wire>,
}

impl Reply {
    pub(crate) fn new(lens: Vec<u64>) -> Self {
        Reply { wire: Some(Wire::Start(Vec::new(), Frames::new(lens))) }
    }

    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<(), String> {
        let wire = self.wire.take().ok_or("The copy came back garbled")?;
        let (wire, rest) = match wire {
            Wire::Start(mut line, frames) => match bytes.iter().position(|byte| *byte == b'\n') {
                None => {
                    line.extend_from_slice(bytes);
                    if line.len() > LINE_MAX {
                        return Err("The copy came back garbled".into());
                    }
                    self.wire = Some(Wire::Start(line, frames));
                    return Ok(());
                }
                Some(at) => {
                    line.extend_from_slice(&bytes[..at]);
                    let wire = match line.as_slice() {
                        b"zstd" => Wire::Zstd(zstd::stream::write::Decoder::new(frames).map_err(|error| format!("Couldn't decompress: {error}"))?),
                        b"gzip" => Wire::Gzip(flate2::write::GzDecoder::new(frames)),
                        b"none" => Wire::Plain(frames),
                        _ => return Err("The copy came back garbled".into()),
                    };
                    (wire, &bytes[at + 1..])
                }
            },
            wire => (wire, bytes),
        };
        let mut wire = wire;
        let written = match &mut wire {
            Wire::Start(..) => Ok(()),
            Wire::Plain(frames) => frames.write_all(rest),
            Wire::Zstd(decoder) => decoder.write_all(rest),
            Wire::Gzip(decoder) => decoder.write_all(rest),
        };
        written.map_err(|error| error.to_string())?;
        self.wire = Some(wire);
        Ok(())
    }

    pub(crate) fn finish(self) -> Result<Vec<Piece>, String> {
        let frames = match self.wire {
            None | Some(Wire::Start(..)) => return Err("The copy stopped short".into()),
            Some(Wire::Plain(frames)) => frames,
            Some(Wire::Zstd(mut decoder)) => {
                decoder.flush().map_err(|error| error.to_string())?;
                decoder.into_inner()
            }
            Some(Wire::Gzip(decoder)) => decoder.finish().map_err(|error| error.to_string())?,
        };
        frames.finish()
    }
}

/// Fetches through a machine's shell: SSH, or `sh` in tests.
pub(crate) struct ShellFetch {
    command: Box<dyn Fn() -> MachineCommand + Send>,
    runtime: tokio::runtime::Handle,
    codecs: Vec<&'static str>,
}

impl ShellFetch {
    pub(in crate::usage) fn on(machine: Machine, runtime: tokio::runtime::Handle) -> Self {
        ShellFetch { command: Box::new(move || MachineCommand::from(&machine)), runtime, codecs: CODECS.to_vec() }
    }
}

impl Fetch for ShellFetch {
    fn fetch(&mut self, ranges: &[Range]) -> Result<Vec<Piece>, String> {
        let script = fetch_script(ranges, &self.codecs);
        let mut reply = Reply::new(ranges.iter().map(|range| range.len).collect());
        self.runtime.block_on(run_streaming((self.command)(), MachineOp::ArchiveRead, &script, IDLE, &mut |bytes| reply.push(bytes)))?;
        reply.finish()
    }
}

/// How a machine's files are fetched.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Sizes {
    /// Files up to this size are fetched whole, several to a fetch, up to so many bytes and files.
    pub(crate) whole_max: u64,
    pub(crate) batch_bytes: u64,
    pub(crate) batch_files: usize,
    /// A bigger file is fetched a window at a time: this far ahead while it's read in order,
    /// and at least this much when a read jumps.
    pub(crate) read_ahead: u64,
    pub(crate) min_read: u64,
    /// The start of a bigger file fetched for the ids at its top.
    pub(crate) head: u64,
}

/// Whole files up to the size a changed file is read whole at (see `classify::LIMITS`), so a
/// file that's read twice is only fetched once.
pub(crate) const SIZES: Sizes = Sizes { whole_max: 64 << 20, batch_bytes: 64 << 20, batch_files: 500, read_ahead: 16 << 20, min_read: 256 << 10, head: 1 << 20 };

struct Window {
    path: PathBuf,
    off: u64,
    bytes: Vec<u8>,
    /// Where the last read from it ended, to tell a read carrying on from one that jumps.
    read_to: u64,
}

/// Another machine's files, for a pass over its listing.
pub(crate) struct RemoteFiles<'f> {
    fetch: &'f mut dyn Fetch,
    sizes: Sizes,
    throttle: Throttle,
    /// The files to fetch whole, in the order the pass reads them, and where each is in it.
    order: Vec<(PathBuf, u64)>,
    place: HashMap<PathBuf, usize>,
    fetched: HashMap<PathBuf, Piece>,
    window: Option<Window>,
    /// Why the machine stopped answering, after which nothing more is asked of it this pass.
    lost: Option<String>,
    /// Every byte fetched, whatever the pass made of it.
    pub(crate) bytes: u64,
}

impl<'f> RemoteFiles<'f> {
    pub(crate) fn new(fetch: &'f mut dyn Fetch, sizes: Sizes, bytes_per_second: u64) -> Self {
        RemoteFiles {
            fetch,
            sizes,
            throttle: Throttle::new(bytes_per_second),
            order: Vec::new(),
            place: HashMap::new(),
            fetched: HashMap::new(),
            window: None,
            lost: None,
            bytes: 0,
        }
    }

    fn ask(&mut self, ranges: &[Range]) -> Result<Vec<Piece>, String> {
        if let Some(lost) = &self.lost {
            return Err(lost.clone());
        }
        let wanted: u64 = ranges.iter().map(|range| range.len).sum();
        match self.fetch.fetch(ranges) {
            Ok(pieces) if pieces.len() == ranges.len() => {
                self.bytes += wanted;
                self.throttle.take(wanted);
                Ok(pieces)
            }
            Ok(_) => Err(self.lose("The copy came back garbled".into())),
            Err(error) => Err(self.lose(error)),
        }
    }

    fn lose(&mut self, error: String) -> String {
        self.lost = Some(error.clone());
        error
    }

    /// Fetches `path` whole, with the files the pass reads after it, as many as a fetch takes.
    fn fetch_whole(&mut self, path: &Path, size: u64) -> Result<(), String> {
        // Whatever's left from the last fetch wasn't read, as the pass stopped or skipped it.
        self.fetched.clear();
        let mut batch = vec![(path.to_path_buf(), size)];
        let mut bytes = size;
        if let Some(start) = self.place.get(path).copied() {
            for (next, next_size) in self.order.iter().skip(start + 1) {
                if batch.len() >= self.sizes.batch_files || bytes + next_size > self.sizes.batch_bytes {
                    break;
                }
                batch.push((next.clone(), *next_size));
                bytes += next_size;
            }
        }
        let ranges: Vec<Range> = batch.iter().map(|(path, size)| Range { path: path.to_string_lossy().into_owned(), off: 0, len: *size }).collect();
        let pieces = self.ask(&ranges)?;
        for ((path, _), piece) in batch.into_iter().zip(pieces) {
            self.fetched.insert(path, piece);
        }
        Ok(())
    }

    /// `len` bytes of a bigger file from `off`, fetching a window when they aren't in the last.
    fn read_at(&mut self, path: &Path, size: u64, off: u64, len: u64) -> Result<&[u8], String> {
        let end = off.checked_add(len).filter(|end| *end <= size).ok_or_else(|| CHANGED.to_string())?;
        let covered = self.window.as_ref().is_some_and(|window| window.path == path && window.off <= off && end <= window.off + window.bytes.len() as u64);
        if !covered {
            let carrying_on = self.window.as_ref().is_some_and(|window| window.path == path && window.read_to == off);
            let want = len.max(if carrying_on { self.sizes.read_ahead } else { self.sizes.min_read }).min(size - off);
            let range = Range { path: path.to_string_lossy().into_owned(), off, len: want };
            let piece = self.ask(std::slice::from_ref(&range))?.into_iter().next().unwrap_or(Piece::Changed);
            let Piece::Bytes(bytes) = piece else {
                return Err(piece.error());
            };
            self.window = Some(Window { path: path.to_path_buf(), off, bytes, read_to: off });
        }
        let Some(window) = self.window.as_mut() else {
            return Err(CHANGED.to_string());
        };
        window.read_to = end;
        let at = (off - window.off) as usize;
        Ok(&window.bytes[at..at + len as usize])
    }
}

impl Files for RemoteFiles<'_> {
    fn stat(&mut self, _path: &Path, listed: &ListedFile) -> Option<Seen> {
        Some(Seen {
            dev: listed.dev,
            ino: listed.ino,
            size: listed.size,
            mtime_ns: listed.mtime.saturating_mul(1_000_000_000),
            ctime_ns: listed.ctime.saturating_mul(1_000_000_000),
        })
    }

    fn plan(&mut self, files: &[(PathBuf, u64)]) {
        self.order = files.iter().filter(|(_, size)| *size <= self.sizes.whole_max).cloned().collect();
        self.place = self.order.iter().enumerate().map(|(at, (path, _))| (path.clone(), at)).collect();
    }

    fn ready(&mut self, path: &Path, size: u64) -> Result<(), String> {
        if size > self.sizes.whole_max {
            return self.read_at(path, size, 0, size.min(self.sizes.head)).map(|_| ());
        }
        if !self.fetched.contains_key(path) {
            self.fetch_whole(path, size)?;
        }
        match self.fetched.get(path) {
            Some(Piece::Bytes(_)) => Ok(()),
            Some(piece) => Err(piece.error()),
            None => Err(CHANGED.to_string()),
        }
    }

    fn head(&mut self, path: &Path, size: u64) -> Option<Vec<u8>> {
        let zst = path.extension().is_some_and(|ext| ext == "zst");
        let start = match self.fetched.get(path) {
            Some(Piece::Bytes(bytes)) if zst => return codec::decode_head(bytes.as_slice(), HEAD_LIMIT).ok(),
            Some(Piece::Bytes(bytes)) => return Some(bytes[..bytes.len().min(HEAD_LIMIT)].to_vec()),
            _ => self.read_at(path, size, 0, size.min(self.sizes.head)).ok()?,
        };
        if zst {
            return codec::decode_head(start, HEAD_LIMIT).ok();
        }
        Some(start[..start.len().min(HEAD_LIMIT)].to_vec())
    }

    fn open(&mut self, path: &Path, size: u64) -> Result<Box<dyn Source + '_>, String> {
        if size > self.sizes.whole_max {
            return Ok(Box::new(Windowed { files: self, path: path.to_path_buf(), size }));
        }
        self.ready(path, size)?;
        match self.fetched.remove(path) {
            Some(Piece::Bytes(bytes)) => Ok(Box::new(Held(bytes))),
            Some(piece) => Err(piece.error()),
            None => Err(CHANGED.to_string()),
        }
    }

    fn lost(&self) -> bool {
        self.lost.is_some()
    }
}

/// A file fetched whole.
struct Held(Vec<u8>);

impl Source for Held {
    fn read_exact_at(&mut self, off: u64, buf: &mut [u8]) -> Result<(), String> {
        let mut bytes: &[u8] = &self.0;
        bytes.read_exact_at(off, buf)
    }
}

/// A bigger file, fetched a window at a time.
struct Windowed<'a, 'f> {
    files: &'a mut RemoteFiles<'f>,
    path: PathBuf,
    size: u64,
}

impl Source for Windowed<'_, '_> {
    fn read_exact_at(&mut self, off: u64, buf: &mut [u8]) -> Result<(), String> {
        let bytes = self.files.read_at(&self.path, self.size, off, buf.len() as u64)?;
        buf.copy_from_slice(bytes);
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::super::archive::SessionFilter;
    use super::super::super::shell::shells;
    use super::super::classify::{self, tests::SMALL, Blobs, Limits};
    use super::super::ingest::tests::{Fixture, SECRET_TEXT, SID, THREAD};
    use super::super::ingest::{run_pass_from, PassOptions};
    use super::super::journal;
    use super::super::lister::{list_script, parse, tests::run_list};
    use super::super::store::tests::temp_dir;
    use super::*;
    use std::fs;

    /// Runs the fetch script in a local shell against temp files, as it runs over SSH.
    pub(crate) fn shell_fetch(shell: &'static str, codecs: &[&'static str], runtime: tokio::runtime::Handle) -> ShellFetch {
        ShellFetch {
            command: Box::new(move || {
                let mut command = tokio::process::Command::new(shell);
                command.env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin");
                MachineCommand::from(command)
            }),
            runtime,
            codecs: codecs.to_vec(),
        }
    }

    pub(crate) fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap()
    }

    fn has(tool: &str) -> bool {
        std::process::Command::new("sh").arg("-c").arg(format!("command -v {tool}")).env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin").output().is_ok_and(|output| output.status.success())
    }

    /// Answers from a table, and counts what it's asked.
    pub(crate) struct Table {
        pub(crate) files: HashMap<String, Vec<u8>>,
        pub(crate) asked: Vec<Vec<Range>>,
        pub(crate) down: bool,
    }

    impl Fetch for Table {
        fn fetch(&mut self, ranges: &[Range]) -> Result<Vec<Piece>, String> {
            self.asked.push(ranges.to_vec());
            if self.down {
                return Err("ssh: connect to host cedar port 22: Operation timed out".into());
            }
            Ok(ranges
                .iter()
                .map(|range| match self.files.get(&range.path) {
                    None => Piece::Gone,
                    Some(bytes) if (bytes.len() as u64) < range.off + range.len => Piece::Changed,
                    Some(bytes) => Piece::Bytes(bytes[range.off as usize..(range.off + range.len) as usize].to_vec()),
                })
                .collect())
        }
    }

    #[test]
    fn the_script_brings_back_each_range_whole_or_says_why_not_in_every_shell_and_compression() {
        let base = temp_dir("remote-fetch");
        let text: Vec<u8> = (0..300_000u32).flat_map(|n| format!("{{\"n\":{n}}}\n").into_bytes()).collect();
        let big = base.join("it's big.jsonl");
        fs::write(&big, &text).unwrap();
        let small = base.join("small.jsonl");
        fs::write(&small, b"{}\n").unwrap();
        let empty = base.join("empty.jsonl");
        fs::write(&empty, b"").unwrap();
        let locked = base.join("locked.jsonl");
        fs::write(&locked, b"{}\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        // Running as root reads it anyway, so it's only expected unreadable when it is.
        let locked_reads = fs::read(&locked).is_ok();
        let path = |p: &Path| p.to_string_lossy().into_owned();
        let ranges = vec![
            Range { path: path(&big), off: 0, len: text.len() as u64 },
            Range { path: path(&big), off: 1_000_001, len: 700_000 },
            Range { path: path(&small), off: 0, len: 3 },
            Range { path: path(&small), off: 0, len: 4 },
            Range { path: path(&base.join("gone.jsonl")), off: 0, len: 10 },
            Range { path: path(&empty), off: 0, len: 0 },
            Range { path: path(&locked), off: 0, len: 3 },
            Range { path: path(&base), off: 0, len: 1 },
        ];
        let expected = vec![
            Piece::Bytes(text.clone()),
            Piece::Bytes(text[1_000_001..1_700_001].to_vec()),
            Piece::Bytes(b"{}\n".to_vec()),
            Piece::Changed,
            Piece::Gone,
            Piece::Bytes(Vec::new()),
            if locked_reads { Piece::Bytes(b"{}\n".to_vec()) } else { Piece::Unreadable },
            Piece::Unreadable,
        ];
        let runtime = runtime();
        let mut codecs: Vec<Vec<&'static str>> = vec![Vec::new(), vec!["gzip"]];
        if has("zstd") {
            codecs.push(vec!["zstd", "gzip"]);
        }
        // A machine without the first choice falls back to the next.
        codecs.push(vec!["no-such-compressor", "gzip"]);
        for shell in shells() {
            for codec in &codecs {
                let mut fetch = shell_fetch(shell, codec, runtime.handle().clone());
                assert_eq!(fetch.fetch(&ranges).unwrap(), expected, "{shell} with {codec:?}");
            }
        }
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o600)).unwrap();
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_reply_that_stops_short_or_says_something_else_is_refused() {
        let reply = |lens: Vec<u64>, parts: &[&[u8]]| {
            let mut reply = Reply::new(lens);
            for part in parts {
                reply.push(part)?;
            }
            reply.finish()
        };
        // Split anywhere, a reply reads the same.
        let whole = b"none\nB\t1\nab\ncdY\t1\nG\t2\nE\n";
        for cut in 0..whole.len() {
            let (a, b) = whole.split_at(cut);
            assert_eq!(reply(vec![5, 9], &[a, b]).unwrap(), [Piece::Bytes(b"ab\ncd".to_vec()), Piece::Gone]);
        }
        assert!(reply(vec![5], &[b"none\nB\t1\nab"]).is_err(), "cut off in its bytes");
        assert!(reply(vec![5], &[b"none\nB\t1\nab\ncdY\t1\n"]).is_err(), "no end");
        assert!(reply(vec![5, 1], &[b"none\nB\t1\nab\ncdY\t1\nE\n"]).is_err(), "a range never answered");
        assert!(reply(vec![5], &[b"none\nB\t1\nab\ncdY\t2\nE\n"]).is_err(), "the wrong range said whole");
        assert!(reply(vec![5], &[b"none\nB\t1\nab\ncdY\t1\nY\t1\nE\n"]).is_err(), "a range answered twice");
        assert!(reply(vec![5], &[b"none\nQ\t1\nE\n"]).is_err());
        assert!(reply(vec![5], &[b"bzip2\n"]).is_err());
        assert!(reply(vec![5], &[b""]).is_err());
        assert_eq!(reply(vec![5], &[b"none\nB\t1\n\0\0\0\0\0X\t1\nE\n"]).unwrap(), [Piece::Changed]);
    }

    fn listed(size: u64) -> ListedFile {
        ListedFile { rel_path: String::new(), dev: 7, ino: 8, size, mtime: 1_700_000_000, ctime: 1_700_000_001, via_link: false }
    }

    fn read_all(files: &mut RemoteFiles<'_>, path: &str, size: u64) -> Result<Vec<u8>, String> {
        files.ready(Path::new(path), size)?;
        let mut source = files.open(Path::new(path), size)?;
        let mut out = vec![0u8; size as usize];
        source.read_exact_at(0, &mut out)?;
        Ok(out)
    }

    #[test]
    fn small_files_come_several_to_a_fetch_and_big_ones_a_window_at_a_time() {
        let sizes = Sizes { whole_max: 100, batch_bytes: 150, batch_files: 3, read_ahead: 64, min_read: 16, head: 32 };
        let big: Vec<u8> = (0..400u32).map(|n| (n % 251) as u8).collect();
        let mut table = Table { files: HashMap::new(), asked: Vec::new(), down: false };
        for (name, len) in [("/a", 40usize), ("/b", 60), ("/c", 60), ("/d", 10)] {
            table.files.insert(name.into(), vec![name.as_bytes()[1]; len]);
        }
        table.files.insert("/big".into(), big.clone());
        let mut files = RemoteFiles::new(&mut table, sizes, u64::MAX);
        assert_eq!(files.stat(Path::new("/a"), &listed(40)).map(|seen| (seen.size, seen.mtime_ns)), Some((40, 1_700_000_000_000_000_000)));
        let plan: Vec<(PathBuf, u64)> = [("/a", 40), ("/big", 400), ("/b", 60), ("/gone", 5), ("/c", 60), ("/d", 10)].iter().map(|(p, s)| (PathBuf::from(p), *s)).collect();
        files.plan(&plan);
        assert_eq!(read_all(&mut files, "/a", 40).unwrap(), vec![b'a'; 40]);
        // The big one's head, then windows as it's read in order: the first read is in the head.
        assert_eq!(files.head(Path::new("/big"), 400).unwrap(), big[..32]);
        // A small file's head is from what was fetched whole.
        assert_eq!(files.head(Path::new("/b"), 60).unwrap(), vec![b'b'; 60]);
        {
            let mut source = files.open(Path::new("/big"), 400).unwrap();
            let mut buf = [0u8; 20];
            for off in (0..400).step_by(20) {
                source.read_exact_at(off, &mut buf).unwrap();
                assert_eq!(buf, big[off as usize..off as usize + 20]);
            }
            // A jump back fetches only a little.
            source.read_exact_at(5, &mut buf[..4]).unwrap();
            assert!(source.read_exact_at(390, &mut buf).is_err(), "nothing past the size listed");
        }
        assert_eq!(read_all(&mut files, "/b", 60).unwrap(), vec![b'b'; 60]);
        assert_eq!(read_all(&mut files, "/gone", 5).unwrap_err(), GONE);
        assert_eq!(read_all(&mut files, "/c", 60).unwrap(), vec![b'c'; 60]);
        assert_eq!(read_all(&mut files, "/d", 10).unwrap(), vec![b'd'; 10]);
        let fetched = files.bytes;
        drop(files);
        let asked: Vec<Vec<(&str, u64, u64)>> = table.asked.iter().map(|ranges| ranges.iter().map(|range| (range.path.as_str(), range.off, range.len)).collect()).collect();
        assert_eq!(
            asked,
            [
                // /a with the small files after it, up to three and 150 bytes.
                vec![("/a", 0, 40), ("/b", 0, 60), ("/gone", 0, 5)],
                vec![("/big", 0, 32)],
                vec![("/big", 20, 64)],
                vec![("/big", 80, 64)],
                vec![("/big", 140, 64)],
                vec![("/big", 200, 64)],
                vec![("/big", 260, 64)],
                vec![("/big", 320, 64)],
                vec![("/big", 380, 20)],
                vec![("/big", 5, 16)],
                vec![("/c", 0, 60), ("/d", 0, 10)],
            ]
        );
        assert_eq!(fetched, 40 + 60 + 5 + 32 + 64 * 6 + 20 + 16 + 60 + 10);
    }

    fn version_bytes(fixture: &Fixture, rel: &str) -> Vec<u8> {
        let id: i64 = fixture.db.query_row("SELECT version_id FROM files WHERE rel_path = ?1", [rel], |row| row.get(0)).unwrap();
        let version = classify::load_version(&fixture.db, id).unwrap();
        let mut bytes: Vec<u8> = version.chunks.iter().flat_map(|(_, hash, _)| fixture.places.read_chunk(hash).unwrap()).collect();
        if version.state == "growing" && version.tail_len > 0 {
            bytes.extend(fixture.places.read_pending(&version.vk, version.pending_gen).unwrap());
        }
        bytes
    }

    #[test]
    fn another_machines_sessions_are_kept_byte_for_byte_as_they_grow() {
        let fixture = Fixture::new("remote-pass");
        let lines = |count: usize| -> String { (0..count).map(|n| format!("{{\"type\":\"user\",\"sessionId\":\"{SID}\",\"n\":{n},\"text\":\"{SECRET_TEXT}\"}}\n")).collect() };
        let main = format!(".claude/projects/-home-me-app/{SID}.jsonl");
        let small = ".claude/projects/-home-me-app/0f8b5c2e-1111-4222-8333-444455559999.jsonl";
        let rollout = format!(".codex/sessions/2026/09/25/rollout-2026-09-25T10-00-00-{THREAD}.jsonl");
        fixture.write(&main, &lines(30));
        fixture.write(small, &lines(2));
        fixture.write(&rollout, &format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{THREAD}\"}}}}\n{}", lines(1)));
        fixture.write(".claude/history.jsonl", &format!("{{\"display\":\"{SECRET_TEXT}\"}}\n"));
        // A small version of the real sizes, so the big transcript is read a window at a time and
        // its growth through spot checks, while the rest come whole, two to a fetch.
        let limits = Limits { full_check_max: 1500, keep_max: 600, ..SMALL };
        let sizes = Sizes { whole_max: 1500, batch_bytes: 3000, batch_files: 2, read_ahead: 700, min_read: 50, head: 300 };
        assert!(lines(30).len() > 1500);
        let runtime = runtime();
        let pass = |shell: &'static str| {
            let listing = parse(&run_list("sh", &fixture.home, &list_script(&[])));
            let mut fetch = shell_fetch(shell, &["gzip"], runtime.handle().clone());
            let mut files = RemoteFiles::new(&mut fetch, sizes, 1 << 40);
            let options = PassOptions { machine: "cedar".into(), user_home: listing.home.clone(), limits, bytes_per_second: 1 << 40, max_bytes: 1 << 40, max_time: Duration::from_secs(600), import: false, sessions: SessionFilter::everything() };
            let report = run_pass_from(&fixture.db, &fixture.places, &listing, &options, &mut files, &|| false).unwrap();
            journal::flush(&fixture.db, &fixture.places.store).unwrap();
            report
        };
        let shell = *shells().last().unwrap();
        let first = pass("sh");
        assert!(first.complete && !first.lost, "{first:?}");
        assert_eq!((first.files_changed, first.failures), (4, 0));
        let sources: Vec<(String, String)> = fixture.db.prepare("SELECT machine, label FROM sources ORDER BY label").unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap().map(Result::unwrap).collect();
        assert_eq!(sources, [("cedar".to_string(), "~/.claude".to_string()), ("cedar".to_string(), "~/.codex".to_string())]);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM sessions WHERE agent = 'codex' AND session_id = '019a1b2c-3d4e-7f00-8111-222233334444'"), 1);
        let again = pass(shell);
        assert_eq!((again.files_changed, again.bytes_read), (0, 0));

        // It grows a second later, as a machine's listing only has whole seconds.
        fixture.write(&main, &lines(45));
        let later = std::time::SystemTime::now() + Duration::from_secs(5);
        fs::File::options().write(true).open(fixture.home.join(&main)).unwrap().set_modified(later).unwrap();
        let grew = pass(shell);
        assert_eq!((grew.files_changed, grew.failures), (1, 0));
        assert!(grew.bytes_read < lines(45).len() as u64, "only the new end and spot checks are read: {grew:?}");
        assert_eq!(fixture.count("SELECT COUNT(*) FROM versions"), 4);
        for (rel, text) in [(main.as_str(), lines(45)), (small, lines(2))] {
            assert_eq!(version_bytes(&fixture, rel.trim_start_matches(".claude/")), text.as_bytes(), "{rel}");
        }
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn a_machine_that_stops_answering_partway_leaves_the_rest_for_another_pass() {
        let fixture = Fixture::new("remote-lost");
        for n in 0..3 {
            fixture.write(&format!(".claude/projects/-a/0f8b5c2e-1111-4222-8333-44445555666{n}.jsonl"), "{}\n");
        }
        let listing = parse(&run_list("sh", &fixture.home, &list_script(&[])));
        let mut table = Table { files: HashMap::new(), asked: Vec::new(), down: true };
        let mut files = RemoteFiles::new(&mut table, SIZES, 1 << 40);
        let options = PassOptions { machine: "cedar".into(), user_home: listing.home.clone(), limits: SMALL, bytes_per_second: 1 << 40, max_bytes: 1 << 40, max_time: Duration::from_secs(600), import: false, sessions: SessionFilter::everything() };
        let report = run_pass_from(&fixture.db, &fixture.places, &listing, &options, &mut files, &|| false).unwrap();
        assert!(!report.complete && report.lost);
        assert_eq!((report.files_changed, report.failures), (1, 1));
        assert!(report.first_failure.unwrap().contains("timed out"));
        drop(files);
        assert_eq!(table.asked.len(), 1);
        // Nothing was noted for files it never got.
        assert_eq!(fixture.count("SELECT COUNT(*) FROM sessions"), 0);
        let _ = fs::remove_dir_all(&fixture.base);
    }

    #[test]
    fn a_machine_that_stops_answering_is_asked_nothing_more() {
        let mut table = Table { files: HashMap::new(), asked: Vec::new(), down: true };
        let mut files = RemoteFiles::new(&mut table, SIZES, u64::MAX);
        files.plan(&[(PathBuf::from("/a"), 10), (PathBuf::from("/b"), 10)]);
        assert!(!files.lost());
        assert!(files.ready(Path::new("/a"), 10).unwrap_err().contains("timed out"));
        assert!(files.lost());
        assert!(files.ready(Path::new("/b"), 10).is_err());
        assert!(files.head(Path::new("/big"), 100 << 20).is_none());
        drop(files);
        assert_eq!(table.asked.len(), 1);
    }
}

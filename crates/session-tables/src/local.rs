//! Agent homes on this machine, read into tables: what the `session-tables` command does, for someone with no
//! archive of their sessions and no app keeping one. It reads the transcripts where the agents write them, never
//! changes them, and sends nothing anywhere: the tables are a folder on this machine.
//!
//! Each run reads only what is new. `local.json` in the tables' folder says how far each file is read, and
//! `keys.bin` holds the key of every line read with the file it was first read from, which is what tells a repeat.
//! Both are staged with the number the next write takes and count once the tables hold a write of that number, so a
//! run stopped at any moment neither loses rows nor adds them twice.

use crate::store::{make_dir, private, Batch, Engine, Origin, Store};
use crate::{Agent, Detail, LineKey, Parser, Rows, Seen, State, RULE};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// A write is made once this much is waiting, and a table's fresh files are folded into months once there are this
/// many.
const BATCH_BYTES: u64 = 64 << 20;
const MERGE_AT: usize = 8;
/// A file's rows go to the batch each time this many of its lines are read, so a long session isn't held in memory.
const LINES_AT_ONCE: usize = 20_000;
/// A file changed more recently than this may be a session still running, whose last reply is still being written.
const SETTLED_AFTER: Duration = Duration::from_secs(600);
const PROGRESS: &str = "local.json";
const KEYS: &str = "keys.bin";
const STAGED_KEYS: &str = "keys.staged";

/// A folder an agent keeps its sessions under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Home {
    pub agent: Agent,
    pub path: PathBuf,
}

/// The homes each agent uses by default, of those that are there.
pub fn homes(user_home: &Path) -> Vec<Home> {
    let usual = [(Agent::Claude, ".claude"), (Agent::Codex, ".codex"), (Agent::Pi, ".pi/agent"), (Agent::OpenClaw, ".openclaw")];
    usual.into_iter().map(|(agent, path)| Home { agent, path: user_home.join(path) }).filter(|home| home.path.is_dir()).collect()
}

/// Every file under `dir`, links not followed.
fn walk(dir: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => walk(&entry.path(), found),
            Ok(kind) if kind.is_file() => found.push(entry.path()),
            _ => {}
        }
    }
}

/// The transcripts a home holds, in the order of their paths.
pub fn transcripts(home: &Home) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let named = |path: &Path, ends: &str| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.ends_with(ends));
    match home.agent {
        // A session's own file, and the files of the subagents it started beside it.
        Agent::Claude => walk(&home.path.join("projects"), &mut found),
        Agent::Codex => {
            walk(&home.path.join("sessions"), &mut found);
            walk(&home.path.join("archived_sessions"), &mut found);
            found.retain(|path| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("rollout-")));
        }
        Agent::Pi => walk(&home.path.join("sessions"), &mut found),
        Agent::OpenClaw => {
            walk(&home.path.join("agents"), &mut found);
            // `<id>.jsonl` in a `sessions` folder is a session; `<id>.trajectory.jsonl` and the copies beside it aren't.
            found.retain(|path| {
                let in_sessions = path.parent().and_then(Path::file_name).is_some_and(|dir| dir == "sessions");
                let plain = path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.matches('.').count() == 1 && name != "sessions.json");
                in_sessions && plain
            });
        }
    }
    found.retain(|path| named(path, ".jsonl"));
    found.sort();
    found
}

/// How far a file is read.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ReadTo {
    /// The file's number among the keys.
    id: u32,
    bytes: u64,
    lines: u64,
    /// Nothing is being held for a next line.
    finished: bool,
    state: State,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Staged {
    /// The number the write these wait on takes.
    batch: u64,
    files: BTreeMap<String, ReadTo>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Progress {
    /// The rule and detail the tables were made with.
    made_by: String,
    files_numbered: u32,
    files: BTreeMap<String, ReadTo>,
    staged: Option<Staged>,
}

/// What a run did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// Files with something new in them.
    pub files: u64,
    pub bytes: u64,
    pub lines: u64,
    /// Rows added, in every table.
    pub rows: u64,
    /// Files that couldn't be read, which the next run tries again.
    pub unread: u64,
    /// The tables as they are now.
    pub table_rows: u64,
    pub table_bytes: u64,
}

fn failed(doing: &str, path: &Path, error: impl std::fmt::Display) -> String {
    format!("Couldn't {doing} {}: {error}", path.display())
}

fn load(root: &Path) -> Result<Progress, String> {
    let path = root.join(PROGRESS);
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| format!("{} can't be read", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Progress::default()),
        Err(error) => Err(failed("read", &path, error)),
    }
}

fn save(root: &Path, progress: &Progress) -> Result<(), String> {
    let (path, temp) = (root.join(PROGRESS), root.join(format!(".{PROGRESS}.tmp")));
    let bytes = serde_json::to_vec(progress).map_err(|error| error.to_string())?;
    let mut file = private().create(true).truncate(true).open(&temp).map_err(|error| failed("write", &temp, error))?;
    file.write_all(&bytes).and_then(|()| file.sync_all()).map_err(|error| failed("write", &temp, error))?;
    fs::rename(&temp, &path).map_err(|error| failed("put in place", &path, error))
}

/// A key and the number of the file it was first read from, 16 bytes each.
fn read_keys(path: &Path, into: &mut HashMap<LineKey, u32>) -> Result<(), String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(failed("read", path, error)),
    };
    // A last record cut short by a stop mid-write is one whose write never counted.
    for record in bytes.as_chunks::<16>().0 {
        let key: LineKey = std::array::from_fn(|index| record[index]);
        into.entry(key).or_insert(u32::from_le_bytes([record[12], record[13], record[14], record[15]]));
    }
    Ok(())
}

fn write_keys(path: &Path, keys: &[(LineKey, u32)], append: bool) -> Result<(), String> {
    let mut bytes = Vec::with_capacity(keys.len() * 16);
    for (key, file) in keys {
        bytes.extend_from_slice(key);
        bytes.extend_from_slice(&file.to_le_bytes());
    }
    let mut file = private().create(true).append(append).truncate(!append).open(path).map_err(|error| failed("write", path, error))?;
    file.write_all(&bytes).and_then(|()| file.sync_all()).map_err(|error| failed("write", path, error))
}

/// Counts what was staged, now that the tables hold the write it waited on.
fn promote(root: &Path, progress: &mut Progress) -> Result<(), String> {
    let Some(staged) = progress.staged.take() else { return Ok(()) };
    let mut keys = HashMap::new();
    read_keys(&root.join(STAGED_KEYS), &mut keys)?;
    let keys: Vec<(LineKey, u32)> = keys.into_iter().collect();
    // A stop after this and before the progress is saved adds the keys again next time, which changes nothing.
    write_keys(&root.join(KEYS), &keys, true)?;
    progress.files.extend(staged.files);
    save(root, progress)?;
    let _ = fs::remove_file(root.join(STAGED_KEYS));
    Ok(())
}

/// A run in progress: the tables, how far every file is read, and what waits on the next write.
struct Run<'a> {
    root: &'a Path,
    engine: &'a dyn Engine,
    store: Store,
    progress: Progress,
    keys: HashMap<LineKey, u32>,
    batch: Batch,
    /// The files read since the last write, with how far.
    waiting: BTreeMap<String, ReadTo>,
    /// The keys first met since the last write.
    new_keys: Vec<(LineKey, u32)>,
    rows: u64,
}

/// One file to read, and from where.
struct Task<'a> {
    path: &'a Path,
    agent: Agent,
    detail: Detail,
    machine: &'a str,
    from: ReadTo,
    /// How long the file is now.
    len: u64,
    /// It has stopped growing.
    settled: bool,
}

impl Run<'_> {
    /// Writes what's waiting, and counts the files it came from as read that far.
    fn commit(&mut self) -> Result<(), String> {
        let batch = std::mem::replace(&mut self.batch, self.store.batch()?);
        if batch.bytes() == 0 {
            // Nothing to write, so nothing to wait on.
            batch.discard();
            if !self.waiting.is_empty() {
                write_keys(&self.root.join(KEYS), &self.new_keys, true)?;
                self.new_keys.clear();
                self.progress.files.append(&mut self.waiting);
                save(self.root, &self.progress)?;
            }
            return Ok(());
        }
        write_keys(&self.root.join(STAGED_KEYS), &self.new_keys, false)?;
        self.new_keys.clear();
        self.progress.staged = Some(Staged { batch: self.store.next(), files: std::mem::take(&mut self.waiting) });
        save(self.root, &self.progress)?;
        self.rows += self.store.write(batch, self.engine)?;
        promote(self.root, &mut self.progress)?;
        self.store.merge(self.engine, MERGE_AT)?;
        Ok(())
    }

    /// Reads a file's new lines into the batch, and gives how far it's read now.
    fn read(&mut self, task: &Task) -> Result<ReadTo, String> {
        let path = task.path;
        let name = path.to_string_lossy();
        let origin = Origin { agent: task.agent, machine: task.machine, source: &name };
        let mut file = File::open(path).map_err(|error| failed("open", path, error))?;
        file.seek(SeekFrom::Start(task.from.bytes)).map_err(|error| failed("read", path, error))?;
        let mut reader = BufReader::with_capacity(1 << 20, file.take(task.len - task.from.bytes));
        let mut parser = Parser::new(task.agent, task.detail, task.from.state.clone());
        let mut to = task.from.clone();
        let mut rows = Rows::default();
        let mut line = Vec::new();
        // Where this file's keys start among the new ones, and whether its rows have started going to the batch.
        let mut own_keys = self.new_keys.len();
        let mut spilled = false;
        let read = (|| -> Result<(), String> {
            loop {
                line.clear();
                let took = reader.read_until(b'\n', &mut line).map_err(|error| failed("read", path, error))?;
                // A last line with no end is still being written, and is read once it has one.
                if took == 0 || line.last() != Some(&b'\n') {
                    break;
                }
                let (keys, new_keys, id) = (&mut self.keys, &mut self.new_keys, to.id);
                let mut seen = |key: LineKey| match keys.get(&key) {
                    Some(first) if *first == id => Seen::Here,
                    Some(_) => Seen::Elsewhere,
                    None => {
                        keys.insert(key, id);
                        new_keys.push((key, id));
                        Seen::New
                    }
                };
                parser.line_once(to.lines, &line[..line.len() - 1], &mut seen, &mut rows);
                to.bytes += took as u64;
                to.lines += 1;
                if rows.lines.len() >= LINES_AT_ONCE {
                    // What other files left waiting is written first, so that dropping this file's rows, should
                    // it fail further on, drops only its own. The keys met so far stay with this file.
                    if !spilled {
                        let own = self.new_keys.split_off(own_keys);
                        self.commit()?;
                        self.new_keys = own;
                        (own_keys, spilled) = (0, true);
                    }
                    self.batch.add(&origin, &rows)?;
                    rows = Rows::default();
                }
            }
            // What's held for a next line goes out once the file has stopped growing.
            to.finished = task.settled;
            if task.settled {
                parser.finish(&mut rows);
            }
            to.state = parser.state().clone();
            self.batch.add(&origin, &rows)
        })();
        if let Err(error) = read {
            // The file is read again next time from where it was, so its keys go, and its rows if any got as far
            // as the batch.
            for (key, _) in self.new_keys.drain(own_keys..) {
                self.keys.remove(&key);
            }
            if spilled {
                std::mem::replace(&mut self.batch, self.store.batch()?).discard();
            }
            return Err(error);
        }
        Ok(to)
    }
}

/// Reads what's new in every transcript under `homes` into the tables in `root`. `said` is told of each file as
/// it's read, for whoever is watching.
pub fn build(root: &Path, homes: &[Home], detail: Detail, machine: &str, engine: &dyn Engine, said: &mut dyn FnMut(&Path)) -> Result<Report, String> {
    // The folder is its owner's alone: the tables hold what was said, and the progress beside them names every
    // project. One that's already there keeps the mode it was given.
    if let Some(parent) = root.parent() {
        fs::create_dir_all(parent).map_err(|error| failed("make", parent, error))?;
    }
    make_dir(root)?;
    let made_by = format!("{RULE} {}", if detail == Detail::Everything { "everything" } else { "numbers" });
    let mut progress = load(root)?;
    if progress.made_by != made_by {
        // Tables another rule or detail made are started again. Progress goes first: tables without progress are
        // read into again, and never the other way round.
        for name in [PROGRESS, KEYS, STAGED_KEYS] {
            let _ = fs::remove_file(root.join(name));
        }
        Store::clear(root);
        progress = Progress { made_by, ..Progress::default() };
        save(root, &progress)?;
    }
    let store = Store::open(root)?;
    // What a run that stopped mid-write left staged counts if its write landed, and is dropped if it didn't.
    match &progress.staged {
        Some(staged) if store.next() > staged.batch => promote(root, &mut progress)?,
        Some(_) => {
            progress.staged = None;
            let _ = fs::remove_file(root.join(STAGED_KEYS));
            save(root, &progress)?;
        }
        None => {}
    }
    store.sweep()?;
    let mut keys = HashMap::new();
    read_keys(&root.join(KEYS), &mut keys)?;
    let batch = store.batch()?;
    let mut run = Run { root, engine, store, progress, keys, batch, waiting: BTreeMap::new(), new_keys: Vec::new(), rows: 0 };
    let mut report = Report::default();
    let now = SystemTime::now();

    for home in homes {
        for path in transcripts(home) {
            let name = path.to_string_lossy().into_owned();
            let Ok(meta) = fs::metadata(&path) else { continue };
            let settled = meta.modified().ok().and_then(|at| now.duration_since(at).ok()).is_some_and(|age| age >= SETTLED_AFTER);
            let mut from = run.progress.files.get(&name).cloned().unwrap_or_else(|| {
                run.progress.files_numbered += 1;
                ReadTo { id: run.progress.files_numbered, ..ReadTo::default() }
            });
            // A file shorter than it was has been written again from its start, so it's read again from there.
            if meta.len() < from.bytes {
                from = ReadTo { id: from.id, ..ReadTo::default() };
            }
            if meta.len() == from.bytes && (from.finished || !settled) {
                continue;
            }
            said(&path);
            let task = Task { path: &path, agent: home.agent, detail, machine, from, len: meta.len(), settled };
            match run.read(&task) {
                Ok(to) => {
                    report.files += 1;
                    report.bytes += to.bytes - task.from.bytes;
                    report.lines += to.lines - task.from.lines;
                    run.waiting.insert(name, to);
                }
                Err(_) => report.unread += 1,
            }
            if run.batch.bytes() >= BATCH_BYTES {
                run.commit()?;
            }
        }
    }
    run.commit()?;
    run.store.merge(engine, MERGE_AT)?;
    run.store.sweep()?;
    report.rows = run.rows;
    (report.table_rows, report.table_bytes) = run.store.size();
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Program;
    use crate::{claude, codex, pi};
    use serde_json::Value;
    use std::cell::Cell;

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("session-tables-local-{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(&dir).unwrap()
    }

    fn engine() -> Option<Program> {
        let path = std::env::var_os("SESSION_TABLES_DUCKDB").filter(|path| !path.is_empty())?;
        Some(Program { path: PathBuf::from(path) })
    }

    /// Writes a file as one last changed long enough ago to have stopped growing, or just now.
    fn write(path: &Path, lines: &[String], settled: bool) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, lines.iter().map(|line| format!("{line}\n")).collect::<String>()).unwrap();
        if settled {
            File::options().write(true).open(path).unwrap().set_modified(SystemTime::now() - SETTLED_AFTER * 2).unwrap();
        }
    }

    fn ask(engine: &Program, root: &Path, query: &str) -> Vec<Value> {
        let store = Store::open(root).unwrap();
        let answer = engine.run(&format!("SET TimeZone = 'UTC';\n{}{query};", store.views())).unwrap();
        serde_json::from_str(answer.trim()).unwrap()
    }

    fn count(engine: &Program, root: &Path, table: &str) -> u64 {
        ask(engine, root, &format!("SELECT count(*) AS n FROM {table}"))[0]["n"].as_u64().unwrap()
    }

    const CLAUDE: &str = "claude/projects/-srv-app/0f8b5c2e-1111-4222-8333-444455556666.jsonl";
    const ROLLOUT: &str = "codex/sessions/2026/10/02/rollout-2026-10-02T09-00-00-019a1b2c-3d4e-7f00-8111-222233334444.jsonl";

    fn all(base: &Path) -> Vec<Home> {
        [(Agent::Claude, "claude"), (Agent::Codex, "codex"), (Agent::Pi, "pi"), (Agent::OpenClaw, "openclaw")].into_iter().map(|(agent, dir)| Home { agent, path: base.join(dir) }).collect()
    }

    #[test]
    fn a_homes_transcripts_are_found_and_what_sits_beside_them_is_not() {
        let base = temp_dir("found");
        let line = [String::from("{}")];
        for path in [
            CLAUDE,
            "claude/projects/-srv-app/0f8b5c2e-1111-4222-8333-444455556666/subagents/agent-a1.jsonl",
            "claude/projects/-srv-app/0f8b5c2e-1111-4222-8333-444455556666/tool-results/big.txt",
            "claude/history.jsonl",
            ROLLOUT,
            "codex/archived_sessions/rollout-2026-09-01T09-00-00-019a1b2c-0000-7f00-8111-222233334444.jsonl",
            "codex/sessions/2026/10/02/notes.jsonl",
            "codex/history.jsonl",
            "pi/sessions/--srv-app--/2026-10-03T08-00-00-000Z_p-1.jsonl",
            "pi/settings.json",
            "openclaw/agents/main/sessions/c-1.jsonl",
            "openclaw/agents/main/sessions/c-1.trajectory.jsonl",
            "openclaw/agents/main/sessions/c-1.jsonl.bak-1",
            "openclaw/agents/main/sessions/sessions.json",
            "openclaw/agents/main/agent/notes.jsonl",
        ] {
            write(&base.join(path), &line, true);
        }
        let found: Vec<String> = all(&base).iter().flat_map(transcripts).map(|path| path.strip_prefix(&base).unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(
            found,
            [
                "claude/projects/-srv-app/0f8b5c2e-1111-4222-8333-444455556666/subagents/agent-a1.jsonl",
                CLAUDE,
                "codex/archived_sessions/rollout-2026-09-01T09-00-00-019a1b2c-0000-7f00-8111-222233334444.jsonl",
                ROLLOUT,
                "pi/sessions/--srv-app--/2026-10-03T08-00-00-000Z_p-1.jsonl",
                "openclaw/agents/main/sessions/c-1.jsonl",
            ]
        );
        // Only the homes that are there are read by default.
        fs::create_dir_all(base.join("home/.codex")).unwrap();
        assert_eq!(homes(&base.join("home")), [Home { agent: Agent::Codex, path: base.join("home/.codex") }]);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn each_run_reads_only_what_is_new_and_a_session_kept_twice_counts_once() {
        let Some(engine) = engine() else { return };
        let base = temp_dir("runs");
        let root = base.join("tables");
        let (claude, codex, pi) = (claude::tests::session(), codex::tests::session(), pi::tests::session());
        write(&base.join(CLAUDE), &claude[..6], true);
        write(&base.join(ROLLOUT), &codex, true);
        write(&base.join("pi/sessions/--srv-app--/2026-10-03T08-00-00-000Z_p-1.jsonl"), &pi, true);
        let run = || build(&root, &all(&base), Detail::Everything, "cam-mbp", &engine, &mut |_| {}).unwrap();
        let first = run();
        assert_eq!((first.files, first.lines, first.unread), (3, (6 + codex.len() + pi.len()) as u64, 0));
        assert_eq!(count(&engine, &root, "lines"), first.lines);
        assert_eq!(ask(&engine, &root, "SELECT DISTINCT agent, machine FROM lines ORDER BY agent").len(), 3);
        // The folder and what's in it are their owner's alone.
        #[cfg(unix)]
        for (name, mode) in [("", 0o700), (PROGRESS, 0o600), (KEYS, 0o600), ("manifest.json", 0o600)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(root.join(name)).unwrap().permissions().mode() & 0o777, mode, "{name}");
        }
        // Nothing new: nothing read, nothing added.
        let again = run();
        assert_eq!((again.files, again.rows, again.table_rows), (0, 0, first.table_rows));
        // The Claude session goes on, and a copy of it is kept under another name.
        write(&base.join(CLAUDE), &claude, true);
        write(&base.join("claude/projects/-srv-app/7c1d9e4a-5555-4666-8777-888899990000.jsonl"), &claude, true);
        let more = run();
        assert_eq!((more.files, more.lines), (2, (claude.len() - 6 + claude.len()) as u64));
        assert_eq!(count(&engine, &root, "lines_all"), first.lines + more.lines);
        // The copy's lines are all repeats but the one with no id of its own, which only another file's bytes tell.
        assert_eq!(count(&engine, &root, "lines"), (claude.len() + codex.len() + pi.len()) as u64);
        let once = ask(&engine, &root, "SELECT count(*) AS n, count(DISTINCT message_id) AS ids FROM requests WHERE agent = 'claude'");
        assert_eq!(once[0]["n"], once[0]["ids"]);
        // Asking for less detail makes the tables again, without what was said.
        let numbers = build(&root, &all(&base), Detail::Numbers, "cam-mbp", &engine, &mut |_| {}).unwrap();
        assert_eq!(numbers.files, 4);
        assert_eq!(count(&engine, &root, "lines_all"), first.lines + more.lines);
        assert_eq!(count(&engine, &root, "tool_io"), 0);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_reply_still_being_written_waits_for_its_file_to_settle() {
        let Some(engine) = engine() else { return };
        let base = temp_dir("growing");
        let root = base.join("tables");
        let lines = claude::tests::session();
        // Two lines of one reply, the second not written yet.
        write(&base.join(CLAUDE), &lines[..3], false);
        let run = || build(&root, &all(&base), Detail::Everything, "cam-mbp", &engine, &mut |_| {}).unwrap();
        assert_eq!(run().lines, 3);
        assert_eq!(count(&engine, &root, "requests"), 0);
        write(&base.join(CLAUDE), &lines[..4], false);
        assert_eq!(run().lines, 1);
        assert_eq!(count(&engine, &root, "requests"), 0);
        // Once the file has been still a while, the reply is counted, once, with its largest numbers.
        File::options().write(true).open(base.join(CLAUDE)).unwrap().set_modified(SystemTime::now() - SETTLED_AFTER * 2).unwrap();
        assert_eq!(run().files, 1);
        assert_eq!(ask(&engine, &root, "SELECT count(*) AS n, max(output) AS output FROM requests")[0], serde_json::json!({ "n": 1, "output": 60 }));
        assert_eq!(run().files, 0);
        fs::remove_dir_all(base).unwrap();
    }

    /// The real engine, until it's told to fail.
    struct Failing<'a> {
        engine: &'a Program,
        fail: Cell<bool>,
    }

    impl Engine for Failing<'_> {
        fn run(&self, sql: &str) -> Result<String, String> {
            if self.fail.get() {
                return Err("IO Error: made up".to_string());
            }
            self.engine.run(sql)
        }
    }

    #[test]
    fn a_run_stopped_around_a_write_neither_loses_rows_nor_adds_them_twice() {
        let Some(engine) = engine() else { return };
        let base = temp_dir("stopped");
        let root = base.join("tables");
        let codex = codex::tests::session();
        write(&base.join(ROLLOUT), &codex[..5], true);
        let failing = Failing { engine: &engine, fail: Cell::new(false) };
        let run = || build(&root, &all(&base), Detail::Everything, "cam-mbp", &failing, &mut |_| {});
        run().unwrap();
        let before = load(&root).unwrap().files.values().next().unwrap().clone();
        write(&base.join(ROLLOUT), &codex, true);

        // The write never lands: what was staged for it is dropped, and the lines are read again.
        failing.fail.set(true);
        assert!(run().is_err());
        assert!(load(&root).unwrap().staged.is_some());
        failing.fail.set(false);
        assert_eq!(run().unwrap().lines, (codex.len() - 5) as u64);
        assert_eq!((count(&engine, &root, "lines_all"), count(&engine, &root, "lines")), (codex.len() as u64, codex.len() as u64));

        // The write landed and the run stopped before saying so: what was staged counts, and nothing is read again.
        let mut progress = load(&root).unwrap();
        let name = progress.files.keys().next().unwrap().clone();
        let after = progress.files.insert(name.clone(), before).unwrap();
        progress.staged = Some(Staged { batch: Store::open(&root).unwrap().next() - 1, files: BTreeMap::from([(name.clone(), after.clone())]) });
        save(&root, &progress).unwrap();
        assert_eq!(run().unwrap().files, 0);
        let settled = load(&root).unwrap();
        assert!(settled.staged.is_none());
        assert_eq!((settled.files[&name].bytes, settled.files[&name].lines), (after.bytes, after.lines));
        assert_eq!(count(&engine, &root, "lines_all"), codex.len() as u64);
        fs::remove_dir_all(base).unwrap();
    }
}

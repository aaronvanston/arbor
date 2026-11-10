//! The tables on disk: a folder of Parquet files and a manifest that names them.
//!
//! ```text
//! <folder>/
//!   manifest.json                    the files each table is made of; a file it doesn't name isn't part of a table
//!   v1/<table>/fresh/<n>.parquet     what one batch added
//!   v1/<table>/2026-10.<n>.parquet   rows of one month, from the fresh files a merge folded in
//!   tmp/                             a batch's rows as JSON lines, until they're Parquet
//! ```
//!
//! Parquet is written and merged by DuckDB's command-line program, run as a process and handed SQL: this crate links
//! no engine. Rows are only added. A file is written whole under a name the manifest doesn't hold yet, and the
//! manifest is replaced last, so stopping at any moment leaves the tables as they were.
//!
//! Whoever reads the tables lists their files from the manifest and then opens them, with no lock between the two.
//! So a file a merge replaced stays on disk for [`KEPT_AFTER_REPLACING`], which is longer than a query runs.
//!
//! One writer at a time: whoever calls [`Store::write`], [`Store::merge`] or [`Store::sweep`] holds the folder.

use crate::tables::{Kind, Shape, Table, EXIT_CODE, REPEAT, RESULTS, TABLES, VIEWS};
use crate::{Agent, ProxyRequest, Rows};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The DuckDB release this crate's SQL was written against and tested with.
pub const DUCKDB_VERSION: &str = "2.0.0";

/// That release's command-line program as DuckDB publishes it: where it runs, the archive's name, its SHA-256 and
/// its size. Whoever fetches one checks it against these and runs nothing else.
pub const DUCKDB_ARCHIVES: [(&str, &str, &str, u64); 4] = [
    ("macos-aarch64", "duckdb-cli-osx-arm64.tar.gz", "188a36fe8883ef52e69165a0cbb6031ef679c8e6c448a1ce22951964149b7f96", 19_169_633),
    ("macos-x86_64", "duckdb-cli-osx-amd64.tar.gz", "fbc7013ba09d117396dabf16783281c2add47fc01cdac4855464a03526dc96ee", 21_471_922),
    ("linux-x86_64", "duckdb-cli-linux-amd64.tar.gz", "c6507206baf7793c6013dbd82368469a45f20dc0e17a6f92f204602f652ed2bc", 24_424_037),
    ("linux-aarch64", "duckdb-cli-linux-arm64.tar.gz", "859e1875d2a9515fbb4bf8871061437a14af82320da68c753f094c4b776348fe", 22_306_407),
];

const FORMAT: &str = "session-tables";
const SCHEMA: u32 = 1;
const MANIFEST: &str = "manifest.json";
/// A month's worth of rows whose line had no time.
const UNDATED: &str = "undated";
/// The one merged file of a table that isn't split by month.
const WHOLE: &str = "all";
/// The most files a month of a table is left in. Folding adds a small file to a month and rewrites nothing, so a
/// month already written isn't written again each time a few rows arrive; past this many, reading it slows down.
pub const FILES_A_MONTH: usize = 8;
/// The engine reads JSON lines into buffers as long as the longest line it's told to expect, so it's told the
/// longest one a batch really has, and never less than this.
const SHORTEST_BUFFER: u64 = 1 << 20;
/// A row's field that isn't a column: the time its day is worked out from when it has none of its own.
const NEAR: &str = "near";
/// How every file is written. A row group is cut by its bytes and not its rows: the engine holds a whole group in
/// memory to write it and again to read it, and a group of rows by the hundred thousand, each with a tool's output
/// in it, is gigabytes. The engine only cuts by bytes with `preserve_insertion_order` off, which the settings do.
const PARQUET: &str = "FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE_BYTES '32MB'";
/// The least memory the engine is given, in MiB.
const LEAST_MEMORY: u64 = 2048;
/// How long a file a merge replaced is kept before it's removed.
pub const KEPT_AFTER_REPLACING: Duration = Duration::from_secs(600);

/// Something that runs SQL and gives back what it printed, as JSON.
pub trait Engine {
    fn run(&self, sql: &str) -> Result<String, String>;
}

/// DuckDB's command-line program at a path.
pub struct Program {
    pub path: PathBuf,
}

impl Program {
    /// The program, ready to read SQL from its input. It starts with no settings file of the user's, and prints rows
    /// as JSON whoever started it.
    pub fn command(&self) -> std::process::Command {
        let mut command = std::process::Command::new(&self.path);
        command.args(["-no-agent", "-no-init", "-bail", "-json"]);
        command
    }
}

impl Engine for Program {
    fn run(&self, sql: &str) -> Result<String, String> {
        use std::process::Stdio;
        let mut child = self
            .command()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Couldn't start {}: {error}", self.path.display()))?;
        let mut input = child.stdin.take().ok_or("The engine has no input")?;
        let sql = sql.to_string();
        // Written from another thread: the engine can fill its output before it has read all of its input.
        let writer = std::thread::spawn(move || input.write_all(sql.as_bytes()));
        let output = child.wait_with_output().map_err(|error| format!("The engine didn't finish: {error}"))?;
        let _ = writer.join();
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        String::from_utf8(output.stdout).map_err(|_| "The engine printed something that isn't text".to_string())
    }
}

/// Where a file's rows came from.
pub struct Origin<'a> {
    pub agent: Agent,
    pub machine: &'a str,
    /// The file, as whoever read it names it: an id, or a path.
    pub source: &'a str,
}

/// One file of a table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Part {
    /// From the store's folder.
    pub path: String,
    pub rows: u64,
    pub bytes: u64,
    /// The month it holds (`2026-10`, `undated`, or `all`), or nothing for a batch not merged yet.
    pub month: Option<String>,
    /// The longest row it can hold, in bytes, which is what the engine's memory is sized by when it's merged.
    #[serde(default)]
    pub longest: u64,
}

/// A file a merge put others in the place of, and when, in seconds since 1970.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Replaced {
    path: String,
    at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Manifest {
    format: String,
    schema: u32,
    engine: String,
    /// The number the next file written takes, so no two files ever share a name.
    next: u64,
    tables: BTreeMap<String, Vec<Part>>,
    /// Files no table holds any more, kept for whoever listed them just before.
    #[serde(default)]
    replaced: Vec<Replaced>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self { format: FORMAT.into(), schema: SCHEMA, engine: format!("duckdb {DUCKDB_VERSION}"), next: 0, tables: BTreeMap::new(), replaced: Vec::new() }
    }
}

pub struct Store {
    root: PathBuf,
    manifest: Manifest,
    keep: Duration,
}

/// Rows waiting to be written, as a file of JSON lines per table in the store's `tmp/`.
struct Waiting {
    file: BufWriter<File>,
    rows: u64,
    /// The longest row, in bytes.
    longest: u64,
}

pub struct Batch {
    dir: PathBuf,
    files: BTreeMap<&'static str, Waiting>,
    /// Prompts and tool definitions already in this batch: each is written once.
    seen: HashSet<String>,
    bytes: u64,
}

impl Batch {
    /// Adds a file's rows.
    pub fn add(&mut self, origin: &Origin, rows: &Rows) -> Result<(), String> {
        let place = serde_json::to_vec(&serde_json::json!({ "agent": origin.agent.name(), "machine": origin.machine, "source": origin.source })).map_err(|error| error.to_string())?;
        let place = Some(&place[..place.len() - 1]);
        self.put("lines", place, &rows.lines)?;
        self.put("messages", place, &rows.messages)?;
        self.put("requests", place, &rows.requests)?;
        self.put("tool_calls", place, &rows.tool_calls)?;
        self.put("tool_results", place, &rows.tool_results)?;
        self.put("tool_io", place, &rows.tool_io)?;
        self.put("commands", place, &rows.commands)?;
        self.put("hooks", place, &rows.hooks)?;
        self.put("context_use", place, &rows.context_use)?;
        self.put("files_touched", place, &rows.files_touched)?;
        let prompts: Vec<_> = rows.prompts.iter().filter(|prompt| self.seen.insert(format!("p{}", prompt.hash))).collect();
        self.put("prompts", None, &prompts)?;
        let tool_defs: Vec<_> = rows.tool_defs.iter().filter(|tool| self.seen.insert(format!("t{}", tool.hash))).collect();
        self.put("tool_defs", None, &tool_defs)
    }

    /// Adds requests a proxy saw.
    pub fn add_proxy(&mut self, requests: &[ProxyRequest]) -> Result<(), String> {
        self.put("proxy_requests", None, requests)
    }

    /// How much is waiting, in bytes of JSON.
    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    /// Drops the rows waiting, for a batch that won't be written.
    pub fn discard(self) {
        drop(self.files);
        remove(&self.dir);
    }

    fn put<T: Serialize>(&mut self, table: &'static str, place: Option<&[u8]>, rows: &[T]) -> Result<(), String> {
        if rows.is_empty() {
            return Ok(());
        }
        if !self.files.contains_key(table) {
            let path = self.dir.join(format!("{table}.jsonl"));
            self.files.insert(table, Waiting { file: BufWriter::new(new_file(&path)?), rows: 0, longest: 0 });
        }
        let Some(Waiting { file, rows: count, longest }) = self.files.get_mut(table) else { return Ok(()) };
        for row in rows {
            let row = serde_json::to_vec(row).map_err(|error| error.to_string())?;
            let written = match place {
                // A row is `{…}` with a field or more, so its place goes in after the brace.
                Some(place) => file.write_all(place).and_then(|()| file.write_all(b",")).and_then(|()| file.write_all(&row[1..])),
                None => file.write_all(&row),
            };
            written.and_then(|()| file.write_all(b"\n")).map_err(|error| format!("Couldn't write rows for {table}: {error}"))?;
            let length = (row.len() + place.map_or(0, <[u8]>::len) + 1) as u64;
            *count += 1;
            *longest = (*longest).max(length);
            self.bytes += length;
        }
        Ok(())
    }
}

impl Store {
    /// Opens the tables in a folder, making the folder when it isn't there.
    pub fn open(root: &Path) -> Result<Store, String> {
        for dir in [root.to_path_buf(), root.join(version_dir()), root.join("tmp")] {
            make_dir(&dir)?;
        }
        let path = root.join(MANIFEST);
        let manifest = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Manifest>(&bytes).map_err(|_| format!("{} can't be read", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Manifest::default(),
            Err(error) => return Err(format!("Couldn't read {}: {error}", path.display())),
        };
        if manifest.format != FORMAT || manifest.schema != SCHEMA {
            return Err(format!("{} holds tables in another format ({} {})", root.display(), manifest.format, manifest.schema));
        }
        Ok(Store { root: root.to_path_buf(), manifest, keep: KEPT_AFTER_REPLACING })
    }

    /// Removes every table in a folder, to start them again. Whatever else the folder holds stays.
    pub fn clear(root: &Path) {
        for name in [MANIFEST, version_dir(), "tmp"] {
            remove(&root.join(name));
        }
    }

    /// Sets how long a file a merge replaced is kept, for whoever knows nothing else reads the tables.
    pub fn keep_replaced_for(&mut self, keep: Duration) {
        self.keep = keep;
    }

    /// The number the next write or merge takes. It only goes up, and only once what was written is part of the
    /// tables, so whoever notes it before a write can tell afterwards whether that write landed.
    pub fn next(&self) -> u64 {
        self.manifest.next
    }

    /// How many rows the tables hold, and how many bytes their files take.
    pub fn size(&self) -> (u64, u64) {
        self.manifest.tables.values().flatten().fold((0, 0), |(rows, bytes), part| (rows + part.rows, bytes + part.bytes))
    }

    /// The files a table is made of.
    pub fn parts(&self, table: &str) -> &[Part] {
        self.manifest.tables.get(table).map_or(&[], Vec::as_slice)
    }

    /// Removes what no table holds: a batch that was never written, a file from a write or merge that stopped
    /// halfway, a file a merge replaced.
    pub fn sweep(&self) -> Result<(), String> {
        let tmp = self.root.join("tmp");
        for entry in fs::read_dir(&tmp).map_err(|error| format!("Couldn't read {}: {error}", tmp.display()))?.flatten() {
            remove(&entry.path());
        }
        let replaced = self.manifest.replaced.iter().map(|file| self.root.join(&file.path));
        let held: HashSet<PathBuf> = self.manifest.tables.values().flatten().map(|part| self.root.join(&part.path)).chain(replaced).collect();
        let mut dirs = vec![self.root.join(version_dir())];
        while let Some(dir) = dirs.pop() {
            for entry in fs::read_dir(&dir).map_err(|error| format!("Couldn't read {}: {error}", dir.display()))?.flatten() {
                let path = entry.path();
                match entry.file_type() {
                    Ok(kind) if kind.is_dir() => dirs.push(path),
                    _ if !held.contains(&path) => remove(&path),
                    _ => {}
                }
            }
        }
        Ok(())
    }

    /// Starts a batch, in a folder of its own. One that's never written stays in `tmp/` until a sweep.
    pub fn batch(&self) -> Result<Batch, String> {
        static STARTED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let started = STARTED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = self.root.join("tmp").join(format!("batch-{}-{started}", std::process::id()));
        remove(&dir);
        make_dir(&dir)?;
        Ok(Batch { dir, files: BTreeMap::new(), seen: HashSet::new(), bytes: 0 })
    }

    /// Writes a batch as one fresh file per table that has rows, and gives back how many rows that was.
    pub fn write(&mut self, batch: Batch, engine: &dyn Engine) -> Result<u64, String> {
        let Batch { dir, files, .. } = batch;
        let number = self.manifest.next;
        let mut sql = self.settings_for(files.values().map(|waiting| waiting.longest).max().unwrap_or(0));
        let mut added: Vec<(&'static str, Part)> = Vec::new();
        for (name, Waiting { file, rows, longest }) in files {
            let table = crate::tables::table(name).ok_or("A batch holds a table this crate doesn't have")?;
            file.into_inner().map_err(|error| error.to_string()).and_then(|file| file.sync_all().map_err(|error| error.to_string())).map_err(|error| format!("Couldn't write rows for {name}: {error}"))?;
            let folder = Path::new(version_dir()).join(name).join("fresh");
            make_dirs(&self.root, &folder)?;
            let path = folder.join(format!("{number:010}.parquet"));
            sql.push_str(&format!("COPY ({}) TO {} ({PARQUET});\n", read_json(table, &dir.join(format!("{name}.jsonl")), longest), quoted(&self.root.join(&path))));
            added.push((name, Part { path: path.to_string_lossy().into_owned(), rows, bytes: 0, month: None, longest }));
        }
        let total = added.iter().map(|(_, part)| part.rows).sum();
        if !added.is_empty() {
            let mut parts: Vec<&mut Part> = added.iter_mut().map(|(_, part)| part).collect();
            let done = engine.run(&sql).map_err(|error| failed("writing", &error)).and_then(|_| self.settle(&mut parts));
            if let Err(error) = done {
                added.iter().for_each(|(_, part)| remove(&self.root.join(&part.path)));
                remove(&dir);
                return Err(error);
            }
            let mut manifest = self.manifest.clone();
            manifest.next += 1;
            for (name, part) in added {
                manifest.tables.entry(name.to_string()).or_default().push(part);
            }
            self.save(manifest)?;
        }
        remove(&dir);
        Ok(total)
    }

    /// Folds fresh files into months, for each table with at least `at_least` of them, and gives back how many
    /// tables that was. Each fold reads the fresh files once and adds a file to every month they hold; a month
    /// that has gathered more than [`FILES_A_MONTH`] is rewritten as one. A table of distinct things becomes one
    /// file, each thing in it once.
    pub fn merge(&mut self, engine: &dyn Engine, at_least: usize) -> Result<usize, String> {
        self.reap()?;
        let mut merged = 0;
        for table in &TABLES {
            let fresh: Vec<Part> = self.parts(table.name).iter().filter(|part| part.month.is_none()).cloned().collect();
            if fresh.is_empty() || fresh.len() < at_least {
                continue;
            }
            let work = self.root.join("tmp").join(format!("merge-{}", self.manifest.next));
            remove(&work);
            let folded = self.fold(table, &fresh, &work, engine);
            remove(&work);
            folded?;
            self.gather(table, engine)?;
            merged += 1;
        }
        Ok(merged)
    }

    fn fold(&mut self, table: &Table, fresh: &[Part], work: &Path, engine: &dyn Engine) -> Result<(), String> {
        let number = self.manifest.next;
        let folder = Path::new(version_dir()).join(table.name);
        let names = names(table);
        let mut made: Vec<Part> = Vec::new();
        let mut replaced: Vec<Part> = fresh.to_vec();
        let old: Vec<Part> = if table.shape != Shape::Things { Vec::new() } else { self.parts(table.name).iter().filter(|part| part.month.is_some()).cloned().collect() };
        let longest = fresh.iter().chain(&old).map(|part| part.longest).max().unwrap_or(0);
        let done = (|| {
            if table.shape != Shape::Things {
                // One pass over the fresh files, written as a folder per month: `month=2026-10/…parquet`.
                let sql = format!(
                    "{}COPY (SELECT {names}, coalesce(strftime(day, '%Y-%m'), '{UNDATED}') AS month FROM read_parquet({}, union_by_name = true)) TO {} ({PARQUET}, PARTITION_BY (month), WRITE_PARTITION_COLUMNS false);\n",
                    self.settings_for(longest),
                    self.list(fresh.iter()),
                    quoted(work)
                );
                engine.run(&sql).map_err(|error| failed("merging", &error))?;
                for (month, files) in months_in(work)? {
                    for (index, file) in files.iter().enumerate() {
                        let path = folder.join(format!("{month}.{number}.{index}.parquet"));
                        fs::rename(file, self.root.join(&path)).map_err(|error| format!("Couldn't put {} in place: {error}", path.display()))?;
                        made.push(Part { path: path.to_string_lossy().into_owned(), rows: 0, bytes: 0, month: Some(month.clone()), longest });
                    }
                }
            } else {
                let path = folder.join(format!("{WHOLE}.{number}.parquet"));
                let sql = format!(
                    "{}COPY (SELECT DISTINCT ON (hash) {names} FROM read_parquet({}, union_by_name = true)) TO {} ({PARQUET});\n",
                    self.settings_for(longest),
                    self.list(old.iter().chain(fresh)),
                    quoted(&self.root.join(&path))
                );
                made.push(Part { path: path.to_string_lossy().into_owned(), rows: 0, bytes: 0, month: Some(WHOLE.to_string()), longest });
                replaced.extend(old.iter().cloned());
                engine.run(&sql).map_err(|error| failed("merging", &error))?;
            }
            self.count(&mut made, engine)?;
            self.settle(&mut made.iter_mut().collect::<Vec<_>>())
        })();
        self.swap(table, done, replaced, made)
    }

    /// Rewrites as one file each month of a table that has more than [`FILES_A_MONTH`].
    fn gather(&mut self, table: &Table, engine: &dyn Engine) -> Result<(), String> {
        let mut months: BTreeMap<String, Vec<Part>> = BTreeMap::new();
        for part in self.parts(table.name) {
            if let Some(month) = &part.month {
                months.entry(month.clone()).or_default().push(part.clone());
            }
        }
        for (month, parts) in months {
            if parts.len() <= FILES_A_MONTH {
                continue;
            }
            let path = Path::new(version_dir()).join(table.name).join(format!("{month}.{}.parquet", self.manifest.next));
            let longest = parts.iter().map(|part| part.longest).max().unwrap_or(0);
            let sql = format!("{}COPY (SELECT {} FROM read_parquet({}, union_by_name = true)) TO {} ({PARQUET});\n", self.settings_for(longest), names(table), self.list(parts.iter()), quoted(&self.root.join(&path)));
            let mut made = vec![Part { path: path.to_string_lossy().into_owned(), rows: parts.iter().map(|part| part.rows).sum(), bytes: 0, month: Some(month), longest }];
            let done = engine.run(&sql).map_err(|error| failed("merging", &error)).and_then(|_| self.settle(&mut made.iter_mut().collect::<Vec<_>>()));
            self.swap(table, done, parts, made)?;
        }
        Ok(())
    }

    /// Puts new files in a table's place of old ones, once writing them worked; drops them when it didn't.
    fn swap(&mut self, table: &Table, written: Result<(), String>, replaced: Vec<Part>, made: Vec<Part>) -> Result<(), String> {
        if let Err(error) = written {
            made.iter().for_each(|part| remove(&self.root.join(&part.path)));
            return Err(error);
        }
        let mut manifest = self.manifest.clone();
        manifest.next += 1;
        let parts = manifest.tables.entry(table.name.to_string()).or_default();
        parts.retain(|part| !replaced.contains(part));
        parts.extend(made);
        parts.sort_by(|a, b| a.month.cmp(&b.month).then(a.path.cmp(&b.path)));
        let at = now();
        manifest.replaced.extend(replaced.into_iter().map(|part| Replaced { path: part.path, at }));
        self.save(manifest)?;
        self.reap()
    }

    /// Removes the files merges replaced long enough ago that nothing is still reading them.
    fn reap(&mut self) -> Result<(), String> {
        let now = now();
        let (gone, kept): (Vec<Replaced>, Vec<Replaced>) = self.manifest.replaced.iter().cloned().partition(|file| now.saturating_sub(file.at) >= self.keep.as_secs());
        if gone.is_empty() {
            return Ok(());
        }
        gone.iter().for_each(|file| remove(&self.root.join(&file.path)));
        self.save(Manifest { replaced: kept, ..self.manifest.clone() })
    }

    /// Fills in how many rows each file holds, from the files themselves.
    fn count(&self, parts: &mut [Part], engine: &dyn Engine) -> Result<(), String> {
        if parts.is_empty() {
            return Ok(());
        }
        let counted = engine.run(&format!("{}SELECT filename, count(*) AS n FROM read_parquet({}, filename = true) GROUP BY ALL;\n", self.settings(), self.list(parts.iter()))).map_err(|error| failed("merging", &error))?;
        let counted: Vec<serde_json::Value> = serde_json::from_str(counted.trim()).map_err(|_| failed("merging", "Unreadable Answer"))?;
        for part in parts {
            let path = self.root.join(&part.path);
            part.rows = counted.iter().find(|row| row.get("filename").and_then(serde_json::Value::as_str).is_some_and(|name| Path::new(name) == path)).and_then(|row| row.get("n")?.as_u64()).ok_or_else(|| failed("merging", "Unreadable Answer"))?;
        }
        Ok(())
    }

    /// SQL that makes a view of each table over the files it has now, and the views worked out from them. A table
    /// with no files is a view with no rows and every column, so a query that names it still runs.
    ///
    /// A table that says where its rows came from is two views: `lines_all` is every row, and `lines` is the rows
    /// that aren't repeats, without the column that marks them, so a count over it counts each line once. A command
    /// is written before it ends, so `commands` takes how it ended from its result.
    pub fn views(&self) -> String {
        let mut sql = String::new();
        for table in &TABLES {
            let parts = self.parts(table.name);
            let columns = table.columns();
            let name = if table.placed() { format!("{}_all", table.name) } else { table.name.to_string() };
            if parts.is_empty() {
                let empty: Vec<String> = columns.iter().map(|(name, kind)| format!("CAST(NULL AS {}) AS \"{name}\"", stored(*kind))).collect();
                sql.push_str(&format!("CREATE VIEW \"{name}\" AS SELECT {} WHERE false;\n", empty.join(", ")));
            } else {
                // A thing can be in a fresh file and the merged one at once, until the next merge.
                let distinct = if table.shape == Shape::Things { "DISTINCT ON (hash) " } else { "" };
                sql.push_str(&format!("CREATE VIEW \"{name}\" AS SELECT {distinct}{} FROM read_parquet({}, union_by_name = true);\n", names(table), self.list(parts.iter())));
            }
            if !table.placed() {
                continue;
            }
            let once: Vec<String> = columns.iter().filter(|(column, _)| *column != REPEAT).map(|(column, _)| format!("\"{column}\"")).collect();
            if table.name == "commands" {
                let ended = ["exit_code", "duration_ms", "output_chars"];
                // Every Claude command is a Bash call; `k` is the calls that asked to run in the background.
                let exit_code = EXIT_CODE.replace("{bash}", "true").replace("{asked}", "k.background");
                let taken: Vec<String> = columns
                    .iter()
                    .filter(|(column, _)| *column != REPEAT)
                    .map(|(column, _)| match *column {
                        "exit_code" => format!("coalesce(c.exit_code, {exit_code}) AS exit_code"),
                        column if ended.contains(&column) => format!("coalesce(c.\"{column}\", r.\"{column}\") AS \"{column}\""),
                        column => format!("c.\"{column}\""),
                    })
                    .collect();
                sql.push_str(&format!(
                    "CREATE VIEW \"commands\" AS SELECT {} FROM \"{name}\" c LEFT JOIN {RESULTS} r ON r.agent = c.agent AND r.tool_use_id = c.tool_use_id LEFT JOIN (SELECT agent, tool_use_id, true AS background FROM \"tool_calls\" WHERE background GROUP BY agent, tool_use_id) k ON k.agent = c.agent AND k.tool_use_id = c.tool_use_id WHERE c.\"{REPEAT}\" IS NOT TRUE;\n",
                    taken.join(", ")
                ));
            } else {
                sql.push_str(&format!("CREATE VIEW \"{}\" AS SELECT {} FROM \"{name}\" WHERE \"{REPEAT}\" IS NOT TRUE;\n", table.name, once.join(", ")));
            }
        }
        for view in &VIEWS {
            sql.push_str(&format!("CREATE VIEW \"{}\" AS {};\n", view.name, view.sql.replace("{results}", RESULTS).replace("{exit_code}", &EXIT_CODE.replace("{bash}", "c.tool = 'Bash'").replace("{asked}", "c.background"))));
        }
        sql
    }

    /// What every run of the engine starts with. Times with no zone of their own are read as UTC, whatever the
    /// machine's zone; nothing is fetched or loaded; and what doesn't fit in memory spills into the store's `tmp/`.
    /// Rows are written in no promised order, which is what lets a file's groups be cut by their bytes, and a month
    /// being written takes what it has every few hundred rows: the engine otherwise holds half a million rows of
    /// each month before it writes any.
    fn settings(&self) -> String {
        self.settings_for(0)
    }

    /// The same, for reading rows as long as `longest` bytes. The engine holds a row a few times over while it
    /// reads one, so its memory grows with the longest: measured, a 300 MB row needs more than 1 GB and fits in 2.
    fn settings_for(&self, longest: u64) -> String {
        let memory = (longest.saturating_mul(6) >> 20).max(LEAST_MEMORY);
        format!(
            "SET autoinstall_known_extensions = false;\nSET autoload_known_extensions = false;\nSET TimeZone = 'UTC';\nSET temp_directory = {};\nSET memory_limit = '{memory}MiB';\nSET threads = 2;\nSET preserve_insertion_order = false;\nSET partitioned_write_flush_threshold = 256;\n",
            quoted(&self.root.join("tmp"))
        )
    }

    /// Files as a SQL list.
    fn list<'a>(&self, parts: impl Iterator<Item = &'a Part>) -> String {
        format!("[{}]", parts.map(|part| quoted(&self.root.join(&part.path))).collect::<Vec<_>>().join(", "))
    }

    /// Makes files the engine wrote safe to name in the manifest: on disk for good, and the owner's alone.
    fn settle(&self, parts: &mut [&mut Part]) -> Result<(), String> {
        for part in parts {
            let path = self.root.join(&part.path);
            let file = File::open(&path).map_err(|error| format!("Couldn't open {}: {error}", path.display()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(fs::Permissions::from_mode(0o600)).map_err(|error| format!("Couldn't close {} to others: {error}", path.display()))?;
            }
            file.sync_all().map_err(|error| format!("Couldn't flush {}: {error}", path.display()))?;
            part.bytes = file.metadata().map_or(0, |meta| meta.len());
        }
        Ok(())
    }

    fn save(&mut self, manifest: Manifest) -> Result<(), String> {
        let path = self.root.join(MANIFEST);
        let temp = self.root.join(format!(".{MANIFEST}.tmp"));
        remove(&temp);
        let bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
        let written = (|| {
            let mut file = new_file(&temp)?;
            file.write_all(&bytes).and_then(|()| file.sync_all()).map_err(|error| format!("Couldn't write {}: {error}", temp.display()))?;
            fs::rename(&temp, &path).map_err(|error| format!("Couldn't put {} in place: {error}", path.display()))?;
            // The folder's list of names, so the new manifest outlasts a power cut.
            File::open(&self.root).and_then(|dir| dir.sync_all()).map_err(|error| format!("Couldn't flush {}: {error}", self.root.display()))
        })();
        if written.is_err() {
            remove(&temp);
        }
        written?;
        self.manifest = manifest;
        Ok(())
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs())
}

fn version_dir() -> &'static str {
    "v1"
}

/// An engine's failure, for a message that can go in a log. What the engine printed can quote the rows it was
/// reading, so only the kind of error it names is kept.
fn failed(doing: &str, error: &str) -> String {
    let kind = error.lines().next().and_then(|line| line.split(':').next()).map(str::trim).filter(|kind| !kind.is_empty() && kind.len() <= 40 && kind.chars().all(|c| c.is_ascii_alphabetic() || c == ' ')).unwrap_or("an error");
    format!("The query engine stopped while {doing} tables ({kind})")
}

/// A table's columns, as a SQL list.
fn names(table: &Table) -> String {
    table.columns().iter().map(|(name, _)| format!("\"{name}\"")).collect::<Vec<_>>().join(", ")
}

/// The folders the engine wrote a month into, `month=<month>`, each with its files.
fn months_in(work: &Path) -> Result<Vec<(String, Vec<PathBuf>)>, String> {
    let read = |dir: &Path| -> Result<Vec<PathBuf>, String> {
        let mut found: Vec<PathBuf> = fs::read_dir(dir).map_err(|error| format!("Couldn't read {}: {error}", dir.display()))?.flatten().map(|entry| entry.path()).collect();
        found.sort();
        Ok(found)
    };
    let mut months = Vec::new();
    for dir in read(work)? {
        let Some(month) = dir.file_name().and_then(|name| name.to_str()).and_then(|name| name.strip_prefix("month=")) else { continue };
        // A month names a file, so it has to look like one: `2026-10` or `undated`.
        if month.is_empty() || !month.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(failed("merging", "Unreadable Answer"));
        }
        months.push((month.to_string(), read(&dir)?));
    }
    Ok(months)
}

/// A path as a SQL string.
fn quoted(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

/// The type a column has in a table.
fn stored(kind: Kind) -> &'static str {
    match kind {
        Kind::Text => "VARCHAR",
        Kind::Count | Kind::Number => "BIGINT",
        Kind::Flag => "BOOLEAN",
        Kind::Texts => "VARCHAR[]",
        Kind::Time => "TIMESTAMPTZ",
        Kind::Day => "DATE",
        Kind::Real => "DOUBLE",
    }
}

/// A query that reads a batch's file of JSON lines as a table's columns. Nothing a row holds can stop it: a time
/// that isn't one, or a count too large for the column, is read as nothing.
fn read_json(table: &Table, file: &Path, longest: u64) -> String {
    let columns = table.columns();
    let mut read: Vec<String> = columns
        .iter()
        .filter(|(_, kind)| *kind != Kind::Day)
        .map(|(name, kind)| {
            let read = match kind {
                Kind::Count => "UBIGINT",
                Kind::Time => "VARCHAR",
                other => stored(*other),
            };
            format!("\"{name}\": '{read}'")
        })
        .collect();
    if table.placed() {
        read.push(format!("\"{NEAR}\": 'VARCHAR'"));
    }
    let select: Vec<String> = columns
        .iter()
        .map(|(name, kind)| match kind {
            Kind::Count => format!("try_cast(\"{name}\" AS BIGINT) AS \"{name}\""),
            Kind::Time => format!("try_cast(\"{name}\" AS TIMESTAMPTZ) AS \"{name}\""),
            // A line with no time falls on the day of the nearest line before it that had one.
            Kind::Day => format!("CAST(try_cast({} AS TIMESTAMPTZ) AT TIME ZONE 'UTC' AS DATE) AS \"{name}\"", if table.placed() { format!("coalesce(ts, \"{NEAR}\")") } else { "ts".to_string() }),
            _ => format!("\"{name}\""),
        })
        .collect();
    format!("SELECT {} FROM read_json({}, format = 'newline_delimited', maximum_object_size = {}, columns = {{{}}})", select.join(", "), quoted(file), longest.max(SHORTEST_BUFFER), read.join(", "))
}

/// Makes one folder, the owner's alone. One that's there already has to be a folder and not a link: a store can sit
/// on a drive others write to, and a link would send writes, and the clearing of `tmp/`, somewhere outside it.
pub(crate) fn make_dir(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => match fs::symlink_metadata(path) {
            Ok(meta) if meta.is_dir() => Ok(()),
            _ => Err(format!("{} isn't a folder of the tables' own, so nothing is written through it", path.display())),
        },
        Err(error) => Err(format!("Couldn't make {}: {error}", path.display())),
    }
}

/// Makes each folder of `relative` under `root`.
fn make_dirs(root: &Path, relative: &Path) -> Result<(), String> {
    let mut dir = root.to_path_buf();
    for part in relative.components() {
        dir.push(part);
        make_dir(&dir)?;
    }
    Ok(())
}

/// Options for a file only its owner reads, when the file is made.
pub(crate) fn private() -> fs::OpenOptions {
    let mut options = fs::OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

fn new_file(path: &Path) -> Result<File, String> {
    private().create_new(true).open(path).map_err(|error| format!("Couldn't write {}: {error}", path.display()))
}

/// Removes a file, or a folder and what's in it. A link is removed, never followed.
fn remove(path: &Path) {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => {
            let _ = fs::remove_dir_all(path);
        }
        Ok(_) => {
            let _ = fs::remove_file(path);
        }
        Err(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{parse, SECRET};
    use crate::{claude, codex, pi, Detail};
    use serde_json::Value;

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("session-tables-{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(&dir).unwrap()
    }

    /// The engine the tests that write Parquet run, named by `SESSION_TABLES_DUCKDB`. Without it those tests check
    /// nothing, since a test never fetches a program: `scripts/check-query-engine.sh` fetches one and runs them.
    fn engine() -> Option<Program> {
        let path = std::env::var_os("SESSION_TABLES_DUCKDB").filter(|path| !path.is_empty())?;
        Some(Program { path: PathBuf::from(path) })
    }

    /// A request a proxy saw, in the session the made-up Claude transcript is.
    fn proxy(id: u64, failed: bool) -> ProxyRequest {
        ProxyRequest { id, ts: Some("2026-10-01T10:00:05.000Z".into()), session_id: Some("s-1".into()), model: Some("claude-test-1".into()), failed, latency_ms: Some(3000), ttft_ms: Some(1000), output: if failed { 0 } else { 500 }, cost: (!failed).then_some(0.25), ..ProxyRequest::default() }
    }

    fn ask(engine: &Program, store: &Store, query: &str) -> Vec<Value> {
        let answer = engine.run(&format!("{}{}{query};", store.settings(), store.views())).unwrap();
        serde_json::from_str(answer.trim()).unwrap()
    }

    fn files(root: &Path) -> Vec<String> {
        let mut found = Vec::new();
        let mut dirs = vec![root.to_path_buf()];
        while let Some(dir) = dirs.pop() {
            for entry in fs::read_dir(&dir).unwrap().flatten() {
                if entry.file_type().unwrap().is_dir() {
                    dirs.push(entry.path());
                } else {
                    found.push(entry.path().strip_prefix(root).unwrap().to_string_lossy().into_owned());
                }
            }
        }
        found.sort();
        found
    }

    #[test]
    fn every_table_lists_exactly_the_fields_its_rows_have() {
        let root = temp_dir("columns");
        let store = Store::open(&root).unwrap();
        let mut batch = store.batch().unwrap();
        for (agent, lines) in [(Agent::Claude, claude::tests::session()), (Agent::Codex, codex::tests::session())] {
            batch.add(&Origin { agent, machine: "cam-mbp", source: "one" }, &parse(agent, Detail::Everything, &lines)).unwrap();
        }
        batch.add_proxy(&[proxy(1, false)]).unwrap();
        let Batch { dir, files, .. } = batch;
        assert_eq!(files.keys().copied().collect::<Vec<_>>(), { let mut names: Vec<_> = TABLES.iter().map(|table| table.name).collect(); names.sort_unstable(); names });
        for (name, Waiting { file, rows, .. }) in files {
            drop(file.into_inner().unwrap());
            let text = fs::read_to_string(dir.join(format!("{name}.jsonl"))).unwrap();
            assert_eq!(text.lines().count() as u64, rows);
            let mut listed: Vec<&str> = table(name).columns().into_iter().filter(|(_, kind)| *kind != Kind::Day).map(|(column, _)| column).collect();
            listed.extend(table(name).placed().then_some(NEAR));
            listed.sort_unstable();
            for line in text.lines() {
                let Value::Object(row) = serde_json::from_str::<Value>(line).unwrap() else { panic!("{name}: a row isn't an object") };
                let mut held: Vec<&str> = row.keys().map(String::as_str).collect();
                held.sort_unstable();
                assert_eq!(held, listed, "{name}");
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    fn table(name: &str) -> &'static Table {
        crate::tables::table(name).unwrap()
    }

    #[test]
    fn a_prompt_is_in_a_batch_once_however_many_files_had_it() {
        let root = temp_dir("once");
        let store = Store::open(&root).unwrap();
        let mut batch = store.batch().unwrap();
        let rows = parse(Agent::Claude, Detail::Everything, &claude::tests::session());
        assert!(!rows.prompts.is_empty() && !rows.tool_defs.is_empty());
        for source in ["one", "two"] {
            batch.add(&Origin { agent: Agent::Claude, machine: "cam-mbp", source }, &rows).unwrap();
        }
        let distinct: HashSet<&str> = rows.prompts.iter().map(|prompt| prompt.hash.as_str()).collect();
        assert_eq!(batch.files["prompts"].rows, distinct.len() as u64);
        assert_eq!(batch.files["lines"].rows, 2 * rows.lines.len() as u64);
        assert!(batch.bytes() > 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_folder_that_is_a_link_is_refused_and_another_format_is_not_opened() {
        let root = temp_dir("edges");
        let elsewhere = temp_dir("elsewhere");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&elsewhere, root.join("tmp")).unwrap();
            assert!(Store::open(&root).err().unwrap().contains("isn't a folder"));
            assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
            fs::remove_file(root.join("tmp")).unwrap();
        }
        fs::write(root.join(MANIFEST), r#"{"format":"session-tables","schema":2,"engine":"x","next":0,"tables":{}}"#).unwrap();
        assert!(Store::open(&root).err().unwrap().contains("another format"));
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(elsewhere).unwrap();
    }

    #[test]
    fn an_engine_failure_is_reported_by_its_kind_and_never_its_words() {
        assert_eq!(failed("writing", &format!("Invalid Input Error: Malformed JSON near {SECRET}")), "The query engine stopped while writing tables (Invalid Input Error)");
        assert_eq!(failed("merging", SECRET), "The query engine stopped while merging tables (an error)");
        assert_eq!(failed("merging", ""), "The query engine stopped while merging tables (an error)");
    }

    #[test]
    fn rows_written_and_merged_read_back_the_same_with_each_month_in_a_file() {
        let Some(engine) = engine() else { return };
        let root = temp_dir("store");
        let mut store = Store::open(&root).unwrap();
        store.keep_replaced_for(Duration::ZERO);
        let claude = parse(Agent::Claude, Detail::Everything, &claude::tests::session());
        let codex = parse(Agent::Codex, Detail::Everything, &codex::tests::session());

        // Two batches: one agent each, and the first file again in the second, as a resumed session's lines are.
        let mut first = store.batch().unwrap();
        first.add(&Origin { agent: Agent::Claude, machine: "cam-mbp", source: "one" }, &claude).unwrap();
        let written = store.write(first, &engine).unwrap();
        assert_eq!(written, store.size().0);
        assert!(store.size().1 > 0);
        let mut second = store.batch().unwrap();
        second.add(&Origin { agent: Agent::Codex, machine: "it's a box", source: "two" }, &codex).unwrap();
        second.add(&Origin { agent: Agent::Claude, machine: "cam-mbp", source: "three" }, &claude).unwrap();
        store.write(second, &engine).unwrap();
        assert_eq!(fs::read_dir(root.join("tmp")).unwrap().count(), 0);

        let counts = |store: &Store| -> Vec<u64> {
            TABLES.iter().map(|table| ask(&engine, store, &format!("SELECT count(*) AS n FROM \"{}\"", table.name))[0]["n"].as_u64().unwrap()).collect()
        };
        let before = counts(&store);
        assert_eq!(before[0], (2 * claude.lines.len() + codex.lines.len()) as u64);
        let text_before = ask(&engine, &store, "SELECT agent, machine, source, line, ts, day, role, kind, text FROM messages ORDER BY ALL");
        assert!(text_before.iter().any(|row| row["text"].as_str().is_some_and(|text| text.contains(SECRET))));
        assert!(text_before.iter().any(|row| row["machine"] == "it's a box"));
        // A row's day is its time's, in UTC.
        for row in &text_before {
            if let Some(ts) = row["ts"].as_str() {
                assert_eq!(row["day"].as_str().unwrap(), &ts[..10]);
            }
        }

        assert_eq!(store.merge(&engine, 3).unwrap(), 0);
        assert!(store.merge(&engine, 2).unwrap() > 0);
        store.merge(&engine, 1).unwrap();
        assert!(store.manifest.tables.values().flatten().all(|part| part.month.is_some()));
        // A prompt is read once however many files hold it, and after a merge one file holds it once.
        let after = counts(&store);
        assert_eq!(after, before);
        for (index, table) in TABLES.iter().enumerate() {
            assert_eq!(store.parts(table.name).iter().map(|part| part.rows).sum::<u64>(), after[index], "{}", table.name);
        }
        assert_eq!(ask(&engine, &store, "SELECT agent, machine, source, line, ts, day, role, kind, text FROM messages ORDER BY ALL"), text_before);
        // Every file left is one the manifest names, and a month's file holds only that month.
        let mut named: Vec<String> = store.manifest.tables.values().flatten().map(|part| part.path.clone()).collect();
        named.push(MANIFEST.to_string());
        named.sort();
        assert_eq!(files(&root), named);
        for part in store.parts("lines") {
            let months = ask(&engine, &store, &format!("SELECT DISTINCT coalesce(strftime(day, '%Y-%m'), 'undated') AS month FROM read_parquet({})", quoted(&root.join(&part.path))));
            assert_eq!(months.len(), 1);
            assert_eq!(months[0]["month"].as_str(), part.month.as_deref());
        }

        // Opened again, it is what it was; and a later batch lands beside the months.
        let mut again = Store::open(&root).unwrap();
        assert_eq!(again.manifest, store.manifest);
        let mut third = again.batch().unwrap();
        third.add(&Origin { agent: Agent::Codex, machine: "cam-mbp", source: "four" }, &codex).unwrap();
        again.write(third, &engine).unwrap();
        again.merge(&engine, 1).unwrap();
        assert_eq!(counts(&again)[0], before[0] + codex.lines.len() as u64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for file in files(&root) {
                assert_eq!(fs::metadata(root.join(&file)).unwrap().permissions().mode() & 0o777, 0o600, "{file}");
            }
            assert_eq!(fs::metadata(root.join("v1/lines")).unwrap().permissions().mode() & 0o777, 0o700);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_table_is_read_without_its_repeats_and_a_command_takes_how_it_ended_from_its_result() {
        let Some(engine) = engine() else { return };
        let root = temp_dir("once");
        let mut store = Store::open(&root).unwrap();
        let lines = [claude::tests::session(), claude::tests::commands()].concat();
        let mut batch = store.batch().unwrap();
        for (source, repeat) in [("one", false), ("two", true)] {
            let mut parser = crate::Parser::new(Agent::Claude, Detail::Everything, crate::State::default());
            let mut rows = Rows::default();
            for (number, line) in lines.iter().enumerate() {
                parser.line_once(number as u64, line.as_bytes(), &mut |_| if repeat { crate::Seen::Elsewhere } else { crate::Seen::New }, &mut rows);
            }
            parser.finish(&mut rows);
            batch.add(&Origin { agent: Agent::Claude, machine: "cam-mbp", source }, &rows).unwrap();
        }
        // A subagent's request, under an id no transcript has, and one from a session that was never kept.
        let other = |id: u64, session: &str, parent: Option<&str>| ProxyRequest { session_id: Some(session.into()), parent_session_id: parent.map(str::to_string), ..proxy(id, false) };
        batch.add_proxy(&[proxy(1, false), proxy(2, true), other(3, "sub-1", Some("s-1")), other(4, "s-9", None)]).unwrap();
        store.write(batch, &engine).unwrap();
        for merged in [false, true] {
            if merged {
                store.merge(&engine, 1).unwrap();
            }
            let count = lines.len() as u64;
            // What the proxy saw of the session: its cost, and how fast the reply that worked was written.
            assert_eq!(ask(&engine, &store, "SELECT proxy_requests, cost FROM sessions")[0], serde_json::json!({ "proxy_requests": 3, "cost": 0.5 }));
            assert_eq!(ask(&engine, &store, "SELECT CAST(day AS VARCHAR) AS day, model, generation_ms, tokens_per_second FROM speed WHERE session_id = 's-1'"), [serde_json::json!({ "day": "2026-10-01", "model": "claude-test-1", "generation_ms": 2000, "tokens_per_second": 250.0 })]);
            assert_eq!(ask(&engine, &store, "SELECT (SELECT count(*) FROM lines) AS once, (SELECT count(*) FROM lines_all) AS every, (SELECT count(*) FROM lines_all WHERE repeat) AS repeats")[0], serde_json::json!({ "once": count, "every": 2 * count, "repeats": count }));
            // The command's row was written before it ended: its exit code is its result's.
            assert_eq!(ask(&engine, &store, "SELECT tool_use_id, exit_code, output_chars FROM commands ORDER BY line"), [serde_json::json!({ "tool_use_id": "toolu_1", "exit_code": null, "output_chars": 9 + SECRET.len() }), serde_json::json!({ "tool_use_id": "toolu_8", "exit_code": 2, "output_chars": 37 }), serde_json::json!({ "tool_use_id": "toolu_9", "exit_code": 0, "output_chars": 4 }), serde_json::json!({ "tool_use_id": "toolu_10", "exit_code": 0, "output_chars": 2 }), serde_json::json!({ "tool_use_id": "toolu_11", "exit_code": null, "output_chars": 7 })]);
            assert_eq!(ask(&engine, &store, "SELECT tool_use_id, exit_code FROM tools WHERE tool_use_id IN ('toolu_2', 'toolu_10', 'toolu_11') ORDER BY line"), [serde_json::json!({ "tool_use_id": "toolu_2", "exit_code": null }), serde_json::json!({ "tool_use_id": "toolu_10", "exit_code": 0 }), serde_json::json!({ "tool_use_id": "toolu_11", "exit_code": null })]);
            assert_eq!(ask(&engine, &store, "SELECT tool, is_error, exit_code, elapsed_ms FROM tools WHERE tool_use_id = 'toolu_8'")[0], serde_json::json!({ "tool": "Bash", "is_error": true, "exit_code": 2, "elapsed_ms": 2000 }));
            // The line with no time falls on the day of the line before it.
            assert_eq!(ask(&engine, &store, "SELECT CAST(day AS VARCHAR) AS day, ts FROM lines WHERE kind = 'mode'")[0], serde_json::json!({ "day": "2026-10-01", "ts": null }));
            let session = &ask(&engine, &store, "SELECT session_id, machine, lines, prompts, requests, output, tool_calls, tool_errors, cwd, model FROM sessions")[0];
            assert_eq!(*session, serde_json::json!({ "session_id": "s-1", "machine": "cam-mbp", "lines": count, "prompts": 1, "requests": 8, "output": 60 + 30 + 12 + 4 + 4 * 9, "tool_calls": 7, "tool_errors": 2, "cwd": "/srv/app", "model": "claude-test-1" }));
            // The one prompt led to all of it, and a bare LIMIT over the turns comes back.
            let turns = ask(&engine, &store, "SELECT session_id, machine, CAST(day AS VARCHAR) AS day, requests, output, tool_calls, tool_errors, model, elapsed_ms > 0 AS took FROM turns LIMIT 5");
            assert_eq!(turns, [serde_json::json!({ "session_id": "s-1", "machine": "cam-mbp", "day": "2026-10-01", "requests": 8, "output": 60 + 30 + 12 + 4 + 4 * 9, "tool_calls": 7, "tool_errors": 2, "model": "claude-test-1", "took": true })]);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn every_saved_query_runs_and_none_shares_a_name() {
        use crate::cookbook::{saved, SAVED};
        let names: HashSet<&str> = SAVED.iter().map(|saved| saved.name).collect();
        assert_eq!(names.len(), SAVED.len());
        for query in &SAVED {
            assert!(query.name.chars().all(|c| c.is_ascii_lowercase() || c == '-') && !query.about.is_empty(), "{}", query.name);
            assert!(query.sql.starts_with("SELECT ") || query.sql.starts_with("WITH "), "{}", query.name);
            assert_eq!(saved(query.name).map(|found| found.sql), Some(query.sql));
        }
        let Some(engine) = engine() else { return };
        let root = temp_dir("saved");
        let mut store = Store::open(&root).unwrap();
        // With no tables at all, and then with rows in them.
        for filled in [false, true] {
            if filled {
                let mut batch = store.batch().unwrap();
                for (agent, lines) in [(Agent::Claude, [claude::tests::session(), claude::tests::commands()].concat()), (Agent::Codex, codex::tests::session()), (Agent::Pi, pi::tests::session())] {
                    batch.add(&Origin { agent, machine: "cam-mbp", source: agent.name() }, &parse(agent, Detail::Everything, &lines)).unwrap();
                }
                batch.add_proxy(&[proxy(1, false), proxy(2, true)]).unwrap();
                store.write(batch, &engine).unwrap();
            }
            for query in &SAVED {
                let answer = engine.run(&format!("{}{}{};", store.settings(), store.views(), query.sql));
                assert!(answer.is_ok(), "{}: {answer:?}", query.name);
            }
        }
        let linked = ask(&engine, &store, saved("pull-requests").unwrap().sql);
        assert_eq!(linked, [serde_json::json!({ "repository": "example/app", "number": 12, "sessions": 1, "requests": 8, "tool_calls": 7, "output": 60 + 30 + 12 + 4 + 4 * 9, "cost": 0.25 })]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn row_groups_stay_small_however_much_text_rows_hold() {
        let Some(engine) = engine() else { return };
        let root = temp_dir("groups");
        let mut store = Store::open(&root).unwrap();
        // 120 MB of tool output in 3,000 rows: by row count that's one group, which the engine holds whole.
        let mut rows = parse(Agent::Codex, Detail::Everything, &codex::tests::session());
        let io = rows.tool_io.first().cloned().expect("the sample session has tool output");
        rows.tool_io = (0..3000).map(|n| crate::rows::ToolIo { text: format!("{n:08}").repeat(5000), ..io.clone() }).collect();
        let groups = |store: &Store| {
            let files: Vec<String> = store.parts("tool_io").iter().map(|part| quoted(&root.join(&part.path))).collect();
            let answer = engine.run(&format!("SELECT count(DISTINCT (file_name, row_group_id)) AS groups, max(row_group_bytes) AS most FROM parquet_metadata([{}]);", files.join(", "))).unwrap();
            let answer: Vec<Value> = serde_json::from_str(answer.trim()).unwrap();
            (answer[0]["groups"].as_u64().unwrap(), answer[0]["most"].as_u64().unwrap())
        };
        for round in 0..2 {
            let mut batch = store.batch().unwrap();
            batch.add(&Origin { agent: Agent::Codex, machine: "cam-mbp", source: &format!("file-{round}") }, &rows).unwrap();
            store.write(batch, &engine).unwrap();
            let (count, most) = groups(&store);
            assert!(count > 2 && most < 64 << 20, "fresh: {count} groups, the biggest {most} bytes");
        }
        store.merge(&engine, 1).unwrap();
        let (count, most) = groups(&store);
        assert!(count > 4 && most < 64 << 20, "merged: {count} groups, the biggest {most} bytes");
        assert_eq!(ask(&engine, &store, "SELECT count(*) AS n, min(length(text)) AS chars FROM tool_io")[0], serde_json::json!({ "n": 6000, "chars": 40000 }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_month_gathers_small_files_and_is_rewritten_as_one_past_the_limit() {
        let Some(engine) = engine() else { return };
        let root = temp_dir("gather");
        let mut store = Store::open(&root).unwrap();
        let rows = parse(Agent::Codex, Detail::Everything, &codex::tests::session());
        let mut most = 0;
        let mut listed = String::new();
        for round in 0..=FILES_A_MONTH {
            let mut batch = store.batch().unwrap();
            batch.add(&Origin { agent: Agent::Codex, machine: "cam-mbp", source: &format!("file-{round}") }, &rows).unwrap();
            store.write(batch, &engine).unwrap();
            if round == 0 {
                listed = store.views();
            }
            store.merge(&engine, 1).unwrap();
            most = most.max(store.parts("lines").len());
        }
        // Every round added a file to the month until the last, which made them one.
        assert_eq!(most, FILES_A_MONTH);
        assert_eq!(store.parts("lines").len(), 1);
        let held = (FILES_A_MONTH as u64 + 1) * rows.lines.len() as u64;
        assert_eq!(store.parts("lines")[0].rows, held);
        assert_eq!(ask(&engine, &store, "SELECT count(*) AS n, count(DISTINCT source) AS sources FROM lines")[0], serde_json::json!({ "n": held, "sources": FILES_A_MONTH + 1 }));
        // A table of distinct things is one file all along.
        assert_eq!(store.parts("tool_defs").len(), 1);
        assert_eq!(ask(&engine, &store, "SELECT count(*) AS n FROM tool_defs")[0]["n"].as_u64(), Some(store.parts("tool_defs")[0].rows));
        let mut named: Vec<String> = store.manifest.tables.values().flatten().map(|part| part.path.clone()).collect();
        named.push(MANIFEST.to_string());
        named.sort();
        // A query that listed the files before the first merge still finds them, every merge since replaced or not.
        let answer = engine.run(&format!("{}{listed}SELECT count(*) AS n FROM lines;", store.settings())).unwrap();
        assert_eq!(serde_json::from_str::<Vec<Value>>(answer.trim()).unwrap()[0]["n"], rows.lines.len());
        assert!(files(&root).len() > named.len());
        // Once they've been kept long enough, the next merge takes them.
        store.keep_replaced_for(Duration::ZERO);
        store.merge(&engine, 1).unwrap();
        assert_eq!(files(&root), named);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_table_with_no_rows_is_a_view_with_every_column() {
        let Some(engine) = engine() else { return };
        let root = temp_dir("empty");
        let store = Store::open(&root).unwrap();
        let all = TABLES.iter().filter(|table| table.placed()).map(|table| (format!("{}_all", table.name), table.columns()));
        for (name, columns) in crate::tables::shown().into_iter().map(|shown| (shown.name.to_string(), shown.columns)).chain(all) {
            let described = ask(&engine, &store, &format!("DESCRIBE \"{name}\""));
            let found: Vec<(String, String)> = described.iter().map(|row| (row["column_name"].as_str().unwrap().to_string(), row["column_type"].as_str().unwrap().to_string())).collect();
            let listed: Vec<(String, String)> = columns.into_iter().map(|(name, kind)| (name.to_string(), stored(kind).replace("TIMESTAMPTZ", "TIMESTAMP WITH TIME ZONE"))).collect();
            assert_eq!(found, listed, "{name}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn what_a_row_holds_never_stops_a_write() {
        let Some(engine) = engine() else { return };
        let root = temp_dir("odd");
        let mut store = Store::open(&root).unwrap();
        let long = "x".repeat(20 << 20);
        let mut rows = Rows::default();
        rows.lines.push(crate::Line { at: crate::At { line: u64::MAX, ts: Some("not a time".into()), session_id: Some("it's \"quoted\"\n\u{0}".into()), ..Default::default() }, kind: "odd".into(), bytes: u64::MAX, rest: Some(long.clone()), ..Default::default() });
        rows.lines.push(crate::Line { at: crate::At { line: 1, ts: Some("2026-10-31T23:59:59.5-02:00".into()), ..Default::default() }, kind: "zoned".into(), ..Default::default() });
        let mut batch = store.batch().unwrap();
        batch.add(&Origin { agent: Agent::Claude, machine: "cam-mbp", source: "one" }, &rows).unwrap();
        assert_eq!(store.write(batch, &engine).unwrap(), 2);
        let read = ask(&engine, &store, "SELECT line, ts, day, session_id, bytes, length(rest) AS rest FROM lines ORDER BY kind");
        assert_eq!(read[0]["line"], Value::Null);
        assert_eq!(read[0]["ts"], Value::Null);
        assert_eq!(read[0]["day"], Value::Null);
        assert_eq!(read[0]["bytes"], Value::Null);
        assert_eq!(read[0]["rest"].as_u64(), Some(long.len() as u64));
        assert!(read[0]["session_id"].as_str().unwrap().starts_with("it's \"quoted\"\n"));
        // A time in another zone lands on its UTC day: the first of the next month here.
        assert_eq!(read[1]["day"].as_str(), Some("2026-11-01"));
        store.merge(&engine, 1).unwrap();
        let months: Vec<Option<&str>> = store.parts("lines").iter().map(|part| part.month.as_deref()).collect();
        assert_eq!(months, [Some("2026-11"), Some("undated")]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_write_that_fails_leaves_the_tables_as_they_were_and_a_sweep_clears_what_is_left() {
        struct Broken;
        impl Engine for Broken {
            fn run(&self, _: &str) -> Result<String, String> {
                Err(format!("IO Error: no room for {SECRET}"))
            }
        }
        let root = temp_dir("fails");
        let mut store = Store::open(&root).unwrap();
        let mut batch = store.batch().unwrap();
        batch.add(&Origin { agent: Agent::Claude, machine: "cam-mbp", source: "one" }, &parse(Agent::Claude, Detail::Everything, &claude::tests::session())).unwrap();
        assert_eq!(store.write(batch, &Broken).err().unwrap(), "The query engine stopped while writing tables (IO Error)");
        assert!(store.manifest.tables.is_empty());
        assert_eq!(store.next(), 0);
        // A batch with nothing in it writes nothing, and one dropped leaves nothing.
        assert_eq!(store.write(store.batch().unwrap(), &Broken), Ok(0));
        store.batch().unwrap().discard();
        assert_eq!(fs::read_dir(root.join("tmp")).unwrap().count(), 0);
        // What a stopped run leaves: a batch never written, and a file no table names.
        fs::create_dir(root.join("tmp/batch-9")).unwrap();
        fs::write(root.join("tmp/batch-9/lines.jsonl"), SECRET).unwrap();
        fs::write(root.join("v1/lines/fresh/0000000009.parquet"), SECRET).unwrap();
        store.sweep().unwrap();
        assert_eq!(files(&root), Vec::<String>::new());
        fs::write(root.join("state.db"), "kept").unwrap();
        fs::write(root.join(MANIFEST), "{}").unwrap();
        Store::clear(&root);
        assert_eq!(files(&root), ["state.db"]);
        fs::remove_dir_all(root).unwrap();
    }
}

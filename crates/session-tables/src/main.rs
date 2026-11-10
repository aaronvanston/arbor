//! `session-tables`: this machine's coding agent sessions as tables to ask questions of. `build` reads the agents'
//! own transcripts into Parquet files in a folder, and `query` runs SQL over them with DuckDB. Nothing leaves the
//! machine, and the transcripts are only ever read.

use session_tables::cookbook::{saved, SAVED};
use session_tables::local::{build, homes, Home};
use session_tables::store::{Engine, Program, Store, DUCKDB_VERSION};
use session_tables::tables::{shown, Kind};
use session_tables::{Agent, Detail};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const HELP: &str = "session-tables: your coding agents' sessions as tables

  session-tables build              Read what's new in every session into the tables
  session-tables query <select>     Ask the tables a question, in DuckDB's SQL
  session-tables query --saved      List the ready-made questions; add a name to ask one
  session-tables tables             List every table and view with its columns
  session-tables views              Print the SQL that names the tables, for a DuckDB of your own:
                                    duckdb -init <(session-tables views)

Options
  --out <folder>       Where the tables are kept (default ~/.local/share/session-tables, or under XDG_DATA_HOME)
  --duckdb <path>      DuckDB's command-line program (default SESSION_TABLES_DUCKDB, then duckdb on your PATH)
  --json               query: print rows as JSON

build only
  --claude <home>      A Claude Code home to read, in place of ~/.claude. Repeat it for more
  --codex <home>       A Codex home, in place of ~/.codex
  --pi <home>          A Pi home, in place of ~/.pi/agent
  --openclaw <home>    An OpenClaw home, in place of ~/.openclaw
  --numbers-only       Keep names, ids, counts, sizes and times, and no prompt, reply, command or tool output
  --machine <name>     The name rows carry for this machine (default its host name)
  --quiet              Don't print each file as it's read

build reads only what is new since the last run, so it can run as often as you like. It never changes a transcript.
Changing --numbers-only makes the tables again.
";

struct Options {
    command: String,
    words: Vec<String>,
    out: Option<PathBuf>,
    duckdb: Option<PathBuf>,
    homes: Vec<Home>,
    numbers_only: bool,
    machine: Option<String>,
    json: bool,
    quiet: bool,
    saved: bool,
}

fn options(mut args: impl Iterator<Item = String>) -> Result<Options, String> {
    let mut options = Options { command: args.next().unwrap_or_default(), words: Vec::new(), out: None, duckdb: None, homes: Vec::new(), numbers_only: false, machine: None, json: false, quiet: false, saved: false };
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--out" => options.out = Some(PathBuf::from(value("--out")?)),
            "--duckdb" => options.duckdb = Some(PathBuf::from(value("--duckdb")?)),
            "--machine" => options.machine = Some(value("--machine")?),
            "--claude" | "--codex" | "--pi" | "--openclaw" => {
                let agent = Agent::named(&arg[2..]).ok_or("No such agent")?;
                options.homes.push(Home { agent, path: PathBuf::from(value(&arg)?) });
            }
            "--numbers-only" => options.numbers_only = true,
            "--json" => options.json = true,
            "--quiet" => options.quiet = true,
            "--saved" => options.saved = true,
            flag if flag.starts_with("--") => return Err(format!("There's no option {flag}. Run session-tables --help for the ones there are.")),
            _ => options.words.push(arg),
        }
    }
    Ok(options)
}

fn user_home() -> Result<PathBuf, String> {
    std::env::var_os("HOME").filter(|home| !home.is_empty()).map(PathBuf::from).ok_or_else(|| "HOME isn't set, so pass --out and the homes to read".to_string())
}

fn out(options: &Options) -> Result<PathBuf, String> {
    if let Some(out) = &options.out {
        return Ok(out.clone());
    }
    match std::env::var_os("XDG_DATA_HOME").filter(|dir| !dir.is_empty()) {
        Some(data) => Ok(PathBuf::from(data).join("session-tables")),
        None => Ok(user_home()?.join(".local/share/session-tables")),
    }
}

/// DuckDB's program: the one named, or the one on the PATH.
fn engine(options: &Options) -> Result<Program, String> {
    let named = options.duckdb.clone().or_else(|| std::env::var_os("SESSION_TABLES_DUCKDB").filter(|path| !path.is_empty()).map(PathBuf::from));
    let program = Program { path: named.unwrap_or_else(|| PathBuf::from("duckdb")) };
    match program.run("SELECT version() AS version;") {
        Ok(_) => Ok(program),
        Err(error) => Err(format!(
            "DuckDB's command-line program is needed and wasn't found ({error}).\nInstall it (https://duckdb.org/install, or `brew install duckdb`) or pass --duckdb <path>. This was written against DuckDB {DUCKDB_VERSION}."
        )),
    }
}

fn machine(options: &Options) -> String {
    let named = options.machine.clone().or_else(|| std::env::var("HOSTNAME").ok()).or_else(|| std::fs::read_to_string("/etc/hostname").ok());
    let named = named.or_else(|| std::process::Command::new("hostname").output().ok().and_then(|output| String::from_utf8(output.stdout).ok()));
    named.map(|name| name.trim().to_string()).filter(|name| !name.is_empty()).unwrap_or_else(|| "local".to_string())
}

fn megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / f64::from(1 << 20))
}

fn run_build(options: &Options) -> Result<(), String> {
    let root = out(options)?;
    let homes = if options.homes.is_empty() { homes(&user_home()?) } else { options.homes.clone() };
    if homes.is_empty() {
        return Err("No agent home was found here (~/.claude, ~/.codex, ~/.pi/agent, ~/.openclaw). Pass one with --claude, --codex, --pi or --openclaw.".to_string());
    }
    let engine = engine(options)?;
    let detail = if options.numbers_only { Detail::Numbers } else { Detail::Everything };
    let started = std::time::Instant::now();
    let mut said = |path: &Path| {
        if !options.quiet {
            eprintln!("  {}", path.display());
        }
    };
    let report = build(&root, &homes, detail, &machine(options), &engine, &mut said)?;
    println!("Read {} of new lines in {} files: {} rows added in {:.1}s.", megabytes(report.bytes), report.files, report.rows, started.elapsed().as_secs_f64());
    if report.unread > 0 {
        println!("{} files couldn't be read, and are tried again next time.", report.unread);
    }
    println!("The tables hold {} rows in {}, in {}.", report.table_rows, megabytes(report.table_bytes), root.display());
    Ok(())
}

/// What every query starts with: the engine reaches nothing but the tables' folder, fetches and loads nothing, and
/// can't be told otherwise by the query. It still can write inside that folder, which `build` makes again.
fn confined(root: &Path) -> String {
    let dir = |name: &str| format!("'{}/'", root.join(name).to_string_lossy().replace('\'', "''"));
    format!(
        "SET TimeZone = 'UTC';\nSET temp_directory = {tmp};\nSET allowed_directories = [{tables}, {tmp}];\nSET enable_external_access = false;\nSET autoinstall_known_extensions = false;\nSET autoload_known_extensions = false;\nSET allow_community_extensions = false;\nSET lock_configuration = true;\n",
        tmp = dir("tmp"),
        tables = dir("v1"),
    )
}

fn run_query(options: &Options) -> Result<(), String> {
    let sql = match (options.saved, options.words.first()) {
        (true, None) => {
            let width = SAVED.iter().map(|saved| saved.name.len()).max().unwrap_or(0);
            SAVED.iter().for_each(|saved| println!("{:width$}  {}", saved.name, saved.about));
            return Ok(());
        }
        (true, Some(name)) => saved(name).ok_or_else(|| format!("There's no saved question called {name}. Run session-tables query --saved for the list."))?.sql.to_string(),
        (false, Some(sql)) => sql.trim().trim_end_matches(';').to_string(),
        (false, None) => return Err("Give a SELECT to run, or --saved.".to_string()),
    };
    let root = out(options)?;
    if !root.join("manifest.json").exists() {
        return Err(format!("There are no tables in {} yet. Run session-tables build first.", root.display()));
    }
    let store = Store::open(&root)?;
    let program = engine(options)?;
    let mut command = std::process::Command::new(&program.path);
    command.args(["-no-agent", "-no-init", "-bail"]);
    // The views and settings go in quietly, so only the query's own rows are printed.
    command.args(["-cmd", &format!("{}{}", confined(&root), store.views().replace('\n', " "))]);
    command.arg(if options.json { "-json" } else { "-box" });
    command.args(["-c", &format!("{sql};")]);
    let status = command.status().map_err(|error| format!("Couldn't start {}: {error}", program.path.display()))?;
    if status.success() {
        Ok(())
    } else {
        Err(String::new())
    }
}

fn run_tables() {
    for table in shown() {
        println!("{}", table.name);
        for (name, kind) in table.columns {
            let kind = match kind {
                Kind::Text => "text",
                Kind::Texts => "list of text",
                Kind::Count | Kind::Number => "integer",
                Kind::Real => "number",
                Kind::Flag => "yes or no",
                Kind::Time => "time",
                Kind::Day => "day",
            };
            println!("  {name:<22} {kind}");
        }
    }
}

fn run(options: &Options) -> Result<(), String> {
    match options.command.as_str() {
        "build" => run_build(options),
        "query" => run_query(options),
        "tables" => {
            run_tables();
            Ok(())
        }
        "views" => {
            let root = out(options)?;
            print!("{}", Store::open(&root)?.views());
            Ok(())
        }
        "" | "help" | "--help" | "-h" => {
            print!("{HELP}");
            Ok(())
        }
        other => Err(format!("There's no command {other}. Run session-tables --help for the ones there are.")),
    }
}

fn main() -> ExitCode {
    match options(std::env::args().skip(1)).and_then(|options| run(&options)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            if !error.is_empty() {
                eprintln!("{error}");
            }
            ExitCode::FAILURE
        }
    }
}

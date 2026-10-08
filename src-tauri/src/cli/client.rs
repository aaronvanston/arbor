//! `arbor` itself: finds the running app's socket (opening Arbor hidden when it isn't running), sends one request a
//! line and prints the answers. It never opens the app's files; everything goes through the app.

use super::{args, help, mcp, protocol, render, settings};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::{fs::MetadataExt, net::UnixStream},
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

/// Exit codes, so a script can tell what happened without reading the words.
pub(crate) mod exit {
    pub(crate) const OK: i32 = 0;
    pub(crate) const FAILED: i32 = 1;
    pub(crate) const USAGE: i32 = 2;
    /// A change that asks first, asked without `--yes`: nothing happened.
    pub(crate) const NEEDS_YES: i32 = 10;
    /// Arbor isn't running, or doesn't answer.
    pub(crate) const UNAVAILABLE: i32 = 69;
    /// The app speaks a newer protocol than this `arbor`, or an older one.
    pub(crate) const PROTOCOL: i32 = 76;
    /// The socket isn't this user's.
    pub(crate) const PERMISSION: i32 = 77;
}

/// Why a run ended without an answer, with the exit code that says so.
#[derive(Debug)]
pub(crate) struct Failure {
    pub(crate) code: i32,
    pub(crate) message: String,
}

impl Failure {
    fn new(code: i32, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// What the app answered.
pub(crate) enum Answer {
    Ok(Value),
    /// The change needs confirming; this is what it would do.
    Plan(Value),
}

/// A connection to the running app.
pub(crate) struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    next_id: u64,
    pub(crate) hello: Value,
}

impl Client {
    /// Connects, opening Arbor first when it isn't running and that's allowed, and says hello.
    pub(crate) fn connect(name: &str, launch: bool, timeout: Duration) -> Result<Self, Failure> {
        let path = super::socket_path().map_err(|error| Failure::new(exit::FAILED, error))?;
        let stream = match open(&path) {
            Ok(stream) => stream,
            Err(_) if launch => {
                launch_arbor()?;
                wait_for(&path, timeout)?
            }
            Err(_) => return Err(not_running()),
        };
        let writer = stream.try_clone().map_err(|error| Failure::new(exit::FAILED, error.to_string()))?;
        let mut client = Self { reader: BufReader::new(stream), writer, next_id: 0, hello: Value::Null };
        let hello = match client.ask(protocol::HELLO, json!({ "client": name }), false)? {
            Answer::Ok(hello) | Answer::Plan(hello) => hello,
        };
        let theirs = hello.get("protocol").and_then(Value::as_u64).unwrap_or_default();
        if theirs != u64::from(protocol::PROTOCOL) {
            return Err(Failure::new(
                exit::PROTOCOL,
                format!("This arbor speaks protocol {} and Arbor speaks {theirs}. Update Arbor, then reinstall the command from Settings › App.", protocol::PROTOCOL),
            ));
        }
        client.hello = hello;
        Ok(client)
    }

    fn send(&mut self, request: &Value) -> Result<(), Failure> {
        let mut line = serde_json::to_vec(request).map_err(|error| Failure::new(exit::FAILED, error.to_string()))?;
        line.push(b'\n');
        self.writer.write_all(&line).map_err(lost)
    }

    fn receive(&mut self) -> Result<Value, Failure> {
        let mut line = String::new();
        let read = self.reader.read_line(&mut line).map_err(lost)?;
        if read == 0 {
            return Err(Failure::new(exit::UNAVAILABLE, "Arbor closed the connection."));
        }
        serde_json::from_str(&line).map_err(|error| Failure::new(exit::FAILED, format!("Arbor's answer couldn't be read: {error}")))
    }

    /// Asks the app one thing and waits for its answer.
    pub(crate) fn ask(&mut self, method: &str, args: Value, confirm: bool) -> Result<Answer, Failure> {
        self.next_id += 1;
        let id = self.next_id.to_string();
        self.send(&json!({ "v": protocol::PROTOCOL, "id": id, "method": method, "args": args, "confirm": confirm }))?;
        let answer = self.receive()?;
        if let Some(error) = answer.get("error") {
            let kind = error.get("kind").and_then(Value::as_str).unwrap_or("failed");
            let code = if kind == "unavailable" { exit::UNAVAILABLE } else { exit::FAILED };
            return Err(Failure::new(code, render::field(error, "message")));
        }
        if let Some(plan) = answer.get("plan") {
            return Ok(Answer::Plan(plan.clone()));
        }
        Ok(Answer::Ok(answer.get("ok").cloned().unwrap_or(Value::Null)))
    }

    /// Asks for something that only reads.
    pub(crate) fn read(&mut self, method: &str, args: Value) -> Result<Value, Failure> {
        match self.ask(method, args, false)? {
            Answer::Ok(value) | Answer::Plan(value) => Ok(value),
        }
    }

    /// Starts `watch` and hands each event line to `each` until the app goes away or `each` says stop.
    fn watch(&mut self, events: Vec<String>, mut each: impl FnMut(&Value) -> bool) -> Result<(), Failure> {
        self.send(&json!({ "v": protocol::PROTOCOL, "id": "watch", "method": protocol::WATCH, "args": { "events": events } }))?;
        let started = self.receive()?;
        if let Some(error) = started.get("error") {
            return Err(Failure::new(exit::FAILED, render::field(error, "message")));
        }
        loop {
            let event = self.receive()?;
            if !each(&event) {
                return Ok(());
            }
        }
    }
}

fn lost(error: std::io::Error) -> Failure {
    Failure::new(exit::UNAVAILABLE, format!("Lost the connection to Arbor: {error}"))
}

fn not_running() -> Failure {
    Failure::new(exit::UNAVAILABLE, "Arbor isn't running. Open it, then try again.")
}

/// Opens the socket, after checking it's this user's: anything else could be someone posing as Arbor.
fn open(path: &Path) -> Result<UnixStream, Failure> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| not_running())?;
    if meta.uid() != unsafe { libc::geteuid() } {
        return Err(Failure::new(exit::PERMISSION, format!("{} isn't yours, so arbor won't use it.", path.display())));
    }
    UnixStream::connect(path).map_err(|_| not_running())
}

/// Opens Arbor in the background, without its window, the way logging in does.
fn launch_arbor() -> Result<(), Failure> {
    let Some(app) = settings::linkable_executable().and_then(|exe| exe.ancestors().nth(3).map(Path::to_path_buf)) else {
        return Err(not_running());
    };
    let mut command = Command::new("/usr/bin/open");
    command.args(["-g", "-j", "-a"]).arg(&app);
    crate::configure_background_command(&mut command);
    let status = command.status().map_err(|error| Failure::new(exit::UNAVAILABLE, format!("Couldn't open Arbor: {error}")))?;
    if !status.success() {
        return Err(Failure::new(exit::UNAVAILABLE, "Couldn't open Arbor."));
    }
    eprintln!("Opening Arbor…");
    Ok(())
}

fn wait_for(path: &Path, timeout: Duration) -> Result<UnixStream, Failure> {
    let deadline = Instant::now() + timeout;
    loop {
        match open(path) {
            Ok(stream) => return Ok(stream),
            Err(failure) if failure.code == exit::PERMISSION => return Err(failure),
            Err(_) if Instant::now() >= deadline => {
                return Err(Failure::new(
                    exit::UNAVAILABLE,
                    "Arbor didn't answer. If it's open, update it to the latest version, which answers the command line.",
                ));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(150)),
        }
    }
}

pub(super) const HELP: &str = "arbor: Arbor from the command line

Usage: arbor [command] [flags]

  status                       The proxy, machines, live sessions and alerts at a glance (the default)
  machines [name]              Every machine's health, or one machine in full
  pools                        Machine pools and who would take each one's next run
  pools connect <pool> [host]  Carry an SSH connection to a pool member (ssh's ProxyCommand)
  pools start <pool> --repo owner/name --agent claude --prompt '…'
                               Start a session on whichever member has room
  pools recent [pool]          Sessions started on pools, and how each went
  sessions [--live]            Recent sessions, or the ones running now
  usage [today|7d|30d]         Requests, tokens and cost
  accounts [refresh]           Signed-in accounts and their limits (refresh reads them again)
  accounts pause|resume <account>
  accounts cap <account> <percent|off>
  routing [<provider> on|off]  Automatic account order per provider
  alerts [seen]                Recent alerts, or mark them all seen
  sync                         How far each machine is from the setup repo
  sync repo                    Whether the setup repo is kept in step with its remote
  sync auto [pause|resume <m>] Machines brought in line by themselves, and pausing one
  sync <machine>               What bringing it in line would change
  sync apply <machine>         Bring it in line (backed up first)
  core [status|start|stop|restart|install [version]]
  archive                      The session archive
  archive export --out <folder> [--project name] [--since 30d] [--machine name]
                               Put kept sessions back together, one folder per session
  settings [get|set|unset] [name] [value]
                               Arbor's saved settings
  commands [filter]            Everything arbor can call
  call <command> [name=value…] [--args JSON]
                               Call any command directly
  watch [event…]               Print Arbor's events as they happen
  mcp [--read-only]            Serve Arbor to an agent over MCP (stdio)
  skill [install]              The skill that teaches agents arbor, or add it to this Mac's agent homes
  install                      Link arbor into ~/.local/bin
  doctor                       Check that arbor can reach Arbor
  version
  help [command]               This list, or one command's usage with examples

Flags:
  --json        Print Arbor's answer as JSON
  --yes, -y     Go ahead with a change that asks first (stopping the proxy, removing things)
  --no-launch   Don't open Arbor when it isn't running
  --timeout N   Seconds to wait for Arbor to open (30)

Exit codes: 0 done, 1 failed, 2 usage, 10 needs --yes, 69 Arbor unavailable, 76 version mismatch, 77 permission.
";

/// Runs `arbor` and gives its exit code.
pub(crate) fn run(arguments: Vec<String>) -> i32 {
    // Like any command line tool, stop quietly when what reads the output goes away (`arbor sessions | head`) instead
    // of panicking on the broken pipe; Rust ignores SIGPIPE by default.
    unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) };
    let options = match args::parse(&arguments) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}");
            return exit::USAGE;
        }
    };
    let asked_help = options.words.first().is_some_and(|word| word == "help");
    if options.help || asked_help {
        // `arbor help sync` and `arbor sync --help` give that command's own help.
        let command = options.words.get(usize::from(asked_help));
        match command {
            None => print!("{HELP}"),
            Some(command) => match help::topic(command) {
                Some(text) => print!("{text}"),
                None => {
                    eprintln!("arbor has no command called {command}. Run arbor help to see them.");
                    return exit::USAGE;
                }
            },
        }
        return exit::OK;
    }
    match run_command(&options) {
        Ok(()) => exit::OK,
        Err(failure) => {
            if !failure.message.is_empty() {
                eprintln!("{}", failure.message);
            }
            failure.code
        }
    }
}

/// The name Arbor keeps a machine under, from what someone typed: its name or its SSH host, in any case, with spaces,
/// dashes or dots between words (`cedar-dev-01` finds "Cedar dev 01"). Anything else is passed on as typed.
fn machine_name(client: &mut Client, typed: &str) -> Result<String, Failure> {
    let hosts = client.read("get_machine_hosts", Value::Null)?;
    Ok(matching_machine(&hosts, typed).unwrap_or_else(|| typed.to_string()))
}

fn matching_machine(hosts: &Value, typed: &str) -> Option<String> {
    let loose = |text: &str| text.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect::<String>();
    let wanted = loose(typed);
    let hosts = hosts.as_array()?;
    let machine = |host: &Value| render::field(host, "machine");
    hosts
        .iter()
        .find(|host| machine(host) == typed)
        .or_else(|| hosts.iter().find(|host| loose(&machine(host)) == wanted))
        .or_else(|| hosts.iter().find(|host| loose(&render::field(host, "endpoint")) == wanted))
        .map(machine)
}

/// The pool typed, by its id or its name in any case: its id, name and members.
fn matching_pool(pools: &Value, typed: &str) -> Result<(String, String, Vec<String>), Failure> {
    let loose = |text: &str| text.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect::<String>();
    let all = pools.as_array().map(Vec::as_slice).unwrap_or(&[]);
    let pool = all
        .iter()
        .find(|pool| render::field(pool, "id") == typed)
        .or_else(|| all.iter().find(|pool| loose(&render::field(pool, "name")) == loose(typed)))
        .ok_or_else(|| Failure::new(exit::FAILED, format!("Arbor has no pool called {typed}. arbor pools lists them.")))?;
    let members = render::items(pool, "members").iter().map(|member| render::field(member, "machine")).collect();
    Ok((render::field(pool, "id"), render::field(pool, "name"), members))
}

/// A repository typed as `owner/name`, found among the members' checkouts as their Projects scans saw them, as the
/// `host/owner/name` a run names. One typed in full is taken as it is.
fn matching_repo(projects: &Value, members: &[String], pool: &str, typed: &str) -> Result<String, Failure> {
    let typed = typed.trim().trim_end_matches(".git").to_ascii_lowercase();
    if typed.split('/').count() >= 3 {
        return Ok(typed);
    }
    let mut found: Vec<String> = projects
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|scan| members.contains(&render::field(scan, "machine")))
        .flat_map(|scan| render::items(scan, "repos"))
        .filter_map(|repo| repo.get("remote").and_then(Value::as_str))
        .map(|remote| remote.trim_end_matches(".git").to_ascii_lowercase())
        .filter(|remote| remote.ends_with(&format!("/{typed}")))
        .collect();
    found.sort();
    found.dedup();
    match found.as_slice() {
        [one] => Ok(one.clone()),
        [] => Err(Failure::new(
            exit::FAILED,
            format!("No member of {pool} has a checkout of {typed} that Arbor has seen. Give it in full, like github.com/{typed}, and Arbor looks on the members it hasn't scanned yet."),
        )),
        many => Err(usage_error(format!("{typed} could be {}. Give the one you mean in full.", many.join(" or ")))),
    }
}

/// Starts a session on a pool: Arbor picks the member, which works in its own checkout of the repository (or the
/// folder), in a worktree of its own unless asked not to. Like the window's New session it asks first.
fn pool_start(options: &args::Options, pool: &str, rest: &[&str]) -> Result<(), Failure> {
    let mut start = args::pool_start(rest).map_err(usage_error)?;
    if start.prompt == "-" {
        let mut prompt = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut prompt).map_err(|error| Failure::new(exit::FAILED, format!("Couldn't read the prompt: {error}")))?;
        start.prompt = prompt;
    }
    let mut client = connect(options)?;
    let (pool_id, pool_name, members) = matching_pool(&client.read("get_pools", Value::Null)?, pool)?;
    let repo = match &start.repo {
        Some(typed) => Some(matching_repo(&client.read("get_projects", Value::Null)?, &members, &pool_name, typed)?),
        None => None,
    };
    let request = json!({
        "pool": pool_id,
        "harness": if start.cli { "headless" } else { "orca" },
        "setup": start.agent,
        "folder": start.folder.unwrap_or_default(),
        "repo": repo,
        "worktree": !start.no_worktree,
        "prompt": start.prompt,
        "model": start.model,
        "fallback": start.fallback,
        "title": start.title,
    });
    let run = match client.ask("start_pool_run", json!({ "request": request }), options.yes)? {
        Answer::Ok(run) => run,
        Answer::Plan(plan) => {
            if options.json {
                print_json(&json!({ "needsConfirmation": true, "plan": plan }));
            } else {
                println!("{}", render::session_plan(&request, &pool_name));
            }
            return Err(Failure::new(exit::NEEDS_YES, ""));
        }
    };
    if options.json {
        print_json(&run);
    }
    match render::run_started(&run) {
        Ok(line) => {
            if !options.json {
                println!("{line}");
            }
            Ok(())
        }
        Err(line) => Err(Failure::new(exit::FAILED, if options.json { String::new() } else { line })),
    }
}

fn connect(options: &args::Options) -> Result<Client, Failure> {
    Client::connect("cli", !options.no_launch, Duration::from_secs(options.timeout))
}

fn print_json(value: &Value) {
    println!("{}", serde_json::to_string_pretty(value).unwrap_or_default());
}

/// Prints an answer: JSON when asked for, otherwise the given rendering.
fn show(options: &args::Options, value: &Value, human: impl FnOnce(&Value) -> String) {
    if options.json {
        print_json(value);
    } else {
        println!("{}", human(value));
    }
}

/// Runs a change, printing its plan and stopping when it asks first and there's no `--yes`.
fn change(client: &mut Client, options: &args::Options, method: &str, args: Value) -> Result<Value, Failure> {
    match client.ask(method, args, options.yes)? {
        Answer::Ok(value) => Ok(value),
        Answer::Plan(plan) => {
            if options.json {
                print_json(&json!({ "needsConfirmation": true, "plan": plan }));
            } else {
                println!("{}", render::plan(&plan));
            }
            Err(Failure::new(exit::NEEDS_YES, ""))
        }
    }
}

fn usage_error(message: impl Into<String>) -> Failure {
    Failure::new(exit::USAGE, message)
}

fn run_command(options: &args::Options) -> Result<(), Failure> {
    let words: Vec<&str> = options.words.iter().map(String::as_str).collect();
    match words.as_slice() {
        [] | ["status"] => status(options),
        ["version"] => {
            println!("arbor {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        ["install"] => install(options),
        // The skill is part of arbor itself, so printing it needs no app.
        ["skill"] => {
            print!("{}", super::SKILL);
            Ok(())
        }
        ["skill", "install"] => {
            let mut client = connect(options)?;
            let installed = change(&mut client, options, "install_cli_skill", json!({}))?;
            show(options, &installed, render::skill_install);
            Ok(())
        }
        ["doctor"] => doctor(options),
        ["mcp", rest @ ..] => {
            let read_only = rest.contains(&"--read-only");
            mcp::serve(read_only, !options.no_launch, Duration::from_secs(options.timeout))
        }
        ["machines"] => {
            let mut client = connect(options)?;
            let snapshot = client.read("get_machine_health", json!({ "passive": true }))?;
            show(options, &snapshot, render::machines);
            Ok(())
        }
        ["machines", name] => {
            let mut client = connect(options)?;
            let name = machine_name(&mut client, name)?;
            let snapshot = client.read("get_machine_health", json!({ "passive": true }))?;
            let machine = render::items(&snapshot, "machines")
                .iter()
                .find(|machine| render::field(machine, "machine") == name)
                .cloned()
                .ok_or_else(|| Failure::new(exit::FAILED, format!("Arbor has no machine called {name}.")))?;
            print_json(&machine);
            Ok(())
        }
        ["pools" | "pool", "connect", pool, host @ ..] => pool_connect(options, pool, host.first().copied().unwrap_or_default()),
        ["pools" | "pool", "start", pool, rest @ ..] => pool_start(options, pool, rest),
        ["pools" | "pool", "recent", pool @ ..] => {
            let mut client = connect(options)?;
            let pool = match pool.first() {
                Some(typed) => Some(matching_pool(&client.read("get_pools", Value::Null)?, typed)?.0),
                None => None,
            };
            let runs = client.read("get_runs", Value::Null)?;
            show(options, &runs, |runs| render::recent_runs(runs, pool.as_deref()));
            Ok(())
        }
        ["pools"] => {
            let mut client = connect(options)?;
            let pools = client.read("get_pools", Value::Null)?;
            let previews = client.read("preview_pools", Value::Null)?;
            show(options, &json!({ "pools": pools, "previews": previews }), render::pools);
            Ok(())
        }
        ["sessions", rest @ ..] => sessions(options, rest.contains(&"--live")),
        ["usage"] => usage(options, "today"),
        ["usage", range] => usage(options, range),
        ["accounts"] => window_action(options, "accounts.list", json!({}), render::accounts),
        ["accounts", "refresh"] => window_action(options, "accounts.list", json!({ "refresh": true }), render::accounts),
        ["accounts", action @ ("pause" | "resume"), account] => {
            window_action(options, &format!("accounts.{action}"), json!({ "account": account }), |_| format!("Done: {account} is {action}d."))
        }
        ["accounts", "cap", account, percent] => {
            let percent = if *percent == "off" { Value::Null } else { serde_json::from_str(percent).map_err(|_| usage_error("The cap is a percent from 1 to 99, or off"))? };
            window_action(options, "accounts.cap", json!({ "account": account, "percent": percent }), |_| if percent.is_null() { format!("Cleared {account}'s cap.") } else { format!("Capped {account} at {percent}%.") })
        }
        ["routing"] => window_action(options, "routing.auto", json!({}), pretty),
        ["routing", provider, state @ ("on" | "off")] => {
            window_action(options, "routing.auto", json!({ "provider": provider, "on": *state == "on" }), pretty)
        }
        ["alerts"] => window_action(options, "alerts.list", json!({}), render::alerts),
        ["alerts", "seen"] => window_action(options, "alerts.seen", json!({}), |_| "Every alert is marked seen.".into()),
        ["sync"] => window_action(options, "sync.status", json!({}), render::sync_status),
        ["sync", "auto"] => {
            let mut client = connect(options)?;
            let found = client.read("get_setup_autoline", Value::Null)?;
            show(options, &found, |found| render::sync_auto(found, render::now_ms()));
            Ok(())
        }
        ["sync", "auto", verb @ ("pause" | "resume"), machine] => {
            let mut client = connect(options)?;
            let machine = machine_name(&mut client, machine)?;
            let found = client.read("set_setup_autoline_paused", json!({ "machine": machine, "paused": *verb == "pause" }))?;
            show(options, &found, |found| render::sync_auto(found, render::now_ms()));
            Ok(())
        }
        ["sync", "repo"] => {
            let mut client = connect(options)?;
            let found = client.read("get_setup_repo_keeper", Value::Null)?;
            show(options, &found, |found| render::sync_repo(found, render::now_ms()));
            Ok(())
        }
        ["sync", "apply", machine] => {
            let machine = machine_name(&mut connect(options)?, machine)?;
            window_action(options, "sync.apply", json!({ "machine": machine }), pretty)
        }
        ["sync", machine] => {
            let machine = machine_name(&mut connect(options)?, machine)?;
            window_action(options, "sync.plan", json!({ "machine": machine }), render::sync_plan)
        }
        ["core"] | ["core", "status"] => {
            let mut client = connect(options)?;
            let status = client.read("get_core_status", Value::Null)?;
            show(options, &status, render::core);
            Ok(())
        }
        ["core", action @ ("start" | "stop" | "restart")] => {
            let mut client = connect(options)?;
            let status = change(&mut client, options, &format!("{action}_core_process"), json!({}))?;
            show(options, &status, render::core);
            Ok(())
        }
        ["core", "install", version @ ..] => {
            let mut client = connect(options)?;
            let args = json!({ "version": version.first() });
            let installed = change(&mut client, options, "core.install", args)?;
            show(options, &installed, |_| "Installed.".into());
            Ok(())
        }
        ["archive"] => {
            let mut client = connect(options)?;
            let status = client.read("get_session_archive_status", Value::Null)?;
            show(options, &status, archive_summary);
            Ok(())
        }
        ["archive", "export", rest @ ..] => archive_export(options, rest),
        ["settings", rest @ ..] => saved_settings(options, rest),
        ["commands", filter @ ..] => {
            let client = connect(options)?;
            let methods = client.hello.clone();
            show(options, &methods, |hello| render::commands(hello, filter.first().copied()));
            Ok(())
        }
        ["call", method, rest @ ..] => {
            let args = args::command_arguments(&rest.iter().map(|word| word.to_string()).collect::<Vec<_>>()).map_err(usage_error)?;
            let mut client = connect(options)?;
            let answer = change(&mut client, options, &args::method_name(method), args)?;
            print_json(&answer);
            Ok(())
        }
        ["watch", events @ ..] => {
            let mut client = connect(options)?;
            let events = events.iter().map(|event| event.to_string()).collect();
            client.watch(events, |event| {
                if options.json {
                    println!("{event}");
                } else {
                    println!("{}  {}", render::field(event, "event"), event.get("payload").unwrap_or(&Value::Null));
                }
                std::io::stdout().flush().is_ok()
            })
        }
        [other, ..] => Err(usage_error(format!("arbor has no command called {other}. Run arbor help to see them."))),
    }
}

/// Carries one SSH connection to the pool member Arbor picks: ssh runs this as a host's ProxyCommand, so stdin and
/// stdout are the connection and anything to say goes to stderr. The socket to Arbor stays open while the connection
/// does, which is how Arbor knows the member is still in use.
fn pool_connect(options: &args::Options, pool: &str, host: &str) -> Result<(), Failure> {
    let mut client = connect(options)?;
    let target = client.read(protocol::POOL_CONNECT, json!({ "pool": pool, "name": host }))?;
    let port = target.get("port").and_then(Value::as_u64).and_then(|port| u16::try_from(port).ok()).unwrap_or(22);
    let result = match render::field(&target, "how").as_str() {
        "direct" => carry(&render::field(&target, "host"), port),
        "via" => {
            // ssh's own config knows the way to a machine behind a jump host; it then opens the machine's own sshd.
            let mut command = Command::new("ssh");
            command
                .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"])
                // The member's own key, checked as Arbor's runs check it: only one already trusted.
                .args(crate::usage::machine_health::host_keys::strict_options())
                .arg("-W")
                .arg(format!("127.0.0.1:{port}"))
                .arg("--")
                .arg(render::field(&target, "endpoint"));
            match command.status() {
                Ok(status) if status.success() => Ok(()),
                Ok(_) => Err(Failure::new(exit::FAILED, format!("Couldn't reach {} through ssh.", render::field(&target, "machine")))),
                Err(error) => Err(Failure::new(exit::FAILED, format!("Couldn't run ssh: {error}"))),
            }
        }
        _ => Err(Failure::new(exit::PROTOCOL, "Arbor answered with a way to connect this arbor doesn't know. Update the arbor command.")),
    };
    drop(client);
    result
}

/// Copies stdin to a TCP connection and the connection to stdout until either side ends.
fn carry(host: &str, port: u16) -> Result<(), Failure> {
    use std::{fs::File, mem::ManuallyDrop, net::{TcpStream, ToSocketAddrs}, os::fd::FromRawFd};
    let unreachable = |error: std::io::Error| Failure::new(exit::FAILED, format!("Couldn't connect to {host}:{port}: {error}"));
    let addresses: Vec<_> = (host, port).to_socket_addrs().map_err(unreachable)?.collect();
    let mut last = std::io::Error::new(std::io::ErrorKind::NotFound, "no address");
    let mut stream = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, Duration::from_secs(10)) {
            Ok(connected) => {
                stream = Some(connected);
                break;
            }
            Err(error) => last = error,
        }
    }
    let stream = stream.ok_or_else(|| unreachable(last))?;
    let _ = stream.set_nodelay(true);
    let mut upstream = stream.try_clone().map_err(unreachable)?;
    // Raw descriptors, not Rust's stdin and stdout: stdout's line buffering would hold back an SSH stream.
    // ManuallyDrop leaves them open for the process, which owns them.
    std::thread::spawn(move || {
        let mut input = ManuallyDrop::new(unsafe { File::from_raw_fd(0) });
        let _ = std::io::copy(&mut *input, &mut upstream);
        let _ = upstream.shutdown(std::net::Shutdown::Write);
    });
    let mut output = ManuallyDrop::new(unsafe { File::from_raw_fd(1) });
    let mut downstream = stream;
    let _ = std::io::copy(&mut downstream, &mut *output);
    Ok(())
}

/// Runs one of the window's actions and prints what it gave.
fn window_action(options: &args::Options, action: &str, args: Value, human: impl FnOnce(&Value) -> String) -> Result<(), Failure> {
    let mut client = connect(options)?;
    let answer = change(&mut client, options, action, args)?;
    show(options, &answer, human);
    Ok(())
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

fn status(options: &args::Options) -> Result<(), Failure> {
    let mut client = connect(options)?;
    let core = client.read("get_core_status", Value::Null)?;
    let machines = client.read("get_machine_health", json!({ "passive": true }))?;
    let live = client.read("get_live_sessions", Value::Null)?;
    // The window adds its own view of limits and alerts when it's loaded; without it the rest still shows.
    let window = if client.hello.get("windowReady") == Some(&Value::Bool(true)) {
        client.read("status.summary", json!({})).ok()
    } else {
        None
    };
    if options.json {
        print_json(&json!({ "core": core, "machines": machines, "live": live, "window": window }));
        return Ok(());
    }
    println!("{}", render::core(&core));
    let all = render::items(&machines, "machines");
    let healthy = all.iter().filter(|machine| render::field(machine, "status") == "healthy").count();
    println!("Machines: {healthy} of {} healthy", all.len());
    for machine in all.iter().filter(|machine| !matches!(render::field(machine, "status").as_str(), "healthy" | "pending")) {
        println!("  {} is {}", render::field(machine, "machine"), render::field(machine, "status"));
    }
    println!(
        "Live sessions: {} running, {} an hour",
        render::count(live.get("running").unwrap_or(&Value::Null)),
        render::dollars(live.get("costPerHour").unwrap_or(&Value::Null)),
    );
    if let Some(window) = &window {
        let unread = window.get("unreadAlerts").and_then(Value::as_u64).unwrap_or(0);
        println!("Unread alerts: {unread}");
        for (label, field) in [("off", "accountsOff"), ("nearly out", "accountsLow")] {
            let names: Vec<String> = render::items(window, field).iter().map(render::text).collect();
            if !names.is_empty() {
                println!("Accounts {label}: {}", names.join(", "));
            }
        }
    }
    Ok(())
}

fn sessions(options: &args::Options, live: bool) -> Result<(), Failure> {
    let mut client = connect(options)?;
    if live {
        let report = client.read("get_live_sessions", Value::Null)?;
        show(options, &report, |report| render::sessions(render::items(report, "sessions")));
    } else {
        let page = client.read("get_usage_sessions", json!({ "query": { "page": 1, "page_size": 20 } }))?;
        show(options, &page, |page| render::sessions(render::items(page, "items")));
    }
    Ok(())
}

/// The start of a range: midnight today, or so many days back.
fn range_start(range: &str) -> Result<chrono::DateTime<chrono::Local>, Failure> {
    use chrono::{Duration as Days, Local, TimeZone};
    let today = Local::now().date_naive().and_hms_opt(0, 0, 0).and_then(|midnight| Local.from_local_datetime(&midnight).earliest());
    let today = today.ok_or_else(|| Failure::new(exit::FAILED, "Couldn't work out today's date"))?;
    match range {
        "today" => Ok(today),
        "7d" => Ok(today - Days::days(6)),
        "30d" => Ok(today - Days::days(29)),
        other => Err(usage_error(format!("usage takes today, 7d or 30d, not {other}"))),
    }
}

fn usage(options: &args::Options, range: &str) -> Result<(), Failure> {
    let start = range_start(range)?;
    let mut client = connect(options)?;
    let overview = client.read("get_usage_overview", json!({ "query": { "start": start.to_rfc3339() } }))?;
    show(options, &overview, |overview| render::usage(overview, range));
    Ok(())
}

fn archive_summary(status: &Value) -> String {
    let totals = status.get("totals").unwrap_or(&Value::Null);
    let gigabytes = totals.get("storedBytes").and_then(Value::as_f64).map_or("–".into(), |bytes| format!("{:.1} GB", bytes / 1e9));
    let mut out = vec![
        format!("Session archive: {}", render::field(status, "state")),
        format!("  Sessions  {}", render::count(totals.get("sessions").unwrap_or(&Value::Null))),
        format!("  Stored    {gigabytes}"),
        format!("  Last pass {}", render::ago(status.get("lastPassAt").unwrap_or(&Value::Null), render::now_ms())),
    ];
    if let Some(error) = status.get("lastError").and_then(Value::as_str) {
        out.push(format!("  Problem   {error}"));
    }
    out.join("\n")
}

/// `arbor archive export`: the kept sessions it picks, put back together in a new or empty folder by the app.
fn archive_export(options: &args::Options, rest: &[&str]) -> Result<(), Failure> {
    let export = args::archive_export(rest).map_err(usage_error)?;
    let since = export.since.as_deref().map(|since| args::since_ms(since, chrono::Local::now())).transpose().map_err(usage_error)?;
    let cwd = std::env::current_dir().map_err(|error| Failure::new(exit::FAILED, format!("Couldn't tell which folder arbor runs in: {error}")))?;
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let out = args::full_path(&export.out, home.as_deref(), &cwd);
    let mut client = connect(options)?;
    let machine = match &export.machine {
        Some(typed) => Some(machine_name(&mut client, typed)?),
        None => None,
    };
    let request = json!({
        "out": out.to_string_lossy(),
        "project": export.project,
        "machine": machine,
        "since": since,
        "allVersions": export.all_versions,
    });
    let report = change(&mut client, options, "export_session_archive", json!({ "request": request }))?;
    show(options, &report, render::archive_export);
    Ok(())
}

/// `arbor settings`: lists, reads and changes the window's saved settings through the app, which tells the window.
fn saved_settings(options: &args::Options, words: &[&str]) -> Result<(), Failure> {
    let mut client = connect(options)?;
    let snapshot = client.read("saved_store_snapshot", Value::Null)?;
    let values = snapshot.get("values").and_then(Value::as_object).cloned().unwrap_or_default();
    let readable = |raw: &Value| raw.as_str().and_then(|text| serde_json::from_str::<Value>(text).ok()).unwrap_or_else(|| raw.clone());
    match words {
        [] => {
            if options.json {
                let all: serde_json::Map<String, Value> = values.iter().map(|(name, raw)| (name.clone(), readable(raw))).collect();
                print_json(&Value::Object(all));
            } else {
                let rows: Vec<Vec<String>> = values
                    .iter()
                    .map(|(name, raw)| vec![name.clone(), format!("{} bytes", raw.as_str().map_or(0, str::len))])
                    .collect();
                println!("{}", render::table(&["SETTING", "SIZE"], &rows));
            }
            Ok(())
        }
        ["get", name] => {
            let raw = values.get(*name).ok_or_else(|| Failure::new(exit::FAILED, format!("Nothing is saved as {name}.")))?;
            print_json(&readable(raw));
            Ok(())
        }
        ["set", name, value] => {
            change(&mut client, options, "saved_store_set", json!({ "name": name, "value": value }))?;
            eprintln!("Saved {name}.");
            Ok(())
        }
        ["unset", name] => {
            change(&mut client, options, "saved_store_set", json!({ "name": name, "value": null }))?;
            eprintln!("Removed {name}.");
            Ok(())
        }
        _ => Err(usage_error("arbor settings [get <name> | set <name> <value> | unset <name>]")),
    }
}

fn install(options: &args::Options) -> Result<(), Failure> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from).ok_or_else(|| Failure::new(exit::FAILED, "Can't find your home folder"))?;
    let installed = settings::install_link(&home, settings::linkable_executable().as_deref()).map_err(|error| Failure::new(exit::FAILED, error))?;
    if options.json {
        print_json(&serde_json::to_value(&installed).unwrap_or_default());
    } else {
        println!("arbor is linked at {}.", installed.link_path);
        println!("If your shell doesn't find it, add ~/.local/bin to your PATH.");
    }
    Ok(())
}

fn doctor(options: &args::Options) -> Result<(), Failure> {
    let mut checks: Vec<(String, bool)> = Vec::new();
    let path = super::socket_path().map_err(|error| Failure::new(exit::FAILED, error))?;
    checks.push((format!("Socket at {}", path.display()), path.exists()));
    let client = Client::connect("cli", false, Duration::from_secs(options.timeout));
    let reached = client.as_ref().map(|client| client.hello.clone());
    checks.push(("Arbor answers".into(), reached.is_ok()));
    if let Ok(hello) = &reached {
        checks.push((format!("Arbor {} with protocol {}", render::field(hello, "app"), render::field(hello, "protocol")), true));
        checks.push(("Arbor's window is loaded (accounts, alerts, Sync)".into(), hello.get("windowReady") == Some(&Value::Bool(true))));
    }
    if options.json {
        let rows: Vec<Value> = checks.iter().map(|(name, ok)| json!({ "check": name, "ok": ok })).collect();
        print_json(&Value::Array(rows));
    } else {
        for (name, ok) in &checks {
            println!("{} {name}", if *ok { "✓" } else { "✗" });
        }
        if let Err(failure) = &reached {
            println!("  {}", failure.message);
        }
    }
    if checks.iter().all(|(_, ok)| *ok) {
        Ok(())
    } else {
        Err(Failure::new(exit::UNAVAILABLE, ""))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pool_is_found_by_id_or_name_and_a_repo_by_owner_and_name_on_its_members() {
        let pools = json!([
            { "id": "p1", "name": "Builds", "members": [{ "machine": "cam-mbp" }, { "machine": "cedar-02" }] },
            { "id": "p2", "name": "Overflow", "members": [{ "machine": "ci-01" }] },
        ]);
        assert_eq!(matching_pool(&pools, "p2").unwrap().1, "Overflow");
        let (id, _, members) = matching_pool(&pools, "builds").unwrap();
        assert_eq!((id.as_str(), members.clone()), ("p1", vec!["cam-mbp".to_string(), "cedar-02".to_string()]));
        assert!(matching_pool(&pools, "nowhere").is_err());

        let projects = json!([
            { "machine": "cam-mbp", "repos": [{ "remote": "github.com/acme/storefront.git" }, { "remote": "github.com/acme/docs" }] },
            { "machine": "cedar-02", "repos": [{ "remote": "github.com/Acme/storefront" }, { "remote": "gitlab.com/other/docs" }] },
            // Not a member, so its repos don't count.
            { "machine": "ci-01", "repos": [{ "remote": "github.com/acme/billing" }] },
        ]);
        let found = |typed: &str| matching_repo(&projects, &members, "Builds", typed);
        assert_eq!(found("acme/storefront").unwrap(), "github.com/acme/storefront");
        assert_eq!(found("github.com/acme/billing").unwrap(), "github.com/acme/billing");
        assert!(found("acme/billing").unwrap_err().message.contains("github.com/acme/billing"));
        // Two hosts with the same owner and name: say which, and ask for one in full.
        assert!(matching_repo(&projects, &members, "Builds", "docs").is_err());
        let both = json!([{ "machine": "cam-mbp", "repos": [{ "remote": "github.com/acme/docs" }, { "remote": "gitlab.com/acme/docs" }] }]);
        assert!(matching_repo(&both, &members, "Builds", "acme/docs").unwrap_err().message.contains(" or "));
    }

    #[test]
    fn a_range_starts_at_midnight_some_days_back() {
        let today = range_start("today").unwrap();
        assert_eq!(today.format("%H:%M").to_string(), "00:00");
        assert_eq!((today - range_start("7d").unwrap()).num_days(), 6);
        assert_eq!(range_start("forever").unwrap_err().code, exit::USAGE);
    }

    #[test]
    fn a_machine_is_found_by_its_name_or_its_host_however_it_is_typed() {
        let hosts = json!([
            { "machine": "Cam dev 01", "endpoint": "cam-dev-01" },
            { "machine": "studio", "endpoint": "cam-studio.local" },
        ]);
        assert_eq!(matching_machine(&hosts, "Cam dev 01").as_deref(), Some("Cam dev 01"));
        assert_eq!(matching_machine(&hosts, "cam-dev-01").as_deref(), Some("Cam dev 01"));
        assert_eq!(matching_machine(&hosts, "STUDIO").as_deref(), Some("studio"));
        assert_eq!(matching_machine(&hosts, "cam-studio.local").as_deref(), Some("studio"));
        assert_eq!(matching_machine(&hosts, "nowhere"), None);
    }

    #[test]
    fn an_unknown_command_is_a_usage_error() {
        let options = args::parse(&["frobnicate".into()]).unwrap();
        assert_eq!(run_command(&options).unwrap_err().code, exit::USAGE);
    }
}

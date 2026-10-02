//! Where each machine's agents keep their homes: the one list every script that looks for an agent
//! home reads. Claude Code's, Codex's and Pi's standard homes are always on it. The first time Arbor
//! looks at a machine it scans for folders shaped like an agent's home and adds the ones it finds;
//! later scans only suggest. The user adds, removes and switches homes in Settings › Agent homes.
//!
//! A home has two switches. Sessions: its transcripts are read for the Sessions pages and kept by
//! the archive. Sync: its settings are read and changed, for the Sync page, the needs-you reporter,
//! telemetry and how long sessions are kept. A folder a `*` matched has to look like the agent's
//! home as well, so a pattern never picks up a folder that only happens to sit beside one.

use super::shell::shell_quote;
use super::*;
use std::collections::BTreeSet;
use std::sync::RwLock;

/// What a home belongs to, by the name the archive files its sessions under.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AgentHomeKind {
    Claude,
    Codex,
    /// Pi's sessions folder, one folder in it for each place Pi ran.
    Pi,
    /// A folder of Claude's desktop app's local sessions, each with an audit log.
    ClaudeDesktop,
    /// Pi's own folder, with its instructions and skills; its sessions are listed as `Pi`.
    PiAgent,
    PrimeAgent,
    #[serde(rename = "opencode")]
    OpenCode,
    Droid,
    Amp,
}

impl AgentHomeKind {
    pub(crate) fn shell_name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Pi => "pi",
            Self::ClaudeDesktop => "claude-desktop",
            Self::PiAgent => "pi-agent",
            Self::PrimeAgent => "prime-agent",
            Self::OpenCode => "opencode",
            Self::Droid => "droid",
            Self::Amp => "amp",
        }
    }

    const ALL: [Self; 9] =
        [Self::Claude, Self::Codex, Self::Pi, Self::ClaudeDesktop, Self::PiAgent, Self::PrimeAgent, Self::OpenCode, Self::Droid, Self::Amp];

    pub(crate) fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.shell_name() == value)
    }

    /// Only Claude Code's and Codex's homes have settings Sync reads and changes, and the scripts that look in a home
    /// for its settings take only theirs.
    pub(crate) fn has_settings(self) -> bool {
        matches!(self, Self::Claude | Self::Codex)
    }

    /// Arbor reads the sessions in it. The other harnesses' own folders hold no sessions it can read yet.
    pub(crate) fn reads_sessions(self) -> bool {
        matches!(self, Self::Claude | Self::Codex | Self::Pi | Self::ClaudeDesktop)
    }

    /// Sync reads it: Claude Code's and Codex's settings, and the other harnesses' instructions and skills.
    pub(crate) fn syncs(self) -> bool {
        !matches!(self, Self::Pi | Self::ClaudeDesktop)
    }
}

/// Where a home on the list came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentHomeSource {
    /// One of the agents' own homes, on every machine. It can be switched off but not removed.
    Standard,
    /// Added by the first scan of its machine.
    Found,
    /// Added in Settings, from a scan's suggestion or by hand.
    Added,
}

impl AgentHomeSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Found => "found",
            Self::Added => "added",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "standard" => Self::Standard,
            "found" => Self::Found,
            _ => Self::Added,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentHome {
    /// The machine it's on, by name, or empty for every machine.
    pub(crate) machine: String,
    pub(crate) agent: AgentHomeKind,
    /// From `~/` or `/`, where a `*` in a folder's name stands for any characters in it; for a standard home, an
    /// environment variable the agent reads its home from, like `$CLAUDE_CONFIG_DIR`.
    pub(crate) path: String,
    pub(crate) source: AgentHomeSource,
    /// Its sessions are read for the Sessions pages and kept by the archive.
    pub(crate) sessions: bool,
    /// Its settings are read and changed: the Sync page, the needs-you reporter, telemetry, how long sessions are kept.
    pub(crate) sync: bool,
}

/// The agents' own homes, on every machine that has them: where each harness's environment variable points, then its
/// default folder, for each harness whose sessions Arbor reads (see `harnesses`).
fn standard_paths() -> impl Iterator<Item = (AgentHomeKind, &'static str)> {
    super::harnesses::CATALOG.iter().flat_map(|spec| {
        let sessions = spec.sessions.map(|home| (home.kind, home.env, home.default));
        // A harness whose sessions sit in a folder of their own, like Pi's, has its home listed beside them.
        let own = spec.home_kind.filter(|kind| sessions.is_none_or(|(listed, _, _)| listed != *kind)).map(|kind| (kind, spec.home_env, spec.home));
        sessions.into_iter().chain(own).flat_map(|(kind, env, default)| env.map(|env| (kind, env)).into_iter().chain([(kind, default)]))
    })
}

/// Whether a home the scan finds starts with Sync on. Off, since a found home is often a tool's copy of a standard
/// one, or a folder of short-lived sessions, whose settings nobody keeps in line.
const FOUND_SYNC: bool = false;

fn standard() -> Vec<AgentHome> {
    standard_paths()
        .map(|(agent, path)| AgentHome {
            machine: String::new(),
            agent,
            path: path.to_string(),
            source: AgentHomeSource::Standard,
            sessions: agent.reads_sessions(),
            sync: agent.syncs(),
        })
        .collect()
}

/// The homes on `machine`, as its scripts read them: the standard ones, then those saved for every machine, then
/// those saved for it. A saved home takes the place of the same home from before it, so a standard home switched
/// off on one machine stays on everywhere else.
pub(crate) fn homes_on(saved: &[AgentHome], machine: &str) -> Vec<AgentHome> {
    let mut homes = standard();
    let scopes: &[&str] = if machine.is_empty() { &[""] } else { &["", machine] };
    for scope in scopes {
        for home in saved.iter().filter(|home| home.machine == *scope) {
            match homes.iter_mut().find(|listed| listed.agent == home.agent && listed.path == home.path) {
                Some(listed) => {
                    listed.machine = home.machine.clone();
                    listed.sessions = home.sessions && home.agent.reads_sessions();
                    listed.sync = home.sync && home.agent.syncs();
                }
                None => homes.push(AgentHome {
                    sessions: home.sessions && home.agent.reads_sessions(),
                    sync: home.sync && home.agent.syncs(),
                    ..home.clone()
                }),
            }
        }
    }
    homes
}

// ---------------------------------------------------------------------------
// The shell side
// ---------------------------------------------------------------------------

/// What a script looks in the homes for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HomeUse {
    /// Claude Code's and Codex's homes with Sessions on, for their transcripts.
    Sessions,
    /// Every home with Sessions on, whatever it belongs to, for the archive.
    Archive,
    /// Claude Code's and Codex's homes with Sync on, for their settings.
    Sync,
    /// Every home with Sync on, for the setup scan: Claude Code's and Codex's settings and the other harnesses'
    /// instructions and skills.
    Files,
}

/// Every script that reads agent homes starts with these: `tab`, `settings_file agent home`, and `home_line agent
/// folder matched`, which prints "agent<TAB>folder" for a folder that's there. One a `*` matched (`matched` is 1)
/// also has to look like the agent's home.
const HOME_HELPERS: &str = r##"tab=$(printf '\t')
settings_file() {
  case "$1" in claude) printf '%s/settings.json' "$2" ;; *) printf '%s/config.toml' "$2" ;; esac
}
home_line() {
  hl_agent=$1
  hl_dir=${2%/}
  { [ -n "$hl_dir" ] && [ -d "$hl_dir" ]; } || return 0
  if [ "$3" = 1 ]; then
    case $hl_agent in
      claude) { [ -d "$hl_dir/projects" ] || [ -f "$hl_dir/.claude.json" ]; } || return 0 ;;
      codex) { [ -f "$hl_dir/config.toml" ] || [ -d "$hl_dir/sessions" ]; } || return 0 ;;
      claude-desktop) set -- "$hl_dir"/local_*/audit.jsonl; [ -f "$1" ] || return 0 ;;
      pi-agent|prime-agent|droid|amp) { [ -f "$hl_dir/settings.json" ] || [ -f "$hl_dir/AGENTS.md" ] || [ -d "$hl_dir/skills" ]; } || return 0 ;;
      opencode) { [ -f "$hl_dir/opencode.json" ] || [ -f "$hl_dir/AGENTS.md" ] || [ -d "$hl_dir/skills" ]; } || return 0 ;;
    esac
  fi
  printf '%s\t%s\n' "$hl_agent" "$hl_dir"
}
"##;

/// The helpers alone, for a script that reads no homes but shares their words.
pub(crate) fn helpers() -> &'static str {
    HOME_HELPERS
}

/// Defines `agent_homes`, which prints "agent<TAB>folder" for each home on `machine` that `use_` takes, once each,
/// along with the helpers every home script uses.
pub(crate) fn shell_function(machine: &str, use_: HomeUse) -> String {
    shell_function_for(&saved(), machine, use_)
}

/// `shell_function` for a given list rather than the saved one.
pub(crate) fn shell_function_for(saved: &[AgentHome], machine: &str, use_: HomeUse) -> String {
    let mut script = String::from(HOME_HELPERS);
    script.push_str("agent_homes() {\n  {\n");
    for home in homes_on(saved, machine) {
        let taken = match use_ {
            HomeUse::Sessions => home.sessions && home.agent.has_settings(),
            HomeUse::Archive => home.sessions,
            HomeUse::Sync => home.sync && home.agent.has_settings(),
            HomeUse::Files => home.sync,
        };
        let Some(words) = taken.then(|| shell_words(&home.path)).flatten() else {
            continue;
        };
        let matched = u8::from(home.path.contains('*'));
        script.push_str(&format!("    for dir in {words}; do home_line {} \"$dir\" {matched}; done\n", home.agent.shell_name()));
    }
    script.push_str("    :\n  } | awk '!seen[$0]++'\n}\n");
    script
}

/// A home's path as shell words: each folder's name quoted, and each `*` left for the shell to expand. None for a
/// path that can't be one.
fn shell_words(path: &str) -> Option<String> {
    if let Some(name) = path.strip_prefix('$') {
        return standard_paths().any(|(_, standard)| standard == path).then(|| format!("\"${{{name}:-}}\""));
    }
    let (mut words, rest) = match path.strip_prefix("~/") {
        Some(rest) => (String::from("\"$HOME\""), rest),
        None => (String::new(), path.strip_prefix('/')?),
    };
    let mut any = false;
    for part in rest.split('/').filter(|part| !part.is_empty()) {
        words.push('/');
        let pieces: Vec<String> = part.split('*').map(|piece| if piece.is_empty() { String::new() } else { shell_quote(piece) }).collect();
        words.push_str(&pieces.join("*"));
        any = true;
    }
    any.then_some(words)
}

/// `path` written from `~` when it's in `home`.
pub(crate) fn tilde(path: &str, home: &str) -> String {
    let home = home.trim_end_matches('/');
    match path.strip_prefix(home) {
        Some(rest) if !home.is_empty() && (rest.is_empty() || rest.starts_with('/')) => format!("~{rest}"),
        _ => path.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Checking what's saved
// ---------------------------------------------------------------------------

/// A home as it's saved, or why it can't be.
fn checked(home: AgentHome) -> Result<AgentHome, String> {
    let machine = home.machine.trim().to_string();
    if machine.len() > 100 || machine.chars().any(char::is_control) {
        return Err("Machine names are at most 100 characters".into());
    }
    let path = home.path.trim().trim_end_matches('/').to_string();
    let standard = standard_paths().any(|(agent, listed)| agent == home.agent && listed == path);
    if !standard {
        if !(path.starts_with("~/") || path.starts_with('/')) || path.contains('$') {
            return Err("A home's folder starts with ~/ or /".into());
        }
        let parts: Vec<&str> = path.split('/').skip(1).collect();
        if parts.is_empty() || parts.iter().any(|part| part.is_empty() || *part == "." || *part == "..") {
            return Err("Choose a folder, without . or .. in it".into());
        }
        if path.chars().any(char::is_control) || path.len() > 1024 {
            return Err("A home's folder can't hold a line break or a tab".into());
        }
    }
    let source = match home.source {
        AgentHomeSource::Standard if !standard => AgentHomeSource::Added,
        _ if standard => AgentHomeSource::Standard,
        source => source,
    };
    Ok(AgentHome { machine, path, source, sessions: home.sessions && home.agent.reads_sessions(), sync: home.sync && home.agent.syncs(), ..home })
}

// ---------------------------------------------------------------------------
// Storage, and the list scripts read
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Saved {
    loaded: bool,
    // Tests build scripts from their own list instead.
    #[cfg_attr(test, allow(dead_code))]
    homes: Vec<AgentHome>,
    /// Machines a look for homes has worked on, and so added what it found.
    scanned: BTreeSet<String>,
    /// Machines looked at, whether it worked or not.
    looked: BTreeSet<String>,
}

/// The saved list, read once and kept in step with every save, so a script can be built without opening usage.db.
static SAVED: RwLock<Saved> = RwLock::new(Saved { loaded: false, homes: Vec::new(), scanned: BTreeSet::new(), looked: BTreeSet::new() });

/// Whether Arbor has looked for homes on `machine` yet. The archive waits for that, so a first pass never lists a
/// machine with only the standard homes and takes the rest for gone.
pub(crate) fn looked_at(machine: &str) -> bool {
    SAVED.read().is_ok_and(|saved| saved.looked.contains(machine))
}

#[cfg(test)]
thread_local! {
    /// What a test has the list hold, on its own thread, since tests never read usage.db.
    static TEST_SAVED: std::cell::RefCell<Vec<AgentHome>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// The saved homes.
fn saved() -> Vec<AgentHome> {
    #[cfg(test)]
    {
        TEST_SAVED.with(|saved| saved.borrow().clone())
    }
    #[cfg(not(test))]
    {
        let loaded = SAVED.read().map(|saved| saved.loaded).unwrap_or(true);
        if !loaded {
            if let Err(error) = open_usage_database().and_then(|connection| reload(&connection)) {
                eprintln!("Failed to read the agent homes: {error}");
            }
        }
        SAVED.read().map(|saved| saved.homes.clone()).unwrap_or_default()
    }
}

/// Reads the saved list into what scripts are built from.
pub(super) fn reload(connection: &Connection) -> Result<(), String> {
    let homes = read_homes(connection)?;
    let scans = read_scans(connection)?;
    let scanned = scans.iter().filter(|scan| scan.filled).map(|scan| scan.machine.clone()).collect();
    let looked = scans.into_iter().map(|scan| scan.machine).collect();
    if let Ok(mut saved) = SAVED.write() {
        *saved = Saved { loaded: true, homes, scanned, looked };
    }
    Ok(())
}

fn read_homes(connection: &Connection) -> Result<Vec<AgentHome>, String> {
    let mut statement = connection
        .prepare("SELECT machine, agent, path, source, sessions, sync FROM usage_agent_homes ORDER BY machine, agent, path")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?))
        })
        .map_err(|error| error.to_string())?;
    let mut homes = Vec::new();
    for row in rows {
        let (machine, agent, path, source, sessions, sync) = row.map_err(|error| error.to_string())?;
        // A kind a newer Arbor saved is left for it.
        let Some(agent) = AgentHomeKind::parse(&agent) else {
            continue;
        };
        homes.push(AgentHome { machine, agent, path, source: AgentHomeSource::parse(&source), sessions: sessions != 0, sync: sync != 0 });
    }
    Ok(homes)
}

fn write_home(connection: &Connection, home: &AgentHome) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO usage_agent_homes(machine, agent, path, source, sessions, sync) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(machine, agent, path) DO UPDATE SET source = excluded.source, sessions = excluded.sessions, sync = excluded.sync",
            params![home.machine, home.agent.shell_name(), home.path, home.source.as_str(), home.sessions as i64, home.sync as i64],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// A machine's last look for homes: when it ran, the folders the last one that worked found that look like an agent's
/// home, and why the last one failed, if it did.
#[derive(Clone, Debug, PartialEq, Eq)]
struct StoredScan {
    machine: String,
    scanned_at_ms: i64,
    found: Vec<(AgentHomeKind, String)>,
    error: String,
    /// A look has worked, and added what it found to the list.
    filled: bool,
}

fn read_scans(connection: &Connection) -> Result<Vec<StoredScan>, String> {
    let mut statement = connection
        .prepare("SELECT machine, scanned_at_ms, found, error, filled FROM usage_agent_home_scans ORDER BY machine")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?))
        })
        .map_err(|error| error.to_string())?;
    let mut scans = Vec::new();
    for row in rows {
        let (machine, scanned_at_ms, found, error, filled) = row.map_err(|error| error.to_string())?;
        let found: Vec<(String, String)> = serde_json::from_str(&found).unwrap_or_default();
        let found = found.into_iter().filter_map(|(agent, path)| Some((AgentHomeKind::parse(&agent)?, path))).collect();
        scans.push(StoredScan { machine, scanned_at_ms, found, error, filled: filled != 0 });
    }
    Ok(scans)
}

/// Files a look. One that failed keeps what the last one that worked found.
fn write_scan(connection: &Connection, scan: &StoredScan) -> Result<(), String> {
    if !scan.error.is_empty() {
        return connection
            .execute(
                "INSERT INTO usage_agent_home_scans(machine, scanned_at_ms, error) VALUES (?1, ?2, ?3)
                 ON CONFLICT(machine) DO UPDATE SET scanned_at_ms = excluded.scanned_at_ms, error = excluded.error",
                params![scan.machine, scan.scanned_at_ms, scan.error],
            )
            .map(|_| ())
            .map_err(|error| error.to_string());
    }
    let found: Vec<(&str, &str)> = scan.found.iter().map(|(agent, path)| (agent.shell_name(), path.as_str())).collect();
    connection
        .execute(
            "INSERT INTO usage_agent_home_scans(machine, scanned_at_ms, found, error, filled) VALUES (?1, ?2, ?3, '', 1)
             ON CONFLICT(machine) DO UPDATE SET scanned_at_ms = excluded.scanned_at_ms, found = excluded.found, error = '', filled = 1",
            params![scan.machine, scan.scanned_at_ms, serde_json::to_string(&found).map_err(|error| error.to_string())?],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Files a scan. The first one of a machine also adds the homes it found that the list doesn't cover; later ones
/// are only offered. Returns the homes it added.
fn store_scan(connection: &mut Connection, scan: &StoredScan) -> Result<Vec<AgentHome>, String> {
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let first: bool = transaction
        .query_row("SELECT NOT EXISTS (SELECT 1 FROM usage_agent_home_scans WHERE machine = ?1 AND filled != 0)", params![scan.machine], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    write_scan(&transaction, scan)?;
    let mut added = Vec::new();
    if first && scan.error.is_empty() {
        let homes = read_homes(&transaction)?;
        for found in suggestions(&homes_on(&homes, &scan.machine), &scan.found) {
            let home = AgentHome {
                machine: scan.machine.clone(),
                agent: found.agent,
                path: found.path,
                source: AgentHomeSource::Found,
                sessions: found.agent.reads_sessions(),
                sync: FOUND_SYNC && found.agent.syncs(),
            };
            write_home(&transaction, &home)?;
            added.push(home);
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(added)
}

// ---------------------------------------------------------------------------
// Scanning a machine for homes
// ---------------------------------------------------------------------------

const SCAN_TIMEOUT: Duration = Duration::from_secs(60);

/// Looks for folders shaped like an agent's home, where they tend to be: in the home folder's own dot-folders, in
/// the apps' folders under Library, and a little way into the rest. Caches, packages, checkouts and other apps'
/// data are skipped. Lines out:
///   H home                 the machine's home folder
///   V agent folder         where the agent's environment variable points in the shell the script runs in
///   F agent folder         a folder that looks like the agent's home: Claude Code's has a `projects` folder of
///                          encoded folder names or a `.claude.json`, Codex's keeps its sessions by year, Pi's
///                          sessions folder has a folder for each place Pi ran, and Claude's desktop app keeps each
///                          local session's audit log in a folder of its own
const SCAN_SCRIPT: &str = r##"set -u
export LC_ALL=C
renice -n 10 $$ >/dev/null 2>&1
command -v ionice >/dev/null 2>&1 && ionice -c 3 -p $$ >/dev/null 2>&1
tab=$(printf '\t')
work=$(mktemp -d "${TMPDIR:-/tmp}/arbor-homes.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT
printf 'H\t%s\n' "$HOME"
printf 'V\tclaude\t%s\nV\tcodex\t%s\nV\tpi\t%s\n' "${CLAUDE_CONFIG_DIR:-}" "${CODEX_HOME:-}" "${PI_CODING_AGENT_SESSION_DIR:-}"
# A login shell can point the agents somewhere the script's own shell doesn't. It gets five seconds.
"${SHELL:-/bin/sh}" -lc 'printf "E\tclaude\t%s\nE\tcodex\t%s\nE\tpi\t%s\n" "${CLAUDE_CONFIG_DIR:-}" "${CODEX_HOME:-}" "${PI_CODING_AGENT_SESSION_DIR:-}"' </dev/null >"$work/login" 2>/dev/null &
login=$!
( sleep 5; kill "$login" 2>/dev/null ) >/dev/null 2>&1 &
watch=$!
wait "$login" 2>/dev/null
kill "$watch" 2>/dev/null
grep "^E$tab" "$work/login" 2>/dev/null | while IFS=$tab read -r tag agent dir; do
  dir=${dir%/}
  if [ -n "$dir" ] && [ -d "$dir" ]; then printf 'F\t%s\t%s\n' "$agent" "$dir"; fi
done
look() {
  depth=$1
  shift
  find "$@" -maxdepth "$depth" \( -type d \( -name node_modules -o -name .git -o -name .hg -o -name .svn -o -name .cache \
    -o -name Caches -o -name Cache -o -name CachedData -o -name .npm -o -name .bun -o -name .cargo -o -name .rustup -o -name .gradle \
    -o -name .m2 -o -name .pnpm-store -o -name .venv -o -name venv -o -name __pycache__ -o -name .Trash -o -name DerivedData \
    -o -name Containers -o -name 'Group Containers' -o -name Mail -o -name Logs -o -name worktrees -o -name '*.photoslibrary' \
    -o -name '*.app' -o -name target -o -name dist \) -prune \) \
    -o \( -type d \( -name projects -o -name sessions \) -print \) \
    -o \( -type f \( -name .claude.json -o -name audit.jsonl \) -print \) 2>/dev/null
}
{
  look 5 "$HOME"/.[!.]* "$HOME"/..?*
  look 7 "$HOME/Library/Application Support"
  set --
  for d in "$HOME"/[!.]*; do if [ "$d" != "$HOME/Library" ]; then set -- "$@" "$d"; fi; done
  if [ $# -gt 0 ]; then look 3 "$@"; fi
} | while IFS= read -r p; do
  case $p in
    *"$tab"*) ;;
    */projects)
      set -- "$p"/-*
      if [ -d "$1" ]; then printf 'F\tclaude\t%s\n' "${p%/projects}"; fi ;;
    */.claude.json)
      h=${p%/.claude.json}
      if [ "$h" != "$HOME" ]; then printf 'F\tclaude\t%s\n' "$h"; fi ;;
    */sessions)
      set -- "$p"/[0-9][0-9][0-9][0-9]
      if [ -d "$1" ]; then printf 'F\tcodex\t%s\n' "${p%/sessions}"; continue; fi
      set -- "$p"/--*--
      if [ -d "$1" ]; then printf 'F\tpi\t%s\n' "$p"; fi ;;
    */local_*/audit.jsonl) printf 'F\tclaude-desktop\t%s\n' "${p%/local_*/audit.jsonl}" ;;
  esac
done | awk '!seen[$0]++'
"##;

#[derive(Debug, Default, PartialEq)]
struct ScanRead {
    home: String,
    found: Vec<(AgentHomeKind, String)>,
}

/// The folders a scan found, written from `~`, leaving out any an agent's environment variable points at, which its
/// standard home already covers.
fn parse_scan(stdout: &str) -> ScanRead {
    let mut read = ScanRead::default();
    let mut env = Vec::new();
    let mut found = Vec::new();
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields[..] {
            ["H", home] => read.home = home.trim_end_matches('/').to_string(),
            ["V", agent, dir] if !dir.is_empty() => env.extend(AgentHomeKind::parse(agent).map(|agent| (agent, dir.trim_end_matches('/').to_string()))),
            ["F", agent, dir] if dir.starts_with('/') => found.extend(AgentHomeKind::parse(agent).map(|agent| (agent, dir.to_string()))),
            _ => {}
        }
    }
    let mut seen = HashSet::new();
    read.found = found
        .into_iter()
        .filter(|entry| !env.contains(entry))
        .map(|(agent, dir)| (agent, tilde(&dir, &read.home)))
        .filter(|entry| seen.insert(entry.clone()))
        .collect();
    read.found.sort();
    read
}

/// A folder the last scan found that the list doesn't cover, or siblings of one kind folded into a `*`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FoundHome {
    pub(crate) agent: AgentHomeKind,
    pub(crate) path: String,
    /// How many folders it stands for.
    pub(crate) folders: u32,
}

/// Whether `pattern`, a home's path, takes in `path`, a folder or another pattern: the same number of folders, each
/// matched the way the shell matches it, where a `*` never matches a name that starts with a dot.
fn covers(pattern: &str, path: &str) -> bool {
    let pattern: Vec<&str> = pattern.split('/').collect();
    let path: Vec<&str> = path.split('/').collect();
    pattern.len() == path.len() && pattern.iter().zip(&path).all(|(want, part)| glob_matches(want, part))
}

fn glob_matches(pattern: &str, name: &str) -> bool {
    if name.starts_with('.') && !pattern.starts_with('.') {
        return false;
    }
    let pieces: Vec<&str> = pattern.split('*').collect();
    let [first, middle @ .., last] = &pieces[..] else {
        return pattern == name;
    };
    let Some(mut rest) = name.strip_prefix(first) else {
        return false;
    };
    for piece in middle {
        match rest.find(piece) {
            Some(at) => rest = &rest[at + piece.len()..],
            None => return false,
        }
    }
    rest.len() >= last.len() && rest.ends_with(last)
}

/// The found folders no home in `homes` covers, with siblings of one kind folded into one `*`: two that differ in
/// one folder's name become one pattern, as long as that folder isn't right in the home or the root, and neither
/// name starts with a dot, which a `*` wouldn't match.
fn suggestions(homes: &[AgentHome], found: &[(AgentHomeKind, String)]) -> Vec<FoundHome> {
    let uncovered = found.iter().filter(|(agent, path)| !homes.iter().any(|home| home.agent == *agent && covers(&home.path, path)));
    let mut by_agent: BTreeMap<AgentHomeKind, Vec<(String, u32)>> = BTreeMap::new();
    for (agent, path) in uncovered {
        by_agent.entry(*agent).or_default().push((path.clone(), 1));
    }
    let mut folded = Vec::new();
    for (agent, mut paths) in by_agent {
        while let Some(pattern) = first_fold(&paths) {
            let folders = paths.iter().filter(|(path, _)| covers(&pattern, path)).map(|(_, count)| count).sum();
            paths.retain(|(path, _)| !covers(&pattern, path));
            paths.push((pattern, folders));
        }
        paths.sort();
        folded.extend(paths.into_iter().map(|(path, folders)| FoundHome { agent, path, folders }));
    }
    folded
}

/// The pattern the first two paths that fold together fold into: a `*` where they differ in one folder's name. A
/// folder one of them already has as a pattern that takes the other's name isn't a difference.
fn first_fold(paths: &[(String, u32)]) -> Option<String> {
    for (at_left, (left, _)) in paths.iter().enumerate() {
        let left_parts: Vec<&str> = left.split('/').collect();
        for (right, _) in paths.iter().skip(at_left + 1) {
            let right_parts: Vec<&str> = right.split('/').collect();
            if left_parts.len() != right_parts.len() {
                continue;
            }
            let mut pattern = Vec::with_capacity(left_parts.len());
            let mut differ = Vec::new();
            for (at, (one, other)) in left_parts.iter().zip(&right_parts).enumerate() {
                if glob_matches(one, other) {
                    pattern.push(*one);
                } else if glob_matches(other, one) {
                    pattern.push(*other);
                } else {
                    differ.push(at);
                    pattern.push("*");
                }
            }
            let [at] = differ[..] else {
                continue;
            };
            if at <= 1 || left_parts[at].starts_with('.') || right_parts[at].starts_with('.') {
                continue;
            }
            return Some(pattern.join("/"));
        }
    }
    None
}

async fn scan(machine: &Machine) -> StoredScan {
    let scanned_at_ms = Local::now().timestamp_millis();
    match run_checked(machine, MachineOp::AgentHomesScan, SCAN_SCRIPT, SCAN_TIMEOUT).await {
        Ok(stdout) => StoredScan { machine: machine.name().to_string(), scanned_at_ms, found: parse_scan(&stdout).found, error: String::new(), filled: true },
        Err(error) => StoredScan { machine: machine.name().to_string(), scanned_at_ms, found: Vec::new(), error, filled: false },
    }
}

/// Machines being scanned now, so a second look waits for the first.
static SCANNING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// When each machine was last looked at in the background, so one that failed waits before it's tried again.
static TRIED: Mutex<BTreeMap<String, i64>> = Mutex::new(BTreeMap::new());
const RETRY_MS: i64 = 30 * 60 * 1000;

/// Looks for homes on each answering machine a look hasn't worked on yet, and adds what it finds. One that fails is
/// tried again half an hour later.
pub(super) fn scan_due(app: &tauri::AppHandle, state: &MachineHealthState, now_ms: i64) {
    let scanned = match SAVED.read() {
        Ok(saved) if saved.loaded => saved.scanned.clone(),
        _ => return,
    };
    let machines = answering(&state.lock());
    let Ok(mut tried) = TRIED.lock() else {
        return;
    };
    for machine in machines {
        let name = machine.name().to_string();
        if scanned.contains(&name) || tried.get(&name).is_some_and(|at| now_ms - at < RETRY_MS) {
            continue;
        }
        tried.insert(name, now_ms);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = scan_and_store(&app, &machine).await {
                eprintln!("Failed to look for agent homes on {}: {error}", machine.name());
            }
        });
    }
}

/// What this Mac is called on the list: its name on the Machines page, or the one its sessions are filed under when
/// the page doesn't list it.
pub(super) fn this_mac_name(inner: &Inner) -> String {
    inner
        .series
        .values()
        .find(|series| series.local && series.host.enabled)
        .map(|series| series.host.machine.clone())
        .or_else(|| this_machine_name(inner))
        .unwrap_or_else(|| "localhost".into())
}

/// Every machine scripts run on: those the Machines page lists and can reach, and this Mac when it doesn't list it.
pub(super) fn machines_to_scan(inner: &Inner) -> Vec<Machine> {
    let mut machines: Vec<Machine> = inner.series.values().filter(|series| runs_scripts(series)).map(Machine::listed).collect();
    if let Some(name) = this_machine_name(inner) {
        machines.push(Machine::this_mac(&name));
    }
    machines
}

/// Those that answered their last health sample.
fn answering(inner: &Inner) -> Vec<Machine> {
    let mut machines: Vec<Machine> = inner
        .series
        .values()
        .filter(|series| runs_scripts(series) && series.error.is_none() && series.last_ok_at.is_some())
        .map(Machine::listed)
        .collect();
    if let Some(name) = this_machine_name(inner) {
        machines.push(Machine::this_mac(&name));
    }
    machines
}

async fn scan_and_store(app: &tauri::AppHandle, machine: &Machine) -> Result<(), String> {
    let name = machine.name().to_string();
    {
        let mut scanning = SCANNING.lock().map_err(|_| "The agent homes scan is stuck".to_string())?;
        if scanning.contains(&name) {
            return Ok(());
        }
        scanning.push(name.clone());
    }
    let result = scan(machine).await;
    let stored = run_usage_task(move || {
        let mut connection = open_usage_database()?;
        let added = store_scan(&mut connection, &result)?;
        reload(&connection)?;
        Ok(added)
    })
    .await;
    if let Ok(mut scanning) = SCANNING.lock() {
        scanning.retain(|machine| *machine != name);
    }
    stored?;
    let _ = app.emit(AGENT_HOMES_UPDATED_EVENT, ());
    Ok(())
}

/// Sent after each look for homes, so an open Agent homes page reads the list again.
pub(crate) const AGENT_HOMES_UPDATED_EVENT: &str = "agent-homes-updated";

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Each machine's homes, as Settings › Agent homes shows them.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentHomesView {
    /// The homes on every machine: the standard ones and those saved for every machine.
    everywhere: Vec<AgentHome>,
    machines: Vec<MachineHomes>,
    /// What Arbor knows about each harness: its home, sessions, instructions, skills and MCP config.
    harnesses: Vec<super::harnesses::HarnessInfo>,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "MachineAgentHomes")]
pub(crate) struct MachineHomes {
    machine: String,
    /// Its homes as its scripts read them, those for every machine included.
    homes: Vec<AgentHome>,
    #[ts(type = "number | null")]
    scanned_at_ms: Option<i64>,
    /// Why its last scan failed.
    error: Option<String>,
    /// What its last scan found that no home on the list covers.
    suggested: Vec<FoundHome>,
}

fn view(connection: &Connection, machines: &[String]) -> Result<AgentHomesView, String> {
    let saved = read_homes(connection)?;
    let scans = read_scans(connection)?;
    let machines = machines
        .iter()
        .map(|machine| {
            let homes = homes_on(&saved, machine);
            let scan = scans.iter().find(|scan| scan.machine == *machine);
            MachineHomes {
                machine: machine.clone(),
                suggested: scan.map(|scan| suggestions(&homes, &scan.found)).unwrap_or_default(),
                scanned_at_ms: scan.map(|scan| scan.scanned_at_ms),
                error: scan.filter(|scan| !scan.error.is_empty()).map(|scan| scan.error.clone()),
                homes,
            }
        })
        .collect();
    Ok(AgentHomesView { everywhere: homes_on(&saved, ""), machines, harnesses: super::harnesses::infos() })
}

fn machine_names(state: &MachineHealthState) -> Vec<String> {
    machines_to_scan(&state.lock()).iter().map(|machine| machine.name().to_string()).collect()
}

async fn read_view(state: &MachineHealthState) -> Result<AgentHomesView, String> {
    let machines = machine_names(state);
    run_usage_task(move || view(&open_usage_database()?, &machines)).await
}

#[tauri::command]
pub(crate) async fn get_agent_homes(state: tauri::State<'_, MachineHealthState>) -> Result<AgentHomesView, String> {
    read_view(&state).await
}

/// Adds a home, or changes its switches.
#[tauri::command]
pub(crate) async fn save_agent_home(state: tauri::State<'_, MachineHealthState>, home: AgentHome) -> Result<AgentHomesView, String> {
    let home = checked(home)?;
    run_usage_task(move || {
        let connection = open_usage_database()?;
        write_home(&connection, &home)?;
        reload(&connection)
    })
    .await?;
    read_view(&state).await
}

/// Takes a home off the list. A standard one comes back as it was, with both switches on.
#[tauri::command]
pub(crate) async fn remove_agent_home(
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    agent: AgentHomeKind,
    path: String,
) -> Result<AgentHomesView, String> {
    run_usage_task(move || {
        let connection = open_usage_database()?;
        connection
            .execute("DELETE FROM usage_agent_homes WHERE machine = ?1 AND agent = ?2 AND path = ?3", params![machine, agent.shell_name(), path])
            .map_err(|error| error.to_string())?;
        reload(&connection)
    })
    .await?;
    read_view(&state).await
}

/// Scans a machine for homes again, or every machine.
#[tauri::command]
pub(crate) async fn scan_agent_homes(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: Option<String>,
) -> Result<AgentHomesView, String> {
    let machines: Vec<Machine> = {
        let inner = state.lock();
        match &machine {
            Some(name) => vec![find_machine(&inner, name)?],
            None => machines_to_scan(&inner),
        }
    };
    futures_util::future::join_all(machines.iter().map(|machine| scan_and_store(&app, machine))).await.into_iter().collect::<Result<Vec<()>, String>>()?;
    read_view(&state).await
}

/// The folders a home would take in on a machine, for the Add dialog to show before it's saved: at most 50.
#[tauri::command]
pub(crate) async fn preview_agent_home(
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    agent: AgentHomeKind,
    path: String,
) -> Result<Vec<String>, String> {
    let home = checked(AgentHome { machine, agent, path, source: AgentHomeSource::Added, sessions: true, sync: false })?;
    let target = {
        let inner = state.lock();
        if home.machine.is_empty() {
            machines_to_scan(&inner).into_iter().find(Machine::is_local).ok_or_else(|| "Arbor can't run scripts on this Mac".to_string())?
        } else {
            find_machine(&inner, &home.machine)?
        }
    };
    let words = shell_words(&home.path).ok_or_else(|| "A home's folder starts with ~/ or /".to_string())?;
    let matched = u8::from(home.path.contains('*'));
    let script = format!(
        "set -u\nexport LC_ALL=C\n{HOME_HELPERS}printf 'H\\t%s\\n' \"$HOME\"\nfor dir in {words}; do home_line {} \"$dir\" {matched}; done | head -n 50\n",
        home.agent.shell_name()
    );
    let stdout = run_checked(&target, MachineOp::AgentHomeCheck, &script, Duration::from_secs(20)).await?;
    let user_home = stdout.lines().find_map(|line| line.strip_prefix("H\t")).unwrap_or_default().to_string();
    Ok(stdout.lines().filter_map(|line| line.split_once('\t')).filter(|(agent, _)| *agent != "H").map(|(_, dir)| tilde(dir, &user_home)).collect())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn home(machine: &str, agent: AgentHomeKind, path: &str, sessions: bool, sync: bool) -> AgentHome {
        AgentHome { machine: machine.into(), agent, path: path.into(), source: AgentHomeSource::Added, sessions, sync }
    }

    /// Has the list hold `homes` for the scripts this thread builds.
    pub(crate) fn save_on_this_thread(homes: Vec<AgentHome>) {
        TEST_SAVED.with(|saved| *saved.borrow_mut() = homes);
    }

    fn run(shell: &str, home: &Path, script: &str) -> String {
        let output = std::process::Command::new(shell)
            .arg("-c")
            .arg(script)
            .env_clear()
            .env("HOME", home)
            .env("PATH", "/usr/bin:/bin")
            .env("SHELL", "/bin/sh")
            .output()
            .unwrap();
        assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8(output.stdout).unwrap()
    }

    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("arbor-agent-homes-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_machine_gets_the_standard_homes_then_every_machine_s_then_its_own() {
        let saved = [
            home("", AgentHomeKind::Claude, "~/work/*", true, true),
            home("cedar-01", AgentHomeKind::Claude, "~/.claude", false, true),
            home("cedar-01", AgentHomeKind::Pi, "/srv/pi/sessions", true, true),
        ];
        let paths = |machine: &str| homes_on(&saved, machine).into_iter().map(|home| (home.path, home.sessions, home.sync)).collect::<Vec<_>>();
        let cedar = paths("cedar-01");
        assert!(cedar.contains(&("~/.claude".into(), false, true)), "switched off on cedar-01 alone");
        assert!(cedar.contains(&("/srv/pi/sessions".into(), true, false)), "Pi's sessions folder has no settings to sync");
        assert!(paths("casey-mbp").contains(&("~/.claude".into(), true, true)));
        assert!(paths("casey-mbp").contains(&("~/work/*".into(), true, true)));
        assert!(!paths("casey-mbp").iter().any(|(path, ..)| path == "/srv/pi/sessions"));
    }

    #[test]
    fn each_use_takes_its_homes_and_a_pattern_s_folders_have_to_look_the_part() {
        let root = temp_home("function");
        for dir in [".claude/projects", ".codex/sessions", "tools/a/projects", "tools/b/sessions", "tools/c", ".pi/agent/sessions/--x--", "env home"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        let saved = [
            home("", AgentHomeKind::Claude, "~/tools/*", true, false),
            home("", AgentHomeKind::Codex, "~/tools/*", true, true),
            home("m", AgentHomeKind::Codex, "~/.codex", false, true),
        ];
        let list = |use_: HomeUse| {
            let script = format!("{}CLAUDE_CONFIG_DIR=\"$HOME/env home\"\nagent_homes\n", shell_function_for(&saved, "m", use_));
            shells().into_iter().map(|shell| run(shell, &root, &script)).collect::<Vec<_>>()
        };
        let at = |path: &str| root.join(path).display().to_string();
        for listed in list(HomeUse::Sessions) {
            assert_eq!(listed, format!("claude\t{}\nclaude\t{}\nclaude\t{}\ncodex\t{}\n", at("env home"), at(".claude"), at("tools/a"), at("tools/b")));
        }
        for listed in list(HomeUse::Archive) {
            assert_eq!(
                listed,
                format!("claude\t{}\nclaude\t{}\npi\t{}\nclaude\t{}\ncodex\t{}\n", at("env home"), at(".claude"), at(".pi/agent/sessions"), at("tools/a"), at("tools/b"))
            );
        }
        for listed in list(HomeUse::Sync) {
            assert_eq!(listed, format!("claude\t{}\nclaude\t{}\ncodex\t{}\ncodex\t{}\n", at("env home"), at(".claude"), at(".codex"), at("tools/b")));
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_path_becomes_quoted_words_with_its_stars_left_to_the_shell() {
        assert_eq!(shell_words("~/Library/Application Support/Claude/*/local_*").unwrap(), "\"$HOME\"/'Library'/'Application Support'/'Claude'/*/'local_'*");
        assert_eq!(shell_words("/srv/it's").unwrap(), "/'srv'/'it'\\''s'");
        assert_eq!(shell_words("$CODEX_HOME").unwrap(), "\"${CODEX_HOME:-}\"");
        assert_eq!(shell_words("$PATH"), None, "only the agents' own variables");
        assert_eq!(shell_words("~/"), None);
        assert_eq!(shell_words("relative/path"), None);
    }

    #[test]
    fn only_a_folder_from_home_or_root_is_saved() {
        let check = |path: &str| checked(home("", AgentHomeKind::Claude, path, true, true)).map(|home| home.path);
        assert_eq!(check(" ~/work/*/ ").unwrap(), "~/work/*");
        assert_eq!(check("/opt/agents/claude").unwrap(), "/opt/agents/claude");
        for bad in ["~", "/", "work", "~/a/../b", "~/a//b", "$HOME/x", "~/a\nb"] {
            assert!(check(bad).is_err(), "{bad:?}");
        }
        let standard = checked(AgentHome { source: AgentHomeSource::Added, ..home("m", AgentHomeKind::Claude, "~/.claude", false, true) }).unwrap();
        assert_eq!(standard.source, AgentHomeSource::Standard, "switching a standard home keeps it standard");
        assert!(checked(home("", AgentHomeKind::Claude, "$CODEX_HOME", true, true)).is_err(), "another agent's variable");
        assert!(!checked(home("", AgentHomeKind::Pi, "~/pi", true, true)).unwrap().sync);
    }

    #[test]
    fn the_scan_finds_folders_shaped_like_homes_and_skips_the_rest() {
        let root = temp_home("scan");
        for dir in [
            ".claude/projects/-Users-casey-src",
            ".codex/sessions/2026/09/25",
            ".tools/profiles/work/projects/-Users-casey-src",
            ".tools/profiles/home/projects/-Users-casey-app",
            ".tools/profiles/codex/sessions/2026",
            ".pi/agent/sessions/--Users-casey-src--",
            "Library/Application Support/Claude/local-agent-mode-sessions/acct/org/local_1",
            "src/app/node_modules/pkg/.claude/projects/-x",
            "src/app/projects/website",
            "env home/projects/-x",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        fs::write(root.join(".claude.json"), "{}").unwrap();
        fs::write(root.join("Library/Application Support/Claude/local-agent-mode-sessions/acct/org/local_1/audit.jsonl"), "{}\n").unwrap();
        for shell in shells() {
            let script = format!("CLAUDE_CONFIG_DIR=\"$HOME/env home\"\n{SCAN_SCRIPT}");
            let read = parse_scan(&run(shell, &root, &script));
            assert_eq!(read.home, root.display().to_string());
            assert_eq!(
                read.found,
                [
                    (AgentHomeKind::Claude, "~/.claude".to_string()),
                    (AgentHomeKind::Claude, "~/.tools/profiles/home".into()),
                    (AgentHomeKind::Claude, "~/.tools/profiles/work".into()),
                    (AgentHomeKind::Codex, "~/.codex".into()),
                    (AgentHomeKind::Codex, "~/.tools/profiles/codex".into()),
                    (AgentHomeKind::Pi, "~/.pi/agent/sessions".into()),
                    (AgentHomeKind::ClaudeDesktop, "~/Library/Application Support/Claude/local-agent-mode-sessions/acct/org".into()),
                ],
                "{shell}"
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn what_the_list_doesn_t_cover_is_suggested_with_siblings_folded() {
        let found = |paths: &[(AgentHomeKind, &str)]| paths.iter().map(|(agent, path)| (*agent, path.to_string())).collect::<Vec<_>>();
        let homes = homes_on(&[home("m", AgentHomeKind::Claude, "~/.tools/profiles/*", true, false)], "m");
        let scanned = found(&[
            (AgentHomeKind::Claude, "~/.claude"),
            (AgentHomeKind::Claude, "~/.tools/profiles/work"),
            (AgentHomeKind::Claude, "~/.t4/homes/claude-a"),
            (AgentHomeKind::Claude, "~/.t4/homes/claude-b"),
            (AgentHomeKind::Codex, "~/.t4/homes/codex-a"),
            (AgentHomeKind::Claude, "~/.work-claude"),
            (AgentHomeKind::Claude, "~/.home-claude"),
            (AgentHomeKind::Claude, "~/Desktop/sessions/a/local_1/.claude"),
            (AgentHomeKind::Claude, "~/Desktop/sessions/a/local_2/.claude"),
            (AgentHomeKind::Claude, "~/Desktop/sessions/b/local_3/.claude"),
            (AgentHomeKind::Claude, "~/Desktop/sessions/b/.hidden/.claude"),
        ]);
        let suggested: Vec<(AgentHomeKind, String, u32)> = suggestions(&homes, &scanned).into_iter().map(|found| (found.agent, found.path, found.folders)).collect();
        assert_eq!(
            suggested,
            [
                (AgentHomeKind::Claude, "~/.home-claude".to_string(), 1),
                (AgentHomeKind::Claude, "~/.t4/homes/*".into(), 2),
                (AgentHomeKind::Claude, "~/.work-claude".into(), 1),
                (AgentHomeKind::Claude, "~/Desktop/sessions/*/*/.claude".into(), 3),
                (AgentHomeKind::Claude, "~/Desktop/sessions/b/.hidden/.claude".into(), 1),
                (AgentHomeKind::Codex, "~/.t4/homes/codex-a".into(), 1),
            ]
        );
        assert!(covers("~/Desktop/sessions/*/local_*/.claude", "~/Desktop/sessions/a/local_9/.claude"));
        assert!(!covers("~/*", "~/.claude"), "a star never takes a dot-folder");
    }

    #[test]
    fn a_machine_s_first_scan_adds_what_it_finds_and_later_ones_only_suggest() {
        let mut connection = super::super::super::schema::test_database();
        let scan = |found: &[&str]| StoredScan {
            machine: "cedar-01".into(),
            scanned_at_ms: 1,
            found: found.iter().map(|path| (AgentHomeKind::Claude, path.to_string())).collect(),
            error: String::new(),
            filled: true,
        };
        let added = store_scan(&mut connection, &scan(&["~/.claude", "~/.tools/a", "~/.tools/b"])).unwrap();
        assert_eq!(added.iter().map(|home| (home.path.as_str(), home.source, home.sessions, home.sync)).collect::<Vec<_>>(), [("~/.tools/*", AgentHomeSource::Found, true, FOUND_SYNC)]);
        assert!(store_scan(&mut connection, &scan(&["~/.tools/a", "~/.other"])).unwrap().is_empty(), "only suggested now");
        let view = view(&connection, &["cedar-01".into()]).unwrap();
        let [cedar] = &view.machines[..] else { panic!() };
        assert_eq!(cedar.suggested, [FoundHome { agent: AgentHomeKind::Claude, path: "~/.other".into(), folders: 1 }]);
        assert!(cedar.homes.iter().any(|home| home.path == "~/.tools/*" && home.machine == "cedar-01"));
        assert_eq!(view.everywhere.len(), standard_paths().count());
    }
}

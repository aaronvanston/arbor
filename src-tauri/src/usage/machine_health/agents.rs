//! Claude Code and Codex on each machine: the install the machine's PATH leads
//! to, its version, how it was installed (see `agent_install`) and any other
//! copy further along PATH, checked every ten minutes over the same shell or
//! SSH connection the health samples use, and an update that runs there the
//! way it was installed. Checks run apart from the health rounds, so a slow
//! `--version` never holds one up. How many are running comes with every
//! health sample instead (see `SAMPLE_SCRIPT`). Each check also says whether
//! Arbor's reporter is set up there, and which agent homes run it (see
//! `attention`), and whether T3 Code keeps its home there.

use super::agent_install::{self, InstallMethod, Probes, UpdatePlan};
use ts_rs::TS;
use super::*;

/// How often each machine's agents are checked. An update checks again at once.
const CHECK_INTERVAL_MS: i64 = 10 * 60 * 1000;
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
/// A native Claude Code build is a large download, and npm can be slow.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How much of an update's output the page gets.
const OUTPUT_LINES: usize = 12;
const OUTPUT_CHARS: usize = 2_000;

// Non-interactive shells leave out the directories installers put the agents
// in, so those go first, the way a login shell would order them, with version
// managers' Node installs, pnpm's global binaries and mise's shims last.
// Nothing may read stdin: the script arrives on it.
pub(super) const AGENT_ENV: &str = r##"set -u
export LC_ALL=C NO_COLOR=1 TERM=dumb
PATH="$HOME/.local/bin:$HOME/.claude/local:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.volta/bin:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"
for d in "$HOME/.local/share/fnm/aliases/default/bin" "$HOME/Library/Application Support/fnm/aliases/default/bin" "$HOME"/.nvm/versions/node/*/bin "$HOME/Library/pnpm" "$HOME/.local/share/pnpm" "$HOME/.local/share/mise/shims"; do
  if [ -d "$d" ]; then PATH="$PATH:$d"; fi
done
export PATH
"##;

// Every probe is read-only. Homebrew is asked about a binary only when it's in a keg, and mise only
// when it's a shim or one of mise's installs. Other copies of an agent further along PATH are listed
// once each, however many links lead to them. T3 Code's version comes from its app, or from the npm
// package behind its `t3` command.
const CHECK_SCRIPT: &str = r##"nl='
'
real_path() { realpath "$1" 2>/dev/null || readlink -f "$1" 2>/dev/null || printf '%s' "$1"; }
for agent in claude codex; do
  bin=$(command -v "$agent" 2>/dev/null || true)
  case "$bin" in /*) ;; *) continue ;; esac
  real=$(real_path "$bin")
  printf '%s_path=%s\n' "$agent" "$bin"
  printf '%s_real=%s\n' "$agent" "$real"
  printf '%s_version=%s\n' "$agent" "$("$bin" --version </dev/null 2>/dev/null | head -n 1)"
  case "$real" in
    */Cellar/*/*/*|*/Caskroom/*/*/*)
      brew=$(command -v brew 2>/dev/null || true)
      if [ -n "$brew" ]; then
        prefix=$(HOMEBREW_NO_AUTO_UPDATE=1 "$brew" --prefix </dev/null 2>/dev/null || true)
        if [ -n "$prefix" ]; then printf '%s_brew_prefix=%s\n' "$agent" "$(real_path "$prefix")"; fi
        case "$real" in
          */Caskroom/*) kind=cask; name=${real##*/Caskroom/} ;;
          *) kind=formula; name=${real##*/Cellar/} ;;
        esac
        name=${name%%/*}
        if HOMEBREW_NO_AUTO_UPDATE=1 "$brew" list "--$kind" "$name" </dev/null >/dev/null 2>&1; then
          printf '%s_brew_owner=%s %s\n' "$agent" "$kind" "$name"
        fi
      fi
      ;;
  esac
  case "$bin$nl$real" in
    */mise/shims/*|*/mise/installs/*)
      mise=$(command -v mise 2>/dev/null || true)
      if [ -z "$mise" ] && [ -x "$HOME/.local/bin/mise" ]; then mise=$HOME/.local/bin/mise; fi
      if [ -n "$mise" ]; then
        tool=$("$mise" which "$agent" --plugin </dev/null 2>/dev/null | head -n 1 || true)
        gives=$("$mise" which "$agent" </dev/null 2>/dev/null | head -n 1 || true)
        if [ -n "$tool" ] && [ -n "$gives" ]; then
          printf '%s_mise_tool=%s\n' "$agent" "$tool"
          printf '%s_mise_real=%s\n' "$agent" "$(real_path "$gives")"
        fi
      fi
      ;;
  esac
  seen="$nl$real$nl"
  old_ifs=$IFS
  IFS=:
  set -f
  for dir in $PATH; do
    IFS=$old_ifs
    case "$dir" in /*) ;; *) continue ;; esac
    other="$dir/$agent"
    if [ -f "$other" ] && [ -x "$other" ]; then
      other_real=$(real_path "$other")
      case "$seen" in *"$nl$other_real$nl"*) continue ;; esac
      seen="$seen$other_real$nl"
      printf '%s_copy=%s\t%s\t%s\n' "$agent" "$other" "$other_real" "$("$other" --version </dev/null 2>/dev/null | head -n 1 | tr -d '\t')"
    fi
  done
  IFS=$old_ifs
  set +f
done
if [ -d "$HOME/.t3" ]; then
  printf 't3=1\n'
  t3_version=
  for app in /Applications/T3\ Code*.app "$HOME"/Applications/T3\ Code*.app; do
    [ -f "$app/Contents/Info.plist" ] || continue
    t3_version=$(plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist" 2>/dev/null || defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)
    if [ -n "$t3_version" ]; then break; fi
  done
  if [ -z "$t3_version" ]; then
    t3_bin=$(command -v t3 2>/dev/null || true)
    case "$t3_bin" in
      /*)
        t3_real=$(real_path "$t3_bin")
        case "$t3_real" in
          */node_modules/t3/dist/*) t3_version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "${t3_real%/dist/*}/package.json" 2>/dev/null | head -n 1) ;;
        esac
        ;;
    esac
  fi
  if [ -n "$t3_version" ]; then printf 't3_version=%s\n' "$t3_version"; fi
fi
"##;

// Expects `agent` to be set. An npm install updates with the npm next to the
// Node that owns it rather than whichever npm comes first.
pub(super) const UPDATE_SCRIPT: &str = r##"bin=$(command -v "$agent" 2>/dev/null || true)
case "$bin" in
  /*) ;;
  *) printf '%s is not installed where Arbor looks for it\n' "$agent" >&2; exit 127 ;;
esac
real=$(realpath "$bin" 2>/dev/null || readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")
case "$real" in
  */lib/node_modules/*) PATH="${real%%/lib/node_modules/*}/bin:$PATH"; export PATH ;;
esac
# An agent too old to have `update` would take the word as a prompt, so check it's a command first.
if ! "$bin" --help </dev/null 2>/dev/null | grep -Eq '^[[:space:]]+update([[:space:]|,]|$)'; then
  printf 'This version of %s has no update command. Update it the way it was installed.\n' "$agent" >&2
  exit 2
fi
"$bin" update </dev/null 2>&1
"##;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AgentKind {
    Claude,
    Codex,
}

impl AgentKind {
    pub(super) fn command(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
        }
    }
}

/// One agent's install on a machine.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentInstall {
    /// From `--version`; None when it printed nothing that reads as a version.
    version: Option<String>,
    /// The binary the machine's PATH leads to.
    path: String,
    /// The file `path` leads to, when that's somewhere else.
    real: Option<String>,
    method: InstallMethod,
    /// What an update runs, as its user is shown it.
    update_command: String,
    /// Other copies of the agent further along PATH, which the shell finds only after this one.
    copies: Vec<AgentCopy>,
    #[serde(skip)]
    plan: UpdatePlan,
}

/// Another copy of an agent on the machine.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCopy {
    path: String,
    real: Option<String>,
    version: Option<String>,
}

/// T3 Code on a machine: it keeps its home there.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct T3Install {
    /// From its app, or the npm package behind its `t3` command.
    version: Option<String>,
}

/// The installs one check found.
#[derive(Clone, Debug, Default, PartialEq)]
struct AgentCheck {
    claude: Option<AgentInstall>,
    codex: Option<AgentInstall>,
    reporter: attention::ReporterStatus,
    t3: Option<T3Install>,
}

impl AgentCheck {
    fn install(&self, agent: AgentKind) -> Option<&AgentInstall> {
        match agent {
            AgentKind::Claude => self.claude.as_ref(),
            AgentKind::Codex => self.codex.as_ref(),
        }
    }
}

/// What the checks found on a machine. A failed check keeps what the last good one found.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineAgents {
    claude: Option<AgentInstall>,
    codex: Option<AgentInstall>,
    checked_at: Option<i64>,
    error: Option<String>,
    /// Agents being updated right now.
    updating: Vec<AgentKind>,
    /// Arbor's reporter, which says when a session is waiting on its user.
    reporter: attention::ReporterStatus,
    /// T3 Code, when it keeps its home here.
    t3: Option<T3Install>,
    #[serde(skip)]
    checking: bool,
}

impl MachineAgents {
    pub(super) fn reporter(&self) -> &attention::ReporterStatus {
        &self.reporter
    }

    pub(super) fn t3(&self) -> Option<&T3Install> {
        self.t3.as_ref()
    }
}

/// The version in what `--version` printed: "2.1.281 (Claude Code)", "codex-cli 0.156.0".
pub(super) fn parse_version(line: &str) -> Option<String> {
    line.split_whitespace().find_map(|word| {
        let word = word.strip_prefix('v').unwrap_or(word);
        let end = word
            .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')))
            .unwrap_or(word.len());
        let version = word[..end].trim_end_matches(['.', '-', '+']);
        (version.starts_with(|c: char| c.is_ascii_digit()) && version.contains('.')).then(|| version.to_string())
    })
}

fn parse_check(stdout: &str) -> AgentCheck {
    let fields: HashMap<&str, &str> = stdout
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim(), value.trim()))
        .collect();
    let install = |agent: AgentKind| {
        let field = |name: &str| {
            fields
                .get(format!("{}_{name}", agent.command()).as_str())
                .copied()
                .filter(|value| !value.is_empty())
        };
        let path = field("path")?;
        let real = field("real").unwrap_or(path);
        let probes = Probes {
            brew_prefix: field("brew_prefix").map(str::to_string),
            brew_owner: field("brew_owner").and_then(|owner| owner.split_once(' ')).map(|(kind, name)| (kind.to_string(), name.to_string())),
            mise_tool: field("mise_tool").map(str::to_string),
            mise_real: field("mise_real").map(str::to_string),
        };
        let (method, plan) = agent_install::classify(agent, path, real, &probes);
        // A copy that leads to the binary this install runs is the same install.
        let runs = agent_install::runs(path, real, &probes);
        let copy_prefix = format!("{}_copy=", agent.command());
        let copies = stdout
            .lines()
            .filter_map(|line| line.strip_prefix(copy_prefix.as_str()))
            .filter_map(|copy| {
                let mut parts = copy.splitn(3, '\t');
                let (path, copy_real) = (parts.next()?.trim(), parts.next().unwrap_or_default().trim());
                let copy_real = if copy_real.is_empty() { path } else { copy_real };
                (!path.is_empty() && copy_real != runs).then(|| AgentCopy {
                    path: path.to_string(),
                    real: (copy_real != path).then(|| copy_real.to_string()),
                    version: parts.next().and_then(parse_version),
                })
            })
            .collect();
        Some(AgentInstall {
            version: field("version").and_then(parse_version),
            path: path.to_string(),
            real: (real != path).then(|| real.to_string()),
            method,
            update_command: agent_install::update_command(agent, &plan),
            copies,
            plan,
        })
    };
    AgentCheck {
        claude: install(AgentKind::Claude),
        codex: install(AgentKind::Codex),
        reporter: attention::parse_status(stdout),
        t3: fields.get("t3").filter(|on| **on == "1").map(|_| T3Install {
            version: fields.get("t3_version").and_then(|line| parse_version(line)),
        }),
    }
}

fn check_script() -> String {
    format!("{AGENT_ENV}{CHECK_SCRIPT}{}{}", attention::AGENT_HOMES, attention::REPORTER_CHECK)
}

fn update_script(agent: AgentKind, plan: &UpdatePlan) -> String {
    format!("{AGENT_ENV}{}", agent_install::update_script(agent, plan))
}

async fn check(machine: &Machine) -> Result<AgentCheck, String> {
    Ok(parse_check(&run_checked(machine, MachineOp::AgentVersions, &check_script(), CHECK_TIMEOUT).await?))
}

/// Stores a check's result, unless the machine has since been pointed somewhere else.
fn record_check(state: &MachineHealthState, machine: &str, host: &MachineHost, at_ms: i64, result: Result<AgentCheck, String>) {
    let mut inner = state.lock();
    let Some(series) = inner.series.get_mut(machine) else {
        return;
    };
    if series.host.endpoint != host.endpoint || series.host.port != host.port {
        return;
    }
    let agents = &mut series.agents;
    agents.checking = false;
    agents.checked_at = Some(at_ms);
    match result {
        Ok(found) => {
            agents.claude = found.claude;
            agents.codex = found.codex;
            agents.reporter = found.reporter;
            agents.t3 = found.t3;
            agents.error = None;
        }
        Err(error) => agents.error = Some(error),
    }
}

/// Machines that answered their last sample and haven't had their agents checked for a while,
/// marked as being checked.
fn take_due(state: &MachineHealthState, now_ms: i64) -> Vec<Machine> {
    let mut inner = state.lock();
    inner
        .series
        .values_mut()
        .filter(|series| series.host.enabled && series.error.is_none() && series.last_ok_at.is_some())
        .filter(|series| {
            !series.agents.checking && series.agents.checked_at.is_none_or(|at| now_ms - at >= CHECK_INTERVAL_MS)
        })
        .map(|series| {
            series.agents.checking = true;
            Machine::listed(series)
        })
        .collect()
}

/// Checks a machine's agents again now, as after an update or a change to the reporter, and
/// tells the page.
pub(super) async fn recheck(app: &tauri::AppHandle, state: &MachineHealthState, machine: &Machine) {
    let checked = check(machine).await;
    record_check(state, machine.name(), machine.host(), Local::now().timestamp_millis(), checked);
    let seq = state.lock().seq;
    let _ = app.emit(MACHINE_HEALTH_UPDATED_EVENT, seq);
}

/// Starts a check on each machine that's due for one. Called after every health round.
pub(super) fn check_due(app: &tauri::AppHandle, state: &MachineHealthState, now_ms: i64) {
    for machine in take_due(state, now_ms) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let result = check(&machine).await;
            record_check(&app.state::<MachineHealthState>(), machine.name(), machine.host(), Local::now().timestamp_millis(), result);
        });
    }
}

/// Drops color and cursor codes, and control characters other than line breaks and tabs.
pub(super) fn strip_terminal_codes(raw: &str) -> String {
    let mut plain = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                // CSI: parameters, then one final byte.
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC (window titles, links): up to BEL or ESC \.
                Some(']') => {
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' {
                            break;
                        }
                        if c == '\u{1b}' {
                            chars.next_if_eq(&'\\');
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\n' | '\r' | '\t' => plain.push(c),
            c if c.is_control() => {}
            c => plain.push(c),
        }
    }
    plain
}

/// The last lines of what a command printed, as plain text. A progress line that redraws itself
/// keeps only its last state.
fn output_tail(raw: &str) -> String {
    let plain = strip_terminal_codes(raw);
    let lines: Vec<&str> = plain
        .lines()
        .filter_map(|line| line.rsplit('\r').map(str::trim_end).find(|part| !part.trim().is_empty()))
        .collect();
    let tail = lines[lines.len().saturating_sub(OUTPUT_LINES)..].join("\n");
    match tail.char_indices().rev().nth(OUTPUT_CHARS - 1) {
        Some((start, _)) if start > 0 => format!("…{}", &tail[start..]),
        _ => tail,
    }
}

/// What the update printed when it worked; why it didn't when it failed.
fn update_result(output: &std::process::Output) -> Result<String, String> {
    let printed = output_tail(&String::from_utf8_lossy(&output.stdout));
    if output.status.success() {
        Ok(printed)
    } else if printed.is_empty() {
        Err(failure_detail(output))
    } else {
        Err(printed)
    }
}

/// What an update did, for the page.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUpdate {
    before: Option<String>,
    after: Option<String>,
    /// The end of what the update printed.
    output: String,
}

/// The install an update goes ahead with, from a check made just before it: the one the page showed,
/// unless it now updates with another command than the one its user said yes to.
fn planned_install(checked: &Result<AgentCheck, String>, agent: AgentKind, machine: &str, command: Option<&str>) -> Result<AgentInstall, String> {
    let found = checked.as_ref().map_err(Clone::clone)?;
    let install = found
        .install(agent)
        .ok_or_else(|| format!("{} isn't installed where Arbor looks for it on {machine} any more", agent.label()))?;
    match command {
        Some(shown) if shown != install.update_command => Err(format!(
            "{} on {machine} now updates with {} instead. Look at it again, then update.",
            agent.label(),
            install.update_command
        )),
        _ => Ok(install.clone()),
    }
}

/// Updates the agent on the machine the way it was installed, then checks its agents again so the
/// page shows the version it ended up on. How it was installed is read again first, so the update
/// never goes by an older check; `command`, when given, is what its user was shown, and nothing runs
/// if that has changed.
#[tauri::command]
pub(crate) async fn update_machine_agent(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    agent: AgentKind,
    command: Option<String>,
) -> Result<AgentUpdate, String> {
    let target = {
        let mut inner = state.lock();
        let target = find_machine(&inner, &machine)?;
        // Agent versions are only kept for machines the Machines page lists.
        let series = inner.series.get_mut(&machine).ok_or_else(|| not_checked(&machine))?;
        if series.agents.updating.contains(&agent) {
            return Err(format!("{} is already being updated on {machine}", agent.label()));
        }
        series.agents.updating.push(agent);
        target
    };
    let fresh = check(&target).await;
    let install = match planned_install(&fresh, agent, &machine, command.as_deref()) {
        Ok(install) => install,
        Err(error) => {
            if let Some(series) = state.lock().series.get_mut(&machine) {
                series.agents.updating.retain(|kind| *kind != agent);
            }
            record_check(&state, &machine, target.host(), Local::now().timestamp_millis(), fresh);
            let seq = state.lock().seq;
            let _ = app.emit(MACHINE_HEALTH_UPDATED_EVENT, seq);
            return Err(error);
        }
    };
    let before = install.version.clone();
    let updated = match run_on_machine(&target, MachineOp::AgentUpdate, &update_script(agent, &install.plan), UPDATE_TIMEOUT).await {
        Ok(output) => update_result(&output),
        Err(error) => Err(error),
    };
    let checked = check(&target).await;
    let after = checked
        .as_ref()
        .ok()
        .and_then(|found| found.install(agent))
        .and_then(|install| install.version.clone());
    if let Some(series) = state.lock().series.get_mut(&machine) {
        series.agents.updating.retain(|kind| *kind != agent);
    }
    record_check(&state, &machine, target.host(), Local::now().timestamp_millis(), checked);
    let seq = state.lock().seq;
    let _ = app.emit(MACHINE_HEALTH_UPDATED_EVENT, seq);
    updated.map(|output| AgentUpdate { before, after, output })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(name: &str) -> MachineHost {
        MachineHost { machine: name.into(), endpoint: name.into(), port: 22, enabled: true, source: String::new() }
    }

    /// An install as a check reads it when nothing but its paths says how it was installed.
    fn install_at(version: Option<&str>, path: &str, real: Option<&str>) -> AgentInstall {
        let agent = if path.ends_with("codex") { AgentKind::Codex } else { AgentKind::Claude };
        let (method, plan) = agent_install::classify(agent, path, real.unwrap_or(path), &Probes::default());
        AgentInstall {
            version: version.map(Into::into),
            path: path.into(),
            real: real.map(Into::into),
            method,
            update_command: agent_install::update_command(agent, &plan),
            copies: Vec::new(),
            plan,
        }
    }

    fn install(version: &str, path: &str) -> Option<AgentInstall> {
        Some(install_at(Some(version), path, None))
    }

    #[test]
    fn versions_are_read_from_what_the_agents_print() {
        assert_eq!(parse_version("2.1.281 (Claude Code)").as_deref(), Some("2.1.281"));
        assert_eq!(parse_version("codex-cli 0.156.0").as_deref(), Some("0.156.0"));
        assert_eq!(parse_version("codex-cli 0.47.0-alpha.3").as_deref(), Some("0.47.0-alpha.3"));
        assert_eq!(parse_version("Claude Code v2.0.1.").as_deref(), Some("2.0.1"));
        assert_eq!(parse_version("error: unknown option --version"), None);
        assert_eq!(parse_version("version 7"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn checks_name_each_agent_and_where_it_lives() {
        let found = parse_check(
            "claude_path=/home/casey/.local/bin/claude\nclaude_version=2.1.281 (Claude Code)\n\
             codex_path=/usr/local/bin/codex\ncodex_version=\n",
        );
        assert_eq!(found.claude, install("2.1.281", "/home/casey/.local/bin/claude"));
        assert_eq!(
            found.codex,
            Some(install_at(None, "/usr/local/bin/codex", None)),
            "an install whose --version printed nothing still shows where it is",
        );
        assert_eq!(parse_check(""), AgentCheck::default());
    }

    #[test]
    fn checks_say_how_each_agent_was_installed_and_what_else_is_on_path() {
        let found = parse_check(
            "claude_path=/Users/a/.local/bin/claude\nclaude_real=/Users/a/.local/share/claude/versions/2.1.281\nclaude_version=2.1.281 (Claude Code)\n\
             codex_path=/Users/a/.npm-global/bin/codex\ncodex_real=/Users/a/.npm-global/lib/node_modules/@openai/codex/bin/codex.js\ncodex_version=codex-cli 0.156.0\n\
             codex_copy=/opt/homebrew/bin/codex\t/opt/homebrew/Caskroom/codex/0.153.3/codex\tcodex-cli 0.153.3\n\
             codex_copy=/usr/local/bin/codex\t\t\n\
             t3=1\nt3_version=0.0.42\n",
        );
        let claude = found.claude.expect("claude");
        assert_eq!((claude.method, claude.update_command.as_str()), (InstallMethod::Native, "claude update"));
        assert_eq!(claude.real.as_deref(), Some("/Users/a/.local/share/claude/versions/2.1.281"));
        let codex = found.codex.expect("codex");
        assert_eq!(codex.method, InstallMethod::Npm);
        assert_eq!(codex.update_command, "npm install -g --prefix /Users/a/.npm-global --allow-scripts=@openai/codex @openai/codex@latest");
        assert_eq!(codex.copies, [
            AgentCopy { path: "/opt/homebrew/bin/codex".into(), real: Some("/opt/homebrew/Caskroom/codex/0.153.3/codex".into()), version: Some("0.153.3".into()) },
            AgentCopy { path: "/usr/local/bin/codex".into(), real: None, version: None },
        ]);
        assert_eq!(found.t3, Some(T3Install { version: Some("0.0.42".into()) }));
        assert_eq!(parse_check("t3=1\n").t3, Some(T3Install { version: None }));

        let brew = parse_check(
            "codex_path=/opt/homebrew/bin/codex\ncodex_real=/opt/homebrew/Caskroom/codex/0.157.0/codex\n\
             codex_brew_prefix=/opt/homebrew\ncodex_brew_owner=cask codex\n",
        );
        let brew = brew.codex.expect("codex");
        assert_eq!((brew.method, brew.update_command.as_str()), (InstallMethod::Homebrew, "brew upgrade --cask codex"));

        // A copy that is the binary mise's shim runs isn't another copy.
        let mise = parse_check(
            "codex_path=/Users/a/.local/share/mise/shims/codex\ncodex_real=/opt/homebrew/bin/mise\n\
             codex_mise_tool=npm:@openai/codex\ncodex_mise_real=/Users/a/.local/share/mise/installs/codex/0.157.0/codex.js\n\
             codex_copy=/Users/a/.local/share/mise/installs/codex/0.157.0/bin/codex\t/Users/a/.local/share/mise/installs/codex/0.157.0/codex.js\t\n",
        );
        let mise = mise.codex.expect("codex");
        assert_eq!((mise.method, mise.update_command.as_str()), (InstallMethod::Mise, "mise upgrade npm:@openai/codex"));
        assert!(mise.copies.is_empty());

        // Nor is one an npm global under mise's own Node, reached through the shim, leads to; a copy elsewhere still is.
        let global = "/Users/a/.local/share/mise/installs/node/24.1.0/lib/node_modules/@openai/codex/bin/codex.js";
        let npm = parse_check(&format!(
            "codex_path=/Users/a/.local/share/mise/shims/codex\ncodex_real=/opt/homebrew/bin/mise\n\
             codex_mise_tool=node\ncodex_mise_real={global}\n\
             codex_copy=/Users/a/.local/share/mise/installs/node/24.1.0/bin/codex\t{global}\t\n\
             codex_copy=/usr/local/bin/codex\t/usr/local/lib/node_modules/@openai/codex/bin/codex.js\tcodex-cli 0.150.0\n",
        ));
        let npm = npm.codex.expect("codex");
        assert_eq!(npm.method, InstallMethod::Npm);
        assert_eq!(npm.copies, [AgentCopy {
            path: "/usr/local/bin/codex".into(),
            real: Some("/usr/local/lib/node_modules/@openai/codex/bin/codex.js".into()),
            version: Some("0.150.0".into()),
        }]);
    }

    #[test]
    fn an_update_goes_ahead_only_with_the_command_its_user_saw() {
        let checked = Ok(parse_check(
            "codex_path=/Users/a/.npm-global/bin/codex\ncodex_real=/Users/a/.npm-global/lib/node_modules/@openai/codex/bin/codex.js\n",
        ));
        let shown = "npm install -g --prefix /Users/a/.npm-global --allow-scripts=@openai/codex @openai/codex@latest";
        assert_eq!(planned_install(&checked, AgentKind::Codex, "mbp", Some(shown)).map(|install| install.plan), Ok(UpdatePlan::Npm { prefix: "/Users/a/.npm-global".into() }));
        assert!(planned_install(&checked, AgentKind::Codex, "mbp", None).is_ok(), "an update from before commands were shown");
        assert_eq!(
            planned_install(&checked, AgentKind::Codex, "mbp", Some("codex update")).map(|install| install.plan),
            Err(format!("Codex on mbp now updates with {shown} instead. Look at it again, then update.")),
        );
        assert_eq!(
            planned_install(&checked, AgentKind::Claude, "mbp", None).map(|install| install.plan),
            Err("Claude Code isn't installed where Arbor looks for it on mbp any more".into()),
        );
        assert_eq!(planned_install(&Err("Timed out after 20s".into()), AgentKind::Codex, "mbp", None).map(|install| install.plan), Err("Timed out after 20s".into()));
    }

    #[test]
    fn machines_are_checked_when_they_answer_and_then_every_ten_minutes() {
        let state = MachineHealthState::default();
        apply_hosts(&state, vec![host("up"), host("down"), host("off")]);
        {
            let mut inner = state.lock();
            for (name, series) in inner.series.iter_mut() {
                series.last_ok_at = Some(1_000);
                series.error = (name == "down").then(|| "ssh: connect refused".to_string());
                series.host.enabled = name != "off";
            }
        }
        let due = take_due(&state, 1_000);
        assert_eq!(due.iter().map(Machine::name).collect::<Vec<_>>(), ["up"]);
        assert!(take_due(&state, 2_000).is_empty(), "one check at a time");

        let found = AgentCheck { claude: install("2.1.281", "/usr/local/bin/claude"), ..AgentCheck::default() };
        record_check(&state, "up", &host("up"), 5_000, Ok(found));
        assert!(take_due(&state, 5_000 + CHECK_INTERVAL_MS - 1).is_empty());
        assert_eq!(take_due(&state, 5_000 + CHECK_INTERVAL_MS).len(), 1);

        // A failed check keeps what the last one found.
        record_check(&state, "up", &host("up"), 9_000, Err("Timed out after 20s".into()));
        let inner = state.lock();
        let agents = &inner.series["up"].agents;
        assert_eq!(agents.claude, install("2.1.281", "/usr/local/bin/claude"));
        assert_eq!(agents.error.as_deref(), Some("Timed out after 20s"));
        assert_eq!(agents.checked_at, Some(9_000));
        assert!(!agents.checking);
    }

    #[test]
    fn a_check_of_a_machine_pointed_elsewhere_since_is_dropped() {
        let state = MachineHealthState::default();
        apply_hosts(&state, vec![host("box")]);
        let moved = MachineHost { endpoint: "box.lan".into(), ..host("box") };
        apply_hosts(&state, vec![moved]);
        let found = AgentCheck { claude: install("2.1.281", "/usr/local/bin/claude"), ..AgentCheck::default() };
        record_check(&state, "box", &host("box"), 1_000, Ok(found));
        assert_eq!(state.lock().series["box"].agents, MachineAgents::default());
    }

    #[test]
    fn update_output_is_plain_text_ending_where_the_command_did() {
        let raw = "\u{1b}]0;claude\u{7}Current version: 2.1.270\n\
                   Downloading  10%\rDownloading  64%\rDownloading 100%\n\n\
                   \u{1b}[32m✔\u{1b}[0m Successfully updated from 2.1.270 to version 2.1.281\r\n";
        assert_eq!(
            output_tail(raw),
            "Current version: 2.1.270\nDownloading 100%\n✔ Successfully updated from 2.1.270 to version 2.1.281",
        );
        let long = (1..=40).map(|line| format!("line {line}")).collect::<Vec<_>>().join("\n");
        assert_eq!(output_tail(&long).lines().count(), OUTPUT_LINES);
        assert!(output_tail(&long).ends_with("line 40"));
        let wide = output_tail(&"x".repeat(OUTPUT_CHARS * 2));
        assert_eq!(wide.chars().count(), OUTPUT_CHARS + 1);
        assert!(wide.starts_with('…'));
    }

    #[cfg(unix)]
    mod scripts {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn temp_home(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let home = std::env::temp_dir().join(format!("arbor-agents-{name}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&home).unwrap();
            // The script resolves links, and macOS's temp dir is behind one.
            fs::canonicalize(&home).unwrap()
        }

        /// The check, looking only under `home`: without the system's Homebrew directories and
        /// /Applications, so whatever this Mac has installed there can't be found.
        fn home_check_script() -> String {
            let apps = "for app in /Applications/T3\\ Code*.app ";
            assert!(check_script().contains(apps));
            home_only(&check_script()).replace(apps, "for app in ")
        }

        /// A script with the system's Homebrew directories left off its PATH.
        fn home_only(script: &str) -> String {
            let brew_dirs = "/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:";
            assert!(script.contains(brew_dirs));
            script.replace(brew_dirs, "")
        }

        fn link(target: &Path, at: &Path) {
            fs::create_dir_all(at.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(target, at).unwrap();
        }

        fn write(path: &Path, content: &str) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        fn run_in(shell_name: &str, home: &Path, script: &str) -> std::process::Output {
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(run_script(shell_named(shell_name, home), script, Duration::from_secs(10)))
                .unwrap()
        }

        fn checked(shell_name: &str, home: &Path) -> AgentCheck {
            let output = run_in(shell_name, home, &home_check_script());
            assert!(output.status.success(), "{shell_name}: {}", String::from_utf8_lossy(&output.stderr));
            parse_check(&String::from_utf8_lossy(&output.stdout))
        }

        /// An executable stand-in for an agent or npm.
        fn fake(path: &Path, body: &str) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }

        /// `sh` with nothing of this machine's environment but a bare PATH, so only the fakes
        /// under `home` (which come first on the script's PATH) can be found and run.
        fn shell(home: &Path) -> tokio::process::Command {
            shell_named("sh", home)
        }

        fn shell_named(name: &str, home: &Path) -> tokio::process::Command {
            let mut command = tokio::process::Command::new(name);
            command
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            command
        }

        fn run(home: &Path, script: &str) -> std::process::Output {
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(run_script(shell(home), script, Duration::from_secs(10)))
                .unwrap()
        }

        #[test]
        fn the_check_finds_agents_where_installers_put_them() {
            let home = temp_home("check");
            fake(&home.join(".local/bin/claude"), "echo '2.1.281 (Claude Code)'");
            fake(&home.join(".npm-global/bin/codex"), "echo 'codex-cli 0.156.0'");
            let output = run(&home, &home_check_script());
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            let found = parse_check(&String::from_utf8_lossy(&output.stdout));
            assert_eq!(found.claude, install("2.1.281", &home.join(".local/bin/claude").display().to_string()));
            assert_eq!(found.codex, install("0.156.0", &home.join(".npm-global/bin/codex").display().to_string()));
            assert_eq!(found.t3, None, "no ~/.t3, no T3 Code");
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn the_check_follows_links_lists_other_copies_once_and_finds_t3_code() {
            let home = temp_home("copies");
            let at = |rel: &str| home.join(rel);
            let shown = |rel: &str| at(rel).display().to_string();
            fake(&at(".local/share/claude/versions/2.1.281"), "echo '2.1.281 (Claude Code)'");
            link(&at(".local/share/claude/versions/2.1.281"), &at(".local/bin/claude"));
            let package = at(".npm-global/lib/node_modules/@openai/codex/bin/codex.js");
            fake(&package, "echo 'codex-cli 0.156.0'");
            link(&package, &at(".npm-global/bin/codex"));
            // A second copy, and a link to the first, which isn't one.
            fake(&at(".bun/bin/codex"), "echo 'codex-cli 0.150.0'");
            link(&package, &at(".volta/bin/codex"));
            fs::create_dir_all(at(".t3/userdata")).unwrap();
            let t3 = at(".npm-global/lib/node_modules/t3/dist/bin.mjs");
            fake(&t3, "exit 0");
            write(&at(".npm-global/lib/node_modules/t3/package.json"), "{\n  \"name\": \"t3\",\n  \"version\": \"0.0.42\",\n  \"bin\": { \"t3\": \"./dist/bin.mjs\" }\n}\n");
            link(&t3, &at(".npm-global/bin/t3"));
            for shell_name in shells() {
                let found = checked(shell_name, &home);
                let claude = found.claude.expect("claude");
                assert_eq!((claude.method, claude.real), (InstallMethod::Native, Some(shown(".local/share/claude/versions/2.1.281"))), "{shell_name}");
                let codex = found.codex.expect("codex");
                assert_eq!((codex.path.as_str(), codex.method, codex.version.as_deref()), (shown(".npm-global/bin/codex").as_str(), InstallMethod::Npm, Some("0.156.0")), "{shell_name}");
                assert_eq!(codex.copies, [AgentCopy { path: shown(".bun/bin/codex"), real: None, version: Some("0.150.0".into()) }], "{shell_name}");
                assert_eq!(found.t3, Some(T3Install { version: Some("0.0.42".into()) }), "{shell_name}");
            }
            let _ = fs::remove_dir_all(&home);
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn t3_codes_version_comes_from_its_app() {
            let home = temp_home("t3-app");
            fs::create_dir_all(home.join(".t3")).unwrap();
            write(
                &home.join("Applications/T3 Code (Alpha).app/Contents/Info.plist"),
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.0.43</string></dict></plist>
"#,
            );
            assert_eq!(checked("sh", &home).t3, Some(T3Install { version: Some("0.0.43".into()) }));
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn homebrew_is_asked_only_about_a_binary_in_one_of_its_kegs() {
            let home = temp_home("brew");
            let calls = home.join("brew-calls");
            fake(
                &home.join(".local/bin/brew"),
                &format!(
                    r#"printf '%s\n' "$*" >> '{}'
case "$1" in
  --prefix) printf '%s\n' "$HOME/brew" ;;
  list) [ "$2" = --cask ] && [ "$3" = codex ] ;;
  *) exit 1 ;;
esac"#,
                    calls.display()
                ),
            );
            let cask = home.join("brew/Caskroom/codex/0.157.0/codex-aarch64-apple-darwin");
            fake(&cask, "echo 'codex-cli 0.157.0'");
            link(&cask, &home.join(".local/bin/codex"));
            fake(&home.join(".npm-global/bin/claude"), "echo '2.1.281 (Claude Code)'");
            for shell_name in shells() {
                let _ = fs::remove_file(&calls);
                let found = checked(shell_name, &home);
                let codex = found.codex.expect("codex");
                assert_eq!((codex.method, codex.update_command.as_str()), (InstallMethod::Homebrew, "brew upgrade --cask codex"), "{shell_name}");
                assert_eq!(found.claude.expect("claude").method, InstallMethod::Unknown, "{shell_name}");
                assert_eq!(fs::read_to_string(&calls).unwrap(), "--prefix\nlist --cask codex\n", "{shell_name}: only read-only questions, and only about the keg");
            }
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn mise_names_the_tool_behind_its_shim() {
            let home = temp_home("mise");
            let installed = home.join(".local/share/mise/installs/npm-openai-codex/0.157.0/bin/codex");
            fake(&installed, "echo 'codex-cli 0.157.0'");
            fake(
                &home.join(".local/bin/mise"),
                &format!(
                    r#"case "$0" in */codex) echo 'codex-cli 0.157.0'; exit 0 ;; esac
case "$*" in
  "which codex --plugin") echo 'npm:@openai/codex' ;;
  "which codex") echo '{}' ;;
  *) exit 1 ;;
esac"#,
                    installed.display()
                ),
            );
            link(&home.join(".local/bin/mise"), &home.join(".local/share/mise/shims/codex"));
            for shell_name in shells() {
                let codex = checked(shell_name, &home).codex.expect("codex");
                assert_eq!((codex.method, codex.update_command.as_str()), (InstallMethod::Mise, "mise upgrade npm:@openai/codex"), "{shell_name}");
                assert_eq!(codex.version.as_deref(), Some("0.157.0"), "{shell_name}");
            }
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn updates_run_the_tool_that_installed_the_agent() {
            let home = temp_home("tools");
            let run = |script: String| run(&home, &home_only(&script));
            let echo = r#"printf '%s %s\n' "${0##*/}" "$*""#;
            // npm beside the Node that owns the install.
            let prefix = home.join(".nvm/versions/node/v24.1.0");
            fake(&prefix.join("bin/npm"), echo);
            let npm = run(update_script(AgentKind::Codex, &UpdatePlan::Npm { prefix: prefix.display().to_string() }));
            assert_eq!(
                update_result(&npm),
                Ok(format!("npm install -g --prefix {} --allow-scripts=@openai/codex @openai/codex@latest", prefix.display())),
            );
            fake(&home.join(".local/bin/brew"), echo);
            let brew = run(update_script(AgentKind::Codex, &UpdatePlan::Homebrew { cask: true, name: "codex".into() }));
            assert_eq!(update_result(&brew), Ok("brew upgrade --cask codex".into()));
            fake(&home.join(".local/bin/mise"), echo);
            let mise = run(update_script(AgentKind::Claude, &UpdatePlan::Mise { tool: "npm:@anthropic-ai/claude-code".into() }));
            assert_eq!(update_result(&mise), Ok("mise upgrade npm:@anthropic-ai/claude-code".into()));
            fake(&home.join(".bun/bin/bun"), echo);
            let bun = run(update_script(AgentKind::Codex, &UpdatePlan::Bun));
            assert_eq!(update_result(&bun), Ok("bun add -g @openai/codex@latest".into()));
            // pnpm finds its global directory from where the agent is.
            fake(&home.join("Library/pnpm/codex"), "exit 0");
            fake(&home.join("Library/pnpm/pnpm"), r#"printf 'PNPM_HOME=%s %s\n' "$PNPM_HOME" "$*""#);
            let pnpm = run(update_script(AgentKind::Codex, &UpdatePlan::Pnpm));
            assert_eq!(update_result(&pnpm), Ok(format!("PNPM_HOME={} add -g @openai/codex@latest", home.join("Library/pnpm").display())));
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn an_npm_install_updates_with_the_npm_that_owns_it() {
            let home = temp_home("update");
            let prefix = home.join(".local/share/fnm/node-versions/v24.13.0/installation");
            fake(&prefix.join("bin/npm"), "exit 0");
            let package = prefix.join("lib/node_modules/@openai/codex/bin/codex.js");
            fake(
                &package,
                r#"case "$1" in
  --help) printf 'Commands:\n  exec    Run Codex non-interactively\n  update  Update Codex to the latest version\n' ;;
  update) printf 'Updating with %s\n' "$(command -v npm)" ;;
esac"#,
            );
            fs::create_dir_all(home.join(".local/bin")).unwrap();
            std::os::unix::fs::symlink(&package, home.join(".local/bin/codex")).unwrap();

            let output = run(&home, &update_script(AgentKind::Codex, &UpdatePlan::SelfUpdate));
            let npm = fs::canonicalize(&prefix).unwrap().join("bin/npm");
            assert_eq!(update_result(&output), Ok(format!("Updating with {}", npm.display())));
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn a_failed_update_says_why() {
            let home = temp_home("failed-update");
            fake(
                &home.join(".local/bin/claude"),
                r#"case "$1" in
  --help) printf 'Commands:\n  update|upgrade  Check for updates and install if available\n'; exit 0 ;;
  update) ;;
  *) exit 0 ;;
esac
printf 'Current version: 2.1.270\n'
printf '\033[31mError: EACCES: permission denied, mkdir /usr/local/share/claude\033[0m\n' >&2
exit 1"#,
            );
            let output = run(&home, &update_script(AgentKind::Claude, &UpdatePlan::SelfUpdate));
            assert_eq!(
                update_result(&output),
                Err("Current version: 2.1.270\nError: EACCES: permission denied, mkdir /usr/local/share/claude".into()),
            );
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn an_agent_without_an_update_command_is_never_given_one() {
            let home = temp_home("no-update");
            let prompted = home.join("prompted");
            fake(
                &home.join(".local/bin/codex"),
                &format!(
                    r#"case "$1" in
  --help) printf 'Usage: codex [PROMPT]\n\nCommands:\n  exec  Run Codex non-interactively\n' ;;
  *) touch '{}' ;;
esac"#,
                    prompted.display()
                ),
            );
            let output = run(&home, &update_script(AgentKind::Codex, &UpdatePlan::SelfUpdate));
            assert_eq!(
                update_result(&output),
                Err("This version of codex has no update command. Update it the way it was installed.".into()),
            );
            assert!(!prompted.exists());
            let _ = fs::remove_dir_all(&home);
        }
    }
}

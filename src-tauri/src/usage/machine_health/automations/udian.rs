//! The background runner: ultradian ("udian"), a small scheduler daemon Arbor carries and installs on a machine, so an
//! automation set to run on the machine runs there when it's due whether Arbor is open or not.
//!
//! Arbor keeps the automation; udian keeps only its schedule. For each one Arbor writes a folder on the machine,
//! `~/.arbor/automations/<name>/`, with the prompt, the precheck and two scripts: `gate.sh`, which udian runs first and
//! which starts the agent only when the precheck exits 0, and `run.sh`, which starts the agent the way Arbor's own
//! runner does, its output going to /dev/null. Each run leaves its precheck's exit and the end of its output, the
//! session's id and the agent's exit in `~/.arbor/automation-runs/<udian run>/`, which Arbor reads with udian's own run
//! records and then takes away. udian keeps its own log of each run on the machine; Arbor never reads it.

use super::super::agents::AGENT_ENV;
use super::super::guarded_writes::STATE_FUNCTIONS;
use super::super::shell::{run_checked, shell_quote, Machine};
use super::runner::{agent_command_for, path_word, REMOVE_FOLDER};
use super::*;
use crate::usage::diagnostics::MachineOp;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Where udian lives on a machine. The daemon's service runs it from here, and an update replaces it in place.
const BIN: &str = "\"$HOME/.ultradian/bin/udian\"";
/// The group every schedule Arbor writes is in, so Arbor reads back only its own.
const GROUP: &str = "arbor";
/// Every schedule Arbor places starts with this, which is how its runs are told from the machine's others.
const SCHEDULE_PREFIX: &str = "arbor-";
const VERSION_FILE: &str = "udian-version.txt";
/// In the app's Resources, and in a checkout for a dev build.
const RESOURCES_FOLDER: &str = "udian";
const SOURCE_FOLDER: &str = "bundled-udian";
/// How much of a precheck's output is kept, as Arbor's own runner keeps.
const PRECHECK_KEPT: usize = 4 << 10;
/// How long one run may take in all before udian stops it.
const RUN_TIMEOUT: &str = "6h";
/// Run records asked of udian at a time, and the most pages one sync reads before carrying on from there next time.
const SYNC_PAGE: usize = 500;
const SYNC_PAGES: usize = 20;
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

// ── What Arbor carries ───────────────────────────────────────────────────────────────────────────────────────────

/// The udian release in this build: its version and the folder with each system's archive and their checksums.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Bundle {
    pub(super) version: String,
    dir: PathBuf,
}

fn bundle_in(version_file: &Path, dir: &Path) -> Option<Bundle> {
    let version = std::fs::read_to_string(version_file).ok()?.trim().trim_start_matches('v').to_string();
    (!version.is_empty() && dir.is_dir()).then(|| Bundle { version, dir: dir.to_path_buf() })
}

/// The release this build carries: the app's own Resources, or a checkout's `bundled-udian/` for a dev build.
pub(super) fn bundle() -> Option<Bundle> {
    let executable_dir = crate::core_runtime::executable_dir().ok()?;
    if let Some(resources) = crate::core_runtime::macos_app_resources_dir(&executable_dir) {
        if let Some(bundle) = bundle_in(&resources.join(VERSION_FILE), &resources.join(RESOURCES_FOLDER)) {
            return Some(bundle);
        }
    }
    let root = crate::core_runtime::source_project_root(&executable_dir)?;
    bundle_in(&root.join(VERSION_FILE), &root.join(SOURCE_FOLDER))
}

pub(super) fn asset_name(version: &str, target: &str) -> String {
    format!("ultradian-{version}-{target}.tar.gz")
}

/// The build a machine needs, from `uname -s` and `uname -m`; None for a system udian isn't built for.
pub(super) fn target_for(system: &str, arch: &str) -> Option<&'static str> {
    match (system.trim(), arch.trim()) {
        ("Darwin", "arm64" | "aarch64") => Some("darwin-arm64"),
        ("Darwin", "x86_64") => Some("darwin-x64"),
        ("Linux", "x86_64" | "amd64") => Some("linux-x64"),
        ("Linux", "aarch64" | "arm64") => Some("linux-arm64"),
        _ => None,
    }
}

/// One system's archive, read only when it matches the checksum the release lists for it.
pub(super) fn archive(bundle: &Bundle, target: &str) -> Result<Vec<u8>, String> {
    let name = asset_name(&bundle.version, target);
    let sums = std::fs::read_to_string(bundle.dir.join("SHA256SUMS")).map_err(|_| "This build of Arbor has no checksums for the background runner".to_string())?;
    let expected = sums
        .lines()
        .find_map(|line| {
            let (hash, file) = line.split_once(char::is_whitespace)?;
            (file.trim().trim_start_matches('*') == name).then(|| hash.trim().to_ascii_lowercase())
        })
        .ok_or_else(|| format!("This build of Arbor has no background runner for {target}"))?;
    let bytes = std::fs::read(bundle.dir.join(&name)).map_err(|_| format!("This build of Arbor has no background runner for {target}"))?;
    let actual: String = Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect();
    if actual != expected {
        return Err("The background runner Arbor carries doesn't match its checksum".into());
    }
    Ok(bytes)
}

// ── Looking ──────────────────────────────────────────────────────────────────────────────────────────────────────

// Part of each machine's automations scan. Lines out: `U system arch`, and when udian is installed, `V version` and
// `D live` (1 or 0) from its own answers, each base64 of the JSON.
pub(super) const PROBE_SCRIPT: &str = r##"printf 'U\t%s\t%s\n' "$(uname -s)" "$(uname -m)"
if [ -x "$HOME/.ultradian/bin/udian" ]; then
  printf 'V\t%s\n' "$("$HOME/.ultradian/bin/udian" version --json </dev/null 2>/dev/null | base64 | tr -d '\n')"
  printf 'D\t%s\n' "$("$HOME/.ultradian/bin/udian" status --json </dev/null 2>/dev/null | base64 | tr -d '\n')"
fi
"##;

fn json_line(value: &str) -> Option<serde_json::Value> {
    serde_json::from_slice(&STANDARD.decode(value.trim()).ok()?).ok()
}

/// The `data` of udian's JSON answer, which wraps it with its schema's version.
fn data(value: &serde_json::Value) -> &serde_json::Value {
    value.get("data").unwrap_or(value)
}

/// What the probe found, or None when the scan didn't get that far.
pub(super) fn parse_probe(stdout: &str) -> Option<UdianOnMachine> {
    let mut found: Option<UdianOnMachine> = None;
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["U", system, arch] => found = Some(UdianOnMachine { target: target_for(system, arch).map(str::to_string), version: None, live: false }),
            ["V", json] => {
                if let (Some(udian), Some(value)) = (found.as_mut(), json_line(json)) {
                    udian.version = data(&value).get("version").and_then(serde_json::Value::as_str).map(|version| version.trim_start_matches('v').to_string());
                }
            }
            ["D", json] => {
                if let (Some(udian), Some(value)) = (found.as_mut(), json_line(json)) {
                    let daemon = data(&value).get("daemon").unwrap_or(&serde_json::Value::Null);
                    udian.live = daemon.get("live").and_then(serde_json::Value::as_bool).unwrap_or(false);
                }
            }
            _ => {}
        }
    }
    found
}

/// The machine can run automations in the background now: udian is there and its daemon answered.
pub(super) fn ready(udian: Option<&UdianOnMachine>) -> bool {
    udian.is_some_and(|udian| udian.version.is_some() && udian.live)
}

// ── Installing ───────────────────────────────────────────────────────────────────────────────────────────────────

/// Puts udian on the machine, or replaces an older one, and has the machine start its daemon at login. The archive
/// goes in the script as base64; the new binary takes the old one's place in one rename, and the daemon restarts on it.
pub(super) fn install_script(archive: &[u8]) -> String {
    let encoded = STANDARD.encode(archive);
    let mut lines = String::with_capacity(encoded.len() + encoded.len() / 76 + 1024);
    for chunk in encoded.as_bytes().chunks(76) {
        lines.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        lines.push('\n');
    }
    format!(
        "set -e\n{STATE_FUNCTIONS}\
         bin=\"$HOME/.ultradian/bin\"\n\
         mkdir -p \"$bin\"\n\
         chmod 700 \"$HOME/.ultradian\" \"$bin\"\n\
         tmp=$(mktemp -d \"$bin/.install.XXXXXX\")\n\
         trap 'rm -rf \"$tmp\"' EXIT\n\
         unbase >\"$tmp/udian.tar.gz\" <<'ARBOR_UDIAN'\n{lines}ARBOR_UDIAN\n\
         tar -xzf \"$tmp/udian.tar.gz\" -C \"$tmp\"\n\
         chmod 755 \"$tmp/ultradian\"\n\
         \"$tmp/ultradian\" version --json </dev/null >/dev/null\n\
         mv -f \"$tmp/ultradian\" \"$bin/udian\"\n\
         {BIN} daemon install --json </dev/null >/dev/null\n\
         {BIN} daemon restart --json </dev/null >/dev/null\n\
         {BIN} version --json </dev/null\n"
    )
}

pub(super) async fn install(machine: &Machine, archive: &[u8]) -> Result<(), String> {
    run_checked(machine, MachineOp::RunnerInstall, &install_script(archive), INSTALL_TIMEOUT).await.map(|_| ())
}

// ── Schedules ────────────────────────────────────────────────────────────────────────────────────────────────────

/// The schedule's name in udian, and its folder's under `~/.arbor/automations`: `arbor-` and the id's letters.
pub(super) fn schedule_name(id: &str) -> String {
    let word: String = id.trim_start_matches("arbor:").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').map(|c| c.to_ascii_lowercase()).take(57).collect();
    format!("{SCHEDULE_PREFIX}{word}")
}

/// This Mac's time zone by its IANA name, which an automation's times are read in unless it names its own.
fn local_zone() -> Option<String> {
    let link = std::fs::read_link("/etc/localtime").ok()?;
    let text = link.to_string_lossy();
    text.split_once("zoneinfo/").map(|(_, zone)| zone.to_string()).filter(|zone| !zone.is_empty())
}

/// udian's trigger for an automation's schedule: a cron line in its time zone, or a plain interval for a number of
/// minutes or hours cron can't step by. None for a rule only Arbor's own runner can follow.
pub(super) fn trigger_args(input: &AutomationInput, zone: Option<&str>) -> Option<Vec<String>> {
    let cron = |line: String| {
        let mut args = vec!["--cron".to_string(), line];
        if let Some(zone) = input.timezone.as_deref().filter(|zone| !zone.is_empty()).or(zone) {
            args.extend(["--tz".to_string(), zone.to_string()]);
        }
        Some(args)
    };
    match schedule::summary(&input.rrule) {
        ScheduleSummary::EveryMinutes { minutes } if minutes > 0 && 60 % minutes == 0 => cron(format!("*/{minutes} * * * *")),
        ScheduleSummary::EveryMinutes { minutes } if minutes > 0 => Some(vec!["--every".into(), format!("{minutes}m")]),
        ScheduleSummary::EveryHours { hours: 1, minute } => cron(format!("{minute} * * * *")),
        ScheduleSummary::EveryHours { hours, minute } if hours > 0 && 24 % hours == 0 => cron(format!("{minute} */{hours} * * *")),
        ScheduleSummary::EveryHours { hours, .. } if hours > 0 => Some(vec!["--every".into(), format!("{hours}h")]),
        ScheduleSummary::Daily { hour, minute } => cron(format!("{minute} {hour} * * *")),
        ScheduleSummary::Weekdays { hour, minute } => cron(format!("{minute} {hour} * * 1-5")),
        ScheduleSummary::Weekly { days, hour, minute } if !days.is_empty() => {
            let days: Vec<String> = days.iter().map(u8::to_string).collect();
            cron(format!("{minute} {hour} * * {}", days.join(",")))
        }
        _ => None,
    }
}

/// Why an automation can't run on its machine in the background, if it can't.
pub(super) fn unplaceable(input: &AutomationInput) -> Option<&'static str> {
    if !matches!(input.target, AutomationTarget::Machine { .. }) {
        return Some("Only an automation on one machine can run there in the background; a pool's member is picked by Arbor when it's due");
    }
    if trigger_args(input, None).is_none() {
        return Some("The machine's background runner can't follow this schedule. Pick one of the usual schedules, or run it from Arbor");
    }
    None
}

/// The gate udian runs first: the precheck in the project's folder under its time limit. Its exit decides, and what
/// it printed is kept for the run, the end of it for the agent too.
fn gate_script(input: &AutomationInput) -> String {
    // The agents' folders go on PATH, as for every script Arbor runs: the service's own PATH may not have them.
    format!(
        "{AGENT_ENV}dir=\"$HOME/.arbor/automation-runs/$ULTRADIAN_RUN_ID\"\n\
         mkdir -p \"$dir\" && : >\"$dir/by-udian\"\n\
         cd {project} 2>/dev/null || {{ echo 127 >\"$dir/precheck.exit\"; exit 127; }}\n\
         sh \"$(dirname \"$0\")/precheck\" </dev/null >\"$dir/precheck.full\" 2>&1 &\n\
         check=$!\n\
         ( sleep {timeout}; kill \"$check\" 2>/dev/null ) </dev/null >/dev/null 2>&1 &\n\
         watchdog=$!\n\
         wait \"$check\"; code=$?\n\
         kill \"$watchdog\" 2>/dev/null\n\
         tail -c {PRECHECK_KEPT} \"$dir/precheck.full\" >\"$dir/precheck.out\"; rm -f \"$dir/precheck.full\"\n\
         echo \"$code\" >\"$dir/precheck.exit\"\n\
         exit \"$code\"\n",
        project = path_word(&input.project_path),
        timeout = input.precheck_timeout_secs.clamp(1, 3600),
    )
}

/// What udian runs when the gate lets it: the agent, as Arbor's own runner starts it, in the project or a new worktree
/// of it. A session to carry on comes from the last run's, which this script keeps beside it.
fn run_script(input: &AutomationInput) -> String {
    let mut script = format!(
        "{AGENT_ENV}here=$(cd \"$(dirname \"$0\")\" && pwd)\n\
         dir=\"$HOME/.arbor/automation-runs/$ULTRADIAN_RUN_ID\"\n\
         mkdir -p \"$dir\" && : >\"$dir/by-udian\"\n\
         ended() {{ echo \"$1\" >\"$dir/exit\"; exit \"$1\"; }}\n\
         work={project}\n\
         cd \"$work\" 2>/dev/null || ended 127\n",
        project = path_word(&input.project_path),
    );
    if input.workspace == AutomationWorkspace::NewWorktree {
        script.push_str(
            "wt=\"$HOME/.arbor/automation-worktrees/$(basename \"$here\")/$ULTRADIAN_RUN_ID\"\n\
             mkdir -p \"${wt%/*}\" && git worktree add --quiet --detach \"$wt\" HEAD </dev/null >/dev/null 2>&1 || ended 126\n\
             printf '%s' \"$wt\" >\"$dir/worktree\"\n\
             work=$wt\n\
             cd \"$work\" || ended 126\n",
        );
    }
    script.push_str(
        "cp \"$here/prompt\" \"$dir/prompt\" || ended 126\n\
         if [ -s \"$dir/precheck.out\" ]; then { printf '\\n\\nThe precheck found:\\n'; cat \"$dir/precheck.out\"; } >>\"$dir/prompt\"; fi\n\
         session=''\n",
    );
    if input.session == AutomationSession::Reuse {
        script.push_str("session=$(head -c 200 \"$here/session\" 2>/dev/null | head -n 1)\n");
    }
    let resumed = agent_command_for(input, Some("\"$session\""), true);
    let fresh = match input.agent {
        AutomationAgent::Claude => {
            script.push_str(
                "if [ -z \"$session\" ]; then new=$( (uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid) | tr 'A-Z' 'a-z'); fi\n",
            );
            agent_command_for(input, Some("\"$new\""), false)
        }
        _ => agent_command_for(input, None, false),
    };
    script.push_str(&format!(
        "if [ -n \"$session\" ]; then\n\
         \x20 printf '%s' \"$session\" >\"$dir/session\"\n\
         \x20 {resumed}\n\
         else\n\
         \x20 [ -n \"${{new:-}}\" ] && printf '%s' \"$new\" >\"$dir/session\"\n\
         \x20 {fresh}\n\
         fi\n\
         if [ -s \"$dir/session\" ]; then cp \"$dir/session\" \"$here/session\"; fi\n\
         code=$(head -c 20 \"$dir/code\" 2>/dev/null | tr -dc '0-9')\n\
         rm -f \"$dir/prompt\" \"$dir/code\"\n\
         ended \"${{code:-1}}\"\n"
    ));
    script
}

/// Writes an automation's folder on its machine and its schedule into udian: a new one, or the same name changed in
/// place so its run history stays. A paused automation's schedule is paused.
pub(super) fn place_script(id: &str, input: &AutomationInput, enabled: bool, zone: Option<&str>) -> Result<String, String> {
    let name = schedule_name(id);
    let trigger = trigger_args(input, zone).ok_or_else(|| unplaceable(input).unwrap_or_default().to_string())?;
    let file = |content: &str| shell_quote(&STANDARD.encode(content));
    let mut options: Vec<String> = trigger;
    options.extend(["--timeout".into(), RUN_TIMEOUT.into(), "--catch-up".into(), format!("{}m", input.grace_minutes)]);
    let has_precheck = input.precheck.as_deref().is_some_and(|precheck| !precheck.trim().is_empty());
    let options: String = options.iter().map(|option| format!(" {}", shell_quote(option))).collect();
    let gate = if has_precheck { " --gate \"sh \\\"$here/gate.sh\\\"\" --gate-mode exit".to_string() } else { " --no-gate".to_string() };
    let pause = if enabled { "resume" } else { "pause" };
    Ok(format!(
        "set -e\n{STATE_FUNCTIONS}\
         here=\"$HOME/.arbor/automations/\"{folder}\n\
         mkdir -p \"$here\"\n\
         printf '%s' {prompt} | unbase >\"$here/prompt\"\n\
         printf '%s' {precheck} | unbase >\"$here/precheck\"\n\
         printf '%s' {gate_file} | unbase >\"$here/gate.sh\"\n\
         printf '%s' {run_file} | unbase >\"$here/run.sh\"\n\
         if {BIN} list --json </dev/null | grep -q {quoted_name}; then\n\
         \x20 {BIN} set {name_word}{options}{gate} --cwd \"$here\" --json -- /bin/sh \"$here/run.sh\" </dev/null >/dev/null\n\
         else\n\
         \x20 {BIN} add {name_word}{options}{add_gate} --group {GROUP} --cwd \"$here\" --yes --json -- /bin/sh \"$here/run.sh\" </dev/null >/dev/null\n\
         fi\n\
         {BIN} {pause} {name_word} --json </dev/null >/dev/null\n",
        folder = shell_quote(&name),
        prompt = file(&input.prompt),
        precheck = file(input.precheck.as_deref().unwrap_or_default()),
        gate_file = file(&gate_script(input)),
        run_file = file(&run_script(input)),
        quoted_name = shell_quote(&format!("\"{name}\"")),
        name_word = shell_quote(&name),
        add_gate = if has_precheck { gate.as_str() } else { "" },
    ))
}

/// Takes an automation's schedule out of udian and its folder off the machine.
pub(super) fn remove_script(id: &str) -> String {
    let name = schedule_name(id);
    format!(
        "{REMOVE_FOLDER}if [ -x \"$HOME/.ultradian/bin/udian\" ]; then {BIN} rm {name} --yes --json </dev/null >/dev/null 2>&1 || true; fi\n\
         arbor_remove \"$HOME/.arbor/automations/\"{name}\n",
        name = shell_quote(&name)
    )
}

pub(super) fn run_now_script(id: &str) -> String {
    format!("{BIN} run {} --detach --json </dev/null\n", shell_quote(&schedule_name(id)))
}

pub(super) fn cancel_script(run_id: &str) -> String {
    format!("{BIN} cancel {} --json </dev/null >/dev/null\n", shell_quote(run_id))
}

pub(super) async fn call(machine: &Machine, script: &str) -> Result<String, String> {
    run_checked(machine, MachineOp::AutomationChange, script, CALL_TIMEOUT).await
}

pub(super) fn place_on(id: &str, input: &AutomationInput, enabled: bool) -> Result<String, String> {
    place_script(id, input, enabled, local_zone().as_deref())
}

/// What a placed automation looks like to the reconciler: a change to any of these means writing it again.
pub(super) fn fingerprint(machine: &str, input: &AutomationInput, enabled: bool) -> String {
    let text = format!("{machine}\n{enabled}\n{}", serde_json::to_string(input).unwrap_or_default());
    Sha256::digest(text.as_bytes()).iter().take(12).map(|byte| format!("{byte:02x}")).collect()
}

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// Lines out: a `J` line for each page of udian's run records as base64 JSON, then `F run precheck-exit exit session
// worktree precheck-output` for each run folder a udian run left. A folder whose run has ended goes once it's read.
// udian lists every run on the machine, oldest change first, so on a machine whose own schedules have years of runs
// one page would leave Arbor's far behind: pages follow each other until a short one, up to SYNC_PAGES of them.
pub(super) fn sync_script(since: Option<&str>) -> String {
    let since = since.map(shell_quote).unwrap_or_default();
    format!(
        "[ -x \"$HOME/.ultradian/bin/udian\" ] || exit 0\n{REMOVE_FOLDER}\
         c={since}\n\
         n=0\n\
         while [ \"$n\" -lt {SYNC_PAGES} ]; do\n\
         \x20 page=$({BIN} runs ${{c:+--since \"$c\"}} --limit {SYNC_PAGE} --json </dev/null 2>/dev/null) || break\n\
         \x20 printf 'J\\t%s\\n' \"$(printf '%s' \"$page\" | base64 | tr -d '\\n')\"\n\
         \x20 [ \"$(printf '%s' \"$page\" | grep -o '\"run_id\"' | wc -l | tr -d ' ')\" -ge {SYNC_PAGE} ] || break\n\
         \x20 next=$(printf '%s' \"$page\" | grep -o '\"cursor\": *\"[^\"]*\"' | head -n 1 | sed 's/.*\"\\([^\"]*\\)\"$/\\1/')\n\
         \x20 [ -n \"$next\" ] && [ \"$next\" != \"$c\" ] || break\n\
         \x20 c=$next; n=$((n + 1))\n\
         done\n\
         for d in \"$HOME/.arbor/automation-runs\"/*/; do\n\
         \x20 [ -f \"$d/by-udian\" ] || continue\n\
         \x20 id=$(basename \"$d\")\n\
         \x20 pe=$(head -c 20 \"$d/precheck.exit\" 2>/dev/null | tr -dc '0-9')\n\
         \x20 ex=$(head -c 20 \"$d/exit\" 2>/dev/null | tr -dc '0-9')\n\
         \x20 printf 'F\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"$id\" \"$pe\" \"$ex\" \"$(head -c 200 \"$d/session\" 2>/dev/null | head -n 1)\" \"$(head -c 1000 \"$d/worktree\" 2>/dev/null)\" \"$(tail -c {PRECHECK_KEPT} \"$d/precheck.out\" 2>/dev/null | base64 | tr -d '\\n')\"\n\
         \x20 if [ -n \"$ex\" ] || {{ [ -n \"$pe\" ] && [ \"$pe\" != 0 ]; }}; then\n\
         \x20   wt=$(cat \"$d/worktree\" 2>/dev/null)\n\
         \x20   if [ -n \"$wt\" ] && [ -d \"$wt\" ] && [ -z \"$(git -C \"$wt\" status --porcelain 2>/dev/null)\" ]; then git -C \"$wt\" worktree remove \"$wt\" </dev/null >/dev/null 2>&1; fi\n\
         \x20   arbor_remove \"$d\"\n\
         \x20 fi\n\
         done\n"
    )
}

/// What a run's folder said.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct RunFiles {
    precheck_exit: Option<i32>,
    exit: Option<i32>,
    session: Option<String>,
    precheck_output: Option<String>,
}

/// One of udian's run records, cut to what Arbor keeps.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct UdianRun {
    pub(super) id: String,
    pub(super) schedule: String,
    status: String,
    manual: bool,
    gate_exit: Option<i32>,
    action_exit: Option<i32>,
    started_at_ms: Option<i64>,
    finished_at_ms: Option<i64>,
}

/// A time as udian writes it: an RFC 3339 string, or a number of seconds or milliseconds.
fn time_ms(value: Option<&serde_json::Value>) -> Option<i64> {
    match value? {
        serde_json::Value::String(text) => chrono::DateTime::parse_from_rfc3339(text).ok().map(|time| time.timestamp_millis()),
        serde_json::Value::Number(number) => number.as_i64().map(|at| if at < 100_000_000_000 { at * 1000 } else { at }),
        _ => None,
    }
}

fn exit_code(value: Option<&serde_json::Value>) -> Option<i32> {
    value.and_then(serde_json::Value::as_i64).and_then(|code| i32::try_from(code).ok())
}

/// The run records and the files each run left, and the cursor to read on from next time.
pub(super) fn parse_sync(stdout: &str) -> (Vec<UdianRun>, BTreeMap<String, RunFiles>, Option<String>) {
    let (mut runs, mut files, mut cursor) = (Vec::new(), BTreeMap::new(), None);
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["J", json] => {
                let Some(value) = json_line(json) else { continue };
                let body = data(&value);
                cursor = body.get("cursor").and_then(|cursor| cursor.as_str().map(str::to_string).or_else(|| cursor.as_i64().map(|at| at.to_string())));
                let list = body.get("runs").or(Some(body)).and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
                for run in list {
                    let text = |key: &str| run.get(key).and_then(serde_json::Value::as_str).map(str::to_string);
                    let (Some(id), Some(schedule)) = (text("run_id"), text("schedule")) else { continue };
                    // udian lists every run on the machine; only Arbor's own schedules are Arbor's to read.
                    if !schedule.starts_with(SCHEDULE_PREFIX) {
                        continue;
                    }
                    let trigger = run.get("trigger").map(|trigger| trigger.get("kind").and_then(serde_json::Value::as_str).or(trigger.as_str()).unwrap_or_default().to_string()).unwrap_or_default();
                    // A run that changed between two pages is in both; the later page has its latest state.
                    runs.retain(|known: &UdianRun| known.id != id);
                    runs.push(UdianRun {
                        id,
                        schedule,
                        status: text("status").unwrap_or_default(),
                        manual: trigger == "manual" || trigger == "run",
                        gate_exit: exit_code(run.get("gate_exit")),
                        action_exit: exit_code(run.get("action_exit")),
                        started_at_ms: time_ms(run.get("started_at")),
                        finished_at_ms: time_ms(run.get("finished_at")),
                    });
                }
            }
            ["F", id, precheck_exit, exit, session, _worktree, output] => {
                let text = String::from_utf8_lossy(&STANDARD.decode(output.trim()).unwrap_or_default()).trim_end().to_string();
                files.insert(
                    id.to_string(),
                    RunFiles {
                        precheck_exit: precheck_exit.parse().ok(),
                        exit: exit.parse().ok(),
                        session: Some(session.trim().to_string()).filter(|session| !session.is_empty()),
                        precheck_output: (!text.is_empty()).then_some(text),
                    },
                );
            }
            _ => {}
        }
    }
    (runs, files, cursor)
}

/// A udian run as Arbor records it, over what Arbor had for it already: the files are read only once, as the folder
/// goes after an ended run is read.
pub(super) fn as_run(udian: &UdianRun, files: Option<&RunFiles>, automation_id: &str, machine: &str, known: Option<&AutomationRun>) -> AutomationRun {
    let mut run = known.cloned().unwrap_or_else(|| {
        let mut run = runner::new_run(automation_id, Some(machine.to_string()), udian.started_at_ms.unwrap_or_default(), udian.manual);
        run.id = udian.id.clone();
        run
    });
    run.started_at_ms = udian.started_at_ms.or(run.started_at_ms);
    run.finished_at_ms = udian.finished_at_ms.or(run.finished_at_ms);
    run.precheck_exit = files.and_then(|files| files.precheck_exit).or(udian.gate_exit).or(run.precheck_exit);
    if let Some(files) = files {
        run.precheck_output = files.precheck_output.clone().or(run.precheck_output);
        run.session_id = files.session.clone().or(run.session_id);
    }
    run.exit_code = udian.action_exit.or(files.and_then(|files| files.exit)).or(run.exit_code);
    let (status, error) = match udian.status.as_str() {
        "running" => (AutomationRunStatus::Running, None),
        "succeeded" => (AutomationRunStatus::Done, None),
        "clean" | "gate_failed" => (AutomationRunStatus::Skipped, None),
        "skipped" => (AutomationRunStatus::Skipped, Some("The last run was still going")),
        "missed" => (AutomationRunStatus::Missed, None),
        "canceled" | "cancelled" => (AutomationRunStatus::Canceled, None),
        "timed_out" => (AutomationRunStatus::Failed, Some("It ran past its time limit and was stopped")),
        "interrupted" => (AutomationRunStatus::Failed, Some("The machine's background runner stopped during the run")),
        _ => (AutomationRunStatus::Failed, None),
    };
    run.status = status;
    run.error = match (status, error) {
        (_, Some(error)) => Some(error.to_string()),
        (AutomationRunStatus::Failed, None) => Some(match run.exit_code {
            Some(code) => format!("The agent exited with {code}"),
            None => "The run failed".to_string(),
        }),
        _ => None,
    };
    run
}

// ── Keeping machines in step ─────────────────────────────────────────────────────────────────────────────────────

/// Why the last try to write a machine's schedules failed, by machine, while Arbor is open.
static PLACING_ERRORS: std::sync::Mutex<BTreeMap<String, String>> = std::sync::Mutex::new(BTreeMap::new());
/// When the machines were last asked for their runs.
static LAST_SYNC_MS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
/// How often runs are read back while none is known to be going.
const SYNC_EVERY_MS: i64 = 120_000;
const PLACED: &str = "placed:";
const SINCE: &str = "udian-since:";

pub(super) fn placing_errors() -> BTreeMap<String, String> {
    PLACING_ERRORS.lock().map(|errors| errors.clone()).unwrap_or_default()
}

/// The machine an automation is meant to run on in the background, if it is.
pub(super) fn wanted_machine(record: &store::Record) -> Option<&str> {
    match (&record.input.runs_on, &record.input.target) {
        (AutomationRunsOn::Machine, AutomationTarget::Machine { name }) => Some(name),
        _ => None,
    }
}

fn placed_value(machine: &str, fingerprint: &str) -> String {
    format!("{machine}\t{fingerprint}")
}

fn placed_machine(value: &str) -> &str {
    value.split('\t').next().unwrap_or_default()
}

fn machine_named(app: &tauri::AppHandle, name: &str) -> Result<Machine, String> {
    use tauri::Manager;
    super::super::shell::find_machine(&app.state::<MachineHealthState>().lock(), name)
}

/// Writes each automation meant to run on its machine whose schedule there isn't as saved, once the machine's
/// background runner is ready, and takes away the ones no longer meant to be there. Returns whether anything changed.
pub(super) async fn reconcile(app: &tauri::AppHandle) -> Result<bool, String> {
    let (records, placed, on) = run_usage_task(|| {
        let connection = open_usage_database()?;
        Ok((store::records(&connection)?, store::settings_with_prefix(&connection, PLACED)?, runner::running_on(&connection)?))
    })
    .await?;
    let placed: BTreeMap<String, String> = placed.into_iter().collect();
    let found = discover::found();
    let mut errors: BTreeMap<String, String> = BTreeMap::new();
    let mut changed = false;
    let mut wanted = BTreeSet::new();
    for record in &records {
        let Some(name) = wanted_machine(record) else { continue };
        wanted.insert(record.id.clone());
        // Settings' switch for all of Arbor's automations pauses the ones on machines too.
        let enabled = record.enabled && on;
        let value = placed_value(name, &fingerprint(name, &record.input, enabled));
        if placed.get(&record.id) == Some(&value) || !ready(found.get(name).and_then(|find| find.udian.as_ref())) {
            continue;
        }
        if let Some(before) = placed.get(&record.id).map(|value| placed_machine(value)).filter(|before| *before != name) {
            if let Ok(machine) = machine_named(app, before) {
                let _ = call(&machine, &remove_script(&record.id)).await;
            }
        }
        let result = match (machine_named(app, name), place_on(&record.id, &record.input, enabled)) {
            (Ok(machine), Ok(script)) => call(&machine, &script).await,
            (Err(error), _) | (_, Err(error)) => Err(error),
        };
        match result {
            Ok(_) => {
                let (id, value) = (record.id.clone(), value.clone());
                run_usage_task(move || store::set_setting(&open_usage_database()?, &format!("{PLACED}{id}"), &value)).await?;
                changed = true;
            }
            Err(error) => {
                errors.insert(name.to_string(), error.lines().last().unwrap_or_default().chars().take(300).collect());
            }
        }
    }
    for (id, value) in placed.iter().filter(|(id, _)| !wanted.contains(*id)) {
        let Ok(machine) = machine_named(app, placed_machine(value)) else { continue };
        if call(&machine, &remove_script(id)).await.is_ok() {
            let id = id.clone();
            run_usage_task(move || store::remove_setting(&open_usage_database()?, &format!("{PLACED}{id}"))).await?;
            changed = true;
        }
    }
    if let Ok(mut kept) = PLACING_ERRORS.lock() {
        changed |= *kept != errors;
        *kept = errors;
    }
    Ok(changed)
}

/// Reads back the runs of every machine Arbor placed automations on, when it's time or `now` says so.
pub(super) async fn sync(app: &tauri::AppHandle, now: bool) -> Result<bool, String> {
    let now_ms = Local::now().timestamp_millis();
    let (records, placed, going) = run_usage_task(|| {
        let connection = open_usage_database()?;
        let records = store::records(&connection)?;
        let machine_ids: BTreeSet<String> = records.iter().filter(|record| wanted_machine(record).is_some()).map(|record| record.id.clone()).collect();
        let going = store::running(&connection)?.iter().any(|stored| machine_ids.contains(&stored.run.automation_id));
        Ok((records, store::settings_with_prefix(&connection, PLACED)?, going))
    })
    .await?;
    if !now && !going && now_ms - LAST_SYNC_MS.load(std::sync::atomic::Ordering::Relaxed) < SYNC_EVERY_MS {
        return Ok(false);
    }
    LAST_SYNC_MS.store(now_ms, std::sync::atomic::Ordering::Relaxed);
    let by_name: BTreeMap<String, String> = records.iter().map(|record| (schedule_name(&record.id), record.id.clone())).collect();
    let machines: BTreeSet<String> = placed.iter().map(|(_, value)| placed_machine(value).to_string()).collect();
    let mut changed = false;
    for name in machines {
        let Ok(machine) = machine_named(app, &name) else { continue };
        let key = format!("{SINCE}{name}");
        let since = run_usage_task({
            let key = key.clone();
            move || store::setting(&open_usage_database()?, &key)
        })
        .await?;
        // A machine that doesn't answer is asked again next time; its runs carry on there regardless.
        let Ok(stdout) = run_checked(&machine, MachineOp::AutomationPoll, &sync_script(since.as_deref()), CALL_TIMEOUT).await else { continue };
        let (runs, files, cursor) = parse_sync(&stdout);
        let by_name = by_name.clone();
        let machine_name = name.clone();
        changed |= run_usage_task(move || {
            let connection = open_usage_database()?;
            let _guard = lock_usage_writes();
            let mut changed = false;
            for udian in &runs {
                let Some(automation_id) = by_name.get(&udian.schedule) else { continue };
                let known = store::run(&connection, &udian.id)?;
                let run = as_run(udian, files.get(&udian.id), automation_id, &machine_name, known.as_ref().map(|stored| &stored.run));
                if known.as_ref().map(|stored| &stored.run) != Some(&run) {
                    store::write_run(&connection, &store::StoredRun { run, worktree: None })?;
                    store::prune_runs(&connection, automation_id)?;
                    changed = true;
                }
            }
            if let Some(cursor) = cursor {
                store::set_setting(&connection, &key, &cursor)?;
            }
            Ok(changed)
        })
        .await?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> AutomationInput {
        AutomationInput {
            id: None,
            name: "Sentry watch".into(),
            prompt: "Fix what's new.".into(),
            agent: AutomationAgent::Claude,
            model: None,
            effort: None,
            target: AutomationTarget::Machine { name: "cedar-02".into() },
            project_path: "~/code/billing".into(),
            workspace: AutomationWorkspace::Checkout,
            session: AutomationSession::Fresh,
            access: AutomationAccess::Edits,
            runs_on: AutomationRunsOn::Machine,
            rrule: "FREQ=HOURLY;BYMINUTE=15".into(),
            timezone: None,
            grace_minutes: 20,
            precheck: Some("test -s inbox".into()),
            precheck_timeout_secs: 60,
            enabled: true,
        }
    }

    #[test]
    fn names_each_system_s_build_and_only_those() {
        assert_eq!(target_for("Darwin", "arm64"), Some("darwin-arm64"));
        assert_eq!(target_for("Linux", "aarch64"), Some("linux-arm64"));
        assert_eq!(target_for("Linux", "x86_64\n"), Some("linux-x64"));
        assert_eq!(target_for("FreeBSD", "amd64"), None);
        assert_eq!(asset_name("1.0.0", "darwin-x64"), "ultradian-1.0.0-darwin-x64.tar.gz");
    }

    #[test]
    fn turns_the_usual_schedules_into_udian_triggers() {
        let mut item = input();
        assert_eq!(trigger_args(&item, Some("Australia/Melbourne")).unwrap(), ["--cron", "15 * * * *", "--tz", "Australia/Melbourne"]);
        item.timezone = Some("Europe/Berlin".into());
        item.rrule = "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=30".into();
        assert_eq!(trigger_args(&item, Some("Australia/Melbourne")).unwrap(), ["--cron", "30 9 * * 1,3", "--tz", "Europe/Berlin"]);
        item.rrule = "FREQ=MINUTELY;INTERVAL=45".into();
        assert_eq!(trigger_args(&item, None).unwrap(), ["--every", "45m"]);
        item.rrule = "FREQ=MINUTELY;INTERVAL=15".into();
        assert_eq!(trigger_args(&item, None).unwrap(), ["--cron", "*/15 * * * *", "--tz", "Europe/Berlin"]);
        item.rrule = "FREQ=MONTHLY;BYMONTHDAY=1".into();
        assert_eq!(trigger_args(&item, None), None);
        assert!(unplaceable(&item).is_some());
        let mut pooled = input();
        pooled.target = AutomationTarget::Pool { id: "builds".into() };
        assert!(unplaceable(&pooled).is_some());
        assert_eq!(unplaceable(&input()), None);
    }

    #[test]
    fn reads_what_the_probe_found() {
        let b64 = |text: &str| STANDARD.encode(text);
        let stdout = format!(
            "U\tDarwin\tarm64\nV\t{}\nD\t{}\n",
            b64(r#"{"schemaVersion":2,"data":{"version":"1.0.0"}}"#),
            b64(r#"{"schemaVersion":2,"data":{"daemon":{"live":true,"pid":42}}}"#)
        );
        let found = parse_probe(&stdout).unwrap();
        assert_eq!(found, UdianOnMachine { target: Some("darwin-arm64".into()), version: Some("1.0.0".into()), live: true });
        assert!(ready(Some(&found)));
        let missing = parse_probe("U\tLinux\tx86_64\n").unwrap();
        assert_eq!(missing.version, None);
        assert!(!ready(Some(&missing)));
        assert_eq!(parse_probe(""), None);
    }

    #[test]
    fn names_schedules_from_the_id() {
        assert_eq!(schedule_name("arbor:Ab_c-9"), "arbor-abc-9");
    }

    #[test]
    fn maps_udian_runs_and_their_files_onto_arbor_runs() {
        let b64 = |text: &str| STANDARD.encode(text);
        let runs = r#"{"schemaVersion":2,"data":{"cursor":"c-7","runs":[
            {"run_id":"r1","schedule":"arbor-a","status":"succeeded","trigger":{"kind":"cron"},"gate_exit":0,"action_exit":0,"started_at":"2026-10-02T01:00:00Z","finished_at":"2026-10-02T01:05:00Z"},
            {"run_id":"r2","schedule":"arbor-a","status":"gate_failed","trigger":{"kind":"cron"},"gate_exit":1,"started_at":1790900000000},
            {"run_id":"r3","schedule":"arbor-a","status":"timed_out","trigger":{"kind":"manual"},"gate_exit":0}]}}"#;
        let stdout = format!("J\t{}\nF\tr1\t0\t0\tsess-1\t\t{}\n", b64(runs), b64("3 new issues\n"));
        let (runs, files, cursor) = parse_sync(&stdout);
        assert_eq!(cursor.as_deref(), Some("c-7"));
        assert_eq!(runs.len(), 3);
        let done = as_run(&runs[0], files.get("r1"), "arbor:a", "cedar-02", None);
        assert_eq!(done.id, "r1");
        assert_eq!(done.status, AutomationRunStatus::Done);
        assert_eq!(done.session_id.as_deref(), Some("sess-1"));
        assert_eq!(done.precheck_output.as_deref(), Some("3 new issues"));
        assert_eq!(done.machine.as_deref(), Some("cedar-02"));
        assert_eq!(done.finished_at_ms.zip(done.started_at_ms).map(|(end, start)| end - start), Some(300_000));
        let skipped = as_run(&runs[1], None, "arbor:a", "cedar-02", None);
        assert_eq!((skipped.status, skipped.precheck_exit, skipped.started_at_ms), (AutomationRunStatus::Skipped, Some(1), Some(1_790_900_000_000)));
        let timed = as_run(&runs[2], None, "arbor:a", "cedar-02", None);
        assert_eq!(timed.status, AutomationRunStatus::Failed);
        assert!(timed.manual);
        assert!(timed.error.unwrap().contains("time limit"));
        // A later read without the folder keeps what the first read took from it.
        let again = as_run(&runs[0], None, "arbor:a", "cedar-02", Some(&done));
        assert_eq!(again.session_id.as_deref(), Some("sess-1"));
    }

    #[test]
    fn a_placed_automation_gates_runs_and_is_read_back_under_sh() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let home = std::env::temp_dir().join(format!("arbor-udian-{}-{}", std::process::id(), runner::new_uuid()));
        let (project, bin, udian_bin) = (home.join("code/billing"), home.join(".local/bin"), home.join(".ultradian/bin"));
        for dir in [&project, &bin, &udian_bin] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let executable = |path: &std::path::Path, text: &str| {
            std::fs::write(path, text).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        // The agent reads its prompt and exits 0; udian only notes what it's asked and answers `runs`.
        executable(&bin.join("claude"), "#!/bin/sh\ncat >\"$HOME/prompt-seen\"\nprintf '%s' \"$*\" >\"$HOME/args-seen\"\nexit 0\n");
        executable(
            &udian_bin.join("udian"),
            // It refuses the options the real one refuses, per command, so a call udian would reject fails here too.
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >>\"$HOME/udian-calls\"\n\
             case \" $* \" in\n\
             \x20 *' --yes '*) case $1 in add|rm) ;; *) echo \"unknown option '--yes'\" >&2; exit 2 ;; esac ;;\n\
             esac\n\
             case $1 in list|runs|run|cancel|set) case \" $* \" in *' --group '*) [ \"$1\" = set ] || { echo \"unknown option '--group'\" >&2; exit 2; } ;; esac ;; esac\n\
             case $1 in\n list) echo '{\"data\":[]}' ;;\n runs) echo '{\"data\":{\"cursor\":\"c1\",\"runs\":[{\"run_id\":\"r1\",\"schedule\":\"arbor-a\",\"status\":\"succeeded\",\"action_exit\":0},{\"run_id\":\"x9\",\"schedule\":\"backup\",\"status\":\"succeeded\",\"action_exit\":0}]}}' ;;\nesac\n",
        );
        let sh = |script: &str, run: Option<&str>| {
            let mut command = std::process::Command::new("sh");
            command.env("HOME", &home).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
            if let Some(run) = run {
                command.env("ULTRADIAN_RUN_ID", run);
            }
            let mut child = command.spawn().unwrap();
            child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
            let output = child.wait_with_output().unwrap();
            (output.status.code(), String::from_utf8_lossy(&output.stdout).into_owned())
        };
        let mut item = input();
        item.precheck = Some("echo 3 new issues".into());
        let (code, _) = sh(&place_script("arbor:a", &item, true, None).unwrap(), None);
        assert_eq!(code, Some(0));
        let calls = std::fs::read_to_string(home.join("udian-calls")).unwrap();
        assert!(calls.contains("add arbor-a --cron 15 * * * * --timeout 6h --catch-up 20m --gate sh \""), "{calls}");
        assert!(calls.contains("--gate-mode exit --group arbor --cwd"), "{calls}");
        assert!(calls.contains("resume arbor-a"), "{calls}");
        let folder = home.join(".arbor/automations/arbor-a");
        let gate = format!("sh {}", folder.join("gate.sh").display());
        let run = format!("sh {}", folder.join("run.sh").display());
        assert_eq!(sh(&gate, Some("r1")).0, Some(0));
        assert_eq!(sh(&run, Some("r1")).0, Some(0));
        let prompt = std::fs::read_to_string(home.join("prompt-seen")).unwrap();
        assert!(prompt.starts_with("Fix what's new.") && prompt.contains("The precheck found:\n3 new issues"), "{prompt}");
        let args = std::fs::read_to_string(home.join("args-seen")).unwrap();
        assert!(args.contains("--session-id ") && args.contains("--permission-mode acceptEdits"), "{args}");
        let (runs, files, cursor) = parse_sync(&sh(&sync_script(None), None).1);
        assert_eq!(cursor.as_deref(), Some("c1"));
        let files = files.get("r1").unwrap();
        assert_eq!((files.precheck_exit, files.exit), (Some(0), Some(0)));
        assert_eq!(files.session.as_ref().map(String::len), Some(36));
        assert_eq!(runs.len(), 1, "the machine's own schedules aren't Arbor's");
        assert_eq!(runs[0].schedule, "arbor-a");
        assert_eq!(sh(&run_now_script("arbor:a"), None).0, Some(0));
        assert_eq!(sh(&cancel_script("r1"), None).0, Some(0));
        assert!(!home.join(".arbor/automation-runs/r1").exists(), "an ended run's folder goes once read");
        // A precheck that fails stops there: no agent, and the folder goes once read.
        std::fs::remove_file(home.join("prompt-seen")).unwrap();
        item.precheck = Some("exit 4".into());
        sh(&place_script("arbor:a", &item, true, None).unwrap(), None);
        assert_eq!(sh(&gate, Some("r2")).0, Some(4));
        let (_, files, _) = parse_sync(&sh(&sync_script(Some("c1")), None).1);
        assert_eq!(files.get("r2").and_then(|files| files.precheck_exit), Some(4));
        assert!(!home.join("prompt-seen").exists());
        assert!(!home.join(".arbor/automation-runs/r2").exists());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_sync_pages_past_the_machine_s_own_runs_to_arbor_s() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let home = std::env::temp_dir().join(format!("arbor-udian-pages-{}-{}", std::process::id(), runner::new_uuid()));
        let udian_bin = home.join(".ultradian/bin");
        std::fs::create_dir_all(&udian_bin).unwrap();
        // A full first page of the machine's own runs, then a short one with Arbor's, which also changed r1.
        std::fs::write(
            udian_bin.join("udian"),
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >>\"$HOME/udian-calls\"\n\
                 case \" $* \" in\n\
                 \x20 *' --since c2 '*) echo '{{\"data\":{{\"cursor\":\"c3\",\"runs\":[{{\"run_id\":\"r1\",\"schedule\":\"arbor-a\",\"status\":\"succeeded\"}},{{\"run_id\":\"r9\",\"schedule\":\"arbor-b\",\"status\":\"clean\"}}]}}}}' ;;\n\
                 \x20 *) awk 'BEGIN {{ printf \"{{\\n  \\\"data\\\": {{\\n    \\\"cursor\\\": \\\"c2\\\",\\n    \\\"runs\\\": [\\n\"; \
                 for (i = 1; i <= {SYNC_PAGE}; i++) printf \"%s      {{ \\\"run_id\\\": \\\"%s\\\", \\\"schedule\\\": \\\"%s\\\", \\\"status\\\": \\\"running\\\" }}\\n\", \
                 (i > 1 ? \",\" : \"\"), (i == 1 ? \"r1\" : \"x\" i), (i == 1 ? \"arbor-a\" : \"backup\"); print \"    ]\\n  }}\\n}}\" }}' ;;\n\
                 esac\n"
            ),
        )
        .unwrap();
        std::fs::set_permissions(udian_bin.join("udian"), std::fs::Permissions::from_mode(0o755)).unwrap();
        for shell in ["sh", "dash"] {
            let _ = std::fs::remove_file(home.join("udian-calls"));
            let Ok(mut child) = std::process::Command::new(shell).env("HOME", &home).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn() else { continue };
            child.stdin.take().unwrap().write_all(sync_script(None).as_bytes()).unwrap();
            let stdout = String::from_utf8_lossy(&child.wait_with_output().unwrap().stdout).into_owned();
            let (runs, _, cursor) = parse_sync(&stdout);
            assert_eq!(cursor.as_deref(), Some("c3"), "{shell}");
            let states: Vec<(&str, &str)> = runs.iter().map(|run| (run.id.as_str(), run.status.as_str())).collect();
            assert_eq!(states, [("r1", "succeeded"), ("r9", "clean")], "{shell}");
            let calls = std::fs::read_to_string(home.join("udian-calls")).unwrap();
            assert_eq!(calls.lines().collect::<Vec<_>>(), ["runs --limit 500 --json", "runs --since c2 --limit 500 --json"], "{shell}");
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_placed_scripts_start_the_agent_only_after_the_gate() {
        let script = place_script("arbor:a", &input(), true, Some("Australia/Melbourne")).unwrap();
        assert!(script.contains("--gate-mode exit"));
        assert!(script.contains("'--cron' '15 * * * *' '--tz' 'Australia/Melbourne'"));
        assert!(script.contains("--catch-up' '20m'"));
        assert!(script.contains(" resume 'arbor-a'"));
        let run = run_script(&input());
        assert!(run.contains("claude -p --session-id \"$new\""));
        assert!(run.contains(">/dev/null 2>&1"));
        let mut paused = input();
        paused.precheck = None;
        assert!(place_script("arbor:a", &paused, false, None).unwrap().contains(" pause 'arbor-a'"));
    }

    /// The checkout's pinned release, as `scripts/build-release.sh` fetches it into `bundled-udian/`: every system's
    /// archive is there, matches its checksum and holds the version udian-version.txt names. Ignored because it needs
    /// that fetch first.
    #[test]
    #[ignore]
    fn the_pinned_release_is_bundled_for_every_system() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let bundle = bundle_in(&root.join(VERSION_FILE), &root.join(SOURCE_FOLDER)).expect("udian-version.txt names a release");
        for target in ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] {
            let bytes = archive(&bundle, target).unwrap();
            let mut tar = std::process::Command::new("tar").args(["-tzf", "-"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
            std::io::Write::write_all(&mut tar.stdin.take().unwrap(), &bytes).unwrap();
            let listing = String::from_utf8(tar.wait_with_output().unwrap().stdout).unwrap();
            assert_eq!(listing.trim(), "ultradian", "{target}");
        }
    }

    /// The same round trip against a real ultradian build, with its daemon: place, run now, read back, remove. It's
    /// ignored because it needs that build, named by ARBOR_UDIAN_BIN; run it before pinning a version in
    /// udian-version.txt. Everything happens under a temporary HOME, and the daemon it starts is stopped at the end.
    #[test]
    #[ignore]
    fn a_real_udian_runs_what_arbor_places() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let Ok(binary) = std::env::var("ARBOR_UDIAN_BIN") else { panic!("set ARBOR_UDIAN_BIN to an ultradian build") };
        let home = std::env::temp_dir().join(format!("arbor-real-udian-{}-{}", std::process::id(), runner::new_uuid()));
        assert!(home.starts_with(std::env::temp_dir()));
        let (project, bin, udian_bin) = (home.join("code/billing"), home.join(".local/bin"), home.join(".ultradian/bin"));
        for dir in [&project, &bin, &udian_bin] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::copy(&binary, udian_bin.join("udian")).unwrap();
        std::fs::write(bin.join("claude"), "#!/bin/sh\ncat >\"$HOME/prompt-seen\"\nexit 0\n").unwrap();
        std::fs::set_permissions(bin.join("claude"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let sh = |script: &str| {
            let mut child = std::process::Command::new("sh")
                .env("HOME", &home)
                .env("ULTRADIAN_HOME", home.join(".ultradian"))
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
            let output = child.wait_with_output().unwrap();
            (output.status.code(), String::from_utf8_lossy(&output.stdout).into_owned(), String::from_utf8_lossy(&output.stderr).into_owned())
        };
        let finish = |home: &std::path::Path| {
            let _ = sh(&format!("{BIN} daemon stop --json"));
            let _ = std::fs::remove_dir_all(home);
        };
        let probe = parse_probe(&sh(PROBE_SCRIPT).1).unwrap();
        assert!(probe.version.is_some() && !probe.live, "{probe:?}");
        let (code, _, err) = sh(&format!("{BIN} daemon start --json"));
        assert_eq!(code, Some(0), "{err}");
        let mut item = input();
        item.project_path = project.display().to_string();
        item.precheck = Some("echo 3 new issues".into());
        let (code, _, err) = sh(&place_script("arbor:a", &item, true, None).unwrap());
        assert_eq!(code, Some(0), "placing: {err}");
        // Placing again edits the schedule in place.
        let (code, _, err) = sh(&place_script("arbor:a", &item, false, None).unwrap());
        assert_eq!(code, Some(0), "placing again: {err}");
        let (code, _, err) = sh(&place_script("arbor:a", &item, true, None).unwrap());
        assert_eq!(code, Some(0), "resuming: {err}");
        let (code, out, err) = sh(&run_now_script("arbor:a"));
        assert_eq!(code, Some(0), "run now: {err}");
        assert!(out.contains("\"run_id\""), "{out}");
        let mut seen = None;
        for _ in 0..120 {
            let (runs, files, _) = parse_sync(&sh(&sync_script(None)).1);
            if let Some(run) = runs.iter().find(|run| run.status == "succeeded") {
                seen = Some((run.clone(), files.get(&run.id).cloned()));
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        let Some((run, files)) = seen else {
            finish(&home);
            panic!("the run never finished");
        };
        assert_eq!(run.schedule, "arbor-a");
        assert!(run.manual);
        let files = files.expect("the run's folder was read");
        assert_eq!((files.precheck_exit, files.exit), (Some(0), Some(0)));
        let prompt = std::fs::read_to_string(home.join("prompt-seen")).unwrap_or_default();
        assert!(prompt.contains("The precheck found:\n3 new issues"), "{prompt}");
        let (code, _, err) = sh(&remove_script("arbor:a"));
        assert_eq!(code, Some(0), "removing: {err}");
        assert!(!home.join(".arbor/automations/arbor-a").exists());
        finish(&home);
    }
}

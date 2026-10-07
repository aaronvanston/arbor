//! Taking things off a machine: agent homes nobody uses, the agents installed there, startup items whose program is
//! gone, and the logs and caches the harnesses keep (`harnesses::CLEARABLE`).
//!
//! One read-only scan, run when the machine page's Clean up section opens or on Refresh and never on a timer, lists
//! them with their sizes and times. It sends back names, paths, sizes and times only: each folder's listing (names,
//! sizes, times) is fingerprinted on the machine, and nothing reads what a file says, apart from the one path a
//! startup item names as its program.
//!
//! Removing one moves it aside, never deletes it. Each removal is a folder of its own, `~/.arbor/set-aside/<stamp>/`,
//! with a manifest and the items in `items/<n>`. An item on another drive than the home folder is set aside in
//! `.arbor-set-aside/<stamp>/` at that drive's top, so the move is a rename and nothing is copied. The set-aside area
//! is apart from `~/.arbor/setup-backups`, which keeps only its newest changes: nothing set aside is ever removed
//! except by the user's Delete for good. A small pointer in setup-backups, with the same stamp, lists the removal on
//! Sync › Repo › History beside Arbor's other changes; pruning it only takes it off that list.
//!
//! Each item is moved only while it's as the scan found it (its fingerprint), and put back only while its place is
//! free and its set-aside copy unchanged. Removing a home also turns it to Ignored in the agent homes list, and
//! putting it back puts its role back.
//!
//! A home Arbor reads sessions from also says how many of its session files the archive holds safely
//! (`archive::standing`). It can still be set aside when some aren't, once the user says so: they stay on the
//! machine, in the set-aside area, until deleted for good.

use super::agent_homes::{self, AgentHome, AgentHomeKind, AgentHomeRole, AgentHomeSource};
use super::agent_install::{method_from_paths, InstallMethod};
use super::agents::{parse_version, AgentKind, AGENT_ENV};
use super::archive::{self, standing::HomeCounts, ArchiveCondition};
use super::guarded_writes::{is_stamp, new_stamp, prune_backups, stamp_ms, SyncFailure, SyncOutcome};
use super::harnesses::{self, ClearableKind, Harness};
use super::setup::{HELPERS, INSTALLS_SCRIPT};
use super::shell::shell_quote;
use super::*;
use crate::command_error::CommandError;
use std::collections::{BTreeSet, HashMap};

const SCAN_TIMEOUT: Duration = Duration::from_secs(150);
/// How long the scan spends measuring, after which what's left is listed unmeasured.
const MEASURE_BUDGET_S: u32 = 100;
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// Moving checks every item's fingerprint again first, which reads each folder's listing.
const MOVE_TIMEOUT: Duration = Duration::from_secs(180);
const DELETE_TIMEOUT: Duration = Duration::from_secs(300);

// ---------------------------------------------------------------------------
// What the scan finds
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CleanupGroup {
    Home,
    Cache,
    Leftover,
}

impl CleanupGroup {
    fn name(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Cache => "cache",
            Self::Leftover => "leftover",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        [Self::Home, Self::Cache, Self::Leftover].into_iter().find(|group| group.name() == value)
    }
}

/// Why an item has no Remove.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CleanupHold {
    /// The scan ran out of time before measuring it.
    Unmeasured,
    /// Outside the machine's home folder, which the clean-up never touches.
    OutsideHome,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupHome {
    /// From ~ when it's in the home folder.
    pub(crate) path: String,
    pub(crate) agent: AgentHomeKind,
    pub(crate) harness: Harness,
    pub(crate) role: AgentHomeRole,
    #[ts(type = "number | null")]
    pub(crate) size_kb: Option<u64>,
    /// When anything in it was last written.
    #[ts(type = "number | null")]
    pub(crate) newest_ms: Option<i64>,
    /// When a session file in it was last written.
    #[ts(type = "number | null")]
    pub(crate) last_session_ms: Option<i64>,
    /// How many session files it holds, once measured.
    pub(crate) session_files: Option<u32>,
    /// The harness's command is on the machine.
    pub(crate) installed: bool,
    /// The app folder it sits in, by that folder's name, for a home an app keeps.
    pub(crate) inside: Option<String>,
    /// For a home whose own agent's sessions Arbor doesn't read from it, the sessions folder the catalog says it
    /// keeps, when it's there.
    pub(crate) own_sessions: Option<String>,
    /// That sessions folder is a home on the list Arbor reads and archives, which removing this one takes along.
    pub(crate) own_sessions_archived: bool,
    pub(crate) held: Option<CleanupHold>,
    /// For a home Arbor reads sessions from, how much of them the archive holds safely.
    pub(crate) archive: Option<HomeArchive>,
    #[serde(skip)]
    abs: String,
    #[serde(skip)]
    print: Option<String>,
    /// The agent homes list's path for it: the home's own, or the folder for one a pattern found.
    #[serde(skip)]
    list_path: String,
}

/// Why none of a home's sessions count as archived.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ArchiveBlock {
    /// No session archive is set up.
    Off,
    Paused,
    /// The archive's drive isn't connected.
    MainMissing,
    /// The archive's folder holds another archive, or isn't one.
    Foreign,
    /// The archive doesn't keep this machine's sessions.
    NotKept,
    /// The archive's index couldn't be read.
    Unreadable,
}

/// A home's sessions as the archive has them, from the clean-up's count of its session files and the archive's index.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HomeArchive {
    /// Session files in the home, as the scan counted them.
    pub(crate) sessions: u32,
    /// Of those, the ones not safely in a store: not listed yet, still growing, skipped, unreachable, or everything
    /// while `blocked`.
    pub(crate) not_archived: u32,
    pub(crate) blocked: Option<ArchiveBlock>,
    /// When the machine's last complete archive pass started.
    #[ts(type = "number | null")]
    pub(crate) last_pass_ms: Option<i64>,
    /// A session file was written after that pass started, so it may not be archived as it is now.
    pub(crate) newer_than_pass: bool,
}

impl HomeArchive {
    pub(crate) fn all_archived(&self) -> bool {
        self.blocked.is_none() && self.not_archived == 0 && !self.newer_than_pass
    }
}

/// A home's standing from what the archive says and what the scan counted: `sessions` session files, the newest
/// written at `last_session_ms`.
fn home_archive(condition: Result<(ArchiveCondition, bool, HomeCounts), ()>, sessions: u32, last_session_ms: Option<i64>) -> HomeArchive {
    let blocked = |block| HomeArchive { sessions, not_archived: sessions, blocked: Some(block), last_pass_ms: None, newer_than_pass: false };
    let (condition, kept, counts) = match condition {
        Ok(found) => found,
        Err(()) => return blocked(ArchiveBlock::Unreadable),
    };
    let block = match condition {
        ArchiveCondition::Off => Some(ArchiveBlock::Off),
        ArchiveCondition::Paused => Some(ArchiveBlock::Paused),
        ArchiveCondition::MainMissing => Some(ArchiveBlock::MainMissing),
        ArchiveCondition::Foreign => Some(ArchiveBlock::Foreign),
        ArchiveCondition::Ok | ArchiveCondition::CatchingUp | ArchiveCondition::Error if !kept => Some(ArchiveBlock::NotKept),
        ArchiveCondition::Ok | ArchiveCondition::CatchingUp | ArchiveCondition::Error => None,
    };
    if let Some(block) = block {
        return HomeArchive { last_pass_ms: counts.last_pass_ms, ..blocked(block) };
    }
    let unsafe_known = counts.known.saturating_sub(counts.safe);
    let unseen = u64::from(sessions).saturating_sub(counts.known);
    let newer_than_pass = sessions > 0 && match (last_session_ms, counts.last_pass_ms) {
        (Some(written), Some(pass)) => written > pass,
        (_, None) => true,
        (None, Some(_)) => false,
    };
    HomeArchive {
        sessions,
        not_archived: u32::try_from((unsafe_known + unseen).min(u64::from(sessions))).unwrap_or(sessions),
        blocked: None,
        last_pass_ms: counts.last_pass_ms,
        newer_than_pass,
    }
}

/// Fills in the archive standing of each home Arbor reads sessions from.
async fn add_standings(app: &tauri::AppHandle, target: &Machine, scan: &mut CleanupScan) {
    let roots: Vec<String> = scan.homes.iter().filter(|home| home.agent.reads_sessions()).map(|home| home.abs.clone()).collect();
    if roots.is_empty() {
        return;
    }
    let found = archive::home_standings(app, target.name(), target.is_local(), roots.clone()).await;
    for home in scan.homes.iter_mut().filter(|home| home.agent.reads_sessions()) {
        let at = roots.iter().position(|root| *root == home.abs);
        let counts = match (&found, at) {
            (Ok((condition, kept, counts)), Some(at)) => counts.get(at).map(|counts| (*condition, *kept, *counts)).ok_or(()),
            _ => Err(()),
        };
        home.archive = Some(home_archive(counts, home.session_files.unwrap_or(0), home.last_session_ms));
    }
    holders_take_standing(scan);
}

/// A home holding a sessions folder Arbor archives (Pi's own folder holds Pi's sessions) takes that folder's standing,
/// since setting it aside sets them aside too.
fn holders_take_standing(scan: &mut CleanupScan) {
    let standings: Vec<(String, HomeArchive)> = scan.homes.iter().filter_map(|home| home.archive.clone().map(|archive| (home.path.clone(), archive))).collect();
    for home in scan.homes.iter_mut().filter(|home| home.archive.is_none() && home.own_sessions_archived) {
        home.archive = standings.iter().find(|(path, _)| Some(path) == home.own_sessions.as_ref()).map(|(_, archive)| archive.clone());
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupAgent {
    pub(crate) harness: Harness,
    /// Its command, from ~ when it's in the home folder.
    pub(crate) path: String,
    /// What the command leads to, when that's somewhere else.
    pub(crate) real: Option<String>,
    pub(crate) version: Option<String>,
    /// How its paths say it was installed. Shown only: nothing is run on this word.
    pub(crate) method: InstallMethod,
    /// The first of its harness on the PATH, the one that runs.
    pub(crate) first: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LeftoverKind {
    /// A macOS launch agent in ~/Library/LaunchAgents.
    LaunchAgent,
    /// A systemd user service in ~/.config/systemd/user.
    SystemdUnit,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupLeftover {
    pub(crate) kind: LeftoverKind,
    /// Its file's name without the extension: the launch agent's label or the unit's name, as a rule.
    pub(crate) name: String,
    pub(crate) path: String,
    /// The program it starts, which isn't there.
    pub(crate) program: String,
    #[ts(type = "number | null")]
    pub(crate) size_kb: Option<u64>,
    #[ts(type = "number | null")]
    pub(crate) newest_ms: Option<i64>,
    pub(crate) held: Option<CleanupHold>,
    #[serde(skip)]
    abs: String,
    #[serde(skip)]
    print: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupCache {
    pub(crate) harness: Harness,
    pub(crate) kind: ClearableKind,
    pub(crate) path: String,
    /// The agent home it's in, if any.
    pub(crate) home: Option<String>,
    #[ts(type = "number | null")]
    pub(crate) size_kb: Option<u64>,
    #[ts(type = "number | null")]
    pub(crate) newest_ms: Option<i64>,
    pub(crate) held: Option<CleanupHold>,
    #[serde(skip)]
    abs: String,
    #[serde(skip)]
    print: Option<String>,
}

/// Something set aside on the machine, waiting to be put back or deleted for good.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetAsideItem {
    /// The removal it was part of.
    pub(crate) stamp: String,
    pub(crate) item: u32,
    pub(crate) group: CleanupGroup,
    /// Where it was, and goes back to.
    pub(crate) path: String,
    #[ts(type = "number")]
    pub(crate) at_ms: i64,
    #[ts(type = "number | null")]
    pub(crate) size_kb: Option<u64>,
    /// The top of the drive it's kept on (from ~ when it's in the home folder), when that isn't the home folder's.
    pub(crate) volume: Option<String>,
    /// Something is at its place now, so it can't go back.
    pub(crate) taken: bool,
    #[serde(skip)]
    from: String,
    #[serde(skip)]
    aside: String,
    #[serde(skip)]
    print: String,
}

/// What putting a removed home back restores in the agent homes list.
#[derive(Clone, Debug, PartialEq)]
struct RoleNote {
    stamp: String,
    item: u32,
    agent: AgentHomeKind,
    path: String,
    /// The home saved for this machine alone before, which goes back as it was; none to take the one Arbor added off.
    before: Option<(bool, bool, bool, AgentHomeSource)>,
}

/// A machine's clean-up: what the last scan found, and what's set aside there now.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupScan {
    pub(crate) machine: String,
    /// When the groups were read; none when only what's set aside was.
    #[ts(type = "number | null")]
    pub(crate) scanned_at_ms: Option<i64>,
    pub(crate) homes: Vec<CleanupHome>,
    pub(crate) agents: Vec<CleanupAgent>,
    pub(crate) leftovers: Vec<CleanupLeftover>,
    pub(crate) caches: Vec<CleanupCache>,
    pub(crate) aside: Vec<SetAsideItem>,
    /// The scan ran out of time before measuring everything.
    pub(crate) partial: bool,
    #[serde(skip)]
    home_dir: String,
    #[serde(skip)]
    roles: Vec<RoleNote>,
}

/// One thing to remove, as the scan lists it.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupTarget {
    pub(crate) group: CleanupGroup,
    pub(crate) path: String,
}

/// One thing set aside.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetAsideRef {
    pub(crate) stamp: String,
    pub(crate) item: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupRemoval {
    /// The removal's stamp, which Undo puts back by.
    pub(crate) stamp: Option<String>,
    pub(crate) removed: Vec<String>,
    /// Paths that couldn't be moved; the rest were.
    pub(crate) failed: Vec<String>,
    pub(crate) scan: CleanupScan,
}

/// Why something set aside couldn't go back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RestoreProblem {
    /// Something is at its place now.
    Taken,
    /// The set-aside copy isn't as it was set aside.
    Changed,
    /// It isn't set aside any more.
    Gone,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreFailure {
    pub(crate) path: String,
    pub(crate) problem: RestoreProblem,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupRestore {
    pub(crate) restored: Vec<String>,
    pub(crate) failed: Vec<RestoreFailure>,
    pub(crate) scan: CleanupScan,
}

// ---------------------------------------------------------------------------
// The shell side
// ---------------------------------------------------------------------------

// Every clean-up script starts with these, after setup's HELPERS (for `sum_in`):
//   there p       something is at p, a link to nothing included
//   devof p       the device p is on, without following a link
//   listing p f   p's listing into f: a line for everything in a folder (type and mode, time, size, name from the
//                 folder), sorted; for a file, the same line without its name. Never what a file says.
//   print_of p    p's fingerprint: - for nothing, L and where a link leads, D or F and the sum of its listing
//   facts f       from a listing: kilobytes, the newest file's time, the newest .jsonl's and how many there are
//   list_aside [s] each item set aside (in removal s only): `A stamp n group from aside print kb taken`, and the
//                 agent homes roles each removal noted, `R stamp n agent path existed sessions sync chosen source`
//   tidy s        when nothing of removal s is set aside any more, takes away its folders (and says 0)
const COMMON: &str = r##"tab=$(printf '\t')
work=$(mktemp -d "${TMPDIR:-/tmp}/arbor-cleanup.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT
printf 'H\t%s\n' "$HOME"
there() { [ -e "$1" ] || [ -L "$1" ]; }
if stat -c %d / >/dev/null 2>&1; then sflag=-c; slist='%A %Y %s %n'; sone='%A %Y %s'
else sflag=-f; slist='%Sp %m %z %N'; sone='%Sp %m %z'; fi
devof() { stat "$sflag" %d "$1" 2>/dev/null; }
listing() {
  if [ -d "$1" ]; then
    ( cd "$1" 2>/dev/null && find . -mindepth 1 -print0 2>/dev/null | xargs -0 stat "$sflag" "$slist" 2>/dev/null ) | LC_ALL=C sort > "$2"
  else
    stat "$sflag" "$sone" "$1" > "$2" 2>/dev/null
  fi
}
print_of() {
  if [ -L "$1" ]; then printf 'L%s' "$(readlink "$1" | tr -d '\t\n')"
  elif [ -d "$1" ]; then listing "$1" "$work/print"; printf 'D%s' "$(sum_in < "$work/print")"
  elif [ -f "$1" ]; then listing "$1" "$work/print"; printf 'F%s' "$(sum_in < "$work/print")"
  elif there "$1"; then printf '?'
  else printf -
  fi
}
facts() {
  awk '
    substr($1, 1, 1) == "-" {
      size += $3
      if ($2 + 0 > newest) newest = $2 + 0
      if ($0 ~ /\.jsonl$/) { count++; if ($2 + 0 > sess) sess = $2 + 0 }
    }
    END {
      kb = int((size + 1023) / 1024)
      printf "%.0f\t%s\t%s\t%d", kb, (newest ? sprintf("%.0f", newest) : "-"), (sess ? sprintf("%.0f", sess) : "-"), count
    }' "$1"
}
list_aside() {
  for m in "$HOME"/.arbor/set-aside/*/manifest; do
    [ -f "$m" ] || continue
    s=${m%/manifest}; s=${s##*/}
    if [ -n "${1:-}" ] && [ "$s" != "$1" ]; then continue; fi
    while IFS=$tab read -r tag n group from aside print kb rest; do
      [ "$tag" = M ] || continue
      there "$aside" || continue
      if there "$from"; then taken=1; else taken=0; fi
      printf 'A\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$s" "$n" "$group" "$from" "$aside" "$print" "$kb" "$taken"
    done < "$m"
    grep "^R$tab" "$m" | while IFS= read -r line; do printf 'R\t%s\t%s\n' "$s" "${line#R"$tab"}"; done
  done
}
tidy() {
  m="$HOME/.arbor/set-aside/$1/manifest"
  [ -f "$m" ] || return 1
  left=0
  while IFS=$tab read -r tag n group from aside rest; do
    [ "$tag" = M ] || continue
    if there "$aside"; then left=1; else d=${aside%/*}; rmdir "$d" "${d%/*}" "${d%/*/*}" 2>/dev/null; fi
  done < "$m"
  [ "$left" = 0 ] || return 1
  rm -f "$m"
  rmdir "$HOME/.arbor/set-aside/$1/items" "$HOME/.arbor/set-aside/$1" 2>/dev/null
  return 0
}
"##;

// Follows COMMON. Lines out, besides COMMON's:
//   G n agent folder          a home on the list (its index in the list the script was made from)
//   C harness kind folder     a folder a harness keeps that it can do without (`harnesses::CLEARABLE`)
//   S folder sessions         a home's own sessions folder, where the catalog knows one Arbor doesn't read there
//   O kind file program       a startup item whose program isn't there: launchd or systemd
//   B agent path real version an agent's command along the PATH (setup's INSTALLS_SCRIPT)
//   Z path kb newest last-session sessions print    a measured item
//   Q                         the measuring ran out of time here
// Each item found is queued for measuring with a priority: leftovers and caches first, then homes Arbor reads no
// sessions from, then the rest.
const FIND_FUNCTIONS: &str = r##": > "$work/todo"
todo() { printf '%s\t%s\n' "$1" "$2" >> "$work/todo"; }
plain() { case "$1" in *"$tab"*|*'
'*) return 1 ;; esac; return 0; }
c_at() {
  if [ -d "$3" ] && [ ! -L "$3" ] && plain "$3"; then printf 'C\t%s\t%s\t%s\n' "$1" "$2" "$3"; todo 1 "$3"; fi
}
leftover() {
  case "$3" in /*) ;; *) return 0 ;; esac
  # A program on a drive that isn't plugged in now isn't gone.
  case "$3" in /Volumes/*|/media/*|/mnt/*|/run/media/*) return 0 ;; esac
  plain "$2" && plain "$3" || return 0
  if ! there "$3"; then printf 'O\t%s\t%s\t%s\n' "$1" "$2" "$3"; todo 0 "$2"; fi
}
find_leftovers() {
  d="$HOME/Library/LaunchAgents"
  if [ -d "$d" ]; then
    for f in "$d"/*.plist; do
      [ -f "$f" ] || continue
      p=
      if command -v plutil >/dev/null 2>&1; then
        p=$(plutil -extract Program raw -o - "$f" 2>/dev/null) || p=$(plutil -extract ProgramArguments.0 raw -o - "$f" 2>/dev/null) || p=
      fi
      if [ -z "$p" ] && [ -x /usr/libexec/PlistBuddy ]; then
        p=$(/usr/libexec/PlistBuddy -c 'Print :Program' "$f" 2>/dev/null) || p=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$f" 2>/dev/null) || p=
      fi
      leftover launchd "$f" "$p"
    done
  fi
  d="$HOME/.config/systemd/user"
  if [ -d "$d" ]; then
    for f in "$d"/*.service; do
      [ -f "$f" ] || continue
      # Only the program ExecStart names: its first word, without systemd's prefixes or quotes.
      p=$(sed -n 's/^[[:space:]]*ExecStart[[:space:]]*=[[:space:]]*//p' "$f" | head -n 1 | awk '{ print $1 }' | sed -e 's/^[-@:+!]*//' -e 's/^"//' -e 's/"$//')
      case "$p" in %h/*) p="$HOME/${p#%h/}" ;; *'%'*|*'$'*) continue ;; esac
      leftover systemd "$f" "$p"
    done
  fi
}
measure() {
  p=$1
  if [ -L "$p" ]; then printf 'Z\t%s\t0\t-\t-\t0\t%s\n' "$p" "$(print_of "$p")"; return 0; fi
  there "$p" || return 0
  listing "$p" "$work/list"
  if [ -d "$p" ]; then mark=D; else mark=F; fi
  printf 'Z\t%s\t%s\t%s%s\n' "$p" "$(facts "$work/list")" "$mark" "$(sum_in < "$work/list")"
}
measure_all() {
  start=$(date +%s)
  LC_ALL=C sort -s -t "$tab" -k1,1n "$work/todo" | cut -f2- | awk '!seen[$0]++' > "$work/order"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ $(( $(date +%s) - start )) -ge "$budget" ]; then printf 'Q\n'; break; fi
    measure "$p"
  done < "$work/order"
}
"##;

/// The scan of `homes`, the machine's agent homes as the list has them.
fn scan_script(homes: &[AgentHome]) -> String {
    let mut script = String::from("set -u\nexport LC_ALL=C\nrenice -n 10 $$ >/dev/null 2>&1\ncommand -v ionice >/dev/null 2>&1 && ionice -c 3 -p $$ >/dev/null 2>&1\n");
    script.push_str(agent_homes::helpers());
    script.push_str(HELPERS);
    script.push_str(COMMON);
    script.push_str(FIND_FUNCTIONS);
    script.push_str(&format!("budget={MEASURE_BUDGET_S}\n"));
    // Which folders each kind of home keeps that the clean-up can clear, and how soon each kind is measured.
    script.push_str("caches_in() {\n  case \"$1\" in\n");
    for spec in harnesses::CATALOG {
        let Some(kind) = spec.home_kind else { continue };
        let calls: Vec<String> = harnesses::clearable(spec.harness)
            .iter()
            .filter(|folder| !folder.path.starts_with("~/") && !folder.path.starts_with('/'))
            .map(|folder| format!("c_at {} {} \"$2/{}\"", spec.id, kind_name(folder.kind), folder.path))
            .collect();
        if !calls.is_empty() {
            script.push_str(&format!("    {}) {} ;;\n", kind.shell_name(), calls.join("; ")));
        }
    }
    script.push_str("  esac\n}\nown_sessions() {\n  case \"$1\" in\n");
    for (kind, rel) in own_sessions_folders() {
        script.push_str(&format!(
            "    {}) if [ -d \"$2/{rel}\" ] && plain \"$2/{rel}\"; then printf 'S\\t%s\\t%s\\n' \"$2\" \"$2/{rel}\"; fi ;;\n",
            kind.shell_name()
        ));
    }
    script.push_str("  esac\n}\nprio_of() {\n  case \"$1\" in\n");
    let sessions: Vec<&str> = homes.iter().filter(|home| home.agent.reads_sessions()).map(|home| home.agent.shell_name()).collect::<BTreeSet<_>>().into_iter().collect();
    if !sessions.is_empty() {
        script.push_str(&format!("    {}) printf 3 ;;\n", sessions.join("|")));
    }
    script.push_str("    *) printf 2 ;;\n  esac\n}\n");
    for (index, home) in homes.iter().enumerate() {
        let Some(words) = agent_homes::shell_words(&home.path) else { continue };
        let matched = u8::from(home.path.contains('*'));
        script.push_str(&format!(
            "for dir in {words}; do home_line {} \"$dir\" {matched}; done | while IFS=$tab read -r agent folder; do\n\
             \x20 plain \"$folder\" || continue\n\
             \x20 printf 'G\\t%s\\t%s\\t%s\\n' {index} \"$agent\" \"$folder\"; todo \"$(prio_of \"$agent\")\" \"$folder\"; caches_in \"$agent\" \"$folder\"; own_sessions \"$agent\" \"$folder\"\n\
             done\n",
            home.agent.shell_name()
        ));
    }
    for spec in harnesses::CATALOG {
        for folder in harnesses::clearable(spec.harness) {
            if let Some(rel) = folder.path.strip_prefix("~/") {
                script.push_str(&format!("c_at {} {} \"$HOME/\"{}\n", spec.id, kind_name(folder.kind), shell_quote(rel)));
            }
        }
    }
    script.push_str("find_leftovers\n");
    script.push_str(&harnesses::installs_script());
    script.push_str(INSTALLS_SCRIPT);
    script.push_str(&format!("(\n{AGENT_ENV}emit_installs \"$PATH\"\n)\n"));
    script.push_str("list_aside\nmeasure_all\n");
    script
}

/// The sessions folder, from the home, of each kind of home whose agent keeps its sessions inside it but where Arbor
/// doesn't read them as that home: from the catalog, so a harness with no known sessions folder has none.
fn own_sessions_folders() -> Vec<(AgentHomeKind, &'static str)> {
    harnesses::CATALOG
        .iter()
        .filter_map(|spec| {
            let kind = spec.home_kind.filter(|kind| !kind.reads_sessions())?;
            let rel = spec.sessions?.default.strip_prefix(spec.home)?.strip_prefix('/')?;
            (!rel.is_empty()).then_some((kind, rel))
        })
        .collect()
}

fn kind_name(kind: ClearableKind) -> &'static str {
    match kind {
        ClearableKind::Logs => "logs",
        ClearableKind::Cache => "cache",
    }
}

/// An item to move aside, as the removal script takes it.
#[derive(Clone, Debug, PartialEq)]
struct Planned {
    group: CleanupGroup,
    abs: String,
    print: String,
    size_kb: u64,
}

// Follows COMMON, with `stamp` set. `where n path` sets `dest` to where item n goes: in the home folder's set-aside
// area when it's on the home folder's drive, or in `.arbor-set-aside` at the top of its own drive, so the move is a
// rename. It says `X n unwritable top` when that can't be made, and `X n mounted` for a drive of its own.
const MOVE_FUNCTIONS: &str = r##"changed=0
check() { if [ "$(print_of "$2")" != "$3" ]; then printf 'X\t%s\tchanged\n' "$1"; changed=1; fi; }
base="$HOME/.arbor/set-aside/$stamp"
where() {
  dest=
  parent=${2%/*}; [ -n "$parent" ] || parent=/
  idev=$(devof "$2"); pdev=$(devof "$parent")
  if [ -z "$idev" ] || [ "$idev" != "$pdev" ]; then printf 'X\t%s\tmounted\n' "$1"; changed=1; return 0; fi
  if [ "$pdev" = "$home_dev" ]; then dest="$base/items/$1"; return 0; fi
  top=$parent
  while [ "$top" != / ]; do
    up=${top%/*}; [ -n "$up" ] || up=/
    [ "$(devof "$up")" = "$pdev" ] || break
    top=$up
  done
  r="${top%/}/.arbor-set-aside/$stamp"
  if (umask 077 && mkdir -p "$r/items") 2>/dev/null && [ "$(devof "$r/items")" = "$pdev" ]; then
    printf '%s\n' "$r" >> "$work/made"; dest="$r/items/$1"; return 0
  fi
  printf 'X\t%s\tunwritable\t%s\n' "$1" "$top"; changed=1
}
undo_made() {
  rmdir "$base/items" "$base" 2>/dev/null
  if [ -f "$work/made" ]; then while IFS= read -r r; do rmdir "$r/items" "$r" "${r%/*}" 2>/dev/null; done < "$work/made"; fi
}
move() { if mv "$2" "$3"; then printf 'D\t%s\n' "$1"; else printf 'X\t%s\tfailed\n' "$1"; fi; }
"##;

/// Moves `items` aside as removal `stamp`, all or none: each is checked against the scan's fingerprint first and
/// given a place on its own drive, then the removal is written down (with `roles`, the agent homes list's entries it
/// changes) and listed among Arbor's changes before anything moves. Lines out: `X n why` for one refused, `K stamp`
/// once it's written down, `D n` for each moved, then what's set aside.
fn remove_script(stamp: &str, items: &[Planned], roles: &[RoleNote]) -> String {
    let mut script = format!("set -u\nexport LC_ALL=C\n{HELPERS}{COMMON}stamp={}\n{MOVE_FUNCTIONS}", shell_quote(stamp));
    for (n, item) in items.iter().enumerate() {
        script.push_str(&format!("check {n} {} {}\n", shell_quote(&item.abs), shell_quote(&item.print)));
    }
    script.push_str(
        "[ \"$changed\" = 0 ] || exit 0\n\
         home_dev=$(devof \"$HOME\")\n\
         if ! (umask 077 && mkdir -p \"$base/items\") || ! chmod 700 \"$HOME/.arbor/set-aside\"; then\n\
         \x20 echo \"Arbor couldn't make a folder to set things aside in ~/.arbor, so it moved nothing\" >&2; exit 5\n\
         fi\n",
    );
    for n in 0..items.len() {
        script.push_str(&format!("where {n} {}; d{n}=$dest\n", shell_quote(&items[n].abs)));
    }
    script.push_str("if [ \"$changed\" != 0 ]; then undo_made; exit 0; fi\n");
    // The manifest, then the pointer that lists it among Arbor's changes; nothing moves unless both are written.
    let mut manifest = String::from("{\n  printf 'what\\tcleanup\\n'\n");
    let mut pointer = String::from("{\n  printf 'what\\tcleanup\\n'\n");
    for (n, item) in items.iter().enumerate() {
        manifest.push_str(&format!(
            "  printf 'M\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' {n} {} {} \"$d{n}\" {} {}\n",
            item.group.name(),
            shell_quote(&item.abs),
            shell_quote(&item.print),
            item.size_kb
        ));
        pointer.push_str(&format!("  printf 'C\\t%s\\t%s\\t%s\\n' {n} {} \"$d{n}\"\n", shell_quote(&item.abs)));
    }
    for role in roles {
        let line = role_line(role);
        manifest.push_str(&format!("  printf '%s\\n' {}\n", shell_quote(&line)));
    }
    manifest.push_str("} > \"$base/manifest\"");
    pointer.push_str("} > \"$root/$stamp/manifest\"");
    script.push_str(&format!(
        "if ! {manifest}; then echo \"Arbor couldn't write down what it sets aside, so it moved nothing\" >&2; rm -f \"$base/manifest\"; undo_made; exit 5; fi\n\
         root=\"$HOME/.arbor/setup-backups\"\n\
         if ! (umask 077 && mkdir -p \"$root/$stamp\") || ! chmod 700 \"$root\" || ! {pointer}; then\n\
         \x20 echo \"Arbor couldn't list the change among its changes, so it moved nothing\" >&2; rm -rf \"$root/$stamp\"; rm -f \"$base/manifest\"; undo_made; exit 5\n\
         fi\n\
         printf 'K\\t%s\\n' \"$stamp\"\n"
    ));
    for (n, item) in items.iter().enumerate() {
        script.push_str(&format!("move {n} {} \"$d{n}\"\n", shell_quote(&item.abs)));
    }
    script.push_str(&prune_backups());
    script.push_str("list_aside\n");
    script
}

fn source_name(source: AgentHomeSource) -> &'static str {
    match source {
        AgentHomeSource::Standard => "standard",
        AgentHomeSource::Found => "found",
        AgentHomeSource::Added => "added",
    }
}

fn source_named(value: &str) -> Option<AgentHomeSource> {
    match value {
        "standard" => Some(AgentHomeSource::Standard),
        "found" => Some(AgentHomeSource::Found),
        "added" => Some(AgentHomeSource::Added),
        _ => None,
    }
}

/// A role note as the manifest has it: `R n agent path existed sessions sync chosen source`.
fn role_line(role: &RoleNote) -> String {
    let flag = |value: bool| if value { "1" } else { "0" };
    let (existed, sessions, sync, chosen, source) = match role.before {
        Some((sessions, sync, chosen, source)) => ("1", flag(sessions), flag(sync), flag(chosen), source_name(source)),
        None => ("0", "0", "0", "0", "added"),
    };
    format!("R\t{}\t{}\t{}\t{existed}\t{sessions}\t{sync}\t{chosen}\t{source}", role.item, role.agent.shell_name(), role.path)
}

// Follows COMMON. `back s n from aside print` puts item n of removal s back, only while its place is free and the
// set-aside copy is as it was set aside: `B s n`, or `X s n why` (taken, changed, gone or failed).
const RESTORE_FUNCTIONS: &str = r##"back() {
  if ! there "$4"; then printf 'X\t%s\t%s\tgone\n' "$1" "$2"; return 0; fi
  if there "$3"; then printf 'X\t%s\t%s\ttaken\n' "$1" "$2"; return 0; fi
  if [ "$(print_of "$4")" != "$5" ]; then printf 'X\t%s\t%s\tchanged\n' "$1" "$2"; return 0; fi
  if mkdir -p "${3%/*}" && mv "$4" "$3"; then printf 'B\t%s\t%s\n' "$1" "$2"; else printf 'X\t%s\t%s\tfailed\n' "$1" "$2"; fi
}
finish() {
  if tidy "$1"; then
    p="$HOME/.arbor/setup-backups/$1"
    if [ -f "$p/manifest" ]; then date +%s > "$p/undone"; fi
  fi
}
"##;

fn restore_script(items: &[SetAsideItem]) -> String {
    let mut script = format!("set -u\nexport LC_ALL=C\n{HELPERS}{COMMON}{RESTORE_FUNCTIONS}");
    let mut stamps = BTreeSet::new();
    for item in items {
        script.push_str(&format!(
            "back {} {} {} {} {}\n",
            shell_quote(&item.stamp),
            item.item,
            shell_quote(&item.from),
            shell_quote(&item.aside),
            shell_quote(&item.print)
        ));
        stamps.insert(item.stamp.clone());
    }
    for stamp in stamps {
        script.push_str(&format!("finish {}\n", shell_quote(&stamp)));
    }
    script.push_str("list_aside\n");
    script
}

// Follows COMMON. `del s n aside` deletes item n of removal s for good, only when `aside` is that item's place in a
// set-aside area and the removal's manifest names it there: `G s n`, or `X s n refused|failed`.
const DELETE_FUNCTIONS: &str = r##"del() {
  case "$3" in *'/../'*|*'/./'*|*'/..'|*'/.') printf 'X\t%s\t%s\trefused\n' "$1" "$2"; return 0 ;; esac
  case "$3" in
    "$HOME/.arbor/set-aside/$1/items/$2"|/*/.arbor-set-aside/"$1"/items/"$2") ;;
    *) printf 'X\t%s\t%s\trefused\n' "$1" "$2"; return 0 ;;
  esac
  awk -F'\t' -v n="$2" -v a="$3" '$1 == "M" && $2 == n && $5 == a { f = 1 } END { exit !f }' "$HOME/.arbor/set-aside/$1/manifest" 2>/dev/null \
    || { printf 'X\t%s\t%s\trefused\n' "$1" "$2"; return 0; }
  if rm -rf "$3" && ! there "$3"; then
    printf 'G\t%s\t%s\n' "$1" "$2"
    # Arbor's changes note it, so the removal's Undo there no longer offers it.
    p="$HOME/.arbor/setup-backups/$1/manifest"
    if [ -f "$p" ]; then printf 'Y\t%s\t%s\n' "$2" "$(date +%s)" >> "$p"; fi
  else printf 'X\t%s\t%s\tfailed\n' "$1" "$2"; fi
}
"##;

fn delete_script(items: &[SetAsideItem]) -> String {
    let mut script = format!("set -u\nexport LC_ALL=C\n{HELPERS}{COMMON}{DELETE_FUNCTIONS}");
    let mut stamps = BTreeSet::new();
    for item in items {
        script.push_str(&format!("del {} {} {}\n", shell_quote(&item.stamp), item.item, shell_quote(&item.aside)));
        stamps.insert(item.stamp.clone());
    }
    for stamp in stamps {
        script.push_str(&format!("tidy {} || :\n", shell_quote(&stamp)));
    }
    script.push_str("list_aside\n");
    script
}

// ---------------------------------------------------------------------------
// Reading what the scripts print
// ---------------------------------------------------------------------------

/// A whole path with nothing in it that could lead out of where it says.
fn whole(path: &str) -> bool {
    path.starts_with('/') && path.len() > 1 && !path.split('/').any(|part| part == "." || part == "..") && !path.chars().any(char::is_control)
}

/// Inside the home folder, and not Arbor's own folder or anything holding it.
fn in_home(path: &str, home: &str) -> bool {
    let home = home.trim_end_matches('/');
    !home.is_empty()
        && whole(path)
        && path.strip_prefix(home).is_some_and(|rest| rest.starts_with('/') && rest.len() > 1)
        && !within(path, &format!("{home}/.arbor"))
        && !path.contains("/.arbor-set-aside/")
}

/// `path` is `folder` or inside it.
fn within(path: &str, folder: &str) -> bool {
    path.strip_prefix(folder).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

fn seconds_ms(value: &str) -> Option<i64> {
    value.parse::<i64>().ok().filter(|seconds| *seconds > 0).map(|seconds| seconds * 1000)
}

/// What a `Z` line measured.
#[derive(Clone, Debug, Default, PartialEq)]
struct Measured {
    size_kb: u64,
    newest_ms: Option<i64>,
    last_session_ms: Option<i64>,
    sessions: u32,
    print: String,
}

fn is_print(value: &str) -> bool {
    value == "-" || (value.len() > 1 && matches!(value.as_bytes()[0], b'D' | b'F' | b'L') && !value.chars().any(char::is_control))
}

/// The app folder a home sits in, by that folder's name: `~/Library/Application Support/<app>/…`, or on Linux
/// `~/.config/<app>/…` or `~/.local/share/<app>/…`, with more below it. None for any other place.
fn inside_app(path: &str) -> Option<String> {
    ["~/Library/Application Support/", "~/.config/", "~/.local/share/"].iter().find_map(|base| {
        let rest = path.strip_prefix(base)?;
        let (app, below) = rest.split_once('/')?;
        (!app.is_empty() && !below.is_empty()).then(|| app.to_string())
    })
}

fn harness_kind(harness: Harness) -> Option<AgentKind> {
    match harness {
        Harness::Claude => Some(AgentKind::Claude),
        Harness::Codex => Some(AgentKind::Codex),
        _ => None,
    }
}

fn parse_scan(machine: &str, homes: &[AgentHome], stdout: &str, now_ms: i64) -> CleanupScan {
    let mut home_dir = String::new();
    let mut found_homes: Vec<(usize, AgentHomeKind, String)> = Vec::new();
    let mut caches: Vec<(Harness, ClearableKind, String)> = Vec::new();
    let mut leftovers: Vec<(LeftoverKind, String, String)> = Vec::new();
    let mut agents: Vec<CleanupAgent> = Vec::new();
    let mut measured: HashMap<String, Measured> = HashMap::new();
    let mut own_sessions: HashMap<String, String> = HashMap::new();
    let mut partial = false;
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["H", home] => home_dir = home.trim_end_matches('/').to_string(),
            ["G", index, agent, folder] if whole(folder) => {
                if let (Ok(index), Some(agent)) = (index.parse::<usize>(), AgentHomeKind::parse(agent)) {
                    if index < homes.len() && !found_homes.iter().any(|(_, _, seen)| seen == folder) {
                        found_homes.push((index, agent, folder.to_string()));
                    }
                }
            }
            ["C", harness, kind, folder] if whole(folder) => {
                let kind = match *kind {
                    "logs" => ClearableKind::Logs,
                    "cache" => ClearableKind::Cache,
                    _ => continue,
                };
                let harness = Harness::from_id(harness);
                if harness != Harness::Other && !caches.iter().any(|(_, _, seen)| seen == folder) {
                    caches.push((harness, kind, folder.to_string()));
                }
            }
            ["O", kind, file, program] if whole(file) && whole(program) => {
                let kind = match *kind {
                    "launchd" => LeftoverKind::LaunchAgent,
                    "systemd" => LeftoverKind::SystemdUnit,
                    _ => continue,
                };
                leftovers.push((kind, file.to_string(), program.to_string()));
            }
            ["B", agent, path, real, version] if path.starts_with('/') => {
                let harness = Harness::from_id(agent);
                if harness == Harness::Other {
                    continue;
                }
                let first = !agents.iter().any(|seen| seen.harness == harness);
                agents.push(CleanupAgent {
                    harness,
                    method: method_from_paths(harness_kind(harness), path, real),
                    path: path.to_string(),
                    real: (*real != *path && !real.is_empty()).then(|| real.to_string()),
                    version: parse_version(version).or_else(|| Some(version.trim().to_string()).filter(|version| !version.is_empty() && version.len() <= 80)),
                    first,
                });
            }
            ["Z", path, kb, newest, session, sessions, print] if whole(path) && is_print(print) => {
                measured.insert(
                    path.to_string(),
                    Measured {
                        size_kb: kb.parse().unwrap_or(0),
                        newest_ms: seconds_ms(newest),
                        last_session_ms: seconds_ms(session),
                        sessions: sessions.parse().unwrap_or(0),
                        print: print.to_string(),
                    },
                );
            }
            ["S", folder, sessions] if whole(folder) && whole(sessions) => {
                own_sessions.insert(folder.to_string(), sessions.to_string());
            }
            ["Q"] => partial = true,
            _ => {}
        }
    }
    let tilde = |path: &str| agent_homes::tilde(path, &home_dir);
    let installed: BTreeSet<Harness> = agents.iter().map(|agent| agent.harness).collect();
    for agent in &mut agents {
        agent.path = tilde(&agent.path);
        agent.real = agent.real.as_deref().map(tilde);
    }
    let held = |path: &str, measure: Option<&Measured>| -> Option<CleanupHold> {
        if !in_home(path, &home_dir) {
            Some(CleanupHold::OutsideHome)
        } else if measure.is_none() {
            Some(CleanupHold::Unmeasured)
        } else {
            None
        }
    };
    let homes_found: Vec<CleanupHome> = found_homes
        .iter()
        .filter_map(|(index, agent, folder)| {
            let listed = homes.get(*index)?;
            let measure = measured.get(folder);
            let sessions = own_sessions.get(folder);
            // Archived when the folder is a home on the list that reads sessions and isn't Ignored.
            let archived = sessions.is_some_and(|sessions| {
                found_homes.iter().any(|(at, kind, home)| home == sessions && kind.reads_sessions() && homes.get(*at).is_some_and(|listed| listed.role() != AgentHomeRole::Ignored))
            });
            let path = tilde(folder);
            let spec = agent.harness().spec();
            Some(CleanupHome {
                inside: (path != spec.home).then(|| inside_app(&path)).flatten(),
                agent: *agent,
                harness: agent.harness(),
                role: listed.role(),
                size_kb: measure.map(|measure| measure.size_kb),
                newest_ms: measure.and_then(|measure| measure.newest_ms),
                last_session_ms: measure.and_then(|measure| measure.last_session_ms),
                session_files: measure.map(|measure| measure.sessions),
                installed: installed.contains(&agent.harness()),
                own_sessions: sessions.map(|sessions| tilde(sessions)),
                own_sessions_archived: archived,
                held: held(folder, measure),
                archive: None,
                print: measure.map(|measure| measure.print.clone()),
                list_path: if listed.path.contains('*') { path.clone() } else { listed.path.clone() },
                abs: folder.clone(),
                path,
            })
        })
        .collect();
    let caches = caches
        .into_iter()
        .map(|(harness, kind, folder)| {
            let measure = measured.get(&folder);
            let home = found_homes.iter().filter(|(_, _, home)| within(&folder, home)).map(|(_, _, home)| home).max_by_key(|home| home.len()).map(|home| tilde(home));
            CleanupCache {
                harness,
                kind,
                path: tilde(&folder),
                home,
                size_kb: measure.map(|measure| measure.size_kb),
                newest_ms: measure.and_then(|measure| measure.newest_ms),
                held: held(&folder, measure),
                print: measure.map(|measure| measure.print.clone()),
                abs: folder,
            }
        })
        .collect();
    let leftovers = leftovers
        .into_iter()
        .map(|(kind, file, program)| {
            let measure = measured.get(&file);
            let name = file.rsplit('/').next().unwrap_or_default();
            let name = name.strip_suffix(".plist").or_else(|| name.strip_suffix(".service")).unwrap_or(name).to_string();
            CleanupLeftover {
                kind,
                name,
                path: tilde(&file),
                program: tilde(&program),
                size_kb: measure.map(|measure| measure.size_kb),
                newest_ms: measure.and_then(|measure| measure.newest_ms),
                held: held(&file, measure),
                print: measure.map(|measure| measure.print.clone()),
                abs: file,
            }
        })
        .collect();
    let (aside, roles) = parse_aside(stdout, &home_dir);
    CleanupScan {
        machine: machine.to_string(),
        scanned_at_ms: Some(now_ms),
        homes: homes_found,
        agents,
        leftovers,
        caches,
        aside,
        partial,
        home_dir,
        roles,
    }
}

/// What's set aside, from `A` and `R` lines. A line whose places aren't where a set-aside item can be is left out.
fn parse_aside(stdout: &str, home: &str) -> (Vec<SetAsideItem>, Vec<RoleNote>) {
    let home = home.trim_end_matches('/');
    let mut items = Vec::new();
    let mut roles = Vec::new();
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["A", stamp, item, group, from, aside, print, kb, taken] => {
                let (Some(group), Ok(item)) = (CleanupGroup::parse(group), item.parse::<u32>()) else { continue };
                if !is_stamp(stamp) || !in_home(from, home) || !is_print(print) {
                    continue;
                }
                let Some(volume) = aside_volume(aside, home, stamp, item) else { continue };
                items.push(SetAsideItem {
                    stamp: stamp.to_string(),
                    item,
                    group,
                    path: agent_homes::tilde(from, home),
                    at_ms: stamp_ms(stamp).unwrap_or_default(),
                    size_kb: kb.parse().ok(),
                    volume: volume.map(|top| agent_homes::tilde(&top, home)),
                    taken: *taken == "1",
                    from: from.to_string(),
                    aside: aside.to_string(),
                    print: print.to_string(),
                });
            }
            ["R", stamp, item, agent, path, existed, sessions, sync, chosen, source] => {
                let (Ok(item), Some(agent)) = (item.parse::<u32>(), AgentHomeKind::parse(agent)) else { continue };
                if !is_stamp(stamp) || path.is_empty() {
                    continue;
                }
                let before = match (*existed, source_named(source)) {
                    ("1", Some(source)) => Some((*sessions == "1", *sync == "1", *chosen == "1", source)),
                    ("0", _) => None,
                    _ => continue,
                };
                roles.push(RoleNote { stamp: stamp.to_string(), item, agent, path: path.to_string(), before });
            }
            _ => {}
        }
    }
    items.sort_by(|a, b| b.stamp.cmp(&a.stamp).then(a.item.cmp(&b.item)));
    (items, roles)
}

/// Where a set-aside item has to be: in the home folder's set-aside area (Some(None)), or in `.arbor-set-aside` at the
/// top of another drive (Some(Some(top))). None for anywhere else.
fn aside_volume(aside: &str, home: &str, stamp: &str, item: u32) -> Option<Option<String>> {
    if aside == format!("{home}/.arbor/set-aside/{stamp}/items/{item}") {
        return Some(None);
    }
    let top = aside.strip_suffix(&format!("/.arbor-set-aside/{stamp}/items/{item}"))?;
    (whole(aside) && (top.is_empty() || whole(top))).then(|| Some(if top.is_empty() { "/".to_string() } else { top.to_string() }))
}

/// The number and folder of a `C` line of a change's pointer: `C n from aside`.
pub(super) fn pointer_from<'a>(fields: &[&'a str]) -> Option<(&'a str, &'a str)> {
    match fields {
        ["C", n, from, aside] if !n.is_empty() && n.bytes().all(|byte| byte.is_ascii_digit()) && whole(from) && whole(aside) => Some((*n, *from)),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// What Arbor keeps between calls
// ---------------------------------------------------------------------------

/// Each machine's last scan, kept while Arbor runs so the section shows it again without a second scan, and each
/// removal is checked against what the user saw.
static SCANS: Mutex<BTreeMap<String, CleanupScan>> = Mutex::new(BTreeMap::new());

/// What each removal took out of its machine's scan, so putting it back lists it again without a scan.
#[derive(Clone, Debug)]
enum Removed {
    Home(CleanupHome),
    Cache(CleanupCache),
    Leftover(CleanupLeftover),
}

static REMOVED: Mutex<BTreeMap<(String, String, u32), Removed>> = Mutex::new(BTreeMap::new());

fn stored(machine: &str) -> Option<CleanupScan> {
    SCANS.lock().ok()?.get(machine).cloned()
}

fn store(scan: &CleanupScan) {
    if let Ok(mut scans) = SCANS.lock() {
        scans.insert(scan.machine.clone(), scan.clone());
    }
}

/// The machine's stored scan with what's set aside read afresh, or a scan of just that.
fn with_aside(machine: &str, home_dir: &str, aside: Vec<SetAsideItem>, roles: Vec<RoleNote>) -> CleanupScan {
    let mut scan = stored(machine).unwrap_or_else(|| CleanupScan { machine: machine.to_string(), home_dir: home_dir.to_string(), ..CleanupScan::default() });
    scan.aside = aside;
    scan.roles = roles;
    store(&scan);
    scan
}

fn home_dir_of(stdout: &str) -> String {
    stdout.lines().find_map(|line| line.strip_prefix("H\t")).unwrap_or_default().trim_end_matches('/').to_string()
}

async fn list(target: &Machine, stamp: Option<&str>) -> Result<(String, Vec<SetAsideItem>, Vec<RoleNote>), String> {
    let call = stamp.map_or_else(|| "list_aside\n".to_string(), |stamp| format!("list_aside {}\n", shell_quote(stamp)));
    let stdout = run_checked(target, MachineOp::CleanupList, &format!("set -u\nexport LC_ALL=C\n{HELPERS}{COMMON}{call}"), LIST_TIMEOUT).await?;
    let home = home_dir_of(&stdout);
    let (items, roles) = parse_aside(&stdout, &home);
    Ok((home, items, roles))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// The machine's last clean-up scan this session, without looking again; none before the first.
#[tauri::command]
pub(crate) async fn get_machine_cleanup(machine: String) -> Result<Option<CleanupScan>, String> {
    Ok(stored(&machine).filter(|scan| scan.scanned_at_ms.is_some()))
}

/// Looks at a machine for what could come off it: agent homes, agents, leftovers from apps that are gone, and the
/// harnesses' logs and caches, with their sizes; and what's set aside there. Changes nothing.
#[tauri::command]
pub(crate) async fn check_machine_cleanup(app: tauri::AppHandle, state: tauri::State<'_, MachineHealthState>, machine: String) -> Result<CleanupScan, String> {
    let target = find_machine(&state.lock(), &machine)?;
    let homes = agent_homes::every_home_on(&machine);
    let stdout = run_checked(&target, MachineOp::CleanupScan, &scan_script(&homes), SCAN_TIMEOUT).await?;
    let mut scan = parse_scan(&machine, &homes, &stdout, Local::now().timestamp_millis());
    add_standings(&app, &target, &mut scan).await;
    store(&scan);
    Ok(scan)
}

/// Moves things the last scan found aside on a machine, all or none, each only while it's as the scan found it. A home
/// Arbor reads sessions from is asked of the archive again first: with session files it doesn't hold safely, it's
/// moved only with `allowUnarchived` (they stay on the machine, set aside). A home moved aside turns Ignored in the agent
/// homes list.
#[tauri::command]
pub(crate) async fn remove_cleanup_items(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    items: Vec<CleanupTarget>,
    allow_unarchived: Option<bool>,
) -> Result<CleanupRemoval, CommandError> {
    let target = find_machine(&state.lock(), &machine)?;
    let mut scan = stored(&machine).filter(|scan| scan.scanned_at_ms.is_some()).ok_or_else(|| format!("Look at what's on {machine} first"))?;
    // The archive may have moved on since the look, either way: ask it again.
    add_standings(&app, &target, &mut scan).await;
    let (planned, homes) = plan_removal(&scan, &items)?;
    if allow_unarchived != Some(true) {
        let unarchived: Vec<String> = homes
            .iter()
            .filter_map(|(_, home)| home.archive.as_ref().filter(|standing| !standing.all_archived()).map(|standing| format!("{} ({} of {})", home.path, standing.not_archived, standing.sessions)))
            .collect();
        if !unarchived.is_empty() {
            // The fresh numbers go into the stored scan, so the page reads them and asks again.
            if let Ok(mut scans) = SCANS.lock() {
                if let Some(stored) = scans.get_mut(&machine) {
                    for home in &mut stored.homes {
                        if let Some(fresh) = scan.homes.iter().find(|fresh| fresh.abs == home.abs) {
                            home.archive = fresh.archive.clone();
                        }
                    }
                }
            }
            return Err(CommandError::unarchived(format!(
                "Not every session file is archived in {}. Setting it aside keeps them on the machine; pass allowUnarchived to go ahead.",
                unarchived.join(", ")
            )));
        }
    }
    let roles: Vec<RoleNote> = homes
        .iter()
        .map(|(n, home)| RoleNote {
            stamp: String::new(),
            item: *n as u32,
            agent: home.agent,
            path: home.list_path.clone(),
            before: agent_homes::saved_home(&machine, home.agent, &home.list_path).map(|saved| (saved.sessions, saved.sync, saved.chosen, saved.source)),
        })
        .collect();
    let stamp = new_stamp();
    let stdout = run_checked(&target, MachineOp::CleanupMove, &remove_script(&stamp, &planned, &roles), MOVE_TIMEOUT).await?;
    let outcome = parse_moves(&stdout);
    if let Some(refusal) = refusal(&outcome.refused, &planned, &scan.home_dir) {
        return Err(refusal);
    }
    // The homes moved aside turn Ignored, so nothing reads them or offers them again.
    for (n, home) in &homes {
        if outcome.moved.contains(n) {
            let ignored = AgentHome {
                machine: machine.clone(),
                agent: home.agent,
                path: home.list_path.clone(),
                source: agent_homes::saved_home(&machine, home.agent, &home.list_path).map_or(AgentHomeSource::Added, |saved| saved.source),
                sessions: false,
                sync: false,
                chosen: true,
                guess: None,
            };
            if let Err(error) = agent_homes::put_home(ignored).await {
                eprintln!("Couldn't turn the home set aside on {machine} to Ignored: {error}");
            }
        }
    }
    if !homes.is_empty() {
        let _ = app.emit(agent_homes::AGENT_HOMES_UPDATED_EVENT, ());
    }
    let home_dir = home_dir_of(&stdout);
    let (aside, roles) = parse_aside(&stdout, &home_dir);
    let removed_paths: Vec<String> = outcome.moved.iter().filter_map(|n| planned.get(*n)).map(|item| item.abs.clone()).collect();
    let mut updated = stored(&machine).unwrap_or(scan);
    if let Ok(mut removed) = REMOVED.lock() {
        for (n, item) in planned.iter().enumerate().filter(|(n, _)| outcome.moved.contains(n)) {
            if let Some(entry) = take_out(&mut updated, item) {
                removed.insert((machine.clone(), stamp.clone(), n as u32), entry);
            }
        }
    }
    // Whatever was inside a folder moved aside went with it.
    for path in &removed_paths {
        updated.homes.retain(|home| !within(&home.abs, path));
        updated.caches.retain(|cache| !within(&cache.abs, path));
        updated.leftovers.retain(|leftover| !within(&leftover.abs, path));
    }
    updated.aside = aside;
    updated.roles = roles;
    store(&updated);
    let shown = |path: &str| agent_homes::tilde(path, &home_dir);
    Ok(CleanupRemoval {
        stamp: outcome.stamp,
        removed: removed_paths.iter().map(|path| shown(path)).collect(),
        failed: outcome.failed.iter().filter_map(|n| planned.get(*n)).map(|item| shown(&item.abs)).collect(),
        scan: updated,
    })
}

/// The items to move, in order, from what the page asked for, and the homes among them by their number.
fn plan_removal(scan: &CleanupScan, items: &[CleanupTarget]) -> Result<(Vec<Planned>, Vec<(usize, CleanupHome)>), String> {
    if items.is_empty() {
        return Err("There's nothing to remove".into());
    }
    let mut chosen: Vec<(Planned, Option<CleanupHome>)> = Vec::new();
    for target in items {
        let (abs, print, size_kb, held, home) = match target.group {
            CleanupGroup::Home => {
                let home = scan.homes.iter().find(|home| home.path == target.path).ok_or_else(|| gone(&target.path))?;
                (home.abs.clone(), home.print.clone(), home.size_kb, home.held, Some(home.clone()))
            }
            CleanupGroup::Cache => {
                let cache = scan.caches.iter().find(|cache| cache.path == target.path).ok_or_else(|| gone(&target.path))?;
                (cache.abs.clone(), cache.print.clone(), cache.size_kb, cache.held, None)
            }
            CleanupGroup::Leftover => {
                let leftover = scan.leftovers.iter().find(|leftover| leftover.path == target.path).ok_or_else(|| gone(&target.path))?;
                (leftover.abs.clone(), leftover.print.clone(), leftover.size_kb, leftover.held, None)
            }
        };
        match held {
            Some(CleanupHold::OutsideHome) => return Err(format!("{} isn't in the home folder, so Arbor leaves it alone", target.path)),
            Some(CleanupHold::Unmeasured) => return Err(format!("Arbor hasn't measured {} yet. Refresh and try again", target.path)),
            None => {}
        }
        let print = print.ok_or_else(|| format!("Arbor hasn't measured {} yet. Refresh and try again", target.path))?;
        if !in_home(&abs, &scan.home_dir) {
            return Err(format!("{} isn't in the home folder, so Arbor leaves it alone", target.path));
        }
        if chosen.iter().any(|(planned, _)| planned.abs == abs) {
            continue;
        }
        chosen.push((Planned { group: target.group, abs, print, size_kb: size_kb.unwrap_or(0) }, home));
    }
    // Something inside another chosen folder moves with it.
    let outer: Vec<String> = chosen.iter().map(|(planned, _)| planned.abs.clone()).collect();
    chosen.retain(|(planned, _)| !outer.iter().any(|other| *other != planned.abs && within(&planned.abs, other)));
    let mut planned = Vec::new();
    let mut homes = Vec::new();
    for (n, (item, home)) in chosen.into_iter().enumerate() {
        planned.push(item);
        if let Some(home) = home {
            homes.push((n, home));
        }
    }
    Ok((planned, homes))
}

fn gone(path: &str) -> String {
    format!("{path} isn't in the last scan. Refresh and try again")
}

#[derive(Debug, Default, PartialEq)]
struct Moves {
    stamp: Option<String>,
    moved: BTreeSet<usize>,
    failed: Vec<usize>,
    /// Item, why, and for `unwritable` the top of its drive.
    refused: Vec<(usize, String, Option<String>)>,
}

fn parse_moves(stdout: &str) -> Moves {
    let mut moves = Moves::default();
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["K", stamp] if is_stamp(stamp) => moves.stamp = Some(stamp.to_string()),
            ["D", n] => moves.moved.extend(n.parse::<usize>().ok()),
            ["X", n, "failed"] => moves.failed.extend(n.parse::<usize>().ok()),
            ["X", n, why] => moves.refused.extend(n.parse::<usize>().ok().map(|n| (n, why.to_string(), None))),
            ["X", n, why, top] => moves.refused.extend(n.parse::<usize>().ok().map(|n| (n, why.to_string(), Some(top.to_string())))),
            _ => {}
        }
    }
    moves
}

/// Why nothing moved, when the script refused: something changed since the scan, or an item's drive can't take it.
fn refusal(refused: &[(usize, String, Option<String>)], planned: &[Planned], home: &str) -> Option<CommandError> {
    let path = |n: usize| planned.get(n).map_or_else(String::new, |item| agent_homes::tilde(&item.abs, home));
    let changed: Vec<String> = refused.iter().filter(|(_, why, _)| why == "changed").map(|(n, _, _)| path(*n)).collect();
    if !changed.is_empty() {
        return Some(CommandError::changed(format!(
            "{} changed since Arbor looked, so nothing was moved. Refresh and try again.",
            changed.join(", ")
        )));
    }
    let (n, why, top) = refused.first()?;
    Some(CommandError::failed(match why.as_str() {
        "unwritable" => format!(
            "{} is on another drive, and Arbor can't make a .arbor-set-aside folder at its top ({}) to set it aside without copying it. Nothing was moved.",
            path(*n),
            top.as_deref().map_or_else(|| "?".to_string(), |top| agent_homes::tilde(top, home))
        ),
        "mounted" => format!("{} is a drive of its own, so Arbor won't move it. Nothing was moved.", path(*n)),
        _ => format!("Arbor couldn't set {} aside. Nothing was moved.", path(*n)),
    }))
}

/// Takes an item out of the scan's lists, giving it back.
fn take_out(scan: &mut CleanupScan, item: &Planned) -> Option<Removed> {
    match item.group {
        CleanupGroup::Home => {
            let at = scan.homes.iter().position(|home| home.abs == item.abs)?;
            Some(Removed::Home(scan.homes.remove(at)))
        }
        CleanupGroup::Cache => {
            let at = scan.caches.iter().position(|cache| cache.abs == item.abs)?;
            Some(Removed::Cache(scan.caches.remove(at)))
        }
        CleanupGroup::Leftover => {
            let at = scan.leftovers.iter().position(|leftover| leftover.abs == item.abs)?;
            Some(Removed::Leftover(scan.leftovers.remove(at)))
        }
    }
}

/// Puts back what a machine has set aside: one item, or all of removal `stamp` when `item` is none.
#[tauri::command]
pub(crate) async fn restore_set_aside(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    stamp: String,
    item: Option<u32>,
) -> Result<CleanupRestore, String> {
    let target = find_machine(&state.lock(), &machine)?;
    restore(&app, &target, &stamp, item).await
}

async fn restore(app: &tauri::AppHandle, target: &Machine, stamp: &str, item: Option<u32>) -> Result<CleanupRestore, String> {
    if !is_stamp(stamp) {
        return Err("That isn't something Arbor set aside".into());
    }
    let machine = target.name().to_string();
    let (_, listed, roles) = list(target, Some(stamp)).await?;
    let chosen: Vec<SetAsideItem> = listed.into_iter().filter(|listed| item.is_none_or(|item| listed.item == item)).collect();
    if chosen.is_empty() {
        return Err(format!("That isn't set aside on {machine} any more"));
    }
    let stdout = run_checked(target, MachineOp::CleanupMove, &restore_script(&chosen), MOVE_TIMEOUT).await?;
    let mut back = BTreeSet::new();
    let mut failed = Vec::new();
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["B", s, n] if *s == stamp => back.extend(n.parse::<u32>().ok()),
            ["X", s, n, why] if *s == stamp => {
                let Some(entry) = n.parse::<u32>().ok().and_then(|n| chosen.iter().find(|entry| entry.item == n)) else { continue };
                let problem = match *why {
                    "taken" => RestoreProblem::Taken,
                    "changed" => RestoreProblem::Changed,
                    "gone" => RestoreProblem::Gone,
                    _ => RestoreProblem::Failed,
                };
                failed.push(RestoreFailure { path: entry.path.clone(), problem });
            }
            _ => {}
        }
    }
    // A home put back takes its role back.
    let mut homes_changed = false;
    for role in roles.iter().filter(|role| role.stamp == stamp && back.contains(&role.item)) {
        homes_changed = true;
        let result = match role.before {
            Some((sessions, sync, chosen, source)) => {
                agent_homes::put_home(AgentHome { machine: machine.clone(), agent: role.agent, path: role.path.clone(), source, sessions, sync, chosen, guess: None }).await
            }
            None => agent_homes::forget_home(machine.clone(), role.agent, role.path.clone()).await,
        };
        if let Err(error) = result {
            eprintln!("Couldn't put the role of {} on {machine} back: {error}", role.path);
        }
    }
    if homes_changed {
        let _ = app.emit(agent_homes::AGENT_HOMES_UPDATED_EVENT, ());
    }
    let home_dir = home_dir_of(&stdout);
    let (aside, all_roles) = parse_aside(&stdout, &home_dir);
    let mut scan = with_aside(&machine, &home_dir, aside, all_roles);
    if let Ok(mut removed) = REMOVED.lock() {
        for n in &back {
            match removed.remove(&(machine.clone(), stamp.to_string(), *n)) {
                Some(Removed::Home(home)) if !scan.homes.iter().any(|seen| seen.abs == home.abs) => scan.homes.push(home),
                Some(Removed::Cache(cache)) if !scan.caches.iter().any(|seen| seen.abs == cache.abs) => scan.caches.push(cache),
                Some(Removed::Leftover(leftover)) if !scan.leftovers.iter().any(|seen| seen.abs == leftover.abs) => scan.leftovers.push(leftover),
                _ => {}
            }
        }
    }
    store(&scan);
    let restored = chosen.iter().filter(|entry| back.contains(&entry.item)).map(|entry| entry.path.clone()).collect();
    Ok(CleanupRestore { restored, failed, scan })
}

/// Undo on Sync › Repo › History for a clean-up: puts back everything of it that's still set aside, and names what
/// was deleted for good (`deleted`, as History shows them) with the reason `deleted`.
pub(super) async fn undo_from_history(app: &tauri::AppHandle, target: &Machine, stamp: &str, deleted: &[String]) -> Result<SyncOutcome, String> {
    let restored = restore(app, target, stamp, None).await?;
    Ok(undo_outcome(restored, deleted))
}

fn undo_outcome(restored: CleanupRestore, deleted: &[String]) -> SyncOutcome {
    let mut failed: Vec<SyncFailure> = restored
        .failed
        .into_iter()
        .filter(|failure| !(failure.problem == RestoreProblem::Gone && deleted.contains(&failure.path)))
        .map(|failure| SyncFailure {
            path: failure.path,
            reason: if matches!(failure.problem, RestoreProblem::Taken | RestoreProblem::Changed) { "changed" } else { "failed" },
        })
        .collect();
    failed.extend(deleted.iter().map(|path| SyncFailure { path: path.clone(), reason: "deleted" }));
    SyncOutcome { backup: None, done: restored.restored, failed }
}

/// Deletes things set aside on a machine for good. Only ever inside a set-aside area, and never undone.
#[tauri::command]
pub(crate) async fn delete_set_aside(
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    items: Vec<SetAsideRef>,
) -> Result<CleanupScan, String> {
    let target = find_machine(&state.lock(), &machine)?;
    if items.is_empty() {
        return Err("There's nothing to delete".into());
    }
    let (_, listed, _) = list(&target, None).await?;
    let mut chosen = Vec::new();
    for wanted in &items {
        let found = listed
            .iter()
            .find(|entry| entry.stamp == wanted.stamp && entry.item == wanted.item)
            .ok_or_else(|| format!("That isn't set aside on {machine} any more"))?;
        chosen.push(found.clone());
    }
    let stdout = run_checked(&target, MachineOp::CleanupDelete, &delete_script(&chosen), DELETE_TIMEOUT).await?;
    let failed: Vec<String> = stdout
        .lines()
        .filter_map(|line| match line.split('\t').collect::<Vec<_>>().as_slice() {
            ["X", s, n, _] => chosen.iter().find(|entry| entry.stamp == *s && n.parse::<u32>().ok() == Some(entry.item)).map(|entry| entry.path.clone()),
            _ => None,
        })
        .collect();
    let home_dir = home_dir_of(&stdout);
    let (aside, roles) = parse_aside(&stdout, &home_dir);
    if let Ok(mut removed) = REMOVED.lock() {
        removed.retain(|(on, stamp, n), _| *on != machine || aside.iter().any(|entry| entry.stamp == *stamp && entry.item == *n));
    }
    let scan = with_aside(&machine, &home_dir, aside, roles);
    if !failed.is_empty() {
        return Err(format!("Arbor couldn't delete {}", failed.join(", ")));
    }
    Ok(scan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::machine_health::agent_homes::tests::{home, save_on_this_thread};

    const SECRET: &str = "sk-cleanup-SECRET-do-not-leak";

    #[test]
    fn a_home_inside_an_apps_folder_is_named_by_that_folder() {
        assert_eq!(inside_app("~/Library/Application Support/Some App/claude").as_deref(), Some("Some App"));
        assert_eq!(inside_app("~/.config/agent-app/homes/a").as_deref(), Some("agent-app"));
        assert_eq!(inside_app("~/.config/opencode"), None, "the folder itself isn't inside one");
        assert_eq!(inside_app("~/.claude"), None);
    }

    #[test]
    fn only_paths_in_the_home_folder_and_outside_arbors_own_are_offered() {
        let home = "/home/cam";
        assert!(in_home("/home/cam/.factory", home));
        assert!(!in_home("/home/cam", home));
        assert!(!in_home("/home/cam/.arbor/set-aside/x", home));
        assert!(!in_home("/home/cam/.arbor", home));
        assert!(!in_home("/home/cam/../etc", home));
        assert!(!in_home("/Volumes/Backup/.claude", home));
        assert!(!in_home("/home/cammy/.claude", home));
    }

    #[test]
    fn a_set_aside_place_is_only_ever_in_a_set_aside_area() {
        let stamp = "20261007T010203Z-00aa";
        assert_eq!(aside_volume(&format!("/home/cam/.arbor/set-aside/{stamp}/items/0"), "/home/cam", stamp, 0), Some(None));
        assert_eq!(aside_volume(&format!("/Volumes/Backup/.arbor-set-aside/{stamp}/items/2"), "/home/cam", stamp, 2), Some(Some("/Volumes/Backup".into())));
        for bad in [
            format!("/home/cam/.arbor/set-aside/{stamp}/items/1"),
            format!("/home/cam/.claude"),
            format!("/Volumes/Backup/../../home/cam/.arbor-set-aside/{stamp}/items/0"),
            format!("/home/cam/.arbor/set-aside/20261007T010203Z-00bb/items/0"),
        ] {
            assert_eq!(aside_volume(&bad, "/home/cam", stamp, 0), None, "{bad}");
        }
        let line = format!("A\t{stamp}\t0\tcache\t/home/cam/.claude/debug\t/etc/passwd\tDabc\t12\t0\n");
        assert!(parse_aside(&line, "/home/cam").0.is_empty(), "a listing naming somewhere else isn't trusted");
        assert_eq!(pointer_from(&["C", "0", "/home/cam/.claude/debug", "/home/cam/.arbor/set-aside/x/items/0"]), Some(("0", "/home/cam/.claude/debug")));
        assert_eq!(pointer_from(&["C", "0", "relative", "/x"]), None);
    }

    #[test]
    fn a_homes_sessions_count_as_archived_only_when_the_archive_holds_them_all_and_has_looked_since() {
        let counts = |known, safe, pass| HomeCounts { known, safe, last_pass_ms: pass };
        let standing = |condition, kept, found: HomeCounts, sessions, newest| home_archive(Ok((condition, kept, found)), sessions, newest);
        let all = standing(ArchiveCondition::Ok, true, counts(1_284, 1_284, Some(2_000)), 1_284, Some(1_000));
        assert!(all.all_archived() && all.not_archived == 0, "{all:?}");
        // Growing, skipped or never listed: 300 unsafe plus 12 the archive hasn't listed.
        let partly = standing(ArchiveCondition::CatchingUp, true, counts(1_272, 972, Some(2_000)), 1_284, Some(1_000));
        assert_eq!((partly.not_archived, partly.all_archived()), (312, false));
        // Written since the last complete pass: not all archived, though every file it knows is safe.
        let newer = standing(ArchiveCondition::Ok, true, counts(10, 10, Some(2_000)), 10, Some(3_000));
        assert!(newer.newer_than_pass && !newer.all_archived());
        assert!(!standing(ArchiveCondition::Ok, true, counts(0, 0, None), 3, None).all_archived(), "never passed");
        for (condition, kept, block) in [
            (ArchiveCondition::Off, true, ArchiveBlock::Off),
            (ArchiveCondition::Paused, true, ArchiveBlock::Paused),
            (ArchiveCondition::MainMissing, true, ArchiveBlock::MainMissing),
            (ArchiveCondition::Foreign, true, ArchiveBlock::Foreign),
            (ArchiveCondition::Ok, false, ArchiveBlock::NotKept),
        ] {
            let blocked = standing(condition, kept, counts(5, 5, Some(2_000)), 5, Some(1_000));
            assert_eq!((blocked.blocked, blocked.not_archived), (Some(block), 5), "{condition:?}");
        }
        let unreadable = home_archive(Err(()), 7, None);
        assert_eq!((unreadable.blocked, unreadable.not_archived), (Some(ArchiveBlock::Unreadable), 7));
    }

    #[test]
    fn a_home_holding_an_archived_sessions_folder_takes_its_standing() {
        let standing = HomeArchive { sessions: 40, not_archived: 3, blocked: None, last_pass_ms: Some(1), newer_than_pass: false };
        let home = |path: &str, agent, archive: Option<HomeArchive>, own: Option<&str>, archived| CleanupHome {
            path: path.into(), agent, harness: agent.harness(), role: AgentHomeRole::Active, size_kb: Some(1), newest_ms: None, last_session_ms: None,
            session_files: None, installed: true, inside: None, own_sessions: own.map(str::to_string), own_sessions_archived: archived, held: None,
            archive, abs: String::new(), print: None, list_path: String::new(),
        };
        let mut scan = CleanupScan {
            homes: vec![
                home("~/.pi/agent/sessions", AgentHomeKind::Pi, Some(standing.clone()), None, false),
                home("~/.pi/agent", AgentHomeKind::PiAgent, None, Some("~/.pi/agent/sessions"), true),
                home("~/.old-pi", AgentHomeKind::PiAgent, None, Some("~/.old-pi/sessions"), false),
            ],
            ..CleanupScan::default()
        };
        holders_take_standing(&mut scan);
        assert_eq!(scan.homes[1].archive.as_ref(), Some(&standing));
        assert_eq!(scan.homes[2].archive, None, "its sessions folder isn't one Arbor archives");
    }

    #[test]
    fn a_change_since_the_scan_refuses_as_its_own_kind() {
        let planned = vec![Planned { group: CleanupGroup::Cache, abs: "/home/cam/.claude/debug".into(), print: "D1".into(), size_kb: 1 }];
        let error = refusal(&parse_moves("H\t/home/cam\nX\t0\tchanged\n").refused, &planned, "/home/cam").unwrap();
        assert_eq!(error.kind, crate::command_error::CommandErrorKind::Changed);
        let error = refusal(&parse_moves("X\t0\tunwritable\t/Volumes/Backup\n").refused, &planned, "/home/cam").unwrap();
        assert_eq!(error.kind, crate::command_error::CommandErrorKind::Failed);
        assert!(error.message.contains("/Volumes/Backup") && error.message.starts_with("~/.claude/debug"), "{}", error.message);
        assert!(refusal(&parse_moves("K\t20261007T010203Z-00aa\nD\t0\n").refused, &planned, "/home/cam").is_none());
    }

    mod on_disk {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn temp_home(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("arbor-cleanup-{name}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            fs::canonicalize(&dir).unwrap()
        }

        fn run(shell: &str, home: &Path, script: &str) -> String {
            let mut command = tokio::process::Command::new(shell);
            command
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
                .env("TMPDIR", home)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let output = tokio::runtime::Runtime::new().unwrap().block_on(run_script(command, script, Duration::from_secs(60))).unwrap();
            assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8_lossy(&output.stdout).into_owned()
        }

        fn write(path: &Path, content: &str) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        /// A machine with things to clean: a Claude Code home with sessions and debug logs, a Droid home nobody uses,
        /// an app's copy of a Claude home, OpenCode's cache, a launch agent and a user service whose programs are gone
        /// and one whose program is there. Every file holds SECRET.
        fn fixture(home: &Path) {
            write(&home.join(".claude/projects/-src-app/one.jsonl"), SECRET);
            write(&home.join(".claude/settings.json"), SECRET);
            write(&home.join(".claude/debug/abc.txt"), SECRET);
            write(&home.join(".factory/settings.json"), SECRET);
            write(&home.join(".factory/AGENTS.md"), SECRET);
            write(&home.join(".pi/agent/AGENTS.md"), SECRET);
            write(&home.join(".pi/agent/sessions/--src-app--/s.jsonl"), SECRET);
            write(&home.join(".agent-app/homes/one/.claude.json"), SECRET);
            write(&home.join(".agent-app/homes/one/projects/-x/s.jsonl"), SECRET);
            write(&home.join(".cache/opencode/node_modules/pkg/index.js"), SECRET);
            write(&home.join(".config/systemd/user/old-sync.service"), &format!("[Service]\nEnvironment=TOKEN={SECRET}\nExecStart=\"{}/gone/bin/old-sync\" --token {SECRET}\n", home.display()));
            write(&home.join(".config/systemd/user/kept.service"), "[Service]\nExecStart=/bin/sh -c true\n");
            write(&home.join(".config/systemd/user/special.service"), "[Service]\nExecStart=%h/gone/x\n");
            write(
                &home.join("Library/LaunchAgents/com.example.gone.plist"),
                &format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
                     <plist version=\"1.0\"><dict><key>Label</key><string>com.example.gone</string><key>ProgramArguments</key><array><string>{}/Applications/Gone.app/run</string><string>{SECRET}</string></array>\
                     <key>EnvironmentVariables</key><dict><key>TOKEN</key><string>{SECRET}</string></dict></dict></plist>\n",
                    home.display()
                ),
            );
        }

        fn homes() -> Vec<AgentHome> {
            save_on_this_thread(vec![home_entry("~/.agent-app/homes/*", AgentHomeKind::Claude)]);
            agent_homes::every_home_on("cam-mbp")
        }

        fn home_entry(path: &str, agent: AgentHomeKind) -> AgentHome {
            home("cam-mbp", agent, path, true, false)
        }

        #[test]
        fn the_scan_lists_what_could_come_off_with_sizes_and_never_what_a_file_says() {
            for shell in shells() {
                let home = temp_home(&format!("scan-{shell}"));
                fixture(&home);
                let list = homes();
                let stdout = run(shell, &home, &scan_script(&list));
                assert!(!stdout.contains(SECRET), "{shell}: the scan printed a file's contents:\n{stdout}");
                let scan = parse_scan("cam-mbp", &list, &stdout, 1);
                let paths = |homes: &[CleanupHome]| homes.iter().map(|home| (home.path.clone(), home.held)).collect::<BTreeMap<_, _>>();
                let found = paths(&scan.homes);
                assert_eq!(found.get("~/.claude"), Some(&None), "{shell}: homes with sessions can be set aside now: {found:?}");
                assert_eq!(found.get("~/.factory"), Some(&None), "{shell}: {found:?}");
                assert_eq!(found.get("~/.agent-app/homes/one"), Some(&None), "{shell}");
                let factory = scan.homes.iter().find(|home| home.path == "~/.factory").unwrap();
                assert!(factory.size_kb.is_some() && factory.print.as_deref().is_some_and(|print| print.starts_with('D')), "{shell}");
                assert!(!factory.installed, "{shell}: no droid on the PATH");
                assert_eq!((factory.own_sessions.as_deref(), factory.own_sessions_archived), (None, false), "{shell}: the catalog knows no sessions folder for Droid");
                // Pi's own folder can be removed, and says it holds the sessions folder Arbor archives.
                let pi = scan.homes.iter().find(|home| home.path == "~/.pi/agent").unwrap();
                assert_eq!((pi.held, pi.own_sessions.as_deref(), pi.own_sessions_archived), (None, Some("~/.pi/agent/sessions"), true), "{shell}");
                assert_eq!(found.get("~/.pi/agent/sessions"), Some(&None), "{shell}");
                let claude = scan.homes.iter().find(|home| home.path == "~/.claude").unwrap();
                assert_eq!(claude.session_files, Some(1), "{shell}");
                assert!(claude.last_session_ms.is_some(), "{shell}");
                let caches: Vec<(&str, Harness)> = scan.caches.iter().map(|cache| (cache.path.as_str(), cache.harness)).collect();
                assert!(caches.contains(&("~/.claude/debug", Harness::Claude)), "{shell}: {caches:?}");
                assert!(caches.contains(&("~/.cache/opencode", Harness::OpenCode)), "{shell}: {caches:?}");
                let debug = scan.caches.iter().find(|cache| cache.path == "~/.claude/debug").unwrap();
                assert_eq!(debug.home.as_deref(), Some("~/.claude"));
                let leftovers: Vec<(&str, &str)> = scan.leftovers.iter().map(|leftover| (leftover.name.as_str(), leftover.program.as_str())).collect();
                let mut expected = vec![("old-sync", "~/gone/bin/old-sync"), ("special", "~/gone/x")];
                // Launch agents are read with macOS's own plist tools.
                if Path::new("/usr/bin/plutil").exists() {
                    expected.insert(0, ("com.example.gone", "~/Applications/Gone.app/run"));
                }
                assert_eq!(leftovers, expected, "{shell}");
                assert!(!scan.partial);
                let _ = fs::remove_dir_all(&home);
            }
        }

        fn scan(shell: &str, home: &Path) -> CleanupScan {
            let list = homes();
            parse_scan("cam-mbp", &list, &run(shell, home, &scan_script(&list)), 1)
        }

        fn plan(scan: &CleanupScan, targets: &[(CleanupGroup, &str)]) -> Vec<Planned> {
            let targets: Vec<CleanupTarget> = targets.iter().map(|(group, path)| CleanupTarget { group: *group, path: path.to_string() }).collect();
            plan_removal(scan, &targets).unwrap().0
        }

        #[test]
        fn removing_sets_aside_lists_the_change_and_putting_back_restores_it_as_it_was() {
            for shell in shells() {
                let home = temp_home(&format!("move-{shell}"));
                fixture(&home);
                let found = scan(shell, &home);
                let planned = plan(&found, &[(CleanupGroup::Home, "~/.factory"), (CleanupGroup::Cache, "~/.claude/debug"), (CleanupGroup::Leftover, "~/.config/systemd/user/old-sync.service")]);
                let roles = vec![RoleNote { stamp: String::new(), item: 0, agent: AgentHomeKind::Droid, path: "~/.factory".into(), before: None }];
                let stamp = "20261007T010203Z-00aa";
                let stdout = run(shell, &home, &remove_script(stamp, &planned, &roles));
                let moves = parse_moves(&stdout);
                assert_eq!((moves.stamp.as_deref(), moves.moved.len(), moves.refused.len()), (Some(stamp), 3, 0), "{shell}: {stdout}");
                assert!(!home.join(".factory").exists() && !home.join(".claude/debug").exists(), "{shell}");
                let kept = home.join(format!(".arbor/set-aside/{stamp}"));
                assert_eq!(fs::read_to_string(kept.join("items/0/AGENTS.md")).unwrap(), SECRET, "{shell}: moved, not copied or changed");
                assert_eq!(fs::metadata(home.join(".arbor/set-aside")).unwrap().permissions().mode() & 0o777, 0o700);
                let manifest = fs::read_to_string(kept.join("manifest")).unwrap();
                assert!(!manifest.contains(SECRET), "{shell}");
                assert!(manifest.contains("R\t0\tdroid\t~/.factory\t0"), "{manifest}");
                // Listed among Arbor's changes, by a pointer setup_sync reads.
                let backups = run(shell, &home, &format!("set -u\nexport LC_ALL=C\n{}", guarded_writes::BACKUPS_SCRIPT));
                let listed = setup_sync::parse_backups(&backups);
                assert_eq!(listed.len(), 1, "{shell}: {backups}");
                let (aside, roles) = parse_aside(&stdout, &home.display().to_string());
                assert_eq!(aside.len(), 3, "{shell}: {stdout}");
                assert_eq!(roles.len(), 1);
                assert!(aside.iter().all(|item| item.volume.is_none() && !item.taken));

                // Something new at a place keeps that item where it is; the rest go back.
                write(&home.join(".claude/debug/new.txt"), "new");
                let stdout = run(shell, &home, &restore_script(&aside));
                assert!(stdout.contains(&format!("B\t{stamp}\t0")) && stdout.contains(&format!("X\t{stamp}\t1\ttaken")), "{shell}: {stdout}");
                assert_eq!(fs::read_to_string(home.join(".factory/AGENTS.md")).unwrap(), SECRET);
                assert!(home.join(".config/systemd/user/old-sync.service").exists());
                let (left, _) = parse_aside(&stdout, &home.display().to_string());
                assert_eq!(left.iter().map(|item| (item.item, item.taken)).collect::<Vec<_>>(), [(1, true)], "{shell}");
                assert!(!home.join(format!(".arbor/setup-backups/{stamp}/undone")).exists(), "{shell}: not all of it is back");

                // Deleted for good: only inside the set-aside area, and the removal's folders go with its last item.
                let stdout = run(shell, &home, &delete_script(&left));
                assert!(stdout.contains(&format!("G\t{stamp}\t1")), "{shell}: {stdout}");
                assert!(!kept.exists(), "{shell}: nothing left of the removal");
                assert!(home.join(".claude/debug/new.txt").exists(), "{shell}: what took its place is left alone");
                let _ = fs::remove_dir_all(&home);
            }
        }

        #[test]
        fn deleting_for_good_marks_the_change_so_undo_restores_only_the_rest() {
            for shell in shells() {
                let home = temp_home(&format!("history-{shell}"));
                fixture(&home);
                let found = scan(shell, &home);
                let planned = plan(&found, &[(CleanupGroup::Home, "~/.factory"), (CleanupGroup::Cache, "~/.claude/debug")]);
                let stamp = "20261007T010203Z-00f0";
                let stdout = run(shell, &home, &remove_script(stamp, &planned, &[]));
                let (aside, _) = parse_aside(&stdout, &home.display().to_string());
                let history = || setup_sync::parse_backups(&run(shell, &home, &format!("set -u\nexport LC_ALL=C\n{}", guarded_writes::BACKUPS_SCRIPT)));

                // One of the two deleted for good: History still offers Undo, which knows that one is gone.
                let factory: Vec<SetAsideItem> = aside.iter().filter(|item| item.path == "~/.factory").cloned().collect();
                run(shell, &home, &delete_script(&factory));
                let listed = history();
                assert_eq!((listed[0].deleted.as_slice(), listed[0].deleted_at_ms), (&["~/.factory".to_string()][..], None), "{shell}");
                let rest: Vec<SetAsideItem> = aside.iter().filter(|item| item.path != "~/.factory").cloned().collect();
                let stdout = run(shell, &home, &restore_script(&rest));
                assert!(stdout.contains(&format!("B\t{stamp}\t1")) && home.join(".claude/debug/abc.txt").exists(), "{shell}: {stdout}");
                let restored = CleanupRestore { restored: vec!["~/.claude/debug".into()], failed: Vec::new(), scan: CleanupScan::default() };
                let outcome = undo_outcome(restored, &listed[0].deleted);
                assert_eq!(outcome.done, ["~/.claude/debug"]);
                assert_eq!(outcome.failed, [SyncFailure { path: "~/.factory".into(), reason: "deleted" }], "{shell}");

                // Everything deleted for good: nothing left to undo, with when.
                let found = scan(shell, &home);
                let planned = plan(&found, &[(CleanupGroup::Cache, "~/.claude/debug")]);
                let stamp = "20261007T010203Z-00f1";
                let stdout = run(shell, &home, &remove_script(stamp, &planned, &[]));
                run(shell, &home, &delete_script(&parse_aside(&stdout, &home.display().to_string()).0));
                let listed = history();
                let all_gone = listed.iter().find(|backup| backup.id == stamp).unwrap();
                assert!(all_gone.deleted_at_ms.is_some_and(|at| at > 0), "{shell}");
                let _ = fs::remove_dir_all(&home);
            }
        }

        #[test]
        fn nothing_moves_when_anything_changed_since_the_scan() {
            for shell in shells() {
                let home = temp_home(&format!("changed-{shell}"));
                fixture(&home);
                let found = scan(shell, &home);
                let planned = plan(&found, &[(CleanupGroup::Home, "~/.factory"), (CleanupGroup::Cache, "~/.cache/opencode")]);
                write(&home.join(".cache/opencode/extra.json"), "{}");
                let stdout = run(shell, &home, &remove_script("20261007T010203Z-00bb", &planned, &[]));
                let moves = parse_moves(&stdout);
                assert!(moves.moved.is_empty() && moves.stamp.is_none(), "{shell}: {stdout}");
                assert_eq!(moves.refused, [(1, "changed".to_string(), None)], "{shell}");
                assert!(home.join(".factory/AGENTS.md").exists() && !home.join(".arbor").exists(), "{shell}");
                let _ = fs::remove_dir_all(&home);
            }
        }

        /// The removal script as it runs when `~/ext` is a drive of its own: `devof` answers 2 there and 1 elsewhere.
        fn with_other_drive(script: &str) -> String {
            script.replacen(
                "\nstamp=",
                "\ndevof() { case \"$1\" in \"$HOME/ext\"|\"$HOME/ext/\"*) printf 2 ;; *) printf 1 ;; esac; }\nstamp=",
                1,
            )
        }

        #[test]
        fn an_item_on_another_drive_is_set_aside_on_that_drive_or_not_at_all() {
            for shell in shells() {
                let home = temp_home(&format!("drive-{shell}"));
                fixture(&home);
                write(&home.join("ext/.cache/opencode/pkg.js"), SECRET);
                let found = scan(shell, &home);
                let ext = found.caches.iter().find(|cache| cache.harness == Harness::OpenCode).unwrap().clone();
                let planned = vec![Planned {
                    group: CleanupGroup::Cache,
                    abs: home.join("ext/.cache/opencode").display().to_string(),
                    print: run(shell, &home, &format!("set -u\n{HELPERS}{COMMON}print_of \"$HOME/ext/.cache/opencode\"\n")).lines().last().unwrap().to_string(),
                    size_kb: ext.size_kb.unwrap_or(0),
                }];
                // Nowhere to put it on that drive: refused, and nothing is left behind.
                fs::set_permissions(home.join("ext"), fs::Permissions::from_mode(0o555)).unwrap();
                let stdout = run(shell, &home, &with_other_drive(&remove_script("20261007T010203Z-00ee", &planned, &[])));
                assert_eq!(parse_moves(&stdout).refused, [(0, "unwritable".to_string(), Some(home.join("ext").display().to_string()))], "{shell}: {stdout}");
                assert!(home.join("ext/.cache/opencode/pkg.js").exists() && !home.join(".arbor/set-aside/20261007T010203Z-00ee").exists(), "{shell}");
                fs::set_permissions(home.join("ext"), fs::Permissions::from_mode(0o755)).unwrap();

                let stamp = "20261007T010203Z-00ef";
                let stdout = run(shell, &home, &with_other_drive(&remove_script(stamp, &planned, &[])));
                assert_eq!(parse_moves(&stdout).moved.len(), 1, "{shell}: {stdout}");
                let kept = home.join(format!("ext/.arbor-set-aside/{stamp}/items/0/pkg.js"));
                assert_eq!(fs::read_to_string(&kept).unwrap(), SECRET, "{shell}");
                let (aside, _) = parse_aside(&stdout, &home.display().to_string());
                assert_eq!(aside[0].volume.as_deref(), Some("~/ext"), "{shell}");
                let stdout = run(shell, &home, &restore_script(&aside));
                assert!(stdout.contains(&format!("B\t{stamp}\t0")), "{shell}: {stdout}");
                assert!(home.join("ext/.cache/opencode/pkg.js").exists() && !home.join(format!("ext/.arbor-set-aside/{stamp}")).exists(), "{shell}");
                assert!(home.join(format!(".arbor/setup-backups/{stamp}/undone")).exists(), "{shell}: all of it is back");
                let _ = fs::remove_dir_all(&home);
            }
        }

        #[test]
        fn putting_back_refuses_a_set_aside_copy_that_changed() {
            for shell in shells() {
                let home = temp_home(&format!("copy-{shell}"));
                fixture(&home);
                let found = scan(shell, &home);
                let planned = plan(&found, &[(CleanupGroup::Home, "~/.factory")]);
                let stamp = "20261007T010203Z-00cc";
                let stdout = run(shell, &home, &remove_script(stamp, &planned, &[]));
                let (aside, _) = parse_aside(&stdout, &home.display().to_string());
                write(&home.join(format!(".arbor/set-aside/{stamp}/items/0/added.md")), "x");
                let stdout = run(shell, &home, &restore_script(&aside));
                assert!(stdout.contains(&format!("X\t{stamp}\t0\tchanged")), "{shell}: {stdout}");
                assert!(!home.join(".factory").exists());
                let _ = fs::remove_dir_all(&home);
            }
        }

        #[test]
        fn deleting_for_good_refuses_anything_outside_a_set_aside_area() {
            for shell in shells() {
                let home = temp_home(&format!("delete-{shell}"));
                fixture(&home);
                let stamp = "20261007T010203Z-00dd";
                let outside = SetAsideItem {
                    stamp: stamp.into(),
                    item: 0,
                    group: CleanupGroup::Home,
                    path: "~/.factory".into(),
                    at_ms: 0,
                    size_kb: None,
                    volume: None,
                    taken: false,
                    from: home.join(".factory").display().to_string(),
                    aside: home.join(".factory").display().to_string(),
                    print: "D1".into(),
                };
                let stdout = run(shell, &home, &delete_script(&[outside.clone()]));
                assert!(stdout.contains(&format!("X\t{stamp}\t0\trefused")), "{shell}: {stdout}");
                // In the right place, but not named by a manifest there.
                let fake = home.join(format!(".arbor/set-aside/{stamp}/items/0"));
                fs::create_dir_all(&fake).unwrap();
                let stdout = run(shell, &home, &delete_script(&[SetAsideItem { aside: fake.display().to_string(), ..outside }]));
                assert!(stdout.contains("refused") && fake.exists(), "{shell}: {stdout}");
                assert!(home.join(".factory/AGENTS.md").exists(), "{shell}");
                let _ = fs::remove_dir_all(&home);
            }
        }
    }
}

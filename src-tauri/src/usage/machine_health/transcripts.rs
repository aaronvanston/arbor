//! Where each session ran, from Claude Code's and Codex's own transcripts on
//! the machine that ran it: the folder, its git worktree and branch, the pull
//! requests it opened, the lines it changed, each compaction with what set it
//! off, how often it called each tool, and which skills Claude Code called for
//! by name. The homes looked in are the machine's agent homes with Sessions on
//! (agent_homes).
//!
//! A session's title (Claude Code's own or the one its user gave it, or a Codex
//! thread's name) is conversation text, so it's read only while Settings ›
//! Harnesses' Session titles is on (`set_session_titles`), and only held in
//! memory (`TitleMemory`). usage.db never has one, and turning the switch off
//! drops every title held.
//!
//! Every few minutes, each machine that answered its last health sample is
//! asked, over the same shell or SSH connection, about the sessions Arbor has
//! seen lately that aren't known to be somewhere else. The script there picks
//! those fields out of the matching transcripts and prints nothing else: no
//! message, prompt or summary ever leaves the machine, and a tool call leaves
//! it as its name alone, never what went into it or came back; a Skill call
//! also gives the name of the skill it asked for, and a skill a person typed or
//! picked leaves as its name alone. A transcript
//! that hasn't grown since it was last read is skipped, so after the first
//! scan each one costs little.

use super::agent_homes::{self, tilde, HomeUse};
use super::*;
use ts_rs::TS;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// How often each machine's transcripts are looked through.
const SCAN_INTERVAL_MS: i64 = 5 * 60 * 1000;
/// The first scan of a machine reads every recent transcript, which takes a while.
const SCAN_TIMEOUT: Duration = Duration::from_secs(120);
/// Sessions with requests this recent are looked up.
const LOOKBACK_MS: i64 = 30 * 86_400_000;
/// At most this many sessions are asked about in one scan, the most recent first.
const WANTED_LIMIT: usize = 5_000;
const TITLE_CHARS: usize = 300;
/// The most titles held at once. Past it they're all dropped and read again, so a long run can't grow without end.
const TITLES_KEPT: usize = 50_000;
const PATH_CHARS: usize = 4_096;
const PULL_REQUESTS_KEPT: usize = 50;
/// The most names kept in each of a session's tool lists, the most called first.
const TOOL_NAMES_KEPT: usize = 100;
/// Transcripts stored before Arbor counted tool calls are read again, this many
/// in a scan, so a machine's first scan after the update doesn't run out of time.
const RE_READS_PER_SCAN: usize = 200;

pub(crate) const SESSION_TRANSCRIPTS_UPDATED_EVENT: &str = "session-transcripts-updated";

/// Off until the webview says otherwise, so no title is read before the setting is known.
static TITLES: AtomicBool = AtomicBool::new(false);
/// Moves on each time titles are turned on or off, so a scan that began before keeps none of what it read.
static TITLE_EPOCH: AtomicU64 = AtomicU64::new(0);
static TITLE_MEMORY: std::sync::Mutex<TitleMemory> = std::sync::Mutex::new(TitleMemory::new());

fn titles_on() -> bool {
    TITLES.load(Ordering::SeqCst)
}

fn title_memory() -> std::sync::MutexGuard<'static, TitleMemory> {
    TITLE_MEMORY.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Sessions' titles while Session titles is on. Only ever in memory: never in usage.db, a log or the archive.
#[derive(Debug, Default, PartialEq)]
struct TitleMemory {
    /// Each session's title and where it came from ("custom", "ai" or "codex"), by session id.
    titles: BTreeMap<String, (String, &'static str)>,
    /// The sessions whose transcripts have been looked through for titles since they came on, titled or not, so a
    /// transcript that hasn't changed isn't looked through again.
    looked_up: BTreeSet<String>,
}

impl TitleMemory {
    const fn new() -> Self {
        Self { titles: BTreeMap::new(), looked_up: BTreeSet::new() }
    }

    /// Holds a session's title, or drops it when it's empty. True when that changed what's held.
    fn set(&mut self, id: &str, title: &str, source: &'static str) -> bool {
        if title.is_empty() {
            return self.titles.remove(id).is_some();
        }
        if self.titles.get(id).is_some_and(|(held, held_source)| held == title && *held_source == source) {
            return false;
        }
        self.titles.insert(id.to_string(), (title.to_string(), source));
        true
    }
}

/// A Claude Code session's title: the one its user gave it, else Claude Code's own.
fn claude_title<'a>(ai: &'a str, custom: &'a str) -> (&'a str, &'static str) {
    if custom.is_empty() {
        (ai, "ai")
    } else {
        (custom, "custom")
    }
}

/// Folds the titles a scan read into `memory`, and returns how many sessions' titles changed.
fn remember_titles(memory: &mut TitleMemory, scan: &ScanOutput) -> usize {
    let mut changed = 0;
    for file in scan.files.iter().filter(|file| file.agent == TranscriptAgent::Claude) {
        let (title, source) = claude_title(&file.ai_title, &file.custom_title);
        changed += usize::from(memory.set(&file.session_id, title, source));
    }
    for (id, (ai, custom)) in &scan.claude_titles {
        let (title, source) = claude_title(ai, custom);
        changed += usize::from(memory.set(id, title, source));
    }
    // A Codex thread can be named, or its name cleared, without its transcript growing.
    for (id, title) in &scan.titles {
        changed += usize::from(memory.set(id, title, "codex"));
    }
    // Every transcript found was looked through for titles: read whole, or for its titles alone.
    memory.looked_up.extend(scan.agent_homes.keys().cloned());
    if memory.titles.len() > TITLES_KEPT || memory.looked_up.len() > TITLES_KEPT {
        *memory = TitleMemory::new();
    }
    changed
}

/// Holds what a scan that began at `epoch` read of titles, unless titles have been turned on or off since.
fn remember_scan_titles(scan: &ScanOutput, epoch: u64) -> usize {
    let mut memory = title_memory();
    if !titles_on() || TITLE_EPOCH.load(Ordering::SeqCst) != epoch {
        return 0;
    }
    remember_titles(&mut memory, scan)
}

/// Puts the titles held in `memory` on transcripts read from usage.db, which never holds one.
fn put_titles(memory: &TitleMemory, found: &mut HashMap<String, SessionTranscript>) {
    if memory.titles.is_empty() {
        return;
    }
    for (id, transcript) in found.iter_mut() {
        if let Some((title, source)) = memory.titles.get(id) {
            transcript.title = title.clone();
            transcript.title_source = (*source).to_string();
        }
    }
}

/// Turns reading sessions' titles on or off (Settings › Harnesses' Session titles). Either way every title held is
/// dropped, so none outlives the switch. On, every machine is looked through again at its next health round, so
/// titles show soon after.
#[tauri::command]
pub(crate) async fn set_session_titles(
    enabled: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
) -> Result<(), String> {
    {
        let mut memory = title_memory();
        if TITLES.swap(enabled, Ordering::SeqCst) == enabled {
            return Ok(());
        }
        TITLE_EPOCH.fetch_add(1, Ordering::SeqCst);
        *memory = TitleMemory::new();
    }
    if enabled {
        let mut inner = state.lock();
        for series in inner.series.values_mut() {
            series.transcripts.scanned_at = None;
        }
        inner.local_transcripts.scanned_at = None;
    }
    let _ = app.emit(SESSION_TRANSCRIPTS_UPDATED_EVENT, Local::now().timestamp_millis());
    Ok(())
}

// Runs with `sh` on the machine, fed on stdin like the health sample. The
// sessions to look for arrive in the heredoc Rust puts between the two halves,
// one "id size titles" line each, with the size the transcript had when last
// read and 1 when its titles are wanted even if it hasn't changed. Rust sets
// `titles` to 1 above it only while Session titles is on; otherwise no title
// record, thread name or name column is read at all.
//
// Lines out, tab-separated, each file's lines after its S line:
//   H home                                  the machine's home directory
//   W id agent-home                         the agent home a wanted transcript is in, changed or not
//   S agent id size                         a transcript that changed
//   R record                                Claude Code: a pull request or cost record, whole, or a title
//   Q id record                             Claude Code: a title of a transcript that hasn't changed, whole
//   K timestamp trigger pre post duration   Claude Code: a compaction
//   P "cwd":…,"sessionId":…,"gitBranch":…   Claude Code: where the session last was
//   M "field":"value"                       Codex: the folder, branch and repository it started in
//   C timestamp                             Codex: a compaction
//   N record                                Codex: a thread's name, from a session index
//   T id "name" "branch"                    Codex: a thread's branch, and its name with titles on, from a state database
//   U count name                            how often the session called a tool
//   V count name                            Claude Code: how often its subagents called a tool
//   A count type                            Claude Code: the subagents it started of a type
//   L count skill                           Claude Code: how often it or its subagents called for a skill
//   Y skill                                 a skill the session used: called for, typed, or picked in Codex
//   G folder [root common head]             the git checkout a folder is in; a bare folder is gone
const SCRIPT_HEAD: &str = r##"set -u
export LC_ALL=C
renice -n 10 $$ >/dev/null 2>&1
work=$(mktemp -d "${TMPDIR:-/tmp}/arbor-transcripts.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT
cat > "$work/wanted" <<'ARBOR_WANTED'
"##;

const SCRIPT_BODY: &str = r##"ARBOR_WANTED
: > "$work/cwds"
printf 'H\t%s\n' "$HOME"

# Where each agent keeps its files: the homes on the machine's list with Sessions on.
agent_homes > "$work/homes"
awk -F"$tab" '$1 == "claude" { print $2 }' "$work/homes" > "$work/claude-homes"
awk -F"$tab" '$1 == "codex" { print $2 }' "$work/homes" > "$work/codex-homes"

# Keeps a folder to look up, unless its JSON has escapes in it.
remember() {
  dir=${1#\"cwd\":\"}
  dir=${dir%%\"*}
  case "$dir" in *\\*|'') ;; *) printf '%s\n' "$dir" >> "$work/cwds" ;; esac
}

# The Claude Code records read whole: pull requests and line counts, and titles only while Arbor is asked for them.
records='pr-link|cost-state'
if [ "$titles" = 1 ]; then records="ai-title|custom-title|$records"; fi

# Every record that has a folder carries these fields together, in this order.
place='"cwd":"([^"\\]|\\.)*","sessionId":"[^"]*"(,"version":"[^"]*")?(,"gitBranch":"([^"\\]|\\.)*")?'

# A Claude Code tool call's name, the type of subagent an agent tool was asked
# for, the skill a Skill call asked for, which opens its input, and the skill a
# request was made under, which Claude Code notes whether its model called for
# the skill or a person typed it. Nothing else in the call, or in what came
# back, is printed.
uses='"type":"(server_)?tool_use","id":"[^"]*","name":"[^"]*"|"subagent_type":"[^"]*"|"input":\{"skill":"[^"]*"|"attributionSkill":"[^"]*"'

# Counts the calls read by the pattern above, printing them under the tag given.
# A subagent type or skill belongs to the call before it; a copy of the call's
# input kept later in the same record isn't counted again. A skill can be
# asked for as its command, with a slash.
count_uses() {
  awk -v tag="$1" '
    /^"type"/ { name = substr($0, index($0, "\"name\":\"") + 8); sub(/"$/, "", name); calls[name]++; open = 1; skill = (name == "Skill"); next }
    /^"input"/ { if (skill) { asked = substr($0, 19); sub(/"$/, "", asked); sub(/^\//, "", asked); skills[asked]++; used[asked] = 1 }; skill = 0; open = 0; next }
    /^"attributionSkill"/ { under = substr($0, 21); sub(/"$/, "", under); sub(/^\//, "", under); if (under != "") used[under] = 1; next }
    open { type = substr($0, 18); sub(/"$/, "", type); started[type]++; open = 0 }
    END {
      for (name in calls) print tag "\t" calls[name] "\t" name
      for (type in started) print "A\t" started[type] "\t" type
      for (asked in skills) print "L\t" skills[asked] "\t" asked
      for (name in used) print "Y\t" name
    }'
}

# A Codex tool call's name, with the namespace an app's or MCP server's tools
# come in. Its arguments and output are left where they are.
calls='"type":"response_item","payload":\{"type":"(function_call|custom_tool_call)",("[a-z_]+":("[^"]*"|null),){0,3}"name":"[^"]*"(,"namespace":"[^"]*")?|"type":"response_item","payload":\{"type":"(local_shell|web_search)_call"'

# A compaction's keys have come in more than one order, so it's found by its subtype.
claude_file() {
  grep -E '^\{"type":"('"$records"')"|"subtype":"compact_boundary"' "$1" 2>/dev/null | awk '
    function text(name) { return match($0, "\"" name "\":\"[^\"]*\"") ? substr($0, RSTART + length(name) + 4, RLENGTH - length(name) - 5) : "" }
    function number(name) { return match($0, "\"" name "\":[0-9]+") ? substr($0, RSTART + length(name) + 3, RLENGTH - length(name) - 3) : "" }
    /^\{"type":"ai-title"/ { ai = $0; next }
    /^\{"type":"custom-title"/ { custom = $0; next }
    /^\{"type":"cost-state"/ { cost = $0; next }
    /^\{"type":"pr-link"/ { url = text("prUrl"); if (url != "" && !(url in seen)) { seen[url] = 1; print "R\t" $0 }; next }
    /"type":"system"/ { print "K\t" text("timestamp") "\t" text("trigger") "\t" number("preTokens") "\t" number("postTokens") "\t" number("durationMs") }
    END { if (ai != "") print "R\t" ai; if (custom != "") print "R\t" custom; if (cost != "") print "R\t" cost }'
  grep -o -E "$uses" "$1" 2>/dev/null | count_uses U
  # Each subagent's calls are in a transcript of its own, beside the session's.
  if [ -d "${1%.jsonl}/subagents" ]; then
    find "${1%.jsonl}/subagents" \( -type f -o -type l \) -name 'agent-*.jsonl' -exec grep -h -o -E "$uses" {} + 2>/dev/null | count_uses V
  fi
  last=$(tail -c 262144 "$1" 2>/dev/null | grep -o -E "$place" | tail -n 1)
  [ -n "$last" ] || last=$(grep -o -E "$place" "$1" 2>/dev/null | tail -n 1)
  if [ -n "$last" ]; then
    printf 'P\t%s\n' "$last"
    remember "$last"
  fi
}

# Only the latest titles of a transcript that hasn't changed since it was read, tagged with its session.
claude_titles() {
  grep -E '^\{"type":"(ai-title|custom-title)"' "$1" 2>/dev/null | awk -v id="$2" '
    /^\{"type":"ai-title"/ { ai = $0; next }
    { custom = $0 }
    END { if (ai != "") print "Q\t" id "\t" ai; if (custom != "") print "Q\t" id "\t" custom }'
}

codex_file() {
  meta=$(head -n 1 "$1" 2>/dev/null | grep -o -E '"(cwd|branch|commit_hash|repository_url)":"([^"\\]|\\.)*"')
  if [ -n "$meta" ]; then
    printf '%s\n' "$meta" | awk '{ print "M\t" $0 }'
    remember "$(printf '%s\n' "$meta" | grep -m 1 '^"cwd"')"
  fi
  grep -o -E '^\{"timestamp":"[^"]*",("ordinal":[0-9]+,)?"type":"compacted"' "$1" 2>/dev/null | awk '{ print "C\t" substr($0, 15, index(substr($0, 15), "\"") - 1) }'
  grep -o -E "$calls" "$1" 2>/dev/null | awk '
    {
      if ((at = index($0, "\"name\":\"")) > 0) {
        name = substr($0, at + 8); space = ""
        if ((cut = index(name, "\",\"namespace\":\"")) > 0) { space = substr(name, cut + 15); name = substr(name, 1, cut - 1); sub(/"$/, "", space) }
        sub(/"$/, "", name)
        if (space != "") name = space "/" name
      } else {
        # A built-in call without a name: local_shell_call, web_search_call.
        name = substr($0, 43); sub(/_call"$/, "", name)
      }
      calls[name]++
    }
    END { for (name in calls) print "U\t" calls[name] "\t" name }'
  # The skills a person picked for a turn, which Codex keeps beside what they
  # typed. Only each one's name is printed.
  grep -o -E '"type":"skill","name":"[^"]*"|"type":"mention","name":"[^"]*","path":"skill://' "$1" 2>/dev/null | awk '
    { name = substr($0, index($0, "\"name\":\"") + 8); sub(/".*/, "", name); if (name != "") used[name] = 1 }
    END { for (name in used) print "Y\t" name }'
}

# The checkout a folder is in: its top, the main checkout's git directory
# when it's a linked worktree, and where its HEAD points.
place_of() {
  if [ ! -d "$1" ]; then
    printf 'G\t%s\n' "$1"
    return
  fi
  d=$1
  while :; do
    if [ -d "$d/.git" ]; then
      printf 'G\t%s\t%s\t\t%s\n' "$1" "$d" "$(head -n 1 "$d/.git/HEAD" 2>/dev/null)"
      return
    fi
    if [ -f "$d/.git" ]; then
      gitdir=$(sed -n 's/^gitdir: //p' "$d/.git" 2>/dev/null | head -n 1)
      case "$gitdir" in /*) ;; ?*) gitdir="$d/$gitdir" ;; esac
      common=$(head -n 1 "$gitdir/commondir" 2>/dev/null)
      case "$common" in /*|'') ;; *) common="$gitdir/$common" ;; esac
      printf 'G\t%s\t%s\t%s\t%s\n' "$1" "$d" "$common" "$(head -n 1 "$gitdir/HEAD" 2>/dev/null)"
      return
    fi
    case "$d" in /|'') break ;; esac
    d=${d%/*}
    [ -n "$d" ] || d=/
  done
  printf 'G\t%s\t\t\t\n' "$1"
}

{
  while IFS= read -r home; do
    if [ -d "$home/projects" ]; then
      find "$home/projects" -mindepth 2 -maxdepth 2 \( -type f -o -type l \) -name '*.jsonl' 2>/dev/null | awk '{ print "claude " $0 }'
    fi
  done < "$work/claude-homes"
  while IFS= read -r home; do
    for dir in "$home/sessions" "$home/archived_sessions"; do
      if [ -d "$dir" ]; then
        find "$dir" \( -type f -o -type l \) -name 'rollout-*.jsonl' 2>/dev/null | awk '{ print "codex " $0 }'
      fi
    done
  done < "$work/codex-homes"
} > "$work/files"

awk 'NR == FNR { want[$1] = $2; named[$1] = ($3 == "1"); next }
  {
    path = substr($0, length($1) + 2)
    name = path; sub(/.*\//, "", name); sub(/\.jsonl$/, "", name)
    # rollout-<19-character time>-<thread>, with _<rollout> after it once a thread has been reverted.
    if ($1 == "codex") { id = substr(name, 29); sub(/_.*/, "", id) } else id = name
    if ((id in want) && !(id in found)) { found[id] = 1; print $1, id, want[id], (named[id] ? 1 : 0), path }
  }' "$work/wanted" "$work/files" > "$work/matched"

while read -r agent id known named path; do
  # The home is the folder above Claude Code's projects, or above Codex's sessions.
  case $agent in
    claude) where=${path%/projects/*} ;;
    *) where=${path%/sessions/*}; where=${where%/archived_sessions/*} ;;
  esac
  printf 'W\t%s\t%s\n' "$id" "$where"
  size=$(wc -c < "$path" 2>/dev/null | tr -d ' ')
  if [ "$titles" = 1 ] && [ "$named" = 1 ] && [ "$agent" = claude ] && [ -n "$size" ] && [ "$size" = "$known" ]; then
    claude_titles "$path" "$id"
  fi
  [ -n "$size" ] && [ "$size" != "$known" ] || continue
  printf 'S\t%s\t%s\t%s\n' "$agent" "$id" "$size"
  if [ "$agent" = claude ]; then claude_file "$path"; else codex_file "$path"; fi
done < "$work/matched"

if [ "$titles" = 1 ]; then
  while IFS= read -r home; do
    if [ -f "$home/session_index.jsonl" ]; then
      awk 'NR == FNR { want[$1] = 1; next }
        match($0, /"id":"[^"]*"/) && (substr($0, RSTART + 6, RLENGTH - 7) in want) { print "N\t" $0 }' "$work/wanted" "$home/session_index.jsonl"
    fi
  done < "$work/codex-homes"
fi

# Codex 0.145 on keeps thread names in its state database. Only the branch is
# asked for, and the name with titles on; the query goes in on stdin, as it can be long. While
# Codex has the database open it reads read-only. Once Codex has closed it, a
# read-only open can't start, and nothing is writing, so it's read as it lies.
if command -v sqlite3 >/dev/null 2>&1; then
  awk -v titles="$titles" 'BEGIN {
      name = titles == 1 ? "coalesce(name, \047\047)" : "\047\047"
      printf "SELECT \047T\047 || char(9) || id || char(9) || json_quote(%s) || char(9) || json_quote(coalesce(git_branch, \047\047)) FROM threads WHERE id IN (", name
    }
    { printf "%s\047%s\047", (NR > 1 ? "," : ""), $1 }
    END { print ");" }' "$work/wanted" > "$work/names.sql"
  { if [ -n "${CODEX_SQLITE_HOME:-}" ]; then printf '%s\n' "$CODEX_SQLITE_HOME"; fi; cat "$work/codex-homes"; } | awk '!seen[$0]++' |
  while IFS= read -r home; do
    db="$home/state_5.sqlite"
    if [ -f "$db" ]; then
      sqlite3 -batch -init /dev/null -readonly -noheader -list -cmd '.timeout 2000' "$db" < "$work/names.sql" 2>/dev/null ||
        sqlite3 -batch -init /dev/null -noheader -list "file:$(printf '%s' "$db" | sed -e 's/%/%25/g' -e 's/ /%20/g' -e 's/?/%3F/g' -e 's/#/%23/g')?immutable=1" < "$work/names.sql" 2>/dev/null
    fi
  done
fi

sort -u "$work/cwds" | while IFS= read -r dir; do
  place_of "$dir"
done
"##;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum TranscriptAgent {
    #[default]
    Claude,
    Codex,
}

impl TranscriptAgent {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

/// A pull request a Claude Code session opened or worked on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequestLink {
    number: u64,
    url: String,
    /// "owner/name".
    repository: String,
}

impl PullRequestLink {
    pub(in crate::usage) fn number(&self) -> u64 {
        self.number
    }

    pub(in crate::usage) fn url(&self) -> &str {
        &self.url
    }

    /// "owner/name": as the transcript says, else from the address.
    pub(in crate::usage) fn repository(&self) -> Option<String> {
        owner_and_name(&self.repository).or_else(|| {
            let path = self.url.strip_prefix("https://")?.split_once('/')?.1;
            let (repository, _) = path.split_once("/pull/")?;
            owner_and_name(repository)
        })
    }
}

/// A compaction as the agent recorded it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptCompaction {
    at_ms: i64,
    /// "auto" or "manual" from Claude Code; empty from Codex, which doesn't record it.
    #[serde(default)]
    #[ts(type = r#""" | "auto" | "manual""#)]
    trigger: String,
    #[serde(default)]
    pre_tokens: Option<u64>,
    #[serde(default)]
    post_tokens: Option<u64>,
    #[serde(default)]
    duration_ms: Option<u64>,
}

impl TranscriptCompaction {
    pub(in crate::usage) fn at_ms(&self) -> i64 {
        self.at_ms
    }

    /// True when the user asked for it, which Claude Code records.
    pub(in crate::usage) fn is_manual(&self) -> bool {
        self.trigger == "manual"
    }
}

/// What a session called, by tool name alone: never what went into a call or came back.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolUsage {
    /// The session's own calls, by tool name.
    #[serde(default)]
    tools: BTreeMap<String, u64>,
    /// Its subagents' calls, by tool name. Claude Code keeps each subagent in a transcript of its own.
    #[serde(default)]
    subagent_tools: BTreeMap<String, u64>,
    /// The subagents it started, by the type each was asked for. Codex doesn't give them one.
    #[serde(default)]
    subagents: BTreeMap<String, u64>,
    /// The skills it and its subagents called for, by name, from Claude Code's Skill calls.
    #[serde(default)]
    skills: BTreeMap<String, u64>,
    /// Every skill it used, by name: called for by Claude Code's model, typed by a person, or
    /// picked in Codex. Missing from what was stored before Arbor noted them, so those
    /// transcripts are read again.
    #[serde(default)]
    used_skills: BTreeSet<String>,
}

impl ToolUsage {
    /// Adds a `count\tname` line to one of the lists. A name that isn't shaped like a tool's is left out.
    fn add(counts: &mut BTreeMap<String, u64>, fields: &str) {
        let Some((count, name)) = fields.split_once('\t') else {
            return;
        };
        let (Ok(count), Some(name)) = (count.trim().parse::<u64>(), tool_name(name)) else {
            return;
        };
        let total = counts.entry(name.to_string()).or_default();
        *total = total.saturating_add(count);
    }

    /// Keeps the most called names in each list, so an odd transcript can't swell the row.
    fn trim(&mut self) {
        for counts in [&mut self.tools, &mut self.subagent_tools, &mut self.subagents, &mut self.skills] {
            if counts.len() > TOOL_NAMES_KEPT {
                let mut ranked: Vec<(String, u64)> = std::mem::take(counts).into_iter().collect();
                ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
                ranked.truncate(TOOL_NAMES_KEPT);
                counts.extend(ranked);
            }
        }
        if self.used_skills.len() > TOOL_NAMES_KEPT {
            self.used_skills = std::mem::take(&mut self.used_skills).into_iter().take(TOOL_NAMES_KEPT).collect();
        }
    }
}

/// A tool or subagent type as the agents name them, like `Bash`,
/// `mcp__github__create_issue`, `collaboration/spawn_agent` or `general-purpose`.
/// Anything else is left out rather than shown.
fn tool_name(value: &str) -> Option<&str> {
    let value = value.trim();
    let shaped = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':' | '/' | '@');
    (!value.is_empty() && value.len() <= 200 && value.chars().all(shaped)).then_some(value)
}

/// One transcript as the scan read it.
#[derive(Debug, Default, PartialEq)]
struct TranscriptRead {
    agent: TranscriptAgent,
    session_id: String,
    size: u64,
    cwd: String,
    branch: String,
    commit_hash: String,
    repository_url: String,
    ai_title: String,
    custom_title: String,
    pull_requests: Vec<PullRequestLink>,
    lines: Option<(u64, u64)>,
    compactions: Vec<TranscriptCompaction>,
    tool_usage: ToolUsage,
}

/// The git checkout a folder is in, as the machine found it.
#[derive(Clone, Debug, PartialEq)]
enum FolderPlace {
    /// The folder isn't there any more, so where it was is unknown.
    Gone,
    Outside,
    Checkout {
        root: String,
        /// The main checkout's git directory, for a linked worktree.
        common_dir: String,
        head: String,
    },
}

#[derive(Debug, Default, PartialEq)]
struct ScanOutput {
    home: String,
    files: Vec<TranscriptRead>,
    /// Claude Code titles (its own, then the user's) of transcripts that hadn't changed, by session id.
    claude_titles: HashMap<String, (String, String)>,
    /// Codex thread names by session id. An empty one was cleared.
    titles: HashMap<String, String>,
    /// Codex threads' branches by session id, from its state database.
    branches: HashMap<String, String>,
    places: HashMap<String, FolderPlace>,
    /// The agent home each wanted transcript is in, by session id, as the machine writes it.
    agent_homes: HashMap<String, String>,
}

fn is_session_id(value: &str) -> bool {
    value.len() == 36
        && value.char_indices().all(|(index, c)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

fn capped(value: &str, chars: usize) -> String {
    value.trim().chars().take(chars).collect()
}

fn parse_time_ms(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value.trim()).ok().map(|time| time.timestamp_millis())
}

/// JSON fields printed bare, `"cwd":"…","gitBranch":"…"`, read as an object.
fn parse_fields(fragment: &str) -> Option<serde_json::Map<String, Value>> {
    match serde_json::from_str::<Value>(&format!("{{{fragment}}}")) {
        Ok(Value::Object(fields)) => Some(fields),
        _ => None,
    }
}

fn text_field(fields: &serde_json::Map<String, Value>, name: &str) -> String {
    fields.get(name).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn read_claude_record(file: &mut TranscriptRead, record: &str) {
    let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(record) else {
        return;
    };
    match fields.get("type").and_then(Value::as_str) {
        Some("ai-title") => file.ai_title = capped(&text_field(&fields, "aiTitle"), TITLE_CHARS),
        Some("custom-title") => file.custom_title = capped(&text_field(&fields, "customTitle"), TITLE_CHARS),
        Some("pr-link") => {
            let url = text_field(&fields, "prUrl");
            let number = fields.get("prNumber").and_then(Value::as_u64);
            if let Some(number) = number.filter(|_| url.starts_with("https://") && url.len() <= 2_048) {
                if file.pull_requests.len() < PULL_REQUESTS_KEPT && !file.pull_requests.iter().any(|pr| pr.url == url) {
                    file.pull_requests.push(PullRequestLink {
                        number,
                        url,
                        repository: capped(&text_field(&fields, "prRepository"), 200),
                    });
                }
            }
        }
        Some("cost-state") => {
            let added = fields.get("totalLinesAdded").and_then(Value::as_u64);
            let removed = fields.get("totalLinesRemoved").and_then(Value::as_u64);
            if let (Some(added), Some(removed)) = (added, removed) {
                file.lines = Some((added, removed));
            }
        }
        _ => {}
    }
}

fn parse_claude_compaction(fields: &str) -> Option<TranscriptCompaction> {
    let mut parts = fields.split('\t');
    let at_ms = parse_time_ms(parts.next()?)?;
    let trigger = parts.next().unwrap_or_default();
    let mut number = || parts.next().and_then(|value| value.parse::<u64>().ok());
    Some(TranscriptCompaction {
        at_ms,
        trigger: if matches!(trigger, "auto" | "manual") { trigger.to_string() } else { String::new() },
        pre_tokens: number(),
        post_tokens: number(),
        duration_ms: number(),
    })
}

fn read_folder_place(places: &mut HashMap<String, FolderPlace>, fields: &str) {
    let parts: Vec<&str> = fields.split('\t').collect();
    let Some(folder) = parts.first().filter(|folder| !folder.is_empty()) else {
        return;
    };
    let place = match parts.as_slice() {
        [_] => FolderPlace::Gone,
        [_, root, common_dir, head] if !root.is_empty() => FolderPlace::Checkout {
            root: root.to_string(),
            common_dir: common_dir.to_string(),
            head: head.trim().to_string(),
        },
        _ => FolderPlace::Outside,
    };
    places.insert(folder.to_string(), place);
}

fn parse_scan(stdout: &str) -> ScanOutput {
    let mut scan = ScanOutput::default();
    // Codex's index gains a line each time a thread is named, so the last one counts, and an
    // empty name clears it. The state database has the names from Codex 0.145 on, so it wins.
    let mut index_names = HashMap::<String, (String, String)>::new();
    let mut thread_names = HashMap::<String, String>::new();
    // The file the lines that follow an S line belong to. None after one that can't be used.
    let mut current: Option<usize> = None;
    for line in stdout.lines() {
        let Some((tag, rest)) = line.split_once('\t') else {
            continue;
        };
        match tag {
            "H" => scan.home = rest.trim().to_string(),
            "W" => {
                if let Some((id, home)) = rest.split_once('\t').filter(|(id, home)| is_session_id(id) && !home.is_empty()) {
                    scan.agent_homes.insert(id.to_string(), home.to_string());
                }
            }
            "S" => {
                let mut parts = rest.split('\t');
                current = None;
                let (Some(agent), Some(id), Some(size)) = (parts.next(), parts.next(), parts.next()) else {
                    continue;
                };
                if let Some(agent) = TranscriptAgent::parse(agent).filter(|_| is_session_id(id)) {
                    current = Some(scan.files.len());
                    scan.files.push(TranscriptRead {
                        agent,
                        session_id: id.to_string(),
                        size: size.trim().parse().unwrap_or(0),
                        ..TranscriptRead::default()
                    });
                }
            }
            "G" => read_folder_place(&mut scan.places, rest),
            "Q" => {
                let Some((id, record)) = rest.split_once('\t').filter(|(id, _)| is_session_id(id)) else {
                    continue;
                };
                // Only a title is taken from these, whatever else the record says.
                let mut read = TranscriptRead::default();
                read_claude_record(&mut read, record);
                let titles = scan.claude_titles.entry(id.to_string()).or_default();
                if !read.ai_title.is_empty() {
                    titles.0 = read.ai_title;
                }
                if !read.custom_title.is_empty() {
                    titles.1 = read.custom_title;
                }
            }
            "N" => {
                let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(rest) else {
                    continue;
                };
                let id = text_field(&fields, "id");
                let Some(name) = fields.get("thread_name").and_then(Value::as_str) else {
                    continue;
                };
                let updated = text_field(&fields, "updated_at");
                if is_session_id(&id) && index_names.get(&id).is_none_or(|(last, _)| *last <= updated) {
                    index_names.insert(id, (updated, capped(name, TITLE_CHARS)));
                }
            }
            "T" => {
                let mut parts = rest.split('\t');
                let (Some(id), Some(name), Some(branch)) = (parts.next(), parts.next(), parts.next()) else {
                    continue;
                };
                if !is_session_id(id) {
                    continue;
                }
                let text = |value: &str| serde_json::from_str::<String>(value).unwrap_or_default();
                let (name, branch) = (capped(&text(name), TITLE_CHARS), capped(&text(branch), 255));
                if !name.is_empty() {
                    thread_names.insert(id.to_string(), name);
                }
                if !branch.is_empty() {
                    scan.branches.insert(id.to_string(), branch);
                }
            }
            _ => {
                let Some(file) = current.and_then(|index| scan.files.get_mut(index)) else {
                    continue;
                };
                match (tag, file.agent) {
                    ("R", TranscriptAgent::Claude) => read_claude_record(file, rest),
                    ("K", TranscriptAgent::Claude) => file.compactions.extend(parse_claude_compaction(rest)),
                    ("P", TranscriptAgent::Claude) => {
                        if let Some(fields) = parse_fields(rest) {
                            file.cwd = capped(&text_field(&fields, "cwd"), PATH_CHARS);
                            file.branch = capped(&text_field(&fields, "gitBranch"), 255);
                        }
                    }
                    ("M", TranscriptAgent::Codex) => {
                        let Some(fields) = parse_fields(rest) else {
                            continue;
                        };
                        for (name, value) in fields {
                            let value = value.as_str().unwrap_or_default();
                            match name.as_str() {
                                // The first is the session's own; later ones sit inside its settings.
                                "cwd" if file.cwd.is_empty() => file.cwd = capped(value, PATH_CHARS),
                                "branch" if file.branch.is_empty() => file.branch = capped(value, 255),
                                "commit_hash" if file.commit_hash.is_empty() => file.commit_hash = capped(value, 64),
                                "repository_url" if file.repository_url.is_empty() => {
                                    file.repository_url = capped(value, 2_048);
                                }
                                _ => {}
                            }
                        }
                    }
                    ("C", TranscriptAgent::Codex) => {
                        if let Some(at_ms) = parse_time_ms(rest) {
                            file.compactions.push(TranscriptCompaction {
                                at_ms,
                                trigger: String::new(),
                                pre_tokens: None,
                                post_tokens: None,
                                duration_ms: None,
                            });
                        }
                    }
                    ("U", _) => ToolUsage::add(&mut file.tool_usage.tools, rest),
                    ("V", TranscriptAgent::Claude) => ToolUsage::add(&mut file.tool_usage.subagent_tools, rest),
                    ("A", TranscriptAgent::Claude) => ToolUsage::add(&mut file.tool_usage.subagents, rest),
                    ("L", TranscriptAgent::Claude) => ToolUsage::add(&mut file.tool_usage.skills, rest),
                    ("Y", _) => {
                        if let Some(name) = tool_name(rest) {
                            file.tool_usage.used_skills.insert(name.to_string());
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    for file in &mut scan.files {
        file.tool_usage.trim();
    }
    scan.titles = index_names.into_iter().map(|(id, (_, name))| (id, name)).collect();
    scan.titles.extend(thread_names);
    scan
}

/// An absolute path with `.` and `..` folded away, without touching the disk.
fn normalize_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

/// The main checkout of a linked worktree, from its common git directory:
/// `/src/app/.git` is `/src/app`'s, and a bare repository is its own.
fn main_checkout(root: &str, common_dir: &str) -> String {
    if common_dir.is_empty() {
        return root.to_string();
    }
    let common = normalize_path(common_dir);
    match common.strip_suffix("/.git") {
        Some(main) if !main.is_empty() => main.to_string(),
        _ => common,
    }
}

/// The branch HEAD is on, or None when it's detached.
fn head_branch(head: &str) -> Option<&str> {
    head.strip_prefix("ref: refs/heads/").map(str::trim).filter(|branch| !branch.is_empty())
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// How much a skill was used in the sessions active lately, by the name it was used by.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillUsage {
    name: String,
    /// The sessions that used it, whether a model called for it or a person typed or picked it.
    sessions: u64,
    /// The times Claude Code's model called for it.
    calls: u64,
    /// When the latest of those sessions was last active.
    last_ms: i64,
    /// Its sessions by the machine each ran on.
    machines: BTreeMap<String, u64>,
}

#[derive(Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillUsageReport {
    /// The most called first.
    skills: Vec<SkillUsage>,
    /// Sessions active in the window whose transcripts have been read for skills.
    counted: u64,
    /// Those still to be read for them, which are read a few at a time.
    pending: u64,
}

/// The skills the sessions active since `since_ms` used, from what their transcripts gave.
pub(in crate::usage) fn load_skill_usage(connection: &Connection, since_ms: i64) -> Result<SkillUsageReport, String> {
    let mut statement = connection
        .prepare(
            "SELECT transcript.machine, transcript.tool_usage, recent.last_ms
             FROM (
                 SELECT session_id, MAX(timestamp_ms) AS last_ms FROM usage_events
                 WHERE timestamp_ms >= ?1 AND session_id <> ''
                 GROUP BY session_id
             ) recent
             JOIN usage_session_transcripts transcript ON transcript.session_id = recent.session_id",
        )
        .map_err(|error| format!("Failed to prepare the skills query: {error}"))?;
    let rows = statement
        .query_map([since_ms], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?)))
        .map_err(|error| format!("Failed to query the skills sessions called for: {error}"))?;
    let mut report = SkillUsageReport::default();
    let mut skills: HashMap<String, SkillUsage> = HashMap::new();
    for row in rows {
        let (machine, usage, last_ms) = row.map_err(|error| format!("Failed to read the skills sessions called for: {error}"))?;
        // Stored before skills were counted, so not known yet.
        let Some(usage) = usage.filter(|json| json.contains("\"usedSkills\":")).and_then(|json| serde_json::from_str::<ToolUsage>(&json).ok()) else {
            report.pending += 1;
            continue;
        };
        report.counted += 1;
        let used: BTreeSet<&String> = usage.used_skills.iter().chain(usage.skills.keys()).collect();
        for name in used {
            let skill = skills.entry(name.clone()).or_insert_with(|| SkillUsage { name: name.clone(), ..SkillUsage::default() });
            skill.sessions += 1;
            skill.calls = skill.calls.saturating_add(usage.skills.get(name).copied().unwrap_or(0));
            skill.last_ms = skill.last_ms.max(last_ms);
            *skill.machines.entry(machine.clone()).or_default() += 1;
        }
    }
    report.skills = skills.into_values().collect();
    report.skills.sort_by(|a, b| b.sessions.cmp(&a.sessions).then_with(|| b.calls.cmp(&a.calls)).then_with(|| a.name.cmp(&b.name)));
    Ok(report)
}

/// The skills sessions used in the last `days` days.
#[tauri::command]
pub(crate) async fn get_skill_usage(days: u32) -> Result<SkillUsageReport, String> {
    let since_ms = Local::now().timestamp_millis() - i64::from(days.clamp(1, 90)) * 86_400_000;
    run_usage_task(move || load_skill_usage(&open_usage_database()?, since_ms)).await
}

/// The MCP server a tool is from, as the tool's name gives it: `mcp__github__create_issue` is
/// github's, a plugin's server gives `plugin_<plugin>_<server>`, and Codex names its apps' tools
/// `mcp__codex_apps__github/_create_pull_request`.
fn mcp_server(tool: &str) -> Option<&str> {
    let rest = tool.strip_prefix("mcp__")?;
    let end = [rest.find("__"), rest.find('/')].into_iter().flatten().min()?;
    (end > 0).then(|| &rest[..end])
}

/// A plugin's name as Claude Code puts it in its MCP servers' tool names.
fn tool_safe(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '-') { c } else { '_' }).collect()
}

/// How much an MCP server or a plugin was used in the sessions active lately.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtensionUsage {
    /// A server as its tools' names give it, or a plugin's name.
    name: String,
    sessions: u64,
    /// Calls to its tools, and for a plugin to its skills, by sessions and their subagents.
    calls: u64,
    /// When the latest of those sessions was last active.
    last_ms: i64,
    /// Its sessions by the machine each ran on.
    machines: BTreeMap<String, u64>,
}

impl ExtensionUsage {
    fn count(found: &mut HashMap<String, ExtensionUsage>, name: &str, calls: u64, machine: &str, last_ms: i64) {
        let usage = found.entry(name.to_string()).or_insert_with(|| ExtensionUsage { name: name.to_string(), ..ExtensionUsage::default() });
        usage.sessions += 1;
        usage.calls = usage.calls.saturating_add(calls);
        usage.last_ms = usage.last_ms.max(last_ms);
        *usage.machines.entry(machine.to_string()).or_default() += 1;
    }

    fn ranked(found: HashMap<String, ExtensionUsage>) -> Vec<ExtensionUsage> {
        let mut ranked: Vec<ExtensionUsage> = found.into_values().collect();
        ranked.sort_by(|a, b| b.sessions.cmp(&a.sessions).then_with(|| b.calls.cmp(&a.calls)).then_with(|| a.name.cmp(&b.name)));
        ranked
    }
}

#[derive(Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpUsageReport {
    /// The most used first.
    servers: Vec<ExtensionUsage>,
    /// The plugins asked about that were used, the most used first.
    plugins: Vec<ExtensionUsage>,
    /// Sessions active in the window whose transcripts have been read for tools.
    counted: u64,
    /// Those not read yet.
    pending: u64,
}

/// The MCP servers the sessions active since `since_ms` called, and which of `plugins` they
/// used: a plugin's server's tools, or its skills or subagents, which go by `<plugin>:<name>`.
pub(in crate::usage) fn load_mcp_usage(connection: &Connection, since_ms: i64, plugins: &[String]) -> Result<McpUsageReport, String> {
    let mut statement = connection
        .prepare(
            "SELECT transcript.machine, transcript.tool_usage, recent.last_ms
             FROM (
                 SELECT session_id, MAX(timestamp_ms) AS last_ms FROM usage_events
                 WHERE timestamp_ms >= ?1 AND session_id <> ''
                 GROUP BY session_id
             ) recent
             JOIN usage_session_transcripts transcript ON transcript.session_id = recent.session_id",
        )
        .map_err(|error| format!("Failed to prepare the MCP servers query: {error}"))?;
    let rows = statement
        .query_map([since_ms], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?)))
        .map_err(|error| format!("Failed to query the MCP servers sessions called: {error}"))?;
    let plugins: Vec<(&String, String, String)> = plugins
        .iter()
        .filter(|name| tool_name(name).is_some_and(|name| !name.contains(':')))
        .take(500)
        .map(|name| (name, format!("mcp__plugin_{}_", tool_safe(name)), format!("{name}:")))
        .collect();
    let mut report = McpUsageReport::default();
    let (mut servers, mut used_plugins) = (HashMap::new(), HashMap::new());
    for row in rows {
        let (machine, usage, last_ms) = row.map_err(|error| format!("Failed to read the MCP servers sessions called: {error}"))?;
        let Some(usage) = usage.and_then(|json| serde_json::from_str::<ToolUsage>(&json).ok()) else {
            report.pending += 1;
            continue;
        };
        report.counted += 1;
        let tools = || usage.tools.iter().chain(&usage.subagent_tools);
        let mut calls: BTreeMap<&str, u64> = BTreeMap::new();
        for (tool, count) in tools() {
            if let Some(server) = mcp_server(tool) {
                let total = calls.entry(server).or_default();
                *total = total.saturating_add(*count);
            }
        }
        for (server, count) in calls {
            ExtensionUsage::count(&mut servers, server, count, &machine, last_ms);
        }
        for (name, tool_prefix, prefix) in &plugins {
            let tool_calls: u64 = tools().filter(|(tool, _)| tool.starts_with(tool_prefix.as_str())).map(|(_, count)| *count).sum();
            let skill_calls: u64 = usage.skills.iter().filter(|(skill, _)| skill.starts_with(prefix.as_str())).map(|(_, count)| *count).sum();
            let used = tool_calls > 0
                || skill_calls > 0
                || usage.used_skills.iter().chain(usage.subagents.keys()).any(|used| used.starts_with(prefix.as_str()));
            if used {
                ExtensionUsage::count(&mut used_plugins, name, tool_calls.saturating_add(skill_calls), &machine, last_ms);
            }
        }
    }
    report.servers = ExtensionUsage::ranked(servers);
    report.plugins = ExtensionUsage::ranked(used_plugins);
    Ok(report)
}

/// The MCP servers sessions called in the last `days` days, and which of `plugins` they used.
#[tauri::command]
pub(crate) async fn get_mcp_usage(days: u32, plugins: Vec<String>) -> Result<McpUsageReport, String> {
    let since_ms = Local::now().timestamp_millis() - i64::from(days.clamp(1, 90)) * 86_400_000;
    run_usage_task(move || load_mcp_usage(&open_usage_database()?, since_ms, &plugins)).await
}

/// Where a session ran and what it was called, as the Sessions page shows it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionTranscript {
    /// The machine its transcript is on, as the Machines page names it.
    machine: String,
    agent: String,
    /// That machine's home directory, so the page can shorten paths under it.
    home: String,
    /// The agent home the transcript is in, under ~ as Setup writes homes: `~/.claude`, or another home on the machine's agent homes list.
    /// Empty until a scan has said.
    agent_home: String,
    /// The folder the session was last working in.
    cwd: String,
    /// The top of the git checkout the folder is in. Empty outside git or when unknown.
    repo_root: String,
    /// The main checkout, which differs from `repo_root` in a linked worktree.
    main_repo: String,
    branch: String,
    commit_hash: String,
    repository_url: String,
    title: String,
    /// "custom" when the user named the session, "ai" when Claude Code did, "codex" for a Codex thread name.
    #[ts(type = r#""" | "custom" | "ai" | "codex""#)]
    title_source: String,
    pull_requests: Vec<PullRequestLink>,
    lines_added: Option<u64>,
    lines_removed: Option<u64>,
    compactions: Vec<TranscriptCompaction>,
    /// None until the transcript has been read since Arbor began counting tool calls.
    tool_usage: Option<ToolUsage>,
    /// When the transcript was last read.
    read_at_ms: i64,
}

impl SessionTranscript {
    pub(in crate::usage) fn compactions(&self) -> &[TranscriptCompaction] {
        &self.compactions
    }

    pub(in crate::usage) fn machine(&self) -> &str {
        &self.machine
    }

    pub(in crate::usage) fn branch(&self) -> &str {
        &self.branch
    }

    pub(in crate::usage) fn has_pull_requests(&self) -> bool {
        !self.pull_requests.is_empty()
    }

    pub(in crate::usage) fn pull_requests(&self) -> &[PullRequestLink] {
        &self.pull_requests
    }

    /// The lines the session added and removed. Claude Code counts them; Codex doesn't.
    pub(in crate::usage) fn lines(&self) -> Option<(u64, u64)> {
        self.lines_added.zip(self.lines_removed)
    }

    /// "owner/name" of the repository the session worked in, from its remote,
    /// else from the first pull request it opened.
    pub(in crate::usage) fn repository(&self) -> Option<String> {
        repository_name(&self.repository_url)
            .or_else(|| self.pull_requests.first().map(|link| link.repository.clone()))
            .filter(|repository| !repository.is_empty())
    }

    /// The project the Sessions page files the session under, as
    /// `sessionPlace` in usageSessions.ts names it: the repository's name, else
    /// the main checkout's folder, else the folder's own. None when the
    /// transcript doesn't say where the session ran.
    pub(in crate::usage) fn project(&self) -> Option<String> {
        if self.cwd.is_empty() {
            return None;
        }
        let project = match self.repository() {
            Some(repository) => last_segment(&repository).to_string(),
            None => {
                let checkout = if self.main_repo.is_empty() { &self.repo_root } else { &self.main_repo };
                let folder = last_segment(if checkout.is_empty() { &self.cwd } else { checkout });
                folder.strip_suffix(".git").unwrap_or(folder).to_string()
            }
        };
        if !project.is_empty() {
            return Some(project);
        }
        // Only a root folder has no name: the folder itself, with the home directory as ~.
        let home = self.home.trim_end_matches('/');
        Some(match self.cwd.strip_prefix(home) {
            Some(rest) if !home.is_empty() && (rest.is_empty() || rest.starts_with('/')) => format!("~{rest}"),
            _ => self.cwd.clone(),
        })
    }

    /// What search looks through: the title, the folder, branch and
    /// repository, and each pull request by number and address.
    pub(in crate::usage) fn search_text(&self) -> String {
        let mut text = [
            self.title.as_str(),
            self.cwd.as_str(),
            self.branch.as_str(),
            self.repository_url.as_str(),
        ]
        .join("\n");
        for link in &self.pull_requests {
            text.push_str(&format!("\n#{} {} {}", link.number, link.url, link.repository));
        }
        text
    }
}

fn last_segment(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or_default()
}

/// `owner/name` from a git remote, like `repositoryName` in usageSessions.ts:
/// `git@github.com:owner/name.git`, `https://github.com/owner/name`.
pub(crate) fn repository_name(url: &str) -> Option<String> {
    let url = url.trim();
    let is_scheme = |scheme: &str| {
        !scheme.is_empty() && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '.' | '-'))
    };
    // scheme://[user@]host/owner/name
    let address = url
        .split_once("://")
        .filter(|(scheme, _)| is_scheme(scheme))
        .and_then(|(_, rest)| rest.split_once('/'))
        .filter(|(host, _)| !host.is_empty())
        .and_then(|(_, path)| owner_and_name(path));
    address.or_else(|| {
        // user@host:owner/name
        let (user, rest) = url.split_once('@')?;
        let (host, path) = rest.split_once(':')?;
        let blank = |part: &str| part.is_empty() || part.chars().any(char::is_whitespace);
        if blank(user) || blank(host) {
            return None;
        }
        owner_and_name(path)
    })
}

/// A path of exactly two parts, without a trailing `.git` or slash.
fn owner_and_name(path: &str) -> Option<String> {
    let (owner, name) = path.strip_suffix('/').unwrap_or(path).split_once('/')?;
    let name = match name.strip_suffix(".git") {
        Some(stem) if !stem.is_empty() => stem,
        _ => name,
    };
    let part = |part: &str| !part.is_empty() && !part.contains('/') && !part.chars().any(char::is_whitespace);
    (part(owner) && part(name)).then(|| format!("{owner}/{name}"))
}

fn row_transcript(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, u64, SessionTranscript)> {
    let json = |index: usize| -> rusqlite::Result<String> { row.get::<_, String>(index) };
    Ok((
        row.get(0)?,
        row.get::<_, i64>(3).map(|size| u64::try_from(size).unwrap_or(0))?,
        SessionTranscript {
            machine: row.get(1)?,
            agent: row.get(2)?,
            read_at_ms: row.get(4)?,
            home: row.get(5)?,
            cwd: row.get(6)?,
            repo_root: row.get(7)?,
            main_repo: row.get(8)?,
            branch: row.get(9)?,
            commit_hash: row.get(10)?,
            repository_url: row.get(11)?,
            // Only ever from memory (`put_titles`): usage.db's title columns are never read or written.
            title: String::new(),
            title_source: String::new(),
            pull_requests: serde_json::from_str(&json(12)?).unwrap_or_default(),
            lines_added: row.get::<_, Option<i64>>(13)?.and_then(|value| u64::try_from(value).ok()),
            lines_removed: row.get::<_, Option<i64>>(14)?.and_then(|value| u64::try_from(value).ok()),
            compactions: serde_json::from_str(&json(15)?).unwrap_or_default(),
            tool_usage: row.get::<_, Option<String>>(16)?.and_then(|json| serde_json::from_str(&json).ok()),
            agent_home: row.get(17)?,
        },
    ))
}

/// Every column read and written. `title` and `title_source` are left out: an older Arbor kept titles there, and
/// they're only ever held in memory now.
const TRANSCRIPT_COLUMNS: &str = "session_id, machine, agent, file_size, read_at_ms, home, cwd, repo_root, main_repo, \
     branch, commit_hash, repository_url, pull_requests, lines_added, lines_removed, compactions, tool_usage, \
     agent_home";

/// The transcripts known for these sessions, by session id.
pub(in crate::usage) fn load_session_transcripts(
    connection: &Connection,
    ids: &[&str],
) -> Result<HashMap<String, SessionTranscript>, String> {
    let mut found = HashMap::new();
    for batch in ids.chunks(500) {
        let sql = format!(
            "SELECT {TRANSCRIPT_COLUMNS} FROM usage_session_transcripts WHERE session_id IN ({})",
            vec!["?"; batch.len()].join(", ")
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("Failed to prepare session transcripts query: {error}"))?;
        let rows = statement
            .query_map(params_from_iter(batch.iter()), row_transcript)
            .map_err(|error| format!("Failed to query session transcripts: {error}"))?;
        for row in rows {
            let (id, _, transcript) = row.map_err(|error| format!("Failed to read session transcripts: {error}"))?;
            found.insert(id, transcript);
        }
    }
    put_titles(&title_memory(), &mut found);
    Ok(found)
}

/// The transcripts that name a pull request or were on one of `branches`, by session id.
pub(in crate::usage) fn load_linked_transcripts(
    connection: &Connection,
    branches: &[&str],
) -> Result<HashMap<String, SessionTranscript>, String> {
    let sql = format!(
        "SELECT {TRANSCRIPT_COLUMNS} FROM usage_session_transcripts WHERE pull_requests <> '[]' OR branch IN (SELECT value FROM json_each(?1))"
    );
    let branches = serde_json::to_string(branches).map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare session transcripts query: {error}"))?;
    let rows = statement
        .query_map([branches], row_transcript)
        .map_err(|error| format!("Failed to query session transcripts: {error}"))?;
    let mut found = HashMap::new();
    for row in rows {
        let (id, _, transcript) = row.map_err(|error| format!("Failed to read session transcripts: {error}"))?;
        found.insert(id, transcript);
    }
    put_titles(&title_memory(), &mut found);
    Ok(found)
}

/// The sessions to ask `machine` about, with the size each transcript had when
/// it was last read there: recent sessions found there before, and recent ones
/// not found anywhere yet (size 0). Sessions found on another of the `scanned`
/// machines are left to that one. Those found on a machine Arbor no longer scans,
/// because it was renamed or removed, are looked for again. So are some whose
/// tool calls, or the skills they used, haven't been counted, as if they'd never
/// been read.
fn wanted_sessions(connection: &Connection, machine: &str, scanned: &[String], now_ms: i64) -> Result<Vec<(String, u64)>, String> {
    let scanned_list = (0..scanned.len()).map(|index| format!("?{}", index + 4)).collect::<Vec<_>>().join(", ");
    let mut statement = connection
        .prepare(&format!(
            "SELECT recent.session_id, CASE WHEN transcript.machine = ?2 THEN transcript.file_size ELSE 0 END,
                 COALESCE(transcript.machine = ?2
                     AND (transcript.tool_usage IS NULL OR instr(transcript.tool_usage, '\"usedSkills\":') = 0), 0)
             FROM (
                 SELECT session_id, MAX(timestamp_ms) AS last_ms FROM usage_events
                 WHERE timestamp_ms >= ?1 AND session_id <> '' AND (parent_session_id IS NULL OR parent_session_id = '')
                 GROUP BY session_id
             ) recent
             LEFT JOIN usage_session_transcripts transcript ON transcript.session_id = recent.session_id
             WHERE transcript.session_id IS NULL OR transcript.machine = ?2 OR transcript.machine NOT IN ({scanned_list})
             ORDER BY recent.last_ms DESC
             LIMIT ?3"
        ))
        .map_err(|error| format!("Failed to prepare the sessions to look up: {error}"))?;
    let mut values: Vec<rusqlite::types::Value> =
        vec![(now_ms - LOOKBACK_MS).into(), machine.to_string().into(), (WANTED_LIMIT as i64).into()];
    values.extend(scanned.iter().cloned().map(Into::into));
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)? != 0))
        })
        .map_err(|error| format!("Failed to query the sessions to look up: {error}"))?;
    let mut wanted = Vec::new();
    // Where in `wanted` the transcripts read before tool calls were counted are.
    let mut uncounted = Vec::new();
    for row in rows {
        let (id, size, tools_uncounted) = row.map_err(|error| format!("Failed to read the sessions to look up: {error}"))?;
        // Only ids that can't mean anything to the shell go into the script.
        if is_session_id(&id) {
            if tools_uncounted {
                uncounted.push(wanted.len());
            }
            wanted.push((id, u64::try_from(size).unwrap_or(0)));
        }
    }
    for index in re_reads(uncounted.len(), RE_READS_PER_SCAN, now_ms) {
        wanted[uncounted[index]].1 = 0;
    }
    Ok(wanted)
}

/// Which of `count` transcripts waiting to be read again get read in the scan at
/// `now_ms`: `per_scan` of them, starting further along each scan, so one that's
/// no longer on the machine can't keep its place for good.
fn re_reads(count: usize, per_scan: usize, now_ms: i64) -> Vec<usize> {
    if count <= per_scan {
        return (0..count).collect();
    }
    let scan = usize::try_from(now_ms.max(0) / SCAN_INTERVAL_MS).unwrap_or(0);
    let start = scan.wrapping_mul(per_scan) % count;
    (0..per_scan).map(|offset| (start + offset) % count).collect()
}

/// The scan of `machine`'s homes, for the sessions in `wanted`. `looked_up` is None while Session titles is off, so no
/// title is read; on, it's the sessions already looked through for titles, which an unchanged transcript isn't again.
fn scan_script(machine: &str, wanted: &[(String, u64)], looked_up: Option<&BTreeSet<String>>) -> String {
    let homes = agent_homes::shell_function(machine, HomeUse::Sessions);
    let mut script = String::with_capacity(homes.len() + SCRIPT_HEAD.len() + SCRIPT_BODY.len() + wanted.len() * 50 + 16);
    script.push_str(&homes);
    script.push_str(if looked_up.is_some() { "titles=1\n" } else { "titles=0\n" });
    script.push_str(SCRIPT_HEAD);
    for (id, size) in wanted {
        script.push_str(id);
        script.push(' ');
        script.push_str(&size.to_string());
        script.push_str(if looked_up.is_some_and(|looked_up| !looked_up.contains(id)) { " 1\n" } else { " 0\n" });
    }
    script.push_str(SCRIPT_BODY);
    script
}

/// Folds a scan into what's stored for `machine`, and returns how many sessions changed.
fn store_scan(connection: &mut Connection, machine: &str, scan: &ScanOutput, now_ms: i64) -> Result<usize, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start storing session transcripts: {error}"))?;
    let mut changed = 0;
    let mut read = HashSet::new();
    for file in &scan.files {
        read.insert(file.session_id.as_str());
        let previous = transaction
            .query_row(
                &format!("SELECT {TRANSCRIPT_COLUMNS} FROM usage_session_transcripts WHERE session_id = ?1"),
                params![file.session_id],
                row_transcript,
            )
            .optional()
            .map_err(|error| format!("Failed to read a stored session transcript: {error}"))?
            .map(|(_, _, transcript)| transcript);
        let next = merge_transcript(previous.as_ref(), machine, &scan.home, file, scan, now_ms);
        if previous.as_ref().is_some_and(|previous| same_except_read_time(previous, &next)) {
            // Only its size changed: keep the size, so the next scan skips it.
            transaction
                .execute(
                    "UPDATE usage_session_transcripts SET file_size = ?2, read_at_ms = ?3 WHERE session_id = ?1",
                    params![file.session_id, file.size as i64, now_ms],
                )
                .map_err(|error| format!("Failed to store a session transcript: {error}"))?;
            continue;
        }
        write_transcript(&transaction, &file.session_id, file.size, &next)?;
        changed += 1;
    }
    // Every transcript found says which agent home it's in, whether it was read or not, and that isn't a change
    // anyone is told about. Written after the rows above, which a read replaces whole.
    for (id, agent_home) in &scan.agent_homes {
        let agent_home = tilde(agent_home, &scan.home);
        transaction
            .execute(
                "UPDATE usage_session_transcripts SET agent_home = ?2 WHERE session_id = ?1 AND machine = ?3 AND agent_home <> ?2",
                params![id, agent_home, machine],
            )
            .map_err(|error| format!("Failed to store a session's agent home: {error}"))?;
    }
    // A Codex thread's branch can arrive without its transcript growing, when nothing else said which it was.
    // Its name is only ever held in memory (`remember_titles`).
    for (id, branch) in &scan.branches {
        if read.contains(id.as_str()) {
            continue;
        }
        changed += transaction
            .execute(
                "UPDATE usage_session_transcripts SET branch = ?2
                 WHERE session_id = ?1 AND machine = ?3 AND agent = 'codex' AND branch = ''",
                params![id, branch, machine],
            )
            .map_err(|error| format!("Failed to store a session branch: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to store session transcripts: {error}"))?;
    Ok(changed)
}

fn same_except_read_time(previous: &SessionTranscript, next: &SessionTranscript) -> bool {
    SessionTranscript { read_at_ms: 0, ..previous.clone() } == SessionTranscript { read_at_ms: 0, ..next.clone() }
}

/// What a freshly read transcript says, with what it can't say kept from before.
fn merge_transcript(
    previous: Option<&SessionTranscript>,
    machine: &str,
    home: &str,
    file: &TranscriptRead,
    scan: &ScanOutput,
    now_ms: i64,
) -> SessionTranscript {
    let same_folder = previous.filter(|previous| previous.cwd == file.cwd);
    let (repo_root, main_repo, checkout_branch) = match scan.places.get(&file.cwd) {
        Some(FolderPlace::Checkout { root, common_dir, head }) => (
            root.clone(),
            main_checkout(root, common_dir),
            head_branch(head).unwrap_or_default().to_string(),
        ),
        Some(FolderPlace::Outside) => Default::default(),
        // A folder that's gone keeps the checkout it was last seen in.
        _ => same_folder.map_or_else(Default::default, |previous| {
            (previous.repo_root.clone(), previous.main_repo.clone(), String::new())
        }),
    };
    // Codex seldom writes down the branch; its state database may have it.
    let thread_branch = scan.branches.get(&file.session_id).map_or("", String::as_str);
    let branch = [file.branch.as_str(), thread_branch, checkout_branch.as_str()]
        .into_iter()
        .find(|branch| !branch.is_empty())
        .map(str::to_string)
        .or_else(|| same_folder.map(|previous| previous.branch.clone()))
        .unwrap_or_default();
    let keep = |value: &str, old: fn(&SessionTranscript) -> &String| {
        if value.is_empty() {
            previous.map(|previous| old(previous).clone()).unwrap_or_default()
        } else {
            value.to_string()
        }
    };
    SessionTranscript {
        machine: machine.to_string(),
        agent: file.agent.as_str().to_string(),
        home: keep(home, |previous| &previous.home),
        agent_home: keep(
            &scan.agent_homes.get(&file.session_id).map(|agent_home| tilde(agent_home, &scan.home)).unwrap_or_default(),
            |previous| &previous.agent_home,
        ),
        cwd: keep(&file.cwd, |previous| &previous.cwd),
        repo_root,
        main_repo,
        branch,
        commit_hash: keep(&file.commit_hash, |previous| &previous.commit_hash),
        repository_url: keep(&file.repository_url, |previous| &previous.repository_url),
        // Never stored: titles are only held in memory, while Session titles is on.
        title: String::new(),
        title_source: String::new(),
        pull_requests: file.pull_requests.clone(),
        lines_added: file.lines.map(|(added, _)| added).or(previous.and_then(|previous| previous.lines_added)),
        lines_removed: file.lines.map(|(_, removed)| removed).or(previous.and_then(|previous| previous.lines_removed)),
        // The whole transcript was read, so its compactions and tool calls are all here.
        compactions: file.compactions.clone(),
        tool_usage: Some(file.tool_usage.clone()),
        read_at_ms: now_ms,
    }
}

fn write_transcript(transaction: &Transaction<'_>, session_id: &str, size: u64, transcript: &SessionTranscript) -> Result<(), String> {
    let pull_requests = serde_json::to_string(&transcript.pull_requests).unwrap_or_else(|_| "[]".into());
    let compactions = serde_json::to_string(&transcript.compactions).unwrap_or_else(|_| "[]".into());
    let tool_usage = transcript.tool_usage.as_ref().and_then(|usage| serde_json::to_string(usage).ok());
    transaction
        .execute(
            &format!(
                "INSERT OR REPLACE INTO usage_session_transcripts ({TRANSCRIPT_COLUMNS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)"
            ),
            params![
                session_id,
                transcript.machine,
                transcript.agent,
                size as i64,
                transcript.read_at_ms,
                transcript.home,
                transcript.cwd,
                transcript.repo_root,
                transcript.main_repo,
                transcript.branch,
                transcript.commit_hash,
                transcript.repository_url,
                pull_requests,
                transcript.lines_added.map(|value| value as i64),
                transcript.lines_removed.map(|value| value as i64),
                compactions,
                tool_usage,
                transcript.agent_home,
            ],
        )
        .map(|_| ())
        .map_err(|error| format!("Failed to store a session transcript: {error}"))
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/// How a machine's transcript scans are going.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct TranscriptScans {
    scanned_at: Option<i64>,
    scanning: bool,
    error: Option<String>,
}

/// Which machine a scan is for: one on the Machines page, or this one when it isn't there.
#[derive(Clone, Debug, PartialEq)]
enum ScanTarget {
    Series(String),
    ThisMachine,
}

fn due(scans: &TranscriptScans, now_ms: i64) -> bool {
    !scans.scanning && scans.scanned_at.is_none_or(|at| now_ms - at >= SCAN_INTERVAL_MS)
}

/// Every machine whose transcripts Arbor reads, whether or not it's answering right now.
fn scanned_machines(state: &MachineHealthState) -> Vec<String> {
    let inner = state.lock();
    let mut names: Vec<String> = inner
        .series
        .values()
        .filter(|series| series.host.enabled)
        .map(|series| series.host.machine.clone())
        .collect();
    names.extend(this_machine_name(&inner));
    names
}

/// Machines that answered their last sample and haven't been scanned for a while, marked as
/// being scanned. This machine is scanned too when the Machines page doesn't list it.
fn take_due(state: &MachineHealthState, now_ms: i64) -> Vec<(ScanTarget, Machine)> {
    let mut inner = state.lock();
    let mut targets: Vec<(ScanTarget, Machine)> = inner
        .series
        .values_mut()
        .filter(|series| series.host.enabled && series.error.is_none() && series.last_ok_at.is_some())
        .filter(|series| due(&series.transcripts, now_ms))
        .map(|series| {
            series.transcripts.scanning = true;
            (ScanTarget::Series(series.host.machine.clone()), Machine::listed(series))
        })
        .collect();
    if let Some(name) = this_machine_name(&inner).filter(|_| due(&inner.local_transcripts, now_ms)) {
        inner.local_transcripts.scanning = true;
        targets.push((ScanTarget::ThisMachine, Machine::this_mac(&name)));
    }
    targets
}

fn record_scan(state: &MachineHealthState, target: &ScanTarget, host: &MachineHost, at_ms: i64, error: Option<String>) {
    let mut inner = state.lock();
    let scans = match target {
        ScanTarget::Series(machine) => match inner.series.get_mut(machine) {
            Some(series) if series.host.endpoint == host.endpoint && series.host.port == host.port => &mut series.transcripts,
            _ => return,
        },
        ScanTarget::ThisMachine => &mut inner.local_transcripts,
    };
    scans.scanning = false;
    scans.scanned_at = Some(at_ms);
    scans.error = error;
}

async fn scan_machine(target: &Machine, scanned: Vec<String>, now_ms: i64) -> Result<usize, String> {
    let machine = target.name();
    let wanted = {
        let machine = machine.to_string();
        run_usage_task(move || wanted_sessions(&open_usage_database()?, &machine, &scanned, now_ms)).await?
    };
    if wanted.is_empty() {
        return Ok(0);
    }
    // Titles are asked for only while they're on, and kept only if they're still on, unswitched, when the scan ends.
    let epoch = TITLE_EPOCH.load(Ordering::SeqCst);
    let script = {
        let memory = title_memory();
        scan_script(machine, &wanted, titles_on().then_some(&memory.looked_up))
    };
    let scan = parse_scan(&run_checked(target, MachineOp::TranscriptScan, &script, SCAN_TIMEOUT).await?);
    let retitled = remember_scan_titles(&scan, epoch);
    let machine = machine.to_string();
    let stored = run_usage_task(move || {
        let _write_guard = lock_usage_writes();
        store_scan(&mut open_usage_database()?, &machine, &scan, now_ms)
    })
    .await?;
    Ok(stored + retitled)
}

/// Starts a scan on each machine that's due for one. Called after every health round.
pub(super) fn scan_due(app: &tauri::AppHandle, state: &MachineHealthState, now_ms: i64) {
    let scanned = scanned_machines(state);
    let targets = take_due(state, now_ms);
    let count = targets.len();
    for (index, (target, machine)) in targets.into_iter().enumerate() {
        let app = app.clone();
        let scanned = scanned.clone();
        tauri::async_runtime::spawn(async move {
            let delay = super::scan_wave_delay(index, count, Duration::from_millis(SCAN_INTERVAL_MS as u64));
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            let result = scan_machine(&machine, scanned, now_ms).await;
            if let Err(error) = &result {
                eprintln!("Could not read session transcripts on {}: {error}", machine.name());
            }
            let at_ms = Local::now().timestamp_millis();
            record_scan(&app.state::<MachineHealthState>(), &target, machine.host(), at_ms, result.as_ref().err().cloned());
            if result.is_ok_and(|changed| changed > 0) {
                let _ = app.emit(SESSION_TRANSCRIPTS_UPDATED_EVENT, at_ms);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::schema::insert_request;

    const CLAUDE_ID: &str = "a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7";
    const CODEX_ID: &str = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";

    fn host(name: &str) -> MachineHost {
        MachineHost { machine: name.into(), endpoint: name.into(), port: 22, enabled: true, source: String::new() }
    }

    #[test]
    fn repository_names_come_from_either_kind_of_remote() {
        // The same cases as usageSessions.test.ts.
        for (url, name) in [
            ("git@github.com:acme/arbor.git", Some("acme/arbor")),
            ("https://github.com/acme/arbor", Some("acme/arbor")),
            ("https://github.com/acme/arbor.git/", Some("acme/arbor")),
            ("ssh://git@github.com:22/acme/arbor.git", Some("acme/arbor")),
            ("https://token@github.com/acme/arbor", Some("acme/arbor")),
            ("  git@github.com:acme/arbor  ", Some("acme/arbor")),
            ("https://gitlab.com/group/sub/site", None),
            ("file:///srv/arbor", None),
            ("/Users/cam/src/arbor", None),
            ("", None),
        ] {
            assert_eq!(repository_name(url).as_deref(), name, "{url}");
        }
    }

    #[test]
    fn projects_are_named_like_the_sessions_page_names_them() {
        // The same cases as usageSessions.test.ts, so the project filter matches the list.
        let transcript = |cwd: &str, main_repo: &str, repository_url: &str, pull_request: Option<&str>| SessionTranscript {
            home: "/Users/cam".into(),
            cwd: cwd.into(),
            repo_root: if main_repo.is_empty() { String::new() } else { cwd.into() },
            main_repo: main_repo.into(),
            repository_url: repository_url.into(),
            pull_requests: pull_request
                .map(|repository| vec![PullRequestLink { number: 7, url: String::new(), repository: repository.into() }])
                .unwrap_or_default(),
            ..SessionTranscript::default()
        };
        for (transcript, project) in [
            (transcript("", "", "git@github.com:acme/arbor.git", None), None),
            (transcript("/Users/cam/src/arbor/src", "/Users/cam/src/arbor", "git@github.com:acme/arbor-app.git", None), Some("arbor-app")),
            (transcript("/Users/cam/.agent-app/worktrees/arbor/login", "/Users/cam/src/arbor", "", None), Some("arbor")),
            (transcript("/Users/cam/src/site", "/Users/cam/src/site", "https://gitlab.com/group/sub/site", Some("acme/website")), Some("website")),
            (transcript("/srv/mirror.git", "", "", None), Some("mirror")),
            (transcript("/Users/cam/scratch", "", "", None), Some("scratch")),
            (transcript("/", "", "", None), Some("/")),
        ] {
            assert_eq!(transcript.project().as_deref(), project, "{}", transcript.cwd);
        }
    }

    #[test]
    fn session_ids_are_uuids_and_nothing_else() {
        assert!(is_session_id(CLAUDE_ID));
        assert!(is_session_id(CODEX_ID));
        assert!(!is_session_id("a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a"));
        assert!(!is_session_id("a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7 "));
        assert!(!is_session_id("a3f1c2d4x5b6e-4f70-8a91-b2c3d4e5f6a7"));
        assert!(!is_session_id("'; rm -rf / #-5b6e-4f70-8a91-b2c3d4e5"));
    }

    #[test]
    fn a_scan_reads_each_transcript_into_its_session() {
        let output = format!(
            "H\t/home/cam\n\
             S\tclaude\t{CLAUDE_ID}\t52000\n\
             R\t{{\"type\":\"pr-link\",\"sessionId\":\"{CLAUDE_ID}\",\"prNumber\":412,\"prUrl\":\"https://github.com/acme/arbor/pull/412\",\"prRepository\":\"acme/arbor\",\"timestamp\":\"2026-09-24T01:00:00.000Z\"}}\n\
             K\t2026-09-24T01:10:00.000Z\tauto\t364412\t74190\t41250\n\
             K\t2026-09-24T01:40:00.000Z\tmanual\t120000\t\t\n\
             R\t{{\"type\":\"ai-title\",\"aiTitle\":\"Fix the \\\"login\\\" loop\",\"sessionId\":\"{CLAUDE_ID}\"}}\n\
             R\t{{\"type\":\"cost-state\",\"sessionId\":\"{CLAUDE_ID}\",\"totalCostUSD\":3.2,\"totalLinesAdded\":210,\"totalLinesRemoved\":35}}\n\
             P\t\"cwd\":\"/home/cam/src/arbor-wt\",\"sessionId\":\"{CLAUDE_ID}\",\"version\":\"2.1.280\",\"gitBranch\":\"fix/login\"\n\
             S\tcodex\t{CODEX_ID}\t9000\n\
             M\t\"cwd\":\"/home/cam/src/api\"\n\
             M\t\"commit_hash\":\"1a2b3c4d5e6f\"\n\
             M\t\"repository_url\":\"git@github.com:acme/api.git\"\n\
             C\t2026-09-24T02:00:00.000Z\n\
             N\t{{\"id\":\"{CODEX_ID}\",\"thread_name\":\"Old name\",\"updated_at\":\"2026-09-24T01:00:00Z\"}}\n\
             N\t{{\"id\":\"{CODEX_ID}\",\"thread_name\":\"Rate limiter\",\"updated_at\":\"2026-09-24T03:00:00Z\"}}\n\
             G\t/home/cam/src/api\t/home/cam/src/api\t\tref: refs/heads/main\n\
             G\t/home/cam/src/arbor-wt\t/home/cam/src/arbor-wt\t/home/cam/src/arbor/.git/worktrees/arbor-wt/../..\tref: refs/heads/fix/login\n\
             G\t/tmp/gone\n\
             G\t/opt/plain\t\t\t\n"
        );
        let scan = parse_scan(&output);
        assert_eq!(scan.home, "/home/cam");
        assert_eq!(scan.files.len(), 2);
        let claude = &scan.files[0];
        assert_eq!(claude.size, 52_000);
        assert_eq!(claude.ai_title, "Fix the \"login\" loop");
        assert_eq!(claude.cwd, "/home/cam/src/arbor-wt");
        assert_eq!(claude.branch, "fix/login");
        assert_eq!(claude.lines, Some((210, 35)));
        assert_eq!(
            claude.pull_requests,
            [PullRequestLink { number: 412, url: "https://github.com/acme/arbor/pull/412".into(), repository: "acme/arbor".into() }]
        );
        assert_eq!(
            claude.compactions,
            [
                TranscriptCompaction { at_ms: 1_790_212_200_000, trigger: "auto".into(), pre_tokens: Some(364_412), post_tokens: Some(74_190), duration_ms: Some(41_250) },
                TranscriptCompaction { at_ms: 1_790_214_000_000, trigger: "manual".into(), pre_tokens: Some(120_000), post_tokens: None, duration_ms: None },
            ]
        );
        let codex = &scan.files[1];
        assert_eq!((codex.cwd.as_str(), codex.commit_hash.as_str()), ("/home/cam/src/api", "1a2b3c4d5e6f"));
        assert_eq!(codex.repository_url, "git@github.com:acme/api.git");
        assert_eq!(codex.compactions.len(), 1);
        assert_eq!(scan.titles.get(CODEX_ID).map(String::as_str), Some("Rate limiter"));
        assert_eq!(scan.places["/tmp/gone"], FolderPlace::Gone);
        assert_eq!(scan.places["/opt/plain"], FolderPlace::Outside);
        let FolderPlace::Checkout { root, common_dir, head } = &scan.places["/home/cam/src/arbor-wt"] else {
            panic!("the worktree is a checkout");
        };
        assert_eq!(main_checkout(root, common_dir), "/home/cam/src/arbor");
        assert_eq!(head_branch(head), Some("fix/login"));
    }

    #[test]
    fn codex_names_come_from_its_state_database_first_and_can_be_cleared() {
        let other = "0199a0f4-6e21-7c3d-9a8b-1c2d3e4f5a6b";
        let third = "0199a05d-91c2-7b4a-8e6f-2d3e4f5a6b7c";
        let output = format!(
            "N\t{{\"id\":\"{CODEX_ID}\",\"thread_name\":\"Rate limiter\",\"updated_at\":\"2026-09-24T01:00:00Z\"}}\n\
             N\t{{\"id\":\"{CODEX_ID}\",\"thread_name\":\"\",\"updated_at\":\"2026-09-24T02:00:00Z\"}}\n\
             N\t{{\"id\":\"{other}\",\"thread_name\":\"From the index\",\"updated_at\":\"2026-09-24T01:00:00Z\"}}\n\
             N\t{{\"id\":\"{third}\",\"thread_name\":\"Only in the index\",\"updated_at\":\"2026-09-24T01:00:00Z\"}}\n\
             N\t{{\"id\":\"{third}\",\"updated_at\":\"2026-09-24T05:00:00Z\"}}\n\
             T\t{other}\t\"Named in the app\"\t\"feat/queue\"\n\
             T\t{third}\t\"\"\t\"main\"\n\
             T\tnot-an-id\t\"Nope\"\t\"nope\"\n"
        );
        let scan = parse_scan(&output);
        assert_eq!(scan.titles.get(CODEX_ID).map(String::as_str), Some(""), "the last name in the index cleared it");
        assert_eq!(scan.titles.get(other).map(String::as_str), Some("Named in the app"));
        assert_eq!(scan.titles.get(third).map(String::as_str), Some("Only in the index"), "a line without a name says nothing");
        assert_eq!(scan.titles.len(), 3);
        assert_eq!(scan.branches.get(other).map(String::as_str), Some("feat/queue"));
        assert_eq!(scan.branches.get(third).map(String::as_str), Some("main"));
        assert_eq!(scan.branches.len(), 2);
    }

    #[test]
    fn records_of_the_wrong_kind_or_shape_are_ignored() {
        let output = format!(
            "S\tclaude\t{CLAUDE_ID}\t1\n\
             R\t{{\"type\":\"last-prompt\",\"lastPrompt\":\"secret\"}}\n\
             R\t{{\"type\":\"pr-link\",\"prNumber\":7,\"prUrl\":\"javascript:alert(1)\"}}\n\
             R\tnot json\n\
             K\tyesterday\tauto\t1\t2\t3\n\
             M\t\"cwd\":\"/elsewhere\"\n\
             S\tclaude\tnot-an-id\t1\n\
             P\t\"cwd\":\"/lost\",\"sessionId\":\"x\"\n"
        );
        let scan = parse_scan(&output);
        assert_eq!(scan.files.len(), 1);
        let file = &scan.files[0];
        assert!(file.pull_requests.is_empty() && file.compactions.is_empty());
        assert_eq!(file.ai_title, "");
        assert_eq!(file.cwd, "", "the lines of a file that couldn't be used aren't given to another");
    }

    fn counts(pairs: &[(&str, u64)]) -> BTreeMap<String, u64> {
        pairs.iter().map(|(name, count)| (name.to_string(), *count)).collect()
    }

    #[test]
    fn tool_calls_are_kept_by_name_and_odd_names_are_left_out() {
        let mut output = format!(
            "S\tclaude\t{CLAUDE_ID}\t1\n\
             U\t2\tBash\n\
             U\t1\tBash\n\
             U\t4\tmcp__github__create_issue\n\
             U\t1\tnot a tool\n\
             U\tmany\tRead\n\
             U\t1\t{{\"secret\":1}}\n\
             A\t2\tExplore\n\
             A\t1\tplugin:reviewer\n\
             S\tcodex\t{CODEX_ID}\t1\n\
             U\t3\tcollaboration/spawn_agent\n\
             A\t1\tExplore\n\
             V\t1\tRead\n\
             S\tclaude\t{CLAUDE_ID}\t2\n"
        );
        for index in 0..TOOL_NAMES_KEPT + 5 {
            output.push_str(&format!("V\t{}\ttool_{index:03}\n", index + 1));
        }
        let scan = parse_scan(&output);
        let claude = &scan.files[0].tool_usage;
        assert_eq!(claude.tools, counts(&[("Bash", 3), ("mcp__github__create_issue", 4)]));
        assert_eq!(claude.subagents, counts(&[("Explore", 2), ("plugin:reviewer", 1)]));
        let codex = &scan.files[1].tool_usage;
        assert_eq!(codex.tools, counts(&[("collaboration/spawn_agent", 3)]));
        assert!(codex.subagents.is_empty() && codex.subagent_tools.is_empty(), "Codex keeps its subagents elsewhere");
        let busy = &scan.files[2].tool_usage.subagent_tools;
        assert_eq!(busy.len(), TOOL_NAMES_KEPT);
        assert!(!busy.contains_key("tool_000"), "the least called go first");
        assert_eq!(busy.get("tool_104"), Some(&105));
    }

    #[test]
    fn transcripts_read_before_tools_were_counted_are_read_again_a_few_at_a_time() {
        assert_eq!(re_reads(3, 200, 0), [0, 1, 2]);
        assert_eq!(re_reads(5, 2, 0), [0, 1]);
        assert_eq!(re_reads(5, 2, SCAN_INTERVAL_MS), [2, 3]);
        assert_eq!(re_reads(5, 2, 2 * SCAN_INTERVAL_MS), [4, 0], "and round again, so none waits for good");
        assert!(re_reads(0, 2, 0).is_empty());

        let mut connection = database();
        let now = 100 * 86_400_000;
        insert_request(&connection, "timestamp_ms, session_id", params![now - 1_000, CLAUDE_ID]);
        store_scan(&mut connection, "mini", &scan_of(vec![claude_read(52_000)]), now).unwrap();
        let scanned = ["mini".to_string(), "cedar".to_string()];
        assert_eq!(wanted_sessions(&connection, "mini", &scanned, now).unwrap(), [(CLAUDE_ID.to_string(), 52_000)]);

        // As an earlier Arbor stored it.
        connection.execute("UPDATE usage_session_transcripts SET tool_usage = NULL", []).unwrap();
        assert_eq!(wanted_sessions(&connection, "mini", &scanned, now).unwrap(), [(CLAUDE_ID.to_string(), 0)]);
        assert!(wanted_sessions(&connection, "cedar", &scanned, now).unwrap().is_empty(), "only the machine it's on reads it again");

        let mut read = claude_read(52_000);
        read.tool_usage.tools.insert("Bash".into(), 3);
        store_scan(&mut connection, "mini", &scan_of(vec![read]), now + 1).unwrap();
        let stored = load_session_transcripts(&connection, &[CLAUDE_ID]).unwrap().remove(CLAUDE_ID).unwrap();
        assert_eq!(stored.tool_usage.map(|usage| usage.tools), Some(counts(&[("Bash", 3)])));
        assert_eq!(wanted_sessions(&connection, "mini", &scanned, now).unwrap(), [(CLAUDE_ID.to_string(), 52_000)]);
    }

    #[test]
    fn a_session_s_agent_home_is_kept_as_setup_writes_it() {
        let mut connection = database();
        let now = 100 * 86_400_000;
        let mut scan = scan_of(vec![claude_read(52_000)]);
        scan.agent_homes.insert(CLAUDE_ID.into(), "/home/cam/.agent-app/homes/claude-other".into());
        store_scan(&mut connection, "mini", &scan, now).unwrap();
        let home = |connection: &Connection| -> String {
            connection.query_row("SELECT agent_home FROM usage_session_transcripts WHERE session_id = ?1", params![CLAUDE_ID], |row| row.get(0)).unwrap()
        };
        assert_eq!(home(&connection), "~/.agent-app/homes/claude-other");
        // A later scan that doesn't read it again still moves it, and another machine can't.
        let mut moved = scan_of(Vec::new());
        moved.agent_homes.insert(CLAUDE_ID.into(), "/home/cam/.claude".into());
        store_scan(&mut connection, "cedar", &moved, now + 1).unwrap();
        assert_eq!(home(&connection), "~/.agent-app/homes/claude-other");
        store_scan(&mut connection, "mini", &moved, now + 1).unwrap();
        assert_eq!(home(&connection), "~/.claude");
        assert_eq!(tilde("/opt/claude", "/home/cam"), "/opt/claude");
        assert_eq!(tilde("/home/camr/.claude", "/home/cam"), "/home/camr/.claude");
    }

    #[test]
    fn transcripts_read_before_skills_were_noted_are_read_again() {
        let mut connection = database();
        let now = 100 * 86_400_000;
        for id in [CLAUDE_ID, CODEX_ID] {
            insert_request(&connection, "timestamp_ms, session_id", params![now - 1_000, id]);
        }
        let mut codex = claude_read(9_000);
        (codex.agent, codex.session_id) = (TranscriptAgent::Codex, CODEX_ID.into());
        store_scan(&mut connection, "mini", &scan_of(vec![claude_read(52_000), codex]), now).unwrap();
        let scanned = ["mini".to_string()];
        let sizes = |connection: &Connection| {
            let mut wanted = wanted_sessions(connection, "mini", &scanned, now).unwrap();
            wanted.sort();
            wanted.into_iter().map(|(_, size)| size).collect::<Vec<_>>()
        };
        assert_eq!(sizes(&connection), [9_000, 52_000]);

        // As the Arbor before this one stored them, with tools counted but not skills.
        connection
            .execute(r#"UPDATE usage_session_transcripts SET tool_usage = '{"tools":{"Skill":1},"subagentTools":{},"subagents":{},"skills":{"pdf":1}}'"#, [])
            .unwrap();
        assert_eq!(sizes(&connection), [0, 0]);
        let report = load_skill_usage(&connection, now - 86_400_000).unwrap();
        assert_eq!((report.counted, report.pending, report.skills.len()), (0, 2, 0), "not counted until they're read again");
    }

    #[test]
    fn skills_add_up_by_the_sessions_that_used_them() {
        let mut connection = database();
        let now = 100 * 86_400_000;
        let ids = ["a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a1", "a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a2", "a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a3", CODEX_ID];
        let read = |id: &str, calls: &[(&str, u64)], used: &[&str]| {
            let mut read = claude_read(1_000);
            read.session_id = id.into();
            read.tool_usage.skills = counts(calls);
            read.tool_usage.used_skills = used.iter().map(|name| name.to_string()).collect();
            read.tool_usage.used_skills.extend(calls.iter().map(|(name, _)| name.to_string()));
            read
        };
        for (index, id) in ids.iter().enumerate() {
            insert_request(&connection, "timestamp_ms, session_id", params![now - 1_000 * (index as i64 + 1), id]);
        }
        // One long ago, which is left out.
        insert_request(&connection, "timestamp_ms, session_id", params![now - 40 * 86_400_000, CLAUDE_ID]);
        let mut codex = read(CODEX_ID, &[], &["pdf"]);
        codex.agent = TranscriptAgent::Codex;
        store_scan(&mut connection, "mini", &scan_of(vec![read(ids[0], &[("pdf", 3)], &["release-notes"]), read(ids[1], &[("pdf", 1)], &[])]), now).unwrap();
        store_scan(&mut connection, "cedar", &scan_of(vec![read(ids[2], &[("pdf", 2)], &[]), codex, read(CLAUDE_ID, &[("old", 9)], &[])]), now).unwrap();

        let report = load_skill_usage(&connection, now - 30 * 86_400_000).unwrap();
        assert_eq!((report.counted, report.pending), (4, 0));
        assert_eq!(
            report.skills,
            [
                SkillUsage { name: "pdf".into(), sessions: 4, calls: 6, last_ms: now - 1_000, machines: counts(&[("cedar", 2), ("mini", 2)]) },
                SkillUsage { name: "release-notes".into(), sessions: 1, calls: 0, last_ms: now - 1_000, machines: counts(&[("mini", 1)]) },
            ],
            "typed, picked in Codex, or called for by the model, each session counts once"
        );
    }

    #[test]
    fn mcp_servers_and_plugins_add_up_by_the_sessions_that_used_them() {
        assert_eq!(mcp_server("mcp__github__create_issue"), Some("github"));
        assert_eq!(mcp_server("mcp__codex_apps__github/_create_pull_request"), Some("codex_apps"));
        assert_eq!(mcp_server("mcp__plugin_context7_context7__resolve-library-id"), Some("plugin_context7_context7"));
        assert_eq!(mcp_server("mcp__linear/list_issues"), Some("linear"));
        assert_eq!((mcp_server("mcp__github"), mcp_server("mcp____x"), mcp_server("Bash")), (None, None, None));

        let mut connection = database();
        let now = 100 * 86_400_000;
        let ids = ["b3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a1", "b3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a2", CODEX_ID];
        for (index, id) in ids.iter().enumerate() {
            insert_request(&connection, "timestamp_ms, session_id", params![now - 1_000 * (index as i64 + 1), id]);
        }
        let mut first = claude_read(1_000);
        first.session_id = ids[0].into();
        first.tool_usage.tools = counts(&[("mcp__github__create_issue", 2), ("mcp__github__get_issue", 1), ("Bash", 4)]);
        first.tool_usage.subagent_tools = counts(&[("mcp__linear__list_issues", 3)]);
        first.tool_usage.used_skills = ["frontend-design:review".to_string()].into();
        let mut second = claude_read(1_000);
        second.session_id = ids[1].into();
        second.tool_usage.tools = counts(&[("mcp__plugin_context7_context7__resolve-library-id", 5), ("mcp__github__get_issue", 1)]);
        second.tool_usage.skills = counts(&[("frontend-design:review", 2)]);
        second.tool_usage.subagents = counts(&[("pr-review-toolkit:code-reviewer", 1)]);
        let mut codex = claude_read(1_000);
        (codex.agent, codex.session_id) = (TranscriptAgent::Codex, CODEX_ID.into());
        codex.tool_usage.tools = counts(&[("mcp__codex_apps__github/_create_pull_request", 1)]);
        store_scan(&mut connection, "mini", &scan_of(vec![first, second]), now).unwrap();
        store_scan(&mut connection, "cedar", &scan_of(vec![codex]), now).unwrap();

        let plugins = ["context7", "frontend-design", "pr-review-toolkit", "unused", "no:colons"].map(String::from);
        let report = load_mcp_usage(&connection, now - 30 * 86_400_000, &plugins).unwrap();
        assert_eq!((report.counted, report.pending), (3, 0));
        let usage = |name: &str, sessions: u64, calls: u64, last_ms: i64, machines: &[(&str, u64)]| ExtensionUsage {
            name: name.into(),
            sessions,
            calls,
            last_ms,
            machines: counts(machines),
        };
        assert_eq!(
            report.servers,
            [
                usage("github", 2, 4, now - 1_000, &[("mini", 2)]),
                usage("plugin_context7_context7", 1, 5, now - 2_000, &[("mini", 1)]),
                usage("linear", 1, 3, now - 1_000, &[("mini", 1)]),
                usage("codex_apps", 1, 1, now - 3_000, &[("cedar", 1)]),
            ],
            "a subagent's calls count for its session"
        );
        assert_eq!(
            report.plugins,
            [
                usage("frontend-design", 2, 2, now - 1_000, &[("mini", 2)]),
                usage("context7", 1, 5, now - 2_000, &[("mini", 1)]),
                usage("pr-review-toolkit", 1, 0, now - 2_000, &[("mini", 1)]),
            ],
            "a plugin counts by its servers, its skills and its subagents"
        );
    }

    #[test]
    fn worktrees_lead_back_to_their_main_checkout() {
        assert_eq!(main_checkout("/src/app", ""), "/src/app");
        assert_eq!(main_checkout("/src/app-wt", "/src/app/.git/worktrees/app-wt/../.."), "/src/app");
        assert_eq!(main_checkout("/src/app-wt", "/src/app/.git"), "/src/app");
        assert_eq!(main_checkout("/src/wt", "/srv/app.git/worktrees/wt/../.."), "/srv/app.git");
        assert_eq!(head_branch("ref: refs/heads/codex/fold-in"), Some("codex/fold-in"));
        assert_eq!(head_branch("1a2b3c4d5e6f7a8b9c0d"), None);
    }

    fn database() -> Connection {
        crate::usage::schema::test_database()
    }

    fn scan_of(files: Vec<TranscriptRead>) -> ScanOutput {
        ScanOutput { home: "/home/cam".into(), files, ..ScanOutput::default() }
    }

    fn claude_read(size: u64) -> TranscriptRead {
        TranscriptRead {
            agent: TranscriptAgent::Claude,
            session_id: CLAUDE_ID.into(),
            size,
            cwd: "/home/cam/src/arbor-wt".into(),
            branch: "fix/login".into(),
            ai_title: "Fix the login loop".into(),
            ..TranscriptRead::default()
        }
    }

    #[test]
    fn machines_are_asked_about_recent_sessions_not_found_elsewhere() {
        let mut connection = database();
        let now = 100 * 86_400_000;
        let other = "0199a0f4-6e21-7c3d-9a8b-1c2d3e4f5a6b";
        let old = "d4c3b2a1-7f6e-4d5c-9b8a-e1f2a3b4c5d6";
        let subagent = "9c1e7a20-44b1-4d3e-9f10-3a4b5c6d7e8f";
        for (at, id, parent) in [
            (now - 1_000, CLAUDE_ID, None),
            (now - 2_000, CODEX_ID, None),
            (now - 3_000, other, None),
            (now - 3_000, subagent, Some(CLAUDE_ID)),
            (now - LOOKBACK_MS - 1, old, None),
            (now - 500, "derived-not-a-uuid", None),
        ] {
            insert_request(&connection, "timestamp_ms, session_id, parent_session_id", params![at, id, parent]);
        }
        let scanned = ["mini".to_string(), "cedar".to_string()];
        assert_eq!(
            wanted_sessions(&connection, "mini", &scanned, now).unwrap(),
            [(CLAUDE_ID.to_string(), 0), (CODEX_ID.to_string(), 0), (other.to_string(), 0)]
        );

        store_scan(&mut connection, "mini", &scan_of(vec![claude_read(52_000)]), now).unwrap();
        let codex = TranscriptRead { agent: TranscriptAgent::Codex, session_id: CODEX_ID.into(), size: 9_000, ..TranscriptRead::default() };
        store_scan(&mut connection, "cedar", &scan_of(vec![codex]), now).unwrap();
        assert_eq!(
            wanted_sessions(&connection, "mini", &scanned, now).unwrap(),
            [(CLAUDE_ID.to_string(), 52_000), (other.to_string(), 0)],
            "a transcript found on cedar isn't looked for on mini"
        );
        assert_eq!(
            wanted_sessions(&connection, "cedar", &scanned, now).unwrap(),
            [(CODEX_ID.to_string(), 9_000), (other.to_string(), 0)]
        );
        assert_eq!(
            wanted_sessions(&connection, "studio", &["studio".to_string(), "cedar".to_string()], now).unwrap(),
            [(CLAUDE_ID.to_string(), 0), (other.to_string(), 0)],
            "once mini isn't scanned (renamed to studio, say), its sessions are read afresh wherever they turn up"
        );
    }

    #[test]
    fn a_rescan_keeps_what_the_transcript_no_longer_says() {
        let mut connection = database();
        let now = 1_000_000;
        let mut first = scan_of(vec![claude_read(52_000)]);
        first.places.insert(
            "/home/cam/src/arbor-wt".into(),
            FolderPlace::Checkout {
                root: "/home/cam/src/arbor-wt".into(),
                common_dir: "/home/cam/src/arbor/.git/worktrees/arbor-wt/../..".into(),
                head: "ref: refs/heads/fix/login".into(),
            },
        );
        assert_eq!(store_scan(&mut connection, "mini", &first, now).unwrap(), 1);

        // The worktree has since been removed, and the session named.
        let mut read = claude_read(80_000);
        read.custom_title = "Login loop".into();
        read.compactions.push(TranscriptCompaction { at_ms: now, trigger: "manual".into(), pre_tokens: Some(200_000), post_tokens: None, duration_ms: None });
        let mut second = scan_of(vec![read]);
        second.places.insert("/home/cam/src/arbor-wt".into(), FolderPlace::Gone);
        assert_eq!(store_scan(&mut connection, "mini", &second, now + 1).unwrap(), 1);

        let stored = load_session_transcripts(&connection, &[CLAUDE_ID]).unwrap().remove(CLAUDE_ID).unwrap();
        assert_eq!((stored.repo_root.as_str(), stored.main_repo.as_str()), ("/home/cam/src/arbor-wt", "/home/cam/src/arbor"));
        assert_eq!((stored.title.as_str(), stored.title_source.as_str()), ("", ""), "a title is never stored");
        assert_eq!(stored.branch, "fix/login");
        assert_eq!(stored.compactions.len(), 1);
        assert_eq!((stored.machine.as_str(), stored.home.as_str(), stored.read_at_ms), ("mini", "/home/cam", now + 1));

        // A transcript that grew without saying anything new isn't counted as a change.
        assert_eq!(store_scan(&mut connection, "mini", &second, now + 2).unwrap(), 0);
    }

    #[test]
    fn codex_thread_names_arrive_without_the_transcript_growing_and_are_only_held_in_memory() {
        let mut connection = database();
        let codex = TranscriptRead { agent: TranscriptAgent::Codex, session_id: CODEX_ID.into(), size: 9_000, cwd: "/src/api".into(), ..TranscriptRead::default() };
        store_scan(&mut connection, "cedar", &scan_of(vec![codex]), 1).unwrap();
        let mut memory = TitleMemory::new();
        let mut named = scan_of(Vec::new());
        named.titles.insert(CODEX_ID.into(), "Rate limiter".into());
        assert_eq!(store_scan(&mut connection, "cedar", &named, 2).unwrap(), 0, "a name is never stored");
        assert_eq!(remember_titles(&mut memory, &named), 1);
        assert_eq!(remember_titles(&mut memory, &named), 0, "the same name again isn't a change");
        let mut found = load_session_transcripts(&connection, &[CODEX_ID]).unwrap();
        assert_eq!(found[CODEX_ID].title, "");
        put_titles(&memory, &mut found);
        let shown = &found[CODEX_ID];
        assert_eq!((shown.title.as_str(), shown.title_source.as_str(), shown.cwd.as_str()), ("Rate limiter", "codex", "/src/api"));

        let mut cleared = scan_of(Vec::new());
        cleared.titles.insert(CODEX_ID.into(), String::new());
        cleared.branches.insert(CODEX_ID.into(), "rate-limits".into());
        assert_eq!(store_scan(&mut connection, "cedar", &cleared, 4).unwrap(), 1, "only the branch is stored");
        assert_eq!(remember_titles(&mut memory, &cleared), 1, "a name cleared is dropped");
        assert!(memory.titles.is_empty());
        let mut moved = scan_of(Vec::new());
        moved.branches.insert(CODEX_ID.into(), "main".into());
        assert_eq!(store_scan(&mut connection, "cedar", &moved, 5).unwrap(), 0, "a branch already known stays");
        let stored = load_session_transcripts(&connection, &[CODEX_ID]).unwrap().remove(CODEX_ID).unwrap();
        assert_eq!((stored.title.as_str(), stored.title_source.as_str(), stored.branch.as_str()), ("", "", "rate-limits"));
    }

    #[test]
    fn claude_titles_are_held_by_session_and_an_unchanged_transcript_is_asked_once() {
        let other = "b2c3d4e5-6f70-4a81-9b2c-3d4e5f6a7b8c";
        let unseen = "11111111-2222-4333-8444-555555555555";
        let mut memory = TitleMemory::new();
        let mut scan = scan_of(vec![claude_read(1)]);
        scan.claude_titles.insert(other.into(), ("Its own".into(), "Named by the user".into()));
        for id in [CLAUDE_ID, other] {
            scan.agent_homes.insert(id.into(), "/home/cam/.claude".into());
        }
        assert_eq!(remember_titles(&mut memory, &scan), 2);
        assert_eq!(memory.titles.get(CLAUDE_ID), Some(&("Fix the login loop".to_string(), "ai")));
        assert_eq!(memory.titles.get(other), Some(&("Named by the user".to_string(), "custom")), "the user's name wins");
        assert!(memory.looked_up.contains(CLAUDE_ID) && memory.looked_up.contains(other));

        // On, an unchanged transcript is asked for its titles until it's been looked through. Off, nothing is.
        let wanted = [(CLAUDE_ID.to_string(), 5), (unseen.to_string(), 5)];
        let on = scan_script("", &wanted, Some(&memory.looked_up));
        assert!(on.contains("titles=1\n"));
        assert!(on.contains(&format!("{CLAUDE_ID} 5 0\n")) && on.contains(&format!("{unseen} 5 1\n")), "{on}");
        let off = scan_script("", &wanted, None);
        assert!(off.contains("titles=0\n"));
        assert!(off.contains(&format!("{CLAUDE_ID} 5 0\n")) && off.contains(&format!("{unseen} 5 0\n")), "{off}");

        // A transcript read again without a title gives up the one held.
        let mut untitled = claude_read(2);
        untitled.ai_title.clear();
        assert_eq!(remember_titles(&mut memory, &scan_of(vec![untitled])), 1);
        assert!(!memory.titles.contains_key(CLAUDE_ID));
    }

    #[test]
    fn no_title_reaches_usage_db_or_what_commands_return_while_titles_are_off() {
        const SECRET: &str = "TITLE-NEVER-STORED";
        // Ids no other test uses, as titles are held app-wide.
        let read_id = "5ec7e700-0000-4000-8000-000000000001";
        let legacy_id = "5ec7e700-0000-4000-8000-000000000002";
        let mut connection = database();
        // An older Arbor kept titles in usage.db.
        for id in [read_id, legacy_id] {
            connection
                .execute(
                    "INSERT INTO usage_session_transcripts (session_id, machine, agent, title, title_source) VALUES (?1, 'mini', 'claude', ?2, 'ai')",
                    params![id, SECRET],
                )
                .unwrap();
        }
        // A scan with every kind of title in it, which a scan with titles off never has.
        let read = TranscriptRead {
            agent: TranscriptAgent::Claude,
            session_id: read_id.into(),
            size: 10,
            ai_title: SECRET.into(),
            custom_title: SECRET.into(),
            ..TranscriptRead::default()
        };
        let mut scan = scan_of(vec![read]);
        scan.titles.insert(read_id.into(), SECRET.into());
        scan.claude_titles.insert(legacy_id.into(), (SECRET.into(), SECRET.into()));
        scan.agent_homes.insert(read_id.into(), "/home/cam/.claude".into());
        store_scan(&mut connection, "mini", &scan, 1).unwrap();
        assert!(!titles_on(), "nothing in the tests turns titles on");
        assert_eq!(remember_scan_titles(&scan, TITLE_EPOCH.load(Ordering::SeqCst)), 0, "titles are off, so none is held");

        let stored: Vec<String> = connection
            .prepare("SELECT title || title_source FROM usage_session_transcripts WHERE session_id = ?1")
            .unwrap()
            .query_map([read_id], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(stored, [""], "a rewritten row drops the title an older Arbor stored");
        let found = load_session_transcripts(&connection, &[read_id, legacy_id]).unwrap();
        assert_eq!(found.len(), 2);
        let json = serde_json::to_string(&found).unwrap();
        assert!(!json.contains(SECRET), "a title reached a command's result:\n{json}");
        let linked = serde_json::to_string(&load_linked_transcripts(&connection, &[""]).unwrap()).unwrap();
        assert!(!linked.contains(SECRET), "{linked}");
    }

    #[test]
    fn a_codex_session_takes_its_branch_from_the_state_database_before_the_checkout() {
        let mut connection = database();
        let codex = TranscriptRead { agent: TranscriptAgent::Codex, session_id: CODEX_ID.into(), size: 9_000, cwd: "/src/api".into(), ..TranscriptRead::default() };
        let mut scan = scan_of(vec![codex]);
        scan.places.insert("/src/api".into(), FolderPlace::Checkout { root: "/src/api".into(), common_dir: String::new(), head: "ref: refs/heads/main".into() });
        scan.branches.insert(CODEX_ID.into(), "rate-limits".into());
        store_scan(&mut connection, "cedar", &scan, 1).unwrap();
        let stored = load_session_transcripts(&connection, &[CODEX_ID]).unwrap().remove(CODEX_ID).unwrap();
        assert_eq!(stored.branch, "rate-limits", "the branch it was on, not the one the folder has moved to");
    }

    #[test]
    fn each_machine_is_scanned_when_it_answers_and_then_every_five_minutes() {
        let state = MachineHealthState::default();
        apply_hosts(&state, vec![host("up"), host("down")]);
        {
            let mut inner = state.lock();
            inner.local_names = vec!["mini".into()];
            for (name, series) in inner.series.iter_mut() {
                series.last_ok_at = Some(1_000);
                series.error = (name == "down").then(|| "ssh: connect refused".to_string());
            }
        }
        let due = take_due(&state, 1_000);
        let names: Vec<_> = due.iter().map(|(_, machine)| machine.name()).collect();
        assert_eq!(names, ["up", "mini"], "this machine is scanned even though the Machines page doesn't list it");
        assert_eq!(scanned_machines(&state), ["down", "up", "mini"], "a machine that's down still has its sessions");
        assert!(take_due(&state, 2_000).is_empty(), "one scan at a time");
        record_scan(&state, &ScanTarget::Series("up".into()), &host("up"), 5_000, None);
        record_scan(&state, &ScanTarget::ThisMachine, &host("localhost"), 5_000, Some("Timed out after 120s".into()));
        assert!(take_due(&state, 5_000 + SCAN_INTERVAL_MS - 1).is_empty());
        assert_eq!(take_due(&state, 5_000 + SCAN_INTERVAL_MS).len(), 2);
    }

    #[cfg(unix)]
    mod script {
        use super::*;

        const SECRET: &str = "NEVER-LEAVES-THE-MACHINE";

        fn temp_home(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let home = std::env::temp_dir().join(format!("arbor-transcripts-{name}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&home).unwrap();
            fs::canonicalize(&home).unwrap()
        }

        fn write(path: &Path, lines: &[String]) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, lines.join("\n") + "\n").unwrap();
        }

        fn run(home: &Path, wanted: &[(String, u64)], titles: Option<&BTreeSet<String>>) -> String {
            let mut command = tokio::process::Command::new("sh");
            command
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let output = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(run_script(command, &scan_script("", wanted, titles), Duration::from_secs(20)))
                .unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8(output.stdout).unwrap()
        }

        /// A Claude Code transcript shaped like 2.1.280's, with the secret everywhere a message could be.
        fn claude_transcript(id: &str, cwd: &Path) -> Vec<String> {
            let cwd = cwd.display();
            let place = format!(r#""userType":"external","entrypoint":"cli","cwd":"{cwd}","sessionId":"{id}","version":"2.1.280","gitBranch":"fix/login""#);
            vec![
                format!(r#"{{"type":"permission-mode","permissionMode":"default","sessionId":"{id}"}}"#),
                format!(r#"{{"parentUuid":null,"isSidechain":false,"type":"user","message":{{"role":"user","content":"{SECRET} \"cwd\":\"/nowhere\""}},"uuid":"u1","timestamp":"2026-09-24T01:00:00.000Z",{place}}}"#),
                format!(r#"{{"parentUuid":"u1","isSidechain":false,"type":"assistant","message":{{"content":[{{"type":"text","text":"{SECRET}"}},{{"type":"tool_use","input":{{"note":"{{\"type\":\"system\",\"subtype\":\"compact_boundary\"}}"}}}}]}},"uuid":"a1","timestamp":"2026-09-24T01:01:00.000Z",{place}}}"#),
                // Tool calls, with the secret in what went in and what came back.
                format!(r#"{{"parentUuid":"a1","isSidechain":false,"type":"assistant","message":{{"model":"claude-opus-5-5","id":"msg_2","type":"message","role":"assistant","content":[{{"type":"tool_use","id":"toolu_01","name":"Bash","input":{{"command":"{SECRET}","description":"{SECRET}"}},"caller":{{"type":"direct"}}}}]}},"uuid":"a2","timestamp":"2026-09-24T01:01:10.000Z",{place}}}"#),
                format!(r#"{{"parentUuid":"a2","isSidechain":false,"type":"user","message":{{"role":"user","content":[{{"tool_use_id":"toolu_01","type":"tool_result","content":"{SECRET} \"type\":\"tool_use\",\"id\":\"toolu_09\",\"name\":\"{SECRET}\" \"subagent_type\":\"{SECRET}\""}}]}},"toolUseResult":{{"stdout":"{SECRET}"}},"uuid":"u3","timestamp":"2026-09-24T01:01:20.000Z",{place}}}"#),
                // An agent call, with the copy of its input Claude Code sometimes keeps.
                format!(r#"{{"parentUuid":"u3","isSidechain":false,"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"toolu_02","name":"Agent","input":{{"description":"{SECRET}","prompt":"{SECRET}","subagent_type":"Explore"}}}}]}},"wireToolInputs":{{"toolu_02":{{"description":"{SECRET}","prompt":"{SECRET}","subagent_type":"Explore"}}}},"uuid":"a3","timestamp":"2026-09-24T01:02:00.000Z",{place}}}"#),
                // One that doesn't name a type, then a web search, a command and an MCP tool.
                format!(r#"{{"parentUuid":"a3","isSidechain":false,"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"toolu_03","name":"Agent","input":{{"description":"{SECRET}","prompt":"{SECRET}"}}}}]}},"uuid":"a4","timestamp":"2026-09-24T01:03:00.000Z",{place}}}"#),
                format!(r#"{{"parentUuid":"a4","isSidechain":false,"type":"assistant","message":{{"content":[{{"type":"server_tool_use","id":"srvtoolu_01","name":"web_search","input":{{"query":"{SECRET}"}}}},{{"type":"tool_use","id":"toolu_04","name":"Bash","input":{{"command":"{SECRET}"}}}},{{"type":"tool_use","id":"toolu_05","name":"mcp__github__create_pull_request","input":{{"title":"{SECRET}"}}}}]}},"uuid":"a5","timestamp":"2026-09-24T01:04:00.000Z",{place}}}"#),
                // Skill calls: only the skill asked for is read, never what came with it, and an input that only
                // looks like one, from another tool or quoted in what came back, isn't a skill.
                format!(r#"{{"parentUuid":"a5","isSidechain":false,"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"toolu_06","name":"Skill","input":{{"skill":"/pdf"}}}},{{"type":"tool_use","id":"toolu_07","name":"Skill","input":{{"skill":"superpowers:brainstorming","args":"{SECRET}"}}}},{{"type":"tool_use","id":"toolu_08","name":"mcp__notes__find","input":{{"skill":"{SECRET}"}}}}]}},"uuid":"a6","timestamp":"2026-09-24T01:04:30.000Z",{place}}}"#),
                format!(r#"{{"parentUuid":"a6","isSidechain":false,"type":"user","message":{{"role":"user","content":[{{"tool_use_id":"toolu_06","type":"tool_result","content":"{SECRET} \"name\":\"Skill\",\"input\":{{\"skill\":\"{SECRET}\"}} \"attributionSkill\":\"{SECRET}\""}}]}},"uuid":"u4","timestamp":"2026-09-24T01:04:40.000Z",{place}}}"#),
                // A skill a person typed: only the name Claude Code notes each request was made under is read.
                format!(r#"{{"parentUuid":"u4","isSidechain":false,"type":"user","message":{{"role":"user","content":"<command-message>{SECRET}</command-message>\n<command-name>/{SECRET}</command-name>"}},"uuid":"u5","timestamp":"2026-09-24T01:05:00.000Z",{place}}}"#),
                format!(r#"{{"parentUuid":"u5","isSidechain":false,"type":"assistant","message":{{"content":[{{"type":"text","text":"{SECRET}"}}]}},"uuid":"a7","timestamp":"2026-09-24T01:05:10.000Z",{place},"attributionSkill":"release-notes"}}"#),
                format!(r#"{{"type":"ai-title","aiTitle":"First idea","sessionId":"{id}"}}"#),
                format!(r#"{{"type":"pr-link","sessionId":"{id}","prNumber":412,"prUrl":"https://github.com/acme/arbor/pull/412","prRepository":"acme/arbor","timestamp":"2026-09-24T01:02:00.000Z"}}"#),
                format!(r#"{{"type":"pr-link","sessionId":"{id}","prNumber":412,"prUrl":"https://github.com/acme/arbor/pull/412","prRepository":"acme/arbor","timestamp":"2026-09-24T01:05:00.000Z"}}"#),
                format!(r#"{{"parentUuid":null,"logicalParentUuid":"a1","isSidechain":false,"type":"system","subtype":"compact_boundary","content":"Conversation compacted","level":"info","compactMetadata":{{"trigger":"auto","preTokens":364412,"postTokens":74190,"cumulativeDroppedTokens":290222,"durationMs":41250,"preCompactDiscoveredTools":["Read"],"preservedSegment":{{"headUuid":"u1","anchorUuid":"u1","tailUuid":"a1"}}}},"uuid":"c1","timestamp":"2026-09-24T01:10:00.000Z",{place},"slug":"quiet-lemur"}}"#),
                format!(r#"{{"parentUuid":"c1","isSidechain":false,"type":"user","message":{{"role":"user","content":"This session is being continued. {SECRET}"}},"isCompactSummary":true,"uuid":"u2","timestamp":"2026-09-24T01:10:01.000Z",{place}}}"#),
                // Keys in another order, as some versions write them, and without the sizes after.
                format!(r#"{{"parentUuid":"u2","isSidechain":false,"subtype":"compact_boundary","compactMetadata":{{"trigger":"manual","preTokens":120000}},"content":"Conversation compacted","type":"system","uuid":"c2","timestamp":"2026-09-24T01:40:00.000Z",{place}}}"#),
                format!(r#"{{"type":"last-prompt","lastPrompt":"{SECRET}","sessionId":"{id}"}}"#),
                format!(r#"{{"type":"system","subtype":"away_summary","content":"{SECRET}","sessionId":"{id}"}}"#),
                format!(r#"{{"type":"ai-title","aiTitle":"Fix the \"login\" loop","sessionId":"{id}"}}"#),
                format!(r#"{{"type":"cost-state","sessionId":"{id}","totalCostUSD":3.2,"totalLinesAdded":210,"totalLinesRemoved":35,"modelUsage":{{}}}}"#),
            ]
        }

        /// A subagent's transcript, which Claude Code keeps beside the session's.
        fn subagent_transcript(id: &str, tools: &[(&str, &str)]) -> Vec<String> {
            let mut lines = vec![format!(r#"{{"parentUuid":null,"isSidechain":true,"type":"user","message":{{"role":"user","content":"{SECRET}"}},"uuid":"s0","sessionId":"{id}","agentId":"a1b2c3"}}"#)];
            for (index, (name, input)) in tools.iter().enumerate() {
                lines.push(format!(
                    r#"{{"parentUuid":"s{index}","isSidechain":true,"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"toolu_1{index}","name":"{name}","input":{{{input}}}}}]}},"uuid":"s{}","sessionId":"{id}","agentId":"a1b2c3"}}"#,
                    index + 1
                ));
            }
            lines
        }

        /// A Codex rollout shaped like 0.156's.
        fn codex_rollout(id: &str, cwd: &Path) -> Vec<String> {
            let cwd = cwd.display();
            vec![
                format!(r#"{{"timestamp":"2026-09-24T02:00:00.000Z","ordinal":0,"type":"session_meta","payload":{{"session_id":"{id}","id":"{id}","timestamp":"2026-09-24T02:00:00.000Z","cwd":"{cwd}","originator":"codex_exec","cli_version":"0.156.0","source":"exec","model_provider":"openai","base_instructions":{{"text":"{SECRET} \"cwd\":\"/nowhere\""}},"git":{{"commit_hash":"1a2b3c4d5e6f","repository_url":"git@github.com:acme/api.git"}}}}}}"#),
                format!(r#"{{"timestamp":"2026-09-24T02:01:00.000Z","ordinal":1,"type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"{SECRET}"}}]}}}}"#),
                // What the compaction kept holds calls too, which were counted where they first came.
                format!(r#"{{"timestamp":"2026-09-24T02:30:00.000Z","ordinal":2,"type":"compacted","payload":{{"message":"{SECRET}","replacement_history":[{{"text":"{SECRET}"}},{{"type":"function_call","id":"fc_0","name":"exec_command","arguments":"{SECRET}"}}],"window_number":1}}}}"#),
                format!(r#"{{"timestamp":"2026-09-24T02:31:00.000Z","ordinal":3,"type":"turn_context","payload":{{"cwd":"/elsewhere","model":"gpt-6-sol"}}}}"#),
                // Tool calls, with the secret in what went in and what came back.
                format!(r#"{{"timestamp":"2026-09-24T02:32:00.000Z","ordinal":4,"type":"response_item","payload":{{"type":"function_call","id":"fc_1","name":"exec_command","arguments":"{{\"cmd\":\"{SECRET}\"}}","call_id":"call_1","internal_chat_message_metadata_passthrough":{{}}}}}}"#),
                format!(r#"{{"timestamp":"2026-09-24T02:32:10.000Z","ordinal":5,"type":"response_item","payload":{{"type":"function_call_output","call_id":"call_1","output":"{SECRET} \"type\":\"response_item\",\"payload\":{{\"type\":\"function_call\",\"id\":\"fc_9\",\"name\":\"{SECRET}\""}}}}"#),
                format!(r#"{{"timestamp":"2026-09-24T02:33:00.000Z","ordinal":6,"type":"response_item","payload":{{"type":"function_call","id":"fc_2","name":"exec_command","arguments":"{{}}","call_id":"call_2"}}}}"#),
                format!(r#"{{"timestamp":"2026-09-24T02:34:00.000Z","ordinal":7,"type":"response_item","payload":{{"type":"function_call","id":"fc_3","name":"spawn_agent","namespace":"collaboration","arguments":"{{\"message\":\"{SECRET}\"}}","call_id":"call_3"}}}}"#),
                format!(r#"{{"timestamp":"2026-09-24T02:35:00.000Z","ordinal":8,"type":"response_item","payload":{{"type":"custom_tool_call","id":"ctc_1","status":"completed","call_id":"call_4","name":"apply_patch","input":"*** Begin Patch {SECRET}"}}}}"#),
                format!(r#"{{"timestamp":"2026-09-24T02:36:00.000Z","ordinal":9,"type":"response_item","payload":{{"type":"web_search_call","id":"ws_1","status":"completed","action":{{"type":"search","query":"{SECRET}"}}}}}}"#),
                format!(r#"{{"timestamp":"2026-09-24T02:37:00.000Z","ordinal":10,"type":"response_item","payload":{{"type":"function_call","id":null,"name":"_create_pull_request","namespace":"mcp__codex_apps__github","arguments":"{{}}","call_id":"call_5"}}}}"#),
                // Skills a person picked, beside what they typed and a mention that isn't a skill.
                format!(r#"{{"timestamp":"2026-09-24T02:38:00.000Z","ordinal":11,"type":"event_msg","payload":{{"type":"item_completed","thread_id":"{id}","turn_id":"t2","item":{{"type":"UserMessage","id":"um_2","content":[{{"type":"text","text":"{SECRET} $pdf","text_elements":[]}},{{"type":"skill","name":"pdf","path":"/Users/cam/.agents/skills/pdf/SKILL.md"}},{{"type":"mention","name":"github","path":"app://github"}},{{"type":"mention","name":"release-notes","path":"skill://release-notes"}}]}}}}}}"#),
                // The skill's instructions as they went to the model, and a skill quoted in a call's output.
                format!(r#"{{"timestamp":"2026-09-24T02:38:01.000Z","ordinal":12,"type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"<skill>\n<name>{SECRET}</name>\n</skill>"}}],"internal_chat_message_metadata_passthrough":{{"content_item_kinds":["skills.selected_skill_instructions"]}}}}}}"#),
                format!(r#"{{"timestamp":"2026-09-24T02:38:02.000Z","ordinal":13,"type":"response_item","payload":{{"type":"function_call_output","call_id":"call_6","output":"{{\"type\":\"skill\",\"name\":\"{SECRET}\"}}"}}}}"#),
            ]
        }

        /// A Codex state database with the columns that hold a thread's messages filled with the secret.
        fn thread_database(path: &Path, threads: &[(&str, Option<&str>, Option<&str>)]) -> Connection {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let connection = Connection::open(path).unwrap();
            connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get::<_, String>(0)).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE threads (
                        id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL,
                        first_user_message TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '', git_branch TEXT, name TEXT
                    );",
                )
                .unwrap();
            for (id, name, branch) in threads {
                connection
                    .execute(
                        "INSERT INTO threads (id, rollout_path, cwd, title, first_user_message, preview, git_branch, name)
                         VALUES (?1, '', '', ?2, ?2, ?2, ?3, ?4)",
                        params![id, SECRET, branch, name],
                    )
                    .unwrap();
            }
            connection
        }

        #[test]
        fn the_script_reads_titles_places_and_compactions_and_never_a_message() {
            let home = temp_home("read");
            // A main checkout with a linked worktree, as git lays them out.
            let main = home.join("src/arbor");
            let worktree = home.join("src/arbor-wt");
            fs::create_dir_all(main.join(".git/worktrees/arbor-wt")).unwrap();
            fs::write(main.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
            fs::write(main.join(".git/worktrees/arbor-wt/commondir"), "../..\n").unwrap();
            fs::write(main.join(".git/worktrees/arbor-wt/HEAD"), "ref: refs/heads/fix/login\n").unwrap();
            fs::create_dir_all(&worktree).unwrap();
            fs::write(worktree.join(".git"), format!("gitdir: {}\n", main.join(".git/worktrees/arbor-wt").display())).unwrap();
            let api = home.join("src/api/service");
            fs::create_dir_all(home.join("src/api/.git")).unwrap();
            fs::write(home.join("src/api/.git/HEAD"), "ref: refs/heads/rate-limits\n").unwrap();
            fs::create_dir_all(&api).unwrap();

            let project = home.join(".claude/projects/-home-cam-src-arbor-wt");
            write(&project.join(format!("{CLAUDE_ID}.jsonl")), &claude_transcript(CLAUDE_ID, &worktree));
            // Subagents' transcripts sit a level down and aren't sessions of their own here, but their calls count.
            let subagents = project.join(CLAUDE_ID).join("subagents");
            let read = format!(r#""file_path":"{SECRET}""#);
            let explore = format!(r#""description":"{SECRET}","prompt":"{SECRET}","subagent_type":"general-purpose""#);
            write(&subagents.join("agent-a1b2c3.jsonl"), &subagent_transcript(CLAUDE_ID, &[("Read", read.as_str()), ("Read", read.as_str()), ("Agent", explore.as_str())]));
            write(&subagents.join("agent-d4e5f6.jsonl"), &subagent_transcript(CLAUDE_ID, &[("Grep", r#""pattern":"x""#), ("Skill", r#""skill":"pdf""#)]));
            write(&subagents.join("agent-a1b2c3.meta.json"), &[format!(r#"{{"agentType":"Explore","description":"{SECRET}"}}"#)]);
            // A session Arbor didn't see is never read.
            let unseen = "11111111-2222-4333-8444-555555555555";
            write(&project.join(format!("{unseen}.jsonl")), &claude_transcript(unseen, &worktree));
            write(
                &home.join(format!(".codex/sessions/2026/09/24/rollout-2026-09-24T02-00-00-{CODEX_ID}.jsonl")),
                &codex_rollout(CODEX_ID, &api),
            );
            // A second Claude Code and Codex home, each with its own sessions.
            let proxied_claude = "b2c3d4e5-6f70-4a81-9b2c-3d4e5f6a7b8c";
            let proxied_codex = "0199a2b3-c4d5-7e6f-8a7b-8c9d0e1f2a3b";
            // Another app's homes, on the list with Sessions on.
            agent_homes::tests::save_on_this_thread(vec![
                agent_homes::tests::home("", agent_homes::AgentHomeKind::Claude, "~/.agent-app/homes/*", true, false),
                agent_homes::tests::home("", agent_homes::AgentHomeKind::Codex, "~/.agent-app/homes/*", true, false),
            ]);
            let homes = home.join(".agent-app/homes");
            write(&homes.join(format!("claude-other/projects/-home-cam-src-api/{proxied_claude}.jsonl")), &claude_transcript(proxied_claude, &api));
            write(
                &homes.join(format!("codex-other/sessions/2026/09/24/rollout-2026-09-24T04-00-00-{proxied_codex}.jsonl")),
                &codex_rollout(proxied_codex, &api),
            );
            // One Codex has closed, and one still has open with its writes in the WAL.
            drop(thread_database(&homes.join("codex-other/state_5.sqlite"), &[(proxied_codex, Some("Queue worker"), Some("feat/queue"))]));
            let open = thread_database(&home.join(".codex/state_5.sqlite"), &[(CODEX_ID, None, Some("rate-limits")), (unseen, Some(SECRET), Some(SECRET))]);
            write(
                &home.join(".codex/session_index.jsonl"),
                &[
                    format!(r#"{{"id":"{CODEX_ID}","thread_name":"Rate limiter","updated_at":"2026-09-24T03:00:00Z"}}"#),
                    format!(r#"{{"id":"{unseen}","thread_name":"{SECRET}","updated_at":"2026-09-24T03:00:00Z"}}"#),
                ],
            );

            let wanted = [CLAUDE_ID, CODEX_ID, proxied_claude, proxied_codex].map(|id| (id.to_string(), 0));
            // With Session titles on.
            let stdout = run(&home, &wanted, Some(&BTreeSet::new()));
            assert!(!stdout.contains(SECRET), "a message got out:\n{stdout}");
            let scan = parse_scan(&stdout);
            assert_eq!(scan.home, home.display().to_string());
            assert_eq!(scan.files.len(), 4, "{stdout}");
            let agent_home = |id: &str| scan.agent_homes.get(id).map(|path| tilde(path, &scan.home));
            assert_eq!(agent_home(CLAUDE_ID).as_deref(), Some("~/.claude"));
            assert_eq!(agent_home(CODEX_ID).as_deref(), Some("~/.codex"));
            assert_eq!(agent_home(proxied_claude).as_deref(), Some("~/.agent-app/homes/claude-other"));
            assert_eq!(agent_home(proxied_codex).as_deref(), Some("~/.agent-app/homes/codex-other"));
            assert_eq!(scan.agent_homes.len(), 4, "only the sessions asked for");
            for id in [proxied_claude, proxied_codex] {
                let file = scan.files.iter().find(|file| file.session_id == id).expect("found in T3 Code's home");
                assert_eq!(file.cwd, api.display().to_string());
            }
            let proxied = &scan.files.iter().find(|file| file.session_id == proxied_claude).unwrap().tool_usage;
            assert_eq!(proxied.subagents, counts(&[("Explore", 1)]), "a subagent type the session named, without transcripts of its subagents");
            assert!(proxied.subagent_tools.is_empty());

            let claude = scan.files.iter().find(|file| file.session_id == CLAUDE_ID).unwrap();
            assert_eq!(claude.ai_title, "Fix the \"login\" loop");
            assert_eq!(claude.cwd, worktree.display().to_string());
            assert_eq!(claude.branch, "fix/login");
            assert_eq!(claude.lines, Some((210, 35)));
            assert_eq!(claude.pull_requests.len(), 1);
            assert_eq!(
                claude.compactions,
                [
                    TranscriptCompaction { at_ms: 1_790_212_200_000, trigger: "auto".into(), pre_tokens: Some(364_412), post_tokens: Some(74_190), duration_ms: Some(41_250) },
                    TranscriptCompaction { at_ms: 1_790_214_000_000, trigger: "manual".into(), pre_tokens: Some(120_000), post_tokens: None, duration_ms: None },
                ]
            );
            assert_eq!(
                claude.tool_usage.tools,
                counts(&[("Agent", 2), ("Bash", 2), ("Skill", 2), ("mcp__github__create_pull_request", 1), ("mcp__notes__find", 1), ("web_search", 1)])
            );
            assert_eq!(claude.tool_usage.subagent_tools, counts(&[("Agent", 1), ("Grep", 1), ("Read", 2), ("Skill", 1)]));
            assert_eq!(
                claude.tool_usage.skills,
                counts(&[("pdf", 2), ("superpowers:brainstorming", 1)]),
                "its own and its subagents' calls for a skill, by the skill's name"
            );
            assert_eq!(
                claude.tool_usage.used_skills.iter().map(String::as_str).collect::<Vec<_>>(),
                ["pdf", "release-notes", "superpowers:brainstorming"],
                "with the one a person typed"
            );
            assert_eq!(
                claude.tool_usage.subagents,
                counts(&[("Explore", 1), ("general-purpose", 1)]),
                "one of each: the copy of the call's input isn't counted, and the call without a type adds none"
            );

            let codex = scan.files.iter().find(|file| file.session_id == CODEX_ID).unwrap();
            assert_eq!(codex.cwd, api.display().to_string());
            assert_eq!(codex.commit_hash, "1a2b3c4d5e6f");
            assert_eq!(codex.repository_url, "git@github.com:acme/api.git");
            assert_eq!(codex.compactions.iter().map(|compaction| compaction.at_ms).collect::<Vec<_>>(), [1_790_217_000_000]);
            assert_eq!(
                codex.tool_usage.tools,
                counts(&[
                    ("apply_patch", 1),
                    ("collaboration/spawn_agent", 1),
                    ("exec_command", 2),
                    ("mcp__codex_apps__github/_create_pull_request", 1),
                    ("web_search", 1),
                ])
            );
            assert_eq!(codex.tool_usage.used_skills.iter().map(String::as_str).collect::<Vec<_>>(), ["pdf", "release-notes"]);
            assert_eq!(scan.titles.get(CODEX_ID).map(String::as_str), Some("Rate limiter"), "the database has no name for it, so the index's stands");
            if Path::new("/usr/bin/sqlite3").exists() {
                assert_eq!(scan.titles.get(proxied_codex).map(String::as_str), Some("Queue worker"), "{stdout}");
                assert_eq!(scan.branches.get(proxied_codex).map(String::as_str), Some("feat/queue"));
                assert_eq!(scan.branches.get(CODEX_ID).map(String::as_str), Some("rate-limits"));
                assert_eq!(scan.branches.len(), 2, "only the sessions asked about");
            }
            drop(open);

            let FolderPlace::Checkout { root, common_dir, head } = &scan.places[&claude.cwd] else {
                panic!("the worktree is a checkout: {:?}", scan.places);
            };
            assert_eq!(root, &worktree.display().to_string());
            assert_eq!(main_checkout(root, common_dir), main.display().to_string());
            assert_eq!(head_branch(head), Some("fix/login"));
            let FolderPlace::Checkout { root, common_dir, head } = &scan.places[&codex.cwd] else {
                panic!("the service folder is inside a checkout: {:?}", scan.places);
            };
            assert_eq!(root, &home.join("src/api").display().to_string());
            assert_eq!(main_checkout(root, common_dir), home.join("src/api").display().to_string());
            assert_eq!(head_branch(head), Some("rate-limits"));
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn with_titles_off_no_title_or_thread_name_leaves_the_machine() {
            let home = temp_home("untitled");
            let path = home.join(format!(".claude/projects/-src/{CLAUDE_ID}.jsonl"));
            let mut lines = claude_transcript(CLAUDE_ID, &home);
            lines.push(format!(r#"{{"type":"ai-title","aiTitle":"{SECRET}","sessionId":"{CLAUDE_ID}"}}"#));
            lines.push(format!(r#"{{"type":"custom-title","customTitle":"{SECRET}","sessionId":"{CLAUDE_ID}"}}"#));
            write(&path, &lines);
            write(
                &home.join(format!(".codex/sessions/2026/09/24/rollout-2026-09-24T02-00-00-{CODEX_ID}.jsonl")),
                &codex_rollout(CODEX_ID, &home),
            );
            write(
                &home.join(".codex/session_index.jsonl"),
                &[format!(r#"{{"id":"{CODEX_ID}","thread_name":"{SECRET}","updated_at":"2026-09-24T03:00:00Z"}}"#)],
            );
            let open = thread_database(&home.join(".codex/state_5.sqlite"), &[(CODEX_ID, Some(SECRET), Some("rate-limits"))]);
            let size = fs::metadata(&path).unwrap().len();

            // Read whole, and unchanged.
            for wanted in [vec![(CLAUDE_ID.to_string(), 0), (CODEX_ID.to_string(), 0)], vec![(CLAUDE_ID.to_string(), size)]] {
                let stdout = run(&home, &wanted, None);
                assert!(!stdout.contains(SECRET), "a title got out with titles off:\n{stdout}");
                let scan = parse_scan(&stdout);
                assert!(scan.titles.is_empty() && scan.claude_titles.is_empty(), "{stdout}");
                assert!(scan.files.iter().all(|file| file.ai_title.is_empty() && file.custom_title.is_empty()), "{stdout}");
            }
            if Path::new("/usr/bin/sqlite3").exists() {
                let stdout = run(&home, &[(CODEX_ID.to_string(), 0)], None);
                assert_eq!(parse_scan(&stdout).branches.get(CODEX_ID).map(String::as_str), Some("rate-limits"), "the branch still comes");
            }

            // On, an unchanged transcript gives up its titles alone, once.
            let stdout = run(&home, &[(CLAUDE_ID.to_string(), size)], Some(&BTreeSet::new()));
            let scan = parse_scan(&stdout);
            assert!(scan.files.is_empty(), "{stdout}");
            assert_eq!(scan.claude_titles.get(CLAUDE_ID), Some(&(SECRET.to_string(), SECRET.to_string())), "{stdout}");
            let looked_up = BTreeSet::from([CLAUDE_ID.to_string()]);
            let stdout = run(&home, &[(CLAUDE_ID.to_string(), size)], Some(&looked_up));
            assert!(parse_scan(&stdout).claude_titles.is_empty(), "{stdout}");
            drop(open);
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn a_transcript_that_hasnt_grown_is_skipped() {
            let home = temp_home("unchanged");
            let path = home.join(format!(".claude/projects/-src/{CLAUDE_ID}.jsonl"));
            write(&path, &claude_transcript(CLAUDE_ID, &home));
            let size = fs::metadata(&path).unwrap().len();
            let stdout = run(&home, &[(CLAUDE_ID.into(), size)], None);
            assert!(parse_scan(&stdout).files.is_empty(), "{stdout}");
            // Its home is still said, so a session read before homes were kept gets one without being read again.
            assert_eq!(parse_scan(&stdout).agent_homes.get(CLAUDE_ID), Some(&home.join(".claude").display().to_string()));
            assert_eq!(parse_scan(&run(&home, &[(CLAUDE_ID.into(), size - 1)], None)).files.len(), 1);
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn transcripts_moved_elsewhere_and_linked_back_are_read() {
            // Codex keeps working with rollouts moved to another drive and linked back, so the scan follows the links.
            let home = temp_home("linked");
            let moved = home.join("moved");
            let claude = moved.join(format!("{CLAUDE_ID}.jsonl"));
            let codex = moved.join(format!("rollout-2026-09-24T02-00-00-{CODEX_ID}.jsonl"));
            write(&claude, &claude_transcript(CLAUDE_ID, &home));
            write(&codex, &codex_rollout(CODEX_ID, &home));
            let claude_link = home.join(format!(".claude/projects/-src/{CLAUDE_ID}.jsonl"));
            let codex_link = home.join(format!(".codex/archived_sessions/rollout-2026-09-24T02-00-00-{CODEX_ID}.jsonl"));
            fs::create_dir_all(claude_link.parent().unwrap()).unwrap();
            fs::create_dir_all(codex_link.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(&claude, &claude_link).unwrap();
            std::os::unix::fs::symlink(&codex, &codex_link).unwrap();
            // A link into a drive that isn't there any more is passed over.
            let gone = "0199a1b2-c3d4-7e5f-8a6b-000000000000";
            std::os::unix::fs::symlink(home.join("unmounted/x.jsonl"), home.join(format!(".codex/archived_sessions/rollout-2026-09-24T03-00-00-{gone}.jsonl"))).unwrap();

            let stdout = run(&home, &[(CLAUDE_ID.into(), 0), (CODEX_ID.into(), 0), (gone.into(), 0)], None);
            let scan = parse_scan(&stdout);
            assert_eq!(scan.agent_homes.get(CODEX_ID), Some(&home.join(".codex").display().to_string()), "archived rollouts are in the home too");
            let mut read: Vec<String> = scan.files.into_iter().map(|file| file.session_id).collect();
            read.sort_unstable();
            assert_eq!(read, [CODEX_ID, CLAUDE_ID], "{stdout}");
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn a_reverted_codex_thread_is_found_by_its_thread_id() {
            // Reverting a thread writes a new rollout named <thread>_<rollout>.
            let home = temp_home("reverted");
            let rollout = "0199a1b2-c3d4-7e5f-8a6b-111111111111";
            write(
                &home.join(format!(".codex/sessions/2026/09/24/rollout-2026-09-24T02-00-00-{CODEX_ID}_{rollout}.jsonl")),
                &codex_rollout(CODEX_ID, &home),
            );
            let stdout = run(&home, &[(CODEX_ID.into(), 0), (rollout.into(), 0)], None);
            let read: Vec<String> = parse_scan(&stdout).files.into_iter().map(|file| file.session_id).collect();
            assert_eq!(read, [CODEX_ID], "{stdout}");
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn a_machine_without_agents_answers_with_nothing() {
            let home = temp_home("empty");
            let stdout = run(&home, &[(CLAUDE_ID.into(), 0)], None);
            let scan = parse_scan(&stdout);
            assert!(scan.files.is_empty() && scan.titles.is_empty() && scan.branches.is_empty() && scan.places.is_empty(), "{stdout}");
            let _ = fs::remove_dir_all(&home);
        }
    }
}

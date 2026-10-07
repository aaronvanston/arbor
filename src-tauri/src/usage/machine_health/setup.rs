//! Setup: what each machine's agents load, and where that differs across the
//! fleet.
//!
//! A read-only script goes to each machine over the same shell or SSH
//! connection the health samples use. For every agent home (see
//! `agent_homes`: those with Sync on), and for the skills the machine shares in
//! ~/.agents, it reports:
//! - the instructions file (Claude Code's CLAUDE.md, Codex's AGENTS.md) and
//!   the files it pulls in with @imports;
//! - rules, skills, subagents and commands;
//! - hooks, MCP servers, plugins and settings.
//!
//! It also lists every Claude Code and Codex install along the PATH a login
//! shell would have, with its version, so a second, forgotten one shows.
//!
//! Files are fingerprinted where they are, so only a SHA-256 of each leaves
//! the machine. Settings files come back whole to be read here, and only
//! fingerprints of their values are kept. Some values are never shown or
//! stored:
//! - an environment variable's value;
//! - an MCP server's command line, headers and environment;
//! - anything in config.toml that isn't on a short list.
//!
//! Those fingerprints are salted with a random salt the window never sees, so
//! they can't be matched against a guess there, and a path in the machine's
//! home counts the same on every machine. The salt is kept beside the saved
//! scans in Arbor's data folder, which holds the sign-ins already, so a scan
//! put back after a restart still compares with a fresh one. From Claude Code's .claude.json only the MCP servers
//! are read out, on the machine, so its history and projects never leave it.
//! Arbor's own reporter hooks are left out, since Machines sets those up.
//!
//! Each machine's last scan, names, paths and fingerprints only, is kept in
//! Arbor's data folder (`setup-scans.json`) and put back at launch, so Sync,
//! change alerts and the harnesses found survive a restart. A file's content
//! is fetched only when the page asks to compare it, and only for files a scan
//! listed as text; it's never kept.

use super::agents::{parse_version, AgentKind, AGENT_ENV};
use ts_rs::TS;
use super::agent_homes::{self, tilde, AgentHomeKind, HomeUse};
use super::harnesses::{self, Harness};
use super::attention::REPORTER_MARK;
use super::shell::shell_quote;
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::collections::BTreeSet;

const SCAN_TIMEOUT: Duration = Duration::from_secs(60);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// A scan this recent is fresh enough that the page doesn't ask for another.
const FRESH_MS: i64 = 10 * 60 * 1000;

pub(crate) const SETUP_INVENTORY_UPDATED_EVENT: &str = "setup-inventory-updated";

/// Salts the fingerprints of settings values. It's made once, kept beside the saved scans so a scan put back after a
/// restart still compares with a fresh one, and never leaves this Mac's data folder.
static SALT: std::sync::OnceLock<[u8; 16]> = std::sync::OnceLock::new();

/// A short hash of the salt, never the salt: what Sync's bases note to tell whether their salted fingerprints still
/// compare.
pub(super) fn salt_check() -> String {
    use sha2::{Digest, Sha256};
    hex(&Sha256::digest(salt())[..8])
}

fn salt() -> &'static [u8] {
    SALT.get_or_init(|| {
        let mut salt = [0u8; 16];
        // Without randomness the fingerprints still compare; they just aren't salted.
        let _ = getrandom::fill(&mut salt);
        salt
    })
}

// Every setup script starts with these, after the agent homes' own helpers.
//   sum_in       the fingerprint of what comes in: a SHA-256 where the machine
//                has a tool for that, a checksum marked with a c where not
//   hash_each    the same for each file named on its input, NUL-separated
//   dir_listing  the files in folder $1 (followed where it's a link), one
//                "path<TAB>fingerprint" line each in path order, leaving out
//                version control and dependency folders
pub(super) const HELPERS: &str = r##"command -v base64 >/dev/null 2>&1 || { echo "base64 isn't installed on this machine" >&2; exit 3; }
nl='
'
if command -v sha256sum >/dev/null 2>&1; then
  sum_in() { s=$(sha256sum) && printf '%s' "${s%% *}"; }
  hash_each() { xargs -0 sha256sum; }
  hashed=sha
elif command -v shasum >/dev/null 2>&1; then
  sum_in() { s=$(shasum -a 256) && printf '%s' "${s%% *}"; }
  hash_each() { xargs -0 shasum -a 256; }
  hashed=sha
else
  sum_in() { s=$(cksum) && printf 'c%s' "$(printf '%s' "$s" | tr ' ' '-')"; }
  hash_each() { xargs -0 cksum; }
  hashed=ck
fi
dir_listing() {
  ( cd "$1" 2>/dev/null || exit 0
    find -L . \( -name .git -o -name node_modules -o -name __pycache__ -o -name .DS_Store \) -prune -o -type f -print0 2>/dev/null \
      | hash_each 2>/dev/null \
      | awk -v mode="$hashed" '{
          if (mode == "ck") { h = "c" $1 "-" $2; p = $0; sub(/^[0-9]+ [0-9]+ /, "", p) }
          else { h = $1; sub(/^\\/, "", h); p = substr($0, length($1) + 3) }
          sub(/^\.\//, "", p)
          if (p != "-" && p != "") print p "\t" h
        }' \
      | LC_ALL=C sort )
}
"##;

// Follows HELPERS, in the scan and wherever a home's settings are read again:
//   emit_data kind file   a settings file as a J line, then its content in base64 and a line with
//                         a dot; `size` is `large` past 1 MB, with no content
//   emit_mcp file         of Claude Code's .claude.json, only the "mcpServers" object at its top,
//                         read out on the machine, as a J line of kind mcp
//   claude_mcp home       emit_mcp for the .claude.json a Claude Code home keeps its servers in: the
//                         one in the home, or for ~/.claude the one beside it
pub(super) const EMIT_FUNCTIONS: &str = r##"emit_data() {
  [ -f "$2" ] || return 0
  size=$(wc -c < "$2" | tr -d ' ')
  if [ "$size" -gt 1048576 ]; then printf 'J\t%s\t%s\tlarge\n.\n' "$1" "$2"; return 0; fi
  printf 'J\t%s\t%s\t%s\n' "$1" "$2" "$size"
  base64 < "$2"
  printf '.\n'
}
emit_mcp() {
  [ -f "$1" ] || return 0
  servers=$(awk '
    { n = length($0); from = 1
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (instr) {
          if (esc) esc = 0
          else if (c == "\\") esc = 1
          else if (c == "\"") { instr = 0; if (keyish) key = substr($0, kstart, i - kstart) }
          continue
        }
        if (c == "\"") { instr = 1; kstart = i + 1; keyish = (depth == 1 && !cap); continue }
        if (c == ":") { if (depth == 1 && !cap && key == "mcpServers") want = 1; continue }
        if (c == ",") { if (depth == 1) { key = ""; want = 0 }; continue }
        if (c == "{" || c == "[") { if (want && !cap) { cap = 1; want = 0; capdepth = depth; from = i }; depth++; continue }
        if (c == "}" || c == "]") { depth--; if (cap && depth == capdepth) { printf "%s%s", buf, substr($0, from, i - from + 1); exit } }
      }
      if (cap) buf = buf substr($0, from) "\n"
    }' "$1" 2>/dev/null) || return 0
  [ -n "$servers" ] || return 0
  printf 'J\tmcp\t%s\t%s\n' "$1" "$(printf '%s' "$servers" | wc -c | tr -d ' ')"
  printf '%s' "$servers" | base64
  printf '.\n'
}
claude_mcp() {
  if [ -f "$1/.claude.json" ]; then emit_mcp "$1/.claude.json"
  elif [ "$1" = "$HOME/.claude" ]; then emit_mcp "$HOME/.claude.json"
  fi
}
"##;

// Follows HELPERS. Lines out, paths as the machine has them:
//   H home                                  the machine's home directory
//   A agent home                            an agent home (claude, codex) or the shared ~/.agents,
//                                           which the lines after it belong to
//   F kind file sum size link               a file: instructions, rule, subagent, command or a
//                                           Codex profile. `sum` is - for a link that leads
//                                           nowhere, `link` - when it isn't one
//   S folder sum files link doc name chars when manual
//                                           a skill: its fingerprint and file count, whether it has
//                                           a SKILL.md (doc 1, or - for a link to nothing), and from
//                                           its front matter the name, the lengths of the description
//                                           and when_to_use, and whether only a person can invoke it
//                                           (manual 1, from disable-model-invocation)
//   I level from written path sum           an @import in `from`, as written and where it leads;
//                                           `sum` is - when nothing's there
//   J kind file size                        a settings file, then its content in base64 and a line
//                                           with a dot; `size` is `large` past 1 MB, with no content.
//                                           Before the first home, `managed` is the machine's
//                                           managed-settings policy, whose `size` is `unreadable`
//                                           when it's there and can't be read
//   K entry link                            first in a Codex home, each of its top-level entries that's
//                                           a link, and where it leads: T3 Code's shadow homes link
//                                           everything but their sign-in to the home they share
//   B agent path real version               an install, from INSTALLS_SCRIPT
// Of Claude Code's .claude.json, only the "mcpServers" object at its top is read out.
const SCAN_SCRIPT: &str = r##"emit_file() {
  if [ -f "$2" ]; then
    sum=$(sum_in < "$2") || return 0
    size=$(wc -c < "$2" | tr -d ' ')
  elif [ -L "$2" ]; then
    sum=-; size=0
  else
    return 0
  fi
  link=-
  if [ -L "$2" ]; then link=$(readlink "$2" 2>/dev/null) || link=-; fi
  printf 'F\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$sum" "$size" "$link"
}
emit_tree() {
  [ -d "$2" ] || return 0
  find -L "$2" \( -type f -o -type l \) -name "$3" 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do emit_file "$1" "$f"; done
}
import_tokens() {
  awk '
    { t = $0; sub(/^[ \t]+/, "", t) }
    fence != "" { if (substr(t, 1, 3) == fence) fence = ""; next }
    substr(t, 1, 3) == "```" || substr(t, 1, 3) == "~~~" { fence = substr(t, 1, 3); next }
    { line = $0; gsub(/`[^`]*`/, " ", line)
      n = split(line, w, /[ \t]+/)
      for (i = 1; i <= n; i++) if (substr(w[i], 1, 1) == "@" && length(w[i]) > 1) print substr(w[i], 2) }
  ' "$1" 2>/dev/null
}
resolve_import() {
  case "$2" in
    "~/"*) printf '%s/%s' "$HOME" "${2#??}" ;;
    /*) printf '%s' "$2" ;;
    *) printf '%s/%s' "$1" "$2" ;;
  esac
}
walk_imports() {
  set -f
  saved_ifs=$IFS
  IFS=$nl
  level=1; current=$1; seen=$1
  while [ -n "$current" ] && [ "$level" -le 5 ]; do
    next=
    for from in $current; do
      for token in $(import_tokens "$from"); do
        path=$(resolve_import "${from%/*}" "$token")
        sum=-
        if [ -f "$path" ]; then sum=$(sum_in < "$path") || sum=-; fi
        printf 'I\t%s\t%s\t%s\t%s\t%s\n' "$level" "$from" "$token" "$path" "$sum"
        if [ "$sum" != - ]; then
          case "$nl$seen$nl" in
            *"$nl$path$nl"*) ;;
            *) seen=$seen$nl$path; next=$next$nl$path ;;
          esac
        fi
      done
    done
    current=${next#"$nl"}
    level=$((level + 1))
  done
  IFS=$saved_ifs
  set +f
}
skill_meta() {
  awk '
    function bare(v) { sub(/[ \t\r]+$/, "", v); gsub(/^["\047]|["\047]$/, "", v); return v }
    function size(v) { sub(/[ \t\r]+$/, "", v); return v ~ /^[>|][-+0-9]*$/ ? 0 : length(bare(v)) }
    NR == 1 { if ($0 !~ /^---[ \t\r]*$/) exit; next }
    /^---[ \t\r]*$/ { exit }
    /^name:/ { v = $0; sub(/^name:[ \t]*/, "", v); name = bare(v); key = ""; next }
    /^description:/ { v = $0; sub(/^description:[ \t]*/, "", v); len["d"] = size(v); key = "d"; next }
    /^when_to_use:/ { v = $0; sub(/^when_to_use:[ \t]*/, "", v); len["w"] = size(v); key = "w"; next }
    /^disable-model-invocation:/ { v = $0; sub(/^disable-model-invocation:[ \t]*/, "", v); v = bare(v); manual = (v == "true" || v == "True" || v == "TRUE"); key = ""; next }
    key != "" && /^[ \t]/ { v = $0; sub(/^[ \t]+/, "", v); sub(/[ \t\r]+$/, "", v); if (v != "") len[key] += (len[key] ? 1 : 0) + length(v); next }
    { key = "" }
    END { printf "%s\t%d\t%d\t%d", name, len["d"], len["w"], manual }
  ' "$1" 2>/dev/null
}
emit_skills() {
  if [ -L "$1" ]; then printf 'SL\t%s\t%s\n' "$1" "$(readlink "$1" 2>/dev/null)"; fi
  for dir in "$1"/*; do
    doc=0; sum=-; files=0; meta=$tab$tab$tab
    if [ -d "$dir" ]; then
      if [ -f "$dir/SKILL.md" ]; then
        doc=1
        listing=$(dir_listing "$dir")
        if [ -n "$listing" ]; then
          files=$(printf '%s\n' "$listing" | wc -l | tr -d ' ')
          sum=$(printf '%s\n' "$listing" | sum_in)
        fi
        meta=$(skill_meta "$dir/SKILL.md")
      fi
    elif [ ! -L "$dir" ]; then
      continue
    elif [ ! -e "$dir" ]; then
      doc=-
    fi
    link=-
    if [ -L "$dir" ]; then link=$(readlink "$dir" 2>/dev/null) || link=-; fi
    printf 'S\t%s\t%s\t%s\t%s\t%s\t%s\n' "$dir" "$sum" "$files" "$link" "$doc" "$meta"
  done
}
claude_home() {
  emit_file instructions "$1/CLAUDE.md"
  if [ -f "$1/CLAUDE.md" ]; then walk_imports "$1/CLAUDE.md"; fi
  emit_tree rule "$1/rules" '*.md'
  if [ -d "$1/rules" ]; then
    find -L "$1/rules" -type f -name '*.md' 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do walk_imports "$f"; done
  fi
  for f in "$1"/agents/*.md; do emit_file subagent "$f"; done
  emit_tree command "$1/commands" '*.md'
  emit_skills "$1/skills"
  emit_data settings "$1/settings.json"
  claude_mcp "$1"
  emit_data plugins "$1/plugins/installed_plugins.json"
  emit_data marketplaces "$1/plugins/known_marketplaces.json"
}
codex_home() {
  for entry in "$1"/*; do
    if [ -L "$entry" ]; then printf 'K\t%s\t%s\n' "${entry##*/}" "$(readlink "$entry" 2>/dev/null)"; fi
  done
  emit_file instructions "$1/AGENTS.override.md"
  emit_file instructions "$1/AGENTS.md"
  emit_tree rule "$1/rules" '*.rules'
  emit_tree command "$1/prompts" '*.md'
  emit_skills "$1/skills"
  for f in "$1"/*.config.toml; do emit_file profile "$f"; done
  emit_data config "$1/config.toml"
  emit_data hooks "$1/hooks.json"
}
printf 'H\t%s\n' "$HOME"
if [ -f "$policy" ]; then
  if [ -r "$policy" ]; then emit_data managed "$policy"; else printf 'J\tmanaged\t%s\tunreadable\n.\n' "$policy"; fi
fi
agent_homes | while IFS=$tab read -r agent home; do
  printf 'A\t%s\t%s\n' "$agent" "$home"
  case "$agent" in
    claude) claude_home "$home" ;;
    codex) codex_home "$home" ;;
    *) harness_home "$agent" "$home" ;;
  esac < /dev/null
done
if [ -d "$HOME/.agents" ]; then
  printf 'A\tshared\t%s\n' "$HOME/.agents"
  emit_skills "$HOME/.agents/skills"
  emit_tree command "$HOME/.agents/commands" '*.md'
  for f in "$HOME"/.agents/hooks/*; do emit_file hookscript "$f"; done
  emit_data skilllock "$HOME/.agents/.skill-lock.json"
fi
"##;

// Follows HELPERS and `harnesses::installs_script`. `emit_installs` takes a PATH and lists each
// agent's command along it, first to last, so the first of each is the one that runs:
// `B agent path real version`, where `real` is the file the path leads to. A
// file reached twice, by a link or a directory listed twice, is listed once;
// directories that aren't absolute are passed over.
pub(super) const INSTALLS_SCRIPT: &str = r##"emit_installs() {
  for agent in $install_agents; do
    seen=$nl
    old_ifs=$IFS
    IFS=:
    set -f
    for dir in $1; do
      IFS=$old_ifs
      case "$dir" in /*) ;; *) continue ;; esac
      bin="$dir/$agent"
      if [ -f "$bin" ] && [ -x "$bin" ]; then
        real=$(realpath "$bin" 2>/dev/null || readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")
        case "$seen" in *"$nl$real$nl"*) continue ;; esac
        seen="$seen$real$nl"
        version=$(install_version "$agent" "$bin" </dev/null 2>/dev/null | head -n 1 | tr -d '\t')
        printf 'B\t%s\t%s\t%s\t%s\n' "$agent" "$bin" "$real" "$version"
      fi
    done
    IFS=$old_ifs
    set +f
  done
}
"##;

// Expects `f`, the file to show. Lines out: `T size` and the file in base64,
// or `L size` when it's over 256 KB.
const READ_TEXT_SCRIPT: &str = r##"command -v base64 >/dev/null 2>&1 || { echo "base64 isn't installed on this machine" >&2; exit 3; }
if [ ! -f "$f" ]; then echo "It isn't there any more. Scan again to see what is." >&2; exit 4; fi
size=$(wc -c < "$f" | tr -d ' ')
if [ "$size" -gt 262144 ]; then printf 'L\t%s\n' "$size"; exit 0; fi
printf 'T\t%s\n' "$size"
base64 < "$f"
"##;

// Follows HELPERS and expects `d`, the skill's folder. A line for each file:
//   C path sum size       then its content in base64 and a line with a dot
//   N path sum size why   one that isn't shown: `secret` by its name, or `large`, past 128 KB,
//                         or once 1 MB of the skill has been shown
const READ_SKILL_SCRIPT: &str = r##"if [ ! -d "$d" ]; then echo "It isn't there any more. Scan again to see what is." >&2; exit 4; fi
cd "$d" || exit 4
total=0
dir_listing . | while IFS=$tab read -r path sum; do
  size=$(wc -c < "$path" | tr -d ' ')
  lower=$(printf '%s' "/$path" | tr '[:upper:]' '[:lower:]')
  case "$lower" in
    */.env*|*.pem|*.key|*.p12|*.pfx|*credential*|*secret*|*token*|*/auth.json|*/.netrc|*/id_rsa*|*/id_ed25519*)
      printf 'N\t%s\t%s\t%s\tsecret\n' "$path" "$sum" "$size"; continue ;;
  esac
  if [ "$size" -gt 131072 ] || [ $((total + size)) -gt 1048576 ]; then
    printf 'N\t%s\t%s\t%s\tlarge\n' "$path" "$sum" "$size"; continue
  fi
  total=$((total + size))
  printf 'C\t%s\t%s\t%s\n' "$path" "$sum" "$size"
  base64 < "$path"
  printf '.\n'
done
"##;

/// Claude Code settings shown as they're set; others only compare.
const CLAUDE_SHOWN: [&str; 6] = ["model", "effortLevel", "outputStyle", "permissions.defaultMode", "language", "autoUpdatesChannel"];
/// Codex settings shown as they're set; others only compare.
const CODEX_SHOWN: [&str; 11] = [
    "model",
    "model_provider",
    "model_reasoning_effort",
    "model_reasoning_summary",
    "model_verbosity",
    "approval_policy",
    "sandbox_mode",
    "personality",
    "web_search",
    "service_tier",
    "review_model",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub(crate) enum HomeAgent {
    Claude,
    Codex,
    /// The machine's ~/.agents, which Codex reads skills from and `npx skills` installs to.
    Shared,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ItemKind {
    Instructions,
    Import,
    Rule,
    Skill,
    Subagent,
    Command,
    Hook,
    Mcp,
    Plugin,
    Marketplace,
    Setting,
    Env,
    Profile,
}

/// A skill's folder, as the scan found it.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillFacts {
    files: u32,
    /// It has a SKILL.md, without which the agents don't load it.
    has_doc: bool,
    /// The name its front matter gives, which should match its folder.
    declared_name: Option<String>,
    /// How long its description is, in bytes.
    description_chars: u32,
    /// How long its when_to_use is, in bytes, which Claude Code lists after the description.
    when_to_use_chars: u32,
    /// Only a person can invoke it (`disable-model-invocation: true`), so Claude Code leaves it out
    /// of the skills it lists for the model.
    manual_only: bool,
    /// Where `npx skills` installed it from, for a shared skill: "owner/repo".
    source: Option<String>,
}

/// Where an @import is, in the file that has it.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportFacts {
    /// The file with the @import, with the machine's home as ~.
    from: String,
    /// The path as written after the @.
    written: String,
    /// 1 for an @import in the instructions or a rule, 2 for one in the file that pulls in, and so on.
    level: u8,
}

/// One thing an agent home loads.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupItem {
    kind: ItemKind,
    name: String,
    /// The file or folder, with the machine's home as ~. None for something in a settings file.
    path: Option<String>,
    /// A fingerprint of what it holds. None when it's missing: an @import that leads nowhere, or a
    /// link to nothing.
    sum: Option<String>,
    /// A file's size in bytes.
    size: Option<u64>,
    /// Where a link leads, with the machine's home as ~.
    link: Option<String>,
    /// What it's set to, where that's safe to show: a setting's value, a plugin's version, an MCP
    /// server's transport.
    value: Option<String>,
    /// A second fact: the host or program of an MCP server, the source of a marketplace.
    note: Option<String>,
    /// How many it holds: handlers for a hook, entries in a list setting.
    count: Option<u32>,
    /// Whether it's switched on, for plugins; false for an AGENTS.md an override replaces.
    enabled: Option<bool>,
    /// Can be shown and compared line by line.
    text: bool,
    /// None for a skill that's a link to nothing.
    skill: Option<SkillFacts>,
    import: Option<ImportFacts>,
}

impl SetupItem {
    fn new(kind: ItemKind, name: impl Into<String>) -> Self {
        Self {
            kind,
            name: name.into(),
            path: None,
            sum: None,
            size: None,
            link: None,
            value: None,
            note: None,
            count: None,
            enabled: None,
            text: false,
            skill: None,
            import: None,
        }
    }
}

/// What a `skillOverrides` entry in Claude Code's settings does to a skill.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OverrideState {
    On,
    /// Listed for the model by its name alone, without its description.
    NameOnly,
    /// Hidden from the model, as `disable-model-invocation` hides it: only a person can invoke it.
    UserInvocableOnly,
    Off,
}

impl OverrideState {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "on" => Some(Self::On),
            "name-only" => Some(Self::NameOnly),
            "user-invocable-only" => Some(Self::UserInvocableOnly),
            "off" => Some(Self::Off),
            _ => None,
        }
    }
}

/// Where a skill's override is set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub(crate) enum OverrideSource {
    /// The home's own settings.json.
    Settings,
    /// The machine's managed-settings policy, which outranks every home's settings.
    Policy,
}

/// A skill Claude Code's settings turn off, or change how it's offered to the model.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillOverride {
    /// The skill's folder name, which is what Claude Code goes by.
    name: String,
    state: OverrideState,
    source: OverrideSource,
    /// The file that sets it, with the machine's home as ~.
    file: String,
}

/// A name a skill folder, setting or variable could have, so nothing odd from a settings file
/// reaches the page.
fn sane_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 256 && !name.chars().any(char::is_control)
}

/// A settings file's `skillOverrides`, or None when Claude Code would ignore it. It checks the
/// whole map, not each entry: one value it doesn't know, or one that isn't a string, and it drops
/// every override in the file.
/// The servers a `deniedMcpServers` list denies by name (`{"serverName": …}`), nothing else of it. Entries by URL or
/// command aren't a name Arbor can match, so they're left out.
pub(super) fn denied_mcp_names(value: &Value) -> Vec<String> {
    let mut names: Vec<String> = value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("serverName")?.as_str())
        .filter(|name| sane_name(name))
        .map(str::to_string)
        .collect();
    names.sort();
    names.dedup();
    names
}

pub(super) fn parse_overrides(value: &Value) -> Option<BTreeMap<String, OverrideState>> {
    value
        .as_object()?
        .iter()
        .map(|(name, state)| Some((name.clone(), OverrideState::parse(state.as_str()?)?)))
        .collect::<Option<BTreeMap<_, _>>>()
        .map(|overrides| overrides.into_iter().filter(|(name, _)| sane_name(name)).collect())
}

/// Where Claude Code looks for the policy an administrator sets for every user and home on the
/// machine: `managed-settings.json` in /Library/Application Support/ClaudeCode on a Mac and in
/// /etc/claude-code elsewhere. Sets `policy` for the scan.
const POLICY_FILE: &str = r##"case "$(uname -s 2>/dev/null)" in
  Darwin) policy="/Library/Application Support/ClaudeCode/managed-settings.json" ;;
  *) policy=/etc/claude-code/managed-settings.json ;;
esac
"##;

/// The most keys a policy is read for, so a strange file can't flood the page.
const POLICY_KEYS_MAX: usize = 500;

/// Something the machine's managed-settings policy sets, by name alone: a setting, an env
/// variable's name, a hook event, a plugin or a marketplace, named as a home's items are.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PolicyKey {
    kind: ItemKind,
    name: String,
}

/// The managed-settings policy Claude Code finds on a machine. It outranks every home's own
/// settings, and Arbor only ever reads it: its values, env values above all, never leave the scan.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudePolicy {
    /// Where it is on the machine.
    file: String,
    /// What it sets, by name.
    keys: Vec<PolicyKey>,
    /// Why Arbor couldn't read it, when it couldn't; what it sets is then unknown.
    problem: Option<String>,
    /// Claude Code ignores its `skillOverrides`, as one of the values isn't one it knows.
    ignored_overrides: bool,
}

/// Overrides as a settings file has them: None when it has none, Some(None) when Claude Code
/// ignores the ones it has.
type FileOverrides = Option<Option<BTreeMap<String, OverrideState>>>;

/// The names in a policy, taken the way a home's settings are, so each lines up with the home's
/// item of the same name, and its skill overrides apart.
fn policy_keys(value: &Value) -> (Vec<PolicyKey>, FileOverrides) {
    let mut keys = BTreeSet::new();
    let mut overrides = None;
    let mut add = |kind: ItemKind, name: &str| {
        if sane_name(name) && keys.len() < POLICY_KEYS_MAX {
            keys.insert(PolicyKey { kind, name: name.to_string() });
        }
    };
    let names = |value: &Value| value.as_object().map(|map| map.keys().cloned().collect::<Vec<_>>()).unwrap_or_default();
    for (key, value) in value.as_object().into_iter().flatten() {
        match key.as_str() {
            "hooks" => names(value).iter().for_each(|event| add(ItemKind::Hook, event)),
            "env" => names(value).iter().for_each(|name| add(ItemKind::Env, name)),
            "enabledPlugins" => names(value).iter().for_each(|id| add(ItemKind::Plugin, id)),
            "extraKnownMarketplaces" => names(value).iter().for_each(|name| add(ItemKind::Marketplace, name)),
            // Each skill's override shows on the skill, as a home's own do.
            "skillOverrides" => overrides = Some(parse_overrides(value)),
            "feedbackDrafts" | "$schema" => {}
            "permissions" if value.is_object() => names(value).iter().for_each(|part| add(ItemKind::Setting, &format!("permissions.{part}"))),
            _ => add(ItemKind::Setting, key),
        }
    }
    (keys.into_iter().collect(), overrides)
}

/// A policy file from a scan's `J managed` line, and the skill overrides it sets that Claude Code
/// keeps. `size` is `unreadable` when the file's there and the user the scan runs as can't read it.
fn read_policy(path: &str, size: &str, encoded: &str) -> (ClaudePolicy, Option<BTreeMap<String, OverrideState>>, Vec<String>) {
    let mut policy = ClaudePolicy { file: path.to_string(), keys: Vec::new(), problem: None, ignored_overrides: false };
    let bytes = match size {
        "unreadable" => Err(format!("{path} is there, but the user Arbor signs in as can't read it")),
        "large" => Err(format!("{path} is over 1 MB, so Arbor didn't read it")),
        _ => match STANDARD.decode(encoded.as_bytes()) {
            Ok(bytes) if size.parse::<usize>().ok() == Some(bytes.len()) => Ok(bytes),
            _ => Err(format!("{path} came back incomplete")),
        },
    };
    let value = bytes.and_then(|bytes| serde_json::from_slice::<Value>(&bytes).map_err(|_| format!("{path} isn't JSON Arbor can read")));
    let value = match value {
        Ok(value) => value,
        Err(problem) => {
            policy.problem = Some(problem);
            return (policy, None, Vec::new());
        }
    };
    let (keys, overrides) = policy_keys(&value);
    policy.keys = keys;
    policy.ignored_overrides = matches!(overrides, Some(None));
    (policy, overrides.flatten(), value.get("deniedMcpServers").map(denied_mcp_names).unwrap_or_default())
}

/// Another Codex home on the machine that this one's entries are links into, the way T3 Code
/// builds a shadow home: every entry but its sign-in leads to the same entry in the home it shares.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SharedHome {
    /// The home it shares, with the machine's home as ~.
    home: String,
    /// Its entries that lead there, by name. What's in them is that home's, and shows there.
    entries: Vec<String>,
}

/// The most shared entries kept for a home; T3 Code links a dozen or so.
const SHARED_ENTRIES_MAX: usize = 200;

/// An agent home, or the machine's shared ~/.agents, and what's in it.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupHome {
    agent: HomeAgent,
    /// With the machine's home as ~.
    path: String,
    items: Vec<SetupItem>,
    /// Files in it Arbor couldn't read.
    problems: Vec<String>,
    /// Where its skills folder leads, when that's a link: every skill in it is then that folder's.
    skills_link: Option<String>,
    /// Skills Claude Code's settings turn off or change for this home, by name.
    skill_overrides: Vec<SkillOverride>,
    /// Settings files whose `skillOverrides` Claude Code ignores altogether, because one of its
    /// values isn't one it knows.
    ignored_overrides: Vec<String>,
    /// MCP servers its settings.json, or the machine's policy, deny by name: nothing turns them on
    /// in a project.
    denied_mcp: Vec<String>,
    /// The Codex home this one's entries lead into, for a shadow home. What they hold is left to
    /// that home, so the two aren't read as separate homes that drift apart.
    shares: Option<SharedHome>,
    /// Hooks that run a script in ~/.agents/hooks, which the setup repo keeps. Only Arbor compares
    /// them, by fingerprint; their commands are never sent on.
    #[serde(skip)]
    repo_hooks: Vec<FoundHook>,
}

/// A hook in a home's settings that runs a script in ~/.agents/hooks.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(super) struct FoundHook {
    pub(super) event: String,
    /// The script's file name in ~/.agents/hooks.
    pub(super) script: String,
    /// A fingerprint of its matcher and handler, as `hook_sum` gives one.
    pub(super) sum: String,
}

/// A home of a harness other than Claude Code and Codex, as far as Sync reads it so far: its own instructions file
/// and the skills in its own folder, which the setup repo and skill changes reach.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessHome {
    harness: Harness,
    /// With the machine's home as ~.
    path: String,
    items: Vec<SetupItem>,
    /// Where its skills folder leads, when that's a link: every skill in it is then that folder's.
    skills_link: Option<String>,
    /// Files it couldn't read, kept only so change alerts can tell an unreadable file from everything in it going.
    #[serde(skip)]
    problems: Vec<String>,
}

/// A Claude Code or Codex on the machine's PATH. The first of each agent is the one that runs.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupInstall {
    agent: AgentKind,
    /// With the machine's home as ~.
    path: String,
    /// The file `path` leads to, when that's somewhere else.
    real: Option<String>,
    /// From `--version`; None when it printed nothing that reads as one.
    version: Option<String>,
}

/// Another harness's command on the machine's PATH. The first of each harness is the one that runs.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessInstall {
    harness: Harness,
    /// With the machine's home as ~.
    path: String,
    /// The file `path` leads to, when that's somewhere else.
    real: Option<String>,
    /// From its version command; None when it printed nothing that reads as one.
    version: Option<String>,
    /// Its own command that updates it, which the page shows before running it; none when Arbor doesn't update it.
    update_command: Option<String>,
}

/// What the last scan of a machine found. A failed scan keeps what the last good one found.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineSetup {
    homes: Vec<SetupHome>,
    /// The other harnesses' homes, read for their own instructions, skills, MCP servers and hooks.
    harness_homes: Vec<HarnessHome>,
    installs: Vec<SetupInstall>,
    harness_installs: Vec<HarnessInstall>,
    /// Claude Code's managed-settings policy, when the machine has one.
    policy: Option<ClaudePolicy>,
    scanned_at: Option<i64>,
    error: Option<String>,
    scanning: bool,
    /// The machine's home directory, to turn a ~ path back into the one it has.
    #[serde(skip)]
    home_dir: String,
    /// When Arbor last changed something here itself, until a scan that started after that has
    /// seen it: what scans find meanwhile isn't a change to tell anyone about.
    #[serde(skip)]
    arbor_wrote_ms: Option<i64>,
}

/// A hook, MCP server, plugin marketplace or plugin that came, went or changed between two scans
/// of a machine. Each can run code on it, so it's worth hearing about when Arbor didn't do it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupChange {
    /// The home it's in, any agent's, with the machine's home as ~.
    home: String,
    kind: ItemKind,
    name: String,
    change: ChangeKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ChangeKind {
    Added,
    Removed,
    Changed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupChanged {
    machine: String,
    changes: Vec<SetupChange>,
}

pub(crate) const SETUP_CHANGED_EVENT: &str = "setup-changed";

/// What's watched for changes. A plugin's fingerprint follows its version, which updates on its
/// own, so only a plugin coming or going counts.
const WATCHED: [ItemKind; 4] = [ItemKind::Hook, ItemKind::Mcp, ItemKind::Marketplace, ItemKind::Plugin];

/// One home as change alerts see it: Claude Code's, Codex's, the shared one or another harness's.
struct WatchedHome<'a> {
    path: &'a str,
    problems: &'a [String],
    items: &'a [SetupItem],
}

/// Every home a scan found, each path once.
fn watched_homes<'a>(homes: &'a [SetupHome], harness_homes: &'a [HarnessHome]) -> Vec<WatchedHome<'a>> {
    homes
        .iter()
        .map(|home| WatchedHome { path: &home.path, problems: &home.problems, items: &home.items })
        .chain(harness_homes.iter().map(|home| WatchedHome { path: &home.path, problems: &home.problems, items: &home.items }))
        .collect()
}

/// The watched things that came, went or changed from one scan's homes to the next. A home whose
/// unreadable files differ between the two is left out, since a file that couldn't be read looks
/// like everything in it going away.
fn watched_changes(before: &[WatchedHome], after: &[WatchedHome]) -> Vec<SetupChange> {
    let watched = |home: &WatchedHome| -> BTreeMap<(ItemKind, String), Option<String>> {
        home.items.iter().filter(|item| WATCHED.contains(&item.kind)).map(|item| ((item.kind, item.name.clone()), item.sum.clone())).collect()
    };
    let none = BTreeMap::new();
    let mut changes = Vec::new();
    let paths: BTreeSet<&str> = before.iter().chain(after).map(|home| home.path).collect();
    for path in paths {
        let old = before.iter().find(|home| home.path == path);
        let new = after.iter().find(|home| home.path == path);
        if old.map_or(&[][..], |home| home.problems) != new.map_or(&[][..], |home| home.problems) {
            continue;
        }
        let (old_items, new_items) = (old.map(watched), new.map(watched));
        let (old_items, new_items) = (old_items.as_ref().unwrap_or(&none), new_items.as_ref().unwrap_or(&none));
        let mut change = |(kind, name): &(ItemKind, String), change: ChangeKind| {
            changes.push(SetupChange { home: path.to_string(), kind: *kind, name: name.clone(), change });
        };
        for (key, sum) in new_items {
            match old_items.get(key) {
                None => change(key, ChangeKind::Added),
                Some(old_sum) if old_sum != sum && key.0 != ItemKind::Plugin => change(key, ChangeKind::Changed),
                Some(_) => {}
            }
        }
        for key in old_items.keys().filter(|key| !new_items.contains_key(*key)) {
            change(key, ChangeKind::Removed);
        }
    }
    changes
}

#[derive(Debug, Default, PartialEq)]
struct Scan {
    home_dir: String,
    homes: Vec<SetupHome>,
    harness_homes: Vec<HarnessHome>,
    installs: Vec<SetupInstall>,
    harness_installs: Vec<HarnessInstall>,
    policy: Option<ClaudePolicy>,
}

// ---------------------------------------------------------------------------
// Fingerprints and paths
// ---------------------------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A path in the machine's home written with ~, anywhere in `text`.
fn home_as_tilde(text: &str, home: &str) -> String {
    if home.is_empty() || home == "/" {
        return text.to_string();
    }
    let text = text.replace(&format!("{home}/"), "~/");
    if text == home {
        "~".to_string()
    } else {
        text
    }
}

/// JSON with its keys in order and the machine's home as ~, so the same settings read the same on
/// every machine.
fn write_canonical(value: &Value, home: &str, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_canonical(&map[key], home, out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, home, out);
            }
            out.push(']');
        }
        Value::String(text) => out.push_str(&Value::String(home_as_tilde(text, home)).to_string()),
        other => out.push_str(&other.to_string()),
    }
}

/// A salted fingerprint of a settings value.
fn fingerprint(value: &Value, home: &str, salt: &[u8]) -> String {
    let mut canonical = String::new();
    write_canonical(value, home, &mut canonical);
    let mut hasher = Sha256::new();
    hasher.update(salt);
    hasher.update(canonical.as_bytes());
    hex(&hasher.finalize()[..12])
}

/// `path` with `.` and `..` worked out, without asking the file system.
fn normalize_path(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            _ => parts.push(part),
        }
    }
    let joined = parts.join("/");
    if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

pub(super) fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Where a link at `path` that reads `link` leads.
fn link_target(path: &str, link: &str) -> String {
    if link.starts_with('/') {
        normalize_path(link)
    } else {
        normalize_path(&format!("{}/{link}", parent(path)))
    }
}

/// A ~ path as the machine has it.
fn untilde(path: &str, home: &str) -> String {
    match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{home}{rest}"),
        _ => path.to_string(),
    }
}

/// A file whose name says it may hold a secret, which is never shown.
pub(super) fn looks_secret(path: &str) -> bool {
    let name = file_name(path).to_ascii_lowercase();
    name.starts_with(".env")
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || name == "auth.json"
        || name == ".netrc"
        || [".pem", ".key", ".p12", ".pfx"].iter().any(|end| name.ends_with(end))
        || ["credential", "secret", "token"].iter().any(|word| name.contains(word))
}

/// The host of a URL, without any user name or password in it.
pub(super) fn url_host(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    (!host.is_empty()).then(|| host.to_string())
}

/// A URL's host and path, without credentials, query or fragment.
fn url_place(url: &str) -> Option<String> {
    let host = url_host(url)?;
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let path = rest
        .split(['?', '#'])
        .next()
        .and_then(|before| before.find('/').map(|at| &before[at..]))
        .unwrap_or("");
    Some(format!("{host}{}", path.trim_end_matches('/')))
}

// ---------------------------------------------------------------------------
// Reading what the scan found
// ---------------------------------------------------------------------------

/// A home's findings as they come in, turned into items once the home's done.
struct HomeParts {
    agent: HomeAgent,
    /// The harness, for a home that isn't Claude Code's, Codex's or the shared one.
    harness: Option<Harness>,
    /// As the machine has it.
    path: String,
    items: Vec<SetupItem>,
    problems: Vec<String>,
    /// Plugins from enabledPlugins in settings.json: on or off.
    enabled: BTreeMap<String, bool>,
    /// Plugins installed for the user: version and commit.
    installed: BTreeMap<String, Value>,
    /// When each of those was last installed or updated.
    plugin_updated: BTreeMap<String, String>,
    /// Marketplaces: where each comes from.
    marketplaces: BTreeMap<String, Value>,
    /// When Claude Code last fetched each marketplace, and whether it keeps it up to date itself.
    marketplace_state: BTreeMap<String, (Option<String>, Option<bool>)>,
    /// Auto-update as settings set it for a marketplace, which comes before what Claude Code recorded.
    marketplace_auto: BTreeMap<String, bool>,
    /// Shared skills' sources, from `npx skills`' lock file.
    sources: BTreeMap<String, String>,
    repo_hooks: Vec<FoundHook>,
    skills_link: Option<String>,
    /// Skills settings.json overrides, with the file, as the machine has it.
    overrides: Option<(String, BTreeMap<String, OverrideState>)>,
    /// Settings files whose overrides Claude Code ignores, as the machine has them.
    ignored_overrides: Vec<String>,
    /// MCP servers settings.json denies by name.
    denied_mcp: Vec<String>,
    /// The Codex home this one's links lead into, as the machine has it, and which entries do.
    shares: Option<(String, BTreeSet<String>)>,
}

impl HomeParts {
    fn new(agent: HomeAgent, path: &str) -> Self {
        Self {
            agent,
            harness: None,
            path: path.to_string(),
            items: Vec::new(),
            problems: Vec::new(),
            enabled: BTreeMap::new(),
            installed: BTreeMap::new(),
            plugin_updated: BTreeMap::new(),
            marketplaces: BTreeMap::new(),
            marketplace_state: BTreeMap::new(),
            marketplace_auto: BTreeMap::new(),
            sources: BTreeMap::new(),
            repo_hooks: Vec::new(),
            skills_link: None,
            overrides: None,
            ignored_overrides: Vec::new(),
            denied_mcp: Vec::new(),
            shares: None,
        }
    }

    /// A top-level entry that's a link. One leading to the same entry in another of the machine's
    /// Codex homes makes the entry that home's.
    fn link(&mut self, entry: &str, link: &str, codex_homes: &BTreeSet<String>) {
        if entry.is_empty() || entry.contains('/') || link.is_empty() {
            return;
        }
        let target = link_target(&format!("{}/{entry}", self.path), link);
        let home = parent(&target);
        if file_name(&target) != entry || home == self.path || !codex_homes.contains(home) {
            return;
        }
        let (shared, entries) = self.shares.get_or_insert_with(|| (home.to_string(), BTreeSet::new()));
        if shared.as_str() == home && entries.len() < SHARED_ENTRIES_MAX {
            entries.insert(entry.to_string());
        }
    }

    /// Whether `path` is in an entry this home shares with another, so what's there is that home's.
    fn is_shared(&self, path: &str) -> bool {
        let Some((_, entries)) = &self.shares else {
            return false;
        };
        path.strip_prefix(self.path.as_str())
            .and_then(|rest| rest.strip_prefix('/'))
            .is_some_and(|rest| entries.contains(rest.split('/').next().unwrap_or(rest)))
    }

    fn file(&mut self, kind: &str, path: &str, sum: &str, size: &str, link: &str, home: &str) {
        let (kind, name, text) = match kind {
            "instructions" => (ItemKind::Instructions, file_name(path).to_string(), true),
            "rule" => (ItemKind::Rule, self.relative(path, "rules").to_string(), true),
            "subagent" => (ItemKind::Subagent, file_name(path).trim_end_matches(".md").to_string(), true),
            "command" => {
                let folder = if self.agent == HomeAgent::Codex { "prompts" } else { "commands" };
                (ItemKind::Command, self.relative(path, folder).trim_end_matches(".md").replace('/', ":"), true)
            }
            "profile" => (ItemKind::Profile, file_name(path).trim_end_matches(".config.toml").to_string(), false),
            // The scripts the setup repo's hooks run, by file name.
            "hookscript" => (ItemKind::Hook, file_name(path).to_string(), true),
            _ => return,
        };
        let mut item = SetupItem::new(kind, name);
        item.path = Some(tilde(path, home));
        item.sum = (sum != "-").then(|| sum.to_string());
        item.size = size.parse().ok();
        item.link = (link != "-").then(|| tilde(&link_target(path, link), home));
        item.text = text && item.sum.is_some() && !looks_secret(path);
        self.items.push(item);
    }

    /// `path` under this home's `folder`.
    fn relative<'a>(&self, path: &'a str, folder: &str) -> &'a str {
        let prefix = format!("{}/{folder}/", self.path);
        path.strip_prefix(prefix.as_str()).unwrap_or_else(|| file_name(path))
    }

    #[allow(clippy::too_many_arguments)]
    fn skill(&mut self, path: &str, sum: &str, files: &str, link: &str, doc: &str, meta: [&str; 4], home: &str) {
        let [name, chars, when, manual] = meta;
        let mut item = SetupItem::new(ItemKind::Skill, file_name(path));
        item.path = Some(tilde(path, home));
        item.sum = (sum != "-").then(|| sum.to_string());
        item.link = (link != "-").then(|| tilde(&link_target(path, link), home));
        // A link to nothing has no folder to tell anything about.
        item.skill = (doc != "-").then(|| SkillFacts {
            files: files.parse().unwrap_or(0),
            has_doc: doc == "1",
            declared_name: (!name.is_empty()).then(|| name.to_string()),
            description_chars: chars.parse().unwrap_or(0),
            when_to_use_chars: when.parse().unwrap_or(0),
            manual_only: manual == "1",
            source: None,
        });
        self.items.push(item);
    }

    fn import(&mut self, level: &str, from: &str, written: &str, path: &str, sum: &str, home: &str) {
        let name = tilde(&normalize_path(path), home);
        // A file pulled in from more than one place is listed once, where it's first reached.
        if self.items.iter().any(|item| item.kind == ItemKind::Import && item.name == name) {
            return;
        }
        let mut item = SetupItem::new(ItemKind::Import, name.clone());
        item.path = Some(name);
        item.sum = (sum != "-").then(|| sum.to_string());
        item.text = item.sum.is_some() && !looks_secret(path);
        item.import = Some(ImportFacts {
            from: tilde(from, home),
            written: written.to_string(),
            level: level.parse().unwrap_or(1),
        });
        self.items.push(item);
    }

    /// A settings file's content. Only what the items need is taken from it; the rest is dropped
    /// with it, and it's never quoted in a problem.
    fn data(&mut self, kind: &str, path: &str, bytes: &[u8], home: &str, salt: &[u8]) {
        let shown = tilde(path, home);
        let parsed = match kind {
            "config" => std::str::from_utf8(bytes)
                .ok()
                .and_then(|text| toml::from_str::<toml::Value>(text).ok())
                .and_then(|value| serde_json::to_value(value).ok())
                .ok_or_else(|| format!("{shown} isn't TOML Arbor can read")),
            _ => serde_json::from_slice::<Value>(bytes).map_err(|_| format!("{shown} isn't JSON Arbor can read")),
        };
        let value = match parsed {
            Ok(value) => value,
            Err(problem) => {
                self.problems.push(problem);
                return;
            }
        };
        match kind {
            "settings" => self.claude_settings(&value, path, home, salt),
            "mcp" => {
                for (name, server) in value.as_object().into_iter().flatten() {
                    self.items.push(mcp_item(self.agent, name, server, home, salt));
                }
            }
            // Another harness's MCP file: its servers sit under the key the catalog gives, and the rest of the file
            // is dropped here.
            "harnessmcp" => {
                let key = self.harness.and_then(|harness| harness.spec().mcp).map(|mcp| mcp.key);
                for (name, server) in key.and_then(|key| value.get(key)).and_then(Value::as_object).into_iter().flatten() {
                    self.items.push(mcp_item(self.agent, name, server, home, salt));
                }
            }
            "plugins" => {
                for (id, installs) in value.get("plugins").and_then(Value::as_object).into_iter().flatten() {
                    let user = installs
                        .as_array()
                        .and_then(|installs| installs.iter().find(|install| install.get("scope").and_then(Value::as_str) == Some("user")));
                    if let Some(install) = user {
                        self.installed.insert(
                            id.clone(),
                            serde_json::json!({ "version": install.get("version"), "commit": install.get("gitCommitSha") }),
                        );
                        if let Some(at) = install.get("lastUpdated").or_else(|| install.get("installedAt")).and_then(Value::as_str).filter(|at| is_timestamp(at)) {
                            self.plugin_updated.insert(id.clone(), at.to_string());
                        }
                    }
                }
            }
            "marketplaces" => {
                for (name, marketplace) in value.as_object().into_iter().flatten() {
                    if let Some(source) = marketplace.get("source") {
                        self.marketplaces.insert(name.clone(), source.clone());
                        let fetched = marketplace.get("lastUpdated").and_then(Value::as_str).filter(|at| is_timestamp(at)).map(str::to_string);
                        self.marketplace_state.insert(name.clone(), (fetched, marketplace.get("autoUpdate").and_then(Value::as_bool)));
                    }
                }
            }
            "config" => self.codex_config(&value, home, salt),
            "hooks" => {
                if let Some(events) = value.get("hooks") {
                    self.hooks(events, home, salt);
                }
            }
            // A hooks file keyed by event at its top, as Droid's is.
            "eventhooks" => self.hooks(&value, home, salt),
            "skilllock" => {
                for (name, skill) in value.get("skills").and_then(Value::as_object).into_iter().flatten() {
                    if let Some(source) = skill.get("source").and_then(Value::as_str) {
                        self.sources.insert(name.clone(), source.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    fn setting(&mut self, name: String, value: &Value, shown: bool, home: &str, salt: &[u8]) {
        let mut item = SetupItem::new(ItemKind::Setting, name);
        item.sum = Some(fingerprint(value, home, salt));
        item.value = match value {
            Value::Bool(on) => Some(on.to_string()),
            Value::Number(number) => Some(number.to_string()),
            Value::String(text) if shown => Some(home_as_tilde(text, home)),
            _ => None,
        };
        item.count = match value {
            Value::Array(items) => Some(items.len() as u32),
            Value::Object(map) => Some(map.len() as u32),
            _ => None,
        };
        self.items.push(item);
    }

    fn claude_settings(&mut self, value: &Value, path: &str, home: &str, salt: &[u8]) {
        let Some(settings) = value.as_object() else {
            return;
        };
        for (key, value) in settings {
            match key.as_str() {
                "hooks" => self.hooks(value, home, salt),
                // Each skill's override shows on the skill, rather than the whole map as one setting.
                "skillOverrides" => match parse_overrides(value) {
                    Some(overrides) => self.overrides = Some((path.to_string(), overrides)),
                    None => self.ignored_overrides.push(path.to_string()),
                },
                // Still a setting on the page too; the names are kept apart for a project's MCP servers.
                "deniedMcpServers" => {
                    self.denied_mcp = denied_mcp_names(value);
                    self.setting(key.clone(), value, false, home, salt);
                }
                "env" => {
                    let Some(env) = value.as_object() else {
                        continue;
                    };
                    // Arbor's telemetry token and endpoint differ by machine by design, so they're one setting here.
                    let same = Value::String("arbor-telemetry".into());
                    for (name, value) in env {
                        let mut item = SetupItem::new(ItemKind::Env, name.clone());
                        let value = if super::telemetry::per_machine_telemetry(env, name) { &same } else { value };
                        item.sum = Some(fingerprint(value, home, salt));
                        self.items.push(item);
                    }
                }
                "enabledPlugins" => {
                    for (id, on) in value.as_object().into_iter().flatten() {
                        self.enabled.insert(id.clone(), on.as_bool().unwrap_or(false));
                    }
                }
                "extraKnownMarketplaces" => {
                    for (name, marketplace) in value.as_object().into_iter().flatten() {
                        if let Some(source) = marketplace.get("source") {
                            self.marketplaces.entry(name.clone()).or_insert_with(|| source.clone());
                        }
                        if let Some(auto) = marketplace.get("autoUpdate").and_then(Value::as_bool) {
                            self.marketplace_auto.insert(name.clone(), auto);
                        }
                    }
                }
                // Claude Code's own state rather than settings someone chose.
                "feedbackDrafts" | "$schema" => {}
                "permissions" if value.is_object() => {
                    for (part, value) in value.as_object().into_iter().flatten() {
                        let name = format!("permissions.{part}");
                        let shown = CLAUDE_SHOWN.contains(&name.as_str());
                        self.setting(name, value, shown, home, salt);
                    }
                }
                _ => self.setting(key.clone(), value, CLAUDE_SHOWN.contains(&key.as_str()), home, salt),
            }
        }
    }

    /// Hooks by event, from Claude Code's settings or Codex's hooks, leaving out Arbor's reporter.
    /// Hooks that run a script in ~/.agents/hooks are the setup repo's, so they're kept apart.
    fn hooks(&mut self, events: &Value, home: &str, salt: &[u8]) {
        for (event, groups) in events.as_object().into_iter().flatten() {
            let kept: Vec<Value> = groups
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|group| {
                    let Some(handlers) = group.get("hooks").and_then(Value::as_array) else {
                        return Some(group.clone());
                    };
                    let matcher = group.get("matcher").and_then(Value::as_str);
                    let handlers: Vec<Value> = handlers
                        .iter()
                        .filter(|handler| {
                            let command = handler.get("command").and_then(Value::as_str);
                            if command.is_some_and(|command| command.contains(REPORTER_MARK)) {
                                return false;
                            }
                            let Some(script) = command.and_then(|command| hook_script(command, home)) else {
                                return true;
                            };
                            self.repo_hooks.push(FoundHook { event: event.clone(), script: script.to_string(), sum: hook_sum_with(matcher, handler, home, salt) });
                            false
                        })
                        .cloned()
                        .collect();
                    if handlers.is_empty() {
                        return None;
                    }
                    let mut group = group.clone();
                    group["hooks"] = Value::Array(handlers);
                    Some(group)
                })
                .collect();
            if kept.is_empty() {
                continue;
            }
            let handlers = kept
                .iter()
                .map(|group| group.get("hooks").and_then(Value::as_array).map_or(1, Vec::len))
                .sum::<usize>();
            let mut item = SetupItem::new(ItemKind::Hook, event.clone());
            item.count = Some(handlers as u32);
            item.sum = Some(fingerprint(&Value::Array(kept), home, salt));
            self.items.push(item);
        }
    }

    fn codex_config(&mut self, value: &Value, home: &str, salt: &[u8]) {
        let Some(config) = value.as_object() else {
            return;
        };
        for (key, value) in config {
            match key.as_str() {
                "mcp_servers" => {
                    for (name, server) in value.as_object().into_iter().flatten() {
                        self.items.push(mcp_item(self.agent, name, server, home, salt));
                    }
                }
                "hooks" => self.hooks(value, home, salt),
                // Codex's plugins are its config's `[plugins."name@marketplace"]` tables, each on unless `enabled`
                // says otherwise; its cache has their files, so a listed plugin counts as installed.
                "plugins" => {
                    for (id, plugin) in value.as_object().into_iter().flatten() {
                        self.enabled.insert(id.clone(), plugin.get("enabled").and_then(Value::as_bool).unwrap_or(true));
                        self.installed.entry(id.clone()).or_insert_with(|| serde_json::json!({ "version": null }));
                    }
                }
                // `[marketplaces.name]` with `source_type` and `source`: a folder, or a repository to fetch.
                "marketplaces" => {
                    for (name, marketplace) in value.as_object().into_iter().flatten() {
                        let Some(source) = marketplace.get("source").and_then(Value::as_str) else { continue };
                        let local = marketplace.get("source_type").and_then(Value::as_str) == Some("local");
                        // Codex saves an `owner/repo` it was given as that repository's https URL, so both read as GitHub.
                        let named = source
                            .strip_prefix("https://github.com/")
                            .map(|rest| rest.trim_end_matches('/').trim_end_matches(".git"))
                            .filter(|rest| rest.split('/').count() == 2)
                            .unwrap_or(source);
                        let github = named.split('/').count() == 2 && !named.contains(':') && !named.starts_with('.') && !named.starts_with('~');
                        let place = match (local, github) {
                            (true, _) => serde_json::json!({ "path": source }),
                            (false, true) => serde_json::json!({ "repo": named }),
                            (false, false) => serde_json::json!({ "url": source }),
                        };
                        self.marketplaces.insert(name.clone(), place);
                    }
                }
                // Which folders are trusted differs by machine and isn't a setting to share.
                "projects" => {}
                "notify" => {
                    // Arbor's reporter runs any notify set before it after `--then`.
                    let words: Vec<Value> = value.as_array().cloned().unwrap_or_default();
                    let own = words
                        .first()
                        .and_then(Value::as_str)
                        .is_some_and(|first| first.contains(REPORTER_MARK));
                    let chained = if own {
                        match words.get(2).and_then(Value::as_str) {
                            Some("--then") => words[3..].to_vec(),
                            _ => Vec::new(),
                        }
                    } else {
                        words
                    };
                    if !chained.is_empty() {
                        self.setting("notify".into(), &Value::Array(chained), false, home, salt);
                    }
                }
                "model_providers" => {
                    for (name, provider) in value.as_object().into_iter().flatten() {
                        self.setting(format!("model_providers.{name}"), provider, false, home, salt);
                    }
                }
                "profiles" => self.setting(key.clone(), value, false, home, salt),
                _ => match value.as_object() {
                    Some(table) => {
                        for (part, value) in table {
                            self.setting(format!("{key}.{part}"), value, false, home, salt);
                        }
                    }
                    None => self.setting(key.clone(), value, CODEX_SHOWN.contains(&key.as_str()), home, salt),
                },
            }
        }
    }

    fn finish(mut self, home: &str, salt: &[u8]) -> SetupHome {
        let ids: BTreeSet<String> = self.installed.keys().chain(self.enabled.keys()).cloned().collect();
        for id in ids {
            let installed = self.installed.get(&id);
            let enabled = self.enabled.get(&id).copied();
            let mut item = SetupItem::new(ItemKind::Plugin, id.clone());
            item.value = installed.and_then(|install| install.get("version")).and_then(Value::as_str).map(str::to_string);
            item.note = self.plugin_updated.get(&id).cloned();
            item.enabled = enabled;
            item.sum = Some(fingerprint(
                &serde_json::json!({ "installed": installed, "enabled": enabled }),
                home,
                salt,
            ));
            self.items.push(item);
        }
        for (name, source) in &self.marketplaces {
            let mut item = SetupItem::new(ItemKind::Marketplace, name.clone());
            item.note = source
                .get("repo")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| source.get("url").and_then(Value::as_str).and_then(url_place))
                .or_else(|| source.get("path").and_then(Value::as_str).map(|path| home_as_tilde(path, home)));
            item.sum = Some(fingerprint(source, home, salt));
            // When it was last fetched, and whether Claude Code keeps it up to date where something
            // says so, apart from its fingerprint.
            let (fetched, auto) = self.marketplace_state.get(name).cloned().unwrap_or_default();
            item.value = fetched;
            item.enabled = self.marketplace_auto.get(name).copied().or(auto);
            self.items.push(item);
        }
        for item in &mut self.items {
            if let (ItemKind::Skill, Some(skill)) = (item.kind, item.skill.as_mut()) {
                skill.source = self.sources.get(&item.name).cloned();
            }
        }
        // Codex reads AGENTS.override.md in place of AGENTS.md.
        let overridden = self
            .items
            .iter()
            .any(|item| item.kind == ItemKind::Instructions && item.name == "AGENTS.override.md" && item.sum.is_some());
        for item in &mut self.items {
            if overridden && item.kind == ItemKind::Instructions && item.name == "AGENTS.md" {
                item.enabled = Some(false);
            }
        }
        self.items.sort_by(|a, b| (a.kind, &a.name).cmp(&(b.kind, &b.name)));
        let skill_overrides = self
            .overrides
            .map(|(file, overrides)| {
                let file = tilde(&file, home);
                overrides
                    .into_iter()
                    .map(|(name, state)| SkillOverride { name, state, source: OverrideSource::Settings, file: file.clone() })
                    .collect()
            })
            .unwrap_or_default();
        SetupHome {
            agent: self.agent,
            path: tilde(&self.path, home),
            items: self.items,
            problems: self.problems,
            skills_link: self.skills_link,
            skill_overrides,
            ignored_overrides: self.ignored_overrides.iter().map(|file| tilde(file, home)).collect(),
            denied_mcp: self.denied_mcp,
            shares: self.shares.map(|(shared, entries)| SharedHome { home: tilde(&shared, home), entries: entries.into_iter().collect() }),
            repo_hooks: self.repo_hooks,
        }
    }
}

/// An MCP server's definition the way its agent keeps it, so the same server compares the same
/// however it was written: nothing null, no empty `args`, `env` or headers, Claude Code's stdio
/// type on a server with a command and no type (and `http` for its `streamable-http`), and not
/// Codex's `enabled = true`, which it has anyway.
pub(super) fn normalized_mcp(agent: HomeAgent, server: &Value) -> Value {
    let Some(fields) = server.as_object() else {
        return server.clone();
    };
    let mut kept = serde_json::Map::new();
    for (key, value) in fields {
        let empty = match value {
            Value::Null => true,
            Value::Object(entries) => entries.is_empty() && matches!(key.as_str(), "env" | "environment" | "headers" | "http_headers" | "env_http_headers"),
            Value::Array(items) => items.is_empty() && matches!(key.as_str(), "args" | "env_vars"),
            _ => false,
        };
        if !empty {
            kept.insert(key.clone(), value.clone());
        }
    }
    match agent {
        HomeAgent::Claude => match kept.get("type").and_then(Value::as_str) {
            None if kept.contains_key("command") => {
                kept.insert("type".into(), "stdio".into());
            }
            Some("streamable-http") => {
                kept.insert("type".into(), "http".into());
            }
            _ => {}
        },
        HomeAgent::Codex => {
            if kept.get("enabled") == Some(&Value::Bool(true)) {
                kept.remove("enabled");
            }
        }
        HomeAgent::Shared => {}
    }
    Value::Object(kept)
}

/// The fingerprint a scan gives an MCP server that `server` defines, in a home of `agent` on a
/// machine whose home folder is `home`.
pub(super) fn mcp_sum(agent: HomeAgent, server: &Value, home: &str) -> String {
    fingerprint(&normalized_mcp(agent, server), home, salt())
}

/// Programs a repo hook may run its script with, rather than running the script itself.
pub(super) const HOOK_RUNNERS: [&str; 6] = ["sh", "bash", "zsh", "node", "python3", "bun"];

/// The file name of the script in ~/.agents/hooks that a hook's command runs, when it runs one:
/// the command starts with the script's path, or with one of `HOOK_RUNNERS` and then it. `home`
/// is the machine's home folder, which the path can start with instead of ~ or $HOME.
pub(super) fn hook_script<'a>(command: &'a str, home: &str) -> Option<&'a str> {
    let mut command = command.trim_start();
    if let Some((first, rest)) = command.split_once(' ') {
        if HOOK_RUNNERS.contains(&first) {
            command = rest.trim_start();
        }
    }
    let path = command.split_whitespace().next()?;
    let folder = format!("{home}/.agents/hooks/");
    let script = ["~/.agents/hooks/", "$HOME/.agents/hooks/", "${HOME}/.agents/hooks/", folder.as_str()]
        .iter()
        .find_map(|prefix| path.strip_prefix(prefix))?;
    is_script_name(script).then_some(script)
}

/// A script's file name as the repo keeps them: letters, digits, `.`, `-` and `_`, not starting with a dot.
pub(super) fn is_script_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('.')
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn hook_sum_with(matcher: Option<&str>, handler: &Value, home: &str, salt: &[u8]) -> String {
    fingerprint(&serde_json::json!({ "matcher": matcher, "handler": handler }), home, salt)
}

/// The fingerprint a scan gives a hook with this matcher and handler, on a machine whose home
/// folder is `home`.
pub(super) fn hook_sum(matcher: Option<&str>, handler: &Value, home: &str) -> String {
    hook_sum_with(matcher, handler, home, salt())
}

/// An MCP server: its name, how it's reached, and a fingerprint of the rest. Its command line,
/// headers and environment can hold secrets, so they're never shown.
fn mcp_item(agent: HomeAgent, name: &str, server: &Value, home: &str, salt: &[u8]) -> SetupItem {
    let url = server.get("url").and_then(Value::as_str);
    // OpenCode gives the command and its arguments as one list.
    let command = server
        .get("command")
        .and_then(|command| command.as_str().or_else(|| command.as_array()?.first()?.as_str()));
    let mut item = SetupItem::new(ItemKind::Mcp, name);
    item.value = server
        .get("type")
        .and_then(Value::as_str)
        // OpenCode's words for the two.
        .map(|kind| match kind {
            "local" => "stdio",
            "remote" => "http",
            other => other,
        })
        .map(str::to_string)
        .or_else(|| url.map(|_| "http".to_string()))
        .or_else(|| command.map(|_| "stdio".to_string()));
    item.note = url
        .and_then(url_host)
        .or_else(|| command.map(|command| file_name(command.split_whitespace().next().unwrap_or(command)).to_string()));
    if server.get("enabled").and_then(Value::as_bool) == Some(false) || server.get("disabled").and_then(Value::as_bool) == Some(true) {
        item.enabled = Some(false);
    }
    item.sum = Some(fingerprint(&normalized_mcp(agent, server), home, salt));
    item
}

impl Scan {
    fn finish_home(&mut self, parts: HomeParts, harness: Option<Harness>, home: &str, salt: &[u8]) {
        let done = parts.finish(home, salt);
        match harness {
            Some(harness) => self.harness_homes.push(HarnessHome {
                harness,
                path: done.path,
                items: done.items,
                skills_link: done.skills_link,
                problems: done.problems,
            }),
            None => self.homes.push(done),
        }
    }
}

fn parse_scan(stdout: &str, salt: &[u8]) -> Result<Scan, String> {
    let mut scan = Scan::default();
    let mut current: Option<HomeParts> = None;
    // The harness the home being read belongs to, when it isn't Claude Code's or Codex's.
    let mut harness: Option<Harness> = None;
    let mut policy_overrides = None;
    let mut policy_denied: Vec<String> = Vec::new();
    // Which Codex homes there are, as the machine has them, so a shadow home's links can be told apart from others.
    let codex_homes: BTreeSet<String> = stdout
        .lines()
        .filter_map(|line| line.strip_prefix("A\tcodex\t"))
        .map(str::to_string)
        .collect();
    let mut lines = stdout.lines();
    while let Some(line) = lines.next() {
        let fields: Vec<&str> = line.split('\t').collect();
        let home = scan.home_dir.clone();
        match fields.as_slice() {
            ["H", dir] => scan.home_dir = dir.to_string(),
            ["A", agent, path] => {
                if let Some(done) = current.take() {
                    scan.finish_home(done, harness.take(), &home, salt);
                }
                let agent = match *agent {
                    "claude" => HomeAgent::Claude,
                    "codex" => HomeAgent::Codex,
                    "shared" => HomeAgent::Shared,
                    other => match AgentHomeKind::parse(other).filter(|kind| kind.syncs() && !kind.has_settings()) {
                        // Its instructions, skills and hooks come as a home of any agent's do; its MCP file is read
                        // by its harness.
                        Some(kind) => {
                            harness = Some(kind.harness());
                            HomeAgent::Shared
                        }
                        None => continue,
                    },
                };
                let mut parts = HomeParts::new(agent, path);
                parts.harness = harness;
                current = Some(parts);
            }
            ["K", entry, link] => {
                if let Some(parts) = current.as_mut().filter(|parts| parts.agent == HomeAgent::Codex) {
                    parts.link(entry, link, &codex_homes);
                }
            }
            ["F", kind, path, sum, size, link] => {
                if let Some(parts) = current.as_mut().filter(|parts| !parts.is_shared(path)) {
                    parts.file(kind, path, sum, size, link, &home);
                }
            }
            ["S", path, sum, files, link, doc, name, chars, when, manual] => {
                if let Some(parts) = current.as_mut().filter(|parts| !parts.is_shared(path)) {
                    parts.skill(path, sum, files, link, doc, [name, chars, when, manual], &home);
                }
            }
            ["SL", path, link] => {
                if let (Some(parts), false) = (current.as_mut(), link.is_empty()) {
                    parts.skills_link = Some(tilde(&link_target(path, link), &home));
                }
            }
            ["I", level, from, written, path, sum] => {
                if let Some(parts) = current.as_mut() {
                    parts.import(level, from, written, path, sum, &home);
                }
            }
            ["B", agent, path, real, version] => {
                let (path, real) = (tilde(path, &home), tilde(real, &home));
                let (real, version) = ((real != path).then_some(real), parse_version(version));
                match *agent {
                    "claude" => scan.installs.push(SetupInstall { agent: AgentKind::Claude, path, real, version }),
                    "codex" => scan.installs.push(SetupInstall { agent: AgentKind::Codex, path, real, version }),
                    other => match Harness::ALL.into_iter().find(|harness| harness.spec().binary == other) {
                        Some(harness) => {
                            let update_command = super::harness_update::update_command(harness);
                            scan.harness_installs.push(HarnessInstall { harness, path, real, version, update_command });
                        }
                        None => continue,
                    },
                }
            }
            ["J", kind, path, size] => {
                let mut encoded = String::new();
                for line in lines.by_ref() {
                    if line == "." {
                        break;
                    }
                    encoded.push_str(line.trim());
                }
                if *kind == "managed" {
                    let (policy, overrides, denied) = read_policy(path, size, &encoded);
                    scan.policy = Some(policy);
                    policy_overrides = overrides;
                    policy_denied = denied;
                    continue;
                }
                let Some(parts) = current.as_mut().filter(|parts| !parts.is_shared(path)) else {
                    continue;
                };
                let shown = tilde(path, &home);
                if *size == "large" {
                    parts.problems.push(format!("{shown} is over 1 MB, so Arbor didn't read it"));
                    continue;
                }
                match STANDARD.decode(encoded.as_bytes()) {
                    Ok(bytes) if size.parse::<usize>().ok() == Some(bytes.len()) => parts.data(kind, path, &bytes, &home, salt),
                    _ => parts.problems.push(format!("{shown} came back incomplete")),
                }
            }
            _ => {}
        }
    }
    if let Some(done) = current.take() {
        let home = scan.home_dir.clone();
        scan.finish_home(done, harness, &home, salt);
    }
    if scan.home_dir.is_empty() {
        return Err("The machine didn't say where its home is".into());
    }
    // The policy's overrides outrank each home's own, skill by skill, in every Claude Code home.
    if let (Some(policy), Some(overrides)) = (&scan.policy, &policy_overrides) {
        for home in scan.homes.iter_mut().filter(|home| home.agent == HomeAgent::Claude) {
            home.skill_overrides.retain(|entry| !overrides.contains_key(&entry.name));
            home.skill_overrides.extend(overrides.iter().map(|(name, state)| SkillOverride {
                name: name.clone(),
                state: *state,
                source: OverrideSource::Policy,
                file: policy.file.clone(),
            }));
            home.skill_overrides.sort_by(|a, b| a.name.cmp(&b.name));
        }
    }
    // The policy's denied servers are denied in every Claude Code home, as Claude Code merges denylists from every scope.
    for home in scan.homes.iter_mut().filter(|home| home.agent == HomeAgent::Claude) {
        for name in &policy_denied {
            if !home.denied_mcp.contains(name) {
                home.denied_mcp.push(name.clone());
            }
        }
    }
    Ok(scan)
}

/// The scan of `machine`'s homes, with `policy` setting where the managed-settings policy is looked for and ending
/// with `installs`, the line that lists the agents' installs.
fn scan_script_with(machine: &str, policy: &str, installs: &str) -> String {
    let homes = agent_homes::shell_function(machine, HomeUse::Files);
    let harness_homes = harnesses::files_script();
    let agents = harnesses::installs_script();
    format!("set -u\nexport LC_ALL=C\n{homes}{HELPERS}{EMIT_FUNCTIONS}{harness_homes}{policy}{SCAN_SCRIPT}{agents}{INSTALLS_SCRIPT}{installs}")
}

/// Installs are looked for along the PATH the agents check uses, which puts the
/// installers' directories first the way a login shell would. It's set in a
/// subshell, so the rest of the scan runs with the machine's own.
fn scan_script(machine: &str) -> String {
    scan_script_with(machine, POLICY_FILE, &format!("(\n{AGENT_ENV}emit_installs \"$PATH\"\n)\n"))
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

/// Which machine a scan is for: one on the Machines page, or this one when it isn't there.
#[derive(Clone, Debug, PartialEq)]
enum Target {
    Series(String),
    ThisMachine,
}

fn stale(setup: &MachineSetup, now_ms: i64) -> bool {
    setup.scanned_at.is_none_or(|at| now_ms - at >= FRESH_MS)
}

/// The machines to scan now, marked as being scanned: `machine`, or every one Setup covers.
/// `stale_only` leaves out machines scanned lately and ones that aren't answering.
fn take_targets(state: &MachineHealthState, machine: Option<&str>, stale_only: bool, now_ms: i64) -> Vec<(Target, Machine)> {
    let mut inner = state.lock();
    let mut targets: Vec<(Target, Machine)> = inner
        .series
        .values_mut()
        .filter(|series| runs_scripts(series) && machine.is_none_or(|name| series.host.machine == name))
        .filter(|series| !series.setup.scanning)
        .filter(|series| {
            !stale_only || (series.error.is_none() && series.last_ok_at.is_some() && stale(&series.setup, now_ms))
        })
        .map(|series| {
            series.setup.scanning = true;
            (Target::Series(series.host.machine.clone()), Machine::listed(series))
        })
        .collect();
    if let Some(name) = this_machine_name(&inner) {
        let setup = &mut inner.local_setup;
        if machine.is_none_or(|wanted| wanted == name) && !setup.scanning && (!stale_only || stale(setup, now_ms)) {
            setup.scanning = true;
            targets.push((Target::ThisMachine, Machine::this_mac(&name)));
        }
    }
    targets
}

#[derive(Debug, Default, PartialEq)]
struct Recorded {
    /// What changed since the last good scan, when Arbor didn't change it.
    changes: Vec<SetupChange>,
    /// Arbor changed something after the scan started, so scan again.
    again: bool,
    /// The scan found a harness the last one didn't, or missed one it found, so the lists that show only the
    /// harnesses some machine has may change.
    harnesses_changed: bool,
}

/// Stores a scan's result, unless the machine has since been pointed somewhere else, and says what
/// changed since the last good scan this run.
fn record(state: &MachineHealthState, target: &Target, host: &MachineHost, started_ms: i64, at_ms: i64, result: Result<Scan, String>) -> Recorded {
    let mut inner = state.lock();
    let setup = match target {
        Target::Series(machine) => match inner.series.get_mut(machine) {
            Some(series) if series.host.endpoint == host.endpoint && series.host.port == host.port => &mut series.setup,
            _ => return Recorded::default(),
        },
        Target::ThisMachine => &mut inner.local_setup,
    };
    record_scan(setup, started_ms, at_ms, result)
}

fn record_scan(setup: &mut MachineSetup, started_ms: i64, at_ms: i64, result: Result<Scan, String>) -> Recorded {
    let mut recorded = Recorded::default();
    setup.scanning = false;
    setup.scanned_at = Some(at_ms);
    match result {
        Ok(scan) => {
            let before = setup.harnesses();
            match setup.arbor_wrote_ms {
                // The first good scan has nothing to compare with.
                None if !setup.home_dir.is_empty() => {
                    recorded.changes = watched_changes(
                        &watched_homes(&setup.homes, &setup.harness_homes),
                        &watched_homes(&scan.homes, &scan.harness_homes),
                    )
                }
                None => {}
                Some(wrote_ms) if wrote_ms < started_ms => setup.arbor_wrote_ms = None,
                Some(_) => recorded.again = true,
            }
            setup.homes = scan.homes;
            setup.harness_homes = scan.harness_homes;
            setup.installs = scan.installs;
            setup.harness_installs = scan.harness_installs;
            setup.policy = scan.policy;
            setup.home_dir = scan.home_dir;
            setup.error = None;
            recorded.harnesses_changed = setup.harnesses() != before;
        }
        Err(error) => setup.error = Some(error),
    }
    recorded
}

// ---------------------------------------------------------------------------
// Kept across restarts
// ---------------------------------------------------------------------------

/// Each machine's last setup scan, in Arbor's data folder.
const SAVED_SCANS_FILE: &str = "setup-scans.json";
/// Raised when the saved form changes, so an older file is dropped rather than misread.
const SAVED_SCANS_VERSION: u32 = 1;
static SAVING: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Deserialize, PartialEq, Serialize)]
struct SavedScans {
    version: u32,
    /// The salt these scans' fingerprints were made with, which Arbor goes on using after a restart so they still
    /// compare with fresh ones.
    salt: String,
    machines: Vec<SavedSetup>,
}

/// One machine's last scan, with what the window is never sent: its home folder, and the hooks that run the repo's
/// scripts, by fingerprint.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(super) struct SavedSetup {
    machine: String,
    /// How the machine was reached, so one pointed somewhere else since doesn't get another machine's scan; None for
    /// this Mac when the Machines page doesn't list it.
    endpoint: Option<(String, u16)>,
    setup: MachineSetup,
    home_dir: String,
    repo_hooks: Vec<(String, Vec<FoundHook>)>,
    harness_problems: Vec<(String, Vec<String>)>,
}

impl SavedSetup {
    fn of(machine: &str, endpoint: Option<(String, u16)>, setup: &MachineSetup) -> Self {
        Self {
            machine: machine.to_string(),
            endpoint,
            setup: MachineSetup { scanning: false, arbor_wrote_ms: None, ..setup.clone() },
            home_dir: setup.home_dir.clone(),
            repo_hooks: setup.homes.iter().filter(|home| !home.repo_hooks.is_empty()).map(|home| (home.path.clone(), home.repo_hooks.clone())).collect(),
            harness_problems: setup.harness_homes.iter().filter(|home| !home.problems.is_empty()).map(|home| (home.path.clone(), home.problems.clone())).collect(),
        }
    }

    /// The scan as it was, with what the saved form keeps apart put back.
    fn into_setup(self) -> MachineSetup {
        let mut setup = self.setup;
        setup.home_dir = self.home_dir;
        for (path, hooks) in self.repo_hooks {
            if let Some(home) = setup.homes.iter_mut().find(|home| home.path == path) {
                home.repo_hooks = hooks;
            }
        }
        for (path, problems) in self.harness_problems {
            if let Some(home) = setup.harness_homes.iter_mut().find(|home| home.path == path) {
                home.problems = problems;
            }
        }
        setup
    }
}

/// Every scanned machine's last scan, and the kept ones no listed machine has taken up yet, so they aren't lost
/// meanwhile.
fn saved_setups(inner: &Inner) -> Vec<SavedSetup> {
    let mut saved: Vec<SavedSetup> = inner
        .series
        .values()
        .filter(|series| series.setup.scanned_at.is_some())
        .map(|series| SavedSetup::of(&series.host.machine, Some((series.host.endpoint.clone(), series.host.port)), &series.setup))
        .collect();
    if inner.local_setup.scanned_at.is_some() {
        saved.push(SavedSetup::of(&this_machine_name(inner).unwrap_or_default(), None, &inner.local_setup));
    }
    for kept in &inner.restored_setups {
        if !saved.iter().any(|entry| entry.machine == kept.machine && entry.endpoint.is_some() == kept.endpoint.is_some()) {
            saved.push(kept.clone());
        }
    }
    saved
}

fn write_saved_scans(path: &Path, machines: Vec<SavedSetup>, salt: &[u8]) -> Result<(), String> {
    let text = serde_json::to_vec(&SavedScans { version: SAVED_SCANS_VERSION, salt: hex(salt), machines }).map_err(|error| error.to_string())?;
    super::archive::store::write_atomic(path, &text)
}

/// The scans kept at `path` and their salt, or none when there's no file, or it's from another version or unreadable.
fn read_saved_scans(path: &Path) -> Option<([u8; 16], Vec<SavedSetup>)> {
    let saved = serde_json::from_slice::<SavedScans>(&fs::read(path).ok()?).ok().filter(|saved| saved.version == SAVED_SCANS_VERSION)?;
    let bytes = (0..saved.salt.len())
        .step_by(2)
        .map(|at| saved.salt.get(at..at + 2).and_then(|pair| u8::from_str_radix(pair, 16).ok()))
        .collect::<Option<Vec<u8>>>()?;
    Some((bytes.try_into().ok()?, saved.machines))
}

/// Keeps what's in memory now, after a scan has landed: one save at a time, each taking what's there then.
fn save_scans(app: &tauri::AppHandle) {
    let saving = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _saving = SAVING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let machines = saved_setups(&saving.state::<MachineHealthState>().lock());
        if let Err(error) = crate::core_base_dir().and_then(|dir| write_saved_scans(&dir.join(SAVED_SCANS_FILE), machines, salt())) {
            eprintln!("Couldn't keep the setup scans: {error}");
        }
    });
}

/// Puts back each machine's last setup scan from before Arbor started, so Sync, change alerts and the harnesses found
/// carry on from it rather than from nothing. It runs before the first scan, so the kept salt is the one every scan
/// uses; were a fingerprint made already, the kept scans wouldn't compare and are left out.
pub(crate) fn restore_saved_scans(app: &tauri::AppHandle) {
    let Ok(dir) = crate::core_base_dir() else { return };
    let Some((kept_salt, machines)) = read_saved_scans(&dir.join(SAVED_SCANS_FILE)) else { return };
    if SALT.set(kept_salt).is_err() && salt() != kept_salt.as_slice() {
        return;
    }
    {
        let state = app.state::<MachineHealthState>();
        let mut inner = state.lock();
        for saved in machines {
            restore_into(&mut inner, saved);
        }
    }
    let _ = app.emit(SETUP_INVENTORY_UPDATED_EVENT, Local::now().timestamp_millis());
    let _ = app.emit(agent_homes::AGENT_HOMES_UPDATED_EVENT, ());
}

/// Lays a kept scan where it belongs, this Mac's or a listed machine's reached the same way, unless a scan has
/// finished there since. One for a machine not listed yet waits until it is (`take_restored`).
fn restore_into(inner: &mut Inner, saved: SavedSetup) {
    let target = match &saved.endpoint {
        None => Some(&mut inner.local_setup),
        Some((endpoint, port)) => match inner.series.get_mut(&saved.machine) {
            Some(series) if series.host.endpoint == *endpoint && series.host.port == *port => Some(&mut series.setup),
            Some(_) => return,
            None => None,
        },
    };
    match target {
        Some(setup) if setup.scanned_at.is_none() => {
            let scanning = setup.scanning;
            *setup = MachineSetup { scanning, ..saved.into_setup() };
        }
        Some(_) => {}
        None => inner.restored_setups.push(saved),
    }
}

/// The kept scan of a machine the Machines page has just listed, when it's reached the way it was then.
pub(super) fn take_restored(restored: &mut Vec<SavedSetup>, host: &MachineHost) -> Option<MachineSetup> {
    let at = restored
        .iter()
        .position(|saved| saved.machine == host.machine && saved.endpoint.as_ref().is_some_and(|(endpoint, port)| *endpoint == host.endpoint && *port == host.port))?;
    Some(restored.remove(at).into_setup())
}

async fn scan(machine: &Machine) -> Result<Scan, String> {
    parse_scan(&run_checked(machine, MachineOp::SetupScan, &scan_script(machine.name()), SCAN_TIMEOUT).await?, salt())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupMachine {
    machine: String,
    local: bool,
    /// Answering its health samples. Always true for this machine.
    reachable: bool,
    #[serde(flatten)]
    setup: MachineSetup,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupInventory {
    machines: Vec<SetupMachine>,
}

fn inventory(inner: &Inner) -> SetupInventory {
    let mut machines: Vec<SetupMachine> = inner
        .series
        .values()
        .filter(|series| runs_scripts(series))
        .map(|series| SetupMachine {
            machine: series.host.machine.clone(),
            local: series.local,
            reachable: series.error.is_none() && series.last_ok_at.is_some(),
            setup: series.setup.clone(),
        })
        .collect();
    if let Some(name) = this_machine_name(inner) {
        machines.push(SetupMachine { machine: name, local: true, reachable: true, setup: inner.local_setup.clone() });
    }
    SetupInventory { machines }
}

/// Each machine Sync covers, as the inventory lists them: its name, whether it's answering, and its last scan.
pub(super) fn covered_machines(inner: &Inner) -> Vec<(String, bool, MachineSetup)> {
    inventory(inner).machines.into_iter().map(|entry| (entry.machine, entry.reachable, entry.setup)).collect()
}

/// What each machine's agents load, as the last scans found it.
#[tauri::command]
pub(crate) async fn get_setup_inventory(state: tauri::State<'_, MachineHealthState>) -> Result<SetupInventory, String> {
    Ok(inventory(&state.lock()))
}

/// Scans `machine`, or every machine, in the background; the page hears as each one starts and
/// finishes. `stale_only` scans only the machines that are answering and weren't scanned lately.
#[tauri::command]
pub(crate) async fn scan_setup(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: Option<String>,
    stale_only: Option<bool>,
) -> Result<(), String> {
    let now_ms = Local::now().timestamp_millis();
    let stale_only = stale_only == Some(true);
    let targets = take_targets(&state, machine.as_deref(), stale_only, now_ms);
    // Only the background rounds (stale only) spread machines over the interval; a Scan someone asked for runs now,
    // as many at once as the SSH cap in `shell` lets through.
    start_scans(&app, targets, now_ms, stale_only);
    Ok(())
}

/// Scans `machine` again in the background, after Arbor has changed something on it: what that
/// scan finds is Arbor's doing, so it isn't reported as a change.
pub(super) fn rescan(app: &tauri::AppHandle, machine: &str) {
    let now_ms = Local::now().timestamp_millis();
    let state = app.state::<MachineHealthState>();
    {
        let mut inner = state.lock();
        if let Some(setup) = setup_mut(&mut inner, machine) {
            setup.arbor_wrote_ms = Some(now_ms);
        }
    }
    let targets = take_targets(&state, Some(machine), false, now_ms);
    start_scans(app, targets, now_ms, false);
}

/// A machine's setup, found as `covered_machine` finds it.
fn setup_mut<'a>(inner: &'a mut Inner, machine: &str) -> Option<&'a mut MachineSetup> {
    if inner.series.get(machine).is_some_and(runs_scripts) {
        return inner.series.get_mut(machine).map(|series| &mut series.setup);
    }
    (this_machine_name(inner).as_deref() == Some(machine)).then_some(&mut inner.local_setup)
}

fn start_scans(app: &tauri::AppHandle, targets: Vec<(Target, Machine)>, now_ms: i64, stagger: bool) {
    if targets.is_empty() {
        return;
    }
    let _ = app.emit(SETUP_INVENTORY_UPDATED_EVENT, now_ms);
    let count = targets.len();
    for (index, (target, machine)) in targets.into_iter().enumerate() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let delay = if stagger { super::scan_wave_delay(index, count, Duration::from_millis(FRESH_MS as u64)) } else { Duration::ZERO };
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            let result = scan(&machine).await;
            if let Err(error) = &result {
                eprintln!("Could not read the setup on {}: {error}", machine.name());
            }
            let at_ms = Local::now().timestamp_millis();
            let recorded = record(&app.state::<MachineHealthState>(), &target, machine.host(), now_ms, at_ms, result);
            save_scans(&app);
            let _ = app.emit(SETUP_INVENTORY_UPDATED_EVENT, at_ms);
            if recorded.harnesses_changed {
                let _ = app.emit(agent_homes::AGENT_HOMES_UPDATED_EVENT, ());
            }
            if !recorded.changes.is_empty() {
                let _ = app.emit(SETUP_CHANGED_EVENT, SetupChanged { machine: machine.name().to_string(), changes: recorded.changes });
            }
            // Arbor changed something while this scan ran, so it may have missed that.
            if recorded.again {
                let now_ms = Local::now().timestamp_millis();
                let targets = take_targets(&app.state::<MachineHealthState>(), Some(machine.name()), false, now_ms);
                start_scans(&app, targets, now_ms, false);
            }
        });
    }
}

/// A machine Setup covers: how to reach it, whether it's this one, and what its last scan found.
pub(super) fn covered_machine<'a>(inner: &'a Inner, machine: &str) -> Result<(Machine, &'a MachineSetup), String> {
    let target = find_machine(inner, machine)?;
    let setup = match inner.series.get(machine) {
        Some(series) if target.is_listed() => &series.setup,
        _ => &inner.local_setup,
    };
    Ok((target, setup))
}

/// An ISO 8601 time as Claude Code writes one, with nothing else in it.
fn is_timestamp(value: &str) -> bool {
    value.len() <= 40 && value.as_bytes().first().is_some_and(u8::is_ascii_digit) && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-:.+".contains(&byte))
}

/// The plugins or marketplaces a machine's last scan found in the home at `path`: each one's
/// name, its version (a plugin's) and whether it's on.
pub(super) fn home_extensions(setup: &MachineSetup, path: &str, kind: ItemKind) -> Vec<(String, Option<String>, Option<bool>)> {
    setup
        .homes
        .iter()
        .filter(|home| home.path == path)
        .flat_map(|home| &home.items)
        .filter(|item| item.kind == kind)
        .map(|item| (item.name.clone(), if kind == ItemKind::Plugin { item.value.clone() } else { None }, item.enabled))
        .collect()
}

/// Each machine Setup covers whose setup has been read, with what its last scan found.
pub(super) fn scanned_machines(inner: &Inner) -> Vec<(String, MachineSetup)> {
    let mut machines: Vec<(String, MachineSetup)> = inner
        .series
        .values()
        .filter(|series| runs_scripts(series) && series.setup.scanned_at.is_some())
        .map(|series| (series.host.machine.clone(), series.setup.clone()))
        .collect();
    if let Some(name) = this_machine_name(inner).filter(|_| inner.local_setup.scanned_at.is_some()) {
        machines.push((name, inner.local_setup.clone()));
    }
    machines
}

/// Each harness the last setup scans found, with the machines it's on, by name. A machine not scanned yet since Arbor
/// started has none, so until the first scans land only Claude Code and Codex count as found (`harnesses::is_found`).
pub(super) fn harnesses_found(inner: &Inner) -> harnesses::FoundOn {
    let series = inner.series.values().filter(|series| runs_scripts(series)).map(|series| (series.host.machine.clone(), &series.setup));
    let local = this_machine_name(inner).map(|name| (name, &inner.local_setup));
    let mut found = harnesses::FoundOn::new();
    for (machine, setup) in series.chain(local) {
        for harness in setup.harnesses() {
            found.entry(harness).or_default().push(machine.clone());
        }
    }
    for machines in found.values_mut() {
        machines.sort();
        machines.dedup();
    }
    found
}

impl MachineSetup {
    /// The machine's home folder.
    pub(super) fn home_dir(&self) -> &str {
        &self.home_dir
    }

    /// Its Claude Code and Codex homes, as the scan names them.
    pub(super) fn agent_homes(&self) -> Vec<(HomeAgent, &str)> {
        self.homes
            .iter()
            .filter(|home| home.agent != HomeAgent::Shared)
            .map(|home| (home.agent, home.path.as_str()))
            .collect()
    }

    /// The harnesses its last scan found: a home of theirs that's there, or their command on the PATH.
    pub(super) fn harnesses(&self) -> BTreeSet<Harness> {
        let homes = self.homes.iter().filter_map(|home| match home.agent {
            HomeAgent::Claude => Some(Harness::Claude),
            HomeAgent::Codex => Some(Harness::Codex),
            HomeAgent::Shared => None,
        });
        let installs = self.installs.iter().map(|install| match install.agent {
            AgentKind::Claude => Harness::Claude,
            AgentKind::Codex => Harness::Codex,
        });
        homes
            .chain(installs)
            .chain(self.harness_homes.iter().map(|home| home.harness))
            .chain(self.harness_installs.iter().map(|install| install.harness))
            .collect()
    }

    /// Whether the home at `path` shares `entry` with another Codex home, as T3 Code's shadow homes
    /// do: a change to it is a change to that home's.
    pub(super) fn shares(&self, path: &str, entry: &str) -> bool {
        self.homes
            .iter()
            .any(|home| home.path == path && home.shares.as_ref().is_some_and(|shared| shared.entries.iter().any(|name| name == entry)))
    }

    /// Whether the machine's managed-settings policy sets this, as the last scan read it.
    pub(super) fn policy_sets(&self, kind: ItemKind, name: &str) -> bool {
        self.policy.as_ref().is_some_and(|policy| policy.keys.iter().any(|key| key.kind == kind && key.name == name))
    }

    /// Refuses a change to things the machine's managed-settings policy sets: Claude Code goes by
    /// the policy whatever a home's settings say, and Setup never writes what the policy decides.
    pub(super) fn leave_to_policy(&self, machine: &str, kind: ItemKind, names: &[&str]) -> Result<(), String> {
        let set: Vec<&str> = names.iter().copied().filter(|name| self.policy_sets(kind, name)).collect();
        if set.is_empty() {
            return Ok(());
        }
        Err(format!("The managed settings policy on {machine} sets {}, so Arbor leaves it as the policy has it", set.join(", ")))
    }

    /// The MCP servers in the home at `path`, each with its fingerprint.
    /// Whether the home at `path`'s settings, or the machine's policy, deny MCP server `name`.
    pub(super) fn home_denies(&self, path: &str, name: &str) -> bool {
        self.homes.iter().filter(|home| home.path == path).any(|home| home.denied_mcp.iter().any(|entry| entry == name))
    }

    /// Whether the machine's ~/.agents/hooks has `script`, as the last scan found it.
    pub(super) fn has_hook_script(&self, script: &str) -> bool {
        let path = format!("~/.agents/hooks/{script}");
        self.homes.iter().flat_map(|home| &home.items).any(|item| item.kind == ItemKind::Hook && item.path.as_deref() == Some(path.as_str()) && item.sum.is_some())
    }

    /// The hooks in the home at `path` that run a script in ~/.agents/hooks.
    pub(super) fn home_hooks(&self, path: &str) -> Vec<&FoundHook> {
        self.homes.iter().filter(|home| home.path == path).flat_map(|home| &home.repo_hooks).collect()
    }

    pub(super) fn home_servers(&self, path: &str) -> BTreeMap<&str, Option<&str>> {
        self.homes
            .iter()
            .filter(|home| home.path == path)
            .flat_map(|home| &home.items)
            .filter(|item| item.kind == ItemKind::Mcp)
            .map(|item| (item.name.as_str(), item.sum.as_deref()))
            .collect()
    }

    /// The other harnesses' homes, each with its MCP servers' fingerprints by name.
    pub(super) fn harness_servers(&self) -> Vec<(Harness, &str, BTreeMap<&str, Option<&str>>)> {
        self.harness_homes
            .iter()
            .map(|home| {
                let servers = home.items.iter().filter(|item| item.kind == ItemKind::Mcp).map(|item| (item.name.as_str(), item.sum.as_deref())).collect();
                (home.harness, home.path.as_str(), servers)
            })
            .collect()
    }
}

/// Whose home `path` is, as a machine's last scan names it.
pub(super) fn home_agent(setup: &MachineSetup, path: &str) -> Option<HomeAgent> {
    setup.homes.iter().find(|home| home.path == path).map(|home| home.agent)
}

/// Where the skills folder of the home at `path` leads, when the last scan found it's a link.
pub(super) fn skills_link<'a>(setup: &'a MachineSetup, path: &str) -> Option<&'a str> {
    match setup.homes.iter().find(|home| home.path == path) {
        Some(home) => home.skills_link.as_deref(),
        None => setup.harness_homes.iter().find(|home| home.path == path).and_then(|home| home.skills_link.as_deref()),
    }
}

/// The harness whose home is at `path`, for a home that isn't Claude Code's or Codex's.
pub(super) fn home_harness(setup: &MachineSetup, path: &str) -> Option<Harness> {
    setup.harness_homes.iter().find(|home| home.path == path).map(|home| home.harness)
}

/// What Sync's standing (`setup_standing`) reads of a scan, and nothing more.
impl MachineSetup {
    /// Read at least once: a scan has landed, or one was kept from before Arbor started.
    pub(super) fn is_read(&self) -> bool {
        self.scanned_at.is_some() || !self.homes.is_empty()
    }

    pub(super) fn homes(&self) -> &[SetupHome] {
        &self.homes
    }

    pub(super) fn harness_homes(&self) -> &[HarnessHome] {
        &self.harness_homes
    }
}

impl SetupHome {
    pub(super) fn agent(&self) -> HomeAgent {
        self.agent
    }

    pub(super) fn path(&self) -> &str {
        &self.path
    }

    pub(super) fn items(&self) -> &[SetupItem] {
        &self.items
    }
}

impl HarnessHome {
    pub(super) fn path(&self) -> &str {
        &self.path
    }

    pub(super) fn items(&self) -> &[SetupItem] {
        &self.items
    }
}

impl SetupItem {
    pub(super) fn kind(&self) -> ItemKind {
        self.kind
    }

    pub(super) fn name(&self) -> &str {
        &self.name
    }

    pub(super) fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    pub(super) fn sum(&self) -> Option<&str> {
        self.sum.as_deref()
    }

    pub(super) fn is_link(&self) -> bool {
        self.link.is_some()
    }

    pub(super) fn value(&self) -> Option<&str> {
        self.value.as_deref()
    }

    pub(super) fn enabled(&self) -> Option<bool> {
        self.enabled
    }

    /// A skill folder with a SKILL.md, which the agents load.
    pub(super) fn has_doc(&self) -> bool {
        self.skill.as_ref().is_some_and(|skill| skill.has_doc)
    }
}

#[cfg(test)]
impl MachineSetup {
    /// The same, with a file or skill folder at `item_path` in the home at `home`, fingerprinted `sum` (none for a link).
    pub(super) fn with_file(mut self, home: &str, kind: ItemKind, item_path: &str, sum: Option<&str>) -> Self {
        if let Some(found) = self.homes.iter_mut().find(|entry| entry.path == home) {
            let mut item = SetupItem::new(kind, item_path.rsplit('/').next().unwrap_or(item_path));
            item.path = Some(item_path.to_string());
            item.sum = sum.map(str::to_string);
            item.link = sum.is_none().then(|| "~/elsewhere".to_string());
            if kind == ItemKind::Skill {
                item.skill = Some(SkillFacts { files: 1, has_doc: true, declared_name: None, description_chars: 0, when_to_use_chars: 0, manual_only: false, source: None });
            }
            found.items.push(item);
        }
        self.scanned_at.get_or_insert(1);
        self
    }

    /// The same, with `script` in the machine's ~/.agents/hooks, which has to be one of its homes.
    pub(super) fn with_hook_script(mut self, script: &str) -> Self {
        if let Some(home) = self.homes.iter_mut().find(|home| home.path == "~/.agents") {
            let mut item = SetupItem::new(ItemKind::Hook, script);
            item.path = Some(format!("~/.agents/hooks/{script}"));
            item.sum = Some("s".into());
            home.items.push(item);
        }
        self
    }

    pub(super) fn set_home_hooks(&mut self, path: &str, hooks: Vec<FoundHook>) {
        for home in self.homes.iter_mut().filter(|home| home.path == path) {
            home.repo_hooks = hooks.clone();
        }
    }

    /// The same, with an empty home of another harness at `path`.
    pub(super) fn with_harness_home(mut self, harness: Harness, path: &str) -> Self {
        self.harness_homes.push(HarnessHome { harness, path: path.to_string(), items: Vec::new(), skills_link: None, problems: Vec::new() });
        self
    }

    /// A scan that found these homes, with nothing in them.
    pub(super) fn with_homes(homes: &[(HomeAgent, &str)]) -> Self {
        Self {
            homes: homes
                .iter()
                .map(|(agent, path)| SetupHome {
                    agent: *agent,
                    path: path.to_string(),
                    items: Vec::new(),
                    problems: Vec::new(),
                    skills_link: None,
                    skill_overrides: Vec::new(),
                    ignored_overrides: Vec::new(),
            denied_mcp: Vec::new(),
                    shares: None,
                    repo_hooks: Vec::new(),
                })
                .collect(),
            ..Self::default()
        }
    }

    /// The same, with an item in the home at `path`: a plugin and its version, a marketplace, and
    /// whether it's on.
    pub(super) fn with_item(mut self, path: &str, kind: ItemKind, name: &str, value: Option<&str>, enabled: Option<bool>) -> Self {
        if let Some(home) = self.homes.iter_mut().find(|home| home.path == path) {
            let mut item = SetupItem::new(kind, name);
            item.value = value.map(str::to_string);
            item.enabled = enabled;
            home.items.push(item);
        }
        self
    }

    /// The same, on a machine whose home folder is `dir`.
    pub(super) fn with_home_dir(mut self, dir: &str) -> Self {
        self.home_dir = dir.to_string();
        self.scanned_at = Some(1);
        self
    }

    /// The same, with an MCP server in the home at `path` that `server` defines.
    pub(super) fn with_mcp(mut self, path: &str, name: &str, server: &Value) -> Self {
        let dir = self.home_dir.clone();
        if let Some(home) = self.homes.iter_mut().find(|home| home.path == path) {
            home.items.push(mcp_item(home.agent, name, server, &dir, salt()));
        }
        self
    }

    /// The same, with a server in the MCP file of another harness's home at `path`.
    pub(super) fn with_harness_mcp(mut self, path: &str, name: &str, server: &Value) -> Self {
        let dir = self.home_dir.clone();
        if let Some(home) = self.harness_homes.iter_mut().find(|home| home.path == path) {
            home.items.push(mcp_item(HomeAgent::Shared, name, server, &dir, salt()));
        }
        self
    }

    /// The same, on a machine whose managed-settings policy sets these.
    pub(super) fn with_policy(mut self, keys: &[(ItemKind, &str)]) -> Self {
        self.policy = Some(ClaudePolicy {
            file: "/etc/claude-code/managed-settings.json".into(),
            keys: keys.iter().map(|(kind, name)| PolicyKey { kind: *kind, name: name.to_string() }).collect(),
            problem: None,
            ignored_overrides: false,
        });
        self
    }

    /// The same, with the home at `path` sharing these entries with the Codex home at `with`.
    pub(super) fn with_shared(mut self, path: &str, with: &str, entries: &[&str]) -> Self {
        if let Some(home) = self.homes.iter_mut().find(|home| home.path == path) {
            home.shares = Some(SharedHome { home: with.to_string(), entries: entries.iter().map(|entry| entry.to_string()).collect() });
        }
        self
    }

    /// The same, with the skills folder of the home at `path` a link to `target`.
    pub(super) fn with_skills_link(mut self, path: &str, target: &str) -> Self {
        if let Some(home) = self.homes.iter_mut().find(|home| home.path == path) {
            home.skills_link = Some(target.to_string());
        }
        self
    }
}

/// Kinds of file whose content can be read from a machine.
pub(super) const TEXT_KINDS: [ItemKind; 6] = [ItemKind::Instructions, ItemKind::Import, ItemKind::Rule, ItemKind::Subagent, ItemKind::Command, ItemKind::Hook];

/// The machine a read is for, how to reach it, and the item its last scan found at `path`.
pub(super) fn scanned_item(inner: &Inner, machine: &str, path: &str, kinds: &[ItemKind]) -> Result<(Machine, String), String> {
    let (target, setup) = covered_machine(inner, machine)?;
    setup
        .homes
        .iter()
        .flat_map(|home| &home.items)
        .chain(setup.harness_homes.iter().flat_map(|home| &home.items))
        .find(|item| kinds.contains(&item.kind) && item.path.as_deref() == Some(path) && item.sum.is_some() && (item.text || item.kind == ItemKind::Skill))
        .ok_or_else(|| "Arbor can only show what its last scan of this machine found. Scan again.".to_string())?;
    Ok((target, untilde(path, &setup.home_dir)))
}

/// A file's content, for comparing.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupText {
    /// None when it's over 256 KB or isn't text.
    pub(super) content: Option<String>,
    pub(super) size: u64,
}

fn parse_text(stdout: &str) -> Result<SetupText, String> {
    let mut lines = stdout.lines();
    let first = lines.next().unwrap_or_default();
    if let Some(size) = first.strip_prefix("L\t") {
        return Ok(SetupText { content: None, size: size.trim().parse().unwrap_or(0) });
    }
    let size: u64 = first
        .strip_prefix("T\t")
        .and_then(|size| size.trim().parse().ok())
        .ok_or("The machine sent back something Arbor couldn't read")?;
    let encoded: String = lines.map(str::trim).collect();
    let bytes = STANDARD.decode(encoded.as_bytes()).map_err(|_| "The file came back unreadable".to_string())?;
    if bytes.len() as u64 != size {
        return Err("The file came back incomplete".into());
    }
    Ok(SetupText { content: String::from_utf8(bytes).ok(), size })
}

/// The content of a text file a scan found, for comparing it with another machine's.
#[tauri::command]
pub(crate) async fn read_setup_text(
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    path: String,
) -> Result<SetupText, String> {
    let (target, absolute) = scanned_item(&state.lock(), &machine, &path, &TEXT_KINDS)?;
    read_text(&target, &absolute).await
}

/// The content of the text file at `absolute` on a machine.
pub(super) async fn read_text(machine: &Machine, absolute: &str) -> Result<SetupText, String> {
    read_text_after(machine, &format!("f={}\n", shell_quote(absolute))).await
}

/// The content of the text file a `prelude` of shell sets `f` to, on a machine.
pub(super) async fn read_text_after(machine: &Machine, prelude: &str) -> Result<SetupText, String> {
    let script = format!("set -u\nexport LC_ALL=C\n{prelude}{READ_TEXT_SCRIPT}");
    parse_text(&run_checked(machine, MachineOp::SetupFileRead, &script, READ_TIMEOUT).await?)
}

/// One file in a skill.
/// Why a skill's file isn't shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HiddenReason {
    /// Its name says it may hold a secret.
    Secret,
    Large,
    Binary,
}

#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupSkillFile {
    /// Within the skill's folder.
    pub(super) path: String,
    pub(super) sum: String,
    pub(super) size: u64,
    /// None when it isn't shown.
    pub(super) content: Option<String>,
    /// Why it isn't shown.
    pub(super) hidden: Option<HiddenReason>,
}

fn parse_skill(stdout: &str) -> Result<Vec<SetupSkillFile>, String> {
    let mut files = Vec::new();
    let mut lines = stdout.lines();
    while let Some(line) = lines.next() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["C", path, sum, size] => {
                let mut encoded = String::new();
                for line in lines.by_ref() {
                    if line == "." {
                        break;
                    }
                    encoded.push_str(line.trim());
                }
                let size: u64 = size.parse().unwrap_or(0);
                let bytes = STANDARD.decode(encoded.as_bytes()).ok().filter(|bytes| bytes.len() as u64 == size);
                let Some(bytes) = bytes else {
                    return Err(format!("{path} came back incomplete"));
                };
                let content = String::from_utf8(bytes).ok();
                let hidden = content.is_none().then_some(HiddenReason::Binary);
                files.push(SetupSkillFile { path: path.to_string(), sum: sum.to_string(), size, content, hidden });
            }
            ["N", path, sum, size, why] => files.push(SetupSkillFile {
                path: path.to_string(),
                sum: sum.to_string(),
                size: size.parse().unwrap_or(0),
                content: None,
                hidden: Some(if *why == "secret" { HiddenReason::Secret } else { HiddenReason::Large }),
            }),
            _ => {}
        }
    }
    Ok(files)
}

/// The files of a skill a scan found, with the content of those that can be shown, for comparing
/// it with another machine's.
#[tauri::command]
pub(crate) async fn read_setup_skill(
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    path: String,
) -> Result<Vec<SetupSkillFile>, String> {
    let (target, absolute) = scanned_item(&state.lock(), &machine, &path, &[ItemKind::Skill])?;
    let script = format!("set -u\nexport LC_ALL=C\n{}{HELPERS}d={}\n{READ_SKILL_SCRIPT}", agent_homes::helpers(), shell_quote(&absolute));
    parse_skill(&run_checked(&target, MachineOp::SkillRead, &script, READ_TIMEOUT).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SALT: &[u8] = b"test-salt";

    fn item<'a>(home: &'a SetupHome, kind: ItemKind, name: &str) -> &'a SetupItem {
        home.items
            .iter()
            .find(|item| item.kind == kind && item.name == name)
            .unwrap_or_else(|| panic!("no {kind:?} {name} in {}", home.path))
    }

    fn names(home: &SetupHome, kind: ItemKind) -> Vec<&str> {
        home.items.iter().filter(|item| item.kind == kind).map(|item| item.name.as_str()).collect()
    }

    fn data(kind: &str, path: &str, content: &str) -> String {
        format!("J\t{kind}\t{path}\t{}\n{}\n.\n", content.len(), STANDARD.encode(content))
    }

    #[test]
    fn fingerprints_ignore_key_order_and_where_the_home_is() {
        let mac = serde_json::json!({ "command": "bash /Users/cam/.claude/statusline.sh", "type": "command" });
        let linux = serde_json::json!({ "type": "command", "command": "bash /home/cam/.claude/statusline.sh" });
        assert_eq!(fingerprint(&mac, "/Users/cam", SALT), fingerprint(&linux, "/home/cam", SALT));
        assert_ne!(fingerprint(&mac, "/Users/cam", SALT), fingerprint(&mac, "/Users/cam", b"another-salt"));
        assert_ne!(
            fingerprint(&serde_json::json!("a"), "/h", SALT),
            fingerprint(&serde_json::json!(["a"]), "/h", SALT),
        );
    }

    #[test]
    fn paths_are_worked_out_without_the_file_system() {
        assert_eq!(normalize_path("/Users/a/.claude/skills/../../.agents/skills/x"), "/Users/a/.agents/skills/x");
        assert_eq!(normalize_path("/a/./b//c/"), "/a/b/c");
        assert_eq!(link_target("/Users/a/.claude/skills/x", "../../.agents/skills/x"), "/Users/a/.agents/skills/x");
        assert_eq!(link_target("/Users/a/.claude/CLAUDE.md", "/Users/a/dotfiles/CLAUDE.md"), "/Users/a/dotfiles/CLAUDE.md");
        assert_eq!(untilde("~/.claude/CLAUDE.md", "/home/cam"), "/home/cam/.claude/CLAUDE.md");
        assert_eq!(untilde("/etc/codex", "/home/cam"), "/etc/codex");
        assert_eq!(url_host("https://user:pass@mcp.example.com:8443/sse?key=abc"), Some("mcp.example.com:8443".into()));
        assert_eq!(url_place("https://token@github.com/org/repo.git?x=1"), Some("github.com/org/repo.git".into()));
        assert!(looks_secret("/Users/a/.agents/skills/x/.env.local"));
        assert!(looks_secret("/x/API_TOKEN.txt"));
        assert!(!looks_secret("/Users/a/.claude/CLAUDE.md"));
    }

    #[test]
    fn a_scan_lists_each_homes_files_skills_and_imports() {
        let stdout = [
            "H\t/Users/cam",
            "A\tclaude\t/Users/cam/.claude",
            "F\tinstructions\t/Users/cam/.claude/CLAUDE.md\taaa\t1700\t-",
            "I\t1\t/Users/cam/.claude/CLAUDE.md\t~/notes/style.md\t/Users/cam/notes/style.md\tbbb",
            "I\t1\t/Users/cam/.claude/CLAUDE.md\tmissing.md\t/Users/cam/.claude/missing.md\t-",
            "I\t2\t/Users/cam/notes/style.md\t../notes/style.md\t/Users/cam/notes/../notes/style.md\tbbb",
            "F\trule\t/Users/cam/.claude/rules/web/react.md\tccc\t200\t-",
            "F\tsubagent\t/Users/cam/.claude/agents/reviewer.md\tddd\t300\t-",
            "F\tcommand\t/Users/cam/.claude/commands/git/ship.md\teee\t100\t-",
            "S\t/Users/cam/.claude/skills/pdf\tfff\t3\t../../.agents/skills/pdf\t1\tpdf\t120\t40\t0",
            "S\t/Users/cam/.claude/skills/deploy\tddd\t1\t-\t1\tdeploy\t60\t0\t1",
            "S\t/Users/cam/.claude/skills/everything\t-\t0\t/Users/cam/.agents/skills\t0\t\t\t\t",
            "S\t/Users/cam/.claude/skills/gone\t-\t0\t../../src/gone\t-\t\t\t\t",
            "A\tcodex\t/Users/cam/.codex",
            "F\tinstructions\t/Users/cam/.codex/AGENTS.override.md\tggg\t20\t-",
            "F\tinstructions\t/Users/cam/.codex/AGENTS.md\thhh\t414\t-",
            "F\trule\t/Users/cam/.codex/rules/default.rules\tiii\t90\t-",
            "F\tcommand\t/Users/cam/.codex/prompts/review.md\tjjj\t50\t-",
            "F\tprofile\t/Users/cam/.codex/review.config.toml\tkkk\t80\t-",
            "SL\t/Users/cam/.codex/skills\t../.agents/skills",
            "A\tshared\t/Users/cam/.agents",
            "S\t/Users/cam/.agents/skills/pdf\tfff\t3\t-\t1\tpdf\t120\t40\t0",
            "F\thookscript\t/Users/cam/.agents/hooks/guard.sh\tlll\t30\t-",
            "B\tclaude\t/Users/cam/.local/bin/claude\t/Users/cam/.local/share/claude/versions/2.1.281\t2.1.281 (Claude Code)",
            "B\tcodex\t/Users/cam/.npm-global/bin/codex\t/Users/cam/.npm-global/bin/codex\tcodex-cli 0.156.1",
            "B\tcodex\t/opt/homebrew/bin/codex\t/opt/homebrew/Caskroom/codex/0.153.3/codex\t",
            "B\tgemini\t/usr/local/bin/gemini\t/usr/local/bin/gemini\t1.0.0",
        ]
        .join("\n");
        let stdout = format!(
            "{stdout}\n{}",
            data("skilllock", "/Users/cam/.agents/.skill-lock.json", r#"{"skills":{"pdf":{"source":"anthropics/skills","sourceType":"github"}}}"#),
        );
        let scan = parse_scan(&stdout, SALT).unwrap();
        assert_eq!(scan.home_dir, "/Users/cam");
        assert_eq!(scan.homes.iter().map(|home| home.path.as_str()).collect::<Vec<_>>(), ["~/.claude", "~/.codex", "~/.agents"]);

        let claude = &scan.homes[0];
        let instructions = item(claude, ItemKind::Instructions, "CLAUDE.md");
        assert_eq!((instructions.path.as_deref(), instructions.size, instructions.text), (Some("~/.claude/CLAUDE.md"), Some(1700), true));
        let style = item(claude, ItemKind::Import, "~/notes/style.md");
        assert_eq!(style.sum.as_deref(), Some("bbb"));
        assert_eq!(style.import, Some(ImportFacts { from: "~/.claude/CLAUDE.md".into(), written: "~/notes/style.md".into(), level: 1 }));
        assert_eq!(names(claude, ItemKind::Import).len(), 2, "a file reached twice is listed once");
        let missing = item(claude, ItemKind::Import, "~/.claude/missing.md");
        assert_eq!((missing.sum.as_deref(), missing.text), (None, false));
        assert_eq!(names(claude, ItemKind::Rule), ["web/react.md"]);
        assert_eq!(names(claude, ItemKind::Subagent), ["reviewer"]);
        assert_eq!(names(claude, ItemKind::Command), ["git:ship"]);
        let pdf = item(claude, ItemKind::Skill, "pdf");
        assert_eq!(pdf.link.as_deref(), Some("~/.agents/skills/pdf"));
        assert_eq!(
            pdf.skill.as_ref().map(|skill| (skill.files, skill.has_doc, skill.description_chars, skill.when_to_use_chars, skill.manual_only)),
            Some((3, true, 120, 40, false)),
        );
        assert_eq!(item(claude, ItemKind::Skill, "deploy").skill.as_ref().map(|skill| skill.manual_only), Some(true));
        let everything = item(claude, ItemKind::Skill, "everything");
        assert_eq!(everything.skill.as_ref().map(|skill| skill.has_doc), Some(false));
        assert_eq!(everything.sum, None);
        let gone = item(claude, ItemKind::Skill, "gone");
        assert_eq!((gone.link.as_deref(), gone.sum.as_deref(), gone.skill.as_ref()), (Some("~/src/gone"), None, None), "a link to nothing");

        let codex = &scan.homes[1];
        assert_eq!(item(codex, ItemKind::Instructions, "AGENTS.md").enabled, Some(false), "the override takes its place");
        assert_eq!(item(codex, ItemKind::Instructions, "AGENTS.override.md").enabled, None);
        assert_eq!(names(codex, ItemKind::Rule), ["default.rules"]);
        assert_eq!(names(codex, ItemKind::Command), ["review"]);
        let profile = item(codex, ItemKind::Profile, "review");
        assert!(!profile.text, "a profile can hold secrets, so it's never shown");
        assert_eq!((claude.skills_link.as_deref(), codex.skills_link.as_deref()), (None, Some("~/.agents/skills")));

        let shared = &scan.homes[2];
        assert_eq!(item(shared, ItemKind::Skill, "pdf").skill.as_ref().and_then(|skill| skill.source.as_deref()), Some("anthropics/skills"));
        let script = item(shared, ItemKind::Hook, "guard.sh");
        assert_eq!((script.path.as_deref(), script.text), (Some("~/.agents/hooks/guard.sh"), true), "a hook script is a file the repo syncs");

        let install = |agent, path: &str, real: Option<&str>, version: Option<&str>| SetupInstall {
            agent,
            path: path.into(),
            real: real.map(Into::into),
            version: version.map(Into::into),
        };
        assert_eq!(scan.installs, [
            install(AgentKind::Claude, "~/.local/bin/claude", Some("~/.local/share/claude/versions/2.1.281"), Some("2.1.281")),
            install(AgentKind::Codex, "~/.npm-global/bin/codex", None, Some("0.156.1")),
            install(AgentKind::Codex, "/opt/homebrew/bin/codex", Some("/opt/homebrew/Caskroom/codex/0.153.3/codex"), None),
        ], "in PATH order, with any other program left out");
    }

    #[test]
    fn settings_come_out_as_fingerprints_with_only_safe_values_shown() {
        const SECRET: &str = "sk-NEVER-SHOWN-12345";
        let settings = format!(
            r#"{{
  "model": "opus",
  "effortLevel": "high",
  "autoCompactEnabled": false,
  "apiKeyHelper": "/Users/cam/bin/key --token {SECRET}",
  "env": {{ "ANTHROPIC_AUTH_TOKEN": "{SECRET}", "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317" }},
  "permissions": {{ "defaultMode": "acceptEdits", "allow": ["Bash(git:*)", "Read"] }},
  "hooks": {{
    "Stop": [{{ "hooks": [{{ "type": "command", "command": "\"$HOME/.arbor/bin/arbor-agent-event\" claude" }}] }}],
    "PreToolUse": [{{ "matcher": "Bash", "hooks": [{{ "type": "command", "command": "guard.sh" }}, {{ "type": "command", "command": "\"$HOME/.arbor/bin/arbor-agent-event\" claude" }}] }}],
    "SessionStart": [{{ "hooks": [{{ "type": "command", "command": "bash /Users/cam/.agents/hooks/start.sh --token {SECRET}" }}] }}]
  }},
  "enabledPlugins": {{ "codex@openai-codex": true, "paper@paper": false, "ghost@nowhere": true }},
  "extraKnownMarketplaces": {{ "team": {{ "source": {{ "source": "git", "url": "https://{SECRET}@git.example.com/team/plugins.git" }}, "autoUpdate": true }} }},
  "feedbackDrafts": {{ "draft": "{SECRET}" }}
}}"#
        );
        let mcp = format!(
            r#"{{ "linear": {{ "type": "http", "url": "https://mcp.linear.app/mcp", "headers": {{ "Authorization": "Bearer {SECRET}" }} }},
  "github": {{ "command": "/opt/homebrew/bin/npx", "args": ["-y", "server-github", "--token={SECRET}"], "env": {{ "GITHUB_TOKEN": "{SECRET}" }} }} }}"#
        );
        let plugins = r#"{"version":2,"plugins":{"codex@openai-codex":[{"scope":"user","version":"1.4.0","gitCommitSha":"abc","installedAt":"2026-09-01T10:00:00.000Z","lastUpdated":"2026-09-20T08:30:00.000Z"}],"paper@paper":[{"scope":"project","version":"0.2.0","lastUpdated":"2026-09-02T10:00:00.000Z"}]}}"#;
        let marketplaces = r#"{"openai-codex":{"source":{"source":"github","repo":"openai/codex-plugins"},"lastUpdated":"2026-09-24T22:00:00.000Z","autoUpdate":false},
  "odd":{"source":{"source":"github","repo":"someone/odd"},"lastUpdated":"not a time $(id)"},
  "team":{"source":{"source":"git","url":"https://git.example.com/team/plugins.git"},"autoUpdate":false}}"#;
        let stdout = format!(
            "H\t/Users/cam\nA\tclaude\t/Users/cam/.claude\n{}{}{}{}",
            data("settings", "/Users/cam/.claude/settings.json", &settings),
            data("mcp", "/Users/cam/.claude.json", &mcp),
            data("plugins", "/Users/cam/.claude/plugins/installed_plugins.json", plugins),
            data("marketplaces", "/Users/cam/.claude/plugins/known_marketplaces.json", marketplaces),
        );
        let scan = parse_scan(&stdout, SALT).unwrap();
        let home = &scan.homes[0];
        assert!(home.problems.is_empty(), "{:?}", home.problems);
        assert!(!serde_json::to_string(&scan.homes).unwrap().contains("NEVER-SHOWN"));

        assert_eq!(item(home, ItemKind::Setting, "model").value.as_deref(), Some("opus"));
        assert_eq!(item(home, ItemKind::Setting, "autoCompactEnabled").value.as_deref(), Some("false"));
        assert_eq!(item(home, ItemKind::Setting, "apiKeyHelper").value, None, "only listed strings are shown");
        assert_eq!(item(home, ItemKind::Setting, "permissions.defaultMode").value.as_deref(), Some("acceptEdits"));
        assert_eq!(item(home, ItemKind::Setting, "permissions.allow").count, Some(2));
        assert!(home.items.iter().all(|item| item.name != "feedbackDrafts"));
        assert_eq!(names(home, ItemKind::Env), ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]);
        assert!(home.items.iter().filter(|item| item.kind == ItemKind::Env).all(|item| item.value.is_none() && item.sum.is_some()));

        assert_eq!(names(home, ItemKind::Hook), ["PreToolUse"], "Arbor's reporter isn't counted");
        assert_eq!(item(home, ItemKind::Hook, "PreToolUse").count, Some(1));
        // A hook running a script in ~/.agents/hooks is the setup repo's: kept apart, by fingerprint only.
        assert_eq!(home.repo_hooks.iter().map(|found| (found.event.as_str(), found.script.as_str())).collect::<Vec<_>>(), [("SessionStart", "start.sh")]);
        let handler = serde_json::json!({ "type": "command", "command": format!("bash ~/.agents/hooks/start.sh --token {SECRET}") });
        assert_eq!(home.repo_hooks[0].sum, hook_sum_with(None, &handler, "/Users/cam", SALT), "the home folder counts as ~");

        let linear = item(home, ItemKind::Mcp, "linear");
        assert_eq!((linear.value.as_deref(), linear.note.as_deref()), (Some("http"), Some("mcp.linear.app")));
        let github = item(home, ItemKind::Mcp, "github");
        assert_eq!((github.value.as_deref(), github.note.as_deref()), (Some("stdio"), Some("npx")));

        let codex = item(home, ItemKind::Plugin, "codex@openai-codex");
        assert_eq!((codex.value.as_deref(), codex.enabled), (Some("1.4.0"), Some(true)));
        assert_eq!(codex.note.as_deref(), Some("2026-09-20T08:30:00.000Z"), "when it was last updated");
        let paper = item(home, ItemKind::Plugin, "paper@paper");
        assert_eq!((paper.value.as_deref(), paper.note.as_deref()), (None, None), "only installs for the user count");
        assert_eq!(item(home, ItemKind::Plugin, "ghost@nowhere").value, None);
        let official = item(home, ItemKind::Marketplace, "openai-codex");
        assert_eq!(official.note.as_deref(), Some("openai/codex-plugins"));
        assert_eq!((official.value.as_deref(), official.enabled), (Some("2026-09-24T22:00:00.000Z"), Some(false)));
        let odd = item(home, ItemKind::Marketplace, "odd");
        assert_eq!((odd.value.as_deref(), odd.enabled), (None, None), "only a time is kept");
        let team = item(home, ItemKind::Marketplace, "team");
        assert_eq!(team.note.as_deref(), Some("git.example.com/team/plugins.git"));
        assert_eq!(team.enabled, Some(true), "settings come before what Claude Code recorded");
    }

    #[test]
    fn skill_overrides_are_read_per_skill_and_dropped_whole_as_claude_code_does() {
        let settings = r#"{ "model": "opus", "skillOverrides": { "pdf": "off", "deploy": "user-invocable-only", "notes": "name-only", "docs": "on" } }"#;
        let stdout = format!("H\t/Users/cam\nA\tclaude\t/Users/cam/.claude\n{}", data("settings", "/Users/cam/.claude/settings.json", settings));
        let scan = parse_scan(&stdout, SALT).unwrap();
        let home = &scan.homes[0];
        let overrides: Vec<(&str, OverrideState)> = home.skill_overrides.iter().map(|entry| (entry.name.as_str(), entry.state)).collect();
        assert_eq!(overrides, [
            ("deploy", OverrideState::UserInvocableOnly),
            ("docs", OverrideState::On),
            ("notes", OverrideState::NameOnly),
            ("pdf", OverrideState::Off),
        ]);
        assert!(home.skill_overrides.iter().all(|entry| entry.source == OverrideSource::Settings && entry.file == "~/.claude/settings.json"));
        assert!(home.items.iter().all(|item| item.name != "skillOverrides"), "each shows on its skill, not as a setting");
        assert!(home.ignored_overrides.is_empty());

        // One value Claude Code doesn't know, or a boolean, and it ignores every override in the file.
        for odd in [r#"{ "pdf": "off", "deploy": "disabled" }"#, r#"{ "pdf": false }"#, r#"["pdf"]"#] {
            let settings = format!(r#"{{ "skillOverrides": {odd} }}"#);
            let stdout = format!("H\t/h\nA\tclaude\t/h/.agent-app/homes/claude-other\n{}", data("settings", "/h/.agent-app/homes/claude-other/settings.json", &settings));
            let home = &parse_scan(&stdout, SALT).unwrap().homes[0];
            assert!(home.skill_overrides.is_empty(), "{odd}");
            assert_eq!(home.ignored_overrides, ["~/.agent-app/homes/claude-other/settings.json"], "{odd}");
            assert!(home.problems.is_empty(), "the file itself reads fine");
        }
    }

    #[test]
    fn a_policy_gives_names_its_skill_overrides_and_what_went_wrong_reading_it() {
        let policy_file = "/Library/Application Support/ClaudeCode/managed-settings.json";
        let policy = r#"{
            "$schema": "https://json.schemastore.org/claude-code-settings.json",
            "model": "opus",
            "cleanupPeriodDays": 90,
            "permissions": { "defaultMode": "plan", "deny": ["Bash(rm:*)"] },
            "env": { "CLAUDE_CODE_ENABLE_TELEMETRY": "1", "OTEL_EXPORTER_OTLP_METRICS_HEADERS": "Authorization=Bearer policy-secret" },
            "hooks": { "PreToolUse": [{ "hooks": [{ "type": "command", "command": "/opt/audit.sh" }] }] },
            "enabledPlugins": { "audit@corp": true },
            "extraKnownMarketplaces": { "corp": { "source": { "source": "github", "repo": "corp/plugins" } } },
            "skillOverrides": { "deploy": "off", "pdf": "name-only" },
            "\u0007odd": 1
        }"#;
        let stdout = format!(
            "H\t/h\n{}A\tclaude\t/h/.claude\n{}A\tcodex\t/h/.codex\n",
            data("managed", policy_file, policy),
            data("settings", "/h/.claude/settings.json", r#"{ "skillOverrides": { "pdf": "off", "web": "off" } }"#),
        );
        let scan = parse_scan(&stdout, SALT).unwrap();
        let found = scan.policy.as_ref().unwrap();
        assert_eq!((found.file.as_str(), found.problem.as_deref(), found.ignored_overrides), (policy_file, None, false));
        let keys: Vec<(ItemKind, &str)> = found.keys.iter().map(|key| (key.kind, key.name.as_str())).collect();
        assert_eq!(keys, [
            (ItemKind::Hook, "PreToolUse"),
            (ItemKind::Plugin, "audit@corp"),
            (ItemKind::Marketplace, "corp"),
            (ItemKind::Setting, "cleanupPeriodDays"),
            (ItemKind::Setting, "model"),
            (ItemKind::Setting, "permissions.defaultMode"),
            (ItemKind::Setting, "permissions.deny"),
            (ItemKind::Env, "CLAUDE_CODE_ENABLE_TELEMETRY"),
            (ItemKind::Env, "OTEL_EXPORTER_OTLP_METRICS_HEADERS"),
        ]);
        let shown = serde_json::to_string(&scan.policy).unwrap();
        assert!(!shown.contains("policy-secret") && !shown.contains("audit.sh") && !shown.contains("opus") && !shown.contains("rm:"), "{shown}");

        // Skill by skill, the policy's override wins; the home's own for other skills stand. Codex has none.
        let claude = &scan.homes[0];
        let overrides: Vec<_> = claude.skill_overrides.iter().map(|entry| (entry.name.as_str(), entry.state, entry.source, entry.file.as_str())).collect();
        assert_eq!(overrides, [
            ("deploy", OverrideState::Off, OverrideSource::Policy, policy_file),
            ("pdf", OverrideState::NameOnly, OverrideSource::Policy, policy_file),
            ("web", OverrideState::Off, OverrideSource::Settings, "~/.claude/settings.json"),
        ]);
        assert!(scan.homes[1].skill_overrides.is_empty());
        assert!(claude.problems.is_empty(), "the policy's problems are its own, not the home's");

        // Overrides Claude Code ignores are said so, and the homes keep their own.
        let ignored = format!("H\t/h\n{}A\tclaude\t/h/.claude\n", data("managed", policy_file, r#"{ "skillOverrides": { "pdf": "hidden" } }"#));
        let scan = parse_scan(&ignored, SALT).unwrap();
        assert!(scan.policy.as_ref().unwrap().ignored_overrides);
        assert!(scan.homes[0].skill_overrides.is_empty());

        // What couldn't be read is named, never quoted.
        let cases = [
            (format!("J\tmanaged\t{policy_file}\tunreadable\n.\n"), "can't read it"),
            (format!("J\tmanaged\t{policy_file}\tlarge\n.\n"), "over 1 MB"),
            (data("managed", policy_file, "{ \"env\": { \"TOKEN\": \"policy-secret\" "), "isn't JSON"),
            (format!("J\tmanaged\t{policy_file}\t99\ne30=\n.\n"), "incomplete"),
        ];
        for (lines, problem) in cases {
            let scan = parse_scan(&format!("H\t/h\n{lines}A\tclaude\t/h/.claude\n"), SALT).unwrap();
            let found = scan.policy.unwrap();
            assert!(found.problem.as_deref().is_some_and(|said| said.starts_with(policy_file) && said.contains(problem)), "{found:?}");
            assert!(found.keys.is_empty() && !found.problem.unwrap().contains("policy-secret"));
            assert_eq!(scan.homes.len(), 1);
        }
    }

    #[test]
    fn a_shadow_homes_links_leave_what_they_hold_to_the_home_it_shares() {
        let codex = "/h/.codex";
        let shadow = "/h/.agent-app/homes/codex-other";
        let lines = [
            format!("H\t/h"),
            format!("A\tcodex\t{codex}"),
            format!("F\tinstructions\t{codex}/AGENTS.md\ta1\t12\t-"),
            format!("S\t{codex}/skills/pdf\tk1\t2\t-\t1\tpdf\t20\t0\t0"),
            data("config", &format!("{codex}/config.toml"), "model = \"gpt-5.5\"\n[mcp_servers.fs]\ncommand = \"npx\"\n").trim_end().to_string(),
            format!("A\tcodex\t{shadow}"),
            // As T3 Code makes them: absolute links to the same entry in the home it shares, and one relative.
            format!("K\tAGENTS.md\t{codex}/AGENTS.md"),
            format!("K\tconfig.toml\t{codex}/config.toml"),
            format!("K\tsessions\t{codex}/sessions"),
            format!("K\tskills\t../../../.codex/skills"),
            // Not the same entry, nor into a Codex home: these stay the shadow home's own.
            format!("K\tprompts\t{codex}/rules"),
            format!("K\tfast.config.toml\t/h/dotfiles/fast.config.toml"),
            format!("F\tinstructions\t{shadow}/AGENTS.md\ta1\t12\t{codex}/AGENTS.md"),
            format!("SL\t{shadow}/skills\t../../../.codex/skills"),
            format!("S\t{shadow}/skills/pdf\tk1\t2\t-\t1\tpdf\t20\t0\t0"),
            format!("F\tcommand\t{shadow}/prompts/ship.md\tm1\t9\t-"),
            format!("F\tprofile\t{shadow}/fast.config.toml\tf1\t20\t/h/dotfiles/fast.config.toml"),
            data("config", &format!("{shadow}/config.toml"), "model = \"gpt-5.5\"\n[mcp_servers.fs]\ncommand = \"npx\"\n").trim_end().to_string(),
            data("hooks", &format!("{shadow}/hooks.json"), "not json").trim_end().to_string(),
        ];
        let scan = parse_scan(&(lines.join("\n") + "\n"), SALT).unwrap();
        let (main, t3) = (&scan.homes[0], &scan.homes[1]);
        assert_eq!(main.shares, None);
        assert_eq!(names(main, ItemKind::Mcp), ["fs"]);
        assert_eq!(
            t3.shares,
            Some(SharedHome { home: "~/.codex".into(), entries: vec!["AGENTS.md".into(), "config.toml".into(), "sessions".into(), "skills".into()] }),
        );
        let items: Vec<(ItemKind, &str)> = t3.items.iter().map(|item| (item.kind, item.name.as_str())).collect();
        assert_eq!(items, [(ItemKind::Command, "ship"), (ItemKind::Profile, "fast")], "only what it doesn't share is its own");
        assert_eq!(t3.skills_link.as_deref(), Some("~/.codex/skills"), "its skills folder still reads as a link, so nothing changes skills through it");
        assert_eq!(t3.problems, ["~/.agent-app/homes/codex-other/hooks.json isn't JSON Arbor can read"], "a file of its own is still read");

        // A Codex home that links into one Arbor didn't find is read as it is, and Claude Code homes never share.
        let alone = format!("H\t/h\nA\tcodex\t{shadow}\nK\tconfig.toml\t{codex}/config.toml\nA\tclaude\t/h/.claude\nK\tskills\t{codex}/skills\n");
        let scan = parse_scan(&alone, SALT).unwrap();
        assert!(scan.homes.iter().all(|home| home.shares.is_none()));

        let setup = MachineSetup::with_homes(&[(HomeAgent::Codex, "~/.codex"), (HomeAgent::Codex, "~/.agent-app/homes/codex-other")])
            .with_shared("~/.agent-app/homes/codex-other", "~/.codex", &["config.toml"]);
        assert!(setup.shares("~/.agent-app/homes/codex-other", "config.toml"));
        assert!(!setup.shares("~/.agent-app/homes/codex-other", "skills"));
        assert!(!setup.shares("~/.codex", "config.toml"));
    }

    #[test]
    fn what_a_policy_sets_is_left_to_it() {
        let setup = MachineSetup::with_homes(&[(HomeAgent::Claude, "~/.claude")])
            .with_policy(&[(ItemKind::Setting, "cleanupPeriodDays"), (ItemKind::Env, "CLAUDE_CODE_ENABLE_TELEMETRY")]);
        assert!(setup.policy_sets(ItemKind::Setting, "cleanupPeriodDays"));
        assert!(!setup.policy_sets(ItemKind::Env, "cleanupPeriodDays"), "a name counts only for its kind");
        assert!(setup.leave_to_policy("ci-01", ItemKind::Setting, &["model"]).is_ok());
        assert_eq!(
            setup.leave_to_policy("ci-01", ItemKind::Env, &["OTEL_METRICS_EXPORTER", "CLAUDE_CODE_ENABLE_TELEMETRY"]).unwrap_err(),
            "The managed settings policy on ci-01 sets CLAUDE_CODE_ENABLE_TELEMETRY, so Arbor leaves it as the policy has it",
        );
        let none = MachineSetup::with_homes(&[(HomeAgent::Claude, "~/.claude")]);
        assert!(none.leave_to_policy("ci-01", ItemKind::Setting, &["cleanupPeriodDays"]).is_ok());
    }

    #[test]
    fn codex_config_gives_its_plugins_and_marketplaces() {
        let config = r#"model = "gpt-6"

[marketplaces.openai-bundled]
source_type = "local"
source = "/Users/cam/.codex/.tmp/bundled-marketplaces/openai-bundled"

[marketplaces.team]
source_type = "git"
source = "acme/codex-plugins"

[marketplaces.tools]
source_type = "git"
source = "https://github.com/acme/codex-tools.git"

[marketplaces.elsewhere]
source_type = "git"
source = "https://git.example.com/acme/x.git"

[plugins."chrome@openai-bundled"]
enabled = true

[plugins."sketch@team"]
enabled = false

[plugins."pdf@team"]
"#;
        let stdout = format!("H\t/Users/cam\nA\tcodex\t/Users/cam/.codex\n{}", data("config", "/Users/cam/.codex/config.toml", config));
        let scan = parse_scan(&stdout, SALT).unwrap();
        let home = &scan.homes[0];
        assert_eq!(names(home, ItemKind::Plugin), ["chrome@openai-bundled", "pdf@team", "sketch@team"]);
        assert_eq!(item(home, ItemKind::Plugin, "chrome@openai-bundled").enabled, Some(true));
        assert_eq!(item(home, ItemKind::Plugin, "sketch@team").enabled, Some(false));
        assert_eq!(item(home, ItemKind::Plugin, "pdf@team").enabled, Some(true), "on unless it says otherwise");
        assert_eq!(names(home, ItemKind::Marketplace), ["elsewhere", "openai-bundled", "team", "tools"]);
        // A repository Codex was given as owner/repo, which it saves as its https URL.
        assert_eq!(item(home, ItemKind::Marketplace, "tools").note.as_deref(), Some("acme/codex-tools"));
        assert_eq!(item(home, ItemKind::Marketplace, "elsewhere").note.as_deref(), Some("git.example.com/acme/x.git"));
        assert_eq!(item(home, ItemKind::Marketplace, "openai-bundled").note.as_deref(), Some("~/.codex/.tmp/bundled-marketplaces/openai-bundled"));
        assert_eq!(item(home, ItemKind::Marketplace, "team").note.as_deref(), Some("acme/codex-plugins"));
        // They're read as plugins and marketplaces, not settings.
        assert!(home.items.iter().all(|found| !(found.kind == ItemKind::Setting && (found.name.starts_with("plugins") || found.name.starts_with("marketplaces")))));
    }

    #[test]
    fn codex_config_gives_servers_hooks_and_settings_but_not_trusted_folders() {
        const SECRET: &str = "sk-NEVER-SHOWN-67890";
        let config = format!(
            r#"model = "gpt-5.5"
approval_policy = "on-request"
experimental_bearer_token = "{SECRET}"
notify = ["/Users/cam/.arbor/bin/arbor-agent-event", "codex", "--then", "say", "done"]

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
bearer_token_env_var = "LINEAR_TOKEN"

[mcp_servers.fs]
command = "npx"
args = ["-y", "fs-server", "--key={SECRET}"]
env = {{ API_KEY = "{SECRET}" }}

[model_providers.proxy]
base_url = "http://127.0.0.1:8317/v1"
env_key = "PROXY_KEY"

[profiles.fast]
model = "gpt-5.5-mini"

[projects."/Users/cam/src/app"]
trust_level = "trusted"

[tui]
notifications = true
"#
        );
        let hooks = r#"{"hooks":{"PreToolUse":[{"matcher":"shell","hooks":[{"type":"command","command":"guard.sh"}]}]}}"#;
        let stdout = format!(
            "H\t/Users/cam\nA\tcodex\t/Users/cam/.codex\n{}{}",
            data("config", "/Users/cam/.codex/config.toml", &config),
            data("hooks", "/Users/cam/.codex/hooks.json", hooks),
        );
        let scan = parse_scan(&stdout, SALT).unwrap();
        let home = &scan.homes[0];
        assert!(!serde_json::to_string(&scan.homes).unwrap().contains("NEVER-SHOWN"));
        assert_eq!(item(home, ItemKind::Setting, "model").value.as_deref(), Some("gpt-5.5"));
        assert_eq!(item(home, ItemKind::Setting, "approval_policy").value.as_deref(), Some("on-request"));
        assert_eq!(item(home, ItemKind::Setting, "experimental_bearer_token").value, None);
        assert_eq!(item(home, ItemKind::Setting, "tui.notifications").value.as_deref(), Some("true"));
        assert_eq!(item(home, ItemKind::Setting, "profiles").count, Some(1));
        assert!(item(home, ItemKind::Setting, "model_providers.proxy").value.is_none());
        assert!(home.items.iter().all(|item| !item.name.starts_with("projects")));
        assert_eq!(names(home, ItemKind::Mcp), ["fs", "linear"]);
        assert_eq!(names(home, ItemKind::Hook), ["PreToolUse"]);

        // With only the reporter as notify, there's no notify to compare.
        let reporter_only = "notify = [\"/home/a/.arbor/bin/arbor-agent-event\", \"codex\"]\n";
        let stdout = format!("H\t/home/a\nA\tcodex\t/home/a/.codex\n{}", data("config", "/home/a/.codex/config.toml", reporter_only));
        let scan = parse_scan(&stdout, SALT).unwrap();
        assert!(scan.homes[0].items.is_empty());
        let chained = fingerprint(&serde_json::json!(["say", "done"]), "/Users/cam", SALT);
        assert_eq!(item(home, ItemKind::Setting, "notify").sum.as_deref(), Some(chained.as_str()));
    }

    #[test]
    fn unreadable_settings_are_named_but_never_quoted() {
        let stdout = format!(
            "H\t/h\nA\tcodex\t/h/.codex\n{}J\tsettings\t/h/.codex/big.json\tlarge\n.\nJ\thooks\t/h/.codex/hooks.json\t999\nAAAA\n.\n",
            data("config", "/h/.codex/config.toml", "api_key = \"sk-QUOTED\"\nbroken = [\n"),
        );
        let scan = parse_scan(&stdout, SALT).unwrap();
        assert_eq!(
            scan.homes[0].problems,
            [
                "~/.codex/config.toml isn't TOML Arbor can read",
                "~/.codex/big.json is over 1 MB, so Arbor didn't read it",
                "~/.codex/hooks.json came back incomplete",
            ],
        );
        assert!(parse_scan("A\tclaude\t/h/.claude\n", SALT).is_err(), "a scan has to say where the home is");
    }

    #[test]
    fn files_come_back_whole_or_not_at_all() {
        let text = parse_text(&format!("T\t5\n{}\n", STANDARD.encode("hello"))).unwrap();
        assert_eq!(text, SetupText { content: Some("hello".into()), size: 5 });
        assert_eq!(parse_text("L\t400000\n").unwrap(), SetupText { content: None, size: 400_000 });
        assert!(parse_text(&format!("T\t9\n{}\n", STANDARD.encode("hello"))).is_err());
        let binary = parse_text(&format!("T\t2\n{}\n", STANDARD.encode([0xff, 0xfe]))).unwrap();
        assert_eq!(binary.content, None);

        let files = parse_skill(&format!(
            "C\tSKILL.md\taaa\t5\n{}\n.\nN\t.env\tbbb\t30\tsecret\nN\tassets/big.bin\tccc\t900000\tlarge\nC\tlogo.png\tddd\t2\n{}\n.\n",
            STANDARD.encode("hello"),
            STANDARD.encode([0x89, 0xff]),
        ))
        .unwrap();
        assert_eq!(files.iter().map(|file| (file.path.as_str(), file.hidden)).collect::<Vec<_>>(), [
            ("SKILL.md", None),
            (".env", Some(HiddenReason::Secret)),
            ("assets/big.bin", Some(HiddenReason::Large)),
            ("logo.png", Some(HiddenReason::Binary)),
        ]);
        assert_eq!(files[0].content.as_deref(), Some("hello"));
    }

    fn watched(kind: ItemKind, name: &str, sum: &str) -> SetupItem {
        let mut item = SetupItem::new(kind, name);
        item.sum = Some(sum.into());
        item
    }

    fn claude_home(items: Vec<SetupItem>, problems: &[&str]) -> SetupHome {
        SetupHome {
            problems: problems.iter().map(|problem| problem.to_string()).collect(),
            items,
            ..MachineSetup::with_homes(&[(HomeAgent::Claude, "~/.claude")]).homes.remove(0)
        }
    }

    fn changes(before: &[SetupHome], after: &[SetupHome]) -> Vec<(ItemKind, String, ChangeKind)> {
        watched_changes(&watched_homes(before, &[]), &watched_homes(after, &[]))
            .into_iter()
            .map(|change| (change.kind, change.name, change.change))
            .collect()
    }

    #[test]
    fn hooks_mcp_servers_marketplaces_and_plugins_coming_and_going_are_changes() {
        let before = vec![claude_home(
            vec![
                watched(ItemKind::Hook, "PreToolUse", "h1"),
                watched(ItemKind::Mcp, "github", "m1"),
                watched(ItemKind::Mcp, "linear", "m2"),
                watched(ItemKind::Marketplace, "team", "k1"),
                watched(ItemKind::Plugin, "pdf@team", "p1"),
                watched(ItemKind::Skill, "release", "s1"),
                watched(ItemKind::Setting, "model", "v1"),
            ],
            &[],
        )];
        let after = vec![claude_home(
            vec![
                watched(ItemKind::Hook, "PreToolUse", "h2"),
                watched(ItemKind::Hook, "Stop", "h3"),
                watched(ItemKind::Mcp, "github", "m1"),
                watched(ItemKind::Marketplace, "team", "k2"),
                // A plugin's new version isn't a change worth an alert; a new plugin is.
                watched(ItemKind::Plugin, "pdf@team", "p2"),
                watched(ItemKind::Plugin, "deploy@team", "p3"),
                watched(ItemKind::Skill, "release", "s2"),
                watched(ItemKind::Setting, "model", "v2"),
            ],
            &[],
        )];
        assert_eq!(
            changes(&before, &after),
            [
                (ItemKind::Hook, "PreToolUse".to_string(), ChangeKind::Changed),
                (ItemKind::Hook, "Stop".to_string(), ChangeKind::Added),
                (ItemKind::Plugin, "deploy@team".to_string(), ChangeKind::Added),
                (ItemKind::Marketplace, "team".to_string(), ChangeKind::Changed),
                (ItemKind::Mcp, "linear".to_string(), ChangeKind::Removed),
            ]
        );
        assert!(changes(&before, &before).is_empty());
        // A new home brings its servers; a home gone takes them.
        assert_eq!(changes(&[], &before).len(), 5);
        assert_eq!(changes(&before, &[]).iter().filter(|change| change.2 == ChangeKind::Removed).count(), 5);
    }

    #[test]
    fn a_file_that_could_not_be_read_is_not_everything_in_it_going_away() {
        let before = vec![claude_home(vec![watched(ItemKind::Mcp, "github", "m1")], &[])];
        let unreadable = vec![claude_home(vec![], &["~/.claude.json isn't JSON Arbor can read"])];
        assert!(changes(&before, &unreadable).is_empty());
        assert!(changes(&unreadable, &before).is_empty());
    }

    #[test]
    fn other_agents_servers_and_hooks_are_watched_too() {
        let pi = |items: Vec<SetupItem>, problems: &[&str]| HarnessHome {
            harness: Harness::Pi,
            path: "~/.pi/agent".into(),
            items,
            skills_link: None,
            problems: problems.iter().map(|problem| problem.to_string()).collect(),
        };
        let homes = [claude_home(vec![watched(ItemKind::Mcp, "github", "m1")], &[])];
        let before = [pi(vec![watched(ItemKind::Mcp, "linear", "l1")], &[])];
        let after = [pi(vec![watched(ItemKind::Mcp, "linear", "l2"), watched(ItemKind::Hook, "PreToolUse", "h1")], &[])];
        let found = watched_changes(&watched_homes(&homes, &before), &watched_homes(&homes, &after));
        assert_eq!(
            found.iter().map(|change| (change.home.as_str(), change.kind, change.name.as_str(), change.change)).collect::<Vec<_>>(),
            [("~/.pi/agent", ItemKind::Hook, "PreToolUse", ChangeKind::Added), ("~/.pi/agent", ItemKind::Mcp, "linear", ChangeKind::Changed)]
        );
        // Its MCP file going unreadable isn't its servers going away.
        let unreadable = [pi(vec![], &["~/.pi/agent/mcp.json isn't JSON Arbor can read"])];
        assert!(watched_changes(&watched_homes(&homes, &before), &watched_homes(&homes, &unreadable)).is_empty());
    }

    #[test]
    fn what_arbor_changed_itself_is_not_reported() {
        let scan = |sum: &str| Scan {
            home_dir: "/h".into(),
            homes: vec![claude_home(vec![watched(ItemKind::Mcp, "github", sum)], &[])],
            harness_homes: vec![],
            installs: vec![],
            harness_installs: vec![],
            policy: None,
        };
        let mut setup = MachineSetup::default();
        assert_eq!(
            record_scan(&mut setup, 100, 110, Ok(scan("m1"))),
            Recorded { harnesses_changed: true, ..Recorded::default() },
            "the first scan has nothing to compare with, and finds Claude Code"
        );
        assert_eq!(record_scan(&mut setup, 200, 210, Ok(scan("m2"))).changes.len(), 1);

        // Arbor writes at 300, after a scan started at 250: that scan may not have seen it, so it's quiet and runs again.
        setup.arbor_wrote_ms = Some(300);
        assert_eq!(record_scan(&mut setup, 250, 310, Ok(scan("m3"))), Recorded { again: true, ..Recorded::default() });
        assert_eq!(record_scan(&mut setup, 320, 330, Ok(scan("m3"))), Recorded::default());
        assert_eq!(setup.arbor_wrote_ms, None);
        // From then on, changes are someone else's.
        assert_eq!(record_scan(&mut setup, 400, 410, Ok(scan("m4"))).changes.len(), 1);
        // A failed scan changes nothing, and the next good one compares with the last good one.
        assert_eq!(record_scan(&mut setup, 500, 510, Err("Timed out after 60s".into())), Recorded::default());
        assert!(record_scan(&mut setup, 600, 610, Ok(scan("m4"))).changes.is_empty());
    }

    #[test]
    fn a_harness_counts_as_on_a_machine_from_its_home_or_its_command() {
        let mut setup = MachineSetup::default();
        let scan = |harness_homes: Vec<HarnessHome>, harness_installs: Vec<HarnessInstall>| Scan {
            home_dir: "/h".into(),
            homes: vec![claude_home(vec![], &[])],
            harness_homes,
            installs: vec![],
            harness_installs,
            policy: None,
        };
        let droid = HarnessInstall { harness: Harness::Droid, path: "~/.local/bin/droid".into(), real: None, version: None, update_command: None };
        let pi = HarnessHome { harness: Harness::Pi, path: "~/.pi/agent".into(), items: vec![], skills_link: None, problems: vec![] };
        assert!(record_scan(&mut setup, 1, 2, Ok(scan(vec![], vec![droid.clone()]))).harnesses_changed);
        assert_eq!(setup.harnesses(), BTreeSet::from([Harness::Claude, Harness::Droid]));
        assert!(!record_scan(&mut setup, 3, 4, Ok(scan(vec![], vec![droid]))).harnesses_changed, "the same harnesses again");
        assert!(record_scan(&mut setup, 5, 6, Ok(scan(vec![pi], vec![]))).harnesses_changed);
        assert_eq!(setup.harnesses(), BTreeSet::from([Harness::Claude, Harness::Pi]));
        // A failed scan keeps what the last good one found.
        assert!(!record_scan(&mut setup, 7, 8, Err("Timed out after 60s".into())).harnesses_changed);
        assert_eq!(setup.harnesses(), BTreeSet::from([Harness::Claude, Harness::Pi]));
    }

    fn host(name: &str) -> MachineHost {
        MachineHost { machine: name.into(), endpoint: name.into(), port: 22, enabled: true, source: String::new() }
    }

    #[test]
    fn stale_scans_skip_machines_scanned_lately_or_not_answering() {
        let state = MachineHealthState::default();
        apply_hosts(&state, vec![host("up"), host("down"), host("fresh")]);
        {
            let mut inner = state.lock();
            inner.local_names = vec!["this-mac".into()];
            for (name, series) in inner.series.iter_mut() {
                series.last_ok_at = Some(1_000);
                series.error = (name == "down").then(|| "ssh: connect refused".to_string());
                if name == "fresh" {
                    series.setup.scanned_at = Some(1_000);
                }
            }
        }
        let names = |targets: Vec<(Target, Machine)>| targets.into_iter().map(|(_, machine)| machine.name().to_string()).collect::<Vec<_>>();
        let now = 1_000 + FRESH_MS - 1;
        assert_eq!(names(take_targets(&state, None, true, now)), ["up", "this-mac"]);
        assert!(take_targets(&state, None, true, now).is_empty(), "one scan at a time");
        record(&state, &Target::Series("up".into()), &host("up"), now, now, Err("Timed out after 60s".into()));
        assert_eq!(names(take_targets(&state, Some("down"), false, now)), ["down"], "asking for a machine scans it");
        assert_eq!(names(take_targets(&state, Some("up"), false, now)), ["up"]);

        let found = Scan {
            home_dir: "/h".into(),
            homes: MachineSetup::with_homes(&[(HomeAgent::Claude, "~/.claude")]).homes,
            harness_homes: vec![],
            installs: vec![SetupInstall { agent: AgentKind::Claude, path: "~/.local/bin/claude".into(), real: None, version: Some("2.1.281".into()) }],
            harness_installs: vec![],
            policy: None,
        };
        record(&state, &Target::Series("up".into()), &host("up"), now, now, Ok(found));
        record(&state, &Target::Series("up".into()), &host("up"), now + 1, now + 1, Err("Timed out after 60s".into()));
        let inner = state.lock();
        let setup = &inner.series["up"].setup;
        assert_eq!((setup.homes.len(), setup.installs.len()), (1, 1), "a failed scan keeps what the last good one found");
        assert_eq!((setup.error.as_deref(), setup.scanning), (Some("Timed out after 60s"), false));
        assert_eq!(inventory(&inner).machines.iter().map(|machine| machine.machine.as_str()).collect::<Vec<_>>(), ["down", "fresh", "up", "this-mac"]);
    }

    /// A machine's scan as it would be saved: a Claude Code home whose settings hold secrets in every place they can.
    fn scan_with_secrets(secret: &str) -> Scan {
        let settings = format!(
            r#"{{ "model": "opus", "apiKeyHelper": "/Users/cam/bin/key --token {secret}", "env": {{ "ANTHROPIC_AUTH_TOKEN": "{secret}" }},
  "hooks": {{ "SessionStart": [{{ "hooks": [{{ "type": "command", "command": "bash /Users/cam/.agents/hooks/start.sh --token {secret}" }}] }}] }},
  "enabledPlugins": {{ "paper@paper": true }} }}"#
        );
        let mcp = format!(r#"{{ "linear": {{ "type": "http", "url": "https://mcp.linear.app/mcp", "headers": {{ "Authorization": "Bearer {secret}" }} }} }}"#);
        let stdout = format!(
            "H\t/Users/cam\nA\tclaude\t/Users/cam/.claude\n{}{}",
            data("settings", "/Users/cam/.claude/settings.json", &settings),
            data("mcp", "/Users/cam/.claude.json", &mcp),
        );
        parse_scan(&stdout, SALT).unwrap()
    }

    #[test]
    fn a_kept_scan_holds_names_paths_and_fingerprints_and_never_a_secret() {
        const SECRET: &str = "sk-KEPT-NEVER-12345";
        let mut setup = MachineSetup::default();
        let recorded = record_scan(&mut setup, 1, 2, Ok(scan_with_secrets(SECRET)));
        assert!(recorded.changes.is_empty());
        assert!(!setup.homes[0].repo_hooks.is_empty(), "the hook running a repo script is kept, by fingerprint");
        let path = std::env::temp_dir().join(format!("arbor-setup-scans-{}-secret.json", std::process::id()));
        write_saved_scans(&path, vec![SavedSetup::of("cam-mbp", Some(("cam-mbp".into(), 22)), &setup)], SALT).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let _ = fs::remove_file(&path);
        assert!(!text.contains("NEVER"), "a kept scan never holds a secret: {text}");
        assert!(!text.contains("Bearer") && !text.contains("--token"), "nor a command line or header");
        assert!(text.contains("~/.claude") && text.contains("linear"), "only names and paths, as the window sees them");
    }

    #[test]
    fn a_kept_scan_comes_back_whole_with_its_salt_and_never_over_a_newer_one() {
        let path = std::env::temp_dir().join(format!("arbor-setup-scans-{}-whole.json", std::process::id()));
        let mut setup = MachineSetup::default();
        record_scan(&mut setup, 1, 2, Ok(scan_with_secrets("x")));
        setup.scanning = true;
        let saved = SavedSetup::of("cam-mbp", Some(("cam-mbp.local".into(), 22)), &setup);
        write_saved_scans(&path, vec![saved.clone()], b"0123456789abcdef").unwrap();
        let (salt, machines) = read_saved_scans(&path).unwrap();
        assert_eq!(&salt, b"0123456789abcdef");
        let [read] = <[SavedSetup; 1]>::try_from(machines).unwrap();
        assert_eq!((read.machine.as_str(), read.endpoint.clone()), ("cam-mbp", saved.endpoint.clone()));
        let back = read.into_setup();
        assert_eq!(back, MachineSetup { scanning: false, ..setup.clone() }, "the home folder and repo hooks come back too; a scan under way doesn't");
        assert_eq!(back.scanned_at, Some(2), "it keeps when it was scanned, so it's still seen as stale in time");

        let other_version = fs::read_to_string(&path).unwrap().replacen("\"version\":1", "\"version\":0", 1);
        fs::write(&path, other_version).unwrap();
        assert!(read_saved_scans(&path).is_none());
        fs::write(&path, "{").unwrap();
        assert!(read_saved_scans(&path).is_none());
        let _ = fs::remove_file(&path);

        // Kept for a machine not listed yet, it waits; listed the same way, it takes it up; reached elsewhere, it doesn't.
        let state = MachineHealthState::default();
        restore_into(&mut state.lock(), saved.clone());
        let elsewhere = MachineHost { endpoint: "10.0.0.9".into(), ..host("cam-mbp") };
        assert!(take_restored(&mut state.lock().restored_setups, &elsewhere).is_none());
        apply_hosts(&state, vec![MachineHost { endpoint: "cam-mbp.local".into(), ..host("cam-mbp") }]);
        assert_eq!(state.lock().series["cam-mbp"].setup.scanned_at, Some(2));
        assert!(state.lock().restored_setups.is_empty());
        // A scan that's landed since wins.
        state.lock().series.get_mut("cam-mbp").unwrap().setup.scanned_at = Some(9);
        restore_into(&mut state.lock(), saved);
        assert_eq!(state.lock().series["cam-mbp"].setup.scanned_at, Some(9));
    }

    #[test]
    fn a_kept_scan_is_the_baseline_for_change_alerts_after_a_restart() {
        let mut before = MachineSetup::default();
        record_scan(&mut before, 1, 2, Ok(scan_with_secrets("x")));
        let mut setup = SavedSetup::of("cam-mbp", None, &before).into_setup();
        assert!(record_scan(&mut setup, 3, 4, Ok(scan_with_secrets("x"))).changes.is_empty(), "the same setup isn't a change");
        let changes = record_scan(&mut setup, 5, 6, Ok(scan_with_secrets("y"))).changes;
        assert_eq!(changes.iter().map(|change| (change.kind, change.name.as_str(), change.change)).collect::<Vec<_>>(), [
            (ItemKind::Mcp, "linear", ChangeKind::Changed),
        ]);
    }

    #[cfg(unix)]
    mod scripts {
        use super::*;
        use std::os::unix::fs::symlink;

        fn temp_home(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let home = std::env::temp_dir().join(format!("arbor-setup-{name}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&home).unwrap();
            // The temp folder can sit behind a link (/var → /private/var); the script sees the real path.
            fs::canonicalize(&home).unwrap()
        }

        fn write(path: &Path, content: &str) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        fn run(home: &Path, script: &str) -> std::process::Output {
            run_in("sh", home, script)
        }

        fn run_in(shell: &str, home: &Path, script: &str) -> std::process::Output {
            let mut command = tokio::process::Command::new(shell);
            command
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(run_script(command, script, Duration::from_secs(30)))
                .unwrap()
        }

        /// Read here and dropped: only its fingerprint is kept.
        const SECRET: &str = "NEVER-SHOWN-OR-KEPT";
        /// Never leaves the machine at all.
        const PRIVATE: &str = "NEVER-LEAVES-THE-MACHINE";

        /// The settings files a scan sent back, decoded.
        fn payloads(stdout: &str) -> Vec<String> {
            let mut found = Vec::new();
            let mut lines = stdout.lines();
            while let Some(line) = lines.next() {
                if line.starts_with("J\t") {
                    let encoded: String = lines.by_ref().take_while(|line| *line != ".").map(str::trim).collect();
                    found.push(String::from_utf8_lossy(&STANDARD.decode(encoded).unwrap_or_default()).into_owned());
                }
            }
            found
        }

        #[test]
        fn the_scan_reads_a_home_and_nothing_it_shouldnt() {
            let home = temp_home("scan");
            let claude = home.join(".claude");
            let instructions = "# Me\n@~/notes/style.md\nSee @missing.md and `@not/an/import.md`.\n```\n@also/not.md\n```\nmail me at me@example.com\n";
            write(&claude.join("CLAUDE.md"), instructions);
            write(&home.join("notes/style.md"), "Be brief. @more.md\n");
            write(&home.join("notes/more.md"), "More.\n");
            write(&claude.join("rules/web/react.md"), "Use hooks.\n");
            write(&claude.join("agents/reviewer.md"), "---\nname: reviewer\n---\n");
            write(&claude.join("commands/git/ship.md"), "Ship it.\n");
            symlink(home.join("dotfiles/gone.md"), claude.join("commands/old.md")).unwrap();
            write(&home.join(".agents/skills/pdf/SKILL.md"), "---\nname: pdf\ndescription: Read and write PDFs.\n---\nBody\n");
            write(&home.join(".agents/skills/pdf/scripts/fill.py"), "print('hi')\n");
            write(&home.join(".agents/skills/pdf/node_modules/dep/index.js"), "ignored\n");
            write(
                &home.join(".agents/skills/long/SKILL.md"),
                "---\nname: \"long-one\"\ndescription: >\n  First line\n  second line\nwhen_to_use: When asked\n  twice\ndisable-model-invocation: true\nmetadata:\n  description: not this one\n---\ndescription: nor this\n",
            );
            fs::create_dir_all(claude.join("skills")).unwrap();
            symlink("../../.agents/skills/pdf", claude.join("skills/pdf")).unwrap();
            symlink(home.join(".agents/skills"), claude.join("skills/all")).unwrap();
            symlink(home.join("gone"), claude.join("skills/broken")).unwrap();
            write(&home.join(".agents/.skill-lock.json"), r#"{"version":3,"skills":{"pdf":{"source":"anthropics/skills","sourceType":"github"}}}"#);
            write(
                &claude.join("settings.json"),
                &format!(r#"{{ "model": "opus", "env": {{ "ANTHROPIC_AUTH_TOKEN": "{SECRET}" }} }}"#),
            );
            // History, a project's servers and the account in .claude.json never leave the machine:
            // the braces, escaped quote and "mcpServers" in the history mustn't fool the reader.
            write(
                &home.join(".claude.json"),
                &format!(
                    "{{\n  \"numStartups\": 3,\n  \"projects\": {{\n    \"/src/app\": {{\n      \"history\": [{{ \"display\": \"{PRIVATE} {{ }} \\\" mcpServers\" }}],\n      \"mcpServers\": {{ \"project-only\": {{ \"command\": \"x\" }} }}\n    }}\n  }},\n  \"mcpServers\": {{\n    \"linear\": {{ \"type\": \"http\", \"url\": \"https://mcp.linear.app/mcp\", \"headers\": {{ \"Authorization\": \"Bearer {SECRET}\" }} }}\n  }},\n  \"oauthAccount\": {{ \"emailAddress\": \"{PRIVATE}\" }}\n}}\n"
                ),
            );
            let codex = home.join(".codex");
            write(&codex.join("AGENTS.md"), "Codex rules.\n");
            write(&codex.join("rules/default.rules"), "prefix_rule(pattern = [\"git\"])\n");
            write(&codex.join("config.toml"), &format!("model = \"gpt-5.5\"\n\n[mcp_servers.fs]\ncommand = \"npx\"\nenv = {{ KEY = \"{SECRET}\" }}\n"));
            write(&codex.join("fast.config.toml"), "model = \"mini\"\n");
            write(&codex.join("auth.json"), &format!("{{ \"token\": \"{PRIVATE}\" }}"));
            symlink("../.agents/skills", codex.join("skills")).unwrap();
            // Another harness's home: its instructions and own skills are read, and its settings never are.
            let pi = home.join(".pi/agent");
            write(&pi.join("AGENTS.md"), "Pi rules.\n");
            write(&pi.join("skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: Ship it.\n---\n");
            write(&pi.join("settings.json"), &format!("{{ \"apiKey\": \"{SECRET}\" }}"));
            // Their MCP servers and hooks give names, how each is reached and fingerprints, never their secrets.
            write(&pi.join("mcp.json"), &format!(r#"{{ "mcpServers": {{ "github": {{ "command": "npx", "args": ["-y", "gh"], "env": {{ "TOKEN": "{SECRET}" }} }} }} }}"#));
            let droid = home.join(".factory");
            write(&droid.join("AGENTS.md"), "Droid rules.\n");
            write(&droid.join("mcp.json"), r#"{ "mcpServers": { "linear": { "type": "http", "url": "https://mcp.linear.app/mcp", "disabled": true } } }"#);
            write(&droid.join("hooks.json"), &format!(r#"{{ "PreToolUse": [{{ "matcher": "Execute", "hooks": [{{ "type": "command", "command": "echo {SECRET}" }}] }}] }}"#));
            write(
                &home.join(".config/opencode/opencode.json"),
                &format!(r#"{{ "theme": "dark", "mcp": {{ "fs": {{ "type": "local", "command": ["npx", "fs"], "environment": {{ "KEY": "{SECRET}" }} }} }} }}"#),
            );
            // Stand-ins for the agents, so the test never runs the real ones.
            let program = |path: PathBuf, prints: &str, mode: u32| {
                write(&path, &format!("#!/bin/sh\necho '{prints}'\n"));
                fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(mode)).unwrap();
            };
            program(home.join("bin-a/claude"), "2.1.281 (Claude Code)", 0o755);
            program(home.join("bin-a/codex"), "codex-cli 9.9.9", 0o644);
            fs::create_dir_all(home.join("bin-b")).unwrap();
            symlink(home.join("bin-a/claude"), home.join("bin-b/claude")).unwrap();
            program(home.join("bin-c/claude"), "2.1.270 (Claude Code)", 0o755);
            program(home.join("bin-c/codex"), "codex-cli 0.156.1", 0o755);
            program(home.join("bin-a/pi"), "0.70.2", 0o755);
            // Amp prints its version for `amp version`, and only that is asked.
            write(&home.join("bin-c/amp"), "#!/bin/sh\n[ \"$1\" = version ] && echo '0.0.1751 (released 2026-09-30)'\n");
            fs::set_permissions(home.join("bin-c/amp"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();

            for shell in shells() {
                check_scan(shell, &home, instructions);
            }
            let _ = fs::remove_dir_all(&home);
        }

        fn check_scan(shell: &str, home: &Path, instructions: &str) {
            let script = scan_script_with("", "policy=\"$HOME/no policy/managed-settings.json\"\n", "emit_installs \"$HOME/bin-a:bin-a:$HOME/bin-b:$HOME/bin-c:$HOME/bin-a\"\n");
            let output = run_in(shell, home, &script);
            assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
            let stdout = String::from_utf8_lossy(&output.stdout);
            let sent = payloads(&stdout);
            assert_eq!(sent.len(), 8, "settings.json, .claude.json's servers, config.toml, the skill lock, and Pi's, Droid's and OpenCode's MCP files and Droid's hooks");
            for payload in &sent {
                assert!(!payload.contains(PRIVATE) && !payload.contains("oauthAccount") && !payload.contains("project-only"), "{payload}");
            }
            assert!(!stdout.contains(PRIVATE));
            let scan = parse_scan(&stdout, SALT).unwrap();
            let shown = serde_json::to_string(&scan.homes).unwrap();
            assert!(!shown.contains(SECRET), "{shown}");
            let harness_homes = serde_json::to_string(&scan.harness_homes).unwrap();
            assert!(!harness_homes.contains(SECRET) && !harness_homes.contains("Pi rules"), "{harness_homes}");
            let read: Vec<_> = scan
                .harness_homes
                .iter()
                .map(|found| (found.harness, found.path.as_str(), found.items.iter().map(|item| (item.kind, item.name.as_str())).collect::<Vec<_>>()))
                .collect();
            assert_eq!(read, [
                (Harness::Pi, "~/.pi/agent", vec![(ItemKind::Instructions, "AGENTS.md"), (ItemKind::Skill, "deploy"), (ItemKind::Mcp, "github")]),
                (Harness::OpenCode, "~/.config/opencode", vec![(ItemKind::Mcp, "fs")]),
                (Harness::Droid, "~/.factory", vec![(ItemKind::Instructions, "AGENTS.md"), (ItemKind::Hook, "PreToolUse"), (ItemKind::Mcp, "linear")]),
            ], "{shell}");
            let server = |harness: Harness, name: &str| {
                let found = scan.harness_homes.iter().find(|found| found.harness == harness).unwrap();
                let item = found.items.iter().find(|item| item.kind == ItemKind::Mcp && item.name == name).unwrap();
                (item.value.clone(), item.note.clone(), item.enabled)
            };
            assert_eq!(server(Harness::Pi, "github"), (Some("stdio".into()), Some("npx".into()), None));
            assert_eq!(server(Harness::OpenCode, "fs"), (Some("stdio".into()), Some("npx".into()), None), "OpenCode's own words and command list");
            assert_eq!(server(Harness::Droid, "linear"), (Some("http".into()), Some("mcp.linear.app".into()), Some(false)));
            let installs: Vec<_> = scan.harness_installs.iter().map(|install| (install.harness, install.path.as_str(), install.version.as_deref())).collect();
            assert_eq!(installs, [(Harness::Pi, "~/bin-a/pi", Some("0.70.2")), (Harness::Amp, "~/bin-c/amp", Some("0.0.1751"))], "{shell}");
            assert!(scan.homes.iter().all(|found| !found.path.starts_with("~/.pi") && found.path != "~/.factory"));

            let claude = scan.homes.iter().find(|found| found.path == "~/.claude").unwrap();
            assert_eq!(item(claude, ItemKind::Instructions, "CLAUDE.md").size, Some(instructions.len() as u64));
            assert_eq!(names(claude, ItemKind::Import), ["~/.claude/missing.md", "~/notes/more.md", "~/notes/style.md"]);
            assert_eq!(item(claude, ItemKind::Import, "~/notes/more.md").import.as_ref().map(|facts| facts.level), Some(2));
            assert_eq!(item(claude, ItemKind::Import, "~/.claude/missing.md").sum, None);
            assert_eq!(names(claude, ItemKind::Rule), ["web/react.md"]);
            assert_eq!(names(claude, ItemKind::Subagent), ["reviewer"]);
            assert_eq!(names(claude, ItemKind::Command), ["git:ship", "old"]);
            let old = item(claude, ItemKind::Command, "old");
            assert_eq!((old.sum.as_deref(), old.link.as_deref(), old.text), (None, Some("~/dotfiles/gone.md"), false), "a link to nothing shows");
            assert_eq!(names(claude, ItemKind::Skill), ["all", "broken", "pdf"]);
            let linked = item(claude, ItemKind::Skill, "pdf");
            assert_eq!(linked.link.as_deref(), Some("~/.agents/skills/pdf"));
            assert_eq!(linked.skill.as_ref().map(|skill| (skill.files, skill.declared_name.as_deref())), Some((2, Some("pdf"))));
            assert_eq!(item(claude, ItemKind::Skill, "all").skill.as_ref().map(|skill| skill.has_doc), Some(false), "{shell}");
            let broken = item(claude, ItemKind::Skill, "broken");
            assert_eq!((broken.sum.as_deref(), broken.skill.as_ref()), (None, None), "{shell}: a link to nothing");
            assert_eq!(item(claude, ItemKind::Setting, "model").value.as_deref(), Some("opus"));
            assert_eq!(names(claude, ItemKind::Env), ["ANTHROPIC_AUTH_TOKEN"]);
            assert_eq!(names(claude, ItemKind::Mcp), ["linear"]);

            let shared = scan.homes.iter().find(|found| found.path == "~/.agents").unwrap();
            let pdf = item(shared, ItemKind::Skill, "pdf");
            assert_eq!(pdf.sum, linked.sum, "a linked skill has the fingerprint of the one it links to");
            assert_eq!(pdf.skill.as_ref().and_then(|skill| skill.source.as_deref()), Some("anthropics/skills"));
            let long = item(shared, ItemKind::Skill, "long");
            assert_eq!(
                long.skill.as_ref().map(|skill| (skill.declared_name.as_deref(), skill.description_chars, skill.when_to_use_chars, skill.manual_only)),
                Some((Some("long-one"), 22, 16, true)),
                "{shell}",
            );
            assert_eq!(pdf.skill.as_ref().map(|skill| (skill.description_chars, skill.when_to_use_chars, skill.manual_only)), Some((20, 0, false)), "{shell}");

            let codex = scan.homes.iter().find(|found| found.path == "~/.codex").unwrap();
            assert_eq!(names(codex, ItemKind::Instructions), ["AGENTS.md"]);
            assert_eq!(names(codex, ItemKind::Rule), ["default.rules"]);
            assert_eq!(names(codex, ItemKind::Profile), ["fast"]);
            assert_eq!(names(codex, ItemKind::Mcp), ["fs"]);
            assert_eq!(codex.skills_link.as_deref(), Some("~/.agents/skills"), "{shell}");
            assert_eq!(names(codex, ItemKind::Skill), ["long", "pdf"], "{shell}: the store's, through the link");
            assert_eq!(claude.skills_link, None);

            let installs: Vec<_> = scan.installs.iter().map(|install| (install.agent, install.path.as_str(), install.version.as_deref())).collect();
            assert_eq!(installs, [
                (AgentKind::Claude, "~/bin-a/claude", Some("2.1.281")),
                (AgentKind::Claude, "~/bin-c/claude", Some("2.1.270")),
                (AgentKind::Codex, "~/bin-c/codex", Some("0.156.1")),
            ], "{shell}: a link to one already found, a file that can't run and a relative directory are passed over");
            assert!(scan.installs.iter().all(|install| install.real.is_none()), "{shell}");
            assert_eq!(scan.policy, None, "{shell}: no policy file, no policy");
        }

        #[test]
        fn a_shadow_home_is_read_as_sharing_the_codex_home_it_links_to() {
            let home = temp_home("shadow");
            let codex = home.join(".codex");
            write(&codex.join("AGENTS.md"), "Codex rules.\n");
            write(&codex.join("config.toml"), "model = \"gpt-5.5\"\n");
            write(&codex.join("skills/pdf/SKILL.md"), "---\nname: pdf\ndescription: PDFs.\n---\n");
            fs::create_dir_all(codex.join("sessions")).unwrap();
            // As an agent app builds one: a link for each entry, and its own sign-in and scratch folders.
            agent_homes::tests::save_on_this_thread(vec![
                agent_homes::tests::home("", agent_homes::AgentHomeKind::Claude, "~/.agent-app/homes/*", true, true),
                agent_homes::tests::home("", agent_homes::AgentHomeKind::Codex, "~/.agent-app/homes/*", true, true),
            ]);
            let shadow = home.join(".agent-app/homes/codex-other");
            fs::create_dir_all(&shadow).unwrap();
            for entry in ["AGENTS.md", "config.toml", "skills", "sessions"] {
                symlink(codex.join(entry), shadow.join(entry)).unwrap();
            }
            write(&shadow.join("auth.json"), &format!("{{ \"token\": \"{PRIVATE}\" }}"));
            fs::create_dir_all(shadow.join("tmp")).unwrap();
            for shell in shells() {
                let output = run_in(shell, &home, &scan_script_with("", "policy=\"$HOME/no policy\"\n", ""));
                assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
                let stdout = String::from_utf8_lossy(&output.stdout);
                assert!(!stdout.contains(PRIVATE), "{shell}");
                let scan = parse_scan(&stdout, SALT).unwrap();
                let main = scan.homes.iter().find(|found| found.path == "~/.codex").unwrap();
                assert_eq!((names(main, ItemKind::Instructions), names(main, ItemKind::Skill)), (vec!["AGENTS.md"], vec!["pdf"]), "{shell}");
                let shadow = scan.homes.iter().find(|found| found.path == "~/.agent-app/homes/codex-other").unwrap();
                let shared = shadow.shares.as_ref().unwrap();
                assert_eq!((shared.home.as_str(), shared.entries.as_slice()), ("~/.codex", &["AGENTS.md".to_string(), "config.toml".into(), "sessions".into(), "skills".into()][..]), "{shell}");
                assert!(shadow.items.is_empty() && shadow.problems.is_empty(), "{shell}: {:?}", shadow.items);
                assert_eq!(shadow.skills_link.as_deref(), Some("~/.codex/skills"), "{shell}");
            }
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn a_policy_is_read_for_its_names_and_never_its_values() {
            let home = temp_home("policy");
            let file = home.join("Application Support/ClaudeCode/managed-settings.json");
            write(
                &file,
                &format!(
                    r#"{{ "model": "{PRIVATE}", "env": {{ "OTEL_EXPORTER_OTLP_METRICS_HEADERS": "Authorization=Bearer {SECRET}" }}, "permissions": {{ "deny": ["Bash(curl:*)"] }}, "skillOverrides": {{ "pdf": "off" }} }}"#
                ),
            );
            write(&home.join(".claude/settings.json"), r#"{ "skillOverrides": { "pdf": "on", "web": "name-only" } }"#);
            agent_homes::tests::save_on_this_thread(vec![
                agent_homes::tests::home("", agent_homes::AgentHomeKind::Claude, "~/.agent-app/homes/*", true, true),
                agent_homes::tests::home("", agent_homes::AgentHomeKind::Codex, "~/.agent-app/homes/*", true, true),
            ]);
            write(&home.join(".agent-app/homes/claude-other/.claude.json"), "{}");
            let policy = "policy=\"$HOME/Application Support/ClaudeCode/managed-settings.json\"\n";
            for shell in shells() {
                let output = run_in(shell, &home, &scan_script_with("", policy, ""));
                assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
                let scan = parse_scan(&String::from_utf8_lossy(&output.stdout), SALT).unwrap();
                let found = scan.policy.as_ref().unwrap();
                assert_eq!(found.file, file.to_string_lossy(), "{shell}");
                let keys: Vec<(ItemKind, &str)> = found.keys.iter().map(|key| (key.kind, key.name.as_str())).collect();
                assert_eq!(keys, [(ItemKind::Setting, "model"), (ItemKind::Setting, "permissions.deny"), (ItemKind::Env, "OTEL_EXPORTER_OTLP_METRICS_HEADERS")], "{shell}");
                let shown = serde_json::to_string(&(&scan.policy, &scan.homes)).unwrap();
                assert!(!shown.contains(SECRET) && !shown.contains(PRIVATE) && !shown.contains("curl"), "{shell}: {shown}");
                // The policy's override wins over the home's own, in every Claude Code home.
                for path in ["~/.claude", "~/.agent-app/homes/claude-other"] {
                    let claude = scan.homes.iter().find(|found| found.path == path).unwrap();
                    let overrides: Vec<_> = claude.skill_overrides.iter().map(|entry| (entry.name.as_str(), entry.state, entry.source)).collect();
                    let mut expected = vec![("pdf", OverrideState::Off, OverrideSource::Policy)];
                    if path == "~/.claude" {
                        expected.push(("web", OverrideState::NameOnly, OverrideSource::Settings));
                    }
                    assert_eq!(overrides, expected, "{shell}: {path}");
                }
            }

            // One the user the scan runs as can't read is named, and nothing more is said about it.
            fs::set_permissions(&file, std::os::unix::fs::PermissionsExt::from_mode(0o000)).unwrap();
            if fs::read(&file).is_err() {
                for shell in shells() {
                    let output = run_in(shell, &home, &scan_script_with("", policy, ""));
                    let scan = parse_scan(&String::from_utf8_lossy(&output.stdout), SALT).unwrap();
                    let found = scan.policy.unwrap();
                    assert!(found.problem.as_deref().is_some_and(|problem| problem.contains("can't read it")), "{shell}: {found:?}");
                    assert!(found.keys.is_empty());
                }
            }
            let _ = fs::set_permissions(&file, std::os::unix::fs::PermissionsExt::from_mode(0o644));
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn the_scan_the_app_sends_is_valid_sh() {
            for shell in shells() {
                let mut command = tokio::process::Command::new(shell);
                command.arg("-n").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
                let output = tokio::runtime::Runtime::new()
                    .unwrap()
                    .block_on(run_script(command, &scan_script(""), Duration::from_secs(30)))
                    .unwrap();
                assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
            }
        }

        #[test]
        fn a_skill_reads_back_file_by_file_without_its_secrets() {
            let home = temp_home("skill");
            let skill = home.join(".agents/skills/pdf");
            write(&skill.join("SKILL.md"), "---\nname: pdf\n---\nBody\n");
            write(&skill.join(".env"), &format!("KEY={SECRET}\n"));
            write(&skill.join("scripts/fill.py"), "print('hi')\n");
            let script =
                format!("set -u\nexport LC_ALL=C\n{}{HELPERS}d={}\n{READ_SKILL_SCRIPT}", agent_homes::helpers(), shell_quote(&skill.display().to_string()));
            let output = run(&home, &script);
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(!stdout.contains(&STANDARD.encode(format!("KEY={SECRET}\n"))));
            let files = parse_skill(&stdout).unwrap();
            assert_eq!(files.iter().map(|file| (file.path.as_str(), file.hidden)).collect::<Vec<_>>(), [
                (".env", Some(HiddenReason::Secret)),
                ("SKILL.md", None),
                ("scripts/fill.py", None),
            ]);
            assert_eq!(files[2].content.as_deref(), Some("print('hi')\n"));

            let text = run(&home, &format!("set -u\nf={}\n{READ_TEXT_SCRIPT}", shell_quote(&skill.join("SKILL.md").display().to_string())));
            assert_eq!(parse_text(&String::from_utf8_lossy(&text.stdout)).unwrap().content.as_deref(), Some("---\nname: pdf\n---\nBody\n"));
            let _ = fs::remove_dir_all(&home);
        }
    }
}

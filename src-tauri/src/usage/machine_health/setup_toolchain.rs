//! The tools on each machine and what each project asks of them, for the Toolchain tab on Setup:
//! the version of Node, Python, Rust, Go and the rest a shell there finds first, the other
//! versions its version managers keep, and for every repo sessions have worked in there, the
//! versions its files ask for (`engines`, `.nvmrc`, `rust-toolchain.toml`, `go.mod` and so on) and
//! the version of each package.json dependency installed in its `node_modules`.
//!
//! A scan only reads. Every version check runs with stdin closed, a time limit, and the switches
//! that stop version managers from installing or downloading what's missing (rustup, mise,
//! corepack, Go's toolchain switching). The repos come from the sessions Arbor knows about, as on
//! the Projects tab. Project files are read only when they're small and inside the checkout, and
//! only the fields the page shows are kept: versions asked for, dependency names and ranges.
//! Nothing else in them (scripts, config) leaves the parser. Scans are kept in memory.

use super::agents::AGENT_ENV;
use super::tool_updates::{prove_owner, OwnerFacts, ToolOwner, ToolUpdates};
use ts_rs::TS;
use super::setup::covered_machine;
use super::shell::shell_quote;
use super::setup_projects::{is_path, load_checkouts, normalize_remote, INSIDE_REPO, ORIGIN_URL};
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};

pub(crate) const SETUP_TOOLCHAIN_UPDATED_EVENT: &str = "setup-toolchain-updated";

/// How long a scan keeps reading repos before it stops where it is and says so, in seconds.
const SCAN_BUDGET_S: u32 = 150;
const SCAN_TIMEOUT: Duration = Duration::from_secs(300);
const PACKAGES_BUDGET_S: u32 = 90;
const PACKAGES_TIMEOUT: Duration = Duration::from_secs(150);
/// How long one `--version` gets before it's stopped.
const PROBE_S: u32 = 8;
/// The biggest project file Arbor reads.
const FILE_BYTES: usize = 64 * 1024;
/// Manifests read from folders one level down, per repo.
const MOST_NESTED: usize = 12;
/// Dependencies kept from one package.json; the rest are counted.
const MOST_LIBRARIES: usize = 200;
/// Installed versions looked up in one scan.
const MOST_LOOKUPS: usize = 8_000;
const TEXT_CHARS: usize = 100;
const NAME_CHARS: usize = 214;

/// The tools looked for on each machine: the name the page knows each by, and how to ask its version.
const TOOLS: [(&str, &str); 16] = [
    ("node", "node --version"),
    ("npm", "npm --version"),
    ("pnpm", "pnpm --version"),
    ("yarn", "yarn --version"),
    ("bun", "bun --version"),
    ("deno", "deno --version"),
    ("python", "python3 --version"),
    ("uv", "uv --version"),
    ("go", "go version"),
    ("rust", "rustc --version"),
    ("cargo", "cargo --version"),
    ("git", "git --version"),
    ("gh", "gh --version"),
    ("jq", "jq --version"),
    ("rg", "rg --version"),
    ("docker", "docker --version"),
];

/// Lockfiles, and the tool each says a project is installed with.
const LOCKFILES: [(&str, &str); 6] = [
    ("bun.lock", "bun"),
    ("bun.lockb", "bun"),
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("package-lock.json", "npm"),
    ("uv.lock", "uv"),
];

/// A tool a shell on the machine finds.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolFound {
    tool: String,
    path: String,
    /// None when it didn't answer, or didn't say a version.
    version: Option<String>,
    /// The installer that put it there, when Arbor can prove it.
    owner: Option<ToolOwner>,
}

impl ToolFound {
    pub(super) fn tool(&self) -> &str {
        &self.tool
    }

    pub(super) fn path(&self) -> &str {
        &self.path
    }

    pub(super) fn version(&self) -> Option<&str> {
        self.version.as_deref()
    }

    pub(super) fn owner(&self) -> Option<&ToolOwner> {
        self.owner.as_ref()
    }

    #[cfg(test)]
    pub(super) fn for_test(tool: &str, path: &str, version: Option<&str>, owner: Option<ToolOwner>) -> Self {
        Self { tool: tool.into(), path: path.into(), version: version.map(str::to_string), owner }
    }
}

/// A version a version manager keeps, which a project that pins it gets.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeptVersion {
    tool: String,
    /// nvm, fnm, volta, mise, asdf, pyenv, uv, rustup, sdk, toolchain, corepack or brew.
    manager: String,
    version: String,
    /// A rustup toolchain's channel, like `stable` or `nightly-2026-09-01`.
    label: Option<String>,
}

/// How a project says which version it wants.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NeedKind {
    /// An npm range, like `engines` in package.json, or anything when it's empty.
    Range,
    /// A version a version manager or corepack picks, like `.nvmrc`; `22` means any 22.x.
    Pin,
    /// The oldest version that works, like `rust-version` or `go.mod`'s `go` line.
    Min,
    /// A Python version specifier, like `requires-python`.
    Python,
}

/// A version of a tool one of a project's files asks for.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolNeed {
    tool: String,
    /// As the file writes it; empty when a lockfile only says the tool is used.
    wants: String,
    kind: NeedKind,
    /// The file, from the top of the checkout.
    file: String,
    /// Where in the file, like `engines.node`.
    field: Option<String>,
}

/// A dependency in one of a project's package.json files.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectLibrary {
    /// The folder the package.json is in, from the top of the checkout; empty for the top.
    dir: String,
    name: String,
    wants: String,
    dev: bool,
    /// The version in `node_modules`; None when it isn't installed or wasn't looked up.
    installed: Option<String>,
    /// Whether the packages script looked it up, so None means it isn't installed.
    checked: bool,
}

/// A folder with a package.json.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageDir {
    dir: String,
    lockfile: Option<String>,
    /// Whether it (or the top of the checkout) has a `node_modules`; None when it wasn't looked at.
    modules: Option<bool>,
}

/// What one repo on the machine asks for.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectToolchain {
    /// The main checkout.
    path: String,
    /// The folder isn't there any more.
    missing: bool,
    remote: Option<String>,
    last_used_ms: Option<i64>,
    needs: Vec<ToolNeed>,
    libraries: Vec<ProjectLibrary>,
    /// Dependencies past the ones kept.
    libraries_more: u32,
    packages: Vec<PackageDir>,
    /// Files Arbor found but couldn't read: too big, or not what their name says.
    unread: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineToolchain {
    machine: String,
    home_dir: String,
    /// From `uname`, like `Darwin` and `arm64`.
    os: String,
    arch: String,
    scanned_at: Option<i64>,
    /// The scan ran out of time before it reached every repo.
    partial: bool,
    scanning: bool,
    error: Option<String>,
    tools: Vec<ToolFound>,
    kept: Vec<KeptVersion>,
    projects: Vec<ProjectToolchain>,
    /// What proves who installed each tool, kept for the update check.
    #[serde(skip)]
    #[ts(skip)]
    facts: OwnerFacts,
    /// Asking the installers what's newer.
    checking: bool,
    /// What the last update check found.
    updates: Option<ToolUpdates>,
    /// Why the last update check failed.
    check_error: Option<String>,
}

impl MachineToolchain {
    pub(super) fn machine(&self) -> &str {
        &self.machine
    }

    pub(super) fn is_scanning(&self) -> bool {
        self.scanning
    }

    pub(super) fn scanned_at(&self) -> Option<i64> {
        self.scanned_at
    }

    pub(super) fn tools(&self) -> &[ToolFound] {
        &self.tools
    }

    pub(super) fn facts(&self) -> &OwnerFacts {
        &self.facts
    }

    pub(super) fn checking(&self) -> bool {
        self.checking
    }

    pub(super) fn set_checking(&mut self, checking: bool) {
        self.checking = checking;
    }

    pub(super) fn updates_checked_at(&self) -> Option<i64> {
        self.updates.as_ref().map(ToolUpdates::checked_at)
    }

    pub(super) fn set_updates(&mut self, updates: ToolUpdates) {
        self.updates = Some(updates);
        self.check_error = None;
    }

    pub(super) fn set_check_error(&mut self, error: String) {
        self.check_error = Some(error);
    }

    #[cfg(test)]
    pub(super) fn for_test(machine: &str, tools: Vec<ToolFound>, facts: OwnerFacts) -> Self {
        Self { machine: machine.into(), scanned_at: Some(1), tools, facts, ..Self::default() }
    }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

// Where tools are on a real machine, past what AGENT_ENV already adds. Tests leave it out, so the
// tools installed where they run are never found.
pub(super) const SYSTEM_PATHS: &str = r##"PATH="$PATH:/usr/local/go/bin"
cellars="/opt/homebrew/Cellar /usr/local/Cellar /home/linuxbrew/.linuxbrew/Cellar"
"##;

// A shell with a version manager loaded finds its default first, so nvm's and fnm's defaults and
// the shims go in front. Nothing a version check starts may install, download or ask anything.
pub(super) const TOOL_ENV: &str = r##"export LC_ALL=C NO_COLOR=1 TERM=dumb
export GOTOOLCHAIN=local RUSTUP_AUTO_INSTALL=0 MISE_AUTO_INSTALL=0 MISE_NOT_FOUND_AUTO_INSTALL=0 \
  COREPACK_ENABLE_NETWORK=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_ENABLE_AUTO_PIN=0 COREPACK_ENABLE_STRICT=0 \
  NO_UPDATE_NOTIFIER=1 npm_config_update_notifier=false GH_NO_UPDATE_NOTIFIER=1 GH_PROMPT_DISABLED=1 \
  DENO_NO_UPDATE_CHECK=1 HOMEBREW_NO_AUTO_UPDATE=1 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_PAGER=cat
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY 2>/dev/null
cd / || exit 3
renice -n 10 $$ >/dev/null 2>&1
start=$(date +%s)
tab=$(printf '\t')
work=$(mktemp -d "${TMPDIR:-/tmp}/arbor-toolchain.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT
data=${XDG_DATA_HOME:-$HOME/.local/share}
mise=${MISE_DATA_DIR:-$data/mise}
asdf=${ASDF_DATA_DIR:-$HOME/.asdf}
nvm=${NVM_DIR:-$HOME/.nvm}
corepack=${COREPACK_HOME:-$HOME/.cache/node/corepack}
front=
put_first() { if [ -d "$1" ]; then front="$front$1:"; fi; }
want=$(head -n 1 "$nvm/alias/default" 2>/dev/null | tr -d ' \t\r' || true)
hops=0
while [ -n "$want" ] && [ -f "$nvm/alias/$want" ] && [ "$hops" -lt 3 ]; do
  want=$(head -n 1 "$nvm/alias/$want" | tr -d ' \t\r'); hops=$((hops + 1))
done
if [ -n "$want" ] && [ -d "$nvm/versions/node" ]; then
  pick=$(ls "$nvm/versions/node" 2>/dev/null | sed -n 's/^v\([0-9][0-9.]*\)$/\1/p' | awk -F. -v want="${want#v}" '
    want == "node" || want == "stable" || $0 == want || index($0, want ".") == 1 || (want == "lts/*" && $1 % 2 == 0)' |
    sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
  if [ -n "$pick" ]; then put_first "$nvm/versions/node/v$pick/bin"; fi
fi
for d in "$data/fnm/aliases/default/bin" "$HOME/Library/Application Support/fnm/aliases/default/bin" "$HOME/.fnm/aliases/default/bin" \
  "$mise/shims" "$asdf/shims" "${PYENV_ROOT:-$HOME/.pyenv}/shims" "$HOME/.cargo/bin"; do
  put_first "$d"
done
PATH="$front$PATH:$HOME/.deno/bin:${PNPM_HOME:-$HOME/Library/pnpm}:$data/pnpm"
export PATH
os=$(uname -s 2>/dev/null || true)
nl='
'
# A Mac without the Command Line Tools has a git and python3 in /usr/bin that only offer to install
# them, and a version manager's shim can fall back to them. `xcode-select -p` can name a folder that's gone.
clt=1
if [ "$os" = Darwin ]; then
  dev=$(xcode-select -p 2>/dev/null || true)
  if [ -z "$dev" ] || [ ! -x "$dev/usr/bin/git" ]; then clt=0; fi
fi
git=0
case "$(command -v git 2>/dev/null || true)" in
  /usr/bin/git|*/shims/*) [ "$clt" = 1 ] && git=1 ;;
  /*) git=1 ;;
esac
b64=0
command -v base64 >/dev/null 2>&1 && b64=1
printf 'H\t%s\n' "$HOME"
printf 'U\t%s\t%s\n' "$os" "$(uname -m 2>/dev/null || true)"
# Runs a command with stdin closed for at most $probe_s seconds, into a file of its own, so a stopped
# check that left something running can't write into the next one's. Its errors go in with what it
# says unless $quiet is 1.
probes=0
quiet=0
capped() {
  probes=$((probes + 1))
  out="$work/out.$probes"
  if [ "$quiet" = 1 ]; then ( exec "$@" </dev/null >"$out" 2>/dev/null ) & else ( exec "$@" </dev/null >"$out" 2>&1 ) & fi
  pid=$!
  ( sleep "$probe_s"; kill -9 "$pid" ) </dev/null >/dev/null 2>&1 &
  dog=$!
  wait "$pid" 2>/dev/null
  status=$?
  kill "$dog" 2>/dev/null
  wait "$dog" 2>/dev/null
}
# Puts the first line a command wrote with a version in it in $probed, when it finished without an error.
probe() {
  probed=
  capped "$@"
  if [ "$status" = 0 ]; then probed=$(awk '/[0-9]+\.[0-9]+/ { gsub(/[\t\r]/, " "); print substr($0, 1, 200); exit }' "$out"); fi
}
# Puts the first line a command wrote to its output in $asked, when it finished without an error.
ask() {
  asked=
  quiet=1
  capped "$@"
  quiet=0
  if [ "$status" = 0 ]; then asked=$(awk 'NF { gsub(/[\t\r]/, " "); print substr($0, 1, 300); exit }' "$out"); fi
}
real_path() { realpath "$1" 2>/dev/null || readlink -f "$1" 2>/dev/null || printf '%s' "$1"; }
# `V name path version-line` for the tool a shell finds first, then `L name real-path mise-tool`: where
# the binary really is and, for one of mise's, the tool mise says gives it, which prove who installed it.
tool() {
  name=$1; shift
  cmd=$1
  bin=$(command -v "$1" 2>/dev/null || true)
  case "$bin" in /*) ;; *) return 0 ;; esac
  case "$bin" in *"$nl"*|*"$tab"*) return 0 ;; esac
  shift
  probed=
  case "$name:$bin" in
    go:*)
      # Every run of the go command writes telemetry counters, so its version comes from the VERSION
      # file at the top of the Go it belongs to.
      real=$(realpath "$bin" 2>/dev/null || readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")
      root=$(dirname "$(dirname "$real")")
      if [ -f "$root/VERSION" ]; then
        probed=$(head -n 1 "$root/VERSION" | tr -d '\t\r')
        case "$probed" in go[0-9]*) ;; *) probed= ;; esac
      fi
      ;;
    node:*/.volta/bin/*)
      # A Volta shim downloads a default Node it doesn't have, so its version comes from Volta's settings.
      probed=$(sed -n 's/.*"runtime"[[:space:]]*:[[:space:]]*"\([0-9][0-9A-Za-z.+-]*\)".*/\1/p' "$HOME/.volta/tools/user/platform.json" 2>/dev/null | head -n 1)
      ;;
    *:*/.volta/bin/*) ;;
    git:/usr/bin/*|git:*/shims/*|python:/usr/bin/*|python:*/shims/*) [ "$clt" = 1 ] && probe "$bin" "$@" ;;
    *) probe "$bin" "$@" ;;
  esac
  printf 'V\t%s\t%s\t%s\n' "$name" "$bin" "$probed"
  real=$(real_path "$bin")
  plugin=
  case "$bin:$real" in
    */mise/shims/*|*/mise/installs/*)
      if command -v mise >/dev/null 2>&1; then
        ask mise which --plugin "$cmd"
        plugin=$asked
        ask mise which "$cmd"
        case "$asked" in /*) real=$(real_path "$asked") ;; esac
      fi
      ;;
  esac
  case "$real$plugin" in *"$nl"*|*"$tab"*) return 0 ;; esac
  printf 'L\t%s\t%s\t%s\n' "$name" "$real" "$plugin"
}
"##;

// Follows the tools. What the installers that own tools need proven, past each tool's own path:
//   B brew prefix         where Homebrew keeps its kegs, from `brew --prefix`
//   B mise path           mise itself
//   B rustup path         rustup, whose proxies are rustc and cargo when they sit beside it
//   B uv-receipt 1        uv's standalone installer put it there, so it updates itself
//   B system manager      the system's package manager, which needs sudo
const OWNERS_BODY: &str = r##"for installer in brew mise rustup; do
  at=$(command -v "$installer" 2>/dev/null || true)
  case "$at" in /*) ;; *) continue ;; esac
  case "$at" in *"$nl"*|*"$tab"*) continue ;; esac
  if [ "$installer" = brew ]; then
    ask "$at" --prefix
    case "$asked" in /*) printf 'B\tbrew\t%s\n' "$(real_path "$asked")" ;; esac
  else
    printf 'B\t%s\t%s\n' "$installer" "$at"
  fi
done
if [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/uv/uv-receipt.json" ]; then printf 'B\tuv-receipt\t1\n'; fi
for manager in apt-get dnf yum pacman zypper apk; do
  if command -v "$manager" >/dev/null 2>&1; then printf 'B\tsystem\t%s\n' "$manager"; break; fi
done
"##;

// Follows TOOL_ENV. `M tool manager name` for each version a version manager keeps; rustup's
// toolchains also get their rustc's answer.
const KEPT_BODY: &str = r##"kept() {
  for e in "$3"/*; do
    case "$e" in *"$nl"*|*"$tab"*) continue ;; esac
    if [ -d "$e" ] && [ ! -L "$e" ]; then printf 'M\t%s\t%s\t%s\n' "$1" "$2" "$(basename "$e")"; fi
  done
}
kept node nvm "$nvm/versions/node"
kept node fnm "$data/fnm/node-versions"
kept node fnm "$HOME/Library/Application Support/fnm/node-versions"
kept node fnm "$HOME/.fnm/node-versions"
kept node volta "$HOME/.volta/tools/image/node"
kept node mise "$mise/installs/node"
kept node asdf "$asdf/installs/nodejs"
kept python pyenv "${PYENV_ROOT:-$HOME/.pyenv}/versions"
kept python mise "$mise/installs/python"
kept python asdf "$asdf/installs/python"
kept python uv "${UV_PYTHON_INSTALL_DIR:-$data/uv/python}"
kept go mise "$mise/installs/go"
kept go asdf "$asdf/installs/golang"
kept go sdk "$HOME/sdk"
kept go toolchain "${GOMODCACHE:-${GOPATH:-$HOME/go}/pkg/mod}/golang.org"
kept bun mise "$mise/installs/bun"
kept deno mise "$mise/installs/deno"
kept pnpm corepack "$corepack/v1/pnpm"
kept pnpm corepack "$corepack/pnpm"
kept yarn corepack "$corepack/v1/yarn"
kept yarn corepack "$corepack/yarn"
for cellar in $cellars; do
  [ -d "$cellar" ] || continue
  for f in "$cellar"/node "$cellar"/node@*; do kept node brew "$f"; done
  for f in "$cellar"/python@3*; do kept python brew "$f"; done
  kept go brew "$cellar/go"
done
for tc in "${RUSTUP_HOME:-$HOME/.rustup}"/toolchains/*; do
  case "$tc" in *"$nl"*|*"$tab"*) continue ;; esac
  if [ -x "$tc/bin/rustc" ]; then
    probe "$tc/bin/rustc" --version
    printf 'M\trust\trustup\t%s\t%s\n' "$(basename "$tc")" "$probed"
  fi
done
"##;

// Follows KEPT_BODY, INSIDE_REPO and ORIGIN_URL, with the repos in a heredoc Rust puts between the
// halves. Each repo is looked at with stdin closed, so nothing can read the list. Lines out:
//   H home                     the machine's home folder
//   U os arch
//   V tool path line           the tool a shell finds first, and the line with its version
//   M tool manager name [line] a version a version manager keeps
//   R path ok|missing          a repo
//   O url                      its origin, without user name, password or query
//   P file size base64|-       a project file, or `-` when it's too big to read
//   K file                     a lockfile
//   Q                          the scan ran out of time here
const REPOS_HEAD: &str = r##"cat > "$work/repos" <<'ARBOR_REPOS'
"##;

const REPOS_BODY: &str = r##"ARBOR_REPOS
emit_file() {
  found=$(inside_repo "$repo" "$1") || return 0
  size=$(wc -c < "$found" | tr -d ' ')
  if [ "$size" -gt "$most" ] || [ "$b64" = 0 ]; then printf 'P\t%s\t%s\t-\n' "$1" "$size"; return 0; fi
  printf 'P\t%s\t%s\t%s\n' "$1" "$size" "$(base64 < "$found" | tr -d '\n\r')"
}
locks() {
  for name in bun.lock bun.lockb pnpm-lock.yaml yarn.lock package-lock.json uv.lock; do
    if [ -f "$repo/$1$name" ]; then printf 'K\t%s%s\n' "$1" "$name"; fi
  done
}
scan_repo() {
  if [ ! -d "$repo" ]; then printf 'R\t%s\tmissing\n' "$repo"; return 0; fi
  printf 'R\t%s\tok\n' "$repo"
  if [ "$git" = 1 ]; then
    url=$(origin_url "$repo")
    if [ -n "$url" ]; then printf 'O\t%s\n' "$url"; fi
  fi
  for name in package.json .nvmrc .node-version .tool-versions mise.toml .mise.toml .python-version pyproject.toml rust-toolchain.toml rust-toolchain Cargo.toml go.mod; do
    emit_file "$name"
  done
  locks ""
  n=0
  for d in "$repo"/*/; do
    # A name with a line break or tab in it could pass for a line of its own.
    case "$d" in *"$nl"*|*"$tab"*) continue ;; esac
    [ -d "$d" ] || continue
    sub=$(basename "$d")
    case "$sub" in node_modules|target|dist|build|out|vendor|venv) continue ;; esac
    for name in package.json Cargo.toml go.mod pyproject.toml rust-toolchain.toml .nvmrc .node-version .python-version; do
      [ -f "$d$name" ] || continue
      n=$((n + 1))
      [ "$n" -le "$nested" ] || return 0
      emit_file "$sub/$name"
    done
    locks "$sub/"
  done
}
while IFS= read -r repo <&3; do
  [ -n "$repo" ] || continue
  if [ $(( $(date +%s) - start )) -ge "$budget" ]; then printf 'Q\n'; break; fi
  scan_repo </dev/null
done 3< "$work/repos"
"##;

/// The script that finds a machine's tools and reads what its repos ask for. `paths` puts the
/// machine's usual tool folders on PATH.
fn scan_script(paths: &str, repos: &[String]) -> String {
    let mut script = format!(
        "set -u\n{paths}{TOOL_ENV}{INSIDE_REPO}{ORIGIN_URL}probe_s={PROBE_S}\nbudget={SCAN_BUDGET_S}\nmost={FILE_BYTES}\nnested={MOST_NESTED}\n"
    );
    for (name, command) in TOOLS {
        script.push_str(&format!("tool {name} {command}\n"));
    }
    script.push_str(OWNERS_BODY);
    script.push_str(KEPT_BODY);
    script.push_str(REPOS_HEAD);
    for repo in repos.iter().filter(|repo| is_path(repo)) {
        script.push_str(repo);
        script.push('\n');
    }
    script.push_str(REPOS_BODY);
    script
}

/// The first version in a line: `1.2.3` from `go version go1.2.3 linux/amd64`, with a pre-release
/// tag like `-nightly` or `rc1` kept.
pub(super) fn version_in(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() || (index > 0 && (bytes[index - 1].is_ascii_digit() || bytes[index - 1] == b'.')) {
            index += 1;
            continue;
        }
        let mut end = index;
        while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'.') {
            end += 1;
        }
        let number = text[index..end].trim_end_matches('.');
        if number.contains('.') && !number.contains("..") {
            let rest = &text[index + number.len()..];
            let tag = ["-nightly", "-beta", "-alpha", "-rc", "-canary", "-dev", "-pre", "rc", "a", "b"]
                .iter()
                .find(|tag| rest.starts_with(**tag) && rest[tag.len()..].chars().next().is_none_or(|c| !c.is_ascii_alphabetic()))
                .map(|tag| {
                    let tail: String = rest[tag.len()..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
                    format!("{tag}{}", tail.trim_end_matches('.'))
                })
                .unwrap_or_default();
            return Some(format!("{number}{tag}"));
        }
        index = end;
    }
    None
}

/// The version a version manager's folder holds, from its name.
fn kept_version(manager: &str, name: &str) -> Option<String> {
    let name = match manager {
        "uv" => name.strip_prefix("cpython-")?,
        "toolchain" => name.strip_prefix("toolchain@")?.split_once("-go")?.1,
        "sdk" => name.strip_prefix("go")?,
        _ => name.strip_prefix('v').unwrap_or(name),
    };
    // Conda, PyPy and the like start with their own name, and aren't the tool's own versions.
    if !name.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    version_in(name)
}

/// A rustup toolchain's channel, without the platform: `stable` from `stable-aarch64-apple-darwin`.
fn channel(name: &str) -> String {
    const ARCHES: [&str; 9] = ["aarch64", "x86_64", "arm", "armv7", "i686", "riscv64gc", "powerpc64le", "s390x", "loongarch64"];
    ARCHES
        .iter()
        .filter_map(|arch| name.find(&format!("-{arch}-")))
        .min()
        .map_or(name, |at| &name[..at])
        .to_string()
}

/// A value from a project file as the page may show it: one short line.
fn clean(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.chars().count() <= TEXT_CHARS && !value.chars().any(char::is_control)).then(|| value.to_string())
}

/// A package's version as its package.json gives it, and nothing that only sits where one might.
fn is_version(value: &str) -> bool {
    value.len() <= 60 && value.starts_with(|c: char| c.is_ascii_digit()) && value.chars().all(|c| c.is_ascii_alphanumeric() || ".+-".contains(c))
}

/// A name that is safe to put in `node_modules/<name>`: an npm package name, maybe scoped.
fn is_package_name(name: &str) -> bool {
    let part = |part: &str| part.starts_with(|c: char| c.is_ascii_alphanumeric()) && part.chars().all(|c| c.is_ascii_alphanumeric() || "._~-".contains(c));
    name.len() <= NAME_CHARS
        && match name.strip_prefix('@') {
            Some(scoped) => scoped.split_once('/').is_some_and(|(scope, rest)| part(scope) && part(rest)),
            None => part(name),
        }
}

/// A dependency range that means a version from the registry, not a folder, a link or a git URL.
fn registry_range(range: &str) -> bool {
    !["workspace:", "file:", "link:", "portal:", "git", "github:", "http:", "https:", "npm:", "catalog:", "patch:", "exec:", "./", "../", "/", "~/"]
        .iter()
        .any(|prefix| range.starts_with(prefix))
        && !range.contains('/')
}

/// The name a tool goes by in the page, from what `.tool-versions` or mise calls it.
fn tool_name(name: &str) -> Option<&'static str> {
    Some(match name.strip_prefix("core:").unwrap_or(name) {
        "node" | "nodejs" => "node",
        "python" => "python",
        "go" | "golang" => "go",
        "rust" => "rust",
        "bun" => "bun",
        "deno" => "deno",
        "pnpm" => "pnpm",
        "yarn" => "yarn",
        "uv" => "uv",
        _ => return None,
    })
}

fn first_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).find(|line| !line.is_empty() && !line.starts_with('#')).and_then(clean)
}

fn toml_string<'a>(value: &'a toml::Value, path: &[&str]) -> Option<&'a str> {
    path.iter().try_fold(value, |value, key| value.get(key))?.as_str()
}

/// Reads what one project file asks for into `project`. Returns false when the file isn't what
/// its name says.
fn read_manifest(project: &mut ProjectToolchain, file: &str, text: &str) -> bool {
    let (dir, base) = file.rsplit_once('/').unwrap_or(("", file));
    let mut need = |tool: &str, wants: &str, kind: NeedKind, field: Option<String>| {
        if let Some(wants) = clean(wants) {
            project.needs.push(ToolNeed { tool: tool.to_string(), wants, kind, file: file.to_string(), field });
        }
    };
    match base {
        "package.json" => {
            let Ok(serde_json::Value::Object(json)) = serde_json::from_str::<serde_json::Value>(text) else {
                return false;
            };
            if let Some(serde_json::Value::Object(engines)) = json.get("engines") {
                for tool in ["node", "npm", "pnpm", "yarn", "bun", "deno"] {
                    if let Some(wants) = engines.get(tool).and_then(|value| value.as_str()) {
                        need(tool, wants, NeedKind::Range, Some(format!("engines.{tool}")));
                    }
                }
            }
            if let Some((tool, version)) = json.get("packageManager").and_then(|value| value.as_str()).and_then(|value| value.split_once('@')) {
                if ["npm", "pnpm", "yarn", "bun"].contains(&tool) {
                    need(tool, version.split('+').next().unwrap_or_default(), NeedKind::Pin, Some("packageManager".into()));
                }
            }
            if let Some(serde_json::Value::Object(volta)) = json.get("volta") {
                for tool in ["node", "npm", "pnpm", "yarn"] {
                    if let Some(wants) = volta.get(tool).and_then(|value| value.as_str()) {
                        need(tool, wants, NeedKind::Pin, Some(format!("volta.{tool}")));
                    }
                }
            }
            project.packages.push(PackageDir { dir: dir.to_string(), ..PackageDir::default() });
            let mut kept = 0;
            for (key, dev) in [("dependencies", false), ("devDependencies", true)] {
                let Some(serde_json::Value::Object(dependencies)) = json.get(key) else { continue };
                for (name, range) in dependencies {
                    let Some(range) = range.as_str().and_then(clean).filter(|range| registry_range(range)) else { continue };
                    if !is_package_name(name) || project.libraries.iter().any(|library| library.dir == dir && library.name == *name) {
                        continue;
                    }
                    if kept == MOST_LIBRARIES {
                        project.libraries_more += 1;
                        continue;
                    }
                    kept += 1;
                    project.libraries.push(ProjectLibrary { dir: dir.to_string(), name: name.clone(), wants: range, dev, installed: None, checked: false });
                }
            }
        }
        ".nvmrc" | ".node-version" => {
            if let Some(wants) = first_line(text) {
                need("node", &wants, NeedKind::Pin, None);
            }
        }
        ".python-version" => {
            if let Some(wants) = first_line(text) {
                need("python", &wants, NeedKind::Pin, None);
            }
        }
        ".tool-versions" => {
            for line in text.lines() {
                let mut words = line.split('#').next().unwrap_or_default().split_whitespace();
                if let (Some(tool), Some(wants)) = (words.next().and_then(tool_name), words.next()) {
                    need(tool, wants, NeedKind::Pin, Some(tool.to_string()));
                }
            }
        }
        "mise.toml" | ".mise.toml" => {
            let Ok(toml) = text.parse::<toml::Value>() else { return false };
            if let Some(toml::Value::Table(tools)) = toml.get("tools") {
                for (key, value) in tools {
                    let Some(tool) = tool_name(key) else { continue };
                    let wants = match value {
                        toml::Value::String(wants) => Some(wants.as_str()),
                        toml::Value::Array(list) => list.first().and_then(toml::Value::as_str),
                        toml::Value::Table(table) => table.get("version").and_then(toml::Value::as_str),
                        _ => None,
                    };
                    if let Some(wants) = wants {
                        need(tool, wants, NeedKind::Pin, Some(format!("tools.{key}")));
                    }
                }
            }
        }
        "pyproject.toml" => {
            let Ok(toml) = text.parse::<toml::Value>() else { return false };
            if let Some(wants) = toml_string(&toml, &["project", "requires-python"]) {
                need("python", wants, NeedKind::Python, Some("requires-python".into()));
            } else if let Some(wants) = toml_string(&toml, &["tool", "poetry", "dependencies", "python"]) {
                need("python", wants, NeedKind::Python, Some("tool.poetry.dependencies.python".into()));
            }
        }
        "rust-toolchain.toml" | "rust-toolchain" => {
            let channel = if base == "rust-toolchain" && !text.contains("[toolchain]") {
                first_line(text)
            } else {
                let Ok(toml) = text.parse::<toml::Value>() else { return false };
                toml_string(&toml, &["toolchain", "channel"]).map(str::to_string)
            };
            if let Some(channel) = channel {
                need("rust", &channel, NeedKind::Pin, Some("channel".into()));
            }
        }
        "Cargo.toml" => {
            let Ok(toml) = text.parse::<toml::Value>() else { return false };
            match toml_string(&toml, &["package", "rust-version"]).or_else(|| toml_string(&toml, &["workspace", "package", "rust-version"])) {
                Some(wants) => need("rust", wants, NeedKind::Min, Some("rust-version".into())),
                // A Rust project needs Rust even when it doesn't say which.
                None => need("rust", "*", NeedKind::Range, None),
            }
        }
        "go.mod" => {
            if let Some(wants) = text.lines().find_map(|line| line.trim().strip_prefix("go ")) {
                need("go", wants, NeedKind::Min, Some("go".into()));
            }
        }
        _ => {}
    }
    true
}

/// A lockfile says which tool installs the project's packages, when nothing else there does.
fn read_lockfile(project: &mut ProjectToolchain, file: &str) {
    let (dir, base) = file.rsplit_once('/').unwrap_or(("", file));
    let Some((_, tool)) = LOCKFILES.iter().find(|(name, _)| *name == base) else { return };
    if let Some(package) = project.packages.iter_mut().find(|package| package.dir == dir) {
        package.lockfile.get_or_insert_with(|| base.to_string());
    }
    let said = project.needs.iter().any(|need| need.tool == *tool && need.file.rsplit_once('/').map_or("", |(dir, _)| dir) == dir);
    if !said {
        project.needs.push(ToolNeed { tool: tool.to_string(), wants: "*".into(), kind: NeedKind::Range, file: file.to_string(), field: None });
    }
}

/// A file name as the scan sends it: at the top of the checkout, or one folder down.
fn is_project_file(file: &str) -> bool {
    let parts: Vec<&str> = file.split('/').collect();
    parts.len() <= 2 && parts.iter().all(|part| !part.is_empty() && *part != "." && *part != ".." && part.len() <= 255 && !part.chars().any(char::is_control))
}

/// What a scan found.
#[derive(Debug, Default, PartialEq)]
struct Scanned {
    home_dir: String,
    os: String,
    arch: String,
    tools: Vec<ToolFound>,
    kept: Vec<KeptVersion>,
    projects: Vec<ProjectToolchain>,
    partial: bool,
    facts: OwnerFacts,
}

fn parse_scan(stdout: &str, used: &HashMap<String, i64>) -> Scanned {
    let mut scanned = Scanned::default();
    let mut locks: Vec<String> = Vec::new();
    // Each tool's real path and the tool mise names for it, by tool.
    let mut real: HashMap<String, (String, String)> = HashMap::new();
    let finish = |project: Option<&mut ProjectToolchain>, locks: &mut Vec<String>| {
        if let Some(project) = project {
            for lock in locks.drain(..) {
                read_lockfile(project, &lock);
            }
        }
        locks.clear();
    };
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["H", home] => scanned.home_dir = home.to_string(),
            ["U", os, arch] => {
                scanned.os = clean(os).unwrap_or_default();
                scanned.arch = clean(arch).unwrap_or_default();
            }
            ["Q"] => scanned.partial = true,
            ["V", tool, path, line] => {
                if TOOLS.iter().any(|(name, _)| name == tool) && is_path(path) && !scanned.tools.iter().any(|found| found.tool == *tool) {
                    scanned.tools.push(ToolFound { tool: tool.to_string(), path: path.to_string(), version: version_in(line), owner: None });
                }
            }
            ["L", tool, path, plugin] => {
                if is_path(path) {
                    real.entry(tool.to_string()).or_insert_with(|| (path.to_string(), plugin.to_string()));
                }
            }
            ["B", key, value] => scanned.facts.read(key, value),
            ["M", tool, manager, name, rest @ ..] => {
                let (version, label) = if *manager == "rustup" {
                    (rest.first().and_then(|line| version_in(line)), Some(channel(name)).filter(|label| !label.is_empty()))
                } else {
                    (kept_version(manager, name), None)
                };
                if let (Some(version), Some(tool)) = (version, TOOLS.iter().map(|(name, _)| *name).find(|name| name == tool)) {
                    let kept = KeptVersion { tool: tool.to_string(), manager: manager.chars().take(20).collect(), version, label };
                    if !scanned.kept.contains(&kept) {
                        scanned.kept.push(kept);
                    }
                }
            }
            ["R", path, state] => {
                finish(scanned.projects.last_mut(), &mut locks);
                scanned.projects.push(ProjectToolchain {
                    path: path.to_string(),
                    missing: *state == "missing",
                    last_used_ms: used.get(*path).copied(),
                    ..ProjectToolchain::default()
                });
            }
            ["O", url] => {
                if let Some(project) = scanned.projects.last_mut() {
                    project.remote = normalize_remote(url);
                }
            }
            ["P", file, _size, content] => {
                let Some(project) = scanned.projects.last_mut() else { continue };
                if !is_project_file(file) {
                    continue;
                }
                let text = (*content != "-")
                    .then(|| STANDARD.decode(content.trim()).ok())
                    .flatten()
                    .filter(|bytes| bytes.len() <= FILE_BYTES)
                    .and_then(|bytes| String::from_utf8(bytes).ok());
                let read = text.is_some_and(|text| read_manifest(project, file, &text));
                if !read {
                    project.unread.push(file.to_string());
                }
            }
            ["K", file] => {
                if scanned.projects.last().is_some() && is_project_file(file) {
                    locks.push(file.to_string());
                }
            }
            _ => {}
        }
    }
    finish(scanned.projects.last_mut(), &mut locks);
    for found in &mut scanned.tools {
        if let Some((path, plugin)) = real.get(&found.tool) {
            found.owner = prove_owner(&found.tool, &found.path, path, plugin, &scanned.facts);
        }
    }
    scanned
}

// ---------------------------------------------------------------------------
// Installed packages
// ---------------------------------------------------------------------------

// Follows `budget`, with the lookups in a heredoc Rust adds, one `repo dir name` a line (`.` for
// the top of the checkout, and no name to ask whether there's a node_modules). A package is looked
// for where Node would find it: next to the package.json, then at the top. Lines out:
//   N repo dir name version|-
//   W repo dir 1|0             whether there's a node_modules
//   Q                          ran out of time here
const PACKAGES_HEAD: &str = r##"set -u
export LC_ALL=C
cd / || exit 3
renice -n 10 $$ >/dev/null 2>&1
tab=$(printf '\t')
work=$(mktemp -d "${TMPDIR:-/tmp}/arbor-packages.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT
cat > "$work/want" <<'ARBOR_WANT'
"##;

const PACKAGES_BODY: &str = r##"ARBOR_WANT
start=$(date +%s)
while IFS="$tab" read -r repo dir name <&3; do
  [ -n "$repo" ] || continue
  if [ $(( $(date +%s) - start )) -ge "$budget" ]; then printf 'Q\n'; break; fi
  if [ "$dir" = . ]; then base=$repo; else base="$repo/$dir"; fi
  if [ -z "$name" ]; then
    has=0
    if [ -d "$base/node_modules" ] || [ -d "$repo/node_modules" ]; then has=1; fi
    printf 'W\t%s\t%s\t%s\n' "$repo" "$dir" "$has"
    continue
  fi
  v=-
  for top in "$base" "$repo"; do
    f="$top/node_modules/$name/package.json"
    if [ -f "$f" ]; then
      # The first "version" whose value starts with a digit: a script called version doesn't.
      v=$(awk 'match($0, /"version"[ \t]*:[ \t]*"[0-9][^"]*"/) { s = substr($0, RSTART, RLENGTH); sub(/^"version"[ \t]*:[ \t]*"/, "", s); sub(/"$/, "", s); print substr(s, 1, 60); exit }' "$f" </dev/null)
      break
    fi
  done
  printf 'N\t%s\t%s\t%s\t%s\n' "$repo" "$dir" "$name" "${v:--}"
done 3< "$work/want"
"##;

/// The script that reads which version of each dependency is installed, or None when there's
/// nothing to look up.
fn packages_script(projects: &[ProjectToolchain]) -> Option<String> {
    let mut lookups = Vec::new();
    for project in projects.iter().filter(|project| !project.missing && is_path(&project.path)) {
        for package in &project.packages {
            lookups.push(format!("{}\t{}\t", project.path, if package.dir.is_empty() { "." } else { &package.dir }));
        }
        for library in project.libraries.iter().filter(|library| is_package_name(&library.name) && !library.dir.contains(['/', '\t'])) {
            lookups.push(format!("{}\t{}\t{}", project.path, if library.dir.is_empty() { "." } else { &library.dir }, library.name));
        }
    }
    lookups.truncate(MOST_LOOKUPS);
    if lookups.is_empty() {
        return None;
    }
    let mut script = format!("budget={PACKAGES_BUDGET_S}\n{PACKAGES_HEAD}");
    for lookup in lookups {
        script.push_str(&lookup);
        script.push('\n');
    }
    script.push_str(PACKAGES_BODY);
    Some(script)
}

/// Puts what the packages script found into the projects it looked in.
fn apply_packages(projects: &mut [ProjectToolchain], stdout: &str) -> bool {
    let mut partial = false;
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        let dir_of = |dir: &str| if dir == "." { String::new() } else { dir.to_string() };
        match fields.as_slice() {
            ["Q"] => partial = true,
            ["W", repo, dir, has] => {
                let dir = dir_of(dir);
                if let Some(package) = projects.iter_mut().filter(|project| project.path == *repo).flat_map(|project| &mut project.packages).find(|package| package.dir == dir) {
                    package.modules = Some(*has == "1");
                }
            }
            ["N", repo, dir, name, version] => {
                let dir = dir_of(dir);
                let found = projects
                    .iter_mut()
                    .filter(|project| project.path == *repo)
                    .flat_map(|project| &mut project.libraries)
                    .find(|library| library.dir == dir && library.name == *name);
                if let Some(library) = found {
                    library.checked = true;
                    library.installed = Some(*version).filter(|version| is_version(version)).map(str::to_string);
                }
            }
            _ => {}
        }
    }
    partial
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Every machine's toolchain Arbor has looked at, as the page shows them.
#[tauri::command]
pub(crate) fn get_toolchain(state: tauri::State<'_, MachineHealthState>) -> Vec<MachineToolchain> {
    state.lock().toolchain.values().cloned().collect()
}

fn release(app: &tauri::AppHandle, machine: &str, update: impl FnOnce(&mut MachineToolchain)) -> MachineToolchain {
    let state = app.state::<MachineHealthState>();
    let toolchain = {
        let mut inner = state.lock();
        let entry = inner.toolchain.entry(machine.to_string()).or_insert_with(|| MachineToolchain { machine: machine.to_string(), ..MachineToolchain::default() });
        entry.scanning = false;
        update(entry);
        entry.clone()
    };
    let _ = app.emit(SETUP_TOOLCHAIN_UPDATED_EVENT, Local::now().timestamp_millis());
    toolchain
}

/// Finds a machine's tools, and reads what every repo sessions have worked in there asks for.
#[tauri::command]
pub(crate) async fn scan_toolchain(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
) -> Result<MachineToolchain, String> {
    let target = {
        let mut inner = state.lock();
        let target = covered_machine(&inner, &machine)?.0;
        let entry = inner.toolchain.entry(machine.clone()).or_insert_with(|| MachineToolchain { machine: machine.clone(), ..MachineToolchain::default() });
        if entry.scanning {
            return Err(format!("Arbor is already looking at the tools on {machine}"));
        }
        entry.scanning = true;
        target
    };
    let _ = app.emit(SETUP_TOOLCHAIN_UPDATED_EVENT, Local::now().timestamp_millis());
    let result = async {
        let name = machine.clone();
        let checkouts = run_usage_task(move || load_checkouts(&open_usage_database()?, &name)).await?;
        let paths = format!("{AGENT_ENV}{SYSTEM_PATHS}");
        let stdout = run_checked(&target, MachineOp::ToolchainScan, &scan_script(&paths, &checkouts.repos), SCAN_TIMEOUT).await?;
        let mut scanned = parse_scan(&stdout, &checkouts.used);
        if let Some(script) = packages_script(&scanned.projects) {
            // Tools and versions asked for are still worth showing when the packages can't be read.
            match run_checked(&target, MachineOp::PackageScan, &script, PACKAGES_TIMEOUT).await {
                Ok(stdout) => scanned.partial |= apply_packages(&mut scanned.projects, &stdout),
                Err(_) => scanned.partial = true,
            }
        }
        Ok(scanned)
    }
    .await;
    let failure = result.as_ref().err().cloned();
    let toolchain = release(&app, &machine, |entry| match result {
        Ok(scanned) => {
            entry.home_dir = scanned.home_dir;
            entry.os = scanned.os;
            entry.arch = scanned.arch;
            entry.tools = scanned.tools;
            entry.kept = scanned.kept;
            entry.projects = scanned.projects;
            entry.partial = scanned.partial;
            entry.facts = scanned.facts;
            entry.scanned_at = Some(Local::now().timestamp_millis());
            entry.error = None;
        }
        Err(error) => entry.error = Some(error),
    });
    match failure {
        Some(error) => Err(error),
        None => {
            // What the installers have newer is asked after the scan, apart from it, since the scan never goes online.
            if super::tool_updates::check_due(&toolchain, Local::now().timestamp_millis()) {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = super::tool_updates::run_check(&app, &machine, false).await;
                });
            }
            Ok(toolchain)
        }
    }
}

// ---------------------------------------------------------------------------
// Changing Node's versions
// ---------------------------------------------------------------------------

/// The version managers whose Node versions Arbor changes, each with its own command.
const NODE_MANAGERS: [&str; 5] = ["nvm", "fnm", "mise", "asdf", "volta"];
/// Installs download, so they get longer.
const NODE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MOST_NODE_CHANGES: usize = 12;

/// What to do with one of Node's versions on a machine.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NodeAction {
    /// Downloads and keeps a version, with the version manager's own command.
    Install,
    /// Removes a version the version manager keeps, which the machine's shell doesn't use by default.
    Uninstall,
    /// Makes a kept version the one a new shell finds first.
    SetDefault,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeChange {
    /// nvm, fnm, mise, asdf or volta.
    #[ts(type = "\"nvm\" | \"fnm\" | \"mise\" | \"asdf\" | \"volta\"")]
    manager: String,
    /// For an install, a version like `22` or `22.20.0`; otherwise one the last scan found the manager keeping.
    version: String,
    action: NodeAction,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeResult {
    #[ts(type = "\"nvm\" | \"fnm\" | \"mise\" | \"asdf\" | \"volta\"")]
    manager: String,
    version: String,
    action: NodeAction,
    ok: bool,
    /// The last thing the version manager said, when it failed.
    message: Option<String>,
}

/// A version as a version manager takes it: digits and dots, with a v in front if nvm or fnm keeps it that way.
fn node_version_word(version: &str) -> bool {
    let bare = version.strip_prefix('v').unwrap_or(version);
    !bare.is_empty() && bare.len() <= 20 && bare.split('.').count() <= 3 && bare.split('.').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

/// Whether the node a shell finds first is `manager`'s `version`: that one is the machine's default, which isn't removed.
fn is_default_node(scan: &MachineToolchain, manager: &str, version: &str) -> bool {
    let Some(node) = scan.tools.iter().find(|tool| tool.tool == "node") else { return false };
    let bare = version.trim_start_matches('v');
    let from_manager = match manager {
        "nvm" => node.path.contains("/.nvm/"),
        "fnm" => node.path.contains("fnm"),
        "mise" => node.path.contains("/mise/"),
        "asdf" => node.path.contains("/.asdf/"),
        _ => node.path.contains("/.volta/"),
    };
    // fnm's and mise's shims don't say the version in their path; the version the shell's node gave does.
    from_manager && (node.path.contains(&format!("/{version}/")) || node.version.as_deref().map(|found| found.trim_start_matches('v')) == Some(bare))
}

/// Checks each change against the machine's last scan: a known manager, a version it keeps (for anything but an
/// install), and never the default's removal.
fn plan_node_changes(scan: &MachineToolchain, changes: &[NodeChange]) -> Result<(), String> {
    if changes.is_empty() {
        return Err("There's nothing to change".into());
    }
    if changes.len() > MOST_NODE_CHANGES {
        return Err(format!("Arbor makes at most {MOST_NODE_CHANGES} changes to Node's versions at once"));
    }
    for change in changes {
        if !NODE_MANAGERS.contains(&change.manager.as_str()) {
            return Err(format!("Arbor doesn't change Node versions {} keeps", change.manager));
        }
        if !node_version_word(&change.version) {
            return Err(format!("{} isn't a Node version Arbor passes on: use numbers like 22 or 22.20.0", change.version));
        }
        if change.action == NodeAction::Install {
            if change.manager == "volta" && !scan.tools.iter().any(|tool| tool.path.contains("/.volta/")) {
                return Err("Volta isn't set up on this machine".into());
            }
            continue;
        }
        let kept = scan.kept.iter().any(|kept| kept.tool == "node" && kept.manager == change.manager && kept.version == change.version);
        if !kept {
            return Err(format!("{} doesn't keep Node {} on {} as its last scan found. Scan again.", change.manager, change.version, scan.machine));
        }
        if change.action == NodeAction::Uninstall {
            if change.manager == "volta" {
                return Err("Volta has no command to remove a Node version it keeps".into());
            }
            if is_default_node(scan, &change.manager, &change.version) {
                return Err(format!("Node {} is {}'s default. Make another version the default first.", change.version, scan.machine));
            }
        }
    }
    Ok(())
}

/// The command that makes one change, with the version manager loaded as a login shell would have it.
fn node_command(change: &NodeChange) -> String {
    let v = shell_quote(&change.version);
    let bare = shell_quote(change.version.trim_start_matches('v'));
    match (change.manager.as_str(), change.action) {
        ("nvm", action) => {
            let verb = match action {
                NodeAction::Install => format!("nvm install {v}"),
                NodeAction::Uninstall => format!("nvm uninstall {v}"),
                NodeAction::SetDefault => format!("nvm alias default {v}"),
            };
            format!("export NVM_DIR=\"${{NVM_DIR:-$HOME/.nvm}}\"; . \"$NVM_DIR/nvm.sh\" --no-use && {verb}")
        }
        ("fnm", NodeAction::Install) => format!("fnm install {v}"),
        ("fnm", NodeAction::Uninstall) => format!("fnm uninstall {v}"),
        ("fnm", NodeAction::SetDefault) => format!("fnm default {v}"),
        ("mise", NodeAction::Install) => format!("mise install node@{bare}"),
        ("mise", NodeAction::Uninstall) => format!("mise uninstall node@{bare}"),
        ("mise", NodeAction::SetDefault) => format!("mise use --global node@{bare}"),
        ("asdf", NodeAction::Install) => format!("asdf install nodejs {bare}"),
        ("asdf", NodeAction::Uninstall) => format!("asdf uninstall nodejs {bare}"),
        // asdf 0.16 replaced `global` with `set -u`.
        ("asdf", NodeAction::SetDefault) => format!("asdf set -u nodejs {bare} 2>/dev/null || asdf global nodejs {bare}"),
        // Volta's install makes the version its default too.
        (_, _) => format!("volta install node@{bare}"),
    }
}

/// The command that moves a Node version manager's default to `version`: installed, then made the default.
pub(super) fn node_update_command(manager: &str, version: &str) -> String {
    let change = |action| NodeChange { manager: manager.to_string(), version: version.to_string(), action };
    format!("{} && {}", node_command(&change(NodeAction::Install)), node_command(&change(NodeAction::SetDefault)))
}

/// Makes each change in turn, each in its own shell with stdin closed, and says how each went: `R index status`,
/// then its last line of output when it failed.
fn node_script(changes: &[NodeChange]) -> String {
    let mut script = format!(
        "{AGENT_ENV}{SYSTEM_PATHS}PATH=\"$HOME/.local/share/fnm:$HOME/.fnm:$HOME/.asdf/bin:$HOME/.asdf/shims:$PATH\"\nexport PATH\nexport NO_UPDATE_NOTIFIER=1 HOMEBREW_NO_AUTO_UPDATE=1 MISE_YES=1\ncd \"$HOME\" || exit 3\nout=$(mktemp \"${{TMPDIR:-/tmp}}/arbor-node.XXXXXX\") || exit 1\ntrap 'rm -f \"$out\"' EXIT\n"
    );
    for (index, change) in changes.iter().enumerate() {
        let command = node_command(change);
        script.push_str(&format!(
            "( {command} ) </dev/null >\"$out\" 2>&1\nstatus=$?\nprintf 'R\\t{index}\\t%s\\t%s\\n' \"$status\" \"$(tr -d '\\r' < \"$out\" | grep -v '^[[:space:]]*$' | tail -n 1 | tr '\\t' ' ' | cut -c 1-300)\"\n"
        ));
    }
    script
}

fn parse_node_results(stdout: &str, changes: &[NodeChange]) -> Vec<NodeResult> {
    let mut results: Vec<NodeResult> = changes
        .iter()
        .map(|change| NodeResult { manager: change.manager.clone(), version: change.version.clone(), action: change.action, ok: false, message: Some("It didn't run".into()) })
        .collect();
    for line in stdout.lines() {
        let mut fields = line.splitn(4, '\t');
        if fields.next() != Some("R") {
            continue;
        }
        let (Some(Ok(index)), Some(status)) = (fields.next().map(str::parse::<usize>), fields.next()) else { continue };
        let said = fields.next().map(str::trim).filter(|said| !said.is_empty()).map(str::to_string);
        if let Some(result) = results.get_mut(index) {
            result.ok = status == "0";
            result.message = if result.ok { None } else { said.or_else(|| Some(format!("It stopped with status {status}"))) };
        }
    }
    results
}

/// Installs, removes or picks the default of Node's versions on a machine with its own version managers, then looks
/// at its tools again.
#[tauri::command]
pub(crate) async fn change_node_versions(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    changes: Vec<NodeChange>,
) -> Result<Vec<NodeResult>, String> {
    let target = {
        let inner = state.lock();
        let target = covered_machine(&inner, &machine)?.0;
        let scan = inner.toolchain.get(&machine).filter(|scan| scan.scanned_at.is_some()).ok_or_else(|| format!("Look at the tools on {machine} first"))?;
        if scan.scanning {
            return Err(format!("Arbor is looking at the tools on {machine}. Try again once it's done."));
        }
        plan_node_changes(scan, &changes)?;
        target
    };
    let output = run_on_machine(&target, MachineOp::NodeChange, &node_script(&changes), NODE_TIMEOUT).await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !stdout.lines().any(|line| line.starts_with("R\t")) {
        return Err(failure_detail(&output));
    }
    let results = parse_node_results(&stdout, &changes);
    let _ = app.emit(SETUP_TOOLCHAIN_UPDATED_EVENT, Local::now().timestamp_millis());
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn need(tool: &str, wants: &str, kind: NeedKind, file: &str, field: Option<&str>) -> ToolNeed {
        ToolNeed { tool: tool.into(), wants: wants.into(), kind, file: file.into(), field: field.map(str::to_string) }
    }

    fn b64(text: &str) -> String {
        STANDARD.encode(text)
    }

    #[test]
    fn versions_are_read_from_what_each_tool_says() {
        let cases = [
            ("v22.17.0", Some("22.17.0")),
            ("go version go1.24.4 darwin/arm64", Some("1.24.4")),
            ("rustc 1.90.0-nightly (abc123 2026-08-01)", Some("1.90.0-nightly")),
            ("rustc 1.89.0-beta.3 (abc 2026-08-01)", Some("1.89.0-beta.3")),
            ("Python 3.14.0rc1", Some("3.14.0rc1")),
            ("git version 2.50.1 (Apple Git-155)", Some("2.50.1")),
            ("Docker version 28.3.0, build 38b7060", Some("28.3.0")),
            ("jq-1.7.1", Some("1.7.1")),
            ("deno 2.4.0 (stable, release, aarch64-apple-darwin)", Some("2.4.0")),
            ("gh version 2.74.0 (2026-06-10)", Some("2.74.0")),
            ("1.22.22", Some("1.22.22")),
            ("no version here 7", None),
            ("", None),
        ];
        for (line, version) in cases {
            assert_eq!(version_in(line).as_deref(), version, "{line}");
        }
        assert_eq!(kept_version("uv", "cpython-3.12.4-macos-aarch64-none").as_deref(), Some("3.12.4"));
        assert_eq!(kept_version("uv", "pypy-3.10.14-macos-aarch64-none"), None);
        assert_eq!(kept_version("toolchain", "toolchain@v0.0.1-go1.22.3.darwin-arm64").as_deref(), Some("1.22.3"));
        assert_eq!(kept_version("toolchain", "x"), None);
        assert_eq!(kept_version("sdk", "go1.21.0").as_deref(), Some("1.21.0"));
        assert_eq!(kept_version("nvm", "v20.19.0").as_deref(), Some("20.19.0"));
        assert_eq!(kept_version("brew", "3.13.5_1").as_deref(), Some("3.13.5"));
        assert_eq!(kept_version("pyenv", "miniconda3-4.7.12"), None);
        assert_eq!(channel("stable-aarch64-apple-darwin"), "stable");
        assert_eq!(channel("nightly-2026-09-01-x86_64-unknown-linux-gnu"), "nightly-2026-09-01");
        assert_eq!(channel("1.85.0-aarch64-apple-darwin"), "1.85.0");
    }

    #[test]
    fn project_files_give_only_the_versions_they_ask_for() {
        let mut project = ProjectToolchain::default();
        let package = r#"{
          "name": "app",
          "scripts": { "deploy": "SECRET=1 ./ship" },
          "engines": { "node": ">=22", "bun": "^1.3.0", "other": "1" },
          "packageManager": "pnpm@9.15.0+sha512.abc",
          "volta": { "node": "22.17.0" },
          "dependencies": { "react": "^19.1.0", "@types/node": "^24", "local": "workspace:*", "fork": "github:me/fork", "..": "1", "tar": "file:./x.tgz" },
          "devDependencies": { "typescript": "~5.9.2", "react": "^18" }
        }"#;
        assert!(read_manifest(&mut project, "package.json", package));
        assert!(read_manifest(&mut project, ".nvmrc", "# pinned\nv22\n"));
        assert!(read_manifest(&mut project, ".tool-versions", "nodejs 22.17.0\ngolang 1.24.4 # the build\nruby 3.3.0\n"));
        assert!(read_manifest(&mut project, "mise.toml", "[tools]\npython = \"3.12\"\n\"core:rust\" = [\"1.88\", \"stable\"]\nbun = { version = \"1.3\" }\n\"npm:prettier\" = \"3\"\n"));
        assert!(read_manifest(&mut project, "web/pyproject.toml", "[project]\nname = \"x\"\nrequires-python = \">=3.11,<4\"\n"));
        assert!(read_manifest(&mut project, "src-tauri/Cargo.toml", "[package]\nname = \"x\"\nrust-version = \"1.85\"\n"));
        assert!(read_manifest(&mut project, "cli/Cargo.toml", "[package]\nname = \"y\"\n"));
        assert!(read_manifest(&mut project, "rust-toolchain", "1.88.0\n"));
        assert!(read_manifest(&mut project, "rust-toolchain.toml", "[toolchain]\nchannel = \"nightly-2026-09-01\"\n"));
        assert!(read_manifest(&mut project, "go.mod", "module x\n\ngo 1.22\n\ntoolchain go1.22.3\n"));
        assert!(!read_manifest(&mut project, "web/package.json", "not json"));
        assert!(!read_manifest(&mut project, "mise.toml", "[tools\n"));
        assert_eq!(
            project.needs,
            vec![
                need("node", ">=22", NeedKind::Range, "package.json", Some("engines.node")),
                need("bun", "^1.3.0", NeedKind::Range, "package.json", Some("engines.bun")),
                need("pnpm", "9.15.0", NeedKind::Pin, "package.json", Some("packageManager")),
                need("node", "22.17.0", NeedKind::Pin, "package.json", Some("volta.node")),
                need("node", "v22", NeedKind::Pin, ".nvmrc", None),
                need("node", "22.17.0", NeedKind::Pin, ".tool-versions", Some("node")),
                need("go", "1.24.4", NeedKind::Pin, ".tool-versions", Some("go")),
                need("bun", "1.3", NeedKind::Pin, "mise.toml", Some("tools.bun")),
                need("rust", "1.88", NeedKind::Pin, "mise.toml", Some("tools.core:rust")),
                need("python", "3.12", NeedKind::Pin, "mise.toml", Some("tools.python")),
                need("python", ">=3.11,<4", NeedKind::Python, "web/pyproject.toml", Some("requires-python")),
                need("rust", "1.85", NeedKind::Min, "src-tauri/Cargo.toml", Some("rust-version")),
                need("rust", "*", NeedKind::Range, "cli/Cargo.toml", None),
                need("rust", "1.88.0", NeedKind::Pin, "rust-toolchain", Some("channel")),
                need("rust", "nightly-2026-09-01", NeedKind::Pin, "rust-toolchain.toml", Some("channel")),
                need("go", "1.22", NeedKind::Min, "go.mod", Some("go")),
            ]
        );
        let libraries: Vec<(&str, &str, bool)> = project.libraries.iter().map(|library| (library.name.as_str(), library.wants.as_str(), library.dev)).collect();
        assert_eq!(libraries, vec![("@types/node", "^24", false), ("react", "^19.1.0", false), ("typescript", "~5.9.2", true)]);
        assert_eq!(project.packages, vec![PackageDir { dir: String::new(), lockfile: None, modules: None }]);
        let text = format!("{project:?}");
        assert!(!text.contains("SECRET") && !text.contains("deploy"), "only the fields the page shows are kept");
    }

    #[test]
    fn a_scan_reads_tools_kept_versions_and_each_project() {
        let used = HashMap::from([("/src/app".to_string(), 42)]);
        let stdout = [
            "H\t/home/cam".to_string(),
            "U\tLinux\tx86_64".into(),
            "V\tnode\t/home/cam/.nvm/versions/node/v22.17.0/bin/node\tv22.17.0".into(),
            "V\tnode\t/usr/bin/node\tv18.0.0".into(),
            "V\tpnpm\t/usr/bin/pnpm\t".into(),
            "V\tevil\t/usr/bin/evil\t1.0".into(),
            "V\tgit\trelative/git\t2.0".into(),
            "M\tnode\tnvm\tv20.19.0".into(),
            "M\tnode\tnvm\tv20.19.0".into(),
            "M\tpython\tuv\tcpython-3.13.5-linux-x86_64-gnu".into(),
            "M\tpython\tpyenv\tanaconda3-2024".into(),
            "M\trust\trustup\tstable-x86_64-unknown-linux-gnu\trustc 1.88.0 (6b00bc388 2026-06-23)".into(),
            "R\t/src/app\tok".into(),
            "O\thttps://token:x-oauth@github.com/Cam/App.git".into(),
            format!("P\tpackage.json\t80\t{}", b64(r#"{"engines":{"node":">=22"},"dependencies":{"react":"^19.1.0"}}"#)),
            "P\tpyproject.toml\t90000\t-".into(),
            format!("P\t../etc/passwd\t10\t{}", b64("root")),
            "K\tbun.lock".into(),
            "K\tweb/pnpm-lock.yaml".into(),
            format!("P\tweb/package.json\t40\t{}", b64(r#"{"packageManager":"pnpm@10.0.0"}"#)),
            "R\t/src/gone\tmissing".into(),
            "Q".into(),
        ]
        .join("\n");
        let scanned = parse_scan(&stdout, &used);
        assert_eq!(scanned.home_dir, "/home/cam");
        assert_eq!((scanned.os.as_str(), scanned.arch.as_str()), ("Linux", "x86_64"));
        assert!(scanned.partial);
        assert_eq!(
            scanned.tools,
            vec![
                ToolFound { tool: "node".into(), path: "/home/cam/.nvm/versions/node/v22.17.0/bin/node".into(), version: Some("22.17.0".into()), owner: None },
                ToolFound { tool: "pnpm".into(), path: "/usr/bin/pnpm".into(), version: None, owner: None },
            ]
        );
        assert_eq!(
            scanned.kept,
            vec![
                KeptVersion { tool: "node".into(), manager: "nvm".into(), version: "20.19.0".into(), label: None },
                KeptVersion { tool: "python".into(), manager: "uv".into(), version: "3.13.5".into(), label: None },
                KeptVersion { tool: "rust".into(), manager: "rustup".into(), version: "1.88.0".into(), label: Some("stable".into()) },
            ]
        );
        let [app, gone] = scanned.projects.as_slice() else { panic!("two projects") };
        assert_eq!(app.remote.as_deref(), Some("github.com/cam/app"));
        assert_eq!(app.last_used_ms, Some(42));
        assert_eq!(app.unread, vec!["pyproject.toml".to_string()]);
        assert_eq!(
            app.needs,
            vec![
                need("node", ">=22", NeedKind::Range, "package.json", Some("engines.node")),
                need("pnpm", "10.0.0", NeedKind::Pin, "web/package.json", Some("packageManager")),
                need("bun", "*", NeedKind::Range, "bun.lock", None),
            ],
            "a lockfile adds its tool only where nothing else names it"
        );
        assert_eq!(
            app.packages,
            vec![
                PackageDir { dir: String::new(), lockfile: Some("bun.lock".into()), modules: None },
                PackageDir { dir: "web".into(), lockfile: Some("pnpm-lock.yaml".into()), modules: None },
            ]
        );
        assert!(gone.missing && gone.needs.is_empty());
    }

    #[test]
    fn installed_versions_are_looked_up_only_for_safe_names() {
        let mut projects = vec![ProjectToolchain {
            path: "/src/app".into(),
            packages: vec![PackageDir::default(), PackageDir { dir: "web".into(), ..PackageDir::default() }],
            libraries: vec![
                ProjectLibrary { dir: String::new(), name: "react".into(), wants: "^19".into(), dev: false, installed: None, checked: false },
                ProjectLibrary { dir: "web".into(), name: "@types/node".into(), wants: "^24".into(), dev: true, installed: None, checked: false },
                ProjectLibrary { dir: String::new(), name: "../../etc".into(), wants: "1".into(), dev: false, installed: None, checked: false },
            ],
            ..ProjectToolchain::default()
        }];
        let script = packages_script(&projects).unwrap();
        let body = script.split_once("<<'ARBOR_WANT'\n").unwrap().1;
        let lookups: Vec<&str> = body.split_once("ARBOR_WANT\n").unwrap().0.lines().collect();
        assert_eq!(lookups, vec!["/src/app\t.\t", "/src/app\tweb\t", "/src/app\t.\treact", "/src/app\tweb\t@types/node"]);
        let partial = apply_packages(&mut projects, "W\t/src/app\t.\t1\nW\t/src/app\tweb\t0\nN\t/src/app\t.\treact\t19.1.0\nN\t/src/app\tweb\t@types/node\tchangeset version\nN\t/src/other\t.\treact\t1.0.0\n");
        assert!(!partial);
        let [app] = projects.as_slice() else { panic!() };
        assert_eq!(app.packages.iter().map(|package| package.modules).collect::<Vec<_>>(), vec![Some(true), Some(false)]);
        assert_eq!(app.libraries.iter().map(|library| (library.installed.as_deref(), library.checked)).collect::<Vec<_>>(), vec![(Some("19.1.0"), true), (None, true), (None, false)]);
        assert!(packages_script(&[ProjectToolchain { path: "/src/x".into(), missing: true, packages: vec![PackageDir::default()], ..ProjectToolchain::default() }]).is_none());
        assert!(is_package_name("@scope/name.js") && is_package_name("lodash") && !is_package_name("..") && !is_package_name("@scope") && !is_package_name("a/b"));
    }

    #[cfg(unix)]
    mod scripts {
        use super::*;

        fn temp_dir(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("arbor-toolchain-{name}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            dir.canonicalize().unwrap()
        }

        fn write(path: &Path, text: &str) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }

        fn fake(path: &Path, body: &str) {
            write(path, &format!("#!/bin/sh\n{body}\n"));
            fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        }

        fn run(shell: &str, home: &Path, script: &str) -> String {
            let mut command = tokio::process::Command::new(shell);
            command
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let output = tokio::runtime::Runtime::new().unwrap().block_on(run_script(command, script, Duration::from_secs(60))).unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8_lossy(&output.stdout).into_owned()
        }

        /// Everything under a folder with its size, to show a scan changed nothing.
        fn listing(root: &Path) -> Vec<(PathBuf, u64)> {
            let mut found = Vec::new();
            let mut stack = vec![root.to_path_buf()];
            while let Some(dir) = stack.pop() {
                for entry in fs::read_dir(&dir).unwrap().flatten() {
                    let meta = fs::symlink_metadata(entry.path()).unwrap();
                    if meta.is_dir() {
                        stack.push(entry.path());
                    }
                    found.push((entry.path(), meta.len()));
                }
            }
            found.sort();
            found
        }

        #[test]
        fn a_scan_finds_the_default_tools_and_reads_projects_without_changing_anything() {
            for shell in shells() {
                let root = temp_dir(shell);
                let home = root.join("home");
                let bin = home.join(".local/bin");
                // nvm's default comes before anything else on PATH, as it does in a shell with nvm loaded.
                fake(&bin.join("node"), "echo v18.0.0");
                fake(&home.join(".nvm/versions/node/v20.19.0/bin/node"), "echo v20.19.0");
                fake(&home.join(".nvm/versions/node/v22.17.0/bin/node"), "echo v22.17.0");
                write(&home.join(".nvm/alias/default"), "20\n");
                // A check that reads stdin gets nothing, and one that hangs is stopped.
                fake(&bin.join("bun"), "cat >/dev/null; echo 1.3.2");
                fake(&bin.join("pnpm"), "sleep 30; echo 10.0.0");
                fake(&bin.join("python3"), "echo Python 3.13.5 >&2");
                // A check that fails says nothing, even when its error has a version in it.
                fake(&bin.join("deno"), "echo 'mise use -g deno@2.4.0'; exit 1");
                // Go's version comes from its VERSION file: running go writes telemetry.
                fake(&home.join("goroot/bin/go"), "touch \"$HOME/go-ran\"; echo go version go1.99.0");
                write(&home.join("goroot/VERSION"), "go1.24.4\ntime 2026-06-01T00:00:00Z\n");
                std::os::unix::fs::symlink(home.join("goroot/bin/go"), bin.join("go")).unwrap();
                // A Volta shim can download what it's missing, so it isn't run.
                fake(&home.join(".volta/bin/yarn"), "touch \"$HOME/yarn-ran\"; echo 1.22.22");
                fake(&home.join(".rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc"), "echo 'rustc 1.88.0 (6b00bc388 2026-06-23)'");
                fs::create_dir_all(home.join(".local/share/mise/installs/python/3.12.4")).unwrap();
                std::os::unix::fs::symlink(home.join(".local/share/mise/installs/python/3.12.4"), home.join(".local/share/mise/installs/python/3.12")).unwrap();
                fs::create_dir_all(home.join("Cellar/node@22/22.17.0")).unwrap();

                let app = root.join("app");
                write(&app.join("package.json"), r#"{"engines":{"node":">=22"},"dependencies":{"react":"^19.1.0"}}"#);
                write(&app.join(".nvmrc"), "22\n");
                write(&app.join("bun.lock"), "{}");
                write(&app.join("src-tauri/Cargo.toml"), "[package]\nname = \"x\"\nrust-version = \"1.85\"\n");
                write(&app.join("node_modules/react/package.json"), "{\n  \"scripts\": { \"version\": \"npm run build && git add -A\" },\n  \"name\": \"react\",\n  \"version\": \"19.1.0\"\n}\n");
                // A folder whose name could pass for lines of the scan's own.
                write(&app.join("a\nH\t/spoofed\nz/package.json"), r#"{"engines":{"node":"1"}}"#);
                write(&app.join("node_modules/lodash/package.json"), "{\"version\": \"4.17.21\"}");
                write(&app.join("pyproject.toml"), &format!("[project]\ndescription = \"{}\"\n", "x".repeat(70_000)));
                write(&root.join("outside/.python-version"), "3.9\n");
                std::os::unix::fs::symlink(root.join("outside/.python-version"), app.join(".python-version")).unwrap();
                let status = std::process::Command::new("git").args(["init", "-q"]).current_dir(&app).env_clear().env("HOME", &home).env("PATH", "/usr/bin:/bin:/opt/homebrew/bin").status().unwrap();
                assert!(status.success());
                let status = std::process::Command::new("git")
                    .args(["remote", "add", "origin", "https://me:hunter2@github.com/me/App.git?x=1"])
                    .current_dir(&app)
                    .env_clear()
                    .env("HOME", &home)
                    .env("PATH", "/usr/bin:/bin:/opt/homebrew/bin")
                    .status()
                    .unwrap();
                assert!(status.success());

                let before = listing(&root);
                let paths = format!("PATH=\"{}:{}:/usr/bin:/bin\"\ncellars=\"{}\"\n", bin.display(), home.join(".volta/bin").display(), home.join("Cellar").display());
                let started = std::time::Instant::now();
                let script = scan_script(&paths, &[app.display().to_string(), root.join("gone").display().to_string()]).replace(&format!("probe_s={PROBE_S}"), "probe_s=1");
                let stdout = run(shell, &home, &script);
                assert!(started.elapsed() < Duration::from_secs(20), "a hung check doesn't hold the scan up");
                assert!(!stdout.contains("hunter2"));
                let mut scanned = parse_scan(&stdout, &HashMap::new());
                let tool = |name: &str| scanned.tools.iter().find(|found| found.tool == name).map(|found| (found.path.clone(), found.version.clone()));
                assert_eq!(tool("node"), Some((home.join(".nvm/versions/node/v20.19.0/bin/node").display().to_string(), Some("20.19.0".into()))), "{shell}");
                assert_eq!(tool("bun").and_then(|found| found.1).as_deref(), Some("1.3.2"));
                assert_eq!(tool("pnpm").map(|found| found.1), Some(None));
                assert_eq!(tool("python").and_then(|found| found.1).as_deref(), Some("3.13.5"));
                assert_eq!(tool("deno").map(|found| found.1), Some(None));
                assert_eq!(tool("go").and_then(|found| found.1).as_deref(), Some("1.24.4"));
                assert_eq!(tool("yarn").map(|found| found.1), Some(None));
                assert!(!home.join("go-ran").exists() && !home.join("yarn-ran").exists(), "{shell}: go and a Volta shim weren't run");
                assert_eq!(scanned.home_dir, home.display().to_string());
                let kept: Vec<(&str, &str, &str)> = scanned.kept.iter().map(|kept| (kept.tool.as_str(), kept.manager.as_str(), kept.version.as_str())).collect();
                assert_eq!(
                    kept,
                    vec![("node", "nvm", "20.19.0"), ("node", "nvm", "22.17.0"), ("python", "mise", "3.12.4"), ("node", "brew", "22.17.0"), ("rust", "rustup", "1.88.0")],
                    "{shell}"
                );
                let [project, gone] = scanned.projects.as_slice() else { panic!("{stdout}") };
                assert!(gone.missing);
                assert_eq!(project.remote.as_deref(), Some("github.com/me/app"));
                assert_eq!(project.unread, vec!["pyproject.toml".to_string()]);
                let needs: Vec<(&str, &str, &str)> = project.needs.iter().map(|need| (need.tool.as_str(), need.wants.as_str(), need.file.as_str())).collect();
                assert_eq!(
                    needs,
                    vec![("node", ">=22", "package.json"), ("node", "22", ".nvmrc"), ("rust", "1.85", "src-tauri/Cargo.toml"), ("bun", "*", "bun.lock")],
                    "a linked file outside the checkout isn't read"
                );

                let packages = packages_script(&scanned.projects).unwrap();
                let stdout = run(shell, &home, &packages);
                assert!(!apply_packages(&mut scanned.projects, &stdout));
                let project = &scanned.projects[0];
                assert_eq!(project.packages[0].modules, Some(true));
                assert_eq!(project.libraries[0].installed.as_deref(), Some("19.1.0"));
                assert_eq!(listing(&root), before, "{shell}: the scan changed nothing");
                fs::remove_dir_all(&root).ok();
            }
        }

        #[test]
        fn a_scan_proves_who_installed_each_tool() {
            for shell in shells() {
                let root = temp_dir(&format!("owners-{shell}"));
                let home = root.join("home");
                let bin = home.join(".local/bin");
                // Homebrew's uv, linked from its keg into the prefix's bin.
                let brew = home.join("brew");
                fake(&brew.join("Cellar/uv/0.8.3/bin/uv"), "echo uv 0.8.3");
                fs::create_dir_all(brew.join("bin")).unwrap();
                std::os::unix::fs::symlink(brew.join("Cellar/uv/0.8.3/bin/uv"), brew.join("bin/uv")).unwrap();
                fake(&brew.join("bin/brew"), &format!("cat >/dev/null; [ \"$1\" = --prefix ] && echo '{}'", brew.display()));
                // mise's shim, which mise says gives python from its installs.
                let shims = home.join(".local/share/mise/shims");
                let python = home.join(".local/share/mise/installs/python/3.12.4/bin/python3");
                fake(&python, "echo Python 3.12.4");
                fake(&shims.join("python3"), "echo Python 3.12.4");
                fake(&bin.join("mise"), &format!("[ \"$1 $2\" = 'which --plugin' ] && {{ echo python; exit 0; }}; [ \"$1\" = which ] && echo '{}'", python.display()));
                // rustup's proxies beside rustup.
                let cargo = home.join(".cargo/bin");
                fake(&cargo.join("rustup"), "echo 'rustc 1.88.0 (6b00bc388 2026-06-23)'");
                std::os::unix::fs::symlink(cargo.join("rustup"), cargo.join("rustc")).unwrap();
                // A bun nothing proves.
                fake(&bin.join("bun"), "echo 1.3.2");
                write(&home.join(".config/uv/uv-receipt.json"), "{}");

                let paths = format!("PATH=\"{}:{}:/usr/bin:/bin\"\ncellars=\"\"\n", bin.display(), brew.join("bin").display());
                let stdout = run(shell, &home, &scan_script(&paths, &[]));
                let scanned = parse_scan(&stdout, &HashMap::new());
                let owner = |name: &str| {
                    let found = scanned.tools.iter().find(|found| found.tool == name)?;
                    let owner = found.owner.as_ref()?;
                    Some((format!("{:?}", owner.kind()), owner.name().map(str::to_string)))
                };
                assert_eq!(owner("uv"), Some(("Brew".into(), Some("uv".into()))), "{shell}: {stdout}");
                assert_eq!(owner("python"), Some(("Mise".into(), Some("python".into()))), "{shell}: {stdout}");
                assert_eq!(owner("rust"), Some(("Rustup".into(), None)), "{shell}: {stdout}");
                assert_eq!(owner("bun"), None, "{shell}");
                assert!(scanned.facts.uv_receipt);
                fs::remove_dir_all(&root).ok();
            }
        }

        #[test]
        fn node_changes_run_through_each_version_manager_and_say_how_each_went() {
            for shell in shells() {
                let root = temp_dir(&format!("node-{shell}"));
                let home = root.join("home");
                // nvm is a shell function its script defines; fnm and mise are programs.
                write(&home.join(".nvm/nvm.sh"), "nvm() { echo \"nvm $*\" >> \"$HOME/ran\"; }\n");
                fake(&home.join(".local/bin/fnm"), "cat >/dev/null; echo \"fnm $*\" >> \"$HOME/ran\"");
                fake(&home.join(".local/bin/mise"), "echo \"mise $*\" >> \"$HOME/ran\"; echo 'mise ERROR no such version' >&2; exit 1");
                let change = |manager: &str, version: &str, action| NodeChange { manager: manager.into(), version: version.into(), action };
                let changes = [
                    change("nvm", "v20.19.0", NodeAction::Uninstall),
                    change("fnm", "22", NodeAction::Install),
                    change("mise", "24.1.0", NodeAction::SetDefault),
                ];
                let stdout = run(shell, &home, &node_script(&changes));
                let results = parse_node_results(&stdout, &changes);
                assert_eq!(results.iter().map(|result| result.ok).collect::<Vec<_>>(), [true, true, false], "{shell}: {stdout}");
                assert_eq!(results[2].message.as_deref(), Some("mise ERROR no such version"));
                let ran = fs::read_to_string(home.join("ran")).unwrap();
                assert_eq!(ran, "nvm uninstall v20.19.0\nfnm install 22\nmise use --global node@24.1.0\n", "{shell}");
                fs::remove_dir_all(&root).ok();
            }
        }
    }

    #[test]
    fn node_changes_are_checked_against_the_last_scan() {
        let kept = |manager: &str, version: &str| KeptVersion { tool: "node".into(), manager: manager.into(), version: version.into(), label: None };
        let scan = MachineToolchain {
            machine: "cedar".into(),
            scanned_at: Some(1),
            tools: vec![ToolFound { tool: "node".into(), path: "/Users/a/.nvm/versions/node/v22.17.0/bin/node".into(), version: Some("22.17.0".into()), owner: None }],
            kept: vec![kept("nvm", "v22.17.0"), kept("nvm", "v18.20.0"), kept("volta", "20.1.0")],
            ..MachineToolchain::default()
        };
        let change = |manager: &str, version: &str, action| NodeChange { manager: manager.into(), version: version.into(), action };
        assert!(plan_node_changes(&scan, &[change("nvm", "v18.20.0", NodeAction::Uninstall), change("nvm", "24", NodeAction::Install)]).is_ok());
        // The default isn't removed, only what's kept is changed, and nothing but a version is passed on.
        assert!(plan_node_changes(&scan, &[change("nvm", "v22.17.0", NodeAction::Uninstall)]).unwrap_err().contains("default"));
        assert!(plan_node_changes(&scan, &[change("nvm", "v16.0.0", NodeAction::SetDefault)]).unwrap_err().contains("Scan again"));
        assert!(plan_node_changes(&scan, &[change("nvm", "22; rm -rf ~", NodeAction::Install)]).is_err());
        assert!(plan_node_changes(&scan, &[change("nvm", "lts/*", NodeAction::Install)]).is_err());
        assert!(plan_node_changes(&scan, &[change("brew", "22", NodeAction::Install)]).is_err());
        assert!(plan_node_changes(&scan, &[change("volta", "20.1.0", NodeAction::Uninstall)]).unwrap_err().contains("Volta"));
        assert!(plan_node_changes(&scan, &[]).is_err());
        // mise's shim hides the version in its path; the version node gave says which is the default.
        let shimmed = MachineToolchain {
            tools: vec![ToolFound { tool: "node".into(), path: "/Users/a/.local/share/mise/shims/node".into(), version: Some("24.1.0".into()), owner: None }],
            kept: vec![kept("mise", "24.1.0"), kept("mise", "22.0.0")],
            ..scan
        };
        assert!(plan_node_changes(&shimmed, &[change("mise", "24.1.0", NodeAction::Uninstall)]).is_err());
        assert!(plan_node_changes(&shimmed, &[change("mise", "22.0.0", NodeAction::Uninstall)]).is_ok());
    }
}

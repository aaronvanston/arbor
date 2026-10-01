#!/usr/bin/env bash
# Sets up this Mac as the Release workflow's runner (.github/workflows/arbor-release.yml): a self-hosted GitHub Actions
# runner for aaronvanston/arbor, labeled arbor-release, run at login as a LaunchAgent. GitHub bills a private
# repository's hosted minutes, so the nightly and stable builds run here instead. Needs gh signed in as the repository's
# owner, and the build's tools on this Mac: node, cargo, uvx and git (the workflow installs bun itself). Run it again to
# update the runner or pick up a tool that moved; it keeps the registration.
set -euo pipefail

fail() {
  echo "$1" >&2
  exit 1
}

repository="aaronvanston/arbor"
install_dir="$HOME/.arbor/release-runner"
[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || fail "The release runner builds the Apple silicon DMG, so it runs on an Apple silicon Mac."

# The LaunchAgent starts with a bare PATH, and some of these come from version managers whose shell paths change each
# session, so each tool's real folder is written into the runner's PATH. A Homebrew tool keeps its link folder, since
# its real one changes with every upgrade.
tool_dirs=()
for tool in node cargo uvx git gh; do
  found="$(command -v "$tool" 2>/dev/null)" || fail "$tool isn't installed; the release build needs it."
  real="$(realpath "$found")"
  [[ "$real" == */Cellar/* ]] && real="$found"
  tool_dirs+=("$(dirname "$real")")
done
runner_path="$(printf '%s\n' "${tool_dirs[@]}" "$HOME/.bun/bin" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin | awk '!seen[$0]++' | paste -sd: -)"

release="$(gh api repos/actions/runner/releases/latest)"
version="$(jq -r '.tag_name | ltrimstr("v")' <<< "$release")"
expected_sha="$(jq -r '.body' <<< "$release" | sed -n 's/.*<!-- BEGIN SHA osx-arm64 -->\([0-9a-f]*\)<!-- END SHA osx-arm64 -->.*/\1/p')"
[[ -n "$expected_sha" ]] || fail "Couldn't find the checksum for runner $version."

mkdir -p "$install_dir"
cd "$install_dir"
if [[ "$(cat .runner-version 2>/dev/null)" != "$version" ]]; then
  [[ -f .runner ]] && ./svc.sh stop >/dev/null 2>&1 || true
  archive="actions-runner-osx-arm64-$version.tar.gz"
  curl -fsSL --retry 3 -o "$archive" "https://github.com/actions/runner/releases/download/v$version/$archive"
  [[ "$(shasum -a 256 "$archive" | awk '{print $1}')" == "$expected_sha" ]] || { rm -f "$archive"; fail "Runner $version's download didn't match its checksum."; }
  tar -xzf "$archive"
  rm -f "$archive"
  echo "$version" > .runner-version
fi

if [[ ! -f .runner ]]; then
  token="$(gh api -X POST "repos/$repository/actions/runners/registration-token" --jq .token)"
  ./config.sh --unattended --replace --url "https://github.com/$repository" --token "$token" \
    --name "$(scutil --get LocalHostName)-arbor-release" --labels arbor-release --work _work
fi

printf '%s\n' "$runner_path" > .path
if ./svc.sh status 2>/dev/null | grep -q 'not installed'; then
  ./svc.sh install
fi
./svc.sh stop >/dev/null 2>&1 || true
./svc.sh start

echo "The release runner (actions runner $version) is running from $install_dir; logs are in $install_dir/_diag."

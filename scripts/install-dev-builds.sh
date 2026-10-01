#!/usr/bin/env bash
# Sets this Mac up to build main for the dev update channel: a clone of Arbor to build in, and a LaunchAgent that runs
# scripts/dev-build.sh every ten minutes and when "Build latest main" asks. Then pick Dev in Settings › Updates. Only
# a Mac that can sign releases (node scripts/release-signing.mjs check) can build for it.
#
#   ./scripts/install-dev-builds.sh              sets up, or updates the installed scripts
#   ./scripts/install-dev-builds.sh --uninstall  stops the builder (its builds and clone stay)
set -euo pipefail

repo_dir="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --path-format=absolute --git-common-dir | sed 's#/\.git$##')"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install_dir="$HOME/.arbor/dev-build"
checkout="$install_dir/checkout"
feed_dir="$HOME/Library/Application Support/Arbor Dev Builds"
log_dir="$HOME/Library/Logs/Arbor"
label="onl.arbor.dev-build"
agent_path="$HOME/Library/LaunchAgents/$label.plist"
user_domain="gui/$(id -u)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$user_domain/$label" 2>/dev/null || true
  rm -f "$agent_path"
  echo "Stopped the dev builder. Its builds stay in $feed_dir and its clone in $checkout; delete them if you like."
  echo "Switch Settings › Updates back to Stable or Nightly."
  exit 0
fi

if ! node "$script_dir/release-signing.mjs" check; then
  echo "This Mac can't sign Arbor's update lists, so the app wouldn't take its builds. Set up dev builds on the Mac" >&2
  echo "that publishes releases." >&2
  exit 1
fi
if [[ ! -f "$repo_dir/.env" ]]; then
  echo "Warning: $repo_dir/.env isn't there, so builds get the free icons and no usage data key and will stop." >&2
fi

# Builds need bun, node, cargo, uv (for the DMG's window) and git, which launchd's bare PATH doesn't have.
agent_path_dirs=""
for tool in bun node cargo uvx git; do
  found="$(command -v "$tool" || true)"
  if [[ -z "$found" ]]; then
    [[ "$tool" == uvx ]] && continue
    echo "$tool isn't on your PATH; install it first." >&2
    exit 1
  fi
  dir="$(dirname "$found")"
  [[ ":$agent_path_dirs:" == *":$dir:"* ]] || agent_path_dirs="${agent_path_dirs:+$agent_path_dirs:}$dir"
done
agent_path_dirs="$agent_path_dirs:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$install_dir" "$feed_dir/logs" "$log_dir" "$(dirname "$agent_path")"
# Its own clone, not a worktree: nothing that tidies worktrees can take it, and it shares no stash.
if [[ ! -d "$checkout/.git" ]]; then
  git clone --quiet --no-checkout "$repo_dir" "$checkout"
  git -C "$checkout" remote set-url origin "$(git -C "$repo_dir" remote get-url origin)"
  git -C "$checkout" fetch --quiet origin main
  git -C "$checkout" checkout --quiet --detach origin/main
fi
for file in dev-build.sh dev-build.mjs; do
  install -m 755 "$script_dir/$file" "$install_dir/$file"
done

cat > "$agent_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${install_dir}/dev-build.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ARBOR_REPO</key>
    <string>${repo_dir}</string>
    <key>ARBOR_DEV_CHECKOUT</key>
    <string>${checkout}</string>
    <key>ARBOR_DEV_INSTALL_DIR</key>
    <string>${install_dir}</string>
    <key>PATH</key>
    <string>${agent_path_dirs}</string>
  </dict>
  <key>StartInterval</key>
  <integer>600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${log_dir}/dev-build.log</string>
  <key>StandardErrorPath</key>
  <string>${log_dir}/dev-build.log</string>
</dict>
</plist>
PLIST

plutil -lint "$agent_path" >/dev/null
launchctl bootout "$user_domain/$label" 2>/dev/null || true
launchctl bootstrap "$user_domain" "$agent_path"

echo "Dev builds are set up: main is built in $checkout after it changes, into $feed_dir."
echo "Pick Dev in Arbor's Settings › Updates to take them. Builder log: $log_dir/dev-build.log"

#!/usr/bin/env bash
# Runs scripts/clean-dev-disk.sh every six hours, and at login, so build folders, finished worktrees and old feed DMGs
# never pile up until the disk is full. The script is copied out of the repo first, since the worktree this runs from
# may be one it later removes. Run this again after changing the script; logs go to ~/Library/Logs/Arbor.
set -euo pipefail

repo_dir="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --path-format=absolute --git-common-dir | sed 's#/\.git$##')"
install_dir="$HOME/.arbor/dev"
log_dir="$HOME/Library/Logs/Arbor"
label="com.arbor.dev-disk-cleanup"
agent_path="$HOME/Library/LaunchAgents/$label.plist"
user_domain="gui/$(id -u)"

mkdir -p "$install_dir" "$log_dir" "$(dirname "$agent_path")"
install -m 755 "$(dirname "${BASH_SOURCE[0]}")/clean-dev-disk.sh" "$install_dir/clean-dev-disk.sh"

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
    <string>${install_dir}/clean-dev-disk.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ARBOR_REPO</key>
    <string>${repo_dir}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartInterval</key>
  <integer>21600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${log_dir}/dev-disk-cleanup.log</string>
  <key>StandardErrorPath</key>
  <string>${log_dir}/dev-disk-cleanup.log</string>
</dict>
</plist>
PLIST

plutil -lint "$agent_path" >/dev/null
launchctl bootout "$user_domain/$label" 2>/dev/null || true
launchctl bootstrap "$user_domain" "$agent_path"

echo "Disk cleanup runs every 6 hours for $repo_dir; log: $log_dir/dev-disk-cleanup.log"

#!/usr/bin/env bash
set -euo pipefail

feed_dir="$HOME/Library/Application Support/Arbor Updates"
log_dir="$HOME/Library/Logs/Arbor"
agent_path="$HOME/Library/LaunchAgents/com.cpa.gui.custom-update-server.plist"
user_domain="gui/$(id -u)"

mkdir -p "$feed_dir" "$log_dir" "$(dirname "$agent_path")"

cat > "$agent_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cpa.gui.custom-update-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>-m</string>
    <string>http.server</string>
    <string>8321</string>
    <string>--bind</string>
    <string>127.0.0.1</string>
    <string>--directory</string>
    <string>${feed_dir}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log_dir}/update-server.log</string>
  <key>StandardErrorPath</key>
  <string>${log_dir}/update-server-error.log</string>
</dict>
</plist>
PLIST

plutil -lint "$agent_path" >/dev/null
launchctl bootout "$user_domain/com.cpa.gui.custom-update-server" 2>/dev/null || true
launchctl bootstrap "$user_domain" "$agent_path"
launchctl kickstart -k "$user_domain/com.cpa.gui.custom-update-server"

echo "Local update feed is running at http://127.0.0.1:8321/"
echo "Feed directory: $feed_dir"

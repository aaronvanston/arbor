#!/bin/sh
# Installs the latest stable Arbor into /Applications (or ARBOR_INSTALL_DIR), for people who run
#   curl -fsSL https://arbor.onl/install.sh | sh
# Builds aren't notarized, and macOS blocks a quarantined DMG and the app copied out of it until the user finds Open
# Anyway. A browser marks its downloads quarantined; curl doesn't, so a DMG fetched here opens without either prompt.
# The DMG is checked against the SHA-256 in the release's update list before anything is mounted.
# POSIX sh, and everything runs from main at the end, so a download cut short by the pipe runs nothing.
set -eu

repository="aaronvanston/arbor"
feed_url="https://github.com/$repository/releases/latest/download/arbor-update-darwin.json"
install_dir="${ARBOR_INSTALL_DIR:-/Applications}"

fail() {
  echo "arbor install: $1" >&2
  exit 1
}

# A string at `keypath` in a JSON file; plutil reads JSON and ships with every macOS, unlike jq before macOS 15.
json_string() {
  plutil -extract "$2" raw -o - "$1" 2>/dev/null
}

main() {
  [ "$(uname -s)" = "Darwin" ] || fail "Arbor runs on macOS only."
  # uname -m says x86_64 under Rosetta, so ask the hardware.
  [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ] || fail "Arbor needs a Mac with Apple silicon."
  if pgrep -f "$install_dir/Arbor.app/Contents/MacOS/" >/dev/null 2>&1; then
    fail "Arbor is open. Quit it from its menu bar icon, then run this again."
  fi

  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/arbor-install.XXXXXX")"
  mount_dir="$work_dir/mount"
  trap 'hdiutil detach -quiet "$mount_dir" 2>/dev/null || true; rm -rf "$work_dir"' EXIT
  trap 'exit 1' INT TERM HUP

  echo "Finding the latest Arbor release…"
  curl -fsSL --retry 3 "$feed_url" -o "$work_dir/feed.json" || fail "Couldn't download $feed_url."
  json_string "$work_dir/feed.json" manifest > "$work_dir/manifest.json" || fail "The release's update list isn't readable."
  version="$(json_string "$work_dir/manifest.json" version)" || fail "The update list names no version."
  dmg_url="$(json_string "$work_dir/manifest.json" assets.darwin-aarch64.url)" || fail "The update list names no DMG."
  expected_sha="$(json_string "$work_dir/manifest.json" assets.darwin-aarch64.sha256)" || fail "The update list has no SHA-256."

  echo "Downloading Arbor ${version}…"
  dmg_path="$work_dir/Arbor.dmg"
  curl -fL --retry 3 --progress-bar "$dmg_url" -o "$dmg_path" || fail "Couldn't download $dmg_url."
  actual_sha="$(shasum -a 256 "$dmg_path" | awk '{print $1}')"
  [ "$actual_sha" = "$expected_sha" ] || fail "The download doesn't match the release's SHA-256, so nothing was installed. Try again."

  mkdir -p "$mount_dir"
  hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$mount_dir" "$dmg_path" || fail "Couldn't open the DMG."
  [ -d "$mount_dir/Arbor.app" ] || fail "The DMG has no Arbor.app."

  # Copy beside the old app, then swap, so a failed copy leaves the installed Arbor as it was.
  mkdir -p "$install_dir" 2>/dev/null || true
  sudo_cmd=""
  if [ ! -w "$install_dir" ]; then
    echo "$install_dir needs an administrator password."
    sudo_cmd="sudo"
  fi
  staged="$install_dir/.Arbor.app.installing"
  $sudo_cmd rm -rf "$staged"
  $sudo_cmd ditto "$mount_dir/Arbor.app" "$staged" || fail "Couldn't copy Arbor.app into $install_dir."
  $sudo_cmd xattr -dr com.apple.quarantine "$staged" 2>/dev/null || true
  $sudo_cmd rm -rf "$install_dir/Arbor.app"
  $sudo_cmd mv "$staged" "$install_dir/Arbor.app"

  # The app's updater swaps Arbor.app inside its folder as the user, so it can't update a folder that needed sudo.
  if [ -n "$sudo_cmd" ]; then
    echo "Installed Arbor $version in $install_dir. Arbor can't update itself there, because the folder needs an administrator password. Run this again to update it, or install into a folder you own with ARBOR_INSTALL_DIR=\"\$HOME/Applications\"."
  else
    echo "Installed Arbor $version in $install_dir. Open it from there; it updates itself from now on."
  fi
}

main "$@"

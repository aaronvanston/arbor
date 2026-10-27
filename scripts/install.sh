#!/bin/sh
# Installs the latest stable Arbor, for people who run
#   curl -fsSL https://arbor.onl/install.sh | sh
# Builds aren't notarized, and macOS blocks a quarantined DMG and the app copied out of it until the user finds Open
# Anyway. A browser marks its downloads quarantined; curl doesn't, so a DMG fetched here opens without either prompt.
# The DMG is checked against the SHA-256 in the release's update list before anything is mounted.
# Arbor updates itself by swapping Arbor.app inside its folder as the user, so it has to live in a folder the user can
# write to. An update goes where Arbor already is, if the user can write there; a first install goes into /Applications
# when the user can write there (admins can) and ~/Applications when they can't, so it never needs sudo. Only a folder
# named with --dir or ARBOR_INSTALL_DIR can need an administrator's password, and then Arbor can't update itself there.
# POSIX sh, and everything runs from main at the end, so a download cut short by the pipe runs nothing.
set -eu

repository="aaronvanston/arbor"
feed_url="https://github.com/$repository/releases/latest/download/arbor-update-darwin.json"
# Tests point this at a temp folder, so they never touch the real /Applications.
system_dir="${ARBOR_SYSTEM_APPLICATIONS:-/Applications}"
user_dir="$HOME/Applications"
# Options go after `sh -s --`: a variable typed before curl reaches curl, not this script.
own_folder_install="  curl -fsSL https://arbor.onl/install.sh | sh -s -- --dir ~/Applications"

fail() {
  echo "arbor install: $1" >&2
  exit 1
}

# A string at `keypath` in a JSON file; plutil reads JSON and ships with every macOS, unlike jq before macOS 15.
json_string() {
  plutil -extract "$2" raw -o - "$1" 2>/dev/null
}

# A folder as an absolute path with links resolved, so two spellings of one folder compare equal. One that doesn't
# exist yet is made absolute without resolving.
real_dir() {
  if [ -d "$1" ]; then
    (cd "$1" && pwd -P)
  else
    case "$1" in /*) dir="$1" ;; *) dir="$PWD/$1" ;; esac
    echo "${dir%/}"
  fi
}

# Where Arbor already is, in a folder the user can write to; otherwise /Applications if they can write there, or
# ~/Applications. A copy in a folder they can't write to is left where it is and pointed out at the end.
pick_install_dir() {
  for dir in "$system_dir" "$user_dir"; do
    if [ -d "$dir/Arbor.app" ] && [ -w "$dir" ]; then
      echo "$dir"
      return
    fi
  done
  if [ -w "$system_dir" ]; then echo "$system_dir"; else echo "$user_dir"; fi
}

# Whether this user has Arbor open from the folder. pgrep reads its pattern as a regex, so the folder's own
# characters are escaped.
arbor_open_in() {
  pattern="$(printf '%s' "$1/Arbor.app/Contents/MacOS/" | sed 's/[][\\.*^$+?(){}|]/\\&/g')"
  pgrep -U "$(id -u)" -f "$pattern" >/dev/null 2>&1
}

main() {
  named_dir="${ARBOR_INSTALL_DIR:-}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir)
        [ $# -ge 2 ] && [ -n "$2" ] || fail "--dir needs a folder."
        named_dir="$2"
        shift
        ;;
      --dir=*)
        named_dir="${1#--dir=}"
        [ -n "$named_dir" ] || fail "--dir needs a folder."
        ;;
      *) fail "$1 isn't an option. Use --dir <folder> to choose where Arbor goes." ;;
    esac
    shift
  done
  # The shell doesn't expand ~ after --dir=, so do it here.
  case "$named_dir" in
    "~") named_dir="$HOME" ;;
    "~/"*) named_dir="$HOME/${named_dir#"~/"}" ;;
  esac

  [ "$(uname -s)" = "Darwin" ] || fail "Arbor runs on macOS only."
  # uname -m says x86_64 under Rosetta, so ask the hardware.
  [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ] || fail "Arbor needs a Mac with Apple silicon."

  if [ -n "$named_dir" ]; then
    install_dir="$named_dir"
  else
    # Root can write anywhere, and Arbor couldn't update the copy it left.
    [ "$(id -u)" != 0 ] || fail "Run this without sudo, so Arbor goes in a folder where it can update itself."
    install_dir="$(pick_install_dir)"
    if [ "$install_dir" = "$user_dir" ] && [ ! -d "$user_dir/Arbor.app" ]; then
      echo "Installing into $user_dir, because $system_dir needs an administrator password."
    fi
  fi

  # Settled before downloading, so a folder that can't be used fails fast.
  mkdir -p "$install_dir" 2>/dev/null || true
  sudo_cmd=""
  if [ ! -w "$install_dir" ]; then
    [ -n "$named_dir" ] || fail "Couldn't write to $install_dir. Choose a folder you own with --dir."
    echo "$install_dir needs an administrator password."
    sudo_cmd="sudo"
    # Standard users can't use sudo, and they're the ones who end up here, so say where they can install instead.
    sudo true || fail "Couldn't get an administrator's permission for $install_dir. Install Arbor into a folder you own instead:
$own_folder_install"
    sudo mkdir -p "$install_dir"
  fi
  install_dir="$(real_dir "$install_dir")"
  system_real="$(real_dir "$system_dir")"
  user_real="$(real_dir "$user_dir")"
  for dir in "$install_dir" "$system_real" "$user_real"; do
    arbor_open_in "$dir" && fail "Arbor is open. Quit it from its menu bar icon, then run this again."
  done

  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/arbor-install.XXXXXX")"
  mount_dir="$work_dir/mount"
  staged="$install_dir/.Arbor.app.installing-$$"
  old="$install_dir/.Arbor.app.replaced-$$"
  # A staged copy only exists until it becomes Arbor.app, so one still here at exit is from a failed install.
  trap 'hdiutil detach -quiet "$mount_dir" 2>/dev/null || true; rm -rf "$work_dir"; $sudo_cmd rm -rf "$staged" 2>/dev/null || true' EXIT
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

  # Copy beside the old app, then swap, so a failed copy leaves the installed Arbor as it was. The old app is moved
  # aside rather than deleted first: renaming needs only the folder, so an Arbor.app someone else owns is replaced
  # too, and a failed swap can put it back.
  $sudo_cmd ditto "$mount_dir/Arbor.app" "$staged" || fail "Couldn't copy Arbor.app into $install_dir."
  $sudo_cmd xattr -dr com.apple.quarantine "$staged" 2>/dev/null || true
  if [ -e "$install_dir/Arbor.app" ]; then
    $sudo_cmd mv "$install_dir/Arbor.app" "$old" || fail "Couldn't move the installed Arbor.app aside in $install_dir."
  fi
  if ! $sudo_cmd mv "$staged" "$install_dir/Arbor.app"; then
    [ ! -e "$old" ] || $sudo_cmd mv "$old" "$install_dir/Arbor.app" || true
    fail "Couldn't put the new Arbor.app in $install_dir, so the installed one was left as it was."
  fi
  leftover=""
  if [ -e "$old" ]; then
    $sudo_cmd rm -rf "$old" 2>/dev/null || leftover="$old"
  fi

  # The app's updater swaps Arbor.app inside its folder as the user, so it can't update a copy installed as root.
  if [ -n "$sudo_cmd" ] || [ "$(id -u)" = 0 ]; then
    echo "Installed Arbor $version in $install_dir. Open it from there."
    echo "Arbor can't update itself there, because it was installed with an administrator's password. Run this again with the same folder to update it, or install it into a folder you own:"
    echo "$own_folder_install"
  else
    echo "Installed Arbor $version in $install_dir. Open it from there; it updates itself from now on."
  fi
  if [ -n "$leftover" ]; then
    echo "The old copy couldn't be deleted. An administrator can remove it with: sudo rm -rf \"$leftover\""
  fi
  for dir in "$system_real" "$user_real"; do
    if [ "$dir" != "$install_dir" ] && [ -d "$dir/Arbor.app" ]; then
      echo "There's another Arbor in $dir. Delete it (it may ask for an administrator's password), so Spotlight, the Dock and Open at login use this one."
    fi
  done
}

main "$@"

#!/usr/bin/env bash
# Builds Arbor's DMG for a release from this checkout: the core release pinned in core-version.txt, the core plugin and
# the app, signed ad hoc. It sets the version in the Cargo files and writes portable-app.json; checking the code first
# is the caller's job. The Release workflow (.github/workflows/arbor-release.yml) runs it on its macOS runner,
# and publish-local-update.sh does in an emergency.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: ./scripts/build-release.sh <semver> <dmg path>" >&2
  exit 1
fi

version="$1"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$(dirname "$2")"
asset_path="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/arbor-release-build.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

case "$(uname -m)" in
  arm64) update_arch="aarch64" ;;
  x86_64) update_arch="amd64" ;;
  *) echo "Unsupported Mac architecture: $(uname -m)" >&2; exit 1 ;;
esac

cd "$repo_dir"
node scripts/version.mjs "$version" >/dev/null

# Bundle the official core release pinned in core-version.txt. The app installs it on a Mac
# with no core yet, or over an older core after an update, and every core start needs the
# config.example.yaml the archive carries.
# checksums.txt is verified here but not bundled: upstream's CI release build re-signed the core
# binary inside the archive, so the upstream checksum wouldn't match a DMG built there.
core_version="$(tr -d '[:space:]' < core-version.txt)"
core_version="${core_version#v}"
core_asset="CLIProxyAPI_${core_version}_darwin_${update_arch}.tar.gz"
core_release_url="https://github.com/router-for-me/CLIProxyAPI/releases/download/v${core_version}"

core_archive_verified() {
  local archive="$1" checksums="$2" expected actual
  [[ -f "$archive" && -f "$checksums" ]] || return 1
  expected="$(awk -v name="$core_asset" '{ file = $2; sub(/^\*/, "", file); if (file == name) { print tolower($1); exit } }' "$checksums")"
  [[ -n "$expected" ]] || return 1
  actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]]
}

# Earlier builds kept the download in cpa-core/; reuse it rather than downloading the core again.
if [[ -d cpa-core && ! -e bundled-core ]]; then
  mv cpa-core bundled-core
fi
mkdir -p bundled-core
if core_archive_verified "bundled-core/$core_asset" bundled-core/checksums.txt; then
  echo "Using cached core $core_asset"
else
  core_download="$work_dir/core"
  mkdir -p "$core_download"
  curl -fsSL --retry 3 -o "$core_download/$core_asset" "$core_release_url/$core_asset"
  curl -fsSL --retry 3 -o "$core_download/checksums.txt" "$core_release_url/checksums.txt"
  if ! core_archive_verified "$core_download/$core_asset" "$core_download/checksums.txt"; then
    echo "SHA-256 verification failed for $core_asset" >&2
    exit 1
  fi
  mv "$core_download/$core_asset" "bundled-core/$core_asset"
  mv "$core_download/checksums.txt" bundled-core/checksums.txt
fi

core_entries="$(tar -tzf "bundled-core/$core_asset")"
for required_entry in cli-proxy-api config.example.yaml; do
  if ! grep -Eq "(^|/)${required_entry//./\\.}\$" <<< "$core_entries"; then
    echo "$core_asset is missing $required_entry" >&2
    exit 1
  fi
done

# The DMG bundles every bundled-core/CLIProxyAPI_* file, so drop archives from earlier core versions.
find bundled-core -maxdepth 1 -type f -name 'CLIProxyAPI_*' ! -name "$core_asset" -delete

# Bundle the background runner (ultradian) pinned in udian-version.txt: one archive for each system Arbor can put it
# on, each checked against the release's SHA256SUMS. Arbor checks it again before it copies one to a machine. An empty
# udian-version.txt builds without it, and automations then run only from Arbor while it's open.
udian_version="$(tr -d '[:space:]' < udian-version.txt)"
udian_version="${udian_version#v}"
udian_targets=(darwin-arm64 darwin-x64 linux-x64 linux-arm64)

# The last build's archives are reused when they're this version's and still match the sums it checked them against,
# as the core's are, and the folder holds nothing else, since all of it goes into the app.
udian_cached() {
  [[ -n "$udian_version" && -f bundled-udian/SHA256SUMS ]] || return 1
  [[ "$(find bundled-udian -mindepth 1 | wc -l | tr -d ' ')" == "$(( ${#udian_targets[@]} + 1 ))" ]] || return 1
  local target asset expected actual
  for target in "${udian_targets[@]}"; do
    asset="ultradian-${udian_version}-${target}.tar.gz"
    [[ -f "bundled-udian/$asset" ]] || return 1
    expected="$(awk -v name="$asset" '$2 == name { print $1; exit }' bundled-udian/SHA256SUMS)"
    actual="$(shasum -a 256 "bundled-udian/$asset" | awk '{print $1}')"
    [[ -n "$expected" && "$actual" == "$expected" ]] || return 1
  done
}

if udian_cached; then
  echo "Using cached ultradian $udian_version"
else
  rm -rf bundled-udian
  mkdir -p bundled-udian
  if [[ -n "$udian_version" ]]; then
    udian_release_url="https://github.com/aaronvanston/ultradian/releases/download/v${udian_version}"
    curl -fsSL --retry 3 -o bundled-udian/SHA256SUMS.release "$udian_release_url/SHA256SUMS"
    : > bundled-udian/SHA256SUMS
    for udian_target in "${udian_targets[@]}"; do
      udian_asset="ultradian-${udian_version}-${udian_target}.tar.gz"
      curl -fsSL --retry 3 -o "bundled-udian/$udian_asset" "$udian_release_url/$udian_asset"
      udian_expected="$(awk -v name="$udian_asset" '{ file = $2; sub(/^\*/, "", file); if (file == name) { print tolower($1); exit } }' bundled-udian/SHA256SUMS.release)"
      udian_actual="$(shasum -a 256 "bundled-udian/$udian_asset" | awk '{print $1}')"
      if [[ -z "$udian_expected" || "$udian_actual" != "$udian_expected" ]]; then
        echo "SHA-256 verification failed for $udian_asset" >&2
        exit 1
      fi
      printf '%s  %s\n' "$udian_actual" "$udian_asset" >> bundled-udian/SHA256SUMS
    done
    rm bundled-udian/SHA256SUMS.release
  else
    echo "No background runner pinned in udian-version.txt; building without it."
    : > bundled-udian/SHA256SUMS
  fi
fi

node scripts/set-version.mjs "$version"

# Versions up to 1.0 install an update only when this marker names EasyCLIProxyAPI, the app Arbor was forked from, so
# every build keeps that name here, where nobody sees it.
cat > portable-app.json <<JSON
{
  "schemaVersion": 1,
  "application": "EasyCLIProxyAPI",
  "version": "$version",
  "platform": "darwin",
  "arch": "$update_arch",
  "autoUpdate": true
}
JSON

# Rust keeps source paths for panic messages, and a dependency's is under ~/.cargo, which names the build machine's
# user; the build writes each as ~ instead, and this checkout's (generated code included) as arbor. The last match
# wins.
release_rustflags="${RUSTFLAGS:+$RUSTFLAGS }--remap-path-prefix=$HOME=~ --remap-path-prefix=$repo_dir=arbor"

# The core plugin behind Settings › Extra models (core-plugins/arbor-models) ships beside the core archive, and Arbor
# puts it in the core's plugins folder.
RUSTFLAGS="$release_rustflags" cargo build --quiet --release --locked --manifest-path core-plugins/arbor-models/Cargo.toml
mkdir -p bundled-core/plugins
cp core-plugins/arbor-models/target/release/libarbor_models.dylib bundled-core/plugins/arbor-models.dylib

# A nightly or dev build is packaged with its own icon (src-tauri/icons/channels/), so Finder, Launchpad and the Dock
# tell it from stable even while it's closed; src-tauri/src/app_icon.rs matches it while it runs. Each Arbor.icon is
# the Icon Composer version macOS 26 and later show, with its own dark colors so dark mode doesn't swap the tile for
# black; Tauri compiles it with Xcode 26's actool and falls back to the icns without one.
case "$version" in
  *-nightly.*) icons=icons/channels/nightly ;;
  *-dev.*) icons=icons/channels/dev ;;
  *) icons=icons ;;
esac
# Tauri only falls back when actool is missing or older than 26. An actool that's there but can't compile the icon (one
# Xcode 27 build fails every Icon Composer file, Xcode's own template too, with "Bad file descriptor") fails the whole
# bundle, so the icon is compiled once here first and left out, keeping the icns, when that fails. The check runs
# exactly what tauri-bundler's macos/icon.rs runs (a copy named Icon.icon, the same flags): a lighter call passed on
# GitHub's Xcode 26.6 runner while Tauri's own failed the bundle.
icon_composer=",\"$icons/Arbor.icon\""
actool_check="$(mktemp -d)"
cp -R "src-tauri/$icons/Arbor.icon" "$actool_check/Icon.icon"
mkdir "$actool_check/out"
if ! actool "$actool_check/Icon.icon" --compile "$actool_check/out" --output-format human-readable-text --notices \
  --warnings --output-partial-info-plist "$actool_check/out/assetcatalog_generated_info.plist" --app-icon Icon \
  --include-all-app-icons --accent-color AccentColor --enable-on-demand-resources NO --development-region en \
  --target-device mac --minimum-deployment-target 26.0 --platform macosx \
  >"$actool_check/actool.log" 2>&1 </dev/null || [[ ! -f "$actool_check/out/Assets.car" ]]; then
  echo "actool couldn't compile src-tauri/$icons/Arbor.icon, so this build uses the icns icon alone. It said:" >&2
  sed 's/^/  /' "$actool_check/actool.log" >&2
  icon_composer=
fi
rm -rf "$actool_check"
icon_config=(--config "{\"bundle\":{\"icon\":[\"$icons/icon.png\",\"$icons/32x32.png\",\"$icons/128x128.png\",\"$icons/128x128@2x.png\",\"$icons/icon.icns\"$icon_composer]}}")

RUSTFLAGS="$release_rustflags" bun tauri build --bundles app --config src-tauri/tauri.dmg.conf.json "${icon_config[@]}"

app_path="$repo_dir/src-tauri/target/release/bundle/macos/Arbor.app"
# Versions up to 1.0 ran as Contents/MacOS/cpa-gui. Their updater installs a new version only when it has that file, and
# starts it by that path, and their open-at-login item runs it too, so it stays as a link to Arbor, the app's executable.
if [[ "$(plutil -extract CFBundleExecutable raw "$app_path/Contents/Info.plist")" != "Arbor" ]]; then
  echo "The app's executable isn't Contents/MacOS/Arbor; check mainBinaryName in src-tauri/tauri.conf.json." >&2
  exit 1
fi
ln -sfn Arbor "$app_path/Contents/MacOS/cpa-gui"
# Anyone can read the app's strings, so a build that still names the build machine's home folder isn't published. The
# bytes are searched whole: `strings` skips a library's load commands, where the linker writes the path it was built at.
if LC_ALL=C grep -aFq "$HOME/" "$app_path/Contents/MacOS/"* "$app_path/Contents/Resources/core/plugins/"* || grep -rFlq "$HOME/" dist; then
  echo "The build still contains $HOME, which names this Mac's user; not publishing it." >&2
  exit 1
fi
codesign --force --deep --sign - "$app_path"
codesign --verify --deep --strict "$app_path"
# `arbor` is this same program; it answers before the app starts anything, so a signed build that can't is caught here.
if [[ "$("$app_path/Contents/MacOS/Arbor" cli version)" != arbor\ * ]]; then
  echo "The built app doesn't answer 'Arbor cli version'." >&2
  exit 1
fi

dmg_stage="$work_dir/dmg"
mkdir -p "$dmg_stage"
ditto "$app_path" "$dmg_stage/Arbor.app"
ln -s /Applications "$dmg_stage/Applications"

# The window someone sees when they open the DMG: the installer background with the app and Applications in its
# clearings, laid out by dmgbuild (scripts/dmg/settings.py). The app's updater only needs Arbor.app at the top of the
# image, so if uv or dmgbuild isn't there, or fails, this falls back to a plain DMG.
rm -f "$asset_path"
if command -v uvx >/dev/null 2>&1 \
  && uvx --quiet dmgbuild@1.6.7 -s "$repo_dir/scripts/dmg/settings.py" -D app="$app_path" \
    -D background="$repo_dir/scripts/dmg/background.tiff" "Arbor" "$asset_path" >"$work_dir/dmgbuild.log" 2>&1; then
  echo "Built the DMG with its installer window"
else
  echo "dmgbuild didn't build the DMG, so it's a plain one:" >&2
  tail -n 5 "$work_dir/dmgbuild.log" >&2 2>/dev/null || true
  rm -f "$asset_path"
  hdiutil create -volname "Arbor" -srcfolder "$dmg_stage" -format ULFO -ov "$asset_path" >/dev/null
fi
codesign --force --sign - "$asset_path"

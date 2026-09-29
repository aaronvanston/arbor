#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: ./scripts/publish-local-update.sh <semver>" >&2
  exit 1
fi

requested_version="$1"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
feed_dir="$HOME/Library/Application Support/Arbor Updates"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/easycli-local-update.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

case "$(uname -m)" in
  arm64) update_arch="aarch64" ;;
  x86_64) update_arch="amd64" ;;
  *) echo "Unsupported Mac architecture: $(uname -m)" >&2; exit 1 ;;
esac

cd "$repo_dir"

node scripts/version.mjs "$requested_version" >/dev/null

# The release notes come from git history, and the release commit holds only the Cargo files, so what's built has to
# be what's committed, on top of everything already released.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Commit or set aside your changes first; the build and its release notes come from committed work." >&2
  exit 1
fi
case "$(git remote get-url origin)" in
  https://github.com/aaronvanston/arbor.git | https://github.com/aaronvanston/arbor | git@github.com:aaronvanston/arbor.git) ;;
  *) echo "The origin remote isn't github.com/aaronvanston/arbor, where releases are published." >&2; exit 1 ;;
esac
if ! git fetch -q origin; then
  echo "Couldn't fetch origin; publishing needs the latest origin/main to pick a free version." >&2
  exit 1
fi
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "HEAD isn't on top of origin/main; rebase onto it first." >&2
  exit 1
fi

# A release build needs several GB. Below 25 GB free, clear what scripts/clean-dev-disk.sh can (never this worktree);
# below 12 GB, don't start.
free_gb="$(df -g "$HOME" | awk 'NR==2 { print $4 }')"
if (( free_gb < 25 )); then
  echo "Only ${free_gb} GB free; clearing old build folders, worktrees and feed DMGs first."
  ARBOR_CLEAN_SKIP="$repo_dir" "$repo_dir/scripts/clean-dev-disk.sh" || true
  free_gb="$(df -g "$HOME" | awk 'NR==2 { print $4 }')"
fi
if (( free_gb < 12 )); then
  echo "Only ${free_gb} GB free, too little to build a release. Free some space, then try again." >&2
  exit 1
fi

# Apps take a release from GitHub only with an update list signed by the release key (publish-github-release.sh), so
# don't build one that can't be signed.
if ! node scripts/release-signing.mjs check; then
  echo "This Mac can't sign Arbor's update list, so nothing it builds could be installed from GitHub." >&2
  exit 1
fi

# A worktree without the Hugeicons key builds with the free icons: selected sidebar rows lose their duotone drawing.
# ARBOR_ALLOW_FREE_ICONS=1 publishes that way on purpose.
if [[ ! -d node_modules/@hugeicons-pro/core-duotone-rounded && "${ARBOR_ALLOW_FREE_ICONS:-}" != "1" ]]; then
  echo "Hugeicons Pro isn't installed, so this build would use the free icons. Copy .env (HUGEICONS_LICENSE_KEY) from" >&2
  echo "the main checkout and run bun install, or set ARBOR_ALLOW_FREE_ICONS=1 to publish with the free set." >&2
  exit 1
fi

# Official releases send usage data and crash reports (src-tauri/src/product_analytics.rs). PostHog's project key is
# built in only here, from ARBOR_POSTHOG_KEY in the environment or .env, so a build from source sends nothing.
# ARBOR_ALLOW_NO_ANALYTICS=1 publishes a build that sends nothing on purpose.
posthog_key="${ARBOR_POSTHOG_KEY:-$(sed -n 's/^ARBOR_POSTHOG_KEY=//p' .env 2>/dev/null | tail -1)}"
if [[ -z "$posthog_key" && "${ARBOR_ALLOW_NO_ANALYTICS:-}" != "1" ]]; then
  echo "ARBOR_POSTHOG_KEY isn't set, so this build would send no usage data or crash reports. Copy .env from the main" >&2
  echo "checkout, or set ARBOR_ALLOW_NO_ANALYTICS=1 to publish a build that sends nothing." >&2
  exit 1
fi
export ARBOR_POSTHOG_KEY="$posthog_key"

# Claim the version in the feed before checking or building anything: two runs publishing the same number at once
# would each overwrite the other's DMG and manifest. mkdir either makes the claim or finds someone else's, in one
# step. A run that stops before publishing lets go of its claim; one that publishes keeps it.
claim="$feed_dir/.claims/$requested_version"
published=0
mkdir -p "$feed_dir/.claims"
if ! mkdir "$claim" 2>/dev/null; then
  holder="$(cat "$claim/by" 2>/dev/null || echo "another run")"
  holder_pid="$(cat "$claim/pid" 2>/dev/null || true)"
  # A run killed before it could let go, and that never published, leaves its claim behind.
  if [[ ! -e "$claim/published" && -n "$holder_pid" ]] && ! kill -0 "$holder_pid" 2>/dev/null \
    && rm -rf "$claim" && mkdir "$claim" 2>/dev/null; then
    echo "Took over $requested_version from a run that stopped without publishing it ($holder)."
  else
    echo "Arbor $requested_version is already claimed in the feed by $holder. Rebase and publish the next version." >&2
    exit 1
  fi
fi
trap 'rm -rf "$work_dir"; [[ $published == 1 ]] || rm -rf "$claim"' EXIT
echo "$$" > "$claim/pid"
echo "$repo_dir at $(git rev-parse --short HEAD), $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$claim/by"
if [[ -e "$feed_dir/Arbor-v${requested_version}-Darwin-${update_arch}.dmg" ]]; then
  echo "The feed already has Arbor $requested_version. Rebase and publish the next version." >&2
  exit 1
fi

# The public notes: ARBOR_RELEASE_SUMMARY says at a feature level what the release adds or changes, and
# ARBOR_RELEASE_CHANGES can add up to three high-level changes, one a line. This refuses notes missing a summary or naming
# what's never published (release-notes.mjs), and a version that's already out.
echo "Release notes:"
node scripts/release-notes.mjs preview --pending "$requested_version"
echo ""

# Check the code before anything is downloaded, versioned or built, so a broken tree never reaches the feed.
# ARBOR_SKIP_VERIFY=1 is the escape hatch for an urgent build; it says so loudly.
if [[ "${ARBOR_SKIP_VERIFY:-}" == "1" ]]; then
  echo "" >&2
  echo "!!! WARNING: ARBOR_SKIP_VERIFY=1 — publishing WITHOUT 'bun run verify' or 'bun run verify:rust'." >&2
  echo "!!! This build has not been type-checked, linted, dead-code checked or tested." >&2
  echo "" >&2
else
  if ! bun run verify; then
    echo "bun run verify failed; not publishing. Fix it, or set ARBOR_SKIP_VERIFY=1 to publish anyway." >&2
    exit 1
  fi
  if ! bun run verify:rust; then
    echo "bun run verify:rust failed; not publishing. Fix it, or set ARBOR_SKIP_VERIFY=1 to publish anyway." >&2
    exit 1
  fi
fi

# The app ships THIRD_PARTY_NOTICES.md, every bundled package's license; a dependency change means running
# bun run notices and committing the result first.
if ! bun scripts/third-party-notices.mjs --check; then
  echo "THIRD_PARTY_NOTICES.md is out of date; run bun run notices and commit it. Not publishing." >&2
  exit 1
fi

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

mkdir -p cpa-core "$feed_dir"
if core_archive_verified "cpa-core/$core_asset" cpa-core/checksums.txt; then
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
  mv "$core_download/$core_asset" "cpa-core/$core_asset"
  mv "$core_download/checksums.txt" cpa-core/checksums.txt
fi

core_entries="$(tar -tzf "cpa-core/$core_asset")"
for required_entry in cli-proxy-api config.example.yaml; do
  if ! grep -Eq "(^|/)${required_entry//./\\.}\$" <<< "$core_entries"; then
    echo "$core_asset is missing $required_entry" >&2
    exit 1
  fi
done

# The DMG bundles every cpa-core/CLIProxyAPI_* file, so drop archives from earlier core versions.
find cpa-core -maxdepth 1 -type f -name 'CLIProxyAPI_*' ! -name "$core_asset" -delete

node scripts/set-version.mjs "$requested_version"
node scripts/release-notes.mjs add --version "$requested_version"

cat > portable-app.json <<JSON
{
  "schemaVersion": 1,
  "application": "EasyCLIProxyAPI",
  "version": "$requested_version",
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
mkdir -p cpa-core/plugins
cp core-plugins/arbor-models/target/release/libarbor_models.dylib cpa-core/plugins/arbor-models.dylib

RUSTFLAGS="$release_rustflags" bun tauri build --bundles app --config src-tauri/tauri.dmg.conf.json

app_path="$repo_dir/src-tauri/target/release/bundle/macos/Arbor.app"
# Anyone can read the app's strings, so a build that still names the build machine's home folder isn't published. The
# bytes are searched whole: `strings` skips a library's load commands, where the linker writes the path it was built at.
if LC_ALL=C grep -aFq "$HOME/" "$app_path/Contents/MacOS/"* "$app_path/Contents/Resources/cpa-core/plugins/"* || grep -rFlq "$HOME/" dist; then
  echo "The build still contains $HOME, which names this Mac's user; not publishing it." >&2
  exit 1
fi
codesign --force --deep --sign - "$app_path"
codesign --verify --deep --strict "$app_path"

dmg_stage="$work_dir/dmg"
mkdir -p "$dmg_stage"
ditto "$app_path" "$dmg_stage/Arbor.app"
ln -s /Applications "$dmg_stage/Applications"

asset_name="Arbor-v${requested_version}-Darwin-${update_arch}.dmg"
asset_path="$feed_dir/$asset_name"
# The window someone sees when they open the DMG: the installer background with the app and Applications in its
# clearings, laid out by dmgbuild (scripts/dmg/settings.py). The app's updater only needs Arbor.app at the top of the
# image, so if uv or dmgbuild isn't there, or fails, this falls back to a plain DMG.
if command -v uvx >/dev/null 2>&1 \
  && uvx --quiet dmgbuild@1.6.7 -s "$repo_dir/scripts/dmg/settings.py" -D app="$app_path" \
    -D background="$repo_dir/scripts/dmg/background.tiff" "Arbor" "$asset_path" >"$work_dir/dmgbuild.log" 2>&1; then
  echo "Built the DMG with its installer window"
else
  echo "dmgbuild didn't build the DMG, so it's a plain one:" >&2
  tail -n 5 "$work_dir/dmgbuild.log" >&2 2>/dev/null || true
  rm -f "$asset_path"
  hdiutil create -volname "Arbor" -srcfolder "$dmg_stage" -format UDZO -ov "$asset_path" >/dev/null
fi
codesign --force --sign - "$asset_path"

asset_sha="$(shasum -a 256 "$asset_path" | awk '{print $1}')"
asset_size="$(stat -f %z "$asset_path")"
built_from="$(git rev-parse HEAD)"

# The local feed is only for apps from before the GitHub feed, which read nothing else: through it they update to a
# version that reads GitHub. Apps since then are offered a release once publish-github-release.sh publishes it. It's
# written whole and swapped in, since older apps read it every minute.
node scripts/release-notes.mjs feed-manifest \
  --version "$requested_version" \
  --arch "$update_arch" \
  --sha256 "$asset_sha" \
  --size "$asset_size" \
  --core-version "$core_version" \
  --output "$feed_dir/portable-update-darwin-v2.json"

# What publish-github-release.sh checks before uploading this DMG: another run publishing the same number
# overwrites the DMG, and this is how that shows.
cat > "$feed_dir/${asset_name%.dmg}.release.json" <<JSON
{
  "version": "$requested_version",
  "sha256": "$asset_sha",
  "sizeBytes": $asset_size,
  "commit": "$built_from"
}
JSON

touch "$claim/published"
published=1

release_message="$(git rev-parse --absolute-git-dir)/ARBOR_RELEASE_MSG_$requested_version"
node scripts/release-notes.mjs commit-message --version "$requested_version" --output "$release_message"

echo "Published Arbor v$requested_version"
echo "Manifest: $feed_dir/portable-update-darwin-v2.json"
echo ""
echo "Next:"
echo "  git commit -F \"$release_message\" -- src-tauri/Cargo.toml src-tauri/Cargo.lock release-notes.json"
echo "  git fetch origin   # if origin/main moved, rebase and publish the next version instead"
echo "  git push origin HEAD:main"
echo "  ./scripts/publish-github-release.sh $requested_version"

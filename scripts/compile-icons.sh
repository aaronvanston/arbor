#!/usr/bin/env bash
# Compiles each Icon Composer file (src-tauri/icons/Arbor.icon and each build channel's) into the Assets.car beside it,
# with tauri-bundler's own actool flags (macos/icon.rs), and writes the source's hash next to it
# (scripts/icon-hash.mjs). Builds then list the committed Assets.car, which Tauri copies in as it is, so no build runs
# actool: one Xcode 27 build fails every Icon Composer file, and Tauri's own call failed on GitHub's Xcode 26.6 runner.
#
# Needs Xcode 26's actool; the Icons workflow (.github/workflows/arbor-icons.yml) runs this on GitHub's Mac. Run it
# again whenever an icon changes; tests/appIcons.test.ts fails until the hashes match.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
actool --version --output-format human-readable-text | grep short-bundle-version

for icon in src-tauri/icons/Arbor.icon src-tauri/icons/channels/*/Arbor.icon; do
  dir="$(dirname "$icon")"
  work="$(mktemp -d)"
  # Tauri names the icon Icon, and Info.plist's CFBundleIconName comes from that name.
  cp -R "$icon" "$work/Icon.icon"
  mkdir "$work/out"
  actool "$work/Icon.icon" --compile "$work/out" --output-format human-readable-text --notices --warnings \
    --output-partial-info-plist "$work/out/assetcatalog_generated_info.plist" --app-icon Icon --include-all-app-icons \
    --accent-color AccentColor --enable-on-demand-resources NO --development-region en --target-device mac \
    --minimum-deployment-target 26.0 --platform macosx </dev/null
  [[ -f "$work/out/Assets.car" ]] || { echo "actool didn't make an Assets.car for $icon" >&2; exit 1; }
  cp "$work/out/Assets.car" "$dir/Assets.car"
  node scripts/icon-hash.mjs "$icon" > "$dir/Assets.car.sha256"
  rm -rf "$work"
  echo "Compiled $icon"
done

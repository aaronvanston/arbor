#!/usr/bin/env bash
# Pins the core release Arbor bundles: writes the version to core-version.txt and the SHA-256 of each macOS archive to
# core-sha256.txt, which the release build checks the download against (scripts/build-release.sh). The digests are
# taken from the archives themselves and must also match the release's checksums.txt, so a pin records what was
# reviewed, and a release whose files change after it fails the build instead of shipping. Commit both files together.
#
#   ./scripts/pin-core.sh 8.0.4
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: ./scripts/pin-core.sh <core version>" >&2
  exit 1
fi

version="${1#v}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Not a core version: $1" >&2; exit 1; }
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/arbor-pin-core.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
release_url="https://github.com/router-for-me/CLIProxyAPI/releases/download/v${version}"

curl -fsSL --retry 3 -o "$work_dir/checksums.txt" "$release_url/checksums.txt"
: > "$work_dir/core-sha256.txt"
for arch in aarch64 amd64; do
  asset="CLIProxyAPI_${version}_darwin_${arch}.tar.gz"
  curl -fsSL --retry 3 -o "$work_dir/$asset" "$release_url/$asset"
  actual="$(shasum -a 256 "$work_dir/$asset" | awk '{print $1}')"
  published="$(awk -v name="$asset" '{ file = $2; sub(/^\*/, "", file); if (file == name) { print tolower($1); exit } }' "$work_dir/checksums.txt")"
  if [[ "$actual" != "$published" ]]; then
    echo "$asset doesn't match the release's checksums.txt; not pinning it." >&2
    exit 1
  fi
  printf '%s  %s\n' "$actual" "$asset" >> "$work_dir/core-sha256.txt"
done

printf '%s\n' "$version" > "$repo_dir/core-version.txt"
mv "$work_dir/core-sha256.txt" "$repo_dir/core-sha256.txt"
echo "Pinned core $version:"
cat "$repo_dir/core-sha256.txt"

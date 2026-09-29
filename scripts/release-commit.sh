#!/usr/bin/env bash
# Makes the `Release Arbor X.Y.Z` commit a stable release is published from: the version in the Cargo files and its
# notes in release-notes.json, from ARBOR_RELEASE_SUMMARY and ARBOR_RELEASE_CHANGES. Push it to main, then run the
# Release workflow with channel stable; until then, nightlies are built as X.Y.Z's prereleases.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: ARBOR_RELEASE_SUMMARY=\"…\" ./scripts/release-commit.sh <X.Y.Z>" >&2
  exit 1
fi

fail() {
  echo "$1" >&2
  exit 1
}

version="$1"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
node scripts/version.mjs "$version" >/dev/null
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "A release's version is X.Y.Z; nightlies get theirs from the workflow."

[[ -z "$(git status --porcelain --untracked-files=no)" ]] || fail "Commit or set aside your changes first."
git fetch -q origin || fail "Couldn't fetch origin."
git merge-base --is-ancestor origin/main HEAD || fail "HEAD isn't on top of origin/main; rebase onto it first."

# Refuses notes missing a summary or naming what's never published (release-notes.mjs), and a version that's out.
echo "Release notes:"
node scripts/release-notes.mjs preview --pending "$version"
echo ""

node scripts/set-version.mjs "$version"
node scripts/release-notes.mjs add --version "$version"
message="$(git rev-parse --absolute-git-dir)/ARBOR_RELEASE_MSG_$version"
node scripts/release-notes.mjs commit-message --version "$version" --output "$message"
git commit -q -F "$message" -- src-tauri/Cargo.toml src-tauri/Cargo.lock release-notes.json

echo "Committed Release Arbor $version."
echo ""
echo "Next:"
echo "  git push origin HEAD:main"
echo "  gh workflow run arbor-release.yml --repo aaronvanston/arbor --ref main -f channel=stable"

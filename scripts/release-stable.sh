#!/usr/bin/env bash
# Starts a stable release: the Release workflow (.github/workflows/arbor-release.yml) promotes the newest nightly to
# X.Y.Z with these notes, publishes it, and commits the version and notes to main. Nothing is built or committed here;
# this only checks the notes first, so a run doesn't fail on them halfway.
#
#   ARBOR_RELEASE_SUMMARY="…" [ARBOR_RELEASE_CHANGES=$'…\n…'] ./scripts/release-stable.sh
set -euo pipefail

fail() {
  echo "$1" >&2
  exit 1
}

repository="aaronvanston/arbor"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
[[ -n "${ARBOR_RELEASE_SUMMARY:-}" ]] || fail "Set ARBOR_RELEASE_SUMMARY to the release's one-line summary."

nightly="$(gh release list --repo "$repository" --limit 50 --json tagName,isDraft \
  --jq '[.[] | select(.isDraft | not) | .tagName | select(test("^arbor-v[0-9]+\\.[0-9]+\\.[0-9]+-nightly\\."))][0] // ""')"
[[ -n "$nightly" ]] || fail "No nightly is out yet. A stable release promotes the newest nightly."
version="${nightly#arbor-v}"
version="${version%%-*}"

# Checked against main's notes, as the workflow will, in a throwaway checkout of main.
git fetch -q origin main
main_dir="$(mktemp -d "${TMPDIR:-/tmp}/arbor-release-stable.XXXXXX")"
git worktree add -q --detach "$main_dir" origin/main
trap 'git worktree remove --force "$main_dir"' EXIT
echo "Promotes ${nightly#arbor-v} to Arbor $version, with these notes:"
node "$main_dir/scripts/release-notes.mjs" preview --pending "$version"
echo ""

gh workflow run arbor-release.yml --repo "$repository" --ref main -f channel=stable \
  -f summary="$ARBOR_RELEASE_SUMMARY" -f changes="${ARBOR_RELEASE_CHANGES:-}"
echo "Started. Follow it with: gh run watch --repo $repository \$(gh run list --repo $repository --workflow arbor-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"

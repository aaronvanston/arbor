#!/usr/bin/env bash
# Starts a stable release: the Release workflow (.github/workflows/arbor-release.yml) promotes the newest nightly to
# X.Y.Z with these notes, publishes it, and commits the version and notes to main. Nothing is built or committed here;
# this only checks the notes first, so a run doesn't fail on them halfway. ARBOR_RELEASE_BUMP=minor or major releases
# the nightly as the next minor or major instead of its own patch version, for a release that adds features or breaks
# something.
#
#   ARBOR_RELEASE_SUMMARY="…" [ARBOR_RELEASE_CHANGES=$'…\n…'] [ARBOR_RELEASE_BUMP=patch|minor|major] ./scripts/release-stable.sh
set -euo pipefail

fail() {
  echo "$1" >&2
  exit 1
}

repository="aaronvanston/arbor"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
[[ -n "${ARBOR_RELEASE_SUMMARY:-}" ]] || fail "Set ARBOR_RELEASE_SUMMARY to the release's one-line summary."
bump="${ARBOR_RELEASE_BUMP:-patch}"
[[ "$bump" =~ ^(patch|minor|major)$ ]] || fail "ARBOR_RELEASE_BUMP is patch, minor or major, not $bump."

nightly="$(gh release list --repo "$repository" --limit 50 --json tagName,isDraft \
  --jq '[.[] | select(.isDraft | not) | .tagName | select(test("^arbor-v[0-9]+\\.[0-9]+\\.[0-9]+-nightly\\."))][0] // ""')"
[[ -n "$nightly" ]] || fail "No nightly is out yet. A stable release promotes the newest nightly."
latest="$(gh release view --repo "$repository" --json tagName --jq '.tagName' 2>/dev/null || true)"

# Checked against main's notes, as the workflow will, in a throwaway checkout of main.
git fetch -q origin main
main_dir="$(mktemp -d "${TMPDIR:-/tmp}/arbor-release-stable.XXXXXX")"
git worktree add -q --detach "$main_dir" origin/main
trap 'git worktree remove --force "$main_dir"' EXIT
# The workflow works the version out the same way, from the same script. The values go in the environment, since a
# path in argv would make the script think it was run directly.
version="$(PLAN="$main_dir/scripts/release-plan.mjs" NIGHTLY="${nightly#arbor-v}" LATEST="${latest#arbor-v}" BUMP="$bump" \
  node --input-type=module -e '
    const { PLAN, NIGHTLY, LATEST, BUMP } = process.env;
    const { stableVersion } = await import(PLAN);
    console.log(stableVersion(NIGHTLY, LATEST || undefined, BUMP));
  ')" || exit 1
echo "Promotes ${nightly#arbor-v} to Arbor $version, with these notes:"
node "$main_dir/scripts/release-notes.mjs" preview --pending "$version"
echo ""

gh workflow run arbor-release.yml --repo "$repository" --ref main -f channel=stable -f bump="$bump" \
  -f summary="$ARBOR_RELEASE_SUMMARY" -f changes="${ARBOR_RELEASE_CHANGES:-}"
echo "Started. Follow it with: gh run watch --repo $repository \$(gh run list --repo $repository --workflow arbor-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"

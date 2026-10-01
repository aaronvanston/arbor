#!/usr/bin/env bash
# Publishes what the Release workflow (.github/workflows/arbor-release.yml) built: an `arbor-v<version>` release at the
# commit it was built from, with its notes, the DMG and the signed update list the app reads. A nightly is a prerelease,
# which only apps on the nightly channel look at; a stable release becomes the latest, which every app updates to.
# The notes come from this checkout's release-notes.json, where the workflow adds a stable release's before building.
# Signing needs ARBOR_RELEASE_SIGNING_KEY (scripts/release-signing.mjs), and gh needs GH_TOKEN.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: ./scripts/publish-workflow-release.sh <semver> <commit> <dmg>" >&2
  exit 1
fi

fail() {
  echo "$1" >&2
  exit 1
}

version="$1"
commit="$2"
asset_path="$3"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
node scripts/version.mjs "$version" >/dev/null

repository="${GITHUB_REPOSITORY:-aaronvanston/arbor}"
[[ "$repository" == "aaronvanston/arbor" ]] || fail "Apps only take releases from aaronvanston/arbor, not $repository."
tag="arbor-v$version"
asset_name="$(basename "$asset_path")"
update_arch="${asset_name#"Arbor-v${version}-Darwin-"}"
update_arch="${update_arch%.dmg}"
[[ "$update_arch" == "aarch64" || "$update_arch" == "amd64" ]] || fail "$asset_name isn't Arbor ${version}'s DMG."
[[ -f "$asset_path" ]] || fail "$asset_path isn't there."

if gh release view "$tag" --repo "$repository" >/dev/null 2>&1; then
  fail "$tag is already published; a published release is never replaced."
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/arbor-workflow-release.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
asset_sha="$(shasum -a 256 "$asset_path" | awk '{print $1}')"
feed_file="$work_dir/arbor-update-darwin.json"
core_version="$(git show "$commit:core-version.txt" | tr -d '[:space:]')"
node scripts/release-notes.mjs github-manifest \
  --version "$version" \
  --arch "$update_arch" \
  --sha256 "$asset_sha" \
  --size "$(wc -c < "$asset_path" | tr -d ' ')" \
  --core-version "${core_version#v}" \
  --output "$work_dir/manifest.json"
node scripts/release-signing.mjs sign --manifest "$work_dir/manifest.json" --output "$feed_file" \
  || fail "Couldn't sign the update list; apps won't take this release without it."
node scripts/release-notes.mjs github-body \
  --version "$version" \
  --asset "$asset_name" \
  --sha256 "$asset_sha" > "$work_dir/notes.md"

if [[ "$version" == *-* ]]; then
  channel_flags=(--prerelease --latest=false)
else
  channel_flags=(--latest)
fi
# gh keeps a release with files a draft until they've all uploaded, so apps never see it without its update list.
if ! gh release create "$tag" "$asset_path" "$feed_file" --repo "$repository" --target "$commit" \
  --title "Arbor $version" --notes-file "$work_dir/notes.md" "${channel_flags[@]}"; then
  fail "Creating the release failed. A failed upload can leave a draft behind: check gh release list --repo $repository."
fi

echo "Published $tag: https://github.com/$repository/releases/tag/$tag"

#!/usr/bin/env bash
# Publishes an Arbor release on GitHub: an `arbor-vX.Y.Z` release on aaronvanston/arbor with its notes, the DMG from the
# local feed, and the signed update list (arbor-update-darwin.json) the app reads from the newest release. Run it after
# the `Release Arbor X.Y.Z` commit is pushed: until it runs, no app is offered the release. Signing needs the
# "Arbor release signing key" in the Keychain (scripts/release-signing.mjs).
set -euo pipefail

usage() {
  echo "Usage: ./scripts/publish-github-release.sh [--dry-run] <semver>" >&2
  exit 1
}

dry_run=0
version=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -*) usage ;;
    *) [[ -z "$version" ]] || usage; version="$arg" ;;
  esac
done
[[ -n "$version" ]] || usage

fail() {
  echo "$1" >&2
  exit 1
}

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
node scripts/version.mjs "$version" >/dev/null

repository="aaronvanston/arbor"
case "$(git remote get-url origin)" in
  https://github.com/aaronvanston/arbor.git | https://github.com/aaronvanston/arbor | git@github.com:aaronvanston/arbor.git) ;;
  *) fail "The origin remote isn't github.com/$repository." ;;
esac

case "$(uname -m)" in
  arm64) update_arch="aarch64" ;;
  x86_64) update_arch="amd64" ;;
  *) fail "Unsupported Mac architecture: $(uname -m)" ;;
esac

feed_dir="${ARBOR_FEED_DIR:-$HOME/Library/Application Support/Arbor Updates}"
asset_name="Arbor-v${version}-Darwin-${update_arch}.dmg"
asset_path="$feed_dir/$asset_name"
sidecar="$feed_dir/${asset_name%.dmg}.release.json"
tag="arbor-v$version"

git fetch -q origin || fail "Couldn't fetch origin."
release_commit="$(git log --first-parent --format=%H -n1 --grep="^Release Arbor ${version//./\\.}\$" origin/main)"
[[ -n "$release_commit" ]] || fail "There's no \"Release Arbor $version\" commit on origin/main; commit and push the release first."

[[ -f "$asset_path" ]] || fail "$asset_name isn't in the local feed."
[[ -f "$sidecar" ]] || fail "$(basename "$sidecar") isn't in the local feed; publish-local-update.sh writes it."
asset_sha="$(shasum -a 256 "$asset_path" | awk '{print $1}')"
read -r recorded_version recorded_sha recorded_commit < <(node -e '
  const release = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  console.log(`${release.version} ${release.sha256} ${release.commit}`);
' "$sidecar")
# Another run publishing the same number overwrites the DMG, so upload only the build this release commit made.
[[ "$recorded_version" == "$version" ]] || fail "$(basename "$sidecar") is for $recorded_version, not $version."
[[ "$recorded_sha" == "$asset_sha" ]] || fail "$asset_name has changed since it was published; another build may have overwritten it."
[[ "$recorded_commit" == "$(git rev-parse "$release_commit^")" ]] || fail "$asset_name was built from $recorded_commit, not from the commit before \"Release Arbor $version\"."

# Mark this one Latest only when no newer release is on GitHub: apps read the Latest release.
newer_exists=0
while read -r released; do
  [[ -n "$released" && "$released" != "$version" ]] || continue
  if [[ "$(printf '%s\n%s\n' "$released" "$version" | sort -V | head -n1)" != "$released" ]]; then
    newer_exists=1
  fi
done < <(git ls-remote --tags --refs origin 'refs/tags/arbor-v*' | sed 's#.*refs/tags/arbor-v##' | sort -V)

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/arbor-github-release.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
body_file="$work_dir/notes.md"
# The update list: this release's DMG and recent notes, signed; the app offers nothing its signature doesn't cover.
feed_file="$work_dir/arbor-update-darwin.json"
core_version="$(git show "$release_commit:core-version.txt" | tr -d '[:space:]')"
node scripts/release-notes.mjs github-manifest \
  --version "$version" \
  --ref "$release_commit" \
  --arch "$update_arch" \
  --sha256 "$asset_sha" \
  --size "$(stat -f %z "$asset_path")" \
  --core-version "${core_version#v}" \
  --output "$work_dir/manifest.json"
node scripts/release-signing.mjs sign --manifest "$work_dir/manifest.json" --output "$feed_file" \
  || fail "Couldn't sign the update list; apps won't take this release without it."

node scripts/release-notes.mjs github-body \
  --version "$version" \
  --ref "$release_commit" \
  --asset "$asset_name" \
  --sha256 "$asset_sha" > "$body_file"

if [[ "$dry_run" == "1" ]]; then
  echo "Tag:     $tag (at $release_commit)"
  echo "Title:   Arbor $version"
  echo "Asset:   $asset_path ($(stat -f %z "$asset_path") bytes)"
  echo "Feed:    $(basename "$feed_file") (signed)"
  echo "Latest:  $([[ "$newer_exists" == "1" ]] && echo no || echo yes)"
  echo "---"
  cat "$body_file"
  echo "---"
  cat "$work_dir/manifest.json"
  exit 0
fi

gh auth status -h github.com >/dev/null 2>&1 || fail "gh isn't signed in to github.com; run gh auth login."

if gh release view "$tag" --repo "$repository" >/dev/null 2>&1; then
  gh release edit "$tag" --repo "$repository" --title "Arbor $version" --notes-file "$body_file"
  gh release upload "$tag" "$asset_path" "$feed_file" --repo "$repository" --clobber
else
  latest_flag="--latest"
  [[ "$newer_exists" == "1" ]] && latest_flag="--latest=false"
  # gh keeps a release with files a draft until they've all uploaded, so apps never see it without its update list.
  if ! gh release create "$tag" "$asset_path" "$feed_file" --repo "$repository" --target "$release_commit" \
    --title "Arbor $version" --notes-file "$body_file" "$latest_flag"; then
    fail "Creating the release failed. A failed upload can leave a draft behind: check gh release list --repo $repository."
  fi
fi

echo "Published $tag: https://github.com/$repository/releases/tag/$tag"

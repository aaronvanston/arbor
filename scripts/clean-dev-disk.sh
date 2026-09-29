#!/usr/bin/env bash
# Frees the disk space Arbor's development piles up: each worktree's Rust build folder (4-8 GB apiece), worktrees
# whose work is already on origin/main, and old DMGs in the local update feed. Nothing a running process is using is
# touched, and nothing that isn't on origin/main or GitHub is removed. A checkout with an `archive` remote (history
# from before the source was public) counts work on archive/main as kept too.
#
#   ./scripts/clean-dev-disk.sh             clean
#   ./scripts/clean-dev-disk.sh --dry-run   say what it would do
#
# ARBOR_CLEAN_TARGET_HOURS (6): a build folder nothing has built in for this long goes; it's rebuilt when needed.
# ARBOR_CLEAN_WORKTREE_HOURS (48): a worktree left alone this long goes, once it's clean and on origin/main.
# ARBOR_CLEAN_SKIP: a worktree to leave alone entirely, like the one a release is about to build in.
# ARBOR_CLEAN_KEEP_DMGS (5): the newest DMGs the feed keeps. GitHub has every release's DMG, and the feed's claims
# stay, so a version number is never taken twice.
set -uo pipefail

dry=0
[[ "${1:-}" == "--dry-run" ]] && dry=1
target_hours="${ARBOR_CLEAN_TARGET_HOURS:-6}"
worktree_hours="${ARBOR_CLEAN_WORKTREE_HOURS:-48}"
keep_dmgs="${ARBOR_CLEAN_KEEP_DMGS:-5}"
feed_dir="$HOME/Library/Application Support/Arbor Updates"
now="$(date +%s)"

# The main checkout, whichever worktree this runs from, or the copy installed for the LaunchAgent.
repo_dir="${ARBOR_REPO:-$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's#/\.git$##')}"
if [[ -z "$repo_dir" || ! -d "$repo_dir/.git" ]]; then
  echo "Can't find Arbor's repo; set ARBOR_REPO to the main checkout." >&2
  exit 1
fi

free_gb() { df -g "$HOME" | awk 'NR==2 { print $4 }'; }
say() { echo "$(date '+%Y-%m-%d %H:%M') $*"; }
remove() {
  if (( dry )); then say "would remove $1 ($2)"; else rm -rf "$1" && say "removed $1 ($2)"; fi
}

# Every process's working folder and command line, read once: a folder with a build running in it, or (for a whole
# worktree) any process at all open in it, is left alone.
cwds="$(lsof -a -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
commands="$(ps -Ao command= 2>/dev/null)"
builds="$(ps -Ao command= 2>/dev/null | grep -E 'cargo|rustc|tauri|bun|node|vite|publish-local-update' || true)"
in_use() { # path, what: build | any
  local path="$1"
  if grep -qF "$path" <<<"$builds"; then return 0; fi
  if [[ "$2" == "any" ]] && { grep -qxF "$path" <<<"$cwds" || grep -qF "$path/" <<<"$cwds"; }; then return 0; fi
  return 1
}
# Hours since anything in the folder changed, build output, dependencies and git's own files aside.
idle_hours() {
  local newest
  newest="$(find "$1" \( -name target -o -name node_modules -o -name .git -o -name dist \) -prune -o -type f -print0 2>/dev/null \
    | xargs -0 stat -f %m 2>/dev/null | sort -n | tail -1)"
  echo $(( (now - ${newest:-0}) / 3600 ))
}
# Hours since a build folder was last built in: cargo touches a profile's lock on every build.
built_hours() {
  local newest
  newest="$(stat -f %m "$1"/*/.cargo-lock "$1" 2>/dev/null | sort -n | tail -1)"
  echo $(( (now - ${newest:-0}) / 3600 ))
}

before="$(free_gb)"
git -C "$repo_dir" fetch -q origin 2>/dev/null || say "couldn't fetch origin; judging worktrees against the last fetch"
kept_on=()
for ref in refs/remotes/origin/main refs/remotes/archive/main; do
  git -C "$repo_dir" rev-parse -q --verify "$ref" >/dev/null && kept_on+=("$ref")
done

while IFS= read -r line; do
  path="${line#worktree }"
  target="$path/src-tauri/target"
  [[ -n "${ARBOR_CLEAN_SKIP:-}" && "$path" == "$ARBOR_CLEAN_SKIP" ]] && continue
  if [[ "$path" != "$repo_dir" ]]; then
    # A worktree whose work is all on origin/main, with nothing uncommitted or new, nobody in it, left for a while.
    ahead=1
    (( ${#kept_on[@]} )) && ahead="$(git -C "$path" rev-list --count HEAD --not "${kept_on[@]}" 2>/dev/null || echo 1)"
    changes="$(git -C "$path" status --porcelain 2>/dev/null | head -1)"
    idle="$(idle_hours "$path")"
    if [[ "$ahead" == "0" && -z "$changes" ]] && (( idle >= worktree_hours )) && ! in_use "$path" any; then
      if (( dry )); then
        say "would remove worktree $path (its work is kept, idle ${idle}h)"
      else
        rm -rf "$target" "$path/node_modules"
        # Never --force: git refuses a worktree with changes, which is the last check.
        git -C "$repo_dir" worktree remove "$path" && say "removed worktree $path (its work is kept, idle ${idle}h; its branch is kept)"
      fi
      continue
    fi
  fi
  if [[ -d "$target" ]]; then
    built="$(built_hours "$target")"
    if (( built >= target_hours )) && ! in_use "$path" build; then
      remove "$target" "build folder, last built ${built}h ago, $(du -sh "$target" 2>/dev/null | cut -f1)"
    fi
  fi
done < <(git -C "$repo_dir" worktree list --porcelain | grep '^worktree ')
(( dry )) || git -C "$repo_dir" worktree prune

# The feed's DMGs, newest version first; the newest few stay, with any a run is still publishing. An older one goes
# only when its GitHub release holds the same file: a release that never reached GitHub has no other copy.
on_github="$(gh release list -R aaronvanston/arbor --limit 400 --json tagName --jq '.[].tagName' 2>/dev/null \
  | while IFS= read -r tag; do gh release view "$tag" -R aaronvanston/arbor --json assets --jq '.assets[].name' 2>/dev/null; done)"
if [[ -d "$feed_dir" ]]; then
  ls "$feed_dir" | grep -E '^Arbor-v[0-9]+\.[0-9]+\.[0-9]+-.*\.dmg$' | sed -E 's/^Arbor-v([0-9.]+)-.*/\1/' | sort -t. -k1,1nr -k2,2nr -k3,3nr \
    | tail -n +$((keep_dmgs + 1)) | while IFS= read -r version; do
      claim="$feed_dir/.claims/$version"
      if [[ -d "$claim" && ! -e "$claim/published" ]]; then continue; fi
      for file in "$feed_dir"/Arbor-v"$version"-*.dmg; do
        if grep -qxF "$(basename "$file")" <<<"$on_github"; then
          remove "$file" "old feed DMG; GitHub has it"
        else
          say "kept $(basename "$file"): it isn't on GitHub"
        fi
      done
    done
fi

say "free: ${before} GB before, $(free_gb) GB now"

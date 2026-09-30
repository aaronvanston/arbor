#!/usr/bin/env bash
# Copies what .worktreeinclude lists from the main checkout into a new worktree: gitignored files a fresh checkout lacks,
# like .env with the key bun install needs. Claude Code does this itself for the worktrees it makes; t3.json runs this
# for T3 Code's, and any other tool can run it from inside a new worktree. It reads the file the way Claude Code does
# (.gitignore patterns, matched only against paths git ignores), takes an ignored folder whole, and never replaces
# anything the worktree already has.
set -euo pipefail

worktree="$(git rev-parse --show-toplevel)"
main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
include="$worktree/.worktreeinclude"
if [[ "$worktree" == "$main" || ! -f "$include" ]]; then
  exit 0
fi

# An empty repository has no .gitignore of its own, so check-ignore there matches each ignored path against the
# .worktreeinclude patterns alone.
matcher="$(mktemp -d)"
trap 'rm -rf "$matcher"' EXIT
git init -q "$matcher"

git -C "$main" ls-files -z --others --ignored --exclude-standard --directory |
  { git -C "$matcher" -c core.excludesFile="$include" check-ignore -z --no-index --stdin || [[ $? -eq 1 ]]; } |
  while IFS= read -r -d '' path; do
    path="${path%/}"
    if [[ -e "$worktree/$path" || -L "$worktree/$path" ]]; then
      continue
    fi
    # A link would point the worktree at whatever the main checkout's link points at, so it's left for a person to make.
    if [[ -L "$main/$path" ]]; then
      echo "Skipped $path: it's a link in the main checkout."
      continue
    fi
    mkdir -p "$(dirname "$worktree/$path")"
    cp -Rp "$main/$path" "$worktree/$path"
    echo "Copied $path from the main checkout."
  done

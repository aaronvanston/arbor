#!/usr/bin/env bash
# Builds origin/main for the dev update channel, on the Mac that runs it, when main has moved. The LaunchAgent
# scripts/install-dev-builds.sh sets up runs this every ten minutes; "Build latest main" in Settings › Updates leaves a
# build-now file and starts it at once. The app on the dev channel offers the newest build like any update
# (src-tauri/src/dev_builds.rs).
#
# A build runs in its own clone (never a worktree, so disk cleanup and other sessions leave it alone), checks the code
# with bun run verify and verify:rust, builds with scripts/build-release.sh, and signs its update list with the release
# key, so only a Mac that can sign releases can build for the dev channel. It writes, in the builder's folder:
#   Arbor-v<version>-Darwin-<arch>.dmg   the newest three builds
#   arbor-update-dev.json                the newest build's signed update list
#   status.json                          what the builder is doing, for the app
#   logs/                                each build's output, the newest ten
#
# On the timer, a build waits until main has been still for ARBOR_DEV_SETTLE_SECONDS (300), so a run of pushes builds
# once, and a commit that failed isn't tried again until main moves or a build is asked for.
#
# ARBOR_DEV_FEED_DIR       the builder's folder (~/Library/Application Support/Arbor Dev Builds)
# ARBOR_DEV_CHECKOUT       the clone it builds in (~/.arbor/dev-build/checkout)
# ARBOR_REPO               the main checkout, whose .env (Hugeicons and PostHog keys) builds use
# ARBOR_DEV_SKIP_RUST=1    skips bun run verify:rust
# ARBOR_DEV_DRY_RUN=1      checks nothing and builds a stand-in DMG, to try the bookkeeping; its list is left
#                          unsigned (arbor-update-dev.unsigned.json) unless ARBOR_DEV_DRY_RUN_SIGN=1
# ARBOR_DEV_INSTALL_DIR    where the LaunchAgent runs this from; a good build copies main's newer copy there
set -euo pipefail

# Everything is in main, read whole before it runs, so a newer copy of this file landing mid-run changes nothing.
main() {
  local feed_dir="${ARBOR_DEV_FEED_DIR:-$HOME/Library/Application Support/Arbor Dev Builds}"
  local checkout="${ARBOR_DEV_CHECKOUT:-$HOME/.arbor/dev-build/checkout}"
  local settle="${ARBOR_DEV_SETTLE_SECONDS:-300}"
  local status_file="$feed_dir/status.json"
  local lock="$feed_dir/.lock"
  mkdir -p "$feed_dir/logs"

  # One build at a time. A second start leaves build-now to the running one, which builds again when it's done.
  if ! mkdir "$lock" 2>/dev/null; then
    local holder
    holder="$(cat "$lock/pid" 2>/dev/null || true)"
    if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then
      echo "A dev build is already running ($holder)."
      return 0
    fi
    rm -rf "$lock"
    mkdir "$lock"
  fi
  echo "$$" > "$lock/pid"
  # Global, so the trap still has it once main has returned.
  held_lock="$lock"
  trap 'rm -rf "$held_lock"' EXIT

  if [[ ! -d "$checkout/.git" ]]; then
    fail_status "$status_file" "" "The dev build clone isn't at $checkout; run scripts/install-dev-builds.sh again."
    return 1
  fi
  cd "$checkout"

  while true; do
    local requested=0
    [[ -e "$feed_dir/build-now" ]] && requested=1
    if ! git fetch --quiet origin main; then
      echo "Couldn't fetch origin; trying again next time." >&2
      return 0
    fi
    local target built failed state
    target="$(git rev-parse origin/main)"
    built="$(status_get "$status_file" builtCommit)"
    state="$(status_get "$status_file" state)"
    failed=""
    [[ "$state" == "failed" ]] && failed="$(status_get "$status_file" commit)"

    if (( ! requested )); then
      if [[ "$target" == "$built" ]]; then
        status_set "$status_file" state=idle step=
        return 0
      fi
      if [[ "$target" == "$failed" ]]; then
        return 0
      fi
      local age=$(( $(date +%s) - $(git log -1 --format=%ct "$target") ))
      if (( age < settle )); then
        status_set "$status_file" state=waiting commit="$target" step= error=
        return 0
      fi
    fi
    rm -f "$feed_dir/build-now"

    local log_name
    log_name="$(date -u +%Y%m%dT%H%M%SZ)-${target:0:7}.log"
    status_set "$status_file" state=building commit="$target" step=fetching error= finishedAt= \
      startedAt="$(now)" log="$log_name"
    # In a subshell outside any `if`, where set -e still stops the build at the first failure.
    local outcome
    set +e
    (set -e; build "$feed_dir" "$status_file" "$target" "$built") >"$feed_dir/logs/$log_name" 2>&1
    outcome=$?
    set -e
    if (( outcome == 0 )); then
      status_set "$status_file" state=idle step= finishedAt="$(now)"
      # The builder updates itself: the next run is main's copy of this script and its helper.
      if [[ -n "${ARBOR_DEV_INSTALL_DIR:-}" ]]; then
        local file
        for file in dev-build.sh dev-build.mjs; do
          cp "$checkout/scripts/$file" "$ARBOR_DEV_INSTALL_DIR/$file.new"
          chmod 755 "$ARBOR_DEV_INSTALL_DIR/$file.new"
          mv "$ARBOR_DEV_INSTALL_DIR/$file.new" "$ARBOR_DEV_INSTALL_DIR/$file"
        done
      fi
    else
      local reason
      reason="$(grep -v '^[[:space:]]*$' "$feed_dir/logs/$log_name" | tail -1 | cut -c1-500)"
      fail_status "$status_file" "$target" "${reason:-The build stopped without saying why.}"
    fi
    prune "$feed_dir"
    [[ -e "$feed_dir/build-now" ]] || return 0
  done
}

now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# The checkout's helper when it has one, else the copy installed beside this script.
helper() {
  if [[ -f scripts/dev-build.mjs ]]; then
    node scripts/dev-build.mjs "$@"
  else
    node "$(dirname "${BASH_SOURCE[0]}")/dev-build.mjs" "$@"
  fi
}

status_set() {
  helper status "$@"
}

status_get() {
  helper get "$1" "$2" 2>/dev/null || true
}

fail_status() {
  local file="$1" commit="$2" error="$3"
  echo "$error" >&2
  status_set "$file" state=failed step= finishedAt="$(now)" error="$error" ${commit:+commit="$commit"}
}

build() {
  local feed_dir="$1" status_file="$2" target="$3" built="$4"
  git checkout --quiet --force --detach "$target"
  git clean -fdq
  # The keys a build needs (Hugeicons' for bun install, PostHog's) are in the main checkout's untracked .env.
  if [[ ! -e .env && -n "${ARBOR_REPO:-}" && -f "$ARBOR_REPO/.env" ]]; then
    ln -s "$ARBOR_REPO/.env" .env
  fi

  local free_gb
  free_gb="$(df -g "$HOME" | awk 'NR==2 { print $4 }')"
  if (( free_gb < 12 )); then
    echo "Only ${free_gb} GB free, too little to build. Free some space and build again."
    return 1
  fi

  local arch
  case "$(uname -m)" in
    arm64) arch="aarch64" ;;
    x86_64) arch="amd64" ;;
    *) echo "Unsupported Mac architecture: $(uname -m)"; return 1 ;;
  esac
  local cargo_version version dmg
  cargo_version="$(node -e "import('./scripts/version.mjs').then(async (v) => console.log(v.parseCargoPackageVersion(await (await import('node:fs/promises')).readFile('src-tauri/Cargo.toml', 'utf8'))))")"
  version="$(helper version --cargo-version "$cargo_version" --count "$(git rev-list --count "$target")")"
  dmg="$feed_dir/Arbor-v$version-Darwin-$arch.dmg"

  if [[ "${ARBOR_DEV_DRY_RUN:-}" == "1" ]]; then
    echo "Dry run: a stand-in DMG for $version."
    printf 'dry run of %s\n' "$version" > "$dmg"
  else
    # Nothing an app on the dev channel could install comes from a Mac that can't sign for it.
    node scripts/release-signing.mjs check
    status_set "$status_file" step=installing
    bun install --frozen-lockfile
    status_set "$status_file" step=verifying
    bun run verify
    if [[ "${ARBOR_DEV_SKIP_RUST:-}" != "1" ]]; then
      bun run verify:rust
    fi
    status_set "$status_file" step=building
    ./scripts/build-release.sh "$version" "$dmg"
  fi

  status_set "$status_file" step=signing
  local work subjects
  work="$(mktemp -d "${TMPDIR:-/tmp}/arbor-dev-build.XXXXXX")"
  subjects="$work/subjects.txt"
  if [[ -n "$built" ]] && git merge-base --is-ancestor "$built" "$target" 2>/dev/null; then
    git log --format=%s "$built..$target" > "$subjects"
  else
    git log -1 --format=%s "$target" > "$subjects"
  fi
  local core_version
  core_version="$(tr -d '[:space:]' < core-version.txt)"
  helper manifest --version "$version" --arch "$arch" \
    --sha256 "$(shasum -a 256 "$dmg" | awk '{print $1}')" \
    --size "$(wc -c < "$dmg" | tr -d ' ')" \
    --commit "$target" --core-version "${core_version#v}" \
    --subjects-file "$subjects" --output "$work/manifest.json"
  if [[ "${ARBOR_DEV_DRY_RUN:-}" != "1" || "${ARBOR_DEV_DRY_RUN_SIGN:-}" == "1" ]]; then
    node scripts/release-signing.mjs sign --manifest "$work/manifest.json" --output "$feed_dir/arbor-update-dev.json"
  else
    echo "Dry run: not signing; the manifest is at $work/manifest.json."
    cp "$work/manifest.json" "$feed_dir/arbor-update-dev.unsigned.json"
  fi
  rm -rf "$work"
  # Only now is the build what the app offers.
  status_set "$status_file" builtVersion="$version" builtCommit="$target" builtAt="$(now)"
  echo "Built Arbor $version from ${target:0:7}."
}

# Keeps the newest three DMGs (the one on offer among them) and ten logs.
prune() {
  local feed_dir="$1"
  local offered=""
  offered="$(status_get "$feed_dir/status.json" builtVersion)"
  { ls -1t "$feed_dir"/Arbor-v*-dev.*-Darwin-*.dmg 2>/dev/null || true; } | tail -n +4 | while IFS= read -r old; do
    [[ -n "$offered" && "$old" == *"Arbor-v$offered-Darwin-"* ]] || rm -f "$old"
  done
  { ls -1t "$feed_dir"/logs/*.log 2>/dev/null || true; } | tail -n +11 | while IFS= read -r old; do rm -f "$old"; done
}

main "$@"

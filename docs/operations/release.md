# Releasing Arbor

Sessions don't release. Finished work goes to main, and the Release workflow
(`.github/workflows/arbor-release.yml`) turns main into releases on a timer, the way T3 Code ships. Everything here is
the maintainer's to run.

## The workflow

Planning a release and committing a stable one run on GitHub's Linux runners. The build needs a Mac, so it runs on
GitHub's macOS runner (`macos-latest`, paid by the minute while the repository is private, free once it's public),
never on anyone's own machine. Each release runs `bun run verify` and `bun run verify:rust` (the only place the Rust
tests run), builds with `scripts/build-release.sh` and publishes with `scripts/publish-workflow-release.sh`, in one job
so the DMG never becomes a GitHub artifact. The runner is new each time; rust-cache keeps the Rust builds between runs.

- **Nightly.** Checked once a day (17:23 UTC) by `scripts/release-plan.mjs`. One goes out once main has moved past the
  newest build (release commits alone don't count) and 20 hours have passed since the newest nightly, so a nightly
  started by hand that day holds back the scheduled one. Its version is
  `X.Y.Z-nightly.YYYYMMDD.N`: a prerelease of the patch after the newest release (or of `Cargo.toml`'s version if
  that's newer), where `N` is the workflow's run number. It has fixed notes, and nothing is committed for it. Only apps
  on the nightly channel (Settings › Updates) take it. Started by hand (channel nightly), it skips both waits.
- **Stable.** Only when the maintainer asks:

  ```sh
  ARBOR_RELEASE_SUMMARY="…" [ARBOR_RELEASE_CHANGES=$'…\n…'] [ARBOR_RELEASE_BUMP=patch|minor|major] ./scripts/release-stable.sh
  ```

  It checks the notes and starts the workflow, which promotes the newest nightly: the same commit, built as X.Y.Z, so
  stable only ships what nightly users already run. X.Y.Z is the nightly's own patch version; `ARBOR_RELEASE_BUMP=minor`
  or `major` makes it the next minor or major after the newest release instead, for a release that adds features or
  breaks something. Once it's published as the latest release, which every app reads, the workflow commits
  `Release Arbor X.Y.Z` (the version and notes) to main as github-actions.

Versions follow semver and are only ever changed by the workflow (or the emergency scripts below), never by hand.

## Secrets

`ARBOR_RELEASE_SIGNING_KEY` (the Keychain's update-list signing key as base64 PKCS#8, seen only by the publish step),
`HUGEICONS_LICENSE_KEY`, `ARBOR_POSTHOG_KEY` and, for source maps, `POSTHOG_CLI_API_KEY`.
`.github/workflows/arbor-checks.yml` runs `bun run verify`, the notices check and `bun run build` on GitHub's Linux
runners for every pull request and push to main; without the Hugeicons key it installs the free icons and still
passes. Bun on Linux writes some dates unlike the Mac (`Sept`, `14–20`), so tests compare dates through `macDates`
(`tests/support/macDates.ts`).

## The old runner

No job uses the self-hosted runner on the release Mac (label `arbor-release`, `scripts/install-release-runner.sh`) any
more. While it's still installed it guards itself: a pull request can change workflow files and ask for the runner by
its labels, and GitHub can't tie a personal
repository's runner to one workflow. So `scripts/release-runner-guard.sh`, installed as the runner's job-started hook,
fails any job before its first step unless it's `arbor-release.yml` as committed on main, started by the schedule or by
hand (`tests/releaseRunnerGuard.test.ts`). Never point another workflow at the `arbor-release` label. With the
repository public, keep Settings › Actions › "Approval for running fork pull request workflows" on all external
contributors.

## Tags

Arbor's tags are `arbor-vX.Y.Z` and `arbor-vX.Y.Z-nightly.YYYYMMDD.N`, made only by the workflow and
`publish-github-release.sh`. The `v*` tags are upstream's, and pushing one starts upstream's release workflow, so never
push tags yourself (`git push --tags` included).

## Release notes

The notes are public: the GitHub release, the app's update card, and anything that copies them. Each is a short
summary of what the release adds or changes at a feature level ("Sync: keep rules and commands per machine."), plus at
most three high-level changes. Never commit subjects, screen paths, internals, usage figures, other apps' names,
machines, people, emails or paths; `scripts/release-notes.mjs` refuses notes that name them, and British spellings.
Past notes live in `release-notes.json` and can be reworded there.

```sh
node scripts/release-notes.mjs check                                              # every past note
ARBOR_RELEASE_SUMMARY="…" node scripts/release-notes.mjs preview --pending <X.Y.Z>  # the next one
```

## Dev channel

Settings › Updates has a third channel, Dev, for the Mac that builds releases: that Mac's own builds of main, made
after each change instead of a few times a day. The Dev builds switch on that page runs the repository's
`scripts/install-dev-builds.sh` (asking for the repository the first time), which sets up a LaunchAgent running
`scripts/dev-build.sh` every two minutes; switching it off (or `--uninstall`) stops it.

Once main has been still for two minutes, or "Build latest main" leaves its `build-now` file, it builds origin/main in
its own clone in `~/.arbor/dev-build` (a clone, so nothing tidies it away) with `scripts/build-release.sh`, without the
test gates or a source map upload: main's commits passed the gates before they were pushed, and the nightly runs them
again. It signs the update list with the release key. The DMG, `arbor-update-dev.json`, `status.json` and the build
logs sit in `~/Library/Application Support/Arbor Dev Builds`; `scripts/dev-build.mjs` writes the version
(`X.Y.Z-dev.<main's commit count>`), the list and the status. The app reads only that folder on Dev
(`src-tauri/src/dev_builds.rs`), checks the signature, and offers any build that isn't the one running, since `-dev`
sorts below `-nightly`. A commit that failed isn't tried again until main moves or a build is asked for. Nothing is
published, and a session never sets the builder up or switches a real app to Dev.

## By hand, in an emergency

When the workflow can't run (the release Mac is off, GitHub is down) and the maintainer wants a release now:
`ARBOR_RELEASE_SUMMARY="…" ./scripts/publish-local-update.sh <X.Y.Z>` claims the number in the feed folder, checks the
notes, runs both verify gates, sets the version, adds the notes, builds and signs, and prints its next steps: commit
`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and `release-notes.json` with the message it wrote, fetch and rebase
(take the next number if main moved), push, then `./scripts/publish-github-release.sh <X.Y.Z>`, which creates the
GitHub release apps update from. `ARBOR_SKIP_VERIFY=1` skips the gates with a loud warning; it's for an urgent build,
never to get past a failure nobody has read.

## Disk

`scripts/clean-dev-disk.sh` removes idle worktrees' Rust build folders, worktrees whose work is on origin/main, and
feed DMGs GitHub also holds. The release script runs it when free space is low, and
`scripts/install-dev-disk-cleanup.sh` schedules it every six hours.

## Signing

Builds are ad-hoc signed (`codesign --sign -` in `scripts/build-release.sh`), not notarized, so a downloaded DMG needs
Open Anyway on its first launch (the README says how). Updates are protected separately: the app installs only what an
Ed25519-signed update list names (`src-tauri/release-signing.pub`, `scripts/release-signing.mjs`).

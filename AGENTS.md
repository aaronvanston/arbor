# Arbor: notes for coding agents

This file and `.claude/CLAUDE.md` are written and kept up to date separately, by hand.
Don't generate one from the other, merge them, or import one into the other. If you
change a rule here, make the same change there in that file's own words.

## What this is

Arbor is a macOS desktop app around CLIProxyAPI ("the core"), a local proxy that pools
a person's own subscription accounts (Codex, Claude, xAI and others) for the coding
agents on their own machines. Arbor runs the core, edits its config, signs accounts in,
watches limits, and records usage, machines and agent sessions. It's a fork of
EasyCLIProxyAPI, MIT licensed (see `LICENSE` and `THIRD_PARTY_NOTICES.md`).

Stack: Tauri 2, React 19, TypeScript, Tailwind CSS v4 and Base UI (`@base-ui/react`)
in the webview; Rust in `src-tauri/`; Bun is the package manager and test runner.
The bundle id is still `com.cpa.gui`, so the real app's data lives in
`~/Library/Application Support/com.cpa.gui`. Leave that folder alone. The session
archive is real data too: its index is in `session-archive/` inside that folder, and
its store is on the drive chosen in Settings › Session Archive. Leave those alone as well.

## Layout

- `src/App.tsx`, `src/navigation.ts`: the shell. The sidebar is a tree, laid out in
  `src/services/sidebarTree.ts` and drawn by `components/sidebar/SidebarTree.tsx`:
  Home on its own, then Fleet (Machines, with every machine listed under it, Sessions
  and Sync) and Spend (Accounts and Usage). Each page's views hang under it, and Alerts
  is the bell in the footer. Sync is still `setup` in ids and storage keys. Pages
  have no tabs of their own; the tree picks the view and the top bar's breadcrumb
  names it. Everything else is in the Settings area. `navigation.ts` has the page
  ids, in the tree's order that ⌘1–⌘6 follow, and `ViewContent` in `App.tsx` picks
  the page for each view. There's no URL routing. Open a page with a view that names
  its view and filters (`usageView`, `sessionsView`, `setupView`, `accountsView`,
  `machinesView`) so Back returns to them; history lives in
  `src/services/viewHistory.ts` and shortcuts in `src/services/shortcuts.ts`. When a
  view moves, its old id still has to land somewhere: `movedUsageView` sends Usage's
  old Capacity, Analysis, Failures and Claude Code (`telemetry`) to Accounts › Value,
  Overview, Requests with Failed on and Sync › Cost, and `movedSetupView` sends Sync's
  old Context to Cost, Projects to Sessions › Projects' Checkouts
  (`checkoutsView`, a Sessions view with `lens: 'checkouts'`) and Checklist to
  Machines. They cover links, the
  palette's saved picks and the view a page was left on (`savedUsageView`,
  `savedSetupView`); `tests/movedViews.test.ts` covers them. Sync's Checks and Arbor's
  changes kept their old ids, `overview` and `history`. Agent updates and each
  machine's agent versions live on Sync › Agents. Machines is the fleet at a glance
  (health rows, stats, usage by machine); each machine's leaf opens its own page
  (`machinesView(name)`, `pages/MachinePage.tsx`, rendered by `UsageRecordsPage` so
  it shares the range picker): its health, what's running, its agents, usage,
  sessions, setup against the reference machine and checkouts, with the "Bring …
  in line" checklist at the top when it's behind. Anything comparing machines stays
  in Sync. A machine's name is always its `MachinePill` (`components/identity/`);
  its color, fill and icon are picked in `MachineLookPicker`.
- `src/pages/`: pages and the larger sections they're built from.
- `src/components/`: shared components (limits, dashboards, dialogs, monitors).
  `components/ui/` holds the primitives; `components/layout/` holds page, settings-row
  and stat layouts.
- `src/services/`: the app's logic as plain functions, plus small stores that
  components read through `useSyncExternalStore` hooks. Most of the rules live here.
- `src/i18n/locales/en.ts`: every string the UI shows. English only.
- `src/native/`: the webview's side of the Tauri commands. `commands.ts` has
  `invokeCommand`; each domain file (`app.ts`, `core.ts`, `usage.ts`, `machines.ts`,
  `setup.ts`, `archive.ts`) lists its commands with the arguments they take and what
  they return; `types.ts` is the Rust types those use, written out by
  `bun run bindings` (see Conventions).
- `src/dev/mockTauri.ts` and `src/dev/mock/`: the browser mock of the Tauri side (see
  below).
- `src-tauri/src/`: `main.rs` registers the Tauri commands; `core_runtime.rs` runs and
  updates the core; `core_config/` edits its config; `management_api.rs` talks to the
  core's management API; `usage.rs` and `usage/` collect usage into SQLite and cover
  machines, machine health over SSH, setup scans, transcripts and capacity. Any screen
  that lists sessions reads them through `usage/session_read.rs` (`select_sessions`,
  then `complete_sessions` for peak context and compactions), so the numbers agree.
  usage.db's tables come from the ordered steps in `usage/schema.rs`, run once a
  launch before anything reads: a new table, column or index is a new step at the end
  of `STEPS`, never a `CREATE` or `ALTER` beside the queries, and tests open
  `schema::test_database()` rather than a table of their own. A write to the records
  takes `lock_usage_writes()` and reports what it changed through
  `publish_record_changes`, which moves the running count and reloads open views.
  Every script run on a machine goes through `usage/machine_health/shell.rs`: find the
  machine with `find_machine`, then `run_checked` (or `run_on_machine` for a script
  that reports each item itself, or `run_streaming` for output too big to hold, which
  has slots of its own). It caps how many run at once and notes each run in
  Diagnostics, so don't build SSH commands or take its slots anywhere else. A change to
  a file on a machine goes through `usage/machine_health/guarded_writes.rs`
  (`edit_start`, `edit_call` for each file, `edit_finish`): it writes only while the
  file is still as Arbor read it, backs it up first in `~/.arbor/setup-backups`, and
  lands on Sync › Arbor's changes, the one list where any of them can be undone;
  `app_update.rs` checks for and installs app updates; `phone_alerts.rs`,
  `digest_export.rs`, `quit_guard.rs` and `tray.rs` do what they say. Rust tests are
  in `tests.rs`, `tests/` and inline `#[cfg(test)]` modules.
- `src-tauri/src/usage/machine_health/archive.rs` and `archive/`: the session archive.
  Byte-for-byte copies of transcripts go into a store on another drive, with the index
  in `archive.db`. Settings › Session Archive is its page. This Mac's homes are read
  from disk, and each other machine's over SSH by `archive/remote.rs`, after this
  Mac's. `archive/imports.rs` takes in
  old backups of agent homes the maintainer picks there, `archive/layouts.rs` finds and lists
  backups in other shapes (OpenClaw, Claude's desktop app), and `archive/tokens.rs` counts the tokens in what it keeps for Usage ›
  All time. `archive/recovered.rs` reads Claude Code's own daily totals from the
  `stats-cache.json` copies it keeps, shown apart for days whose transcripts are gone.
- `tests/`: `bun:test` suites (`*.test.ts` and `*.test.tsx`).
- `scripts/`: the local update feed (`publish-local-update.sh`,
  `install-local-update-server.sh`), the GitHub record of each release
  (`publish-github-release.sh`, which is also the app's update feed), the public
  release notes in `release-notes.json` (`release-notes.mjs`), the update list's
  signing key (`release-signing.mjs`), disk cleanup (`clean-dev-disk.sh`, which removes idle
  worktrees' Rust build folders, worktrees whose work is on origin/main, and
  feed DMGs GitHub also holds; the release script runs it when free space is
  low, and `install-dev-disk-cleanup.sh` schedules it every 6 hours), version
  helpers, and packaging scripts inherited from upstream.
- `core-version.txt`: the core release the DMG bundles.

## Commands

From the repo root:

```sh
bun install                 # add --frozen-lockfile unless you're changing dependencies
bun run verify              # every TypeScript gate below, in order
bun run verify:rust         # the Rust tests
bun run build               # tsc + vite build into dist/, including the Tailwind CSS
bun run bindings            # rewrite src/native/types.ts after changing a Rust type
bun test tests/x.test.ts    # one suite
```

To time the reads behind each page, `src-tauri/src/usage/bench.rs` fills a usage.db
with a million requests and prints how long each takes. It's ignored in the normal run
and needs a release build, since a debug build compiles SQLite without optimization:
`cd src-tauri && cargo test --release usage::bench -- --ignored --nocapture`. Set
`ARBOR_BENCH_DIR` to keep the database between runs.

The gates are `package.json` scripts:

- `typecheck`: `tsc --noEmit`, for `src/`. `tsconfig.json` adds
  `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch` and
  `noImplicitOverride` to `strict`.
- `typecheck:tests`: `tsc -p tsconfig.test.json --noEmit`, the same settings over
  `src/` and `tests/` with Bun's types.
- `lint`: `oxlint --disable-nested-config`, configured in `.oxlintrc.json`. The
  `.claude/worktrees/` entry in `.gitignore` keeps oxlint out of those worktrees; the
  flag is a second guard, so their copies of the config never apply even if that
  entry goes missing.
- `knip`: `knip`, configured in `knip.json`; it reports unused files, exports and
  dependencies.
- `test`: `bun test`.
- `verify`: typecheck, typecheck:tests, lint, knip and test, in that order, stopping
  at the first failure.
- `verify:rust`: `cd src-tauri && cargo test`. Its bindings test fails when
  `src/native/types.ts` no longer matches the Rust types.
- `bindings`: runs that test with `ARBOR_WRITE_BINDINGS=1`, which rewrites the file.
- `build`: `tsc && vite build`, writing the gitignored `dist/`. `verify` doesn't run
  it, and it's the only gate that compiles `src/styles.css`, so a bad Tailwind
  utility passes `verify` and fails here.

`scripts/publish-local-update.sh` runs `bun run verify` and then
`bun run verify:rust` before it downloads, versions or builds anything, and stops if
either fails. `ARBOR_SKIP_VERIFY=1` skips both, with a loud warning; it's for an
urgent build only, never to get past a failure you haven't looked at.

Run `bun run verify` and `bun run build`, plus `verify:rust` if you touched Rust,
before calling work done. The release script doesn't run `build` until
`bun tauri build`, after it has bumped the version, so don't leave it to find a build
failure. Don't run `bun tauri dev` (it starts the real app) or `bun tauri build`
(only the release script builds the app).

## Checking the UI without the app

```sh
bunx vite --host 127.0.0.1 --port 1420 --strictPort
```

Then open http://127.0.0.1:1420. Use exactly this: plain `vite` listens only on
`::1`, and `bun run dev` listens on every interface.

In a Vite dev build outside the Tauri shell, `src/main.tsx` loads
`src/dev/mockTauri.ts`. It answers every Tauri command, and the core's management API
behind the `management_request` command, with made-up data, through `mockCommands` in
`src/dev/mock/answers.ts`. Each domain's answers form one map typed against that
domain's command list, so a missing answer, one for a command that's gone, or one of
the wrong shape doesn't compile. Each domain has a file in `src/dev/mock/` named for
it (`app.ts`, `core.ts`, `usage.ts`, `machines.ts`, `setup.ts`, `archive.ts`) with its
answers and its made-up data, typed with the generated types; `scenario.ts` has the
query string and the clock they share.

Scenarios are query-string flags, for example `http://127.0.0.1:1420/?core=stopped`.
The list is the comment at the top of `src/dev/mockTauri.ts`; a few more are
described where they're read (search for `params.get(`). Read it there rather than
guessing. When you add a Tauri command, add its answer to the domain's map; when the
webview stops calling one, delete the answer along with its list entry. When you add a
UI state (an error, an empty list, a warning), add a flag that shows it and list the
flag at the top of the mock.

## Conventions

- Match the code around you, and keep changes focused.
- Every string the UI shows, including `aria-label`, `title` and `placeholder`, is a
  key in `src/i18n/locales/en.ts`. Components read it with `const { t } = useI18n()`
  and `t('key', { name })`, where `{name}` in the message is filled in. A service that
  needs text takes a `t` function or returns a `MessageKey`, so it stays testable.
  `tests/uiLocalization.test.ts` fails on hard-coded text in `.tsx` files.
- Copy is plain, short and in sentence case. Say what happened and what to do next.
- Arbor is written in US English: the UI, messages, comments, docs, identifiers,
  commit messages and release notes all say color, behavior, canceled, gray and
  organize. `scripts/us-spelling.mjs` lists the British spellings;
  `tests/i18n.test.ts` fails on one in the UI text and `release-notes.mjs` won't
  publish notes with one. Names from other programs stay as they are spelled there,
  such as tokio's `is_cancelled`, `aria-labelledby` and GitHub's `CANCELLED`.
- Put logic in `src/services/` as plain functions and test it in
  `tests/<service>.test.ts`. Components stay thin. There's no DOM in tests: component
  tests render with `renderToStaticMarkup` from `react-dom/server`.
- With `noUncheckedIndexedAccess`, an index read may be `undefined`. Narrow it with a
  guard or destructuring rather than a `!`. In tests, read items with `itemAt` (a
  negative index throws), `lastItem` and `present` from `tests/support/items.ts`.
- Build UI from `src/components/ui/` (buttons, menus, dialogs, selects, switches,
  tooltips, badges, status dots, tables, empty states) before writing new markup.
  `Button` takes `disabledReason`, which keeps a disabled button focusable and shows
  why in a tooltip. Ticked menu choices use `MenuCheckboxItem` or `MenuRadioGroup`
  with `MenuRadioItem`, never hand-drawn ticks. Confirm with `useConfirmation()` from
  `components/ConfirmationDialog.tsx`, join classes with `cn()` from
  `src/lib/utils.ts`, and take icons from `components/ui/icons.tsx` (Hugeicons
  stroke rounded under Lucide names; add a new one there, with a duotone twin if a
  sidebar row can select it). The Pro duotone set needs `HUGEICONS_LICENSE_KEY` in
  the untracked `.env`; never commit the key. Number inputs are a
  `NumberField`, long paths and branch names a `MiddleTruncate`, refresh arrows a
  `RefreshIcon`, and a monospace input an `Input` with `font="mono"`; `Collapsible`
  and `Popover` are there too.
- A save that worked, or an Undo for something just removed, is a `toast()` from
  `components/ui/toast.tsx`. Every copy button goes through `useCopyToClipboard()`
  from `src/hooks/`: a button that passes `inline` gets a tick, the rest a toast.
  Errors stay in the inline notice next to what failed. Where there's no such place,
  as for a copy the clipboard refused or an action run from the search palette,
  which closes, the error is a toast of kind `error`, and it doesn't close on its
  own. Ask first with `useConfirmation()` only when the action can't be undone or
  changes what the proxy serves; otherwise do it and offer Undo.
- When the webview decides something from how a command failed, don't match its
  sentence. Have the command return a `CommandError` (`src-tauri/src/command_error.rs`)
  with a kind, plus the core's status and own words when it answered, and read it with
  `readCommandError` from `src/services/commandError.ts`. `managementApi` requests and
  `install_core_version` already do. A command whose failure is only shown can keep
  returning a sentence. Text from other programs, such as ssh's stderr, still has to
  be matched as text.
- Call a Tauri command with `invokeCommand` from `src/native/commands.ts`, not
  `invoke`. Its entry in the domain's file under `src/native/` gives the arguments it
  takes and what it returns, and `tests/commandParity.test.ts` checks each entry
  against the Rust signature. The types come from Rust: give each type a command takes
  or returns `#[derive(TS)]`, list it in `src-tauri/src/bindings.rs`, and run
  `bun run bindings`. Use those types rather than writing copies in TypeScript, and
  when TypeScript needs a narrower one (a union where Rust has a `String`), make it an
  enum in Rust instead. The exception is text Rust only keeps or hands on from
  somewhere else, like GitHub's review states or a transcript's compaction trigger,
  or words it shares with a script running on a machine, like the reasons a machine
  gives for refusing a skill: it stays a `String`, and `#[ts(type = "...")]` spells
  out the values its doc comment lists. A field serde can leave out gets
  `#[ts(optional)]`, which the parity test checks, and a query struct whose fields
  all have defaults gets `#[ts(optional_fields)]` so the webview sends only what it
  uses. Every type lands in the one `types.ts`, so give a nested type whose name is
  vague or taken `#[ts(rename = "...")]`. Don't do that to a type a command takes or
  returns directly: the parity test finds those by their Rust name, so rename the
  Rust type instead. Every command registered in `main.rs` has an entry, and the
  parity test fails when one is missing or when a file outside `src/native/` imports
  `invoke`.
- Alerts go through `notify()` in `src/services/notify.ts`, so they reach the Mac,
  the phone and the alert history. While Arbor's window is in front it shows them as
  toasts instead of Mac notifications, and it folds a repeat within ten minutes into
  its entry, except agents asking for you and setup changes, which each stay their
  own. So don't toast or de-duplicate alerts yourself. Give each a `subject` so it
  can be opened and its repeats matched: the one account, machine, session, page or
  provider it's about, or every account or machine in `accounts` or `machines` when
  it covers several. Only an alert about one thing folds; one about several, or
  about nothing, always goes out.
- A process Arbor starts goes through one of two helpers, so it inherits none of
  Arbor's open files (macOS hands a child every file that isn't close-on-exec, and a
  long-lived child such as the core would hold them open): `configure_helper_command` for a quick tokio
  one such as ssh, sh, git or ping, and `configure_background_command` for a std one
  that can outlive the call, such as the core, the update helper or `open`. Links and
  files open through `system_open::open_with_system`; tauri-plugin-opener's
  `open_url` and `open_path` never reap the `open` they start.
- The core's settings have one home, its config.yaml. Arbor's config.toml holds only
  Arbor's own settings, the plaintext management key, client key names filed by the
  key's fingerprint, and paused keys (`core_config/ownership.rs`). Don't copy a core
  setting into config.toml, and don't write Arbor's values over an existing
  config.yaml when the core starts: a save changes config.yaml, and the in-memory copy
  is read back from it.
- Arbor edits config.yaml itself, under `lock_core_config_file`, for aliases as for
  every other setting; it doesn't PUT the file through the core. It writes the v8
  path of a setting and removes the setting's old-layout spelling in that same edit.
- Configuration belongs in Settings. Main pages stay compact and show state. Give a
  new `SettingsRow` a `settingId` and an entry in `src/services/settingsIndex.ts`,
  which Settings search and ⌘K read; a test checks the two match.
- Comments explain why, not what.

## Safety rules

- Never run the real app against live data, and never read or write the real config,
  credentials or usage database. Use the browser mock and tests.
- Never call real claim, reset or redeem endpoints (quota resets, reset credits,
  banked resets). They spend something that can't be undone. Mocks and tests only.
- Tests never SSH to a real machine or reach the network. Bun tests fake Tauri with
  `mockCommands` from `src/dev/mock/answers.ts`, which types each answer like the
  browser mock's; `tests/commandParity.test.ts` fails on any other use of `mockIPC`.
  Rust tests parse sample command output.
- Secrets are never shown, logged or stored on the webview side (no `console`
  output, no `localStorage`): account tokens, MCP servers' env and headers, and env
  values in agent settings. Setup scans pass only names and salted fingerprints of
  such values to the UI.
- From agent transcripts and other apps' databases, match things by the ids those
  stores record and never by guesswork. Read only the fields a feature needs. Outside
  the session archive, never read or keep conversation text: prompts, messages,
  summaries, or tool inputs and outputs.
- The session archive is the one exception, and a narrow one. It copies transcript
  files byte for byte into a store's `chunks/` (and a growing file's end into
  `pending/`) and nowhere else. `archive.db`, the store's `journal/`, listings, logs and
  every archive command carry only ids, paths, sizes, hashes and times, plus, for token
  counting, each call's hashed id, day, model name and token counts, and from Claude
  Code's `stats-cache.json` each machine's days with their model names, token counts and
  session counts. Working out which session a file is, and counting its tokens, uses
  structs that name only those fields.
  The archive's SECRET tests prove this; extend them for every new archive command.
- Never delete or rewrite anything in a store's `chunks/`, except to replace a file
  proven corrupt with a verified copy of the same hash. Superseded tails stay.
- Archive tests never touch `/Volumes/Archive`, the app's `session-archive/` folder or real
  agent homes. They build stores and homes in temp dirs, and run the lister under both
  `sh` and `dash` against a temp HOME.

## Releases

The maintainer runs releases, or an agent the maintainer has told to release.

1. `git fetch origin`. Rebase onto `origin/main` and take the next patch number
   nobody has used yet; the current one is in `src-tauri/Cargo.toml` there. Someone
   else may be releasing at the same time.
2. `ARBOR_RELEASE_SUMMARY="…" ./scripts/publish-local-update.sh <X.Y.Z>`. The
   summary is required: one line saying at a feature level what the release adds or
   changes (see Release notes below). `ARBOR_RELEASE_CHANGES` can add up to three
   high-level changes, one a line. It stops on uncommitted changes or a HEAD that isn't on top of `origin/main`. Its
   first step is to claim the version in the feed folder (`.claims/X.Y.Z`), which fails
   if another run got there first or the number is already out, and a run that
   stops early lets go of its claim. It then checks and prints
   the release notes, runs `bun run verify` and `bun run verify:rust` (see Commands),
   sets the version in `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`, adds the notes
   to `release-notes.json`, builds and signs the app (refusing a build that still
   contains the builder's home folder), and writes the DMG to
   `~/Library/Application Support/Arbor Updates`, with a manifest there for older apps
   that read that local feed. It finishes by printing the next steps.
3. Commit only those files with the message the script wrote:
   `git commit -F <message file> -- src-tauri/Cargo.toml src-tauri/Cargo.lock release-notes.json`.
   The subject is `Release Arbor X.Y.Z` and the body is the summary.
4. `git fetch origin` again. If `origin/main` moved during the build, someone else
   may have published the same number; rebase and publish again with the next one.
5. Push to `origin`'s `main`.
6. `./scripts/publish-github-release.sh <X.Y.Z>` publishes the release on
   `aaronvanston/arbor`: an `arbor-vX.Y.Z` tag on the release commit, the notes, the
   DMG and `arbor-update-darwin.json`, the update list signed with the "Arbor release
   signing key" in the release Mac's Keychain, after checking the feed's DMG is still the one
   this release built. The app updates from the newest GitHub release, so no Mac is
   offered the release until this runs. `--dry-run` shows what it would do.

### Release notes

The notes are public: the GitHub release, the app's update card, and anything that
copies them. They're a short summary of what the release adds or changes, at a feature
level ("Sync: keep rules and commands per machine."), plus at most three high-level
changes when a release adds several things. Never commit subjects, screen paths,
internals, usage figures, other apps' names, machines, people, emails or paths;
`release-notes.mjs` refuses notes that name them. Past notes live in
`release-notes.json` and can be reworded there; `node scripts/release-notes.mjs check`
checks them all, and `ARBOR_RELEASE_SUMMARY="…" node scripts/release-notes.mjs preview
--pending <X.Y.Z>` shows what the next release will say.

Arbor's tags are `arbor-vX.Y.Z`, made only by that script. The `v*` tags are
upstream's, and pushing one starts upstream's release workflow, so never push tags
yourself (`git push --tags` included).

Never change version numbers by hand.

## Git

- Branch from `origin/main`, which is github.com/aaronvanston/arbor. If you add
  EasyCLIProxyAPI as a remote (call it `upstream`), never base work on it.
- Make logical commits. Subjects are imperative, plain English and say what changes
  for the user. The body says why.
- Never use bare `git stash`: the stash is shared by every worktree. Park work in a
  WIP commit, or push a stash with a unique message and apply it by its SHA.
- Don't push unless you are releasing or have been asked to.

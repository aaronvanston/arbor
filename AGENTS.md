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
The bundle id is `onl.arbor.app`, so the real app's data lives in
`~/Library/Application Support/onl.arbor.app`. Earlier versions ran as `com.cpa.gui`,
EasyCLIProxyAPI's id; `app_identity.rs` moves their folder across once and leaves a link
at the old path. Leave both alone. The session
archive is real data too: its index is in `session-archive/` inside that folder, and
its store is on the drive chosen in Settings › Session Archive. Leave those alone as well.

## Layout

- `src/App.tsx`, `src/navigation.ts`: the shell. The sidebar is a tree, laid out in
  `src/services/sidebarTree.ts` and drawn by `components/sidebar/SidebarTree.tsx`:
  Home on its own, then Fleet (Machines, with every machine listed under it, Pools, with
  every pool under it, Sessions, Automations and Sync) and Spend (Accounts and Usage). Each page's views hang under it, and Alerts
  is the bell in the footer. Sync is still `setup` in ids and storage keys. Pages
  have no tabs of their own; the tree picks the view and the top bar's breadcrumb
  names it. A view that can be narrowed to one machine (`hasMachineScope`, plus
  Checkouts and Sync › Cost) ends its breadcrumb with `MachineCrumb`, the machine
  picker, which other views of the same page keep. Everything else is in the Settings area. `navigation.ts` has the page
  ids, in the tree's order that ⌘1–⌘8 follow (Alerts is ⌘9), and `ViewContent` in `App.tsx` picks
  the page for each view. There's no URL routing. Open a page with a view that names
  its view and filters (`usageView`, `sessionsView`, `setupView`, `accountsView`,
  `machinesView`, `poolsView`) so Back returns to them; history lives in
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
  its color, fill and icon are picked in `MachineLookPicker`. Pools is every pool's
  health (`pages/PoolsPage.tsx`; `poolsView(id)` opens one pool's own page): who has
  room, each member's load against the limits, the next run's chances and where a
  burst would go. Settings › Pools only edits pools.
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
  lands on Sync › Arbor's changes, the one list where any of them can be undone.
  Where a machine's agents keep their files comes from one list,
  `usage/machine_health/agent_homes.rs`: the standard Claude Code, Codex and Pi homes,
  the ones a scan found and the ones the user added in Settings › Agent homes, each
  with a Sessions and a Sync switch. Every script that looks in an agent home loops
  over its generated `agent_homes` shell function (`shell_function`) instead of
  naming folders of its own;
  `app_update.rs` checks for and installs app updates; `phone_alerts.rs`,
  `digest_export.rs`, `quit_guard.rs` and `tray.rs` do what they say. Rust tests are
  in `tests.rs`, `tests/` and inline `#[cfg(test)]` modules.
- `src-tauri/src/usage/machine_health/automations.rs` and `automations/`: scheduled
  agent runs. `discover.rs` reads what the Codex app, Claude's scheduled tasks and Orca
  keep on each machine, held in memory only; `runner.rs` runs Arbor's own while the
  app is open, a precheck over SSH first and then the agent detached, whose output is
  never kept; `draft.rs` turns a sentence into a draft through the local proxy.
  An automation aimed at a pool has its machine chosen by `runs::pick_for_automation`
  when it's due. One set to run on its machine goes to `udian.rs` instead: Arbor
  installs the background runner it carries (ultradian, pinned in `udian-version.txt`,
  fetched into `bundled-udian/` by the release build) on that machine, writes the
  automation's schedule and scripts there, and reads its runs back, so it runs whether
  Arbor is open or not. ultradian keeps its own log of each run on the machine; Arbor
  never reads it.
- `src-tauri/src/usage/machine_health/pools.rs`, `runs.rs` and `runs_handoff.rs`:
  machine pools (members, weights, limits, what a full pool does) and the runs started
  on them, handed to T3 Code or Orca on the member picked, with the agent's own command
  line as the last resort. Arbor routes a run and keeps where it went, never its
  prompt.
- `src-tauri/src/usage/machine_health/pool_ssh.rs`: each pool as an SSH host,
  `ssh arbor-<pool>`. Arbor's own `~/.arbor/ssh/pools.conf` makes `arbor pools connect`
  the host's ProxyCommand, which asks the app for a member over the socket
  (`pools.connect`) and carries the bytes. A host name keeps its member while it's
  connected and ten minutes after, and only a member that stops answering loses it.
  Host keys come only from the user's own known_hosts, never a scan, and
  `~/.ssh/config` gets its one Include line only through a guarded write.
- `src-tauri/src/usage/machine_health/archive.rs` and `archive/`: the session archive.
  Byte-for-byte copies of transcripts go into a store in a folder the user picks,
  usually on another drive (this Mac's own disk works, with a warning), with the index
  in `archive.db`. Settings › Session Archive is its page. This Mac's homes are read
  from disk, and each other machine's over SSH by `archive/remote.rs`, after this
  Mac's. `archive/imports.rs` takes in
  old backups of agent homes the user picks there, `archive/layouts.rs` finds and lists
  backups in other shapes (OpenClaw, Claude's desktop app), and `archive/tokens.rs` counts the tokens in what it keeps for Usage ›
  All time. `archive/recovered.rs` reads Claude Code's own daily totals from the
  `stats-cache.json` copies it keeps, shown apart for days whose transcripts are gone.
- `src-tauri/src/cli/`: `arbor`, the command line, and `arbor mcp`, the same for
  agents. It's the app's own program, run through a link named `arbor`
  (`~/.local/bin`, added from Settings › App › Command line) or as `Arbor cli …`; a
  development build's program is itself called `arbor` and stays the app. It never
  opens Arbor's files: it sends each request over a private socket
  (`<data folder>/cli/arbor.sock`, folder 0700, same-user check) to the running app,
  which runs the same Tauri command the window would, so locks, guarded writes and
  events apply and an open window updates by itself. `server.rs` answers the socket,
  `dispatch.rs` runs a request, `commands.rs` is generated by
  `bun run cli-commands` (`scripts/cli-commands.mjs`, which also lists the commands
  left out and why, and those that need confirming), `bridge.rs` asks the window for
  what only it works out (limits, caps, routing, Sync's plan, alerts; the window's
  side is `src/services/cliHandlers.ts`), `redact.rs` hides secrets in every answer
  and event, and `audit.rs` keeps `cli/activity.jsonl` (method, client, outcome,
  never arguments). On the other side `args.rs`, `client.rs`, `render.rs`,
  `help.rs` (each command's own help, for `arbor help <command>`) and `mcp.rs`.
  `skill.md` is the skill that teaches agents `arbor`: `arbor skill` prints it, and
  Settings › App › Command line or `arbor skill install` put it in this Mac's store
  and Claude Code homes through guarded writes (`usage/machine_health/cli_skill.rs`);
  edit it when a command changes. A command Arbor would confirm returns its plan and exits 10 until it gets
  `--yes` (`confirm: true` over MCP). `management_request` and every claim, reset and
  redeem call are left out for good. Saved settings the CLI can change live in the
  app's `saved-store.json` (`saved_store.rs`); `savedStore.ts` keeps a store there
  unless it's `place: 'window'`.
- `tests/`: `bun:test` suites (`*.test.ts` and `*.test.tsx`).
- `scripts/`: the local update feed (`publish-local-update.sh`,
  `install-local-update-server.sh`), the release build it and the Release workflow
  share (`build-release.sh`), the GitHub record of each release
  (`publish-github-release.sh`, which is also the app's update feed), the Release
  workflow's plan and publish steps (`release-plan.mjs`, `publish-workflow-release.sh`),
  its runner (`install-release-runner.sh`) and how a stable release is started
  (`release-stable.sh`), the dev channel's builds of main (`dev-build.sh`,
  `dev-build.mjs`, set up by `install-dev-builds.sh`), the public
  release notes in `release-notes.json` (`release-notes.mjs`), the update list's
  signing key (`release-signing.mjs`), disk cleanup (`clean-dev-disk.sh`, which removes idle
  worktrees' Rust build folders, worktrees whose work is on origin/main, and
  feed DMGs GitHub also holds; the release script runs it when free space is
  low, and `install-dev-disk-cleanup.sh` schedules it every 6 hours), a new
  worktree's copy of the gitignored files `.worktreeinclude` lists, `.env` among them
  (`copy-worktree-includes.sh`; Claude Code copies them itself, and `t3.json` runs it
  when T3 Code makes a worktree), version helpers, and packaging scripts inherited
  from upstream.
- `core-version.txt`: the core release the DMG bundles.
- `udian-version.txt`: the ultradian release the DMG bundles for the background
  runner; empty builds without it.

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
before calling work done. A release doesn't run `build` until `bun tauri build`, at
the end of the workflow's build, so don't push work that leaves it to find a build
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

Scenarios are query-string flags, for example `http://127.0.0.1:1420/?core=stopped`,
or `?fresh=1` for Arbor on the day it's installed: no key, accounts, machines or
history yet.
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
  A new command also has to reach `arbor`: run `bun run cli-commands`, or add it to
  `LEFT_OUT` in `scripts/cli-commands.mjs` with the reason, and to
  `NEEDS_CONFIRMATION` if the window asks before running it.
  `tests/cliCommands.test.ts` fails until one of those is done.
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
- Arbor runs on anyone's Macs, so nothing in it is shaped around one person's setup.
  Don't build in a folder, file or name from a particular tool, machine, drive or
  account. A location Arbor needs comes from the agent homes list or a setting, and
  anything tied to a named app (T3 Code's threads, the Antiburn row) stays hidden
  until that app is found. Test and mock data use made-up names: `casey-mbp`,
  `~/.agent-app/homes/…`, `/Volumes/Backup`.
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
- Archive tests never touch a real store (the folder chosen in Settings › Session
  Archive), the app's `session-archive/` folder or real agent homes. They build
  stores and homes in temp dirs, and run the lister under both `sh` and `dash`
  against a temp HOME.

## Releases

Finished work goes to main, and the Release workflow
(`.github/workflows/arbor-release.yml`) releases it; it follows how T3 Code ships.
When your work is done and `bun run verify`, `bun run build` (and `verify:rust`
after Rust changes) pass, commit it, `git fetch origin`, rebase onto `origin/main`
and push to `main`. Don't bump the version, write release notes, build a DMG or
publish a release yourself.

The workflow runs every job on a self-hosted runner on the release Mac, labeled
`arbor-release` (`scripts/install-release-runner.sh` sets it up, and rerunning it
updates it), because GitHub bills a private repository's hosted minutes. Each
release runs `bun run verify` and `bun run verify:rust`, builds with
`scripts/build-release.sh` and publishes with `scripts/publish-workflow-release.sh`,
in one job so the DMG stays on that Mac.

- Nightly: checked every half hour and published once main has moved past the
  newest build (release commits alone don't count) and six hours have passed since
  the newest nightly (`scripts/release-plan.mjs`). Its version is
  `X.Y.Z-nightly.YYYYMMDD.N`, a prerelease of the patch after the newest release,
  with fixed notes, and nothing is committed for it. Only apps on the nightly
  channel (Settings › Updates) take it. Started by hand, a nightly skips both waits.
- Stable: only when the maintainer asks.
  `ARBOR_RELEASE_SUMMARY="…" [ARBOR_RELEASE_CHANGES=…] ./scripts/release-stable.sh`
  checks the notes and starts the workflow, which promotes the newest nightly: the
  same commit, built as X.Y.Z, so stable ships only what nightly users already run.
  Once it's published, the workflow commits `Release Arbor X.Y.Z` (the version and
  notes) to main. The release becomes the latest, which every app reads.

Its secrets are `ARBOR_RELEASE_SIGNING_KEY` (the Keychain's signing key as base64
PKCS#8, which only the publish step sees), `HUGEICONS_LICENSE_KEY`, `ARBOR_POSTHOG_KEY`
and, for source maps, `POSTHOG_CLI_API_KEY`. `.github/workflows/arbor-checks.yml` runs
the checks on GitHub's Macs for pull requests and pushes to main once the repository
is public.

A pull request can change workflow files and ask for the runner by its labels, and
GitHub can't tie a personal repository's runner to one workflow. So the runner checks
each job itself: `scripts/release-runner-guard.sh`, installed as its job-started hook,
fails any job before its first step unless it's `arbor-release.yml` as committed on
main, started by the schedule or by hand (`tests/releaseRunnerGuard.test.ts`). Never
point another workflow at the `arbor-release` label. When the repository goes public,
also set Settings › Actions › "Approval for running fork pull request workflows" to
all external contributors (GitHub only offers it on public repositories).

### Dev channel

Settings › Updates has a third channel, Dev, for the Mac that builds releases: it
takes that Mac's own builds of main, built after each change instead of a few times a
day. The Dev builds switch on that page turns it on and off: on runs the
repository's `scripts/install-dev-builds.sh` (asking for the repository the first time,
then remembering it), off stops the LaunchAgent. The script (`--uninstall` to stop)
sets up a LaunchAgent
running `scripts/dev-build.sh` every ten minutes. Once main has been still for five
minutes, or when "Build latest main" leaves its `build-now` file, it builds origin/main
in its own clone in `~/.arbor/dev-build` (a clone, not a worktree, so nothing tidies it
away), runs `bun run verify` and `verify:rust`, builds with `scripts/build-release.sh`
and signs the update list with the release key. The DMG, `arbor-update-dev.json`,
`status.json` and the build logs sit in `~/Library/Application Support/Arbor Dev
Builds`; `scripts/dev-build.mjs` writes the version (`X.Y.Z-dev.<main's commit count>`),
the list and the status. The app reads only that folder on Dev
(`src-tauri/src/dev_builds.rs`), checks the signature, and offers any build that isn't
the one running, since `-dev` sorts below `-nightly`. A commit that failed isn't
tried again until main moves or a build is asked for. Nothing is published, and a
session never sets the builder up or switches a real app to Dev; that's the
maintainer's to do.

### By hand, in an emergency

When the workflow can't run (the release Mac is off, GitHub is down) and the
maintainer wants a release now, the old local path still works:
`ARBOR_RELEASE_SUMMARY="…" ./scripts/publish-local-update.sh <X.Y.Z>` claims the
number in the feed folder, checks the notes, runs both verify gates, sets the
version, adds the notes, builds and signs, and prints its next steps: commit
`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and `release-notes.json` with the
message it wrote, fetch and rebase again (take the next number if main moved), push,
then `./scripts/publish-github-release.sh <X.Y.Z>`, which creates the GitHub release
apps update from.

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

Arbor's tags are `arbor-vX.Y.Z` and `arbor-vX.Y.Z-nightly.YYYYMMDD.N`, made only by the
GitHub script and the Release workflow. The `v*` tags are
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
- When work is finished and checked, push it to `origin`'s `main` (see Releases);
  don't push unfinished work unless you've been asked to.

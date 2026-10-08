# Arbor

Arbor is a Mac app that pools a person's own Claude, Codex, xAI and other subscription accounts behind one local
proxy, CLIProxyAPI ("the core"), and shares it with the coding agents on every machine they own. It runs the core,
signs accounts in, tracks their limits, and records usage, machines, agent sessions and each machine's agent setup.

It's a fork of EasyCLIProxyAPI, MIT licensed. Tauri 2: React 19, TypeScript, Tailwind CSS v4 and Base UI in the
webview, Rust and SQLite in `src-tauri/`, Bun for packages and tests. The bundle id is `onl.arbor.app`.

## What we never compromise on

### 1. Private by design

People trust Arbor with their account sign-ins and a view into every agent session they run. Sign-ins stay on the Mac
that runs Arbor. Secrets never reach the webview. Arbor reads ids, times, models and token counts, never what anyone
said to an agent, with the session archive as the one narrow exception.

### 2. Nothing breaks your machines

Arbor changes files on other people's machines over SSH. Every change is checked against what was read, backed up
first, and undoable from one list. Anything reversible happens at once with Undo; we confirm only what can't be undone
or changes what the proxy serves.

### 3. Anyone's setup, not ours

Arbor runs on anyone's Macs and Linux boxes. Nothing is shaped around one person's tools, folders, machines, drives or
accounts. Locations come from the agent homes list or a setting, and a feature tied to a named app stays hidden until
that app is found.

### 4. Fast on real data

Real installs have millions of requests. Pages read from SQLite with that in mind (`src-tauri/src/usage/bench.rs`
times them), and nothing repaints or polls when it doesn't need to. `bun run perf:check` holds the webview to ceilings
that only ever come down (`docs/perf/PROCESS.md`).

## A small glossary

- **you** is the agent reading this file. **we** and **the maintainer** are the people building Arbor.
- **user** is the person running Arbor on their Mac.
- **the core** is CLIProxyAPI, the proxy Arbor runs. **the management API** is its admin interface.
- **account** is a provider sign-in the core routes requests to; **key** is a client key agents use to reach the proxy.
- **machine** is any Mac or Linux box Arbor watches; **this Mac** is the one running Arbor.
- **agent home** is a folder where a coding agent keeps its files (`~/.claude`, `~/.codex`, …).
- **pool** is a group of machines that runs and hands off agent work as one.
- **Sync** keeps machines' agent setup in step with a **setup repo**. It's still `setup` in ids.
- **guarded write** is the only way Arbor changes a file on a machine.
- **the archive** is the session archive: raw transcript copies in a **store** on a drive the user picks.
- **view** is a page plus its params; there's no URL routing.
- **the mock** is the browser stand-in for the whole Rust side.

## The five ways to hurt yourself

1. **Touching live data.** `~/Library/Application Support/onl.arbor.app` holds the real config, credentials and usage
   history, and `com.cpa.gui` beside it is a link to it. The archive's index (`session-archive/` there) and its store
   (the drive picked in Settings › Session Archive) are live too. Don't launch the real app, don't read or change any
   of it, and never start `bun tauri dev` or `bun tauri build`. Work in the mock and tests.
2. **Spending something real.** Claim, reset and redeem calls (quota resets, reset credits, banked resets) use
   something up for good. They're only ever mocked.
3. **Reaching out of the sandbox.** Tests never SSH anywhere real or touch the network. Bun tests fake Tauri with
   `mockCommands` from `src/dev/mock/answers.ts`, never `mockIPC`; Rust tests parse sample command output.
4. **Leaking what Arbor sees.** Account tokens, MCP servers' env and headers, and env values in agent settings are never
   shown, logged or stored in the webview, `localStorage` included; setup scans send names and salted fingerprints
   only. Data from transcripts and other apps' databases is linked by the ids they store, never by heuristics, and
   limited to the fields a feature uses. Conversation text (prompts, replies, summaries, tool inputs and outputs) is
   never read or kept outside the archive. The one other exception is a session's or thread's title behind an opt-in
   switch on Settings › Harnesses, off by default (T3 Code's Thread names; Claude Code's and Codex's Session titles):
   read only while it's on, held in memory for what names sessions, never saved, logged, archived or put in an alert,
   and dropped when it's turned off.
5. **Breaking the archive's edges.** Raw bytes live only in a store's `chunks/` and, for a file still growing,
   `pending/`, until the user exports sessions into a folder they name (`arbor archive export`). `archive.db`, `journal/`, listings, logs and every archive command hold ids, paths, sizes, hashes and
   times; token counting keeps a hash of each call's id with its day, model and token numbers, and Claude Code's own
   totals keep each machine's days with model names, token and session counts. Nothing more. Nothing in `chunks/` is
   ever deleted or rewritten, apart from swapping a proven-corrupt file for a verified copy with the same hash. Every
   new archive command gets a SECRET test, and archive tests use temp stores and temp HOMEs, with the lister run under
   `sh` and `dash`.

## Hit every surface

The most common defect here is a change that works where you tested it and is missing everywhere else. Before calling
work done, walk this list and say which entries applied:

- **Commands.** A new Tauri command has its entry in `src/native/` (`tests/commandParity.test.ts`), generated types
  (`bun run bindings`), an answer in the mock, and a place in `arbor` (`bun run cli-commands`, or `LEFT_OUT` with a
  reason). See [Commands and types](docs/internals/native-commands.md).
- **The CLI's skill.** A command that changes updates `src-tauri/src/cli/skill.md`.
- **The mock.** Every new UI state (a failure, an empty list, a warning) gets a scenario flag, listed at the top of
  `src/dev/mockTauri.ts`.
- **Text.** Every string, `aria-label`, `title` and `placeholder` included, is a key in `src/i18n/locales/en.ts`.
- **Settings.** A new `SettingsRow` or `SettingsSection` takes a `settingId` listed in `src/services/settingsIndex.ts`,
  which feeds Settings search and ⌘K.
- **Machines.** Macs and Linux, this Mac and remote ones, one machine and all of them. A view that can narrow to one
  machine uses the machine picker.
- **Reverse states.** A way in needs a way out: removal gets Undo, a change on a machine lands on Sync › Repo › Arbor's
  changes, a pause gets a resume.
- **Moved views.** A view that moves keeps its old id landing somewhere ([Navigation](docs/internals/navigation.md)).
- **Docs.** Check whether the change makes a doc wrong. Follow the documentation rules below before adding anything.

## Verifying

```sh
bun install --frozen-lockfile   # drop the flag only when changing dependencies
bun run verify                  # typecheck, tests' typecheck, lint, knip, bun test
bun run build                   # the only gate that compiles the Tailwind CSS
bun run verify:rust             # after Rust changes
bun run perf && bun run perf:check  # after webview or mock changes, about a minute
bun test tests/x.test.ts        # one suite
```

Finish with `verify` and `build`, plus `verify:rust` after Rust changes and `perf:check` after webview or mock changes.
When `perf:check` fails, a count went up: fix it, or if the growth is the point of the change (a new view's code),
raise that ceiling in `perf/baseline.json` by hand and say why in the commit. Never lower a ceiling by hand; `bun run
perf:ratchet` does that. A release reaches `build` only at the very end
of its build, so a failure pushed to main costs a nightly.

To see the UI, serve the mock with exactly `bunx vite --host 127.0.0.1 --port 1420 --strictPort` and open
http://127.0.0.1:1420 (plain `vite` binds only `::1`, and `bun run dev` binds every interface). Scenarios are
query-string flags such as `?core=stopped` or `?fresh=1`; read the list at the top of `src/dev/mockTauri.ts` instead of
guessing. Gate details, the mock's internals and the benchmark: [Development](docs/operations/development.md).

### macOS builds from a Linux box

On the Linux dev boxes `src-tauri` doesn't compile, because its macOS-only code isn't gated. When a change touches
`src-tauri`, run `mac-build` once before you finish, and it compiles the commit on the Mac Mini:

```sh
mac-build          # cargo check in src-tauri, for HEAD as committed
mac-build test     # cargo test there; `build` is a debug cargo build
```

It sends unpushed commits itself and pushes nothing, but uncommitted changes stay behind, so commit first. Don't run it
after every edit: the Mac runs one build at a time, at low priority because it's a desktop, and a newer request takes an
older one's place in the queue. `mac-build bundle` runs `tauri build` for the app alone in a throwaway worktree on the
Mac; use it only when the maintainer asks. The modes are in `.mac-build.toml`, and the `mac-build` skill covers the
rest.

## How it works

The webview never touches files, processes or the network: it calls Rust commands through `invokeCommand`, and Rust
runs the core, patches its config.yaml, keeps usage.db and reaches machines over SSH. `arbor` talks to the running app
over a socket and runs the same commands, so the window and the CLI agree. Details and their reasons:
[How Arbor fits together](docs/internals/overview.md).

## Where code lives

- `src/App.tsx`, `src/navigation.ts`, `src/services/sidebarTree.ts`: the shell and the sidebar tree.
- `src/pages/`: pages and their big sections. `src/components/`: shared pieces; `ui/` holds the primitives, `layout/`
  `Page`, `SettingsSection`/`SettingsRow` and `StatBlock`.
- `src/services/`: logic as plain, testable functions, and small stores read through `useSyncExternalStore`.
- `src/native/`: the webview's side of every Tauri command, and the generated `types.ts`.
- `src/dev/`: the browser mock. `tests/`: `bun:test` suites.
- `src-tauri/src/`: the core (`core_runtime.rs`, `core_config/`, `management_api.rs`), usage and machines (`usage.rs`,
  `usage/`), the CLI (`cli/`), updates (`app_update.rs`). Machines, automations and pools:
  [Machines](docs/internals/machines.md). The archive: [Session archive](docs/internals/session-archive.md). The CLI:
  [Command line](docs/internals/cli.md).
- `scripts/`: releases, notes, notices and dev tooling; each says what it does at the top.

## Taste

- Match the file you're in, and keep the diff to the task.
- Logic lives in `src/services/` with a `bun:test` suite; components stay thin. Tests have no DOM, so components are
  checked through `renderToStaticMarkup`.
- `noUncheckedIndexedAccess` is on. Guard or destructure instead of `!`; tests use `itemAt`, `lastItem` and `present`
  from `tests/support/items.ts`.
- Reach for `src/components/ui/` first. `Button`'s `disabledReason` explains a disabled button; ticked menu choices use
  `MenuCheckboxItem` or `MenuRadioItem`; numbers are a `NumberField`, paths a `MiddleTruncate`. Join classes with
  `cn()`. Icons come from `components/ui/icons.tsx`.
- A save that worked is a `toast()`. Copy buttons use `useCopyToClipboard()`. A failure stays inline beside what failed;
  one with nowhere on screen to go is a `kind: 'error'` toast that stays until dismissed.
- Alerts go through `notify()` (`src/services/notify.ts`), which reaches the Mac, the phone and the alert history, and
  folds repeats itself. Give each a `subject`.
- Never branch on an error's sentence; return a `CommandError`.
- Types come from Rust through `bun run bindings`. Never copy them into TypeScript.
- Every process starts through `configure_helper_command` or `configure_background_command`, and links open through
  `system_open::open_with_system`. Every script on a machine runs through `shell.rs`, and every file change on one is a
  guarded write.
- config.yaml owns the core's settings; config.toml holds only Arbor's own.
- Configuration lives in Settings. Main pages stay compact and show state.
- Copy is plain, short and sentence case: say what happened and what to do next. US English everywhere (color,
  canceled, gray); `scripts/us-spelling.mjs` guards it. Other programs' names keep their spelling.
- Test and mock data use made-up names: `cam-mbp`, `~/.agent-app/homes/…`, `/Volumes/Backup`.
- Comments say why.
- If a rule here fights the task in front of you, say so plainly and get the maintainer's sign-off before breaking it.

## Shipping

When the work is done and verified, commit it, `git fetch origin`, rebase onto `origin/main`, and push to `main`. Never
force it; if main moved, rebase again. The Release workflow does the rest. Never change versions, write release notes,
build a DMG, publish a release or push tags (`v*` tags are upstream's and start its release workflow). Don't set up the
dev channel or switch a real app to it. How releases work: [Releasing Arbor](docs/operations/release.md).

## Git

- Base work on `origin/main` (github.com/aaronvanston/arbor). EasyCLIProxyAPI, if added as `upstream`, is never a base.
- One logical change per commit. The subject is imperative plain English about what the user gets; the body says why.
- No bare `git stash`: every worktree shares the stash. Use a WIP commit, or a named `git stash push -m <unique>`
  applied by SHA.
- Push finished, verified work to main. Push unfinished work only when asked.

## Documentation

Most changes need no doc change. Agents and contributors can read the code.

- `docs/internals/` is for decisions and their reasons, constraints that cross components, and traps the code doesn't
  make obvious. Before adding a paragraph, ask what someone would get wrong without it.
- Don't keep file catalogs, narrate control flow, or record feature history. A constraint local to one function goes in
  a comment there.
- When a decision changes, rewrite or remove the text that describes it. Don't append the new behavior beside the old.
- `docs/operations/` holds development and release procedures.
- Don't commit plans, research notes or scratch files.

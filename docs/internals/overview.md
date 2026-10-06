# How Arbor fits together

Arbor is a Tauri 2 app. The webview (React, in `src/`) never touches files, processes or the network itself: it calls
Rust commands through `invokeCommand`, and the Rust side (`src-tauri/src/`) runs the core, edits its config, keeps
SQLite databases and reaches other machines over SSH. The `arbor` command line talks to the running app over a socket
and runs the same commands, so the window and the CLI never disagree.

## The core

CLIProxyAPI ("the core") is a separate Go program Arbor downloads from GitHub (pinned in `core-version.txt`), starts
and updates (`core_runtime.rs`). Arbor reads and changes its state through the core's management API
(`management_api.rs`) and its `config.yaml` (`core_config/`).

- config.yaml owns the core's settings. Arbor's config.toml keeps only Arbor's own settings, the plaintext management
  key, client key names filed by fingerprint, and paused keys (`core_config/ownership.rs`). Never copy a core setting
  into config.toml.
- A start only adds the management key and a missing port to an existing config.yaml; it never writes Arbor's values
  over it. A save changes config.yaml and reads it back into memory.
- Every write to config.yaml, aliases included, patches the file under `lock_core_config_file`, never through the
  core's config API, and puts a setting only at its v8 path, removing the old spelling in the same edit.
- An app update leaves the core running and the new version adopts it.

## usage.db

`usage.rs` and `usage/` record every request, machine, session and setup scan in SQLite.

- Tables come only from the ordered steps in `usage/schema.rs`, run once a launch before anything reads. A new table,
  column or index is a new step at the end of `STEPS`, never a `CREATE` or `ALTER` beside the queries. Tests open
  `schema::test_database()`.
- A write to the records takes `lock_usage_writes()` and reports what changed through `publish_record_changes`, which
  moves the running count and reloads open views.
- Every screen that lists sessions reads through `usage/session_read.rs` (`select_sessions`, then
  `complete_sessions`), so the numbers agree everywhere.

## Processes

macOS hands a child process every file that isn't close-on-exec, and a long-lived child such as the core would hold
Arbor's files open. So every process starts through `configure_helper_command` (tokio: ssh, sh, git, ping) or
`configure_background_command` (std: the core, the update helper, `open`, anything that can outlive the call). Links and
files open through `system_open::open_with_system`; tauri-plugin-opener's `open_url` and `open_path` never reap the
`open` they start.

## The hidden window

Closing the window only hides it, and it's hidden most of the time: the webview is the background service (alerts,
caps, limits, tray rows, the pools' report, the CLI's window actions all run in the monitors `AppRoot.tsx` mounts beside
the app, `App.tsx`). So:

- Anything that must keep going while nobody looks belongs in a monitor, never in a page. Half a minute after the
  window is closed or minimized (five when it's only covered) the open page rests: the content area renders nothing
  until the window shows, then the same view mounts again (`services/pageRest.ts`). A page holds that off only while
  it has unsaved edits (`useUnsavedChanges`), a dialog open, or a spinner or refresh showing.
- WebKit keeps a page's peak memory however much it lets go, so after half an hour closed or minimized (never only
  covered) the window reloads into a fresh page (`services/backgroundReload.ts`). That page starts in the background:
  the monitors start as at launch and `App.tsx` isn't even loaded until the window shows, back on the view it was
  left on. A monitor must therefore pick up from what's saved, not from memory: anything it alone keeps that would
  re-alert or restart a countdown is saved, carried over (`carryOverReload`), or holds the reload while it lasts
  (`holdReload`, as an alert going out, a CLI answer, a cap being applied and a queued update do). The page's own
  holds are the ones above.
- `backgroundThrottling` is off, so WebKit never slows a hidden page's timers. A monitor's check that runs more often
  than once a minute goes through `pacedInterval` or `throttleWaitMs` (`services/hiddenPace.ts`), which hold it to
  once a minute while hidden; alerts and the tray stay within that. A page's own polls skip while `document.hidden`.

## The first screen

The window shows before any of the app's script runs, on a static copy of the shell in `index.html`, and React's first
commit replaces it with the same picture. What someone changing the shell or Home needs to know:

- The build renders `src/boot/BootShell.tsx` into `#root` (vite.config.js, `bootShell()`). Its classes come from
  `components/sidebar/shellParts.ts` and Home's waiting skeletons from `components/homeSkeletons.tsx`, the same ones
  the real shell and Home use. A class written straight into the real shell instead drifts; `tests/bootShell.test.tsx`
  compares the markup, and `bun run perf` gates the handoff at 0 px moved and 0 pixels changed.
- Home shows those skeletons until it knows whether the core is running and the board is read, so React's first
  frame matches the static one. How many rows comes from `arbor.boot.v1` (`src/boot/bootState.ts`): counts only,
  written as Home loads. Anything else the first screen needs must be in the window's storage before the page loads;
  the app's own settings aren't readable yet.
- `src/boot/bootHead.ts` and `bootPaint.ts` are inlined into the page, so they import nothing that reaches a store or
  Tauri (that's why `sidebarLayoutRules.ts` and `sidebarTree.ts` hold no store). `bootPaint.ts` reads layout only in
  its first frame: a read while the page is parsing lays the whole page out early, and again after its changes.
- It sends `frontend_ready` itself; Rust shows the window on the first call and ignores the rest.

## What loads at launch

Home, the sidebar and the monitors load with the app; everything else loads when it's first used.

- The UI's strings are one typed table (`src/i18n/locales/en.ts`), which dev and the tests read whole. A build ships
  only the strings the launch's code names, and every lazily loaded module brings the ones its own code names
  (`scripts/vite-split-strings.mjs`). So a key built in code keeps a fixed start, `` t(`status.indicator.${x}`) ``,
  and never starts with a variable: the build can't tell which strings that needs, and the screen would show the raw
  key in a build only. An `import()` names its module as a string, or the build stops.

## Where to read more

- [Navigation](navigation.md): the sidebar tree, views, and old view ids that still have to land.
- [Commands and types](native-commands.md): `invokeCommand`, generated types, `CommandError`.
- [Machines](machines.md): scripts over SSH, guarded writes, agent homes, automations and pools.
- [Session archive](session-archive.md): the one place transcript bytes are kept.
- [Command line](cli.md): `arbor` and `arbor mcp`.

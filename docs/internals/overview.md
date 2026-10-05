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
caps, limits, tray rows, the pools' report, the CLI's window actions all run in the monitors `App.tsx` mounts beside
the page). So:

- Anything that must keep going while nobody looks belongs in a monitor, never in a page. Half a minute after the
  window is closed or minimized (five when it's only covered) the open page rests: the content area renders nothing
  until the window shows, then the same view mounts again (`services/pageRest.ts`). A page holds that off only while
  it has unsaved edits (`useUnsavedChanges`), a dialog open, or a spinner or refresh showing.
- `backgroundThrottling` is off, so WebKit never slows a hidden page's timers. A monitor's check that runs more often
  than once a minute goes through `pacedInterval` or `throttleWaitMs` (`services/hiddenPace.ts`), which hold it to
  once a minute while hidden; alerts and the tray stay within that. A page's own polls skip while `document.hidden`.

## Where to read more

- [Navigation](navigation.md): the sidebar tree, views, and old view ids that still have to land.
- [Commands and types](native-commands.md): `invokeCommand`, generated types, `CommandError`.
- [Machines](machines.md): scripts over SSH, guarded writes, agent homes, automations and pools.
- [Session archive](session-archive.md): the one place transcript bytes are kept.
- [Command line](cli.md): `arbor` and `arbor mcp`.

# A window left open for hours (2026-10-07)

The owner's Arbor sat visible on a machine page for two hours and showed WebContent at 23% CPU, the GPU process at
27% and WebContent's memory at ~490 MB. The page-clock benchmark (`bun run perf`) passed: it counts commits and timers
but can't see painting, CSS animations or anything on the Rust side.

## How it's measured now

- `bun run perf:cpu` (`perf/idleCpu.ts`): real CPU of Playwright WebKit's WebContent and GPU processes while a page
  idles at the owner's window size, health rounds every 5 s. `--unfocused` is the owner's usual state (another app in
  front, so the sidebar art rests). `--case=all` covers every main page; `--css=` tries a style change before
  making it.
- `bun run perf:soak` (`perf/soak.ts`): hours on the page clock with health rounds every 5 s. Gates that elements,
  live timers, window and document listeners and native event listeners stay flat; reports the WebContent footprint
  and its slope per hour.
- The live app: `ps -o time` and `footprint` of the running Arbor, its WebKit helpers and the core, sampled every
  30 s. Process numbers only (PROCESS.md allows that), never its data.

## What the live app showed (dev.399, ~26 min, window visible, unfocused)

| Process | CPU | Footprint |
| --- | --- | --- |
| Core (CLIProxyAPI) | ~20% while agents ran | 200–300 MB |
| Arbor (Rust) | ~5% | 41 → 80 MB |
| WebContent | 0.6% idle, 8% while an update waited for agents | 128 → 346 MB |
| GPU | 0.2% idle, 3.6% then | 26 → 163 MB |

## Webview, ranked

1. **Chart scroll under the page's scroll mask.** Every `[data-slot=page-scroll]` carries a `mask-image` even at the
   top, where it draws nothing (`styles.css`). The chart layers animate beneath it.
2. **Health rounds tween every number with a React commit per frame.** `useAnimatedNumber` runs a 600 ms rAF loop
   with `setState` each frame; `Meter` animates `width` (layout each frame). ~36 frames per round, every 5 s, on
   machine pages, for every row on Machines.
3. **`steps()` status pulses** (`--animate-status-pulse`) on working sessions, degraded machines and warning pills
   keep running while the window is unfocused. WebKit may not hand stepped animations to Core Animation.
4. **The spinner animates inside SVG** (`spinner.tsx`), which WebKit repaints every frame. It shows for long stretches
   in the update pill's steps, rollouts, scans and the core-locked page.
5. **The update pill's waiting ring** spins at display rate for as long as an update waits for agents to go idle.
6. **The fleet board is built two or three times per read** (`fleetBoard.ts` fingerprint, `AgentAttentionMonitor`,
   `sharedBoard`), 4–12 reads a minute while visible.
7. **`useCollectorStatus`** sets a new object every tick, re-rendering whole Usage views every 15–30 s.
8. Smaller: once-a-minute clock consumers without selectors (`LimitsMonitor`, `SidebarLimits`, `HomeAccounts`,
   Accounts), `proxyChecks` notifying unchanged values.

## Rust, ranked (Arbor's own ~5%)

1. **T3 Code's database is read in full every 5 s** while T3 Code writes (`t3_threads.rs` `LOCAL_TICK`): the
   unchanged check compares WAL size and mtime, which change every tick; each read opens a new connection and re-runs
   the schema probes.
2. **`get_fleet_sources` has no cache** (`usage/fleet.rs`): sessions over 6 h, up to 700 single-row lookups, and up
   to 1 MB over IPC, 4–12 times a minute while visible.
3. **The usage collector opens a connection per message** (`usage/collector.rs`) and wakes every 2 s.
4. **Diagnostics prune on every flush** (`usage/diagnostics.rs`): four DELETEs with window functions, up to every 2 s.
5. **The health sampler forks ~50 processes per local sample**, every 5 s while a machine page is visible, even
   unfocused. Not counted in Arbor's CPU, but the Mac pays for it.
6. **`wanted_sessions` is recomputed per machine** each transcript wave (`transcripts.rs`).
7. Smaller: config.yaml parsed ~9 times a minute for the listen host (`core_runtime.rs`), the archive lister
   rewriting every row each pass, the config watcher waking on Arbor's own database writes.

## Memory

No collection in Arbor's code grows only with uptime: the memory audit traced every module-level cache, store,
listener and timer to a cap, a prune or a fixed key set. Suspects for the live growth are churn, not leaks:

- **The tray menu is rebuilt on most health reads** (`tray.rs`, `set_tray_rows`), with a new PNG and NSImage per
  dotted row, since the machine rows carry live numbers. Up to ~120 rebuilds an hour.
- Tauri's own JS event registry keeps an entry per `listen()` ever made (`tauri` `event/mod.rs`); small.
- WebKit keeps its JS heap at its high point, so high-rate churn (fleet reads, health merges) raises the floor of a
  window that never reloads.

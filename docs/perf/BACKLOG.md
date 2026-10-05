# Speed and memory backlog

Ranked from the three audits in `findings/` (webview-idle, rust-side, launch-and-residual), 2026-10-06. Each item
becomes one fix session following `PROCESS.md`: bench first with `bun run perf` (or `usage/bench.rs`), fix, ratchet.
"Visible" items need the owner's sign-off before they ship.

## Wave 1: no visible change, small, independent

| # | Slow spot | Where | Counter that must drop | Effort |
| --- | --- | --- | --- | --- |
| W1 | Fleet sources re-read every 5–15 s even when hidden, fresh object every time, board rebuilt | `FleetMonitor.tsx:61`, `fleetBoard.ts:761` | native bytes per idle minute, commits per idle minute | S–M |
| W2 | Stores emit new objects when nothing changed (health, identities, pools previews, sidebar tree, Home) | `fleetHealth.ts:41`, `useMachineIdentities.ts:20`, `pools.ts:121`, `SidebarTree.tsx:105` | commits per idle minute | S |
| W3 | `useQuotaClock` re-renders 24 consumers every minute | `quotaTime.ts:61` | commits per idle minute | S |
| W4 | Prefetch everything at 2 s → prefetch on hover, focus, ⌘-digit, palette highlight | `App.tsx:166` | JS bytes loaded at idle | S |
| W5 | Three dialogs and react-markdown load at launch | `App.tsx:27`, `HomeDashboard.tsx:18`, `HomeProxy.tsx:23`, `AutomationPage.tsx:4` | launch JS bytes | S |
| W6 | Accounts list fetched up to 5× at once | `accountsStore.ts:99,234` | native calls at launch | S |
| W7 | ~30 native calls in the first render; monitors compete with Home | App shell monitors | calls before Home settles, time to Home | S |
| W8 | Sidebar art: 60 rAF callbacks/s for 15 frames/s | `SidebarArt.tsx:69` | rAF per idle second | S |
| W9 | English strings are 40% of the entry chunk | `src/i18n/locales/en.ts` | launch JS bytes, parse time | S (JSON.parse) then M (split by area) |
| W10 | Always-mounted full-window glass layer, footer backdrop blur | `QuitGuard.tsx:46`, `data-table.tsx:96` | composited layers (reported) | S |

## Wave 2: Rust side, bench in `usage/bench.rs` first

| # | Slow spot | Where | Counter | Effort |
| --- | --- | --- | --- | --- |
| R1 | Sessions page builds and sorts every session to return one page | `usage.rs:1387`, `session_read.rs:69` | page-1 latency and peak memory at 1M requests | M |
| R2 | Usage views rescan requests and rebuild cost groups every refresh | `usage.rs:853,1264`, `cost_groups.rs:43` | rows visited, latency, result bytes | M |
| R3 | Health sampler: SSH + ping every minute while hidden, 5 s while viewed, event every round | `machine_health.rs:84` | SSH launches per idle minute, events emitted | S–M |
| R4 | Setup/transcript scans hit every machine at once | see `findings/rust-side.md` §4 | concurrent SSH peak | S |
| R5 | Tray counts read the whole fleet and T3 threads | see `findings/rust-side.md` §5 | bytes read per tray update | S–M |

## Wave 3: residual memory (needs owner decisions)

| # | Change | Visible? | Effort |
| --- | --- | --- | --- |
| M1 | Unmount the open page while hidden, keep monitors; slower cadence while hidden | No (cadence: maybe) | S–M |
| M2 | Static first screen in `index.html`, generated from a shared `<BootShell/>` | Yes | M |
| M3 | Reload into "monitors only" after a long hide (fresh heap) | Barely | M |
| M4 | Move alerts, caps, limits, routing, pool report, tray rows and CLI actions to Rust, in that order; then destroy the webview on close | Reopen becomes a cold start | XL |

## Still to measure

- The real window: `footprint <pid>` and `ps` samples over an idle minute with Arbor open, visible and hidden.
- Whether the perf counters move with the window's memory and wall-clock time (step 3 of the process).

## Owner decisions (2026-10-06)

- The window is **mostly hidden or closed** when the memory shows, so hidden cost goes first: W1, M1, M3, R3 lead.
- Hidden pace: **only a little slower**. Alerts and tray counts stay within about a minute while hidden (for example
  the fleet board every 60 s instead of 5–15 s, and no 5 s health bursts). Nothing that feeds an alert waits longer.
- Residual memory: **M1 + M3** (unmount while hidden, reload into monitors-only after a long hide). M4,
  destroy-on-close, is not planned.
- M2, the static first screen: **design it**, and show before/after shots before it ships.

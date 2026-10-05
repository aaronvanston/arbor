# Baseline: what `bun run perf` measures on 2026-10-06

The first run of the benchmark (step 2 of `docs/perf/PROCESS.md`), at commit 72406e27 plus the perf tooling. Every
later fix is checked against these numbers; `perf/baseline.json` holds them as ceilings.

## How it's measured

`bun run perf` builds the mock as the demo site (`vite build --mode demo --sourcemap hidden` into `.perf/site/`), serves
it on 127.0.0.1 and drives it in Playwright's WebKit (1.63.0, the cached webkit-2359), 1440×900, UTC, a fresh profile
per journey. Counters go in through an init script (`perf/counters.ts`) and the mock's `observe` hook on
`mockCommands` (`src/dev/mock/answers.ts`); nothing is added to the app's own code. Call sites are mapped back to
source through the hidden source maps (`perf/sourcemap.ts`).

- **Journeys.** Cold launch: load, then 5 s on the page clock. Open each page: from Home, through `window.__mockOpen`
  (the demo's in-app navigation), 3 s of page clock each, in the order of the table below. Idle: 10 minutes on Home on
  the page clock, in 1 s steps.
- **Page JS.** `usePagePrefetch` (`src/App.tsx:166`) loads every page two seconds after launch, so opening pages in a
  row loads no JS at all. Each page's JS is therefore a cold start on that page (`?page=…`) stopped at 1.9 s, less what
  a cold start on Home loads. Mock-only chunks (more than half their source in `src/dev/`) are left out of "app JS";
  the mock's own chunk is 261 KB.
- **Frames.** The page clock waits a real task after every timer it runs (~7 ms), so a draw-every-frame loop made 10
  minutes of idle take four and a half minutes. Frames run for the first 10 s of idle and are counted there, then held
  (counted, callback never run); `rafPerSecond` is the 10 s sample.
- **Determinism.** Five runs gave identical counts except React commits (±2, when a lazily loaded chunk lands decides
  React's batching) and command bytes (±4 bytes in launch and Accounts replies). Those two have a tolerance in
  `perf/baseline.json` (3% or 2 commits; 0.1% or 16 bytes); everything else must not go up at all.
- **Real size** is the new `?size=real` mock scenario: 14 machines, a million requests recorded (1,000 request rows),
  400 more sessions, the setup repo with 50 skills (and 50 removed), 40 T3 Code threads.

A full run (both sizes) takes about a minute.

## The numbers

Gated counts. App JS is per page (cold start beyond Home) and doesn't depend on the mock's size.

| Journey | App JS KB | Commits (def / real) | DOM mutations (def / real) | Commands (def / real) | Command KB (def / real) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold launch → Home settled (5 s) | 2,951.5 (1,590.2 for Home) | 121 / 121 | 321 / 334 | 83 / 83 | 199.5 / 576.7 |
| Open machines | 727.8 | 15 / 15 | 48 / 65 | 7 / 7 | 217.4 / 801.9 |
| Open machine (ci-01) | 727.8 | 22 / 22 | 110 / 122 | 17 / 17 | 408.2 / 942.5 |
| Open pools | 45.4 | 6 / 5 | 43 / 44 | 3 / 3 | 2.7 / 2.7 |
| Open sessions | 727.8 | 10 / 10 | 67 / 109 | 10 / 10 | 49.8 / 131.3 |
| Open automations | 241.5 | 7 / 7 | 48 / 48 | 3 / 3 | 5.6 / 5.6 |
| Open sync (Checks) | 374.0 | 10 / 9 | 46 / 47 | 6 / 6 | 40.5 / 40.5 |
| Open sync › agents | 374.0 | 3 / 3 | 24 / 24 | 3 / 3 | 125.0 / 134.4 |
| Open sync › skills | 374.0 | 5 / 5 | 91 / 91 | 4 / 4 | 21.6 / 33.7 |
| Open sync › repo | 374.0 | 4 / 4 | 9 / 9 | 5 / 4 | 35.6 / 62.2 |
| Open sync › plugins | 374.0 | 5 / 5 | 33 / 33 | 3 / 3 | 13.7 / 13.7 |
| Open sync › hooks | 374.0 | 2 / 2 | 11 / 11 | 1 / 1 | 0.1 / 0.1 |
| Open sync › toolchain | 374.0 | 4 / 4 | 16 / 16 | 3 / 3 | 9.4 / 9.4 |
| Open sync › cost | 374.0 | 3 / 3 | 18 / 18 | 3 / 3 | 54.4 / 54.4 |
| Open sync › history | 374.0 | 4 / 5 | 11 / 12 | 3 / 3 | 25.7 / 52.9 |
| Open accounts | 175.7 | 9 / 9 | 64 / 65 | 7 / 7 | 7.0 / 6.9 |
| Open usage | 727.8 | 8 / 8 | 69 / 71 | 8 / 8 | 7.3 / 9.9 |
| Open alerts | 6.9 | 5 / 5 | 16 / 16 | 3 / 3 | 1.0 / 1.0 |
| Open settings (General) | 74.8 | 6 / 6 | 61 / 61 | 3 / 3 | 0.9 / 0.9 |
| Back to home | — | 21 / 21 | 65 / 96 | 17 / 17 | 102.0 / 206.5 |

| Idle on Home, 10 minutes | Default | Real size |
| --- | ---: | ---: |
| Commands per minute | 17.4 | 16.4 |
| Command bytes per minute | 146,226 | 326,535 |
| React commits per minute | 9.7 | 9.7 |
| DOM mutations per minute | 5.8 | 5.8 |
| App timer fires per minute | 28.7 | 28.7 |
| Live app timers at the end | 18 | 18 |
| requestAnimationFrame calls per second | 62.7 | 62.7 |

Reported only (real clock, no counters in the page; noisy):

| | Default | Real size |
| --- | ---: | ---: |
| First contentful paint | 204 ms | 199 ms |
| DOMContentLoaded | 56 ms | 46 ms |
| Settled (last DOM change before 1 s of quiet) | 943 ms | 963 ms |
| WebContent RSS after launch | 232 MB | 256 MB |
| WebContent RSS over 10 min idle (page clock, counters in) | 287 → 336 MB | 291 → 336 MB |

## What the counters show, ranked

Sure-ness is about the finding being real in the app, not just in the mock.

1. **The sidebar art draws every frame while the window has focus.** 62.7 `requestAnimationFrame` calls a second on
   an idle Home, 37,500 canvas frames in ten minutes, each a `drawScene` over the whole canvas and a `putImageData`
   (`src/components/sidebar/SidebarArt.tsx:74-82`, the frame request at `:81`). Nothing else in the app asks for
   frames while idle (Base UI's `useAnimationFrame` asked twice). Most likely the largest share of idle CPU. Benchmark:
   `idle.rafPerSecond`; to prove it matters, compare the running Arbor's `%cpu` with the art on and set to None.
   Fix: draw at a low rate (the scene drifts slowly) or stop after a while without input; it changes how the art
   moves, so it needs the owner's sign-off. Sure: high.
2. **The live board's source read every 15 seconds is most of idle's IPC.** `get_fleet_sources`
   (`src/components/FleetMonitor.tsx:12`, interval at `:61`, debounce at `:33`) runs 4 times a minute at 25 KB
   (default) or 52 KB (real, 40 T3 Code threads): 100 KB of the 143 KB a minute idle sends by default and 209 KB of
   319 KB at real size. Benchmark: `idle.commandBytesPerMinute`. Fix: send only what changed since the last read, or
   read less often while the board isn't on screen. Sure: high that it dominates the webview's side; the Rust side's
   cost per read needs its own bench.
3. **A launch loads every page.** 2,951 KB of app JS is parsed by five seconds in; Home needs 1,590 KB of it. The rest
   is `usePagePrefetch` (`src/App.tsx:166-170`) importing every page two seconds after launch. That's parse and compile
   time and memory spent on pages most launches never open. Benchmark: `launch.appJsBytes` against
   `launch.homeJsBytes`. Fix: prefetch the pages the sidebar's pointer is near, or one at a time on idle callbacks.
   Sure: medium on how much it costs a person (it happens after first paint), high that it's loaded.
4. **All of the UI text loads with the first chunk.** `src/i18n/locales/en.ts` (405 KB of source) sits in the eager
   `appMenu` chunk (463 KB built), 63% of that chunk's source, through `src/i18n/resources.ts:1`. Every launch parses
   every string of every page. Benchmark: `launch.homeJsBytes`. Fix: split the strings by page area and load them with
   their page. Sure: high that it's loaded; the parse cost is to be timed.
5. **Machine health sends every machine's hour of history.** Opening Machines reads `get_machine_health` once for
   195 KB (default) or 712 KB (14 machines); a machine's own page reads it twice (202 KB / 724 KB) though it shows one
   machine (`src/pages/MachineHealthPanel.tsx:708`, through `src/services/machineHealth.ts:16`). Five-second points
   for an hour are 720 a machine. Benchmark: `page.machines.commandBytes`, `page.machine.commandBytes`. Fix: ask for
   one machine on its page, and downsample points to what a sparkline's width can show. Sure: high; the mock's history
   is shaped like Rust's.
6. **The heavy-session check asks for 200 sessions.** `SessionMonitor` (`src/components/SessionMonitor.tsx:84`,
   interval `:119`, every 5 minutes) reads `get_usage_sessions` with `page_size: 200`: 260 KB at real size in the
   launch, and again every five minutes. The mock ignores the query's `start`, so it answers with every session; Rust
   limits it to the last hour (`HEAVY_SESSION_WINDOW_MS`), so the real payload depends on that hour. Benchmark:
   `launch.commandBytes` (real). Fix: a command that returns only sessions over the threshold. Sure: medium until the
   mock filters by window like Rust.
7. **Eighteen intervals stay alive on an idle Home, firing 28.7 times a minute.** The busiest:
   `MachineMonitor`'s wake tick every 10 s (`src/components/MachineMonitor.tsx:23`, `:126`), `coreRuntime`'s status
   read every 10 s (`src/coreRuntime.tsx:71`, `get_core_status` 6 a minute), the fleet board's 15 s pair (above),
   `LiveSessionsMonitor` every 30 s (`src/components/LiveSessionsMonitor.tsx:16`, `:68`, `get_live_sessions` 19 KB a
   minute) and `quotaTime` every minute (`src/services/quotaTime.ts:69`). The rest run every 2 to 30 minutes
   (`perf/latest.json` lists them under `idle.live`). Benchmark: `idle.timerFiresPerMinute`, `idle.liveTimers`. Fix:
   one shared scheduler that lines the polls up on the same tick, and longer intervals for what can't change that
   fast. Sure: high.
8. **Each idle commit re-renders the shell's icons, tooltips and machine pills.** 9.7 commits a minute on an idle
   Home render `Icon` 271 times a minute by default and 392 at real size (`src/components/ui/icons.tsx:24`), Base UI's
   `FastComponent` 209 / 289, the tooltip trio 74 / 114 (`src/components/ui/tooltip.tsx:8`, `:29`, Base UI's
   `TooltipPortal`), `MachineIcon` 67 / 149 (`src/components/MachineIcon.tsx:58`) and `MachinePill` 52 / 94
   (`src/components/identity/Identity.tsx:74`, `:94`). It grows with the number of machines, so a poll whose answer
   didn't change still re-renders every machine row. Benchmark: `idle.reactCommitsPerMinute`; per-component renders
   are in `perf/latest.json` (`idle.topComponents`). Fix: keep poll results the same object when nothing changed, and
   memoize the sidebar's and Home's rows. Sure: high.
9. **Launch renders a lot before Home settles.** 121 commits in the first five seconds, with about 1,000 `Icon`
   renders and about 490 renders of each of `TooltipTrigger`, `TooltipPopup` and `TooltipPortal`: every tooltip
   renders its portal and popup even while closed (`src/components/ui/tooltip.tsx:29`). Benchmark:
   `launch.reactCommits`. Fix: render a tooltip's popup only once it opens, and let the stores that start up publish
   once rather than one by one. Sure: medium (closed portals may render little).
10. **Machines, Sessions and Usage share one 728 KB chunk.** Opening any of them loads `UsageRecordsPage` with all
    three pages' code (Machines' page sits inside it for its range picker); Sync's views share `SetupPage` (374 KB).
    Sync › Agents also reads `get_client_versions` for 118 KB. Benchmark: `page.machines.appJsBytes`. Fix: split the
    Machines view and its machine page out of `UsageRecordsPage`. Sure: high that it's loaded; a person feels it only
    on the first open before the prefetch.

Also seen: a `<span>` in one of Home's `SettingsSection`s changes its text four times a minute (40 of idle's 58
mutations), and the WebContent process grew from 287 to 336 MB over ten idle minutes on the page clock. That growth
includes the counters' own tallies and wants checking against the running Arbor's `ps -o rss` before it's chased.

## What WebKit couldn't measure

- **Long tasks.** WebKit has no `longtask` entries in `PerformanceObserver.supportedEntryTypes` (it lists event,
  first-input, largest-contentful-paint, mark, measure, navigation, paint and resource), and the page clock fakes
  `performance.now`, `Date` and even event time stamps, so the page can't time its own tasks during the gated journeys.
  Not gated.
- **JS heap size.** WebKit has no `performance.memory`; the WebContent process's RSS from `ps` stands in, reported only.
- **CPU while idle.** Not sampled: the page clock compresses idle into a few seconds of busy work, so the content
  process's CPU then says nothing about an idle window. Compare the running Arbor's `%cpu` instead (allowed by
  PROCESS.md).

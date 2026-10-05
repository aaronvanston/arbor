# Webview idle cost: memory, CPU, wakeups, re-renders

Step 1 of `docs/perf/PROCESS.md` ("report a slow spot"). Read-only audit of `src/` plus the few Rust files that set
the cadence. Nothing was run: no build, no benchmark, no real-app inspection. Every number below is either counted
from the source (timers, call sites, constants) or an **estimate**, and says which. None of it has passed step 3
("prove the benchmark matters") yet.

Symptom: the owner's WKWebView content process (`com.apple.WebKit.WebContent`) holds about 448 MB and uses CPU while
nothing is happening.

## How to read this

- "Hidden-aware" means the loop skips its work on `document.hidden` / `visibilityState` / `hasFocus()`.
- Idle sampler cadence on the Rust side: `ACTIVE_INTERVAL` 5 s while a page asks for fast rounds, `IDLE_INTERVAL` 60 s
  otherwise (`src-tauri/src/usage/machine_health.rs:86-87`). At idle, `machine-health-updated` fires about once a
  minute.
- Every default preference is on (`src/appPreferences.ts:63-89`: `trayLimits`, `trayMachines`, `traySessions`,
  `limitNotifications`, `machineNotifications`, `setupChangeAlerts`, `fleetT3Threads`, ...). So on a default install
  nothing in the always-mounted layer ever pauses.
- Fixes marked **[visible]** change something the user can see and need the owner's sign-off first. Everything else is
  a pure speed change.

## Where the memory is: not known yet

I can't attribute the 448 MB from source. Candidates, in the order I'd expect them to matter:

1. JavaScriptCore heap high-water mark. JSC rarely returns memory to the OS, so allocation churn (items 1, 4 and 7)
   shows up as resident size even when live data is small.
2. Compiled code and module state for the pages prefetched at 2 s (item 5).
3. Graphics memory: composited layers, the sidebar canvas, mask and backdrop layers (items 2 and 8).
4. WebKit's own baseline for a React app in WKWebView, which isn't ours to fix.
5. After the repo browser has been opened once: the shiki wasm and grammars, held for the life of the window
   (`src/components/CodeDiff.tsx:130-134`, `preloadHighlighter` is never disposed).

Before any fix lands, take a `footprint <pid>` breakdown of the running window, as `PROCESS.md` allows. Its categories
(JavaScriptCore heap, WebKit malloc, IOSurface or graphics) say whether items 1/4/7 or 2/8 deserve to go first.

## Ranked findings

### 1. `get_fleet_sources` is read every 15 s, ignores a hidden window, and always notifies every subscriber

- **Where**
  - Timer and throttle: `src/components/FleetMonitor.tsx:10-12`, `:61`. Not hidden-aware, by design (the tray and the
    pools need it).
  - Extra triggers, each throttled to 5 s: `t3-threads-updated`, `agent-attention-updated`, `usage-records-updated`
    (`FleetMonitor.tsx:9`, `:53-60`).
  - Store: `src/services/fleetBoard.ts:761-768` (`setFleetSources` assigns and notifies unconditionally);
    `:784-790` (`loadFleetSources`).
  - Board rebuild: `:806-815` (`useFleetBoard`), `:827-836` (`sharedBoard`).
  - Payload: `src-tauri/src/usage/fleet.rs:43-68`, with `THREAD_LIMIT = 500` per T3 channel
    (`src-tauri/src/usage/machine_health/t3_threads.rs:42`, `:214`).
- **Evidence**
  - The read always returns a new object with a fresh `nowMs` and per-channel `readAtMs`, so no reference check can
    ever hit.
  - Every read runs `rememberQuestions`, which walks every thread (`fleetBoard.ts:243-259`).
  - Every subscriber then rebuilds the board. `buildFleetBoard` walks every row (`:506-528`).
  - `useFleetBoard` has 10 call sites in 8 files, including the always-mounted `LiveSessionsMonitor`, `FleetMonitor`,
    `FleetHealthMonitor` (through `useFleetMachines`) and the sidebar's machine chips.
  - It also runs while agents are working: with `usage-records-updated` firing "every few seconds", reads go to every
    5 s (12 a minute).
- **Estimated cost**
  - Idle: 4 native calls a minute; up to 12 while agents run.
  - Payload (estimate, unmeasured): each `T3Thread` is roughly 0.5-0.7 KB as JSON (`src/native/types.ts:4633-4674`).
    With up to 500 threads per channel, a few machines and two channels each, that is on the order of 0.3-2 MB per
    read, parsed into fresh objects 4-12 times a minute.
  - That is the single largest allocation churn I can find in the webview. It also reads SQLite and joins in Rust on
    each call (`fleet.rs:52-56`).
- **Proposed benchmark counters**
  - `get_fleet_sources` calls and payload bytes per idle minute.
  - `buildFleetBoard` calls per idle minute.
  - React commits per idle minute attributed to board consumers.
  - Mock at the owner's real size: 500 threads x 2 channels x N machines.
- **Proposed fix**
  1. Send a change token from Rust (a hash of the content, leaving out `nowMs` and `readAtMs`). The webview sends it
     back and Rust answers "unchanged" with no payload.
  2. In `setFleetSources`, keep the previous object and its identity when the token matches, and only bump a separate
     "clock" for time-based fields.
  3. Trim threads to the board's 6 h window in Rust (`FLEET_WINDOW_MS`, `fleetBoard.ts:93`); today the 500 are cut
     only after they have crossed IPC.
  4. While the window is hidden, slow the timer to about 60 s and keep only what the tray and pools need.
- **User-visible?** No, if the tray count and the pools' working counts still update within seconds. Slowing the hidden
  cadence would delay tray updates, so that part needs a nod.
- **Confidence**: high that it churns and re-renders on every read; medium on the payload size until measured.

### 2. Sidebar canopy art: 60 rAF callbacks a second to draw 15 frames, whenever the window is focused

- **Where**
  - `src/components/sidebar/SidebarArt.tsx:69-81` (`moving()` needs `visibilityState === 'visible'` and
    `document.hasFocus()`).
  - `src/services/sidebarScenes.ts:20` (`SCENE_FPS = 15`), `:35-48` (the clock skips frames), `:328` (canopy is 152
    rows tall), `:515-543` (`drawScene`).
  - Default is on: `DEFAULT_SIDEBAR_ART = 'canopy'`, `DEFAULT_SIDEBAR_ART_MOTION = 'moving'`
    (`src/services/sidebarArt.ts:17`, `:36`).
- **Evidence**
  - `requestAnimationFrame(loop)` is re-armed every vsync. `clock.tick` returns `null` for 3 of every 4 frames, but the
    callback still wakes the main thread 60 times a second (120 on a ProMotion display).
  - Each real frame does `pixels.fill(0)`, then scene math over `cols x 152` pixels (about 40-50k at a 260-330 px
    sidebar). Dark theme runs `sceneLevel`, `pack` and a palette lookup per lit pixel, then `putImageData`. The 4
    other buffers (`value`, `drift`, `ranks`, `ImageData`) are reused, so this is CPU and compositing, not memory.
  - It stops when Arbor loses focus, so it only costs while the window is in front. That fits "just sitting there" if
    the window is the frontmost app.
- **Estimated cost**: 60 wakeups a second plus 15 full-strip redraws and canvas uploads a second. Likely a few percent
  of one core (estimate), plus the compositor re-compositing the canvas layer and the sidebar behind it 15 times a
  second.
- **Proposed benchmark counters**
  - rAF callbacks per second while focused (60 now).
  - Scene draws per second (15).
  - Milliseconds per `drawScene`.
  - WebContent CPU % with the window focused and idle.
- **Proposed fix**, in order of visibility:
  1. Schedule frames from a 66 ms timer and use rAF only to paint each one: wakeups drop from 60 to about 15 a second
     with the same animation. **Not visible.**
  2. Skip the full-strip clear and redraw by drawing only the rows that change (the canopy is mostly static between
     falling leaves). **Not visible.**
  3. Pause the motion after N seconds without pointer or key input, resuming on the next. **[visible]**
  4. Lower the frame rate to 8-10 fps. **[visible]**
- **Confidence**: high on the 60 Hz wakeups (it is in the code); medium on the CPU share until measured.

### 3. The one-minute quota clock re-renders and recomputes 24 consumers, and rebuilds the fleet board

- **Where**
  - `src/services/quotaTime.ts:61-82` (`useQuotaClock`: one shared 60 s interval, notifies every subscriber).
  - 24 call sites in 19 files, including always-mounted `LimitsMonitor` (`LimitsMonitor.tsx:129`),
    `AccountReservesMonitor` (`:36`), `SidebarLimits` (`SidebarLimits.tsx:61`), `SidebarTree`
    (`SidebarTree.tsx:87`) and `useFleetBoard` (`fleetBoard.ts:812`).
- **Evidence**
  - Each tick changes `now`, which is a dependency of:
    - the two `providerLimits(...)` memos (`LimitsMonitor.tsx:136`, `:139`);
    - the tray-row memo (`:206-228`), which also builds `JSON.stringify` keys (`:240`);
    - every effect that lists `now`, such as `:189-194`, `:251-289` and `:357-381`;
    - `AccountReservesMonitor`'s effect (`:43-72`, `clock` in the deps), which runs `reservePlan` once a minute;
    - `sharedBoard`, which sees `shared.clock !== clock` and calls `buildFleetBoard` again (`fleetBoard.ts:829-833`),
      so every board consumer gets a new board object.
  - Most of these end in "nothing changed", but each still renders, allocates and walks its data.
- **Estimated cost**: about 10-20 component renders and 3-5 board and limit recomputations a minute, forever.
  Small per tick; it is a steady floor rather than a spike.
- **Proposed benchmark counters**
  - React commits per idle minute, split by cause.
  - `providerLimits` and `buildFleetBoard` calls per minute.
  - Subscribers notified per tick.
- **Proposed fix**
  - Give the clock a selector form, `useQuotaClock(select)`, so a component re-renders only when what it derives
    changes (a countdown string, a "reset has passed" boolean), the way `useSyncExternalStoreWithSelector` works.
  - Make the board depend on the minute only for rows whose status can change with time (the quiet and failed
    thresholds), not for the whole object.
  - Drop `clock` from `AccountReservesMonitor`'s effect deps and let its own 2-minute watch drive it.
- **User-visible?** No, so long as the countdown text still moves each minute.
- **Confidence**: high.

### 4. Stores that emit a new object on every read, so nothing downstream can skip

Each of these assigns the fresh result straight into a store or state, with no structural compare. Compare the ones
that do it right: `coreRuntime.tsx:28`, `appUpdate.tsx:127`, `coreUpdate.tsx:187`, `liveSessions.ts:154`.

| Where | What it notifies | Cadence |
| --- | --- | --- |
| `src/services/fleetHealth.ts:41` (`store.set(snapshot.machines)`) | `FleetHealthMonitor`, sidebar machine chips, the tree's machine leaves, Home | every health round, at most every 30 s per `REFRESH_MS` (`:10`) |
| `src/hooks/useMachineIdentities.ts:20-21` (`new Map` each read) | every machine name pill on screen | at most every 60 s (`:8`) |
| `src/services/pools.ts:121-124`, `:227-232` | the tree's pool leaves and Pools pages; `reloadPreviews` is **not throttled** on `machine-health-updated` | every health round |
| `src/components/sidebar/SidebarTree.tsx:100-110` (`setSetup(setupBadge(...))`) | the whole tree | each `setup-inventory-updated` |
| `src/components/HomeDashboard.tsx:137`, `src/components/HomeMachines.tsx:59` (`setOverview`, `setSessions`) | all of Home | every 10 s while records arrive, every 5 min otherwise |
| `src/services/automations.ts:40` (`set({ list })`) | `AutomationMonitor`, Automations pages | every automations event |

- **Evidence**: the health data does change each round (CPU and memory readings), so a plain deep-equal on
  `MachineHealth` wouldn't help. The sidebar chips only show status, score, the working count and the agent versions,
  and they re-render whole.
- **Estimated cost**: roughly 5-15 extra component renders a minute at idle (estimate), more with agents running.
- **Proposed benchmark counters**: React commits per idle minute for the sidebar subtree; store notifications per
  minute with an unchanged projection.
- **Proposed fix**
  - Add selector hooks that project to what the view shows (status, rounded score, working count), and compare
    projections.
  - Add one shared `setIfChanged` helper (structural compare, with volatile fields named).
  - Throttle `reloadPreviews` like the other health listeners.
- **User-visible?** No.
- **Confidence**: high that the emits are unconditional; medium on the saved renders.

### 5. `usePagePrefetch` loads every page 2 s after launch (about 1.2 MB of JS) to save a local file read

- **Where**: `src/App.tsx:124-144` (the module list), `:166-173` (`usePagePrefetch`, called at `:243`).
- **Evidence** (sizes from the existing `dist/assets`, minified, stale-or-not unknown):
  - Prefetched page chunks: UsageRecordsPage 345 KB, SetupPage 343 KB, AccountsPage 161 KB, ConfigPanel 61 KB,
    AutomationsPage 42 KB, PoolsPage 20 KB, and 13 smaller ones for about 1.11 MB in all.
  - `src/pages/AutomationPage.tsx:4` imports `MarkdownPreview` statically, which pulls the react-markdown stack (a
    separate 147 KB chunk) in with the Automations chunk.
  - `AccountsPage.tsx:3-5` pulls dnd-kit; `data-grid.tsx:17` pulls TanStack Table.
  - **Good news:** shiki, `@pierre/diffs` and `@pierre/trees` are not in the prefetch. They are behind `lazy()` in
    `SetupRepoBrowser.tsx:54-56`, `SetupRepoChanges.tsx:17` and `FileChanges.tsx:21-22`. The big shiki grammar chunks
    (`cpp` 767 KB, `wasm` 608 KB, `CodeDiff` 487 KB) load only when a diff or the repo browser opens.
  - The entry chunk is already 972 KB and loads at launch regardless.
- **Estimated cost**: parse, execute and keep the top level of about 1.2 MB of JS plus its vendor chunks. I'd guess
  10-25 MB of resident memory (low confidence; JSC compiles functions lazily). Plus a burst of CPU at the 2 s mark
  that competes with the first Home paint's data loads.
- **Proposed benchmark counters**: JS bytes loaded at launch and at t+5 s; WebContent footprint at t+30 s with and
  without prefetch.
- **Proposed fix**
  - Prefetch on intent: `onPointerEnter` / `onFocus` of a sidebar row, and the command palette opening.
  - Or prefetch only Accounts and Usage, at `requestIdleCallback`.
  - Make `AutomationPage` load `MarkdownPreview` through `lazy()` as `FileChanges.tsx:22` does.
- **User-visible?** Possibly a few ms on the first open of a page. The code comment at `App.tsx:686` says a first load
  is "a local file read", so likely not noticeable, but check at real size. **[possibly visible]**
- **Confidence**: high on what loads; low on the memory it holds.

### 6. Always-on watchers never pause on a hidden window, and several do duplicate work

Timers and polls in the always-mounted layer (`src/App.tsx:491-507`), at default preferences. "Hidden" is
`document.hidden` or `visibilityState`; "Compare" is whether the result is compared before notifying.

| Component and location | Period | Native call | Hidden-aware | Compare |
| --- | --- | --- | --- | --- |
| `coreRuntime.tsx:71-75` | 10 s | `get_core_status` | yes | yes (`:28`) |
| `FleetMonitor.tsx:61` (+ events, 5 s throttle) | 15 s | `get_fleet_sources` | **no** | **no** (item 1) |
| `LiveSessionsMonitor.tsx:68`, `:45` | 30 s (+ events, 10 s throttle) | `get_live_sessions` | only when the tray's sessions are off | yes (`liveSessions.ts:154`) |
| `MachineMonitor.tsx:125-126` | 2 min check + **10 s wake tick** | `get_machine_health` | no | n/a (alerts) |
| `fleetHealth.ts:37-45` | per health event, 30 s throttle | `get_machine_health` | no | no (item 4) |
| `useMachineIdentities.ts:34-36` | per health event, 60 s throttle | `get_machine_health` | no | no |
| `pools.ts:231` | per health event, none | `preview_pools` | no | no |
| `ProxyChecksMonitor.tsx:56` | 60 s (+ `config-files-changed`) | `check_proxy_settings` | no | no: `latest.set(checks)` gets a new object each read (`proxyChecks.ts:26`) |
| `AccountReservesMonitor.tsx:76-91` | 2 min | quota reads, only if caps are set | no | n/a |
| `SessionMonitor.tsx:119` (+ events, 60 s throttle) | 5 min | `get_usage_sessions`, `page_size: 200` (`:83-85`) | no | no (`setHeavySessions(items)`, `:88`) |
| `LimitsMonitor.tsx:161` | 15 min default | one quota read per account, through the core | pauses unless `pollWhileHidden` (true by default, `:144-145`) | store compares by identity (`quotaCache.ts:29`) |
| `LimitsMonitor.tsx:179` | 5 min | public status pages | no | no |
| `ArchiveMonitor.tsx:61` | 5 min | archive status | no | n/a |
| `SetupChangeMonitor.tsx:36` | 30 min | `scanSetup`, which SSHes each machine | no | native side |
| `appUpdate.tsx:137`, `coreUpdate.tsx:194` | 30 min each | update feeds | yes | yes |
| `WeeklyDigestMonitor.tsx:59` | 15 min | none (clock check; off by default) | no | n/a |
| `UpdateWhenIdleMonitor.tsx:85` | 15 s, only while an update waits | `get_live_sessions` | no | yes |

- **Evidence**
  - A closed-to-tray window is hidden but still runs all of the above (WKWebView throttles hidden timers to about
    1 Hz but doesn't stop them).
  - `get_machine_health` is read three times per round by three listeners (`MachineMonitor`, `fleetHealth`,
    `useMachineIdentities`) plus a fourth call, `preview_pools`, on the same event.
  - `get_live_sessions` is also called by `UpdateWhenIdleMonitor` (`:60-66`).
  - `SessionMonitor` pulls up to 200 sessions with their transcript fields (estimate: hundreds of KB) every 5 min, and
    again on usage events at most once a minute, only to total the last hour's tokens in JS and keep the few over the
    threshold.
- **Estimated cost**: about 15-25 native calls and about 25 timer fires a minute at idle, window shown or hidden.
  With agents running, the event-driven reads add up to about 20 more a minute.
- **Proposed benchmark counters**
  - Native calls per idle minute and their payload bytes, window visible vs hidden.
  - Timers firing per idle minute.
  - `get_machine_health` calls per health event (now 3).
- **Proposed fix**
  1. One shared health feed: the first listener reads once, and `fleetHealth`, `useMachineIdentities` and
     `MachineMonitor` consume it. `reloadPreviews` joins it.
  2. A single scheduler where each job declares what needs it (`visible`, `tray`, `alerts`) and a hidden cadence;
     jobs nothing needs while hidden pause.
  3. Move the "which sessions exceed N tokens/hour" check for `SessionMonitor` into Rust, and return only the
     offenders.
  4. Replace `MachineMonitor`'s 10 s wake tick (`WAKE_TICK_MS`, `MachineMonitor.tsx:23`, started at `:126`) with
     `visibilitychange`, plus the `online` listener it already has (`:128`), or one Rust-side wake event.
- **User-visible?** No for 1, 3 and 4. For 2, a slower hidden cadence delays tray and alert freshness by seconds.
  **[possibly visible]**
- **Confidence**: high on the counts; medium on how much the 448 MB moves.

### 7. Page-level timers re-render large trees even when nothing on screen changes

Only run while their page is open, so they matter when the owner leaves one of these on screen.

- `useNow` re-renders its host every 30 s (`src/hooks/useNow.ts:7`) in `SetupPage.tsx:279` (the 343 KB page),
  `SetupChecklist.tsx:189`, `SetupProjects.tsx:118` and `SetupToolchain.tsx:140`. Each tick re-renders the whole
  page, to keep "scanned 3 minutes ago" true.
- `useNothingRecorded` creates its own 30 s `get_usage_collector_status` poll per caller
  (`src/hooks/useCollectorStatus.ts:46-50`): four callers in `UsageSessionsView.tsx:55`,
  `SessionProjectsView.tsx:217`, `UsageEmpty.tsx:8` and `UsageFleet.tsx:21`. `UsageCollectorBanner` adds another at
  15 s (`UsageRecordsPage.tsx:959`), so Sessions can run three collector polls at once. These compare nothing before
  `setStatus`.
- `HomeDashboard.tsx:172` (5 min) and `HomeMachines.tsx:83` (5 min) don't check `document.hidden` on the timer, only
  on the event path.
- Page timers with no hidden check: `CommandLineSettings.tsx:49` (3 s), `SetupChecklist.tsx:216` (15 s) and
  `SetupChecklist.tsx:317` (4 s while joining).
- Hidden-aware, for contrast: `UsageCollectorSection.tsx:9` (5 s, through `useCollectorStatus`),
  `UsageRecordsPage.tsx:545-558`, `SessionDetailPage.tsx:173`,
  `DiagnosticsSettings.tsx:65`, `SessionArchiveSettings.tsx:86`, `SetupAgents.tsx:91-92`, `SetupCost.tsx:69`,
  `UsageLifetimeView.tsx:68`, `UsageDigestView.tsx:123`, and the 1 s `chartClock` in `MachineHealthPanel.tsx:92-101`
  (which only subscribes while a chart is on screen).
- **Estimated cost**: low per tick, but each tick on `SetupPage` is a render of a large tree.
- **Proposed benchmark counters**: React commits per idle minute on Setup, Sessions and Machines (the pages most
  likely to be left open); native calls per minute on Sessions.
- **Proposed fix**: replace `useNow` with a small `<RelativeTime at={...} />` that owns its own timer and re-renders
  only itself; make `useCollectorStatus` a refcounted shared store; add the hidden check to the timers above.
- **User-visible?** No.
- **Confidence**: high on the counts; low-medium on the share of total idle cost.

### 8. Compositing: where `backdrop-filter`, masks and scroll-timeline layers sit

The census (count of sites, not all live at once):

- `backdrop-filter` is defined in three Tailwind utilities (`src/styles.css:280-316`: `dialog-glass`,
  `dialog-backdrop`, `dropdown-glass`) and used by:
  - dialogs and their backdrop (`src/components/ui/dialog.tsx:12-14`);
  - menus, popovers, selects and toasts (`menu.tsx:62`, `popover.tsx:30`, `select.tsx:78`, `toast.tsx:150`);
  - `QuitGuard`, which is **always mounted** as a full-window fixed layer with a `dialog-glass` child hidden by
    `invisible` + `opacity-0` (`src/components/QuitGuard.tsx:46-51`);
  - sticky bars with `backdrop-blur`: the table footer on every table page (`src/components/ui/data-table.tsx:96`)
    and the selection bars in `SetupPage.tsx:786`, `SetupProjects.tsx:287`, `SetupSkills.tsx:1080`;
  - the narrow-window sidebar scrim (`App.tsx:665`, only in overlay mode).
- Menus, dialogs and popovers are Base UI portals that unmount when closed, so at idle only the toast stack (up to 3,
  `toast.tsx:77`) and possibly `QuitGuard` hold live blur layers. The sticky table footer costs while scrolling a long
  table, not at idle.
- Every `[data-slot='page-scroll']` page has a two-gradient `mask-image` plus a scroll-driven animation
  (`styles.css:530-548`). That is a full-size mask layer on the scroller for as long as a page is open.
- No `:has()` selectors in `styles.css`. `has-[...]` appears in only 3 `.tsx` files. No problem found.
- Infinite animations (`styles.css:84-88`) are paused while the window is hidden (`:553-555`, set by
  `lib/windowVisibility.ts:10-16`), so none run offscreen. `animate-pulse` is used in 4 places; loading chips only.
- There is no list virtualization anywhere (no `react-virtual`, `react-window` or `virtuoso` in `package.json`). Lists
  are server-paged instead: the default page is 50 rows (`UsageRecordsPage.tsx:274`) and the picker goes to 200
  (`data-table.tsx:104`). The live board has no cap on rows beyond the 6 h window (`fleetBoard.ts:93`), so Sessions ›
  Live and the fleet views render every row.
- **Estimated cost**: low at idle (0-4 blur layers, one mask layer); real while scrolling a long table with the sticky
  footer, and for GPU memory (each layer is a backing store).
- **Proposed benchmark counters**: composited layer count and layer memory from Web Inspector's Layers panel at idle
  on Home and on a table page (this needs a WebKit session, so it fits the Playwright WebKit journey); frames
  dropped while scrolling.
- **Proposed fix**
  - Mount the `QuitGuard` glass only while `open` (an `open && ...` or Base UI `Dialog`).
  - Replace the sticky footer's `backdrop-blur` with a solid `bg-background` plus a hairline. **[visible]**
  - Apply the page-scroll mask only after the first scroll (toggle a data attribute) so a page at the top has no mask
    layer. **[visible, subtle]**
- **Confidence**: medium on the cost at idle; high on the inventory.

## Checked, no idle cost found

- `AppContent` shell: every store it subscribes to compares before notifying (`coreRuntime.tsx:28`,
  `appUpdate.tsx:127`, `coreUpdate.tsx:187`), and `ViewContent` is memoized (`App.tsx:183`). The shell should commit
  about zero times a minute at idle; the benchmark should confirm it.
- `useAppPreferences` returns the whole object to 26 call sites, so one preference change re-renders all of them. It
  is rare, so not an idle cost. A selector form would still be cheap to add.
- Growth: the alert history is capped at 500 entries and 30 days (`alertHistory.ts:67`, `:191`); view history at 100
  (`viewHistory.ts:HISTORY_LIMIT`); toasts at 3; the quota cache is pruned to current accounts
  (`quotaCache.ts:71-86`); fleet sources and the shared board are replaced, not appended
  (`fleetBoard.ts:761-768`, `:827-836`). I found no unbounded module-level collection.
- Listeners never removed: module-level `listen()` calls in `pools.ts:229-231`, `agentHomes.ts:149`, `runs.ts:172`
  and `agentTelemetry.ts:55` run once for the life of the window by design. They only reload on rare events, so
  this is not a leak. The monitors' `listen()` calls all unlisten on cleanup.
- Dead-simple wakeups: `quotaTime.ts` stops its interval when nothing subscribes; `agentReleases.ts` polls only while
  something shows it; `useAnimatedNumber` uses rAF only while a number is moving.

## Suggested order for the benchmarks

1. A launch-and-idle journey in the demo build (Playwright WebKit): a 10-minute idle on Home with fake timers at the
   owner's data size. It records the counters from items 1, 3, 4 and 6: native calls and bytes per minute, commits per
   minute, timers per minute.
2. A focused-window variant to count rAF callbacks and draws a second (item 2).
3. Page-open variants for Setup, Sessions and Machines (item 7).
4. Compare `footprint <pid>` of the running window against the benchmark's own number (step 3 of `PROCESS.md`), then
   pick the fix order from the JS-heap vs graphics split.

## Open questions for the owner

- Is the 448 MB window usually frontmost, or hidden/closed to the tray? Item 2 only costs when it is focused; item 6
  matters most when it is hidden.
- Is a slower hidden cadence for tray and alert freshness (item 6, fix 2) acceptable, or should the tray stay at its
  current speed?

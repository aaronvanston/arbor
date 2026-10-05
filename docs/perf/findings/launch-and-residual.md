# Launch cost and residual memory

Step 1 of `docs/perf/PROCESS.md` ("report a slow spot") for two things: what the window loads and runs between launch
and a usable Home, and what it still holds once it's closed to the tray. This was a read-only audit; nothing in the
repo changed except this file.

**How the numbers were got**

- **Bundle numbers** are exact. They come from `vite build` into `/tmp` with a `generateBundle` hook that dumps
  every chunk's modules with their `renderedLength`, plus the module graph. The output hashes match `dist/`.
  - "Rendered" means bytes before minification. The minified entry is 0.66× its rendered size.
  - `en.ts` minifies to 393 KB, measured by `bun build --minify`.
- **Memory numbers** come from `vite build --mode demo` (the mock) served from `/tmp` and loaded in Playwright WebKit
  (revision 2359) at 1440×900, devicePixelRatio 2.
  - Each figure is the content process's `footprint`. Runs vary by ±10 MB, so treat them as directional.
  - The mock's data is far smaller than the owner's, so absolute MB are low: about 115 MB here against 448 MB in the
    real window. The *differences* are what matter.
- No real app was launched or inspected.

## Ranked opportunities

| # | Opportunity | Win | Effort | Confidence | Visible? |
|---|---|---|---|---|---|
| 1 | Unmount the open page (and drop page caches) while the window is hidden; keep the monitor layer | ~30–40 MB in the mock after visiting 6 pages (more at real data size); stops hidden re-renders of big grids | S–M | High that the DOM/React state goes; medium on how much WebKit returns without memory pressure | No (a page reopens at its saved view) |
| 2 | Move `en.ts` out of the entry: per-area string chunks, or at least `JSON.parse` of a string | 393 KB of the 990 KB entry (40%). Shell + Home + monitors need roughly 120 KB of it | M (split) / S (JSON.parse) | High | No |
| 3 | Lazy the three dialogs the entry carries for one click: AddMachineDialog, ConnectAgentDialog, CommandPalette | ~275 KB rendered, ~180 KB minified, out of the launch JS (incl. Base UI Select, NumberField, ToggleGroup and the whole `setup*` checklist tree) | S | High | No (a few ms on first open; preload on hover) |
| 4 | Replace "import every page at 2 s" with prefetch on intent (hover/focus of a sidebar row, ⌘-digit held, palette highlight) | 1.36 MB of JS in 40 chunks not parsed or compiled unless used; ~6 MB footprint at 7.5 s in the mock | S | High | No |
| 5 | Static first paint in `index.html` (sidebar + Home skeleton) so `frontend_ready` can fire before 1.65 MB of JS has parsed | Window visible and laid out ~one JS-parse earlier; removes the 1.5 s fallback race on slow launches | M (plus a drift test) | Medium | **Yes**: needs the owner's sign-off |
| 6 | Dedupe `loadAccountFiles` (`accountsStore.ts:99`): five callers fire at the moment the core becomes ready, so up to 5× `GET /auth-files` | 4 management round trips saved at every launch and every core restart; Home's accounts fill sooner | S | High | No |
| 6b | Defer non-Home monitors' first fetch until after Home settles (idle) | ~30 native calls in one effects pass come down to Home's ~10; Home's own reads go first | S | Medium | No |
| 7 | Destroy the webview on close and recreate it on demand | The whole content process (448 MB today) while closed | **XL**: see the dependency list | High that it works once everything is moved; it's a big port | Slower reopen (~0.3–1 s) |
| 8 | Ask WebKit to release memory after hiding (memory-pressure / `_purgeCaches`-style call via `with_webview`) | Unknown; in the mock, `about:blank` kept 134–145 MB after a page tour, so WebKit does not hand memory back on its own | M (new objc2-web-kit dependency, private API risk) | Low | No |
| 9 | Shiki highlighter: already lazy, keep it that way, and free it on leaving Sync › Repo | ~8 MB when first used (wasm engine, two themes, three grammars); never paid at launch today | S | High | No |
| 10 | WebKit specifics (images, canvas, blur, fonts) | Under 1 MB together; nothing to win | — | High | — |

Details follow, in the order of the brief's questions.

---

## 1. What's in the 990 KB entry chunk

The entry (`assets/index-CPM46kgn.js`, 990,148 bytes) loads with five vendor chunks. Together that's **1,654,353 bytes
of JS before `createRoot`**:

| Chunk | Bytes |
|---|---|
| react-vendor | 194,252 |
| icons-vendor | 174,847 |
| ui-vendor (Base UI) | 223,794 |
| vendor | 52,269 |
| tauri-vendor | 19,043 |

The entry holds 235 modules, 1,491 KB rendered.

### Biggest contents (rendered bytes)

| KB | Module | Why it's eager |
|---|---|---|
| 405 | `src/i18n/locales/en.ts` | `i18n/index.tsx:3` → `resources.ts` → `en`. All 5,939 lines of UI text. By prefix: setup 116 KB, usage 37, automations 19, machines 15, sessionArchive 12, fix 12, config 12, sessions 11, quota 10 … |
| 52 | `services/quotaService.ts` | SidebarLimits, LimitsMonitor and 17 other eager importers. Needed at launch. |
| 33 | `App.tsx` | shell |
| 24 | `services/fleetBoard.ts` | LiveSessionsMonitor, FleetMonitor, Home. Needed. |
| 22 + 10 | `CommandPalette.tsx` + `CommandPaletteActions.tsx` | `App.tsx:30`. Only once ⌘K is pressed. |
| 21 + 18 + 14 + 12 + 8 + 8 | `setupToolchain`, `setupChecklist`, `setupPlugins`, `setupSkills`, `setupProjects`, `setupMcp` | **`App.tsx:27` → `AddMachineDialog.tsx` → `services/setupChecklist.ts`** pulls in the whole Sync checklist tree for a dialog nobody opens at launch |
| 21 | `services/settingsIndex.ts` | `App.tsx:49`, for the palette and Settings search. Partly needed (sidebar labels). |
| 18 | `HomeProxy.tsx` | Home |
| 17 | `services/sidebarScenes.ts` | sidebar art |
| 13 | `AddMachineDialog.tsx` | `App.tsx:27,695` |
| 13 | `services/fixPrompt.ts` | `HomeDashboard → AgentAttention → FleetBoard → fixPrompt` |
| 11 + 6 | `weeklyDigest.ts` + `capacityReport.ts` | `WeeklyDigestMonitor` (App.tsx:17), which only acts weekly |
| 9 | `ConnectAgentDialog.tsx` | `HomeDashboard.tsx:18`, `HomeProxy.tsx:23` |
| 9 | `services/cliHandlers.ts` | `CliBridgeMonitor`. Its `setupSync` import (9 KB) only matters when a CLI call arrives. |

### What each lazy cut takes out of launch

Each cut was simulated by removing the edge from the graph and recomputing what stays reachable. Sizes are rendered
bytes; multiply by ~0.66 for minified.

| Cut (make it `lazy()` / `import()`) | Rendered KB out of launch | Of which node_modules | Notes |
|---|---|---|---|
| `en.ts` split by area (lazy strings with each page chunk) | 405 (393 minified) | 0 | Shell/Home/monitors/tray/palette keys (`app`, `home`, `quota`, `fleet`, `machines`, `reserves`, `tray`, `palette`, `phoneAlerts`, `notifications`, `interface`, `settingsSearch` …) are roughly 120 KB. The rest (setup 116, usage 37, automations 19, sessionArchive 12, config 12 …) can load with its page. |
| `App.tsx:27` AddMachineDialog → lazy, mounted only while `addingMachine` | **145** | 46 (Base UI NumberField) | Includes `setupChecklist`, `setupToolchain`, `setupPlugins`, `setupSkills`, `setupProjects`, `setupMcp`, `machineDiscovery`, `CommandLine`. |
| `HomeDashboard.tsx:18` + `HomeProxy.tsx:23` ConnectAgentDialog → lazy | **106** | 88 (Base UI Select + ToggleGroup + Toggle + Composite) | Select leaves ui-vendor. Pages that use it get it through their own chunk, already split. |
| `App.tsx:30` CommandPalette → lazy, mounted on first ⌘K / search-row focus | 23 | 0 | `palettePages`/`paletteSettings` memos (App.tsx:432-453) can also wait for the first open. |
| `AgentAttention → FleetBoard` | 36 | 0 | **Not a cut**: Home's Needs-you list renders `FleetRow` (`AgentAttention.tsx:5`). Only `fixPrompt.ts` (13 KB, the Fix menu) could split off. |
| `WeeklyDigestMonitor` body → `import()` inside its weekly check | 22 | 0 | It acts once a week. |
| `cliHandlers` → `import()` on the first `cli-request` | 9 | 0 | |

**Total for the four cheap dialog/monitor cuts: about 300 KB rendered, roughly 200 KB minified.** That's on top of 393 KB for
the strings.

### Proposed counters

- `launch.js.bytes`: the sum of JS bytes fetched before `frontend_ready`. Today it's 1,654,353 in prod.
  - The demo build's entry differs because it adds the mock, which loads dynamically. Gate on the prod-shaped number:
    run the journey against `vite build` output with the mock injected, or record the demo number and ratchet that.
- `launch.js.modules`: entry module count, 235 today.

Both are exact and repeatable. They prove they matter through parse/compile time in the "cold launch to Home" journey.

### Fix order

1. AddMachineDialog, ConnectAgentDialog, CommandPalette to lazy (S).
2. `en.ts` (M). Simplest safe first step: emit the table as `JSON.parse('…')`. JSC parses JSON several times faster
   than an object literal, and the gain doesn't depend on the split. Then split by top-level prefix into
   `locales/en/<area>.ts`:
   - Keep the `MessageKey` type from a generated `.d.ts`, or a `typeof` over all parts, so `t()` stays typed.
   - Load an area's strings with the page that uses it.
   - `t()` on a missing area should suspend or fall back. The page loaders in `App.tsx:124-144` already give a natural
     hook: `pageModules.setup = () => Promise.all([import('./pages/SetupPage'), loadStrings('setup')])`.
   - `tests/uiLocalization.test.ts` and `tests/i18n.test.ts` need to read all parts.

---

## 2. Cold launch, `main.tsx` to Home settled

**Measured in WebKit** (demo build, M-series Mac, three runs):

| Milestone | Time |
|---|---|
| `domInteractive` | 10–19 ms |
| All 10 launch scripts received | 58–78 ms |
| Shell in the DOM | 199–234 ms |
| First contentful paint | 205–242 ms |

So ~140 ms goes on parsing and evaluating 1.65 MB of JS, the mock's pre-render answers and React's first render. In the
real app add three IPC round trips and the real `saved_store_snapshot` size.

### Sequence

1. **`index.html`** runs an inline script that sets the theme, the background colour and the app colour from
   localStorage.
   - There is **no static markup**: `<div id="root">` is empty.
   - The window is created hidden (`tauri.conf.json:21`, `visible: false`), so nothing shows until React has painted.
2. **`main.tsx`, synchronously:** `renameLegacySavedKeys` (:19), `reportUncaughtErrors`, `initializeTheme`,
   `trackWindowVisibility` (:27-29). `preparePhoneAlerts()` (:31) fires `get_phone_alert_secrets` without waiting.
3. **Blocking `Promise.all`** (`main.tsx:43`):
   - `system_locale`, capped at 250 ms (`systemRegion.ts:5,13,20`).
   - `get_zoom_level` + `listen('zoom-changed')`, capped at 250 ms (`zoom.ts:20,89,97`).
   - **`saved_store_snapshot` with no cap** (`savedStore.ts:146`), then `saved_store_migrate` on a first run, then
     `listen('saved-store-changed')`.
   - All three are parallel. The slowest decides, and the snapshot is unbounded and carries every saved value,
     including alert history of up to 500 entries.
4. **`createRoot().render(...)`.** In one effects pass, about **26 distinct native calls** go out at once, plus about
   25 `listen` registrations (full table in the inventory below):
   - `get_core_status`
   - `check_app_update`, `get_app_update_task`, `check_latest_core`
   - `get_product_analytics`, `track_event`
   - `set_tray_rows` ×3, `set_tray_status`, `set_tray_unread`, `set_quit_guard`
   - `get_usage_sessions`, `get_live_sessions`, `get_machine_health` ×2, `get_agent_latest_versions`
   - `list_automations`, `set_t3_threads_enabled`, `get_fleet_sources`, `cli_bridge_ready`
   - `get_setup_inventory`, `get_pools` → `preview_pools`
   - `get_machine_sessions`, `get_gui_settings`, `get_core_tls_settings`, `get_core_config_settings`
5. **`ShowWindowWhenPainted`** waits two rAFs, at most 100 ms (`windowChrome.ts:84,91`), then sends `frontend_ready`.
   Rust shows the window on the page's colour (`main_window.rs:143-157`). Rust's fallback shows it anyway after
   **1,500 ms** (`main_window.rs:10`).
6. **coreReady** comes from three sources: `get_core_status`, the `core-status-changed` event (`main.rs:1676,1727`),
   and a 10 s poll (`coreRuntime.tsx:71`). Rust's `ready` means the process is running and the management port
   accepts a connect (`core_runtime.rs:902,937-944`). A cold core start waits up to 10 s for its port
   (`core_runtime.rs:1169`).
7. **Once coreReady flips:**
   - `ensureAccountsLoaded()` is called from **five places in the same tick**: LimitsMonitor :149, SidebarTree :98,
     SidebarLimits :66, HomeDashboard :48, HomeAccounts :55.
   - `loadAccountFiles` (`accountsStore.ts:99`) has **no in-flight dedupe**: `ensureAccountsLoaded` (`:234`) only
     checks `state.loaded`. That means up to **5 concurrent `GET /auth-files`** through `management_request`, then one
     `/api-call` per account (4 at a time).
   - Then `get_usage_overview`, `check_proxy_settings` and `record_limit_samples`.

### What blocks what

- **First paint is blocked by:** parsing 1.65 MB of JS, then the unbounded `saved_store_snapshot` (plus up to 250 ms
  for region/zoom), then React's first render of the shell, Home and 17 monitors.
- **Home being usable is blocked by:**
  - The sidebar and Home's frame, Needs-you, HomeProxy and machine figures show at first paint. Home is never locked
    (`navigation.ts:305-307`).
  - Accounts, Today and the sidebar limits wait for coreReady (`HomeDashboard.tsx:56`), then skeletons
    (`HomeAccounts.tsx:89`) until `/auth-files` and the quota calls answer.
  - Machine cards show skeletons until `get_machine_health` answers (`HomeMachines.tsx:119`).

### Cheap launch fixes

- **Dedupe `loadAccountFiles`.** Share one in-flight promise when the call isn't `quiet`. That turns 5× `/auth-files`
  into 1× at the moment the core becomes ready. S effort, high confidence.
  - Counter: `launch.management_requests` until Home settles, exact and gated.
- **Stagger the monitors.** Give each monitor that doesn't feed Home or the tray a first run after Home settles, e.g.
  `requestIdleCallback`, or after `frontend_ready` + 1 s. That covers SessionMonitor, `get_agent_latest_versions`,
  `list_automations`, `get_setup_inventory` and `get_pools`/`preview_pools`.
  - The 26-call burst competes with Home's own reads on the Tauri IPC and on the Rust side's SQLite reads.
  - Counter: `launch.native_calls_before_settled`, today ~30. Gate it.
- **Bound `saved_store_snapshot`, or slim it.** Send the alert history and other large values separately after first
  paint. Counter: snapshot payload bytes.

### Static first screen (opportunity 5, **visible**: needs the owner's sign-off)

Today the window is hidden until React paints. On a fast Mac that's ~200–250 ms after navigation in WebKit; the 1.5 s
fallback covers a slow one. A static first screen would let `frontend_ready` fire from `index.html` itself, as soon as
the HTML and CSS paint, before any JS has parsed. React then hydrates over it, or replaces it in the same frame. That's
the same idea as claude.ai's static composer.

**What goes in `index.html`:**

- A `<div id="boot-shell">`, sibling to `#root`, that draws the frame the shell will draw:
  - the sidebar at its saved width (read `arbor.sidebar.*` in the existing inline script and set `--sidebar-width`)
  - the wordmark row
  - the search row
  - the tree's section labels and rows as neutral bars (they can't know machine names)
  - the footer icons
  - a Home column with the card outlines as skeletons
- The sidebar art's first still frame as a background colour block in the art's average colour. The canvas comes later.
- Style it with a small inline `<style>` using the same tokens (`--background`, `--sidebar`, `--sidebar-border`, radii)
  so it follows theme and app colour, which the inline script already sets.
- The Tailwind CSS file (160 KB) is a render-blocking `<link>` that Vite injects. The boot shell's inline styles must
  not depend on it.

**Behavior:**

- The inline script sends `frontend_ready` once the boot shell has painted, after a rAF. It does that through
  `window.__TAURI_INTERNALS__.invoke`, which exists before modules load. `main.tsx` then skips its own call, because
  `LaunchShowState.take()` already makes it a no-op.
- `createRoot` removes `#boot-shell` in the first commit, `useLayoutEffect` in `App`, so there's no flash. Both draw
  the same frame.
- **Risk: wrong rows.** A static tree can't show the person's machines or pools. Keep it to section headers and the
  fixed rows (Home, Fleet, Spend) plus faded placeholder bars. That's what claude.ai does with its composer only.

**Keeping it from drifting:**

1. A `bun:test` that renders the real shell with `renderToStaticMarkup` (an empty-stores mock) and compares a short
   list of structural facts with the boot markup: sidebar width variable, the header row height
   (`--workspace-topbar-height`), section labels taken from `en.ts` keys (fill them in at build time with a tiny Vite
   `transformIndexHtml` plugin, never hand-typed), and the footer icon count.
2. A perf journey screenshot diff: the boot frame vs React's first frame, in WebKit. Fail over N% of pixels changed in
   the sidebar and top bar. This catches layout drift (padding, widths) that the structural test can't.
3. Generate it rather than hand-write it. At build, render `<BootShell/>`, a component the real shell also uses for
   its skeleton states, to static HTML in `transformIndexHtml`. One source then draws both. This is the
   lowest-drift option and costs one small component.

**Win:** the window appears roughly one JS parse-and-render earlier, about 150–250 ms on the owner's Mac and more on a
cold disk or right after an update. It also removes the fallback race where a slow launch shows an empty window at
1.5 s. Medium confidence that it's felt: on a fast Mac the launch is already short. The bigger launch wins are the
byte cuts in section 1.

**Counter:** `launch.ms_to_frontend_ready` (reported; it's wall-clock), plus a gated "boot shell present in
`index.html`" check.

---

## 3. Prefetch strategy

Today: `usePagePrefetch` (`src/App.tsx:166-173`) imports all 19 `pageModules` (App.tsx:124-144) 2 s after the shell
mounts. Measured from the chunk graph:

- **Prefetch adds 1,395,859 bytes in 40 chunks.**
  - UsageRecordsPage closure 729 KB. It statically pulls `SetupPage` (351 KB) through `AccountsPage.tsx:94`'s lazy and
    its own imports.
  - SetupPage 375 KB.
  - AutomationsPage 241 KB, including `MarkdownPreview` + react-markdown, 151 KB, via `pages/AutomationPage.tsx:4`
    static import.
  - AccountsPage 175 KB.
  - ConfigPanel 75 KB, the rest under 50 KB each.
- **It does *not* load shiki, the wasm engine, grammars, CodeDiff, CodeFile, RepoFileTree or CodeChanges.** They sit
  behind `lazy()` in `components/FileChanges.tsx:21-22`, `pages/SetupRepoChanges.tsx:17` and
  `pages/SetupRepoBrowser.tsx:54-56`.
  - Of the 9.48 MB of JS in `dist/assets` (369 chunks), 6.43 MB in 323 chunks is never prefetched. It loads only when a
    diff or file view is drawn.
  - The brief's assumption that prefetch pulls in shiki is not borne out by the graph. The measured run below agrees:
    after prefetch, 50 JS resources and 3,212 KB decoded, with no `cpp`, `wasm` or `CodeDiff`.
- **Is shiki created eagerly anywhere?** No.
  - The only highlighter creation is `preloadHighlighter` in `components/CodeDiff.tsx:134`, run when a diff renders.
  - `services/highlightLanguages.ts:2` imports `bundledLanguagesInfo` from `shiki`, but only CodeDiff, CodeChanges and
    CodeFile import that service, all lazy.
  - Measured cost when it does run: a probe page loading `@pierre/diffs` and calling `preloadHighlighter` with both
    pierre themes and three grammars went from **21 → 29 MB footprint, 23–37 ms**, three runs alike.
  - The highlighter is a module singleton, so those ~8 MB stay for the life of the window once Sync › Repo or any diff
    has been opened. That's opportunity 9: drop it when the window hides.

### Memory, measured (footprint, MB)

| Run | Home @1.5 s (before prefetch) | Home @7.5 s | After visiting Machines, Sessions, Automations, Sync, Accounts, Usage → Home | Then `about:blank` |
|---|---|---|---|---|
| default | 110 / 112 | 116 / 117 | — | 105 / 109 |
| prefetch blocked | 128* / 110 | 110 / 111 | — | 94 / 67 |
| tour | 132 / 130 | 118 / 116 | **154 / 143** | **145 / 134** |

\* first-run noise.

So prefetch costs about **6 MB** of footprint in the mock: parsed and compiled code for 1.4 MB of JS plus module
state. Real pages hold far more data, so a page's *visit* costs far more than its prefetch: about **+30 MB after a
six-page tour, kept after returning Home**. WebKit doesn't give it back even on `about:blank` within 3 s.

### Proposal

- Delete the 2 s timer. Prefetch a page's module on intent:
  - `pointerenter` / `focus` of its `SidebarRow` / tree leaf (`components/sidebar/SidebarTree.tsx`, `SidebarChrome.tsx`).
  - ⌘ held (`useModifierHold`, App.tsx:482). When the digit hints show, prefetch nothing yet, then the digit's page on
    keydown. Navigation is already on keydown, so this is mostly "load as you go".
  - The palette's highlighted row (`CommandPalette`).
  - Settings rows on hover.
  - Keep `pageModules` as the one table, adding a `prefetchPage(id)` that dedupes by id.
- A first open of a non-prefetched page costs a local file read plus parse. The Suspense fallback is `null`
  (App.tsx:687), and the comment at :686 already calls this "a few milliseconds". On a hover that's typically 100–300 ms
  ahead of the click, enough to hide it.
- Optional: during `requestIdleCallback` after Home settles, prefetch only the page the person opened last session
  (saved view history).
- **Counter:** `idle.js.bytes@10s`, the JS fetched 10 s after launch with no input. Today it's 3,212 KB decoded in the
  demo. Target: equal to the launch figure. It's exact and gated.

---

## 4. Residual memory with the window closed

### How close works today

- **Close hides the window:**
  - `src-tauri/src/main.rs:1604-1618`: `CloseRequested` → `api.prevent_close()`, Dock icon hidden, `window.hide()`.
  - `tauri.conf.json` sets the window `visible: false` and **`"backgroundThrottling": "disabled"`**, so WebKit never
    throttles timers in the hidden page. That's deliberate: the page *is* the background service.
- **Show:** `src-tauri/src/tray.rs:477-511` `show_main_window` does `get_webview_window("main")`, then show, unminimize
  and focus. If the window doesn't exist it returns (`tray.rs:478`) and creates nothing. Its callers:
  - tray "Open Main Window" (`tray.rs:552`) and double-click (`:582`)
  - tray rows (`:187`)
  - the app menu (`app_menu.rs:41`)
  - the quit guard (`quit_guard.rs:277`)
  - Dock reopen (`main.rs:2001-2004`)
- **The window comes from config only** (label `main`), with no `WebviewWindowBuilder`. Rebuilding it is easy in
  itself: `WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])`, then re-arm `LaunchShowState`
  (`main_window.rs:52-73`). Zoom is re-applied in `on_page_load` (`main.rs:1576`).
- **The webview is the service by design.** `src-tauri/src/cli/bridge.rs:1-4` says so: "the window keeps running while
  it's closed, so instead of a second copy of that logic the command line asks the window".
- **Nothing happens on hide:**
  - Nothing unmounts or navigates.
  - The open page stays mounted with its data and timers. A Usage › Requests grid stays rendered.
  - `lib/windowVisibility.ts:10-15` only sets `data-window-hidden` to pause CSS loops.
  - The sidebar canvas stops animating (`SidebarArt.tsx:69`).
  - App/core update checks pause.
  - LimitsMonitor and LiveSessionsMonitor slow down only when no tray/alert feature needs them, and every such feature
    is on by default.

### What depends on the webview being alive

This is the crux for destroy-on-close. Class key:

- **1**: Rust already does it; the webview only shows it.
- **2**: the logic lives in TS and must be ported to Rust first.
- **3**: can wait until the window is next open.

| Job | Lives in | Cadence | Rust today | Class | Port effort |
|---|---|---|---|---|---|
| `notify()`: alert history (`saved-store.json` key `arbor.alert-history.v1`), Mac notification, toast-vs-notify, 10-min merge, phone routing | `services/notify.ts:45-83`, `alertHistory.ts:344-356`, `phoneAlerts.ts` | per alert | only phone *delivery* (`phone_alerts.rs:309,324`) and the saved store | 2. **Everything below calls this.** | M |
| Limits polling; pace/reset/expiring alerts; tray limit rows and status dot; **auto account order** (`quotaRouting.ts:90,147` PATCH via management API) | `components/LimitsMonitor.tsx` | refresh minutes; status every 5 min | none | 2 | L |
| **Account caps**: pause at cap, resume at reset | `components/AccountReservesMonitor.tsx` | 1-min tick, 2-min near-cap reads | none | 2, correctness-critical: closing the window would stop caps | M |
| Proxy checks alerts | `ProxyChecksMonitor.tsx` | 60 s | checks in `proxy_checks.rs` | 2 (thin) | S |
| Heavy-session alert | `SessionMonitor.tsx` | usage event (60 s throttle), 5 min | usage DB | 2 | S–M |
| Tray Sessions rows | `LiveSessionsMonitor.tsx` | 10–30 s | `get_live_sessions` | 2 (rows) | S |
| Weekly digest | `WeeklyDigestMonitor.tsx` | 15 min | digest data | 3 (it already catches up) | S |
| Machine down/back alerts, wake detection | `MachineMonitor.tsx` | health event, 2 min, 10 s wake tick | sampler (`machine_health.rs`) | 2 | M |
| Tray machine rows | `FleetHealthMonitor.tsx` | health event | sampler | 2 | S |
| Setup change alerts (and it *triggers* the 30-min scan) | `SetupChangeMonitor.tsx` | 60 s, then 30 min | scan + diff in Rust | 2 (timer + notify) | S |
| Automation failure alerts | `AutomationMonitor.tsx` | event | **runner is Rust** (`automations/runner.rs:24`, 30 s tick) | 1 (runs) / 2 (alerts) | S |
| **Pool slot counts**: `report_working_sessions` | `FleetMonitor.tsx` | 15 s | `pools.rs:605` *relies on the webview's report*; without it pool slots and run release go stale | 2: breaks automations on pools | M |
| Needs-you alerts | `AgentAttentionMonitor.tsx` | per fleet update | `attention.rs` collects | 2 | S–M |
| Archive drive alerts | `ArchiveMonitor.tsx` | 2 then 5 min | collection fully Rust | 1 / 2 (alert) | S |
| Update when idle | `UpdateWhenIdleMonitor.tsx` | 15 s | install/restart commands | 2 | S–M |
| Unread badge | `AlertCoordinator.tsx` → `set_tray_unread` | per alert | holds the count | 2 (badge) / 3 (toasts) | S |
| **CLI window actions**: `status.summary`, `accounts.list/pause/resume/cap`, `routing.auto`, `alerts.list/seen`, `sync.status/plan/apply`, `core.install` | `services/cliHandlers.ts:100-241` via `cli/bridge.rs` | per call | bridge waits `READY_WAIT` 30 s / `ANSWER_WAIT` 120 s (`bridge.rs:21-23`). **`ready` is never reset on unload**, so with the window gone each call would hang 120 s. | 2, or recreate the webview hidden on a CLI call | M–L |
| Tray rows/status/unread/waiting | pushed by the webview through `set_tray_rows`, `set_tray_status`, `set_tray_unread`, `set_tray_waiting` (`tray.rs:89-136,240,394,404`) | — | Rust only stores the last push | 2 | S–M each |
| Tray row actions | `tray-action` event → `services/trayMenu.ts:27` | — | shows the window, then emits | 1 (the window is shown anyway) | — |
| Quit guard | `QuitGuard.tsx` | event | Rust shows the window first | 1 | — |
| Notification click | none: no `onAction` handler, so a click just activates the app | — | — | — | — |
| Launch core install | `core_runtime.rs:115-118` errors if the window doesn't exist | launch | — | small fix | S |
| App/core update checks, analytics | `appUpdate.tsx`, `coreUpdate.tsx`; Rust flusher | 30 min, already paused when hidden | Rust | 3 / 1 | — |

**Verdict:** destroy-on-close is **XL**. Before it's safe, the decisions behind every alert, the caps state machine,
auto routing, the tray row builders, the pool report and 12 CLI actions all have to move to Rust. The order would be:

1. `notify()` → Rust, with history and phone routing (M). This unblocks every alert.
2. Caps + routing + limits (L).
3. Pool report (M).
4. Tray rows (S–M).
5. CLI actions (M–L).

Each step is also good on its own merits, since the alerts then work even if the webview crashes. Ship
destroy-on-close only at the end.

A cheaper hybrid, recreating the webview *hidden* when a CLI call arrives, only fixes the CLI. It doesn't fix caps or
alerts.

### Cheaper options, in order

1. **Unmount the page while hidden (opportunity 1).**
   - On `visibilitychange → hidden`, after a grace of ~30 s so a quick ⌘H/⌘Tab doesn't churn, render nothing in
     `<main>` instead of `ViewContent`.
   - `ViewContent` is memoized and keyed, and the view lives in `services/viewHistory.ts`, so on show it mounts again at
     the same view.
   - Also clear page-only caches: Usage records pages, session lists, request-detail data, the shiki highlighter.
   - Keep the monitor block (App.tsx:491-507) and the sidebar. The sidebar is cheap; or hide it too.
   - Measured upper bound in the mock: the six-page tour added ~30–40 MB that stayed after returning Home.
   - This doesn't free the JSC heap high-water mark by itself. It frees the live objects, and GC plus WebKit's own
     scavenger give pages back over time. Item 3 below makes that prompt.
   - **Counter:** `hidden.footprint` in a journey: visit every page → hide the page (Playwright can't hide the window,
     so dispatch the visibility state through an override) → wait 60 s → footprint. Reported, not gated, as PROCESS.md
     says for memory. Pair it with a gated count of the **DOM nodes while hidden**. Today that's whatever the last page
     had; 839 on Home in the mock. Target: the shell only.
2. **Pause what doesn't feed alerts.** That's the webview-idle findings' territory (`docs/perf/findings/webview-idle.md`).
   With `backgroundThrottling` disabled, every page-level poll keeps running hidden.
3. **Memory pressure (opportunity 8).**
   - WKWebView has no public "purge" API. The content process does respond to the system's memory-pressure
     notifications.
   - Reaching it means adding `objc2-web-kit` and `WebviewWindow::with_webview`. Options are a private
     `_setMemoryPressure…`/`_clearMemoryCache`-style call (risky, may break across macOS versions), or
     `WKWebsiteDataStore.removeData(ofTypes: [memoryCache])` for decoded resources only (public, small win).
   - Low confidence, measure before building.
   - In the mock, navigating to `about:blank` kept 134–145 MB after a tour versus 67–109 MB without. WebKit holds the
     high-water mark, which is why unmounting early (before a big page's data grows the heap) matters more than
     clearing later.
4. **Reload the webview after a long hide.**
   - After N minutes hidden, `location.reload()` into a "background" mode that mounts only providers and monitors.
     That gives a fresh JSC heap at ~launch size (about 110 MB in the mock, at real data maybe 150–200 MB versus 448).
   - Cost: one launch's worth of CPU, and the show needs the full UI to mount (~300 ms, plus the static first paint
     from opportunity 5 to hide it).
   - All jobs survive, because the monitors come back with the reload. The CLI bridge's `ready` must handle the reload
     too: set it false on page unload.
   - This is the best ratio of win to effort if 1 isn't enough. M effort, medium confidence.

---

## 5. WebKit-specific memory

| Item | Measured | Cost |
|---|---|---|
| Sidebar art canvas | `canvas` 255×152, **one canvas pixel per CSS px, not ×DPR** (`SidebarArt.tsx:50-56`, scaled with `image-rendering: pixelated`) | ImageData 155 KB, plus two Float32Arrays of 155 KB each: about 0.5 MB. Animates with rAF only while visible and focused (`:69`). Fine. |
| Decoded images | 8 `<img>` on Home, all 16×16 (provider marks) | negligible |
| Backdrop blur | 1 element on Home: `bg-background/95 backdrop-blur` on surfaces. Elsewhere `App.tsx:665` (narrow-window scrim), `data-table.tsx:96` footer, `SetupPage.tsx:786`, `SetupSkills.tsx:1080`, `SetupProjects.tsx:287` sticky trays, `UsageRequestsGrid.tsx:346` and `SetupPluginGrid.tsx:449` (`backdrop-blur-xl` sheets) | Each is a composited layer the size of the element × DPR², about 1–6 MB each while shown. Only matters while those pages are mounted, so opportunity 1 covers it. |
| Fonts | `document.fonts` is empty. `--font-sans`/`--font-mono` are system stacks (`styles.css:8-9`). | none |
| DOM | 839 elements on Home | small |

Nothing here is worth a change on its own.

---

## Launch timer inventory (for the benchmark's "timers while idle" count)

Started by the shell and monitors at launch:

| Timer | Interval | Where | Paused while hidden? |
|---|---|---|---|
| Page prefetch | 2 s, once | App.tsx:168 | – |
| Core status | 10 s | coreRuntime.tsx:71 | yes |
| App / core update | 30 min | appUpdate.tsx:137, coreUpdate.tsx:194 | yes |
| Shared quota clock | 60 s | services/quotaTime.ts:69 | no |
| Quota refresh | 15 min | LimitsMonitor.tsx:161 | no (tray/alerts on by default) |
| Provider status pages | 5 min (`fetch`) | LimitsMonitor.tsx:179 | no |
| Reserves | 2 min | AccountReservesMonitor.tsx:76 | no |
| Proxy checks | 60 s | ProxyChecksMonitor.tsx:56 | no |
| Heavy sessions | 5 min | SessionMonitor.tsx:119 | no |
| Live sessions | 30 s | LiveSessionsMonitor.tsx:68 | no by default |
| Machine alerts | 2 min, 10 s wake tick | MachineMonitor.tsx:125-126 | no |
| Agent versions | 1 h | services/agentReleases.ts:39 | no |
| Setup scan | 60 s, then 30 min | SetupChangeMonitor.tsx:35-36 | no |
| Archive check | 2 min, then 5 min | ArchiveMonitor.tsx:60-61 | no |
| Fleet sources | 15 s | FleetMonitor.tsx:61 | no |
| Today stats / Home machine sessions | 5 min | HomeDashboard.tsx:172, HomeMachines.tsx:83 | no (and still running from a page left open while hidden) |
| Sidebar art | rAF | SidebarArt.tsx:81 | yes (visible and focused) |

`backgroundThrottling: "disabled"` (`tauri.conf.json:25`) means none of these slow down when the window is hidden.

## Reproducing the numbers

- The audit config is `/tmp/arbor-perf-audit/audit.config.mjs`: it imports `vite.config.js` and adds a
  `generateBundle` hook that writes `chunks.json` and `graph.json`. `cut.mjs` simulates a lazy cut by removing an
  import edge. `pf.mjs` computes each page's prefetch closure.
- WebKit runs are in `/tmp/arbor-perf-audit/pw/` (`run.mjs`, `residual.mjs`, `timing.mjs`, `probe.mjs` for shiki),
  against `vite build --mode demo --outDir /tmp/arbor-perf-audit/demo` served by `python3 -m http.server`.
- These should become `bun run perf` journeys: "cold launch to Home" (bytes, native calls, management requests),
  "idle 10 s after launch" (bytes fetched), "tour then hide" (footprint and DOM nodes while hidden).

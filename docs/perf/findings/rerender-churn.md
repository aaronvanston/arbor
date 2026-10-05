# Re-render churn: what changed, and what still renders

BACKLOG items W2, W3, W8 and W10, and findings 8 and 9 of `baseline.md`, measured with `bun run perf` on 2026-10-06.
"Before" is main with the new counters (below) and none of the fixes; every gated count is in `perf/baseline.json`.

## The counters this work added

- **Component renders** (`launch.componentRenders`, `idle.componentRendersPerMinute`): every component render across
  every commit. Commits alone hid the cost: one commit can re-render a card or all of Home. Launch varies by up to
  about 6% between runs (when lazily loaded chunks land), so the counter has a 6% tolerance; idle doesn't vary.
- **Where renders start** (`topOrigins` in `perf/latest.json`, printed after the idle tables): each render tallied
  against the topmost component that rendered for its own reasons. It names the store or clock behind a commit.
- **Health rounds** (`healthRound.*`): the mock never sends `machine-health-updated`, so the idle journey missed what
  the real sampler's once-a-minute round re-renders. Five rounds after the idle send it through `window.__mockEmit`
  and count the two seconds after each. The mock cycles ci-01's status every minute, so the sidebar tree's re-render
  on a round is a real change, not churn.

## Before and after

| Counter | Default | Real size |
| --- | ---: | ---: |
| Idle component renders a minute | 752 → 273 | 915 → 273 |
| Idle React commits a minute | 5.7 → 5.3 | 5.7 → 5.3 |
| Renders per health round | 555 → 258 | 710 → 245 |
| Launch component renders | 7,666 → 5,567 | 8,542 → 5,929 |
| Launch React commits | 121 → 112 | 119 → 113 |
| Frame callbacks a second, idle and focused | 62.7 → 15.8 | 62.7 → 15.8 |
| Timer fires a minute, idle | 28.8 → 44.5 | 28.8 → 44.5 |
| DOM nodes, closed to the tray | 313 → 310 | 457 → 454 |
| Launch JS | +3,256 bytes | +3,256 bytes |

The timer fires are the sidebar art's: it now sleeps on a timer between its 15 frames a second rather than asking
for every display frame, so a focused idle window wakes about 31 times a second instead of 63, and runs a rendering
update 15 times instead of 60. The counter samples frames for the first 10 s of idle only, so it reads 15.6 timer
fires a second as 15.7 a minute. The launch JS is the shared `replaceEqualDeep` and selector hooks, the popup
wrappers and the shared clocks. The owner approved raising both ceilings.

## How "no visible change" was checked

Screenshots of the build before the fixes and after, in Playwright WebKit on the same page clock: Home at 5 s and
65 s, the sidebar canopy frame by frame in light and dark, a glance chip's tooltip and the glance's context menu as
they open and close, the ⌘Q warning in and out, Usage › Requests at rest and scrolled, Sync › Software and Projects ›
Checkouts across a minute of their clocks. All match pixel for pixel except two spots that also differ between two
runs of the same build: the pulsing waiting dots on Needs you, and an account bar's grow-in. Two traps:

- CSS transitions and animations run on real time, not the page clock, so a shot mid-fade isn't reproducible. Wait
  real time before each shot and compare settled states.
- `setTimeout` is the page clock's too: awaiting one in `page.evaluate` while the clock is paused hangs. Post
  through a `MessageChannel` instead.

The art's frames are also checked by `tests/sceneFrames.test.ts`, which runs the old loop and the new one against
displays at 60, 90 and 120 Hz with late timers and compares every draw.

## What still renders at an idle Home, at real size

- Home itself, about 100 renders a minute: `useHomeMachines` follows the live board, which is rebuilt on every
  fleet read. Its sections are memoized, so this is Home's own shell; the board's rows (Needs you) render with it.
- `HomeProxy`, 82 a minute: its own state from `useCoreRuntime` and `useAppUpdate`, not the clock any more.
- The footer's `CoreUtility` (30) and the toast viewport (17).
- Per health round, Home's machine cards for the machines whose readings changed.

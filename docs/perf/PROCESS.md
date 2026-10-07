# Making Arbor faster: how the work runs

Modeled on how claude.ai got ~3x faster (claude.dev/blog/how-we-made-claude-ai-faster): measure first, make each
measurement repeatable, fix one slow spot at a time, and never let a number go back up.

## The loop every session follows

1. **Report a slow spot.** Name it, where it is (`file:line`), and what it costs (memory, CPU, load time, re-renders).
2. **Build a benchmark** that shows it, using `bun run perf` (see below). A number you can't reproduce isn't one.
3. **Prove the benchmark matters.** It must move with something a person feels: wall-clock time, or the window's
   memory in Activity Monitor. A counter that doesn't track either is dropped.
4. **Fix it** in its own worktree, one logical change per commit, tests first where behavior could change.
5. **Ratchet.** `bun run perf:ratchet` lowers the ceiling to the new number, in the same commit as the fix.
6. Move on to the next slow spot.

## What gets measured

All in the mock (`vite build --mode demo`, served locally) driven by Playwright WebKit, the engine Arbor's window uses.
Each journey (cold launch to Home, open each main page, an hour of idle compressed with fake timers, ...) records:

- **Gated counts** (same on every run, so CI can fail on them): JS bytes loaded at launch and per page, timers
  running while idle, commands sent to the native side per idle minute and their payload bytes, React commits per
  idle minute and per navigation, DOM mutations, long tasks over 50 ms.
- **Reported only** (noisy, used to prove a counter matters): time to first paint and to interactive, the WebKit
  content process's memory, CPU while idle.

`perf/baseline.json` holds the ceilings. `bun run perf:check` fails when a gated count goes over its ceiling;
`bun run perf:ratchet` tightens ceilings to the current numbers and never loosens them.

`bun run perf:cpu` (`perf/idleCpu.ts`) is the real-clock companion: it idles a page in WebKit at a large Retina
window, sends health rounds every five seconds, and reports the CPU the WebContent and GPU processes used. It sees
what the page clock can't, CSS transitions and painting, so check it after touching anything that animates.
`bun run perf:soak` (`perf/soak.ts`) leaves a page open for hours of page-clock time, with health rounds every five
seconds, and fails `--check` when elements, live timers, window listeners or native event listeners grow; it reports
the WebContent footprint's slope per hour. A window left visible never reloads, so anything that only adds shows here.

The Rust side has `src-tauri/src/usage/bench.rs` (page reads on a million requests, release mode only) and grows
the same way: a slow command or background loop gets a bench before it gets a fix.

## Rules for every session

- Everything in `CLAUDE.md` / `AGENTS.md` applies. The real app and its data are off limits: never launch it, never
  read its config, credentials, usage.db or archive. The one exception: a session may read the **running** Arbor's
  process numbers (`ps -o pid,rss,%cpu`, `footprint <pid>` summary) to check a benchmark against reality. Nothing
  else about the real app.
- No user-visible change ships without the owner's sign-off on how it looks or feels (memory: show designs before
  shipping). Pure speed changes with no visible difference follow the normal push-to-main flow.
- Findings go in `docs/perf/findings/<topic>.md`: ranked slow spots, each with location, evidence, proposed
  benchmark and proposed fix, plus how sure you are.
- Mock data must be at the owner's real size (memory: test at real size), so a page that's slow with 50 machines or
  a million requests shows it.

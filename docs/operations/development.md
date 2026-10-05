# Development

## Gates

Each is a `package.json` script.

- `typecheck`: `tsc --noEmit` over `src/`. Beyond `strict`, `tsconfig.json` turns on `noUncheckedIndexedAccess`,
  `noImplicitReturns`, `noFallthroughCasesInSwitch` and `noImplicitOverride`.
- `typecheck:tests`: `tsc -p tsconfig.test.json --noEmit`, the same over `src/` and `tests/` with Bun's types.
- `lint`: `oxlint --disable-nested-config` with `.oxlintrc.json`. `.gitignore` already keeps oxlint out of
  `.claude/worktrees`; the flag makes sure a worktree's own copy of the config never applies even if that entry goes.
- `knip`: unused files, exports and dependencies, configured in `knip.json`.
- `test`: `bun test`.
- `verify`: the five above in order, stopping at the first failure.
- `verify:rust`: `cargo test` in `src-tauri` and `core-plugins/arbor-models`. Its bindings test fails when
  `src/native/types.ts` no longer matches the Rust types.
- `bindings`: that test with `ARBOR_WRITE_BINDINGS=1`, which rewrites the file.
- `build`: `tsc && vite build` into the gitignored `dist/`. `verify` doesn't run it, and it's the only gate that
  compiles `src/styles.css`, so a bad Tailwind utility passes `verify` and fails here. A release only reaches it at the
  end of `bun tauri build`, so a build failure pushed to main costs a nightly.
- `build:demo`: `tsc && vite build --mode demo` into the gitignored `dist-demo/`: the browser mock as a static site with
  relative paths and only the free icons (the Pro license doesn't cover a public website), for the website's clickable
  demo. Production builds never include the mock.

## Icons

Icons come from `src/components/ui/icons.tsx`: Hugeicons stroke rounded under Lucide names, with a duotone twin for
anything a sidebar row can select. The duotone set is Hugeicons Pro, installed through `.npmrc` with
`HUGEICONS_LICENSE_KEY` from the untracked `.env`. Without the key `bun install` prints a 401 for
`@hugeicons-pro/core-duotone-rounded`, and the free set stands in. Never commit the key.

New worktrees get `.env` and the other gitignored files `.worktreeinclude` lists: Claude Code copies them itself, and
`t3.json` runs `scripts/copy-worktree-includes.sh` for T3 Code's worktrees.

## The browser mock

In a Vite dev build outside the Tauri shell, `src/main.tsx` loads `src/dev/mockTauri.ts`. It answers every Tauri
command, and the core's management API behind `management_request`, through `mockCommands` in
`src/dev/mock/answers.ts`. Each domain's answers form one map typed against that domain's command list, so a missing
answer, one for a command that's gone, or one of the wrong shape doesn't compile. Each domain has a file in
`src/dev/mock/` named for it (`app.ts`, `core.ts`, `usage.ts`, `machines.ts`, `setup.ts`, `archive.ts`) with its
answers and made-up data, typed with the generated types; `scenario.ts` has the query string and the clock they share.

Scenarios are query-string flags such as `?core=stopped`, `?health=down`, or `?fresh=1` for the day Arbor is installed
(no key, accounts, machines or history). The list is the comment at the top of `src/dev/mockTauri.ts`, and a few more
sit beside their `params.get(` calls. When you add a Tauri command, add its answer; when the webview stops calling one,
delete the answer with its list entry; when you add a UI state (an error, an empty list, a warning), add a flag that
shows it and list it in that comment.

## Benchmarks

`bun run perf` is the webview's speed benchmark, run the way `docs/perf/PROCESS.md` describes. It builds the demo
with hidden source maps into the gitignored `.perf/site/`, drives it in Playwright's WebKit on a fake clock (cold
launch, every page, ten minutes of idle, at the default and `?size=real` sizes), prints the counts with where they
come from and writes the gitignored `perf/latest.json`. `perf:check` fails when a gated count is over its ceiling in
`perf/baseline.json`, `perf:ratchet` lowers the ceilings to this run (never raising one) and `perf:report` prints the
last run again. It takes about a minute, so `verify` doesn't run it; `--reuse` checks or ratchets the last run.

`src-tauri/src/usage/bench.rs` fills a usage.db with a million requests and times each page's reads. It's ignored in
the normal run and only means something in release, where SQLite is compiled optimized:

```sh
cd src-tauri && cargo test --release usage::bench -- --ignored --nocapture   # ARBOR_BENCH_DIR=<dir> keeps the database
```

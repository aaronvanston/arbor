# Commands and types

## Calling a command

The webview calls Tauri commands only through `invokeCommand` (`src/native/commands.ts`), never `invoke`. Each command
has an entry in its domain's file under `src/native/` (`app.ts`, `core.ts`, `usage.ts`, `machines.ts`, `setup.ts`,
`archive.ts`) giving the arguments it takes and what it returns. `tests/commandParity.test.ts` checks every entry
against the Rust signature, fails on a command registered in `main.rs` without one, and fails on an `invoke` import
outside `src/native/` or a `mockIPC` use.

## Generated types

The types come from Rust: give each type a command takes or returns `#[derive(TS)]`, list it in
`src-tauri/src/bindings.rs`, and run `bun run bindings` to rewrite `src/native/types.ts`. Never copy one into
TypeScript.

- Where TypeScript wants a union and Rust has a `String`, make it a Rust enum.
- A string Rust only stores, passes on from another program (GitHub's review states, a transcript's compaction
  trigger) or shares as words with a script on a machine stays a `String`, with `#[ts(type = "...")]` spelling out the
  values its doc comment lists.
- A field serde may skip needs `#[ts(optional)]` (the parity test checks). An input whose fields all have defaults
  takes `#[ts(optional_fields)]`, so the webview sends only what it uses.
- `types.ts` is one namespace, so a nested type with a vague or clashing name gets `#[ts(rename = "...")]`. A command's
  own argument or result type keeps its Rust name, since the parity test matches on it; rename that one in Rust.

## Failures

Never branch on a command's error sentence. A command whose failure the webview acts on returns a `CommandError`
(`src-tauri/src/command_error.rs`: a kind, plus the core's status and reason when it answered), read with
`readCommandError` (`src/services/commandError.ts`). Management requests and core installs already do. A failure that's
only shown can stay a string. Other programs' text, such as ssh's stderr, is still matched as text.

## Every new command also needs

- an answer in its domain's mock map (`src/dev/mock/`), and a scenario flag for any new UI state;
- a place in `arbor`: `bun run cli-commands`, or an entry in `LEFT_OUT` in `scripts/cli-commands.mjs` with its reason
  (and in `NEEDS_CONFIRMATION` when the window confirms it first). `tests/cliCommands.test.ts` fails until one is done.

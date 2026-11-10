# session-tables

Your coding agents' sessions as tables you can ask questions of.

Claude Code, Codex, Pi and OpenClaw each keep a transcript of every session as a file of JSON lines. `session-tables`
reads those files into Parquet tables in a folder on the same machine, and runs SQL over them with
[DuckDB](https://duckdb.org). Nothing is sent anywhere, and a transcript is only ever read.

```sh
cargo install --path .          # needs DuckDB's command-line program too: https://duckdb.org/install
session-tables build            # read what's new in ~/.claude, ~/.codex, ~/.pi/agent and ~/.openclaw
session-tables query --saved    # the ready-made questions
session-tables query --saved shell-habits
session-tables query "SELECT model, count(*) AS calls, sum(output) AS output FROM requests GROUP BY model ORDER BY calls DESC"
session-tables tables           # every table and view, with its columns
```

`build` reads only what is new since the last run, so it can run as often as you like, from a timer or by hand. The
tables go in `~/.local/share/session-tables` (or under `XDG_DATA_HOME`) unless `--out` names another folder, and the
folder is its owner's alone: with the default detail it holds what was said in every session. `--numbers-only` keeps
names, ids, counts, sizes and times and leaves out every prompt, reply, command and tool output.

A query can read the tables and nothing else: the engine is started with no access to other files or the network,
and with its settings locked. To use a DuckDB of your own without that, `duckdb -init <(session-tables views)` names
the tables in it.

## What's in the tables

- `lines`: one row per transcript line, with every field no other column holds kept in `rest`.
- `messages`: what was said, by role and kind: prompts, replies, thinking, summaries. A prompt says who sent it
  (`origin`: a person, a program, a schedule, another agent) where the agent wrote that down.
- `requests`: one row per model call, with its model, token counts, and how it ended.
- `tool_calls`, `tool_results`, `tool_io`: each tool call, how it ended and how long it took, and its input and output.
- `commands`: each program a shell call ran, split out of the command line.
- `files_touched`, `hooks`, `prompts`, `tool_defs`, `context_use`: the files a session read and wrote, hook runs,
  system prompts, tool definitions, and how full the context was.
- `sessions`, `turns`, `tools`: views with one row per session, per prompt with what it led to, and per tool call
  with how it ended.
- `proxy_requests`, `speed`: a proxy's own record of each request. Arbor fills these; `build` leaves them empty.

A session is often kept in more than one file: a resumed or forked session writes what came before again, and Codex
writes a call again each time it carries a session on. Each line gets a key from what it is (its id, a call's id, a
running total) and is counted once however many files hold it. `lines_all` and the other `_all` views show the
repeats too.

## As a library

`Parser::line` turns one transcript line into `Rows`, and opens no files, so it serves an archive, a folder or a
test alike. `store` keeps rows as Parquet files in a folder and merges them by month; `local` is what `build` runs.
The crate has no async runtime and three dependencies. [Arbor](https://github.com/aaronvanston/arbor) uses it to make
the same tables from its session archive, across every machine it watches.

## Tests

```sh
cargo test                                         # the parsers, and the store against a stand-in engine
SESSION_TABLES_DUCKDB=<duckdb> cargo test          # the same with DuckDB writing and reading real files
SESSION_TABLES_DUCKDB=<duckdb> cargo test --release bench -- --ignored --nocapture   # timings on made-up sessions
```

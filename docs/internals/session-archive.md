# Session archive

The archive is the one place Arbor keeps conversation text, and the exception has hard edges. The rules themselves
are in `AGENTS.md`; this is how the pieces fit.

Code lives in `src-tauri/src/usage/machine_health/archive.rs` and `archive/`. Settings › Session Archive is its page.

- **Store.** Byte-for-byte copies of transcript files go into a store in a folder the user picks, usually on another
  drive (this Mac's own disk works, with a warning). Raw bytes live only in the store's `chunks/`, and for a file still
  growing, its tail in `pending/`. Nothing in `chunks/` is deleted or rewritten, except swapping a proven-corrupt file
  for a verified copy with the same hash; superseded tails stay.
- **Index.** `archive.db`, kept in the app's `session-archive/` folder, plus the store's `journal/`, hold ids, paths,
  sizes, hashes and times only.
- **Collection.** This Mac's agent homes are read from disk; each other machine's over SSH by `archive/remote.rs`,
  after this Mac's. `archive/imports.rs` takes in old backups of agent homes the user picks, and `archive/layouts.rs`
  finds backups in other shapes (OpenClaw, Claude's desktop app).
- **Links.** A live home's links are followed, since a rollout moved to another disk and linked back is still that
  home's. A backup's aren't: it can come from anywhere, so `imports::confine` keeps only files that resolve inside their
  own root, and the pass reads only the file the listing stat'ed. A store's own folders must be real folders, never
  links, because a store can sit on a drive others write to.
- **Tokens.** `archive/tokens.rs` counts tokens for Usage › All time, keeping each call's hashed id with its day, model
  name and token numbers. `archive/recovered.rs` reads Claude Code's own `stats-cache.json` daily totals (each
  machine's days with model names, token and session counts) for days whose transcripts are gone.

- **Export.** `archive/export.rs` puts sessions back together into a new or empty folder the user names, outside the
  archive's own folders: the one way raw bytes leave a store, and only when asked. It reads without the store's lock,
  since chunks never change and a growing version whose tail moves on is read again, and it writes nothing to the
  index or the journal. Its answer holds the same ids, paths and counts as every archive command. A session's
  project and branch come from usage.db by session id, so a session Arbor hasn't read a transcript of has none.
- **Analytics.** With analytics on (off by default), `archive/analytics.rs` reads the kept Claude Code, Codex, Pi
  and OpenClaw transcripts into tables in the store's `analytics/`, after everything else in a pass. The tables are made from
  `chunks/` and can always be made again, so they are never the only copy of anything and removing the folder only
  costs the time to rebuild.
  - **Who reads a line.** `crates/session-tables` alone turns a transcript line into rows; the archive hands it
    bytes. That keeps the one place that reads what was said small, apart from Tauri, and usable on its own.
    The crate's `session-tables` command (`local.rs`) is that use on its own: it reads agent homes straight into a
    folder, for someone with no Arbor. Arbor never runs it or calls `local`; what Arbor reads comes from `chunks/`.
  - **Self-contained.** The Parquet files, their manifest and `state.db` (how far each version is read) are all in
    `analytics/`. Nothing of the tables is in `archive.db` or the journal, so those hold what they always held.
  - **Rows are only added.** A version is read from where it was last read to. Progress is staged in `state.db`
    with the number the next write takes, and counts once the tables hold a write of that number, so a pass stopped
    at any moment neither loses rows nor adds them twice.
  - **A line counts once.** The same session can be kept in more than one file: an earlier copy in a backup beside
    the finished one, or a session that carried on from another and copied its lines. `state.db` holds a 12-byte
    key for every line read with the version it was first read from, and a line met again is written with `repeat`
    set. A table is read without its repeats; `lines_all` and the like include them. Keys are staged with the
    progress, since a key says its line's rows are in the tables. Dropping the rows instead would lose the only
    copy of a line whenever the first file read turned out to be the one later deleted.
  - **A line's key is what it is, not its bytes, where it says.** Codex writes a session's items again with new
    times when it carries the session on, and one rollout holds the counts of every thread that reports into it, so
    by its bytes a Codex call was counted about six times on a real archive. An item is known by its id or its
    call's, a count of tokens by the thread's running total after it (the key token counting uses), and a Pi reply
    by its response's id. Only a line with none of these is known by its bytes. Before changing what a key is made
    of, compare `requests` by agent with the calls `get_lifetime_tokens` counts, leaving out requests with no
    tokens at all (a failed call, which token counting doesn't count): on a real archive of 2.5 million calls each
    agent's two numbers were within a hundredth of a percent, the gap being sessions still running.
  - **A prompt is what a session was sent, as the agent itself says.** Far more reaches the model under the user's
    name than anyone typed: on a real archive nearly half of Codex's user messages were the folder's instructions,
    the environment, plugins on offer and subagents' reports, and a quarter of Claude Code's prompts on one machine
    were notices from its own background tasks. Those rows are `meta`. Codex's prompt is its `user_message` event
    or, in later versions, its `UserMessage` item (a rollout has one or the other; a session carried on can have
    both for one prompt, in two files, so prompts are counted by when they were sent). Claude Code's is a user line
    that isn't `isMeta`, whose `promptSource` isn't `system` and whose `origin.kind`, if it has one, is `human`.
    Never tell them apart by how the text opens.
  - **A Claude Code subagent's task is no turn.** Its lines are under its parent's session, so its task is `meta`
    and its work counts for the prompt that led to it; counted as prompts, those tasks were two in five of Claude
    Code's on a real archive and cut the person's turns short. A Codex subagent is a thread of its own, so its
    task is a turn there. `origin` on a prompt says who sent it (`person`, `program`, `subagent`, `schedule`,
    `agent`) from what the agent wrote down: Claude Code's `promptSource` and `origin.kind`, Codex's
    `turn_attribution` on the turn's start and `thread_source` on the rollout's first line. Where neither says, it
    is empty, never guessed.
  - **A file that can't be read is set aside.** A kept version that fails to read (one that decompresses past the
    4 GB the archive reads, say) is left for a quarter of an hour, then four times as long each time it fails again,
    up to a week, and tried at once if it grows. Token counting does the same. Trying every pass cost a 4 GB read
    each time and kept "still to read" from ever reaching zero.
  - **The proxy's requests are a table too.** `proxy_requests` is copied from usage.db after the transcripts, in the
    order the proxy numbered them, with a cursor in `state.db` staged around each write. It holds ids, names and
    numbers only: what a failed request answered with, the client's address and its key stay in usage.db, and the
    account is the core's index for it, never its name, since the store can sit on a drive that leaves the Mac.
    Cost is worked out when a row is copied, by the code the Usage pages use, so a query never has to redo tiers and
    long-context rates; it is the price on the day of the copy.
  - **The engine is a program, not a library.** Parquet is written by DuckDB's command-line program, which Arbor
    fetches when analytics is turned on and checks against the SHA-256 pinned in the crate. What DuckDB says when it
    fails can quote a row, so only the kind of error it names is kept.
  - **Queries.** `arbor query` (`archive/query.rs`) runs one `SELECT` over the tables, and its answer can hold what
    was said, so the command is the command line's alone and has no entry in `src/native/`.
    - DuckDB's own parser decides what a `SELECT` is: the query is handed to `json_serialize_sql` as a string, and
      what runs is the parsed statement that comes back, through `json_execute_serialized_sql`. Typed text is never
      read as SQL twice, or as a line of DuckDB's shell, so there is no second parser to disagree with the first.
    - The settings that confine the process to `analytics/v1/` are defense in depth, as DuckDB's own guide says, not
      a sandbox. The vetting is what keeps a query from writing; the settings keep a `SELECT` from reading other
      files. The process also starts with an empty environment.
    - The socket's redaction only hides a value that is a key from its first character. A command or a file an agent
      read can hold one mid-line, so a query's text cells are masked inside as well (`redact::masked`).
  - **Only a pass touches the folder.** Rebuild and Delete tables set a flag, and the next pass removes the folder
    before it reads anything, so a removal never races the pass that writes there. The status reads what the last
    pass noted in `archive.db` (rows, bytes, files left, an error's kind), never the drive.

Stored frames and compressed transcripts are only ever decompressed through `archive/codec.rs`, which stops at a
ceiling: a store or a backup can come from someone else, and a few kilobytes of zstd can claim gigabytes.

Working out which session a file is, and counting its tokens, uses structs that name only those fields. The archive's
SECRET tests prove nothing more leaves `chunks/`, apart from the rows in `analytics/` when it's on; every new archive
command extends them. Archive tests build stores and
homes in temp folders and run the lister under both `sh` and `dash` against a temp HOME.

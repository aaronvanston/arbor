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
- **Analytics.** With analytics on (off by default), `archive/analytics.rs` reads the kept Claude Code and Codex
  transcripts into tables in the store's `analytics/`, after everything else in a pass. The tables are made from
  `chunks/` and can always be made again, so they are never the only copy of anything and removing the folder only
  costs the time to rebuild.
  - **Who reads a line.** `crates/session-tables` alone turns a transcript line into rows; the archive hands it
    bytes. That keeps the one place that reads what was said small, apart from Tauri, and usable on its own.
  - **Self-contained.** The Parquet files, their manifest and `state.db` (how far each version is read) are all in
    `analytics/`. Nothing of the tables is in `archive.db` or the journal, so those hold what they always held.
  - **Rows are only added.** A version is read from where it was last read to. Progress is staged in `state.db`
    with the number the next write takes, and counts once the tables hold a write of that number, so a pass stopped
    at any moment neither loses rows nor adds them twice.
  - **The engine is a program, not a library.** Parquet is written by DuckDB's command-line program, which Arbor
    fetches when analytics is turned on and checks against the SHA-256 pinned in the crate. What DuckDB says when it
    fails can quote a row, so only the kind of error it names is kept.
  - **Only a pass touches the folder.** Rebuild and Delete tables set a flag, and the next pass removes the folder
    before it reads anything, so a removal never races the pass that writes there. The status reads what the last
    pass noted in `archive.db` (rows, bytes, files left, an error's kind), never the drive.

Stored frames and compressed transcripts are only ever decompressed through `archive/codec.rs`, which stops at a
ceiling: a store or a backup can come from someone else, and a few kilobytes of zstd can claim gigabytes.

Working out which session a file is, and counting its tokens, uses structs that name only those fields. The archive's
SECRET tests prove nothing more leaves `chunks/`, apart from the rows in `analytics/` when it's on; every new archive
command extends them. Archive tests build stores and
homes in temp folders and run the lister under both `sh` and `dash` against a temp HOME.

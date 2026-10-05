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
- **Tokens.** `archive/tokens.rs` counts tokens for Usage › All time, keeping each call's hashed id with its day, model
  name and token numbers. `archive/recovered.rs` reads Claude Code's own `stats-cache.json` daily totals (each
  machine's days with model names, token and session counts) for days whose transcripts are gone.

Working out which session a file is, and counting its tokens, uses structs that name only those fields. The archive's
SECRET tests prove nothing more leaves `chunks/`; every new archive command extends them. Archive tests build stores and
homes in temp folders and run the lister under both `sh` and `dash` against a temp HOME.

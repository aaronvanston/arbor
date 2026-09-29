import type { ArchiveStatus, FolderCheck, ImportPreview, LifetimeTokens } from './types';

/** The session archive: its store, collecting into it, old backups brought in, and the all-time token count it keeps. */
export type ArchiveCommands = {
  get_session_archive_status: { result: ArchiveStatus };
  check_session_archive_folder: { args: { path: string }; result: FolderCheck };
  create_session_archive: { args: { path: string }; result: ArchiveStatus };
  use_session_archive: { args: { path: string }; result: ArchiveStatus };
  run_session_archive_now: { result: void };
  set_session_archive_paused: { args: { paused: boolean }; result: ArchiveStatus };
  save_session_archive_settings: { args: { gentle: boolean; otherMachines: boolean }; result: ArchiveStatus };
  set_session_archive_machine: { args: { machine: string; keep: boolean | null }; result: ArchiveStatus };
  set_session_archive_project: { args: { project: string; machine: string | null; keep: boolean | null }; result: ArchiveStatus };
  reveal_session_archive: { result: void };

  preview_session_import: { args: { path: string }; result: ImportPreview };
  add_session_import: { args: { path: string; machine: string }; result: ArchiveStatus };
  cancel_session_import: { args: { id: number }; result: ArchiveStatus };

  get_lifetime_tokens: { result: LifetimeTokens };
};

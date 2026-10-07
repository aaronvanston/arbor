import type { CleanupRemoval, CleanupRestore, CleanupScan, CleanupTarget, SetAsideRef } from './types';

/** A machine's clean-up: what could come off it, set aside rather than deleted, and what's set aside there. */
export type CleanupCommands = {
  get_machine_cleanup: { args: { machine: string }; result: CleanupScan | null };
  check_machine_cleanup: { args: { machine: string }; result: CleanupScan };
  remove_cleanup_items: { args: { machine: string; items: CleanupTarget[] }; result: CleanupRemoval };
  restore_set_aside: { args: { machine: string; stamp: string; item?: number | null }; result: CleanupRestore };
  delete_set_aside: { args: { machine: string; items: SetAsideRef[] }; result: CleanupScan };
};

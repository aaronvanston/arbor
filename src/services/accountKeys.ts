import { renameLimitHistory } from './accountLimitHistory';
import { getAccountsSnapshot, loadAccountFiles } from './accountsStore';
import { renameAccountOrderKeys } from './accountOrder';
import { renameAccountProfiles } from './accountProfiles';
import { renameReserveKeys } from './accountReserves';
import { renamePlanCosts } from './planCosts';
import type { AuthFileRecord } from './authFiles';
import { renameQuotaCacheKeys } from './quotaCache';
import { quotaKey } from './quotaService';

export type AccountKeyRename = { from: string; to: string };

/** The app keys a credential by file name and auth index, and both change when the core renames the file. */
export const renamedCredentialKeys = (from: AuthFileRecord, to: AuthFileRecord): AccountKeyRename => ({
  from: quotaKey(from),
  to: quotaKey(to),
});

/**
 * Carries per-account app state (display profile, Accounts order, cached
 * limits, plan cost, cap, long-term limit history) over to a credential's new key
 * after the core saved it under a new file name. State kept per provider (the
 * 24-hour sparkline history, window preferences, limit notifications, tray
 * lines) is unaffected by a rename.
 */
export function migrateAccountKeys(renames: AccountKeyRename[]) {
  const moves = renames.filter(({ from, to }) => from && to && from !== to);
  if (moves.length === 0) return;
  renameAccountProfiles(moves);
  renameAccountOrderKeys(moves);
  renameQuotaCacheKeys(moves);
  renamePlanCosts(moves);
  renameReserveKeys(moves);
  void renameLimitHistory(moves);
  // The shared account list still holds the old file. Reload it so background
  // limit refreshes and the sidebar stop asking about a credential that is gone.
  if (getAccountsSnapshot().loaded) void loadAccountFiles();
}

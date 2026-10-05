import { renameLimitHistory } from './accountLimitHistory';
import { getAccountsSnapshot, loadAccountFiles } from './accountsStore';
import { renameAccountOrderKeys } from './accountOrder';
import { renameAccountProfiles } from './accountProfiles';
import { renameReserveKeys } from './accountReserves';
import { renamePlanCosts } from './planCosts';
import type { AuthFileRecord } from './authFiles';
import { renameQuotaCacheKeys } from './quotaCache';
import { readString } from './managementApi';
import { quotaKey } from './quotaService';

export type AccountKeyRename = {
  from: string;
  to: string;
  /** The name the account was shown under before, for one that had no profile name of its own. */
  name?: string;
};

/**
 * The name an account without a profile name was shown under: its file name. A file name carrying the account's email
 * is left out, since a saved profile name would show the email even while Hide email addresses is on.
 */
const shownFileName = (file: AuthFileRecord) => {
  const fileName = readString(file, 'name').replace(/\.json$/i, '');
  return fileName && !fileName.includes('@') ? fileName : undefined;
};

/**
 * The app keys a credential by file name and auth index, and both change when the core renames the file. The old file
 * name goes along too, so an account the core moved to its own file name keeps the name it was known by.
 */
export const renamedCredentialKeys = (from: AuthFileRecord, to: AuthFileRecord): AccountKeyRename => {
  const name = shownFileName(from);
  return { from: quotaKey(from), to: quotaKey(to), ...(name ? { name } : {}) };
};

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

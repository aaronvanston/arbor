import type { UsageAccountCategory, UsageCategory } from '../native/types';
import type { ResolvedProfile } from './accountProfiles';
import type { ShownIdentity } from './emailPrivacy';
import { normalizeAuthIndex } from './managementApi';

/** A Breakdown row for an account, with the profile it's named by when its credential is still known. */
export type AccountUsageRow = UsageCategory & { profile?: ResolvedProfile };

/**
 * The Breakdown's accounts, each named by its profile when its auth index finds one, with its avatar, as everywhere
 * else an account is named. A credential that's gone, or requests that carried no index, keep what the core called
 * them, hidden like any email while Hide email addresses is on.
 */
export function accountUsageRows(accounts: UsageAccountCategory[], profiles: ReadonlyMap<string, ResolvedProfile>, shown: ShownIdentity): AccountUsageRow[] {
  return accounts.map(({ authIndex, label, requests, failures, tokens }) => {
    // Trimmed as the files' indexes are (profilesByAuthIndex), as the Requests grid looks them up.
    const profile = authIndex ? profiles.get(normalizeAuthIndex(authIndex)) : undefined;
    const row: AccountUsageRow = {
      // Indexes and sources are told apart, so an index can never be taken for a source of the same text.
      key: authIndex ? `index:${authIndex}` : `source:${label}`,
      label: profile ? profile.name : shown(label, { fileName: label }),
      requests,
      failures,
      tokens,
    };
    if (profile) row.profile = profile;
    return row;
  });
}

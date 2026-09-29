import { useMemo } from 'react';
import { profilesByAuthIndex, useAccountProfiles, type ResolvedProfile } from '../services/accountProfiles';
import { useAccountsStore } from '../services/accountsStore';

/**
 * Each account's profile by the auth index its requests carry, for what's recorded per request (Usage › Requests, the
 * Breakdown's accounts). Paused and turned-off accounts too, as their earlier requests are still there.
 */
export function useAccountsByAuthIndex(): Map<string, ResolvedProfile> {
  const { files, disabled } = useAccountsStore();
  const profiles = useAccountProfiles();
  return useMemo(() => profilesByAuthIndex([...files, ...disabled], profiles), [files, disabled, profiles]);
}

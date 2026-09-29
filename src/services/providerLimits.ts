import { formatDuration } from '../lib/format';
import {
  buildHeadline, headlinePace, resolveHeadlineWindow, staleLimits, windowLabels,
  type AccountLike, type Headline, type Pace, type StaleLimits,
} from './accountLimits';
import { resolveAccountProfile, type AccountProfile } from './accountProfiles';
import { sortByOrder, type AccountOrder } from './accountOrder';
import { fileName, idleQuota, providerForFile, quotaKey, type AuthFile, type QuotaProvider, type QuotaState } from './quotaService';

export type LimitAccount = AccountLike & { key: string };
/**
 * One pooled figure per provider, shared by the sidebar, the tray menu and notifications. `stale` is set while
 * the figure includes limits from an earlier check because the latest failed; automation reads the limits of
 * `freshQuotas`, where it never is.
 */
export type ProviderLimit = {
  provider: QuotaProvider;
  headline: Headline;
  pace: Pace;
  loading: boolean;
  stale: StaleLimits | null;
  accounts: LimitAccount[];
};

export const providerOrder: QuotaProvider[] = ['claude', 'codex', 'antigravity', 'xai', 'kimi'];
export const providerLabel: Record<QuotaProvider, string> = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi', xai: 'xAI', antigravity: 'Antigravity' };

export function providerLimits(
  files: AuthFile[],
  quotas: Record<string, QuotaState>,
  profiles: Record<string, AccountProfile | undefined>,
  prefs: { hidden: Record<string, string[]>; headline: Record<string, string> },
  nowMs = Date.now(),
  order: AccountOrder = {},
): ProviderLimit[] {
  const groups = new Map<QuotaProvider, LimitAccount[]>();
  files.forEach((file) => {
    const provider = providerForFile(file);
    if (!provider) return;
    const key = quotaKey(file);
    const items = groups.get(provider) ?? [];
    items.push({ key, name: resolveAccountProfile(key, fileName(file), profiles[key]).name, quota: quotas[key] ?? idleQuota() });
    groups.set(provider, items);
  });
  return providerOrder.flatMap((provider) => {
    const listed = groups.get(provider);
    if (!listed) return [];
    const accounts = sortByOrder(listed, order[provider], (account) => account.key);
    const labels = windowLabels(accounts);
    const hiddenLabels = prefs.hidden[provider] ?? [];
    const label = resolveHeadlineWindow(provider, labels.filter((item) => !hiddenLabels.includes(item)), prefs.headline[provider]);
    const headline = buildHeadline(accounts, label);
    return [{
      provider,
      headline,
      pace: headlinePace(headline, nowMs),
      loading: accounts.some((account) => account.quota.status === 'loading'),
      stale: staleLimits(headline),
      accounts,
    }];
  });
}

/** Short "3h 12m" style countdown to a reset instant; empty when unknown or already passed. */
export function formatResetCountdown(resetAtMs: number | undefined, nowMs = Date.now()): string {
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs)) return '';
  const delta = resetAtMs - nowMs;
  return delta > 0 ? formatDuration(delta, 'up') : '';
}

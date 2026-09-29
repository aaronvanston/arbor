import { freshRows, windowDurationMs } from './accountLimits';
import type { ProviderLimit } from './providerLimits';
import type { QuotaProvider } from './quotaService';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How close to its reset a window has to be before what's left of it counts as going unused. */
export const EXPIRING_WITHIN_MS = DAY;
/** How much of the window has to be left for it to be worth mentioning. */
export const EXPIRING_MIN_PERCENT = 30;
/** Reset times computed from a countdown drift a little between refreshes; a new window moves by days. */
const SAME_RESET_TOLERANCE_MS = HOUR;

/** An account whose long limit resets soon with a good share of it still unused. */
export type ExpiringCapacity = { provider: QuotaProvider; key: string; name: string; window: string; percent: number; resetAtMs: number };

/**
 * Accounts that will reset with capacity left over: at least 30% of the
 * provider's headline window left, a day or less before it resets. Windows
 * shorter than a day (the 5-hour limits) reset too often for this to matter.
 */
export function expiringCapacity(limits: ProviderLimit[], nowMs: number): ExpiringCapacity[] {
  return limits.flatMap((limit) => {
    const window = limit.headline.label;
    if (!window) return [];
    const durationMs = windowDurationMs(window);
    if (durationMs === null || durationMs < DAY) return [];
    return limit.accounts.flatMap((account) => {
      if (account.quota.status !== 'success') return [];
      const row = freshRows(account.quota).find((item) => item.label === window);
      const percent = row?.remainingPercent ?? null;
      const resetAtMs = row?.resetAtMs;
      if (percent === null || resetAtMs === undefined || percent < EXPIRING_MIN_PERCENT) return [];
      const leftMs = resetAtMs - nowMs;
      if (leftMs <= 0 || leftMs > EXPIRING_WITHIN_MS) return [];
      return [{ provider: limit.provider, key: account.key, name: account.name, window, percent, resetAtMs }];
    });
  });
}

const notifiedKey = (item: Pick<ExpiringCapacity, 'key' | 'window'>) => `${item.key}::${item.window}`;

/**
 * Picks the accounts to notify about. `notified` maps each account and window
 * already mentioned to the reset it was mentioned for, so every window is
 * mentioned once before each reset. Entries are dropped a day after their
 * reset has passed.
 */
export function nextExpiringNotifications(notified: Record<string, number>, items: ExpiringCapacity[], nowMs: number) {
  const next = Object.fromEntries(Object.entries(notified).filter(([, resetAtMs]) => resetAtMs > nowMs - DAY));
  const fresh = items.filter((item) => {
    const previous = next[notifiedKey(item)];
    if (previous !== undefined && Math.abs(previous - item.resetAtMs) <= SAME_RESET_TOLERANCE_MS) return false;
    next[notifiedKey(item)] = item.resetAtMs;
    return true;
  });
  const changed = fresh.length > 0 || Object.keys(next).length !== Object.keys(notified).length;
  return { notified: next, fresh, changed };
}

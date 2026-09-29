import { canResetClaudeQuota, canResetCodexQuota, resetUnconfirmed } from './quotaActions';
import type { AuthFile, QuotaState } from './quotaService';

/** An account at a limit that a reset can refill now, with what ran out when it is known. */
export type ResetReady = { provider: 'claude'; limit?: string } | { provider: 'codex'; limit: string };

/**
 * Whether an account deserves a "reset ready" notification: it is at a limit
 * and a reset can refill it now. A Claude reset that would be spent early
 * doesn't count, and neither do Codex resets banked while the main limits still
 * have headroom.
 */
export function resetReadyFor(file: AuthFile, quota: QuotaState): ResetReady | null {
  if (canResetClaudeQuota(file, quota)) {
    return quota.bankedReset?.earlyUse === undefined ? { provider: 'claude', limit: quota.bankedReset?.refills } : null;
  }
  if (canResetCodexQuota(file, quota)) {
    const spent = quota.rows.find((row) => !row.extra && row.remainingPercent !== null && row.remainingPercent <= 0);
    return spent ? { provider: 'codex', limit: spent.label } : null;
  }
  return null;
}

export type ResetReadyAccount = { key: string; file: AuthFile; quota: QuotaState | undefined };

/**
 * Picks the accounts that just became ready. `notified` holds the accounts
 * already told about, so each stretch at a limit notifies once. An account
 * mid-refresh, or whose last reset is still unconfirmed, keeps its entry until
 * its limits are known again. With `prune`, entries for accounts no longer
 * listed are dropped; leave it off until the account list has loaded.
 */
export function nextResetNotifications(notified: Record<string, true>, accounts: ResetReadyAccount[], prune: boolean) {
  const next: Record<string, true> = {};
  const ready: (ResetReady & { key: string; file: AuthFile })[] = [];
  const listed = new Set<string>();
  accounts.forEach(({ key, file, quota }) => {
    listed.add(key);
    if (!quota || quota.status !== 'success' || resetUnconfirmed(quota)) {
      if (notified[key]) next[key] = true;
      return;
    }
    const readiness = resetReadyFor(file, quota);
    if (!readiness) return;
    next[key] = true;
    if (!notified[key]) ready.push({ ...readiness, key, file });
  });
  if (!prune) {
    Object.keys(notified).forEach((key) => {
      if (!listed.has(key)) next[key] = true;
    });
  }
  const keys = Object.keys(next);
  const changed = keys.length !== Object.keys(notified).length || keys.some((key) => !notified[key]);
  return { notified: next, ready, changed };
}

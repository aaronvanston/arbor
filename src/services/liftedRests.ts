import { freshRows } from './accountLimits';
import { limitRestsEndAt, type AuthFileRecord } from './authFiles';
import type { QuotaState } from './quotaService';

/*
 * The core rests an account until the reset time it saw when the account hit its limit. A limit refilled sooner (a
 * reset used anywhere, a window that ended early) leaves the account resting with limit left, so nothing is routed to
 * it. This finds those rests, for the core to be told to drop them.
 */

/** A window with less than this left is out: a reading of 1% is what an account at its limit often shows. */
export const LIFTED_MIN_PERCENT = 2;
/** How long an account is remembered as having run out. No window is longer than a week. */
const SEEN_OUT_KEPT_MS = 8 * 86_400_000;

export type RestedAccount = { key: string; file: AuthFileRecord; quota: QuotaState | undefined };

/** Whether an account's limits read `out` (a window has run out) or `left`; null when nothing is known. Extra limits don't count. */
function limitState(quota: QuotaState | undefined): 'out' | 'left' | null {
  if (!quota || quota.status !== 'success') return null;
  const left = freshRows(quota).flatMap((row) => (!row.extra && row.remainingPercent !== null ? [row.remainingPercent] : []));
  if (!left.length) return null;
  return left.some((percent) => percent < LIFTED_MIN_PERCENT) ? 'out' : 'left';
}

/**
 * The accounts the core is resting for a limit that has since been refilled: seen with a window out, and now with
 * some left on every limit read while a rest for a limit still runs. `seenOut` holds when each account was last seen
 * out, by account key, and comes back to pass in next time. Only an account seen out is ever named, and once for each
 * time: a rest on an account whose limits never read out is one the provider knows more about than the readings do,
 * and it stays.
 */
export function liftedRests(
  accounts: RestedAccount[],
  listedAt: { receivedAtMs: number; observedAt?: string },
  seenOut: Record<string, number>,
  nowMs: number,
): { lifted: RestedAccount[]; seenOut: Record<string, number> } {
  const next: Record<string, number> = {};
  const lifted = accounts.filter((account) => {
    const state = limitState(account.quota);
    if (state === 'out') {
      next[account.key] = nowMs;
      return false;
    }
    const outAtMs = seenOut[account.key];
    if (outAtMs === undefined || nowMs - outAtMs > SEEN_OUT_KEPT_MS) return false;
    // A listing from before the rest began says nothing yet, so the account stays remembered until one shows it.
    const resting = state === 'left' && listedAt.receivedAtMs > 0
      && limitRestsEndAt(account.file, listedAt.receivedAtMs, listedAt.observedAt).some((endsAtMs) => endsAtMs > nowMs);
    if (!resting) next[account.key] = outAtMs;
    return resting;
  });
  return { lifted, seenOut: next };
}

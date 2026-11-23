import { canResetClaudeQuota, canResetCodexQuota, resetUnconfirmed } from './quotaActions';
import { providerForFile, type AuthFile, type ClaudeResetKind, type QuotaState } from './quotaService';

/**
 * An account at a limit that a reset can refill now, with what ran out when it is known. A Claude one names the kind
 * of reset, and `givesBackOnly` when it frees up only what Fable used on the limit the account is at.
 */
export type ResetReady =
  | { provider: 'claude'; reset: ClaudeResetKind; limit?: string; givesBackOnly?: true }
  | { provider: 'codex'; limit: string };

/**
 * Whether an account deserves a "reset ready" notification: it is at a limit
 * and a reset can refill it now. A Claude reset that would be spent early
 * doesn't count, and neither do Codex resets banked while the main limits still
 * have headroom. With `kind`, only that kind of Claude reset counts.
 */
export function resetReadyFor(file: AuthFile, quota: QuotaState, kind?: ClaudeResetKind): ResetReady | null {
  if (canResetClaudeQuota(file, quota)) {
    // The kinds come best first, so this is the reset made for the limit the account is at.
    const offer = quota.bankedReset?.kinds.find((item) =>
      item.grantId !== undefined && item.earlyUse === undefined && (kind === undefined || item.kind === kind));
    if (!offer) return null;
    return {
      provider: 'claude', reset: offer.kind, limit: offer.refills,
      ...(offer.givesBackOnly ? { givesBackOnly: true as const } : {}),
    };
  }
  if (canResetCodexQuota(file, quota)) {
    const spent = codexMainLimits(quota).find((row) => row.remainingPercent <= 0);
    return spent ? { provider: 'codex', limit: spent.label } : null;
  }
  return null;
}

/** The limits a Codex manual reset refills, with what's left of each known. Extra limits aren't refilled. */
const codexMainLimits = (quota: QuotaState) => quota.rows.flatMap((row) =>
  !row.extra && row.remainingPercent !== null ? [{ label: row.label, remainingPercent: row.remainingPercent }] : []);

/**
 * Whether a Codex manual reset would be spent early: none of the limits it refills has run out. Names the one closest
 * to running out, as Claude's banked resets do, or null when one has run out or nothing is known.
 */
export function codexResetEarlyUse(quota: QuotaState): { limit: string; percentLeft: number } | null {
  const limits = codexMainLimits(quota);
  if (!limits.length || limits.some((row) => row.remainingPercent <= 0)) return null;
  const closest = limits.reduce((least, row) => (row.remainingPercent < least.remainingPercent ? row : least));
  return { limit: closest.label, percentLeft: Math.round(closest.remainingPercent) };
}

export type ResetReadyAccount = { key: string; file: AuthFile; quota: QuotaState | undefined };

/** The limits a ready account is out of, among those its reset refills: what another account needs room on. */
function limitsOut(quota: QuotaState, readiness: ResetReady): string[] {
  const refills = readiness.provider === 'codex' ? [readiness.limit]
    : quota.bankedReset?.kinds.find((offer) => offer.kind === readiness.reset)?.windows ?? (readiness.limit ? [readiness.limit] : []);
  const out = quota.rows.filter((row) => refills.includes(row.label) && row.remainingPercent !== null && row.remainingPercent <= 0).map((row) => row.label);
  return out.length ? out : refills;
}

/** Whether an account can take work on every one of `limits`: the proxy moves there before a reset is needed. */
const hasRoom = (quota: QuotaState | undefined, limits: string[]) => quota?.status === 'success' && limits.length > 0
  && limits.every((label) => quota.rows.some((row) => row.label === label && (row.remainingPercent ?? 0) > 0));

/**
 * Picks the accounts that just became ready. `notified` holds the accounts
 * already told about, so each stretch at a limit notifies once. An account
 * mid-refresh, or whose last reset is still unconfirmed, keeps its entry until
 * its limits are known again. With `prune`, entries for accounts no longer
 * listed are dropped; leave it off until the account list has loaded.
 *
 * `accounts` are the ones in use. One at a limit isn't ready while another of
 * its provider still has room on that limit: the proxy moves there, and a reset
 * used now would refill capacity the others would have covered. It's told
 * about once the rest of the pool is out too.
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
    const provider = providerForFile(file);
    const limits = limitsOut(quota, readiness);
    if (accounts.some((other) => other.key !== key && providerForFile(other.file) === provider && hasRoom(other.quota, limits))) return;
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

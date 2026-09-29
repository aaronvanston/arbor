import { invokeCommand } from '../native/commands';
import { rowWindowMs } from './accountLimits';
import type { QuotaRow } from './quotaService';
import type { LimitCycle, UsageSession, UsageSessionPage } from '../native/types';

/**
 * "What used this limit?": the sessions whose requests went through an account during one of its limit
 * windows. A window that resets at R ran from R minus its length, so the requests the core recorded
 * for the account's credential in that span are what used it, as far as Arbor can see.
 */

/** Which requests use up a window: all of the account's, or only one model family's, like "opus". */
export type LimitScope = { durationMs: number; modelFamily: string | null };

/** Windows for use Arbor never sees: another product's (Cowork, third-party apps). */
const UNSEEN_WINDOW = /\b(oauth|cowork)\b/i;
/** A window named after a model family only counts that family's requests, like Claude's weekly Opus limit. */
const MODEL_FAMILY = /\b(opus|sonnet|fable|haiku)\b/i;

/** Null when Arbor can't tell what used the window: a limit outside the main one, or one it can't time. */
export function limitScope(row: Pick<QuotaRow, 'label' | 'extra' | 'windowMs'>): LimitScope | null {
  if (row.extra || UNSEEN_WINDOW.test(row.label)) return null;
  const durationMs = rowWindowMs(row);
  if (!durationMs) return null;
  return { durationMs, modelFamily: MODEL_FAMILY.exec(row.label)?.[1]?.toLowerCase() ?? null };
}

export type LimitSpan = { startMs: number; endMs: number; resetAtMs: number };

/** The span of a window resetting at `resetAtMs`: from one window length before, to the reset or now, whichever is first. */
export const limitSpan = (resetAtMs: number, durationMs: number, nowMs: number): LimitSpan => ({
  startMs: resetAtMs - durationMs,
  endMs: Math.min(nowMs, resetAtMs),
  resetAtMs,
});

/** Readings with reset times this close are the same window, as in the capacity report. */
const SAME_RESET_MS = 3_600_000;

export type LimitWindowOption = {
  key: string;
  /** The credential the window's requests were sent with. */
  authIndex: string;
  span: LimitSpan;
  /** How much of the limit was used: now, for the running window; at most, for an earlier one. */
  usedPercent: number | null;
  current: boolean;
};

const usedFrom = (remaining: number | null) => (remaining === null ? null : Math.max(0, Math.min(100, 100 - remaining)));

/**
 * The windows the dialog offers, newest first: the running one, from the account's latest refresh,
 * then earlier ones from the limit history.
 */
export function limitWindowOptions(
  row: Pick<QuotaRow, 'remainingPercent' | 'resetAtMs'>,
  authIndex: string,
  cycles: LimitCycle[],
  durationMs: number,
  nowMs: number,
): LimitWindowOption[] {
  const options: LimitWindowOption[] = [];
  if (row.resetAtMs !== undefined && row.resetAtMs > nowMs) {
    options.push({ key: 'current', authIndex, span: limitSpan(row.resetAtMs, durationMs, nowMs), usedPercent: usedFrom(row.remainingPercent), current: true });
  }
  [...cycles].sort((left, right) => right.resetAtMs - left.resetAtMs).forEach((cycle) => {
    if (options.some((option) => Math.abs(option.span.resetAtMs - cycle.resetAtMs) <= SAME_RESET_MS)) return;
    const running = options.find((option) => option.current);
    // Without a fresh refresh, the history may be all that knows about the running window.
    const current = !running && cycle.resetAtMs > nowMs;
    const span = limitSpan(cycle.resetAtMs, durationMs, nowMs);
    // A window reset early (with a banked reset, say) was over by the time the running one started.
    if (running && span.endMs > running.span.startMs) span.endMs = Math.max(span.startMs, running.span.startMs);
    options.push({ key: String(cycle.resetAtMs), authIndex: cycle.authIndex || authIndex, span, usedPercent: usedFrom(cycle.minRemainingPercent), current });
  });
  return options;
}

export type SessionShare = { session: UsageSession; share: number };

export type LimitUsage = {
  sessions: SessionShare[];
  /** What shares are of: API-price cost, or tokens when none of the requests have a price. */
  measure: 'cost' | 'tokens';
  /** The sessions beyond the ones listed, and their share together. */
  rest: { sessions: number; share: number };
};

/**
 * Each listed session's share of the window's use. Providers weigh a request by its model and tokens
 * much as their API prices do, so cost is the fairer measure; raw tokens are mostly cache reads.
 */
export function limitUsage(page: UsageSessionPage, shown: number): LimitUsage {
  const measure = page.summary.estimatedCost > 0 ? 'cost' : 'tokens';
  const total = measure === 'cost' ? page.summary.estimatedCost : page.summary.totalTokens;
  const sessions = page.items.slice(0, shown).map((session) => ({
    session,
    share: total > 0 ? (measure === 'cost' ? session.estimatedCost : session.totalTokens) / total : 0,
  }));
  const listed = sessions.reduce((sum, item) => sum + item.share, 0);
  return {
    sessions,
    measure,
    rest: { sessions: Math.max(0, page.summary.sessions - sessions.length), share: Math.max(0, 1 - listed) },
  };
}

export const loadLimitCycles = (account: string, window: string) =>
  invokeCommand('get_limit_cycles', { account, window });

export const loadLimitSessions = (authIndex: string, startMs: number, endMs: number, modelFamily: LimitScope['modelFamily']) =>
  invokeCommand('get_usage_sessions', {
    query: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      auth_index: authIndex,
      model_family: modelFamily ?? undefined,
      sort: 'cost',
      page_size: 20,
    },
  });

import type { QuotaProvider, QuotaRow, QuotaState } from './quotaService';
import { savedStore, sharedStore, storedRecord } from './savedStore';

export type AccountLike = { name: string; quota: QuotaState };
/** `off`: the account is turned off, so the bar grays it out. */
export type StackedSegment = { account: AccountLike; row: QuotaRow | null; percent: number | null; width: number; off?: boolean };
export type Headline = {
  label: string | null;
  /** Average left across the accounts that report the window; null when none does. */
  percent: number | null;
  segments: StackedSegment[];
  /** Accounts with a reading of the window, and all of them. */
  reporting: number;
  total: number;
  /** Turned-off accounts among them: counted in `percent`, never in the pace or the next reset. */
  off: number;
  /** The soonest reset that restores something: a reporting account in use below 100%. */
  nextResetMs?: number;
  nextResetFallback?: string;
};
export type CapWarning = { account: AccountLike; row: QuotaRow; headline: string };

/** Each provider's hidden window labels. */
function parseHidden(raw: string | null): Record<string, string[]> {
  const hidden: Record<string, string[]> = {};
  for (const [provider, labels] of Object.entries(storedRecord(raw))) {
    if (Array.isArray(labels)) hidden[provider] = labels.filter((label): label is string => typeof label === 'string');
  }
  return hidden;
}

/** Each provider's headline window label. */
const parseHeadline = (raw: string | null): Record<string, string> =>
  Object.fromEntries(Object.entries(storedRecord(raw)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

const hiddenWindows = savedStore({ key: 'arbor.accounts.hidden-windows.v1', parse: parseHidden, fallback: {} });
const headlineWindows = savedStore({ key: 'arbor.accounts.headline-window.v1', parse: parseHeadline, fallback: {} });

type LimitPrefs = { hidden: Record<string, string[]>; headline: Record<string, string> };
/** Both kept apart as they always were, and handed out together so a page reads one value. */
const prefs = sharedStore<LimitPrefs>({ hidden: hiddenWindows.get(), headline: headlineWindows.get() });
export const useAccountLimitPrefs = prefs.useValue;
export const getAccountLimitPrefs = prefs.get;
export function setHeadlineWindow(provider: string, label: string) {
  const headline = { ...headlineWindows.get(), [provider]: label };
  headlineWindows.set(headline);
  prefs.set({ ...prefs.get(), headline });
}
export function toggleHiddenWindow(provider: string, label: string) {
  const list = hiddenWindows.get()[provider] ?? [];
  const hidden = { ...hiddenWindows.get(), [provider]: list.includes(label) ? list.filter((item) => item !== label) : [...list, label] };
  hiddenWindows.set(hidden);
  prefs.set({ ...prefs.get(), hidden });
}

/** Whether the rows are held over from an earlier check because the latest one failed. */
export const isStaleQuota = (quota: QuotaState): boolean => quota.staleSinceMs !== undefined && quota.rows.length > 0;

/**
 * Rows that can be shown: fresh results, the retained previous results while a refresh is in flight, or the last
 * good results after a failed check, which the page marks as stale.
 */
export const displayRows = (quota: QuotaState): QuotaRow[] =>
  quota.status === 'success' || quota.status === 'loading' || isStaleQuota(quota) ? quota.rows : [];

/** Rows automation may act on (pauses, alerts, routing, history): never ones held over after a failed check. */
export const freshRows = (quota: QuotaState): QuotaRow[] => (isStaleQuota(quota) ? [] : displayRows(quota));

/** The cache as automation should see it: a stale account reads like one whose check failed. */
export function freshQuotas(quotas: Record<string, QuotaState>): Record<string, QuotaState> {
  if (!Object.values(quotas).some(isStaleQuota)) return quotas;
  return Object.fromEntries(Object.entries(quotas).map(([key, quota]) => [
    key,
    isStaleQuota(quota) ? { ...quota, rows: [], staleSinceMs: undefined } : quota,
  ]));
}

/**
 * How many accounts feed a headline figure with stale limits and whether that's all it covers, when the oldest was
 * read, when the latest of them started failing, and an error.
 */
export type StaleLimits = { accounts: number; all: boolean; asOfMs: number; latestSinceMs: number; error: string };

/**
 * Stale limits behind a headline figure. Only accounts whose headline window is held over count: one whose kept
 * rows the headline leaves out doesn't make the figure any older.
 */
export function staleLimits(headline: Headline): StaleLimits | null {
  const stale = headline.segments.filter((segment) => segment.row !== null && isStaleQuota(segment.account.quota)).map((segment) => segment.account);
  if (!stale.length) return null;
  const asOfMs = Math.min(...stale.map((account) => account.quota.fetchedAt ?? account.quota.staleSinceMs!));
  return {
    accounts: stale.length,
    all: stale.length === headline.reporting,
    asOfMs,
    latestSinceMs: Math.max(...stale.map((account) => account.quota.staleSinceMs!)),
    error: stale.find((account) => account.quota.error)?.quota.error ?? '',
  };
}

/** The note for stale limits, with `count` and `time`: just the time when every account the figure covers is stale. */
export const staleNoteKey = (stale: StaleLimits) =>
  stale.all ? 'accounts.stale.asOf' as const : stale.accounts === 1 ? 'accounts.headline.stale.one' as const : 'accounts.headline.stale.other' as const;

/** Every distinct window label reported by any account, in first-seen order. */
export function windowLabels(accounts: AccountLike[]): string[] {
  const seen = new Set<string>();
  accounts.forEach((account) => {
    displayRows(account.quota).forEach((row) => seen.add(row.label));
  });
  return [...seen];
}

/**
 * The window labels some account reports a share left for: the windows the Windows menu offers. A row with nothing to
 * measure (an xAI paid API account's note) isn't a window to pick or hide.
 */
export function meteredWindowLabels(accounts: AccountLike[]): string[] {
  const metered = new Set<string>();
  accounts.forEach((account) => {
    displayRows(account.quota).forEach((row) => { if (row.remainingPercent !== null) metered.add(row.label); });
  });
  return windowLabels(accounts).filter((label) => metered.has(label));
}

/** Most windows side by side in an account's grid; more wrap onto the next line. */
const WINDOWS_PER_LINE = 3;

/**
 * Where an account's windows sit in its grid: a column each for the provider's windows being shown, up to three to a
 * line, so one window spans the row and the same window lines up across the provider's accounts. Positions are 1-based.
 */
export function windowGrid(columns: string[]) {
  const perLine = Math.min(Math.max(columns.length, 1), WINDOWS_PER_LINE);
  return {
    perLine,
    place(label: string): { column: number; row: number } | null {
      const index = columns.indexOf(label);
      return index < 0 ? null : { column: (index % perLine) + 1, row: Math.floor(index / perLine) + 1 };
    },
  };
}

const preferred: Record<QuotaProvider, RegExp[]> = {
  claude: [/fable/i, /7-day window/i, /^7-day/i],
  codex: [/^weekly limit$/i, /weekly/i, /^5-hour limit$/i],
  antigravity: [],
  xai: [/weekly/i],
  kimi: [/weekly/i],
};

/** Picks the window that best represents the account's real ceiling for the provider. */
export function defaultHeadlineWindow(provider: QuotaProvider, labels: string[]): string | null {
  for (const pattern of preferred[provider]) {
    const match = labels.find((label) => pattern.test(label));
    if (match) return match;
  }
  return labels[0] ?? null;
}

export function resolveHeadlineWindow(provider: QuotaProvider, labels: string[], chosen: string | undefined): string | null {
  if (chosen && labels.includes(chosen)) return chosen;
  return defaultHeadlineWindow(provider, labels);
}

const rowFor = (account: AccountLike, label: string | null): QuotaRow | null =>
  label === null ? null : displayRows(account.quota).find((row) => row.label === label) ?? null;

/**
 * Stacks every account's remaining share of the headline window left to right on a 0–100 bar.
 * Each account owns an equal slice of the bar. The percent averages only the accounts that
 * report the window: one that errored or hasn't loaded is unknown, not empty.
 * Turned-off accounts (`off`) join the bar and the percent once they have a reading, marked so the bar grays them
 * out; one without a reading is left out, since there's nothing of it to show.
 */
export function buildHeadline(accounts: AccountLike[], label: string | null, off: AccountLike[] = []): Headline {
  const offRead = off.filter((account) => (rowFor(account, label)?.remainingPercent ?? null) !== null);
  const slice = accounts.length + offRead.length ? 100 / (accounts.length + offRead.length) : 0;
  let nextResetMs: number | undefined;
  let nextResetFallback: string | undefined;
  const segment = (account: AccountLike, isOff: boolean): StackedSegment => {
    const row = rowFor(account, label);
    const percent = row?.remainingPercent ?? null;
    // A full window's reset restores nothing, so it isn't the next refill; nor is one the proxy can't use.
    const refills = !isOff && percent !== null && percent < 100;
    if (refills && row?.resetAtMs !== undefined && (nextResetMs === undefined || row.resetAtMs < nextResetMs)) {
      nextResetMs = row.resetAtMs;
      nextResetFallback = row.reset;
    } else if (refills && nextResetMs === undefined && !nextResetFallback && row?.reset) {
      nextResetFallback = row.reset;
    }
    const width = percent === null ? 0 : (Math.max(0, Math.min(100, percent)) * slice) / 100;
    return isOff ? { account, row, percent, width, off: true } : { account, row, percent, width };
  };
  const segments = [...accounts.map((account) => segment(account, false)), ...offRead.map((account) => segment(account, true))];
  const known = segments.filter((item) => item.percent !== null);
  const percent = known.length ? known.reduce((sum, item) => sum + (item.percent ?? 0), 0) / known.length : null;
  return { label, percent, segments, reporting: known.length, total: segments.length, off: offRead.length, nextResetMs, nextResetFallback };
}

/** A headline figure that leaves some accounts out, so it should say how many it covers. */
export const partialHeadline = (headline: Headline) => headline.percent !== null && headline.reporting < headline.total;

/** Average remaining percent across accounts for one window label, or null when no account reports it. */
export function pooledPercent(accounts: AccountLike[], label: string): number | null {
  const values = accounts.map((account) => rowFor(account, label)?.remainingPercent ?? null).filter((value): value is number => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export const CAP_WARNING_THRESHOLD = 25;

/**
 * Windows other than the headline that are closer to empty than the headline and under the threshold,
 * because they will block requests before the headline limit is reached.
 */
export function capWarnings(accounts: AccountLike[], headline: string | null, hidden: string[]): CapWarning[] {
  if (!headline) return [];
  const warnings: CapWarning[] = [];
  accounts.forEach((account) => {
    const main = rowFor(account, headline);
    const mainPercent = main?.remainingPercent ?? null;
    if (mainPercent === null) return;
    displayRows(account.quota).forEach((row) => {
      if (row.label === headline || hidden.includes(row.label) || row.remainingPercent === null) return;
      if (row.remainingPercent < mainPercent && row.remainingPercent <= CAP_WARNING_THRESHOLD) {
        warnings.push({ account, row, headline });
      }
    });
  });
  return warnings;
}

export type PaceTone = 'success' | 'warning' | 'error' | 'muted';
export type Pace = { tone: PaceTone; ratio: number | null; elapsed: number | null };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Window length inferred from the label the provider gave us; null when unknown. */
export function windowDurationMs(label: string): number | null {
  const lower = label.toLowerCase();
  const explicit = /(\d+(?:\.\d+)?)\s*[- ]?\s*(hour|hr|day|week|month)/.exec(lower);
  if (explicit) {
    const count = Number(explicit[1]);
    const unit = explicit[2]!;
    const size = unit.startsWith('hour') || unit.startsWith('hr') ? HOUR : unit.startsWith('day') ? DAY : unit.startsWith('week') ? 7 * DAY : 30 * DAY;
    return count * size;
  }
  if (/weekly/.test(lower)) return 7 * DAY;
  if (/monthly/.test(lower)) return 30 * DAY;
  if (/daily/.test(lower)) return DAY;
  return null;
}

/**
 * A row's window length: the one the provider gave (`windowMs`), else the one its label implies. Every pace reads
 * it from here, so the headline color, the sidebar and the even-pace tick agree.
 */
export const rowWindowMs = (row: Pick<QuotaRow, 'label' | 'windowMs'>): number | null =>
  row.windowMs !== undefined && Number.isFinite(row.windowMs) && row.windowMs > 0 ? row.windowMs : windowDurationMs(row.label);

export const PACE_WARNING_RATIO = 1.1;
export const PACE_ERROR_RATIO = 1.5;
const MIN_ELAPSED = 0.05;

/**
 * Compares how much of the window has been used against how much of the window has elapsed.
 * A ratio above 1 means usage is ahead of the clock and the limit will run out before it resets.
 */
export function usagePace(percentLeft: number | null, resetAtMs: number | undefined, durationMs: number | null, nowMs = Date.now()): Pace {
  if (percentLeft === null) return { tone: 'muted', ratio: null, elapsed: null };
  if (percentLeft <= 5) return { tone: 'error', ratio: null, elapsed: null };
  if (resetAtMs === undefined || durationMs === null || durationMs <= 0) {
    return { tone: percentLeft <= 10 ? 'error' : percentLeft <= 30 ? 'warning' : 'success', ratio: null, elapsed: null };
  }
  const remainingMs = Math.max(0, resetAtMs - nowMs);
  const elapsed = Math.max(MIN_ELAPSED, Math.min(1, 1 - remainingMs / durationMs));
  const used = Math.max(0, Math.min(1, 1 - percentLeft / 100));
  const ratio = used / elapsed;
  const tone: PaceTone = ratio >= PACE_ERROR_RATIO ? 'error' : ratio >= PACE_WARNING_RATIO ? 'warning' : 'success';
  return { tone, ratio, elapsed };
}

type PoolAccount = { left: number; resetAtMs: number; windowMs: number };

/**
 * Whether the pool runs dry before refills catch up, spending at `rate` (percent of one account per ms).
 * Spends the account that resets soonest first, as soonest-reset-first routing does, and refills each account to
 * 100% at its reset, out to one full window, after which every account has refilled at least once.
 */
function poolRunsOut(accounts: PoolAccount[], untimedLeft: number, rate: number, nowMs: number): boolean {
  if (rate <= 0) return false;
  const pool = accounts.map((account) => ({ ...account }));
  const horizon = nowMs + Math.max(...pool.map((account) => account.windowMs));
  let spare = untimedLeft;
  let time = nowMs;
  while (time < horizon) {
    pool.sort((a, b) => a.resetAtMs - b.resetAtMs);
    const next = pool[0];
    if (!next) return false;
    const until = Math.min(next.resetAtMs, horizon);
    let need = rate * (until - time);
    for (const account of pool) {
      const spent = Math.min(account.left, need);
      account.left -= spent;
      need -= spent;
      if (need <= 0) break;
    }
    if (need > 0) {
      const spent = Math.min(spare, need);
      spare -= spent;
      need -= spent;
    }
    if (need > 0) return true;
    time = until;
    next.left = 100;
    next.resetAtMs += next.windowMs;
  }
  return false;
}

/**
 * Pace for a pooled headline. The proxy moves to another account when one empties, so the pool only runs out when
 * the whole of it does: every account's average spend since its window began is added up and played forward
 * against what's left and each reset's refill. One nearly empty account doesn't make the pool critical.
 */
export function headlinePace(headline: Headline, nowMs = Date.now()): Pace {
  if (!headline.label || headline.percent === null) return { tone: 'muted', ratio: null, elapsed: null };
  const labelDuration = windowDurationMs(headline.label);
  const timed: PoolAccount[] = [];
  const untimed: number[] = [];
  let rate = 0;
  headline.segments.forEach((segment) => {
    // A turned-off account can't run anything out or be spent, and one paused at its cap would always read as empty.
    if (segment.percent === null || segment.off) return;
    const left = Math.max(0, Math.min(100, segment.percent));
    const resetAtMs = segment.row?.resetAtMs;
    const windowMs = segment.row ? rowWindowMs(segment.row) : labelDuration;
    if (resetAtMs === undefined || !Number.isFinite(resetAtMs) || resetAtMs <= nowMs || windowMs === null || windowMs <= 0) {
      untimed.push(left);
      return;
    }
    const elapsedMs = Math.max(MIN_ELAPSED * windowMs, Math.min(windowMs, windowMs - (resetAtMs - nowMs)));
    rate += (100 - left) / elapsedMs;
    timed.push({ left, resetAtMs, windowMs });
  });
  // With no account's reset known there's no clock to spend against, so the pooled figure gets plain thresholds.
  if (!timed.length) return usagePace(untimed.reduce((sum, value) => sum + value, 0) / untimed.length, undefined, null, nowMs);
  const untimedLeft = untimed.reduce((sum, value) => sum + value, 0);
  // The single-account thresholds in pool terms: a pool that would still run dry spent 1.5× slower is being spent
  // at least 1.5× faster than it can last.
  const tone: PaceTone = poolRunsOut(timed, untimedLeft, rate / PACE_ERROR_RATIO, nowMs)
    ? 'error'
    : poolRunsOut(timed, untimedLeft, rate / PACE_WARNING_RATIO, nowMs) ? 'warning' : 'success';
  return { tone, ratio: null, elapsed: null };
}

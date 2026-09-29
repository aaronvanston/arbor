import type { QuotaProvider, QuotaRow, QuotaState } from './quotaService';
import { savedStore, sharedStore, storedRecord } from './savedStore';

export type AccountLike = { name: string; quota: QuotaState };
export type StackedSegment = { account: AccountLike; row: QuotaRow | null; percent: number | null; width: number };
export type Headline = {
  label: string | null;
  /** Average left across the accounts that report the window; null when none does. */
  percent: number | null;
  segments: StackedSegment[];
  /** Accounts with a reading of the window, and all of them. */
  reporting: number;
  total: number;
  /** The soonest reset that restores something: a reporting account below 100%. */
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

const hiddenWindows = savedStore({ key: 'cpa-gui.accounts.hidden-windows.v1', parse: parseHidden, fallback: {} });
const headlineWindows = savedStore({ key: 'cpa-gui.accounts.headline-window.v1', parse: parseHeadline, fallback: {} });

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
 */
export function buildHeadline(accounts: AccountLike[], label: string | null): Headline {
  const slice = accounts.length ? 100 / accounts.length : 0;
  let nextResetMs: number | undefined;
  let nextResetFallback: string | undefined;
  const segments = accounts.map((account): StackedSegment => {
    const row = rowFor(account, label);
    const percent = row?.remainingPercent ?? null;
    // A full window's reset restores nothing, so it isn't the next refill.
    const refills = percent !== null && percent < 100;
    if (refills && row?.resetAtMs !== undefined && (nextResetMs === undefined || row.resetAtMs < nextResetMs)) {
      nextResetMs = row.resetAtMs;
      nextResetFallback = row.reset;
    } else if (refills && nextResetMs === undefined && !nextResetFallback && row?.reset) {
      nextResetFallback = row.reset;
    }
    return { account, row, percent, width: percent === null ? 0 : (Math.max(0, Math.min(100, percent)) * slice) / 100 };
  });
  const known = segments.filter((segment) => segment.percent !== null);
  const percent = known.length ? known.reduce((sum, segment) => sum + (segment.percent ?? 0), 0) / known.length : null;
  return { label, percent, segments, reporting: known.length, total: accounts.length, nextResetMs, nextResetFallback };
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

/** Pace for a pooled headline: the worst account decides the color. */
export function headlinePace(headline: Headline, nowMs = Date.now()): Pace {
  if (!headline.label || headline.percent === null) return { tone: 'muted', ratio: null, elapsed: null };
  const labelDuration = windowDurationMs(headline.label);
  const order: PaceTone[] = ['muted', 'success', 'warning', 'error'];
  let worst: Pace = { tone: 'muted', ratio: null, elapsed: null };
  headline.segments.forEach((segment) => {
    if (segment.percent === null) return;
    const pace = usagePace(segment.percent, segment.row?.resetAtMs, segment.row ? rowWindowMs(segment.row) : labelDuration, nowMs);
    if (order.indexOf(pace.tone) > order.indexOf(worst.tone)) worst = pace;
  });
  return worst;
}

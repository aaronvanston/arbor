import { describe, expect, test } from 'bun:test';
import { freshQuotas } from '../src/services/accountLimits';
import { formatResetCountdown, providerLimits } from '../src/services/providerLimits';
import { appendSample, pruneSamples, HISTORY_WINDOW_MS } from '../src/services/limitsHistory';
import { notificationKind, paceStep, staleHoldMs, staleHolds } from '../src/components/LimitsMonitor';
import { mergeQuotaResult } from '../src/services/quotaCache';
import { quotaKey, quotaRowsFor, type QuotaState } from '../src/services/quotaService';

const HOUR = 3_600_000;
const success = (rows: QuotaState['rows']): QuotaState => ({ status: 'success', rows });
const codexFile = (name: string) => ({ name, type: 'codex', provider: 'codex' });

describe('provider limits', () => {
  test('groups files per provider and picks the headline window', () => {
    const now = 1_000_000;
    const files = [codexFile('a.json'), codexFile('b.json')];
    const [a, b] = files as [typeof files[0], typeof files[0]];
    const quotas: Record<string, QuotaState> = {
      [quotaKey(a)]: success([{ label: '5-hour limit', remainingPercent: 90, resetAtMs: now + HOUR }, { label: 'Weekly limit', remainingPercent: 40, resetAtMs: now + 3 * 24 * HOUR }]),
      [quotaKey(b)]: success([{ label: '5-hour limit', remainingPercent: 10, resetAtMs: now + HOUR }, { label: 'Weekly limit', remainingPercent: 60, resetAtMs: now + 3 * 24 * HOUR }]),
    };
    const limits = providerLimits(files, quotas, {}, { hidden: {}, headline: {} }, now);
    expect(limits).toHaveLength(1);
    expect(limits[0]!.provider).toBe('codex');
    expect(limits[0]!.headline.label).toBe('Weekly limit');
    expect(limits[0]!.headline.percent).toBe(50);
    expect(limits[0]!.accounts.map((account) => account.name)).toEqual(['a', 'b']);
    const reordered = providerLimits(files, quotas, {}, { hidden: {}, headline: {} }, now, { codex: [quotaKey(b), quotaKey(a)] });
    expect(reordered[0]!.accounts.map((account) => account.name)).toEqual(['b', 'a']);
  });

  test('marks stale limits for showing, and leaves them out of what automation reads', () => {
    const now = 1_000_000;
    const files = [codexFile('a.json'), codexFile('b.json')];
    const [a, b] = files as [typeof files[0], typeof files[0]];
    const weekly = (left: number) => [{ label: 'Weekly limit', remainingPercent: left, resetAtMs: now + 3 * 24 * HOUR }];
    const quotas: Record<string, QuotaState> = {
      [quotaKey(a)]: success(weekly(50)),
      [quotaKey(b)]: { status: 'error', rows: weekly(4), error: 'Couldn’t reach chatgpt.com.', fetchedAt: now - HOUR, staleSinceMs: now - 10 * 60_000 },
    };
    const [shown] = providerLimits(files, quotas, {}, { hidden: {}, headline: {} }, now);
    expect(shown!.headline.percent).toBe(27);
    expect(shown!.stale).toEqual({ accounts: 1, all: false, asOfMs: now - HOUR, latestSinceMs: now - 10 * 60_000, error: 'Couldn’t reach chatgpt.com.' });
    // With the stale account nearly out the pool won't last; only the fresh one decides alerts, routing and history.
    expect(shown!.pace.tone).toBe('error');
    const [fresh] = providerLimits(files, freshQuotas(quotas), {}, { hidden: {}, headline: {} }, now);
    expect(fresh!.stale).toBeNull();
    expect(fresh!.headline.segments.map((segment) => segment.percent)).toEqual([50, null]);
    expect(fresh!.pace.tone).toBe('success');
  });

  test('stops marking a provider stale once an account whose checks keep failing no longer feeds its figure', () => {
    const start = Date.UTC(2030, 0, 1);
    const claudeFile = (name: string) => ({ name, type: 'claude', provider: 'claude' });
    const files = [claudeFile('broken.json'), claudeFile('fine.json')];
    const [broken, fine] = files as [typeof files[0], typeof files[0]];
    // Idle at its last good check, so the 5-hour window has no reset time; extra usage never has one.
    const rows = quotaRowsFor('claude', {
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: 40, resets_at: new Date(start + 3 * 24 * HOUR).toISOString() },
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1000 },
    });
    expect(rows.map((row) => [row.label, row.resetAtMs ?? null])).toEqual([
      ['5-hour window', null], ['7-day window', start + 3 * 24 * HOUR], ['Extra usage', null],
    ]);
    const good = (nowMs: number): QuotaState => ({ status: 'success', rows, fetchedAt: nowMs });
    const failed: QuotaState = { status: 'error', rows: [], error: 'HTTP 401' };
    let quotas: Record<string, QuotaState> = { [quotaKey(broken)]: good(start), [quotaKey(fine)]: good(start) };
    const at = (nowMs: number) => providerLimits(files, quotas, {}, { hidden: {}, headline: {} }, nowMs)[0]!;
    // An expired login fails every hour; the other account keeps reading.
    for (let hour = 1; hour <= 30 * 24; hour += 1) {
      const nowMs = start + hour * HOUR;
      quotas = { [quotaKey(broken)]: mergeQuotaResult(quotas[quotaKey(broken)], failed, nowMs), [quotaKey(fine)]: good(nowMs) };
      if (hour === 2) expect(at(nowMs).stale).toMatchObject({ accounts: 1, asOfMs: start, error: 'HTTP 401' });
    }
    const end = start + 30 * 24 * HOUR;
    expect(quotas[quotaKey(broken)]).toBe(failed);
    const limit = at(end);
    expect(limit.headline).toMatchObject({ label: '7-day window', reporting: 1, total: 2 });
    expect(limit.stale).toBeNull();
  });

  test('formats reset countdowns compactly', () => {
    const now = 0;
    expect(formatResetCountdown(undefined, now)).toBe('');
    expect(formatResetCountdown(-1, now)).toBe('');
    expect(formatResetCountdown(5 * 60_000, now)).toBe('5m');
    expect(formatResetCountdown(3 * HOUR + 12 * 60_000, now)).toBe('3h 12m');
    expect(formatResetCountdown(2 * 24 * HOUR + 5 * HOUR, now)).toBe('2d 5h');
  });
});

describe('limits history', () => {
  test('drops samples older than the window and collapses rapid repeats', () => {
    const now = 10 * HISTORY_WINDOW_MS;
    const samples = [{ t: now - HISTORY_WINDOW_MS - 1, percent: 90 }, { t: now - HOUR, percent: 80 }];
    expect(pruneSamples(samples, now)).toEqual([{ t: now - HOUR, percent: 80 }]);
    const appended = appendSample(samples, { t: now, percent: 70 });
    expect(appended).toEqual([{ t: now - HOUR, percent: 80 }, { t: now, percent: 70 }]);
    const collapsed = appendSample(appended, { t: now + 10_000, percent: 65 });
    expect(collapsed).toEqual([{ t: now - HOUR, percent: 80 }, { t: now + 10_000, percent: 65 }]);
    const unchanged = appendSample(collapsed, { t: now + 5 * 60_000, percent: 65 });
    expect(unchanged).toEqual(collapsed);
    const later = appendSample(collapsed, { t: now + 20 * 60_000, percent: 65 });
    expect(later).toHaveLength(3);
  });
});

describe('limit notifications', () => {
  test('fires once when crossing into amber or red and once on recovery', () => {
    expect(notificationKind(undefined, 'warning')).toBeNull();
    expect(notificationKind('success', 'warning')).toBe('warning');
    expect(notificationKind('warning', 'error')).toBe('error');
    expect(notificationKind('success', 'error')).toBe('error');
    expect(notificationKind('error', 'warning')).toBeNull();
    expect(notificationKind('warning', 'success')).toBe('recovered');
    expect(notificationKind('error', 'success')).toBe('recovered');
    expect(notificationKind('success', 'success')).toBeNull();
    expect(notificationKind('success', 'muted')).toBeNull();
  });

  test('keeps the pace from easing while held-over limits hold, but not from rising', () => {
    // Leaving the stale account out would read as back on track: the held-over limits still show it critical.
    expect(paceStep('error', 'error', 'success', 'error')).toEqual({ saved: 'error', kind: null });
    expect(paceStep('warning', 'warning', 'success', 'warning')).toEqual({ saved: 'warning', kind: null });
    expect(paceStep('error', 'error', 'warning', 'error')).toEqual({ saved: 'error', kind: null });
    // The accounts still read can make it worse, and without held-over limits it moves freely.
    expect(paceStep('success', 'success', 'error', 'success')).toEqual({ saved: 'error', kind: 'error' });
    expect(paceStep('warning', 'warning', 'error', 'warning')).toEqual({ saved: 'error', kind: 'error' });
    expect(paceStep(undefined, undefined, 'success', 'error')).toEqual({ saved: 'success', kind: null });
    expect(paceStep('error', 'error', 'success', null)).toEqual({ saved: 'success', kind: 'recovered' });
    expect(paceStep('error', 'error', 'error', null)).toEqual({ saved: 'error', kind: null });
    expect(paceStep('error', 'error', 'muted', 'error')).toEqual({ saved: 'error', kind: null });
    // When the held-over limits look as good, leaving them out isn't what eased it: a real recovery.
    expect(paceStep('error', 'error', 'success', 'success')).toEqual({ saved: 'success', kind: 'recovered' });
  });

  // money-13: turning an account off or on moves the pooled pace, but that's not a limit running down or recovering.
  test('settles quietly when the accounts counted change', () => {
    expect(paceStep('warning', 'warning', 'success', null, true)).toEqual({ saved: 'success', kind: null });
    expect(paceStep('success', 'success', 'error', null, true)).toEqual({ saved: 'error', kind: null });
    // The next look with the same accounts notifies as usual.
    expect(paceStep('success', 'success', 'error', null)).toEqual({ saved: 'error', kind: 'error' });
  });

  test('still notifies a new run on another account while the pace is held', () => {
    // Critical, then an account's checks fail and the others calm down: held at critical.
    let step = paceStep('error', 'error', 'success', 'error');
    expect(step).toEqual({ saved: 'error', kind: null });
    // Another account, still read, runs hot again: a new critical run, measured from where they were.
    step = paceStep(step.saved, 'success', 'error', 'error');
    expect(step).toEqual({ saved: 'error', kind: 'error' });
    // And ahead of pace, below the held level, still says so.
    expect(paceStep('error', 'success', 'warning', 'error')).toEqual({ saved: 'error', kind: 'warning' });
    // Once the hold ends, the level stands: no second alert for the same run when the account is read again.
    expect(paceStep('error', 'success', 'error', null)).toEqual({ saved: 'error', kind: null });
  });

  test('lets held-over limits hold for a check or two after the latest started failing', () => {
    const now = 10 * HOUR;
    const stale = { accounts: 1, all: false, asOfMs: now - 2 * HOUR, latestSinceMs: now - 20 * 60_000, error: 'HTTP 401' };
    expect(staleHoldMs(15)).toBe(30 * 60_000);
    expect(staleHoldMs(0)).toBe(30 * 60_000);
    expect(staleHoldMs(60)).toBe(2 * HOUR);
    expect(staleHolds(stale, now, staleHoldMs(15))).toBe(true);
    expect(staleHolds(stale, now, staleHoldMs(5))).toBe(false);
    expect(staleHolds(null, now, staleHoldMs(15))).toBe(false);
  });
});

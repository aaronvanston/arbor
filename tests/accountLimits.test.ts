import { describe, expect, test } from 'bun:test';
import {
  buildHeadline, capWarnings, defaultHeadlineWindow, displayRows, freshQuotas, freshRows, headlinePace, isStaleQuota, partialHeadline,
  pooledPercent, rowWindowMs, staleLimits, staleNoteKey, usagePace, windowDurationMs, windowGrid, windowLabels,
} from '../src/services/accountLimits';
import { evenPace } from '../src/services/limitPace';
import { quotaRowsFor, type QuotaState } from '../src/services/quotaService';

const success = (rows: QuotaState['rows']): QuotaState => ({ status: 'success', rows });
const claude = (name: string, fable: number, fiveHour: number) => ({
  name,
  quota: success([
    { label: '5-hour window', remainingPercent: fiveHour, resetAtMs: 1_000 },
    { label: '7-day window', remainingPercent: 50, resetAtMs: 5_000 },
    { label: '7-day Fable window', remainingPercent: fable, resetAtMs: 9_000 },
  ]),
});

describe('account limits', () => {
  test('prefers the Fable window for Claude and the weekly limit for Codex', () => {
    expect(defaultHeadlineWindow('claude', ['5-hour window', '7-day window', '7-day Fable window'])).toBe('7-day Fable window');
    expect(defaultHeadlineWindow('claude', ['5-hour window', '7-day window'])).toBe('7-day window');
    expect(defaultHeadlineWindow('codex', ['5-hour limit', 'Weekly limit', 'Code review Weekly limit'])).toBe('Weekly limit');
    expect(defaultHeadlineWindow('antigravity', ['Quota 1', 'Quota 2'])).toBe('Quota 1');
    expect(defaultHeadlineWindow('kimi', [])).toBeNull();
  });

  test('collects window labels in first-seen order and ignores unfetched accounts', () => {
    const accounts = [claude('a', 80, 70), { name: 'b', quota: { status: 'idle', rows: [] } as QuotaState }];
    expect(windowLabels(accounts)).toEqual(['5-hour window', '7-day window', '7-day Fable window']);
  });

  test('stacks equal slices so the filled width equals the pooled percent', () => {
    const headline = buildHeadline([claude('a', 80, 70), claude('b', 20, 90)], '7-day Fable window');
    expect(headline.percent).toBe(50);
    expect(headline.segments.map((segment) => segment.width)).toEqual([40, 10]);
    expect(headline.nextResetMs).toBe(9_000);
    expect([headline.reporting, headline.total]).toEqual([2, 2]);
    expect(partialHeadline(headline)).toBe(false);
  });

  // An account that errored or lacked the window is unknown, not empty: the average covers the accounts that report,
  // so it isn't read as 0% left and doesn't drag the pool down.
  test('averages only the accounts that report the window', () => {
    const noWindow = { name: 'b', quota: success([{ label: '5-hour window', remainingPercent: 10 }]) };
    const failed = { name: 'c', quota: { status: 'error', rows: [], error: 'HTTP 500' } as QuotaState };
    const headline = buildHeadline([claude('a', 60, 70), noWindow, failed], '7-day Fable window');
    expect(headline.percent).toBe(60);
    expect([headline.reporting, headline.total]).toEqual([1, 3]);
    expect(partialHeadline(headline)).toBe(true);
    expect(headline.segments.map((segment) => segment.percent)).toEqual([60, null, null]);
    // Each account keeps its slice of the bar; the unknown ones stay unfilled.
    expect(headline.segments.map((segment) => Math.round(segment.width))).toEqual([20, 0, 0]);
    expect(pooledPercent([claude('a', 60, 70)], '5-hour window')).toBe(70);
    const none = buildHeadline([noWindow, failed], '7-day Fable window');
    expect(none.percent).toBeNull();
    expect([none.reporting, none.total]).toEqual([0, 2]);
    // With no figure at all there is nothing to qualify.
    expect(partialHeadline(none)).toBe(false);
  });

  test('next refill is the soonest reset that restores something', () => {
    const at = (name: string, left: number | null, resetAtMs?: number, reset?: string) => ({
      name, quota: success([{ label: 'Weekly limit', remainingPercent: left, resetAtMs, reset }]),
    });
    // The full account resets first, but that restores nothing.
    const skipsFull = buildHeadline([at('a', 100, 1_000, 'soon'), at('b', 40, 5_000, 'later')], 'Weekly limit');
    expect(skipsFull.nextResetMs).toBe(5_000);
    expect(skipsFull.nextResetFallback).toBe('later');
    // An account without a reading doesn't name the refill either.
    const skipsUnknown = buildHeadline([at('a', null, 1_000, 'soon'), at('b', 40, 5_000, 'later')], 'Weekly limit');
    expect(skipsUnknown.nextResetMs).toBe(5_000);
    // Without an instant, the label of an account below 100% is the fallback, never a full one's.
    const fallback = buildHeadline([at('a', 100, undefined, 'Mon 9:00'), at('b', 30, undefined, 'Tue 9:00')], 'Weekly limit');
    expect(fallback.nextResetMs).toBeUndefined();
    expect(fallback.nextResetFallback).toBe('Tue 9:00');
    const allFull = buildHeadline([at('a', 100, 1_000, 'soon'), at('b', 100, 5_000, 'later')], 'Weekly limit');
    expect(allFull.nextResetMs).toBeUndefined();
    expect(allFull.nextResetFallback).toBeUndefined();
  });

  // A turned-off account counts toward the pooled figure, marked so the bar grays it out, but it can't run anything out
  // or refill anything the proxy uses; one without a reading has nothing to show.
  test('counts turned-off accounts that have a reading, kept out of the pace and the next refill', () => {
    const weekly = (name: string, left: number, resetAtMs: number) => ({ name, quota: success([{ label: 'Weekly limit', remainingPercent: left, resetAtMs }]) });
    const unread = { name: 'c', quota: { status: 'error', rows: [], error: 'HTTP 401' } as QuotaState };
    const headline = buildHeadline([weekly('a', 80, 5_000)], 'Weekly limit', [weekly('b', 2, 1_000), unread]);
    expect(headline.percent).toBe(41);
    expect(headline.segments.map((segment) => [segment.account.name, segment.off ?? false, segment.width])).toEqual([['a', false, 40], ['b', true, 1]]);
    expect([headline.reporting, headline.total, headline.off]).toEqual([2, 2, 1]);
    expect(headline.nextResetMs).toBe(5_000);
    // Nearly spent, the turned-off account alone would make the pace critical.
    expect(headlinePace(headline, 0).tone).toBe('success');
  });

  test('warns when another window will cap usage before the headline window', () => {
    const warnings = capWarnings([claude('a', 80, 12), claude('b', 30, 60)], '7-day Fable window', []);
    expect(warnings.map((warning) => [warning.account.name, warning.row.label])).toEqual([['a', '5-hour window']]);
    expect(capWarnings([claude('a', 80, 12)], '7-day Fable window', ['5-hour window'])).toEqual([]);
    expect(capWarnings([claude('a', 5, 12)], '7-day Fable window', [])).toEqual([]);
  });

  test('warns about a Claude cap that has no fixed label', () => {
    const quota = success(quotaRowsFor('claude', {
      seven_day: { utilization: 30 },
      seven_day_omelette: { utilization: 85 },
      limits: [
        { kind: 'weekly_scoped', is_active: true, percent: 20, scope: { model: { display_name: 'Fable' } } },
        { kind: 'weekly_scoped', percent: 95, scope: { model: { display_name: 'Haiku 5' } } },
      ],
    }));
    const warnings = capWarnings([{ name: 'a', quota }], '7-day Fable window', []);
    expect(warnings.map((warning) => [warning.row.label, warning.row.remainingPercent])).toEqual([
      ['7-day Omelette window', 15], ['7-day Haiku window', 5],
    ]);
  });

  test('infers window length from provider labels', () => {
    expect(windowDurationMs('5-hour window')).toBe(5 * 3_600_000);
    expect(windowDurationMs('7-day Fable window')).toBe(7 * 86_400_000);
    expect(windowDurationMs('Weekly limit')).toBe(7 * 86_400_000);
    expect(windowDurationMs('GPT-5.3 Spark Weekly limit')).toBe(7 * 86_400_000);
    expect(windowDurationMs('Monthly limit')).toBe(30 * 86_400_000);
    expect(windowDurationMs('Quota 1')).toBeNull();
  });

  test('colors by whether usage is outrunning the reset clock', () => {
    const week = 7 * 86_400_000;
    const now = 0;
    // Half the week gone, half the quota gone: on pace.
    expect(usagePace(50, now + week / 2, week, now).tone).toBe('success');
    // Half the week gone, 70% used: ahead of the clock.
    expect(usagePace(30, now + week / 2, week, now).tone).toBe('warning');
    // A quarter of the week gone, 70% used: badly ahead.
    expect(usagePace(30, now + (week * 3) / 4, week, now).tone).toBe('error');
    // Nearly empty is always red even when the reset is close.
    expect(usagePace(3, now + 1_000, week, now).tone).toBe('error');
    expect(usagePace(null, undefined, week, now).tone).toBe('muted');
    // Unknown window falls back to plain thresholds.
    expect(usagePace(25, undefined, null, now).tone).toBe('warning');
  });

  test('headline pace runs out only when the whole pool does', () => {
    const week = 7 * 86_400_000;
    const account = (name: string, left: number) => ({ name, quota: success([{ label: 'Weekly limit', remainingPercent: left, resetAtMs: week / 2 }]) });
    // 125 points spent in half a week leaves 75 against 125 more before the shared reset: well over 1.5× too fast.
    expect(headlinePace(buildHeadline([account('a', 60), account('b', 15)], 'Weekly limit'), 0).tone).toBe('error');
    expect(headlinePace(buildHeadline([account('a', 60), account('b', 55)], 'Weekly limit'), 0).tone).toBe('success');
    // 90 points left against 110 more: faster than the pool can last, but not 1.5× faster.
    expect(headlinePace(buildHeadline([account('a', 50), account('b', 40)], 'Weekly limit'), 0).tone).toBe('warning');
  });

  // The pools from a real Accounts page: one Claude account nearly spent among four nearly full ones, and Codex
  // accounts drained days before their resets.
  test('a nearly empty account among full ones leaves the pool on track', () => {
    const hour = 3_600_000;
    const week = 7 * 24 * hour;
    const account = (name: string, left: number, resetInHours: number) => ({
      name, quota: success([{ label: '7-day window', remainingPercent: left, resetAtMs: resetInHours * hour, windowMs: week }]),
    });
    const claudePool = buildHeadline([
      account('p2', 94, 51), account('w1', 97, 62), account('p1', 100, 91), account('as', 100, 141), account('p3', 3, 15),
    ], '7-day window');
    expect(headlinePace(claudePool, 0).tone).toBe('success');
    const codexPool = buildHeadline([account('w1', 25, 70), account('p3', 32, 101), account('p1', 0, 44), account('p2', 2, 48)], '7-day window');
    expect(headlinePace(codexPool, 0).tone).toBe('error');
  });

  test('headline pace without any reset time falls back to plain thresholds on the pooled figure', () => {
    const account = (name: string, left: number) => ({ name, quota: success([{ label: 'Quota', remainingPercent: left }]) });
    expect(headlinePace(buildHeadline([account('a', 3), account('b', 90)], 'Quota'), 0).tone).toBe('success');
    expect(headlinePace(buildHeadline([account('a', 3), account('b', 15)], 'Quota'), 0).tone).toBe('error');
  });

  test('pace times a window by the length the provider gave, before the one its label implies', () => {
    const day = 86_400_000;
    // Half of a 30-day window gone and half the limit used, under a label that says weekly.
    const row = { label: 'Weekly limit', remainingPercent: 50, resetAtMs: 15 * day, windowMs: 30 * day };
    expect(rowWindowMs(row)).toBe(30 * day);
    const headline = buildHeadline([{ name: 'a', quota: success([row]) }], 'Weekly limit');
    expect(headlinePace(headline, 0).tone).toBe('success');
    // The even-pace tick reads the same length, so it agrees.
    expect(evenPace(row.remainingPercent, row.resetAtMs, row.windowMs, 0)).toEqual({ evenPercent: 50, verdict: 'on-pace' });
    // Without the provider's length the label's week stands: a reset 15 days off reads as barely started.
    const { windowMs: _windowMs, ...labeled } = row;
    expect(rowWindowMs(labeled)).toBe(7 * day);
    expect(headlinePace(buildHeadline([{ name: 'a', quota: success([labeled]) }], 'Weekly limit'), 0).tone).toBe('error');
    // A label with no length gets one from the provider, and plain thresholds without.
    expect(rowWindowMs({ label: 'Quota', windowMs: 5 * 3_600_000 })).toBe(5 * 3_600_000);
    expect(rowWindowMs({ label: 'Quota' })).toBeNull();
    expect(rowWindowMs({ label: 'Weekly limit', windowMs: 0 })).toBe(7 * day);
  });
});

describe('stale limits', () => {
  const rows = [{ label: 'Weekly limit', remainingPercent: 30, resetAtMs: 9_000 }];
  const stale: QuotaState = { status: 'error', rows, error: 'timeout', fetchedAt: 1_000, staleSinceMs: 4_000 };

  test('are shown, including while the next check runs, but never acted on', () => {
    expect(isStaleQuota(stale)).toBe(true);
    expect(displayRows(stale)).toEqual(rows);
    expect(freshRows(stale)).toEqual([]);
    const retrying: QuotaState = { ...stale, status: 'loading' };
    expect(displayRows(retrying)).toEqual(rows);
    expect(freshRows(retrying)).toEqual([]);
    // A plain failure shows nothing, and fresh rows are the same either way.
    expect(displayRows({ status: 'error', rows, error: 'timeout' })).toEqual([]);
    expect(freshRows(success(rows))).toEqual(rows);
    expect(freshRows({ status: 'loading', rows })).toEqual(rows);
  });

  test('read as a failed check to automation', () => {
    const quotas = { good: success(rows), stale };
    const fresh = freshQuotas(quotas);
    expect(fresh.good).toBe(quotas.good);
    expect(fresh.stale).toMatchObject({ status: 'error', rows: [], error: 'timeout', fetchedAt: 1_000 });
    expect(isStaleQuota(fresh.stale!)).toBe(false);
    // Nothing stale: the same object, so memoized consumers don't re-run.
    const clean = { good: success(rows) };
    expect(freshQuotas(clean)).toBe(clean);
  });

  test('count in the pooled headline for showing, and are summed up with the oldest check', () => {
    const accounts = [
      { name: 'a', quota: success([{ ...rows[0]!, remainingPercent: 70 }]) },
      { name: 'b', quota: stale },
      { name: 'c', quota: { ...stale, fetchedAt: 500, error: 'DNS' } },
    ];
    expect(buildHeadline(accounts, 'Weekly limit').percent).toBeCloseTo(130 / 3);
    // Automation leaves the stale accounts out: unknown, not empty, so the fresh one alone is the average.
    const fresh = buildHeadline(accounts.map((account) => ({ ...account, quota: freshQuotas({ q: account.quota }).q! })), 'Weekly limit');
    expect(fresh).toMatchObject({ percent: 70, reporting: 1, total: 3 });
    const staleOf = (list: typeof accounts) => staleLimits(buildHeadline(list, 'Weekly limit'));
    expect(staleOf(accounts)).toEqual({ accounts: 2, all: false, asOfMs: 500, latestSinceMs: 4_000, error: 'timeout' });
    expect(staleOf(accounts.slice(0, 1))).toBeNull();
    expect(staleNoteKey(staleOf(accounts)!)).toBe('accounts.headline.stale.other');
    expect(staleNoteKey(staleOf(accounts.slice(0, 2))!)).toBe('accounts.headline.stale.one');
    // When every account the figure covers is stale the note is just the time.
    expect(staleOf(accounts.slice(1))).toMatchObject({ accounts: 2, all: true });
    expect(staleNoteKey(staleOf(accounts.slice(1))!)).toBe('accounts.stale.asOf');
    // The latest to start failing is the one that went stale last.
    expect(staleOf([...accounts, { name: 'd', quota: { ...stale, staleSinceMs: 7_000 } }])).toMatchObject({ accounts: 3, latestSinceMs: 7_000 });
  });

  test('only mark the figure stale when its window is among the rows held over', () => {
    // Claude's extra usage row, kept after the account's checks started failing, isn't the headline window.
    const extraOnly: QuotaState = { ...stale, rows: [{ label: 'Extra usage', remainingPercent: 80 }] };
    const accounts = [
      { name: 'a', quota: success([{ ...rows[0]!, remainingPercent: 70 }]) },
      { name: 'b', quota: extraOnly },
    ];
    const headline = buildHeadline(accounts, 'Weekly limit');
    expect(headline).toMatchObject({ percent: 70, reporting: 1, total: 2 });
    expect(staleLimits(headline)).toBeNull();
    // Its row is still stale where it shows.
    expect(staleLimits(buildHeadline(accounts, 'Extra usage'))).toMatchObject({ accounts: 1, all: true });
  });
});

describe('windowGrid', () => {
  test('one window spans the row and two take half each', () => {
    expect(windowGrid(['Weekly limit']).perLine).toBe(1);
    expect(windowGrid(['Weekly limit']).place('Weekly limit')).toEqual({ column: 1, row: 1 });
    expect(windowGrid(['5-hour limit', 'Weekly limit']).perLine).toBe(2);
  });

  test('three to a line, each window in its own column whatever an account is missing', () => {
    const grid = windowGrid(['5-hour window', '7-day window', '7-day Opus window', '7-day Sonnet window', '7-day Fable window']);
    expect(grid.perLine).toBe(3);
    expect(grid.place('7-day window')).toEqual({ column: 2, row: 1 });
    expect(grid.place('7-day Sonnet window')).toEqual({ column: 1, row: 2 });
    expect(grid.place('7-day Fable window')).toEqual({ column: 2, row: 2 });
    // A window the provider's list leaves out (hidden) has no place.
    expect(grid.place('Extra usage')).toBeNull();
  });

  test('an empty list still has a line', () => {
    expect(windowGrid([]).perLine).toBe(1);
  });
});

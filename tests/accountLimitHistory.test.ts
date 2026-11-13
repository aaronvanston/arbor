import { describe, expect, it } from 'bun:test';
import { limitReadings, noteResetUsed, unrecordedLimitReadings } from '../src/services/accountLimitHistory';
import { quotaKey, type QuotaState } from '../src/services/quotaService';

const HOUR = 3_600_000;
const claude = { name: 'claude-work.json', provider: 'claude', auth_index: ' idx-1 ' };
const codex = { name: 'codex-home.json', provider: 'codex', authIndex: 7 };
const claudeQuota = (fetchedAt: number): QuotaState => ({
  status: 'success',
  plan: 'max',
  fetchedAt,
  rows: [
    { label: '5-hour window', remainingPercent: 64, resetAtMs: fetchedAt + 2 * HOUR },
    { label: '7-day window', remainingPercent: 31.5, resetAtMs: fetchedAt + 50 * HOUR },
    { label: 'Extra usage', remainingPercent: null, detail: '$0 of $50' },
  ],
});

describe('account limit history', () => {
  it('turns a successful refresh into one reading per window with a percentage', () => {
    expect(limitReadings(claude, claudeQuota(1_000))).toEqual([
      { account: 'claude-work.json::idx-1', authIndex: 'idx-1', provider: 'claude', plan: 'max', window: '5-hour window', remainingPercent: 64, resetAtMs: 1_000 + 2 * HOUR, extra: false, sampledAtMs: 1_000 },
      { account: 'claude-work.json::idx-1', authIndex: 'idx-1', provider: 'claude', plan: 'max', window: '7-day window', remainingPercent: 31.5, resetAtMs: 1_000 + 50 * HOUR, extra: false, sampledAtMs: 1_000 },
    ]);
    const review: QuotaState = { status: 'success', fetchedAt: 5, rows: [{ label: 'Code review 5-hour limit', remainingPercent: 100, extra: true }] };
    expect(limitReadings(codex, review)).toEqual([
      { account: 'codex-home.json::7', authIndex: '7', provider: 'codex', plan: '', window: 'Code review 5-hour limit', remainingPercent: 100, resetAtMs: null, extra: true, sampledAtMs: 5 },
    ]);
  });

  it('records nothing while a refresh is loading or failed, or for an unknown provider', () => {
    const quota = claudeQuota(1_000);
    expect(limitReadings(claude, { ...quota, status: 'loading' })).toEqual([]);
    expect(limitReadings(claude, { ...quota, status: 'error', error: 'expired' })).toEqual([]);
    // Rows kept from an earlier check after a failed one were recorded when they were read.
    const stale: QuotaState = { ...quota, status: 'error', error: 'timeout', staleSinceMs: 2_000 };
    expect(limitReadings(claude, stale)).toEqual([]);
    expect(unrecordedLimitReadings([claude], { [quotaKey(claude)]: stale }, {}).readings).toEqual([]);
    expect(limitReadings(claude, { ...quota, fetchedAt: undefined })).toEqual([]);
    expect(limitReadings(claude, undefined)).toEqual([]);
    expect(limitReadings({ name: 'mystery.json', provider: 'someone-else' }, quota)).toEqual([]);
  });

  it('names a reset on the rows it refills', () => {
    const fable = limitReadings(claude, claudeQuota(1_000), { reset: 'fable', windows: ['7-day window'] });
    expect(fable.map((reading) => [reading.window, reading.resetUsed])).toEqual([['5-hour window', undefined], ['7-day window', 'fable']]);
    // Codex's reset refills every main limit, and none of the ones beside them.
    const quota: QuotaState = { status: 'success', fetchedAt: 5, rows: [
      { label: '5-hour limit', remainingPercent: 100 }, { label: 'Weekly limit', remainingPercent: 100 },
      { label: 'Code review 5-hour limit', remainingPercent: 40, extra: true },
    ] };
    expect(limitReadings(codex, quota, { reset: 'manual', windows: null }).map((reading) => reading.resetUsed)).toEqual(['manual', 'manual', undefined]);
  });

  it('puts a reset Arbor used on the first refresh after it, and only that one', () => {
    const file = { name: 'claude-reset.json', provider: 'claude', auth_index: 'reset-1' };
    const key = quotaKey(file);
    const tags = (fetchedAt: number, recorded: Record<string, number> = {}) =>
      unrecordedLimitReadings([file], { [key]: claudeQuota(fetchedAt) }, recorded).readings.map((reading) => reading.resetUsed);
    noteResetUsed(key, { reset: 'weekly', windows: ['7-day window'] }, 5_000);
    // A refresh from before the reset can't show it, and another account's says nothing about it.
    expect(tags(4_000)).toEqual([undefined, undefined]);
    expect(unrecordedLimitReadings([claude], { [quotaKey(claude)]: claudeQuota(6_000) }, {}).readings.every((reading) => !reading.resetUsed)).toBe(true);
    // The refresh after the reset failed, so the next good one carries it.
    expect(tags(5_000 + 20 * 60_000)).toEqual([undefined, 'weekly']);
    expect(tags(5_000 + 30 * 60_000)).toEqual([undefined, undefined]);
    // Hours on, a refill can't be put down to it.
    noteResetUsed(key, { reset: 'full', windows: ['5-hour window', '7-day window'] }, 10 * HOUR);
    expect(tags(12 * HOUR)).toEqual([undefined, undefined]);
    expect(tags(12 * HOUR + 1)).toEqual([undefined, undefined]);
  });

  it('sends each refresh once and picks up the next one', () => {
    const files = [claude, codex];
    const first = unrecordedLimitReadings(files, { [quotaKey(claude)]: claudeQuota(1_000) }, {});
    expect(first.readings).toHaveLength(2);
    expect(first.recorded).toEqual({ [quotaKey(claude)]: 1_000 });

    // The same refresh again (a re-render, or the account going back to loading) sends nothing.
    expect(unrecordedLimitReadings(files, { [quotaKey(claude)]: claudeQuota(1_000) }, first.recorded).readings).toEqual([]);
    const loading: QuotaState = { ...claudeQuota(1_000), status: 'loading' };
    expect(unrecordedLimitReadings(files, { [quotaKey(claude)]: loading }, first.recorded).readings).toEqual([]);

    const second = unrecordedLimitReadings(files, { [quotaKey(claude)]: claudeQuota(2_000) }, first.recorded);
    expect(second.readings.map((reading) => reading.sampledAtMs)).toEqual([2_000, 2_000]);
    expect(second.recorded).toEqual({ [quotaKey(claude)]: 2_000 });
  });
});

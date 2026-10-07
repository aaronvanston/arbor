import { describe, expect, it } from 'bun:test';
import { capacityGap, capacityReport, costedRatio, longLimitWindows } from '../src/services/capacityReport';
import { listPrice } from '../src/services/planCosts';
import { quotaKey, type QuotaState } from '../src/services/quotaService';
import type { AccountValue, CapacityReport, LimitCoverage, LimitCycle } from '../src/native/types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MONTH = (365.25 / 12) * DAY;
const start = 100 * DAY;
const now = 130 * DAY;
const WEEKLY = '7-day window';

const claude = (name: string, authIndex: string, extra: Record<string, unknown> = {}) => ({ name, provider: 'claude', auth_index: authIndex, ...extra });
const quota = (plan: string, weeklyLeft: number | null, resetIn?: number): QuotaState => ({
  status: 'success',
  plan,
  rows: [
    { label: '5-hour window', remainingPercent: 90, resetAtMs: now + HOUR },
    { label: WEEKLY, remainingPercent: weeklyLeft, resetAtMs: resetIn === undefined ? undefined : now + resetIn },
  ],
});
const value = (authIndex: string, estimatedCost: number, firstSeenMs = start - 20 * DAY, requests = 100): AccountValue => ({
  authIndex, provider: 'claude', requests, totalTokens: requests * 1_000, estimatedCost, pricedRequests: requests - 10, firstSeenMs,
});
const watched = (account: string, from: number, to = now): LimitCoverage => ({ account, window: WEEKLY, firstSampledAtMs: from, lastSampledAtMs: to });
const cycle = (account: string, firstSampledAtMs: number, firstRemainingPercent: number, minRemainingPercent: number, resetAtMs: number): LimitCycle => ({
  account, authIndex: '', plan: '', window: WEEKLY, resetAtMs, firstRemainingPercent, minRemainingPercent, firstSampledAtMs, lastSampledAtMs: resetAtMs - HOUR,
});
const noPrefs = { hidden: {}, headline: {} };

const work = claude('work.json', 'w1');
const spare = claude('spare.json', 's1');
const fresh = claude('fresh.json', 'f1');
const apiKey = claude('claude-key', 'k1', { account_type: 'api_key' });
const files = [work, spare, fresh, apiKey];
const quotas: Record<string, QuotaState> = {
  [quotaKey(work)]: quota('Max 20x', 50, 3 * DAY),
  [quotaKey(spare)]: quota('Max 20x', 100),
  [quotaKey(fresh)]: quota('Pro', 40, 2 * DAY),
};
const data: CapacityReport = {
  startMs: start,
  endMs: now,
  accounts: [value('w1', 120), value('s1', 5), value('f1', 30, start + 15 * DAY), value('k1', 50), value('gone', 40, start, 20)],
  coverage: [watched(quotaKey(work), 120 * DAY), watched(quotaKey(spare), 116 * DAY), watched(quotaKey(fresh), 128 * DAY)],
  cycles: [
    // Already running at the first reading: counts from 60% left down to 30%.
    cycle(quotaKey(work), 120 * DAY, 60, 30, 123 * DAY),
    // Started while watched: counts from the full window down to 50%.
    cycle(quotaKey(work), 124 * DAY, 90, 50, 130 * DAY),
  ],
  historySinceMs: 110 * DAY,
};

describe('capacity report', () => {
  it('sets each subscription’s value at API prices against its cost over the period', () => {
    const [report] = capacityReport({ data, files, quotas, profiles: {}, prefs: noPrefs, costs: {}, nowMs: now });
    expect(report?.provider).toBe('claude');
    expect(report?.window).toBe(WEEKLY);
    const byName = Object.fromEntries(report!.accounts.map((account) => [account.name, account]));
    // The API key isn't a subscription.
    expect(Object.keys(byName)).toEqual(['work', 'spare', 'fresh']);
    expect(byName.work).toMatchObject({ plan: 'Max 20x', monthlyCost: 200, costSet: false, value: 120, requests: 100, unpricedRequests: 10 });
    expect(byName.work!.periodCost).toBeCloseTo((200 * 30 * DAY) / MONTH);
    expect(byName.work!.ratio).toBeCloseTo(120 / ((200 * 30 * DAY) / MONTH));
    // First seen halfway through: it only costs the second half.
    expect(byName.fresh!.periodCost).toBeCloseTo((20 * 15 * DAY) / MONTH);
    expect(report?.monthlyCost).toBe(420);
    expect(report?.unknownCosts).toBe(0);
    expect(report?.value).toBe(155);
    // Usage from a credential that's gone is shown apart; the API key's isn't counted at all.
    expect(report?.unlisted).toEqual({ value: 40, requests: 20 });

    const [set] = capacityReport({ data, files, quotas, profiles: {}, prefs: noPrefs, costs: { [quotaKey(work)]: 100 }, nowMs: now });
    expect(set!.accounts[0]).toMatchObject({ monthlyCost: 100, costSet: true });
    const [unknown] = capacityReport({ data, files, quotas: { ...quotas, [quotaKey(work)]: quota('Max', 50, 3 * DAY) }, profiles: {}, prefs: noPrefs, costs: {}, nowMs: now });
    expect(unknown!.accounts[0]).toMatchObject({ monthlyCost: null, periodCost: null, ratio: null });
    expect(unknown!.unknownCosts).toBe(1);
  });

  it('measures use per week from the readings, or the live window once half of it has passed', () => {
    const [report] = capacityReport({ data, files, quotas, profiles: {}, prefs: noPrefs, costs: {}, nowMs: now });
    const byName = Object.fromEntries(report!.accounts.map((account) => [account.name, account]));
    // 30 + 50 points over 10 days watched.
    expect(byName.work!.use).toEqual({ percent: 56, basis: 'history', watchedMs: 10 * DAY });
    // Watched for two weeks without the window ever running.
    expect(byName.spare).toMatchObject({ use: { percent: 0, basis: 'history' }, idle: true });
    // Two days of readings isn't enough; 60% used five days into the window is.
    expect(byName.fresh!.use?.basis).toBe('live');
    expect(byName.fresh!.use?.percent).toBeCloseTo(60 / (5 / 7));
    expect(byName.fresh!.current).toEqual({ usedPercent: 60, resetAtMs: now + 2 * DAY });

    // A range that ended a while ago doesn't use the live reading.
    const [past] = capacityReport({ data: { ...data, endMs: now - DAY }, files, quotas, profiles: {}, prefs: noPrefs, costs: {}, nowMs: now });
    expect(past!.accounts[2]).toMatchObject({ use: null, current: null });

    // Nor does one held over from before a failed check: it isn't live.
    const stale: QuotaState = { ...quotas[quotaKey(fresh)]!, status: 'error', error: 'timeout', fetchedAt: now - DAY, staleSinceMs: now - HOUR };
    const [failed] = capacityReport({ data, files, quotas: { ...quotas, [quotaKey(fresh)]: stale }, profiles: {}, prefs: noPrefs, costs: {}, nowMs: now });
    expect(failed!.window).toBe(WEEKLY);
    expect(failed!.accounts[2]).toMatchObject({ use: null, current: null });
  });

  it('suggests letting go of the least used accounts on a plan the others could cover', () => {
    const [report] = capacityReport({ data, files, quotas, profiles: {}, prefs: noPrefs, costs: {}, nowMs: now });
    // 56% + 0% of one Max 20x account's week fits in one account at 80%.
    expect(report?.verdicts).toEqual([{ plan: 'Max 20x', accounts: 2, needPercent: 56, keep: 1, spare: ['spare'], saving: 200 }]);
    expect(report?.accounts.map((account) => account.spare)).toEqual([false, true, false]);

    // Busier: 56% + 65% needs both.
    const busy = { ...data, cycles: [...data.cycles, cycle(quotaKey(spare), 118 * DAY, 100, 0, 125 * DAY), cycle(quotaKey(spare), 126 * DAY, 100, 70, 133 * DAY)] };
    expect(capacityReport({ data: busy, files, quotas, profiles: {}, prefs: noPrefs, costs: {}, nowMs: now })[0]?.verdicts).toEqual([]);

    // Not enough readings for one of them: no suggestion yet.
    const unsure = { ...data, coverage: [watched(quotaKey(work), 120 * DAY), watched(quotaKey(spare), 128 * DAY)] };
    expect(capacityReport({ data: unsure, files, quotas, profiles: {}, prefs: noPrefs, costs: {}, nowMs: now })[0]?.verdicts).toEqual([]);
  });

  it('knows the list prices of the plans providers report', () => {
    expect([listPrice('claude', 'Max 20x'), listPrice('claude', 'Max 5x'), listPrice('claude', 'Max'), listPrice('claude', 'Pro'), listPrice('claude', 'Free')]).toEqual([200, 100, null, 20, 0]);
    expect([listPrice('codex', 'pro'), listPrice('codex', 'plus'), listPrice('codex', 'business'), listPrice('codex', 'enterprise'), listPrice('codex', undefined)]).toEqual([200, 20, 30, null, null]);
    expect(listPrice('kimi', 'Pro')).toBeNull();
  });

  it('asks for the limit windows a day or longer', () => {
    expect(longLimitWindows(quotas)).toEqual([WEEKLY]);
    expect(longLimitWindows({ a: { status: 'success', rows: [{ label: 'Weekly limit', remainingPercent: 5 }, { label: '5-hour limit', remainingPercent: 1 }] } })).toEqual(['Weekly limit']);
  });
});

describe('why Value is empty', () => {
  const listed = { loaded: true, error: '', files: [], disabled: [] };
  it('offers adding an account only when the core has none', () => {
    expect(capacityGap(false, listed)).toBe('coreStopped');
    expect(capacityGap(true, { ...listed, loaded: false })).toBe('loading');
    expect(capacityGap(true, { ...listed, disabled: [{ name: 'claude.json' }] })).toBe('off');
    expect(capacityGap(true, { ...listed, error: 'Management API error (503): unavailable' })).toBe('failed');
    expect(capacityGap(null, listed)).toBe('none');
    // Accounts listed, none of them a subscription.
    expect(capacityGap(true, { ...listed, files: [{ name: 'gemini-key.json' }] })).toBe('subscriptions');
  });
});

describe('capacity ratio', () => {
  it('is unknown when the accounts had requests and none of them had a price', () => {
    const unpriced: CapacityReport = { ...data, accounts: data.accounts.map((account) => ({ ...account, estimatedCost: 0, pricedRequests: 0 })) };
    const [report] = capacityReport({ data: unpriced, files, quotas, profiles: {}, prefs: noPrefs, costs: {}, nowMs: now });
    expect(report?.ratio).toBeNull();
    expect(report?.accounts.map((account) => account.ratio)).toEqual([null, null, null]);
  });

  it('is nothing for accounts with a cost that made no requests', () => {
    expect(costedRatio([{ periodCost: 50, value: 0, requests: 0, unpricedRequests: 0 }])).toBe(0);
    expect(costedRatio([{ periodCost: null, value: 10, requests: 5, unpricedRequests: 0 }])).toBeNull();
    expect(costedRatio([{ periodCost: 50, value: 25, requests: 5, unpricedRequests: 4 }])).toBe(0.5);
  });
});

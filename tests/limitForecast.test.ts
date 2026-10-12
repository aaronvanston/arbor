import { describe, expect, test } from 'bun:test';
import type { LimitTrendAccount } from '../src/native/types';
import { buildHeadline } from '../src/services/accountLimits';
import {
  buildForecast, burnRate, forecastAccounts, forecastAlert, nextForecastAlerts, plannableCredits, poolHistory, spendByHour,
  type ForecastAccount, type ForecastSettings,
} from '../src/services/limitForecast';
import { simulatePool } from '../src/services/poolSimulation';
import type { QuotaState } from '../src/services/quotaService';
import { itemAt, lastItem, present } from './support/items';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A Monday at midnight, local time, so hours of the week line up with the test's days.
const NOW = new Date(2026, 9, 12, 0, 0, 0).getTime();

type Reading = { account: string; reading: [number, number, number | null] };
const reading = (account: string, hoursAgo: number, remainingPercent: number, resetAtMs: number | null = NOW + 3 * DAY): Reading =>
  ({ account, reading: [NOW - hoursAgo * HOUR, remainingPercent, resetAtMs] });
/** Readings as `get_limit_trend` groups them: by account, in time order. */
const trend = (readings: Reading[]): LimitTrendAccount[] => {
  const grouped = new Map<string, LimitTrendAccount>();
  readings.forEach(({ account, reading: item }) => {
    const entry = grouped.get(account) ?? { account, authIndex: account, readings: [] };
    entry.readings.push(item);
    grouped.set(account, entry);
  });
  return [...grouped.values()].map((entry) => ({ ...entry, readings: entry.readings.sort((a, b) => a[0] - b[0]) }));
};

const account = (key: string, left: number, resetInHours: number | null, credits = 0, creditsExpireAtMs: number | null = null): ForecastAccount => ({
  key, name: key, left, resetAtMs: resetInHours === null ? null : NOW + resetInHours * HOUR, windowMs: 7 * DAY, credits, creditsExpireAtMs,
});

const settings = (overrides: Partial<ForecastSettings> = {}): ForecastSettings =>
  ({ model: 'recent', lookbackDays: 7, ratePerHour: null, countResets: false, ...overrides });

describe('pool simulation', () => {
  test('spends the soonest reset first and refills each account at its reset', () => {
    const run = simulatePool([account('a', 50, 10), account('b', 50, 100)], { startMs: NOW, endMs: NOW + 20 * HOUR, rate: () => 5 / HOUR, points: true });
    // 50 points of a last 10 hours, then a refills to 100 and is spent first again.
    expect(run.emptyAtMs.a).toBe(NOW + 10 * HOUR);
    expect(itemAt(run.events, 0)).toMatchObject({ key: 'a', kind: 'reset', before: 0, atMs: NOW + 10 * HOUR });
    expect(run.dryAtMs).toBeNull();
    expect(lastItem(run.points).left).toBe(100 + 50 - 50);
  });

  test('finds the moment the whole pool runs dry, and how long it stays dry', () => {
    const run = simulatePool([account('a', 20, 48), account('b', 10, 72)], { startMs: NOW, endMs: NOW + 40 * HOUR, rate: () => 1 / HOUR });
    expect(run.dryAtMs).toBe(NOW + 30 * HOUR);
    expect(run.dryMs).toBe(10 * HOUR);
  });

  test('claims a credit when the account runs out, if asked to', () => {
    const run = simulatePool([account('a', 10, 100, 1)], { startMs: NOW, endMs: NOW + 50 * HOUR, rate: () => 1 / HOUR, claimCredits: true });
    expect(itemAt(run.events, 0)).toMatchObject({ kind: 'credit', atMs: NOW + 10 * HOUR });
    expect(run.dryAtMs).toBeNull();
  });
});

describe('limit history', () => {
  test('adds the accounts up, holding each reading until the next', () => {
    const accounts = [account('a', 60, 72), account('b', 100, 72)];
    const points = poolHistory(trend([reading('a', 10, 90), reading('b', 5, 100), reading('a', 2, 70)]), accounts, NOW - DAY, NOW);
    // b's first reading stands in before it; the live figures end it.
    expect(points.map((point) => point.left)).toEqual([190, 190, 170, 160]);
  });

  test('counts drops within a cycle and what was used after a reset, never the refill', () => {
    const resetBefore = NOW - 4 * HOUR;
    const accounts = [account('a', 80, 7 * 24 - 4)];
    const spend = spendByHour(trend([
      reading('a', 8, 50, resetBefore),
      reading('a', 6, 30, resetBefore),
      reading('a', 2, 90, NOW + 7 * DAY - 4 * HOUR),
    ]), accounts, NOW - DAY, NOW);
    const total = spend.hours.reduce((sum, value) => sum + value, 0);
    // 20 within the old cycle, 10 since the reset, 10 more to the live 80%.
    expect(total).toBeCloseTo(40, 6);
    expect(spend.watchedFromMs).toBe(NOW - 8 * HOUR);
  });
});

describe('burn rate', () => {
  const accounts = [account('a', 50, 72)];

  test('averages the recent spend, falling back from the weekly pattern without a week of readings', () => {
    const spend = spendByHour(trend([reading('a', 10, 60)]), accounts, NOW - 28 * DAY, NOW);
    const burn = burnRate(spend, accounts, settings({ model: 'weekly' }), NOW);
    expect(burn.basis).toBe('recent');
    expect(burn.fellBack).toBe(true);
    expect(burn.perHour).toBeCloseTo(1, 6);
  });

  test('uses a manual rate over everything', () => {
    const spend = spendByHour([], accounts, NOW - 28 * DAY, NOW);
    expect(burnRate(spend, accounts, settings({ ratePerHour: 4 }), NOW)).toMatchObject({ basis: 'manual', perHour: 4 });
  });

  test("before any history, uses each window's average so far", () => {
    const spend = spendByHour([], accounts, NOW - 28 * DAY, NOW);
    // 50 used over the 4 days of the window gone.
    expect(burnRate(spend, accounts, settings(), NOW)).toMatchObject({ basis: 'window' });
    expect(burnRate(spend, accounts, settings(), NOW).perHour).toBeCloseTo(50 / 96, 6);
  });

  test('learns a weekly pattern: busy days spend more than quiet ones', () => {
    // Two weeks of readings: 2% an hour through each day's working hours, nothing at night.
    const readings: Reading[] = [];
    let left = 100;
    for (let hour = 14 * 24; hour >= 0; hour -= 1) {
      const t = NOW - hour * HOUR;
      const local = new Date(t).getHours();
      if (local >= 9 && local < 17) left = Math.max(0, left - 2);
      if (left === 0) left = 100;
      readings.push(reading('a', hour, left, null));
    }
    const pool = [account('a', left, null)];
    const spend = spendByHour(trend(readings), pool, NOW - 28 * DAY, NOW);
    const burn = burnRate(spend, pool, settings({ model: 'weekly' }), NOW);
    expect(burn.basis).toBe('weekly');
    expect(burn.rateAt(NOW + 12 * HOUR) * HOUR).toBeGreaterThan(burn.rateAt(NOW + 3 * HOUR) * HOUR * 3);
  });
});

describe('forecast', () => {
  test('suggests the reset that buys the most time, when its account runs out', () => {
    const accounts = [account('a', 20, 100, 1), account('b', 20, 30)];
    const forecast = buildForecast({ accounts, readings: [], settings: settings({ ratePerHour: 2 }), horizonDays: 3, historyMs: DAY, nowMs: NOW });
    expect(forecast.capacity).toBe(200);
    expect(forecast.left).toBe(40);
    // b runs out first (10h), a 10h later, and the pool stays dry until b's reset at 30h.
    expect(forecast.projection.dryAtMs).toBe(NOW + 20 * HOUR);
    const claim = present(forecast.advice.find((item) => item.kind === 'claim'));
    expect(claim).toMatchObject({ key: 'a', atMs: NOW + 20 * HOUR });
  });

  test('draws the claims in when asked to count them', () => {
    const accounts = [account('a', 20, 100, 1), account('b', 20, 30)];
    const forecast = buildForecast({ accounts, readings: [], settings: settings({ ratePerHour: 2, countResets: true }), horizonDays: 1, historyMs: DAY, nowMs: NOW });
    expect(forecast.projection.dryAtMs).toBeNull();
    expect(forecast.advice.find((item) => item.kind === 'lasts')).toMatchObject({ credits: 0 });
  });

  test('without resets, says what pace would last', () => {
    const forecast = buildForecast({ accounts: [account('a', 10, 100)], readings: [], settings: settings({ ratePerHour: 1 }), horizonDays: 1, historyMs: DAY, nowMs: NOW });
    const slow = present(forecast.advice.find((item) => item.kind === 'slow'));
    expect(slow.kind === 'slow' && slow.perHour).toBeCloseTo(10 / 24, 2);
  });

  test('flags credits that lapse unused and capacity that resets unspent', () => {
    const accounts = [account('a', 90, 5, 2, NOW + 2 * DAY), account('b', 100, 100)];
    const forecast = buildForecast({ accounts, readings: [], settings: settings({ ratePerHour: 0.5 }), horizonDays: 3, historyMs: DAY, nowMs: NOW });
    expect(forecast.advice.find((item) => item.kind === 'expiring')).toMatchObject({ key: 'a', count: 2 });
    expect(forecast.advice.find((item) => item.kind === 'unused')).toMatchObject({ byMs: NOW + 5 * HOUR });
    expect(forecast.nextRefill).toMatchObject({ atMs: NOW + 5 * HOUR });
  });

  test('alerts once for each refill the pool waits on', () => {
    const forecast = buildForecast({ accounts: [account('a', 5, 48)], readings: [], settings: settings({ ratePerHour: 1 }), horizonDays: 3, historyMs: DAY, nowMs: NOW });
    const alert = present(forecastAlert('claude', forecast, NOW));
    const first = nextForecastAlerts({}, [alert], NOW);
    expect(first.fresh).toHaveLength(1);
    expect(nextForecastAlerts(first.notified, [alert], NOW + HOUR).fresh).toHaveLength(0);
  });
});

describe('forecast accounts', () => {
  const quota = (remaining: number, extra: Partial<QuotaState> = {}): QuotaState => ({
    status: 'success',
    rows: [{ label: '7-day window', remainingPercent: remaining, resetAtMs: NOW + DAY }],
    ...extra,
  });

  test('leaves out turned-off accounts and counts only credits that can be planned', () => {
    const headline = buildHeadline(
      [{ name: 'a', quota: quota(40, { resetCredits: 2, resetCreditsApplicable: 1 }) }, { name: 'b', quota: quota(60) }],
      '7-day window',
      [{ name: 'c', quota: quota(90) }],
    );
    const accounts = forecastAccounts(headline, (item) => `key-${item.name}`);
    expect(accounts.map((item) => [item.key, item.left, item.credits])).toEqual([['key-a', 40, 1], ['key-b', 60, 0]]);
  });

  test("counts Claude's banked resets unless Claude won't take them from here", () => {
    expect(plannableCredits({ status: 'success', rows: [], resetCredits: 1, bankedReset: {} })).toBe(1);
    expect(plannableCredits({ status: 'success', rows: [], resetCredits: 1, bankedReset: { blockedReason: 'cooldown' } })).toBe(1);
    expect(plannableCredits({ status: 'success', rows: [], resetCredits: 1, bankedReset: { blockedReason: 'client', blockedHere: true } })).toBe(0);
    expect(plannableCredits({ status: 'success', rows: [], resetCredits: 1 })).toBe(0);
  });
});

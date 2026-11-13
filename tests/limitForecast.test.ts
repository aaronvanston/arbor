import { describe, expect, test } from 'bun:test';
import type { LimitTrendAccount } from '../src/native/types';
import { buildHeadline } from '../src/services/accountLimits';
import {
  buildForecast, burnRate, forecastAccounts, forecastAlert, historyMarks, nextForecastAlerts, poolHistory, spendByHour,
  type Advice, type ForecastAccount, type ForecastSettings,
} from '../src/services/limitForecast';
import { simulatePool } from '../src/services/poolSimulation';
import type { QuotaState } from '../src/services/quotaService';
import { creditLots, type CreditLot } from '../src/services/resetLots';
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
  key, name: key, left, resetAtMs: resetInHours === null ? null : NOW + resetInHours * HOUR, windowMs: 7 * DAY, credits,
  lots: credits ? [{ count: credits, expiresAtMs: creditsExpireAtMs, refills: true }] : [],
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

describe('pool simulation with resets that lapse', () => {
  test('spends an account ahead of its turn until the reset it holds lapses', () => {
    // b resets sooner, but a holds a reset that lapses at 8h: a goes first until then.
    const pool = [{ ...account('a', 50, 100), useBy: [NOW + 8 * HOUR] }, account('b', 50, 30)];
    const run = simulatePool(pool, { startMs: NOW, endMs: NOW + 20 * HOUR, rate: () => 5 / HOUR, stepMs: HOUR });
    expect(Math.round((present(run.emptyAtMs.b) - NOW) / HOUR)).toBe(18);
    expect(Math.round((present(run.emptyAtMs.a) - NOW) / HOUR)).toBe(20);
    // In time, a runs out first and the claim spends the reset, so it's back in its usual place.
    const claimed = simulatePool([{ ...account('a', 20, 100, 1), useBy: [NOW + 8 * HOUR] }, account('b', 50, 30)], {
      startMs: NOW, endMs: NOW + 20 * HOUR, rate: () => 5 / HOUR, stepMs: HOUR, claimAt: [{ key: 'a', atMs: NOW + 4 * HOUR }],
    });
    expect(claimed.events.map((event) => [event.key, event.kind, Math.round((event.atMs - NOW) / HOUR), Math.round(event.before)])).toEqual([['a', 'credit', 4, 0]]);
    expect(Math.round((present(claimed.emptyAtMs.b) - NOW) / HOUR)).toBe(14);
  });

  test('records every time an account runs out', () => {
    const run = simulatePool([account('a', 10, 100, 2)], { startMs: NOW, endMs: NOW + 3 * DAY, rate: () => 5 / HOUR, stepMs: HOUR, claimCredits: true });
    expect(present(run.emptied.a).map((atMs) => Math.round((atMs - NOW) / HOUR))).toEqual([2, 22, 42]);
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

describe('resets on the chart', () => {
  const RESET = NOW + 3 * DAY;

  test("marks a rise the window's own reset doesn't explain, from five percent up", () => {
    const accounts = [account('a', 90, 72), account('b', 60, 72), account('c', 100, 7 * 24 - 29)];
    const marks = historyMarks(trend([
      // The week's reset time hasn't moved, as after a Claude reset: a refill with none on record.
      reading('a', 30, 20), reading('a', 20, 95),
      // A provider's rounding, not a refill.
      reading('a', 10, 93), reading('a', 9, 95.5),
      // The window reset on schedule: the step alone says so.
      reading('b', 30, 10, NOW - 25 * HOUR), reading('b', 24, 97, RESET),
      // A new window started before the old one was due, as after a Codex reset.
      reading('c', 30, 20, NOW + DAY), reading('c', 29, 100, NOW + 7 * DAY - 29 * HOUR),
    ]), accounts, NOW - 2 * DAY, NOW);
    expect(marks).toEqual([
      { atMs: NOW - 29 * HOUR, key: 'c', name: 'c', how: 'early', gain: 80 },
      { atMs: NOW - 20 * HOUR, key: 'a', name: 'a', how: 'early', gain: 75 },
    ]);
    // Before the chart begins there's nothing to mark, and the live figure counts as a reading.
    expect(historyMarks(trend([reading('a', 30, 20), reading('a', 20, 95)]), accounts, NOW - 10 * HOUR, NOW)).toEqual([]);
    expect(historyMarks(trend([reading('a', 3, 20)]), accounts, NOW - DAY, NOW)).toMatchObject([{ atMs: NOW, how: 'early', gain: 70 }]);
  });

  test('names a reset Arbor used where the account rose, or when it was used with nothing to show for it', () => {
    const accounts = [account('a', 80, 72), account('b', 99, 7 * 24 - 2)];
    const readings = trend([
      reading('a', 30, 20), reading('a', 20, 95), reading('a', 6, 81), reading('a', 5, 81),
      // Used minutes before the window was due anyway: the reset is what refilled it.
      reading('b', 4, 0, NOW - 3 * HOUR), reading('b', 2, 100, NOW + 7 * DAY - 2 * HOUR),
    ]).map((item) => ({
      ...item,
      resetsUsed: item.account === 'a'
        // The rise was read a little after the reset was, and a Fable reset handed nothing back to this window.
        ? [[NOW - 20 * HOUR - 5 * 60_000, 'weekly'], [NOW - 5 * HOUR, 'fable']] satisfies LimitTrendAccount['resetsUsed']
        : [[NOW - 2 * HOUR, 'manual']] satisfies LimitTrendAccount['resetsUsed'],
    }));
    expect(historyMarks(readings, accounts, NOW - 2 * DAY, NOW)).toEqual([
      { atMs: NOW - 20 * HOUR, key: 'a', name: 'a', how: 'used', reset: 'weekly', gain: 75 },
      { atMs: NOW - 5 * HOUR, key: 'a', name: 'a', how: 'used', reset: 'fable', gain: 0 },
      // Codex has one kind of reset, so it goes unnamed.
      { atMs: NOW - 2 * HOUR, key: 'b', name: 'b', how: 'used', gain: 100 },
    ]);
    // An account that's turned off is in neither the line nor its marks.
    expect(historyMarks(readings, [account('b', 99, 7 * 24 - 2)], NOW - 2 * DAY, NOW).map((mark) => mark.key)).toEqual(['b']);
  });

  test('gives each reset the rise read nearest it', () => {
    // A Fable reset that handed nothing back, then a weekly reset 50 minutes on: the rise is the weekly one's.
    const readings = trend([reading('a', 10, 20), reading('a', 9, 20), reading('a', 9 - 50 / 60, 100)])
      .map((item) => ({ ...item, resetsUsed: [[NOW - 9 * HOUR, 'fable'], [NOW - 9 * HOUR + 50 * 60_000, 'weekly']] satisfies LimitTrendAccount['resetsUsed'] }));
    expect(historyMarks(readings, [account('a', 100, 72)], NOW - DAY, NOW)).toEqual([
      { atMs: NOW - 9 * HOUR, key: 'a', name: 'a', how: 'used', reset: 'fable', gain: 0 },
      { atMs: NOW - 9 * HOUR + 50 * 60_000, key: 'a', name: 'a', how: 'used', reset: 'weekly', gain: 80 },
    ]);
  });

  test('marks the resets the projection spends, named as the advice names them', () => {
    const a: ForecastAccount = { ...account('a', 20, 100, 1), lots: [{ count: 1, expiresAtMs: null, refills: true, reset: 'weekly' }] };
    const forecast = (countResets: boolean) => buildForecast({
      accounts: [a, account('b', 20, 30)], readings: [], settings: settings({ ratePerHour: 2, countResets }), horizonDays: 1, historyMs: DAY, nowMs: NOW,
    });
    expect(forecast(true).marks).toEqual([{ atMs: NOW + 20 * HOUR, key: 'a', name: 'a', how: 'planned', reset: 'weekly', gain: 100 }]);
    // Drawn without the suggestions, the projection spends none.
    expect(forecast(false).marks).toEqual([]);
  });

  test('keeps a mark on its step when the history is thinned', () => {
    // Three days of readings ten minutes apart, far more than the line draws, with a refill in the middle of them.
    const refillAt = 200;
    const readings: Reading[] = Array.from({ length: 433 }, (_, step) => ({
      account: 'a', reading: [NOW - (432 - step) * 10 * 60_000, step < refillAt ? 100 - step * 0.4 : 100 - (step - refillAt) * 0.1, RESET],
    }));
    const live = 100 - (432 - refillAt) * 0.1;
    const forecast = buildForecast({ accounts: [account('a', live, 72)], readings: trend(readings), settings: settings(), horizonDays: 3, historyMs: 3 * DAY, nowMs: NOW });
    expect(forecast.history.length).toBeLessThan(300);
    const mark = itemAt(forecast.marks, 0);
    expect(mark).toMatchObject({ how: 'early', atMs: NOW - (432 - refillAt) * 10 * 60_000 });
    expect(mark.gain).toBeCloseTo(100 - (100 - 199 * 0.4), 6);
    const at = forecast.history.findIndex((point) => point.t === mark.atMs);
    // The point at the refill, and the low just before it, both survive.
    expect(itemAt(forecast.history, at).left).toBe(100);
    expect(itemAt(forecast.history, at - 1)).toMatchObject({ t: mark.atMs - 10 * 60_000 });
    expect(itemAt(forecast.history, at - 1).left).toBeCloseTo(100 - 199 * 0.4, 6);
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
    // a resets long before it could run out, so its resets can't be used before they lapse.
    expect(forecast.advice.find((item) => item.kind === 'expiring')).toMatchObject({ key: 'a', count: 2, use: { how: 'none' } });
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

describe('which reset the forecast spends, and where', () => {
  type Claim = Extract<Advice, { kind: 'claim' }>;
  const hours = (atMs: number | undefined) => (atMs === undefined ? undefined : Math.round(((atMs - NOW) / HOUR) * 10) / 10);
  const claims = (accounts: ForecastAccount[], rate: number, horizonDays = 3) =>
    buildForecast({ accounts, readings: [], settings: settings({ ratePerHour: rate }), horizonDays, historyMs: DAY, nowMs: NOW })
      .advice.filter((item): item is Claim => item.kind === 'claim');
  const holding = (base: ForecastAccount, lot: Partial<CreditLot>): ForecastAccount =>
    ({ ...base, credits: lot.count ?? 1, lots: [{ count: 1, expiresAtMs: null, refills: true, ...lot }] });

  test('spends each reset an account holds as it runs out again', () => {
    // Alone, a runs out at 10h and every 50h after a reset: two of its three carry it past the forecast.
    const plan = claims([account('a', 20, 100, 3)], 2);
    expect(plan.map((item) => [hours(item.atMs), item.gainMs === null])).toEqual([[10, false], [60, true]]);
  });

  test('plans a reset on the last account out, at the moment the pool runs dry', () => {
    // At paces that don't divide evenly, rounding mustn't read that moment as already dry.
    [0.7, 1.3, 2.2, 3.1].forEach((rate) => {
      const plan = claims([account('a', 20, 100, 1), account('b', 17, 90)], rate);
      expect(plan.map((item) => [item.key, hours(item.atMs)])).toEqual([['a', Math.round((37 / rate) * 10) / 10]]);
    });
  });

  test('between resets that buy the same, spends the one that lapses sooner', () => {
    // Either reset carries the pool the same 50h; b's lapses at 60h and a's never does.
    const plan = claims([account('a', 20, 100, 1), account('b', 20, 101, 1, NOW + 60 * HOUR)], 2);
    expect(plan.map((item) => [item.key, hours(item.atMs), hours(item.lapsesAtMs)])).toEqual([['b', 20, 60], ['a', 10, undefined]]);
  });

  test("leaves an account about to reset on its own, and says which reset the pool is carried to", () => {
    // a resets by itself at 12h, so a reset there buys seven hours; b's own reset isn't until 100h.
    const own = claims([account('a', 10, 12, 1), account('b', 10, 100, 1)], 2);
    expect(own.map((item) => [item.key, hours(item.atMs), item.gainMs])).toEqual([['b', 10, null]]);
    expect(itemAt(own, 0).bridge).toEqual({ atMs: NOW + 12 * HOUR, names: ['a'] });
    // The pool would sit dry from 20h until b resets at 30h: a's reset gets it there, and it then lasts.
    const bridged = claims([account('a', 20, 100, 1), account('b', 20, 30)], 2);
    expect(bridged).toMatchObject([{ key: 'a', gainMs: null, bridge: { atMs: NOW + 30 * HOUR, names: ['b'] } }]);
  });

  test('spends a reset Claude takes early just before it lapses, when its account would run out too late', () => {
    // a runs out at 60h, long after its reset lapses at 20h. An hour before that it still has 41% left.
    const early = claims([holding(account('a', 60, 100), { reset: 'weekly', expiresAtMs: NOW + 20 * HOUR, anytime: true })], 1);
    expect(early).toMatchObject([{ key: 'a', reset: 'weekly', lapsesAtMs: NOW + 20 * HOUR, gainMs: null }]);
    expect([hours(itemAt(early, 0).atMs), Math.round(itemAt(early, 0).early ?? -1)]).toEqual([19, 41]);
    // One that waits for a limit can't be: nothing to plan.
    expect(claims([holding(account('a', 60, 100), { reset: 'weekly', expiresAtMs: NOW + 20 * HOUR })], 1)).toEqual([]);
  });

  test('sends work to an account first when that gets it to its limit before its reset lapses', () => {
    // b resets sooner, so a would wait its turn and run out at 20h, after its reset lapsed at 10h. First, it's out at 7.5h.
    const plan = claims([holding(account('a', 30, 100), { expiresAtMs: NOW + 10 * HOUR }), account('b', 50, 40)], 4);
    expect(plan).toMatchObject([{ key: 'a', first: true, lapsesAtMs: NOW + 10 * HOUR, bridge: { atMs: NOW + 40 * HOUR, names: ['b'] } }]);
    expect(hours(itemAt(plan, 0).atMs)).toBe(7.5);
    // It's a suggestion: what's drawn without the resets keeps a in its turn, running out at 20h.
    const drawn = buildForecast({
      accounts: [holding(account('a', 30, 100), { expiresAtMs: NOW + 10 * HOUR }), account('b', 50, 40)],
      readings: [], settings: settings({ ratePerHour: 4 }), horizonDays: 3, historyMs: DAY, nowMs: NOW,
    }).projection;
    expect([hours(drawn.emptyAtMs.b), hours(drawn.emptyAtMs.a)]).toEqual([12.5, 20]);
    // Too much left to get there in time: it keeps its turn, and the reset is flagged instead.
    const late = buildForecast({
      accounts: [holding(account('a', 90, 100), { expiresAtMs: NOW + 10 * HOUR }), account('b', 50, 40)],
      readings: [], settings: settings({ ratePerHour: 4 }), horizonDays: 3, historyMs: DAY, nowMs: NOW,
    });
    expect(late.advice.some((item) => item.kind === 'claim')).toBe(false);
    expect(late.advice.find((item) => item.kind === 'expiring')).toMatchObject({ key: 'a', use: { how: 'none' } });
  });

  test('in a pool that lasts, only points out an account that could go first for its reset', () => {
    // At 1% an hour the pool lasts. b resets sooner, so a (30% left) waits past its reset's lapse at 40h; first, it's out at 30h.
    const accounts = [holding(account('a', 30, 150), { expiresAtMs: NOW + 40 * HOUR }), account('b', 60, 70)];
    const forecast = buildForecast({ accounts, readings: [], settings: settings({ ratePerHour: 1 }), horizonDays: 3, historyMs: DAY, nowMs: NOW });
    expect(forecast.advice.some((item) => item.kind === 'claim')).toBe(false);
    expect(forecast.projection.dryAtMs).toBeNull();
    expect(hours(forecast.projection.emptyAtMs.b)).toBe(60);
    const lapsing = present(forecast.advice.find((item) => item.kind === 'expiring'));
    expect(lapsing.kind === 'expiring' && lapsing.use).toMatchObject({ how: 'atLimit', first: true });
    expect(hours(lapsing.kind === 'expiring' && lapsing.use.how === 'atLimit' ? lapsing.use.atMs : undefined)).toBe(30);
  });

  test('says how a reset that lapses unplanned could still be used', () => {
    const lapsing = (accounts: ForecastAccount[]) => {
      const forecast = buildForecast({ accounts, readings: [], settings: settings({ ratePerHour: 1 }), horizonDays: 2, historyMs: DAY, nowMs: NOW });
      const item = present(forecast.advice.find((advice) => advice.kind === 'expiring'));
      return { use: item.kind === 'expiring' ? item.use : null, lasts: forecast.advice.find((advice) => advice.kind === 'lasts') };
    };
    // The pool lasts, but a runs out at 10h with a reset that lapses at 40h: spare capacity then, not one to keep.
    const atLimit = lapsing([account('a', 10, 60, 1, NOW + 40 * HOUR), account('b', 100, 100)]);
    expect(atLimit.use).toMatchObject({ how: 'atLimit' });
    expect(hours(atLimit.use?.how === 'atLimit' ? atLimit.use.atMs : undefined)).toBe(10);
    expect(atLimit.lasts).toMatchObject({ credits: 0 });
    // Claude takes this one early: an hour before it lapses a has 31% left, so it refills 69%.
    const early = lapsing([holding(account('a', 50, 100), { reset: 'weekly', expiresAtMs: NOW + 20 * HOUR, anytime: true }), account('b', 100, 120)]);
    expect(early.use).toMatchObject({ how: 'early' });
    expect(Math.round(early.use?.how === 'early' ? early.use.percent : 0)).toBe(69);
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

  const offer = (kind: 'session' | 'weekly' | 'fable' | 'full', count: number, windows: string[], extra: Record<string, unknown> = {}) =>
    ({ kind, count, windows, ...extra });
  const banked = (kinds: ReturnType<typeof offer>[], extra: Record<string, unknown> = {}): QuotaState => ({
    status: 'success', rows: [], resetCredits: kinds.reduce((total, item) => total + item.count, 0), bankedReset: { kinds, ...extra },
  });

  test("counts Claude's banked resets unless Claude won't take them from here", () => {
    const full = [offer('full', 1, ['5-hour window', '7-day window'])];
    expect(creditLots(banked(full), '7-day window')).toEqual([{ reset: 'full', count: 1, expiresAtMs: null, refills: true }]);
    // One in a cooldown, or waiting for a limit, can still be planned.
    expect(creditLots(banked(full, { blockedReason: 'cooldown' }), '7-day window')).toMatchObject([{ refills: true }]);
    expect(creditLots(banked(full, { blockedReason: 'client', blockedHere: true }), '7-day window')).toEqual([]);
    expect(creditLots({ status: 'success', rows: [], resetCredits: 1 }, '7-day window')).toEqual([]);
  });

  // An account holding what claude.ai lists as "Fable reset · 3" and "Weekly reset".
  const mixed = banked([
    offer('weekly', 1, ['7-day window', '7-day Fable window'], { expiresAt: new Date(NOW + 2 * DAY).toISOString() }),
    offer('fable', 3, ['7-day Fable window'], { givesBackTo: '7-day window', expiresAt: new Date(NOW + 90 * DAY).toISOString() }),
    offer('full', 1, ['5-hour window', '7-day window', '7-day Fable window']),
  ]);

  test('plans only the resets that refill the window forecast, the narrowest first', () => {
    const lots = (window: string) => creditLots(mixed, window).map((lot) => [lot.reset, lot.count, lot.refills, lot.givesBack ?? false]);
    // Fable's allowance: the Fable reset, keeping the wider ones for limits only they lift.
    expect(lots('7-day Fable window')).toEqual([['fable', 3, true, false], ['weekly', 1, true, false], ['full', 1, true, false]]);
    // The week: a Fable reset doesn't refill it, it only hands some back.
    expect(lots('7-day window')).toEqual([['fable', 3, false, true], ['weekly', 1, true, false], ['full', 1, true, false]]);
    // The 5-hour limit: only the reset for everything.
    expect(lots('5-hour window')).toEqual([['fable', 3, false, false], ['weekly', 1, false, false], ['full', 1, true, false]]);
    const row = (label: string) => ({ ...mixed, rows: [{ label, remainingPercent: 40, resetAtMs: NOW + DAY }] });
    const credits = (label: string) => forecastAccounts(buildHeadline([{ name: 'a', quota: row(label) }], label), (item) => item.name)[0]?.credits;
    expect([credits('7-day Fable window'), credits('7-day window'), credits('5-hour window')]).toEqual([5, 2, 1]);
  });

  const pool = (window: string, rate: number, horizonDays = 3, others = [account('b', 20, 30)]) => {
    const a: ForecastAccount = { ...account('a', 20, 100), lots: creditLots(mixed, window), credits: 0 };
    a.credits = a.lots.reduce((total, lot) => (lot.refills ? total + lot.count : total), 0);
    return buildForecast({ accounts: [a, ...others], readings: [], settings: settings({ ratePerHour: rate }), horizonDays, historyMs: DAY, nowMs: NOW });
  };

  test('names the kind of reset to use, and never a Fable reset for the week', () => {
    // Out of Fable at 20h. The weekly reset refills Fable too and lapses a day later, so it goes before a Fable
    // reset with months left.
    expect(pool('7-day Fable window', 2).advice.find((item) => item.kind === 'claim')).toMatchObject({ key: 'a', atMs: NOW + 20 * HOUR, reset: 'weekly' });
    // With weeks left on the weekly reset, a Fable reset does it and the wider one is kept.
    const keeps = banked([
      offer('weekly', 1, ['7-day window', '7-day Fable window'], { expiresAt: new Date(NOW + 30 * DAY).toISOString() }),
      offer('fable', 3, ['7-day Fable window'], { givesBackTo: '7-day window', expiresAt: new Date(NOW + 90 * DAY).toISOString() }),
    ]);
    const a: ForecastAccount = { ...account('a', 20, 100, 4), lots: creditLots(keeps, '7-day Fable window') };
    const fable = buildForecast({ accounts: [a, account('b', 20, 30)], readings: [], settings: settings({ ratePerHour: 2 }), horizonDays: 3, historyMs: DAY, nowMs: NOW });
    expect(fable.advice.find((item) => item.kind === 'claim')).toMatchObject({ key: 'a', atMs: NOW + 20 * HOUR, reset: 'fable' });
    // Out of the week at 20h: the weekly reset, which is also the one about to lapse.
    const week = pool('7-day window', 2);
    expect(week.advice.filter((item) => item.kind === 'claim').map((item) => item.kind === 'claim' && item.reset)).toEqual(['weekly']);
    expect(week.advice.some((item) => item.kind === 'expiring')).toBe(false);
    expect(week.advice.some((item) => item.kind === 'givesBack')).toBe(false);
  });

  test('skips a reset that lapses before its account runs out, and says so', () => {
    // Alone at this pace, a runs out at 50h, after the weekly reset lapsed at 48h: the full one is planned and the
    // weekly one flagged.
    const slow = pool('7-day window', 0.4, 4, []);
    expect(slow.advice.filter((item) => item.kind === 'claim').map((item) => item.kind === 'claim' && item.reset)).toEqual(['full']);
    expect(slow.advice.find((item) => item.kind === 'expiring')).toMatchObject({ key: 'a', count: 1, reset: 'weekly', expiresAtMs: NOW + 2 * DAY });
  });

  test('mentions Fable resets when the week still runs dry, without counting them', () => {
    // Fast enough that the weekly and full resets aren't enough.
    const fast = pool('7-day window', 12);
    expect(fast.projection.dryAtMs).not.toBeNull();
    expect(fast.advice.filter((item) => item.kind === 'claim').map((item) => item.kind === 'claim' && item.reset)).toEqual(['weekly', 'full']);
    expect(fast.advice.find((item) => item.kind === 'givesBack')).toEqual({ kind: 'givesBack', key: 'a', name: 'a', count: 3 });
    expect(pool('5-hour window', 12).advice.some((item) => item.kind === 'givesBack')).toBe(false);
  });
});

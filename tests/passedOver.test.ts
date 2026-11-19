import { describe, expect, it } from 'bun:test';
import type { LimitTrendAccount } from '../src/native/types';
import { nextPassedOverAlerts, passedOverAccounts, type PassedOver, type RankedAccount } from '../src/services/passedOver';

const HOUR = 3_600_000;
const now = 2_000 * HOUR;
const resetAt = now + 72 * HOUR;

const ranked = (key: string, priority: number, percent: number | null, usable = true): RankedAccount => ({ key, name: key, priority, percent, usable });
/** Hourly readings ending now: `hours` of them, from `from` percent left to `to`. */
const trend = (account: string, hours: number, from: number, to: number): LimitTrendAccount => ({
  account, authIndex: account,
  readings: Array.from({ length: hours + 1 }, (_, index) => [now - (hours - index) * HOUR, from + ((to - from) * index) / hours, resetAt] as [number, number, number]),
});
const still = (account: string, hours: number, percent: number) => trend(account, hours, percent, percent);

describe('accounts the proxy passes over', () => {
  it('finds an account ahead in the order whose limits stood still while the ones behind it ran down', () => {
    const accounts = [ranked('work', 3, 43), ranked('side', 1, 0), ranked('home', 2, 60)];
    const readings = [still('work', 25, 43), trend('side', 25, 100, 0), trend('home', 25, 90, 60)];
    expect(passedOverAccounts(accounts, readings, now)).toEqual([
      { key: 'work', name: 'work', percent: 43, sinceMs: now - 25 * HOUR, by: 'side', used: 130 },
    ]);
  });

  it('measures the stretch from when the limits last moved, and counts only what was used since', () => {
    const work: LimitTrendAccount = { account: 'work', authIndex: 'work', readings: [...trend('work', 10, 60, 43).readings.map(([at, percent, reset]) => [at - 9 * HOUR, percent, reset] as [number, number, number]), ...still('work', 8, 43).readings] };
    const [found] = passedOverAccounts([ranked('work', 3, 43), ranked('side', 1, 20)], [work, trend('side', 20, 100, 20)], now);
    expect(found).toMatchObject({ sinceMs: now - 9 * HOUR, used: 36 });
  });

  it('says nothing about a short stretch, or one in which the accounts behind used little', () => {
    const accounts = [ranked('work', 3, 43), ranked('side', 1, 50)];
    expect(passedOverAccounts(accounts, [still('work', 5, 43), trend('side', 5, 90, 50)], now)).toEqual([]);
    expect(passedOverAccounts(accounts, [still('work', 25, 43), trend('side', 25, 60, 50)], now)).toEqual([]);
    // A refill on the account behind is not use.
    expect(passedOverAccounts(accounts, [still('work', 25, 43), trend('side', 25, 10, 50)], now)).toEqual([]);
  });

  it('only counts accounts strictly behind it: a shared place may be taking turns', () => {
    const readings = [still('work', 25, 43), trend('side', 25, 100, 20)];
    expect(passedOverAccounts([ranked('work', 1, 43), ranked('side', 1, 20)], readings, now)).toEqual([]);
    expect(passedOverAccounts([ranked('work', 0, 43), ranked('side', 1, 20)], readings, now)).toEqual([]);
  });

  it('leaves out an account that couldn’t serve, is nearly out or has no recent reading', () => {
    const side = ranked('side', 1, 20);
    const used = trend('side', 25, 100, 20);
    expect(passedOverAccounts([ranked('work', 3, 43, false), side], [still('work', 25, 43), used], now)).toEqual([]);
    expect(passedOverAccounts([ranked('work', 3, 6), side], [still('work', 25, 6), used], now)).toEqual([]);
    expect(passedOverAccounts([ranked('work', 3, null), side], [still('work', 25, 43), used], now)).toEqual([]);
    expect(passedOverAccounts([ranked('work', 3, 43), side], [used], now)).toEqual([]);
    const old = still('work', 25, 43);
    expect(passedOverAccounts([ranked('work', 3, 43), side], [{ ...old, readings: old.readings.slice(0, -4) }, used], now)).toEqual([]);
  });
});

describe('telling about a passed-over account once', () => {
  const found = (sinceMs: number): PassedOver => ({ key: 'work', name: 'work', percent: 43, sinceMs, by: 'side', used: 30 });

  it('tells once for a stretch, however far back the readings reach, and again for a new one', () => {
    const first = nextPassedOverAlerts({}, [found(now - 25 * HOUR)], ['work', 'side'], now);
    expect(first).toMatchObject({ notified: { work: now }, changed: true });
    expect(first.fresh).toHaveLength(1);
    // Two days on, the readings only reach back 48 hours, so the stretch seems to start later. It began before the alert.
    const later = nextPassedOverAlerts(first.notified, [found(now - HOUR)], ['work', 'side'], now + 47 * HOUR);
    expect(later).toMatchObject({ fresh: [], changed: false });
    // Its limits moved, then stood still again.
    const again = nextPassedOverAlerts(first.notified, [found(now + 50 * HOUR)], ['work', 'side'], now + 60 * HOUR);
    expect(again.fresh).toHaveLength(1);
    expect(again.notified).toEqual({ work: now + 60 * HOUR });
  });

  it('keeps what it told about while the account is listed, and forgets it after', () => {
    expect(nextPassedOverAlerts({ work: now }, [], ['work'], now + HOUR)).toMatchObject({ notified: { work: now }, changed: false });
    expect(nextPassedOverAlerts({ work: now }, [], ['side'], now + HOUR)).toMatchObject({ notified: {}, changed: true });
  });
});

import type { LimitTrendAccount } from '../native/types';

/*
 * An account the proxy should be using and isn't: it's ahead in the order with limit left, yet its limits haven't
 * moved for hours while accounts behind it ran down. Whatever the cause (a rest the proxy never dropped, a credential
 * it lost track of), the limits page shows the account on and full, so nothing else says so.
 */

const HOUR = 3_600_000;
/**
 * How long an account's limits have to stand still before it counts, and how much of the window the accounts behind
 * it have to use meanwhile, in percent of one account. Both are wide on purpose: a session stays with the account it
 * started on, so an account behind can run down for a while beside one ahead that only new sessions reach.
 */
export const PASSED_OVER_MIN_MS = 6 * HOUR;
export const PASSED_OVER_MIN_USED = 15;
/** Below this the account goes last in the order anyway (`ROUTING_LOW_PERCENT`). */
export const PASSED_OVER_MIN_LEFT = 10;
/** How far back the readings are looked at, so a stretch longer than this reads as this long. */
export const PASSED_OVER_LOOKBACK_MS = 48 * HOUR;
/** A reading older than this says nothing about now. */
const LATEST_MAX_AGE_MS = 2 * HOUR;
/** Readings this close are the same: the provider rounds them. */
const STILL_PERCENT = 0.5;

export type RankedAccount = {
  key: string;
  name: string;
  /** Its place in the order: the proxy uses the highest first. */
  priority: number;
  /** What's left of the window the readings are of, or null when that isn't known. */
  percent: number | null;
  /** Whether it could take a request now: on, signed in, every limit with some left, not kept for certain models. */
  usable: boolean;
};

export type PassedOver = {
  key: string;
  name: string;
  percent: number;
  /** When its limits last moved, as far back as the readings go. */
  sinceMs: number;
  /** The account behind it that used the most meanwhile, and how much all of them used. */
  by: string;
  used: number;
};

type Reading = LimitTrendAccount['readings'][number];

/** What an account used after `sinceMs`: every drop between one reading and the next. A rise is a refill, not use. */
const usedSince = (readings: Reading[], sinceMs: number) => readings.reduce((used, [atMs, percent], index) => {
  const before = readings[index - 1];
  return before && before[0] >= sinceMs && atMs > sinceMs ? used + Math.max(0, before[1] - percent) : used;
}, 0);

/**
 * The accounts passed over, on one provider's window. `readings` are that window's, oldest first for each account, as
 * `get_limit_trend` gives them. Only an account strictly ahead of the ones being used counts: accounts sharing a place
 * may take turns or be used one after another, depending on a setting this doesn't read.
 */
export function passedOverAccounts(accounts: RankedAccount[], readings: LimitTrendAccount[], nowMs: number): PassedOver[] {
  const byKey = new Map(readings.map((account) => [account.account, account.readings]));
  return accounts.flatMap((account): PassedOver[] => {
    if (!account.usable || account.percent === null || account.percent < PASSED_OVER_MIN_LEFT) return [];
    const own = byKey.get(account.key) ?? [];
    const latest = own[own.length - 1];
    if (!latest || nowMs - latest[0] > LATEST_MAX_AGE_MS) return [];
    let sinceMs = latest[0];
    for (let index = own.length - 2; index >= 0; index -= 1) {
      const reading = own[index];
      if (!reading || Math.abs(reading[1] - latest[1]) > STILL_PERCENT) break;
      sinceMs = reading[0];
    }
    if (nowMs - sinceMs < PASSED_OVER_MIN_MS) return [];
    const behind = accounts
      .filter((other) => other.key !== account.key && other.priority < account.priority)
      .map((other) => ({ name: other.name, used: usedSince(byKey.get(other.key) ?? [], sinceMs) }))
      .sort((a, b) => b.used - a.used);
    const used = behind.reduce((total, other) => total + other.used, 0);
    const [most] = behind;
    if (!most || used < PASSED_OVER_MIN_USED) return [];
    return [{ key: account.key, name: account.name, percent: account.percent, sinceMs, by: most.name, used }];
  });
}

/**
 * Picks the accounts to tell about. `notified` holds when each was last told about, so one stretch notifies once: a
 * new one can only begin after that, when the account's limits moved again. Entries for accounts no longer listed go.
 */
export function nextPassedOverAlerts(notified: Record<string, number>, found: PassedOver[], listed: string[], nowMs: number) {
  const next: Record<string, number> = {};
  listed.forEach((key) => {
    if (notified[key] !== undefined) next[key] = notified[key];
  });
  const fresh = found.filter((item) => item.sinceMs >= (next[item.key] ?? 0));
  fresh.forEach((item) => { next[item.key] = nowMs; });
  const keys = Object.keys(next);
  const changed = fresh.length > 0 || keys.length !== Object.keys(notified).length;
  return { notified: next, fresh, changed };
}

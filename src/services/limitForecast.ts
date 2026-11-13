/**
 * The forecast on Accounts › Limits: how a provider's pool of accounts has drained, how fast it drains, when it runs
 * dry at that pace, and when a banked or manual reset is worth spending.
 *
 * Everything is in summed percent: each account is worth 100%, so six accounts are 600% and a reset adds back what
 * the account had used. Spend is read from the limit history (`get_limit_trend`): a drop between two readings of the
 * same window cycle. A reset or a claimed credit raises the figure but isn't spend. A reset that was used is marked
 * where the pool rose: named when Arbor used it, since the limit history then says which it was.
 */
import type { LimitTrendAccount } from '../native/types';
import { rowWindowMs, windowDurationMs, type Headline } from './accountLimits';
import { simulatePool, type PoolAccount, type PoolPoint, type PoolRun } from './poolSimulation';
import type { ClaudeResetKind } from './quotaService';
import { creditLots, type CreditLot } from './resetLots';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Readings with reset times this close belong to the same cycle; a countdown drifts by seconds between refreshes. */
const SAME_RESET_MS = HOUR;
/** The history the forecast reads: the most `get_limit_trend` gives. */
export const FORECAST_HISTORY_MS = 28 * DAY;
/** The weekly pattern needs a full week of readings before it's used; until then the recent average stands in. */
export const WEEKLY_MIN_COVERAGE_MS = WEEK;
/** How much an hour of the week leans on the recent average: as much as one week's sample of it. */
const WEEKLY_PRIOR_WEIGHT = 1;
/** A recent average needs this much watched time to mean anything. */
const MIN_WATCHED_MS = 2 * HOUR;
/** Capacity a reset hands back unspent that's worth a mention, as `EXPIRING_MIN_PERCENT` is for one account. */
export const UNUSED_MIN_PERCENT = 30;
/** Most "use a reset" suggestions at once. */
const MOST_CLAIMS = 3;
const MAX_HISTORY_POINTS = 240;
/** Resets this close together read as one. */
const SAME_MOMENT_MS = 5 * 60_000;
/** Two resets that buy within this of each other are as good as each other, so the one lapsing sooner is spent. */
const SAME_GAIN_MS = HOUR;
/** A reset lapsing this soon after it could be used goes before a narrower one that keeps: it's lost otherwise. */
const LAPSING_SOON_MS = 3 * DAY;
/** How long before a reset lapses the plan spends one Claude takes early. */
const EARLY_MARGIN_MS = HOUR;
/** A reset spent early is worth a mention when it refills at least this much. */
const EARLY_MIN_PERCENT = 10;
/** A claim lands this long after the account's last one at least, so rounding can't read one run-out as two. */
const CLAIM_GAP_MS = 1000;
/** A rise before the window's reset with no reset on record is marked from this size; less is a provider's rounding. */
export const EARLY_REFILL_MIN_PERCENT = 5;
/** A reset Arbor used is put down to a rise from this size, read within `USED_MATCH_MS` of it. */
const USED_RISE_MIN_PERCENT = 1;
const USED_MATCH_MS = HOUR;

export type ForecastModel = 'weekly' | 'recent';
export type ForecastSettings = {
  model: ForecastModel;
  /** How far back the recent average looks. */
  lookbackDays: number;
  /** A spend rate in percent an hour that replaces the measured one; null measures it. */
  ratePerHour: number | null;
  /** Spend banked and manual resets in the projection, as the advice would. */
  countResets: boolean;
};
export const FORECAST_LOOKBACK_OPTIONS = [1, 3, 7, 14] as const;
export const FORECAST_HORIZON_OPTIONS = [1, 3, 7, 14] as const;

export type ForecastAccount = PoolAccount & {
  name: string;
  /** Resets that refill the forecast's window: the `lots` that do, added up. */
  credits: number;
  /** What the account holds, the one to spend first leading. */
  lots: CreditLot[];
};

/**
 * The accounts a headline's forecast plays forward: those in use with a reading. Turned-off ones can't be spent, so
 * they count toward neither what's left nor the capacity.
 */
export function forecastAccounts(headline: Headline, keyOf: (account: Headline['segments'][number]['account']) => string): ForecastAccount[] {
  const labelMs = headline.label ? windowDurationMs(headline.label) : null;
  return headline.segments.flatMap((segment) => {
    if (segment.off || segment.percent === null) return [];
    const row = segment.row;
    const resetAtMs = row?.resetAtMs !== undefined && Number.isFinite(row.resetAtMs) ? row.resetAtMs : null;
    const lots = creditLots(segment.account.quota, row?.label ?? headline.label);
    return [{
      key: keyOf(segment.account),
      name: segment.account.name,
      left: Math.max(0, Math.min(100, segment.percent)),
      resetAtMs,
      windowMs: row ? rowWindowMs(row) : labelMs,
      credits: lots.reduce((total, lot) => (lot.refills ? total + lot.count : total), 0),
      lots,
    }];
  });
}

type Reading = { t: number; left: number; resetAtMs: number | null };

/** Whether two readings are of one window cycle: their reset times agree, or neither has one. */
const sameCycle = (before: Reading, after: Reading) => (before.resetAtMs === null || after.resetAtMs === null
  ? before.resetAtMs === after.resetAtMs
  : Math.abs(before.resetAtMs - after.resetAtMs) <= SAME_RESET_MS);

/** The accounts' readings, by account, in time order, with the live limits' figure last. */
function byAccount(trend: LimitTrendAccount[], accounts: ForecastAccount[], nowMs: number) {
  const keys = new Set(accounts.map((account) => account.key));
  const grouped = new Map<string, Reading[]>();
  trend.forEach(({ account, readings }) => {
    if (!keys.has(account)) return;
    const list = grouped.get(account) ?? [];
    readings.forEach(([t, left, resetAtMs]) => { if (t <= nowMs) list.push({ t, left, resetAtMs }); });
    grouped.set(account, list);
  });
  accounts.forEach((account) => {
    const list = grouped.get(account.key) ?? [];
    list.sort((a, b) => a.t - b.t);
    const last = list[list.length - 1];
    if (!last || last.t < nowMs) list.push({ t: nowMs, left: account.left, resetAtMs: account.resetAtMs });
    grouped.set(account.key, list);
  });
  return grouped;
}

/**
 * The pool's summed figure over time. Each account holds its last reading until the next; before its first, its first
 * stands in, so an account added lately doesn't read as an empty one. Thinned to a few hundred points, with those at
 * the `marked` times kept, and the one before each, so a mark sits on the step it's about.
 */
export function poolHistory(readings: LimitTrendAccount[], accounts: ForecastAccount[], sinceMs: number, nowMs: number, marked: number[] = []): PoolPoint[] {
  const grouped = [...byAccount(readings, accounts, nowMs).values()];
  const times = [...new Set(grouped.flatMap((list) => list.map((item) => item.t)).filter((t) => t >= sinceMs))].sort((a, b) => a - b);
  if (!times.length) return [];
  const cursors = grouped.map(() => 0);
  const points = times.map((t) => {
    let left = 0;
    grouped.forEach((list, index) => {
      let cursor = cursors[index] ?? 0;
      while (cursor + 1 < list.length && (list[cursor + 1]?.t ?? Number.POSITIVE_INFINITY) <= t) cursor += 1;
      cursors[index] = cursor;
      left += list[cursor]?.left ?? 0;
    });
    return { t, left };
  });
  if (points.length <= MAX_HISTORY_POINTS) return points;
  // Keep the last point of each slice, plus the first, so steps and the live figure stay where they are.
  const slice = (nowMs - (points[0]?.t ?? nowMs)) / MAX_HISTORY_POINTS;
  const keep = new Set(marked);
  const thinned: PoolPoint[] = [];
  points.forEach((point, index) => {
    const next = points[index + 1];
    if (index === 0 || !next || keep.has(point.t) || keep.has(next.t)
      || Math.floor((next.t - sinceMs) / slice) !== Math.floor((point.t - sinceMs) / slice)) thinned.push(point);
  });
  return thinned;
}

/** A reset that was used, or one the projection spends, as a point on the chart. */
export type ResetMark = {
  atMs: number;
  key: string;
  name: string;
  /**
   * `used`: a reset Arbor used. `early`: the account rose before its window's reset with no reset on record, as one
   * used elsewhere reads. `planned`: a reset the projection spends.
   */
  how: 'used' | 'early' | 'planned';
  /** Which Claude reset. Unset for Codex's reset, and for a rise with none on record. */
  reset?: ClaudeResetKind;
  /** Percent of one account it added back; 0 when the readings show no rise for it. */
  gain: number;
};

/**
 * The resets used since `sinceMs`, from the limit history. A reset Arbor used is on record with its kind, and is put
 * where the account rose around then; with no rise to show for it (a Fable reset may hand back nothing) it's marked
 * when it was used. Any other rise that the window's own reset doesn't explain is marked as an early refill.
 */
export function historyMarks(readings: LimitTrendAccount[], accounts: ForecastAccount[], sinceMs: number, nowMs: number): ResetMark[] {
  const names = new Map(accounts.map((account) => [account.key, account.name]));
  const marks: ResetMark[] = [];
  byAccount(readings, accounts, nowMs).forEach((list, key) => {
    const name = names.get(key) ?? key;
    const rises = list.flatMap((after, index) => {
      const before = list[index - 1];
      if (!before || after.t < sinceMs || after.left <= before.left) return [];
      const onSchedule = !sameCycle(before, after) && before.resetAtMs !== null && before.resetAtMs <= after.t;
      return [{ atMs: after.t, gain: after.left - before.left, onSchedule }];
    });
    type Rise = (typeof rises)[number];
    const used = readings
      .flatMap((account) => (account.account === key ? account.resetsUsed ?? [] : []))
      .filter(([atMs]) => atMs >= sinceMs && atMs <= nowMs)
      .sort((a, b) => a[0] - b[0])
      .map(([atMs, reset]) => ({ atMs, reset }));
    // Each reset takes the rise read nearest it, the closest pairs first, so one with nothing to show for it can't
    // take the rise of another used soon after. A reset used just as the window resets is what refilled it, so a
    // rise on schedule can be its rise too.
    const riseOf = new Map<(typeof used)[number], Rise>();
    const taken = new Set<Rise>();
    used
      .flatMap((reset) => rises.flatMap((rise) => {
        const apart = Math.abs(rise.atMs - reset.atMs);
        return rise.gain >= USED_RISE_MIN_PERCENT && apart <= USED_MATCH_MS ? [{ reset, rise, apart }] : [];
      }))
      .sort((a, b) => a.apart - b.apart)
      .forEach(({ reset, rise }) => {
        if (riseOf.has(reset) || taken.has(rise)) return;
        riseOf.set(reset, rise);
        taken.add(rise);
      });
    used.forEach((item) => {
      const rise = riseOf.get(item);
      marks.push({ atMs: rise?.atMs ?? item.atMs, key, name, how: 'used', ...(item.reset === 'manual' ? {} : { reset: item.reset }), gain: rise?.gain ?? 0 });
    });
    rises.forEach((rise) => {
      if (taken.has(rise) || rise.onSchedule || rise.gain < EARLY_REFILL_MIN_PERCENT) return;
      marks.push({ atMs: rise.atMs, key, name, how: 'early', gain: rise.gain });
    });
  });
  return marks.sort((a, b) => a.atMs - b.atMs);
}

export type SpendHistory = {
  /** Percent spent in each hour, oldest first, from `startMs`. */
  hours: number[];
  startMs: number;
  /** The first reading of any account in the pool; nothing before it is known. */
  watchedFromMs: number | null;
};

/**
 * How much of the pool was spent each hour. A drop between two readings of one cycle is spread evenly between them,
 * so a gap while Arbor was closed still counts. Across a reset, what's gone since the reset is counted from 100%.
 * A refill that isn't a reset (a credit claimed) counts nothing.
 */
export function spendByHour(readings: LimitTrendAccount[], accounts: ForecastAccount[], sinceMs: number, nowMs: number): SpendHistory {
  const startMs = Math.floor(sinceMs / HOUR) * HOUR;
  const hours = Array.from({ length: Math.max(0, Math.ceil((nowMs - startMs) / HOUR)) }, () => 0);
  let watchedFromMs: number | null = null;
  const spread = (fromMs: number, toMs: number, amount: number) => {
    if (amount <= 0) return;
    if (toMs <= fromMs) {
      const index = Math.floor((toMs - startMs) / HOUR);
      if (index >= 0 && index < hours.length) hours[index] = (hours[index] ?? 0) + amount;
      return;
    }
    const perMs = amount / (toMs - fromMs);
    for (let t = fromMs; t < toMs;) {
      const index = Math.floor((t - startMs) / HOUR);
      const end = Math.min(toMs, startMs + (index + 1) * HOUR);
      if (index >= 0 && index < hours.length) hours[index] = (hours[index] ?? 0) + perMs * (end - t);
      t = end;
    }
  };
  byAccount(readings, accounts, nowMs).forEach((list) => {
    const watched = list.filter((item) => item.t >= sinceMs);
    const first = watched[0];
    // The live figure alone says nothing about the past.
    if (first && watched.length > 1) watchedFromMs = watchedFromMs === null ? first.t : Math.min(watchedFromMs, first.t);
    for (let index = 1; index < list.length; index += 1) {
      const before = list[index - 1];
      const after = list[index];
      if (!before || !after || after.t < sinceMs) continue;
      const fromMs = Math.max(before.t, sinceMs);
      if (sameCycle(before, after)) {
        spread(fromMs, after.t, before.left - after.left);
      } else if (before.resetAtMs !== null && before.resetAtMs <= after.t) {
        spread(Math.max(fromMs, before.resetAtMs), after.t, 100 - after.left);
      }
    }
  });
  return { hours, startMs, watchedFromMs };
}

export type Burn = {
  /** What the rate comes from: the user's own figure, the weekly pattern, the recent average, or each window so far. */
  basis: 'manual' | 'weekly' | 'recent' | 'window';
  /** The weekly pattern was asked for but there isn't a week of readings yet. */
  fellBack: boolean;
  /** Percent of one account spent an hour, on average over the next day. */
  perHour: number;
  /** Percent of one account spent per ms at a time. */
  rateAt: (atMs: number) => number;
};

const hourOfWeek = (atMs: number) => {
  const date = new Date(atMs);
  return date.getDay() * 24 + date.getHours();
};

/**
 * Each account's average spend since its window began, added up: what the headline's pace color uses, and what the
 * forecast falls back on before there's any history.
 */
function windowRatePerHour(accounts: ForecastAccount[], nowMs: number): number {
  return accounts.reduce((total, account) => {
    if (account.resetAtMs === null || account.windowMs === null || account.resetAtMs <= nowMs) return total;
    const elapsedMs = Math.max(0.05 * account.windowMs, Math.min(account.windowMs, account.windowMs - (account.resetAtMs - nowMs)));
    return total + ((100 - account.left) / elapsedMs) * HOUR;
  }, 0);
}

export function burnRate(spend: SpendHistory, accounts: ForecastAccount[], settings: ForecastSettings, nowMs: number): Burn {
  const steady = (basis: Burn['basis'], perHour: number, fellBack = false): Burn =>
    ({ basis, fellBack, perHour: Math.max(0, perHour), rateAt: () => Math.max(0, perHour) / HOUR });
  if (settings.ratePerHour !== null && settings.ratePerHour >= 0) return steady('manual', settings.ratePerHour);
  const total = (fromMs: number) => spend.hours.reduce((sum, value, index) => (spend.startMs + (index + 1) * HOUR > fromMs ? sum + value : sum), 0);
  const watched = spend.watchedFromMs;
  const recentFrom = Math.max(nowMs - settings.lookbackDays * DAY, watched ?? nowMs);
  const recentMs = nowMs - recentFrom;
  const recent = recentMs >= MIN_WATCHED_MS ? (total(recentFrom) / recentMs) * HOUR : null;
  const wantsWeekly = settings.model === 'weekly';
  if (recent === null) return steady('window', windowRatePerHour(accounts, nowMs), wantsWeekly);
  if (!wantsWeekly || watched === null || nowMs - watched < WEEKLY_MIN_COVERAGE_MS) return steady('recent', recent, wantsWeekly);
  // Each hour of the week: what was spent in it over the weeks watched, leaning on the recent average so one odd
  // week doesn't set it.
  const spent = Array.from({ length: 168 }, () => 0);
  const seen = Array.from({ length: 168 }, () => 0);
  spend.hours.forEach((value, index) => {
    const t = spend.startMs + index * HOUR;
    if (t < watched || t >= nowMs) return;
    const slot = hourOfWeek(t);
    spent[slot] = (spent[slot] ?? 0) + value;
    seen[slot] = (seen[slot] ?? 0) + 1;
  });
  const profile = spent.map((value, slot) => (value + recent * WEEKLY_PRIOR_WEIGHT) / ((seen[slot] ?? 0) + WEEKLY_PRIOR_WEIGHT));
  const perHourAt = (atMs: number) => profile[hourOfWeek(atMs)] ?? recent;
  let nextDay = 0;
  for (let hour = 0; hour < 24; hour += 1) nextDay += perHourAt(nowMs + hour * HOUR);
  return { basis: 'weekly', fellBack: false, perHour: nextDay / 24, rateAt: (atMs) => perHourAt(atMs) / HOUR };
}

/** The regular reset a planned reset carries the pool to: when, and whose. */
export type Bridge = { atMs: number; names: string[] };

/** What to do with a reset that lapses within the forecast and isn't in the plan. */
export type LapsingUse =
  /** Its account runs out before it lapses: use it then. `first`: only if work goes to that account ahead of its turn. */
  | { how: 'atLimit'; atMs: number; first?: true }
  /** Claude takes it early: spent just before it lapses it refills this much of the account. */
  | { how: 'early'; percent: number }
  /** Its account can't run out in time at this pace. */
  | { how: 'none' };

export type Advice =
  /**
   * Use a reset on an account: the pool would otherwise run dry first. `gainMs` null: it then lasts. `reset` is which
   * Claude reset to use.
   */
  | {
    kind: 'claim'; key: string; name: string; atMs: number; gainMs: number | null; reset?: ClaudeResetKind;
    /** When it lapses, when that's within the forecast: why it's the one to spend. */
    lapsesAtMs?: number;
    /** Spent before the account runs out, since it lapses first: the percent still left on the account then. */
    early?: number;
    /** The account only runs out in time if work goes to it ahead of its turn. */
    first?: true;
    bridge?: Bridge;
  }
  /** Even with every reset spent the pool runs dry: this pace would last. */
  | { kind: 'slow'; perHour: number }
  /** Resets that lapse within the forecast with no place in the plan. */
  | { kind: 'expiring'; key: string; name: string; count: number; expiresAtMs: number; reset?: ClaudeResetKind; use: LapsingUse }
  /** Fable resets on an account of a pool that runs dry: they hand some of this window back, but not a known amount. */
  | { kind: 'givesBack'; key: string; name: string; count: number }
  /** Capacity that resets before it's spent, by `byMs`: room to spend more. */
  | { kind: 'unused'; percent: number; byMs: number }
  /** The pool lasts the whole horizon, with `credits` resets left over that outlive it. */
  | { kind: 'lasts'; untilMs: number; credits: number };

export type Forecast = {
  /** Every account in the pool at 100%. */
  capacity: number;
  left: number;
  burn: Burn;
  history: PoolPoint[];
  spend: SpendHistory;
  /** The projection drawn: with the suggested resets spent when `countResets` is on. */
  projection: PoolRun;
  /** The resets used over the chart's history, and those the projection spends, oldest first. */
  marks: ResetMark[];
  /** The first reset that hands something back, and how much. */
  nextRefill: { atMs: number; gain: number } | null;
  advice: Advice[];
  horizonEndMs: number;
};

type PlannedClaim = { key: string; atMs: number; lot: CreditLot };
type ClaimStep = Omit<Extract<Advice, { kind: 'claim' }>, 'kind' | 'name' | 'bridge'> & { bridge?: { atMs: number; keys: string[] } };
type Simulate = (claims: { key: string; atMs: number }[]) => PoolRun;

const usedOf = (claims: PlannedClaim[], lot: CreditLot) => claims.filter((claim) => claim.lot === lot).length;
const lastClaimMs = (claims: PlannedClaim[], key: string) =>
  claims.reduce((last, claim) => (claim.key === key ? Math.max(last, claim.atMs) : last), Number.NEGATIVE_INFINITY);
/** When an account next runs out after the resets already planned for it. */
const nextEmptyMs = (run: PoolRun, claims: PlannedClaim[], key: string) => {
  const after = lastClaimMs(claims, key) + CLAIM_GAP_MS;
  return run.emptied[key]?.find((atMs) => atMs > after);
};
const lapsesWithin = (lot: CreditLot, fromMs: number, toMs: number): lot is CreditLot & { expiresAtMs: number } =>
  lot.expiresAtMs !== null && lot.expiresAtMs > fromMs && lot.expiresAtMs <= toMs;

/**
 * The lot a claim at a time spends, of those that refill the window, have a reset left and haven't lapsed: one about
 * to lapse first, the soonest leading, since it's lost otherwise; then the account's own order, narrowest first. A
 * wider reset with weeks left stays behind the narrower one, for the limits only it lifts.
 */
const lotFor = (account: ForecastAccount, claims: PlannedClaim[], atMs: number) => {
  const alive = account.lots.filter((lot) => lot.refills && lot.count - usedOf(claims, lot) > 0 && (lot.expiresAtMs === null || lot.expiresAtMs > atMs));
  const lapsing = alive.filter((lot) => lapsesWithin(lot, atMs, atMs + LAPSING_SOON_MS)).sort((a, b) => (a.expiresAtMs ?? 0) - (b.expiresAtMs ?? 0));
  return lapsing[0] ?? alive[0];
};

/** A reset Claude takes early that lapses before its account next runs out, and when the plan would spend it. */
const earlyClaim = (account: ForecastAccount, claims: PlannedClaim[], emptyAtMs: number | undefined, nowMs: number) => {
  const lot = account.lots
    .filter((item) => item.anytime && item.refills && item.count - usedOf(claims, item) > 0 && lapsesWithin(item, nowMs, emptyAtMs ?? Number.POSITIVE_INFINITY))
    .sort((a, b) => (a.expiresAtMs ?? 0) - (b.expiresAtMs ?? 0))[0];
  if (!lot || lot.expiresAtMs === null) return null;
  const atMs = Math.max(nowMs, lot.expiresAtMs - EARLY_MARGIN_MS);
  return atMs > lastClaimMs(claims, account.key) + CLAIM_GAP_MS ? { atMs, lot } : null;
};

/** How much an account had left when a planned reset refilled it. */
const leftAtClaim = (run: PoolRun, key: string, atMs: number) =>
  run.events.find((event) => event.kind === 'credit' && event.key === key && Math.abs(event.atMs - atMs) < CLAIM_GAP_MS)?.before;

/** The first regular reset that hands something back after the pool would have run dry, when the pool now reaches it. */
const bridgeAfter = (run: PoolRun, dryAtMs: number) => {
  const first = run.events.find((event) => event.kind === 'reset' && event.before < 100 && event.atMs >= dryAtMs);
  if (!first || (run.dryAtMs !== null && run.dryAtMs < first.atMs)) return undefined;
  const keys = run.events
    .filter((event) => event.kind === 'reset' && event.before < 100 && Math.abs(event.atMs - first.atMs) <= SAME_MOMENT_MS)
    .map((event) => event.key);
  return { atMs: first.atMs, keys: [...new Set(keys)] };
};

/**
 * The accounts as the plan spends them: one holding a reset that lapses within the forecast goes ahead of its turn
 * when that, and only that, has it run out in time to use the reset. The account order makes the same call, and
 * moves the account only when the user has asked it to.
 */
function spendFirst(accounts: ForecastAccount[], simulate: (pool: ForecastAccount[]) => PoolRun, nowMs: number, horizonEndMs: number): ForecastAccount[] {
  const lapsing = accounts.flatMap((account) => {
    const useBy = account.lots
      .flatMap((lot) => (lot.refills && lapsesWithin(lot, nowMs, horizonEndMs) ? Array.from({ length: lot.count }, () => lot.expiresAtMs) : []))
      .sort((a, b) => a - b);
    const firstMs = useBy[0];
    return firstMs === undefined ? [] : [{ key: account.key, useBy, firstMs }];
  }).sort((a, b) => a.firstMs - b.firstMs);
  let pool = accounts;
  for (const item of lapsing) {
    const inTime = (run: PoolRun) => (run.emptied[item.key]?.[0] ?? Number.POSITIVE_INFINITY) <= item.firstMs;
    if (inTime(simulate(pool))) continue;
    const trial = pool.map((account) => (account.key === item.key ? { ...account, useBy: item.useBy } : account));
    if (inTime(simulate(trial))) pool = trial;
  }
  return pool;
}

/**
 * Greedy plan for the resets: while the pool runs dry, spend the one that buys the most time, on an account that runs
 * out before the pool does, at the moment it runs out (the most a reset can refill). Each account's own reset is in
 * the simulation, so a reset just before one buys little and loses to another account's. Between resets that buy
 * about the same, the one lapsing sooner goes. A reset Claude takes early that would lapse first is spent just
 * before it does.
 */
function planClaims(accounts: ForecastAccount[], run: Simulate, nowMs: number, horizonEndMs: number, unaided: PoolRun) {
  type Candidate = { key: string; atMs: number; lot: CreditLot; early: boolean; result: PoolRun; gain: number };
  const claims: PlannedClaim[] = [];
  const steps: ClaimStep[] = [];
  const lapse = (candidate: Candidate) => candidate.lot.expiresAtMs ?? Number.POSITIVE_INFINITY;
  const beats = (a: Candidate, b: Candidate) => {
    const same = a.gain === b.gain || Math.abs(a.gain - b.gain) <= SAME_GAIN_MS;
    if (!same) return a.gain > b.gain;
    return lapse(a) === lapse(b) ? a.gain > b.gain : lapse(a) < lapse(b);
  };
  let base = run(claims);
  while (base.dryAtMs !== null && steps.length < MOST_CLAIMS) {
    const dryAtMs = base.dryAtMs;
    let best: Candidate | null = null;
    for (const account of accounts) {
      const emptyAtMs = nextEmptyMs(base, claims, account.key);
      const atLimit = emptyAtMs !== undefined && emptyAtMs <= dryAtMs ? lotFor(account, claims, emptyAtMs) : undefined;
      const early = earlyClaim(account, claims, emptyAtMs, nowMs);
      const tries = [
        ...(atLimit && emptyAtMs !== undefined ? [{ atMs: emptyAtMs, lot: atLimit, early: false }] : []),
        ...(early ? [{ ...early, early: true }] : []),
      ];
      for (const item of tries) {
        const result = run([...claims, { key: account.key, atMs: item.atMs }]);
        const candidate = { key: account.key, ...item, result, gain: (result.dryAtMs ?? Number.POSITIVE_INFINITY) - dryAtMs };
        if (candidate.gain > 0 && (!best || beats(candidate, best))) best = candidate;
      }
    }
    if (!best) break;
    const { key, atMs, lot } = best;
    const lapsesAtMs = lapsesWithin(lot, nowMs, horizonEndMs) ? lot.expiresAtMs : undefined;
    const left = best.early ? leftAtClaim(best.result, key, atMs) : undefined;
    // Its first reset only: whether the account reaches its limit in time without going ahead of its turn.
    const first = !best.early && lapsesAtMs !== undefined && !claims.some((claim) => claim.key === key)
      && (unaided.emptied[key]?.[0] ?? Number.POSITIVE_INFINITY) > lapsesAtMs;
    const bridge = bridgeAfter(best.result, dryAtMs);
    claims.push({ key, atMs, lot });
    steps.push({
      key, atMs, gainMs: Number.isFinite(best.gain) ? best.gain : null,
      ...(lot.reset ? { reset: lot.reset } : {}),
      ...(lapsesAtMs !== undefined ? { lapsesAtMs } : {}),
      ...(left !== undefined ? { early: left } : {}),
      ...(first ? { first: true as const } : {}),
      ...(bridge ? { bridge } : {}),
    });
    base = best.result;
  }
  return { claims, steps, final: base };
}

export function buildForecast(input: {
  accounts: ForecastAccount[];
  readings: LimitTrendAccount[];
  settings: ForecastSettings;
  horizonDays: number;
  /** How far back the chart starts. */
  historyMs: number;
  nowMs: number;
}): Forecast {
  const { accounts, readings, settings, horizonDays, historyMs, nowMs } = input;
  const horizonEndMs = nowMs + horizonDays * DAY;
  const spend = spendByHour(readings, accounts, nowMs - FORECAST_HISTORY_MS, nowMs);
  const burn = burnRate(spend, accounts, settings, nowMs);
  const simulate = (pool: ForecastAccount[], claims: { key: string; atMs: number }[], points = false, scale = 1) => simulatePool(pool, {
    startMs: nowMs,
    endMs: horizonEndMs,
    rate: (atMs) => burn.rateAt(atMs) * scale,
    stepMs: HOUR,
    claimAt: claims,
    points,
  });
  // What's drawn without the suggestions keeps every account in its turn: going first is only ever suggested.
  const baseline = simulate(accounts, [], true);
  const moved = spendFirst(accounts, (pool) => simulate(pool, []), nowMs, horizonEndMs);
  // A pool that lasts needs no plan, so no account is moved to make one.
  const planned = baseline.dryAtMs === null ? accounts : moved;
  const run = (claims: { key: string; atMs: number }[], points = false, scale = 1) => simulate(planned, claims, points, scale);
  const plan = planClaims(planned, (claims) => run(claims), nowMs, horizonEndMs, baseline);
  const projection = settings.countResets && plan.claims.length ? run(plan.claims, true) : baseline;
  const names = new Map(accounts.map((account) => [account.key, account.name]));
  const advice: Advice[] = plan.steps.map(({ bridge, ...step }) => ({
    kind: 'claim',
    ...step,
    name: names.get(step.key) ?? step.key,
    ...(bridge ? { bridge: { atMs: bridge.atMs, names: bridge.keys.map((key) => names.get(key) ?? key) } } : {}),
  }));
  const withClaims = plan.final;
  if (withClaims.dryAtMs !== null && burn.perHour > 0) {
    // The pace that would just last the horizon, with the suggested resets spent.
    let low = 0;
    let high = 1;
    for (let round = 0; round < 14; round += 1) {
      const middle = (low + high) / 2;
      if (run(plan.claims, false, middle).dryAtMs === null) low = middle;
      else high = middle;
    }
    advice.push({ kind: 'slow', perHour: burn.perHour * low });
  }
  // Resets that lapse within the forecast and aren't in the plan: when one could still be used, rather than lost.
  // How the accounts run out with those worth it going first, for a reset its account wouldn't otherwise reach.
  const reach = planned === moved ? withClaims : simulate(moved, plan.claims);
  const noWorse = (trial: PoolRun) => trial.dryAtMs === null || (withClaims.dryAtMs !== null && trial.dryAtMs >= withClaims.dryAtMs);
  moved.forEach((account) => account.lots.forEach((lot) => {
    if (!lot.refills || !lapsesWithin(lot, nowMs, horizonEndMs)) return;
    const unused = lot.count - usedOf(plan.claims, lot);
    if (unused <= 0) return;
    const { key } = account;
    const { expiresAtMs } = lot;
    const inTurnMs = nextEmptyMs(withClaims, plan.claims, key);
    const firstMs = nextEmptyMs(reach, plan.claims, key);
    let use: LapsingUse = { how: 'none' };
    if (inTurnMs !== undefined && inTurnMs < expiresAtMs) {
      // The plan may already have it going first.
      const first = !plan.claims.some((claim) => claim.key === key) && (baseline.emptied[key]?.[0] ?? Number.POSITIVE_INFINITY) > expiresAtMs;
      use = { how: 'atLimit', atMs: inTurnMs, ...(first ? { first: true as const } : {}) };
    } else if (firstMs !== undefined && firstMs < expiresAtMs && noWorse(simulate(moved, [...plan.claims, { key, atMs: firstMs }]))) {
      use = { how: 'atLimit', atMs: firstMs, first: true };
    } else if (lot.anytime) {
      const atMs = Math.max(nowMs, expiresAtMs - EARLY_MARGIN_MS);
      const left = atMs > lastClaimMs(plan.claims, key) + CLAIM_GAP_MS
        ? leftAtClaim(run([...plan.claims, { key, atMs }]), key, atMs) : undefined;
      if (left !== undefined && 100 - left >= EARLY_MIN_PERCENT) use = { how: 'early', percent: 100 - left };
    }
    advice.push({ kind: 'expiring', key, name: account.name, count: unused, expiresAtMs, ...(lot.reset ? { reset: lot.reset } : {}), use });
  }));
  // A pool that still runs dry may get some of the window back from a Fable reset, which the plan can't count on.
  const stillDryAtMs = withClaims.dryAtMs;
  if (stillDryAtMs !== null) {
    accounts.forEach((account) => {
      const count = account.lots.reduce((total, lot) =>
        (lot.givesBack && (lot.expiresAtMs === null || lot.expiresAtMs > stillDryAtMs) ? total + lot.count : total), 0);
      if (count > 0) advice.push({ kind: 'givesBack', key: account.key, name: account.name, count });
    });
  }
  const handedBack = baseline.events.filter((event) => event.kind === 'reset' && event.before >= UNUSED_MIN_PERCENT
    && (baseline.dryAtMs === null || event.atMs < baseline.dryAtMs));
  const lastHandedBack = handedBack[handedBack.length - 1];
  const unused = handedBack.reduce((total, event) => total + event.before, 0);
  if (lastHandedBack && unused >= UNUSED_MIN_PERCENT) advice.push({ kind: 'unused', percent: unused, byMs: lastHandedBack.atMs });
  if (projection.dryAtMs === null) {
    // Those lapsing within the forecast aren't ones to keep: they have a line of their own.
    const kept = accounts.reduce((total, account) => total + account.lots.reduce((sum, lot) =>
      (lot.refills && !lapsesWithin(lot, nowMs, horizonEndMs) ? sum + lot.count - (settings.countResets ? usedOf(plan.claims, lot) : 0) : sum), 0), 0);
    advice.push({ kind: 'lasts', untilMs: horizonEndMs, credits: kept });
  }
  // Accounts that reset together are one step on the chart, so the next reset counts them all.
  const refill = projection.events.find((event) => event.before < 100);
  const refillGain = refill ? projection.events
    .filter((event) => Math.abs(event.atMs - refill.atMs) <= SAME_MOMENT_MS)
    .reduce((total, event) => total + 100 - event.before, 0) : 0;
  const used = historyMarks(readings, accounts, nowMs - historyMs, nowMs);
  // The plan's own claims, named as the advice names them.
  const spends = projection.events.flatMap((event): ResetMark[] => {
    if (event.kind !== 'credit') return [];
    const reset = plan.claims.find((claim) => claim.key === event.key && Math.abs(claim.atMs - event.atMs) < CLAIM_GAP_MS)?.lot.reset;
    return [{ atMs: event.atMs, key: event.key, name: names.get(event.key) ?? event.key, how: 'planned', ...(reset ? { reset } : {}), gain: 100 - event.before }];
  });
  return {
    capacity: accounts.length * 100,
    left: accounts.reduce((total, account) => total + account.left, 0),
    burn,
    history: poolHistory(readings, accounts, nowMs - historyMs, nowMs, used.map((mark) => mark.atMs)),
    spend,
    projection,
    marks: [...used, ...spends],
    nextRefill: refill ? { atMs: refill.atMs, gain: refillGain } : null,
    advice,
    horizonEndMs,
  };
}

/** What a forecast alert is about: the pool running dry within a day. Keyed so it's told once each time. */
export type ForecastAlert = { dryAtMs: number; key: string };

export const FORECAST_ALERT_WITHIN_MS = DAY;

export function forecastAlert(provider: string, forecast: Forecast, nowMs: number): ForecastAlert | null {
  const { dryAtMs } = forecast.projection;
  if (dryAtMs === null || dryAtMs - nowMs > FORECAST_ALERT_WITHIN_MS) return null;
  // Once for each refill the pool waits on: a new cycle can warn again.
  return { dryAtMs, key: `${provider}:${forecast.nextRefill ? Math.round(forecast.nextRefill.atMs / HOUR) : 'none'}` };
}

/** Which providers to alert, given those already alerted (by key, with when). Entries go a week after they're made. */
export function nextForecastAlerts(notified: Record<string, number>, alerts: ForecastAlert[], nowMs: number) {
  const next = Object.fromEntries(Object.entries(notified).filter(([, atMs]) => atMs > nowMs - WEEK));
  const fresh = alerts.filter((alert) => {
    if (next[alert.key] !== undefined) return false;
    next[alert.key] = nowMs;
    return true;
  });
  const changed = fresh.length > 0 || Object.keys(next).length !== Object.keys(notified).length;
  return { notified: next, fresh, changed };
}

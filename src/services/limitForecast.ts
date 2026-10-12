/**
 * The forecast on Accounts › Limits: how a provider's pool of accounts has drained, how fast it drains, when it runs
 * dry at that pace, and when a banked or manual reset is worth spending.
 *
 * Everything is in summed percent: each account is worth 100%, so six accounts are 600% and a reset adds back what
 * the account had used. Spend is read from the limit history (`get_limit_trend`): a drop between two readings of the
 * same window cycle. A reset or a claimed credit raises the figure but isn't spend.
 */
import type { LimitTrendAccount } from '../native/types';
import { rowWindowMs, windowDurationMs, type Headline } from './accountLimits';
import { simulatePool, type PoolAccount, type PoolPoint, type PoolRun } from './poolSimulation';
import type { QuotaState } from './quotaService';

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
  credits: number;
  /** When the account's earliest credit lapses, when known. */
  creditsExpireAtMs: number | null;
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
    const expiry = segment.account.quota.resetCreditsEarliestExpiry;
    const expiresAtMs = expiry ? Date.parse(expiry) : Number.NaN;
    return [{
      key: keyOf(segment.account),
      name: segment.account.name,
      left: Math.max(0, Math.min(100, segment.percent)),
      resetAtMs,
      windowMs: row ? rowWindowMs(row) : labelMs,
      credits: plannableCredits(segment.account.quota),
      creditsExpireAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
    }];
  });
}

/**
 * Credits the forecast can plan to spend. Codex counts only those that apply to its main limits. Claude counts banked
 * resets unless Claude won't take them from Arbor at all; one in a cooldown, or waiting for a limit, can still be planned.
 */
export function plannableCredits(quota: QuotaState): number {
  const count = quota.resetCredits ?? 0;
  if (count <= 0 || quota.status !== 'success') return 0;
  if (quota.resetCreditsApplicable !== undefined) return Math.min(count, quota.resetCreditsApplicable);
  if (quota.bankedReset === undefined) return 0;
  return quota.bankedReset.blockedHere ? 0 : count;
}

/** The accounts' readings, by account, in time order, with the live limits' figure last. */
function byAccount(trend: LimitTrendAccount[], accounts: ForecastAccount[], nowMs: number) {
  const keys = new Set(accounts.map((account) => account.key));
  const grouped = new Map<string, { t: number; left: number; resetAtMs: number | null }[]>();
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
 * stands in, so an account added lately doesn't read as an empty one. Thinned to a few hundred points.
 */
export function poolHistory(readings: LimitTrendAccount[], accounts: ForecastAccount[], sinceMs: number, nowMs: number): PoolPoint[] {
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
  const thinned: PoolPoint[] = [];
  points.forEach((point, index) => {
    const next = points[index + 1];
    if (index === 0 || !next || Math.floor((next.t - sinceMs) / slice) !== Math.floor((point.t - sinceMs) / slice)) thinned.push(point);
  });
  return thinned;
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
      const sameCycle = before.resetAtMs === null || after.resetAtMs === null
        ? before.resetAtMs === after.resetAtMs
        : Math.abs(before.resetAtMs - after.resetAtMs) <= SAME_RESET_MS;
      if (sameCycle) {
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

export type Advice =
  /** Claim a reset on an account when it runs out: the pool would otherwise run dry first. `gainMs` null: it then lasts. */
  | { kind: 'claim'; key: string; name: string; atMs: number; gainMs: number | null }
  /** Even with every reset spent the pool runs dry: this pace would last. */
  | { kind: 'slow'; perHour: number }
  /** Credits that lapse before the forecast ever needs them. */
  | { kind: 'expiring'; key: string; name: string; count: number; expiresAtMs: number }
  /** Capacity that resets before it's spent, by `byMs`: room to spend more. */
  | { kind: 'unused'; percent: number; byMs: number }
  /** The pool lasts the whole horizon, with `credits` resets left over. */
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
  /** The first reset that hands something back, and how much. */
  nextRefill: { atMs: number; gain: number } | null;
  advice: Advice[];
  horizonEndMs: number;
};

const claimed = (claims: { key: string }[], key: string) => claims.filter((claim) => claim.key === key).length;

/**
 * Greedy plan for the credits: while the pool runs dry, spend the credit that buys the most time, on the account
 * that runs out before the pool does, at the moment it runs out (Claude and Codex only refill an account at a limit).
 */
function planClaims(accounts: ForecastAccount[], run: (claims: { key: string; atMs: number }[]) => PoolRun) {
  const claims: { key: string; atMs: number }[] = [];
  const steps: { key: string; atMs: number; gainMs: number | null }[] = [];
  let base = run(claims);
  while (base.dryAtMs !== null && steps.length < MOST_CLAIMS) {
    const dryAtMs = base.dryAtMs;
    let best: { key: string; atMs: number; result: PoolRun; gain: number } | null = null;
    for (const account of accounts) {
      const emptyAtMs = base.emptyAtMs[account.key];
      if (account.credits - claimed(claims, account.key) <= 0 || emptyAtMs === undefined || emptyAtMs > dryAtMs) continue;
      if (account.creditsExpireAtMs !== null && account.creditsExpireAtMs <= emptyAtMs) continue;
      // Claimed again after an earlier claim this run, it runs out later than first time.
      const atMs = Math.max(emptyAtMs, ...claims.filter((claim) => claim.key === account.key).map((claim) => claim.atMs + 1));
      const result = run([...claims, { key: account.key, atMs }]);
      const gain = (result.dryAtMs ?? Number.POSITIVE_INFINITY) - dryAtMs;
      if (gain > 0 && (!best || gain > best.gain)) best = { key: account.key, atMs, result, gain };
    }
    if (!best) break;
    claims.push({ key: best.key, atMs: best.atMs });
    steps.push({ key: best.key, atMs: best.atMs, gainMs: Number.isFinite(best.gain) ? best.gain : null });
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
  const run = (claims: { key: string; atMs: number }[], points = false, scale = 1) => simulatePool(accounts, {
    startMs: nowMs,
    endMs: horizonEndMs,
    rate: (atMs) => burn.rateAt(atMs) * scale,
    stepMs: HOUR,
    claimAt: claims,
    points,
  });
  const baseline = run([], true);
  const plan = planClaims(accounts, (claims) => run(claims));
  const projection = settings.countResets && plan.claims.length ? run(plan.claims, true) : baseline;
  const names = new Map(accounts.map((account) => [account.key, account.name]));
  const advice: Advice[] = plan.steps.map((step) => ({ kind: 'claim', ...step, name: names.get(step.key) ?? step.key }));
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
  accounts.forEach((account) => {
    const expiresAtMs = account.creditsExpireAtMs;
    if (expiresAtMs === null || expiresAtMs > horizonEndMs) return;
    const unused = account.credits - plan.claims.filter((claim) => claim.key === account.key && claim.atMs < expiresAtMs).length;
    if (unused > 0) advice.push({ kind: 'expiring', key: account.key, name: account.name, count: unused, expiresAtMs });
  });
  const handedBack = baseline.events.filter((event) => event.kind === 'reset' && event.before >= UNUSED_MIN_PERCENT
    && (baseline.dryAtMs === null || event.atMs < baseline.dryAtMs));
  const lastHandedBack = handedBack[handedBack.length - 1];
  const unused = handedBack.reduce((total, event) => total + event.before, 0);
  if (lastHandedBack && unused >= UNUSED_MIN_PERCENT) advice.push({ kind: 'unused', percent: unused, byMs: lastHandedBack.atMs });
  if (projection.dryAtMs === null) {
    const spentCredits = settings.countResets ? plan.claims.length : 0;
    advice.push({ kind: 'lasts', untilMs: horizonEndMs, credits: accounts.reduce((total, account) => total + account.credits, 0) - spentCredits });
  }
  // Accounts that reset together are one step on the chart, so the next reset counts them all.
  const refill = projection.events.find((event) => event.before < 100);
  const refillGain = refill ? projection.events
    .filter((event) => Math.abs(event.atMs - refill.atMs) <= SAME_MOMENT_MS)
    .reduce((total, event) => total + 100 - event.before, 0) : 0;
  return {
    capacity: accounts.length * 100,
    left: accounts.reduce((total, account) => total + account.left, 0),
    burn,
    history: poolHistory(readings, accounts, nowMs - historyMs, nowMs),
    spend,
    projection,
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

import { freshRows, windowDurationMs } from './accountLimits';
import { authFileAvailability } from './authFiles';
import {
  LEND_FLOOR_PERCENT,
  OUT_PERCENT,
  RECENT_USE_MS,
  RESERVE_MAX_PERCENT,
  RESERVE_MIN_PERCENT,
  RESERVE_SAFETY,
  accessSummary,
  isPartial,
  lower,
  modelKey,
  recentUse,
  reservePolicyFor,
  type LendMode,
  type ModelAccessState,
  type ReservePolicy,
} from './extraModelHold';
import { fileName, providerForFile, quotaKey, type AuthFile, type QuotaState } from './quotaService';

/*
 * The reserves accounts keep for extra models only some accounts have: how big each is, and whether an account is at
 * it. Only installs with such a model load this, so it stays out of what every launch reads.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** An account as a reserve sees it, from its longest limit window. */
export type ReserveAccount = {
  /** Credential file name. */
  name: string;
  /** The share of its limit left, or null with no reading. */
  remaining: number | null;
  resetAtMs?: number;
  windowMs?: number;
  /** It can't take requests now: at a limit, or all but out of it. */
  out: boolean;
};

/**
 * Where an account with a reserve stands.
 * - `open`: above its reserve, so it takes everyday requests like any account.
 * - `fenced`: at its reserve, so it serves only the models it keeps it for.
 * - `lending`: at its reserve, but every other account is out, so it takes everyday requests down to `floor`.
 */
export type AccountReserve = {
  /** The models it keeps the reserve for, in lower case. */
  models: string[];
  /** The share of its limit kept, in percent. */
  percent: number;
  remaining: number;
  state: 'open' | 'fenced' | 'lending';
  floor: number;
  /** Whether a smart reserve sized it, rather than a fixed one. */
  smart: boolean;
};

/** Where its window started, if the reading says. */
export const windowStart = (account: Pick<ReserveAccount, 'resetAtMs' | 'windowMs'>): number | null =>
  account.resetAtMs !== undefined && account.windowMs !== undefined ? account.resetAtMs - account.windowMs : null;

/**
 * What a model looks set to use of an account's limit before it resets, in percent: its tokens this week at the
 * week's pace, each priced at what the account's tokens have cost of its limit so far this window. Null when the
 * account has no window reading or its tokens since the window began haven't been read.
 */
export function forecastUse(state: ModelAccessState, provider: string, model: string, account: ReserveAccount, nowMs: number): number | null {
  const tokens = state.usage[modelKey(provider, model)]?.tokens[account.name] ?? 0;
  if (tokens === 0) return 0;
  const window = state.windows[account.name];
  const start = windowStart(account);
  if (!window || start === null || account.remaining === null || account.resetAtMs === undefined) return null;
  // Read for an earlier window, it prices this one's tokens wrongly.
  if (Math.abs(window.sinceMs - start) > HOUR || window.tokens <= 0) return null;
  const perToken = Math.max(0, 100 - account.remaining) / window.tokens;
  return tokens * perToken * (Math.max(0, account.resetAtMs - nowMs) / RECENT_USE_MS);
}

/** A smart reserve for a forecast, easing off over the last day, when capacity kept would only reset unused. */
export function smartReserve(forecast: number, account: Pick<ReserveAccount, 'resetAtMs'>, nowMs: number): number {
  const ease = account.resetAtMs === undefined ? 1 : Math.min(1, Math.max(0, (account.resetAtMs - nowMs) / DAY));
  const percent = Math.min(RESERVE_MAX_PERCENT, Math.max(RESERVE_MIN_PERCENT * ease, RESERVE_SAFETY * forecast));
  // Half a percent steps keep it from twitching between refreshes.
  return Math.ceil(percent * 2) / 2;
}

const STRICTER: Record<LendMode, number> = { all: 0, floor: 1, hold: 2 };

/**
 * The reserves a provider's `accounts` keep for extra models some of the others lack, and where each stands. A model
 * shares its forecast across the accounts that have it. An account at its reserve serves only its models, unless
 * every account above its reserve is out: then it lends the reserve to everyday requests, as its model's policy says.
 */
export function modelReserves(state: ModelAccessState, policies: Record<string, ReservePolicy>, provider: string, accounts: ReserveAccount[], nowMs: number): Map<string, AccountReserve> {
  const byName = new Map(accounts.map((account) => [account.name, account]));
  const claims = new Map<string, { models: string[]; percent: number; lend: LendMode; smart: boolean }>();
  for (const model of state.providers[provider]?.models ?? []) {
    const summary = accessSummary(state, model, accounts.map((account) => account.name));
    if (!isPartial(summary)) continue;
    const policy = reservePolicyFor(policies, provider, model);
    // Serving only the model fences the account outright, in its excluded models.
    if (policy.mode === 'never' || policy.mode === 'only') continue;
    if (policy.mode === 'auto' && recentUse(state, provider, model) === 0) continue;
    const holders = summary.have.flatMap((name) => {
      const account = byName.get(name);
      return account && account.remaining !== null ? [account] : [];
    });
    if (holders.length === 0) continue;
    const share = holders.reduce((sum, account) => sum + (forecastUse(state, provider, model, account, nowMs) ?? 0), 0) / holders.length;
    holders.forEach((account) => {
      const percent = policy.mode === 'fixed' ? policy.percent : smartReserve(share, account, nowMs);
      const claim = claims.get(account.name);
      claims.set(account.name, claim
        ? { models: [...claim.models, lower(model)], percent: claim.percent + percent, lend: STRICTER[policy.lend] > STRICTER[claim.lend] ? policy.lend : claim.lend, smart: claim.smart || policy.mode === 'auto' }
        : { models: [lower(model)], percent, lend: policy.lend, smart: policy.mode === 'auto' });
    });
  }
  const atReserve = (account: ReserveAccount) => {
    const claim = claims.get(account.name);
    return claim !== undefined && account.remaining !== null && account.remaining <= claim.percent;
  };
  // Everyday requests have nowhere else to go once every account not at its reserve is out.
  const isOut = (account: ReserveAccount) => account.out || (account.remaining !== null && account.remaining < OUT_PERCENT);
  const othersOut = accounts.every((account) => isOut(account) || atReserve(account));
  const reserves = new Map<string, AccountReserve>();
  claims.forEach((claim, name) => {
    const remaining = byName.get(name)?.remaining ?? 0;
    const floor = claim.lend === 'all' ? 0 : claim.lend === 'floor' ? Math.min(LEND_FLOOR_PERCENT, claim.percent / 2) : claim.percent;
    const state = remaining > claim.percent ? 'open' : othersOut && claim.lend !== 'hold' && remaining > floor ? 'lending' : 'fenced';
    reserves.set(name, { models: [...claim.models].sort(), percent: claim.percent, remaining, state, floor, smart: claim.smart });
  });
  return reserves;
}

/** Percent as the page says it: whole numbers, and halves below ten, where a half is a fair share of a reserve. */
export const percentText = (percent: number) => String(percent >= 10 ? Math.round(percent) : Math.round(percent * 2) / 2);

/** The models each account at its reserve serves, by credential file name, for its excluded models. */
export const fencesFrom = (reserves: ReadonlyMap<string, AccountReserve>): Record<string, string[]> =>
  Object.fromEntries([...reserves].filter(([, reserve]) => reserve.state === 'fenced').map(([name, reserve]) => [name, reserve.models]).sort(([a], [b]) => String(a).localeCompare(String(b))));

export const sameFences = (left: Record<string, string[]>, right: Record<string, string[]>) => {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => (left[key] ?? []).join(',') === (right[key] ?? []).join(','));
};

/**
 * A provider's accounts as reserves for extra models see them, from each one's longest limit window: the one a
 * reserve has to last through, as a shorter one comes back within hours. Turned-off and signed-out accounts take no
 * requests, so they're left out.
 */
export function reserveAccounts(files: AuthFile[], quotas: Record<string, QuotaState>, nowMs: number): ReserveAccount[] {
  return files.flatMap((file) => {
    const availability = authFileAvailability(file, nowMs).kind;
    if (availability === 'disabled' || availability === 'signin') return [];
    const quota = quotas[quotaKey(file)];
    // Limits on one feature (code review, a single model) don't say what the account has left for everything else.
    const rows = quota?.status === 'success' ? freshRows(quota).filter((row) => !row.extra && row.remainingPercent !== null) : [];
    const longest = rows
      .map((row) => ({ row, windowMs: row.windowMs ?? windowDurationMs(row.label) }))
      .filter((entry): entry is { row: typeof entry.row; windowMs: number } => entry.windowMs !== null && entry.row.resetAtMs !== undefined)
      .sort((a, b) => b.windowMs - a.windowMs || (a.row.remainingPercent ?? 0) - (b.row.remainingPercent ?? 0))[0];
    const out = availability === 'limit' || availability === 'access' || availability === 'unavailable'
      || rows.some((row) => (row.remainingPercent ?? 100) < OUT_PERCENT);
    return [{
      name: fileName(file),
      remaining: longest?.row.remainingPercent ?? null,
      ...(longest ? { resetAtMs: longest.row.resetAtMs, windowMs: longest.windowMs } : {}),
      out,
    }];
  });
}

/** The reserves one provider's accounts keep for extra models, and where each stands. See `modelReserves`. */
export const providerReserves = (
  files: AuthFile[],
  quotas: Record<string, QuotaState>,
  state: ModelAccessState,
  policies: Record<string, ReservePolicy>,
  provider: string,
  nowMs: number,
): Map<string, AccountReserve> => (state.providers[provider]?.models.length
  ? modelReserves(state, policies, provider, reserveAccounts(files.filter((file) => providerForFile(file) === provider), quotas, nowMs), nowMs)
  : new Map());

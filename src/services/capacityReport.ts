import { useSyncExternalStore } from 'react';
import { displayRows, freshRows, windowDurationMs } from './accountLimits';
import type { AccountOrder } from './accountOrder';
import type { AccountProfile } from './accountProfiles';
import { isOAuthCredentialFile } from './authFiles';
import { accountsGap, type AccountsGap } from './accountsStore';
import { normalizeAuthIndex } from './managementApi';
import { listPrice } from './planCosts';
import { providerLimits } from './providerLimits';
import { getQuotaCacheSnapshot, subscribeQuotaCache } from './quotaCache';
import { providerForFile, quotaKey, type AuthFile, type QuotaProvider, type QuotaState } from './quotaService';
import type { CapacityReport, LimitCoverage, LimitCycle } from '../native/types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** An average month, to turn a monthly price into the cost of a period. */
const MONTH_MS = (365.25 / 12) * DAY;
/** Limit readings have to span this share of a window before they say how busy an account is. */
const MIN_WATCHED_SHARE = 0.5;
/** Likewise, the live reading says little until this share of the current window has passed. */
const MIN_ELAPSED_SHARE = 0.5;
/** A period ending this close to now includes the live reading. */
const LIVE_WITHIN_MS = 10 * 60_000;
/** An account using less than this share of its limit is barely used. */
export const IDLE_PERCENT = 10;
/** Fewer accounts are suggested only if each would use at most this share of its limit, leaving room for busier weeks. */
export const TARGET_PERCENT = 80;

/**
 * How much of its limit window an account uses, in percent of the window per
 * window length: from the limit readings over `watchedMs`, or from the live
 * reading of the current window, projected to its reset.
 */
export type LimitUse = { percent: number; basis: 'history'; watchedMs: number } | { percent: number; basis: 'live' };

export type CapacityAccount = {
  key: string;
  name: string;
  plan: string;
  /** US dollars a month, set by hand or the plan's list price; null when neither is known. */
  monthlyCost: number | null;
  costSet: boolean;
  /** What the account's requests in the period would have cost at API prices. */
  value: number;
  requests: number;
  unpricedRequests: number;
  /** The subscription's cost over the part of the period the account was in use. */
  periodCost: number | null;
  /** Value divided by the period cost. */
  ratio: number | null;
  use: LimitUse | null;
  /** The live reading of the current window, when the period reaches now. */
  current: { usedPercent: number; resetAtMs?: number } | null;
  idle: boolean;
  /** One of the accounts the rest of its plan could cover. */
  spare: boolean;
};

/** Same-plan accounts that could do with fewer of them. */
export type PlanVerdict = { plan: string; accounts: number; needPercent: number; keep: number; spare: string[]; saving: number | null };

export type CapacityProvider = {
  provider: QuotaProvider;
  /** The window use is measured against: the provider's headline window, when it lasts a day or more. */
  window: string | null;
  accounts: CapacityAccount[];
  /** Usage from credentials no longer listed, such as removed or renamed accounts. */
  unlisted: { value: number; requests: number } | null;
  /** The accounts with a known cost. */
  monthlyCost: number;
  unknownCosts: number;
  periodCost: number;
  value: number;
  /** Value of the accounts with a known cost, divided by their period cost. */
  ratio: number | null;
  verdicts: PlanVerdict[];
};

export type CapacityInput = {
  data: CapacityReport;
  files: AuthFile[];
  quotas: Record<string, QuotaState>;
  profiles: Record<string, AccountProfile | undefined>;
  prefs: { hidden: Record<string, string[]>; headline: Record<string, string> };
  order?: AccountOrder;
  costs: Record<string, number>;
  nowMs: number;
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/**
 * What `accounts`' requests were worth over what the ones with a known cost cost; null without a cost, or when they
 * had requests and none of them had a price, since their worth then isn't known rather than nothing.
 */
export function costedRatio(accounts: Pick<CapacityAccount, 'periodCost' | 'value' | 'requests' | 'unpricedRequests'>[]): number | null {
  const costed = accounts.filter((account) => account.periodCost !== null);
  const periodCost = sum(costed.map((account) => account.periodCost ?? 0));
  if (periodCost <= 0) return null;
  const requests = sum(costed.map((account) => account.requests));
  if (requests > 0 && requests === sum(costed.map((account) => account.unpricedRequests))) return null;
  return sum(costed.map((account) => account.value)) / periodCost;
}

/**
 * Readings spanning at least half a window give the account's use per window
 * length: the use of every cycle they saw, with a window already running at
 * the first reading counted from that reading on, spread over the time
 * watched. Idle stretches (no window running) count as watched time with no
 * use. Short of that, the current window's use so far is projected to its
 * reset, once half of it has passed.
 */
function limitUse(
  coverage: LimitCoverage | undefined,
  cycles: LimitCycle[],
  current: CapacityAccount['current'],
  durationMs: number,
  nowMs: number,
): LimitUse | null {
  if (coverage) {
    const watchedMs = coverage.lastSampledAtMs - coverage.firstSampledAtMs;
    if (watchedMs >= durationMs * MIN_WATCHED_SHARE) {
      const used = sum(cycles.map((cycle) => {
        const from = cycle.firstSampledAtMs === coverage.firstSampledAtMs ? cycle.firstRemainingPercent : 100;
        return Math.max(0, from - cycle.minRemainingPercent);
      }));
      return { percent: (used * durationMs) / watchedMs, basis: 'history', watchedMs };
    }
  }
  if (current?.resetAtMs !== undefined) {
    const elapsed = 1 - (current.resetAtMs - nowMs) / durationMs;
    if (elapsed >= MIN_ELAPSED_SHARE && elapsed <= 1) return { percent: current.usedPercent / elapsed, basis: 'live' };
  }
  return null;
}

/**
 * Accounts on the same plan whose combined use would fit in fewer of them,
 * with each remaining account at most at TARGET_PERCENT of its limit. The
 * least used accounts are the ones to let go. Needs a use figure for every
 * account on the plan.
 */
function planVerdicts(accounts: CapacityAccount[]): PlanVerdict[] {
  const plans = new Map<string, CapacityAccount[]>();
  accounts.forEach((account) => {
    const plan = account.plan.trim().toLowerCase();
    if (plan) plans.set(plan, [...(plans.get(plan) ?? []), account]);
  });
  return [...plans.values()].flatMap((group) => {
    if (group.length < 2 || group.some((account) => account.use === null)) return [];
    if (group.every((account) => account.monthlyCost === 0)) return [];
    const needPercent = sum(group.map((account) => account.use!.percent));
    // Rounding noise shouldn't cost a whole account.
    const keep = Math.max(1, Math.ceil(needPercent / TARGET_PERCENT - 1e-9));
    if (keep >= group.length) return [];
    const spare = [...group]
      .sort((a, b) => a.use!.percent - b.use!.percent || a.value - b.value || a.key.localeCompare(b.key))
      .slice(0, group.length - keep);
    spare.forEach((account) => {
      account.spare = true;
    });
    const costs = spare.map((account) => account.monthlyCost);
    return [{
      plan: group[0]!.plan,
      accounts: group.length,
      needPercent,
      keep,
      spare: spare.map((account) => account.name),
      saving: costs.every((cost): cost is number => cost !== null) ? sum(costs) : null,
    }];
  });
}

/**
 * The capacity report per provider: every subscription account's value at
 * API prices against what it costs over the period, how much of the
 * provider's headline window it uses, and which same-plan accounts the others
 * could cover.
 */
export function capacityReport({ data, files, quotas, profiles, prefs, order, costs, nowMs }: CapacityInput): CapacityProvider[] {
  const subscriptions = files.filter(isOAuthCredentialFile);
  const fileByKey = new Map(subscriptions.map((file) => [quotaKey(file), file]));
  const values = new Map(data.accounts.map((account) => [normalizeAuthIndex(account.authIndex), account]));
  const listed = new Set(files.map((file) => normalizeAuthIndex(file.auth_index ?? file.authIndex)).filter(Boolean));
  const live = nowMs - data.endMs <= LIVE_WITHIN_MS;
  return providerLimits(subscriptions, quotas, profiles, prefs, nowMs, order).map((limit) => {
    const label = limit.headline.label;
    const durationMs = label ? windowDurationMs(label) : null;
    const window = label && durationMs !== null && durationMs >= DAY ? label : null;
    const accounts = limit.accounts.map((account): CapacityAccount => {
      const file = fileByKey.get(account.key);
      const authIndex = file ? normalizeAuthIndex(file.auth_index ?? file.authIndex) : '';
      const value = authIndex ? values.get(authIndex) : undefined;
      const cycles = window ? data.cycles.filter((cycle) => cycle.account === account.key && cycle.window === window) : [];
      const coverage = window ? data.coverage.find((item) => item.account === account.key && item.window === window) : undefined;
      const plan = account.quota.plan ?? cycles[cycles.length - 1]?.plan ?? '';
      const setCost = costs[account.key];
      const monthlyCost = setCost ?? listPrice(limit.provider, plan);
      const activeFrom = data.startMs === null ? null : Math.max(data.startMs, value?.firstSeenMs || data.startMs);
      const periodCost = monthlyCost === null || activeFrom === null ? null : (monthlyCost * Math.max(0, data.endMs - activeFrom)) / MONTH_MS;
      const estimatedCost = value?.estimatedCost ?? 0;
      const requests = value?.requests ?? 0;
      const unpricedRequests = Math.max(0, requests - (value?.pricedRequests ?? 0));
      // Use is projected from the live reading, so one held over from before a failed check doesn't count.
      const row = window && live ? freshRows(account.quota).find((item) => item.label === window) : undefined;
      const current = row && row.remainingPercent !== null ? { usedPercent: Math.max(0, 100 - row.remainingPercent), resetAtMs: row.resetAtMs } : null;
      const use = window && durationMs !== null ? limitUse(coverage, cycles, current, durationMs, nowMs) : null;
      return {
        key: account.key,
        name: account.name,
        plan,
        monthlyCost,
        costSet: setCost !== undefined,
        value: estimatedCost,
        requests,
        unpricedRequests,
        periodCost,
        ratio: costedRatio([{ periodCost, value: estimatedCost, requests, unpricedRequests }]),
        use,
        current,
        idle: use !== null && use.percent < IDLE_PERCENT,
        spare: false,
      };
    });
    const verdicts = planVerdicts(accounts);
    const others = data.accounts.filter((account) =>
      !listed.has(normalizeAuthIndex(account.authIndex)) && providerForFile({ provider: account.provider }) === limit.provider);
    const periodCost = sum(accounts.flatMap((account) => (account.periodCost === null ? [] : [account.periodCost])));
    return {
      provider: limit.provider,
      window,
      accounts,
      unlisted: others.length ? { value: sum(others.map((account) => account.estimatedCost)), requests: sum(others.map((account) => account.requests)) } : null,
      monthlyCost: sum(accounts.flatMap((account) => (account.monthlyCost === null ? [] : [account.monthlyCost]))),
      unknownCosts: accounts.filter((account) => account.monthlyCost === null).length,
      periodCost,
      value: sum(accounts.map((account) => account.value)),
      ratio: costedRatio(accounts),
      verdicts,
    };
  });
}

/** Every limit window of a day or more that any account reports: the windows the report asks history for. */
export const longLimitWindows = (quotas: Record<string, QuotaState>): string[] =>
  [...new Set(Object.values(quotas).flatMap((quota) => displayRows(quota).map((row) => row.label)))]
    .filter((label) => (windowDurationMs(label) ?? 0) >= DAY)
    .sort();

const longWindowsKey = () => longLimitWindows(getQuotaCacheSnapshot()).join('\n');

/** The long limit windows as one string, so a component re-renders only when the set changes. */
export const useLongLimitWindowsKey = () => useSyncExternalStore(subscribeQuotaCache, longWindowsKey, longWindowsKey);

/**
 * Why Value has no subscription account to show, so it can say so rather than offer adding one: the core isn't
 * running (it lists the accounts), the list is still loading or failed, every account is turned off, or the core has
 * none (`accountsGap`). `subscriptions` when accounts are listed but none is a subscription, the one case where
 * adding one is the answer, as it is for `none`.
 */
export function capacityGap(coreRunning: boolean | null, accounts: Parameters<typeof accountsGap>[0]): 'coreStopped' | AccountsGap | 'subscriptions' {
  if (coreRunning === false) return 'coreStopped';
  return accountsGap(accounts) ?? 'subscriptions';
}

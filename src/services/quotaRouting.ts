import { freshRows, windowDurationMs } from './accountLimits';
import { sortByOrder, type AccountOrder } from './accountOrder';
import { resolveAccountProfile, type AccountProfile } from './accountProfiles';
import { authFileAvailability, isOAuthCredentialFile, parseAuthFilePriority, type AuthFileRecord } from './authFiles';
import { managementApi } from './managementApi';
import { providerLimits } from './providerLimits';
import { savedStore, storedRecord } from './savedStore';
import { fileName, providerForFile, quotaKey, type AuthFile, type QuotaProvider, type QuotaState } from './quotaService';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Below this share of the headline window an account goes last: it is about to run out anyway. */
export const ROUTING_LOW_PERCENT = 10;
/** Resets this close together count as one, so a countdown drifting between refreshes can't reorder accounts. */
const SAME_RESET_MS = HOUR;

/**
 * Why an account sits where it does in the suggested order.
 * - `soonest`: ranked by when its headline window resets.
 * - `low`: nearly out of the window, so it goes last.
 * - `unknown`: no limit reading yet.
 * - `fixed`: a runtime-only credential or an API key, whose priority the core can't change.
 * - `blocked`: disabled, or the core can't use it until someone fixes it (a rejected sign-in, a billing problem).
 * The last three keep their priority.
 */
export type RoutingReason =
  | { kind: 'soonest'; percent: number; resetAtMs: number }
  | { kind: 'low'; percent: number }
  | { kind: 'unknown' }
  | { kind: 'fixed' }
  | { kind: 'blocked' };

export type RoutingItem = {
  key: string;
  name: string;
  /** The credential file name the core knows it by. */
  fileName: string;
  current: number;
  /** The priority to set, or null to leave the account as it is. */
  suggested: number | null;
  reason: RoutingReason;
};

export type RoutingPlan = { items: RoutingItem[]; changes: RoutingItem[] };
export type RoutingCandidate = { file: AuthFileRecord; quota: QuotaState | undefined; name: string };

const reasonFor = ({ file, quota }: RoutingCandidate, window: string, nowMs: number): RoutingReason => {
  if (!isOAuthCredentialFile(file)) return { kind: 'fixed' };
  const availability = authFileAvailability(file, nowMs).kind;
  if (availability === 'disabled' || availability === 'signin' || availability === 'access' || availability === 'unavailable') {
    return { kind: 'blocked' };
  }
  if (quota?.status !== 'success') return { kind: 'unknown' };
  const row = freshRows(quota).find((item) => item.label === window);
  if (!row || row.remainingPercent === null) return { kind: 'unknown' };
  if (row.remainingPercent < ROUTING_LOW_PERCENT) return { kind: 'low', percent: row.remainingPercent };
  if (row.resetAtMs === undefined) return { kind: 'unknown' };
  return { kind: 'soonest', percent: row.remainingPercent, resetAtMs: row.resetAtMs };
};

/**
 * Accounts with resets within an hour of each other form one group, in the
 * order of the first reset in each group. Inside a group the account with
 * more left goes first.
 */
const rankBySoonestReset = <T extends { key: string; reason: Extract<RoutingReason, { kind: 'soonest' }> }>(items: T[]): T[] => {
  const byReset = [...items].sort((a, b) => a.reason.resetAtMs - b.reason.resetAtMs || a.key.localeCompare(b.key));
  const groups: T[][] = [];
  byReset.forEach((item) => {
    const group = groups[groups.length - 1];
    if (group && item.reason.resetAtMs - group[0]!.reason.resetAtMs <= SAME_RESET_MS) group.push(item);
    else groups.push([item]);
  });
  return groups.flatMap((group) => group.sort((a, b) => b.reason.percent - a.reason.percent || a.key.localeCompare(b.key)));
};

/**
 * Suggests credential priorities for one provider's accounts so the core uses
 * capacity before it expires. The core only routes to its highest priority
 * with a usable credential, so the account whose headline window resets
 * soonest gets the highest priority, the next one the priority below, and so
 * on; when an account hits a limit the core moves on to the next. Accounts
 * nearly out of the window get priority 0 and go last. Accounts without a
 * reading, or that the core can't use or re-prioritize, keep their priority.
 *
 * Returns null when there is nothing to order: a headline window shorter
 * than a day (it resets too often to plan around), or fewer than two
 * accounts with a reading.
 */
export function routingPlan(candidates: RoutingCandidate[], window: string | null, nowMs: number): RoutingPlan | null {
  if (!window) return null;
  const durationMs = windowDurationMs(window);
  if (durationMs === null || durationMs < DAY) return null;
  const entries = candidates.map((candidate) => ({
    key: quotaKey(candidate.file),
    name: candidate.name,
    fileName: fileName(candidate.file),
    current: parseAuthFilePriority(candidate.file.priority) ?? 0,
    reason: reasonFor(candidate, window, nowMs),
  }));
  type Soonest = (typeof entries)[number] & { reason: Extract<RoutingReason, { kind: 'soonest' }> };
  const ranked = rankBySoonestReset(entries.filter((entry): entry is Soonest => entry.reason.kind === 'soonest'));
  const low = entries.filter((entry) => entry.reason.kind === 'low').sort((a, b) => a.key.localeCompare(b.key));
  if (ranked.length + low.length < 2) return null;
  const items: RoutingItem[] = [
    ...ranked.map((entry, index) => ({ ...entry, suggested: ranked.length - index })),
    ...low.map((entry) => ({ ...entry, suggested: 0 })),
    ...entries.filter((entry) => entry.reason.kind !== 'soonest' && entry.reason.kind !== 'low').map((entry) => ({ ...entry, suggested: null })),
  ];
  return { items, changes: items.filter((item) => item.suggested !== null && item.suggested !== item.current) };
}

/** Accounts as the plan sees them: the credential, its latest limits and the name it goes by. */
export const routingCandidates = (
  files: AuthFile[],
  quotas: Record<string, QuotaState>,
  profiles: Record<string, AccountProfile | undefined>,
): RoutingCandidate[] => files.map((file) => {
  const key = quotaKey(file);
  return { file, quota: quotas[key], name: resolveAccountProfile(key, fileName(file), profiles[key]).name };
});

export type ProviderRouting = { provider: QuotaProvider; window: string; plan: RoutingPlan };

/**
 * The suggested priorities for each provider with accounts to order, ranked on
 * the headline window the Accounts page sums its accounts up by. `files` are
 * the accounts in use.
 */
export function providerRoutingPlans(
  files: AuthFile[],
  quotas: Record<string, QuotaState>,
  profiles: Record<string, AccountProfile | undefined>,
  prefs: { hidden: Record<string, string[]>; headline: Record<string, string> },
  nowMs: number,
  order: AccountOrder = {},
): ProviderRouting[] {
  return providerLimits(files, quotas, profiles, prefs, nowMs, order).flatMap(({ provider, headline }) => {
    const window = headline.label;
    const providerFiles = sortByOrder(files.filter((file) => providerForFile(file) === provider), order[provider], quotaKey);
    const plan = routingPlan(routingCandidates(providerFiles, quotas, profiles), window, nowMs);
    return plan && window ? [{ provider, window, plan }] : [];
  });
}

/**
 * Why Settings › Routing's account order has nothing to show, so it says so rather than vanishing: the core isn't
 * running, the accounts are still being read, there are none in use, or none has a limit reading to order by yet.
 */
export function accountOrderGap({ coreReady, loaded, accounts, reading, routings }: {
  coreReady: boolean;
  loaded: boolean;
  /** Accounts in use. */
  accounts: number;
  /** Whether any of their limits is being read. */
  reading: boolean;
  routings: number;
}): 'core' | 'loading' | 'none' | 'unread' | null {
  if (routings > 0) return null;
  if (!coreReady) return 'core';
  if (!loaded) return 'loading';
  if (accounts === 0) return 'none';
  return reading ? 'loading' : 'unread';
}

/** Sets the suggested priorities through the core. It picks each one up straight away. */
export async function applyRoutingPlan(
  changes: RoutingItem[],
  api: { patch: (path: string, body: Record<string, unknown>) => Promise<unknown> } = managementApi,
) {
  // Callers read the shared account list again after, which a run that failed partway may still have changed.
  for (const change of changes) {
    if (change.suggested === null) continue;
    await api.patch('/auth-files/fields', { name: change.fileName, priority: change.suggested });
  }
}

/** Providers whose suggested priorities are applied after every limit refresh. */
const parseAuto = (raw: string | null): Record<string, boolean> =>
  Object.fromEntries(Object.entries(storedRecord(raw)).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
const auto = savedStore<Record<string, boolean>>({ key: 'arbor.routing-auto.v1', parse: parseAuto, fallback: {} });
export const useRoutingAuto = auto.useValue;
export const getRoutingAuto = auto.get;
export function setRoutingAuto(provider: string, enabled: boolean) {
  auto.set({ ...auto.get(), [provider]: enabled });
}

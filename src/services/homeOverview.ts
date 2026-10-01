import type { MessageKey, MessageVariables } from '../i18n/resources';
import type { HealthPoint, HealthReason, MachineHealth, MachineSessions } from '../native/types';
import { isStaleQuota, rowWindowMs, usagePace, windowDurationMs, type PaceTone } from './accountLimits';
import { authFileAvailability, parseAuthFilePriority } from './authFiles';
import type { FleetBoard, FleetSession } from './fleetBoard';
import { formatBytes, KIB } from './machineHealth';
import { planLabel } from './planCosts';
import { formatResetCountdown, type ProviderLimit } from './providerLimits';
import type { AuthFile } from './quotaService';

/** Start of the local calendar day, so "today" matches the Usage page's Today range. */
export const todayRange = (now = new Date()) => {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { start: start.toISOString(), end: now.toISOString() };
};

/**
 * Whether the proxy can send an account requests right now, from the core's own listing of it: `ready`, or why it's
 * skipped and, where the core says, when it's back.
 */
export type HomeAccountState =
  | { kind: 'ready' }
  | { kind: 'limit' | 'retrying'; backAtMs?: number }
  | { kind: 'signin' | 'off' | 'refused' };

/** One account under its provider on Home: what's left of the provider's headline window and when it comes back. */
export type HomeAccount = {
  key: string;
  name: string;
  /** The plan the provider reports, as words ("Max 20x"); null when it doesn't say. */
  plan: string | null;
  /** Percent left of the headline window; null without a reading of it. */
  percent: number | null;
  resetAtMs: number | undefined;
  tone: PaceTone;
  /** Held over from an earlier check because the latest failed. */
  stale: boolean;
  /** The core's priority for it: higher goes first, and none is 0. */
  priority: number;
  state: HomeAccountState;
  /** Gets new requests now: ready, in the highest priority any ready account has. */
  taking: boolean;
};

const accountState = (file: AuthFile | undefined, nowMs: number): HomeAccountState => {
  // Without the core's listing of it there's nothing to say it's skipped.
  if (!file) return { kind: 'ready' };
  const availability = authFileAvailability(file, nowMs);
  switch (availability.kind) {
    case 'ready': return { kind: 'ready' };
    case 'limit':
    case 'retrying': return { kind: availability.kind, backAtMs: availability.retryAtMs };
    case 'signin': return { kind: 'signin' };
    case 'disabled': return { kind: 'off' };
    case 'access':
    case 'unavailable': return { kind: 'refused' };
  }
};

/**
 * The provider's accounts in the order the proxy tries them, each read against the window its pooled figure uses.
 * The core only sends new requests to the highest priority that has an account it can use, sharing them between the
 * accounts there, and moves down a priority only when every one above is skipped (core-routing-semantics). Accounts
 * with the same priority keep their saved order.
 */
export function homeAccounts(limit: ProviderLimit, nowMs: number, files: ReadonlyMap<string, AuthFile> = new Map()): HomeAccount[] {
  const duration = limit.headline.label ? windowDurationMs(limit.headline.label) : null;
  const accounts = limit.headline.segments.map((segment) => {
    const { row } = segment;
    const account = segment.account as ProviderLimit['accounts'][number];
    const file = files.get(account.key);
    return {
      key: account.key,
      name: account.name,
      plan: account.quota.plan ? planLabel(account.quota.plan) : null,
      percent: segment.percent,
      resetAtMs: row?.resetAtMs,
      tone: usagePace(segment.percent, row?.resetAtMs, row ? rowWindowMs(row) : duration, nowMs).tone,
      stale: segment.percent !== null && isStaleQuota(account.quota),
      priority: (file ? parseAuthFilePriority(file.priority) : undefined) ?? 0,
      state: accountState(file, nowMs),
      taking: false,
    };
  });
  const ready = accounts.filter((account) => account.state.kind === 'ready');
  const top = ready.length ? Math.max(...ready.map((account) => account.priority)) : null;
  return accounts
    .map((account, index) => ({ account: { ...account, taking: account.state.kind === 'ready' && account.priority === top }, index }))
    .sort((a, b) => b.account.priority - a.account.priority || a.index - b.index)
    .map(({ account }) => account);
}

/** One machine on Home: its health, what its agents are doing now, and what it sent through the proxy today. */
export type HomeMachine = {
  machine: string;
  thisMachine: boolean;
  /** Null for a machine Arbor only knows from its sessions, with no host added. */
  health: MachineHealth | null;
  /** Sessions working now, and those asking for approval or an answer, from the live board. Snoozed ones aren't counted. */
  working: number;
  waiting: number;
  /** The working sessions by agent: Claude (Code, the SDK or in T3 Code), Codex, and any other. */
  workingAgents: Record<AgentFamily, number>;
  /** Null when it made no request today. */
  today: MachineSessions | null;
};

/** Why the proxy skips an account, and when it's back where the core says, in place of when its limit resets. */
export function accountSkippedText(state: HomeAccountState, now: number, t: (key: MessageKey, variables?: MessageVariables) => string): string | null {
  switch (state.kind) {
    case 'ready': return null;
    case 'limit':
    case 'retrying': {
      const back = formatResetCountdown(state.backAtMs, now);
      const prefix = t(state.kind === 'limit' ? 'home.accounts.skipped.limit' : 'home.accounts.skipped.retrying');
      return back ? t('home.accounts.skipped.back', { reason: prefix, time: back }) : prefix;
    }
    case 'signin': return t('home.accounts.skipped.signin');
    case 'off': return t('home.accounts.skipped.off');
    case 'refused': return t('home.accounts.skipped.refused');
  }
}

/**
 * Every machine using the proxy, this one first, then the rest in the order Machines lists them, then any only known
 * from today's sessions, and those with no host last. The order stays put while their activity changes, so a card
 * doesn't move under the pointer.
 */
export type AgentFamily = 'claude' | 'codex' | 'other';

/** Which agent a board session is, from its client or, for T3 Code's threads, its provider. */
export function agentFamily(row: Pick<FleetSession, 'client' | 'agent'>): AgentFamily {
  if (row.client === 'claudeCode' || row.client === 'claudeSdk') return 'claude';
  if (row.client === 'codex') return 'codex';
  if (row.agent?.toLowerCase().startsWith('claude')) return 'claude';
  if (row.agent?.toLowerCase() === 'codex') return 'codex';
  return 'other';
}

export function homeMachines(
  health: readonly MachineHealth[],
  sessions: readonly MachineSessions[],
  board: Pick<FleetBoard, 'rows'> | null,
  thisMachine: string,
): HomeMachine[] {
  const today = new Map(sessions.filter((item) => item.machine).map((item) => [item.machine, item]));
  const rows = (board?.rows ?? []).filter((row) => row.machine && row.snoozedUntilMs === null);
  const build = (machine: string, item: MachineHealth | null): HomeMachine => {
    const working = rows.filter((row) => row.machine === machine && row.status === 'working');
    const workingAgents: Record<AgentFamily, number> = { claude: 0, codex: 0, other: 0 };
    for (const row of working) workingAgents[agentFamily(row)] += 1;
    return {
      machine,
      thisMachine: machine === thisMachine || Boolean(item?.local),
      health: item,
      working: working.length,
      waiting: rows.filter((row) => row.machine === machine && row.countsAsWaiting).length,
      workingAgents,
      today: today.get(machine) ?? null,
    };
  };
  const listed = health.map((item) => build(item.machine, item));
  const known = new Set(listed.map((item) => item.machine));
  const extra = [...new Set([...today.keys(), ...rows.map((row) => row.machine)])]
    .filter((machine) => !known.has(machine))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((machine) => build(machine, null));
  const rank = (item: HomeMachine) => (item.thisMachine ? 0 : item.health?.status === 'unconfigured' ? 3 : item.health ? 1 : 2);
  return [...listed, ...extra]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * The proxy card's two ends, as the site draws them: the machines sending it requests and the accounts it passes them
 * to. `machines` is null until health has been read, and `accounts` while the core's list isn't loaded.
 */
export type ProxyFlow = {
  machines: { count: number; sentToday: number } | null;
  accounts: { count: number; ready: number } | null;
};

export function proxyFlow(machines: readonly HomeMachine[] | null, files: readonly AuthFile[] | null, nowMs: number): ProxyFlow {
  return {
    machines: machines ? { count: machines.length, sentToday: machines.filter((item) => (item.today?.requests ?? 0) > 0).length } : null,
    accounts: files ? { count: files.length, ready: files.filter((file) => authFileAvailability(file, nowMs).kind === 'ready').length } : null,
  };
}

/** What's pulling a machine's score down, in the words Machines uses. */
export function healthReasonText(reason: HealthReason, latest: HealthPoint): { key: MessageKey; variables: MessageVariables } {
  const { metric, value } = reason;
  switch (metric) {
    case 'disk':
      return { key: 'machines.health.reason.disk', variables: { free: formatBytes(latest.diskFreeKb * KIB, 0) } };
    case 'memory':
      return { key: 'machines.health.reason.memory', variables: { value: Math.round(value) } };
    case 'swap':
      return { key: 'machines.health.reason.swap', variables: { value: Math.round(value) } };
    case 'cpu':
      return { key: 'machines.health.reason.cpu', variables: { value: Math.round(value) } };
    case 'load':
      return { key: 'machines.health.reason.load', variables: { value: value.toFixed(1) } };
    case 'cpuTemp':
      return { key: 'machines.health.reason.cpuTemp', variables: { value: Math.round(value) } };
    case 'gpuTemp':
      return { key: 'machines.health.reason.gpuTemp', variables: { value: Math.round(value) } };
  }
}

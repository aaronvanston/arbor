import { listen } from '@tauri-apps/api/event';
import { useSyncExternalStore } from 'react';
import type { MessageKey } from '../i18n/resources';
import { formatAgo, formatDuration } from '../lib/format';
import { invokeCommand } from '../native/commands';
import type {
  ComputeLimit,
  ComputeLimitKind,
  ComputePoint,
  ComputeProviderId,
  ComputeProviderSnapshot,
  ComputeSandbox,
  ComputeSnapshot,
  ComputeStartBlock,
} from '../native/types';
import { readingTone } from './machineHealth';
import { COMPUTE_UPDATED_EVENT, computeHint, correctComputeHint } from './computeHint';
import { replaceEqualDeep, useStoreSelector } from './stableValue';
import { shortSessionId } from './usageSessions';

/**
 * Compute: cloud sandboxes from the providers the user connected (src-tauri/src/compute.rs). Rust reads each provider
 * once a minute and holds the latest snapshot; this file keeps the window's copy of it and the figures every Compute
 * screen shows. The saved hint that says a provider is connected lives in ./computeHint.ts, which launch reads; this
 * file loads only in the chunks that show Compute, so an install that never connects a provider pays nothing for it.
 */

// ---------------------------------------------------------------------------
// The snapshot store
// ---------------------------------------------------------------------------

export type ComputeState = {
  /** The latest snapshot, or null until the first read answers. Only connected providers are in it. */
  snapshot: ComputeSnapshot | null;
  /** Why the last read failed, when it did; the snapshot before it stays. */
  error: string | null;
};

const EMPTY: ComputeState = { snapshot: null, error: null };
let state: ComputeState = EMPTY;
const listeners = new Set<() => void>();
let stopListening: Promise<() => void> | null = null;
/** The last stop's unlisten, which Tauri finishes asynchronously; tests wait on it before tearing the window down. */
let stopped: Promise<void> = Promise.resolve();
let watchingHint = false;

/** Takes a state; one equal to the last keeps the same object and tells no one. */
function publish(next: ComputeState) {
  const kept = replaceEqualDeep(state, next);
  if (kept === state) return;
  state = kept;
  for (const listener of listeners) listener();
}

/** Takes a snapshot from a command or the event, and corrects the hint from it. */
export function takeComputeSnapshot(snapshot: ComputeSnapshot) {
  publish({ snapshot, error: null });
  correctComputeHint(snapshot);
}

/** Reads what Rust holds now. Never reaches a provider. */
export async function loadCompute(): Promise<void> {
  try {
    takeComputeSnapshot(await invokeCommand('get_compute'));
  } catch (error) {
    publish({ ...state, error: String(error) });
  }
}

/** Starts following Rust: one read, then the event after every round. Only while the hint names a provider. */
function start() {
  if (stopListening) return;
  stopListening = listen<ComputeSnapshot>(COMPUTE_UPDATED_EVENT, ({ payload }) => takeComputeSnapshot(payload))
    .catch(() => () => undefined);
  void loadCompute();
}

function stop() {
  const stopping = stopListening;
  stopListening = null;
  // Unlistening is itself async and can fail once the window is going away; nothing is left to undo then.
  if (stopping) stopped = stopping.then((unlisten) => unlisten()).catch(() => undefined);
}

/** Follows the hint: a provider connected starts the reads, the last one gone stops them. */
function followHint() {
  if (computeHint.get().length) start();
  else stop();
}

function watchHint() {
  if (watchingHint) return;
  watchingHint = true;
  computeHint.subscribe(followHint);
}

/** Calls `listener` after each change to Compute's state; reads it first when a provider is connected. */
export function subscribeCompute(listener: () => void) {
  watchHint();
  followHint();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const currentCompute = () => state;

/** Compute's state, kept current while anything shows it. */
export const useCompute = () => useSyncExternalStore(subscribeCompute, currentCompute, currentCompute);

/** Part of Compute's state: the component renders again only when that part changes. */
export const useComputeSelect = <T,>(select: (state: ComputeState) => T): T => useStoreSelector(subscribeCompute, currentCompute, select);

/** For tests: forgets the state and stops following, as at launch, settling once the listener is gone. */
export async function resetComputeStore(): Promise<void> {
  stop();
  state = EMPTY;
  for (const listener of listeners) listener();
  await stopped;
}

// ---------------------------------------------------------------------------
// What the window asks of Rust
// ---------------------------------------------------------------------------

/** Checks a key with a live read and saves it when it works. A failure is a `CommandError` (`refused`, `unreachable`, `failed`). */
export async function connectComputeProvider(provider: ComputeProviderId, key: string): Promise<ComputeSnapshot> {
  const snapshot = await invokeCommand('connect_compute_provider', { provider, key });
  takeComputeSnapshot(snapshot);
  return snapshot;
}

/** Forgets the provider's key and everything read with it. Can't be undone: the window confirms first. */
export async function disconnectComputeProvider(provider: ComputeProviderId): Promise<ComputeSnapshot> {
  const snapshot = await invokeCommand('disconnect_compute_provider', { provider });
  takeComputeSnapshot(snapshot);
  return snapshot;
}

/** Runs a round now (Rust skips it when one ran in the last 10 s) and takes what it read. */
export async function refreshCompute(): Promise<ComputeSnapshot> {
  const snapshot = await invokeCommand('refresh_compute');
  takeComputeSnapshot(snapshot);
  return snapshot;
}

/** Every reading Rust holds for one sandbox, about two hours, oldest first, for its page's chart. */
export const readComputeHistory = (provider: ComputeProviderId, sandboxId: string): Promise<ComputePoint[]> =>
  invokeCommand('get_compute_sandbox_history', { provider, sandboxId });

/** Opens the sandbox on the provider's own dashboard, in the browser. */
export const openComputeSandbox = (provider: ComputeProviderId, sandboxId: string) =>
  invokeCommand('open_compute_sandbox', { provider, sandboxId });

/** Drops what the command line linked a sandbox to; Rust sends the snapshot without it before this returns. */
export const unlinkComputeSandbox = (provider: ComputeProviderId, sandboxId: string) =>
  invokeCommand('unlink_compute_sandbox', { provider, sandboxId });

// ---------------------------------------------------------------------------
// Figures every screen shows
// ---------------------------------------------------------------------------

/** A sandbox that counts as running: anything not stopped, starting and in error included, since each holds its place. */
export const isActiveSandbox = (sandbox: Pick<ComputeSandbox, 'state'>) => sandbox.state !== 'stopped';

export const activeSandboxes = (sandboxes: readonly ComputeSandbox[]) => sandboxes.filter(isActiveSandbox);

/** A provider's sandboxes that are running. */
export const runningCount = (provider: Pick<ComputeProviderSnapshot, 'sandboxes'>) => provider.sandboxes.filter(isActiveSandbox).length;

/** Every sandbox of the providers, each with the provider it's from. */
export type ProvidedSandbox = ComputeSandbox & { provider: ComputeProviderId };
export const allSandboxes = (providers: readonly ComputeProviderSnapshot[]): ProvidedSandbox[] =>
  providers.flatMap((provider) => provider.sandboxes.map((sandbox) => ({ ...sandbox, provider: provider.id })));

/** The providers a view shows: one when it names it, else every connected one. */
export const shownProviders = (snapshot: ComputeSnapshot | null, provider?: ComputeProviderId): ComputeProviderSnapshot[] =>
  (snapshot?.providers ?? []).filter((entry) => !provider || entry.id === provider);

export const findProvider = (snapshot: ComputeSnapshot | null, provider: ComputeProviderId) =>
  snapshot?.providers.find((entry) => entry.id === provider);

export const findSandbox = (snapshot: ComputeSnapshot | null, provider: ComputeProviderId, sandboxId: string) =>
  findProvider(snapshot, provider)?.sandboxes.find((sandbox) => sandbox.id === sandboxId);

/**
 * How old a rate-limited provider's list may be and still count as current. A provider can ask Arbor to slow down over
 * the CPU and memory reads alone, with the list read fine; past two missed rounds the list is an earlier read's too.
 */
export const RATE_LIMITED_STALE_MS = 150_000;

/** Whether a provider asking Arbor to slow down has kept it from reading the list for longer than a passing while. */
export const rateLimitedListStale = (provider: Pick<ComputeProviderSnapshot, 'status' | 'checkedAtMs'>, nowMs: number) =>
  provider.status === 'rateLimited' && (provider.checkedAtMs === null || nowMs - provider.checkedAtMs > RATE_LIMITED_STALE_MS);

/** A sandbox's CPU and memory as fractions, or null until it's been read. */
export const sandboxCpu = (sandbox: Pick<ComputeSandbox, 'load'>) => (sandbox.load.kind === 'read' ? sandbox.load.cpu : null);
export const sandboxMemory = (sandbox: Pick<ComputeSandbox, 'load'>) => (sandbox.load.kind === 'read' ? sandbox.load.memory : null);

/**
 * Why a sandbox has no reading, or null with nothing to say. Rust gives a sandbox stopping or in error `unavailable`
 * whatever the key can do, so only a running one's says the key can't read it.
 */
export function loadUnreadLabel(sandbox: Pick<ComputeSandbox, 'load' | 'state'>): MessageKey | null {
  if (sandbox.load.kind === 'read') return null;
  if (sandbox.load.kind === 'unavailable' && sandbox.state !== 'running') return null;
  return `compute.load.${sandbox.load.kind}`;
}

/** A share (0–1) as the whole percent a table shows. */
export const percentOf = (share: number | null) => (share === null ? null : Math.round(share * 100));

export type ComputeTone = 'primary' | 'warning' | 'error' | 'muted';

/** CPU and memory take the machines' own thresholds (`READING_LIMITS`), so a busy sandbox reads like a busy machine. */
export const cpuTone = (sandbox: Pick<ComputeSandbox, 'load'>): ComputeTone => readingTone('cpu', percentOf(sandboxCpu(sandbox)));
export const memoryTone = (sandbox: Pick<ComputeSandbox, 'load'>): ComputeTone => readingTone('mem', percentOf(sandboxMemory(sandbox)));

/** CPU this high is at its limit: what runs there waits on CPU. The machines' critical line. */
export const cpuAtLimit = (sandbox: Pick<ComputeSandbox, 'load'>) => cpuTone(sandbox) === 'error';

export type ComputeTotals = {
  running: number;
  vcpus: number;
  memoryGb: number;
  /** vCPUs in use now, Σ cpu × vCPUs over the sandboxes read. */
  busyVcpus: number;
  /** How many have a reading. */
  read: number;
  /** How many are above the CPU warning line. */
  hot: number;
};

/** What the running sandboxes add up to. Stopped ones count for nothing. */
export function computeTotals(sandboxes: readonly ComputeSandbox[]): ComputeTotals {
  const totals: ComputeTotals = { running: 0, vcpus: 0, memoryGb: 0, busyVcpus: 0, read: 0, hot: 0 };
  for (const sandbox of activeSandboxes(sandboxes)) {
    totals.running += 1;
    totals.vcpus += sandbox.vcpus;
    totals.memoryGb += sandbox.memoryGb;
    const cpu = sandboxCpu(sandbox);
    if (cpu === null) continue;
    totals.read += 1;
    totals.busyVcpus += cpu * sandbox.vcpus;
    if (cpuTone(sandbox) !== 'primary') totals.hot += 1;
  }
  return totals;
}

export type SizeShare = { size: string; count: number; vcpus: number; memoryGb: number; multiplier: number | null };

/** The running sandboxes by size, most first: each size's count and what one of it has. */
export function sizeMix(sandboxes: readonly ComputeSandbox[]): SizeShare[] {
  const sizes = new Map<string, SizeShare>();
  for (const sandbox of activeSandboxes(sandboxes)) {
    const share = sizes.get(sandbox.size);
    if (share) share.count += 1;
    else sizes.set(sandbox.size, { size: sandbox.size, count: 1, vcpus: sandbox.vcpus, memoryGb: sandbox.memoryGb, multiplier: sandbox.multiplier });
  }
  return [...sizes.values()].sort((left, right) => right.count - left.count || left.size.localeCompare(right.size));
}

/**
 * What started a sandbox, as the mix and the groups put it: a machine Arbor knows, nothing linked yet, or a teammate,
 * whose sandboxes are never linked.
 */
export type SandboxOrigin = { kind: 'machine'; machine: string } | { kind: 'notLinked' } | { kind: 'teammate' };

export const sandboxOrigin = (sandbox: Pick<ComputeSandbox, 'mine' | 'machine'>): SandboxOrigin =>
  (!sandbox.mine ? { kind: 'teammate' } : sandbox.machine ? { kind: 'machine', machine: sandbox.machine } : { kind: 'notLinked' });

export const originKey = (origin: SandboxOrigin) => (origin.kind === 'machine' ? `machine:${origin.machine}` : origin.kind);

export type OriginShare = { origin: SandboxOrigin; count: number; vcpus: number };

/** The running sandboxes by what started them: machines by name, then not linked, then teammates'. */
export function machineMix(sandboxes: readonly ComputeSandbox[]): OriginShare[] {
  const origins = new Map<string, OriginShare>();
  for (const sandbox of activeSandboxes(sandboxes)) {
    const origin = sandboxOrigin(sandbox);
    const key = originKey(origin);
    const share = origins.get(key);
    if (share) {
      share.count += 1;
      share.vcpus += sandbox.vcpus;
    } else {
      origins.set(key, { origin, count: 1, vcpus: sandbox.vcpus });
    }
  }
  const rank = (origin: SandboxOrigin) => (origin.kind === 'machine' ? 0 : origin.kind === 'notLinked' ? 1 : 2);
  return [...origins.values()].sort((left, right) => rank(left.origin) - rank(right.origin)
    || (left.origin.kind === 'machine' && right.origin.kind === 'machine' ? left.origin.machine.localeCompare(right.origin.machine) : 0));
}

export type ComputeGrouping = 'provider' | 'machine' | 'size';
export const COMPUTE_GROUPINGS: readonly ComputeGrouping[] = ['provider', 'machine', 'size'];

export type ComputeGroup =
  | { kind: 'provider'; key: string; provider: ComputeProviderSnapshot; sandboxes: ProvidedSandbox[]; vcpus: number; memoryGb: number }
  | { kind: 'machine'; key: string; origin: SandboxOrigin; sandboxes: ProvidedSandbox[]; vcpus: number; memoryGb: number }
  | { kind: 'size'; key: string; size: SizeShare; sandboxes: ProvidedSandbox[]; vcpus: number; memoryGb: number };

const sums = (sandboxes: readonly ComputeSandbox[]) => ({
  vcpus: sandboxes.reduce((sum, sandbox) => sum + sandbox.vcpus, 0),
  memoryGb: sandboxes.reduce((sum, sandbox) => sum + sandbox.memoryGb, 0),
});

/**
 * The running sandboxes of the providers shown, in groups: by provider (one group each that has any), by what started
 * them (as `machineMix` orders them), or by size (as `sizeMix` does). Within a group, oldest first.
 */
export function groupSandboxes(providers: readonly ComputeProviderSnapshot[], by: ComputeGrouping): ComputeGroup[] {
  const oldestFirst = (list: ProvidedSandbox[]) => [...list].sort((left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id));
  const active = allSandboxes(providers).filter(isActiveSandbox);
  if (by === 'provider') {
    return providers.flatMap((provider) => {
      const list = oldestFirst(active.filter((sandbox) => sandbox.provider === provider.id));
      return list.length ? [{ kind: 'provider' as const, key: provider.id, provider, sandboxes: list, ...sums(list) }] : [];
    });
  }
  if (by === 'machine') {
    return machineMix(active).map(({ origin }) => {
      const key = originKey(origin);
      const list = oldestFirst(active.filter((sandbox) => originKey(sandboxOrigin(sandbox)) === key));
      return { kind: 'machine' as const, key, origin, sandboxes: list, ...sums(list) };
    });
  }
  return sizeMix(active).map((size) => {
    const list = oldestFirst(active.filter((sandbox) => sandbox.size === size.size));
    return { kind: 'size' as const, key: size.size, size, sandboxes: list, ...sums(list) };
  });
}

// ---------------------------------------------------------------------------
// Limits, plan hours and burn
// ---------------------------------------------------------------------------

/**
 * Where a limit turns warning and critical, as a share of its maximum. 80% is also where the alerts start
 * (computeAlerts.ts), so a limit an alert names always shows in its warning color.
 */
export const LIMIT_LEVELS = { warning: 0.8, critical: 0.95 } as const;

/** How much of a limit is used, 0–1, or null when it has no maximum. */
export const limitShare = (limit: Pick<ComputeLimit, 'used' | 'max'>) =>
  (limit.max === null || limit.max <= 0 ? null : Math.min(1, Math.max(0, limit.used / limit.max)));

export function limitTone(limit: Pick<ComputeLimit, 'used' | 'max'>): ComputeTone {
  const share = limitShare(limit);
  return share === null ? 'muted' : share >= LIMIT_LEVELS.critical ? 'error' : share >= LIMIT_LEVELS.warning ? 'warning' : 'primary';
}

export const findLimit = (provider: Pick<ComputeProviderSnapshot, 'limits'>, kind: ComputeLimitKind) =>
  provider.limits.find((limit) => limit.kind === kind);

/** The limits the page lists as meters, in this order; plan hours have their own cell. */
export const METER_LIMITS: readonly ComputeLimitKind[] = ['activeSandboxes', 'startsPerMinute', 'startsPerHour', 'startsPerDay', 'extraSpend'];

export const LIMIT_LABEL: Record<ComputeLimitKind, MessageKey> = {
  activeSandboxes: 'compute.limit.activeSandboxes',
  startsPerMinute: 'compute.limit.startsPerMinute',
  startsPerHour: 'compute.limit.startsPerHour',
  startsPerDay: 'compute.limit.startsPerDay',
  planHours: 'compute.limit.planHours',
  extraSpend: 'compute.limit.extraSpend',
};

export const START_BLOCK_LABEL: Record<ComputeStartBlock, MessageKey> = {
  planHoursGone: 'compute.startBlock.planHoursGone',
  walletEmpty: 'compute.startBlock.walletEmpty',
  startRate: 'compute.startBlock.startRate',
  activeMax: 'compute.startBlock.activeMax',
  other: 'compute.startBlock.other',
};

export type PlanHours = {
  used: number;
  max: number;
  left: number;
  share: number;
  /** Plan hours used each hour at the current rate: Σ billing multiplier of the running sandboxes. */
  perHour: number | null;
  /** When they'd run out at that rate; null while nothing uses them. */
  runOutAtMs: number | null;
  /** When the period ends and they reset, if the provider says. */
  resetsAtMs: number | null;
  /** They'd run out before the period ends. */
  runsOutFirst: boolean;
};

/** Hours to run-out under which plan hours read as a warning, and as critical. */
export const RUN_OUT_LEVELS_MS = { warning: 48 * 3_600_000, critical: 2 * 3_600_000 } as const;

/** A provider's plan hours and how fast they go, or null when it doesn't report them. */
export function planHours(provider: ComputeProviderSnapshot): PlanHours | null {
  const limit = findLimit(provider, 'planHours');
  if (!limit || limit.max === null) return null;
  const left = Math.max(0, limit.max - limit.used);
  const resetsAtMs = limit.resetsAtMs ?? provider.periodEndMs;
  const runOutAtMs = provider.runOutAtMs;
  return {
    used: limit.used,
    max: limit.max,
    left,
    share: limitShare(limit) ?? 0,
    perHour: provider.planHoursPerHour,
    runOutAtMs,
    resetsAtMs,
    runsOutFirst: runOutAtMs !== null && resetsAtMs !== null && runOutAtMs < resetsAtMs,
  };
}

/**
 * How plan hours read: critical once they're gone or run out within two hours, a warning when they'd run out within
 * two days or before the reset, or past 80% used.
 */
export function planHoursTone(hours: PlanHours, nowMs: number): ComputeTone {
  const untilRunOut = hours.runOutAtMs === null ? null : hours.runOutAtMs - nowMs;
  if (hours.left <= 0 || (untilRunOut !== null && untilRunOut < RUN_OUT_LEVELS_MS.critical)) return 'error';
  if (hours.runsOutFirst || (untilRunOut !== null && untilRunOut < RUN_OUT_LEVELS_MS.warning) || hours.share >= LIMIT_LEVELS.warning) return 'warning';
  return 'primary';
}

/** Whether to show dollars: not while every cost is $0, as on a plan whose hours cover everything. */
export const dollarsShown = (providers: readonly ComputeProviderSnapshot[]) =>
  providers.some((provider) => provider.sandboxes.some((sandbox) => (sandbox.monthDollars ?? 0) > 0));

// ---------------------------------------------------------------------------
// Times, as the rows and pages write them
// ---------------------------------------------------------------------------

/** How long until it stops by itself, or null with no auto-stop. Never below zero. */
export const stopsInMs = (sandbox: Pick<ComputeSandbox, 'stopsAtMs'>, nowMs: number) =>
  (sandbox.stopsAtMs === null ? null : Math.max(0, sandbox.stopsAtMs - nowMs));

/** "2h 48m", rounded up as a countdown is; null with no auto-stop, for the row to say so. */
export const formatStopsIn = (sandbox: Pick<ComputeSandbox, 'stopsAtMs'>, nowMs: number) => {
  const ms = stopsInMs(sandbox, nowMs);
  return ms === null ? null : formatDuration(ms, 'up');
};

/** A stop this close reads as a warning. */
export const STOPS_SOON_MS = 15 * 60_000;
export const stopsSoon = (sandbox: Pick<ComputeSandbox, 'stopsAtMs'>, nowMs: number) => {
  const ms = stopsInMs(sandbox, nowMs);
  return ms !== null && ms < STOPS_SOON_MS;
};

/**
 * How long its current run has lasted: from its last start or resume, not when it was first made, since a sandbox
 * resumed this morning hasn't been running for the three days since it was created.
 */
export const sandboxAgeMs = (sandbox: Pick<ComputeSandbox, 'startedAtMs'>, nowMs: number) => Math.max(0, nowMs - sandbox.startedAtMs);
/** How long it has run: "1h 12m". */
export const formatSandboxAge = (sandbox: Pick<ComputeSandbox, 'startedAtMs'>, nowMs: number) => formatDuration(sandboxAgeMs(sandbox, nowMs));

/** How long ago the provider was last read: "3m ago", or null before it ever was. */
export const formatReadAgo = (provider: Pick<ComputeProviderSnapshot, 'checkedAtMs'>, nowMs: number) =>
  (provider.checkedAtMs === null ? null : formatAgo(provider.checkedAtMs, nowMs));

/** How long ago a linked session ended, for "ended 41m ago". */
export const formatEndedAgo = (endedAtMs: number, nowMs: number) => formatDuration(Math.max(0, nowMs - endedAtMs));

/** A session id short enough for a row: a UUID's first block, any other id cut to its first eight characters. */
export const shortComputeSessionId = (id: string) => {
  const short = shortSessionId(id);
  return short.length > 12 ? `${short.slice(0, 8)}…` : short;
};

/** Plan hours to a tenth, the way the rows write them: "2.4", "0.5", "7". */
export const formatHours = (hours: number) => String(Math.round(hours * 10) / 10);

// ---------------------------------------------------------------------------
// What needs looking at
// ---------------------------------------------------------------------------

/** What a sandbox's row and page flag, in the order they show. */
export type SandboxFlag = 'starting' | 'stopping' | 'error' | 'cpuAtLimit' | 'degraded' | 'forgotten';

/** Flags that say what a sandbox is doing, not that it wants a look. */
const PASSING_FLAGS: ReadonlySet<SandboxFlag> = new Set<SandboxFlag>(['starting', 'stopping']);

export function sandboxFlags(sandbox: ComputeSandbox): SandboxFlag[] {
  if (!isActiveSandbox(sandbox)) return [];
  const flags: SandboxFlag[] = [];
  if (sandbox.state === 'starting') flags.push('starting');
  // Still listed as running until it's gone, so the row says it's on its way out.
  if (sandbox.state === 'stopping') flags.push('stopping');
  if (sandbox.state === 'error') flags.push('error');
  if (cpuAtLimit(sandbox)) flags.push('cpuAtLimit');
  if (sandbox.issue !== null) flags.push('degraded');
  if (sandbox.mine && sandbox.forgotten !== null) flags.push('forgotten');
  return flags;
}

/**
 * A sandbox's dot: error for one in error or at its CPU limit, warning for one degraded or forgotten, `changing` while
 * it starts or stops.
 */
export function sandboxTone(sandbox: ComputeSandbox): ComputeTone | 'changing' {
  const flags = sandboxFlags(sandbox);
  if (!isActiveSandbox(sandbox)) return 'muted';
  if (flags.includes('error') || flags.includes('cpuAtLimit')) return 'error';
  if (flags.includes('degraded') || flags.includes('forgotten')) return 'warning';
  if (flags.includes('starting') || flags.includes('stopping')) return 'changing';
  return 'primary';
}

/**
 * A provider's leaf dot in the sidebar: error for a refused key or blocked starts, warning while it isn't answering or
 * a sandbox wants a look, success with something running, muted with nothing.
 */
export function providerTone(provider: ComputeProviderSnapshot): 'success' | 'warning' | 'error' | 'muted' {
  if (provider.status === 'refused' || provider.canStart === false) return 'error';
  if (provider.status !== 'ok' && provider.status !== 'limitsNeedScope') return 'warning';
  if (provider.sandboxes.some((sandbox) => sandboxFlags(sandbox).some((flag) => !PASSING_FLAGS.has(flag)))) return 'warning';
  return runningCount(provider) ? 'success' : 'muted';
}

/** What the sidebar draws for each provider read: its running count and its dot. */
export type ComputeTreeRead = { id: ComputeProviderId; running: number; tone: ReturnType<typeof providerTone> };

export const computeTreeReads = (state: ComputeState): ComputeTreeRead[] =>
  (state.snapshot?.providers ?? []).map((provider) => ({ id: provider.id, running: runningCount(provider), tone: providerTone(provider) }));

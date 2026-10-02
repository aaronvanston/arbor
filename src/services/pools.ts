import { useEffect, useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invokeCommand } from '../native/commands';
import type { MessageKey } from '../i18n/resources';
import type { MachinePool, PoolMemberVerdict, PoolPreview, PoolVerdictKind, PoolWeight, PoolWhenFull } from '../native/types';

/**
 * Machine pools (see `pools.rs`): named sets of machines harness runs are balanced across, each member with its own
 * weight, and limits past which a member is too busy to take a run. The native side keeps them and works out who would
 * take the next run; this file has what the page says about them.
 */

export const MACHINE_POOLS_UPDATED_EVENT = 'machine-pools-updated';
const MACHINE_HEALTH_UPDATED_EVENT = 'machine-health-updated';

export const POOL_WEIGHTS: readonly PoolWeight[] = ['prefer', 'normal', 'less', 'manual'];

export const POOL_WEIGHT_LABEL: Record<PoolWeight, MessageKey> = {
  prefer: 'pools.weight.prefer',
  normal: 'pools.weight.normal',
  less: 'pools.weight.less',
  manual: 'pools.weight.manual',
};

export const POOL_WHEN_FULL: readonly PoolWhenFull[] = ['refuse', 'queue', 'spill'];

export const POOL_WHEN_FULL_LABEL: Record<PoolWhenFull, MessageKey> = {
  refuse: 'pools.whenFull.refuse',
  queue: 'pools.whenFull.queue',
  spill: 'pools.whenFull.spill',
};

/** A new pool's limits: T3 Code's CPU and memory lines, and room for a few agents a machine. */
export const newPool = (): MachinePool => ({
  id: '', name: '', members: [], maxAgents: 4, cpuCeiling: 95, memFloor: 5, whenFull: 'refuse', spillPool: null, queueTimeoutMin: 30,
});

/** What a member's verdict says, short, beside its figures in their own columns. */
export function verdictMessage(verdict: PoolMemberVerdict): { key: MessageKey; values: Record<string, string | number> } {
  const byKind: Record<PoolVerdictKind, MessageKey> = {
    eligible: 'pools.verdict.eligible',
    manual: 'pools.verdict.manual',
    notListed: 'pools.verdict.notListed',
    off: 'pools.verdict.off',
    noReading: 'pools.verdict.noReading',
    unreachable: 'pools.verdict.unreachable',
    stale: 'pools.verdict.stale',
    agentsFull: 'pools.verdict.agentsFull',
    cpuHigh: 'pools.verdict.cpuHigh',
    memoryLow: 'pools.verdict.memoryLow',
    noHarness: 'pools.verdict.noHarness',
  };
  return { key: byKind[verdict.kind], values: { minutes: Math.max(1, Math.round((verdict.readingAgeMs ?? 0) / 60_000)) } };
}

export type PoolLimit = 'agents' | 'cpu' | 'memory';

/** The limit a verdict says a member is at, so its figure can be marked. */
export const trippedLimit = (kind: PoolVerdictKind): PoolLimit | null =>
  kind === 'agentsFull' ? 'agents' : kind === 'cpuHigh' ? 'cpu' : kind === 'memoryLow' ? 'memory' : null;

/** The limits a pool has on, as words; a member at any one of them is full. Empty when every limit is off. */
export function limitWords(pool: Pick<MachinePool, 'maxAgents' | 'cpuCeiling' | 'memFloor'>): { key: MessageKey; values: Record<string, number> }[] {
  const words: { key: MessageKey; values: Record<string, number> }[] = [];
  if (pool.maxAgents !== null) words.push({ key: 'pools.limit.agents', values: { count: pool.maxAgents } });
  if (pool.cpuCeiling !== null) words.push({ key: 'pools.limit.cpu', values: { percent: pool.cpuCeiling } });
  if (pool.memFloor !== null) words.push({ key: 'pools.limit.memory', values: { percent: pool.memFloor } });
  return words;
}

/** How a member's chance is worked out: by free agent slots under an agent limit, else by agents running. */
export const shareRule = (pool: Pick<MachinePool, 'maxAgents'>): MessageKey =>
  pool.maxAgents === null ? 'pools.how.shareOpen' : 'pools.how.shareSlots';

/**
 * The preview's plan as the page shows it: the runs that would find a member, in order, and whether the pool fills
 * before the plan's end (every later run then waits, spills or doesn't start).
 */
export function planSteps(plan: readonly (string | null)[]): { machines: string[]; fills: boolean } {
  const firstGap = plan.indexOf(null);
  const machines = (firstGap === -1 ? plan : plan.slice(0, firstGap)).filter((machine): machine is string => machine !== null);
  return { machines, fills: firstGap !== -1 };
}

/**
 * How a pool stands as a whole: some member has room for a run, none has (so a run waits, spills or doesn't start), it
 * has no machines that are ever picked, or its preview hasn't come in.
 */
export type PoolStanding = 'room' | 'full' | 'empty' | 'checking';

export function poolStanding(pool: Pick<MachinePool, 'members'>, preview: Pick<PoolPreview, 'members'> | undefined): {
  standing: PoolStanding;
  withRoom: number;
  /** The members ever picked for a run: all but the manual-only ones. */
  pickable: number;
} {
  const pickable = pool.members.filter((member) => member.weight !== 'manual').length;
  const withRoom = preview ? preview.members.filter((verdict) => verdict.share > 0).length : 0;
  const standing: PoolStanding = pickable === 0 ? 'empty' : !preview ? 'checking' : withRoom > 0 ? 'room' : 'full';
  return { standing, withRoom, pickable };
}

export const POOL_STANDING_LABEL: Record<PoolStanding, MessageKey> = {
  room: 'pools.standing.room',
  full: 'pools.standing.full',
  empty: 'pools.standing.empty',
  checking: 'pools.verdict.checking',
};

/**
 * A member's load on one of a pool's limits, 0–1 of the way to it, for a meter that fills toward the limit: agents
 * running against the agent limit, CPU against its ceiling, memory used against what the floor leaves. Null when the
 * figure isn't known. With the limit off, the meter shows the figure on its own scale (eight agents, all the CPU or
 * memory) with no line to cross.
 */
export function limitLoad(
  limit: PoolLimit,
  verdict: Pick<PoolMemberVerdict, 'running' | 'cpu' | 'memFree'>,
  pool: Pick<MachinePool, 'maxAgents' | 'cpuCeiling' | 'memFloor'>,
): { fill: number; mark: number | null } | null {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  if (limit === 'agents') {
    if (verdict.running === null) return null;
    const scale = pool.maxAgents ?? Math.max(8, verdict.running);
    return { fill: clamp(verdict.running / scale), mark: pool.maxAgents === null ? null : 1 };
  }
  if (limit === 'cpu') {
    if (verdict.cpu === null) return null;
    return { fill: clamp(verdict.cpu / 100), mark: pool.cpuCeiling === null ? null : pool.cpuCeiling / 100 };
  }
  if (verdict.memFree === null) return null;
  return { fill: clamp((100 - verdict.memFree) / 100), mark: pool.memFloor === null ? null : (100 - pool.memFloor) / 100 };
}

/** Whether a verdict leaves a member out for being busy or unseen, rather than by its weight. */
export const leftOut = (kind: PoolVerdictKind) => kind !== 'eligible' && kind !== 'manual';

/**
 * The folded line beside a pool's name: its members that aren't Normal, by weight, so the shape of the pool reads at a
 * glance (T3 Code's load-balancing header does the same).
 */
export function poolSummary(pool: MachinePool): { machine: string; weight: PoolWeight }[] {
  return pool.members.filter((member) => member.weight !== 'normal');
}

/** Why a draft can't be saved yet, as the native side would refuse it. Null when it can. */
export function poolDraftProblem(draft: MachinePool, pools: readonly MachinePool[]): MessageKey | null {
  const name = draft.name.trim();
  if (!name) return 'pools.problem.name';
  if (pools.some((pool) => pool.id !== draft.id && pool.name.toLowerCase() === name.toLowerCase())) return 'pools.problem.nameTaken';
  if (draft.whenFull === 'spill') {
    if (!draft.spillPool || draft.spillPool === draft.id || !pools.some((pool) => pool.id === draft.spillPool)) return 'pools.problem.spillPool';
    if (spillsBack(draft, pools)) return 'pools.problem.spillLoop';
  }
  return null;
}

/** Whether following a pool's overflow leads back to it. */
function spillsBack(draft: MachinePool, pools: readonly MachinePool[]): boolean {
  const all = [...pools.filter((pool) => pool.id !== draft.id), draft];
  const seen = new Set([draft.id]);
  let next = draft.whenFull === 'spill' ? draft.spillPool : null;
  while (next) {
    if (seen.has(next)) return true;
    seen.add(next);
    const pool = all.find((entry) => entry.id === next);
    next = pool?.whenFull === 'spill' ? pool.spillPool : null;
  }
  return false;
}

/** The pools a draft may send its overflow to: any other saved one. */
export const spillTargets = (draft: MachinePool, pools: readonly MachinePool[]) => pools.filter((pool) => pool.id !== draft.id);

/** Machines that can still join a pool, in the order given. */
export const machinesToAdd = (draft: MachinePool, machines: readonly string[]) => {
  const loose = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const members = new Set(draft.members.map((member) => loose(member.machine)));
  return machines.filter((machine) => !members.has(loose(machine)));
};

// ---------------------------------------------------------------------------
// The pools and their previews, for every page that shows them
// ---------------------------------------------------------------------------

type Snapshot = { pools: MachinePool[] | null; previews: PoolPreview[]; error: string | null };
let snapshot: Snapshot = { pools: null, previews: [], error: null };
const listeners = new Set<() => void>();
let started = false;
/** Pages open that show pools' figures; while there are any, the sampler stays on its fast interval. */
let watching = 0;

const publish = (next: Snapshot) => {
  snapshot = next;
  for (const listener of listeners) listener();
};

async function reloadPreviews() {
  try {
    publish({ ...snapshot, previews: await invokeCommand('preview_pools', { watching: watching > 0 }) });
  } catch {
    // A preview that can't be read leaves the last one up; the pools themselves still show.
  }
}

/** Reads the pools again, and who would take each one's next run. */
export async function reloadPools() {
  try {
    publish({ ...snapshot, pools: await invokeCommand('get_pools'), error: null });
  } catch (error) {
    publish({ ...snapshot, error: String(error) });
  }
  await reloadPreviews();
}

const take = async (pools: MachinePool[]) => {
  publish({ ...snapshot, pools, error: null });
  await reloadPreviews();
  return pools;
};

export const savePool = async (pool: MachinePool) => take(await invokeCommand('save_pool', { pool }));
export const removePool = async (id: string) => take(await invokeCommand('remove_pool', { id }));

function start() {
  if (started) return;
  started = true;
  void reloadPools();
  void listen(MACHINE_POOLS_UPDATED_EVENT, () => void reloadPools()).catch(() => undefined);
  // Each sampling round can change who has room.
  void listen(MACHINE_HEALTH_UPDATED_EVENT, () => { if (listeners.size) void reloadPreviews(); }).catch(() => undefined);
}

const subscribe = (listener: () => void) => {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The pools and their previews, kept current while anything shows them. */
export const usePools = () => useSyncExternalStore(subscribe, () => snapshot, () => snapshot);

/**
 * For a page whose figures should move with the machines, as Machines' do: while it's open the sampler reads every
 * few seconds rather than once a minute. Each round reloads the previews, which keeps it so.
 */
export function usePoolsWatching() {
  useEffect(() => {
    watching += 1;
    void reloadPreviews();
    return () => {
      watching -= 1;
    };
  }, []);
}

/** Sessions working now on each machine, from the live board: the agents a pool counts against its limit. */
export const reportWorkingSessions = (counts: Record<string, number>) => invokeCommand('report_working_sessions', { counts });

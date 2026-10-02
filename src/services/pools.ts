import { useSyncExternalStore } from 'react';
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

/** What a member's verdict says, filled from its figures. */
export function verdictMessage(verdict: PoolMemberVerdict, pool: Pick<MachinePool, 'maxAgents'>): { key: MessageKey; values: Record<string, string | number> } {
  const running = verdict.running ?? 0;
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
  return {
    key: byKind[verdict.kind],
    values: {
      running,
      max: pool.maxAgents,
      cpu: Math.round(verdict.cpu ?? 0),
      free: Math.round(verdict.memFree ?? 0),
      minutes: Math.max(1, Math.round((verdict.readingAgeMs ?? 0) / 60_000)),
    },
  };
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

const publish = (next: Snapshot) => {
  snapshot = next;
  for (const listener of listeners) listener();
};

async function reloadPreviews() {
  try {
    publish({ ...snapshot, previews: await invokeCommand('preview_pools') });
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
export const usePools = () => useSyncExternalStore(subscribe, () => snapshot);

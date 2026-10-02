/** The browser mock's machine pools (Settings › Pools), with a preview read from the mock machines' health. */
import { emit } from '@tauri-apps/api/event';
import type { MachineCommands } from '../../native/machines';
import type { MachineHealthSnapshot, MachinePool, PoolMemberVerdict, PoolPreview, PoolVerdictKind } from '../../native/types';
import type { CommandAnswers } from './answers';
import { freshInstall, mockLog, params } from './scenario';

// `?pools=none`, `full`, `stale` or `open` (every limit off; listed at the top of mockTauri.ts).
const poolsScenario = params.get('pools');

const mockPools: MachinePool[] = poolsScenario === 'none' || freshInstall ? [] : [
  {
    id: 'mock-builds', name: 'Builds', maxAgents: 6, cpuCeiling: 95, memFloor: 5, whenFull: 'spill', spillPool: 'mock-overflow', queueTimeoutMin: 30,
    members: [
      { machine: 'casey-mbp', weight: 'prefer' },
      { machine: 'cedar-02', weight: 'normal' },
      { machine: 'ci-01', weight: 'less' },
      { machine: 'lab-box', weight: 'normal' },
    ],
  },
  {
    id: 'mock-overflow', name: 'Overflow', maxAgents: 2, cpuCeiling: 90, memFloor: 10, whenFull: 'queue', spillPool: null, queueTimeoutMin: 45,
    members: [
      { machine: 'ci-01', weight: 'normal' },
      { machine: 'casey-mbp', weight: 'manual' },
    ],
  },
];
let pools: MachinePool[] = poolsScenario === 'open' ? mockPools.map((pool) => ({ ...pool, maxAgents: null, cpuCeiling: null, memFloor: null })) : mockPools;

/** The pools as they stand, for the mock's runs. */
export const poolsNow = () => pools;

const shares = { prefer: 4, normal: 2, less: 1, manual: 0 } as const;
const loose = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The native side's verdicts (`pools.rs` `assess`), near enough for the page to show each case. */
export function preview(pool: MachinePool, snapshot: MachineHealthSnapshot): PoolPreview {
  const first = assess(pool, snapshot, {});
  // The native side's plan: each run counted as running on its member for the next.
  const sent: Record<string, number> = {};
  const plan = Array.from({ length: 8 }, () => {
    const next = assess(pool, snapshot, sent).likely;
    if (next) sent[next] = (sent[next] ?? 0) + 1;
    return next;
  });
  return { ...first, plan };
}

function assess(pool: MachinePool, snapshot: MachineHealthSnapshot, sent: Record<string, number>): Omit<PoolPreview, 'plan'> {
  const freshForMs = Math.max(15_000, snapshot.intervalMs * 3);
  const members = pool.members.map((member): PoolMemberVerdict => {
    const health = snapshot.machines.find((entry) => loose(entry.machine) === loose(member.machine));
    const verdict: PoolMemberVerdict = { machine: member.machine, weight: member.weight, kind: 'notListed', running: null, cpu: null, memFree: null, readingAgeMs: null, share: 0 };
    if (!health) return verdict;
    const latest = health.latest;
    const full = poolsScenario === 'full';
    verdict.running = latest ? (full ? pool.maxAgents ?? 8 : (latest.claudeRunning ?? 0) + (latest.codexRunning ?? 0)) + (sent[member.machine] ?? 0) : null;
    verdict.cpu = latest?.cpu ?? null;
    verdict.memFree = latest ? Math.max(0, 100 - latest.mem) : null;
    verdict.readingAgeMs = health.lastOkAt === null ? null : poolsScenario === 'stale' ? freshForMs + 40_000 : snapshot.now - health.lastOkAt;
    const kind: PoolVerdictKind = !health.host.enabled ? 'off'
      : health.lastOkAt === null ? (health.error ? 'unreachable' : 'noReading')
      : health.error ? 'unreachable'
      : (verdict.readingAgeMs ?? 0) > freshForMs ? 'stale'
      : pool.maxAgents !== null && (verdict.running ?? 0) >= pool.maxAgents ? 'agentsFull'
      : pool.cpuCeiling !== null && verdict.cpu !== null && verdict.cpu >= pool.cpuCeiling ? 'cpuHigh'
      : pool.memFloor !== null && verdict.memFree !== null && verdict.memFree <= pool.memFloor ? 'memoryLow'
      : member.weight === 'manual' ? 'manual' : 'eligible';
    return { ...verdict, kind };
  });
  const weights = members.map((verdict) => {
    if (verdict.kind !== 'eligible') return 0;
    const running = verdict.running ?? 0;
    return pool.maxAgents === null ? shares[verdict.weight] / (running + 1) : shares[verdict.weight] * Math.max(0, pool.maxAgents - running);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const shared = members.map((verdict, index) => ({ ...verdict, share: total > 0 ? (weights[index] ?? 0) / total : 0 }));
  const best = shared.filter((verdict) => verdict.share > 0).sort((a, b) => b.share - a.share)[0];
  return { pool: pool.id, likely: best?.machine ?? null, members: shared, freshForMs };
}

export const poolAnswers = (
  snapshot: () => MachineHealthSnapshot,
): Pick<CommandAnswers<MachineCommands>, 'get_pools' | 'save_pool' | 'remove_pool' | 'preview_pools'> => ({
  get_pools: () => pools,
  save_pool: ({ pool }) => {
    mockLog('save_pool', pool);
    const name = pool.name.trim();
    if (!name) throw new Error('Give the pool a name.');
    if (pools.some((other) => other.id !== pool.id && other.name.toLowerCase() === name.toLowerCase())) throw new Error(`There's already a pool called ${name}.`);
    const saved: MachinePool = { ...pool, name, id: pool.id || `mock-${Date.now().toString(36)}`, spillPool: pool.whenFull === 'spill' ? pool.spillPool : null };
    pools = [...pools.filter((other) => other.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name));
    void emit('machine-pools-updated', Date.now());
    return pools;
  },
  remove_pool: ({ id }) => {
    mockLog('remove_pool', { id });
    pools = pools.filter((pool) => pool.id !== id).map((pool) => pool.spillPool === id ? { ...pool, whenFull: 'refuse', spillPool: null } : pool);
    void emit('machine-pools-updated', Date.now());
    return pools;
  },
  preview_pools: () => {
    const health = snapshot();
    return pools.map((pool) => preview(pool, health));
  },
});

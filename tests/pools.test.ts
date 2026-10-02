import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import type { MachinePool, PoolMemberVerdict } from '../src/native/types';
import { leftOut, machinesToAdd, newPool, poolDraftProblem, poolSummary, spillTargets, verdictMessage } from '../src/services/pools';

const pool = (patch: Partial<MachinePool> = {}): MachinePool => ({ ...newPool(), id: 'p1', name: 'Builds', ...patch });
const verdict = (patch: Partial<PoolMemberVerdict>): PoolMemberVerdict => ({
  machine: 'casey-mbp', weight: 'normal', kind: 'eligible', running: 1, cpu: 31.6, memFree: 42.2, readingAgeMs: 2_000, share: 0.5, ...patch,
});
const said = (entry: PoolMemberVerdict, max = 4) => {
  const message = verdictMessage(entry, { maxAgents: max });
  return translate(message.key, message.values);
};

describe('a pool member’s standing', () => {
  it('says why it can or can’t take the next run, with its figures', () => {
    expect(said(verdict({}))).toBe('Has room: 1 of 4 agents running');
    expect(said(verdict({ kind: 'agentsFull', running: 4 }))).toBe('Full: 4 agents running, the pool allows 4');
    expect(said(verdict({ kind: 'cpuHigh', cpu: 97.4 }))).toBe('Busy: CPU at 97%');
    expect(said(verdict({ kind: 'memoryLow', memFree: 3.2 }))).toBe('Busy: 3% memory free');
    expect(said(verdict({ kind: 'stale', readingAgeMs: 200_000 }))).toBe('Last reading 3 min ago, too old to go by');
    expect(said(verdict({ kind: 'manual' }))).toBe('Manual only: never picked for a run');
  });

  it('counts a member as left out only when it’s busy or unseen, not for its weight', () => {
    expect(leftOut('eligible')).toBe(false);
    expect(leftOut('manual')).toBe(false);
    expect(leftOut('agentsFull')).toBe(true);
    expect(leftOut('unreachable')).toBe(true);
  });
});

describe('a pool draft', () => {
  const overflow = pool({ id: 'p2', name: 'Overflow' });

  it('needs a name no other pool has, whatever its case', () => {
    expect(poolDraftProblem(pool({ name: '  ' }), [])).toBe('pools.problem.name');
    expect(poolDraftProblem(pool({ name: 'overflow' }), [overflow])).toBe('pools.problem.nameTaken');
    expect(poolDraftProblem(pool(), [pool(), overflow])).toBeNull();
  });

  it('spills only into another saved pool that doesn’t send its overflow back', () => {
    expect(poolDraftProblem(pool({ whenFull: 'spill', spillPool: null }), [overflow])).toBe('pools.problem.spillPool');
    expect(poolDraftProblem(pool({ whenFull: 'spill', spillPool: 'p1' }), [overflow])).toBe('pools.problem.spillPool');
    expect(poolDraftProblem(pool({ whenFull: 'spill', spillPool: 'p2' }), [overflow])).toBeNull();
    const back = { ...overflow, whenFull: 'spill' as const, spillPool: 'p1' };
    expect(poolDraftProblem(pool({ whenFull: 'spill', spillPool: 'p2' }), [pool(), back])).toBe('pools.problem.spillLoop');
    expect(spillTargets(pool(), [pool(), overflow]).map((target) => target.id)).toEqual(['p2']);
  });

  it('offers only machines not in it yet, matching names loosely', () => {
    const draft = pool({ members: [{ machine: 'Casey MBP', weight: 'prefer' }] });
    expect(machinesToAdd(draft, ['casey-mbp', 'ci-01', 'cedar-02'])).toEqual(['ci-01', 'cedar-02']);
  });

  it('sums up its members that aren’t Normal', () => {
    const draft = pool({ members: [{ machine: 'casey-mbp', weight: 'prefer' }, { machine: 'ci-01', weight: 'normal' }, { machine: 'lab-box', weight: 'manual' }] });
    expect(poolSummary(draft).map((member) => `${member.machine} ${member.weight}`)).toEqual(['casey-mbp prefer', 'lab-box manual']);
  });
});

import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import type { MachinePool, PoolMemberVerdict } from '../src/native/types';
import { leftOut, limitWords, machinesToAdd, newPool, planSteps, poolDraftProblem, poolSummary, shareRule, spillTargets, trippedLimit, verdictMessage, whenFullKey } from '../src/services/pools';

const pool = (patch: Partial<MachinePool> = {}): MachinePool => ({ ...newPool(), id: 'p1', name: 'Builds', ...patch });
const verdict = (patch: Partial<PoolMemberVerdict>): PoolMemberVerdict => ({
  machine: 'cam-mbp', weight: 'normal', kind: 'eligible', running: 1, cpu: 31.6, memFree: 42.2, readingAgeMs: 2_000, share: 0.5, ...patch,
});
const said = (entry: PoolMemberVerdict) => {
  const message = verdictMessage(entry);
  return translate(message.key, message.values);
};

describe('a pool member’s standing', () => {
  it('says why it can or can’t take the next run, and marks the limit it’s at', () => {
    expect(said(verdict({}))).toBe('Has room');
    expect(said(verdict({ kind: 'agentsFull', running: 4 }))).toBe('Full: agents working');
    expect(said(verdict({ kind: 'stale', readingAgeMs: 200_000 }))).toBe('Reading 3 min old, too old to go by');
    expect(said(verdict({ kind: 'manual' }))).toBe('Never picked: manual only');
    expect([trippedLimit('agentsFull'), trippedLimit('cpuHigh'), trippedLimit('memoryLow'), trippedLimit('stale')]).toEqual(['agents', 'cpu', 'memory', null]);
  });

  it('counts a member as left out only when it’s busy or unseen, not for its weight', () => {
    expect(leftOut('eligible')).toBe(false);
    expect(leftOut('manual')).toBe(false);
    expect(leftOut('agentsFull')).toBe(true);
    expect(leftOut('unreachable')).toBe(true);
  });
});

describe('how a pool picks', () => {
  const words = (draft: MachinePool) => limitWords(draft).map((limit) => translate(limit.key, limit.values));

  it('names only the limits that are on, any one of which makes a machine full', () => {
    expect(words(pool())).toEqual(['4 agents working', '95% CPU', '5% memory free or less']);
    expect(words(pool({ maxAgents: null, memFloor: null }))).toEqual(['95% CPU']);
    expect(words(pool({ maxAgents: null, cpuCeiling: null, memFloor: null }))).toEqual([]);
  });

  // money-32: with no limits a machine can't be full, so the overflow sentence says when none is answering.
  it('says when a run overflows in terms the pool’s limits allow', () => {
    expect(whenFullKey(pool())).toBe('pools.page.whenFull');
    expect(whenFullKey(pool({ maxAgents: null, cpuCeiling: null, memFloor: null }))).toBe('pools.page.whenNoneAnswer');
  });

  it('explains the chance by free slots under an agent limit, else by agents running', () => {
    expect(shareRule(pool())).toBe('pools.how.shareSlots');
    expect(shareRule(pool({ maxAgents: null }))).toBe('pools.how.shareOpen');
  });

  it('shows the planned runs up to the first that finds no room', () => {
    expect(planSteps(['cam-mbp', 'cedar-02', 'cam-mbp', null, null])).toEqual({ machines: ['cam-mbp', 'cedar-02', 'cam-mbp'], fills: true });
    expect(planSteps(['cam-mbp', 'cam-mbp'])).toEqual({ machines: ['cam-mbp', 'cam-mbp'], fills: false });
    expect(planSteps([null])).toEqual({ machines: [], fills: true });
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
    const draft = pool({ members: [{ machine: 'Cam MBP', weight: 'prefer' }] });
    expect(machinesToAdd(draft, ['cam-mbp', 'ci-01', 'cedar-02'])).toEqual(['ci-01', 'cedar-02']);
  });

  it('sums up its members that aren’t Normal', () => {
    const draft = pool({ members: [{ machine: 'cam-mbp', weight: 'prefer' }, { machine: 'ci-01', weight: 'normal' }, { machine: 'lab-box', weight: 'manual' }] });
    expect(poolSummary(draft).map((member) => `${member.machine} ${member.weight}`)).toEqual(['cam-mbp prefer', 'lab-box manual']);
  });
});

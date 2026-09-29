import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import { t3AdvisoryText } from '../src/pages/MachineAgents';
import { satisfiesRange, t3Advisory } from '../src/services/t3Compat';
import type { T3Policy } from '../src/native/types';

const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);

/** T3 Code's policies for Claude Code and Codex, as its model manifest has them. */
const POLICIES: T3Policy[] = [
  {
    agent: 'codex', t3CodeRange: '>=0.0.42', recommendedRange: '>=0.156.0', recommendedVersion: null,
    ranges: [{ range: '>=0.156.0', status: 'supported' }, { range: '>=0.149.0 <0.156.0', status: 'unsupported' }, { range: '<0.149.0', status: 'broken' }],
  },
  {
    agent: 'claude', t3CodeRange: '>=0.0.42', recommendedRange: '>=2.1.280', recommendedVersion: null,
    ranges: [{ range: '>=2.1.280', status: 'supported' }, { range: '>=2.1.111 <2.1.280', status: 'graceful' }, { range: '<2.1.111', status: 'unsupported' }],
  },
];

describe("T3 Code's version ranges", () => {
  it('holds a version when every comparator of any group does, as T3 Code checks it', () => {
    const range = '^22.16 || ^23.11 || >=24.10';
    expect(['22.16.0', '23.11.1', '24.10.0'].map((version) => satisfiesRange(version, range))).toEqual([true, true, true]);
    expect(['22.15.9', '23.10.9', '24.9.9'].map((version) => satisfiesRange(version, range))).toEqual([false, false, false]);
    expect(satisfiesRange('24.9.0', '>=24.0 <24.10')).toBe(true);
    expect(satisfiesRange('24.10.0', '>=24.0 <24.10')).toBe(false);
    expect(satisfiesRange('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfiesRange('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfiesRange('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false);
    expect(satisfiesRange('v0.0.42', '=0.0.42')).toBe(true);
    expect(satisfiesRange('0.0.43-nightly.20260920', '>=0.0.42')).toBe(true);
    expect(satisfiesRange('not-a-version', '>=24.0')).toBe(false);
    expect(satisfiesRange('24.10.0', '~24.10')).toBe(false);
    expect(satisfiesRange('24.10.0', '')).toBe(false);
  });
});

describe('what T3 Code makes of an agent', () => {
  it('warns about versions it lists as broken or unsupported, with what it recommends', () => {
    expect(t3Advisory(POLICIES, 'codex', '0.148.2', '0.0.42')).toEqual({ status: 'broken', recommendation: '>=0.156.0' });
    expect(t3Advisory(POLICIES, 'codex', '0.153.3', '0.0.42')).toEqual({ status: 'unsupported', recommendation: '>=0.156.0' });
    expect(t3Advisory(POLICIES, 'claude', '2.1.100', '0.0.42')).toEqual({ status: 'unsupported', recommendation: '>=2.1.280' });
  });

  it('says nothing about versions it supports, works with in part, or can’t place', () => {
    expect(t3Advisory(POLICIES, 'codex', '0.156.0', '0.0.42')).toBeNull();
    expect(t3Advisory(POLICIES, 'claude', '2.1.270', '0.0.42')).toBeNull();
    // Only stable versions are looked up, as in T3 Code.
    expect(t3Advisory(POLICIES, 'codex', '0.148.0-alpha.3', '0.0.42')).toBeNull();
    expect(t3Advisory(POLICIES, 'codex', null, '0.0.42')).toBeNull();
  });

  it('uses the policy for the T3 Code version there, or the only one when that’s unknown', () => {
    // A T3 Code older than every policy falls back to what it has built in, which Arbor can't know.
    expect(t3Advisory(POLICIES, 'codex', '0.148.2', '0.0.41')).toBeNull();
    expect(t3Advisory(POLICIES, 'codex', '0.148.2', null)).toEqual({ status: 'broken', recommendation: '>=0.156.0' });
    const earlier: T3Policy = { ...itemOf(POLICIES, 0), t3CodeRange: '>=0.0.42 <0.0.50' };
    const later: T3Policy = { agent: 'codex', t3CodeRange: '>=0.0.50', recommendedRange: null, recommendedVersion: null, ranges: [{ range: '<0.160.0', status: 'broken' }] };
    const both = [earlier, later, itemOf(POLICIES, 1)];
    expect(t3Advisory(both, 'codex', '0.157.0', '0.0.42')).toBeNull();
    expect(t3Advisory(both, 'codex', '0.157.0', '0.0.50')).toEqual({ status: 'broken', recommendation: null });
    expect(t3Advisory(both, 'codex', '0.148.2', null)).toBeNull();
  });

  it('shows nothing without a manifest, or with one T3 Code itself would turn down', () => {
    expect(t3Advisory(null, 'codex', '0.148.2', '0.0.42')).toBeNull();
    const unsupportedPick: T3Policy = { ...itemOf(POLICIES, 0), recommendedVersion: '0.150.0' };
    expect(t3Advisory([unsupportedPick, itemOf(POLICIES, 1)], 'codex', '0.148.2', '0.0.42')).toBeNull();
    expect(t3Advisory([{ ...itemOf(POLICIES, 0), recommendedVersion: '0.156.1' }], 'codex', '0.148.2', '0.0.42')).toEqual({ status: 'broken', recommendation: '0.156.1' });
  });

  it('says why, naming the T3 Code version when it’s known', () => {
    expect(t3AdvisoryText(t, { status: 'broken', recommendation: '>=0.156.0' }, { agent: 'codex', version: '0.148.2', t3Version: '0.0.42' }))
      .toBe('T3 Code 0.0.42 on this machine is known not to work with Codex 0.148.2. It recommends >=0.156.0.');
    expect(t3AdvisoryText(t, { status: 'unsupported', recommendation: null }, { agent: 'claude', version: '2.1.100', t3Version: null }))
      .toBe('Claude Code 2.1.100 is outside the range T3 Code on this machine supports.');
  });
});

function itemOf<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
}

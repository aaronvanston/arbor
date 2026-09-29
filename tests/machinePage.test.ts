import { describe, expect, it } from 'bun:test';
import { checklistOnPage, machineUsageTotal, setupStanding } from '../src/services/machinePage';
import type { MachineUsage, SetupHome, SetupItem, SetupMachine } from '../src/native/types';

const item = (kind: SetupItem['kind'], name: string, sum: string | null, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind, name, path: null, sum, size: null, link: null, value: null, note: null, count: null, enabled: null, text: false, skill: null, import: null, ...fields,
});
const home = (agent: SetupHome['agent'], path: string, items: SetupItem[]): SetupHome => ({
  agent, path, items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null,
});
const machine = (name: string, homes: SetupHome[], fields: Partial<SetupMachine> = {}): SetupMachine => ({
  machine: name, local: false, reachable: true, homes, installs: [], policy: null, scannedAt: 1_000, error: null, scanning: false, ...fields,
});

const claude = (items: SetupItem[]) => home('claude', '~/.claude', items);
const codex = (items: SetupItem[]) => home('codex', '~/.codex', items);
const mac = machine('mac', [
  claude([item('instructions', 'CLAUDE.md', 'c1'), item('mcp', 'linear', 'l1'), item('mcp', 'playwright', 'p1')]),
  codex([item('instructions', 'AGENTS.md', 'a1')]),
], { local: true });
// Its CLAUDE.md differs and it's without playwright; its Codex home matches.
const box = machine('box', [
  claude([item('instructions', 'CLAUDE.md', 'c2'), item('mcp', 'linear', 'l1')]),
  codex([item('instructions', 'AGENTS.md', 'a1')]),
]);
const twin = machine('twin', mac.homes);

describe('a machine’s setup standing', () => {
  it('counts what differs from the reference, by home, most first', () => {
    const standing = setupStanding([mac, box, twin], 'box', null);
    // This machine is the reference while none is chosen.
    expect(standing.reference).toBe('mac');
    expect(standing.differences).toBe(2);
    expect(standing.homes).toEqual([{ key: 'claude:~/.claude', count: 2 }]);
    expect(standing.problems).toBe(0);
    expect(setupStanding([mac, box, twin], 'twin', null).differences).toBe(0);
  });

  it('compares with the machine chosen, while it’s there', () => {
    expect(setupStanding([mac, box, twin], 'mac', 'box').reference).toBe('box');
    expect(setupStanding([mac, box, twin], 'mac', 'box').differences).toBe(2);
    expect(setupStanding([mac, box], 'box', 'gone').reference).toBe('mac');
  });

  it('counts the problems its last scan found, and only its own', () => {
    const broken = claude([item('import', '~/notes/gone.md', null, { import: { from: '~/.claude/CLAUDE.md', written: '@~/notes/gone.md', level: 1 } })]);
    const standing = setupStanding([mac, machine('box', [broken])], 'box', null);
    expect(standing.problems).toBeGreaterThan(0);
    expect(setupStanding([mac, machine('box', [broken])], 'mac', null).problems).toBe(0);
  });
});

describe('the checklist on a machine’s page', () => {
  const same = { reference: 'mac', differences: 0, homes: [], problems: 0 };
  const drifted = { ...same, differences: 3, homes: [{ key: 'claude:~/.claude', count: 3 }] };

  it('opens on the steps for a machine still being set up', () => {
    expect(checklistOnPage('unconfigured', null, same, true, 'lab')).toEqual({ show: true, folded: false });
    expect(checklistOnPage('healthy', null, same, true, 'lab')).toEqual({ show: true, folded: false });
    expect(checklistOnPage('healthy', machine('lab', [], { scannedAt: null }), same, true, 'lab')).toEqual({ show: true, folded: false });
  });

  it('is there but folded for a machine that has only drifted, or has problems', () => {
    expect(checklistOnPage('degraded', box, drifted, true, 'box')).toEqual({ show: true, folded: true });
    expect(checklistOnPage('healthy', box, { ...same, problems: 1 }, true, 'box')).toEqual({ show: true, folded: true });
  });

  it('isn’t there for a machine in line, for the reference, or before the scans have loaded', () => {
    expect(checklistOnPage('healthy', twin, same, true, 'twin').show).toBe(false);
    expect(checklistOnPage('unconfigured', null, { ...drifted, reference: 'mac' }, true, 'mac').show).toBe(false);
    expect(checklistOnPage('unconfigured', null, same, false, 'lab').show).toBe(false);
  });
});

describe('a machine’s usage', () => {
  const usage = (machine: string, pool: string, requests: number, lastRequest: string | null): MachineUsage => ({
    machine, pool, requests, tokens: requests * 1_000, success: requests - 1, failures: 1, canceled: 0, lastRequest,
  });

  it('adds up its key pools, and keeps its latest request', () => {
    const total = machineUsageTotal([
      usage('box', 'claude', 10, '2026-09-28T01:00:00Z'),
      usage('mac', 'claude', 99, '2026-09-28T09:00:00Z'),
      usage('box', 'codex', 5, '2026-09-28T03:00:00Z'),
      usage('box', 'gemini', 1, null),
    ], 'box');
    expect(total).toEqual({
      machine: 'box', pool: '', requests: 16, tokens: 16_000, success: 13, failures: 3, canceled: 0, lastRequest: '2026-09-28T03:00:00Z',
    });
  });

  it('is nothing for a machine that made no requests', () => {
    expect(machineUsageTotal([usage('mac', 'claude', 3, null)], 'box')).toBeNull();
  });
});

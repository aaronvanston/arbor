import { describe, expect, it } from 'bun:test';
import { fleetSkillGrid, fleetSkills, repoSkillState } from '../src/services/setupSkills';
import { parseSyncScope } from '../src/services/syncScope';
import type { SetupHome, SetupItem, SetupMachine } from '../src/native/types';

const skill = (home: string, name: string, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind: 'skill', name, path: `${home}/skills/${name}`, sum: name, size: null, link: null, value: null, note: null, count: null, enabled: null,
  text: false, skill: null, import: null, ...fields,
});
const home = (agent: SetupHome['agent'], path: string, items: SetupItem[]): SetupHome => ({
  agent, path, items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null,
});
const machine = (name: string, homes: SetupHome[], scannedAt: number | null = 1): SetupMachine => ({
  machine: name, local: false, reachable: true, homes, harnessHomes: [], harnessInstalls: [], installs: [], policy: null, scannedAt, error: null, scanning: false,
});

describe('Sync’s scope', () => {
  it('reads a saved scope, and anything else as All projects on All machines', () => {
    expect(parseSyncScope('{"project":"cam/arbor","machine":"ci-01"}')).toEqual({ project: 'cam/arbor', machine: 'ci-01' });
    expect(parseSyncScope('{"project":"","machine":3}')).toEqual({ project: null, machine: null });
    expect(parseSyncScope('not json')).toEqual({ project: null, machine: null });
    expect(parseSyncScope(null)).toEqual({ project: null, machine: null });
  });

  it('sums each skill up per machine at All machines, leaving out machines not read yet', () => {
    const machines = [
      machine('mac', [
        home('shared', '~/.agents', [skill('~/.agents', 'pdf')]),
        home('claude', '~/.claude', [skill('~/.claude', 'pdf', { link: '~/.agents/skills/pdf' })]),
        home('codex', '~/.codex', []),
      ]),
      machine('ci', [home('claude', '~/.claude', [skill('~/.claude', 'review')])]),
      machine('new', [], null),
    ];
    const fleet = fleetSkills(machines);
    expect(fleet.machines).toEqual(['mac', 'ci']);
    const sums = (cell: (typeof fleet.rows)[number]['cells'][string] | undefined) => (cell ? { loads: cell.loads, homes: cell.homes, look: cell.look } : null);
    expect(fleet.rows.map((row) => [row.name, sums(row.cells.mac), sums(row.cells.ci)])).toEqual([
      // Codex loads the store's, Claude Code links to it.
      ['pdf', { loads: 2, homes: 2, look: false }, null],
      ['review', null, { loads: 1, homes: 1, look: true }],
    ]);
    expect(Object.keys(fleet.views)).toEqual(['mac', 'ci']);
  });

  it('lists the skills that want a look at All machines, hiding the ones the same everywhere', () => {
    const same = (name: string) => home('claude', '~/.claude', [skill('~/.claude', 'pdf', { link: '~/.agents/skills/pdf' }), skill('~/.claude', name)]);
    const store = home('shared', '~/.agents', [skill('~/.agents', 'pdf')]);
    const fleet = fleetSkills([machine('mac', [store, same('notes')]), machine('ci', [store, same('draft')])]);
    // notes and draft are each one machine's own copy; pdf loads everywhere.
    const grid = fleetSkillGrid(fleet, true, '');
    expect([grid.rows.map((row) => row.name), grid.inLine]).toEqual([['draft', 'notes'], 1]);
    expect(fleetSkillGrid(fleet, false, '').rows.map((row) => row.name)).toEqual(['draft', 'notes', 'pdf']);
    expect(fleetSkillGrid(fleet, true, 'not').rows.map((row) => row.name)).toEqual(['notes']);
  });

  it('keeps a skill the repo removed in view while a machine still has it', () => {
    const linked = home('claude', '~/.claude', [skill('~/.claude', 'pdf', { link: '~/.agents/skills/pdf' })]);
    const store = home('shared', '~/.agents', [skill('~/.agents', 'pdf')]);
    const fleet = fleetSkills([machine('mac', [store, linked]), machine('ci', [store, linked])]);
    expect(fleetSkillGrid(fleet, true, '').rows).toEqual([]);
    expect(fleetSkillGrid(fleet, true, '', new Set(['pdf'])).rows.map((row) => row.name)).toEqual(['pdf']);
    const repo = { skills: [], removedSkills: ['pdf'] };
    expect([repoSkillState(repo, 'pdf'), repoSkillState(repo, 'notes')]).toEqual(['removed', 'absent']);
  });
});

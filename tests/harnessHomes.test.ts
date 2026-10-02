import { describe, expect, it } from 'bun:test';
import { harnessHomeRows, harnessSkillRows } from '../src/services/harnessHomes';
import type { Harness, HarnessHome, SetupItem, SetupMachine } from '../src/native/types';

const item = (kind: SetupItem['kind'], name: string, sum: string | null): SetupItem => ({
  kind, name, path: null, sum, size: null, link: null, value: null, note: null, count: null, enabled: null, text: false, skill: null, import: null,
});
const home = (harness: Harness, path: string, instructions: string | null, skills: string[] = []): HarnessHome => ({
  harness,
  path,
  items: [...(instructions === null ? [] : [item('instructions', 'AGENTS.md', instructions)]), ...skills.map((name) => item('skill', name, `${name}-sum`))],
});
const machine = (name: string, harnessHomes: HarnessHome[]): SetupMachine => ({
  machine: name, local: false, reachable: true, homes: [], harnessHomes, installs: [], policy: null, scannedAt: 1, error: null, scanning: false,
});

describe('the other harnesses homes', () => {
  const fleet = [
    machine('cedar-02', [home('droid', '~/.factory', 'd1'), home('pi', '~/.pi/agent', 'p1', ['deploy'])]),
    machine('casey-mbp', [home('pi', '~/.pi/agent', 'p2', ['deploy', 'pdf']), home('openCode', '~/.config/opencode', null)]),
    machine('ci-01', [home('pi', '~/.pi/agent', 'p2')]),
  ];

  it('lists each by harness then machine, and says how its instructions stand against the same harness elsewhere', () => {
    expect(harnessHomeRows(fleet).map((row) => [row.harness, row.machine, row.state, row.skills])).toEqual([
      ['pi', 'casey-mbp', 'differs', 2],
      ['pi', 'cedar-02', 'differs', 1],
      ['pi', 'ci-01', 'differs', 0],
      ['openCode', 'casey-mbp', 'missing', 0],
      ['droid', 'cedar-02', 'only', 0],
    ]);
    const same = [machine('a', [home('pi', '~/.pi/agent', 'p')]), machine('b', [home('pi', '~/.pi/agent', 'p')])];
    expect(harnessHomeRows(same).map((row) => row.state)).toEqual(['same', 'same']);
  });

  it('lists each skill once, with the harnesses each machine has it in', () => {
    const rows = harnessSkillRows([...fleet, machine('ci-02', [home('droid', '~/.factory', null, ['deploy']), home('pi', '~/.pi/agent', null, ['deploy'])])]);
    expect(rows).toEqual([
      { name: 'deploy', on: { 'cedar-02': ['pi'], 'casey-mbp': ['pi'], 'ci-02': ['pi', 'droid'] } },
      { name: 'pdf', on: { 'casey-mbp': ['pi'] } },
    ]);
  });
});

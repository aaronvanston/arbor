import { describe, expect, it } from 'bun:test';
import { harnessHomeRows, harnessItemRows, harnessSkillChange, harnessSkillRows } from '../src/services/harnessHomes';
import type { Harness, HarnessHome, HarnessInstall, SetupHome, SetupItem, SetupMachine } from '../src/native/types';

const item = (kind: SetupItem['kind'], name: string, sum: string | null): SetupItem => ({
  kind, name, path: null, sum, size: null, link: null, value: null, note: null, count: null, enabled: null, text: false, skill: null, import: null,
});
const home = (harness: Harness, path: string, instructions: string | null, skills: string[] = []): HarnessHome => ({
  harness,
  path,
  items: [...(instructions === null ? [] : [item('instructions', 'AGENTS.md', instructions)]), ...skills.map((name) => item('skill', name, `${name}-sum`))],
  skillsLink: null,
});
const machine = (name: string, harnessHomes: HarnessHome[], harnessInstalls: HarnessInstall[] = []): SetupMachine => ({
  machine: name, local: false, reachable: true, homes: [], harnessHomes, harnessInstalls, installs: [], policy: null, scannedAt: 1, error: null, scanning: false,
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

  it('gives each home the version of its harness that runs on its machine, the first on the path', () => {
    const installs: HarnessInstall[] = [
      { harness: 'droid', path: '~/.local/bin/droid', real: null, version: '0.22.1' },
      { harness: 'pi', path: '~/.npm-global/bin/pi', real: null, version: '0.70.2' },
      { harness: 'pi', path: '/opt/homebrew/bin/pi', real: null, version: '0.60.0' },
    ];
    const rows = harnessHomeRows([machine('a', [home('pi', '~/.pi/agent', 'p'), home('openCode', '~/.config/opencode', null)], installs)]);
    expect(rows.map((row) => [row.harness, row.version])).toEqual([['pi', '0.70.2'], ['openCode', null]]);
  });

  it('lists servers and hooks by name, each against the same harness’s of that name elsewhere', () => {
    const withItems = (harness: Harness, path: string, items: SetupItem[]): HarnessHome => ({ harness, path, items, skillsLink: null });
    const fleet = [
      machine('a', [withItems('pi', '~/.pi/agent', [item('mcp', 'github', 'g1'), item('mcp', 'linear', 'l1')]), withItems('droid', '~/.factory', [item('mcp', 'linear', 'l9'), item('hook', 'Stop', 'h1')])]),
      machine('b', [withItems('pi', '~/.pi/agent', [item('mcp', 'github', 'g1'), item('mcp', 'linear', 'l2')])]),
    ];
    const states = (kind: 'mcp' | 'hook') => harnessItemRows(fleet, kind).map((row) => [
      row.name,
      Object.fromEntries(Object.entries(row.on).map(([name, places]) => [name, places.map((place) => `${place.harness}:${place.state}`)])),
    ]);
    expect(states('mcp')).toEqual([
      ['github', { a: ['pi:same'], b: ['pi:same'] }],
      ['linear', { a: ['pi:differs', 'droid:only'], b: ['pi:differs'] }],
    ]);
    expect(states('hook')).toEqual([['Stop', { a: ['droid:only'] }]]);
  });

  it('lists each skill once, with the harnesses each machine has it in', () => {
    const rows = harnessSkillRows([...fleet, machine('ci-02', [home('droid', '~/.factory', null, ['deploy']), home('pi', '~/.pi/agent', null, ['deploy'])])]);
    const where = rows.map((row) => [row.name, Object.fromEntries(Object.entries(row.on).map(([name, places]) => [name, places.map((place) => place.harness)]))]);
    expect(where).toEqual([
      ['deploy', { 'cedar-02': ['pi'], 'casey-mbp': ['pi'], 'ci-02': ['pi', 'droid'] }],
      ['pdf', { 'casey-mbp': ['pi'] }],
    ]);
  });

  it('offers what the store lets each copy do, and makes the change against what the scan found', () => {
    const store = (skills: SetupItem[]): SetupHome => ({
      agent: 'shared', path: '~/.agents', items: skills, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null,
    });
    const own = { ...machine('a', [home('pi', '~/.pi/agent', null, ['solo', 'same', 'drift', 'linked'])]) };
    const pi = own.harnessHomes[0]!;
    pi.items = pi.items.map((found) => (found.name === 'linked' ? { ...found, link: '~/src/linked' } : found));
    own.homes = [store([item('skill', 'same', 'same-sum'), item('skill', 'drift', 'other-sum')])];
    const places = Object.fromEntries(harnessSkillRows([own]).map((row) => [row.name, row.on.a?.[0]]));
    expect(Object.fromEntries(Object.entries(places).map(([name, place]) => [name, [place?.standing, place?.actions]]))).toEqual({
      drift: ['differs', ['adopt', 'remove']],
      linked: ['link', ['remove']],
      same: ['sameAsStore', ['remove']],
      solo: ['own', ['adopt', 'remove']],
    });
    expect(harnessSkillChange('solo', places.solo!, 'adopt')).toEqual({ home: '~/.pi/agent', name: 'solo', action: 'adopt', homeBefore: 'Dsolo-sum', storeBefore: '-' });
    expect(harnessSkillChange('same', places.same!, 'adopt')).toBeNull();
    const linkedFolder = machine('b', [{ ...home('pi', '~/.pi/agent', null, ['solo']), skillsLink: '~/.agents/skills' }]);
    expect(harnessSkillRows([linkedFolder])[0]?.on.b?.[0]?.actions).toEqual([]);
  });
});

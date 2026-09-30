import { describe, expect, it } from 'bun:test';
import {
  buildMatrix,
  compareSkillFiles,
  differingRows,
  homeKeys,
  homeLook,
  machineDifferences,
  resolveReference,
  overrideWords,
  policySets,
  sharedItems,
  sharedSetupEntries,
  sharingMachines,
} from '../src/services/setupInventory';
import type {
  ClaudePolicy,
  SetupHome,
  SetupItem,
  SetupMachine,
  SetupSkillFile,
  SkillOverride,
} from '../src/native/types';

const item = (kind: SetupItem['kind'], name: string, sum: string | null, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind, name, path: null, sum, size: null, link: null, value: null, note: null, count: null, enabled: null, text: false, skill: null, import: null, ...fields,
});
const home = (agent: SetupHome['agent'], path: string, items: SetupItem[]): SetupHome => ({ agent, path, items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null });
const machine = (name: string, homes: SetupHome[], fields: Partial<SetupMachine> = {}): SetupMachine => ({
  machine: name, local: false, reachable: true, homes, installs: [], policy: null, scannedAt: 1_000, error: null, scanning: false, ...fields,
});

describe('setup homes', () => {
  it('reads each home as an agent’s own, the shared skills, or another on the list', () => {
    expect(homeLook('claude:~/.claude')).toMatchObject({ id: 'claude' });
    expect(homeLook('codex:~/.codex')).toMatchObject({ id: 'codex' });
    expect(homeLook('shared:~/.agents')).toMatchObject({ id: 'shared' });
    expect(homeLook('claude:~/.agent-app/homes/claude-proxy')).toMatchObject({ id: 'other', agent: 'claude' });
    expect(homeLook('claude:/opt/claude')).toMatchObject({ id: 'other', path: '/opt/claude' });
  });

  it('lists the agents’ own homes first, then the shared skills, then the rest', () => {
    const fleet = [
      machine('a', [home('claude', '~/.agent-app/homes/claude-proxy', []), home('shared', '~/.agents', []), home('codex', '~/.codex', [])]),
      machine('b', [home('claude', '~/.claude', []), home('codex', '~/.agent-app/homes/codex-proxy', [])]),
    ];
    expect(homeKeys(fleet)).toEqual([
      'claude:~/.claude',
      'codex:~/.codex',
      'shared:~/.agents',
      'claude:~/.agent-app/homes/claude-proxy',
      'codex:~/.agent-app/homes/codex-proxy',
    ]);
  });

  it('compares with the machine chosen while it’s there, else this one', () => {
    const fleet = [machine('ci-01', []), machine('mac', [], { local: true })];
    expect(resolveReference(fleet, 'ci-01')).toBe('ci-01');
    expect(resolveReference(fleet, 'gone')).toBe('mac');
    expect(resolveReference([machine('ci-01', [])], null)).toBe('ci-01');
    expect(resolveReference([], null)).toBeNull();
  });
});

describe('setup matrix', () => {
  const reference = machine('mac', [home('claude', '~/.claude', [
    item('instructions', 'CLAUDE.md', 'aaa'),
    item('skill', 'pdf', 'p1'),
    item('skill', 'web', 'w1'),
    item('import', '~/notes/missing.md', null),
  ])], { local: true });
  const fleet = [
    reference,
    machine('ci-01', [home('claude', '~/.claude', [
      item('instructions', 'CLAUDE.md', 'bbb'),
      item('skill', 'pdf', 'p1'),
      item('skill', 'only-here', 'o1'),
      item('import', '~/notes/missing.md', null),
    ])]),
    machine('cedar', [home('codex', '~/.codex', [])]),
    machine('new', [], { scannedAt: null }),
  ];

  it('says how each machine’s copy compares with the reference’s', () => {
    const groups = buildMatrix(fleet, 'claude:~/.claude', 'mac');
    expect(groups.map((group) => group.kind)).toEqual(['instructions', 'import', 'skill']);
    const states = (name: string) => groups.flatMap((group) => group.rows).find((row) => row.name === name)!.cells.map((cell) => cell.state);
    expect(states('CLAUDE.md')).toEqual(['reference', 'different', 'noHome', 'unknown']);
    expect(states('pdf')).toEqual(['reference', 'same', 'noHome', 'unknown']);
    expect(states('web')).toEqual(['reference', 'missing', 'noHome', 'unknown']);
    expect(states('only-here')).toEqual(['absent', 'extra', 'noHome', 'unknown']);
    expect(states('~/notes/missing.md')).toEqual(['reference', 'same', 'noHome', 'unknown']);
    expect(groups.find((group) => group.kind === 'skill')!.rows.map((row) => row.name)).toEqual(['only-here', 'pdf', 'web']);
    expect(differingRows(groups)).toBe(3);
    expect(machineDifferences(groups, 'ci-01')).toBe(3);
    expect(machineDifferences(groups, 'mac')).toBe(0);
  });

  it('only lists what’s there when the reference hasn’t the home', () => {
    const groups = buildMatrix(fleet, 'claude:~/.claude', 'cedar');
    expect(groups.flatMap((group) => group.rows).find((row) => row.name === 'pdf')!.cells.map((cell) => cell.state)).toEqual(['present', 'present', 'noHome', 'unknown']);
    expect(differingRows(groups)).toBe(0);
  });

  it('counts a skill a machine’s settings turn off as neither missing nor different', () => {
    const override = (name: string, state: SkillOverride['state']): SkillOverride => ({ name, state, source: 'settings', file: '~/.claude/settings.json' });
    const withOverrides = (entry: SetupMachine, overrides: SkillOverride[]): SetupMachine => ({
      ...entry,
      homes: entry.homes.map((found) => ({ ...found, skillOverrides: overrides })),
    });
    // ci-01 turns web off, which it hasn't got, and pdf, whose copy it has; the Mac lists its web by name only.
    const turned = [withOverrides(reference, [override('web', 'nameOnly')]), withOverrides(fleet[1]!, [override('web', 'off'), override('pdf', 'off')])];
    const groups = buildMatrix(turned, 'claude:~/.claude', 'mac');
    const row = (name: string) => groups.flatMap((group) => group.rows).find((entry) => entry.name === name)!;
    expect(row('web').cells.map((cell) => cell.state)).toEqual(['reference', 'turnedOff']);
    expect(row('pdf').cells.map((cell) => cell.state)).toEqual(['reference', 'turnedOff']);
    expect(row('web').cells.map((cell) => cell.override?.state ?? null)).toEqual(['nameOnly', 'off']);
    expect(row('CLAUDE.md').cells.every((cell) => cell.override === null)).toBe(true);
    expect(machineDifferences(groups, 'ci-01')).toBe(2);

    // Where the reference turns a skill off, the others have nothing to be held to.
    const theirs = buildMatrix(turned, 'claude:~/.claude', 'ci-01');
    const their = (name: string) => theirs.flatMap((group) => group.rows).find((entry) => entry.name === name)!.cells.map((cell) => cell.state);
    expect(their('pdf')).toEqual(['present', 'turnedOff']);
    expect(their('web')).toEqual(['present', 'turnedOff']);
    expect(their('only-here')).toEqual(['missing', 'reference']);
  });
});

describe('a managed settings policy', () => {
  const policy = (file: string, keys: ClaudePolicy['keys']): ClaudePolicy => ({ file, keys, problem: null, ignoredOverrides: false });
  const mac = machine('mac', [
    home('claude', '~/.claude', [item('setting', 'model', 's-opus', { value: 'opus' }), item('setting', 'effortLevel', 'e1'), item('skill', 'pdf', 'p1')]),
    home('codex', '~/.codex', [item('setting', 'model', 'g1')]),
  ], { local: true });
  const ci = machine('ci-01', [home('claude', '~/.claude', [item('setting', 'model', 's-sonnet', { value: 'sonnet' }), item('setting', 'effortLevel', 'e2')])], {
    policy: policy('/etc/claude-code/managed-settings.json', [{ kind: 'setting', name: 'model' }, { kind: 'env', name: 'CLAUDE_CODE_ENABLE_TELEMETRY' }]),
  });
  const states = (groups: ReturnType<typeof buildMatrix>, name: string) =>
    groups.flatMap((group) => group.rows).find((row) => row.name === name)?.cells.map((cell) => cell.state) ?? null;

  it('shows what it sets as set by policy on its machine, not as a difference', () => {
    const groups = buildMatrix([mac, ci], 'claude:~/.claude', 'mac');
    expect(states(groups, 'model')).toEqual(['reference', 'enforced']);
    expect(states(groups, 'effortLevel')).toEqual(['reference', 'different']);
    // What only the policy sets still gets a row, for the machine it's set on.
    expect(states(groups, 'CLAUDE_CODE_ENABLE_TELEMETRY')).toEqual(['absent', 'enforced']);
    expect(groups.flatMap((group) => group.rows).find((row) => row.name === 'model')!.cells[1]!.policy).toBe('/etc/claude-code/managed-settings.json');
    expect(machineDifferences(groups, 'ci-01')).toBe(2);
    // Codex doesn't read Claude Code's policy.
    expect(states(buildMatrix([mac, { ...ci, homes: [...ci.homes, home('codex', '~/.codex', [])] }], 'codex:~/.codex', 'mac'), 'model')).toEqual(['reference', 'missing']);
  });

  it('holds nobody to what the reference’s policy sets', () => {
    const groups = buildMatrix([mac, ci], 'claude:~/.claude', 'ci-01');
    expect(states(groups, 'model')).toEqual(['present', 'enforced']);
    expect(states(groups, 'CLAUDE_CODE_ENABLE_TELEMETRY')).toEqual(['absent', 'enforced']);
    expect(machineDifferences(groups, 'mac')).toBe(2);
    expect(policySets(ci, 'setting', 'model')).toBe(true);
    expect(policySets(ci, 'env', 'model')).toBe(false);
    expect(policySets(mac, 'setting', 'model')).toBe(false);
  });

  it('says where a skill’s override comes from', () => {
    const words = (source: SkillOverride['source']) => overrideWords({ name: 'pdf', state: 'off', source, file: '/etc/claude-code/managed-settings.json' }).map(([key]) => key);
    expect(words('policy')).toEqual(['setup.override.hint.off', 'setup.override.policy']);
    expect(words('settings')).toEqual(['setup.override.hint.off', 'setup.override.settings']);
  });
});

describe('a T3 Code shadow home', () => {
  const codex = home('codex', '~/.codex', [
    { ...item('instructions', 'AGENTS.md', 'a1'), path: '~/.codex/AGENTS.md' },
    { ...item('skill', 'pdf', 'p1'), path: '~/.codex/skills/pdf' },
    { ...item('rule', 'default.rules', 'r1'), path: '~/.codex/rules/default.rules' },
    item('setting', 'model', 'm1'),
  ]);
  const shadow = { ...home('codex', '~/.agent-app/homes/codex-proxy', []), shares: { home: '~/.codex', entries: ['sessions', 'skills', 'fast.config.toml', 'config.toml', 'AGENTS.md', 'sqlite'] } };
  const mac = machine('mac', [codex, shadow]);

  it('loads what’s in the entries it links, from the home it shares', () => {
    expect(sharedItems(mac, shadow).map((entry) => entry.name)).toEqual(['AGENTS.md', 'pdf']);
    expect(sharedItems(mac, codex)).toEqual([]);
  });

  it('names only the shared entries Setup reads, in the order it reads them', () => {
    expect(sharedSetupEntries(shadow.shares)).toEqual(['AGENTS.md', 'config.toml', 'skills', 'fast.config.toml']);
    expect(sharingMachines([mac, machine('ci-01', [codex])], 'codex:~/.agent-app/homes/codex-proxy')).toEqual([{ machine: 'mac', shares: shadow.shares }]);
  });
});

describe('setup diffs', () => {
  it('lists a skill’s changed, added and removed files before the ones that match', () => {
    const file = (path: string, sum: string): SetupSkillFile => ({ path, sum, size: 1, content: 'x', hidden: null });
    const changes = compareSkillFiles(
      [file('SKILL.md', 'a'), file('old.py', 'o'), file('same.md', 's')],
      [file('SKILL.md', 'b'), file('new.py', 'n'), file('same.md', 's')],
    );
    expect(changes.map((change) => [change.path, change.state])).toEqual([
      ['SKILL.md', 'changed'],
      ['new.py', 'added'],
      ['old.py', 'removed'],
      ['same.md', 'same'],
    ]);
  });
});

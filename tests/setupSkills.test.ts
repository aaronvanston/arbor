import { describe, expect, it } from 'bun:test';
import {
  addChanges,
  cellOptions,
  changeKey,
  choose,
  homeCounts,
  ignoredSkillOverrides,
  isTurnedOff,
  needsLook,
  placeState,
  plannedSkills,
  settleSkills,
  skillChanges,
  skillOffBy,
  skillSuggestions,
  skillsView,
  usageFor,
  type SkillRow,
  type SkillsView,
} from '../src/services/setupSkills';
import type { SetupHome, SetupItem, SetupMachine, SkillFacts, SkillOverride, SkillUsage } from '../src/native/types';

const sha = (seed: string) => seed.repeat(64).slice(0, 64);
const facts = (fields: Partial<SkillFacts> = {}): SkillFacts => ({
  files: 2, hasDoc: true, declaredName: null, descriptionChars: 120, whenToUseChars: 0, manualOnly: false, source: null, ...fields,
});
const skill = (home: string, name: string, sum: string | null, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind: 'skill', name, path: `${home}/skills/${name}`, sum, size: null, link: null, value: null, note: null, count: null, enabled: null,
  text: false, skill: facts({ declaredName: name }), import: null, ...fields,
});
const home = (agent: SetupHome['agent'], path: string, items: SetupItem[], skillsLink: string | null = null, fields: Partial<SetupHome> = {}): SetupHome => ({
  agent, path, items, problems: [], skillsLink, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null, ...fields,
});

const CLAUDE = '~/.claude';
const PROXY = '~/.agent-app/homes/claude-other';
const LINKED = '~/.agent-app/homes/claude-linked';
const CODEX = '~/.codex';
const STORE = '~/.agents';

const machine: SetupMachine = {
  machine: 'cam-mbp', local: true, reachable: true, harnessHomes: [], harnessInstalls: [], installs: [], policy: null, scannedAt: 1_000, error: null, scanning: false,
  homes: [
    home('codex', CODEX, [
      skill(CODEX, 'pdf', sha('1')),
      skill(CODEX, 'notes', sha('3'), { link: '~/.agents/skills/notes' }),
      skill(CODEX, 'legacy', sha('6')),
    ]),
    home('claude', PROXY, [skill(PROXY, 'mine', sha('4')), skill(PROXY, 'design', sha('2'))]),
    home('claude', CLAUDE, [
      skill(CLAUDE, 'pdf', sha('1'), { link: '~/.agents/skills/pdf' }),
      skill(CLAUDE, 'design', sha('9')),
      skill(CLAUDE, 'mine', sha('4')),
      skill(CLAUDE, 'scratch', null, { skill: facts({ hasDoc: false, files: 0 }) }),
      skill(CLAUDE, 'browser', sha('5'), { link: '~/Developer/browser', skill: facts({ declaredName: 'browser-check' }) }),
      skill(CLAUDE, 'old', null, { link: '~/src/old', skill: null }),
      // A plugin, which isn't a skill.
      { ...skill(CLAUDE, 'superpowers', 'p1'), kind: 'plugin' },
    ]),
    // A home whose whole skills folder leads to the store.
    home('claude', LINKED, [skill(LINKED, 'pdf', sha('1')), skill(LINKED, 'design', sha('2'))], '~/.agents/skills'),
    home('shared', STORE, [
      skill(STORE, 'pdf', sha('1'), { skill: facts({ declaredName: 'pdf', source: 'anthropics/skills', manualOnly: true }) }),
      skill(STORE, 'design', sha('2')),
      // A link the store keeps to a skill somewhere else, and one to nothing.
      skill(STORE, 'notes', sha('3'), { link: '~/src/notes' }),
      skill(STORE, 'gone', null, { link: '~/src/gone', skill: null }),
    ]),
  ],
};
const view = skillsView(machine);
const row = (name: string) => view.rows.find((entry) => entry.name === name)!;
const cell = (name: string, path: string) => row(name).cells.find((entry) => entry.home.path === path)!;
const places = (name: string) => [row(name).storePlace, ...row(name).cells.map((entry) => entry.place)];
const options = (name: string, path: string, pending = {}) => cellOptions(row(name), cell(name, path), pending);
const pick = (pending: Record<string, string>, name: string, path: string, action: Parameters<typeof choose>[4]) =>
  choose(view, pending as never, row(name), cell(name, path), action);

describe('where each skill stands', () => {
  it('lists every skill in the store and in each Claude Code and Codex home, Claude Code’s first', () => {
    expect(view.homes.map((entry) => [entry.path, entry.agent, entry.folderLink])).toEqual([
      [CLAUDE, 'claude', null], [LINKED, 'claude', '~/.agents/skills'], [PROXY, 'claude', null], [CODEX, 'codex', null],
    ]);
    expect(view.rows.map((entry) => entry.name)).toEqual(['browser', 'design', 'gone', 'legacy', 'mine', 'notes', 'old', 'pdf', 'scratch']);
    expect(view.store?.path).toBe(STORE);
  });

  it('leaves out a shadow Codex home whose skills are another home’s', () => {
    const shadow = home('codex', '~/.agent-app/homes/codex-other', [], '~/.codex/skills', { shares: { home: CODEX, entries: ['config.toml', 'skills'] } });
    const shared = skillsView({ ...machine, homes: [...machine.homes, shadow] });
    expect(shared.homes.map((entry) => entry.path)).toEqual(view.homes.map((entry) => entry.path));
    expect(shared.sharing).toEqual([{ path: '~/.agent-app/homes/codex-other', home: CODEX }]);
    expect(view.sharing).toEqual([]);
  });

  it('reads links to the store as on, the store’s skills a home hasn’t got as off, and copies against the store’s', () => {
    // Store, ~/.claude, claude-linked, claude-other, Codex.
    expect(places('pdf')).toEqual(['store', 'linked', 'viaFolder', 'off', 'copy']);
    expect(places('design')).toEqual(['store', 'drifted', 'viaFolder', 'copy', 'loads']);
    expect(places('notes')).toEqual(['elsewhere', 'off', 'none', 'off', 'linked']);
    expect(places('mine')).toEqual(['none', 'own', 'none', 'own', 'none']);
    expect(places('legacy')).toEqual(['none', 'none', 'none', 'none', 'own']);
  });

  it('tells links elsewhere, links to nothing and folders that aren’t skills apart', () => {
    expect(places('browser')).toEqual(['none', 'elsewhere', 'none', 'none', 'none']);
    expect(places('old')).toEqual(['none', 'broken', 'none', 'none', 'none']);
    expect(places('scratch')).toEqual(['none', 'notSkill', 'none', 'none', 'none']);
    expect(places('gone')).toEqual(['broken', 'none', 'none', 'none', 'none']);
  });

  it('keeps what the store says about a skill', () => {
    expect([row('pdf').source, row('pdf').manualOnly, row('pdf').declaredName]).toEqual(['anthropics/skills', true, null]);
    expect(row('browser').declaredName).toBe('browser-check');
  });

  it('gives each place as a change must still find it', () => {
    expect(placeState(cell('pdf', CLAUDE).item)).toBe('L~/.agents/skills/pdf');
    expect(placeState(cell('design', CLAUDE).item)).toBe(`D${sha('9')}`);
    expect(placeState(cell('pdf', PROXY).item)).toBe('-');
    expect(placeState(cell('scratch', CLAUDE).item)).toBeNull();
    expect(placeState(row('gone').store)).toBe('L~/src/gone');
  });

  it('counts what each home loads from the store, and what it has of its own', () => {
    const counts = (path: string) => homeCounts(view, view.homes.find((entry) => entry.path === path)!);
    expect(counts(CLAUDE)).toEqual({ fromStore: 1, own: 3, turnedOff: 0 });
    expect(counts(LINKED)).toEqual({ fromStore: 2, own: 0, turnedOff: 0 });
    expect(counts(PROXY)).toEqual({ fromStore: 0, own: 2, turnedOff: 0 });
    expect(counts(CODEX)).toEqual({ fromStore: 2, own: 2, turnedOff: 0 });
  });

  it('flags the skills that need a look', () => {
    expect(view.rows.filter(needsLook).map((entry) => entry.name)).toEqual(['design', 'gone', 'legacy', 'mine', 'notes', 'old', 'pdf']);
  });
});

describe('what can change', () => {
  it('turns a store skill on or off in a Claude Code home', () => {
    expect(options('pdf', PROXY)).toEqual(['link']);
    expect(options('pdf', CLAUDE)).toEqual(['remove']);
    expect(options('notes', CLAUDE)).toEqual(['link']);
  });

  it('gives copies way to the store’s, or makes one the store’s', () => {
    expect(options('design', PROXY)).toEqual(['useStore', 'remove']);
    expect(options('design', CLAUDE)).toEqual(['useStore', 'adopt', 'remove']);
    expect(options('mine', CLAUDE)).toEqual(['adopt', 'remove']);
    expect(options('legacy', CODEX)).toEqual(['adopt', 'remove']);
  });

  it('leaves Codex to load the store itself, and takes out its second copies', () => {
    expect(options('design', CODEX)).toEqual([]);
    expect(options('pdf', CODEX)).toEqual(['remove']);
    expect(options('notes', CODEX)).toEqual(['remove']);
  });

  it('never puts a store link aside, links to one that leads nowhere, or changes a home whose folder is a link', () => {
    expect(options('gone', CLAUDE)).toEqual([]);
    expect(options('pdf', LINKED)).toEqual([]);
    expect(options('scratch', CLAUDE)).toEqual([]);
    expect(options('browser', CLAUDE)).toEqual(['remove']);
    expect(options('old', CLAUDE)).toEqual(['remove']);
    const linkedStore: SkillRow = { ...row('design'), store: { ...row('design').store!, link: '~/src/design' }, storePlace: 'elsewhere' };
    expect(cellOptions(linkedStore, linkedStore.cells[0]!)).toEqual(['useStore', 'remove']);
  });

  it('lets other homes link to a skill moving into the store with the same change', () => {
    const adopting = { [changeKey(CLAUDE, 'mine')]: 'adopt' as const };
    expect(options('mine', PROXY, adopting)).toEqual(['useStore', 'adopt', 'remove']);
    expect(options('mine', LINKED, adopting)).toEqual([]);
    expect(options('mine', CODEX, adopting)).toEqual([]);
    expect(options('mine', CLAUDE, adopting)).toEqual(['adopt', 'remove']);
  });
});

describe('choosing changes', () => {
  it('moves one home’s copy into the store at a time', () => {
    let pending = pick({}, 'mine', CLAUDE, 'adopt');
    pending = pick(pending, 'mine', PROXY, 'useStore');
    expect(pending).toEqual({ [changeKey(CLAUDE, 'mine')]: 'adopt', [changeKey(PROXY, 'mine')]: 'useStore' });
    // Choosing the other home's copy drops the first, and the link that led to it.
    expect(pick(pending, 'mine', PROXY, 'adopt')).toEqual({ [changeKey(PROXY, 'mine')]: 'adopt' });
  });

  it('drops a link that needed a skill moving in once that move is cleared', () => {
    const pending = pick(pick({}, 'mine', CLAUDE, 'adopt'), 'mine', PROXY, 'useStore');
    expect(pick(pending, 'mine', CLAUDE, null)).toEqual({});
  });

  it('keeps only what still holds after the machine is read again', () => {
    const pending = { [changeKey(PROXY, 'pdf')]: 'link' as const, [changeKey(PROXY, 'gone-now')]: 'remove' as const, [changeKey(CLAUDE, 'pdf')]: 'link' as const };
    expect(settleSkills(view, pending)).toEqual({ [changeKey(PROXY, 'pdf')]: 'link' });
  });

  it('sends each change with what the scan found, what goes into the store first', () => {
    let pending = pick({}, 'pdf', PROXY, 'link');
    pending = pick(pending, 'design', CLAUDE, 'useStore');
    pending = pick(pending, 'mine', PROXY, 'useStore');
    pending = pick(pending, 'mine', CLAUDE, 'adopt');
    pending = pick(pending, 'mine', PROXY, 'useStore');
    expect(skillChanges(view, pending)).toEqual([
      { home: CLAUDE, name: 'design', action: 'useStore', homeBefore: `D${sha('9')}`, storeBefore: `D${sha('2')}` },
      { home: CLAUDE, name: 'mine', action: 'adopt', homeBefore: `D${sha('4')}`, storeBefore: '-' },
      { home: PROXY, name: 'mine', action: 'useStore', homeBefore: `D${sha('4')}`, storeBefore: '-' },
      { home: PROXY, name: 'pdf', action: 'link', homeBefore: '-', storeBefore: `D${sha('1')}` },
    ]);
    expect(plannedSkills(view, pending).map((change) => change.row.name)).toEqual(['design', 'mine', 'mine', 'pdf']);
  });

  it('won’t send a change the machine can’t make as it was found', () => {
    expect(skillChanges(view, { [changeKey(PROXY, 'mine')]: 'useStore' })).toBeNull();
    expect(skillChanges(view, { [changeKey(CODEX, 'design')]: 'remove' })).toBeNull();
  });
});

describe('suggestions', () => {
  const suggestions = skillSuggestions(view);
  const found = (kind: string) => suggestions.find((entry) => entry.kind === kind)?.changes.map((change) => [change.row.name, change.cell.home.path, change.action]);

  it('links copies that match the store’s, and takes Codex’s second copies out', () => {
    expect(found('linkCopies')).toEqual([['design', PROXY, 'useStore']]);
    expect(found('codexTwice')).toEqual([['notes', CODEX, 'remove'], ['pdf', CODEX, 'remove']]);
  });

  it('moves skills only homes have into the store, with the copies that match giving way to it', () => {
    expect(found('intoStore')).toEqual([['legacy', CODEX, 'adopt'], ['mine', CLAUDE, 'adopt'], ['mine', PROXY, 'useStore']]);
  });

  it('turns on in a second Claude home what ~/.claude has on, but not in one whose folder is a link', () => {
    expect(suggestions.filter((entry) => entry.kind === 'match').map((entry) => entry.home)).toEqual([PROXY]);
    expect(found('match')).toEqual([['pdf', PROXY, 'link']]);
  });

  it('adds a suggestion’s changes, leaving ones already chosen, and stops suggesting them', () => {
    const chosen = { [changeKey(PROXY, 'mine')]: 'remove' as const };
    const into = skillSuggestions(view, chosen).find((entry) => entry.kind === 'intoStore')!;
    expect(into.changes.map((change) => change.row.name)).toEqual(['legacy']);
    const pending = addChanges(view, {}, skillSuggestions(view).find((entry) => entry.kind === 'intoStore')!.changes);
    expect(pending).toEqual({
      [changeKey(CODEX, 'legacy')]: 'adopt', [changeKey(CLAUDE, 'mine')]: 'adopt', [changeKey(PROXY, 'mine')]: 'useStore',
    });
    expect(skillSuggestions(view, pending).some((entry) => entry.kind === 'intoStore')).toBe(false);
  });

  it('leaves copies that differ, with nothing in the store, to be looked at', () => {
    const differ: SkillsView = skillsView({
      ...machine,
      homes: machine.homes.map((entry) => (entry.path === PROXY ? { ...entry, items: [skill(PROXY, 'mine', sha('8'))] } : entry)),
    });
    expect(skillSuggestions(differ).find((entry) => entry.kind === 'intoStore')?.changes.map((change) => change.row.name)).toEqual(['legacy']);
  });
});

describe('why a skill loads nowhere on a machine', () => {
  const pdf = row('pdf');
  const turnedOff = (source: SkillOverride['source']) => ({ ...pdf, cells: pdf.cells.map((entry) => ({ ...entry, place: 'off' as const, override: { name: 'pdf', state: 'off' as const, source, file: '~/.claude/settings.json' } })) });

  it('says a policy or a home’s settings turn it off, and nothing when it loads somewhere', () => {
    expect(skillOffBy(turnedOff('policy'))).toBe('policy');
    expect(skillOffBy(turnedOff('settings'))).toBe('settings');
    expect(skillOffBy(pdf)).toBeNull();
  });

  it('lists each file whose skill overrides Claude Code ignores, a policy’s too', () => {
    const policy = { file: '/etc/claude-code/managed-settings.json', keys: [], problem: null, ignoredOverrides: true };
    const ignoring: SetupMachine = { ...machine, machine: 'cedar-02', policy, homes: [home('claude', PROXY, [], null, { ignoredOverrides: [`${PROXY}/settings.json`] })] };
    expect(ignoredSkillOverrides([machine, ignoring])).toEqual([
      { machine: 'cedar-02', file: '/etc/claude-code/managed-settings.json' },
      { machine: 'cedar-02', file: `${PROXY}/settings.json` },
    ]);
  });
});

describe('skills Claude Code’s settings override', () => {
  const override = (name: string, state: SkillOverride['state'], file = `${PROXY}/settings.json`): SkillOverride => ({ name, state, source: 'settings', file });
  // The second home turns pdf off (the store has it, and ~/.claude has it on) and design, its copy, off; ~/.claude
  // lists mine by name only.
  const overridden = skillsView({
    ...machine,
    homes: machine.homes.map((entry) => {
      if (entry.path === PROXY) return { ...entry, skillOverrides: [override('pdf', 'off'), override('design', 'off')] };
      if (entry.path === CLAUDE) return { ...entry, skillOverrides: [override('mine', 'nameOnly', `${CLAUDE}/settings.json`)] };
      return entry;
    }),
  });
  const at = (name: string, path: string) => overridden.rows.find((entry) => entry.name === name)!.cells.find((entry) => entry.home.path === path)!;

  it('says what each home’s settings do to a skill, and where, keeping its place', () => {
    expect([at('pdf', PROXY).place, at('pdf', PROXY).override?.state, isTurnedOff(at('pdf', PROXY))]).toEqual(['off', 'off', true]);
    expect(at('mine', CLAUDE).override).toEqual({ name: 'mine', state: 'nameOnly', source: 'settings', file: `${CLAUDE}/settings.json` });
    expect(isTurnedOff(at('mine', CLAUDE))).toBe(false);
    expect(at('pdf', CODEX).override).toBeNull();
  });

  it('offers no link to a skill turned off, and doesn’t count or flag it', () => {
    const row = overridden.rows.find((entry) => entry.name === 'pdf')!;
    expect(cellOptions(row, at('pdf', PROXY))).toEqual([]);
    const design = overridden.rows.find((entry) => entry.name === 'design')!;
    expect(cellOptions(design, at('design', PROXY))).toEqual(['remove']);
    expect(homeCounts(overridden, at('pdf', PROXY).home)).toEqual({ fromStore: 0, own: 1, turnedOff: 2 });
    // design's only other copy that needs a look is ~/.claude's drifted one.
    expect(needsLook(design)).toBe(true);
    expect(needsLook({ ...design, cells: design.cells.filter((entry) => entry.home.path !== CLAUDE) })).toBe(false);
  });

  it('suggests nothing for a skill a home turns off', () => {
    const kinds = skillSuggestions(overridden).map((entry) => [entry.kind, entry.changes.map((change) => `${change.row.name}@${change.cell.home.path}`)]);
    expect(kinds).toEqual([
      ['codexTwice', [`notes@${CODEX}`, `pdf@${CODEX}`]],
      ['intoStore', [`legacy@${CODEX}`, `mine@${CLAUDE}`, `mine@${PROXY}`]],
    ]);
  });
});

describe('how much each skill is used', () => {
  const usage = (name: string): SkillUsage => ({ name, sessions: 3, calls: 5, lastMs: 1_000, machines: { 'cam-mbp': 3 } });
  const used = new Map([['pdf', usage('pdf')], ['browser-check', usage('browser-check')]]);

  it('finds a skill by its folder’s name, or the one its SKILL.md gives', () => {
    expect(usageFor(row('pdf'), used)?.name).toBe('pdf');
    expect(usageFor(row('browser'), used)?.name).toBe('browser-check');
    expect(usageFor(row('design'), used)).toBeNull();
  });
});

import { describe, expect, it } from 'bun:test';
import { changeKey, extensionsView } from '../src/services/setupPlugins';
import { differs, ownValues, pluginRepoSuggestions, repoAction, repoPluginValue, wantedOn, withPluginRepo } from '../src/services/setupPluginRepo';
import type { RepoPlugin, SetupHome, SetupItem, SetupMachine } from '../src/native/types';

const item = (kind: SetupItem['kind'], name: string, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind, name, path: null, sum: `${kind}:${name}`, size: null, link: null, value: null, note: null, count: null, enabled: null,
  text: false, skill: null, import: null, ...fields,
});
const plugin = (id: string, version: string | null, enabled: boolean | null = true) => item('plugin', id, { value: version, enabled });
const market = (name: string, source: string) => item('marketplace', name, { note: source, value: new Date().toISOString(), enabled: true });
const home = (path: string, items: SetupItem[]): SetupHome => ({ agent: 'claude', path, items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null });
const machine = (name: string, homes: SetupHome[]): SetupMachine => ({
  machine: name, local: name === 'Mac Mini', reachable: true, homes, harnessHomes: [], harnessInstalls: [], installs: [], policy: null, scannedAt: 1, error: null, scanning: false,
});

const OFFICIAL = 'anthropics/claude-plugins-official';
const machines = [
  machine('Mac Mini', [home('~/.claude', [plugin('context7@official', '1.2.0'), plugin('review@official', '2.0.0'), market('official', OFFICIAL)])]),
  machine('ci-01', [home('~/.claude', [plugin('context7@official', '1.1.0', false), market('official', OFFICIAL)])]),
  machine('cedar', [home('~/.claude', [plugin('context7@official', '1.2.0')])]),
];
const listed: RepoPlugin[] = [
  { id: 'context7@official', source: OFFICIAL, all: 'on', machines: { cedar: 'own' }, projects: {} },
  { id: 'review@official', source: OFFICIAL, all: 'off', machines: { macmini: 'on' }, projects: {} },
  { id: 'lint@official', source: OFFICIAL, all: 'on', machines: { ci01: 'off' }, projects: {} },
];

describe('a plugin’s repo value before a change', () => {
  it('is All machines’ value or the machine’s own, looked up loosely, and nothing when unlisted', () => {
    const [context7, review] = listed;
    expect(repoPluginValue(context7 ?? null, null)).toBe('on');
    expect(repoPluginValue(review ?? null, 'Mac Mini')).toBe('on');
    expect(repoPluginValue(review ?? null, 'ci-01')).toBeNull();
    expect(repoPluginValue(null, null)).toBeNull();
  });
});

describe('the setup repo’s plugins', () => {
  it('gives a machine its own value, looked up loosely, else All machines’', () => {
    expect(wantedOn(listed[0]!, 'Cedar')).toEqual({ value: 'own', own: true });
    expect(wantedOn(listed[0]!, 'ci-01')).toEqual({ value: 'on', own: false });
    expect(ownValues(listed[1]!, ['Mac Mini', 'ci-01'])).toEqual([{ machine: 'Mac Mini', value: 'on' }]);
  });

  it('only counts a home out of step when it would load the plugin otherwise than wanted', () => {
    expect(differs('off', 'on')).toBe(true);
    expect(differs('none', 'on')).toBe(true);
    expect(differs('on', 'off')).toBe(true);
    // Turned on but not installed doesn't load, so it's already off.
    expect(differs('missing', 'off')).toBe(false);
    expect(differs('on', 'own')).toBe(false);
  });

  it('marks each cell, adds rows only the repo has, and suggests the changes that bring homes in step', () => {
    const view = withPluginRepo(extensionsView(machines), listed);
    expect(view.plugins.map((row) => row.id)).toEqual(['context7@official', 'lint@official', 'review@official']);
    const context7 = view.plugins[0]!;
    expect(context7.cells.map((cell) => cell.wanted)).toEqual([
      { value: 'on', own: false, differs: false },
      { value: 'on', own: false, differs: true },
      { value: 'own', own: true, differs: false },
    ]);
    expect(repoAction(context7, context7.cells[1]!)).toBe('enable');
    const lint = view.plugins[1]!;
    // Mac Mini has the marketplace; cedar hasn't, but the repo says where it comes from, so it can be added.
    expect(lint.source).toBe(OFFICIAL);
    expect(repoAction(lint, lint.cells[0]!)).toBe('install');
    expect(repoAction(lint, lint.cells[1]!)).toBeNull();
    expect(repoAction(lint, lint.cells[2]!)).toBe('install');
    const [suggestion] = pluginRepoSuggestions(view, {});
    expect(suggestion?.count).toBe(3);
    // A change already chosen isn't suggested again.
    const chosen = { [changeKey(context7.cells[1]!.home, 'plugin', context7.id)]: 'uninstall' as const };
    expect(pluginRepoSuggestions(view, chosen)[0]?.count).toBe(2);
  });

  it('holds a removed plugin to not being installed, and removes it where it is', () => {
    expect(differs('on', 'removed')).toBe(true);
    expect(differs('off', 'removed')).toBe(true);
    // Named in settings but not installed has nothing to remove.
    expect(differs('missing', 'removed')).toBe(false);
    expect(differs('none', 'removed')).toBe(false);
    const view = withPluginRepo(extensionsView(machines), [{ id: 'context7@official', source: OFFICIAL, all: 'removed', machines: { cedar: 'own' }, projects: {} }]);
    const row = view.plugins.find((entry) => entry.id === 'context7@official')!;
    expect(row.cells.map((cell) => repoAction(row, cell))).toEqual(['uninstall', 'uninstall', null]);
  });

  it('leaves the page alone when the repo lists no plugins', () => {
    const view = extensionsView(machines);
    expect(withPluginRepo(view, [])).toBe(view);
    expect(withPluginRepo(view, null)).toBe(view);
  });
});

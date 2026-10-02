import { describe, expect, it } from 'bun:test';
import { leftoversByMachine, machineColumns, machineLooks, marketplaceSummary, pluginGrid, pluginSummary } from '../src/services/pluginGrid';
import { changeKey, codexPluginActions, extensionsView, marketplaceOptions, plannedPlugins, pluginsFrom } from '../src/services/setupPlugins';
import { codexRepoChanges, withCodexPluginRepo, withPluginRepo } from '../src/services/setupPluginRepo';
import { itemAt, present } from './support/items';
import type { RepoPlugin, SetupHome, SetupItem, SetupMachine } from '../src/native/types';

const item = (kind: SetupItem['kind'], name: string, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind, name, path: null, sum: `${kind}:${name}`, size: null, link: null, value: null, note: null, count: null, enabled: null,
  text: false, skill: null, import: null, ...fields,
});
const plugin = (id: string, version: string | null, enabled: boolean | null = true) => item('plugin', id, { value: version, enabled });
const market = (name: string, source: string) => item('marketplace', name, { note: source, value: new Date().toISOString(), enabled: true });
const home = (path: string, items: SetupItem[]): SetupHome => ({ agent: 'claude', path, items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null });
const machine = (name: string, homes: SetupHome[], reachable = true): SetupMachine => ({
  machine: name, local: name === 'mini', reachable, homes, harnessHomes: [], installs: [], policy: null, scannedAt: 1, error: null, scanning: false,
});

const SECOND = '~/.agent-app/homes/claude-proxy';
const machines = [
  machine('mini', [
    home('~/.claude', [plugin('context7@official', '1.2.0'), plugin('superpowers@official', '4.1.0'), market('official', 'anthropics/official')]),
    home(SECOND, [plugin('context7@official', '1.2.0'), plugin('superpowers@official', '4.1.0', false), market('official', 'anthropics/official')]),
  ]),
  machine('air', [home('~/.claude', [
    plugin('context7@official', '1.2.0'),
    plugin('agency@agency-skills', '1.2.0'),
    market('official', 'anthropics/official'),
    market('agency-skills', 'acme/agency-skills'),
  ])]),
  // Gone from dev, which only still names it as turned off.
  machine('dev', [home('~/.claude', [plugin('context7@official', '1.2.0'), plugin('old@official', null, false)])]),
];
const view = extensionsView(machines);
const columns = machineColumns(view.claudeHomes);
const row = (id: string) => view.plugins.find((entry) => entry.id === id)!;
const column = (name: string) => columns.find((entry) => entry.machine === name)!;

describe('the plugin grid', () => {
  it('puts each machine’s homes in one column', () => {
    expect(columns.map((entry) => [entry.machine, entry.homes.map((found) => found.path)])).toEqual([
      ['mini', ['~/.claude', SECOND]],
      ['air', ['~/.claude']],
      ['dev', ['~/.claude']],
    ]);
  });

  it('sums a plugin up over a machine’s homes', () => {
    const on = pluginSummary(row('context7@official'), column('mini'), {});
    expect([on.state, on.on, on.homes, on.version]).toEqual(['on', 2, 2, '1.2.0']);
    const mixed = pluginSummary(row('superpowers@official'), column('mini'), {});
    expect([mixed.state, mixed.on, mixed.installed]).toEqual(['mixed', 1, 2]);
    expect(pluginSummary(row('superpowers@official'), column('air'), {}).state).toBe('none');
    const chosen = pluginSummary(row('superpowers@official'), column('mini'), { [changeKey(itemAt(column('mini').homes, 1), 'plugin', 'superpowers@official')]: 'enable' });
    expect(chosen.chosen).toBe(1);
  });

  it('lists only what needs a look, and counts a removed plugin a settings file still names instead of listing it', () => {
    const grid = pluginGrid(view, columns, true);
    // context7 is on everywhere; superpowers and agency aren't on every machine.
    expect(grid.rows.map((entry) => entry.id)).toEqual(['agency@agency-skills', 'superpowers@official']);
    expect(grid.inLine).toBe(1);
    expect(grid.leftovers).toEqual([{ machine: 'dev', home: '~/.claude', plugin: 'old@official', reachable: true, policy: false }]);
    const all = pluginGrid(view, columns, false);
    expect(all.rows.map((entry) => entry.id)).toEqual(['agency@agency-skills', 'superpowers@official', 'context7@official']);
    expect(pluginGrid(view, columns, false, 'AGENCY').rows.map((entry) => entry.id)).toEqual(['agency@agency-skills']);
  });

  it('cleans up leftovers by machine, leaving out machines it can’t reach and what a policy names', () => {
    const leftovers = [
      { machine: 'dev', home: '~/.claude', plugin: 'old@official', reachable: true, policy: false },
      { machine: 'dev', home: '~/.agent-app', plugin: 'old@official', reachable: true, policy: false },
      { machine: 'air', home: '~/.claude', plugin: 'gone@official', reachable: false, policy: false },
      { machine: 'mini', home: '~/.claude', plugin: 'kept@official', reachable: true, policy: true },
    ];
    expect([...leftoversByMachine(leftovers)]).toEqual([
      ['dev', [{ home: '~/.claude', plugin: 'old@official' }, { home: '~/.agent-app', plugin: 'old@official' }]],
    ]);
  });

  it('holds the listed plugins to the repo: removed everywhere, on where the repo says, a machine’s own left alone', () => {
    const listed: RepoPlugin[] = [
      { id: 'agency@agency-skills', source: 'acme/agency-skills', all: 'removed', machines: {}, projects: {} },
      { id: 'superpowers@official', source: 'anthropics/official', all: 'on', machines: { air: 'own' }, projects: {} },
    ];
    const repoView = withPluginRepo(view, listed);
    const grid = pluginGrid(repoView, columns, true);
    expect(grid.rows.map((entry) => entry.id)).toEqual(['agency@agency-skills', 'superpowers@official']);
    const agency = repoView.plugins.find((entry) => entry.id === 'agency@agency-skills')!;
    expect(pluginSummary(agency, column('air'), {}).differs).toBe(true);
    expect(pluginSummary(agency, column('mini'), {}).differs).toBe(false);
    const superpowers = present(repoView.plugins.find((entry) => entry.id === 'superpowers@official'));
    expect(Object.values(pluginSummary(agency, column('air'), {}).toRepo)).toEqual(['uninstall']);
    expect(Object.values(pluginSummary(superpowers, column('air'), {}).toRepo)).toEqual([]);
    expect(Object.values(pluginSummary(superpowers, column('mini'), {}).toRepo)).toEqual(['enable']);
    // dev hasn't got superpowers, which the repo wants on; air keeps its own.
    expect(machineLooks(repoView, columns)).toEqual(new Map([['mini', 1], ['air', 1], ['dev', 1]]));
  });
});

describe('removing a marketplace', () => {
  const air = itemAt(column('air').homes, 0);
  const agencyKey = changeKey(air, 'plugin', 'agency@agency-skills');
  const marketRow = view.marketplaces.find((entry) => entry.name === 'agency-skills')!;
  const cell = marketRow.cells.find((entry) => entry.home.machine === 'air')!;

  it('is offered once nothing is left installed from it there, counting the removals chosen', () => {
    expect(pluginsFrom(view, 'agency-skills', air, {})).toEqual(['agency@agency-skills']);
    expect(marketplaceOptions(marketRow, cell, view, {})).toEqual(['refresh']);
    expect(marketplaceOptions(marketRow, cell, view, { [agencyKey]: 'uninstall' })).toEqual(['refresh', 'removeMarketplace']);
  });

  it('comes after its plugins in the review, with where to add it back from', () => {
    const pending = { [agencyKey]: 'uninstall' as const, [changeKey(air, 'marketplace', 'agency-skills')]: 'removeMarketplace' as const };
    const planned = plannedPlugins(view, pending).get('air') ?? [];
    expect(planned.map((change) => [change.action, change.target, change.source])).toEqual([
      ['uninstall', 'agency@agency-skills', null],
      ['removeMarketplace', 'agency-skills', 'acme/agency-skills'],
    ]);
    expect(marketplaceSummary(marketRow, column('air'), pending)).toMatchObject({ has: 1, homes: 1, chosen: 1 });
  });
});

describe('Codex’s plugins', () => {
  const codex = (items: SetupItem[]): SetupHome => ({ ...home('~/.codex', items), agent: 'codex' });
  const view = extensionsView([
    machine('mini', [home('~/.claude', [plugin('context7@official', '1.2.0')]), codex([
      plugin('chrome@openai-bundled', null, true),
      plugin('sketch@team', null, false),
      item('marketplace', 'team', { note: 'acme/codex-plugins' }),
    ])]),
    machine('air', [codex([plugin('sketch@team', null, true)])]),
  ]);

  it('lists them apart from Claude Code’s, on or off as Codex’s config has them', () => {
    expect(view.plugins.map((row) => row.id)).toEqual(['context7@official']);
    expect(view.codexPlugins.map((row) => [row.id, row.cells.map((cell) => [cell.home.machine, cell.place])])).toEqual([
      ['chrome@openai-bundled', [['mini', 'on'], ['air', 'none']]],
      ['sketch@team', [['mini', 'off'], ['air', 'on']]],
    ]);
    // Codex never says when it fetched a marketplace, so none is stale.
    expect(view.codexMarketplaces.map((row) => [row.name, row.github, row.cells.some((cell) => cell.stale)])).toEqual([['team', 'acme/codex-plugins', false]]);
  });

  it('offers what Codex can do in each home, and nothing for the Codex app’s own or a machine it can’t reach', () => {
    const team = item('marketplace', 'team', { note: 'acme/codex-plugins' });
    const offered = extensionsView([
      machine('mini', [codex([plugin('chrome@openai-bundled', null, true), plugin('sketch@team', null, false), team])]),
      machine('air', [codex([plugin('sketch@team', null, true)])]),
      machine('box', [codex([team, item('marketplace', 'openai-bundled')])]),
      machine('gone', [codex([plugin('sketch@team', null, true), team])], false),
    ]).codexPlugins.map((row) => [row.id, row.cells.map((cell) => [cell.home.machine, codexPluginActions(row, cell)])]);
    expect(offered).toEqual([
      ['chrome@openai-bundled', [['mini', []], ['air', []], ['box', []], ['gone', []]]],
      ['sketch@team', [['mini', ['enable', 'uninstall']], ['air', ['disable', 'uninstall']], ['box', ['install']], ['gone', []]]],
    ]);
  });

  it('brings Codex homes in step with the repo’s Codex plugins, adding the marketplace first where its repository is known', () => {
    const team = item('marketplace', 'team', { note: 'acme/codex-plugins' });
    const listed = (id: string, all: RepoPlugin['all'], machines: RepoPlugin['machines'] = {}, source: string | null = null): RepoPlugin => ({ id, source, all, machines, projects: {} });
    const view = withCodexPluginRepo(extensionsView([
      machine('mini', [codex([plugin('sketch@team', null, false), team])]),
      machine('air', [codex([plugin('sketch@team', null, true)])]),
      machine('box', [codex([team])]),
    ]), [listed('sketch@team', 'on', { air: 'removed' }), listed('review@team', 'on'), listed('deploy@ops', 'on', {}, 'acme/codex-ops'), listed('lint@local', 'on')]);
    const actions = view.codexPlugins.map((row) => [row.id, row.cells.map((cell) => [cell.home.machine, codexRepoChanges(row, cell)])]);
    expect(actions).toEqual([
      // The repo gives ops' repository, so every home gets the marketplace first.
      ['deploy@ops', [['mini', ['addMarketplace', 'install']], ['air', ['addMarketplace', 'install']], ['box', ['addMarketplace', 'install']]]],
      // Without a repository to add it from, a marketplace no home has leaves nothing to do.
      ['lint@local', [['mini', []], ['air', []], ['box', []]]],
      // Air hasn't team, whose repository mini's config gives.
      ['review@team', [['mini', ['install']], ['air', ['addMarketplace', 'install']], ['box', ['install']]]],
      ['sketch@team', [['mini', ['enable']], ['air', ['uninstall']], ['box', ['install']]]],
    ]);
    // Claude Code's plugins are left alone.
    expect(view.plugins).toEqual([]);
  });
});

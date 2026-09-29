import { describe, expect, it } from 'bun:test';
import {
  changeKey,
  compareVersions,
  extensionsView,
  marketplaceOptions,
  newestVersion,
  pluginChanges,
  pluginNames,
  pluginOptions,
  pluginSuggestions,
  plannedPlugins,
  serverUsage,
  settlePlugins,
  unusedServer,
} from '../src/services/setupPlugins';
import { itemAt } from './support/items';
import type { McpUsageReport, SetupHome, SetupItem, SetupMachine } from '../src/native/types';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const item = (kind: SetupItem['kind'], name: string, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind, name, path: null, sum: `${kind}:${name}`, size: null, link: null, value: null, note: null, count: null, enabled: null,
  text: false, skill: null, import: null, ...fields,
});
const plugin = (id: string, version: string | null, enabled: boolean | null = true) => item('plugin', id, { value: version, enabled });
const market = (name: string, source: string, fetched: string | null, auto: boolean | null = null) => item('marketplace', name, { note: source, value: fetched, enabled: auto });
const server = (name: string, sum: string, fields: Partial<SetupItem> = {}) => item('mcp', name, { sum, value: 'stdio', note: 'npx', ...fields });
const home = (agent: SetupHome['agent'], path: string, items: SetupItem[]): SetupHome => ({ agent, path, items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null });
const machine = (name: string, homes: SetupHome[], reachable = true): SetupMachine => ({
  machine: name, local: name === 'mbp', reachable, homes, installs: [], policy: null, scannedAt: NOW, error: null, scanning: false,
});

const OFFICIAL = 'claude-plugins-official';
const machines = [
  machine('mbp', [
    home('codex', '~/.codex', [server('linear', 'codex-a')]),
    home('claude', '~/.t3/provider-homes/claude-proxy', [plugin(`context7@${OFFICIAL}`, '1.2.0'), market(OFFICIAL, 'anthropics/claude-plugins-official', ago(1), true)]),
    home('claude', '~/.claude', [
      plugin(`context7@${OFFICIAL}`, '1.2.0'),
      plugin(`review@${OFFICIAL}`, '2.0.0', false),
      plugin('superpowers@superpowers-marketplace', '4.1.0'),
      market(OFFICIAL, 'anthropics/claude-plugins-official', ago(2), true),
      market('superpowers-marketplace', 'obra/superpowers-marketplace', ago(40)),
      market('local', '~/src/plugins', ago(1)),
      server('linear', 'a', { value: 'http', note: 'mcp.linear.app' }),
      server('playwright', 'p'),
    ]),
    home('shared', '~/.agents', []),
  ]),
  machine('ci', [
    home('claude', '~/.claude', [
      plugin(`context7@${OFFICIAL}`, '1.1.0'),
      plugin(`ghost@${OFFICIAL}`, null, true),
      plugin('superpowers@superpowers-marketplace', 'abc123def456'),
      market(OFFICIAL, 'anthropics/claude-plugins-official', ago(20), false),
      server('linear', 'b', { value: 'http', note: 'mcp.linear.app', enabled: false }),
    ]),
    home('codex', '~/.codex', [server('linear', 'codex-b')]),
  ]),
  machine('cedar', [home('claude', '~/.claude', [plugin(`context7@${OFFICIAL}`, '1.2.0')])], false),
];

describe('versions', () => {
  it('orders dotted versions, with a pre-release before its release', () => {
    expect(compareVersions('1.10.0', '1.9.3')).toBe(1);
    expect(compareVersions('v2.0', '2.0.0')).toBe(0);
    expect(compareVersions('2.0.0-beta.2', '2.0.0')).toBe(-1);
    expect(compareVersions('2.0.0-beta.10', '2.0.0-beta.2')).toBe(1);
    expect(compareVersions('abc123def456', '1.0.0')).toBeNull();
  });

  it('finds the newest only when every version can be ordered', () => {
    expect(newestVersion(['1.1.0', '1.2.0', '1.1.0'])).toBe('1.2.0');
    expect(newestVersion(['4.1.0', 'abc123def456'])).toBeNull();
    expect(newestVersion(['abc123def456', 'abc123def456'])).toBe('abc123def456');
    expect(newestVersion([])).toBeNull();
  });
});

describe('the fleet view', () => {
  const view = extensionsView(machines, {}, NOW);

  it('has a column for every Claude Code home, and Codex homes for MCP servers', () => {
    expect(view.claudeHomes.map((entry) => `${entry.machine} ${entry.path}`)).toEqual([
      'mbp ~/.claude', 'mbp ~/.t3/provider-homes/claude-proxy', 'ci ~/.claude', 'cedar ~/.claude',
    ]);
    expect(view.mcpHomes.map((entry) => `${entry.machine} ${entry.path}`)).toEqual([
      'mbp ~/.claude', 'mbp ~/.t3/provider-homes/claude-proxy', 'mbp ~/.codex', 'ci ~/.claude', 'ci ~/.codex', 'cedar ~/.claude',
    ]);
  });

  it('leaves out a shadow Codex home whose config.toml is another home’s', () => {
    const shadow = { ...home('codex', '~/.t3/provider-homes/codex-proxy', []), shares: { home: '~/.codex', entries: ['config.toml'] } };
    const withShadow = machines.map((entry) => (entry.machine === 'mbp' ? { ...entry, homes: [...entry.homes, shadow] } : entry));
    expect(extensionsView(withShadow, {}, NOW).mcpHomes.map((entry) => `${entry.machine} ${entry.path}`)).toEqual(view.mcpHomes.map((entry) => `${entry.machine} ${entry.path}`));
  });

  it('marks plugins behind the newest version any home has', () => {
    const context7 = view.plugins.find((row) => row.name === 'context7')!;
    expect([context7.marketplace, context7.newest, context7.source]).toEqual([OFFICIAL, '1.2.0', 'anthropics/claude-plugins-official']);
    expect(context7.cells.map((cell) => [cell.place, cell.behind])).toEqual([['on', false], ['on', false], ['on', true], ['on', false]]);
    const review = view.plugins.find((row) => row.name === 'review')!;
    expect(review.cells.map((cell) => cell.place)).toEqual(['off', 'none', 'none', 'none']);
    expect(itemAt(view.plugins.find((row) => row.name === 'ghost')!.cells, 2).place).toBe('missing');
    const superpowers = view.plugins.find((row) => row.name === 'superpowers')!;
    expect([superpowers.newest, superpowers.mixed, superpowers.cells.some((cell) => cell.behind)]).toEqual([null, true, false]);
  });

  it('marks marketplaces nobody has fetched for a week, unless Claude Code keeps them up to date', () => {
    const official = view.marketplaces.find((row) => row.name === OFFICIAL)!;
    expect(official.cells.map((cell) => cell.stale)).toEqual([false, false, true, false]);
    expect(itemAt(official.cells, 0).fetchedMs).toBe(NOW - 2 * 86_400_000);
    const superpowers = view.marketplaces.find((row) => row.name === 'superpowers-marketplace')!;
    expect([superpowers.github, itemAt(superpowers.cells, 0).stale]).toEqual(['obra/superpowers-marketplace', true]);
    expect(view.marketplaces.find((row) => row.name === 'local')!.github).toBeNull();
  });

  it('letters MCP servers set up differently, comparing each agent only with itself', () => {
    const linear = view.servers.find((row) => row.name === 'linear')!;
    expect(linear.cells.map((cell) => cell.variant)).toEqual(['A', null, 'A', 'B', 'B', null]);
    expect(view.servers.find((row) => row.name === 'playwright')!.cells.map((cell) => cell.variant)).toEqual([null, null, null, null, null, null]);
  });

  it('adds what a health check found, by where it comes from', () => {
    const checked = extensionsView(machines, {
      [`mbp\u0000~/.claude`]: {
        home: '~/.claude', checkedAt: NOW, servers: [
          { name: 'linear', status: 'needsAuth' },
          { name: 'plugin:context7:context7', status: 'connected' },
          { name: 'claude.ai Gmail', status: 'failed' },
        ],
      },
    }, NOW);
    const rows = checked.servers.map((row) => [row.name, row.origin, row.plugin, row.toolName]);
    expect(rows).toEqual([
      ['linear', 'config', null, 'linear'],
      ['playwright', 'config', null, 'playwright'],
      ['claude.ai Gmail', 'claudeai', null, 'claude_ai_Gmail'],
      ['plugin:context7:context7', 'plugin', 'context7', 'plugin_context7_context7'],
    ]);
    expect(itemAt(checked.servers, 0).cells.map((cell) => cell.health)).toEqual(['needsAuth', null, null, null, null, null]);
  });
});

describe('plugin changes', () => {
  const view = extensionsView(machines, {}, NOW);
  const row = (name: string) => view.plugins.find((entry) => entry.name === name)!;
  const marketRow = (name: string) => view.marketplaces.find((entry) => entry.name === name)!;

  it('offers what the backend allows, and nothing on a machine that isn’t answering', () => {
    expect(pluginOptions(row('context7'), itemAt(row('context7').cells, 0))).toEqual(['update', 'disable', 'uninstall']);
    expect(pluginOptions(row('review'), itemAt(row('review').cells, 0))).toEqual(['enable', 'update', 'uninstall']);
    expect(pluginOptions(row('review'), itemAt(row('review').cells, 2))).toEqual(['install']);
    expect(pluginOptions(row('ghost'), itemAt(row('ghost').cells, 2))).toEqual(['install']);
    expect(pluginOptions(row('context7'), itemAt(row('context7').cells, 3))).toEqual([]);
    expect(marketplaceOptions(marketRow(OFFICIAL), itemAt(marketRow(OFFICIAL).cells, 2), view, {})).toEqual(['refresh']);
    expect(marketplaceOptions(marketRow('superpowers-marketplace'), itemAt(marketRow('superpowers-marketplace').cells, 2), view, {})).toEqual(['addMarketplace']);
    expect(marketplaceOptions(marketRow('local'), itemAt(marketRow('local').cells, 2), view, {})).toEqual([]);
  });

  it('only updates a plugin a machine’s policy turns on or off', () => {
    const policy = { file: '/etc/claude-code/managed-settings.json', keys: [{ kind: 'plugin' as const, name: `review@${OFFICIAL}` }], problem: null, ignoredOverrides: false };
    const ruled = extensionsView(machines.map((entry) => (entry.machine === 'mbp' || entry.machine === 'ci' ? { ...entry, policy } : entry)), {}, NOW);
    const review = ruled.plugins.find((entry) => entry.name === 'review')!;
    expect(review.cells.map((cell) => cell.policy)).toEqual([policy.file, policy.file, policy.file, null]);
    expect(pluginOptions(review, itemAt(review.cells, 0))).toEqual(['update']);
    expect(pluginOptions(review, itemAt(review.cells, 2))).toEqual([]);
    expect(pluginOptions(ruled.plugins.find((entry) => entry.name === 'context7')!, itemAt(review.cells, 0))).toEqual(['update']);
    expect(itemAt(row('context7').cells, 0).policy).toBeNull();
  });

  it('adds a marketplace an install needs, once, and groups the changes by machine', () => {
    const mbp = itemAt(view.claudeHomes, 0);
    const proxy = itemAt(view.claudeHomes, 1);
    const ci = itemAt(view.claudeHomes, 2);
    const pending = settlePlugins(view, {
      [changeKey(ci, 'plugin', 'superpowers@superpowers-marketplace')]: 'update',
      [changeKey(ci, 'plugin', `review@${OFFICIAL}`)]: 'install',
      [changeKey(proxy, 'plugin', 'superpowers@superpowers-marketplace')]: 'install',
      [changeKey(proxy, 'marketplace', OFFICIAL)]: 'refresh',
      [changeKey(mbp, 'plugin', `context7@${OFFICIAL}`)]: 'enable',
      [changeKey(itemAt(view.claudeHomes, 3), 'plugin', `context7@${OFFICIAL}`)]: 'update',
    });
    expect(Object.values(pending)).toHaveLength(4);
    const planned = plannedPlugins(view, pending);
    expect([...planned.keys()]).toEqual(['mbp', 'ci']);
    expect(pluginChanges(planned.get('mbp')!)).toEqual([
      { home: '~/.t3/provider-homes/claude-proxy', action: 'refresh', target: OFFICIAL },
      { home: '~/.t3/provider-homes/claude-proxy', action: 'addMarketplace', target: 'superpowers-marketplace', source: 'obra/superpowers-marketplace' },
      { home: '~/.t3/provider-homes/claude-proxy', action: 'install', target: 'superpowers@superpowers-marketplace' },
    ]);
    expect(planned.get('mbp')!.map((change) => change.auto)).toEqual([false, true, false]);
    expect(pluginChanges(planned.get('ci')!)).toEqual([
      { home: '~/.claude', action: 'install', target: `review@${OFFICIAL}` },
      { home: '~/.claude', action: 'update', target: 'superpowers@superpowers-marketplace' },
    ]);
  });

  it('suggests updating what’s behind and refreshing stale marketplaces', () => {
    const suggestions = pluginSuggestions(view, {});
    expect(suggestions.map((suggestion) => [suggestion.kind, suggestion.count])).toEqual([['behind', 1], ['stale', 2]]);
    expect(Object.values(itemAt(suggestions, 1).keys)).toEqual(['refresh', 'refresh']);
    const taken = pluginSuggestions(view, itemAt(suggestions, 0).keys);
    expect(taken.map((suggestion) => suggestion.kind)).toEqual(['stale']);
  });
});

describe('use', () => {
  const view = extensionsView(machines, {}, NOW);
  const usage: McpUsageReport = {
    servers: [{ name: 'linear', sessions: 4, calls: 9, lastMs: NOW, machines: { mbp: 4 } }],
    plugins: [],
    counted: 30,
    pending: 0,
  };

  it('flags servers in a Claude Code home that no session called', () => {
    const linear = itemAt(view.servers, 0);
    const playwright = itemAt(view.servers, 1);
    expect(serverUsage(linear, usage)?.sessions).toBe(4);
    expect([unusedServer(linear, usage), unusedServer(playwright, usage)]).toEqual([false, true]);
    expect(unusedServer(playwright, { ...usage, counted: 0 })).toBe(false);
    expect(unusedServer(playwright, null)).toBe(false);
  });

  it('asks about each plugin by name once', () => {
    expect(pluginNames(view)).toEqual(['context7', 'ghost', 'review', 'superpowers']);
  });
});

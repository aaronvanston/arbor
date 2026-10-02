import { describe, expect, it } from 'bun:test';
import { columnKey, extensionsView, homePluginTokens, pluginCost } from '../src/services/setupPlugins';
import { itemAt } from './support/items';
import type { PluginCost, PluginCosts, SetupHome, SetupItem, SetupMachine } from '../src/native/types';

const item = (kind: SetupItem['kind'], name: string, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind, name, path: null, sum: `${kind}:${name}`, size: null, link: null, value: null, note: null, count: null, enabled: null,
  text: false, skill: null, import: null, ...fields,
});
const plugin = (id: string, version: string | null, enabled: boolean | null = true) => item('plugin', id, { value: version, enabled });
const home = (path: string, items: SetupItem[]): SetupHome => ({ agent: 'claude', path, items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null });
const machine = (name: string, homes: SetupHome[]): SetupMachine => ({
  machine: name, local: false, reachable: true, homes, harnessHomes: [], installs: [], policy: null, scannedAt: 1, error: null, scanning: false,
});
const cost = (id: string, tokens: number | null, under = false): PluginCost => ({
  id, alwaysOn: tokens === null ? null : { tokens, under }, components: [], counts: {}, error: tokens === null ? 'claude plugin details stopped with code 1 there' : null,
});
const measure = (path: string, plugins: PluginCost[]): PluginCosts => ({ home: path, measuredAt: 1, plugins });

const view = extensionsView([
  machine('mbp', [home('~/.claude', [plugin('big@team', '2.0.0'), plugin('small@team', '1.0.0'), plugin('idle@team', '1.0.0', false)])]),
  machine('ci', [home('~/.claude', [plugin('big@team', '1.0.0')])]),
]);
const mbp = itemAt(view.claudeHomes.filter((entry) => entry.machine === 'mbp'), 0);
const ci = itemAt(view.claudeHomes.filter((entry) => entry.machine === 'ci'), 0);

describe('plugin token cost', () => {
  it('adds up only the plugins turned on in a home, from its own measure', () => {
    const costs = {
      [columnKey(mbp)]: measure('~/.claude', [cost('big@team', 2_000), cost('small@team', 20, true), cost('idle@team', 900)]),
    };
    expect(homePluginTokens(view.plugins, mbp, costs)).toEqual({ tokens: 2_020, under: true });
    expect(homePluginTokens(view.plugins, ci, costs)).toBeNull();
  });

  it('shows a plugin at the most any home measured it, and a failed measure only when nothing better came back', () => {
    const costs = {
      [columnKey(mbp)]: measure('~/.claude', [cost('big@team', 2_000), cost('small@team', null)]),
      [columnKey(ci)]: measure('~/.claude', [cost('big@team', 1_500)]),
    };
    expect(pluginCost(costs, 'big@team')?.alwaysOn?.tokens).toBe(2_000);
    expect(pluginCost(costs, 'small@team')?.error).toBe('claude plugin details stopped with code 1 there');
    expect(pluginCost(costs, 'ghost@team')).toBeNull();
  });
});

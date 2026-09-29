import { describe, expect, it } from 'bun:test';
import { mcpGrid, mcpMachineLooks, mcpNeedsLook, mcpSummary, unchosen } from '../src/services/mcpGrid';
import { machineColumns } from '../src/services/pluginGrid';
import { isRemovedServer, mcpKey, mcpWantedOn, withRegistry } from '../src/services/setupMcp';
import { extensionsView } from '../src/services/setupPlugins';
import { present } from './support/items';
import type { McpRegistry, RegistryCell, ServerView, SetupHome, SetupItem, SetupMachine } from '../src/native/types';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const server = (name: string, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind: 'mcp', name, path: null, sum: name, size: null, link: null, value: 'stdio', note: 'npx', count: null, enabled: null,
  text: false, skill: null, import: null, ...fields,
});
const home = (agent: SetupHome['agent'], path: string, items: SetupItem[]): SetupHome => ({ agent, path, items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null });
const machine = (name: string, homes: SetupHome[], reachable = true): SetupMachine => ({
  machine: name, local: name === 'mbp', reachable, homes, installs: [], policy: null, scannedAt: NOW, error: null, scanning: false,
});

const machines = [
  machine('mbp', [
    home('claude', '~/.claude', [server('linear', { value: 'http' }), server('playwright'), server('sketch')]),
    home('codex', '~/.codex', [server('linear', { value: 'http' }), server('sketch', { enabled: false })]),
  ]),
  machine('ci', [home('claude', '~/.claude', [server('linear', { value: 'http' }), server('sketch')])]),
];

const definition = { transport: 'http', place: 'mcp.linear.app', variables: [] };
const serverView = (name: string, fields: Partial<ServerView> = {}): ServerView => ({ name, claude: definition, codex: definition, homes: null, own: [], off: [], problems: [], ...fields });
const cell = (machineName: string, path: string, name: string, state: RegistryCell['state']): RegistryCell => ({ machine: machineName, home: path, name, state, own: false, blocked: null });
const registry: McpRegistry = {
  commit: 'a'.repeat(40),
  found: true,
  uncommitted: false,
  problems: [],
  // linear is kept off ci; sentry is missing from ci.
  servers: [serverView('linear', { off: ['ci'] }), serverView('sentry', { codex: null })],
  cells: [
    cell('mbp', '~/.claude', 'linear', 'same'),
    cell('mbp', '~/.codex', 'linear', 'same'),
    cell('ci', '~/.claude', 'linear', 'extra'),
    cell('mbp', '~/.claude', 'sentry', 'same'),
    cell('ci', '~/.claude', 'sentry', 'add'),
    cell('mbp', '~/.claude', 'playwright', 'extra'),
    cell('mbp', '~/.claude', 'sketch', 'extra'),
    cell('mbp', '~/.codex', 'sketch', 'extra'),
    cell('ci', '~/.claude', 'sketch', 'extra'),
  ],
};

const view = withRegistry(extensionsView(machines, {}, NOW), registry);
const columns = machineColumns(view.mcpHomes);
const row = (name: string) => present(view.servers.find((entry) => entry.name === name), `a ${name} row`);
const column = (name: string) => present(columns.find((entry) => entry.machine === name), `${name}'s column`);

describe('the MCP grid', () => {
  it('puts a machine’s Claude Code and Codex homes in one column', () => {
    expect(columns.map((entry) => [entry.machine, entry.homes.map((found) => found.path)])).toEqual([
      ['mbp', ['~/.claude', '~/.codex']],
      ['ci', ['~/.claude']],
    ]);
  });

  it('sums a server up over a machine’s homes', () => {
    const linear = mcpSummary(row('linear'), column('mbp'), true, {});
    expect([linear.state, linear.configured, linear.homes, linear.transport, linear.differs]).toEqual(['on', 2, 2, 'http', false]);
    // On in Claude Code, off in Codex.
    expect(mcpSummary(row('sketch'), column('mbp'), true, {}).state).toBe('some');
    expect(mcpSummary(row('playwright'), column('mbp'), true, {}).state).toBe('some');
    expect(mcpSummary(row('sentry'), column('ci'), true, {}).state).toBe('missing');
    expect(mcpSummary(row('playwright'), column('ci'), true, {}).state).toBe('none');
  });

  it('holds a machine to the repo: set up what it lacks, take out what the repo keeps off it', () => {
    const kept = mcpSummary(row('linear'), column('ci'), true, {});
    expect(kept.differs).toBe(true);
    expect(kept.toRepo).toEqual({ [mcpKey({ machine: 'ci', path: '~/.claude' }, 'linear')]: 'remove' });
    const missing = mcpSummary(row('sentry'), column('ci'), true, {});
    expect(missing.toRepo).toEqual({ [mcpKey({ machine: 'ci', path: '~/.claude' }, 'sentry')]: 'add' });
    // Until the repo's file is read cleanly, nothing is taken out to match it.
    expect(mcpSummary(row('linear'), column('ci'), false, {}).toRepo).toEqual({});
  });

  it('leaves a server the repo has never had to its machines, and never removes it to match', () => {
    const playwright = mcpSummary(row('playwright'), column('mbp'), true, {});
    expect([playwright.differs, playwright.toRepo]).toEqual([false, {}]);
  });

  it('counts what’s chosen and doesn’t offer it again', () => {
    const key = mcpKey({ machine: 'ci', path: '~/.claude' }, 'sentry');
    const summary = mcpSummary(row('sentry'), column('ci'), true, { [key]: 'add' });
    expect(summary.chosen).toBe(1);
    expect(unchosen(summary.toRepo, { [key]: 'add' })).toEqual({});
  });

  it('shows what needs a look first, and only that by default', () => {
    // playwright is on one machine only and the repo hasn't a word on it; sketch is on both.
    expect(mcpNeedsLook(row('playwright'), columns)).toBe(true);
    expect(mcpNeedsLook(row('sketch'), columns)).toBe(true);
    const only = mcpGrid(view, columns, true);
    expect(only.rows.map((entry) => entry.name)).toEqual(['linear', 'playwright', 'sentry', 'sketch']);
    expect(only.inLine).toBe(0);
    expect(mcpGrid(view, columns, true, 'sen').rows.map((entry) => entry.name)).toEqual(['sentry']);
  });

  it('hides servers in line everywhere until everything is asked for', () => {
    const inLine = withRegistry(extensionsView([machine('mbp', [home('claude', '~/.claude', [server('linear')])]), machine('ci', [home('claude', '~/.claude', [server('linear')])])], {}, NOW), null);
    const inLineColumns = machineColumns(inLine.mcpHomes);
    expect(mcpGrid(inLine, inLineColumns, true)).toEqual({ rows: [], inLine: 1 });
    expect(mcpGrid(inLine, inLineColumns, false).rows.map((entry) => entry.name)).toEqual(['linear']);
  });

  it('counts each machine’s servers to look at', () => {
    expect([...mcpMachineLooks(view, columns)]).toEqual([['mbp', 0], ['ci', 2]]);
  });

  it('takes a server the repo removed out of every home that has it', () => {
    const removed = withRegistry(extensionsView(machines, {}, NOW), {
      ...registry,
      servers: [...registry.servers, serverView('sketch', { claude: null, codex: null })],
    });
    const sketch = present(removed.servers.find((entry) => entry.name === 'sketch'), 'sketch');
    expect(sketch.repo && isRemovedServer(sketch.repo)).toBe(true);
    const mbp = mcpSummary(sketch, column('mbp'), true, {});
    expect(mbp.differs).toBe(true);
    expect(mbp.toRepo).toEqual({
      [mcpKey({ machine: 'mbp', path: '~/.claude' }, 'sketch')]: 'remove',
      [mcpKey({ machine: 'mbp', path: '~/.codex' }, 'sketch')]: 'remove',
    });
  });

  it('says what the repo wants of a server on each machine', () => {
    const linear = serverView('linear', { off: ['ci'], own: ['cedar'] });
    expect([mcpWantedOn(linear, 'ci'), mcpWantedOn(linear, 'cedar'), mcpWantedOn(linear, 'mbp')]).toEqual(['off', 'own', 'default']);
    expect(mcpWantedOn(serverView('gone', { claude: null, codex: null }), 'mbp')).toBe('removed');
  });
});

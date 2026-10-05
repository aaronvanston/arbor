import { describe, expect, it } from 'bun:test';
import { extensionsView } from '../src/services/setupPlugins';
import {
  canTake,
  mcpChanges,
  mcpKey,
  mcpOptions,
  mcpSuggestions,
  plannedMcp,
  settleMcp,
  takePlan,
  withRegistry,
} from '../src/services/setupMcp';
import { itemAt, present } from './support/items';
import type { McpRegistry, RegistryCell, ServerView, SetupHome, SetupItem, SetupMachine } from '../src/native/types';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const server = (name: string, sum: string, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind: 'mcp', name, path: null, sum, size: null, link: null, value: 'stdio', note: 'npx', count: null, enabled: null,
  text: false, skill: null, import: null, ...fields,
});
const home = (agent: SetupHome['agent'], path: string, items: SetupItem[]): SetupHome => ({ agent, path, items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null });
const machine = (name: string, homes: SetupHome[], reachable = true): SetupMachine => ({
  machine: name, local: name === 'mbp', reachable, homes, harnessHomes: [], harnessInstalls: [], installs: [], policy: null, scannedAt: NOW, error: null, scanning: false,
});

const machines = [
  machine('mbp', [
    home('claude', '~/.claude', [server('linear', 'a', { value: 'http', note: 'mcp.linear.app' }), server('playwright', 'p')]),
    home('codex', '~/.codex', [server('linear', 'c')]),
  ]),
  machine('ci', [home('claude', '~/.claude', [server('linear', 'b', { value: 'http', note: 'mcp.linear.app' }), server('odd.name', 'o')])]),
  machine('cedar', [home('claude', '~/.claude', [])], false),
];

const definition = { transport: 'http', place: 'mcp.linear.app', variables: ['LINEAR_API_KEY'] };
const view = (name: string, fields: Partial<ServerView> = {}): ServerView => ({
  name, claude: definition, codex: null, homes: null, agents: [], own: [], off: [], allOff: false, problems: [], ...fields,
});
const cell = (machine: string, home: string, name: string, state: RegistryCell['state'], fields: Partial<RegistryCell> = {}): RegistryCell => ({
  machine, home, name, state, own: false, blocked: null, ...fields,
});
const registry: McpRegistry = {
  commit: 'a'.repeat(40),
  found: true,
  uncommitted: false,
  problems: [],
  servers: [view('linear', { own: ['ci'] }), view('sentry'), view('notion', { problems: ['claude: headers.Authorization looks like a secret'] })],
  cells: [
    cell('mbp', '~/.claude', 'linear', 'same'),
    cell('mbp', '~/.claude', 'notion', 'add', { blocked: 'broken' }),
    cell('mbp', '~/.claude', 'playwright', 'extra'),
    cell('mbp', '~/.claude', 'sentry', 'add'),
    cell('mbp', '~/.codex', 'linear', 'extra'),
    cell('ci', '~/.claude', 'linear', 'update', { own: true }),
    cell('ci', '~/.claude', 'odd.name', 'extra', { blocked: 'name' }),
    cell('ci', '~/.claude', 'sentry', 'add'),
    cell('cedar', '~/.claude', 'sentry', 'add'),
  ],
};

const merged = withRegistry(extensionsView(machines, {}, NOW), registry);
const row = (name: string) => present(merged.servers.find((entry) => entry.name === name), `a ${name} row`);
const at = (name: string, machineName: string, path: string) =>
  present(row(name).cells.find((entry) => entry.home.machine === machineName && entry.home.path === path), `${name} on ${machineName} ${path}`);

describe('the repo in the fleet view', () => {
  it('adds a row for each server only the repo has, in order with the rest', () => {
    expect(merged.servers.map((entry) => entry.name)).toEqual(['linear', 'notion', 'odd.name', 'playwright', 'sentry']);
    expect(row('sentry').cells.every((entry) => entry.item === null)).toBe(true);
    expect(row('sentry').repo?.claude?.variables).toEqual(['LINEAR_API_KEY']);
    expect(row('playwright').repo).toBeNull();
  });

  it('gives each cell its state against the repo', () => {
    expect(at('linear', 'mbp', '~/.claude').repo?.state).toBe('same');
    expect(at('linear', 'ci', '~/.claude').repo).toMatchObject({ state: 'update', own: true });
    expect(at('sentry', 'cedar', '~/.claude').repo?.state).toBe('add');
    expect(at('linear', 'cedar', '~/.claude').repo).toBeNull();
  });

  it('leaves the view alone until the repo is read', () => {
    const plain = extensionsView(machines, {}, NOW);
    expect(withRegistry(plain, null)).toBe(plain);
  });
});

describe('changes against the repo', () => {
  it('offers what brings a home in step, only where it can be made', () => {
    expect(mcpOptions(at('sentry', 'mbp', '~/.claude'), true)).toEqual(['add']);
    expect(mcpOptions(at('linear', 'ci', '~/.claude'), true)).toEqual(['update']);
    expect(mcpOptions(at('playwright', 'mbp', '~/.claude'), true)).toEqual(['remove']);
    expect(mcpOptions(at('playwright', 'mbp', '~/.claude'), false)).toEqual([]);
    expect(mcpOptions(at('linear', 'mbp', '~/.claude'), true)).toEqual([]);
    expect(mcpOptions(at('notion', 'mbp', '~/.claude'), true)).toEqual([]);
    expect(mcpOptions(at('odd.name', 'ci', '~/.claude'), true)).toEqual([]);
    expect(mcpOptions(at('sentry', 'cedar', '~/.claude'), true)).toEqual([]);
  });

  it('can take what a home has differently, or what the repo hasn’t got there', () => {
    expect(canTake(at('linear', 'ci', '~/.claude'))).toBe(true);
    expect(canTake(at('playwright', 'mbp', '~/.claude'))).toBe(true);
    expect(canTake(at('linear', 'mbp', '~/.claude'))).toBe(false);
    expect(canTake(at('sentry', 'mbp', '~/.claude'))).toBe(false);
    expect(canTake(at('odd.name', 'ci', '~/.claude'))).toBe(false);
  });

  it('keeps only choices that still hold, and plans them by machine', () => {
    const pending = {
      [mcpKey({ machine: 'mbp', path: '~/.claude' }, 'sentry')]: 'add' as const,
      [mcpKey({ machine: 'mbp', path: '~/.claude' }, 'linear')]: 'update' as const,
      [mcpKey({ machine: 'ci', path: '~/.claude' }, 'linear')]: 'update' as const,
      [mcpKey({ machine: 'mbp', path: '~/.claude' }, 'playwright')]: 'remove' as const,
    };
    const settled = settleMcp(merged, true, pending);
    expect(Object.keys(settled)).toHaveLength(3);
    const planned = plannedMcp(merged, settled);
    expect([...planned.keys()]).toEqual(['mbp', 'ci']);
    expect(mcpChanges(present(planned.get('mbp')))).toEqual([
      { home: '~/.claude', name: 'playwright', action: 'remove' },
      { home: '~/.claude', name: 'sentry', action: 'add' },
    ]);
    expect(itemAt(present(planned.get('ci')), 0)).toMatchObject({ name: 'linear', action: 'update', own: true, signsOut: true });
  });

  it('suggests what the repo has, never removals', () => {
    const suggestions = mcpSuggestions(merged, true, {});
    expect(suggestions.map((entry) => [entry.kind, entry.count])).toEqual([['repoAdd', 2], ['repoUpdate', 1]]);
    const taken = { [mcpKey({ machine: 'ci', path: '~/.claude' }, 'linear')]: 'update' as const };
    expect(mcpSuggestions(merged, true, taken).map((entry) => entry.kind)).toEqual(['repoAdd']);
  });

  it('says what taking a server does', () => {
    expect(takePlan(row('linear'), at('linear', 'ci', '~/.claude'))).toMatchObject({ replaces: true, ownReplaces: true, addsHome: false });
    expect(takePlan(row('playwright'), at('playwright', 'mbp', '~/.claude'))).toMatchObject({ replaces: false, ownReplaces: false, addsHome: false });
    const kept = withRegistry(extensionsView(machines, {}, NOW), { ...registry, servers: [view('linear', { homes: ['~/.codex'] })] });
    const linear = present(kept.servers.find((entry) => entry.name === 'linear'));
    expect(takePlan(linear, itemAt(linear.cells, 0)).addsHome).toBe(true);
  });
});

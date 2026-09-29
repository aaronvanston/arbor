import { describe, expect, it } from 'bun:test';
import type { ProjectCheckout } from '../src/services/projectCheckouts';
import { homeServer, mcpChanges, projectMcpChanges, repoDefines, serverLoadsIn, type HomeServer } from '../src/services/setupMcpProjects';
import type { McpRegistry, RepoProjectValue, SetupItem, SetupMachine } from '../src/native/types';
import { itemAt } from './support/items';

const mcp = (name: string): SetupItem => ({
  kind: 'mcp', name, path: '~/.claude.json', sum: name, size: null, link: null, value: null, note: null, count: null, enabled: null,
  text: false, skill: null, import: null,
});
const machine = (name: string, items: SetupItem[], deniedMcp: string[] = []): SetupMachine => ({
  machine: name, local: false, reachable: true, installs: [], policy: null, scannedAt: 1, error: null, scanning: false,
  homes: [{ agent: 'claude', path: '~/.claude', items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp, shares: null }],
});
const checkout = (machineName: string, path: string, extra: Partial<ProjectCheckout> = {}): ProjectCheckout => ({
  machine: machineName, path, main: false, plugins: [], skills: [], ignoredOverrides: [], localSeen: false, mcpDenied: [], mcpLocal: [], mcpDisabled: [], instructions: [], agentsMd: null, claudeMd: false, ...extra,
});

const machines = [machine('mac-mini', [mcp('linear')]), machine('ci-01', [mcp('linear')], ['linear'])];
const registry = {
  commit: 'abc', found: true, uncommitted: false, problems: [], servers: [],
  cells: [
    { machine: 'mac-mini', home: '~/.claude', name: 'sentry', state: 'add', own: false, blocked: null },
    { machine: 'mac-mini', home: '~/.claude', name: 'linear', state: 'same', own: false, blocked: null },
    { machine: 'ci-01', home: '~/.claude', name: 'notion', state: 'add', own: false, blocked: 'broken' },
  ],
} satisfies McpRegistry;

describe('a project’s MCP servers in its checkouts', () => {
  it('reads a machine’s home: set up for every project, and denied by its settings or policy', () => {
    expect(homeServer(machines, 'mac-mini', 'linear')).toEqual({ there: true, denied: false });
    expect(homeServer(machines, 'ci-01', 'linear')).toEqual({ there: true, denied: true });
    expect(homeServer(machines, 'cedar', 'linear')).toEqual({ there: false, denied: false });
  });

  it('decides as Claude Code does: a deny anywhere wins, then /mcp, then being set up', () => {
    const there: HomeServer = { there: true, denied: false };
    expect(serverLoadsIn(checkout('m', '/a'), 'linear', there)).toEqual({ on: true, from: 'set' });
    expect(serverLoadsIn(checkout('m', '/a'), 'linear', { there: false, denied: false })).toEqual({ on: false, from: 'none' });
    expect(serverLoadsIn(checkout('m', '/a', { mcpLocal: ['linear'] }), 'linear', { there: false, denied: false }).on).toBe(true);
    expect(serverLoadsIn(checkout('m', '/a', { mcpDenied: [{ name: 'linear', local: true }] }), 'linear', there).from).toBe('local');
    expect(serverLoadsIn(checkout('m', '/a', { mcpDenied: [{ name: 'linear', local: false }], mcpLocal: ['linear'] }), 'linear', there).from).toBe('denied');
    expect(serverLoadsIn(checkout('m', '/a', { mcpDisabled: ['linear'] }), 'linear', there).from).toBe('toggled');
    expect(serverLoadsIn(checkout('m', '/a'), 'linear', { there: true, denied: true }).from).toBe('denied');
  });

  it('only counts a definition the repo can set up in that machine’s Claude Code home', () => {
    expect(repoDefines(registry, 'mac-mini', 'sentry')).toBe(true);
    expect(repoDefines(registry, 'ci-01', 'notion')).toBe(false);
    expect(repoDefines(registry, 'ci-01', 'sentry')).toBe(false);
    expect(repoDefines(null, 'mac-mini', 'sentry')).toBe(false);
  });

  it('lists the changes each checkout needs, and why one can’t be made', () => {
    const values: Record<string, Record<string, RepoProjectValue>> = {
      linear: { 'casey/arbor': { all: 'off', machines: {} } },
      sentry: { 'casey/arbor': { all: 'on', machines: { ci01: 'on' } } },
    };
    const checkouts = [
      checkout('mac-mini', '/src/arbor', { mcpDenied: [{ name: 'linear', local: true }] }),
      checkout('mac-mini', '/src/arbor-wt', { localSeen: true }),
      checkout('mac-mini', '/src/arbor-local', { mcpLocal: ['sentry'] }),
      checkout('mac-mini', '/src/arbor-off', { mcpDisabled: ['sentry'] }),
      checkout('ci-01', '/home/ci/arbor'),
    ];
    const changes = projectMcpChanges(
      ['linear', 'sentry'], values, checkouts, 'Casey/Arbor',
      (name, server) => homeServer(machines, name, server),
      (name, server) => repoDefines(registry, name, server),
    );
    expect(changes).toEqual([
      // The main checkout denies linear already; the worktree needs a settings.local.json Git would see.
      { machine: 'mac-mini', checkout: '/src/arbor-wt', target: 'linear', on: false, blocked: 'seen' },
      { machine: 'mac-mini', checkout: '/src/arbor-local', target: 'linear', on: false, blocked: null },
      { machine: 'mac-mini', checkout: '/src/arbor-off', target: 'linear', on: false, blocked: null },
      // ci-01's own settings deny linear, so it's off there already.
      { machine: 'mac-mini', checkout: '/src/arbor', target: 'sentry', on: true, blocked: null },
      // Turning on needs no new file, so a checkout Git would see a file in can still get it.
      { machine: 'mac-mini', checkout: '/src/arbor-wt', target: 'sentry', on: true, blocked: null },
      { machine: 'mac-mini', checkout: '/src/arbor-off', target: 'sentry', on: true, blocked: 'toggled' },
      { machine: 'ci-01', checkout: '/home/ci/arbor', target: 'sentry', on: true, blocked: 'noDefinition' },
    ]);
    expect(mcpChanges([itemAt(changes, 3)])).toEqual([{ checkout: '/src/arbor', server: 'sentry', on: true }]);
  });

  it('won’t turn on a server a checked-in deny keeps out', () => {
    const values: Record<string, Record<string, RepoProjectValue>> = { linear: { 'casey/arbor': { all: 'on', machines: {} } } };
    const changes = projectMcpChanges(['linear'], values, [checkout('mac-mini', '/a', { mcpDenied: [{ name: 'linear', local: false }] })], 'casey/arbor',
      (name, server) => homeServer(machines, name, server), () => true);
    expect(changes.map((change) => change.blocked)).toEqual(['denied']);
  });
});

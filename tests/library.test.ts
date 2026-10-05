import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import { libraryCounts, libraryList, libraryRows, libraryScope, type LibraryRow } from '../src/services/library';
import { lineUp, relisted, togglePlugin, undoToggle } from '../src/services/libraryToggle';
import { withPluginRepo } from '../src/services/setupPluginRepo';
import { extensionsView, type PluginRow } from '../src/services/setupPlugins';
import { present } from './support/items';
import type { PluginChange, PluginResult, RepoPlugin, SetupHome, SetupItem, SetupMachine, SetupRepo } from '../src/native/types';

const item = (kind: SetupItem['kind'], name: string, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind, name, path: null, sum: null, size: null, link: null, value: null, note: null, count: null, enabled: null,
  text: false, skill: null, import: null, ...fields,
});
// A plugin installed (with a version) and on unless `enabled` is false.
const plugin = (id: string, enabled = true) => item('plugin', id, { value: '1.0.0', enabled });
const marketplace = (name: string) => item('marketplace', name, { note: 'acme/agent-tools', value: new Date(0).toISOString(), enabled: true });
const home = (agent: SetupHome['agent'], path: string, items: SetupItem[]): SetupHome => ({
  agent, path, items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null,
});
const machine = (name: string, items: SetupItem[], reachable = true): SetupMachine => ({
  machine: name, local: false, reachable, homes: [home('claude', '~/.claude', items)], harnessHomes: [], harnessInstalls: [], installs: [],
  policy: null, scannedAt: 1_000, error: null, scanning: false,
});
const listing = (id: string, all: RepoPlugin['all'], machines: RepoPlugin['machines'] = {}): RepoPlugin => ({ id, source: 'acme/agent-tools', all, machines, projects: {} });
const repo = (plugins: RepoPlugin[], fields: Partial<SetupRepo> = {}): SetupRepo => ({
  path: '/Users/casey/src/agent-setup', branch: 'main', head: { sha: 'ab'.repeat(32), subject: 'Start', atMs: 1_000 },
  upstream: null, uncommitted: [], files: [], skills: [], ignored: [], skillMachines: {}, removedSkills: [], removedFiles: [], fileMachines: {},
  skillProjects: {}, mcpProjects: {}, instructions: [], plugins, codexPlugins: [], ...fields,
});

const REVIEW = 'review@acme-tools';
// casey-mbp has the plugin on, ci-01 has it off, cedar-02 hasn't got it (but has its marketplace).
const fleet = () => [
  machine('casey-mbp', [plugin(REVIEW), marketplace('acme-tools')]),
  machine('ci-01', [plugin(REVIEW, false), marketplace('acme-tools')]),
  machine('cedar-02', [marketplace('acme-tools')]),
];

const rowsOf = (machines: SetupMachine[], setup: SetupRepo | null) =>
  libraryRows({ machines, view: withPluginRepo(extensionsView(machines), setup?.plugins ?? null), repo: setup, registryFound: false, hooks: null });
const rowFor = (rows: LibraryRow[], name: string) => present(rows.find((row) => row.name === name));
const pluginRow = (machines: SetupMachine[], setup: SetupRepo | null): PluginRow =>
  present(withPluginRepo(extensionsView(machines), setup?.plugins ?? null).plugins.find((row) => row.id === REVIEW));

// The commands are answered as the mock answers them, which wants a window to hang its answers on.
let originalWindow: PropertyDescriptor | undefined;
beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
});
afterEach(() => {
  clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('the Library’s rows', () => {
  it('sums a plugin up across machines: the repo’s word, where it’s on and which machines aren’t as the repo has it', () => {
    const row = rowFor(rowsOf(fleet(), repo([listing(REVIEW, 'on')])), 'review');
    expect(row).toMatchObject({ kind: 'plugins', detail: 'acme-tools', agents: ['claude'], state: 'on', on: ['casey-mbp'], exceptions: 0 });
    expect(row.fleet).toEqual(['casey-mbp', 'ci-01', 'cedar-02']);
    expect(row.behind).toEqual(['ci-01', 'cedar-02']);
    expect(libraryScope(row)).toEqual({ kind: 'all' });
    expect(row.toggle?.kind).toBe('plugin');
  });

  it('says a plugin the repo doesn’t list is left to the machines that have it', () => {
    const row = rowFor(rowsOf(fleet(), repo([])), 'review');
    expect(row.state).toBe('unlisted');
    expect(row.behind).toEqual([]);
    expect(libraryScope(row)).toEqual({ kind: 'unlisted', on: 1, of: 3 });
  });

  it('counts machines with a value of their own, so it isn’t on every machine', () => {
    const row = rowFor(rowsOf(fleet(), repo([listing(REVIEW, 'on', { ci01: 'off' })])), 'review');
    expect(row.exceptions).toBe(1);
    expect(row.behind).toEqual(['cedar-02']);
    expect(libraryScope(row)).toEqual({ kind: 'some', on: 1, of: 3 });
    expect(libraryScope(rowFor(rowsOf(fleet(), repo([listing(REVIEW, 'off')])), 'review'))).toEqual({ kind: 'off' });
  });

  it('keeps a removed plugin out of the list and out of the counts, under Removed', () => {
    const rows = rowsOf([machine('casey-mbp', [])], repo([listing(REVIEW, 'removed')]));
    expect(libraryCounts(rows).plugins).toBe(0);
    const list = libraryList(rows, { kind: 'plugins', agent: null, query: '' });
    expect(list.rows).toEqual([]);
    expect(list.removed.map((row) => row.name)).toEqual(['review']);
  });

  it('lists the repo’s instructions, rules and commands, but not hook scripts, which come with their hooks', () => {
    const file = (path: string, kind: SetupRepo['files'][number]['kind']) => ({ path, kind, sum: 'x', ck: 'y', size: 10 });
    const setup = repo([], {
      files: [file('~/.claude/CLAUDE.md', 'instructions'), file('~/.codex/AGENTS.md', 'instructions'), file('~/.agents/hooks/lint.sh', 'hookScript')],
      removedFiles: ['~/.claude/commands/old.md'],
      fileMachines: { '~/.claude/CLAUDE.md': { ci01: 'off' } },
    });
    const rows = rowsOf(fleet(), setup).filter((row) => row.kind === 'instructions');
    expect(rows.map((row) => [row.detail, row.state, row.agents])).toEqual([
      ['~/.claude/CLAUDE.md', 'on', ['claude']],
      ['~/.codex/AGENTS.md', 'on', ['codex']],
      ['~/.claude/commands/old.md', 'removed', ['claude']],
    ]);
    expect(present(rows[0]).on).toEqual(['casey-mbp', 'cedar-02']);
  });

  it('narrows a tab to an agent and a search, by name or what else names it', () => {
    const rows = rowsOf(fleet(), repo([listing(REVIEW, 'on')]));
    expect(libraryList(rows, { kind: 'plugins', agent: 'claude', query: 'acme' }).rows).toHaveLength(1);
    expect(libraryList(rows, { kind: 'plugins', agent: 'codex', query: '' }).rows).toHaveLength(0);
    expect(libraryList(rows, { kind: 'plugins', agent: null, query: 'nothing' }).rows).toHaveLength(0);
  });
});

describe('a plugin’s switch', () => {
  it('lines every machine up with the repo’s new word, adding nothing for one that doesn’t answer', () => {
    const machines = [...fleet(), machine('far-01', [], false)];
    const row = relisted(pluginRow(machines, null), listing(REVIEW, 'off'));
    expect(Object.fromEntries(lineUp(row, false))).toEqual({
      'casey-mbp': [{ machine: 'casey-mbp', home: '~/.claude', action: 'disable', target: REVIEW, source: null }],
    });
    const on = relisted(pluginRow(machines, null), listing(REVIEW, 'on'));
    expect(Object.fromEntries(lineUp(on, false))).toEqual({
      'ci-01': [{ machine: 'ci-01', home: '~/.claude', action: 'enable', target: REVIEW, source: null }],
      'cedar-02': [{ machine: 'cedar-02', home: '~/.claude', action: 'install', target: REVIEW, source: null }],
    });
  });

  it('adds the marketplace first where an install needs it and its repository is known', () => {
    const machines = [machine('casey-mbp', [plugin(REVIEW), marketplace('acme-tools')]), machine('ci-01', [])];
    const row = relisted(pluginRow(machines, null), listing(REVIEW, 'on'));
    expect(lineUp(row, false).get('ci-01')?.map((change) => change.action)).toEqual(['addMarketplace', 'install']);
  });

  it('commits the repo first, then changes each machine, and Undo puts both back as they were', async () => {
    const changed: { machine: string; changes: PluginChange[] }[] = [];
    let listed: RepoPlugin[] = [];
    const calls = mockCommands({
      set_setup_plugin: ({ wanted }) => {
        listed = wanted ? [listing(REVIEW, wanted)] : [];
        return repo(listed);
      },
      apply_plugin_changes: ({ machine: name, changes }) => {
        changed.push({ machine: name, changes });
        return changes.map((change): PluginResult => ({ ...change, checkout: null, outcome: name === 'cedar-02' ? 'needsYou' : 'done', message: '' }));
      },
    });
    const row = pluginRow(fleet(), null);
    const run = await togglePlugin('/repo', row, false, true);
    expect(calls.map((call) => call.command).filter((command) => command !== 'track_event')).toEqual(['set_setup_plugin', 'apply_plugin_changes', 'apply_plugin_changes']);
    expect(present(calls[0]).args).toMatchObject({ plugin: REVIEW, machine: null, wanted: 'on' });
    expect(run.before).toBeNull();
    expect(run.done.map((change) => [change.machine, change.action])).toEqual([['ci-01', 'enable']]);
    expect(run.needsYou.map((result) => result.machine)).toEqual(['cedar-02']);
    expect(run.repo.plugins).toEqual([listing(REVIEW, 'on')]);

    changed.length = 0;
    const undone = await undoToggle('/repo', row, false, run);
    // The repo didn't list it before, so Undo takes the listing out, and turns ci-01's back off.
    expect(undone.repo.plugins).toEqual([]);
    expect(changed).toEqual([{ machine: 'ci-01', changes: [{ home: '~/.claude', action: 'disable', target: REVIEW }] }]);
  });

  it('keeps a machine’s failure with the machine it was on', async () => {
    mockCommands({
      set_setup_plugin: () => repo([listing(REVIEW, 'off')]),
      apply_plugin_changes: () => Promise.reject('ssh: connect to host casey-mbp: Connection refused'),
    });
    const run = await togglePlugin('/repo', pluginRow(fleet(), null), false, false);
    expect(run.done).toEqual([]);
    expect(run.failed.map((result) => [result.machine, result.action, result.message])).toEqual([
      ['casey-mbp', 'disable', 'ssh: connect to host casey-mbp: Connection refused'],
    ]);
  });
});

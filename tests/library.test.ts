import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import { libraryCounts, libraryItemName, libraryKindProblems, libraryList, libraryRowProblems, libraryRows, libraryScope, type LibraryRow } from '../src/services/library';
import { addPlugin, behindHomes, bringInLine, inverseChanges, linePlans, marketplaceEverywhere, marketplaceHomes, takeIntoRepo, takeSources, updatePlugin, lineUp, relisted, removeEverywhere, switchFile, switchHook, switchMachine, switchServer, togglePlugin, undoToggle } from '../src/services/libraryToggle';
import { withRegistry } from '../src/services/setupMcp';
import { directoryEntries, directorySources } from '../src/services/directory';
import { withPluginRepo } from '../src/services/setupPluginRepo';
import { extensionsView, type PluginRow } from '../src/services/setupPlugins';
import { lastItem, present } from './support/items';
import type { HookRegistry, McpRegistry, PluginChange, PluginResult, RepoPlugin, ServerView, SetupHome, SetupItem, SetupMachine, SetupRepo, SyncStanding } from '../src/native/types';

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
  path: '/Users/cam/src/agent-setup', branch: 'main', head: { sha: 'ab'.repeat(32), subject: 'Start', atMs: 1_000 },
  upstream: null, uncommitted: [], files: [], skills: [], ignored: [], skillMachines: {}, removedSkills: [], removedFiles: [], offSkills: [], offFiles: [], fileMachines: {},
  skillProjects: {}, mcpProjects: {}, instructions: [], plugins, codexPlugins: [], layers: { machines: [], projects: [], problems: [] }, ...fields,
});

const REVIEW = 'review@acme-tools';
// cam-mbp has the plugin on, ci-01 has it off, cedar-02 hasn't got it (but has its marketplace).
const fleet = () => [
  machine('cam-mbp', [plugin(REVIEW), marketplace('acme-tools')]),
  machine('ci-01', [plugin(REVIEW, false), marketplace('acme-tools')]),
  machine('cedar-02', [marketplace('acme-tools')]),
];

/** Sync's standing as Rust would give it, saying only which machines are behind on which rows' keys. */
const standingWith = (behind: Record<string, string[]>): SyncStanding => ({
  repo: repo([]), mcp: null, mcpError: null, hooks: null, hooksError: null, inStep: 0, read: 0,
  machines: Object.entries(behind).map(([name, keys]) => ({
    machine: name, state: keys.length ? 'behind' : 'inStep', reachable: true,
    counts: { files: 0, skills: 0, mcp: 0, hooks: 0, plugins: 0, projects: 0 },
    behind: keys.map((key) => ({ kind: 'plugin', key, name: key, drift: 'update' })),
  })),
});
const REVIEW_KEY = 'plugin:claude:review@acme-tools';
const rowsOf = (machines: SetupMachine[], setup: SetupRepo | null, behind: Record<string, string[]> = {}) =>
  libraryRows({ machines, view: withPluginRepo(extensionsView(machines), setup?.plugins ?? null), repo: setup, registryFound: false, hooks: null, standing: standingWith(behind) });
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
  it('sums a plugin up across machines: the repo’s word, where it’s on, and the machines Sync’s standing has behind on it', () => {
    const row = rowFor(rowsOf(fleet(), repo([listing(REVIEW, 'on')]), { 'cam-mbp': [], 'ci-01': [REVIEW_KEY], 'cedar-02': [REVIEW_KEY] }), 'review');
    expect(row).toMatchObject({ kind: 'plugins', detail: 'acme-tools', agents: ['claude'], state: 'on', on: ['cam-mbp'], exceptions: 0 });
    expect(row.fleet).toEqual(['cam-mbp', 'ci-01', 'cedar-02']);
    expect(row.behind).toEqual(['ci-01', 'cedar-02']);
    expect(libraryScope(row)).toEqual({ kind: 'all' });
    expect(row.toggle?.kind).toBe('plugin');
  });

  it('says a plugin the repo doesn’t list is left to the machines that have it', () => {
    // What the repo doesn't list is never behind, whatever reaches the rows.
    const row = rowFor(rowsOf(fleet(), repo([]), { 'ci-01': [REVIEW_KEY] }), 'review');
    expect(row.state).toBe('unlisted');
    expect(row.behind).toEqual([]);
    expect(libraryScope(row)).toEqual({ kind: 'unlisted', on: 1, of: 3 });
  });

  it('counts machines with a value of their own, so it isn’t on every machine', () => {
    const row = rowFor(rowsOf(fleet(), repo([listing(REVIEW, 'on', { ci01: 'off' })]), { 'cedar-02': [REVIEW_KEY] }), 'review');
    expect(row.exceptions).toBe(1);
    expect(row.behind).toEqual(['cedar-02']);
    expect(libraryScope(row)).toEqual({ kind: 'some', on: 1, of: 3 });
    expect(libraryScope(rowFor(rowsOf(fleet(), repo([listing(REVIEW, 'off')])), 'review'))).toEqual({ kind: 'off' });
  });

  it('keeps a removed plugin out of the list and out of the counts, under Removed', () => {
    const rows = rowsOf([machine('cam-mbp', [])], repo([listing(REVIEW, 'removed')]));
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
    expect(present(rows[0]).on).toEqual(['cam-mbp', 'cedar-02']);
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
      'cam-mbp': [{ machine: 'cam-mbp', home: '~/.claude', action: 'disable', target: REVIEW, source: null }],
    });
    const on = relisted(pluginRow(machines, null), listing(REVIEW, 'on'));
    expect(Object.fromEntries(lineUp(on, false))).toEqual({
      'ci-01': [{ machine: 'ci-01', home: '~/.claude', action: 'enable', target: REVIEW, source: null }],
      'cedar-02': [{ machine: 'cedar-02', home: '~/.claude', action: 'install', target: REVIEW, source: null }],
    });
  });

  it('adds the marketplace first where an install needs it and its repository is known', () => {
    const machines = [machine('cam-mbp', [plugin(REVIEW), marketplace('acme-tools')]), machine('ci-01', [])];
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
      apply_plugin_changes: () => Promise.reject('ssh: connect to host cam-mbp: Connection refused'),
    });
    const run = await togglePlugin('/repo', pluginRow(fleet(), null), false, false);
    expect(run.done).toEqual([]);
    expect(run.failed.map((result) => [result.machine, result.action, result.message])).toEqual([
      ['cam-mbp', 'disable', 'ssh: connect to host cam-mbp: Connection refused'],
    ]);
  });
});

describe('every kind’s switch', () => {
  const definition = { transport: 'http', place: 'mcp.linear.app', variables: [] };
  const server = (fields: Partial<ServerView> = {}): ServerView => ({ name: 'linear', claude: definition, codex: null, homes: null, agents: [], own: [], off: [], allOff: false, problems: [], ...fields });
  const registry = (fields: Partial<McpRegistry> = {}): McpRegistry => ({ commit: 'c'.repeat(40), found: true, uncommitted: false, problems: [], servers: [server()], cells: [], ...fields });
  const withServer = (name: string) => machine('cam-mbp', [item('mcp', name, { value: 'http', sum: 'x1' })]);

  it('gives what the repo lists a switch and its off state, but never an agent’s instructions or what it only has on a machine', () => {
    const file = (path: string, kind: SetupRepo['files'][number]['kind']) => ({ path, kind, sum: 'x', ck: 'y', size: 10 });
    const setup = repo([], {
      files: [file('~/.claude/CLAUDE.md', 'instructions'), file('~/.claude/commands/ship.md', 'command')],
      offFiles: ['~/.claude/commands/ship.md'],
    });
    const rows = libraryRows({
      machines: [withServer('linear'), withServer('mine')],
      view: withRegistry(extensionsView([withServer('linear'), withServer('mine')]), registry({ servers: [server({ allOff: true })] })),
      repo: setup, registryFound: true, hooks: null, standing: null,
    });
    const by = (name: string) => rowFor(rows, name);
    expect([by('linear').state, by('linear').toggle]).toEqual(['off', { kind: 'mcp', name: 'linear' }]);
    expect([by('mine').state, by('mine').toggle]).toEqual(['unlisted', null]);
    expect([by('ship.md').state, by('ship.md').toggle]).toEqual(['off', { kind: 'file', path: '~/.claude/commands/ship.md' }]);
    expect([by('CLAUDE.md').state, by('CLAUDE.md').toggle]).toEqual(['on', null]);
  });

  it('turns a server off for every machine, takes it out of each one that answers, and Undo turns it back on', async () => {
    const wanted: unknown[] = [];
    const applied: { machine: string; actions: string[] }[] = [];
    mockCommands({
      set_mcp_wanted: ({ machine: name, wanted: value }) => {
        wanted.push([name, value]);
        const off = value === 'off';
        return registry({ servers: [server({ allOff: off })], cells: [{ machine: 'cam-mbp', home: '~/.claude', name: 'linear', state: off ? 'extra' : 'same', own: false, blocked: null }] });
      },
      apply_mcp_changes: ({ machine: name, changes }) => {
        applied.push({ machine: name, actions: changes.map((change) => change.action) });
        return changes.map((change) => ({ ...change, outcome: change.action === 'remove' ? 'removed' as const : 'done' as const, message: '' }));
      },
    });
    const machines = [withServer('linear'), machine('far-01', [item('mcp', 'linear', { value: 'http', sum: 'x1' })], false)];
    const run = await switchServer('/repo', machines, 'linear', false);
    expect(wanted).toEqual([[null, 'off']]);
    expect(applied).toEqual([{ machine: 'cam-mbp', actions: ['remove'] }]);
    expect(run.changed).toEqual(['cam-mbp']);
    expect(run.skipped).toEqual(['far-01']);
    const back = await run.undo();
    expect(wanted).toEqual([[null, 'off'], [null, 'default']]);
    expect(back.registry?.servers[0]?.allOff).toBe(false);
  });

  it('turns a command off for every machine, takes each answering machine’s copy out, and Undo puts the copies back first', async () => {
    const calls: unknown[] = [];
    const command = { path: '~/.claude/commands/ship.md', kind: 'command' as const, sum: 's1', ck: 'c1-10', size: 10 };
    mockCommands({
      set_setup_file_off: ({ path, off }) => {
        calls.push(['off', path, off]);
        return repo([], { files: [command], offFiles: off ? [path] : [] });
      },
      apply_setup_sync: ({ machine: name, changes }) => {
        calls.push(['apply', name, changes]);
        return { backup: 'b1', done: changes.map((change) => change.path), failed: [] };
      },
      undo_setup_sync: ({ machine: name, backup }) => {
        calls.push(['undo', name, backup]);
        return { backup: null, done: [command.path], failed: [] };
      },
    });
    const machines = [machine('cam-mbp', [item('command', 'ship.md', { path: command.path, sum: 's1' })])];
    const run = await switchFile('/repo', machines, command.path, false);
    expect(run.changed).toEqual(['cam-mbp']);
    await run.undo();
    expect(calls).toEqual([
      ['off', command.path, true],
      ['apply', 'cam-mbp', [{ path: command.path, remove: true, before: 's1' }]],
      ['undo', 'cam-mbp', 'b1'],
      ['off', command.path, false],
    ]);
  });
});

describe('an item’s own page', () => {
  it('names an item from its key before it’s read', () => {
    expect(libraryItemName('plugin:claude:review@acme-tools')).toBe('review');
    expect(libraryItemName('mcp:linear')).toBe('linear');
    expect(libraryItemName('skill:pdf')).toBe('pdf');
    expect(libraryItemName('hook:repo:guard')).toBe('guard');
    expect(libraryItemName('hook:extra:SessionStart\u0000old.sh')).toBe('old.sh');
    expect(libraryItemName('file:~/.claude/commands/ship.md')).toBe('ship.md');
  });

  it('says for each machine what the repo wants there, its own value, and which homes have it', () => {
    const row = rowFor(rowsOf(fleet(), repo([listing(REVIEW, 'on', { ci01: 'off' })]), { 'cedar-02': [REVIEW_KEY] }), 'review');
    expect(row.places).toEqual({
      'cam-mbp': { own: null, wanted: true, homes: ['~/.claude'] },
      'ci-01': { own: 'off', wanted: false, homes: ['~/.claude'] },
      'cedar-02': { own: null, wanted: true, homes: [] },
    });
  });

  it('turns a plugin on for one machine as a value of its own, changes only that machine, and Undo takes the value out', async () => {
    const set: unknown[] = [];
    const applied: string[] = [];
    mockCommands({
      set_setup_plugin: ({ machine: name, wanted }) => {
        set.push([name, wanted]);
        return repo([listing(REVIEW, 'on', wanted ? { ci01: wanted } : {})]);
      },
      apply_plugin_changes: ({ machine: name, changes }) => {
        applied.push(name);
        return changes.map((change): PluginResult => ({ ...change, checkout: null, outcome: 'done', message: '' }));
      },
    });
    const machines = fleet();
    const row = pluginRow(machines, repo([listing(REVIEW, 'on', { ci01: 'off' })]));
    const run = await switchMachine('/repo', machines, { kind: 'plugin', codex: false, row }, 'ci-01', true);
    // On is every machine's value already, so the machine's own goes rather than repeating it.
    expect(set).toEqual([['ci-01', null]]);
    expect(applied).toEqual(['ci-01']);
    expect(run.changed).toEqual(['ci-01']);
    await run.undo();
    expect(set).toEqual([['ci-01', null], ['ci-01', 'off']]);
  });

  it('removes a server from every machine and Undo puts the repo’s last definition back', async () => {
    const calls: string[] = [];
    const definition = { transport: 'http', place: 'mcp.linear.app', variables: [] };
    const server = (removed: boolean): ServerView => ({ name: 'linear', claude: removed ? null : definition, codex: null, homes: null, agents: [], own: [], off: [], allOff: false, problems: [] });
    const answer = (removed: boolean): McpRegistry => ({
      commit: 'c'.repeat(40), found: true, uncommitted: false, problems: [], servers: [server(removed)],
      cells: [{ machine: 'cam-mbp', home: '~/.claude', name: 'linear', state: removed ? 'extra' : 'same', own: false, blocked: null }],
    });
    mockCommands({
      set_mcp_wanted: ({ wanted }) => { calls.push(`set ${wanted}`); return answer(true); },
      put_back_mcp_server: () => { calls.push('put back'); return answer(false); },
      apply_mcp_changes: ({ changes }) => {
        calls.push(`apply ${changes.map((change) => change.action).join(',')}`);
        return changes.map((change) => ({ ...change, outcome: 'removed' as const, message: '' }));
      },
    });
    const machines = [machine('cam-mbp', [item('mcp', 'linear', { value: 'http', sum: 'x1' })])];
    const run = await removeEverywhere('/repo', machines, { kind: 'mcp', name: 'linear' });
    expect(run.changed).toEqual(['cam-mbp']);
    await run.undo();
    expect(calls).toEqual(['set removed', 'apply remove', 'put back']);
  });
});

describe('Undo puts each machine back as it was', () => {
  const guard = { name: 'guard', event: 'PreToolUse', matcher: null, command: '~/.agents/hooks/guard.sh', script: 'guard.sh', timeout: null, agents: ['claude' as const], homes: null, removed: false, allOff: false, off: [] as string[], problems: [] };
  const hooksAt = (state: 'extra' | 'same', off: string[] = []): HookRegistry => ({
    commit: 'h'.repeat(40), found: true, uncommitted: false, problems: [], hooks: [{ ...guard, off }],
    cells: [{ machine: 'ci-01', agent: 'claude', home: '~/.claude', name: 'guard', event: 'PreToolUse', script: 'guard.sh', state, blocked: null }],
  });

  it('restores a hook switch from each machine’s backup rather than applying the repo’s word again', async () => {
    const calls: string[] = [];
    mockCommands({
      set_hook_wanted: ({ machine: name, wanted }) => { calls.push(`set ${name} ${wanted}`); return hooksAt(wanted === 'off' ? 'extra' : 'same', wanted === 'off' ? ['ci-01'] : []); },
      apply_hooks: ({ machine: name }) => {
        calls.push(`apply ${name}`);
        return [
          { home: '~/.claude', path: '~/.claude/settings.json', change: 'edit', written: true, error: null, backup: 'b-claude' },
          { home: '~/.agent-app/claude', path: '~/.agent-app/claude/settings.json', change: 'edit', written: true, error: null, backup: 'b-claude' },
        ];
      },
      undo_setup_sync: ({ machine: name, backup }) => { calls.push(`undo ${name} ${backup}`); return { backup: null, done: ['~/.claude/settings.json'], failed: [] }; },
    });
    const machines = [machine('ci-01', [])];
    const run = await switchMachine('/repo', machines, { kind: 'hook', name: 'guard' }, 'ci-01', false);
    expect(run.changed).toEqual(['ci-01']);
    const back = await run.undo();
    expect(back.failed).toEqual([]);
    // One backup for the file the two homes share, put back once; nothing is applied again.
    expect(calls).toEqual(['set ci-01 off', 'apply ci-01', 'undo ci-01 b-claude', 'set ci-01 default']);
  });

  it('says which machine refused to be put back, and why, for every kind of hook switch', async () => {
    mockCommands({
      set_hook_wanted: ({ wanted }) => hooksAt(wanted === 'default' ? 'same' : 'extra'),
      apply_hooks: () => [{ home: '~/.claude', path: '~/.claude/settings.json', change: 'edit', written: true, error: null, backup: 'b1' }],
      undo_setup_sync: () => ({ backup: null, done: [], failed: [{ path: '~/.claude/settings.json', reason: 'changed' }] }),
    });
    const machines = [machine('ci-01', [])];
    for (const run of [await switchHook('/repo', machines, 'guard', false), await removeEverywhere('/repo', machines, { kind: 'hook', name: 'guard' })]) {
      const back = await run.undo();
      expect(back.failed).toEqual([{ machine: 'ci-01', message: 'changed', reason: 'changed', paths: ['~/.claude/settings.json'] }]);
    }
  });

  it('takes back only the plugin changes a removal made, a plugin that was off going back in off', async () => {
    const applied: { machine: string; actions: string[] }[] = [];
    mockCommands({
      set_setup_plugin: ({ wanted }) => repo(wanted ? [listing(REVIEW, wanted)] : []),
      apply_plugin_changes: ({ machine: name, changes }) => {
        applied.push({ machine: name, actions: changes.map((change) => change.action) });
        return changes.map((change): PluginResult => ({ ...change, checkout: null, outcome: 'done', message: '' }));
      },
    });
    const machines = fleet();
    const row = pluginRow(machines, repo([listing(REVIEW, 'on', { ci01: 'off' })]));
    const run = await removeEverywhere('/repo', machines, { kind: 'plugin', codex: false, row });
    expect(applied).toEqual([{ machine: 'cam-mbp', actions: ['uninstall'] }, { machine: 'ci-01', actions: ['uninstall'] }]);
    applied.length = 0;
    await run.undo();
    // cedar-02 never had it, so Undo leaves it alone rather than installing it there.
    expect(applied).toEqual([{ machine: 'ci-01', actions: ['install', 'disable'] }, { machine: 'cam-mbp', actions: ['install'] }]);
  });

  it('turns each change around, the last first, leaving a marketplace it added', () => {
    const change = (machine: string, action: 'install' | 'uninstall' | 'addMarketplace' | 'enable', wasOff = false) =>
      ({ machine, home: '~/.claude', action, target: REVIEW, source: null, ...(wasOff ? { wasOff } : {}) });
    expect(Object.fromEntries(inverseChanges([change('ci-01', 'addMarketplace'), change('ci-01', 'install'), change('cam-mbp', 'uninstall', true), change('cam-mbp', 'enable')]))).toEqual({
      'cam-mbp': [
        { machine: 'cam-mbp', home: '~/.claude', action: 'disable', target: REVIEW, source: null },
        { machine: 'cam-mbp', home: '~/.claude', action: 'install', target: REVIEW, source: null },
        { machine: 'cam-mbp', home: '~/.claude', action: 'disable', target: REVIEW, source: null },
      ],
      'ci-01': [{ machine: 'ci-01', home: '~/.claude', action: 'uninstall', target: REVIEW, source: null }],
    });
  });
});

describe('bringing a machine in line', () => {
  const hookView = { name: 'guard', event: 'PreToolUse', matcher: null, command: '~/.agents/hooks/guard.sh', script: 'guard.sh', timeout: null, agents: ['claude' as const], homes: null, removed: false, allOff: false, off: [], problems: [] };
  const hooks = (state: 'add' | 'same'): HookRegistry => ({
    commit: 'h'.repeat(40), found: true, uncommitted: false, problems: [], hooks: [hookView],
    cells: [{ machine: 'cam-mbp', agent: 'claude', home: '~/.claude', name: 'guard', event: 'PreToolUse', script: 'guard.sh', state, blocked: null }],
  });

  it('plans each answering machine’s rows that the repo lists and that are behind there', () => {
    const rows = rowsOf([...fleet(), machine('far-01', [], false)], repo([listing(REVIEW, 'on')]), { 'ci-01': [REVIEW_KEY], 'cedar-02': [REVIEW_KEY], 'far-01': [REVIEW_KEY] });
    expect(linePlans(rows, [...fleet(), machine('far-01', [], false)]).map((plan) => [plan.machine, plan.rows.map((row) => row.name)])).toEqual([
      ['ci-01', ['review']],
      ['cedar-02', ['review']],
    ]);
    // What the repo doesn't list is each machine's own, so it's never brought in line.
    expect(linePlans(rowsOf(fleet(), repo([]), { 'ci-01': [REVIEW_KEY] }), fleet())).toEqual([]);
  });

  it('writes the hooks’ scripts before the hooks, since a hook runs one', async () => {
    const calls: string[] = [];
    const script = { path: '~/.agents/hooks/guard.sh', kind: 'hookScript' as const, sum: 's1', ck: 'c1-10', size: 10 };
    const setup = repo([], { files: [script] });
    mockCommands({
      apply_setup_sync: ({ changes }) => { calls.push(`sync ${changes.map((change) => change.path).join(',')}`); return { backup: 'b1', done: changes.map((change) => change.path), failed: [] }; },
      apply_hooks: () => { calls.push('hooks'); return [{ home: '~/.claude', path: '~/.claude/settings.json', change: 'edit', written: true, error: null, backup: 'h1' }]; },
    });
    const machines = [machine('cam-mbp', [])];
    const row = { ...rowFor(libraryRows({ machines, view: extensionsView(machines), repo: setup, registryFound: false, hooks: hooks('add'), standing: null }), 'guard') };
    const done = await bringInLine('/repo', { repo: setup, registry: null, hooks: hooks('add') }, machines, { machine: 'cam-mbp', rows: [row] });
    expect(calls).toEqual(['sync ~/.agents/hooks/guard.sh', 'hooks']);
    expect(done).toEqual({ changed: true, failed: [], needsYou: false });
  });

  it('says what’s wrong with the hooks file and a hook in it, rather than an empty list or a hook in step', () => {
    const machines = [machine('cam-mbp', [])];
    const unreadable: HookRegistry = { ...hooks('same'), problems: ['.agents/hooks.json isn’t a JSON object Arbor can read'], hooks: [], cells: [] };
    expect(libraryKindProblems(unreadable, 'hooks')).toEqual(['.agents/hooks.json isn’t a JSON object Arbor can read']);
    expect(libraryKindProblems(unreadable, 'mcps')).toEqual([]);
    expect(libraryKindProblems(null, 'hooks')).toEqual([]);

    const broken: HookRegistry = { ...hooks('same'), hooks: [{ ...hookView, problems: ['timeout should be seconds, from 1 to 3600'] }] };
    const row = rowFor(libraryRows({ machines, view: extensionsView(machines), repo: repo([]), registryFound: false, hooks: broken, standing: null }), 'guard');
    expect(libraryRowProblems(broken, row)).toEqual(['timeout should be seconds, from 1 to 3600']);
    expect(libraryRowProblems(hooks('same'), row)).toEqual([]);
  });
});

describe('the directory', () => {
  const entry = (name: string, description: string, category: string, version: string | null = null) =>
    ({ name, displayName: null, description, version, category, signsIn: false, installable: true });
  const catalog = { source: 'acme/agent-tools', name: 'acme-tools', displayName: null, readAtMs: 0, plugins: [
    entry('oncall', 'Page summaries', 'operations'),
    entry('review', 'Review a diff', 'development', '1.0.0'),
  ] };

  it('lists the marketplaces in use, then the official ones not in use, then the ones typed in, once each', () => {
    const machines = fleet();
    const sources = directorySources(extensionsView(machines), repo([listing(REVIEW, 'on')]), [{ source: 'acme/agent-tools', agent: 'claude' }, { source: 'not a repo', agent: 'claude' }, { source: 'other/tools', agent: 'codex' }]);
    expect(sources).toEqual([
      { source: 'acme/agent-tools', agent: 'claude', added: true, suggested: false },
      { source: 'anthropics/claude-plugins-official', agent: 'claude', added: false, suggested: true },
      { source: 'openai/plugins', agent: 'codex', added: false, suggested: true },
      { source: 'other/tools', agent: 'codex', added: false, suggested: false },
    ]);
  });

  it('says how the Library has each plugin, and narrows them to a search', () => {
    const rows = rowsOf(fleet(), repo([listing(REVIEW, 'off')]));
    const entries = directoryEntries(catalog, 'claude', rows);
    expect(entries.map((entry) => [entry.id, entry.standing])).toEqual([['oncall@acme-tools', null], [REVIEW, 'off']]);
    expect(directoryEntries(catalog, 'codex', rows).every((entry) => entry.standing === null)).toBe(true);
    expect(directoryEntries(catalog, 'claude', rows, 'operations').map((entry) => entry.name)).toEqual(['oncall']);
  });

  it('adds a plugin on for every machine with its marketplace, installs it where it isn’t, and Undo takes it all back', async () => {
    const set: unknown[] = [];
    const applied: { machine: string; actions: string[] }[] = [];
    mockCommands({
      set_setup_plugin: ({ plugin, source, wanted }) => { set.push([plugin, source, wanted]); return repo(wanted ? [listing(plugin, wanted)] : []); },
      apply_plugin_changes: ({ machine: name, changes }) => {
        applied.push({ machine: name, actions: changes.map((change) => change.action) });
        return changes.map((change): PluginResult => ({ ...change, checkout: null, outcome: 'done', message: '' }));
      },
    });
    const machines = [machine('cam-mbp', [marketplace('acme-tools')]), machine('ci-01', [])];
    const run = await addPlugin('/repo', machines, 'oncall@acme-tools', 'acme/agent-tools', false);
    expect(set).toEqual([['oncall@acme-tools', 'acme/agent-tools', 'on']]);
    expect(applied).toEqual([
      { machine: 'cam-mbp', actions: ['install'] },
      { machine: 'ci-01', actions: ['addMarketplace', 'install'] },
    ]);
    expect(run.changed).toEqual(['cam-mbp', 'ci-01']);
    applied.length = 0;
    await run.undo();
    expect(lastItem(set)).toEqual(['oncall@acme-tools', 'acme/agent-tools', null]);
    expect(applied).toEqual([{ machine: 'ci-01', actions: ['uninstall'] }, { machine: 'cam-mbp', actions: ['uninstall'] }]);
  });
});

describe('taking a machine’s own into the repo', () => {
  it('offers the answering machines that have it, and takes a server or hook from the copy picked', async () => {
    const calls: unknown[] = [];
    const empty = { commit: 'c'.repeat(40), found: true, uncommitted: false, problems: [], cells: [] };
    mockCommands({
      take_mcp_server: (args) => { calls.push(['mcp', args.machine, args.home, args.name, args.own]); return { ...empty, servers: [] }; },
      take_hook: (args) => { calls.push(['hook', args.machine, args.home, args.event, args.script]); return { ...empty, hooks: [] }; },
    });
    const machines = [machine('cam-mbp', []), machine('far-01', [], false)];
    const place = { own: null, wanted: false, homes: ['~/.claude'] };
    const row = (kind: LibraryRow['kind'], key: string, name: string): LibraryRow => ({
      key, kind, name, detail: null, agents: ['claude'], state: 'unlisted', on: ['cam-mbp', 'far-01'], fleet: ['cam-mbp', 'far-01'], behind: [], exceptions: 0,
      places: { 'cam-mbp': place, 'far-01': place }, toggle: null,
    });
    const server = row('mcps', 'mcp:mine', 'mine');
    expect(takeSources(server, machines)).toEqual([{ machine: 'cam-mbp', homes: ['~/.claude'] }]);
    expect(takeSources({ ...server, state: 'on' }, machines)).toEqual([]);
    expect((await takeIntoRepo('/repo', machines, server, { machine: 'cam-mbp', home: '~/.claude' })).undo).toBeNull();
    await takeIntoRepo('/repo', machines, row('hooks', 'hook:extra:SessionStart\u0000old.sh', 'old.sh'), { machine: 'cam-mbp', home: '~/.claude' });
    expect(calls).toEqual([['mcp', 'cam-mbp', '~/.claude', 'mine', false], ['hook', 'cam-mbp', '~/.claude', 'SessionStart', 'old.sh']]);
  });
});

describe('bringing an agent’s instructions in line', () => {
  it('plans and writes CLAUDE.md where it’s behind, though it has no switch', async () => {
    const claude = { path: '~/.claude/CLAUDE.md', kind: 'instructions' as const, sum: 'new', ck: 'c1-10', size: 10 };
    const setup = repo([], { files: [claude] });
    const machines = [machine('cam-mbp', [item('instructions', 'CLAUDE.md', { path: claude.path, sum: 'old' })])];
    const rows = libraryRows({ machines, view: extensionsView(machines), repo: setup, registryFound: false, hooks: null, standing: standingWith({ 'cam-mbp': [`file:${claude.path}`] }) });
    const plans = linePlans(rows, machines);
    expect(plans.map((plan) => [plan.machine, plan.rows.map((row) => row.name)])).toEqual([['cam-mbp', ['CLAUDE.md']]]);
    const synced: unknown[] = [];
    mockCommands({ apply_setup_sync: ({ changes }) => { synced.push(changes); return { backup: 'b', done: changes.map((change) => change.path), failed: [] }; } });
    const done = await bringInLine('/repo', { repo: setup, registry: null, hooks: null }, machines, present(plans[0]));
    expect(synced).toEqual([[{ path: claude.path, remove: false, before: 'old' }]]);
    expect(done.changed).toBe(true);
  });
});

describe('everyday per-home changes from the new pages', () => {
  const applied = (calls: { machine: string; changes: PluginChange[] }[]) => calls.map(({ machine: name, changes }) => [name, changes.map((change) => `${change.action} ${change.target}`)]);
  const answering = (calls: { machine: string; changes: PluginChange[] }[]) => mockCommands({
    apply_plugin_changes: ({ machine: name, changes }) => {
      calls.push({ machine: name, changes });
      return changes.map((change): PluginResult => ({ ...change, checkout: null, outcome: 'done', message: '' }));
    },
  });

  it('updates a plugin only in the homes with an older version', async () => {
    const calls: { machine: string; changes: PluginChange[] }[] = [];
    answering(calls);
    const machines = [machine('cam-mbp', [plugin(REVIEW)]), machine('ci-01', [item('plugin', REVIEW, { value: '0.9.0', enabled: true })])];
    const row = pluginRow(machines, null);
    expect(behindHomes(row).map((cell) => cell.home.machine)).toEqual(['ci-01']);
    const run = await updatePlugin(row);
    expect(applied(calls)).toEqual([['ci-01', [`update ${REVIEW}`]]]);
    expect(run.changed).toEqual(['ci-01']);
  });

  it('refreshes a marketplace in every home that has it, and removes it only once nothing from it is installed', async () => {
    const calls: { machine: string; changes: PluginChange[] }[] = [];
    answering(calls);
    const inUse = fleet();
    expect(marketplaceHomes(extensionsView(inUse), 'acme-tools').inUse).toBe(true);
    await marketplaceEverywhere(extensionsView(inUse), 'acme-tools', 'refresh');
    expect(applied(calls)).toEqual([['cam-mbp', ['refresh acme-tools']], ['ci-01', ['refresh acme-tools']], ['cedar-02', ['refresh acme-tools']]]);
    await expect(marketplaceEverywhere(extensionsView(inUse), 'acme-tools', 'removeMarketplace')).rejects.toThrow();
    calls.length = 0;
    const unused = [machine('cam-mbp', [marketplace('acme-tools')])];
    expect(marketplaceHomes(extensionsView(unused), 'acme-tools').inUse).toBe(false);
    await marketplaceEverywhere(extensionsView(unused), 'acme-tools', 'removeMarketplace');
    expect(applied(calls)).toEqual([['cam-mbp', ['removeMarketplace acme-tools']]]);
  });
});

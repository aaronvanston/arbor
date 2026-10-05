import { describe, expect, it } from 'bun:test';
import { checkoutsStanding, projectCheckouts, readyByMachine } from '../src/services/projectCheckouts';
import { loadsIn, pluginChanges, projectChanges, projectWanted, type HomePlugin } from '../src/services/setupPluginProjects';
import type { MachineProjects, ProjectRepo, ProjectWorktree, RepoPlugin } from '../src/native/types';

const worktree = (path: string, fields: Partial<ProjectWorktree> = {}): ProjectWorktree => ({
  path, main: false, head: 'abc', branch: 'feature', locked: false, prunable: false, changed: 0, untracked: 0,
  upstream: null, ahead: 0, behind: 0, gone: false, merged: false, committedAt: null, touchedAt: null,
  open: false, hidden: 0, nested: false, midway: false, unreachable: 0, lastUsedMs: null, ignored: [], ignoredMore: 0, sizeKb: null, blocker: null, plugins: [], skills: [], ignoredOverrides: [], localSeen: false, mcpDenied: [], mcpLocal: [], mcpDisabled: [], instructions: [], agentsMd: null, claudeMd: false, ...fields,
});
const repo = (path: string, remote: string | null, worktrees: ProjectWorktree[], fields: Partial<ProjectRepo> = {}): ProjectRepo => ({
  path, state: 'ok', bare: false, remote, defaultBranch: 'origin/main', fetchedAt: null, fetchFailed: false, lastUsedMs: null, worktrees, files: [], ...fields,
});
const scan = (machine: string, repos: ProjectRepo[]): MachineProjects => ({
  machine, homeDir: '/home/cam', scannedAt: 1, partial: false, fetchedAt: null, measuredAt: null, scanning: false, measuring: false, removing: false, error: null, repos,
});

const scans = [
  scan('mac-mini', [
    repo('/Users/cam/src/arbor', 'github.com/Cam/arbor.git', [
      worktree('/Users/cam/src/arbor', { main: true, plugins: [{ id: 'context7@official', on: false, local: true }] }),
      worktree('/Users/cam/.agent-app/worktrees/arbor/fix'),
      worktree('/gone', { prunable: true }),
    ]),
    repo('/Users/cam/src/other', 'github.com/acme/other', [worktree('/Users/cam/src/other', { main: true })]),
  ]),
  scan('ci-01', [
    repo('/home/ci/arbor', 'github.com/cam/arbor', [worktree('/home/ci/arbor', { main: true, plugins: [{ id: 'superpowers@m', on: false, local: false }] })]),
    repo('/home/ci/old', 'github.com/cam/arbor', [], { state: 'missing' }),
  ]),
];

const plugins: RepoPlugin[] = [
  { id: 'context7@official', source: null, all: 'on', machines: {}, projects: { 'cam/arbor': { all: 'off', machines: {} } } },
  { id: 'superpowers@m', source: null, all: 'on', machines: {}, projects: { 'cam/arbor': { all: null, machines: { ci01: 'on' } } } },
  { id: 'lint@official', source: null, all: 'on', machines: {}, projects: {} },
];

// context7 installed and on everywhere; superpowers installed on ci-01 only.
const home = (machine: string, plugin: string): HomePlugin =>
  plugin === 'superpowers@m' ? { installed: machine === 'ci-01', on: machine === 'ci-01' } : { installed: true, on: true };

describe('a project’s plugins', () => {
  it('finds each checkout of a project by its remote, on every machine, leaving out ones gone', () => {
    expect(projectCheckouts(scans, 'cam/arbor').map((checkout) => `${checkout.machine}:${checkout.path}`)).toEqual([
      'mac-mini:/Users/cam/src/arbor',
      'mac-mini:/Users/cam/.agent-app/worktrees/arbor/fix',
      'ci-01:/home/ci/arbor',
    ]);
  });

  it('takes the project’s value on a machine, else on every machine, else follows the machine', () => {
    expect(projectWanted(plugins[0]!, 'Cam/Arbor', 'ci-01')).toEqual({ value: 'off', own: false });
    expect(projectWanted(plugins[1]!, 'cam/arbor', 'CI 01')).toEqual({ value: 'on', own: true });
    expect(projectWanted(plugins[1]!, 'cam/arbor', 'mac-mini')).toBeNull();
    expect(projectWanted(plugins[2]!, 'cam/arbor', 'mac-mini')).toBeNull();
  });

  it('reads a checkout as Claude Code does: local, then checked in, then the home; never on when not installed', () => {
    const [main, fix, ci] = projectCheckouts(scans, 'cam/arbor');
    expect(loadsIn(main!, 'context7@official', { installed: true, on: true })).toEqual({ on: false, from: 'local' });
    expect(loadsIn(fix!, 'context7@official', { installed: true, on: true })).toEqual({ on: true, from: 'home' });
    expect(loadsIn(ci!, 'superpowers@m', { installed: true, on: true })).toEqual({ on: false, from: 'shared' });
    expect(loadsIn(fix!, 'superpowers@m', { installed: false, on: true }).on).toBe(false);
  });

  it('lists the changes that bring each checkout in step, and says which can’t work', () => {
    const checkouts = projectCheckouts(scans, 'cam/arbor');
    const changes = projectChanges(plugins, checkouts, 'cam/arbor', home);
    expect(changes).toEqual([
      // The main checkout already keeps context7 off; the worktree and ci-01 don't.
      { machine: 'mac-mini', checkout: '/Users/cam/.agent-app/worktrees/arbor/fix', target: 'context7@official', on: false, blocked: null },
      { machine: 'ci-01', checkout: '/home/ci/arbor', target: 'context7@official', on: false, blocked: null },
      // The checked-in settings turn superpowers off on ci-01; the local value wins over them.
      { machine: 'ci-01', checkout: '/home/ci/arbor', target: 'superpowers@m', on: true, blocked: null },
    ]);
    expect(checkoutsStanding(changes, checkouts, 'mac-mini', 'context7@official')).toEqual({ total: 2, behind: 1, blocked: null });
    const byMachine = readyByMachine([...changes, { machine: 'mac-mini', checkout: '/x', target: 'ghost@m', on: true, blocked: 'notInstalled' }]);
    expect(pluginChanges(byMachine.get('mac-mini') ?? [])).toEqual([{ home: '~/.claude', action: 'disable', target: 'context7@official', checkout: '/Users/cam/.agent-app/worktrees/arbor/fix' }]);
    expect(byMachine.get('ci-01')?.length).toBe(2);
  });
});

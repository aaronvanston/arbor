import { describe, expect, it } from 'bun:test';
import {
  branchFate,
  buildProjects,
  canClean,
  chosenWorktrees,
  looksSecret,
  machineTotals,
  matchesProject,
  needsLook,
  needsScan,
  ownSizeKb,
  placeSummary,
  projectKey,
  projectName,
  PROJECTS_FRESH_MS,
  removalCounts,
  removalPlan,
  tilde,
  worktreeOwner,
} from '../src/services/setupProjects';
import { itemAt, present } from './support/items';
import type { MachineProjects, ProjectRepo, ProjectWorktree } from '../src/native/types';

const NOW = Date.parse('2026-09-25T12:00:00Z');

const worktree = (path: string, fields: Partial<ProjectWorktree> = {}): ProjectWorktree => ({
  path, main: false, head: 'abc', branch: 'feature', locked: false, prunable: false, changed: 0, untracked: 0,
  upstream: 'origin/feature', ahead: 0, behind: 0, gone: false, merged: false, committedAt: null, touchedAt: null,
  open: false, hidden: 0, nested: false, midway: false, unreachable: 0, lastUsedMs: null, ignored: [], ignoredMore: 0, sizeKb: null, blocker: 'notMerged', plugins: [], skills: [], ignoredOverrides: [], localSeen: false, mcpDenied: [], mcpLocal: [], mcpDisabled: [], instructions: [], agentsMd: null, claudeMd: false, ...fields,
});
const main = (path: string, fields: Partial<ProjectWorktree> = {}) => worktree(path, { main: true, branch: 'main', blocker: 'main', ...fields });
const repo = (path: string, remote: string | null, worktrees: ProjectWorktree[], fields: Partial<ProjectRepo> = {}): ProjectRepo => ({
  path, state: 'ok', bare: false, remote, defaultBranch: 'origin/main', fetchedAt: null, fetchFailed: false, lastUsedMs: null,
  worktrees, files: [], ...fields,
});
const machine = (name: string, homeDir: string, repos: ProjectRepo[], fields: Partial<MachineProjects> = {}): MachineProjects => ({
  machine: name, homeDir, scannedAt: NOW, partial: false, fetchedAt: null, measuredAt: null, scanning: false, measuring: false,
  removing: false, error: null, repos, ...fields,
});

const agents = (sum: string) => ({ name: 'AGENTS.md', sum, size: 100 });
const claude = (sum: string) => ({ name: '.claude/CLAUDE.md', sum, size: 200 });

const fleet = [
  machine('mbp', '/Users/casey', [
    repo('/Users/casey/src/arbor', 'github.com/casey/arbor', [
      main('/Users/casey/src/arbor', { sizeKb: 900, behind: 2 }),
      worktree('/Users/casey/src/arbor/.claude/worktrees/fox', { merged: true, blocker: null, sizeKb: 300, ignored: ['.env.local', 'node_modules/'] }),
      worktree('/Users/casey/.agent-app/worktrees/arbor/login', { gone: true, blocker: null, sizeKb: 200 }),
      worktree('/Users/casey/.agent-app/worktrees/arbor/wip', { untracked: 2, blocker: 'dirty' }),
    ], { lastUsedMs: NOW - 1_000, files: [claude('a'), agents('x')] }),
    repo('/Users/casey/src/notes', null, [main('/Users/casey/src/notes')], { lastUsedMs: NOW - 50_000, files: [agents('n')] }),
  ]),
  machine('ci', '/home/ci', [
    repo('/home/ci/src/arbor', 'github.com/casey/arbor', [main('/home/ci/src/arbor')], { lastUsedMs: NOW - 5_000, files: [claude('b'), agents('x')] }),
    repo('/home/ci/src/notes', null, [main('/home/ci/src/notes')], { lastUsedMs: NOW - 90_000 }),
  ]),
  machine('cedar', '/home/casey', [
    repo('/home/casey/src/arbor', 'github.com/casey/arbor', [main('/home/casey/src/arbor')], { files: [claude('a')] }),
  ]),
];

describe('projects across machines', () => {
  it('groups copies of a repo by its remote, and keeps a repo without one to its machine', () => {
    const rows = buildProjects(fleet);
    expect(rows.map((row) => row.name)).toEqual(['arbor', 'notes', 'notes']);
    const arbor = itemAt(rows, 0);
    expect(arbor.note).toBe('github.com/casey');
    expect(Object.keys(arbor.places)).toEqual(['mbp', 'ci', 'cedar']);
    expect(arbor.lastUsedMs).toBe(NOW - 1_000);
    expect(itemAt(rows, 1).note).toBe('~/src');
    expect(projectKey('mbp', repo('/x', '/srv/git/x', []))).toBe('path:mbp\u0000/x');
    expect(projectName(repo('/srv/git/tools.git', null, []), '/home/ci')).toEqual({ name: 'tools', note: '/srv/git' });
  });

  it('letters each instruction file by content, and marks one a machine lacks', () => {
    const arbor = itemAt(buildProjects(fleet), 0);
    const [claudeRow, agentsRow] = arbor.files;
    expect(present(claudeRow).name).toBe('.claude/CLAUDE.md');
    expect(present(claudeRow).differs).toBe(true);
    expect(Object.fromEntries(Object.entries(present(claudeRow).cells).map(([name, cell]) => [name, cell?.letter ?? null]))).toEqual({ mbp: 'A', ci: 'B', cedar: 'A' });
    expect(present(agentsRow).differs).toBe(true);
    expect(present(agentsRow).cells.cedar).toBeNull();
    const notes = itemAt(buildProjects(fleet), 1);
    expect(itemAt(notes.files, 0).differs).toBe(false);
  });

  it('sums a copy up at a glance, counting a checkout inside another once', () => {
    const arbor = itemAt(fleet[0]?.repos ?? [], 0);
    expect(ownSizeKb(arbor, itemAt(arbor.worktrees, 0))).toBe(600);
    expect(placeSummary(arbor)).toEqual({
      state: 'ok', bare: false, branch: 'main', ahead: 0, behind: 2, changes: 0, worktrees: 3, dirtyWorktrees: 1, removable: 2, sizeKb: 1_100,
    });
    expect(machineTotals(present(fleet[0]))).toEqual({ repos: 2, worktrees: 3, removable: 2, sizeKb: 1_100, reclaimKb: 500 });
    expect(machineTotals(present(fleet[1])).sizeKb).toBeNull();
  });

  it('says which projects need a look and which can be cleaned up', () => {
    const [arbor, notes, ciNotes] = buildProjects(fleet);
    expect(needsLook(present(arbor))).toBe(true);
    expect(needsLook(present(notes))).toBe(false);
    expect(canClean(present(arbor))).toBe(true);
    expect(canClean(present(ciNotes))).toBe(false);
    const gone = buildProjects([machine('mbp', '/Users/casey', [repo('/Users/casey/src/old', null, [], { state: 'missing' })])]);
    expect(needsLook(itemAt(gone, 0))).toBe(true);
    expect(matchesProject(present(arbor), 'LOGIN')).toBe(true);
    expect(matchesProject(present(arbor), 'billing')).toBe(false);
    expect(matchesProject(present(arbor), 'feature')).toBe(true);
    expect(matchesProject(present(arbor), 'casey/arbor')).toBe(true);
  });

  it('names who keeps a worktree and writes home paths from ~', () => {
    expect(worktreeOwner('/Users/casey/.t3/worktrees/arbor/x', '/Users/casey')).toBe('t3');
    expect(worktreeOwner('/Users/casey/.codex/worktrees/1a2b/arbor', '/Users/casey')).toBe('codex');
    expect(worktreeOwner('/srv/app/.claude/worktrees/fox', '/Users/casey')).toBe('claude');
    expect(worktreeOwner('/Users/casey/src/arbor-2', '/Users/casey')).toBeNull();
    expect(tilde('/Users/casey/src/x', '/Users/casey')).toBe('~/src/x');
    expect(tilde('/Users/caseyr/src', '/Users/casey')).toBe('/Users/caseyr/src');
    expect(tilde('/srv/x', '')).toBe('/srv/x');
  });

  it('scans a machine again only when it hasn’t been lately', () => {
    expect(needsScan(undefined, NOW)).toBe(true);
    expect(needsScan(machine('mbp', '', [], { scannedAt: NOW - 60_000 }), NOW)).toBe(false);
    expect(needsScan(machine('mbp', '', [], { scannedAt: NOW - PROJECTS_FRESH_MS - 1 }), NOW)).toBe(true);
    expect(needsScan(machine('mbp', '', [], { scannedAt: null, scanning: true }), NOW)).toBe(false);
  });

  it('plans removals only from what the last scan says can go', () => {
    const mbp = present(fleet[0]);
    const chosen = chosenWorktrees(mbp, ['/Users/casey/src/arbor/.claude/worktrees/fox', '/Users/casey/.agent-app/worktrees/arbor/wip', '/Users/casey/src/arbor', '/nowhere']);
    expect(chosen.map(({ worktree: entry }) => entry.path)).toEqual(['/Users/casey/src/arbor/.claude/worktrees/fox']);
    expect(removalPlan(chosen)).toEqual([{ repo: '/Users/casey/src/arbor', path: '/Users/casey/src/arbor/.claude/worktrees/fox', head: 'abc' }]);
    expect(branchFate(worktree('/a', { merged: true }))).toBe('delete');
    expect(branchFate(worktree('/a', { gone: true }))).toBe('keep');
    expect(branchFate(worktree('/a', { branch: null, merged: true }))).toBeNull();
  });

  it('warns about ignored files that may hold secrets', () => {
    expect(['.env', '.env.local', 'config/.env.production', 'id_ed25519', 'server.pem', '.npmrc', 'aws-credentials.json'].every(looksSecret)).toBe(true);
    expect(['node_modules/', 'dist/', 'target/', 'coverage/', 'README.md'].some(looksSecret)).toBe(false);
  });

  it('counts how removals went', () => {
    expect(removalCounts([
      { path: '/a', outcome: 'removed', branch: 'deleted', message: '' },
      { path: '/b', outcome: 'changed', branch: null, message: 'It has changes now' },
      { path: '/c', outcome: 'removed', branch: 'kept', message: '' },
    ])).toEqual({ removed: 2, gone: 0, changed: 1, busy: 0, skipped: 0, failed: 0 });
  });
});

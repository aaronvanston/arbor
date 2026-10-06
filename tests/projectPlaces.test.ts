import { describe, expect, it } from 'bun:test';
import type { CheckoutStatus, ProjectCell, ProjectDrift, ProjectsDrift } from '../src/native/types';
import { behindByMachine, behindOnDefault, canMove, cellFixes, cellNeeds, dirtyCount, isStale, machineFixes, matchesQuery, PLACE_STALE_MS, projectInStep, projectName, splitProjects } from '../src/services/projectPlaces';

const status = (extra: Partial<CheckoutStatus> = {}): CheckoutStatus => ({
  branch: 'main', changed: 0, untracked: 0, upstream: 'origin/main', ahead: 0, behind: 0, defaultBranch: 'origin/main',
  fetchedAt: 1_000, fetchFailed: false, worktrees: 0, ...extra,
});

const cell = (machine: string, state: ProjectCell['state'], extra: Partial<ProjectCell> = {}): ProjectCell => ({
  machine, path: '~/code/cam/arbor', state, blocker: null, blockerRemote: null, link: null, checkout: null, status: null, others: [], skillsTotal: 0, skillsOut: 0, ...extra,
});

const project = (name: string, cells: ProjectCell[], extra: Partial<ProjectDrift> = {}): ProjectDrift => ({
  project: name, local: false, archived: false, remote: `git@github.com:${name}.git`, branch: null, cells, unknown: [], unassigned: [], ...extra,
});

describe('what a project needs on a machine', () => {
  it('names the fix for the place first, then bringing the checkout up to date', () => {
    expect(cellNeeds(cell('ci-01', 'inPlace', { status: status() }))).toEqual([]);
    expect(cellNeeds(cell('ci-01', 'linked', { status: status({ behind: 3 }) }))).toEqual(['pull']);
    expect(cellNeeds(cell('ci-01', 'elsewhere', { status: status({ behind: 3, fetchFailed: true }) }))).toEqual(['link', 'fetch', 'pull']);
    expect(cellNeeds(cell('ci-01', 'missing'))).toEqual(['clone']);
    expect(cellNeeds(cell('ci-01', 'blocked'))).toEqual(['clear']);
    expect(cellNeeds(cell('ci-01', 'notScanned'))).toEqual(['scan']);
  });

  it('counts behind only on the remote’s default branch, which is the one Sync keeps up to date', () => {
    expect(behindOnDefault(status({ behind: 4 }))).toBe(4);
    expect(behindOnDefault(status({ branch: 'fix', upstream: 'origin/fix', behind: 4 }))).toBe(0);
    expect(behindOnDefault(status({ upstream: null, behind: null }))).toBe(0);
    expect(behindOnDefault(status({ defaultBranch: null, behind: 2 }))).toBe(2);
  });

  it('adds changed and untracked files, and says nothing when the scan couldn’t tell', () => {
    expect(dirtyCount(status({ changed: 2, untracked: 1 }))).toBe(3);
    expect(dirtyCount(status({ changed: null, untracked: null }))).toBeNull();
  });

  it('calls a checkout stale after a day without a fetch, or never fetched', () => {
    expect(isStale(status({ fetchedAt: 0 }), PLACE_STALE_MS - 1)).toBe(false);
    expect(isStale(status({ fetchedAt: 0 }), PLACE_STALE_MS + 1)).toBe(true);
    expect(isStale(status({ fetchedAt: null }), 0)).toBe(true);
  });
});

describe('projects across the machines', () => {
  const drift: ProjectsDrift = {
    projects: [
      project('cam/arbor', [cell('cam-mbp', 'linked', { status: status() }), cell('ci-01', 'elsewhere', { status: status() }), cell('cedar-02', 'notScanned')]),
      project('acme/proxy', [cell('cam-mbp', 'inPlace', { status: status({ behind: 1 }) }), cell('ci-01', 'inPlace', { status: status() })]),
      project('_local/notes', [cell('cam-mbp', 'inPlace', { status: status() })], { local: true, remote: null }),
      project('cam/old', [], { archived: true }),
    ],
    unlisted: [],
    machines: [],
  };

  it('counts what each machine has to fix, leaving out machines only waiting on a scan', () => {
    expect(behindByMachine(drift)).toEqual(new Map([['ci-01', 1], ['cam-mbp', 1]]));
  });

  it('keeps archived projects apart and says which are in step', () => {
    const { active, archived } = splitProjects(drift);
    expect(active.map((found) => found.project)).toEqual(['cam/arbor', 'acme/proxy', '_local/notes']);
    expect(archived.map((found) => found.project)).toEqual(['cam/old']);
    expect(active.map(projectInStep)).toEqual([false, false, true]);
  });

  it('shows a local project by its name and finds projects by name or remote', () => {
    expect(projectName('_local/notes')).toBe('notes');
    expect(projectName('cam/arbor')).toBe('cam/arbor');
    const [arbor] = drift.projects;
    expect(arbor && matchesQuery(arbor, 'ARBOR')).toBe(true);
    expect(arbor && matchesQuery(arbor, 'github.com:cam')).toBe(true);
    expect(arbor && matchesQuery(arbor, 'proxy')).toBe(false);
  });
});

describe('fixes', () => {
  it('offers the fix for each need, and never links or clones a local project', () => {
    expect(cellFixes(cell('ci-01', 'elsewhere', { status: status({ behind: 2 }) }), false)).toEqual(['link', 'fastForward']);
    expect(cellFixes(cell('ci-01', 'missing'), false)).toEqual(['clone']);
    expect(cellFixes(cell('ci-01', 'missing'), true)).toEqual([]);
    expect(cellFixes(cell('ci-01', 'blocked'), false)).toEqual([]);
    expect(cellFixes(cell('ci-01', 'notScanned'), false)).toEqual([]);
    // A local project's skills are still copied into its checkout.
    expect(cellFixes(cell('ci-01', 'inPlace', { status: status(), skillsTotal: 4, skillsOut: 2 }), true)).toEqual(['skills']);
  });

  it('moves only a clean checkout with no linked worktrees that isn’t at its place', () => {
    expect(canMove(cell('ci-01', 'elsewhere', { status: status() }))).toBe(true);
    expect(canMove(cell('ci-01', 'linked', { status: status() }))).toBe(true);
    expect(canMove(cell('ci-01', 'inPlace', { status: status() }))).toBe(false);
    expect(canMove(cell('ci-01', 'elsewhere', { status: status({ untracked: 1 }) }))).toBe(false);
    expect(canMove(cell('ci-01', 'linked', { status: status({ worktrees: 3 }) }))).toBe(false);
  });

  it('gathers what one machine needs, archived projects left out', () => {
    const drift: ProjectsDrift = {
      projects: [
        project('cam/arbor', [cell('ci-01', 'elsewhere', { status: status() }), cell('cam-mbp', 'missing')]),
        project('acme/proxy', [cell('ci-01', 'inPlace', { status: status({ behind: 1 }) })]),
        project('cam/old', [cell('ci-01', 'missing')], { archived: true }),
      ],
      unlisted: [],
      machines: [],
    };
    expect(machineFixes(drift, 'ci-01')).toEqual({ fixes: [{ project: 'cam/arbor', fix: 'link' }, { project: 'acme/proxy', fix: 'fastForward' }], skills: [] });
  });
});

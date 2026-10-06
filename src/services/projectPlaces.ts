import { invokeCommand } from '../native/commands';
import type { CheckoutStatus, PlaceState, ProjectCell, ProjectDrift, ProjectsDrift } from '../native/types';

/**
 * Where each of the setup repo's projects is on each machine, against where its project.json wants it: the place the
 * repo names on each machine it's on, and what the machine's last project scan found there. See
 * docs/internals/projects-and-machines.md.
 */

/** Every project's places against the machines' last project scans. Remembers `repo` for scans started elsewhere. */
export const getProjectDrift = (repo: string) => invokeCommand('get_project_drift', { repo });
/** Puts Arbor's schemas for machine and project files in the repo, so editors check them. */
export const addSetupSchemas = (repo: string) => invokeCommand('add_setup_schemas', { repo });

/** A checkout nobody has fetched for this long may not know what the remote has. */
export const PLACE_STALE_MS = 86_400_000;

/** What a cell needs before the project is where the repo wants it on that machine; empty when it's there. */
export type CellNeed = 'link' | 'clone' | 'clear' | 'scan' | 'pull' | 'fetch';

/** The states where the project isn't at its place yet. */
const NOT_THERE: Record<PlaceState, CellNeed | null> = {
  inPlace: null,
  linked: null,
  elsewhere: 'link',
  missing: 'clone',
  blocked: 'clear',
  notScanned: 'scan',
};

/** What a cell needs, in the order it'd be done: the place first, then bringing the checkout up to date. */
export function cellNeeds(cell: ProjectCell): CellNeed[] {
  const needs: CellNeed[] = [];
  const place = NOT_THERE[cell.state];
  if (place) needs.push(place);
  if (cell.status?.fetchFailed) needs.push('fetch');
  if (cell.status && behindOnDefault(cell.status) > 0) needs.push('pull');
  return needs;
}

/** How far the checkout is behind, counted only on the remote's default branch, the one Sync keeps up to date. */
export function behindOnDefault(status: CheckoutStatus): number {
  if (!status.behind || !status.upstream || !status.branch) return 0;
  return status.defaultBranch === null || status.upstream === status.defaultBranch ? status.behind : 0;
}

/** Changed and untracked files in the checkout; null when the scan couldn't tell. */
export function dirtyCount(status: CheckoutStatus): number | null {
  if (status.changed === null && status.untracked === null) return null;
  return (status.changed ?? 0) + (status.untracked ?? 0);
}

/** Whether a checkout hasn't been fetched for a while. Only a failed fetch counts against the project. */
export const isStale = (status: CheckoutStatus, now: number) => status.fetchedAt === null || now - status.fetchedAt > PLACE_STALE_MS;

/** Whether a project is where the repo wants it on every machine it's on, and up to date there. */
export const projectInStep = (project: ProjectDrift) => project.cells.every((cell) => cellNeeds(cell).length === 0);

/** The projects on record, archived ones apart, and whether any is out of step. */
export function splitProjects(drift: ProjectsDrift): { active: ProjectDrift[]; archived: ProjectDrift[] } {
  return {
    active: drift.projects.filter((project) => !project.archived),
    archived: drift.projects.filter((project) => project.archived),
  };
}

/** How many of the projects on each machine aren't where the repo wants them, or up to date, by machine. */
export function behindByMachine(drift: ProjectsDrift): Map<string, number> {
  const counts = new Map<string, number>();
  for (const project of drift.projects) {
    for (const cell of project.cells) {
      if (cellNeeds(cell).some((need) => need !== 'scan')) counts.set(cell.machine, (counts.get(cell.machine) ?? 0) + 1);
    }
  }
  return counts;
}

/** A project's name as the page shows it: `owner/name`, or a local one's name. */
export const projectName = (project: string) => project.startsWith('_local/') ? project.slice('_local/'.length) : project;

/** Whether a project matches what's typed in the search box: its name or remote. */
export function matchesQuery(project: ProjectDrift, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return true;
  return project.project.includes(wanted) || Boolean(project.remote?.toLowerCase().includes(wanted));
}

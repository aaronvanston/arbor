import { invokeCommand } from '../native/commands';
import type { CheckoutStatus, PlaceFix, ProjectCell, ProjectDrift, ProjectFixRequest, ProjectsDrift } from '../native/types';

/**
 * Where each of the setup repo's projects is on each machine, against where its project.json wants it: the place the
 * repo names on each machine it's on, and what the machine's last project scan found there. See
 * docs/internals/projects-and-machines.md.
 */

/** Every project's places against the machines' last project scans. Remembers `repo` for scans started elsewhere. */
export const getProjectDrift = (repo: string) => invokeCommand('get_project_drift', { repo });
/** Puts Arbor's schemas for machine and project files in the repo, so editors check them. */
export const addSetupSchemas = (repo: string) => invokeCommand('add_setup_schemas', { repo });

/**
 * Brings projects in line on a machine: links, clones, moves, fast-forwards and fetches, each checked again there first
 * and backed up, so Repo › History can undo it.
 */
export const applyProjectFixes = (repo: string, machine: string, fixes: ProjectFixRequest[]) => invokeCommand('apply_project_fixes', { repo, machine, fixes });
/**
 * Keeps a project with no remote in step through the hub on this Mac: collects each machine's branches, moves the
 * hub's forward where one machine is ahead of the rest, and hands them back out as `arbor/<branch>`.
 */
export const syncLocalProject = (repo: string, project: string) => invokeCommand('sync_local_project', { repo, project });
/** Copies a project's own skills into each of its checkouts and worktrees on a machine, backed up the same way. */
export const applyProjectSkills = (repo: string, machine: string, project: string) => invokeCommand('apply_project_skills', { repo, machine, project });

/** A checkout nobody has fetched for this long may not know what the remote has. */
export const PLACE_STALE_MS = 86_400_000;

/** A machine scanned longer ago than this, as a scan Arbor kept from before it restarted may be, is scanned again when Sync › Projects opens. */
export const SCAN_REFRESH_MS = 15 * 60_000;

/** The machines Sync › Projects scans when it opens: ones whose last scan didn't look at the repo's places, and ones scanned a while ago. */
export function machinesToScan(drift: ProjectsDrift, now: number): Set<string> {
  const due = new Set(drift.projects.flatMap((project) => project.cells.filter((cell) => cell.state === 'notScanned').map((cell) => cell.machine)));
  for (const machine of drift.machines) {
    if (machine.scannedAt !== null && now - machine.scannedAt > SCAN_REFRESH_MS) due.add(machine.machine);
  }
  return due;
}

/** What a cell needs before the project is where the repo wants it on that machine; empty when it's there. */
export type CellNeed = ProjectCell['needs'][number];

/**
 * What a cell needs, in the order it'd be done: the place first, then bringing the checkout up to date. Worked out in
 * Rust (`project_places::cell_needs`), where Sync's standing counts a project behind from the same list.
 */
export const cellNeeds = (cell: ProjectCell): CellNeed[] => cell.needs;

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
  for (const project of drift.projects.filter((found) => !found.archived)) {
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

/** The fix that meets each need, where Arbor has one. A path something else holds is the user's to clear. */
const NEED_FIX: Record<CellNeed, CellFix | null> = { link: 'link', clone: 'clone', clear: null, scan: null, pull: 'fastForward', fetch: 'fetch', skills: 'skills' };

/** A fix a cell offers: one of the place's, or copying the project's own skills into its checkouts. */
export type CellFix = PlaceFix | 'skills';

/** The fixes a project's cell needs, in order. A local project's place waits for the hub, so it's never linked or cloned. */
export function cellFixes(cell: ProjectCell, local: boolean): CellFix[] {
  return cellNeeds(cell)
    .map((need) => NEED_FIX[need])
    .filter((fix): fix is CellFix => fix !== null && !(local && (fix === 'link' || fix === 'clone')));
}

/**
 * Whether the checkout can be moved to its place instead of linked: only a clean one with no linked worktrees, since
 * those, and other apps, remember where it is. Arbor checks again on the machine, and for anything running in it.
 */
export function canMove(cell: ProjectCell): boolean {
  const status = cell.status;
  return (cell.state === 'elsewhere' || cell.state === 'linked') && status !== null && status.changed === 0 && status.untracked === 0 && status.worktrees === 0;
}

/** What a machine's card's Fix button runs: every place fix its projects need (never a move), and the projects whose skills to copy after. */
export function machineFixes(drift: ProjectsDrift, machine: string): { fixes: ProjectFixRequest[]; skills: string[] } {
  const fixes: ProjectFixRequest[] = [];
  const skills: string[] = [];
  for (const project of drift.projects.filter((found) => !found.archived)) {
    const cell = project.cells.find((found) => found.machine === machine);
    for (const fix of cell ? cellFixes(cell, project.local) : []) {
      if (fix === 'skills') skills.push(project.project);
      else fixes.push({ project: project.project, fix });
    }
  }
  return { fixes, skills };
}

/** How a run of fixes on one machine went: what was done, what wasn't and why, and the backups to undo it with. */
export type FixRun = { done: number; missed: { project: string; detail: string | null }[]; backups: string[] };

/**
 * Runs `fixes` on a machine, then copies the skills of each project in `skills`, which goes after them so a clone or
 * link made first gets its skills too. Each step is backed up on its own; undoing the run undoes them newest first.
 */
export async function runFixes(repo: string, machine: string, fixes: ProjectFixRequest[], skills: string[]): Promise<FixRun> {
  const run: FixRun = { done: 0, missed: [], backups: [] };
  if (fixes.length) {
    const { backups, results } = await applyProjectFixes(repo, machine, fixes);
    run.backups.push(...backups);
    for (const result of results) {
      if (result.outcome === 'done') run.done += 1;
      else run.missed.push({ project: result.project, detail: result.detail });
    }
  }
  for (const project of skills) {
    try {
      const outcome = await applyProjectSkills(repo, machine, project);
      if (outcome.backup) run.backups.push(outcome.backup);
      if (outcome.failed.length) run.missed.push({ project, detail: outcome.failed.join('; ') });
      else run.done += 1;
    } catch (error) {
      run.missed.push({ project, detail: String(error) });
    }
  }
  return run;
}

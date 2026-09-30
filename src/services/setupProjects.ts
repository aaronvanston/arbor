import { invokeCommand } from '../native/commands';
import type {
  MachineProjects,
  ProjectRepo,
  ProjectWorktree,
  RemovalOutcome,
  RemovalResult,
  RepoState,
  WorktreeRemoval,
} from '../native/types';
import { tracked } from './productAnalytics';

/**
 * The git checkouts sessions have worked in on each machine, with their worktrees and the instruction files at the top
 * of each. A scan only reads; removing a worktree is `git worktree remove` without `--force`, checked again on the
 * machine first.
 */

export const SETUP_PROJECTS_UPDATED_EVENT = 'setup-projects-updated';
export const INSTRUCTION_FILES = ['.claude/CLAUDE.md', 'CLAUDE.md', 'AGENTS.md'] as const;
/** A scan older than this is run again when the tab opens. */
export const PROJECTS_FRESH_MS = 30 * 60_000;
/** A repo nobody has fetched for this long may not know what's merged. */
export const FETCH_STALE_MS = 7 * 86_400_000;

export const getProjects = () => invokeCommand('get_projects');
export const scanProjects = (machine: string, fetch = false) => invokeCommand('scan_projects', { machine, fetch });
export const measureProjects = (machine: string) => invokeCommand('measure_projects', { machine });
export const readProjectFile = (machine: string, repo: string, name: string) => invokeCommand('read_project_file', { machine, repo, name });
export const removeWorktrees = (machine: string, removals: WorktreeRemoval[]) => tracked('worktrees-removed', invokeCommand('remove_worktrees', { machine, removals }), { count: removals.length });

/** A path under the machine's home folder, written from `~`. */
export function tilde(path: string, homeDir: string): string {
  if (!homeDir || homeDir === '/') return path;
  if (path === homeDir) return '~';
  return path.startsWith(`${homeDir}/`) ? `~${path.slice(homeDir.length)}` : path;
}

/**
 * Where tools put the worktrees they make by default: a folder under the home, or one inside a checkout. A worktree
 * anywhere else is shown as a plain worktree.
 */
const WORKTREE_FOLDERS: { owner: WorktreeOwner; folder: string; inHome: boolean }[] = [
  { owner: 't3', folder: '/.t3/worktrees/', inHome: true },
  { owner: 'codex', folder: '/.codex/worktrees/', inHome: true },
  { owner: 'claude', folder: '/.claude/worktrees/', inHome: false },
];

/** Which tool keeps a worktree, from where it is. */
export type WorktreeOwner = 't3' | 'claude' | 'codex';
export function worktreeOwner(path: string, homeDir: string): WorktreeOwner | null {
  const match = WORKTREE_FOLDERS.find(({ folder, inHome }) => (inHome ? Boolean(homeDir) && path.startsWith(`${homeDir}${folder}`) : path.includes(folder)));
  return match?.owner ?? null;
}

/** A remote on a host, as opposed to a folder on the machine, which only means something there. */
const hosted = (remote: string | null): remote is string => Boolean(remote && !remote.startsWith('/'));

/** Copies of one project are the same remote on every machine; one without a remote is its folder on its machine. */
export function projectKey(machine: string, repo: Pick<ProjectRepo, 'path' | 'remote'>): string {
  return hosted(repo.remote) ? `remote:${repo.remote}` : `path:${machine}\u0000${repo.path}`;
}

const lastPart = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path;

/** What a project is called, and the line under it: where its remote is, or the folder it's in. */
export function projectName(repo: Pick<ProjectRepo, 'path' | 'remote'>, homeDir: string): { name: string; note: string } {
  if (hosted(repo.remote)) {
    const parts = repo.remote.split('/');
    return { name: parts.pop() ?? repo.remote, note: parts.join('/') };
  }
  const name = lastPart(repo.path).replace(/\.git$/, '');
  return { name, note: tilde(repo.path.slice(0, repo.path.length - lastPart(repo.path).length).replace(/\/$/, '') || '/', homeDir) };
}

export type ProjectPlace = { machine: string; homeDir: string; repo: ProjectRepo };
/** Where an instruction file differs: the same letter is the same content. */
export type FileVariant = { letter: string; sum: string; size: number; place: ProjectPlace };
export type FileRow = { name: string; cells: Record<string, FileVariant | null>; differs: boolean };
export type ProjectRow = {
  key: string;
  name: string;
  note: string;
  remote: string | null;
  lastUsedMs: number | null;
  /** Each machine's copies, usually one. */
  places: Record<string, ProjectPlace[]>;
  files: FileRow[];
};

/** Every project on any machine, the most recently used first. */
export function buildProjects(machines: MachineProjects[]): ProjectRow[] {
  const rows = new Map<string, ProjectRow>();
  for (const projects of machines) {
    for (const repo of projects.repos) {
      const key = projectKey(projects.machine, repo);
      let row = rows.get(key);
      if (!row) {
        const { name, note } = projectName(repo, projects.homeDir);
        row = { key, name, note, remote: hosted(repo.remote) ? repo.remote : null, lastUsedMs: null, places: {}, files: [] };
        rows.set(key, row);
      }
      (row.places[projects.machine] ??= []).push({ machine: projects.machine, homeDir: projects.homeDir, repo });
      if (repo.lastUsedMs !== null && (row.lastUsedMs === null || repo.lastUsedMs > row.lastUsedMs)) row.lastUsedMs = repo.lastUsedMs;
    }
  }
  const list = [...rows.values()];
  for (const row of list) row.files = fileRows(row, machines.map((projects) => projects.machine));
  return list.sort((a, b) => (b.lastUsedMs ?? 0) - (a.lastUsedMs ?? 0) || a.name.localeCompare(b.name));
}

/** Each instruction file a project keeps somewhere, lettered by content across the machines that have the project. */
function fileRows(row: ProjectRow, machines: string[]): FileRow[] {
  const holders = machines.flatMap((machine) => {
    const place = row.places[machine]?.find((candidate) => candidate.repo.state === 'ok' && !candidate.repo.bare);
    return place ? [place] : [];
  });
  return INSTRUCTION_FILES.flatMap((name) => {
    if (!holders.some((place) => place.repo.files.some((file) => file.name === name))) return [];
    const letters = new Map<string, string>();
    const cells: Record<string, FileVariant | null> = {};
    for (const place of holders) {
      const file = place.repo.files.find((candidate) => candidate.name === name);
      if (!file) {
        cells[place.machine] = null;
        continue;
      }
      const key = `${file.sum}:${file.size}`;
      if (!letters.has(key)) letters.set(key, String.fromCharCode(65 + letters.size));
      cells[place.machine] = { letter: letters.get(key) ?? 'A', sum: file.sum, size: file.size, place };
    }
    const values = Object.values(cells);
    return [{ name, cells, differs: letters.size > 1 || (values.includes(null) && holders.length > 1) }];
  });
}

/** A worktree's own size, without the checkouts inside its folder, which are counted on their own. */
export function ownSizeKb(repo: ProjectRepo, worktree: ProjectWorktree): number | null {
  if (worktree.sizeKb === null) return null;
  const inside = repo.worktrees.filter((other) => other.path.startsWith(`${worktree.path}/`) && other.sizeKb !== null);
  const outermost = inside.filter((other) => !inside.some((outer) => outer !== other && other.path.startsWith(`${outer.path}/`)));
  return Math.max(0, worktree.sizeKb - outermost.reduce((sum, other) => sum + (other.sizeKb ?? 0), 0));
}

const dirtyCount = (worktree: ProjectWorktree) => (worktree.changed ?? 0) + (worktree.untracked ?? 0);

/** What one copy of a project looks like at a glance. */
export type PlaceSummary = {
  state: RepoState;
  bare: boolean;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  /** Uncommitted files in the main checkout. */
  changes: number;
  /** Linked worktrees. */
  worktrees: number;
  /** Linked worktrees with uncommitted files. */
  dirtyWorktrees: number;
  removable: number;
  sizeKb: number | null;
};

export function placeSummary(repo: ProjectRepo): PlaceSummary {
  const main = repo.worktrees.find((worktree) => worktree.main) ?? null;
  const linked = repo.worktrees.filter((worktree) => !worktree.main);
  const sizes = repo.worktrees.map((worktree) => ownSizeKb(repo, worktree)).filter((size): size is number => size !== null);
  return {
    state: repo.state,
    bare: repo.bare,
    branch: main?.branch ?? null,
    ahead: main?.ahead ?? null,
    behind: main?.behind ?? null,
    changes: main ? dirtyCount(main) : 0,
    worktrees: linked.length,
    dirtyWorktrees: linked.filter((worktree) => dirtyCount(worktree) > 0).length,
    removable: linked.filter((worktree) => worktree.blocker === null).length,
    sizeKb: sizes.length ? sizes.reduce((sum, size) => sum + size, 0) : null,
  };
}

/** A machine's projects in a line: how many repos and worktrees, what can go and how much it takes. */
export type MachineTotals = { repos: number; worktrees: number; removable: number; sizeKb: number | null; reclaimKb: number | null };
export function machineTotals(projects: MachineProjects): MachineTotals {
  let worktrees = 0;
  let removable = 0;
  let sizeKb: number | null = null;
  let reclaimKb: number | null = null;
  for (const repo of projects.repos) {
    for (const worktree of repo.worktrees) {
      if (!worktree.main) worktrees += 1;
      const size = ownSizeKb(repo, worktree);
      if (size !== null) sizeKb = (sizeKb ?? 0) + size;
      if (worktree.blocker === null) {
        removable += 1;
        if (size !== null) reclaimKb = (reclaimKb ?? 0) + size;
      }
    }
  }
  return { repos: projects.repos.length, worktrees, removable, sizeKb, reclaimKb };
}

/** Whether a project has something to look at: changes, commits to pull or push, a folder gone, files that differ. */
export function needsLook(row: ProjectRow): boolean {
  if (row.files.some((file) => file.differs)) return true;
  return Object.values(row.places).flat().some(({ repo }) => {
    if (repo.state !== 'ok' || repo.fetchFailed) return true;
    const summary = placeSummary(repo);
    return summary.changes > 0 || (summary.ahead ?? 0) > 0 || (summary.behind ?? 0) > 0 || summary.dirtyWorktrees > 0;
  });
}

export const canClean = (row: ProjectRow) => Object.values(row.places).flat().some(({ repo }) => placeSummary(repo).removable > 0);

export function matchesProject(row: ProjectRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [row.name, row.note, row.remote ?? '', ...Object.values(row.places).flat().flatMap(({ repo }) => [repo.path, ...repo.worktrees.flatMap((worktree) => [worktree.path, worktree.branch ?? ''])])]
    .some((text) => text.toLowerCase().includes(needle));
}

/** Whether the machines' projects should be looked at again: never scanned, or not lately. */
export function needsScan(projects: MachineProjects | undefined, now: number): boolean {
  if (!projects) return true;
  if (projects.scanning || projects.measuring || projects.removing) return false;
  return projects.scannedAt === null || now - projects.scannedAt > PROJECTS_FRESH_MS;
}

/** What happens to a removed worktree's branch: deleted when it's merged (git refuses otherwise), else kept. */
export function branchFate(worktree: ProjectWorktree): 'delete' | 'keep' | null {
  if (!worktree.branch) return null;
  return worktree.merged ? 'delete' : 'keep';
}

/** Why a worktree the page offers can go. */
export const removableWhy = (worktree: ProjectWorktree): 'merged' | 'gone' => (worktree.merged ? 'merged' : 'gone');

/** An ignored file whose name says it may hold a secret, which goes with the worktree. */
export function looksSecret(entry: string): boolean {
  const name = entry.replace(/\/$/, '').split('/').pop()?.toLowerCase() ?? '';
  return name.startsWith('.env') || /^id_(rsa|ed25519|ecdsa|dsa)/.test(name) || /\.(pem|key|p12|pfx|keystore)$/.test(name)
    || ['.npmrc', '.netrc', '.pypirc'].includes(name) || /credential|secret|token/.test(name);
}

/** The worktrees chosen on one machine, found in its last scan; ones it no longer has are dropped. */
export function chosenWorktrees(projects: MachineProjects, paths: string[]): { repo: ProjectRepo; worktree: ProjectWorktree }[] {
  return projects.repos.flatMap((repo) => repo.worktrees
    .filter((worktree) => paths.includes(worktree.path) && worktree.blocker === null && worktree.head !== null)
    .map((worktree) => ({ repo, worktree })));
}

export function removalPlan(chosen: { repo: ProjectRepo; worktree: ProjectWorktree }[]): WorktreeRemoval[] {
  return chosen.map(({ repo, worktree }) => ({ repo: repo.path, path: worktree.path, head: worktree.head ?? '' }));
}

/** How many of each outcome came back. */
export function removalCounts(results: RemovalResult[]): Record<RemovalOutcome, number> {
  const counts: Record<RemovalOutcome, number> = { removed: 0, gone: 0, changed: 0, busy: 0, skipped: 0, failed: 0 };
  for (const result of results) counts[result.outcome] += 1;
  return counts;
}

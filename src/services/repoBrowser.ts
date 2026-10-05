import type { GitStatusEntry } from '@pierre/trees';
import type { MessageKey } from '../i18n/resources';
import { invokeCommand } from '../native/commands';
import { savedStore } from './savedStore';
import type { RepoChange, RepoEntry, RepoRole, RepoStatus, SetupMachine, SetupRepo } from '../native/types';
import { scanned, syncPlan, type SyncState } from './setupSync';

/** Every file in the repo's folder, committed or not, and how each stands against the last commit. */
export const listSetupRepoTree = (repo: string) => invokeCommand('list_setup_repo_tree', { repo });
/** A file as the folder has it, or with `commit` as that commit had it. */
export const readSetupRepoText = (repo: string, path: string, commit: string | null = null) =>
  invokeCommand('read_setup_repo_text', { repo, path, commit });
/** Writes a file in the folder without committing it, when it still has `expected` (null: when there's no file there). */
export const writeSetupRepoText = (repo: string, path: string, content: string, expected: string | null) =>
  invokeCommand('write_setup_repo_text', { repo, path, content, expected });
/** Renames a file or folder in the folder, without committing it. */
export const moveSetupRepoPath = (repo: string, from: string, to: string) => invokeCommand('move_setup_repo_path', { repo, from, to });
/** Deletes a file or folder in the folder, without committing it. */
export const deleteSetupRepoPath = (repo: string, path: string) => invokeCommand('delete_setup_repo_path', { repo, path });
/** Puts the files back as the last commit has them; a file the commit hasn't got goes. */
export const discardSetupRepoChanges = (repo: string, paths: string[]) => invokeCommand('discard_setup_repo_changes', { repo, paths });
/** The changes not committed yet, or with `commit` what that commit changed. */
export const getSetupRepoChanges = (repo: string, commit: string | null = null) => invokeCommand('get_setup_repo_changes', { repo, commit });
/** The branch's latest commits, newest first. */
export const getSetupRepoLog = (repo: string, limit: number) => invokeCommand('get_setup_repo_log', { repo, limit });
/** Commits the files' changes, and nothing else, with the message. */
export const commitSetupRepo = (repo: string, paths: string[], message: string) => invokeCommand('commit_setup_repo', { repo, paths, message });

/** Where the repo keeps skills, a folder each. */
const SKILLS_FOLDER = '.agents/skills/';
/** Where the repo keeps projects' own instructions. */
const PROJECTS_FOLDER = '.agents/projects/';

/** Roles whose file goes to the same place in each machine's home. */
const HOME_ROLES: ReadonlySet<RepoRole> = new Set(['instructions', 'rule', 'subagent', 'command', 'hookScript']);

/** The skill a path in the repo is, or is in. */
export function skillOf(path: string): string | null {
  if (!path.startsWith(SKILLS_FOLDER)) return null;
  const [name] = path.slice(SKILLS_FOLDER.length).split('/');
  return name || null;
}

/** A skill's folder in the repo. */
export const skillFolder = (name: string) => `${SKILLS_FOLDER}${name}`;

/** The project, and the machine when it's one machine's, whose own instructions a file in the repo holds. */
export function projectOf(path: string): { project: string; machine: string | null } | null {
  if (!path.startsWith(PROJECTS_FOLDER)) return null;
  const parts = path.slice(PROJECTS_FOLDER.length).split('/');
  const [owner, name, third, fourth] = parts;
  if (!owner || !name) return null;
  const project = `${owner}/${name}`;
  if (parts.length === 3 && third === 'instructions.md') return { project, machine: null };
  if (parts.length === 4 && third === 'machines' && fourth?.endsWith('.md') && fourth.length > 3) return { project, machine: fourth.slice(0, -3) };
  return null;
}

/** Where a file goes on each machine, as the scans name it: its place in the home folder, or for a skill its folder in the store. */
export function homePath(entry: Pick<RepoEntry, 'path' | 'role'>): string | null {
  if (entry.role === 'skill') {
    const skill = skillOf(entry.path);
    return skill ? `~/${skillFolder(skill)}` : null;
  }
  return HOME_ROLES.has(entry.role) ? `~/${entry.path}` : null;
}

const GIT_STATUS: Record<Exclude<RepoStatus, 'same'>, GitStatusEntry['status']> = { modified: 'modified', added: 'added', deleted: 'deleted' };

/** Each file with changes not committed, as the tree marks it. */
export const treeStatus = (entries: readonly RepoEntry[]): GitStatusEntry[] =>
  entries.flatMap((entry) => (entry.status === 'same' ? [] : [{ path: entry.path, status: GIT_STATUS[entry.status] }]));

/** The files with changes not committed. */
export const uncommittedEntries = (entries: readonly RepoEntry[]) => entries.filter((entry) => entry.status !== 'same');

/** The file the browser opens first: the README, else Claude Code's instructions, else the first it can show. */
export function firstFile(entries: readonly RepoEntry[]): string | null {
  const openable = entries.filter((entry) => entry.problem === null && entry.status !== 'deleted');
  const named = (path: string) => openable.find((entry) => entry.path.toLowerCase() === path)?.path;
  return named('readme.md') ?? named('.claude/claude.md') ?? openable[0]?.path ?? null;
}

/** How one machine's copy stands against the repo's last commit; `unread` until the machine has been scanned. */
export type Standing = { machine: string; state: SyncState | 'unread' };

/** How each machine's copy of a file or skill the repo syncs stands against the repo's last commit. */
export function standings(repo: SetupRepo, machines: readonly SetupMachine[], entry: Pick<RepoEntry, 'path' | 'role'>): Standing[] {
  const home = homePath(entry);
  if (!home || !repo.head) return [];
  return machines.map((machine) => {
    if (!scanned(machine)) return { machine: machine.machine, state: 'unread' };
    const file = syncPlan(repo, machine).find((candidate) => candidate.path === home);
    return { machine: machine.machine, state: file?.state ?? 'add' };
  });
}

/** Whether a machine's copy needs nothing doing: the same, kept off it or its own, or nowhere for it to go. */
export const settled = (state: Standing['state']) => state === 'same' || state === 'offHere' || state === 'own' || state === 'noHome';

/** A file's name, from its path. */
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** A commit message for changes, as words to fill in: one file's name and what happened to it, or how many files. */
export function suggestedMessage(changes: readonly Pick<RepoChange, 'path' | 'status'>[]): { key: MessageKey; name?: string; count?: number } | null {
  const [only] = changes;
  if (!only) return null;
  if (changes.length > 1) {
    const skills = new Set(changes.map((change) => skillOf(change.path)));
    const [skill] = skills;
    if (skills.size === 1 && skill) return { key: 'repo.commit.suggest.skill', name: skill };
    return { key: 'repo.commit.suggest.many', count: changes.length };
  }
  const key: MessageKey = only.status === 'added' ? 'repo.commit.suggest.add' : only.status === 'deleted' ? 'repo.commit.suggest.delete' : 'repo.commit.suggest.edit';
  return { key, name: baseName(only.path) };
}

/** A name that says the file may hold a secret, as the backend's `looks_secret` reads one, which Arbor never opens or makes. */
const looksSecret = (name: string) => {
  const lower = name.toLowerCase();
  return lower.startsWith('.env') || lower.startsWith('id_rsa') || lower.startsWith('id_ed25519') || lower === 'auth.json' || lower === '.netrc'
    || /\.(pem|key|p12|pfx)$/.test(lower) || /credential|secret|token/.test(lower);
};

/**
 * Why a new path can't be made in the repo: none given, outside the folder, inside git's own, a name that says it may
 * hold a secret, or something there already. Null when it can.
 */
export function newPathProblem(path: string, entries: readonly RepoEntry[]): MessageKey | null {
  const parts = path.split('/');
  if (!path.trim()) return 'repo.new.problem.empty';
  if (path.startsWith('/') || path.includes('\\') || parts.some((part) => !part || part === '.' || part === '..')) return 'repo.new.problem.outside';
  if (parts.some((part) => part.toLowerCase() === '.git')) return 'repo.new.problem.git';
  if (parts.some(looksSecret)) return 'repo.new.problem.secret';
  if (entries.some((entry) => entry.path === path || entry.path.startsWith(`${path}/`) || path.startsWith(`${entry.path}/`))) return 'repo.new.problem.taken';
  return null;
}

/** A new skill's SKILL.md, with the front matter agents read a skill's name and use from. */
export const skillTemplate = (name: string) => `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n`;

/** A skill's name as the store takes one: letters, digits, dots, dashes and underscores, not starting with a dot. */
export const isSkillName = (name: string) => /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(name);

/** The file list's column on Sync › Repo, in CSS pixels: 18rem to start with, never so narrow names are all cut. */
export const REPO_TREE_MIN_WIDTH = 200;
export const REPO_TREE_DEFAULT_WIDTH = 288;
export const REPO_TREE_MAX_WIDTH = 560;
/** How far one arrow key press moves the column's edge. */
const REPO_TREE_KEY_STEP = 16;

/** A width within the limits, in whole pixels; one that isn't a number at all is the default. */
export function clampRepoTreeWidth(width: number): number {
  const whole = Number.isFinite(width) ? Math.round(width) : REPO_TREE_DEFAULT_WIDTH;
  return Math.max(REPO_TREE_MIN_WIDTH, Math.min(REPO_TREE_MAX_WIDTH, whole));
}

/** Where a key press on the column's edge moves it: the arrows a step, Home and End all the way; null for other keys. */
export function repoTreeWidthForKey(width: number, key: string): number | null {
  switch (key) {
    case 'ArrowLeft': return clampRepoTreeWidth(width - REPO_TREE_KEY_STEP);
    case 'ArrowRight': return clampRepoTreeWidth(width + REPO_TREE_KEY_STEP);
    case 'Home': return REPO_TREE_MIN_WIDTH;
    case 'End': return REPO_TREE_MAX_WIDTH;
    default: return null;
  }
}

/** The column's width as last dragged; a window preference like the sidebar's. */
export const repoTreeWidth = savedStore<number>({
  key: 'arbor.repo.treeWidth.v1',
  parse: (raw) => (raw ? clampRepoTreeWidth(Number(raw)) : REPO_TREE_DEFAULT_WIDTH),
  fallback: REPO_TREE_DEFAULT_WIDTH,
  serialize: String,
  place: 'window',
});

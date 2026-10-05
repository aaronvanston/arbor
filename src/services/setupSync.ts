import { invokeCommand } from '../native/commands';
import type { SetupItemKind } from './setupInventory';
import { machineLookKey } from './machineLook';
import type {
  Harness,
  HarnessHome,
  SetupHome,
  SetupItem,
  SetupMachine,
  SetupRepo,
  SetupRepoFile,
  SetupRepoSkill,
  SkillWanted,
  SyncChange,
  SyncFileKind,
} from '../native/types';
import { tracked } from './productAnalytics';
import { savedStore } from './savedStore';

/** The kinds of file the repo syncs, and skills. */
export type SyncKind = SyncFileKind | 'skill';

/**
 * Why a skill in the repo can't be synced: a link or submodule in it, a file name the machines' tools would print
 * differently, a file whose name says it may hold a secret, over 1 MB a file or 4 MB or 400 files in all, or no SKILL.md.
 */
export type SkillProblem = 'link' | 'name' | 'secret' | 'large' | 'noDoc';

/** How many changes a machine keeps backups of, as the native side keeps them. */
export const BACKUPS_KEPT = 20;

export const getSetupRepo = (repo: string) => invokeCommand('get_setup_repo', { repo });
export const readSetupRepoFile = (repo: string, commit: string, path: string) => invokeCommand('read_setup_repo_file', { repo, commit, path });
/** Starts a repo in `repo` with this Mac's instructions, rules, subagents and commands. */
export const startSetupRepo = (repo: string) => invokeCommand('start_setup_repo', { repo });
/** Commits a machine's copy of a file as the repo's. */
export const takeSetupFile = (repo: string, machine: string, path: string) => invokeCommand('take_setup_file', { repo, machine, path });
export const pullSetupRepo = (repo: string) => invokeCommand('pull_setup_repo', { repo });
export const pushSetupRepo = (repo: string) => invokeCommand('push_setup_repo', { repo });
export const applySetupSync = (repo: string, commit: string, machine: string, changes: SyncChange[]) =>
  tracked('sync-applied', invokeCommand('apply_setup_sync', { repo, commit, machine, changes }), { count: changes.length });
export const listSetupBackups = (machine: string) => invokeCommand('list_setup_backups', { machine });
export const undoSetupSync = (machine: string, backup: string) => tracked('sync-undone', invokeCommand('undo_setup_sync', { machine, backup }));
/** Commits a machine's copy of each skill as the repo's, with where `npx skills` there says it came from. */
export const takeSetupSkills = (repo: string, machine: string, paths: string[]) => invokeCommand('take_setup_skills', { repo, machine, paths });
/** The repo's copy of a skill, file by file; each file's fingerprint is its checksum when `ck`, to compare with a machine that has no SHA-256 tool. */
export const readSetupRepoSkill = (repo: string, commit: string, name: string, ck: boolean) =>
  invokeCommand('read_setup_repo_skill', { repo, commit, name, ck });

/** Asks GitHub about each skill with a recorded source; what it said in the last 15 minutes is used again, unless `force`. */
export const checkSetupSkillSources = (repo: string, force: boolean) => invokeCommand('check_setup_skill_sources', { repo, force });
/** Replaces the repo's copy of a skill with its source's latest, as a commit. */
export const updateSetupSkill = (repo: string, name: string) => invokeCommand('update_setup_skill', { repo, name });

/** The setup repo's folder, as the Repo tab remembers it; a setting the app keeps, so `arbor sync` finds it too. */
const setupRepo = savedStore<string | null>({
  key: 'arbor.setup.repo.v1',
  parse: (raw) => raw || null,
  fallback: null,
  serialize: (path) => path ?? '',
});

export const storedSetupRepo = () => setupRepo.get();
export const storeSetupRepo = (path: string | null) => setupRepo.set(path);

/** A skill in a machine's store, as the scan names it. */
export const isStoreSkill = (path: string) => /^~\/\.agents\/skills\/[^/.][^/]*$/.test(path);

/** The homes the repo syncs into, and whose each is. */
export const SYNC_HOMES = [
  { agent: 'claude', path: '~/.claude' },
  { agent: 'codex', path: '~/.codex' },
] as const;

/**
 * The other harnesses' default homes, whose own AGENTS.md the repo keeps (mirrors the backend's
 * `harnesses::repo_instructions`).
 */
export const HARNESS_SYNC_HOMES: readonly { harness: Harness; path: string }[] = [
  { harness: 'pi', path: '~/.pi/agent' },
  { harness: 'primeAgent', path: '~/.prime/agent' },
  { harness: 'openCode', path: '~/.config/opencode' },
  { harness: 'droid', path: '~/.factory' },
  { harness: 'amp', path: '~/.config/amp' },
];
const harnessInstructions = (path: string) => HARNESS_SYNC_HOMES.some((home) => path === `${home.path}/AGENTS.md`);
const isHarnessSyncHome = (home: HarnessHome) => HARNESS_SYNC_HOMES.some((sync) => sync.harness === home.harness && sync.path === home.path);

const SYNC_KINDS: ReadonlySet<SetupItemKind> = new Set(['instructions', 'rule', 'subagent', 'command', 'hook']);

/** A script the repo's hooks run, in the machine's ~/.agents/hooks, as the backend's `is_script_name` reads one. */
const isHookScript = (name: string) => name.length <= 100 && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name);

/** A name that says the file may hold a secret, as the backend's `looks_secret` reads one. */
const looksSecret = (name: string) => {
  const lower = name.toLowerCase();
  return lower.startsWith('.env') || lower.startsWith('id_rsa') || lower.startsWith('id_ed25519') || /credential|secret|token/.test(lower);
};

/**
 * The kind of file a path is, when the repo syncs it (mirrors the backend's `managed`): Claude Code's
 * CLAUDE.md, rules, subagents and commands, Codex's AGENTS.md and prompts, and the scripts hooks run.
 */
export function syncKind(path: string): SyncFileKind | null {
  if (!path.startsWith('~/')) return null;
  if (harnessInstructions(path)) return 'instructions';
  const parts = path.slice(2).split('/');
  if (path.includes('\\') || parts.some((part) => !part || part === '.' || part === '..')) return null;
  const [home, folder] = parts;
  // `split` always returns at least one part, so the fallback only satisfies the type checker.
  const name = parts[parts.length - 1] ?? '';
  if (parts.length === 2) {
    return (home === '.claude' && folder === 'CLAUDE.md') || (home === '.codex' && folder === 'AGENTS.md') ? 'instructions' : null;
  }
  if (home === '.agents' && folder === 'hooks') return parts.length === 3 && isHookScript(name) && !looksSecret(name) ? 'hookScript' : null;
  if (name.length <= 3 || !name.endsWith('.md') || looksSecret(name)) return null;
  if (home === '.claude' && folder === 'rules') return 'rule';
  if (home === '.claude' && folder === 'agents') return parts.length === 3 ? 'subagent' : null;
  if ((home === '.claude' && folder === 'commands') || (home === '.codex' && folder === 'prompts')) return 'command';
  return null;
}

/**
 * How a machine's copy of a file or skill stands against the repo's:
 * - `same`, `update` (it differs), `add` (the machine hasn't got it), `extra` (only the machine has it);
 * - `linked`: it's a link there, which is left alone;
 * - `noHome`: the machine hasn't the agent's home, so the agent isn't set up there;
 * - `blocked`: a skill that can't be synced, as `problem` says.
 */
/**
 * `offHere` and `own` are a skill's own value on the machine (.agents/machines.json): kept off it, or its copy kept as
 * the machine has it. Neither is changed or counted as out of step.
 */
/**
 * `removed`: a rule, subagent, command or skill the repo has taken off every machine, whose copy on the machine goes
 * unless kept.
 */
export type SyncState = 'same' | 'update' | 'add' | 'extra' | 'removed' | 'linked' | 'noHome' | 'blocked' | 'offHere' | 'own';

export type SyncFile = {
  path: string;
  kind: SyncKind;
  state: SyncState;
  /** The repo's copy of a file; null for a skill, or a file only the machine has. */
  repo: SetupRepoFile | null;
  /** The repo's copy of a skill; null for a file, or a skill only the machine has. */
  skill: SetupRepoSkill | null;
  /** The machine's copy, as its last scan found it. */
  item: SetupItem | null;
  /** Why a `blocked` skill can't be synced: the repo's copy's problem, or `notSkill` when the machine's folder has no SKILL.md. */
  problem: SkillProblem | 'notSkill' | null;
};

const isSyncHome = (home: SetupHome) => SYNC_HOMES.some((sync) => sync.agent === home.agent && sync.path === home.path);
/** A machine without a SHA-256 tool fingerprints with `cksum`: c, its checksum, a dash and the length. */
export const isChecksum = (sum: string) => /^c\d+-\d+$/.test(sum);
const byPath = (a: SyncFile, b: SyncFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** A skill's name from where the store keeps it, ~/.agents/skills/<name>. */
export const skillName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** A machine's own value for a repo skill, or undefined while it follows every machine's. */
export const skillWanted = (repo: SetupRepo, path: string, machine: string): SkillWanted | undefined =>
  repo.skillMachines?.[skillName(path)]?.[machineLookKey(machine)];

/** Takes a rule, subagent or command off every machine in the repo (each machine's copy goes with its review), or puts it back. */
export const setSetupFileRemoved = (repo: string, path: string, removed: boolean) =>
  invokeCommand('set_setup_file_removed', { repo, path, removed });

/**
 * Turns a skill the repo has off on every machine, kept in the repo (each machine's store copy goes with its review), or
 * on again; commits .agents/machines.json alone.
 */
export const setSetupSkillOff = (repo: string, skill: string, off: boolean) => invokeCommand('set_setup_skill_off', { repo, skill, off });

/** Turns a rule, subagent or command the repo has off on every machine, kept in the repo, or on again. */
export const setSetupFileOff = (repo: string, path: string, off: boolean) => invokeCommand('set_setup_file_off', { repo, path, off });

/** A file the repo can take off every machine: not an agent's instructions, which every machine has its own of. */
export const removableKind = (kind: SyncFileKind) => kind !== 'instructions';

/** Takes a skill off every machine in the repo (its folder goes, and each machine's store copy with the next review), or puts it back. */
export const setSetupSkillRemoved = (repo: string, skill: string, removed: boolean) =>
  invokeCommand('set_setup_skill_removed', { repo, skill, removed });

/** Takes skills back out of the repo in one commit, undoing putting them in: nothing is marked removed, so machines keep theirs. */
export const dropSetupSkills = (repo: string, skills: string[]) => invokeCommand('drop_setup_skills', { repo, skills });

/** A machine's own value for a repo rule, subagent or command, or undefined while it follows every machine's. */
export const fileWanted = (repo: SetupRepo, path: string, machine: string): SkillWanted | undefined =>
  repo.fileMachines?.[path]?.[machineLookKey(machine)];

/** Gives a machine its own value for a rule, subagent or command in the repo, or with null every machine's; commits the one file. */
export const setSetupFileMachine = (repo: string, path: string, machine: string, wanted: SkillWanted | null) =>
  invokeCommand('set_setup_file_machine', { repo, path, machine, wanted });

/** Gives a machine its own value for a skill in the repo, or with null puts it back on every machine's; commits the one file. */
export const setSetupSkillMachine = (repo: string, skill: string, machine: string, wanted: SkillWanted | null) =>
  invokeCommand('set_setup_skill_machine', { repo, skill, machine, wanted });

/** Each file and skill the repo syncs, and each the machine has where the repo would put one, as the machine's last scan found it. */
export function syncPlan(repo: SetupRepo, machine: SetupMachine): SyncFile[] {
  const homes = new Set([...machine.homes.filter(isSyncHome), ...machine.harnessHomes.filter(isHarnessSyncHome)].map((home) => home.path));
  const present = new Map<string, SetupItem>();
  for (const home of machine.harnessHomes.filter(isHarnessSyncHome)) {
    for (const item of home.items) {
      if (item.path && item.kind === 'instructions' && syncKind(item.path)) present.set(item.path, item);
    }
  }
  // Hook scripts go in ~/.agents, which is made where there isn't one.
  for (const home of machine.homes.filter((candidate) => isSyncHome(candidate) || candidate.agent === 'shared')) {
    for (const item of home.items) {
      if (item.path && SYNC_KINDS.has(item.kind) && syncKind(item.path)) present.set(item.path, item);
    }
  }
  const offFiles = new Set(repo.offFiles ?? []);
  const offSkills = new Set(repo.offSkills ?? []);
  const files: SyncFile[] = repo.files.map((file) => {
    const item = present.get(file.path) ?? null;
    const home = file.kind === 'hookScript'
      ? null
      : [...SYNC_HOMES, ...HARNESS_SYNC_HOMES].find((sync) => file.path.startsWith(`${sync.path}/`))?.path ?? '';
    const wanted = fileWanted(repo, file.path, machine.machine);
    let state: SyncState;
    // Off everywhere: a copy the machine has is the repo's to take out, as a removed file's is, unless it keeps its own.
    if (offFiles.has(file.path) && wanted !== 'own') state = item && item.link === null && item.sum !== null ? 'removed' : 'offHere';
    else if (wanted === 'off') state = 'offHere';
    else if (wanted === 'own' && item && item.link === null && item.sum !== null) state = 'own';
    else if (home !== null && !homes.has(home)) state = 'noHome';
    else if (!item) state = 'add';
    else if (item.link !== null || item.sum === null) state = 'linked';
    else state = item.sum === (isChecksum(item.sum) ? file.ck : file.sum) ? 'same' : 'update';
    return { path: file.path, kind: file.kind, state, repo: file, skill: null, item, problem: null };
  });
  const inRepo = new Set(repo.files.map((file) => file.path));
  const removedFiles = new Set(repo.removedFiles ?? []);
  for (const [path, item] of present) {
    if (inRepo.has(path) || item.link !== null || item.sum === null) continue;
    files.push({ path, kind: syncKind(path) as SyncKind, state: removedFiles.has(path) ? 'removed' : 'extra', repo: null, skill: null, item, problem: null });
  }
  // Skills go into the store, which is made where there isn't one, so every machine has somewhere for them.
  const store = new Map<string, SetupItem>();
  for (const home of machine.homes.filter((candidate) => candidate.agent === 'shared')) {
    for (const item of home.items) {
      if (item.kind === 'skill' && item.path && isStoreSkill(item.path)) store.set(item.path, item);
    }
  }
  for (const skill of repo.skills ?? []) {
    const item = store.get(skill.path) ?? null;
    const wanted = skillWanted(repo, skill.path, machine.machine);
    let state: SyncState;
    let problem: SyncFile['problem'] = null;
    if (offSkills.has(skill.name) && wanted !== 'own') state = item && item.link === null && item.sum !== null && item.skill?.hasDoc ? 'removed' : 'offHere';
    else if (wanted === 'off') state = 'offHere';
    else if (wanted === 'own' && item && item.link === null && item.sum !== null) state = 'own';
    else if (skill.problem) [state, problem] = ['blocked', skill.problem];
    else if (!item) state = 'add';
    else if (item.link !== null) state = 'linked';
    else if (item.sum === null || !item.skill?.hasDoc) [state, problem] = ['blocked', 'notSkill'];
    else state = item.sum === (isChecksum(item.sum) ? skill.ck : skill.sum) ? 'same' : 'update';
    files.push({ path: skill.path, kind: 'skill', state, repo: null, skill, item, problem });
  }
  const skillsInRepo = new Set((repo.skills ?? []).map((skill) => skill.path));
  const removed = new Set(repo.removedSkills ?? []);
  for (const [path, item] of store) {
    if (skillsInRepo.has(path) || item.link !== null || item.sum === null || !item.skill?.hasDoc) continue;
    // A machine keeping its own copy keeps it, removed from every other machine or not.
    const gone = removed.has(skillName(path)) && skillWanted(repo, path, machine.machine) !== 'own';
    files.push({ path, kind: 'skill', state: gone ? 'removed' : 'extra', repo: null, skill: null, item, problem: null });
  }
  return files.sort(byPath);
}

/** Whether a file is changed: the repo's copy written where it differs or is missing, the machine's removed where only it has one. */
export type SyncChoices = Record<string, boolean>;

/**
 * Unless chosen otherwise, the repo's copies are written, files only the machine has are kept, and skills the repo
 * removed from every machine go.
 */
export const chosen = (file: SyncFile, choices: SyncChoices) => choices[file.path] ?? (file.state === 'update' || file.state === 'add' || file.state === 'removed');

/** Whether a file's state can be changed at all. */
export const changeable = (file: SyncFile) => file.state === 'update' || file.state === 'add' || file.state === 'extra' || file.state === 'removed';

/** The changes the choices make. */
export function syncChanges(files: SyncFile[], choices: SyncChoices = {}): SyncChange[] {
  return files.flatMap((file): SyncChange[] => {
    if (!changeable(file) || !chosen(file, choices)) return [];
    if (file.state === 'extra' || file.state === 'removed') return [{ path: file.path, remove: true, before: file.item?.sum ?? null }];
    return [{ path: file.path, remove: false, before: file.item?.sum ?? null }];
  });
}

export type SyncCounts = Record<SyncState, number>;

export function syncCounts(files: SyncFile[]): SyncCounts {
  const counts: SyncCounts = { same: 0, update: 0, add: 0, extra: 0, removed: 0, linked: 0, noHome: 0, blocked: 0, offHere: 0, own: 0 };
  for (const file of files) counts[file.state] += 1;
  return counts;
}

/** How many are files and how many skills, to say so. */
export const tally = (paths: string[]) => {
  const skills = paths.filter(isStoreSkill).length;
  return { files: paths.length - skills, skills };
};

/** In step once nothing the repo has differs or is missing, and nothing it removed is left; files only the machine has may stay. */
export const inStep = (counts: SyncCounts) => counts.update + counts.add + counts.removed === 0;

/** Whether a machine has been read, so there's something to compare with the repo. */
export const scanned = (machine: SetupMachine) => machine.scannedAt !== null || machine.homes.length > 0;

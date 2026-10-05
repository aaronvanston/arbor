import { useSyncExternalStore } from 'react';
import type { SetupMachine, SetupRepo, SkillAction, SyncOutcome } from '../native/types';
import { fetchSetupInventory } from './setupInventory';
import {
  applySkillChanges,
  cellOptions,
  changeKey,
  isTurnedOff,
  settleSkills,
  skillChanges,
  skillsView,
  STORE,
  type PendingSkills,
  type PlannedSkill,
  type SkillCell,
  type SkillHome,
  type SkillRow,
  type SkillsView,
} from './setupSkills';
import {
  applySetupSync,
  dropSetupSkills,
  isChecksum,
  scanned,
  setSetupSkillRemoved,
  skillName,
  skillWanted,
  syncChanges,
  syncPlan,
  takeSetupSkills,
  undoSetupSync,
} from './setupSync';

/**
 * Skill changes made straight away rather than chosen and reviewed later, and the ones that reach across machines:
 * - `add`: a skill goes in the setup repo (one machine's copy, as a commit), into every machine's store, which Codex
 *   loads, and on in every Claude Code home through a link to the store's copy;
 * - `remove`: the repo takes it off every machine, and it goes from every store and home;
 * - `on`, `off`: every Claude Code home that can load the store's copy turns it on, or off;
 * - `machine`: one machine's home changes, picked together.
 * Each machine's part is made with the same commands its pages use, so it's checked against what the last scan found,
 * backed up there first, and undone by putting those backups back, the last first.
 */
export type SkillPlanKind = 'add' | 'remove' | 'on' | 'off' | 'machine';

/** A copy of a skill the repo can take: a machine's store's (`agent` null), or a home's own. */
export type SkillCopy = { name: string; machine: string; home: string; agent: SkillHome['agent'] | null; path: string; sum: string };

/**
 * Why a machine or home is left as it is:
 * - `offHere`, `ownHere`: the repo keeps the skill off that machine, or lets it keep its own copy;
 * - `turnedOff`: the home's settings turn the skill off;
 * - `folderLink`: the home's whole skills folder is a link, which Arbor leaves alone;
 * - `storeLink`, `notSkill`: the store holds a link, or a folder without a SKILL.md, by that name;
 * - `linkElsewhere`: the home links to a copy somewhere else, or to nothing;
 * - `ownCopy`: the home has a copy of its own, unlike the store's, which turning off would lose;
 * - `notInStore`: the machine's store hasn't got it, so there's no copy for a home to link to.
 */
export type KeptReason = 'offHere' | 'ownHere' | 'turnedOff' | 'folderLink' | 'storeLink' | 'notSkill' | 'linkElsewhere' | 'ownCopy' | 'notInStore';
/** `home` is null for the whole machine, and `agent` null for its store. */
export type Kept = { name: string; home: string | null; agent: SkillHome['agent'] | null; reason: KeptReason };

/** One machine's part: store copies the repo's sync writes in or takes out, then its homes' changes. */
export type MachineSkillPlan = { machine: string; storeIn: string[]; storeOut: string[]; homes: PlannedSkill[]; kept: Kept[] };

export type SkillPlan = {
  kind: SkillPlanKind;
  names: string[];
  /** `add`: the copy each skill the repo hasn't got is taken from. */
  takes: SkillCopy[];
  /** `add`: each such skill's different copies, the one taken first. */
  copies: Record<string, SkillCopy[]>;
  /** `add`: skills the repo took off every machine, put back. */
  putBack: string[];
  /** `add`: skills with no copy anywhere the repo could take. */
  uncopied: string[];
  /** `remove`: skills the repo marks removed; one it took off already stays as it is. */
  marks: string[];
  machines: MachineSkillPlan[];
};

const COPY_PLACES = new Set(['own', 'copy', 'drifted']);

/**
 * A skill's copies the repo could take, different ones only, `first` machine's first and a store's before a home's:
 * real folders with a SKILL.md, not links.
 */
export function skillCopies(machines: SetupMachine[], name: string, first: string | null = null): SkillCopy[] {
  const ordered = [...machines].filter(scanned).sort((a, b) => Number(b.machine === first) - Number(a.machine === first));
  const copies: SkillCopy[] = [];
  for (const machine of ordered) {
    const row = skillsView(machine).rows.find((entry) => entry.name === name);
    if (!row) continue;
    for (const copy of rowCopies(machine.machine, row)) {
      if (!copies.some((other) => other.sum === copy.sum)) copies.push(copy);
    }
  }
  return copies;
}

/** One machine's copies of a skill the repo could take. */
function rowCopies(machine: string, row: SkillRow): SkillCopy[] {
  const found = [
    ...(row.storePlace === 'store' && row.store ? [{ home: STORE, agent: null, item: row.store }] : []),
    ...row.cells.filter((cell) => COPY_PLACES.has(cell.place)).map((cell) => ({ home: cell.home.path, agent: cell.home.agent, item: cell.item })),
  ];
  return found.flatMap(({ home, agent, item }) => !item?.path || !item.sum || item.skill?.hasDoc === false
    ? []
    : [{ name: row.name, machine, home, agent, path: item.path, sum: item.sum }]);
}

/**
 * The skills some machine has a copy of the repo could take, read once for a whole table: a skill that's only ever a
 * link or a folder without a SKILL.md can't be added to the repo.
 */
export function takeableSkills(machines: SetupMachine[]): Set<string> {
  const names = new Set<string>();
  for (const machine of machines.filter(scanned)) {
    for (const row of skillsView(machine).rows) {
      if (!names.has(row.name) && rowCopies(machine.machine, row).length) names.add(row.name);
    }
  }
  return names;
}

const planned = (row: SkillRow, cell: SkillCell, action: SkillAction): PlannedSkill => ({ row, cell, action });

/**
 * What a kind of change does to one skill's homes on a machine. With `predict`, the store doesn't have the skill yet
 * and will by then, so a home with nothing is turned on and a home's own copy gives way to the store's.
 */
function homeSteps(kind: Exclude<SkillPlanKind, 'machine'>, row: SkillRow, predict: boolean): { homes: PlannedSkill[]; kept: Kept[] } {
  const homes: PlannedSkill[] = [];
  const kept: Kept[] = [];
  const keep = (cell: SkillCell, reason: KeptReason) => kept.push({ name: row.name, home: cell.home.path, agent: cell.home.agent, reason });
  for (const cell of row.cells) {
    const { place } = cell;
    if (cell.home.folderLink) {
      if (cell.item) keep(cell, 'folderLink');
      continue;
    }
    if (kind === 'remove') {
      if (place === 'none' || place === 'off' || place === 'loads') continue;
      homes.push(planned(row, cell, 'remove'));
      continue;
    }
    if (cell.home.agent === 'codex') {
      // Codex loads the store's copy itself, so one of its own is a second copy once the store has it.
      if (kind === 'add' && (place === 'copy' || place === 'linked' || place === 'drifted' || (predict && place === 'own'))) homes.push(planned(row, cell, 'remove'));
      continue;
    }
    if (kind === 'off') {
      if (isTurnedOff(cell)) continue;
      if (place === 'linked' || place === 'copy') homes.push(planned(row, cell, 'remove'));
      else if (place === 'drifted' || place === 'own') keep(cell, 'ownCopy');
      continue;
    }
    if (place === 'linked' || place === 'viaFolder') continue;
    if (isTurnedOff(cell)) {
      if (place !== 'none') keep(cell, 'turnedOff');
      continue;
    }
    if (place === 'off' || (predict && place === 'none')) homes.push(planned(row, cell, 'link'));
    else if (kind === 'add' && (place === 'copy' || place === 'drifted' || (predict && place === 'own'))) homes.push(planned(row, cell, 'useStore'));
    else if (place === 'elsewhere' || place === 'broken') keep(cell, 'linkElsewhere');
    else if (place === 'notSkill') keep(cell, 'notSkill');
  }
  return { homes, kept };
}

/** The repo's own value for a skill on a machine, as `offHere` or `ownHere` when it has one. */
function repoKeeps(repo: SetupRepo | null, machine: string, name: string): KeptReason | null {
  const wanted = repo ? skillWanted(repo, `${STORE}/${name}`, machine) : undefined;
  return wanted === 'off' ? 'offHere' : wanted === 'own' ? 'ownHere' : null;
}

function planMachine(
  kind: Exclude<SkillPlanKind, 'machine'>,
  machine: SetupMachine,
  names: string[],
  repo: SetupRepo | null,
  takes: SkillCopy[],
  putBack: readonly string[],
): MachineSkillPlan {
  const view = skillsView(machine, kind === 'add' ? names : []);
  const plan: MachineSkillPlan = { machine: machine.machine, storeIn: [], storeOut: [], homes: [], kept: [] };
  for (const name of names) {
    const row = view.rows.find((entry) => entry.name === name);
    if (!row) continue;
    const trace = row.store !== null || row.cells.some((cell) => cell.place !== 'none' && cell.place !== 'off' && cell.place !== 'loads');
    const repoKept = kind === 'add' || kind === 'remove' ? repoKeeps(repo, machine.machine, name) : null;
    // Taking it off every machine leaves alone one that keeps its own; putting it on leaves one it's kept off.
    if (repoKept === 'ownHere' || (repoKept === 'offHere' && kind === 'add')) {
      if (trace || kind === 'add') plan.kept.push({ name, home: null, agent: null, reason: repoKept });
      continue;
    }
    const store = row.store;
    let predict = false;
    if (kind === 'add') {
      if (store?.link) {
        plan.kept.push({ name, home: STORE, agent: null, reason: 'storeLink' });
        continue;
      }
      if (store && (store.sum === null || store.skill?.hasDoc === false)) {
        plan.kept.push({ name, home: STORE, agent: null, reason: 'notSkill' });
        continue;
      }
      const inRepo = repo?.skills.find((skill) => skill.name === name) ?? null;
      const taken = takes.find((take) => take.name === name) ?? null;
      const wanted = inRepo ? (store?.sum && isChecksum(store.sum) ? inRepo.ck : inRepo.sum) : taken?.sum ?? null;
      // What the repo puts back isn't known until it has, so only a store without it is sure to change.
      if (!store || (!putBack.includes(name) && store.sum !== wanted)) {
        plan.storeIn.push(name);
        predict = !store;
      }
    } else if (kind === 'remove') {
      if (store?.link) plan.kept.push({ name, home: STORE, agent: null, reason: 'storeLink' });
      else if (store?.sum) plan.storeOut.push(name);
    } else if (row.storePlace !== 'store') {
      if (trace) plan.kept.push({ name, home: STORE, agent: null, reason: 'notInStore' });
      continue;
    }
    const steps = homeSteps(kind, row, predict);
    plan.homes.push(...steps.homes);
    plan.kept.push(...steps.kept);
  }
  return plan;
}

/** What a change across machines would do, against each machine's last scan and the repo as it stands. */
export function planSkills(
  kind: Exclude<SkillPlanKind, 'machine'>,
  names: string[],
  machines: SetupMachine[],
  repo: SetupRepo | null,
  first: string | null = null,
  chosen: Record<string, SkillCopy> = {},
): SkillPlan {
  const read = machines.filter(scanned);
  const inRepo = new Set(repo?.skills.map((skill) => skill.name) ?? []);
  const removed = new Set(repo?.removedSkills ?? []);
  const copies: Record<string, SkillCopy[]> = {};
  const takes: SkillCopy[] = [];
  const putBack: string[] = [];
  const uncopied: string[] = [];
  if (kind === 'add') {
    for (const name of names.filter((entry) => !inRepo.has(entry))) {
      const found = skillCopies(read, name, first);
      copies[name] = found;
      // The repo puts back the copy it had; one from a machine is only taken if it hadn't one.
      if (removed.has(name)) {
        putBack.push(name);
        continue;
      }
      const pick = found.find((copy) => copy.path === chosen[name]?.path && copy.machine === chosen[name]?.machine) ?? found[0];
      if (pick) takes.push(pick);
      else uncopied.push(name);
    }
  }
  const going = kind === 'add' ? names.filter((name) => !uncopied.includes(name)) : names;
  const plans = read.map((machine) => planMachine(kind, machine, going, repo, takes, putBack));
  return {
    kind,
    names: going,
    takes,
    copies,
    putBack,
    uncopied,
    marks: kind === 'remove' ? names.filter((name) => !removed.has(name)) : [],
    machines: plans.filter((plan) => plan.storeIn.length || plan.storeOut.length || plan.homes.length || plan.kept.length),
  };
}

/** One machine's home changes, picked together on its page. */
export const machinePlan = (machine: string, changes: PlannedSkill[]): SkillPlan => ({
  kind: 'machine',
  names: [...new Set(changes.map((change) => change.row.name))],
  takes: [],
  copies: {},
  putBack: [],
  uncopied: [],
  marks: [],
  machines: [{ machine, storeIn: [], storeOut: [], homes: changes, kept: [] }],
});

/** How many changes a plan makes: commits in the repo, store copies and homes. */
export function planSize(plan: SkillPlan): { commits: number; machines: number; changes: number } {
  const changes = plan.machines.reduce((sum, machine) => sum + machine.storeIn.length + machine.storeOut.length + machine.homes.length, 0);
  const commits = plan.kind === 'add' ? new Set(plan.takes.map((take) => take.machine)).size + plan.putBack.length : plan.marks.length;
  return { commits, machines: plan.machines.filter((machine) => machine.storeIn.length + machine.storeOut.length + machine.homes.length > 0).length, changes };
}

/** Why a machine's part didn't get made, or wasn't all made. */
export type RunProblem =
  | { kind: 'changed'; paths: string[] }
  | { kind: 'failed'; paths: string[] }
  | { kind: 'unread' }
  | { kind: 'error'; detail: string };
export type RunPhase = 'waiting' | 'running' | 'done' | 'failed';
export type SkillRunProgress = {
  repo: RunPhase | null;
  repoError: string | null;
  machines: Record<string, { phase: RunPhase; problem: RunProblem | null }>;
};

/** A commit a run made in the repo: a skill taken from a machine, put back, or taken off every machine. */
export type RepoStep = { name: string; step: 'taken' | 'putBack' | 'removed' };

/** What a run did, for Undo: each machine's backups in the order they were made, and the repo's commits. */
export type SkillRunDone = {
  kind: SkillPlanKind;
  names: string[];
  repo: string | null;
  repoSteps: RepoStep[];
  backups: { machine: string; backup: string }[];
  problems: Record<string, RunProblem>;
  repoError: string | null;
  /** The machines a write was sent to; only those are read again, so only their rows wait for it. */
  touched: string[];
};

export const runSucceeded = (done: SkillRunDone) => done.repoError === null && !Object.keys(done.problems).length;

const problemOf = (outcome: SyncOutcome): RunProblem | null => {
  const changed = outcome.failed.filter((failure) => failure.reason === 'changed').map((failure) => failure.path);
  if (changed.length) return { kind: 'changed', paths: changed };
  const failed = outcome.failed.map((failure) => failure.path);
  return failed.length ? { kind: 'failed', paths: failed } : null;
};

/** How long a run waits for a machine to be read again after its store changed. */
const READ_AGAIN_MS = 120_000;
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * The machine once a scan has found `ready` true of it. A change starts a scan, but one already under way when it
 * was made lands first with what it found before, so the scan's time alone doesn't say the change has been read.
 */
async function readAgain(machine: string, ready: (entry: SetupMachine) => boolean): Promise<SetupMachine | null> {
  const until = Date.now() + READ_AGAIN_MS;
  for (;;) {
    const entry = (await fetchSetupInventory()).machines.find((candidate) => candidate.machine === machine);
    if (entry && !entry.scanning && ready(entry)) return entry;
    if (Date.now() > until) return null;
    await sleep(700);
  }
}

/** The store skills the repo's sync would write in, or take out, of `names`. */
function storeChanges(repo: SetupRepo, machine: SetupMachine, names: ReadonlySet<string>, remove: boolean) {
  const files = syncPlan(repo, machine).filter((file) => file.kind === 'skill' && names.has(skillName(file.path))
    && (remove ? file.state === 'removed' : file.state === 'add' || file.state === 'update'));
  return syncChanges(files);
}

/** A machine's home changes for `names`, worked out again from its latest scan, as the backend will check them. */
function homeChanges(kind: Exclude<SkillPlanKind, 'machine'>, machine: SetupMachine, names: string[], repo: SetupRepo | null) {
  const view = skillsView(machine);
  const pending: PendingSkills = {};
  for (const name of names) {
    const row = view.rows.find((entry) => entry.name === name);
    if (!row || ((kind === 'add' || kind === 'remove') && repoKeeps(repo, machine.machine, name) === 'ownHere')) continue;
    if (kind === 'add' && repoKeeps(repo, machine.machine, name) === 'offHere') continue;
    for (const change of homeSteps(kind, row, false).homes) pending[changeKey(change.cell.home.path, name)] = change.action;
  }
  return { view, settled: settleSkills(view, pending) };
}

/** An add of skills the repo has already, which only puts them on the machines missing them. */
export const putsOnly = (plan: Pick<SkillPlan, 'kind' | 'takes' | 'putBack'>) => plan.kind === 'add' && !plan.takes.length && !plan.putBack.length;

/** Makes a plan, the repo's part first, then every machine's side by side; `onProgress` hears each step. */
export async function runSkillPlan(plan: SkillPlan, repo: SetupRepo | null, onProgress: (progress: SkillRunProgress) => void): Promise<SkillRunDone> {
  const repoStep = (plan.kind === 'add' && !putsOnly(plan)) || plan.marks.length > 0;
  const progress: SkillRunProgress = {
    repo: repoStep ? 'waiting' : null,
    repoError: null,
    machines: Object.fromEntries(plan.machines.map((machine) => [machine.machine, { phase: 'waiting' as RunPhase, problem: null }])),
  };
  const report = () => onProgress({ ...progress, machines: { ...progress.machines } });
  // Only what it changes, so a skill left out (no copy to take) isn't counted as done.
  const done: SkillRunDone = { kind: plan.kind, names: touchedSkills(plan), repo: repo?.path ?? null, repoSteps: [], backups: [], problems: {}, repoError: null, touched: [] };
  let current = repo;

  if (repoStep) {
    progress.repo = 'running';
    report();
    try {
      if (!repo) throw new Error('no setup repo');
      if (plan.kind === 'add') {
        const takes = [...plan.takes];
        for (const name of plan.putBack) {
          current = await setSetupSkillRemoved(repo.path, name, false);
          done.repoSteps.push({ name, step: 'putBack' });
          // Marked removed without the repo ever having had it: a machine's copy goes in instead.
          const copy = plan.copies[name]?.[0];
          if (!current.skills.some((skill) => skill.name === name) && copy) takes.push(copy);
        }
        const byMachine = new Map<string, SkillCopy[]>();
        for (const take of takes) byMachine.set(take.machine, [...(byMachine.get(take.machine) ?? []), take]);
        for (const [machine, taken] of byMachine) {
          current = await takeSetupSkills(repo.path, machine, taken.map((take) => take.path));
          done.repoSteps.push(...taken.map((take) => ({ name: take.name, step: 'taken' as const })));
        }
      } else {
        // One taken off already stays off, and Undo leaves it that way.
        for (const name of plan.marks) {
          current = await setSetupSkillRemoved(repo.path, name, true);
          done.repoSteps.push({ name, step: 'removed' });
        }
      }
      progress.repo = 'done';
    } catch (error) {
      progress.repo = 'failed';
      progress.repoError = String(error);
      done.repoError = String(error);
      report();
      return done;
    }
    report();
  }

  const latest = new Map((await fetchSetupInventory()).machines.map((machine) => [machine.machine, machine]));
  const names = new Set(plan.names);
  await Promise.all(plan.machines.map(async ({ machine: name, homes }) => {
    const set = (phase: RunPhase, problem: RunProblem | null = null) => {
      progress.machines[name] = { phase, problem };
      if (problem) done.problems[name] = problem;
      report();
    };
    const made = (outcome: SyncOutcome) => {
      if (!done.touched.includes(name)) done.touched.push(name);
      if (outcome.backup) done.backups.push({ machine: name, backup: outcome.backup });
      const problem = problemOf(outcome);
      if (problem) set('failed', problem);
      return problem === null;
    };
    let machine = latest.get(name) ?? null;
    if (!machine) return set('failed', { kind: 'unread' });
    set('running');
    try {
      if (plan.kind === 'machine') {
        const pending: PendingSkills = Object.fromEntries(homes.map((change) => [changeKey(change.cell.home.path, change.row.name), change.action]));
        const view = skillsView(machine);
        const changes = skillChanges(view, settleSkills(view, pending));
        if (changes?.length && !made(await applySkillChanges(name, changes))) return undefined;
        return set('done');
      }
      const kind = plan.kind;
      if (kind === 'add' && current?.head) {
        const writes = storeChanges(current, machine, names, false);
        if (writes.length) {
          if (!made(await applySetupSync(current.path, current.head.sha, name, writes))) return undefined;
          const after = current;
          machine = await readAgain(name, (entry) => storeChanges(after, entry, names, false).length === 0);
          if (!machine) return set('failed', { kind: 'unread' });
        }
      }
      const { view, settled } = homeChanges(kind, machine, plan.names, current);
      const changes = skillChanges(view, settled);
      if (changes?.length && !made(await applySkillChanges(name, changes))) return undefined;
      // A store copy goes once no home links to it.
      if (kind === 'remove' && current?.head) {
        const removals = storeChanges(current, machine, names, true);
        if (removals.length && !made(await applySetupSync(current.path, current.head.sha, name, removals))) return undefined;
      }
      return set('done');
    } catch (error) {
      return set('failed', { kind: 'error', detail: String(error) });
    }
  }));
  return done;
}

/** What undoing a run couldn't put back. */
export type UndoProblems = { machines: Record<string, RunProblem>; repoError: string | null };

/** Puts back what a run did: each machine's changes the last first, then the repo's. */
export async function undoSkillRun(done: SkillRunDone): Promise<UndoProblems> {
  const problems: UndoProblems = { machines: {}, repoError: null };
  const byMachine = new Map<string, string[]>();
  for (const { machine, backup } of done.backups) byMachine.set(machine, [...(byMachine.get(machine) ?? []), backup]);
  await Promise.all([...byMachine].map(async ([machine, backups]) => {
    try {
      for (const backup of [...backups].reverse()) {
        const problem = problemOf(await undoSetupSync(machine, backup));
        if (problem) {
          problems.machines[machine] = problem;
          return;
        }
      }
    } catch (error) {
      problems.machines[machine] = { kind: 'error', detail: String(error) };
    }
  }));
  const repo = done.repo;
  if (repo && done.repoSteps.length) {
    try {
      const taken = done.repoSteps.filter((step) => step.step === 'taken').map((step) => step.name);
      if (taken.length) await dropSetupSkills(repo, taken);
      for (const { name, step } of [...done.repoSteps].reverse()) {
        if (step === 'putBack') await setSetupSkillRemoved(repo, name, true);
        else if (step === 'removed') await setSetupSkillRemoved(repo, name, false);
      }
    } catch (error) {
      problems.repoError = String(error);
    }
  }
  return problems;
}

export const undoSucceeded = (problems: UndoProblems) => problems.repoError === null && !Object.keys(problems.machines).length;

/**
 * Skills being changed, by machine and name, and when: a row waits until its change is made and the machine has been
 * read again, since a change is checked against the last scan.
 */
type Activity = Readonly<Record<string, { running: boolean; since: number }>>;
let activity: Activity = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => activity;
export const useSkillActivity = () => useSyncExternalStore(subscribe, snapshot, snapshot);

const activityKey = (machine: string, name: string) => `${machine}\u0000${name}`;

function markActivity(keys: { machine: string; name: string }[], running: boolean, touched?: ReadonlySet<string>) {
  const at = Date.now();
  const next: Record<string, { running: boolean; since: number }> = {};
  // Ones whose machine has long been read again are let go.
  for (const [key, entry] of Object.entries(activity)) if (at - entry.since < 10 * 60_000) next[key] = entry;
  for (const { machine, name } of keys) {
    const key = activityKey(machine, name);
    // A machine nothing was written to isn't read again, so its rows would otherwise wait for good.
    if (!running && touched && !touched.has(machine)) delete next[key];
    else next[key] = { running, since: running ? at : next[key]?.since ?? at };
  }
  activity = next;
  listeners.forEach((listener) => listener());
}

/** The skills a plan changes, on each machine it reaches. */
export const planKeys = (plan: SkillPlan) => plan.machines.flatMap((machine) => plan.names.map((name) => ({ machine: machine.machine, name })));

export const startActivity = (keys: { machine: string; name: string }[]) => markActivity(keys, true);
/** Ends a change; with `touched`, rows on machines outside it are let go at once rather than waiting for a scan. */
export const endActivity = (keys: { machine: string; name: string }[], touched?: Iterable<string>) => markActivity(keys, false, touched ? new Set(touched) : undefined);

/** Whether a skill on a machine is being changed, or was and the machine hasn't been read since. */
export function isBusy(current: Activity, machine: SetupMachine, name: string): boolean {
  const entry = current[activityKey(machine.machine, name)];
  if (!entry) return false;
  return entry.running || machine.scanning || (machine.scannedAt ?? 0) < entry.since;
}

/** Makes one pick in one home straight away, the way its cell's menu offers it; null when the last scan no longer allows it. */
export async function applySkillPick(machine: string, view: SkillsView, row: SkillRow, cell: SkillCell, action: SkillAction): Promise<SyncOutcome | null> {
  const changes = skillChanges(view, { [changeKey(cell.home.path, row.name)]: action });
  if (!changes?.length) return null;
  const keys = [{ machine, name: row.name }];
  startActivity(keys);
  try {
    return await applySkillChanges(machine, changes);
  } finally {
    endActivity(keys);
  }
}

/**
 * What one machine's ticked skills can have done in its homes, all at once:
 * - `link`: turned on in each Claude Code home that hasn't it on;
 * - `turnOff`: turned off in each Claude Code home linking to the store's copy;
 * - `useStore`: each Claude Code home's copy gives way to a link to the store's;
 * - `codexTwice`: Codex's second copies of store skills go, since it loads the store's.
 */
export type BulkHomeKind = 'link' | 'turnOff' | 'useStore' | 'codexTwice';

export function bulkHomeChanges(view: SkillsView, names: ReadonlySet<string>, kind: BulkHomeKind): PlannedSkill[] {
  const action: SkillAction = kind === 'turnOff' || kind === 'codexTwice' ? 'remove' : kind;
  return view.rows.filter((row) => names.has(row.name)).flatMap((row) => row.cells.flatMap((cell) => {
    const fits = kind === 'codexTwice'
      ? cell.home.agent === 'codex' && row.storePlace === 'store' && (cell.place === 'copy' || cell.place === 'linked')
      : cell.home.agent === 'claude' && !isTurnedOff(cell) && (kind === 'link' ? cell.place === 'off' : kind === 'turnOff' ? cell.place === 'linked' : cell.place === 'copy' || cell.place === 'drifted');
    return fits && cellOptions(row, cell).includes(action) ? [planned(row, cell, action)] : [];
  }));
}

/** The skills a plan does something to: put in or out of the repo, or changed on a machine. */
export function touchedSkills(plan: SkillPlan): string[] {
  const touched = new Set([...plan.takes.map((take) => take.name), ...plan.putBack, ...plan.marks]);
  for (const machine of plan.machines) {
    for (const name of [...machine.storeIn, ...machine.storeOut]) touched.add(name);
    for (const change of machine.homes) touched.add(change.row.name);
  }
  return plan.names.filter((name) => touched.has(name));
}

/**
 * Ticks or unticks a row, or with `range` every row from the last one ticked to this one, in the order shown, the
 * way this one went.
 */
export function tickRows(order: readonly string[], selected: ReadonlySet<string>, anchor: string | null, name: string, on: boolean, range: boolean): ReadonlySet<string> {
  const next = new Set(selected);
  const from = range && anchor !== null ? order.indexOf(anchor) : -1;
  const to = order.indexOf(name);
  const span = from >= 0 && to >= 0 ? order.slice(Math.min(from, to), Math.max(from, to) + 1) : [name];
  for (const entry of span) {
    if (on) next.add(entry);
    else next.delete(entry);
  }
  return next;
}

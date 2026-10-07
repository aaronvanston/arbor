import { mcpSummary } from './mcpGrid';
import { machineColumns } from './pluginGrid';
import { planSkills, runSkillPlan, undoSkillRun, type RunProblem } from './skillRuns';
import { applyHooks, hookChanges, setHookWanted, takeHook } from './setupHooks';
import { applyMcpChanges, mcpChanges, plannedMcp, putBackMcpServer, setMcpWanted, takeMcpServer, withRegistry, type PendingMcp } from './setupMcp';
import { codexRepoChanges, differs, repoAction, setSetupCodexPlugin, setSetupPlugin, wantedOn, withCodexPluginRepo, withPluginRepo } from './setupPluginRepo';
import { applyCodexPluginChanges, applyPluginChanges, extensionsView, type ExtensionsView, type PluginCell, type PluginRow } from './setupPlugins';
import { applySetupSync, getSetupRepo, setSetupFileMachine, setSetupFileOff, setSetupFileRemoved, setSetupSkillMachine, setSetupSkillOff, syncChanges, syncPlan, undoSetupSync } from './setupSync';
import { skillsView, STORE } from './setupSkills';
import { machineLookKey } from './machineLook';
import type { LibraryRow, LibraryToggle } from './library';
import type { HookRegistry, McpRegistry, PluginAction, PluginResult, PluginWanted, RepoPlugin, SetupMachine, SetupRepo, SyncFailure } from '../native/types';

/**
 * A Library switch, made straight away: the repo's word for every machine committed, then each machine that answers
 * brought in line with it, one machine after another. What was done is kept so Undo can put it all back.
 */

/**
 * One change made in one home, as the plugin commands take it. `wasOff` marks an uninstall of a plugin that was turned
 * off there, so putting it back turns it off again.
 */
export type DoneChange = { machine: string; home: string; action: PluginAction; target: string; source: string | null; wasOff?: boolean };

/** A change's outcome, with the machine it was made on. */
export type MachineResult = PluginResult & { machine: string };

export type ToggleRun = {
  /** The repo's listing before, null when it didn't list it, which Undo restores. */
  before: PluginWanted | null;
  done: DoneChange[];
  /** Changes a machine didn't make, with what it said. */
  failed: MachineResult[];
  /** Installs that run a command the marketplace declares, which nobody accepts on the user's behalf. */
  needsYou: MachineResult[];
  /** Machines that didn't answer, left for Overview's Bring in line. */
  skipped: string[];
  repo: SetupRepo;
};

/** The row as the repo's new listing has it: each cell's value and whether it differs. */
export function relisted(row: PluginRow, plugin: RepoPlugin | null): PluginRow {
  if (!plugin) return { ...row, repo: null, cells: row.cells.map((cell) => ({ ...cell, wanted: null })) };
  return {
    ...row,
    repo: plugin,
    cells: row.cells.map((cell): PluginCell => {
      const { value, own } = wantedOn(plugin, cell.home.machine);
      return { ...cell, wanted: { value, own, differs: differs(cell.place, value) } };
    }),
  };
}

/**
 * The changes that bring each machine's homes in line with the row's listing, by machine. A Claude Code install
 * whose home hasn't the marketplace adds it first when its GitHub repository is known, as the plugin review does.
 */
export function lineUp(row: PluginRow, codex: boolean): Map<string, DoneChange[]> {
  const byMachine = new Map<string, DoneChange[]>();
  const added = new Set<string>();
  for (const cell of row.cells) {
    if (!cell.home.reachable) continue;
    const { machine, path: home } = cell.home;
    const actions = codex ? codexRepoChanges(row, cell) : [repoAction(row, cell)].filter((action): action is PluginAction => action !== null);
    const changes: DoneChange[] = [];
    for (const action of actions) {
      if (action === 'addMarketplace') {
        changes.push({ machine, home, action, target: row.marketplace, source: row.source });
        continue;
      }
      const needs = `${machine}\u0000${home}`;
      if (!codex && action === 'install' && !cell.hasMarketplace && row.source && !added.has(needs)) {
        changes.push({ machine, home, action: 'addMarketplace', target: row.marketplace, source: row.source });
        added.add(needs);
      }
      changes.push({ machine, home, action, target: row.id, source: null, ...(action === 'uninstall' && cell.place === 'off' ? { wasOff: true } : {}) });
    }
    if (changes.length) byMachine.set(machine, [...(byMachine.get(machine) ?? []), ...changes]);
  }
  return byMachine;
}

async function applyOn(machine: string, changes: DoneChange[], codex: boolean): Promise<PluginResult[]> {
  const asChanges = changes.map(({ home, action, target, source }) => ({ home, action, target, ...(source && action === 'addMarketplace' ? { source } : {}) }));
  return codex ? applyCodexPluginChanges(machine, asChanges) : applyPluginChanges(machine, asChanges);
}

const fleetOf = (row: PluginRow) => [...new Set(row.cells.map((cell) => cell.home.machine))];
const unreachable = (row: PluginRow) => fleetOf(row).filter((machine) => row.cells.some((cell) => cell.home.machine === machine && !cell.home.reachable));

/** Runs each machine's changes, collecting what each made, didn't, or left to the user. */
async function runChanges(byMachine: Map<string, DoneChange[]>, codex: boolean): Promise<Pick<ToggleRun, 'done' | 'failed' | 'needsYou'>> {
  const done: DoneChange[] = [];
  const failed: MachineResult[] = [];
  const needsYou: MachineResult[] = [];
  for (const [machine, changes] of byMachine) {
    let results: PluginResult[];
    try {
      results = await applyOn(machine, changes, codex);
    } catch (error) {
      failed.push(...changes.map((change): MachineResult => ({ machine, home: change.home, action: change.action, target: change.target, checkout: null, outcome: 'failed', message: String(error) })));
      continue;
    }
    for (const result of results) {
      const change = changes.find((entry) => entry.home === result.home && entry.action === result.action && entry.target === result.target);
      if (result.outcome === 'done' && change) done.push(change);
      else if (result.outcome === 'needsYou') needsYou.push({ ...result, machine });
      else if (result.outcome === 'failed') failed.push({ ...result, machine });
    }
  }
  return { done, failed, needsYou };
}

const setListing = (repo: string, row: PluginRow, codex: boolean, wanted: PluginWanted | null) =>
  (codex ? setSetupCodexPlugin : setSetupPlugin)(repo, row.id, row.source, null, wanted);
const listingOf = (repo: SetupRepo, row: PluginRow, codex: boolean) => (codex ? repo.codexPlugins : repo.plugins).find((plugin) => plugin.id === row.id) ?? null;

/** Turns a plugin on or off for every machine: the repo first, then the machines that answer. */
export async function togglePlugin(repo: string, row: PluginRow, codex: boolean, on: boolean): Promise<ToggleRun> {
  const before = row.repo?.all ?? null;
  const next = await setListing(repo, row, codex, on ? 'on' : 'off');
  const ran = await runChanges(lineUp(relisted(row, listingOf(next, row, codex)), codex), codex);
  return { before, ...ran, skipped: unreachable(row), repo: next };
}

/** What takes a change back. A marketplace added along the way stays, since other plugins may come from it. */
const INVERSE: Partial<Record<PluginAction, PluginAction>> = { install: 'uninstall', uninstall: 'install', enable: 'disable', disable: 'enable' };

/**
 * The changes that take `done` back, the last first, by machine: each home is put back as it was, and only the homes
 * that were changed. A plugin that was off when it was uninstalled goes back in turned off.
 */
export function inverseChanges(done: DoneChange[]): Map<string, DoneChange[]> {
  const byMachine = new Map<string, DoneChange[]>();
  for (const change of [...done].reverse()) {
    const action = INVERSE[change.action];
    if (!action) continue;
    const back: DoneChange[] = [{ machine: change.machine, home: change.home, action, target: change.target, source: change.source }];
    if (action === 'install' && change.wasOff) back.push({ machine: change.machine, home: change.home, action: 'disable', target: change.target, source: null });
    byMachine.set(change.machine, [...(byMachine.get(change.machine) ?? []), ...back]);
  }
  return byMachine;
}

/** Puts back what a switch did: the repo's listing as it was, then each change made, undone in reverse. */
export async function undoToggle(repo: string, row: PluginRow, codex: boolean, run: ToggleRun): Promise<{ repo: SetupRepo; failed: MachineResult[] }> {
  const next = await setListing(repo, row, codex, run.before);
  const { failed } = await runChanges(inverseChanges(run.done), codex);
  return { repo: next, failed };
}

// ---------------------------------------------------------------------------
// Every kind's switch
// ---------------------------------------------------------------------------

/**
 * A machine a switch couldn't change, with what it said. A file change it refused carries why (`reason`, as the sync
 * commands give it) and the paths, so the screen says it in words rather than the bare reason.
 */
export type SwitchFailure = { machine: string; message: string; reason?: SyncReason; paths?: string[] };

/** Why a guarded file change wasn't made: changed since the scan, couldn't be written, deleted for good, or not read. */
export type SyncReason = 'changed' | 'failed' | 'deleted' | 'unread';

const SYNC_REASONS: readonly string[] = ['changed', 'failed', 'deleted'];

/** A file the sync commands didn't change, as a switch's failure. */
export const fromSync = (machine: string, entry: SyncFailure): SwitchFailure =>
  SYNC_REASONS.includes(entry.reason)
    ? { machine, message: entry.reason, reason: entry.reason as SyncReason, paths: [entry.path] }
    : { machine, message: entry.reason, paths: [entry.path] };

/** What a switch changed and the sources it read back, so the Library shows the new state without another read. */
export type SwitchSources = { repo?: SetupRepo; registry?: McpRegistry; hooks?: HookRegistry };

export type LibrarySwitch = SwitchSources & {
  /** Machines changed. */
  changed: string[];
  failed: SwitchFailure[];
  /** Machines where a plugin's install waits on its user. */
  needsYou: string[];
  /** Machines that didn't answer, left for Overview's Bring in line. */
  skipped: string[];
  /** Puts the repo's word back, then each machine as it was. */
  undo: () => Promise<SwitchSources & UndoResult>;
};

/** What an Undo couldn't put back: each machine's, and the repo's own when taking a change back out of it failed. */
export type UndoResult = { failed: SwitchFailure[]; repoError?: string | null };

const unique = (values: string[]) => [...new Set(values)];

/**
 * How a change went, for its title: done, done but not on some machines, or made on none of the machines it tried.
 * `failedOn` names the machines that failed, in order.
 */
export function switchVerdict(changed: string[], failed: SwitchFailure[]): { verdict: 'done' | 'partly' | 'none'; failedOn: string[] } {
  const failedOn = unique(failed.map((entry) => entry.machine));
  if (!failedOn.length) return { verdict: 'done', failedOn };
  return { verdict: changed.length ? 'partly' : 'none', failedOn };
}
const reachableMachines = (machines: SetupMachine[]) => machines.filter((machine) => machine.reachable);
const unreachableOf = (machines: SetupMachine[], among: (machine: SetupMachine) => boolean) =>
  machines.filter((machine) => !machine.reachable && among(machine)).map((machine) => machine.machine);
const failure = (machine: string, error: unknown): SwitchFailure => ({ machine, message: String(error) });

/** Brings each answering machine's homes in line with the registry's word on one server. */
async function lineUpServer(repo: string, machines: SetupMachine[], registry: McpRegistry, name: string, only: string | null = null) {
  const found = registry.found && registry.problems.length === 0;
  const view = withRegistry(extensionsView(machines), registry);
  const row = view.servers.find((entry) => entry.name === name);
  const changed: string[] = [];
  const failed: SwitchFailure[] = [];
  if (!row || !registry.commit) return { changed, failed };
  const pending: PendingMcp = {};
  for (const column of machineColumns(view.mcpHomes)) {
    if (column.reachable && (only === null || column.machine === only)) Object.assign(pending, mcpSummary(row, column, found, {}).toRepo);
  }
  for (const [machine, planned] of plannedMcp({ ...view, servers: [row] }, pending)) {
    try {
      const results = await applyMcpChanges(repo, registry.commit, machine, mcpChanges(planned));
      if (results.some((result) => result.outcome === 'done' || result.outcome === 'removed')) changed.push(machine);
      failed.push(...results.filter((result) => result.outcome === 'failed' || result.outcome === 'changed').map((result) => ({ machine, message: result.message })));
    } catch (error) {
      failed.push(failure(machine, error));
    }
  }
  return { changed, failed };
}

/** Turns an MCP server on or off for every machine, its definitions kept either way. */
export async function switchServer(repo: string, machines: SetupMachine[], name: string, on: boolean): Promise<LibrarySwitch> {
  const registry = await setMcpWanted(repo, name, null, on ? 'default' : 'off');
  const ran = await lineUpServer(repo, machines, registry, name);
  const has = (machine: SetupMachine) => machine.homes.some((home) => home.items.some((item) => item.kind === 'mcp' && item.name === name));
  return {
    registry,
    ...ran,
    needsYou: [],
    skipped: unreachableOf(machines, (machine) => on || has(machine)),
    undo: async () => {
      const back = await setMcpWanted(repo, name, null, on ? 'off' : 'default');
      return { registry: back, failed: (await lineUpServer(repo, machines, back, name)).failed };
    },
  };
}

/**
 * Brings each answering machine with a home out of step on the hook in line: its hooks, as the repo has them, keeping
 * each settings file's backup so Undo puts back what the machine had.
 */
async function lineUpHook(repo: string, machines: SetupMachine[], registry: HookRegistry, name: string, only: string | null = null) {
  const changed: string[] = [];
  const failed: SwitchFailure[] = [];
  const backups: { machine: string; backup: string }[] = [];
  if (!registry.commit) return { changed, failed, backups };
  for (const machine of reachableMachines(machines)) {
    if (only !== null && machine.machine !== only) continue;
    if (!hookChanges(registry, machine.machine).some((cell) => cell.name === name)) continue;
    try {
      const edits = await applyHooks(repo, registry.commit, machine.machine);
      if (edits.some((edit) => edit.written)) changed.push(machine.machine);
      // Claude Code's and Codex's homes are written apart, each with its own backup.
      for (const backup of unique(edits.flatMap((edit) => (edit.backup ? [edit.backup] : [])))) backups.push({ machine: machine.machine, backup });
      failed.push(...edits.flatMap((edit) => (edit.error ? [{ machine: machine.machine, message: edit.error }] : [])));
    } catch (error) {
      failed.push(failure(machine.machine, error));
    }
  }
  return { changed, failed, backups };
}

/** Puts back every machine's backups, the last first. */
async function undoAllBackups(backups: { machine: string; backup: string }[]): Promise<SwitchFailure[]> {
  const failed: SwitchFailure[] = [];
  for (const { machine, backup } of [...backups].reverse()) failed.push(...await undoBackups(machine, [backup]));
  return failed;
}

/** Turns a hook on or off for every machine, kept in the repo either way. */
export async function switchHook(repo: string, machines: SetupMachine[], name: string, on: boolean): Promise<LibrarySwitch> {
  const hooks = await setHookWanted(repo, name, null, on ? 'default' : 'off');
  const ran = await lineUpHook(repo, machines, hooks, name);
  return {
    hooks,
    ...ran,
    needsYou: [],
    skipped: unreachableOf(machines, (machine) => hooks.cells.some((cell) => cell.machine === machine.machine && cell.name === name && cell.state !== 'same')),
    undo: async () => {
      // Each machine gets back the settings file it had, its own hooks with it, rather than the repo's word again.
      const failed = await undoAllBackups(ran.backups);
      return { hooks: await setHookWanted(repo, name, null, on ? 'off' : 'default'), failed };
    },
  };
}

/** What a skill run left undone, by machine. */
const runFailures = (problems: Record<string, RunProblem>): SwitchFailure[] =>
  Object.entries(problems).map(([machine, problem]): SwitchFailure => {
    if (problem.kind === 'error') return { machine, message: problem.detail };
    if (problem.kind === 'unread') return { machine, message: 'unread', reason: 'unread' };
    return { machine, message: problem.paths.join(', '), reason: problem.kind, paths: problem.paths };
  });

/**
 * Turns a skill on or off for every machine, kept in the repo either way: off takes it out of every Claude Code home
 * and every store, as removing it everywhere does; on puts it back in every store and turns it on in every home.
 */
export async function switchSkill(repo: string, machines: SetupMachine[], name: string, on: boolean): Promise<LibrarySwitch> {
  const next = await setSetupSkillOff(repo, name, !on);
  // The repo's word is set already, so the plan only changes the machines.
  const plan = { ...planSkills(on ? 'add' : 'remove', [name], reachableMachines(machines), next), marks: [] };
  const done = await runSkillPlan(plan, next, () => undefined);
  return {
    repo: next,
    changed: done.touched,
    failed: runFailures(done.problems),
    needsYou: [],
    skipped: unreachableOf(machines, () => true),
    undo: async () => {
      const problems = await undoSkillRun(done);
      const back = await setSetupSkillOff(repo, name, on);
      return { repo: back, failed: runFailures(problems.machines), repoError: problems.repoError };
    },
  };
}

/** Writes or takes out one file on each answering machine, as the repo now has it, keeping each machine's backup. */
async function lineUpFile(setup: SetupRepo, machines: SetupMachine[], path: string, only: string | null = null) {
  const changed: string[] = [];
  const failed: SwitchFailure[] = [];
  const backups: { machine: string; backup: string }[] = [];
  if (!setup.head) return { changed, failed, backups };
  for (const machine of reachableMachines(machines)) {
    if (only !== null && machine.machine !== only) continue;
    const changes = syncChanges(syncPlan(setup, machine).filter((file) => file.path === path));
    if (!changes.length) continue;
    try {
      const outcome = await applySetupSync(setup.path, setup.head.sha, machine.machine, changes);
      if (outcome.backup) backups.push({ machine: machine.machine, backup: outcome.backup });
      if (outcome.done.length) changed.push(machine.machine);
      failed.push(...outcome.failed.map((entry) => fromSync(machine.machine, entry)));
    } catch (error) {
      failed.push(failure(machine.machine, error));
    }
  }
  return { changed, failed, backups };
}

/** Turns a rule, subagent or command on or off for every machine, kept in the repo either way. */
export async function switchFile(repo: string, machines: SetupMachine[], path: string, on: boolean): Promise<LibrarySwitch> {
  const next = await setSetupFileOff(repo, path, !on);
  const { changed, failed, backups } = await lineUpFile(next, machines, path);
  return {
    repo: next,
    changed,
    failed,
    needsYou: [],
    skipped: unreachableOf(machines, () => true),
    undo: async () => {
      const undone: SwitchFailure[] = [];
      for (const { machine, backup } of [...backups].reverse()) {
        try {
          const outcome = await undoSetupSync(machine, backup);
          undone.push(...outcome.failed.map((entry) => fromSync(machine, entry)));
        } catch (error) {
          undone.push(failure(machine, error));
        }
      }
      return { repo: await setSetupFileOff(repo, path, on), failed: undone };
    },
  };
}

/** A plugin's switch in the same shape as the others'. */
export async function switchPlugin(repo: string, row: PluginRow, codex: boolean, on: boolean): Promise<LibrarySwitch> {
  const run = await togglePlugin(repo, row, codex, on);
  const asFailure = (result: MachineResult): SwitchFailure => ({ machine: result.machine, message: result.message });
  return {
    repo: run.repo,
    changed: unique(run.done.map((change) => change.machine)),
    failed: run.failed.map(asFailure),
    needsYou: unique(run.needsYou.map((result) => result.machine)),
    skipped: run.skipped,
    undo: async () => {
      const undone = await undoToggle(repo, row, codex, run);
      return { repo: undone.repo, failed: undone.failed.map(asFailure) };
    },
  };
}

// ---------------------------------------------------------------------------
// One machine's switch, and removing from every machine
// ---------------------------------------------------------------------------

const noSwitch = (failed: SwitchFailure[], changed: string[], sources: SwitchSources, undo: LibrarySwitch['undo']): LibrarySwitch =>
  ({ ...sources, changed, failed, needsYou: [], skipped: [], undo });

/** Runs a plugin's changes on the machines `lineUp` gives, the one machine's alone when `only` names it. */
async function lineUpPlugin(row: PluginRow, plugin: RepoPlugin | null, codex: boolean, only: string | null) {
  const byMachine = lineUp(relisted(row, plugin), codex);
  if (only !== null) for (const machine of byMachine.keys()) if (machine !== only) byMachine.delete(machine);
  return runChanges(byMachine, codex);
}

/**
 * The store copy and home links of a skill on one machine taken out, as removing it does there, keeping each backup:
 * a machine's own value of off leaves its copy alone, so turning it off there takes the copy out by hand.
 */
async function takeSkillOff(setup: SetupRepo, machine: SetupMachine, name: string) {
  const done = await runSkillPlan({ ...planSkills('remove', [name], [machine], setup), marks: [] }, setup, () => undefined);
  const failed = runFailures(done.problems);
  const backups = done.backups.map((entry) => entry.backup);
  const store = skillsView(machine).rows.find((row) => row.name === name)?.store ?? null;
  if (store?.sum && !store.link && setup.head) {
    try {
      const outcome = await applySetupSync(setup.path, setup.head.sha, machine.machine, [{ path: `${STORE}/${name}`, remove: true, before: store.sum }]);
      if (outcome.backup) backups.push(outcome.backup);
      failed.push(...outcome.failed.map((entry) => fromSync(machine.machine, entry)));
    } catch (error) {
      failed.push(failure(machine.machine, error));
    }
  }
  return { changed: done.touched.length || backups.length ? [machine.machine] : [], failed, backups };
}

/** Puts back a machine's backups, the last first. */
async function undoBackups(machine: string, backups: string[]): Promise<SwitchFailure[]> {
  const failed: SwitchFailure[] = [];
  for (const backup of [...backups].reverse()) {
    try {
      failed.push(...(await undoSetupSync(machine, backup)).failed.map((entry) => fromSync(machine, entry)));
    } catch (error) {
      failed.push(failure(machine, error));
    }
  }
  return failed;
}

/**
 * Turns a row on or off on one machine: that machine's own value in the repo, then the machine brought in line. On one
 * machine while it's off everywhere only a plugin can be; the other kinds keep no such value.
 */
export async function switchMachine(repo: string, machines: SetupMachine[], toggle: LibraryToggle, machine: string, on: boolean): Promise<LibrarySwitch> {
  const entry = machines.find((candidate) => candidate.machine === machine);
  if (!entry) throw new Error(`${machine} hasn't been read yet`);
  switch (toggle.kind) {
    case 'plugin': {
      const { row, codex } = toggle;
      const listing = row.repo;
      if (!listing) throw new Error(`The repo doesn't list ${row.id}`);
      const set = (value: PluginWanted | null) => (codex ? setSetupCodexPlugin : setSetupPlugin)(repo, row.id, row.source, machine, value);
      const before = listing.machines[machineLookKey(machine)] ?? null;
      const wanted: PluginWanted = on ? 'on' : 'off';
      const next = await set(wanted === listing.all ? null : wanted);
      const ran = await lineUpPlugin(row, listingOf(next, row, codex), codex, machine);
      const asFailure = (result: MachineResult): SwitchFailure => ({ machine: result.machine, message: result.message });
      return {
        repo: next,
        changed: unique(ran.done.map((change) => change.machine)),
        failed: ran.failed.map(asFailure),
        needsYou: unique(ran.needsYou.map((result) => result.machine)),
        skipped: [],
        undo: async () => {
          const back = await set(before);
          return { repo: back, failed: (await runChanges(inverseChanges(ran.done), codex)).failed.map(asFailure) };
        },
      };
    }
    case 'mcp': {
      const registry = await setMcpWanted(repo, toggle.name, machine, on ? 'default' : 'off');
      const ran = await lineUpServer(repo, machines, registry, toggle.name, machine);
      return noSwitch(ran.failed, ran.changed, { registry }, async () => {
        const back = await setMcpWanted(repo, toggle.name, machine, on ? 'off' : 'default');
        return { registry: back, failed: (await lineUpServer(repo, machines, back, toggle.name, machine)).failed };
      });
    }
    case 'hook': {
      const hooks = await setHookWanted(repo, toggle.name, machine, on ? 'default' : 'off');
      const ran = await lineUpHook(repo, machines, hooks, toggle.name, machine);
      return noSwitch(ran.failed, ran.changed, { hooks }, async () => {
        const failed = await undoAllBackups(ran.backups);
        return { hooks: await setHookWanted(repo, toggle.name, machine, on ? 'off' : 'default'), failed };
      });
    }
    case 'skill': {
      const { name } = toggle;
      if (on) {
        const next = await setSetupSkillMachine(repo, name, machine, null);
        const done = await runSkillPlan(planSkills('add', [name], [entry], next), next, () => undefined);
        return noSwitch(runFailures(done.problems), done.touched, { repo: next }, async () => {
          const problems = await undoSkillRun(done);
          return { repo: await setSetupSkillMachine(repo, name, machine, 'off'), failed: runFailures(problems.machines), repoError: problems.repoError };
        });
      }
      const next = await setSetupSkillMachine(repo, name, machine, 'off');
      const ran = await takeSkillOff(next, entry, name);
      return noSwitch(ran.failed, ran.changed, { repo: next }, async () => {
        const failed = await undoBackups(machine, ran.backups);
        return { repo: await setSetupSkillMachine(repo, name, machine, null), failed };
      });
    }
    case 'file': {
      const { path } = toggle;
      if (on) {
        const next = await setSetupFileMachine(repo, path, machine, null);
        const ran = await lineUpFile(next, machines, path, machine);
        return noSwitch(ran.failed, ran.changed, { repo: next }, async () => {
          const failed = await undoBackups(machine, ran.backups.map((backup) => backup.backup));
          return { repo: await setSetupFileMachine(repo, path, machine, 'off'), failed };
        });
      }
      const next = await setSetupFileMachine(repo, path, machine, 'off');
      // Kept off a machine, its copy is no longer the repo's business, so it's taken out here by hand.
      const copy = entry.homes.flatMap((home) => home.items).find((item) => item.path === path && item.link === null && item.sum !== null);
      const failed: SwitchFailure[] = [];
      const backups: string[] = [];
      if (copy?.sum && next.head) {
        try {
          const outcome = await applySetupSync(next.path, next.head.sha, machine, [{ path, remove: true, before: copy.sum }]);
          if (outcome.backup) backups.push(outcome.backup);
          failed.push(...outcome.failed.map((entry) => fromSync(machine, entry)));
        } catch (error) {
          failed.push(failure(machine, error));
        }
      }
      return noSwitch(failed, backups.length ? [machine] : [], { repo: next }, async () => {
        const undone = await undoBackups(machine, backups);
        return { repo: await setSetupFileMachine(repo, path, machine, null), failed: undone };
      });
    }
  }
}

/**
 * Takes a row off every machine and out of the repo, kept only in its history: the repo's word first, then each machine
 * that answers. Undo puts the repo's back and each machine with it.
 */
export async function removeEverywhere(repo: string, machines: SetupMachine[], toggle: LibraryToggle): Promise<LibrarySwitch> {
  const skipped = unreachableOf(machines, () => true);
  switch (toggle.kind) {
    case 'plugin': {
      const { row, codex } = toggle;
      const before = row.repo?.all ?? null;
      const set = (value: PluginWanted | null) => setListing(repo, row, codex, value);
      const next = await set('removed');
      const ran = await lineUpPlugin(row, listingOf(next, row, codex), codex, null);
      const asFailure = (result: MachineResult): SwitchFailure => ({ machine: result.machine, message: result.message });
      return {
        repo: next,
        changed: unique(ran.done.map((change) => change.machine)),
        failed: ran.failed.map(asFailure),
        needsYou: [],
        skipped,
        undo: async () => {
          const back = await set(before);
          return { repo: back, failed: (await runChanges(inverseChanges(ran.done), codex)).failed.map(asFailure) };
        },
      };
    }
    case 'mcp': {
      const registry = await setMcpWanted(repo, toggle.name, null, 'removed');
      const ran = await lineUpServer(repo, machines, registry, toggle.name);
      return { ...noSwitch(ran.failed, ran.changed, { registry }, async () => {
        const back = await putBackMcpServer(repo, toggle.name);
        return { registry: back, failed: (await lineUpServer(repo, machines, back, toggle.name)).failed };
      }), skipped };
    }
    case 'hook': {
      const hooks = await setHookWanted(repo, toggle.name, null, 'removed');
      const ran = await lineUpHook(repo, machines, hooks, toggle.name);
      return { ...noSwitch(ran.failed, ran.changed, { hooks }, async () => {
        const failed = await undoAllBackups(ran.backups);
        return { hooks: await setHookWanted(repo, toggle.name, null, 'default'), failed };
      }), skipped };
    }
    case 'skill': {
      const current = await getSetupRepo(repo);
      const done = await runSkillPlan(planSkills('remove', [toggle.name], reachableMachines(machines), current), current, () => undefined);
      if (done.repoError) throw new Error(done.repoError);
      return { ...noSwitch(runFailures(done.problems), done.touched, { repo: await getSetupRepo(repo) }, async () => {
        const problems = await undoSkillRun(done);
        return { repo: await getSetupRepo(repo), failed: runFailures(problems.machines), repoError: problems.repoError };
      }), skipped };
    }
    case 'file': {
      const next = await setSetupFileRemoved(repo, toggle.path, true);
      const { changed, failed, backups } = await lineUpFile(next, machines, toggle.path);
      return { ...noSwitch(failed, changed, { repo: next }, async () => {
        const undone: SwitchFailure[] = [];
        for (const { machine, backup } of [...backups].reverse()) undone.push(...await undoBackups(machine, [backup]));
        return { repo: await setSetupFileRemoved(repo, toggle.path, false), failed: undone };
      }), skipped };
    }
  }
}

// ---------------------------------------------------------------------------
// Bringing a machine in line
// ---------------------------------------------------------------------------

/**
 * What bringing one machine in line changes: each Library row behind there that the repo lists. `holdsHooks`: a hook
 * on the machine was edited there; a machine's hooks are written together, so none are while that waits.
 */
export type LinePlan = { machine: string; rows: LibraryRow[]; holdsHooks?: boolean };

/**
 * A row bringing a machine in line can change: anything the repo lists, on, off or removed from every machine. What it
 * doesn't list is each machine's own until it's taken in.
 */
export const bringable = (row: LibraryRow) => row.state !== 'unlisted';

/**
 * Each answering machine with rows behind there that it may change, in the machines' order. A row edited on the
 * machine isn't one of them: Bring in line never overwrites an edit made there.
 */
export function linePlans(rows: LibraryRow[], machines: SetupMachine[]): LinePlan[] {
  return reachableMachines(machines)
    .map((machine) => ({
      machine: machine.machine,
      rows: rows.filter((row) => bringable(row) && row.behind.includes(machine.machine)),
      holdsHooks: rows.some((row) => row.kind === 'hooks' && row.edited[machine.machine] !== undefined),
    }))
    .filter((plan) => plan.rows.length > 0);
}

/**
 * Brings one machine in line with the repo, row by row with each kind's own line-up: plugins, MCP servers, its hooks
 * at once, its files from the repo's sync, and skills into or out of its store and homes. Edits to files and settings
 * land on Arbor's changes, where they can be undone; Claude Code's own plugin and MCP commands keep no backup, so the
 * Overview confirms before this runs.
 */
export async function bringInLine(repo: string, sources: { [K in keyof SwitchSources]-?: SwitchSources[K] | null }, machines: SetupMachine[], plan: LinePlan): Promise<LineRun> {
  const { machine } = plan;
  const entry = machines.find((candidate) => candidate.machine === machine);
  const failed: SwitchFailure[] = [];
  const backups: string[] = [];
  let changed = false;
  let needsYou = false;
  if (!entry) return { changed, failed: [{ machine, message: 'unread', reason: 'unread' }], needsYou, heldHooks: false, backups };
  const of = (kind: LibraryRow['kind']) => plan.rows.filter((row) => row.kind === kind);
  const setup = sources.repo;
  const heldHooks = Boolean(plan.holdsHooks) && of('hooks').length > 0;
  const hooksBehind = of('hooks').length > 0 && !heldHooks;
  // Files first: a hook runs a script the repo's sync puts in ~/.agents/hooks, so its scripts go with them. A skill the
  // repo took off every machine leaves the store the same way.
  if (setup?.head) {
    const files = new Set([
      ...of('instructions').flatMap((row) => (row.detail ? [row.detail] : [])),
      ...of('skills').filter((row) => row.state === 'removed').map((row) => `${STORE}/${row.name}`),
    ]);
    const changes = syncChanges(syncPlan(setup, entry).filter((file) => files.has(file.path) || (hooksBehind && file.kind === 'hookScript')));
    if (changes.length) {
      try {
        const outcome = await applySetupSync(setup.path, setup.head.sha, machine, changes);
        changed ||= outcome.done.length > 0;
        if (outcome.backup) backups.push(outcome.backup);
        failed.push(...outcome.failed.map((entry) => fromSync(machine, entry)));
      } catch (error) {
        failed.push(failure(machine, error));
      }
    }
  }
  for (const row of of('plugins')) {
    if (row.toggle?.kind !== 'plugin') continue;
    const ran = await lineUpPlugin(row.toggle.row, row.toggle.row.repo, row.toggle.codex, machine);
    changed ||= ran.done.length > 0;
    needsYou ||= ran.needsYou.length > 0;
    failed.push(...ran.failed.map((result) => ({ machine, message: result.message })));
  }
  if (sources.registry) {
    for (const row of of('mcps')) {
      const ran = await lineUpServer(repo, machines, sources.registry, row.name, machine);
      changed ||= ran.changed.length > 0;
      failed.push(...ran.failed);
    }
  }
  // A machine's hooks are written together, so one hook behind brings them all in line.
  if (hooksBehind && sources.hooks?.commit && hookChanges(sources.hooks, machine).length) {
    try {
      const edits = await applyHooks(repo, sources.hooks.commit, machine);
      changed ||= edits.some((edit) => edit.written);
      failed.push(...edits.flatMap((edit) => (edit.error ? [{ machine, message: edit.error }] : [])));
    } catch (error) {
      failed.push(failure(machine, error));
    }
  }
  if (setup?.head) {
    // Skills the repo puts on the machine go in its store and on in its homes; ones it keeps off come out of both.
    const skills = of('skills').filter((row) => row.state !== 'removed').map((row) => row.name);
    const off = new Set(setup.offSkills);
    for (const [kind, names] of [['add', skills.filter((name) => !off.has(name))], ['remove', skills.filter((name) => off.has(name))]] as const) {
      if (!names.length) continue;
      const done = await runSkillPlan({ ...planSkills(kind, names, [entry], setup), marks: [] }, setup, () => undefined);
      changed ||= done.touched.length > 0;
      backups.push(...done.backups.map((made) => made.backup));
      failed.push(...runFailures(done.problems));
    }
  }
  return { changed, failed, needsYou, heldHooks, backups };
}

/**
 * What bringing a machine in line did. `heldHooks`: its hooks were left alone, one of them waiting on a decision.
 * `backups`: what it backed up on the machine, newest last, for Undo.
 */
export type LineRun = { changed: boolean; failed: SwitchFailure[]; needsYou: boolean; heldHooks: boolean; backups: string[] };

/** Puts back what a run of bringing in line backed up on a machine. */
export const undoLineRun = (machine: string, run: LineRun) => undoBackups(machine, run.backups);

// ---------------------------------------------------------------------------
// Adding from the directory
// ---------------------------------------------------------------------------

/**
 * Adds a marketplace's plugin to the Library: the repo lists it on for every machine, with its marketplace's
 * repository so a machine without the marketplace adds it first, then each machine that answers installs it. Undo
 * takes the listing out and the installs back off.
 */
export async function addPlugin(repo: string, machines: SetupMachine[], id: string, source: string, codex: boolean): Promise<LibrarySwitch> {
  const set = (wanted: PluginWanted | null) => (codex ? setSetupCodexPlugin : setSetupPlugin)(repo, id, source, null, wanted);
  const listings = (setup: SetupRepo) => (codex ? withCodexPluginRepo : withPluginRepo)(extensionsView(machines), codex ? setup.codexPlugins : setup.plugins);
  const rowOf = (setup: SetupRepo) => {
    const view = listings(setup);
    return (codex ? view.codexPlugins : view.plugins).find((row) => row.id === id) ?? null;
  };
  const next = await set('on');
  const row = rowOf(next);
  if (!row) throw new Error(`The repo didn't list ${id}`);
  const ran = await runChanges(lineUp(row, codex), codex);
  const asFailure = (result: MachineResult): SwitchFailure => ({ machine: result.machine, message: result.message });
  return {
    repo: next,
    changed: unique(ran.done.map((change) => change.machine)),
    failed: ran.failed.map(asFailure),
    needsYou: unique(ran.needsYou.map((result) => result.machine)),
    skipped: unreachableOf(machines, () => true),
    undo: async () => {
      const back = await set(null);
      return { repo: back, failed: (await runChanges(inverseChanges(ran.done), codex)).failed.map(asFailure) };
    },
  };
}

// ---------------------------------------------------------------------------
// Taking a machine's own into the repo
// ---------------------------------------------------------------------------

/** Where a row the repo doesn't list can be taken from: each machine that answers, with the homes that have it. */
export function takeSources(row: LibraryRow, machines: SetupMachine[]): { machine: string; homes: string[] }[] {
  if (row.state !== 'unlisted') return [];
  return reachableMachines(machines).flatMap((machine) => {
    // A skill can be taken from a machine's store (~/.agents) as well as from a home's own copy.
    const homes = (row.places[machine.machine]?.homes ?? []);
    return homes.length ? [{ machine: machine.machine, homes }] : [];
  });
}

/** What taking a row in did, and how to take it back out where that's possible. */
export type TakeRun = SwitchSources & { failed: SwitchFailure[]; undo: (() => Promise<SwitchSources & UndoResult>) | null };

/**
 * Takes a row only machines have into the repo, from one machine's copy: an MCP server as every machine's definition,
 * a hook with its script, or a skill, which also goes on every machine as adding it to the repo does. A plugin is
 * taken in by its switch. An MCP server or hook taken in has no Undo here; the repo's History keeps the commit.
 */
export async function takeIntoRepo(repo: string, machines: SetupMachine[], row: LibraryRow, from: { machine: string; home: string }): Promise<TakeRun> {
  switch (row.kind) {
    case 'mcps':
      return { registry: await takeMcpServer(repo, from.machine, from.home, row.name, false), failed: [], undo: null };
    case 'hooks': {
      const [event, script] = row.key.replace(/^hook:extra:/, '').split('\u0000');
      if (!event || !script) throw new Error(`Arbor can't tell which hook ${row.name} is`);
      return { hooks: await takeHook(repo, from.machine, from.home, event, script), failed: [], undo: null };
    }
    case 'skills': {
      const current = await getSetupRepo(repo);
      const done = await runSkillPlan(planSkills('add', [row.name], reachableMachines(machines), current, from.machine), current, () => undefined);
      if (done.repoError) throw new Error(done.repoError);
      return {
        repo: await getSetupRepo(repo),
        failed: runFailures(done.problems),
        undo: async () => {
          const problems = await undoSkillRun(done);
          return { repo: await getSetupRepo(repo), failed: runFailures(problems.machines), repoError: problems.repoError };
        },
      };
    }
    default:
      throw new Error(`${row.name} is taken into the repo with its switch`);
  }
}

// ---------------------------------------------------------------------------
// Updating a plugin everywhere
// ---------------------------------------------------------------------------

/** The Claude Code homes, on machines that answer, with an older version of a plugin than another home has. */
export const behindHomes = (row: PluginRow) => row.cells.filter((cell) => cell.behind && cell.home.reachable);

/** Updates a plugin in every home that has an older version, with Claude Code's own plugin command. */
export async function updatePlugin(row: PluginRow): Promise<{ changed: string[]; failed: SwitchFailure[] }> {
  const byMachine = new Map<string, DoneChange[]>();
  for (const cell of behindHomes(row)) {
    const { machine, path: home } = cell.home;
    byMachine.set(machine, [...(byMachine.get(machine) ?? []), { machine, home, action: 'update', target: row.id, source: null }]);
  }
  const ran = await runChanges(byMachine, false);
  return { changed: unique(ran.done.map((change) => change.machine)), failed: ran.failed.map((result) => ({ machine: result.machine, message: result.message })) };
}

// ---------------------------------------------------------------------------
// Marketplaces everywhere
// ---------------------------------------------------------------------------

/** The Claude Code homes on answering machines that have a marketplace, and whether any has a plugin from it installed. */
export function marketplaceHomes(view: ExtensionsView, name: string) {
  const row = view.marketplaces.find((entry) => entry.name === name);
  const cells = (row?.cells ?? []).filter((cell) => cell.item && cell.home.reachable);
  const inUse = (home: { machine: string; path: string }) => view.plugins.some((plugin) => plugin.marketplace === name
    && plugin.cells.some((cell) => cell.home.machine === home.machine && cell.home.path === home.path && (cell.place === 'on' || cell.place === 'off')));
  return { cells, inUse: cells.some((cell) => inUse(cell.home)), oldestMs: cells.reduce<number | null>((oldest, cell) => (cell.fetchedMs !== null && (oldest === null || cell.fetchedMs < oldest) ? cell.fetchedMs : oldest), null) };
}

/**
 * Refreshes a Claude Code marketplace in every home that has it, or removes it from them all, with Claude Code's own
 * plugin command. A removal is refused while any home has a plugin from it installed.
 */
export async function marketplaceEverywhere(view: ExtensionsView, name: string, action: 'refresh' | 'removeMarketplace'): Promise<{ changed: string[]; failed: SwitchFailure[] }> {
  const { cells, inUse } = marketplaceHomes(view, name);
  if (action === 'removeMarketplace' && inUse) throw new Error(`A machine has a plugin from ${name} installed`);
  const byMachine = new Map<string, DoneChange[]>();
  for (const cell of cells) {
    const { machine, path: home } = cell.home;
    byMachine.set(machine, [...(byMachine.get(machine) ?? []), { machine, home, action, target: name, source: null }]);
  }
  const ran = await runChanges(byMachine, false);
  return { changed: unique(ran.done.map((change) => change.machine)), failed: ran.failed.map((result) => ({ machine: result.machine, message: result.message })) };
}

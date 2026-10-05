import { mcpSummary } from './mcpGrid';
import { machineColumns } from './pluginGrid';
import { planSkills, runSkillPlan, undoSkillRun, type RunProblem } from './skillRuns';
import { applyHooks, hookChanges, setHookWanted } from './setupHooks';
import { applyMcpChanges, mcpChanges, plannedMcp, setMcpWanted, withRegistry, type PendingMcp } from './setupMcp';
import { codexRepoChanges, differs, repoAction, setSetupCodexPlugin, setSetupPlugin, wantedOn } from './setupPluginRepo';
import { applyCodexPluginChanges, applyPluginChanges, extensionsView, type PluginCell, type PluginRow } from './setupPlugins';
import { applySetupSync, setSetupFileOff, setSetupSkillOff, syncChanges, syncPlan, undoSetupSync } from './setupSync';
import type { HookRegistry, McpRegistry, PluginAction, PluginResult, PluginWanted, RepoPlugin, SetupMachine, SetupRepo } from '../native/types';

/**
 * A Library switch, made straight away: the repo's word for every machine committed, then each machine that answers
 * brought in line with it, one machine after another. What was done is kept so Undo can put it all back.
 */

/** One change made in one home, as the plugin commands take it. */
export type DoneChange = { machine: string; home: string; action: PluginAction; target: string; source: string | null };

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
      changes.push({ machine, home, action, target: row.id, source: null });
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

/** Puts back what a switch did: the repo's listing as it was, then each change made, undone in reverse. */
export async function undoToggle(repo: string, row: PluginRow, codex: boolean, run: ToggleRun): Promise<{ repo: SetupRepo; failed: MachineResult[] }> {
  const next = await setListing(repo, row, codex, run.before);
  const byMachine = new Map<string, DoneChange[]>();
  for (const change of [...run.done].reverse()) {
    const action = INVERSE[change.action];
    if (!action) continue;
    byMachine.set(change.machine, [...(byMachine.get(change.machine) ?? []), { ...change, action }]);
  }
  const { failed } = await runChanges(byMachine, codex);
  return { repo: next, failed };
}

// ---------------------------------------------------------------------------
// Every kind's switch
// ---------------------------------------------------------------------------

/** A machine a switch couldn't change, with what it said. */
export type SwitchFailure = { machine: string; message: string };

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
  undo: () => Promise<SwitchSources & { failed: SwitchFailure[] }>;
};

const unique = (values: string[]) => [...new Set(values)];
const reachableMachines = (machines: SetupMachine[]) => machines.filter((machine) => machine.reachable);
const unreachableOf = (machines: SetupMachine[], among: (machine: SetupMachine) => boolean) =>
  machines.filter((machine) => !machine.reachable && among(machine)).map((machine) => machine.machine);
const failure = (machine: string, error: unknown): SwitchFailure => ({ machine, message: String(error) });

/** Brings each answering machine's homes in line with the registry's word on one server. */
async function lineUpServer(repo: string, machines: SetupMachine[], registry: McpRegistry, name: string) {
  const found = registry.found && registry.problems.length === 0;
  const view = withRegistry(extensionsView(machines), registry);
  const row = view.servers.find((entry) => entry.name === name);
  const changed: string[] = [];
  const failed: SwitchFailure[] = [];
  if (!row || !registry.commit) return { changed, failed };
  const pending: PendingMcp = {};
  for (const column of machineColumns(view.mcpHomes)) {
    if (column.reachable) Object.assign(pending, mcpSummary(row, column, found, {}).toRepo);
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

/** Brings each answering machine with a home out of step on the hook in line: its hooks, as the repo has them. */
async function lineUpHook(repo: string, machines: SetupMachine[], registry: HookRegistry, name: string) {
  const changed: string[] = [];
  const failed: SwitchFailure[] = [];
  if (!registry.commit) return { changed, failed };
  for (const machine of reachableMachines(machines)) {
    if (!hookChanges(registry, machine.machine).some((cell) => cell.name === name)) continue;
    try {
      const edits = await applyHooks(repo, registry.commit, machine.machine);
      if (edits.some((edit) => edit.written)) changed.push(machine.machine);
      failed.push(...edits.flatMap((edit) => (edit.error ? [{ machine: machine.machine, message: edit.error }] : [])));
    } catch (error) {
      failed.push(failure(machine.machine, error));
    }
  }
  return { changed, failed };
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
      const back = await setHookWanted(repo, name, null, on ? 'off' : 'default');
      return { hooks: back, failed: (await lineUpHook(repo, machines, back, name)).failed };
    },
  };
}

/** What a skill run left undone, by machine. */
const runFailures = (problems: Record<string, RunProblem>): SwitchFailure[] =>
  Object.entries(problems).map(([machine, problem]) => ({
    machine,
    message: problem.kind === 'error' ? problem.detail : problem.kind === 'unread' ? 'unread' : problem.paths.join(', '),
  }));

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
      return { repo: back, failed: runFailures(problems.machines) };
    },
  };
}

/** Writes or takes out one file on each answering machine, as the repo now has it, keeping each machine's backup. */
async function lineUpFile(setup: SetupRepo, machines: SetupMachine[], path: string) {
  const changed: string[] = [];
  const failed: SwitchFailure[] = [];
  const backups: { machine: string; backup: string }[] = [];
  if (!setup.head) return { changed, failed, backups };
  for (const machine of reachableMachines(machines)) {
    const changes = syncChanges(syncPlan(setup, machine).filter((file) => file.path === path));
    if (!changes.length) continue;
    try {
      const outcome = await applySetupSync(setup.path, setup.head.sha, machine.machine, changes);
      if (outcome.backup) backups.push({ machine: machine.machine, backup: outcome.backup });
      if (outcome.done.length) changed.push(machine.machine);
      failed.push(...outcome.failed.map((entry) => ({ machine: machine.machine, message: entry.reason })));
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
          undone.push(...outcome.failed.map((entry) => ({ machine, message: entry.reason })));
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

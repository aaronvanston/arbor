import { codexRepoChanges, differs, repoAction, setSetupCodexPlugin, setSetupPlugin, wantedOn } from './setupPluginRepo';
import { applyCodexPluginChanges, applyPluginChanges, type PluginCell, type PluginRow } from './setupPlugins';
import type { PluginAction, PluginResult, PluginWanted, RepoPlugin, SetupRepo } from '../native/types';

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

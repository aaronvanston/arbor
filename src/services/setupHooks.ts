import { invokeCommand } from '../native/commands';
import type { AgentKind, HookCell, HookRegistry, HookState, HookView, HookWanted, SetupMachine } from '../native/types';
import { tracked } from './productAnalytics';

/** The repo's hooks (.agents/hooks.json), and how every machine's Claude Code and Codex homes stand against them. */
export const getHookRegistry = (repo: string) => invokeCommand('get_hook_registry', { repo });
/** A hook's value for every machine (null) or one, committed to the repo straight away. */
export const setHookWanted = (repo: string, name: string, machine: string | null, wanted: HookWanted) =>
  invokeCommand('set_hook_wanted', { repo, name, machine, wanted });
/** Takes a machine's hook that runs a script in ~/.agents/hooks into the repo, with the script when the repo hasn't got it. */
export const takeHook = (repo: string, machine: string, home: string, event: string, script: string) =>
  invokeCommand('take_hook', { repo, machine, home, event, script });
/** Brings a machine's Claude Code and Codex homes in step with the repo's hooks as `commit` has them. */
export const applyHooks = (repo: string, commit: string, machine: string) =>
  tracked('hooks-changed', invokeCommand('apply_hooks', { repo, commit, machine }));
/** The agents whose homes a hook goes in, committed to the repo straight away. */
export const setHookAgents = (repo: string, name: string, agents: AgentKind[]) => invokeCommand('set_hook_agents', { repo, name, agents });

/** Which agents a hook goes to, as the repo menu offers them. */
export type HookAgents = 'claude' | 'codex' | 'both';

export function hookAgents(view: HookView): HookAgents {
  const codex = view.agents.includes('codex');
  if (!codex) return 'claude';
  return view.agents.includes('claude') ? 'both' : 'codex';
}

export const HOOK_AGENT_KINDS: Record<HookAgents, AgentKind[]> = { claude: ['claude'], codex: ['codex'], both: ['claude', 'codex'] };

/** A row of the grid: a repo hook, or a hook a machine runs from ~/.agents/hooks that the repo hasn't got. */
export type HookRow = { key: string; view: HookView | null; event: string; script: string };

/**
 * How a machine's homes have a row's hook: as the repo has it (`same`), missing (`add`), different (`update`), there
 * when the repo doesn't want it there (`extra`), a mix of those across its homes, or nothing to say: `off` (kept off
 * the machine), `removed` (removed everywhere) and `none` (no home has it, or it has no Claude Code home).
 */
export type HookMachineState = HookState | 'mixed' | 'off' | 'removed' | 'none';

export type HookSummary = { state: HookMachineState; cells: HookCell[]; differs: boolean };

export function hookRows(registry: HookRegistry): HookRow[] {
  const rows: HookRow[] = registry.hooks.map((view) => ({ key: `repo:${view.name}`, view, event: view.event, script: view.script ?? '' }));
  const seen = new Set<string>();
  for (const cell of registry.cells) {
    if (cell.name !== null) continue;
    const key = `extra:${cell.event}\u0000${cell.script}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, view: null, event: cell.event, script: cell.script });
  }
  return rows;
}

const cellsOf = (registry: HookRegistry, row: HookRow, machine: string) =>
  registry.cells.filter((cell) => cell.machine === machine
    && (row.view ? cell.name === row.view.name : cell.name === null && cell.event === row.event && cell.script === row.script));

export function hookSummary(registry: HookRegistry, row: HookRow, machine: string): HookSummary {
  const cells = cellsOf(registry, row, machine);
  const differs = cells.some((cell) => cell.state !== 'same');
  if (!cells.length) {
    const state: HookMachineState = row.view?.removed ? 'removed' : row.view?.off.includes(machine) ? 'off' : 'none';
    return { state, cells, differs };
  }
  const states = new Set(cells.map((cell) => cell.state));
  const [only] = states;
  return { state: states.size === 1 && only ? only : 'mixed', cells, differs };
}

/** The rows to show: each that differs somewhere when `onlyDifferences`, matching `query` by name, event or script. */
export function hookGrid(registry: HookRegistry, machines: readonly string[], onlyDifferences: boolean, query: string): HookRow[] {
  const needle = query.trim().toLowerCase();
  return hookRows(registry).filter((row) => {
    if (needle && ![row.view?.name ?? '', row.event, row.script].some((text) => text.toLowerCase().includes(needle))) return false;
    if (!onlyDifferences) return true;
    return Boolean(row.view?.problems.length) || machines.some((machine) => hookSummary(registry, row, machine).differs);
  });
}

/** What bringing a machine in step changes, home by home. */
export const hookChanges = (registry: HookRegistry, machine: string) =>
  registry.cells.filter((cell) => cell.machine === machine && cell.state !== 'same');

/** How many handlers a machine's Claude Code and Codex homes run that are their own, rather than the repo's. */
export function ownHookCount(machine: SetupMachine): number {
  return machine.homes
    .filter((home) => home.agent === 'claude' || home.agent === 'codex')
    .flatMap((home) => home.items)
    .reduce((total, item) => total + (item.kind === 'hook' && item.path === null ? item.count ?? 1 : 0), 0);
}

/** The machines with a Claude Code or Codex home, whose hooks the repo keeps. */
export const hookMachines = (machines: readonly SetupMachine[]) =>
  machines.filter((machine) => machine.homes.some((home) => home.agent === 'claude' || home.agent === 'codex'));

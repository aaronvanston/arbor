import { mcpKey, mcpOptions, type PendingMcp } from './setupMcp';
import type { MachineColumn } from './pluginGrid';
import type { ExtensionsView, McpCell, McpRow } from './setupPlugins';
import type { McpAction, McpStatus } from '../native/types';

/**
 * MCP servers by machine rather than by home, as plugins are: each machine's Claude Code and Codex homes summed up in
 * one column, and each home still changed on its own.
 */

/**
 * A server on one machine, over its homes.
 * - `none`: in none of them. `on`, `off`: set up in every home, and on or off in all of them.
 * - `some`: set up in some homes and not others, or on in some and off in others.
 * - `missing`: the repo has it for a home here that hasn't got it, and no home has it.
 */
export type McpMachineState = 'none' | 'on' | 'off' | 'some' | 'missing';

export type McpSummary = {
  machine: string;
  cells: McpCell[];
  state: McpMachineState;
  /** How many of the machine's homes have it set up, and how many homes it has. */
  configured: number;
  homes: number;
  /** The one transport its homes use, when they agree. */
  transport: string | null;
  /** The worst answer a connection check got from it here, when one has been made. */
  health: McpStatus | null;
  /** Some home isn't as the repo defines it: missing it, set up differently, or has it where the repo keeps it off. */
  differs: boolean;
  /** The repo has a definition of its own for the machine. */
  own: boolean;
  /** Changes chosen in the machine's homes. */
  chosen: number;
  /** The changes that would bring every home on the machine in step with the repo. */
  toRepo: PendingMcp;
};

/** Worst first, so a machine's cell says the worst any of its homes answered. */
const HEALTH_ORDER: McpStatus[] = ['failed', 'needsAuth', 'pending', 'disabled', 'connected'];

/**
 * A home that isn't as the repo has it. A home with a server the repo doesn't list only counts when the repo lists the
 * server at all, as it does a plugin: a server the repo has never had is the machine's business until it's taken in.
 */
const cellDiffers = (row: McpRow, cell: McpCell) =>
  cell.repo?.state === 'add' || cell.repo?.state === 'update' || (cell.repo?.state === 'extra' && row.repo !== null);

export function mcpSummary(row: McpRow, column: MachineColumn, found: boolean, pending: PendingMcp): McpSummary {
  const cells = row.cells.filter((cell) => cell.home.machine === column.machine);
  const set = cells.filter((cell) => cell.item);
  const on = set.filter((cell) => cell.item?.enabled !== false).length;
  let state: McpMachineState = 'none';
  if (set.length && set.length === cells.length) state = on === set.length ? 'on' : on ? 'some' : 'off';
  else if (set.length) state = 'some';
  else if (cells.some((cell) => cell.repo?.state === 'add')) state = 'missing';
  const transports = [...new Set(set.flatMap((cell) => (cell.item?.value ? [cell.item.value] : [])))];
  const answers = new Set(cells.flatMap((cell) => (cell.health ? [cell.health] : [])));
  const toRepo: PendingMcp = {};
  for (const cell of cells) {
    if (!cellDiffers(row, cell)) continue;
    const action = mcpOptions(cell, found)[0];
    if (action) toRepo[mcpKey(cell.home, row.name)] = action;
  }
  return {
    machine: column.machine,
    cells,
    state,
    configured: set.length,
    homes: cells.length,
    transport: transports.length === 1 ? transports[0] ?? null : null,
    health: HEALTH_ORDER.find((status) => answers.has(status)) ?? null,
    differs: cells.some((cell) => cellDiffers(row, cell)),
    own: cells.some((cell) => cell.repo?.own),
    chosen: cells.filter((cell) => pending[mcpKey(cell.home, row.name)]).length,
    toRepo,
  };
}

/** Something about the row that wants a look: not as the repo has it, failing, or, without the repo's word, machines that differ. */
export function mcpNeedsLook(row: McpRow, columns: MachineColumn[]): boolean {
  if (row.cells.some((cell) => cellDiffers(row, cell) || cell.health === 'failed' || cell.health === 'needsAuth')) return true;
  // Plugins' servers and claude.ai's follow their plugin or account, so machines having them differently isn't news.
  if (row.repo || row.origin !== 'config') return false;
  const states = new Set(columns.filter((column) => column.reachable).map((column) => mcpSummary(row, column, false, {}).state));
  return states.has('some') || states.size > 1;
}

export type McpGrid = {
  rows: McpRow[];
  /** Rows hidden while only differences are shown. */
  inLine: number;
};

/** The rows the grid shows, the ones that need a look first, and only those when `onlyDifferences` is on. */
export function mcpGrid(view: ExtensionsView, columns: MachineColumn[], onlyDifferences: boolean, query = ''): McpGrid {
  const text = query.trim().toLowerCase();
  const found = view.servers.filter((row) => !text || row.name.toLowerCase().includes(text) || Boolean(row.plugin?.toLowerCase().includes(text)));
  const look = found.filter((row) => mcpNeedsLook(row, columns));
  return onlyDifferences
    ? { rows: look, inLine: found.length - look.length }
    : { rows: [...look, ...found.filter((row) => !look.includes(row))], inLine: 0 };
}

/** How many servers want a look on each machine, for the strip above the grids. */
export function mcpMachineLooks(view: ExtensionsView, columns: MachineColumn[]): Map<string, number> {
  const counts = new Map(columns.map((column) => [column.machine, 0]));
  for (const row of view.servers) {
    for (const column of columns) {
      const cells = row.cells.filter((cell) => cell.home.machine === column.machine);
      if (cells.some((cell) => cellDiffers(row, cell) || cell.health === 'failed')) counts.set(column.machine, (counts.get(column.machine) ?? 0) + 1);
    }
  }
  return counts;
}

/** The actions a machine's "Match the repo" adds, less any already chosen. */
export const unchosen = (toRepo: PendingMcp, pending: PendingMcp): Record<string, McpAction> =>
  Object.fromEntries(Object.entries(toRepo).filter(([key]) => !pending[key]));

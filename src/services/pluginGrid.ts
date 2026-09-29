import { changeKey, type ExtHome, type ExtensionsView, type MarketplaceRow, type PendingPlugins, type PluginCell, type PluginRow } from './setupPlugins';
import { repoAction } from './setupPluginRepo';
import type { PluginAction, PluginLeftover, PluginWanted } from '../native/types';

/**
 * Plugins and marketplaces by machine rather than by home: each machine's Claude Code homes are summed up in one
 * column, and a row is kept only while it's somewhere or the repo wants it somewhere. Each home is still changed on its
 * own; the sum only says where to look.
 */

/** A machine's Claude Code homes, in the page's order. */
export type MachineColumn = { machine: string; homes: ExtHome[]; reachable: boolean };

export function machineColumns(homes: ExtHome[]): MachineColumn[] {
  const columns = new Map<string, MachineColumn>();
  for (const home of homes) {
    const column = columns.get(home.machine) ?? { machine: home.machine, homes: [], reachable: home.reachable };
    column.homes.push(home);
    columns.set(home.machine, column);
  }
  return [...columns.values()];
}

/**
 * A plugin on one machine, over its homes.
 * - `none`: in none of them. `on`, `off`: installed in every one that has it, and on or off in all of them.
 * - `mixed`: on in some homes and off or missing in others. `missing`: turned on somewhere but not installed.
 */
export type MachineState = 'none' | 'on' | 'off' | 'mixed' | 'missing';

export type PluginSummary = {
  machine: string;
  cells: PluginCell[];
  state: MachineState;
  /** How many of the machine's homes have it on, and how many homes it has. */
  on: number;
  installed: number;
  homes: number;
  /** The one version its homes have, when they agree. */
  version: string | null;
  behind: boolean;
  /** What the repo wants of it on the machine, when the repo lists it. */
  wanted: PluginWanted | null;
  /** Some home isn't as the repo wants it. */
  differs: boolean;
  /** Changes chosen in the machine's homes. */
  chosen: number;
  /** The changes that would bring every home on the machine in step with the repo: the plugin review's, or Codex's own for a Codex row. */
  toRepo: Record<string, PluginAction>;
};

export function pluginSummary(row: PluginRow, column: MachineColumn, pending: PendingPlugins, codex = false): PluginSummary {
  const cells = row.cells.filter((cell) => cell.home.machine === column.machine);
  const on = cells.filter((cell) => cell.place === 'on').length;
  const off = cells.filter((cell) => cell.place === 'off').length;
  const missing = cells.filter((cell) => cell.place === 'missing').length;
  const installed = on + off;
  let state: MachineState = 'none';
  if (on && on === cells.length) state = 'on';
  else if (on) state = 'mixed';
  else if (missing) state = 'missing';
  else if (off) state = 'off';
  const versions = [...new Set(cells.flatMap((cell) => (cell.item?.value && (cell.place === 'on' || cell.place === 'off') ? [cell.item.value] : [])))];
  const toRepo: Record<string, PluginAction> = {};
  for (const cell of cells) {
    const action = repoAction(row, cell, codex);
    if (action) toRepo[changeKey(cell.home, 'plugin', row.id)] = action;
  }
  return {
    machine: column.machine,
    cells,
    state,
    on,
    installed,
    homes: cells.length,
    version: versions.length === 1 ? versions[0] ?? null : null,
    behind: cells.some((cell) => cell.behind),
    wanted: cells.find((cell) => cell.wanted)?.wanted?.value ?? null,
    differs: cells.some((cell) => cell.wanted?.differs),
    chosen: cells.filter((cell) => pending[changeKey(cell.home, 'plugin', row.id)]).length,
    toRepo,
  };
}

/** Somewhere at all: installed in a home, or turned on in one without being installed. */
const somewhere = (row: PluginRow) => row.cells.some((cell) => cell.place !== 'none');

/** Something about the row that wants a look: not as the repo wants it, behind, missing, or the machines disagreeing. */
export function pluginNeedsLook(row: PluginRow, columns: MachineColumn[]): boolean {
  if (row.cells.some((cell) => cell.wanted?.differs || cell.behind || cell.place === 'missing')) return true;
  // The repo's word settles it; without one, machines that don't all have it the same way are worth a look.
  if (row.repo) return false;
  const states = new Set(columns.filter((column) => column.reachable).map((column) => pluginSummary(row, column, {}).state));
  return states.has('mixed') || states.size > 1;
}

/** A home's settings naming a plugin it hasn't installed. `policy`: a managed policy names it, so it can't be taken out. */
export type Leftover = { machine: string; home: string; plugin: string; reachable: boolean; policy: boolean };

/** The leftovers that can be cleaned up, by machine, as the command takes them. */
export function leftoversByMachine(leftovers: Leftover[]): Map<string, PluginLeftover[]> {
  const byMachine = new Map<string, PluginLeftover[]>();
  for (const leftover of leftovers) {
    if (!leftover.reachable || leftover.policy) continue;
    byMachine.set(leftover.machine, [...(byMachine.get(leftover.machine) ?? []), { home: leftover.home, plugin: leftover.plugin }]);
  }
  return byMachine;
}

export type PluginGrid = {
  rows: PluginRow[];
  /** Rows kept, but hidden while only differences are shown. */
  inLine: number;
  /**
   * Plugins in no home, which a home's settings still name as turned off. They're gone, so they aren't rows; the count
   * says why a plugin someone removed can still turn up in a scan, and each can be taken out of the settings naming it.
   */
  leftovers: Leftover[];
};

/**
 * The rows the grid shows: every plugin that's somewhere or that the repo wants somewhere, the ones that need a look
 * first when `onlyDifferences` is off, and only those when it's on. `query` matches the plugin's name or marketplace.
 */
export function pluginGrid(view: ExtensionsView, columns: MachineColumn[], onlyDifferences: boolean, query = ''): PluginGrid {
  const text = query.trim().toLowerCase();
  const matches = (row: PluginRow) => !text || row.id.toLowerCase().includes(text);
  const kept = view.plugins.filter((row) => somewhere(row) || row.cells.some((cell) => cell.wanted?.differs));
  const leftovers = view.plugins
    .filter((row) => !kept.includes(row))
    .flatMap((row) => row.cells.filter((cell) => cell.item).map((cell) => ({ machine: cell.home.machine, home: cell.home.path, plugin: row.id, reachable: cell.home.reachable, policy: cell.policy !== null })));
  const found = kept.filter(matches);
  const look = found.filter((row) => pluginNeedsLook(row, columns));
  return onlyDifferences
    ? { rows: look, inLine: found.length - look.length, leftovers }
    : { rows: [...look, ...found.filter((row) => !look.includes(row))], inLine: 0, leftovers };
}

/** How many plugins want a look on each machine, for the strip above the grid. */
export function machineLooks(view: ExtensionsView, columns: MachineColumn[]): Map<string, number> {
  const counts = new Map(columns.map((column) => [column.machine, 0]));
  for (const row of view.plugins) {
    for (const column of columns) {
      const cells = row.cells.filter((cell) => cell.home.machine === column.machine);
      if (cells.some((cell) => cell.wanted?.differs || cell.behind || cell.place === 'missing')) counts.set(column.machine, (counts.get(column.machine) ?? 0) + 1);
    }
  }
  return counts;
}

/** A marketplace on one machine, over its homes. */
export type MarketplaceSummary = { machine: string; has: number; homes: number; stale: boolean; newestMs: number | null; auto: boolean; chosen: number };

export function marketplaceSummary(row: MarketplaceRow, column: MachineColumn, pending: PendingPlugins): MarketplaceSummary {
  const cells = row.cells.filter((cell) => cell.home.machine === column.machine);
  const fetched = cells.flatMap((cell) => (cell.item && cell.fetchedMs !== null ? [cell.fetchedMs] : []));
  return {
    machine: column.machine,
    has: cells.filter((cell) => cell.item).length,
    homes: cells.length,
    stale: cells.some((cell) => cell.stale),
    newestMs: fetched.length ? Math.max(...fetched) : null,
    auto: cells.some((cell) => cell.item && cell.auto),
    chosen: cells.filter((cell) => pending[changeKey(cell.home, 'marketplace', row.name)]).length,
  };
}

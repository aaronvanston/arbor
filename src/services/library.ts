import { machineLookKey } from './machineLook';
import { machineColumns, pluginSummary } from './pluginGrid';
import { mcpSummary } from './mcpGrid';
import { HOOK_AGENT_KINDS, hookAgents, hookRows, hookSummary } from './setupHooks';
import { isRemovedServer } from './setupMcp';
import { removableKind } from './setupSync';
import { isCodexOwnMarketplace, type ExtensionsView, type PluginRow } from './setupPlugins';
import { fleetSkills, repoSkillState } from './setupSkills';
import type { HookRegistry, SetupMachine, SetupRepo } from '../native/types';

/**
 * Sync › Library: everything the setup repo gives the machines' agents, one row each, whatever kind it is, with the
 * repo's word for every machine and how the machines stand against it. The per-kind grids work out the details; this
 * only sums them up, so a row says the same as its grid under By machine.
 */

export type LibraryKind = 'plugins' | 'mcps' | 'skills' | 'hooks' | 'instructions';
export const LIBRARY_KINDS: readonly LibraryKind[] = ['plugins', 'mcps', 'skills', 'hooks', 'instructions'];
export const isLibraryKind = (kind: string | null | undefined): kind is LibraryKind => (LIBRARY_KINDS as readonly string[]).includes(kind ?? '');

export type LibraryAgent = 'claude' | 'codex';

/**
 * The repo's word on a row for every machine: `on` and `off` as it lists it, `removed` (taken off every machine, kept
 * only in its history), or `unlisted`, found on a machine but not in the repo, which leaves it to each machine.
 */
export type LibraryState = 'on' | 'off' | 'removed' | 'unlisted';

/**
 * What a row's switch changes: a plugin (Claude Code's or Codex's), an MCP server, a hook, a skill, or a rule, subagent
 * or command by its path. Only what the repo lists has one; the rest are taken in under By machine first.
 */
export type LibraryToggle =
  | { kind: 'plugin'; codex: boolean; row: PluginRow }
  | { kind: 'mcp'; name: string }
  | { kind: 'hook'; name: string }
  | { kind: 'skill'; name: string }
  | { kind: 'file'; path: string };

export type LibraryRow = {
  /** Unique across kinds and agents. */
  key: string;
  kind: LibraryKind;
  name: string;
  /** What else names it: a plugin's marketplace, a hook's event, a file's place. */
  detail: string | null;
  agents: LibraryAgent[];
  state: LibraryState;
  /** The machines that have it on in some home, of those that have a home for it. */
  on: string[];
  fleet: string[];
  /** Machines not as the repo has it, which bringing them in line changes. */
  behind: string[];
  /** Machines with a value of their own, where the repo's word for every machine doesn't apply. */
  exceptions: number;
  toggle: LibraryToggle | null;
};

const unique = <T,>(values: T[]) => [...new Set(values)];

/** The machines with a home for an agent's things. */
const fleetOf = (homes: { machine: string }[]) => unique(homes.map((home) => home.machine));

function pluginRows(view: ExtensionsView, codex: boolean): LibraryRow[] {
  const homes = codex ? view.codexHomes : view.claudeHomes;
  const columns = machineColumns(homes);
  const fleet = fleetOf(homes);
  const plugins = codex ? view.codexPlugins.filter((row) => !isCodexOwnMarketplace(row.marketplace)) : view.plugins;
  return plugins
    // Plugins gone from every home that the repo doesn't want anywhere are leftovers, not things to switch.
    .filter((row) => row.repo || row.cells.some((cell) => cell.place === 'on' || cell.place === 'off'))
    .map((row): LibraryRow => {
      const summaries = columns.map((column) => pluginSummary(row, column, {}, codex));
      const state: LibraryState = row.repo ? (row.repo.all === 'removed' ? 'removed' : row.repo.all === 'on' ? 'on' : 'off') : 'unlisted';
      return {
        key: `plugin:${codex ? 'codex' : 'claude'}:${row.id}`,
        kind: 'plugins',
        name: row.name,
        detail: row.marketplace,
        agents: [codex ? 'codex' : 'claude'],
        state,
        on: summaries.filter((summary) => summary.on > 0).map((summary) => summary.machine),
        fleet,
        behind: summaries.filter((summary) => summary.differs && columns.find((column) => column.machine === summary.machine)?.reachable).map((summary) => summary.machine),
        exceptions: row.repo ? Object.keys(row.repo.machines).length : 0,
        toggle: { kind: 'plugin', codex, row },
      };
    });
}

function serverRows(view: ExtensionsView, found: boolean): LibraryRow[] {
  const columns = machineColumns(view.mcpHomes);
  // A plugin's servers come and go with it, and a claude.ai connector is the account's, so neither is the repo's.
  return view.servers.filter((row) => row.origin === 'config').map((row): LibraryRow => {
    const summaries = columns.map((column) => mcpSummary(row, column, found, {}));
    const server = row.repo;
    const state: LibraryState = !server ? 'unlisted' : isRemovedServer(server) ? 'removed' : server.allOff ? 'off' : 'on';
    const agents = unique(row.cells.filter((cell) => cell.item).map((cell) => cell.home.agent));
    if (server?.claude && !agents.includes('claude')) agents.push('claude');
    if (server?.codex && !agents.includes('codex')) agents.push('codex');
    return {
      key: `mcp:${row.name}`,
      kind: 'mcps',
      name: row.name,
      detail: summaries.find((summary) => summary.transport)?.transport ?? null,
      agents: agents.sort(),
      state,
      on: summaries.filter((summary) => summary.state === 'on' || summary.state === 'some').map((summary) => summary.machine),
      fleet: fleetOf(view.mcpHomes),
      behind: summaries.filter((summary) => summary.differs).map((summary) => summary.machine),
      exceptions: server ? server.off.length + server.own.length : 0,
      toggle: state === 'on' || state === 'off' ? { kind: 'mcp', name: row.name } : null,
    };
  });
}

function skillRows(machines: SetupMachine[], repo: SetupRepo | null): LibraryRow[] {
  const fleet = fleetSkills(machines);
  return fleet.rows.map((row): LibraryRow => {
    const state = repo ? repoSkillState(repo, row.name) : 'absent';
    const off = state === 'synced' && Boolean(repo?.offSkills.includes(row.name));
    const cells = Object.entries(row.cells).flatMap(([machine, cell]) => (cell ? [{ machine, cell }] : []));
    const agents = unique(cells.flatMap(({ cell }) => cell.row.cells.filter((entry) => entry.place !== 'none').map((entry) => entry.home.agent)));
    return {
      key: `skill:${row.name}`,
      kind: 'skills',
      name: row.name,
      detail: row.source,
      agents: agents.sort(),
      state: off ? 'off' : state === 'synced' ? 'on' : state === 'removed' ? 'removed' : 'unlisted',
      on: cells.filter(({ cell }) => cell.loads > 0).map(({ machine }) => machine),
      fleet: fleet.machines,
      behind: cells.filter(({ cell }) => cell.look).map(({ machine }) => machine),
      exceptions: Object.keys(repo?.skillMachines[row.name] ?? {}).length,
      toggle: state === 'synced' ? { kind: 'skill', name: row.name } : null,
    };
  });
}

function hookLibraryRows(registry: HookRegistry, machines: readonly string[]): LibraryRow[] {
  return hookRows(registry).map((row): LibraryRow => {
    const summaries = machines.map((machine) => ({ machine, summary: hookSummary(registry, row, machine) }));
    const view = row.view;
    return {
      key: `hook:${row.key}`,
      kind: 'hooks',
      name: view?.name ?? row.script.split('/').pop() ?? row.script,
      detail: view?.matcher ? `${row.event} · ${view.matcher}` : row.event,
      agents: view ? HOOK_AGENT_KINDS[hookAgents(view)] : unique(summaries.flatMap(({ summary }) => summary.cells.map((cell): LibraryAgent => cell.agent))),
      state: !view ? 'unlisted' : view.removed ? 'removed' : view.allOff ? 'off' : 'on',
      on: summaries.filter(({ summary }) => ['same', 'update', 'extra', 'mixed'].includes(summary.state)).map(({ machine }) => machine),
      fleet: [...machines],
      behind: summaries.filter(({ summary }) => summary.differs).map(({ machine }) => machine),
      exceptions: view?.off.length ?? 0,
      toggle: view && !view.removed ? { kind: 'hook', name: view.name } : null,
    };
  });
}

function fileRows(repo: SetupRepo, machines: readonly string[]): LibraryRow[] {
  const removed = repo.removedFiles.map((path) => ({ path, removed: true }));
  const files = repo.files.filter((file) => file.kind !== 'hookScript').map((file) => ({ path: file.path, removed: false, kind: file.kind }));
  return [...files, ...removed.map((entry) => ({ ...entry, kind: null }))].map(({ path, removed: gone, kind }): LibraryRow => {
    const offHere = Object.entries(repo.fileMachines[path] ?? {}).filter(([, value]) => value === 'off').map(([machine]) => machine);
    const off = !gone && repo.offFiles.includes(path);
    return {
      key: `file:${path}`,
      kind: 'instructions',
      name: path.split('/').pop() ?? path,
      detail: path,
      agents: [path.startsWith('~/.codex/') ? 'codex' : 'claude'],
      state: gone ? 'removed' : off ? 'off' : 'on',
      on: gone || off ? [] : machines.filter((machine) => !offHere.includes(machineLookKey(machine))),
      fleet: [...machines],
      behind: [],
      exceptions: Object.keys(repo.fileMachines[path] ?? {}).length,
      // An agent's instructions are every machine's own, so they're changed in the repo, never switched off.
      toggle: !gone && kind !== null && removableKind(kind) ? { kind: 'file', path } : null,
    };
  });
}

export type LibrarySources = {
  machines: SetupMachine[];
  view: ExtensionsView;
  repo: SetupRepo | null;
  /** The MCP registry's file is there and readable, so servers can be compared with it. */
  registryFound: boolean;
  hooks: HookRegistry | null;
};

/**
 * Every row of every kind, each kind in name order. Only what the repo lists can be behind it: machines differing over
 * something it doesn't list is each machine's business until it's taken in.
 */
export function libraryRows({ machines, view, repo, registryFound, hooks }: LibrarySources): LibraryRow[] {
  const names = machines.map((machine) => machine.machine);
  const byName = (a: LibraryRow, b: LibraryRow) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
  const rows = [
    ...[...pluginRows(view, false), ...pluginRows(view, true)].sort(byName),
    ...serverRows(view, registryFound).sort(byName),
    ...skillRows(machines, repo).sort(byName),
    ...(hooks ? hookLibraryRows(hooks, names).sort(byName) : []),
    ...(repo ? fileRows(repo, names) : []),
  ];
  return rows.map((row) => (row.state === 'unlisted' && row.behind.length ? { ...row, behind: [] } : row));
}

export type LibraryFilter = { kind: LibraryKind; agent: LibraryAgent | null; query: string };

/**
 * The rows a tab shows: the kind's, for the agent picked, matching the search by name or detail. Removed rows are
 * left out, counted apart, as the Repo's "Removed from every machine" is.
 */
export function libraryList(rows: LibraryRow[], { kind, agent, query }: LibraryFilter): { rows: LibraryRow[]; removed: LibraryRow[] } {
  const text = query.trim().toLowerCase();
  const matching = rows.filter((row) => row.kind === kind
    && (!agent || row.agents.includes(agent))
    && (!text || row.name.toLowerCase().includes(text) || Boolean(row.detail?.toLowerCase().includes(text))));
  return { rows: matching.filter((row) => row.state !== 'removed'), removed: matching.filter((row) => row.state === 'removed') };
}

/** How many rows each tab has, removed ones aside. */
export function libraryCounts(rows: LibraryRow[]): Record<LibraryKind, number> {
  const counts: Record<LibraryKind, number> = { plugins: 0, mcps: 0, skills: 0, hooks: 0, instructions: 0 };
  for (const row of rows) if (row.state !== 'removed') counts[row.kind] += 1;
  return counts;
}

/**
 * Where a row is on, in words' terms: on every machine with a home for it, on some, off everywhere, or (for what the
 * repo doesn't list) on the machines that have it.
 */
export type LibraryScope =
  | { kind: 'all' }
  | { kind: 'some'; on: number; of: number }
  | { kind: 'off' }
  | { kind: 'unlisted'; on: number; of: number };

export function libraryScope(row: LibraryRow): LibraryScope {
  const of = row.fleet.length;
  const on = row.on.filter((machine) => row.fleet.includes(machine)).length;
  if (row.state === 'unlisted') return { kind: 'unlisted', on, of };
  if (row.state !== 'on') return { kind: 'off' };
  return row.exceptions === 0 || on >= of ? { kind: 'all' } : { kind: 'some', on, of };
}

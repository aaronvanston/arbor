import { invokeCommand } from '../native/commands';
import { columnKey, toolSafe, type ExtHome, type ExtensionsView, type McpCell, type McpRow } from './setupPlugins';
import type { McpAction, McpChange, McpRegistry, McpWanted, ServerView } from '../native/types';
import { tracked } from './productAnalytics';

/**
 * The setup repo's .agents/mcp-servers.json defines each MCP server for Claude Code and for Codex, with the machines
 * that have their own definition or none, and names each secret as a variable rather than holding it. How each home's
 * servers stand against it is worked out on the backend, by fingerprint, from the machines' last scans.
 */
export const MCP_FILE = '.agents/mcp-servers.json';

export const getMcpRegistry = (repo: string) => invokeCommand('get_mcp_registry', { repo });
/** Makes a machine's servers match the repo at `commit`, then reads the machine again. */
export const applyMcpChanges = (repo: string, commit: string, machine: string, changes: McpChange[]) =>
  tracked('mcp-changed', invokeCommand('apply_mcp_changes', { repo, commit, machine, changes }), { count: changes.length });
/** Sets what the repo wants of a server, for every machine (`machine` null) or one, as a commit of the file alone. */
export const setMcpWanted = (repo: string, name: string, machine: string | null, wanted: McpWanted) =>
  invokeCommand('set_mcp_wanted', { repo, name, machine, wanted });
/** Commits a home's server to the repo, as its agent's definition for every machine or as the machine's own. */
export const takeMcpServer = (repo: string, machine: string, home: string, name: string, own: boolean) =>
  invokeCommand('take_mcp_server', { repo, machine, home, name, own });

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

const byName = (a: string, b: string) => a.localeCompare(b);
const cellKey = (home: Pick<ExtHome, 'machine' | 'path'>, name: string) => `${columnKey(home)}\u0000${name}`;

/**
 * The page's MCP servers with the repo's: each row's definition there, each cell's state against it, and a row for each
 * server that only the repo has. Servers from plugins and claude.ai are never the repo's.
 */
export function withRegistry(view: ExtensionsView, registry: McpRegistry | null): ExtensionsView {
  if (!registry) return view;
  const servers = new Map(registry.servers.map((server) => [server.name, server]));
  const cells = new Map(registry.cells.map((cell) => [cellKey({ machine: cell.machine, path: cell.home }, cell.name), cell]));
  const attach = (name: string, row: McpCell[]) => row.map((cell): McpCell => ({ ...cell, repo: cells.get(cellKey(cell.home, name)) ?? null }));
  const configured = view.servers
    .filter((row) => row.origin === 'config')
    .map((row): McpRow => ({ ...row, repo: servers.get(row.name) ?? null, cells: attach(row.name, row.cells) }));
  const known = new Set(configured.map((row) => row.name));
  const repoOnly = registry.servers
    .filter((server) => !known.has(server.name))
    .map((server): McpRow => ({
      name: server.name,
      toolName: toolSafe(server.name),
      origin: 'config',
      plugin: null,
      repo: server,
      cells: attach(server.name, view.mcpHomes.map((home) => ({ home, item: null, variant: null, health: null, repo: null }))),
    }));
  const others = view.servers.filter((row) => row.origin !== 'config');
  return { ...view, servers: [...[...configured, ...repoOnly].sort((a, b) => byName(a.name, b.name)), ...others] };
}

/** The repo keeps the server's name with no definition: every machine is to be rid of it. */
export const isRemovedServer = (server: ServerView) => !server.claude && !server.codex && !server.own.length;

/** What the repo wants of a server on one machine: as every machine has it, its own definition, or kept off it. */
export function mcpWantedOn(server: ServerView, machine: string): 'removed' | 'default' | 'own' | 'off' {
  if (isRemovedServer(server)) return 'removed';
  if (server.off.includes(machine)) return 'off';
  return server.own.includes(machine) ? 'own' : 'default';
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/** Changes chosen on the page, one per server in a home, by `mcpKey`. */
export type PendingMcp = Record<string, McpAction>;
export const mcpKey = (home: Pick<ExtHome, 'machine' | 'path'>, name: string) => `${columnKey(home)}\u0000mcp\u0000${name}`;

/**
 * What can be done to a home's server to bring it in step with the repo. A server the repo hasn't got is only offered
 * for removal once the repo keeps MCP servers at all.
 */
export function mcpOptions(cell: McpCell, found: boolean): McpAction[] {
  if (!cell.home.reachable || !cell.repo || cell.repo.blocked) return [];
  switch (cell.repo.state) {
    case 'add': return ['add'];
    case 'update': return ['update'];
    case 'extra': return found ? ['remove'] : [];
    default: return [];
  }
}

/** A home's server can be taken into the repo when the repo has it differently there, or not at all. */
export const canTake = (cell: McpCell) =>
  Boolean(
    cell.home.reachable
      && cell.item
      && cell.repo
      && (cell.repo.state === 'update' || cell.repo.state === 'extra')
      && cell.repo.blocked !== 'outside'
      && cell.repo.blocked !== 'name',
  );

/** The chosen changes that still hold once the repo or the machines are read again. */
export function settleMcp(view: ExtensionsView, found: boolean, pending: PendingMcp): PendingMcp {
  const settled: PendingMcp = {};
  for (const row of view.servers) {
    for (const cell of row.cells) {
      const key = mcpKey(cell.home, row.name);
      if (pending[key] && mcpOptions(cell, found).includes(pending[key])) settled[key] = pending[key];
    }
  }
  return settled;
}

/**
 * A chosen change, as the review lists it. `own`: the repo's definition is the machine's own. `signsOut`: Claude Code
 * forgets a remote server's sign-in when it takes the server out to replace it.
 */
export type PlannedMcp = { home: ExtHome; name: string; action: McpAction; own: boolean; signsOut: boolean };

/** The chosen changes by machine, in the page's order. */
export function plannedMcp(view: ExtensionsView, pending: PendingMcp): Map<string, PlannedMcp[]> {
  const planned: PlannedMcp[] = [];
  for (const row of view.servers) {
    for (const cell of row.cells) {
      const action = pending[mcpKey(cell.home, row.name)];
      if (!action) continue;
      const remote = Boolean(cell.item?.value && cell.item.value !== 'stdio');
      planned.push({ home: cell.home, name: row.name, action, own: cell.repo?.own === true, signsOut: action === 'update' && cell.home.agent === 'claude' && remote });
    }
  }
  const byMachine = new Map<string, PlannedMcp[]>();
  for (const machine of new Set(view.mcpHomes.map((home) => home.machine))) {
    const changes = planned.filter((change) => change.home.machine === machine);
    if (changes.length) byMachine.set(machine, changes);
  }
  return byMachine;
}

/** A machine's changes, as the backend takes them. */
export const mcpChanges = (planned: PlannedMcp[]): McpChange[] => planned.map(({ home, name, action }) => ({ home: home.path, name, action }));

/** Changes the page offers to make in one go: servers the repo has that homes are missing, and ones set up differently. Removals never are. */
export type McpSuggestion = { kind: 'repoAdd' | 'repoUpdate'; keys: PendingMcp; count: number };

export function mcpSuggestions(view: ExtensionsView, found: boolean, pending: PendingMcp): McpSuggestion[] {
  const keys: Record<McpSuggestion['kind'], PendingMcp> = { repoAdd: {}, repoUpdate: {} };
  for (const row of view.servers) {
    for (const cell of row.cells) {
      const key = mcpKey(cell.home, row.name);
      if (pending[key]) continue;
      const options = mcpOptions(cell, found);
      if (options.includes('add')) keys.repoAdd[key] = 'add';
      else if (options.includes('update')) keys.repoUpdate[key] = 'update';
    }
  }
  return (['repoAdd', 'repoUpdate'] as const)
    .map((kind) => ({ kind, keys: keys[kind], count: Object.keys(keys[kind]).length }))
    .filter((suggestion) => suggestion.count > 0);
}

// ---------------------------------------------------------------------------
// Taking a server into the repo
// ---------------------------------------------------------------------------

/**
 * What taking a home's server into the repo does, for the take dialog.
 * - `replaces`: the repo has a definition for its agent already, which taking it for every machine replaces.
 * - `ownReplaces`: the machine has its own already, which taking it for the machine replaces.
 * - `addsHome`: the repo keeps the server to other homes, so taking it adds this one, on every machine.
 */
export type TakePlan = { row: McpRow; cell: McpCell; replaces: boolean; ownReplaces: boolean; addsHome: boolean };

export function takePlan(row: McpRow, cell: McpCell): TakePlan {
  return {
    row,
    cell,
    replaces: Boolean(row.repo?.[cell.home.agent]),
    ownReplaces: cell.repo?.own === true,
    addsHome: Boolean(row.repo?.homes && !row.repo.homes.includes(cell.home.path)),
  };
}

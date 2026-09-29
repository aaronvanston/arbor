import { invokeCommand } from '../native/commands';
import { policySets, sharesEntry } from './setupInventory';
import type {
  CodexPluginChange,
  McpHealth,
  McpStatus,
  McpUsageReport,
  PluginAction,
  PluginChange,
  PluginCost,
  PluginCosts,
  PluginLeftover,
  PluginWanted,
  RegistryCell,
  RepoPlugin,
  ServerView,
  SetupItem,
  SetupMachine,
  TokenEstimate,
} from '../native/types';
import { tracked } from './productAnalytics';

/**
 * Plugins are changed with Claude Code's own `plugin` command on the machine, one Claude Code home at a time, and
 * marketplaces are refreshed or added the same way. Nothing is ever accepted on anyone's behalf: a plugin whose
 * install runs a command its marketplace declares comes back as `needsYou`.
 */

export const applyPluginChanges = (machine: string, changes: PluginChange[]) => tracked('plugins-changed', invokeCommand('apply_plugin_changes', { machine, changes }), { count: changes.length });
/** Installs, removes and turns plugins on or off in a machine's Codex homes. */
export const applyCodexPluginChanges = (machine: string, changes: CodexPluginChange[]) =>
  tracked('plugins-changed', invokeCommand('apply_codex_plugin_changes', { machine, changes }), { count: changes.length });

/** Marketplaces the Codex app keeps for itself, whose plugins Arbor leaves as the app has them. */
const CODEX_OWN_MARKETPLACES: readonly string[] = ['openai-bundled', 'openai-primary-runtime'];
export const isCodexOwnMarketplace = (name: string) => CODEX_OWN_MARKETPLACES.includes(name);

/** What Arbor can do to a Codex plugin in one home, as the home's last scan found it. */
export function codexPluginActions(row: PluginRow, cell: PluginCell): PluginAction[] {
  if (isCodexOwnMarketplace(row.marketplace) || !cell.home.reachable) return [];
  if (cell.place === 'on') return ['disable', 'uninstall'];
  if (cell.place === 'off') return ['enable', 'uninstall'];
  return cell.hasMarketplace ? ['install'] : [];
}
/** Takes plugins a home's settings name but that aren't installed out of those settings, backed up and undoable. */
export const forgetPluginLeftovers = (machine: string, leftovers: PluginLeftover[]) =>
  tracked('plugins-changed', invokeCommand('forget_plugin_leftovers', { machine, leftovers }), { count: leftovers.length });
export const checkMcpHealth = (machine: string, home: string) => invokeCommand('check_mcp_health', { machine, home });
export const measurePluginCosts = (machine: string, home: string) => invokeCommand('measure_plugin_costs', { machine, home });
export const getMcpUsage = (days: number, plugins: string[]) => invokeCommand('get_mcp_usage', { days, plugins });

/** A marketplace nobody has fetched for this long is stale, unless Claude Code keeps it up to date itself. */
export const STALE_MS = 7 * 86_400_000;

/** A Claude Code or Codex home on one machine: a column. */
export type ExtHome = { machine: string; path: string; agent: 'claude' | 'codex'; reachable: boolean };
export const columnKey = (home: Pick<ExtHome, 'machine' | 'path'>) => `${home.machine}\u0000${home.path}`;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

const VERSION = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Orders two versions: negative when `a` is older. Null when either isn't a version, such as the commit Claude Code
 * records for a plugin without one.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  // The numbers group isn't optional in the pattern, so any match has it.
  const leftNumbers = left?.[1];
  const rightNumbers = right?.[1];
  if (!left || !right || leftNumbers === undefined || rightNumbers === undefined) return null;
  const [x, y] = [leftNumbers.split('.').map(Number), rightNumbers.split('.').map(Number)];
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  // A pre-release comes before its release.
  if (left[2] === right[2]) return 0;
  if (!left[2]) return 1;
  if (!right[2]) return -1;
  return left[2].localeCompare(right[2], undefined, { numeric: true }) < 0 ? -1 : 1;
}

/** The newest of the versions, when they can all be ordered and aren't all the same. */
export function newestVersion(versions: string[]): string | null {
  const [first, ...rest] = [...new Set(versions)];
  if (first === undefined || !rest.length) return first ?? null;
  let newest = first;
  for (const version of rest) {
    const order = compareVersions(version, newest);
    if (order === null) return null;
    if (order > 0) newest = version;
  }
  return newest;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/**
 * Where a plugin stands in a Claude Code home.
 * - `on`, `off`: installed, and turned on or off.
 * - `missing`: turned on in settings but not installed, so it doesn't load.
 * - `none`: not installed.
 */
export type PluginPlace = 'on' | 'off' | 'missing' | 'none';
/**
 * `behind`: installed, and older than the newest version any home has. `policy`: the managed-settings policy file that
 * turns it on or off on the home's machine, which only leaves updating it to Setup.
 */
export type PluginCell = {
  home: ExtHome;
  item: SetupItem | null;
  place: PluginPlace;
  behind: boolean;
  hasMarketplace: boolean;
  policy: string | null;
  /** What the setup repo wants of it on the home's machine, once the repo is read and lists it. */
  wanted: WantedHere | null;
};
/**
 * The repo's value for a plugin on one machine. `own`: the machine's own value rather than All machines'. `differs`:
 * the home doesn't have it that way.
 */
export type WantedHere = { value: PluginWanted; own: boolean; differs: boolean };
export type PluginRow = {
  id: string;
  name: string;
  marketplace: string;
  /** Null when its versions can't be ordered, or no home has it installed. */
  newest: string | null;
  /** The versions installed differ, and can't be ordered. */
  mixed: boolean;
  /** Its marketplace's GitHub repository, as some home has it, so a home without the marketplace can add it. */
  source: string | null;
  /** The setup repo's listing of it, once that's read. */
  repo: RepoPlugin | null;
  cells: PluginCell[];
};

export type MarketplaceCell = { home: ExtHome; item: SetupItem | null; fetchedMs: number | null; auto: boolean | null; stale: boolean };
export type MarketplaceRow = {
  name: string;
  /** Where it comes from, as a home has it: a GitHub repository, a git host and path, or a folder. */
  source: string | null;
  /** The same, when it's a GitHub repository that another home can add. */
  github: string | null;
  cells: MarketplaceCell[];
};

/**
 * `variant`: a letter for how it's set up, when the same agent's homes don't all have it the same way. `repo`: how it
 * stands against the setup repo's, once that's read.
 */
export type McpCell = { home: ExtHome; item: SetupItem | null; variant: string | null; health: McpStatus | null; repo: RegistryCell | null };
export type McpRow = {
  name: string;
  /** Its name as its tools' names give it, which usage goes by. */
  toolName: string;
  /** Set up in a home, or only seen in a health check: one of a plugin's, or a claude.ai connector. */
  origin: 'config' | 'plugin' | 'claudeai';
  /** The plugin a plugin's server is from. */
  plugin: string | null;
  /** The setup repo's definition of it, once that's read. */
  repo: ServerView | null;
  cells: McpCell[];
};

export type ExtensionsView = {
  /** Claude Code homes, which plugins and marketplaces are in. */
  claudeHomes: ExtHome[];
  /** Codex homes, with plugins and marketplaces of their own, which aren't Claude Code's. */
  codexHomes: ExtHome[];
  codexPlugins: PluginRow[];
  codexMarketplaces: MarketplaceRow[];
  /** Claude Code's then Codex's homes, which MCP servers are in. */
  mcpHomes: ExtHome[];
  plugins: PluginRow[];
  marketplaces: MarketplaceRow[];
  servers: McpRow[];
};

/** A GitHub repository as a marketplace's source gives it: `owner/repo`. */
export const isGithubRepo = (source: string | null | undefined): source is string =>
  Boolean(source && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(source));

/** A server's name as Claude Code puts it in its tools' names. */
export const toolSafe = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_');

const byName = (a: string, b: string) => a.localeCompare(b);
const homeRank = (home: ExtHome) => (home.agent === 'claude' ? 0 : 2) + (home.path === (home.agent === 'claude' ? '~/.claude' : '~/.codex') ? 0 : 1);

function homesOf(machines: SetupMachine[]): ExtHome[] {
  return machines.flatMap((machine) =>
    machine.homes
      .filter((home): home is typeof home & { agent: 'claude' | 'codex' } => home.agent === 'claude' || home.agent === 'codex')
      // A shadow home's config.toml is the home it shares's, so its servers show, and change, there.
      .filter((home) => !(home.agent === 'codex' && sharesEntry(home, 'config.toml')))
      .map((home): ExtHome => ({ machine: machine.machine, path: home.path, agent: home.agent, reachable: machine.reachable }))
      .sort((a, b) => homeRank(a) - homeRank(b) || a.path.localeCompare(b.path)));
}

function itemsBy(machines: SetupMachine[], kind: SetupItem['kind']): Map<string, Map<string, SetupItem>> {
  const found = new Map<string, Map<string, SetupItem>>();
  for (const machine of machines) {
    for (const home of machine.homes) {
      const items = new Map(home.items.filter((item) => item.kind === kind).map((item) => [item.name, item]));
      found.set(columnKey({ machine: machine.machine, path: home.path }), items);
    }
  }
  return found;
}

const timeOf = (value: string | null) => {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** Where a health check's server comes from, by its name. */
function healthOrigin(name: string): Pick<McpRow, 'origin' | 'plugin'> {
  const plugin = /^plugin:([^:]+):/.exec(name)?.[1];
  if (plugin) return { origin: 'plugin', plugin };
  return { origin: name.startsWith('claude.ai ') ? 'claudeai' : 'config', plugin: null };
}

/** Every plugin, marketplace and MCP server in every Claude Code and Codex home, and where each stands in each. */
export function extensionsView(machines: SetupMachine[], health: Record<string, McpHealth> = {}, now = Date.now()): ExtensionsView {
  const homes = homesOf(machines);
  const claudeHomes = homes.filter((home) => home.agent === 'claude');
  const plugins = itemsBy(machines, 'plugin');
  const marketplaces = itemsBy(machines, 'marketplace');
  const servers = itemsBy(machines, 'mcp');
  const cellItems = (found: Map<string, Map<string, SetupItem>>, home: ExtHome, name: string) => found.get(columnKey(home))?.get(name) ?? null;

  const policies = new Map(machines.map((machine) => [machine.machine, machine]));
  // Codex's config lists what it has; it never records when a marketplace was fetched, so none is ever stale.
  const marketplaceRowsOf = (agentHomes: ExtHome[], codex: boolean) => {
    const names = new Set(agentHomes.flatMap((home) => [...(marketplaces.get(columnKey(home))?.keys() ?? [])]));
    return [...names].sort(byName).map((name): MarketplaceRow => {
      const cells = agentHomes.map((home): MarketplaceCell => {
        const item = cellItems(marketplaces, home, name);
        const fetchedMs = timeOf(item?.value ?? null);
        const auto = item?.enabled ?? null;
        return { home, item, fetchedMs, auto, stale: !codex && item !== null && auto !== true && (fetchedMs === null || now - fetchedMs > STALE_MS) };
      });
      const sources = cells.map((cell) => cell.item?.note).filter((note): note is string => Boolean(note));
      return { name, source: sources[0] ?? null, github: sources.find(isGithubRepo) ?? null, cells };
    });
  };
  const pluginRowsOf = (agentHomes: ExtHome[], marketplaceRows: MarketplaceRow[], codex: boolean) => {
    const github = new Map(marketplaceRows.map((row) => [row.name, row.github]));
    const ids = new Set(agentHomes.flatMap((home) => [...(plugins.get(columnKey(home))?.keys() ?? [])]));
    return [...ids].sort(byName).map((id): PluginRow => {
      const at = id.lastIndexOf('@');
      const [name, marketplace] = at > 0 ? [id.slice(0, at), id.slice(at + 1)] : [id, ''];
      const items = agentHomes.map((home) => cellItems(plugins, home, id));
      const versions = items.map((item) => item?.value).filter((version): version is string => Boolean(version));
      const newest = newestVersion(versions);
      const cells = agentHomes.map((home, index): PluginCell => {
        // One item per home, so it's never missing; the fallback only satisfies the type checker.
        const item = items[index] ?? null;
        // Codex's config names only what's installed, so a plugin listed there is installed, on or off.
        const place: PluginPlace = !item
          ? 'none'
          : codex ? (item.enabled === false ? 'off' : 'on')
          : item.value === null ? (item.enabled === true ? 'missing' : 'none') : item.enabled === false ? 'off' : 'on';
        const behind = Boolean(item?.value && newest && item.value !== newest && (compareVersions(item.value, newest) ?? 0) < 0);
        const machine = policies.get(home.machine);
        const policy = !codex && policySets(machine, 'plugin', id) ? machine?.policy?.file ?? null : null;
        return { home, item, place, behind, hasMarketplace: cellItems(marketplaces, home, marketplace) !== null, policy, wanted: null };
      });
      return { id, name, marketplace, newest, mixed: newest === null && new Set(versions).size > 1, source: github.get(marketplace) ?? null, repo: null, cells };
    });
  };
  const marketplaceRows = marketplaceRowsOf(claudeHomes, false);
  const pluginRows = pluginRowsOf(claudeHomes, marketplaceRows, false);
  const codexHomes = homes.filter((home) => home.agent === 'codex');
  const codexMarketplaces = marketplaceRowsOf(codexHomes, true);
  const codexPlugins = pluginRowsOf(codexHomes, codexMarketplaces, true);

  const configured = new Set(homes.flatMap((home) => [...(servers.get(columnKey(home))?.keys() ?? [])]));
  const checked = new Set(claudeHomes.flatMap((home) => health[columnKey(home)]?.servers.map((server) => server.name) ?? []));
  const serverRows = [...new Set([...configured, ...checked])].sort((a, b) => {
    const rank = (name: string) => (configured.has(name) ? 0 : 1);
    return rank(a) - rank(b) || byName(a, b);
  }).map((name): McpRow => {
    const items = homes.map((home) => cellItems(servers, home, name));
    // Letters for how it's set up, by agent: Claude Code's and Codex's settings aren't alike, so they're never compared.
    const letters = new Map<string, string>();
    for (const agent of ['claude', 'codex'] as const) {
      const sums = [...new Set(homes.flatMap((home, index) => (home.agent === agent && items[index]?.sum ? [items[index]!.sum!] : [])))];
      if (sums.length > 1) sums.forEach((sum, index) => letters.set(`${agent}:${sum}`, String.fromCharCode(65 + (index % 26))));
    }
    const cells = homes.map((home, index): McpCell => {
      // One item per home, so it's never missing; the fallback only satisfies the type checker.
      const item = items[index] ?? null;
      const status = home.agent === 'claude' ? health[columnKey(home)]?.servers.find((server) => server.name === name)?.status ?? null : null;
      return { home, item, variant: item?.sum ? letters.get(`${home.agent}:${item.sum}`) ?? null : null, health: status, repo: null };
    });
    return { name, toolName: toolSafe(name), ...(configured.has(name) ? { origin: 'config' as const, plugin: null } : healthOrigin(name)), repo: null, cells };
  });

  return { claudeHomes, codexHomes, codexPlugins, codexMarketplaces, mcpHomes: homes, plugins: pluginRows, marketplaces: marketplaceRows, servers: serverRows };
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/** Changes chosen on the page, one per plugin or marketplace in a home, by `changeKey`. */
export type PendingPlugins = Record<string, PluginAction>;
export const changeKey = (home: ExtHome, what: 'plugin' | 'marketplace', target: string) => `${columnKey(home)}\u0000${what}\u0000${target}`;

/** What can be done to a plugin in a home, as the backend allows it. A home that hasn't got its marketplace can add it from GitHub. */
export function pluginOptions(row: PluginRow, cell: PluginCell): PluginAction[] {
  if (!cell.home.reachable) return [];
  // Installing, turning on or off and removing each write the home's enabledPlugins, which the policy decides.
  if (cell.policy) return cell.place === 'on' || cell.place === 'off' ? ['update'] : [];
  switch (cell.place) {
    case 'on': return ['update', 'disable', 'uninstall'];
    case 'off': return ['enable', 'update', 'uninstall'];
    default: return cell.hasMarketplace || row.source ? ['install'] : [];
  }
}

/**
 * The plugins installed from a marketplace in a home that aren't being removed in the chosen changes. A marketplace
 * can only go once this is empty, since Claude Code would take its plugins with it.
 */
export function pluginsFrom(view: ExtensionsView, marketplace: string, home: ExtHome, pending: PendingPlugins): string[] {
  return view.plugins.flatMap((row) => {
    if (row.marketplace !== marketplace) return [];
    const cell = row.cells.find((entry) => columnKey(entry.home) === columnKey(home));
    if (!cell || (cell.place !== 'on' && cell.place !== 'off')) return [];
    return pending[changeKey(home, 'plugin', row.id)] === 'uninstall' ? [] : [row.id];
  });
}

/**
 * What can be done to a marketplace in a home. It can be removed once nothing is installed from it there, counting
 * the removals already chosen.
 */
export function marketplaceOptions(row: MarketplaceRow, cell: MarketplaceCell, view: ExtensionsView, pending: PendingPlugins): PluginAction[] {
  if (!cell.home.reachable) return [];
  if (cell.item) return pluginsFrom(view, row.name, cell.home, pending).length ? ['refresh'] : ['refresh', 'removeMarketplace'];
  return row.github ? ['addMarketplace'] : [];
}

/** The chosen changes that still hold after the machines are read again. */
export function settlePlugins(view: ExtensionsView, pending: PendingPlugins): PendingPlugins {
  const settled: PendingPlugins = {};
  for (const row of view.plugins) {
    for (const cell of row.cells) {
      const key = changeKey(cell.home, 'plugin', row.id);
      if (pending[key] && pluginOptions(row, cell).includes(pending[key])) settled[key] = pending[key];
    }
  }
  for (const row of view.marketplaces) {
    for (const cell of row.cells) {
      const key = changeKey(cell.home, 'marketplace', row.name);
      if (pending[key] && marketplaceOptions(row, cell, view, settled).includes(pending[key])) settled[key] = pending[key];
    }
  }
  return settled;
}

/** A chosen change, as the review lists it. `auto`: a marketplace added because an install needs it. */
export type PlannedPlugin = { home: ExtHome; action: PluginAction; target: string; source: string | null; auto: boolean };

/**
 * The chosen changes by machine, in the page's order, with each install's marketplace added first where its home
 * hasn't got it and nothing else adds it, and marketplaces being removed last.
 */
export function plannedPlugins(view: ExtensionsView, pending: PendingPlugins): Map<string, PlannedPlugin[]> {
  const planned: PlannedPlugin[] = [];
  // Removing a marketplace runs after its plugins are removed, so the review lists it after them too.
  const removals: PlannedPlugin[] = [];
  const added = new Set<string>();
  for (const row of view.marketplaces) {
    for (const cell of row.cells) {
      const action = pending[changeKey(cell.home, 'marketplace', row.name)];
      if (!action) continue;
      // A marketplace being removed keeps its source, so the review can say where to add it back from.
      const source = action === 'addMarketplace' ? row.github : action === 'removeMarketplace' ? row.source : null;
      (action === 'removeMarketplace' ? removals : planned).push({ home: cell.home, action, target: row.name, source, auto: false });
      if (action === 'addMarketplace') added.add(`${columnKey(cell.home)}\u0000${row.name}`);
    }
  }
  for (const row of view.plugins) {
    for (const cell of row.cells) {
      const action = pending[changeKey(cell.home, 'plugin', row.id)];
      if (!action) continue;
      const needs = `${columnKey(cell.home)}\u0000${row.marketplace}`;
      if (action === 'install' && !cell.hasMarketplace && !added.has(needs) && row.source) {
        planned.push({ home: cell.home, action: 'addMarketplace', target: row.marketplace, source: row.source, auto: true });
        added.add(needs);
      }
      planned.push({ home: cell.home, action, target: row.id, source: null, auto: false });
    }
  }
  planned.push(...removals);
  // Machines in the page's order.
  const byMachine = new Map<string, PlannedPlugin[]>();
  for (const machine of new Set(view.claudeHomes.map((home) => home.machine))) {
    const changes = planned.filter((change) => change.home.machine === machine);
    if (changes.length) byMachine.set(machine, changes);
  }
  return byMachine;
}

/** A machine's changes, as the backend takes them. */
export const pluginChanges = (planned: PlannedPlugin[]): PluginChange[] =>
  planned.map(({ home, action, target, source }) => ({ home: home.path, action, target, ...(source && action === 'addMarketplace' ? { source } : {}) }));

/** Changes the page offers to make in one go. */
export type PluginSuggestion = { kind: 'behind' | 'stale' | 'repoPlugins'; keys: Record<string, PluginAction>; count: number };

/** Plugins older than the newest version another home has, and marketplaces nobody has fetched lately. */
export function pluginSuggestions(view: ExtensionsView, pending: PendingPlugins): PluginSuggestion[] {
  const behind: Record<string, PluginAction> = {};
  for (const row of view.plugins) {
    for (const cell of row.cells) {
      const key = changeKey(cell.home, 'plugin', row.id);
      if (cell.behind && cell.home.reachable && !pending[key]) behind[key] = 'update';
    }
  }
  const stale: Record<string, PluginAction> = {};
  for (const row of view.marketplaces) {
    for (const cell of row.cells) {
      const key = changeKey(cell.home, 'marketplace', row.name);
      if (cell.stale && cell.home.reachable && !pending[key]) stale[key] = 'refresh';
    }
  }
  return ([['behind', behind], ['stale', stale]] as const)
    .map(([kind, keys]) => ({ kind, keys, count: Object.keys(keys).length }))
    .filter((suggestion) => suggestion.count > 0);
}

// ---------------------------------------------------------------------------
// Use
// ---------------------------------------------------------------------------

/** How much a server was used, by its tools' names. */
export const serverUsage = (row: McpRow, usage: McpUsageReport | null) => usage?.servers.find((entry) => entry.name === row.toolName) ?? null;

/** A server set up in a Claude Code home that no session called lately. Codex's servers aren't judged. */
export const unusedServer = (row: McpRow, usage: McpUsageReport | null) =>
  Boolean(usage && usage.counted > 0 && row.origin === 'config' && row.cells.some((cell) => cell.home.agent === 'claude' && cell.item) && !serverUsage(row, usage));

/** The plugins' names, to ask how much each was used. */
export const pluginNames = (view: ExtensionsView) => [...new Set(view.plugins.map((row) => row.name))].sort(byName);

// ---------------------------------------------------------------------------
// Token cost
// ---------------------------------------------------------------------------

/**
 * A plugin's cost as a home measured it. When homes measured it differently, since they can run different versions,
 * the one that costs most, so a plugin doesn't look cheaper than it is anywhere.
 */
export function pluginCost(costs: Record<string, PluginCosts>, id: string): PluginCost | null {
  let found: PluginCost | null = null;
  for (const measured of Object.values(costs)) {
    const cost = measured.plugins.find((entry) => entry.id === id);
    if (!cost) continue;
    if (!found || (cost.alwaysOn && (!found.alwaysOn || cost.alwaysOn.tokens > found.alwaysOn.tokens))) found = cost;
  }
  return found;
}

/**
 * What the plugins on in a home add to every session there, from that home's own measure. `under` when some plugin's
 * share was only given as less than an amount. Null until the home is measured.
 */
export function homePluginTokens(rows: PluginRow[], home: ExtHome, costs: Record<string, PluginCosts>): TokenEstimate | null {
  const measured = costs[columnKey(home)];
  if (!measured) return null;
  let tokens = 0;
  let under = false;
  for (const row of rows) {
    const cell = row.cells.find((entry) => columnKey(entry.home) === columnKey(home));
    if (cell?.place !== 'on') continue;
    const cost = measured.plugins.find((entry) => entry.id === row.id)?.alwaysOn;
    if (!cost) continue;
    tokens += cost.tokens;
    under ||= cost.under;
  }
  return { tokens, under };
}

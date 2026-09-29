import { invokeCommand } from '../native/commands';
import { machineLookKey } from './machineLook';
import { changeKey, codexPluginActions, isCodexOwnMarketplace, pluginOptions, type ExtensionsView, type PendingPlugins, type PluginCell, type PluginPlace, type PluginRow, type PluginSuggestion, type WantedHere } from './setupPlugins';
import type { PluginAction, PluginWanted, RepoPlugin } from '../native/types';

/**
 * The setup repo's .agents/plugins.json lists plugins with a value for All machines, on, off or removed, and the
 * machines with their own: on, off, removed, or left as the machine has it. A home is brought in step through the
 * plugin review, with Claude Code's own plugin command: "off" turns a plugin off and keeps it, "removed" uninstalls it.
 */
export const PLUGINS_FILE = '.agents/plugins.json';

/**
 * Lists a plugin in the repo for All machines (`machine` null) or gives a machine its own value; with `wanted` null
 * takes the machine's own value out, or the plugin, for All machines. Commits the one file.
 */
export const setSetupPlugin = (repo: string, plugin: string, source: string | null, machine: string | null, wanted: PluginWanted | null) =>
  invokeCommand('set_setup_plugin', { repo, plugin, source, project: null, machine, wanted });

/**
 * Gives a project its own value for a listed plugin, on every machine (`machine` null) or on one, or with `wanted` null
 * lets it follow its machine again. Commits the one file.
 */
export const setSetupPluginProject = (repo: string, plugin: string, project: string, machine: string | null, wanted: 'on' | 'off' | null) =>
  invokeCommand('set_setup_plugin', { repo, plugin, source: null, project, machine, wanted });

/**
 * Lists a Codex plugin in the repo, under its own section, for All machines (`machine` null) or gives a machine its own
 * value; with `wanted` null takes the machine's own value out, or the plugin, for All machines. `source` records its
 * marketplace's GitHub repository, so a machine without the marketplace can add it. Commits the one file.
 */
export const setSetupCodexPlugin = (repo: string, plugin: string, source: string | null, machine: string | null, wanted: PluginWanted | null) =>
  invokeCommand('set_setup_codex_plugin', { repo, plugin, source, machine, wanted });

/** A machine's value for a listed plugin: its own, else All machines'. */
export function wantedOn(plugin: RepoPlugin, machine: string): { value: PluginWanted; own: boolean } {
  const own = plugin.machines[machineLookKey(machine)];
  return own ? { value: own, own: true } : { value: plugin.all, own: false };
}

/**
 * Whether a home has a plugin other than as wanted. A plugin turned on in settings but not installed doesn't load, so
 * it's already off; and a machine keeping its own is never out of step.
 */
export function differs(place: PluginPlace, wanted: PluginWanted): boolean {
  switch (wanted) {
    case 'on': return place !== 'on';
    case 'off': return place === 'on';
    // A plugin turned on in settings but not installed has nothing to remove.
    case 'removed': return place === 'on' || place === 'off';
    default: return false;
  }
}

const emptyCell = (home: PluginCell['home'], hasMarketplace: boolean): PluginCell =>
  ({ home, item: null, place: 'none', behind: false, hasMarketplace, policy: null, wanted: null });

/** Plugin rows with the repo's: each row's listing, each cell's value against it, and a row for each plugin only the repo has. */
function withRepoRows(rows: PluginRow[], homes: PluginCell['home'][], marketplaces: ExtensionsView['marketplaces'], plugins: RepoPlugin[]): PluginRow[] {
  const listed = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const attach = (row: PluginRow, plugin: RepoPlugin): PluginRow => ({
    ...row,
    repo: plugin,
    source: row.source ?? plugin.source,
    cells: row.cells.map((cell): PluginCell => {
      const { value, own } = wantedOn(plugin, cell.home.machine);
      const wanted: WantedHere = { value, own, differs: differs(cell.place, value) };
      return { ...cell, wanted };
    }),
  });
  const known = new Set(rows.map((row) => row.id));
  const has = (home: PluginCell['home'], marketplace: string) =>
    marketplaces.some((row) => row.name === marketplace && row.cells.some((cell) => cell.item && cell.home.machine === home.machine && cell.home.path === home.path));
  const repoOnly = plugins.filter((plugin) => !known.has(plugin.id)).map((plugin) => {
    const at = plugin.id.lastIndexOf('@');
    const [name, marketplace] = [plugin.id.slice(0, at), plugin.id.slice(at + 1)];
    // Its marketplace's repository, as a home that has the marketplace gives it, before the repo's own.
    const source = marketplaces.find((row) => row.name === marketplace)?.github ?? null;
    const row: PluginRow = { id: plugin.id, name, marketplace, newest: null, mixed: false, source, repo: null, cells: homes.map((home) => emptyCell(home, has(home, marketplace))) };
    return attach(row, plugin);
  });
  const attached = rows.map((row) => {
    const plugin = listed.get(row.id);
    return plugin ? attach(row, plugin) : row;
  });
  return [...attached, ...repoOnly].sort((a, b) => a.id.localeCompare(b.id));
}

/** The page's plugins with the repo's: each row's listing, each cell's value against it, and a row for each plugin only the repo has. */
export function withPluginRepo(view: ExtensionsView, plugins: RepoPlugin[] | null): ExtensionsView {
  if (!plugins?.length) return view;
  return { ...view, plugins: withRepoRows(view.plugins, view.claudeHomes, view.marketplaces, plugins) };
}

/** The page's Codex plugins with the repo's Codex section, as `withPluginRepo` does for Claude Code's. */
export function withCodexPluginRepo(view: ExtensionsView, plugins: RepoPlugin[] | null): ExtensionsView {
  if (!plugins?.length) return view;
  return { ...view, codexPlugins: withRepoRows(view.codexPlugins, view.codexHomes, view.codexMarketplaces, plugins) };
}

/**
 * The change that brings a home in step with the repo's value, when the page can make it there: with Claude Code's
 * plugin review, or for a Codex home (`codex`) with the changes Arbor makes in Codex.
 */
export function repoAction(row: PluginRow, cell: PluginCell, codex = false): PluginAction | null {
  if (!cell.wanted?.differs) return null;
  const options = codex ? codexPluginActions(row, cell) : pluginOptions(row, cell);
  let action: PluginAction = cell.place === 'off' ? 'enable' : 'install';
  if (cell.wanted.value === 'off') action = 'disable';
  if (cell.wanted.value === 'removed') action = 'uninstall';
  return options.includes(action) ? action : null;
}

/**
 * The Codex changes that bring a home in step with the repo, in the order they're made: the plugin's marketplace
 * first when the home hasn't it and its GitHub repository is known, from another home or the repo, then the plugin.
 */
export function codexRepoChanges(row: PluginRow, cell: PluginCell): PluginAction[] {
  const action = repoAction(row, cell, true);
  if (action) return [action];
  const addable = cell.wanted?.differs && cell.wanted.value === 'on' && cell.place === 'none' && !cell.hasMarketplace && cell.home.reachable;
  return addable && row.source && !isCodexOwnMarketplace(row.marketplace) ? ['addMarketplace', 'install'] : [];
}

/** Every change that brings a home in step with the repo's plugins, and isn't chosen already. */
export function pluginRepoSuggestions(view: ExtensionsView, pending: PendingPlugins): PluginSuggestion[] {
  const keys: Record<string, PluginAction> = {};
  for (const row of view.plugins) {
    for (const cell of row.cells) {
      const action = repoAction(row, cell);
      const key = changeKey(cell.home, 'plugin', row.id);
      if (action && !pending[key]) keys[key] = action;
    }
  }
  const count = Object.keys(keys).length;
  return count ? [{ kind: 'repoPlugins', keys, count }] : [];
}

/** The machines with their own value for a plugin, by the names the page shows, with that value. */
export function ownValues(plugin: RepoPlugin, machines: readonly string[]): { machine: string; value: PluginWanted }[] {
  return machines.flatMap((machine) => {
    const value = plugin.machines[machineLookKey(machine)];
    return value ? [{ machine, value }] : [];
  });
}

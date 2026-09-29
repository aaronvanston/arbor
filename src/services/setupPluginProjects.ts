import { projectValueAt, type CheckoutChange, type ProjectCheckout } from './projectCheckouts';
import type { ExtensionsView } from './setupPlugins';
import type { PluginChange, RepoPlugin } from '../native/types';

/**
 * A project's plugins: the setup repo gives a listed plugin a value for a project, and Arbor brings each of the
 * project's checkouts in step with Claude Code's own `plugin enable|disable --scope local`, run in the checkout.
 */

/** The home a checkout's plugins are installed in: Claude Code's default one. */
export const CHECKOUT_HOME = '~/.claude';

/** The project's value for a plugin on a machine: its own there, else the project's; null when it follows the machine. */
export const projectWanted = (plugin: RepoPlugin, project: string, machine: string) => projectValueAt(plugin.projects, project, machine);

/** Whether a home has a plugin installed, and on. */
export type HomePlugin = { installed: boolean; on: boolean };

/** How the page's Claude Code home on a machine has a plugin. */
export function homePlugin(view: ExtensionsView, machine: string, plugin: string): HomePlugin {
  const place = view.plugins
    .find((row) => row.id === plugin)
    ?.cells.find((cell) => cell.home.machine === machine && cell.home.path === CHECKOUT_HOME)?.place;
  return { installed: place === 'on' || place === 'off', on: place === 'on' };
}

/**
 * Whether a plugin loads in a checkout, as Claude Code decides: its local settings, then its checked-in settings, then
 * the home's. A plugin that isn't installed never loads.
 */
export function loadsIn(checkout: ProjectCheckout, plugin: string, home: HomePlugin): { on: boolean; from: 'local' | 'shared' | 'home' } {
  const local = checkout.plugins.find((entry) => entry.local && entry.id === plugin);
  const shared = checkout.plugins.find((entry) => !entry.local && entry.id === plugin);
  const from = local ? 'local' : shared ? 'shared' : 'home';
  const on = (local ?? shared)?.on ?? home.on;
  return { on: on && home.installed, from };
}

/** Every change that brings the project's checkouts in step with the repo, a plugin at a time. */
export function projectChanges(plugins: RepoPlugin[], checkouts: ProjectCheckout[], project: string, home: (machine: string, plugin: string) => HomePlugin): CheckoutChange[] {
  return plugins.flatMap((plugin) =>
    checkouts.flatMap((checkout): CheckoutChange[] => {
      const wanted = projectWanted(plugin, project, checkout.machine);
      if (!wanted) return [];
      const here = home(checkout.machine, plugin.id);
      const on = loadsIn(checkout, plugin.id, here).on;
      if (wanted.value === 'on' && !on) return [{ machine: checkout.machine, checkout: checkout.path, target: plugin.id, on: true, blocked: here.installed ? null : 'notInstalled' }];
      if (wanted.value === 'off' && on) return [{ machine: checkout.machine, checkout: checkout.path, target: plugin.id, on: false, blocked: null }];
      return [];
    }),
  );
}

/** A machine's ready changes as its apply_plugin_changes takes them. */
export const pluginChanges = (changes: CheckoutChange[]): PluginChange[] =>
  changes.map((change) => ({ home: CHECKOUT_HOME, action: change.on ? 'enable' : 'disable', target: change.target, checkout: change.checkout }));

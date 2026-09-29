import { invokeCommand } from '../native/commands';
import { tracked } from './productAnalytics';
import { projectValueAt, type Blocked, type CheckoutChange, type ProjectCheckout } from './projectCheckouts';
import type { CheckoutMcpChange, McpRegistry, RepoProjectValue, SetupMachine } from '../native/types';

/**
 * A project's MCP servers: the setup repo gives a server a value for a project, and Arbor brings each of the project's
 * checkouts in step. Off denies it by name in the checkout's git-ignored .claude/settings.local.json; on takes that out
 * again and, where the machine hasn't the server for every project, sets it up in Claude Code's local scope there.
 */

/** The home a checkout's sessions take their servers from: Claude Code's default one. */
const CHECKOUT_HOME = '~/.claude';

/** How a machine's Claude Code home has a server: set up for every project, and denied by its settings or policy. */
export type HomeServer = { there: boolean; denied: boolean };

export function homeServer(machines: SetupMachine[], machine: string, server: string): HomeServer {
  const home = machines.find((entry) => entry.machine === machine)?.homes.find((entry) => entry.agent === 'claude' && entry.path === CHECKOUT_HOME);
  return {
    there: Boolean(home?.items.some((item) => item.kind === 'mcp' && item.name === server)),
    denied: Boolean(home?.deniedMcp.includes(server)),
  };
}

/**
 * Whether a server loads in a checkout, as Claude Code decides: a deny anywhere keeps it out, then /mcp turning it off
 * there; otherwise it loads when the checkout or the machine has it set up.
 */
export function serverLoadsIn(checkout: ProjectCheckout, server: string, home: HomeServer): { on: boolean; from: 'denied' | 'local' | 'toggled' | 'set' | 'none' } {
  if (home.denied || checkout.mcpDenied.some((entry) => !entry.local && entry.name === server)) return { on: false, from: 'denied' };
  if (checkout.mcpDenied.some((entry) => entry.local && entry.name === server)) return { on: false, from: 'local' };
  if (checkout.mcpDisabled.includes(server)) return { on: false, from: 'toggled' };
  return checkout.mcpLocal.includes(server) || home.there ? { on: true, from: 'set' } : { on: false, from: 'none' };
}

/** Whether the repo sets `server` up in a machine's Claude Code home, so a checkout there can have it. */
export const repoDefines = (registry: McpRegistry | null, machine: string, server: string) =>
  Boolean(registry?.cells.some((cell) => cell.machine === machine && cell.home === CHECKOUT_HOME && cell.name === server && cell.state !== 'extra' && !cell.blocked));

/** Every change that brings the project's checkouts in step with the repo, a server at a time. */
export function projectMcpChanges(
  servers: string[],
  values: Record<string, Record<string, RepoProjectValue>>,
  checkouts: ProjectCheckout[],
  project: string,
  home: (machine: string, server: string) => HomeServer,
  defined: (machine: string, server: string) => boolean,
): CheckoutChange[] {
  return servers.flatMap((server) =>
    checkouts.flatMap((checkout): CheckoutChange[] => {
      const wanted = projectValueAt(values[server] ?? {}, project, checkout.machine);
      if (!wanted) return [];
      const here = home(checkout.machine, server);
      const now = serverLoadsIn(checkout, server, here);
      const on = wanted.value === 'on';
      if (on === now.on) return [];
      let blocked: Blocked | null = null;
      if (on && now.from === 'denied') blocked = 'denied';
      else if (on && now.from === 'toggled') blocked = 'toggled';
      else if (on && !here.there && !checkout.mcpLocal.includes(server) && !defined(checkout.machine, server)) blocked = 'noDefinition';
      // Turning off needs a settings.local.json to deny it in.
      else if (!on && checkout.localSeen) blocked = 'seen';
      return [{ machine: checkout.machine, checkout: checkout.path, target: server, on, blocked }];
    }),
  );
}

/** A machine's ready changes as its apply_checkout_mcp takes them. */
export const mcpChanges = (changes: CheckoutChange[]): CheckoutMcpChange[] =>
  changes.map((change) => ({ checkout: change.checkout, server: change.target, on: change.on }));

/** Gives a project a value for a server on every machine or on one, or with null lets it follow its machine; commits the one file. */
export const setSetupMcpProject = (repo: string, server: string, project: string, machine: string | null, wanted: 'on' | 'off' | null) =>
  invokeCommand('set_setup_mcp_project', { repo, server, project, machine, wanted });

/** Keeps servers out of checkouts on a machine, or has them there, as the repo's last commit defines them. */
export const applyCheckoutMcp = (repo: string, machine: string, changes: CheckoutMcpChange[]) =>
  tracked('mcp-changed', invokeCommand('apply_checkout_mcp', { repo, machine, changes }), { kind: 'checkouts', count: changes.length });

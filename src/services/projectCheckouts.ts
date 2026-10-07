import { machineLookKey } from './machineLook';
import { projectSettingsKey } from './machineSettings';
import type { CheckoutInstructions, CheckoutMcpDeny, CheckoutPlugin, CheckoutSkill, MachineProjects, RepoProjectValue } from '../native/types';

/**
 * A project's own values in the setup repo, for plugins and skills alike: on every machine or on one, applied to each
 * of the project's checkouts in Claude Code's local scope, the checkout's git-ignored .claude/settings.local.json,
 * which wins over the machine's value. Never the checked-in settings.json.
 */

/** One checkout of a project, on a machine, with what its own settings set. */
export type ProjectCheckout = {
  machine: string; path: string; main: boolean; plugins: CheckoutPlugin[]; skills: CheckoutSkill[]; ignoredOverrides: string[];
  /** No settings.local.json yet, and Git wouldn't ignore a new one. */
  localSeen: boolean;
  /** MCP servers its settings deny, ones set up for it alone, and ones turned off in it with /mcp. */
  mcpDenied: CheckoutMcpDeny[]; mcpLocal: string[]; mcpDisabled: string[];
  /** The project instruction files Arbor writes in it, its AGENTS.md's fingerprint, and whether it has a CLAUDE.md. */
  instructions: CheckoutInstructions[]; agentsMd: string | null; claudeMd: boolean;
};

/** `owner/name` from a scanned remote, `host/owner/name`, as project keys have it. */
function remoteProject(remote: string | null): string | null {
  const parts = remote && !remote.startsWith('/') ? remote.split('/') : [];
  return parts.length < 3 ? null : projectSettingsKey(parts.slice(-2).join('/').replace(/\.git$/, ''));
}

/** Every checkout of `project` the last Projects scans found, main checkouts first. */
export function projectCheckouts(scans: MachineProjects[], project: string): ProjectCheckout[] {
  const key = projectSettingsKey(project);
  return scans.flatMap((scan) =>
    scan.repos
      .filter((repo) => repo.state === 'ok' && remoteProject(repo.remote) === key)
      .flatMap((repo) => repo.worktrees.filter((worktree) => !worktree.prunable).map((worktree) => ({
        machine: scan.machine, path: worktree.path, main: worktree.main, plugins: worktree.plugins, skills: worktree.skills, ignoredOverrides: worktree.ignoredOverrides,
        localSeen: worktree.localSeen, mcpDenied: worktree.mcpDenied, mcpLocal: worktree.mcpLocal, mcpDisabled: worktree.mcpDisabled,
        instructions: worktree.instructions, agentsMd: worktree.agentsMd, claudeMd: worktree.claudeMd,
      }))),
  );
}

/** A project's value on a machine: its own there, else the project's; null when it follows the machine. */
export function projectValueAt(values: Record<string, RepoProjectValue>, project: string, machine: string): { value: 'on' | 'off'; own: boolean } | null {
  const found = values[projectSettingsKey(project)];
  const own = found?.machines[machineLookKey(machine)];
  const onOff = (value: string | null | undefined) => (value === 'on' || value === 'off' ? value : null);
  const mine = onOff(own);
  if (mine) return { value: mine, own: true };
  const all = onOff(found?.all);
  return all ? { value: all, own: false } : null;
}

/**
 * Why a change can't be made: turning on something the machine hasn't installed, the machine's managed policy
 * deciding it, a checkout settings file whose value Claude Code ignores already, or a checkout where Git would see
 * the settings.local.json Arbor would have to create. For an MCP server: a deny Arbor doesn't write (the checked-in
 * settings, the machine's or its policy), /mcp having turned it off in that checkout, or no definition in the repo
 * for the machine to set up. For a project's instructions: a file of that name that's someone's own.
 */
export type Blocked = 'notInstalled' | 'policy' | 'ignored' | 'seen' | 'denied' | 'toggled' | 'noDefinition' | 'own';

/** A change a checkout needs to have something as the project wants it. */
export type CheckoutChange = { machine: string; checkout: string; target: string; on: boolean; blocked: Blocked | null };

/**
 * The names a project card works on: every one on Per home, only the item's own on its Library page, so the page's
 * "Make N changes" never touches another server's or skill's checkouts.
 */
export function namesInScope(names: readonly string[], only: string | null): string[] {
  return only === null ? [...names] : names.filter((name) => name === only);
}

/** The changes that can be made, by machine. */
export function readyByMachine(changes: CheckoutChange[]): Map<string, CheckoutChange[]> {
  const byMachine = new Map<string, CheckoutChange[]>();
  for (const change of changes.filter((entry) => !entry.blocked)) {
    byMachine.set(change.machine, [...(byMachine.get(change.machine) ?? []), change]);
  }
  return byMachine;
}

/** How a machine's checkouts of the project stand for one thing: how many there are, and how many aren't as wanted. */
export function checkoutsStanding(changes: CheckoutChange[], checkouts: ProjectCheckout[], machine: string, target: string) {
  const mine = changes.filter((change) => change.machine === machine && change.target === target);
  return {
    total: checkouts.filter((checkout) => checkout.machine === machine).length,
    behind: mine.length,
    blocked: mine.find((change) => change.blocked)?.blocked ?? null,
  };
}

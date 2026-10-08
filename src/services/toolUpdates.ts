import { invokeCommand } from '../native/commands';
import { tracked } from './productAnalytics';
import { compareVersions, TOOL_ORDER } from './setupToolchain';
import type { MachineToolchain, OwnerKind, RepoTool, RepoTools, ToolChange, ToolFound, ToolOwner, ToolResult } from '../native/types';

/**
 * What each tool's installer says is newer than the copy a machine's shell finds first, and updating it the way it
 * was installed. Arbor proves who installed each tool from where it really is; a tool nothing proves, or one the
 * system's packages own (which needs sudo), is an agent's job. A scan asks the installers again by itself when their
 * last answer is six hours old.
 */

/** The backend takes this many tool changes on a machine in one run, so a bigger batch goes in several. */
export const MOST_TOOL_CHANGES = 16;

export const checkToolUpdates = (machine: string, refresh: boolean) => invokeCommand('check_tool_updates', { machine, refresh });

export const changeTools = (machine: string, changes: ToolChange[]) =>
  tracked('tools-changed', invokeCommand('change_tools', { machine, changes }), { count: changes.length });

/** Brings a machine's tools in line with the setup repo's .agents/tools.json. Only `applyEngine` calls it. */
export const applyRepoToolsCommand = (repo: string, machine: string) =>
  tracked('tools-changed', invokeCommand('apply_repo_tools', { repo, machine }), { kind: 'repo' });

/** Gives a tool a value in the setup repo for every machine, or for one, or takes it out with null. */
export const setSetupTool = (repo: string, tool: string, machine: string | null, value: string | null) =>
  invokeCommand('set_setup_tool', { repo, tool, machine, value });

/** The repo's listing of a tool, when it has one. */
export const repoTool = (tools: RepoTools | null | undefined, tool: string): RepoTool | null => tools?.tools.find((entry) => entry.tool === tool) ?? null;

/** Node version managers keep each version apart, so an update names the one to move to. */
const NODE_MANAGERS: ReadonlySet<OwnerKind> = new Set(['nvm', 'fnm', 'asdf', 'volta']);
/** The installers Arbor takes a tool off with; the rest have no command for it, or it needs sudo. */
const REMOVERS: ReadonlySet<OwnerKind> = new Set(['brew', 'mise', 'npm', 'corepack']);

/** Whether Arbor can take a tool off itself, with the installer that put it there. npm stays with its Node. */
export const removesNatively = (found: ToolFound) => Boolean(found.owner && REMOVERS.has(found.owner.kind) && found.tool !== 'npm');

export type ToolUpdate = {
  key: string;
  machine: string;
  tool: string;
  have: string;
  latest: string;
  owner: ToolOwner;
  path: string;
  /** Arbor updates it itself; otherwise it's handed to an agent (the system's packages need sudo). */
  native: boolean;
  change: ToolChange;
};

export const toolUpdateKey = (machine: string, tool: string) => `${machine}\u0000${tool}`;

const toolRank = (tool: string) => {
  const index = (TOOL_ORDER as readonly string[]).indexOf(tool);
  return index < 0 ? TOOL_ORDER.length : index;
};

/**
 * Every tool on every machine its installer has something newer for, by tool and then machine in the order given.
 * rustup updates rustc and cargo together, so cargo goes with rust.
 */
export function toolUpdates(machines: MachineToolchain[]): ToolUpdate[] {
  const out: ToolUpdate[] = [];
  machines.forEach((machine) => {
    if (machine.scannedAt === null || !machine.updates) return;
    for (const latest of machine.updates.latest) {
      const found = machine.tools.find((tool) => tool.tool === latest.tool);
      if (!found?.version || !found.owner || compareVersions(latest.version, found.version) <= 0) continue;
      if (found.tool === 'cargo' && found.owner.kind === 'rustup' && machine.tools.some((tool) => tool.tool === 'rust' && tool.owner?.kind === 'rustup')) continue;
      out.push({
        key: toolUpdateKey(machine.machine, found.tool),
        machine: machine.machine,
        tool: found.tool,
        have: found.version,
        latest: latest.version,
        owner: found.owner,
        path: found.path,
        native: found.owner.kind !== 'system',
        change: { tool: found.tool, action: 'update', version: NODE_MANAGERS.has(found.owner.kind) ? latest.version : null, via: null },
      });
    }
  });
  return sortUpdates(out, machines.map((machine) => machine.machine));
}

/** Updates by tool, in the page's order, then by machine in the order given. */
export const sortUpdates = (updates: ToolUpdate[], machines: string[]) =>
  [...updates].sort((a, b) => toolRank(a.tool) - toolRank(b.tool) || machines.indexOf(a.machine) - machines.indexOf(b.machine));

/** The newest release a machine's installer offers for a tool, when it's newer than the copy there. */
export function newerOn(machine: MachineToolchain, tool: string): string | null {
  const found = machine.tools.find((entry) => entry.tool === tool);
  const latest = machine.updates?.latest.find((entry) => entry.tool === tool)?.version ?? null;
  return found?.version && latest && compareVersions(latest, found.version) > 0 ? latest : null;
}

/** How an update came out once the machine was looked at again: there now, or still older than it was meant to be. */
/** `unchecked`: the installer said it worked, but the machine couldn't be looked at again to see. */
export type UpdateState =
  | { kind: 'running' }
  | { kind: 'updated'; version: string }
  | { kind: 'unchecked' }
  | { kind: 'stillBehind'; version: string | null }
  | { kind: 'failed'; message: string };

/** An update that said it worked, checked against the tool's version on the machine's next scan. */
export function updateVerdict(update: ToolUpdate, after: MachineToolchain | null | undefined): UpdateState {
  const found = after?.tools.find((tool) => tool.tool === update.tool) ?? null;
  if (found?.version && compareVersions(found.version, update.latest) >= 0) return { kind: 'updated', version: found.version };
  return { kind: 'stillBehind', version: found?.version ?? null };
}

/** Each machine's changes, in the order the updates are listed. */
export function changesByMachine(updates: ToolUpdate[]): Map<string, ToolUpdate[]> {
  const out = new Map<string, ToolUpdate[]>();
  for (const update of updates) out.set(update.machine, [...(out.get(update.machine) ?? []), update]);
  return out;
}

/**
 * The machine to try a batch on first, when a tool in it is going to more than one machine: the one with the most of
 * those, the first listed when it's a tie. Null when no tool is going to two.
 */
export function trialMachine(updates: ToolUpdate[]): string | null {
  const machinesFor = new Map<string, Set<string>>();
  for (const update of updates) machinesFor.set(update.tool, (machinesFor.get(update.tool) ?? new Set()).add(update.machine));
  const shared = new Set([...machinesFor.entries()].filter(([, machines]) => machines.size > 1).map(([tool]) => tool));
  if (!shared.size) return null;
  const counts = new Map<string, number>();
  for (const update of updates) if (shared.has(update.tool)) counts.set(update.machine, (counts.get(update.machine) ?? 0) + 1);
  let best: string | null = null;
  for (const update of updates) {
    const count = counts.get(update.machine) ?? 0;
    if (count && (best === null || count > (counts.get(best) ?? 0))) best = update.machine;
  }
  return best;
}

/** What a run of changes said, by tool, with a run that didn't answer for a tool counted as a failure. */
export function resultsByTool(changes: ToolChange[], results: ToolResult[]): Map<string, ToolResult> {
  const out = new Map<string, ToolResult>();
  for (const change of changes) {
    const result = results.find((entry) => entry.tool === change.tool);
    out.set(change.tool, result ?? { tool: change.tool, action: change.action, ok: false, message: null });
  }
  return out;
}

export type ToolUpdateGroup = { tool: string; machines: string[]; haves: string[]; latests: string[] };

/** A batch by tool, in the order the updates are listed, so a confirmation names each tool once. */
export function updatesByTool(updates: ToolUpdate[]): ToolUpdateGroup[] {
  const out = new Map<string, ToolUpdateGroup>();
  for (const update of updates) {
    const group = out.get(update.tool) ?? { tool: update.tool, machines: [], haves: [], latests: [] };
    group.machines.push(update.machine);
    if (!group.haves.includes(update.have)) group.haves.push(update.have);
    if (!group.latests.includes(update.latest)) group.latests.push(update.latest);
    out.set(update.tool, group);
  }
  return [...out.values()];
}

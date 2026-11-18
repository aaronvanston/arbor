import { invokeCommand } from '../native/commands';
import type { ComputePoint, ComputeProviderId, ComputeProviderSnapshot, ComputeSandbox, MachineHealth } from '../native/types';
import {
  allSandboxes,
  groupSandboxes,
  isActiveSandbox,
  planHours,
  planHoursGoneLastSaid,
  planHoursTone,
  sandboxFlags,
  sandboxOrigin,
  type ComputeGroup,
  type ComputeGrouping,
  type PlanHours,
  type ProvidedSandbox,
} from './compute';
import { READING_LIMITS } from './machineHealth';

/**
 * The figures only Fleet › Compute's page and a sandbox's own page show, worked out from the snapshot (compute.ts holds
 * the ones every Compute screen shares).
 */

/** What the page's "Agents using them" says: live sessions behind the running sandboxes, and the ones left behind. */
export type AgentsFigure = {
  /** Distinct sessions Arbor knows, still live, that started a running sandbox. */
  liveSessions: number;
  /** Running sandboxes whose session Arbor saw end. */
  leftBehind: number;
  /** The user's running sandboxes with nothing linked, or linked to a machine Arbor doesn't know. */
  notLinked: number;
  /** The user's running sandboxes: teammates' are never linked, so they don't count either way. */
  own: number;
};

export function agentsFigure(sandboxes: readonly ComputeSandbox[]): AgentsFigure {
  const live = new Set<string>();
  const figure: AgentsFigure = { liveSessions: 0, leftBehind: 0, notLinked: 0, own: 0 };
  for (const sandbox of sandboxes) {
    if (!isActiveSandbox(sandbox) || !sandbox.mine) continue;
    figure.own += 1;
    if (sandbox.linkProblem !== null) figure.notLinked += 1;
    const session = sandbox.session;
    if (!session?.known) continue;
    if (session.live) live.add(session.id);
    else figure.leftBehind += 1;
  }
  figure.liveSessions = live.size;
  return figure;
}

/**
 * The commands a sandbox's provider started in it that are still running, and when the newest began: what Arbor can
 * say about whether anything is still using it. Null when there's no reading or the provider doesn't say. Counts and
 * a time only; what the commands are is never read.
 */
export const sandboxCommands = (sandbox: Pick<ComputeSandbox, 'load'>): { count: number; newestStartedAtMs: number | null } | null =>
  (sandbox.load.kind === 'read' && sandbox.load.commands !== null ? { count: sandbox.load.commands, newestStartedAtMs: sandbox.load.commandStartedMs } : null);

/** As long as Arbor waits before an ended session can make a sandbox look forgotten, so the note and the flag keep step. */
const SESSION_ENDED_NOTE_MS = 30 * 60_000;

/**
 * When the session behind a running sandbox of one's own ended, once that's a while ago; else null. Its page says so
 * even when the sandbox doesn't look forgotten, because one that's still working is exactly the one to ask about.
 */
export function sessionEndedNoteAtMs(sandbox: Pick<ComputeSandbox, 'mine' | 'state' | 'session'>, nowMs: number): number | null {
  const session = sandbox.session;
  if (!sandbox.mine || sandbox.state !== 'running' || !session?.known || session.live || session.endedAtMs === null) return null;
  return nowMs - session.endedAtMs >= SESSION_ENDED_NOTE_MS ? session.endedAtMs : null;
}

/**
 * True when a provider's key is what keeps CPU and memory blank: a running sandbox it won't give load for, and none it
 * will. Said once above the figures, with the way to the key, instead of only row by row.
 */
export function loadNeedsKey(provider: Pick<ComputeProviderSnapshot, 'sandboxes'>): boolean {
  const running = provider.sandboxes.filter((sandbox) => sandbox.state === 'running');
  return running.some((sandbox) => sandbox.load.kind === 'keyCantRead') && !running.some((sandbox) => sandbox.load.kind === 'read');
}

/** How many running sandboxes carry each flag the table's head counts. */
export type FlagCounts = { cpuAtLimit: number; forgotten: number; degraded: number };

export function flagCounts(sandboxes: readonly ComputeSandbox[]): FlagCounts {
  const counts: FlagCounts = { cpuAtLimit: 0, forgotten: 0, degraded: 0 };
  for (const sandbox of sandboxes) {
    for (const flag of sandboxFlags(sandbox)) {
      if (flag === 'cpuAtLimit' || flag === 'forgotten' || flag === 'degraded') counts[flag] += 1;
    }
  }
  return counts;
}

const TONE_RANK = { error: 0, warning: 1, primary: 2, muted: 3 } as const;

/**
 * The plan hours the stats row shows when several providers report them: the one closest to trouble (its tone first,
 * then fewest hours left), so a provider about to run out is never hidden behind one that's fine.
 */
export function mostPressingPlanHours(providers: readonly ComputeProviderSnapshot[], nowMs: number): { provider: ComputeProviderSnapshot; hours: PlanHours } | null {
  let best: { provider: ComputeProviderSnapshot; hours: PlanHours; rank: number } | null = null;
  for (const provider of providers) {
    const hours = planHours(provider);
    if (!hours) continue;
    const rank = TONE_RANK[planHoursTone(hours, nowMs, planHoursGoneLastSaid(provider))];
    if (!best || rank < best.rank || (rank === best.rank && hours.left < best.hours.left)) best = { provider, hours, rank };
  }
  return best ? { provider: best.provider, hours: best.hours } : null;
}

/** The stopped sandboxes the provider still lists this month, most recently started first. */
export const stoppedSandboxes = (providers: readonly ComputeProviderSnapshot[]): ProvidedSandbox[] =>
  allSandboxes(providers).filter((sandbox) => !isActiveSandbox(sandbox)).sort((left, right) => right.createdAtMs - left.createdAtMs);

/** What the table can be narrowed to: one of the flags its head counts, or the sandboxes one machine started. */
export type TableFilter = { kind: 'flag'; flag: keyof FlagCounts } | { kind: 'machine'; machine: string };

const filterMatches = (filter: TableFilter, sandbox: ComputeSandbox) => {
  if (filter.kind === 'flag') return sandboxFlags(sandbox).includes(filter.flag);
  const origin = sandboxOrigin(sandbox);
  return origin.kind === 'machine' && origin.machine === filter.machine;
};

/**
 * The providers with only the sandboxes a filter keeps, so the groups, their totals and the stopped count all follow
 * it. A filter no running sandbox matches is dropped (null back with the providers as they were): the flag it named
 * cleared, or the machine's sandboxes stopped, and a table left empty under it would read as nothing running at all.
 */
export function narrowProviders(providers: readonly ComputeProviderSnapshot[], filter: TableFilter | null): { providers: readonly ComputeProviderSnapshot[]; filter: TableFilter | null } {
  if (!filter) return { providers, filter: null };
  const narrowed = providers.map((provider) => ({ ...provider, sandboxes: provider.sandboxes.filter((sandbox) => filterMatches(filter, sandbox)) }));
  return narrowed.some((provider) => provider.sandboxes.some(isActiveSandbox)) ? { providers: narrowed, filter } : { providers, filter: null };
}

/** The table's groups: the running ones as `by` groups them, then, when shown, the stopped ones as one more. */
export type TableGroup = ComputeGroup | { kind: 'stopped'; key: string; sandboxes: ProvidedSandbox[]; vcpus: number; memoryGb: number };

export function tableGroups(providers: readonly ComputeProviderSnapshot[], by: ComputeGrouping, showStopped: boolean): TableGroup[] {
  const groups: TableGroup[] = groupSandboxes(providers, by);
  const stopped = showStopped ? stoppedSandboxes(providers) : [];
  if (stopped.length) groups.push({ kind: 'stopped', key: 'stopped', sandboxes: stopped, vcpus: 0, memoryGb: 0 });
  return groups;
}

/** Past this many rows the table pages, so a hundred sandboxes cost no more to draw than fifty. */
export const COMPUTE_PAGE_SIZE = 50;

export const groupRowCount = (groups: readonly TableGroup[]) => groups.reduce((sum, group) => sum + group.sandboxes.length, 0);

/**
 * The rows on page `page` (from 1) of `size`, still in their groups. A group cut by a page break keeps its heading and
 * its whole totals on both pages, so a heading always says what the group adds up to.
 */
export function pageOfGroups(groups: readonly TableGroup[], page: number, size: number): TableGroup[] {
  const start = (Math.max(1, page) - 1) * size;
  const end = start + size;
  const shown: TableGroup[] = [];
  let index = 0;
  for (const group of groups) {
    const first = index;
    index += group.sandboxes.length;
    if (index <= start || first >= end) continue;
    shown.push({ ...group, sandboxes: group.sandboxes.slice(Math.max(0, start - first), end - first) });
  }
  return shown;
}

/** The machines' CPU in use now, from the health Arbor already samples: cores busy and cores in all. */
export type MachinesCpu = { busy: number; cores: number };

export function machinesCpu(health: readonly MachineHealth[] | null): MachinesCpu | null {
  if (!health) return null;
  let busy = 0;
  let cores = 0;
  for (const machine of health) {
    const cpu = machine.latest?.cpu;
    if (!machine.facts || cpu === null || cpu === undefined) continue;
    cores += machine.facts.cores;
    busy += (cpu / 100) * machine.facts.cores;
  }
  return cores ? { busy, cores } : null;
}

// ---------------------------------------------------------------------------
// A sandbox's load over time
// ---------------------------------------------------------------------------

/** The most readings Rust keeps for a sandbox: one a minute for about two hours. */
export const HISTORY_POINTS = 120;

/**
 * The chart's readings with the latest the snapshot brings: each new one added in time order, the oldest dropped past
 * the ring's size. The same array back when nothing is new, so the chart doesn't draw again.
 */
export function mergeHistory(history: readonly ComputePoint[], recent: readonly ComputePoint[], max = HISTORY_POINTS): ComputePoint[] {
  const known = new Set(history.map((point) => point.atMs));
  const added = recent.filter((point) => !known.has(point.atMs));
  if (!added.length) return history as ComputePoint[];
  return [...history, ...added].sort((left, right) => left.atMs - right.atMs).slice(-max);
}

/**
 * Two readings further apart than this have a gap between them, as when Arbor wasn't running: they come a minute
 * apart, and one round late is still no gap.
 */
export const LOAD_GAP_MS = 150_000;

type Series = { t: number; v: number | null }[];

/**
 * CPU and memory as percents for the chart, with a null between readings a gap apart so the lines break there rather
 * than drawing across time nobody read, and those gaps for the chart to shade and name.
 */
export function loadSeries(points: readonly ComputePoint[]): { cpu: Series; memory: Series; gaps: { from: number; to: number }[] } {
  const cpu: Series = [];
  const memory: Series = [];
  const gaps: { from: number; to: number }[] = [];
  let previous: ComputePoint | null = null;
  for (const point of points) {
    if (previous && point.atMs - previous.atMs > LOAD_GAP_MS) {
      const middle = previous.atMs + (point.atMs - previous.atMs) / 2;
      cpu.push({ t: middle, v: null });
      memory.push({ t: middle, v: null });
      gaps.push({ from: previous.atMs, to: point.atMs });
    }
    cpu.push({ t: point.atMs, v: point.cpu * 100 });
    memory.push({ t: point.atMs, v: point.memory * 100 });
    previous = point;
  }
  return { cpu, memory, gaps };
}

/** The CPU share at which a sandbox is at its limit: the machines' critical line, as `cpuAtLimit` has it. */
const AT_LIMIT = READING_LIMITS.cpu[1] / 100;

/**
 * How long the latest readings have run at the CPU limit without a break, counting each one-minute reading as a
 * minute; null when the latest isn't at it. A gap ends the run, since nobody knows what CPU did then.
 */
export function cpuAtLimitForMs(points: readonly ComputePoint[]): number | null {
  let count = 0;
  let next: ComputePoint | null = null;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (!point || point.cpu < AT_LIMIT) break;
    if (next && next.atMs - point.atMs > LOAD_GAP_MS) break;
    count += 1;
    next = point;
  }
  return count ? count * 60_000 : null;
}

/**
 * Puts back the link a sandbox had, for Undo after unlinking it on its page: the same machine and session, as the
 * command line first gave them. The window never makes a link of its own.
 */
export const relinkComputeSandbox = (provider: ComputeProviderId, sandboxId: string, machine: string, session: string | null) =>
  invokeCommand('link_compute_sandbox', { provider, sandboxId, machine, session });

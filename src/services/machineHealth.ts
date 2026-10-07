import { invokeCommand } from '../native/commands';
import type { AgentKind, HealthPoint, MachineHealth, MachineHealthSnapshot, MachineHistory, MachineHost } from '../native/types';
import { isWindowInBackground } from './hiddenPace';
import { tracked } from './productAnalytics';

export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex'];

export const HEALTH_WINDOWS = [
  { id: '5m', ms: 5 * 60_000 },
  { id: '15m', ms: 15 * 60_000 },
  { id: '1h', ms: 60 * 60_000 },
] as const;
export type HealthWindowId = (typeof HEALTH_WINDOWS)[number]['id'];

/** The hour Arbor keeps of every machine; a machine's own page goes further back with Grove's stored history. */
export const HOUR_MS = 60 * 60_000;
export const MACHINE_WINDOWS = [
  ...HEALTH_WINDOWS,
  { id: '6h', ms: 6 * HOUR_MS },
  { id: '24h', ms: 24 * HOUR_MS },
  { id: '7d', ms: 7 * 24 * HOUR_MS },
  { id: '30d', ms: 30 * 24 * HOUR_MS },
] as const;
export type MachineWindowId = (typeof MACHINE_WINDOWS)[number]['id'];
export const machineWindowMs = (id: MachineWindowId) => MACHINE_WINDOWS.find((option) => option.id === id)?.ms ?? HOUR_MS;

/** One of a history's metrics as a chart's series, each bucket's value at the bucket's middle; null leaves a gap. */
export function historySeries(history: MachineHistory, values: readonly (number | null)[]): { t: number; v: number | null }[] {
  return values.map((value, index) => ({ t: history.since + (index + 0.5) * history.bucketMs, v: value }));
}

/** How often a long window is read again while it shows: its buckets are minutes to hours wide. */
export const historyRefreshMs = (history: MachineHistory | null) => Math.max(60_000, history?.bucketMs ?? 0);

/**
 * A passive read doesn't count as watching, so it leaves the sampler on its background interval. Nobody watches a
 * hidden window, or one behind another app (the owner's call, 2026-10-08: once a minute then, every 5 s again as Arbor
 * comes forward), so a page left open in one reads passively too, and doesn't hold the fleet on the fast interval.
 * `machine` keeps the history to that machine's; every machine still comes with its latest reading.
 */
export function fetchMachineHealth(since: number | null, windowMs: number, passive = false, machine?: string) {
  const args = { since, windowMs, passive: passive || isWindowInBackground() };
  return invokeCommand('get_machine_health', machine === undefined ? args : { ...args, machine });
}

/**
 * How long a background read of the fleet answers for others. The sampler's rounds are at least 5 seconds apart, so a
 * read this fresh is the latest round's; and the timestamp it carries, which alerts time outages by, is still close.
 */
const SHARED_READ_MS = 2_000;
let sharedRead: { read: Promise<MachineHealthSnapshot>; settledAt: number | null } | null = null;

/**
 * Every machine as the sampler last saw it, its latest reading without history, read passively. What watches the
 * fleet in the background (the sidebar and Home's machines, machine icons, machine alerts, scoped settings) reads it
 * through here, so one sampling round, which wakes all of them at once, is read once: a read in flight is shared, and
 * so is one that answered in the last two seconds.
 */
export function readFleetHealth(): Promise<MachineHealthSnapshot> {
  const now = Date.now();
  if (sharedRead && (sharedRead.settledAt === null || now - sharedRead.settledAt < SHARED_READ_MS)) return sharedRead.read;
  const entry: NonNullable<typeof sharedRead> = { read: fetchMachineHealth(now, 1_000, true), settledAt: null };
  sharedRead = entry;
  entry.read.then(
    () => { entry.settledAt = Date.now(); },
    // A failed read isn't shared beyond its callers: the next one tries again.
    () => { if (sharedRead === entry) sharedRead = null; },
  );
  return entry.read;
}

export const fetchMachineHosts = () => invokeCommand('get_machine_hosts');
const hostsSaved = new Set<() => void>();
/** Calls `listener` each time the machine list is saved from this window; returns what stops it. */
export function onMachineHostsSaved(listener: () => void): () => void {
  hostsSaved.add(listener);
  return () => { hostsSaved.delete(listener); };
}

/** Adds or updates `hosts`, and takes the machines named in `removed` off the list; their history stays, and saving one again brings it back. */
export async function saveMachineHosts(hosts: MachineHost[], removed: string[] = []) {
  const saved = await tracked('machines-saved', invokeCommand('save_machine_hosts', { hosts, removed }), { count: hosts.length });
  // The list changed, so a read from before it no longer answers for anyone.
  sharedRead = null;
  for (const listener of hostsSaved) listener();
  return saved;
}

/** An SSH port typed into the hosts table: whole digits from 1 to 65535, otherwise null. */
export function parsePort(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}
/**
 * Updates the agent on the machine the way it was installed, then checks its version again. `command` is the update
 * command its user was shown; nothing runs if the machine now updates another way.
 */
export const updateMachineAgent = (machine: string, agent: AgentKind, command: string) =>
  invokeCommand('update_machine_agent', { machine, agent, command });

/**
 * Merge an incremental snapshot into the previous one. Points arrive
 * append-only, so the client keeps its own bounded copy of the series and
 * only pulls what it has not seen; the ring never grows past the window.
 */
export function mergeSnapshots(previous: MachineHealthSnapshot | null, next: MachineHealthSnapshot, windowMs: number): MachineHealthSnapshot {
  if (!previous) return next;
  const floor = next.now - windowMs;
  const prior = new Map(previous.machines.map((item) => [item.machine, item]));
  return {
    ...next,
    machines: next.machines.map((item) => {
      const old = prior.get(item.machine);
      if (!old || old.host.endpoint !== item.host.endpoint || old.host.port !== item.host.port) return item;
      const lastSeen = old.points[old.points.length - 1]?.t ?? -Infinity;
      const merged = old.points.filter((point) => point.t >= floor);
      for (const point of item.points) if (point.t > lastSeen) merged.push(point);
      return { ...item, points: merged };
    }),
  };
}

/** Where a reading turns warning and critical, matching the backend's score ramps. */
export const READING_LIMITS = { cpu: [75, 98], mem: [78, 96], disk: [82, 96] } as const satisfies Record<string, readonly [number, number]>;

/** A reading's pressure tone: primary while fine, warning and error past its limits, muted with no reading. */
export const readingTone = (reading: keyof typeof READING_LIMITS, value: number | null): 'primary' | 'warning' | 'error' | 'muted' => {
  const [warn, critical] = READING_LIMITS[reading];
  return value === null ? 'muted' : value >= critical ? 'error' : value >= warn ? 'warning' : 'primary';
};

export const KIB = 1024;

export function formatBytes(bytes: number, fractionDigits = 1): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(value >= 100 ? 0 : fractionDigits)} ${units[unit]}`;
}

export function formatRate(bytesPerSecond: number | null): { value: string; unit: string } {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond)) return { value: '—', unit: '' };
  const kb = bytesPerSecond / 1024;
  if (kb < 1000) return { value: kb < 10 ? kb.toFixed(1) : Math.round(kb).toString(), unit: 'KB/s' };
  const mb = kb / 1024;
  if (mb < 1000) return { value: mb < 10 ? mb.toFixed(1) : Math.round(mb).toString(), unit: 'MB/s' };
  return { value: (mb / 1024).toFixed(1), unit: 'GB/s' };
}

/** Latency keeps a decimal only while it's under 10 ms. */
export const latencyDigits = (ms: number) => (ms < 10 ? 1 : 0);

export const formatLatency = (ms: number) => `${ms.toFixed(latencyDigits(ms))} ms`;

/** Lowest, mean and highest round trip across the points that got a reply. */
/**
 * Whether a machine's round trip is shown: remote ones only, which Grove either times over a probe's stream (through
 * any jump host) or pings when it has no probe (not behind a jump host).
 */
export const showsRoundTrip = (item: MachineHealth) => !item.local && (item.pingTarget !== null || item.points.some((point) => point.latencyMs !== null));

export function latencyStats(points: HealthPoint[]): { min: number; avg: number; max: number } | null {
  const values = points.flatMap((point) => (point.latencyMs === null ? [] : [point.latencyMs]));
  if (!values.length) return null;
  return { min: Math.min(...values), avg: values.reduce((sum, value) => sum + value, 0) / values.length, max: Math.max(...values) };
}


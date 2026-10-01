import type { MessageKey, MessageVariables } from '../i18n/resources';
import { formatTime } from '../lib/format';
import type { AgentKind, HealthStatus, MachineHealth, TrayRow } from '../native/types';
import { agentsBehind, runningAgents, type NewestAgents } from './agentVersions';
import { healthReasonText, type HomeMachine } from './homeOverview';
import { unreachableReason } from './machineAlerts';
import { AGENT_KINDS, formatBytes, formatLatency, KIB } from './machineHealth';
import { machinePlace } from './machineIdentity';
import { HEALTH_DOT, TRAY_SEPARATOR } from './trayMenu';
import type { QuotaProvider } from './quotaService';
import { savedStore, storedRecord } from './savedStore';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/**
 * What the sidebar's foot and the menu bar menu leave out: providers whose pooled limit isn't wanted there, and
 * machines. Kept as what's hidden rather than what's shown, so a provider signed into or a machine added later shows
 * without being picked.
 */
export type GlancePicks = {
  hiddenProviders: readonly string[];
  hiddenMachines: readonly string[];
};

const NONE: GlancePicks = { hiddenProviders: [], hiddenMachines: [] };

const names = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))] : [];

function parseGlancePicks(raw: string | null): GlancePicks {
  const stored = storedRecord(raw);
  return { hiddenProviders: names(stored.hiddenProviders), hiddenMachines: names(stored.hiddenMachines) };
}

const store = savedStore<GlancePicks>({ key: 'arbor.glance.v1', parse: parseGlancePicks, fallback: NONE });
export const useGlancePicks = store.useValue;

const toggled = (list: readonly string[], item: string, shown: boolean) =>
  shown ? list.filter((other) => other !== item) : list.includes(item) ? list : [...list, item];

export function setGlanceProviderShown(provider: QuotaProvider, shown: boolean) {
  const picks = store.get();
  store.set({ ...picks, hiddenProviders: toggled(picks.hiddenProviders, provider, shown) });
}

export function setGlanceMachineShown(machine: string, shown: boolean) {
  const picks = store.get();
  store.set({ ...picks, hiddenMachines: toggled(picks.hiddenMachines, machine, shown) });
}

/** The providers' limits the glance shows, in the order given. */
export const glanceProviders = <T extends { provider: QuotaProvider }>(rows: readonly T[], picks: GlancePicks): T[] =>
  rows.filter((row) => !picks.hiddenProviders.includes(row.provider));

/**
 * The machines that can be picked: those with a host Arbor checks the health of. One only known from its sessions, or
 * whose host has no address yet, has no health to show.
 */
export const glanceCandidates = (machines: readonly HomeMachine[]): HomeMachine[] =>
  machines.filter((item) => item.health !== null && item.health.status !== 'unconfigured');

/** The machines the glance shows: every candidate not hidden, in Home's order. */
export const glanceMachines = (machines: readonly HomeMachine[], picks: GlancePicks): HomeMachine[] =>
  glanceCandidates(machines).filter((item) => !picks.hiddenMachines.includes(item.machine));

export const HEALTH_LABEL: Record<HealthStatus, MessageKey> = {
  healthy: 'machines.health.status.healthy',
  degraded: 'machines.health.status.degraded',
  critical: 'machines.health.status.critical',
  unreachable: 'machines.health.status.unreachable',
  pending: 'machines.health.status.pending',
  unconfigured: 'machines.health.status.unconfigured',
};

/** What a machine's agents are doing, in a few words ("3 working · 1 waiting on you"); empty while none are. */
export const agentsText = (item: Pick<HomeMachine, 'working' | 'waiting'>, t: Translate): string =>
  [
    item.working ? t('glance.working', { count: item.working }) : '',
    item.waiting ? t('glance.waiting', { count: item.waiting }) : '',
  ].filter(Boolean).join(' · ');

/** What's pulling a machine down, in Machines' words; null while it's healthy. */
function machineCondition(health: MachineHealth | null, t: Translate): string | null {
  const status = health?.status ?? 'pending';
  if (status === 'healthy') return null;
  if (status === 'pending' || status === 'unconfigured') return t('tray.machines.pending');
  if (status === 'unreachable') return t('tray.machines.unreachable');
  if (health?.reason && health.latest) {
    const { key, variables } = healthReasonText(health.reason, health.latest);
    return t(key, variables);
  }
  return t(HEALTH_LABEL[status]);
}

/** Its working sessions by agent and those waiting on you ("6 Claude · 4 Codex · 1 waiting on you"), or idle. */
function machineAgentsText(item: HomeMachine, t: Translate): string {
  const { claude, codex, other } = item.workingAgents;
  return [
    claude ? t('tray.agents.claude', { count: claude }) : '',
    codex ? t('tray.agents.codex', { count: codex }) : '',
    other ? t('tray.agents.other', { count: other }) : '',
    item.waiting ? t('glance.waiting', { count: item.waiting }) : '',
  ].filter(Boolean).join(' · ') || t('tray.machines.idle');
}

/**
 * The machines' section of the menu bar menu: a row per machine with its health dot, what's wrong with it and what its
 * agents are doing, opening a sub-menu with its readings, its agents' versions and a way to its page.
 */
export function machineTrayRows(
  machines: readonly HomeMachine[],
  name: (machine: string) => string,
  newest: NewestAgents,
  t: Translate,
): TrayRow[] {
  if (!machines.length) return [];
  const rows = machines.map((item): TrayRow => {
    const { health } = item;
    const status = health?.status ?? 'pending';
    const condition = machineCondition(health, t);
    return {
      text: [name(item.machine), condition, machineAgentsText(item, t)].filter(Boolean).join(' · '),
      dot: HEALTH_DOT[status],
      children: machineDetailRows(item, newest, t),
    };
  });
  return [{ text: t('tray.machines.header') }, ...rows];
}

/** A machine's sub-menu: its health and what it is, its readings, its agents, when it was checked, and its page. */
function machineDetailRows(item: HomeMachine, newest: NewestAgents, t: Translate): TrayRow[] {
  const { health } = item;
  const status = health?.status ?? 'pending';
  const score = health?.score === null || health?.score === undefined ? null : Math.round(health.score);
  const statusText = t(HEALTH_LABEL[status]);
  const detail = status === 'unreachable'
    ? unreachableReason(health?.error ?? null, t)
    : status === 'healthy' ? null : machineCondition(health, t);
  const place = machinePlace(health?.facts ?? null, t);
  const about: TrayRow[] = [
    { text: score === null ? statusText : t('glance.machine.score', { status: statusText, score }) },
    ...(detail && detail !== statusText ? [{ text: detail }] : []),
    ...(place ? [{ text: place }] : []),
  ];
  const readings = health ? machineReadingRows(health, t) : [];
  const agents = health ? machineAgentRows(health, newest, t) : [];
  const checked = health ? machineCheckedRow(health, t) : null;
  return [
    ...about,
    ...(readings.length ? [TRAY_SEPARATOR, ...readings] : []),
    ...(agents.length || checked ? [TRAY_SEPARATOR, ...agents, ...(checked ? [checked] : [])] : []),
    TRAY_SEPARATOR,
    { text: t('tray.machine.open'), action: { kind: 'openMachine', machine: item.machine } },
  ];
}

/** Its latest readings: CPU and load, memory, disk and the round trip. Nothing while it can't be reached. */
function machineReadingRows(health: MachineHealth, t: Translate): TrayRow[] {
  const point = health.status === 'unreachable' ? null : health.latest;
  if (!point) return [];
  const load = point.load1.toFixed(1);
  const memTotalKb = health.facts?.memTotalKb ?? 0;
  return [
    { text: point.cpu === null ? t('tray.machine.load', { load }) : t('tray.machine.cpu', { value: Math.round(point.cpu), load }) },
    {
      text: memTotalKb
        ? t('tray.machine.memory', { value: Math.round(point.mem), used: formatBytes(point.memUsedKb * KIB), total: formatBytes(memTotalKb * KIB, 0) })
        : t('tray.machine.memoryShare', { value: Math.round(point.mem) }),
    },
    { text: t('tray.machine.disk', { value: Math.round(point.disk), free: formatBytes(point.diskFreeKb * KIB, 0) }) },
    ...(point.latencyMs === null ? [] : [{ text: t('tray.machine.latency', { value: formatLatency(point.latencyMs) }) }]),
  ];
}

/** Each agent installed: its version, how many are running, and the newer one to be at when it's behind, in amber. */
function machineAgentRows(health: MachineHealth, newest: NewestAgents, t: Translate): TrayRow[] {
  const running = runningAgents(health);
  const behind = new Map(agentsBehind(health, newest).map((item) => [item.agent, item.newest]));
  return AGENT_KINDS.flatMap((agent: AgentKind): TrayRow[] => {
    const install = health.agents[agent];
    if (!install) return [];
    const newer = behind.get(agent);
    const count = running?.[agent];
    return [{
      text: [
        install.version ? `${t(`machines.agents.name.${agent}`)} ${install.version}` : t(`machines.agents.name.${agent}`),
        count ? t('tray.machine.running', { count }) : '',
        newer ? t('tray.machine.newer', { version: newer }) : '',
      ].filter(Boolean).join(' · '),
      dot: newer ? 'amber' : 'blank',
    }];
  });
}

/** When it was last checked, or for one that can't be reached, when it last answered. */
function machineCheckedRow(health: MachineHealth, t: Translate): TrayRow | null {
  if (health.status === 'unreachable') return health.lastOkAt ? { text: t('tray.machine.lastSeen', { time: formatTime(health.lastOkAt) }) } : null;
  return health.lastAttemptAt ? { text: t('tray.machine.checked', { time: formatTime(health.lastAttemptAt) }) } : null;
}

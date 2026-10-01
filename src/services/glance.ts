import type { MessageKey, MessageVariables } from '../i18n/resources';
import type { HealthStatus } from '../native/types';
import type { HomeMachine } from './homeOverview';
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

/** The menu bar's words for a machine's health, lower case after its name as the limits' lines are. */
const TRAY_HEALTH: Record<HealthStatus, MessageKey> = {
  healthy: 'tray.machines.healthy',
  degraded: 'tray.machines.degraded',
  critical: 'tray.machines.critical',
  unreachable: 'tray.machines.unreachable',
  pending: 'tray.machines.pending',
  unconfigured: 'tray.machines.pending',
};

/** What a machine's agents are doing, in a few words ("3 working · 1 waiting on you"); empty while none are. */
export const agentsText = (item: Pick<HomeMachine, 'working' | 'waiting'>, t: Translate): string =>
  [
    item.working ? t('glance.working', { count: item.working }) : '',
    item.waiting ? t('glance.waiting', { count: item.waiting }) : '',
  ].filter(Boolean).join(' · ');

/** A line per machine for the menu bar menu: its name, its health and what its agents are doing. */
export function machineTrayLines(machines: readonly HomeMachine[], name: (machine: string) => string, t: Translate): string[] {
  return machines.map((item) => {
    const status = item.health?.status ?? 'pending';
    return [name(item.machine), t(TRAY_HEALTH[status]), agentsText(item, t) || t('tray.machines.idle')].join(' · ');
  });
}

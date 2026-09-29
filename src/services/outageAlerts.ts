import type { MessageKey, MessageVariables } from '../i18n/resources';
import type { SystemNotification } from './notify';
import { providerLabel } from './providerLimits';
import { isOutage, type ProviderStatus, type StatusIncident, type StatusProvider } from './providerStatus';
import { incidentStatusKey } from './providerStatusText';

const WEEK = 7 * 24 * 3_600_000;

export type OutageAlert = { provider: StatusProvider; incident: StatusIncident };

/**
 * Picks the incidents to notify about: each open one once. Maintenance and incidents rated as having no
 * impact are left out. `notified` maps `provider:incident` to when it was first mentioned; an incident
 * still open is kept however long it runs, and one that's closed is forgotten a week later.
 */
export function nextOutageNotifications(
  notified: Record<string, number>,
  statuses: Partial<Record<StatusProvider, ProviderStatus | null>>,
  nowMs: number,
) {
  const next: Record<string, number> = {};
  const fresh: OutageAlert[] = [];
  (Object.entries(statuses) as [StatusProvider, ProviderStatus | null | undefined][]).forEach(([provider, status]) => {
    status?.incidents.forEach((incident) => {
      if (incident.indicator === 'maintenance' || incident.indicator === 'none') return;
      const key = `${provider}:${incident.id}`;
      if (notified[key] === undefined) fresh.push({ provider, incident });
      next[key] = notified[key] ?? nowMs;
    });
  });
  Object.entries(notified).forEach(([key, atMs]) => {
    if (next[key] === undefined && atMs > nowMs - WEEK) next[key] = atMs;
  });
  const changed = fresh.length > 0 || Object.keys(next).length !== Object.keys(notified).length;
  return { notified: next, fresh, changed };
}

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/** How an incident is announced. Partial and major outages are urgent. */
export function outageNotification({ provider, incident }: OutageAlert, t: Translate): SystemNotification {
  const state = incidentStatusKey[incident.status];
  return {
    title: t('notifications.outage.title', { provider: providerLabel[provider] }),
    body: state ? t('notifications.outage.body', { incident: incident.name, state: t(state) }) : incident.name,
    kind: 'outage',
    urgent: isOutage(incident.indicator),
    subject: { url: incident.url },
  };
}

import type { MessageKey, MessageVariables } from '../i18n/resources';
import { affectedComponents, statusIncidents, type ProviderStatus } from './providerStatus';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/** How an incident's progress reads, for the states worth naming. */
export const incidentStatusKey: Partial<Record<string, MessageKey>> = {
  investigating: 'status.incident.investigating',
  identified: 'status.incident.identified',
  monitoring: 'status.incident.monitoring',
  in_progress: 'status.incident.inProgress',
  maintenance_in_progress: 'status.incident.inProgress',
};

/** One line naming what is wrong: the most pressing incident, else the worst affected component, else the overall state. */
export function statusSummary(status: ProviderStatus, t: Translate): string {
  const incident = statusIncidents(status)[0];
  if (incident) return incident.name;
  const component = affectedComponents(status)[0];
  const state = t(`status.indicator.${component?.indicator ?? status.indicator}`);
  return component ? t('status.component', { component: component.name, state }) : state;
}

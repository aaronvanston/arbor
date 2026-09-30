import { useEffect, useRef } from 'react';
import type { FleetSources } from '../native/types';
import { useAppPreferences } from '../appPreferences';
import { resolveScoped, useMachineOverrides, useProjectOverrides } from '../services/machineSettings';
import { sessionRepository } from '../services/usageSessions';
import { useI18n } from '../i18n';
import { attentionNotifications, nextAttentionAlerts, type AttentionAlertState } from '../services/agentAttention';
import type { AttentionItem } from '../native/types';
import { currentFleetBoard, currentFleetSources, onFleetSources, snoozedWaitIds } from '../services/fleetBoard';
import { notify } from '../services/notify';

const STATE_KEY = 'arbor.attention-alerts.v1';

const readState = (): AttentionAlertState => {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') as AttentionAlertState;
  } catch {
    return {};
  }
};

/**
 * Headless: notifies once when a session has waited on its user long enough that nobody is at the keyboard. The
 * waits come with the live board's sources, which FleetMonitor reads on each report, new request and quarter minute,
 * the window hidden or not, so this checks them each time they arrive rather than reading them again.
 */
export function AgentAttentionMonitor() {
  const { t } = useI18n();
  const preferences = useAppPreferences();
  const overrides = useMachineOverrides();
  const projects = useProjectOverrides();
  const tRef = useRef(t);
  tRef.current = t;
  // Whether a wait is alerted, by its kind and its project's and machine's values (Settings › Notifications scoped to them).
  const wanted = (item: AttentionItem) =>
    resolveScoped(
      preferences,
      overrides,
      projects,
      { project: sessionRepository(item.session), machine: item.machine },
      item.kind === 'waiting' ? 'agentWaitingAlerts' : 'agentPermissionAlerts',
    ).value;
  const alertedRef = useRef(wanted);
  alertedRef.current = wanted;

  useEffect(() => {
    let state = readState();
    let checked: FleetSources | null = null;
    const check = () => {
      const sources = currentFleetSources();
      // A failed read keeps the last sources, and those waits have been checked already.
      if (!sources || sources === checked) return;
      checked = sources;
      // A wait on a row snoozed on the live board isn't alerted either, until it wakes.
      const snoozed = snoozedWaitIds(currentFleetBoard());
      const items = sources.attention.items.filter((item) => !snoozed.has(item.sessionId));
      // Every wait is recorded as it comes due, alerted or not, so one turned back on later isn't announced late.
      const next = nextAttentionAlerts(state, items, Date.now(), { permission: true, waiting: true });
      if (next.changed) {
        state = next.state;
        try {
          localStorage.setItem(STATE_KEY, JSON.stringify(state));
        } catch {
          /* keep in memory */
        }
      }
      void notify(attentionNotifications(next.due.filter((item) => alertedRef.current(item)), tRef.current));
    };
    check();
    const stop = onFleetSources(check);
    return () => {
      stop();
    };
  }, []);

  return null;
}

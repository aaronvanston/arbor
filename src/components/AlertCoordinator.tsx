import { useEffect, useRef } from 'react';
import { alertDestinationView, openAlertDestination } from '../alertNavigation';
import { useI18n } from '../i18n';
import { canOpenView, type AppView } from '../navigation';
import { alertDestination, markAlertRead, showUnreadAlertsInTray } from '../services/alertHistory';
import { alertMentions } from '../services/machineMentions';
import { presentAlertsInApp, type InAppAlert } from '../services/notify';
import type { AlertKind } from '../services/phoneAlerts';
import { MachineText } from './identity/MachineText';
import { toast, type ToastInput, type ToastKind } from './ui/toast';

const TOAST_KIND: Record<AlertKind, ToastKind> = {
  limitWarning: 'warning',
  limitCritical: 'warning',
  limitRecovered: 'success',
  resetReady: 'info',
  expiring: 'warning',
  accountPaused: 'warning',
  accountResumed: 'success',
  heavySession: 'warning',
  agentPermission: 'warning',
  agentWaiting: 'info',
  archiveAway: 'warning',
  archiveFailing: 'warning',
  machineDown: 'warning',
  machineUp: 'success',
  setupChanged: 'info',
  setupRepo: 'warning',
  setupAuto: 'info',
  setupAutoFailed: 'warning',
  setupWaiting: 'info',
  automationFailed: 'warning',
  outage: 'warning',
  proxySettings: 'error',
  digest: 'info',
  test: 'info',
};

type Current = { coreReady: boolean; onNavigate: (view: AppView) => void; t: ReturnType<typeof useI18n>['t'] };

/** The toast for an alert that came in while the window is in front. `current` is read again when Open is pressed. */
export function alertToast(alert: InAppAlert, current: { current: Current }): ToastInput {
  const { coreReady, t } = current.current;
  const destination = alertDestination(alert);
  const view = destination ? alertDestinationView(destination) : null;
  // As on the Alerts page: no button when there's nothing to open, or its page needs the core and that's down.
  const openable = destination !== null && (view === null || canOpenView(view, coreReady));
  // The machines it's about show as their pills, as on the Alerts page.
  const mentions = alertMentions(alert);
  return {
    // A repeat that goes out again replaces its toast rather than stacking another.
    id: `alert-${alert.id}`,
    title: <MachineText parts={mentions.title} size="md" />,
    description: <MachineText parts={mentions.body} />,
    kind: alert.urgent ? 'warning' : TOAST_KIND[alert.kind],
    action: destination && openable
      ? {
          label: t('alerts.toast.open'),
          // Opened here, it's read, as it would be once opened from the Alerts page; the other new ones still count.
          onClick: () => {
            markAlertRead(alert.id);
            openAlertDestination(destination, current.current.onNavigate);
          },
        }
      : undefined,
  };
}

/**
 * Where alerts show besides the Mac's notifications: as toasts while Arbor's window is in front, each opening what
 * it's about, and as the unread count on the tray icon. Mounted once, by the app.
 */
export function AlertCoordinator({ coreReady, onNavigate }: { coreReady: boolean; onNavigate: (view: AppView) => void }) {
  const { t } = useI18n();
  // Alerts come in at any time, and a toast's button is pressed later still, so both read what's current then.
  const current = useRef<Current>({ coreReady, onNavigate, t });
  useEffect(() => {
    current.current = { coreReady, onNavigate, t };
  });
  useEffect(() => presentAlertsInApp((alerts) => alerts.forEach((alert) => toast(alertToast(alert, current)))), []);
  useEffect(() => showUnreadAlertsInTray(), []);
  return null;
}

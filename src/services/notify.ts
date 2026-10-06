import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { isWindowInFront } from '../lib/windowVisibility';
import { recordAlertDelivery, recordAlerts, type AlertSubject } from './alertHistory';
import { phoneWants, sendPhoneAlerts, type AlertKind, type PhoneAlert } from './phoneAlerts';
import { trackFeature } from './productAnalytics';
import { holdingReload } from './reloadHolds';

export type SystemNotification = {
  title: string;
  body: string;
  /** What the phone gets instead of `body`, when that holds detail that shouldn't leave this Mac. */
  phoneBody?: string;
  /** What raised it; webhooks receive this. */
  kind: AlertKind;
  /** A problem that wants attention now. Phones may alert louder for it. */
  urgent?: boolean;
  /** What it's about, so the alert history can open it. */
  subject?: AlertSubject;
};

/** An alert as Arbor's window shows it, with the history entry it's kept in. */
export type InAppAlert = SystemNotification & { id: string };

let showInApp: ((alerts: InAppAlert[]) => void) | null = null;

/** Lets the app show alerts itself while its window is in front. Returns a function that stops it. */
export function presentAlertsInApp(show: (alerts: InAppAlert[]) => void) {
  showInApp = show;
  return () => {
    if (showInApp === show) showInApp = null;
  };
}

const windowInFront = () => typeof document !== 'undefined' && isWindowInFront(document);

/** The alert as it goes to the phone. */
export const phoneAlertFor = ({ title, body, phoneBody, kind, urgent }: SystemNotification): PhoneAlert =>
  ({ title, body: phoneBody ?? body, kind, urgent: urgent ?? false });

/**
 * Shows alerts on this Mac: in Arbor's window while it's in front, since a notification there only covers what's
 * being looked at, and as native notifications otherwise, asking for permission the first time. The phone gets the
 * kinds it's set to take either way. Each is kept in the alert history with how it got out; a repeat of one that
 * went out lately is only counted there.
 */
export async function notify(messages: SystemNotification[]) {
  if (!messages.length) return;
  // Recorded in the history before it goes out, so the window doesn't reload between the two and lose it.
  await holdingReload('alert', () => deliver(messages));
}

async function deliver(messages: SystemNotification[]) {
  const due = recordAlerts(messages).flatMap(({ id, deliver }, index) => {
    const message = messages[index];
    return deliver && message ? [{ ...message, id }] : [];
  });
  if (!due.length) return;
  for (const alert of due) trackFeature('alert-sent', { kind: alert.kind });
  const phone = due.filter((alert) => phoneWants(alert.kind));
  void sendPhoneAlerts(phone.map(phoneAlertFor), (index, error) => {
    const alert = phone[index];
    if (alert) recordAlertDelivery([alert.id], { phone: error });
  });

  const ids = due.map((alert) => alert.id);
  const show = showInApp;
  if (show && windowInFront()) {
    try {
      show(due);
      recordAlertDelivery(ids, { mac: 'app' });
      return;
    } catch (error) {
      console.warn('Failed to show alerts in the window, so they go to the Mac instead', error);
    }
  }
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
    if (!granted) {
      recordAlertDelivery(ids, { mac: 'off' });
      return;
    }
    due.forEach(({ title, body }) => sendNotification({ title, body }));
    recordAlertDelivery(ids, { mac: 'shown' });
  } catch (error) {
    console.warn('Failed to send a notification', error);
    recordAlertDelivery(ids, { mac: 'failed' });
  }
}

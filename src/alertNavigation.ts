import { invokeCommand } from './native/commands';
import { requestFocus } from './focusRequests';
import { accountLimitsView, machinesView, sessionsView, setupChecksView, usageView, type AppView } from './navigation';
import type { AlertDestination } from './services/alertHistory';

/** The page an alert opens on, or null for a status page, which opens in the browser. */
export function alertDestinationView(destination: AlertDestination): AppView | null {
  switch (destination.kind) {
    case 'accounts': return accountLimitsView();
    case 'machines': return machinesView(destination.machine);
    // What changed is in Checks' table of each machine's setup.
    case 'setup': return setupChecksView();
    case 'archive': return { kind: 'settings', page: 'session-archive' };
    case 'session': return sessionsView({ session: destination.session });
    case 'sessions': return { kind: 'main', page: 'sessions' };
    case 'digest': return usageView({ tab: 'digest' });
    case 'home': return { kind: 'main', page: 'home' };
    case 'url': return null;
  }
}

/**
 * Opens what an alert is about, from the Alerts page or the alert's toast: its page with the row, session or tab it
 * names, or its status page in the browser.
 */
export function openAlertDestination(destination: AlertDestination, navigate: (view: AppView) => void) {
  if (destination.kind === 'url') {
    invokeCommand('open_external_url', { url: destination.url }).catch((error) => console.warn('Failed to open the status page', error));
    return;
  }
  if (destination.kind === 'accounts' && destination.account) requestFocus('account', destination.account);
  if (destination.kind === 'machines' && destination.machine) requestFocus('machine', destination.machine);
  const view = alertDestinationView(destination);
  if (view) navigate(view);
}

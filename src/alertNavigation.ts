import { invokeCommand } from './native/commands';
import { requestFocus, type FocusTarget } from './focusRequests';
import { accountLimitsView, automationView, machinesView, movedSetupView, sessionsView, setupChecksView, setupView, usageView, type AppView } from './navigation';
import type { AlertDestination } from './services/alertHistory';
import { settingEntry } from './services/settingsIndex';
import { setSyncMachine } from './services/syncScope';

/** The page an alert opens on, or null for a status page, which opens in the browser. */
export function alertDestinationView(destination: AlertDestination): AppView | null {
  switch (destination.kind) {
    case 'accounts': return accountLimitsView();
    case 'machines': return machinesView(destination.machine);
    case 'automation': return automationView(destination.automation);
    // A change of one kind opens that kind in the Library by machine, where each machine's homes are; others, Overview's
    // table of each machine's setup.
    case 'setup':
      // The setup repo's own trouble is on Sync › Repo, beside its Pull and Push.
      if (destination.tab === 'repo') return setupView({ tab: 'repo' });
      return (destination.tab ? movedSetupView(destination.tab) : null) ?? setupChecksView();
    case 'archive': return { kind: 'settings', page: 'session-archive' };
    case 'session': return sessionsView({ session: destination.session });
    // An agent waiting on one machine is on the live board, narrowed to that machine.
    case 'sessions': return destination.machine ? sessionsView({ tab: 'live', machine: destination.machine }) : { kind: 'main', page: 'sessions' };
    // Every proxy problem's setting is on Settings › Proxy, which is where an id the index no longer has opens too.
    case 'setting': return { kind: 'settings', page: settingEntry(destination.setting)?.page ?? 'general' };
    case 'digest': return usageView({ tab: 'digest' });
    case 'home': return { kind: 'main', page: 'home' };
    case 'url': return null;
  }
}

/**
 * What the page an alert opens is asked to bring into view, and the machine Sync is shown on, which, unlike a view's
 * params, outlast the visit: an account's row or a provider's accounts, a machine's page, a setting's row.
 */
export type AlertFocus = { focus?: { target: FocusTarget; id: string }; syncMachine?: string };

export function alertDestinationFocus(destination: AlertDestination): AlertFocus {
  switch (destination.kind) {
    case 'accounts':
      if (destination.account) return { focus: { target: 'account', id: destination.account } };
      return destination.provider ? { focus: { target: 'provider', id: destination.provider } } : {};
    case 'machines': return destination.machine ? { focus: { target: 'machine', id: destination.machine } } : {};
    case 'setting': return { focus: { target: 'setting', id: destination.setting } };
    // Only MCP & plugins can be narrowed to one machine; Hooks shows each machine side by side.
    case 'setup': return destination.tab === 'plugins' && destination.machine ? { syncMachine: destination.machine } : {};
    default: return {};
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
  const { focus, syncMachine } = alertDestinationFocus(destination);
  if (focus) requestFocus(focus.target, focus.id);
  if (syncMachine) setSyncMachine(syncMachine);
  const view = alertDestinationView(destination);
  if (view) navigate(view);
}

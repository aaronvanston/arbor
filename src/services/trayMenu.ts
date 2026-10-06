import { listen } from '@tauri-apps/api/event';
import { machinesView } from '../navigation';
import { invokeCommand } from '../native/commands';
import type { HealthStatus, TrayAction, TrayDot, TrayRow, TraySection } from '../native/types';
import { pushToTray } from './bootMode';
import { isWindowHidden } from './hiddenPace';
import { goToView } from './viewHistory';

/** A line across the tray menu or one of its sub-menus. */
export const TRAY_SEPARATOR: TrayRow = { text: '' };

/** The menu's dot for a machine's health, as the sidebar colors it; gray until it's been sampled. */
export const HEALTH_DOT: Record<HealthStatus, TrayDot> = {
  healthy: 'green',
  degraded: 'amber',
  critical: 'red',
  unreachable: 'red',
  pending: 'gray',
  unconfigured: 'gray',
};

const lastRows = new Map<TraySection, string>();

/** Puts a section's rows in the tray menu, which leaves it alone when they haven't changed. */
export function publishTrayRows(section: TraySection, rows: TrayRow[]) {
  const hidden = isWindowHidden();
  // Reset countdown text ticks every minute while the tray is closed. Keep the useful limit values and status
  // stable until the window is shown again, when the limits monitor refreshes the menu with the current countdown.
  const signatureRows = hidden && section === 'limits'
    ? rows.map((row) => ({ ...row, text: row.text.replace(/resets in [^·]+/g, 'resets in') }))
    : rows;
  const signature = JSON.stringify(signatureRows);
  if (lastRows.get(section) === signature) return;
  lastRows.set(section, signature);
  pushToTray(`rows:${section}`, rows.length === 0, () => {
    invokeCommand('set_tray_rows', { section, rows }).catch((error) => console.warn(`Failed to update the tray ${section}`, error));
  });
}

/** Carries out what was picked in the tray menu; the native side has already shown the window. Returns what stops it. */
export function watchTrayActions(): () => void {
  const stop = listen<TrayAction>('tray-action', ({ payload }) => {
    switch (payload.kind) {
      case 'openMachine':
        goToView(machinesView(payload.machine));
        break;
    }
  });
  return () => void stop.then((unlisten) => unlisten()).catch(() => undefined);
}

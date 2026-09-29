import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useAppPreferences } from '../appPreferences';
import { machineValue, raisedAnywhere, useMachineOverrides } from '../services/machineSettings';
import { useI18n } from '../i18n';
import { notify } from '../services/notify';
import { SETUP_CHANGED_EVENT, SETUP_WATCH_INTERVAL_MS, setupChangeNotification, type SetupChanged } from '../services/setupChanges';
import { scanSetup } from '../services/setupInventory';

/** The first read after Arbor starts, once the machines have answered their first health checks. */
const FIRST_SCAN_DELAY_MS = 60_000;

/**
 * Headless: while change alerts are on, reads each machine's setup every half hour (only those that answer and weren't
 * read lately), and tells its user when a hook, MCP server, plugin marketplace or plugin came, went or changed without
 * Arbor doing it. The first read after Arbor starts is what later ones compare with.
 */
export function SetupChangeMonitor() {
  const { t } = useI18n();
  const preferences = useAppPreferences();
  const overrides = useMachineOverrides();
  const enabled = raisedAnywhere(preferences, overrides, 'setupChangeAlerts');
  // A change is told only for a machine whose alerts are on (Settings › Notifications at that machine).
  const onForRef = useRef((machine: string) => machineValue(preferences, overrides, machine, 'setupChangeAlerts'));
  onForRef.current = (machine: string) => machineValue(preferences, overrides, machine, 'setupChangeAlerts');
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const scan = () => {
      if (!disposed) scanSetup(null, true).catch((error) => console.warn('Could not start setup scans', error));
    };
    const first = window.setTimeout(scan, FIRST_SCAN_DELAY_MS);
    const timer = window.setInterval(scan, SETUP_WATCH_INTERVAL_MS);
    let stop: (() => void) | undefined;
    listen<SetupChanged>(SETUP_CHANGED_EVENT, ({ payload }) => {
      if (!onForRef.current(payload.machine)) return;
      const message = setupChangeNotification(payload, tRef.current);
      if (message) void notify([message]);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [enabled]);

  return null;
}

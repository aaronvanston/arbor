import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useI18n } from '../i18n';
import { AUTOMATIONS_UPDATED_EVENT, failedRunAlerts, loadAutomations, useAutomations, type SeenRuns } from '../services/automations';
import { carriedTimes } from '../services/backgroundReload';
import { notify } from '../services/notify';
import { carriedOver, carryOverReload } from '../services/reloadHolds';

/** The runs already seen, carried over a reload of the hidden window so one that failed during it still alerts. */
const SEEN_CARRY = 'automations.seen';

/**
 * Headless watcher for Arbor's own automations: it reads the list again whenever the native side says something
 * changed, so every page showing automations stays current, and alerts once for each run that failed or couldn't
 * reach its machine.
 */
export function AutomationMonitor() {
  const { t } = useI18n();
  const { list } = useAutomations();
  const seenRef = useRef<SeenRuns | null>(carriedTimes(carriedOver(SEEN_CARRY)));
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => carryOverReload(SEEN_CARRY, () => seenRef.current), []);

  useEffect(() => {
    void loadAutomations();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen(AUTOMATIONS_UPDATED_EVENT, () => { void loadAutomations(); }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!list) return;
    const { seen, alerts } = failedRunAlerts(seenRef.current, list, tRef.current);
    seenRef.current = seen;
    if (alerts.length) void notify(alerts);
  }, [list]);

  return null;
}

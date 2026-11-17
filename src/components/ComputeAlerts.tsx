import { useEffect, useRef } from 'react';
import { useAppPreferences } from '../appPreferences';
import { useI18n } from '../i18n';
import { useComputeSelect } from '../services/compute';
import { computeAlertNotification, nextComputeAlerts } from '../services/computeAlerts';
import { notify } from '../services/notify';
import { readComputeAlerted, saveComputeAlerted } from './ComputeMonitor';

/**
 * Compute's alerts once a provider is connected: follows the snapshot Rust sends after each round, which keeps coming
 * with the window closed, and alerts each problem once while it lasts. Its own chunk, which ComputeMonitor loads only
 * then, so the rules and their words cost an install with no provider nothing at launch.
 */
export function ComputeAlerts() {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const { computeAlerts: enabled } = useAppPreferences();
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const snapshot = useComputeSelect((state) => state.snapshot);

  useEffect(() => {
    if (!snapshot) return;
    const now = Date.now();
    const next = nextComputeAlerts(readComputeAlerted(), snapshot, now);
    // Kept with alerts off too, so turning them on doesn't alert everything that was already wrong.
    saveComputeAlerted(next.alerted);
    if (enabledRef.current && next.alert.length) {
      void notify(next.alert.map((problem) => computeAlertNotification(problem, tRef.current, now)));
    }
  }, [snapshot]);

  return null;
}

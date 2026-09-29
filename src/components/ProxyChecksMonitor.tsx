import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef } from 'react';
import { useI18n } from '../i18n';
import { notify } from '../services/notify';
import { nextProxyAlerts, proxyProblemNotification, refreshProxyChecks, useDismissedNetworkHost } from '../services/proxyChecks';

const ALERTED_KEY = 'cpa-gui.proxy-checks.alerted.v1';
/** Usage statistics and keys change rarely, and a config file change asks again straight away. */
const CHECK_INTERVAL_MS = 60_000;

const readAlerted = (): string[] => {
  try {
    const stored = JSON.parse(localStorage.getItem(ALERTED_KEY) ?? '[]') as unknown;
    return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
};

const saveAlerted = (alerted: string[]) => {
  try {
    localStorage.setItem(ALERTED_KEY, JSON.stringify(alerted));
  } catch {
    /* alerts again next run */
  }
};

/**
 * Headless watcher for the proxy settings Arbor depends on: asks the running core once it's up, every minute and
 * whenever a config file changes, and alerts when a problem appears. A problem that lasts alerts once, across
 * restarts too; fixed and back again, it alerts again.
 */
export function ProxyChecksMonitor({ coreReady }: { coreReady: boolean }) {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const dismissed = useDismissedNetworkHost();
  const dismissedRef = useRef(dismissed);
  dismissedRef.current = dismissed;

  useEffect(() => {
    if (!coreReady) return;
    let disposed = false;
    const check = async () => {
      try {
        const checks = await refreshProxyChecks();
        if (disposed) return;
        const next = nextProxyAlerts(readAlerted(), checks, dismissedRef.current);
        saveAlerted(next.alerted);
        if (next.alert.length) void notify(next.alert.map((problem) => proxyProblemNotification(problem, tRef.current)));
      } catch (error) {
        console.warn('Failed to check the proxy settings', error);
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    let stopListening: (() => void) | undefined;
    void listen('config-files-changed', () => void check()).then((stop) => {
      if (disposed) stop();
      else stopListening = stop;
    });
    return () => {
      disposed = true;
      window.clearInterval(timer);
      stopListening?.();
    };
  }, [coreReady]);

  return null;
}

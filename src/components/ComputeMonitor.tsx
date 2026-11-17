import { lazy, Suspense, useEffect } from 'react';
import { useConnectedComputeProviders } from '../services/computeHint';

const ComputeAlerts = lazy(() => import('./ComputeAlerts').then((module) => ({ default: module.ComputeAlerts })));

const ALERTED_KEY = 'arbor.compute.alerted.v1';

/** The problems already alerted, by `computeProblemKey`, so a restart doesn't alert them again. */
export const readComputeAlerted = (): string[] => {
  try {
    const stored = JSON.parse(localStorage.getItem(ALERTED_KEY) ?? '[]') as unknown;
    return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
};

export const saveComputeAlerted = (alerted: string[]) => {
  try {
    if (alerted.length) localStorage.setItem(ALERTED_KEY, JSON.stringify(alerted));
    else localStorage.removeItem(ALERTED_KEY);
  } catch {
    /* alerts again next run */
  }
};

/**
 * Headless watcher for Compute's alerts. Does nothing until a provider is connected (the saved hint says so), so an
 * install without one makes no call, holds no listener and loads none of the alert rules.
 */
export function ComputeMonitor() {
  const connected = useConnectedComputeProviders();
  // Nothing connected: what was alerted goes too, so a provider connected again starts fresh.
  useEffect(() => {
    if (!connected.length) saveComputeAlerted([]);
  }, [connected.length]);
  return connected.length ? <Suspense fallback={null}><ComputeAlerts /></Suspense> : null;
}

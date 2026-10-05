import { useSyncExternalStore } from 'react';

/**
 * How long after the window's first render the work that doesn't feed the first screen waits, so Home's own reads go
 * first rather than competing with thirty others. An alert that work raises is held up by no more than this.
 */
export const LAUNCH_SETTLE_MS = 1_500;

let settled = typeof window === 'undefined';
let started = false;
const listeners = new Set<() => void>();

/** Starts the wait on first use, which is the window's first render. */
function start() {
  if (started || settled) return;
  started = true;
  setTimeout(() => {
    settled = true;
    for (const listener of listeners) listener();
    listeners.clear();
  }, LAUNCH_SETTLE_MS);
}

/** Resolves once launch has settled: at once after that. */
export function afterLaunch(): Promise<void> {
  start();
  return settled ? Promise.resolve() : new Promise((resolve) => listeners.add(resolve));
}

const subscribe = (listener: () => void) => {
  start();
  if (settled) return () => undefined;
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const isSettled = () => settled;

/** Whether launch has settled, for what mounts only after it. */
export const useLaunchSettled = () => useSyncExternalStore(subscribe, isSettled, isSettled);

/** Back to a fresh launch, for tests. */
export function resetLaunchSettle(value = false) {
  settled = value;
  started = false;
  listeners.clear();
}

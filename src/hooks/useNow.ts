import { formatAgo } from '../lib/format';
import { useStoreSelector } from '../services/stableValue';

/** Every half minute: enough for "scanned 3 minutes ago" to stay true while a page is open. */
const TICK_MS = 30_000;

// One clock for everything that shows how long ago something was, running only while something does.
let now = Date.now();
let timer: number | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      listeners.forEach((notify) => notify());
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
};
const getNow = () => now;
const itself = (value: number) => value;

/**
 * The time now, moved on every half minute. With `select`, only what's worked out from it ("3 minutes ago", whether
 * something has gone stale): the component renders again when that changes, not on every tick, so a page that shows a
 * few times doesn't render whole twice a minute.
 */
export function useNow(): number;
export function useNow<T>(select: (nowMs: number) => T): T;
export function useNow<T>(select?: (nowMs: number) => T): T | number {
  return useStoreSelector<number, T | number>(subscribe, getNow, select ?? itself);
}

/** How long ago `atMs` was, in words, kept true while it's on screen; empty for null. */
export const useAgo = (atMs: number | null | undefined): string =>
  useNow((nowMs) => (atMs === null || atMs === undefined ? '' : formatAgo(atMs, nowMs)));

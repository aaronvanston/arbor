import { useSyncExternalStore } from 'react';
import type { QuotaRow, QuotaState } from './quotaService';

type QuotaCache = Record<string, QuotaState>;
type QuotaCacheUpdater = QuotaCache | ((current: QuotaCache) => QuotaCache);

let cache: QuotaCache = {};
let generation = 0;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = () => cache;
export const getQuotaCacheSnapshot = getSnapshot;
export const subscribeQuotaCache = subscribe;
export const captureQuotaCacheGeneration = () => generation;

export const commitQuotaCacheIfCurrent = (expectedGeneration: number, commit: () => void) => {
  if (generation !== expectedGeneration) return false;
  commit();
  return true;
};

export const updateQuotaCache = (updater: QuotaCacheUpdater) => {
  const next = typeof updater === 'function' ? updater(cache) : updater;
  if (Object.is(next, cache)) return;
  cache = next;
  listeners.forEach((listener) => listener());
};

/**
 * How long limits are kept after they were read while checks keep failing. Past this it's no passing timeout but
 * a login or a provider that stays broken, and figures that old would only keep the account marked stale.
 */
export const STALE_ROWS_MAX_AGE_MS = 24 * 3_600_000;

/**
 * What a finished limit check leaves in the cache. A failed check keeps the rows of the last good one, marked
 * stale from the first failure, so one timeout doesn't blank the account's limits; its error still shows. Rows
 * never cross accounts: the cache is keyed per credential file and auth index.
 */
export const mergeQuotaResult = (previous: QuotaState | undefined, result: QuotaState, nowMs = Date.now()): QuotaState => {
  if (result.status !== 'error' || result.rows.length > 0 || !previous?.rows.length) return result;
  if (nowMs - (previous.fetchedAt ?? previous.staleSinceMs ?? nowMs) >= STALE_ROWS_MAX_AGE_MS) return result;
  // A limit that has reset since it was read says nothing about the account any more.
  const serverNowMs = nowMs + (previous.serverTimeOffsetMs ?? 0);
  const current = (row: QuotaRow) => row.resetAtMs === undefined || row.resetAtMs > serverNowMs;
  // One without a reset time (Claude's extra usage, an idle 5-hour window) can't tell when it went out of date,
  // so it goes with the last one that can.
  const dated = previous.rows.filter((row) => row.resetAtMs !== undefined);
  if (dated.length && !dated.some(current)) return result;
  const rows = previous.rows.filter(current);
  if (!rows.length) return result;
  return {
    ...result,
    rows,
    plan: previous.plan,
    fetchedAt: previous.fetchedAt,
    serverTimeOffsetMs: previous.serverTimeOffsetMs,
    staleSinceMs: previous.staleSinceMs ?? nowMs,
  };
};

/** Stores a finished limit check. Every refresh goes through here. */
export const storeQuotaResult = (key: string, result: QuotaState) =>
  updateQuotaCache((current) => ({ ...current, [key]: mergeQuotaResult(current[key], result) }));

export const pruneQuotaCache = (validKeys: Set<string>) => {
  updateQuotaCache((current) => {
    const next = Object.fromEntries(
      Object.entries(current)
        .filter(([key]) => validKeys.has(key))
        .map(([key, value]) => [
          key,
          value.status === 'loading' ? { status: 'idle', rows: [] } : value,
        ]),
    ) as QuotaCache;
    const unchanged = Object.keys(next).length === Object.keys(current).length;
    if (unchanged) return current;
    generation += 1;
    return next;
  });
};

/**
 * Moves cached limits to a credential's new key after a rename. Like pruning,
 * it retires the cache generation so a fetch still running for the old key
 * cannot write it back. That discards every fetch in flight, so like pruning it
 * returns every loading entry to idle rather than leave it loading for good.
 */
export const renameQuotaCacheKeys = (renames: { from: string; to: string }[]) => {
  updateQuotaCache((current) => {
    let next = current;
    for (const { from, to } of renames) {
      const moved = next[from];
      if (from === to || !moved) continue;
      next = { ...next };
      delete next[from];
      if (!next[to] || next[to].status === 'idle') next[to] = moved;
    }
    if (next === current) return current;
    generation += 1;
    return Object.fromEntries(Object.entries(next).map(([key, value]) => [
      key,
      value.status === 'loading' ? { status: 'idle', rows: [] } : value,
    ])) as QuotaCache;
  });
};

export function useQuotaCache() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

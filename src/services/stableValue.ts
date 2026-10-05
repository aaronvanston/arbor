import { useState, useSyncExternalStore } from 'react';

const { hasOwnProperty: hasOwn } = Object.prototype;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

/**
 * `next`, with every part that equals the same part of `previous` swapped for that part, so a read that changed nothing
 * gives back `previous` itself and one that changed a machine keeps every other machine's object. Components memoized
 * on those objects then skip the rows that didn't change. Arrays, plain objects and Maps are compared through; anything
 * else (dates, class instances) only by identity.
 */
export function replaceEqualDeep<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) return previous as T;
  if (Array.isArray(previous) && Array.isArray(next)) {
    let same = previous.length === next.length;
    const merged = next.map((item, index) => {
      const kept = replaceEqualDeep(previous[index], item);
      if (kept !== previous[index]) same = false;
      return kept;
    });
    return (same ? previous : merged) as T;
  }
  if (previous instanceof Map && next instanceof Map) {
    let same = previous.size === next.size;
    const merged = new Map();
    for (const [key, value] of next) {
      const kept = previous.has(key) ? replaceEqualDeep(previous.get(key), value) : value;
      if (!previous.has(key) || kept !== previous.get(key)) same = false;
      merged.set(key, kept);
    }
    return (same ? previous : merged) as T;
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    const keys = Object.keys(next);
    let same = keys.length === Object.keys(previous).length;
    const merged: Record<string, unknown> = {};
    for (const key of keys) {
      const kept = hasOwn.call(previous, key) ? replaceEqualDeep(previous[key], next[key]) : next[key];
      if (!hasOwn.call(previous, key) || kept !== previous[key]) same = false;
      merged[key] = kept;
    }
    return (same ? previous : merged) as T;
  }
  return next;
}

/**
 * `value`, kept the same object while it's equal throughout to what it was last render, so a memo or a memoized child
 * keyed on it doesn't run again for a copy.
 */
export function useStableValue<T>(value: T): T {
  // A box rather than a ref: it's read and written during render, which is safe here as the result depends only on the
  // values passed in, whichever render saw them first.
  const [box] = useState<{ value: T }>(() => ({ value }));
  box.value = replaceEqualDeep(box.value, value);
  return box.value;
}

/** What `useStoreSelector` picked last, and from what. */
export type SelectorCache<S, T> = { last: { source: S; select: (snapshot: S) => T; value: T } | null };

/**
 * The store's part `select` picks now: the cached one while neither the store nor `select` changed, else picked again
 * and kept as the cached one wherever it's equal.
 */
export function selectedSnapshot<S, T>(cache: SelectorCache<S, T>, source: S, select: (snapshot: S) => T): T {
  const { last } = cache;
  if (last && Object.is(last.source, source) && last.select === select) return last.value;
  const value = last ? replaceEqualDeep(last.value, select(source)) : select(source);
  cache.last = { source, select, value };
  return value;
}

/**
 * Part of an external store, picked by `select`: the component renders again only when what it picked changes, judged
 * throughout by `replaceEqualDeep`, rather than on every change to the store. `select` may be written inline.
 */
export function useStoreSelector<S, T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => S, select: (snapshot: S) => T): T {
  const [cache] = useState<SelectorCache<S, T>>(() => ({ last: null }));
  const get = () => selectedSnapshot(cache, getSnapshot(), select);
  return useSyncExternalStore(subscribe, get, get);
}

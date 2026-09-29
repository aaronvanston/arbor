import { useSyncExternalStore } from 'react';

/** A value shared across the app, for code outside React (`get`, `set`) and for components (`useValue`). */
export type SharedStore<T> = {
  get: () => T;
  /** Replaces the value and tells every subscriber; the same value again tells no one. */
  set: (next: T) => void;
  subscribe: (listener: () => void) => () => void;
  useValue: () => T;
};

/** A store whose first value is worked out when something first asks for it. */
function lazyStore<T>(first: () => T, onChange?: (value: T) => void): SharedStore<T> {
  let loaded = false;
  let value = undefined as T;
  const listeners = new Set<() => void>();
  const get = () => {
    if (!loaded) {
      value = first();
      loaded = true;
    }
    return value;
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    get,
    subscribe,
    set(next) {
      if (Object.is(next, get())) return;
      value = next;
      onChange?.(next);
      listeners.forEach((listener) => listener());
    },
    useValue: () => useSyncExternalStore(subscribe, get, get),
  };
}

/** A value kept in memory only, gone when Arbor quits. */
export const sharedStore = <T,>(initial: T): SharedStore<T> => lazyStore(() => initial);

type SavedStoreOptions<T> = {
  /** Where it's kept in localStorage. A key's stored shape only changes with a new key. */
  key: string;
  /**
   * Turns what's stored (null when nothing is) into a value, keeping only what's valid, since the stored text could be
   * from an older Arbor or edited by hand. Throwing counts as unreadable and gives `fallback`.
   */
  parse: (raw: string | null) => T;
  /** What's used when there's no storage (tests) or the stored text can't be read. */
  fallback: T;
  /** How the value is written; JSON unless the store keeps plain text. */
  serialize?: (value: T) => string;
};

/**
 * A value kept in localStorage: read and checked the first time it's asked for, not at import, so the browser mock can
 * seed it first; then kept in memory and written back on every change. A write that fails (storage full) keeps the
 * change in memory for this run.
 */
export function savedStore<T>({ key, parse, fallback, serialize = JSON.stringify }: SavedStoreOptions<T>): SharedStore<T> {
  const read = (): T => {
    try {
      return typeof localStorage === 'undefined' ? fallback : parse(localStorage.getItem(key));
    } catch {
      return fallback;
    }
  };
  return lazyStore(read, (value) => {
    try {
      localStorage.setItem(key, serialize(value));
    } catch {
      /* keep in memory */
    }
  });
}

/** Stored JSON as an object with string keys, or an empty one when it's missing or anything else. */
export function storedRecord(raw: string | null): Record<string, unknown> {
  const parsed = JSON.parse(raw ?? '{}') as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

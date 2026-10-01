import { useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invokeCommand } from '../native/commands';
import type { SavedStoreChange } from '../native/types';

/** The app's event for a setting saved from the command line (or anywhere else outside this window). */
export const SAVED_STORE_CHANGED_EVENT = 'saved-store-changed';

/** A value shared across the app, for code outside React (`get`, `set`) and for components (`useValue`). */
export type SharedStore<T> = {
  get: () => T;
  /** Replaces the value and tells every subscriber; the same value again tells no one. */
  set: (next: T) => void;
  subscribe: (listener: () => void) => () => void;
  useValue: () => T;
};

/** A store whose first value is worked out when something first asks for it. */
function lazyStore<T>(first: () => T, onChange?: (value: T) => void): SharedStore<T> & { replace: (next: T) => void } {
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
  const tell = () => listeners.forEach((listener) => listener());
  return {
    get,
    subscribe,
    set(next) {
      if (Object.is(next, get())) return;
      value = next;
      onChange?.(next);
      tell();
    },
    /** Takes a value that was saved elsewhere: tells the subscribers without saving it again. */
    replace(next) {
      value = next;
      loaded = true;
      tell();
    },
    useValue: () => useSyncExternalStore(subscribe, get, get),
  };
}

/** A value kept in memory only, gone when Arbor quits. */
export const sharedStore = <T,>(initial: T): SharedStore<T> => lazyStore(() => initial);

type SavedStoreOptions<T> = {
  /** Where it's kept. A key's stored shape only changes with a new key. */
  key: string;
  /**
   * Turns what's stored (null when nothing is) into a value, keeping only what's valid, since the stored text could be
   * from an older Arbor, edited by hand or set from the command line. Throwing counts as unreadable and gives `fallback`.
   */
  parse: (raw: string | null) => T;
  /** What's used when there's no storage (tests) or the stored text can't be read. */
  fallback: T;
  /** How the value is written; JSON unless the store keeps plain text. */
  serialize?: (value: T) => string;
  /**
   * `window` for what only matters to this window's layout (the sidebar, a grid's columns, recent picks), which stays
   * in its own storage. Everything else is a setting the app keeps, so the command line can read and change it.
   */
  place?: 'app' | 'window';
};

/** A setting the app keeps: how to read it from its stored text, and how to take a value saved elsewhere. */
type KeptSetting = { take: (raw: string | null) => void };

/** The settings the app keeps, by key, as their stores are made. */
const kept = new Map<string, KeptSetting>();
/** What the app has saved, once `loadSavedSettings` has read it; until then (and in tests) localStorage stands in. */
let fromApp: Map<string, string> | null = null;

/** What's stored for a key, or undefined when there's no storage at all (tests). */
const storedText = (key: string): string | null | undefined => {
  if (fromApp && kept.has(key)) return fromApp.get(key) ?? null;
  return typeof localStorage === 'undefined' ? undefined : localStorage.getItem(key);
};

/** How the app is asked to save a setting; set by `loadSavedSettings`. */
let saveInApp: ((name: string, value: string | null) => Promise<unknown>) | null = null;

/**
 * A saved value: read and checked the first time it's asked for, not at import, so the browser mock can seed it
 * first; then kept in memory and written back on every change. Settings the app keeps are written to the app (and to
 * localStorage too, for one more version, in case the app's copy can't be read); a change from the command line comes
 * back through `loadSavedSettings` and updates every subscriber. A write that fails keeps the change in memory for
 * this run.
 */
export function savedStore<T>({ key, parse, fallback, serialize = JSON.stringify, place = 'app' }: SavedStoreOptions<T>): SharedStore<T> {
  const readText = (raw: string | null): T => {
    try {
      return parse(raw);
    } catch {
      return fallback;
    }
  };
  const read = (): T => {
    try {
      const text = storedText(key);
      return text === undefined ? fallback : readText(text);
    } catch {
      return fallback;
    }
  };
  const store = lazyStore(read, (value) => {
    let text: string;
    try {
      text = serialize(value);
    } catch {
      return;
    }
    if (place === 'app') {
      fromApp?.set(key, text);
      void saveInApp?.(key, text).catch(() => undefined);
    }
    try {
      localStorage.setItem(key, text);
    } catch {
      /* keep in memory */
    }
  });
  if (place === 'app') kept.set(key, { take: (raw) => store.replace(readText(raw)) });
  return { get: store.get, set: store.set, subscribe: store.subscribe, useValue: store.useValue };
}

/**
 * Reads the settings the app keeps, before anything is drawn, and listens for changes made from the command line. The
 * first run of this version moves what the window kept itself into the app. When the app can't be reached the window
 * carries on with its own storage for this run.
 */
export async function loadSavedSettings(): Promise<void> {
  try {
    let snapshot = await invokeCommand('saved_store_snapshot');
    if (!snapshot.migrated) {
      const values: Record<string, string> = {};
      for (const key of kept.keys()) {
        const text = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
        if (text !== null) values[key] = text;
      }
      snapshot = await invokeCommand('saved_store_migrate', { values });
    }
    fromApp = new Map(Object.entries(snapshot.values));
    // Anything read before now read the window's own copy; the app's is the one that counts.
    for (const [key, setting] of kept) setting.take(fromApp.get(key) ?? null);
    saveInApp = (name, value) => invokeCommand('saved_store_set', { name, value });
    await listen<SavedStoreChange>(SAVED_STORE_CHANGED_EVENT, ({ payload }) => {
      const setting = kept.get(payload.name);
      if (!fromApp || !setting || fromApp.get(payload.name) === (payload.value ?? undefined)) return;
      if (payload.value === null || payload.value === undefined) fromApp.delete(payload.name);
      else fromApp.set(payload.name, payload.value);
      try {
        if (payload.value === null || payload.value === undefined) localStorage.removeItem(payload.name);
        else localStorage.setItem(payload.name, payload.value);
      } catch {
        /* the app's copy is the one that counts */
      }
      setting.take(payload.value ?? null);
    });
  } catch {
    fromApp = null;
    saveInApp = null;
  }
}

/** Stored JSON as an object with string keys, or an empty one when it's missing or anything else. */
export function storedRecord(raw: string | null): Record<string, unknown> {
  const parsed = JSON.parse(raw ?? '{}') as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

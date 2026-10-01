import { afterEach, describe, expect, it } from 'bun:test';
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import { loadSavedSettings, SAVED_STORE_CHANGED_EVENT, savedStore } from '../src/services/savedStore';

const global = globalThis as { localStorage?: unknown };
const previous = global.localStorage;
afterEach(() => {
  global.localStorage = previous;
});

/** Installs a stand-in for localStorage, returning what's in it. */
function storage(initial: Record<string, string> = {}, { failWrites = false } = {}) {
  const values = new Map(Object.entries(initial));
  global.localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error('full');
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
  };
  return values;
}

const parseCount = (raw: string | null) => {
  const value: unknown = JSON.parse(raw ?? '0');
  if (typeof value !== 'number') throw new Error('not a count');
  return value;
};

describe('a saved store', () => {
  it('reads what was saved the first time it is asked, not when it is made', () => {
    storage();
    const store = savedStore({ key: 'count', parse: parseCount, fallback: -1 });
    // Seeded after the store was made, as the browser mock seeds after the app's modules load.
    storage({ count: '4' });
    expect(store.get()).toBe(4);
  });

  it('starts from the fallback when what was saved cannot be read, or there is no storage', () => {
    storage({ count: '"four"' });
    expect(savedStore({ key: 'count', parse: parseCount, fallback: -1 }).get()).toBe(-1);
    storage({ count: '{not json' });
    expect(savedStore({ key: 'count', parse: parseCount, fallback: -1 }).get()).toBe(-1);
    global.localStorage = undefined;
    expect(savedStore({ key: 'count', parse: parseCount, fallback: -1 }).get()).toBe(-1);
  });

  it('writes each change and tells its subscribers, and the same value again does neither', () => {
    const values = storage();
    const store = savedStore({ key: 'count', parse: parseCount, fallback: 0 });
    let told = 0;
    store.subscribe(() => told++);
    store.set(2);
    expect(values.get('count')).toBe('2');
    expect(told).toBe(1);
    values.set('count', 'untouched');
    store.set(2);
    expect(values.get('count')).toBe('untouched');
    expect(told).toBe(1);
  });

  it('keeps a change it could not write for the rest of the run', () => {
    storage({}, { failWrites: true });
    const store = savedStore({ key: 'count', parse: parseCount, fallback: 0 });
    let told = 0;
    store.subscribe(() => told++);
    expect(() => store.set(3)).not.toThrow();
    expect(store.get()).toBe(3);
    expect(told).toBe(1);
  });
});

describe('settings the app keeps', () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(async () => {
    // An app that can't be reached puts every store back on the window's own storage, as before the app was asked.
    mockCommands({ saved_store_snapshot: () => { throw 'gone'; } });
    await loadSavedSettings();
    clearMocks();
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  it('move in from the window once, save to the app, and take changes made from the command line', async () => {
    Object.defineProperty(globalThis, 'window', { value: { crypto: globalThis.crypto }, writable: true, configurable: true });
    const values = storage({ 'arbor.test-count.v1': '5', 'arbor.test-layout.v1': '1' });
    const store = savedStore({ key: 'arbor.test-count.v1', parse: parseCount, fallback: 0 });
    savedStore({ key: 'arbor.test-layout.v1', parse: parseCount, fallback: 0, place: 'window' });
    let moved: Record<string, string> = {};
    const saved: [string, string | null | undefined][] = [];
    mockCommands({
      saved_store_snapshot: () => ({ values: {}, migrated: false }),
      saved_store_migrate: (args) => {
        moved = args.values;
        return { values: { ...args.values }, migrated: true };
      },
      saved_store_set: (args) => {
        saved.push([args.name, args.value]);
        return null;
      },
    }, { events: true });

    await loadSavedSettings();
    expect(moved['arbor.test-count.v1']).toBe('5');
    expect(moved).not.toHaveProperty('arbor.test-layout.v1');
    expect(store.get()).toBe(5);

    store.set(7);
    await settle();
    expect(saved).toContainEqual(['arbor.test-count.v1', '7']);

    let told = 0;
    store.subscribe(() => told++);
    await emit(SAVED_STORE_CHANGED_EVENT, { name: 'arbor.test-count.v1', value: '9' });
    await settle();
    expect(store.get()).toBe(9);
    expect(told).toBe(1);
    expect(values.get('arbor.test-count.v1')).toBe('9');
    expect(saved).toHaveLength(1);

    // Its own save coming back is nothing new.
    await emit(SAVED_STORE_CHANGED_EVENT, { name: 'arbor.test-count.v1', value: '9' });
    await settle();
    expect(told).toBe(1);
  });

  it('read what the app has over what the window kept, once it has moved', async () => {
    Object.defineProperty(globalThis, 'window', { value: { crypto: globalThis.crypto }, writable: true, configurable: true });
    storage({ 'arbor.test-name.v1': '1' });
    const store = savedStore({ key: 'arbor.test-name.v1', parse: parseCount, fallback: 0 });
    expect(store.get()).toBe(1);
    mockCommands({ saved_store_snapshot: () => ({ values: { 'arbor.test-name.v1': '3' }, migrated: true }) }, { events: true });
    await loadSavedSettings();
    expect(store.get()).toBe(3);
  });
});

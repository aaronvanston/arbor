import { afterEach, describe, expect, it } from 'bun:test';
import { savedStore } from '../src/services/savedStore';

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

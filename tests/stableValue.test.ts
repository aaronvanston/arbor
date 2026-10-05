import { describe, expect, test } from 'bun:test';
import { replaceEqualDeep, selectedSnapshot, type SelectorCache } from '../src/services/stableValue';
import { itemAt } from './support/items';

describe('replaceEqualDeep', () => {
  test('gives back the previous value when a fresh read equals it throughout', () => {
    const previous = { machines: [{ name: 'cam-mbp', score: 92, agents: { claude: '2.1.0' } }], at: null };
    const next = { machines: [{ name: 'cam-mbp', score: 92, agents: { claude: '2.1.0' } }], at: null };
    expect(replaceEqualDeep(previous, next)).toBe(previous);
  });

  test('keeps the parts that are equal when one part changed', () => {
    const previous = [{ name: 'cam-mbp', score: 92 }, { name: 'ci-01', score: 70 }];
    const next = [{ name: 'cam-mbp', score: 92 }, { name: 'ci-01', score: 71 }];
    const merged = replaceEqualDeep(previous, next);
    expect(merged).not.toBe(previous);
    expect(merged).toEqual(next);
    expect(itemAt(merged, 0)).toBe(itemAt(previous, 0));
    expect(itemAt(merged, 1)).not.toBe(itemAt(previous, 1));
  });

  test('sees an item added, removed or reordered', () => {
    const previous = [{ name: 'a' }, { name: 'b' }];
    expect(replaceEqualDeep(previous, [{ name: 'a' }])).toEqual([{ name: 'a' }]);
    expect(replaceEqualDeep(previous, [{ name: 'a' }, { name: 'b' }, { name: 'c' }])).toHaveLength(3);
    const reordered = replaceEqualDeep(previous, [{ name: 'b' }, { name: 'a' }]);
    expect(reordered).not.toBe(previous);
    expect(reordered).toEqual([{ name: 'b' }, { name: 'a' }]);
  });

  test('tells a missing key from one set to undefined', () => {
    const previous: Record<string, unknown> = { a: 1 };
    const next: Record<string, unknown> = { a: 1, b: undefined };
    expect(replaceEqualDeep(previous, next)).not.toBe(previous);
    expect(Object.keys(replaceEqualDeep(previous, next))).toEqual(['a', 'b']);
    expect(Object.keys(replaceEqualDeep(next, previous))).toEqual(['a']);
  });

  test('compares Maps by their entries', () => {
    const previous = new Map([['cam-mbp', { kind: 'laptop' }], ['ci-01', { kind: 'linux' }]]);
    expect(replaceEqualDeep(previous, new Map([['cam-mbp', { kind: 'laptop' }], ['ci-01', { kind: 'linux' }]]))).toBe(previous);
    const changed = replaceEqualDeep(previous, new Map([['cam-mbp', { kind: 'laptop' }], ['ci-01', { kind: 'server' }]]));
    expect(changed).not.toBe(previous);
    expect(changed.get('cam-mbp')).toBe(previous.get('cam-mbp'));
    expect(changed.get('ci-01')).toEqual({ kind: 'server' });
    expect(replaceEqualDeep(previous, new Map([['cam-mbp', { kind: 'laptop' }]])).size).toBe(1);
  });

  test('takes the new value for numbers, strings, null and things it does not look inside', () => {
    expect(replaceEqualDeep(1, 2)).toBe(2);
    expect(replaceEqualDeep('a', 'a')).toBe('a');
    expect(replaceEqualDeep(null, { a: 1 })).toEqual({ a: 1 });
    expect(replaceEqualDeep({ a: 1 }, null)).toBeNull();
    expect(replaceEqualDeep(Number.NaN, Number.NaN)).toBeNaN();
    const date = new Date(0);
    expect(replaceEqualDeep(new Date(0), date)).toBe(date);
    expect(replaceEqualDeep([1], { 0: 1 })).toEqual({ 0: 1 });
  });
});

describe('selectedSnapshot', () => {
  test('picks again only when the store or the pick changed, and keeps an equal pick', () => {
    const cache: SelectorCache<{ now: number }, string> = { last: null };
    let picks = 0;
    const select = (store: { now: number }) => {
      picks += 1;
      return store.now >= 120_000 ? 'passed' : 'soon';
    };
    const first = { now: 60_000 };
    expect(selectedSnapshot(cache, first, select)).toBe('soon');
    expect(selectedSnapshot(cache, first, select)).toBe('soon');
    expect(picks).toBe(1);
    expect(selectedSnapshot(cache, { now: 90_000 }, select)).toBe('soon');
    expect(selectedSnapshot(cache, { now: 120_000 }, select)).toBe('passed');
    expect(picks).toBe(3);
  });

  test('keeps the same object for an equal pick, so a render can bail out', () => {
    const cache: SelectorCache<number[], { count: number }> = { last: null };
    const first = selectedSnapshot(cache, [1, 2], (list) => ({ count: list.length }));
    // An inline pick is a new function every render; its equal result is still the same object.
    const again = selectedSnapshot(cache, [3, 4], (list) => ({ count: list.length }));
    expect(again).toBe(first);
    expect(selectedSnapshot(cache, [3, 4, 5], (list) => ({ count: list.length }))).toEqual({ count: 3 });
  });
});

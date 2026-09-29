import { describe, expect, it } from 'bun:test';
import { moveKey, sortByOrder } from '../src/services/accountOrder';

describe('account order', () => {
  it('puts known keys first in the saved order and keeps the rest in listing order', () => {
    const items = ['a', 'b', 'c', 'd'];
    expect(sortByOrder(items, ['c', 'a'], (item) => item)).toEqual(['c', 'a', 'b', 'd']);
    expect(sortByOrder(items, undefined, (item) => item)).toEqual(items);
    expect(sortByOrder(items, ['zzz'], (item) => item)).toEqual(items);
  });

  it('moves a key onto the dropped position', () => {
    expect(moveKey(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moveKey(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
    expect(moveKey(['a', 'b', 'c'], 'a', 'missing')).toEqual(['a', 'b', 'c']);
  });
});

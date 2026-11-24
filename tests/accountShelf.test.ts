import { describe, expect, it } from 'bun:test';
import { nextShelf, outOfPool, parseShelf, shelfReason, type Shelf } from '../src/services/accountShelf';

const NOW = Date.parse('2030-01-10T00:00:00Z');
const HOUR = 3_600_000;
const empty: Shelf = { seeded: false, since: {}, past: {} };

describe('the shelf', () => {
  it('puts accounts already off on the first listing on it from always, and later ones from when they went off', () => {
    const first = nextShelf(empty, { on: ['a'], off: ['b'] }, {}, NOW);
    expect(first).toEqual({ seeded: true, since: { b: 0 }, past: {} });
    const later = nextShelf(first, { on: [], off: ['a', 'b'] }, {}, NOW + HOUR);
    expect(later.since).toEqual({ b: 0, a: NOW + HOUR });
  });

  it('leaves out an account Arbor paused at its cap, which comes back by itself', () => {
    const shelf = nextShelf({ ...empty, seeded: true }, { on: [], off: ['a'] }, { a: {} }, NOW);
    expect(shelf.since).toEqual({});
  });

  it('keeps the stretch an account spent shelved once it is back on, and keeps an unlisted account as it was', () => {
    const shelved: Shelf = { seeded: true, since: { a: NOW - 5 * HOUR, gone: NOW - HOUR }, past: {} };
    const back = nextShelf(shelved, { on: ['a'], off: [] }, {}, NOW);
    expect(back).toEqual({ seeded: true, since: { gone: NOW - HOUR }, past: { a: [[NOW - 5 * HOUR, NOW]] } });
    // Nothing changed: the same object, so nothing is saved.
    expect(nextShelf(back, { on: ['a'], off: [] }, {}, NOW + HOUR)).toBe(back);
  });

  it('gives the forecast every stretch out of the pool, from always for an account it has not seen yet', () => {
    const shelf: Shelf = { seeded: true, since: { a: NOW }, past: { a: [[1, 2]], b: [[3, 4]] } };
    expect(outOfPool(shelf, ['a', 'c'])).toEqual({ a: [[1, 2], [NOW, null]], b: [[3, 4]], c: [[0, null]] });
  });

  it('reads back only what it wrote', () => {
    expect(parseShelf(JSON.stringify({ seeded: true, since: { a: 5, b: 'x' }, past: { a: [[1, 2], [3]], c: 'no' } })))
      .toEqual({ seeded: true, since: { a: 5 }, past: { a: [[1, 2]] } });
    expect(parseShelf(null)).toEqual(empty);
  });

  it('says why when the provider has the account on its free plan', () => {
    expect(shelfReason('claude', 'Free')).toBe('freePlan');
    expect(shelfReason('claude', 'Max 20x')).toBeNull();
  });
});

/**
 * The item at `index`. A missing item fails the test there and then, rather than surfacing later as a confusing read
 * of `undefined`. Negative indexes fail too, so a `-1` from an `indexOf` or `findIndex` that matched nothing can't
 * quietly read the last item; use `lastItem` for that.
 */
export function itemAt<T>(items: readonly T[], index: number): T {
  const item = index < 0 ? undefined : items[index];
  if (item === undefined) throw new Error(`Expected an item at index ${index} of a list of ${items.length}`);
  return item;
}

/** The last item, failing the test when the list is empty. */
export function lastItem<T>(items: readonly T[]): T {
  const item = items[items.length - 1];
  if (item === undefined) throw new Error('Expected a non-empty list');
  return item;
}

/** The value, failing the test when it is missing (a `find` that matched nothing, a map without the key). */
export function present<T>(value: T | null | undefined, what = 'a value'): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what}, got ${String(value)}`);
  return value;
}

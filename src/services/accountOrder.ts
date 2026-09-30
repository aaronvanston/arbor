import { savedStore, storedRecord } from './savedStore';

/** User-chosen account order per provider, as a list of quota keys. Unknown accounts keep their listing order after the known ones. */
export type AccountOrder = Record<string, string[]>;

/** Each provider's list of keys, keeping only lists of strings. */
function parseOrder(raw: string | null): AccountOrder {
  const order: AccountOrder = {};
  for (const [provider, keys] of Object.entries(storedRecord(raw))) {
    if (Array.isArray(keys)) order[provider] = keys.filter((key): key is string => typeof key === 'string');
  }
  return order;
}

const store = savedStore<AccountOrder>({ key: 'arbor.accounts.order.v1', parse: parseOrder, fallback: {} });

export const getAccountOrder = store.get;
export const useAccountOrder = store.useValue;

export function setAccountOrder(provider: string, keys: string[]) {
  store.set({ ...store.get(), [provider]: keys });
}

/** Swaps renamed keys in place so a credential keeps its position; a key already listed under its new name just drops the old one. */
export function renameOrderKeys(current: AccountOrder, renames: { from: string; to: string }[]): AccountOrder {
  let changed = false;
  const next = Object.fromEntries(Object.entries(current).map(([provider, keys]) => {
    let list = keys;
    for (const { from, to } of renames) {
      if (from === to || !list.includes(from)) continue;
      list = list.includes(to) ? list.filter((key) => key !== from) : list.map((key) => (key === from ? to : key));
      changed = true;
    }
    return [provider, list];
  }));
  return changed ? next : current;
}

export function renameAccountOrderKeys(renames: { from: string; to: string }[]) {
  store.set(renameOrderKeys(store.get(), renames));
}

/** Stable sort: keys present in `preferred` come first in that order, everything else keeps its original position. */
export function sortByOrder<T>(items: T[], preferred: string[] | undefined, keyOf: (item: T) => string): T[] {
  if (!preferred?.length) return items;
  const rank = new Map(preferred.map((key, index) => [key, index]));
  return items
    .map((item, index) => ({ item, index, rank: rank.get(keyOf(item)) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
}

/** Moves `from` so it lands where `to` currently is; unchanged when either key is missing. */
export function moveKey(keys: string[], from: string, to: string): string[] {
  const fromIndex = keys.indexOf(from);
  const toIndex = keys.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return keys;
  const next = [...keys];
  next.splice(fromIndex, 1);
  next.splice(toIndex, 0, from);
  return next;
}

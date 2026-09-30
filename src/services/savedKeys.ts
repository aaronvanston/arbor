/** Every key Arbor keeps in the window's storage starts with this. */
export const SAVED_KEY_PREFIX = 'arbor.';

/** Versions up to 1.0 kept their keys under the names of the app Arbor was forked from. */
const LEGACY_PREFIXES = ['cpa-gui.', 'easy-cli-proxy-api.'];

type KeyedStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Moves each key an earlier version saved under an old prefix to the same name under `arbor.`, so an update keeps the
 * window's settings and history. Runs before anything reads them. A key already under `arbor.` wins, since it's newer.
 */
export function renameLegacySavedKeys(storage?: KeyedStorage): void {
  let saved: KeyedStorage;
  let keys: string[];
  try {
    saved = storage ?? window.localStorage;
    keys = Array.from({ length: saved.length }, (_, index) => saved.key(index) ?? '');
  } catch {
    return; // Blocked storage has nothing to move.
  }
  for (const key of keys) {
    const prefix = LEGACY_PREFIXES.find((legacy) => key.startsWith(legacy));
    if (!prefix) continue;
    const renamed = SAVED_KEY_PREFIX + key.slice(prefix.length);
    try {
      const value = saved.getItem(key);
      const kept = saved.getItem(renamed);
      // The old key goes first, so a value near the storage limit still has room under its new name.
      saved.removeItem(key);
      if (value !== null && kept === null) saved.setItem(renamed, value);
    } catch {
      // A value that can't be moved starts over from its default, as it would with storage full.
    }
  }
}

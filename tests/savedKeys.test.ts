import { describe, expect, it } from 'bun:test';
import { renameLegacySavedKeys } from '../src/services/savedKeys';

/** A stand-in for localStorage that, like WebKit's, refuses a write taking it past `capacity` characters. */
function storage(initial: Record<string, string>, capacity = Infinity) {
  const values = new Map(Object.entries(initial));
  const used = () => [...values].reduce((total, [key, value]) => total + key.length + value.length, 0);
  return {
    values,
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (used() - (values.get(key)?.length ?? 0) + key.length + value.length > capacity) throw new Error('QuotaExceededError');
      values.set(key, value);
    },
    removeItem: (key: string) => void values.delete(key),
  };
}

describe('saved keys from versions up to 1.0', () => {
  it('move to the arbor prefix, a newer value already there wins, and other keys stay', () => {
    const saved = storage({
      'cpa-gui.preferences.v1': '{"appColor":"autumn"}',
      'easy-cli-proxy-api.theme': 'dark',
      'cpa-gui.sidebar.v1': '{"old":true}',
      'arbor.sidebar.v1': '{"new":true}',
      'someone-else.key': 'kept',
    });
    renameLegacySavedKeys(saved);
    expect(Object.fromEntries(saved.values)).toEqual({
      'arbor.preferences.v1': '{"appColor":"autumn"}',
      'arbor.theme': 'dark',
      'arbor.sidebar.v1': '{"new":true}',
      'someone-else.key': 'kept',
    });
  });

  it('move even when storage has no room for a second copy', () => {
    const history = 'x'.repeat(600);
    const saved = storage({ 'cpa-gui.alert-history.v1': history }, 1_000);
    renameLegacySavedKeys(saved);
    expect(Object.fromEntries(saved.values)).toEqual({ 'arbor.alert-history.v1': history });
  });
});

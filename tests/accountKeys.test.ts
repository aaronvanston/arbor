import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import { migrateAccountKeys, renamedCredentialKeys } from '../src/services/accountKeys';
import { accountFilesFromListing } from '../src/services/accountsStore';
import { getAccountOrder, renameOrderKeys, setAccountOrder } from '../src/services/accountOrder';
import { getAccountProfiles, saveAccountProfile } from '../src/services/accountProfiles';
import { getPlanCosts, setPlanCost } from '../src/services/planCosts';
import { getQuotaCacheSnapshot, updateQuotaCache } from '../src/services/quotaCache';
import { lastItem } from './support/items';

let originalWindow: PropertyDescriptor | undefined;
let ipcCalls: ReturnType<typeof mockCommands>;

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  ipcCalls = mockCommands({ rename_limit_history_accounts: () => 0 });
});

afterEach(() => {
  clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('account keys after the core renames a credential', () => {
  it('derives the old and new keys from file name and auth index', () => {
    expect(renamedCredentialKeys(
      { name: 'claude-cam.json', auth_index: 'idx-old' },
      { name: 'claude-5772b8d7-cam@example.com.json', auth_index: 'idx-new' },
    )).toEqual({ from: 'claude-cam.json::idx-old', to: 'claude-5772b8d7-cam@example.com.json::idx-new', name: 'claude-cam' });
  });

  it('keeps a renamed credential in its place in the saved order', () => {
    const order = { claude: ['a', 'old', 'b'], codex: ['x'] };
    expect(renameOrderKeys(order, [{ from: 'old', to: 'new' }])).toEqual({ claude: ['a', 'new', 'b'], codex: ['x'] });
    expect(renameOrderKeys({ claude: ['old', 'new'] }, [{ from: 'old', to: 'new' }])).toEqual({ claude: ['new'] });
    expect(renameOrderKeys(order, [{ from: 'missing', to: 'new' }])).toBe(order);
  });

  it('moves the profile, order, plan cost and cached limits to the new key', () => {
    const from = 'wp2-rename.json::idx-old';
    const to = 'wp2-renamed.json::idx-new';
    saveAccountProfile(from, { name: 'Work', color: 'teal' });
    setPlanCost(from, 180);
    setAccountOrder('wp2-provider', ['wp2-first.json::1', from, 'wp2-last.json::2']);
    updateQuotaCache((current) => ({ ...current, [from]: { status: 'success', rows: [], fetchedAt: 42 } }));

    migrateAccountKeys([{ from, to }]);

    expect(getAccountProfiles()[from]).toBeUndefined();
    expect(getAccountProfiles()[to]).toEqual({ name: 'Work', color: 'teal' });
    expect(getAccountOrder()['wp2-provider']).toEqual(['wp2-first.json::1', to, 'wp2-last.json::2']);
    expect(getQuotaCacheSnapshot()[from]).toBeUndefined();
    expect(getQuotaCacheSnapshot()[to]).toEqual({ status: 'success', rows: [], fetchedAt: 42 });
    expect(getPlanCosts()[from]).toBeUndefined();
    expect(getPlanCosts()[to]).toBe(180);
    expect(ipcCalls).toEqual([{ command: 'rename_limit_history_accounts', args: { renames: [{ from, to }] } }]);
  });

  it('never overwrites state already saved under the new key, and drops in-flight fetches', () => {
    const from = 'wp2-dupe.json::idx-old';
    const to = 'wp2-dupe-canonical.json::idx-new';
    saveAccountProfile(from, { name: 'Old' });
    saveAccountProfile(to, { name: 'Canonical' });
    updateQuotaCache((current) => ({
      ...current,
      [from]: { status: 'loading', rows: [] },
      'wp2-loading.json::idx-old': { status: 'loading', rows: [] },
      [to]: { status: 'error', rows: [], error: 'kept' },
    }));

    migrateAccountKeys([{ from, to }, { from: 'wp2-loading.json::idx-old', to: 'wp2-loading-new.json::idx-new' }]);

    expect(getAccountProfiles()[to]).toEqual({ name: 'Canonical' });
    expect(getAccountProfiles()[from]).toBeUndefined();
    expect(getQuotaCacheSnapshot()[to]).toEqual({ status: 'error', rows: [], error: 'kept' });
    // Nobody will finish a fetch for the new key, so it starts idle and gets refreshed.
    expect(getQuotaCacheSnapshot()['wp2-loading-new.json::idx-new']).toEqual({ status: 'idle', rows: [] });
  });

  it('keeps the name an account without a profile was known by, unless that name is an email', () => {
    expect(renamedCredentialKeys({ name: 'cam@example.com.json', auth_index: 'a' }, { name: 'new.json', auth_index: 'b' }))
      .toEqual({ from: 'cam@example.com.json::a', to: 'new.json::b' });
    const from = 'wp2-plain.json::idx-old';
    const to = 'wp2-plain-canonical.json::idx-new';
    migrateAccountKeys([{ from, to, name: 'wp2-plain' }]);
    expect(getAccountProfiles()[to]).toEqual({ name: 'wp2-plain' });
    expect(lastItem(ipcCalls)).toEqual({ command: 'rename_limit_history_accounts', args: { renames: [{ from, to }] } });
  });

  it('does not show the replaced file as an account while the core still lists it', () => {
    const canonical = { name: 'claude-5772b8d7-cam@example.com.json', provider: 'claude', source: 'file', path: '/auths/claude-5772b8d7-cam@example.com.json' };
    const lingering = { name: 'claude-cam.json', provider: 'claude', source: 'memory', path: '/auths/claude-cam.json' };
    const disabled = { name: 'codex-off.json', provider: 'codex', source: 'file', path: '/auths/codex-off.json', disabled: true };
    expect(accountFilesFromListing([canonical, lingering, disabled])).toEqual([canonical]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { coreReply, mockCommands } from '../src/dev/mock/answers';
import { ensureAccountsLoaded, getAccountsSnapshot, resetAccountsStore } from '../src/services/accountsStore';
import { updateQuotaCache } from '../src/services/quotaCache';
import type { AuthFile } from '../src/services/quotaService';

const account = (name: string): AuthFile =>
  ({ name: `${name}.json`, provider: 'claude', auth_index: name, source: 'file', account_type: 'oauth' }) as AuthFile;

let originalWindow: PropertyDescriptor | undefined;
let paths: string[];
let failListing: boolean;

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  paths = [];
  failListing = false;
  mockCommands({
    management_request: async ({ request }) => {
      paths.push(request.path);
      // Answered a moment later, as the core would, so the callers below overlap.
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (request.path === '/auth-files') {
        if (failListing) throw 'offline';
        return coreReply({ files: [account('work-load')] });
      }
      throw 'offline';
    },
  });
});

afterEach(() => {
  resetAccountsStore();
  updateQuotaCache((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith('work-load'))));
  clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('loading the accounts once', () => {
  it('lists them once when everything asks at the same time', async () => {
    // The sidebar, its limits, Home, its accounts and the limits monitor all ask as the core becomes ready.
    await Promise.all(Array.from({ length: 5 }, () => ensureAccountsLoaded()));
    expect(paths.filter((path) => path === '/auth-files')).toHaveLength(1);
    const limitChecks = paths.filter((path) => path === '/api-call').length;
    // As many limit checks as one caller alone makes.
    resetAccountsStore();
    updateQuotaCache((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith('work-load'))));
    paths = [];
    await ensureAccountsLoaded();
    expect(paths.filter((path) => path === '/api-call')).toHaveLength(limitChecks);
    expect(getAccountsSnapshot().files.map((file) => file.name)).toEqual(['work-load.json']);
  });

  it('doesn’t list them again once they’re loaded', async () => {
    await ensureAccountsLoaded();
    await ensureAccountsLoaded();
    expect(paths.filter((path) => path === '/auth-files')).toHaveLength(1);
  });

  it('lists them again after a listing that failed', async () => {
    failListing = true;
    await ensureAccountsLoaded();
    expect(getAccountsSnapshot().error).not.toBe('');
    failListing = false;
    await ensureAccountsLoaded();
    expect(paths.filter((path) => path === '/auth-files')).toHaveLength(2);
    expect(getAccountsSnapshot().files.map((file) => file.name)).toEqual(['work-load.json']);
  });
});

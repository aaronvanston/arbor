import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { coreReply, mockCommands } from '../src/dev/mock/answers';
import { pauseAccount, resumeAccount } from '../src/services/accountPause';
import { getAccountsSnapshot, resetAccountsStore } from '../src/services/accountsStore';
import { getQuotaCacheSnapshot, updateQuotaCache } from '../src/services/quotaCache';
import { quotaKey, type AuthFile } from '../src/services/quotaService';

type Request = { method: string; path: string; body?: unknown };

const account = (name: string, fields: Partial<AuthFile> = {}): AuthFile =>
  ({ name: `${name}.json`, provider: 'claude', auth_index: name, source: 'file', account_type: 'oauth', ...fields }) as AuthFile;

let originalWindow: PropertyDescriptor | undefined;
let requests: Request[];
let listing: AuthFile[];

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  requests = [];
  mockCommands({
    management_request: ({ request }) => {
      requests.push({ method: request.method, path: request.path, body: request.body });
      if (request.path === '/auth-files/status') {
        const { name, disabled } = request.body as { name: string; disabled: boolean };
        listing = listing.map((file) => (file.name === name ? { ...file, disabled } : file));
        return { ok: true };
      }
      if (request.path === '/auth-files') return coreReply({ files: listing });
      // Limit checks get nowhere here; which accounts they were for is what counts.
      throw 'offline';
    },
  });
});

afterEach(() => {
  // The store and cache are shared with the other suites, so these accounts leave them as they came.
  resetAccountsStore();
  updateQuotaCache((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !['work.json::work', 'home.json::home'].includes(key))));
  clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

/** Lets a limit refresh that was started and not awaited settle. */
const settle = async () => {
  for (let tick = 0; tick < 20 && Object.values(getQuotaCacheSnapshot()).some((quota) => quota?.status === 'loading'); tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

describe('pausing and resuming an account', () => {
  it('turns the account off in the core, then lists the accounts again', async () => {
    const work = account('work');
    listing = [work, account('home')];
    await pauseAccount(work);
    expect(requests).toEqual([
      { method: 'PATCH', path: '/auth-files/status', body: { name: 'work.json', disabled: true } },
      { method: 'GET', path: '/auth-files', body: undefined },
    ]);
    expect(getAccountsSnapshot().files.map((file) => file.name)).toEqual(['home.json']);
    expect(getAccountsSnapshot().disabled.map((file) => file.name)).toEqual(['work.json']);
    // Pausing by hand checks no limits.
    expect(requests.filter((request) => request.path === '/api-call')).toEqual([]);
  });

  it('turns it back on, lists the accounts again, and checks only that account’s limits', async () => {
    const work = account('work', { disabled: true });
    listing = [work, account('home')];
    await resumeAccount(quotaKey(work), work);
    expect(requests.slice(0, 2)).toEqual([
      { method: 'PATCH', path: '/auth-files/status', body: { name: 'work.json', disabled: false } },
      { method: 'GET', path: '/auth-files', body: undefined },
    ]);
    expect(getAccountsSnapshot().files.map((file) => file.name).sort()).toEqual(['home.json', 'work.json']);
    expect(getAccountsSnapshot().disabled).toEqual([]);
    const cache = getQuotaCacheSnapshot();
    expect(cache[quotaKey(work)]?.status).toBe('loading');
    expect(cache[quotaKey(account('home'))]?.status).not.toBe('loading');
    await settle();
  });

  it('stops at a refusal, leaving the listing as it was', async () => {
    const work = account('work');
    listing = [work];
    mockCommands({
      management_request: () => {
        throw { kind: 'core', status: 500, reason: 'mock store is read-only', message: 'Management API error (500): mock store is read-only' };
      },
    });
    await expect(pauseAccount(work)).rejects.toThrow('Management API error (500): mock store is read-only');
  });
});

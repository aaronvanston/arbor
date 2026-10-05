import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { coreReply, mockCommands } from '../src/dev/mock/answers';
import { getAccountReserves, setAccountReserve } from '../src/services/accountReserves';
import { resetAccountsStore } from '../src/services/accountsStore';
import { answerCliRequest } from '../src/services/cliBridge';
import { accountId, cliHandlers } from '../src/services/cliHandlers';
import { getRoutingAuto } from '../src/services/quotaRouting';
import { quotaKey, type AuthFile } from '../src/services/quotaService';

const account = (name: string, provider: string): AuthFile =>
  ({ name: `${name}.json`, provider, auth_index: name, source: 'file', account_type: 'oauth' }) as AuthFile;

const listing = [account('cam@example.com', 'claude'), account('cam-work@example.com', 'codex')];
const [claude] = listing;

let originalWindow: PropertyDescriptor | undefined;

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  mockCommands({
    management_request: ({ request }) => {
      if (request.path === '/auth-files') return coreReply({ files: listing });
      // Limit checks get nowhere here; the accounts themselves are what count.
      throw 'offline';
    },
  });
});

afterEach(() => {
  if (claude) setAccountReserve(quotaKey(claude), null);
  resetAccountsStore();
  clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

const ask = (action: string, args: Record<string, unknown> = {}) =>
  answerCliRequest(cliHandlers, { id: 'cli-1', action, args, confirm: false });

describe('the window’s account and routing actions for arbor', () => {
  it('list each account by an id that keeps its email and key out', async () => {
    const { result } = await ask('accounts.list');
    const listed = (result as { accounts: Array<Record<string, unknown>> }).accounts;
    expect(listed.map((row) => String(row.id)).sort()).toEqual(listing.map((file) => accountId(quotaKey(file))).sort());
    expect(listed.every((row) => !('key' in row))).toBe(true);
  });

  it('find an account by that id', async () => {
    if (!claude) throw new Error('no account');
    const { result, error } = await ask('accounts.cap', { account: accountId(quotaKey(claude)), percent: 40 });
    expect(error).toBeNull();
    expect(result).toMatchObject({ cap: 40 });
    expect(getAccountReserves().caps[quotaKey(claude)]).toBe(40);
  });

  it('keep routing to providers someone has signed in to', async () => {
    const { error } = await ask('routing.auto', { provider: 'nope', on: true });
    expect(error?.message).toContain('claude, codex');
    expect(getRoutingAuto()).not.toHaveProperty('nope');
  });
});

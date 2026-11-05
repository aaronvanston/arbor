import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { coreReply, mockCommands } from '../src/dev/mock/answers';
import { getAccountReserves, setAccountReserve } from '../src/services/accountReserves';
import { resetAccountsStore } from '../src/services/accountsStore';
import { answerCliRequest } from '../src/services/cliBridge';
import { accountId, cliHandlers } from '../src/services/cliHandlers';
import { DEFAULT_RESERVE, emptyAccessState, getReservePolicies, setModelAccess, setReservePolicy } from '../src/services/extraModelAccess';
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

describe('ChatGPT’s counts for Codex accounts, for arbor', () => {
  const work = { ...account('cam-work@example.com', 'codex'), id_token: { chatgpt_account_id: 'acct-1' } } as AuthFile;
  const again = { ...account('cam-work-2@example.com', 'codex'), auth_index: 'again', id_token: { chatgpt_account_id: 'acct-1' } } as AuthFile;
  const other = { ...account('cam-side@example.com', 'codex'), id_token: { chatgpt_account_id: 'acct-2' } } as AuthFile;

  beforeEach(() => {
    mockCommands({
      management_request: ({ request }) => {
        if (request.path === '/auth-files') return coreReply({ files: [listing[0], work, again, other] });
        if (request.path === '/api-call') {
          const body = request.body as { authIndex: string; url: string; header: Record<string, string> };
          if (!body.url.endsWith('/wham/profiles/me')) throw 'offline';
          if (body.authIndex === 'cam-side@example.com') return coreReply({ status_code: 401, body: JSON.stringify({ detail: 'Unauthorized' }) });
          // The token stays a placeholder the core fills in.
          expect(body.header.Authorization).toBe('Bearer $TOKEN$');
          return coreReply({ status_code: 200, body: JSON.stringify({ stats: { lifetime_tokens: 1_000, daily_usage_buckets: [] } }) });
        }
        throw 'offline';
      },
    });
  });

  it('read every Codex account, count a ChatGPT account signed in twice once, and keep a failure on its row', async () => {
    const { result, error } = await ask('accounts.codexProfile');
    expect(error).toBeNull();
    const { lifetimeTokens, accounts } = result as { lifetimeTokens: number; accounts: Array<{ id: string; profile: unknown; error: string | null }> };
    expect(accounts).toHaveLength(3);
    expect(lifetimeTokens).toBe(1_000);
    expect(accounts.filter((row) => row.error !== null)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('acct-1');
  });
});

describe('extra models on only some accounts, for arbor', () => {
  const work = listing[1];
  const side = account('cam-side@example.com', 'codex');
  const model = 'gpt-preview-latest';

  beforeEach(() => {
    mockCommands({
      management_request: ({ request }) => {
        if (request.path === '/auth-files') return coreReply({ files: [...listing, side] });
        throw 'offline';
      },
    });
    setModelAccess({
      ...emptyAccessState(),
      providers: { codex: { models: [model], accounts: ['cam-side@example.com.json', 'cam-work@example.com.json'], checkedAtMs: 1 } },
      access: { 'cam-work@example.com.json': { [model]: 'yes' }, 'cam-side@example.com.json': { [model]: 'no' } },
      usage: { [`codex/${model}`]: { readAtMs: 1, byAccount: { 'cam-work@example.com.json': 12 }, tokens: { 'cam-work@example.com.json': 12_000 } } },
    });
  });

  afterEach(() => {
    setModelAccess(emptyAccessState());
    setReservePolicy('codex', model, DEFAULT_RESERVE);
  });

  it('list which accounts have each, by id, and the reserve kept for it', async () => {
    if (!work) throw new Error('no account');
    const { result, error } = await ask('extraModels.access');
    expect(error).toBeNull();
    const [codex] = (result as { providers: Array<{ provider: string; models: Array<Record<string, unknown>> }> }).providers;
    expect(codex?.provider).toBe('codex');
    expect(codex?.models[0]).toMatchObject({
      model,
      have: [{ id: accountId(quotaKey(work)) }],
      lack: [{ id: accountId(quotaKey(side)) }],
      mode: 'auto',
      percent: 10,
      lend: 'floor',
      requestsThisWeek: 12,
      // No limit reading yet, so no reserve to size.
      reserves: [],
    });
  });

  it('set the reserve, only for a model Arbor has checked', async () => {
    expect((await ask('extraModels.reserve', { provider: 'codex', model, mode: 'sometimes' })).error?.message).toContain('auto, fixed, never, only');
    expect((await ask('extraModels.reserve', { provider: 'codex', model, lend: 'maybe' })).error?.message).toContain('floor, all, hold');
    expect((await ask('extraModels.reserve', { provider: 'codex', model })).error?.message).toContain('Give a mode');
    expect((await ask('extraModels.reserve', { provider: 'codex', model: 'gpt-nope', mode: 'never' })).error?.message).toContain('extraModels.access');
    const { result, error } = await ask('extraModels.reserve', { provider: 'codex', model, mode: 'fixed', percent: 80, lend: 'hold' });
    expect(error).toBeNull();
    // A fixed share is held to what the page allows.
    expect(result).toEqual({ provider: 'codex', model, mode: 'fixed', percent: 50, lend: 'hold', accountsChanged: 0 });
    expect(getReservePolicies()).toEqual({ [`codex/${model}`]: { mode: 'fixed', percent: 50, lend: 'hold' } });
  });
});

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  CODEX_UNSETTLED_REDEEM_MS, codexConsumeOutcome, codexRedeemRequestId, nextCodexResetCredit,
  rememberCodexRedeem, settleCodexRedeem, unsettledCodexRedeem,
} from '../src/services/codexResetRedeem';
import { managementApi } from '../src/services/managementApi';
import { resetCodexQuotaWithConfirmation } from '../src/services/quotaActions';
import { getQuotaCacheSnapshot, updateQuotaCache } from '../src/services/quotaCache';
import { consumeCodexResetCredit, quotaKey, type AuthFile } from '../src/services/quotaService';
import { itemAt } from './support/items';

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const credit = (overrides: Record<string, unknown> = {}) => ({
  id: 'rlrc_soon', reset_type: 'codex_rate_limits', status: 'available',
  expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), ...overrides,
});

describe('naming a Codex reset redemption', () => {
  it('gives the same account and credit the same id, and T3 Code’s id for them', async () => {
    const id = await codexRedeemRequestId('acct-test', 'rlrc_1');
    expect(id).toMatch(UUID_V5);
    expect(await codexRedeemRequestId('acct-test', 'rlrc_1')).toBe(id);
    // What T3 Code's creditRedeemRequestId sends for the same account and credit.
    expect(id).toBe('7dd5be0d-85ab-5b8a-b7d1-94699d26dce2');
    expect(await codexRedeemRequestId('ünï', 'crédit')).toBe('89685881-9dac-5c66-a91e-3c69dc91b870');
  });

  it('gives a different credit or account a different id', async () => {
    const id = await codexRedeemRequestId('acct-test', 'rlrc_1');
    expect(await codexRedeemRequestId('acct-test', 'rlrc_2')).not.toBe(id);
    expect(await codexRedeemRequestId('acct-other', 'rlrc_1')).not.toBe(id);
  });

  it('picks the available credit that expires soonest, preferring ones that apply now', () => {
    const now = Date.parse('2030-01-10T00:00:00Z');
    const at = (day: number) => `2030-01-${String(day).padStart(2, '0')}T00:00:00Z`;
    expect(nextCodexResetCredit({
      credits: [
        credit({ id: 'later', expires_at: at(20) }),
        credit({ id: 'soonest-but-not-applicable', expires_at: at(11), applicable: false }),
        credit({ id: 'expired', expires_at: at(9) }),
        credit({ id: 'used', status: 'redeemed', expires_at: at(12) }),
        credit({ id: 'other-kind', reset_type: 'other', expires_at: at(12) }),
        credit({ id: '', expires_at: at(12) }),
        credit({ id: 'soon', expires_at: at(15) }),
      ],
    }, now)).toEqual({ id: 'soon', expiresAt: at(15) });
    expect(nextCodexResetCredit({ credits: [credit({ id: 'only', expires_at: at(11), applicable: false })] }, now))
      .toEqual({ id: 'only', expiresAt: at(11) });
    // Codex lists some credits without an expiry: spent after any that expire, never skipped.
    expect(nextCodexResetCredit({
      credits: [credit({ id: 'forever', expires_at: null }), credit({ id: 'unreadable', expires_at: 'soon' }), credit({ id: 'soon', expires_at: at(15) })],
    }, now)).toEqual({ id: 'soon', expiresAt: at(15) });
    expect(nextCodexResetCredit({ credits: [credit({ id: 'forever', expires_at: null }), credit({ id: 'unreadable', expires_at: 'soon' })] }, now))
      .toEqual({ id: 'forever', expiresAt: '' });
    expect(nextCodexResetCredit({ credits: [] }, now)).toBeUndefined();
    expect(nextCodexResetCredit({ available_count: 2 }, now)).toBeUndefined();
  });

  it('reads Codex’s answer and nothing else', () => {
    for (const code of ['reset', 'already_redeemed', 'nothing_to_reset', 'no_credit']) {
      expect(codexConsumeOutcome({ code })).toBe(code as never);
    }
    expect(codexConsumeOutcome({ code: 'something_new' })).toBeUndefined();
    expect(codexConsumeOutcome({})).toBeUndefined();
    expect(codexConsumeOutcome('reset')).toBeUndefined();
  });

  it('keeps an unconfirmed redemption for a while, and on disk when it can', () => {
    const saved = new Map<string, string>();
    const storage = globalThis as { localStorage?: unknown };
    const previous = storage.localStorage;
    storage.localStorage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) };
    try {
      const redeem = { requestId: '7dd5be0d-85ab-5b8a-b7d1-94699d26dce2', creditId: 'rlrc_1', atMs: 1_000 };
      rememberCodexRedeem('acct-disk', redeem, 1_000);
      expect(JSON.parse(saved.get('cpa-gui.codex-unsettled-redeems.v1')!)).toEqual({ 'acct-disk': redeem });
      expect(unsettledCodexRedeem('acct-disk', 1_000 + CODEX_UNSETTLED_REDEEM_MS - 1)).toEqual(redeem);
      expect(unsettledCodexRedeem('acct-disk', 1_000 + CODEX_UNSETTLED_REDEEM_MS)).toBeUndefined();
      // Anything else found there is not resent.
      saved.set('cpa-gui.codex-unsettled-redeems.v1', JSON.stringify({ 'acct-disk': { requestId: 'not-a-uuid', atMs: 1_000 } }));
      expect(unsettledCodexRedeem('acct-disk', 1_000)).toBeUndefined();
      rememberCodexRedeem('acct-disk', redeem, 1_000);
      settleCodexRedeem('acct-disk');
      expect(unsettledCodexRedeem('acct-disk', 1_000)).toBeUndefined();
    } finally {
      storage.localStorage = previous;
    }
  });
});

type Request = { url: string; method: string; header: Record<string, string>; data?: string; authIndex: string };
type Call = { path: string; body: Request & { auth_index?: string }; options?: unknown };
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const CONSUME_URL = `${CREDITS_URL}/consume`;
const success = (body: unknown) => ({ status_code: 200, body: JSON.stringify(body) });
const codexUsage = {
  rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000 } },
  rate_limit_reset_credits: { available_count: 2, applicable_available_count: 2 },
};

let post: ReturnType<typeof spyOn>;
let calls: Call[];
let fileCount = 0;
let creditList: () => unknown;
let consumeReply: (request: Request) => unknown;
let clearReply: () => unknown;

const codexFile = (): AuthFile => {
  fileCount += 1;
  return {
    name: `codex-redeem-${fileCount}.json`, provider: 'codex', auth_index: `cr-${fileCount}`,
    metadata: { id_token: { chatgpt_account_id: `acct-${fileCount}` } },
  };
};
const consumes = () => calls.filter((call) => call.body.url === CONSUME_URL).map((call) => JSON.parse(call.body.data!));
const clears = () => calls.filter((call) => call.path === '/reset-quota');

beforeEach(() => {
  calls = [];
  creditList = () => success({ credits: [credit({ id: 'rlrc_later', expires_at: new Date(Date.now() + 9 * 86_400_000).toISOString() }), credit()] });
  consumeReply = () => success({ code: 'reset' });
  clearReply = () => ({ status: 'ok', models: [] });
  post = spyOn(managementApi, 'post').mockImplementation(async (path, body, options) => {
    const request = body as unknown as Call['body'];
    calls.push({ path, body: request, options });
    if (path === '/reset-quota') return { ...clearReply() as object, auth_index: request.auth_index } as never;
    expect(path).toBe('/api-call');
    if (request.url === USAGE_URL) return success(codexUsage) as never;
    if (request.url === CREDITS_URL) return creditList() as never;
    if (request.url === CONSUME_URL) return consumeReply(request) as never;
    throw new Error('Unexpected API request ' + request.url);
  });
});
afterEach(() => post.mockRestore());

describe('using a Codex reset credit', () => {
  it('redeems the soonest credit under an id derived from it, then lets the proxy route the account again', async () => {
    const file = codexFile();
    const result = await consumeCodexResetCredit(file);
    expect(result).toMatchObject({
      status: 'success', actionResult: { action: 'reset', status: 'success', message: 'Limits reset and quota refreshed.' },
    });
    expect(result.actionResult?.warning).toBeUndefined();
    const consume = calls.find((call) => call.body.url === CONSUME_URL)!;
    expect(consume.body.method).toBe('POST');
    expect(consume.body.header['Chatgpt-Account-Id']).toBe(`acct-${fileCount}`);
    expect(consume.options).toEqual({ timeoutMs: 25000 });
    expect(JSON.parse(consume.body.data!)).toEqual({
      redeem_request_id: await codexRedeemRequestId(`acct-${fileCount}`, 'rlrc_soon'),
      credit_id: 'rlrc_soon',
    });
    // Read the credits, redeemed one, told the core, then read the quota again.
    expect(calls.slice(0, 3).map((call) => call.body.url ?? call.path)).toEqual([CREDITS_URL, CONSUME_URL, '/reset-quota']);
    expect(itemAt(clears(), 0).body).toEqual({ auth_index: `cr-${fileCount}` } as never);
    expect(calls.slice(3).map((call) => call.body.url).sort()).toEqual([CREDITS_URL, USAGE_URL].sort());
  });

  it('names a redemption by the auth index when the login has no account id or file name', async () => {
    await consumeCodexResetCredit({ provider: 'codex', auth_index: 'cr-unnamed' });
    expect(consumes()[0].redeem_request_id).toBe(await codexRedeemRequestId('cr-unnamed', 'rlrc_soon'));
  });

  it('counts a credit already redeemed as a reset and still tells the proxy', async () => {
    consumeReply = () => success({ code: 'already_redeemed' });
    const result = await consumeCodexResetCredit(codexFile());
    expect(result.actionResult).toMatchObject({ status: 'success', message: 'That reset had already gone through. Quota was refreshed.' });
    expect(clears()).toHaveLength(1);
  });

  it.each([
    ['nothing_to_reset', 'The limits don’t need a reset right now. Nothing was used.'],
    ['no_credit', 'There’s no reset left to use on this account. Nothing was used.'],
  ])('reports %s as nothing used and leaves the proxy alone', async (code, message) => {
    consumeReply = () => success({ code });
    const result = await consumeCodexResetCredit(codexFile());
    expect(result).toMatchObject({ status: 'success', actionResult: { status: 'not-used', message } });
    expect(clears()).toHaveLength(0);
  });

  it('still reports the reset when the proxy couldn’t be told, with a warning', async () => {
    clearReply = () => { throw new Error('Management API error (500): failed to reset quota'); };
    const result = await consumeCodexResetCredit(codexFile());
    expect(result.actionResult).toMatchObject({
      status: 'success',
      message: 'Limits reset and quota refreshed.',
      warning: 'Reset used, but Arbor couldn’t tell the proxy yet. It will route again when its cooldown ends.',
    });
  });

  it('resends an unconfirmed redemption unchanged, even once its credit has left the list', async () => {
    const file = codexFile();
    consumeReply = () => { throw new Error('Management API error (502): request failed'); };
    const first = await consumeCodexResetCredit(file);
    expect(first.actionResult).toMatchObject({
      status: 'error',
      message: 'Couldn’t confirm the reset went through (Management API error (502): request failed). Refresh in a moment; if the limits weren’t refilled, try again.',
    });
    // It went through: the credit is spent, so the list now offers the next one.
    creditList = () => success({ credits: [credit({ id: 'rlrc_later' })] });
    consumeReply = () => success({ code: 'something_new' });
    const second = await consumeCodexResetCredit(file);
    expect(second.actionResult).toMatchObject({ status: 'error', message: 'Still couldn’t confirm the reset. Nothing more was used. Refresh in a few minutes to see if the limits were refilled.' });
    consumeReply = () => success({ code: 'already_redeemed' });
    const third = await consumeCodexResetCredit(file);
    expect(third.actionResult).toMatchObject({ status: 'success', message: 'Your earlier reset went through after all. Quota was refreshed.' });
    consumeReply = () => success({ code: 'reset' });
    await consumeCodexResetCredit(file);
    const sent = consumes();
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[2]).toEqual(sent[0]);
    expect(sent[0].credit_id).toBe('rlrc_soon');
    // Settled, so the next redemption is of the credit now listed.
    expect(sent[3]).toEqual({ redeem_request_id: await codexRedeemRequestId(`acct-${fileCount}`, 'rlrc_later'), credit_id: 'rlrc_later' });
    expect(clears()).toHaveLength(2);
  });

  it('keeps an unconfirmed redemption to its own login when seats of one workspace share the account id', async () => {
    // Two people's logins in one ChatGPT Team workspace: the id token names the workspace, the same for both.
    const seat = (id: string): AuthFile => ({
      name: `codex-${id}.json`, provider: 'codex', auth_index: id,
      metadata: { id_token: { chatgpt_account_id: 'ws-team' } },
    });
    const seatA = seat('seat-a');
    const seatB = seat('seat-b');
    creditList = () => success({ credits: [credit({ id: 'rlrc_seat-a' })] });
    consumeReply = () => { throw new Error('Management API error (502): request failed'); };
    expect((await consumeCodexResetCredit(seatA)).actionResult?.status).toBe('error');
    // Seat B's reset reads its own credits and redeems its own, never seat A's lost try.
    calls = [];
    creditList = () => success({ credits: [credit({ id: 'rlrc_seat-b' })] });
    consumeReply = () => success({ code: 'reset' });
    const b = await consumeCodexResetCredit(seatB);
    expect(b.actionResult).toMatchObject({ status: 'success', message: 'Limits reset and quota refreshed.' });
    expect(calls.slice(0, 3).map((call) => [call.body.url ?? call.path, call.body.authIndex ?? call.body.auth_index]))
      .toEqual([[CREDITS_URL, 'seat-b'], [CONSUME_URL, 'seat-b'], ['/reset-quota', 'seat-b']]);
    expect(consumes()).toEqual([{ redeem_request_id: await codexRedeemRequestId('ws-team', 'rlrc_seat-b'), credit_id: 'rlrc_seat-b' }]);
    // Seat A's try is still there to resend, unchanged, through seat A.
    calls = [];
    consumeReply = () => success({ code: 'already_redeemed' });
    const a = await consumeCodexResetCredit(seatA);
    expect(a.actionResult?.message).toBe('Your earlier reset went through after all. Quota was refreshed.');
    expect(consumes()).toEqual([{ redeem_request_id: await codexRedeemRequestId('ws-team', 'rlrc_seat-a'), credit_id: 'rlrc_seat-a' }]);
    expect(calls.find((call) => call.body.url === CONSUME_URL)?.body.authIndex).toBe('seat-a');
  });

  it('lets Codex pick the credit when the list can’t be read, and resends that id on a retry', async () => {
    const file = codexFile();
    creditList = () => ({ status_code: 503, body: 'overloaded' });
    consumeReply = () => ({ status_code: 502, body: 'bad gateway' });
    expect((await consumeCodexResetCredit(file)).actionResult).toMatchObject({ status: 'error', message: expect.stringContaining('(bad gateway)') });
    creditList = () => success({ credits: [credit()] });
    consumeReply = () => success({ code: 'reset' });
    expect((await consumeCodexResetCredit(file)).actionResult?.status).toBe('success');
    const [first, second] = consumes();
    expect(first.credit_id).toBeUndefined();
    expect(first.redeem_request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toEqual(first);
  });

  it('reports a refused redemption as nothing used, and doesn’t count it as a try to repeat', async () => {
    const file = codexFile();
    consumeReply = () => ({ status_code: 429, body: 'slow down' });
    expect((await consumeCodexResetCredit(file)).actionResult)
      .toMatchObject({ status: 'not-used', message: expect.stringContaining('limiting requests') });
    consumeReply = () => ({ status_code: 403, body: 'forbidden' });
    expect((await consumeCodexResetCredit(file)).actionResult)
      .toMatchObject({ status: 'not-used', message: expect.stringContaining('didn’t accept this login') });
    consumeReply = () => success({ code: 'no_credit' });
    expect((await consumeCodexResetCredit(file)).actionResult?.message).toBe('There’s no reset left to use on this account. Nothing was used.');
    expect(clears()).toHaveLength(0);
  });

  it('shows the warning on the account through the reset action', async () => {
    const file = codexFile();
    updateQuotaCache((current) => ({
      ...current,
      [quotaKey(file)]: { status: 'success', rows: [{ label: '5-hour window', remainingPercent: 0 }], resetCredits: 2, resetCreditsApplicable: 2 },
    }));
    clearReply = () => { throw new Error('connection refused'); };
    expect(await resetCodexQuotaWithConfirmation(file, async () => true)).toBe('success');
    expect(getQuotaCacheSnapshot()[quotaKey(file)]?.actionResult).toMatchObject({
      status: 'success', warning: expect.stringContaining('couldn’t tell the proxy'),
    });
  });
});

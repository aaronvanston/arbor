import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from 'bun:test';
import { managementApi } from '../src/services/managementApi';
import { canResetClaudeQuota, resetClaudeQuotaWithConfirmation } from '../src/services/quotaActions';
import { getQuotaCacheSnapshot, updateQuotaCache } from '../src/services/quotaCache';
import {
  claimClaudeBankedReset, claudeBankedResetFor, loadQuota, quotaKey, quotaRowsFor, type AuthFile,
} from '../src/services/quotaService';
import { itemAt, present } from './support/items';

const NOW = Date.parse('2030-01-10T00:00:00Z');
const grant = (overrides: Record<string, unknown> = {}) => ({
  id: 'launch_week', label: 'Launch week', resets_total: 3, resets_left: 2,
  starts_at: '2030-01-01T00:00:00Z', ends_at: '2030-01-20T00:00:00Z',
  clears: ['five_hour', 'seven_day'], paused: false, usable_now: true, use_requires_limit: true,
  percent_used: { five_hour: 100, seven_day: 40 }, blocking: [], ...overrides,
});
const status = (overrides: Record<string, unknown> = {}, grants: unknown[] = [grant()]) => ({
  five_hour: { utilization: 100, resets_at: '2030-01-10T02:00:00Z' },
  cedar_ember: {
    eligible: true, next_grant_id: 'launch_week', exhausted: ['five_hour'],
    weekly_resets_at: '2030-01-14T00:00:00Z', cooldown_until: null, grants, ...overrides,
  },
});

describe('reading Claude banked resets', () => {
  it('offers nothing when the block is missing, malformed or the account is not eligible', () => {
    expect(claudeBankedResetFor({ five_hour: {} }, NOW)).toEqual({});
    expect(claudeBankedResetFor({ cedar_ember: { grants: [grant()] } }, NOW)).toEqual({});
    expect(claudeBankedResetFor(status({ eligible: false, ineligible_reason: 'tier' }), NOW)).toEqual({});
    expect(claudeBankedResetFor('not json', NOW)).toEqual({});
  });

  it('reports the reset that can be used at a limit, what it refills and when it must be used', () => {
    expect(claudeBankedResetFor(JSON.stringify(status()), NOW)).toEqual({
      resetCredits: 2,
      resetCreditsEarliestExpiry: '2030-01-20T00:00:00Z',
      bankedReset: {
        grantId: 'launch_week',
        refills: '5-hour window and 7-day window',
        weeklyResetsAt: '2030-01-14T00:00:00Z',
      },
    });
  });

  it('names every cap it refills the way its row on the Accounts page does', () => {
    const refills = (clears: unknown[]) =>
      claudeBankedResetFor(status({}, [grant({ clears })]), NOW).bankedReset?.refills;
    expect(refills(['seven_day_cowork', 'seven_day_omelette', 'seven_day_oauth_apps']))
      .toBe('7-day Cowork window, 7-day Omelette window and 7-day OAuth apps window');
    // A cap Claude Code doesn't know yet, and the 7-day limit under its other name, said once.
    expect(refills(['five_hour', 'seven_day', 'seven_day_overage_included', 'seven_day_deep_research']))
      .toBe('5-hour window, 7-day window and 7-day Deep Research window');
    // Nothing that isn't a window, and no raw field names.
    expect(refills(['weekly_scoped', 'seven_day_', 'Seven_Day_Opus', 7, 'five_hour'])).toBe('5-hour window');
    // Word for word what the rows say.
    const rows = quotaRowsFor('claude', {
      seven_day_cowork: { utilization: 1 }, seven_day_omelette: { utilization: 1 },
      seven_day_oauth_apps: { utilization: 1 }, seven_day_deep_research: { utilization: 1 },
    }).map((row) => row.label);
    for (const clears of ['seven_day_cowork', 'seven_day_omelette', 'seven_day_oauth_apps', 'seven_day_deep_research']) {
      expect(rows).toContain(refills([clears])!);
    }
  });

  it('warns before spending a reset that works without a limit early', () => {
    const anytime = (overrides: Record<string, unknown>) =>
      claudeBankedResetFor(status({ exhausted: [] }, [grant({ use_requires_limit: false, ...overrides })]), NOW).bankedReset?.earlyUse;
    expect(anytime({ percent_used: { five_hour: 22, seven_day: 58 } })).toEqual({ percentLeft: 42, limit: '7-day window' });
    expect(anytime({ percent_used: {} })).toEqual({});
    expect(anytime({ percent_used: { seven_day_cowork: 90 } })).toEqual({});
    // A newer cap it refills, used the most, is the one named.
    expect(anytime({ clears: ['five_hour', 'seven_day_omelette'], percent_used: { five_hour: 22, seven_day_omelette: 70 } }))
      .toEqual({ percentLeft: 30, limit: '7-day Omelette window' });
    // Claude Code's own limits win a tie.
    expect(anytime({ clears: ['seven_day_deep_research', 'seven_day'], percent_used: { seven_day_deep_research: 58, seven_day: 58 } }))
      .toEqual({ percentLeft: 42, limit: '7-day window' });
    // At a limit the reset refills, it is not early.
    expect(claudeBankedResetFor(status({}, [grant({ use_requires_limit: false })]), NOW).bankedReset?.earlyUse).toBeUndefined();
  });

  it('explains why resets left cannot be used now', () => {
    const reason = (grantOverrides: Record<string, unknown>, statusOverrides: Record<string, unknown> = {}) =>
      claudeBankedResetFor(status(statusOverrides, [grant({ usable_now: false, ...grantOverrides })]), NOW).bankedReset;
    expect(reason({ blocking: ['seven_day'] })?.blockedReason).toBe('It doesn’t refill the 7-day window, so it can’t be used until that resets');
    // Every cap the rows show is named, not passed over for a vaguer reason.
    expect(reason({ blocking: ['seven_day_cowork'] })?.blockedReason).toBe('It doesn’t refill the 7-day Cowork window, so it can’t be used until that resets');
    expect(reason({ blocking: ['seven_day_oauth_apps'] })?.blockedReason).toBe('It doesn’t refill the 7-day OAuth apps window, so it can’t be used until that resets');
    expect(reason({ blocking: ['seven_day_omelette'] })?.blockedReason).toBe('It doesn’t refill the 7-day Omelette window, so it can’t be used until that resets');
    expect(reason({ blocking: ['seven_day_deep_research'] })?.blockedReason).toBe('It doesn’t refill the 7-day Deep Research window, so it can’t be used until that resets');
    expect(reason({ blocking: ['weekly_scoped'] })?.blockedReason).toBe('Saved for when this account reaches a usage limit');
    expect(reason({ paused: true })?.blockedReason).toBe('Banked resets are paused right now');
    expect(reason({}, { cooldown_until: '2030-01-10T00:01:00Z' })?.blockedReason).toContain('Another reset just ran');
    expect(reason({})?.blockedReason).toBe('Saved for when this account reaches a usage limit');
    expect(reason({ use_requires_limit: false })?.blockedReason).toBe('It can’t be used right now. Try again later');
    expect(reason({})?.grantId).toBeUndefined();
    // A paused next grant is not offered even if marked usable.
    expect(claudeBankedResetFor(status({}, [grant({ paused: true })]), NOW).bankedReset?.grantId).toBeUndefined();
  });

  it('counts only live grants, drops malformed ones and never offers a grant it could not read', () => {
    const result = claudeBankedResetFor(status({ next_grant_id: 'bad id' }, [
      grant({ id: 'expired', ends_at: '2030-01-05T00:00:00Z' }),
      grant({ id: 'later', resets_left: 1, ends_at: '2030-02-01T00:00:00Z', usable_now: false }),
      grant({ id: 'sooner', resets_left: 3, ends_at: '2030-01-15T00:00:00Z', usable_now: false }),
      grant({ id: 'spent', resets_left: 0 }),
      grant({ id: 'bad id' }),
      grant({ id: 'negative', resets_left: -1 }),
      grant({ id: 'fraction', resets_left: 1.5 }),
      grant({ id: 'missing', resets_left: undefined }),
    ]), NOW);
    expect(result.resetCredits).toBe(4);
    expect(result.resetCreditsEarliestExpiry).toBe('2030-01-15T00:00:00Z');
    expect(result.bankedReset?.grantId).toBeUndefined();
    expect(result.bankedReset?.blockedReason).toBe('Saved for when this account reaches a usage limit');
    // An eligible account with nothing left shows zero, not nothing.
    expect(claudeBankedResetFor(status({}, []), NOW)).toMatchObject({ resetCredits: 0, bankedReset: {} });
  });

  it('treats an unavailable service as a failed check and names a client refusal', () => {
    expect(claudeBankedResetFor(status({ eligible: false, ineligible_reason: 'unavailable' }), NOW).error)
      .toBe('Claude couldn’t check banked resets right now');
    expect(claudeBankedResetFor(status({ eligible: false, ineligible_reason: 'surface' }), NOW)).toEqual({
      resetCredits: 2,
      resetCreditsEarliestExpiry: '2030-01-20T00:00:00Z',
      bankedReset: { blockedReason: 'Claude isn’t offering these to Arbor (surface)' },
    });
    expect(claudeBankedResetFor(status({ eligible: false, ineligible_reason: 'surface' }, []), NOW)).toEqual({});
  });
});

type Request = { url: string; method: string; header: Record<string, string>; data?: string; authIndex: string };
const success = (body: unknown) => ({ status_code: 200, body });
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const BANKED_URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1';
const ORG = '5f0c1a2e-8d7b-4c3a-9e21-0b6d4f8a7c11';
const CLAIM_URL = `https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`;
const future = (ms: number) => new Date(Date.now() + ms).toISOString();
const liveStatus = (overrides: Record<string, unknown> = {}, grants: unknown[] = [grant({ ends_at: future(86_400_000) })]) =>
  status({ weekly_resets_at: future(3 * 86_400_000), ...overrides }, grants);

let post: Mock<typeof managementApi.post>;
let calls: Request[];
let fileCount = 0;
let bankedStatus: () => unknown;
let claimReply: (request: Request) => unknown;

const claudeFile = (): AuthFile => ({ name: `claude-banked-${++fileCount}.json`, provider: 'claude', auth_index: `cb-${fileCount}` });
const claims = () => calls.filter((request) => request.url === CLAIM_URL);

beforeEach(() => {
  calls = [];
  bankedStatus = () => success(liveStatus());
  claimReply = () => success({ result: 'reset', resets_left: 1, cleared: ['five_hour'] });
  post = spyOn(managementApi, 'post').mockImplementation(async (path, body) => {
    expect(path).toBe('/api-call');
    const request = body as unknown as Request;
    calls.push(request);
    if (request.url === USAGE_URL) return success({ five_hour: { utilization: 100 } }) as never;
    if (request.url === PROFILE_URL) return success({ account: { has_claude_max: true }, organization: { uuid: ORG } }) as never;
    if (request.url === BANKED_URL) return bankedStatus() as never;
    if (request.url === CLAIM_URL) return claimReply(request) as never;
    throw new Error('Unexpected API request ' + request.url);
  });
});
afterEach(() => post.mockRestore());

describe('checking Claude banked resets with the quota', () => {
  it('reads them the way Claude Code does, beside the usual usage request', async () => {
    const result = await loadQuota(claudeFile());
    expect(result).toMatchObject({
      status: 'success', plan: 'Max', resetCredits: 2,
      bankedReset: { grantId: 'launch_week', refills: '5-hour window and 7-day window' },
    });
    expect(result.resetCreditsApplicable).toBeUndefined();
    expect(calls.map((request) => request.url).sort()).toEqual([BANKED_URL, PROFILE_URL, USAGE_URL].sort());
    const banked = calls.find((request) => request.url === BANKED_URL)!;
    expect(banked.method).toBe('GET');
    expect(banked.header).toEqual({
      Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-cli/2.1.280 (external, cli)',
    });
    expect(itemAt(post.mock.calls, calls.indexOf(banked))[2]).toEqual({ timeoutMs: 8000 });
    // The usual usage request is unchanged.
    expect(calls.find((request) => request.url === USAGE_URL)?.header['User-Agent']).toBeUndefined();
  });

  it('stays quiet about a failed check until the account has been offered banked resets', async () => {
    const file = claudeFile();
    bankedStatus = () => ({ status_code: 503, body: 'overloaded' });
    expect(await loadQuota(file)).toMatchObject({ status: 'success', resetCreditsError: undefined, resetCredits: undefined });
    bankedStatus = () => success({ unexpected: true });
    expect((await loadQuota(file)).resetCreditsError).toBeUndefined();
    bankedStatus = () => success(liveStatus());
    expect((await loadQuota(file)).resetCredits).toBe(2);
    bankedStatus = () => ({ status_code: 503, body: 'overloaded' });
    expect(await loadQuota(file)).toMatchObject({ status: 'success', resetCreditsError: 'overloaded', resetCredits: undefined });
    bankedStatus = () => success({ unexpected: true });
    expect((await loadQuota(file)).resetCreditsError).toBe('The banked resets check returned unrecognized data');
    // Once a check says none are offered, the account is quiet again.
    bankedStatus = () => success({ five_hour: {} });
    expect((await loadQuota(file)).resetCreditsError).toBeUndefined();
    bankedStatus = () => ({ status_code: 503, body: 'overloaded' });
    expect((await loadQuota(file)).resetCreditsError).toBeUndefined();
  });
});

describe('claiming a Claude banked reset', () => {
  it('claims the confirmed reset for the account’s organization, then refreshes', async () => {
    const result = await claimClaudeBankedReset(claudeFile(), { grantId: 'launch_week', earlyUse: false });
    expect(result).toMatchObject({ status: 'success', actionResult: { action: 'reset', status: 'success' } });
    expect(result.actionResult?.message).toStartWith('Limits reset and quota refreshed. The weekly limit still resets ');
    const claim = itemAt(claims(), 0);
    expect(claim.method).toBe('POST');
    expect(claim.header['User-Agent']).toBe('claude-cli/2.1.280 (external, cli)');
    expect(claim.header['anthropic-beta']).toBe('oauth-2025-04-20');
    const body = JSON.parse(claim.data!);
    expect(body).toEqual({ program: 'cedar_ember', grant_id: 'launch_week', request_id: body.request_id });
    expect(body.request_id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(itemAt(post.mock.calls, calls.indexOf(claim))[2]).toEqual({ timeoutMs: 25000 });
    // Checked the reset just before claiming it, then read the quota again.
    const claimAt = calls.indexOf(claim);
    expect(calls.slice(0, claimAt).map((request) => request.url).sort()).toEqual([BANKED_URL, PROFILE_URL].sort());
    expect(calls.slice(claimAt + 1).map((request) => request.url).sort()).toEqual([BANKED_URL, PROFILE_URL, USAGE_URL].sort());
  });

  it('claims nothing when the reset or the limits changed since the confirmation', async () => {
    bankedStatus = () => success(liveStatus({ next_grant_id: 'other' }, [grant({ id: 'other', ends_at: future(86_400_000) })]));
    const moved = await claimClaudeBankedReset(claudeFile(), { grantId: 'launch_week', earlyUse: false });
    expect(moved.actionResult).toMatchObject({ status: 'not-used', message: expect.stringContaining('changed since') });
    // The limit it would refill reset on its own, so using it now would be early.
    bankedStatus = () => success(liveStatus({ exhausted: [] }, [grant({ use_requires_limit: false, ends_at: future(86_400_000) })]));
    const early = await claimClaudeBankedReset(claudeFile(), { grantId: 'launch_week', earlyUse: false });
    expect(early.actionResult?.status).toBe('not-used');
    expect(claims()).toHaveLength(0);
    // The confirmation already warned about spending it early.
    expect((await claimClaudeBankedReset(claudeFile(), { grantId: 'launch_week', earlyUse: true })).actionResult?.status).toBe('success');
    expect(claims()).toHaveLength(1);
  });

  it('claims nothing when the check fails or the organization is unknown', async () => {
    bankedStatus = () => ({ status_code: 500, body: 'down' });
    const failed = await claimClaudeBankedReset(claudeFile(), { grantId: 'launch_week', earlyUse: false });
    expect(failed).toMatchObject({ status: 'error', actionResult: { status: 'not-used', message: 'Couldn’t check the banked reset before using it: down. Nothing was used.' } });
    bankedStatus = () => success(liveStatus());
    post.mockImplementation(async (_path, body) => {
      const request = body as unknown as Request;
      calls.push(request);
      if (request.url === PROFILE_URL) return success({ organization: { uuid: '../../elsewhere' } }) as never;
      return success(liveStatus()) as never;
    });
    const noOrganization = await claimClaudeBankedReset(claudeFile(), { grantId: 'launch_week', earlyUse: false });
    expect(noOrganization.actionResult).toMatchObject({ status: 'not-used', message: expect.stringContaining('organization') });
    expect(calls.some((request) => request.url.includes('/organizations/'))).toBe(false);
    await expect(claimClaudeBankedReset(claudeFile(), { grantId: 'Not A Grant', earlyUse: false })).rejects.toThrow();
    await expect(claimClaudeBankedReset({ ...claudeFile(), provider: 'codex' }, { grantId: 'launch_week', earlyUse: false })).rejects.toThrow();
  });

  it.each([
    ['not_limited', 'not-used', 'only works at a usage limit'],
    ['already_used', 'not-used', 'already used'],
    ['cooldown', 'not-used', 'Another reset was just started'],
    ['ineligible', 'not-used', 'isn’t available any more. Nothing was used'],
  ])('reports %s without spending anything', async (reply, expected, text) => {
    claimReply = () => success({ result: reply });
    const result = await claimClaudeBankedReset(claudeFile(), { grantId: 'launch_week', earlyUse: false });
    expect(result.actionResult).toMatchObject({ status: expected, message: expect.stringContaining(text) });
    expect(result.status).toBe('success');
  });

  it('reports rate limiting and a rejected login as nothing used', async () => {
    claimReply = () => ({ status_code: 429, body: 'slow down' });
    expect((await claimClaudeBankedReset(claudeFile(), { grantId: 'launch_week', earlyUse: false })).actionResult)
      .toMatchObject({ status: 'not-used', message: expect.stringContaining('limiting requests') });
    claimReply = () => ({ status_code: 403, body: 'forbidden' });
    expect((await claimClaudeBankedReset(claudeFile(), { grantId: 'launch_week', earlyUse: false })).actionResult)
      .toMatchObject({ status: 'not-used', message: expect.stringContaining('didn’t accept this login') });
  });

  it('retries an unconfirmed claim under the same request id so it can’t spend two resets', async () => {
    const file = claudeFile();
    claimReply = () => ({ status_code: 502, body: 'bad gateway' });
    const first = await claimClaudeBankedReset(file, { grantId: 'launch_week', earlyUse: false });
    expect(first.actionResult).toMatchObject({ status: 'error', message: 'Couldn’t confirm the reset went through (bad gateway). Refresh in a moment; if the limits weren’t refilled, try again.' });
    claimReply = () => success({ result: 'something new' });
    const second = await claimClaudeBankedReset(file, { grantId: 'launch_week', earlyUse: false });
    expect(second.actionResult).toMatchObject({ status: 'error', message: expect.stringMatching(/^Still couldn’t confirm the reset\. Nothing more was used\./) });
    claimReply = () => success({ result: 'already_used' });
    const third = await claimClaudeBankedReset(file, { grantId: 'launch_week', earlyUse: false });
    expect(third.actionResult).toMatchObject({ status: 'success', message: expect.stringContaining('earlier reset went through') });
    claimReply = () => success({ result: 'reset' });
    await claimClaudeBankedReset(file, { grantId: 'launch_week', earlyUse: false });
    const ids = claims().map((request) => JSON.parse(request.data!).request_id);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).toBe(ids[0]);
    // Settled, so the next claim is a new one.
    expect(ids[3]).not.toBe(ids[0]);
  });

  it('keeps an unconfirmed claim open through a cooldown and after a lost reply', async () => {
    const file = claudeFile();
    claimReply = () => { throw new Error('connection reset'); };
    post.mockImplementation(async (_path, body) => {
      const request = body as unknown as Request;
      calls.push(request);
      if (request.url === CLAIM_URL) return claimReply(request) as never;
      if (request.url === PROFILE_URL) return success({ organization: { uuid: ORG } }) as never;
      return success(liveStatus()) as never;
    });
    expect((await claimClaudeBankedReset(file, { grantId: 'launch_week', earlyUse: false })).actionResult)
      .toMatchObject({ status: 'error', message: expect.stringContaining('(connection reset)') });
    claimReply = () => success({ result: 'cooldown' });
    expect((await claimClaudeBankedReset(file, { grantId: 'launch_week', earlyUse: false })).actionResult)
      .toMatchObject({ status: 'not-used', message: expect.stringContaining('may still be going through') });
    claimReply = () => success({ result: 'not_limited' });
    expect((await claimClaudeBankedReset(file, { grantId: 'launch_week', earlyUse: false })).actionResult)
      .toMatchObject({ status: 'not-used', message: expect.stringContaining('earlier try may have gone through') });
    const ids = claims().map((request) => JSON.parse(request.data!).request_id);
    expect(new Set(ids).size).toBe(1);
  });
});

describe('the Claude reset action', () => {
  const offered = (file: AuthFile) => {
    updateQuotaCache((current) => ({
      ...current,
      [quotaKey(file)]: {
        status: 'success', rows: [{ label: '5-hour window', remainingPercent: 0 }], resetCredits: 2,
        bankedReset: { grantId: 'launch_week' },
      },
    }));
  };

  it('asks first, then shows Claude’s answer on the account', async () => {
    const file = claudeFile();
    offered(file);
    let asked = 0;
    expect(await resetClaudeQuotaWithConfirmation(file, async () => { asked++; return false; })).toBe('canceled');
    expect(claims()).toHaveLength(0);
    expect(await resetClaudeQuotaWithConfirmation(file, async () => { asked++; return true; })).toBe('success');
    expect(asked).toBe(2);
    expect(getQuotaCacheSnapshot()[quotaKey(file)]).toMatchObject({
      status: 'success', resetCredits: 2, actionResult: { status: 'success', message: expect.stringContaining('Limits reset') },
    });
  });

  it('lets a declined reset be tried again but not an unconfirmed one', async () => {
    const file = claudeFile();
    offered(file);
    claimReply = () => success({ result: 'cooldown' });
    expect(await resetClaudeQuotaWithConfirmation(file, async () => true)).toBe('not-used');
    expect(canResetClaudeQuota(file, present(getQuotaCacheSnapshot()[quotaKey(file)], 'the cached quota'))).toBe(true);
    claimReply = () => ({ status_code: 500, body: 'oops' });
    expect(await resetClaudeQuotaWithConfirmation(file, async () => true)).toBe('error');
    expect(canResetClaudeQuota(file, present(getQuotaCacheSnapshot()[quotaKey(file)], 'the cached quota'))).toBe(false);
    expect(await resetClaudeQuotaWithConfirmation(file, async () => true)).toBe('canceled');
    expect(claims()).toHaveLength(2);
  });

  it('keeps the last quota when a declined reset could not be refreshed', async () => {
    const file = claudeFile();
    offered(file);
    const before = present(getQuotaCacheSnapshot()[quotaKey(file)], 'the cached quota');
    bankedStatus = () => ({ status_code: 500, body: 'down' });
    expect(await resetClaudeQuotaWithConfirmation(file, async () => true)).toBe('not-used');
    expect(getQuotaCacheSnapshot()[quotaKey(file)]).toMatchObject({ rows: before.rows, resetCredits: 2, actionResult: { status: 'not-used' } });
  });

  it('offers nothing to use when no reset can be used now', async () => {
    const file = claudeFile();
    updateQuotaCache((current) => ({
      ...current,
      [quotaKey(file)]: { status: 'success', rows: [], resetCredits: 1, bankedReset: { blockedReason: 'Saved for when this account reaches a usage limit' } },
    }));
    let asked = false;
    expect(await resetClaudeQuotaWithConfirmation(file, async () => { asked = true; return true; })).toBe('canceled');
    expect(asked).toBe(false);
    expect(canResetClaudeQuota({ ...file, disabled: true }, { status: 'success', rows: [], bankedReset: { grantId: 'launch_week' } })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

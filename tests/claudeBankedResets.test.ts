import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from 'bun:test';
import { managementApi } from '../src/services/managementApi';
import { canResetClaudeQuota, resetClaudeQuotaWithConfirmation } from '../src/services/quotaActions';
import { getQuotaCacheSnapshot, updateQuotaCache } from '../src/services/quotaCache';
import {
  claimClaudeBankedReset, claudeBankedResetFor, loadQuota, quotaKey, quotaRowsFor, usableClaudeReset, type AuthFile,
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
        kinds: [{
          kind: 'full', count: 2, expiresAt: '2030-01-20T00:00:00Z', windows: ['5-hour window', '7-day window'],
          refills: '5-hour window and 7-day window', grantId: 'launch_week', useBy: '2030-01-20T00:00:00Z',
        }],
        weeklyResetsAt: '2030-01-14T00:00:00Z',
      },
    });
  });

  // What claude.ai shows as "Fable reset · 3" beside "Weekly reset": two kinds, counted and offered apart.
  const fableGrant = (overrides: Record<string, unknown> = {}) => grant({
    id: 'fable_launch', resets_left: 3, ends_at: '2030-05-01T00:00:00Z', clears: ['seven_day_overage_included'],
    gives_back_weekly: true, use_requires_limit: false, percent_used: { seven_day_overage_included: 30 }, ...overrides,
  });
  const weeklyGrant = (overrides: Record<string, unknown> = {}) => grant({
    id: 'weekly_thanks', resets_left: 1, ends_at: '2030-01-15T00:00:00Z', type: 'weekly',
    clears: ['seven_day', 'seven_day_overage_included', 'seven_day_opus'], use_requires_limit: false,
    percent_used: { seven_day: 58, seven_day_overage_included: 30 }, ...overrides,
  });
  const kindsOf = (overrides: Record<string, unknown>, grants: unknown[]) =>
    present(claudeBankedResetFor(status(overrides, grants), NOW).bankedReset).kinds;

  it('tells a Fable reset from a weekly one: its own count, use-by date and what it gives back', () => {
    const result = claudeBankedResetFor(status({ exhausted: [], next_grant_id: 'fable_launch' }, [fableGrant(), weeklyGrant()]), NOW);
    expect(result.resetCredits).toBe(4);
    expect(result.resetCreditsEarliestExpiry).toBe('2030-01-15T00:00:00Z');
    // Before any limit, the narrower one leads.
    expect(result.bankedReset?.kinds).toEqual([
      {
        kind: 'weekly', count: 1, expiresAt: '2030-01-15T00:00:00Z', useBy: '2030-01-15T00:00:00Z', grantId: 'weekly_thanks',
        windows: ['7-day window', '7-day Opus window', '7-day Fable window'], refills: '7-day window and 7-day Opus window',
        earlyUse: { percentLeft: 42, limit: '7-day window' },
      },
      {
        kind: 'fable', count: 3, expiresAt: '2030-05-01T00:00:00Z', useBy: '2030-05-01T00:00:00Z', grantId: 'fable_launch',
        windows: ['7-day Fable window'], refills: '7-day Fable window', givesBackTo: '7-day window',
        earlyUse: { percentLeft: 70, limit: '7-day Fable window' },
      },
    ]);
    expect(result.bankedReset?.blockedReason).toBeUndefined();
  });

  it('works out the kind as Claude Code does: what it gives back, then Claude’s type, then what it refills', () => {
    const kind = (overrides: Record<string, unknown>) => itemAt(kindsOf({}, [grant(overrides)]), 0).kind;
    expect(kind({ clears: ['five_hour'] })).toBe('session');
    expect(kind({ clears: ['seven_day', 'seven_day_opus'] })).toBe('weekly');
    expect(kind({ clears: ['five_hour', 'seven_day'] })).toBe('full');
    expect(kind({ clears: ['five_hour', 'seven_day'], type: 'weekly' })).toBe('weekly');
    expect(kind({ clears: ['five_hour'], type: 'something new' })).toBe('session');
    expect(kind({ type: 'full', gives_back_weekly: true })).toBe('fable');
    // Grants of one kind are one line: counted together, the first to lapse as its date.
    expect(kindsOf({}, [grant({ id: 'a', resets_left: 1, ends_at: '2030-02-01T00:00:00Z' }), grant({ id: 'b', resets_left: 2, usable_now: false })]))
      .toMatchObject([{ kind: 'full', count: 3, expiresAt: '2030-01-20T00:00:00Z', grantId: 'a', useBy: '2030-02-01T00:00:00Z' }]);
    // Claude's next grant is the one claimed when it's one of them.
    expect(itemAt(kindsOf({ next_grant_id: 'b' }, [grant({ id: 'a' }), grant({ id: 'b' })]), 0).grantId).toBe('b');
  });

  it('leads with the reset made for the limit the account is at', () => {
    const session = grant({ id: 'five', clears: ['five_hour'], type: 'session' });
    const order = (exhausted: string[], grants: unknown[]) => kindsOf({ exhausted, at_limit: true }, grants).map((offer) => offer.kind);
    // Out of Fable: the Fable reset, keeping the weekly one for the week.
    const outOfFable = { percent_used: { seven_day_overage_included: 100 } };
    expect(order(['seven_day_overage_included'], [weeklyGrant(), fableGrant(outOfFable)])).toEqual(['fable', 'weekly']);
    // At the 5-hour limit: the 5-hour reset before the one that refills everything.
    expect(order(['five_hour'], [grant(), session])).toEqual(['session', 'full']);
    // At the weekly limit: the weekly reset, and the Fable one last, since it frees up only what Fable used.
    const atWeek = kindsOf({ exhausted: ['seven_day'], at_limit: true }, [fableGrant(), weeklyGrant(), grant()]);
    expect(atWeek.map((offer) => [offer.kind, offer.givesBackOnly, offer.earlyUse])).toEqual([
      ['weekly', undefined, undefined], ['full', undefined, undefined], ['fable', true, undefined],
    ]);
    // One that would be spent early comes after one that refills the limit, and one that can't be used last.
    const mixed = kindsOf({ exhausted: ['five_hour'], at_limit: true }, [
      weeklyGrant({ usable_now: false, use_requires_limit: true }), fableGrant(), grant(),
    ]);
    expect(mixed.map((offer) => [offer.kind, Boolean(offer.grantId), offer.earlyUse !== undefined])).toEqual([
      ['full', true, false], ['fable', true, true], ['weekly', false, false],
    ]);
    expect(present(usableClaudeReset({ status: 'success', rows: [], bankedReset: { kinds: mixed } })).kind).toBe('full');
    expect(usableClaudeReset({ status: 'success', rows: [], bankedReset: { kinds: mixed } }, 'weekly')).toBeUndefined();
  });

  it('says why one kind can’t be used while another can', () => {
    const reason = (overrides: Record<string, unknown>, block: Record<string, unknown> = {}) => present(
      kindsOf({ exhausted: ['seven_day'], at_limit: true, ...block }, [weeklyGrant(), fableGrant({ usable_now: false, ...overrides })])
        .find((offer) => offer.kind === 'fable'),
    ).blockedReason;
    // Claude's own reason, when it gives one.
    expect(reason({ unavailable_reason: 'blocked_seven_day' })).toBe('Fable hasn’t used anything this week to give back');
    expect(reason({ unavailable_reason: 'cannot_clear' })).toBe('It doesn’t refill the limit this account has reached');
    expect(reason({ unavailable_reason: 'blocked_other' })).toBe('It can’t be used while this account is at another limit it doesn’t refill');
    expect(reason({ unavailable_reason: 'blocked_five_hour' })).toBe('It doesn’t refill the 5-hour window, so it can’t be used until that resets');
    expect(reason({ unavailable_reason: 'cooldown' })).toContain('Another reset just ran');
    expect(reason({ unavailable_reason: 'needs_limit' })).toBe('Saved for when this account reaches a usage limit');
    expect(reason({ unavailable_reason: 'something new', blocking: ['seven_day'] })).toBe('Fable hasn’t used anything this week to give back');
    // Without one, what the reply implies: at a limit the reset does nothing for.
    expect(reason({}, { exhausted: ['five_hour'] })).toBe('It doesn’t refill the limit this account has reached');
    // The account's own reason is kept for when nothing can be used.
    const both = present(claudeBankedResetFor(status({ exhausted: ['five_hour'], at_limit: true }, [
      weeklyGrant({ usable_now: false }), fableGrant({ usable_now: false }),
    ]), NOW).bankedReset);
    expect(both.blockedReason).toBe('It doesn’t refill the limit this account has reached');
    expect(present(claudeBankedResetFor(status({ exhausted: ['seven_day'] }, [weeklyGrant(), fableGrant({ usable_now: false })]), NOW).bankedReset).blockedReason)
      .toBeUndefined();
  });

  it('names every cap it refills the way its row on the Accounts page does', () => {
    const refills = (clears: unknown[]) =>
      claudeBankedResetFor(status({}, [grant({ clears })]), NOW).bankedReset?.kinds[0]?.refills;
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
      claudeBankedResetFor(status({ exhausted: [] }, [grant({ use_requires_limit: false, ...overrides })]), NOW).bankedReset?.kinds[0]?.earlyUse;
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
    expect(claudeBankedResetFor(status({}, [grant({ use_requires_limit: false })]), NOW).bankedReset?.kinds[0]?.earlyUse).toBeUndefined();
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
    expect(reason({})?.kinds[0]?.grantId).toBeUndefined();
    // A paused next grant is not offered even if marked usable.
    expect(claudeBankedResetFor(status({}, [grant({ paused: true })]), NOW).bankedReset?.kinds[0]?.grantId).toBeUndefined();
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
    expect(result.bankedReset?.kinds).toMatchObject([{ kind: 'full', count: 4 }]);
    expect(result.bankedReset?.kinds[0]?.grantId).toBeUndefined();
    expect(result.bankedReset?.blockedReason).toBe('Saved for when this account reaches a usage limit');
    // An eligible account with nothing left shows zero, not nothing.
    expect(claudeBankedResetFor(status({}, []), NOW)).toMatchObject({ resetCredits: 0, bankedReset: { kinds: [] } });
  });

  it('treats an unavailable service as a failed check and names a client refusal', () => {
    expect(claudeBankedResetFor(status({ eligible: false, ineligible_reason: 'unavailable' }), NOW).error)
      .toBe('Claude couldn’t check banked resets right now');
    expect(claudeBankedResetFor(status({ eligible: false, ineligible_reason: 'surface' }), NOW)).toEqual({
      resetCredits: 2,
      resetCreditsEarliestExpiry: '2030-01-20T00:00:00Z',
      bankedReset: {
        // What's held is still listed, with nothing to claim.
        kinds: [{ kind: 'full', count: 2, expiresAt: '2030-01-20T00:00:00Z', windows: ['5-hour window', '7-day window'], refills: '5-hour window and 7-day window' }],
        blockedReason: 'Claude isn’t offering these to Arbor (surface)', blockedHere: true,
      },
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
const PREPAID_URL = `https://api.anthropic.com/api/oauth/organizations/${ORG}/prepaid/credits`;
const future = (ms: number) => new Date(Date.now() + ms).toISOString();
const liveStatus = (overrides: Record<string, unknown> = {}, grants: unknown[] = [grant({ ends_at: future(86_400_000) })]) =>
  status({ weekly_resets_at: future(3 * 86_400_000), ...overrides }, grants);

let post: Mock<typeof managementApi.post>;
let calls: Request[];
let fileCount = 0;
let bankedStatus: () => unknown;
let claimReply: (request: Request) => unknown;
let prepaidReply: () => unknown;

const claudeFile = (): AuthFile => ({ name: `claude-banked-${++fileCount}.json`, provider: 'claude', auth_index: `cb-${fileCount}` });
const claims = () => calls.filter((request) => request.url === CLAIM_URL);

beforeEach(() => {
  calls = [];
  bankedStatus = () => success(liveStatus());
  claimReply = () => success({ result: 'reset', resets_left: 1, cleared: ['five_hour'] });
  prepaidReply = () => success({ amount: 0, currency: 'USD', expiry_policy_months: 12 });
  post = spyOn(managementApi, 'post').mockImplementation(async (path, body) => {
    expect(path).toBe('/api-call');
    const request = body as unknown as Request;
    calls.push(request);
    if (request.url === USAGE_URL) return success({ five_hour: { utilization: 100 } }) as never;
    if (request.url === PROFILE_URL) return success({ account: { has_claude_max: true }, organization: { uuid: ORG } }) as never;
    if (request.url === BANKED_URL) return bankedStatus() as never;
    if (request.url === CLAIM_URL) return claimReply(request) as never;
    if (request.url === PREPAID_URL) return prepaidReply() as never;
    throw new Error('Unexpected API request ' + request.url);
  });
});
afterEach(() => post.mockRestore());

describe('checking Claude banked resets with the quota', () => {
  it('reads them the way Claude Code does, beside the usual usage request', async () => {
    const result = await loadQuota(claudeFile());
    expect(result).toMatchObject({
      status: 'success', plan: 'Max', resetCredits: 2,
      bankedReset: { kinds: [{ kind: 'full', grantId: 'launch_week', refills: '5-hour window and 7-day window' }] },
    });
    expect(result.resetCreditsApplicable).toBeUndefined();
    expect(calls.map((request) => request.url).sort()).toEqual([BANKED_URL, PREPAID_URL, PROFILE_URL, USAGE_URL].sort());
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

  it('reads prepaid usage credits for the organization, and leaves them out when the read fails', async () => {
    prepaidReply = () => success({ amount: 4250, currency: 'USD', expiry_policy_months: 12 });
    expect((await loadQuota(claudeFile())).usageCredits).toEqual({ balance: 4250, currency: 'USD', expiryMonths: 12 });
    const prepaid = present(calls.find((request) => request.url === PREPAID_URL));
    expect(prepaid.method).toBe('GET');
    expect(prepaid.header['x-organization-uuid']).toBe(ORG);
    prepaidReply = () => ({ status_code: 404, body: 'not found' });
    expect(await loadQuota(claudeFile())).toMatchObject({ status: 'success', plan: 'Max', usageCredits: undefined });
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
    expect(calls.slice(claimAt + 1).map((request) => request.url).sort()).toEqual([BANKED_URL, PREPAID_URL, PROFILE_URL, USAGE_URL].sort());
  });

  it('claims the kind that was confirmed and says what a Fable reset gave back', async () => {
    bankedStatus = () => success(liveStatus({ exhausted: [] }, [
      grant({ ends_at: future(86_400_000), use_requires_limit: false }),
      grant({ id: 'fable_launch', ends_at: future(86_400_000), clears: ['seven_day_overage_included'], gives_back_weekly: true, use_requires_limit: false }),
    ]));
    const result = await claimClaudeBankedReset(claudeFile(), { grantId: 'fable_launch', earlyUse: true });
    expect(JSON.parse(itemAt(claims(), 0).data!).grant_id).toBe('fable_launch');
    expect(result.actionResult?.message).toStartWith('Fable reset used and quota refreshed. What Fable used is back in the weekly limit, which still resets ');
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
    expect(first.actionResult).toMatchObject({ status: 'error', message: 'Couldn’t confirm the reset went through. The provider answered: bad gateway. Refresh in a moment; if the limits weren’t refilled, try again.' });
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
      .toMatchObject({ status: 'error', message: expect.stringContaining('went through. connection reset. Refresh') });
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
        bankedReset: { kinds: [{ kind: 'full', count: 2, windows: [], grantId: 'launch_week' }] },
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

  it('uses the kind asked for, and nothing when that kind can’t be used', async () => {
    const file = claudeFile();
    bankedStatus = () => success(liveStatus({}, [
      grant({ ends_at: future(86_400_000) }),
      grant({ id: 'fable_launch', ends_at: future(86_400_000), clears: ['seven_day_overage_included'], gives_back_weekly: true }),
    ]));
    updateQuotaCache((current) => ({
      ...current,
      [quotaKey(file)]: {
        status: 'success', rows: [], resetCredits: 3,
        bankedReset: { kinds: [
          { kind: 'full', count: 2, windows: [], grantId: 'launch_week' },
          { kind: 'fable', count: 1, windows: [], grantId: 'fable_launch' },
          { kind: 'weekly', count: 1, windows: [], blockedReason: 'Saved for when this account reaches a usage limit' },
        ] },
      },
    }));
    let asked = 0;
    expect(await resetClaudeQuotaWithConfirmation(file, async () => { asked++; return true; }, 'weekly')).toBe('canceled');
    expect(asked).toBe(0);
    expect(await resetClaudeQuotaWithConfirmation(file, async () => { asked++; return true; }, 'fable')).toBe('success');
    expect(claims().map((request) => JSON.parse(request.data!).grant_id)).toEqual(['fable_launch']);
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
      [quotaKey(file)]: {
        status: 'success', rows: [], resetCredits: 1,
        bankedReset: { kinds: [{ kind: 'full', count: 1, windows: [] }], blockedReason: 'Saved for when this account reaches a usage limit' },
      },
    }));
    let asked = false;
    expect(await resetClaudeQuotaWithConfirmation(file, async () => { asked = true; return true; })).toBe('canceled');
    expect(asked).toBe(false);
    expect(canResetClaudeQuota({ ...file, disabled: true }, {
      status: 'success', rows: [], bankedReset: { kinds: [{ kind: 'full', count: 1, windows: [], grantId: 'launch_week' }] },
    })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

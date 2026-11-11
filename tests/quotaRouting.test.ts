import { describe, expect, it } from 'bun:test';
import { accountOrderGap, applyRoutingPlan, providerRoutingPlans, routingPlan, type RoutingCandidate } from '../src/services/quotaRouting';
import { reserveAccounts } from '../src/services/modelReserves';

// money-22: Account order says why it has nothing to show rather than vanishing.
describe('accountOrderGap', () => {
  const base = { coreReady: true, loaded: true, accounts: 2, mostForOneProvider: 2, reading: false, routings: 0 };
  it('says why there is no order', () => {
    expect(accountOrderGap({ ...base, coreReady: false })).toBe('core');
    expect(accountOrderGap({ ...base, loaded: false })).toBe('loading');
    expect(accountOrderGap({ ...base, accounts: 0, mostForOneProvider: 0 })).toBe('none');
    expect(accountOrderGap({ ...base, mostForOneProvider: 1 })).toBe('single');
    expect(accountOrderGap({ ...base, reading: true })).toBe('loading');
    expect(accountOrderGap(base)).toBe('unread');
  });
  it('says nothing once there is an order', () => {
    expect(accountOrderGap({ ...base, coreReady: false, routings: 1 })).toBeNull();
  });
});
import { quotaKey, type QuotaState } from '../src/services/quotaService';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = 100 * DAY;
const WEEKLY = '7-day window';
const weekly = (left: number, resetIn: number): QuotaState => ({
  status: 'success',
  rows: [
    { label: '5-hour window', remainingPercent: 90, resetAtMs: now + HOUR },
    { label: WEEKLY, remainingPercent: left, resetAtMs: now + resetIn },
  ],
});
const account = (name: string, quota: QuotaState | undefined, extra: Record<string, unknown> = {}): RoutingCandidate => ({
  file: { name: `${name}.json`, provider: 'claude', auth_index: name, ...extra },
  quota,
  name,
});

describe('quota-aware routing', () => {
  it('ranks an account keeping a reserve like any other, and says so beside it', () => {
    const reserve = { models: ['gpt-daybreak-blue-latest'], percent: 4, remaining: 70, state: 'open' as const, floor: 1, smart: true };
    const plan = routingPlan([
      account('preview', weekly(70, 2 * HOUR)),
      account('later', weekly(80, 3 * DAY)),
      account('empty', weekly(5, DAY)),
    ], WEEKLY, now, new Map([['preview.json', reserve]]));
    // Above its reserve its limit is everyday capacity, and it resets soonest.
    expect(plan?.items.map((item) => [item.name, item.suggested, item.reason.kind])).toEqual([
      ['preview', 2, 'soonest'],
      ['later', 1, 'soonest'],
      ['empty', 0, 'low'],
    ]);
    expect(plan?.items[0]?.reserve).toEqual(reserve);
    expect(plan?.items[1]?.reserve).toBeUndefined();
  });

  it('reads an account for reserves from its longest window, and counts it out at a limit', () => {
    const files = [
      { name: 'a.json', provider: 'claude', auth_index: 'a' },
      { name: 'b.json', provider: 'claude', auth_index: 'b', disabled: true },
      { name: 'c.json', provider: 'claude', auth_index: 'c' },
    ];
    const quotas = {
      [quotaKey(files[0]!)]: weekly(70, 2 * DAY),
      [quotaKey(files[2]!)]: { status: 'success' as const, rows: [{ label: '5-hour window', remainingPercent: 0, resetAtMs: now + HOUR }, { label: WEEKLY, remainingPercent: 40, resetAtMs: now + DAY }] },
    };
    expect(reserveAccounts(files, quotas, now)).toEqual([
      { name: 'a.json', remaining: 70, resetAtMs: now + 2 * DAY, windowMs: 7 * DAY, out: false },
      { name: 'c.json', remaining: 40, resetAtMs: now + DAY, windowMs: 7 * DAY, out: true },
    ]);
  });

  it('puts the soonest reset first, nearly empty accounts last, and leaves the rest alone', () => {
    const plan = routingPlan([
      account('later', weekly(80, 3 * DAY)),
      account('empty', weekly(5, DAY), { priority: 5 }),
      account('soon', weekly(45, 20 * HOUR)),
      account('failed', { status: 'error', rows: [], error: 'timeout' }, { priority: 2 }),
      account('off', weekly(90, 2 * HOUR), { disabled: true, priority: 7 }),
      account('runtime', weekly(90, 2 * HOUR), { runtime_only: true }),
      account('signed-out', weekly(90, 2 * HOUR), { status: 'error', status_message: 'invalid_grant', unavailable: true }),
    ], WEEKLY, now);
    expect(plan?.items.map((item) => [item.name, item.current, item.suggested, item.reason.kind])).toEqual([
      ['soon', 0, 2, 'soonest'],
      ['later', 0, 1, 'soonest'],
      ['empty', 5, 0, 'low'],
      ['failed', 2, null, 'unknown'],
      ['off', 7, null, 'blocked'],
      ['runtime', 0, null, 'fixed'],
      ['signed-out', 0, null, 'blocked'],
    ]);
    expect(plan?.changes.map((item) => `${item.fileName}:${item.current}->${item.suggested}`)).toEqual(['soon.json:0->2', 'later.json:0->1', 'empty.json:5->0']);
  });

  describe('an account holding a reset that lapses before its window resets', () => {
    const holding = (left: number, resetIn: number, lapsesIn: number): QuotaState =>
      ({ ...weekly(left, resetIn), resetCredits: 1, resetCreditsApplicable: 1, resetCreditsEarliestExpiry: new Date(now + lapsesIn).toISOString() });
    const order = (candidates: RoutingCandidate[], lapsingFirst: boolean) => routingPlan(candidates, WEEKLY, now, undefined, lapsingFirst)?.items
      .map((item) => [item.name, item.suggested, item.reason.kind === 'soonest' ? item.reason.lapsesAtMs : undefined, item.resetLapsesAtMs]);
    // The pool spends about 1.4% an hour. In its turn `holder` runs out in 58h, after its reset lapsed; first, in 22h.
    const worthIt = [account('soon', weekly(50, 2 * DAY)), account('holder', holding(30, 4 * DAY, DAY))];

    it('is only pointed out unless the user asked for it to go first', () => {
      expect(order(worthIt, false)).toEqual([['soon', 2, undefined, undefined], ['holder', 1, undefined, now + DAY]]);
      expect(routingPlan(worthIt.map((item, index) => ({ ...item, file: { ...item.file, priority: 2 - index } })), WEEKLY, now)?.changes).toEqual([]);
    });

    it('goes ahead, when asked, if that gets it to its limit in time and its turn wouldn’t', () => {
      expect(order(worthIt, true)).toEqual([['holder', 2, now + DAY, undefined], ['soon', 1, undefined, undefined]]);
      // With 80% left it can't get there by then, so it keeps its turn.
      expect(order([account('soon', weekly(50, 2 * DAY)), account('holder', holding(80, 4 * DAY, DAY))], true))
        .toEqual([['soon', 2, undefined, undefined], ['holder', 1, undefined, undefined]]);
      // A reset that lapses in three days is reached in its turn anyway.
      expect(order([account('soon', weekly(50, 2 * DAY)), account('holder', holding(30, 4 * DAY, 3 * DAY))], true))
        .toEqual([['soon', 2, undefined, undefined], ['holder', 1, undefined, undefined]]);
      // Nearly out, it would go last and never reach its limit: finishing it off first uses the reset.
      const low = [account('soon', weekly(50, 2 * DAY)), account('later', weekly(60, 3 * DAY)), account('low', holding(5, 4 * DAY, DAY))];
      expect(order(low, true)).toEqual([['low', 3, now + DAY, undefined], ['soon', 2, undefined, undefined], ['later', 1, undefined, undefined]]);
      expect(order(low, false)).toEqual([['soon', 2, undefined, undefined], ['later', 1, undefined, undefined], ['low', 0, undefined, now + DAY]]);
    });
  });

  it('leaves an account showing limits from before a failed check where it is', () => {
    const stale: QuotaState = { ...weekly(5, 20 * HOUR), status: 'error', error: 'timeout', staleSinceMs: now - HOUR };
    const plan = routingPlan([
      account('later', weekly(80, 3 * DAY)),
      account('soon', weekly(45, 20 * HOUR)),
      account('stale', stale, { priority: 4 }),
      account('retrying', { ...stale, status: 'loading' }, { priority: 3 }),
    ], WEEKLY, now);
    expect(plan?.items.map((item) => [item.name, item.suggested, item.reason.kind])).toEqual([
      ['soon', 2, 'soonest'],
      ['later', 1, 'soonest'],
      ['stale', null, 'unknown'],
      ['retrying', null, 'unknown'],
    ]);
  });

  it('treats resets within an hour as the same time and uses the account with more left first', () => {
    const plan = routingPlan([
      account('x', weekly(40, 10 * HOUR)),
      account('y', weekly(70, 10 * HOUR + 30 * 60_000)),
      account('z', weekly(95, 13 * HOUR)),
    ], WEEKLY, now);
    expect(plan?.items.map((item) => `${item.name}=${item.suggested}`)).toEqual(['y=3', 'x=2', 'z=1']);
  });

  it('has nothing to change once the priorities match', () => {
    const plan = routingPlan([
      account('soon', weekly(45, 20 * HOUR), { priority: 2 }),
      account('later', weekly(80, 3 * DAY), { priority: '1' }),
    ], WEEKLY, now);
    expect(plan?.changes).toEqual([]);
  });

  it('only plans around a daily or longer headline with two accounts to order', () => {
    const accounts = [account('a', weekly(45, 20 * HOUR)), account('b', weekly(80, 3 * DAY))];
    expect(routingPlan(accounts, '5-hour window', now)).toBeNull();
    expect(routingPlan(accounts, null, now)).toBeNull();
    expect(routingPlan([accounts[0]!, account('c', undefined)], WEEKLY, now)).toBeNull();
  });

  it('sets each changed priority on the credential file', async () => {
    const calls: unknown[] = [];
    const plan = routingPlan([account('soon', weekly(45, 20 * HOUR)), account('later', weekly(80, 3 * DAY), { priority: 1 })], WEEKLY, now);
    await applyRoutingPlan(plan!.changes, { patch: async (path, body) => void calls.push({ path, body }) });
    expect(calls).toEqual([{ path: '/auth-files/fields', body: { name: 'soon.json', priority: 2 } }]);
  });

  it('plans each provider on the headline window the Accounts page sums it up by', () => {
    const file = (name: string, provider: string) => ({ name: `${name}.json`, provider, auth_index: name });
    const [soon, later, solo] = [file('soon', 'claude'), file('later', 'claude'), file('solo', 'codex')];
    const quotas = { [quotaKey(soon)]: weekly(45, 20 * HOUR), [quotaKey(later)]: weekly(80, 3 * DAY), [quotaKey(solo)]: weekly(50, DAY) };
    const plans = providerRoutingPlans([later, solo, soon], quotas, { [quotaKey(later)]: { name: 'Work' } }, { hidden: {}, headline: {} }, now);
    // Codex has one account, so there's nothing to order.
    expect(plans.map(({ provider, window, plan }) => [provider, window, plan.items.map((item) => `${item.name}=${item.suggested}`)])).toEqual([
      ['claude', WEEKLY, ['soon=2', 'Work=1']],
    ]);
    // A headline that resets every few hours isn't planned around.
    expect(providerRoutingPlans([soon, later], quotas, {}, { hidden: {}, headline: { claude: '5-hour window' } }, now)).toEqual([]);
  });
});

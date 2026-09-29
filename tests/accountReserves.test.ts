import { beforeEach, describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import {
  applyReserveSteps,
  getAccountReserves,
  renameReserveKeys,
  reserveNotifications,
  reservePlan,
  reserveReached,
  reserveReadingDue,
  resetAccountReserves,
  resumePausedAccount,
  resumesWithCap,
  setAccountReserve,
  type PausedAccount,
  type ReserveInput,
  type ReserveState,
} from '../src/services/accountReserves';
import type { AuthFile, QuotaState } from '../src/services/quotaService';
import { lastItem } from './support/items';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = 100 * DAY;
const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);

/** Claude's limits with the used share of each. */
const claude = (used: { fiveHour?: number; week?: number; sonnet?: number } = {}): QuotaState => ({
  status: 'success',
  fetchedAt: now - 5 * MINUTE,
  rows: [
    { label: '5-hour window', remainingPercent: 100 - (used.fiveHour ?? 20), resetAtMs: now + 2 * HOUR },
    { label: '7-day window', remainingPercent: 100 - (used.week ?? 50), resetAtMs: now + 3 * DAY },
    { label: '7-day Sonnet window', remainingPercent: 100 - (used.sonnet ?? 10), resetAtMs: now + 3 * DAY },
    // Paid overage, with no reset: never a cap limit.
    { label: 'Extra usage', remainingPercent: 0 },
  ],
});

const file = (name: string, fields: Record<string, unknown> = {}): AuthFile => ({
  name: `${name}.json`, provider: 'claude', auth_index: name, source: 'file', account_type: 'oauth', ...fields,
});
const key = (name: string) => `${name}.json::${name}`;

const paused = (fields: Partial<PausedAccount> = {}): PausedAccount => ({
  provider: 'claude', name: 'Work', window: '7-day window', cap: 80, percentUsed: 81, pausedAtMs: now - HOUR, resumeAtMs: now + DAY,
  ...fields,
});

const input = (fields: Partial<Omit<ReserveInput, 'state'>> & { state?: Partial<ReserveState> }): ReserveInput => ({
  enabled: [],
  disabled: [],
  quotas: {},
  hidden: {},
  nameFor: (_key, file) => String(file.name).replace('.json', ''),
  nowMs: now,
  ...fields,
  state: { caps: {}, paused: {}, skipUntil: {}, ...fields.state },
});

const summary = (steps: ReturnType<typeof reservePlan>) => steps.map((step) =>
  step.kind === 'pause' ? `pause ${step.key} at ${step.paused.percentUsed}% of ${step.paused.window}${step.last ? ' (last)' : ''}`
    : step.kind === 'resume' ? `resume ${step.key} (${step.reason})`
      : step.kind === 'update' ? `update ${step.key} to ${step.paused.percentUsed}% of ${step.paused.window} at ${step.paused.cap}% until ${step.paused.resumeAtMs - now}`
        : `forget ${step.key}${step.skipUntilMs === null ? '' : ` until ${step.skipUntilMs - now}`}`);

describe('which limits a cap applies to', () => {
  it('pauses on any limit at the cap, until the one at the cap that resets last resets', () => {
    expect(reserveReached(claude({ week: 79 }), 80, [], now)).toBeNull();
    expect(reserveReached(claude({ week: 80 }), 80, [], now)).toEqual({ window: '7-day window', percentUsed: 80, resumeAtMs: now + 3 * DAY + MINUTE });
    // The 5-hour window reached it too, but the account can't come back before the weekly one resets.
    expect(reserveReached(claude({ fiveHour: 95, week: 85 }), 80, [], now)?.window).toBe('7-day window');
    expect(reserveReached(claude({ fiveHour: 95 }), 80, [], now)).toEqual({ window: '5-hour window', percentUsed: 95, resumeAtMs: now + 2 * HOUR + MINUTE });
    // Same reset: the one used most names it.
    expect(reserveReached(claude({ week: 82, sonnet: 97 }), 80, [], now)?.window).toBe('7-day Sonnet window');
  });

  it('leaves out hidden limits, side limits, limits with no reset or one already past, and failed readings', () => {
    expect(reserveReached(claude({ sonnet: 91 }), 80, ['7-day Sonnet window'], now)).toBeNull();
    const codex: QuotaState = {
      status: 'success',
      rows: [
        { label: '5-hour limit', remainingPercent: 60, resetAtMs: now + HOUR },
        { label: 'Code review Weekly limit', remainingPercent: 0, resetAtMs: now + DAY, extra: true },
      ],
    };
    expect(reserveReached(codex, 80, [], now)).toBeNull();
    const stale: QuotaState = { status: 'success', rows: [{ label: '5-hour window', remainingPercent: 5, resetAtMs: now - MINUTE }] };
    expect(reserveReached(stale, 80, [], now)).toBeNull();
    expect(reserveReached({ status: 'error', rows: [], error: 'timeout' }, 80, [], now)).toBeNull();
    expect(reserveReached({ status: 'loading', rows: claude({ week: 99 }).rows }, 80, [], now)).toBeNull();
  });

  it('reads accounts near their cap every couple of minutes, and every account with a cap at least every quarter hour', () => {
    const near = { ...claude({ week: 66 }), fetchedAt: now - 2 * MINUTE };
    expect(reserveReadingDue(near, 80, [], now)).toBe(true);
    expect(reserveReadingDue({ ...near, fetchedAt: now - 30_000 }, 80, [], now)).toBe(false);
    const far = { ...claude({ week: 50 }), fetchedAt: now - 5 * MINUTE };
    expect(reserveReadingDue(far, 80, [], now)).toBe(false);
    expect(reserveReadingDue({ ...far, fetchedAt: now - 15 * MINUTE }, 80, [], now)).toBe(true);
    expect(reserveReadingDue({ status: 'error', rows: [], error: 'timeout' }, 80, [], now)).toBe(false);
  });
});

describe('keeping accounts under their cap', () => {
  it('pauses accounts at their cap and says when that leaves none in use', () => {
    const steps = reservePlan(input({
      enabled: [file('work'), file('home'), file('spare', { status: 'error', status_message: 'invalid_grant', unavailable: true })],
      quotas: { [key('work')]: claude({ week: 81 }), [key('home')]: claude({ week: 40 }), [key('spare')]: claude() },
      state: { caps: { [key('work')]: 80, [key('home')]: 90 } },
    }));
    expect(summary(steps)).toEqual(['pause work.json::work at 81% of 7-day window']);
    expect(steps[0]).toMatchObject({ kind: 'pause', paused: { provider: 'claude', name: 'work', cap: 80, pausedAtMs: now, resumeAtMs: now + 3 * DAY + MINUTE } });

    // The spare needs signing in again, so it doesn't count as in use.
    const both = reservePlan(input({
      enabled: [file('work'), file('home'), file('spare', { status: 'error', status_message: 'invalid_grant', unavailable: true })],
      quotas: { [key('work')]: claude({ week: 81 }), [key('home')]: claude({ fiveHour: 92 }) },
      state: { caps: { [key('work')]: 80, [key('home')]: 90 } },
    }));
    expect(summary(both)).toEqual([
      'pause work.json::work at 81% of 7-day window (last)',
      'pause home.json::home at 92% of 5-hour window (last)',
    ]);
  });

  it('leaves alone accounts without a cap, turned back on early, already paused, or that the core can’t turn off', () => {
    const over = claude({ week: 99 });
    expect(reservePlan(input({
      enabled: [file('none'), file('early'), file('runtime', { runtime_only: true }), file('key', { account_type: 'api_key' })],
      quotas: { [key('none')]: over, [key('early')]: over, [key('runtime')]: over, [key('key')]: over },
      state: {
        caps: { [key('early')]: 80, [key('runtime')]: 80, [key('key')]: 80 },
        skipUntil: { [key('early')]: now + HOUR },
      },
    }))).toEqual([]);
    // Once its limit has reset the early one is watched again.
    expect(summary(reservePlan(input({
      enabled: [file('early')],
      quotas: { [key('early')]: over },
      state: { caps: { [key('early')]: 80 }, skipUntil: { [key('early')]: now - MINUTE } },
    })))).toEqual(['pause early.json::early at 99% of 7-day window (last)']);
  });

  it('never pauses on limits held over from before a failed check', () => {
    const stale: QuotaState = { ...claude({ week: 95 }), status: 'error', error: 'timeout', staleSinceMs: now - MINUTE };
    const plan = (quota: QuotaState) => reservePlan(input({
      enabled: [file('work')],
      quotas: { [key('work')]: quota },
      state: { caps: { [key('work')]: 80 } },
    }));
    expect(plan(stale)).toEqual([]);
    expect(plan({ ...stale, status: 'loading' })).toEqual([]);
    // Nor reads it more often: the usual refresh tries again.
    expect(reserveReadingDue({ ...stale, fetchedAt: now - HOUR }, 80, [], now)).toBe(false);
  });

  it('keeps a paused account paused on a stale reading after its limit went under the cap', () => {
    const off = file('work', { disabled: true, status: 'disabled' });
    const stale: QuotaState = { ...claude({ week: 10 }), status: 'error', error: 'timeout', staleSinceMs: now - MINUTE };
    expect(summary(reservePlan(input({
      disabled: [off],
      quotas: { [key('work')]: stale },
      state: { caps: { [key('work')]: 80 }, paused: { [key('work')]: paused() } },
    })))).toEqual([]);
  });

  it('resumes a paused account when its limit resets, or when its cap goes or rises past the reading', () => {
    const off = file('work', { disabled: true, status: 'disabled' });
    const plan = (state: Partial<ReserveState>, nowMs = now) => summary(reservePlan(input({ disabled: [off], state, nowMs })));
    expect(plan({ caps: { [key('work')]: 80 }, paused: { [key('work')]: paused() } })).toEqual([]);
    expect(plan({ caps: { [key('work')]: 80 }, paused: { [key('work')]: paused() } }, now + DAY)).toEqual(['resume work.json::work (reset)']);
    expect(plan({ paused: { [key('work')]: paused() } })).toEqual(['resume work.json::work (cap)']);
    expect(plan({ caps: { [key('work')]: 90 }, paused: { [key('work')]: paused() } })).toEqual(['resume work.json::work (cap)']);
    // A lower cap keeps it paused, under the new cap.
    expect(plan({ caps: { [key('work')]: 70 }, paused: { [key('work')]: paused() } })).toEqual([`update work.json::work to 81% of 7-day window at 70% until ${DAY}`]);
    // An account turned off by hand is never turned on.
    expect(plan({ caps: { [key('work')]: 80 } }, now + 10 * DAY)).toEqual([]);
  });

  it('judges a paused account on the reading that paused it when its cap or hidden limits change', () => {
    const off = file('work', { disabled: true, status: 'disabled' });
    // Paused at 90%: the 5-hour window got there too, but the 7-day window resets last.
    const atCap = paused({ cap: 90, percentUsed: 91, resumeAtMs: now + 3 * DAY + MINUTE });
    const plan = (cap: number, hidden: string[] = [], nowMs = now) => summary(reservePlan(input({
      disabled: [off],
      quotas: { [key('work')]: claude({ fiveHour: 92, week: 91 }) },
      hidden: { claude: hidden },
      state: { caps: { [key('work')]: cap }, paused: { [key('work')]: atCap } },
      nowMs,
    })));
    expect(plan(90)).toEqual([]);
    // Nothing is at 95%, so it's back straight away.
    expect(plan(95)).toEqual(['resume work.json::work (cap)']);
    // The 5-hour window is still at 92%, so it waits for that one instead.
    expect(plan(92)).toEqual([`update work.json::work to 92% of 5-hour window at 92% until ${2 * HOUR + MINUTE}`]);
    expect(plan(85)).toEqual([`update work.json::work to 91% of 7-day window at 85% until ${3 * DAY + MINUTE}`]);
    // Hidden limits don't count.
    expect(plan(90, ['7-day window'])).toEqual([`update work.json::work to 92% of 5-hour window at 90% until ${2 * HOUR + MINUTE}`]);
    expect(plan(90, ['7-day window', '5-hour window'])).toEqual(['resume work.json::work (cap)']);
    // With the 5-hour window reset since, hiding the 7-day one brings it straight back, and that's no reset.
    expect(plan(90, ['7-day window'], now + 3 * HOUR)).toEqual(['resume work.json::work (cap)']);
  });

  it('waits out a limit that reset since the pause, rather than coming back early', () => {
    const off = file('work', { disabled: true, status: 'disabled' });
    const atCap = paused({ window: '5-hour window', cap: 90, percentUsed: 95, resumeAtMs: now + 2 * HOUR + MINUTE });
    const plan = (nowMs: number) => summary(reservePlan(input({
      disabled: [off],
      quotas: { [key('work')]: claude({ fiveHour: 95 }) },
      state: { caps: { [key('work')]: 90 }, paused: { [key('work')]: atCap } },
      nowMs,
    })));
    // The window reset a moment ago; Arbor gives the provider a minute.
    expect(plan(now + 2 * HOUR + MINUTE / 2)).toEqual([]);
    expect(plan(now + 2 * HOUR + MINUTE)).toEqual(['resume work.json::work (reset)']);
  });

  it('marks the caps that bring a paused account straight back', () => {
    const atCap = paused({ cap: 90, percentUsed: 91, resumeAtMs: now + 3 * DAY + MINUTE });
    const choices = (quota?: QuotaState) => [null, 95, 92, 90].filter((cap) => resumesWithCap(atCap, quota, cap, [], now));
    expect(choices(claude({ fiveHour: 92, week: 91 }))).toEqual([null, 95]);
    // Without the reading, only the limit that paused it is known.
    expect(choices()).toEqual([null, 95, 92]);
  });

  it('respects an account turned back on by hand, and forgets one gone from the listing once it would be back', () => {
    const state = { caps: { [key('work')]: 80 }, paused: { [key('work')]: paused() } };
    expect(summary(reservePlan(input({ enabled: [file('work')], quotas: { [key('work')]: claude({ week: 85 }) }, state }))))
      .toEqual([`forget work.json::work until ${DAY}`]);
    // Mid-rename, or deleted: kept until its reset so the new file can still be turned back on.
    expect(reservePlan(input({ state }))).toEqual([]);
    expect(summary(reservePlan(input({ state, nowMs: now + DAY })))).toEqual(['forget work.json::work']);
  });
});

describe('pausing through the core', () => {
  beforeEach(() => resetAccountReserves());

  it('turns accounts off and on, remembers which it paused, and keeps going past a failure', async () => {
    const calls: unknown[] = [];
    const api = {
      patch: async (path: string, body: Record<string, unknown>) => {
        calls.push({ path, ...body });
        if (body.name === 'broken.json') throw new Error('core unavailable');
        return {};
      },
    };
    setAccountReserve(key('work'), 80);
    setAccountReserve(key('broken'), 80);
    const steps = reservePlan(input({
      enabled: [file('work'), file('broken')],
      quotas: { [key('work')]: claude({ week: 81 }), [key('broken')]: claude({ week: 95 }) },
      state: getAccountReserves(),
    }));
    const { done, failed } = await applyReserveSteps(steps, api);
    expect(calls).toEqual([
      { path: '/auth-files/status', name: 'work.json', disabled: true },
      { path: '/auth-files/status', name: 'broken.json', disabled: true },
    ]);
    expect(done.map((step) => step.key)).toEqual([key('work')]);
    expect(failed).toMatchObject([{ error: 'core unavailable' }]);
    expect(Object.keys(getAccountReserves().paused)).toEqual([key('work')]);

    // Resumed by hand before the reset: left on until then.
    await resumePausedAccount(key('work'), file('work', { disabled: true }), api);
    expect(lastItem(calls)).toEqual({ path: '/auth-files/status', name: 'work.json', disabled: false });
    expect(getAccountReserves().paused).toEqual({});
    expect(getAccountReserves().skipUntil).toEqual({ [key('work')]: now + 3 * DAY + MINUTE });
    // Setting a cap again applies it straight away.
    setAccountReserve(key('work'), 75);
    expect(getAccountReserves().skipUntil).toEqual({});
  });

  it('keeps a paused account paused on its new limit without asking the core', async () => {
    const calls: unknown[] = [];
    const api = { patch: async (path: string, body: Record<string, unknown>) => { calls.push({ path, ...body }); return {}; } };
    resetAccountReserves({ caps: { [key('work')]: 92 }, paused: { [key('work')]: paused() }, skipUntil: {} });
    const moved = paused({ window: '5-hour window', cap: 92, percentUsed: 92, resumeAtMs: now + 2 * HOUR + MINUTE });
    const { done } = await applyReserveSteps([{ kind: 'update', key: key('work'), paused: moved }], api);
    expect(calls).toEqual([]);
    expect(getAccountReserves().paused).toEqual({ [key('work')]: moved });
    expect(reserveNotifications(done, t, now)).toEqual([]);
  });

  it('moves caps and paused accounts to a credential’s new key', () => {
    resetAccountReserves({ caps: { old: 80, other: 90 }, paused: { old: paused() }, skipUntil: { old: now } });
    renameReserveKeys([{ from: 'old', to: 'new' }]);
    expect(getAccountReserves()).toEqual({ caps: { other: 90, new: 80 }, paused: { new: paused() }, skipUntil: { new: now } });
  });
});

describe('alerts', () => {
  it('says what reached the cap, until when, and when an account is back', () => {
    const pause = reservePlan(input({
      enabled: [file('work')],
      quotas: { [key('work')]: claude({ week: 81 }) },
      state: { caps: { [key('work')]: 80 } },
    }));
    expect(reserveNotifications(pause, t, now)).toEqual([{
      title: 'Claude account paused',
      body: 'work has used 81% of its 7-day window, past the 80% you set. Arbor turned it off in the proxy until that resets in 3d 0h. No other Claude account is in use, so Claude requests through the proxy will fail until then.',
      kind: 'accountPaused',
      urgent: true,
      subject: { account: key('work') },
    }]);
    const off = file('work', { disabled: true });
    const resumed = reservePlan(input({ disabled: [off], state: { caps: { [key('work')]: 80 }, paused: { [key('work')]: paused({ name: 'Work Max' }) } }, nowMs: now + DAY }));
    expect(reserveNotifications(resumed, t, now + DAY)).toEqual([{
      title: 'Claude account back in use',
      body: 'Work Max’s 7-day window reset, so Arbor turned it back on.',
      kind: 'accountResumed',
      subject: { account: key('work') },
    }]);
    // Resuming because the cap changed is the person's own doing, and forgetting is bookkeeping.
    const quiet = reservePlan(input({ disabled: [off], state: { paused: { [key('work')]: paused() } } }));
    expect(summary(quiet)).toEqual(['resume work.json::work (cap)']);
    expect(reserveNotifications(quiet, t, now)).toEqual([]);
  });
});

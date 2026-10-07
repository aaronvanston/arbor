import { describe, expect, test } from 'bun:test';
import type { HealthPoint, MachineHealth, MachineSessions } from '../src/native/types';
import type { FleetSession } from '../src/services/fleetBoard';
import { healthReasonText, homeAccounts, homeMachines, proxyFlow, todayRange } from '../src/services/homeOverview';
import { providerLimits } from '../src/services/providerLimits';
import { quotaKey, type AuthFile, type QuotaState } from '../src/services/quotaService';
import { itemAt } from './support/items';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const health = (machine: string, fields: Partial<MachineHealth> = {}) => ({ machine, local: false, status: 'healthy', ...fields }) as MachineHealth;
const today = (machine: string, requests: number) => ({ machine, requests, estimatedCost: requests / 10, pricedRequests: requests }) as MachineSessions;
const row = (machine: string, status: FleetSession['status'], fields: Partial<FleetSession> = {}) =>
  ({ machine, status, countsAsWaiting: status === 'approval' || status === 'question', snoozedUntilMs: null, ...fields }) as FleetSession;

describe('home machines', () => {
  test('puts this machine first, keeps the rest in Machines’ order, then ones only seen today, then ones with no host', () => {
    const machines = homeMachines(
      [health('lab'), health('spare', { status: 'unconfigured' }), health('studio', { local: true }), health('mini')],
      [today('mini', 40), today('runner', 12), today('', 5)],
      null,
      'studio',
    );
    expect(machines.map((item) => item.machine)).toEqual(['studio', 'lab', 'mini', 'runner', 'spare']);
    expect(itemAt(machines, 0).thisMachine).toBe(true);
    // Sessions Arbor couldn't place on a machine aren't a card.
    expect(machines.some((item) => item.machine === '')).toBe(false);
  });

  test('joins today’s use and the live board by machine name', () => {
    const [studio, lab] = homeMachines(
      [health('studio', { local: true }), health('lab')],
      [today('studio', 71)],
      { rows: [row('studio', 'working'), row('studio', 'approval'), row('studio', 'question'), row('lab', 'working'), row('lab', 'done')] },
      'studio',
    );
    expect(studio).toMatchObject({ working: 1, waiting: 2, today: { requests: 71 } });
    expect(lab).toMatchObject({ working: 1, waiting: 0, today: null });
  });

  test('leaves snoozed sessions out of what’s working and waiting', () => {
    const [studio] = homeMachines(
      [health('studio', { local: true })],
      [],
      { rows: [row('studio', 'approval', { snoozedUntilMs: NOW + HOUR }), row('studio', 'working', { snoozedUntilMs: NOW + HOUR })] },
      'studio',
    );
    expect(studio).toMatchObject({ working: 0, waiting: 0 });
  });

  test('adds a machine the board knows but Machines doesn’t, with no health', () => {
    const machines = homeMachines([health('studio', { local: true })], [], { rows: [row('runner', 'working')] }, 'studio');
    expect(itemAt(machines, 1)).toMatchObject({ machine: 'runner', health: null, working: 1 });
  });
});

describe('home accounts', () => {
  const file = (name: string): AuthFile => ({ name: `${name}.json`, provider: 'codex', type: 'codex' }) as AuthFile;
  const quota = (percent: number | null, plan?: string): QuotaState => ({
    status: 'success',
    plan,
    rows: percent === null ? [] : [{ label: 'Weekly limit', remainingPercent: percent, resetAtMs: NOW + 24 * HOUR, windowMs: 7 * 24 * HOUR }],
  });

  test('lists each account in the provider’s order with its plan, what’s left and its pace', () => {
    const [main, team, fresh] = [file('codex-main'), file('codex-team'), file('codex-new')];
    const quotas = { [quotaKey(main)]: quota(80, 'pro'), [quotaKey(team)]: quota(4, 'team'), [quotaKey(fresh)]: quota(null) };
    const limits = providerLimits([main, team, fresh], quotas, {}, { hidden: {}, headline: {} }, NOW);
    const accounts = homeAccounts(itemAt(limits, 0), NOW);
    expect(accounts.map((item) => item.name)).toEqual(['codex-main', 'codex-team', 'codex-new']);
    expect(itemAt(accounts, 0)).toMatchObject({ plan: 'Pro', percent: 80, resetAtMs: NOW + 24 * HOUR, tone: 'success', stale: false });
    expect(itemAt(accounts, 1)).toMatchObject({ plan: 'Team', percent: 4, tone: 'error' });
    expect(itemAt(accounts, 2)).toMatchObject({ plan: null, percent: null, tone: 'muted' });
  });

  test('marks an account held over from an earlier check', () => {
    const main = file('codex-main');
    const limits = providerLimits([main], { [quotaKey(main)]: { ...quota(50), staleSinceMs: NOW - HOUR, fetchedAt: NOW - 2 * HOUR } }, {}, { hidden: {}, headline: {} }, NOW);
    expect(itemAt(homeAccounts(itemAt(limits, 0), NOW), 0).stale).toBe(true);
  });

  describe('in the order the proxy tries them', () => {
    const listed = (...entries: [AuthFile, Record<string, unknown>][]) => {
      const files = entries.map(([item, fields]) => ({ ...item, ...fields }) as AuthFile);
      const quotas = Object.fromEntries(files.map((item) => [quotaKey(item), quota(60)]));
      const limit = itemAt(providerLimits(files, quotas, {}, { hidden: {}, headline: {} }, NOW), 0);
      return homeAccounts(limit, NOW, new Map(files.map((item) => [quotaKey(item), item])));
    };
    const [main, team, spare] = [file('codex-main'), file('codex-team'), file('codex-spare')];

    test('puts higher priorities first and keeps the saved order within one', () => {
      const accounts = listed([main, {}], [team, { priority: 5 }], [spare, { priority: '5' }]);
      expect(accounts.map((item) => [item.name, item.priority])).toEqual([['codex-team', 5], ['codex-spare', 5], ['codex-main', 0]]);
    });

    test('marks the accounts new requests go to: every ready one in the highest priority with any', () => {
      const accounts = listed([main, { priority: 1 }], [team, { priority: 5 }], [spare, { priority: 5 }]);
      expect(accounts.map((item) => [item.name, item.taking])).toEqual([['codex-team', true], ['codex-spare', true], ['codex-main', false]]);
    });

    test('moves down a priority when every account above it is skipped, and says why each one is', () => {
      const back = new Date(NOW + 3 * HOUR).toISOString();
      const accounts = listed(
        [main, {}],
        [team, { priority: 9, unavailable: true, status: 'error', status_message: 'quota exhausted', next_retry_after: back, cooldowns: [{ scope: 'credential', reason: 'credential_quota', retry_at: back }] }],
        [spare, { priority: 7, disabled: true }],
      );
      expect(accounts.map((item) => [item.name, item.state.kind, item.taking])).toEqual([
        ['codex-team', 'limit', false],
        ['codex-spare', 'off', false],
        ['codex-main', 'ready', true],
      ]);
      expect(itemAt(accounts, 0).state).toEqual({ kind: 'limit', backAtMs: NOW + 3 * HOUR });
    });

    test('takes nothing when no account can be used', () => {
      const accounts = listed([main, { disabled: true }], [team, { status: 'error', status_message: 'invalid_grant', unavailable: true }]);
      expect(accounts.some((item) => item.taking)).toBe(false);
      expect(accounts.map((item) => item.state.kind)).toEqual(['off', 'signin']);
    });

    test('treats an account the core hasn’t listed as ready', () => {
      const limit = itemAt(providerLimits([main], { [quotaKey(main)]: quota(60) }, {}, { hidden: {}, headline: {} }, NOW), 0);
      expect(itemAt(homeAccounts(limit, NOW), 0)).toMatchObject({ priority: 0, state: { kind: 'ready' }, taking: true });
    });
  });
});

describe('proxy flow', () => {
  test('counts the machines that sent requests today and the accounts the core could use now', () => {
    const machines = homeMachines([health('studio', { local: true }), health('lab'), health('mini')], [today('studio', 71), today('mini', 0)], null, 'studio');
    const files = [
      { name: 'a.json', provider: 'codex' },
      { name: 'b.json', provider: 'codex', disabled: true },
      { name: 'c.json', provider: 'claude', status: 'error', status_message: 'invalid_grant', unavailable: true },
    ] as AuthFile[];
    expect(proxyFlow(machines, { files, disabled: [], error: '' }, NOW)).toEqual({ machines: { count: 3, sentToday: 1 }, accounts: { count: 3, ready: 1, off: 0, failed: false } });
  });

  test('counts accounts that are turned off, and says a list that failed is unknown rather than empty', () => {
    const off = [{ name: 'a.json', provider: 'codex', disabled: true }] as AuthFile[];
    expect(proxyFlow(null, { files: [], disabled: off, error: '' }, NOW).accounts).toEqual({ count: 1, ready: 0, off: 1, failed: false });
    expect(proxyFlow(null, { files: [], disabled: [], error: 'connection refused' }, NOW).accounts).toEqual({ count: 0, ready: 0, off: 0, failed: true });
    // Accounts from an earlier listing are still known after a later one fails.
    expect(proxyFlow(null, { files: [], disabled: off, error: 'connection refused' }, NOW).accounts?.failed).toBe(false);
    expect(proxyFlow(null, { files: [], disabled: [], error: '' }, NOW).accounts).toEqual({ count: 0, ready: 0, off: 0, failed: false });
  });

  test('leaves an end blank until it has been read', () => {
    expect(proxyFlow(null, null, NOW)).toEqual({ machines: null, accounts: null });
  });
});

describe('health reason', () => {
  test('says what pulls the score down in Machines’ words', () => {
    const latest = { diskFreeKb: 41 * 1024 * 1024 } as HealthPoint;
    expect(healthReasonText({ metric: 'disk', value: 91 }, latest)).toEqual({ key: 'machines.health.reason.disk', variables: { free: '41 GB' } });
    expect(healthReasonText({ metric: 'memory', value: 86.6 }, latest)).toEqual({ key: 'machines.health.reason.memory', variables: { value: 87 } });
    expect(healthReasonText({ metric: 'load', value: 1.234 }, latest)).toEqual({ key: 'machines.health.reason.load', variables: { value: '1.2' } });
  });
});

describe('today', () => {
  test('runs from local midnight to now', () => {
    const now = new Date(2026, 8, 27, 15, 30);
    expect(todayRange(now)).toEqual({ start: new Date(2026, 8, 27).toISOString(), end: now.toISOString() });
  });
});

import { afterEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { AccountRow, logText } from '../src/pages/AccountsRoutingPage';
import { DEFAULT_RESERVE, emptyAccessState, getReservePolicies, reservePolicyFor, setReservePolicy, type ModelAccessState } from '../src/services/extraModelHold';
import { learnReserves, reserveRound, type AccountReserve, type ReserveAccount } from '../src/services/modelReserves';
import { getRoutingAuto, setRoutingAuto } from '../src/services/quotaRouting';
import { quotaKey, type QuotaState } from '../src/services/quotaService';
import { fenceDecisions, getRoutingLog, parseRoutingLog, recordRoutingDecisions, ROUTING_LOG_MAX, type RoutingLogEntry } from '../src/services/routingLog';
import { logActionFor, routingOverview, takeLogAction } from '../src/services/routingOverview';

const PREVIEW = 'gpt-preview-latest';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const now = 1_800_000_000_000;
const reset = now + 3 * DAY;

const codex = (name: string, index: string, more: Record<string, unknown> = {}) => ({
  name, provider: 'codex', auth_index: index, status: 'active', source: 'file', account_type: 'oauth', ...more,
});
const files = [codex('cam-team.json', 'codex-1', { priority: 2 }), codex('cam-home.json', 'codex-2', { priority: 3 }), codex('cam-spare.json', 'codex-3', { disabled: true })];
const weekly = (left: number): QuotaState => ({ status: 'success', rows: [{ label: '7-day window', remainingPercent: left, resetAtMs: reset }] });
const state: ModelAccessState = {
  ...emptyAccessState(),
  providers: { codex: { models: [PREVIEW], accounts: ['cam-home.json', 'cam-team.json'], checkedAtMs: now } },
  access: { 'cam-team.json': { [PREVIEW]: 'yes' }, 'cam-home.json': { [PREVIEW]: 'no' } },
  usage: { [`codex/${PREVIEW}`]: { readAtMs: now, byAccount: { 'cam-team.json': 40 }, tokens: {} } },
};
const quotasWith = (team: number, home = 60) => ({ [quotaKey(files[0]!)]: weekly(team), [quotaKey(files[1]!)]: weekly(home) });

describe('Accounts › Routing', () => {
  it('lists accounts in the order the core tries them, with where each stands', () => {
    const [provider] = routingOverview({ files, quotas: quotasWith(1.5), profiles: {}, state, policies: {}, paused: {}, auto: { codex: true }, nowMs: now });
    expect(provider?.auto).toBe(true);
    expect(provider?.accounts.map((account) => [account.fileName, account.priority, account.standing])).toEqual([
      ['cam-home.json', 3, 'shared'],
      ['cam-team.json', 2, 'fenced'],
      ['cam-spare.json', 0, 'off'],
    ]);
    expect(provider?.claims).toEqual([{ model: PREVIEW, policy: DEFAULT_RESERVE, forecast: 0, safety: 2, holders: [{ name: 'cam-team.json', percent: 2 }] }]);
    const roomy = routingOverview({ files, quotas: quotasWith(60), profiles: {}, state, policies: {}, paused: { [quotaKey(files[1]!)]: { provider: 'codex', name: 'Home', pausedAtMs: now } as never }, auto: {}, nowMs: now });
    expect(roomy[0]?.accounts.map((account) => account.standing)).toEqual(['paused', 'reserved', 'off']);
  });

  it('works out a round’s fences, keeping one for an account with no reading', () => {
    expect(reserveRound(files, quotasWith(1.5), state, {}, now).fenced).toEqual({ 'cam-team.json': [PREVIEW] });
    const kept = reserveRound(files, { [quotaKey(files[1]!)]: weekly(60) }, { ...state, fenced: { 'cam-team.json': [PREVIEW] } }, {}, now);
    expect(kept.fenced).toEqual({ 'cam-team.json': [PREVIEW] });
    // Every other account out: the team account lends its reserve.
    const lending = reserveRound(files, quotasWith(1.5, 0), state, {}, now);
    expect(lending.fenced).toEqual({});
    expect(lending.reserves.get('cam-team.json')?.state).toBe('lending');
  });

  it('shows an account’s bar and reserve', () => {
    const reserve: AccountReserve = { models: [PREVIEW], percent: 3.5, remaining: 3, state: 'fenced', floor: 1, smart: true };
    const html = renderToStaticMarkup(<I18nProvider><AccountRow account={{ key: 'k', fileName: 'cam-team.json', name: 'Team', priority: 2, remaining: 3, resetAtMs: reset, standing: 'fenced', reserve }} place={1} now={now} /></I18nProvider>);
    expect(html).toContain('at its 3.5% reserve, serves only gpt-preview-latest');
    expect(html).toContain('Reserve only');
    expect(html).toContain('3% of its limit left, 3.5% of it kept in reserve');
  });
});

describe('tuning a smart reserve', () => {
  const account = (remaining: number, sinceMs = reset - WEEK): ReserveAccount => ({ name: 'cam-team.json', remaining, resetAtMs: sinceMs + WEEK, windowMs: WEEK, out: remaining < 1 });
  const reserve = (state: AccountReserve['state'], remaining: number): Map<string, AccountReserve> => new Map([['cam-team.json', { models: [PREVIEW], percent: 4, remaining, state, floor: 1, smart: true }]]);
  const after = (rounds: [number, AccountReserve['state']][]) => rounds.reduce(
    (learned, [remaining, standing]) => ({ ...learned, ...learnReserves(learned, 'codex', [account(remaining)], reserve(standing, remaining)) }),
    state,
  );
  const atReset = (learned: ModelAccessState) => learnReserves(learned, 'codex', [account(90, reset)], new Map()).tuning[`codex/${PREVIEW}`];

  it('raises the safety factor when a fenced reserve ran out, and lowers it when most went unused', () => {
    expect(atReset(after([[10, 'open'], [3, 'fenced'], [0.5, 'fenced']]))).toEqual({ safety: 2.5, resets: 1 });
    expect(atReset(after([[10, 'open'], [3.5, 'fenced']]))).toEqual({ safety: 1.75, resets: 1 });
    expect(atReset(after([[10, 'open'], [1, 'fenced']]))).toEqual({ safety: 2, resets: 1 });
  });

  it('learns nothing from a window that never reached its reserve, or lent it', () => {
    expect(atReset(after([[10, 'open']]))).toBeUndefined();
    expect(atReset(after([[3, 'fenced'], [2, 'lending'], [0.2, 'fenced']]))).toBeUndefined();
  });
});

describe('what Arbor changed', () => {
  afterEach(() => {
    recordRoutingDecisions([]);
    setReservePolicy('codex', PREVIEW, DEFAULT_RESERVE);
    setRoutingAuto('codex', false);
  });

  it('says which fences came and went, and why', () => {
    const decisions = fenceDecisions({ 'cam-old.json': [PREVIEW], 'cam-lend.json': [PREVIEW] }, { 'cam-team.json': [PREVIEW] }, () => 'codex', new Set(['cam-lend.json']), () => 4);
    expect(decisions).toEqual([
      { kind: 'fenced', provider: 'codex', account: 'cam-team.json', models: [PREVIEW], percent: 4 },
      { kind: 'opened', provider: 'codex', account: 'cam-lend.json', models: [PREVIEW], why: 'lending' },
      { kind: 'opened', provider: 'codex', account: 'cam-old.json', models: [PREVIEW], why: 'above' },
    ]);
  });

  it('keeps the newest, and reads back only what it can use', () => {
    recordRoutingDecisions(Array.from({ length: ROUTING_LOG_MAX + 5 }, () => ({ kind: 'order' as const, provider: 'codex', changes: [] })), now);
    expect(getRoutingLog()).toHaveLength(ROUTING_LOG_MAX);
    expect(parseRoutingLog(JSON.stringify({ entries: [{ id: 'a', atMs: 1, provider: 'codex', kind: 'nope' }, { id: 'b', atMs: 2, provider: 'codex', kind: 'fenced', account: 'x.json', models: [PREVIEW, 3], percent: 4 }] })))
      .toEqual([{ id: 'b', atMs: 2, provider: 'codex', kind: 'fenced', account: 'x.json', models: [PREVIEW], percent: 4 }]);
  });

  it('stops reserving for a fenced model, and Undo brings the reserve back', async () => {
    recordRoutingDecisions([{ kind: 'fenced', provider: 'codex', account: 'cam-team.json', models: [PREVIEW], percent: 4 }], now);
    const [entry] = getRoutingLog();
    expect(entry && logActionFor(entry)).toBe('stopReserving');
    const undo = await takeLogAction(entry!);
    expect(reservePolicyFor(getReservePolicies(), 'codex', PREVIEW).mode).toBe('never');
    expect(getRoutingLog()[0]?.acted).toBe(true);
    expect(logActionFor(getRoutingLog()[0]!)).toBeNull();
    await undo();
    expect(reservePolicyFor(getReservePolicies(), 'codex', PREVIEW)).toEqual(DEFAULT_RESERVE);
    expect(getRoutingLog()[0]?.acted).toBeUndefined();
  });

  it('puts priorities back with automatic order off, and Undo turns it back on', async () => {
    setRoutingAuto('codex', true);
    const applied: { fileName: string; suggested: number | null }[][] = [];
    const entry: RoutingLogEntry = { id: 'x', atMs: now, kind: 'order', provider: 'codex', changes: [{ fileName: 'cam-team.json', from: 1, to: 3 }] };
    const undo = await takeLogAction(entry, async (changes) => { applied.push(changes); });
    expect(applied).toEqual([[{ fileName: 'cam-team.json', suggested: 1 }]]);
    expect(getRoutingAuto().codex).toBe(false);
    await undo();
    expect(getRoutingAuto().codex).toBe(true);
    expect(logActionFor({ ...entry, changes: [] })).toBeNull();
    expect(logActionFor({ id: 'y', atMs: now, kind: 'opened', provider: 'codex', account: 'a', models: [], why: 'above' })).toBeNull();
  });

  it('says what each one did', () => {
    const names = { 'cam-team.json': 'Team' };
    expect(logText({ id: 'a', atMs: now, kind: 'fenced', provider: 'codex', account: 'cam-team.json', models: [PREVIEW], percent: 3.5 }, names))
      .toEqual({ key: 'accounts.routingView.log.fenced', values: { name: 'Team', percent: '3.5', model: PREVIEW } });
    expect(logText({ id: 'b', atMs: now, kind: 'order', provider: 'codex', changes: [{ fileName: 'cam-team.json', from: 1, to: 3 }] }, names))
      .toEqual({ key: 'accounts.routingView.log.orderOne', values: { provider: 'Codex', name: 'Team', from: 1, to: 3 } });
  });
});

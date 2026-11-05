import { describe, expect, it } from 'bun:test';
import {
  accessLine,
  accessSummary,
  checkModelAccess,
  desiredExclusions,
  emptyAccessState,
  exclusionChanges,
  fencesFrom,
  forecastUse,
  modelReserves,
  parseAccessState,
  providersWithNewAccounts,
  reconcileExclusions,
  refreshRecentUse,
  reserveLine,
  smartReserve,
  undoExclusionChanges,
  USAGE_READ_EVERY_MS,
  type AccessDeps,
  type ModelAccessState,
  type ReserveAccount,
} from '../src/services/extraModelAccess';
import type { ExtraModel, ExtraModelsView, UsageAnalysis, UsageQuery } from '../src/native/types';

const PREVIEW = 'gpt-preview-latest';
const now = 1_800_000_000_000;

const model = (id: string): ExtraModel => ({
  id, displayName: null, description: null, contextLength: null, maxCompletionTokens: null, thinking: null,
  inputModalities: [], outputModalities: [],
});
const view: ExtraModelsView = {
  providers: [{
    provider: 'codex',
    models: [model(PREVIEW)],
    catalog: [model('gpt-6-sol'), model('gpt-6-luna')],
    hasAccount: true,
    pluginInstalled: true,
    pluginLoaded: true,
  }],
  served: ['gpt-6-sol', 'gpt-6-luna', PREVIEW],
  coreRunning: true,
};
const codex = (name: string, index: string, more: Record<string, unknown> = {}) => ({
  name, provider: 'codex', auth_index: index, status: 'active', source: 'file', account_type: 'oauth', ...more,
});
const files = [codex('cam-team.json', 'codex-1'), codex('cam-home.json', 'codex-2'), codex('cam-spare.json', 'codex-3')];

const state = (more: Partial<ModelAccessState>): ModelAccessState => ({ ...emptyAccessState(), ...more });
const partial = state({
  providers: { codex: { models: [PREVIEW], accounts: ['cam-home.json', 'cam-spare.json', 'cam-team.json'], checkedAtMs: now } },
  access: {
    'cam-team.json': { [PREVIEW]: 'yes' },
    'cam-home.json': { [PREVIEW]: 'no' },
    'cam-spare.json': { [PREVIEW]: 'no' },
  },
});
const accounts = files.map((file) => file.name);

const noUsage = async (): Promise<UsageAnalysis> => ({ models: [], providers: [], sources: [], accounts: [], apiKeys: [] });
/** Usage with `byIndex` requests and failures for the preview model, a thousand tokens each, and `all` tokens in all. */
const usageOn = (byIndex: Record<string, [number, number]>, all: Record<string, number> = {}) => async (query: UsageQuery): Promise<UsageAnalysis> => ({
  models: [], providers: [], sources: [], apiKeys: [],
  accounts: query.model === PREVIEW
    ? Object.entries(byIndex).map(([authIndex, [requests, failures]]) => ({ authIndex, label: authIndex, requests, failures, tokens: requests * 1000 }))
    : Object.entries(all).map(([authIndex, tokens]) => ({ authIndex, label: authIndex, requests: 1, failures: 0, tokens })),
});

/** A proxy whose accounts each list the models given, answering `/api-call` by auth index. */
const proxy = (lists: Record<string, string[] | 'fails'>, patched: { name: string; excluded_models: string[] }[] = []) => ({
  post: async <T,>(_path: string, body?: unknown) => {
    const { authIndex } = body as { authIndex: string };
    const list = lists[authIndex];
    if (!list || list === 'fails') return { status_code: 401, body: JSON.stringify({ error: { message: 'expired' } }) } as T;
    return {
      status_code: 200,
      body: JSON.stringify({ models: list.map((slug) => ({ slug, visibility: slug === PREVIEW ? 'hide' : 'list' })) }),
    } as T;
  },
  patch: async <T,>(_path: string, body?: unknown) => {
    patched.push(body as { name: string; excluded_models: string[] });
    return {} as T;
  },
});

const deps = (more: Partial<AccessDeps> = {}): AccessDeps => ({
  api: proxy({}),
  excludedModels: async () => ({ kind: 'rules', rules: [] }),
  usage: noUsage,
  nowMs: now,
  ...more,
});

describe('which accounts have an extra model', () => {
  it('takes a model a list hides from pickers as the account’s, and one only another account lists as missing', async () => {
    const { state: checked, live } = await checkModelAccess(view, files, emptyAccessState(), deps({
      api: proxy({ 'codex-1': ['gpt-6-sol', PREVIEW], 'codex-2': ['gpt-6-sol'], 'codex-3': 'fails' }),
    }));
    expect(checked.access['cam-team.json']).toEqual({ [PREVIEW]: 'yes' });
    expect(checked.access['cam-home.json']).toEqual({ [PREVIEW]: 'no' });
    // An account that couldn't be asked isn't known either way.
    expect(checked.access['cam-spare.json']).toEqual({});
    expect(checked.providers.codex?.accounts).toEqual(['cam-home.json', 'cam-spare.json', 'cam-team.json']);
    // Hidden models aren't suggested, and the accounts' lists are merged for suggestions.
    expect(live.codex).toEqual({ ok: true, models: [{ id: 'gpt-6-sol', displayName: null, details: null }] });
  });

  it('doesn’t take a model no list has as missing: it may work before it’s listed', async () => {
    const { state: checked } = await checkModelAccess(view, files, emptyAccessState(), deps({
      api: proxy({ 'codex-1': ['gpt-6-sol'], 'codex-2': ['gpt-6-sol'], 'codex-3': ['gpt-6-sol'] }),
    }));
    expect(Object.values(checked.access).every((models) => !(PREVIEW in models))).toBe(true);
  });

  it('counts a request that worked as proof, and keeps what was known about an account it couldn’t ask', async () => {
    const before = state({ access: { 'cam-spare.json': { [PREVIEW]: 'no' } } });
    const { state: checked } = await checkModelAccess(view, files, before, deps({
      api: proxy({ 'codex-1': [PREVIEW], 'codex-2': ['gpt-6-sol'], 'codex-3': 'fails' }),
      usage: usageOn({ 'codex-2': [5, 1], 'codex-3': [3, 3] }),
    }));
    expect(checked.access['cam-home.json']).toEqual({ [PREVIEW]: 'yes' });
    expect(checked.access['cam-spare.json']).toEqual({ [PREVIEW]: 'no' });
    expect(checked.usage[`codex/${PREVIEW}`]).toEqual({ readAtMs: now, byAccount: { 'cam-home.json': 4 }, tokens: { 'cam-home.json': 5000 } });
  });

  it('forgets accounts that have gone', async () => {
    const before = state({ access: { 'cam-gone.json': { [PREVIEW]: 'yes' } }, added: { 'cam-gone.json': [PREVIEW] } });
    const { state: checked } = await checkModelAccess(view, files, before, deps());
    expect(checked.access['cam-gone.json']).toBeUndefined();
    expect(checked.added['cam-gone.json']).toBeUndefined();
  });

  it('says where a model is in a row', () => {
    const names = { 'cam-team.json': 'Team', 'cam-home.json': 'Home', 'cam-spare.json': 'Spare' };
    expect(accessLine(accessSummary(partial, PREVIEW, accounts), 'Codex', names)).toEqual({ key: 'extraModels.access.only', values: { names: 'Team' } });
    const everywhere = state({ access: Object.fromEntries(accounts.map((name) => [name, { [PREVIEW]: 'yes' as const }])) });
    expect(accessLine(accessSummary(everywhere, PREVIEW, accounts), 'Codex', names)?.key).toBe('extraModels.access.everywhere');
    const worked = state({ access: { 'cam-team.json': { [PREVIEW]: 'yes' } } });
    expect(accessLine(accessSummary(worked, PREVIEW, accounts), 'Codex', names)?.key).toBe('extraModels.access.workedOn');
    expect(accessLine(accessSummary(emptyAccessState(), PREVIEW, accounts), 'Codex', names)?.key).toBe('extraModels.access.unknown');
    expect(accessLine(accessSummary(emptyAccessState(), PREVIEW, []), 'Codex', names)).toBeNull();
  });

  it('reads back only what it can use from storage', () => {
    const parsed = parseAccessState(JSON.stringify({ access: { 'a.json': { x: 'yes', y: 'maybe' } }, added: { 'a.json': ['x', 3] }, usage: { 'codex/x': { readAtMs: 5, byAccount: { 'a.json': 2, 'b.json': -1 } } } }));
    expect(parsed.access).toEqual({ 'a.json': { x: 'yes' } });
    expect(parsed.added).toEqual({ 'a.json': ['x'] });
    expect(parsed.usage).toEqual({ 'codex/x': { readAtMs: 5, byAccount: { 'a.json': 2 }, tokens: {} } });
    expect(parsed.windows).toEqual({});
    expect(parsed.fenced).toEqual({});
  });
});

describe('reserves for an extra model', () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const reset = now + 3 * DAY;
  // This week the team account served 100k tokens of the preview, and 1M in all since its window began 4 days ago,
  // which cost 40% of its limit: the preview at the week's pace uses 4% × 3/7 before the reset.
  const used = state({
    ...partial,
    usage: { [`codex/${PREVIEW}`]: { readAtMs: now, byAccount: { 'cam-team.json': 40 }, tokens: { 'cam-team.json': 100_000 } } },
    windows: { 'cam-team.json': { sinceMs: reset - WEEK, tokens: 1_000_000, readAtMs: now } },
  });
  const account = (name: string, remaining: number | null, more: Partial<ReserveAccount> = {}): ReserveAccount =>
    ({ name, remaining, resetAtMs: reset, windowMs: WEEK, out: false, ...more });
  const roomy = [account('cam-team.json', 60), account('cam-home.json', 50), account('cam-spare.json', 30)];
  const policy = (more: Record<string, unknown>) => ({ [`codex/${PREVIEW}`]: { mode: 'auto' as const, percent: 10, lend: 'floor' as const, ...more } });
  const forecast = 0.1 * 40 * (3 / 7);

  it('forecasts the model’s use until the reset from the week, priced by the account’s window so far', () => {
    expect(forecastUse(used, 'codex', PREVIEW, roomy[0]!, now)).toBeCloseTo(forecast);
    expect(forecastUse(partial, 'codex', PREVIEW, roomy[0]!, now)).toBe(0);
    // Tokens read for an earlier window price this one wrongly.
    const stale = { ...used, windows: { 'cam-team.json': { sinceMs: reset - 2 * WEEK, tokens: 1_000_000, readAtMs: now } } };
    expect(forecastUse(stale, 'codex', PREVIEW, roomy[0]!, now)).toBeNull();
  });

  it('keeps twice the forecast, at least 2% until the last day, and at most a quarter', () => {
    expect(smartReserve(forecast, { resetAtMs: reset }, now)).toBe(3.5);
    expect(smartReserve(0.2, { resetAtMs: reset }, now)).toBe(2);
    expect(smartReserve(0.2, { resetAtMs: now + 6 * HOUR }, now)).toBe(0.5);
    expect(smartReserve(40, { resetAtMs: reset }, now)).toBe(25);
  });

  it('shares an account above its reserve like any other', () => {
    expect([...modelReserves(used, {}, 'codex', roomy, now)]).toEqual([
      ['cam-team.json', { models: [PREVIEW], percent: 3.5, remaining: 60, state: 'open', floor: 1, smart: true }],
    ]);
  });

  it('keeps nothing for a model unused this week, unless set to, and nothing when told not to', () => {
    expect(modelReserves(partial, {}, 'codex', roomy, now).size).toBe(0);
    expect(modelReserves(partial, policy({ mode: 'fixed', percent: 15 }), 'codex', roomy, now).get('cam-team.json')?.percent).toBe(15);
    expect(modelReserves(used, policy({ mode: 'never' }), 'codex', roomy, now).size).toBe(0);
    // Serving only the model is its excluded models' doing, whatever the limits say.
    expect(modelReserves(used, policy({ mode: 'only' }), 'codex', roomy, now).size).toBe(0);
  });

  it('fences an account at its reserve, so it serves only the model', () => {
    const atReserve = [account('cam-team.json', 3), ...roomy.slice(1)];
    const reserves = modelReserves(used, {}, 'codex', atReserve, now);
    expect(reserves.get('cam-team.json')?.state).toBe('fenced');
    expect(fencesFrom(reserves)).toEqual({ 'cam-team.json': [PREVIEW] });
  });

  it('lends the reserve once every other account is out, down to its floor, as the policy says', () => {
    const othersOut = (left: number) => [account('cam-team.json', left), account('cam-home.json', 0.5), account('cam-spare.json', 40, { out: true })];
    expect(modelReserves(used, {}, 'codex', othersOut(3), now).get('cam-team.json')).toMatchObject({ state: 'lending', floor: 1 });
    expect(modelReserves(used, {}, 'codex', othersOut(1), now).get('cam-team.json')?.state).toBe('fenced');
    expect(modelReserves(used, policy({ lend: 'all' }), 'codex', othersOut(0.5), now).get('cam-team.json')?.state).toBe('lending');
    expect(modelReserves(used, policy({ lend: 'hold' }), 'codex', othersOut(3), now).get('cam-team.json')?.state).toBe('fenced');
    // An account with no reading could still take requests, so nothing is lent yet.
    const unread = [account('cam-team.json', 3), account('cam-home.json', null), account('cam-spare.json', 0.2, { out: true })];
    expect(modelReserves(used, {}, 'codex', unread, now).get('cam-team.json')?.state).toBe('fenced');
  });

  it('splits the forecast between the accounts with the model', () => {
    const both = { ...used, access: { ...used.access, 'cam-home.json': { [PREVIEW]: 'yes' as const } } };
    const reserves = modelReserves(both, policy({ mode: 'fixed', percent: 8 }), 'codex', roomy, now);
    expect([...reserves.keys()].sort()).toEqual(['cam-home.json', 'cam-team.json']);
  });

  it('says where the reserve stands in a row', () => {
    const names = { 'cam-team.json': 'Team' };
    const open = [...modelReserves(used, {}, 'codex', roomy, now)];
    expect(reserveLine('auto', 40, open, names)).toEqual({ key: 'extraModels.reserve.state.smart', values: { percent: '3.5', count: 40 } });
    const fenced = [...modelReserves(used, {}, 'codex', [account('cam-team.json', 2), ...roomy.slice(1)], now)];
    expect(reserveLine('auto', 40, fenced, names)).toEqual({ key: 'extraModels.reserve.state.fenced', values: { name: 'Team', percent: '8.5' } });
    expect(reserveLine('auto', 0, [], names).key).toBe('extraModels.reserve.state.idle');
    expect(reserveLine('fixed', 0, [], names).key).toBe('extraModels.reserve.state.unread');
    expect(reserveLine('only', 0, [], names).key).toBe('extraModels.reserve.state.only');
  });

  it('reads use again only when it’s an hour old and sizes a smart reserve, and an account’s window when it began again', async () => {
    let reads = 0;
    const counting = async (query: UsageQuery) => {
      reads += 1;
      return usageOn({ 'codex-1': [7, 0] }, { 'codex-1': 2_000_000 })(query);
    };
    const starts = { 'cam-team.json': reset - WEEK };
    expect(await refreshRecentUse(used, {}, files, { usage: counting, nowMs: now + 60_000 }, starts)).toBeNull();
    expect(await refreshRecentUse(used, policy({ mode: 'fixed' }), files, { usage: counting, nowMs: now + USAGE_READ_EVERY_MS }, starts)).toBeNull();
    const began = await refreshRecentUse(used, {}, files, { usage: counting, nowMs: now + 60_000 }, { 'cam-team.json': reset }, );
    expect(began?.windows['cam-team.json']).toEqual({ sinceMs: reset, tokens: 2_000_000, readAtMs: now + 60_000 });
    expect(began?.usage).toEqual(used.usage);
    const fresh = await refreshRecentUse(used, {}, files, { usage: counting, nowMs: now + USAGE_READ_EVERY_MS }, starts);
    expect(fresh?.usage[`codex/${PREVIEW}`]).toEqual({ readAtMs: now + USAGE_READ_EVERY_MS, byAccount: { 'cam-team.json': 7 }, tokens: { 'cam-team.json': 7000 } });
    expect(reads).toBe(3);
  });

  it('checks a provider again when its usable accounts change', () => {
    expect(providersWithNewAccounts(partial, files)).toEqual([]);
    expect(providersWithNewAccounts(partial, [...files, codex('cam-new.json', 'codex-4')])).toEqual(['codex']);
    expect(providersWithNewAccounts(partial, [...files.slice(1), codex('cam-team.json', 'codex-1', { disabled: true })])).toEqual(['codex']);
  });
});

describe('keeping an extra model from accounts without it', () => {
  const base = { state: partial, policies: {}, provider: 'codex', models: [PREVIEW], everyModel: ['gpt-6-sol', 'gpt-6-luna', PREVIEW], accounts, usable: accounts };

  it('keeps it from the accounts that lack it, unless someone undid that', () => {
    expect(desiredExclusions(base)).toEqual({ 'cam-team.json': [], 'cam-home.json': [PREVIEW], 'cam-spare.json': [PREVIEW] });
    const declined = { ...partial, declined: { 'cam-home.json': [PREVIEW] } };
    expect(desiredExclusions({ ...base, state: declined })['cam-home.json']).toEqual([]);
  });

  it('keeps every other model from accounts set to serve only it, but never from all of them', () => {
    const only = { [`codex/${PREVIEW}`]: { mode: 'only' as const, percent: 10, lend: 'floor' as const } };
    expect(desiredExclusions({ ...base, policies: only })['cam-team.json']).toEqual(['gpt-6-luna', 'gpt-6-sol']);
    const everywhere = state({ access: Object.fromEntries(accounts.map((name) => [name, { [PREVIEW]: 'yes' as const }])) });
    expect(desiredExclusions({ ...base, state: everywhere, policies: only })['cam-team.json']).toEqual([]);
  });

  it('keeps every other model from an account at its reserve', () => {
    expect(desiredExclusions({ ...base, state: { ...partial, fenced: { 'cam-team.json': [PREVIEW] } } })['cam-team.json']).toEqual(['gpt-6-luna', 'gpt-6-sol']);
    // A fence for a model that has gone fences nothing.
    expect(desiredExclusions({ ...base, state: { ...partial, fenced: { 'cam-team.json': ['gpt-old'] } } })['cam-team.json']).toEqual([]);
  });

  it('leaves rules someone added alone, and takes back only Arbor’s', () => {
    const changes = exclusionChanges(
      { 'cam-home.json': ['codex-mini-latest'], 'cam-spare.json': [PREVIEW], 'cam-team.json': [PREVIEW, 'gpt-6-sol'] },
      { 'cam-team.json': [PREVIEW] },
      { 'cam-home.json': [PREVIEW], 'cam-spare.json': [PREVIEW], 'cam-team.json': [] },
    );
    expect(changes).toEqual([
      { fileName: 'cam-home.json', before: ['codex-mini-latest'], after: ['codex-mini-latest', PREVIEW], addedBefore: [], addedAfter: [PREVIEW] },
      { fileName: 'cam-team.json', before: [PREVIEW, 'gpt-6-sol'], after: ['gpt-6-sol'], addedBefore: [PREVIEW], addedAfter: [] },
    ]);
  });

  it('changes only the excluded models, and an Undo leaves the model going everywhere', async () => {
    const patched: { name: string; excluded_models: string[] }[] = [];
    const rules: Record<string, string[]> = { 'cam-home.json': ['codex-mini-latest'] };
    const { changes, state: after } = await reconcileExclusions(view, files, partial, {}, {
      api: proxy({}, patched),
      excludedModels: async (name) => ({ kind: 'rules', rules: rules[name] ?? [] }),
    });
    expect(patched).toEqual([
      { name: 'cam-home.json', excluded_models: ['codex-mini-latest', PREVIEW] },
      { name: 'cam-spare.json', excluded_models: [PREVIEW] },
    ]);
    expect(after.added).toEqual({ 'cam-home.json': [PREVIEW], 'cam-spare.json': [PREVIEW] });

    const undone = await undoExclusionChanges(changes, after, proxy({}, patched), true);
    expect(patched.slice(2)).toEqual([
      { name: 'cam-home.json', excluded_models: ['codex-mini-latest'] },
      { name: 'cam-spare.json', excluded_models: [] },
    ]);
    expect(undone.added).toEqual({});
    expect(undone.declined).toEqual({ 'cam-home.json': [PREVIEW], 'cam-spare.json': [PREVIEW] });
    // The next check leaves them be.
    const again = await reconcileExclusions(view, files, undone, {}, { api: proxy({}, patched), excludedModels: async () => ({ kind: 'rules', rules: [] }) });
    expect(again.changes).toEqual([]);
  });

  it('fences an account at its reserve and opens it again, taking back only the rules it added', async () => {
    const patched: { name: string; excluded_models: string[] }[] = [];
    const rules: Record<string, string[]> = { 'cam-home.json': [PREVIEW], 'cam-spare.json': [PREVIEW], 'cam-team.json': ['codex-mini-latest'] };
    const fencedState = { ...partial, added: { 'cam-home.json': [PREVIEW], 'cam-spare.json': [PREVIEW] }, fenced: { 'cam-team.json': [PREVIEW] } };
    const excludedModels = async (name: string) => ({ kind: 'rules' as const, rules: rules[name] ?? [] });
    const fenced = await reconcileExclusions(view, files, fencedState, {}, { api: proxy({}, patched), excludedModels });
    expect(patched).toEqual([{ name: 'cam-team.json', excluded_models: ['codex-mini-latest', 'gpt-6-luna', 'gpt-6-sol'] }]);
    rules['cam-team.json'] = ['codex-mini-latest', 'gpt-6-luna', 'gpt-6-sol'];
    await reconcileExclusions(view, files, { ...fenced.state, fenced: {} }, {}, { api: proxy({}, patched), excludedModels });
    expect(patched[1]).toEqual({ name: 'cam-team.json', excluded_models: ['codex-mini-latest'] });
  });

  it('stops at a failed change and says why, keeping the ones made to undo', async () => {
    let calls = 0;
    const failing = {
      ...proxy({}),
      patch: async <T,>() => {
        calls += 1;
        if (calls === 2) throw new Error('proxy stopped');
        return {} as T;
      },
    };
    const result = await reconcileExclusions(view, files, partial, {}, { api: failing, excludedModels: async () => ({ kind: 'rules', rules: [] }) });
    expect(result.changes.map((change) => change.fileName)).toEqual(['cam-home.json']);
    expect(result.error).toContain('proxy stopped');
    expect(result.state.added).toEqual({ 'cam-home.json': [PREVIEW] });
  });
});

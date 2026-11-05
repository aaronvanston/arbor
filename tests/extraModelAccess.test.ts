import { describe, expect, it } from 'bun:test';
import {
  accessLine,
  accessSummary,
  checkModelAccess,
  desiredExclusions,
  emptyAccessState,
  exclusionChanges,
  heldAccounts,
  holdLine,
  parseAccessState,
  providersWithNewAccounts,
  reconcileExclusions,
  refreshRecentUse,
  undoExclusionChanges,
  USAGE_READ_EVERY_MS,
  type AccessDeps,
  type ModelAccessState,
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
const usageOn = (byIndex: Record<string, [number, number]>) => async (query: UsageQuery): Promise<UsageAnalysis> => ({
  models: [], providers: [], sources: [], apiKeys: [],
  accounts: query.model === PREVIEW
    ? Object.entries(byIndex).map(([authIndex, [requests, failures]]) => ({ authIndex, label: authIndex, requests, failures, tokens: 0 }))
    : [],
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
    expect(checked.usage[`codex/${PREVIEW}`]).toEqual({ readAtMs: now, byAccount: { 'cam-home.json': 4 } });
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
    expect(parsed.usage).toEqual({ 'codex/x': { readAtMs: 5, byAccount: { 'a.json': 2 } } });
  });
});

describe('holding accounts back for an extra model', () => {
  const used = state({ ...partial, usage: { [`codex/${PREVIEW}`]: { readAtMs: now, byAccount: { 'cam-team.json': 40 } } } });

  it('holds the accounts with it while it’s in use, unless told otherwise', () => {
    expect([...heldAccounts(used, {}, 'codex', accounts)]).toEqual([['cam-team.json', { model: PREVIEW, why: 'used' }]]);
    expect(heldAccounts(partial, {}, 'codex', accounts).size).toBe(0);
    expect([...heldAccounts(partial, { [`codex/${PREVIEW}`]: 'always' }, 'codex', accounts)]).toEqual([['cam-team.json', { model: PREVIEW, why: 'always' }]]);
    expect(heldAccounts(used, { [`codex/${PREVIEW}`]: 'never' }, 'codex', accounts).size).toBe(0);
  });

  it('holds nothing when every account has it, or none is known to lack it', () => {
    const everywhere = state({ ...used, access: Object.fromEntries(accounts.map((name) => [name, { [PREVIEW]: 'yes' as const }])) });
    expect(heldAccounts(everywhere, { [`codex/${PREVIEW}`]: 'always' }, 'codex', accounts).size).toBe(0);
    expect(heldAccounts(used, {}, 'codex', ['cam-team.json']).size).toBe(0);
  });

  it('says how the accounts are kept', () => {
    expect(holdLine('auto', 40)).toEqual({ key: 'extraModels.hold.state.used', values: { count: 40 } });
    expect(holdLine('auto', 0).key).toBe('extraModels.hold.state.idle');
    expect(holdLine('only', 0).key).toBe('extraModels.hold.state.only');
  });

  it('reads recent use again only when it’s an hour old and matters', async () => {
    let reads = 0;
    const counting = async (query: UsageQuery) => {
      reads += 1;
      return usageOn({ 'codex-1': [7, 0] })(query);
    };
    expect(await refreshRecentUse(used, {}, files, { usage: counting, nowMs: now + 60_000 })).toBeNull();
    expect(await refreshRecentUse(used, { [`codex/${PREVIEW}`]: 'always' }, files, { usage: counting, nowMs: now + USAGE_READ_EVERY_MS })).toBeNull();
    const fresh = await refreshRecentUse(used, {}, files, { usage: counting, nowMs: now + USAGE_READ_EVERY_MS });
    expect(fresh?.usage[`codex/${PREVIEW}`]).toEqual({ readAtMs: now + USAGE_READ_EVERY_MS, byAccount: { 'cam-team.json': 7 } });
    expect(reads).toBe(1);
  });

  it('checks a provider again when its usable accounts change', () => {
    expect(providersWithNewAccounts(partial, files)).toEqual([]);
    expect(providersWithNewAccounts(partial, [...files, codex('cam-new.json', 'codex-4')])).toEqual(['codex']);
    expect(providersWithNewAccounts(partial, [...files.slice(1), codex('cam-team.json', 'codex-1', { disabled: true })])).toEqual(['codex']);
  });
});

describe('keeping an extra model from accounts without it', () => {
  const base = { state: partial, modes: {}, provider: 'codex', models: [PREVIEW], everyModel: ['gpt-6-sol', 'gpt-6-luna', PREVIEW], accounts, usable: accounts };

  it('keeps it from the accounts that lack it, unless someone undid that', () => {
    expect(desiredExclusions(base)).toEqual({ 'cam-team.json': [], 'cam-home.json': [PREVIEW], 'cam-spare.json': [PREVIEW] });
    const declined = { ...partial, declined: { 'cam-home.json': [PREVIEW] } };
    expect(desiredExclusions({ ...base, state: declined })['cam-home.json']).toEqual([]);
  });

  it('keeps every other model from accounts set to serve only it, but never from all of them', () => {
    const only = { [`codex/${PREVIEW}`]: 'only' as const };
    expect(desiredExclusions({ ...base, modes: only })['cam-team.json']).toEqual(['gpt-6-luna', 'gpt-6-sol']);
    const everywhere = state({ access: Object.fromEntries(accounts.map((name) => [name, { [PREVIEW]: 'yes' as const }])) });
    expect(desiredExclusions({ ...base, state: everywhere, modes: only })['cam-team.json']).toEqual([]);
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

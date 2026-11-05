import type { AuthFileExcludedModels, ExtraModelsView, UsageAnalysis, UsageQuery } from '../native/types';
import type { MessageKey } from '../i18n/resources';
import { canonicalProvider, isOAuthCredentialFile } from './authFiles';
import { askAccountModels, hasLiveList, usableAccounts, type AccountModelsResult, type LiveModel, type LiveModelsResult } from './extraModels';
import {
  RECENT_USE_MS,
  USAGE_READ_EVERY_MS,
  accessSummary,
  getModelAccess,
  getReservePolicies,
  isPartial,
  lower,
  modelKey,
  reservePolicyFor,
  setModelAccess,
  type AccessSummary,
  type ModelAccessState,
  type ReserveMode,
  type ReservePolicy,
} from './extraModelHold';
import { invokeCommand } from '../native/commands';
import { managementApi, normalizeAuthIndex, readString, responseList } from './managementApi';
import { normalizeOAuthExcludedRules } from './oauthModels';

import { percentText, reserveAccounts, windowStart, type AccountReserve } from './modelReserves';
import type { AuthFile, QuotaState } from './quotaService';

export * from './extraModelHold';
export * from './modelReserves';

/**
 * An extra model can be on only some of a provider's accounts (a preview one account was let into, say), while the
 * proxy offers it on all of them. Arbor asks each account which models it has, and keeps the model from the accounts
 * without it so requests for it never land there. The accounts with it keep a reserve of their limit for it: above
 * the reserve they're shared like any account, and at it they serve only the model, until every other account is out
 * and they lend it to everyday requests rather than turn them away.
 */

/**
 * The models Arbor should keep from each of a provider's accounts: the extra models it lacks, unless someone undid
 * that, and on an account set to serve only some models, or at its reserve for them (`state.fenced`), every other
 * model. `usable` decides whether a model is only on some accounts; "only" never applies when every account has the
 * model, as nothing would serve the rest.
 */
export function desiredExclusions({ state, policies, provider, models, everyModel, accounts, usable }: {
  state: ModelAccessState;
  policies: Record<string, ReservePolicy>;
  provider: string;
  /** The provider's extra models the proxy's catalog doesn't have. */
  models: string[];
  /** Every model the provider's accounts serve: the catalog and the extra models. */
  everyModel: string[];
  /** The provider's credential files Arbor can change. */
  accounts: string[];
  /** Those of them requests can go to. */
  usable: string[];
}): Record<string, string[]> {
  const only = models.filter((model) => reservePolicyFor(policies, provider, model).mode === 'only' && isPartial(accessSummary(state, model, usable)));
  const extras = new Set(models.map(lower));
  return Object.fromEntries(accounts.map((account) => {
    const access = state.access[account] ?? {};
    const declined = state.declined[account] ?? [];
    const keep = new Set(models.map(lower).filter((model) => access[model] === 'no' && !declined.includes(model)));
    const fenced = (state.fenced[account] ?? []).filter((model) => extras.has(model));
    const own = [...new Set([...only.map(lower), ...fenced])].filter((model) => access[model] === 'yes');
    if (own.length > 0) everyModel.map(lower).forEach((model) => { if (!own.includes(model)) keep.add(model); });
    return [account, [...keep].sort()];
  }));
}

/** A change to one account's excluded models, with what it was, to undo it. */
export type ExclusionChange = { fileName: string; before: string[]; after: string[]; addedBefore: string[]; addedAfter: string[] };

const sameSet = (left: string[], right: string[]) => left.length === right.length && left.every((item) => right.includes(item));

/**
 * What to change in each account's excluded models so it keeps `desired` from it. Rules someone added themselves stay
 * as they are, and a rule Arbor added goes once it isn't wanted.
 */
export function exclusionChanges(current: Record<string, string[]>, added: Record<string, string[]>, desired: Record<string, string[]>): ExclusionChange[] {
  return Object.keys(current).sort().flatMap((fileName) => {
    const rules = normalizeOAuthExcludedRules(current[fileName] ?? []);
    const mine = added[fileName] ?? [];
    const want = desired[fileName] ?? [];
    const drop = mine.filter((model) => !want.includes(model));
    const add = want.filter((model) => !rules.includes(model));
    const after = [...rules.filter((rule) => !drop.includes(rule)), ...add];
    const addedAfter = [...new Set([...mine.filter((model) => want.includes(model)), ...add])].sort();
    if (sameSet(after, rules) && sameSet(addedAfter, mine)) return [];
    return [{ fileName, before: rules, after, addedBefore: mine, addedAfter }];
  });
}

/** The models a set of changes keeps from accounts, or stops keeping from them. */
export const changedModels = (changes: ExclusionChange[]): string[] => [...new Set(changes.flatMap((change) => [
  ...change.after.filter((rule) => !change.before.includes(rule)),
  ...change.before.filter((rule) => !change.after.includes(rule)),
]))].sort();

type AccessApi = Pick<typeof managementApi, 'post' | 'patch'>;

export type AccessDeps = {
  api: AccessApi;
  excludedModels: (name: string) => Promise<AuthFileExcludedModels>;
  usage: (query: UsageQuery) => Promise<UsageAnalysis>;
  codexVersion?: string;
  nowMs: number;
};

type Files = Record<string, unknown>[];

const failureOf = (answer: AccountModelsResult | undefined): LiveModelsResult =>
  !answer || answer.ok ? { ok: false, reason: 'extraModels.suggestions.noAccount' } : answer;

type RecentUse = { byAccount: Record<string, number>; tokens: Record<string, number> };

/** Requests for `model` that worked in the last week and their tokens, by credential file name, or null when unread. */
async function readRecentUse(deps: Pick<AccessDeps, 'usage' | 'nowMs'>, files: Files, provider: string, model: string): Promise<RecentUse | null> {
  const analysis = await deps.usage({ start: new Date(deps.nowMs - RECENT_USE_MS).toISOString(), model }).catch(() => null);
  if (!analysis) return null;
  // Only the provider's own accounts: another provider's model of the same name isn't this one.
  const byIndex = new Map(files
    .filter((file) => canonicalProvider(readString(file, 'provider', 'type')) === provider)
    .map((file) => [normalizeAuthIndex(file.auth_index ?? file.authIndex), nameOf(file)]));
  const byAccount: Record<string, number> = {};
  const tokens: Record<string, number> = {};
  analysis.accounts.forEach((account) => {
    const name = byIndex.get(account.authIndex);
    const worked = account.requests - account.failures;
    if (!name || worked <= 0) return;
    byAccount[name] = (byAccount[name] ?? 0) + worked;
    tokens[name] = (tokens[name] ?? 0) + account.tokens;
  });
  return { byAccount, tokens };
}

/**
 * Every token each account served since its limit window began (`starts`, by credential file name), or null for the
 * ones that couldn't be read. Accounts whose windows began together are read in one go.
 */
async function readWindowTokens(deps: Pick<AccessDeps, 'usage'>, files: Files, starts: Record<string, number>): Promise<Record<string, number | null>> {
  const indexOf = new Map(files.map((file) => [nameOf(file), normalizeAuthIndex(file.auth_index ?? file.authIndex)]));
  const byStart = new Map<number, string[]>();
  Object.entries(starts).forEach(([name, sinceMs]) => byStart.set(sinceMs, [...(byStart.get(sinceMs) ?? []), name]));
  const read: Record<string, number | null> = {};
  await Promise.all([...byStart].map(async ([sinceMs, names]) => {
    const analysis = await deps.usage({ start: new Date(sinceMs).toISOString() }).catch(() => null);
    names.forEach((name) => {
      const index = indexOf.get(name);
      read[name] = analysis && index ? analysis.accounts.filter((account) => account.authIndex === index).reduce((sum, account) => sum + account.tokens, 0) : null;
    });
  }));
  return read;
}
const nameOf = (file: Record<string, unknown>) => readString(file, 'name');
const extrasOf = (provider: ExtraModelsView['providers'][number]) =>
  provider.models.filter((model) => !provider.catalog.some((entry) => lower(entry.id) === lower(model.id)));

/** Each account's live list, merged into the new models it offers for Extra models' suggestions. */
const mergeLists = (results: { ok: true; models: LiveModel[] }[]): LiveModel[] => {
  const merged: LiveModel[] = [];
  results.forEach((result) => result.models.forEach((model) => {
    if (!merged.some((entry) => lower(entry.id) === lower(model.id))) merged.push(model);
  }));
  return merged;
};

/**
 * Asks each usable account of the providers (all of them, or `only`) which models it has, and reads which accounts
 * served each extra model lately: a request that worked proves an account has it, even where there's no list to ask.
 * An account that couldn't be asked keeps what was known about it. Returns the new state, and for each provider with
 * a live list, the models its accounts offer between them, for suggestions.
 */
export async function checkModelAccess(view: ExtraModelsView, files: Files, previous: ModelAccessState, deps: AccessDeps, only?: string[]): Promise<{
  state: ModelAccessState;
  live: Record<string, LiveModelsResult>;
}> {
  const state: ModelAccessState = {
    ...previous,
    providers: { ...previous.providers },
    access: { ...previous.access },
    added: { ...previous.added },
    declined: { ...previous.declined },
    usage: { ...previous.usage },
    windows: { ...previous.windows },
    fenced: { ...previous.fenced },
    watch: { ...previous.watch },
  };
  const live: Record<string, LiveModelsResult> = {};
  await Promise.all(view.providers.filter((entry) => !only || only.includes(entry.provider)).map(async (entry) => {
    const { provider } = entry;
    const models = extrasOf(entry);
    const usable = usableAccounts(files, provider);
    const answers = hasLiveList(provider)
      ? await Promise.all(usable.map((account) => askAccountModels(deps.api, provider, account, deps.codexVersion)
        .catch((error: unknown): AccountModelsResult => ({ ok: false, message: String(error) }))))
      : [];
    if (hasLiveList(provider)) {
      const worked = answers.filter((answer): answer is Extract<typeof answer, { ok: true }> => answer.ok);
      live[provider] = usable.length === 0
        ? { ok: false, reason: 'extraModels.suggestions.noAccount' }
        : worked.length > 0 ? { ok: true, models: mergeLists(worked) } : failureOf(answers[0]);
    }
    await Promise.all(models.map(async (model) => {
      const recent = await readRecentUse(deps, files, provider, model.id);
      if (recent) state.usage[modelKey(provider, model.id)] = { readAtMs: deps.nowMs, ...recent };
    }));
    const lists = answers.map((answer) => (answer.ok ? answer.ids.map(lower) : null));
    // A model can work before a provider lists it (one added by ID for a limited preview), so a list leaving it out
    // only shows an account lacks it when another account's list has it.
    const listedSomewhere = new Set(lists.flatMap((ids) => ids ?? []));
    usable.forEach((account, index) => {
      const name = nameOf(account);
      const ids = lists[index] ?? null;
      const known = { ...state.access[name] };
      models.forEach((model) => {
        const id = lower(model.id);
        const used = (state.usage[modelKey(provider, id)]?.byAccount[name] ?? 0) > 0;
        if (used || ids?.includes(id)) known[id] = 'yes';
        else if (ids && listedSomewhere.has(id)) known[id] = 'no';
        else if (ids) delete known[id];
      });
      state.access[name] = known;
      const declined = (state.declined[name] ?? []).filter((id) => known[id] !== 'yes');
      if (declined.length > 0) state.declined[name] = declined;
      else delete state.declined[name];
    });
    state.providers[provider] = { models: models.map((model) => lower(model.id)), accounts: usable.map(nameOf).sort(), checkedAtMs: deps.nowMs };
  }));
  // Forget accounts that have gone, and providers left with nothing to check.
  const listed = new Set(files.map(nameOf));
  for (const map of [state.access, state.added, state.declined, state.windows, state.fenced, state.watch]) {
    Object.keys(map).forEach((name) => { if (!listed.has(name)) delete map[name]; });
  }
  Object.keys(state.providers).forEach((provider) => {
    if (!view.providers.some((entry) => entry.provider === provider)) delete state.providers[provider];
  });
  return { state, live };
}

/**
 * Reads this week's use of each provider's extra models that are only on some accounts and keep a smart reserve, and
 * the tokens their accounts served since their windows began (`starts`, by credential file name), which price that use
 * in percent: what a smart reserve is sized from between visits to Extra models. Nothing is read within the hour of
 * the last read, unless an account's window has begun again since.
 */
export async function refreshRecentUse(state: ModelAccessState, policies: Record<string, ReservePolicy>, files: Files, deps: Pick<AccessDeps, 'usage' | 'nowMs'>, starts: Record<string, number> = {}): Promise<ModelAccessState | null> {
  const smart = Object.entries(state.providers).flatMap(([provider, { models, accounts }]) => models
    .filter((model) => reservePolicyFor(policies, provider, model).mode === 'auto')
    .map((model) => ({ provider, model, summary: accessSummary(state, model, accounts) }))
    .filter(({ summary }) => isPartial(summary)));
  const due = smart.filter(({ provider, model }) => deps.nowMs - (state.usage[modelKey(provider, model)]?.readAtMs ?? 0) >= USAGE_READ_EVERY_MS);
  const holders = new Set(smart.flatMap(({ summary }) => summary.have));
  const windowsDue = Object.fromEntries(Object.entries(starts).filter(([name, sinceMs]) => {
    const known = state.windows[name];
    return holders.has(name) && (!known || Math.abs(known.sinceMs - sinceMs) > 60_000 || deps.nowMs - known.readAtMs >= USAGE_READ_EVERY_MS);
  }));
  if (due.length === 0 && Object.keys(windowsDue).length === 0) return null;
  const usage = { ...state.usage };
  const windows = { ...state.windows };
  await Promise.all([
    ...due.map(async ({ provider, model }) => {
      const key = modelKey(provider, model);
      // A failed read waits the hour too, keeping what was read before, rather than ask again every refresh.
      const recent = await readRecentUse(deps, files, provider, model) ?? { byAccount: usage[key]?.byAccount ?? {}, tokens: usage[key]?.tokens ?? {} };
      usage[key] = { readAtMs: deps.nowMs, ...recent };
    }),
    readWindowTokens(deps, files, windowsDue).then((read) => Object.entries(read).forEach(([name, tokens]) => {
      const sinceMs = windowsDue[name] ?? 0;
      windows[name] = tokens === null
        ? { ...(windows[name] ?? { sinceMs, tokens: 0 }), readAtMs: deps.nowMs }
        : { sinceMs, tokens, readAtMs: deps.nowMs };
    })),
  ]);
  return { ...state, usage, windows };
}

/**
 * Changes each account's excluded models so it keeps what `desiredExclusions` says from it: extra models it lacks,
 * and everything else on one set to serve only some. Returns the changes made, with the state that records which
 * rules are Arbor's.
 */
export async function reconcileExclusions(view: ExtraModelsView, files: Files, state: ModelAccessState, policies: Record<string, ReservePolicy>, deps: Pick<AccessDeps, 'api' | 'excludedModels'>, only?: string[]): Promise<{
  changes: ExclusionChange[];
  state: ModelAccessState;
  /** Why it stopped partway; the changes made before then are still listed, to undo. */
  error?: string;
}> {
  const desired: Record<string, string[]> = {};
  view.providers.filter((entry) => !only || only.includes(entry.provider)).forEach((entry) => {
    const accounts = files
      .filter((file) => canonicalProvider(readString(file, 'provider', 'type')) === entry.provider)
      .filter(isOAuthCredentialFile)
      .map(nameOf);
    Object.assign(desired, desiredExclusions({
      state,
      policies,
      provider: entry.provider,
      models: extrasOf(entry).map((model) => model.id),
      everyModel: [...entry.catalog, ...entry.models].map((model) => model.id),
      accounts,
      usable: usableAccounts(files, entry.provider).map(nameOf),
    }));
  });
  // Only accounts with something to keep from them, or rules of Arbor's to take back, are read.
  const names = [...new Set([...Object.keys(desired).filter((name) => (desired[name] ?? []).length > 0), ...Object.keys(state.added)])]
    .filter((name) => name in desired);
  const current: Record<string, string[]> = {};
  await Promise.all(names.map(async (name) => {
    const read = await deps.excludedModels(name).catch(() => null);
    if (read?.kind === 'rules') current[name] = read.rules;
  }));
  const changes = exclusionChanges(current, state.added, desired);
  const applied: ExclusionChange[] = [];
  const added = { ...state.added };
  for (const change of changes) {
    try {
      // Patch only this field: never upload a stale copy of tokens or other metadata.
      await deps.api.patch('/auth-files/fields', { name: change.fileName, excluded_models: change.after });
    } catch (error) {
      return { changes: applied, state: { ...state, added }, error: String(error) };
    }
    applied.push(change);
    if (change.addedAfter.length > 0) added[change.fileName] = change.addedAfter;
    else delete added[change.fileName];
  }
  return { changes: applied, state: { ...state, added } };
}

/**
 * Puts the accounts' excluded models back as they were. With `decline`, the models Arbor had just kept from them stay
 * off its list for those accounts until they turn out to have them.
 */
export async function undoExclusionChanges(changes: ExclusionChange[], state: ModelAccessState, api: Pick<AccessApi, 'patch'>, decline: boolean): Promise<ModelAccessState> {
  const added = { ...state.added };
  const declined = { ...state.declined };
  for (const change of changes) {
    await api.patch('/auth-files/fields', { name: change.fileName, excluded_models: change.before });
    // With the rules as they were, Arbor's are only those still among them.
    const mine = change.addedBefore.filter((model) => change.before.includes(model));
    if (mine.length > 0) added[change.fileName] = mine;
    else delete added[change.fileName];
    const fresh = change.addedAfter.filter((model) => !change.before.includes(model));
    if (decline && fresh.length > 0) declined[change.fileName] = [...new Set([...(declined[change.fileName] ?? []), ...fresh])].sort();
  }
  return { ...state, added, declined };
}

/** Checks and changes run one at a time, so two at once (the page and an account added) can't both change one account. */
let queue: Promise<unknown> = Promise.resolve();
const oneAtATime = <T,>(run: () => Promise<T>): Promise<T> => {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
};

const appDeps = (codexVersion?: string): AccessDeps => ({
  api: managementApi,
  excludedModels: (name) => invokeCommand('get_auth_file_excluded_models', { name }),
  usage: (query) => invokeCommand('get_usage_analysis', { query }),
  codexVersion,
  nowMs: Date.now(),
});

/**
 * Checks which accounts have each extra model, keeps each from the accounts without it, and saves what was found. For
 * the providers in `only`, or all of them.
 */
export async function runModelAccessCheck(view: ExtraModelsView, { codexVersion, only }: { codexVersion?: string; only?: string[] } = {}): Promise<{
  live: Record<string, LiveModelsResult>;
  changes: ExclusionChange[];
  error?: string;
}> {
  return oneAtATime(async () => {
    const deps = appDeps(codexVersion);
    const files = responseList(await managementApi.get('/auth-files'), 'files');
    const checked = await checkModelAccess(view, files, getModelAccess(), deps, only);
    setModelAccess(checked.state);
    const reconciled = await reconcileExclusions(view, files, checked.state, getReservePolicies(), deps, only);
    setModelAccess(reconciled.state);
    return { live: checked.live, changes: reconciled.changes, error: reconciled.error };
  });
}

/** Keeps each model from the accounts without it again, after a reserve changed, without asking the accounts again. */
export function reapplyExclusions(view: ExtraModelsView): Promise<{ changes: ExclusionChange[]; error?: string }> {
  return oneAtATime(async () => {
    const files = responseList(await managementApi.get('/auth-files'), 'files');
    const reconciled = await reconcileExclusions(view, files, getModelAccess(), getReservePolicies(), appDeps());
    setModelAccess(reconciled.state);
    return { changes: reconciled.changes, error: reconciled.error };
  });
}

/**
 * Fences the accounts at their reserve, so they serve only the models they keep it for, and opens the rest again. If
 * a change fails, the fences that were in place are saved back, so the next limit refresh tries again.
 */
export function applyFences(view: ExtraModelsView, fenced: Record<string, string[]>): Promise<{ changes: ExclusionChange[]; error?: string }> {
  return oneAtATime(async () => {
    const before = getModelAccess().fenced;
    const files = responseList(await managementApi.get('/auth-files'), 'files');
    const reconciled = await reconcileExclusions(view, files, { ...getModelAccess(), fenced }, getReservePolicies(), appDeps());
    setModelAccess(reconciled.error ? { ...reconciled.state, fenced: before } : reconciled.state);
    return { changes: reconciled.changes, error: reconciled.error };
  });
}

/** Undoes changes from a check, saving what Arbor's rules are now. See `undoExclusionChanges`. */
export function undoAccessChanges(changes: ExclusionChange[], decline: boolean) {
  return oneAtATime(async () => {
    setModelAccess(await undoExclusionChanges(changes, getModelAccess(), managementApi, decline));
  });
}

/** Sends a model to every account of a provider's again after an Undo, so Arbor keeps it from those without it. */
export function clearDeclined(model: string, accounts: string[]) {
  const state = getModelAccess();
  const id = lower(model);
  const declined = { ...state.declined };
  accounts.forEach((account) => {
    const rest = (declined[account] ?? []).filter((entry) => entry !== id);
    if (rest.length > 0) declined[account] = rest;
    else delete declined[account];
  });
  setModelAccess({ ...state, declined });
}

/**
 * Reads use again where it's due and saves it, for smart reserves, with each account's window start from its limits.
 * `files` are the accounts in use.
 */
export async function keepRecentUseFresh(files: AuthFile[], quotas: Record<string, QuotaState>) {
  const state = getModelAccess();
  const nowMs = Date.now();
  const starts = Object.fromEntries(reserveAccounts(files, quotas, nowMs).flatMap((account) => {
    const start = windowStart(account);
    return start === null ? [] : [[account.name, start]];
  }));
  const next = await refreshRecentUse(state, getReservePolicies(), files, { usage: appDeps().usage, nowMs }, starts);
  if (next) setModelAccess({ ...getModelAccess(), usage: next.usage, windows: next.windows });
}



/** What an extra model's row says about which accounts have it, given the usable accounts' names by file name. */
export function accessLine(summary: AccessSummary, provider: string, names: Record<string, string>): { key: MessageKey; values: Record<string, string | number> } | null {
  const total = summary.have.length + summary.lack.length + summary.unknown.length;
  if (total === 0) return null;
  const listed = summary.have.slice(0, 2).map((file) => names[file] ?? file).join(', ') + (summary.have.length > 2 ? ` +${summary.have.length - 2}` : '');
  if (summary.have.length === total) return { key: 'extraModels.access.everywhere', values: { provider } };
  if (summary.have.length > 0 && summary.lack.length > 0) {
    return summary.have.length <= 2
      ? { key: 'extraModels.access.only', values: { names: listed } }
      : { key: 'extraModels.access.some', values: { have: summary.have.length, total, provider } };
  }
  if (summary.have.length > 0) return { key: 'extraModels.access.workedOn', values: { names: listed } };
  if (summary.lack.length > 0) return { key: 'extraModels.access.none', values: { provider } };
  return { key: 'extraModels.access.unknown', values: { provider } };
}

/**
 * What an extra model's row says about the reserve its accounts keep for it: how much, and whether an account is at it
 * (`reserves` by credential file name, for the accounts with the model; `names` their names).
 */
export function reserveLine(mode: ReserveMode, recent: number, reserves: [string, AccountReserve][], names: Record<string, string>): { key: MessageKey; values: Record<string, string | number> } {
  if (mode === 'never' || mode === 'only') return { key: `extraModels.reserve.state.${mode}`, values: {} };
  const lending = reserves.find(([, reserve]) => reserve.state === 'lending');
  if (lending) return { key: 'extraModels.reserve.state.lending', values: { name: names[lending[0]] ?? lending[0], percent: percentText(lending[1].remaining) } };
  const fenced = reserves.find(([, reserve]) => reserve.state === 'fenced');
  if (fenced) return { key: 'extraModels.reserve.state.fenced', values: { name: names[fenced[0]] ?? fenced[0], percent: percentText(fenced[1].percent) } };
  const [first] = reserves;
  if (first) return { key: mode === 'auto' ? 'extraModels.reserve.state.smart' : 'extraModels.reserve.state.fixed', values: { percent: percentText(first[1].percent), count: recent } };
  return mode === 'auto' && recent === 0 ? { key: 'extraModels.reserve.state.idle', values: {} } : { key: 'extraModels.reserve.state.unread', values: {} };
}

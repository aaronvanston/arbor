import { authFileAvailability, canonicalProvider, isAuthFileGoneFromDisk } from './authFiles';
import { normalizeAuthIndex, readString } from './managementApi';
import { savedStore, storedRecord } from './savedStore';

/*
 * What Arbor knows about which accounts have each extra model, and how their accounts are kept for it: the part the
 * account order needs at every limit refresh. Asking the accounts and changing their excluded models is in
 * extraModelAccess.ts, loaded when that runs.
 */

const QUOTA_PROVIDERS = ['claude', 'codex', 'kimi', 'xai', 'antigravity'];

const HOUR = 3_600_000;
/** Requests this recent show a model is in use, which is what holds its accounts back. */
export const RECENT_USE_MS = 7 * 24 * HOUR;
/** Recent use is read again after this, for automatic routing between visits to Extra models. */
export const USAGE_READ_EVERY_MS = HOUR;

export type ModelAccess = 'yes' | 'no';

/**
 * How an extra model on only some accounts holds them back in the account order.
 * - `auto`: while it has been used in the last week.
 * - `always`: whether it's used or not.
 * - `never`: they take everyday requests like any other account.
 * - `only`: they serve nothing else, so it's all theirs.
 */
export type HoldMode = 'auto' | 'always' | 'never' | 'only';
export const HOLD_MODES: HoldMode[] = ['auto', 'always', 'never', 'only'];

export type ModelAccessState = {
  /** By provider: its extra models when last checked, and the usable accounts (credential file names) it covered. */
  providers: Record<string, { models: string[]; accounts: string[]; checkedAtMs: number }>;
  /** By credential file name, then model id in lower case: whether the account has the model. Missing is not known. */
  access: Record<string, Record<string, ModelAccess>>;
  /** By credential file name: the models Arbor put in its excluded models, the only ones it ever takes back out. */
  added: Record<string, string[]>;
  /** By credential file name: models someone undid keeping from it, left alone until the account turns out to have them. */
  declined: Record<string, string[]>;
  /** By `provider/model`: requests that worked in the last week, by credential file name, and when they were read. */
  usage: Record<string, { readAtMs: number; byAccount: Record<string, number> }>;
};

export const emptyAccessState = (): ModelAccessState => ({ providers: {}, access: {}, added: {}, declined: {}, usage: {} });

export const modelKey = (provider: string, model: string) => `${provider}/${model.trim().toLowerCase()}`;
export const lower = (id: string) => id.trim().toLowerCase();

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
export const recordOf = <T,>(value: unknown, item: (value: unknown) => T | null): Record<string, T> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const parsed = item(entry);
    return parsed === null ? [] : [[key, parsed]];
  }));
};
const isRecordValue = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseAccessState(raw: string | null): ModelAccessState {
  const stored = storedRecord(raw);
  return {
    providers: recordOf(stored.providers, (entry) => isRecordValue(entry)
      ? { models: stringList(entry.models), accounts: stringList(entry.accounts), checkedAtMs: Number(entry.checkedAtMs) || 0 }
      : null),
    access: recordOf(stored.access, (entry) => recordOf(entry, (value) => (value === 'yes' || value === 'no' ? value : null))),
    added: recordOf(stored.added, stringList),
    declined: recordOf(stored.declined, stringList),
    usage: recordOf(stored.usage, (entry) => isRecordValue(entry)
      ? { readAtMs: Number(entry.readAtMs) || 0, byAccount: recordOf(entry.byAccount, (value) => (typeof value === 'number' && value >= 0 ? value : null)) }
      : null),
  };
}

const accessStore = savedStore<ModelAccessState>({ key: 'arbor.extra-model-access.v1', parse: parseAccessState, fallback: emptyAccessState() });
export const useModelAccess = accessStore.useValue;
export const getModelAccess = accessStore.get;
export const setModelAccess = accessStore.set;

const parseModes = (raw: string | null): Record<string, HoldMode> =>
  recordOf(storedRecord(raw), (value) => (HOLD_MODES.includes(value as HoldMode) ? value as HoldMode : null));
const modesStore = savedStore<Record<string, HoldMode>>({ key: 'arbor.extra-model-hold.v1', parse: parseModes, fallback: {} });
export const useHoldModes = modesStore.useValue;
export const getHoldModes = modesStore.get;
export function setHoldMode(provider: string, model: string, mode: HoldMode) {
  const { [modelKey(provider, model)]: _previous, ...rest } = modesStore.get();
  // Auto is the default, so it isn't kept.
  modesStore.set(mode === 'auto' ? rest : { ...rest, [modelKey(provider, model)]: mode });
}
export const holdModeFor = (modes: Record<string, HoldMode>, provider: string, model: string): HoldMode =>
  modes[modelKey(provider, model)] ?? 'auto';

/** Which of these accounts (credential file names) have a model, which don't, and which haven't been asked. */
export type AccessSummary = { have: string[]; lack: string[]; unknown: string[] };

export function accessSummary(state: ModelAccessState, model: string, accounts: string[]): AccessSummary {
  const id = lower(model);
  const summary: AccessSummary = { have: [], lack: [], unknown: [] };
  accounts.forEach((account) => {
    const answer = state.access[account]?.[id];
    (answer === 'yes' ? summary.have : answer === 'no' ? summary.lack : summary.unknown).push(account);
  });
  return summary;
}

/** On some accounts but not others: the only case where it matters which accounts its requests go to. */
export const isPartial = (summary: AccessSummary) => summary.have.length > 0 && summary.lack.length > 0;

/** Requests for a model that worked in the last week, across its accounts, as last read. */
export const recentUse = (state: ModelAccessState, provider: string, model: string): number =>
  Object.values(state.usage[modelKey(provider, model)]?.byAccount ?? {}).reduce((sum, count) => sum + count, 0);

/** Why an account is held back: for this model, because it's in use, or because it was set to be. */
export type HoldReason = { model: string; why: 'used' | 'always' | 'only' };

/**
 * The accounts (credential file names) to hold back in a provider's account order, of the usable `accounts`: each
 * account that has an extra model some of the others lack, while that model is in use or set to always be held.
 */
export function heldAccounts(state: ModelAccessState, modes: Record<string, HoldMode>, provider: string, accounts: string[]): Map<string, HoldReason> {
  const held = new Map<string, HoldReason>();
  for (const model of state.providers[provider]?.models ?? []) {
    const summary = accessSummary(state, model, accounts);
    if (!isPartial(summary)) continue;
    const mode = holdModeFor(modes, provider, model);
    if (mode === 'never' || (mode === 'auto' && recentUse(state, provider, model) === 0)) continue;
    const why = mode === 'auto' ? 'used' : mode;
    summary.have.forEach((account) => {
      if (!held.has(account)) held.set(account, { model, why });
    });
  }
  return held;
}

/** The credentials of `provider`'s that can be asked for their live list: turned on, on disk and still signed in. */
export function usableAccounts(files: Record<string, unknown>[], provider: string): Record<string, unknown>[] {
  return files
    .filter((file) => canonicalProvider(readString(file, 'provider', 'type')) === provider && !isAuthFileGoneFromDisk(file))
    .filter((file) => normalizeAuthIndex(file.auth_index ?? file.authIndex))
    .filter((file) => {
      const kind = authFileAvailability(file).kind;
      return kind !== 'disabled' && kind !== 'signin';
    });
}
/**
 * The providers whose usable accounts differ from the ones their last check covered: one was added, removed, turned
 * on or off, or signed out. Only providers that have been checked count.
 */
export function providersWithNewAccounts(state: ModelAccessState, files: Record<string, unknown>[]): string[] {
  return Object.entries(state.providers).flatMap(([provider, { models, accounts }]) => {
    // The accounts list the app keeps only has providers it reads limits for; the rest wait for Extra models to open.
    if (models.length === 0 || !QUOTA_PROVIDERS.includes(provider)) return [];
    const now = usableAccounts(files, provider).map((file) => readString(file, 'name')).sort();
    return now.length === accounts.length && now.every((name, index) => name === accounts[index]) ? [] : [provider];
  });
}

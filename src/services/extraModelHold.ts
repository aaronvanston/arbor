import { authFileAvailability, canonicalProvider, isAuthFileGoneFromDisk } from './authFiles';
import { normalizeAuthIndex, readString } from './managementApi';
import { savedStore, storedRecord } from './savedStore';

/*
 * What Arbor knows about which accounts have each extra model, and the reserve of their limit those accounts keep for
 * it: the part every limit refresh needs. Asking the accounts and changing their excluded models is in
 * extraModelAccess.ts, loaded when that runs.
 */

const QUOTA_PROVIDERS = ['claude', 'codex', 'kimi', 'xai', 'antigravity'];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The stretch of use a reserve is forecast from, and that shows a model is in use at all. */
export const RECENT_USE_MS = 7 * DAY;
/** Use is read again after this, for reserves between visits to Extra models. */
export const USAGE_READ_EVERY_MS = HOUR;

export type ModelAccess = 'yes' | 'no';

/**
 * How the accounts with an extra model some others lack keep part of their limit for it.
 * - `auto`: a smart reserve, twice what the model looks set to use before the account resets, from this week's use;
 *   none while it hasn't been used this week.
 * - `fixed`: a set share of the limit, used or not.
 * - `never`: no reserve; they take everyday requests like any other account.
 * - `only`: they serve nothing else, so their whole limit is the model's.
 */
export type ReserveMode = 'auto' | 'fixed' | 'never' | 'only';
export const RESERVE_MODES: ReserveMode[] = ['auto', 'fixed', 'never', 'only'];

/**
 * What an account at its reserve does once every other account is out, so a request is never turned away while some
 * account could take it.
 * - `floor`: takes everyday requests down to a sliver of the reserve, `LEND_FLOOR_PERCENT` or half of it.
 * - `all`: takes them until the account is out too.
 * - `hold`: keeps the whole reserve for the model.
 */
export type LendMode = 'floor' | 'all' | 'hold';
export const LEND_MODES: LendMode[] = ['floor', 'all', 'hold'];

export type ReservePolicy = { mode: ReserveMode; /** For `fixed`: the share of the limit kept. */ percent: number; lend: LendMode };
export const DEFAULT_RESERVE: ReservePolicy = { mode: 'auto', percent: 10, lend: 'floor' };
export const FIXED_RESERVE_MIN = 1;
export const FIXED_RESERVE_MAX = 50;

/** A smart reserve is this many times the forecast, so a busier week than the last still fits. */
export const RESERVE_SAFETY = 2;
/** The least a smart reserve keeps while a day or more is left before the reset, for use the week didn't show. */
export const RESERVE_MIN_PERCENT = 2;
/** The most a smart reserve keeps: past this the account would hardly be shared at all. */
export const RESERVE_MAX_PERCENT = 25;
/** What an account lending its reserve keeps back, unless the reserve is smaller than twice this. */
export const LEND_FLOOR_PERCENT = 1;
/** An account with less than this share of its limit left can't take everyday requests. */
export const OUT_PERCENT = 1;

export type ModelAccessState = {
  /** By provider: its extra models when last checked, and the usable accounts (credential file names) it covered. */
  providers: Record<string, { models: string[]; accounts: string[]; checkedAtMs: number }>;
  /** By credential file name, then model id in lower case: whether the account has the model. Missing is not known. */
  access: Record<string, Record<string, ModelAccess>>;
  /** By credential file name: the models Arbor put in its excluded models, the only ones it ever takes back out. */
  added: Record<string, string[]>;
  /** By credential file name: models someone undid keeping from it, left alone until the account turns out to have them. */
  declined: Record<string, string[]>;
  /**
   * By `provider/model`: requests that worked in the last week and their tokens, by credential file name, and when
   * they were read.
   */
  usage: Record<string, { readAtMs: number; byAccount: Record<string, number>; tokens: Record<string, number> }>;
  /**
   * By credential file name: every token it served since its limit window began at `sinceMs`, which prices a token
   * in its limit's percent.
   */
  windows: Record<string, { sinceMs: number; tokens: number; readAtMs: number }>;
  /** By credential file name: the models an account at its reserve serves, and nothing else, as last applied. */
  fenced: Record<string, string[]>;
};

export const emptyAccessState = (): ModelAccessState => ({ providers: {}, access: {}, added: {}, declined: {}, usage: {}, windows: {}, fenced: {} });

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
const count = (value: unknown) => (typeof value === 'number' && value >= 0 ? value : null);

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
      ? { readAtMs: Number(entry.readAtMs) || 0, byAccount: recordOf(entry.byAccount, count), tokens: recordOf(entry.tokens, count) }
      : null),
    windows: recordOf(stored.windows, (entry) => isRecordValue(entry) && count(entry.tokens) !== null
      ? { sinceMs: Number(entry.sinceMs) || 0, tokens: Number(entry.tokens), readAtMs: Number(entry.readAtMs) || 0 }
      : null),
    fenced: recordOf(stored.fenced, stringList),
  };
}

const accessStore = savedStore<ModelAccessState>({ key: 'arbor.extra-model-access.v1', parse: parseAccessState, fallback: emptyAccessState() });
export const useModelAccess = accessStore.useValue;
export const getModelAccess = accessStore.get;
export const setModelAccess = accessStore.set;

export const clampFixedReserve = (percent: number) =>
  Number.isFinite(percent) ? Math.min(FIXED_RESERVE_MAX, Math.max(FIXED_RESERVE_MIN, Math.round(percent))) : DEFAULT_RESERVE.percent;

const parsePolicy = (value: unknown): ReservePolicy | null => {
  // The first version kept only a mode, and "always" held the accounts back whether the model was used or not.
  if (typeof value === 'string') {
    if (value === 'always') return { ...DEFAULT_RESERVE, mode: 'fixed' };
    return RESERVE_MODES.includes(value as ReserveMode) ? { ...DEFAULT_RESERVE, mode: value as ReserveMode } : null;
  }
  if (!isRecordValue(value)) return null;
  return {
    mode: RESERVE_MODES.includes(value.mode as ReserveMode) ? value.mode as ReserveMode : DEFAULT_RESERVE.mode,
    percent: clampFixedReserve(Number(value.percent)),
    lend: LEND_MODES.includes(value.lend as LendMode) ? value.lend as LendMode : DEFAULT_RESERVE.lend,
  };
};
const parsePolicies = (raw: string | null): Record<string, ReservePolicy> => recordOf(storedRecord(raw), parsePolicy);
const policiesStore = savedStore<Record<string, ReservePolicy>>({ key: 'arbor.extra-model-hold.v1', parse: parsePolicies, fallback: {} });
export const useReservePolicies = policiesStore.useValue;
export const getReservePolicies = policiesStore.get;
export const reservePolicyFor = (policies: Record<string, ReservePolicy>, provider: string, model: string): ReservePolicy =>
  policies[modelKey(provider, model)] ?? DEFAULT_RESERVE;
export function setReservePolicy(provider: string, model: string, change: Partial<ReservePolicy>) {
  const key = modelKey(provider, model);
  const { [key]: previous, ...rest } = policiesStore.get();
  const next = { ...(previous ?? DEFAULT_RESERVE), ...change };
  next.percent = clampFixedReserve(next.percent);
  // The default isn't kept.
  const isDefault = next.mode === DEFAULT_RESERVE.mode && next.percent === DEFAULT_RESERVE.percent && next.lend === DEFAULT_RESERVE.lend;
  policiesStore.set(isDefault ? rest : { ...rest, [key]: next });
}

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
  Object.values(state.usage[modelKey(provider, model)]?.byAccount ?? {}).reduce((sum, value) => sum + value, 0);

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

import type { MessageKey } from '../i18n/resources';
import { authFileAvailability, isOAuthCredentialFile, setOAuthCredentialFileDisabled } from './authFiles';
import { managementApi } from './managementApi';
import type { SystemNotification } from './notify';
import { formatResetCountdown, providerLabel } from './providerLimits';
import { savedStore, sharedStore, storedRecord } from './savedStore';
import { providerForFile, quotaKey, type AuthFile, type QuotaProvider, type QuotaRow, type QuotaState } from './quotaService';

type Translate = (key: MessageKey, variables?: Record<string, string | number>) => string;

/** The caps on offer: how much of each limit the proxy may use before Arbor pauses the account. */
export const RESERVE_CAPS = [95, 90, 85, 80, 75, 70, 60, 50] as const;
/** Within this many points of its cap an account's limits are read more often, so it stops close to the cap. */
export const RESERVE_WATCH_POINTS = 15;
export const RESERVE_WATCH_INTERVAL_MS = 2 * 60_000;
/** An account with a cap never goes longer than this between readings, whatever the refresh interval. */
const RESERVE_MAX_READING_AGE_MS = 15 * 60_000;
/** Resuming a minute after the reset leaves room for the provider's clock. */
const RESUME_MARGIN_MS = 60_000;

/** An account Arbor turned off in the core because one of its limits reached the cap. */
export type PausedAccount = {
  provider: QuotaProvider;
  /** The account's name when it was paused, for alerts after it has gone from the listing. */
  name: string;
  /** The limit at the cap that resets last, which decides when the account comes back. */
  window: string;
  cap: number;
  /** How much of that limit was used. */
  percentUsed: number;
  pausedAtMs: number;
  resumeAtMs: number;
};

export type ReserveState = {
  /** How much of every limit the proxy may use, in percent, by account key. */
  caps: Record<string, number>;
  /** Accounts Arbor turned off, by account key. These are the only ones it ever turns back on. */
  paused: Record<string, PausedAccount>;
  /** Accounts turned back on before their limit reset, left alone until then. */
  skipUntil: Record<string, number>;
};

/** Limits a cap applies to: plan limits with a reading and a reset still to come, shown on the Accounts page. */
const countedRows = (quota: QuotaState | undefined, hidden: readonly string[], nowMs: number) =>
  quota?.status === 'success'
    ? quota.rows.filter((row): row is QuotaRow & { remainingPercent: number; resetAtMs: number } =>
        !row.extra && row.remainingPercent !== null && row.resetAtMs !== undefined && row.resetAtMs > nowMs && !hidden.includes(row.label))
    : [];

/** Whether a limit is a cap limit at all, for marking it on the Accounts page. */
export const countsTowardCap = (row: QuotaRow) => !row.extra && row.resetAtMs !== undefined;

/**
 * The limits that have reached the cap, summed up as the one that resets last: the account can't come back
 * before that one resets. Null while every limit is under the cap.
 */
export function reserveReached(quota: QuotaState | undefined, cap: number, hidden: readonly string[], nowMs: number) {
  const reached = countedRows(quota, hidden, nowMs).filter((row) => 100 - row.remainingPercent >= cap);
  if (!reached.length) return null;
  const last = reached.reduce((latest, row) =>
    row.resetAtMs > latest.resetAtMs || (row.resetAtMs === latest.resetAtMs && row.remainingPercent < latest.remainingPercent) ? row : latest);
  return { window: last.label, percentUsed: Math.round(100 - last.remainingPercent), resumeAtMs: last.resetAtMs + RESUME_MARGIN_MS };
}

/**
 * Whether a paused account is still at its cap, judged on the reading that paused it, so raising or removing the
 * cap, or hiding the limit, can bring it back: the limit at the cap that resets last, or null once none is. Limits
 * that reset since the pause still count, so it waits for its own reset. That reading isn't kept across restarts;
 * without it only the limit that paused it is known.
 */
export function stillAtCap(paused: PausedAccount, quota: QuotaState | undefined, cap: number, hidden: readonly string[]) {
  if (quota?.status === 'success') return reserveReached(quota, cap, hidden, paused.pausedAtMs);
  return cap > paused.percentUsed ? null : { window: paused.window, percentUsed: paused.percentUsed, resumeAtMs: paused.resumeAtMs };
}

/** Whether a paused account comes straight back with a cap, or with none, for marking the choices that do that. */
export function resumesWithCap(paused: PausedAccount, quota: QuotaState | undefined, cap: number | null, hidden: readonly string[], nowMs: number) {
  if (cap === null) return true;
  const still = stillAtCap(paused, quota, cap, hidden);
  return !still || nowMs >= still.resumeAtMs;
}

/** Whether an account is close enough to its cap that its limits are worth reading every couple of minutes. */
export const nearReserve = (quota: QuotaState | undefined, cap: number, hidden: readonly string[], nowMs: number) =>
  countedRows(quota, hidden, nowMs).some((row) => 100 - row.remainingPercent >= cap - RESERVE_WATCH_POINTS);

/**
 * Whether an account with a cap is due a new reading: it's close to its cap, or its reading is a quarter of an
 * hour old (the refresh interval may be longer, or off). Failed readings are left to the usual refresh.
 */
export function reserveReadingDue(quota: QuotaState | undefined, cap: number, hidden: readonly string[], nowMs: number) {
  if (quota?.status !== 'success') return false;
  const age = nowMs - (quota.fetchedAt ?? 0);
  return age >= RESERVE_MAX_READING_AGE_MS || (age >= RESERVE_WATCH_INTERVAL_MS / 2 && nearReserve(quota, cap, hidden, nowMs));
}

export type ReserveStep =
  | { kind: 'pause'; key: string; file: AuthFile; paused: PausedAccount; last: boolean }
  | { kind: 'resume'; key: string; file: AuthFile; paused: PausedAccount; reason: 'reset' | 'cap' }
  | { kind: 'update'; key: string; paused: PausedAccount }
  | { kind: 'forget'; key: string; skipUntilMs: number | null };

export type ReserveInput = {
  state: ReserveState;
  /** Accounts in use. */
  enabled: AuthFile[];
  /** Accounts turned off in the core, by Arbor or by hand. */
  disabled: AuthFile[];
  quotas: Record<string, QuotaState>;
  /** Limits hidden on the Accounts page, by provider. */
  hidden: Record<string, string[]>;
  nameFor: (key: string, file: AuthFile) => string;
  nowMs: number;
};

/** Accounts that need a person before the core can use them again don't count as in use. */
const inUse = (file: AuthFile, nowMs: number) => {
  const kind = authFileAvailability(file, nowMs).kind;
  return kind !== 'disabled' && kind !== 'signin' && kind !== 'access';
};

/**
 * What to change so every account stays under its cap:
 * - `pause`: an account in use has a limit at its cap. It is turned off until that limit resets.
 * - `resume`: a paused account's limit has reset, or nothing in the reading that paused it is at the cap any more
 *   (the cap went away or up, or the limit is hidden now).
 * - `update`: a paused account stays paused after its cap or hidden limits changed, until the limit now at the cap resets.
 * - `forget`: a paused account was turned back on by someone else, which is left alone until its limit resets,
 *   or it has gone from the listing (deleted, or renamed and moved to its new key) past its reset.
 * Accounts turned off by hand are never touched.
 */
export function reservePlan({ state, enabled, disabled, quotas, hidden, nameFor, nowMs }: ReserveInput): ReserveStep[] {
  const steps: ReserveStep[] = [];
  const enabledKeys = new Set(enabled.map(quotaKey));
  const disabledByKey = new Map(disabled.map((file) => [quotaKey(file), file]));
  Object.entries(state.paused).forEach(([key, paused]) => {
    const file = disabledByKey.get(key);
    if (!file) {
      if (enabledKeys.has(key)) steps.push({ kind: 'forget', key, skipUntilMs: paused.resumeAtMs });
      else if (nowMs >= paused.resumeAtMs) steps.push({ kind: 'forget', key, skipUntilMs: null });
      return;
    }
    const cap = state.caps[key];
    const still = cap === undefined ? null : stillAtCap(paused, quotas[key], cap, hidden[paused.provider] ?? []);
    const reason = nowMs >= paused.resumeAtMs ? 'reset' : 'cap';
    if (cap === undefined || !still || nowMs >= still.resumeAtMs) steps.push({ kind: 'resume', key, file, paused, reason });
    else if (cap !== paused.cap || still.window !== paused.window || still.percentUsed !== paused.percentUsed || still.resumeAtMs !== paused.resumeAtMs) {
      steps.push({ kind: 'update', key, paused: { ...paused, ...still, cap } });
    }
  });

  const pausing = new Set<string>();
  const pauses: Extract<ReserveStep, { kind: 'pause' }>[] = [];
  enabled.forEach((file) => {
    const key = quotaKey(file);
    const cap = state.caps[key];
    const provider = providerForFile(file);
    if (cap === undefined || !provider || state.paused[key] || (state.skipUntil[key] ?? 0) > nowMs || !isOAuthCredentialFile(file)) return;
    const reached = reserveReached(quotas[key], cap, hidden[provider] ?? [], nowMs);
    if (!reached) return;
    pausing.add(key);
    pauses.push({ kind: 'pause', key, file, paused: { provider, name: nameFor(key, file), cap, pausedAtMs: nowMs, ...reached }, last: false });
  });
  pauses.forEach((step) => {
    step.last = !enabled.some((file) =>
      providerForFile(file) === step.paused.provider && !pausing.has(quotaKey(file)) && inUse(file, nowMs));
  });
  return [...steps, ...pauses];
}

/** Carries out a plan through the core, one account at a time. Returns the steps that took effect, and the ones that failed. */
export async function applyReserveSteps(
  steps: ReserveStep[],
  api: { patch: (path: string, body: Record<string, unknown>) => Promise<unknown> } = managementApi,
) {
  const done: ReserveStep[] = [];
  const failed: { step: ReserveStep; error: string }[] = [];
  for (const step of steps) {
    if (step.kind === 'forget' || step.kind === 'update') {
      if (step.kind === 'forget') forgetPaused(step.key, step.skipUntilMs);
      else markPaused(step.key, step.paused);
      done.push(step);
      continue;
    }
    try {
      await setOAuthCredentialFileDisabled(step.file, step.kind === 'pause', api);
      if (step.kind === 'pause') markPaused(step.key, step.paused);
      else forgetPaused(step.key, null);
      setReserveFailure(step.key, null);
      done.push(step);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setReserveFailure(step.key, message);
      failed.push({ step, error: message });
    }
  }
  return { done, failed };
}

const lowerFirst = (value: string) => value.charAt(0).toLowerCase() + value.slice(1);

/** Alerts for accounts paused at their cap, and for accounts back on because their limit reset. */
export function reserveNotifications(done: ReserveStep[], t: Translate, nowMs: number): SystemNotification[] {
  return done.flatMap((step): SystemNotification[] => {
    if (step.kind === 'forget' || step.kind === 'update' || (step.kind === 'resume' && step.reason !== 'reset')) return [];
    const { paused } = step;
    const provider = providerLabel[paused.provider];
    const window = lowerFirst(paused.window);
    if (step.kind === 'resume') {
      return [{
        title: t('reserves.alert.resumed.title', { provider }),
        body: t('reserves.alert.resumed.body', { name: paused.name, window }),
        kind: 'accountResumed',
        subject: { account: step.key },
      }];
    }
    const time = formatResetCountdown(paused.resumeAtMs, nowMs);
    return [{
      title: t('reserves.alert.paused.title', { provider }),
      body: [
        t(time ? 'reserves.alert.paused.body' : 'reserves.alert.paused.bodySoon', { name: paused.name, percent: paused.percentUsed, window, cap: paused.cap, time }),
        step.last ? t('reserves.alert.paused.last', { provider }) : '',
      ].filter(Boolean).join(' '),
      kind: 'accountPaused',
      urgent: step.last,
      subject: { account: step.key },
    }];
  });
}

const EMPTY: ReserveState = { caps: {}, paused: {}, skipUntil: {} };

const parseReserves = (raw: string | null): ReserveState => {
  const { caps, paused, skipUntil } = storedRecord(raw) as Partial<ReserveState>;
  return { caps: caps ?? {}, paused: paused ?? {}, skipUntil: skipUntil ?? {} };
};

const reserves = savedStore<ReserveState>({ key: 'cpa-gui.account-reserves.v1', parse: parseReserves, fallback: EMPTY });
/** Why Arbor couldn't pause or resume an account, by account key. Only for this run of the app. */
const failures = sharedStore<Record<string, string>>({});
const without = <T,>(record: Record<string, T>, key: string) => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};

export const useAccountReserves = reserves.useValue;
export const getAccountReserves = reserves.get;
export const useReserveFailures = failures.useValue;

/** Sets or clears an account's cap. A new cap applies straight away, even to an account turned back on early. */
export function setAccountReserve(key: string, cap: number | null) {
  failures.set(without(failures.get(), key));
  const state = reserves.get();
  reserves.set({
    ...state,
    caps: cap === null ? without(state.caps, key) : { ...state.caps, [key]: cap },
    skipUntil: without(state.skipUntil, key),
  });
}

function markPaused(key: string, paused: PausedAccount) {
  const state = reserves.get();
  reserves.set({ ...state, paused: { ...state.paused, [key]: paused }, skipUntil: without(state.skipUntil, key) });
}

function forgetPaused(key: string, skipUntilMs: number | null) {
  const state = reserves.get();
  reserves.set({
    ...state,
    paused: without(state.paused, key),
    skipUntil: skipUntilMs === null ? without(state.skipUntil, key) : { ...state.skipUntil, [key]: skipUntilMs },
  });
}

function setReserveFailure(key: string, error: string | null) {
  const current = failures.get();
  if ((current[key] ?? null) === error) return;
  failures.set(error === null ? without(current, key) : { ...current, [key]: error });
}

/** Turns a paused account back on before its limit resets. Arbor leaves it on until that limit resets. */
export async function resumePausedAccount(
  key: string,
  file: AuthFile,
  api: { patch: (path: string, body: Record<string, unknown>) => Promise<unknown> } = managementApi,
) {
  const paused = reserves.get().paused[key];
  await setOAuthCredentialFileDisabled(file, false, api);
  setReserveFailure(key, null);
  forgetPaused(key, paused ? paused.resumeAtMs : null);
}

/** Moves reserve state to a credential's new key after the core saved it under a new file name. */
export function renameReserveKeys(moves: { from: string; to: string }[]) {
  let next = reserves.get();
  let moved = false;
  const move = <T,>(record: Record<string, T>, from: string, to: string) => {
    if (!(from in record)) return record;
    moved = true;
    return { ...without(record, from), [to]: record[from]! };
  };
  moves.forEach(({ from, to }) => {
    next = { caps: move(next.caps, from, to), paused: move(next.paused, from, to), skipUntil: move(next.skipUntil, from, to) };
  });
  if (moved) reserves.set(next);
}

/** For tests. */
export function resetAccountReserves(next: ReserveState = EMPTY) {
  failures.set({});
  reserves.set(next);
}

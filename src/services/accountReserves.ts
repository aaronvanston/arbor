import type { MessageKey } from '../i18n/resources';
import { rowWindowMs } from './accountLimits';
import { authFileAvailability, isOAuthCredentialFile, setOAuthCredentialFileDisabled } from './authFiles';
import { managementApi } from './managementApi';
import type { SystemNotification } from './notify';
import { formatResetCountdown, providerLabel } from './providerLimits';
import { savedStore, sharedStore, storedRecord } from './savedStore';
import { providerForFile, quotaKey, type AuthFile, type QuotaProvider, type QuotaRow, type QuotaState } from './quotaService';

type Translate = (key: MessageKey, variables?: Record<string, string | number>) => string;

/** A cap can be set anywhere from 1% to 99%; all of a limit is no cap at all. */
export const RESERVE_MIN = 1;
export const RESERVE_MAX = 99;
/** Within this many points of its cap an account's limits are read more often, so it stops close to the cap. */
export const RESERVE_WATCH_POINTS = 15;
export const RESERVE_WATCH_INTERVAL_MS = 2 * 60_000;
/** An account with a cap never goes longer than this between readings, whatever the refresh interval. */
const RESERVE_MAX_READING_AGE_MS = 15 * 60_000;
/** Resuming a minute after the reset leaves room for the provider's clock. */
const RESUME_MARGIN_MS = 60_000;

/**
 * How much of each limit the proxy may use, in percent. With `ease`, the share kept back shrinks in step with the time
 * left before each limit resets, to nothing at the reset: a reserve only has to last until then.
 */
export type AccountCap = { percent: number; ease: boolean };

/** An account Arbor turned off in the core because one of its limits reached the cap. */
export type PausedAccount = {
  provider: QuotaProvider;
  /** The account's name when it was paused, for alerts after it has gone from the listing. */
  name: string;
  /** The limit at the cap that holds the account longest, which decides when it comes back. */
  window: string;
  cap: number;
  /** Where an easing cap had got to for that limit when it paused the account, in percent. */
  easedCap?: number;
  /** How much of that limit was used. */
  percentUsed: number;
  pausedAtMs: number;
  /** When Arbor turns it back on: that limit's reset, or sooner, when an easing cap passes what it used. */
  resumeAtMs: number;
  /** When that limit resets. Missing from accounts paused before caps could ease, whose `resumeAtMs` is the reset. */
  resetAtMs?: number;
  /** How long that limit's window runs, when it's known, to judge a changed cap without a new reading. */
  windowMs?: number;
};

export type ReserveState = {
  /** How much of every limit the proxy may use, in percent, by account key. */
  caps: Record<string, number>;
  /** Accounts whose cap eases toward each limit's reset, by account key. Caps set before easing existed stay flat. */
  easing: Record<string, boolean>;
  /** Accounts Arbor turned off, by account key. These are the only ones it ever turns back on. */
  paused: Record<string, PausedAccount>;
  /** Accounts turned back on before their limit reset, left alone until then. */
  skipUntil: Record<string, number>;
};

/** An account's cap, or null without one. */
export function capOf(state: ReserveState, key: string): AccountCap | null {
  const percent = state.caps[key];
  return percent === undefined ? null : { percent, ease: state.easing[key] === true };
}

/** When a paused account's limit resets, which a turn back on by hand lasts until. */
const resetOf = (paused: PausedAccount) => paused.resetAtMs ?? paused.resumeAtMs;

/** A limit as a cap reads it: how much is used, when it resets, and how long its window runs when that's known. */
type Limit = { label: string; usedPercent: number; resetAtMs: number; windowMs: number | null };

/** Limits a cap applies to: plan limits with a reading and a reset still to come, shown on the Accounts page. */
const countedLimits = (quota: QuotaState | undefined, hidden: readonly string[], nowMs: number): Limit[] =>
  quota?.status === 'success'
    ? quota.rows.flatMap((row) =>
        !row.extra && row.remainingPercent !== null && row.resetAtMs !== undefined && row.resetAtMs > nowMs && !hidden.includes(row.label)
          ? [{ label: row.label, usedPercent: 100 - row.remainingPercent, resetAtMs: row.resetAtMs, windowMs: rowWindowMs(row) }]
          : [])
    : [];

/** Whether a cap eases on a limit: it has to know how long the window runs. */
const easesOn = (limit: Pick<Limit, 'windowMs'>, cap: AccountCap): limit is { windowMs: number } =>
  cap.ease && limit.windowMs !== null && cap.percent < 100;

/** How much of a limit the proxy may use at a moment, in percent: the cap, or with easing, the cap less what the time gone has freed. */
function capAt(limit: Pick<Limit, 'resetAtMs' | 'windowMs'>, cap: AccountCap, nowMs: number) {
  if (!easesOn(limit, cap)) return cap.percent;
  const shareLeft = Math.max(0, Math.min(1, (limit.resetAtMs - nowMs) / limit.windowMs));
  return 100 - (100 - cap.percent) * shareLeft;
}

/**
 * When a limit used this much stops holding the account: its reset, or with easing, when the cap has eased past
 * what it used (solving `capAt` for the time left).
 */
function freeAt(limit: Limit, cap: AccountCap) {
  if (!easesOn(limit, cap)) return limit.resetAtMs;
  return Math.min(limit.resetAtMs, limit.resetAtMs - ((100 - limit.usedPercent) / (100 - cap.percent)) * limit.windowMs);
}

/**
 * Where a cap has a limit pause the account right now, in percent used, for marking it on the Accounts page, and
 * whether it's easing there. Null on a limit a cap doesn't apply to.
 */
export function capForRow(row: QuotaRow, cap: AccountCap, nowMs: number) {
  if (row.extra || row.resetAtMs === undefined) return null;
  const limit = { resetAtMs: row.resetAtMs, windowMs: rowWindowMs(row) };
  return { percent: capAt(limit, cap, nowMs), eased: easesOn(limit, cap) };
}

/** Where a cap has each counted limit pause the account right now, for showing it as a cap is chosen. */
export function capLimits(quota: QuotaState | undefined, cap: AccountCap, hidden: readonly string[], nowMs: number) {
  return countedLimits(quota, hidden, nowMs).map((limit) => ({ label: limit.label, usedPercent: limit.usedPercent, capPercent: capAt(limit, cap, nowMs) }));
}

type Held = Pick<PausedAccount, 'window' | 'percentUsed' | 'resumeAtMs' | 'resetAtMs' | 'windowMs' | 'easedCap'>;

/** Limits at the cap, summed up as the one that holds the account longest; on a tie, the one used most names it. */
function heldBy(reached: Limit[], cap: AccountCap, nowMs: number): Held | null {
  const [first, ...rest] = reached;
  if (!first) return null;
  const last = rest.reduce((latest, limit) => {
    const [at, latestAt] = [freeAt(limit, cap), freeAt(latest, cap)];
    return at > latestAt || (at === latestAt && limit.usedPercent > latest.usedPercent) ? limit : latest;
  }, first);
  return {
    window: last.label,
    percentUsed: Math.round(last.usedPercent),
    resumeAtMs: freeAt(last, cap) + RESUME_MARGIN_MS,
    resetAtMs: last.resetAtMs + RESUME_MARGIN_MS,
    ...(last.windowMs !== null ? { windowMs: last.windowMs } : {}),
    ...(easesOn(last, cap) ? { easedCap: Math.round(capAt(last, cap, nowMs)) } : {}),
  };
}

/**
 * The limits that have reached the cap, summed up as the one that holds the account longest: the account can't come
 * back before that one resets, or with easing, before the cap has eased past it. Null while every limit is under the cap.
 */
export function reserveReached(quota: QuotaState | undefined, cap: AccountCap, hidden: readonly string[], nowMs: number) {
  return heldBy(countedLimits(quota, hidden, nowMs).filter((limit) => limit.usedPercent >= capAt(limit, cap, nowMs)), cap, nowMs);
}

/**
 * Whether a paused account is still at its cap, judged on the reading that paused it, so raising or removing the
 * cap, easing it, or hiding the limit, can bring it back: the limit at the cap that holds it longest, or null once
 * none is. Limits that reset since the pause still count, so it waits for its own reset. That reading isn't kept
 * across restarts; without it only the limit that paused it is known.
 */
export function stillAtCap(paused: PausedAccount, quota: QuotaState | undefined, cap: AccountCap, hidden: readonly string[]) {
  if (quota?.status === 'success') return reserveReached(quota, cap, hidden, paused.pausedAtMs);
  const limit: Limit = { label: paused.window, usedPercent: paused.percentUsed, resetAtMs: resetOf(paused) - RESUME_MARGIN_MS, windowMs: paused.windowMs ?? null };
  return limit.usedPercent >= capAt(limit, cap, paused.pausedAtMs) ? heldBy([limit], cap, paused.pausedAtMs) : null;
}

/** When a paused account comes back with a cap, or with none: now, or the time it's held until. */
export function resumeWithCap(paused: PausedAccount, quota: QuotaState | undefined, cap: AccountCap | null, hidden: readonly string[], nowMs: number) {
  const still = cap === null ? null : stillAtCap(paused, quota, cap, hidden);
  return !still || nowMs >= still.resumeAtMs ? nowMs : still.resumeAtMs;
}

/** Whether an account is close enough to its cap that its limits are worth reading every couple of minutes. */
export const nearReserve = (quota: QuotaState | undefined, cap: AccountCap, hidden: readonly string[], nowMs: number) =>
  countedLimits(quota, hidden, nowMs).some((limit) => limit.usedPercent >= capAt(limit, cap, nowMs) - RESERVE_WATCH_POINTS);

/**
 * Whether an account with a cap is due a new reading: it's close to its cap, or its reading is a quarter of an
 * hour old (the refresh interval may be longer, or off). Failed readings are left to the usual refresh.
 */
export function reserveReadingDue(quota: QuotaState | undefined, cap: AccountCap, hidden: readonly string[], nowMs: number) {
  if (quota?.status !== 'success') return false;
  const age = nowMs - (quota.fetchedAt ?? 0);
  return age >= RESERVE_MAX_READING_AGE_MS || (age >= RESERVE_WATCH_INTERVAL_MS / 2 && nearReserve(quota, cap, hidden, nowMs));
}

export type ReserveStep =
  | { kind: 'pause'; key: string; file: AuthFile; paused: PausedAccount; last: boolean }
  | { kind: 'resume'; key: string; file: AuthFile; paused: PausedAccount; reason: 'reset' | 'eased' | 'cap' }
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
 * - `pause`: an account in use has a limit at its cap. It is turned off until that limit resets, or with easing,
 *   until the cap has eased past it.
 * - `resume`: a paused account's limit has reset (`reset`), its cap has eased past what it used (`eased`), or nothing
 *   in the reading that paused it is at the cap any more (`cap`: the cap went away or up, or the limit is hidden now).
 * - `update`: a paused account stays paused after its cap or hidden limits changed, until the limit now at the cap
 *   resets or the cap eases past it.
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
      if (enabledKeys.has(key)) steps.push({ kind: 'forget', key, skipUntilMs: resetOf(paused) });
      else if (nowMs >= resetOf(paused)) steps.push({ kind: 'forget', key, skipUntilMs: null });
      return;
    }
    const cap = capOf(state, key);
    const still = cap === null ? null : stillAtCap(paused, quotas[key], cap, hidden[paused.provider] ?? []);
    // Only the time the pause itself set is an easing; coming back sooner is the person's own change.
    const reason = nowMs >= resetOf(paused) ? 'reset' : nowMs >= paused.resumeAtMs ? 'eased' : 'cap';
    if (cap === null || !still || nowMs >= still.resumeAtMs) steps.push({ kind: 'resume', key, file, paused, reason });
    else {
      const next: PausedAccount = { provider: paused.provider, name: paused.name, cap: cap.percent, pausedAtMs: paused.pausedAtMs, ...still };
      if (!samePause(next, paused)) steps.push({ kind: 'update', key, paused: next });
    }
  });

  const pausing = new Set<string>();
  const pauses: Extract<ReserveStep, { kind: 'pause' }>[] = [];
  enabled.forEach((file) => {
    const key = quotaKey(file);
    const cap = capOf(state, key);
    const provider = providerForFile(file);
    if (cap === null || !provider || state.paused[key] || (state.skipUntil[key] ?? 0) > nowMs || !isOAuthCredentialFile(file)) return;
    const reached = reserveReached(quotas[key], cap, hidden[provider] ?? [], nowMs);
    if (!reached) return;
    pausing.add(key);
    pauses.push({ kind: 'pause', key, file, paused: { provider, name: nameFor(key, file), cap: cap.percent, pausedAtMs: nowMs, ...reached }, last: false });
  });
  pauses.forEach((step) => {
    step.last = !enabled.some((file) =>
      providerForFile(file) === step.paused.provider && !pausing.has(quotaKey(file)) && inUse(file, nowMs));
  });
  return [...steps, ...pauses];
}

const PAUSE_FIELDS = ['window', 'cap', 'easedCap', 'percentUsed', 'resumeAtMs', 'resetAtMs', 'windowMs'] as const;
const samePause = (a: PausedAccount, b: PausedAccount) => PAUSE_FIELDS.every((field) => a[field] === b[field]);

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
    // An easing cap can let an account back and pause it again a few times as it's used elsewhere, so only a reset says so.
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
    const eased = paused.easedCap !== undefined;
    const body = eased ? time ? 'reserves.alert.paused.bodyEased' : 'reserves.alert.paused.bodyEasedSoon' : time ? 'reserves.alert.paused.body' : 'reserves.alert.paused.bodySoon';
    return [{
      title: t('reserves.alert.paused.title', { provider }),
      body: [
        t(body, { name: paused.name, percent: paused.percentUsed, window, cap: paused.cap, eased: paused.easedCap ?? paused.cap, time }),
        step.last ? t('reserves.alert.paused.last', { provider }) : '',
      ].filter(Boolean).join(' '),
      kind: 'accountPaused',
      urgent: step.last,
      subject: { account: step.key },
    }];
  });
}

const EMPTY: ReserveState = { caps: {}, easing: {}, paused: {}, skipUntil: {} };

const parseReserves = (raw: string | null): ReserveState => {
  const { caps, easing, paused, skipUntil } = storedRecord(raw) as Partial<ReserveState>;
  return { caps: caps ?? {}, easing: easing ?? {}, paused: paused ?? {}, skipUntil: skipUntil ?? {} };
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

/**
 * Sets or clears an account's cap, held to whole percents from 1 to 99 (all of it is no cap). A new cap applies
 * straight away, even to an account turned back on early.
 */
export function setAccountReserve(key: string, cap: AccountCap | null) {
  failures.set(without(failures.get(), key));
  const state = reserves.get();
  const percent = cap === null ? null : Math.max(RESERVE_MIN, Math.min(RESERVE_MAX, Math.round(cap.percent)));
  reserves.set({
    ...state,
    caps: percent === null ? without(state.caps, key) : { ...state.caps, [key]: percent },
    easing: cap?.ease ? { ...state.easing, [key]: true } : without(state.easing, key),
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
  forgetPaused(key, paused ? resetOf(paused) : null);
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
    next = { caps: move(next.caps, from, to), easing: move(next.easing, from, to), paused: move(next.paused, from, to), skipUntil: move(next.skipUntil, from, to) };
  });
  if (moved) reserves.set(next);
}

/** For tests. */
export function resetAccountReserves(next: ReserveState = EMPTY) {
  failures.set({});
  reserves.set(next);
}

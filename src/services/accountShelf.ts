/**
 * Shelved accounts: those turned off by hand, which come back only when someone turns them on. An account Arbor paused
 * at its cap isn't shelved: it comes back by itself at its reset, and stays part of the pool meanwhile.
 *
 * A shelved account is out of the headline, the forecast and its history. The history is what happened, so it needs
 * to know when: the shelf keeps when each account went on it, and the stretches it spent there before. It's read from
 * the account list rather than from each way an account is turned off (Accounts, Sign-ins, the command line, the
 * core's own files), so none can be missed. Accounts already off when the shelf was first kept have no known start,
 * and count as shelved for all of their history.
 */
import { savedStore, storedRecord } from './savedStore';
import { onFreePlan, type QuotaProvider } from './quotaService';

/** A stretch an account spent shelved: from when, and to when, or null while it still is. */
export type ShelfStretch = readonly [number, number | null];
/** Stretches out of the pool, by account key, as the forecast takes them. */
export type OutOfPool = Readonly<Record<string, readonly ShelfStretch[]>>;

export type Shelf = {
  /** Whether the account list has been read once: accounts off before then have no known start. */
  seeded: boolean;
  /** When each shelved account went on the shelf, by key; 0 when that isn't known. */
  since: Record<string, number>;
  /** Earlier stretches, by key, oldest first. */
  past: Record<string, Array<[number, number]>>;
};

/** Earlier stretches kept for each account: more than the four weeks of history the forecast reads ever needs. */
const MOST_PAST = 8;

const EMPTY: Shelf = { seeded: false, since: {}, past: {} };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseShelf(raw: string | null): Shelf {
  const record = storedRecord(raw);
  const since = isRecord(record.since) ? record.since : {};
  const past = isRecord(record.past) ? record.past : {};
  return {
    seeded: record.seeded === true,
    since: Object.fromEntries(Object.entries(since).filter((entry): entry is [string, number] => finite(entry[1]))),
    past: Object.fromEntries(Object.entries(past).flatMap(([key, stretches]) => {
      if (!Array.isArray(stretches)) return [];
      const kept = stretches.filter((item): item is [number, number] => Array.isArray(item) && finite(item[0]) && finite(item[1]));
      return kept.length ? [[key, kept]] : [];
    })),
  };
}

const shelf = savedStore<Shelf>({ key: 'arbor.account-shelf.v1', parse: parseShelf, fallback: EMPTY });
export const useShelf = shelf.useValue;
export const getShelf = shelf.get;
export const setShelf = shelf.set;

/**
 * The shelf after a listing: each account off and not paused by Arbor goes on it from `nowMs` (or from always, on the
 * first listing read), and each one back on comes off it, its stretch kept. An account no longer listed keeps its
 * entries, since its readings are still in the history. Returns the same object when nothing changed.
 */
export function nextShelf(current: Shelf, listing: { on: readonly string[]; off: readonly string[] }, paused: Readonly<Record<string, unknown>>, nowMs: number): Shelf {
  const since = { ...current.since };
  const past = { ...current.past };
  let changed = !current.seeded;
  listing.off.forEach((key) => {
    if (key in paused || key in since) return;
    since[key] = current.seeded ? nowMs : 0;
    changed = true;
  });
  // One turned back on is in use again, and one Arbor paused at its cap is still in the pool, whatever the shelf had.
  [...listing.on, ...listing.off.filter((key) => key in paused)].forEach((key) => {
    const from = since[key];
    if (from === undefined) return;
    delete since[key];
    past[key] = [...(past[key] ?? []), [from, nowMs] as [number, number]].slice(-MOST_PAST);
    changed = true;
  });
  return changed ? { seeded: true, since, past } : current;
}

/** Every stretch out of the pool, by key: the shelf's, and from always for an account off that it hasn't seen yet. */
export function outOfPool(current: Shelf, shelved: readonly string[]): OutOfPool {
  const out: Record<string, ShelfStretch[]> = {};
  Object.entries(current.past).forEach(([key, stretches]) => { out[key] = [...stretches]; });
  Object.entries(current.since).forEach(([key, from]) => { out[key] = [...(out[key] ?? []), [from, null]]; });
  shelved.forEach((key) => { if (!(key in current.since)) out[key] = [...(out[key] ?? []), [0, null]]; });
  return out;
}

/** Why an account is shelved, when Arbor can tell: the provider has it on its free plan. */
export type ShelfReason = 'freePlan';

export const shelfReason = (provider: QuotaProvider | null | undefined, plan: string | undefined): ShelfReason | null =>
  (onFreePlan(provider, plan) ? 'freePlan' : null);

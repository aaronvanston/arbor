import { savedStore, storedRecord } from './savedStore';

/*
 * What Arbor changed about routing by itself, newest first: the account order it applied, and the accounts it fenced to
 * their reserve or opened again. Accounts Routing lists them with what each one's action does.
 */

/** Enough to explain the last few days of changes; older ones only repeat the pattern. */
export const ROUTING_LOG_MAX = 60;

export type PriorityChange = { fileName: string; from: number; to: number };

/**
 * One change Arbor made by itself. Accounts are credential file names, models are in lower case.
 * - `fenced`: an account reached its reserve, so it serves only its models.
 * - `opened`: an account was fenced and takes everyday requests again: `lending` because every other account is out,
 *   or `above` because it's above its reserve again (a reset, or a smaller reserve).
 * - `order`: automatic account order changed priorities.
 */
export type RoutingDecision =
  | { kind: 'fenced'; provider: string; account: string; models: string[]; percent: number }
  | { kind: 'opened'; provider: string; account: string; models: string[]; why: 'lending' | 'above' }
  | { kind: 'order'; provider: string; changes: PriorityChange[] };

export type RoutingLogEntry = RoutingDecision & { id: string; atMs: number; /** Its action was taken. */ acted?: boolean };

const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

const parseEntry = (value: unknown): RoutingLogEntry | null => {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  const base = {
    id: String(entry.id ?? ''),
    atMs: Number(entry.atMs) || 0,
    provider: String(entry.provider ?? ''),
    ...(entry.acted === true ? { acted: true } : {}),
  };
  if (!base.id || !base.provider) return null;
  if (entry.kind === 'fenced') return { ...base, kind: 'fenced', account: String(entry.account ?? ''), models: strings(entry.models), percent: Number(entry.percent) || 0 };
  if (entry.kind === 'opened') return { ...base, kind: 'opened', account: String(entry.account ?? ''), models: strings(entry.models), why: entry.why === 'lending' ? 'lending' : 'above' };
  if (entry.kind === 'order' && Array.isArray(entry.changes)) {
    const changes = entry.changes.flatMap((change: unknown) => {
      if (typeof change !== 'object' || change === null) return [];
      const { fileName, from, to } = change as Record<string, unknown>;
      return typeof fileName === 'string' && typeof from === 'number' && typeof to === 'number' ? [{ fileName, from, to }] : [];
    });
    return { ...base, kind: 'order', changes };
  }
  return null;
};

export function parseRoutingLog(raw: string | null): RoutingLogEntry[] {
  const { entries } = storedRecord(raw);
  return Array.isArray(entries) ? entries.flatMap((entry) => parseEntry(entry) ?? []).slice(0, ROUTING_LOG_MAX) : [];
}

const logStore = savedStore<{ entries: RoutingLogEntry[] }>({
  key: 'arbor.routing-log.v1',
  parse: (raw) => ({ entries: parseRoutingLog(raw) }),
  fallback: { entries: [] },
});
export const useRoutingLog = () => logStore.useValue().entries;
export const getRoutingLog = () => logStore.get().entries;

let sequence = 0;
/** Adds decisions to the top of the log, dropping the oldest past `ROUTING_LOG_MAX`. */
export function recordRoutingDecisions(decisions: RoutingDecision[], nowMs = Date.now()) {
  if (decisions.length === 0) return;
  const fresh = decisions.map((decision) => ({ ...decision, id: `${nowMs.toString(36)}-${(sequence++).toString(36)}`, atMs: nowMs }));
  logStore.set({ entries: [...fresh, ...getRoutingLog()].slice(0, ROUTING_LOG_MAX) });
}

/** Marks an entry's action as taken, or not, after an Undo of it. */
export function markActed(id: string, acted: boolean) {
  logStore.set({ entries: getRoutingLog().map((entry) => (entry.id === id ? { ...entry, ...(acted ? { acted: true } : { acted: undefined }) } : entry)) });
}

/**
 * The fences that came and went between the ones last applied and the new ones, by provider of each account
 * (`providerOf`), with why each one opened (`lending` for accounts lending their reserve).
 */
export function fenceDecisions(before: Record<string, string[]>, after: Record<string, string[]>, providerOf: (account: string) => string | null, lending: ReadonlySet<string>, percentOf: (account: string) => number): RoutingDecision[] {
  const added = Object.keys(after).filter((account) => !(account in before)).sort();
  const removed = Object.keys(before).filter((account) => !(account in after)).sort();
  return [
    ...added.flatMap((account): RoutingDecision[] => {
      const provider = providerOf(account);
      return provider ? [{ kind: 'fenced', provider, account, models: after[account] ?? [], percent: percentOf(account) }] : [];
    }),
    ...removed.flatMap((account): RoutingDecision[] => {
      const provider = providerOf(account);
      return provider ? [{ kind: 'opened', provider, account, models: before[account] ?? [], why: lending.has(account) ? 'lending' : 'above' }] : [];
    }),
  ];
}

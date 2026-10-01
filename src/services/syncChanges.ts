import { useSyncExternalStore } from 'react';
import type { PendingMcp } from './setupMcp';
import type { PendingPlugins } from './setupPlugins';

/**
 * The plugin and MCP changes chosen on Sync's pages and not yet made, kept together so they last from one page, and one
 * machine, to the next, and one tray at the foot of every Sync page can say what's waiting and open their review. Only
 * for this run of the app: a choice is made against what the last scan found, which a restart reads again. Skills
 * aren't here: a skill change is made as it's picked.
 */
export type SyncChanges = {
  plugins: PendingPlugins;
  mcp: PendingMcp;
  /** A review the tray asked for, which the page it's on opens once it's showing. */
  review: SyncReview | null;
};

export type SyncReview = { kind: 'plugins' };

const EMPTY: SyncChanges = { plugins: {}, mcp: {}, review: null };

let changes: SyncChanges = EMPTY;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const current = () => changes;

export const useSyncChanges = () => useSyncExternalStore(subscribe, current, current);

function update(next: Partial<SyncChanges>) {
  changes = { ...changes, ...next };
  listeners.forEach((listener) => listener());
}

type Updater<T> = T | ((current: T) => T);
const resolve = <T,>(updater: Updater<T>, value: T): T => (typeof updater === 'function' ? (updater as (current: T) => T)(value) : updater);

/** Same keys, same choices: nothing to tell anyone. */
const same = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

export function setSyncPlugins(updater: Updater<PendingPlugins>) {
  const next = resolve(updater, changes.plugins);
  if (!same(next, changes.plugins)) update({ plugins: next });
}

export function setSyncMcp(updater: Updater<PendingMcp>) {
  const next = resolve(updater, changes.mcp);
  if (!same(next, changes.mcp)) update({ mcp: next });
}

export const clearSyncChanges = () => update(EMPTY);

/** Asks the page a review belongs to to open it once it's showing. */
export const requestSyncReview = (review: SyncReview) => update({ review });

/** The review asked for, if it's this page's to open; taking it clears the request. */
export function takeSyncReview(kind: SyncReview['kind']): SyncReview | null {
  const review = changes.review;
  if (review?.kind !== kind) return null;
  update({ review: null });
  return review;
}

/** A machine's name from a plugin or MCP change's key, which starts with its home's column. */
const machineOf = (key: string) => key.split('\u0000')[0] ?? '';

/**
 * A page's settled choices put back beside the ones for machines it isn't showing, which it can't judge: scoped to one
 * machine, the plugins page mustn't drop what was chosen for the rest.
 */
export function withSettled<A extends string>(current: Record<string, A>, settled: Record<string, A>, shown: ReadonlySet<string>): Record<string, A> {
  const elsewhere = Object.entries(current).filter(([key]) => !shown.has(machineOf(key)));
  return { ...Object.fromEntries(elsewhere), ...settled };
}

/** What's waiting, for the tray: plugins and MCP servers together, since one review makes both. */
export type SyncCounts = {
  total: number;
  machines: number;
};

export function syncCounts(state: SyncChanges): SyncCounts {
  const keys = [...Object.keys(state.plugins), ...Object.keys(state.mcp)];
  return { total: keys.length, machines: new Set(keys.map(machineOf)).size };
}

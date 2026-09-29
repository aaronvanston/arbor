import { useSyncExternalStore } from 'react';
import type { PendingMcp } from './setupMcp';
import type { PendingPlugins } from './setupPlugins';
import type { PendingSkills } from './setupSkills';

/**
 * The changes chosen on Sync's pages and not yet made, kept together so they last from one page, and one machine, to
 * the next, and one tray at the foot of every Sync page can say what's waiting. Each kind is still reviewed and made
 * the way its page does it, one machine at a time; the tray opens the right review. Only for this run of the app:
 * a choice is made against what the last scan found, which a restart reads again.
 */
export type SyncChanges = {
  plugins: PendingPlugins;
  mcp: PendingMcp;
  /** A machine's skill changes, by machine: skill changes are made on one machine at a time. */
  skills: Record<string, PendingSkills>;
  /** A review the tray asked for, which the page it's on opens once it's showing. */
  review: SyncReview | null;
};

export type SyncReview = { kind: 'plugins' } | { kind: 'skills'; machine: string };

const EMPTY: SyncChanges = { plugins: {}, mcp: {}, skills: {}, review: null };

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

export function setSyncSkills(machine: string, updater: Updater<PendingSkills>) {
  const mine = changes.skills[machine] ?? {};
  const next = resolve(updater, mine);
  if (same(next, mine)) return;
  const skills = { ...changes.skills };
  if (Object.keys(next).length) skills[machine] = next;
  else delete skills[machine];
  update({ skills });
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

/** What's waiting, for the tray: plugins and MCP servers together, since one review makes both, and skills by machine. */
export type SyncCounts = {
  total: number;
  machines: number;
  extensions: number;
  skills: { machine: string; count: number }[];
};

export function syncCounts(state: SyncChanges): SyncCounts {
  const extensionKeys = [...Object.keys(state.plugins), ...Object.keys(state.mcp)];
  const skills = Object.entries(state.skills)
    .map(([machine, pending]) => ({ machine, count: Object.keys(pending).length }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => a.machine.localeCompare(b.machine));
  const machines = new Set([...extensionKeys.map(machineOf), ...skills.map((entry) => entry.machine)]);
  return {
    total: extensionKeys.length + skills.reduce((sum, entry) => sum + entry.count, 0),
    machines: machines.size,
    extensions: extensionKeys.length,
    skills,
  };
}

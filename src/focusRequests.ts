import { useSyncExternalStore } from 'react';

/**
 * Asks a page to bring one of its rows into view: a machine on the Machines page, an account on the Accounts page, a
 * provider's accounts there (`provider`, by its id, such as `claude`), a setting (by its id in
 * src/services/settingsIndex.ts) on its Settings page, a provider on Add account, whose sign-in it starts, a file
 * (by its path in the setup repo) on Sync › Repo, which opens it, a level on Sync › Checks, which then shows only
 * that level's checks, a pool (by id) on its page, which opens New session for it, a machine's Clean up section (by
 * the machine's name) on its page, or a session on the live board (by its board key). Unlike what a view carries in
 * its params, these reach a page that is already open, so it watches for them.
 */
export type FocusTarget = 'machine' | 'account' | 'provider' | 'setting' | 'sign-in' | 'repo-file' | 'setup-checks' | 'pool-session' | 'machine-cleanup' | 'fleet-session';

let pending: Partial<Record<FocusTarget, string>> = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const emit = () => listeners.forEach((listener) => listener());

export function requestFocus(target: FocusTarget, id: string) {
  pending = { ...pending, [target]: id };
  emit();
}

/** The row asked for, until the page clears it. */
export const useFocusRequest = (target: FocusTarget) =>
  useSyncExternalStore(subscribe, () => pending[target] ?? null, () => null);

export function clearFocusRequest(target: FocusTarget) {
  if (pending[target] === undefined) return;
  const { [target]: _cleared, ...rest } = pending;
  pending = rest;
  emit();
}

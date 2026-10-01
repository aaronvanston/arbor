import { useSyncExternalStore } from 'react';

/**
 * Asks a page to bring one of its rows into view: a machine on the Machines page, an account on the Accounts page, a
 * setting (by its id in src/services/settingsIndex.ts) on its Settings page, a provider on Add account, whose
 * sign-in it starts, or a file (by its path in the setup repo) on Sync › Repo, which opens it. Unlike what a view
 * carries in its params, these reach a page that is already open, so it watches for them.
 */
export type FocusTarget = 'machine' | 'account' | 'setting' | 'sign-in' | 'repo-file';

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

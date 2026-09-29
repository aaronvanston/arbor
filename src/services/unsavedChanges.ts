import { useEffect } from 'react';

/**
 * Pages holding edits that aren't saved yet. Leaving a page unmounts it and its drafts with it, so a key that leaves
 * (Esc out of Settings), easy to press meaning something else, checks here first. A click on another page is a choice
 * and still leaves.
 */
const holders = new Set<object>();

/** Notes that a page holds unsaved edits, until the returned function lets go. */
export function holdUnsavedChanges(): () => void {
  const holder = {};
  holders.add(holder);
  return () => {
    holders.delete(holder);
  };
}

export const hasUnsavedChanges = () => holders.size > 0;

/** Holds while `unsaved` is true and the page is mounted. */
export function useUnsavedChanges(unsaved: boolean) {
  useEffect(() => (unsaved ? holdUnsavedChanges() : undefined), [unsaved]);
}

export type SettingsEscape = 'blur' | 'stay' | 'leave';

/**
 * What Escape does in Settings: lets go of a field first, then leaves, unless a page holds edits leaving would throw
 * away. Those stay until they're saved or undone.
 */
export const settingsEscape = (typing: boolean, unsaved: boolean): SettingsEscape => (typing ? 'blur' : unsaved ? 'stay' : 'leave');

import { useSyncExternalStore } from 'react';
import { canOpenView, normalizeView, samePage, sameView, type AppView } from '../navigation';

/**
 * Back and forward between views, as a browser does between pages. Going somewhere adds a step and drops the ones
 * ahead; a page changing its tab or filters rewrites its own step, so Back returns to it as it was left.
 */
export type ViewHistory = { entries: readonly AppView[]; index: number };

/** How a page's change to what it shows is kept: in its own step, as a step of its own, or back to the step before. */
export type ViewChange = 'replace' | 'push' | 'return';

/** The most steps kept; the oldest go first. */
export const HISTORY_LIMIT = 100;

const HOME: AppView = { kind: 'main', page: 'home' };

export const startHistory = (view: AppView = HOME): ViewHistory => ({ entries: [normalizeView(view)], index: 0 });

export const currentView = (history: ViewHistory): AppView => history.entries[history.index] ?? HOME;

/** Folds a step into the one before it when they show the same thing, keeping `index` on the view it was on. */
function withoutRepeats(entries: readonly AppView[], index: number): ViewHistory {
  const kept: AppView[] = [];
  let at = index;
  entries.forEach((view, position) => {
    const previous = kept[kept.length - 1];
    if (previous && sameView(previous, view)) {
      if (position <= index) at -= 1;
      return;
    }
    kept.push(view);
  });
  return { entries: kept, index: Math.min(Math.max(at, 0), kept.length - 1) };
}

/** Goes to `view` as a new step, dropping any ahead. Going to the view already on screen changes nothing. */
export function pushView(history: ViewHistory, view: AppView, limit = HISTORY_LIMIT): ViewHistory {
  const next = normalizeView(view);
  if (sameView(currentView(history), next)) return history;
  const entries = [...history.entries.slice(0, history.index + 1), next].slice(-limit);
  return { entries, index: entries.length - 1 };
}

/** Rewrites the current step. One that ends up the same as a step beside it folds into it. */
export function replaceView(history: ViewHistory, view: AppView): ViewHistory {
  const next = normalizeView(view);
  if (sameView(currentView(history), next)) return history;
  return withoutRepeats(history.entries.map((entry, position) => (position === history.index ? next : entry)), history.index);
}

/**
 * Goes to `view` by stepping back when it's the step just before, so closing a session opened from the list returns
 * to that list and Forward opens the session again. Otherwise it rewrites the current step.
 */
export function returnToView(history: ViewHistory, view: AppView): ViewHistory {
  const previous = history.entries[history.index - 1];
  if (previous && sameView(previous, view)) return { ...history, index: history.index - 1 };
  return replaceView(history, view);
}

/** A page changing what it shows. Ignored once another page is on screen, so a late change can't land elsewhere. */
export function changeView(history: ViewHistory, view: AppView, how: ViewChange): ViewHistory {
  if (!samePage(currentView(history), view)) return history;
  if (how === 'push') return pushView(history, view);
  return how === 'return' ? returnToView(history, view) : replaceView(history, view);
}

/**
 * Where Back (-1) or Forward (1) lands: the nearest step that way that can open now and shows something else. A page
 * locked while the core is down is passed over rather than landed on.
 */
export function stepTarget(history: ViewHistory, direction: -1 | 1, canOpen: (view: AppView) => boolean): number | null {
  const current = currentView(history);
  for (let at = history.index + direction; at >= 0 && at < history.entries.length; at += direction) {
    const view = history.entries[at];
    if (view && canOpen(view) && !sameView(view, current)) return at;
  }
  return null;
}

export function stepHistory(history: ViewHistory, direction: -1 | 1, canOpen: (view: AppView) => boolean): ViewHistory {
  const at = stepTarget(history, direction, canOpen);
  return at === null ? history : { ...history, index: at };
}

/**
 * How the shell reaches a view. `open` chooses it afresh (a sidebar row, the palette, a page's link), which a page that
 * needs the core only does while the core answers: its row and palette entry show it locked. `return` goes back to the
 * page left on the other side of Settings (Settings, ⌘, and Esc), which it does even when that page needs the core
 * and it has stopped since: the page shows locked where it is, and opens there once the core answers.
 */
export type ViewArrival = 'open' | 'return';

export const canArrive = (view: AppView, how: ViewArrival, coreReady: boolean) => how === 'return' || canOpenView(view, coreReady);

/**
 * Whether the view on screen shows locked in place. A page that needs the core, while the core is down, stays the
 * current step, saying why with what gets the core going, rather than being swapped for another page; the history
 * keeps its steps as they were, so the page opens right there once the core answers.
 */
export const lockedInPlace = (history: ViewHistory, coreReady: boolean) => !canOpenView(currentView(history), coreReady);

/** The mouse's back (4th) and forward (5th) buttons, as `MouseEvent.button` numbers them. */
export const mouseStep = (button: number): -1 | 1 | null => (button === 3 ? -1 : button === 4 ? 1 : null);

// The app's one history, kept for as long as the window is open.
let state = startHistory();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const update = (next: ViewHistory) => {
  if (next === state) return false;
  state = next;
  listeners.forEach((listener) => listener());
  return true;
};

export const useViewHistory = () => useSyncExternalStore(subscribe, () => state, () => state);

/** Starts the history over, for tests and the browser mock's `?history=` scenarios. */
export const resetViewHistory = (history: ViewHistory = startHistory()) => void update(history);

export const goToView = (view: AppView) => update(pushView(state, view));
export const changePageView = (view: AppView, how: ViewChange = 'replace') => update(changeView(state, view, how));
/** Returns whether it moved, so ⌘[ with nowhere to go keeps its usual meaning. */
export const goBack = (canOpen: (view: AppView) => boolean) => update(stepHistory(state, -1, canOpen));
export const goForward = (canOpen: (view: AppView) => boolean) => update(stepHistory(state, 1, canOpen));

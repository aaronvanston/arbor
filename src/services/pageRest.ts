/**
 * Whether the open page rests while the window is hidden: the content area renders nothing, which lets go of the
 * page's elements, data and timers, while the monitors beside it carry on (docs/perf/BACKLOG.md, M1). The window is
 * the background service and is mostly hidden, so this is where its memory goes. The page comes back at the view it
 * was left on, scrolled where it was, as soon as the window shows.
 */

/** Where the window is: on screen, closed to the tray or minimized (`away`), or on screen under other windows. */
export type WindowPlace = 'shown' | 'away' | 'covered';

/**
 * How long the window is hidden before the page rests. Closed or minimized, the page isn't coming back soon; covered,
 * it's often a glance at another app, and a page that came back fresh after each would lose what wasn't saved in its
 * view (a scrolled table, an open row), so it waits longer.
 */
export const REST_AFTER_MS: Record<Exclude<WindowPlace, 'shown'>, number> = { away: 30_000, covered: 5 * 60_000 };

/** How often a hidden window looks again: it may have been closed after being covered, or a hold let go. */
export const REST_CHECK_MS = 30_000;

/**
 * What keeps a page from resting, as it would be lost: edits not saved yet, a dialog open (a sign-in waiting in the
 * browser, a confirmation), or something on the page still working.
 */
export type RestHolds = { unsaved: boolean; dialog: boolean; busy: boolean };

/** Whether the page should rest now, hidden for `hiddenForMs` in `place`. */
export function restDue(place: WindowPlace, hiddenForMs: number, holds: RestHolds): boolean {
  if (place === 'shown') return false;
  if (holds.unsaved || holds.dialog || holds.busy) return false;
  return hiddenForMs >= REST_AFTER_MS[place];
}

/** The window's place from what the page and Tauri's window say; a window Tauri can't answer for counts as covered. */
export function windowPlace(hidden: boolean, window: { visible: boolean; minimized: boolean } | null): WindowPlace {
  if (!hidden) return 'shown';
  if (!window) return 'covered';
  return !window.visible || window.minimized ? 'away' : 'covered';
}

/** Where the page was scrolled to as it rested, so it comes back there: only on the same view, and only once. */
export type RestScroll = { view: string; top: number };

/** The scroll to put back on `view` after a rest, or null. */
export const scrollToRestore = (saved: RestScroll | null, view: string) => (saved && saved.view === view && saved.top > 0 ? saved.top : null);

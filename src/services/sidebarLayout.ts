import { useSyncExternalStore } from 'react';
import { savedStore } from './savedStore';
import { clampSidebarWidth, DEFAULT_SIDEBAR_LAYOUT as DEFAULT_LAYOUT, NARROW_WINDOW_WIDTH, parseSidebarLayout, SIDEBAR_DEFAULT_WIDTH, sidebarMaxWidth, sidebarOverlays, sidebarShown, toggledSidebar, withNarrowWindow, type SidebarLayout, type SidebarVisibility } from './sidebarLayoutRules';

export * from './sidebarLayoutRules';

/** Only the width and whether it's hidden are kept: how narrow the window is and what ⌘B revealed in it are this run's. */
const saved = savedStore<SidebarLayout>({ key: 'arbor.sidebar.v1', parse: parseSidebarLayout, fallback: DEFAULT_LAYOUT, place: 'window' });

export type SidebarState = SidebarLayout & SidebarVisibility & { shown: boolean; overlay: boolean };

const narrowQuery = `(max-width: ${NARROW_WINDOW_WIDTH - 0.02}px)`;
const matchNarrow = () => (typeof window === 'undefined' || !window.matchMedia ? null : window.matchMedia(narrowQuery));

const withShown = (next: SidebarLayout & SidebarVisibility): SidebarState => ({ ...next, shown: sidebarShown(next), overlay: sidebarOverlays(next) });

let state: SidebarState = withShown({ ...saved.get(), narrow: matchNarrow()?.matches ?? false, revealed: false });
let watching = false;
const listeners = new Set<() => void>();

const update = (next: SidebarLayout & SidebarVisibility, persist: boolean) => {
  if (next.width === state.width && next.hidden === state.hidden && next.narrow === state.narrow && next.revealed === state.revealed) return;
  state = withShown(next);
  if (persist) saved.set({ width: state.width, hidden: state.hidden });
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const query = matchNarrow();
  if (!watching && query) {
    // One watcher for the page's lifetime; only crossing the width tells it anything.
    watching = true;
    query.addEventListener('change', (event) => update(withNarrowWindow(state, event.matches), false));
    update(withNarrowWindow(state, query.matches), false);
  }
  return () => { listeners.delete(listener); };
};

export const useSidebarLayout = () => useSyncExternalStore(subscribe, () => state, () => state);

export const toggleSidebar = () => update(toggledSidebar(state), true);

/** Puts away a sidebar open over the page (a click beside it, Esc, a page picked from it); one beside the page stays. */
export const putAwaySidebarOverlay = () => {
  if (state.overlay) update(toggledSidebar(state), true);
};

export const setSidebarWidth = (width: number) => update({ ...state, width: clampSidebarWidth(width) }, true);

/** A double-click on the edge: back to 16rem, and saved. */
export const resetSidebarWidth = () => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);

/** The layout as it stands, outside React. */
export const getSidebarLayout = (): SidebarState => state;

const windowWidth = () => (typeof window === 'undefined' ? 1280 : window.innerWidth);
let maxWidth = sidebarMaxWidth(windowWidth());
let watchingMax = false;
const maxListeners = new Set<() => void>();

const subscribeMax = (listener: () => void) => {
  maxListeners.add(listener);
  if (!watchingMax && typeof window !== 'undefined') {
    // One watcher for the page's lifetime; most resizes leave the maximum where it was.
    watchingMax = true;
    const follow = () => {
      const next = sidebarMaxWidth(windowWidth());
      if (next === maxWidth) return;
      maxWidth = next;
      maxListeners.forEach((notify) => notify());
    };
    window.addEventListener('resize', follow);
    // The window can change size between this module loading and the first render, as a zoom put on then does, and
    // that resize has already gone by; as with the narrow watcher, catch up with it here.
    follow();
  }
  return () => { maxListeners.delete(listener); };
};

/** The widest the sidebar can be in the window as it is now, following its resizes. */
export const useSidebarMaxWidth = () => useSyncExternalStore(subscribeMax, () => maxWidth, () => maxWidth);

/**
 * Sets the layout without saving it, for the browser mock's `?sidebar=` scenarios. `revealed` is ⌘B's in a narrow
 * window, opening the sidebar over the page.
 */
export const previewSidebarLayout = (layout: Partial<SidebarLayout & Pick<SidebarVisibility, 'revealed'>>) =>
  update({ ...state, ...layout, width: clampSidebarWidth(layout.width ?? state.width) }, false);

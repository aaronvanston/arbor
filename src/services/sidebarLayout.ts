import { useSyncExternalStore } from 'react';
import { savedStore } from './savedStore';

/**
 * The sidebar's width and whether it's hidden, kept across restarts. They're UI preferences with nothing secret in
 * them, so they live in the window's storage like the rest.
 */
export type SidebarLayout = { width: number; hidden: boolean };

/** In CSS pixels: 13rem at the narrowest and 16rem to start with. */
export const SIDEBAR_MIN_WIDTH = 208;
export const SIDEBAR_DEFAULT_WIDTH = 256;
/**
 * The narrowest the page beside the sidebar gets. There's no fixed widest: the sidebar can take all of the window but
 * this, so a drag that would leave the page narrower stops there (sidebarMaxWidth).
 */
export const MAIN_MIN_WIDTH = 640;
/** How far one arrow key press moves the sidebar's edge. */
export const SIDEBAR_KEY_STEP = 16;
/** Below this the window hides the sidebar by itself: the narrowest sidebar and the narrowest page side by side. */
export const NARROW_WINDOW_WIDTH = SIDEBAR_MIN_WIDTH + MAIN_MIN_WIDTH;

const DEFAULT_LAYOUT: SidebarLayout = { width: SIDEBAR_DEFAULT_WIDTH, hidden: false };

/** The widest the sidebar gets in a window this wide: all but the page's 640px, never under the narrowest. */
export const sidebarMaxWidth = (windowWidth: number) => Math.max(SIDEBAR_MIN_WIDTH, Math.floor(windowWidth) - MAIN_MIN_WIDTH);

/**
 * A width within the limits, in whole pixels, up to `max` (the window's, from sidebarMaxWidth). One that isn't a number
 * at all is the default.
 */
export function clampSidebarWidth(width: number, max = Number.POSITIVE_INFINITY): number {
  const whole = Number.isFinite(width) ? Math.round(width) : SIDEBAR_DEFAULT_WIDTH;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(max, whole));
}

/**
 * Where a key press on the resize handle moves the edge: the arrows a step either way, Home and End all the way, End
 * to the widest the window allows. Null for a key the handle leaves alone.
 */
export function sidebarWidthForKey(width: number, key: string, max: number): number | null {
  switch (key) {
    case 'ArrowLeft': return clampSidebarWidth(width - SIDEBAR_KEY_STEP, max);
    case 'ArrowRight': return clampSidebarWidth(width + SIDEBAR_KEY_STEP, max);
    case 'Home': return SIDEBAR_MIN_WIDTH;
    case 'End': return clampSidebarWidth(max);
    default: return null;
  }
}

/** The width mid-drag: the width it started at, moved as far as the pointer has, stopping at the page's 640px. */
export const draggedSidebarWidth = (startWidth: number, startX: number, x: number, max: number) =>
  clampSidebarWidth(startWidth + x - startX, max);

/**
 * The saved layout. Anything missing or damaged falls back on its own: a width that isn't a number is the default,
 * one under the narrowest is brought up to it (the window caps it as it shows), and `hidden` is only ever true or false.
 */
export function parseSidebarLayout(raw: string | null): SidebarLayout {
  let saved: unknown;
  try {
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    return DEFAULT_LAYOUT;
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return DEFAULT_LAYOUT;
  const { width, hidden } = saved as Record<string, unknown>;
  return {
    width: typeof width === 'number' ? clampSidebarWidth(width) : SIDEBAR_DEFAULT_WIDTH,
    hidden: typeof hidden === 'boolean' ? hidden : false,
  };
}

/**
 * What decides whether the sidebar shows: the saved choice, whether the window is too narrow for it, and whether it
 * was brought back while the window was narrow.
 */
export type SidebarVisibility = { hidden: boolean; narrow: boolean; revealed: boolean };

export const sidebarShown = ({ hidden, narrow, revealed }: SidebarVisibility) => !hidden && (!narrow || revealed);

/**
 * Whether the sidebar opens over the page rather than beside it: when it's brought back in a window too narrow for
 * both, so the page keeps its 640px and the sidebar covers its start until it's put away.
 */
export const sidebarOverlays = (state: SidebarVisibility) => state.narrow && sidebarShown(state);

/**
 * Whether going from one page to another (by viewPageId) puts away a sidebar open over the page. Picking a page does;
 * switching between the main pages and Settings doesn't, so the other list is there to pick from.
 */
export const pagePutsAwaySidebar = (from: string, to: string) => from !== to && from.startsWith('settings:') === to.startsWith('settings:');

/**
 * What ⌘B and the sidebar buttons do. In a window wide enough, they hide or show the sidebar and that's saved. In a
 * narrow one they bring back the sidebar the window hid, and hiding it again leaves the saved choice alone, so it's
 * back by itself once the window is wide.
 */
export function toggledSidebar<T extends SidebarVisibility>(state: T): T {
  if (sidebarShown(state)) return state.narrow ? { ...state, revealed: false } : { ...state, hidden: true };
  return { ...state, hidden: false, revealed: state.narrow };
}

/** The window getting narrow or wide again goes back to what's saved, whatever was done while it was narrow. */
export const withNarrowWindow = <T extends SidebarVisibility>(state: T, narrow: boolean): T =>
  narrow === state.narrow ? state : { ...state, narrow, revealed: false };

/** Only the width and whether it's hidden are kept: how narrow the window is and what ⌘B revealed in it are this run's. */
const saved = savedStore<SidebarLayout>({ key: 'cpa-gui.sidebar.v1', parse: parseSidebarLayout, fallback: DEFAULT_LAYOUT });

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

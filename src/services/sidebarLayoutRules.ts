/**
 * The sidebar's layout rules, apart from its store so index.html's boot script (src/boot/bootPaint.ts) can size the
 * static first screen's sidebar exactly as the shell will, without the store's Tauri imports.
 *
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

export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayout = { width: SIDEBAR_DEFAULT_WIDTH, hidden: false };

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
    return DEFAULT_SIDEBAR_LAYOUT;
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return DEFAULT_SIDEBAR_LAYOUT;
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


/**
 * What the static first screen needs that the window's storage doesn't already hold: the zoom, which the native side
 * keeps. services/zoom.ts writes it here whenever the level changes, and index.html's head script reads it before the
 * first paint. Only look values ever go in; this key is the window's own.
 */
export const BOOT_KEY = 'arbor.boot.v1';

export type BootState = { zoom: number };

const DEFAULT_BOOT_STATE: BootState = { zoom: 1 };

/** The stored state, or actual size for anything missing or damaged. Zoom stays within the View menu's 83–144%. */
export function readBootState(raw: string | null): BootState {
  let saved: unknown;
  try {
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    return DEFAULT_BOOT_STATE;
  }
  if (!saved || typeof saved !== 'object') return DEFAULT_BOOT_STATE;
  const { zoom } = saved as Record<string, unknown>;
  return { zoom: typeof zoom === 'number' && zoom >= 0.8 && zoom <= 1.5 ? zoom : 1 };
}

/** Keeps the zoom for the next launch's first screen. Blocked storage just means that screen opens at actual size. */
export function rememberBootZoom(zoom: number): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const next = JSON.stringify({ ...readBootState(localStorage.getItem(BOOT_KEY)), zoom });
    if (localStorage.getItem(BOOT_KEY) !== next) localStorage.setItem(BOOT_KEY, next);
  } catch {
    /* keep going */
  }
}

/**
 * What the static first screen needs that the window's storage doesn't already hold: the zoom, which the native side
 * keeps, and Home's shape the last time it loaded (how many accounts each provider pools, how many machines), so its
 * skeletons have the rows the content will. services/zoom.ts and Home write it as those change, and index.html's
 * scripts read it before the first paint. Only counts and look values ever go in, never a name; the key is the
 * window's own.
 */
export const BOOT_KEY = 'arbor.boot.v1';

/**
 * Set on the window as the first screen sends its own `frontend_ready` (src/boot/bootPaint.ts), so main.tsx doesn't
 * send a second one the shell would only ignore.
 */
export const FIRST_SCREEN_SHOWN = '__arborFirstScreenShown';
export const firstScreenShown = () => typeof window !== 'undefined' && (window as unknown as Record<string, unknown>)[FIRST_SCREEN_SHOWN] === true;

/** Needs you's rows and whether a "more on the board" line followed, the last time it listed any, and when. */
export type NeedsYouShape = { rows: number; more: boolean; at: number };
export type HomeShape = { providers: number[]; machines: number; needsYou: NeedsYouShape };
export type BootState = { zoom: number; home: HomeShape };

/** Home's shape before it has ever loaded: two providers of two, and the three cards the machines had before. */
export const DEFAULT_HOME_SHAPE: HomeShape = { providers: [2, 2], machines: 3, needsYou: { rows: 0, more: false, at: 0 } };
const DEFAULT_BOOT_STATE: BootState = { zoom: 1, home: DEFAULT_HOME_SHAPE };

/** Enough rows to show the shape without a skeleton taller than any screen. */
export const MAX_PROVIDERS = 6;
export const MAX_ACCOUNTS = 8;
export const MAX_MACHINES = 9;
export const MAX_NEEDS_YOU = 6;
/** Needs you lists the last two hours (fleetBoard.ts NEEDS_YOU_WINDOW_MS); rows seen longer ago than that have aged out. */
export const NEEDS_YOU_RECENT_MS = 2 * 60 * 60 * 1000;

/** Whether Needs you is likely to list rows now: it did within its window. */
export const needsYouLikely = (shape: NeedsYouShape, nowMs: number) => shape.rows > 0 && nowMs - shape.at < NEEDS_YOU_RECENT_MS;

const count = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min ? Math.min(max, value) : null;

function readHomeShape(value: unknown): HomeShape {
  if (!value || typeof value !== 'object') return DEFAULT_HOME_SHAPE;
  const { providers, machines, needsYou } = value as Record<string, unknown>;
  const attention = needsYou && typeof needsYou === 'object' ? needsYou as Record<string, unknown> : {};
  const pooled = Array.isArray(providers)
    ? providers.map((accounts) => count(accounts, 1, MAX_ACCOUNTS)).filter((accounts): accounts is number => accounts !== null).slice(0, MAX_PROVIDERS)
    : [];
  return {
    providers: pooled.length ? pooled : DEFAULT_HOME_SHAPE.providers,
    // A Home with no machines yet still draws one card's room; its empty state is about as tall.
    machines: Math.max(1, count(machines, 0, MAX_MACHINES) ?? DEFAULT_HOME_SHAPE.machines),
    needsYou: {
      rows: count(attention.rows, 0, MAX_NEEDS_YOU) ?? 0,
      more: attention.more === true,
      at: typeof attention.at === 'number' && Number.isFinite(attention.at) ? attention.at : 0,
    },
  };
}

/** The stored state; anything missing or damaged falls back on its own. Zoom stays within the View menu's 83–144%. */
export function readBootState(raw: string | null): BootState {
  let saved: unknown;
  try {
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    return DEFAULT_BOOT_STATE;
  }
  if (!saved || typeof saved !== 'object') return DEFAULT_BOOT_STATE;
  const { zoom, home } = saved as Record<string, unknown>;
  return {
    zoom: typeof zoom === 'number' && zoom >= 0.8 && zoom <= 1.5 ? zoom : 1,
    home: readHomeShape(home),
  };
}

const storedText = () => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(BOOT_KEY);
  } catch {
    return null;
  }
};

/** Keeps part of the state for the next launch's first screen. Blocked storage just means that screen uses defaults. */
function remember(change: (state: BootState) => BootState) {
  try {
    if (typeof localStorage === 'undefined') return;
    const before = storedText();
    const next = JSON.stringify(change(readBootState(before)));
    if (before !== next) localStorage.setItem(BOOT_KEY, next);
  } catch {
    /* keep going */
  }
}

export const rememberBootZoom = (zoom: number) => remember((state) => ({ ...state, zoom }));

export const rememberHomeShape = (shape: Partial<HomeShape>) =>
  remember((state) => ({ ...state, home: readHomeShape({ ...state.home, ...shape }) }));

/**
 * Home's shape as this launch's first screen drew it, read once, so React's skeletons match that screen's for the
 * whole run rather than following what this run writes.
 */
let launchShape: HomeShape | null = null;
export const launchHomeShape = (): HomeShape => (launchShape ??= readBootState(storedText()).home);

import { mainPageIds, normalizeView, settingsPageIds, type AppView } from '../navigation';
import type { RestHolds, WindowPlace } from './pageRest';
import type { ReloadHold } from './reloadHolds';
import { HISTORY_LIMIT, type ViewHistory } from './viewHistory';

/**
 * Reloading the window into a fresh page after it's been closed to the tray or minimized for a long while
 * (docs/perf/BACKLOG.md, M3). Letting the open page go (pageRest.ts) frees what it held, but WebKit keeps the page's
 * peak memory, so only a new page gets back to launch size. The new page starts in the background: the monitors start
 * as at launch and carry on, and the sidebar and the open view wait until the window shows, back on the view it was
 * left on.
 */

/** How long the window is closed or minimized before it reloads. Covered by other windows never counts. */
export const RELOAD_AFTER_MS = 30 * 60_000;
/** How often a hidden window asks where it is: two window commands, so not often. */
export const RELOAD_CHECK_MS = 5 * 60_000;

/**
 * How long the window has been away this time: when it hid, since when it's been closed or minimized (null while
 * covered or not yet known), and whether it has been asked yet.
 */
export type AwayTrack = { hiddenAtMs: number | null; awaySinceMs: number | null; looked: boolean };

export const SHOWN_TRACK: AwayTrack = { hiddenAtMs: null, awaySinceMs: null, looked: false };

/** The window just hid, at `nowMs`; hiding again while hidden changes nothing. */
export const hiddenAt = (track: AwayTrack, nowMs: number): AwayTrack => (track.hiddenAtMs === null ? { hiddenAtMs: nowMs, awaySinceMs: null, looked: false } : track);

/**
 * What a look at the window in `place` says. Found away on the first look since it hid, it's taken as away since it
 * hid (it was likely closed straight away); after that, away since this look. Covered starts the count over.
 */
export function lookedAt(track: AwayTrack, place: WindowPlace, nowMs: number): AwayTrack {
  if (place === 'shown') return SHOWN_TRACK;
  const hiddenAtMs = track.hiddenAtMs ?? nowMs;
  if (place === 'covered') return { hiddenAtMs, awaySinceMs: null, looked: true };
  return { hiddenAtMs, awaySinceMs: track.awaySinceMs ?? (track.looked ? nowMs : hiddenAtMs), looked: true };
}

/** Why the window doesn't reload now. */
export type ReloadBlock = 'no-page' | 'not-away' | 'too-soon' | keyof RestHolds | ReloadHold;

export type ReloadInputs = {
  track: AwayTrack;
  nowMs: number;
  /** Whether this page has shown the app: one started in the background and never shown has nothing to let go of. */
  shell: boolean;
  /** What the open page has that a reload would lose, as pageRest reads it. */
  page: RestHolds;
  holds: readonly ReloadHold[];
};

/** Why the window shouldn't reload now, or null when it should. */
export function reloadBlock({ track, nowMs, shell, page, holds }: ReloadInputs): ReloadBlock | null {
  if (!shell) return 'no-page';
  if (track.awaySinceMs === null) return 'not-away';
  if (nowMs - track.awaySinceMs < RELOAD_AFTER_MS) return 'too-soon';
  if (page.unsaved) return 'unsaved';
  if (page.dialog) return 'dialog';
  if (page.busy) return 'busy';
  return holds[0] ?? null;
}

/**
 * How long a page the window reloaded into leaves the tray as the page before left it, rather than clearing it while
 * the monitors take their first readings: the minute the tray keeps to anyway. A push that clears it then waits.
 */
export const TRAY_KEPT_MS = 60_000;

/** Whether a push to the tray waits: one that would clear it, on a page reloaded into the background, in its first minute. */
export const trayPushWaits = (clears: boolean, background: boolean, sinceBootMs: number) => clears && background && sinceBootMs < TRAY_KEPT_MS;

export { backgroundBootUrl, reloadedPage, startsInBackground, withoutBootMark } from './bootMark';

/** Where what's carried over a reload waits for the new page. Only views, ids and times: nothing secret. */
export const CARRY_KEY = 'arbor.reload-carry.v1';
/** A carry older than this is from some other reload, and isn't taken. */
export const CARRY_FRESH_MS = 5 * 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const writeCarry = (values: Record<string, unknown>, nowMs: number) => JSON.stringify({ savedAtMs: nowMs, values });

/** What's carried over, read back: the values when they're fresh and well formed, else nothing. */
export function readCarry(raw: string | null, nowMs: number): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || typeof parsed.savedAtMs !== 'number' || !isRecord(parsed.values)) return {};
    if (nowMs - parsed.savedAtMs > CARRY_FRESH_MS || parsed.savedAtMs > nowMs + 60_000) return {};
    return parsed.values;
  } catch {
    return {};
  }
}

/** A carried view, if it's one this version has. */
function carriedView(value: unknown): AppView | null {
  if (!isRecord(value)) return null;
  const { kind, page, params } = value;
  if (kind === 'settings') {
    return settingsPageIds.some((id) => id === page) && params === undefined ? ({ kind, page } as AppView) : null;
  }
  if (kind !== 'main' || !mainPageIds.some((id) => id === page)) return null;
  if (params === undefined) return { kind, page } as AppView;
  if (!isRecord(params) || !Object.values(params).every((param) => typeof param === 'string')) return null;
  return normalizeView({ kind, page, params } as AppView);
}

/** The carried view history, less any step this version doesn't know, or null. */
export function carriedHistory(value: unknown): ViewHistory | null {
  if (!isRecord(value) || !Array.isArray(value.entries) || typeof value.index !== 'number') return null;
  const steps: unknown[] = value.entries;
  const current = carriedView(steps[value.index]);
  if (!current) return null;
  const entries: AppView[] = [];
  let index = 0;
  steps.forEach((step, position) => {
    const view = carriedView(step);
    if (!view) return;
    if (position === value.index) index = entries.length;
    entries.push(view);
  });
  const dropped = Math.max(0, entries.length - HISTORY_LIMIT);
  return { entries: entries.slice(dropped), index: Math.max(0, index - dropped) };
}

/** Carried times by id (each automation's last run seen), or null. */
export function carriedTimes(value: unknown): Record<string, number> | null {
  if (!isRecord(value) || !Object.values(value).every((time) => typeof time === 'number')) return null;
  return value as Record<string, number>;
}

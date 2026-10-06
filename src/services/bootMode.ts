import { CARRY_KEY, carriedHistory, readCarry, reloadedPage, startsInBackground, TRAY_KEPT_MS, trayPushWaits, withoutBootMark } from './backgroundReload';
import { receiveCarry } from './reloadHolds';
import { resetViewHistory } from './viewHistory';

let background = false;
let bootedAtMs = Date.now();

/**
 * Whether this page started in the background: the window reloaded itself while closed to the tray
 * (services/backgroundReload.ts) and hasn't been shown since it started. Its monitors run as at launch; the app's
 * pages wait for the window to show.
 */
export const bootedInBackground = () => background;

/**
 * Reads how this page starts, before anything is drawn, and returns whether it's in the background. A page the window
 * reloaded into takes what the page before it carried over, its views first, and drops the mark from its address so
 * a later reload starts as usual.
 */
export function beginBoot(): boolean {
  const href = window.location.href;
  if (!reloadedPage(href)) return false;
  background = startsInBackground(href, document.visibilityState === 'hidden');
  bootedAtMs = Date.now();
  window.history.replaceState(window.history.state, '', withoutBootMark(href));
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(CARRY_KEY);
    window.sessionStorage.removeItem(CARRY_KEY);
  } catch {
    /* nothing carried: it starts on Home */
  }
  const values = readCarry(raw, Date.now());
  receiveCarry(values);
  const history = carriedHistory(values.history);
  if (history) resetViewHistory(history);
  return background;
}

const waitingForTray = new Map<string, number>();

/**
 * Sends `key`'s part of the tray (a menu section's rows, the status dot) with `send`. On a page the window reloaded
 * into, one that would clear it waits out the first minute, so the menu doesn't empty while the monitors take their
 * first readings; anything newer meanwhile replaces it.
 */
export function pushToTray(key: string, clears: boolean, send: () => void) {
  const waiting = waitingForTray.get(key);
  if (waiting !== undefined) window.clearTimeout(waiting);
  waitingForTray.delete(key);
  const sinceBootMs = Date.now() - bootedAtMs;
  if (!trayPushWaits(clears, background, sinceBootMs)) {
    send();
    return;
  }
  waitingForTray.set(key, window.setTimeout(() => {
    waitingForTray.delete(key);
    send();
  }, TRAY_KEPT_MS - sinceBootMs));
}

/**
 * Runs `run` once the window is shown: at once, unless this page started in the background and the window hasn't
 * shown since. For what only matters to someone looking (an update check). Returns a cleanup.
 */
export function whenShown(run: () => void): () => void {
  if (!background || document.visibilityState !== 'hidden') {
    run();
    return () => undefined;
  }
  const shown = () => {
    if (document.visibilityState === 'hidden') return;
    document.removeEventListener('visibilitychange', shown);
    run();
  };
  document.addEventListener('visibilitychange', shown);
  return () => document.removeEventListener('visibilitychange', shown);
}

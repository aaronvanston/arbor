import { useEffect, useRef } from 'react';
import {
  backgroundBootUrl,
  CARRY_KEY,
  hiddenAt,
  lookedAt,
  RELOAD_CHECK_MS,
  reloadBlock,
  SHOWN_TRACK,
  writeCarry,
  type AwayTrack,
} from '../services/backgroundReload';
import { packCarry, reloadHolds } from '../services/reloadHolds';
import { savesSettled } from '../services/savedStore';
import { readPageHolds, readWindowPlace } from './usePageRest';

/**
 * Reloads the window into a fresh page once it's been closed to the tray or minimized for half an hour
 * (services/backgroundReload.ts), so its memory goes back to launch size. `shell` says whether this page has shown the
 * app; one that started in the background and hasn't been shown since has nothing to let go of. It looks every five
 * minutes while hidden, and not at all while shown.
 */
export function useBackgroundReload(shell: boolean) {
  const shellRef = useRef(shell);
  shellRef.current = shell;

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let track: AwayTrack = SHOWN_TRACK;
    const hidden = () => document.visibilityState === 'hidden';
    const due = () => !disposed && hidden() && reloadBlock({ track, nowMs: Date.now(), shell: shellRef.current, page: readPageHolds(), holds: reloadHolds() }) === null;
    const look = () => {
      timer = window.setTimeout(() => void check(), RELOAD_CHECK_MS);
    };
    const check = async () => {
      timer = undefined;
      const place = await readWindowPlace();
      if (disposed || !hidden()) return;
      track = lookedAt(track, place, Date.now());
      if (due()) {
        // What the app is still saving lands first; then it's asked again, as the wait may have let something start.
        await savesSettled();
        if (due()) {
          try {
            window.sessionStorage.setItem(CARRY_KEY, writeCarry(packCarry(), Date.now()));
          } catch {
            /* nothing carried: it comes back on Home */
          }
          disposed = true;
          window.location.replace(backgroundBootUrl(window.location.href));
          return;
        }
      }
      if (!disposed && hidden()) look();
    };
    const follow = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (!hidden()) {
        track = SHOWN_TRACK;
        return;
      }
      track = hiddenAt(track, Date.now());
      if (shellRef.current) look();
    };
    follow();
    document.addEventListener('visibilitychange', follow);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', follow);
    };
  }, []);
}

import { useEffect, useRef } from 'react';
import type { RunHarness } from '../native/types';
import { listen } from '@tauri-apps/api/event';
import { useAppPreferences } from '../appPreferences';
import { loadFleetSources, recentSessionIds, useFleetBoard, waitingCount, workingByMachine } from '../services/fleetBoard';
import { isWindowHidden, pacedInterval, throttleWaitMs } from '../services/hiddenPace';
import { reportWorkingSessions } from '../services/pools';
import { getFleetTrayCounts, setT3ThreadsEnabled, setT3ThreadTitles, setTrayWaiting, T3_THREADS_UPDATED_EVENT } from '../services/fleetSources';
import { runHarnessesOff, setRunHarnessesOff } from '../services/runs';
import { bootedInBackground } from '../services/bootMode';

/** New events from a machine's reporter, and new requests, which can end a wait or start work. */
const SOURCE_EVENTS = [T3_THREADS_UPDATED_EVENT, 'agent-attention-updated', 'usage-records-updated'];
const CHECK_THROTTLE_MS = 5_000;
/** Work goes quiet and turns go stale with nothing arriving, so the board is read on a timer too. */
const CHECK_INTERVAL_MS = 15_000;

/**
 * Headless: keeps the live board fresh for Sessions › Live and Home, and the number of sessions waiting on you beside
 * the tray icon, and each machine's working sessions for the pools. It keeps reading while the window is hidden, since
 * then the tray is all that shows, but once a minute (services/hiddenPace.ts), and at once when it shows. It tells the backend whether to read T3 Code's threads, which it does nothing about
 * until told.
 */
export function FleetMonitor() {
  const { fleetT3Threads, fleetT3Titles, runsToOrca } = useAppPreferences();
  const { board } = useFleetBoard();
  const checkRef = useRef<() => void>(() => undefined);
  const needsInitialFleetReadRef = useRef(bootedInBackground());
  const trayWaitingRef = useRef<number | null>(null);
  const updateTrayWaiting = (waiting: number) => {
    if (waiting === trayWaitingRef.current) return Promise.resolve();
    trayWaitingRef.current = waiting;
    return setTrayWaiting(waiting).catch((error) => {
      trayWaitingRef.current = null;
      console.warn('Failed to show the sessions waiting on you on the tray icon', error);
    });
  };

  useEffect(() => {
    let disposed = false;
    let running = false;
    let lastCheckMs = 0;
    let pending: number | undefined;
    const stops: (() => void)[] = [];
    const schedule = () => {
      if (pending !== undefined) return;
      pending = window.setTimeout(() => {
        pending = undefined;
        void check();
      }, throttleWaitMs(lastCheckMs, Date.now(), CHECK_THROTTLE_MS, isWindowHidden()));
    };
    const check = async () => {
      if (disposed) return;
      if (running) {
        schedule();
        return;
      }
      running = true;
      lastCheckMs = Date.now();
      try {
        if (document.hidden) {
          if (needsInitialFleetReadRef.current) {
            needsInitialFleetReadRef.current = false;
            await loadFleetSources();
          } else {
            await getFleetTrayCounts();
          }
        } else {
          needsInitialFleetReadRef.current = false;
          await loadFleetSources();
        }
      } finally {
        running = false;
      }
    };
    checkRef.current = () => void check();
    for (const event of SOURCE_EVENTS) {
      listen(event, schedule)
        .then((unlisten) => {
          if (disposed) unlisten();
          else stops.push(unlisten);
        })
        .catch(() => undefined);
    }
    // A read waiting out the hidden minute comes forward when the window shows.
    const stopTimer = pacedInterval(schedule, CHECK_INTERVAL_MS, {
      onChange: (hidden) => {
        if (hidden || pending === undefined) return;
        window.clearTimeout(pending);
        pending = undefined;
        schedule();
      },
    });
    return () => {
      disposed = true;
      checkRef.current = () => undefined;
      stops.forEach((stop) => stop());
      stopTimer();
      if (pending !== undefined) window.clearTimeout(pending);
    };
  }, []);

  // Told first, then read at once: switching it off drops what was read, and on reads it again.
  useEffect(() => {
    let stale = false;
    setT3ThreadsEnabled(fleetT3Threads)
      .catch((error) => console.warn('Failed to turn reading T3 Code threads on or off', error))
      .finally(() => {
        if (!stale) checkRef.current();
      });
    return () => {
      stale = true;
    };
  }, [fleetT3Threads]);

  // Titles change what's read, so the board is read again once the native side has dropped the old reads.
  useEffect(() => {
    let stale = false;
    setT3ThreadTitles(fleetT3Titles)
      .catch((error) => console.warn('Failed to turn reading T3 Code thread titles on or off', error))
      .finally(() => {
        if (!stale) checkRef.current();
      });
    return () => {
      stale = true;
    };
  }, [fleetT3Titles]);

  // The native side picks members for runs, queued ones too, so it's told which harnesses are off.
  const harnessesOff = runHarnessesOff({ runsToOrca }).join(',');
  useEffect(() => {
    setRunHarnessesOff(harnessesOff ? (harnessesOff.split(',') as RunHarness[]) : [])
      .catch((error) => console.warn('Failed to tell Arbor which harnesses take runs', error));
  }, [harnessesOff]);

  // Snoozing, seeing a row and time passing change the count as much as a new read does.
  const waiting = board ? waitingCount(board) : null;
  useEffect(() => {
    if (!isWindowHidden() && waiting !== null) void updateTrayWaiting(waiting);
  }, [waiting]);

  // Pools count a machine's agents as its sessions working now, so they read the same as the sidebar and Home; the
  // native side picks for automations even while the window is hidden, which this keeps reporting through. The ids of
  // sessions just started let go of the slots the pools held for them.
  const working = board ? JSON.stringify({ counts: workingByMachine(board), seen: recentSessionIds(board) }) : null;
  const reportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (working === null || working === reportedRef.current) return;
    reportedRef.current = working;
    const { counts, seen } = JSON.parse(working) as { counts: Record<string, number>; seen: string[] };
    reportWorkingSessions(counts, seen).catch((error) => {
      reportedRef.current = null;
      console.warn('Failed to tell the pools which sessions are working', error);
    });
  }, [working]);

  return null;
}

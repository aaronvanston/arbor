import { useEffect, useMemo, useRef } from 'react';
import { invokeCommand } from '../native/commands';
import type { TrayRow } from '../native/types';
import { listen } from '@tauri-apps/api/event';
import { useAppPreferences } from '../appPreferences';
import { useI18n } from '../i18n';
import { compareFleetRows, fleetSessionName, useFleetBoard } from '../services/fleetBoard';
import { liveTrayRows, setLiveSessions, useLiveSessions, type TrayWaitingSession } from '../services/liveSessions';
import { machineNameIn, useMachineNames } from '../services/machineNames';
import { isWindowHidden, pacedInterval, throttleWaitMs } from '../services/hiddenPace';
import { publishTrayRows } from '../services/trayMenu';

const USAGE_UPDATED_EVENT = 'usage-records-updated';
/** Records arrive every few seconds while agents run; the running sessions are checked at most this often. */
const CHECK_THROTTLE_MS = 10_000;
/** A session that goes quiet has to leave the board without a new record, so they're checked on a timer too. */
const CHECK_INTERVAL_MS = 30_000;

/**
 * Headless: keeps the running sessions fresh for Home's board and the tray menu. While the window is hidden it only
 * checks when the tray shows them, and then once a minute (services/hiddenPace.ts).
 */
export function LiveSessionsMonitor() {
  const { t } = useI18n();
  const { traySessions, sessionTitles } = useAppPreferences();
  const report = useLiveSessions();
  const { board, now } = useFleetBoard();
  const names = useMachineNames();
  const trayRef = useRef(traySessions);
  trayRef.current = traySessions;
  const checkRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let disposed = false;
    let running = false;
    let lastCheckMs = 0;
    let pending: number | undefined;
    let stop: (() => void) | null = null;
    const schedule = () => {
      if (pending !== undefined) return;
      pending = window.setTimeout(() => {
        pending = undefined;
        void check();
      }, throttleWaitMs(lastCheckMs, Date.now(), CHECK_THROTTLE_MS, isWindowHidden()));
    };
    const check = async () => {
      if (disposed || (document.hidden && !trayRef.current)) return;
      if (running) {
        schedule();
        return;
      }
      running = true;
      lastCheckMs = Date.now();
      try {
        const next = await invokeCommand('get_live_sessions');
        if (!disposed) setLiveSessions(next);
      } catch {
        // A failed check keeps the last report; the next update or tick tries again.
      } finally {
        running = false;
      }
    };
    checkRef.current = () => void check();
    void check();
    listen(USAGE_UPDATED_EVENT, schedule)
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    // Shown again, it checks without waiting out the hidden minute.
    const stopTimer = pacedInterval(schedule, CHECK_INTERVAL_MS, {
      onChange: (hidden) => {
        if (hidden) return;
        if (pending !== undefined) window.clearTimeout(pending);
        pending = undefined;
        schedule();
      },
    });
    return () => {
      disposed = true;
      checkRef.current = () => undefined;
      stop?.();
      stopTimer();
      if (pending !== undefined) window.clearTimeout(pending);
    };
  }, []);

  // Titles are read only while Settings › Harnesses' Session titles is on, and the native side drops them when it goes
  // off, so it's told on each change, and then the running sessions are read again. At launch it's only told when it's
  // on: the native side starts with titles off, and only this turns them on.
  const titlesToldRef = useRef(false);
  useEffect(() => {
    let stale = false;
    const changed = titlesToldRef.current;
    titlesToldRef.current = true;
    if (!changed && !sessionTitles) return;
    invokeCommand('set_session_titles', { enabled: sessionTitles })
      .catch((error) => console.warn('Failed to turn reading session titles on or off', error))
      .finally(() => {
        if (!stale && changed) checkRef.current();
      });
    return () => {
      stale = true;
    };
  }, [sessionTitles]);

  const waiting = useMemo((): TrayWaitingSession[] => (board?.rows ?? [])
    .filter((row) => row.countsAsWaiting && (row.status === 'approval' || row.status === 'question'))
    .sort(compareFleetRows)
    .map((row) => ({ name: fleetSessionName(row, t), status: row.status === 'approval' ? 'approval' : 'question', machine: row.machine, sinceMs: row.sinceMs })), [board, t]);
  const trayKey = useMemo(
    () => (traySessions ? JSON.stringify(liveTrayRows(report, waiting, t, { nowMs: now, machineName: (machine) => machineNameIn(names, machine) })) : '[]'),
    [names, now, report, traySessions, waiting, t],
  );
  useEffect(() => {
    publishTrayRows('sessions', JSON.parse(trayKey) as TrayRow[]);
  }, [trayKey]);

  return null;
}

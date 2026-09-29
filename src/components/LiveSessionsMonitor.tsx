import { useEffect, useMemo, useRef } from 'react';
import { invokeCommand } from '../native/commands';
import { listen } from '@tauri-apps/api/event';
import { useAppPreferences } from '../appPreferences';
import { useI18n } from '../i18n';
import { liveTrayLines, setLiveSessions, useLiveSessions } from '../services/liveSessions';

const USAGE_UPDATED_EVENT = 'usage-records-updated';
/** Records arrive every few seconds while agents run; the running sessions are checked at most this often. */
const CHECK_THROTTLE_MS = 10_000;
/** A session that goes quiet has to leave the board without a new record, so they're checked on a timer too. */
const CHECK_INTERVAL_MS = 30_000;

/**
 * Headless: keeps the running sessions fresh for Home's board and the tray menu. While the window is hidden it only
 * checks when the tray shows them.
 */
export function LiveSessionsMonitor() {
  const { t } = useI18n();
  const { traySessions } = useAppPreferences();
  const report = useLiveSessions();
  const trayRef = useRef(traySessions);
  trayRef.current = traySessions;

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
      }, Math.max(0, lastCheckMs + CHECK_THROTTLE_MS - Date.now()));
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
    void check();
    listen(USAGE_UPDATED_EVENT, schedule)
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    const timer = window.setInterval(schedule, CHECK_INTERVAL_MS);
    const checkWhenVisible = () => {
      if (!document.hidden) schedule();
    };
    document.addEventListener('visibilitychange', checkWhenVisible);
    return () => {
      disposed = true;
      stop?.();
      window.clearInterval(timer);
      if (pending !== undefined) window.clearTimeout(pending);
      document.removeEventListener('visibilitychange', checkWhenVisible);
    };
  }, []);

  const trayKey = useMemo(() => (traySessions ? liveTrayLines(report, t).join('\n') : ''), [report, traySessions, t]);
  useEffect(() => {
    invokeCommand('set_tray_lines', { section: 'sessions', lines: trayKey ? trayKey.split('\n') : [] })
      .catch((error) => console.warn('Failed to update the tray sessions', error));
  }, [trayKey]);

  return null;
}

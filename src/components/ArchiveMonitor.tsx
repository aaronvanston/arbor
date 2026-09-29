import { useEffect, useRef } from 'react';
import { useAppPreferences } from '../appPreferences';
import { useI18n } from '../i18n';
import { notify } from '../services/notify';
import { archiveNotification, archiveTrouble, getSessionArchiveStatus, nextArchiveAlert, type ArchiveAlertState } from '../services/sessionArchive';

const STATE_KEY = 'cpa-gui.archive-alerts.v1';
/** The archive's first pass runs a minute after Arbor starts; until then it can't say it's failing. */
const FIRST_CHECK_AFTER_MS = 2 * 60_000;
/** Passes run every five minutes, so the status changes no faster than this. */
const CHECK_INTERVAL_MS = 5 * 60_000;

const readState = (): ArchiveAlertState => {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as ArchiveAlertState;
  } catch {
    return null;
  }
};

const saveState = (state: ArchiveAlertState) => {
  try {
    if (state) localStorage.setItem(STATE_KEY, JSON.stringify(state));
    else localStorage.removeItem(STATE_KEY);
  } catch {
    /* nothing stored */
  }
};

/**
 * Headless watcher for the session archive: notifies when its drive has been away, or the archive has been failing,
 * for an hour, and again each day that lasts. Copying waits while the drive is away, so this is how the user hears
 * that sessions deleted meanwhile won't be kept.
 */
export function ArchiveMonitor() {
  const { t } = useI18n();
  const { archiveAlerts: enabled } = useAppPreferences();
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!enabled) {
      // Switched back on later, it starts over rather than reminding about trouble from before.
      saveState(null);
      return;
    }
    let disposed = false;
    const check = async () => {
      try {
        const status = await getSessionArchiveStatus();
        if (disposed) return;
        const now = Date.now();
        const next = nextArchiveAlert(readState(), archiveTrouble(status), now);
        saveState(next.state);
        if (next.alert) void notify([archiveNotification(next.alert, status, now, tRef.current)]);
      } catch (error) {
        console.warn('Failed to check the session archive for alerts', error);
      }
    };
    const first = window.setTimeout(() => void check(), FIRST_CHECK_AFTER_MS);
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [enabled]);

  return null;
}

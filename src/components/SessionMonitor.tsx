import { useEffect, useRef } from 'react';
import { invokeCommand } from '../native/commands';
import { listen } from '@tauri-apps/api/event';
import { useAppPreferences } from '../appPreferences';
import { raisedAnywhere, resolveScoped, useMachineOverrides, useProjectOverrides } from '../services/machineSettings';
import { useI18n } from '../i18n';
import {
  HEAVY_SESSION_WINDOW_MS,
  heavySessions,
  heavySessionText,
  nextHeavyNotifications,
  setHeavySessions,
  undismissHeavySessions,
} from '../services/heavySessions';
import { notify } from '../services/notify';
import type { UsageSession } from '../native/types';
import { sessionRepository, shortSessionId } from '../services/usageSessions';

const SEEN_KEY = 'arbor.heavy-sessions-seen.v1';
const USAGE_UPDATED_EVENT = 'usage-records-updated';
/** Records arrive every few seconds while agents run; sessions are checked at most this often. */
const CHECK_THROTTLE_MS = 60_000;
/** Without new records a burst still has to age out of the hour, so sessions are checked on a timer too. */
const CHECK_INTERVAL_MS = 5 * 60_000;
/** More at once would be noise; the banner lists every one. */
const MAX_NOTIFICATIONS = 3;

const readSeen = (): Record<string, number> => {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
};

/**
 * Headless watcher for sessions using tokens fast: whenever new usage records arrive (at most once a
 * minute), it totals each session's last hour, subagents included, keeps the ones over the threshold for
 * the banner, and notifies once each time a session goes over.
 */
export function SessionMonitor() {
  const { t } = useI18n();
  const preferences = useAppPreferences();
  const overrides = useMachineOverrides();
  const projects = useProjectOverrides();
  // Checked on, as long as some project or machine flags heavy sessions; each session is held to its project's and
  // machine's threshold.
  const active = raisedAnywhere(preferences, overrides, 'heavySessionTokens', projects);
  const threshold = (session: UsageSession) =>
    resolveScoped(preferences, overrides, projects, { project: sessionRepository(session), machine: session.machine }, 'heavySessionTokens').value;
  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;
  const textRef = useRef({ t });
  textRef.current = { t };
  const seenRef = useRef<Record<string, number>>(typeof localStorage === 'undefined' ? {} : readSeen());

  useEffect(() => {
    if (!active) {
      setHeavySessions([]);
      return;
    }
    let disposed = false;
    let running = false;
    let lastCheckMs = 0;
    let pending: number | undefined;
    const schedule = () => {
      if (pending !== undefined) return;
      pending = window.setTimeout(() => {
        pending = undefined;
        void check();
      }, Math.max(0, lastCheckMs + CHECK_THROTTLE_MS - Date.now()));
    };
    const check = async () => {
      if (disposed) return;
      if (running) {
        schedule();
        return;
      }
      running = true;
      const nowMs = Date.now();
      lastCheckMs = nowMs;
      try {
        const page = await invokeCommand('get_usage_sessions', {
          query: { start: new Date(nowMs - HEAVY_SESSION_WINDOW_MS).toISOString(), sort: 'tokens', page_size: 200 },
        });
        if (disposed) return;
        const items = heavySessions(page, (session) => thresholdRef.current(session));
        setHeavySessions(items);
        const { seen, fresh, changed } = nextHeavyNotifications(seenRef.current, items, nowMs);
        if (changed) {
          seenRef.current = seen;
          try {
            localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
          } catch {
            /* keep in memory */
          }
        }
        if (!fresh.length) return;
        undismissHeavySessions(fresh.map((item) => item.id));
        const { t: translate } = textRef.current;
        void notify(fresh.slice(0, MAX_NOTIFICATIONS).map((item) => {
          const text = heavySessionText(item, translate);
          return {
            title: text.title,
            body: translate('notifications.heavySession.withSession', { text: text.body, id: shortSessionId(item.id) }),
            kind: 'heavySession',
            urgent: true,
            subject: { session: item.id, ...(item.placedOn ? { on: item.placedOn } : {}) },
          };
        }));
      } catch (error) {
        console.warn('Failed to check how fast sessions use tokens', error);
      } finally {
        running = false;
      }
    };

    void check();
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    let stop: (() => void) | undefined;
    listen(USAGE_UPDATED_EVENT, schedule)
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
      window.clearInterval(timer);
      if (pending !== undefined) window.clearTimeout(pending);
    };
  }, [active]);

  return null;
}

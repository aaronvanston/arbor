import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useAppPreferences } from '../appPreferences';
import { machineValue, raisedAnywhere, useMachineOverrides } from '../services/machineSettings';
import { useI18n } from '../i18n';
import {
  machineNotifications,
  nextMachineNotifications,
  SETTLE_AFTER_RESUME_MS,
  sleptBetween,
  type MachineAlertState,
} from '../services/machineAlerts';
import { fetchMachineHealth } from '../services/machineHealth';
import { isWindowHidden, pacedInterval, pacedMs } from '../services/hiddenPace';
import { notify } from '../services/notify';

const STATE_KEY = 'arbor.machine-alerts.v1';
const HEALTH_UPDATED_EVENT = 'machine-health-updated';
/** Rounds come every 5 seconds while the Machines page is open; machines are looked at no more often than this. */
const CHECK_THROTTLE_MS = 30_000;
/** In case a round's event is missed. */
const CHECK_INTERVAL_MS = 2 * 60_000;
/** How often the time is noted, to tell when this Mac has slept: a minute apart while the window is hidden. */
const WAKE_TICK_MS = 10_000;

const readState = (): MachineAlertState => {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') as MachineAlertState;
  } catch {
    return {};
  }
};

/**
 * Headless watcher for the fleet: after the health sampler's rounds it notifies once when a machine has been
 * unreachable for a few minutes (or at once when it needs fixing), and again when it's back. Its reads are
 * passive, so it doesn't hold the sampler on the fast interval the Machines page uses. It notes when this Mac
 * wakes or comes back online, so failures while its own network comes up aren't blamed on the machines.
 */
export function MachineMonitor() {
  const { t } = useI18n();
  const preferences = useAppPreferences();
  const overrides = useMachineOverrides();
  // Running while any machine is alerted about; each alert is then kept to the machines it's on for.
  const enabled = raisedAnywhere(preferences, overrides, 'machineNotifications');
  const onForRef = useRef((machine: string) => machineValue(preferences, overrides, machine, 'machineNotifications'));
  onForRef.current = (machine: string) => machineValue(preferences, overrides, machine, 'machineNotifications');
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!enabled) {
      // Switched back on later, it starts over rather than announcing old outages as over.
      try {
        localStorage.removeItem(STATE_KEY);
      } catch {
        /* nothing stored */
      }
      return;
    }
    let state = readState();
    let disposed = false;
    let running = false;
    let lastCheckMs = 0;
    let pending: number | undefined;
    let resumedAtMs = Date.now();
    let lastTickMs = resumedAtMs;
    let settled: number | undefined;
    const resume = (atMs: number) => {
      resumedAtMs = atMs;
      // Look again once the network has had its minute, rather than waiting for the next round.
      if (settled !== undefined) window.clearTimeout(settled);
      settled = window.setTimeout(() => {
        settled = undefined;
        schedule();
      }, SETTLE_AFTER_RESUME_MS);
    };
    let tickMs = pacedMs(WAKE_TICK_MS, isWindowHidden());
    const tick = () => {
      const now = Date.now();
      if (sleptBetween(lastTickMs, now, tickMs)) resume(now);
      lastTickMs = now;
    };
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
      tick();
      lastCheckMs = Date.now();
      try {
        const snapshot = await fetchMachineHealth(Date.now(), 1_000, true);
        if (disposed) return;
        const next = nextMachineNotifications(state, snapshot.machines, snapshot.now, {
          offline: !navigator.onLine,
          resumedAtMs,
        });
        if (next.changed) {
          state = next.state;
          try {
            localStorage.setItem(STATE_KEY, JSON.stringify(state));
          } catch {
            /* keep in memory */
          }
        }
        void notify(machineNotifications(next.alerts.filter((alert) => onForRef.current(alert.machine)), snapshot.now, tRef.current));
      } catch (error) {
        console.warn('Failed to check the machines for alerts', error);
      } finally {
        running = false;
      }
    };

    // Arbor starting counts as resuming: the network may still be coming up at login, and a stored count
    // ran while nothing was watching.
    resume(resumedAtMs);
    void check();
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    // The gap so far is judged by the pace it was ticking at, before the pace changes.
    const stopWakeTimer = pacedInterval(tick, WAKE_TICK_MS, {
      onChange: (hidden) => {
        tick();
        tickMs = pacedMs(WAKE_TICK_MS, hidden);
      },
    });
    const online = () => resume(Date.now());
    window.addEventListener('online', online);
    let stop: (() => void) | undefined;
    listen(HEALTH_UPDATED_EVENT, schedule)
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
      window.clearInterval(timer);
      stopWakeTimer();
      window.removeEventListener('online', online);
      if (pending !== undefined) window.clearTimeout(pending);
      if (settled !== undefined) window.clearTimeout(settled);
    };
  }, [enabled]);

  return null;
}

import { useEffect, useRef } from 'react';
import { invokeCommand } from '../native/commands';
import { useAppUpdate } from '../appUpdate';
import { useCoreRuntime } from '../coreRuntime';
import { useI18n } from '../i18n';
import { readCommandError } from '../services/commandError';
import { setLiveSessions } from '../services/liveSessions';
import {
  IDLE_UPDATE_CHECK_MS,
  idleAppUpdateBlocked,
  idleAppUpdateOutcome,
  recordAgentCheck,
  recordIdleUpdateFailure,
  takeDueIdleUpdates,
  useIdleUpdates,
  type IdleUpdate,
} from '../services/updateWhenIdle';
import type { AppUpdateTask } from '../native/types';

/**
 * Headless: while an update waits for idle agents, checks the running sessions every 15 seconds, window shown or
 * not, and starts it once none has run for 2 minutes with this Mac awake. The core's goes first, as Arbor's
 * relaunches the app. One that fails, or can't start, is kept for Home to show until it's dismissed.
 */
export function UpdateWhenIdleMonitor() {
  const { t } = useI18n();
  const waiting = useIdleUpdates().updates.length > 0;
  const appUpdate = useAppUpdate();
  const core = useCoreRuntime();
  const latest = useRef({ appUpdate, core, t });
  latest.current = { appUpdate, core, t };
  // An Arbor install this started, and its task as it was before, until the task says how it went.
  const startedApp = useRef<{ update: IdleUpdate; task: AppUpdateTask } | null>(null);

  useEffect(() => {
    if (!waiting) return;
    let disposed = false;
    let checking = false;
    const start = async (update: IdleUpdate) => {
      const { appUpdate: { info, task, install }, core: { status, publishStatus, refreshStatus }, t } = latest.current;
      try {
        if (update.kind === 'app') {
          const blocked = idleAppUpdateBlocked(update, info, t);
          if (blocked) {
            recordIdleUpdateFailure(update, blocked);
            return;
          }
          startedApp.current = { update, task };
          // Starting only begins the download; a failure after that comes as the task's progress.
          const error = await install();
          if (error) {
            startedApp.current = null;
            recordIdleUpdateFailure(update, error);
          }
        } else if (update.kind === 'core') {
          await invokeCommand('install_core_version', { version: update.version });
          await refreshStatus();
        } else if (status?.running) {
          publishStatus(await invokeCommand('restart_core_process'));
        }
      } catch (error) {
        recordIdleUpdateFailure(update, readCommandError(error).message);
        void refreshStatus();
      }
    };
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const running = await invokeCommand('get_live_sessions')
          .then((report) => {
            setLiveSessions(report);
            return report.running;
          })
          .catch(() => null);
        if (disposed) return;
        recordAgentCheck(running, Date.now());
        // Taking them ends this watch; they go ahead one at a time regardless.
        for (const update of takeDueIdleUpdates(Date.now())) await start(update);
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), IDLE_UPDATE_CHECK_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [waiting]);

  // The update dialog closes as the task fails, so a failed Arbor install this started is kept like the others.
  useEffect(() => {
    const started = startedApp.current;
    if (!started || appUpdate.task === started.task) return;
    const outcome = idleAppUpdateOutcome(appUpdate.task, t);
    if (!outcome) return;
    startedApp.current = null;
    if (outcome !== 'settled') recordIdleUpdateFailure(started.update, outcome.failed);
  }, [appUpdate.task, t]);

  return null;
}

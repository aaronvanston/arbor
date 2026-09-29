import { useCallback, useRef } from 'react';
import { invokeCommand } from '../native/commands';
import { Clock, TriangleAlert } from './ui/icons';
import { useCoreRuntime } from '../coreRuntime';
import { useI18n } from '../i18n';
import { formatTime } from '../lib/format';
import { setLiveSessions, useLiveSessions } from '../services/liveSessions';
import {
  cancelIdleUpdates,
  dismissIdleUpdateFailure,
  idleUpdateConfirmation,
  idleUpdateDueAtMs,
  idleUpdateFailureKey,
  idleUpdateTitleKey,
  idleUpdateWaitingText,
  liveAgentLoad,
  scheduleIdleUpdate,
  useIdleUpdates,
  type IdleUpdate,
} from '../services/updateWhenIdle';
import { useConfirmation } from './ConfirmationDialog';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Button } from './ui/button';
import type { LiveSessionsReport } from '../native/types';

/** A slow check falls back to the board's last one rather than holding up the button. */
const FRESH_CHECK_TIMEOUT_MS = 2_000;

/**
 * Starts something that restarts the proxy, warning first when agent sessions are running and offering to wait
 * for them. With none running it goes ahead as before: `unprompted` is that path, for updates with a confirmation
 * of their own.
 */
export function useIdleUpdateGuard() {
  const { t } = useI18n();
  const { status } = useCoreRuntime();
  const report = useLiveSessions();
  const reportRef = useRef(report);
  reportRef.current = report;
  // Only requests through a running core can be cut.
  const coreStopped = status?.running === false;
  const { askChoice } = useConfirmation();
  const checkingRef = useRef(false);

  const guard = useCallback(async (update: IdleUpdate, start: () => void, unprompted: () => void = start) => {
    // The button stays enabled while it checks, and a second click would install or restart twice.
    if (checkingRef.current) return;
    checkingRef.current = true;
    // A fresh check, as the board's can be half a minute old.
    const latest = coreStopped ? null : await new Promise<LiveSessionsReport | null>((resolve) => {
      const timer = window.setTimeout(() => resolve(reportRef.current), FRESH_CHECK_TIMEOUT_MS);
      invokeCommand('get_live_sessions')
        .then((next) => {
          setLiveSessions(next);
          resolve(next);
        })
        .catch(() => resolve(reportRef.current))
        .finally(() => window.clearTimeout(timer));
    });
    checkingRef.current = false;
    const load = liveAgentLoad(latest);
    if (!load.sessions) {
      unprompted();
      return;
    }
    const choice = await askChoice(idleUpdateConfirmation(update, load, t));
    if (choice === 'confirm') scheduleIdleUpdate(update);
    else if (choice === 'secondary') start();
  }, [askChoice, coreStopped, t]);

  return { guard };
}

/** What's waiting for the agents to go idle, with a way to stop waiting; else why the last one to go ahead failed. */
export function IdleUpdateNotice() {
  const { t } = useI18n();
  const state = useIdleUpdates();
  const running = useLiveSessions()?.running ?? 0;

  if (state.updates.length) {
    const dueAtMs = idleUpdateDueAtMs(state);
    const progress = dueAtMs !== null
      ? t('idleUpdate.due', { time: formatTime(dueAtMs) })
      : running ? t(running === 1 ? 'idleUpdate.running.one' : 'idleUpdate.running.other', { count: running }) : '';
    return (
      <Alert
        variant="info"
        icon={<Clock />}
        action={<Button variant="outline" size="sm" onClick={cancelIdleUpdates}>{t('common.cancel')}</Button>}
      >
        <AlertTitle>{t(idleUpdateTitleKey(state.updates))}</AlertTitle>
        <AlertDescription>{[idleUpdateWaitingText(state.updates, t), progress].filter(Boolean).join(' ')}</AlertDescription>
      </Alert>
    );
  }
  if (!state.failure) return null;
  return (
    <Alert
      variant="error"
      icon={<TriangleAlert />}
      action={<Button variant="ghost-muted" size="sm" onClick={dismissIdleUpdateFailure}>{t('idleUpdate.dismiss')}</Button>}
    >
      <AlertTitle>{t(idleUpdateFailureKey(state.failure.update))}</AlertTitle>
      <AlertDescription>{state.failure.error}</AlertDescription>
    </Alert>
  );
}

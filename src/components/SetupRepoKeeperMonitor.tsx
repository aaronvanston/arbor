import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useI18n } from '../i18n';
import { notify } from '../services/notify';
import { FOCUS_AGE_MS, keepRepoNow, keepsInStep, keeperNotification, REPO_KEEPER_EVENT } from '../services/setupRepoKeeper';
import { AUTOLINE_EVENT, autoLineNotification } from '../services/setupAutoline';
import type { AutoLineEvent, RepoKeeper } from '../native/types';

/**
 * Headless: the window's part in keeping the setup repo, and machines, in step. Coming back to the front, it asks for a
 * round when the last fetch is five minutes old or more; when a round runs into something, it raises an alert, once
 * per kind of trouble (the alert history folds repeats about the repo besides). It also says what each machine's run
 * by itself did, why it stopped, or what waits there for the user, one alert per machine, folded on repeat.
 */
export function SetupRepoKeeperMonitor() {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const told = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const front = () => {
      if (!document.hidden && keepsInStep()) void keepRepoNow(FOCUS_AGE_MS).catch(() => undefined);
    };
    window.addEventListener('focus', front);
    const stop = listen<RepoKeeper>(REPO_KEEPER_EVENT, ({ payload }) => {
      if (disposed || payload.running) return;
      const now = payload.enabled && payload.problem ? `${payload.problem}\u0000${payload.detail ?? ''}` : null;
      if (now === told.current) return;
      told.current = now;
      const message = keeperNotification(payload, tRef.current);
      if (message) void notify([message]);
    });
    const runs = listen<AutoLineEvent>(AUTOLINE_EVENT, ({ payload }) => {
      if (disposed) return;
      const message = autoLineNotification(payload, tRef.current);
      if (message) void notify([message]);
    });
    return () => {
      disposed = true;
      window.removeEventListener('focus', front);
      void stop.then((off) => off()).catch(() => undefined);
      void runs.then((off) => off()).catch(() => undefined);
    };
  }, []);

  return null;
}

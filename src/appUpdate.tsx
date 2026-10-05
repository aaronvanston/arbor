import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { invokeCommand } from './native/commands';
import { listen } from '@tauri-apps/api/event';
import { AlertCircle, Download } from './components/ui/icons';
import { Alert, AlertDescription } from './components/ui/alert';
import { Button } from './components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from './components/ui/dialog';
import { Progress } from './components/ui/progress';
import { Spinner } from './components/ui/spinner';
import { useCoreRuntime } from './coreRuntime';
import { translate, useI18n } from './i18n';
import { appUpdateRestartsProxy, settleIdleUpdate } from './services/updateWhenIdle';
import type { AppUpdateInfo, AppUpdateTask } from './native/types';
import { trackFeature } from './services/productAnalytics';
import { afterLaunch } from './services/launchSettle';

type AppUpdateContextValue = {
  info: AppUpdateInfo | null;
  task: AppUpdateTask;
  error: string;
  checking: boolean;
  confirmOpen: boolean;
  hasUpdate: boolean;
  processing: boolean;
  check: () => Promise<void>;
  requestInstall: () => void;
  dismissConfirm: () => void;
  /** Starts installing the latest version; resolves to why it couldn't start, else ''. */
  install: () => Promise<string>;
  cancel: () => Promise<void>;
};

/**
 * How often Arbor's GitHub releases are re-checked while the window is visible. Settings › Updates checks when it opens,
 * and each check is two requests to GitHub's API, which allows 60 an hour without a sign-in.
 */
const UPDATE_POLL_INTERVAL_MS = 30 * 60_000;

const idleTask: AppUpdateTask = {
  running: false,
  cancelable: false,
  phase: 'idle',
  targetVersion: null,
  downloadedBytes: 0,
  totalBytes: null,
  percent: null,
  message: null,
};

const AppUpdateContext = createContext<AppUpdateContextValue | null>(null);

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [task, setTask] = useState<AppUpdateTask>(idleTask);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const startupCheckStarted = useRef(false);

  const check = useCallback(async () => {
    setChecking(true);
    setError('');
    try {
      const result = await invokeCommand('check_app_update');
      setInfo(result);
      setTask((current) => (
        current.running
          ? current
          : {
              ...current,
              phase: result.updateAvailable ? 'available' : 'idle',
              targetVersion: result.updateAvailable ? result.latestVersion : null,
              message: null,
            }
      ));
    } catch (nextError) {
      setInfo(null);
      setError(String(nextError));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;

    void invokeCommand('get_app_update_task')
      .then((current) => {
        if (!disposed) setTask(current);
      })
      .catch(() => undefined);

    void listen<AppUpdateTask>('app-update-progress', (event) => {
      if (disposed) return;
      setTask(event.payload);
      if (event.payload.phase === 'failed') {
        setError(event.payload.message || translate('appUpdate.phase.failed'));
        // The install checks the feed again first, and may have found the update gone from it; what's offered should
        // say so too. The task keeps its failure, so only the feed's answer is taken.
        void invokeCommand('check_app_update')
          .then((result) => { if (!disposed) setInfo(result); })
          .catch(() => undefined);
      } else if (event.payload.phase !== 'canceled') {
        setError('');
      }
    }).then((stop) => {
      if (disposed) stop();
      else stopListening = stop;
    });

    if (!startupCheckStarted.current) {
      startupCheckStarted.current = true;
      // The feed is on the network; Home's own reads go first.
      void afterLaunch().then(() => check());
    }
    // Quiet background poll so the sidebar pill and Home banner appear without a manual check.
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const result = await invokeCommand('check_app_update');
        if (disposed) return;
        // Most polls find what the last one did; keeping the same objects then spares the open page a render.
        setInfo((current) => (current && JSON.stringify(current) === JSON.stringify(result) ? current : result));
        setTask((current) => {
          if (current.running || (current.phase !== 'idle' && current.phase !== 'available')) return current;
          const phase = result.updateAvailable ? 'available' : 'idle';
          const targetVersion = result.updateAvailable ? result.latestVersion : null;
          return current.phase === phase && current.targetVersion === targetVersion ? current : { ...current, phase, targetVersion };
        });
      } catch {
        // Keep the last known result; a transient feed error should not clear an available update.
      }
    };
    const timer = window.setInterval(() => void poll(), UPDATE_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      stopListening?.();
      window.clearInterval(timer);
    };
  }, [check]);

  const install = useCallback(async () => {
    setConfirmOpen(false);
    setError('');
    // Started now, so nothing waits for idle agents to do it.
    settleIdleUpdate('app');
    try {
      await invokeCommand('start_app_update');
      trackFeature('update-started');
      return '';
    } catch (nextError) {
      setError(String(nextError));
      return String(nextError);
    }
  }, []);

  const cancel = useCallback(async () => {
    try {
      await invokeCommand('cancel_app_update');
    } catch (nextError) {
      setError(String(nextError));
    }
  }, []);

  const value = useMemo<AppUpdateContextValue>(() => ({
    info,
    task,
    error,
    checking,
    confirmOpen,
    hasUpdate: Boolean(info?.updateAvailable),
    processing: task.running,
    check,
    requestInstall: () => setConfirmOpen(true),
    dismissConfirm: () => setConfirmOpen(false),
    install,
    cancel,
  }), [cancel, check, checking, confirmOpen, error, info, install, task]);

  return <AppUpdateContext.Provider value={value}>{children}</AppUpdateContext.Provider>;
}

export function useAppUpdate() {
  const context = useContext(AppUpdateContext);
  if (!context) throw new Error('useAppUpdate must be used inside AppUpdateProvider');
  return context;
}

export function AppUpdateDialog() {
  const { t } = useI18n();
  const { info, task, error, confirmOpen, dismissConfirm, install, cancel } = useAppUpdate();
  const { status: coreStatus } = useCoreRuntime();
  const open = confirmOpen || task.running;
  const bundledCore = info?.bundledCoreVersion;

  const percent = task.percent ?? (task.totalBytes && task.totalBytes > 0 ? (task.downloadedBytes / task.totalBytes) * 100 : null);
  const phaseLabel = t(`appUpdate.phase.${task.phase}` as Parameters<typeof t>[0]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && confirmOpen) dismissConfirm(); }}>
      <DialogPopup className="max-w-md" showCloseButton={confirmOpen}>
        <DialogHeader>
          <span className="text-xs font-medium text-muted-foreground">{t('appUpdate.eyebrow')}</span>
          <DialogTitle>{confirmOpen ? t('appUpdate.confirmTitle') : t('appUpdate.progressTitle')}</DialogTitle>
          {confirmOpen ? (
            <DialogDescription>
              {bundledCore && appUpdateRestartsProxy(bundledCore, coreStatus?.currentVersion)
                ? t('appUpdate.confirmDescriptionCore', { version: info?.latestVersion ?? '', core: bundledCore })
                : t('appUpdate.confirmDescription', { version: info?.latestVersion ?? '' })}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {confirmOpen ? (
          <DialogFooter>
            <Button variant="outline" onClick={dismissConfirm}>{t('common.cancel')}</Button>
            <Button onClick={() => void install()}>
              <Download aria-hidden="true" />
              {t('appUpdate.installNow')}
            </Button>
          </DialogFooter>
        ) : (
          <>
            <div className="flex flex-col gap-4 px-6 pb-5">
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="text-muted-foreground">{t('kernel.dialog.phase')}</span>
                <span className="font-medium text-foreground">{phaseLabel}</span>
              </div>
              <Progress value={percent} />
              <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
                <span className="tabular-nums text-foreground">{percent === null ? t('kernel.dialog.unknownProgress') : `${percent.toFixed(1)}%`}</span>
                <span className="min-w-0 truncate">{task.message || phaseLabel}</span>
              </div>
              {error ? (
                <Alert variant="error" icon={<AlertCircle />}>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
            </div>
            <DialogFooter>
              <Button variant="destructive-outline" disabled={!task.cancelable} onClick={() => void cancel()}>
                {task.cancelable ? t('appUpdate.cancelDownload') : <><Spinner /> {phaseLabel}</>}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

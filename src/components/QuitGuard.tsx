import { useEffect, useState } from 'react';
import { invokeCommand } from '../native/commands';
import { listen } from '@tauri-apps/api/event';
import { useAppPreferences } from '../appPreferences';
import { useI18n } from '../i18n';
import { QUIT_GUARD_ARMED_EVENT, quitWarningMs } from '../services/quitGuard';

/**
 * Keeps the native ⌘Q guard in step with its setting, and says why a first ⌘Q didn't quit for as
 * long as a second one would.
 */
export function QuitGuard() {
  const { t } = useI18n();
  const { quitGuard } = useAppPreferences();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void invokeCommand('set_quit_guard', { enabled: quitGuard }).catch((error) => {
      console.warn('Failed to update the quit guard', error);
    });
  }, [quitGuard]);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;
    let timer: number | undefined;
    void listen(QUIT_GUARD_ARMED_EVENT, (event) => {
      window.clearTimeout(timer);
      setOpen(true);
      timer = window.setTimeout(() => setOpen(false), quitWarningMs(event.payload));
    })
      .then((stop) => {
        if (disposed) stop();
        else stopListening = stop;
      })
      .catch((error) => {
        console.error('Failed to listen for the quit warning', error);
      });
    return () => {
      disposed = true;
      stopListening?.();
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center p-4" role="status" aria-live="assertive">
      <div
        data-open={open}
        className="dialog-glass max-w-sm rounded-2xl border px-5 py-3.5 text-center text-popover-foreground transition-[opacity,scale,visibility] duration-150 ease-out data-[open=false]:invisible data-[open=false]:opacity-0 motion-safe:data-[open=false]:scale-98"
      >
        <p className="text-sm font-medium tracking-title">{t('quitGuard.title')}</p>
        <p className="mt-0.5 text-xs leading-[1.45] text-muted-foreground">{t('quitGuard.description')}</p>
      </div>
    </div>
  );
}

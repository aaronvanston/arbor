import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invokeCommand } from '../native/commands';
import { listen } from '@tauri-apps/api/event';
import { useAppPreferences } from '../appPreferences';
import { useI18n } from '../i18n';
import { QUIT_GUARD_ARMED_EVENT, quitWarningMs } from '../services/quitGuard';

/** The warning's fade (`duration-150` below), and a little more, after which a closed warning leaves the page. */
const FADE_OUT_MS = 200;

/**
 * Keeps the native ⌘Q guard in step with its setting, and says why a first ⌘Q didn't quit for as
 * long as a second one would.
 */
export function QuitGuard() {
  const { t } = useI18n();
  const { quitGuard } = useAppPreferences();
  const [open, setOpen] = useState(false);
  // The glass is a full-window blur layer, so it's only in the page while it shows or fades out: `mounted` puts it
  // there, and `shown` turns it on once it's been drawn off, so it fades in just as it did when it was always there.
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const glass = useRef<HTMLDivElement>(null);

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
      setMounted(true);
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

  useEffect(() => {
    if (open) return undefined;
    setShown(false);
    const gone = window.setTimeout(() => setMounted(false), FADE_OUT_MS);
    return () => window.clearTimeout(gone);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !mounted || shown) return;
    // Its closed look is worked out before it opens, so the change is a transition rather than a first draw.
    glass.current?.getBoundingClientRect();
    setShown(true);
  }, [open, mounted, shown]);

  // The live region itself stays, empty and cheap, so a screen reader hears the warning when it's put in.
  return (
    <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center p-4" role="status" aria-live="assertive">
      {mounted ? (
        <div
          ref={glass}
          data-open={shown}
          className="dialog-glass max-w-sm rounded-2xl border px-5 py-3.5 text-center text-popover-foreground transition-[opacity,scale,visibility] duration-150 ease-out data-[open=false]:invisible data-[open=false]:opacity-0 motion-safe:data-[open=false]:scale-98"
        >
          <p className="text-sm font-medium tracking-title">{t('quitGuard.title')}</p>
          <p className="mt-0.5 text-xs leading-[1.45] text-muted-foreground">{t('quitGuard.description')}</p>
        </div>
      ) : null}
    </div>
  );
}

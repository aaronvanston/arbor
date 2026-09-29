import { Toast } from '@base-ui/react/toast';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from './icons';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import { createToastTimers, toastDuration, type ToastHold } from '../../services/toastTimers';
import { Button } from './button';

/** `error` is for a failure with nowhere else to show, and stays until it's dismissed. */
export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export type ToastInput = {
  /** Words, which can hold elements such as the pill of a machine it's about. */
  title: ReactNode;
  description?: ReactNode;
  kind?: ToastKind;
  /** One button, such as Undo. Pressing it also closes the toast. */
  action?: { label: string; onClick: () => void };
  /**
   * Moves focus to the action as the toast shows, for an Undo of something whose own button just went: toasts sit at
   * the end of the page, where the keyboard wouldn't otherwise reach it. With keyboard focus on it, it stays.
   */
  focusAction?: boolean;
  /** How long it shows; 0 keeps it until it's dismissed, as an `error` is unless this says otherwise. */
  durationMs?: number;
  /** A toast with the same id replaces this one rather than stacking under it. */
  id?: string;
};

const KIND_ICON = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert } as const;
const KIND_ICON_CLASS: Record<ToastKind, string> = { info: 'text-info', success: 'text-success', warning: 'text-warning', error: 'text-error' };
const isToastKind = (value: unknown): value is ToastKind => typeof value === 'string' && value in KIND_ICON;

const manager = Toast.createToastManager();
const timers = createToastTimers((id) => manager.close(id));
let sequence = 0;

/**
 * Shows a short note in the corner: a save or copy that worked, or an Undo for something just removed. Errors stay in
 * the inline notices next to what failed, where they don't disappear on their own. One with no such place, such as a
 * copy the clipboard refused or an action run from the search palette (which closes), is an `error` toast, which
 * stays until it's dismissed for the same reason.
 */
export function toast({ title, description, kind = 'info', action, focusAction = false, durationMs, id = `toast-${(sequence += 1)}` }: ToastInput) {
  // A closing toast stays pressable while it fades out, so a quick second press mustn't run the action twice.
  let acted = false;
  manager.add({
    id,
    title,
    description,
    type: kind,
    // Read out after whatever is being said, never interrupting.
    priority: 'low',
    // Counted down here instead, so a hidden window or a pointer on the toast holds it.
    timeout: 0,
    onClose: () => timers.stop(id),
    actionProps: action
      ? {
          children: action.label,
          autoFocus: focusAction,
          onClick: () => {
            manager.close(id);
            if (acted) return;
            acted = true;
            action.onClick();
          },
        }
      : undefined,
  });
  timers.start(id, toastDuration({ durationMs, action, kind }));
  return id;
}

/** Where toasts show, bottom right. Mounted once, by the app. */
export function Toaster() {
  return (
    <Toast.Provider toastManager={manager} limit={3} timeout={0}>
      <ToastViewport />
    </Toast.Provider>
  );
}

const setHold = (reason: ToastHold, held: boolean) => (held ? timers.hold(reason) : timers.release(reason));

/**
 * Only keyboard focus holds the toasts, as in Base UI. A click on a toast focuses it too, and holding for that
 * would keep it on screen until the next click somewhere else.
 */
function keyboardFocused(element: EventTarget | null) {
  if (!(element instanceof Element)) return false;
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

function ToastViewport() {
  const { t } = useI18n();
  const { toasts } = Toast.useToastManager();
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = () => setHold('hidden', document.visibilityState === 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      timers.release('hidden');
    };
  }, []);

  // A toast that closes under the pointer or with focus in it sends no leave or blur, so look again.
  const syncPointerAndFocus = useCallback(() => {
    const viewport = viewportRef.current;
    setHold('hovered', Boolean(viewport?.matches(':hover')));
    const active = document.activeElement;
    setHold('focused', Boolean(viewport?.contains(active)) && keyboardFocused(active));
  }, []);
  useEffect(syncPointerAndFocus, [toasts, syncPointerAndFocus]);

  return (
    <Toast.Portal>
      <Toast.Viewport
        ref={viewportRef}
        aria-label={t('toast.region')}
        className="fixed end-4 bottom-4 z-60 flex w-[min(22rem,calc(100vw-2rem))] flex-col-reverse gap-2 outline-none"
        onMouseEnter={() => setHold('hovered', true)}
        onMouseLeave={() => setHold('hovered', false)}
        onFocus={(event) => setHold('focused', keyboardFocused(event.target))}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHold('focused', false);
        }}
      >
        {toasts.map((item) => <ToastCard key={item.id} toast={item} />)}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

function ToastCard({ toast: item }: { toast: Toast.Root.ToastObject }) {
  const { t } = useI18n();
  const kind = isToastKind(item.type) ? item.type : 'info';
  const Icon = KIND_ICON[kind];
  return (
    <Toast.Root
      toast={item}
      swipeDirection="right"
      className={cn(
        'dropdown-glass pointer-events-auto flex w-full items-start gap-2.5 rounded-xl py-2.5 ps-3 pe-2 text-sm text-popover-foreground outline-none',
        'shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)] focus-visible:ring-2 focus-visible:ring-ring',
        // Follows a swipe, and slides up and fades in; reduced motion keeps only the fade.
        'translate-x-(--toast-swipe-movement-x) transition-[opacity,translate] duration-200 ease-out',
        'data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:data-starting-style:translate-y-0',
        'data-limited:hidden',
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', KIND_ICON_CLASS[kind])} aria-hidden="true" />
      <Toast.Content className="flex min-w-0 flex-1 flex-col gap-0.5 py-px">
        <Toast.Title className="font-medium leading-5 text-foreground" />
        <Toast.Description className="text-xs leading-[1.4] text-muted-foreground" />
      </Toast.Content>
      <div className="flex shrink-0 items-center gap-1">
        {item.actionProps ? <Toast.Action render={<Button variant="outline" size="xs" />} /> : null}
        <Toast.Close aria-label={t('toast.dismiss')} render={<Button variant="ghost-muted" size="icon-xs" />}>
          <X />
        </Toast.Close>
      </div>
    </Toast.Root>
  );
}

import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { X } from './icons';
import type * as React from 'react';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import { Button } from './button';

// Dialogs, popovers, menus and selects share z-50, and each portals to the end of <body> as it opens, so whatever
// opened last is on top: a confirmation asked from a popover covers it, and a select inside a dialog opens over it.
// Tooltips (z-[140]) and toasts (z-60) stay above all of them.
const DIALOG_BACKDROP_CLASS = 'dialog-backdrop fixed inset-0 z-50 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0';
const DIALOG_POPUP_CLASS =
  'dialog-glass relative flex min-h-0 w-full min-w-0 flex-col rounded-2xl border outline-none transition-[scale,opacity] duration-200 ease-in-out will-change-transform data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0';

const Dialog = DialogPrimitive.Root;
/**
 * A dialog that asks for an answer: a click on the backdrop leaves it open, and it announces itself as an alert.
 * It takes the same parts as `Dialog`.
 */
const AlertDialog = AlertDialogPrimitive.Root;
const DialogPortal = DialogPrimitive.Portal;

function DialogPopup({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  const { t } = useI18n();
  return (
    <DialogPortal>
      <DialogPrimitive.Backdrop className={DIALOG_BACKDROP_CLASS} data-slot="dialog-backdrop" />
      <DialogPrimitive.Viewport
        className="fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4"
        data-slot="dialog-viewport"
        // A press beside the dialog would move focus to the page behind it. An alert dialog stays open after one,
        // so focus stays in it; a plain dialog still closes on the click.
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) event.preventDefault();
        }}
      >
        <DialogPrimitive.Popup
          className={cn(DIALOG_POPUP_CLASS, 'row-start-2 max-h-full max-w-lg text-popover-foreground', className)}
          data-slot="dialog-popup"
          {...props}
        >
          {children}
          {showCloseButton ? (
            <DialogPrimitive.Close aria-label={t('common.close')} className="absolute end-2 top-2" render={<Button size="icon" variant="ghost-muted" />}>
              <X />
            </DialogPrimitive.Close>
          ) : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-2 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3', className)} data-slot="dialog-header" {...props} />;
}

function DialogFooter({ className, variant = 'default', ...props }: React.ComponentProps<'div'> & { variant?: 'default' | 'bare' }) {
  return (
    <div
      className={cn(
        'flex flex-row justify-end gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] px-6',
        variant === 'default' && 'border-t bg-muted/72 py-4 dark:bg-input/16',
        variant === 'bare' && 'py-4',
        className,
      )}
      data-slot="dialog-footer"
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return <DialogPrimitive.Title className={cn('text-lg font-semibold leading-none tracking-title', className)} data-slot="dialog-title" {...props} />;
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return <DialogPrimitive.Description className={cn('text-sm text-muted-foreground', className)} data-slot="dialog-description" {...props} />;
}

function DialogPanel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('min-h-0 overflow-y-auto p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1 in-[[data-slot=dialog-popup]:has([data-slot=dialog-footer]:not(.border-t))]:pb-1', className)}
      data-slot="dialog-panel"
      {...props}
    />
  );
}

export { DIALOG_BACKDROP_CLASS, DIALOG_POPUP_CLASS, AlertDialog, Dialog, DialogPortal, DialogPopup, DialogHeader, DialogFooter, DialogTitle, DialogDescription, DialogPanel };

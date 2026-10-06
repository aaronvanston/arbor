import { useCallback, useEffect, useId, useRef, useSyncExternalStore, type ReactNode, type Ref } from 'react';
import { TriangleAlert } from './ui/icons';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { createConfirmationQueue, type ConfirmationChoice } from '../services/confirmationQueue';
import { holdReloadWhile } from '../services/reloadHolds';
import { Button } from './ui/button';
import { AlertDialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from './ui/dialog';

/** Words can hold elements, such as the pill of a machine the confirmation is about. */
export type ConfirmationOptions = {
  title: ReactNode;
  message: ReactNode;
  confirmText?: string;
  /** A second way to go ahead, between Cancel and the confirm button. */
  secondaryText?: string;
  warning?: string;
  details?: { label: ReactNode; value: ReactNode }[];
  variant?: 'primary' | 'danger';
};

type Decisions = { onDecision: (confirmed: boolean) => void; onSecondary?: () => void };

// Every confirmation in the app goes through this one queue and shows in the one host, one after another.
const confirmations = createConfirmationQueue<ConfirmationOptions>();
// A question waiting for an answer, on screen or not yet, would go with a reload.
holdReloadWhile('confirmation', () => confirmations.current() !== null);

/** What a confirmation says and its buttons. Apart from the dialog around it so tests can render it without a portal. */
export function ConfirmationContent({
  title, message, confirmText, secondaryText, warning, details, variant = 'primary', onDecision, onSecondary, cancelRef,
}: ConfirmationOptions & Decisions & { cancelRef?: Ref<HTMLButtonElement> }) {
  const { t } = useI18n();
  return (
    <>
      <DialogHeader className="pe-14">
        <div className="flex items-center gap-2">
          <TriangleAlert className={cn('size-4 shrink-0', variant === 'danger' ? 'text-error' : 'text-warning')} aria-hidden="true" />
          <DialogTitle>{title}</DialogTitle>
        </div>
        <DialogDescription>{message}</DialogDescription>
      </DialogHeader>
      {details?.length || warning ? (
        <div className="flex flex-col gap-3 px-6 pb-5">
          {details?.length ? (
            <dl className="overflow-hidden rounded-lg border border-border/60 text-sm [&>div+div]:border-t [&>div+div]:border-border/50">
              {details.map((detail, index) => (
                // A fixed list, shown once, so its order is its identity.
                <div key={index} className="flex items-center justify-between gap-4 px-3 py-1.5">
                  <dt className="text-muted-foreground">{detail.label}</dt>
                  <dd className="min-w-0 truncate font-mono text-sm text-foreground">{detail.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {warning ? <p className="rounded-lg border border-warning/32 bg-warning-surface px-3 py-2 text-xs text-warning-foreground">{warning}</p> : null}
        </div>
      ) : null}
      <DialogFooter>
        <Button ref={cancelRef} variant="outline" onClick={() => onDecision(false)}>{t('common.cancel')}</Button>
        {secondaryText && onSecondary ? <Button variant="outline" onClick={onSecondary}>{secondaryText}</Button> : null}
        <Button variant={variant === 'danger' ? 'destructive' : 'default'} onClick={() => onDecision(true)}>{confirmText ?? t('common.confirm')}</Button>
      </DialogFooter>
    </>
  );
}

/**
 * A confirmation as an alert dialog: a click on the backdrop leaves it open, so only a button, Escape or the close
 * button answers it. Cancel has focus first, so Enter doesn't go ahead by accident.
 */
function ConfirmationDialog(props: ConfirmationOptions & Decisions) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { onDecision } = props;
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onDecision(false); }}>
      <DialogPopup className="max-w-md" initialFocus={cancelRef}>
        <ConfirmationContent {...props} cancelRef={cancelRef} />
      </DialogPopup>
    </AlertDialog>
  );
}

/** Shows the confirmation at the front of the queue. Mounted once, by the app. */
export function ConfirmationHost() {
  const request = useSyncExternalStore(confirmations.subscribe, confirmations.current, () => null);
  if (!request) return null;
  const decide = (choice: ConfirmationChoice) => confirmations.decide(request.id, choice);
  return (
    <ConfirmationDialog
      key={request.id}
      {...request.options}
      onDecision={(confirmed) => decide(confirmed ? 'confirm' : 'cancel')}
      onSecondary={() => decide('secondary')}
    />
  );
}

/**
 * Asks before going ahead. Requests wait their turn behind any confirmation already showing, and the ones a
 * component asked are canceled when it goes away.
 */
export function useConfirmation() {
  const owner = useId();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      confirmations.cancelOwner(owner);
    };
  }, [owner]);
  /** Resolves with the button chosen, for confirmations with a `secondaryText`. */
  const askChoice = useCallback(
    (options: ConfirmationOptions): Promise<ConfirmationChoice> => (mountedRef.current ? confirmations.ask(owner, options) : Promise.resolve('cancel')),
    [owner],
  );
  const askConfirmation = useCallback(
    (options: ConfirmationOptions) => askChoice(options).then((choice) => choice === 'confirm'),
    [askChoice],
  );
  return { askConfirmation, askChoice };
}

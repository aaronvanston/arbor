/** Which button closed a confirmation. Escape and the close button cancel. */
export type ConfirmationChoice = 'confirm' | 'secondary' | 'cancel';

export type ConfirmationRequest<Options> = { id: number; owner: string; options: Options };

type Pending<Options> = ConfirmationRequest<Options> & { resolve: (choice: ConfirmationChoice) => void };

/**
 * Confirmations waiting to be shown, one at a time and in the order they were asked. A second request waits its
 * turn rather than replacing the first and silently canceling it. `owner` is the component that asked, so its
 * requests can be dropped when it goes away.
 */
export function createConfirmationQueue<Options>() {
  let queue: Pending<Options>[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const settle = (request: Pending<Options>, choice: ConfirmationChoice) => {
    queue = queue.filter((item) => item !== request);
    request.resolve(choice);
  };

  return {
    ask(owner: string, options: Options): Promise<ConfirmationChoice> {
      // A double click asks the same thing twice; the first ask stands and the second goes away.
      const key = JSON.stringify(options);
      if (queue.some((item) => item.owner === owner && JSON.stringify(item.options) === key)) return Promise.resolve('cancel');
      return new Promise((resolve) => {
        queue = [...queue, { id: nextId++, owner, options, resolve }];
        emit();
      });
    },
    /** The confirmation on screen, or null. Stable between changes, for `useSyncExternalStore`. */
    current(): ConfirmationRequest<Options> | null {
      return queue[0] ?? null;
    },
    /** Answers the confirmation on screen; the next one waiting shows after it. */
    decide(id: number, choice: ConfirmationChoice) {
      const request = queue[0];
      if (request?.id !== id) return;
      settle(request, choice);
      emit();
    },
    /** Cancels everything a component asked, shown or waiting. */
    cancelOwner(owner: string) {
      const dropped = queue.filter((item) => item.owner === owner);
      if (!dropped.length) return;
      dropped.forEach((request) => settle(request, 'cancel'));
      emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

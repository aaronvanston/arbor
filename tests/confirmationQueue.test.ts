import { describe, expect, it } from 'bun:test';
import { createConfirmationQueue, type ConfirmationChoice } from '../src/services/confirmationQueue';
import { present } from './support/items';

type Options = { title: string };

/** Records each answer as it arrives, so a test can see which promises have settled. */
function answers() {
  const settled: Record<string, ConfirmationChoice> = {};
  const track = (name: string, promise: Promise<ConfirmationChoice>) => {
    void promise.then((choice) => {
      settled[name] = choice;
    });
  };
  return { settled, track };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the confirmation queue', () => {
  it('shows confirmations one after another, in the order they were asked', async () => {
    const queue = createConfirmationQueue<Options>();
    const { settled, track } = answers();
    track('delete', queue.ask('page', { title: 'Delete the key?' }));
    track('update', queue.ask('updates', { title: 'Update while agents run?' }));
    expect(present(queue.current()).options.title).toBe('Delete the key?');

    queue.decide(present(queue.current()).id, 'confirm');
    await flush();
    // The first answer is the one given, not a cancel because another request came in.
    expect(settled).toEqual({ delete: 'confirm' });
    expect(present(queue.current()).options.title).toBe('Update while agents run?');

    queue.decide(present(queue.current()).id, 'secondary');
    await flush();
    expect(settled).toEqual({ delete: 'confirm', update: 'secondary' });
    expect(queue.current()).toBeNull();
  });

  it('ignores an answer for a confirmation that is not the one showing', async () => {
    const queue = createConfirmationQueue<Options>();
    const { settled, track } = answers();
    track('first', queue.ask('page', { title: 'First' }));
    track('second', queue.ask('page', { title: 'Second' }));
    const first = present(queue.current());
    queue.decide(first.id + 1, 'confirm');
    queue.decide(first.id, 'cancel');
    // A late second answer for the one already answered doesn't reach the next.
    queue.decide(first.id, 'confirm');
    await flush();
    expect(settled).toEqual({ first: 'cancel' });
    expect(present(queue.current()).options.title).toBe('Second');
  });

  it('cancels what a component asked when it goes away, shown or still waiting', async () => {
    const queue = createConfirmationQueue<Options>();
    const { settled, track } = answers();
    track('a1', queue.ask('a', { title: 'A one' }));
    track('b', queue.ask('b', { title: 'B' }));
    track('a2', queue.ask('a', { title: 'A two' }));
    queue.cancelOwner('a');
    await flush();
    expect(settled).toEqual({ a1: 'cancel', a2: 'cancel' });
    expect(present(queue.current()).options.title).toBe('B');
    queue.cancelOwner('nobody');
    expect(present(queue.current()).options.title).toBe('B');
  });

  it('lets a double click ask only once', async () => {
    const queue = createConfirmationQueue<Options>();
    const { settled, track } = answers();
    track('first', queue.ask('page', { title: 'Delete?' }));
    track('again', queue.ask('page', { title: 'Delete?' }));
    // The same question from somewhere else still waits its turn.
    track('elsewhere', queue.ask('other', { title: 'Delete?' }));
    await flush();
    expect(settled).toEqual({ again: 'cancel' });
    queue.decide(present(queue.current()).id, 'confirm');
    await flush();
    expect(settled).toEqual({ again: 'cancel', first: 'confirm' });
    expect(present(queue.current()).owner).toBe('other');
  });

  it('tells the host when the confirmation showing changes, and keeps it the same object in between', () => {
    const queue = createConfirmationQueue<Options>();
    let changes = 0;
    const unsubscribe = queue.subscribe(() => {
      changes += 1;
    });
    void queue.ask('page', { title: 'One' });
    void queue.ask('page', { title: 'Two' });
    expect(queue.current()).toBe(queue.current());
    queue.decide(present(queue.current()).id, 'confirm');
    expect(changes).toBe(3);
    unsubscribe();
    queue.decide(present(queue.current()).id, 'confirm');
    expect(changes).toBe(3);
    expect(queue.current()).toBeNull();
  });
});

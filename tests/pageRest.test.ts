import { describe, expect, it } from 'bun:test';
import { REST_AFTER_MS, restDue, scrollToRestore, windowPlace } from '../src/services/pageRest';

const FREE = { unsaved: false, dialog: false, busy: false };

describe('resting the page while the window is hidden', () => {
  it('rests half a minute after the window is closed or minimized, and five minutes after it is covered', () => {
    expect(restDue('away', REST_AFTER_MS.away - 1, FREE)).toBe(false);
    expect(restDue('away', 30_000, FREE)).toBe(true);
    expect(restDue('covered', 4 * 60_000, FREE)).toBe(false);
    expect(restDue('covered', 5 * 60_000, FREE)).toBe(true);
  });

  it('never rests a page on screen, however long', () => {
    expect(restDue('shown', 60 * 60_000, FREE)).toBe(false);
  });

  it('keeps a page with unsaved edits, an open dialog or work going on', () => {
    for (const hold of ['unsaved', 'dialog', 'busy'] as const) {
      expect(restDue('away', 60 * 60_000, { ...FREE, [hold]: true })).toBe(false);
    }
  });

  it('tells closed and minimized from covered, and takes a window it can’t ask about as covered', () => {
    expect(windowPlace(false, { visible: true, minimized: false })).toBe('shown');
    expect(windowPlace(true, { visible: false, minimized: false })).toBe('away');
    expect(windowPlace(true, { visible: true, minimized: true })).toBe('away');
    expect(windowPlace(true, { visible: true, minimized: false })).toBe('covered');
    expect(windowPlace(true, null)).toBe('covered');
  });

  it('scrolls back only on the view it rested on, and only when it was scrolled', () => {
    expect(scrollToRestore({ view: 'usage', top: 640 }, 'usage')).toBe(640);
    expect(scrollToRestore({ view: 'usage', top: 640 }, 'machines')).toBeNull();
    expect(scrollToRestore({ view: 'usage', top: 0 }, 'usage')).toBeNull();
    expect(scrollToRestore(null, 'usage')).toBeNull();
  });
});

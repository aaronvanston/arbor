import { expect, test } from 'bun:test';
import { trackWindowVisibility, whenWindowInFront } from '../src/lib/windowVisibility';

function stubPage(visibilityState: DocumentVisibilityState) {
  const attributes = new Set<string>();
  const listeners = new Set<() => void>();
  const page = {
    visibilityState,
    documentElement: {
      toggleAttribute: (name: string, force?: boolean) => {
        if (force) attributes.add(name);
        else attributes.delete(name);
        return Boolean(force);
      },
    },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  const show = (state: DocumentVisibilityState) => {
    page.visibilityState = state;
    listeners.forEach((listener) => listener());
  };
  return { page: page as unknown as Parameters<typeof trackWindowVisibility>[0], attributes, listeners, show };
}

test('marks the page while the window is hidden and clears it when shown', () => {
  const { page, attributes, show } = stubPage('visible');
  trackWindowVisibility(page);
  expect(attributes.has('data-window-hidden')).toBe(false);
  show('hidden');
  expect(attributes.has('data-window-hidden')).toBe(true);
  show('visible');
  expect(attributes.has('data-window-hidden')).toBe(false);
});

test('starts hidden when the window opens hidden, and stops listening on cleanup', () => {
  const { page, attributes, listeners } = stubPage('hidden');
  const stop = trackWindowVisibility(page);
  expect(attributes.has('data-window-hidden')).toBe(true);
  stop();
  expect(listeners.size).toBe(0);
});

test('runs what counts as looked at only while the window is showing and focused, and each time it comes back', () => {
  const page = { visibilityState: 'hidden' as DocumentVisibilityState, focused: false, listeners: new Set<() => void>() };
  const focusListeners = new Set<() => void>();
  const stubDocument = {
    get visibilityState() { return page.visibilityState; },
    hasFocus: () => page.focused,
    addEventListener: (_type: string, listener: () => void) => page.listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => page.listeners.delete(listener),
  } as unknown as Parameters<typeof whenWindowInFront>[1];
  const stubWindow = {
    addEventListener: (_type: string, listener: () => void) => focusListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => focusListeners.delete(listener),
  } as unknown as Parameters<typeof whenWindowInFront>[2];
  let runs = 0;
  // Closed to the tray: nothing counts as seen.
  const stop = whenWindowInFront(() => void (runs += 1), stubDocument, stubWindow);
  expect(runs).toBe(0);
  // Shown but behind another app's window: still not looked at.
  page.visibilityState = 'visible';
  page.listeners.forEach((listener) => listener());
  expect(runs).toBe(0);
  page.focused = true;
  focusListeners.forEach((listener) => listener());
  expect(runs).toBe(1);
  stop();
  expect(page.listeners.size + focusListeners.size).toBe(0);
  // Already in front, it runs straight away.
  whenWindowInFront(() => void (runs += 1), stubDocument, stubWindow)();
  expect(runs).toBe(2);
});

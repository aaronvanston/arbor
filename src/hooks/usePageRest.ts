import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { REST_CHECK_MS, restDue, scrollToRestore, windowPlace, type RestHolds, type RestScroll, type WindowPlace } from '../services/pageRest';
import { hasUnsavedChanges } from '../services/unsavedChanges';

const PAGE_SCROLL = 'main [data-slot="page-scroll"]';
/** A dialog open, wherever it's portaled to: a page's own can be waiting on a sign-in or a choice. */
const DIALOG = '[data-slot="dialog-popup"]';
/** The page still working on something: a spinner, a refresh going round, or a region marked busy. */
const BUSY = 'main [data-slot="spinner"], main [data-refreshing], main [aria-busy="true"]';
/** When a page that came back is scrolled to where it was: at once, then as its data arrives and it grows. */
const SCROLL_ATTEMPTS_MS = [0, 100, 300, 1_000, 2_000];

/** Where the window is now: on screen, or, hidden, whether Tauri's window says it's closed or minimized. */
export async function readWindowPlace(): Promise<WindowPlace> {
  if (document.visibilityState !== 'hidden') return 'shown';
  try {
    const current = getCurrentWindow();
    const [visible, minimized] = await Promise.all([current.isVisible(), current.isMinimized()]);
    return windowPlace(true, { visible, minimized });
  } catch {
    return windowPlace(true, null);
  }
}

/** What the open page has that resting or reloading it would lose. */
export const readPageHolds = (): RestHolds => ({
  unsaved: hasUnsavedChanges(),
  dialog: document.querySelector(DIALOG) !== null,
  busy: document.querySelector(BUSY) !== null,
});

/**
 * Whether the open page rests while the window is hidden (services/pageRest.ts). It looks every half minute while
 * hidden, and wakes the page the moment the window shows, scrolled back to where it was if it's the same view.
 */
export function usePageRest(view: string): boolean {
  const [resting, setResting] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const savedRef = useRef<RestScroll | null>(null);

  useEffect(() => {
    let disposed = false;
    let hiddenAtMs: number | null = null;
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const check = async () => {
      timer = undefined;
      const place = await readWindowPlace();
      if (disposed || hiddenAtMs === null) return;
      if (restDue(place, Date.now() - hiddenAtMs, readPageHolds())) {
        savedRef.current = { view: viewRef.current, top: document.querySelector<HTMLElement>(PAGE_SCROLL)?.scrollTop ?? 0 };
        setResting(true);
      } else if (place !== 'shown') {
        timer = window.setTimeout(() => void check(), REST_CHECK_MS);
      }
    };
    const follow = () => {
      stop();
      if (document.visibilityState === 'hidden') {
        hiddenAtMs ??= Date.now();
        timer = window.setTimeout(() => void check(), REST_CHECK_MS);
      } else {
        hiddenAtMs = null;
        setResting(false);
      }
    };
    follow();
    document.addEventListener('visibilitychange', follow);
    return () => {
      disposed = true;
      stop();
      document.removeEventListener('visibilitychange', follow);
    };
  }, []);

  // Scrolled back as the page comes back, until it's there or someone scrolls it themselves.
  useEffect(() => {
    if (resting) return;
    const top = scrollToRestore(savedRef.current, viewRef.current);
    savedRef.current = null;
    if (top === null) return;
    let last = 0;
    let done = false;
    const timers = SCROLL_ATTEMPTS_MS.map((delay) => window.setTimeout(() => {
      const scroller = document.querySelector<HTMLElement>(PAGE_SCROLL);
      if (done || !scroller) return;
      if (scroller.scrollTop !== last) {
        done = true;
        return;
      }
      scroller.scrollTop = top;
      last = scroller.scrollTop;
      done = last >= top;
    }, delay));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [resting]);

  return resting;
}

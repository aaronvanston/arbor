import { useSyncExternalStore } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { invokeCommand } from '../native/commands';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { AppTheme } from '../themeController';

type Unlisten = () => void;

/**
 * The Mac window has no title bar of its own (`titleBarStyle: "Overlay"` in tauri.conf.json):
 * macOS draws the window buttons over the sidebar's top row and the page's top rows drag the
 * window. Windows and Linux keep their native title bar.
 *
 * The drag regions work from the page's mousedown, and while Arbor isn't the active app macOS
 * spends the first click on bringing the window forward without passing it to the page
 * (tauri-apps/tauri#4316). So dragging a window in the background takes a click first, then a
 * drag. `acceptFirstMouse` would pass that click on, but to every button under it too, so a click
 * meant only to bring Arbor forward could press one; the window leaves it off.
 */
export function hasMacTitleBar(tauri: boolean, userAgent: string): boolean {
  return tauri && /Macintosh|Mac OS X/.test(userAgent);
}

export interface FullscreenSource {
  isFullscreen(): Promise<boolean>;
  onResized(listener: () => void): Promise<Unlisten>;
}

/**
 * Follows the window in and out of full screen, where macOS hides the window buttons. Entering and
 * leaving both end with a resize; resizes also come in bursts while the window is dragged larger,
 * so one read runs at a time and a burst ends with one more.
 */
export function watchFullscreen(source: FullscreenSource, onChange: (fullscreen: boolean) => void): Unlisten {
  let disposed = false;
  let reading = false;
  let again = false;
  let known: boolean | undefined;
  let unlisten: Unlisten | undefined;

  const read = () => {
    if (disposed) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    source.isFullscreen()
      .then((fullscreen) => {
        if (disposed || fullscreen === known) return;
        known = fullscreen;
        onChange(fullscreen);
      }, () => {
        // Keep the last known state; the next resize reads again.
      })
      .finally(() => {
        reading = false;
        if (again) {
          again = false;
          read();
        }
      });
  };

  source.onResized(read).then((stop) => {
    if (disposed) stop();
    else unlisten = stop;
  }, () => {
    // Without resize events the window keeps the state read at launch.
  });
  read();
  return () => {
    disposed = true;
    unlisten?.();
  };
}

export interface FrameScheduler {
  frame(callback: () => void): void;
  timeout(callback: () => void, ms: number): void;
}

/** How long to wait for animation frames before going ahead without them. */
export const FIRST_PAINT_FALLBACK_MS = 100;

/**
 * Runs `callback` once, after the first frame has painted: two animation frames. WebKit may run no
 * animation frames for a window that isn't on screen yet, and the window stays hidden until this
 * runs, so a short timer stands in for them.
 */
export function afterFirstPaint(callback: () => void, scheduler: FrameScheduler): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    callback();
  };
  scheduler.frame(() => scheduler.frame(run));
  scheduler.timeout(run, FIRST_PAINT_FALLBACK_MS);
}

/** The theme the page painted in, from the root's `data-theme` (index.html's pre-paint script and theme.ts set it). */
export function paintedTheme(value: string | undefined): AppTheme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

let announced = false;

/**
 * Tells the shell the page has painted, so it shows the window it kept hidden at launch
 * (src-tauri/src/main_window.rs), on the page's background color. Once per page load; the shell
 * ignores it after launch.
 */
export function showWindowWhenPainted(): void {
  if (announced) return;
  announced = true;
  afterFirstPaint(() => {
    const theme = paintedTheme(document.documentElement.dataset.theme);
    void invokeCommand('frontend_ready', { theme }).catch(() => {
      // The shell shows the window by itself after a short wait.
    });
  }, {
    frame: (callback) => window.requestAnimationFrame(callback),
    timeout: (callback, ms) => window.setTimeout(callback, ms),
  });
}

let previewMac = false;

/** The browser preview (`?chrome=mac` in src/dev/mockTauri.ts) draws the Mac title bar without the Mac window. */
export function previewMacTitleBar(): void {
  previewMac = true;
}

let fullscreen = false;
let watching = false;
const subscribers = new Set<() => void>();

function macWindow(): boolean {
  return previewMac || hasMacTitleBar(isTauri(), navigator.userAgent);
}

function subscribe(listener: () => void): Unlisten {
  subscribers.add(listener);
  if (!watching && macWindow()) {
    // One watcher for the page's lifetime: the sidebar and every page's top bar share it.
    watching = true;
    const currentWindow = getCurrentWindow();
    watchFullscreen({
      isFullscreen: () => currentWindow.isFullscreen(),
      onResized: (resized) => currentWindow.onResized(() => resized()),
    }, (next) => {
      fullscreen = next;
      subscribers.forEach((notify) => notify());
    });
  }
  return () => { subscribers.delete(listener); };
}

/**
 * True while the page stands in for the Mac title bar: the sidebar's top row leaves room for the
 * window buttons and the top rows drag the window. Off in full screen, where macOS hides the
 * buttons and a double-click would only queue a zoom for later.
 */
export function useMacTitleBar(): boolean {
  const snapshot = () => macWindow() && !fullscreen;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

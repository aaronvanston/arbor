import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { WINDOW_BACKGROUND } from '../src/theme';
import {
  afterFirstPaint,
  FIRST_PAINT_FALLBACK_MS,
  hasMacTitleBar,
  paintedTheme,
  watchFullscreen,
  type FullscreenSource,
} from '../src/services/windowChrome';
import { SYSTEM_REGION_WAIT_MS } from '../src/services/systemRegion';
import { ZOOM_MAX_STEP, ZOOM_MIN_STEP, ZOOM_WAIT_MS, zoomFactor, zoomPercent } from '../src/services/zoom';
import { itemAt } from './support/items';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** A custom property's value where styles.css declares it. */
const declared = (name: string) => read('../src/styles.css').match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();

/**
 * The Mac title row's height in points, or NaN unless styles.css divides it by the zoom. The window buttons it's
 * centered on don't zoom, so to stay that tall on screen the row has to shrink in CSS pixels as the zoom grows.
 */
const topbarPoints = () => Number(declared('--workspace-topbar-height')?.match(/^calc\((\d+)px \/ var\(--zoom\)\)$/)?.[1]);

/** The title row's controls in CSS pixels, which do zoom. */
const titlebarControlPixels = () => Number(declared('--workspace-titlebar-control-size')?.match(/^([\d.]+)rem$/)?.[1]) * 16;

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** A window whose full screen reads answer only when the test says so. */
function fakeWindow() {
  const reads: ReturnType<typeof deferred<boolean>>[] = [];
  let resized: (() => void) | undefined;
  let unlistened = false;
  const source: FullscreenSource = {
    isFullscreen() {
      const next = deferred<boolean>();
      reads.push(next);
      return next.promise;
    },
    async onResized(listener) {
      resized = listener;
      return () => { unlistened = true; };
    },
  };
  return { source, reads, resize: () => resized?.(), unlistened: () => unlistened };
}

describe('the Mac title bar', () => {
  test('only the Mac window draws it; Windows, Linux and the plain browser keep a title bar', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    expect(hasMacTitleBar(true, mac)).toBe(true);
    expect(hasMacTitleBar(false, mac)).toBe(false);
    expect(hasMacTitleBar(true, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/140.0')).toBe(false);
    expect(hasMacTitleBar(true, 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15')).toBe(false);
  });

  test('its buttons sit on the midline of the top bar, whatever height the page gives it', () => {
    const config = JSON.parse(read('../src-tauri/tauri.conf.json'));
    const main = config.app.windows.find((window: { label: string }) => window.label === 'main');
    // Tauri's y sizes the title bar around the buttons rather than placing them. On macOS 27 the
    // buttons are 14pt and their center lands at y − 2 (measured with AppKit), so y is the midline plus 2.
    // The top bar's height is divided by the zoom, as the buttons don't zoom: at actual size it's the height itself.
    expect(main.trafficLightPosition.y).toBe(topbarPoints() / 2 + 2);
  });

  test('its title row stays 52pt on screen at every zoom, with the sidebar button at 90pt and the wordmark 40px past it', () => {
    const styles = read('../src/styles.css');
    expect(topbarPoints()).toBe(52);
    const controls = styles.match(/\[data-app-shell\]\[data-mac-title-bar\] \{\s*--workspace-controls-left: calc\((\d+)px \/ var\(--zoom\)\);/)?.[1];
    expect(Number(controls)).toBe(90);
    expect(styles).toMatch(/--workspace-titlebar-content-left: calc\(var\(--workspace-controls-left\) \+ var\(--workspace-titlebar-control-size\) \+ 0\.75rem\);/);
    // The controls grow with the zoom inside a row that doesn't, so at every step, up to the largest, they keep 4pt
    // above and below them. On screen, a CSS pixel is the zoom factor in points.
    expect(titlebarControlPixels()).toBeGreaterThan(0);
    for (let step = ZOOM_MIN_STEP; step <= ZOOM_MAX_STEP; step++) {
      expect(titlebarControlPixels() * zoomFactor(step)).toBeLessThanOrEqual(topbarPoints() - 8);
    }
  });

  test('the View menu has Actual Size, Zoom In and Zoom Out before full screen, on T3’s keys and steps', () => {
    const zoom = read('../src-tauri/src/zoom.rs');
    const constant = (name: string) => zoom.match(new RegExp(`const ${name}: &str = "([^"]+)";`))?.[1];
    expect([constant('ACTUAL_SIZE_MENU_ID'), constant('ZOOM_IN_MENU_ID'), constant('ZOOM_OUT_MENU_ID')]).toEqual(['view-actual-size', 'view-zoom-in', 'view-zoom-out']);
    expect([constant('ACTUAL_SIZE_ACCELERATOR'), constant('ZOOM_IN_ACCELERATOR'), constant('ZOOM_OUT_ACCELERATOR')]).toEqual(['CmdOrCtrl+0', 'CmdOrCtrl+=', 'CmdOrCtrl+-']);
    const menu = read('../src-tauri/src/quit_guard.rs');
    const view = menu.slice(menu.indexOf('zoom::VIEW_SUBMENU_ID'), menu.indexOf('PredefinedMenuItem::fullscreen'));
    const order = ['ACTUAL_SIZE_MENU_ID', 'ZOOM_IN_MENU_ID', 'ZOOM_OUT_MENU_ID', 'PredefinedMenuItem::separator'].map((item) => view.indexOf(item));
    expect(order.every((position) => position > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Handled where the menu's other items are, and never given to the webview as a permission.
    expect(read('../src-tauri/src/main.rs')).toContain('zoom::menu_zoom_change(id)');
    expect(read('../src-tauri/capabilities/default.json')).not.toContain('zoom');
    expect(Array.from({ length: ZOOM_MAX_STEP - ZOOM_MIN_STEP + 1 }, (_, index) => zoomPercent(zoomFactor(ZOOM_MIN_STEP + index))))
      .toEqual([83, 91, 100, 110, 120, 131, 144]);
  });

  test('the page is allowed the window calls it makes: drag, zoom and reading full screen', () => {
    const capability = JSON.parse(read('../src-tauri/capabilities/default.json'));
    for (const permission of ['core:window:allow-start-dragging', 'core:window:allow-internal-toggle-maximize', 'core:window:allow-is-fullscreen']) {
      expect(capability.permissions).toContain(permission);
    }
  });
});

describe('full screen', () => {
  test('reads the state at the start and after each resize, reporting only changes', async () => {
    const window = fakeWindow();
    const seen: boolean[] = [];
    watchFullscreen(window.source, (fullscreen) => seen.push(fullscreen));
    itemAt(window.reads, 0).resolve(false);
    await settle();
    expect(seen).toEqual([false]);

    window.resize();
    itemAt(window.reads, 1).resolve(true);
    await settle();
    window.resize();
    itemAt(window.reads, 2).resolve(true);
    await settle();
    expect(seen).toEqual([false, true]);
  });

  test('a burst of resizes runs one read at a time and ends with one more', async () => {
    const window = fakeWindow();
    const seen: boolean[] = [];
    watchFullscreen(window.source, (fullscreen) => seen.push(fullscreen));
    await settle();
    window.resize();
    window.resize();
    window.resize();
    expect(window.reads).toHaveLength(1);
    itemAt(window.reads, 0).resolve(false);
    await settle();
    // The resizes during the first read ask once more, for the state they ended in.
    expect(window.reads).toHaveLength(2);
    itemAt(window.reads, 1).resolve(true);
    await settle();
    expect(window.reads).toHaveLength(2);
    expect(seen).toEqual([false, true]);
  });

  test('a failed read keeps the last state and the next resize tries again', async () => {
    const window = fakeWindow();
    const seen: boolean[] = [];
    watchFullscreen(window.source, (fullscreen) => seen.push(fullscreen));
    itemAt(window.reads, 0).reject(new Error('not allowed'));
    await settle();
    expect(seen).toEqual([]);
    window.resize();
    itemAt(window.reads, 1).resolve(true);
    await settle();
    expect(seen).toEqual([true]);
  });

  test('stopping drops a read in flight and stops listening, even before the listener is up', async () => {
    const window = fakeWindow();
    const seen: boolean[] = [];
    const stop = watchFullscreen(window.source, (fullscreen) => seen.push(fullscreen));
    stop();
    itemAt(window.reads, 0).resolve(true);
    await settle();
    expect(seen).toEqual([]);
    expect(window.unlistened()).toBe(true);
  });
});

describe('showing the window after the first paint', () => {
  function scheduler() {
    const frames: (() => void)[] = [];
    const timers: { callback: () => void; ms: number }[] = [];
    return {
      frames,
      timers,
      frame: (callback: () => void) => { frames.push(callback); },
      timeout: (callback: () => void, ms: number) => { timers.push({ callback, ms }); },
      nextFrame: () => frames.splice(0).forEach((callback) => callback()),
    };
  }

  test('goes ahead after two animation frames, once', () => {
    const clock = scheduler();
    let calls = 0;
    afterFirstPaint(() => calls++, clock);
    clock.nextFrame();
    expect(calls).toBe(0);
    clock.nextFrame();
    expect(calls).toBe(1);
    itemAt(clock.timers, 0).callback();
    expect(calls).toBe(1);
  });

  test('a hidden window with no animation frames goes ahead on the timer', () => {
    const clock = scheduler();
    let calls = 0;
    afterFirstPaint(() => calls++, clock);
    expect(clock.timers.map((timer) => timer.ms)).toEqual([FIRST_PAINT_FALLBACK_MS]);
    itemAt(clock.timers, 0).callback();
    expect(calls).toBe(1);
    clock.nextFrame();
    clock.nextFrame();
    expect(calls).toBe(1);
    // Well inside the shell's own wait, so the page, not the fallback, shows the window.
    const shell = read('../src-tauri/src/main_window.rs');
    const fallbackMs = Number(shell.match(/const FRONTEND_READY_FALLBACK: Duration = Duration::from_millis\(([\d_]+)\);/)?.[1]?.replace(/_/g, ''));
    expect(FIRST_PAINT_FALLBACK_MS * 5).toBeLessThanOrEqual(fallbackMs);
    // The first render waits for the Mac's region and the zoom first, side by side (src/main.tsx), so the longer of
    // those and this together stay inside it too.
    expect(Math.max(SYSTEM_REGION_WAIT_MS, ZOOM_WAIT_MS) + FIRST_PAINT_FALLBACK_MS).toBeLessThan(fallbackMs);
  });

  test('tells the shell the painted theme, and nothing it could misread', () => {
    expect(paintedTheme('light')).toBe('light');
    expect(paintedTheme('dark')).toBe('dark');
    for (const value of [undefined, '', 'system', 'Dark']) expect(paintedTheme(value)).toBeNull();
  });

  test('the shell colors the window with the page background for each theme', () => {
    const shell = read('../src-tauri/src/main_window.rs');
    const color = (name: string) => {
      const channels = shell.match(new RegExp(`const ${name}: Color = Color\\((0x[0-9a-f]{2}), (0x[0-9a-f]{2}), (0x[0-9a-f]{2}), 0xff\\);`))!.slice(1, 4);
      return `#${channels.map((channel) => channel.slice(2)).join('')}`;
    };
    expect(color('LIGHT_BACKGROUND')).toBe(WINDOW_BACKGROUND.light);
    expect(color('DARK_BACKGROUND')).toBe(WINDOW_BACKGROUND.dark);
  });
});

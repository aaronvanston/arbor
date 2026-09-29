import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { emit } from '@tauri-apps/api/event';
import { mockCommands } from '../src/dev/mock/answers';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { I18nProvider } from '../src/i18n';
import { AppearanceSettingsPage } from '../src/pages/AppearanceSettingsPage';
import { matchesKeys, SHORTCUTS } from '../src/services/shortcuts';
import {
  canZoomIn,
  canZoomOut,
  clampZoomStep,
  loadZoom,
  nearestZoomStep,
  readZoomLevel,
  resetZoom,
  setZoomStep,
  tryZoomChange,
  ZOOM_CHANGED_EVENT,
  ZOOM_MAX_STEP,
  ZOOM_MIN_STEP,
  zoomFactor,
  zoomFailureReason,
  zoomIn,
  zoomLevelAt,
  zoomOut,
  zoomPercent,
} from '../src/services/zoom';
import type { ZoomLevel } from '../src/native/types';
import { lastItem } from './support/items';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('the zoom’s steps', () => {
  test('are T3’s, 1.2^(n/2) from 83% to 144%, with actual size exactly 1', () => {
    const steps = Array.from({ length: ZOOM_MAX_STEP - ZOOM_MIN_STEP + 1 }, (_, index) => ZOOM_MIN_STEP + index);
    expect(steps.map((step) => zoomPercent(zoomFactor(step)))).toEqual([83, 91, 100, 110, 120, 131, 144]);
    expect(zoomFactor(0)).toBe(1);
    expect(zoomLevelAt(2)).toEqual({ step: 2, factor: zoomFactor(2) });
  });

  test('are the native side’s: the same ends, so the menu and the page agree on where they stop', () => {
    const rust = read('../src-tauri/src/zoom.rs');
    expect(Number(rust.match(/const ZOOM_MIN_STEP: i32 = (-?\d+);/)?.[1])).toBe(ZOOM_MIN_STEP);
    expect(Number(rust.match(/const ZOOM_MAX_STEP: i32 = (-?\d+);/)?.[1])).toBe(ZOOM_MAX_STEP);
    expect(rust).toContain(`const ZOOM_CHANGED_EVENT: &str = "${ZOOM_CHANGED_EVENT}";`);
  });

  test('stop at either end, and anything that isn’t a number is actual size', () => {
    expect(clampZoomStep(-9)).toBe(ZOOM_MIN_STEP);
    expect(clampZoomStep(9)).toBe(ZOOM_MAX_STEP);
    expect(clampZoomStep(1.4)).toBe(1);
    for (const odd of [Number.NaN, Number.POSITIVE_INFINITY]) expect(clampZoomStep(odd)).toBe(0);
    expect(zoomLevelAt(12)).toEqual(zoomLevelAt(ZOOM_MAX_STEP));
    expect(canZoomIn(zoomLevelAt(ZOOM_MAX_STEP))).toBe(false);
    expect(canZoomOut(zoomLevelAt(ZOOM_MAX_STEP))).toBe(true);
    expect(canZoomOut(zoomLevelAt(ZOOM_MIN_STEP))).toBe(false);
    expect(canZoomIn(zoomLevelAt(ZOOM_MIN_STEP))).toBe(true);
  });

  test('take a level previewed off the steps from the nearest one', () => {
    expect(nearestZoomStep(1)).toBe(0);
    expect(nearestZoomStep(1.2)).toBe(2);
    expect(nearestZoomStep(1.25)).toBe(2);
    expect(nearestZoomStep(1.3)).toBe(3);
    expect(nearestZoomStep(0.5)).toBe(ZOOM_MIN_STEP);
    expect(nearestZoomStep(3)).toBe(ZOOM_MAX_STEP);
    for (const odd of [0, -1, Number.NaN]) expect(nearestZoomStep(odd)).toBe(0);
  });

  test('read only a level the native side could have sent', () => {
    expect(readZoomLevel({ step: 2, factor: 1.2 })).toEqual({ step: 2, factor: 1.2 });
    for (const odd of [null, 'zoom', { step: 1.5, factor: 1.1 }, { step: 1, factor: 0 }, { step: 1, factor: '1.1' }, { step: 1 }]) {
      expect(readZoomLevel(odd)).toBeNull();
    }
  });
});

describe('the page’s zoom', () => {
  const globals = globalThis as { window?: unknown; document?: unknown };
  const properties = new Map<string, string>();
  const frames: (() => void)[] = [];
  const resized: string[] = [];
  globals.window = {
    // For the mock's event callbacks.
    crypto: globalThis.crypto,
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    dispatchEvent: (event: Event) => resized.push(event.type),
  };
  globals.document = {
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name),
      },
    },
  };
  let saved: ZoomLevel = zoomLevelAt(2);
  // What the settings file says when it won't take a change, or null while it does.
  let refusal: string | null = null;
  const calls = mockCommands({
    get_zoom_level: () => saved,
    // As zoom.rs does: brought within the range, saved, and sent to the page.
    set_zoom_level: ({ step }) => {
      if (refusal) throw refusal;
      saved = zoomLevelAt(step);
      void emit(ZOOM_CHANGED_EVENT, saved);
      return saved;
    },
  }, { events: true });
  const sent = () => calls.filter(({ command }) => command === 'set_zoom_level').map(({ args }) => args.step);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const row = () => {
    const html = renderToStaticMarkup(<I18nProvider><TooltipProvider><AppearanceSettingsPage theme="light" onThemeChange={() => {}} /></TooltipProvider></I18nProvider>);
    const start = html.indexOf('data-setting-id="appearance.zoom"');
    if (start < 0) return '';
    // Up to the next row, or the next section when it's the last of its own, whose header has an info button.
    const ends = ['data-slot="settings-row"', 'data-slot="settings-section"'].map((slot) => html.indexOf(slot, start)).filter((at) => at >= 0);
    return html.slice(start, ends.length ? Math.min(...ends) : undefined);
  };
  /** Each button's label and whether it's held back, from the row's markup. */
  const buttons = () => [...row().matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attributes = '', content = '']) => ({
    label: attributes.match(/aria-label="([^"]+)"/)?.[1] ?? content.replace(/<[^>]+>/g, '').replace(/Already at .*$/, '').trim(),
    held: attributes.includes('aria-disabled="true"'),
  }));

  afterAll(async () => {
    await resetZoom();
    delete globals.window;
    delete globals.document;
  });

  test('draws its first frame at the saved level, with --zoom on the root for the Mac title row', async () => {
    await loadZoom();
    expect(properties.get('--zoom')).toBe(String(zoomFactor(2)));
    expect(row()).toContain('120%');
    // The sidebar's widest is measured again once the new zoom has laid out.
    lastItem(frames)();
    expect(resized).toContain('resize');
  });

  test('follows a change made from the View menu', async () => {
    await emit(ZOOM_CHANGED_EVENT, zoomLevelAt(ZOOM_MAX_STEP));
    await settle();
    expect(properties.get('--zoom')).toBe(String(zoomFactor(ZOOM_MAX_STEP)));
    expect(row()).toContain('144%');
    expect(buttons()).toEqual([
      { label: 'Zoom out', held: false },
      { label: 'Zoom in', held: true },
      { label: 'Actual size', held: false },
    ]);
    expect(row()).toContain('Already at the largest size');
  });

  test('steps through the native command, which keeps it within the range', async () => {
    await zoomIn();
    await zoomOut();
    await setZoomStep(-7);
    expect(sent()).toEqual([ZOOM_MAX_STEP, ZOOM_MAX_STEP - 1, ZOOM_MIN_STEP]);
    await settle();
    expect(row()).toContain('83%');
    expect(buttons().find((button) => button.label === 'Zoom out')?.held).toBe(true);
  });

  test('takes --zoom off the root at actual size, where Actual size is held back', async () => {
    await resetZoom();
    await settle();
    expect(properties.has('--zoom')).toBe(false);
    expect(row()).toContain('100%');
    expect(buttons()).toEqual([
      { label: 'Zoom out', held: false },
      { label: 'Zoom in', held: false },
      { label: 'Actual size', held: true },
    ]);
  });

  test('a change the settings file refuses says why, and only until the zoom moves on', async () => {
    refusal = 'Failed to write configuration directly config.toml: Permission denied (os error 13)';
    const failure = await tryZoomChange(zoomIn);
    expect(failure?.reason).toBe(refusal);
    // Nothing was saved, so the window stays where it was, and the failure with it.
    expect(row()).toContain('100%');
    expect(zoomFailureReason(failure, failure?.from ?? zoomLevelAt(0))).toBe(refusal);
    // A change from the View menu since then puts it behind.
    await emit(ZOOM_CHANGED_EVENT, zoomLevelAt(1));
    await settle();
    const now = (await tryZoomChange(zoomIn))?.from;
    expect(now).toEqual(zoomLevelAt(1));
    expect(zoomFailureReason(failure, now ?? zoomLevelAt(1))).toBeNull();
    refusal = null;
    // One that goes through has nothing to say.
    expect(await tryZoomChange(resetZoom)).toBeNull();
    await settle();
    expect(row()).toContain('100%');
  });
});

describe('the zoom keys', () => {
  test('belong to the View menu alone: no shortcut of the page’s takes ⌘=, ⌘−, ⌘0 or ⌘+, so a press steps once', () => {
    const press = (key: string, code: string, shiftKey = false) => ({ key, code, metaKey: true, ctrlKey: false, altKey: false, shiftKey });
    for (const event of [press('=', 'Equal'), press('-', 'Minus'), press('0', 'Digit0'), press('+', 'Equal', true)]) {
      expect(SHORTCUTS.filter((shortcut) => matchesKeys(event, shortcut.keys, true)).map((shortcut) => shortcut.id)).toEqual([]);
    }
  });

  test('are the menu’s: the mock stands in for them only in the browser, where there’s no menu', () => {
    const menu = read('../src-tauri/src/quit_guard.rs');
    for (const id of ['ACTUAL_SIZE', 'ZOOM_IN', 'ZOOM_OUT']) {
      expect(menu).toContain(`zoom::${id}_MENU_ID`);
      expect(menu).toContain(`zoom::${id}_ACCELERATOR`);
    }
    const mock = read('../src/dev/mockTauri.ts');
    expect(mock).toContain("event.key !== '=' && event.key !== '-' && event.key !== '0'");
  });
});

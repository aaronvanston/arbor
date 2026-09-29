import { useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invokeCommand } from '../native/commands';
import type { ZoomLevel } from '../native/types';

/**
 * The window's zoom. The native side owns it (src-tauri/src/zoom.rs): the View menu's Actual Size, Zoom In and Zoom
 * Out (⌘0, ⌘= and ⌘−) change it, it's saved with the app's settings and put on the web view before the window shows.
 * The page only hears the level, from `get_zoom_level` for its first paint and `zoom-changed` after, and sets `--zoom`
 * on the root from it, so the Mac title row, whose window buttons don't zoom, can stay the same size on screen
 * (styles.css). Settings › Appearance and the search palette change it through `set_zoom_level`. The page never
 * handles ⌘= / ⌘− / ⌘0 itself: the menu has them, and a second handler here would step twice.
 */

/** T3's steps: each is 1.2^(n/2), so 83%, 91%, 100%, 110%, 120%, 131% and 144%. The same as zoom.rs. */
export const ZOOM_MIN_STEP = -2;
export const ZOOM_MAX_STEP = 4;
export const ZOOM_CHANGED_EVENT = 'zoom-changed';
/** How long the first render waits for the level, beside the region's wait (src/main.tsx). */
export const ZOOM_WAIT_MS = 250;

export const clampZoomStep = (step: number) =>
  Number.isFinite(step) ? Math.min(ZOOM_MAX_STEP, Math.max(ZOOM_MIN_STEP, Math.round(step))) : 0;

export const zoomFactor = (step: number) => 1.2 ** (clampZoomStep(step) / 2);

export const zoomLevelAt = (step: number): ZoomLevel => {
  const clamped = clampZoomStep(step);
  return { step: clamped, factor: zoomFactor(clamped) };
};

/** The step closest to any factor, for a level previewed off the steps (the browser mock's `?zoom=1.25`). */
export const nearestZoomStep = (factor: number) =>
  Number.isFinite(factor) && factor > 0 ? clampZoomStep((2 * Math.log(factor)) / Math.log(1.2)) : 0;

/** The level as a whole percentage, for a label: 110% rather than 109.5%. */
export const zoomPercent = (factor: number) => Math.round(factor * 100);

export const canZoomIn = (level: ZoomLevel) => level.step < ZOOM_MAX_STEP;
export const canZoomOut = (level: ZoomLevel) => level.step > ZOOM_MIN_STEP;

/** A level the native side sent, or null for anything that isn't one. */
export function readZoomLevel(value: unknown): ZoomLevel | null {
  if (typeof value !== 'object' || value === null) return null;
  const { step, factor } = value as Record<string, unknown>;
  if (typeof step !== 'number' || !Number.isInteger(step) || typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) return null;
  return { step, factor };
}

let level: ZoomLevel = zoomLevelAt(0);
let heardChange = false;
let listening = false;
const listeners = new Set<() => void>();

function show(next: ZoomLevel) {
  if (next.step === level.step && next.factor === level.factor) return;
  level = next;
  if (typeof document !== 'undefined') {
    // styles.css has 1 on the root for when nothing is set.
    const root = document.documentElement.style;
    if (next.factor === 1) root.removeProperty('--zoom');
    else root.setProperty('--zoom', String(next.factor));
  }
  listeners.forEach((listener) => listener());
  // What's measured from the window, like the sidebar's widest, is in CSS pixels, and a zoom changes how many fit.
  // WebKit reports that as a resize; this makes sure every measure is taken again once the new zoom has laid out.
  if (typeof window !== 'undefined') window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function listenForChanges() {
  if (listening) return;
  listening = true;
  listen(ZOOM_CHANGED_EVENT, (event) => {
    const next = readZoomLevel(event.payload);
    if (!next) return;
    heardChange = true;
    show(next);
  }).catch(() => {
    // Outside the app shell there's nothing to hear.
  });
}

/**
 * Reads the saved level before the first render, and follows it from then on. The window stays hidden until that
 * render paints, so it opens already at the right size; a late answer still applies, unless a change came first.
 */
export async function loadZoom(waitMs = ZOOM_WAIT_MS): Promise<void> {
  listenForChanges();
  const loaded = invokeCommand('get_zoom_level')
    .then((reply) => {
      const next = readZoomLevel(reply);
      if (next && !heardChange) show(next);
    })
    .catch(() => {
      // Outside the app shell: actual size.
    });
  await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, waitMs))]);
}

/** Goes to a step, brought within the range, and saves it. Rejects with the native side's reason when it can't. */
export async function setZoomStep(step: number): Promise<ZoomLevel> {
  const reply = readZoomLevel(await invokeCommand('set_zoom_level', { step: clampZoomStep(step) }));
  if (reply) show(reply);
  return reply ?? level;
}

/** A zoom change that didn't go through: why, and the level it was made from. */
export type ZoomFailure = { from: ZoomLevel; reason: string };

/**
 * Makes a change and settles with why it failed, or null once it went through, so each place that offers one can say
 * so where it is: Settings › Appearance under its Zoom row, and the palette, which closes, in a toast.
 */
export async function tryZoomChange(change: () => Promise<unknown>): Promise<ZoomFailure | null> {
  const from = level;
  try {
    await change();
    return null;
  } catch (error) {
    return { from, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Why a change failed, while the zoom is still at the level it was made from. The store hands over a new level with
 * every change, so one made since, here or from the View menu, puts the failure behind it.
 */
export const zoomFailureReason = (failure: ZoomFailure | null, current: ZoomLevel) =>
  failure && failure.from === current ? failure.reason : null;

export const zoomIn = () => setZoomStep(level.step + 1);
export const zoomOut = () => setZoomStep(level.step - 1);
export const resetZoom = () => setZoomStep(0);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const useZoomLevel = () => useSyncExternalStore(subscribe, () => level, () => level);

import { describe, expect, it } from 'bun:test';
import { sceneClock, sceneResting, sceneWakeDelay, SCENE_REST_AFTER_MS, SCENE_WAKE_EARLY_MS } from '../src/services/sidebarScenes';

/**
 * A display beating every `period` ms from `phase`: a frame asked for at `at` comes on the first beat after it. Both
 * loops below are SidebarArt's, run against it for ten seconds; each draw is kept as when it happened and what it drew.
 */
type Display = { period: number; phase: number; drawMs: number; lateMs: number };
const SECONDS = 10_000;
/** The beat's time, and the first beat after `at` (counted in whole beats, so a beat is never its own next one). */
const beat = ({ period, phase }: Display, index: number) => phase + index * period;
const beatAfter = (display: Display, at: number) => {
  let index = Math.max(0, Math.floor((at - display.phase) / display.period) - 1);
  while (beat(display, index) <= at) index += 1;
  return index;
};

/** The loop as it was: a display frame every beat, the clock skipping those between the scene's frames. */
function everyFrame(display: Display, speed = 1) {
  const clock = sceneClock();
  const draws: [number, number][] = [];
  let callbacks = 0;
  for (let index = beatAfter(display, 0); beat(display, index) < SECONDS; index += 1) {
    const now = beat(display, index);
    callbacks += 1;
    const seconds = clock.tick(now, speed);
    if (seconds !== null) draws.push([now, seconds]);
  }
  return { draws, callbacks };
}

/** The loop now: after a draw, sleep on a timer (which may fire late) until shortly before the next frame is due. */
function sleepBetween(display: Display, speed = 1) {
  const clock = sceneClock();
  const draws: [number, number][] = [];
  let callbacks = 0;
  let index = beatAfter(display, 0);
  while (beat(display, index) < SECONDS) {
    const now = beat(display, index);
    callbacks += 1;
    const seconds = clock.tick(now, speed);
    if (seconds === null) {
      index += 1;
      continue;
    }
    draws.push([now, seconds]);
    const after = now + display.drawMs;
    const fired = after + sceneWakeDelay(clock.dueAt, after) + display.lateMs;
    index = Math.max(index + 1, beatAfter(display, fired));
  }
  return { draws, callbacks };
}

describe('the sidebar art’s frames', () => {
  const displays: Display[] = [];
  for (const period of [1000 / 60, 1000 / 120, 1000 / 90]) {
    for (const phase of [0, 3.3, period - 0.5]) {
      for (const lateMs of [0, 2, SCENE_WAKE_EARLY_MS - 4]) displays.push({ period, phase, drawMs: 3, lateMs });
    }
  }

  it('draws the same moments at the same times when it sleeps between them', () => {
    for (const display of displays) {
      for (const speed of [1, 0.5]) {
        expect(sleepBetween(display, speed).draws).toEqual(everyFrame(display, speed).draws);
      }
    }
  });

  it('wakes for about one display frame in four at 60 Hz, rather than every one', () => {
    const display = { period: 1000 / 60, phase: 0, drawMs: 3, lateMs: 1 };
    const before = everyFrame(display);
    const after = sleepBetween(display);
    expect(before.callbacks).toBeGreaterThan(590);
    expect(after.callbacks).toBe(after.draws.length);
    expect(after.callbacks * 3.5).toBeLessThan(before.callbacks);
  });

  it('waits on frames straight away while the clock is paused', () => {
    expect(sceneWakeDelay(null, 1_000)).toBe(0);
    expect(sceneWakeDelay(1_000, 1_000)).toBe(0);
    expect(sceneWakeDelay(1_062, 1_000)).toBe(62 - SCENE_WAKE_EARLY_MS);
  });
});

describe('resting', () => {
  it('moves for a minute after the last input, then rests until the next', () => {
    expect(sceneResting(1_000, 1_000)).toBe(false);
    expect(sceneResting(1_000, 1_000 + SCENE_REST_AFTER_MS - 1)).toBe(false);
    expect(sceneResting(1_000, 1_000 + SCENE_REST_AFTER_MS)).toBe(true);
  });
});

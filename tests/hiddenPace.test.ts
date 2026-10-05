import { describe, expect, it } from 'bun:test';
import { present } from './support/items';
import { HIDDEN_PACE_MS, isWindowHidden, pacedInterval, pacedMs, throttleWaitMs } from '../src/services/hiddenPace';

/** A page whose visibility a test moves, and the visibilitychange listeners it would call. */
function fakePage(state: DocumentVisibilityState = 'visible') {
  const listeners = new Set<() => void>();
  const page = {
    visibilityState: state,
    addEventListener: (_: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_: string, listener: () => void) => { listeners.delete(listener); },
  };
  const move = (next: DocumentVisibilityState) => {
    page.visibilityState = next;
    listeners.forEach((listener) => listener());
  };
  return { page: page as unknown as Document, move, listeners };
}

/** Intervals by id, with the gap each was started at. */
function fakeTimers() {
  const running = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  return {
    running,
    timers: {
      setInterval: (run: () => void, ms: number) => { next += 1; running.set(next, { run, ms }); return next; },
      clearInterval: (id: number) => { running.delete(id); },
    },
    gaps: () => [...running.values()].map((timer) => timer.ms),
  };
}

describe('the hidden pace', () => {
  it('slows a check faster than a minute to a minute while hidden, and leaves slower ones as they are', () => {
    expect(pacedMs(5_000, false)).toBe(5_000);
    expect(pacedMs(5_000, true)).toBe(HIDDEN_PACE_MS);
    expect(pacedMs(15_000, true)).toBe(60_000);
    expect(pacedMs(2 * 60_000, true)).toBe(2 * 60_000);
    expect(pacedMs(30 * 60_000, true)).toBe(30 * 60_000);
  });

  it('holds a throttled check back for its own gap while shown and a minute while hidden', () => {
    expect(throttleWaitMs(10_000, 12_000, 5_000, false)).toBe(3_000);
    expect(throttleWaitMs(10_000, 12_000, 5_000, true)).toBe(58_000);
    expect(throttleWaitMs(10_000, 80_000, 5_000, true)).toBe(0);
  });

  it('reads the page hidden only when it says so, and shown without a page', () => {
    expect(isWindowHidden({ visibilityState: 'hidden' })).toBe(true);
    expect(isWindowHidden({ visibilityState: 'visible' })).toBe(false);
    expect(isWindowHidden(null)).toBe(false);
  });

  it('starts its timer again at the new pace as the window hides and shows, and tells the caller first', () => {
    const { page, move, listeners } = fakePage();
    const { timers, gaps, running } = fakeTimers();
    const heard: boolean[] = [];
    let runs = 0;
    const stop = pacedInterval(() => { runs += 1; }, 15_000, { page, timers, onChange: (hidden) => heard.push(hidden) });
    expect(gaps()).toEqual([15_000]);
    move('hidden');
    expect(gaps()).toEqual([60_000]);
    // Hearing the same state again changes nothing.
    move('hidden');
    expect(heard).toEqual([true]);
    move('visible');
    expect(gaps()).toEqual([15_000]);
    expect(heard).toEqual([true, false]);
    running.forEach((timer) => timer.run());
    expect(runs).toBe(1);
    stop();
    expect(running.size).toBe(0);
    expect(listeners.size).toBe(0);
  });

  it('keeps the timer it has when the pace is the same either way', () => {
    const { page, move } = fakePage('hidden');
    const { timers, running } = fakeTimers();
    pacedInterval(() => undefined, 5 * 60_000, { page, timers });
    const [first] = running.keys();
    move('visible');
    expect([...running.keys()]).toEqual([present(first)]);
  });
});

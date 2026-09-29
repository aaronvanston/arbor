import { describe, expect, it } from 'bun:test';
import { TOAST_ACTION_DURATION_MS, TOAST_DURATION_MS, createToastTimers, toastDuration, type ToastClock } from '../src/services/toastTimers';

/** A clock that only moves when the test moves it, running whatever falls due on the way. */
function fakeClock() {
  let now = 0;
  let nextHandle = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const clock: ToastClock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      const handle = nextHandle++;
      pending.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, timer]) => timer.at <= target).sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      const [handle, timer] = due;
      pending.delete(handle);
      now = timer.at;
      timer.callback();
    }
    now = target;
  };
  return { clock, advance, pendingCount: () => pending.size };
}

function setup() {
  const { clock, advance, pendingCount } = fakeClock();
  const expired: string[] = [];
  const timers = createToastTimers((id) => expired.push(id), clock);
  return { timers, advance, expired, pendingCount };
}

describe('toast timing', () => {
  it('gives a toast with a button, such as Undo, longer than a plain one', () => {
    expect(toastDuration({})).toBe(TOAST_DURATION_MS);
    expect(toastDuration({ action: { label: 'Undo', onClick: () => undefined } })).toBe(TOAST_ACTION_DURATION_MS);
    expect(TOAST_ACTION_DURATION_MS).toBeGreaterThan(TOAST_DURATION_MS);
    expect(toastDuration({ durationMs: 0, action: {} })).toBe(0);
    expect(toastDuration({ durationMs: 9_000 })).toBe(9_000);
    // A failure stays until it's dismissed, with or without a button.
    expect(toastDuration({ kind: 'error' })).toBe(0);
    expect(toastDuration({ kind: 'error', action: {} })).toBe(0);
    expect(toastDuration({ kind: 'warning' })).toBe(TOAST_DURATION_MS);
  });

  it('closes a toast once its time is up, and keeps one with no time until it is dismissed', () => {
    const { timers, advance, expired } = setup();
    timers.start('saved', 4_000);
    timers.start('sticky', 0);
    advance(3_999);
    expect(expired).toEqual([]);
    expect(timers.remainingMs('saved')).toBe(1);
    advance(1);
    expect(expired).toEqual(['saved']);
    expect(timers.remainingMs('saved')).toBeNull();
    advance(60_000);
    expect(expired).toEqual(['saved']);
    expect(timers.remainingMs('sticky')).toBeNull();
  });

  it('holds every countdown while the window is hidden and picks up where it left off', () => {
    const { timers, advance, expired } = setup();
    timers.start('undo', 6_000);
    advance(2_000);
    timers.hold('hidden');
    advance(10 * 60_000);
    expect(expired).toEqual([]);
    expect(timers.remainingMs('undo')).toBe(4_000);
    timers.release('hidden');
    advance(3_999);
    expect(expired).toEqual([]);
    advance(1);
    expect(expired).toEqual(['undo']);
  });

  it('keeps holding until the pointer and focus have both left, and the window is visible', () => {
    const { timers, advance, expired } = setup();
    timers.start('copied', 4_000);
    timers.hold('hovered');
    timers.hold('focused');
    timers.hold('hidden');
    timers.release('hovered');
    timers.release('hidden');
    advance(30_000);
    expect(expired).toEqual([]);
    timers.release('focused');
    advance(4_000);
    expect(expired).toEqual(['copied']);
  });

  it('never adds time when held and let go many times', () => {
    const { timers, advance, expired } = setup();
    timers.start('saved', 4_000);
    for (let i = 0; i < 5; i += 1) {
      advance(500);
      timers.hold('hovered');
      advance(10_000);
      timers.release('hovered');
    }
    expect(timers.remainingMs('saved')).toBe(1_500);
    // Holding twice for the same reason, or letting go of one never held, changes nothing.
    timers.hold('hovered');
    timers.hold('hovered');
    timers.release('focused');
    advance(10_000);
    timers.release('hovered');
    advance(1_500);
    expect(expired).toEqual(['saved']);
  });

  it('waits to count down a toast that arrives while held', () => {
    const { timers, advance, expired, pendingCount } = setup();
    timers.hold('hidden');
    timers.start('saved', 4_000);
    expect(pendingCount()).toBe(0);
    advance(20_000);
    timers.release('hidden');
    advance(4_000);
    expect(expired).toEqual(['saved']);
  });

  it('starts over when a toast is shown again, and stops for one that was dismissed', () => {
    const { timers, advance, expired, pendingCount } = setup();
    timers.start('copied', 4_000);
    advance(3_000);
    timers.start('copied', 4_000);
    advance(3_000);
    expect(expired).toEqual([]);
    advance(1_000);
    expect(expired).toEqual(['copied']);
    timers.start('saved', 4_000);
    timers.stop('saved');
    expect(pendingCount()).toBe(0);
    advance(10_000);
    expect(expired).toEqual(['copied']);
  });
});

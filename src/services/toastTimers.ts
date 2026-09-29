/**
 * When toasts close by themselves. Kept apart from the Base UI renderer so it runs on a fake clock in tests,
 * and because Base UI's own timers keep running while the window is hidden, which would let an Undo lapse
 * while nobody could see it.
 */

/** A toast shows for this long unless it says otherwise. */
export const TOAST_DURATION_MS = 4_000;
/** A toast with a button, such as Undo, stays longer so there's time to reach it. */
export const TOAST_ACTION_DURATION_MS = 6_000;

/** How long a toast shows, 0 for until it's dismissed: an error stays, as a failure shouldn't go unread. */
export function toastDuration({ durationMs, action, kind }: { durationMs?: number; action?: unknown; kind?: string }) {
  return durationMs ?? (kind === 'error' ? 0 : action ? TOAST_ACTION_DURATION_MS : TOAST_DURATION_MS);
}

/** What stops every countdown: the window hidden, the pointer over the toasts, or focus inside them. */
export type ToastHold = 'hidden' | 'hovered' | 'focused';

export type ToastClock = {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const systemClock: ToastClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

type Countdown = { remainingMs: number; startedAtMs: number | null; handle: unknown };

export function createToastTimers(onExpire: (id: string) => void, clock: ToastClock = systemClock) {
  const countdowns = new Map<string, Countdown>();
  const holds = new Set<ToastHold>();

  const run = (id: string, countdown: Countdown) => {
    countdown.startedAtMs = clock.now();
    countdown.handle = clock.setTimeout(() => {
      countdowns.delete(id);
      onExpire(id);
    }, countdown.remainingMs);
  };
  // Keeps what's left, so holding and letting go many times never adds time.
  const halt = (countdown: Countdown) => {
    if (countdown.startedAtMs === null) return;
    clock.clearTimeout(countdown.handle);
    countdown.remainingMs = Math.max(0, countdown.remainingMs - (clock.now() - countdown.startedAtMs));
    countdown.startedAtMs = null;
    countdown.handle = undefined;
  };
  const stop = (id: string) => {
    const countdown = countdowns.get(id);
    if (!countdown) return;
    halt(countdown);
    countdowns.delete(id);
  };

  return {
    /** Starts a toast's countdown, or starts it again. A duration of 0 keeps the toast until it's dismissed. */
    start(id: string, durationMs: number) {
      stop(id);
      if (durationMs <= 0) return;
      const countdown: Countdown = { remainingMs: durationMs, startedAtMs: null, handle: undefined };
      countdowns.set(id, countdown);
      if (!holds.size) run(id, countdown);
    },
    stop,
    hold(reason: ToastHold) {
      if (holds.has(reason)) return;
      holds.add(reason);
      if (holds.size === 1) countdowns.forEach(halt);
    },
    release(reason: ToastHold) {
      if (!holds.delete(reason) || holds.size) return;
      countdowns.forEach((countdown, id) => run(id, countdown));
    },
    /** Time left on a toast, or null when it has no countdown. */
    remainingMs(id: string) {
      const countdown = countdowns.get(id);
      if (!countdown) return null;
      return countdown.startedAtMs === null
        ? countdown.remainingMs
        : Math.max(0, countdown.remainingMs - (clock.now() - countdown.startedAtMs));
    },
  };
}

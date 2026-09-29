/** Whether a limit is being spent faster than the clock runs down its window. */
export type PaceVerdict = 'ahead' | 'on-pace' | 'behind';
/** `evenPercent` is how much would be left by now had the window been spent evenly. */
export type EvenPace = { evenPercent: number; verdict: PaceVerdict };

/** Points either side of even pace that still count as on pace. */
export const PACE_MARGIN = 10;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_WINDOW_MS = 366 * DAY;
/** A reset a little past a whole window away is rounding; much further means the length is wrong. */
const MAX_OVERSHOOT = 1.5;

const clamp = (value: number) => Math.max(0, Math.min(100, value));

/**
 * Where an even spend would have left a limit by now, and how the account
 * compares. Null when anything it needs is missing, the window has already
 * reset (the reading is from a window that's over), or the length can't be right.
 */
export function evenPace(
  remainingPercent: number | null | undefined,
  resetAtMs: number | undefined,
  windowMs: number | undefined,
  nowMs = Date.now(),
): EvenPace | null {
  if (remainingPercent === null || remainingPercent === undefined || !Number.isFinite(remainingPercent)) return null;
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs) || !Number.isFinite(nowMs)) return null;
  if (windowMs === undefined || !Number.isFinite(windowMs) || windowMs < MINUTE || windowMs > MAX_WINDOW_MS) return null;
  const timeLeft = resetAtMs - nowMs;
  if (timeLeft <= 0 || timeLeft > windowMs * MAX_OVERSHOOT) return null;
  const evenPercent = clamp((100 * timeLeft) / windowMs);
  const gap = evenPercent - clamp(remainingPercent);
  return { evenPercent, verdict: gap > PACE_MARGIN ? 'ahead' : gap < -PACE_MARGIN ? 'behind' : 'on-pace' };
}

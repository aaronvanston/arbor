/** How long a crashed background monitor waits before it starts again the first time. */
export const MONITOR_RETRY_FIRST_MS = 30_000;
/** The longest wait, so a monitor that keeps crashing still tries every ten minutes. */
export const MONITOR_RETRY_MAX_MS = 10 * 60_000;

/** The wait after a monitor's nth crash in a row: 30 s, doubling each time, up to 10 minutes. */
export function monitorRetryDelay(crashesInARow: number) {
  if (!(crashesInARow > 1)) return MONITOR_RETRY_FIRST_MS;
  const doublings = Math.min(Math.floor(crashesInARow) - 1, 16);
  return Math.min(MONITOR_RETRY_FIRST_MS * 2 ** doublings, MONITOR_RETRY_MAX_MS);
}

/**
 * Counts a crash toward the run of crashes in a row. A monitor that stayed up for the longest wait since it last
 * started has recovered, so its next crash counts as the first and waits only 30 s.
 */
export function monitorCrashStreak(previous: number, ranForMs: number) {
  return ranForMs >= MONITOR_RETRY_MAX_MS ? 1 : Math.max(0, previous) + 1;
}

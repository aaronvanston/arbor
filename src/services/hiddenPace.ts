/**
 * How background checks pace themselves while the window is hidden (closed to the tray, minimized or covered), which
 * is most of the time. The owner's rule (docs/perf/BACKLOG.md): only a little slower, so alerts and the tray stay
 * within about a minute. A check that runs more often than once a minute slows to once a minute; a slower one keeps
 * its own pace, so nothing that feeds an alert waits longer than it did.
 */
export const HIDDEN_PACE_MS = 60_000;

type VisibilityDocument = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
type Timers = { setInterval: (run: () => void, ms: number) => number; clearInterval: (id: number) => void };

/**
 * Whether the window can't be seen: WKWebView says hidden when it's closed to the tray, minimized or covered. False
 * where there's no page at all, as in tests.
 */
export const isWindowHidden = (page: Pick<Document, 'visibilityState'> | null = typeof document === 'undefined' ? null : document) =>
  page?.visibilityState === 'hidden';

/** The gap a background check keeps: its own while the window shows, at least a minute while it's hidden. */
export const pacedMs = (ms: number, hidden: boolean) => (hidden ? Math.max(ms, HIDDEN_PACE_MS) : ms);

/** How long until a check held to one per `throttleMs`, last run at `lastRunMs`, may run again. */
export const throttleWaitMs = (lastRunMs: number, nowMs: number, throttleMs: number, hidden: boolean) =>
  Math.max(0, lastRunMs + pacedMs(throttleMs, hidden) - nowMs);

/**
 * Calls `run` every `ms` while the window shows and at the hidden pace while it doesn't, starting the timer again as
 * the window hides and shows. `onChange` hears each change first, with whether the window is hidden now. Returns a
 * cleanup.
 */
export function pacedInterval(
  run: () => void,
  ms: number,
  { page = document, timers = window, onChange }: { page?: VisibilityDocument; timers?: Timers; onChange?: (hidden: boolean) => void } = {},
): () => void {
  let hidden = isWindowHidden(page);
  let timer = timers.setInterval(run, pacedMs(ms, hidden));
  const update = () => {
    const next = isWindowHidden(page);
    if (next === hidden) return;
    const before = pacedMs(ms, hidden);
    hidden = next;
    onChange?.(hidden);
    if (pacedMs(ms, hidden) === before) return;
    timers.clearInterval(timer);
    timer = timers.setInterval(run, pacedMs(ms, hidden));
  };
  page.addEventListener('visibilitychange', update);
  return () => {
    page.removeEventListener('visibilitychange', update);
    timers.clearInterval(timer);
  };
}

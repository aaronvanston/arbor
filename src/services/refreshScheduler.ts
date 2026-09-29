/**
 * Runs one refresh at a time and keeps only the latest one waiting. A background refresh waits at least
 * `minIntervalMs` after the last run, and `spacing` times as long as that run took, so a range that takes seconds to
 * read leaves the database free most of the time instead of reading it again straight away.
 */
export function createRefreshScheduler(minIntervalMs = 1_000, spacing = 4) {
  type Task = () => Promise<void>;
  type Completion = { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };
  let running = false;
  let foregroundTasks = 0;
  let completedAt = -Infinity;
  let lastRunMs = 0;
  let pending: Task | null = null;
  let urgent = false;
  let completion: Completion | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pump = () => {
    if (running || foregroundTasks > 0 || !pending) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const delay = urgent ? 0 : Math.max(0, Math.max(minIntervalMs, lastRunMs * spacing) - (performance.now() - completedAt));
    if (delay > 0) {
      timer = setTimeout(pump, delay);
      return;
    }
    const task = pending;
    const currentCompletion = completion!;
    pending = null;
    completion = null;
    urgent = false;
    running = true;
    const startedAt = performance.now();
    void (async () => {
      try {
        await task();
        currentCompletion.resolve();
      } catch (error) {
        currentCompletion.reject(error);
      } finally {
        running = false;
        completedAt = performance.now();
        lastRunMs = completedAt - startedAt;
        pump();
      }
    })();
  };

  return {
    async runForeground(task: Task): Promise<void> {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
      urgent = false;
      completion?.resolve();
      completion = null;
      foregroundTasks += 1;
      const startedAt = performance.now();
      try {
        await task();
      } finally {
        foregroundTasks -= 1;
        completedAt = performance.now();
        lastRunMs = completedAt - startedAt;
        pump();
      }
    },
    schedule(task: Task, immediate = false): Promise<void> {
      pending = task;
      urgent ||= immediate;
      if (!completion) {
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<void>((onResolved, onRejected) => {
          resolve = onResolved;
          reject = onRejected;
        });
        completion = { promise, resolve, reject };
      }
      const result = completion.promise;
      pump();
      return result;
    },
    cancelPending() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
      urgent = false;
      completion?.resolve();
      completion = null;
    },
  };
}

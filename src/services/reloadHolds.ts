/**
 * What keeps the hidden window from reloading into a fresh page (services/backgroundReload.ts), and what it carries
 * across one. Work a reload would cut off holds it while it runs: an alert on its way out, a command line request
 * being answered, a cap being applied. A state kept only in memory holds it for as long as it lasts, or, when it's
 * small and only matters to a monitor's timing, is carried over to the new page.
 */
export type ReloadHold = 'alert' | 'cli' | 'caps' | 'update' | 'confirmation';

const running = new Map<ReloadHold, number>();
const conditions = new Set<{ hold: ReloadHold; held: () => boolean }>();

/** Holds the reload until the returned release is called; calling it again does nothing. */
export function holdReload(hold: ReloadHold): () => void {
  running.set(hold, (running.get(hold) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (running.get(hold) ?? 1) - 1;
    if (left > 0) running.set(hold, left);
    else running.delete(hold);
  };
}

/** Runs `work`, holding the reload until it's done. */
export async function holdingReload<T>(hold: ReloadHold, work: () => Promise<T>): Promise<T> {
  const release = holdReload(hold);
  try {
    return await work();
  } finally {
    release();
  }
}

/** Holds the reload whenever `held` says so. Returns how to stop asking. */
export function holdReloadWhile(hold: ReloadHold, held: () => boolean): () => void {
  const condition = { hold, held };
  conditions.add(condition);
  return () => {
    conditions.delete(condition);
  };
}

/** What holds the reload now, each once. */
export function reloadHolds(): ReloadHold[] {
  const holds = new Set(running.keys());
  for (const { hold, held } of conditions) if (held()) holds.add(hold);
  return [...holds];
}

const carriers = new Map<string, () => unknown>();
let carried: Record<string, unknown> = {};

/** Has `read`'s value carried over a reload under `key`, for `carriedOver` to give the new page. Returns how to stop. */
export function carryOverReload(key: string, read: () => unknown): () => void {
  carriers.set(key, read);
  return () => {
    if (carriers.get(key) === read) carriers.delete(key);
  };
}

/** Everything carried over, read as the page is about to reload. */
export const packCarry = (): Record<string, unknown> => Object.fromEntries([...carriers].map(([key, read]) => [key, read()]));

/** What the page before this one carried over; set once, as the page starts. */
export function receiveCarry(values: Record<string, unknown>) {
  carried = values;
}

/** A value the page before this one carried over, as it was stored: whoever reads it checks its shape. */
export const carriedOver = (key: string): unknown => carried[key];

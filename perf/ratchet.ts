/**
 * The ceilings in perf/baseline.json and how a run is held to them. Plain functions, so tests/perfRatchet.test.ts
 * can check them without a browser.
 */

/** Gated counts by key, like `default.idle.commandsPerMinute`. */
export type Counts = Record<string, number>;

/**
 * Room over a ceiling before a check fails: a fraction of it, or a fixed amount, whichever is more. Only for counts
 * that move a little between runs on their own (when a lazily loaded chunk arrives decides how React batches); most
 * have none.
 */
export type Tolerance = { relative?: number; absolute?: number };

export type Baseline = {
  /** By the counter's last key part, like `reactCommits`. */
  tolerance: Record<string, Tolerance>;
  ceilings: Counts;
};

export type CheckRow = {
  key: string;
  ceiling: number | null;
  value: number | null;
  /** over: past its ceiling and tolerance; new: no ceiling yet; missing: not measured this run. */
  status: 'ok' | 'over' | 'new' | 'missing';
};

const counterName = (key: string) => key.slice(key.lastIndexOf('.') + 1);

/** The most a count may reach before it fails: its ceiling plus any tolerance. */
export function allowed(baseline: Baseline, key: string): number | null {
  const ceiling = baseline.ceilings[key];
  if (ceiling === undefined) return null;
  const { relative = 0, absolute = 0 } = baseline.tolerance[counterName(key)] ?? {};
  return Math.max(relative ? Math.ceil(ceiling * (1 + relative)) : ceiling, ceiling + absolute);
}

/** Every counter this run measured or the baseline holds, with how it stands. */
export function check(baseline: Baseline, counts: Counts): CheckRow[] {
  const keys = [...new Set([...Object.keys(baseline.ceilings), ...Object.keys(counts)])].sort();
  return keys.map((key) => {
    const ceiling = baseline.ceilings[key] ?? null;
    const value = counts[key] ?? null;
    const limit = allowed(baseline, key);
    const status: CheckRow['status'] = value === null ? 'missing' : limit === null ? 'new' : value > limit ? 'over' : 'ok';
    return { key, ceiling, value, status };
  });
}

/**
 * Ceilings brought down to this run's counts. A count over its ceiling leaves it where it is (raising one is a
 * deliberate edit to perf/baseline.json, with a reason in the commit), a counter measured for the first time starts
 * at its count, and one not measured this run keeps its ceiling.
 */
export function ratchet(baseline: Baseline, counts: Counts): Baseline {
  const ceilings: Counts = { ...baseline.ceilings };
  for (const [key, value] of Object.entries(counts)) {
    const ceiling = ceilings[key];
    ceilings[key] = ceiling === undefined ? value : Math.min(ceiling, value);
  }
  const sorted = Object.fromEntries(Object.entries(ceilings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { tolerance: baseline.tolerance, ceilings: sorted };
}

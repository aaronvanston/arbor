import { savedStore, storedRecord } from './savedStore';

/** Rolling 24h of pooled headline percents per provider, sampled after every successful refresh. */
export type LimitSample = { t: number; percent: number };
export type LimitsHistory = Record<string, LimitSample[]>;

export const HISTORY_WINDOW_MS = 24 * 3_600_000;
const MIN_SAMPLE_GAP_MS = 60_000;
const UNCHANGED_GAP_MS = 15 * 60_000;

const isSample = (value: unknown): value is LimitSample =>
  !!value && typeof value === 'object' && typeof (value as LimitSample).t === 'number' && typeof (value as LimitSample).percent === 'number';

/** Each provider's samples, keeping only well-formed ones. */
function parseHistory(raw: string | null): LimitsHistory {
  const history: LimitsHistory = {};
  for (const [provider, samples] of Object.entries(storedRecord(raw))) {
    if (Array.isArray(samples)) history[provider] = samples.filter(isSample);
  }
  return history;
}

const store = savedStore<LimitsHistory>({ key: 'cpa-gui.limits-history.v1', parse: parseHistory, fallback: {} });

export const useLimitsHistory = store.useValue;

export function pruneSamples(samples: LimitSample[], nowMs: number): LimitSample[] {
  return samples.filter((sample) => nowMs - sample.t <= HISTORY_WINDOW_MS);
}

/** An hour is about 4px of a 24h sparkline; anything shorter reads as a stray dot at the right edge. */
export const SPARKLINE_MIN_SPAN_MS = 3_600_000;

/**
 * Sparkline points in a `width` × `height` box, oldest on the left and "now" on the right edge. Empty until the
 * window holds two real samples spanning at least an hour, so a lone reading never draws as a dot.
 */
export function sparklinePoints(samples: LimitSample[], nowMs: number, width: number, height: number): { x: number; y: number }[] {
  const recent = pruneSamples(samples, nowMs);
  if (recent.length < 2 || nowMs - recent[0]!.t < SPARKLINE_MIN_SPAN_MS) return [];
  const start = nowMs - HISTORY_WINDOW_MS;
  const points = recent.map((sample) => ({
    x: Math.max(0, Math.min(width, ((sample.t - start) / HISTORY_WINDOW_MS) * width)),
    y: height - 2 - (Math.max(0, Math.min(100, sample.percent)) / 100) * (height - 4),
  }));
  // Extend the last known value to "now" so the line reaches the right edge.
  const last = points[points.length - 1]!;
  if (last.x < width) points.push({ x: width, y: last.y });
  return points;
}

/**
 * Appends one sample. Rapid repeats replace the last sample, and an unchanged value is not
 * re-recorded for 15 minutes so the clock tick alone does not grow the history.
 */
export function appendSample(samples: LimitSample[], sample: LimitSample): LimitSample[] {
  const kept = pruneSamples(samples, sample.t);
  const last = kept[kept.length - 1];
  if (last && last.percent === sample.percent && sample.t - last.t < UNCHANGED_GAP_MS) return kept;
  if (last && sample.t - last.t < MIN_SAMPLE_GAP_MS) return [...kept.slice(0, -1), sample];
  return [...kept, sample];
}

export function recordLimitSample(provider: string, percent: number | null, nowMs = Date.now()) {
  if (percent === null || !Number.isFinite(percent)) return;
  const history = store.get();
  const previous = history[provider] ?? [];
  const next = appendSample(previous, { t: nowMs, percent: Math.round(percent * 10) / 10 });
  if (next === previous || (next.length === previous.length && next.every((sample, index) => sample === previous[index]))) return;
  store.set({ ...history, [provider]: next });
}

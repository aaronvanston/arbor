import { useSyncExternalStore } from 'react';
import { translate } from '../i18n';
import { formatDateTime, formatRelative } from '../lib/format';

export const quotaResetInstant = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const numeric = Number(value);
  const ms = Number.isFinite(numeric)
    ? numeric > 0 ? numeric < 1e12 ? numeric * 1000 : numeric : NaN
    : Date.parse(String(value));
  return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? ms : undefined;
};

export const quotaResetFor = (
  record: Record<string, unknown>,
  absoluteKeys: string[],
  relativeKeys: string[] = [],
  nowMs = Date.now(),
): number | undefined => {
  for (const key of absoluteKeys) {
    const ms = quotaResetInstant(record[key]);
    if (ms !== undefined) return ms;
  }
  for (const key of relativeKeys) {
    const raw = record[key];
    if (typeof raw !== 'number' && typeof raw !== 'string') continue;
    if (typeof raw === 'string' && !raw.trim()) continue;
    const seconds = Number(raw);
    const ms = nowMs + seconds * 1000;
    if (Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(new Date(ms).getTime())) return ms;
  }
  return undefined;
};

/** When a limit resets and how long that is from now: "29 Sep, 5:36 pm · in 2d". */
export const formatQuotaReset = (resetAtMs: number | undefined, fallback?: string, nowMs = Date.now()): string => {
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs)) return fallback || '';
  const absolute = formatDateTime(resetAtMs, { now: nowMs });
  if (resetAtMs <= nowMs) return `${absolute} · ${translate('quota.resetPassed')}`;
  return `${absolute} · ${formatRelative(resetAtMs, nowMs)}`;
};

// One clock shared by quota cards on both pages; no polling of upstream APIs.
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((notify) => notify());
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};
export const useQuotaClock = () => useSyncExternalStore(subscribe, () => now, () => now);

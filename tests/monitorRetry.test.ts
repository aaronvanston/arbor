import { describe, expect, it } from 'bun:test';
import { MONITOR_RETRY_FIRST_MS, MONITOR_RETRY_MAX_MS, monitorCrashStreak, monitorRetryDelay } from '../src/services/monitorRetry';

describe('monitor restart backoff', () => {
  it('waits 30 s, then doubles each crash in a row up to 10 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(monitorRetryDelay)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000,
    ]);
  });

  it('treats odd counts as a first crash or the cap', () => {
    expect(monitorRetryDelay(0)).toBe(MONITOR_RETRY_FIRST_MS);
    expect(monitorRetryDelay(-3)).toBe(MONITOR_RETRY_FIRST_MS);
    expect(monitorRetryDelay(Number.NaN)).toBe(MONITOR_RETRY_FIRST_MS);
    expect(monitorRetryDelay(2.9)).toBe(60_000);
    expect(monitorRetryDelay(Number.POSITIVE_INFINITY)).toBe(MONITOR_RETRY_MAX_MS);
  });

  it('starts the count over once a monitor stayed up for the longest wait', () => {
    expect(monitorCrashStreak(0, 5)).toBe(1);
    expect(monitorCrashStreak(3, 45_000)).toBe(4);
    expect(monitorCrashStreak(3, MONITOR_RETRY_MAX_MS - 1)).toBe(4);
    expect(monitorCrashStreak(6, MONITOR_RETRY_MAX_MS)).toBe(1);
    expect(monitorCrashStreak(-2, 0)).toBe(1);
  });
});

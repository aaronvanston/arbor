import { describe, expect, it } from 'bun:test';
import { formatLatency, latencyStats } from '../src/services/machineHealth';
import type { HealthPoint } from '../src/native/types';

const point = (t: number, latencyMs: number | null): HealthPoint => ({
  t, score: 100, cpu: 5, mem: 40, memUsedKb: 1, swap: null, swapUsedKb: null, disk: 30, diskFreeKb: 1,
  load1: 0, load5: 0, load15: 0, rxBps: null, txBps: null, latencyMs, cpuTemp: null, gpuTemp: null, gpuUtil: null, gpuMemUsedMb: null,
  claudeRunning: null, codexRunning: null,
});

describe('machine latency', () => {
  it('keeps a decimal only under 10 ms', () => {
    expect(formatLatency(0.42)).toBe('0.4 ms');
    expect(formatLatency(6.1)).toBe('6.1 ms');
    expect(formatLatency(32.344)).toBe('32 ms');
    expect(formatLatency(123.6)).toBe('124 ms');
  });

  it('summarizes the replies and skips pings that got none', () => {
    const stats = latencyStats([point(0, 5.7), point(5_000, null), point(10_000, 123.6), point(15_000, 6.1)]);
    expect(stats?.min).toBe(5.7);
    expect(stats?.max).toBe(123.6);
    expect(stats?.avg).toBeCloseTo(45.13, 2);
  });

  it('has no summary until something replies', () => {
    expect(latencyStats([])).toBeNull();
    expect(latencyStats([point(0, null), point(5_000, null)])).toBeNull();
  });
});

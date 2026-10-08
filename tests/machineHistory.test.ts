import { describe, expect, it } from 'bun:test';
import type { MachineHealthSnapshot, MachineHistory } from '../src/native/types';
import { HOUR_MS, MACHINE_WINDOWS, historyRefilled, historyRefreshMs, historySeries, machineWindowMs } from '../src/services/machineHealth';

const history = (fields: Partial<MachineHistory> = {}): MachineHistory => ({
  machine: 'cedar-01', since: 1_000_000, bucketMs: 432_000, samples: 3,
  cpu: [12, null, 40], mem: [], disk: [], swap: [], load1: [], cpuTemp: [], gpuTemp: [], rxBps: [], txBps: [], agents: [],
  ...fields,
});

describe('a machine’s long history', () => {
  it('offers the hour kept here and Grove’s longer windows, on the machine page alone', () => {
    expect(MACHINE_WINDOWS.map((option) => option.id)).toEqual(['5m', '15m', '1h', '6h', '24h', '7d', '30d']);
    expect(machineWindowMs('1h')).toBe(HOUR_MS);
    expect(machineWindowMs('7d')).toBe(7 * 24 * HOUR_MS);
  });

  it('charts each bucket at its middle and leaves a gap where nothing was stored', () => {
    expect(historySeries(history(), history().cpu)).toEqual([
      { t: 1_000_000 + 216_000, v: 12 },
      { t: 1_000_000 + 648_000, v: null },
      { t: 1_000_000 + 1_080_000, v: 40 },
    ]);
  });

  it('reads again as a bucket fills, never more than once a minute', () => {
    expect(historyRefreshMs(null)).toBe(60_000);
    expect(historyRefreshMs(history({ bucketMs: 108_000 }))).toBe(108_000);
    expect(historyRefreshMs(history({ bucketMs: 18_000 }))).toBe(60_000);
  });
});

describe('the hour filled from Grove', () => {
  const snapshot = (revs: Record<string, number>): MachineHealthSnapshot =>
    ({ seq: 1, now: 0, intervalMs: 5_000, sampledAt: null, historyMs: HOUR_MS, machines: Object.entries(revs).map(([machine, historyRev]) => ({ machine, historyRev })) }) as unknown as MachineHealthSnapshot;

  it('reads a series whole again when older readings went into it, and not otherwise', () => {
    expect(historyRefilled(null, snapshot({ 'cedar-01': 1 }))).toBe(false);
    expect(historyRefilled(snapshot({ 'cedar-01': 0 }), snapshot({ 'cedar-01': 0 }))).toBe(false);
    expect(historyRefilled(snapshot({ 'cedar-01': 0 }), snapshot({ 'cedar-01': 1 }))).toBe(true);
    expect(historyRefilled(snapshot({ 'cedar-01': 0 }), snapshot({ 'cedar-01': 0, 'cam-mbp': 3 })), 'a machine just listed comes whole anyway').toBe(false);
  });
});

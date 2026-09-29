import { describe, expect, it } from 'bun:test';
import { nearestSample } from '../src/pages/MachineHealthPanel';

const cpu = [{ t: 0, v: 10 }, { t: 5_000, v: 20 }, { t: 10_000, v: null }, { t: 15_000, v: 40 }];
const mem = [{ t: 0, v: 50 }, { t: 5_000, v: 55 }, { t: 10_000, v: 60 }, { t: 15_000, v: 65 }];

describe('machine chart hover', () => {
  it('snaps to the closest sample inside the tolerance', () => {
    expect(nearestSample([cpu], 6_000, 2_000)).toEqual({ t: 5_000, values: [20] });
    expect(nearestSample([cpu], 12_000, 2_000)).toBeNull();
  });

  it('skips gaps and reads every series at the snapped time', () => {
    expect(nearestSample([cpu, mem], 10_500, 5_000)).toEqual({ t: 15_000, values: [40, 65] });
  });

  it('returns null when the pointer is beyond the trace', () => {
    expect(nearestSample([cpu], 40_000, 2_000)).toBeNull();
    expect(nearestSample([], 0, 2_000)).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import { historyMachine } from '../src/pages/SetupHistory';
import type { SetupMachine } from '../src/native/types';

const machine = (name: string, local = false): SetupMachine => ({
  machine: name, local, reachable: true, homes: [], harnessHomes: [], harnessInstalls: [], installs: [], policy: null, scannedAt: null, error: null, scanning: false,
});

describe('the machine Arbor’s changes shows', () => {
  test('is the one the breadcrumb named, else this Mac, else the first, and never every machine', () => {
    const fleet = [machine('ci-01'), machine('casey-mbp', true), machine('cedar-02')];
    expect(historyMachine(fleet, 'cedar-02')).toBe('cedar-02');
    expect(historyMachine(fleet, undefined)).toBe('casey-mbp');
    // A machine Sync no longer checks falls back the same way.
    expect(historyMachine(fleet, 'old-box')).toBe('casey-mbp');
    expect(historyMachine([machine('ci-01')], undefined)).toBe('ci-01');
    expect(historyMachine([], undefined)).toBeNull();
  });
});

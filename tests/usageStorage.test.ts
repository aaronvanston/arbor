import { describe, expect, it } from 'bun:test';
import {
  compactionSpaceNeeded,
  describeRetentionChange,
  retentionOptions,
  usageDatabaseBytes,
} from '../src/services/usageStorage';
import type { UsageStorageInfo } from '../src/native/types';

const MB = 1_048_576;
const info: UsageStorageInfo = {
  retentionDays: 0,
  fileBytes: 212 * MB,
  walBytes: 4 * MB,
  freeBytes: 50 * MB,
  recordCount: 18_420,
  oldestTimestamp: '2026-02-23T08:00:00.000Z',
};

describe('usage storage helpers', () => {
  it('offers forever first, then the day presets', () => {
    expect(retentionOptions(0)).toEqual([0, 30, 90, 180, 365]);
    expect(retentionOptions(90)).toEqual([0, 30, 90, 180, 365]);
  });

  it('keeps a saved retention that is not a preset selectable', () => {
    expect(retentionOptions(7)).toEqual([0, 7, 30, 90, 180, 365]);
    expect(retentionOptions(3_650)).toEqual([0, 30, 90, 180, 365, 3_650]);
    expect(retentionOptions(-1)).toEqual([0, 30, 90, 180, 365]);
    expect(retentionOptions(Number.NaN)).toEqual([0, 30, 90, 180, 365]);
  });

  it('counts the write-ahead log in the database size', () => {
    expect(usageDatabaseBytes(info)).toBe(216 * MB);
  });

  it('asks for about twice the live data free before compacting', () => {
    expect(compactionSpaceNeeded(info)).toBe(2 * 162 * MB);
    expect(compactionSpaceNeeded({ ...info, freeBytes: info.fileBytes + MB })).toBe(0);
  });

  it('describes what saving a retention will do', () => {
    expect(describeRetentionChange(90, 12_345)).toEqual({ kind: 'delete', days: 90, count: 12_345 });
    expect(describeRetentionChange(365, 0)).toEqual({ kind: 'keep', days: 365 });
    expect(describeRetentionChange(0, 0)).toEqual({ kind: 'forever' });
  });
});

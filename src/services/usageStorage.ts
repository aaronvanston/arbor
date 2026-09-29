import type { UsageStorageInfo } from '../native/types';


/** Retention choices in days; 0 keeps history forever. */
export const RETENTION_PRESETS: readonly number[] = [0, 30, 90, 180, 365];

/** The presets, plus the saved value when it is not one of them, with "forever" first. */
export function retentionOptions(saved: number): number[] {
  const options = [...RETENTION_PRESETS];
  if (Number.isInteger(saved) && saved > 0 && !options.includes(saved)) options.push(saved);
  return options.sort((left, right) => (left === 0 ? -1 : right === 0 ? 1 : left - right));
}

/** The database's size on disk, write-ahead log included. */
export const usageDatabaseBytes = (info: UsageStorageInfo) => info.fileBytes + info.walBytes;

/**
 * Free disk space compaction needs. VACUUM copies the live data to a temporary
 * database and writes the rebuilt pages to the WAL, so about twice the live
 * data; the backend refuses to start with less.
 */
export const compactionSpaceNeeded = (info: UsageStorageInfo) => 2 * Math.max(0, info.fileBytes - info.freeBytes);

export type RetentionChange =
  | { kind: 'forever' }
  | { kind: 'keep'; days: number }
  | { kind: 'delete'; days: number; count: number };

/** What saving `days` will do, given the dry run's count of records it would delete. */
export function describeRetentionChange(days: number, recordsAffected: number): RetentionChange {
  if (days <= 0) return { kind: 'forever' };
  return recordsAffected > 0 ? { kind: 'delete', days, count: recordsAffected } : { kind: 'keep', days };
}

import { invokeCommand } from '../native/commands';
import type { LimitReading } from '../native/types';
import type { AccountKeyRename } from './accountKeys';
import type { AuthFileRecord } from './authFiles';
import { normalizeAuthIndex } from './managementApi';
import { providerForFile, quotaKey, type QuotaState } from './quotaService';

/** The readings a successful refresh gives for an account. Rows without a percentage say nothing about capacity. */
export function limitReadings(file: AuthFileRecord, quota: QuotaState | undefined): LimitReading[] {
  const provider = providerForFile(file);
  if (!provider || quota?.status !== 'success' || !quota.fetchedAt) return [];
  const sampledAtMs = quota.fetchedAt;
  const account = quotaKey(file);
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  return quota.rows.flatMap((row) => {
    const window = row.label.trim();
    if (!window || row.remainingPercent === null || !Number.isFinite(row.remainingPercent)) return [];
    return [{
      account,
      authIndex,
      provider,
      plan: quota.plan ?? '',
      window,
      remainingPercent: row.remainingPercent,
      resetAtMs: row.resetAtMs ?? null,
      extra: row.extra === true,
      sampledAtMs,
    }];
  });
}

/**
 * The readings from refreshes that haven't been recorded yet, and the refresh
 * time now recorded for each account. Every refresh is sent once; the backend
 * decides which readings add anything to the history.
 */
export function unrecordedLimitReadings(
  files: AuthFileRecord[],
  quotas: Record<string, QuotaState>,
  recorded: Record<string, number>,
): { readings: LimitReading[]; recorded: Record<string, number> } {
  const next = { ...recorded };
  const readings = files.flatMap((file) => {
    const key = quotaKey(file);
    const quota = quotas[key];
    if (quota?.status !== 'success' || !quota.fetchedAt || next[key] === quota.fetchedAt) return [];
    next[key] = quota.fetchedAt;
    return limitReadings(file, quota);
  });
  return { readings, recorded: next };
}

export async function recordLimitReadings(readings: LimitReading[]) {
  if (!readings.length) return;
  try {
    await invokeCommand('record_limit_samples', { samples: readings });
  } catch (error) {
    console.warn('Failed to record limit history', error);
  }
}

/** Moves an account's limit history to its new key after the core renamed its credential file. */
export async function renameLimitHistory(renames: AccountKeyRename[]) {
  if (!renames.length) return;
  try {
    await invokeCommand('rename_limit_history_accounts', { renames });
  } catch (error) {
    console.warn('Failed to move limit history to a renamed account', error);
  }
}

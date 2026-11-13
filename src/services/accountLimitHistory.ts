import { invokeCommand } from '../native/commands';
import type { LimitReading, ResetKind } from '../native/types';
import type { AccountKeyRename } from './accountKeys';
import type { AuthFileRecord } from './authFiles';
import { normalizeAuthIndex } from './managementApi';
import { providerForFile, quotaKey, type QuotaState } from './quotaService';
import { sharedStore } from './savedStore';

/** A reset Arbor used on an account. */
export type ResetUse = {
  reset: ResetKind;
  /** The windows it refills, by their rows' labels, or null for every main limit, as Codex's reset does. */
  windows: string[] | null;
};

/** How long a reset waits for a reading to say it was used: past this, a refill can't be put down to it. */
const RESET_USE_KEPT_MS = 3_600_000;
/** Resets used whose readings haven't been recorded yet, by account, with when each began. */
const resetUses = new Map<string, ResetUse & { atMs: number }>();
/** How many readings that say a reset was used have been recorded: the forecast reads its history again after each. */
const resetUsesRecorded = sharedStore(0);
export const useResetUsesRecorded = resetUsesRecorded.useValue;

/**
 * Notes a reset Arbor used, so the account's next readings say which it was. `atMs` is when using it began: a
 * reading from before that can't show it. Kept in memory until then, since the refresh after a reset can fail, and
 * so can recording it.
 */
export function noteResetUsed(key: string, use: ResetUse, atMs: number) {
  resetUses.set(key, { ...use, atMs });
}

/** The reset a reading at `fetchedAt` is the first to follow, taken so only that reading says so. */
function takeResetUse(key: string, fetchedAt: number): ResetUse | undefined {
  const use = resetUses.get(key);
  if (!use || fetchedAt < use.atMs) return undefined;
  resetUses.delete(key);
  return fetchedAt - use.atMs <= RESET_USE_KEPT_MS ? use : undefined;
}

/**
 * The readings a successful refresh gives for an account. Rows without a percentage say nothing about capacity.
 * `used` is the reset this refresh is the first to follow, named on the rows it refills.
 */
export function limitReadings(file: AuthFileRecord, quota: QuotaState | undefined, used?: ResetUse): LimitReading[] {
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
      ...(used && (used.windows === null ? row.extra !== true : used.windows.includes(window)) ? { resetUsed: used.reset } : {}),
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
    return limitReadings(file, quota, takeResetUse(key, quota.fetchedAt));
  });
  return { readings, recorded: next };
}

export async function recordLimitReadings(readings: LimitReading[]) {
  if (!readings.length) return;
  try {
    await invokeCommand('record_limit_samples', { samples: readings });
    if (readings.some((reading) => reading.resetUsed)) resetUsesRecorded.set(resetUsesRecorded.get() + 1);
  } catch (error) {
    console.warn('Failed to record limit history', error);
    // These readings are lost, but not which reset was used: the account's next ones say so instead.
    const lost = new Map<string, ResetUse & { atMs: number }>();
    readings.forEach((reading) => {
      if (!reading.resetUsed) return;
      const use = lost.get(reading.account) ?? { reset: reading.resetUsed, windows: [], atMs: reading.sampledAtMs };
      lost.set(reading.account, { ...use, windows: [...(use.windows ?? []), reading.window] });
    });
    lost.forEach(({ atMs, ...use }, key) => { if (!resetUses.has(key)) noteResetUsed(key, use, atMs); });
  }
}

/** Moves an account's limit history to its new key after the core renamed its credential file. */
export async function renameLimitHistory(renames: AccountKeyRename[]) {
  if (!renames.length) return;
  try {
    await invokeCommand('rename_limit_history_accounts', { renames: renames.map(({ from, to }) => ({ from, to })) });
  } catch (error) {
    console.warn('Failed to move limit history to a renamed account', error);
  }
}

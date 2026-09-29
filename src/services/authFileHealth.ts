import type { MessageKey } from '../i18n/resources';
import { isRecord, readString } from './managementApi';

/**
 * One unexpired retry restriction from the core's `/auth-files` listing
 * (`cooldowns[]`, core 7.3.0+). It says when the core will try the credential
 * or model again, not whether it will work then.
 */
export type AuthFileCooldown = {
  scope: 'credential' | 'model';
  model?: string;
  reason: string;
  retryAt: string;
  remainingSeconds: number;
  httpStatus?: number;
  backoffLevel?: number;
};

/**
 * Cooldowns as one listing reported them. `records` is null when the core could
 * not report them (home mode, disk fallback) or sent something malformed:
 * unknown, which is not the same as none.
 */
export type AuthFileCooldownSnapshot = {
  receivedAtMs: number;
  observedAt?: string;
  records: AuthFileCooldown[] | null;
};

const reasonKeys: Record<string, MessageKey> = {
  quota: 'authFiles.health.reason.quota',
  credential_quota: 'authFiles.health.reason.credentialQuota',
  cloudflare_challenge: 'authFiles.health.reason.cloudflare',
  invalid_grant: 'authFiles.health.reason.invalidGrant',
  unauthorized: 'authFiles.health.reason.unauthorized',
  payment_required: 'authFiles.health.reason.accessDenied',
  not_found: 'authFiles.health.reason.notFound',
  model_not_supported: 'authFiles.health.reason.modelUnsupported',
  transient_error: 'authFiles.health.reason.upstream',
  token_expired: 'authFiles.health.reason.tokenExpired',
};

const hasOwn = (record: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(record, key);

/** Whether the app has a label for a core reason code. */
export const isKnownCooldownReason = (reason: string) => hasOwn(reasonKeys, reason);

/** Label for a core reason code; unknown codes (and inherited keys such as `constructor`) get the generic label. */
export function cooldownReasonKey(reason: string): MessageKey {
  return (hasOwn(reasonKeys, reason) ? reasonKeys[reason] : undefined) ?? 'authFiles.health.reason.unknown';
}

export function cooldownTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : undefined;
}

function normalizeCooldown(value: unknown): AuthFileCooldown | null {
  if (!isRecord(value)) return null;
  const scope = value.scope;
  const model = typeof value.model_key === 'string' ? value.model_key.trim() : '';
  const retryAt = cooldownTimestamp(value.retry_at);
  const remainingSeconds = value.remaining_seconds;
  if ((scope !== 'credential' && scope !== 'model') || (scope === 'model' && !model)
    || !retryAt || typeof remainingSeconds !== 'number'
    || !Number.isSafeInteger(remainingSeconds) || remainingSeconds <= 0
    || remainingSeconds > Number.MAX_SAFE_INTEGER / 1000) return null;
  const httpStatus = value.http_status;
  const backoffLevel = value.backoff_level;
  return {
    scope,
    ...(scope === 'model' ? { model } : {}),
    retryAt,
    remainingSeconds,
    reason: readString(value, 'reason') || 'unknown',
    ...(typeof httpStatus === 'number' && Number.isInteger(httpStatus)
      && httpStatus >= 400 && httpStatus <= 599 ? { httpStatus } : {}),
    ...(typeof backoffLevel === 'number' && Number.isSafeInteger(backoffLevel)
      && backoffLevel >= 0 ? { backoffLevel } : {}),
  };
}

/**
 * Validates a listing entry's `cooldowns`. Undefined means the core predates the
 * field; one malformed record makes the whole list unknown rather than silently
 * dropping a restriction.
 */
export function normalizeAuthFileCooldowns(
  value: unknown,
  receivedAtMs: number,
  observedAt?: string,
): AuthFileCooldownSnapshot | undefined {
  if (value === undefined) return undefined;
  const snapshot = { receivedAtMs, observedAt: cooldownTimestamp(observedAt) };
  if (!Array.isArray(value)) return { ...snapshot, records: null };
  const records = value.map(normalizeCooldown);
  if (records.some((record) => record === null)) return { ...snapshot, records: null };
  return { ...snapshot, records: records as AuthFileCooldown[] };
}

/**
 * Time left on each restriction, counted from when the listing arrived rather
 * than from `retry_at`, so a clock difference between the app and the core
 * cannot shift a countdown. `remaining_seconds` is relative to the core's
 * `observed_at`, the moment it built the listing.
 */
export function summarizeAuthFileCooldowns(snapshot: AuthFileCooldownSnapshot | undefined, nowMs: number) {
  const elapsedSeconds = snapshot ? Math.max(0, nowMs - snapshot.receivedAtMs) / 1000 : 0;
  const rows = (snapshot?.records ?? []).map((record) => ({
    record,
    remainingSeconds: Math.max(0, Math.ceil(record.remainingSeconds - elapsedSeconds)),
  }));
  const active = rows.filter((row) => row.remainingSeconds > 0);
  return {
    rows,
    active,
    modelCount: new Set(active.filter(({ record }) => record.scope === 'model').map(({ record }) => record.model)).size,
    credentialWide: active.some(({ record }) => record.scope === 'credential'),
    earliestSeconds: active.length ? Math.min(...active.map((row) => row.remainingSeconds)) : 0,
    elapsed: rows.length > 0 && active.length === 0,
  };
}

const healthyMessages = new Set(['ok', 'healthy', 'ready', 'success', 'available', 'active']);
const messageReasons: Record<string, string> = {
  'quota exhausted': 'quota',
  'cloudflare challenge': 'cloudflare_challenge',
  'token expired': 'token_expired',
  'transient upstream error': 'transient_error',
};

/** The core's status message for a listing entry, minus placeholder text that only means "fine". */
export const authFileStatusMessage = (file: Record<string, unknown>) => {
  const message = readString(file, 'status_message', 'statusMessage');
  return healthyMessages.has(message.toLowerCase()) ? '' : message;
};

/**
 * Reason code behind one of the core's normalized status messages ("quota
 * exhausted", "token expired", "unauthorized", ...). Only exact markers count;
 * free text from an upstream error body is never read as a reason.
 */
export function statusMessageReason(message: string): string | undefined {
  const marker = message.trim().toLowerCase();
  const reason = (hasOwn(messageReasons, marker) ? messageReasons[marker] : undefined) ?? marker;
  return hasOwn(reasonKeys, reason) ? reason : undefined;
}

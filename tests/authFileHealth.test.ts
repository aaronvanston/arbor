import { describe, expect, it } from 'bun:test';
import { dedupeAuthFiles } from '../src/services/authFiles';
import {
  authFileStatusMessage,
  cooldownReasonKey,
  normalizeAuthFileCooldowns,
  statusMessageReason,
  summarizeAuthFileCooldowns,
} from '../src/services/authFileHealth';
import { itemAt } from './support/items';

// Ported from upstream fe83731 (tests/authFileHealth.test.ts). Upstream's
// `authFileHealth()` label and its component are not part of Arbor, so their
// cases are covered by authFileAvailability and AuthFileStatus instead.
const receivedAtMs = Date.now();
const record = {
  scope: 'model', model_key: 'model-a', reason: 'quota',
  retry_at: '2026-01-01T10:00:32Z', remaining_seconds: 32, http_status: 429, backoff_level: 0,
};
const normalize = (value: unknown) => normalizeAuthFileCooldowns(value, receivedAtMs, '2026-01-01T10:00:00Z');

describe('credential cooldowns from the core listing', () => {
  it('distinguishes old cores, unknown snapshots and known-empty restrictions', () => {
    expect(normalize(undefined)).toBeUndefined();
    expect(normalize(null)?.records).toBeNull();
    expect(normalize([])?.records).toEqual([]);
    const snapshot = normalize([record])!;
    expect(snapshot.records?.[0]).toMatchObject({
      model: 'model-a', reason: 'quota', httpStatus: 429, backoffLevel: 0,
      retryAt: '2026-01-01T10:00:32.000Z', remainingSeconds: 32,
    });
    expect(snapshot.observedAt).toBe('2026-01-01T10:00:00.000Z');
  });

  it('keeps malformed restrictions unknown instead of silently clearing them', () => {
    for (const value of [null, {}, 'bad', [null], [{ ...record, scope: 'future' }],
      [{ ...record, model_key: '' }], [{ ...record, model_key: {} }],
      [{ ...record, retry_at: 'bad-date' }], [{ ...record, remaining_seconds: 0 }],
      [{ ...record, remaining_seconds: -1 }], [{ ...record, remaining_seconds: 1.5 }],
      [{ ...record, remaining_seconds: Infinity }], [record, { scope: 'future' }]]) {
      expect(normalize(value)?.records).toBeNull();
    }
    const diagnostics = normalize([{ ...record, http_status: 200, backoff_level: -1 }])?.records?.[0];
    expect(diagnostics?.httpStatus).toBeUndefined();
    expect(diagnostics?.backoffLevel).toBeUndefined();
  });

  it('accepts the credential-wide view without a model key', () => {
    const snapshot = normalize([{ scope: 'credential', reason: 'credential_quota', retry_at: '2026-01-04T10:00:00Z', remaining_seconds: 259_200 }]);
    expect(snapshot?.records).toEqual([{
      scope: 'credential', reason: 'credential_quota', retryAt: '2026-01-04T10:00:00.000Z', remainingSeconds: 259_200,
    }]);
  });

  it('preserves authoritative empty/unknown snapshots when deduplicating files', () => {
    for (const cooldowns of [[], null]) {
      const file = itemAt(dedupeAuthFiles([
        { name: 'a.json', source: 'file', path: '/synthetic/a.json', cooldowns },
        { name: 'a.json', source: 'memory', cooldowns: [record] },
      ]), 0);
      expect(file.cooldowns).toEqual(cooldowns);
    }
  });

  it('uses server-relative time despite clock skew and keeps elapsed restrictions pending confirmation', () => {
    const snapshot = normalize([record])!;
    expect(summarizeAuthFileCooldowns(snapshot, receivedAtMs - 5000).earliestSeconds).toBe(32);
    expect(summarizeAuthFileCooldowns(snapshot, receivedAtMs + 1001).earliestSeconds).toBe(31);
    const elapsed = summarizeAuthFileCooldowns(snapshot, receivedAtMs + 33_000);
    expect(elapsed.earliestSeconds).toBe(0);
    expect(elapsed.elapsed).toBe(true);
    expect(elapsed.rows).toHaveLength(1);
    expect(elapsed.active).toHaveLength(0);
  });

  it('separates credential-wide cooldowns from model restrictions as timers expire', () => {
    const snapshot = normalize([
      record,
      { ...record, scope: 'credential', reason: 'credential_quota', remaining_seconds: 10 },
    ]);
    expect(summarizeAuthFileCooldowns(snapshot, receivedAtMs)).toMatchObject({
      modelCount: 1, credentialWide: true, earliestSeconds: 10,
    });
    expect(summarizeAuthFileCooldowns(snapshot, receivedAtMs + 11_000)).toMatchObject({
      modelCount: 1, credentialWide: false, earliestSeconds: 21,
    });
  });
});

describe('core reason codes and status markers', () => {
  it('labels known reason codes and falls back for anything else', () => {
    for (const reason of ['future', '__proto__', 'constructor']) {
      expect(cooldownReasonKey(reason)).toBe('authFiles.health.reason.unknown');
    }
    expect(cooldownReasonKey('payment_required')).toBe('authFiles.health.reason.accessDenied');
    expect(cooldownReasonKey('credential_quota')).toBe('authFiles.health.reason.credentialQuota');
  });

  it('reads only the core’s exact status markers as reasons', () => {
    expect(statusMessageReason('quota exhausted')).toBe('quota');
    expect(statusMessageReason('Token Expired')).toBe('token_expired');
    expect(statusMessageReason('transient upstream error')).toBe('transient_error');
    expect(statusMessageReason('cloudflare challenge')).toBe('cloudflare_challenge');
    for (const marker of ['invalid_grant', 'unauthorized', 'payment_required', 'not_found']) {
      expect(statusMessageReason(marker)).toBe(marker);
    }
    for (const text of ['HTTP 403: policy restriction', 'request failed', 'oauth token refresh failed: 401 invalid_grant', 'constructor', '']) {
      expect(statusMessageReason(text)).toBeUndefined();
    }
  });

  it('drops placeholder messages that only mean the credential is fine', () => {
    expect(authFileStatusMessage({ status_message: 'OK' })).toBe('');
    expect(authFileStatusMessage({ status_message: 'active' })).toBe('');
    expect(authFileStatusMessage({ statusMessage: 'quota exhausted' })).toBe('quota exhausted');
  });
});

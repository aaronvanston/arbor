import { describe, expect, it } from 'bun:test';
import {
  authFileAvailability,
  authFileAvailabilityChangesAt,
  authFileFingerprint,
  changedOAuthAuthFileNames,
  dedupeAuthFiles,
  isAuthFileForProvider,
  isAuthFileGoneFromDisk,
  isOAuthCredentialFile,
  normalizeAuthFilePriorityInput,
  oauthModelProvidersFromAuthFiles,
  parseAuthFilePriority,
  setOAuthCredentialFileDisabled,
  snapshotAuthFiles,
} from '../src/services/authFiles';
import { reauthProviderForFile } from '../src/services/authReauth';
import { providerForFile } from '../src/services/quotaService';
import { itemAt } from './support/items';

describe('认证文件列表规范化', () => {
  it('合并同名的磁盘和运行时记录并优先保留磁盘状态', () => {
    const files = dedupeAuthFiles([
      {
        name: 'codex-user.json',
        provider: 'codex',
        runtime_only: true,
        account_type: 'api_key',
        auth_index: 'runtime-index',
        email: 'user@example.com',
      },
      {
        name: 'codex-user.json',
        provider: 'codex',
        source: 'file',
        path: '/tmp/codex-user.json',
        disabled: false,
        modtime: 100,
      },
    ]);

    expect(files).toHaveLength(1);
    const file = itemAt(files, 0);
    expect(file.source).toBe('file');
    expect(file.path).toBe('/tmp/codex-user.json');
    expect(file.email).toBe('user@example.com');
    expect(file.auth_index).toBe('runtime-index');
    // Where a record came from is never borrowed from its runtime twin.
    expect(file.runtime_only).toBeUndefined();
    expect(file.account_type).toBeUndefined();
    expect(isOAuthCredentialFile(file)).toBe(true);
  });
});

describe('duplicate entries', () => {
  it('never lends one entry’s health to another with the same name', () => {
    // A duplicate's rejected token must not fill in the kept file's empty message
    // and turn a healthy credential into Sign-In Needed.
    const file = itemAt(dedupeAuthFiles([
      { name: 'gemini-multi.json', provider: 'gemini', source: 'file', path: '/auths/gemini-multi.json', status: 'active', status_message: '', unavailable: false },
      {
        name: 'gemini-multi.json', provider: 'gemini', source: 'memory', status: 'error', status_message: 'unauthorized', unavailable: true,
        next_retry_after: '2026-09-16T08:00:00Z', cooldowns: [{ scope: 'model', model_key: 'm', reason: 'unauthorized', retry_at: '2026-09-16T08:00:00Z', remaining_seconds: 60 }],
      },
    ]), 0);
    expect(file.status_message).toBe('');
    expect(file.unavailable).toBe(false);
    expect(file.next_retry_after).toBeUndefined();
    expect(file.cooldowns).toBeUndefined();
    expect(authFileAvailability(file)).toEqual({ kind: 'ready' });
  });
});

describe('authentication file priority', () => {
  it('accepts safe integers from API values', () => {
    expect(parseAuthFilePriority(10)).toBe(10);
    expect(parseAuthFilePriority(' -3 ')).toBe(-3);
    expect(parseAuthFilePriority(1.5)).toBeUndefined();
    expect(parseAuthFilePriority('high')).toBeUndefined();
  });

  it('uses zero to restore the default and rejects invalid input', () => {
    expect(normalizeAuthFilePriorityInput('')).toBe(0);
    expect(normalizeAuthFilePriorityInput('0')).toBe(0);
    expect(normalizeAuthFilePriorityInput('12')).toBe(12);
    expect(normalizeAuthFilePriorityInput('1.5')).toBeNull();
  });

  it('finds only credentials created or updated by the completed OAuth provider', () => {
    const before = snapshotAuthFiles([
      { name: 'codex-old.json', provider: 'codex', modtime: 1, priority: 8 },
      { name: 'codex-custom.json', provider: 'codex', modtime: 1, priority: 5 },
      { name: 'claude-old.json', provider: 'claude', modtime: 1 },
    ]);

    expect(changedOAuthAuthFileNames(before, [
      { name: 'codex-old.json', provider: 'codex', modtime: 2 },
      { name: 'codex-custom.json', provider: 'codex', modtime: 2, priority: 5 },
      { name: 'codex-new.json', type: 'codex', modtime: 2 },
      { name: 'claude-old.json', provider: 'claude', modtime: 2 },
    ], 'codex')).toEqual(['codex-old.json', 'codex-new.json']);
  });

  it('never picks a file the core just deleted, so priority 0 cannot write it back to disk', () => {
    const legacy = { name: 'claude-casey.json', provider: 'claude', source: 'file', path: '/auths/claude-casey.json', priority: 0 };
    const before = snapshotAuthFiles([legacy]);
    expect(changedOAuthAuthFileNames(before, [
      { ...legacy, source: 'memory' },
      { name: 'claude-5772b8d7-casey@example.com.json', provider: 'claude', source: 'file', path: '/auths/claude-5772b8d7-casey@example.com.json' },
    ], 'claude')).toEqual(['claude-5772b8d7-casey@example.com.json']);
  });

  it('ignores credentials that only served requests, and runtime entries', () => {
    // The core stamps `updated_at` after every request, and a runtime entry's
    // listed times are the core's own; neither is a sign-in writing a file.
    const onDisk = { name: 'codex-busy.json', provider: 'codex', source: 'file', path: '/auths/codex-busy.json', modtime: 1, updated_at: 1 };
    const runtime = { name: 'codex-key', provider: 'codex', runtime_only: true, source: 'memory', modtime: 1, updated_at: 1 };
    const before = snapshotAuthFiles([onDisk, runtime]);
    expect(changedOAuthAuthFileNames(before, [{ ...onDisk, updated_at: 2 }, { ...runtime, modtime: 2, updated_at: 2 }], 'codex')).toEqual([]);
    expect(changedOAuthAuthFileNames(before, [{ ...onDisk, modtime: 2 }, runtime], 'codex')).toEqual(['codex-busy.json']);
  });
});

describe('files that left the disk', () => {
  it('recognizes a file-backed credential the core still lists from memory', () => {
    expect(isAuthFileGoneFromDisk({ name: 'a.json', source: 'memory', path: '/auths/a.json' })).toBe(true);
    expect(isAuthFileGoneFromDisk({ name: 'a.json', source: 'file', path: '/auths/a.json' })).toBe(false);
    expect(isAuthFileGoneFromDisk({ name: 'runtime', source: 'memory' })).toBe(false);
    expect(isAuthFileGoneFromDisk({ name: 'runtime', source: 'memory', path: '/x', runtime_only: true })).toBe(false);
  });
});

const oauthFile = { name: 'codex-user.json', provider: 'codex', source: 'file', account_type: 'oauth' };
const nonOAuthFiles = [
  { ...oauthFile, runtime_only: true },
  { ...oauthFile, runtimeOnly: true },
  { ...oauthFile, account_type: 'api_key' },
  { ...oauthFile, account_type: 'API-KEY' },
  { ...oauthFile, auth_kind: 'apikey' },
  { ...oauthFile, authKind: 'api_key' },
  { ...oauthFile, source: 'memory' },
  { ...oauthFile, source: 'config:codex[key]' },
  { ...oauthFile, name: 'codex:apikey:runtime-id' },
  { ...oauthFile, name: '' },
];

// Ported from upstream 892b14c, minus its Cognition/Devin alias which Arbor does not have.
describe('OAuth credential file boundaries', () => {
  it('accepts disk-backed OAuth files, disabled files, and legacy disk listings', () => {
    expect(isOAuthCredentialFile(oauthFile)).toBe(true);
    expect(isOAuthCredentialFile({ ...oauthFile, disabled: true })).toBe(true);
    expect(isOAuthCredentialFile({ name: 'legacy.JSON', type: 'codex' })).toBe(true);
    expect(isOAuthCredentialFile({})).toBe(false);
  });

  it('rejects API-key and runtime records even when they use an OAuth provider or JSON name', () => {
    for (const file of nonOAuthFiles) expect(isOAuthCredentialFile(file)).toBe(false);
  });

  it('offers only providers with OAuth credential files, preserving aliases and plugin providers', () => {
    expect(oauthModelProvidersFromAuthFiles([
      ...nonOAuthFiles.map((file) => ({ ...file, provider: 'api-only' })),
      oauthFile,
      { ...oauthFile, name: 'second.json' },
      { name: 'claude.json', type: 'anthropic' },
      { name: 'antigravity.json', type: 'anti-gravity' },
      { name: 'openai.json', type: 'openai' },
      { name: 'plugin.json', provider: 'custom-oauth', source: 'file' },
      { name: 'unknown.json' },
    ])).toEqual(['antigravity', 'claude', 'codex', 'custom-oauth']);
    expect(oauthModelProvidersFromAuthFiles(nonOAuthFiles)).toEqual([]);
  });

  it('limits, re-sign-in and credential matching read every alias as the same provider', () => {
    const aliases = [
      ['anthropic', 'claude'], ['Claude', 'claude'],
      ['openai', 'codex'], ['codex', 'codex'],
      ['grok', 'xai'], ['x-ai', 'xai'], ['x_ai', 'xai'], ['XAI', 'xai'],
      ['anti-gravity', 'antigravity'], ['anti_gravity', 'antigravity'],
    ] as const;
    for (const [alias, provider] of aliases) {
      const file = { name: `${alias}.json`, type: alias };
      expect(providerForFile(file)).toBe(provider);
      expect(reauthProviderForFile(file)).toBe(provider === 'antigravity' ? null : provider);
      expect(isAuthFileForProvider(file, provider)).toBe(true);
      expect(oauthModelProvidersFromAuthFiles([file])).toEqual([provider]);
    }
    expect(reauthProviderForFile({ provider: 'gemini' })).toBeNull();
  });

  it('enables and disables only the selected OAuth file', async () => {
    const writes: unknown[] = [];
    const api = { patch: async (path: string, body: Record<string, unknown>) => { writes.push({ path, body }); } };
    await setOAuthCredentialFileDisabled(oauthFile, true, api);
    await setOAuthCredentialFileDisabled({ ...oauthFile, disabled: true }, false, api);
    expect(writes).toEqual([
      { path: '/auth-files/status', body: { name: 'codex-user.json', disabled: true } },
      { path: '/auth-files/status', body: { name: 'codex-user.json', disabled: false } },
    ]);
  });

  it('rejects runtime and API-key status changes before any management request', async () => {
    const writes: unknown[] = [];
    const api = { patch: async (path: string, body: Record<string, unknown>) => { writes.push({ path, body }); } };
    for (const file of nonOAuthFiles) {
      for (const disabled of [true, false]) {
        await expect(setOAuthCredentialFileDisabled(file, disabled, api)).rejects.toThrow('OAuth');
      }
    }
    expect(writes).toEqual([]);
  });
});

describe('authFileAvailability', () => {
  const listedAt = Date.parse('2026-09-16T07:20:00Z');
  /** A cooldown row shaped like the core's, `seconds` after the listing. */
  const rest = (scope: 'credential' | 'model', reason: string, seconds: number, extra: Record<string, unknown> = {}) => ({
    scope,
    ...(scope === 'model' ? { model_key: 'gpt-6-astra' } : {}),
    reason,
    retry_at: new Date(listedAt + seconds * 1000).toISOString(),
    remaining_seconds: seconds,
    ...extra,
  });
  const at = (seconds: number) => listedAt + seconds * 1000;

  it('lets disabled win over every other signal', () => {
    expect(authFileAvailability({
      disabled: true, unavailable: true, status_message: 'invalid_grant', cooldowns: [rest('credential', 'credential_quota', 60)],
    }, listedAt)).toEqual({ kind: 'disabled' });
  });

  describe('usage limits', () => {
    it('reads an account-wide limit from the credential-scope cooldown', () => {
      // The core always sends `remaining_seconds` on a model row, and a row
      // without it makes the list unknown.
      expect(authFileAvailability({
        unavailable: true,
        status: 'error',
        status_message: 'quota exhausted',
        cooldowns: [
          rest('credential', 'credential_quota', 264_827),
          rest('model', 'quota', 264_827, { http_status: 429, backoff_level: 1 }),
        ],
      }, listedAt)).toEqual({ kind: 'limit', retryAtMs: at(264_827) });
    });

    it('treats an unavailable credential whose models are all quota-limited as limited until the first one returns', () => {
      expect(authFileAvailability({
        unavailable: true,
        status_message: 'quota exhausted',
        cooldowns: [
          rest('model', 'quota', 7_200, { model_key: 'model-a' }),
          rest('model', 'quota', 3_600, { model_key: 'model-b' }),
        ],
      }, listedAt)).toEqual({ kind: 'limit', retryAtMs: at(3_600) });
    });

    it('counts HTTP 429 as a limit only when the reason code is unknown', () => {
      expect(authFileAvailability({ unavailable: true, cooldowns: [rest('model', 'unknown', 600, { http_status: 429 })] }, listedAt))
        .toEqual({ kind: 'limit', retryAtMs: at(600) });
    });

    it('falls back to the marker and next_retry_after on cores without cooldowns, across a clock difference', () => {
      // The core's clock runs an hour ahead; only the gap after observed_at counts.
      expect(authFileAvailability(
        { unavailable: true, status_message: 'quota exhausted', next_retry_after: '2026-09-16T09:20:00Z' },
        listedAt,
        '2026-09-16T08:20:00Z',
      )).toEqual({ kind: 'limit', retryAtMs: at(3_600) });
      expect(authFileAvailability({ unavailable: true, status_message: 'quota exhausted' }, listedAt))
        .toEqual({ kind: 'limit' });
      // Malformed cooldowns are unknown, not "none", so the fallback still applies.
      expect(authFileAvailability({ unavailable: true, status_message: 'quota exhausted', cooldowns: [{ scope: 'model' }] }, listedAt))
        .toEqual({ kind: 'limit' });
    });

    it('reports a limit whose rest already ended as waiting for the core to retry', () => {
      expect(authFileAvailability({ unavailable: true, status_message: 'quota exhausted', cooldowns: [] }, listedAt))
        .toEqual({ kind: 'retrying', message: 'quota exhausted', reason: 'quota' });
      expect(authFileAvailability({ unavailable: true, status_message: 'quota exhausted', next_retry_after: '2026-09-16T07:00:00Z' }, listedAt))
        .toEqual({ kind: 'retrying', message: 'quota exhausted', reason: 'quota' });
    });

    it('reads a credential-level limit from the marker when the core lists only model rests', () => {
      // The core lists a credential-wide rest only for account limits or for
      // credentials without per-model state; otherwise `next_retry_after` carries it.
      expect(authFileAvailability({
        unavailable: true, status_message: 'quota exhausted', next_retry_after: '2026-09-16T09:20:00Z',
        cooldowns: [rest('model', 'transient_error', 60, { http_status: 503 })],
      }, listedAt)).toEqual({ kind: 'limit', retryAtMs: at(7_200) });
    });

    it('lets an account-wide limit outrank the latest failure the core recorded', () => {
      expect(authFileAvailability({
        unavailable: true, status_message: 'transient upstream error',
        cooldowns: [rest('credential', 'credential_quota', 86_400), rest('model', 'transient_error', 60, { http_status: 502 })],
      }, listedAt)).toEqual({ kind: 'limit', retryAtMs: at(86_400) });
    });
  });

  describe('sign-in problems', () => {
    it('asks for a sign-in when the core reports a rejected token', () => {
      expect(authFileAvailability({ unavailable: true, status: 'error', status_message: 'invalid_grant', cooldowns: [] }, listedAt))
        .toEqual({ kind: 'signin', message: 'invalid_grant', reason: 'invalid_grant' });
      expect(authFileAvailability({ unavailable: true, cooldowns: [rest('credential', 'unauthorized', 1_800, { http_status: 401 })] }, listedAt))
        .toEqual({ kind: 'signin', message: '', reason: 'unauthorized' });
      expect(authFileAvailability({ unavailable: true, cooldowns: [rest('model', 'unknown', 1_800, { http_status: 401 })] }, listedAt))
        .toEqual({ kind: 'signin', message: '' });
    });

    it('treats a rejected token as credential-wide even while other models still route', () => {
      expect(authFileAvailability({ unavailable: false, status: 'error', status_message: 'unauthorized', cooldowns: [rest('model', 'unauthorized', 1_800)] }, listedAt))
        .toEqual({ kind: 'signin', message: 'unauthorized', reason: 'unauthorized' });
    });

    it('asks for a sign-in even while a usage limit is still listed', () => {
      // A refresh the provider rejected with 401 marks the credential unauthorized;
      // an older limit must not hide Sign In Again until it ends.
      expect(authFileAvailability({
        unavailable: true, status_message: 'unauthorized',
        cooldowns: [rest('model', 'quota', 7_200, { http_status: 429 })],
      }, listedAt)).toEqual({ kind: 'signin', message: 'unauthorized', reason: 'unauthorized' });
      expect(authFileAvailability({
        unavailable: true, status_message: 'invalid_grant', cooldowns: [rest('credential', 'credential_quota', 86_400)],
      }, listedAt)).toEqual({ kind: 'signin', message: 'invalid_grant', reason: 'invalid_grant' });
    });

    it('keeps the old free-text match only as a last resort for unavailable credentials', () => {
      expect(authFileAvailability({ unavailable: true, status_message: 'oauth token refresh failed: 401 invalid_grant' }, listedAt))
        .toEqual({ kind: 'signin', message: 'oauth token refresh failed: 401 invalid_grant' });
      expect(authFileAvailability({ unavailable: false, status_message: 'oauth token refresh failed: 401 invalid_grant' }, listedAt))
        .toEqual({ kind: 'ready' });
    });
  });

  describe('temporary failures', () => {
    it('shows a failed token refresh as retrying, not as a sign-in', () => {
      expect(authFileAvailability({ unavailable: true, status_message: 'token expired', cooldowns: [] }, listedAt))
        .toEqual({ kind: 'retrying', message: 'token expired', reason: 'token_expired' });
    });

    it('does not promise a failed token refresh works again when a model’s rest ends', () => {
      // The core retries the refresh on a schedule it does not list; a model
      // resting after an earlier error says nothing about it.
      const resting = [rest('model', 'transient_error', 120, { http_status: 502 })];
      expect(authFileAvailability({ unavailable: true, status_message: 'token expired', cooldowns: resting }, listedAt))
        .toEqual({ kind: 'retrying', message: 'token expired', reason: 'token_expired' });
      expect(authFileAvailability({
        unavailable: true, status_message: 'token expired', next_retry_after: new Date(at(300)).toISOString(), cooldowns: resting,
      }, listedAt)).toEqual({ kind: 'retrying', message: 'token expired', reason: 'token_expired', retryAtMs: at(300) });
    });

    it('says when the core tries again after upstream errors or a Cloudflare challenge', () => {
      expect(authFileAvailability({
        unavailable: true,
        status_message: 'transient upstream error',
        cooldowns: [rest('model', 'transient_error', 120, { model_key: 'a', http_status: 502 }), rest('model', 'transient_error', 60, { model_key: 'b', http_status: 503 })],
      }, listedAt)).toEqual({ kind: 'retrying', message: 'transient upstream error', reason: 'transient_error', retryAtMs: at(60) });
      expect(authFileAvailability({ unavailable: true, cooldowns: [rest('model', 'cloudflare_challenge', 300, { backoff_level: 2 })] }, listedAt))
        .toEqual({ kind: 'retrying', message: '', reason: 'cloudflare_challenge', retryAtMs: at(300) });
    });

    it('treats an unavailable credential with no reason as between attempts', () => {
      // The core only lists rests that are still running, so an unavailable
      // credential with none and no message is about to be retried.
      expect(authFileAvailability({ unavailable: true, status_message: '', cooldowns: [] }, listedAt))
        .toEqual({ kind: 'retrying', message: '' });
      expect(authFileAvailability({ unavailable: true, next_retry_after: '2026-09-16T07:25:00Z' }, listedAt))
        .toEqual({ kind: 'retrying', message: '', retryAtMs: at(300) });
    });
  });

  describe('access problems', () => {
    it('separates a refused plan or missing account from sign-in problems', () => {
      expect(authFileAvailability({ unavailable: true, status_message: 'payment_required' }, listedAt))
        .toEqual({ kind: 'access', message: 'payment_required', reason: 'payment_required' });
      expect(authFileAvailability({ unavailable: true, status_message: 'not_found', cooldowns: [] }, listedAt))
        .toEqual({ kind: 'access', message: 'not_found', reason: 'not_found' });
    });

    it('reads access problems from the cooldown before treating an empty message as a pause', () => {
      expect(authFileAvailability({ unavailable: true, status_message: '', cooldowns: [rest('model', 'payment_required', 1_800, { http_status: 402 })] }, listedAt))
        .toEqual({ kind: 'access', message: '', reason: 'payment_required' });
      expect(authFileAvailability({ unavailable: true, cooldowns: [rest('model', 'unknown', 1_800, { http_status: 403 })] }, listedAt))
        .toEqual({ kind: 'access', message: '' });
    });

    it('keeps the credential’s own refusal ahead of a temporary rest on one model', () => {
      expect(authFileAvailability({
        unavailable: true, status_message: 'payment_required', cooldowns: [rest('model', 'transient_error', 60, { http_status: 503 })],
      }, listedAt)).toEqual({ kind: 'access', message: 'payment_required', reason: 'payment_required' });
    });
  });

  it('keeps an unexplained failure as unavailable, with the core’s next attempt when known', () => {
    expect(authFileAvailability({
      unavailable: true, status_message: 'upstream returned an unexpected response', cooldowns: [rest('model', 'unknown', 600)],
    }, listedAt)).toEqual({ kind: 'unavailable', message: 'upstream returned an unexpected response', retryAtMs: at(600) });
    expect(authFileAvailability({ unavailable: true, status_message: 'request failed', cooldowns: [rest('model', 'model_not_supported', 600, { http_status: 400 })] }, listedAt))
      .toEqual({ kind: 'unavailable', message: 'request failed', retryAtMs: at(600) });
  });

  describe('ready credentials', () => {
    it('is ready without annotations when nothing rests', () => {
      expect(authFileAvailability({ status: 'active' }, listedAt)).toEqual({ kind: 'ready' });
      expect(authFileAvailability({ status: 'active', cooldowns: [] }, listedAt)).toEqual({ kind: 'ready' });
      expect(authFileAvailability({ status: 'active', cooldowns: null }, listedAt)).toEqual({ kind: 'ready' });
    });

    it('lists resting models on a credential the core still routes, whatever its raw status says', () => {
      // A routed credential is still ready, but its model rests are reported,
      // and a rejected token is not.
      expect(authFileAvailability({
        status: 'error',
        status_message: 'quota exhausted',
        unavailable: false,
        cooldowns: [
          rest('model', 'quota', 10_800, { model_key: 'claude-opus-5', http_status: 429, backoff_level: 0 }),
          rest('model', 'transient_error', 300, { model_key: 'claude-fable-5-1', http_status: 503 }),
        ],
      }, listedAt)).toEqual({
        kind: 'ready',
        models: {
          count: 2,
          retryAtMs: at(300),
          cooldowns: [
            { model: 'claude-fable-5-1', reason: 'transient_error', httpStatus: 503, retryAtMs: at(300) },
            { model: 'claude-opus-5', reason: 'quota', httpStatus: 429, retryAtMs: at(10_800) },
          ],
        },
      });
    });
  });
});

describe('authFileAvailabilityChangesAt', () => {
  const listedAt = Date.parse('2026-09-16T07:20:00Z');
  const row = (seconds: number) => ({
    scope: 'model', model_key: `m-${seconds}`, reason: 'quota',
    retry_at: new Date(listedAt + seconds * 1000).toISOString(), remaining_seconds: seconds,
  });

  it('finds the first rest that ends across the listing', () => {
    expect(authFileAvailabilityChangesAt([
      { name: 'a.json', cooldowns: [row(600), row(120)] },
      { name: 'b.json', unavailable: true, cooldowns: [row(300)] },
      { name: 'c.json', disabled: true, cooldowns: [row(30)] },
    ], listedAt)).toBe(listedAt + 120_000);
  });

  it('also watches next_retry_after from cores without cooldowns, on this machine’s clock', () => {
    expect(authFileAvailabilityChangesAt(
      [{ name: 'a.json', unavailable: true, next_retry_after: '2026-09-16T08:25:00Z' }],
      listedAt,
      '2026-09-16T08:20:00Z',
    )).toBe(listedAt + 300_000);
  });

  it('has nothing to wait for when no rest is running', () => {
    expect(authFileAvailabilityChangesAt([
      { name: 'a.json', status: 'active' },
      { name: 'b.json', unavailable: true, next_retry_after: '2026-09-16T07:00:00Z', cooldowns: [] },
    ], listedAt)).toBeUndefined();
  });
});

describe('authFileFingerprint', () => {
  const file = { name: 'CC-P3.json', type: 'claude', email: 'a@example.com', modtime: 100, priority: 0 };

  it('ignores runtime state the core attaches to a listing', () => {
    expect(authFileFingerprint({
      ...file,
      status: 'error',
      status_message: 'rate limit',
      unavailable: true,
      cooldowns: [{ reason: 'quota', retry_at: '2026-09-19T08:51:05Z' }],
      quota: { observed_at: '2026-09-17T07:50:00Z', signals: { 'Retry-After': '370964' } },
    })).toBe(authFileFingerprint(file));
  });

  it('changes when the credential on disk is rewritten', () => {
    expect(authFileFingerprint({ ...file, last_refresh: 'now', modtime: 200 })).not.toBe(authFileFingerprint(file));
  });

  it('ignores the time the core stamps after every request', () => {
    expect(authFileFingerprint({ ...file, updated_at: '2026-09-17T07:51:00Z' }))
      .toBe(authFileFingerprint({ ...file, updated_at: '2026-09-17T07:50:00Z' }));
  });
});

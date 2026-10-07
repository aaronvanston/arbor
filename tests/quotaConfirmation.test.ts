import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import type { JsonValue } from '../src/native/types';
import { canResetCodexQuota, resetCodexQuotaWithConfirmation } from '../src/services/quotaActions';
import { settleCodexRedeem } from '../src/services/codexResetRedeem';
import { getQuotaCacheSnapshot, pruneQuotaCache, updateQuotaCache } from '../src/services/quotaCache';
import { quotaKey, type QuotaState } from '../src/services/quotaService';
import { present } from './support/items';

const file = { name: 'confirm-test.json', provider: 'codex', auth_index: 'confirm-test' };
const key = quotaKey(file);
const previous: QuotaState = {
  status: 'success', rows: [{ label: '5h', remainingPercent: 0 }], resetCredits: 2, resetCreditsApplicable: 1,
};
let originalWindow: PropertyDescriptor | undefined;
let originalCache: ReturnType<typeof getQuotaCacheSnapshot>;
let upstreamCalls: { url: string; method: string }[];
let consumeError: boolean;
let refreshError: boolean;

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  originalCache = getQuotaCacheSnapshot();
  updateQuotaCache({ [key]: previous });
  upstreamCalls = [];
  // An unconfirmed reset left by an earlier test would be resent instead of started afresh.
  settleCodexRedeem(file.name);
  consumeError = false;
  refreshError = false;
  mockCommands({
    management_request: ({ request }): JsonValue => {
      // A used reset clears the core's rest for the account.
      if (request.path === '/reset-quota') return { status: 'ok' };
      expect(request.path).toBe('/api-call');
      const upstream = request.body as { url: string; method: string };
      upstreamCalls.push(upstream);
      if (upstream.url.endsWith('/consume')) {
        return consumeError ? { status_code: 409, body: 'reset denied' } : { status_code: 200, body: { code: 'reset' } };
      }
      if (upstream.url.endsWith('/usage') && refreshError) return { status_code: 503, body: 'usage unavailable' };
      return {
        status_code: 200,
        body: upstream.url.endsWith('/usage')
          ? { rate_limit: { primary_window: { used_percent: 0 } } }
          : { available_count: 1 },
      };
    },
  });
});

afterEach(() => {
  clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  updateQuotaCache(originalCache);
});

describe('quota action confirmation with fully mocked IPC', () => {
  it('preserves displayed quota and sends nothing until explicit confirmation', async () => {
    let decide!: (confirmed: boolean) => void;
    const resetting = resetCodexQuotaWithConfirmation(file, () => new Promise((resolve) => { decide = resolve; }));
    expect(getQuotaCacheSnapshot()[key]).toBe(previous);
    expect(upstreamCalls).toHaveLength(0);
    decide(true);
    expect(await resetting).toBe('success');
    expect(upstreamCalls.filter((request) => request.url.endsWith('/consume'))).toHaveLength(1);
    expect(upstreamCalls.find((request) => request.url.endsWith('/consume'))?.method).toBe('POST');
    expect(getQuotaCacheSnapshot()[key]).toMatchObject({ status: 'success', resetCredits: 1, actionResult: { action: 'reset', status: 'success' } });
  });

  it.each([false, null, undefined, 'unexpected', 'true'])('never consumes on cancellation or an invalid answer: %s', async (answer) => {
    expect(await resetCodexQuotaWithConfirmation(file, async () => answer as boolean)).toBe('canceled');
    expect(upstreamCalls).toHaveLength(0);
    expect(getQuotaCacheSnapshot()[key]).toBe(previous);
  });

  it('releases the reservation if opening the confirmation fails', async () => {
    await expect(resetCodexQuotaWithConfirmation(file, async () => { throw new Error('confirmation unavailable'); }))
      .rejects.toThrow('confirmation unavailable');
    expect(getQuotaCacheSnapshot()[key]).toBe(previous);
    expect(upstreamCalls).toHaveLength(0);
    await resetCodexQuotaWithConfirmation(file, async () => true);
    expect(upstreamCalls.filter((request) => request.url.endsWith('/consume'))).toHaveLength(1);
  });

  it('reserves the account while awaiting a decision and prevents duplicate confirmations', async () => {
    let decide!: (confirmed: boolean) => void;
    let confirmations = 0;
    const ask = () => { confirmations++; return new Promise<boolean>((resolve) => { decide = resolve; }); };
    const first = resetCodexQuotaWithConfirmation(file, ask);
    expect(await resetCodexQuotaWithConfirmation(file, ask)).toBe('canceled');
    expect(confirmations).toBe(1);
    expect(upstreamCalls).toHaveLength(0);
    decide(true);
    await first;
    expect(upstreamCalls.filter((request) => request.url.endsWith('/consume'))).toHaveLength(1);
  });

  it('ignores approval after the credential is removed', async () => {
    let decide!: (confirmed: boolean) => void;
    const resetting = resetCodexQuotaWithConfirmation(file, () => new Promise((resolve) => { decide = resolve; }));
    pruneQuotaCache(new Set());
    decide(true);
    expect(await resetting).toBe('canceled');
    expect(upstreamCalls).toHaveLength(0);
    expect(getQuotaCacheSnapshot()[key]).toBeUndefined();
  });

  it('does not act on a stale quota snapshot or overwrite newer data', async () => {
    let decide!: (confirmed: boolean) => void;
    const resetting = resetCodexQuotaWithConfirmation(file, () => new Promise((resolve) => { decide = resolve; }));
    const newer: QuotaState = { status: 'success', rows: [], resetCredits: 3 };
    updateQuotaCache({ [key]: newer });
    decide(true);
    await resetting;
    expect(getQuotaCacheSnapshot()[key]).toBe(newer);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('does not offer or execute a reset when no credits currently apply', async () => {
    updateQuotaCache({ [key]: { ...previous, resetCreditsApplicable: 0 } });
    let asked = false;
    await resetCodexQuotaWithConfirmation(file, async () => { asked = true; return true; });
    expect(asked).toBe(false);
    expect(upstreamCalls).toHaveLength(0);
    expect(canResetCodexQuota(file, present(getQuotaCacheSnapshot()[key], 'the cached quota'))).toBe(false);
    expect(canResetCodexQuota({ ...file, disabled: true }, previous)).toBe(false);
  });

  it('reports an unconfirmed reset on the account, requiring refresh before retry', async () => {
    consumeError = true;
    expect(await resetCodexQuotaWithConfirmation(file, async () => true)).toBe('error');
    expect(getQuotaCacheSnapshot()[key]).toMatchObject({
      actionResult: { action: 'reset', status: 'error', message: expect.stringContaining('The provider answered: reset denied.') },
    });
    expect(canResetCodexQuota(file, present(getQuotaCacheSnapshot()[key], 'the cached quota'))).toBe(false);
    expect(await resetCodexQuotaWithConfirmation(file, async () => true)).toBe('canceled');
    expect(upstreamCalls.filter((request) => request.url.endsWith('/consume'))).toHaveLength(1);
  });

  it('distinguishes an accepted reset from a failed refresh and prevents a second consume', async () => {
    refreshError = true;
    expect(await resetCodexQuotaWithConfirmation(file, async () => true)).toBe('refresh-error');
    expect(getQuotaCacheSnapshot()[key]).toMatchObject({
      rows: previous.rows, actionResult: { action: 'reset', status: 'refresh-error', error: 'The server had a problem on its end. It said “usage unavailable”. Try again in a moment.' },
    });
    await resetCodexQuotaWithConfirmation(file, async () => true);
    expect(upstreamCalls.filter((request) => request.url.endsWith('/consume'))).toHaveLength(1);
  });

  it('keeps application confirmations out of native and browser dialog APIs', async () => {
    for (const name of ['pages/AccountsPage', 'components/AuthFileCommands', 'pages/ThinkingAliasesPage', 'pages/UsageRecordsPage', 'pages/UsageStorageSection']) {
      const source = await Bun.file(new URL('../src/' + name + '.tsx', import.meta.url)).text();
      expect(source).not.toContain('window.confirm');
      expect(source).not.toContain('@tauri-apps/plugin-dialog');
    }
  });
});

import { describe, expect, it, spyOn } from 'bun:test';
import { refreshAccountQuotas } from '../src/services/accountsStore';
import { managementApi } from '../src/services/managementApi';
import {
  captureQuotaCacheGeneration,
  commitQuotaCacheIfCurrent,
  getQuotaCacheSnapshot,
  mergeQuotaResult,
  pruneQuotaCache,
  renameQuotaCacheKeys,
  STALE_ROWS_MAX_AGE_MS,
  updateQuotaCache,
} from '../src/services/quotaCache';
import { quotaKey, type QuotaState } from '../src/services/quotaService';

describe('额度跨页面缓存', () => {
  it('保留仍存在的认证文件额度并清理失效项', () => {
    updateQuotaCache({
      first: { status: 'success', rows: [], fetchedAt: 1 },
      removed: { status: 'error', rows: [], error: 'old' },
    });
    pruneQuotaCache(new Set(['first']));

    expect(getQuotaCacheSnapshot()).toEqual({
      first: { status: 'success', rows: [], fetchedAt: 1 },
    });
  });

  it('认证文件集合变化后拒绝过期请求写回', () => {
    updateQuotaCache({
      stale: { status: 'loading', rows: [] },
      retained: { status: 'loading', rows: [] },
    });
    const generation = captureQuotaCacheGeneration();
    pruneQuotaCache(new Set(['retained']));
    let committed = false;

    expect(commitQuotaCacheIfCurrent(generation, () => {
      committed = true;
    })).toBe(false);
    expect(committed).toBe(false);
    expect(getQuotaCacheSnapshot().retained).toEqual({ status: 'idle', rows: [] });
  });

  it('releases every in-flight fetch when a rename retires the generation', () => {
    // The rename discards all running fetches, not just the renamed one's; an
    // entry left loading would spin forever and block Refresh All.
    updateQuotaCache({
      old: { status: 'success', rows: [], fetchedAt: 1 },
      busy: { status: 'loading', rows: [] },
    });
    const generation = captureQuotaCacheGeneration();
    renameQuotaCacheKeys([{ from: 'old', to: 'new' }]);

    expect(commitQuotaCacheIfCurrent(generation, () => {})).toBe(false);
    expect(getQuotaCacheSnapshot()).toEqual({
      new: { status: 'success', rows: [], fetchedAt: 1 },
      busy: { status: 'idle', rows: [] },
    });
  });
});

describe('limits kept after a failed check', () => {
  // Resets long after any clock these tests use, the real one included.
  const rows = [{ label: 'Weekly limit', remainingPercent: 60, resetAtMs: Date.UTC(2100, 0, 1) }];
  const good: QuotaState = { status: 'success', rows, plan: 'pro', fetchedAt: 1_000, serverTimeOffsetMs: 40, resetCredits: 2 };
  const failed: QuotaState = { status: 'error', rows: [], error: 'Couldn’t reach chatgpt.com.' };

  it('keeps the last good rows, marked stale from the first failure, with the error', () => {
    const stale = mergeQuotaResult({ ...good, status: 'loading' }, failed, 5_000);
    expect(stale).toEqual({
      status: 'error', rows, error: 'Couldn’t reach chatgpt.com.', plan: 'pro', fetchedAt: 1_000, serverTimeOffsetMs: 40, staleSinceMs: 5_000,
    });
    // Another failure keeps when it went stale and when the rows were read.
    expect(mergeQuotaResult({ ...stale, status: 'loading' }, { ...failed, error: 'timeout' }, 9_000))
      .toMatchObject({ rows, error: 'timeout', fetchedAt: 1_000, staleSinceMs: 5_000 });
  });

  it('drops the stale mark once a check succeeds', () => {
    const stale = mergeQuotaResult(good, failed, 5_000);
    const next: QuotaState = { status: 'success', rows: [{ ...rows[0]!, remainingPercent: 40 }], fetchedAt: 8_000 };
    expect(mergeQuotaResult({ ...stale, status: 'loading' }, next, 8_000)).toBe(next);
  });

  it('lets go of a kept limit once it has reset, and of the rows once none are left', () => {
    const weekly = { label: 'Weekly limit', remainingPercent: 60, resetAtMs: 9_000 };
    const fiveHour = { label: '5-hour limit', remainingPercent: 10, resetAtMs: 20_000 };
    const both: QuotaState = { ...good, rows: [weekly, fiveHour] };
    // The weekly limit reset at 9 000; the 5-hour one hasn't yet.
    expect(mergeQuotaResult({ ...both, status: 'loading' }, failed, 12_000)).toMatchObject({ rows: [fiveHour], staleSinceMs: 12_000 });
    // Reset times are on the provider's clock, 40 ms ahead of this one.
    expect(mergeQuotaResult(both, failed, 8_970).rows).toEqual([fiveHour]);
    expect(mergeQuotaResult(both, failed, 8_950).rows).toEqual([weekly, fiveHour]);
    expect(mergeQuotaResult({ ...good, rows: [weekly] }, failed, 10_000)).toBe(failed);
  });

  it('lets a limit with no reset time go with the last one that has one, and every limit a day after it was read', () => {
    const weekly = { label: '7-day window', remainingPercent: 60, resetAtMs: 9_000 };
    // Claude's extra usage never has a reset time, nor does a 5-hour window idle when it was read.
    const extra = { label: 'Extra usage', remainingPercent: 80 };
    const idle = { label: '5-hour window', remainingPercent: 100 };
    const claude: QuotaState = { ...good, rows: [idle, weekly, extra] };
    expect(mergeQuotaResult(claude, failed, 8_000).rows).toEqual([idle, weekly, extra]);
    // Once the weekly limit has reset, nothing kept is known to be current, so the account isn't stale for ever.
    expect(mergeQuotaResult(claude, failed, 9_000)).toBe(failed);
    // With no reset time anywhere they stay until a day after they were read, however often checks fail.
    const credits: QuotaState = { ...good, rows: [extra] };
    let kept = mergeQuotaResult(credits, failed, 5_000);
    kept = mergeQuotaResult({ ...kept, status: 'loading' }, failed, 1_000 + STALE_ROWS_MAX_AGE_MS - 1);
    expect(kept).toMatchObject({ rows: [extra], staleSinceMs: 5_000 });
    expect(mergeQuotaResult({ ...kept, status: 'loading' }, failed, 1_000 + STALE_ROWS_MAX_AGE_MS)).toBe(failed);
    // So do limits that haven't reset yet.
    const later = { ...weekly, resetAtMs: 1e13 };
    expect(mergeQuotaResult({ ...good, rows: [later, extra] }, failed, 1_000 + STALE_ROWS_MAX_AGE_MS)).toBe(failed);
    expect(mergeQuotaResult({ ...good, rows: [later, extra] }, failed, STALE_ROWS_MAX_AGE_MS).rows).toEqual([later, extra]);
  });

  it('stays empty when there were never rows to keep', () => {
    expect(mergeQuotaResult(undefined, failed)).toBe(failed);
    expect(mergeQuotaResult({ status: 'loading', rows: [] }, failed)).toBe(failed);
    expect(mergeQuotaResult({ status: 'success', rows: [], fetchedAt: 1 }, failed)).toBe(failed);
  });

  it('keeps rows while a refresh runs and after it fails, and drops them with the credential', async () => {
    const file = { name: 'codex-work.json', provider: 'codex', auth_index: 'c1' };
    const readAtMs = Date.now() - 60_000;
    updateQuotaCache({ [quotaKey(file)]: { ...good, fetchedAt: readAtMs } });
    let answer = () => {};
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    const post = spyOn(managementApi, 'post').mockImplementation(async () => {
      await answered;
      return { status_code: 502, body: '{"error":"bad gateway"}' } as never;
    });
    try {
      const refresh = refreshAccountQuotas([file]);
      expect(getQuotaCacheSnapshot()[quotaKey(file)]).toMatchObject({ status: 'loading', rows });
      answer();
      await refresh;
    } finally {
      post.mockRestore();
    }
    const stale = getQuotaCacheSnapshot()[quotaKey(file)]!;
    expect(stale).toMatchObject({ status: 'error', rows, fetchedAt: readAtMs });
    expect(stale.error).toBeTruthy();
    expect(stale.staleSinceMs).toBeNumber();
    // Another credential (a different file or auth index) never inherits them.
    pruneQuotaCache(new Set(['codex-work.json::c2']));
    expect(getQuotaCacheSnapshot()).toEqual({});
  });
});

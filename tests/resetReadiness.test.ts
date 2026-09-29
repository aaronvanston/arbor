import { describe, expect, it } from 'bun:test';
import { claudeBankedResetFor, quotaRowsFor, type AuthFile, type QuotaState } from '../src/services/quotaService';
import { nextResetNotifications, resetReadyFor } from '../src/services/resetReadiness';

const NOW = Date.parse('2030-01-10T00:00:00Z');
const claudeFile: AuthFile = { name: 'claude-max.json', provider: 'claude', auth_index: 'claude-1' };
const codexFile: AuthFile = { name: 'codex-team.json', provider: 'codex', auth_index: 'codex-1' };

const grant = (overrides: Record<string, unknown> = {}) => ({
  id: 'launch_week', label: 'Launch week', resets_total: 3, resets_left: 2,
  starts_at: '2030-01-01T00:00:00Z', ends_at: '2030-01-20T00:00:00Z',
  clears: ['five_hour', 'seven_day'], paused: false, usable_now: true, use_requires_limit: true,
  percent_used: { five_hour: 100, seven_day: 40 }, blocking: [], ...overrides,
});
const claudeQuota = (block: Record<string, unknown> = {}, grantOverrides: Record<string, unknown> = {}): QuotaState => ({
  status: 'success',
  rows: [{ label: '5-hour window', remainingPercent: 0 }],
  ...claudeBankedResetFor({
    cedar_ember: {
      eligible: true, next_grant_id: 'launch_week', exhausted: ['five_hour'],
      weekly_resets_at: '2030-01-14T00:00:00Z', cooldown_until: null, grants: [grant(grantOverrides)], ...block,
    },
  }, NOW),
});
const codexQuota = (usage: Record<string, unknown>, credits: { resetCredits?: number; resetCreditsApplicable?: number } = {}): QuotaState => ({
  status: 'success',
  rows: quotaRowsFor('codex', usage),
  resetCredits: 2,
  resetCreditsApplicable: 1,
  ...credits,
});
const codexUsage = (primaryUsed: number, reviewUsed = 10) => ({
  rate_limit: {
    primary_window: { used_percent: primaryUsed, limit_window_seconds: 18_000, reset_after_seconds: 600 },
    secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_after_seconds: 86_400 },
  },
  code_review_rate_limit: {
    primary_window: { used_percent: reviewUsed, limit_window_seconds: 604_800, reset_after_seconds: 86_400 },
  },
});

describe('when a reset is worth a notification', () => {
  it('counts a Claude account at a limit with a banked reset it can use now', () => {
    expect(resetReadyFor(claudeFile, claudeQuota())).toEqual({ provider: 'claude', limit: '5-hour window and 7-day window' });
  });

  it('skips a Claude reset that would be spent before the account reaches a limit', () => {
    const early = claudeQuota({ exhausted: [] }, { use_requires_limit: false, percent_used: { five_hour: 60, seven_day: 40 } });
    expect(early.bankedReset?.earlyUse).toEqual({ percentLeft: 40, limit: '5-hour window' });
    expect(resetReadyFor(claudeFile, early)).toBeNull();
  });

  it('skips Claude resets that are waiting, blocked, on a disabled account or after an unconfirmed claim', () => {
    expect(resetReadyFor(claudeFile, claudeQuota({ exhausted: [] }, { usable_now: false }))).toBeNull();
    expect(resetReadyFor(claudeFile, claudeQuota({}, { usable_now: false, blocking: ['seven_day'] }))).toBeNull();
    expect(resetReadyFor({ ...claudeFile, disabled: true }, claudeQuota())).toBeNull();
    expect(resetReadyFor(claudeFile, { ...claudeQuota(), actionResult: { action: 'reset', status: 'error' } })).toBeNull();
  });

  it('counts a Codex account out of a main limit with a manual reset that applies', () => {
    expect(resetReadyFor(codexFile, codexQuota(codexUsage(100)))).toEqual({ provider: 'codex', limit: '5-hour limit' });
  });

  it('ignores Codex limits a manual reset does not refill', () => {
    const quota = codexQuota(codexUsage(50, 100));
    expect(quota.rows.map((row) => [row.label, row.extra ?? false])).toEqual([
      ['5-hour limit', false],
      ['Weekly limit', false],
      ['Code review Weekly limit', true],
    ]);
    expect(resetReadyFor(codexFile, quota)).toBeNull();
  });

  it('skips a Codex account with headroom, no resets left or none that apply', () => {
    expect(resetReadyFor(codexFile, codexQuota(codexUsage(80)))).toBeNull();
    expect(resetReadyFor(codexFile, codexQuota(codexUsage(100), { resetCredits: 0 }))).toBeNull();
    expect(resetReadyFor(codexFile, codexQuota(codexUsage(100), { resetCreditsApplicable: 0 }))).toBeNull();
  });
});

describe('notifying once per stretch at a limit', () => {
  const claude = (quota: QuotaState | undefined) => ({ key: 'claude', file: claudeFile, quota });
  const codex = (quota: QuotaState | undefined) => ({ key: 'codex', file: codexFile, quota });
  const idle = claudeQuota({ exhausted: [] }, { usable_now: false });

  it('notifies when an account becomes ready and stays quiet while it remains ready', () => {
    const first = nextResetNotifications({}, [claude(claudeQuota()), codex(codexQuota(codexUsage(40)))], true);
    expect(first.ready.map((item) => [item.key, item.provider, item.limit])).toEqual([['claude', 'claude', '5-hour window and 7-day window']]);
    expect(first.notified).toEqual({ claude: true });
    expect(first.changed).toBe(true);

    const again = nextResetNotifications(first.notified, [claude(claudeQuota()), codex(codexQuota(codexUsage(40)))], true);
    expect(again.ready).toEqual([]);
    expect(again.changed).toBe(false);
  });

  it('notifies again after the account has been back under its limits', () => {
    const cleared = nextResetNotifications({ claude: true }, [claude(idle)], true);
    expect(cleared).toMatchObject({ notified: {}, ready: [], changed: true });
    expect(nextResetNotifications(cleared.notified, [claude(claudeQuota())], true).ready).toHaveLength(1);
  });

  it('holds its place while limits are loading, failed or a claim is unconfirmed', () => {
    for (const quota of [
      undefined,
      { ...claudeQuota(), status: 'loading' as const },
      { status: 'error' as const, rows: [], error: 'offline' },
      // Limits held over from the last good check.
      { status: 'error' as const, rows: claudeQuota().rows, error: 'offline', staleSinceMs: NOW },
      { ...claudeQuota(), actionResult: { action: 'reset' as const, status: 'refresh-error' as const } },
    ]) {
      expect(nextResetNotifications({ claude: true }, [claude(quota)], true)).toMatchObject({ notified: { claude: true }, ready: [], changed: false });
      expect(nextResetNotifications({}, [claude(quota)], true)).toMatchObject({ notified: {}, ready: [], changed: false });
    }
  });

  it('forgets accounts that are gone only once the list can be trusted', () => {
    expect(nextResetNotifications({ gone: true }, [claude(idle)], false)).toMatchObject({ notified: { gone: true }, changed: false });
    expect(nextResetNotifications({ gone: true }, [claude(idle)], true)).toMatchObject({ notified: {}, changed: true });
  });
});

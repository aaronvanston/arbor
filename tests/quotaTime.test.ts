import { describe, expect, it } from 'bun:test';
import { getFormatRegion, setFormatRegion } from '../src/lib/format';
import { formatQuotaReset, quotaResetFor, quotaResetInstant, resetCreditsExpiry } from '../src/services/quotaTime';
import { formatQuotaTimestamp } from '../src/services/quotaService';

const resetMs = Date.parse('2030-01-01T00:00:00Z');

describe('quota reset instants', () => {
  it('兼容秒、毫秒、数字字符串与高精度 ISO 时间', () => {
    for (const input of [resetMs, resetMs / 1000, String(resetMs), String(resetMs / 1000), '2030-01-01T00:00:00.000000000Z']) {
      expect(quotaResetInstant(input)).toBe(resetMs);
    }
    for (const input of [null, undefined, '', ' ', 0, -1, false, [], {}, NaN, Infinity, 'invalid']) {
      expect(quotaResetInstant(input)).toBeUndefined();
    }
    expect(formatQuotaTimestamp(String(resetMs / 1000))).not.toBe('—');
  });

  it('跳过坏绝对时间后使用有效别名或相对秒数，仅在获取时计算倒计时', () => {
    expect(quotaResetFor({ reset_at: 'bad', resetAt: resetMs }, ['reset_at', 'resetAt'])).toBe(resetMs);
    expect(quotaResetFor({ ttl: '3600' }, ['reset_at'], ['ttl'], resetMs)).toBe(resetMs + 3600000);
    expect(quotaResetFor({ ttl: 0 }, [], ['ttl'], resetMs)).toBe(resetMs);
    expect(quotaResetFor({ ttl: false }, [], ['ttl'], resetMs)).toBeUndefined();
  });

  it('同一个重置时间显示随时钟更新，过期后提示刷新而不是伪造已恢复额度', () => {
    expect(formatQuotaReset(resetMs, undefined, resetMs - 60000)).toContain('in 1m');
    expect(formatQuotaReset(resetMs, undefined, resetMs)).toContain('Reset time reached; refresh to verify');
    expect(formatQuotaReset(undefined, 'legacy', resetMs)).toBe('legacy');
  });

  // Time left reads in short units now ("in 1d"), as it does everywhere else.
  it('counts whole days, hours and minutes left without rounding up', () => {
    const at = (msLeft: number) => formatQuotaReset(resetMs, undefined, resetMs - msLeft).split(' · ')[1];
    expect(at(36 * 3_600_000)).toBe('in 1d');
    expect(at(24 * 3_600_000)).toBe('in 1d');
    expect(at(24 * 3_600_000 - 1)).toBe('in 23h');
    expect(at(3_600_000)).toBe('in 1h');
    expect(at(3_600_000 - 1)).toBe('in 59m');
    expect(at(1_000)).toBe('in 1m');
  });

  it('says when a limit resets the way the Mac\'s region writes it', () => {
    const region = getFormatRegion();
    const reset = new Date(2030, 8, 29, 17, 36).getTime();
    setFormatRegion({ locale: 'en-AU', hourCycle: 'h12' });
    expect(formatQuotaReset(reset, undefined, reset - 2 * 3_600_000).replace(/\s+/g, ' ')).toBe('29 Sep, 5:36 pm · in 2h');
    setFormatRegion({ locale: 'en-AU', hourCycle: 'h23' });
    expect(formatQuotaReset(reset, undefined, reset - 2 * 3_600_000)).toBe('29 Sep, 17:36 · in 2h');
    setFormatRegion(region);
  });
});

describe('reset credits expiry', () => {
  const day = 86_400_000;
  const expiring = (msLeft: number, resetCredits = 2) =>
    resetCreditsExpiry({ resetCredits, resetCreditsEarliestExpiry: new Date(resetMs).toISOString() }, resetMs - msLeft);

  it('gives the first expiry while credits are left, flagging the last three days', () => {
    expect(expiring(20 * day)).toEqual({ atMs: resetMs, soon: false });
    expect(expiring(3 * day)).toEqual({ atMs: resetMs, soon: true });
    expect(expiring(60_000)).toEqual({ atMs: resetMs, soon: true });
  });

  it('gives nothing with no credits, no date, or a date already passed', () => {
    expect(expiring(20 * day, 0)).toBeUndefined();
    expect(expiring(0)).toBeUndefined();
    expect(resetCreditsExpiry({ resetCredits: 1 }, resetMs)).toBeUndefined();
    expect(resetCreditsExpiry({ resetCredits: 1, resetCreditsEarliestExpiry: 'never' }, resetMs)).toBeUndefined();
  });
});

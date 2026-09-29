import { describe, expect, it } from 'bun:test';
import { freshQuotas } from '../src/services/accountLimits';
import { expiringCapacity, nextExpiringNotifications, type ExpiringCapacity } from '../src/services/expiringCapacity';
import { providerLimits } from '../src/services/providerLimits';
import { quotaKey, type QuotaState } from '../src/services/quotaService';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = 100 * DAY;
const claude = (name: string) => ({ name, provider: 'claude', auth_index: name });
const quota = (weeklyLeft: number | null, weeklyResetIn: number, status: QuotaState['status'] = 'success'): QuotaState => ({
  status,
  rows: [
    { label: '5-hour window', remainingPercent: 90, resetAtMs: now + HOUR },
    { label: '7-day window', remainingPercent: weeklyLeft, resetAtMs: now + weeklyResetIn },
  ],
});
const noPrefs = { hidden: {}, headline: {} };

describe('capacity about to reset unused', () => {
  it('finds accounts with plenty of the headline limit left within a day of its reset', () => {
    const files = [claude('work.json'), claude('busy.json'), claude('early.json'), claude('failed.json'), claude('edge.json')];
    const quotas: Record<string, QuotaState> = {
      [quotaKey(files[0]!)]: quota(45, 20 * HOUR),
      [quotaKey(files[1]!)]: quota(12, 20 * HOUR),
      [quotaKey(files[2]!)]: quota(80, 3 * DAY),
      [quotaKey(files[3]!)]: quota(80, 20 * HOUR, 'error'),
      [quotaKey(files[4]!)]: quota(30, DAY),
    };
    const found = expiringCapacity(providerLimits(files, quotas, {}, noPrefs, now), now);
    expect(found).toEqual([
      { provider: 'claude', key: quotaKey(files[0]!), name: 'work', window: '7-day window', percent: 45, resetAtMs: now + 20 * HOUR },
      { provider: 'claude', key: quotaKey(files[4]!), name: 'edge', window: '7-day window', percent: 30, resetAtMs: now + DAY },
    ]);
  });

  it('ignores headline windows shorter than a day', () => {
    const files = [claude('work.json')];
    const quotas = { [quotaKey(files[0]!)]: quota(45, 20 * HOUR) };
    const limits = providerLimits(files, quotas, {}, { hidden: {}, headline: { claude: '5-hour window' } }, now);
    expect(expiringCapacity(limits, now)).toEqual([]);
  });

  it('never mentions limits held over from before a failed check', () => {
    const files = [claude('work.json')];
    const stale: QuotaState = { ...quota(45, 20 * HOUR, 'error'), error: 'timeout', fetchedAt: now - HOUR, staleSinceMs: now - 30 * 60_000 };
    const quotas = { [quotaKey(files[0]!)]: stale };
    expect(expiringCapacity(providerLimits(files, quotas, {}, noPrefs, now), now)).toEqual([]);
    expect(expiringCapacity(providerLimits(files, freshQuotas(quotas), {}, noPrefs, now), now)).toEqual([]);
  });

  it('mentions each window once before every reset', () => {
    const item: ExpiringCapacity = { provider: 'claude', key: 'work.json::work', name: 'work', window: '7-day window', percent: 45, resetAtMs: now + 20 * HOUR };
    const first = nextExpiringNotifications({}, [item], now);
    expect(first.fresh).toEqual([item]);
    expect(first.changed).toBe(true);

    // The same reset, computed from a countdown that drifted a couple of minutes: already mentioned.
    const again = nextExpiringNotifications(first.notified, [{ ...item, resetAtMs: item.resetAtMs + 2 * 60_000 }], now + HOUR);
    expect(again.fresh).toEqual([]);
    expect(again.changed).toBe(false);

    // A week later the next window is about to reset unused too.
    const nextWeek = { ...item, resetAtMs: item.resetAtMs + 7 * DAY };
    const later = nextExpiringNotifications(again.notified, [nextWeek], now + 7 * DAY);
    expect(later.fresh).toEqual([nextWeek]);
    expect(later.notified).toEqual({ 'work.json::work::7-day window': nextWeek.resetAtMs });
  });

  it('forgets a mention a day after its reset', () => {
    const notified = { 'work.json::work::7-day window': now - 2 * DAY };
    expect(nextExpiringNotifications(notified, [], now)).toEqual({ notified: {}, fresh: [], changed: true });
  });
});

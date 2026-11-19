import { describe, expect, it } from 'bun:test';
import { liftedRests, type RestedAccount } from '../src/services/liftedRests';
import { quotaKey, type QuotaState } from '../src/services/quotaService';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = 100 * DAY;
const listedAt = { receivedAtMs: now };

/** A rest the core took for a limit, running for another `hours`. */
const rest = (hours: number, more: Record<string, unknown> = {}) => ({
  scope: 'model', model_key: 'claude-opus-5-5', reason: 'quota', http_status: 429,
  retry_at: new Date(now + hours * HOUR).toISOString(), remaining_seconds: hours * 3600, ...more,
});
const claude = (name: string, cooldowns: unknown[] = []) => ({ name, provider: 'claude', auth_index: name, status: 'active', cooldowns });
const limits = (weeklyLeft: number | null, more: Partial<QuotaState> = {}): QuotaState => ({
  status: 'success',
  rows: [
    { label: '5-hour window', remainingPercent: 80, resetAtMs: now + HOUR },
    { label: '7-day window', remainingPercent: weeklyLeft, resetAtMs: now + 3 * DAY },
  ],
  ...more,
});
const account = (file: ReturnType<typeof claude>, quota: QuotaState | undefined): RestedAccount => ({ key: quotaKey(file), file, quota });
const names = (found: RestedAccount[]) => found.map((item) => item.file.name);

describe('rests that outlive a refilled limit', () => {
  it('names an account seen out that has limit left again while the core still rests it', () => {
    const file = claude('cam-work.json', [rest(82)]);
    // At the weekly limit: remembered, and nothing to drop.
    const out = liftedRests([account(file, limits(0))], listedAt, {}, now);
    expect(out.lifted).toEqual([]);
    expect(out.seenOut).toEqual({ [quotaKey(file)]: now });
    // A reset refilled part of the week; the core's rest still runs to the old reset time.
    const later = now + 10 * 60_000;
    const refilled = liftedRests([account(file, limits(43))], { receivedAtMs: later }, out.seenOut, later);
    expect(names(refilled.lifted)).toEqual(['cam-work.json']);
    // Told once: if the core rests it again at this reading, the provider knows more than the reading does.
    expect(refilled.seenOut).toEqual({});
    expect(liftedRests([account(file, limits(43))], { receivedAtMs: later }, refilled.seenOut, later).lifted).toEqual([]);
  });

  it('leaves a rest on an account that was never seen out', () => {
    const file = claude('cam-work.json', [rest(3)]);
    expect(liftedRests([account(file, limits(60))], listedAt, {}, now)).toEqual({ lifted: [], seenOut: {} });
  });

  it('counts 1% left as out, and a limit outside the main ones as none of its business', () => {
    const file = claude('cam-work.json', [rest(3)]);
    expect(liftedRests([account(file, limits(1))], listedAt, {}, now).seenOut).toEqual({ [quotaKey(file)]: now });
    const extraOut = limits(50, { rows: [{ label: '7-day window', remainingPercent: 50 }, { label: 'Code review', remainingPercent: 0, extra: true }] });
    expect(liftedRests([account(file, extraOut)], listedAt, {}, now).seenOut).toEqual({});
  });

  it('waits while limits aren’t known, a window is still out or the listing shows no rest yet', () => {
    const seen = { 'cam-work.json::cam-work.json': now - HOUR };
    const resting = claude('cam-work.json', [rest(3)]);
    for (const quota of [undefined, limits(40, { status: 'loading' }), limits(40, { status: 'error' }), limits(40, { staleSinceMs: now - 60_000, fetchedAt: now - HOUR })]) {
      expect(liftedRests([account(resting, quota)], listedAt, seen, now)).toEqual({ lifted: [], seenOut: seen });
    }
    // The rest hasn't reached a listing, or the listing never arrived.
    expect(liftedRests([account(claude('cam-work.json'), limits(40))], listedAt, seen, now)).toEqual({ lifted: [], seenOut: seen });
    expect(liftedRests([account(resting, limits(40))], { receivedAtMs: 0 }, seen, now)).toEqual({ lifted: [], seenOut: seen });
    // Still out: remembered from now.
    expect(liftedRests([account(resting, limits(0))], listedAt, seen, now).seenOut).toEqual({ [quotaKey(resting)]: now });
  });

  it('only drops rests taken for a limit, and only while they run', () => {
    const seen = { 'cam-work.json::cam-work.json': now - HOUR };
    const upstream = claude('cam-work.json', [rest(1, { reason: 'transient_error', http_status: 503 })]);
    expect(liftedRests([account(upstream, limits(40))], listedAt, seen, now).lifted).toEqual([]);
    const wholeAccount = claude('cam-work.json', [{ scope: 'credential', reason: 'credential_quota', retry_at: new Date(now + DAY).toISOString(), remaining_seconds: 86_400 }]);
    expect(names(liftedRests([account(wholeAccount, limits(40))], listedAt, seen, now).lifted)).toEqual(['cam-work.json']);
    // The rest ended since the listing arrived.
    expect(liftedRests([account(claude('cam-work.json', [rest(1)]), limits(40))], listedAt, seen, now + 2 * HOUR).lifted).toEqual([]);
  });

  it('forgets an account seen out more than a window ago, or no longer listed', () => {
    const file = claude('cam-work.json', [rest(3)]);
    expect(liftedRests([account(file, limits(40))], listedAt, { [quotaKey(file)]: now - 9 * DAY, 'gone.json::gone': now }, now)).toEqual({ lifted: [], seenOut: {} });
  });
});

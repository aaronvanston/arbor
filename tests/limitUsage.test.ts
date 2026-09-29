import { describe, expect, it } from 'bun:test';
import { limitScope, limitSpan, limitUsage, limitWindowOptions } from '../src/services/limitUsage';
import type { LimitCycle, UsageSession, UsageSessionPage } from '../src/native/types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_000 * DAY;

const cycle = (resetAtMs: number, minRemainingPercent: number, authIndex = 'claude-1'): LimitCycle => ({
  account: 'claude-max.json::claude-1', authIndex, plan: 'max', window: '7-day window', resetAtMs,
  firstRemainingPercent: 100, minRemainingPercent, firstSampledAtMs: resetAtMs - 6 * DAY, lastSampledAtMs: resetAtMs - HOUR,
});

const session = (id: string, estimatedCost: number, totalTokens: number): UsageSession => ({
  id, parentId: null, depth: 0, models: ['claude-opus-5'], providers: ['claude'], userAgent: 'claude-cli/2.1.280 (external, cli)',
  startedAtMs: 0, lastActiveAtMs: 0, requests: 10, failures: 0, canceled: 0,
  inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  totalTokens, estimatedCost, pricedRequests: estimatedCost > 0 ? 10 : 0, peakContext: 0, compactions: 0,
  provider: 'claude', machine: '', pool: '', apiKeyHash: '', active: false, hasOwnRequests: true, subagents: 0, threads: [], transcript: null,
});
const page = (items: UsageSession[], sessions = items.length): UsageSessionPage => ({
  items, total: sessions, page: 1, pageSize: 20, totalPages: 1,
  summary: {
    sessions, subagentThreads: 0, active: 0, requests: 0,
    totalTokens: items.reduce((sum, item) => sum + item.totalTokens, 0) * (sessions > items.length ? 2 : 1),
    estimatedCost: items.reduce((sum, item) => sum + item.estimatedCost, 0) * (sessions > items.length ? 2 : 1),
    pricedRequests: 0,
    untrackedRequests: 0,
  },
});

describe('which limits Arbor can explain', () => {
  it('times the main windows and limits the model windows to their family', () => {
    expect(limitScope({ label: '5-hour window' })).toEqual({ durationMs: 5 * HOUR, modelFamily: null });
    expect(limitScope({ label: 'Weekly limit' })).toEqual({ durationMs: 7 * DAY, modelFamily: null });
    expect(limitScope({ label: '7-day Opus window' })).toEqual({ durationMs: 7 * DAY, modelFamily: 'opus' });
    expect(limitScope({ label: '7-day Sonnet window' })).toEqual({ durationMs: 7 * DAY, modelFamily: 'sonnet' });
    expect(limitScope({ label: '7-day Fable window' })).toEqual({ durationMs: 7 * DAY, modelFamily: 'fable' });
  });

  it('times a window by the length the provider gave, before the one its label implies', () => {
    expect(limitScope({ label: 'Weekly limit', windowMs: 30 * DAY })).toEqual({ durationMs: 30 * DAY, modelFamily: null });
    expect(limitScope({ label: 'Quota', windowMs: 5 * HOUR })).toEqual({ durationMs: 5 * HOUR, modelFamily: null });
    // A length doesn't make a window Arbor never sees explainable.
    expect(limitScope({ label: '7-day Cowork window', windowMs: 7 * DAY })).toBeNull();
  });

  it('leaves out limits whose use never goes through Arbor, or that it can’t time', () => {
    expect(limitScope({ label: '7-day OAuth apps window' })).toBeNull();
    expect(limitScope({ label: '7-day Cowork window' })).toBeNull();
    expect(limitScope({ label: 'Code review 5-hour limit', extra: true })).toBeNull();
    expect(limitScope({ label: 'Quota' })).toBeNull();
  });
});

describe('the windows to pick from', () => {
  it('starts one window length before the reset and stops at the reset or now', () => {
    expect(limitSpan(NOW + 2 * HOUR, 5 * HOUR, NOW)).toEqual({ startMs: NOW - 3 * HOUR, endMs: NOW, resetAtMs: NOW + 2 * HOUR });
    expect(limitSpan(NOW - DAY, 7 * DAY, NOW)).toEqual({ startMs: NOW - 8 * DAY, endMs: NOW - DAY, resetAtMs: NOW - DAY });
  });

  it('puts the running window first and earlier ones from the history after it, newest first', () => {
    const options = limitWindowOptions(
      { remainingPercent: 38, resetAtMs: NOW + 3 * DAY },
      'claude-1',
      // The history's record of the running window drifted by minutes: it isn't listed twice.
      [cycle(NOW - 11 * DAY, 60, 'claude-old'), cycle(NOW + 3 * DAY + 20 * 60_000, 40), cycle(NOW - 4 * DAY, 0)],
      7 * DAY,
      NOW,
    );
    expect(options.map((option) => [option.key, option.current, option.usedPercent, option.authIndex])).toEqual([
      ['current', true, 62, 'claude-1'],
      [String(NOW - 4 * DAY), false, 100, 'claude-1'],
      // An earlier window keeps the credential its requests were sent with.
      [String(NOW - 11 * DAY), false, 40, 'claude-old'],
    ]);
  });

  it('ends a window that was reset early where the running one starts', () => {
    // A banked reset cleared the week that was due to reset in two days; a new week began an hour ago.
    const options = limitWindowOptions({ remainingPercent: 97, resetAtMs: NOW + 7 * DAY - HOUR }, 'claude-1', [cycle(NOW + 2 * DAY, 3)], 7 * DAY, NOW);
    expect(options[1]).toMatchObject({ current: false, usedPercent: 97, span: { startMs: NOW - 5 * DAY, endMs: NOW - HOUR } });
  });

  it('takes the running window from the history when the account hasn’t been refreshed', () => {
    const options = limitWindowOptions({ remainingPercent: null, resetAtMs: undefined }, 'claude-1', [cycle(NOW - 5 * DAY, 20), cycle(NOW + 2 * DAY, 55)], 7 * DAY, NOW);
    expect(options.map((option) => [option.current, option.usedPercent])).toEqual([[true, 45], [false, 80]]);
    expect(limitWindowOptions({ remainingPercent: 100, resetAtMs: undefined }, 'claude-1', [], 7 * DAY, NOW)).toEqual([]);
  });
});

describe('each session’s share of a window', () => {
  it('shares by API-price cost and sums up the sessions not listed', () => {
    const usage = limitUsage(page([session('big', 30, 1_000), session('small', 10, 9_000)], 5), 2);
    expect(usage.measure).toBe('cost');
    expect(usage.sessions.map((item) => [item.session.id, item.share])).toEqual([['big', 0.375], ['small', 0.125]]);
    expect(usage.rest).toEqual({ sessions: 3, share: 0.5 });
  });

  it('falls back to tokens when none of the requests have a price', () => {
    const usage = limitUsage(page([session('a', 0, 3_000), session('b', 0, 1_000)]), 10);
    expect(usage.measure).toBe('tokens');
    expect(usage.sessions.map((item) => item.share)).toEqual([0.75, 0.25]);
    expect(usage.rest).toEqual({ sessions: 0, share: 0 });
  });
});

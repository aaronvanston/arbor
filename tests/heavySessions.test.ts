import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import { heavySessions, heavySessionText, nextHeavyNotifications, type HeavySession } from '../src/services/heavySessions';
import type { UsageSession, UsageSessionPage } from '../src/native/types';

const HOUR = 3_600_000;
const M = 1_000_000;
const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);

const session = (id: string, totalTokens: number, fields: Partial<UsageSession> = {}): UsageSession => ({
  id, parentId: null, depth: 0, models: ['claude-fable-5-1'], providers: ['claude'],
  userAgent: 'claude-cli/2.1.280 (external, cli) AcmeDesk/1.4.205',
  startedAtMs: 0, lastActiveAtMs: 0, requests: 100, failures: 0, canceled: 0,
  inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  totalTokens, estimatedCost: 84.2, pricedRequests: 100, peakContext: 0, compactions: 0,
  provider: 'claude', machine: 'Cedar 01', pool: 'Cedar', apiKeyHash: 'desk-cedar', active: true, hasOwnRequests: true, subagents: 0, threads: [], transcript: null,
  ...fields,
});
const page = (items: UsageSession[]): UsageSessionPage => ({
  items, total: items.length, page: 1, pageSize: 200, totalPages: 1,
  summary: { sessions: items.length, subagentThreads: 0, active: 0, requests: 0, totalTokens: 0, estimatedCost: 0, pricedRequests: 0, untrackedRequests: 0 },
});
const heavy = (id: string, fields: Partial<HeavySession> = {}): HeavySession => ({
  id, client: 'Claude Code', host: 'AcmeDesk', machine: 'Cedar 01', apiKeyHash: 'desk-cedar', tokens: 130 * M, requests: 100, cost: 84.2, otherKeySessions: 0, ...fields,
});

describe('heavy sessions', () => {
  it('flags the sessions over the hourly threshold, heaviest first', () => {
    const hour = page([
      session('quiet', 12 * M),
      session('heavy', 130 * M),
      session('heavier', 290 * M, { userAgent: 'codex_exec/0.156.0 (Mac OS 26.0.0; arm64) dumb', machine: '', apiKeyHash: 'runner', pricedRequests: 90 }),
      session('same-key', 3 * M),
    ]);
    const items = heavySessions(hour, 100 * M);
    expect(items.map((item) => item.id)).toEqual(['heavier', 'heavy']);
    expect(items[1]).toEqual({
      id: 'heavy', client: 'Claude Code', host: 'AcmeDesk', machine: 'Cedar 01', apiKeyHash: 'desk-cedar',
      tokens: 130 * M, requests: 100, cost: 84.2,
      // The quiet session and the one after it used the same key.
      otherKeySessions: 2,
    });
    // Some requests had no price, so the cost would fall short.
    expect(items[0]).toMatchObject({ client: 'codex exec', host: null, cost: null, otherKeySessions: 0 });
    expect(heavySessions(hour, 0)).toEqual([]);
    expect(heavySessions(hour, 500 * M)).toEqual([]);
  });

  it('notifies when a session goes over, and again only after an hour under', () => {
    const start = 1_000 * HOUR;
    const first = nextHeavyNotifications({}, [heavy('a')], start);
    expect(first.fresh.map((item) => item.id)).toEqual(['a']);
    expect(first.seen).toEqual({ a: start });

    // Still over a few minutes later: nothing new, but it's still seen.
    const still = nextHeavyNotifications(first.seen, [heavy('a'), heavy('b')], start + 10 * 60_000);
    expect(still.fresh.map((item) => item.id)).toEqual(['b']);
    expect(still.seen.a).toBe(start + 10 * 60_000);

    // Under for 50 minutes isn't a new stretch; under for more than an hour is.
    expect(nextHeavyNotifications(still.seen, [heavy('a')], start + 60 * 60_000).fresh).toEqual([]);
    expect(nextHeavyNotifications(still.seen, [heavy('a')], start + 80 * 60_000).fresh.map((item) => item.id)).toEqual(['a']);

    // Nothing over and nothing to forget: no write needed. Day-old entries go.
    expect(nextHeavyNotifications(still.seen, [], start + 2 * HOUR).changed).toBe(false);
    const later = nextHeavyNotifications(still.seen, [], start + 25 * HOUR);
    expect(later).toMatchObject({ seen: {}, fresh: [], changed: true });
  });

  it('says where the session runs, what it used and what that would cost', () => {
    expect(heavySessionText(heavy('a'), t)).toEqual({
      title: 'Heavy session on Cedar 01',
      body: 'Claude Code in AcmeDesk used 130M tokens in the last hour, about $84.20 at API prices.',
    });
    expect(heavySessionText(heavy('a', { machine: '', client: null, host: null, cost: null, tokens: 1_400 * M }), t)).toEqual({
      title: 'Heavy session',
      body: 'A session used 1.4B tokens in the last hour.',
    });
    expect(t('notifications.heavySession.withSession', { text: 'Codex CLI used 210M tokens in the last hour.', id: '9c9d9117' }))
      .toBe('Codex CLI used 210M tokens in the last hour. Session 9c9d9117.');
  });
});

describe('heavy sessions per machine', () => {
  it('holds each session to its own machine’s threshold, where 0 is off', () => {
    const hour = page([
      session('ci', 300 * M, { machine: 'ci-01' }),
      session('cedar', 300 * M, { machine: 'cedar-02' }),
      session('laptop', 120 * M, { machine: 'casey-mbp' }),
    ]);
    const threshold = ({ machine }: { machine: string }) => ({ 'ci-01': 0, 'cedar-02': 500 * M })[machine] ?? 100 * M;
    expect(heavySessions(hour, threshold).map((item) => item.id)).toEqual(['laptop']);
  });
});

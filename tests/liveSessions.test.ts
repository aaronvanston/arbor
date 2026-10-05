import { describe, expect, test } from 'bun:test';
import { translate } from '../src/i18n';
import { clientCountsText, compactionOutlook, contextShare, liveSessionName, liveTrayRows } from '../src/services/liveSessions';
import type { LiveContext, LiveSession, LiveSessionsReport, SessionTranscript } from '../src/native/types';

const MINUTE = 60_000;
const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);

const context = (fields: Partial<LiveContext> = {}): LiveContext => ({
  tokens: 212_000, model: 'claude-opus-5-5', compactsAt: 365_000, basis: 'learned', growthPerMinute: 8_000, compactsInMs: 19 * MINUTE,
  ...fields,
});

const transcript = (fields: Partial<SessionTranscript>): SessionTranscript => ({
  machine: 'cam-mbp', agent: 'claude', home: '/Users/cam', agentHome: '', cwd: '/Users/cam/src/arbor', repoRoot: '/Users/cam/src/arbor',
  mainRepo: '/Users/cam/src/arbor', branch: 'fix/login-loop', commitHash: '', repositoryUrl: '', title: '', titleSource: '',
  pullRequests: [], linesAdded: null, linesRemoved: null, compactions: [], toolUsage: null, readAtMs: 0,
  ...fields,
});

const session = (id: string, fields: Partial<LiveSession> = {}): LiveSession => ({
  id, parentId: null, depth: 0, models: ['claude-opus-5-5'], providers: ['claude'], userAgent: 'claude-cli/2.1.280 (external, cli)',
  startedAtMs: 0, lastActiveAtMs: 0, requests: 40, failures: 0, canceled: 0,
  inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  totalTokens: 0, estimatedCost: 12.4, pricedRequests: 40, peakContext: 0, compactions: 0,
  provider: 'claude', machine: 'cam-mbp', pool: '', apiKeyHash: '', active: true, hasOwnRequests: true, subagents: 0, threads: [],
  transcript: null, runningSinceMs: 0, context: context(),
  ...fields,
});

const report = (sessions: LiveSession[], fields: Partial<LiveSessionsReport> = {}): LiveSessionsReport => ({
  sessions, running: sessions.length, costPerHour: sessions.reduce((sum, item) => sum + item.estimatedCost, 0),
  requests: 100, pricedRequests: 100, clients: sessions.map((item) => item.userAgent ?? ''),
  ...fields,
});

describe('live context', () => {
  test('the gauge fills on the way to the compaction point, and is empty without one', () => {
    expect(contextShare(context({ tokens: 182_500 }))).toBe(0.5);
    expect(contextShare(context({ tokens: 400_000 }))).toBe(1);
    expect(contextShare(context({ compactsAt: null }))).toBeNull();
  });

  test('a compaction is due at the point, and soon within half an hour', () => {
    expect(compactionOutlook(context({ compactsInMs: 0 }))).toEqual({ kind: 'due' });
    expect(compactionOutlook(context({ compactsInMs: 12 * MINUTE }))).toEqual({ kind: 'in', ms: 12 * MINUTE, soon: true });
    expect(compactionOutlook(context({ compactsInMs: 90 * MINUTE }))).toEqual({ kind: 'in', ms: 90 * MINUTE, soon: false });
    expect(compactionOutlook(context({ compactsInMs: null }))).toBeNull();
  });

  test('a session goes by its title, else where it ran, else its client or id', () => {
    expect(liveSessionName(session('a', { transcript: transcript({ title: 'Fix the login loop' }) }))).toBe('Fix the login loop');
    expect(liveSessionName(session('a', { transcript: transcript({}) }))).toBe('arbor · fix/login-loop');
    expect(liveSessionName(session('a', { transcript: transcript({ branch: '' }) }))).toBe('arbor');
    expect(liveSessionName(session('a'))).toBe('Claude Code');
    expect(liveSessionName(session('5f0c2a8e-3b1d-4c6f-9e2a-7d4b1c8e0f31', { userAgent: null }))).toBe('5f0c2a8e');
  });
});

describe('tray rows', () => {
  test('a line for them all and their clients, then the costliest three, and the rest in a sub-menu', () => {
    const rows = liveTrayRows(report([
      session('a', { transcript: transcript({ title: 'Move the billing worker onto the new queue service' }), estimatedCost: 97.4 }),
      session('b', { context: context({ tokens: 341_000, compactsAt: 358_000, compactsInMs: 0 }), estimatedCost: 6.1 }),
      session('c', { context: context({ compactsAt: null, tokens: 96_300, compactsInMs: null }), estimatedCost: 0, pricedRequests: 0 }),
      session('d', { estimatedCost: 1.2, context: context({ compactsInMs: null }) }),
    ], { running: 6 }), [], t, { machineName: (machine) => (machine === 'cam-mbp' ? 'Cam MBP' : machine) });
    expect(rows).toEqual([
      // Every amount shows cents, the $100-plus total included.
      { text: '6 sessions running · $104.70/h' },
      { text: '4 Claude' },
      // Close to compacting, or nearly full, is amber.
      { text: 'Move the billing worker onto th… · 58% context · $97.40/h · compacts in ~19m', dot: 'amber' },
      { text: 'Claude Code · 95% context · $6.10/h · compacts any moment', dot: 'amber' },
      { text: 'Claude Code · 96.3K context', dot: 'blank' },
      {
        text: '3 more',
        dot: 'blank',
        children: [
          { text: 'Claude Code · 58% context · $1.20/h · Cam MBP', dot: 'blank' },
          // The report lists twelve at most; the rest are only counted.
          { text: '…and 2 more' },
        ],
      },
    ]);
  });

  test('sessions waiting on you come before the costliest, in amber', () => {
    const rows = liveTrayRows(
      report([session('a', { context: context({ compactsInMs: 45 * MINUTE }) })]),
      [{ name: 'Fix the login loop', status: 'approval', machine: 'cam-mbp', sinceMs: 0 }],
      t,
      { nowMs: 4 * MINUTE },
    );
    expect(rows.map((row) => row.text)).toEqual([
      '1 session running · $12.40/h',
      '1 Claude',
      'Waiting on you',
      'Fix the login loop · Needs approval · cam-mbp · 4m',
      'Costliest',
      'Claude Code · 58% context · $12.40/h',
    ]);
    expect(rows[3]?.dot).toBe('amber');
    // Waiting with nothing running through Arbor still lists the wait.
    expect(liveTrayRows(report([]), [{ name: 'Fix the login loop', status: 'question', machine: '', sinceMs: 0 }], t, { nowMs: 2 * MINUTE }).map((row) => row.text))
      .toEqual(['Waiting on you', 'Fix the login loop · Has a question · 2m']);
  });

  test('counts the running sessions by client, and leaves the cost out when nothing had a price', () => {
    expect(clientCountsText(['claude-cli/2.1.280 (external, cli)', 'codex_cli_rs/0.158.0', 'codex_exec/0.158.0', 'curl/8.7.1', ''], t))
      .toBe('1 Claude · 2 Codex · 2 other');
    expect(liveTrayRows(report([session('a')], { pricedRequests: 0 }), [], t)[0]).toEqual({ text: '1 session running' });
    expect(liveTrayRows(report([]), [], t)).toEqual([]);
    expect(liveTrayRows(null, [], t)).toEqual([]);
  });
});

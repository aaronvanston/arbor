import { describe, expect, it } from 'bun:test';
import {
  buildThreadTimeline,
  cacheHitRate,
  cacheMissTokens,
  costTotal,
  failureMessage,
  sessionChecks,
  sessionPlatform,
  sessionTotals,
  speedTier,
  threadNames,
} from '../src/services/sessionTimeline';
import type {
  SessionRequest,
  SessionTranscript,
  UsageSession,
  UsageSessionThread,
  UsageSessionTimeline,
} from '../src/native/types';

const T0 = Date.UTC(2026, 8, 24, 0, 0, 0);
const MINUTE = 60_000;

const request = (minute: number, input: number, overrides: Partial<SessionRequest> = {}): SessionRequest => ({
  timestampMs: T0 + minute * MINUTE,
  threadId: 'main',
  model: 'claude-opus-5-5',
  reasoningEffort: 'xhigh',
  serviceTier: 'auto',
  latencyMs: 5_000,
  ttftMs: 1_000,
  failed: false,
  canceled: false,
  failureStatus: 0,
  failure: '',
  inputTokens: input,
  outputTokens: 500,
  reasoningTokens: 0,
  cacheReadTokens: Math.round(input * 0.9),
  cacheCreationTokens: Math.round(input * 0.05),
  cost: { input: 0.01, cacheRead: 0.02, cacheWrite: 0.03, output: 0.04 },
  longContext: false,
  step: 'conversation',
  ...overrides,
});

const thread = (id: string, parentId: string | null, startedMinute: number, overrides: Partial<UsageSessionThread> = {}): UsageSessionThread => ({
  id, parentId, depth: parentId ? 1 : 0, models: ['claude-opus-5-5'], providers: ['claude'], userAgent: null,
  startedAtMs: T0 + startedMinute * MINUTE, lastActiveAtMs: T0 + (startedMinute + 5) * MINUTE,
  requests: 3, failures: 0, canceled: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  totalTokens: 0, estimatedCost: 1, pricedRequests: 3, peakContext: 0, compactions: 0, ...overrides,
});

const session = (threads: UsageSessionThread[]): UsageSession => ({
  ...thread('main', null, 0),
  provider: 'claude', machine: 'casey-mbp', pool: '', apiKeyHash: 'hash', active: false, hasOwnRequests: true,
  subagents: threads.length - 1, threads, transcript: null,
});

const timelineOf = (requests: SessionRequest[], threads = [thread('main', null, 0)], thresholds: Record<string, number> = {}): UsageSessionTimeline => ({
  session: session(threads),
  requests,
  truncated: false,
  longContextThresholds: thresholds,
});

describe('a thread’s context line and events', () => {
  it('draws only the conversation and marks each compaction with its summary', () => {
    const timeline = timelineOf([
      request(0, 100_000),
      request(1, 200_000),
      request(2, 8_000, { step: 'side', reasoningEffort: '' }),
      request(3, 360_000, { outputTokens: 11_000 }),
      request(4, 80_000, { step: 'compacted', cacheReadTokens: 20_000 }),
      request(5, 90_000),
    ]);
    const main = buildThreadTimeline(timeline, 'main');
    expect(main.points.map((point) => point.context)).toEqual([100_000, 200_000, 360_000, 80_000, 90_000]);
    expect(main).toMatchObject({ requests: 6, sideRequests: 1, peak: 360_000, compactions: 1 });
    expect(main.events).toEqual([
      { kind: 'compaction', at: 3, timestampMs: T0 + 4 * MINUTE, before: 360_000, after: 80_000, summary: 11_000, detected: true, recorded: false, trigger: null, durationMs: null },
    ]);
  });

  it('says what started each compaction the transcript recorded, and adds the ones the requests didn’t show', () => {
    const transcript: SessionTranscript = {
      machine: 'casey-mbp', agent: 'claude', home: '/Users/casey', agentHome: '', cwd: '/Users/casey/src/arbor', repoRoot: '', mainRepo: '', branch: '', commitHash: '',
      repositoryUrl: '', title: '', titleSource: '', pullRequests: [], linesAdded: null, linesRemoved: null, toolUsage: null, readAtMs: T0,
      compactions: [
        { atMs: T0 + 2 * MINUTE - 20_000, trigger: 'auto', preTokens: 361_000, postTokens: 79_000, durationMs: 41_000 },
        // Too far from the one Arbor saw to be it.
        { atMs: T0 + 13 * MINUTE, trigger: 'manual', preTokens: 120_000, postTokens: 30_000, durationMs: 12_000 },
        // Codex doesn't say what started it, or how big the conversation was.
        { atMs: T0 + 20 * MINUTE, trigger: '', preTokens: null, postTokens: null, durationMs: null },
      ],
    };
    const timeline = timelineOf(
      [
        request(0, 100_000),
        request(1, 360_000, { outputTokens: 11_000 }),
        request(2, 80_000, { step: 'compacted' }),
        request(3, 90_000),
        request(15, 30_000, { threadId: 'agent' }),
        request(16, 60_000, { threadId: 'agent' }),
        request(17, 95_000),
      ],
      [thread('main', null, 0), thread('agent', 'main', 15)],
    );
    timeline.session = { ...timeline.session!, transcript };
    const main = buildThreadTimeline(timeline, 'main');
    expect(main.compactions).toBe(3);
    expect(main.events.filter((event) => event.kind === 'compaction')).toEqual([
      { kind: 'compaction', at: 2, timestampMs: T0 + 2 * MINUTE, before: 360_000, after: 80_000, summary: 11_000, detected: true, recorded: true, trigger: 'auto', durationMs: 41_000 },
      { kind: 'compaction', at: 4, timestampMs: T0 + 13 * MINUTE, before: 120_000, after: 30_000, summary: 0, detected: false, recorded: true, trigger: 'manual', durationMs: 12_000 },
      { kind: 'compaction', at: 4, timestampMs: T0 + 20 * MINUTE, before: 0, after: 0, summary: 0, detected: false, recorded: true, trigger: null, durationMs: null },
    ]);
    expect(buildThreadTimeline(timeline, 'agent').compactions).toBe(0);
  });

  it('notes model, effort and speed changes, but not a side request’s', () => {
    const timeline = timelineOf([
      request(0, 50_000),
      request(1, 52_000, { step: 'side', model: 'claude-haiku-4-5', reasoningEffort: '' }),
      request(2, 54_000, { reasoningEffort: 'max' }),
      request(3, 56_000, { model: 'claude-fable-5-1', reasoningEffort: 'max', serviceTier: 'priority' }),
    ]);
    const events = buildThreadTimeline(timeline, 'main').events;
    expect(events.map((event) => (event.kind === 'change' ? [event.at, event.change, event.from, event.to] : event.kind))).toEqual([
      [1, 'effort', 'xhigh', 'max'],
      [2, 'model', 'claude-opus-5-5', 'claude-fable-5-1'],
      [2, 'tier', 'standard', 'fast'],
    ]);
  });

  it('tells a cache that went cold from one that was dropped', () => {
    const cold = request(70, 110_000, { cacheReadTokens: 2_000, cacheCreationTokens: 108_000 });
    const dropped = request(71, 112_000, { cacheReadTokens: 0, cacheCreationTokens: 112_000 });
    const timeline = timelineOf([request(0, 100_000), cold, dropped]);
    const misses = buildThreadTimeline(timeline, 'main').events.filter((event) => event.kind === 'cacheMiss');
    expect(misses.map((event) => event.kind === 'cacheMiss' && [event.at, event.tokens, Math.round(event.idleMs / MINUTE)])).toEqual([
      [1, 98_000, 70],
      [2, 110_000, 1],
    ]);
    expect(misses[0]!.kind === 'cacheMiss' && misses[0]!.cost).toBeCloseTo(0.04);
  });

  it('ignores cache misses that are too small, or on a conversation that was never cached', () => {
    const base = request(0, 100_000);
    expect(cacheMissTokens(base, request(1, 101_000, { cacheReadTokens: 95_000 }))).toBe(0);
    expect(cacheMissTokens(request(0, 15_000), request(1, 16_000, { cacheReadTokens: 0 }))).toBe(0);
    expect(cacheMissTokens(request(0, 100_000, { cacheReadTokens: 0, cacheCreationTokens: 0 }), request(1, 101_000, { cacheReadTokens: 0 }))).toBe(0);
    // A context that shrank a lot is a different conversation, not a miss.
    expect(cacheMissTokens(base, request(1, 70_000, { cacheReadTokens: 0 }))).toBe(0);
  });

  it('reads the message out of a JSON error, even one cut short', () => {
    expect(failureMessage('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_1"}')).toBe('Overloaded');
    expect(failureMessage('{"error":{"message":"Rate limit reached for gpt-5.6-sol","type":"requests","code":"rate_limit_exceeded"}}'))
      .toBe('Rate limit reached for gpt-5.6-sol');
    expect(failureMessage('{"error":{"message":"Model \\"x\\" isn\\u2019t available"}}')).toBe('Model "x" isn’t available');
    expect(failureMessage('{"type":"error","error":{"type":"rate_limit_error","message":"This request would exc')).toBe('This request would exc…');
    expect(failureMessage('  upstream timed out  ')).toBe('upstream timed out');
    expect(failureMessage('')).toBe('');
  });

  it('groups failures in a row and places events on the nearest point', () => {
    const timeline = timelineOf([
      request(0, 40_000),
      request(1, 0, { failed: true, failureStatus: 529, failure: ' overloaded ', step: null }),
      request(2, 0, { failed: true, failureStatus: 529, failure: 'overloaded', step: null }),
      request(3, 0, { failed: true, canceled: true, step: null }),
      request(4, 0, { failed: true, failureStatus: 400, failure: 'bad request', step: null }),
      request(5, 42_000),
    ]);
    const failures = buildThreadTimeline(timeline, 'main').events.filter((event) => event.kind === 'failure');
    expect(failures.map((event) => event.kind === 'failure' && [event.at, event.status, event.count, event.message])).toEqual([
      [1, 529, 2, 'overloaded'],
      [1, 400, 1, 'bad request'],
    ]);
  });

  it('shows subagents under the thread that started them, and idle time only when the whole session was idle', () => {
    const threads = [thread('main', null, 0), thread('agent-1', 'main', 10), thread('agent-2', 'agent-1', 12)];
    const timeline = timelineOf([
      request(0, 30_000),
      request(10, 5_000, { threadId: 'agent-1' }),
      request(20, 30_500),
      request(30, 30_600),
      request(46, 6_000, { threadId: 'agent-1' }),
      request(50, 31_000),
      request(125, 32_000),
    ], threads);
    const main = buildThreadTimeline(timeline, 'main');
    expect(main.events.map((event) => [event.kind, event.at])).toEqual([['subagent', 1], ['idle', 4]]);
    const idle = main.events.find((event) => event.kind === 'idle');
    expect(idle?.kind === 'idle' && Math.round(idle.idleMs / MINUTE)).toBe(75);
    // agent-1 sat idle for over 30 minutes while the main thread worked, then started agent-2.
    expect(buildThreadTimeline(timeline, 'agent-1').events.map((event) => [event.kind, event.at])).toEqual([['idle', 1], ['subagent', 1]]);
  });

  it('notes long-context billing once per stretch between compactions', () => {
    const timeline = timelineOf([
      request(0, 280_000, { model: 'gpt-6-sol', longContext: true }),
      request(1, 290_000, { model: 'gpt-6-sol', longContext: true }),
      request(2, 60_000, { model: 'gpt-6-sol', step: 'compacted' }),
      request(3, 300_000, { model: 'gpt-6-sol', longContext: true }),
    ], undefined, { 'gpt-6-sol': 272_000 });
    const long = buildThreadTimeline(timeline, 'main').events.filter((event) => event.kind === 'longContext');
    expect(long.map((event) => event.kind === 'longContext' && [event.at, event.threshold])).toEqual([[0, 272_000], [3, 272_000]]);
  });
});

describe('session totals and checks', () => {
  it('adds up cost by part, subagents and side requests, and active time without long gaps', () => {
    const timeline = timelineOf([
      request(0, 30_000),
      request(1, 5_000, { threadId: 'agent-1' }),
      request(2, 4_000, { step: 'side' }),
      request(60, 31_000, { cost: null }),
    ], [thread('main', null, 0), thread('agent-1', 'main', 1)]);
    const totals = sessionTotals(timeline, 'main');
    expect(totals.cost.output).toBeCloseTo(0.12);
    expect(totals.subagentCost).toBeCloseTo(0.1);
    expect(totals.sideCost).toBeCloseTo(0.1);
    expect(totals.unpricedRequests).toBe(1);
    // Two one-minute gaps, then the hour's gap counts only the request itself; the last adds its own time.
    expect(totals.activeMs).toBe(2 * MINUTE + 5_000 + 5_000);
    expect(totals.spanMs).toBe(60 * MINUTE + 5_000);
    expect(cacheHitRate(totals)).toBeCloseTo(0.9, 2);
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0 })).toBeNull();
  });

  it('flags deep context, cache misses, long-context billing, fast or costly subagents and high effort', () => {
    const threads = [thread('main', null, 0), thread('agent-1', 'main', 1)];
    const timeline = timelineOf([
      request(0, 300_000, { longContext: true }),
      request(1, 420_000, { longContext: true }),
      request(2, 430_000, { cacheReadTokens: 0, longContext: true }),
      request(3, 5_000, { threadId: 'agent-1', serviceTier: 'priority', cost: { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 } }),
    ], threads, { 'claude-opus-5-5': 200_000 });
    const main = buildThreadTimeline(timeline, 'main');
    const checks = sessionChecks(timeline, main, sessionTotals(timeline, 'main'));
    expect(checks.map((check) => check.id)).toEqual(['deepContext', 'cacheMisses', 'longContext', 'fastSubagents', 'subagentShare', 'highEffort']);
    expect(checks[0]).toEqual({ id: 'deepContext', peak: 430_000 });
    expect(checks[2]).toEqual({ id: 'longContext', requests: 3, threshold: 200_000 });
    expect(checks[5]).toEqual({ id: 'highEffort', effort: 'xhigh', share: 1 });
  });

  it('leaves subagents be when Arbor never saw the session’s own requests', () => {
    const agent = request(0, 30_000, { threadId: 'agent-1', reasoningEffort: 'medium' });
    const timeline = timelineOf([agent, { ...agent, timestampMs: agent.timestampMs + MINUTE }], [thread('agent-1', 'main', 0)]);
    timeline.session!.hasOwnRequests = false;
    const main = buildThreadTimeline(timeline, 'main');
    const totals = sessionTotals(timeline, 'main');
    expect(totals.subagentCost).toBeCloseTo(costTotal(totals.cost));
    expect(sessionChecks(timeline, main, totals)).toEqual([]);
  });

  it('has nothing to say about a small, cached session', () => {
    const timeline = timelineOf([request(0, 30_000, { reasoningEffort: 'high' }), request(1, 32_000, { reasoningEffort: 'high' })]);
    const main = buildThreadTimeline(timeline, 'main');
    expect(sessionChecks(timeline, main, sessionTotals(timeline, 'main'))).toEqual([]);
  });

  it('names threads the way the threads table numbers them', () => {
    const names = threadNames(session([thread('main', null, 0), thread('agent-1', 'main', 1), thread('agent-2', 'main', 2)]));
    expect([...names.entries()]).toEqual([
      ['main', { main: true, index: 0 }],
      ['agent-1', { main: false, index: 1 }],
      ['agent-2', { main: false, index: 2 }],
    ]);
  });

  it('reads speed tiers the way the UI names them', () => {
    expect([speedTier('priority'), speedTier('Fast'), speedTier('flex'), speedTier('auto'), speedTier('')]).toEqual(['fast', 'fast', 'flex', 'standard', 'standard']);
  });
});

describe('reading the machine from a User-Agent', () => {
  it('finds the OS, CPU and terminal Codex reports', () => {
    expect(sessionPlatform('codex-tui/0.156.0 (Mac OS 26.0.0; arm64) iTerm.app/3.6.1 AcmeDesk/1.4.205')).toEqual({ os: 'macOS 26', arch: 'arm64', terminal: 'iTerm' });
    expect(sessionPlatform('codex_exec/0.156.0 (Mac OS 27.0.0; arm64) unknown (codex_exec; 0.156.0)')).toEqual({ os: 'macOS 27', arch: 'arm64', terminal: undefined });
    expect(sessionPlatform('acme_desktop/0.156.0 (Ubuntu 26.4.0; x86_64) dumb (acme_desktop; 0.0.42)')).toEqual({ os: 'Ubuntu 26.4', arch: 'x86_64', terminal: undefined });
    // An app that runs Codex in its own terminal is that terminal.
    expect(sessionPlatform('codex-tui/0.156.0 (Mac OS 26.0.0; arm64) AcmeDesk/0.0.0-dev')).toEqual({ os: 'macOS 26', arch: 'arm64', terminal: 'AcmeDesk' });
    expect(sessionPlatform('Codex Desktop/0.156.0 (Mac OS 26.0.0; arm64)')).toEqual({ os: 'macOS 26', arch: 'arm64', terminal: undefined });
  });

  it('has nothing for clients that don’t report it', () => {
    expect(sessionPlatform('claude-cli/2.1.280 (external, cli)')).toBeNull();
    expect(sessionPlatform(null)).toBeNull();
  });
});

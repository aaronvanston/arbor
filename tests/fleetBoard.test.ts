import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import {
  boardForMachine,
  buildFleetBoard,
  effectiveSnooze,
  FLEET_STATUS_ORDER,
  fleetSessionName,
  fleetSkipNote,
  fleetStatus,
  fleetSummary,
  groupFleet,
  markFleetSeen,
  needsYouBySession,
  needsYouRows,
  needsYouSummary,
  pruneSeen,
  pruneSnoozes,
  rememberQuestions,
  setFleetSources,
  snoozeFleetSession,
  snoozedWaitIds,
  snoozeOptions,
  unsnoozeFleetSession,
  waitingCount,
  workingByMachine,
  type FleetBoard,
  type FleetSnoozes,
  type FleetSession,
} from '../src/services/fleetBoard';
import { itemAt, present } from './support/items';
import type {
  AttentionItem,
  FleetSources,
  SessionTranscript,
  T3Channel,
  T3Thread,
  UsageSession,
} from '../src/native/types';

const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 8, 26, 6, 0, 0);
const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);

const CLAUDE_ID = 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7';
const CODEX_ID = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

const thread = (fields: Partial<T3Thread> = {}): T3Thread => ({
  threadId: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', projectId: 'b1c2d3e4', workspaceRoot: '/Users/casey/src/arbor', provider: 'claudeAgent',
  sessionStatus: 'ready', sessionUpdatedAtMs: NOW - 10 * MINUTE, pendingApprovals: 0, pendingQuestions: 0, approvalSinceMs: null, latestApprovalAtMs: null,
  questionSeenAtMs: null, interactionMode: 'default', hasActionablePlan: false, turn: null, latestUserMessageAtMs: null, settled: false,
  t3SnoozedUntilMs: null, t3SnoozedAtMs: null, updatedAtMs: NOW - 10 * MINUTE, agentSessionId: null, arborSession: null,
  ...fields,
});
const running = (startedMinutesAgo: number) => ({ state: 'running', requestedAtMs: NOW - startedMinutesAgo * MINUTE - SECOND, startedAtMs: NOW - startedMinutesAgo * MINUTE, completedAtMs: null });
const completed = (minutesAgo: number) => ({ state: 'completed', requestedAtMs: NOW - (minutesAgo + 5) * MINUTE, startedAtMs: NOW - (minutesAgo + 5) * MINUTE, completedAtMs: NOW - minutesAgo * MINUTE });

const channel = (machine: string, threads: T3Thread[], fields: Partial<T3Channel> = {}): T3Channel => ({
  machine, channel: 'userdata', readAtMs: NOW - 3 * SECOND, serverRunning: true, readMode: 'readonly', skipped: null, threads, ...fields,
});

const transcript = (fields: Partial<SessionTranscript> = {}): SessionTranscript => ({
  machine: 'casey-mbp', agent: 'claude', home: '/Users/casey', agentHome: '', cwd: '/Users/casey/src/arbor', repoRoot: '/Users/casey/src/arbor',
  mainRepo: '/Users/casey/src/arbor', branch: 'fix/login-loop', commitHash: '', repositoryUrl: '', title: '', titleSource: '',
  pullRequests: [], linesAdded: null, linesRemoved: null, compactions: [], toolUsage: null, readAtMs: 0,
  ...fields,
});

const session = (id: string, fields: Partial<UsageSession> = {}): UsageSession => ({
  id, parentId: null, depth: 0, models: ['claude-opus-5-5'], providers: ['claude'], userAgent: 'claude-cli/2.1.280 (external, cli)',
  startedAtMs: NOW - HOUR, lastActiveAtMs: NOW - 20 * MINUTE, requests: 40, failures: 0, canceled: 0,
  inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  totalTokens: 0, estimatedCost: 0, pricedRequests: 0, peakContext: 0, compactions: 0,
  provider: 'claude', machine: 'casey-mbp', pool: '', apiKeyHash: '', active: false, hasOwnRequests: true, subagents: 0, threads: [],
  transcript: null,
  ...fields,
});

const wait = (fields: Partial<AttentionItem> = {}): AttentionItem => ({
  machine: 'casey-mbp', agent: 'claude', sessionId: CLAUDE_ID, kind: 'permission', sinceMs: NOW - 3 * MINUTE, session: null, ...fields,
});

const sources = (fields: Partial<FleetSources> = {}): FleetSources => ({
  nowMs: NOW, thisMachine: 'casey-mbp', t3Enabled: true, t3Found: true, t3: [], attention: { items: [], reporting: ['casey-mbp'] }, sessions: [], ...fields,
});
const board = (input: Partial<FleetSources>, options: { now?: number; snoozes?: FleetSnoozes; seen?: Record<string, number>; asked?: Record<string, number> } = {}) =>
  buildFleetBoard(sources(input), { now: NOW, ...options });
/** The one row a board has. */
const only = (built: FleetBoard) => {
  expect(built.rows).toHaveLength(1);
  return itemAt(built.rows, 0);
};
const t3Row = (fields: Partial<T3Thread>, channelFields: Partial<T3Channel> = {}, options = {}) =>
  only(board({ t3: [channel('casey-mbp', [thread(fields)], channelFields)] }, options));
const pick = (row: FleetSession) => ({ status: row.status, sinceMs: row.sinceMs, note: row.note });
const T3_KEY = 't3:casey-mbp:userdata:7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

describe('a T3 Code thread’s status, as T3 Code’s sidebar has it', () => {
  it('asks for approval ahead of a question, and both ahead of running', () => {
    expect(pick(t3Row({ pendingApprovals: 1, pendingQuestions: 1, approvalSinceMs: NOW - 3 * MINUTE, sessionStatus: 'running', turn: running(9) })))
      .toEqual({ status: 'approval', sinceMs: NOW - 3 * MINUTE, note: null });
    expect(pick(t3Row({ pendingQuestions: 2, questionSeenAtMs: NOW - 95 * SECOND, sessionStatus: 'running', turn: running(6) })))
      .toEqual({ status: 'question', sinceMs: NOW - 95 * SECOND, note: null });
  });

  it('is working while running or starting, since the turn started', () => {
    expect(pick(t3Row({ sessionStatus: 'running', turn: running(12) }))).toEqual({ status: 'working', sinceMs: NOW - 12 * MINUTE, note: null });
    expect(t3Row({ sessionStatus: 'starting', turn: null, sessionUpdatedAtMs: NOW - 20 * SECOND }).status).toBe('working');
    expect(t3Row({ sessionStatus: 'starting', turn: null, sessionUpdatedAtMs: NOW - 20 * SECOND }).sinceMs).toBe(NOW - 20 * SECOND);
  });

  it('is failed when its session errored, ahead of a finished turn', () => {
    expect(pick(t3Row({ sessionStatus: 'error', sessionUpdatedAtMs: NOW - 4 * MINUTE, turn: completed(5) })))
      .toEqual({ status: 'failed', sinceMs: NOW - 4 * MINUTE, note: null });
  });

  it('shows a plan ready to build as done, with its note', () => {
    expect(pick(t3Row({ interactionMode: 'plan', hasActionablePlan: true, turn: completed(12) })))
      .toEqual({ status: 'done', sinceMs: NOW - 12 * MINUTE, note: 'planReady' });
    // A plan that isn't actionable is just a finished turn.
    expect(t3Row({ interactionMode: 'plan', hasActionablePlan: false, turn: completed(12) }).note).toBeNull();
  });

  it('keeps a plan ready until it’s acted on, as T3 Code does: seen, hours old, or however its turn ended', () => {
    const plan = { interactionMode: 'plan', hasActionablePlan: true };
    const ready = (fields: Partial<T3Thread>, options = {}) => pick(t3Row({ ...plan, ...fields }, {}, options));
    expect(ready({ turn: completed(12) }, { seen: { [T3_KEY]: NOW - MINUTE } })).toEqual({ status: 'done', sinceMs: NOW - 12 * MINUTE, note: 'planReady' });
    const old = NOW - 2 * 24 * HOUR;
    expect(ready({ turn: completed(2 * 24 * 60), updatedAtMs: old, sessionUpdatedAtMs: old }).note).toBe('planReady');
    expect(ready({ turn: { ...completed(12), state: 'interrupted' } }).note).toBe('planReady');
    // Filed away, not started, still running, or asking something first: not a plan ready.
    expect(ready({ turn: completed(12), settled: true }).status).toBe('idle');
    expect(ready({ turn: { ...completed(12), startedAtMs: null } }).note).toBeNull();
    expect(ready({ turn: completed(12), sessionStatus: 'running' }).status).toBe('working');
    expect(ready({ turn: completed(12), pendingQuestions: 1 }).status).toBe('question');
    // T3 Code ranks it above a turn that's only finished.
    const built = board({ t3: [channel('casey-mbp', [
      thread({ threadId: 'finished', turn: completed(2) }),
      thread({ threadId: 'plan', ...plan, turn: completed(30) }),
    ])] });
    expect(itemAt(itemAt(built.machines, 0).projects, 0).rows.map((row) => row.t3ThreadId)).toEqual(['plan', 'finished']);
  });

  it('counts a message no turn has started yet as work for two minutes, not after, and not after a failed start', () => {
    const queued = { turn: completed(10), latestUserMessageAtMs: NOW - MINUTE };
    expect(pick(t3Row(queued))).toEqual({ status: 'working', sinceMs: NOW - MINUTE, note: 'queued' });
    // Another device's clock running ahead doesn't hold it there either.
    expect(t3Row({ ...queued, latestUserMessageAtMs: NOW + 90 * SECOND }).status).toBe('working');
    expect(t3Row({ ...queued, latestUserMessageAtMs: NOW - 3 * MINUTE }).status).toBe('done');
    expect(t3Row({ ...queued, sessionStatus: 'error' }).status).toBe('failed');
    // Once a turn picks the message up, the turn is newer, so it's that turn's state.
    expect(t3Row({ turn: completed(0.5), latestUserMessageAtMs: NOW - MINUTE }).status).toBe('done');
  });

  it('follows T3 Code’s order exactly', () => {
    expect(FLEET_STATUS_ORDER).toEqual(['approval', 'question', 'working', 'failed', 'done', 'idle']);
    expect(fleetStatus(thread({ turn: completed(12) }), { now: NOW, serverRunning: true, seenMs: NOW - 5 * MINUTE }).status).toBe('idle');
  });
});

describe('a T3 Code that has stopped', () => {
  it('shows its work as failed, since nothing can be running, and keeps what it asked for without counting it', () => {
    const built = board({
      t3: [channel('casey-mbp', [
        thread({ threadId: 'working', sessionStatus: 'running', turn: running(8), sessionUpdatedAtMs: NOW - 20 * MINUTE, updatedAtMs: NOW - 3 * MINUTE }),
        thread({ threadId: 'asking', pendingApprovals: 1, approvalSinceMs: NOW - 2 * MINUTE, sessionStatus: 'running' }),
      ], { serverRunning: false })],
    });
    const working = present(built.rows.find((row) => row.t3ThreadId === 'working'));
    // When it stopped isn't recorded, so it's timed by the last thing T3 Code wrote, not when the work began.
    expect(pick(working)).toEqual({ status: 'failed', sinceMs: NOW - 3 * MINUTE, note: 't3Stopped' });
    const asking = present(built.rows.find((row) => row.t3ThreadId === 'asking'));
    expect(pick(asking)).toEqual({ status: 'approval', sinceMs: NOW - 2 * MINUTE, note: 't3Stopped' });
    expect(asking.countsAsWaiting).toBe(false);
    expect(waitingCount(built)).toBe(0);
  });

  it('doesn’t count its agent’s own request for permission either, since T3 Code ran the agent', () => {
    const row = only(board({
      t3: [channel('casey-mbp', [thread({ agentSessionId: CLAUDE_ID, sessionStatus: 'running', turn: running(5) })], { serverRunning: false })],
      attention: { items: [wait()], reporting: ['casey-mbp'] },
    }));
    expect(pick(row)).toEqual({ status: 'approval', sinceMs: NOW - 3 * MINUTE, note: 't3Stopped' });
    expect(row.countsAsWaiting).toBe(false);
  });

  it('never lets its agent’s recent requests say it’s still working', () => {
    const linked = { id: CLAUDE_ID, lastActiveAtMs: NOW - MINUTE, lastRequestFailed: false };
    const stopped = (fields: Partial<T3Thread>, failed = false) => only(board({
      t3: [channel('casey-mbp', [thread({ agentSessionId: CLAUDE_ID, arborSession: linked, ...fields })], { serverRunning: false })],
      sessions: [{ session: session(CLAUDE_ID, { lastActiveAtMs: NOW - MINUTE }), lastRequestFailed: failed }],
    }));
    // Quit mid-turn, a minute after its last request.
    const crashed = stopped({ sessionStatus: 'running', turn: running(4) });
    expect([crashed.status, crashed.note]).toEqual(['failed', 't3Stopped']);
    expect(crashed.sources).toEqual(['t3', 'proxy']);
    // Quit right after a turn finished: done, as T3 Code recorded it.
    expect(pick(stopped({ turn: completed(0.5) }))).toEqual({ status: 'done', sinceMs: NOW - 30 * SECOND, note: null });
    expect(stopped({ turn: completed(0.5) }, true).status).toBe('done');
  });

  it('says so when another machine stops answering', () => {
    const quiet = only(board({ t3: [channel('cedar-02', [thread({ pendingApprovals: 1, approvalSinceMs: NOW - MINUTE })], { readAtMs: NOW - 3 * MINUTE })] }));
    expect(quiet.note).toBe('machineQuiet');
    expect(quiet.countsAsWaiting).toBe(false);
    // This Mac is read every few seconds whatever changed, so its read time isn't a sign.
    expect(only(board({ t3: [channel('casey-mbp', [thread({ pendingApprovals: 1 })], { readAtMs: NOW - 3 * MINUTE })] })).note).toBeNull();
    expect(t3Row({ turn: completed(3) }, { readMode: 'immutable', serverRunning: false }).note).toBeNull();
  });
});

describe('done and seen', () => {
  it('goes from done to idle once seen, when filed away in T3 Code, or after six hours', () => {
    expect(t3Row({ turn: completed(12) }).status).toBe('done');
    expect(t3Row({ turn: completed(12) }, {}, { seen: { [T3_KEY]: NOW - 5 * MINUTE } }).status).toBe('idle');
    // Seen before it finished, it's news again.
    expect(t3Row({ turn: completed(12) }, {}, { seen: { [T3_KEY]: NOW - 20 * MINUTE } }).status).toBe('done');
    expect(t3Row({ turn: completed(12), settled: true }).status).toBe('idle');
    expect(t3Row({ turn: completed(6 * 60 + 1), updatedAtMs: NOW - 30 * MINUTE }).status).toBe('idle');
  });

  it('leaves the board after six hours quiet, unless it’s asking for something or working', () => {
    const old = NOW - 7 * HOUR;
    expect(board({ t3: [channel('casey-mbp', [thread({ turn: completed(7 * 60), updatedAtMs: old, sessionUpdatedAtMs: old })])] }).rows).toEqual([]);
    expect(only(board({ t3: [channel('casey-mbp', [thread({ pendingApprovals: 1, updatedAtMs: old, sessionUpdatedAtMs: old })])] })).status).toBe('approval');
  });

  it('marks a reporter’s done turn seen too', () => {
    const done = { attention: { items: [wait({ kind: 'waiting', sinceMs: NOW - 8 * MINUTE })], reporting: ['casey-mbp'] } };
    expect(only(board(done)).status).toBe('done');
    const seen = only(board(done, { seen: { [`claude:${CLAUDE_ID}`]: NOW - MINUTE } }));
    expect(pick(seen)).toEqual({ status: 'idle', sinceMs: NOW - 8 * MINUTE, note: null });
  });
});

describe('merging the sources', () => {
  it('makes one row of a T3 Code thread, its reporter wait and its proxy session with the same id', () => {
    const proxied = session(CLAUDE_ID, { transcript: transcript({ title: 'Fix the login redirect loop' }), lastActiveAtMs: NOW - MINUTE });
    const row = only(board({
      t3: [channel('casey-mbp', [thread({
        pendingApprovals: 1, approvalSinceMs: NOW - 3 * MINUTE, sessionStatus: 'running', turn: running(9), agentSessionId: CLAUDE_ID,
        arborSession: { id: CLAUDE_ID, lastActiveAtMs: NOW - MINUTE, lastRequestFailed: false },
      })])],
      attention: { items: [wait({ session: proxied })], reporting: ['casey-mbp'] },
      sessions: [{ session: proxied, lastRequestFailed: false }],
    }));
    expect(row).toMatchObject({
      key: T3_KEY, client: 't3code', clientLabel: 'T3 Code', agent: 'claudeAgent', machine: 'casey-mbp', status: 'approval',
      countsAsWaiting: true, arborSessionId: CLAUDE_ID, agentSessionId: CLAUDE_ID, project: { key: '/Users/casey/src/arbor', name: 'arbor' },
      sources: ['t3', 'reporter', 'proxy', 'transcript'],
    });
    expect(fleetSessionName(row, t)).toBe('Fix the login redirect loop');
  });

  it('keeps sessions apart that share a project, a machine and a time but not an id', () => {
    const other = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
    const built = board({
      t3: [channel('casey-mbp', [thread({ pendingApprovals: 1, approvalSinceMs: NOW - 3 * MINUTE, agentSessionId: CLAUDE_ID })])],
      attention: { items: [wait({ sessionId: other, sinceMs: NOW - 3 * MINUTE })], reporting: ['casey-mbp'] },
      sessions: [{ session: session('9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a', { transcript: transcript(), lastActiveAtMs: NOW - 3 * MINUTE }), lastRequestFailed: false }],
    });
    expect(built.rows.map((row) => row.key).sort()).toEqual([
      `claude:${other}`,
      'claude:9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a',
      T3_KEY,
    ].sort());
  });

  it('compares ids as they’re stored, so ones that differ only in case stay apart', () => {
    const built = board({
      t3: [channel('casey-mbp', [thread({ agentSessionId: CLAUDE_ID.toUpperCase(), sessionStatus: 'running', turn: running(2) })])],
      attention: { items: [wait()], reporting: ['casey-mbp'] },
    });
    expect(built.rows).toHaveLength(2);
  });

  it('links an id two T3 Code threads claim with neither of them', () => {
    const proxied = session(CLAUDE_ID, { lastActiveAtMs: NOW - MINUTE });
    const linked = { id: CLAUDE_ID, lastActiveAtMs: NOW - MINUTE, lastRequestFailed: false };
    const built = board({
      t3: [
        channel('casey-mbp', [thread({ threadId: 'first', agentSessionId: CLAUDE_ID, arborSession: linked, turn: completed(30) })]),
        channel('casey-mbp', [thread({ threadId: 'imported', agentSessionId: CLAUDE_ID, arborSession: linked, turn: completed(40) })], { channel: 'custom' }),
      ],
      attention: { items: [wait()], reporting: ['casey-mbp'] },
      sessions: [{ session: proxied, lastRequestFailed: false }],
    });
    expect(built.rows).toHaveLength(3);
    for (const row of built.rows.filter((item) => item.t3ThreadId)) {
      expect(row.sources).toEqual(['t3']);
      expect(row.arborSessionId).toBeNull();
    }
    const own = present(built.rows.find((row) => !row.t3ThreadId));
    expect(own).toMatchObject({ key: `claude:${CLAUDE_ID}`, status: 'approval', sources: ['reporter', 'proxy'], arborSessionId: CLAUDE_ID });
  });

  it('links a Codex thread by its thread id, and lets a live T3 Code say it’s done', () => {
    const proxied = session(CODEX_ID, { provider: 'codex', userAgent: 'codex_cli_rs/0.156.0', lastActiveAtMs: NOW - 2 * MINUTE });
    const row = only(board({
      t3: [channel('casey-mbp', [thread({ provider: 'codex', agentSessionId: CODEX_ID, turn: completed(8) })])],
      attention: { items: [wait({ agent: 'codex', sessionId: CODEX_ID, kind: 'waiting', sinceMs: NOW - 8 * MINUTE })], reporting: ['casey-mbp'] },
      // Its latest request was within the last few minutes, but T3 Code knows the turn ended.
      sessions: [{ session: proxied, lastRequestFailed: true }],
    }));
    expect(row).toMatchObject({ agent: 'codex', status: 'done', arborSessionId: CODEX_ID, sources: ['t3', 'reporter', 'proxy'] });
  });

  it('lets a reporter’s request for permission outrank a live T3 Code’s working until T3 Code is read again', () => {
    const asked = (sinceMs: number) => only(board({
      t3: [channel('casey-mbp', [thread({ agentSessionId: CLAUDE_ID, sessionStatus: 'running', turn: running(5) })], { readAtMs: NOW - 3 * SECOND })],
      attention: { items: [wait({ sinceMs })], reporting: ['casey-mbp'] },
    }));
    const fresh = asked(NOW - SECOND);
    expect(pick(fresh)).toEqual({ status: 'approval', sinceMs: NOW - SECOND, note: null });
    expect(fresh.countsAsWaiting).toBe(true);
    // Approved in T3 Code and the tool is still running: its hook never says so, but T3 Code shows nothing pending.
    const answered = asked(NOW - 2 * MINUTE);
    expect(answered.status).toBe('working');
    expect(answered.countsAsWaiting).toBe(false);
    // A question the same way.
    expect(only(board({
      t3: [channel('casey-mbp', [thread({ agentSessionId: CLAUDE_ID, sessionStatus: 'running', turn: running(5) })])],
      attention: { items: [wait({ kind: 'question', sinceMs: NOW - MINUTE })], reporting: ['casey-mbp'] },
    })).status).toBe('working');
  });

  it('reads a CLI session’s requests: working while recent, failed once its own last request failed and it went quiet', () => {
    const cli = (fields: Partial<UsageSession>, lastRequestFailed = false) => only(board({ sessions: [{ session: session(CLAUDE_ID, fields), lastRequestFailed }] }));
    expect(pick(cli({ lastActiveAtMs: NOW - 2 * MINUTE }))).toEqual({ status: 'working', sinceMs: NOW - HOUR, note: null });
    expect(pick(cli({ lastActiveAtMs: NOW - 2 * MINUTE }, true))).toEqual({ status: 'failed', sinceMs: NOW - 2 * MINUTE, note: null });
    // Still retrying.
    expect(cli({ lastActiveAtMs: NOW - 20 * SECOND }, true).status).toBe('working');
    expect(cli({ lastActiveAtMs: NOW - 20 * MINUTE }).status).toBe('idle');
    expect(cli({ lastActiveAtMs: NOW - 20 * MINUTE }).client).toBe('claudeCode');
    // Its turn ended after its latest request, so it's done rather than working.
    const done = only(board({
      attention: { items: [wait({ kind: 'waiting', sinceMs: NOW - MINUTE })], reporting: ['casey-mbp'] },
      sessions: [{ session: session(CLAUDE_ID, { lastActiveAtMs: NOW - 2 * MINUTE }), lastRequestFailed: false }],
    }));
    expect(done.status).toBe('done');
  });

  it('names a T3 Code thread with no session by its provider, project and short id, never a title', () => {
    const row = t3Row({ provider: 'codex', turn: completed(5) });
    expect(fleetSessionName(row, t)).toBe('Codex in arbor · 7c1d2e3f');
    expect(fleetSessionName(t3Row({ workspaceRoot: null, provider: null }), t)).toBe('Agent · 7c1d2e3f');
    const reporterOnly = only(board({ attention: { items: [wait({ agent: 'codex', sessionId: CODEX_ID })], reporting: ['casey-mbp'] } }));
    expect(fleetSessionName(reporterOnly, t)).toBe('Codex 0199a1b2');
  });
});

describe('grouping', () => {
  const row = (machine: string, root: string | null, fields: Partial<T3Thread>) => thread({ workspaceRoot: root, ...fields });

  it('puts this Mac first, then machines by name, and projects by path with the most urgent first and Other last', () => {
    const built = board({
      t3: [
        channel('cedar-02', [row('cedar-02', '/home/casey/src/billing', { threadId: 'e1', sessionStatus: 'running', turn: running(3) })]),
        channel('casey-mbp', [
          row('casey-mbp', '/Users/casey/src/arbor', { threadId: 'a1', turn: completed(5) }),
          row('casey-mbp', '/Users/casey/src/arbor', { threadId: 'a2', sessionStatus: 'running', turn: running(3) }),
          row('casey-mbp', '/Users/casey/src/proxy', { threadId: 'p1', pendingApprovals: 1, approvalSinceMs: NOW - MINUTE }),
          // Same folder name, different path: a different project.
          row('casey-mbp', '/Users/casey/work/arbor', { threadId: 'w1', turn: completed(2) }),
          row('casey-mbp', null, { threadId: 'o1', pendingQuestions: 1, questionSeenAtMs: NOW - MINUTE }),
          row('casey-mbp', '/Users/casey/src/arbor', { threadId: 'i1', updatedAtMs: NOW - HOUR, sessionUpdatedAtMs: NOW - HOUR }),
        ]),
        channel('ci-01', [row('ci-01', '/home/ci/src/arbor', { threadId: 'c1', sessionStatus: 'error' })]),
      ],
    });
    expect(built.machines.map((group) => [group.machine, group.thisMachine])).toEqual([['casey-mbp', true], ['cedar-02', false], ['ci-01', false]]);
    const mac = itemAt(built.machines, 0);
    expect(mac.projects.map((project) => [project.key, project.rows.map((item) => item.t3ThreadId)])).toEqual([
      ['/Users/casey/src/proxy', ['p1']],
      ['/Users/casey/src/arbor', ['a2', 'a1']],
      ['/Users/casey/work/arbor', ['w1']],
      [null, ['o1']],
    ]);
    expect(mac.idle.map((item) => item.t3ThreadId)).toEqual(['i1']);
    expect(built.counts).toEqual({ approval: 1, question: 1, working: 2, failed: 1, done: 2, idle: 1 });
  });

  it('puts the longest waiting first and the latest failure first', () => {
    const built = board({
      t3: [channel('casey-mbp', [
        thread({ threadId: 'newer', pendingApprovals: 1, approvalSinceMs: NOW - MINUTE }),
        thread({ threadId: 'older', pendingApprovals: 1, approvalSinceMs: NOW - 5 * MINUTE }),
        thread({ threadId: 'failed-old', sessionStatus: 'error', sessionUpdatedAtMs: NOW - HOUR }),
        thread({ threadId: 'failed-new', sessionStatus: 'error', sessionUpdatedAtMs: NOW - MINUTE }),
      ])],
    });
    expect(itemAt(itemAt(built.machines, 0).projects, 0).rows.map((item) => item.t3ThreadId)).toEqual(['older', 'newer', 'failed-new', 'failed-old']);
  });

  it('lists a machine whose T3 Code wasn’t read for the note, even with nothing on it, and rows no machine claims last', () => {
    const groups = groupFleet([], 'casey-mbp', [{ machine: 'ci-01', channel: 'userdata', reason: 'noSqlite3', migration: null }]);
    expect(groups.map((group) => [group.machine, group.skipped.length])).toEqual([['ci-01', 1]]);
    const unknown = only(board({ sessions: [{ session: session(CLAUDE_ID, { machine: '', lastActiveAtMs: NOW - MINUTE }), lastRequestFailed: false }] }));
    const grouped = groupFleet([unknown, t3Row({ sessionStatus: 'running', turn: running(1) })], 'casey-mbp');
    expect(grouped.map((group) => group.machine)).toEqual(['casey-mbp', '']);
  });
});

describe('the board for one machine', () => {
  const built = () => board({
    t3: [
      channel('casey-mbp', [
        thread({ threadId: 'a1', workspaceRoot: '/Users/casey/src/arbor', pendingApprovals: 1, approvalSinceMs: NOW - MINUTE }),
        thread({ threadId: 'a2', workspaceRoot: '/Users/casey/src/arbor', sessionStatus: 'running', turn: running(3) }),
      ]),
      channel('cedar-02', [thread({ threadId: 'e1', workspaceRoot: '/home/casey/src/billing', sessionStatus: 'running', turn: running(2) })]),
    ],
  });

  it('keeps only that machine’s sessions, and counts only them', () => {
    const cedar = boardForMachine(built(), 'cedar-02');
    expect(cedar.machines.map((group) => group.machine)).toEqual(['cedar-02']);
    expect(cedar.rows.map((row) => row.t3ThreadId)).toEqual(['e1']);
    expect(cedar.counts).toEqual({ approval: 0, question: 0, working: 1, failed: 0, done: 0, idle: 0 });
    expect(fleetSummary(cedar, t)).toBe(t('fleet.summary.working', { count: 1 }));
  });

  it('is the whole board for every machine, and empty for a machine with nothing on it', () => {
    const all = built();
    expect(boardForMachine(all, '')).toBe(all);
    const none = boardForMachine(all, 'studio');
    expect(none.machines).toEqual([]);
    expect(none.rows).toEqual([]);
    expect(waitingCount(none)).toBe(0);
  });

  it('leaves a machine’s snoozed sessions out of its counts but keeps them folded', () => {
    const snoozed = board({ t3: [channel('casey-mbp', [thread({ threadId: 'a1', pendingApprovals: 1, approvalSinceMs: NOW - MINUTE })])] }, {
      snoozes: { 't3:casey-mbp:userdata:a1': { untilMs: NOW + HOUR, atMs: NOW - MINUTE } },
    });
    const mac = boardForMachine(snoozed, 'casey-mbp');
    expect(mac.snoozed.map((row) => row.t3ThreadId)).toEqual(['a1']);
    expect(mac.counts.approval).toBe(0);
  });
});

describe('what a skipped T3 Code database says', () => {
  it('names the version and what to update', () => {
    const say = (reason: 'noSqlite3' | 'migrationRange' | 'schema' | 'unreadable', migration: number | null) => {
      const { key, variables } = fleetSkipNote({ machine: 'casey-mbp', channel: 'userdata', reason, migration });
      return t(key, variables);
    };
    expect(say('migrationRange', 57)).toBe('T3 Code on casey-mbp moved to database version 57. Arbor reads up to 54; update Arbor to see its threads.');
    expect(say('migrationRange', 33)).toBe('T3 Code on casey-mbp is on database version 33, older than Arbor reads (34 to 54). Update T3 Code to see its threads.');
    expect(say('schema', 54)).toBe('T3 Code on casey-mbp has a database Arbor doesn’t recognize, so its threads aren’t shown.');
    expect(say('noSqlite3', null)).toBe('casey-mbp has T3 Code but no sqlite3, so its threads can’t be read. Install sqlite3 there to see them.');
    expect(say('unreadable', null)).toContain('couldn’t be read');
  });
});

// DST rules depend on the zone, so these pin theirs; the original zone is set back by name, since deleting TZ would
// leave dates in UTC.
const HOST_ZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
function inTimeZone(zone: string, run: () => void) {
  process.env.TZ = zone;
  try {
    run();
  } finally {
    process.env.TZ = HOST_ZONE;
  }
}
const local = (text: string) => new Date(text).getTime();
const shown = (ms: number) => {
  const date = new Date(ms);
  return `${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

describe('snoozing', () => {
  it('offers T3 Code’s presets: an hour, tonight while it’s more than an hour off, and tomorrow morning', () => {
    inTimeZone('Australia/Melbourne', () => {
      const options = (at: string) => snoozeOptions(local(at)).map((option) => `${option.id} ${shown(option.untilMs)}`);
      expect(options('2026-09-26T16:30:00')).toEqual(['hour 26 17:30', 'tonight 26 18:00', 'tomorrow 27 09:00']);
      expect(options('2026-09-26T17:30:00')).toEqual(['hour 26 18:30', 'tomorrow 27 09:00']);
      expect(options('2026-09-26T23:30:00')).toEqual(['hour 27 00:30', 'tomorrow 27 09:00']);
    });
  });

  it('wakes tomorrow at nine by the calendar across a daylight-saving change', () => {
    inTimeZone('Australia/Melbourne', () => {
      // Clocks go forward an hour at 2am on 4 October: 23 hours in that day.
      const now = local('2026-10-03T23:30:00');
      const tomorrow = present(snoozeOptions(now).find((option) => option.id === 'tomorrow'));
      expect(shown(tomorrow.untilMs)).toBe('4 09:00');
      expect(tomorrow.untilMs - now).toBe(8.5 * HOUR);
      // An hour is an hour, whatever the clock says.
      expect(itemAt(snoozeOptions(local('2026-10-04T01:30:00')), 0).untilMs - local('2026-10-04T01:30:00')).toBe(HOUR);
    });
    inTimeZone('America/New_York', () => {
      // Clocks go back an hour at 2am on 1 November: 25 hours in that day.
      const now = local('2026-10-31T23:30:00');
      const tomorrow = present(snoozeOptions(now).find((option) => option.id === 'tomorrow'));
      expect(shown(tomorrow.untilMs)).toBe('1 09:00');
      expect(tomorrow.untilMs - now).toBe(10.5 * HOUR);
    });
  });

  const asking = { t3: [channel('casey-mbp', [thread({ pendingApprovals: 1, approvalSinceMs: NOW - 5 * MINUTE, sessionStatus: 'running' })])] };

  it('leaves a snoozed row out of the count and the machines, until its time', () => {
    const snoozes = { [T3_KEY]: { untilMs: NOW + HOUR, atMs: NOW - MINUTE } };
    const built = board(asking, { snoozes });
    const row = only(built);
    expect(row).toMatchObject({ snoozedBy: 'arbor', snoozedUntilMs: NOW + HOUR, countsAsWaiting: false });
    expect(built.snoozed).toEqual([row]);
    expect(built.machines).toEqual([]);
    expect(built.counts.approval).toBe(0);
    expect(waitingCount(built)).toBe(0);
    expect(only(board(asking, { snoozes, now: NOW + HOUR + SECOND })).snoozedBy).toBeNull();
  });

  it('wakes early for a new request for approval, a failure or a done turn, and not for the one it was snoozed over', () => {
    const snoozes = { [T3_KEY]: { untilMs: NOW + HOUR, atMs: NOW - 10 * MINUTE } };
    expect(only(board(asking, { snoozes })).snoozedBy).toBeNull();
    const at = { status: 'approval' as const, sinceMs: NOW - 5 * MINUTE };
    expect(effectiveSnooze(at, { arbor: { untilMs: NOW + HOUR, atMs: NOW - MINUTE }, now: NOW })).toEqual({ untilMs: NOW + HOUR, by: 'arbor' });
    expect(effectiveSnooze({ status: 'failed', sinceMs: NOW - 30 * SECOND }, { arbor: { untilMs: NOW + HOUR, atMs: NOW - MINUTE }, now: NOW })).toBeNull();
    expect(effectiveSnooze({ status: 'done', sinceMs: NOW - 30 * SECOND }, { arbor: { untilMs: NOW + HOUR, atMs: NOW - MINUTE }, now: NOW })).toBeNull();
    // A second approval asked for after it wakes it, though the first still waits.
    const second = { status: 'approval' as const, sinceMs: NOW - 5 * MINUTE, raisedAtMs: NOW - 30 * SECOND };
    expect(effectiveSnooze(second, { arbor: { untilMs: NOW + HOUR, atMs: NOW - MINUTE }, now: NOW })).toBeNull();
    const pair = { t3: [channel('casey-mbp', [thread({ pendingApprovals: 2, approvalSinceMs: NOW - 5 * MINUTE, latestApprovalAtMs: NOW - 30 * SECOND })])] };
    const woken = only(board(pair, { snoozes: { [T3_KEY]: { untilMs: NOW + HOUR, atMs: NOW - MINUTE } } }));
    expect(woken).toMatchObject({ status: 'approval', sinceMs: NOW - 5 * MINUTE, snoozedBy: null, countsAsWaiting: true });
    const both = { t3: [channel('casey-mbp', [thread({ pendingApprovals: 2, approvalSinceMs: NOW - 5 * MINUTE, latestApprovalAtMs: NOW - 2 * MINUTE })])] };
    expect(only(board(both, { snoozes: { [T3_KEY]: { untilMs: NOW + HOUR, atMs: NOW - MINUTE } } })).snoozedBy).toBe('arbor');
    // Work going on doesn't wake it.
    expect(effectiveSnooze({ status: 'working', sinceMs: NOW - 30 * SECOND }, { arbor: { untilMs: NOW + HOUR, atMs: NOW - MINUTE }, now: NOW })?.by).toBe('arbor');
  });

  it('keeps a question snoozed across a restart, when the backend has only just seen it', () => {
    const snoozes = { [T3_KEY]: { untilMs: NOW + HOUR, atMs: NOW - 10 * MINUTE } };
    // Arbor restarted, so the backend first saw the question just now; it was asking before the snooze.
    const restarted = { t3: [channel('casey-mbp', [thread({ pendingQuestions: 1, questionSeenAtMs: NOW - 3 * SECOND })])] };
    expect(only(board(restarted, { snoozes })).snoozedBy).toBeNull();
    const row = only(board(restarted, { snoozes, asked: { [T3_KEY]: NOW - 20 * MINUTE } }));
    expect(row).toMatchObject({ status: 'question', sinceMs: NOW - 20 * MINUTE, snoozedBy: 'arbor', countsAsWaiting: false });
  });

  it('remembers when each question was first seen, and forgets it once the thread stops asking', () => {
    const asking = (questionSeenAtMs: number | null, pendingQuestions = 1) =>
      sources({ t3: [channel('casey-mbp', [thread({ pendingQuestions, questionSeenAtMs }), thread({ threadId: 'other' })])] });
    const first = rememberQuestions({}, asking(NOW - MINUTE));
    expect(first).toEqual({ [T3_KEY]: NOW - MINUTE });
    // A later time from a restarted backend doesn't move it, and nothing changed comes back as it was.
    expect(rememberQuestions(first, asking(NOW))).toBe(first);
    expect(rememberQuestions(first, asking(NOW - 5 * MINUTE))).toEqual({ [T3_KEY]: NOW - 5 * MINUTE });
    expect(rememberQuestions({}, asking(null))).toEqual({ [T3_KEY]: NOW });
    expect(rememberQuestions(first, asking(null, 0))).toEqual({});
    // A thread missing from the read (T3 Code threads off, or out of the window) keeps it.
    expect(rememberQuestions(first, sources())).toBe(first);
  });

  it('finds what each Arbor session needs you for, as the board has it, and drops it once snoozed', () => {
    const asking = { t3: [channel('casey-mbp', [thread({
      agentSessionId: CLAUDE_ID, pendingApprovals: 1, approvalSinceMs: NOW - 3 * MINUTE, sessionStatus: 'running',
      arborSession: { id: CLAUDE_ID, lastActiveAtMs: NOW - MINUTE, lastRequestFailed: false },
    }), thread({ threadId: 'quiet', turn: completed(30) })])] };
    const found = needsYouBySession(board(asking));
    expect([...found.keys()]).toEqual([CLAUDE_ID]);
    expect(found.get(CLAUDE_ID)?.status).toBe('approval');
    expect(needsYouBySession(board(asking, { snoozes: { [T3_KEY]: { untilMs: NOW + HOUR, atMs: NOW - MINUTE } } })).size).toBe(0);
  });

  it('silences the alerts only for a wait that landed on a snoozed row', () => {
    const merged = { t3: [channel('casey-mbp', [thread({ agentSessionId: CLAUDE_ID, pendingApprovals: 1, approvalSinceMs: NOW - 5 * MINUTE })])], attention: { items: [wait()], reporting: ['casey-mbp'] } };
    const snoozed = { [T3_KEY]: { untilMs: NOW + HOUR, atMs: NOW - MINUTE } };
    expect(snoozedWaitIds(board(merged, { snoozes: snoozed }))).toEqual(new Set([CLAUDE_ID]));
    expect(snoozedWaitIds(board(merged))).toEqual(new Set());
    expect(snoozedWaitIds(null)).toEqual(new Set());

    // Two threads claim the same id, so its wait gets a row of its own; snoozing one thread leaves that row's alerts.
    const shared = board({
      t3: [channel('casey-mbp', [
        thread({ threadId: 'first', agentSessionId: CLAUDE_ID, turn: completed(30) }),
        thread({ threadId: 'imported', agentSessionId: CLAUDE_ID, turn: completed(40) }),
      ])],
      attention: { items: [wait()], reporting: ['casey-mbp'] },
    }, { snoozes: { 't3:casey-mbp:userdata:first': { untilMs: NOW + HOUR, atMs: NOW - MINUTE } } });
    expect(shared.snoozed.map((row) => row.t3ThreadId)).toEqual(['first']);
    expect(present(shared.rows.find((row) => row.key === `claude:${CLAUDE_ID}`)).countsAsWaiting).toBe(true);
    expect(snoozedWaitIds(shared).has(CLAUDE_ID)).toBe(false);
  });

  it('honors T3 Code’s own snooze by T3 Code’s rule', () => {
    const snoozed = { t3SnoozedUntilMs: NOW + 3 * HOUR, t3SnoozedAtMs: NOW - 5 * MINUTE };
    expect(t3Row({ ...snoozed, turn: completed(8) })).toMatchObject({ snoozedBy: 't3', snoozedUntilMs: NOW + 3 * HOUR });
    // A turn done since, a fresh failure or anything asking raises its hand.
    expect(t3Row({ ...snoozed, turn: completed(2) }).snoozedBy).toBeNull();
    expect(t3Row({ ...snoozed, sessionStatus: 'error', sessionUpdatedAtMs: NOW - MINUTE }).snoozedBy).toBeNull();
    expect(t3Row({ ...snoozed, sessionStatus: 'error', sessionUpdatedAtMs: NOW - 9 * MINUTE }).snoozedBy).toBe('t3');
    expect(t3Row({ ...snoozed, pendingQuestions: 1, questionSeenAtMs: NOW - 9 * MINUTE }).snoozedBy).toBeNull();
    expect(t3Row({ ...snoozed, t3SnoozedUntilMs: NOW - MINUTE, turn: completed(8) }).snoozedBy).toBeNull();
  });
});

describe('the working count each pool goes by', () => {
  it('counts each machine’s working sessions as the sidebar does, leaving out snoozed ones and the rest', () => {
    const built = board({
      t3: [
        channel('cedar-02', [
          thread({ threadId: 'a', sessionStatus: 'running', turn: running(3) }),
          thread({ threadId: 'b', sessionStatus: 'running', turn: running(1) }),
          thread({ threadId: 'snoozed', sessionStatus: 'running', turn: running(2) }),
          thread({ threadId: 'done', turn: completed(3) }),
        ]),
        channel('casey-mbp', [thread({ threadId: 'c', sessionStatus: 'running', turn: running(4) })]),
      ],
    }, { snoozes: { 't3:cedar-02:userdata:snoozed': { untilMs: NOW + HOUR, atMs: NOW - MINUTE } } });
    // In name order, so the same counts are never sent twice.
    expect(Object.entries(workingByMachine(built))).toEqual([['casey-mbp', 1], ['cedar-02', 2]]);
    expect(workingByMachine({ rows: [] })).toEqual({});
  });
});

describe('the waiting count', () => {
  it('counts approval and questions, not snoozed ones, not stale ones, and nothing else', () => {
    const built = board({
      t3: [
        channel('casey-mbp', [
          thread({ threadId: 'approval', pendingApprovals: 1, approvalSinceMs: NOW - MINUTE }),
          thread({ threadId: 'question', pendingQuestions: 1, questionSeenAtMs: NOW - MINUTE }),
          thread({ threadId: 'snoozed', pendingApprovals: 1, approvalSinceMs: NOW - 5 * MINUTE }),
          thread({ threadId: 'working', sessionStatus: 'running', turn: running(3) }),
          thread({ threadId: 'done', turn: completed(3) }),
        ]),
        channel('cedar-02', [thread({ threadId: 'quiet', pendingApprovals: 1 })], { readAtMs: NOW - 5 * MINUTE }),
        channel('ci-01', [thread({ threadId: 'stopped', pendingQuestions: 1 })], { serverRunning: false }),
      ],
      attention: { items: [wait({ sessionId: CODEX_ID, agent: 'codex', kind: 'question' })], reporting: ['casey-mbp'] },
    }, { snoozes: { 't3:casey-mbp:userdata:snoozed': { untilMs: NOW + HOUR, atMs: NOW - MINUTE } } });
    expect(waitingCount(built)).toBe(3);
    // The line above the board names every row asking for something: the ones that can't be answered apart.
    expect(fleetSummary(built, t)).toBe('3 waiting on you · 2 can’t be answered now · 1 working · 1 done');
    expect(fleetSummary(built, t, { working: false })).toBe('3 waiting on you · 2 can’t be answered now · 1 done');
  });

  it('never says nothing is waiting above a request that can’t be answered', () => {
    const stopped = board({ t3: [channel('casey-mbp', [thread({ pendingApprovals: 1, approvalSinceMs: NOW - MINUTE })], { serverRunning: false })] });
    expect(fleetSummary(stopped, t)).toBe('1 can’t be answered now');
    expect(fleetSummary(board({}), t)).toBe('Nothing is waiting on you or working.');
  });

  it('gives Home the rows that need you, snoozed ones left out, at most four, and how many more there are', () => {
    const threads = Array.from({ length: 9 }, (_, index) => thread({ threadId: `t${index}`, pendingApprovals: 1, approvalSinceMs: NOW - index * MINUTE }));
    const built = board({ t3: [channel('casey-mbp', [...threads, thread({ threadId: 'working', sessionStatus: 'running', turn: running(1) })])] });
    const { rows, more } = needsYouRows(built, NOW);
    expect(rows.map((row) => row.t3ThreadId)).toEqual(['t8', 't7', 't6', 't5']);
    expect(more).toBe(5);
    const done = board({ t3: [channel('casey-mbp', [thread({ turn: completed(3) })])] }, { snoozes: { [T3_KEY]: { untilMs: NOW + HOUR, atMs: NOW } } });
    expect(needsYouRows(done, NOW)).toEqual({ rows: [], more: 0 });
  });

  it('keeps Home’s list to the last two hours, counting the older ones among the board’s others', () => {
    const built = board({ t3: [channel('casey-mbp', [
      thread({ threadId: 'asking', pendingApprovals: 1, approvalSinceMs: NOW - 3 * HOUR }),
      thread({ threadId: 'finished', turn: completed(119) }),
      thread({ threadId: 'yesterday', turn: completed(24 * 60) }),
    ])] });
    const { rows, more } = needsYouRows(built, NOW);
    expect(rows.map((row) => row.t3ThreadId)).toEqual(['finished']);
    // The request from three hours ago; a turn finished yesterday is already idle on the board, so isn't one of them.
    expect(more).toBe(1);
    // The same board later on: what was recent has aged out too.
    expect(needsYouRows(built, NOW + HOUR)).toEqual({ rows: [], more: 2 });
  });

  it('names what Home’s list shows, and nothing it leaves out', () => {
    const built = board({ t3: [channel('casey-mbp', [
      thread({ threadId: 'asking', pendingApprovals: 1, approvalSinceMs: NOW - MINUTE }),
      thread({ threadId: 'finished', turn: completed(10) }),
      thread({ threadId: 'yesterday', turn: completed(24 * 60) }),
    ])] });
    expect(needsYouSummary(needsYouRows(built, NOW).rows, t)).toBe('1 waiting on you · 1 done');
  });
});

/** A stand-in for localStorage. */
const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
};

describe('the snooze and seen stores', () => {
  const storage = memoryStorage();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  });
  afterAll(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('keep ids and times only, and forget old ones', () => {
    const now = Date.now();
    snoozeFleetSession(T3_KEY, now + HOUR, now);
    markFleetSeen(`claude:${CLAUDE_ID}`, now);
    expect(JSON.parse(storage.values.get('arbor.fleet-snoozes.v1') ?? '')).toEqual({ [T3_KEY]: { untilMs: now + HOUR, atMs: now } });
    expect(JSON.parse(storage.values.get('arbor.fleet-seen.v1') ?? '')).toEqual({ [`claude:${CLAUDE_ID}`]: now });
    unsnoozeFleetSession(T3_KEY);
    expect(JSON.parse(storage.values.get('arbor.fleet-snoozes.v1') ?? '')).toEqual({});
    // Each read keeps when a question was first seen, and nothing more.
    setFleetSources(sources({ nowMs: now, t3: [channel('casey-mbp', [thread({ pendingQuestions: 1, questionSeenAtMs: now - MINUTE })])] }));
    expect(JSON.parse(storage.values.get('arbor.fleet-asked.v1') ?? '')).toEqual({ [T3_KEY]: now - MINUTE });
    setFleetSources(sources({ nowMs: now, t3: [channel('casey-mbp', [thread()])] }));
    expect(JSON.parse(storage.values.get('arbor.fleet-asked.v1') ?? '')).toEqual({});
    setFleetSources(sources());

    expect(pruneSnoozes({
      kept: { untilMs: NOW - HOUR, atMs: NOW - 2 * HOUR },
      old: { untilMs: NOW - 25 * HOUR, atMs: NOW - 26 * HOUR },
      broken: { untilMs: 'soon', atMs: NOW },
      title: 'not a snooze',
    }, NOW)).toEqual({ kept: { untilMs: NOW - HOUR, atMs: NOW - 2 * HOUR } });
    expect(pruneSeen({ recent: NOW - 6 * 24 * HOUR, old: NOW - 8 * 24 * HOUR, broken: 'yesterday' }, NOW)).toEqual({ recent: NOW - 6 * 24 * HOUR });
    expect(pruneSnoozes('not json', NOW)).toEqual({});
    expect(pruneSeen([1, 2], NOW)).toEqual({});
  });
});

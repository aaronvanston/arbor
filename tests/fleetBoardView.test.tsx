import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NeedsYouSection } from '../src/components/AgentAttention';
import { FleetBoardView, FleetRow } from '../src/components/FleetBoard';
import { I18nProvider } from '../src/i18n';
import { buildFleetBoard, setFleetSources, type FleetBoard } from '../src/services/fleetBoard';
import { itemAt } from './support/items';
import type { AttentionItem, FleetSources, T3Channel, T3Thread } from '../src/native/types';

const MINUTE = 60_000;
const NOW = Date.now();

const thread = (fields: Partial<T3Thread> = {}): T3Thread => ({
  threadId: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', projectId: 'b1c2d3e4', workspaceRoot: '/Users/cam/src/arbor', provider: 'claudeAgent',
  sessionStatus: 'ready', sessionUpdatedAtMs: NOW - 10 * MINUTE, pendingApprovals: 0, pendingQuestions: 0, approvalSinceMs: null, latestApprovalAtMs: null,
  questionSeenAtMs: null, interactionMode: 'default', hasActionablePlan: false, turn: null, latestUserMessageAtMs: null, settled: false,
  t3SnoozedUntilMs: null, t3SnoozedAtMs: null, updatedAtMs: NOW - 10 * MINUTE, agentSessionId: null, arborSession: null, title: null,
  ...fields,
});
const channel = (machine: string, threads: T3Thread[], fields: Partial<T3Channel> = {}): T3Channel => ({
  machine, channel: 'userdata', readAtMs: NOW, serverRunning: true, readMode: 'readonly', skipped: null, threads, ...fields,
});
const CODEX = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const wait = (fields: Partial<AttentionItem> = {}): AttentionItem => ({
  machine: 'cedar-02', agent: 'codex', sessionId: CODEX, kind: 'waiting', sinceMs: NOW - 41 * MINUTE, session: null, ...fields,
});
const sources = (fields: Partial<FleetSources> = {}): FleetSources => ({
  nowMs: NOW, thisMachine: 'cam-mbp', t3Enabled: true, t3Found: true, t3: [], attention: { items: [], reporting: [] }, sessions: [], ...fields,
});
const busy = sources({
  t3: [
    channel('cam-mbp', [
      thread({ threadId: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', pendingApprovals: 1, approvalSinceMs: NOW - 3 * MINUTE - 5_000, sessionStatus: 'running' }),
      thread({ threadId: '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d', workspaceRoot: '/Users/cam/src/proxy', provider: 'codex', sessionStatus: 'running', turn: { state: 'running', requestedAtMs: NOW - 12 * MINUTE, startedAtMs: NOW - 12 * MINUTE, completedAtMs: null } }),
      thread({ threadId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a', workspaceRoot: null, updatedAtMs: NOW - 2 * 60 * MINUTE, sessionUpdatedAtMs: NOW - 2 * 60 * MINUTE }),
    ]),
    channel('ci-01', [], { skipped: { reason: 'migrationRange', migration: 57 } }),
  ],
  attention: { items: [wait()], reporting: ['cedar-02'] },
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const view = (board: FleetBoard | null, failure = '', fields: { onRetry?: () => void } = {}) => text(renderToStaticMarkup(
  <I18nProvider>
    <FleetBoardView board={board} failure={failure} now={NOW} onRetry={fields.onRetry} onOpenSession={() => {}} onTurnOnT3={() => {}} />
  </I18nProvider>,
));

afterEach(() => setFleetSources(sources()));

describe('the live board', () => {
  test('says what needs you, then each machine with its sessions by project, the notes and the idle ones folded', () => {
    const html = view(buildFleetBoard(busy, { now: NOW }));
    expect(html).toContain('1 waiting on you · 1 working · 1 done');
    expect(html).toContain('cam-mbp This Mac arbor Claude in arbor · 7c1d2e3f T3 Code · waiting 3m Needs approval');
    expect(html).toContain('proxy Codex in proxy · 2a3b4c5d T3 Code · working 12m Working');
    expect(html).toContain('1 idle session');
    expect(html).toContain('T3 Code on ci-01 moved to database version 57. Arbor reads up to 54; update Arbor to see its threads.');
    // A session known only from its reporter goes by its client and short id.
    expect(html).toContain('cedar-02 Other Codex 0199a1b2 done 41m ago Done');
    // Machines are in order: this Mac, then by name.
    expect(html.indexOf('cam-mbp')).toBeLessThan(html.indexOf('cedar-02'));
    expect(html.indexOf('cedar-02')).toBeLessThan(html.indexOf('ci-01'));
  });

  test('marks what may not be what it seems', () => {
    const stopped = view(buildFleetBoard(sources({ t3: [channel('cam-mbp', [
      thread({ sessionStatus: 'running', turn: { state: 'running', requestedAtMs: NOW - 5 * MINUTE, startedAtMs: NOW - 5 * MINUTE, completedAtMs: null } }),
    ], { serverRunning: false })] }), { now: NOW }));
    // T3 Code didn't record when it stopped, so it's the turn's start, the last thing it did.
    expect(stopped).toContain('T3 Code · last active 5m ago · T3 Code stopped Failed');
    expect(stopped).toContain('1 failed cam-mbp');
    // A request T3 Code can't take while it's stopped is still named above it.
    const asking = view(buildFleetBoard(sources({ t3: [channel('cam-mbp', [thread({ pendingApprovals: 1, approvalSinceMs: NOW - MINUTE })], { serverRunning: false })] }), { now: NOW }));
    expect(asking).toContain('1 can’t be answered now cam-mbp');
    // It doesn't pulse, as one waiting on you does.
    const pulses = (fields: Partial<T3Channel>) => renderToStaticMarkup(<I18nProvider><FleetRow row={itemAt(buildFleetBoard(sources({
      t3: [channel('cam-mbp', [thread({ pendingApprovals: 1, approvalSinceMs: NOW - MINUTE })], fields)],
    }), { now: NOW }).rows, 0)} now={NOW} /></I18nProvider>).includes('animate-status-pulse');
    expect(pulses({ serverRunning: false })).toBe(false);
    expect(pulses({})).toBe(true);
    expect(view(buildFleetBoard(sources({ t3: [channel('cam-mbp', [thread()])] }), { now: NOW }))).toContain('Nothing is waiting on you or working.');
  });

  test('shows an empty board, a failed read with Retry, and T3 Code threads turned off', () => {
    expect(view(buildFleetBoard(sources(), { now: NOW }))).toContain('Nothing on the board');
    expect(view(null, 'database is locked', { onRetry: () => {} })).toBe('Couldn’t read the board: database is locked Retry');
    expect(view(buildFleetBoard(busy, { now: NOW }), 'database is locked')).toContain('Couldn’t refresh the board, so it shows the last read: database is locked');
    expect(view(buildFleetBoard(sources({ t3Enabled: false }), { now: NOW }))).toContain('T3 Code threads are off');
    expect(view(buildFleetBoard(sources({ t3Enabled: false, t3Found: false }), { now: NOW }))).not.toContain('T3 Code');
  });

  test('folds snoozed sessions at the end, saying until when', () => {
    const board = buildFleetBoard(busy, {
      now: NOW,
      snoozes: { 't3:cam-mbp:userdata:7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f': { untilMs: NOW + 60 * MINUTE, atMs: NOW - MINUTE } },
    });
    const html = view(board);
    // Out of the count, and out of its machine.
    expect(html).toContain('1 working · 1 done');
    expect(html).not.toContain('waiting on you');
    expect(html).toContain('Snoozed 1 snoozed session');
    const row = text(renderToStaticMarkup(<I18nProvider><FleetRow row={itemAt(board.snoozed, 0)} now={NOW} place /></I18nProvider>));
    expect(row).toMatch(/^Claude in arbor · 7c1d2e3f T3 Code · arbor · cam-mbp · snoozed until .+ Needs approval$/);
  });
});

describe('Home’s Needs you card', () => {
  test('lists what needs you from the board, with where each is, and nothing when nothing does', () => {
    setFleetSources(busy);
    const html = text(renderToStaticMarkup(<I18nProvider><NeedsYouSection onNavigate={() => {}} /></I18nProvider>));
    // Its line counts only what it lists: working sessions are the board's.
    expect(html).toContain('Needs you 1 waiting on you · 1 done · from the last 2 hours Open board');
    expect(html).toContain('Claude in arbor · 7c1d2e3f T3 Code · arbor · cam-mbp · waiting 3m Needs approval');
    expect(html).toContain('Codex 0199a1b2 cedar-02 · done 41m ago Done');
    // Working and idle sessions are the board's, not Home's.
    expect(html).not.toContain('Codex in proxy');

    setFleetSources(sources({ t3: [channel('cam-mbp', [thread({ sessionStatus: 'running' })])] }));
    expect(renderToStaticMarkup(<I18nProvider><NeedsYouSection /></I18nProvider>)).toBe('');
  });

  test('opens every row: a session Arbor has a page for opens it, any other opens the board at its row', () => {
    setFleetSources(busy);
    const html = renderToStaticMarkup(<I18nProvider><NeedsYouSection onNavigate={() => {}} /></I18nProvider>);
    const rows = html.split('data-fleet-row=').slice(1);
    expect(rows).toHaveLength(2);
    // Neither has an Arbor session: a T3 Code thread and an agent that only reports.
    for (const row of rows) expect(row).toMatch(/^"[^"]+"><button type="button"/);
    // Without a way to navigate, there's nothing to open.
    const still = renderToStaticMarkup(<I18nProvider><NeedsYouSection /></I18nProvider>);
    expect(still).not.toContain('<button type="button" class="flex min-h-14');
  });

  test('says how many more the board has when it lists only some', () => {
    const asking = Array.from({ length: 8 }, (_, index) => thread({ threadId: `thread-${index}`, pendingApprovals: 1, approvalSinceMs: NOW - index * MINUTE }));
    setFleetSources(sources({ t3: [channel('cam-mbp', asking)] }));
    const html = text(renderToStaticMarkup(<I18nProvider><NeedsYouSection onNavigate={() => {}} /></I18nProvider>));
    expect(html).toContain('Needs you 4 waiting on you · from the last 2 hours Open board');
    expect(html.match(/Needs approval/g)).toHaveLength(4);
    expect(html).toEndWith('4 more on the board');
  });
});

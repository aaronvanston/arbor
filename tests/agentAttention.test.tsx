import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, translate } from '../src/i18n';
import { MachineReporterRow, reporterHomesText, reporterPlanText } from '../src/pages/MachineReporter';
import { attentionNotifications, nextAttentionAlerts } from '../src/services/agentAttention';
import type {
  AttentionItem,
  MachineHealth,
  ReporterFile,
  ReporterStatus,
  SessionTranscript,
  UsageSession,
} from '../src/native/types';

const SECOND = 1_000;
const MINUTE = 60_000;
const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);
const both = { permission: true, waiting: true };

const transcript = (fields: Partial<SessionTranscript>): SessionTranscript => ({
  machine: 'cam-mbp', agent: 'claude', home: '/Users/cam', agentHome: '', cwd: '/Users/cam/src/arbor', repoRoot: '/Users/cam/src/arbor',
  mainRepo: '/Users/cam/src/arbor', branch: 'fix/login-loop', commitHash: '', repositoryUrl: '', title: '', titleSource: '',
  pullRequests: [], linesAdded: null, linesRemoved: null, compactions: [], toolUsage: null, readAtMs: 0,
  ...fields,
});

const session = (id: string, fields: Partial<UsageSession> = {}): UsageSession => ({
  id, parentId: null, depth: 0, models: ['claude-opus-5-5'], providers: ['claude'], userAgent: 'claude-cli/2.1.280 (external, cli)',
  startedAtMs: 0, lastActiveAtMs: 0, requests: 40, failures: 0, canceled: 0,
  inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  totalTokens: 0, estimatedCost: 12.4, pricedRequests: 40, peakContext: 0, compactions: 0,
  provider: 'claude', machine: 'cam-mbp', pool: '', apiKeyHash: '', active: true, hasOwnRequests: true, subagents: 0, threads: [],
  transcript: null,
  ...fields,
});

const wait = (fields: Partial<AttentionItem> = {}): AttentionItem => ({
  machine: 'cam-mbp', agent: 'claude', sessionId: 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7', kind: 'permission', sinceMs: 0,
  session: session('a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7', { transcript: transcript({ title: 'Fix the login redirect loop' }) }),
  ...fields,
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('needs-you alerts', () => {
  test('a wait is alerted once, after long enough that nobody at the keyboard answered it', () => {
    const permission = wait({ sinceMs: 0 });
    let next = nextAttentionAlerts({}, [permission], 29 * SECOND, both);
    expect(next.due).toEqual([]);
    expect(next.changed).toBe(false);
    next = nextAttentionAlerts(next.state, [permission], 31 * SECOND, both);
    expect(next.due).toEqual([permission]);
    expect(next.changed).toBe(true);
    next = nextAttentionAlerts(next.state, [permission], 5 * MINUTE, both);
    expect(next.due).toEqual([]);

    // The same session waiting again is a new wait.
    const again = wait({ kind: 'waiting', sinceMs: 6 * MINUTE });
    expect(nextAttentionAlerts(next.state, [again], 6 * MINUTE + 59 * SECOND, both).due).toEqual([]);
    expect(nextAttentionAlerts(next.state, [again], 7 * MINUTE + SECOND, both).due).toEqual([again]);
  });

  test('old news and switched-off kinds are remembered without an alert', () => {
    const late = wait({ sinceMs: 0 });
    const first = nextAttentionAlerts({}, [late], 20 * MINUTE, both);
    expect(first.due).toEqual([]);
    expect(Object.keys(first.state)).toHaveLength(1);

    const done = wait({ kind: 'waiting', sinceMs: 0 });
    const off = nextAttentionAlerts({}, [done], 2 * MINUTE, { permission: true, waiting: false });
    expect(off.due).toEqual([]);
    // Switching it on later doesn't bring that one back.
    expect(nextAttentionAlerts(off.state, [done], 3 * MINUTE, both).due).toEqual([]);
    // Waits alerted long ago are forgotten.
    expect(nextAttentionAlerts(off.state, [], 13 * 60 * MINUTE, both).state).toEqual({});
  });

  test('alerts name the session and the machine, and pile up into one past three', () => {
    const codex = wait({
      agent: 'codex', kind: 'waiting', sessionId: '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', machine: 'cedar-02',
      session: session('0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', { provider: 'codex', userAgent: 'codex_cli_rs/0.156.0', transcript: transcript({ branch: 'main', repoRoot: '/home/cam/src/api', mainRepo: '/home/cam/src/api', cwd: '/home/cam/src/api' }) }),
    });
    const unknown = wait({ kind: 'question', sessionId: 'e5d4c3b2-a190-4f8e-9d7c-6b5a4f3e2d1c', session: null });
    expect(attentionNotifications([wait(), codex, unknown], t)).toEqual([
      {
        title: 'Claude Code needs permission', body: 'Fix the login redirect loop on cam-mbp', kind: 'agentPermission', urgent: true,
        subject: { session: 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7', machine: 'cam-mbp' },
      },
      {
        title: 'Codex is waiting for you', body: 'api · main on cedar-02', kind: 'agentWaiting', urgent: false,
        subject: { session: '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', machine: 'cedar-02' },
      },
      // Its requests didn't come through Arbor, so there's no session to open.
      { title: 'Claude Code has a question', body: 'Claude Code e5d4c3b2 on cam-mbp', kind: 'agentPermission', urgent: true, subject: { machine: 'cam-mbp' } },
    ]);
    const many = attentionNotifications([codex, codex, codex, codex], t);
    expect(many).toHaveLength(1);
    expect(many[0]).toMatchObject({ title: '4 sessions are waiting on you', kind: 'agentWaiting', urgent: false });
    expect(many[0]!.body.split('\n')).toHaveLength(4);
    expect(attentionNotifications([], t)).toEqual([]);
  });
});

describe('the reporter on a machine', () => {
  const file = (fields: Partial<ReporterFile>): ReporterFile => ({
    agent: 'claude', home: '~/.claude', path: '~/.claude/settings.json', change: 'edit', chained: false, written: false, error: null,
    ...fields,
  });

  test('the plan says what each file gets', () => {
    expect(reporterPlanText(file({}), true, t)).toBe('Adds hooks for 4 events');
    expect(reporterPlanText(file({ change: 'create' }), true, t)).toBe('Created, with hooks for 4 events');
    expect(reporterPlanText(file({ agent: 'codex', chained: true }), true, t)).toBe('Sets notify, and keeps running the command set now');
    expect(reporterPlanText(file({ agent: 'codex' }), true, t)).toBe('Sets notify');
    expect(reporterPlanText(file({ agent: 'codex', chained: true }), false, t)).toBe('Puts back the notify command set before');
    expect(reporterPlanText(file({ agent: 'codex' }), false, t)).toBe('Takes notify out');
    expect(reporterPlanText(file({}), false, t)).toBe('Takes the hooks out');
    expect(reporterPlanText(file({ change: 'none' }), true, t)).toBe('Already set up');
    expect(reporterPlanText(file({ change: 'none' }), false, t)).toBe('Nothing to take out');
    expect(reporterPlanText(file({ change: 'none', error: 'settings.json isn’t valid JSON' }), true, t)).toBe('Left alone: settings.json isn’t valid JSON');
  });

  const machine = (reporter: ReporterStatus): MachineHealth => ({
    machine: 'cam-mbp', host: { machine: 'cam-mbp', endpoint: 'localhost', port: 22, enabled: true, source: '' }, local: true,
    status: 'healthy', score: 96, reason: null, facts: null, latest: null, points: [], error: null, lastOkAt: 0, lastAttemptAt: 0,
    pingTarget: null, path: null,
    agents: { claude: null, codex: null, checkedAt: 0, error: null, updating: [], reporter, t3: null, orca: null },
    historyRev: 0,
  });
  const row = (reporter: ReporterStatus) => text(renderToStaticMarkup(<I18nProvider><MachineReporterRow item={machine(reporter)} /></I18nProvider>));

  test('the row says where the reporter runs, and which homes stopped', () => {
    const homes = [
      { agent: 'claude' as const, home: '~/.claude', reporting: true },
      { agent: 'claude' as const, home: '~/.agent-app/homes/claude-other', reporting: true },
      { agent: 'codex' as const, home: '~/.codex', reporting: true },
    ];
    expect(reporterHomesText({ installed: true, homes }, t)).toBe('Claude Code (2 homes) · Codex (1 home)');
    expect(row({ installed: true, homes })).toBe('Alerts Claude Code (2 homes) · Codex (1 home) Remove');
    const stopped = [...homes, { agent: 'codex' as const, home: '~/.agent-app/homes/codex-other', reporting: false }];
    expect(row({ installed: true, homes: stopped })).toBe('Alerts Claude Code (2 homes) · Codex (1 home) · 1 home isn’t reporting Set up again Remove');
    expect(row({ installed: false, homes: homes.map((home) => ({ ...home, reporting: false })) }))
      .toBe('Alerts Off. Set up Arbor’s reporter to hear when an agent here needs you. Set up');
  });
});

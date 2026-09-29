import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { MachinePage } from '../src/pages/MachinePage';
import { UsageRecordsPage } from '../src/pages/UsageRecordsPage';
import { machineRequestsView, machineSessionsView, usageView, type AppView } from '../src/navigation';
import type { MachineSessions, SessionTranscript, UsageSession } from '../src/native/types';

const MINUTE = 60_000;
const now = Date.parse('2026-09-24T07:20:00Z');

const transcript = (fields: Partial<SessionTranscript>): SessionTranscript => ({
  machine: 'casey-mbp', agent: 'claude', home: '/Users/casey', agentHome: '', cwd: '/Users/casey/src/arbor', repoRoot: '/Users/casey/src/arbor',
  mainRepo: '/Users/casey/src/arbor', branch: 'fix/login-loop', commitHash: '', repositoryUrl: '', title: '', titleSource: '',
  pullRequests: [], linesAdded: null, linesRemoved: null, compactions: [], toolUsage: null, readAtMs: 0,
  ...fields,
});

const session = (id: string, fields: Partial<UsageSession> = {}): UsageSession => ({
  id, parentId: null, depth: 0, models: ['claude-opus-5-5'], providers: ['claude'], userAgent: 'claude-cli/2.1.280 (external, cli)',
  startedAtMs: now - 60 * MINUTE, lastActiveAtMs: now - 2 * MINUTE, requests: 40, failures: 0, canceled: 0,
  inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  totalTokens: 1_200_000, estimatedCost: 12.4, pricedRequests: 40, peakContext: 0, compactions: 0,
  provider: 'claude', machine: 'casey-mbp', pool: '', apiKeyHash: '', active: false, hasOwnRequests: true, subagents: 0, threads: [],
  transcript: null,
  ...fields,
});

const machine = (name: string, latest: UsageSession[], fields: Partial<MachineSessions> = {}): MachineSessions => ({
  machine: name, sessions: latest.length, subagents: 0, running: latest.filter((item) => item.active).length,
  requests: 0, totalTokens: latest.reduce((sum, item) => sum + item.totalTokens, 0),
  estimatedCost: latest.reduce((sum, item) => sum + item.estimatedCost, 0), pricedRequests: 1,
  lastActiveAtMs: Math.max(...latest.map((item) => item.lastActiveAtMs)), latest,
  ...fields,
});

/** A machine's page before its health, board and scans have been read, with the range's sessions given. */
const render = (name: string, machines: MachineSessions[] | null) => renderToStaticMarkup(
  <I18nProvider>
    <MachinePage machine={name} overview={null} sessions={machines} onNavigate={() => {}} onOpenSession={() => {}} onOpenRequests={() => {}} />
  </I18nProvider>,
);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
/** The Usage or Sessions page as a view opens it, before anything has loaded. */
const page = (view: AppView) => {
  if (view.kind !== 'main' || (view.page !== 'sessions' && view.page !== 'usage')) throw new Error(`Not a Usage or Sessions view: ${view.page}`);
  return renderToStaticMarkup(<I18nProvider><UsageRecordsPage variant={view.page} params={view.params} /></I18nProvider>);
};
/** The top bar's breadcrumb, which names the view the page opened on. */
const breadcrumb = (html: string) => text(html.match(/<h1[^>]*>(.*?)<\/h1>/)?.[1] ?? '');

describe('a machine’s sessions', () => {
  test('its page says how many ran there and how many are running, and lists its latest', () => {
    const login = session('a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7', {
      active: true,
      lastActiveAtMs: Date.now() - 30_000,
      transcript: transcript({ title: 'Fix the login redirect loop' }),
    });
    const older = session('6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c', { lastActiveAtMs: Date.now() - 3 * 60 * MINUTE, pricedRequests: 0, estimatedCost: 0 });
    const html = text(render('casey-mbp', [
      machine('casey-mbp', [login, older], { sessions: 9, subagents: 3, running: 1, estimatedCost: 41.5 }),
      machine('ci-01', [session('0199a05d-91c2-7b4a-8e6f-2d3e4f5a6b7c', { machine: 'ci-01', transcript: transcript({ title: 'Someone else’s' }) })]),
    ]));
    expect(html).toContain('Sessions 9 sessions · 3 subagents · 1 running View all');
    expect(html).toContain('Fix the login redirect loop arbor · fix/login-loop $12.40 just now');
    // Without a transcript, a session goes by its client and short id; without a price, it says so.
    expect(html).toContain('Claude Code 2.1.280 6f7a8b9c unpriced 3h ago');
    // Only its own.
    expect(html).not.toContain('Someone else’s');
  });

  test('says so when none ran there, and waits while they load', () => {
    expect(text(render('lab-box', []))).toContain('No sessions ran on lab-box in this range.');
    expect(text(render('lab-box', null))).not.toContain('No sessions ran');
  });

  test('a machine’s sessions open on the Sessions list, filtered to that machine', () => {
    // What the Machines page's View All and the search palette open, for sessions Arbor couldn't place and for a
    // named machine.
    const unassigned = page(machineSessionsView('__unassigned__'));
    expect(breadcrumb(unassigned)).toBe('Sessions / All sessions');
    // The machine shows as a chip beside Filters, which counts it.
    expect(text(unassigned)).toContain('Filters 1 Machine Unassigned Clear all');
    expect(text(page(machineSessionsView('casey-mbp')))).toContain('Filters 1 Machine casey-mbp Clear all');
    // A machine's requests are Usage's own filter, and the Sessions page's doesn't follow it there.
    const requests = page(machineRequestsView('casey-mbp'));
    expect(breadcrumb(requests)).toBe('Usage / Requests');
    expect(text(requests)).toContain('Filters 1 Machine casey-mbp Clear all');
    const unfiltered = text(page(usageView({ tab: 'events' })));
    expect(unfiltered).toContain('Last 24 hours Filters');
    expect(unfiltered).not.toContain('Clear all');
  });
});

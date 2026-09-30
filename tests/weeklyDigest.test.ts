import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import { translate } from '../src/i18n';
import { getFormatRegion, setFormatRegion } from '../src/lib/format';
import type { CapacityAccount, CapacityProvider } from '../src/services/capacityReport';
import { digestFileName, digestPage } from '../src/services/digestPage';
import {
  changeText,
  digestNotification,
  digestWeek,
  dueDigestWeek,
  loadWeeklyDigest,
  mergedHint,
  reloadDigestPullRequests,
  weekDays,
  weeklyDigest,
  weekStart,
  type DigestOverview,
  type WeeklyDigestData,
} from '../src/services/weeklyDigest';
import type {
  CapacityReport,
  LimitCycle,
  ProjectPullRequest,
  SessionProject,
  SessionProjectsReport,
  UsageOverview,
  UsageSession,
} from '../src/native/types';
import { present } from './support/items';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);
/** Local times, so the tests hold in any timezone. */
const at = (day: number, hour = 0, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
// Thursday, September 24, 2026, mid-afternoon.
const NOW = at(24, 15);

// Dates and amounts follow the Mac's region; these read as they do in Australia.
const region = getFormatRegion();
beforeAll(() => setFormatRegion({ locale: 'en-AU', hourCycle: 'h12' }));
afterAll(() => setFormatRegion(region));

describe('digest weeks', () => {
  test('a week runs Monday to Monday, and this one to now against the same part of the last', () => {
    expect(weekStart(NOW)).toBe(at(21));
    expect(weekStart(at(27, 23, 59))).toBe(at(21));
    expect(weekStart(at(28))).toBe(at(28));
    expect(digestWeek(0, NOW)).toEqual({ offset: 0, startMs: at(21), endMs: NOW, previousStartMs: at(14), previousEndMs: at(17, 15) });
    expect(digestWeek(1, NOW)).toEqual({ offset: 1, startMs: at(14), endMs: at(21), previousStartMs: at(7), previousEndMs: at(14) });
  });

  test('a week goes by its days', () => {
    expect(weekDays(digestWeek(0, NOW), NOW)).toBe('21 – 24 Sep');
    expect(weekDays(digestWeek(1, NOW), NOW)).toBe('14 – 20 Sep');
    expect(weekDays(digestWeek(0, at(30, 9)), NOW)).toBe('28 – 30 Sep');
    expect(weekDays(digestWeek(1, at(30 + 5, 9)), NOW)).toBe('28 Sep – 4 Oct');
    expect(weekDays(digestWeek(0, at(21, 8)), NOW)).toBe('21 Sep');
    // A week from another year says which.
    expect(weekDays(digestWeek(0, NOW), at(24 + 365))).toBe('21 – 24 Sep 2026');
  });

  test('the week before is due on Monday morning, once, and caught up on after', () => {
    const lastWeek = at(14);
    expect(dueDigestWeek(at(21, 8, 59), at(7))).toBeNull();
    expect(dueDigestWeek(at(21, 9), at(7))?.startMs).toBe(lastWeek);
    expect(dueDigestWeek(at(21, 9), lastWeek)).toBeNull();
    // The app wasn't running on Monday.
    expect(dueDigestWeek(at(23, 18), at(7))?.startMs).toBe(lastWeek);
    // Only the latest week goes out after a longer gap.
    expect(dueDigestWeek(NOW, at(1 - 7))?.startMs).toBe(lastWeek);
    expect(dueDigestWeek(at(27, 22), lastWeek)).toBeNull();
    // Before the first digest, the week just ended is due.
    expect(dueDigestWeek(NOW, null)?.startMs).toBe(lastWeek);
  });

  test('changes read as up, down or about the same', () => {
    expect(changeText(112, 100, t)).toBe('up 12%');
    expect(changeText(88, 100, t)).toBe('down 12%');
    expect(changeText(101, 100, t)).toBe('about the same');
    expect(changeText(5, 0, t)).toBe('');
  });
});

const overview = (fields: Partial<DigestOverview> = {}): DigestOverview => ({
  totalRequests: 1_000, successCount: 970, failureCount: 20, totalTokens: 90_000_000, estimatedCost: 1_234.5, pricedRequests: 990,
  ...fields,
});

const pullRequest = (number: number, fields: Partial<ProjectPullRequest> = {}, github: Partial<NonNullable<ProjectPullRequest['github']>> | null = {}): ProjectPullRequest => ({
  repository: 'acme/arbor', number, url: `https://github.com/acme/arbor/pull/${number}`, project: 'arbor', branch: `fix/${number}`,
  sessions: 2, estimatedCost: 40, pricedRequests: 30, linesAdded: 120, linesRemoved: 30, lastActiveAtMs: at(22),
  github: github === null ? null : {
    state: 'merged', draft: false, title: `Change ${number}`, baseBranch: 'main', mergedAtMs: at(22, 10), closedAtMs: at(22, 10), mergeable: '', review: '', checks: null,
    checkedAtMs: NOW, ...github,
  },
  ...fields,
});

const project = (name: string, fields: Partial<SessionProject> = {}): SessionProject => ({
  name, repository: `acme/${name}`, branches: [], sessions: 10, active: 0, requests: 400, totalTokens: 1, estimatedCost: 500, pricedRequests: 400,
  linesAdded: 1_000, linesRemoved: 200, sessionsWithLines: 6, lastActiveAtMs: at(23),
  ...fields,
});

const session = (id: string, estimatedCost: number): UsageSession => ({
  id, parentId: null, depth: 0, models: ['claude-opus-5-5'], providers: ['claude'], userAgent: 'claude-cli/2.1.280 (external, cli)',
  startedAtMs: at(22), lastActiveAtMs: at(23), requests: 40, failures: 0, canceled: 0,
  inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  totalTokens: 0, estimatedCost, pricedRequests: estimatedCost ? 40 : 0, peakContext: 0, compactions: 0,
  provider: 'claude', machine: 'casey-mbp', pool: '', apiKeyHash: '', active: false, hasOwnRequests: true, subagents: 2, threads: [], transcript: null,
});

const account = (key: string, name: string, percent: number | null): CapacityAccount => ({
  key, name, plan: 'max', monthlyCost: 200, costSet: false, value: 300, requests: 100, unpricedRequests: 0, periodCost: 46, ratio: 6.5,
  use: percent === null ? null : { percent, basis: 'history', watchedMs: 7 * DAY }, current: null, idle: false, spare: false,
});

const provider = (fields: Partial<CapacityProvider>): CapacityProvider => ({
  provider: 'claude', window: '7-day', accounts: [], unlisted: null, monthlyCost: 400, unknownCosts: 0, periodCost: 92, value: 600, ratio: 6.5, verdicts: [],
  ...fields,
});

const cycle = (account: string, resetAtMs: number, minRemainingPercent: number, fields: Partial<LimitCycle> = {}): LimitCycle => ({
  account, authIndex: account, plan: 'max', window: '7-day', resetAtMs, firstRemainingPercent: 100, minRemainingPercent,
  firstSampledAtMs: resetAtMs - 7 * DAY, lastSampledAtMs: resetAtMs - HOUR,
  ...fields,
});

const projectsReport = (fields: Partial<SessionProjectsReport> = {}): SessionProjectsReport => ({
  projects: [project('arbor', { estimatedCost: 700 }), project('billing', { estimatedCost: 300, sessionsWithLines: 0, linesAdded: 0, linesRemoved: 0 })],
  pullRequests: [pullRequest(7, {}, { state: 'open', mergedAtMs: null }), pullRequest(8, {}, { state: 'open', draft: true, mergedAtMs: null })],
  unplaced: { sessions: 4, active: 0, requests: 20, totalTokens: 1, estimatedCost: 10, pricedRequests: 20, linesAdded: 0, linesRemoved: 0, sessionsWithLines: 0, lastActiveAtMs: at(22) },
  github: { checking: false, last: 'ok', message: '', detailError: '', atMs: NOW },
  ...fields,
});

const digestData = (fields: Partial<WeeklyDigestData> = {}): WeeklyDigestData => ({
  week: digestWeek(0, NOW),
  overview: overview(),
  previousOverview: overview({ estimatedCost: 1_400, successCount: 950, failureCount: 50 }),
  sessions: {
    items: [session('a', 312), session('b', 150), session('c', 90), session('d', 0)], total: 60, page: 1, pageSize: 20, totalPages: 3,
    summary: { sessions: 60, subagentThreads: 140, active: 2, requests: 1_000, totalTokens: 1, estimatedCost: 1_234.5, pricedRequests: 990, untrackedRequests: 0 },
  },
  previousSessions: { sessions: 48, subagentThreads: 90, active: 0, requests: 900, totalTokens: 1, estimatedCost: 1_400, pricedRequests: 900, untrackedRequests: 0 },
  projects: projectsReport(),
  pullRequests: [
    pullRequest(1, { estimatedCost: 30 }, { mergedAtMs: at(22, 10) }),
    pullRequest(2, { estimatedCost: 90, project: 'billing' }, { mergedAtMs: at(24, 11) }),
    // Merged the week before, still open, closed, and not asked about yet.
    pullRequest(3, {}, { mergedAtMs: at(20, 23) }),
    pullRequest(4, {}, { state: 'open', mergedAtMs: null }),
    pullRequest(5, {}, { state: 'closed', mergedAtMs: null, closedAtMs: at(23) }),
    pullRequest(6, {}, null),
  ],
  cacheMisses: { requests: 14, tokens: 2_000_000, cost: 56.2, pricedRequests: 14 },
  previousCacheMisses: { requests: 20, tokens: 3_000_000, cost: 80, pricedRequests: 20 },
  capacity: {
    startMs: at(21), endMs: NOW, accounts: [], coverage: [], historySinceMs: at(1),
    cycles: [
      cycle('work', at(22, 6), 52),
      // Too little left to mention, reset before the week, not yet reset, readings stopped days before, and another window.
      cycle('home', at(23, 6), 12),
      cycle('work', at(20, 6), 70),
      cycle('home', at(25, 6), 60),
      cycle('spare', at(23, 12), 80, { lastSampledAtMs: at(20) }),
      cycle('work', at(23, 6), 90, { window: '7-day Opus' }),
    ],
  } satisfies CapacityReport,
  ...fields,
});

const providers = [
  provider({
    accounts: [account('work', 'Work Max', 60), account('home', 'Home Max', 20), account('spare', 'Spare Max', null)],
    verdicts: [{ plan: 'max', accounts: 3, needPercent: 80, keep: 1, spare: ['Home Max'], saving: 200 }],
  }),
  provider({ provider: 'codex', window: 'Weekly limit', accounts: [account('codex', 'Codex Pro', null)], ratio: null }),
  provider({ provider: 'kimi', window: null }),
];

describe('weekly digest', () => {
  test('what got done: the pull requests that merged in the week, and the projects that took the most', () => {
    const digest = weeklyDigest(digestData(), providers, NOW);
    expect(digest.merged.map((item) => item.number)).toEqual([2, 1]);
    expect(digest.mergedCost).toBe(120);
    // Drafts count as open.
    expect(digest.open).toBe(2);
    expect(digest.projects.map((item) => [item.name, item.merged])).toEqual([['arbor', 1], ['billing', 1]]);
    expect(digest.moreProjects).toBe(0);
    expect([digest.linesAdded, digest.linesRemoved, digest.sessionsWithLines]).toEqual([1_000, 200, 6]);
    expect([digest.sessions, digest.previousSessions, digest.subagents]).toEqual([60, 48, 140]);
    expect(digest.costliest.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  test('waste and limits: failures of the finished requests, and headline limits that reset with plenty left', () => {
    const digest = weeklyDigest(digestData(), providers, NOW);
    expect(digest.failureRate).toBeCloseTo(20 / 990);
    expect(digest.previousFailureRate).toBeCloseTo(0.05);
    expect(digest.unused).toEqual([{ provider: 'claude', key: 'work', name: 'Work Max', window: '7-day', percent: 52, resetAtMs: at(22, 6) }]);
    expect(digest.limits).toEqual([
      { provider: 'claude', window: '7-day', percent: 40, measured: 2, accounts: 3, ratio: 6.5, spare: ['Home Max'] },
    ]);
    expect(weeklyDigest(digestData({ capacity: null }), [], NOW).unused).toEqual([]);
  });

  test('the notification says it in a few lines', () => {
    const lastWeek = digestWeek(1, NOW);
    const digest = weeklyDigest(digestData({ week: lastWeek }), providers, NOW);
    expect(digestNotification(digest, t)).toEqual({
      title: 'Your week, 14 – 20 Sep',
      body: [
        // Amounts keep their cents at any size now, as they do everywhere else.
        '$1,234.50 spent, down 12% · 60 sessions',
        // Only #3 merged that week.
        '1 pull request merged · +1,000 −200 lines',
        'Most went to arbor: $700.00',
        // The limit that reset with 70% left on Sunday was that week's.
        'Waste: $56.20 in cache misses · 2.0% failed · 1 limit reset 30%+ unused',
        'Limits used: Claude 40%',
      ].join('\n'),
    });
  });

  test('a quiet week leaves out what it has nothing for', () => {
    const digest = weeklyDigest(digestData({
      overview: overview({ estimatedCost: 0, pricedRequests: 0, successCount: 3, failureCount: 0, totalRequests: 3 }),
      sessions: { ...digestData().sessions, items: [], summary: { ...digestData().sessions.summary, sessions: 1 } },
      projects: projectsReport({ projects: [], pullRequests: [] }),
      pullRequests: [],
      cacheMisses: { requests: 0, tokens: 0, cost: 0, pricedRequests: 0 },
      capacity: null,
    }), [], NOW);
    expect(digestNotification(digest, t)).toEqual({ title: 'Your week, 21 – 24 Sep', body: '1 session' });
  });

  test('a week ending on New Year\'s Eve is named without a year', () => {
    // 31 December 2028 is a Sunday, so that week ends at midnight on New Year's Day.
    const newYear = new Date(2029, 0, 1, 10).getTime();
    const digest = weeklyDigest(digestData({ week: digestWeek(1, newYear), capacity: null }), [], newYear);
    expect(digestNotification(digest, t).title).toBe('Your week, 25 – 31 Dec');
  });

  test('a week with no requests at all spent nothing, rather than an unknown amount', () => {
    const digest = weeklyDigest(digestData({
      overview: overview({ estimatedCost: 0, pricedRequests: 0, successCount: 0, failureCount: 0, totalRequests: 0 }),
      previousOverview: overview({ estimatedCost: 0, pricedRequests: 0, successCount: 0, failureCount: 0, totalRequests: 0 }),
    }), [], NOW);
    const page = digestPage(digest, { t, nowMs: NOW }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(page).toContain('Spend $0.00 $0.00 by this time last week');
  });

  test('with nothing priced, merged pull requests have no cost rather than $0.00 each', () => {
    const lastWeek = digestWeek(1, NOW);
    const unpriced = digestData().pullRequests.map((pullRequest) => ({ ...pullRequest, estimatedCost: 0, pricedRequests: 0 }));
    const digest = weeklyDigest(digestData({
      week: lastWeek,
      overview: overview({ estimatedCost: 0, pricedRequests: 0 }),
      pullRequests: unpriced,
      cacheMisses: { requests: 14, tokens: 2_000_000, cost: 0, pricedRequests: 0 },
    }), providers, NOW);
    expect(mergedHint(digest, t)).toBe('No prices for these models');
    const page = digestPage(digest, { t, nowMs: NOW }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(page).toContain('Change 3 acme/arbor#3 · arbor · merged Sun, 20 Sep +120 −30 unpriced');
    expect(page).toContain('Spend unpriced No prices for these models');
    expect(page).toContain('Cache misses 14 requests sent 2M tokens of context again uncached unpriced Failed');
  });
});

describe('the shareable page', () => {
  const lastWeek = digestWeek(1, NOW);
  const visible = (page: string) => page.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  test('holds the week in one file, with nothing loaded from anywhere', () => {
    const page = digestPage(weeklyDigest(digestData({ week: lastWeek }), providers, NOW), { t, nowMs: NOW });
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('<title>Arbor weekly digest, 14 – 20 Sep, 2026</title>');
    const text = visible(page);
    expect(text).toContain('The week of 14 – 20 Sep, 2026 Compared with the week before');
    expect(text).toContain('Spend $1,234.50 −12% $1,400.00 the week before');
    expect(text).toContain('Sessions 60 +25% 48 the week before');
    expect(text).toContain('Change 3 acme/arbor#3 · arbor · merged Sun, 20 Sep +120 −30 $40.00');
    expect(text).toContain('arbor acme/arbor 10 1 +1,000 −200 $700.00 billing acme/billing 10 — — $300.00');
    expect(text).toContain('Claude Code 2.1.280 a · casey-mbp 25% of spend $312.00');
    expect(text).toContain('Claude 7-day · 2 of 3 accounts measured · Home Max could go 40% used on average 6.5× cost');
    expect(text).toContain('Cache misses 14 requests sent 2M tokens of context again uncached $56.20 −30%');
    expect(text).toContain('Made with Arbor on 24 September 2026.');
    // No scripts, images or remote files; the only links go to the pull requests.
    expect(page).not.toMatch(/<script|<link|<img|<iframe|src=|url\(|@import/i);
    expect([...page.matchAll(/href="([^"]+)"/g)].map((match) => match[1])).toEqual(['https://github.com/acme/arbor/pull/3']);
    expect(digestFileName(lastWeek)).toBe('arbor-week-2026-09-14.html');
  });

  test('quotes names as text, and links only to the web', () => {
    const data = digestData({
      week: lastWeek,
      projects: projectsReport({ projects: [project('<img src=x onerror="alert(1)">')] }),
      pullRequests: [pullRequest(3, { url: 'javascript:alert(1)' }, { mergedAtMs: at(20, 23), title: '</style><script>alert(1)</script>' })],
    });
    const page = digestPage(weeklyDigest(data, providers, NOW), { t, nowMs: NOW });
    expect(page).not.toMatch(/<script|<img|javascript:/i);
    expect(page).toContain('&lt;/style&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(page).not.toContain('href=');
  });
});

describe('loading a week', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  });
  afterEach(() => {
    clearMocks();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  test('keeps the week before from an earlier load, and rechecks only the pull requests', async () => {
    const data = digestData();
    const fullOverview: UsageOverview = {
      ...data.overview, canceledCount: 10, successRate: 97, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, rpm: 0, tpm: 0, tps: 0, tpsSampleCount: 0, averageLatencyMs: 0, cacheHitRate: 0,
      timeline: [], machines: [], machineLive: [],
    };
    const calls = mockCommands({
      get_usage_overview: () => fullOverview,
      get_usage_sessions: () => data.sessions,
      get_session_projects: () => data.projects,
      get_merged_pull_requests: () => ({ pullRequests: data.pullRequests }),
      get_cache_misses: () => data.cacheMisses,
      get_capacity_report: () => present(data.capacity, 'the capacity report'),
    });
    const commands = () => calls.splice(0).map((call) => call.command).sort();
    const first = await loadWeeklyDigest(data.week, []);
    expect(commands()).toHaveLength(9);

    const again = await loadWeeklyDigest(data.week, [], first);
    expect(commands()).toEqual([
      'get_cache_misses',
      'get_capacity_report',
      'get_merged_pull_requests',
      'get_session_projects',
      'get_usage_overview',
      'get_usage_sessions',
    ]);
    expect([again.previousOverview, again.previousSessions, again.previousCacheMisses]).toEqual([
      first.previousOverview,
      first.previousSessions,
      first.previousCacheMisses,
    ]);

    // Next week compares against this one, so reads it.
    await loadWeeklyDigest(digestWeek(0, NOW + 7 * DAY), [], first);
    expect(commands()).toHaveLength(9);

    const rechecked = await reloadDigestPullRequests(first);
    expect(commands()).toEqual(['get_merged_pull_requests', 'get_session_projects']);
    expect(rechecked.overview).toBe(first.overview);
  });
});

/**
 * The browser mock's answers for usage history: the proxy's records and prices, sessions and their requests, projects and
 * pull requests, the live fleet board, limits and capacity, and the database itself.
 */
import { emit } from '@tauri-apps/api/event';
import type {
  AgentAttentionReport,
  AttentionItem,
  CapacityQuery,
  CapacityReport,
  ContextStep,
  FleetSources,
  GithubStatus,
  LimitCoverage,
  LimitCycle,
  LiveContext,
  LiveSessionsReport,
  MachineLive,
  MachineSessions,
  ModelPrice,
  PullRequestChecks,
  PullRequestState,
  SessionFacets,
  SessionProjectsReport,
  SessionRequest,
  SessionTranscript,
  Skipped,
  T3Channel,
  T3Thread,
  T3Turn,
  ToolUsage,
  UsageOverview,
  UsagePricing,
  UsageQuery,
  UsageRecord,
  UsageRequestOrder,
  UsageSession,
  UsageSessionThread,
} from '../../native/types';
import type { UsageCommands } from '../../native/usage';
import { sessionClient, sessionPlace } from '../../services/usageSessions';
import type { CommandAnswers } from './answers';
import { coreStatus, heavyScenario } from './core';
import { freshInstall, iso, later, mockLog, now, params } from './scenario';

// With `?prices=none`, no model has a price, so no request, session or machine has a known cost.
const noPrices = params.get('prices') === 'none';

// With `?gh=missing`, `signedOut` or `failed`, the GitHub CLI can't say which pull requests merged; with `?gh=detailfail`,
// GitHub turns down asking how open ones stand, so only whether they merged comes back.
const githubScenario = params.get('gh') ?? 'ok';

const collectorError = params.get('collector') === 'error';

// With `?failures=none`, no request failed, so Usage's Requests with Failed on has nothing to list.
const noFailures = params.get('failures') === 'none';

const localHour = (offsetMs: number) => {
  const d = new Date(now + offsetMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}`;
};

// Thirty days of hourly usage, quiet overnight and idle for two whole days, so
// the trend chart's bucket sizes and idle gaps all show in the browser. Sized like
// a heavy user's days: about 16,000 requests and 2.5B tokens, each request carrying
// its conversation's cached context.
const HISTORY_HOURS = 30 * 24;

const usageHistory = Array.from({ length: HISTORY_HOURS }, (_, index) => {
  const offset = -(HISTORY_HOURS - 1 - index) * 3_600_000;
  const at = new Date(now + offset);
  const daysAgo = Math.floor((HISTORY_HOURS - 1 - index) / 24);
  if ((at.getHours() >= 1 && at.getHours() < 7) || daysAgo === 11 || daysAgo === 12) return null;
  const requests = Math.round(400 + 600 * Math.abs(Math.sin(index / 3)) + (index % 5) * 60);
  const failure = noFailures ? 0 : Math.round(requests * 0.04);
  const canceled = index % 7 === 0 ? 2 : 0;
  at.setMinutes(0, 0, 0);
  return {
    startMs: at.getTime(),
    point: {
      hour: localHour(offset),
      firstTimestampMs: at.getTime() + (index % 4) * 60_000,
      requests,
      success: requests - failure - canceled,
      failure,
      canceled,
      tokens: requests * (120_000 + (index % 9) * 8_000),
    },
  };
}).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
// `?fresh=1`: nothing has gone through the proxy yet, so every usage view starts empty.
if (freshInstall) usageHistory.length = 0;

type TimelinePoint = (typeof usageHistory)[number]['point'];

/** The hours with traffic that overlap the range, like the backend's hourly timeline. */
const timelineBetween = (start?: string, end?: string) => {
  const from = start ? Date.parse(start) : -Infinity;
  const to = end ? Date.parse(end) : Infinity;
  return usageHistory.filter((entry) => entry.startMs + 3_600_000 > from && entry.startMs <= to).map((entry) => entry.point);
};

const sumTimeline = (points: TimelinePoint[]) => points.reduce((acc, point) => ({ requests: acc.requests + point.requests, failure: acc.failure + point.failure, canceled: acc.canceled + point.canceled, tokens: acc.tokens + point.tokens }), { requests: 0, failure: 0, canceled: 0, tokens: 0 });

const timeline = timelineBetween(iso(-24 * 3_600_000), iso(0));

const totals = sumTimeline(timeline);

/** A machine's share of the last 24 hours. */
const machineShare = (machine: string, pool: string, share: number, failureRate: number, canceled: number, lastRequest: string) => {
  const requests = Math.round(totals.requests * share), failures = Math.round(requests * failureRate);
  return { machine, pool, requests, tokens: Math.round(totals.tokens * share), success: requests - failures - canceled, failures, canceled, lastRequest };
};

const machines = [
  machineShare('casey-mbp', 'dev', 0.726, 0.025, 4, iso(-120_000)),
  machineShare('ci-01', 'ci', 0.251, 0.017, 0, iso(-900_000)),
  machineShare('', '', 0.023, 0, 0, iso(-5_400_000)),
];
if (freshInstall) machines.length = 0;

// Each machine's last minute, as twelve five-second buckets of tokens.
const liveTokens = (seed: number) => Array.from({ length: 12 }, (_, i) => Math.round(100_000 + 90_000 * Math.abs(Math.sin(i / 2.2 + seed)))) as MachineLive['tokens'];

const usageOverview: UsageOverview = {
  totalRequests: totals.requests,
  successCount: totals.requests - totals.failure - totals.canceled,
  failureCount: totals.failure,
  canceledCount: totals.canceled,
  successRate: totals.requests ? ((totals.requests - totals.failure - totals.canceled) / totals.requests) * 100 : 0,
  inputTokens: Math.round(totals.tokens * 0.045),
  outputTokens: Math.round(totals.tokens * 0.011),
  reasoningTokens: Math.round(totals.tokens * 0.004),
  cacheReadTokens: Math.round(totals.tokens * 0.91),
  cacheCreationTokens: Math.round(totals.tokens * 0.03),
  totalTokens: totals.tokens,
  rpm: 11.4,
  tpm: 1_740_000,
  tps: 61.2,
  tpsSampleCount: 8_800,
  averageLatencyMs: 4_180,
  cacheHitRate: 0.95,
  estimatedCost: noPrices ? 0 : 2_684.12,
  pricedRequests: noPrices ? 0 : totals.requests - 120,
  timeline,
  machines,
  machineLive: machines.map((machine) => ({ machine: machine.machine, requests: Math.max(1, Math.round(machine.requests / 800)), tokens: liveTokens(machine.requests) })),
};
if (freshInstall) Object.assign(usageOverview, { rpm: 0, tpm: 0, tps: 0, tpsSampleCount: 0, averageLatencyMs: 0, cacheHitRate: 0, estimatedCost: 0, pricedRequests: 0 });

/** The overview for a range: counts come from its timeline, the rest scales with the last 24 hours. */
const usageOverviewFor = (points: TimelinePoint[]): UsageOverview => {
  const sum = sumTimeline(points);
  const scale = totals.requests ? sum.requests / totals.requests : 0;
  return {
    ...usageOverview,
    totalRequests: sum.requests,
    successCount: sum.requests - sum.failure - sum.canceled,
    failureCount: sum.failure,
    canceledCount: sum.canceled,
    successRate: sum.requests ? ((sum.requests - sum.failure - sum.canceled) / sum.requests) * 100 : 0,
    inputTokens: Math.round(sum.tokens * 0.045),
    outputTokens: Math.round(sum.tokens * 0.011),
    reasoningTokens: Math.round(sum.tokens * 0.004),
    cacheReadTokens: Math.round(sum.tokens * 0.91),
    cacheCreationTokens: Math.round(sum.tokens * 0.03),
    totalTokens: sum.tokens,
    estimatedCost: Math.round(usageOverview.estimatedCost * scale * 100) / 100,
    pricedRequests: noPrices ? 0 : Math.max(0, sum.requests - Math.round(120 * scale)),
    timeline: points,
  };
};

export const reporterInstalled: Record<string, boolean> = freshInstall ? {} : { 'casey-mbp': true, 'ci-01': false, 'cedar-02': true };

/** A breakdown row with `share` of the last 24 hours' requests and tokens. */
const category = (key: string, label: string, share: number, failureRate: number) => {
  const requests = Math.round(totals.requests * share);
  return { key, label, requests, failures: Math.round(requests * failureRate), tokens: Math.round(totals.tokens * share) };
};
const account = (authIndex: string, label: string, share: number, failureRate: number) => {
  const { key, ...row } = category(authIndex, label, share, failureRate);
  return { authIndex: key, ...row };
};

const usageAnalysis = {
  models: [category('claude-opus-5-5', 'claude-opus-5-5', 0.52, 0.015), category('gpt-6-sol', 'gpt-6-sol', 0.31, 0.026), category('claude-sonnet-5', 'claude-sonnet-5', 0.11, 0.01), category('gpt-6-luna', 'gpt-6-luna', 0.06, 0.03)],
  providers: [category('claude', 'Claude', 0.63, 0.014), category('codex', 'Codex', 0.37, 0.027)],
  // The core records an account's email as its source, so these are the accounts below grouped by email: casey@'s
  // Claude and Codex requests are one row here.
  sources: [
    category('casey@example.com', 'casey@example.com', 0.64, 0.018),
    category('team@example.com', 'team@example.com', 0.2, 0.03),
    category('lapsed@example.com', 'lapsed@example.com', 0.09, 0.02),
    category('backup@example.com', 'backup@example.com', 0.04, 0.017),
    category('former@example.com', 'former@example.com', 0.03, 0.04),
  ],
  // By credential: casey@ is signed in to Claude (claude-1) and Codex (codex-1), two accounts with one email, and the
  // last row's requests carried no auth index, so only their source names them.
  accounts: [
    account('claude-1', 'casey@example.com', 0.52, 0.012),
    account('codex-2', 'team@example.com', 0.2, 0.03),
    account('codex-1', 'casey@example.com', 0.12, 0.026),
    account('claude-2', 'lapsed@example.com', 0.09, 0.02),
    account('codex-3', 'backup@example.com', 0.04, 0.017),
    account('', 'former@example.com', 0.03, 0.04),
  ],
  apiKeys: [category('a1b2', 'Casey laptop', 0.73, 0.025), category('c3d4', 'CI runner', 0.27, 0.016)],
};
if (freshInstall) Object.values(usageAnalysis).forEach((rows) => { rows.length = 0; });

/**
 * One request's tokens: a little new input and output on top of the conversation's cached context. Input counts the
 * cached part too, as the core records it, so the cache rate is the cached share of it.
 */
const requestTokens = (index: number, claude: boolean): UsageRecord['tokens'] => {
  const fresh = 2_400 + ((index * 1_931) % 6_000), output = 600 + ((index * 577) % 2_400), reasoning = claude ? 0 : 300 + ((index * 211) % 900);
  const cacheRead = 96_000 + ((index * 7_919) % 150_000), cacheCreation = claude && index % 4 === 1 ? 5_200 : 0;
  const input = fresh + cacheRead + cacheCreation;
  return { input_tokens: input, output_tokens: output, reasoning_tokens: reasoning, cache_read_tokens: cacheRead, cache_creation_tokens: cacheCreation, total_tokens: input + output + reasoning };
};

const usageRecords = Array.from({ length: 25 }, (_, index): UsageRecord => {
  const failed = !noFailures && (index % 9 === 4 || index % 7 === 6);
  const failureStatus = index % 9 === 4 ? 429 : index % 14 === 6 ? 503 : 401;
  const model = index % 3 === 0 ? 'gpt-6-luna' : index % 3 === 1 ? 'claude-opus-5-5' : 'gpt-6-sol';
  const claude = model.startsWith('claude');
  return {
    machine: index % 4 === 0 ? 'ci-01' : 'casey-mbp',
    pool: index % 4 === 0 ? 'ci' : 'dev',
    user_agent: claude ? 'claude-cli/2.1.281 (external, cli)' : 'codex_cli_rs/0.156.0',
    client_ip: '127.0.0.1',
    x_forwarded_for: null,
    id: `evt-${1000 + index}`,
    request_id: `req_${(0x5a1c0 + index * 7_919).toString(16)}`,
    timestamp: iso(-index * 240_000),
    latency_ms: 1_800 + (index * 731) % 6_000,
    ttft_ms: 320 + (index * 97) % 900,
    source: claude ? 'claude-code' : 'codex-cli',
    source_display: claude ? 'Claude Code' : 'Codex CLI',
    failed,
    canceled: false,
    failure_status: failed ? failureStatus : 0,
    failure_body: failed
      ? failureStatus === 429
        ? '{"error":{"type":"rate_limit_error","message":"Rate limited, retry after 12s"}}'
        : failureStatus === 503
          ? '{"error":{"type":"overloaded_error","message":"Overloaded"}}'
          : '{"error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}'
      : '',
    provider: model.startsWith('claude') ? 'claude' : 'codex',
    auth_index: model.startsWith('claude') ? 'claude-1' : 'codex-2',
    auth_type: 'oauth',
    executor_type: model.startsWith('claude') ? 'ClaudeExecutor' : 'CodexWebsocketsExecutor',
    service_tier: '',
    response_service_tier: '',
    model,
    alias: model === 'gpt-6-sol' && index % 2 === 0 ? 'gpt-6-sol-high' : '',
    reasoning_effort: index % 4 === 0 ? 'high' : index % 4 === 1 ? 'medium' : '',
    endpoint: model.startsWith('claude') ? '/v1/messages' : '/v1/responses',
    api_key_hash: index % 4 === 0 ? 'c3d4' : 'a1b2',
    api_key_display: index % 4 === 0 ? 'sk-…0a2c' : 'sk-…3f5a',
    api_key_remark: index % 4 === 0 ? 'CI runner' : 'Casey laptop',
    tokens: requestTokens(index, claude),
  };
});
if (freshInstall) usageRecords.length = 0;

const priceFor = (model: string, prompt: number, completion: number): ModelPrice => ({
  model, prompt, completion, cache: prompt / 10, cacheRead: prompt / 10, cacheCreation: prompt * 1.25,
  promptConfigured: true, completionConfigured: true, cacheReadConfigured: true, cacheCreationConfigured: false,
  source: 'litellm', sourceModelId: model, updatedAtMs: now - 86_400_000,
});

const usagePricing: UsagePricing = {
  rows: [
    { model: 'claude-opus-5-5', requests: 8_560, inputTokens: 61_000_000, outputTokens: 15_400_000, cacheReadTokens: 1_190_000_000, cacheCreationTokens: 42_000_000, totalTokens: 1_308_400_000, estimatedCost: 1_963.75, price: priceFor('claude-opus-5-5', 5, 25) },
    { model: 'gpt-6-sol', requests: 5_110, inputTokens: 36_200_000, outputTokens: 9_800_000, cacheReadTokens: 734_000_000, cacheCreationTokens: 0, totalTokens: 780_000_000, estimatedCost: 604.63, price: priceFor('gpt-6-sol', 1.25, 10) },
    { model: 'claude-sonnet-5', requests: 1_810, inputTokens: 12_900_000, outputTokens: 3_300_000, cacheReadTokens: 251_000_000, cacheCreationTokens: 8_800_000, totalTokens: 276_000_000, estimatedCost: 115.74, price: priceFor('claude-sonnet-5', 3, 15) },
    { model: 'gpt-6-luna', requests: 990, inputTokens: 7_000_000, outputTokens: 1_900_000, cacheReadTokens: 141_000_000, cacheCreationTokens: 0, totalTokens: 149_900_000, estimatedCost: 0, price: null },
  ],
  totalCost: 2_684.12,
  totalRequests: totals.requests,
  pricedRequests: totals.requests - 990,
  savedPrices: 2,
};
if (freshInstall) Object.assign(usagePricing, { rows: [], totalCost: 0, pricedRequests: 0, savedPrices: 0 });

// Capacity report: a month of value at API prices per credential, and twelve
// days of limit readings. `codex-backup` never ran its weekly window, so the
// other Codex accounts could cover it; the lapsed account's readings are too new.
const capacityValues = [
  { authIndex: 'claude-1', provider: 'claude', perMonth: 51_240, requests: 256_800, firstSeenDays: 60 },
  { authIndex: 'claude-2', provider: 'claude', perMonth: 3_410, requests: 14_200, firstSeenDays: 3 },
  { authIndex: 'codex-1', provider: 'codex', perMonth: 6_920, requests: 41_300, firstSeenDays: 60 },
  { authIndex: 'codex-2', provider: 'codex', perMonth: 17_860, requests: 162_400, firstSeenDays: 60 },
  { authIndex: 'codex-3', provider: 'codex', perMonth: 480, requests: 2_900, firstSeenDays: 60 },
  // A credential that has since been removed.
  { authIndex: 'claude-old', provider: 'claude', perMonth: 2_700, requests: 13_100, firstSeenDays: 50 },
];
if (freshInstall) capacityValues.length = 0;

// Each cycle: when its first reading was, when it resets, and the share left at its first and last reading.
type MockCycle = { firstDays: number; resetDays: number; from: number; to: number };

const capacityHistory: Record<string, { provider: 'claude' | 'codex'; watchedDays: number; cycles: MockCycle[] }> = {
  'claude-max.json::claude-1': { provider: 'claude', watchedDays: 12, cycles: [{ firstDays: -12, resetDays: -3, from: 64, to: 8 }, { firstDays: -2.9, resetDays: 4, from: 100, to: 42 }] },
  'claude-lapsed.json::claude-2': { provider: 'claude', watchedDays: 2, cycles: [{ firstDays: -2, resetDays: 5, from: 100, to: 91 }] },
  'codex-casey.json::codex-1': { provider: 'codex', watchedDays: 12, cycles: [{ firstDays: -12, resetDays: -4, from: 80, to: 70 }, { firstDays: -3.9, resetDays: 3, from: 100, to: 88 }] },
  'codex-team.json::codex-2': { provider: 'codex', watchedDays: 12, cycles: [{ firstDays: -12, resetDays: -4, from: 55, to: 0 }, { firstDays: -3.9, resetDays: 3, from: 100, to: 30 }] },
  'codex-backup.json::codex-3': { provider: 'codex', watchedDays: 12, cycles: [] },
};
if (freshInstall) Object.keys(capacityHistory).forEach((account) => { delete capacityHistory[account]; });

function capacityReportFor(query: CapacityQuery): CapacityReport {
  const current = Date.now();
  const endMs = query.end ? Date.parse(query.end) : current;
  const startMs = query.start ? Date.parse(query.start) : current - 60 * DAY_MS;
  const accounts = capacityValues.map(({ perMonth, requests, firstSeenDays, ...value }) => {
    const firstSeenMs = current - firstSeenDays * DAY_MS;
    const share = Math.max(0, endMs - Math.max(startMs, firstSeenMs)) / (30 * DAY_MS);
    const count = Math.round(requests * share);
    return { ...value, requests: count, totalTokens: count * 42_000, estimatedCost: perMonth * share, pricedRequests: Math.max(0, count - (value.authIndex === 'codex-2' ? 60 : 0)), firstSeenMs };
  }).filter((account) => account.requests > 0);
  const coverage: LimitCoverage[] = [];
  const cycles: LimitCycle[] = [];
  const clip = (ms: number) => Math.min(endMs, current, Math.max(startMs, ms));
  (query.windows ?? []).forEach((window) => {
    const provider = /^7-day/i.test(window) ? 'claude' : /weekly/i.test(window) ? 'codex' : null;
    Object.entries(capacityHistory).forEach(([account, history]) => {
      if (history.provider !== provider) return;
      const first = clip(current - history.watchedDays * DAY_MS);
      const last = clip(current - 60_000);
      if (last <= first) return;
      coverage.push({ account, window, firstSampledAtMs: first, lastSampledAtMs: last });
      history.cycles.forEach((cycle) => {
        const cycleFirst = current + cycle.firstDays * DAY_MS;
        const resetAtMs = current + cycle.resetDays * DAY_MS;
        const cycleLast = Math.min(resetAtMs - 3_600_000, current - 60_000);
        const firstSampledAtMs = Math.max(cycleFirst, first);
        const lastSampledAtMs = Math.min(cycleLast, last);
        if (lastSampledAtMs < firstSampledAtMs) return;
        const at = (ms: number) => cycle.from + ((cycle.to - cycle.from) * (ms - cycleFirst)) / Math.max(1, cycleLast - cycleFirst);
        cycles.push({ account, authIndex: account.split('::')[1] ?? '', plan: '', window, resetAtMs, firstRemainingPercent: at(firstSampledAtMs), minRemainingPercent: at(lastSampledAtMs), firstSampledAtMs, lastSampledAtMs });
      });
    });
  });
  return { startMs, endMs, accounts, coverage, cycles, historySinceMs: freshInstall ? null : current - 12 * DAY_MS };
}

// An account's earlier limit windows, as get_limit_cycles reads them from the limit history: the weekly
// cycles the capacity report shows, and a few five-hour windows, one of which ran out.
function limitCyclesFor(account: string, window: string): LimitCycle[] {
  const history = capacityHistory[account];
  if (!history) return [];
  const current = Date.now();
  const authIndex = account.split('::')[1] ?? '';
  const cycle = (resetAtMs: number, firstSampledAtMs: number, from: number, to: number): LimitCycle => ({
    account, authIndex, plan: '', window, resetAtMs,
    firstRemainingPercent: from, minRemainingPercent: to,
    firstSampledAtMs, lastSampledAtMs: Math.min(current, resetAtMs) - 600_000,
  });
  if (/7-day|weekly/i.test(window)) {
    return history.cycles
      .map((item) => cycle(current + item.resetDays * DAY_MS, current + item.firstDays * DAY_MS, item.from, item.to))
      .sort((a, b) => b.resetAtMs - a.resetAtMs);
  }
  return [[-2, 0], [-9, 34], [-27, 61]].map(([hours, left]) => cycle(current + hours! * 3_600_000, current + (hours! - 4.5) * 3_600_000, 100, left!));
}

// Usage history storage for Settings › Data. Records are spread evenly from the
// oldest one to now, so a retention dry run can count what it would delete.
const DAY_MS = 86_400_000;

const usageStorage = {
  retentionDays: 0,
  fileBytes: 212 * 1_048_576,
  walBytes: 4 * 1_048_576,
  freeBytes: 50 * 1_048_576,
  recordCount: 18_420,
  oldestTimestamp: iso(-212 * DAY_MS) as string | null,
};
if (freshInstall) Object.assign(usageStorage, { fileBytes: 229_376, walBytes: 0, freeBytes: 0, recordCount: 0, oldestTimestamp: null });

const usageRecordBytes = (usageStorage.fileBytes - usageStorage.freeBytes) / usageStorage.recordCount;

const expiredUsageRecords = (retentionDays: number) => {
  if (retentionDays <= 0 || !usageStorage.oldestTimestamp || !usageStorage.recordCount) return 0;
  const oldest = Date.parse(usageStorage.oldestTimestamp);
  const cutoff = Date.now() - retentionDays * DAY_MS;
  if (cutoff <= oldest) return 0;
  return Math.min(usageStorage.recordCount, Math.round((usageStorage.recordCount * (cutoff - oldest)) / (Date.now() - oldest)));
};

// Sessions as get_usage_sessions groups them: Claude Code subagents fold into the session that started them.
const sessionAgents = {
  claudeCode: 'claude-cli/2.1.280 (external, cli)',
  agentSdk: 'claude-cli/2.1.280 (external, sdk-ts, agent-sdk/0.3.276)',
  claudePrint: 'claude-cli/2.1.280 (external, sdk-cli)',
  codexHosted: 'codex-tui/0.156.0 (Mac OS 26.0.0; arm64) iTerm.app/3.6.1 AcmeDesk/1.4.205',
  codexExec: 'codex_exec/0.156.0 (Mac OS 26.0.0; arm64) dumb',
  codexApp: 'Codex Desktop/0.156.0 (Mac OS 26.0.0; arm64)',
  claudeHosted: 'claude-cli/2.1.280 (external, cli) AcmeDesk/1.4.205',
};

// Blended USD per million tokens, most of them read from cache.
const sessionPrices: Record<string, number> = { 'claude-opus-5-5': 1.1, 'claude-sonnet-5': 0.66, 'claude-haiku-4-5': 0.22, 'gpt-6-sol': 0.55, 'gpt-6-luna': 0.12 };
/** Each request's tokens: its conversation's context, mostly cached. */
const sessionRequestTokens = (model: string) => (model.includes('haiku') ? 42_000 : model.startsWith('claude') ? 165_000 : 98_000);

const sessionThread = (
  id: string, parentId: string | null, depth: number, model: string, userAgent: string,
  startMinutesAgo: number, minutes: number, requests: number, failures = 0,
): UsageSessionThread => {
  const totalTokens = requests * sessionRequestTokens(model);
  const price = noPrices ? 0 : sessionPrices[model] ?? 0;
  return {
    id, parentId, depth, models: [model], providers: [model.startsWith('claude') ? 'claude' : 'codex'], userAgent,
    // Worked out from the thread's requests once they're made up, below.
    peakContext: 0, compactions: 0,
    startedAtMs: now - startMinutesAgo * 60_000, lastActiveAtMs: now - (startMinutesAgo - minutes) * 60_000,
    requests, failures, canceled: failures ? 1 : 0,
    inputTokens: Math.round(totalTokens * 0.985), outputTokens: Math.round(totalTokens * 0.012), reasoningTokens: Math.round(totalTokens * 0.003),
    cacheReadTokens: Math.round(totalTokens * 0.93), cacheCreationTokens: Math.round(totalTokens * 0.035), totalTokens,
    estimatedCost: (totalTokens / 1_000_000) * price, pricedRequests: price ? requests : 0,
  };
};

type SummedKey = 'requests' | 'failures' | 'canceled' | 'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'cacheReadTokens'
  | 'cacheCreationTokens' | 'totalTokens' | 'estimatedCost' | 'pricedRequests';

const mockSession = (id: string, threads: UsageSessionThread[], machine: string): UsageSession => {
  const sum = (key: SummedKey) => threads.reduce((total, thread) => total + thread[key], 0);
  const byRequests = (key: 'models' | 'providers') => {
    const counts = new Map<string, number>();
    threads.forEach((thread) => thread[key].forEach((value) => counts.set(value, (counts.get(value) ?? 0) + thread.requests)));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value);
  };
  const own = threads.find((thread) => thread.id === id);
  const lastActiveAtMs = Math.max(...threads.map((thread) => thread.lastActiveAtMs));
  return {
    id, parentId: null, depth: 0,
    models: byRequests('models'), providers: byRequests('providers'),
    userAgent: (own ?? threads[0])?.userAgent ?? null, peakContext: 0, compactions: 0,
    startedAtMs: Math.min(...threads.map((thread) => thread.startedAtMs)), lastActiveAtMs,
    requests: sum('requests'), failures: sum('failures'), canceled: sum('canceled'),
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), reasoningTokens: sum('reasoningTokens'),
    cacheReadTokens: sum('cacheReadTokens'), cacheCreationTokens: sum('cacheCreationTokens'), totalTokens: sum('totalTokens'),
    estimatedCost: sum('estimatedCost'), pricedRequests: sum('pricedRequests'),
    provider: byRequests('providers')[0] ?? '', machine, pool: machine ? 'Laptops' : '', apiKeyHash: machine ? 'hash-casey' : '',
    active: lastActiveAtMs >= Date.now() - 5 * 60_000, hasOwnRequests: Boolean(own), subagents: threads.filter((thread) => thread.id !== id).length,
    threads, transcript: null,
  };
};

const usageSessions: UsageSession[] = [
  ...(heavyScenario ? [
    {
      ...mockSession('9c9d9117-4e2a-4b8c-9d1e-2f3a4b5c6d7e', [
        { ...sessionThread('9c9d9117-4e2a-4b8c-9d1e-2f3a4b5c6d7e', null, 0, 'claude-opus-5-5', sessionAgents.claudeHosted, 58, 58, 4_100), estimatedCost: 744.2 },
        { ...sessionThread('4b5c6d7e-8f90-4a1b-9c2d-3e4f5a6b7c8d', '9c9d9117-4e2a-4b8c-9d1e-2f3a4b5c6d7e', 1, 'claude-haiku-4-5', sessionAgents.claudeHosted, 40, 40, 2_690), estimatedCost: 24.9 },
      ], 'Cedar 01'),
      pool: 'Cedar', apiKeyHash: 'hash-desk-cedar',
    },
    {
      ...mockSession('2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f', [
        sessionThread('2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f', null, 0, 'claude-opus-5-5', sessionAgents.claudeHosted, 30, 25, 48),
      ], 'Cedar 01'),
      pool: 'Cedar', apiKeyHash: 'hash-desk-cedar',
    },
  ] : []),
  mockSession('a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7', [
    sessionThread('a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7', null, 0, 'claude-opus-5-5', sessionAgents.claudeCode, 94, 93, 400, 1),
    sessionThread('9c1e7a20-44b1-4d3e-9f10-3a4b5c6d7e8f', 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7', 1, 'claude-haiku-4-5', sessionAgents.claudeCode, 80, 6, 82),
    sessionThread('3e8b0f51-7c2a-4e19-b6d4-4b5c6d7e8f90', '9c1e7a20-44b1-4d3e-9f10-3a4b5c6d7e8f', 2, 'claude-haiku-4-5', sessionAgents.claudeCode, 78, 3, 34),
    sessionThread('d0a47c93-18e5-4b2f-a7c1-5c6d7e8f9012', 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7', 1, 'claude-sonnet-5', sessionAgents.claudeCode, 35, 12, 116),
  ], 'casey-mbp'),
  mockSession('0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', [
    sessionThread('0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', null, 0, 'gpt-6-sol', sessionAgents.codexHosted, 70, 45, 240),
  ], 'casey-mbp'),
  mockSession('6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c', [
    sessionThread('6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c', null, 0, 'claude-opus-5-5', sessionAgents.claudeCode, 320, 50, 310),
  ], 'casey-mbp'),
  mockSession('b7e24c19-0d3a-4f6e-9b21-c4d5e6f7a8b9', [
    sessionThread('b7e24c19-0d3a-4f6e-9b21-c4d5e6f7a8b9', null, 0, 'claude-opus-5-5', sessionAgents.agentSdk, 180, 40, 190),
    sessionThread('7d20c3b4-81e2-8a5f-b6c7-d8e9f0a1b2c3', 'b7e24c19-0d3a-4f6e-9b21-c4d5e6f7a8b9', 1, 'claude-haiku-4-5', sessionAgents.agentSdk, 150, 8, 44),
  ], 'ci-runner'),
  mockSession('0199a0f4-6e21-7c3d-9a8b-1c2d3e4f5a6b', [
    sessionThread('0199a0f4-6e21-7c3d-9a8b-1c2d3e4f5a6b', null, 0, 'gpt-6-luna', sessionAgents.codexExec, 230, 18, 74, 3),
  ], 'ci-runner'),
  mockSession('0199a05d-91c2-7b4a-8e6f-2d3e4f5a6b7c', [
    sessionThread('0199a05d-91c2-7b4a-8e6f-2d3e4f5a6b7c', null, 0, 'gpt-6-sol', sessionAgents.codexApp, 400, 55, 260),
  ], ''),
  mockSession('d4c3b2a1-7f6e-4d5c-9b8a-e1f2a3b4c5d6', [
    sessionThread('d4c3b2a1-7f6e-4d5c-9b8a-e1f2a3b4c5d6', null, 0, 'claude-sonnet-5', sessionAgents.claudePrint, 1_500, 2, 8),
  ], 'casey-mbp'),
  // Only its subagents made requests in the window, so the session itself has none of its own.
  mockSession('e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b', [
    sessionThread('1a2b3c4d-5e6f-8a7b-9c8d-0e1f2a3b4c5d', 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b', 1, 'claude-opus-5-5', sessionAgents.claudeCode, 2_900, 20, 180),
    sessionThread('7b6c5d4e-3f2a-4b1c-8d9e-1f2a3b4c5d6e', 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b', 1, 'claude-haiku-4-5', sessionAgents.claudeCode, 2_880, 10, 40),
  ], 'casey-mbp'),
];
if (freshInstall) usageSessions.length = 0;

// Which account each mock session's requests went through: Claude sessions on the Max account, Codex ones on the team's.
const sessionAccount = (session: UsageSession) => (session.provider === 'claude' ? 'claude-1' : 'codex-2');

// What the Sessions page's own filters look at, as session_filters.rs works it out.
const sessionFacts = (session: UsageSession) => {
  const { transcript } = session;
  const agent = session.userAgent ?? '';
  const client = sessionClient(agent);
  const project = sessionPlace(transcript)?.project ?? null;
  const machine = session.machine || transcript?.machine || '';
  const text = [
    project, client ? [client.name, client.host].filter(Boolean).join(' · ') : '', agent, machine, session.provider,
    ...session.models, session.id, ...session.threads.map((thread) => thread.id),
    transcript?.title, transcript?.cwd, transcript?.branch, transcript?.repositoryUrl,
    ...(transcript?.pullRequests ?? []).map((link) => `#${link.number} ${link.url} ${link.repository}`),
  ].filter(Boolean).join('\n').toLowerCase();
  return {
    project, branch: transcript?.branch ?? '', machine, pullRequests: Boolean(transcript?.pullRequests.length), text,
    client: client ? [client.name, client.host].filter(Boolean).join(' · ') : null,
  };
};

type SessionFacet = 'project' | 'branch' | 'client' | 'machine' | 'pullRequests';

type SessionSort = 'estimatedCost' | 'totalTokens' | 'requests' | 'lastActiveAtMs';

const sessionFilterMatches = (query: UsageQuery, facts: ReturnType<typeof sessionFacts>, except?: SessionFacet) => {
  const terms = (query.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  // Picking another project clears the branch, so the project menu counts without it.
  const applies = (facet: SessionFacet) => except !== facet && !(except === 'project' && facet === 'branch');
  return terms.every((term) => facts.text.includes(term))
    && (!applies('project') || !query.project || facts.project === query.project)
    && (!applies('branch') || !query.branch || facts.branch === query.branch)
    && (!applies('client') || !query.client || facts.client === query.client)
    && (!applies('machine') || !query.machine || (query.machine === '__unassigned__' ? !facts.machine : facts.machine === query.machine))
    && (!applies('pullRequests') || !query.pull_requests || facts.pullRequests === (query.pull_requests === 'with'));
};

const rankedFacet = (values: (string | null)[]) => {
  const counts = new Map<string, number>();
  values.forEach((value) => { if (value) counts.set(value, (counts.get(value) ?? 0) + 1); });
  return [...counts.entries()].map(([value, sessions]) => ({ value, sessions })).sort((a, b) => b.sessions - a.sessions || a.value.localeCompare(b.value));
};

const sessionFacets = (query: UsageQuery, sessions: UsageSession[]): SessionFacets => {
  const facts = sessions.map(sessionFacts);
  const matching = (except: SessionFacet) => facts.filter((item) => sessionFilterMatches(query, item, except));
  return {
    projects: rankedFacet(matching('project').map((item) => item.project)),
    branches: query.project ? rankedFacet(matching('branch').map((item) => item.branch)) : [],
    clients: rankedFacet(matching('client').map((item) => item.client)),
    machines: rankedFacet(matching('machine').map((item) => item.machine)),
    withPullRequests: matching('pullRequests').filter((item) => item.pullRequests).length,
    withoutPullRequests: matching('pullRequests').filter((item) => !item.pullRequests).length,
  };
};

// Each session's requests as get_usage_session_timeline returns them, made up from its threads: context that grows and
// is compacted, side requests, a failure streak, a model tier switch, and an idle stretch that lets the cache go cold.
// Seeded by thread id, so a session looks the same on every refresh.
const seededRandom = (seed: string) => {
  let state = [...seed].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16_777_619), 2_166_136_261) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

// USD per million tokens.
const timelinePrices: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'gpt-6-sol': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-6-luna': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
};

const mockLongContext: Record<string, number> = { 'gpt-6-sol': 272_000, 'gpt-6-luna': 272_000 };

const mockThreadRequests = (thread: UsageSessionThread, main: boolean): SessionRequest[] => {
  const { id } = thread;
  const model = thread.models[0] ?? '';
  const claude = model.startsWith('claude');
  const random = seededRandom(id);
  const between = (low: number, high: number) => Math.round(low + random() * (high - low));
  const { requests: count, failures, canceled, startedAtMs: start, lastActiveAtMs: end } = thread;
  // A long main thread sits idle for 34 minutes a quarter of the way in, while none of its subagents run.
  const idle = main && end - start >= 80 * 60_000 ? { from: start + (end - start) * 0.25, ms: 34 * 60_000 } : null;
  const spacing = (end - start - (idle?.ms ?? 0)) / Math.max(1, count - 1);
  const failAt = Math.floor(count * 0.4);
  const threshold = mockLongContext[model] ?? 0;
  const compactAbove = claude ? between(340_000, 368_000) : 300_000;
  const requests: SessionRequest[] = [];
  let context = claude ? 18_000 : 14_000;
  let previousContext = 0;
  let compactNext = false;
  let wasIdle = false;
  // The first conversation request after the idle stretch finds the cache gone.
  let coldCache = false;
  for (let index = 0; index < count; index += 1) {
    let timestampMs = start + index * spacing;
    const afterIdle = Boolean(idle && timestampMs >= idle.from);
    if (afterIdle) timestampMs += idle!.ms;
    if (afterIdle && !wasIdle) coldCache = true;
    wasIdle = afterIdle;
    // Codex threads move to the fast tier part way through; the long Claude thread to xhigh effort.
    const serviceTier = !claude && main && index >= count * 0.45 ? 'priority' : '';
    const reasoningEffort = claude ? (main ? (index >= count * 0.3 ? 'xhigh' : 'high') : 'medium') : 'high';
    const base = { timestampMs: Math.round(timestampMs), threadId: id, model, serviceTier, ttftMs: between(600, 2_400), reasoningTokens: 0 };
    if (index >= failAt && index < failAt + failures + canceled) {
      const cancel = index >= failAt + failures;
      requests.push({
        ...base, reasoningEffort, latencyMs: cancel ? between(4_000, 20_000) : between(200, 900), ttftMs: null,
        failed: !cancel, canceled: cancel, failureStatus: cancel ? 0 : 529,
        failure: cancel ? '' : '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: null, longContext: false, step: null,
      });
      continue;
    }
    // Claude Code asks for a title or summary now and then, outside the conversation.
    const side = claude && main && index % 23 === 11 && !compactNext;
    let input: number;
    let cacheRead: number;
    let output: number;
    let step: ContextStep;
    if (side) {
      input = between(4_000, 9_000);
      cacheRead = 0;
      output = between(40, 220);
      step = 'side';
    } else if (compactNext) {
      compactNext = false;
      context = claude ? between(65_000, 118_000) : between(40_000, 70_000);
      input = context;
      cacheRead = Math.min(context, claude ? 18_000 : 14_000);
      output = between(300, 2_500);
      step = 'compacted';
      coldCache = false;
    } else {
      if (index > 0) context += between(claude ? 800 : 1_200, claude ? 6_500 : 7_000);
      input = context;
      cacheRead = index === 0 || coldCache ? 0 : Math.min(previousContext, context - between(400, 2_000));
      coldCache = false;
      const summarize = context >= compactAbove;
      output = summarize ? between(10_000, 28_000) : between(200, 3_500);
      if (summarize) compactNext = true;
      step = 'conversation';
    }
    const cacheWrite = claude ? Math.max(0, input - cacheRead - between(200, 900)) : 0;
    const longContext = Boolean(threshold && input > threshold);
    const price = timelinePrices[model];
    const scale = (serviceTier === 'priority' ? 2 : 1) / 1_000_000;
    const inputScale = scale * (longContext ? 2 : 1);
    requests.push({
      ...base, reasoningEffort: side ? '' : reasoningEffort, latencyMs: between(1_500, side ? 3_000 : 14_000),
      failed: false, canceled: false, failureStatus: 0, failure: '',
      inputTokens: input, outputTokens: output, reasoningTokens: Math.round(output * 0.3), cacheReadTokens: cacheRead, cacheCreationTokens: cacheWrite,
      cost: price ? {
        input: Math.max(0, input - cacheRead - cacheWrite) * price.input * inputScale,
        cacheRead: cacheRead * price.cacheRead * inputScale,
        cacheWrite: cacheWrite * price.cacheWrite * inputScale,
        output: output * price.output * scale * (longContext ? 1.5 : 1),
      } : null,
      longContext, step,
    });
    if (step !== 'side') previousContext = context;
  }
  return requests;
};

const sessionRequests = new Map<string, SessionRequest[]>();

const mockSessionRequests = (session: UsageSession): SessionRequest[] => {
  const { id } = session;
  let requests = sessionRequests.get(id);
  if (!requests) {
    requests = session.threads
      .flatMap((thread) => mockThreadRequests(thread, thread.id === id))
      .sort((a, b) => a.timestampMs - b.timestampMs);
    sessionRequests.set(id, requests);
  }
  return requests;
};
// The list shows each thread's peak context and compactions, from the same requests the detail charts.
for (const session of usageSessions) {
  const requests = mockSessionRequests(session);
  const stats = (threadId: string) => {
    const own = requests.filter((request) => request.threadId === threadId && (request.step === 'conversation' || request.step === 'compacted'));
    return {
      peakContext: own.reduce((peak, request) => Math.max(peak, request.inputTokens), 0),
      compactions: own.filter((request) => request.step === 'compacted').length,
    };
  };
  session.threads.forEach((thread) => Object.assign(thread, stats(thread.id)));
  Object.assign(session, stats(session.id));
}

// What each session's transcript says, as the machines' transcript scans store it. Two weren't found: a codex exec run
// with a throwaway CODEX_HOME, and a session seen only through its subagents.
const mockTranscript = (fields: Partial<SessionTranscript>): SessionTranscript => ({
  machine: 'casey-mbp', agent: 'claude', home: '/Users/casey', agentHome: '~/.claude', cwd: '', repoRoot: '', mainRepo: '', branch: '', commitHash: '', repositoryUrl: '',
  title: '', titleSource: '', pullRequests: [], linesAdded: null, linesRemoved: null, compactions: [], toolUsage: null, readAtMs: now - 2 * 60_000,
  ...fields,
});

// What each session called, by tool name. Claude Code sessions list their subagents' calls apart; Codex doesn't name
// its subagents' types, and its tools from an app or MCP server come in a namespace.
const toolUsage = (
  tools: Record<string, number>,
  subagentTools: Record<string, number> = {},
  subagents: Record<string, number> = {},
  skills: Record<string, number> = {},
  typed: string[] = [],
): ToolUsage => ({
  tools, subagentTools, subagents, skills, usedSkills: [...new Set([...Object.keys(skills), ...typed])].sort(),
});

const sessionTranscripts: Record<string, SessionTranscript> = {
  '9c9d9117-4e2a-4b8c-9d1e-2f3a4b5c6d7e': mockTranscript({
    machine: 'Cedar 01', home: '/home/casey', cwd: '/home/casey/src/billing/worker', repoRoot: '/home/casey/src/billing', mainRepo: '/home/casey/src/billing',
    branch: 'feat/queue-worker', title: 'Move the billing worker onto queues', titleSource: 'custom',
    pullRequests: [
      { number: 88, url: 'https://github.com/acme/billing/pull/88', repository: 'acme/billing' },
      { number: 91, url: 'https://github.com/acme/billing/pull/91', repository: 'acme/billing' },
    ],
    linesAdded: 1_842, linesRemoved: 906,
    toolUsage: toolUsage({ Bash: 58, Read: 31, Edit: 12, Agent: 1, Skill: 3 }, { Read: 22, Grep: 9 }, { Explore: 1 }, { pdf: 2, 'superpowers:brainstorming': 1 }, ['release-notes']),
  }),
  'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7': mockTranscript({
    agentHome: '~/.agent-app/homes/claude-proxy', cwd: '/Users/casey/.t3/worktrees/arbor/login-loop', repoRoot: '/Users/casey/.t3/worktrees/arbor/login-loop', mainRepo: '/Users/casey/src/arbor',
    branch: 'fix/login-loop', title: 'Fix the login redirect loop', titleSource: 'ai',
    pullRequests: [
      { number: 412, url: 'https://github.com/acme/arbor/pull/412', repository: 'acme/arbor' },
      { number: 415, url: 'https://github.com/acme/arbor/pull/415', repository: 'acme/arbor' },
    ],
    linesAdded: 214, linesRemoved: 37,
    toolUsage: toolUsage(
      { Bash: 412, Read: 188, Edit: 96, Grep: 64, TodoWrite: 14, Write: 21, Agent: 3, WebSearch: 3, 'mcp__github__create_pull_request': 2, 'mcp__t3-code__preview_snapshot': 4, Skill: 1 },
      { Read: 240, Grep: 131, Glob: 42, Bash: 38, WebFetch: 6 },
      { Explore: 2 },
    ),
  }),
  // Codex carries on with the branch a Claude Code session opened a pull request from; Codex doesn't record pull requests.
  '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b': mockTranscript({
    agent: 'codex', agentHome: '~/.codex', cwd: '/Users/casey/src/proxy', repoRoot: '/Users/casey/src/proxy', mainRepo: '/Users/casey/src/proxy', branch: 'feat/rate-limiter',
    commitHash: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b', repositoryUrl: 'git@github.com:acme/proxy.git', title: 'Rate limiter for the proxy', titleSource: 'codex',
    toolUsage: toolUsage({ exec_command: 184, apply_patch: 37, update_plan: 9, web_search: 4, 'collaboration/spawn_agent': 2, 'collaboration/wait_agent': 2, 'mcp__codex_apps__github/_create_pull_request': 1 }),
  }),
  '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c': mockTranscript({
    cwd: '/Users/casey/src/proxy', repoRoot: '/Users/casey/src/proxy', mainRepo: '/Users/casey/src/proxy', branch: 'feat/rate-limiter',
    repositoryUrl: 'git@github.com:acme/proxy.git', title: 'Add a token bucket to the proxy', titleSource: 'ai',
    pullRequests: [
      { number: 57, url: 'https://github.com/acme/proxy/pull/57', repository: 'acme/proxy' },
      { number: 52, url: 'https://github.com/acme/proxy/pull/52', repository: 'acme/proxy' },
    ],
    linesAdded: 386, linesRemoved: 52, readAtMs: now - 3 * 60_000,
    toolUsage: toolUsage({ Bash: 71, Read: 44, Edit: 19, Write: 3, TodoWrite: 5 }),
  }),
  'b7e24c19-0d3a-4f6e-9b21-c4d5e6f7a8b9': mockTranscript({
    machine: 'ci-runner', home: '/home/runner', cwd: '/home/runner/work/arbor/arbor', repoRoot: '/home/runner/work/arbor/arbor', mainRepo: '/home/runner/work/arbor/arbor',
    branch: 'renovate/tauri-2.x', linesAdded: 12, linesRemoved: 4, readAtMs: now - 4 * 60_000,
    pullRequests: [{ number: 418, url: 'https://github.com/acme/arbor/pull/418', repository: 'acme/arbor' }],
    toolUsage: toolUsage({ Bash: 12, Read: 6, Edit: 2 }),
  }),
  '0199a05d-91c2-7b4a-8e6f-2d3e4f5a6b7c': mockTranscript({
    machine: 'studio', agent: 'codex', agentHome: '~/.codex', cwd: '/Users/casey/src/docs', repoRoot: '/Users/casey/src/docs', mainRepo: '/Users/casey/src/docs', branch: 'main',
    repositoryUrl: 'https://github.com/acme/docs.git', title: 'Draft the 0.3 release notes', titleSource: 'codex', readAtMs: now - 3 * 60_000,
    toolUsage: toolUsage({}),
  }),
  // Its folder was a review worktree that was gone by the time Arbor looked, so only the transcript's branch is known.
  'd4c3b2a1-7f6e-4d5c-9b8a-e1f2a3b4c5d6': mockTranscript({
    cwd: '/Users/casey/.local/share/reviews/review-7/review-7', branch: 'review-7', readAtMs: now - 23 * 3_600_000,
    pullRequests: [
      { number: 407, url: 'https://github.com/acme/arbor/pull/407', repository: 'acme/arbor' },
      { number: 409, url: 'https://github.com/acme/arbor/pull/409', repository: 'acme/arbor' },
    ],
  }),
};
for (const session of usageSessions) {
  const transcript = sessionTranscripts[session.id] ?? null;
  session.transcript = transcript;
  if (!transcript) continue;
  // The agent writes down each compaction of the main conversation; Codex doesn't say what started one, or its sizes.
  const main = mockSessionRequests(session).filter((request) => request.threadId === session.id && (request.step === 'conversation' || request.step === 'compacted'));
  const compacted = main.flatMap((request, index) => (request.step === 'compacted' ? [{ request, before: main[index - 1] }] : []));
  transcript.compactions = compacted.map(({ request, before }, index) => {
    const atMs = request.timestampMs - 25_000;
    if (transcript.agent === 'codex') return { atMs, trigger: '', preTokens: null, postTokens: null, durationMs: null };
    const manual = compacted.length > 1 && index === compacted.length - 1;
    return { atMs, trigger: manual ? 'manual' : 'auto', preTokens: before?.inputTokens ?? 0, postTokens: request.inputTokens, durationMs: 31_000 + (index % 4) * 9_000 };
  });
  session.compactions = Math.max(session.compactions, transcript.compactions.length);
}

// The sessions running now as get_live_sessions returns them: each one's last hour, and where its conversation is
// heading. One is about to compact where it did before, one heads for a learned point, and Codex has none to head for.
// ?live=none shows the board with nothing running; ?live=ends has them stop a minute after the page loads.
const liveContexts: Record<string, { cost: number; requests: number; context: LiveContext }> = {
  '9c9d9117-4e2a-4b8c-9d1e-2f3a4b5c6d7e': {
    cost: 97.4, requests: 1_140,
    context: { tokens: 287_500, model: 'claude-opus-5-5', compactsAt: 365_000, basis: 'learned', growthPerMinute: 11_800, compactsInMs: 394_000 },
  },
  'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7': {
    cost: 72.6, requests: 380,
    context: { tokens: 212_400, model: 'claude-opus-5-5', compactsAt: 365_000, basis: 'learned', growthPerMinute: 8_400, compactsInMs: 1_090_000 },
  },
  'b7e24c19-0d3a-4f6e-9b21-c4d5e6f7a8b9': {
    cost: 34.5, requests: 190,
    context: { tokens: 341_000, model: 'claude-opus-5-5', compactsAt: 358_000, basis: 'session', growthPerMinute: 9_200, compactsInMs: 110_000 },
  },
  '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b': {
    cost: 12.9, requests: 240,
    context: { tokens: 96_300, model: 'gpt-6-sol', compactsAt: null, basis: '', growthPerMinute: 3_100, compactsInMs: null },
  },
};

const liveEndsAtMs = now + 60_000;

const mockLiveSessions = (): LiveSessionsReport => {
  if (params.get('live') === 'none' || (params.get('live') === 'ends' && Date.now() >= liveEndsAtMs)) {
    return { sessions: [], running: 0, costPerHour: 0, requests: 0, pricedRequests: 0, clients: [] };
  }
  const sessions = usageSessions
    .flatMap((session) => {
      const live = liveContexts[session.id];
      if (!live) return [];
      return [{
        ...session, active: true, lastActiveAtMs: Date.now() - 40_000, requests: live.requests, estimatedCost: noPrices ? 0 : live.cost,
        pricedRequests: noPrices ? 0 : live.requests, runningSinceMs: session.startedAtMs, context: live.context,
      }];
    })
    .sort((a, b) => b.estimatedCost - a.estimatedCost);
  const total = (key: 'estimatedCost' | 'requests' | 'pricedRequests') => sessions.reduce((sum, session) => sum + session[key], 0);
  return {
    sessions, running: sessions.length, costPerHour: total('estimatedCost'), requests: total('requests'), pricedRequests: total('pricedRequests'),
    clients: sessions.map((session) => session.userAgent ?? ''),
  };
};

// The sessions waiting on their user, as the live board's sources read them from the reporters' events: a Claude Code
// session asking for permission, a Codex one done with its turn, and a Claude Code session whose requests didn't come
// through Arbor. ?attention=none shows nothing waiting; ?attention=question has the first one asking a question.
// Each wait began at a fixed time, as an event's does, so it's alerted once.
const attentionStart = Date.now();

const mockAgentAttention = (): AgentAttentionReport => {
  const reporting = Object.keys(reporterInstalled).filter((machine) => reporterInstalled[machine]);
  if (params.get('attention') === 'none') return { items: [], reporting };
  const session = (id: string) => usageSessions.find((item) => item.id === id) ?? null;
  const items: Omit<AttentionItem, 'session'>[] = [
    { machine: 'casey-mbp', agent: 'claude', sessionId: 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7', kind: params.get('attention') === 'question' ? 'question' : 'permission', sinceMs: attentionStart - 3 * 60_000 - 12_000 },
    { machine: 'casey-mbp', agent: 'codex', sessionId: '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', kind: 'waiting', sinceMs: attentionStart - 8 * 60_000 },
    { machine: 'cedar-02', agent: 'claude', sessionId: 'e5d4c3b2-a190-4f8e-9d7c-6b5a4f3e2d1c', kind: 'waiting', sinceMs: attentionStart - 41 * 60_000 },
  ];
  return {
    items: items.filter((item) => reporterInstalled[item.machine]).map((item) => ({ ...item, session: item.sessionId.startsWith('e5d4') ? null : session(item.sessionId) })),
    reporting,
  };
};

// What get_fleet_sources returns for the live fleet board: T3 Code's threads, the reporters' waits and the proxy
// sessions active in the last six hours. On casey-mbp T3 Code has a Claude thread asking to run a command (the Claude
// Code session a3f1…, whose reporter wait is the same one), one asking a question, a Codex plan ready to build and one
// filed away; on cedar-02 a Codex thread is working. The reporters add a Codex session done with its turn and a
// Claude Code session on cedar-02 whose requests didn't come through Arbor; the proxy adds a Codex run on ci-runner
// whose last request failed and a few idle sessions. `?fleet=` changes it (listed at the top).
export const fleetScenario = params.get('fleet') ?? '';

const T3_PROXY_THREAD = 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7';

const t3Turn = (state: string, requestedMinutesAgo: number, completedMinutesAgo: number | null = null): T3Turn => ({
  state, requestedAtMs: now - requestedMinutesAgo * 60_000, startedAtMs: now - requestedMinutesAgo * 60_000 + 1_400,
  completedAtMs: completedMinutesAgo === null ? null : now - completedMinutesAgo * 60_000,
});

const t3Thread = (fields: Partial<T3Thread>): T3Thread => ({
  threadId: '', projectId: '', workspaceRoot: null, provider: 'claudeAgent', sessionStatus: 'ready', sessionUpdatedAtMs: null,
  pendingApprovals: 0, pendingQuestions: 0, approvalSinceMs: null, latestApprovalAtMs: null, questionSeenAtMs: null, interactionMode: 'default',
  hasActionablePlan: false, turn: null, latestUserMessageAtMs: null, settled: false, t3SnoozedUntilMs: null, t3SnoozedAtMs: null,
  updatedAtMs: now, agentSessionId: null, arborSession: null,
  ...fields,
});

const t3Channel = (machine: string, readAgoMs: number, threads: T3Thread[]): T3Channel => ({
  machine, channel: 'userdata', readAtMs: Date.now() - readAgoMs, serverRunning: true, readMode: 'readonly', skipped: null, threads,
});

const defaultT3Channels = (): T3Channel[] => {
  const proxied = usageSessions.find((item) => item.id === T3_PROXY_THREAD);
  return [
    t3Channel('casey-mbp', 3_000, [
      t3Thread({
        threadId: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', projectId: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e', workspaceRoot: '/Users/casey/src/arbor',
        sessionStatus: 'running', sessionUpdatedAtMs: now - 3 * 60_000, pendingApprovals: 1, approvalSinceMs: attentionStart - 3 * 60_000 - 12_000,
        latestApprovalAtMs: attentionStart - 3 * 60_000 - 12_000, turn: t3Turn('running', 9), latestUserMessageAtMs: now - 9 * 60_000, updatedAtMs: now - 3 * 60_000, agentSessionId: T3_PROXY_THREAD,
        arborSession: proxied ? { id: T3_PROXY_THREAD, lastActiveAtMs: proxied.lastActiveAtMs, lastRequestFailed: false } : null,
      }),
      t3Thread({
        threadId: '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d', projectId: 'c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f', workspaceRoot: '/Users/casey/src/proxy',
        sessionStatus: 'running', sessionUpdatedAtMs: now - 2 * 60_000, pendingQuestions: 1, questionSeenAtMs: attentionStart - 95_000,
        turn: t3Turn('running', 6), latestUserMessageAtMs: now - 6 * 60_000, updatedAtMs: now - 2 * 60_000,
        agentSessionId: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
      }),
      t3Thread({
        threadId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a', projectId: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e', workspaceRoot: '/Users/casey/src/arbor',
        provider: 'codex', sessionUpdatedAtMs: now - 12 * 60_000, interactionMode: 'plan', hasActionablePlan: true,
        turn: t3Turn('completed', 21, 12), latestUserMessageAtMs: now - 21 * 60_000, updatedAtMs: now - 12 * 60_000,
        agentSessionId: '0199a2c3-d4e5-7f6a-8b7c-9d0e1f2a3b4c',
        // Snoozed in T3 Code itself after the plan was ready, until tomorrow.
        ...(fleetScenario === 'snoozed' ? { t3SnoozedUntilMs: now + 16 * 3_600_000, t3SnoozedAtMs: now - 10 * 60_000 } : {}),
      }),
      t3Thread({
        threadId: '4f5e6d7c-8b9a-4f0e-9d1c-2b3a4f5e6d7c', projectId: 'c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f', workspaceRoot: '/Users/casey/src/proxy',
        sessionStatus: 'stopped', sessionUpdatedAtMs: now - 170 * 60_000, turn: t3Turn('completed', 190, 172), settled: true,
        latestUserMessageAtMs: now - 190 * 60_000, updatedAtMs: now - 170 * 60_000, agentSessionId: '8a9b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d',
      }),
    ]),
    t3Channel('cedar-02', 12_000, [
      t3Thread({
        threadId: '6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e', projectId: 'd3e4f5a6-b7c8-4d9e-8f0a-1b2c3d4e5f6a', workspaceRoot: '/home/casey/src/billing',
        provider: 'codex', sessionStatus: 'running', sessionUpdatedAtMs: now - 4 * 60_000, turn: t3Turn('running', 4),
        latestUserMessageAtMs: now - 4 * 60_000, updatedAtMs: now - 30_000, agentSessionId: '0199b7c8-d9e0-7f1a-8b2c-3d4e5f6a7b8c',
      }),
    ]),
  ];
};

// `?fleet=many`: ten threads on each of four machines, in every state, across a few projects.
const manyT3Channels = (): T3Channel[] => {
  const states = ['approval', 'question', 'working', 'failed', 'done', 'idle', 'idle', 'working', 'done', 'idle'];
  const roots: Record<string, string> = { 'casey-mbp': '/Users/casey/src', 'cedar-02': '/home/casey/src', 'ci-01': '/home/ci/src', 'lab-box': '/home/lab/src' };
  return Object.entries(roots).map(([machine, root], machineIndex) => t3Channel(machine, 3_000 + machineIndex * 7_000, states.map((state, index) => {
    const minutes = 2 + index * 17 + machineIndex * 5;
    const id = `${String(machineIndex + 1).padStart(2, '0')}${String(index).padStart(6, '0')}-7c1d-4e2f-8a3b-4c5d6e7f8a9b`;
    const project = ['arbor', 'proxy', 'billing', 'docs'][(index + machineIndex) % 4]!;
    const running = state === 'approval' || state === 'question' || state === 'working';
    return t3Thread({
      threadId: id, projectId: `project-${project}`, workspaceRoot: `${root}/${project}`, provider: index % 2 ? 'codex' : 'claudeAgent',
      sessionStatus: state === 'failed' ? 'error' : running ? 'running' : 'ready', sessionUpdatedAtMs: now - minutes * 60_000,
      pendingApprovals: state === 'approval' ? 1 : 0, approvalSinceMs: state === 'approval' ? now - minutes * 60_000 : null,
      latestApprovalAtMs: state === 'approval' ? now - minutes * 60_000 : null,
      pendingQuestions: state === 'question' ? 1 : 0, questionSeenAtMs: state === 'question' ? now - minutes * 60_000 : null,
      turn: t3Turn(running ? 'running' : state === 'failed' ? 'error' : 'completed', minutes + 6, running ? null : minutes),
      settled: state === 'idle' && index > 6, updatedAtMs: now - minutes * 60_000,
    });
  })));
};

// Follows set_t3_threads_enabled, as the backend does: off, T3 Code's threads aren't read.
let mockT3Enabled = true;
/** Settings › Machines turns T3 Code's threads off the board and back on. */
export const setMockT3Enabled = (enabled: boolean) => {
  mockT3Enabled = enabled;
};

// `?fleet=not3`: no machine has T3 Code, so neither the board nor Settings mentions it.
const mockT3Found = fleetScenario !== 'not3' && !freshInstall;

let fleetReads = 0;

const skippedT3: Record<string, Skipped> = {
  schema: { reason: 'migrationRange', migration: 57 },
  older: { reason: 'migrationRange', migration: 30 },
  unrecognized: { reason: 'schema', migration: 54 },
  unreadable: { reason: 'unreadable', migration: null },
};

// `?fleet=queued`: a message sent a few seconds ago that T3 Code hasn't started a turn for.
const queuedT3Thread = () => t3Thread({
  threadId: '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b', projectId: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e', workspaceRoot: '/Users/casey/src/arbor',
  sessionUpdatedAtMs: Date.now() - 8 * 60_000, turn: t3Turn('completed', 14, 8), latestUserMessageAtMs: Date.now() - 20_000,
  updatedAtMs: Date.now() - 20_000, agentSessionId: '6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c',
});

const mockFleetSources = (): FleetSources => {
  fleetReads += 1;
  if (fleetScenario === 'fail' || (fleetScenario === 'failafter' && fleetReads > 1)) throw 'Failed to read the fleet: database is locked';
  const nowMs = Date.now();
  const attention = mockAgentAttention();
  if (fleetScenario === 'empty') {
    return { nowMs, thisMachine: 'casey-mbp', t3Enabled: mockT3Enabled, t3Found: mockT3Found, t3: [], attention: { items: [], reporting: attention.reporting }, sessions: [] };
  }
  const t3 = !mockT3Enabled || !mockT3Found ? [] : (fleetScenario === 'many' ? manyT3Channels() : defaultT3Channels()).map((channel): T3Channel => {
    const { machine, threads } = channel;
    // T3 Code quit without cleaning up: its database still says running, but its process is gone.
    if (fleetScenario === 't3down') return { ...channel, serverRunning: false };
    const skipped = skippedT3[fleetScenario];
    if (skipped && machine === 'casey-mbp') return { ...channel, skipped, threads: [] };
    if (fleetScenario === 'nosqlite' && machine === 'cedar-02') {
      return { ...channel, serverRunning: false, skipped: { reason: 'noSqlite3', migration: null }, threads: [] };
    }
    // Its last snapshot, from before it stopped answering.
    if (fleetScenario === 'quiet' && machine === 'cedar-02') return { ...channel, readAtMs: nowMs - 3 * 60_000 };
    if (fleetScenario === 'queued' && machine === 'casey-mbp') return { ...channel, threads: [...threads, queuedT3Thread()] };
    return channel;
  });
  const sessions = usageSessions
    .filter((session) => session.lastActiveAtMs >= nowMs - 6 * 3_600_000)
    .sort((a, b) => b.lastActiveAtMs - a.lastActiveAtMs)
    .map((session) => ({ session, lastRequestFailed: session.id === '0199a0f4-6e21-7c3d-9a8b-1c2d3e4f5a6b' }));
  return { nowMs, thisMachine: 'casey-mbp', t3Enabled: mockT3Enabled, t3Found: mockT3Found, t3, attention, sessions };
};

// The sessions a query's requests belong to, and those the Sessions page's own filters leave.
const mockSessionsMatching = (query: UsageQuery) => {
  const family = (query.model_family ?? '').toLowerCase();
  const inRequests = usageSessions
    .filter((item) => !query.session || item.id === query.session || item.threads.some((thread) => thread.id === query.session))
    .filter((item) => !query.auth_index || sessionAccount(item) === query.auth_index)
    .filter((item) => !family || item.models.some((model) => model.toLowerCase().includes(family)));
  return { inRequests, matching: inRequests.filter((item) => sessionFilterMatches(query, sessionFacts(item))) };
};

// The Machines page's sessions as machine_sessions.rs groups them: each on its key's machine, else its transcript's,
// machines by name and the unplaced ones last, each listing its latest five. ?machineLatest=2 lists fewer, to show the rest
// being counted.
const mockMachineSessions = (query: UsageQuery): MachineSessions[] => {
  const listed = Number(params.get('machineLatest') ?? 5);
  const machines = new Map<string, UsageSession[]>();
  const recent = mockSessionsMatching(query).matching.sort((a, b) => b.lastActiveAtMs - a.lastActiveAtMs);
  for (const session of recent) {
    const { machine } = sessionFacts(session);
    machines.set(machine, [...(machines.get(machine) ?? []), session]);
  }
  return [...machines.entries()]
    .sort(([a], [b]) => Number(!a) - Number(!b) || a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(([machine, sessions]) => {
      const total = (key: 'subagents' | 'requests' | 'totalTokens' | 'estimatedCost' | 'pricedRequests') => sessions.reduce((sum, item) => sum + item[key], 0);
      return {
        machine, sessions: sessions.length, subagents: total('subagents'), running: sessions.filter((item) => item.active).length,
        requests: total('requests'), totalTokens: total('totalTokens'), estimatedCost: total('estimatedCost'), pricedRequests: total('pricedRequests'),
        lastActiveAtMs: Math.max(...sessions.map((item) => item.lastActiveAtMs)), latest: sessions.slice(0, listed),
      };
    });
};

// What GitHub says about the mock pull requests, once the Projects view has asked. The open ones cover each way
// checks, reviews and merging can stand: #57 failing with changes requested and conflicts, #407 still running with a
// review required, #418 passing by GitHub's word alone (no counts) and approved, #409 with no checks at all, and
// drafts #415 and #91 failing with conflicts that aren't raised on a draft. #412 merged with its checks passing and
// #52 closed, neither shown once settled. With `?gh=detailfail`, GitHub turns that part down and none of it comes back.
type MockPullRequestState = Omit<PullRequestState, 'checkedAtMs'> & { headBranch: string };

const mockPullRequest = (fields: Partial<MockPullRequestState>): MockPullRequestState => ({
  state: 'open', draft: false, title: '', headBranch: '', baseBranch: 'main', mergedAtMs: null, closedAtMs: null,
  mergeable: 'mergeable', review: '', checks: null, ...fields,
});

const mockChecks = (rollup: PullRequestChecks['rollup'], passed: number, failed: number, pending: number, total = passed + failed + pending) => ({
  rollup, passed, failed, pending, total,
});

const mockPullRequestStates: Record<string, MockPullRequestState> = {
  'acme/arbor#412': mockPullRequest({
    state: 'merged', title: 'Fix the login redirect loop', headBranch: 'fix/login-loop', mergedAtMs: now - 40 * 60_000, closedAtMs: now - 40 * 60_000,
    review: 'approved', checks: mockChecks('success', 9, 0, 0),
  }),
  'acme/billing#88': mockPullRequest({
    state: 'merged', title: 'Move billing events onto a queue', headBranch: 'feat/queue-worker', mergedAtMs: now - 26 * 3_600_000, closedAtMs: now - 26 * 3_600_000,
  }),
  'acme/billing#91': mockPullRequest({
    draft: true, title: 'Retry failed invoices from the queue', headBranch: 'feat/queue-retries', mergeable: 'conflicting', checks: mockChecks('failure', 2, 1, 0),
  }),
  'acme/arbor#415': mockPullRequest({
    draft: true, title: 'Remember the last account on sign-in', headBranch: 'feat/remember-account', review: 'reviewRequired',
    mergeable: 'conflicting', checks: mockChecks('failure', 6, 2, 0, 9),
  }),
  'acme/proxy#52': mockPullRequest({
    state: 'closed', title: 'Rate limit by IP address', headBranch: 'feat/ip-limits', closedAtMs: now - 50 * 3_600_000, mergeable: '',
    checks: mockChecks('failure', 3, 1, 0),
  }),
  'acme/proxy#57': mockPullRequest({
    title: 'Token bucket rate limiter', headBranch: 'feat/rate-limiter', mergeable: 'conflicting', review: 'changesRequested',
    checks: mockChecks('failure', 4, 1, 1, 7),
  }),
  'acme/arbor#407': mockPullRequest({
    title: 'Show reset credits on Accounts', headBranch: 'feat/reset-credits', mergeable: '', review: 'reviewRequired', checks: mockChecks('pending', 5, 0, 2),
  }),
  'acme/arbor#409': mockPullRequest({ title: 'Fix a typo in the README', headBranch: 'docs/readme-typo' }),
  'acme/arbor#418': mockPullRequest({
    title: 'Update Tauri to 2.9', headBranch: 'renovate/tauri-2.x', review: 'approved', checks: mockChecks('success', 0, 0, 0, 0),
  }),
};

// Whether a pull request merged is all that comes back when GitHub turns down asking how open ones stand.
const mockPullRequestAnswer = (state: MockPullRequestState | null) =>
  state && githubScenario === 'detailfail' ? { ...state, mergeable: '' as const, review: '' as const, checks: null } : state;

const MOCK_DETAIL_ERROR = "Field 'checkRunCountsByState' doesn't exist on type 'StatusCheckRollupContextConnection'";

/** As the app sends a pull request GitHub has answered for: an empty state when it couldn't find it. */
const mockGithubState = (found: MockPullRequestState | null): PullRequestState => {
  const state = mockPullRequestAnswer(found) ?? mockPullRequest({ state: '', baseBranch: '', mergeable: '' });
  return {
    state: state.state, draft: state.draft, title: state.title, baseBranch: state.baseBranch, mergedAtMs: state.mergedAtMs,
    closedAtMs: state.closedAtMs, mergeable: state.mergeable, review: state.review, checks: state.checks, checkedAtMs: now,
  };
};

// The first look at the Projects view or a session's page asks GitHub, which takes a moment.
let mockGithubAskedAt: number | null = null;

let mockGithubAnswered = false;

const mockGithubStatus = (checkNow: boolean): GithubStatus => {
  if (checkNow || mockGithubAskedAt === null) mockGithubAskedAt = Date.now();
  const checking = Date.now() - mockGithubAskedAt < 1_500;
  if (githubScenario === 'ok' || githubScenario === 'detailfail') {
    if (!checking) mockGithubAnswered = true;
    return {
      checking, last: mockGithubAnswered ? 'ok' : '', message: '',
      detailError: mockGithubAnswered && githubScenario === 'detailfail' ? MOCK_DETAIL_ERROR : '',
      atMs: mockGithubAnswered ? mockGithubAskedAt + 1_500 : null,
    };
  }
  return {
    checking, last: githubScenario as GithubStatus['last'], detailError: '', atMs: mockGithubAskedAt + 1_500,
    message: githubScenario === 'failed' ? 'HTTP 502: Bad Gateway (https://api.github.com/graphql)' : '',
  };
};

/** Usage records, sessions and what they cost. */
type MockTotals = {
  sessions: number; active: number; requests: number; totalTokens: number; estimatedCost: number; pricedRequests: number;
  linesAdded: number; linesRemoved: number; sessionsWithLines: number; lastActiveAtMs: number;
};

const emptyTotals = (): MockTotals => ({
  sessions: 0, active: 0, requests: 0, totalTokens: 0, estimatedCost: 0, pricedRequests: 0, linesAdded: 0, linesRemoved: 0, sessionsWithLines: 0, lastActiveAtMs: 0,
});

const addTotals = (totals: MockTotals, session: UsageSession) => {
  const { transcript } = session;
  totals.sessions += 1;
  totals.active += session.active ? 1 : 0;
  totals.requests += session.requests;
  totals.totalTokens += session.totalTokens;
  totals.estimatedCost += session.estimatedCost;
  totals.pricedRequests += session.pricedRequests;
  if (transcript?.linesAdded != null && transcript.linesRemoved != null) {
    totals.linesAdded += transcript.linesAdded;
    totals.linesRemoved += transcript.linesRemoved;
    totals.sessionsWithLines += 1;
  }
  totals.lastActiveAtMs = Math.max(totals.lastActiveAtMs, session.lastActiveAtMs);
};

const costliest = <T extends MockTotals>(left: T, right: T) => right.estimatedCost - left.estimatedCost || right.lastActiveAtMs - left.lastActiveAtMs;

// The Projects view as projects.rs adds it up: sessions by project and branch, and their pull requests, each session's
// cost shared between the ones it named, or once GitHub has said, the ones from the branch it was on.
const mockProjectsReport = (sessions: UsageSession[], answered: boolean): Omit<SessionProjectsReport, 'github' | 'facets'> => {
  type Project = { totals: MockTotals; branches: Map<string, MockTotals>; repository: string | null };
  type PullRequest = { repository: string; number: number; url: string; project: string; branch: string; latestAt: number; shares: MockTotals };
  const projects = new Map<string, Project>();
  const unplaced = emptyTotals();
  const pullRequests = new Map<string, PullRequest>();
  const placed: { session: UsageSession; transcript: SessionTranscript; project: string; branch: string; named: string[] }[] = [];
  for (const session of sessions) {
    const { transcript } = session;
    const place = sessionPlace(transcript);
    if (!transcript || !place) {
      addTotals(unplaced, session);
      continue;
    }
    const project = projects.get(place.project) ?? { totals: emptyTotals(), branches: new Map(), repository: null };
    projects.set(place.project, project);
    addTotals(project.totals, session);
    const branch = project.branches.get(transcript.branch) ?? emptyTotals();
    project.branches.set(transcript.branch, branch);
    addTotals(branch, session);
    project.repository ??= place.repository ?? null;
    const at = session.lastActiveAtMs;
    const named = transcript.pullRequests.map((link) => {
      const key = `${link.repository.toLowerCase()}#${link.number}`;
      const known = pullRequests.get(key);
      if (!known || at > known.latestAt) {
        pullRequests.set(key, {
          repository: link.repository, number: link.number, url: link.url, shares: known?.shares ?? emptyTotals(),
          project: place.project, branch: transcript.branch, latestAt: at,
        });
      }
      return key;
    });
    placed.push({ session, transcript, project: place.project, branch: transcript.branch, named });
  }
  const stateOf = (pullRequest: PullRequest) => (answered ? mockPullRequestStates[`${pullRequest.repository}#${pullRequest.number}`] ?? null : null);
  const onBranch = new Map<string, string[]>();
  pullRequests.forEach((pullRequest, key) => {
    const head = stateOf(pullRequest)?.headBranch;
    if (head) onBranch.set(`${pullRequest.project}\n${head}`, [...(onBranch.get(`${pullRequest.project}\n${head}`) ?? []), key]);
  });
  for (const { session, transcript, project, branch, named } of placed) {
    const keys = named.length ? named : branch ? onBranch.get(`${project}\n${branch}`) ?? [] : [];
    for (const key of keys) {
      const shares = pullRequests.get(key)!.shares;
      shares.sessions += 1;
      shares.estimatedCost += session.estimatedCost / keys.length;
      shares.pricedRequests += session.pricedRequests;
      shares.linesAdded += (transcript.linesAdded ?? 0) / keys.length;
      shares.linesRemoved += (transcript.linesRemoved ?? 0) / keys.length;
      shares.lastActiveAtMs = Math.max(shares.lastActiveAtMs, session.lastActiveAtMs);
    }
  }
  return {
    projects: [...projects.entries()]
      .map(([name, project]) => ({
        name, repository: project.repository, ...project.totals,
        branches: [...project.branches.entries()].map(([branch, totals]) => ({ name: branch, ...totals })).sort(costliest),
      }))
      .sort(costliest),
    pullRequests: [...pullRequests.values()]
      .map((pullRequest) => {
        const state = stateOf(pullRequest);
        return {
          repository: pullRequest.repository, number: pullRequest.number, url: pullRequest.url, project: pullRequest.project,
          branch: state?.headBranch || pullRequest.branch, sessions: pullRequest.shares.sessions, estimatedCost: pullRequest.shares.estimatedCost,
          pricedRequests: pullRequest.shares.pricedRequests,
          linesAdded: Math.round(pullRequest.shares.linesAdded), linesRemoved: Math.round(pullRequest.shares.linesRemoved),
          lastActiveAtMs: pullRequest.shares.lastActiveAtMs,
          github: answered ? mockGithubState(state) : null,
        };
      })
      .sort((left, right) => right.lastActiveAtMs - left.lastActiveAtMs),
    unplaced,
  };
};

export const usageAnswers: CommandAnswers<UsageCommands> = {
  get_usage_machine_assignments: () => freshInstall ? [] : [
    { api_key_hash: 'a1b2', label: 'Casey laptop', machine: 'casey-mbp', pool: 'dev' },
    { api_key_hash: 'c3d4', label: 'CI runner', machine: 'ci-01', pool: 'ci' },
  ],
  save_usage_machine_assignments: () => null,
  record_limit_samples: (args) => { mockLog('limit_history', args.samples); return args.samples.length; },
  rename_limit_history_accounts: (args) => { mockLog('limit_history_rename', args.renames); return 0; },
  get_limit_cycles: (args) => limitCyclesFor(args.account, args.window),
  get_capacity_report: (args) => capacityReportFor(args.query),
  get_usage_collector_status: () => {
    if (collectorError) return { state: 'error', message: 'The core’s usage queue returned HTTP 401: invalid management key', lastCollectedAt: iso(-42 * 60_000), totalRecords: usageStorage.recordCount };
    return { state: coreStatus.ready ? 'collecting' : 'waiting-core', message: coreStatus.ready ? 'Collecting from 127.0.0.1:8317' : 'Waiting for the core to start', lastCollectedAt: iso(-5_000), totalRecords: usageStorage.recordCount };
  },
  get_usage_overview: (args) => usageOverviewFor(timelineBetween(args.query.start, args.query.end)),
  get_usage_analysis: () => usageAnalysis,
  get_usage_sessions: ({ query }) => {
    const sortKey = ({ cost: 'estimatedCost', tokens: 'totalTokens', requests: 'requests' } as const satisfies Record<string, SessionSort>)[query.sort ?? ''] ?? 'lastActiveAtMs';
    // "What used this limit?" narrows to one account (and a model family). The mock doesn't time sessions by
    // window, so an earlier window lists the same ones.
    const { inRequests, matching } = mockSessionsMatching(query);
    const pool = matching
      .sort((a, b) => b[sortKey] - a[sortKey] || b.lastActiveAtMs - a.lastActiveAtMs);
    const narrowed = Boolean(query.search || query.project || query.branch || query.client || query.pull_requests);
    const pageSize = Math.min(200, Math.max(20, Number(query.page_size ?? 50)));
    const totalPages = Math.max(1, Math.ceil(pool.length / pageSize));
    const page = Math.min(totalPages, Math.max(1, Number(query.page ?? 1)));
    const total = (key: 'subagents' | 'requests' | 'totalTokens' | 'estimatedCost' | 'pricedRequests') => pool.reduce((sum, item) => sum + item[key], 0);
    return {
      items: pool.slice((page - 1) * pageSize, page * pageSize), total: pool.length, page, pageSize, totalPages,
      summary: {
        sessions: pool.length, subagentThreads: total('subagents'), active: pool.filter((item) => item.active).length,
        requests: total('requests'), totalTokens: total('totalTokens'), estimatedCost: total('estimatedCost'), pricedRequests: total('pricedRequests'),
        untrackedRequests: query.session || narrowed || freshInstall ? 0 : query.auth_index ? (pool.length ? 3 : 0) : query.machine ? 96 : 1_284,
      },
      ...(query.facets ? { facets: sessionFacets(query, inRequests) } : {}),
    };
  },
  get_session_projects: (args) => {
    const { query } = args;
    const { inRequests, matching } = mockSessionsMatching(query);
    const github = mockGithubStatus(Boolean(args.checkNow));
    return {
      ...mockProjectsReport(matching, mockGithubAnswered),
      github,
      ...(query.facets ? { facets: sessionFacets(query, inRequests) } : {}),
    };
  },
  // The weekly digest's merged pull requests: the all-time Projects view's, merged in the window.
  get_merged_pull_requests: (args) => ({
    pullRequests: mockProjectsReport(mockSessionsMatching({}).matching, mockGithubAnswered).pullRequests.filter((pullRequest) => {
      const mergedAtMs = pullRequest.github?.state === 'merged' ? pullRequest.github.mergedAtMs : null;
      return mergedAtMs != null && mergedAtMs >= args.fromMs && mergedAtMs < args.toMs;
    }),
  }),
  // A session's page asks about the pull requests it named, as the Projects view does.
  get_pull_request_states: (args) => {
    const github = mockGithubStatus(false);
    return {
      pullRequests: args.pullRequests.map((link) => ({
        url: link.url,
        github: mockGithubAnswered ? mockGithubState(mockPullRequestStates[`${link.repository}#${link.number}`] ?? null) : null,
      })),
      github,
    };
  },
  get_usage_session_timeline: (args) => {
    const id = args.session;
    const session = usageSessions.find((item) => item.id === id || item.threads.some((thread) => thread.id === id));
    if (!session) return { session: null, requests: [], truncated: false, longContextThresholds: {} };
    const requests = mockSessionRequests(session);
    const models = new Set(requests.map((request) => request.model));
    return {
      session, requests, truncated: false,
      longContextThresholds: Object.fromEntries(Object.entries(mockLongContext).filter(([model]) => models.has(model))),
    };
  },
  get_usage_events: ({ query }) => {
    const pageSize = query.page_size ?? 20;
    const page = query.page ?? 1;
    const matching = query.session ? usageRecords.filter((_, index) => index % 6 === 0) : usageRecords;
    const filtered = query.failed === true ? matching.filter((record) => record.failed) : query.failed === false ? matching.filter((record) => !record.failed) : matching;
    const pool = query.request_order ? sortMockRequests(filtered, query.request_order) : filtered;
    const items = pool.slice((page - 1) * pageSize, page * pageSize);
    return { items, total: pool.length, page, pageSize, totalPages: Math.ceil(pool.length / pageSize) };
  },
  get_usage_pricing: () => usagePricing,
  repair_usage_cache_records: () => ({ scanned: 18_420, repaired: 12, deleted: 3, backupPath: '/Users/casey/Library/Application Support/onl.arbor.app/usage.backup.db' }),
  get_usage_storage_info: () => ({ ...usageStorage }),
  set_usage_retention: (args) => {
    const retentionDays = Number(args.retentionDays);
    if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3_650) {
      throw new Error('Usage history retention must be 1 to 3650 days, or 0 to keep it forever');
    }
    const recordsAffected = expiredUsageRecords(retentionDays);
    if (!args.dryRun) {
      // Saving prunes straight away; the freed pages stay in the file until it is compacted.
      usageStorage.retentionDays = retentionDays;
      if (recordsAffected > 0) {
        usageStorage.recordCount -= recordsAffected;
        usageStorage.freeBytes += Math.round(recordsAffected * usageRecordBytes);
        usageStorage.oldestTimestamp = usageStorage.recordCount ? new Date(Date.now() - retentionDays * DAY_MS).toISOString() : null;
        // Like the backend, a prune that deleted records tells open usage views to reload.
        void emit('usage-records-updated', new Date().toISOString());
      }
      mockLog('set_usage_retention', { retentionDays, recordsAffected });
    }
    return { retentionDays, recordsAffected };
  },
  compact_usage_database: () => {
    const bytesBefore = usageStorage.fileBytes + usageStorage.walBytes;
    usageStorage.fileBytes = Math.max(0, usageStorage.fileBytes - usageStorage.freeBytes);
    usageStorage.freeBytes = 0;
    usageStorage.walBytes = 0;
    const result = { bytesBefore, bytesAfter: usageStorage.fileBytes, shrinkPending: false };
    mockLog('compact_usage_database', result);
    // VACUUM takes a while on a real database.
    return later(1_200, () => result);
  },
  save_usage_model_price: () => null,
  delete_usage_model_price: () => null,
  sync_usage_model_prices: () => ({ imported: 42, skipped: 3, filled: ['gpt-6-sol', 'gpt-6-luna'], unmatched: ['codex-auto-review'], usedBuiltin: false }),
  get_live_sessions: () => mockLiveSessions(),
  get_fleet_sources: () => mockFleetSources(),
  // ?antiburn=missing: a Mac without Antiburn.
  get_antiburn: () => ({ installed: params.get('antiburn') !== 'missing' && !freshInstall, thisMachine: 'casey-mbp' }),
  open_antiburn: () => { mockLog('open_antiburn', null); return null; },
  get_machine_sessions: (args) => mockMachineSessions(args.query),
  get_cache_misses: ({ query }) => {
    // About one request in 250 misses the cache, each re-sending a mid-sized conversation.
    const requests = Math.round(sumTimeline(timelineBetween(query.start, query.end)).requests / 250);
    return { requests, tokens: requests * 142_300, cost: noPrices ? 0 : Math.round(requests * 0.61 * 100) / 100, pricedRequests: noPrices ? 0 : requests };
  },
};

/** The server's request order, over the mock's records: the column either way, missing values last, ties newest first. */
function sortMockRequests(records: UsageRecord[], order: UsageRequestOrder): UsageRecord[] {
  const value = (record: UsageRecord): number | null => {
    switch (order.by) {
      case 'time': return Date.parse(record.timestamp);
      case 'input': return record.tokens.input_tokens;
      case 'output': return record.tokens.output_tokens;
      case 'cache': return record.tokens.cache_read_tokens;
      case 'reasoning': return record.tokens.reasoning_tokens;
      case 'total': return record.tokens.total_tokens;
      case 'ttft': return record.ttft_ms;
      case 'latency': return record.latency_ms;
    }
  };
  const newest = (a: UsageRecord, b: UsageRecord) => Date.parse(b.timestamp) - Date.parse(a.timestamp);
  return [...records].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (left === null || right === null) return left === right ? newest(a, b) : left === null ? 1 : -1;
    return (order.descending ? right - left : left - right) || newest(a, b);
  });
}

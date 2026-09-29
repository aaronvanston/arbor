import { invokeCommand } from '../native/commands';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import { formatCount, formatDateRange, formatMoney } from '../lib/format';
import type { CapacityProvider } from './capacityReport';
import { EXPIRING_MIN_PERCENT, EXPIRING_WITHIN_MS } from './expiringCapacity';
import { providerLabel } from './providerLimits';
import type { QuotaProvider } from './quotaService';
import { projectsTotals, pullRequestStatus } from './sessionProjects';
import type {
  CacheMisses,
  CapacityReport,
  GithubStatus,
  ProjectPullRequest,
  SessionProjectsReport,
  UsageSession,
  UsageSessionPage,
  UsageSessionSummary,
} from '../native/types';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/** The digest of the week just ended goes out on Monday from this hour, local time. */
export const DIGEST_SEND_HOUR = 9;
/** The most projects, merged pull requests and sessions the digest lists. */
export const DIGEST_PROJECTS = 5;
export const DIGEST_PULL_REQUESTS = 8;
export const DIGEST_SESSIONS = 3;
/** Changes smaller than this, either way, read as about the same. */
export const SAME_CHANGE = 0.02;
/** A limit used this much of its window on average is close to what the accounts have. */
export const LIMIT_WARNING_PERCENT = 90;

/** A week of the digest, Monday to Monday in local time, and the stretch it's compared with. */
export type DigestWeek = {
  /** Weeks back from this one: 0 is this week, 1 last week. */
  offset: number;
  /** Midnight on its Monday. */
  startMs: number;
  /** Midnight on the next Monday, or now while the week is still going. */
  endMs: number;
  /** The same stretch a week earlier: this week so far is compared with the same part of last week. */
  previousStartMs: number;
  previousEndMs: number;
};

/** `ms` moved by whole days on the calendar, so a week across a daylight saving change still runs Monday to Monday. */
const addDays = (ms: number, days: number) => {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
};

/** Midnight on the Monday of the week `ms` falls in, local time. */
export function weekStart(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.getTime();
}

/** The week `offset` weeks back from the one `nowMs` is in. */
export function digestWeek(offset: number, nowMs: number): DigestWeek {
  const startMs = addDays(weekStart(nowMs), -7 * offset);
  const endMs = offset === 0 ? nowMs : addDays(startMs, 7);
  return { offset, startMs, endMs, previousStartMs: addDays(startMs, -7), previousEndMs: addDays(endMs, -7) };
}

/** The week's days, like "15 – 21 Sep"; this week's run to today. */
export function weekDays(week: DigestWeek, nowMs = Date.now()): string {
  return formatDateRange(week.startMs, Math.max(week.startMs, week.endMs - 1), { now: nowMs });
}

/** The usage query for a stretch of time. Both ends count, so it stops just short of the next stretch. */
const rangeQuery = (startMs: number, endMs: number) => ({
  start: new Date(startMs).toISOString(),
  end: new Date(Math.max(startMs, endMs - 1)).toISOString(),
});

/** What the digest uses of `get_usage_overview`. */
export type DigestOverview = {
  totalRequests: number;
  successCount: number;
  /** Cancels aren't failures. */
  failureCount: number;
  totalTokens: number;
  estimatedCost: number;
  pricedRequests: number;
};

/** What the misses cost, or null when none had a price, so the cost reads as unknown rather than free. */
export const cacheMissCost = (misses: CacheMisses): number | null => (misses.pricedRequests ? misses.cost : null);

export type WeeklyDigestData = {
  week: DigestWeek;
  overview: DigestOverview;
  previousOverview: DigestOverview;
  /** The week's sessions, the costliest first. */
  sessions: UsageSessionPage;
  previousSessions: UsageSessionSummary;
  /** The week's sessions by project. */
  projects: SessionProjectsReport;
  /** The pull requests merged in the week, each with every session behind it, however long before the week they ran. */
  pullRequests: ProjectPullRequest[];
  cacheMisses: CacheMisses;
  previousCacheMisses: CacheMisses;
  /** The week's limit readings; null when they couldn't be read. */
  capacity: CapacityReport | null;
};

/**
 * Loads what the digest of `week` is made of. `windows` are the long limit windows the accounts report. Like the
 * Projects view, this asks GitHub about pull requests it hasn't heard the last of. `before`, an earlier load, lends
 * its numbers for the week before when it compared against the same one: that week is over, so they don't change.
 */
export async function loadWeeklyDigest(week: DigestWeek, windows: string[], before?: WeeklyDigestData | null): Promise<WeeklyDigestData> {
  const query = rangeQuery(week.startMs, week.endMs);
  const previous = rangeQuery(week.previousStartMs, week.previousEndMs);
  const kept = before?.week.previousStartMs === week.previousStartMs && before.week.previousEndMs === week.previousEndMs ? before : null;
  const [overview, previousOverview, sessions, previousSessions, projects, merged, cacheMisses, previousCacheMisses, capacity] = await Promise.all([
    invokeCommand('get_usage_overview', { query }),
    kept ? kept.previousOverview : invokeCommand('get_usage_overview', { query: previous }),
    invokeCommand('get_usage_sessions', { query: { ...query, sort: 'cost', page_size: 20 } }),
    kept ? kept.previousSessions : invokeCommand('get_usage_sessions', { query: { ...previous, page_size: 20 } }).then((page) => page.summary),
    invokeCommand('get_session_projects', { query }),
    invokeCommand('get_merged_pull_requests', { fromMs: week.startMs, toMs: week.endMs }),
    invokeCommand('get_cache_misses', { query }),
    kept ? kept.previousCacheMisses : invokeCommand('get_cache_misses', { query: previous }),
    invokeCommand('get_capacity_report', { query: { ...query, windows } }).catch(() => null),
  ]);
  return {
    week,
    overview,
    previousOverview,
    sessions,
    previousSessions,
    projects,
    pullRequests: merged.pullRequests,
    cacheMisses,
    previousCacheMisses,
    capacity,
  };
}

/** `data` with its pull requests read again, for what GitHub has said since; nothing else in it moves that fast. */
export async function reloadDigestPullRequests(data: WeeklyDigestData): Promise<WeeklyDigestData> {
  const { week } = data;
  const [projects, merged] = await Promise.all([
    invokeCommand('get_session_projects', { query: rangeQuery(week.startMs, week.endMs) }),
    invokeCommand('get_merged_pull_requests', { fromMs: week.startMs, toMs: week.endMs }),
  ]);
  return { ...data, projects, pullRequests: merged.pullRequests };
}

export type DigestProject = {
  name: string;
  repository: string | null;
  sessions: number;
  estimatedCost: number;
  pricedRequests: number;
  linesAdded: number;
  linesRemoved: number;
  sessionsWithLines: number;
  /** Its pull requests merged in the week. */
  merged: number;
};

/** An account's long limit that reset in the week with a good share of it unused. */
export type UnusedLimit = { provider: QuotaProvider; key: string; name: string; window: string; percent: number; resetAtMs: number };

/** How much of a provider's headline window its accounts used in the week, and what they were worth. */
export type DigestLimit = {
  provider: QuotaProvider;
  window: string;
  /** The accounts' average use of the window, in percent per window length; null without a figure for any. */
  percent: number | null;
  /** The accounts with a use figure, and all of them. */
  measured: number;
  accounts: number;
  /** Their value at API prices over what the subscriptions cost for the week. */
  ratio: number | null;
  /** Accounts the rest of their plan could cover. */
  spare: string[];
};

export type WeeklyDigest = {
  week: DigestWeek;
  cost: number;
  previousCost: number;
  /** False when none of the week's requests had a price, so its cost isn't known. */
  priced: boolean;
  sessions: number;
  previousSessions: number;
  subagents: number;
  requests: number;
  /** The costliest sessions. */
  costliest: UsageSession[];
  /** Pull requests merged in the week, the latest first. */
  merged: ProjectPullRequest[];
  /** What the merged pull requests cost, every session behind them included. */
  mergedCost: number;
  /** The week's pull requests still open, drafts included. */
  open: number;
  linesAdded: number;
  linesRemoved: number;
  sessionsWithLines: number;
  /** The costliest projects. */
  projects: DigestProject[];
  /** Projects past those listed. */
  moreProjects: number;
  github: GithubStatus;
  cacheMisses: CacheMisses;
  previousCacheMisses: CacheMisses;
  failures: number;
  /** The share of finished requests that failed; null without any. */
  failureRate: number | null;
  previousFailureRate: number | null;
  /** The soonest reset first. */
  unused: UnusedLimit[];
  limits: DigestLimit[];
};

const failureRate = (overview: DigestOverview) => {
  const finished = overview.successCount + overview.failureCount;
  return finished ? overview.failureCount / finished : null;
};

/** How much `current` moved from `previous`, as a share of it; null when there's nothing to compare with. */
export function change(current: number, previous: number): number | null {
  return previous > 0 ? (current - previous) / previous : null;
}

/**
 * Each provider's headline window: how much of it the accounts used on average in the week, what they were worth
 * against what they cost, and which of them the others could cover.
 */
export function digestLimits(providers: CapacityProvider[]): DigestLimit[] {
  return providers.flatMap((provider) => {
    if (!provider.window) return [];
    const measured = provider.accounts.flatMap((account) => (account.use ? [account.use.percent] : []));
    if (!measured.length && provider.ratio === null) return [];
    return [{
      provider: provider.provider,
      window: provider.window,
      percent: measured.length ? measured.reduce((sum, percent) => sum + percent, 0) / measured.length : null,
      measured: measured.length,
      accounts: provider.accounts.length,
      ratio: provider.ratio,
      spare: provider.verdicts.flatMap((verdict) => verdict.spare),
    }];
  });
}

/**
 * Headline windows that reset in the week with at least EXPIRING_MIN_PERCENT of them left: capacity paid for and not
 * used. Only resets the limit readings reached within a day of count, so what was left is known.
 */
export function unusedLimits(data: CapacityReport | null, providers: CapacityProvider[], week: DigestWeek, nowMs: number): UnusedLimit[] {
  if (!data) return [];
  const until = Math.min(week.endMs, nowMs);
  return providers
    .flatMap((provider) => {
      if (!provider.window) return [];
      const names = new Map(provider.accounts.map((account) => [account.key, account.name]));
      return data.cycles.flatMap((cycle): UnusedLimit[] => {
        const name = names.get(cycle.account);
        if (name === undefined || cycle.window !== provider.window) return [];
        if (cycle.resetAtMs < week.startMs || cycle.resetAtMs > until) return [];
        if (cycle.resetAtMs - cycle.lastSampledAtMs > EXPIRING_WITHIN_MS || cycle.minRemainingPercent < EXPIRING_MIN_PERCENT) return [];
        return [{ provider: provider.provider, key: cycle.account, name, window: cycle.window, percent: cycle.minRemainingPercent, resetAtMs: cycle.resetAtMs }];
      });
    })
    .sort((left, right) => left.resetAtMs - right.resetAtMs);
}

/** The digest of a week: what it cost, what got done, how much of the limits it used, and what went to waste. */
export function weeklyDigest(data: WeeklyDigestData, providers: CapacityProvider[], nowMs: number): WeeklyDigest {
  const { week, overview, previousOverview, projects } = data;
  const merged = data.pullRequests
    .filter((pullRequest) => {
      const mergedAtMs = pullRequest.github?.mergedAtMs;
      return pullRequestStatus(pullRequest) === 'merged' && mergedAtMs != null && mergedAtMs >= week.startMs && mergedAtMs < week.endMs;
    })
    .sort((left, right) => right.github!.mergedAtMs! - left.github!.mergedAtMs!);
  const totals = projectsTotals(projects);
  return {
    week,
    cost: overview.estimatedCost,
    previousCost: previousOverview.estimatedCost,
    priced: overview.pricedRequests > 0,
    sessions: data.sessions.summary.sessions,
    previousSessions: data.previousSessions.sessions,
    subagents: data.sessions.summary.subagentThreads,
    requests: overview.totalRequests,
    costliest: data.sessions.items.filter((session) => session.estimatedCost > 0).slice(0, DIGEST_SESSIONS),
    merged,
    mergedCost: merged.reduce((sum, pullRequest) => sum + pullRequest.estimatedCost, 0),
    open: projects.pullRequests.filter((pullRequest) => {
      const status = pullRequestStatus(pullRequest);
      return status === 'open' || status === 'draft';
    }).length,
    linesAdded: totals.linesAdded,
    linesRemoved: totals.linesRemoved,
    sessionsWithLines: totals.sessionsWithLines,
    projects: projects.projects.slice(0, DIGEST_PROJECTS).map((project) => ({
      name: project.name,
      repository: project.repository,
      sessions: project.sessions,
      estimatedCost: project.estimatedCost,
      pricedRequests: project.pricedRequests,
      linesAdded: project.linesAdded,
      linesRemoved: project.linesRemoved,
      sessionsWithLines: project.sessionsWithLines,
      merged: merged.filter((pullRequest) => pullRequest.project === project.name).length,
    })),
    moreProjects: Math.max(0, projects.projects.length - DIGEST_PROJECTS),
    github: projects.github,
    cacheMisses: data.cacheMisses,
    previousCacheMisses: data.previousCacheMisses,
    failures: overview.failureCount,
    failureRate: failureRate(overview),
    previousFailureRate: failureRate(previousOverview),
    unused: unusedLimits(data.capacity, providers, week, nowMs),
    limits: digestLimits(providers),
  };
}

/** "up 12%", "down 12%" or "about the same"; empty without anything to compare with. */
export function changeText(current: number, previous: number, t: Translate): string {
  const moved = change(current, previous);
  if (moved === null) return '';
  if (Math.abs(moved) < SAME_CHANGE) return t('digest.change.same');
  return t(moved > 0 ? 'digest.change.up' : 'digest.change.down', { percent: Math.round(Math.abs(moved) * 100) });
}

/** A share as a percentage, to a tenth below 10% so a small one doesn't round to nothing. */
export const percentText = (share: number) => `${share < 0.1 && share > 0 ? (share * 100).toFixed(1) : Math.round(share * 100)}%`;
/** What requests were worth over what they cost, like "6.5×". */
export const formatRatio = (ratio: number) => `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}×`;

/** Whether GitHub couldn't be asked about the pull requests, so none merging says nothing. */
export const githubUnavailable = (digest: WeeklyDigest) =>
  digest.github.last === 'missing' || digest.github.last === 'signedOut' || digest.github.last === 'failed';

/** What goes under the count of merged pull requests. */
export function mergedHint(digest: WeeklyDigest, t: Translate): string {
  if (digest.merged.length) {
    // With nothing priced in the week, an average of $0.00 would read as free.
    return digest.priced
      ? t('usage.digest.stat.mergedHint', { cost: formatMoney(digest.mergedCost / digest.merged.length) })
      : t('usage.digest.stat.noPrices');
  }
  if (githubUnavailable(digest)) return t('usage.digest.stat.noGithub');
  return digest.open
    ? t(digest.open === 1 ? 'usage.digest.stat.open.one' : 'usage.digest.stat.open.other', { count: formatCount(digest.open) })
    : t('usage.digest.stat.noneMerged');
}

/** Why no merged pull request is listed. */
export function noMergedText(digest: WeeklyDigest, t: Translate): string {
  switch (digest.github.last) {
    case 'missing': return t('usage.projects.github.missing');
    case 'signedOut': return t('usage.projects.github.signedOut');
    case 'failed': return t('usage.projects.github.failed', { message: digest.github.message });
    default: return t('usage.digest.done.none');
  }
}

/** The digest as a notification: the week's headline numbers, what got done, what was wasted and the limits. */
export function digestNotification(digest: WeeklyDigest, t: Translate): { title: string; body: string } {
  const number = formatCount;
  const money = formatMoney;
  const moved = changeText(digest.cost, digest.previousCost, t);
  const spend = digest.priced
    ? moved ? t('digest.push.spentChange', { cost: money(digest.cost), change: moved }) : t('digest.push.spent', { cost: money(digest.cost) })
    : '';
  const sessions = t(digest.sessions === 1 ? 'digest.push.sessions.one' : 'digest.push.sessions.other', { count: number(digest.sessions) });
  const merged = digest.merged.length
    ? t(digest.merged.length === 1 ? 'digest.push.merged.one' : 'digest.push.merged.other', { count: number(digest.merged.length) })
    : '';
  const lines = digest.sessionsWithLines
    ? t('digest.push.lines', { added: number(digest.linesAdded), removed: number(digest.linesRemoved) })
    : '';
  const top = digest.projects[0];
  const project = top && top.pricedRequests && digest.priced
    ? t('digest.push.topProject', { project: top.name, cost: money(top.estimatedCost) })
    : '';
  const waste = [
    (cacheMissCost(digest.cacheMisses) ?? 0) >= 0.01 ? t('digest.push.cacheMisses', { cost: money(digest.cacheMisses.cost) }) : '',
    digest.failureRate ? t('digest.push.failures', { percent: percentText(digest.failureRate) }) : '',
    digest.unused.length
      ? t(digest.unused.length === 1 ? 'digest.push.unused.one' : 'digest.push.unused.other', { count: digest.unused.length, percent: EXPIRING_MIN_PERCENT })
      : '',
  ].filter(Boolean);
  const limits = digest.limits
    .filter((limit) => limit.percent !== null)
    .map((limit) => t('digest.push.limit', { provider: providerLabel[limit.provider], percent: Math.round(limit.percent!) }));
  return {
    title: t('digest.push.title', { days: weekDays(digest.week, digest.week.endMs - 1) }),
    body: [
      [spend, sessions].filter(Boolean).join(' · '),
      [merged, lines].filter(Boolean).join(' · '),
      project,
      waste.length ? t('digest.push.waste', { items: waste.join(' · ') }) : '',
      limits.length ? t('digest.push.limits', { items: limits.join(' · ') }) : '',
    ].filter(Boolean).join('\n'),
  };
}

/**
 * The week whose digest is due to go out at `nowMs`: the one that just ended, once it's Monday DIGEST_SEND_HOUR or
 * later. Null while it's too early, or once it has been sent (`sentWeekMs` is the start of the last week sent).
 */
export function dueDigestWeek(nowMs: number, sentWeekMs: number | null): DigestWeek | null {
  const week = digestWeek(1, nowMs);
  const sendAt = new Date(weekStart(nowMs));
  sendAt.setHours(DIGEST_SEND_HOUR);
  if (nowMs < sendAt.getTime()) return null;
  return sentWeekMs !== null && sentWeekMs >= week.startMs ? null : week;
}

const SENT_KEY = 'cpa-gui.weekly-digest-sent.v1';

/** The start of the last week whose digest went out, or null before the first. */
export function lastDigestSent(): number | null {
  try {
    const saved = Number(localStorage.getItem(SENT_KEY) ?? Number.NaN);
    return Number.isFinite(saved) ? saved : null;
  } catch {
    return null;
  }
}

export function markDigestSent(weekStartMs: number) {
  try {
    localStorage.setItem(SENT_KEY, String(weekStartMs));
  } catch {
    /* Keep going: at worst a digest goes out twice. */
  }
}

/** Turning the digest on starts with the week under way, so last week's doesn't arrive out of the blue. */
export const startWeeklyDigests = (nowMs: number) => markDigestSent(digestWeek(1, nowMs).startMs);

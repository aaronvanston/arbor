import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { invokeCommand } from '../native/commands';
import { listen } from '@tauri-apps/api/event';
import { AlertCircle, ArrowRightLeft, Bot, Check, Copy, CornerDownRight, DatabaseZap, FoldVertical, FolderGit2, Gauge, GitBranch, GitPullRequest, Hourglass, Lightbulb, LineChart, List, MessagesSquare, Sparkles, TriangleAlert } from '../components/ui/icons';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import { createRefreshScheduler } from '../services/refreshScheduler';
import { errorWords } from '../services/plainError';
import { formatAgo, formatCount, formatDateTime, formatDuration, formatMoney, formatPercent, formatTime, formatTokens, formatWhen } from '../lib/format';
import {
  DEEP_CONTEXT_TOKENS,
  buildThreadTimeline,
  cacheHitRate,
  costTotal,
  sessionChecks,
  sessionPlatform,
  sessionTotals,
  speedTier,
  threadNames,
  type SessionCheck,
  type SessionEvent,
  type SessionTotals,
  type ThreadTimeline,
} from '../services/sessionTimeline';
import {
  sessionClient,
  sessionPlace,
  shortSessionId,
  sessionSkills,
  subagentTypes,
  toolLabel,
  toolRows,
} from '../services/usageSessions';
import { githubNote } from '../services/sessionProjects';
import { Page, PageBody, PageBreadcrumb, PageCrumbButton, PageTopbar } from '../components/layout/page';
import { SettingsBlock, SettingsSection } from '../components/layout/settings';
import { StatBlock, StatsGrid } from '../components/layout/stats';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { chipVariants } from '../components/ui/chip';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../components/ui/collapsible';
import { Empty, EmptyDescription, EmptyMedia } from '../components/ui/empty';
import { MiddleTruncate } from '../components/ui/middle-truncate';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { StatusDot, StatusPill } from '../components/ui/status-dot';
import { TABLE_NUMERIC_CLASS, TableEmpty, TableShowAll } from '../components/ui/data-table';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { WithShortcut } from '../components/ShortcutKbd';
import { ClientPill, MachinePill, ModelName, ModelNames, ProviderPill } from '../components/identity/Identity';
import { PullRequestSignals, PullRequestStateBadge } from '../components/PullRequestSignals';
import { openPullRequest } from './SessionProjectsView';
import { SessionAntiburn } from './SessionAntiburn';
import { useShortcut } from '../hooks/useShortcuts';
import {
  CACHE_MISS_COLOR,
  COMPACTION_COLOR,
  CONTEXT_COLOR,
  LANE_COLORS,
  SessionContextChart,
  type ContextReference,
} from './SessionContextChart';
import type {
  CostParts,
  PullRequestLink,
  PullRequestState,
  SessionTranscript,
  UsageSession,
  UsageSessionThread,
  UsageSessionTimeline,
} from '../native/types';

/** The threads listed before "Show all". */
const THREADS_SHOWN = 50;
/** The tools listed before "Show all". */
const TOOLS_SHOWN = 10;
/** A cache that was idle this long before a miss had gone cold rather than been dropped. */
const COLD_CACHE_IDLE_MS = 5 * 60_000;
/** A compaction's summary is at least this long; a smaller drop without one may be a rewind. */
const SUMMARY_MIN_TOKENS = 1_000;

const cost = formatMoney;
const tokens = formatCount;
const percent = (share: number) => formatPercent(share);

const EVENT_ICON: Record<SessionEvent['kind'], { icon: ComponentType<{ className?: string }>; color: string }> = {
  compaction: { icon: FoldVertical, color: COMPACTION_COLOR },
  subagent: { icon: Bot, color: LANE_COLORS.subagent },
  failure: { icon: TriangleAlert, color: LANE_COLORS.failure },
  change: { icon: ArrowRightLeft, color: LANE_COLORS.change },
  cacheMiss: { icon: DatabaseZap, color: CACHE_MISS_COLOR },
  idle: { icon: Hourglass, color: 'text-muted-foreground' },
  longContext: { icon: Gauge, color: 'text-warning' },
};

/**
 * One session over its whole history, whatever the Sessions list is filtered to: its context over time with
 * compactions, what happened along the way, where the money went, and its threads. Built from what the proxy
 * records, so it covers sessions on every machine.
 */
export function SessionDetailPage({ sessionId, onBack, onViewRequests }: { sessionId: string; onBack: () => void; onViewRequests: (id: string) => void }) {
  const { t } = useI18n();
  const [timeline, setTimeline] = useState<UsageSessionTimeline | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [threadId, setThreadId] = useState(sessionId);
  const [highlight, setHighlight] = useState<number | null>(null);
  const requestIdRef = useRef(0);
  const schedulerRef = useRef<ReturnType<typeof createRefreshScheduler> | null>(null);
  if (!schedulerRef.current) schedulerRef.current = createRefreshScheduler(10_000);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const next = await invokeCommand('get_usage_session_timeline', { session: sessionId });
      if (requestId !== requestIdRef.current) return;
      setTimeline(next);
      setError('');
    } catch (requestError) {
      if (requestId === requestIdRef.current) setError(String(requestError));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void schedulerRef.current!.runForeground(load);
    return () => {
      // A counter, not a DOM ref: cleanup bumps its latest value so any load still in flight is ignored.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++requestIdRef.current;
      schedulerRef.current?.cancelPending();
    };
  }, [load]);

  // What the session's transcript says arrives every few minutes, whether or not the session is still going.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    listen('session-transcripts-updated', () => {
      if (!disposed && !document.hidden) void schedulerRef.current!.schedule(load);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [load]);

  // An active session keeps growing, so its detail follows the new requests, at most every 10 seconds.
  const active = timeline?.session?.active ?? false;
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const refresh = () => {
      if (!disposed && !document.hidden) void schedulerRef.current!.schedule(load);
    };
    listen('usage-records-updated', refresh)
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      disposed = true;
      unlisten?.();
      window.clearInterval(timer);
    };
  }, [active, load]);

  const session = timeline?.session ?? null;
  const mainId = session?.id ?? sessionId;
  const names = useMemo(() => threadNames(session), [session]);
  const main = useMemo(() => (timeline ? buildThreadTimeline(timeline, mainId) : null), [timeline, mainId]);
  // A session whose own requests Arbor never saw opens on its first subagent.
  const firstThreadId = session?.threads.some((thread) => thread.id === mainId) ? mainId : session?.threads[0]?.id ?? mainId;
  const shownThreadId = session?.threads.some((thread) => thread.id === threadId) ? threadId : firstThreadId;
  const thread = useMemo(
    () => (timeline && shownThreadId !== mainId ? buildThreadTimeline(timeline, shownThreadId) : main),
    [timeline, shownThreadId, mainId, main],
  );
  const totals = useMemo(() => (timeline ? sessionTotals(timeline, mainId) : null), [timeline, mainId]);
  const checks = useMemo(() => (timeline && main && totals ? sessionChecks(timeline, main, totals) : []), [timeline, main, totals]);

  const threadName = (id: string) => {
    const name = names.get(id);
    return !name || name.main ? t('usage.sessions.mainThread') : t('usage.sessions.subagent', { index: name.index });
  };
  const client = sessionClient(session?.userAgent);
  useShortcut('page.refresh', () => {
    if (!loading) void schedulerRef.current!.runForeground(load);
  });

  const title = session?.transcript?.title || (client ? [client.name, client.version].filter(Boolean).join(' ') : shortSessionId(sessionId));

  // threadName is rebuilt every render from names and t, so those are what the callback really depends on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const describeEvent = useCallback((event: SessionEvent) => eventText(event, t, threadName).title, [t, names]);

  return (
    <Page width="main">
      <PageTopbar
        actions={
          <>
            {active ? <StatusPill tone="success">{t('sessions.active')}</StatusPill> : null}
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost-muted" size="icon-sm" onClick={() => void schedulerRef.current!.runForeground(load)} disabled={loading} focusableWhenDisabled aria-label={t('usage.refresh')} />}>
                <RefreshIcon refreshing={loading} />
              </TooltipTrigger>
              <TooltipPopup><WithShortcut id="page.refresh">{t('usage.refresh')}</WithShortcut></TooltipPopup>
            </Tooltip>
          </>
        }
      >
        <PageBreadcrumb
          segments={[
            <PageCrumbButton key="sessions" onClick={onBack}>{t('app.nav.sessions')}</PageCrumbButton>,
            title,
          ]}
        />
      </PageTopbar>
      <PageBody gap="gap-6">
        {error ? (
          <Alert variant="error" icon={<AlertCircle />}>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {!timeline ? (
          error ? null : (
            <div className="flex flex-col gap-6" aria-busy="true" aria-label={t('sessions.loading')}>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          )
        ) : !session || !main || !thread || !totals ? (
          <Empty>
            <EmptyMedia><MessagesSquare /></EmptyMedia>
            <EmptyDescription>{t('sessions.notFound', { id: sessionId })}</EmptyDescription>
          </Empty>
        ) : (
          <>
            <SessionHeader session={session} onViewRequests={onViewRequests} />
            {timeline.truncated ? (
              <p className="-mt-3 px-1 text-xs text-muted-foreground">{t('sessions.truncated', { count: tokens(timeline.requests.length) })}</p>
            ) : null}
            {!session.hasOwnRequests ? <p className="-mt-3 px-1 text-xs text-muted-foreground">{t('sessions.noOwnRequests')}</p> : null}
            <SessionStats session={session} main={main} totals={totals} checks={checks} />
            <SettingsSection
              title={t('sessions.context.title')}
              description={t('sessions.context.description')}
              headerAction={
                session.threads.length > 1 ? (
                  <Select value={shownThreadId} onValueChange={(value) => { setThreadId(value ?? firstThreadId); setHighlight(null); }}>
                    <SelectTrigger size="sm" className="w-auto min-w-0 max-w-72" aria-label={t('sessions.context.thread')}>
                      <SelectValue className="truncate">{threadName(shownThreadId)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end">
                      {session.threads.slice(0, THREADS_SHOWN).map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate">{threadName(item.id)}</span>
                            {item.models[0] ? <ModelName model={item.models[0]} className="font-normal text-muted-foreground" /> : null}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null
              }
            >
              <SettingsBlock className="flex flex-col gap-3 py-4">
                <ChartLegend />
                {thread.points.length ? (
                  <SessionContextChart thread={thread} references={contextReferences(timeline, thread, t)} highlight={highlight} describeEvent={describeEvent} />
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">{t('sessions.context.empty')}</p>
                )}
              </SettingsBlock>
            </SettingsSection>
            <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
              <div className="flex min-w-0 flex-col gap-6">
                <SessionEvents thread={thread} threadName={threadName} onHighlight={setHighlight} />
                <SessionTools session={session} />
              </div>
              <div className="flex min-w-0 flex-col gap-6">
                <SessionCost totals={totals} />
                <SessionChecks checks={checks} transcript={session.transcript} />
              </div>
            </div>
            <SessionThreads
              session={session}
              threadName={threadName}
              shownThreadId={shownThreadId}
              onShowContext={(id) => {
                setThreadId(id);
                setHighlight(null);
              }}
              onViewRequests={onViewRequests}
            />
          </>
        )}
      </PageBody>
    </Page>
  );
}

type Translate = ReturnType<typeof useI18n>['t'];

/** Where long-context rates start for the thread's model, and where context gets deep. */
function contextReferences(timeline: UsageSessionTimeline, thread: ThreadTimeline, t: Translate): ContextReference[] {
  const references: ContextReference[] = [];
  const models = new Set(thread.points.map((point) => point.request.model));
  const thresholds = [...models].map((model) => timeline.longContextThresholds[model]).filter((value): value is number => Boolean(value));
  if (thresholds.length) {
    const value = Math.min(...thresholds);
    references.push({ value, label: t('sessions.context.longContext', { tokens: formatTokens(value) }), tone: 'muted' });
  }
  if (thread.peak >= DEEP_CONTEXT_TOKENS * 0.75) {
    references.push({ value: DEEP_CONTEXT_TOKENS, label: t('sessions.context.deep', { tokens: formatTokens(DEEP_CONTEXT_TOKENS) }), tone: 'warning' });
  }
  return references;
}

function ChartLegend() {
  const { t } = useI18n();
  const items: { label: MessageKey; color: string; shape: 'area' | 'line' | 'dot' | 'triangle' | 'bar' | 'diamond' | 'dashed' }[] = [
    { label: 'sessions.context.legend.context', color: CONTEXT_COLOR, shape: 'area' },
    { label: 'sessions.context.legend.compaction', color: COMPACTION_COLOR, shape: 'line' },
    { label: 'sessions.context.legend.cacheMiss', color: CACHE_MISS_COLOR, shape: 'dot' },
    { label: 'sessions.context.legend.subagent', color: LANE_COLORS.subagent, shape: 'triangle' },
    { label: 'sessions.context.legend.failure', color: LANE_COLORS.failure, shape: 'bar' },
    { label: 'sessions.context.legend.change', color: LANE_COLORS.change, shape: 'diamond' },
    { label: 'sessions.context.legend.idle', color: 'text-muted-foreground', shape: 'dashed' },
  ];
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground" aria-label={t('sessions.context.legend.title')}>
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <svg className={cn('size-3 shrink-0', item.color)} viewBox="0 0 12 12" aria-hidden="true">
            {item.shape === 'area' ? <rect x="1" y="3" width="10" height="8" rx="1.5" fill="currentColor" fillOpacity="0.35" stroke="currentColor" strokeWidth="1" /> : null}
            {item.shape === 'line' ? <line x1="1" y1="2" x2="11" y2="10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /> : null}
            {item.shape === 'dot' ? <circle cx="6" cy="6" r="3.5" fill="currentColor" /> : null}
            {item.shape === 'triangle' ? <path d="M6,2l4.5,8h-9z" fill="currentColor" /> : null}
            {item.shape === 'bar' ? <rect x="5" y="1.5" width="2" height="9" rx="1" fill="currentColor" /> : null}
            {item.shape === 'diamond' ? <path d="M6,1.5l4.5,4.5l-4.5,4.5l-4.5,-4.5z" fill="currentColor" /> : null}
            {item.shape === 'dashed' ? <line x1="6" y1="0.5" x2="6" y2="11.5" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2,2" /> : null}
          </svg>
          {t(item.label)}
        </li>
      ))}
    </ul>
  );
}

const TITLE_SOURCE: Record<Exclude<SessionTranscript['titleSource'], ''>, MessageKey> = {
  ai: 'sessions.header.titleSource.ai',
  custom: 'sessions.header.titleSource.custom',
  codex: 'sessions.header.titleSource.codex',
};

type Fact = { label: MessageKey; value: ReactNode; mono?: boolean; title?: string };

function FactList({ facts }: { facts: Fact[] }) {
  const { t } = useI18n();
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
      {facts.map((fact) => (
        <div key={fact.label} className="flex min-w-0 items-baseline gap-1.5">
          <dt className="shrink-0 text-muted-foreground">{t(fact.label)}</dt>
          <dd className={cn('min-w-0 max-w-md truncate text-foreground', fact.mono && 'font-mono')} title={fact.title}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** How long to wait before looking again while GitHub is being asked about a session's pull requests. */
const GITHUB_RECHECK_MS = 3_000;

/**
 * The pull requests a session named, each with its state on GitHub and, for an open one, how its checks, reviews and
 * merging stand, as Sessions › Projects shows them. Opening the page asks GitHub about any that are due.
 */
function SessionPullRequests({ pullRequests }: { pullRequests: PullRequestLink[] }) {
  const { t } = useI18n();
  const [states, setStates] = useState<ReadonlyMap<string, PullRequestState | null>>(() => new Map());
  // GitHub may answer whether they merged but turn down how checks and reviews stand: say so, as Projects does.
  const [detailError, setDetailError] = useState('');
  // Without GitHub there are no states at all; say why, as Projects does, rather than leave the links bare.
  const [unavailable, setUnavailable] = useState('');
  // The page reloads its session every few seconds; the same links shouldn't ask again.
  const links = useRef(pullRequests);
  links.current = pullRequests;
  const key = pullRequests.map((pullRequest) => pullRequest.url).join('\n');
  useEffect(() => {
    let disposed = false;
    let recheck: number | undefined;
    const load = () => {
      invokeCommand('get_pull_request_states', { pullRequests: links.current })
        .then((named) => {
          if (disposed) return;
          setStates(new Map(named.pullRequests.map((pullRequest) => [pullRequest.url, pullRequest.github])));
          setDetailError(named.github.last === 'ok' ? named.github.detailError : '');
          const note = githubNote(named.github, t);
          setUnavailable(note?.unavailable ? note.text : '');
          if (named.github.checking) recheck = window.setTimeout(load, GITHUB_RECHECK_MS);
        })
        // The links still work without their states.
        .catch((error) => console.warn('Failed to read pull request states', error));
    };
    load();
    return () => {
      disposed = true;
      window.clearTimeout(recheck);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` changes only with the language, which reloads anyway.
  }, [key]);

  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {pullRequests.map((pullRequest) => {
        const github = states.get(pullRequest.url) ?? null;
        return (
          <span key={pullRequest.url} className="inline-flex items-center gap-1.5">
            <button
              type="button"
              className="cursor-pointer rounded-sm font-mono text-foreground underline decoration-muted-foreground/50 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
              title={github?.title || pullRequest.url}
              aria-label={t('sessions.header.openPullRequest', { name: `${pullRequest.repository}#${pullRequest.number}` })}
              onClick={() => openPullRequest(pullRequest.url)}
            >
              #{pullRequest.number}
            </button>
            {/* Nothing until GitHub has been asked: "Not checked" beside each would only be noise here. */}
            {github ? <PullRequestStateBadge github={github} /> : null}
            <PullRequestSignals github={github} />
          </span>
        );
      })}
      {unavailable ? (
        <span className="text-xs text-warning-foreground" title={unavailable}>{t('sessions.header.githubUnavailable')}</span>
      ) : null}
      {detailError ? (
        <span className="text-xs text-warning-foreground" title={errorWords(detailError)}>
          {t('sessions.header.pullRequestDetailFailed')}
        </span>
      ) : null}
    </span>
  );
}

/** Where the session ran, as one line: the project, then its worktree and branch when it had them. */
function SessionPlaceLine({ transcript }: { transcript: SessionTranscript }) {
  const { t } = useI18n();
  const place = sessionPlace(transcript);
  if (!place) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <FolderGit2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="sr-only">{t('sessions.header.project')}</span>
      <span className="shrink-0 font-medium text-foreground" title={place.repository ?? (transcript.mainRepo || transcript.repoRoot || undefined)}>{place.project}</span>
      {place.worktree ? (
        <>
          <span aria-hidden="true" className="text-muted-foreground">/</span>
          <span className="sr-only">{t('sessions.header.worktree')}</span>
          <span className="min-w-0 truncate text-foreground" title={transcript.repoRoot}>{place.worktree}</span>
        </>
      ) : null}
      {place.branch ? (
        <>
          <GitBranch aria-hidden="true" className="ms-1 size-3.5 shrink-0 text-muted-foreground" />
          <span className="sr-only">{t('sessions.header.branch')}</span>
          <MiddleTruncate value={place.branch} className="max-w-64 font-mono text-foreground" />
        </>
      ) : null}
    </span>
  );
}

const DETAILS_KEY = 'arbor.session-header-details.v1';

const readDetailsOpen = () => {
  try {
    return localStorage.getItem(DETAILS_KEY) === 'open';
  } catch {
    return false;
  }
};

/**
 * Who the session is at a glance: its title with the id to copy, one line of pills for where it ran and what it worked
 * on, and when. The raw facts (folder, full id, platform, User-Agent, where the transcript came from) are folded under
 * Details, which stays as it was last left.
 */
export function SessionHeader({ session, onViewRequests }: { session: UsageSession; onViewRequests: (id: string) => void }) {
  const { t, tRich } = useI18n();
  const { copy, copied } = useCopyToClipboard({ inline: true });
  const [detailsOpen, setDetailsOpen] = useState(readDetailsOpen);
  const client = sessionClient(session.userAgent);
  const platform = sessionPlatform(session.userAgent);
  const platformText = platform ? [platform.os, platform.arch, platform.terminal].filter(Boolean).join(' · ') : '';
  const name = client ? [client.name, client.version].filter(Boolean).join(' ') : t('usage.sessions.unknownClient');
  const { transcript } = session;
  const title = transcript?.title ?? '';
  const place = sessionPlace(transcript);
  const pullRequests = transcript?.pullRequests ?? [];
  const lines = transcript && transcript.linesAdded !== null && transcript.linesRemoved !== null ? { added: transcript.linesAdded, removed: transcript.linesRemoved } : null;
  const details: Fact[] = [
    ...(place ? [{ label: 'sessions.header.folder' as MessageKey, value: place.folder, mono: true, title: transcript?.cwd }] : []),
    { label: 'usage.sessions.detail.id', value: session.id, mono: true },
    ...(platformText ? [{ label: 'sessions.header.platform' as MessageKey, value: platformText }] : []),
    ...(session.userAgent ? [{ label: 'sessions.header.userAgent' as MessageKey, value: session.userAgent, mono: true, title: session.userAgent }] : []),
  ];
  const toggleDetails = (open: boolean) => {
    setDetailsOpen(open);
    try {
      localStorage.setItem(DETAILS_KEY, open ? 'open' : 'closed');
    } catch {
      // Remembered until the page closes.
    }
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-border/70 bg-card px-4 py-3 shadow-xs/5">
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          {session.active ? <StatusDot tone="success" pulse /> : null}
          <h2
            className="truncate text-base font-semibold tracking-title text-foreground"
            title={transcript?.titleSource ? t(TITLE_SOURCE[transcript.titleSource]) : undefined}
          >
            {title || name}
            {!title && client?.host ? <span className="font-normal text-muted-foreground"> · {client.host}</span> : null}
          </h2>
          <Tooltip>
            <TooltipTrigger
              render={<button type="button" className={cn(chipVariants({ tone: 'quiet' }), 'font-mono')} aria-label={t('usage.sessions.copyId')} onClick={() => void copy(session.id)} />}
            >
              {shortSessionId(session.id)}
              {copied ? <Check /> : <Copy />}
            </TooltipTrigger>
            <TooltipPopup>
              {copied ? t('usage.sessions.copied') : t('usage.sessions.copyId')}
              <span className="block text-muted-foreground">{t('usage.sessions.copyHint')}</span>
            </TooltipPopup>
          </Tooltip>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => onViewRequests(session.id)}>
          <List />
          {t('usage.sessions.viewRequests')}
        </Button>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <MachinePill name={session.machine || transcript?.machine} fallback={t('usage.events.unassigned')} />
        {/* Without a title the client already names the session. */}
        {title ? <ClientPill userAgent={session.userAgent} /> : null}
        {session.providers.map((provider) => <ProviderPill key={provider} provider={provider} />)}
        {transcript && (place || pullRequests.length || lines) ? <span aria-hidden="true" className="h-3.5 w-px bg-border" /> : null}
        {transcript ? <SessionPlaceLine transcript={transcript} /> : null}
        {pullRequests.length ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="sr-only">{t(pullRequests.length === 1 ? 'sessions.header.pullRequests.one' : 'sessions.header.pullRequests.other')}</span>
            <GitPullRequest aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <SessionPullRequests pullRequests={pullRequests} />
          </span>
        ) : null}
        {lines ? (
          <span className="tabular-nums" title={t('sessions.header.lines')}>
            <span className="text-success-foreground">+{tokens(lines.added)}</span>{' '}
            <span className="text-error-foreground">−{tokens(lines.removed)}</span>
          </span>
        ) : null}
      </div>

      <Collapsible open={detailsOpen} onOpenChange={toggleDetails}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <p className="tabular-nums">
            {t('sessions.header.times', {
              started: formatDateTime(session.startedAtMs),
              last: formatWhen(session.lastActiveAtMs),
              ago: formatAgo(session.lastActiveAtMs, Date.now()),
            })}
          </p>
          <CollapsibleTrigger
            chevron="end"
            className="-me-1 inline-flex items-center gap-1 rounded-sm px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('sessions.header.details')}
          </CollapsibleTrigger>
        </div>
        <CollapsiblePanel>
          <div className="mt-2.5 flex flex-col gap-1.5 border-t border-border/50 pt-2.5">
            <FactList facts={details} />
            <p className="text-2xs text-muted-foreground">
              {transcript
                ? tRich('sessions.header.transcriptRead', { machine: <MachinePill name={transcript.machine} size="sm" />, time: formatAgo(transcript.readAtMs, Date.now()) })
                : t('sessions.header.noTranscript')}
            </p>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function SessionStats({ session, main, totals, checks }: { session: UsageSession; main: ThreadTimeline; totals: SessionTotals; checks: SessionCheck[] }) {
  const { t } = useI18n();
  const compactions = main.events.filter((event): event is Extract<SessionEvent, { kind: 'compaction' }> => event.kind === 'compaction');
  // A compaction the transcript recorded may not say its sizes, so the typical sizes come from those that do.
  const sized = compactions.filter((event) => event.before > 0 && event.after > 0);
  const typical = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  const sizes = sized.length
    ? t('sessions.stat.compactionsHint', { before: formatTokens(typical(sized.map((event) => event.before))), after: formatTokens(typical(sized.map((event) => event.after))) })
    : '';
  const manual = compactions.filter((event) => event.trigger === 'manual').length;
  const automatic = compactions.filter((event) => event.trigger === 'auto').length;
  // The hint has room for one thing: what started them when the user did, else how big they typically were.
  const compactionHint = !session.hasOwnRequests
    ? t('sessions.stat.noOwnRequests')
    : !compactions.length
      ? t('sessions.stat.noCompactions')
      : manual
        ? (
          <span title={sizes || undefined}>
            {automatic
              ? t('sessions.stat.compactionTriggers', { manual, automatic })
              : t(manual === 1 ? 'sessions.stat.manualCompactions.one' : 'sessions.stat.manualCompactions.other', { count: manual })}
          </span>
        )
        : sizes || t('sessions.stat.compactionsRecorded');
  const hitRate = cacheHitRate(totals);
  const misses = checks.find((check): check is Extract<SessionCheck, { id: 'cacheMisses' }> => check.id === 'cacheMisses');
  const threads = session.threads.length;
  return (
    <StatsGrid columns={6}>
      <StatBlock label={t('sessions.stat.cost')} value={cost(costTotal(totals.cost) === 0 && totals.unpricedRequests ? null : costTotal(totals.cost))} hint={t('sessions.stat.costHint', { tokens: formatTokens(totals.inputTokens + totals.outputTokens) })} />
      <StatBlock
        label={t('sessions.stat.requests')}
        value={tokens(totals.requests)}
        hint={
          totals.failures
            ? t(totals.failures === 1 ? 'sessions.stat.failed.one' : 'sessions.stat.failed.other', { count: tokens(totals.failures) })
            : t(threads === 1 ? 'sessions.stat.threads.one' : 'sessions.stat.threads.other', { count: threads })
        }
      />
      <StatBlock
        label={t('sessions.stat.peak')}
        value={session.hasOwnRequests ? formatTokens(main.peak) : '—'}
        hint={t(session.hasOwnRequests ? 'sessions.stat.peakHint' : 'sessions.stat.noOwnRequests')}
        tone={main.peak > DEEP_CONTEXT_TOKENS ? 'warning' : 'default'}
      />
      <StatBlock
        label={t('sessions.stat.compactions')}
        value={session.hasOwnRequests ? tokens(main.compactions) : '—'}
        hint={compactionHint}
      />
      <StatBlock
        label={t('sessions.stat.cacheHit')}
        value={hitRate === null ? '—' : percent(hitRate)}
        hint={misses ? t(misses.count === 1 ? 'sessions.stat.misses.one' : 'sessions.stat.misses.other', { count: misses.count }) : t('sessions.stat.cacheHitHint')}
      />
      <StatBlock label={t('sessions.stat.active')} value={formatDuration(totals.activeMs)} hint={t('sessions.stat.activeHint', { span: formatDuration(totals.spanMs) })} />
    </StatsGrid>
  );
}

type EventText = { title: string; detail?: string };

function eventText(event: SessionEvent, t: Translate, threadName: (id: string) => string): EventText {
  switch (event.kind) {
    case 'compaction':
      return {
        title: event.before > 0 && event.after > 0
          ? t('sessions.event.compaction', { before: formatTokens(event.before), after: formatTokens(event.after) })
          : t('sessions.event.compactionPlain'),
        detail: [
          event.trigger === 'auto' ? t('sessions.event.compactionAuto') : event.trigger === 'manual' ? t('sessions.event.compactionManual') : '',
          event.summary >= SUMMARY_MIN_TOKENS
            ? t('sessions.event.compactionDetail', { summary: formatTokens(event.summary) })
            : event.recorded ? '' : t('sessions.event.dropDetail'),
          event.durationMs ? t('sessions.event.compactionDuration', { duration: formatDuration(event.durationMs) }) : '',
        ].filter(Boolean).join(' · ') || undefined,
      };
    case 'subagent': {
      const requests = event.thread.requests;
      return {
        title: t('sessions.event.subagent', { name: threadName(event.thread.id) }),
        detail: [
          event.thread.models[0],
          t(requests === 1 ? 'sessions.requestCount.one' : 'sessions.requestCount.other', { count: tokens(requests) }),
          event.thread.pricedRequests ? cost(event.thread.estimatedCost) : '',
        ].filter(Boolean).join(' · '),
      };
    }
    case 'failure':
      return {
        title: t(event.count === 1 ? 'sessions.event.failure.one' : 'sessions.event.failure.other', { count: event.count, status: event.status || '—' }),
        detail: event.message || undefined,
      };
    case 'change': {
      const label = (value: string) =>
        event.change === 'tier' ? t(`sessions.tier.${value as ReturnType<typeof speedTier>}`) : value || t('sessions.effort.default');
      return {
        title: t(`sessions.event.change.${event.change}`),
        detail: t('sessions.event.changeDetail', { from: label(event.from), to: label(event.to) }),
      };
    }
    case 'cacheMiss':
      return {
        title: event.idleMs >= COLD_CACHE_IDLE_MS ? t('sessions.event.cacheCold', { idle: formatDuration(event.idleMs) }) : t('sessions.event.cacheMiss'),
        detail: t('sessions.event.cacheDetail', { tokens: formatTokens(event.tokens), cost: cost(event.cost) }),
      };
    case 'idle':
      return { title: t('sessions.event.idle', { span: formatDuration(event.idleMs) }) };
    case 'longContext':
      return {
        title: t('sessions.event.longContext'),
        detail: event.threshold ? t('sessions.event.longContextDetail', { threshold: formatTokens(event.threshold) }) : undefined,
      };
  }
}

function SessionEvents({ thread, threadName, onHighlight }: { thread: ThreadTimeline; threadName: (id: string) => string; onHighlight: (at: number | null) => void }) {
  const { t } = useI18n();
  const { events } = thread;
  return (
    <SettingsSection title={t('sessions.events.title')} description={t('sessions.events.description')}>
      {events.length ? (
        <ol className="max-h-[28rem] divide-y divide-border/50 overflow-y-auto" onPointerLeave={() => onHighlight(null)}>
          {events.map((event, index) => {
            const text = eventText(event, t, threadName);
            const { icon: Icon, color } = EVENT_ICON[event.kind];
            return (
              <li
                key={`${event.kind}-${event.timestampMs}-${index}`}
                className="flex items-start gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-muted/40 dark:hover:bg-input/12"
                onPointerEnter={() => onHighlight(event.at >= 0 ? event.at : null)}
              >
                <Icon className={cn('mt-0.5 size-4 shrink-0', color)} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-foreground">{text.title}</p>
                  {text.detail ? <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground" title={text.detail}>{text.detail}</p> : null}
                </div>
                <time className="shrink-0 text-2xs tabular-nums text-muted-foreground" dateTime={new Date(event.timestampMs).toISOString()}>
                  {formatTime(event.timestampMs)}
                </time>
              </li>
            );
          })}
        </ol>
      ) : (
        <SettingsBlock className="py-6 text-center text-sm text-muted-foreground">{t('sessions.events.empty')}</SettingsBlock>
      )}
    </SettingsSection>
  );
}

const SESSION_CALLS_COLOR = 'bg-chart-1';
const SUBAGENT_CALLS_COLOR = 'bg-chart-2';

/** Which tools the session called and how often, from its transcript, with the subagents it started by type. */
function SessionTools({ session }: { session: UsageSession }) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const { transcript } = session;
  const usage = transcript?.toolUsage ?? null;
  const rows = useMemo(() => (usage ? toolRows(usage) : []), [usage]);
  const types = useMemo(() => (usage ? subagentTypes(usage) : []), [usage]);
  const skills = useMemo(() => (usage ? sessionSkills(usage) : []), [usage]);
  if (!transcript) return null;

  const withSubagents = rows.some((row) => row.subagentCalls > 0);
  const most = Math.max(1, ...rows.map((row) => row.calls + row.subagentCalls));
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  const subagentCalls = rows.reduce((sum, row) => sum + row.subagentCalls, 0);
  const shown = showAll ? rows : rows.slice(0, TOOLS_SHOWN);
  const empty = (text: string) => <TableEmpty>{text}</TableEmpty>;
  const swatch = (color: string) => <span className={cn('size-2 shrink-0 rounded-[2px]', color)} aria-hidden="true" />;

  return (
    <SettingsSection
      title={t('sessions.tools.title')}
      description={t('sessions.tools.description')}
    >
      {!usage ? (
        empty(t('sessions.tools.pending'))
      ) : !rows.length ? (
        empty(t('sessions.tools.empty'))
      ) : (
        <>
          {types.length ? (
            <SettingsBlock className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="mr-1 text-muted-foreground">{t('sessions.tools.subagents')}</span>
              {types.map((item) => (
                <Badge key={item.type ?? ''} variant="outline" size="lg" className="font-normal" title={item.type ? undefined : t('sessions.tools.defaultTypeHint')}>
                  <Bot className="text-chart-2" aria-hidden="true" />
                  {item.type ?? t('sessions.tools.defaultType')}
                  <span className="tabular-nums text-muted-foreground">{tokens(item.count)}</span>
                </Badge>
              ))}
            </SettingsBlock>
          ) : null}
          {skills.length ? (
            <SettingsBlock className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="mr-1 text-muted-foreground">{t('sessions.tools.skills')}</span>
              {skills.map((skill) => (
                <Badge
                  key={skill.name}
                  variant="outline"
                  size="lg"
                  className="font-normal"
                  title={skill.calls ? t(skill.calls === 1 ? 'sessions.tools.skillCalls.one' : 'sessions.tools.skillCalls.other', { count: skill.calls }) : t('sessions.tools.skillTyped')}
                >
                  <Sparkles className="text-chart-3" aria-hidden="true" />
                  <span className="font-mono">{skill.name}</span>
                  {skill.calls ? <span className="tabular-nums text-muted-foreground">{tokens(skill.calls)}</span> : null}
                </Badge>
              ))}
            </SettingsBlock>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('sessions.tools.column.tool')}</TableHead>
                <TableHead className="w-[34%]"><span className="sr-only">{t('sessions.tools.column.share')}</span></TableHead>
                <TableHead className={cn('w-24', TABLE_NUMERIC_CLASS)}>
                  <span className="inline-flex items-center gap-1.5">{withSubagents ? swatch(SESSION_CALLS_COLOR) : null}{t('sessions.tools.column.session')}</span>
                </TableHead>
                {withSubagents ? (
                  <TableHead className={cn('w-24', TABLE_NUMERIC_CLASS)}>
                    <span className="inline-flex items-center gap-1.5">{swatch(SUBAGENT_CALLS_COLOR)}{t('sessions.tools.column.subagents')}</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row) => {
                const label = toolLabel(row.key);
                return (
                  <TableRow key={row.key}>
                    <TableCell className="max-w-0">
                      <span className="flex min-w-0 items-baseline gap-1.5" title={row.key}>
                        <span className="truncate font-medium text-foreground">{label.name}</span>
                        {label.source ? <span className="truncate text-2xs text-muted-foreground">{label.source}</span> : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
                        <span className={cn('h-full', SESSION_CALLS_COLOR)} style={{ width: `${(row.calls / most) * 100}%` }} />
                        <span className={cn('h-full', SUBAGENT_CALLS_COLOR)} style={{ width: `${(row.subagentCalls / most) * 100}%` }} />
                      </span>
                    </TableCell>
                    <TableCell className={TABLE_NUMERIC_CLASS}>{row.calls ? tokens(row.calls) : '—'}</TableCell>
                    {withSubagents ? (
                      <TableCell className={TABLE_NUMERIC_CLASS}>{row.subagentCalls ? tokens(row.subagentCalls) : '—'}</TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
              <TableRow className="hover:bg-transparent">
                <TableCell className="text-xs text-muted-foreground" colSpan={2}>
                  {t(rows.length === 1 ? 'sessions.tools.total.one' : 'sessions.tools.total.other', { count: rows.length })}
                </TableCell>
                <TableCell className={cn(TABLE_NUMERIC_CLASS, 'font-medium')}>{tokens(calls)}</TableCell>
                {withSubagents ? <TableCell className={cn(TABLE_NUMERIC_CLASS, 'font-medium')}>{tokens(subagentCalls)}</TableCell> : null}
              </TableRow>
            </TableBody>
          </Table>
          {transcript.agent === 'codex' && session.subagents > 0 ? (
            <SettingsBlock className="text-xs text-muted-foreground">{t('sessions.tools.codexSubagents')}</SettingsBlock>
          ) : null}
          {/* The section has no footer of its own, so the table's sits last in the card. */}
          {rows.length > TOOLS_SHOWN ? (
            <div className="flex min-h-11 items-center gap-3 px-4 py-2">
              <TableShowAll shown={shown.length} total={rows.length} expanded={showAll} onToggle={() => setShowAll((current) => !current)} />
            </div>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

const COST_PARTS: { key: keyof CostParts; label: MessageKey; color: string }[] = [
  { key: 'cacheRead', label: 'sessions.cost.cacheRead', color: 'bg-chart-1' },
  { key: 'cacheWrite', label: 'sessions.cost.cacheWrite', color: 'bg-chart-2' },
  { key: 'input', label: 'sessions.cost.input', color: 'bg-chart-3' },
  { key: 'output', label: 'sessions.cost.output', color: 'bg-chart-4' },
];

function SessionCost({ totals }: { totals: SessionTotals }) {
  const { t } = useI18n();
  const total = costTotal(totals.cost);
  const share = (amount: number) => (total > 0 ? amount / total : 0);
  return (
    <SettingsSection title={t('sessions.cost.title')} description={t('sessions.cost.description')}>
      <SettingsBlock className="flex flex-col gap-3 py-4">
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
          {COST_PARTS.map((part) => (
            <span key={part.key} className={cn('h-full', part.color)} style={{ width: `${share(totals.cost[part.key]) * 100}%` }} />
          ))}
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1.5 text-xs">
          {COST_PARTS.map((part) => (
            <div key={part.key} className="contents">
              <span className={cn('size-2 rounded-[2px]', part.color)} aria-hidden="true" />
              <dt className="text-muted-foreground">{t(part.label)}</dt>
              <dd className="text-right tabular-nums text-muted-foreground">{percent(share(totals.cost[part.key]))}</dd>
              <dd className="text-right tabular-nums text-foreground">{cost(totals.cost[part.key])}</dd>
            </div>
          ))}
        </dl>
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-t border-border/50 pt-3 text-xs">
          <dt className="text-muted-foreground">{t('sessions.cost.subagents')}</dt>
          <dd className="text-right tabular-nums text-foreground">{cost(totals.subagentCost)}</dd>
          <dt className="text-muted-foreground">{t('sessions.cost.side')}</dt>
          <dd className="text-right tabular-nums text-foreground">{cost(totals.sideCost)}</dd>
        </dl>
        {totals.unpricedRequests ? (
          <p className="text-xs text-muted-foreground">
            {t(totals.unpricedRequests === 1 ? 'sessions.cost.unpriced.one' : 'sessions.cost.unpriced.other', { count: tokens(totals.unpricedRequests) })}
          </p>
        ) : null}
      </SettingsBlock>
    </SettingsSection>
  );
}

function checkText(check: SessionCheck): { title: MessageKey; body: MessageKey; values: Record<string, string | number> } {
  switch (check.id) {
    case 'deepContext':
      return { title: 'sessions.check.deepContext.title', body: 'sessions.check.deepContext.body', values: { peak: formatTokens(check.peak) } };
    case 'cacheMisses':
      return {
        title: check.count === 1 ? 'sessions.check.cacheMisses.title.one' : 'sessions.check.cacheMisses.title.other',
        body: 'sessions.check.cacheMisses.body',
        values: { count: check.count, tokens: formatTokens(check.tokens), cost: cost(check.cost) },
      };
    case 'longContext':
      return {
        title: 'sessions.check.longContext.title',
        body: check.requests === 1 ? 'sessions.check.longContext.body.one' : 'sessions.check.longContext.body.other',
        values: { count: tokens(check.requests), threshold: formatTokens(check.threshold) },
      };
    case 'fastSubagents':
      return {
        title: 'sessions.check.fastSubagents.title',
        body: check.threads === 1 ? 'sessions.check.fastSubagents.body.one' : 'sessions.check.fastSubagents.body.other',
        values: { count: check.threads },
      };
    case 'subagentShare':
      return { title: 'sessions.check.subagentShare.title', body: 'sessions.check.subagentShare.body', values: { cost: cost(check.cost), share: percent(check.share) } };
    case 'highEffort':
      return { title: 'sessions.check.highEffort.title', body: 'sessions.check.highEffort.body', values: { effort: check.effort, share: percent(check.share) } };
  }
}

function SessionChecks({ checks, transcript }: { checks: SessionCheck[]; transcript: SessionTranscript | null }) {
  const { t } = useI18n();
  return (
    <SettingsSection title={t('sessions.checks.title')} description={t('sessions.checks.description')}>
      {checks.length ? (
        checks.map((check) => {
          const { title, body, values } = checkText(check);
          return (
            <SettingsBlock key={check.id} className="flex items-start gap-3">
              <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{t(title, values)}</p>
                <p className="mt-0.5 text-xs leading-[1.45] text-muted-foreground">{t(body, values)}</p>
              </div>
            </SettingsBlock>
          );
        })
      ) : (
        <SettingsBlock className="py-6 text-center text-sm text-muted-foreground">{t('sessions.checks.empty')}</SettingsBlock>
      )}
      <SessionAntiburn transcript={transcript} />
    </SettingsSection>
  );
}

function SessionThreads({
  session,
  threadName,
  shownThreadId,
  onShowContext,
  onViewRequests,
}: {
  session: UsageSession;
  threadName: (id: string) => string;
  shownThreadId: string;
  onShowContext: (id: string) => void;
  onViewRequests: (id: string) => void;
}) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const threads = showAll ? session.threads : session.threads.slice(0, THREADS_SHOWN);
  return (
    <SettingsSection title={t('sessions.threads.title')} description={t('sessions.threads.description')}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('usage.sessions.column.thread')}</TableHead>
            <TableHead className="w-44">{t('usage.column.model')}</TableHead>
            <TableHead className={cn('w-20', TABLE_NUMERIC_CLASS)}>{t('usage.sessions.column.requests')}</TableHead>
            <TableHead className={cn('w-24', TABLE_NUMERIC_CLASS)}>{t('sessions.threads.column.peak')}</TableHead>
            <TableHead className={cn('w-24', TABLE_NUMERIC_CLASS)}>{t('sessions.threads.column.compactions')}</TableHead>
            <TableHead className={cn('w-20', TABLE_NUMERIC_CLASS)}>{t('usage.sessions.column.tokens')}</TableHead>
            <TableHead className={cn('w-20', TABLE_NUMERIC_CLASS)}>{t('usage.sessions.column.cost')}</TableHead>
            <TableHead className="w-28">{t('usage.sessions.detail.started')}</TableHead>
            <TableHead className="w-16"><span className="sr-only">{t('sessions.threads.actions')}</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {threads.map((thread: UsageSessionThread) => (
            <TableRow key={thread.id} className={cn(thread.id === shownThreadId && 'bg-muted/40')}>
              <TableCell className="max-w-0">
                <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: `${Math.max(0, thread.depth - 1) * 0.75}rem` }}>
                  {thread.depth > 0 ? <CornerDownRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" /> : null}
                  <span className="truncate font-medium text-foreground">{threadName(thread.id)}</span>
                  <span className="shrink-0 font-mono text-2xs text-muted-foreground" title={thread.id}>{shortSessionId(thread.id)}</span>
                </span>
              </TableCell>
              <TableCell className="max-w-0"><ModelNames models={thread.models} /></TableCell>
              <TableCell className={TABLE_NUMERIC_CLASS}>{tokens(thread.requests)}</TableCell>
              <TableCell className={cn(TABLE_NUMERIC_CLASS, thread.peakContext > DEEP_CONTEXT_TOKENS && 'text-warning-foreground')}>
                {thread.peakContext ? formatTokens(thread.peakContext) : '—'}
              </TableCell>
              <TableCell className={TABLE_NUMERIC_CLASS}>{thread.compactions ? tokens(thread.compactions) : '—'}</TableCell>
              <TableCell className={TABLE_NUMERIC_CLASS}>{formatTokens(thread.totalTokens)}</TableCell>
              <TableCell className={TABLE_NUMERIC_CLASS}>{cost(thread.pricedRequests ? thread.estimatedCost : null)}</TableCell>
              <TableCell className="tabular-nums text-muted-foreground">{formatDateTime(thread.startedAtMs)}</TableCell>
              <TableCell className="text-end">
                <span className="inline-flex items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger render={<Button variant="ghost-muted" size="icon-xs" onClick={() => onShowContext(thread.id)} aria-label={t('sessions.threads.showContext')} />}>
                      <LineChart />
                    </TooltipTrigger>
                    <TooltipPopup>{t('sessions.threads.showContext')}</TooltipPopup>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger render={<Button variant="ghost-muted" size="icon-xs" onClick={() => onViewRequests(thread.id)} aria-label={t('usage.sessions.viewThreadRequests')} />}>
                      <List />
                    </TooltipTrigger>
                    <TooltipPopup>{t('usage.sessions.viewThreadRequests')}</TooltipPopup>
                  </Tooltip>
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {/* The section has no footer of its own, so the table's sits last in the card. */}
      {session.threads.length > THREADS_SHOWN ? (
        <div className="flex min-h-11 items-center gap-3 px-4 py-2">
          <TableShowAll shown={threads.length} total={session.threads.length} expanded={showAll} onToggle={() => setShowAll((current) => !current)} />
        </div>
      ) : null}
    </SettingsSection>
  );
}

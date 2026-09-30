import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { invokeCommand } from '../native/commands';
import { AlertCircle, ChevronLeft, ChevronRight, CircleCheck, GitMerge, Share } from '../components/ui/icons';
import { useI18n } from '../i18n';
import { formatCount, formatDate, formatDateWith, formatMoney, formatNumber, formatUnpriced } from '../lib/format';
import { useAccountLimitPrefs } from '../services/accountLimits';
import { useAccountOrder } from '../services/accountOrder';
import { useAccountProfiles } from '../services/accountProfiles';
import { useAccountsStore } from '../services/accountsStore';
import { capacityReport, useLongLimitWindowsKey } from '../services/capacityReport';
import { digestFileName, digestPage } from '../services/digestPage';
import { EXPIRING_MIN_PERCENT } from '../services/expiringCapacity';
import { usePlanCosts } from '../services/planCosts';
import { providerLabel } from '../services/providerLimits';
import { useQuotaCache } from '../services/quotaCache';
import {
  cacheMissCost,
  change,
  digestWeek,
  DIGEST_PULL_REQUESTS,
  formatRatio,
  LIMIT_WARNING_PERCENT,
  loadWeeklyDigest,
  mergedHint,
  noMergedText,
  percentText,
  reloadDigestPullRequests,
  SAME_CHANGE,
  spendKnown,
  weekDays,
  weeklyDigest,
  type DigestLimit,
  type WeeklyDigest,
  type WeeklyDigestData,
} from '../services/weeklyDigest';
import { SettingsBlock, SettingsSection } from '../components/layout/settings';
import { StatBlock, StatsGrid } from '../components/layout/stats';
import { SessionLabel } from '../components/SessionLabel';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Progress } from '../components/ui/progress';
import { Skeleton } from '../components/ui/skeleton';
import { Spinner } from '../components/ui/spinner';
import { TABLE_NUMERIC_CLASS, TableEmpty } from '../components/ui/data-table';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { cn } from '../lib/utils';
import { Lines, openPullRequest } from './SessionProjectsView';
import { trackFeature } from '../services/productAnalytics';
import { ProviderMark } from '../components/identity/Identity';

/**
 * This week's digest refreshes this often while it's open: its numbers grow, and pull requests merge. A day's worth
 * of numbers hardly moves in a few minutes, and each refresh reads the whole week. A past week loads once.
 */
const REFRESH_MS = 5 * 60_000;
/** While GitHub is being asked about pull requests, the digest looks again this soon for what it said. */
const GITHUB_RECHECK_MS = 3_000;
/** How far back the week can go. */
const MAX_WEEKS_BACK = 52;


const number = formatCount;
const money = formatMoney;

type Export = { state: 'idle' | 'saving' } | { state: 'saved'; path: string } | { state: 'failed'; error: string };

/**
 * The Usage page's Weekly tab: a week's spend, what got done, how much of the
 * limits it used and what went to waste, against the week before.
 * `refreshKey` changes when the page's refresh button is pressed.
 */
export function UsageDigestView({ refreshKey, onOpenSession }: { refreshKey: number; onOpenSession?: (id: string) => void }) {
  const { t } = useI18n();
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<WeeklyDigestData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const windowsKey = useLongLimitWindowsKey();
  const { files } = useAccountsStore();
  const quotas = useQuotaCache();
  const profiles = useAccountProfiles();
  const prefs = useAccountLimitPrefs();
  const order = useAccountOrder();
  const costs = usePlanCosts();

  useEffect(() => {
    let disposed = false;
    let running = false;
    let recheck: number | undefined;
    // What this effect last loaded. The first load reads everything, so the refresh button does; later ones keep
    // the week before, and a GitHub recheck reads only the pull requests.
    let loaded: WeeklyDigestData | null = null;
    const load = async (pullRequestsOnly = false) => {
      if (running) return;
      running = true;
      setLoading(true);
      try {
        const next = pullRequestsOnly && loaded
          ? await reloadDigestPullRequests(loaded)
          : await loadWeeklyDigest(digestWeek(offset, Date.now()), windowsKey ? windowsKey.split('\n') : [], loaded);
        if (disposed) return;
        loaded = next;
        setData(next);
        setError('');
        window.clearTimeout(recheck);
        if (next.projects.github.checking) recheck = window.setTimeout(() => void load(true), GITHUB_RECHECK_MS);
      } catch (loadError) {
        if (!disposed) setError(String(loadError));
      } finally {
        running = false;
        if (!disposed) setLoading(false);
      }
    };
    void load();
    const timer = offset === 0
      ? window.setInterval(() => {
          if (!document.hidden) void load();
        }, REFRESH_MS)
      : undefined;
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.clearTimeout(recheck);
    };
  }, [offset, windowsKey, refreshKey]);

  const current = data?.week.offset === offset ? data : null;
  const digest = useMemo(() => {
    if (!current) return null;
    const nowMs = Date.now();
    const providers = current.capacity
      ? capacityReport({ data: current.capacity, files, quotas, profiles, prefs, order, costs, nowMs })
      : [];
    return weeklyDigest(current, providers, nowMs);
  }, [current, files, quotas, profiles, prefs, order, costs]);

  // A saved page belongs to the week it was saved from.
  const [exported, setExported] = useState<Export>({ state: 'idle' });
  useEffect(() => setExported({ state: 'idle' }), [offset]);
  const exportPage = async () => {
    if (!digest) return;
    setExported({ state: 'saving' });
    try {
      const path = await invokeCommand('save_digest_page', {
        fileName: digestFileName(digest.week),
        html: digestPage(digest, { t, nowMs: Date.now() }),
        fileType: t('digest.page.fileType'),
      });
      if (path) trackFeature('digest-exported');
      setExported(path ? { state: 'saved', path } : { state: 'idle' });
    } catch (error) {
      setExported({ state: 'failed', error: String(error) });
    }
  };
  const openPage = (path: string, reveal: boolean) => {
    invokeCommand('open_saved_page', { path, reveal }).catch((error) => setExported({ state: 'failed', error: String(error) }));
  };

  const week = current?.week ?? digestWeek(offset, Date.now());
  const weekName = offset === 0
    ? t('usage.digest.week.this')
    : offset === 1 ? t('usage.digest.week.last') : t('usage.digest.week.ago', { count: offset });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon-sm" onClick={() => setOffset(offset + 1)} disabled={offset >= MAX_WEEKS_BACK} aria-label={t('usage.digest.week.earlier')}>
          <ChevronLeft />
        </Button>
        <span className="min-w-40 px-1 text-center text-sm">
          <span className="font-medium text-foreground">{weekName}</span>
          <span className="text-muted-foreground"> · {weekDays(week)}</span>
        </span>
        <Button variant="outline" size="icon-sm" onClick={() => setOffset(offset - 1)} disabled={offset === 0} aria-label={t('usage.digest.week.later')}>
          <ChevronRight />
        </Button>
        {loading ? <Spinner className="ms-1 size-3.5 text-muted-foreground" /> : null}
        <span className="ms-auto text-xs text-muted-foreground">
          {offset === 0 ? t('usage.digest.week.comparedSoFar') : t('usage.digest.week.compared')}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="outline" size="sm" onClick={() => void exportPage()} disabled={!digest || exported.state === 'saving'} focusableWhenDisabled />}
          >
            {exported.state === 'saving' ? <Spinner /> : <Share />}
            {t('digest.page.export')}
          </TooltipTrigger>
          <TooltipPopup>{t('digest.page.exportHint')}</TooltipPopup>
        </Tooltip>
      </div>

      {exported.state === 'saved' ? (
        <Alert
          variant="success"
          icon={<CircleCheck />}
          action={
            <span className="flex items-center gap-1">
              <Button variant="ghost" size="xs" onClick={() => openPage(exported.path, false)}>{t('digest.page.open')}</Button>
              <Button variant="ghost" size="xs" onClick={() => openPage(exported.path, true)}>{t('digest.page.reveal')}</Button>
            </span>
          }
        >
          <AlertDescription className="truncate text-foreground" title={exported.path}>
            {t('digest.page.saved', { name: exported.path.split(/[\\/]/).pop() ?? exported.path })}
          </AlertDescription>
        </Alert>
      ) : exported.state === 'failed' ? (
        <Alert variant="error" icon={<AlertCircle />}>
          <AlertDescription>{t('digest.page.failed', { error: exported.error })}</AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="error" icon={<AlertCircle />}>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {digest ? <Digest digest={digest} onOpenSession={onOpenSession} /> : error ? null : <DigestSkeleton />}
    </div>
  );
}

function DigestSkeleton() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label={t('usage.loading')}>
      <StatsGrid columns={4}>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-2 px-4 py-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </StatsGrid>
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="space-y-2.5">
          <Skeleton className="mx-4 h-4 w-32" />
          <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs/5">
            {Array.from({ length: 3 }, (_, row) => (
              <div key={row} className="flex min-h-14 items-center gap-3 border-border/50 px-4 py-2.5 [&+&]:border-t">
                <Skeleton className="size-8 rounded-md" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-56" />
                  <Skeleton className="h-3 w-32" />
                </div>
                <Skeleton className="h-3.5 w-16" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** How much a number moved on the week it's compared with. `better` is the way that's good news, if either is. */
function Change({ current, previous, better }: { current: number; previous: number; better?: 'up' | 'down' }) {
  const moved = change(current, previous);
  if (moved === null || Math.abs(moved) < SAME_CHANGE) return null;
  const up = moved > 0;
  const good = better ? (better === 'up') === up : null;
  return (
    <span
      className={cn(
        'ms-2 font-sans text-xs font-medium',
        good === null ? 'text-muted-foreground' : good ? 'text-success-foreground' : 'text-warning-foreground',
      )}
    >
      {up ? '+' : '−'}{formatNumber(Math.round(Math.abs(moved) * 100))}%
    </span>
  );
}

function Digest({ digest, onOpenSession }: { digest: WeeklyDigest; onOpenSession?: (id: string) => void }) {
  const { t } = useI18n();
  const soFar = digest.week.offset === 0;
  const before = (value: string) => t(soFar ? 'usage.digest.before.soFar' : 'usage.digest.before.week', { value });

  return (
    <>
      <StatsGrid columns={4}>
        <StatBlock
          label={t('usage.digest.stat.spend')}
          value={spendKnown(digest) ? <>{money(digest.cost)}<Change current={digest.cost} previous={digest.previousCost} /></> : formatUnpriced()}
          hint={spendKnown(digest) ? before(money(digest.previousCost)) : t('usage.digest.stat.noPrices')}
        />
        <StatBlock
          label={t('usage.digest.stat.sessions')}
          value={<>{number(digest.sessions)}<Change current={digest.sessions} previous={digest.previousSessions} /></>}
          hint={before(number(digest.previousSessions))}
        />
        <StatBlock label={t('usage.digest.stat.merged')} value={number(digest.merged.length)} hint={mergedHint(digest, t)} />
        <StatBlock
          label={t('usage.digest.stat.lines')}
          value={digest.sessionsWithLines ? <Lines added={digest.linesAdded} removed={digest.linesRemoved} /> : '—'}
          hint={digest.sessionsWithLines
            ? t(digest.sessionsWithLines === 1 ? 'usage.projects.stat.linesHint.one' : 'usage.projects.stat.linesHint.other', { count: number(digest.sessionsWithLines) })
            : t('usage.projects.stat.noLines')}
        />
      </StatsGrid>
      <DoneSection digest={digest} />
      <ProjectsSection digest={digest} />
      {digest.costliest.length ? <SessionsSection digest={digest} onOpenSession={onOpenSession} /> : null}
      <LimitsSection limits={digest.limits} />
      <WasteSection digest={digest} />
    </>
  );
}

/** A row of the digest: an icon, what it is, and figures on the right. */
function DigestRow({ icon, title, detail, children, onClick }: { icon?: ReactNode; title: ReactNode; detail?: ReactNode; children?: ReactNode; onClick?: () => void }) {
  const content = (
    <>
      {icon ? (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background p-1.5 dark:bg-input/32">{icon}</span>
      ) : null}
      <span className="block min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        {detail ? <span className="block truncate text-2xs text-muted-foreground">{detail}</span> : null}
      </span>
      {children}
    </>
  );
  const className = 'flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left';
  return onClick ? (
    <button
      type="button"
      className={cn(className, 'cursor-pointer transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40 dark:hover:bg-input/16 dark:focus-visible:bg-input/16')}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

function DoneSection({ digest }: { digest: WeeklyDigest }) {
  const { t } = useI18n();
  const shown = digest.merged.slice(0, DIGEST_PULL_REQUESTS);
  const more = digest.merged.length - shown.length;
  return (
    <SettingsSection title={t('usage.digest.done.title')} description={t('usage.digest.done.description')}>
      {shown.length ? (
        <>
          {shown.map((pullRequest) => {
            const name = `${pullRequest.repository}#${pullRequest.number}`;
            const day = formatDate(pullRequest.github!.mergedAtMs!, { weekday: 'short' });
            return (
              <DigestRow
                key={pullRequest.url}
                icon={<GitMerge className="size-4 text-success-foreground" />}
                title={pullRequest.github?.title || name}
                detail={
                  <>
                    <span className="font-mono">{name}</span> · {pullRequest.project} · {t('usage.digest.done.mergedOn', { day })}
                  </>
                }
                onClick={() => openPullRequest(pullRequest.url)}
              >
                <span className="w-28 shrink-0 text-right text-xs">
                  {pullRequest.linesAdded || pullRequest.linesRemoved
                    ? <Lines added={pullRequest.linesAdded} removed={pullRequest.linesRemoved} />
                    : <span className="text-muted-foreground">—</span>}
                </span>
                <Tooltip>
                  <TooltipTrigger render={<span className="w-20 shrink-0 text-right text-sm text-foreground tabular-nums" />}>
                    {money(pullRequest.pricedRequests ? pullRequest.estimatedCost : null)}
                  </TooltipTrigger>
                  <TooltipPopup className="max-w-64">
                    {t(pullRequest.sessions === 1 ? 'usage.digest.done.costHint.one' : 'usage.digest.done.costHint.other', { count: number(pullRequest.sessions) })}
                  </TooltipPopup>
                </Tooltip>
              </DigestRow>
            );
          })}
          {more > 0 ? (
            <SettingsBlock className="py-2 text-xs text-muted-foreground">
              {t(more === 1 ? 'usage.digest.done.more.one' : 'usage.digest.done.more.other', { count: number(more) })}
            </SettingsBlock>
          ) : null}
        </>
      ) : (
        <SettingsBlock className="text-xs text-muted-foreground">{noMergedText(digest, t)}</SettingsBlock>
      )}
    </SettingsSection>
  );
}

function ProjectsSection({ digest }: { digest: WeeklyDigest }) {
  const { t } = useI18n();
  return (
    <SettingsSection title={t('usage.digest.projects.title')} description={t('usage.digest.projects.description')}>
      {digest.projects.length ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('usage.projects.column.project')}</TableHead>
                <TableHead className={`w-24 ${TABLE_NUMERIC_CLASS}`}>{t('usage.projects.column.sessions')}</TableHead>
                <TableHead className={`w-24 ${TABLE_NUMERIC_CLASS}`}>{t('usage.digest.projects.column.merged')}</TableHead>
                <TableHead className={`w-32 ${TABLE_NUMERIC_CLASS}`}>{t('usage.projects.column.lines')}</TableHead>
                <TableHead className={`w-24 ${TABLE_NUMERIC_CLASS}`}>{t('usage.projects.column.cost')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {digest.projects.map((project) => (
                <TableRow key={project.name}>
                  <TableCell className="max-w-0">
                    <span className="block truncate font-medium text-foreground">{project.name}</span>
                    {project.repository ? <span className="block truncate text-2xs text-muted-foreground">{project.repository}</span> : null}
                  </TableCell>
                  <TableCell className={TABLE_NUMERIC_CLASS}>{number(project.sessions)}</TableCell>
                  <TableCell className={TABLE_NUMERIC_CLASS}>
                    {project.merged ? number(project.merged) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className={TABLE_NUMERIC_CLASS}>
                    {project.sessionsWithLines ? <Lines added={project.linesAdded} removed={project.linesRemoved} /> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className={TABLE_NUMERIC_CLASS}>{money(project.pricedRequests ? project.estimatedCost : null)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {digest.moreProjects ? (
            <SettingsBlock className="py-2 text-xs text-muted-foreground">
              {t(digest.moreProjects === 1 ? 'usage.digest.projects.more.one' : 'usage.digest.projects.more.other', { count: number(digest.moreProjects) })}
            </SettingsBlock>
          ) : null}
        </>
      ) : (
        <TableEmpty>{t('usage.digest.projects.empty')}</TableEmpty>
      )}
    </SettingsSection>
  );
}

function SessionsSection({ digest, onOpenSession }: { digest: WeeklyDigest; onOpenSession?: (id: string) => void }) {
  const { t } = useI18n();
  return (
    <SettingsSection title={t('usage.digest.sessions.title')} description={t('usage.digest.sessions.description')}>
      {digest.costliest.map((session) => {
        // A session's cost in the week is part of the week's; past 100%, the two totals disagree.
        const share = digest.cost > 0 && session.estimatedCost <= digest.cost ? session.estimatedCost / digest.cost : null;
        const content = (
          <>
            <SessionLabel session={session} machine className="flex-1 text-sm" />
            {share !== null ? <span className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{t('usage.digest.sessions.share', { percent: percentText(share) })}</span> : null}
            <span className="w-20 shrink-0 text-right text-sm text-foreground tabular-nums">{money(session.estimatedCost)}</span>
          </>
        );
        const className = 'flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left';
        return onOpenSession ? (
          <button
            key={session.id}
            type="button"
            className={cn(className, 'cursor-pointer transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40 dark:hover:bg-input/16 dark:focus-visible:bg-input/16')}
            onClick={() => onOpenSession(session.id)}
          >
            {content}
          </button>
        ) : (
          <div key={session.id} className={className}>{content}</div>
        );
      })}
    </SettingsSection>
  );
}

function LimitsSection({ limits }: { limits: DigestLimit[] }) {
  const { t } = useI18n();
  return (
    <SettingsSection title={t('usage.digest.limits.title')} description={t('usage.digest.limits.description')}>
      {limits.length ? (
        limits.map((limit) => {
          const accounts = limit.measured === limit.accounts
            ? t(limit.accounts === 1 ? 'usage.digest.limits.accounts.one' : 'usage.digest.limits.accounts.other', { count: limit.accounts })
            : t('usage.digest.limits.measured', { measured: limit.measured, count: limit.accounts });
          return (
            <DigestRow
              key={limit.provider}
              icon={<ProviderMark provider={limit.provider} decorative className="size-full object-contain" />}
              title={providerLabel[limit.provider]}
              detail={[limit.window, accounts, limit.spare.length ? t('usage.digest.limits.spare', { names: limit.spare.join(', ') }) : ''].filter(Boolean).join(' · ')}
            >
              <Tooltip>
                <TooltipTrigger render={<span className="block w-44 shrink-0 space-y-1.5" />}>
                  <Progress
                    value={limit.percent ?? 0}
                    tone={limit.percent !== null && limit.percent >= LIMIT_WARNING_PERCENT ? 'warning' : 'primary'}
                    aria-label={t('usage.digest.limits.useLabel', { provider: providerLabel[limit.provider] })}
                  />
                  <span className="block truncate text-2xs text-muted-foreground tabular-nums">
                    {limit.percent === null ? t('usage.digest.limits.notYet') : t('usage.digest.limits.used', { percent: Math.round(limit.percent) })}
                  </span>
                </TooltipTrigger>
                <TooltipPopup>{t('usage.digest.limits.useHint', { window: limit.window })}</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger render={<span className="w-24 shrink-0 text-right text-sm text-foreground tabular-nums" />}>
                  {limit.ratio === null ? '—' : t('usage.digest.limits.ratio', { ratio: formatRatio(limit.ratio) })}
                </TooltipTrigger>
                <TooltipPopup>{t('usage.digest.limits.ratioHint')}</TooltipPopup>
              </Tooltip>
            </DigestRow>
          );
        })
      ) : (
        <SettingsBlock className="text-xs text-muted-foreground">{t('usage.digest.limits.empty')}</SettingsBlock>
      )}
    </SettingsSection>
  );
}

function WasteSection({ digest }: { digest: WeeklyDigest }) {
  const { t } = useI18n();
  const { cacheMisses, previousCacheMisses, unused } = digest;
  const day = (ms: number) => formatDateWith(ms, { weekday: 'short' });
  const figure = (value: ReactNode) => <span className="w-28 shrink-0 text-right text-sm text-foreground tabular-nums">{value}</span>;
  return (
    <SettingsSection title={t('usage.digest.waste.title')} description={t('usage.digest.waste.description')}>
      <DigestRow
        title={t('usage.digest.waste.cacheMisses')}
        detail={cacheMisses.requests
          ? t(cacheMisses.requests === 1 ? 'usage.digest.waste.cacheMissesDetail.one' : 'usage.digest.waste.cacheMissesDetail.other', {
              count: number(cacheMisses.requests),
              tokens: number(cacheMisses.tokens),
            })
          : t('usage.digest.waste.noCacheMisses')}
      >
        {figure(cacheMisses.requests
          ? (
              <>
                {money(cacheMissCost(cacheMisses))}
                {cacheMisses.pricedRequests && previousCacheMisses.pricedRequests
                  ? <Change current={cacheMisses.cost} previous={previousCacheMisses.cost} better="down" />
                  : null}
              </>
            )
          : '—')}
      </DigestRow>
      <DigestRow
        title={t('usage.digest.waste.failures')}
        detail={digest.failures
          ? t(digest.failures === 1 ? 'usage.digest.waste.failuresDetail.one' : 'usage.digest.waste.failuresDetail.other', { count: number(digest.failures) })
          : t('usage.digest.waste.noFailures')}
      >
        {figure(digest.failureRate
          ? <>{percentText(digest.failureRate)}<Change current={digest.failureRate} previous={digest.previousFailureRate ?? 0} better="down" /></>
          : '—')}
      </DigestRow>
      <DigestRow
        title={t('usage.digest.waste.unused')}
        detail={unused.length
          ? unused.map((item) => t('usage.digest.waste.unusedItem', { name: item.name, percent: Math.round(item.percent), day: day(item.resetAtMs) })).join('; ')
          : t('usage.digest.waste.noUnused', { percent: EXPIRING_MIN_PERCENT })}
      >
        {figure(unused.length ? number(unused.length) : '—')}
      </DigestRow>
    </SettingsSection>
  );
}

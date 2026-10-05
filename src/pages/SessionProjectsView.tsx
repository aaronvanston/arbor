import { Fragment, useState } from 'react';
import { invokeCommand } from '../native/commands';
import { ChevronDown, ChevronRight, GitBranch } from '../components/ui/icons';
import { useNothingRecorded } from '../hooks/useCollectorStatus';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatAgo, formatCount, formatDate, formatDateTime, formatMoney } from '../lib/format';
import {
  branchPullRequests,
  projectsTotals,
  pullRequestStatus,
  summarizePullRequests,
} from '../services/sessionProjects';
import { SettingsSection } from '../components/layout/settings';
import { StatBlock, StatsGrid } from '../components/layout/stats';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TABLE_NUMERIC_CLASS, TableEmpty, TableShowAll } from '../components/ui/data-table';
import { Spinner } from '../components/ui/spinner';
import { StatusDot } from '../components/ui/status-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { MiddleTruncate } from '../components/ui/middle-truncate';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { cn } from '../lib/utils';
import { pullRequestSignals, pullRequestSignalsText } from '../services/pullRequestSignals';
import { plainError } from '../services/plainError';
import { PULL_REQUEST_BADGES, PullRequestSignals, PullRequestStateBadge } from '../components/PullRequestSignals';
import type { ProjectPullRequest, ProjectTotals, SessionProjectsReport } from '../native/types';

/** The pull requests listed before "Show all". */
const PULL_REQUESTS_SHOWN = 50;

const compactNumber = formatCount;
const formatUsd = formatMoney;

/** Narrows the Sessions list to what a row covers. */
export type OpenSessions = (filters: { project: string; branch?: string; search?: string }) => void;

export const openPullRequest = (url: string) => {
  invokeCommand('open_external_url', { url }).catch((error) => console.warn('Failed to open the pull request', error));
};

/**
 * The Sessions page's Projects view: what each project and branch cost, the
 * lines their sessions changed, and the pull requests those sessions worked
 * on, with whether each merged when the GitHub CLI can say.
 */
export function SessionProjectsView({
  report,
  onOpenSessions,
  onCheckGithub,
}: {
  report: SessionProjectsReport;
  onOpenSessions: OpenSessions;
  /** Asks GitHub about the pull requests again now. */
  onCheckGithub: () => void;
}) {
  const { t } = useI18n();
  const summary = summarizePullRequests(report.pullRequests);
  const totals = projectsTotals(report);
  const { unplaced } = report;

  // With nothing priced, $0.00 would read as free.
  const costStat = summary.costPerMerged !== null
    ? {
        label: t('usage.projects.stat.costPerMerged'),
        value: formatUsd(summary.pricedMerged ? summary.costPerMerged : null),
        hint: summary.pricedMerged
          ? t(summary.merged === 1 ? 'usage.projects.stat.costPerMergedHint.one' : 'usage.projects.stat.costPerMergedHint.other', {
              amount: formatUsd(summary.mergedCost),
              count: compactNumber(summary.merged),
            })
          : t('usage.projects.stat.noPrices'),
      }
    : {
        label: t('usage.projects.stat.costPerPullRequest'),
        value: summary.costPerPullRequest === null ? '—' : formatUsd(summary.priced ? summary.costPerPullRequest : null),
        hint: !summary.total
          ? t('usage.projects.stat.noPullRequests')
          : summary.priced
            ? t(summary.total === 1 ? 'usage.projects.stat.costPerPullRequestHint.one' : 'usage.projects.stat.costPerPullRequestHint.other', {
                amount: formatUsd(summary.cost),
                count: compactNumber(summary.total),
              })
            : t('usage.projects.stat.noPrices'),
      };

  return (
    <>
      <StatsGrid columns={4}>
        <StatBlock
          label={t('usage.projects.stat.projects')}
          value={compactNumber(report.projects.length)}
          hint={unplaced.sessions
            ? t(unplaced.sessions === 1 ? 'usage.projects.stat.unplaced.one' : 'usage.projects.stat.unplaced.other', { count: compactNumber(unplaced.sessions) })
            : t(totals.sessions === 1 ? 'usage.projects.stat.projectsHint.one' : 'usage.projects.stat.projectsHint.other', { count: compactNumber(totals.sessions) })}
        />
        <StatBlock
          label={t('usage.projects.stat.pullRequests')}
          value={compactNumber(summary.total)}
          hint={!summary.total
            ? t('usage.projects.stat.noPullRequests')
            : summary.unknown === summary.total
              ? t('usage.projects.stat.notChecked')
              : t('usage.projects.stat.pullRequestsHint', { merged: compactNumber(summary.merged), open: compactNumber(summary.open) })}
        />
        <StatBlock label={costStat.label} value={costStat.value} hint={costStat.hint} />
        <StatBlock
          label={t('usage.projects.stat.lines')}
          value={totals.sessionsWithLines ? <Lines added={totals.linesAdded} removed={totals.linesRemoved} /> : '—'}
          hint={totals.sessionsWithLines
            ? t(totals.sessionsWithLines === 1 ? 'usage.projects.stat.linesHint.one' : 'usage.projects.stat.linesHint.other', { count: compactNumber(totals.sessionsWithLines) })
            : t('usage.projects.stat.noLines')}
        />
      </StatsGrid>
      {summary.total ? <GithubNote report={report} onRetry={onCheckGithub} /> : null}
      <ProjectsSection report={report} onOpenSessions={onOpenSessions} />
      {summary.total ? <PullRequestsSection pullRequests={report.pullRequests} onOpenSessions={onOpenSessions} /> : null}
    </>
  );
}

/** Why pull requests show no state, when GitHub can't be asked. */
function GithubNote({ report, onRetry }: { report: SessionProjectsReport; onRetry: () => void }) {
  const { t } = useI18n();
  const { github } = report;
  if (github.checking) {
    return (
      <p className="-mt-3 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <Spinner className="size-3" />
        {t('usage.projects.github.checking')}
      </p>
    );
  }
  const message = github.last === 'missing'
    ? t('usage.projects.github.missing')
    : github.last === 'signedOut'
      ? t('usage.projects.github.signedOut')
      : github.last === 'failed'
        ? t('usage.projects.github.failed', { message: plainError(github.message, t) })
        : github.last === 'ok' && github.detailError
          ? t('usage.projects.github.detailFailed', { message: plainError(github.detailError, t) })
          : '';
  if (!message) return null;
  return (
    <p className="-mt-3 flex flex-wrap items-center gap-x-2 px-1 text-xs text-muted-foreground">
      <span>{message}</span>
      <Button variant="ghost-muted" size="xs" onClick={onRetry}>
        <RefreshIcon />
        {t('common.retry')}
      </Button>
    </p>
  );
}

export function Lines({ added, removed, className }: { added: number; removed: number; className?: string }) {
  return (
    <span className={cn('whitespace-nowrap tabular-nums', className)}>
      <span className="text-success-foreground">+{compactNumber(added)}</span>{' '}
      <span className="text-error-foreground">−{compactNumber(removed)}</span>
    </span>
  );
}

/** The columns a project and each of its branches share. */
/** A session count's button reads as what it opens, not just the number. */
function sessionsLabel(t: ReturnType<typeof useI18n>['t'], count: number) {
  return t(count === 1 ? 'usage.projects.viewSessionsCount.one' : 'usage.projects.viewSessionsCount.other', { count: compactNumber(count) });
}

function TotalsCells({ totals, pullRequests, now, onOpenSessions }: {
  totals: ProjectTotals;
  pullRequests: ProjectPullRequest[];
  now: number;
  /** None for sessions the list can't be narrowed to. */
  onOpenSessions?: () => void;
}) {
  const { t } = useI18n();
  const merged = pullRequests.filter((pullRequest) => pullRequest.github?.state === 'merged').length;
  return (
    <>
      <TableCell className={TABLE_NUMERIC_CLASS}>
        {onOpenSessions ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={sessionsLabel(t, totals.sessions)}
                  className="cursor-pointer rounded-sm text-foreground underline decoration-muted-foreground/50 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenSessions();
                  }}
                />
              }
            >
              {compactNumber(totals.sessions)}
            </TooltipTrigger>
            <TooltipPopup>{t('usage.projects.viewSessions')}</TooltipPopup>
          </Tooltip>
        ) : compactNumber(totals.sessions)}
        {totals.active ? <span className="block text-2xs text-success-foreground">{t('usage.projects.active', { count: compactNumber(totals.active) })}</span> : null}
      </TableCell>
      <TableCell className={TABLE_NUMERIC_CLASS}>
        {pullRequests.length ? compactNumber(pullRequests.length) : '—'}
        {merged ? <span className="block text-2xs text-muted-foreground">{t('usage.projects.merged', { count: compactNumber(merged) })}</span> : null}
      </TableCell>
      <TableCell className={TABLE_NUMERIC_CLASS}>
        {totals.sessionsWithLines ? <Lines added={totals.linesAdded} removed={totals.linesRemoved} /> : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className={TABLE_NUMERIC_CLASS}>{compactNumber(totals.totalTokens)}</TableCell>
      <TableCell className={TABLE_NUMERIC_CLASS}>{formatUsd(totals.pricedRequests ? totals.estimatedCost : null)}</TableCell>
      <TableCell className="text-muted-foreground" title={totals.lastActiveAtMs ? formatDateTime(totals.lastActiveAtMs, { year: 'always' }) : undefined}>
        {totals.lastActiveAtMs ? formatAgo(totals.lastActiveAtMs, now) : '—'}
      </TableCell>
    </>
  );
}

function ProjectsSection({ report, onOpenSessions }: { report: SessionProjectsReport; onOpenSessions: OpenSessions }) {
  const { t } = useI18n();
  const nothingYet = useNothingRecorded();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const now = Date.now();
  const { unplaced } = report;
  const toggle = (name: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  return (
    <SettingsSection title={t('usage.projects.title')} description={t('usage.projects.description')}>
      {report.projects.length || unplaced.sessions ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('usage.projects.column.project')}</TableHead>
              <TableHead className={cn('w-24', TABLE_NUMERIC_CLASS)}>{t('usage.projects.column.sessions')}</TableHead>
              <TableHead className={cn('w-24', TABLE_NUMERIC_CLASS)}>{t('usage.projects.column.pullRequests')}</TableHead>
              <TableHead className={cn('w-32', TABLE_NUMERIC_CLASS)}>{t('usage.projects.column.lines')}</TableHead>
              <TableHead className={cn('w-24', TABLE_NUMERIC_CLASS)}>{t('usage.projects.column.tokens')}</TableHead>
              <TableHead className={cn('w-24', TABLE_NUMERIC_CLASS)}>{t('usage.projects.column.cost')}</TableHead>
              <TableHead className="w-32">{t('usage.projects.column.lastActive')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.projects.map((project) => {
              const open = expanded.has(project.name);
              const pullRequests = report.pullRequests.filter((pullRequest) => pullRequest.project === project.name);
              return (
                <Fragment key={project.name}>
                  <TableRow className={cn('cursor-pointer', open && 'bg-muted/40')} onClick={() => toggle(project.name)}>
                    <TableCell className="max-w-0">
                      <span className="flex min-w-0 items-center gap-2">
                        <button
                          type="button"
                          className="flex shrink-0 cursor-pointer items-center rounded-sm text-icon-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5"
                          aria-expanded={open}
                          aria-label={t(open ? 'usage.projects.collapse' : 'usage.projects.expand', { name: project.name })}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggle(project.name);
                          }}
                        >
                          {open ? <ChevronDown /> : <ChevronRight />}
                        </button>
                        {project.active ? <StatusDot tone="success" pulse /> : null}
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-foreground">{project.name}</span>
                          {project.repository ? <span className="block truncate text-2xs text-muted-foreground">{project.repository}</span> : null}
                        </span>
                      </span>
                    </TableCell>
                    <TotalsCells totals={project} pullRequests={pullRequests} now={now} onOpenSessions={() => onOpenSessions({ project: project.name })} />
                  </TableRow>
                  {open
                    ? project.branches.map((branch) => {
                        const fromBranch = branchPullRequests(report.pullRequests, project.name, branch.name);
                        return (
                          <TableRow key={`${project.name}\n${branch.name}`} className="bg-muted/20">
                            <TableCell className="max-w-0">
                              <span className="flex min-w-0 items-center gap-1.5 ps-6">
                                <GitBranch className="size-3.5 shrink-0 text-icon-muted" aria-hidden="true" />
                                {branch.name
                                  ? <MiddleTruncate value={branch.name} className="font-mono text-foreground" />
                                  : <span className="truncate text-muted-foreground">{t('usage.projects.noBranch')}</span>}
                                {fromBranch.map((pullRequest) => <PullRequestChip key={pullRequest.url} pullRequest={pullRequest} />)}
                              </span>
                            </TableCell>
                            <TotalsCells
                              totals={branch}
                              pullRequests={fromBranch}
                              now={now}
                              onOpenSessions={branch.name ? () => onOpenSessions({ project: project.name, branch: branch.name }) : undefined}
                            />
                          </TableRow>
                        );
                      })
                    : null}
                </Fragment>
              );
            })}
            {unplaced.sessions ? (
              <TableRow>
                <TableCell className="max-w-0 text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger render={<span className="block truncate ps-5.5" />}>{t('usage.projects.unplaced')}</TooltipTrigger>
                    <TooltipPopup>{t('usage.projects.unplacedHint')}</TooltipPopup>
                  </Tooltip>
                </TableCell>
                <TotalsCells totals={unplaced} pullRequests={[]} now={now} />
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      ) : (
        <TableEmpty>{t(nothingYet ? 'usage.sessions.emptyYet' : 'usage.projects.empty')}</TableEmpty>
      )}
    </SettingsSection>
  );
}

/** A pull request by number, colored by its state, that opens it on GitHub. Its tooltip says how it stands. */
function PullRequestChip({ pullRequest }: { pullRequest: ProjectPullRequest }) {
  const { t } = useI18n();
  const status = pullRequestStatus(pullRequest);
  const name = `${pullRequest.repository}#${pullRequest.number}`;
  const standing = pullRequestSignalsText(pullRequestSignals(pullRequest.github, t));
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="shrink-0 cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('usage.pullRequests.open', { name })}
            onClick={(event) => {
              event.stopPropagation();
              openPullRequest(pullRequest.url);
            }}
          />
        }
      >
        <Badge variant={PULL_REQUEST_BADGES[status]} size="sm" className="tabular-nums">#{pullRequest.number}</Badge>
      </TooltipTrigger>
      <TooltipPopup>
        {pullRequest.github?.title || name} · {t(`usage.pullRequests.state.${status}` as MessageKey)}
        {standing ? <span className="block text-muted-foreground">{standing}</span> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

function PullRequestsSection({ pullRequests, onOpenSessions }: { pullRequests: ProjectPullRequest[]; onOpenSessions: OpenSessions }) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const now = Date.now();
  const shown = showAll ? pullRequests : pullRequests.slice(0, PULL_REQUESTS_SHOWN);
  const day = (ms: number) => formatDate(ms);

  return (
    <SettingsSection
      title={t('usage.pullRequests.title')}
      description={t('usage.pullRequests.description')}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('usage.pullRequests.column.pullRequest')}</TableHead>
            <TableHead className="w-32">{t('usage.pullRequests.column.state')}</TableHead>
            <TableHead className="w-48">{t('usage.pullRequests.column.branch')}</TableHead>
            <TableHead className={cn('w-24', TABLE_NUMERIC_CLASS)}>{t('usage.projects.column.sessions')}</TableHead>
            <TableHead className={cn('w-32', TABLE_NUMERIC_CLASS)}>{t('usage.projects.column.lines')}</TableHead>
            <TableHead className={cn('w-24', TABLE_NUMERIC_CLASS)}>{t('usage.projects.column.cost')}</TableHead>
            <TableHead className="w-32">{t('usage.projects.column.lastActive')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((pullRequest) => {
            const status = pullRequestStatus(pullRequest);
            const name = `${pullRequest.repository}#${pullRequest.number}`;
            const { github } = pullRequest;
            const when = github?.mergedAtMs
              ? t('usage.pullRequests.mergedAt', { date: day(github.mergedAtMs) })
              : status === 'closed' && github?.closedAtMs
                ? t('usage.pullRequests.closedAt', { date: day(github.closedAtMs) })
                : '';
            return (
              <TableRow
                key={pullRequest.url}
                className="cursor-pointer"
                onClick={() => openPullRequest(pullRequest.url)}
              >
                <TableCell className="max-w-0">
                  <button
                    type="button"
                    className="block max-w-full cursor-pointer truncate rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={pullRequest.url}
                    aria-label={t('usage.pullRequests.open', { name })}
                    onClick={(event) => {
                      // The row opens it too.
                      event.stopPropagation();
                      openPullRequest(pullRequest.url);
                    }}
                  >
                    <span className={cn('font-mono', github?.title ? 'text-muted-foreground' : 'font-medium text-foreground')}>#{pullRequest.number}</span>
                    {github?.title ? <span className="font-medium text-foreground"> {github.title}</span> : null}
                  </button>
                  <span className="block truncate text-2xs text-muted-foreground">{pullRequest.repository}</span>
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-1.5">
                    <PullRequestStateBadge github={github} />
                    <PullRequestSignals github={github} />
                  </span>
                  {when ? <span className="block pt-0.5 text-2xs text-muted-foreground">{when}</span> : null}
                </TableCell>
                <TableCell className="max-w-0">
                  <MiddleTruncate value={pullRequest.branch || '—'} title={pullRequest.branch || undefined} className="flex font-mono text-foreground" />
                  <span className="block truncate text-2xs text-muted-foreground">{pullRequest.project}</span>
                </TableCell>
                <TableCell className={TABLE_NUMERIC_CLASS}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={sessionsLabel(t, pullRequest.sessions)}
                          className="cursor-pointer rounded-sm text-foreground underline decoration-muted-foreground/50 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenSessions(pullRequest.branch
                              ? { project: pullRequest.project, branch: pullRequest.branch }
                              : { project: pullRequest.project, search: `#${pullRequest.number}` });
                          }}
                        />
                      }
                    >
                      {compactNumber(pullRequest.sessions)}
                    </TooltipTrigger>
                    <TooltipPopup>{t('usage.projects.viewSessions')}</TooltipPopup>
                  </Tooltip>
                </TableCell>
                <TableCell className={TABLE_NUMERIC_CLASS}>
                  {pullRequest.linesAdded || pullRequest.linesRemoved
                    ? <Lines added={pullRequest.linesAdded} removed={pullRequest.linesRemoved} />
                    : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className={TABLE_NUMERIC_CLASS}>{formatUsd(pullRequest.pricedRequests ? pullRequest.estimatedCost : null)}</TableCell>
                <TableCell className="text-muted-foreground" title={formatDateTime(pullRequest.lastActiveAtMs, { year: 'always' })}>
                  {formatAgo(pullRequest.lastActiveAtMs, now)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {/* The section has no footer of its own, so the table's sits last in the card. */}
      {pullRequests.length > PULL_REQUESTS_SHOWN ? (
        <div className="flex min-h-11 items-center gap-3 px-4 py-2">
          <TableShowAll shown={shown.length} total={pullRequests.length} expanded={showAll} onToggle={() => setShowAll((current) => !current)} />
        </div>
      ) : null}
    </SettingsSection>
  );
}

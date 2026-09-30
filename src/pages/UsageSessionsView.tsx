import { MessagesSquare } from '../components/ui/icons';
import { useNothingRecorded } from '../hooks/useCollectorStatus';
import { useI18n } from '../i18n';
import { formatAgo, formatCount, formatDateTime, formatMoney, formatTokens } from '../lib/format';
import { DEEP_CONTEXT_TOKENS } from '../services/sessionTimeline';
import {
  sessionClient,
  sessionPlace,
  sessionSorts,
  shortSessionId,
  type UsageSessionSort,
} from '../services/usageSessions';
import { StatBlock, StatsGrid } from '../components/layout/stats';
import { TableCard, TablePager } from '../components/ui/data-table';
import { Empty, EmptyDescription, EmptyMedia } from '../components/ui/empty';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { StatusDot } from '../components/ui/status-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { cn } from '../lib/utils';
import { MachinePill, ModelNames } from '../components/identity/Identity';
import { FleetStatusDot } from '../components/FleetBoard';
import { useNeedsYouBySession } from '../services/fleetBoard';
import type { UsageSession, UsageSessionPage } from '../native/types';

/**
 * The session's name is what you scan, so it gets whatever room is left. The other columns are as wide
 * as their content, models and machines truncate past a cap, and as the table narrows Subagents then
 * Machine drop out (both are on the session's own page) before the name gets squeezed.
 */
const HIDE_SUBAGENTS = '@max-[60rem]:hidden';
const HIDE_MACHINE = '@max-[52rem]:hidden';

export function SessionsView({
  sessions,
  search,
  pageSize,
  sort,
  onOpen,
  onPage,
  onPageSizeChange,
  onSortChange,
}: {
  sessions: UsageSessionPage;
  /** The words searched for, if any. */
  search: string;
  pageSize: number;
  sort: UsageSessionSort;
  onOpen: (id: string) => void;
  onPage: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onSortChange: (sort: UsageSessionSort) => void;
}) {
  const { t } = useI18n();
  const nothingYet = useNothingRecorded();
  const { summary } = sessions;
  const now = Date.now();
  const startRecordNum = sessions.total > 0 ? (sessions.page - 1) * sessions.pageSize + 1 : 0;
  const endRecordNum = Math.min(sessions.page * sessions.pageSize, sessions.total);
  const averageCost = summary.sessions ? summary.estimatedCost / summary.sessions : 0;
  // With nothing priced, $0.00 would read as free; with no requests at all it's right.
  const priced = summary.pricedRequests > 0 || !summary.requests;

  return (
    <>
      <StatsGrid columns={4}>
        <StatBlock label={t('usage.sessions.stat.sessions')} value={formatCount(summary.sessions)} hint={t('usage.sessions.stat.sessionsHint', { requests: formatCount(summary.requests) })} />
        <StatBlock label={t('usage.sessions.stat.active')} value={formatCount(summary.active)} tone={summary.active ? 'success' : 'default'} hint={t('usage.sessions.stat.activeHint')} />
        <StatBlock label={t('usage.sessions.stat.subagents')} value={formatCount(summary.subagentThreads)} hint={t('usage.sessions.stat.subagentsHint')} />
        <StatBlock label={t('usage.sessions.stat.averageCost')} value={formatMoney(priced ? averageCost : null)} hint={priced ? t('usage.sessions.stat.averageCostHint', { total: formatMoney(summary.estimatedCost) }) : t('usage.sessions.stat.noPrices')} />
      </StatsGrid>
      {summary.untrackedRequests > 0 ? (
        <p className="-mt-3 px-1 text-xs text-muted-foreground">
          {t(summary.untrackedRequests === 1 ? 'usage.sessions.untracked.one' : 'usage.sessions.untracked.other', { count: formatCount(summary.untrackedRequests) })}
        </p>
      ) : null}
      <TableCard
        title={t('usage.sessions.title')}
        count={t(sessions.total === 1 ? 'usage.sessions.count.one' : 'usage.sessions.count.other', { count: formatCount(sessions.total) })}
        toolbar={
          <Select value={sort} onValueChange={(value) => onSortChange((value ?? 'recent') as UsageSessionSort)}>
            <SelectTrigger size="sm" className="w-auto min-w-0" aria-label={t('usage.sessions.sortLabel')}>
              <SelectValue>{t(`usage.sessions.sort.${sort}`)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              {sessionSorts.map((option) => <SelectItem key={option} value={option}>{t(`usage.sessions.sort.${option}`)}</SelectItem>)}
            </SelectPopup>
          </Select>
        }
        footer={sessions.total > 0 ? (
          <TablePager
            first={startRecordNum}
            last={endRecordNum}
            total={sessions.total}
            page={sessions.page}
            totalPages={sessions.totalPages}
            pageSize={pageSize}
            onPage={onPage}
            onPageSizeChange={onPageSizeChange}
          />
        ) : null}
      >
        {sessions.items.length ? (
          <Table containerClassName="@container" className="min-w-[42rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-full">{t('usage.sessions.column.session')}</TableHead>
                <TableHead>{t('usage.sessions.column.models')}</TableHead>
                <TableHead className={HIDE_MACHINE}>{t('usage.column.machine')}</TableHead>
                <TableHead className={cn('text-end', HIDE_SUBAGENTS)}>{t('usage.sessions.column.subagents')}</TableHead>
                <TableHead className="text-end"><span title={t('usage.sessions.contextTitle')}>{t('usage.sessions.column.context')}</span></TableHead>
                <TableHead className="text-end">{t('usage.sessions.column.requests')}</TableHead>
                <TableHead className="text-end">{t('usage.sessions.column.tokens')}</TableHead>
                <TableHead className="text-end">{t('usage.sessions.column.cost')}</TableHead>
                <TableHead>{t('usage.sessions.column.lastActive')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.items.map((item) => (
                <TableRow key={item.id} className="cursor-pointer transition-colors hover:bg-muted/50 dark:hover:bg-input/16" onClick={() => onOpen(item.id)}>
                  <TableCell className="w-full max-w-0 text-xs">
                    <SessionName session={item} onOpen={onOpen} />
                  </TableCell>
                  <TableCell className="text-xs">
                    <ModelNames models={item.models} className="flex max-w-40 @max-[52rem]:max-w-28" />
                  </TableCell>
                  <TableCell className={cn('text-xs', HIDE_MACHINE)}>
                    <MachinePill name={item.machine || item.transcript?.machine} fallback="—" className="max-w-32" />
                  </TableCell>
                  <TableCell className={cn('text-end text-xs tabular-nums', HIDE_SUBAGENTS)}>{item.subagents ? formatCount(item.subagents) : '—'}</TableCell>
                  <TableCell className={cn('text-end text-xs tabular-nums', item.peakContext > DEEP_CONTEXT_TOKENS && 'text-warning-foreground')}>
                    {item.peakContext ? formatTokens(item.peakContext) : '—'}
                    {item.compactions ? (
                      <span className="block text-2xs text-muted-foreground">
                        {t(item.compactions === 1 ? 'usage.sessions.compactions.one' : 'usage.sessions.compactions.other', { count: formatCount(item.compactions) })}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-end text-xs tabular-nums">
                    {formatCount(item.requests)}
                    {item.failures ? <span className="block text-2xs text-error-foreground">{t('usage.sessions.failed', { count: formatCount(item.failures) })}</span> : null}
                  </TableCell>
                  <TableCell className="text-end text-xs tabular-nums">{formatCount(item.totalTokens)}</TableCell>
                  <TableCell className="text-end text-xs tabular-nums">{formatMoney(item.pricedRequests ? item.estimatedCost : null)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground" title={formatDateTime(item.lastActiveAtMs, { year: 'always' })}>
                    {formatAgo(item.lastActiveAtMs, now)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty size="sm">
            <EmptyMedia><MessagesSquare /></EmptyMedia>
            <EmptyDescription>{search ? t('usage.sessions.emptySearch', { search }) : t(nothingYet ? 'usage.sessions.emptyYet' : 'usage.sessions.empty')}</EmptyDescription>
          </Empty>
        )}
      </TableCard>
    </>
  );
}

function SessionName({ session, onOpen }: { session: UsageSession; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const fleetRow = useNeedsYouBySession().get(session.id);
  const client = sessionClient(session.userAgent);
  const name = client ? [client.name, client.version].filter(Boolean).join(' ') : t('usage.sessions.unknownClient');
  const title = session.transcript?.title ?? '';
  const place = sessionPlace(session.transcript);
  return (
    <span className="flex min-w-0 items-center gap-2">
      {fleetRow ? (
        <FleetStatusDot row={fleetRow} now={Date.now()} />
      ) : session.active ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
            <StatusDot tone="success" pulse />
          </TooltipTrigger>
          <TooltipPopup>{t('usage.sessions.activeTitle')}</TooltipPopup>
        </Tooltip>
      ) : null}
      <span className="min-w-0">
        <button
          type="button"
          className="block max-w-full cursor-pointer truncate rounded-sm text-left font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={[title, session.userAgent].filter(Boolean).join('\n') || undefined}
          aria-label={t('usage.sessions.open', { name: title || `${name} ${shortSessionId(session.id)}` })}
          onClick={(event) => {
            // The row opens it too.
            event.stopPropagation();
            onOpen(session.id);
          }}
        >
          {title || name}
          {!title && client?.host ? <span className="font-normal text-muted-foreground"> · {client.host}</span> : null}
        </button>
        {place ? (
          <span className="block truncate text-2xs text-muted-foreground" title={place.folder}>
            {place.project}
            {place.branch && place.branch !== place.project ? <span className="font-mono"> · {place.branch}</span> : null}
          </span>
        ) : (
          <span className="block truncate font-mono text-2xs text-muted-foreground" title={session.id}>{shortSessionId(session.id)}</span>
        )}
      </span>
    </span>
  );
}

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ChevronRight, Gauge, TriangleAlert } from '../components/ui/icons';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { TABLE_NUMERIC_CLASS, TableCard } from '../components/ui/data-table';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Spinner } from '../components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useI18n } from '../i18n';
import { formatAgo, formatNumber, formatTokens } from '../lib/format';
import { cn } from '../lib/utils';
import {
  fileEstimate,
  getStartingContext,
  homeStarts,
  RECENT_DAYS,
  startGrew,
  startParts,
  STARTING_CONTEXT_DAYS,
  type FileEstimate,
  type HomeStart,
} from '../services/startingContext';
import type { SetupMachine, StartingContext } from '../native/types';
import { FixMenu } from '../components/FixMenu';
import { startingContextProblem } from '../services/fixPrompt';
import { MachinePill, ModelName } from '../components/identity/Identity';
import { MetaLine } from '../components/MetaLine';

const DAY_MS = 86_400_000;
const CHANGE_SHOWN_TOKENS = 1_000;

/** The last part of a repository's path, which is how it's known. */
const repoName = (repo: string) => repo.split('/').filter(Boolean).pop() ?? repo;

/**
 * Sync › Cost's starting context: how big each session's first request was, by the machine and agent home it started
 * from, beside what that home's own files add to it. Every session pays its start again, so a home that loads more
 * than it needs shows here. Cost titles it and says what it counts, over `STARTING_CONTEXT_DAYS`.
 */
export function SetupContext({ machines, machine = null, homeLabel }: {
  machines: SetupMachine[];
  /** The machine the breadcrumb narrowed Cost to; null for every machine. */
  machine?: string | null;
  homeLabel: (key: string) => string;
}) {
  const { t, tRich } = useI18n();
  const [data, setData] = useState<StartingContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(() => {
    const now = Date.now();
    setNowMs(now);
    getStartingContext(now - STARTING_CONTEXT_DAYS * DAY_MS, now + 60_000)
      .then((next) => { setData(next); setError(null); })
      .catch((failure) => setError(String(failure)));
  }, []);
  useEffect(() => {
    load();
    let unlisten: (() => void) | null = null;
    let live = true;
    // A transcript scan is what says which home a session started from.
    void listen('session-transcripts-updated', load).then((stop) => { if (live) unlisten = stop; else stop(); });
    return () => { live = false; unlisten?.(); };
  }, [load]);

  const homes = useMemo(
    () => (data ? homeStarts(data, nowMs).filter((start) => !machine || start.machine === machine) : []),
    [data, nowMs, machine],
  );
  const grown = homes.filter(startGrew);
  // Sessions that couldn't be placed belong to no machine, so their count only reads true for every machine.
  const unplaced = machine ? 0 : data?.unplaced ?? 0;
  const toggle = (key: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  if (data === null) {
    return error ? (
      <Alert variant="error" icon={<TriangleAlert />}>
        <AlertDescription>{t('setup.context.loadFailed', { error })}</AlertDescription>
      </Alert>
    ) : (
      <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Spinner />{t('setup.context.loading')}</p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {!homes.length ? (
        <Empty>
          <EmptyMedia><Gauge /></EmptyMedia>
          <EmptyTitle>{t('setup.context.empty.title')}</EmptyTitle>
          <EmptyDescription>
            {unplaced
              ? t(unplaced === 1 ? 'setup.context.empty.unplaced.one' : 'setup.context.empty.unplaced.other', { count: unplaced })
              : t('setup.context.empty.description', { days: STARTING_CONTEXT_DAYS })}
          </EmptyDescription>
        </Empty>
      ) : (
        <>
          {grown.length ? (
            <Alert variant="warning" icon={<TriangleAlert />}>
              <AlertDescription>
                {/* One run of text: the description stacks its children, which would put the pill on a line of its own. */}
                <span>
                  {grown.length === 1 && grown[0]
                    ? tRich('setup.context.grewOne', {
                      home: homeLabel(`${grown[0].agent}:${grown[0].home}`),
                      machine: <MachinePill name={grown[0].machine} />,
                      change: formatTokens(grown[0].change ?? 0),
                      days: RECENT_DAYS,
                    })
                    : t('setup.context.grewMany', { count: grown.length, days: RECENT_DAYS })}
                </span>
              </AlertDescription>
            </Alert>
          ) : null}
          <TableCard
            title={t('setup.context.table.title')}
            count={t(homes.length === 1 ? 'setup.context.table.count.one' : 'setup.context.table.count.other', { count: homes.length })}
          >
            <Table containerClassName="overflow-auto">
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-64">{t('setup.context.column.home')}</TableHead>
                  <TableHead className="w-24 text-end">{t('setup.context.column.sessions')}</TableHead>
                  <TableHead className="w-28 text-end">{t('setup.context.column.typical')}</TableHead>
                  <TableHead className="w-28 text-end">{t('setup.context.column.heaviest')}</TableHead>
                  <TableHead className="w-36 text-end">{t('setup.context.column.week', { days: RECENT_DAYS })}</TableHead>
                  <TableHead className="w-32 text-end">{t('setup.context.column.files')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {homes.map((start) => {
                  const key = `${start.machine}\u0000${start.agent}:${start.home}`;
                  const estimate = fileEstimate(machines.find((machine) => machine.machine === start.machine), start.agent, start.home);
                  const expanded = open.has(key);
                  return (
                    <Fragment key={key}>
                      <HomeRow start={start} estimate={estimate} label={homeLabel(`${start.agent}:${start.home}`)} open={expanded} onToggle={() => toggle(key)} />
                      {expanded ? (
                        <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
                          <TableCell colSpan={6} className="bg-muted/24 p-0 dark:bg-input/8">
                            <HomeDetail start={start} estimate={estimate} nowMs={nowMs} />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </TableCard>
          <p className="max-w-3xl text-xs text-muted-foreground">
            {t('setup.context.note')}
            {unplaced ? ` ${t(unplaced === 1 ? 'setup.context.unplaced.one' : 'setup.context.unplaced.other', { count: unplaced })}` : ''}
            {data.truncated ? ` ${t('setup.context.truncated')}` : ''}
          </p>
        </>
      )}
    </div>
  );
}

function HomeRow({ start, estimate, label, open, onToggle }: {
  start: HomeStart;
  estimate: FileEstimate | null;
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const grew = startGrew(start);
  return (
    <TableRow className="cursor-pointer" onClick={onToggle}>
      <TableCell className="max-w-80">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            className="-ms-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-2"
            aria-expanded={open}
            aria-label={t(open ? 'setup.context.row.collapse' : 'setup.context.row.expand', { home: label, machine: start.machine })}
            onClick={(event) => { event.stopPropagation(); onToggle(); }}
          >
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          </button>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">{label}</span>
              {grew ? <Badge variant="warning" size="sm">{t('setup.context.row.grew')}</Badge> : null}
              {grew ? (
                // The row opens on a click; the menu's own clicks stay with the menu.
                <span onClick={(event) => event.stopPropagation()}>
                  <FixMenu
                    compact
                    machine={start.machine}
                    problem={startingContextProblem({ agent: start.agent, home: start.home, median: formatTokens(start.median), change: formatTokens(start.change ?? 0), days: RECENT_DAYS }, t)}
                  />
                </span>
              ) : null}
            </span>
            <MetaLine parts={[<MachinePill key="machine" name={start.machine} size="sm" />, <span key="home" className="min-w-0 truncate font-mono">{start.home}</span>]} title={start.home} />
          </div>
        </div>
      </TableCell>
      <TableCell className={TABLE_NUMERIC_CLASS}>{formatNumber(start.sessions)}</TableCell>
      <TableCell className={cn(TABLE_NUMERIC_CLASS, 'font-medium text-foreground')}>{formatTokens(start.median)}</TableCell>
      <TableCell className={TABLE_NUMERIC_CLASS}>{formatTokens(start.p90)}</TableCell>
      <TableCell className={TABLE_NUMERIC_CLASS}>
        {start.recent ? (
          <span className="inline-flex items-baseline justify-end gap-1.5">
            {formatTokens(start.recent.median)}
            {/* A few hundred tokens either way is a longer first message, not a change in what loads. */}
            {start.change !== null && Math.abs(start.change) >= CHANGE_SHOWN_TOKENS ? (
              <span className={cn('text-2xs', grew ? 'text-warning-foreground' : 'text-muted-foreground')}>
                {start.change >= 0 ? '+' : '−'}{formatTokens(Math.abs(start.change))}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground" title={t('setup.context.row.fewRecent')}>—</span>
        )}
      </TableCell>
      <TableCell className={TABLE_NUMERIC_CLASS}>
        {estimate ? (
          <span title={t('setup.context.row.filesHint', { instructions: formatTokens(estimate.instructions), skills: formatTokens(estimate.skills) })}>
            {estimate.total ? t('setup.context.row.about', { tokens: formatTokens(estimate.total) }) : t('setup.context.row.none')}
          </span>
        ) : (
          <span className="text-muted-foreground" title={t('setup.context.row.notScanned')}>—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

function HomeDetail({ start, estimate, nowMs }: { start: HomeStart; estimate: FileEstimate | null; nowMs: number }) {
  const { t } = useI18n();
  const parts = startParts(start.median, estimate);
  const share = (tokens: number) => `${Math.max(0, (tokens / start.median) * 100)}%`;
  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-foreground">{t('setup.context.detail.parts', { tokens: formatTokens(start.median) })}</h3>
        {parts ? (
          <>
            <div className="flex h-2 w-full max-w-2xl overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div className="h-full bg-primary" style={{ width: share(parts.instructions) }} />
              <div className="h-full bg-info" style={{ width: share(parts.skills) }} />
            </div>
            <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
              <li className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-primary" aria-hidden="true" />{t('setup.context.detail.instructions', { tokens: formatTokens(parts.instructions) })}</li>
              <li className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-info" aria-hidden="true" />{t('setup.context.detail.skills', { tokens: formatTokens(parts.skills) })}</li>
              <li className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-muted-foreground/40" aria-hidden="true" />{t('setup.context.detail.rest', { tokens: formatTokens(parts.rest) })}</li>
            </ul>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{t('setup.context.detail.noFiles')}</p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-foreground">{t('setup.context.detail.projects')}</h3>
          {start.projects.length ? (
            <ul className="flex flex-col gap-1 text-xs">
              {start.projects.map((project) => (
                <li key={project.repo} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={project.repo}>{repoName(project.repo)}</span>
                  <span className="text-muted-foreground">
                    {t(project.sessions === 1 ? 'setup.context.detail.projectSessions.one' : 'setup.context.detail.projectSessions.other', { count: project.sessions })}
                  </span>
                  <span className="w-14 text-right tabular-nums text-foreground">{formatTokens(project.median)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t('setup.context.detail.noProjects')}</p>
          )}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">{t('setup.context.detail.latest')}</dt>
          <dd className="tabular-nums text-foreground">
            {t('setup.context.detail.latestValue', { tokens: formatTokens(start.latest.tokens), time: formatAgo(start.latest.atMs, nowMs) })}
          </dd>
          <dt className="text-muted-foreground">{t('setup.context.detail.earlier')}</dt>
          <dd className="tabular-nums text-foreground">
            {start.earlier ? formatTokens(start.earlier.median) : t('setup.context.detail.tooFew')}
          </dd>
          <dt className="text-muted-foreground">{t('setup.context.detail.models')}</dt>
          <dd className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">{start.models.map((model) => <ModelName key={model} model={model} className="font-normal" />)}</dd>
        </dl>
      </div>
    </div>
  );
}

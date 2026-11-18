import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { formatMoney, formatNumber } from '../../lib/format';
import { cn } from '../../lib/utils';
import type { ComputeProviderId, ComputeProviderSnapshot, ComputeSandbox } from '../../native/types';
import {
  COMPUTE_GROUPINGS,
  cpuTone,
  formatHours,
  formatSandboxAge,
  formatStopsIn,
  isActiveSandbox,
  loadUnreadLabel,
  memoryTone,
  percentOf,
  sandboxCpu,
  sandboxMemory,
  stopsSoon,
  type ComputeGrouping,
} from '../../services/compute';
import { computeProviderName } from '../../services/computeHint';
import {
  COMPUTE_PAGE_SIZE,
  flagCounts,
  groupRowCount,
  narrowProviders,
  pageOfGroups,
  stoppedSandboxes,
  tableGroups,
  type FlagCounts,
  type TableFilter,
  type TableGroup,
} from '../../services/computePage';
import { MachinePill } from '../identity/Identity';
import { SectionAbout } from '../layout/settings';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { TableCard, TableEmpty, TablePager, TABLE_NUMERIC_CLASS } from '../ui/data-table';
import { ChevronRight, X } from '../ui/icons';
import { Meter } from '../ui/meter';
import { StatusDot } from '../ui/status-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Toggle, ToggleGroup } from '../ui/toggle-group';
import { ComputeProviderMark } from './ComputeProviderMark';
import { CpuSparkline, SandboxDot, SandboxFlags, StartedByLine } from './parts';

type Open = (provider: ComputeProviderId, sandboxId: string) => void;

/**
 * The grouping the table was last left on, for as long as the window lives, so coming back to Compute finds the list
 * the way it was. A view that names a grouping (a machine's page asks for by machine) opens that one instead.
 */
let lastGrouping: ComputeGrouping = 'provider';

/** The grouping a table opens with: the one its view names, which it's then left on, else the one it was left on. */
export function openingGrouping(asked: ComputeGrouping | undefined): ComputeGrouping {
  if (asked) lastGrouping = asked;
  return lastGrouping;
}

/** Forgets the grouping the table was left on; for tests. */
export const resetSandboxTableGrouping = () => { lastGrouping = 'provider'; };

/** A reading as the table writes it: the percent large, its sign small. */
function Percent({ value, tone }: { value: number | null; tone: string }) {
  return (
    <span className={cn('text-sm font-medium tabular-nums', tone === 'error' ? 'text-destructive-foreground' : tone === 'warning' ? 'text-warning-foreground' : 'text-foreground')}>
      {value ?? '—'}<span className="ms-0.5 text-2xs font-normal text-muted-foreground">%</span>
    </span>
  );
}

/** CPU and memory, or in their place why there's no reading: not read yet, monitoring off, or a key that can't read it. */
function LoadCells({ sandbox }: { sandbox: ComputeSandbox }) {
  const { t } = useI18n();
  if (!isActiveSandbox(sandbox)) return <TableCell colSpan={2} className="text-muted-foreground">—</TableCell>;
  if (sandbox.load.kind !== 'read') {
    const unread = loadUnreadLabel(sandbox);
    return <TableCell colSpan={2} className="text-xs text-muted-foreground">{unread ? t(unread) : '—'}</TableCell>;
  }
  const cpu = cpuTone(sandbox);
  const memory = memoryTone(sandbox);
  return (
    <>
      <TableCell>
        <span className="flex items-center gap-3">
          <CpuSparkline points={sandbox.points} tone={cpu} />
          <span className="flex w-16 flex-col gap-1">
            <Percent value={percentOf(sandboxCpu(sandbox))} tone={cpu} />
            <Meter value={percentOf(sandboxCpu(sandbox))} tone={cpu} animated={false} className="h-1" />
          </span>
        </span>
      </TableCell>
      <TableCell>
        <span className="flex w-16 flex-col gap-1">
          <Percent value={percentOf(sandboxMemory(sandbox))} tone={memory} />
          <Meter value={percentOf(sandboxMemory(sandbox))} tone={memory} animated={false} className="h-1" />
        </span>
      </TableCell>
    </>
  );
}

/**
 * One sandbox. Memoized on the sandbox itself (the store keeps an unchanged one's object) and the minute, so a round
 * that read one sandbox draws one row again; it has no clock of its own.
 */
const SandboxRow = memo(function SandboxRow({ sandbox, provider, nowMs, dollars, onOpen }: {
  sandbox: ComputeSandbox;
  provider: ComputeProviderId;
  nowMs: number;
  dollars: boolean;
  onOpen: Open;
}) {
  const { t } = useI18n();
  const active = isActiveSandbox(sandbox);
  const stopsIn = formatStopsIn(sandbox, nowMs);
  const stopWarns = active && ((stopsIn === null && sandbox.forgotten !== null) || stopsSoon(sandbox, nowMs));
  return (
    <TableRow className={cn('cursor-pointer', !active && 'text-muted-foreground')} onClick={() => onOpen(provider, sandbox.id)} data-sandbox={sandbox.id}>
      {/* Wide enough for a name and its flags, so a narrow window scrolls the table sideways instead of crushing them. */}
      <TableCell className="w-full min-w-72 max-w-0 whitespace-normal">
        <span className="flex min-w-0 items-start gap-3">
          <span className="mt-1.5 flex"><SandboxDot sandbox={sandbox} /></span>
          <span className="flex min-w-0 flex-col gap-1">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <button type="button" className="truncate text-start font-medium text-foreground outline-none focus-visible:underline" aria-label={t('compute.page.openSandbox', { name: sandbox.name })}>
                {sandbox.name}
              </button>
              <Badge variant="outline" size="sm">{sandbox.size}</Badge>
              <SandboxFlags sandbox={sandbox} size="sm" />
            </span>
            <StartedByLine sandbox={sandbox} nowMs={nowMs} />
          </span>
        </span>
      </TableCell>
      <LoadCells sandbox={sandbox} />
      <TableCell className={TABLE_NUMERIC_CLASS}>{formatSandboxAge(sandbox, nowMs)}</TableCell>
      <TableCell className={cn(TABLE_NUMERIC_CLASS, stopWarns && 'text-warning-foreground')}>
        {!active ? t('compute.state.stopped') : stopsIn ?? t('compute.noAutoStop')}
      </TableCell>
      <TableCell className={TABLE_NUMERIC_CLASS}>{sandbox.monthHours === null ? '—' : t('compute.hours', { hours: formatHours(sandbox.monthHours) })}</TableCell>
      {dollars ? <TableCell className={TABLE_NUMERIC_CLASS}>{sandbox.monthDollars === null ? '—' : formatMoney(sandbox.monthDollars)}</TableCell> : null}
      <TableCell className="w-8 text-muted-foreground"><ChevronRight className="size-4" aria-hidden="true" /></TableCell>
    </TableRow>
  );
});

/** A group's heading row: the provider, machine or size, and what its running sandboxes add up to. */
function GroupHeading({ group, columns }: {
  /** The whole group, even when a page shows only some of its rows. */
  group: TableGroup;
  columns: number;
}) {
  const { t } = useI18n();
  const totals = (() => {
    switch (group.kind) {
      case 'provider':
        return t('compute.page.group.provider', { running: group.sandboxes.length, vcpus: group.vcpus, memory: formatNumber(group.memoryGb) });
      case 'machine': {
        const count = group.sandboxes.length;
        return t('compute.page.group.machine', { sandboxes: t(count === 1 ? 'compute.sandboxes.one' : 'compute.sandboxes.other', { count }), vcpus: group.vcpus });
      }
      case 'size':
        return group.size.multiplier === null
          ? t('compute.page.group.size', { vcpus: group.size.vcpus, memory: formatNumber(group.size.memoryGb) })
          : t('compute.page.group.sizeHours', { vcpus: group.size.vcpus, memory: formatNumber(group.size.memoryGb), multiplier: formatNumber(group.size.multiplier, 1) });
      case 'stopped':
        return null;
    }
  })();
  const name = (() => {
    switch (group.kind) {
      case 'provider':
        return <span className="flex items-center gap-2"><ComputeProviderMark provider={group.provider.id} />{computeProviderName(group.provider.id)}</span>;
      case 'machine':
        return group.origin.kind === 'machine'
          ? <MachinePill name={group.origin.machine} size="sm" />
          : <span>{t(group.origin.kind === 'teammate' ? 'compute.aTeammate' : 'compute.notLinked')}</span>;
      case 'size':
        return <span>{group.size.size}</span>;
      case 'stopped':
        return <span>{t('compute.page.group.stopped')}</span>;
    }
  })();
  return (
    <TableRow className="bg-muted/40 hover:bg-muted/40 dark:hover:bg-muted/40">
      <TableCell colSpan={columns} className="h-9 py-1.5">
        <span className="flex items-center justify-between gap-4 text-xs">
          <span className="font-medium text-foreground">{name}</span>
          {totals ? <span className="tabular-nums text-muted-foreground">{totals}</span> : null}
        </span>
      </TableCell>
    </TableRow>
  );
}

/**
 * Fleet › Compute's table: every running sandbox in groups (by provider, by what started it, or by size), with the
 * stopped ones this month behind a disclosure. Past fifty rows it pages. A row opens the sandbox's own page. The counts
 * in its head narrow it to the sandboxes they count, and a machine's page opens it narrowed to what that machine started.
 */
export function SandboxTable({ providers: every, grouping: asked, machine, nowMs, dollars, stale, onOpen }: {
  providers: readonly ComputeProviderSnapshot[];
  /** The grouping the view asks for. The page keys the table on it, so a new one opens the list that way. */
  grouping?: ComputeGrouping;
  /** The machine the view asks for: the table opens showing only the sandboxes it started. */
  machine?: string;
  nowMs: number;
  dollars: boolean;
  /** The figures are an earlier read's: they show dimmed. */
  stale: boolean;
  onOpen: Open;
}) {
  const { t } = useI18n();
  const [grouping, setGrouping] = useState<ComputeGrouping>(() => openingGrouping(asked));
  const [picked, setPicked] = useState<TableFilter | null>(() => (machine ? { kind: 'machine', machine } : null));
  const [showStopped, setShowStopped] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(COMPUTE_PAGE_SIZE);
  // The page passes a new function each render; the rows keep one, so a memoized row isn't drawn again for it.
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const open = useCallback<Open>((provider, sandboxId) => openRef.current(provider, sandboxId), []);

  const { providers, filter } = useMemo(() => narrowProviders(every, picked), [every, picked]);
  // A filter that stopped matching is forgotten, so it doesn't come back by itself when something matches again.
  useEffect(() => { if (picked && !filter) setPicked(null); }, [picked, filter]);
  const pick = (next: TableFilter | null) => { setPicked(next); setPage(1); };
  const groups = useMemo(() => tableGroups(providers, grouping, showStopped), [providers, grouping, showStopped]);
  const stopped = useMemo(() => stoppedSandboxes(providers).length, [providers]);
  const counts = useMemo(() => flagCounts(every.flatMap((provider) => provider.sandboxes)), [every]);
  // The groups carry copies with their provider; each row gets the store's own object, so its memo holds.
  const originals = useMemo(() => new Map<string, ComputeSandbox>(every.flatMap((provider) => provider.sandboxes.map((sandbox) => [`${provider.id}/${sandbox.id}`, sandbox] as const))), [every]);
  const wholeGroups = useMemo(() => new Map(groups.map((group) => [group.key, group])), [groups]);
  const total = groupRowCount(groups);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pages);
  const shown = total > pageSize ? pageOfGroups(groups, current, pageSize) : groups;
  const columns = dollars ? 8 : 7;
  const running = total - (showStopped ? stopped : 0);

  const chips = (['cpuAtLimit', 'forgotten', 'degraded'] as const satisfies readonly (keyof FlagCounts)[])
    .filter((flag) => counts[flag])
    .map((flag) => ({ flag, on: filter?.kind === 'flag' && filter.flag === flag, text: t(`compute.page.count.${flag}`, { count: counts[flag] }) }));
  const chipClass = 'cursor-pointer gap-1.5 outline-none ring-ring focus-visible:ring-2';
  // The machine's chip goes when it's cleared, so the keyboard lands on the next control in the head, not nowhere.
  const toolbarRef = useRef<HTMLSpanElement>(null);
  const clearMachine = () => { pick(null); toolbarRef.current?.querySelector('button')?.focus(); };

  const footer = stopped || total > pageSize ? (
    <>
      {stopped ? (
        <span className="me-auto flex items-center gap-2 text-xs text-muted-foreground">
          {t(stopped === 1 ? 'compute.page.stopped.one' : 'compute.page.stopped.other', { count: stopped })}
          <Button variant="ghost-muted" size="sm" aria-expanded={showStopped} onClick={() => { setShowStopped((value) => !value); setPage(1); }}>
            {showStopped ? t('compute.page.hideStopped') : t('compute.page.showStopped', { count: stopped })}
          </Button>
        </span>
      ) : null}
      {total > pageSize ? (
        <TablePager
          first={(current - 1) * pageSize + 1}
          last={Math.min(total, current * pageSize)}
          total={total}
          page={current}
          totalPages={pages}
          pageSize={pageSize}
          onPage={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        />
      ) : null}
    </>
  ) : null;

  return (
    <TableCard
      title={<span className="flex items-center gap-1.5">{t('compute.page.sandboxes.title')}<SectionAbout title={t('compute.page.sandboxes.title')} description={t('compute.page.sandboxes.about')} /></span>}
      count={t(running === 1 ? 'compute.running.one' : 'compute.running.other', { count: running })}
      nav={chips.length || filter ? (
        <span className="flex flex-wrap items-center gap-1.5">
          {filter?.kind === 'machine' ? (
            <Badge variant="outline" className={cn(chipClass, 'ring-1')} render={<button type="button" aria-pressed title={t('compute.page.filter.clear')} onClick={clearMachine} />}>
              {t('compute.page.filter.machine', { machine: filter.machine })}<X aria-hidden="true" />
            </Badge>
          ) : null}
          {chips.map((chip) => (
            <Badge
              key={chip.flag}
              variant="outline"
              className={cn(chipClass, filter && !chip.on && 'opacity-45', chip.on && 'ring-1')}
              render={<button type="button" aria-pressed={chip.on} title={t(chip.on ? 'compute.page.filter.clear' : 'compute.page.filter.only')} onClick={() => pick(chip.on ? null : { kind: 'flag', flag: chip.flag })} />}
            >
              <StatusDot tone="warning" className="size-1.5" />{chip.text}
            </Badge>
          ))}
        </span>
      ) : null}
      toolbar={(
        <span ref={toolbarRef} className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('compute.grouping.label')}</span>
          <ToggleGroup
            value={[grouping]}
            onValueChange={(next) => { const value = next[0] as ComputeGrouping | undefined; if (value) { lastGrouping = value; setGrouping(value); setPage(1); } }}
            aria-label={t('compute.grouping.label')}
          >
            {COMPUTE_GROUPINGS.map((option) => <Toggle key={option} value={option}>{t(`compute.grouping.${option}`)}</Toggle>)}
          </ToggleGroup>
        </span>
      )}
      footer={footer}
      className={cn(stale && '[&_tbody]:opacity-60')}
    >
      {total ? (
        <Table aria-label={t('compute.page.sandboxes.title')}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('compute.page.column.sandbox')}</TableHead>
              <TableHead>{t('compute.page.column.cpu')}</TableHead>
              <TableHead>{t('compute.page.column.memory')}</TableHead>
              <TableHead className={TABLE_NUMERIC_CLASS}>{t('compute.page.column.age')}</TableHead>
              <TableHead className={TABLE_NUMERIC_CLASS}>{t('compute.page.column.stopsIn')}</TableHead>
              <TableHead className={TABLE_NUMERIC_CLASS}>{t('compute.page.column.monthHours')}</TableHead>
              {dollars ? <TableHead className={TABLE_NUMERIC_CLASS}>{t('compute.page.column.monthDollars')}</TableHead> : null}
              <TableHead className="w-8"><span className="sr-only">{t('compute.sandbox.open')}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((group) => [
              <GroupHeading key={`group:${group.key}`} group={wholeGroups.get(group.key) ?? group} columns={columns} />,
              ...group.sandboxes.map((sandbox) => {
                const key = `${sandbox.provider}/${sandbox.id}`;
                return <SandboxRow key={key} sandbox={originals.get(key) ?? sandbox} provider={sandbox.provider} nowMs={nowMs} dollars={dollars} onOpen={open} />;
              }),
            ])}
          </TableBody>
        </Table>
      ) : (
        <TableEmpty>
          <span className="flex flex-col gap-1">
            <span className="font-medium text-foreground">{t('compute.page.empty.title')}</span>
            {t('compute.page.empty.description', { providers: providers.map((provider) => computeProviderName(provider.id)).join(', ') })}
          </span>
        </TableEmpty>
      )}
    </TableCard>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { formatDuration, formatTime } from '../../lib/format';
import type { ComputePoint, ComputeProviderId, ComputeSandbox } from '../../native/types';
import { loadUnreadLabel, percentOf, readComputeHistory, sandboxCpu, sandboxMemory } from '../../services/compute';
import { loadSeries, mergeHistory } from '../../services/computePage';
import { TimeSeries } from '../charts/TimeSeries';
import { Button } from '../ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

/** The chart covers at least ten minutes, so a sandbox read three times doesn't stretch three points edge to edge. */
const MIN_WINDOW_MS = 10 * 60_000;
/** And at most the ring Rust keeps: two hours. */
const MAX_WINDOW_MS = 120 * 60_000;
const HEIGHT = 160;

/**
 * A sandbox's readings: the ring Rust holds, read once when the page opens, with each round's newest readings (from
 * the snapshot the store already follows) added as they come. Nothing polls here.
 */
export function useSandboxHistory(provider: ComputeProviderId, sandbox: ComputeSandbox): ComputePoint[] {
  const key = `${provider}/${sandbox.id}`;
  const [ring, setRing] = useState<SandboxRing>(NO_RING);
  useEffect(() => {
    let live = true;
    readComputeHistory(provider, sandbox.id)
      .then((points) => { if (live) setRing({ key: `${provider}/${sandbox.id}`, points }); })
      // The chart still fills from the snapshot's latest readings.
      .catch(() => undefined);
    return () => { live = false; };
  }, [provider, sandbox.id]);
  const points = ringFor(ring, key);
  return useMemo(() => mergeHistory(points, sandbox.points), [points, sandbox.points]);
}

/** The ring read for one sandbox, by its provider and id. */
export type SandboxRing = { key: string; points: ComputePoint[] };
const NO_POINTS: ComputePoint[] = [];
const NO_RING: SandboxRing = { key: '', points: NO_POINTS };

/**
 * The ring's readings if they're this sandbox's, else none: a ring read for the sandbox shown before, kept while this
 * one's read is on its way or after it failed, is never drawn under this one's name.
 */
export const ringFor = (ring: SandboxRing, key: string): ComputePoint[] => (ring.key === key ? ring.points : NO_POINTS);

/**
 * CPU and memory on one 0–100% axis, a minute apart, for as long as Arbor has read them. Gaps where nothing was read
 * are drawn as gaps and named, the pointer shows both readings at a time, and the readings are also a table.
 */
export function LoadChart({ sandbox, points }: { sandbox: ComputeSandbox; points: ComputePoint[] }) {
  const { t } = useI18n();
  const [table, setTable] = useState(false);
  const { cpu, memory, gaps } = useMemo(() => loadSeries(points), [points]);
  const first = points[0];
  const last = points[points.length - 1];
  // From the first reading to a minute past the last, so the newest sits just inside the right edge.
  const windowMs = first && last ? Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, last.atMs - first.atMs + 60_000)) : MIN_WINDOW_MS;
  const gapLabel = t('compute.sandbox.load.gap');
  const bands = useMemo(() => gaps.map((gap) => ({ ...gap, label: gapLabel })), [gaps, gapLabel]);
  const series = useMemo(() => [cpu, memory], [cpu, memory]);

  if (!last) {
    const unread = loadUnreadLabel(sandbox);
    const why = unread && sandbox.load.kind !== 'notReadYet' ? t(unread) : t('compute.sandbox.load.empty');
    return <p className="px-4 py-6 text-center text-sm text-muted-foreground">{why}</p>;
  }

  const cpuNow = percentOf(sandboxCpu(sandbox)) ?? Math.round(last.cpu * 100);
  const memoryNow = percentOf(sandboxMemory(sandbox)) ?? Math.round(last.memory * 100);
  const labels = [t('compute.sandbox.cpu'), t('compute.sandbox.memory')];
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-chart-1" aria-hidden="true" />{labels[0]}<span className="font-medium tabular-nums text-foreground">{cpuNow}%</span></span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-chart-5" aria-hidden="true" />{labels[1]}<span className="font-medium tabular-nums text-foreground">{memoryNow}%</span></span>
        <Button variant="ghost-muted" size="xs" className="ms-auto" aria-expanded={table} onClick={() => setTable((shown) => !shown)}>
          {table ? t('compute.sandbox.load.hideTable') : t('compute.sandbox.load.showTable')}
        </Button>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-2">
        <div className="relative w-9 text-right text-2xs tabular-nums text-muted-foreground" style={{ height: HEIGHT }} aria-hidden="true">
          <span className="absolute right-0 top-0 -translate-y-1/2">100%</span>
          <span className="absolute right-0 top-1/2 -translate-y-1/2">50%</span>
          <span className="absolute bottom-0 right-0 translate-y-1/2">0%</span>
        </div>
        <div style={{ height: HEIGHT }}>
          <TimeSeries
            id={`compute-load-${sandbox.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`}
            series={series}
            windowMs={windowMs}
            max={100}
            height={HEIGHT}
            fill={false}
            guides={[0, 50, 100]}
            strokeClass={['text-chart-1', 'text-chart-5']}
            labels={labels}
            formatTime={(at) => formatTime(at)}
            ariaLabel={t('compute.sandbox.load.chart', { name: sandbox.name })}
            bands={bands}
          />
        </div>
        <span />
        <div className="flex justify-between pt-1.5 text-2xs text-muted-foreground" aria-hidden="true">
          {/* The full window is a whole number of hours: "2h ago", not "2h 0m ago". */}
          <span>{t('compute.sandbox.load.ago', { span: windowMs % 3_600_000 === 0 ? t('format.span.hours', { hours: windowMs / 3_600_000 }) : formatDuration(windowMs) })}</span>
          <span>{t('compute.sandbox.load.now')}</span>
        </div>
      </div>
      {table ? (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-border/60">
          <Table density="compact" stickyHeader aria-label={t('compute.sandbox.load.chart', { name: sandbox.name })}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('compute.sandbox.load.time')}</TableHead>
                <TableHead className="text-end">{labels[0]}</TableHead>
                <TableHead className="text-end">{labels[1]}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...points].reverse().map((point) => (
                <TableRow key={point.atMs}>
                  <TableCell className="tabular-nums">{formatTime(point.atMs)}</TableCell>
                  <TableCell className="text-end tabular-nums">{Math.round(point.cpu * 100)}%</TableCell>
                  <TableCell className="text-end tabular-nums">{Math.round(point.memory * 100)}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}

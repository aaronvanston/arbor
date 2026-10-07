import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ArrowDown, ArrowUp, ChevronRight, Cpu, Gpu, HardDrive, MemoryStick, Network, Radar, Settings2, Thermometer, TriangleAlert, Unplug } from '../components/ui/icons';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import {
  fetchMachineHealth,
  formatBytes,
  formatLatency,
  formatRate,
  HEALTH_WINDOWS,
  KIB,
  latencyDigits,
  latencyStats,
  mergeSnapshots,
  READING_LIMITS,
  type HealthWindowId,
} from '../services/machineHealth';
import { useLatestAgentVersions } from '../services/agentReleases';
import { newestAgents, type NewestAgents } from '../services/agentVersions';
import { healthReasonText } from '../services/homeOverview';
import { machineIdentity, osLabel } from '../services/machineIdentity';
import { unreachableReason } from '../services/machineAlerts';
import { errorWords, plainError } from '../services/plainError';
import { SettingsBlock, SettingsSection } from '../components/layout/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { FirstMachineActions } from '../components/FirstMachineActions';
import { Skeleton } from '../components/ui/skeleton';
import { StatusDot, StatusPill, type StatusTone } from '../components/ui/status-dot';
import { Toggle, ToggleGroup } from '../components/ui/toggle-group';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { formatAgo, formatDuration, formatTime } from '../lib/format';
import { cn } from '../lib/utils';
import { useAnimatedNumber } from '../hooks/useAnimatedNumber';
import { MachinePill } from '../components/identity/Identity';
import { MachineAgentSummary } from './MachineAgents';
import type { HealthPoint, HealthStatus, MachineHealth, MachineHealthSnapshot } from '../native/types';
import { machineName } from '../services/machineNames';

type Translate = ReturnType<typeof useI18n>['t'];

export const STATUS_TONE: Record<HealthStatus, StatusTone> = {
  healthy: 'success',
  degraded: 'warning',
  critical: 'error',
  unreachable: 'error',
  pending: 'muted',
  unconfigured: 'muted',
};

const TONE_TEXT: Record<StatusTone, string> = {
  success: 'text-success-foreground',
  warning: 'text-warning-foreground',
  error: 'text-error-foreground',
  info: 'text-info-foreground',
  muted: 'text-muted-foreground',
  primary: 'text-primary',
};

const TONE_STROKE: Record<StatusTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-error',
  info: 'text-info',
  muted: 'text-muted-foreground/60',
  primary: 'text-primary',
};

/** Pressure tone for a single reading. Thresholds match the backend score ramps. */
const toneFor = (value: number | null, warn: number, critical: number): StatusTone =>
  value === null ? 'muted' : value >= critical ? 'error' : value >= warn ? 'warning' : 'primary';

function TweenNumber({ value, digits = 0, className }: { value: number | null; digits?: number; className?: string }) {
  const shown = useAnimatedNumber(value);
  return <span className={className}>{shown === null ? '—' : shown.toFixed(digits)}</span>;
}

type Series = { t: number; v: number | null }[];

const CHART_W = 300;
const CHART_PAD = 2;

/** How far a chart's lines are scrolled at `t`, as a share of its width: "now" sits at the right edge. */
const scrollAt = (t: number, anchor: number, windowMs: number) => `translateX(${(1 - (t - anchor) / windowMs) * 100}%)`;

/** A day: one scroll animation outlasts any window left open, and starts again if the window changes. */
const SCROLL_SPAN_MS = 86_400_000;

/**
 * Scrolls a chart's lines left on the compositor. A transform animated on an HTML layer moves pixels already drawn;
 * the same transition on an SVG group repaints the whole chart every frame, which kept an idle machine page near a
 * quarter of a core in WebContent and as much again in the GPU process. Nothing renders between readings.
 */
function useChartScroll(anchor: number, windowMs: number) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof element.animate !== 'function') return;
    const now = Date.now();
    const animation = element.animate(
      [{ transform: scrollAt(now, anchor, windowMs) }, { transform: scrollAt(now + SCROLL_SPAN_MS, anchor, windowMs) }],
      { duration: SCROLL_SPAN_MS, easing: 'linear', fill: 'forwards' },
    );
    return () => animation.cancel();
  }, [anchor, windowMs]);
  return ref;
}

/**
 * A sparkline drawn in absolute time coordinates. The plotted lines sit in a layer
 * scrolled so "now" stays at the right edge (useChartScroll), so the line moves
 * left continuously instead of snapping whenever a poll lands. Null readings
 * break the line rather than reading as zero.
 */
type HoverPoint = { t: number; values: (number | null)[] };

/** Nearest sample to a chart time, within `tolerance` ms; null when the window is empty or the pointer is off the trace. */
export function nearestSample(series: Series[], t: number, tolerance: number): HoverPoint | null {
  const base = series[0] ?? [];
  let best: { t: number; distance: number } | null = null;
  for (const point of base) {
    if (point.v === null) continue;
    const distance = Math.abs(point.t - t);
    if (distance <= tolerance && (!best || distance < best.distance)) best = { t: point.t, distance };
  }
  if (!best) return null;
  const at = best.t;
  return { t: at, values: series.map((points) => points.find((point) => point.t === at)?.v ?? null) };
}

function TimeSeries({
  series,
  windowMs,
  max,
  height = 40,
  strokeClass,
  fill = true,
  guides = [],
  id,
  ariaLabel,
  format = (value) => `${Math.round(value)}%`,
  labels,
  formatTime,
}: {
  series: Series[];
  windowMs: number;
  max: number;
  height?: number;
  strokeClass: string[];
  fill?: boolean;
  guides?: number[];
  id: string;
  ariaLabel: string;
  /** Formats a hovered value for the floating readout. */
  format?: (value: number) => string;
  /** Per-series names for the readout when more than one trace is drawn. */
  labels?: string[];
  formatTime?: (t: number) => string;
}) {
  const [anchor] = useState(() => Date.now());
  const scrollRef = useChartScroll(anchor, windowMs);
  const pad = CHART_PAD;
  const usable = height - pad * 2;
  const x = (t: number) => ((t - anchor) / windowMs) * CHART_W;
  const y = (v: number) => pad + usable - (Math.max(0, Math.min(max, v)) / max) * usable;
  const [hover, setHover] = useState<HoverPoint | null>(null);
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const sx = ((event.clientX - rect.left) / rect.width) * CHART_W;
    const offset = CHART_W - x(Date.now());
    const t = anchor + ((sx - offset) / CHART_W) * windowMs;
    // Snap to a sample within ~8 chart units so gaps and the far edges do not show stale readings.
    setHover(nearestSample(series, t, (windowMs / CHART_W) * 8));
  };
  const hoverX = hover ? x(hover.t) + CHART_W - x(Date.now()) : 0;
  const hoverLeft = (hoverX / CHART_W) * 100;
  const flip = hoverLeft > 60;
  // The lines are drawn from the anchor, not from now, so they're the same each tick until the readings change.
  const paths = useMemo(() => series.map((points) => {
    const x = (t: number) => ((t - anchor) / windowMs) * CHART_W;
    const y = (v: number) => CHART_PAD + (height - CHART_PAD * 2) - (Math.max(0, Math.min(max, v)) / max) * (height - CHART_PAD * 2);
    let line = '';
    let area = '';
    let open = false;
    let lastX = 0;
    for (const point of points) {
      if (point.v === null) {
        if (open) area += ` L ${lastX.toFixed(1)},${height} Z`;
        open = false;
        continue;
      }
      const px = x(point.t);
      const py = y(point.v);
      if (!open) {
        line += ` M ${px.toFixed(1)},${py.toFixed(1)}`;
        area += ` M ${px.toFixed(1)},${height} L ${px.toFixed(1)},${py.toFixed(1)}`;
        open = true;
      } else {
        line += ` L ${px.toFixed(1)},${py.toFixed(1)}`;
        area += ` L ${px.toFixed(1)},${py.toFixed(1)}`;
      }
      lastX = px;
    }
    if (open) area += ` L ${lastX.toFixed(1)},${height} Z`;
    return { line: line.trim(), area: area.trim() };
  }), [series, anchor, windowMs, max, height]);
  const last = series.map((points) => [...points].reverse().find((point) => point.v !== null) ?? null);
  return (
    <div className="relative h-full w-full" onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)} data-slot="time-series">
    <div className="absolute inset-0 overflow-hidden" role="img" aria-label={ariaLabel}>
    <svg className="absolute inset-0 block h-full w-full" viewBox={`0 0 ${CHART_W} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {guides.map((value) => (
        <line key={value} x1="0" x2={CHART_W} y1={y(value)} y2={y(value)} stroke="var(--border)" strokeDasharray="2,3" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
    <div ref={scrollRef} className="absolute inset-0" style={{ transform: 'translateX(100%)' }}>
      <svg className="block h-full w-full overflow-visible" viewBox={`0 0 ${CHART_W} ${height}`} preserveAspectRatio="none" aria-hidden="true">
          {paths.map((path, index) => (
            <g key={index} className={strokeClass[index]}>
              {fill ? (
                <linearGradient id={`${id}-fill-${index}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
                </linearGradient>
              ) : null}
              {fill && path.area ? <path d={path.area} fill={`url(#${id}-fill-${index})`} /> : null}
              {path.line ? <path d={path.line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" /> : null}
              {last[index] ? <circle cx={x(last[index]!.t)} cy={y(last[index]!.v!)} r="2.5" fill="currentColor" stroke="var(--card)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /> : null}
            </g>
          ))}
          {hover ? (
            <g>
              <line x1={x(hover.t)} x2={x(hover.t)} y1="0" y2={height} stroke="var(--foreground)" strokeOpacity="0.35" strokeDasharray="2,2" vectorEffect="non-scaling-stroke" />
              {hover.values.map((value, index) => (value === null ? null : (
                <circle key={index} className={strokeClass[index]} cx={x(hover.t)} cy={y(value)} r="3" fill="currentColor" stroke="var(--card)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              )))}
            </g>
          ) : null}
      </svg>
    </div>
    </div>
    {hover ? (
      <div
        className={cn('pointer-events-none absolute bottom-full z-10 mb-1 flex flex-col gap-0.5 whitespace-nowrap rounded-md border border-border/70 bg-popover px-2 py-1 text-2xs leading-4 tabular-nums text-foreground shadow-md', flip ? '-translate-x-full' : '')}
        style={{ left: `${hoverLeft}%` }}
        role="status"
      >
        {formatTime ? <span className="text-muted-foreground">{formatTime(hover.t)}</span> : null}
        {hover.values.map((value, index) => (
          <span key={index} className="flex items-center gap-1.5">
            {labels?.[index] ? <span className={cn('size-1.5 rounded-full bg-current', strokeClass[index])} aria-hidden="true" /> : null}
            {labels?.[index] ? <span className="text-muted-foreground">{labels[index]}</span> : null}
            <span className="font-medium">{value === null ? '—' : format(value)}</span>
          </span>
        ))}
      </div>
    ) : null}
    </div>
  );
}

function Meter({ value, tone, className }: { value: number | null; tone: StatusTone; className?: string }) {
  const shown = useAnimatedNumber(value);
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-input/50 dark:bg-input/70', className)} role="presentation">
      <div
        className={cn('h-full rounded-full', tone === 'error' ? 'bg-error' : tone === 'warning' ? 'bg-warning' : tone === 'muted' ? 'bg-muted-foreground/40' : 'bg-primary')}
        style={{ width: `${Math.max(0, Math.min(100, shown ?? 0))}%` }}
      />
    </div>
  );
}

/**
 * Detail tile. Every tile renders the same four slots (header, value, chart,
 * footer) at fixed heights so the grid stays aligned regardless of which
 * sensors a machine exposes. It has no box of its own: the grid draws the
 * hairlines between tiles, inside the Health card.
 */
function Tile({
  icon,
  label,
  badge,
  badgeTone = 'muted',
  value,
  chart,
  footer,
}: {
  icon: ReactNode;
  label: string;
  badge?: ReactNode;
  badgeTone?: 'muted' | 'warning' | 'error' | 'secondary';
  value: ReactNode;
  chart: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 px-4 py-3" data-slot="health-tile">
      <div className="flex h-5 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-icon-muted">
          {icon}
          <span className="truncate">{label}</span>
        </span>
        {badge !== undefined && badge !== null ? (
          <Badge variant={badgeTone} size="sm" className="shrink-0 tabular-nums">{badge}</Badge>
        ) : null}
      </div>
      <div className="h-6">{value}</div>
      <div className="h-8">{chart}</div>
      <div className="h-4 truncate text-2xs leading-4 tabular-nums text-muted-foreground">{footer ?? '—'}</div>
    </div>
  );
}

function BigValue({ value, digits = 0, unit, tone = 'primary', className }: { value: number | null; digits?: number; unit?: string; tone?: StatusTone; className?: string }) {
  return (
    <div className={cn('flex items-baseline gap-1 text-2xl font-semibold leading-none tabular-nums', tone === 'error' || tone === 'warning' ? TONE_TEXT[tone] : value === null ? 'text-muted-foreground' : 'text-foreground', className)}>
      <TweenNumber value={value} digits={digits} />
      {unit && value !== null ? <span className="text-xs font-normal text-muted-foreground">{unit}</span> : null}
    </div>
  );
}

/** One aligned metric column in the collapsed row. */
function MetricCell({ label, value, unit, digits = 0, tone = 'primary', meter = true, className }: { label: string; value: number | null; unit: string; digits?: number; tone?: StatusTone; meter?: boolean; className?: string }) {
  return (
    <div className={cn('hidden min-w-0 flex-col gap-1 @min-[55rem]:flex', className)} role="group" aria-label={label}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className={cn('flex items-baseline gap-0.5 text-sm font-semibold leading-none tabular-nums', tone === 'error' || tone === 'warning' ? TONE_TEXT[tone] : value === null ? 'text-muted-foreground' : 'text-foreground')}>
        <TweenNumber value={value} digits={digits} />
        {value !== null ? <span className="text-3xs leading-none font-normal text-muted-foreground">{unit}</span> : null}
      </span>
      {meter ? <Meter value={value} tone={tone} className="h-1" /> : <span className="h-1" />}
    </div>
  );
}

const cpuLabel = (chip: string, cores: number) => {
  const cleaned = chip
    .replace(/\(R\)|\(TM\)/g, '')
    .replace(/\s+CPU\b.*$/i, '')
    .replace(/\s+with .*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned : `${cores} cores`;
};

const badgeToneFor = (tone: StatusTone): 'muted' | 'warning' | 'error' => (tone === 'error' ? 'error' : tone === 'warning' ? 'warning' : 'muted');

/** Metric-rate value split for the tweened number (the unit changes with magnitude). */
const rateParts = (bytesPerSecond: number | null) => {
  const rate = formatRate(bytesPerSecond);
  return rate.value === '—' ? { value: null, digits: 0, unit: '' } : { value: Number(rate.value), digits: rate.value.includes('.') ? 1 : 0, unit: rate.unit };
};

/** What's wrong with a machine, or that nothing is: its status, or the reading that set it. */
export function machineHeadline(item: MachineHealth, t: Translate, now = Date.now()): string {
  if (item.status === 'unconfigured') return t('machines.health.unconfiguredHint');
  if (item.status === 'unreachable') {
    // How long it's been down says whether it's a blip or something to look at.
    const since = item.lastOkAt !== null ? t('machines.health.lastAnswered', { ago: formatAgo(item.lastOkAt, now) }) : null;
    return [t('machines.health.status.unreachable'), unreachableReason(item.error, t), since].filter(Boolean).join(' · ');
  }
  if (item.status === 'pending') return t('machines.health.status.pending');
  const latest = item.latest;
  if (!item.reason || !latest) return t('machines.health.allClear');
  const { key, variables } = healthReasonText(item.reason, latest);
  return t(key, variables);
}

/** The tone the headline is written in: only a warning or a failure is colored. */
export const headlineClass = (status: HealthStatus) => {
  const tone = STATUS_TONE[status];
  return tone === 'error' || tone === 'warning' ? TONE_TEXT[tone] : 'text-muted-foreground';
};

/** A machine's one-line score: its number in its tone and its trend over the window. */
export function MachineScore({ item, windowMs, chartClassName }: { item: MachineHealth; windowMs: number; chartClassName?: string }) {
  const { t } = useI18n();
  const tone = STATUS_TONE[item.status];
  const id = `mh-${item.machine.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const series = useMemo(() => item.points.map((point) => ({ t: point.t, v: point.score })), [item.points]);
  return (
    <div className="flex items-center gap-2 @min-[55rem]:gap-3">
      <span className={cn('w-8 text-right text-xl font-semibold leading-none tabular-nums', item.score === null ? 'text-muted-foreground' : TONE_TEXT[tone])}>
        {item.score === null ? '—' : <TweenNumber value={item.score} />}
      </span>
      <div className={cn('h-7 w-24', chartClassName)}>
        <TimeSeries
          id={`${id}-score`}
          formatTime={(at) => formatTime(at, { seconds: true })}
          series={[series]}
          windowMs={windowMs}
          max={100}
          height={28}
          strokeClass={[TONE_STROKE[tone]]}
          guides={[45, 75]}
          ariaLabel={t('machines.health.chartAria', { machine: item.machine, metric: t('machines.health.trend') })}
        />
      </div>
    </div>
  );
}

/**
 * One machine in the fleet's list: its pill and what's wrong, its score and trend, and its main readings. The whole row
 * opens the machine's own page.
 */
function MachineRow({ item, newest, windowMs, onOpen }: { item: MachineHealth; newest: NewestAgents; windowMs: number; onOpen: () => void }) {
  const { t } = useI18n();
  const tone = STATUS_TONE[item.status];
  const latest = item.latest;
  const totalRate = rateParts(latest && (latest.rxBps !== null || latest.txBps !== null) ? (latest.rxBps ?? 0) + (latest.txBps ?? 0) : null);
  // Latency is tracked for remote machines only and never feeds the score, so it keeps a neutral tone.
  const pinged = item.pingTarget !== null;
  const latency = latest?.latencyMs ?? null;
  const sampled = item.status !== 'unconfigured';

  return (
    <article className="min-w-0" aria-label={machineName(item.machine)}>
      <div
        role="button"
        tabIndex={0}
        aria-label={t('machines.health.open', { machine: item.machine })}
        onClick={onOpen}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); } }}
        className={cn(
          'grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-3 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:hover:bg-input/16',
          '@min-[55rem]:grid-cols-[minmax(0,1fr)_9rem_repeat(4,4.5rem)_1rem] @min-[60rem]:grid-cols-[minmax(0,1fr)_9rem_repeat(5,4.5rem)_1rem]',
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <StatusDot tone={tone} pulse={item.status === 'degraded' || item.status === 'critical'} className="size-2.5" />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="flex min-w-0"><MachinePill name={item.machine} /></h3>
              {item.local ? <Badge variant="muted" size="sm">{t('machines.health.local')}</Badge> : null}
              <MachineAgentSummary item={item} newest={newest} />
            </div>
            <p className={cn('mt-1 truncate text-xs', headlineClass(item.status))} title={item.error ?? undefined}>
              {machineHeadline(item, t)}
            </p>
          </div>
        </div>

        {sampled ? (
          <>
            <MachineScore item={item} windowMs={windowMs} chartClassName="hidden @min-[55rem]:block" />
            <MetricCell label={t('machines.health.tile.cpu')} value={latest?.cpu ?? null} unit="%" tone={toneFor(latest?.cpu ?? null, ...READING_LIMITS.cpu)} />
            <MetricCell label={t('machines.health.tile.memory')} value={latest?.mem ?? null} unit="%" tone={toneFor(latest?.mem ?? null, ...READING_LIMITS.mem)} />
            <MetricCell label={t('machines.health.tile.disk')} value={latest?.disk ?? null} unit="%" tone={toneFor(latest?.disk ?? null, ...READING_LIMITS.disk)} />
            <MetricCell label={t('machines.health.tile.network')} value={totalRate.value} digits={totalRate.digits} unit={totalRate.unit} meter={false} />
            {pinged ? (
              <MetricCell className="@min-[55rem]:hidden @min-[60rem]:flex" label={t('machines.health.tile.latency')} value={latency} digits={latencyDigits(latency ?? 0)} unit="ms" meter={false} />
            ) : (
              <span className="hidden @min-[60rem]:block" aria-hidden="true" />
            )}
          </>
        ) : (
          <span className="@min-[55rem]:col-span-5 @min-[60rem]:col-span-6" aria-hidden="true" />
        )}
        <ChevronRight className="hidden size-4 justify-self-end text-icon-muted @min-[55rem]:block" aria-hidden="true" />
      </div>
    </article>
  );
}

/**
 * Everything read from one machine, as its page shows it: what it is (model, chip, memory, system, uptime, address),
 * then a tile for each reading with its chart over the window.
 */
export function MachineHealthDetail({ item, windowMs }: { item: MachineHealth; windowMs: number }) {
  const { t } = useI18n();
  const latest = item.latest;
  const facts = item.facts;
  const identity = useMemo(() => machineIdentity(facts), [facts]);
  const id = `mh-${item.machine.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const pick = useCallback((read: (point: HealthPoint) => number | null): Series => item.points.map((point) => ({ t: point.t, v: read(point) })), [item.points]);
  const cpuSeries = useMemo(() => pick((point) => point.cpu), [pick]);
  const memSeries = useMemo(() => pick((point) => point.mem), [pick]);
  const rxSeries = useMemo(() => pick((point) => point.rxBps), [pick]);
  const txSeries = useMemo(() => pick((point) => point.txBps), [pick]);
  const gpuSeries = useMemo(() => pick((point) => point.gpuUtil), [pick]);
  const latencySeries = useMemo(() => pick((point) => point.latencyMs), [pick]);
  const netMax = useMemo(() => Math.max(8 * KIB, ...item.points.flatMap((point) => [point.rxBps ?? 0, point.txBps ?? 0])) * 1.1, [item.points]);
  const latencyMax = useMemo(() => Math.max(10, ...item.points.map((point) => point.latencyMs ?? 0)) * 1.2, [item.points]);
  const latencyRange = useMemo(() => latencyStats(item.points), [item.points]);

  const cpuTone = toneFor(latest?.cpu ?? null, ...READING_LIMITS.cpu);
  const memTone = toneFor(latest?.mem ?? null, ...READING_LIMITS.mem);
  const diskTone = toneFor(latest?.disk ?? null, ...READING_LIMITS.disk);
  const swapTone = toneFor(latest?.swap ?? null, 50, 90);
  const cpuTempTone = toneFor(latest?.cpuTemp ?? null, 82, 97);
  const gpuTempTone = toneFor(latest?.gpuTemp ?? null, 82, 95);
  const loadPerCore = latest && facts ? latest.load1 / Math.max(1, facts.cores) : null;
  const activity = latest?.cpu === null || latest?.cpu === undefined ? null : latest.cpu < 15 ? 'idle' : latest.cpu < 60 ? 'busy' : 'saturated';
  const rx = formatRate(latest?.rxBps ?? null);
  const tx = formatRate(latest?.txBps ?? null);
  const total = latest && (latest.rxBps !== null || latest.txBps !== null) ? (latest.rxBps ?? 0) + (latest.txBps ?? 0) : null;
  const totalRate = rateParts(total);
  const hasGpuTelemetry = latest ? latest.gpuUtil !== null || latest.gpuTemp !== null : false;
  const chartLabel = (metric: string) => t('machines.health.chartAria', { machine: item.machine, metric });
  const chartTime = (at: number) => formatTime(at, { seconds: true });
  const chartRate = (value: number) => { const rate = formatRate(value); return `${rate.value} ${rate.unit}`; };
  const pinged = item.pingTarget !== null;
  const latency = latest?.latencyMs ?? null;
  const ms = (value: number) => value.toFixed(latencyDigits(value));
  const pathBadge = item.path ? (
    <span title={t(`machines.health.path.${item.path.kind}Hint` as MessageKey)}>
      {item.path.kind === 'relay' && item.path.relay
        ? t('machines.health.path.relayRegion', { region: item.path.relay.toUpperCase() })
        : t(`machines.health.path.${item.path.kind}` as MessageKey)}
    </span>
  ) : undefined;

  // Two parts of the Health card, each a child it divides from the next: the facts line, then the tiles edge to edge.
  // The tiles wrap onto more rows as the card narrows, so each draws the line above and to its left, and the grid
  // sits a pixel up and left inside a clipping frame that hides the ones on the card's edge, as StatsGrid does.
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-xs text-muted-foreground">
        {facts ? (
          <>
            {identity?.modelId ? (
              <span className="truncate text-foreground/80" title={t('machines.identity.modelId', { id: identity.modelId })}>
                {identity.productName ?? (identity.label ? t(identity.label) : identity.modelId)}
              </span>
            ) : null}
            <span className="truncate text-foreground/80">{cpuLabel(facts.chip, facts.cores)}</span>
            <span>{t('machines.health.cores', { count: facts.cores })}</span>
            <span>{formatBytes(facts.memTotalKb * KIB, 0)}</span>
            {facts.gpu && facts.gpu !== facts.chip ? <span className="truncate">{facts.gpu}</span> : null}
            <span>{osLabel(facts.os, facts.osVersion)}</span>
            {facts.uptimeS !== null ? <span>{t('machines.health.uptime', { uptime: formatDuration(facts.uptimeS * 1000) })}</span> : null}
            {facts.batteryPct !== null ? <span>{t('machines.health.battery', { value: Math.round(facts.batteryPct) })}</span> : null}
            {facts.ip ? <span className="font-mono">{facts.ip}</span> : null}
          </>
        ) : (
          <>
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-3.5 w-24" />
          </>
        )}
        <span className="ms-auto tabular-nums text-muted-foreground">
          {item.lastOkAt ? t('machines.health.sampled', { time: formatTime(item.lastOkAt, { seconds: true }) }) : ''}
        </span>
      </div>
      <div className="overflow-hidden">
        <div className="-mt-px -ml-px grid grid-cols-2 *:border-t *:border-l *:border-border/50 lg:grid-cols-3">
          <Tile
            icon={<Cpu />}
            label={t('machines.health.tile.cpu')}
            badge={latest?.cpuTemp !== null && latest?.cpuTemp !== undefined ? `${Math.round(latest.cpuTemp)}°C` : undefined}
            badgeTone={badgeToneFor(cpuTempTone)}
            value={<BigValue value={latest?.cpu ?? null} unit="%" tone={cpuTone} />}
            chart={<TimeSeries id={`${id}-cpu`} formatTime={chartTime} series={[cpuSeries]} windowMs={windowMs} max={100} height={32} strokeClass={[TONE_STROKE[cpuTone]]} ariaLabel={chartLabel(t('machines.health.tile.cpu'))} />}
            footer={latest ? [activity ? t(`machines.health.activity.${activity}` as MessageKey) : null, t('machines.health.load', { load: latest.load1.toFixed(1), cores: facts?.cores ?? '—' })].filter(Boolean).join(' · ') : null}
          />
          <Tile
            icon={<MemoryStick />}
            label={t('machines.health.tile.memory')}
            badge={latest?.swap !== null && latest?.swap !== undefined ? t('machines.health.swapBadge', { value: Math.round(latest.swap) }) : undefined}
            badgeTone={badgeToneFor(swapTone)}
            value={<BigValue value={latest?.mem ?? null} unit="%" tone={memTone} />}
            chart={<TimeSeries id={`${id}-mem`} formatTime={chartTime} series={[memSeries]} windowMs={windowMs} max={100} height={32} strokeClass={[TONE_STROKE[memTone]]} ariaLabel={chartLabel(t('machines.health.tile.memory'))} />}
            footer={latest && facts ? `${formatBytes(latest.memUsedKb * KIB)} / ${formatBytes(facts.memTotalKb * KIB, 0)}` : null}
          />
          <Tile
            icon={<HardDrive />}
            label={t('machines.health.tile.disk')}
            badge={latest ? t('machines.health.diskFree', { free: formatBytes(latest.diskFreeKb * KIB, 0) }) : undefined}
            badgeTone={badgeToneFor(diskTone)}
            value={<BigValue value={latest?.disk ?? null} unit="%" tone={diskTone} />}
            chart={
              <div className="flex h-full flex-col justify-end gap-1.5">
                <Meter value={latest?.disk ?? null} tone={diskTone} />
                <div className="flex justify-between text-2xs leading-none text-muted-foreground">
                  <span>{latest && facts ? formatBytes((facts.diskTotalKb - latest.diskFreeKb) * KIB, 0) : '—'}</span>
                  <span>{facts ? formatBytes(facts.diskTotalKb * KIB, 0) : '—'}</span>
                </div>
              </div>
            }
            footer={facts?.os === 'Darwin' ? t('machines.health.diskVolume.data') : t('machines.health.diskVolume.root')}
          />
          <Tile
            icon={<Gpu />}
            label={t('machines.health.tile.gpu')}
            badge={latest?.gpuTemp !== null && latest?.gpuTemp !== undefined ? `${Math.round(latest.gpuTemp)}°C` : undefined}
            badgeTone={badgeToneFor(gpuTempTone)}
            value={<BigValue value={hasGpuTelemetry ? latest?.gpuUtil ?? null : null} unit="%" tone={toneFor(latest?.gpuUtil ?? null, 90, 101)} />}
            chart={
              hasGpuTelemetry ? (
                <TimeSeries id={`${id}-gpu`} formatTime={chartTime} series={[gpuSeries]} windowMs={windowMs} max={100} height={32} strokeClass={['text-primary']} ariaLabel={chartLabel(t('machines.health.tile.gpu'))} />
              ) : (
                <div className="flex h-full items-end text-2xs text-muted-foreground">{facts?.gpu ? t('machines.health.noTelemetry') : t('machines.health.noGpu')}</div>
              )
            }
            footer={
              facts?.gpu
                ? latest?.gpuMemUsedMb !== null && latest?.gpuMemUsedMb !== undefined && facts.gpuMemTotalMb
                  ? `${formatBytes(latest.gpuMemUsedMb * KIB * KIB, 1)} / ${formatBytes(facts.gpuMemTotalMb * KIB * KIB, 0)}`
                  : facts.gpu
                : null
            }
          />
          <Tile
            icon={<Network />}
            label={t('machines.health.tile.network')}
            badge={facts?.ip || undefined}
            value={<BigValue value={totalRate.value} digits={totalRate.digits} unit={totalRate.unit} />}
            chart={
              <TimeSeries
                id={`${id}-net`}
                series={[txSeries, rxSeries]}
             
                windowMs={windowMs}
                max={netMax}
                height={32}
                fill={false}
                strokeClass={['text-chart-1', 'text-chart-5']}
                ariaLabel={chartLabel(t('machines.health.tile.network'))}
                formatTime={chartTime}
                format={chartRate}
                labels={[t('machines.health.net.up'), t('machines.health.net.down')]}
              />
            }
            footer={
              latest ? (
                <span className="flex items-center gap-3">
                  <span className="flex items-center gap-1 text-chart-1"><ArrowUp className="size-3" aria-hidden="true" /><span className="text-muted-foreground">{tx.value} {tx.unit}</span></span>
                  <span className="flex items-center gap-1 text-chart-5"><ArrowDown className="size-3" aria-hidden="true" /><span className="text-muted-foreground">{rx.value} {rx.unit}</span></span>
                </span>
              ) : null
            }
          />
          {pinged ? (
            <Tile
              icon={<Radar />}
              label={t('machines.health.tile.latency')}
              badge={pathBadge}
              value={<BigValue value={latency} digits={latencyDigits(latency ?? 0)} unit="ms" />}
              chart={<TimeSeries id={`${id}-latency`} formatTime={chartTime} series={[latencySeries]} windowMs={windowMs} max={latencyMax} height={32} strokeClass={['text-primary']} format={formatLatency} ariaLabel={chartLabel(t('machines.health.tile.latency'))} />}
              footer={
                latest && latency === null
                  ? t('machines.health.noPingReply')
                  : latencyRange
                  ? t('machines.health.latencyStats', { min: ms(latencyRange.min), avg: ms(latencyRange.avg), max: ms(latencyRange.max) })
                  : null
              }
            />
          ) : null}
          <Tile
            icon={<Thermometer />}
            label={t('machines.health.tile.pressure')}
            badge={loadPerCore !== null ? t('machines.health.loadPerCore', { value: loadPerCore.toFixed(2) }) : undefined}
            badgeTone={loadPerCore !== null && loadPerCore >= 2.5 ? 'error' : loadPerCore !== null && loadPerCore >= 1 ? 'warning' : 'muted'}
            value={
              <div className="flex items-baseline gap-4">
                <span className="flex items-baseline gap-1.5"><span className="text-2xs text-muted-foreground">{t('machines.health.tile.cpu')}</span><BigValue value={latest?.cpuTemp ?? null} unit="°C" tone={cpuTempTone} /></span>
                <span className="flex items-baseline gap-1.5"><span className="text-2xs text-muted-foreground">{t('machines.health.tile.gpu')}</span><BigValue value={latest?.gpuTemp ?? null} unit="°C" tone={gpuTempTone} /></span>
              </div>
            }
            chart={
              <div className="flex h-full flex-col justify-end gap-1.5">
                <Meter value={latest?.swap ?? null} tone={swapTone} />
                <div className="flex justify-between text-2xs leading-none text-muted-foreground">
                  <span>{t('machines.health.swap')}</span>
                  <span className="tabular-nums">
                    {latest?.swap !== null && latest?.swap !== undefined && facts?.swapTotalKb
                      ? `${formatBytes((latest.swapUsedKb ?? 0) * KIB)} / ${formatBytes(facts.swapTotalKb * KIB, 0)}`
                      : t('machines.health.noSwap')}
                  </span>
                </div>
              </div>
            }
            footer={latest ? t('machines.health.loadAverages', { one: latest.load1.toFixed(2), five: latest.load5.toFixed(2), fifteen: latest.load15.toFixed(2) }) : null}
          />
        </div>
      </div>
    </>
  );
}

/**
 * The machines' health over a window, read as the sampler says each round ends and as the window shows again. The
 * backend samples at its fast interval only while something reads it this way. With `machine`, only that machine's
 * history comes, as its own page charts no other.
 */
export function useMachineHealthSnapshot(windowMs: number, machine?: string) {
  const [snapshot, setSnapshot] = useState<MachineHealthSnapshot | null>(null);
  const [error, setError] = useState('');
  // When the figures on screen were read, so a failed read after them can say how old they are.
  const [readAt, setReadAt] = useState<number | null>(null);
  const snapshotRef = useRef<MachineHealthSnapshot | null>(null);
  const inflight = useRef(false);
  const fullReload = useRef(true);

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const previous = fullReload.current ? null : snapshotRef.current;
      const since = previous ? Math.max(-Infinity, ...previous.machines.flatMap((item) => item.points.map((point) => point.t))) : null;
      const next = await fetchMachineHealth(Number.isFinite(since) ? since : null, windowMs, false, machine);
      const merged = mergeSnapshots(previous, next, windowMs);
      snapshotRef.current = merged;
      fullReload.current = false;
      setSnapshot(merged);
      setReadAt(Date.now());
      setError('');
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      inflight.current = false;
    }
  }, [windowMs, machine]);

  useEffect(() => {
    fullReload.current = true;
    snapshotRef.current = null;
  }, [windowMs, machine]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const refresh = () => {
      if (!disposed && !document.hidden) void load();
    };
    refresh();
    // The sampler says when each round ends, and nothing here moves between rounds, so there's no poll.
    listen('machine-health-updated', refresh)
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      unlisten?.();
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  return { snapshot, error, readAt, retry: load };
}

/**
 * A failed read of the machines' health, in plain words with Try again. With figures already on screen it says how old
 * they are, since the charts would otherwise sit still as if nothing had changed.
 */
export function HealthReadFailed({ error, stale, readAt, onRetry }: { error: string; stale: boolean; readAt: number | null; onRetry: () => void }) {
  const { t } = useI18n();
  const reason = plainError(error, t);
  return (
    <Alert
      variant={stale ? 'warning' : 'error'}
      icon={<TriangleAlert />}
      action={<Button variant="outline" size="sm" onClick={onRetry}>{t('common.tryAgain')}</Button>}
    >
      <AlertDescription title={errorWords(error)}>
        {stale && readAt !== null ? t('machines.health.readStale', { time: formatTime(readAt), error: reason }) : t('machines.health.readFailed', { error: reason })}
      </AlertDescription>
    </Alert>
  );
}

/** The window the charts cover, as its toggle's id. */
export const healthWindowMs = (id: HealthWindowId) => HEALTH_WINDOWS.find((option) => option.id === id)?.ms ?? HEALTH_WINDOWS[1].ms;

/** Picks the window the charts cover: 5, 15 or 60 minutes. */
export function HealthWindowToggle({ value, onChange }: { value: HealthWindowId; onChange: (id: HealthWindowId) => void }) {
  const { t } = useI18n();
  return (
    <ToggleGroup value={[value]} onValueChange={(next) => { const id = next[0] as HealthWindowId | undefined; if (id) onChange(id); }} aria-label={t('machines.health.window')}>
      {HEALTH_WINDOWS.map((option) => (
        <Toggle key={option.id} value={option.id}>{option.id}</Toggle>
      ))}
    </ToggleGroup>
  );
}

/**
 * The fleet's health: a row for each machine, which opens its own page. Reads the desktop app while mounted and
 * visible.
 */
export function MachineHealthPanel({ onConfigure, onOpen }: {
  onConfigure?: () => void;
  /** Opens a machine's own page. */
  onOpen: (machine: string) => void;
}) {
  const { t } = useI18n();
  const [windowId, setWindowId] = useState<HealthWindowId>('15m');
  const windowMs = healthWindowMs(windowId);
  const { snapshot, error, readAt, retry } = useMachineHealthSnapshot(windowMs);
  const machines = useMemo(() => snapshot?.machines ?? [], [snapshot]);
  const latest = useLatestAgentVersions();
  const newest = useMemo(() => newestAgents(machines, latest), [machines, latest]);

  const counts = machines.reduce(
    (acc, item) => {
      acc[item.status] += 1;
      return acc;
    },
    { healthy: 0, degraded: 0, critical: 0, unreachable: 0, pending: 0, unconfigured: 0 } as Record<HealthStatus, number>,
  );
  const fleetTone: StatusTone = counts.critical || counts.unreachable ? 'error' : counts.degraded ? 'warning' : counts.healthy ? 'success' : 'muted';
  const fleetLabel = counts.critical
    ? t('machines.health.fleet.critical', { count: counts.critical })
    : counts.unreachable
    ? t('machines.health.fleet.unreachable', { count: counts.unreachable })
    : counts.degraded
    ? t('machines.health.fleet.degraded', { count: counts.degraded })
    : counts.healthy
    ? t('machines.health.fleet.healthy', { count: counts.healthy })
    : t('machines.health.fleet.idle');

  return (
    <SettingsSection
      title={t('machines.health.title')}
      description={t('machines.health.description', { seconds: Math.round((snapshot?.intervalMs ?? 5_000) / 1000) })}
      headerAction={
        // Wraps rather than running past the card in the narrowest zoomed window, where the header puts it under the title.
        <div className="flex flex-wrap items-center justify-end gap-2">
          {snapshot ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <StatusPill tone={fleetTone} className="cursor-default whitespace-nowrap">{fleetLabel}</StatusPill>
              </TooltipTrigger>
              <TooltipPopup>{t('machines.health.fleet.tooltip', { interval: Math.round(snapshot.intervalMs / 1000) })}</TooltipPopup>
            </Tooltip>
          ) : null}
          <HealthWindowToggle value={windowId} onChange={setWindowId} />
          {onConfigure ? (
            <Button variant="outline" size="sm" onClick={onConfigure}>
              <Settings2 />
              {t('machines.health.configure')}
            </Button>
          ) : null}
        </div>
      }
    >
      {error ? <SettingsBlock><HealthReadFailed error={error} stale={snapshot !== null} readAt={readAt} onRetry={() => void retry()} /></SettingsBlock> : null}
      {!snapshot && !error ? (
        <div className="@container divide-y divide-border/50">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="size-2.5 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5"><Skeleton className="h-3.5 w-32" /><Skeleton className="h-3 w-48" /></div>
              <Skeleton className="h-7 w-36" />
              <Skeleton className="hidden h-7 w-72 @min-[55rem]:block" />
            </div>
          ))}
        </div>
      ) : null}
      {snapshot && machines.length === 0 ? (
        <Empty size="sm">
          <EmptyMedia><Unplug /></EmptyMedia>
          <EmptyTitle>{t('machines.health.empty.title')}</EmptyTitle>
          <EmptyDescription>{t('machines.health.empty.description')}</EmptyDescription>
          <FirstMachineActions onAdded={onOpen} />
        </Empty>
      ) : null}
      {machines.length ? (
        // The columns follow the list's own width, not the window's: the sidebar and a zoom both take from it.
        <div className="@container divide-y divide-border/50">
          {machines.map((item) => (
            <MachineRow key={item.machine} item={item} newest={newest} windowMs={windowMs} onOpen={() => onOpen(item.machine)} />
          ))}
        </div>
      ) : null}
    </SettingsSection>
  );
}

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { SettingsBlock, SettingsSection } from '../components/layout/settings';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatCount, formatTokens } from '../lib/format';
import { cn } from '../lib/utils';
import {
  buildUsageTrendSeries,
  clampTrendRatio,
  formatTrendRangeLabel,
  isClientPointInsideRect,
  trendPointIndexAtRatio,
  trendTimeAxis,
  trendTimePosition,
  trendValueAxis,
  type PreparedTrendPoint,
  type PreparedTrendSeries,
  type TrendBucket,
  type TrendInputPoint,
} from '../services/usageTrend';

const BUCKET_DESCRIPTION: Record<TrendBucket, MessageKey> = {
  hour: 'usage.trend.bucket.hour',
  '3h': 'usage.trend.bucket.3h',
  day: 'usage.trend.bucket.day',
  week: 'usage.trend.bucket.week',
  month: 'usage.trend.bucket.month',
};

const TOKENS_HEIGHT = 128;
const REQUESTS_HEIGHT = 56;
// Keeps the top grid line and the tallest mark clear of the panel edge.
const PAD_TOP = 6;
const MAX_BAR_WIDTH = 24;
const BAR_GAP = 2;
const BAR_RADIUS = 4;
// A nonzero bucket stays visible next to a much larger peak.
const MIN_BAR_HEIGHT = 2;
const TOKENS_COLOR = 'text-primary';
const REQUESTS_COLOR = 'text-info';

const round = (value: number) => Math.round(value * 100) / 100;

type SwatchShape = 'bar' | 'line' | 'hatch';

/** A bar with rounded top corners, standing on the baseline. */
function barPath(x: number, y: number, width: number, height: number): string {
  const r = round(Math.min(BAR_RADIUS, width / 2, height));
  const [left, top, right, bottom] = [round(x), round(y), round(x + width), round(y + height)];
  return `M${left},${bottom}V${round(top + r)}A${r},${r} 0 0 1 ${round(left + r)},${top}H${round(right - r)}A${r},${r} 0 0 1 ${right},${round(top + r)}V${bottom}Z`;
}

/**
 * Tokens and requests over the selected range, grouped by the bucket that fits
 * the span. The backend's hourly rows are laid on a continuous time axis, so
 * idle stretches show as gaps instead of collapsing.
 */
export function UsageTrendSection({
  timeline,
  range,
  empty,
}: {
  timeline: TrendInputPoint[];
  range: { start?: string; end?: string };
  empty: ReactNode;
}) {
  const { t } = useI18n();
  // Keyed on the range's fields, since the range object itself may be rebuilt every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const series = useMemo(() => buildUsageTrendSeries(timeline, range), [timeline, range.start, range.end]);
  const hasTraffic = series.points.length > 0 && (series.totals.requests > 0 || series.totals.tokens > 0 || series.totals.recovered > 0);
  return (
    <SettingsSection title={t('usage.trend.title')} summary={t(BUCKET_DESCRIPTION[series.bucket])}>
      <SettingsBlock className="py-4">{hasTraffic ? <UsageTrend series={series} /> : empty}</SettingsBlock>
    </SettingsSection>
  );
}

export function UsageTrend({ series }: { series: PreparedTrendSeries }) {
  const { t } = useI18n();
  const { points, bucket, totals } = series;
  const count = points.length;
  const start = points[0]?.start ?? new Date(0);
  const end = points[count - 1]?.end ?? start;
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [tooltipWidth, setTooltipWidth] = useState(0);
  // The hovered position, not the hovered bucket, so a background refresh that
  // replaces the data keeps the tooltip on whatever is now under the pointer.
  const [hoveredRatio, setHoveredRatio] = useState<number | null>(null);
  // Only points picked with the keyboard are read out; the pointer crosses buckets far too quickly to announce each one.
  const [announcePoint, setAnnouncePoint] = useState(false);
  const summaryId = useId();
  const fillId = `usage-trend-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const hatchId = `${fillId}-hatch`;

  useLayoutEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const measure = () => setWidth(Math.max(0, Math.round(plot.getBoundingClientRect().width)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(plot);
    return () => observer.disconnect();
  }, []);

  const hovering = hoveredRatio !== null;
  useEffect(() => {
    if (!hovering) return;
    // Re-rendered marks can swallow the plot's pointerleave, so any move outside it clears the tooltip.
    const onWindowPointerMove = (event: globalThis.PointerEvent) => {
      if (event.clientX === 0 && event.clientY === 0) return;
      const plot = plotRef.current;
      if (!plot || !isClientPointInsideRect(event.clientX, event.clientY, plot.getBoundingClientRect())) setHoveredRatio(null);
    };
    window.addEventListener('pointermove', onWindowPointerMove);
    return () => window.removeEventListener('pointermove', onWindowPointerMove);
  }, [hovering]);

  const chart = useMemo(() => {
    if (!width || !count) return null;
    const x = (date: Date) => trendTimePosition(date, start, end) * width;
    // Claude Code's own count stands on the transcripts' bar, so the axis reaches the top of both.
    const tokenAxis = trendValueAxis(Math.max(...points.map((point) => point.tokens + point.recovered)), 4);
    const requestAxis = trendValueAxis(Math.max(...points.map((point) => point.requests)), 2);
    const tokenY = (value: number) => PAD_TOP + (1 - value / tokenAxis.max) * (TOKENS_HEIGHT - PAD_TOP);
    const requestY = (value: number) => PAD_TOP + (1 - value / requestAxis.max) * (REQUESTS_HEIGHT - PAD_TOP);
    const slots = points.map((point) => {
      const left = x(point.start);
      const right = x(point.end);
      const center = (left + right) / 2;
      const barWidth = Math.max(1, Math.min(MAX_BAR_WIDTH, right - left - BAR_GAP));
      const barHeight = point.tokens > 0 ? Math.max(MIN_BAR_HEIGHT, (point.tokens / tokenAxis.max) * (TOKENS_HEIGHT - PAD_TOP)) : 0;
      // Kept apart from the bar below it by a gap, since it's a different count rather than more of the same one.
      const gap = barHeight ? BAR_GAP : 0;
      const recoveredHeight = point.recovered > 0 ? Math.max(MIN_BAR_HEIGHT, (point.recovered / tokenAxis.max) * (TOKENS_HEIGHT - PAD_TOP) - gap) : 0;
      return {
        key: point.key,
        center,
        bar: barHeight ? barPath(center - barWidth / 2, TOKENS_HEIGHT - barHeight, barWidth, barHeight) : '',
        recoveredBar: recoveredHeight ? barPath(center - barWidth / 2, TOKENS_HEIGHT - barHeight - gap - recoveredHeight, barWidth, recoveredHeight) : '',
        requestY: requestY(point.requests),
      };
    });
    const line = slots.map((slot, index) => `${index ? 'L' : 'M'}${round(slot.center)},${round(slot.requestY)}`).join('');
    const firstSlot = slots[0];
    const lastSlot = slots[count - 1];
    if (!firstSlot || !lastSlot) return null;
    const area = `${line}L${round(lastSlot.center)},${REQUESTS_HEIGHT}L${round(firstSlot.center)},${REQUESTS_HEIGHT}Z`;
    return { tokenAxis, requestAxis, tokenY, requestY, slots, firstSlot, line, area };
    // Keyed on series: points, count, start, end and bucket all derive from it (start is a new Date when it's empty).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, width]);

  // Keyed on series, like the chart above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const axisLabels = useMemo(() => trendTimeAxis(start, end, bucket, width), [series, width]);

  const hoveredIndex = hoveredRatio === null || !count ? -1 : trendPointIndexAtRatio(points, start, end, hoveredRatio);
  const active = hoveredIndex >= 0 ? points[hoveredIndex] : null;
  const activeSlot = chart && hoveredIndex >= 0 ? chart.slots[hoveredIndex] : null;
  const activeRange = active ? formatTrendRangeLabel(active, bucket) : '';

  // Measured before paint, so the tooltip can be kept inside the plot on the side with room.
  // No deps on purpose: the tooltip's width follows its content, and setting the same width is a no-op.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const next = tooltipRef.current?.offsetWidth ?? 0;
    setTooltipWidth((current) => (current === next ? current : next));
  });

  if (!count) return null;

  const centerRatio = (point: PreparedTrendPoint) => (trendTimePosition(point.start, start, end) + trendTimePosition(point.end, start, end)) / 2;
  let tooltipLeft = 0;
  if (activeSlot) {
    const fitsRight = activeSlot.center + 8 + tooltipWidth <= width;
    const preferRight = fitsRight || activeSlot.center < width / 2;
    const left = preferRight ? activeSlot.center + 8 : activeSlot.center - 8 - tooltipWidth;
    tooltipLeft = Math.max(0, Math.min(Math.max(0, width - tooltipWidth), left));
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = clampTrendRatio((event.clientX - rect.left) / rect.width);
    const index = trendPointIndexAtRatio(points, start, end, ratio);
    setAnnouncePoint(false);
    // Moving within the hovered bucket changes nothing on screen, so skip the render.
    setHoveredRatio((current) => (current !== null && trendPointIndexAtRatio(points, start, end, current) === index ? current : ratio));
  };

  const handlePointerLeave = (event: PointerEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    if (isClientPointInsideRect(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())) return;
    if (event.clientX === 0 && event.clientY === 0) return;
    setHoveredRatio(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = hoveredIndex < 0 ? count - 1 : Math.max(0, hoveredIndex - 1);
    else if (event.key === 'ArrowRight') next = hoveredIndex < 0 ? 0 : Math.min(count - 1, hoveredIndex + 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else if (event.key === 'Escape' && hovering) {
      event.preventDefault();
      setHoveredRatio(null);
      return;
    }
    const nextPoint = next === null ? undefined : points[next];
    if (!nextPoint) return;
    event.preventDefault();
    setAnnouncePoint(true);
    setHoveredRatio(centerRatio(nextPoint));
  };

  const crosshair = (height: number) =>
    activeSlot ? (
      <line
        x1={activeSlot.center}
        x2={activeSlot.center}
        y1={0}
        y2={height}
        stroke="var(--foreground)"
        strokeOpacity="0.35"
        strokeDasharray="2,2"
        vectorEffect="non-scaling-stroke"
      />
    ) : null;

  // Solid hairlines: dashes would read as a threshold rather than a grid.
  const grid = (ticks: number[], y: (value: number) => number) =>
    ticks.map((tick) => (
      <line key={tick} x1={0} x2={width} y1={y(tick)} y2={y(tick)} stroke="var(--border)" strokeOpacity={tick ? 0.7 : 1} vectorEffect="non-scaling-stroke" />
    ));

  return (
    <div className="flex gap-2">
      <div className="w-10 shrink-0 text-2xs leading-4 tabular-nums text-muted-foreground" aria-hidden="true">
        <div className="h-5" />
        <ValueAxis ticks={chart?.tokenAxis.ticks ?? []} y={chart?.tokenY} height={TOKENS_HEIGHT} />
        <div className="mt-3 h-5" />
        <ValueAxis ticks={chart?.requestAxis.ticks ?? []} y={chart?.requestY} height={REQUESTS_HEIGHT} />
      </div>
      <div
        ref={plotRef}
        className="relative min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        tabIndex={0}
        role="group"
        aria-label={t('usage.trend.aria')}
        aria-describedby={summaryId}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onPointerCancel={handlePointerLeave}
        onKeyDown={handleKeyDown}
        onBlur={() => setHoveredRatio(null)}
        data-slot="usage-trend"
      >
        <div className="flex flex-wrap items-center gap-x-3">
          <SeriesLabel color={TOKENS_COLOR} shape="bar">{t('usage.trend.series.tokens')}</SeriesLabel>
          {totals.recovered > 0 ? <SeriesLabel color={TOKENS_COLOR} shape="hatch">{t('usage.trend.series.recovered')}</SeriesLabel> : null}
        </div>
        <svg
          className={cn('block w-full', TOKENS_COLOR)}
          style={{ height: TOKENS_HEIGHT }}
          viewBox={`0 0 ${Math.max(width, 1)} ${TOKENS_HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {chart ? (
            <>
              {grid(chart.tokenAxis.ticks, chart.tokenY)}
              {totals.recovered > 0 ? (
                <defs>
                  <pattern id={hatchId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <rect width="1.5" height="4" fill="currentColor" />
                  </pattern>
                </defs>
              ) : null}
              <g fill="currentColor">
                {chart.slots.map((slot, index) =>
                  slot.bar ? (
                    <path key={slot.key} d={slot.bar} fillOpacity={hoveredIndex < 0 || index === hoveredIndex ? 0.9 : 0.45} />
                  ) : null,
                )}
              </g>
              {chart.slots.map((slot, index) =>
                slot.recoveredBar ? (
                  <g key={`${slot.key}-recovered`} opacity={hoveredIndex < 0 || index === hoveredIndex ? 1 : 0.5}>
                    <path d={slot.recoveredBar} fill="currentColor" fillOpacity="0.14" />
                    <path d={slot.recoveredBar} fill={`url(#${hatchId})`} fillOpacity="0.8" />
                  </g>
                ) : null,
              )}
              {crosshair(TOKENS_HEIGHT)}
            </>
          ) : null}
        </svg>
        <SeriesLabel color={REQUESTS_COLOR} shape="line" className="mt-3">{t('usage.trend.series.requests')}</SeriesLabel>
        <svg
          className={cn('block w-full', REQUESTS_COLOR)}
          style={{ height: REQUESTS_HEIGHT }}
          viewBox={`0 0 ${Math.max(width, 1)} ${REQUESTS_HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {chart ? (
            <>
              <defs>
                <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              {grid(chart.requestAxis.ticks, chart.requestY)}
              {count > 1 ? (
                <>
                  <path d={chart.area} fill={`url(#${fillId})`} />
                  <path d={chart.line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                </>
              ) : (
                <circle cx={chart.firstSlot.center} cy={chart.firstSlot.requestY} r="2.5" fill="currentColor" />
              )}
              {crosshair(REQUESTS_HEIGHT)}
              {activeSlot ? (
                <circle cx={activeSlot.center} cy={activeSlot.requestY} r="3" fill="currentColor" stroke="var(--card)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              ) : null}
            </>
          ) : null}
        </svg>
        <div className="relative mt-1 h-4 text-2xs leading-4 tabular-nums text-muted-foreground" aria-hidden="true">
          {axisLabels.map((label) => (
            <span
              key={`${label.align}-${label.date.getTime()}`}
              className={cn('absolute top-0 whitespace-nowrap', label.align === 'center' && '-translate-x-1/2', label.align === 'end' && '-translate-x-full')}
              style={{ left: `${label.position * 100}%` }}
            >
              {label.tick ? <span className="absolute -top-1 left-1/2 h-1 w-px bg-border" /> : null}
              {label.label}
            </span>
          ))}
        </div>
        {active && activeSlot ? (
          <div
            ref={tooltipRef}
            className="pointer-events-none absolute top-6 z-10 flex flex-col gap-0.5 whitespace-nowrap rounded-md border border-border/70 bg-popover px-2 py-1 text-2xs leading-4 tabular-nums text-foreground shadow-md"
            style={{ left: tooltipLeft }}
            aria-hidden="true"
          >
            <span className="text-muted-foreground">{activeRange}</span>
            <TooltipRow color={TOKENS_COLOR} shape="bar" label={t('usage.trend.series.tokens')} value={formatCount(active.tokens)} />
            {active.recovered > 0 ? (
              <TooltipRow color={TOKENS_COLOR} shape="hatch" label={t('usage.trend.series.recovered')} value={formatCount(active.recovered)} />
            ) : null}
            <TooltipRow color={REQUESTS_COLOR} shape="line" label={t('usage.trend.series.requests')} value={formatCount(active.requests)} />
          </div>
        ) : null}
      </div>
      <p id={summaryId} className="sr-only">
        {t('usage.trend.srSummary', {
          range: formatTrendRangeLabel({ start, end }, 'hour'),
          tokens: formatCount(totals.tokens),
          requests: formatCount(totals.requests),
        })}{' '}
        {totals.recovered > 0 ? `${t('usage.trend.srRecovered', { tokens: formatCount(totals.recovered) })} ` : null}
        {t('usage.trend.keyboardHint')}
      </p>
      <p className="sr-only" aria-live="polite">
        {announcePoint && active
          ? t('usage.trend.srPoint', {
              range: activeRange,
              tokens: formatCount(active.tokens),
              requests: formatCount(active.requests),
            })
          : ''}
        {/* A hatched bar reads out what it adds, as its tooltip shows it. */}
        {announcePoint && active && active.recovered > 0 ? ` ${t('usage.trend.srPointRecovered', { tokens: formatCount(active.recovered) })}` : ''}
      </p>
    </div>
  );
}

function ValueAxis({ ticks, y, height }: { ticks: number[]; y?: (value: number) => number; height: number }) {
  return (
    <div className="relative" style={{ height }}>
      {y
        ? ticks.map((tick) => (
            <span key={tick} className="absolute end-0 -translate-y-1/2" style={{ top: y(tick) }}>
              {formatTokens(tick)}
            </span>
          ))
        : null}
    </div>
  );
}

/** A hatch marks a figure from another, looser count, so it reads apart without leaning on color. */
const HATCH = { backgroundImage: 'repeating-linear-gradient(135deg, currentColor 0 1px, transparent 1px 3px)' };

function Swatch({ color, shape }: { color: string; shape: SwatchShape }) {
  return (
    <span
      className={cn(
        'shrink-0',
        color,
        shape === 'line' ? 'h-0.5 w-2.5 rounded-full bg-current' : 'size-2 rounded-[2px]',
        shape === 'bar' && 'bg-current',
        shape === 'hatch' && 'border border-current/70',
      )}
      style={shape === 'hatch' ? HATCH : undefined}
      aria-hidden="true"
    />
  );
}

function SeriesLabel({ color, shape, className, children }: { color: string; shape: SwatchShape; className?: string; children: ReactNode }) {
  return (
    <div className={cn('flex h-5 items-center gap-1.5 text-xs font-medium text-muted-foreground', className)}>
      <Swatch color={color} shape={shape} />
      {children}
    </div>
  );
}

function TooltipRow({ color, shape, label, value }: { color: string; shape: SwatchShape; label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <Swatch color={color} shape={shape} />
      <span className="text-muted-foreground">{label}</span>
      <span className="ms-auto ps-3 font-medium">{value}</span>
    </span>
  );
}

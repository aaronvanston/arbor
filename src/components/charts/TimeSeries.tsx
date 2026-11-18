import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/utils';

/**
 * The live time series Machines draws (a machine's CPU, memory, network) and Compute's sandbox load chart. Shared so
 * both scroll, snap their hover and break at missing readings the same way.
 */

export type Series = { t: number; v: number | null }[];

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
export type HoverPoint = { t: number; values: (number | null)[] };

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

export function TimeSeries({
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
  bands = [],
  marks = [],
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
  /** Stretches of time to shade and name, such as readings that were never taken; they scroll with the lines. */
  bands?: { from: number; to: number; label: string }[];
  /** Moments to draw a line at and name, such as when a session ended; they scroll with the lines. */
  marks?: { at: number; label: string }[];
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
      {bands.map((band) => (
        <div
          key={band.from}
          className="absolute inset-y-0 flex justify-center overflow-hidden bg-muted/60 pt-1 text-2xs text-muted-foreground"
          style={{ left: `${(x(band.from) / CHART_W) * 100}%`, width: `${((x(band.to) - x(band.from)) / CHART_W) * 100}%` }}
          data-slot="time-series-band"
        >
          <span className="truncate px-1">{band.label}</span>
        </div>
      ))}
      {marks.map((mark) => (
        // The name of the line the svg below draws: under a band's name, and on the side with room, which is left of
        // the line once the line is near the right edge.
        <div key={mark.at} className="absolute top-5" style={{ left: `${(x(mark.at) / CHART_W) * 100}%` }} data-slot="time-series-mark">
          <span className={cn('absolute top-0 whitespace-nowrap text-2xs leading-4 text-muted-foreground', (anchor - mark.at) / windowMs < 0.3 ? 'right-1.5' : 'left-1.5')}>{mark.label}</span>
        </div>
      ))}
      <svg className="block h-full w-full overflow-visible" viewBox={`0 0 ${CHART_W} ${height}`} preserveAspectRatio="none" aria-hidden="true">
          {marks.map((mark) => (
            <line key={mark.at} x1={x(mark.at)} x2={x(mark.at)} y1="0" y2={height} stroke="var(--foreground)" strokeOpacity="0.4" strokeDasharray="3,3" vectorEffect="non-scaling-stroke" />
          ))}
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

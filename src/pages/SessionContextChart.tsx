import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useI18n } from '../i18n';
import { formatDateTime, formatMoney, formatTime, formatTokens } from '../lib/format';
import { cn } from '../lib/utils';
import { costTotal, type SessionEvent, type ThreadTimeline } from '../services/sessionTimeline';
import { isClientPointInsideRect, trendValueAxis } from '../services/usageTrend';

const PLOT_HEIGHT = 184;
const LANE_HEIGHT = 14;
// Keeps the top grid line and the peak clear of the panel edge.
const PAD_TOP = 8;

/** A horizontal line across the plot at a context size, like where long-context rates start. */
export type ContextReference = { value: number; label: string; tone: 'warning' | 'muted' };

type LaneKind = 'subagent' | 'failure' | 'change';

const LANE_COLOR: Record<LaneKind, string> = {
  subagent: 'text-chart-2',
  failure: 'text-error',
  change: 'text-info',
};

export const CONTEXT_COLOR = 'text-primary';
export const COMPACTION_COLOR = 'text-chart-6';
export const CACHE_MISS_COLOR = 'text-chart-5';
export const LANE_COLORS = LANE_COLOR;

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * The indices of the points to draw at a given width. A long thread has far more requests than pixels, so each
 * pixel column keeps only its highest and lowest points, in order, which keeps every peak and drop visible.
 */
export function chartPointIndices(contexts: number[], width: number): number[] {
  const count = contexts.length;
  const columns = Math.max(1, Math.floor(width));
  if (count <= columns * 2) return contexts.map((_, index) => index);
  const indices: number[] = [];
  let column = -1;
  let low = -1;
  let high = -1;
  const flush = () => {
    if (low < 0) return;
    if (low === high) indices.push(low);
    else indices.push(Math.min(low, high), Math.max(low, high));
  };
  contexts.forEach((context, index) => {
    const next = Math.floor((index / (count - 1)) * (columns - 1));
    if (next !== column) {
      flush();
      column = next;
      low = high = index;
      return;
    }
    if (context < contexts[low]!) low = index;
    if (context > contexts[high]!) high = index;
  });
  flush();
  return indices;
}

/**
 * A thread's context per request: the context line, compactions traced in orange, cache misses as
 * pink dots, and a lane underneath for subagents, failures and model or effort changes. The x axis steps through
 * the thread's requests rather than time, so long idle stretches don't flatten the work.
 */
export function SessionContextChart({
  thread,
  references,
  highlight,
  describeEvent,
}: {
  thread: ThreadTimeline;
  references: ContextReference[];
  /** A point picked outside the chart, like an event under the pointer in the events list. */
  highlight: number | null;
  describeEvent: (event: SessionEvent) => string;
}) {
  const { t } = useI18n();
  const { points, events } = thread;
  const count = points.length;
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [tooltipWidth, setTooltipWidth] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const [announce, setAnnounce] = useState(false);
  const summaryId = useId();
  const fillId = `session-context-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

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

  const hovering = hovered !== null;
  useEffect(() => {
    if (!hovering) return;
    // Re-rendered marks can swallow the plot's pointerleave, so any move outside it clears the tooltip.
    const onWindowPointerMove = (event: globalThis.PointerEvent) => {
      const plot = plotRef.current;
      if (!plot || !isClientPointInsideRect(event.clientX, event.clientY, plot.getBoundingClientRect())) setHovered(null);
    };
    window.addEventListener('pointermove', onWindowPointerMove);
    return () => window.removeEventListener('pointermove', onWindowPointerMove);
  }, [hovering]);

  // A thread that grew shorter on refresh drops a hover past its end.
  const active = hovered !== null && hovered < count ? hovered : highlight !== null && highlight < count ? highlight : null;

  const shown = references.filter((reference) => reference.value <= Math.max(thread.peak * 1.25, 1));
  const chart = useMemo(() => {
    if (!width || !count) return null;
    const axis = trendValueAxis(Math.max(thread.peak, ...shown.map((reference) => reference.value)), 4);
    const x = (index: number) => (count === 1 ? width / 2 : (index / (count - 1)) * width);
    const y = (value: number) => PAD_TOP + (1 - value / axis.max) * (PLOT_HEIGHT - PAD_TOP);
    const indices = chartPointIndices(points.map((point) => point.context), width);
    const line = indices.map((index, order) => `${order ? 'L' : 'M'}${round(x(index))},${round(y(points[index]!.context))}`).join('');
    const area = count > 1 ? `${line}L${round(x(indices[indices.length - 1]!))},${PLOT_HEIGHT}L${round(x(indices[0]!))},${PLOT_HEIGHT}Z` : '';
    return { axis, x, y, line, area };
    // Keyed on the shown values rather than `shown`, a new array every render; count follows points.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, width, thread.peak, shown.map((reference) => reference.value).join()]);

  const eventsAt = useMemo(() => {
    const byPoint = new Map<number, SessionEvent[]>();
    for (const event of events) {
      if (event.at < 0) continue;
      byPoint.set(event.at, [...(byPoint.get(event.at) ?? []), event]);
    }
    return byPoint;
  }, [events]);

  const axisLabels = useMemo(() => {
    if (!count) return [];
    const first = points[0]!.request.timestampMs;
    const last = points[count - 1]!.request.timestampMs;
    // Past most of a day, the time alone would be ambiguous.
    const withDate = last - first > 20 * 3_600_000;
    const slots = count === 1 ? [0] : [...new Set([0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(ratio * (count - 1))))];
    const labelWidth = withDate ? 110 : 64;
    return slots
      .filter((index, order) => order === 0 || order === slots.length - 1 || width >= labelWidth * slots.length)
      .map((index, order, kept) => ({
        index,
        label: withDate ? formatDateTime(points[index]!.request.timestampMs, { year: 'never' }) : formatTime(points[index]!.request.timestampMs),
        align: order === 0 && kept.length > 1 ? 'start' : order === kept.length - 1 && kept.length > 1 ? 'end' : 'center',
      }));
  }, [points, count, width]);

  // No deps on purpose: the tooltip's width follows its content, and setting the same width is a no-op.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const next = tooltipRef.current?.offsetWidth ?? 0;
    setTooltipWidth((current) => (current === next ? current : next));
  });

  if (!count) return null;

  const activePoint = active !== null ? points[active] : null;
  const activeX = chart && active !== null ? chart.x(active) : 0;
  let tooltipLeft = 0;
  if (activePoint) {
    const fitsRight = activeX + 12 + tooltipWidth <= width;
    const left = fitsRight || activeX < width / 2 ? activeX + 12 : activeX - 12 - tooltipWidth;
    tooltipLeft = Math.max(0, Math.min(Math.max(0, width - tooltipWidth), left));
  }

  const indexAt = (clientX: number, rect: DOMRect) => (count === 1 ? 0 : Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * (count - 1)));
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    setAnnounce(false);
    const next = indexAt(event.clientX, rect);
    setHovered((current) => (current === next ? current : next));
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = active ?? -1;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = current < 0 ? count - 1 : Math.max(0, current - 1);
    else if (event.key === 'ArrowRight') next = current < 0 ? 0 : Math.min(count - 1, current + 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else if (event.key === 'Escape' && hovering) {
      event.preventDefault();
      setHovered(null);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    setAnnounce(true);
    setHovered(next);
  };

  const laneEvents = events.filter((event): event is SessionEvent & { kind: LaneKind } => event.at >= 0 && (event.kind === 'subagent' || event.kind === 'failure' || event.kind === 'change'));
  const activeEvents = active !== null ? eventsAt.get(active) ?? [] : [];
  const pointTime = activePoint ? formatDateTime(activePoint.request.timestampMs, { seconds: true }) : '';

  return (
    <div className="flex gap-2">
      <div className="w-10 shrink-0 text-2xs leading-4 tabular-nums text-muted-foreground" aria-hidden="true">
        <div className="relative" style={{ height: PLOT_HEIGHT }}>
          {chart?.axis.ticks.map((tick) => (
            <span key={tick} className="absolute end-0 -translate-y-1/2" style={{ top: chart.y(tick) }}>
              {formatTokens(tick)}
            </span>
          ))}
        </div>
      </div>
      <div
        ref={plotRef}
        className="relative min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        tabIndex={0}
        role="group"
        aria-label={t('sessions.context.aria')}
        aria-describedby={summaryId}
        onPointerMove={handlePointerMove}
        onPointerLeave={(event) => {
          if (!isClientPointInsideRect(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())) setHovered(null);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => setHovered(null)}
        data-slot="session-context"
      >
        <svg className={cn('block w-full overflow-visible', CONTEXT_COLOR)} style={{ height: PLOT_HEIGHT + LANE_HEIGHT }} viewBox={`0 0 ${Math.max(width, 1)} ${PLOT_HEIGHT + LANE_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
          {chart ? (
            <>
              <defs>
                <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0.04" />
                </linearGradient>
              </defs>
              {chart.axis.ticks.map((tick) => (
                <line key={tick} x1={0} x2={width} y1={chart.y(tick)} y2={chart.y(tick)} stroke="var(--border)" strokeOpacity={tick ? 0.7 : 1} vectorEffect="non-scaling-stroke" />
              ))}
              {shown.map((reference) => (
                <g key={reference.label} className={reference.tone === 'warning' ? 'text-warning' : 'text-muted-foreground'}>
                  {reference.tone === 'warning' ? <rect x={0} y={PAD_TOP} width={width} height={Math.max(0, chart.y(reference.value) - PAD_TOP)} fill="currentColor" fillOpacity="0.06" /> : null}
                  <line x1={0} x2={width} y1={chart.y(reference.value)} y2={chart.y(reference.value)} stroke="currentColor" strokeOpacity="0.8" strokeDasharray="4,3" vectorEffect="non-scaling-stroke" />
                </g>
              ))}
              {events.map((event) =>
                event.kind === 'idle' && event.at > 0 ? (
                  <line key={`idle-${event.timestampMs}`} x1={chart.x(event.at) - 0.5} x2={chart.x(event.at) - 0.5} y1={PAD_TOP} y2={PLOT_HEIGHT} stroke="var(--muted-foreground)" strokeOpacity="0.45" strokeDasharray="2,3" vectorEffect="non-scaling-stroke" />
                ) : null,
              )}
              <g className={CONTEXT_COLOR}>
                {chart.area ? <path d={chart.area} fill={`url(#${fillId})`} /> : null}
                {count > 1 ? (
                  <path d={chart.line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                ) : (
                  <circle cx={chart.x(0)} cy={chart.y(points[0]!.context)} r="3" fill="currentColor" />
                )}
              </g>
              <g className={COMPACTION_COLOR}>
                {events.map((event) =>
                  // Only a drop the requests show can be traced; one only the transcript has is in the events list.
                  event.kind === 'compaction' && event.detected && event.at > 0 ? (
                    <line
                      key={`compaction-${event.timestampMs}`}
                      x1={chart.x(event.at - 1)}
                      x2={chart.x(event.at)}
                      y1={chart.y(event.before)}
                      y2={chart.y(event.after)}
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null,
                )}
              </g>
              <g className={CACHE_MISS_COLOR} fill="currentColor">
                {events.map((event) =>
                  event.kind === 'cacheMiss' ? <circle key={`miss-${event.timestampMs}`} cx={chart.x(event.at)} cy={chart.y(points[event.at]!.context)} r="3" stroke="var(--card)" strokeWidth="1" /> : null,
                )}
              </g>
              {laneEvents.map((event, order) => {
                const cx = chart.x(event.at);
                const top = PLOT_HEIGHT + 3;
                return (
                  <g key={`${event.kind}-${event.timestampMs}-${order}`} className={LANE_COLOR[event.kind]} fill="currentColor">
                    {event.kind === 'subagent' ? (
                      <path d={`M${round(cx)},${top}l4,8h-8z`} />
                    ) : event.kind === 'failure' ? (
                      <rect x={round(cx - 1)} y={top} width={2} height={9} rx={1} />
                    ) : (
                      <path d={`M${round(cx)},${top}l4,4.5l-4,4.5l-4,-4.5z`} />
                    )}
                  </g>
                );
              })}
              {activePoint ? (
                <>
                  <line x1={activeX} x2={activeX} y1={0} y2={PLOT_HEIGHT} stroke="var(--foreground)" strokeOpacity="0.35" strokeDasharray="2,2" vectorEffect="non-scaling-stroke" />
                  <circle className={CONTEXT_COLOR} cx={activeX} cy={chart.y(activePoint.context)} r="3.5" fill="currentColor" stroke="var(--card)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                </>
              ) : null}
            </>
          ) : null}
        </svg>
        {chart
          ? shown.map((reference) => (
              <span
                key={reference.label}
                className={cn('pointer-events-none absolute end-1 -translate-y-full pb-0.5 text-3xs font-medium', reference.tone === 'warning' ? 'text-warning-foreground' : 'text-muted-foreground')}
                style={{ top: chart.y(reference.value) }}
                aria-hidden="true"
              >
                {reference.label}
              </span>
            ))
          : null}
        <div className="relative mt-1 h-4 text-2xs leading-4 tabular-nums text-muted-foreground" aria-hidden="true">
          {chart
            ? axisLabels.map((label) => (
                <span
                  key={label.index}
                  className={cn('absolute top-0 whitespace-nowrap', label.align === 'center' && '-translate-x-1/2', label.align === 'end' && '-translate-x-full')}
                  style={{ left: chart.x(label.index) }}
                >
                  {label.label}
                </span>
              ))
            : null}
        </div>
        {activePoint ? (
          <div
            ref={tooltipRef}
            className="pointer-events-none absolute top-2 z-10 flex max-w-80 flex-col gap-0.5 rounded-md border border-border/70 bg-popover px-2 py-1 text-2xs leading-4 tabular-nums text-foreground shadow-md"
            style={{ left: tooltipLeft }}
            aria-hidden="true"
          >
            <span className="whitespace-nowrap text-muted-foreground">{t('sessions.context.tooltip.request', { index: active! + 1, time: pointTime })}</span>
            <TooltipRow label={t('sessions.context.tooltip.context')} value={formatTokens(activePoint.context)} />
            <TooltipRow label={t('sessions.context.tooltip.output')} value={formatTokens(activePoint.request.outputTokens)} />
            {activePoint.request.cost ? <TooltipRow label={t('sessions.context.tooltip.cost')} value={formatMoney(costTotal(activePoint.request.cost))} /> : null}
            <span className="whitespace-nowrap text-muted-foreground">
              {[activePoint.request.model, activePoint.request.reasoningEffort].filter(Boolean).join(' · ')}
            </span>
            {activeEvents.map((event, order) => (
              <span key={order} className="whitespace-normal font-sans text-foreground">{describeEvent(event)}</span>
            ))}
          </div>
        ) : null}
      </div>
      <p id={summaryId} className="sr-only">
        {t('sessions.context.summary', { peak: formatTokens(thread.peak), requests: count, compactions: thread.compactions })} {t('sessions.context.keyboardHint')}
      </p>
      <p className="sr-only" aria-live="polite">
        {announce && activePoint ? t('sessions.context.point', { index: active! + 1, time: pointTime, context: formatTokens(activePoint.context) }) : ''}
      </p>
    </div>
  );
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className="text-muted-foreground">{label}</span>
      <span className="ms-auto ps-3 font-medium">{value}</span>
    </span>
  );
}

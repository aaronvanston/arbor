import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useI18n } from '../i18n';
import { formatDate, formatDateTime, formatNumber } from '../lib/format';
import { cn } from '../lib/utils';
import {
  areaUnder, dayTicks, diamondPath, dryStretches, groupHours, heldValueAt, hourStarts, keyStep, lineValueAfter, markSpots, spotNear,
  stepLine, straightLine, type ChartScale,
} from '../services/forecastChart';
import type { Forecast } from '../services/limitForecast';
import { resetMarkLine } from '../services/resetKinds';
import { trendValueAxis } from '../services/usageTrend';

const HEIGHT = 168;
const PAD_TOP = 14;
const HOUR = 3_600_000;
/** Most bars the drain chart draws across its history; more hours than this are averaged together. */
const MOST_BARS = 96;
/** Keyboard steps across the chart. */
const KEY_STEPS = 48;
/** Marks closer together than this, in pixels, are drawn as one. */
const MARK_GAP = 10;
/** How near a mark the pointer reads it, in pixels. */
const MARK_REACH = 8;
/** A mark's diamond, from its middle to each tip. */
const MARK_SIZE = 5;
/** Most marks one readout spells out. */
const MOST_MARK_LINES = 3;

const round = (value: number) => Math.round(value * 100) / 100;
export const formatPoolPercent = (value: number) => `${formatNumber(Math.max(0, value))}%`;
const formatRatePercent = (value: number) => `${formatNumber(Math.max(0, value), value < 10 ? 1 : 0)}%`;

export type ForecastTab = 'remaining' | 'drain';

/**
 * The forecast chart. Remaining: the pool's history as a solid stepped line, the projection dashed, dry stretches
 * shaded, and a diamond where a reset was used: filled for one on record, hollow for a refill with none, fainter
 * for one the projection spends. Drain rate: what was spent each hour, with the rate the forecast expects ahead dashed.
 */
export function LimitForecastChart({ forecast, provider, tab, nowMs, startMs }: {
  forecast: Forecast;
  provider: string;
  tab: ForecastTab;
  nowMs: number;
  startMs: number;
}) {
  const { t } = useI18n();
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [announce, setAnnounce] = useState(false);
  const summaryId = useId();
  const fillId = `forecast-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const endMs = forecast.horizonEndMs;

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

  const chart = useMemo(() => {
    if (!width) return null;
    const x = (time: number) => ((time - startMs) / Math.max(1, endMs - startMs)) * width;
    if (tab === 'remaining') {
      const max = Math.max(100, forecast.capacity);
      const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => share * max);
      const y = (value: number) => PAD_TOP + (1 - Math.max(0, Math.min(max, value)) / max) * (HEIGHT - PAD_TOP);
      const scale: ChartScale = { x, y };
      const history = forecast.history.filter((point) => point.t >= startMs);
      const historyLine = stepLine(history, scale);
      const projection = forecast.projection.points;
      const projectionLine = straightLine(projection, scale);
      const spots = markSpots(forecast.marks, (mark) => {
        const value = mark.how === 'planned' ? lineValueAfter(projection, mark.atMs) : heldValueAt(history, mark.atMs);
        return value === null ? null : { x: x(mark.atMs), y: y(value) };
      }, MARK_GAP);
      return {
        kind: 'remaining' as const, ticks, y,
        historyLine, historyArea: areaUnder(historyLine, history, scale, HEIGHT),
        projectionLine, projectionArea: areaUnder(projectionLine, projection, scale, HEIGHT),
        dry: dryStretches(projection).map((stretch) => ({ left: x(stretch.from), right: x(stretch.to) })),
        spots,
        x,
      };
    }
    const historyHours = forecast.spend.hours.map((value, index) => ({ t: forecast.spend.startMs + index * HOUR, value }))
      .filter((hour) => hour.t + HOUR > startMs && hour.t < nowMs);
    const firstHour = historyHours[0];
    const bars = firstHour ? groupHours(historyHours.map((hour) => hour.value), firstHour.t, MOST_BARS) : [];
    const rates = hourStarts(nowMs, endMs).map((time) => ({ t: time, value: forecast.burn.rateAt(time) * HOUR }));
    const axis = trendValueAxis(Math.max(1, ...bars.map((bar) => bar.value), ...rates.map((rate) => rate.value)), 4);
    const y = (value: number) => PAD_TOP + (1 - Math.max(0, value) / axis.max) * (HEIGHT - PAD_TOP);
    const rateLine = [{ t: nowMs, value: forecast.burn.rateAt(nowMs) * HOUR }, ...rates]
      .map((rate, index) => `${index ? 'H' : 'M'}${round(x(rate.t))}${index ? `V${round(y(rate.value))}` : `,${round(y(rate.value))}`}`)
      .join('') + `H${round(x(endMs))}`;
    return {
      kind: 'drain' as const, ticks: axis.ticks, y,
      bars: bars.map((bar) => {
        const left = x(Math.max(startMs, bar.t));
        const right = x(Math.min(nowMs, bar.t + bar.spanMs));
        const top = y(bar.value);
        return { t: bar.t, spanMs: bar.spanMs, value: bar.value, left, width: Math.max(1, right - left - (right - left > 4 ? 1 : 0)), top };
      }),
      rateLine,
      x,
    };
  }, [width, tab, forecast, startMs, endMs, nowMs]);

  const days = useMemo(() => (width ? dayTicks(startMs, endMs, width) : []), [startMs, endMs, width]);

  const spots = chart?.kind === 'remaining' ? chart.spots : [];

  // What the pointer, or the keyboard, is reading: the held reading before now, the projection after. Near a mark it
  // reads the mark: the pool just after the refill, and what the refill was.
  const readout = (() => {
    if (hover === null || !chart) return null;
    const pointed = startMs + hover * (endMs - startMs);
    if (chart.kind === 'remaining') {
      const spot = spotNear(chart.spots, chart.x(pointed), MARK_REACH);
      const time = spot ? spot.lead.atMs : pointed;
      const past = spot ? spot.lead.how !== 'planned' : time <= nowMs;
      const value = past ? heldValueAt(forecast.history, time) : lineValueAfter(forecast.projection.points, time);
      if (value === null) return null;
      const said = spot ? [spot.lead, ...spot.marks.filter((mark) => mark !== spot.lead)] : [];
      const more = said.length - MOST_MARK_LINES;
      const lines = [
        ...said.slice(0, MOST_MARK_LINES).map((mark) => resetMarkLine(t, mark, Math.round(mark.gain) >= 1 ? formatPoolPercent(Math.round(mark.gain)) : null)),
        ...(more > 0 ? [more === 1 ? t('forecast.mark.more.one') : t('forecast.mark.more.other', { count: more })] : []),
      ];
      return { time, x: chart.x(time), y: chart.y(value), spot, lines, text: t(past ? 'forecast.chart.point' : 'forecast.chart.pointProjected', { time: formatDateTime(time, { now: nowMs, weekday: 'short' }), value: formatPoolPercent(value) }) };
    }
    const time = pointed;
    const bar = chart.bars.find((item) => time >= item.t && time < item.t + item.spanMs);
    const value = time > nowMs ? forecast.burn.rateAt(time) * HOUR : bar?.value;
    if (value === undefined) return null;
    return { time, x: chart.x(time), y: chart.y(value), spot: null, lines: [], text: t('forecast.chart.pointRate', { time: formatDateTime(time, { now: nowMs, weekday: 'short' }), value: formatRatePercent(value) }) };
  })();

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    setAnnounce(false);
    setHover(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // On a narrow chart a step is shorter than a mark's reach, and one from a mark would read the same mark again.
    const step = Math.max(1 / KEY_STEPS, (MARK_REACH + 1) / Math.max(1, width));
    const nowRatio = (nowMs - startMs) / Math.max(1, endMs - startMs);
    // The arrows stop at a mark on their way, since most fall between two steps. A step that lands within reach of
    // one already reads it, so the next press goes on from the mark.
    const share = (atMs: number) => (atMs - startMs) / Math.max(1, endMs - startMs);
    const stops = spots.map((spot) => share(spot.lead.atMs));
    const from = readout?.spot ? share(readout.spot.lead.atMs) : hover;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = from === null ? nowRatio : keyStep(from, -step, stops);
    else if (event.key === 'ArrowRight') next = from === null ? nowRatio : keyStep(from, step, stops);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = 1;
    else if (event.key === 'Escape' && hover !== null) {
      event.preventDefault();
      setHover(null);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    setAnnounce(true);
    setHover(next);
  };

  const nowX = chart ? chart.x(nowMs) : 0;
  // A readout that names a refill is wider, so the line about it fits on one line for most account names.
  const tooltipWidth = readout?.lines.length ? 280 : 180;
  const tooltipLeft = readout ? Math.max(0, Math.min(width - tooltipWidth, readout.x + (readout.x > width / 2 ? -(tooltipWidth + 8) : 8))) : 0;

  return (
    <div className="flex gap-2">
      <div className="relative w-10 shrink-0 text-2xs leading-4 tabular-nums text-muted-foreground" style={{ height: HEIGHT }} aria-hidden="true">
        {chart?.ticks.map((tick) => (
          <span key={tick} className="absolute end-0 -translate-y-1/2" style={{ top: chart.y(tick) }}>
            {chart.kind === 'remaining' ? formatPoolPercent(tick) : formatRatePercent(tick)}
          </span>
        ))}
      </div>
      <div
        ref={plotRef}
        className="relative min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        tabIndex={0}
        role="group"
        aria-label={t(tab === 'remaining' ? 'forecast.chart.aria' : 'forecast.chart.drainAria', { provider })}
        aria-describedby={summaryId}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setHover(null)}
        data-slot="limit-forecast-chart"
      >
        <svg className="block w-full text-primary" style={{ height: HEIGHT }} viewBox={`0 0 ${Math.max(width, 1)} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
          {chart ? (
            <>
              <defs>
                <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.24" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              {chart.ticks.map((tick) => (
                <line key={tick} x1={0} x2={width} y1={chart.y(tick)} y2={chart.y(tick)} stroke="var(--border)" strokeOpacity={tick ? 0.7 : 1} vectorEffect="non-scaling-stroke" />
              ))}
              {chart.kind === 'remaining' ? (
                <>
                  {chart.dry.map((stretch) => (
                    <rect key={stretch.left} x={stretch.left} y={PAD_TOP} width={Math.max(1, stretch.right - stretch.left)} height={HEIGHT - PAD_TOP} fill="var(--destructive)" fillOpacity="0.1" />
                  ))}
                  {chart.projectionArea ? <path d={chart.projectionArea} fill={`url(#${fillId})`} opacity="0.5" /> : null}
                  {chart.historyArea ? <path d={chart.historyArea} fill={`url(#${fillId})`} /> : null}
                  {chart.projectionLine ? (
                    <path d={chart.projectionLine} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="5,4" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                  ) : null}
                  {chart.historyLine ? (
                    <path d={chart.historyLine} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                  ) : null}
                  {chart.spots.map((spot) => (
                    <path
                      key={`${spot.lead.atMs}:${spot.lead.key}`}
                      d={diamondPath(spot.x, spot.y, MARK_SIZE)}
                      fill={spot.lead.how === 'early' ? 'var(--card)' : 'currentColor'}
                      stroke={spot.lead.how === 'early' ? 'currentColor' : 'var(--card)'}
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                      opacity={spot.lead.how === 'planned' ? 0.6 : undefined}
                      vectorEffect="non-scaling-stroke"
                      data-mark={spot.lead.how}
                    />
                  ))}
                </>
              ) : (
                <>
                  <g fill="currentColor" fillOpacity="0.75">
                    {chart.bars.map((bar) => (
                      bar.value > 0 ? <rect key={bar.t} x={bar.left} y={bar.top} width={bar.width} height={Math.max(1, HEIGHT - bar.top)} rx="1" /> : null
                    ))}
                  </g>
                  <path d={chart.rateLine} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="5,4" vectorEffect="non-scaling-stroke" />
                </>
              )}
              <line x1={nowX} x2={nowX} y1={0} y2={HEIGHT} stroke="var(--foreground)" strokeOpacity="0.45" strokeDasharray="2,3" vectorEffect="non-scaling-stroke" />
              {readout ? (
                <>
                  <line x1={readout.x} x2={readout.x} y1={0} y2={HEIGHT} stroke="var(--foreground)" strokeOpacity="0.3" strokeDasharray="2,2" vectorEffect="non-scaling-stroke" />
                  {readout.spot ? (
                    <path d={diamondPath(readout.x, readout.y, MARK_SIZE + 3.5)} fill="none" stroke="currentColor" strokeOpacity="0.55" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                  ) : (
                    <circle cx={readout.x} cy={readout.y} r="3" fill="currentColor" stroke="var(--card)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                  )}
                </>
              ) : null}
            </>
          ) : null}
        </svg>
        <span className="pointer-events-none absolute top-0 text-2xs leading-4 text-muted-foreground" style={{ left: nowX + 4 }} aria-hidden="true">
          {t('forecast.now')}
        </span>
        {chart?.kind === 'remaining' && chart.dry[0] ? (
          <span
            className="pointer-events-none absolute text-2xs font-medium leading-4 text-error-foreground"
            style={{ left: chart.dry[0].left + 4, top: PAD_TOP + 2 }}
            aria-hidden="true"
          >
            {t('forecast.dryBand')}
          </span>
        ) : null}
        <div className="relative mt-1 h-4 text-2xs leading-4 tabular-nums text-muted-foreground" aria-hidden="true">
          {days.map((day) => (
            <span key={day} className="absolute top-0 -translate-x-1/2 whitespace-nowrap" style={{ left: chart ? chart.x(day) : 0 }}>
              {formatDate(day, { now: nowMs, year: 'never' })}
            </span>
          ))}
        </div>
        {readout ? (
          <div
            className={cn('pointer-events-none absolute top-5 z-10 flex flex-col gap-0.5 whitespace-normal rounded-md border border-border/70 bg-popover px-2 py-1 text-2xs leading-4 tabular-nums text-foreground shadow-md')}
            style={{ left: tooltipLeft, width: tooltipWidth }}
            aria-hidden="true"
          >
            <span className={readout.lines.length ? 'text-muted-foreground' : undefined}>{readout.text}</span>
            {readout.lines.map((line, index) => <span key={index}>{line}</span>)}
          </div>
        ) : null}
      </div>
      <p id={summaryId} className="sr-only">
        {t('forecast.chart.keyboardHint')}
        {spots.length ? ` ${spots.length === 1 ? t('forecast.chart.marked.one') : t('forecast.chart.marked.other', { count: spots.length })}` : ''}
      </p>
      <p className="sr-only" aria-live="polite">{announce && readout ? [readout.text, ...readout.lines].join('. ') : ''}</p>
    </div>
  );
}

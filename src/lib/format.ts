import { translate } from '../i18n';

/**
 * Every date, time, number and dollar amount the app shows goes through here, written the way the
 * Mac's region has them (day before month in Australia, the 12- or 24-hour clock the user picked).
 * The interface text itself stays English: only formatting follows the region.
 */

export type HourCycle = 'h12' | 'h23';
export type FormatRegion = { locale: string; hourCycle: HourCycle };
export type DateInput = Date | number | string;

const FALLBACK_LOCALE = 'en-US';

const canonicalLocale = (value: string | null | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
};

const browserLocale = (): string =>
  canonicalLocale(typeof navigator === 'undefined' ? undefined : navigator.language)
  ?? canonicalLocale(new Intl.DateTimeFormat().resolvedOptions().locale)
  ?? FALLBACK_LOCALE;

/** The clock a locale uses when nobody said otherwise. */
const defaultHourCycle = (locale: string): HourCycle => {
  // TypeScript's ES2020 lib leaves hourCycle off the resolved options, though every engine we run on has it.
  const { hourCycle: cycle } = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions() as { hourCycle?: string };
  return cycle === 'h23' || cycle === 'h24' ? 'h23' : 'h12';
};

/** A region from what the Mac (or the web view) reports, falling back to the web view's language. */
export function formatRegion(locale?: string | null, hourCycle?: string | null): FormatRegion {
  const tag = canonicalLocale(locale) ?? browserLocale();
  return { locale: tag, hourCycle: hourCycle === 'h12' || hourCycle === 'h23' ? hourCycle : defaultHourCycle(tag) };
}

let region: FormatRegion = formatRegion();

export const getFormatRegion = (): FormatRegion => region;

/** Set once at startup from the Mac's region; tests set it to pin a locale. */
export function setFormatRegion(next: FormatRegion): void {
  region = formatRegion(next.locale, next.hourCycle);
}

// Building an Intl formatter is slow next to using one, and tables format hundreds of cells.
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

const dateFormat = (options: Intl.DateTimeFormatOptions, place: FormatRegion) => {
  const resolved: Intl.DateTimeFormatOptions = options.hour ? { ...options, hourCycle: place.hourCycle } : options;
  const key = `${place.locale}|${JSON.stringify(resolved)}`;
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(place.locale, resolved);
    dateFormats.set(key, format);
  }
  return format;
};

/** Any other date shape (chart axes, month names), still in the region and on its clock. */
export function formatDateWith(value: DateInput, options: Intl.DateTimeFormatOptions, place: FormatRegion = region): string {
  const date = toDate(value);
  return date ? dateFormat(options, place).format(date) : '—';
}

const numberFormat = (options: Intl.NumberFormatOptions, place: FormatRegion) => {
  const key = `${place.locale}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(place.locale, options);
    numberFormats.set(key, format);
  }
  return format;
};

const toDate = (value: DateInput): Date | undefined => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
};

type DateOptions = {
  region?: FormatRegion;
  /** Decides whether the year is worth showing; defaults to the current time. */
  now?: number;
  /** 'auto' shows the year only when it isn't this year; chart axes say 'never'. */
  year?: 'auto' | 'always' | 'never';
  weekday?: 'short' | 'long';
  month?: 'short' | 'long';
};

/** Day and month, with the year only when it isn't this one: "29 Sep", "29 Sep 2025". */
export function formatDate(value: DateInput, options: DateOptions = {}): string {
  const date = toDate(value);
  if (!date) return '—';
  const showYear = options.year === 'always'
    || (options.year !== 'never' && date.getFullYear() !== new Date(options.now ?? Date.now()).getFullYear());
  return formatDateWith(date, {
    ...(options.weekday ? { weekday: options.weekday } : {}),
    day: 'numeric',
    month: options.month ?? 'short',
    ...(showYear ? { year: 'numeric' } : {}),
  }, options.region);
}

// TypeScript's ES2020 lib doesn't know formatRange yet; every engine the app runs in has it.
type RangeFormat = Intl.DateTimeFormat & { formatRange?: (start: Date, end: Date) => string };

/** Two days as one range, the way the region writes it: "15 – 21 Sep", "28 Sep – 4 Oct". */
export function formatDateRange(start: DateInput, end: DateInput, options: Pick<DateOptions, 'region' | 'now'> = {}): string {
  const from = toDate(start);
  const to = toDate(end);
  if (!from || !to) return '—';
  const year = new Date(options.now ?? Date.now()).getFullYear();
  const showYear = from.getFullYear() !== year || to.getFullYear() !== year;
  const format: RangeFormat = dateFormat({ day: 'numeric', month: 'short', ...(showYear ? { year: 'numeric' } : {}) }, options.region ?? region);
  // ICU puts thin spaces around the dash; plain ones match every other range the app writes.
  if (format.formatRange) return format.formatRange(from, to).replace(/\s–\s/g, ' – ');
  return from.toDateString() === to.toDateString() ? format.format(from) : `${format.format(from)} – ${format.format(to)}`;
}

type TimeOptions = { region?: FormatRegion; seconds?: boolean };

/** The time on the region's clock: "5:36 pm" or "17:36". */
export function formatTime(value: DateInput, options: TimeOptions = {}): string {
  return formatDateWith(value, { hour: 'numeric', minute: '2-digit', ...(options.seconds ? { second: '2-digit' } : {}) }, options.region);
}

/** "29 Sep, 5:36 pm", with the year when it isn't this one. */
export function formatDateTime(value: DateInput, options: DateOptions & TimeOptions = {}): string {
  const date = toDate(value);
  if (!date) return '—';
  return `${formatDate(date, options)}, ${formatTime(date, options)}`;
}

/** Just the time for something from today, the date and time before that: "5:36 pm", "28 Sep, 5:36 pm". */
export function formatWhen(value: DateInput, options: DateOptions & TimeOptions = {}): string {
  const date = toDate(value);
  if (!date) return '—';
  const today = date.toDateString() === new Date(options.now ?? Date.now()).toDateString();
  return today ? formatTime(date, options) : formatDateTime(date, options);
}

const text = (key: Parameters<typeof translate>[0], variables?: Parameters<typeof translate>[1]) =>
  translate(key, variables);

/**
 * How long something took or has left: "45s", "12m", "1h 34m", "4d 0h". Rounding 'up' is for
 * countdowns, so a reset 30 seconds away reads "1m" rather than "0m" or seconds.
 */
export function formatDuration(durationMs: number, rounding: 'down' | 'up' = 'down'): string {
  const ms = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  let minutes: number;
  if (rounding === 'up') {
    minutes = Math.ceil(ms / 60_000);
  } else {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return text('format.span.seconds', { seconds });
    minutes = Math.floor(seconds / 60);
  }
  if (minutes < 60) return text('format.span.minutes', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return text('format.span.hoursMinutes', { hours, minutes: minutes % 60 });
  return text('format.span.daysHours', { days: Math.floor(hours / 24), hours: hours % 24 });
}

/**
 * How long a call took, finer than formatDuration where it counts: "340 ms", "2.4s", "12s", "1m 5s", then as
 * formatDuration past an hour.
 */
export function formatElapsed(durationMs: number, place: FormatRegion = region): string {
  const ms = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  if (ms < 1_000) return text('format.span.milliseconds', { ms: Math.round(ms) });
  // Tenths up to ten seconds, and whole seconds from there, so 9.96s reads "10s" rather than "10.0s".
  if (ms < 9_950) return text('format.span.seconds', { seconds: formatNumber(ms / 1_000, 1, place) });
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return text('format.span.seconds', { seconds });
  if (seconds < 3_600) return text('format.span.minutesSeconds', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
  return formatDuration(ms);
}

/**
 * "in 2h" or "3m ago" in the largest whole unit, rounded down so 36 hours reads as a day rather
 * than two. Anything from the last minute is "just now"; anything coming is at least "in 1m".
 */
export function formatRelative(value: DateInput, nowMs = Date.now()): string {
  const date = toDate(value);
  if (!date) return '—';
  const delta = date.getTime() - nowMs;
  if (delta <= 0 && delta > -60_000) return text('common.justNow');
  const minutes = Math.max(1, Math.floor(Math.abs(delta) / 60_000));
  const span = minutes >= 1440 ? text('format.span.days', { days: Math.floor(minutes / 1440) })
    : minutes >= 60 ? text('format.span.hours', { hours: Math.floor(minutes / 60) })
      : text('format.span.minutes', { minutes });
  return text(delta > 0 ? 'format.relative.future' : 'format.relative.past', { span });
}

/**
 * formatRelative for something that has already happened. It can still land a little after `nowMs`, when a scan
 * finishes after a page's last clock tick or another machine's clock runs fast, and then reads "just now", not "in 1m".
 */
export function formatAgo(value: DateInput, nowMs = Date.now()): string {
  const date = toDate(value);
  return formatRelative(date ? Math.min(date.getTime(), nowMs) : value, nowMs);
}

/** Shown in place of a dollar amount when no price was known, so it doesn't read as free. */
export const formatUnpriced = () => text('format.unpriced');

/**
 * US dollars to the cent, with just enough more places under a dollar to show two significant
 * figures: "$30.97", "$0.93", "$0.0042". Null or NaN means the cost isn't known and says "unpriced".
 */
export function formatMoney(amount: number | null | undefined, place: FormatRegion = region): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return formatUnpriced();
  const size = Math.abs(amount);
  const places = size > 0 && size < 1 ? Math.min(8, Math.max(2, 1 - Math.floor(Math.log10(size)))) : 2;
  // No minus sign on an amount that rounds to nothing.
  const sign = amount < 0 && Number(size.toFixed(places)) > 0 ? '-' : '';
  return `${sign}$${numberFormat({ minimumFractionDigits: 2, maximumFractionDigits: places }, place).format(size)}`;
}

/** A plain number with the region's grouping: "1,234,567". */
export function formatNumber(value: number, maximumFractionDigits = 0, place: FormatRegion = region): string {
  return numberFormat({ maximumFractionDigits }, place).format(Number.isFinite(value) ? value : 0);
}

const MILLION = 1_000_000;
const BILLION = 1_000_000_000;

/** A count that stays exact below a million and shortens after: "999,999", "12.3M", "1.3B". */
export function formatCount(value: number, place: FormatRegion = region): string {
  const amount = Number.isFinite(value) ? value : 0;
  const size = Math.abs(amount);
  const roundedMillions = Math.round((size / MILLION) * 10) / 10;
  const billions = size >= BILLION || roundedMillions >= 1_000;
  const divisor = billions ? BILLION : size >= MILLION ? MILLION : 1;
  const unit = billions ? 'B' : size >= MILLION ? 'M' : '';
  return `${numberFormat({ maximumFractionDigits: divisor === 1 ? 0 : 1 }, place).format(amount / divisor)}${unit}`;
}

/** Tokens in the short form context sizes and chart axes use: "950", "628.3K", "3M". */
export function formatTokens(value: number, place: FormatRegion = region): string {
  return numberFormat({ notation: 'compact', maximumFractionDigits: 1 }, place).format(Number.isFinite(value) ? value : 0);
}

/** A share from 0 to 1 as a percentage: "42%". */
export function formatPercent(share: number, maximumFractionDigits = 0, place: FormatRegion = region): string {
  return numberFormat({ style: 'percent', maximumFractionDigits }, place).format(Number.isFinite(share) ? share : 0);
}

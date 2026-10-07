import { afterAll, describe, expect, it } from 'bun:test';
import {
  formatAgo,
  formatCount,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatDateWith,
  formatDuration,
  formatElapsed,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRate,
  formatRegion,
  formatRelative,
  formatTime,
  formatTokens,
  formatUnpriced,
  formatWhen,
  getFormatRegion,
  setFormatRegion,
  type FormatRegion,
} from '../src/lib/format';
import { macDates } from './support/macDates';

const AU12: FormatRegion = { locale: 'en-AU', hourCycle: 'h12' };
const AU24: FormatRegion = { locale: 'en-AU', hourCycle: 'h23' };
const US: FormatRegion = { locale: 'en-US', hourCycle: 'h12' };

// ICU puts a narrow or thin no-break space around AM/PM and range dashes in some versions.
const plain = (text: string) => macDates(text.replace(/\s+/g, ' '));

const NOW = new Date(2026, 8, 30, 12).getTime();
const EVENING = new Date(2026, 8, 29, 17, 36, 7);
const LAST_YEAR = new Date(2025, 8, 29, 17, 36);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('dates in the region', () => {
  it('puts the day first in Australia and leaves the year off for this year', () => {
    expect(plain(formatDate(EVENING, { region: AU12, now: NOW }))).toBe('29 Sep');
    expect(plain(formatDate(LAST_YEAR, { region: AU12, now: NOW }))).toBe('29 Sep 2025');
    expect(plain(formatDate(EVENING, { region: AU12, now: NOW, year: 'always' }))).toBe('29 Sep 2026');
    expect(plain(formatDate(LAST_YEAR, { region: AU12, now: NOW, year: 'never' }))).toBe('29 Sep');
    expect(plain(formatDate(EVENING, { region: US, now: NOW }))).toBe('Sep 29');
    expect(plain(formatDate(LAST_YEAR, { region: US, now: NOW }))).toBe('Sep 29, 2025');
  });

  it('writes the time on the clock the user picked', () => {
    expect(plain(formatTime(EVENING, { region: AU12 }))).toBe('5:36 pm');
    expect(formatTime(EVENING, { region: AU24 })).toBe('17:36');
    expect(plain(formatTime(EVENING, { region: US }))).toBe('5:36 PM');
    expect(plain(formatTime(new Date(2026, 0, 1, 0, 5), { region: AU12 }))).toBe('12:05 am');
    expect(formatTime(new Date(2026, 0, 1, 0, 5), { region: AU24 })).toBe('00:05');
    expect(plain(formatTime(EVENING, { region: AU12, seconds: true }))).toBe('5:36:07 pm');
    expect(formatTime(EVENING, { region: AU24, seconds: true })).toBe('17:36:07');
  });

  it('joins the date and time with a comma, never in US order in Australia', () => {
    expect(plain(formatDateTime(EVENING, { region: AU12, now: NOW }))).toBe('29 Sep, 5:36 pm');
    expect(plain(formatDateTime(EVENING, { region: AU24, now: NOW }))).toBe('29 Sep, 17:36');
    expect(plain(formatDateTime(EVENING, { region: US, now: NOW }))).toBe('Sep 29, 5:36 PM');
    expect(plain(formatDateTime(LAST_YEAR, { region: AU12, now: NOW }))).toBe('29 Sep 2025, 5:36 pm');
  });

  it('shows just the time for today and the date too before that', () => {
    const lunch = new Date(2026, 8, 30, 12, 30);
    expect(plain(formatWhen(lunch, { region: AU12, now: NOW }))).toBe('12:30 pm');
    expect(plain(formatWhen(lunch, { region: AU24, now: NOW }))).toBe('12:30');
    expect(plain(formatWhen(EVENING, { region: AU12, now: NOW }))).toBe('29 Sep, 5:36 pm');
  });

  it('writes a range of days the way the region does', () => {
    expect(plain(formatDateRange(new Date(2026, 8, 15), new Date(2026, 8, 21), { region: AU12, now: NOW }))).toBe('15 – 21 Sep');
    expect(plain(formatDateRange(new Date(2026, 8, 28), new Date(2026, 9, 4), { region: AU12, now: NOW }))).toBe('28 Sep – 4 Oct');
    expect(plain(formatDateRange(new Date(2026, 8, 21, 9), new Date(2026, 8, 21, 17), { region: AU12, now: NOW }))).toBe('21 Sep');
    expect(plain(formatDateRange(new Date(2025, 11, 29), new Date(2026, 0, 4), { region: AU12, now: NOW }))).toBe('29 Dec 2025 – 4 Jan 2026');
    expect(plain(formatDateRange(new Date(2026, 8, 15), new Date(2026, 8, 21), { region: US, now: NOW }))).toBe('Sep 15 – 21');
  });

  it('keeps other shapes in the region and on its clock', () => {
    expect(formatDateWith(EVENING, { month: 'long', year: 'numeric' }, AU12)).toBe('September 2026');
    expect(formatDateWith(EVENING, { hour: 'numeric' }, AU24)).toBe('17');
    expect(plain(formatDate(new Date(2026, 8, 28), { region: AU12, weekday: 'long', month: 'long', now: NOW }))).toBe('Monday 28 September');
    expect(plain(formatDate(new Date(2026, 8, 28), { region: US, weekday: 'long', month: 'long', now: NOW }))).toBe('Monday, September 28');
  });

  it('says a dash for a date it cannot read', () => {
    expect(plain(formatDate('not a date', { region: AU12 }))).toBe('—');
    expect(plain(formatDateTime(Number.NaN, { region: AU12 }))).toBe('—');
    expect(formatTime('', { region: AU12 })).toBe('—');
  });
});

describe('relative times and durations', () => {
  it('says how far off something is in its largest whole unit', () => {
    expect(formatRelative(NOW - 30_000, NOW)).toBe('just now');
    expect(formatRelative(NOW - 3 * MINUTE, NOW)).toBe('3m ago');
    expect(formatRelative(NOW - 3 * HOUR, NOW)).toBe('3h ago');
    expect(formatRelative(NOW - 2 * DAY, NOW)).toBe('2d ago');
    expect(formatRelative(NOW + 30_000, NOW)).toBe('in 1m');
    expect(formatRelative(NOW + 2 * HOUR + 5 * MINUTE, NOW)).toBe('in 2h');
    // Rounded down, so 36 hours reads as a day rather than two.
    expect(formatRelative(NOW + 36 * HOUR, NOW)).toBe('in 1d');
    expect(formatRelative(NOW + DAY - 1, NOW)).toBe('in 23h');
  });

  it('never puts something that already happened in the future', () => {
    expect(formatAgo(NOW - 3 * MINUTE, NOW)).toBe('3m ago');
    // A scan that finished after the page's last tick, or a machine whose clock runs fast.
    expect(formatAgo(NOW + 400, NOW)).toBe('just now');
    expect(formatAgo(NOW + 2 * MINUTE, NOW)).toBe('just now');
    expect(formatAgo(Number.NaN, NOW)).toBe('—');
  });

  it('says how long something took in up to two units', () => {
    expect(formatDuration(44_600)).toBe('45s');
    expect(formatDuration(12 * MINUTE + 20_000)).toBe('12m');
    expect(formatDuration(94 * MINUTE)).toBe('1h 34m');
    expect(formatDuration(4 * DAY)).toBe('4d 0h');
    expect(formatDuration(-5)).toBe('0s');
  });

  it('says how long a call took down to the millisecond', () => {
    expect(formatElapsed(0)).toBe('0 ms');
    expect(formatElapsed(340.4)).toBe('340 ms');
    expect(formatElapsed(2_449, AU12)).toBe('2.4s');
    expect(formatElapsed(9_960, AU12)).toBe('10s');
    expect(formatElapsed(12_300)).toBe('12s');
    expect(formatElapsed(65_000)).toBe('1m 5s');
    expect(formatElapsed(94 * MINUTE)).toBe('1h 34m');
    expect(formatElapsed(Number.NaN)).toBe('0 ms');
  });

  it('rounds a countdown up so what is left never reads as nothing', () => {
    expect(formatDuration(30_000, 'up')).toBe('1m');
    expect(formatDuration(5 * MINUTE, 'up')).toBe('5m');
    expect(formatDuration(59 * MINUTE + 30_000, 'up')).toBe('1h 0m');
    expect(formatDuration(2 * DAY + 5 * HOUR, 'up')).toBe('2d 5h');
  });
});

describe('money', () => {
  it('shows cents, and just enough more places under a dollar for two significant figures', () => {
    for (const region of [AU12, US]) {
      expect(formatMoney(30.971, region)).toBe('$30.97');
      expect(formatMoney(12.096, region)).toBe('$12.10');
      expect(formatMoney(1234.5, region)).toBe('$1,234.50');
      expect(formatMoney(0.9324, region)).toBe('$0.93');
      expect(formatMoney(0.123456, region)).toBe('$0.12');
      expect(formatMoney(0.05, region)).toBe('$0.05');
      expect(formatMoney(0.0042, region)).toBe('$0.0042');
      expect(formatMoney(0.00123456, region)).toBe('$0.0012');
      expect(formatMoney(0, region)).toBe('$0.00');
    }
  });

  it('keeps the sign of a refund but not of an amount that rounds to nothing', () => {
    expect(formatMoney(-1.5, AU12)).toBe('-$1.50');
    expect(formatMoney(-1e-12, AU12)).toBe('$0.00');
  });

  it('says unpriced when the cost is not known rather than $0.00', () => {
    expect(formatUnpriced()).toBe('unpriced');
    expect(formatMoney(null, AU12)).toBe('unpriced');
    expect(formatMoney(undefined, AU12)).toBe('unpriced');
    expect(formatMoney(Number.NaN, AU12)).toBe('unpriced');
  });
});

describe('numbers', () => {
  it('groups plain numbers and shortens counts past a million', () => {
    expect(formatNumber(1_234_567, 0, AU12)).toBe('1,234,567');
    expect(formatNumber(1.25, 3, AU12)).toBe('1.25');
    expect(formatCount(999_999, AU12)).toBe('999,999');
    expect(formatCount(1_000_000, AU12)).toBe('1M');
    expect(formatCount(12_340_000, AU12)).toBe('12.3M');
    expect(formatCount(999_949_999, AU12)).toBe('999.9M');
    expect(formatCount(999_950_000, AU12)).toBe('1B');
    expect(formatCount(1_250_000_000, AU12)).toBe('1.3B');
    expect(formatCount(Number.NaN, AU12)).toBe('0');
  });

  it('writes tokens in the short form context sizes use', () => {
    expect(formatTokens(0, AU12)).toBe('0');
    expect(formatTokens(950, AU12)).toBe('950');
    expect(formatTokens(12_000, AU12)).toBe('12K');
    expect(formatTokens(628_300, AU12)).toBe('628.3K');
    expect(formatTokens(1_500_000, AU12)).toBe('1.5M');
    expect(formatTokens(3_000_000, US)).toBe('3M');
  });

  it('writes shares as percentages', () => {
    expect(formatPercent(0.42, 0, AU12)).toBe('42%');
    expect(formatRate(0.4234)).toBe('42.3%');
    expect(formatRate(0)).toBe('0.0%');
    // Nothing to measure a rate from is no rate, not 0%.
    expect(formatRate(null)).toBe('—');
    expect(formatPercent(0.0125, 1, AU12)).toBe('1.3%');
  });
});

describe('the region setting', () => {
  const before = getFormatRegion();
  afterAll(() => setFormatRegion(before));

  it('takes the clock from the Mac, or the locale default without one', () => {
    expect(formatRegion('en-AU', 'h23')).toEqual(AU24);
    expect(formatRegion('en-AU')).toEqual(AU12);
    expect(formatRegion('en-GB').hourCycle).toBe('h23');
    expect(formatRegion('en-US', 'nonsense')).toEqual(US);
  });

  it('falls back to the web view for a tag it cannot read', () => {
    expect(formatRegion('not a locale!').locale).not.toBe('not a locale!');
  });

  it('is what the formatters use when not told otherwise', () => {
    setFormatRegion(AU24);
    expect(getFormatRegion()).toEqual(AU24);
    expect(plain(formatDateTime(EVENING, { now: NOW }))).toBe('29 Sep, 17:36');
    setFormatRegion(US);
    expect(plain(formatDateTime(EVENING, { now: NOW }))).toBe('Sep 29, 5:36 PM');
  });
});

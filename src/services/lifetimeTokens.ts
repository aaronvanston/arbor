import { invokeCommand } from '../native/commands';
import type { LifetimeTokens, RecoveredDay } from '../native/types';
import type { TrendInputPoint } from './usageTrend';

/**
 * Every token the session archive has counted in the transcripts it keeps. Each call counts
 * once, by the id its agent gave it, however many copies of it the archive holds. Only
 * counts, days, machines, homes and model names come back, never what a session said.
 */
export type TokenCounts = {
  calls: number;
  /** Input read fresh, not from the cache. */
  input: number;
  cacheWrite: number;
  cacheRead: number;
  /** Includes reasoning. */
  output: number;
  reasoning: number;
};

export type LifetimeMonth = TokenCounts & {
  /** yyyy-mm, in local time. */
  month: string;
  machine: string;
  /** The agent home the session was first seen in, with the home folder as `~`. */
  home: string;
  agent: string;
  /** Empty when the transcript didn't name one. */
  model: string;
};

export type LifetimeDay = TokenCounts & {
  /** yyyy-mm-dd, in local time. */
  day: string;
};

export const getLifetimeTokens = () => invokeCommand('get_lifetime_tokens');

export const emptyCounts = (): TokenCounts => ({ calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 });

/** Every token a call used: fresh input, cache writes and reads, and output. Reasoning is part of output. */
export const tokenTotal = (counts: TokenCounts) => counts.input + counts.cacheWrite + counts.cacheRead + counts.output;

function addCounts(into: TokenCounts, from: TokenCounts) {
  into.calls += from.calls;
  into.input += from.input;
  into.cacheWrite += from.cacheWrite;
  into.cacheRead += from.cacheRead;
  into.output += from.output;
  into.reasoning += from.reasoning;
}

export type TokenGroup = TokenCounts & {
  key: string;
  total: number;
  /** Of every token counted, 0 to 1. */
  share: number;
};

/** Rows added up by `keyOf`, most tokens first. */
export function groupCounts<T extends TokenCounts>(rows: readonly T[], keyOf: (row: T) => string): TokenGroup[] {
  const groups = new Map<string, TokenCounts>();
  for (const row of rows) {
    const key = keyOf(row);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = emptyCounts()));
    addCounts(group, row);
  }
  const all = [...groups.values()].reduce((sum, group) => sum + tokenTotal(group), 0);
  return [...groups.entries()]
    .map(([key, counts]) => ({ ...counts, key, total: tokenTotal(counts), share: all > 0 ? tokenTotal(counts) / all : 0 }))
    .sort((left, right) => right.total - left.total || left.key.localeCompare(right.key));
}

/** Rows added up by month, newest first. */
export function byMonth(rows: readonly LifetimeMonth[]): TokenGroup[] {
  return groupCounts(rows, (row) => row.month).sort((left, right) => right.key.localeCompare(left.key));
}

/** A key for rows grouped by more than one field, split again with `splitKey`. */
export const joinKey = (...parts: string[]) => JSON.stringify(parts);
export const splitKey = (key: string): string[] => {
  const parts: unknown = JSON.parse(key);
  return Array.isArray(parts) ? parts.map(String) : [];
};

export type LifetimeSummary = {
  totals: TokenCounts;
  total: number;
  /** yyyy-mm-dd of the first and last day with a call. */
  firstDay: string | null;
  lastDay: string | null;
  machines: number;
  models: number;
};

export function lifetimeSummary(data: LifetimeTokens): LifetimeSummary {
  const totals = emptyCounts();
  for (const row of data.months) addCounts(totals, row);
  const days = data.days.filter((day) => day.calls > 0).map((day) => day.day).sort();
  return {
    totals,
    total: tokenTotal(totals),
    firstDay: days[0] ?? null,
    lastDay: days[days.length - 1] ?? null,
    machines: new Set(data.months.map((row) => row.machine)).size,
    models: new Set(data.months.map((row) => `${row.agent}\u0000${row.model}`)).size,
  };
}

/**
 * The days as the usage trend's timeline, calls standing for requests, with Claude Code's own count on the days
 * whose transcripts are gone as its own series.
 */
export function lifetimeTimeline(days: readonly LifetimeDay[], recovered: readonly RecoveredDay[] = []): TrendInputPoint[] {
  const points = new Map<string, TrendInputPoint>();
  for (const day of days) {
    points.set(day.day, { hour: `${day.day}-00`, firstTimestampMs: null, requests: day.calls, success: day.calls, failure: 0, canceled: 0, tokens: tokenTotal(day) });
  }
  for (const day of recovered) {
    if (day.tokens <= 0) continue;
    const point = points.get(day.day) ?? { hour: `${day.day}-00`, firstTimestampMs: null, requests: 0, success: 0, failure: 0, canceled: 0, tokens: 0 };
    point.recovered = (point.recovered ?? 0) + day.tokens;
    points.set(day.day, point);
  }
  return [...points.values()].sort((left, right) => left.hour.localeCompare(right.hour));
}

export type RecoveredMachine = {
  machine: string;
  /** Days Claude Code gave a token count for. */
  days: number;
  tokens: number;
  /** Days it kept only how many sessions there were. */
  sessionDays: number;
  sessions: number;
  /** yyyy-mm-dd of the first and last day. */
  firstDay: string;
  lastDay: string;
};

export type RecoveredSummary = {
  tokens: number;
  /** Calendar days with a token count on any machine. */
  days: number;
  sessionDays: number;
  sessions: number;
  machines: RecoveredMachine[];
  /** How many times the transcripts' count Claude Code's is, on the days a machine has both; null with none. */
  ratio: number | null;
};

/** Claude Code's own count on the days whose transcripts are gone, by machine, most tokens first. */
export function recoveredSummary(data: Pick<LifetimeTokens, 'recovered' | 'recoveredOverlap'>): RecoveredSummary {
  const machines = new Map<string, RecoveredMachine>();
  const days = new Set<string>();
  const sessionDays = new Set<string>();
  for (const day of data.recovered) {
    let machine = machines.get(day.machine);
    if (!machine) machines.set(day.machine, (machine = { machine: day.machine, days: 0, tokens: 0, sessionDays: 0, sessions: 0, firstDay: day.day, lastDay: day.day }));
    if (day.tokens > 0) {
      machine.days += 1;
      machine.tokens += day.tokens;
      days.add(day.day);
    } else if (day.sessions > 0) {
      machine.sessionDays += 1;
      sessionDays.add(day.day);
    }
    machine.sessions += day.sessions;
    if (day.day < machine.firstDay) machine.firstDay = day.day;
    if (day.day > machine.lastDay) machine.lastDay = day.day;
  }
  const list = [...machines.values()].sort((left, right) => right.tokens - left.tokens || right.sessions - left.sessions || left.machine.localeCompare(right.machine));
  const { claudeCode, transcripts } = data.recoveredOverlap;
  return {
    tokens: list.reduce((sum, machine) => sum + machine.tokens, 0),
    days: days.size,
    sessionDays: sessionDays.size,
    sessions: list.reduce((sum, machine) => sum + machine.sessions, 0),
    machines: list,
    ratio: claudeCode > 0 && transcripts > 0 ? claudeCode / transcripts : null,
  };
}

/**
 * off: no archive, so nothing to count. waiting: nothing kept to count yet. counting: kept
 * transcripts are still being read. done: everything kept is counted.
 */
export type CountingState = 'off' | 'waiting' | 'counting' | 'done';

export function countingState(data: LifetimeTokens): CountingState {
  if (!data.archived) return 'off';
  if (data.versionsLeft > 0) return 'counting';
  return data.months.length ? 'done' : 'waiting';
}

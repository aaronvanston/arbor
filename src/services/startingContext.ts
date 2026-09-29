import { invokeCommand } from '../native/commands';
import { listingChars } from './setupChecks';
import { sharedItems } from './setupInventory';
import type { HomeAgent, SessionStart, SetupMachine, StartingContext } from '../native/types';

/**
 * Starting context (see `starting_context.rs`): how many tokens each session sent with its first request, before
 * anything was said, by the agent home it ran from. Every session pays it again, so a home that loads more than it
 * needs costs every session it starts.
 */

/** How far back the tab looks: the transcript scan looks at the last 30 days. */
export const STARTING_CONTEXT_DAYS = 28;
/** The latest week, compared with the weeks before it. */
export const RECENT_DAYS = 7;
const DAY_MS = 86_400_000;

export const getStartingContext = (fromMs: number, toMs: number) => invokeCommand('get_starting_context', { fromMs, toMs });

/** About how many characters make a token in instructions and skill descriptions, which are English and markdown. */
export const CHARS_PER_TOKEN = 4;
/** Codex cuts each skill's description to this many characters in its listing. */
const CODEX_LISTING_ENTRY_MAX = 1_024;
/** Fewer sessions than this say too little about a week to compare it. */
export const COMPARE_MIN_SESSIONS = 3;
/** A home's start has grown when it's this many tokens bigger, and by at least this share of what it was. */
export const GROWTH_MIN_TOKENS = 3_000;
export const GROWTH_MIN_SHARE = 0.1;
const PROJECTS_SHOWN = 5;

/** The value at a share of the way through, nearest rank. */
export function percentile(values: number[], share: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1));
  return sorted[rank] ?? 0;
}
export const median = (values: number[]) => percentile(values, 0.5);

export type StartSpan = { sessions: number; median: number };
export type ProjectStart = StartSpan & { repo: string };

export type HomeStart = {
  machine: string;
  agent: 'claude' | 'codex';
  home: string;
  sessions: number;
  median: number;
  p90: number;
  latest: SessionStart;
  /** The latest week, and the weeks before it, when each has enough sessions to say anything. */
  recent: StartSpan | null;
  earlier: StartSpan | null;
  /** The latest week's typical start less the weeks before's, when both are known. */
  change: number | null;
  /** Where its sessions ran, most sessions first. */
  projects: ProjectStart[];
  /** The main models its sessions used, most sessions first. */
  models: string[];
};

const span = (starts: SessionStart[]): StartSpan | null =>
  starts.length >= COMPARE_MIN_SESSIONS ? { sessions: starts.length, median: median(starts.map((start) => start.tokens)) } : null;

function countBy<T>(items: T[], key: (item: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.entries()].sort(([a, left], [b, right]) => right.length - left.length || a.localeCompare(b));
}

/** Each machine's homes with the sessions that started from them, the heaviest typical start first. */
export function homeStarts(data: StartingContext, nowMs: number): HomeStart[] {
  const since = nowMs - RECENT_DAYS * DAY_MS;
  return countBy(data.sessions, (start) => `${start.machine}\u0000${start.agent}:${start.home}`)
    .flatMap(([, starts]) => {
      const latest = starts.reduce<SessionStart | undefined>((last, start) => (!last || start.atMs >= last.atMs ? start : last), undefined);
      if (!latest) return [];
      const tokens = starts.map((start) => start.tokens);
      const recent = span(starts.filter((start) => start.atMs >= since));
      const earlier = span(starts.filter((start) => start.atMs < since));
      return [{
        machine: latest.machine,
        agent: latest.agent,
        home: latest.home,
        sessions: starts.length,
        median: median(tokens),
        p90: percentile(tokens, 0.9),
        latest,
        recent,
        earlier,
        change: recent && earlier ? recent.median - earlier.median : null,
        projects: countBy(starts.filter((start) => start.repo !== ''), (start) => start.repo)
          .slice(0, PROJECTS_SHOWN)
          .map(([repo, group]) => ({ repo, sessions: group.length, median: median(group.map((start) => start.tokens)) })),
        models: countBy(starts, (start) => start.model).map(([model]) => model),
      }];
    })
    .sort((a, b) => b.median - a.median || a.machine.localeCompare(b.machine) || a.home.localeCompare(b.home));
}

/** Whether a home's sessions have started noticeably bigger this week than in the weeks before. */
export const startGrew = (start: HomeStart) =>
  start.change !== null && start.earlier !== null && start.change >= Math.max(GROWTH_MIN_TOKENS, start.earlier.median * GROWTH_MIN_SHARE);

/** About what a home's own files add to every start, in tokens, from Sync's last scan of it. */
export type FileEstimate = {
  /** Instruction files, what they import, and rules. */
  instructions: number;
  /** The skill listing the model is given. */
  skills: number;
  total: number;
};

/**
 * What the files in a home add to a start, about: its instructions with what they import and its rules, and the
 * listing of its skills (Codex also lists the machine's shared skills). Null when Sync hasn't seen the home. The
 * project's own instructions, the agent's prompt and tools, and MCP tools aren't in any home's files.
 */
export function fileEstimate(machine: SetupMachine | undefined, agent: HomeAgent, path: string): FileEstimate | null {
  const found = machine?.homes.find((candidate) => candidate.agent === agent && candidate.path === path);
  if (!machine || !found) return null;
  // A shadow home loads what it shares through its links, though the scan lists it under the home it shares.
  const home = { ...found, items: [...found.items, ...sharedItems(machine, found)] };
  const instructionChars = home.items
    .filter((item) => (item.kind === 'instructions' || item.kind === 'import' || item.kind === 'rule') && item.sum !== null && item.enabled !== false)
    .reduce((sum, item) => sum + (item.size ?? 0), 0);
  const shared = agent === 'codex' ? machine.homes.find((candidate) => candidate.agent === 'shared')?.items ?? [] : [];
  const listing = agent === 'codex'
    ? listingChars([...home.items, ...shared], CODEX_LISTING_ENTRY_MAX)
    : listingChars(home.items, undefined, home.skillOverrides);
  const instructions = Math.round(instructionChars / CHARS_PER_TOKEN);
  const skills = Math.round(listing / CHARS_PER_TOKEN);
  return { instructions, skills, total: instructions + skills };
}

/** Where a start's tokens went, about: the home's files, and everything else. Shares add up to 1 at most. */
export function startParts(typical: number, estimate: FileEstimate | null) {
  if (!estimate || typical <= 0) return null;
  const instructions = Math.min(estimate.instructions, typical);
  const skills = Math.min(estimate.skills, typical - instructions);
  return { instructions, skills, rest: typical - instructions - skills };
}

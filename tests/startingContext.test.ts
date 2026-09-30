import { describe, expect, it } from 'bun:test';
import { fileEstimate, homeStarts, median, percentile, startGrew, startParts } from '../src/services/startingContext';
import { itemAt } from './support/items';
import type {
  SessionStart,
  SetupHome,
  SetupItem,
  SetupMachine,
  SkillFacts,
  StartingContext,
} from '../src/native/types';

const DAY = 86_400_000;
const NOW = 1_790_000_000_000;

const start = (fields: Partial<SessionStart> & Pick<SessionStart, 'tokens' | 'atMs'>): SessionStart => ({
  sessionId: `s-${fields.atMs}-${fields.tokens}`, machine: 'mbp', agent: 'claude', home: '~/.claude', repo: '', model: 'claude-opus-5-5', ...fields,
});
const context = (sessions: SessionStart[]): StartingContext => ({ sessions, unplaced: 0, truncated: false });

const item = (kind: SetupItem['kind'], name: string, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind, name, path: null, sum: 's', size: null, link: null, value: null, note: null, count: null, enabled: null, text: true, skill: null, import: null, ...fields,
});
const facts = (fields: Partial<SkillFacts> = {}): SkillFacts => ({
  files: 1, hasDoc: true, declaredName: null, descriptionChars: 196, whenToUseChars: 0, manualOnly: false, source: null, ...fields,
});
const skill = (name: string, fields: Partial<SkillFacts> = {}) => item('skill', name, { skill: facts(fields) });
const home = (agent: SetupHome['agent'], path: string, items: SetupItem[]): SetupHome => ({ agent, path, items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null });
const machine = (homes: SetupHome[]): SetupMachine => ({
  machine: 'mbp', local: true, reachable: true, homes, installs: [], policy: null, scannedAt: NOW, error: null, scanning: false,
});

describe('percentiles', () => {
  it('takes the nearest rank, and nothing from nothing', () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 20, 30, 40])).toBe(20);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([5], 0.9)).toBe(5);
    expect(median([])).toBe(0);
  });
});

describe('homeStarts', () => {
  it('groups sessions by machine and home, the heaviest typical start first', () => {
    const homes = homeStarts(context([
      start({ tokens: 20_000, atMs: NOW - 10 * DAY }),
      start({ tokens: 22_000, atMs: NOW - 9 * DAY, repo: '/src/arbor' }),
      start({ tokens: 24_000, atMs: NOW - DAY, repo: '/src/arbor' }),
      start({ tokens: 50_000, atMs: NOW - 2 * DAY, machine: 'cedar' }),
      start({ tokens: 18_000, atMs: NOW - 2 * DAY, agent: 'codex', home: '~/.codex', model: 'gpt-6-sol' }),
    ]), NOW);
    expect(homes.map((entry) => `${entry.machine} ${entry.agent}:${entry.home}`)).toEqual(['cedar claude:~/.claude', 'mbp claude:~/.claude', 'mbp codex:~/.codex']);
    const mbp = itemAt(homes, 1);
    expect(mbp.sessions).toBe(3);
    expect(mbp.median).toBe(22_000);
    expect(mbp.p90).toBe(24_000);
    expect(mbp.latest.tokens).toBe(24_000);
    expect(mbp.projects).toEqual([{ repo: '/src/arbor', sessions: 2, median: 22_000 }]);
    expect(itemAt(homes, 2).models).toEqual(['gpt-6-sol']);
  });

  it('compares the last week with the weeks before only when each has a few sessions', () => {
    const before = [0, 1, 2].map((index) => start({ tokens: 30_000 + index * 100, atMs: NOW - (10 + index) * DAY }));
    const lately = [0, 1, 2].map((index) => start({ tokens: 36_000 + index * 100, atMs: NOW - (index + 1) * DAY }));
    const grown = itemAt(homeStarts(context([...before, ...lately]), NOW), 0);
    expect(grown.recent).toEqual({ sessions: 3, median: 36_100 });
    expect(grown.earlier).toEqual({ sessions: 3, median: 30_100 });
    expect(grown.change).toBe(6_000);
    expect(startGrew(grown)).toBe(true);

    const few = itemAt(homeStarts(context([...before, itemAt(lately, 0)]), NOW), 0);
    expect(few.recent).toBeNull();
    expect(few.change).toBeNull();
    expect(startGrew(few)).toBe(false);
  });

  it('calls a start grown only past both a few thousand tokens and a tenth of what it was', () => {
    const grown = (earlier: number, change: number) =>
      startGrew({ ...itemAt(homeStarts(context([start({ tokens: 1, atMs: NOW })]), NOW), 0), earlier: { sessions: 5, median: earlier }, change });
    expect(grown(20_000, 2_900)).toBe(false);
    expect(grown(20_000, 3_000)).toBe(true);
    expect(grown(80_000, 7_000)).toBe(false);
    expect(grown(80_000, 8_000)).toBe(true);
    expect(grown(20_000, -9_000)).toBe(false);
  });
});

describe('fileEstimate', () => {
  it('adds up a Claude Code home’s instructions, imports and rules, and its skill listing', () => {
    const claude = home('claude', '~/.claude', [
      item('instructions', 'CLAUDE.md', { size: 4_000 }),
      item('import', '~/notes/style.md', { size: 2_000 }),
      // An import that leads nowhere loads nothing.
      item('import', '~/notes/gone.md', { sum: null, size: null }),
      item('rule', 'testing.md', { size: 800 }),
      skill('pdf'),
      skill('release', { manualOnly: true }),
      item('mcp', 'github'),
    ]);
    const estimate = fileEstimate(machine([claude]), 'claude', '~/.claude');
    // (4,000 + 2,000 + 800) / 4, and "pdf" + 196 + 4 characters / 4.
    expect(estimate).toEqual({ instructions: 1_700, skills: 51, total: 1_751 });
  });

  it('lists the machine’s shared skills for Codex, cut to its shorter entries, and skips a replaced AGENTS.md', () => {
    const codex = home('codex', '~/.codex', [
      item('instructions', 'AGENTS.md', { size: 1_200, enabled: false }),
      item('instructions', 'AGENTS.override.md', { size: 400 }),
    ]);
    const shared = home('shared', '~/.agents', [skill('find-skills', { descriptionChars: 3_000 })]);
    // "find-skills" (11) + 1,024 + 4 = 1,039 characters.
    expect(fileEstimate(machine([codex, shared]), 'codex', '~/.codex')).toEqual({ instructions: 100, skills: 260, total: 360 });
  });

  it('counts what a shadow home loads through its links into the home it shares', () => {
    const codex = home('codex', '~/.codex', [
      item('instructions', 'AGENTS.md', { path: '~/.codex/AGENTS.md', size: 1_200 }),
      item('rule', 'default.rules', { path: '~/.codex/rules/default.rules', size: 400 }),
    ]);
    const shadow = { ...home('codex', '~/.agent-app/homes/codex-proxy', []), shares: { home: '~/.codex', entries: ['AGENTS.md', 'sessions'] } };
    // Its AGENTS.md is ~/.codex's; the rules folder isn't linked, so ~/.codex's rules aren't its.
    expect(fileEstimate(machine([codex, shadow]), 'codex', '~/.agent-app/homes/codex-proxy')).toEqual({ instructions: 300, skills: 0, total: 300 });
  });

  it('knows nothing of a home Setup hasn’t seen', () => {
    expect(fileEstimate(machine([]), 'claude', '~/.claude')).toBeNull();
    expect(fileEstimate(undefined, 'claude', '~/.claude')).toBeNull();
  });
});

describe('startParts', () => {
  it('splits a typical start into the home’s files and everything else, never past the whole', () => {
    expect(startParts(30_000, { instructions: 2_000, skills: 1_000, total: 3_000 })).toEqual({ instructions: 2_000, skills: 1_000, rest: 27_000 });
    expect(startParts(2_500, { instructions: 2_000, skills: 1_000, total: 3_000 })).toEqual({ instructions: 2_000, skills: 500, rest: 0 });
    expect(startParts(30_000, null)).toBeNull();
    expect(startParts(0, { instructions: 1, skills: 1, total: 2 })).toBeNull();
  });
});

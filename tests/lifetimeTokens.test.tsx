import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { UsageLifetimeContent } from '../src/pages/UsageLifetimeView';
import {
  byMonth,
  countingState,
  groupCounts,
  joinKey,
  lifetimeSummary,
  lifetimeTimeline,
  recoveredSummary,
  splitKey,
  tokenTotal,
  type LifetimeMonth,
} from '../src/services/lifetimeTokens';
import { buildUsageTrendSeries } from '../src/services/usageTrend';
import { itemAt } from './support/items';
import type { LifetimeTokens } from '../src/native/types';

const counts = (calls: number, cacheRead: number, output = 100) => ({ calls, input: 10 * calls, cacheWrite: 50 * calls, cacheRead, output, reasoning: 0 });
const row = (month: string, model: string, fields: Partial<LifetimeMonth> = {}): LifetimeMonth => ({
  month,
  machine: 'mini',
  home: '~/.claude',
  agent: 'claude',
  model,
  ...counts(10, 90_000),
  ...fields,
});
const lifetime = (fields: Partial<LifetimeTokens> = {}): LifetimeTokens => ({
  archived: true,
  months: [
    row('2026-08', 'claude-opus-4-6'),
    row('2026-09', 'claude-opus-5-5', counts(20, 400_000)),
    row('2026-09', 'gpt-6-sol', { home: '~/.codex', agent: 'codex', ...counts(5, 50_000), reasoning: 40 }),
    row('2026-09', '', { home: '~/.codex', agent: 'codex', ...counts(1, 0, 7) }),
  ],
  days: [
    { day: '2026-08-30', ...counts(10, 90_000) },
    { day: '2026-09-01', ...counts(0, 0, 0) },
    { day: '2026-09-25', ...counts(26, 450_000) },
  ],
  sources: [
    { machine: 'mini', home: '~/.claude', agent: 'claude', kind: 'home' },
    { machine: 'mini', home: '~/.codex', agent: 'codex', kind: 'home' },
  ],
  recovered: [],
  recoveredOverlap: { claudeCode: 0, transcripts: 0 },
  versionsLeft: 0,
  bytesLeft: 0,
  lastError: null,
  ...fields,
});

// Claude Code's own count: cedar's days whose transcripts are gone, and mini's older days with only sessions.
const recovered = (): Pick<LifetimeTokens, 'recovered' | 'recoveredOverlap'> => ({
  recovered: [
    { day: '2026-03-02', machine: 'mini', tokens: 0, sessions: 4 },
    { day: '2026-08-02', machine: 'cedar', tokens: 900_000, sessions: 3 },
    { day: '2026-08-03', machine: 'cedar', tokens: 600_000, sessions: 2 },
    { day: '2026-08-03', machine: 'mbp', tokens: 50_000, sessions: 1 },
    { day: '2026-08-30', machine: 'cedar', tokens: 20_000, sessions: 1 },
  ],
  recoveredOverlap: { claudeCode: 1_760_000, transcripts: 1_000_000 },
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const render = (data: LifetimeTokens, onOpenArchive?: () => void, machine = '') =>
  text(renderToStaticMarkup(<I18nProvider><UsageLifetimeContent data={data} machine={machine} onOpenArchive={onOpenArchive} /></I18nProvider>));

describe('all-time tokens', () => {
  it('adds every kind of token, and keeps reasoning inside output', () => {
    expect(tokenTotal({ calls: 3, input: 1, cacheWrite: 2, cacheRead: 30, output: 5, reasoning: 4 })).toBe(38);
    const summary = lifetimeSummary(lifetime());
    expect(summary.totals.calls).toBe(36);
    expect(summary.totals.reasoning).toBe(40);
    expect(summary.total).toBe(90_000 + 400_000 + 50_000 + 36 * 60 + 3 * 100 + 7);
    // Days without a call don't start or end the range.
    expect([summary.firstDay, summary.lastDay]).toEqual(['2026-08-30', '2026-09-25']);
    expect([summary.machines, summary.models]).toEqual([1, 4]);
  });

  it('groups rows with the biggest first, and months newest first', () => {
    const models = groupCounts(lifetime().months, (entry) => joinKey(entry.agent, entry.model));
    expect(models.map((group) => splitKey(group.key)[1])).toEqual(['claude-opus-5-5', 'claude-opus-4-6', 'gpt-6-sol', '']);
    expect(models.reduce((sum, group) => sum + group.share, 0)).toBeCloseTo(1, 10);
    expect(itemAt(models, 0).calls).toBe(20);
    const months = byMonth(lifetime().months);
    expect(months.map((group) => group.key)).toEqual(['2026-09', '2026-08']);
    expect(itemAt(months, 0).calls).toBe(26);
    // A key made of fields that hold separators still splits back into them.
    expect(splitKey(joinKey('mini', '~/a|b', 'claude'))).toEqual(['mini', '~/a|b', 'claude']);
  });

  it('lays the days out for the trend chart, calls standing for requests', () => {
    const timeline = lifetimeTimeline(lifetime().days);
    expect(itemAt(timeline, 0)).toEqual({ hour: '2026-08-30-00', firstTimestampMs: null, requests: 10, success: 10, failure: 0, canceled: 0, tokens: 90_000 + 600 + 100 });
    const series = buildUsageTrendSeries(timeline, { start: new Date(2026, 7, 30).toISOString() }, new Date(2026, 8, 26));
    expect(series.totals.requests).toBe(36);
    expect(series.points.length).toBeGreaterThan(20);
  });

  it('adds Claude Code’s own count as its own series, never into the transcripts’ tokens', () => {
    const timeline = lifetimeTimeline(lifetime().days, recovered().recovered);
    expect(timeline.map((point) => point.hour)).toEqual(['2026-08-02-00', '2026-08-03-00', '2026-08-30-00', '2026-09-01-00', '2026-09-25-00']);
    expect(itemAt(timeline, 1)).toMatchObject({ requests: 0, tokens: 0, recovered: 650_000 });
    // A day with both keeps them apart.
    expect(itemAt(timeline, 2)).toMatchObject({ requests: 10, tokens: 90_700, recovered: 20_000 });
    const series = buildUsageTrendSeries(timeline, { start: new Date(2026, 7, 2).toISOString() }, new Date(2026, 8, 26));
    expect(series.totals).toMatchObject({ tokens: 90_700 + 450_000 + 26 * 60 + 100, recovered: 1_570_000 });
  });

  it('sums Claude Code’s own count by machine, and how far it runs from the transcripts', () => {
    const summary = recoveredSummary(recovered());
    expect(summary).toMatchObject({ tokens: 1_570_000, days: 3, sessionDays: 1, sessions: 11 });
    expect(summary.ratio).toBeCloseTo(1.76, 5);
    expect(summary.machines.map((machine) => machine.machine)).toEqual(['cedar', 'mbp', 'mini']);
    expect(itemAt(summary.machines, 0)).toEqual({ machine: 'cedar', days: 3, tokens: 1_520_000, sessionDays: 0, sessions: 6, firstDay: '2026-08-02', lastDay: '2026-08-30' });
    expect(itemAt(summary.machines, 2)).toMatchObject({ days: 0, tokens: 0, sessionDays: 1, sessions: 4 });
    expect(recoveredSummary({ recovered: [], recoveredOverlap: { claudeCode: 0, transcripts: 0 } })).toMatchObject({ tokens: 0, machines: [], ratio: null });
  });

  it('shows Claude Code’s own count apart from the total', () => {
    const shown = render(lifetime(recovered()));
    expect(shown).toContain('Not in the total: 1.6M by Claude Code’s own count on 3 days whose transcripts are gone');
    expect(shown).toContain('Days without transcripts');
    expect(shown).toContain('Its count runs 1.8× the transcripts’ on days with both');
    expect(shown).toContain('On 1 of these days Claude Code kept only how many sessions there were');
    expect(shown).toContain('Claude Code’s own count, transcripts gone');
    // The total is the transcripts' alone.
    expect(shown).toContain('36 calls since');
    const none = render(lifetime());
    expect(none).not.toContain('Days without transcripts');
    expect(none).not.toContain('Not in the total');
  });

  it('keeps Claude Code’s own count on a machine whose transcripts the archive never counted', () => {
    const shown = render(lifetime({ months: [], days: [], sources: [], ...recovered() }), undefined, 'cedar');
    expect(shown).toContain('Nothing counted on this machine');
    expect(shown).toContain('Days without transcripts');
  });

  it('says whether there is anything to count, and whether it is still counting', () => {
    expect(countingState(lifetime({ archived: false, months: [] }))).toBe('off');
    expect(countingState(lifetime({ months: [] }))).toBe('waiting');
    expect(countingState(lifetime({ versionsLeft: 3 }))).toBe('counting');
    expect(countingState(lifetime({ months: [], versionsLeft: 3 }))).toBe('counting');
    expect(countingState(lifetime())).toBe('done');
  });

  it('shows the total, how it breaks down and what it was counted from', () => {
    const shown = render(lifetime());
    expect(shown).toContain('Tokens');
    expect(shown).toContain('36 calls since');
    expect(shown).toContain('Read from cache');
    expect(shown).toContain('40 of it reasoning');
    expect(shown).toContain('from 2 agent homes on mini');
    // Named as Requests names it: Claude's mark stands in for the `claude-` prefix.
    expect(shown).toContain('opus-5-5 Claude Code');
    expect(shown).toContain('Not named');
    expect(shown).toContain('~/.codex');
    expect(shown).toContain('By month');
    expect(shown).not.toContain('Counting');
    // Homes from old backups count too, and the line says so.
    const backups = render(lifetime({ sources: [...lifetime().sources, { machine: 'mini', home: '/Volumes/Backup/dot-claude', agent: 'claude', kind: 'import' }] }));
    expect(backups).toContain('from agent homes on mini and old backups');
  });

  it('says how much is left to count, and what could not be', () => {
    const counting = render(lifetime({ versionsLeft: 214, bytesLeft: 3.24e9, lastError: 'Couldn’t read a kept chunk' }));
    expect(counting).toContain('Counting: 214 kept session files left (3.0 GB).');
    expect(counting).toContain('Some sessions couldn’t be counted. Couldn’t read a kept chunk. They’re');
  });

  it('points to the archive when there is nothing to count', () => {
    const off = render(lifetime({ archived: false, months: [], days: [], sources: [] }), () => undefined);
    expect(off).toContain('Keep your sessions to count them');
    expect(off).toContain('Open session archive');
    const waiting = render(lifetime({ months: [], days: [] }));
    expect(waiting).toContain('Nothing counted yet');
    expect(waiting).not.toContain('Open session archive');
    // Narrowed to a machine with nothing counted, it says so of that machine, not of the archive.
    const elsewhere = render(lifetime({ months: [], days: [] }), () => {}, 'cedar');
    expect(elsewhere).toContain('Nothing counted on this machine');
    expect(elsewhere).toContain('cedar');
    expect(elsewhere).not.toContain('Nothing counted yet');
  });
});

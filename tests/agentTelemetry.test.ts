import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import {
  TELEMETRY_QUIET_MS,
  isTelemetrySpan,
  machineTelemetryState,
  parseTelemetrySpan,
  telemetryWindow,
  spendName,
  spendShares,
  telemetryNeedsSetup,
  telemetryPlanText,
  totalTokens,
} from '../src/services/agentTelemetry';
import type { MachineTelemetry, SettingsEdit, Spend, TelemetryStatus } from '../src/native/types';

const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);

const NOW = 1_790_000_000_000;

const entry = (machine: string, lastMs: number | null, fields: Partial<MachineTelemetry> = {}): MachineTelemetry => ({
  machine, sinceMs: NOW - 86_400_000, lastMs, requests: lastMs === null ? 0 : 10, cumulative: false, stalePort: null, ...fields,
});
const status = (machines: MachineTelemetry[], fields: Partial<TelemetryStatus> = {}): TelemetryStatus => ({
  enabled: true, port: 8319, listening: '*:8319', error: null, lan: true, machines, ...fields,
});
const spend = (cost: number, tokens = 0, sessions = 1): Spend => ({
  cost, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, sessions,
});

describe('machineTelemetryState', () => {
  it('is off before the status has loaded, or for a machine never set up', () => {
    expect(machineTelemetryState(null, 'ci-01', NOW)).toEqual({ state: 'off', entry: null });
    expect(machineTelemetryState(status([entry('casey-mbp', NOW)]), 'ci-01', NOW).state).toBe('off');
  });

  it('waits for a machine set up that has sent nothing yet', () => {
    expect(machineTelemetryState(status([entry('ci-01', null)]), 'ci-01', NOW).state).toBe('waiting');
  });

  it('is receiving within a day of the last send, and quiet after', () => {
    expect(machineTelemetryState(status([entry('ci-01', NOW - TELEMETRY_QUIET_MS)]), 'ci-01', NOW).state).toBe('receiving');
    expect(machineTelemetryState(status([entry('ci-01', NOW - TELEMETRY_QUIET_MS - 1)]), 'ci-01', NOW).state).toBe('quiet');
  });

  it('says a machine set up is stopped while the receiver is off, whatever it last sent', () => {
    const off = status([entry('ci-01', NOW - 60_000)], { enabled: false, listening: null });
    const { state, entry: found } = machineTelemetryState(off, 'ci-01', NOW);
    expect(state).toBe('stopped');
    expect(found?.machine).toBe('ci-01');
  });
});

describe('telemetryNeedsSetup', () => {
  it('asks to set a machine up again when Arbor can’t use what it sends, or it sends to the wrong port', () => {
    expect(telemetryNeedsSetup(null)).toBe(false);
    expect(telemetryNeedsSetup(entry('ci-01', NOW))).toBe(false);
    expect(telemetryNeedsSetup(entry('ci-01', NOW, { cumulative: true }))).toBe(true);
    expect(telemetryNeedsSetup(entry('ci-01', null, { stalePort: 8320 }))).toBe(true);
  });
});

describe('spendName', () => {
  it('names the stand-ins Claude Code sends for names it keeps back, and marks them hidden', () => {
    expect(spendName('skills', 'third-party', t)).toEqual({ text: 'Skills from other marketplaces', hidden: true });
    expect(spendName('plugins', 'third-party', t)).toEqual({ text: 'Plugins from other marketplaces', hidden: true });
    expect(spendName('mcpServers', 'custom', t)).toEqual({ text: 'Your own servers', hidden: true });
    expect(spendName('agents', 'custom', t)).toEqual({ text: 'Your own subagents', hidden: true });
  });

  it('keeps a stand-in word as a real name where Claude Code doesn’t use it as one', () => {
    // A skill the user called "custom" is theirs, not a hidden server.
    expect(spendName('skills', 'custom', t)).toEqual({ text: 'custom', hidden: false });
    expect(spendName('models', 'third-party', t)).toEqual({ text: 'third-party', hidden: false });
  });

  it('puts the query sources into words without calling them hidden', () => {
    expect(spendName('sources', 'main', t)).toEqual({ text: 'Main conversation', hidden: false });
    expect(spendName('sources', 'subagent', t)).toEqual({ text: 'Subagents', hidden: false });
    expect(spendName('sources', 'auxiliary', t)).toEqual({ text: 'Side calls', hidden: false });
    expect(spendName('sources', '', t)).toEqual({ text: 'Not said', hidden: false });
  });

  it('shows real names as they are, and an empty one as not said', () => {
    expect(spendName('skills', 'release-arbor', t)).toEqual({ text: 'release-arbor', hidden: false });
    expect(spendName('versions', '', t)).toEqual({ text: 'Not said', hidden: false });
  });
});

describe('spendShares', () => {
  it('shares out the cost', () => {
    const groups = [{ name: 'a', ...spend(3) }, { name: 'b', ...spend(1) }];
    expect(spendShares(groups, spend(4))).toEqual([0.75, 0.25]);
  });

  it('shares out tokens when nothing was priced', () => {
    const groups = [{ name: 'a', ...spend(0, 600) }, { name: 'b', ...spend(0, 200) }];
    expect(spendShares(groups, spend(0, 1_000))).toEqual([0.6, 0.2]);
  });

  it('never goes past the whole, and gives nothing when there is no whole', () => {
    // A session can use two skills in one request, so the groups can add up to more than the total.
    expect(spendShares([{ name: 'a', ...spend(5) }], spend(4))).toEqual([1]);
    expect(spendShares([{ name: 'a', ...spend(0) }], spend(0))).toEqual([0]);
  });

  it('adds up every kind of token', () => {
    expect(totalTokens({ cost: 0, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, sessions: 0 })).toBe(10);
  });
});

describe('telemetryPlanText', () => {
  const file = (fields: Partial<SettingsEdit>): SettingsEdit => ({
    home: '~/.claude', path: '~/.claude/settings.json', change: 'edit', written: false, error: null, ...fields,
  });

  it('says what setting a machine up does to each file', () => {
    expect(telemetryPlanText(file({ change: 'create' }), true, t)).toBe('Created, sending to Arbor');
    expect(telemetryPlanText(file({ change: 'edit' }), true, t)).toBe('Set to send to Arbor');
    expect(telemetryPlanText(file({ change: 'none' }), true, t)).toBe('Already sends to Arbor');
  });

  it('says what taking it away does', () => {
    expect(telemetryPlanText(file({ change: 'edit' }), false, t)).toBe('Takes Arbor’s settings out');
    expect(telemetryPlanText(file({ change: 'none' }), false, t)).toBe('Nothing to take out');
  });

  it('puts a file’s error first', () => {
    expect(telemetryPlanText(file({ error: 'It sends to another collector' }), true, t)).toBe('Can’t change it: It sends to another collector');
  });
});

describe('Sync › Cost’s span for Claude Code’s spend', () => {
  it('counts its days up to now, and an hour past it for a send landing while the page is open', () => {
    expect(telemetryWindow(7, NOW)).toEqual({ fromMs: NOW - 7 * 86_400_000, toMs: NOW + 3_600_000 });
    expect(telemetryWindow(1, NOW).fromMs).toBe(NOW - 86_400_000);
  });

  it('is a day, a week or a month, and a week until one is picked', () => {
    expect([1, 7, 30].every(isTelemetrySpan)).toBe(true);
    expect(isTelemetrySpan(14)).toBe(false);
    expect(parseTelemetrySpan(null)).toBe(7);
    expect(parseTelemetrySpan('14')).toBe(7);
    expect(parseTelemetrySpan('junk')).toBe(7);
    expect(parseTelemetrySpan('30')).toBe(30);
  });
});

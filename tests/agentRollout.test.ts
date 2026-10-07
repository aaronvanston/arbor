import { describe, expect, it } from 'bun:test';
import {
  agentRollout,
  agentVersion,
  compareNewest,
  rateWorse,
  rollbackCommand,
  trialMachine,
  versionUses,
} from '../src/services/agentRollout';
import type { AgentInstall, ClientHour, ClientVersions, MachineHealth } from '../src/native/types';

const HOUR = 3_600_000;
const T0 = 1_790_000_000_000 - (1_790_000_000_000 % HOUR);

const hour = (machine: string, userAgent: string, at: number, requests: number, failed = 0, rateLimited = 0): ClientHour => ({
  machine, userAgent, hourMs: T0 + at * HOUR, requests, failed, rateLimited,
});
const data = (hours: ClientHour[]): ClientVersions => ({ hours, truncated: false });
const claude = (version: string) => `claude-cli/${version} (external, cli)`;

const machine = (name: string, claudeVersion: string | null, fields: Partial<MachineHealth> = {}, running = 0): MachineHealth => {
  const install: AgentInstall | null = claudeVersion === null ? null : { version: claudeVersion, path: '/Users/a/.local/bin/claude', real: null, method: 'native', updateCommand: 'claude update', copies: [] };
  return {
    machine: name,
    status: 'healthy',
    latest: { claudeRunning: running, codexRunning: 0 },
    agents: { claude: install, codex: null, checkedAt: T0, error: null, updating: [], reporter: null },
    ...fields,
  } as unknown as MachineHealth;
};

describe('agentVersion', () => {
  it('reads the agent and version from each client’s User-Agent, leaving the Codex app out', () => {
    expect(agentVersion('claude-cli/2.1.283 (external, cli)')).toEqual({ agent: 'claude', version: '2.1.283' });
    expect(agentVersion('claude-cli/2.1.283 (external, sdk-ts, agent-sdk/0.3.1)')).toEqual({ agent: 'claude', version: '2.1.283' });
    expect(agentVersion('codex_cli_rs/0.156.1 (Mac OS 26.0.0; arm64) iTerm.app/3.5')).toEqual({ agent: 'codex', version: '0.156.1' });
    expect(agentVersion('codex_exec/0.157.0-alpha.2 (Ubuntu 24.4.0; x86_64)')).toEqual({ agent: 'codex', version: '0.157.0-alpha.2' });
    expect(agentVersion('Codex Desktop/1.4.0')).toBeNull();
    expect(agentVersion('curl/8.7.1')).toBeNull();
    expect(agentVersion('claude-cli/unknown')).toBeNull();
  });
});

describe('versionUses', () => {
  it('adds up each version’s hours and machines, the newest first', () => {
    const uses = versionUses(data([
      hour('mbp', claude('2.1.90'), 0, 10, 1),
      hour('cedar', claude('2.1.282'), 0, 20, 2, 1),
      hour('mbp', claude('2.1.282'), 3, 5),
      hour('', claude('2.1.282'), 4, 1),
      hour('mbp', 'codex_cli_rs/0.156.1', 1, 7),
    ]), 'claude');
    expect(uses.map((use) => use.version)).toEqual(['2.1.282', '2.1.90']);
    // One hour came through a key no machine is assigned to, so more machines may run it than it names.
    expect(uses[0]).toEqual({ version: '2.1.282', requests: 26, failed: 2, rateLimited: 1, machines: ['cedar', 'mbp'], unassigned: true, firstMs: T0, lastMs: T0 + 4 * HOUR });
    expect(uses[1]?.unassigned).toBe(false);
  });
});

describe('rateWorse', () => {
  it('needs a point’s gap past chance, and enough requests on both sides', () => {
    expect(rateWorse(40, 1_000, 5, 1_000)).toBe(true);
    // Worse by more than a point, but ten more failures of a hundred is within chance of five.
    expect(rateWorse(8, 100, 5, 100)).toBe(false);
    // Past chance, but less than a point.
    expect(rateWorse(700, 100_000, 400, 100_000)).toBe(false);
    expect(rateWorse(3, 10, 0, 1_000)).toBe(false);
    expect(rateWorse(3, 20, 0, 1_000)).toBe(true);
    expect(rateWorse(5, 100, 50, 100)).toBe(false);
  });
});

describe('compareNewest', () => {
  it('compares the new version with the others over the hours since it arrived', () => {
    const comparison = compareNewest(data([
      // Before the new version: the old one's bad hour isn't counted against the new one's.
      hour('cedar', claude('2.1.282'), 0, 500, 100),
      hour('mbp', claude('2.1.283'), 5, 150, 1),
      hour('cedar', claude('2.1.282'), 5, 400, 2),
      hour('cedar', claude('2.1.282'), 6, 200, 1, 1),
    ]), 'claude', '2.1.283');
    expect(comparison).toEqual({
      since: T0 + 5 * HOUR,
      newer: { requests: 150, failed: 1, rateLimited: 0 },
      older: { requests: 600, failed: 3, rateLimited: 1 },
      baseline: 'same',
      verdict: 'fine',
      worse: [],
    });
  });

  it('calls a version worse on errors or on rate limits alone', () => {
    const errors = compareNewest(data([hour('mbp', claude('2.1.283'), 5, 60, 9), hour('cedar', claude('2.1.282'), 5, 600, 3)]), 'claude', '2.1.283');
    expect(errors.verdict).toBe('worse');
    expect(errors.worse).toEqual(['errors']);
    const limits = compareNewest(data([hour('mbp', claude('2.1.283'), 5, 300, 30, 30), hour('cedar', claude('2.1.282'), 5, 600, 3, 1)]), 'claude', '2.1.283');
    expect(limits.worse).toEqual(['rateLimits']);
  });

  it('waits for enough requests before calling a version fine', () => {
    const early = compareNewest(data([hour('mbp', claude('2.1.283'), 5, 40), hour('cedar', claude('2.1.282'), 5, 600, 3)]), 'claude', '2.1.283');
    expect(early.verdict).toBe('waiting');
    const quiet = compareNewest(data([hour('cedar', claude('2.1.282'), 5, 600, 3)]), 'claude', '2.1.283');
    expect(quiet.since).toBeNull();
    expect(quiet.newer.requests).toBe(0);
    expect(quiet.verdict).toBe('waiting');
  });

  it('compares with the hours before when the others were quiet since, and says when there’s nothing to compare', () => {
    const before = compareNewest(data([hour('mbp', claude('2.1.282'), 0, 300, 3), hour('mbp', claude('2.1.283'), 5, 200, 2), hour('cedar', claude('2.1.282'), 6, 10)]), 'claude', '2.1.283');
    expect(before.baseline).toBe('before');
    expect(before.older.requests).toBe(300);
    expect(before.verdict).toBe('fine');
    const nothing = compareNewest(data([hour('mbp', claude('2.1.283'), 5, 200, 2), hour('cedar', claude('2.1.282'), 6, 10)]), 'claude', '2.1.283');
    expect(nothing.verdict).toBe('noBaseline');
    expect(nothing.baseline).toBe('same');
  });
});

describe('agentRollout', () => {
  it('splits the fleet into machines on the newest version and the rest, and compares while they differ', () => {
    const rollout = agentRollout('claude', [
      machine('mbp', '2.1.283'),
      machine('cedar', '2.1.282', {}, 2),
      machine('ci', '2.1.282', { status: 'unreachable' } as Partial<MachineHealth>),
      machine('old', '2.1.270'),
      machine('bare', null),
    ], data([hour('mbp', claude('2.1.283'), 5, 150), hour('cedar', claude('2.1.282'), 5, 600)]));
    expect(rollout?.newest).toBe('2.1.283');
    expect(rollout?.ahead.map((entry) => entry.machine)).toEqual(['mbp']);
    expect(rollout?.behind.map((entry) => entry.machine)).toEqual(['cedar', 'ci', 'old']);
    expect(rollout?.previous).toBe('2.1.282');
    expect(rollout?.comparison?.verdict).toBe('fine');
    expect(rollout?.behind.find((entry) => entry.machine === 'ci')?.reachable).toBe(false);
  });

  it('has nothing to compare while the fleet runs one version, and nothing at all without the agent', () => {
    const even = agentRollout('claude', [machine('mbp', '2.1.282'), machine('cedar', '2.1.282')], data([]));
    expect(even?.behind).toEqual([]);
    expect(even?.comparison).toBeNull();
    expect(agentRollout('codex', [machine('mbp', '2.1.282')], data([]))).toBeNull();
  });

  it('tries a new version first where the fewest sessions are running', () => {
    const rollout = agentRollout('claude', [
      machine('mbp', '2.1.282', {}, 3),
      machine('cedar', '2.1.282', {}, 1),
      machine('ci', '2.1.282', { status: 'unreachable' } as Partial<MachineHealth>, 0),
      machine('beta', '2.1.282', {}, 1),
    ], null);
    expect(rollout && trialMachine(rollout)).toBe('beta');
  });
});

describe('rollbackCommand', () => {
  it('puts a version back with each agent’s installer, and never carries anything but a version', () => {
    expect(rollbackCommand('claude', '2.1.282')).toBe('claude install 2.1.282');
    expect(rollbackCommand('codex', '0.156.1')).toBe('npm install -g @openai/codex@0.156.1');
    expect(rollbackCommand('claude', '2.1.282; rm -rf ~')).toBeNull();
    expect(rollbackCommand('claude', '$(whoami)')).toBeNull();
  });
});

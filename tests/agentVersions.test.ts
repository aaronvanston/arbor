import { describe, expect, it } from 'bun:test';
import { agentsBehind, agentVersionRows, compareVersions, newestAgents, runningAgents } from '../src/services/agentVersions';
import { itemAt } from './support/items';
import type { AgentInstall, HealthPoint, MachineAgents, MachineHealth } from '../src/native/types';

const install = (version: string | null, path = '/home/casey/.local/bin/claude'): AgentInstall => ({ version, path, real: null, method: 'native', updateCommand: 'claude update', copies: [] });
const agents = (fields: Partial<MachineAgents> = {}): MachineAgents => ({
  claude: null, codex: null, checkedAt: 0, error: null, updating: [], reporter: { installed: false, homes: [] }, t3: null, orca: null, ...fields,
});
const machine = (name: string, fields: Partial<MachineHealth> = {}): MachineHealth => ({
  machine: name,
  host: { machine: name, endpoint: name, port: 22, enabled: true, source: 'manual' },
  local: false, status: 'healthy', score: 90, reason: null, facts: null, latest: null, points: [],
  error: null, lastOkAt: 0, lastAttemptAt: 0, pingTarget: null, path: null,
  agents: agents(),
  ...fields,
});
const withAgents = (name: string, claude: string | null, codex: string | null) =>
  machine(name, { agents: agents({ claude: claude ? install(claude) : null, codex: codex ? install(codex, '/usr/local/bin/codex') : null }) });

describe('agent versions', () => {
  it('compares versions part by part, with pre-releases before their release', () => {
    expect(compareVersions('2.1.281', '2.1.90')).toBe(1);
    expect(compareVersions('2.1.90', '2.1.281')).toBe(-1);
    expect(compareVersions('0.156.0', '0.156.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('0.47.0-alpha.3', '0.47.0')).toBe(-1);
    expect(compareVersions('0.47.0-alpha.3', '0.47.0-alpha.10')).toBe(-1);
    expect(compareVersions('0.47.0+build.5', '0.47.0')).toBe(0);
  });

  it('flags a machine whose agent is older than the same agent elsewhere in the fleet', () => {
    const fleet = [
      withAgents('casey-mbp', '2.1.281', '0.156.0'),
      withAgents('ci-01', '2.1.270', '0.156.0'),
      withAgents('cedar-02', '2.1.281', null),
      machine('lab-box', { agents: agents({ claude: install(null) }) }),
    ];
    const newest = newestAgents(fleet);
    expect(newest).toEqual({ claude: { version: '2.1.281', machine: 'casey-mbp' }, codex: { version: '0.156.0', machine: 'casey-mbp' } });
    expect(agentsBehind(fleet[1]!, newest)).toEqual([{ agent: 'claude', version: '2.1.270', newest: '2.1.281', machine: 'casey-mbp' }]);
    expect(agentsBehind(fleet[0]!, newest)).toEqual([]);
    // Without Codex, or without a readable version, there's nothing to compare.
    expect(agentsBehind(fleet[2]!, newest)).toEqual([]);
    expect(agentsBehind(fleet[3]!, newest)).toEqual([]);
    // One machine can't drift from itself.
    const alone = [withAgents('casey-mbp', '2.0.1', '0.1.0')];
    expect(agentsBehind(alone[0]!, newestAgents(alone))).toEqual([]);
  });

  it('holds agents to their latest release once npm has said, and to the fleet while it hasn’t', () => {
    const fleet = [withAgents('casey-mbp', '2.1.281', '0.156.0'), withAgents('ci-01', '2.1.270', '0.157.1')];
    const newest = newestAgents(fleet, { claude: '2.1.283', codex: '0.157.0' });
    expect(newest).toEqual({ claude: { version: '2.1.283', machine: null }, codex: { version: '0.157.0', machine: null } });
    expect(agentsBehind(itemAt(fleet, 0), newest)).toEqual([
      { agent: 'claude', version: '2.1.281', newest: '2.1.283', machine: null },
      { agent: 'codex', version: '0.156.0', newest: '0.157.0', machine: null },
    ]);
    // Ahead of the release isn't behind it.
    expect(agentsBehind(itemAt(fleet, 1), newest)).toEqual([{ agent: 'claude', version: '2.1.270', newest: '2.1.283', machine: null }]);
    // A lone machine can be behind the release, which it can't be behind itself.
    const alone = [withAgents('casey-mbp', '2.1.281', '0.157.0')];
    expect(agentsBehind(itemAt(alone, 0), newestAgents(alone, { claude: '2.1.283', codex: '0.157.0' })).map((entry) => entry.agent)).toEqual(['claude']);
    // An agent npm couldn't be asked about falls back to the fleet.
    const partly = newestAgents(fleet, { claude: null, codex: '0.157.0' });
    expect(partly.claude).toEqual({ version: '2.1.281', machine: 'casey-mbp' });
    expect(newestAgents(fleet, null)).toEqual(newestAgents(fleet));
  });

  it('counts running agents from the last sample while the machine answers', () => {
    const latest = { claudeRunning: 3, codexRunning: null } as HealthPoint;
    expect(runningAgents(machine('casey-mbp', { latest }))).toEqual({ claude: 3, codex: 0 });
    expect(runningAgents(machine('ci-01', { latest, status: 'unreachable' }))).toBeNull();
    expect(runningAgents(machine('ci-01', { latest: { claudeRunning: null, codexRunning: null } as HealthPoint }))).toBeNull();
    expect(runningAgents(machine('lab-box'))).toBeNull();
  });

  it('lists each machine with a host, its agents side by side and how far behind, for Sync › Agents', () => {
    const fleet = [
      machine('casey-mbp', { agents: agents({ claude: install('2.1.281'), codex: install('0.156.0', '/usr/local/bin/codex') }), latest: { claudeRunning: 2, codexRunning: 1 } as HealthPoint }),
      machine('ci-01', { agents: agents({ claude: install(null) }), status: 'unreachable' }),
      machine('cedar-02', { agents: agents({ checkedAt: null }) }),
      machine('lab-box', { status: 'unconfigured' }),
    ];
    const rows = agentVersionRows(fleet, newestAgents(fleet, { claude: '2.1.283', codex: null }));
    // lab-box has no host, so nothing checks its agents.
    expect(rows.map((row) => row.machine)).toEqual(['casey-mbp', 'ci-01', 'cedar-02']);
    expect(itemAt(rows, 0)).toEqual({
      machine: 'casey-mbp',
      status: 'healthy',
      agents: {
        claude: { state: 'installed', version: '2.1.281', newer: { version: '2.1.283', machine: null } },
        codex: { state: 'installed', version: '0.156.0', newer: null },
      },
      running: { claude: 2, codex: 1 },
    });
    // A version that can't be read is never behind; an agent looked for and not found differs from one not looked for.
    expect(itemAt(rows, 1).agents).toEqual({ claude: { state: 'installed', version: null, newer: null }, codex: { state: 'missing' } });
    expect(itemAt(rows, 1).running).toBeNull();
    expect(itemAt(rows, 2).agents).toEqual({ claude: { state: 'unchecked' }, codex: { state: 'unchecked' } });
  });
});

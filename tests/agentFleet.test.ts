import { describe, expect, it } from 'bun:test';
import { agentRollout } from '../src/services/agentRollout';
import { fleetUpdates, harnessGroups, rolloutStanding, rolloutTarget, rolloutTargets, untried } from '../src/services/agentFleet';
import type { HarnessHomeRow } from '../src/services/harnessHomes';
import type { HealthStatus, MachineHealth } from '../src/native/types';

const machine = (name: string, version: string | null, status: HealthStatus = 'healthy'): MachineHealth =>
  ({
    machine: name,
    status,
    latest: { claudeRunning: 1, codexRunning: 0 },
    agents: { claude: { version, path: '/u/.local/bin/claude', updateCommand: 'claude update' }, codex: null, checkedAt: 1, error: null, updating: [], reporter: null },
  }) as unknown as MachineHealth;

const rollout = (machines: MachineHealth[], latest: string | null = null) => {
  const found = agentRollout('claude', machines, { hours: [], truncated: false }, latest);
  if (!found) throw new Error('no rollout');
  return found;
};

const home = (name: string, version: string | null, extra: Partial<HarnessHomeRow> = {}): HarnessHomeRow => ({
  machine: name, harness: 'pi', path: '~/.pi/agent', instructions: null, state: 'missing', skills: 0, version, updateCommand: 'pi update', ...extra,
});

describe('updating Claude Code or Codex everywhere', () => {
  it('aims at the latest release when it’s known, and brings up every machine that answers below it', () => {
    const fleet = rollout([machine('cam-mbp', '2.1.282'), machine('ci-01', '2.1.281'), machine('cedar-02', '2.1.281', 'unreachable')], '2.1.283');
    expect(rolloutTarget(fleet)).toBe('2.1.283');
    expect(rolloutTargets(fleet).map((entry) => entry.machine)).toEqual(['cam-mbp', 'ci-01']);
    expect(untried(fleet)).toBe(true);
  });

  it('aims at the fleet’s newest while the release isn’t known, leaving the machines that have it', () => {
    const fleet = rollout([machine('cam-mbp', '2.1.282'), machine('ci-01', '2.1.281')]);
    expect(rolloutTarget(fleet)).toBe('2.1.282');
    expect(rolloutTargets(fleet).map((entry) => entry.machine)).toEqual(['ci-01']);
    // cam-mbp already runs it, so it isn't untried.
    expect(untried(fleet)).toBe(false);
  });

  it('includes a machine whose version couldn’t be read, which an update settles', () => {
    expect(rolloutTargets(rollout([machine('cam-mbp', '2.1.282'), machine('ci-01', null)])).map((entry) => entry.machine)).toEqual(['ci-01']);
  });

  it('says where the fleet stands', () => {
    expect(rolloutStanding(rollout([machine('a', '2.1.282'), machine('b', '2.1.282')], '2.1.282'))).toBe('current');
    expect(rolloutStanding(rollout([machine('a', '2.1.282'), machine('b', '2.1.282')], '2.1.283'))).toBe('releaseOut');
    expect(rolloutStanding(rollout([machine('a', '2.1.282'), machine('b', '2.1.282')]))).toBe('even');
    // With the proxy's records the newer one is on trial; without them nothing compares the two.
    expect(rolloutStanding(rollout([machine('a', '2.1.282'), machine('b', '2.1.281')]))).toBe('trial');
    const unread = agentRollout('claude', [machine('a', '2.1.282'), machine('b', '2.1.281')], null);
    expect(unread && rolloutStanding(unread)).toBe('mixed');
    expect(rolloutStanding(rollout([machine('a', null)]))).toBe('unknown');
  });
});

describe('the other agents across the fleet', () => {
  it('groups homes by agent, behind the newest the fleet runs, one update per machine', () => {
    const groups = harnessGroups([
      home('cam-mbp', '0.70.2'),
      home('ci-01', '0.68.0'),
      home('ci-01', '0.68.0', { path: '~/.pi/agent-work' }),
      home('cedar-02', '0.15.3', { harness: 'openCode', updateCommand: null }),
    ]);
    expect(groups.map((group) => group.harness)).toEqual(['pi', 'openCode']);
    const [pi, openCode] = groups;
    expect(pi?.newest).toBe('0.70.2');
    expect(pi?.rows.length).toBe(3);
    expect(pi?.updatable.map((row) => row.machine)).toEqual(['cam-mbp', 'ci-01']);
    expect(pi?.behind.map((row) => row.machine)).toEqual(['ci-01']);
    // Arbor can't update this one, so it's never offered.
    expect(openCode?.updatable).toEqual([]);
  });
});

describe('updating everything', () => {
  it('lists what’s behind, agent by agent, and nothing that’s current', () => {
    const claude = rollout([machine('cam-mbp', '2.1.282'), machine('ci-01', '2.1.281')]);
    const groups = harnessGroups([home('cam-mbp', '0.70.2'), home('ci-01', '0.68.0')]);
    expect(fleetUpdates([claude], groups)).toEqual([
      { kind: 'agent', agent: 'claude', machine: 'ci-01', command: 'claude update', version: '2.1.281' },
      { kind: 'harness', harness: 'pi', machine: 'ci-01', command: 'pi update', version: '0.68.0' },
    ]);
    expect(fleetUpdates([rollout([machine('a', '2.1.282')], '2.1.282')], harnessGroups([home('a', '0.70.2')]))).toEqual([]);
  });
});

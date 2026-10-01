import { describe, expect, test } from 'bun:test';
import { translate as t } from '../src/i18n';
import type { MachineHealth } from '../src/native/types';
import type { FleetSession } from '../src/services/fleetBoard';
import { glanceMachines, glanceProviders, machineTrayRows, type GlancePicks } from '../src/services/glance';
import type { NewestAgents } from '../src/services/agentVersions';
import { homeMachines } from '../src/services/homeOverview';

const health = (machine: string, fields: Partial<MachineHealth> = {}) =>
  ({ machine, local: false, status: 'healthy', score: null, reason: null, facts: null, latest: null, error: null, lastOkAt: null, lastAttemptAt: null, agents: { claude: null, codex: null }, ...fields }) as MachineHealth;
const row = (machine: string, status: FleetSession['status'], client: FleetSession['client'] = 'claudeCode', agent: string | null = null) =>
  ({ machine, status, client, agent, countsAsWaiting: status === 'approval' || status === 'question', snoozedUntilMs: null }) as FleetSession;
const NONE_NEWER: NewestAgents = { claude: null, codex: null };
const hiding = (hidden: Partial<GlancePicks>): GlancePicks => ({ hiddenProviders: [], hiddenMachines: [], ...hidden });

describe('the glance', () => {
  test('lists every machine with a host but those unticked, with its health dot, what is wrong and its agents by kind', () => {
    const machines = homeMachines(
      [health('studio', { local: true }), health('lab', { status: 'unreachable' }), health('spare', { status: 'unconfigured' }), health('mini', { status: 'degraded' })],
      [],
      // A T3 Code thread counts by its provider.
      { rows: [row('studio', 'working'), row('studio', 'working', 't3code', 'codex'), row('studio', 'approval'), row('runner', 'working')] },
      'studio',
    );
    const rows = (picks: GlancePicks) =>
      machineTrayRows(glanceMachines(machines, picks), (machine) => (machine === 'studio' ? 'Studio' : machine), NONE_NEWER, t)
        .map(({ text, dot }) => ({ text, dot }));
    // One with no address and one only known from its sessions have no health to show.
    expect(rows(hiding({}))).toEqual([
      { text: 'Machines', dot: undefined },
      { text: 'Studio · 1 Claude · 1 Codex · 1 waiting on you', dot: 'green' },
      { text: 'lab · unreachable · idle', dot: 'red' },
      { text: 'mini · Degraded · idle', dot: 'amber' },
    ]);
    expect(rows(hiding({ hiddenMachines: ['lab', 'gone'] })).map((item) => item.text)).toEqual(['Machines', 'Studio · 1 Claude · 1 Codex · 1 waiting on you', 'mini · Degraded · idle']);
    expect(rows(hiding({ hiddenMachines: ['studio', 'lab', 'mini'] }))).toEqual([]);
  });

  test('a machine opens its readings, its agents with any newer version, when it was checked, and its page', () => {
    const point = {
      t: 0, score: 61, cpu: 34.2, mem: 91.4, memUsedKb: 58_500_000, swap: null, swapUsedKb: null, disk: 58, diskFreeKb: 400_000_000,
      load1: 4.12, load5: 3, load15: 2, rxBps: null, txBps: null, latencyMs: 4.2, cpuTemp: null, gpuTemp: null, gpuUtil: null, gpuMemUsedMb: null,
      claudeRunning: 6, codexRunning: 4,
    } as MachineHealth['latest'];
    const install = (version: string) => ({ version, path: '', real: null, method: 'npm', updateCommand: '', copies: [] }) as unknown as MachineHealth['agents']['claude'];
    const machines = homeMachines([health('lab', {
      status: 'degraded', score: 61.4, reason: { metric: 'memory', value: 91.4 }, latest: point, lastAttemptAt: new Date(2026, 9, 2, 7, 58).getTime(),
      facts: { memTotalKb: 64 * 1024 * 1024 } as MachineHealth['facts'],
      agents: { claude: install('2.1.40'), codex: install('0.157.0') } as MachineHealth['agents'],
    })], [], { rows: [] }, 'studio');
    const [, lab] = machineTrayRows(machines, (machine) => machine, { claude: { version: '2.1.40', machine: null }, codex: { version: '0.158.0', machine: null } }, t);
    expect(lab?.text).toBe('lab · Memory pressure · 91% used · idle');
    expect(lab?.children).toEqual([
      { text: 'Degraded, score 61' },
      { text: 'Memory pressure · 91% used' },
      { text: '' },
      { text: 'CPU 34% · load 4.1' },
      { text: 'Memory 91% · 55.8 GB of 64 GB' },
      { text: 'Disk 58% used · 381 GB free' },
      { text: 'Latency 4.2 ms' },
      { text: '' },
      { text: 'Claude Code 2.1.40 · 6 running', dot: 'blank' },
      { text: 'Codex 0.157.0 · 4 running · 0.158.0 out', dot: 'amber' },
      { text: expect.stringMatching(/^Checked at 7:58/) as unknown as string },
      { text: '' },
      { text: 'Open machine page', action: { kind: 'openMachine', machine: 'lab' } },
    ]);
  });

  test('one that can’t be reached says why and when it last answered, with no readings', () => {
    const machines = homeMachines([health('lab', {
      status: 'unreachable', error: 'ssh: connect to host lab port 22: Operation timed out', lastOkAt: new Date(2026, 9, 2, 7, 44).getTime(),
    })], [], { rows: [] }, 'studio');
    const children = machineTrayRows(machines, (machine) => machine, NONE_NEWER, t)[1]?.children ?? [];
    expect(children.map((item) => item.text)).toEqual(['Unreachable', expect.any(String), '', expect.stringMatching(/^Last seen at 7:44/), '', 'Open machine page']);
  });

  test('leaves out an unticked provider’s limit', () => {
    const limits = [{ provider: 'claude' as const }, { provider: 'codex' as const }];
    expect(glanceProviders(limits, hiding({ hiddenProviders: ['codex'] }))).toEqual([{ provider: 'claude' }]);
  });
});

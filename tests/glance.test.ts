import { describe, expect, test } from 'bun:test';
import { translate as t } from '../src/i18n';
import type { MachineHealth } from '../src/native/types';
import type { FleetSession } from '../src/services/fleetBoard';
import { glanceMachines, glanceProviders, machineTrayLines, type GlancePicks } from '../src/services/glance';
import { homeMachines } from '../src/services/homeOverview';

const health = (machine: string, fields: Partial<MachineHealth> = {}) => ({ machine, local: false, status: 'healthy', ...fields }) as MachineHealth;
const row = (machine: string, status: FleetSession['status']) =>
  ({ machine, status, countsAsWaiting: status === 'approval' || status === 'question', snoozedUntilMs: null }) as FleetSession;
const hiding = (hidden: Partial<GlancePicks>): GlancePicks => ({ hiddenProviders: [], hiddenMachines: [], ...hidden });

describe('the glance', () => {
  test('lists every machine with a host but those unticked, with its health and what its agents are doing', () => {
    const machines = homeMachines(
      [health('studio', { local: true }), health('lab', { status: 'unreachable' }), health('spare', { status: 'unconfigured' }), health('mini', { status: 'degraded' })],
      [],
      { rows: [row('studio', 'working'), row('studio', 'working'), row('studio', 'approval'), row('runner', 'working')] },
      'studio',
    );
    const lines = (picks: GlancePicks) => machineTrayLines(glanceMachines(machines, picks), (machine) => (machine === 'studio' ? 'Studio' : machine), t);
    // One with no address and one only known from its sessions have no health to show.
    expect(lines(hiding({}))).toEqual([
      'Studio · healthy · 2 working · 1 waiting on you',
      'lab · unreachable · idle',
      'mini · degraded · idle',
    ]);
    expect(lines(hiding({ hiddenMachines: ['lab', 'gone'] }))).toEqual(['Studio · healthy · 2 working · 1 waiting on you', 'mini · degraded · idle']);
  });

  test('leaves out an unticked provider’s limit', () => {
    const limits = [{ provider: 'claude' as const }, { provider: 'codex' as const }];
    expect(glanceProviders(limits, hiding({ hiddenProviders: ['codex'] }))).toEqual([{ provider: 'claude' }]);
  });
});

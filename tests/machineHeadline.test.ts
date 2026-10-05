import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import { machineHeadline } from '../src/pages/MachineHealthPanel';
import type { MachineHealth } from '../src/native/types';

const NOW = Date.parse('2026-10-06T09:00:00Z');
const down = (lastOkAt: number | null) => ({
  machine: 'ci-01', status: 'unreachable', error: 'ssh: connect to host ci-01 port 22: Connection refused', lastOkAt, reason: null, latest: null,
}) as MachineHealth;

describe('a machine’s headline', () => {
  it('says how long an unreachable machine has been down, when it ever answered', () => {
    expect(machineHeadline(down(NOW - 12 * 60_000), translate, NOW)).toBe('Unreachable · It refused the SSH connection. · Last answered 12m ago');
    expect(machineHeadline(down(null), translate, NOW)).toBe('Unreachable · It refused the SSH connection.');
  });
});

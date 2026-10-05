import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import { readFleetHealth, saveMachineHosts } from '../src/services/machineHealth';
import type { MachineHealthSnapshot } from '../src/native/types';

let originalWindow: PropertyDescriptor | undefined;
let reads: Record<string, unknown>[];
let failing: boolean;
// Each test starts well after the last one's reads, so none of them is still shared.
let clock = Date.parse('2026-10-05T10:00:00Z');

const snapshot = (): MachineHealthSnapshot => ({ seq: reads.length, now: Date.now(), intervalMs: 60_000, sampledAt: null, historyMs: 3_600_000, machines: [] });

beforeEach(() => {
  clock += 60_000;
  setSystemTime(new Date(clock));
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  reads = [];
  failing = false;
  mockCommands({
    get_machine_health: async (args) => {
      reads.push(args);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (failing) throw 'database is locked';
      return snapshot();
    },
    save_machine_hosts: () => [],
    track_event: () => undefined,
  });
});

afterEach(() => {
  setSystemTime();
  clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('reading the fleet’s health in the background', () => {
  it('reads once when a sampling round wakes every watcher at once', async () => {
    const answers = await Promise.all([readFleetHealth(), readFleetHealth(), readFleetHealth()]);
    // Passive, and with no history: nothing in the background charts it.
    expect(reads).toEqual([{ since: Date.now(), windowMs: 1_000, passive: true }]);
    expect(new Set(answers).size).toBe(1);
  });

  it('shares a read that just answered, and reads again two seconds on', async () => {
    const first = await readFleetHealth();
    clock += 1_500;
    setSystemTime(new Date(clock));
    expect(await readFleetHealth()).toBe(first);
    clock += 600;
    setSystemTime(new Date(clock));
    await readFleetHealth();
    expect(reads).toHaveLength(2);
  });

  it('tries again after a read that failed', async () => {
    failing = true;
    await expect(readFleetHealth()).rejects.toBe('database is locked');
    failing = false;
    await readFleetHealth();
    expect(reads).toHaveLength(2);
  });

  it('reads again once the machine list is saved', async () => {
    await readFleetHealth();
    await saveMachineHosts([]);
    await readFleetHealth();
    expect(reads).toHaveLength(2);
  });
});

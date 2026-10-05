import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import type { PoolMemberVerdict, PoolPreview } from '../src/native/types';
import { currentPools, newPool, reloadPools, subscribePools } from '../src/services/pools';

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const verdict = (share: number): PoolMemberVerdict => ({
  machine: 'cam-mbp', weight: 'normal', kind: 'eligible', running: 1, cpu: 31.6, memFree: 42.2, readingAgeMs: 2_000, share,
});
const preview = (share: number): PoolPreview => ({ pool: 'p1', likely: 'cam-mbp', members: [verdict(share)], freshForMs: 60_000, plan: ['cam-mbp'] });

afterEach(() => {
  clearMocks();
  setSystemTime();
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('the pools store', () => {
  it('tells no one about a read that changed nothing, and reads previews for the sidebar alone at most every 30 s', async () => {
    Object.defineProperty(globalThis, 'window', { value: { crypto: globalThis.crypto }, writable: true, configurable: true });
    let start = Date.parse('2026-10-05T10:30:00Z');
    setSystemTime(start);
    let previews = [preview(0.5)];
    let previewReads = 0;
    mockCommands({
      get_pools: () => [{ ...newPool(), id: 'p1', name: 'Builds' }],
      preview_pools: () => {
        previewReads += 1;
        return previews;
      },
    }, { events: true });

    let told = 0;
    const stop = subscribePools(() => told += 1);
    await settle();
    await settle();
    const loaded = currentPools();
    expect(loaded.pools).toHaveLength(1);
    expect(loaded.previews).toEqual(previews);
    const toldOnLoad = told;

    // The same answers again: the snapshot stays the very same object, and nobody renders for it.
    await reloadPools();
    expect(currentPools()).toBe(loaded);
    expect(told).toBe(toldOnLoad);

    // A sampling round straight after a read waits; one 30 seconds on reads again.
    const reads = previewReads;
    await emit('machine-health-updated', 0);
    await settle();
    expect(previewReads).toBe(reads);
    start += 30_000;
    setSystemTime(start);
    await emit('machine-health-updated', 0);
    await settle();
    expect(previewReads).toBe(reads + 1);
    expect(told).toBe(toldOnLoad);

    // Who has room changed: that one is news.
    previews = [preview(0)];
    start += 30_000;
    setSystemTime(start);
    await emit('machine-health-updated', 0);
    await settle();
    expect(previewReads).toBe(reads + 2);
    expect(told).toBe(toldOnLoad + 1);
    expect(currentPools().previews).toEqual(previews);
    expect(currentPools().pools).toBe(loaded.pools);
    stop();
  });
});

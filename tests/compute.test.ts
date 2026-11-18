import { afterEach, describe, expect, it } from 'bun:test';
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import { computeScenarioSnapshot } from '../src/dev/mock/computeScenarios';
import type { ComputeProviderSnapshot, ComputeSandbox, ComputeSnapshot } from '../src/native/types';
import {
  computeTotals,
  currentCompute,
  dollarsShown,
  formatStopsIn,
  groupSandboxes,
  limitTone,
  loadCompute,
  machineMix,
  planHours,
  planHoursGone,
  planHoursGoneLastSaid,
  planHoursTone,
  providerTone,
  startsBlockedNow,
  resetComputeStore,
  runningCount,
  sandboxFlags,
  sandboxTone,
  shortComputeSessionId,
  sizeMix,
  stopsSoon,
  subscribeCompute,
  takeComputeSnapshot,
} from '../src/services/compute';
import { computeHint, hintFor, parseComputeHint } from '../src/services/computeHint';
import { itemAt, present } from './support/items';

const NOW = Date.parse('2026-11-17T15:52:00Z');
const MINUTE = 60_000;
const typical = () => present(computeScenarioSnapshot('typical', NOW).providers[0]);
const byName = (provider: ComputeProviderSnapshot, name: string) => present(provider.sandboxes.find((sandbox) => sandbox.name === name), name);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');


describe('Compute’s figures', () => {
  it('adds up what’s running: count, vCPUs, memory and busy vCPUs over the sandboxes read', () => {
    const totals = computeTotals(typical().sandboxes);
    expect(totals.running).toBe(6);
    expect(totals.vcpus).toBe(38);
    expect(totals.memoryGb).toBe(76);
    // The starting one has no reading yet.
    expect(totals.read).toBe(5);
    expect(totals.busyVcpus).toBeCloseTo(15.98, 5);
    // What that's out of: the vCPUs read, since the starting one's 8 aren't idle, they're unknown.
    expect(totals.readVcpus).toBe(30);
    // 99% and 78% are past the machines' 75% CPU line.
    expect(totals.hot).toBe(2);
  });

  it('counts nothing stopped', () => {
    const empty = present(computeScenarioSnapshot('empty', NOW).providers[0]);
    expect(empty.sandboxes).toHaveLength(3);
    expect(computeTotals(empty.sandboxes).running).toBe(0);
    expect(runningCount(empty)).toBe(0);
    expect(sizeMix(empty.sandboxes)).toEqual([]);
  });

  it('mixes them by size, most first, and by what started them, machines then not linked then teammates', () => {
    const provider = typical();
    expect(sizeMix(provider.sandboxes).map((share) => [share.size, share.count, share.vcpus])).toEqual([['large', 4, 8], ['default', 1, 4], ['small', 1, 2]]);
    const teammate: ComputeSandbox = { ...byName(provider, 'cam-mbp-docs'), id: 'bx_team', mine: false, machine: null };
    expect(machineMix([...provider.sandboxes, teammate]).map((share) => [share.origin.kind === 'machine' ? share.origin.machine : share.origin.kind, share.count]))
      .toEqual([['cam-mbp', 1], ['cedar-02', 2], ['ci-01', 2], ['notLinked', 1], ['teammate', 1]]);
  });

  it('groups by provider, machine and size, with the ones that want a look first and then oldest first', () => {
    const provider = typical();
    const byProvider = groupSandboxes([provider], 'provider');
    expect(byProvider.map((group) => [group.key, group.sandboxes.length, group.vcpus, group.memoryGb])).toEqual([['boat', 6, 38, 76]]);
    // Forgotten, degraded and at its CPU limit by age, then the rest by age.
    expect(itemAt(byProvider, 0).sandboxes.map((sandbox) => sandbox.name)).toEqual(['ci-01-perf', 'ci-01-build', 'cam-mbp-fix-login', 'cedar-02-ci-matrix', 'cam-mbp-docs', 'cedar-02-e2e']);
    // One in error comes before any that only want a look.
    const failed = { ...provider, sandboxes: provider.sandboxes.map((sandbox): ComputeSandbox => (sandbox.name === 'cam-mbp-docs' ? { ...sandbox, state: 'error' } : sandbox)) };
    expect(itemAt(itemAt(groupSandboxes([failed], 'provider'), 0).sandboxes, 0).name).toBe('cam-mbp-docs');
    expect(groupSandboxes([provider], 'machine').map((group) => group.key)).toEqual(['machine:cam-mbp', 'machine:cedar-02', 'machine:ci-01', 'notLinked']);
    expect(groupSandboxes([provider], 'size').map((group) => [group.key, group.sandboxes.length])).toEqual([['large', 4], ['default', 1], ['small', 1]]);
  });

  it('tones limits as a warning from 80% and red only once used up, and a limit without a maximum as muted', () => {
    expect(limitTone({ used: 79, max: 100 })).toBe('primary');
    expect(limitTone({ used: 80, max: 100 })).toBe('warning');
    // Nearly full still lets sandboxes start, so it isn't red beside "New sandboxes can start".
    expect(limitTone({ used: 99, max: 100 })).toBe('warning');
    expect(limitTone({ used: 100, max: 100 })).toBe('error');
    expect(limitTone({ used: 5, max: null })).toBe('muted');
  });

  it('works out plan hours, the burn and when they run out at the current rate', () => {
    const hours = present(planHours(typical()));
    expect([hours.used, hours.max, hours.left]).toEqual([343, 555, 212]);
    // Three large running at 2×, one default at 1× and one small at 0.5×; the large one still starting uses none yet.
    expect(hours.perHour).toBe(7.5);
    expect(hours.runOutAtMs).toBeCloseTo(NOW + (212 / 7.5) * 3_600_000, -2);
    expect(hours.runsOutFirst).toBe(true);
    expect(planHoursTone(hours, NOW)).toBe('warning');
    const blocked = present(computeScenarioSnapshot('blocked', NOW).providers[0]);
    expect(planHoursTone(present(planHours(blocked)), NOW)).toBe('error');
    // Used up means starts are blocked, or sandboxes run on as extra spend, when the provider says which.
    expect(planHoursGone(blocked, NOW)).toBe('blocked');
    expect(planHoursTone(present(planHours(blocked)), NOW, 'blocked')).toBe('error');
    const paid = present(computeScenarioSnapshot('paid', NOW).providers[0]);
    expect(planHoursGone(paid, NOW)).toBe('billed');
    expect(planHoursTone(present(planHours(paid)), NOW, 'billed')).toBe('warning');
    // Not while hours are left, not when starts are blocked for another reason, not with no extra spend counted, and
    // not from an earlier read.
    expect(planHoursGone(typical(), NOW)).toBeNull();
    expect(planHoursGone({ ...blocked, startBlock: 'activeMax' }, NOW)).toBeNull();
    expect(planHoursGone({ ...paid, limits: paid.limits.filter((limit) => limit.kind !== 'extraSpend') }, NOW)).toBeNull();
    expect(planHoursGone({ ...paid, status: 'unreachable' }, NOW)).toBeNull();
    expect(planHoursGone({ ...blocked, status: 'refused' }, NOW)).toBeNull();
    // The color keeps to the last answer: hours that were only billed don't turn red because the provider went quiet.
    expect(planHoursGoneLastSaid({ ...paid, status: 'unreachable' })).toBe('billed');
    const idle = present(planHours(present(computeScenarioSnapshot('empty', NOW).providers[0])));
    expect([idle.runOutAtMs, idle.runsOutFirst]).toEqual([null, false]);
    expect(planHoursTone(idle, NOW)).toBe('primary');
    // A key that can't read limits has no plan hours to show.
    expect(planHours(present(computeScenarioSnapshot('limits', NOW).providers[0]))).toBeNull();
  });

  it('hides dollars while every cost is $0', () => {
    const provider = typical();
    expect(dollarsShown([provider])).toBe(false);
    const paid = { ...provider, sandboxes: [{ ...byName(provider, 'ci-01-build'), monthDollars: 1.2 }] };
    expect(dollarsShown([paid])).toBe(true);
  });

  it('writes when a sandbox stops, and none for no auto-stop', () => {
    const provider = typical();
    expect(formatStopsIn(byName(provider, 'cedar-02-ci-matrix'), NOW)).toBe('55m');
    expect(formatStopsIn(byName(provider, 'cam-mbp-fix-login'), NOW)).toBe('2h 48m');
    expect(formatStopsIn(byName(provider, 'ci-01-perf'), NOW)).toBeNull();
    expect(stopsSoon(byName(provider, 'cedar-02-ci-matrix'), NOW + 45 * MINUTE)).toBe(true);
    expect(stopsSoon(byName(provider, 'cedar-02-ci-matrix'), NOW)).toBe(false);
  });

  it('flags what wants a look, and nothing on a stopped sandbox or for a teammate’s forgotten one', () => {
    const provider = typical();
    expect(sandboxFlags(byName(provider, 'cam-mbp-fix-login'))).toEqual(['cpuAtLimit']);
    expect(sandboxFlags(byName(provider, 'ci-01-perf'))).toEqual(['forgotten']);
    expect(sandboxFlags(byName(provider, 'ci-01-build'))).toEqual(['degraded']);
    expect(sandboxFlags(byName(provider, 'cedar-02-e2e'))).toEqual(['starting']);
    expect(sandboxFlags({ ...byName(provider, 'ci-01-build'), state: 'stopped' })).toEqual([]);
    expect(sandboxFlags({ ...byName(provider, 'ci-01-perf'), mine: false })).toEqual([]);
    // The sidebar's dot is as amber as the rows: one at its CPU limit, one forgotten and one degraded all want a look,
    // and none of them has stopped. One in error is red. A teammate's sandbox never colors the dot, as it never shows
    // on Home or alerts.
    expect(providerTone(provider, NOW)).toBe('warning');
    expect(sandboxTone(byName(provider, 'cam-mbp-fix-login'))).toBe('warning');
    const failed = { ...provider, sandboxes: provider.sandboxes.map((sandbox): ComputeSandbox => (sandbox.name === 'cam-mbp-docs' ? { ...sandbox, state: 'error' } : sandbox)) };
    expect(providerTone(failed, NOW)).toBe('error');
    expect(providerTone({ ...provider, sandboxes: provider.sandboxes.map((sandbox) => ({ ...sandbox, mine: false })) }, NOW)).toBe('success');
    expect(providerTone({ ...provider, status: 'unreachable' }, NOW)).toBe('warning');
    // Blocked starts from a provider that isn't answering are an earlier read's: amber for not answering, not red.
    const blocked = present(computeScenarioSnapshot('blocked', NOW).providers[0]);
    expect(providerTone({ ...blocked, status: 'unreachable' }, NOW)).toBe('warning');
    // Asked to slow down: red while the list that said so is a moment old, amber once it's an earlier read's too.
    expect(providerTone({ ...blocked, status: 'rateLimited', checkedAtMs: NOW - 60_000 }, NOW)).toBe('error');
    expect(providerTone({ ...blocked, status: 'rateLimited', checkedAtMs: NOW - 10 * 60_000 }, NOW)).toBe('warning');
    // One rule says whether blocked starts are still claimed, and a key turned down leaves an earlier read's too.
    expect(startsBlockedNow(blocked, NOW)).toBe(true);
    expect(startsBlockedNow({ ...blocked, status: 'refused' }, NOW)).toBe(false);
    expect(startsBlockedNow({ ...blocked, status: 'unreachable' }, NOW)).toBe(false);
    expect(providerTone(present(computeScenarioSnapshot('blocked', NOW).providers[0]), NOW)).toBe('error');
    expect(providerTone(present(computeScenarioSnapshot('empty', NOW).providers[0]), NOW)).toBe('muted');
  });

  it('shortens a session id: a UUID to its first block, a long other id to eight characters', () => {
    expect(shortComputeSessionId('3f2a91c4-7b1e-4c2d-9a10-5e6f7a8b9c01')).toBe('3f2a91c4');
    expect(shortComputeSessionId('run-42')).toBe('run-42');
    expect(shortComputeSessionId('thread_0123456789abcdef')).toBe('thread_0…');
  });
});

describe('the connected hint', () => {
  afterEach(async () => {
    takeComputeSnapshot({ providers: [] });
    // Clearing the hint stops the store, whose unlisten needs `window` until it settles.
    await resetComputeStore();
    if (typeof window !== 'undefined') clearMocks();
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  it('keeps only known provider ids, each once', () => {
    expect(parseComputeHint(null)).toEqual([]);
    expect(parseComputeHint('["boat","fly","boat",3]')).toEqual(['boat']);
    expect(parseComputeHint('"boat"')).toEqual([]);
    expect(() => parseComputeHint('not json')).toThrow();
    expect(hintFor({ providers: [] })).toEqual([]);
    expect(hintFor(computeScenarioSnapshot('typical', NOW))).toEqual(['boat']);
  });

  it('calls nothing with no provider connected, starts reading once one is, and stops when the last goes', async () => {
    Object.defineProperty(globalThis, 'window', { value: { crypto: globalThis.crypto }, writable: true, configurable: true });
    let reads = 0;
    const snapshot: ComputeSnapshot = computeScenarioSnapshot('typical', NOW);
    const calls = mockCommands({ get_compute: () => { reads += 1; return snapshot; } }, { events: true });

    const stop = subscribeCompute(() => undefined);
    await settle();
    expect(computeHint.get()).toEqual([]);
    expect(calls).toHaveLength(0);

    // A connect's answer names the provider: the hint follows, and the store reads once and listens.
    takeComputeSnapshot(snapshot);
    await settle();
    expect(computeHint.get()).toEqual(['boat']);
    expect(reads).toBe(1);
    expect(currentCompute().snapshot?.providers).toHaveLength(1);

    // Rust is the truth: a round that says nothing is connected puts the hint right.
    await emit('compute-updated', { providers: [] });
    await settle();
    expect(computeHint.get()).toEqual([]);
    expect(currentCompute().snapshot?.providers).toEqual([]);
    stop();
  });

  it('puts back a lost hint when Settings › Compute asks Rust, which still holds a key', async () => {
    // What ComputeSettingsPage does on open, whatever the hint says.
    Object.defineProperty(globalThis, 'window', { value: { crypto: globalThis.crypto }, writable: true, configurable: true });
    const calls = mockCommands({ get_compute: () => computeScenarioSnapshot('typical', NOW) }, { events: true });
    expect(computeHint.get()).toEqual([]);
    await loadCompute();
    expect(calls.map((call) => call.command)).toContain('get_compute');
    expect(computeHint.get()).toEqual(['boat']);
    expect(currentCompute().snapshot?.providers.map((provider) => provider.id)).toEqual(['boat']);
  });
});

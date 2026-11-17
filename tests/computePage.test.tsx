import { afterEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ringFor } from '../src/components/compute/LoadChart';
import { openingGrouping, resetSandboxTableGrouping } from '../src/components/compute/SandboxTable';
import { SandboxView } from '../src/components/compute/SandboxView';
import { computeScenarioSnapshot, mockHistory, type ComputeScenario } from '../src/dev/mock/computeScenarios';
import { I18nProvider } from '../src/i18n';
import type { ComputePoint, ComputeProviderSnapshot, ComputeSandbox, MachineHealth } from '../src/native/types';
import { ComputeOverview, ComputePage } from '../src/pages/ComputePage';
import { groupSandboxes, resetComputeStore, takeComputeSnapshot, type ComputeGrouping } from '../src/services/compute';
import { computeHint } from '../src/services/computeHint';
import {
  agentsFigure,
  COMPUTE_PAGE_SIZE,
  cpuAtLimitForMs,
  flagCounts,
  groupRowCount,
  loadSeries,
  machinesCpu,
  mergeHistory,
  mostPressingPlanHours,
  pageOfGroups,
  tableGroups,
} from '../src/services/computePage';
import { present } from './support/items';

const NOW = Date.parse('2026-11-17T15:52:00Z');
const MINUTE = 60_000;
const providerOf = (scenario: ComputeScenario) => present(computeScenarioSnapshot(scenario, NOW).providers[0], scenario);
const byName = (provider: ComputeProviderSnapshot, name: string) => present(provider.sandboxes.find((sandbox) => sandbox.name === name), name);
const point = (minutesAgo: number, cpu: number, memory = 0.5): ComputePoint => ({ atMs: NOW - minutesAgo * MINUTE, cpu, memory });
const noop = () => undefined;

const overviewOf = (provider: ComputeProviderSnapshot, grouping?: ComputeGrouping) => renderToStaticMarkup(
  <I18nProvider><ComputeOverview providers={[provider]} grouping={grouping} nowMs={NOW} onNavigate={noop} /></I18nProvider>,
);
const overview = (scenario: ComputeScenario, grouping?: ComputeGrouping) => overviewOf(providerOf(scenario), grouping);
const sandboxPage = (provider: ComputeProviderSnapshot, sandbox: ComputeSandbox) => renderToStaticMarkup(
  <I18nProvider><SandboxView provider={provider.id} sandbox={sandbox} nowMs={NOW} onNavigate={noop} /></I18nProvider>,
);
const rows = (html: string) => html.match(/data-sandbox="/g)?.length ?? 0;

afterEach(async () => {
  await resetComputeStore();
  resetSandboxTableGrouping();
  computeHint.set([]);
});

describe('the Compute page’s figures', () => {
  it('counts the agents behind the running sandboxes: live sessions once each, the ones left behind, the unlinked', () => {
    expect(agentsFigure(providerOf('typical').sandboxes)).toEqual({ liveSessions: 4, leftBehind: 1, notLinked: 1, own: 6 });
    // Teammates' sandboxes are never linked, so they count neither way.
    const big = agentsFigure(providerOf('big').sandboxes);
    expect(big.own).toBeLessThan(100);
    expect(agentsFigure(providerOf('unlinked').sandboxes).notLinked).toBe(6);
  });

  it('counts the flags the table’s head shows', () => {
    expect(flagCounts(providerOf('typical').sandboxes)).toEqual({ cpuAtLimit: 1, forgotten: 1, degraded: 1 });
    expect(flagCounts(providerOf('empty').sandboxes)).toEqual({ cpuAtLimit: 0, forgotten: 0, degraded: 0 });
  });

  it('pages a long table in its groups, each heading keeping its whole group’s figures', () => {
    const groups = tableGroups([providerOf('big')], 'machine', false);
    expect(groupRowCount(groups)).toBe(100);
    const first = pageOfGroups(groups, 1, COMPUTE_PAGE_SIZE);
    const second = pageOfGroups(groups, 2, COMPUTE_PAGE_SIZE);
    expect(groupRowCount(first)).toBe(50);
    expect(groupRowCount(second)).toBe(50);
    // No row is on both pages, and none is lost.
    const ids = [...first, ...second].flatMap((group) => group.sandboxes.map((sandbox) => sandbox.id));
    expect(new Set(ids).size).toBe(100);
    expect(pageOfGroups(groups, 3, COMPUTE_PAGE_SIZE)).toEqual([]);
  });

  it('adds the stopped sandboxes as their own group only when asked', () => {
    const empty = [providerOf('empty')];
    expect(tableGroups(empty, 'provider', false)).toEqual([]);
    const shown = tableGroups(empty, 'provider', true);
    expect(shown.map((group) => group.kind)).toEqual(['stopped']);
    expect(present(shown[0]).sandboxes).toHaveLength(3);
    expect(groupSandboxes(empty, 'provider')).toEqual([]);
  });

  it('picks the plan hours closest to trouble when several providers report them', () => {
    const fine = providerOf('typical');
    const near = providerOf('near');
    expect(mostPressingPlanHours([fine, near], NOW)?.hours.left).toBe(4);
    expect(mostPressingPlanHours([providerOf('limits')], NOW)).toBeNull();
  });

  it('adds up the machines’ CPU from the health Arbor already reads, and nothing without it', () => {
    const machine = (cores: number, cpu: number | null) => ({ facts: { cores }, latest: { cpu } }) as unknown as MachineHealth;
    expect(machinesCpu([machine(10, 50), machine(8, 25), machine(4, null)])).toEqual({ busy: 7, cores: 18 });
    expect(machinesCpu(null)).toBeNull();
    expect(machinesCpu([machine(4, null)])).toBeNull();
  });
});

describe('a sandbox’s load over time', () => {
  it('adds the snapshot’s newest readings to the ring once, in order, and keeps the same array when none are new', () => {
    const ring = [point(3, 0.1), point(2, 0.2)];
    expect(mergeHistory(ring, [point(2, 0.2)])).toBe(ring);
    const merged = mergeHistory(ring, [point(2, 0.2), point(1, 0.3), point(0, 0.4)]);
    expect(merged.map((entry) => entry.cpu)).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(mergeHistory(merged, [point(-1, 0.5)], 3).map((entry) => entry.cpu)).toEqual([0.3, 0.4, 0.5]);
  });

  it('breaks the lines where readings are missing, and names the gap', () => {
    const sandbox = byName(providerOf('typical'), 'cedar-02-ci-matrix');
    const history = mockHistory(sandbox, NOW);
    const { cpu, memory, gaps } = loadSeries(history);
    expect(gaps).toHaveLength(1);
    const gap = present(gaps[0]);
    // Readings 70 to 60 minutes ago are missing, so 71 and 59 minutes ago sit either side.
    expect(gap.to - gap.from).toBe(12 * MINUTE);
    expect(cpu.filter((entry) => entry.v === null)).toHaveLength(1);
    expect(memory).toHaveLength(cpu.length);
    // Percents on the chart's 0–100 axis.
    expect(Math.max(...cpu.map((entry) => entry.v ?? 0))).toBeLessThanOrEqual(100);
    expect(loadSeries([]).gaps).toEqual([]);
  });

  it('says how long CPU has sat at its limit, from the latest reading back to the first below it or a gap', () => {
    expect(cpuAtLimitForMs([point(8, 0.5), point(7, 0.99), point(6, 0.99), point(5, 1)].map((entry, index) => ({ ...entry, atMs: NOW - (3 - index) * MINUTE })))).toBe(3 * MINUTE);
    expect(cpuAtLimitForMs([point(2, 0.99), point(1, 0.99), point(0, 0.4)])).toBeNull();
    // A gap ends the run: nobody knows what CPU did then.
    expect(cpuAtLimitForMs([point(20, 0.99), point(1, 0.99), point(0, 0.99)])).toBe(2 * MINUTE);
    expect(cpuAtLimitForMs([])).toBeNull();
  });
});

describe('Fleet › Compute', () => {
  it('shows the prototype’s afternoon: the stats, every flag, the limits and what’s running', () => {
    const html = overview('typical');
    for (const text of ['Agents using them', 'live sessions', '1 whose session ended', '1 not linked', 'Busy vCPU', 'Plan hours left',
      'cam-mbp-fix-login', 'CPU at its limit', 'Looks forgotten', 'Degraded · disk pressure', 'Starting', 'Not linked', 'ended 41m ago',
      '1 at CPU limit', '1 forgotten', '1 degraded', 'Group by', 'No auto-stop', '2.4 h',
      'Running sandboxes', 'Starts this minute', '343 of 555 used', 'Counted from the list', 'New sandboxes can start',
      'What’s running', 'By type', 'Started from', 'CPU in use now']) {
      expect(html).toContain(text);
    }
    expect(rows(html)).toBe(6);
    // The starting sandbox has no reading yet.
    expect(html).toContain('Not read yet');
    // Boat doesn't say what the key can do, so the limits claim nothing about it.
    expect(html).not.toContain('Read-only key');
    expect(overview('readonlykey')).toContain('Read-only key');
  });

  it('draws the mock’s trouble: a sandbox in error, one stopping and one kept alive', () => {
    const provider = providerOf('trouble');
    expect(provider.status).toBe('rateLimited');
    expect(provider.sandboxes.map((sandbox) => sandbox.state)).toContain('stopping');
    expect(byName(provider, 'cam-mbp-fix-login').forgotten).toBe('keptAlive');
    const html = overview('trouble');
    expect(html).toContain('In error');
    expect(html).toContain('Looks forgotten');
    const keptAlive = byName(provider, 'cam-mbp-fix-login');
    expect(sandboxPage(provider, keptAlive)).toContain('more than twice its auto-stop time');
    expect(sandboxPage(provider, byName(provider, 'cedar-02-ci-matrix'))).toContain('Stopping');
  });

  it('marks a stopping sandbox in its row as a starting one is, and never blames the key for one with no reading to give', () => {
    const provider = providerOf('trouble');
    const stopping = byName(provider, 'cedar-02-ci-matrix');
    const failed = byName(provider, 'cam-mbp-docs');
    // As Rust gives them: neither has a reading.
    expect(stopping.load.kind).toBe('unavailable');
    expect(failed.load.kind).toBe('unavailable');
    const row = overviewOf({ ...provider, sandboxes: [stopping] });
    expect(row).toContain('Stopping');
    expect(row).toContain('animate-status-pulse');
    expect(row).not.toContain('Key can’t read load');
    expect(overviewOf({ ...provider, sandboxes: [failed] })).not.toContain('Key can’t read load');
    expect(sandboxPage(provider, failed)).not.toContain('Key can’t read load');
  });

  it('shows dollars and the extra spend once sandboxes cost something', () => {
    expect(overview('typical')).not.toContain('Extra spend');
    const html = overview('paid');
    expect(html).toContain('This month');
    expect(html).toContain('Extra spend');
  });

  it('pages a hundred sandboxes, fifty to a page, and draws the readings it can’t take', () => {
    const html = overview('big');
    expect(rows(html)).toBe(50);
    expect(html).toContain('Monitoring off');
    expect(html).toContain('Key can’t read load');
    expect(html).toContain('Linked to a machine Arbor doesn’t know');
    expect(html).toContain('Arbor hasn’t seen this session');
    expect(html).toContain('A teammate’s');
  });

  it('dims an earlier read’s figures and says how old they are when the provider isn’t answering', () => {
    const html = overview('unreachable');
    expect(html).toContain('Couldn’t reach Boat. These figures were read 14m ago.');
    expect(html).toContain('Try again');
    expect(html).toContain('opacity-60');
    expect(overview('typical')).not.toContain('opacity-60');
  });

  it('says a provider asked Arbor to slow down in its own words, offers no Try again, and dims only a list that is old', () => {
    const trouble = providerOf('trouble');
    expect(trouble.status).toBe('rateLimited');
    const html = overviewOf(trouble);
    expect(html).toContain('Boat asked Arbor to check less often');
    expect(html).not.toContain('Couldn’t reach');
    expect(html).not.toContain('Try again');
    // Its list is three minutes old: an earlier read's.
    expect(html).toContain('opacity-60');
    // A 429 on CPU and memory alone, with the list just read: the sandboxes are current.
    expect(overviewOf({ ...trouble, checkedAtMs: NOW - 20_000 })).not.toContain('opacity-60');
  });

  it('says quietly when a provider’s list stopped short, alongside any other banner', () => {
    const partial = overview('partial');
    expect(partial).toContain('Boat has more sandboxes than Arbor reads at once, so some older ones may be missing here.');
    expect(overview('typical')).not.toContain('some older ones may be missing');
    const both = overviewOf({ ...providerOf('limits'), listPartial: true });
    expect(both).toContain('some older ones may be missing');
    expect(both).toContain('This key can’t read Boat’s limits.');
  });

  it('points a refused key to Settings, and says when the key can’t read the limits', () => {
    const refused = overview('refused');
    expect(refused).toContain('Boat turned down Arbor’s key');
    expect(refused).toContain('Open Settings');
    const limits = overview('limits');
    // The scope's name comes from the provider's record, not a shared string.
    expect(limits).toContain('This key can’t read Boat’s limits. A key with account.read can.');
    expect(limits).not.toContain('Starts this minute');
  });

  it('asks for links when nothing is linked, and says starts are blocked and why', () => {
    expect(overview('unlinked')).toContain('How to link');
    expect(overview('typical')).not.toContain('How to link');
    expect(overview('blocked')).toContain('Starts blocked · Plan hours used up');
  });

  it('says nothing is running, with the stopped ones behind a disclosure', () => {
    const html = overview('empty');
    expect(html).toContain('Nothing running');
    expect(html).toContain('3 stopped this month');
    expect(html).toContain('Show stopped (3)');
    expect(html).not.toContain('What’s running');
    expect(rows(html)).toBe(0);
  });

  it('waits for the first read, and with no provider points to Settings', () => {
    const render = () => renderToStaticMarkup(<I18nProvider><ComputePage params={{}} onNavigate={noop} /></I18nProvider>);
    computeHint.set(['boat']);
    expect(render()).toContain('Reading Compute…');
    takeComputeSnapshot({ providers: [] });
    expect(render()).toContain('No provider connected');
  });

  it('points to Settings rather than wait for ever when nothing is connected, as an old alert can lead here', () => {
    // With no provider saved the store never asks Rust, so no snapshot is coming.
    computeHint.set([]);
    const html = renderToStaticMarkup(<I18nProvider><ComputePage params={{ provider: 'boat', sandbox: 'bx_4k2m9xqa' }} onNavigate={noop} /></I18nProvider>);
    expect(html).toContain('No provider connected');
    expect(html).toContain('Open Settings');
    expect(html).not.toContain('Reading Compute…');
  });

  it('opens grouped the way the view asks, as a machine’s page asks for by machine, and keeps the grouping it was left on', () => {
    const byProvider = overview('typical');
    expect(byProvider).toMatch(/\d+ running · \d+ vCPU · \d+ GB/);
    const byMachine = overview('typical', 'machine');
    expect(byMachine).toMatch(/\d+ sandboxes · \d+ vCPU/);
    expect(byMachine).not.toMatch(/\d+ running · \d+ vCPU · \d+ GB/);
    // Back to Compute with no grouping named: still by machine.
    expect(overview('typical')).toMatch(/\d+ sandboxes · \d+ vCPU/);
    expect(openingGrouping(undefined)).toBe('machine');
    expect(openingGrouping('size')).toBe('size');
    expect(openingGrouping(undefined)).toBe('size');
  });

  it('counts how long a sandbox has run from its last resume, not when it was first made', () => {
    const typical = providerOf('typical');
    const docs = byName(typical, 'cam-mbp-docs');
    const resumed = { ...docs, createdAtMs: NOW - 3 * 24 * 60 * MINUTE, startedAtMs: NOW - 5 * MINUTE };
    const html = overviewOf({ ...typical, sandboxes: [resumed] });
    expect(html).toContain('>5m<');
    expect(html).not.toContain('3d');
    expect(sandboxPage(typical, resumed)).toContain('running for 5m');
  });

  it('says a sandbox that has gone is gone', () => {
    takeComputeSnapshot(computeScenarioSnapshot('typical', NOW));
    const html = renderToStaticMarkup(<I18nProvider><ComputePage params={{ provider: 'boat', sandbox: 'bx_gone' }} onNavigate={noop} /></I18nProvider>);
    expect(html).toContain('This sandbox isn’t running any more');
    expect(html).toContain('Back to Compute');
  });
});

describe('a sandbox’s own page', () => {
  const typical = providerOf('typical');

  it('heads the page with its state and size, copy and open, then its stats, the chart and what started it', () => {
    const html = sandboxPage(typical, byName(typical, 'cam-mbp-fix-login'));
    for (const text of ['cam-mbp-fix-login', 'Running · 8 vCPU · 16 GB · 2× plan hours', 'Copy ID', 'Open in Boat',
      '99', 'of 8 vCPU busy', 'About 9.8 of 16 GB', '2h 48m', 'Uses 2 plan hours for each hour it runs',
      'at its limit', 'Load', 'Arbor keeps the last two hours', 'Show as a table', 'CPU and memory for cam-mbp-fix-login',
      'Started by', 'cam-mbp', '3f2a91c4', 'live', 'You', 'Unlink', 'Details', 'Healthy', 'bx_4k2m9xqa']) {
      expect(html).toContain(text);
    }
  });

  it('says no shared string names a provider’s own facts', () => {
    const html = sandboxPage(typical, byName(typical, 'cam-mbp-fix-login'));
    expect(html).not.toContain('keeps no history');
  });

  it('says why it looks forgotten, and what’s wrong when it’s degraded', () => {
    const perf = byName(typical, 'ci-01-perf');
    expect(sandboxPage(typical, perf)).toContain('The session that started this ended 41m ago, so it keeps using plan hours until someone stops it.');
    // One whose auto-stop is set stops by itself; it never says someone has to stop it.
    const stops = sandboxPage(typical, { ...perf, stopsAtMs: NOW + 50 * MINUTE });
    expect(stops).toContain('It keeps using plan hours until it stops by itself');
    expect(stops).not.toContain('until someone stops it');
    expect(sandboxPage(typical, byName(typical, 'ci-01-build'))).toContain('Degraded · disk pressure for 7m');
  });

  it('has no chart before the first reading, and says why when it can’t have one', () => {
    expect(sandboxPage(typical, byName(typical, 'cedar-02-e2e'))).toContain('Load shows once the sandbox has started and been read.');
    const big = providerOf('big');
    const off = present(big.sandboxes.find((sandbox) => sandbox.load.kind === 'monitoringOff'));
    expect(sandboxPage(big, off)).toContain('Monitoring off');
  });

  it('offers Unlink only for a link the command line made, never for one its provider’s labels made', () => {
    const fixLogin = byName(typical, 'cam-mbp-fix-login');
    expect(fixLogin.linkedBy).toBe('link');
    expect(sandboxPage(typical, fixLogin)).toContain('Unlink');
    const labelled = sandboxPage(typical, { ...fixLogin, linkedBy: 'label' });
    expect(labelled).toContain('cam-mbp');
    expect(labelled).not.toContain('Unlink');
  });

  it('never draws one sandbox’s readings under another’s name', () => {
    const ring = { key: 'boat/bx_a', points: [point(2, 0.9), point(1, 0.9)] };
    expect(ringFor(ring, 'boat/bx_a')).toBe(ring.points);
    expect(ringFor(ring, 'boat/bx_b')).toEqual([]);
  });

  it('offers a way to link one that isn’t, and keeps a teammate’s to its owner', () => {
    const docs = sandboxPage(typical, byName(typical, 'cam-mbp-docs'));
    expect(docs).toContain('How to link');
    expect(docs).not.toContain('Unlink');
    const big = providerOf('big');
    const teammate = sandboxPage(big, present(big.sandboxes.find((sandbox) => !sandbox.mine)));
    expect(teammate).toContain('A teammate');
    expect(teammate).not.toContain('Session');
  });
});

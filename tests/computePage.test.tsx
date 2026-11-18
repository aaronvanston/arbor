import { afterEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoadChart, ringFor } from '../src/components/compute/LoadChart';
import { openingGrouping, resetSandboxTableGrouping } from '../src/components/compute/SandboxTable';
import { SandboxView } from '../src/components/compute/SandboxView';
import { computeScenarioSnapshot, mockHistory, type ComputeScenario } from '../src/dev/mock/computeScenarios';
import { I18nProvider } from '../src/i18n';
import type { ComputePoint, ComputeProviderSnapshot, ComputeSandbox, MachineHealth } from '../src/native/types';
import { ComputeOverview, ComputePage } from '../src/pages/ComputePage';
import { groupSandboxes, resetComputeStore, sandboxFlags, takeComputeSnapshot, type ComputeGrouping } from '../src/services/compute';
import { computeHint } from '../src/services/computeHint';
import {
  agentsFigure,
  COMPUTE_PAGE_SIZE,
  loadNeedsKey,
  cpuAtLimitForMs,
  flagCounts,
  groupRowCount,
  loadSeries,
  machinesCpu,
  mergeHistory,
  mostPressingPlanHours,
  narrowProviders,
  pageOfGroups,
  sandboxCommands,
  sessionEndedNoteAtMs,
  tableGroups,
} from '../src/services/computePage';
import { present } from './support/items';

const NOW = Date.parse('2026-11-17T15:52:00Z');
const MINUTE = 60_000;
const providerOf = (scenario: ComputeScenario) => present(computeScenarioSnapshot(scenario, NOW).providers[0], scenario);
const byName = (provider: ComputeProviderSnapshot, name: string) => present(provider.sandboxes.find((sandbox) => sandbox.name === name), name);
const point = (minutesAgo: number, cpu: number, memory = 0.5): ComputePoint => ({ atMs: NOW - minutesAgo * MINUTE, cpu, memory });
const noop = () => undefined;

const overviewOf = (provider: ComputeProviderSnapshot, grouping?: ComputeGrouping, machine?: string) => renderToStaticMarkup(
  <I18nProvider><ComputeOverview providers={[provider]} grouping={grouping} machine={machine} nowMs={NOW} onNavigate={noop} /></I18nProvider>,
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

  it('narrows to a flag or to one machine’s sandboxes, and drops a filter nothing running matches', () => {
    const typical = providerOf('typical');
    const names = (providers: readonly ComputeProviderSnapshot[]) => providers.flatMap((provider) => provider.sandboxes.map((sandbox) => sandbox.name));
    const forgotten = narrowProviders([typical], { kind: 'flag', flag: 'forgotten' });
    expect(names(forgotten.providers)).toEqual(['ci-01-perf']);
    // The groups and their totals follow the filter.
    expect(tableGroups(forgotten.providers, 'provider', false).map((group) => [group.sandboxes.length, group.vcpus])).toEqual([[1, 8]]);
    const machine = narrowProviders([typical], { kind: 'machine', machine: 'ci-01' });
    expect(names(machine.providers).sort()).toEqual(['ci-01-build', 'ci-01-perf']);
    expect(machine.filter).toEqual({ kind: 'machine', machine: 'ci-01' });
    // A teammate's sandbox is nobody's machine's here, whatever it names.
    const theirs = { ...typical, sandboxes: typical.sandboxes.map((sandbox) => ({ ...sandbox, mine: false })) };
    expect(narrowProviders([theirs], { kind: 'machine', machine: 'ci-01' })).toEqual({ providers: [theirs], filter: null });
    // The flag cleared, or the machine's sandboxes all stopped: every sandbox again, and no filter.
    const calm = providerOf('working');
    expect(narrowProviders([calm], { kind: 'flag', flag: 'forgotten' })).toEqual({ providers: [calm], filter: null });
    const stopped = { ...typical, sandboxes: typical.sandboxes.map((sandbox): ComputeSandbox => (sandbox.machine === 'ci-01' ? { ...sandbox, state: 'stopped' } : sandbox)) };
    expect(narrowProviders([stopped], { kind: 'machine', machine: 'ci-01' }).filter).toBeNull();
    expect(narrowProviders([typical], null)).toEqual({ providers: [typical], filter: null });
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
      'What’s running', 'By size', 'Started from', 'CPU in use now']) {
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

  it('says what used-up plan hours mean: starts blocked in red, or running on as extra spend in amber', () => {
    const limitCell = (html: string) => html.slice(html.indexOf('data-limit="planHours"')).split('data-limit=')[1] ?? '';
    const blocked = overview('blocked');
    expect(blocked).toContain('Used up, so new sandboxes can’t start. Resets ');
    expect(limitCell(blocked)).toContain('text-destructive-foreground');
    const paid = overview('paid');
    expect(paid).toContain('Used up. Sandboxes now run as extra spend. Resets ');
    expect(paid).toContain('New sandboxes can start');
    // Nothing red about plan hours beside "New sandboxes can start".
    expect(limitCell(paid)).toContain('text-warning-foreground');
    expect(limitCell(paid)).not.toContain('text-destructive-foreground');
    // When the provider doesn't say which, only that they're gone.
    const unsaid = overviewOf({ ...providerOf('paid'), canStart: null });
    expect(unsaid).toContain('Used up. Resets ');
    expect(unsaid).not.toContain('extra spend.');
    // A limit that is nearly full is a warning; red waits for full.
    const near = overview('near');
    const limits = near.slice(near.indexOf('data-limit="activeSandboxes"'), near.indexOf('What’s running'));
    expect(limits).toContain('text-warning-foreground');
    expect(limits).not.toContain('text-destructive-foreground');
  });

  it('pages a hundred sandboxes, fifty to a page, and draws the readings it can’t take', () => {
    const html = overview('big');
    expect(rows(html)).toBe(50);
    expect(html).toContain('Monitoring off');
    // A running sandbox with no sample to give says so without blaming the key; only a refused key does.
    expect(html).toContain('No reading right now');
    expect(html).not.toContain('Key can’t read load');
    expect(overview('noload')).toContain('Key can’t read load');
    expect(html).toContain('Linked to a machine Arbor doesn’t know');
    expect(html).toContain('Arbor hasn’t seen this session');
    expect(html).toContain('A teammate’s');
  });

  it('dims an earlier read’s figures and says how old they are when the provider isn’t answering', () => {
    const html = overview('unreachable');
    // The top bar carries the age; the banner doesn't give a second one.
    expect(html).toContain('Couldn’t reach Boat. These are the last figures it gave.');
    // Nothing an earlier read can't vouch for is said as if it were now's: no "can start", no run-out forecast.
    expect(html).not.toContain('New sandboxes can start');
    expect(html).not.toContain('at the current rate');
    expect(overview('typical')).toContain('New sandboxes can start');
    expect(overview('typical')).toContain('at the current rate');
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
    // Both lead to the key, and the plan hours tile blames the key, not the provider.
    expect(limits).toContain('Open Settings');
    expect(limits).toContain('This key can’t read them');
    expect(limits).not.toContain('No connected provider reports plan hours');
  });

  it('says once, above the figures, that the key is why CPU and memory are blank, and counts nothing unread as idle', () => {
    const html = overview('noload');
    expect(html).toContain('This key can’t read CPU and memory from Boat. Settings › Compute shows the key that can.');
    expect(html).toContain('Open Settings');
    expect(loadNeedsKey(providerOf('noload'))).toBe(true);
    // Unread vCPUs aren't idle ones: no "0 of 38" for the sandboxes.
    expect(html).not.toContain('>0</span> of');
    // Nor is one that's still starting: 16 busy of the 30 vCPUs read, not of all 38.
    expect(overview('typical')).toContain('>16</span> of 30');
    expect(overview('typical')).not.toContain('>16</span> of 38');
    // One reading is enough to know the key can read, and a sandbox with no sample isn't the key's doing.
    expect(loadNeedsKey(providerOf('typical'))).toBe(false);
    expect(loadNeedsKey(providerOf('big'))).toBe(false);
    expect(loadNeedsKey(providerOf('empty'))).toBe(false);
    expect(overview('typical')).not.toContain('This key can’t read CPU and memory');
  });

  it('asks for links when nothing is linked, and says starts are blocked and why', () => {
    expect(overview('unlinked')).toContain('How to link');
    expect(overview('typical')).not.toContain('How to link');
    // Said at the top, where the eye lands, and still beside the limits.
    const blocked = overview('blocked');
    expect(blocked).toContain('Plan hours used up, so Boat isn’t letting new sandboxes start. Agents that need one will fail until that changes.');
    expect(blocked).toContain('Starts blocked · Plan hours used up');
    expect(blocked.indexOf('so Boat isn’t letting new sandboxes start')).toBeLessThan(blocked.indexOf('Plan hours left'));
    // A reason Arbor has no words for isn't forced into the sentence.
    expect(overviewOf({ ...providerOf('blocked'), startBlock: 'other' })).toContain('Boat isn’t letting new sandboxes start. Agents that need one will fail until that changes.');
    expect(overview('typical')).not.toContain('isn’t letting new sandboxes start');
    // A list read a moment ago while Boat asks Arbor to slow down still says starts are blocked; one that isn't
    // answering doesn't, since that's an earlier read's.
    const slowed = overviewOf({ ...providerOf('blocked'), status: 'rateLimited', checkedAtMs: NOW });
    expect(slowed).toContain('so Boat isn’t letting new sandboxes start');
    expect(overviewOf({ ...providerOf('blocked'), status: 'unreachable' })).not.toContain('so Boat isn’t letting new sandboxes start');
    // Before anything was ever read there are no "last figures" to speak of.
    expect(overviewOf({ ...providerOf('typical'), status: 'unreachable', checkedAtMs: null, sandboxes: [] })).toContain('Couldn’t reach Boat.</');
    expect(overviewOf({ ...providerOf('typical'), status: 'refused', checkedAtMs: null, sandboxes: [] })).toContain('Boat turned down Arbor’s key. Replace the key in Settings › Compute.');
    const slowedFirst = overviewOf({ ...providerOf('typical'), status: 'rateLimited', checkedAtMs: null, canStart: null, sandboxes: [] });
    expect(slowedFirst).toContain('Boat asked Arbor to check less often before anything was read. Arbor tries again shortly.');
    expect(slowedFirst).not.toContain('a few minutes old');
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

  it('lets the head’s counts narrow the table, and opens narrowed to a machine’s sandboxes from that machine’s page', () => {
    const html = overview('typical');
    // Each count is a button that isn't pressed until picked.
    expect(html.match(/aria-pressed="false"[^>]*title="Show only these"/g)?.length).toBe(3);
    expect(html).not.toContain('Started on');
    const mine = overviewOf(providerOf('typical'), 'machine', 'ci-01');
    expect(rows(mine)).toBe(2);
    expect(mine).toContain('Started on ci-01');
    expect(mine).toMatch(/aria-pressed="true"[^>]*title="Show every sandbox"/);
    for (const name of ['ci-01-perf', 'ci-01-build']) expect(mine).toContain(name);
    expect(mine).not.toContain('cedar-02-ci-matrix');
    // The figures above the table are still every sandbox's.
    expect(mine).toContain('1 not linked');
    // A machine with nothing running any more opens the whole table rather than an empty one.
    const none = overviewOf(providerOf('typical'), 'machine', 'oak-03');
    expect(rows(none)).toBe(6);
    expect(none).not.toContain('Started on');
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
      '99', 'of 8 vCPU busy', 'About 9.8 of 16 GB', '2h 48m', 'Commands running', 'Newest started 12m ago', 'Plan hours this month', '2.4 h',
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
    // It says what Arbor can see of whether anything still uses it, and where it can be stopped.
    // Only what the count can vouch for: a process left running outside the provider's own exec isn't counted.
    expect(sandboxPage(typical, perf)).toContain('The session that started this ended 41m ago. Nothing started through Boat is still running in it. It uses plan hours until someone stops it in Boat.');
    // One whose auto-stop is set stops by itself; it never says someone has to stop it.
    const stops = sandboxPage(typical, { ...perf, stopsAtMs: NOW + 50 * MINUTE });
    expect(stops).toContain('It uses plan hours until it stops at');
    expect(stops).not.toContain('until someone stops it');
    // With no reading there's nothing to say about commands, and nothing is made up.
    const unread = sandboxPage(typical, { ...perf, load: { kind: 'keyCantRead' }, points: [] });
    expect(unread).toContain('The session that started this ended 41m ago. It uses plan hours until someone stops it in Boat.');
    expect(sandboxPage(typical, byName(typical, 'ci-01-build'))).toContain('Degraded · disk pressure for 7m');
  });

  it('says what’s still running in one whose session ended, as a note and not a warning while it’s at work', () => {
    const working = providerOf('working');
    const perf = byName(working, 'ci-01-perf');
    // Rust holds the flag back while its CPU is busy, so nothing calls it forgotten.
    expect(perf.forgotten).toBeNull();
    expect(sandboxFlags(perf)).toEqual([]);
    expect(sandboxCommands(perf)).toEqual({ count: 3, newestStartedAtMs: NOW - 52 * MINUTE });
    expect(sessionEndedNoteAtMs(perf, NOW)).toBe(NOW - 41 * MINUTE);
    const html = sandboxPage(working, perf);
    expect(html).toContain('The session that started this ended 41m ago. 3 commands are still running in it. The newest started 52m ago.');
    // The chart marks where the session ended, so what the lines do after it is plain to see: once the readings
    // reach back that far, and never for a session that ended before the first of them.
    const chart = (endedAtMs: number | null) => renderToStaticMarkup(<I18nProvider><LoadChart sandbox={perf} points={mockHistory(perf, NOW)} sessionEndedAtMs={endedAtMs} /></I18nProvider>);
    expect(chart(NOW - 41 * MINUTE)).toContain('data-slot="time-series-mark"');
    expect(chart(NOW - 41 * MINUTE)).toContain('Session ended');
    expect(chart(NOW - 300 * MINUTE)).not.toContain('time-series-mark');
    expect(chart(null)).not.toContain('time-series-mark');
    // The page hands the chart the end only of a session Arbor saw end; with half an hour of readings it isn't drawn yet.
    expect(html).not.toContain('time-series-mark');
    expect(html).not.toContain('Looks forgotten');
    expect(html).not.toContain('It uses plan hours until');
    for (const text of ['Commands running', 'Newest started 52m ago']) expect(html).toContain(text);
    // One command reads as one.
    const one = sandboxPage(working, { ...perf, load: { kind: 'read', cpu: 0.34, memory: 0.52, atMs: NOW, commands: 1, commandStartedMs: NOW - 5 * MINUTE } });
    expect(one).toContain('1 command is still running in it. It started 5m ago.');

    // The note waits as long as the flag does, and is only for a running sandbox of one's own whose session Arbor saw end.
    const session = present(perf.session);
    expect(sessionEndedNoteAtMs({ ...perf, session: { ...session, endedAtMs: NOW - 29 * MINUTE } }, NOW)).toBeNull();
    expect(sessionEndedNoteAtMs({ ...perf, session: { ...session, live: true, endedAtMs: null } }, NOW)).toBeNull();
    expect(sessionEndedNoteAtMs({ ...perf, session: { ...session, known: false } }, NOW)).toBeNull();
    expect(sessionEndedNoteAtMs({ ...perf, mine: false }, NOW)).toBeNull();
    expect(sessionEndedNoteAtMs({ ...perf, state: 'stopped' }, NOW)).toBeNull();
    // A provider that doesn't say, or a sandbox with no reading, has no count to show.
    expect(sandboxCommands({ load: { kind: 'read', cpu: 0, memory: 0, atMs: NOW, commands: null, commandStartedMs: null } })).toBeNull();
    expect(sandboxCommands({ load: { kind: 'monitoringOff' } })).toBeNull();
    expect(sandboxPage(working, byName(working, 'cedar-02-e2e'))).not.toContain('Newest started');
    // One that isn't running has no count, and that isn't the provider's doing.
    expect(sandboxPage(working, { ...perf, state: 'stopped', load: { kind: 'unavailable' }, points: [] })).not.toContain('doesn’t report this');
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

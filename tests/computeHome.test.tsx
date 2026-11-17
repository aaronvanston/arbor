import { afterEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { alertDestinationView } from '../src/alertNavigation';
import { HomeCompute } from '../src/components/HomeCompute';
import { MachineComputeLine } from '../src/components/MachineComputeLine';
import { computeScenarioSnapshot, type ComputeScenario } from '../src/dev/mock/computeScenarios';
import { I18nProvider } from '../src/i18n';
import { canOpenView, computeByMachineView, computeView } from '../src/navigation';
import type { ComputeProviderSnapshot } from '../src/native/types';
import { alertDestination } from '../src/services/alertHistory';
import { resetComputeStore, takeComputeSnapshot } from '../src/services/compute';
import { homeComputeLine, homeComputeLineUrgent, sandboxesStartedOn } from '../src/services/computeHome';
import { present } from './support/items';

const NOW = Date.parse('2026-11-17T15:52:00Z');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '\'').replace(/\s+/g, ' ').trim();
const scenario = (name: ComputeScenario) => computeScenarioSnapshot(name, NOW);
const boat = (name: ComputeScenario) => present(scenario(name).providers[0]);
const home = () => renderToStaticMarkup(<I18nProvider><HomeCompute onNavigate={() => undefined} /></I18nProvider>);
const machineLine = (machine: string) => renderToStaticMarkup(<I18nProvider><MachineComputeLine machine={machine} onNavigate={() => undefined} /></I18nProvider>);
const show = (name: ComputeScenario) => {
  // The mock's scenarios are made at their own `now`; the card reads the real clock, so it's built at that.
  takeComputeSnapshot(computeScenarioSnapshot(name, Date.now()));
};

afterEach(async () => {
  // The saved hint outlives the store; nothing connected puts it back to none for the next test.
  takeComputeSnapshot({ providers: [] });
  await resetComputeStore();
});

describe('Home’s Compute line', () => {
  it('puts the user’s oldest forgotten sandbox ahead of one degraded or at its CPU limit', () => {
    const line = present(homeComputeLine(boat('typical'), NOW));
    expect(line.kind).toBe('forgotten');
    expect(line.kind === 'forgotten' ? line.sandbox.name : null).toBe('ci-01-perf');
    expect(homeComputeLineUrgent(line)).toBe(false);
  });

  it('puts the provider’s own trouble first: a refused key, then blocked starts, then not answering', () => {
    expect(homeComputeLine(boat('refused'), NOW)).toEqual({ kind: 'keyRefused' });
    expect(homeComputeLine(boat('blocked'), NOW)).toEqual({ kind: 'startsBlocked', block: 'planHoursGone' });
    expect(homeComputeLine(boat('unreachable'), NOW)).toEqual({ kind: 'unreachable' });
    // Blocked starts are only said while the read that said so still counts: not from a provider that isn't
    // answering, nor from one slowed for so long its list is an earlier read's.
    expect(homeComputeLine({ ...boat('blocked'), status: 'unreachable' }, NOW)).toEqual({ kind: 'unreachable' });
    expect(homeComputeLine({ ...boat('blocked'), status: 'rateLimited', checkedAtMs: NOW - 60_000 }, NOW)).toEqual({ kind: 'startsBlocked', block: 'planHoursGone' });
    expect(present(homeComputeLine({ ...boat('blocked'), status: 'rateLimited', checkedAtMs: NOW - 10 * 60_000 }, NOW)).kind).not.toBe('startsBlocked');
    expect(homeComputeLineUrgent({ kind: 'keyRefused' })).toBe(true);
  });

  it('puts a sandbox in error ahead of being asked to slow down, which comes before the rest', () => {
    // 'trouble' is asked to slow down with cam-mbp-docs in error: the broken sandbox takes the line.
    const failed = present(homeComputeLine(boat('trouble'), NOW));
    expect(failed.kind).toBe('error');
    expect(failed.kind === 'error' ? failed.sandbox.name : null).toBe('cam-mbp-docs');
    // Without it, asked to slow down is its own line (not "couldn't reach"), ahead of a forgotten sandbox.
    const trouble = boat('trouble');
    const slowed = { ...trouble, sandboxes: trouble.sandboxes.map((sandbox) => (sandbox.state === 'error' ? { ...sandbox, state: 'running' as const } : sandbox)) };
    expect(homeComputeLine(slowed, NOW)).toEqual({ kind: 'rateLimited' });
  });

  it('has nothing to say with nothing running, and never names a teammate’s sandbox', () => {
    expect(homeComputeLine(boat('empty'), NOW)).toBeNull();
    const typical = boat('typical');
    const theirs: ComputeProviderSnapshot = { ...typical, sandboxes: typical.sandboxes.map((sandbox) => ({ ...sandbox, mine: false })) };
    expect(homeComputeLine(theirs, NOW)).toBeNull();
  });

  it('counts the user’s running sandboxes linked to a machine, by its exact name', () => {
    const { providers } = scenario('typical');
    expect(sandboxesStartedOn(providers, 'cedar-02')).toBe(2);
    expect(sandboxesStartedOn(providers, 'ci-01')).toBe(2);
    expect(sandboxesStartedOn(providers, 'ci-0')).toBe(0);
    // Nothing linked: nothing started anywhere.
    expect(sandboxesStartedOn(scenario('unlinked').providers, 'cam-mbp')).toBe(0);
    expect(sandboxesStartedOn(scenario('empty').providers, 'cam-mbp')).toBe(0);
  });
});

describe('Home’s Compute card', () => {
  it('draws nothing before a snapshot, or with no provider connected', () => {
    expect(home()).toBe('');
    takeComputeSnapshot({ providers: [] });
    expect(home()).toBe('');
  });

  it('shows what’s running, the plan hours left with when they run out, and one line to look at', () => {
    show('typical');
    const words = text(home());
    expect(words).toContain('Compute');
    expect(words).toContain('Open compute');
    expect(words).toContain('Boat');
    expect(words).toContain('6 running · 38 vCPU · 76 GB');
    expect(words).toContain('212 hours left');
    expect(words).toMatch(/Runs out /);
    expect(words).toContain('ci-01-perf looks forgotten');
    expect(words).toMatch(/ended 4[01]m ago/);
    // One line, not one per sandbox.
    expect(words).not.toContain('is degraded');
    expect(words).not.toContain('CPU limit');
    expect(home()).toContain('role="progressbar"');
  });

  it('says when starts are blocked, the key was turned down, or the provider isn’t answering', () => {
    show('blocked');
    let words = text(home());
    expect(words).toContain('starts blocked');
    expect(words).toContain('Boat isn’t letting sandboxes start');
    expect(words).toContain('Plan hours used up');
    expect(words).toContain('0 hours left');

    show('refused');
    words = text(home());
    expect(words).toContain('Boat turned down Arbor’s key');
    expect(words).toContain('Replace it in Settings');

    show('unreachable');
    words = text(home());
    expect(words).toContain('not answering');
    expect(words).toContain('Couldn’t reach Boat');
    // The quota clock may be a minute behind the scenario's own now.
    expect(words).toMatch(/Read 1[34]m ago/);

    show('trouble');
    words = text(home());
    // The status says it was asked to slow down; the one line goes to the sandbox in error.
    expect(words).toContain('asked to slow down');
    expect(words).toContain('cam-mbp-docs is in error');
    expect(words).not.toContain('Boat asked Arbor to slow down');
    expect(words).not.toContain('not answering');
    expect(words).not.toContain('Couldn’t reach');
  });

  it('says so when nothing runs or the provider reports no plan hours', () => {
    show('empty');
    let words = text(home());
    expect(words).toContain('Nothing running');
    expect(words).toMatch(/Resets /);

    show('limits');
    words = text(home());
    expect(words).toContain('No plan hours reported');
    expect(home()).not.toContain('role="progressbar"');
  });
});

describe('A machine’s Compute line', () => {
  it('is nothing with no provider connected', () => {
    expect(machineLine('ci-01')).toBe('');
  });

  it('counts the sandboxes started there, and is nothing on a machine that started none', () => {
    show('typical');
    expect(text(machineLine('ci-01'))).toBe('2 sandboxes started here');
    expect(text(machineLine('cam-mbp'))).toBe('1 sandbox started here');
    expect(machineLine('oak-03')).toBe('');
    show('unlinked');
    expect(machineLine('ci-01')).toBe('');
  });

  it('opens Compute grouped by machine', () => {
    expect(computeByMachineView()).toEqual({ kind: 'main', page: 'compute', params: { group: 'machine' } });
  });
});

describe('Compute alerts on the Alerts page', () => {
  it('open with the core down too, since sandboxes don’t go through it', () => {
    const sandbox = present(alertDestinationView(present(alertDestination({ kind: 'computeSandbox', subject: { sandbox: 'boat/bx_4k2m9xqa', on: 'ci-01' } }))));
    const limit = present(alertDestinationView(present(alertDestination({ kind: 'computeLimit', subject: { compute: 'boat' } }))));
    const key = present(alertDestinationView(present(alertDestination({ kind: 'computeKey', subject: { compute: 'boat', setting: 'compute.providers' } }))));
    expect(limit).toEqual(computeView('boat'));
    expect(key).toEqual({ kind: 'settings', page: 'compute' });
    for (const view of [sandbox, limit, key]) expect(canOpenView(view, false)).toBe(true);
  });
});

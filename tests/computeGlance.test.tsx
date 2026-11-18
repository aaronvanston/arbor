import { afterEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { APP_PREFERENCE_DEFAULTS } from '../src/appPreferences';
import { SidebarCompute } from '../src/components/sidebar/SidebarCompute';
import { SidebarGlance } from '../src/components/sidebar/SidebarGlance';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { computeScenarioSnapshot, type ComputeScenario } from '../src/dev/mock/computeScenarios';
import { I18nProvider, translate as t } from '../src/i18n';
import { AppearanceSettingsPage } from '../src/pages/AppearanceSettingsPage';
import { computeTreeReads, resetComputeStore, takeComputeSnapshot } from '../src/services/compute';
import { glanceCompute, glanceComputeLabel, glanceRunningText, glanceTroubleText, lookCounts, wantsLook } from '../src/services/computeGlance';
import { computeHint } from '../src/services/computeHint';
import { settingEntry } from '../src/services/settingsIndex';
import { itemAt, present } from './support/items';

const NOW = Date.parse('2026-11-17T15:52:00Z');
const boat = (name: ComputeScenario) => present(itemAt(computeScenarioSnapshot(name, NOW).providers, 0));
const line = (name: ComputeScenario) => present(itemAt(glanceCompute([boat(name)], NOW), 0));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '\'').replace(/\s+/g, ' ').trim();
const row = () => renderToStaticMarkup(<I18nProvider><TooltipProvider><SidebarCompute onOpen={() => undefined} /></TooltipProvider></I18nProvider>);
const show = (name: ComputeScenario) => {
  // The line reads the real clock, so the scenario is built at that.
  takeComputeSnapshot(computeScenarioSnapshot(name, Date.now()));
};

afterEach(async () => {
  // The saved hint outlives the store; nothing connected puts it back to none for the next test.
  takeComputeSnapshot({ providers: [] });
  await resetComputeStore();
});

describe('a provider’s line in the sidebar', () => {
  it('pools its sandboxes: how many run, their vCPUs, and how many of the user’s own want a look', () => {
    expect(line('typical')).toEqual({ provider: 'boat', running: 6, vcpus: 38, look: 3, tone: 'warning', trouble: null, stale: false, neverRead: false });
    expect(glanceRunningText(line('typical'), t)).toBe('6 running · 38 vCPU');
    // Three stopped this month and nothing running.
    expect(line('empty')).toMatchObject({ running: 0, vcpus: 0, look: 0, tone: 'muted' });
    expect(glanceRunningText(line('empty'), t)).toBe('Nothing running');
    expect(glanceCompute([], NOW)).toEqual([]);
  });

  it('counts every running sandbox as the tree’s leaf does, but only the user’s own as wanting a look', () => {
    const big = boat('big');
    const leaf = present(itemAt(computeTreeReads({ snapshot: { providers: [big] }, error: null }, NOW), 0));
    expect(line('big').running).toBe(leaf.running);
    expect(line('big').tone).toBe(leaf.tone);
    expect(line('big').running).toBe(100);
    // A teammate's degraded sandbox is theirs to look after.
    const teammates = big.sandboxes.map((sandbox) => (sandbox.mine ? sandbox : { ...sandbox, issue: 'diskPressure' as const }));
    expect(teammates.some((sandbox) => !sandbox.mine)).toBe(true);
    expect(present(itemAt(glanceCompute([{ ...big, sandboxes: teammates }], NOW), 0)).look).toBe(line('big').look);
    expect(big.sandboxes.filter(wantsLook).every((sandbox) => sandbox.mine && sandbox.state !== 'stopped')).toBe(true);
    expect(line('big').look).toBe(big.sandboxes.filter(wantsLook).length);
    expect(line('big').look).toBeGreaterThan(0);
  });

  it('carries the provider’s own trouble, the most pressing first', () => {
    expect(line('refused')).toMatchObject({ trouble: { kind: 'keyRefused' }, tone: 'error', stale: true });
    expect(line('blocked')).toMatchObject({ trouble: { kind: 'startsBlocked', block: 'planHoursGone' }, tone: 'error', stale: false });
    expect(line('unreachable')).toMatchObject({ trouble: { kind: 'unreachable' }, tone: 'warning', stale: true });
    expect(line('trouble')).toMatchObject({ trouble: { kind: 'rateLimited' } });
    // Blocked starts are only said while the read that said so still counts.
    expect(present(itemAt(glanceCompute([{ ...boat('blocked'), status: 'unreachable' }], NOW), 0)).trouble).toEqual({ kind: 'unreachable' });
    expect(glanceTroubleText({ kind: 'startsBlocked', block: 'planHoursGone' }, 'Boat', t)).toBe('Starts blocked · Plan hours used up');
    expect(glanceTroubleText({ kind: 'startsBlocked', block: null }, 'Boat', t)).toBe('Starts blocked · The provider is refusing new sandboxes');
    expect(glanceTroubleText({ kind: 'keyRefused' }, 'Boat', t)).toBe('Boat turned down Arbor’s key');
  });

  it('spells out what wants a look, the user’s own only', () => {
    expect(lookCounts(boat('typical').sandboxes)).toEqual({ error: 0, cpuAtLimit: 1, degraded: 1, forgotten: 1 });
    expect(lookCounts(boat('trouble').sandboxes).error).toBe(1);
    expect(lookCounts(boat('typical').sandboxes.map((sandbox) => ({ ...sandbox, mine: false })))).toEqual({ error: 0, cpuAtLimit: 0, degraded: 0, forgotten: 0 });
  });

  it('says itself in words', () => {
    expect(glanceComputeLabel(line('typical'), 'Boat', t)).toBe('Boat: 6 running · 38 vCPU. 3 want a look.');
    expect(glanceComputeLabel({ ...line('typical'), look: 1 }, 'Boat', t)).toBe('Boat: 6 running · 38 vCPU. 1 wants a look.');
    expect(glanceComputeLabel(line('empty'), 'Boat', t)).toBe('Boat: Nothing running.');
    expect(glanceComputeLabel(line('unreachable'), 'Boat', t)).toBe('Boat: 6 running · 38 vCPU. 3 want a look. Couldn’t reach Boat. From an earlier read.');
    expect(glanceComputeLabel(line('blocked'), 'Boat', t)).toContain('Starts blocked · Plan hours used up.');
    // A provider that has never answered has no earlier read to speak of.
    const never = present(itemAt(glanceCompute([{ ...boat('empty'), status: 'unreachable', checkedAtMs: null }], NOW), 0));
    expect(never).toMatchObject({ stale: true, neverRead: true });
    expect(glanceComputeLabel(never, 'Boat', t)).toBe('Boat: Nothing running. Couldn’t reach Boat. Not read yet.');
  });
});

describe('the sidebar’s compute row', () => {
  it('draws nothing before a snapshot', () => {
    expect(row()).toBe('');
  });

  it('draws one line for the provider, a button that says the same in words', () => {
    show('typical');
    const html = row();
    expect(html).toContain('data-slot="sidebar-compute"');
    expect(html.split('<button').length - 1).toBe(1);
    expect(html).toContain('aria-label="Boat: 6 running · 38 vCPU. 3 want a look."');
    expect(text(html)).toBe('6 running · 38 vCPU 3');
    // Wanting a look is amber, and nothing here is an earlier read's.
    expect(html).toContain('text-warning-foreground');
    expect(html).not.toContain('text-error-foreground');
    expect(html).not.toContain('opacity-60');
  });

  it('stays, without a marker, while nothing runs', () => {
    show('empty');
    const html = row();
    expect(text(html)).toBe('Nothing running');
    expect(html).not.toContain('text-warning-foreground');
    expect(html).not.toContain('text-error-foreground');
  });

  it('marks blocked starts red, and fades the figures of a provider that isn’t answering', () => {
    show('blocked');
    expect(row()).toContain('text-error-foreground');
    show('unreachable');
    const html = row();
    // The figures and the count beside the marker, both from the earlier read.
    expect(html.split('opacity-60').length - 1).toBe(2);
    expect(html).toContain('text-warning-foreground');
    expect(html).not.toContain('text-error-foreground');
  });

  it('keeps a hundred sandboxes to the one line', () => {
    show('big');
    const html = row();
    expect(html.split('<button').length - 1).toBe(1);
    expect(text(html)).toMatch(/^100 running · \d+ vCPU \d+$/);
  });
});

describe('the sidebar’s glance with compute', () => {
  const glance = (compute: React.ReactNode) => renderToStaticMarkup(
    <I18nProvider><TooltipProvider><SidebarGlance limits={null} machines={null} compute={compute} onCustomize={() => undefined} /></TooltipProvider></I18nProvider>,
  );

  it('shows for compute alone, and not at all with nothing on', () => {
    expect(glance(null)).toBe('');
    expect(glance(<span>compute</span>)).toContain('compute');
  });
});

describe('Settings › Appearance’s Show compute', () => {
  const appearance = () => renderToStaticMarkup(<I18nProvider><TooltipProvider><AppearanceSettingsPage theme="light" onThemeChange={() => undefined} /></TooltipProvider></I18nProvider>);

  afterEach(() => {
    computeHint.set([]);
  });

  it('is on until turned off', () => {
    expect(APP_PREFERENCE_DEFAULTS.sidebarCompute).toBe(true);
  });

  it('shows only once a compute provider is connected, and search lands on Show machines until then', () => {
    expect(appearance()).not.toContain('Show compute');
    expect(present(settingEntry('appearance.sidebar-compute')).fallback).toBe('appearance.sidebar-machines');
    computeHint.set(['boat']);
    expect(appearance()).toContain('Show compute');
  });
});

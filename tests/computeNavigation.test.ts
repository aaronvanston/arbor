import { describe, expect, it } from 'bun:test';
import { COMPUTE_SCENARIOS, computeScenarioSnapshot, mockHistory } from '../src/dev/mock/computeScenarios';
import { computeSandboxView, computeView, mainPageIds, mainPageView, settingsPageIds } from '../src/navigation';
import type { ComputeSnapshot } from '../src/native/types';
import { pageModulesFor } from '../src/pageModules';
import { SHORTCUTS, shortcutDefinition } from '../src/services/shortcuts';
import { mergeHistory } from '../src/services/computePage';
import { openComputeProvider, treeHeightRem, treePage, treePageShown } from '../src/services/sidebarTree';
import { lastItem, present } from './support/items';

const NOW = Date.parse('2026-11-17T15:52:00Z');
const MINUTE = 60_000;

describe('Compute in the navigation', () => {
  it('sits after Pools, and takes no number so Alerts keeps ⌘9', () => {
    expect(mainPageIds.indexOf('compute')).toBe(mainPageIds.indexOf('pools') + 1);
    expect(settingsPageIds.indexOf('compute')).toBe(settingsPageIds.indexOf('pools') + 1);
    expect(SHORTCUTS.some((shortcut) => shortcut.id === ('go.compute' as never))).toBe(false);
    expect(shortcutDefinition('go.alerts')?.keys).toBe('mod+9');
    expect(shortcutDefinition('go.sessions')?.keys).toBe('mod+4');
  });

  it('opens every provider’s sandboxes, one provider’s and one sandbox’s, all from the same module', () => {
    expect(computeView()).toEqual({ kind: 'main', page: 'compute', params: {} });
    expect(mainPageView('compute')).toEqual(computeView());
    expect(computeView('boat')).toEqual({ kind: 'main', page: 'compute', params: { provider: 'boat' } });
    expect(computeSandboxView('boat', 'bx_4k2m9xqa')).toEqual({ kind: 'main', page: 'compute', params: { provider: 'boat', sandbox: 'bx_4k2m9xqa' } });
    expect(pageModulesFor(computeSandboxView('boat', 'bx_4k2m9xqa'))).toEqual(['compute']);
    expect(pageModulesFor({ kind: 'settings', page: 'compute' })).toEqual(['computeSettings']);
  });

  it('hides Compute from the tree until a provider is connected, leaving the tree’s height as it was', () => {
    const page = present(treePage('compute'));
    expect(treePageShown(page, {})).toBe(false);
    expect(treePageShown(page, { compute: 0 })).toBe(false);
    expect(treePageShown(page, { compute: 1 })).toBe(true);
    expect(treePageShown(present(treePage('pools')), {})).toBe(true);
    const closed = treeHeightRem(new Set());
    expect(treeHeightRem(new Set(['compute']), { compute: 0 })).toBe(closed);
    expect(treeHeightRem(new Set(), { compute: 1 })).toBeGreaterThan(closed);
    expect(treeHeightRem(new Set(['compute']), { compute: 1 })).toBeGreaterThan(treeHeightRem(new Set(), { compute: 1 }));
  });

  it('lights the provider a view narrowed to, and a sandbox’s provider', () => {
    expect(openComputeProvider(computeView('boat'), ['boat'])).toBe('boat');
    expect(openComputeProvider(computeSandboxView('boat', 'bx_1'), ['boat'])).toBe('boat');
    expect(openComputeProvider(computeView(), ['boat'])).toBeNull();
    expect(openComputeProvider(computeView('boat'), [])).toBeNull();
    expect(openComputeProvider({ kind: 'main', page: 'pools', params: { pool: 'boat' } }, ['boat'])).toBeNull();
  });
});

describe('the mock’s Compute scenarios', () => {
  it('builds every scenario as the generated types say, and survives a trip through JSON', () => {
    for (const name of COMPUTE_SCENARIOS) {
      const snapshot: ComputeSnapshot = computeScenarioSnapshot(name, NOW);
      expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
      for (const provider of snapshot.providers) {
        expect(provider.id).toBe('boat');
        for (const sandbox of provider.sandboxes) {
          expect(sandbox.points.length).toBeLessThanOrEqual(30);
          const times = sandbox.points.map((point) => point.atMs);
          expect(times).toEqual([...times].sort((a, b) => a - b));
          if (sandbox.state === 'stopped') expect(sandbox.forgotten).toBeNull();
        }
      }
    }
    expect(computeScenarioSnapshot('none', NOW)).toEqual({ providers: [] });
  });

  it('has a hundred sandboxes in big, three stopped in empty, and no machines in unlinked', () => {
    expect(present(computeScenarioSnapshot('big', NOW).providers[0]).sandboxes).toHaveLength(100);
    const empty = present(computeScenarioSnapshot('empty', NOW).providers[0]).sandboxes;
    expect(empty.map((sandbox) => sandbox.state)).toEqual(['stopped', 'stopped', 'stopped']);
    expect(present(computeScenarioSnapshot('unlinked', NOW).providers[0]).sandboxes.every((sandbox) => sandbox.machine === null)).toBe(true);
    expect(present(computeScenarioSnapshot('writekey', NOW).providers[0]).keyAccess).toBe('canWrite');
  });

  it('answers a sandbox’s history as a two-hour ring, a minute apart, with a gap where Arbor wasn’t reading', () => {
    const sandboxes = present(computeScenarioSnapshot('typical', NOW).providers[0]).sandboxes;
    const old = present(sandboxes.find((sandbox) => sandbox.name === 'ci-01-perf'));
    const history = mockHistory(old, NOW);
    // 120 minutes less the 11 from 70 to 60 minutes ago.
    expect(history).toHaveLength(109);
    expect(history.some((point) => point.atMs >= NOW - 70 * MINUTE && point.atMs <= NOW - 60 * MINUTE)).toBe(false);
    expect(lastItem(history).atMs).toBe(NOW);
    expect(present(history[0]).atMs).toBe(NOW - 119 * MINUTE);
    const starting = present(sandboxes.find((sandbox) => sandbox.state === 'starting'));
    expect(mockHistory(starting, NOW)).toEqual([]);
  });

  it('gives only a running sandbox a reading, as Rust’s load_shown does, and counts history from its last start', () => {
    const trouble = present(computeScenarioSnapshot('trouble', NOW).providers[0]).sandboxes;
    const empty = present(computeScenarioSnapshot('empty', NOW).providers[0]).sandboxes;
    for (const sandbox of [...trouble, ...empty]) {
      const expected = { running: 'read', starting: 'notReadYet', stopping: 'unavailable', stopped: 'unavailable', error: 'unavailable' }[sandbox.state];
      expect(`${sandbox.state}:${sandbox.load.kind}`).toBe(`${sandbox.state}:${expected}`);
      if (sandbox.state !== 'running') expect(sandbox.points).toEqual([]);
    }
    const typical = present(computeScenarioSnapshot('typical', NOW).providers[0]).sandboxes;
    const docs = present(typical.find((sandbox) => sandbox.name === 'cam-mbp-docs'));
    // Made three days ago, resumed half an hour ago: half an hour of readings.
    const resumed = { ...docs, createdAtMs: NOW - 3 * 24 * 60 * MINUTE, startedAtMs: NOW - 30 * MINUTE };
    expect(mockHistory(resumed, NOW)).toHaveLength(31);
  });

  it('reads on the minute, so a snapshot’s points and the history asked for later merge without doubling', () => {
    const snapshot = present(computeScenarioSnapshot('typical', NOW + 25_000).providers[0]);
    const sandbox = present(snapshot.sandboxes.find((entry) => entry.name === 'ci-01-perf'));
    const history = mockHistory(sandbox, NOW + 40_000);
    expect(lastItem(sandbox.points).atMs).toBe(NOW);
    expect(mergeHistory(history, sandbox.points)).toBe(history);
  });

  it('burns plan hours only for running sandboxes, as Rust does, while the active limit counts starting ones too', () => {
    const provider = present(computeScenarioSnapshot('typical', NOW).providers[0]);
    // Three large (2 each), one default (1) and one small (0.5) running; cedar-02-e2e is still starting.
    expect(provider.planHoursPerHour).toBe(7.5);
    expect(provider.limits.find((limit) => limit.kind === 'activeSandboxes')?.used).toBe(6);
  });
});

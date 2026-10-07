import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { renderToStaticMarkup } from 'react-dom/server';
import { MachineProbeBlock, MachineProbesSettings } from '../src/components/MachineProbes';
import { mockCommands } from '../src/dev/mock/answers';
import { I18nProvider, translate } from '../src/i18n';
import type { MachineProbes } from '../src/native/types';
import { canRemoveProbe, probeAction, probeOutOfDate, probeState, refreshMachineProbes } from '../src/services/machineProbes';

type Probe = MachineProbes['machines'][number];
const probe = (machine: string, installed: boolean, streaming: boolean, fields: Partial<Probe> = {}): Probe => ({
  machine, installed, streaming, version: installed ? '0.1.3' : null, updating: false, updateError: null, ...fields,
});

const probes = (fields: Partial<MachineProbes> = {}): MachineProbes => ({
  version: '0.1.3',
  unavailable: null,
  machines: [probe('cedar-02', false, false), probe('ci-01', true, true), probe('cam-mbp', true, false)],
  ...fields,
});

/** ci-01's probe on another release, with whatever else its row says. */
const ciOn = (version: string | null, fields: Partial<Probe> = {}) =>
  probes({ machines: [probe('cedar-02', false, false), probe('ci-01', true, true, { version, ...fields })] });

describe('machine probes', () => {
  it('reads each machine’s probe, and nothing while Grove is unavailable or doesn’t know the machine', () => {
    expect(probeState(probes(), 'ci-01')).toBe('streaming');
    expect(probeState(probes(), 'cam-mbp')).toBe('starting');
    expect(probeState(probes(), 'cedar-02')).toBe('none');
    expect(probeState(probes(), 'lab-box')).toBe('unknown');
    expect(probeState(probes({ unavailable: 'Grove isn’t built for this Mac' }), 'ci-01')).toBe('unknown');
    expect(probeState(null, 'ci-01')).toBe('unknown');
    expect([canRemoveProbe('streaming'), canRemoveProbe('starting'), canRemoveProbe('none')]).toEqual([true, true, false]);
  });

  it('offers Update only for a probe older than the one Arbor carries, prereleases first', () => {
    expect(probeAction(probes(), 'cedar-02')).toBe('install');
    expect(probeAction(ciOn('0.1.2'), 'ci-01')).toBe('update');
    expect(probeAction(ciOn('0.1.3-rc.1'), 'ci-01')).toBe('update');
    expect(probeAction(ciOn('0.1.3'), 'ci-01')).toBeNull();
    expect(probeAction(ciOn('0.2.0'), 'ci-01')).toBeNull();
    expect(probeAction(ciOn(null), 'ci-01')).toBeNull();
    expect(probeAction(probes(), 'lab-box')).toBeNull();
    expect([probeOutOfDate(ciOn('0.1.2'), 'ci-01'), probeOutOfDate(ciOn('0.1.2'), 'cedar-02')]).toEqual([true, false]);
  });
});

describe('machine probes, shown', () => {
  let originalWindow: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  });
  afterEach(() => {
    clearMocks();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  const render = async (value: MachineProbes, node: React.ReactNode) => {
    mockCommands({ get_machine_probes: () => value });
    await refreshMachineProbes();
    return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
  };

  it('offers Install where there’s no probe, and Remove and its release where there is', async () => {
    const none = await render(probes(), <MachineProbeBlock machine="cedar-02" />);
    expect(none).toContain(translate('machines.probe.state.none'));
    expect(none).toContain(`>${translate('machines.probe.install')}</button>`);
    expect(none).not.toContain(`>${translate('machines.probe.remove')}</button>`);
    const streaming = await render(probes(), <MachineProbeBlock machine="ci-01" />);
    expect(streaming).toContain(translate('machines.probe.withVersion', { state: translate('machines.probe.state.streaming'), version: '0.1.3' }));
    expect(streaming).not.toContain(`>${translate('machines.probe.update')}</button>`);
    expect(streaming).toContain(`>${translate('machines.probe.remove')}</button>`);
  });

  it('offers Update for an older probe, and says why Arbor’s own update of it failed', async () => {
    const older = await render(ciOn('0.1.2'), <MachineProbeBlock machine="ci-01" />);
    expect(older).toContain(`>${translate('machines.probe.update')}</button>`);
    const error = 'ssh: connect to host ci-01 port 22: Operation timed out';
    const failed = await render(ciOn('0.1.2', { updateError: error }), <MachineProbeBlock machine="ci-01" />);
    expect(failed).toContain(translate('machines.probe.updateFailed', { error }));
    expect(failed).toContain(`>${translate('machines.probe.update')}</button>`);
    const updating = await render(ciOn('0.1.2', { updating: true }), <MachineProbeBlock machine="ci-01" />);
    expect(updating).toContain(translate('machines.probe.updating', { version: '0.1.3' }));
  });

  it('lists every machine Grove reads in Settings, or says why Grove isn’t read', async () => {
    const listed = await render(probes(), <MachineProbesSettings />);
    expect(listed).toContain('data-setting-id="machines.health-probes"');
    expect(listed).toContain(translate('machines.probe.settings.version', { version: '0.1.3' }));
    expect(listed.split(`>${translate('machines.probe.install')}</button>`)).toHaveLength(2);
    const unavailable = await render(probes({ unavailable: 'Grove isn’t built for this Mac', machines: [] }), <MachineProbesSettings />);
    expect(unavailable).toContain(translate('machines.probe.unavailable', { reason: 'Grove isn’t built for this Mac' }));
    expect(unavailable).not.toContain(`>${translate('machines.probe.install')}</button>`);
  });
});

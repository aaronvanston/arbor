import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { renderToStaticMarkup } from 'react-dom/server';
import { MachineProbeBlock, MachineProbesSettings } from '../src/components/MachineProbes';
import { mockCommands } from '../src/dev/mock/answers';
import { I18nProvider, translate } from '../src/i18n';
import type { MachineProbes } from '../src/native/types';
import { canInstallProbe, canRemoveProbe, probeState, refreshMachineProbes } from '../src/services/machineProbes';

const probes = (fields: Partial<MachineProbes> = {}): MachineProbes => ({
  version: '0.1.2',
  unavailable: null,
  machines: [
    { machine: 'cedar-02', installed: false, streaming: false },
    { machine: 'ci-01', installed: true, streaming: true },
    { machine: 'cam-mbp', installed: true, streaming: false },
  ],
  ...fields,
});

describe('machine probes', () => {
  it('reads each machine’s probe, and nothing while Grove is unavailable or doesn’t know the machine', () => {
    expect(probeState(probes(), 'ci-01')).toBe('streaming');
    expect(probeState(probes(), 'cam-mbp')).toBe('starting');
    expect(probeState(probes(), 'cedar-02')).toBe('none');
    expect(probeState(probes(), 'lab-box')).toBe('unknown');
    expect(probeState(probes({ unavailable: 'Grove isn’t built for this Mac' }), 'ci-01')).toBe('unknown');
    expect(probeState(null, 'ci-01')).toBe('unknown');
    expect([canInstallProbe('none'), canInstallProbe('streaming'), canInstallProbe('unknown')]).toEqual([true, true, false]);
    expect([canRemoveProbe('streaming'), canRemoveProbe('starting'), canRemoveProbe('none')]).toEqual([true, true, false]);
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

  it('offers Install where there’s no probe and Update and Remove where there is', async () => {
    const none = await render(probes(), <MachineProbeBlock machine="cedar-02" />);
    expect(none).toContain(translate('machines.probe.state.none'));
    expect(none).toContain(`>${translate('machines.probe.install')}</button>`);
    expect(none).not.toContain(`>${translate('machines.probe.remove')}</button>`);
    const streaming = await render(probes(), <MachineProbeBlock machine="ci-01" />);
    expect(streaming).toContain(translate('machines.probe.state.streaming'));
    expect(streaming).toContain(`>${translate('machines.probe.update')}</button>`);
    expect(streaming).toContain(`>${translate('machines.probe.remove')}</button>`);
  });

  it('lists every machine Grove reads in Settings, or says why Grove isn’t read', async () => {
    const listed = await render(probes(), <MachineProbesSettings />);
    expect(listed).toContain('data-setting-id="machines.health-probes"');
    expect(listed).toContain(translate('machines.probe.settings.version', { version: '0.1.2' }));
    expect(listed.split(`>${translate('machines.probe.install')}</button>`)).toHaveLength(2);
    const unavailable = await render(probes({ unavailable: 'Grove isn’t built for this Mac', machines: [] }), <MachineProbesSettings />);
    expect(unavailable).toContain(translate('machines.probe.unavailable', { reason: 'Grove isn’t built for this Mac' }));
    expect(unavailable).not.toContain(`>${translate('machines.probe.install')}</button>`);
  });
});

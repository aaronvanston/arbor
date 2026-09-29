import { afterEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MachinePill } from '../src/components/identity/Identity';
import { I18nProvider, translate } from '../src/i18n';
import {
  MACHINE_NAME_MAX,
  getMachineNames,
  machineName,
  machineNameTakenBy,
  setMachineName,
} from '../src/services/machineNames';

const render = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);

afterEach(() => {
  for (const machine of ['macbook-air', 'Mac Mini', 'ci-01']) setMachineName(machine, '');
});

describe('machine names', () => {
  it('shows a machine by the name it was given, and by its own until then', () => {
    expect(machineName('macbook-air')).toBe('macbook-air');
    expect(setMachineName('macbook-air', '  MacBook   Air ')).toBe(true);
    expect(machineName('macbook-air')).toBe('MacBook Air');
    // However the machine's own name is written, as the backend matches them.
    expect(machineName('MacBook Air')).toBe('MacBook Air');
    expect(machineName('macbook_air')).toBe('MacBook Air');
    expect(machineName('ci-01')).toBe('ci-01');
  });

  it('goes back to the machine’s own name for a blank one or its own', () => {
    setMachineName('Mac Mini', 'Studio');
    setMachineName('Mac Mini', '   ');
    expect(getMachineNames()).toEqual({});
    setMachineName('Mac Mini', 'Studio');
    setMachineName('Mac Mini', 'Mac Mini');
    expect(getMachineNames()).toEqual({});
  });

  it('refuses a name too long for a pill and keeps the one before', () => {
    setMachineName('ci-01', 'Build box');
    expect(setMachineName('ci-01', 'x'.repeat(MACHINE_NAME_MAX + 1))).toBe(false);
    expect(machineName('ci-01')).toBe('Build box');
  });

  it('finds another machine that already goes by a name, by its own name or the one it was given', () => {
    const machines = ['macbook-air', 'Mac Mini', 'ci-01'];
    // Its own name, however it's written, is never a clash.
    expect(machineNameTakenBy('macbook-air', 'MacBook Air', machines)).toBeNull();
    expect(machineNameTakenBy('macbook-air', 'mac mini', machines)).toBe('Mac Mini');
    setMachineName('ci-01', 'Build box');
    expect(machineNameTakenBy('macbook-air', 'build-box', machines)).toBe('Build box');
    expect(machineNameTakenBy('macbook-air', 'ci-01', machines)).toBe('Build box');
    expect(machineNameTakenBy('macbook-air', '', machines)).toBeNull();
  });

  it('says the given name in pills and messages, and the machine’s own when hovered', () => {
    setMachineName('macbook-air', 'MacBook Air');
    const html = render(<MachinePill name="macbook-air" />);
    expect(html).toContain('>MacBook Air</span>');
    expect(html).toContain('title="MacBook Air (macbook-air)"');
    expect(translate('machine.gone', { machine: 'macbook-air' })).toContain('list MacBook Air any more');
    expect(translate('machine.setup.matches', { reference: 'macbook-air' })).toBe('Everything matches MacBook Air.');
    // Other placeholders are left as they are, and so is a machine nobody renamed.
    expect(translate('machines.name.hint', { own: 'macbook-air' })).toContain('still call it macbook-air.');
    expect(translate('machine.setup.matches', { reference: 'ci-01' })).toBe('Everything matches ci-01.');
  });
});

import { describe, expect, it } from 'bun:test';
import { en } from '../src/i18n/resources';
import { identitiesByMachine, machineIdentity } from '../src/services/machineIdentity';

const mac = (model: string, productName = '') => ({ os: 'Darwin', model, productName });
const label = (model: string, productName = '') => {
  const key = machineIdentity(mac(model, productName))?.label;
  return key ? en[key] : null;
};

describe('machine identity', () => {
  it('names Macs on Apple silicon from their model identifier', () => {
    expect(label('Mac16,8')).toBe('MacBook Pro');
    expect(label('Mac16,12')).toBe('MacBook Air');
    expect(label('Mac16,11')).toBe('Mac mini');
    expect(label('Mac15,14')).toBe('Mac Studio');
    expect(label('Mac16,3')).toBe('iMac');
    expect(label('Mac14,8')).toBe('Mac Pro');
    expect(machineIdentity(mac('Mac16,11'))).toEqual({ kind: 'macMini', label: 'machines.identity.macMini', productName: null, modelId: 'Mac16,11' });
  });

  it('reads the family out of older identifiers, longest name first', () => {
    expect(label('MacBookPro18,3')).toBe('MacBook Pro');
    expect(label('MacBookAir10,1')).toBe('MacBook Air');
    expect(label('MacBook10,1')).toBe('MacBook');
    expect(label('Macmini9,1')).toBe('Mac mini');
    expect(label('iMacPro1,1')).toBe('iMac Pro');
    expect(label('iMac21,1')).toBe('iMac');
    expect(label('MacPro7,1')).toBe('Mac Pro');
  });

  it('falls back to the product name a Mac gives, then to just a Mac', () => {
    const newer = machineIdentity(mac('Mac99,1', 'Mac Studio (2027)'));
    expect(newer?.kind).toBe('macStudio');
    expect(newer?.productName).toBe('Mac Studio (2027)');
    expect(machineIdentity(mac('Mac99,1'))).toEqual({ kind: 'mac', label: 'machines.identity.mac', productName: null, modelId: 'Mac99,1' });
    expect(machineIdentity(mac(''))).toEqual({ kind: 'mac', label: 'machines.identity.mac', productName: null, modelId: null });
    expect(machineIdentity(mac('VirtualMac2,1'))?.kind).toBe('server');
    expect(label('VirtualMac2,1')).toBe('Mac virtual machine');
  });

  it('keeps the identifier ahead of a product name that disagrees', () => {
    expect(label('Mac16,8', 'Mac mini (2024)')).toBe('MacBook Pro');
  });

  it('draws everything that isn’t a Mac as a server', () => {
    expect(machineIdentity({ os: 'Linux', model: 'MS-7D25', productName: '' })).toEqual({ kind: 'server', label: 'machines.identity.linux', productName: null, modelId: null });
    expect(machineIdentity({ os: 'FreeBSD', model: '', productName: '' })).toEqual({ kind: 'server', label: null, productName: null, modelId: null });
    expect(machineIdentity(null)).toBeNull();
  });

  it('maps sampled machines by name and leaves out ones not heard from', () => {
    const identities = identitiesByMachine([
      { machine: 'cam-mbp', facts: { ...mac('Mac16,8', 'MacBook Pro (14-inch, 2024)') } as never },
      { machine: 'lab-box', facts: null },
    ]);
    expect([...identities.keys()]).toEqual(['cam-mbp']);
    expect(identities.get('cam-mbp')?.productName).toBe('MacBook Pro (14-inch, 2024)');
  });
});

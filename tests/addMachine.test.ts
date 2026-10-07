import { describe, expect, it } from 'bun:test';
import { addMachineMissing } from '../src/services/addMachine';

describe('Add machine', () => {
  const ready = { name: 'build-box', host: 'build-box.local', port: 22, hostsRead: true };

  it('says what it still needs before it can add one, the first thing first', () => {
    expect(addMachineMissing({ ...ready, name: ' ', host: '' })).toBe('setup.checklist.addDialog.needsName');
    expect(addMachineMissing({ ...ready, host: '' })).toBe('setup.checklist.addDialog.needsHost');
    // A port out of range reads as none at all.
    expect(addMachineMissing({ ...ready, port: null })).toBe('machines.hosts.portInvalid');
    expect(addMachineMissing({ ...ready, hostsRead: false })).toBe('setup.checklist.addDialog.needsHosts');
  });

  it('needs nothing once it has them all', () => {
    expect(addMachineMissing(ready)).toBeNull();
  });
});

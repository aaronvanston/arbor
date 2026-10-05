import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import { onMachineHostsSaved, saveMachineHosts } from '../src/services/machineHealth';

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

describe('saving the machine list', () => {
  it('tells what lists the machines once a save lands, and not when it fails', async () => {
    // The sidebar and Home read the fleet again on this, so a machine just added shows there at once.
    const host = { machine: 'build-arm', endpoint: 'build-arm', port: 22, enabled: true, source: '' };
    let saves = 0;
    const stop = onMachineHostsSaved(() => { saves += 1; });
    mockCommands({ save_machine_hosts: () => [host] });
    await saveMachineHosts([host]);
    expect(saves).toBe(1);

    mockCommands({ save_machine_hosts: () => { throw 'The usage database is busy'; } });
    await expect(saveMachineHosts([host])).rejects.toBe('The usage database is busy');
    expect(saves).toBe(1);

    stop();
    mockCommands({ save_machine_hosts: () => [host] });
    await saveMachineHosts([host]);
    expect(saves).toBe(1);
  });
});

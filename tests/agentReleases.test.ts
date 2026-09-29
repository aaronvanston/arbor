import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import { refreshLatestVersions, refreshT3Compatibility } from '../src/services/agentReleases';
import type { T3Policy } from '../src/native/types';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

describe('latest agent releases', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  });
  afterEach(() => {
    clearMocks();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  it('reads a failed ask as unknown rather than an error, in place of the last answer', async () => {
    mockCommands({ get_agent_latest_versions: () => ({ claude: '2.1.283', codex: null }) });
    expect(await refreshLatestVersions()).toEqual({ claude: '2.1.283', codex: null });
    mockCommands({
      get_agent_latest_versions: () => {
        throw new Error('error sending request for url (https://registry.npmjs.org/@openai%2Fcodex/latest)');
      },
    });
    expect(await refreshLatestVersions()).toEqual({ claude: null, codex: null });
  });

  it('keeps T3 Code’s policies, and reads a manifest that failed to load as none', async () => {
    const policies: T3Policy[] = [{ agent: 'codex', t3CodeRange: '>=0.0.42', recommendedRange: '>=0.156.0', recommendedVersion: null, ranges: [{ range: '<0.149.0', status: 'broken' }] }];
    mockCommands({ get_t3_compatibility: () => policies });
    expect(await refreshT3Compatibility()).toEqual(policies);
    mockCommands({ get_t3_compatibility: () => null });
    expect(await refreshT3Compatibility()).toBeNull();
    mockCommands({
      get_t3_compatibility: () => {
        throw new Error('command get_t3_compatibility not found');
      },
    });
    expect(await refreshT3Compatibility()).toBeNull();
  });
});

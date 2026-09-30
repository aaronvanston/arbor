import { describe, expect, test } from 'bun:test';
import { isCoreStarting } from '../src/coreRuntime';
import type { CoreStatus } from '../src/native/types';

const coreStatus = (overrides: Partial<CoreStatus>): CoreStatus => ({
  installed: true,
  running: false,
  ready: false,
  starting: false,
  managed: true,
  processId: null,
  currentVersion: '7.3.13',
  installDir: '/tmp/core',
  binaryPath: '/tmp/core/cli-proxy-api',
  message: '',
  ...overrides,
});

describe('core runtime status', () => {
  test('a live core that is not answering on its port yet reads as starting', () => {
    expect(isCoreStarting(coreStatus({ running: true, ready: false, processId: 4821 }))).toBe(true);
  });

  test('a ready core reads as running, even while the launch flag is still set', () => {
    expect(isCoreStarting(coreStatus({ running: true, ready: true, processId: 4821 }))).toBe(false);
    expect(isCoreStarting(coreStatus({ running: true, ready: true, starting: true, processId: 4821 }))).toBe(false);
  });

  test('a stopped core reads as starting only while the app is launching it', () => {
    expect(isCoreStarting(coreStatus({ starting: true }))).toBe(true);
    expect(isCoreStarting(coreStatus({}))).toBe(false);
    expect(isCoreStarting(coreStatus({ installed: false }))).toBe(false);
  });
});

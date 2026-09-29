import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import type { SettingsInEffect } from '../src/native/types';
import { confirmSettingsInEffect, notLoadedNotice } from '../src/services/settingsInEffect';

const answer = (state: SettingsInEffect['state'], line: number | null = null): SettingsInEffect => ({ state, settings: [], line });

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

describe('settings in effect', () => {
  it('says nothing beyond "Saved" unless the proxy kept its old settings', () => {
    for (const state of ['live', 'coreStopped', 'unknown'] as const) expect(notLoadedNotice(answer(state))).toBeNull();
    expect(notLoadedNotice(null)).toBeNull();
  });

  it('names the line the proxy could not read, when its log did', () => {
    expect(notLoadedNotice(answer('notLoaded', 153))).toEqual({ key: 'config.notice.savedNotLoadedLine', variables: { line: 153 } });
    expect(notLoadedNotice(answer('notLoaded'))).toEqual({ key: 'config.notice.savedNotLoaded' });
  });

  it('asks the proxy checks again when a save was not loaded, so Home and Usage say so too', async () => {
    const calls = mockCommands({
      confirm_core_settings: () => answer('notLoaded', 12),
      check_proxy_settings: () => ({ checked: true, problems: [{ kind: 'settingsNotLoaded', detail: '12' }] }),
    });
    expect(await confirmSettingsInEffect()).toEqual(answer('notLoaded', 12));
    await Promise.resolve();
    expect(calls.map((call) => call.command)).toEqual(['confirm_core_settings', 'check_proxy_settings']);
  });

  it('treats not being able to ask as nothing against the save', async () => {
    const calls = mockCommands({ confirm_core_settings: () => { throw 'core gone'; } });
    expect(await confirmSettingsInEffect()).toBeNull();
    expect(calls.map((call) => call.command)).toEqual(['confirm_core_settings']);
  });
});

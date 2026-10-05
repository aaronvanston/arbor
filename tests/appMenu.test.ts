import { describe, expect, test } from 'bun:test';
import { runAppMenuAction } from '../src/services/appMenu';

describe('app menu actions', () => {
  test('each item runs its own handler and only that one', () => {
    const calls: string[] = [];
    const handlers = { checkForUpdates: () => calls.push('updates'), openSettings: () => calls.push('settings') };
    runAppMenuAction('checkForUpdates', handlers);
    expect(calls).toEqual(['updates']);
    runAppMenuAction('openSettings', handlers);
    expect(calls).toEqual(['updates', 'settings']);
  });
});

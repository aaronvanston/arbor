import { describe, expect, test } from 'bun:test';
import { accountSignInsView, canOpenView, mainView, settingsPageIds, settingsPageView, usageView } from '../src/navigation';

describe('navigation', () => {
  test("pages that only read Arbor's own data open while the core is stopped, and the rest wait for it", () => {
    for (const view of [mainView('home'), mainView('usage'), { kind: 'settings', page: 'notifications' } as const]) {
      expect(canOpenView(view, false)).toBe(true);
    }
    expect(canOpenView({ kind: 'settings', page: 'overrides' }, false)).toBe(false);
    expect(canOpenView({ kind: 'settings', page: 'overrides' }, true)).toBe(true);
  });

  test('Interface and Phone Alerts became Notifications, and their old ids still lead there', () => {
    expect(settingsPageIds).toContain('notifications');
    expect(settingsPageIds).not.toContain('interface');
    expect(settingsPageIds).not.toContain('phone-alerts');
    expect(settingsPageView('interface')).toEqual({ kind: 'settings', page: 'notifications' });
    expect(settingsPageView('phone-alerts')).toEqual({ kind: 'settings', page: 'notifications' });
    expect(settingsPageView('appearance')).toEqual({ kind: 'settings', page: 'appearance' });
    expect(settingsPageView('network')).toEqual({ kind: 'settings', page: 'general' });
    expect(settingsPageIds).not.toContain('network');
    expect(settingsPageView('pricing')).toEqual(usageView({ tab: 'prices' }));
    expect(settingsPageView('gone')).toBeNull();
  });

  test('Sign-in left Settings for Accounts › Sign-ins, which signs in itself, and its old id leads there', () => {
    expect(settingsPageIds).not.toContain('oauth');
    expect(settingsPageView('oauth')).toEqual(accountSignInsView());
    expect(settingsPageView('auth-files')).toEqual(accountSignInsView());
  });
});

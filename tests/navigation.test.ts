import { describe, expect, test } from 'bun:test';
import { accountSignInsView, canOpenView, hasMachineScope, keepMachineScope, libraryView, mainView, setupView, sessionsView, settingsPageIds, settingsPageView, usageView } from '../src/navigation';

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

  test('the views a machine narrows are every view of Sessions and Usage', () => {
    for (const tab of ['live', 'sessions', 'projects']) expect(hasMachineScope('sessions', tab)).toBe(true);
    for (const tab of ['overview', 'digest', 'events', 'prices', 'lifetime']) expect(hasMachineScope('usage', tab)).toBe(true);
    // Opening the page without naming a view isn't narrowed until the view is known.
    expect(hasMachineScope('usage', undefined)).toBe(false);
    expect(hasMachineScope('setup', 'cost')).toBe(false);
  });

  test('another view of the same page keeps the machine it was narrowed to, and nothing else carries it', () => {
    const live = sessionsView({ tab: 'live', machine: 'cedar-02' });
    expect(keepMachineScope(live, sessionsView({ tab: 'sessions' }))).toEqual(sessionsView({ tab: 'sessions', machine: 'cedar-02' }));
    // A view that names its own machine keeps it, and one that can't be narrowed isn't.
    expect(keepMachineScope(live, sessionsView({ tab: 'projects', machine: 'studio' }))).toEqual(sessionsView({ tab: 'projects', machine: 'studio' }));
    const requests = usageView({ tab: 'events', machine: 'cedar-02' });
    expect(keepMachineScope(requests, usageView())).toEqual(usageView());
    expect(keepMachineScope(requests, usageView({ tab: 'lifetime' }))).toEqual(usageView({ tab: 'lifetime', machine: 'cedar-02' }));
    expect(keepMachineScope(requests, usageView({ tab: 'overview' }))).toEqual(usageView({ tab: 'overview', machine: 'cedar-02' }));
    // Each page keeps its own choice.
    expect(keepMachineScope(live, usageView({ tab: 'overview' }))).toEqual(usageView({ tab: 'overview' }));
    expect(keepMachineScope(live, setupView({ tab: 'library' }))).toEqual(setupView({ tab: 'library' }));
  });

  test("The Library's Cost and the Repo's Arbor's changes keep each other's machine", () => {
    const cost = setupView({ tab: 'library', lens: 'cost', machine: 'cedar-02' });
    const changes = (machine?: string) => setupView({ tab: 'repo', lens: 'changes', ...(machine ? { machine } : {}) });
    expect(keepMachineScope(cost, changes())).toEqual(changes('cedar-02'));
    expect(keepMachineScope(changes('studio'), libraryView(undefined, 'cost'))).toEqual(setupView({ tab: 'library', lens: 'cost', machine: 'studio' }));
    // Views without a machine in their breadcrumb don't take one.
    expect(keepMachineScope(cost, setupView({ tab: 'software' }))).toEqual(setupView({ tab: 'software' }));
    expect(keepMachineScope(cost, libraryView('skills'))).toEqual(libraryView('skills'));
  });
});

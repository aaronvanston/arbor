import { describe, expect, test } from 'bun:test';
import { mainPageIds, mainView, machinesView, sessionsView, settingsPageIds, usageView } from '../src/navigation';
import { arriveWhenLoaded, cancelPendingArrival, pageModuleFor, prefetchAttribute } from '../src/pageModules';

describe('page modules', () => {
  test('every page but Home has code to load, and a view loads the code its page renders with', () => {
    for (const page of mainPageIds) expect(pageModuleFor(mainView(page)) === null).toBe(page === 'home');
    for (const page of settingsPageIds) expect(pageModuleFor({ kind: 'settings', page })).not.toBeNull();
    // Machines and Sessions are views of the usage records page.
    expect(pageModuleFor(machinesView('ci-01'))).toBe(pageModuleFor(usageView()));
    expect(pageModuleFor(sessionsView({ session: 'a1' }))).toBe(pageModuleFor(usageView()));
    expect(pageModuleFor({ kind: 'settings', page: 'routing' })).toBe(pageModuleFor({ kind: 'settings', page: 'general' }));
  });

  test('a link marks the page it leads to, and a link to Home marks nothing', () => {
    expect(prefetchAttribute(mainView('alerts'))).toEqual({ 'data-prefetch': 'alerts' });
    expect(prefetchAttribute(mainView('home'))).toEqual({});
  });

  test('a page whose code is still loading never lands after a later step has been taken', async () => {
    const arrived: string[] = [];
    const slow = arriveWhenLoaded(mainView('alerts'), () => arrived.push('alerts'));
    // Home has no code to wait for, so it arrives at once and the alerts page's load no longer leads anywhere.
    void arriveWhenLoaded(mainView('home'), () => arrived.push('home'));
    await slow;
    expect(arrived).toEqual(['home']);

    // Its code is here now, so it arrives at once.
    void arriveWhenLoaded(mainView('alerts'), () => arrived.push('alerts'));
    expect(arrived).toEqual(['home', 'alerts']);

    // Back or Forward taken mid-load wins too.
    const pending = arriveWhenLoaded({ kind: 'settings', page: 'about' }, () => arrived.push('about'));
    cancelPendingArrival();
    await pending;
    expect(arrived).toEqual(['home', 'alerts']);
  });
});

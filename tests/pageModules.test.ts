import { describe, expect, test } from 'bun:test';
import { checkoutsView, mainPageIds, mainView, machinesView, sessionsView, settingsPageIds, usageView } from '../src/navigation';
import { arriveWhenLoaded, cancelPendingArrival, pageModulesFor, prefetchAttribute } from '../src/pageModules';

describe('page modules', () => {
  test('every page but Home has code to load, and a view loads the code its page renders with', () => {
    for (const page of mainPageIds) expect(pageModulesFor(mainView(page)).length === 0).toBe(page === 'home');
    for (const page of settingsPageIds) expect(pageModulesFor({ kind: 'settings', page })).toHaveLength(1);
    expect(pageModulesFor({ kind: 'settings', page: 'routing' })).toEqual(pageModulesFor({ kind: 'settings', page: 'general' }));
    // Machines and Sessions are views of the usage records page; one machine's page, a session's and Checkouts bring
    // code of their own on top.
    const usage = pageModulesFor(usageView());
    expect(pageModulesFor(machinesView())).toEqual(usage);
    expect(pageModulesFor(sessionsView())).toEqual(usage);
    expect(pageModulesFor(machinesView('ci-01'))).toEqual([...usage, 'machinePage']);
    expect(pageModulesFor(sessionsView({ session: 'a1' }))).toEqual([...usage, 'sessionDetail']);
    expect(pageModulesFor(checkoutsView())).toEqual([...usage, 'checkouts']);
  });

  test('a link marks the page it leads to, and a link to Home marks nothing', () => {
    expect(prefetchAttribute(mainView('alerts'))).toEqual({ 'data-prefetch': 'alerts' });
    expect(prefetchAttribute(mainView('home'))).toEqual({});
    expect(prefetchAttribute(machinesView('ci-01'))).toEqual({ 'data-prefetch': 'usage machinePage' });
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

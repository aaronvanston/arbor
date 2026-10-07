import { describe, expect, it } from 'bun:test';
import { en } from '../src/i18n/locales/en';
import { alertDestinationView } from '../src/alertNavigation';
import { alertDestination, withAlert } from '../src/services/alertHistory';
import { keeperLine, keeperNotification } from '../src/services/setupRepoKeeper';
import { present } from './support/items';
import type { RepoKeeper } from '../src/native/types';

const kept: RepoKeeper = {
  enabled: true, repo: '/Users/cam/src/agent-setup', upstream: 'origin/main', ahead: 0, behind: 0,
  lastFetchMs: 1_000, lastPullMs: null, lastPushMs: null, checkedMs: 1_000, problem: null, detail: null, running: false,
};
const t = (key: keyof typeof en, values: Record<string, string | number> = {}) =>
  Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), en[key] as string);

describe('keeping the setup repo in step', () => {
  it('says whether it’s kept, off, following nothing, or what stopped it', () => {
    expect(keeperLine(kept)).toEqual({ kind: 'kept', upstream: 'origin/main', fetchedMs: 1_000, running: false });
    expect(keeperLine({ ...kept, enabled: false, problem: 'diverged' })).toEqual({ kind: 'off' });
    expect(keeperLine({ ...kept, upstream: null })).toEqual({ kind: 'noRemote' });
    expect(keeperLine({ ...kept, problem: 'dirty', detail: null })).toEqual({ kind: 'problem', key: 'repoKeeper.problem.dirty', detail: null });
  });

  it('raises an alert only for trouble, about the repo so repeats fold, and it opens Sync › Repo', () => {
    expect(keeperNotification(kept, t)).toBeNull();
    expect(keeperNotification({ ...kept, enabled: false, problem: 'auth' }, t)).toBeNull();
    const alert = present(keeperNotification({ ...kept, problem: 'diverged' }, t));
    expect(alert.kind).toBe('setupRepo');
    expect(alert.body).toContain('origin/main each have commits');
    expect(alert.subject).toEqual({ repo: '/Users/cam/src/agent-setup' });
    const destination = present(alertDestination({ kind: 'setupRepo', subject: alert.subject }));
    expect(alertDestinationView(destination)).toEqual({ kind: 'main', page: 'setup', params: { tab: 'repo' } });

    const record = (id: string, atMs: number) => ({ id, atMs, ...alert, urgent: false });
    const first = withAlert({ entries: [], seenAtMs: 0 }, record('a', 1_000), 1_000);
    const again = withAlert(first.history, record('b', 2_000), 2_000);
    expect([first.deliver, again.deliver, again.history.entries.length]).toEqual([true, false, 1]);
  });
});

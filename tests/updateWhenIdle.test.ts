import { describe, expect, test } from 'bun:test';
import { appUpdateIndicatorState } from '../src/appUpdateModel';
import { translate } from '../src/i18n';
import {
  appUpdateRestartsProxy,
  availableBesideWaiting,
  cancelIdleUpdates,
  dueIdleUpdates,
  emptyIdleUpdates,
  IDLE_UPDATE_CHECK_MS,
  IDLE_UPDATE_WAIT_MS,
  idleAppUpdateBlocked,
  idleAppUpdateOutcome,
  idleUpdateConfirmation,
  idleUpdateDueAtMs,
  idleUpdateFailureKey,
  idleUpdatePillDetail,
  idleUpdateTitleKey,
  idleUpdateWaitingText,
  liveAgentLoad,
  observeAgents,
  recordAgentCheck,
  scheduleIdleUpdate,
  takeDueIdleUpdates,
  withIdleUpdate,
  withIdleUpdateFailure,
  withoutIdleUpdates,
  withoutSettled,
  type IdleUpdateState,
} from '../src/services/updateWhenIdle';
import type { LiveSession, LiveSessionsReport } from '../src/native/types';

const SECOND = 1_000;
const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);

const session = (id: string, machine: string, transcriptMachine = ''): LiveSession => ({
  id, parentId: null, depth: 0, models: [], providers: ['claude'], userAgent: null,
  startedAtMs: 0, lastActiveAtMs: 0, requests: 1, failures: 0, canceled: 0,
  inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  totalTokens: 0, estimatedCost: 0, pricedRequests: 0, peakContext: 0, compactions: 0,
  provider: 'claude', machine, pool: '', apiKeyHash: '', active: true, hasOwnRequests: true, subagents: 0, threads: [],
  transcript: transcriptMachine ? {
    machine: transcriptMachine, agent: 'claude', home: '', agentHome: '', cwd: '', repoRoot: '', mainRepo: '', branch: '', commitHash: '',
    repositoryUrl: '', title: '', titleSource: '', pullRequests: [], linesAdded: null, linesRemoved: null, compactions: [],
    toolUsage: null, readAtMs: 0,
  } : null,
  runningSinceMs: 0,
  context: { tokens: 0, model: '', compactsAt: null, basis: '', growthPerMinute: null, compactsInMs: null },
});

const report = (sessions: LiveSession[], running = sessions.length): LiveSessionsReport => ({
  sessions, running, costPerHour: 0, requests: 0, pricedRequests: 0, clients: [],
});

describe('what an update would cut', () => {
  test('counts the running sessions and the machines they are on', () => {
    expect(liveAgentLoad(report([
      session('a', 'casey-mbp'),
      session('b', 'casey-mbp'),
      session('c', '', 'ci-01'),
    ]))).toEqual({ sessions: 3, machines: 2 });
  });

  test('counts sessions the board does not list, and none with nothing running or no check yet', () => {
    expect(liveAgentLoad(report([session('a', 'casey-mbp')], 14))).toEqual({ sessions: 14, machines: 1 });
    expect(liveAgentLoad(report([session('a', '')]))).toEqual({ sessions: 1, machines: 0 });
    expect(liveAgentLoad(report([]))).toEqual({ sessions: 0, machines: 0 });
    expect(liveAgentLoad(null)).toEqual({ sessions: 0, machines: 0 });
  });

  test('warns with how many are running, and on how many machines when it is more than one', () => {
    expect(idleUpdateConfirmation({ kind: 'app', version: '0.3.34' }, { sessions: 3, machines: 1 }, t)).toEqual({
      title: '3 agent sessions are running',
      message: 'Updating restarts the proxy, so their current requests will fail.',
      confirmText: 'Update when idle',
      secondaryText: 'Update now',
    });
    expect(idleUpdateConfirmation({ kind: 'core', version: 'v7.3.16' }, { sessions: 3, machines: 2 }, t).message)
      .toBe('They’re on 2 machines. Updating restarts the proxy, so their current requests will fail.');
    expect(idleUpdateConfirmation({ kind: 'restart' }, { sessions: 2, machines: 2 }, t).message)
      .toBe('They’re on 2 machines. Restarting the proxy makes their current requests fail.');
    expect(idleUpdateConfirmation({ kind: 'restart' }, { sessions: 1, machines: 1 }, t)).toEqual({
      title: '1 agent session is running',
      message: 'Restarting the proxy makes their current requests fail.',
      confirmText: 'Restart when idle',
      secondaryText: 'Restart now',
    });
  });

  test('a reinstall says so rather than calling itself an update', () => {
    const reinstall = { kind: 'core', version: 'v7.3.15', reinstall: true } as const;
    expect(idleUpdateConfirmation(reinstall, { sessions: 3, machines: 1 }, t)).toEqual({
      title: '3 agent sessions are running',
      message: 'Reinstalling restarts the proxy, so their current requests will fail.',
      confirmText: 'Reinstall when idle',
      secondaryText: 'Reinstall now',
    });
    expect(idleUpdateConfirmation(reinstall, { sessions: 3, machines: 2 }, t).message)
      .toBe('They’re on 2 machines. Reinstalling restarts the proxy, so their current requests will fail.');
  });
});

describe('whether installing Arbor restarts the proxy', () => {
  test('only when it bundles a newer core than the one installed', () => {
    expect(appUpdateRestartsProxy('7.3.17', 'v7.3.17')).toBe(false);
    expect(appUpdateRestartsProxy('7.3.17', 'v8.0.2')).toBe(false);
    expect(appUpdateRestartsProxy('8.0.3', 'v8.0.2')).toBe(true);
    expect(appUpdateRestartsProxy('7.3.100', '7.3.99')).toBe(true);
  });

  test('not knowing either version counts as a restart', () => {
    expect(appUpdateRestartsProxy(null, 'v8.0.2')).toBe(true);
    expect(appUpdateRestartsProxy('8.0.2', null)).toBe(true);
  });
});

describe('waiting for idle agents', () => {
  const waiting = withIdleUpdate(emptyIdleUpdates, { kind: 'app', version: '0.3.34' });

  test('goes ahead once no session has run for the whole wait', () => {
    let state = observeAgents(waiting, 2, 0);
    expect(state.idleSinceMs).toBeNull();
    state = observeAgents(state, 0, 30 * SECOND);
    expect(state.idleSinceMs).toBe(30 * SECOND);
    // Later checks that find none keep counting from the first.
    state = observeAgents(state, 0, 90 * SECOND);
    expect(state.idleSinceMs).toBe(30 * SECOND);
    expect(idleUpdateDueAtMs(state)).toBe(30 * SECOND + IDLE_UPDATE_WAIT_MS);
    expect(dueIdleUpdates(state, 30 * SECOND + IDLE_UPDATE_WAIT_MS - 1)).toEqual([]);
    expect(dueIdleUpdates(state, 30 * SECOND + IDLE_UPDATE_WAIT_MS)).toEqual([{ kind: 'app', version: '0.3.34' }]);
  });

  test('a session starting again starts the wait over', () => {
    let state = observeAgents(waiting, 0, 0);
    state = observeAgents(state, 1, IDLE_UPDATE_WAIT_MS - SECOND);
    expect(state.idleSinceMs).toBeNull();
    expect(dueIdleUpdates(state, IDLE_UPDATE_WAIT_MS)).toEqual([]);
    state = observeAgents(state, 0, IDLE_UPDATE_WAIT_MS);
    expect(dueIdleUpdates(state, 2 * IDLE_UPDATE_WAIT_MS - 1)).toEqual([]);
    expect(dueIdleUpdates(state, 2 * IDLE_UPDATE_WAIT_MS)).toHaveLength(1);
  });

  test('a failed check starts the wait over, as a session may have started', () => {
    const state = observeAgents(observeAgents(waiting, 0, 0), null, 60 * SECOND);
    expect(state.idleSinceMs).toBeNull();
    expect(dueIdleUpdates(state, 10 * IDLE_UPDATE_WAIT_MS)).toEqual([]);
  });

  test('time this Mac spent asleep is not quiet time', () => {
    // Checks on time find none running, then the Mac sleeps for an hour with the wait nearly done.
    let state = observeAgents(waiting, 0, 0, null);
    state = observeAgents(state, 0, IDLE_UPDATE_CHECK_MS, 0);
    expect(state.idleSinceMs).toBe(0);
    const woke = 60 * 60 * SECOND;
    state = observeAgents(state, 0, woke, IDLE_UPDATE_CHECK_MS);
    // The wait starts over from waking: the agents couldn't reach the proxy while it slept.
    expect(state.idleSinceMs).toBe(woke);
    expect(dueIdleUpdates(state, woke)).toEqual([]);
    expect(dueIdleUpdates(state, woke + IDLE_UPDATE_WAIT_MS - 1)).toEqual([]);
    // Checks back on time count from waking.
    state = observeAgents(state, 0, woke + IDLE_UPDATE_CHECK_MS, woke);
    expect(state.idleSinceMs).toBe(woke);
    expect(dueIdleUpdates(state, woke + IDLE_UPDATE_WAIT_MS)).toHaveLength(1);
    // A session found running on waking still stops the wait.
    expect(observeAgents(observeAgents(waiting, 0, 0), 2, woke, 0).idleSinceMs).toBeNull();
  });

  test('a check that is merely late keeps counting', () => {
    const state = observeAgents(observeAgents(waiting, 0, 0), 0, IDLE_UPDATE_CHECK_MS + 59 * SECOND, 0);
    expect(state.idleSinceMs).toBe(0);
  });

  test('the watcher starts the wait over after this Mac sleeps', () => {
    const start = 1_000 * 60 * SECOND;
    const woke = start + 8 * 60 * 60 * SECOND;
    scheduleIdleUpdate({ kind: 'restart' });
    try {
      recordAgentCheck(0, start);
      recordAgentCheck(0, start + IDLE_UPDATE_CHECK_MS);
      // Checks every 15 seconds from waking: nothing goes ahead until the whole wait has passed awake.
      for (let at = woke; at < woke + IDLE_UPDATE_WAIT_MS; at += IDLE_UPDATE_CHECK_MS) {
        recordAgentCheck(0, at);
        expect(takeDueIdleUpdates(at)).toEqual([]);
      }
      recordAgentCheck(0, woke + IDLE_UPDATE_WAIT_MS);
      expect(takeDueIdleUpdates(woke + IDLE_UPDATE_WAIT_MS)).toEqual([{ kind: 'restart' }]);
    } finally {
      cancelIdleUpdates();
    }
  });

  test('nothing waiting has nothing to count or start', () => {
    expect(observeAgents(emptyIdleUpdates, 0, 0)).toBe(emptyIdleUpdates);
    expect(idleUpdateDueAtMs(emptyIdleUpdates)).toBeNull();
    expect(dueIdleUpdates(emptyIdleUpdates, IDLE_UPDATE_WAIT_MS)).toEqual([]);
  });

  test('canceling stops the wait, keeping a failure to show', () => {
    const counting = observeAgents(waiting, 0, 0);
    const canceled = withoutIdleUpdates(counting);
    expect(canceled.updates).toEqual([]);
    expect(dueIdleUpdates(canceled, IDLE_UPDATE_WAIT_MS)).toEqual([]);
    const failed = withIdleUpdateFailure(counting, { kind: 'restart' }, 'port in use');
    expect(withoutIdleUpdates(failed).failure).toEqual({ update: { kind: 'restart' }, error: 'port in use' });
  });

  test('another update waits alongside, the core first, and the wait starts over', () => {
    const counting = observeAgents(waiting, 0, 0);
    const both = withIdleUpdate(counting, { kind: 'core', version: 'v7.3.16' });
    expect(both.updates).toEqual([{ kind: 'core', version: 'v7.3.16' }, { kind: 'app', version: '0.3.34' }]);
    expect(both.idleSinceMs).toBeNull();
    // A newer choice for the same thing replaces the old one.
    expect(withIdleUpdate(both, { kind: 'app', version: '0.3.35' }).updates)
      .toEqual([{ kind: 'core', version: 'v7.3.16' }, { kind: 'app', version: '0.3.35' }]);
  });

  test('a restart does not replace a core install, which restarts the core anyway', () => {
    const install = withIdleUpdate(emptyIdleUpdates, { kind: 'core', version: 'v7.3.16' });
    expect(withIdleUpdate(install, { kind: 'restart' }).updates).toEqual([{ kind: 'core', version: 'v7.3.16' }]);
    const restart = withIdleUpdate(emptyIdleUpdates, { kind: 'restart' });
    expect(withIdleUpdate(restart, { kind: 'core', version: 'v7.3.16' }).updates).toEqual([{ kind: 'core', version: 'v7.3.16' }]);
  });

  test('starting one by hand stops waiting for it', () => {
    const state: IdleUpdateState = {
      ...withIdleUpdate(withIdleUpdate(emptyIdleUpdates, { kind: 'app', version: '0.3.34' }), { kind: 'restart' }),
      idleSinceMs: 5 * SECOND,
    };
    expect(withoutSettled(state, 'app').updates).toEqual([{ kind: 'restart' }]);
    expect(withoutSettled(state, 'app').idleSinceMs).toBe(5 * SECOND);
    // Installing a core restarts it; restarting doesn't install one.
    expect(withoutSettled(state, 'core').updates).toEqual([{ kind: 'app', version: '0.3.34' }]);
    const install = withIdleUpdate(emptyIdleUpdates, { kind: 'core', version: 'v7.3.16' });
    expect(withoutSettled(install, 'restart')).toBe(install);
    expect(withoutSettled(withoutSettled(state, 'app'), 'restart')).toEqual({ updates: [], idleSinceMs: null, failure: null });
  });

  test('scheduling again clears the last failure', () => {
    const failed = withIdleUpdateFailure(emptyIdleUpdates, { kind: 'core', version: 'v7.3.16' }, 'download failed');
    expect(withIdleUpdate(failed, { kind: 'restart' }).failure).toBeNull();
  });
});

describe('what the waiting says', () => {
  test('names what waits', () => {
    expect(idleUpdateWaitingText([{ kind: 'app', version: '0.3.34' }], t)).toBe('Arbor 0.3.34 installs once agents have been idle for 2 minutes.');
    expect(idleUpdateWaitingText([{ kind: 'core', version: 'v7.3.16' }, { kind: 'app', version: '0.3.34' }], t))
      .toBe('Arbor 0.3.34 and proxy core v7.3.16 install once agents have been idle for 2 minutes.');
    expect(idleUpdateWaitingText([{ kind: 'restart' }, { kind: 'app', version: '0.3.34' }], t))
      .toBe('The proxy restarts and Arbor 0.3.34 installs once agents have been idle for 2 minutes.');
    expect(idleUpdateWaitingText([{ kind: 'restart' }], t)).toBe('The proxy restarts once agents have been idle for 2 minutes.');
  });

  test('the sidebar pill lists what waits', () => {
    expect(idleUpdatePillDetail([{ kind: 'core', version: 'v7.3.16' }, { kind: 'app', version: '0.3.34' }], t)).toBe('App 0.3.34 · Core v7.3.16');
    expect(idleUpdatePillDetail([{ kind: 'restart' }], t)).toBe('Core restart');
  });

  test('a restart on its own is not an update', () => {
    expect(t(idleUpdateTitleKey([{ kind: 'restart' }]))).toBe('Restarts when agents are idle');
    expect(t(idleUpdateTitleKey([{ kind: 'restart' }, { kind: 'app', version: '0.3.34' }]))).toBe('Updates when agents are idle');
  });

  test('nor is a reinstall of the core installed', () => {
    const reinstall = { kind: 'core', version: 'v7.3.15', reinstall: true } as const;
    expect(t(idleUpdateTitleKey([reinstall]))).toBe('Reinstalls when agents are idle');
    expect(t(idleUpdateTitleKey([reinstall, { kind: 'app', version: '0.3.34' }]))).toBe('Updates when agents are idle');
    expect(idleUpdatePillDetail([reinstall], t)).toBe('Core v7.3.15 reinstall');
    expect(idleUpdateWaitingText([reinstall], t)).toBe('Proxy core v7.3.15 reinstalls once agents have been idle for 2 minutes.');
    expect(idleUpdateWaitingText([reinstall, { kind: 'app', version: '0.3.34' }], t))
      .toBe('Proxy core v7.3.15 reinstalls and Arbor 0.3.34 installs once agents have been idle for 2 minutes.');
    expect(t(idleUpdateFailureKey(reinstall))).toBe('Couldn’t reinstall when agents went idle');
    expect(t(idleUpdateFailureKey({ kind: 'core', version: 'v7.3.16' }))).toBe('Couldn’t update when agents went idle');
    expect(t(idleUpdateFailureKey({ kind: 'restart' }))).toBe('Couldn’t restart when agents went idle');
  });

  test('updates available still show beside what waits', () => {
    const available = { app: '0.3.34', core: 'v7.3.16' };
    expect(availableBesideWaiting([], available)).toEqual(available);
    // A restart waiting installs neither.
    expect(availableBesideWaiting([{ kind: 'restart' }], available)).toEqual(available);
    // Arbor installs its latest whenever it goes ahead; the core only the version waiting.
    expect(availableBesideWaiting([{ kind: 'app', version: '0.3.33' }], available)).toEqual({ app: '', core: 'v7.3.16' });
    expect(availableBesideWaiting([{ kind: 'core', version: 'v7.3.16' }], available)).toEqual({ app: '0.3.34', core: '' });
    // Reinstalling the core installed leaves the update to show.
    expect(availableBesideWaiting([{ kind: 'core', version: 'v7.3.15', reinstall: true }], available)).toEqual(available);
    expect(availableBesideWaiting([{ kind: 'restart' }], { app: '', core: '' })).toEqual({ app: '', core: '' });
  });

  test('the sidebar pill shows the wait until an update is under way', () => {
    expect(appUpdateIndicatorState(true, false, false, true)).toBe('waiting');
    expect(appUpdateIndicatorState(false, false, false, true)).toBe('waiting');
    expect(appUpdateIndicatorState(true, false, true, true)).toBe('processing');
    expect(appUpdateIndicatorState(true, false, false)).toBe('available');
  });
});

describe('an Arbor install that goes ahead by itself', () => {
  const app = { kind: 'app', version: '0.3.34' } as const;

  test('goes ahead only when the last check found an update it can install', () => {
    expect(idleAppUpdateBlocked(app, { updateAvailable: true, autoUpdateSupported: true }, t)).toBe('');
    expect(idleAppUpdateBlocked(app, null, t)).toBe('Arbor 0.3.34 wasn’t installed because the last update check didn’t find it. Check again in Settings › Updates.');
    expect(idleAppUpdateBlocked(app, { updateAvailable: false, autoUpdateSupported: true }, t)).toContain('didn’t find it');
    expect(idleAppUpdateBlocked(app, { updateAvailable: true, autoUpdateSupported: false }, t))
      .toBe('Arbor 0.3.34 can’t install itself on this Mac. Download it from its release page in Settings › Updates.');
    expect(idleAppUpdateBlocked({ kind: 'restart' }, null, t)).toBe('');
  });

  test('reads how it went from its task', () => {
    expect(idleAppUpdateOutcome({ phase: 'downloading', message: null }, t)).toBeNull();
    expect(idleAppUpdateOutcome({ phase: 'staging', message: null }, t)).toBeNull();
    expect(idleAppUpdateOutcome({ phase: 'failed', message: 'Signature check failed' }, t)).toEqual({ failed: 'Signature check failed' });
    expect(idleAppUpdateOutcome({ phase: 'failed', message: null }, t)).toEqual({ failed: 'Update failed' });
    // Canceled by hand, or past failing: nothing to keep.
    expect(idleAppUpdateOutcome({ phase: 'canceled', message: null }, t)).toBe('settled');
    expect(idleAppUpdateOutcome({ phase: 'restarting', message: null }, t)).toBe('settled');
  });
});

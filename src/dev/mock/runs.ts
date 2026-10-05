/** The browser mock's harness runs: started on a pool, handed to T3 Code, Orca or an agent's command line. */
import { emit } from '@tauri-apps/api/event';
import type { MachineCommands } from '../../native/machines';
import type { HarnessRun, MachineHealthSnapshot, RunHarness, RunRequest } from '../../native/types';
import type { CommandAnswers } from './answers';
import { poolsNow, preview } from './pools';
import { freshInstall, later, mockLog, now, params } from './scenario';

// `?runs=none`, `queued` or `failed` (listed at the top of mockTauri.ts).
const runsScenario = params.get('runs');
const minute = 60_000;

const base = (id: string, overrides: Partial<HarnessRun>): HarnessRun => ({
  id, trigger: null, pool: 'mock-builds', ranPool: 'mock-builds', machine: 'casey-mbp', harness: 't3', used: 't3',
  setup: 'codex_work', folder: '~/src/storefront', repo: null, title: 'Tidy the flaky checkout tests', state: 'handedOff', reason: null,
  detail: null, handle: {}, queuedAtMs: now - 12 * minute, startedAtMs: now - 12 * minute + 4_000, endedAtMs: null, waitUntilMs: null,
  ...overrides,
});

const fixtures = (): HarnessRun[] => {
  if (runsScenario === 'none' || freshInstall) return [];
  const runs: HarnessRun[] = [
    base('run-session', {
      machine: 'cedar-02', harness: 'orca', used: 'orca', setup: 'claude', repo: 'github.com/acme/storefront', title: 'Split the checkout page into steps',
      handle: { terminal: 'term_9c1d', worktree: 'arbor-5e1f0a2b' }, queuedAtMs: now - 4 * minute, startedAtMs: now - 4 * minute + 3_000,
    }),
    base('run-t3', { handle: { projectId: 'p-store', threadId: 't-1' } }),
    base('run-orca', {
      machine: 'cedar-02', harness: 'orca', used: 'orca', setup: 'claude', title: 'Update the billing docs for the new plans',
      handle: { terminal: 'term_7f2a' }, queuedAtMs: now - 40 * minute, startedAtMs: now - 40 * minute + 2_500,
    }),
    base('run-headless', {
      machine: 'ci-01', harness: 'orca', used: 'headless', setup: 'codex', title: 'Bump dependencies and run the suite', state: 'exited',
      handle: { pid: 81_244, log: '~/.arbor/runs/run-headless.log' }, queuedAtMs: now - 3 * 60 * minute, startedAtMs: now - 3 * 60 * minute + 3_000, endedAtMs: now - 2 * 60 * minute,
    }),
    base('run-spilled', {
      ranPool: 'mock-overflow', machine: 'ci-01', harness: 't3', used: 't3', setup: 'claudeAgent', title: 'Nightly lint sweep',
      trigger: 'nightly-lint', handle: { projectId: 'p-store', threadId: 't-2' }, queuedAtMs: now - 9 * 60 * minute, startedAtMs: now - 9 * 60 * minute + 5_000,
    }),
  ];
  if (runsScenario === 'queued') {
    runs.unshift(
      base('run-queued', {
        pool: 'mock-overflow', ranPool: null, machine: null, used: null, state: 'queued', reason: 'noRoom', title: 'Refresh the screenshots',
        startedAtMs: null, queuedAtMs: now - 6 * minute, waitUntilMs: now + 39 * minute,
      }),
      base('run-queued-harness', {
        pool: 'mock-overflow', ranPool: null, machine: null, used: null, harness: 'orca', setup: 'codex', state: 'queued', reason: 'noHarness',
        title: 'Triage new issues', startedAtMs: null, queuedAtMs: now - 2 * minute, waitUntilMs: now + 43 * minute,
      }),
    );
  }
  if (runsScenario === 'failed') {
    runs.unshift(
      base('run-refused', { machine: null, ranPool: null, used: null, state: 'refused', reason: 'noRoom', title: 'Rebuild the docs site', startedAtMs: null, queuedAtMs: now - 3 * minute, endedAtMs: now - 3 * minute }),
      base('run-no-folder', { machine: null, ranPool: null, harness: 'orca', used: null, setup: 'claude', folder: '', repo: 'github.com/acme/uploads', state: 'refused', reason: 'noFolder', detail: 'cedar-02, ci-01', title: 'Fix the flaky upload test', startedAtMs: null, queuedAtMs: now - 5 * minute, endedAtMs: now - 5 * minute + 4_000 }),
      base('run-model', { state: 'failed', reason: 'noModel', detail: 'no_model', title: 'Write release notes', handle: {}, queuedAtMs: now - 8 * minute, endedAtMs: now - 8 * minute + 3_000 }),
      base('run-hand-off', { machine: 'cedar-02', state: 'failed', reason: 'handOffFailed', detail: 'not_running', title: 'Clean up feature flags', handle: {}, queuedAtMs: now - 20 * minute, endedAtMs: now - 20 * minute + 2_000 }),
      base('run-agent', {
        machine: 'cedar-02', harness: 'headless', used: 'headless', setup: 'claude', folder: '~', state: 'failed', reason: 'agentFailed', detail: '1', title: 'Hello',
        handle: { pid: 4_410, log: '~/.arbor/runs/run-agent.log', sessionId: 'e5d4c3b2-a190-4f8e-9d7c-6b5a4f3e2d1c' },
        queuedAtMs: now - minute, startedAtMs: now - minute + 2_000, endedAtMs: now - 20_000,
      }),
      // Started before runs kept logs, and its machine restarted under it.
      base('run-agent-old', { machine: 'ci-01', used: 'headless', setup: 'claude', state: 'failed', reason: 'agentFailed', detail: 'gone', title: 'Profile the import job', handle: { pid: 4_411 }, queuedAtMs: now - 70 * minute, endedAtMs: now - 50 * minute }),
      base('run-timed-out', { pool: 'mock-overflow', ranPool: null, machine: null, used: null, state: 'timedOut', reason: 'noRoom', title: 'Re-run the visual diff', startedAtMs: null, queuedAtMs: now - 4 * 60 * minute, endedAtMs: now - 3 * 60 * minute }),
    );
  }
  return runs;
};

let runs = fixtures();

const changed = () => void emit('harness-runs-updated', Date.now());

/** Where the native side would send a run: the pool's likeliest member, following spills, or why nobody can take it. */
function start(request: RunRequest, snapshot: MachineHealthSnapshot): HarnessRun {
  const title = request.title?.trim() || request.prompt.split('\n').find((line) => line.trim())?.trim().slice(0, 80) || 'Arbor run';
  const run: HarnessRun = base(`run-${Date.now().toString(36)}`, {
    pool: request.pool, ranPool: null, machine: null, harness: request.harness, used: null, setup: request.setup, folder: request.folder,
    repo: request.repo ?? null,
    title, trigger: request.trigger ?? null, state: 'starting', handle: {}, queuedAtMs: Date.now(), startedAtMs: null,
  });
  const seen = new Set<string>();
  let poolId: string | null = request.pool;
  while (poolId && !seen.has(poolId)) {
    seen.add(poolId);
    const pool = poolsNow().find((entry) => entry.id === poolId);
    if (!pool) return { ...run, state: 'refused', reason: 'noPool', endedAtMs: Date.now() };
    const likely = preview(pool, snapshot).likely;
    if (likely) {
      const used = request.harness === 'headless' ? 'headless' : request.harness;
      const handle = used === 't3' ? { projectId: 'p-mock', threadId: `t-${Date.now().toString(36)}` } : used === 'orca' ? { terminal: 'term_new1' } : { pid: 51_000 };
      const worktree = request.worktree && used !== 't3' ? { worktree: `arbor-${Date.now().toString(16).slice(-8)}` } : {};
      // A run on a repo works in the member's checkout of it, as its Projects scan found it.
      const folder = request.repo ? `~/src/${request.repo.split('/').pop() ?? 'project'}` : request.folder;
      return { ...run, ranPool: pool.id, machine: likely, used, folder, handle: { ...handle, ...worktree }, state: used === 'headless' ? 'running' : 'handedOff', startedAtMs: Date.now() };
    }
    if (pool.whenFull === 'spill') { poolId = pool.spillPool; continue; }
    if (pool.whenFull === 'queue') return { ...run, state: 'queued', reason: 'noRoom', waitUntilMs: Date.now() + pool.queueTimeoutMin * minute };
    break;
  }
  return { ...run, state: 'refused', reason: 'noRoom', endedAtMs: Date.now() };
}

// Follows set_run_harnesses_off, as the native side does.
let harnessesOff: RunHarness[] = [];

export const runAnswers = (
  snapshot: () => MachineHealthSnapshot,
): Pick<CommandAnswers<MachineCommands>, 'start_pool_run' | 'set_run_harnesses_off' | 'get_runs' | 'cancel_run' | 'open_run'> => ({
  start_pool_run: ({ request }) => {
    // The prompt is the run's own; the log keeps everything else.
    mockLog('start_pool_run', { ...request, prompt: `(${request.prompt.length} characters)` });
    if (harnessesOff.includes(request.harness) && !request.fallback) {
      throw new Error(`Runs aren't handed to ${request.harness === 't3' ? 'T3 Code' : 'Orca'} now. Turn it on in Settings › Harnesses, or let the run use the command line.`);
    }
    // A run on a repo needs no folder: each member works in its own checkout.
    if (!request.repo && (!/^(~|~\/|\/)/.test(request.folder.trim()) || request.folder.split('/').includes('..'))) throw new Error("A run's folder starts with ~/ or / and has no .. in it.");
    if (!request.prompt.trim()) throw new Error('A run needs a prompt.');
    return later(900, () => {
      const run = start(request, snapshot());
      runs = [run, ...runs];
      changed();
      return run;
    });
  },
  set_run_harnesses_off: ({ off }) => {
    mockLog('set_run_harnesses_off', { off });
    if (off.includes('headless')) throw new Error("The command line is the last resort and can't be turned off");
    harnessesOff = off;
    return null;
  },
  get_runs: () => runs,
  cancel_run: ({ id }) => {
    mockLog('cancel_run', { id });
    runs = runs.map((run) => run.id === id && run.state === 'queued' ? { ...run, state: 'refused', reason: 'canceled', endedAtMs: Date.now(), waitUntilMs: null } : run);
    changed();
    return runs;
  },
  open_run: ({ id }) => {
    mockLog('open_run', { id });
    const run = runs.find((entry) => entry.id === id);
    if (!run?.handle.terminal) throw new Error('Only runs handed to Orca can be opened from Arbor.');
    if (params.get('runs') === 'open-fail') throw new Error("Orca couldn't find the run's terminal. It may have been closed.");
  },
});

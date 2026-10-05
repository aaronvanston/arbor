import { useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invokeCommand } from '../native/commands';
import type { MessageKey } from '../i18n/resources';
import type { HarnessRun, MachineHealth, MachinePool, RunHarness, RunReason, RunRequest, RunState } from '../native/types';
import { type HarnessSetupRow, machineHarnesses } from './harnesses';
import { sshCommand } from './fixPrompt';
import { shellPath, shellWord } from './setupChecklist';

/**
 * Harness runs (see `runs.rs`): work started on a pool and handed to T3 Code, Orca or, as a last resort, an agent's own
 * command line on the machine the pool picks. Arbor keeps where each went and how it went; the run itself is the
 * harness's, so its conversation is never read.
 */

export const HARNESS_RUNS_UPDATED_EVENT = 'harness-runs-updated';

export const RUN_HARNESSES: readonly RunHarness[] = ['t3', 'orca', 'headless'];

export const RUN_STATE_LABEL: Record<RunState, MessageKey> = {
  queued: 'runs.state.queued',
  starting: 'runs.state.starting',
  handedOff: 'runs.state.handedOff',
  running: 'runs.state.running',
  exited: 'runs.state.exited',
  failed: 'runs.state.failed',
  refused: 'runs.state.refused',
  timedOut: 'runs.state.timedOut',
};

export type RunTone = 'info' | 'success' | 'warning' | 'error' | 'muted';

export const RUN_STATE_TONE: Record<RunState, RunTone> = {
  queued: 'info',
  starting: 'info',
  handedOff: 'success',
  running: 'success',
  exited: 'muted',
  failed: 'error',
  refused: 'warning',
  timedOut: 'warning',
};

const REASON_LABEL: Record<RunReason, MessageKey> = {
  noPool: 'runs.reason.noPool',
  noRoom: 'runs.reason.noRoom',
  noHarness: 'runs.reason.noHarness',
  noFolder: 'runs.reason.noFolder',
  noModel: 'runs.reason.noModel',
  handOffFailed: 'runs.reason.handOffFailed',
  arborRestarted: 'runs.reason.arborRestarted',
  canceled: 'runs.reason.canceled',
  agentFailed: 'runs.reason.agentFailed',
};

/** The failure codes the hand-off scripts print (`runs_handoff.rs`), by what they mean. */
const DETAIL_LABEL: Record<string, MessageKey> = {
  no_cli: 'runs.detail.noCli',
  no_curl: 'runs.detail.noCurl',
  not_running: 'runs.detail.notRunning',
  auth: 'runs.detail.auth',
  project_add: 'runs.detail.projectAdd',
  no_project: 'runs.detail.projectAdd',
  not_git: 'runs.detail.notGit',
  repo_add: 'runs.detail.repoAdd',
  unreachable: 'runs.detail.unreachable',
  orca_runtime_unavailable: 'runs.detail.notRunning',
};

/**
 * What a run's reason says, with the harness's failure code made plain where Arbor knows it. `harness` is the one it
 * went to (or was asked for), for the caller to name in `{harness}`.
 */
export function reasonMessage(run: Pick<HarnessRun, 'reason' | 'detail' | 'used' | 'harness'>): { key: MessageKey; values: Record<string, string>; harness: RunHarness } | null {
  if (!run.reason) return null;
  const harness = run.used ?? run.harness;
  // The members the run looked on, when every one that could take it lacked the folder.
  if (run.reason === 'noFolder' && run.detail) return { key: 'runs.reason.noFolderOn', values: { machines: run.detail }, harness };
  if (run.reason === 'agentFailed' && run.detail) return exitMessage(run.detail, harness);
  if (run.reason === 'handOffFailed' && run.detail) {
    const known = DETAIL_LABEL[run.detail];
    if (known) return { key: known, values: {}, harness };
    const status = /^(snapshot|create|turn)_(\d{3})$/.exec(run.detail);
    if (status) return { key: 'runs.detail.status', values: { status: status[2] ?? '' }, harness };
    return { key: 'runs.detail.other', values: { code: run.detail }, harness };
  }
  return { key: REASON_LABEL[run.reason], values: {}, harness };
}

/** What an agent's exit code (or `gone`, when it left none) says about how it stopped. */
function exitMessage(detail: string, harness: RunHarness): { key: MessageKey; values: Record<string, string>; harness: RunHarness } {
  if (detail === 'gone') return { key: 'runs.exit.gone', values: {}, harness };
  // 127 is the shell's "command not found"; 130, 137 and 143 are an interrupt, a kill and a terminate.
  if (detail === '127') return { key: 'runs.exit.notFound', values: {}, harness };
  if (detail === '130' || detail === '137' || detail === '143') return { key: 'runs.exit.killed', values: { code: detail }, harness };
  return { key: 'runs.exit.code', values: { code: detail }, harness };
}

/** Whether Arbor can bring the run up where it runs: only Orca can be told to show one terminal. */
export const canOpenRun = (run: HarnessRun) => Boolean(run.handle.terminal && run.machine && run.used === 'orca');

const loose = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Commands to type to look into a run on the command line, run from this Mac: its log (what the agent printed, which
 * stays on the machine and Arbor never reads), and picking up a Claude Code run's session where it left off. Null for
 * each when there's nothing to look at, or the machine isn't on the Machines list to say how to reach it.
 */
export function runCommands(
  run: Pick<HarnessRun, 'machine' | 'folder' | 'setup' | 'used' | 'handle'>,
  health: readonly MachineHealth[] | null,
): { log: string | null; resume: string | null } {
  const machine = run.machine ? (health ?? []).find((item) => loose(item.machine) === loose(run.machine ?? '')) : undefined;
  if (run.used !== 'headless' || !machine) return { log: null, resume: null };
  // On another machine the command goes to its shell in one word, so `~` is its home, not this Mac's.
  const on = (command: string, terminal = false) => (machine.local ? command : `${sshCommand(machine, terminal ? ['-t'] : [])} ${shellWord(command)}`);
  const log = run.handle.log ? on(`cat ${shellPath(run.handle.log)}`) : null;
  const resume = run.setup === 'claude' && run.handle.sessionId
    ? on(`cd ${run.folder === '~' ? '~' : shellPath(run.folder)} && claude --resume ${shellWord(run.handle.sessionId)}`, true)
    : null;
  return { log, resume };
}

/** The runs started on a pool or spilled into it, newest first. */
export const poolRuns = (runs: readonly HarnessRun[], poolId: string, limit = 6) =>
  runs.filter((run) => run.pool === poolId || run.ranPool === poolId).slice(0, limit);

export type RunSetupChoice = HarnessSetupRow & {
  /** Members whose harness is running with this setup on. */
  ready: number;
  /** Members that have the setup at all. */
  found: number;
};

/** The setups a run on this pool could name for a harness, from what each member's last agents check found. */
export function runSetupChoices(pool: Pick<MachinePool, 'members'>, health: readonly MachineHealth[] | null, harness: RunHarness): RunSetupChoice[] {
  const members = new Set(pool.members.filter((member) => member.weight !== 'manual').map((member) => loose(member.machine)));
  const choices = new Map<string, RunSetupChoice>();
  for (const machine of health ?? []) {
    if (!members.has(loose(machine.machine))) continue;
    const found = machineHarnesses(machine.agents).find((entry) => entry.kind === harness);
    for (const setup of found?.setups ?? []) {
      const choice = choices.get(setup.id) ?? { ...setup, ready: 0, found: 0 };
      choice.found += 1;
      if (setup.enabled && found?.running !== false) choice.ready += 1;
      choices.set(setup.id, choice);
    }
  }
  return [...choices.values()].sort((a, b) => b.ready - a.ready || a.id.localeCompare(b.id));
}

/** A setup's name as the harness shows it. */
export const setupLabel = (setup: Pick<HarnessSetupRow, 'name' | 'driver' | 'rawDriver'>, t: (key: MessageKey) => string) =>
  setup.name ?? (setup.driver ? t(setup.driver) : setup.rawDriver);

export const newRunRequest = (pool: string): RunRequest => ({ pool, harness: 't3', setup: '', folder: '', prompt: '', fallback: false });

/** Why a run can't be started yet, as the native side would refuse it. Null when it can. */
export function runDraftProblem(draft: RunRequest): MessageKey | null {
  if (!draft.setup.trim()) return 'runs.problem.setup';
  const folder = draft.folder.trim();
  if (!/^(~$|~\/|\/)/.test(folder) || folder.split('/').includes('..')) return 'runs.problem.folder';
  if (!draft.prompt.trim()) return 'runs.problem.prompt';
  return null;
}

// ---------------------------------------------------------------------------
// The runs, for every page that shows them
// ---------------------------------------------------------------------------

type Snapshot = { runs: HarnessRun[] | null; error: string | null };
let snapshot: Snapshot = { runs: null, error: null };
const listeners = new Set<() => void>();
let started = false;

const publish = (next: Snapshot) => {
  snapshot = next;
  for (const listener of listeners) listener();
};

export async function reloadRuns() {
  try {
    publish({ runs: await invokeCommand('get_runs'), error: null });
  } catch (error) {
    publish({ ...snapshot, error: String(error) });
  }
}

export async function startRun(request: RunRequest) {
  const run = await invokeCommand('start_pool_run', { request });
  await reloadRuns();
  return run;
}

export async function cancelRun(id: string) {
  publish({ runs: await invokeCommand('cancel_run', { id }), error: null });
}

export const openRun = (id: string) => invokeCommand('open_run', { id });

function start() {
  if (started) return;
  started = true;
  void reloadRuns();
  void listen(HARNESS_RUNS_UPDATED_EVENT, () => void reloadRuns()).catch(() => undefined);
}

const subscribe = (listener: () => void) => {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Every run, newest first, kept current while anything shows them. */
export const useRuns = () => useSyncExternalStore(subscribe, () => snapshot);

/**
 * The browser mock's answers for Compute: the cloud sandboxes of the providers the user connected. `?compute=` picks
 * a scenario (computeScenarios.ts), and `?computeconnect=refused|unreachable` has Connect fail that way; both are
 * listed at the top of mockTauri.ts. With no flag nothing is connected, unless a Connect in an earlier load left the
 * saved hint behind, which the real app's saved key would match.
 */
import { emit } from '@tauri-apps/api/event';
import type { ComputeCommands } from '../../native/compute';
import type { CommandError, ComputeSnapshot } from '../../native/types';
import { COMPUTE_HINT_KEY, COMPUTE_UPDATED_EVENT, parseComputeHint } from '../../services/computeHint';
import type { CommandAnswers } from './answers';
import { computeScenarioSnapshot, isComputeScenario, mockHistory, type ComputeScenario } from './computeScenarios';
import { mockLog, params } from './scenario';

const flag = params.get('compute');
/** The scenario the flag names, or null with none (or one the mock doesn't know). */
export const computeFlag: ComputeScenario | null = isComputeScenario(flag) ? flag : null;
const connectFlag = params.get('computeconnect');

let scenario: ComputeScenario | null = null;
/** Changes made in this load on top of the scenario: sandboxes unlinked. */
const unlinked = new Set<string>();

/** Read on first use, after installTauriMock has seeded the hint, so a hint left by an earlier Connect counts. */
function current(): ComputeScenario {
  if (scenario) return scenario;
  if (computeFlag) scenario = computeFlag;
  else {
    let hinted: string[] = [];
    try {
      hinted = parseComputeHint(window.localStorage.getItem(COMPUTE_HINT_KEY));
    } catch {
      hinted = [];
    }
    scenario = hinted.length ? 'typical' : 'none';
  }
  return scenario;
}

function snapshot(): ComputeSnapshot {
  const now = Date.now();
  const read = computeScenarioSnapshot(current(), now);
  return {
    providers: read.providers.map((provider) => ({
      ...provider,
      sandboxes: provider.sandboxes.map((sandbox) => (unlinked.has(sandbox.id) ? { ...sandbox, machine: null, session: null, linkedBy: null, linkProblem: 'notLinked', forgotten: null } : sandbox)),
    })),
  };
}

/** Sends the snapshot as Rust does after every round, and after connect, disconnect, link and unlink. */
const announce = () => void emit(COMPUTE_UPDATED_EVENT, snapshot());

let rounds: number | null = null;
/** A round a minute while something is connected, as Rust's, so "read 12s ago" moves on. None while nothing is. */
function followRounds() {
  const connected = current() !== 'none';
  if (connected && rounds === null) rounds = window.setInterval(announce, 60_000);
  if (!connected && rounds !== null) {
    window.clearInterval(rounds);
    rounds = null;
  }
}

export const computeAnswers: CommandAnswers<ComputeCommands> = {
  get_compute: () => {
    followRounds();
    return snapshot();
  },
  refresh_compute: () => {
    mockLog('refresh_compute', {});
    const next = snapshot();
    void emit(COMPUTE_UPDATED_EVENT, next);
    return next;
  },
  get_compute_sandbox_history: ({ provider, sandboxId }) => {
    const sandbox = snapshot().providers.find((entry) => entry.id === provider)?.sandboxes.find((entry) => entry.id === sandboxId);
    return sandbox ? mockHistory(sandbox, Date.now()) : [];
  },
  connect_compute_provider: ({ provider, key }) => {
    // The key itself is never logged, here as in the app.
    mockLog('connect_compute_provider', { provider });
    if (connectFlag === 'refused' || !key.trim()) {
      const failure: CommandError = { kind: 'refused', message: 'The provider turned this key down.' };
      throw failure;
    }
    if (connectFlag === 'unreachable') {
      const failure: CommandError = { kind: 'unreachable', message: 'The provider didn’t answer.' };
      throw failure;
    }
    scenario = 'typical';
    unlinked.clear();
    followRounds();
    announce();
    return snapshot();
  },
  disconnect_compute_provider: ({ provider }) => {
    mockLog('disconnect_compute_provider', { provider });
    scenario = 'none';
    followRounds();
    announce();
    return snapshot();
  },
  open_compute_sandbox: ({ provider, sandboxId }) => {
    mockLog('open_compute_sandbox', { provider, sandboxId });
  },
  link_compute_sandbox: ({ provider, sandboxId, machine, session }) => {
    mockLog('link_compute_sandbox', { provider, sandboxId, machine, session });
    unlinked.delete(sandboxId);
    announce();
  },
  unlink_compute_sandbox: ({ provider, sandboxId }) => {
    mockLog('unlink_compute_sandbox', { provider, sandboxId });
    unlinked.add(sandboxId);
    announce();
  },
};

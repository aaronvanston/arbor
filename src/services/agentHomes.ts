import { useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invokeCommand } from '../native/commands';
import type { MessageKey } from '../i18n/resources';
import type { AgentHome, AgentHomeKind, AgentHomeRole, AgentHomesView, FoundHome, HomeGuessReason } from '../native/types';

/**
 * Where each machine's agents keep their homes (see `agent_homes.rs`): the one list every script that reads an agent
 * home goes by. The agents' own homes are always on it; the first look at a machine adds the others it finds there, and
 * the user adds, removes and picks the role of the rest. A home the user hasn't picked a role for follows what each
 * look at its machine guesses.
 */

export const AGENT_HOMES_UPDATED_EVENT = 'agent-homes-updated';

export const AGENT_HOME_KINDS: readonly AgentHomeKind[] = ['claude', 'codex', 'pi', 'claude-desktop', 'pi-agent', 'prime-agent', 'opencode', 'droid', 'amp'];

export const AGENT_HOME_LABEL: Record<AgentHomeKind, MessageKey> = {
  claude: 'agentHomes.agent.claude',
  codex: 'agentHomes.agent.codex',
  pi: 'agentHomes.agent.pi',
  'claude-desktop': 'agentHomes.agent.claudeDesktop',
  'pi-agent': 'agentHomes.agent.piAgent',
  'prime-agent': 'agentHomes.agent.primeAgent',
  opencode: 'agentHomes.agent.openCode',
  droid: 'agentHomes.agent.droid',
  amp: 'agentHomes.agent.amp',
};

/** Sync reads it: Claude Code's and Codex's settings, and the other agents' instructions and skills. */
export const syncs = (agent: AgentHomeKind) => agent !== 'pi' && agent !== 'claude-desktop';

/** Arbor reads the sessions in it; the other agents' own folders hold none it can read yet. */
export const readsSessions = (agent: AgentHomeKind) => agent === 'claude' || agent === 'codex' || agent === 'pi' || agent === 'claude-desktop';

/** A standard home read from where an agent's environment variable points, rather than a folder. */
export const isVariable = (home: Pick<AgentHome, 'path'>) => home.path.startsWith('$');

/** The homes saved for one machine alone: found there, added for it, or a standard one switched there. */
export const ownHomes = (view: AgentHomesView, machine: string) =>
  view.machines.find((entry) => entry.machine === machine)?.homes.filter((home) => home.machine === machine) ?? [];

/** Whether a home the list has on every machine is switched differently on this one. */
export const switchedHere = (view: AgentHomesView, home: AgentHome) =>
  view.everywhere.some((every) => every.agent === home.agent && every.path === home.path);

export const ROLE_LABEL: Record<AgentHomeRole, MessageKey> = {
  active: 'agentHomes.role.active',
  history: 'agentHomes.role.history',
  ignored: 'agentHomes.role.ignored',
};

export const GUESS_REASON_LABEL: Record<HomeGuessReason, MessageKey> = {
  recent: 'agentHomes.guess.recent',
  idle: 'agentHomes.guess.idle',
  sessionCopy: 'agentHomes.guess.sessionCopy',
};

/** A home's role, from the two switches it's kept as. */
export const roleOf = (home: Pick<AgentHome, 'sessions' | 'sync'>): AgentHomeRole => (home.sync ? 'active' : home.sessions ? 'history' : 'ignored');

/** The roles a home of `agent` can have: active only where Arbor can keep its settings, history only where it reads its sessions. */
export const rolesFor = (agent: AgentHomeKind): AgentHomeRole[] => [
  ...(syncs(agent) ? ['active' as const] : []),
  ...(readsSessions(agent) ? ['history' as const] : []),
  'ignored',
];

/** `home` with `role`, picked by the user or (`chosen` false) left to follow Arbor's guess. */
export const withRole = (home: AgentHome, role: AgentHomeRole, chosen: boolean): AgentHome => ({
  ...home,
  sessions: role !== 'ignored' && readsSessions(home.agent),
  sync: role === 'active' && syncs(home.agent),
  chosen,
  guess: null,
});

/** Whether a home can follow Arbor's guess: one found or added on a machine, not an agent's own home. */
export const canFollowGuess = (home: Pick<AgentHome, 'machine' | 'source'>) => home.machine !== '' && home.source !== 'standard';

/**
 * Why a folder typed for a home can't be one, as the native side checks it: it starts from the home folder or the
 * root, and has no empty, `.` or `..` folder in it. Null when it can.
 */
export function homePathProblem(path: string): MessageKey | null {
  const trimmed = path.trim().replace(/\/+$/, '');
  if (!trimmed) return 'agentHomes.add.pathEmpty';
  if (!(trimmed.startsWith('~/') || trimmed.startsWith('/')) || trimmed.includes('$')) return 'agentHomes.add.pathStart';
  const parts = trimmed.split('/').slice(1);
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) return 'agentHomes.add.pathParts';
  // The scripts read homes a line at a time, split at tabs.
  if ([...trimmed].some((char) => char < ' ')) return 'agentHomes.add.pathParts';
  return null;
}

const foundHome = (machine: string, found: FoundHome): AgentHome => ({
  machine, agent: found.agent, path: found.path, source: 'added', sessions: false, sync: false, chosen: false, guess: null,
});

/** A home to add from a look's suggestion, following Arbor's guess: history only when the look couldn't tell. */
export const homeFromFound = (machine: string, found: FoundHome): AgentHome =>
  withRole(foundHome(machine, found), found.guess?.role ?? 'history', false);

/** A look's suggestion kept on the list as ignored, so later looks don't offer it again. */
export const ignoredFromFound = (machine: string, found: FoundHome): AgentHome => withRole(foundHome(machine, found), 'ignored', true);

// ---------------------------------------------------------------------------
// The list, for every page that shows it
// ---------------------------------------------------------------------------

type Snapshot = { view: AgentHomesView | null; error: string | null };
let snapshot: Snapshot = { view: null, error: null };
const listeners = new Set<() => void>();
let started = false;

const publish = (next: Snapshot) => {
  snapshot = next;
  for (const listener of listeners) listener();
};

/** Reads the list again. */
export async function reloadAgentHomes() {
  try {
    publish({ view: await invokeCommand('get_agent_homes'), error: null });
  } catch (error) {
    publish({ view: snapshot.view, error: String(error) });
  }
}

/** Takes the list a command returned after changing it. */
const take = (view: AgentHomesView) => {
  publish({ view, error: null });
  return view;
};

export const saveAgentHome = async (home: AgentHome) => take(await invokeCommand('save_agent_home', { home }));
export const removeAgentHome = async (home: Pick<AgentHome, 'machine' | 'agent' | 'path'>) =>
  take(await invokeCommand('remove_agent_home', { machine: home.machine, agent: home.agent, path: home.path }));
/** Looks for homes again on one machine, or on all of them. */
export const scanAgentHomes = async (machine: string | null) => take(await invokeCommand('scan_agent_homes', { machine }));
/** The folders a home would take in on a machine, before it's saved. */
export const previewAgentHome = (machine: string, agent: AgentHomeKind, path: string) =>
  invokeCommand('preview_agent_home', { machine, agent, path: path.trim() });

function start() {
  if (started) return;
  started = true;
  void reloadAgentHomes();
  void listen(AGENT_HOMES_UPDATED_EVENT, () => void reloadAgentHomes()).catch(() => undefined);
}

const subscribe = (listener: () => void) => {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The list, kept current while anything shows it. */
export const useAgentHomes = () => useSyncExternalStore(subscribe, () => snapshot);

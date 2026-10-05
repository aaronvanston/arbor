import { invokeCommand } from '../native/commands';
import { compareVersions } from './agentVersions';
import { setupChecks, type SetupCheck } from './setupChecks';
import { buildMatrix, homeKey, turnedOff, type SetupItemKind } from './setupInventory';
import { mcpKey, mcpOptions, plannedMcp, type PendingMcp, type PlannedMcp } from './setupMcp';
import {
  changeKey as pluginKey,
  marketplaceOptions,
  plannedPlugins,
  pluginOptions,
  type ExtensionsView,
  type PendingPlugins,
  type PlannedPlugin,
} from './setupPlugins';
import { projectKey, projectName, tilde } from './setupProjects';
import {
  addChanges,
  cellOptions,
  changeKey as skillKey,
  isTurnedOff,
  plannedSkills,
  skillSuggestions,
  skillsView,
  type PendingSkills,
  type PlannedSkill,
  type SkillPlace,
} from './setupSkills';
import { inStep, scanned, syncCounts, syncPlan, type SyncCounts } from './setupSync';
import { actionable, buildToolRows, checkPlace, TOOL_ORDER, type ToolId } from './setupToolchain';
import type {
  LatestVersions,
  MachineHealth,
  MachineProjects,
  MachineToolchain,
  McpRegistry,
  SetupInstall,
  SetupMachine,
  SetupRepo,
} from '../native/types';

/**
 * Where a step stands for the machine being set up.
 * - `done`: it's like the reference machine, or the repo, already.
 * - `todo`: something to do, which the step says.
 * - `waiting`: Arbor is still reading the machine, or hasn't yet.
 * - `unknown`: Arbor can't tell, like when something failed to load.
 * - `skip`: there's nothing to match, like a repo without MCP servers.
 */
export type StepState = 'done' | 'todo' | 'waiting' | 'unknown' | 'skip';

export type StepId = 'connect' | 'agents' | 'proxy' | 'repo' | 'skills' | 'mcp' | 'plugins' | 'settings' | 'alerts' | 'tools' | 'projects' | 'checks';

/** The order a machine is set up in: each step leans on the ones before it. */
export const STEP_ORDER: readonly StepId[] = ['connect', 'agents', 'proxy', 'repo', 'skills', 'mcp', 'plugins', 'settings', 'alerts', 'tools', 'projects', 'checks'];

/** How far back the proxy step looks for a machine's requests. */
export const PROXY_WINDOW_MS = 7 * 86_400_000;

/** What the proxy step reads from the usage records: the API keys given to each machine, and each machine's requests. */
export type KeyAssignment = { api_key_hash: string; label: string; machine: string };
export type MachineRequests = { machine: string; requests: number; lastRequest: string | null };

export const getKeyAssignments = () => invokeCommand('get_usage_machine_assignments');

/** Each machine's requests over the proxy step's window. */
export async function getMachineRequests(now: number): Promise<MachineRequests[]> {
  const query = { start: new Date(now - PROXY_WINDOW_MS).toISOString(), end: new Date(now).toISOString() };
  const overview = await invokeCommand('get_usage_overview', { query });
  return overview.machines;
}

const AGENTS = ['claude', 'codex'] as const;
type Agent = (typeof AGENTS)[number];
/** Where each agent keeps its setup until it's told otherwise. */
const AGENT_HOME: Record<Agent, string> = { claude: '~/.claude', codex: '~/.codex' };

/** The install of an agent that runs: the first on the machine's PATH. */
const running = (machine: SetupMachine, agent: Agent): SetupInstall | null => machine.installs.find((install) => install.agent === agent) ?? null;

/** The machine to compare with: the one chosen, while it's there and isn't the one being set up, else this Mac, else the first other. */
export function checklistReference(machines: SetupMachine[], target: string | null, chosen: string | null): string | null {
  const others = machines.filter((machine) => machine.machine !== target);
  if (chosen && others.some((machine) => machine.machine === chosen)) return chosen;
  return (others.find((machine) => machine.local) ?? others[0])?.machine ?? null;
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export type ConnectStep = {
  state: StepState;
  why: 'ok' | 'noHost' | 'connecting' | 'down' | 'reading' | 'notRead' | 'scanFailed';
  error: string | null;
};

/** Whether Arbor reaches the machine and has read what its agents load. */
export function connectStep(machine: SetupMachine, health: MachineHealth | null): ConnectStep {
  if (!machine.reachable) {
    // Nothing is waited on for a machine with no host: it needs one first.
    if (health?.status === 'unconfigured') return { state: 'todo', why: 'noHost', error: null };
    const error = health?.error ?? null;
    return error ? { state: 'todo', why: 'down', error } : { state: 'waiting', why: 'connecting', error: null };
  }
  if (machine.scannedAt === null) return { state: 'waiting', why: machine.scanning ? 'reading' : 'notRead', error: null };
  if (machine.error) return { state: 'todo', why: 'scanFailed', error: machine.error };
  return { state: 'done', why: 'ok', error: null };
}

/**
 * Whether a step is only waiting because the machine has no SSH host: nothing can read it until one is added, so the
 * step says that rather than that a read is under way, and offers nothing that would need the machine.
 */
export function waitsForHost(connect: ConnectStep, step: { state: StepState }): boolean {
  return connect.why === 'noHost' && step.state === 'waiting';
}

/** A first read that failed leaves nothing to compare, which isn't the same as a machine with little on it. */
const readFailed = (machine: SetupMachine) => machine.scannedAt !== null && machine.error !== null && !machine.homes.length && !machine.installs.length;
/** Whether what a machine's agents load is known: read, and not by a first read that failed. */
const known = (machine: SetupMachine) => scanned(machine) && !readFailed(machine);
/** A step that needs machines not yet known waits for their read, or can't tell once one has failed. */
const unread = (...machines: SetupMachine[]): StepState => (machines.some(readFailed) ? 'unknown' : 'waiting');

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * - `missing`: another machine has it and this one doesn't.
 * - `noHome`: it's installed but hasn't made its home yet, which happens the first time it starts.
 * - `behind`: it's older than the agent's latest release, or, while that's unknown, than another machine's.
 */
export type AgentState = 'ok' | 'missing' | 'noHome' | 'behind' | 'unknown' | 'notNeeded';
export type AgentFact = {
  agent: Agent;
  state: AgentState;
  install: SetupInstall | null;
  /** The version to be at: the latest release (no machine) when npm said, else the newest in the fleet. */
  newest: { version: string; machine: string | null } | null;
  /** How to install it, the way `like` did. */
  command: string;
};
export type AgentsStep = { state: StepState; agents: AgentFact[] };

/**
 * The command that installs an agent, the way another machine has it: from Homebrew when that one came from a cask and
 * this one is a Mac, Codex from npm when that one came from npm, else the agent's own installer. Casks are macOS only,
 * so a machine whose system isn't known yet gets the installer. Claude Code's npm package is deprecated, so it always
 * gets the installer rather than npm.
 */
export function installCommand(agent: Agent, like: SetupInstall | null, os: string | null): string {
  const where = like?.real ?? like?.path ?? '';
  if (where.includes('/Caskroom/') && os === 'Darwin') return agent === 'claude' ? 'brew install --cask claude-code' : 'brew install --cask codex';
  if (agent === 'codex' && where.includes('/node_modules/')) return 'npm install -g @openai/codex';
  return agent === 'claude' ? 'curl -fsSL https://claude.ai/install.sh | bash' : 'curl -fsSL https://chatgpt.com/codex/install.sh | sh';
}

/**
 * Claude Code and Codex on the machine against their latest releases, when `latest` knows them, and the rest of the
 * fleet. `os` is the machine's `uname -s`, when known.
 */
export function agentsStep(
  machine: SetupMachine,
  machines: SetupMachine[],
  reference: SetupMachine | null,
  os: string | null,
  latest: LatestVersions | null = null,
): AgentsStep {
  if (!known(machine)) return { state: unread(machine), agents: [] };
  const others = machines.filter((entry) => entry.machine !== machine.machine && known(entry));
  const agents = AGENTS.map((agent): AgentFact => {
    const install = running(machine, agent);
    let newest: AgentFact['newest'] = null;
    for (const entry of [machine, ...others]) {
      const version = running(entry, agent)?.version;
      if (version && (!newest || compareVersions(version, newest.version) > 0)) newest = { version, machine: entry.machine };
    }
    const release = latest?.[agent];
    if (release) newest = { version: release, machine: null };
    const like = (reference && known(reference) ? running(reference, agent) : null) ?? others.map((entry) => running(entry, agent)).find(Boolean) ?? null;
    let state: AgentState;
    // With nothing to compare with, both are worth having.
    if (!install) state = !others.length || others.some((entry) => running(entry, agent)) ? 'missing' : 'notNeeded';
    else if (!machine.homes.some((home) => home.agent === agent && home.path === AGENT_HOME[agent])) state = 'noHome';
    else if (!install.version) state = 'unknown';
    else if (newest && compareVersions(install.version, newest.version) < 0) state = 'behind';
    else state = 'ok';
    return { agent, state, install, newest, command: installCommand(agent, like, os) };
  });
  const state: StepState = agents.some((fact) => fact.state === 'missing' || fact.state === 'noHome' || fact.state === 'behind')
    ? 'todo'
    : agents.some((fact) => fact.state === 'unknown') ? 'unknown' : 'done';
  return { state, agents };
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

/** What the reference machine's agents set to reach the proxy and this machine's don't: env names, and Codex's providers. */
export type ProxySetting = { home: string; names: string[] };
export type ProxyStep = {
  state: StepState;
  why: 'seen' | 'noKey' | 'quiet' | 'loading' | 'failed';
  keys: KeyAssignment[];
  requests: number;
  lastRequestMs: number | null;
  settings: ProxySetting[];
  error: string | null;
};

/** Env names that point an agent at a proxy or carry its key, as opposed to the rest of what a home sets. */
const PROXY_ENV = /(?:^|_)(?:BASE_URL|API_BASE|API_KEY|AUTH_TOKEN)$|^(?:HTTPS?|ALL)_PROXY$/i;
const isProxySetting = (kind: SetupItemKind, name: string, agent: string) =>
  (kind === 'env' && PROXY_ENV.test(name)) || (agent === 'codex' && kind === 'setting' && (name === 'model_provider' || name.startsWith('model_providers.')));

/** The reference machine's proxy settings, by home, that this machine's same homes haven't got. */
export function missingProxySettings(machine: SetupMachine, reference: SetupMachine | null): ProxySetting[] {
  if (!reference) return [];
  return reference.homes.flatMap((home) => {
    if (home.agent !== 'claude' && home.agent !== 'codex') return [];
    const mine = machine.homes.find((entry) => homeKey(entry) === homeKey(home));
    const have = new Set((mine?.items ?? []).map((item) => `${item.kind}:${item.name}`));
    const names = home.items
      .filter((item) => isProxySetting(item.kind, item.name, home.agent) && !have.has(`${item.kind}:${item.name}`))
      .map((item) => item.name);
    return names.length ? [{ home: homeKey(home), names }] : [];
  });
}

/** Whether the machine's agents reach Arbor: an API key given to it, and its requests over the last week. */
export function proxyStep(
  machine: SetupMachine,
  reference: SetupMachine | null,
  assignments: KeyAssignment[] | null,
  requests: MachineRequests[] | null,
  error: string | null,
  now: number,
): ProxyStep {
  const base = { keys: [], requests: 0, lastRequestMs: null, settings: [], error: null };
  if (error) return { ...base, state: 'unknown', why: 'failed', error };
  if (!assignments || !requests) return { ...base, state: 'waiting', why: 'loading' };
  const keys = assignments.filter((entry) => entry.machine === machine.machine);
  const use = requests.find((entry) => entry.machine === machine.machine);
  const last = use?.lastRequest ? Date.parse(use.lastRequest) : Number.NaN;
  const lastRequestMs = Number.isFinite(last) ? last : null;
  const facts = { keys, requests: use?.requests ?? 0, lastRequestMs, error: null };
  if (lastRequestMs !== null && now - lastRequestMs <= PROXY_WINDOW_MS && facts.requests > 0) {
    return { ...facts, state: 'done', why: 'seen', settings: [] };
  }
  const settings = missingProxySettings(machine, reference);
  return { ...facts, state: 'todo', why: keys.length ? 'quiet' : 'noKey', settings };
}

// ---------------------------------------------------------------------------
// Setup repo
// ---------------------------------------------------------------------------

export type RepoStep = {
  state: StepState;
  why: 'noRepo' | 'loading' | 'failed' | 'noCommits' | 'notRead' | 'inStep' | 'behind';
  counts: SyncCounts | null;
  error: string | null;
};

/** The machine's instructions, rules, subagents, commands and repo skills against the setup repo's. */
export function repoStep(path: string | null, repo: SetupRepo | null, error: string | null, machine: SetupMachine): RepoStep {
  if (!path) return { state: 'todo', why: 'noRepo', counts: null, error: null };
  if (error) return { state: 'unknown', why: 'failed', counts: null, error };
  if (!repo) return { state: 'waiting', why: 'loading', counts: null, error: null };
  if (!repo.head) return { state: 'unknown', why: 'noCommits', counts: null, error: null };
  if (!known(machine)) return { state: unread(machine), why: 'notRead', counts: null, error: null };
  const counts = syncCounts(syncPlan(repo, machine));
  return inStep(counts) ? { state: 'done', why: 'inStep', counts, error: null } : { state: 'todo', why: 'behind', counts, error: null };
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** Where a skill loads in a Claude Code home. */
const ON: ReadonlySet<SkillPlace> = new Set(['linked', 'copy', 'drifted', 'own', 'elsewhere', 'viaFolder']);

export type SkillsStep = {
  state: StepState;
  /** Links from the store to turn skills on as the reference has them, then the machine's own tidy-ups. */
  plan: PlannedSkill[];
  pending: PendingSkills;
  /** How many of `plan` turn on a skill the reference has on. */
  links: number;
  /** Skills the reference has on that this machine hasn't got at all, so there's nothing to link. */
  notHere: string[];
};

/** The skills the reference machine's Claude Code homes load, turned on in this machine's from its store. */
export function skillsStep(machine: SetupMachine, reference: SetupMachine | null): SkillsStep {
  const empty = { plan: [], pending: {}, links: 0, notHere: [] };
  if (!known(machine)) return { ...empty, state: unread(machine) };
  // Without the reference's skills, "every skill it has on is on" can't be said yet.
  if (reference && !known(reference)) return { ...empty, state: unread(reference) };
  const view = skillsView(machine);
  const links: PlannedSkill[] = [];
  const notHere = new Set<string>();
  if (reference) {
    const theirs = skillsView(reference);
    const settingsOf = (home: { path: string }) => machine.homes.find((entry) => entry.agent === 'claude' && entry.path === home.path);
    for (const home of theirs.homes.filter((entry) => entry.agent === 'claude')) {
      const mine = view.homes.find((entry) => entry.agent === 'claude' && entry.path === home.path);
      // A home this machine hasn't got is the agents step's to make.
      if (!mine) continue;
      for (const row of theirs.rows) {
        const cell = row.cells.find((entry) => entry.home === home);
        // What the reference's settings turn off it doesn't load, so it isn't one to match.
        if (!cell || !ON.has(cell.place) || isTurnedOff(cell)) continue;
        const here = view.rows.find((entry) => entry.name === row.name);
        const place = here?.cells.find((entry) => entry.home === mine);
        // Nor is one this machine's settings turn off: that's a choice made here, not something missing.
        if (turnedOff(settingsOf(mine), row.name)) continue;
        if (!here || !place) {
          notHere.add(row.name);
          continue;
        }
        if (place.place === 'off' && cellOptions(here, place).includes('link')) links.push({ row: here, cell: place, action: 'link' });
        else if (place.place === 'none') notHere.add(row.name);
      }
    }
  }
  const tidy = skillSuggestions(view).flatMap((suggestion) => suggestion.changes);
  const pending = addChanges(view, {}, [...links, ...tidy]);
  const plan = plannedSkills(view, pending);
  const wanted = new Set(links.map((change) => skillKey(change.cell.home.path, change.row.name)));
  return {
    state: plan.length || notHere.size ? 'todo' : 'done',
    plan,
    pending,
    links: plan.filter((change) => change.action === 'link' && wanted.has(skillKey(change.cell.home.path, change.row.name))).length,
    notHere: [...notHere].sort((a, b) => a.localeCompare(b)),
  };
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export type McpStep = {
  state: StepState;
  why: 'noRepo' | 'loading' | 'failed' | 'noFile' | 'broken' | 'notRead' | 'offline' | 'inStep' | 'behind';
  plan: PlannedMcp[];
  /** Servers the repo has for this machine that Arbor can't add, like one with a path outside the home. */
  blocked: number;
  error: string | null;
};

/** The repo's MCP servers each home on the machine should have, added or brought up to date. */
export function mcpStep(machine: SetupMachine, path: string | null, registry: McpRegistry | null, error: string | null, view: ExtensionsView): McpStep {
  const base = { plan: [], blocked: 0, error: null };
  if (!path) return { ...base, state: 'skip', why: 'noRepo' };
  if (error) return { ...base, state: 'unknown', why: 'failed', error };
  if (!registry) return { ...base, state: 'waiting', why: 'loading' };
  if (!registry.found) return { ...base, state: 'skip', why: 'noFile' };
  if (registry.problems.length) return { ...base, state: 'unknown', why: 'broken', error: registry.problems[0] ?? null };
  if (!known(machine)) return { ...base, state: unread(machine), why: 'notRead' };
  // Servers are only ever planned for a home Arbor can reach, so an offline machine would look done.
  if (!machine.reachable) return { ...base, state: 'unknown', why: 'offline' };
  const keys: PendingMcp = {};
  for (const row of view.servers) {
    for (const cell of row.cells) {
      if (cell.home.machine !== machine.machine) continue;
      const options = mcpOptions(cell, true);
      if (options.includes('add')) keys[mcpKey(cell.home, row.name)] = 'add';
      else if (options.includes('update')) keys[mcpKey(cell.home, row.name)] = 'update';
    }
  }
  const plan = plannedMcp(view, keys).get(machine.machine) ?? [];
  const blocked = registry.cells.filter((cell) => cell.machine === machine.machine && cell.blocked !== null && cell.state !== 'same').length;
  return { ...base, state: plan.length || blocked ? 'todo' : 'done', why: plan.length || blocked ? 'behind' : 'inStep', plan, blocked };
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export type PluginsStep = {
  state: StepState;
  /** Arbor can't reach the machine, so what it would install can't be told from what it can't. */
  offline: boolean;
  plan: PlannedPlugin[];
  /** Plugins the reference has that no marketplace Arbor knows can install here. */
  cantInstall: string[];
};

/** The reference machine's plugins and marketplaces in each of this machine's matching Claude Code homes. */
export function pluginsStep(machine: SetupMachine, reference: SetupMachine | null, view: ExtensionsView): PluginsStep {
  const none = { plan: [], cantInstall: [], offline: false };
  if (!reference) return { ...none, state: 'skip' };
  if (!known(machine) || !known(reference)) return { ...none, state: unread(machine, reference) };
  if (!machine.reachable) return { ...none, state: 'unknown', offline: true };
  const pending: PendingPlugins = {};
  const cantInstall = new Set<string>();
  const mineFor = <C extends { home: { machine: string; path: string } }>(cells: C[], path: string) =>
    cells.find((cell) => cell.home.machine === machine.machine && cell.home.path === path) ?? null;
  for (const row of view.marketplaces) {
    for (const cell of row.cells) {
      if (cell.home.machine !== reference.machine || !cell.item) continue;
      const mine = mineFor(row.cells, cell.home.path);
      if (mine && !mine.item && marketplaceOptions(row, mine, view, pending).includes('addMarketplace')) pending[pluginKey(mine.home, 'marketplace', row.name)] = 'addMarketplace';
    }
  }
  for (const row of view.plugins) {
    for (const cell of row.cells) {
      if (cell.home.machine !== reference.machine || (cell.place !== 'on' && cell.place !== 'off')) continue;
      const mine = mineFor(row.cells, cell.home.path);
      if (!mine) continue;
      const key = pluginKey(mine.home, 'plugin', row.id);
      // Where a policy turns it on or off, that's the policy's choice, not something for this machine to copy or make.
      const policy = cell.policy !== null || mine.policy !== null;
      if (mine.place === 'none' || mine.place === 'missing') {
        if (policy) continue;
        if (pluginOptions(row, mine).includes('install')) pending[key] = 'install';
        else cantInstall.add(row.id);
      } else if (cell.place === 'on' && mine.place === 'off' && !policy) {
        pending[key] = 'enable';
      } else if (mine.behind && mine.home.reachable) {
        pending[key] = 'update';
      }
    }
  }
  const plan = plannedPlugins(view, pending).get(machine.machine) ?? [];
  return { state: plan.length || cantInstall.size ? 'todo' : 'done', plan, cantInstall: [...cantInstall].sort((a, b) => a.localeCompare(b)), offline: false };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTING_KINDS: ReadonlySet<SetupItemKind> = new Set(['setting', 'env', 'hook', 'profile']);

export type SettingDiff = { home: string; kind: SetupItemKind; name: string; state: 'different' | 'missing' };
export type SettingsStep = {
  state: StepState;
  /** Settings, env names, hooks and profiles the reference has and this machine hasn't. */
  missing: SettingDiff[];
  /** Ones both have, set differently, which can be on purpose. */
  different: SettingDiff[];
};

/** The settings, env names, hooks and Codex profiles the reference machine's homes have, against this machine's. */
export function settingsStep(machine: SetupMachine, reference: SetupMachine | null): SettingsStep {
  if (!reference) return { state: 'skip', missing: [], different: [] };
  if (!known(machine) || !known(reference)) return { state: unread(machine, reference), missing: [], different: [] };
  const pair = [reference, machine];
  const diffs: SettingDiff[] = [];
  for (const home of reference.homes) {
    const key = homeKey(home);
    if (!machine.homes.some((entry) => homeKey(entry) === key)) continue;
    for (const group of buildMatrix(pair, key, reference.machine)) {
      if (!SETTING_KINDS.has(group.kind)) continue;
      for (const row of group.rows) {
        const state = row.cells.find((cell) => cell.machine === machine.machine)?.state;
        if (state === 'different' || state === 'missing') diffs.push({ home: key, kind: group.kind, name: row.name, state });
      }
    }
  }
  const missing = diffs.filter((diff) => diff.state === 'missing');
  return { state: missing.length ? 'todo' : 'done', missing, different: diffs.filter((diff) => diff.state === 'different') };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export type AlertsStep = {
  state: StepState;
  why: 'notListed' | 'loading' | 'down' | 'on' | 'partly' | 'off';
  /** Whether the reference machine has the reporter, when that's known. */
  onReference: boolean | null;
};

/** Whether Arbor's reporter tells it when an agent on the machine is waiting on its user. */
export function alertsStep(listed: boolean, health: MachineHealth | null, referenceHealth: MachineHealth | null): AlertsStep {
  const onReference = referenceHealth?.agents.checkedAt ? referenceHealth.agents.reporter?.installed ?? false : null;
  if (!listed) return { state: 'todo', why: 'notListed', onReference };
  if (!health) return { state: 'waiting', why: 'loading', onReference };
  if (health.status === 'unreachable') return { state: 'unknown', why: 'down', onReference };
  if (!health.agents.checkedAt) return { state: 'waiting', why: 'loading', onReference };
  const reporter = health.agents.reporter;
  if (reporter?.installed) {
    return reporter.homes.every((home) => home.reporting) ? { state: 'done', why: 'on', onReference } : { state: 'todo', why: 'partly', onReference };
  }
  // Only a nudge when the reference has it: some fleets don't use it.
  return { state: onReference === false ? 'skip' : 'todo', why: 'off', onReference };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type ToolsStep = {
  state: StepState;
  why: 'loading' | 'notScanned' | 'scanning' | 'failed' | 'checked';
  /** Tools the reference machine has and this one hasn't. */
  missing: ToolId[];
  /** Tools a release or more behind the newest in the fleet. */
  behind: { tool: ToolId; version: string; newest: string }[];
  /** This machine's projects whose tools or packages need a look. */
  projects: number;
  /** Whether the reference machine's tools have been read, so `missing` means something. */
  referenceScanned: boolean;
  /** Why the reference machine's tools couldn't be read. */
  referenceError: string | null;
  error: string | null;
};

/** The machine's tools against the reference's, and what its own projects ask for. */
export function toolsStep(machine: SetupMachine, reference: SetupMachine | null, list: MachineToolchain[] | null): ToolsStep {
  const base = { missing: [], behind: [], projects: 0, referenceScanned: false, referenceError: null, error: null };
  if (!list) return { ...base, state: 'waiting', why: 'loading' };
  const mine = list.find((entry) => entry.machine === machine.machine);
  if (!mine || mine.scannedAt === null) {
    if (mine?.error) return { ...base, state: 'unknown', why: 'failed', error: mine.error };
    return { ...base, state: 'waiting', why: mine?.scanning ? 'scanning' : 'notScanned' };
  }
  const theirEntry = reference ? list.find((entry) => entry.machine === reference.machine) ?? null : null;
  const theirs = theirEntry?.scannedAt != null ? theirEntry : null;
  const has = (entry: MachineToolchain, tool: ToolId) => entry.tools.some((found) => found.tool === tool);
  const missing = theirs ? TOOL_ORDER.filter((tool) => has(theirs, tool) && !has(mine, tool)) : [];
  const behind = buildToolRows(list).flatMap((row) => {
    const cell = row.cells[machine.machine];
    return cell?.behind && cell.found?.version && row.newest ? [{ tool: row.tool, version: cell.found.version, newest: row.newest }] : [];
  });
  const projects = mine.projects.filter((project) => !project.missing && actionable(checkPlace(mine, project).state)).length;
  const referenceError = reference && !theirs ? theirEntry?.error ?? null : null;
  // With nothing to do here yet, the step isn't done until the reference's tools are known too.
  const settled: StepState = !reference || theirs ? 'done' : referenceError ? 'unknown' : 'waiting';
  return {
    state: missing.length || projects ? 'todo' : settled,
    why: 'checked',
    missing,
    behind,
    projects,
    referenceScanned: theirs !== null,
    referenceError,
    error: mine.error,
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** `command` is null for a remote on a host alias from ~/.ssh/config, which only that machine's config can clone. */
export type MissingProject = { key: string; name: string; remote: string; path: string; command: string | null; lastUsedMs: number | null };
export type ProjectsStep = {
  state: StepState;
  why: 'loading' | 'notScanned' | 'failed' | 'referenceNotScanned' | 'referenceFailed' | 'checked';
  error: string | null;
  /** The reference machine's projects with a remote that aren't checked out here, the last used first. */
  missing: MissingProject[];
};

const SAFE_WORD = /^[A-Za-z0-9._/@:+=,-]+$/;
export const shellWord = (word: string) => (SAFE_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);
/** A path for a shell, with a leading ~ left outside the quotes so the shell still expands it. */
export const shellPath = (path: string) => (path.startsWith('~/') ? `~/${shellWord(path.slice(2))}` : shellWord(path));

/**
 * Clones a project over HTTPS to the same place under the home folder as another machine has it. Remotes are kept
 * without their scheme or user, so how the other machine signs in isn't known; a host without a dot is an
 * ~/.ssh/config alias, which HTTPS can't reach, so it gets no command.
 */
export const cloneCommand = (remote: string, path: string): string | null =>
  remote.split('/')[0]?.includes('.') ? `git clone ${shellWord(`https://${remote}.git`)} ${shellPath(path)}` : null;

/** The reference machine's projects this machine hasn't checked out, matched by remote. */
export function projectsStep(machine: SetupMachine, reference: SetupMachine | null, list: MachineProjects[] | null): ProjectsStep {
  const none = { missing: [], error: null };
  if (!reference) return { ...none, state: 'skip', why: 'checked' };
  if (!list) return { ...none, state: 'waiting', why: 'loading' };
  // A scan that failed before finding anything leaves no scannedAt, only its error.
  const mine = list.find((entry) => entry.machine === machine.machine);
  if (!mine || mine.scannedAt === null) {
    return mine?.error ? { ...none, state: 'unknown', why: 'failed', error: mine.error } : { ...none, state: 'waiting', why: 'notScanned' };
  }
  const theirs = list.find((entry) => entry.machine === reference.machine);
  if (!theirs || theirs.scannedAt === null) {
    return theirs?.error ? { ...none, state: 'unknown', why: 'referenceFailed', error: theirs.error } : { ...none, state: 'waiting', why: 'referenceNotScanned' };
  }
  const here = new Set(mine.repos.filter((repo) => repo.state === 'ok').map((repo) => projectKey(mine.machine, repo)));
  const missing = new Map<string, MissingProject>();
  for (const repo of theirs.repos) {
    if (repo.state !== 'ok' || repo.bare || !repo.remote || repo.remote.startsWith('/')) continue;
    const key = projectKey(theirs.machine, repo);
    if (here.has(key) || missing.has(key)) continue;
    const path = tilde(repo.path, theirs.homeDir);
    // A home folder that's a repo can't be cloned into a home that's already there.
    if (path === '~') continue;
    missing.set(key, { key, name: projectName(repo, theirs.homeDir).name, remote: repo.remote, path, command: cloneCommand(repo.remote, path), lastUsedMs: repo.lastUsedMs });
  }
  const sorted = [...missing.values()].sort((a, b) => (b.lastUsedMs ?? 0) - (a.lastUsedMs ?? 0) || a.name.localeCompare(b.name));
  return { state: sorted.length ? 'todo' : 'done', why: 'checked', missing: sorted, error: null };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export type ChecksStep = { state: StepState; checks: SetupCheck[] };

/** Sync's checks' problems and warnings on this machine. Notes are left to Sync › Checks. */
export function checksStep(machine: SetupMachine): ChecksStep {
  if (!known(machine)) return { state: unread(machine), checks: [] };
  const checks = setupChecks([machine]).filter((check) => check.level !== 'note');
  return { state: checks.length ? 'todo' : 'done', checks };
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** How many steps are done, out of those that apply. */
export function checklistProgress(states: StepState[]): { done: number; total: number } {
  const counted = states.filter((state) => state !== 'skip');
  return { done: counted.filter((state) => state === 'done').length, total: counted.length };
}

/** The step to open first: the first with something to do. */
export const firstOpen = (steps: { id: StepId; state: StepState }[]) => steps.find((step) => step.state === 'todo')?.id ?? null;

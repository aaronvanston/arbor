import type { MessageKey, MessageVariables } from '../i18n/resources';
import { formatDuration, formatWhen } from '../lib/format';
import type { AgentKind, HealthMetric, MachineHealth } from '../native/types';
import type { AgentBehind } from './agentVersions';
import { T3_MIGRATIONS, fleetSkipNote, type FleetSkipNote } from './fleetBoard';
import { healthReasonText } from './homeOverview';
import { AGENT_KINDS, formatBytes, KIB } from './machineHealth';
import { unreachableReason } from './machineAlerts';
import { machineName } from './machineNames';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/**
 * A problem Arbor found on a machine, as an agent asked to fix it is told: what Arbor says, what to do about it, and
 * the readings behind it. `from` is where it has to be fixed from when that isn't the machine itself.
 */
export type FixProblem = {
  text: string;
  goal: string;
  details: string[];
  from: 'machine' | 'thisMac';
};

const AGENT_NAME: Record<AgentKind, MessageKey> = { claude: 'machines.agents.name.claude', codex: 'machines.agents.name.codex' };

const GOAL: Record<HealthMetric, MessageKey> = {
  disk: 'fix.goal.disk',
  memory: 'fix.goal.memory',
  swap: 'fix.goal.swap',
  cpu: 'fix.goal.cpu',
  load: 'fix.goal.load',
  cpuTemp: 'fix.goal.cpuTemp',
  gpuTemp: 'fix.goal.gpuTemp',
};

/**
 * A T3 Code database that wasn't read, when fixing the machine would help. One Arbor doesn't recognize, or that's
 * newer than it reads, needs Arbor itself updated, which no session on the machine can do.
 */
export function skipProblem(note: FleetSkipNote, t: Translate): FixProblem | null {
  const goal: MessageKey | null = note.reason === 'noSqlite3'
    ? 'fix.goal.noSqlite3'
    : note.reason === 'unreadable'
    ? 'fix.goal.t3Unreadable'
    : note.reason === 'migrationRange' && note.migration !== null && note.migration < T3_MIGRATIONS.min
    ? 'fix.goal.t3Older'
    : null;
  if (!goal) return null;
  const { key, variables } = fleetSkipNote(note);
  const details = note.migration === null ? [] : [t('fix.detail.t3Database', { migration: note.migration, min: T3_MIGRATIONS.min, max: T3_MIGRATIONS.max })];
  return { text: t(key, { ...variables, machine: machineName(note.machine) }), goal: t(goal), details, from: 'machine' };
}

/** What the machine's headline says is wrong: a reading pulling its score down, or that it can't be reached. Null when nothing is. */
export function healthProblem(item: MachineHealth, t: Translate): FixProblem | null {
  if (item.status === 'unreachable') {
    const reason = unreachableReason(item.error, t);
    return {
      text: [t('machines.health.status.unreachable'), reason].filter(Boolean).join(' · '),
      goal: t('fix.goal.unreachable', { ssh: `${sshCommand(item, ['-v'])} true` }),
      details: [
        ...(item.error ? [t('fix.detail.sshError', { error: item.error })] : []),
        ...(item.lastOkAt ? [t('fix.detail.lastOk', { time: formatWhen(item.lastOkAt) })] : []),
      ],
      from: 'thisMac',
    };
  }
  const latest = item.latest;
  if (!item.reason || !latest || item.status === 'pending' || item.status === 'unconfigured') return null;
  const { key, variables } = healthReasonText(item.reason, latest);
  const facts = item.facts;
  const total = (kb: number | null | undefined) => (kb ? formatBytes(kb * KIB, 0) : '?');
  const details = [
    t('fix.detail.memory', { value: Math.round(latest.mem), used: formatBytes(latest.memUsedKb * KIB), total: total(facts?.memTotalKb) }),
    ...(latest.swap !== null ? [t('fix.detail.swap', { value: Math.round(latest.swap), used: formatBytes((latest.swapUsedKb ?? 0) * KIB), total: total(facts?.swapTotalKb) })] : []),
    t('fix.detail.disk', { value: Math.round(latest.disk), free: formatBytes(latest.diskFreeKb * KIB, 0), total: total(facts?.diskTotalKb) }),
    t('fix.detail.load', { cpu: latest.cpu === null ? '?' : Math.round(latest.cpu), one: latest.load1.toFixed(1), five: latest.load5.toFixed(1), fifteen: latest.load15.toFixed(1) }),
    ...(latest.cpuTemp !== null ? [t('fix.detail.cpuTemp', { value: Math.round(latest.cpuTemp) })] : []),
    ...(latest.gpuTemp !== null ? [t('fix.detail.gpuTemp', { value: Math.round(latest.gpuTemp) })] : []),
  ];
  return { text: t(key, variables), goal: t(GOAL[item.reason.metric]), details, from: 'machine' };
}

/** An agent older than its latest release or the rest of the fleet. */
export function agentBehindProblem(entry: AgentBehind, item: MachineHealth, t: Translate): FixProblem {
  const agent = t(AGENT_NAME[entry.agent]);
  const command = item.agents[entry.agent]?.updateCommand;
  const text = entry.machine
    ? t('machines.agents.behindTitle', { agent, version: entry.version, newest: entry.newest, machine: machineName(entry.machine) })
    : t('machines.agents.behindLatestTitle', { agent, version: entry.version, newest: entry.newest });
  const goal = t('fix.goal.agentBehind', { agent, version: entry.version, newest: entry.newest });
  return { text, goal: command ? `${goal} ${t('fix.goal.agentBehindCommand', { command })}` : goal, details: [], from: 'machine' };
}

/** An agent's version T3 Code on the machine warns about; `text` is the warning as the page shows it. */
export function t3AdvisoryProblem(agent: AgentKind, text: string, t: Translate): FixProblem {
  return { text, goal: t('fix.goal.t3Advisory', { agent: t(AGENT_NAME[agent]) }), details: [], from: 'machine' };
}

/** A Sync check: its title and what it means, the home it's about, and the things it names. */
export function setupCheckProblem(check: { title: string; detail: string; home: string | null; subjects: string[]; error?: string | null }, t: Translate): FixProblem {
  return {
    text: `${check.title}. ${check.detail}`,
    goal: t(check.home ? 'fix.goal.setupCheckHome' : 'fix.goal.setupCheck', { home: check.home ?? '' }),
    details: [...check.subjects.map((subject) => t('fix.detail.subject', { value: subject })), ...(check.error ? [t('fix.detail.error', { error: check.error })] : [])],
    from: 'machine',
  };
}

/** How this Mac reaches the machine, as a command to type. */
export function sshCommand(item: Pick<MachineHealth, 'host'>, options: string[] = []): string {
  const port = item.host.port === 22 ? [] : ['-p', String(item.host.port)];
  return ['ssh', ...options, ...port, item.host.endpoint.trim()].join(' ');
}

/**
 * Where a session for the problem starts with `agent`: on the machine when it's this Mac, or when it's reachable and
 * the agent is installed there; otherwise on this Mac. `available` is false when the agent is known to be on neither.
 * `thisMac` is this Mac's own entry, when the Machines page lists it.
 */
export function fixPlacement(item: MachineHealth | null, problem: FixProblem, agent: AgentKind, thisMac: MachineHealth | null) {
  if (item?.local) return { onMachine: true, available: item.agents.checkedAt === null || item.agents[agent] !== null };
  const reachable = item !== null && item.status !== 'unreachable' && item.status !== 'pending' && item.status !== 'unconfigured';
  if (problem.from === 'machine' && reachable && item.agents[agent]) return { onMachine: true, available: true };
  return { onMachine: false, available: !thisMac || thisMac.agents.checkedAt === null || thisMac.agents[agent] !== null };
}

/** The agents a session can start with, each with where it would run. */
export const fixSessions = (item: MachineHealth | null, problem: FixProblem, thisMac: MachineHealth | null) =>
  AGENT_KINDS.map((agent) => ({ agent, ...fixPlacement(item, problem, agent, thisMac) }));

/** What the agent is told about the machine: how to reach it and what it is. */
function machineFacts(machine: string, item: MachineHealth | null, t: Translate): string[] {
  const facts = item?.facts ?? null;
  const shown = machineName(machine);
  const lines = [t('fix.prompt.fact.name', { value: shown === machine ? machine : `${shown} (${machine})` })];
  if (!item) return lines;
  lines.push(item.local ? t('fix.prompt.fact.thisMac') : t('fix.prompt.fact.ssh', { command: sshCommand(item) }));
  if (facts) {
    if (facts.hostname) lines.push(t('fix.prompt.fact.hostname', { value: facts.hostname }));
    if (facts.ip) lines.push(t('fix.prompt.fact.ip', { value: facts.ip }));
    lines.push(t('fix.prompt.fact.os', { os: facts.os, version: facts.osVersion, arch: facts.arch }).replace(/\s+\(/, ' ('));
    const model = [facts.productName || facts.model, facts.chip].filter(Boolean).join(', ');
    if (model) lines.push(t('fix.prompt.fact.model', { value: model }));
    lines.push(t('fix.prompt.fact.hardware', { cores: facts.cores, memory: formatBytes(facts.memTotalKb * KIB, 0), disk: formatBytes(facts.diskTotalKb * KIB, 0) }));
    if (facts.uptimeS !== null) lines.push(t('fix.prompt.fact.uptime', { value: formatDuration(facts.uptimeS * 1000) }));
  }
  for (const agent of AGENT_KINDS) {
    const install = item.agents[agent];
    if (install) lines.push(t('fix.prompt.fact.agent', { agent: t(AGENT_NAME[agent]), version: install.version ?? '?', path: install.path }));
  }
  if (item.agents.t3) lines.push(t('fix.prompt.fact.t3', { version: item.agents.t3.version ?? '?' }));
  return lines;
}

/**
 * The prompt for an agent asked to fix `problem`. `where` is where it runs: on the machine, on this Mac (reaching the
 * machine over SSH), or unknown for a prompt copied to run anywhere. Only what the pages already show goes in: the
 * machine's address, system and readings, never a key, token or setting's value.
 */
export function fixPrompt(machine: string, item: MachineHealth | null, problem: FixProblem, where: 'machine' | 'thisMac' | 'unknown', t: Translate): string {
  const shown = machineName(machine);
  const ssh = item ? sshCommand(item) : null;
  const place = item?.local || where === 'machine'
    ? t('fix.prompt.where.machine', { machine: shown })
    : where === 'thisMac' && ssh
    ? t('fix.prompt.where.elsewhere', { machine: shown, command: ssh })
    : ssh
    ? t('fix.prompt.where.unknown', { machine: shown, hostname: item?.facts?.hostname || shown, command: ssh })
    : t('fix.prompt.where.noHost', { machine: shown });
  const list = (lines: string[]) => lines.map((line) => `- ${line}`).join('\n');
  return [
    t('fix.prompt.intro', { machine: shown }),
    t('fix.prompt.problem', { text: problem.text }),
    ...(problem.details.length ? [`${t('fix.prompt.details')}\n${list(problem.details)}`] : []),
    t('fix.prompt.goal', { text: problem.goal }),
    `${t('fix.prompt.machine')}\n${list(machineFacts(machine, item, t))}`,
    place,
    `${t('fix.prompt.rules')}\n${list([t('fix.prompt.rule.look'), t('fix.prompt.rule.ask'), t('fix.prompt.rule.done')])}`,
  ].join('\n\n');
}

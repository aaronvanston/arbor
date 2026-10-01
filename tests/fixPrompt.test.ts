import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import {
  agentBehindProblem,
  fixPrompt,
  fixSessions,
  healthProblem,
  setupCheckProblem,
  skipProblem,
  sshCommand,
  t3AdvisoryProblem,
} from '../src/services/fixPrompt';
import type { AgentInstall, HealthPoint, MachineAgents, MachineFacts, MachineHealth } from '../src/native/types';
import { present } from './support/items';

const t = translate;
const GB_KB = 1024 * 1024;

const install = (version: string, path: string): AgentInstall => ({ version, path, real: null, method: 'native', updateCommand: `${path} update`, copies: [] });
const agents = (fields: Partial<MachineAgents> = {}): MachineAgents => ({
  claude: null, codex: null, checkedAt: 1, error: null, updating: [], reporter: { installed: false, homes: [] }, t3: null, ...fields,
});
const facts: MachineFacts = {
  hostname: 'cedar-02.lan', os: 'Linux', osVersion: 'Ubuntu 24.04', arch: 'x86_64', model: 'B650', productName: '', chip: 'Ryzen 9',
  gpu: '', cores: 16, memTotalKb: 32 * GB_KB, diskTotalKb: 1000 * GB_KB, swapTotalKb: 8 * GB_KB, gpuMemTotalMb: null,
  ip: '192.168.1.40', uptimeS: 90_000, batteryPct: null, batteryState: '',
};
const latest: HealthPoint = {
  t: 0, score: 60, cpu: 12, mem: 81, memUsedKb: 26 * GB_KB, swap: 73, swapUsedKb: 6 * GB_KB, disk: 40, diskFreeKb: 600 * GB_KB,
  load1: 1.5, load5: 1.2, load15: 1, rxBps: null, txBps: null, latencyMs: null, cpuTemp: null, gpuTemp: null, gpuUtil: null,
  gpuMemUsedMb: null, claudeRunning: 0, codexRunning: 0,
};
const machine = (fields: Partial<MachineHealth> = {}): MachineHealth => ({
  machine: 'cedar-02',
  host: { machine: 'cedar-02', endpoint: 'casey@cedar-02', port: 2222, enabled: true, source: 'manual' },
  local: false, status: 'degraded', score: 60, reason: { metric: 'swap', value: 73 }, facts, latest, points: [],
  error: null, lastOkAt: 0, lastAttemptAt: 0, pingTarget: null, path: null,
  agents: agents({ claude: install('2.1.3', '/home/casey/.local/bin/claude'), codex: install('0.150.0', '/usr/local/bin/codex') }),
  ...fields,
});
const thisMac = (fields: Partial<MachineAgents> = {}) =>
  machine({ machine: 'casey-mbp', local: true, host: { machine: 'casey-mbp', endpoint: 'localhost', port: 22, enabled: true, source: 'local' }, agents: agents(fields) });

describe('fix prompts', () => {
  it('reaches the machine with its port and user', () => {
    expect(sshCommand(machine())).toBe('ssh -p 2222 casey@cedar-02');
    expect(sshCommand(machine({ host: { machine: 'cedar-02', endpoint: ' cedar-02 ', port: 22, enabled: true, source: 'manual' } }), ['-v'])).toBe('ssh -v cedar-02');
  });

  it('tells an agent the problem, the readings behind it and the machine, wherever it runs', () => {
    const item = machine();
    const problem = present(healthProblem(item, t));
    expect(problem.text).toBe('Swapping heavily · 73% of swap used');
    expect(problem.details).toContain('Swap: 73% used (6.0 GB of 8 GB)');
    const copied = fixPrompt('cedar-02', item, problem, 'unknown', t);
    for (const line of [
      'The problem: Swapping heavily · 73% of swap used',
      '- Reached over SSH with: ssh -p 2222 casey@cedar-02',
      '- Hostname: cedar-02.lan',
      '- IP address: 192.168.1.40',
      '- System: Linux Ubuntu 24.04 (x86_64)',
      '- Model: B650, Ryzen 9',
      '- Claude Code 2.1.3 at /home/casey/.local/bin/claude',
      '- Codex 0.150.0 at /usr/local/bin/codex',
      'if it isn’t cedar-02.lan, reach the machine with `ssh -p 2222 casey@cedar-02`',
      'Ask me before installing or removing software',
    ]) expect(copied).toContain(line);
    expect(fixPrompt('cedar-02', item, problem, 'machine', t)).toContain('You’re running on cedar-02 itself');
    expect(fixPrompt('cedar-02', item, problem, 'thisMac', t)).toContain('You’re not on cedar-02. Reach it with `ssh -p 2222 casey@cedar-02`');
  });

  it('works before the machine has been read, and says nothing about a healthy one', () => {
    const note = present(skipProblem({ machine: 'cedar-02', channel: 'userdata', reason: 'noSqlite3', migration: null }, t));
    const prompt = fixPrompt('cedar-02', null, note, 'unknown', t);
    expect(prompt).toContain('cedar-02 has T3 Code but no sqlite3');
    expect(prompt).toContain('Install the sqlite3 command-line tool');
    expect(prompt).toContain('Arbor has no SSH address for cedar-02');
    expect(healthProblem(machine({ reason: null, status: 'healthy' }), t)).toBeNull();
    expect(healthProblem(machine({ status: 'pending' }), t)).toBeNull();
  });

  it('only offers to fix a T3 Code database the machine can do something about', () => {
    const note = (reason: 'noSqlite3' | 'unreadable' | 'schema' | 'migrationRange', migration: number | null = null) =>
      skipProblem({ machine: 'cedar-02', channel: 'userdata', reason, migration }, t);
    expect(note('unreadable')).not.toBeNull();
    expect(present(note('migrationRange', 20)).goal).toContain('Update T3 Code');
    // Newer than Arbor reads, or a shape it doesn't know, needs Arbor updated instead.
    expect(note('migrationRange', 99)).toBeNull();
    expect(note('schema')).toBeNull();
  });

  it('fixes a machine it can’t reach from this Mac, with what SSH said', () => {
    const item = machine({ status: 'unreachable', error: 'ssh: connect to host cedar-02 port 2222: Connection refused' });
    const problem = present(healthProblem(item, t));
    expect(problem.from).toBe('thisMac');
    expect(problem.text).toBe('Unreachable · It refused the SSH connection.');
    expect(problem.goal).toContain('`ssh -v -p 2222 casey@cedar-02 true`');
    expect(problem.details).toContain('SSH said: ssh: connect to host cedar-02 port 2222: Connection refused');
    const sessions = fixSessions(item, problem, thisMac({ claude: install('2.1.3', '/opt/claude') }));
    expect(sessions).toEqual([
      { agent: 'claude', onMachine: false, available: true },
      { agent: 'codex', onMachine: false, available: false },
    ]);
  });

  it('starts a session on the machine when its agent is there, and on this Mac otherwise', () => {
    const item = machine({ agents: agents({ claude: install('2.1.3', '/home/casey/.local/bin/claude') }) });
    const problem = present(healthProblem(item, t));
    expect(fixSessions(item, problem, null)).toEqual([
      { agent: 'claude', onMachine: true, available: true },
      // Whether this Mac has Codex isn't known when the Machines page doesn't list it, so it's offered.
      { agent: 'codex', onMachine: false, available: true },
    ]);
    const local = thisMac({ codex: install('0.150.0', '/opt/codex') });
    expect(fixSessions(local, problem, local)).toEqual([
      { agent: 'claude', onMachine: true, available: false },
      { agent: 'codex', onMachine: true, available: true },
    ]);
    expect(fixPrompt('casey-mbp', local, problem, 'unknown', t)).toContain('It’s the Mac Arbor runs on.');
  });

  it('asks for an agent update the way it was installed', () => {
    const problem = agentBehindProblem({ agent: 'codex', version: '0.150.0', newest: '0.158.0', machine: 'casey-mbp' }, machine(), t);
    expect(problem.text).toBe('Codex 0.150.0 here, 0.158.0 on casey-mbp');
    expect(problem.goal).toContain('Update Codex from 0.150.0 to 0.158.0');
    expect(problem.goal).toContain('`/usr/local/bin/codex update`');
    expect(t3AdvisoryProblem('claude', 'T3 Code breaks with this', t).goal).toContain('Claude Code to a version T3 Code supports');
  });

  it('carries a Sync check’s home and subjects', () => {
    const problem = setupCheckProblem({ title: '2 broken imports', detail: 'They point at missing files.', home: '~/.agent-app/homes/work', subjects: ['CLAUDE.md (@rules.md)'], error: null }, t);
    expect(problem.text).toBe('2 broken imports. They point at missing files.');
    expect(problem.goal).toContain('agent home ~/.agent-app/homes/work');
    expect(problem.details).toEqual(['About: CLAUDE.md (@rules.md)']);
  });

  it('SECRET: says nothing the pages don’t already show about the machine', () => {
    const item = machine({ agents: agents({ claude: { ...install('2.1.3', '/home/casey/.local/bin/claude'), updateCommand: 'claude update' } }) });
    const prompt = fixPrompt('cedar-02', item, present(healthProblem(item, t)), 'unknown', t);
    expect(prompt).not.toMatch(/token|api[_ -]?key|secret|password|Bearer/i);
  });
});

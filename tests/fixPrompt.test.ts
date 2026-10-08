import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import {
  agentBehindProblem,
  agentCheckFailedProblem,
  agentMissingProblem,
  agentUpdateFailedProblem,
  archiveCollectionProblem,
  checkoutProblem,
  duplicateInstallProblem,
  libraryLinesProblem,
  mcpServerProblem,
  projectToolchainProblem,
  projectsInLineProblem,
  scanFailedProblem,
  sessionRetentionProblem,
  settingsInLineProblem,
  startingContextProblem,
  toolBehindProblem,
  toolsInLineProblem,
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
  claude: null, codex: null, checkedAt: 1, error: null, updating: [], reporter: { installed: false, homes: [] }, t3: null, orca: null, ...fields,
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
  host: { machine: 'cedar-02', endpoint: 'cam@cedar-02', port: 2222, enabled: true, source: 'manual' },
  local: false, status: 'degraded', score: 60, reason: { metric: 'swap', value: 73 }, facts, latest, points: [],
  error: null, lastOkAt: 0, lastAttemptAt: 0, pingTarget: null, path: null,
  agents: agents({ claude: install('2.1.3', '/home/cam/.local/bin/claude'), codex: install('0.150.0', '/usr/local/bin/codex') }),
  historyRev: 0,
  ...fields,
});
const thisMac = (fields: Partial<MachineAgents> = {}) =>
  machine({ machine: 'cam-mbp', local: true, host: { machine: 'cam-mbp', endpoint: 'localhost', port: 22, enabled: true, source: 'local' }, agents: agents(fields) });

describe('fix prompts', () => {
  it('reaches the machine with its port and user', () => {
    expect(sshCommand(machine())).toBe('ssh -p 2222 cam@cedar-02');
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
      '- Reached over SSH with: ssh -p 2222 cam@cedar-02',
      '- Hostname: cedar-02.lan',
      '- IP address: 192.168.1.40',
      '- System: Linux Ubuntu 24.04 (x86_64)',
      '- Model: B650, Ryzen 9',
      '- Claude Code 2.1.3 at /home/cam/.local/bin/claude',
      '- Codex 0.150.0 at /usr/local/bin/codex',
      'if it isn’t cedar-02.lan, reach the machine with `ssh -p 2222 cam@cedar-02`',
      'Ask me before installing or removing software',
    ]) expect(copied).toContain(line);
    expect(fixPrompt('cedar-02', item, problem, 'machine', t)).toContain('You’re running on cedar-02 itself');
    expect(fixPrompt('cedar-02', item, problem, 'thisMac', t)).toContain('You’re not on cedar-02. Reach it with `ssh -p 2222 cam@cedar-02`');
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
    expect(problem.goal).toContain('`ssh -v -p 2222 cam@cedar-02 true`');
    expect(problem.details).toContain('SSH said: ssh: connect to host cedar-02 port 2222: Connection refused');
    const sessions = fixSessions(item, problem, thisMac({ claude: install('2.1.3', '/opt/claude') }));
    expect(sessions).toEqual([
      { agent: 'claude', onMachine: false, available: true },
      { agent: 'codex', onMachine: false, available: false },
    ]);
  });

  it('starts a session on the machine when its agent is there, and on this Mac otherwise', () => {
    const item = machine({ agents: agents({ claude: install('2.1.3', '/home/cam/.local/bin/claude') }) });
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
    expect(fixPrompt('cam-mbp', local, problem, 'unknown', t)).toContain('It’s the Mac Arbor runs on.');
  });

  it('asks for an agent update the way it was installed', () => {
    const problem = agentBehindProblem({ agent: 'codex', version: '0.150.0', newest: '0.158.0', machine: 'cam-mbp' }, machine(), t);
    expect(problem.text).toBe('Codex 0.150.0 here, 0.158.0 on cam-mbp');
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
    const item = machine({ agents: agents({ claude: { ...install('2.1.3', '/home/cam/.local/bin/claude'), updateCommand: 'claude update' } }) });
    const prompt = fixPrompt('cedar-02', item, present(healthProblem(item, t)), 'unknown', t);
    expect(prompt).not.toMatch(/token|api[_ -]?key|secret|password|Bearer/i);
  });

  it('words every other kind of problem with its facts', () => {
    const tool = toolBehindProblem({ tool: 'Node', version: '20.11.0', newest: '22.4.0', path: '/usr/local/bin/node', kept: ['22.4.0 (nvm)'] }, t);
    expect(tool.text).toBe('Node 20.11.0 here is a release behind 22.4.0, the newest on my machines.');
    expect(tool.details).toEqual(['Path: /usr/local/bin/node', 'Also kept: 22.4.0 (nvm)']);

    const project = projectToolchainProblem({ project: 'arbor', path: '~/src/arbor', needs: ['Node >=22: 20.11.0 here'], packages: ['react: 18 installed, wants ^19'] }, t);
    expect(project.goal).toContain('In ~/src/arbor');
    expect(project.details).toHaveLength(2);

    const library = libraryLinesProblem({ library: 'zod', newest: '4.1.0', uses: ['arbor 4.1.0', 'proxy 3.22.0'], behind: ['proxy on 3.22.0 at ~/src/proxy on cedar-02'] }, t);
    expect(library.text).toBe('My projects use zod on 2 different versions.');
    expect(library.details).toContain('Behind: proxy on 3.22.0 at ~/src/proxy on cedar-02');

    expect(toolsInLineProblem({ reference: 'cam-mbp', missing: ['Go'], behind: [] }, t).details).toEqual(['Missing, which cam-mbp has: Go']);
    expect(settingsInLineProblem({ reference: 'cam-mbp', missing: ['model (Setting, Claude Code)'], different: [] }, t).goal).toContain('never copy a secret’s value');
    expect(projectsInLineProblem({ reference: 'cam-mbp', clones: ['git clone git@github.com:acme/proxy.git ~/src/proxy'] }, t).text).toBe('cam-mbp has 1 projects checked out that this machine doesn’t.');
    expect(agentMissingProblem({ agent: 'codex', command: 'npm install -g @openai/codex' }, t).goal).toContain('`npm install -g @openai/codex`');

    const failed = agentUpdateFailedProblem({ agent: 'claude', command: 'claude update', output: 'x'.repeat(3_000) }, t);
    expect(failed.details[0]).toBe('Command: claude update');
    // Long output keeps its end, where the error is.
    expect(failed.details[1]?.length).toBeLessThan(2_100);

    expect(duplicateInstallProblem({ agent: 'claude', copies: ['/a/claude (2.1.3)', '/b/claude (2.0.1)'] }, t).details).toEqual(['First on PATH: /a/claude (2.1.3)', 'Also: /b/claude (2.0.1)']);
    expect(agentCheckFailedProblem('sh: 1: claude: not found', t).details).toEqual(['Error: sh: 1: claude: not found']);
    expect(checkoutProblem({ project: 'arbor', path: '~/src/arbor', remote: 'git@github.com:cam/arbor.git', defaultBranch: 'main', issues: ['Fetching didn’t work'] }, t).details)
      .toEqual(['Remote: git@github.com:cam/arbor.git', 'Default branch: main', 'Fetching didn’t work']);
    expect(mcpServerProblem({ server: 'docs', home: '~/.claude', status: 'needsAuth', transport: 'http', plugin: null }, t).text).toContain('waiting to be signed in to');
    // Collecting and scanning run from this Mac, so their sessions start here.
    expect(archiveCollectionProblem({ error: 'Permission denied (publickey)', lastOk: null }, t).from).toBe('thisMac');
    expect(scanFailedProblem({ scan: 'toolchain', error: 'exit 2' }, t).from).toBe('thisMac');
    expect(sessionRetentionProblem({ home: '~/.claude', days: 30 }, t).text).toBe('Claude Code deletes sessions in ~/.claude after 30 days.');
    expect(startingContextProblem({ agent: 'claude', home: '~/.claude', median: '42K', change: '8K', days: 7 }, t).text).toContain('8K more tokens');
  });
});

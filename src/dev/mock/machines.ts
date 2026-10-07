/** The browser mock's answers for the machines: their health, agents, reporters and telemetry, and Arbor's calls to them. */
import { emit } from '@tauri-apps/api/event';
import type { MachineCommands } from '../../native/machines';
import type {
  AgentHome,
  AgentHomeKind,
  AgentHomesView,
  AgentInstall,
  AgentKind,
  AgentUpdate,
  CallDiagnostics,
  ClientHour,
  ClientVersions,
  DiagnosticCall,
  DiscoveredHost,
  FoundHome,
  HomeGuess,
  Harness,
  HarnessInfo,
  HealthPoint,
  MachineAgents,
  MachineFacts,
  MachineHealth,
  MachineHealthSnapshot,
  MachineHistory,
  MachineProbes,
  MachineHost,
  MachineTelemetry,
  NetworkPath,
  OrcaInstall,
  ReporterHome,
  ReporterSetup,
  ReporterStatus,
  SettingsEdit,
  Spend,
  T3Install,
  T3Policy,
  TelemetryBreakdown,
  TelemetrySetup,
  TelemetryStatus,
} from '../../native/types';
import { homePathProblem } from '../../services/agentHomes';
import type { CommandAnswers } from './answers';
import { poolAnswers, poolSshAnswers } from './pools';
import { runAnswers } from './runs';
import { configSettings } from './core';
import { freshInstall, later, mockLog, now, params, realSize } from './scenario';
import { joinSetupMachine, leaveToPolicy, mockHarnessesFound, recordEditMock, scanSetupMock, setupItem, setupMachines } from './setup';
import { reporterInstalled, setMockT3Enabled, setMockT3Titles } from './usage';

// Settings › Diagnostics: Arbor's calls to machines and the core, by `?diagnostics=` (listed at the top).
const diagnosticsScenario = params.get('diagnostics') ?? (freshInstall ? 'empty' : 'mixed');

function mockCalls(scenario: string): DiagnosticCall[] {
  if (scenario === 'empty') return [];
  const calls: DiagnosticCall[] = [];
  const minute = 60_000;
  const add = (
    kind: DiagnosticCall['kind'], target: string, operation: string, slowAfterMs: number, agoMs: number, durationMs: number,
    outcome: DiagnosticCall['outcome'] = 'ok', code: number | null = kind === 'core' ? 200 : 0,
  ) => calls.push({
    atMs: now - agoMs, kind, target, operation, durationMs, code: outcome === 'timedOut' ? null : code, outcome, slowAfterMs,
    slow: outcome === 'ok' && durationMs > slowAfterMs,
  });
  // A steady wobble, so the same call doesn't take exactly as long each time.
  const wobble = (index: number, base: number, spread: number) => Math.max(1, Math.round(base + spread * Math.sin(index * 1.7) + spread * 0.5 * Math.cos(index * 0.9)));
  const slow = scenario === 'slow';
  const fail = scenario === 'fail';
  const mixed = scenario === 'mixed';
  for (let index = 0; index < 50; index += 1) {
    const ago = index * minute + 20_000;
    add('machine', 'cam-mbp', 'health check', 10_000, ago, wobble(index, 140, 40));
    add('machine', 'cedar-02', 'health check', 10_000, ago + 3_000, wobble(index, 520, 180));
    add('machine', 'cedar-02', 'needs-you check', 10_000, ago + 9_000, wobble(index, 310, 90));
    if (fail && index < 15) {
      // ci-01 dropped off a quarter of an hour ago: SSH can't connect, and some checks run out of time first.
      if (index % 4 === 1) add('machine', 'ci-01', 'health check', 10_000, ago + 6_000, 12_000, 'timedOut');
      else add('machine', 'ci-01', 'health check', 10_000, ago + 6_000, wobble(index, 5_100, 60), 'failed', 255);
    } else if (slow) {
      add('machine', 'ci-01', 'health check', 10_000, ago + 6_000, wobble(index, 11_200, 2_600));
    } else if (mixed && index === 8) {
      add('machine', 'ci-01', 'health check', 10_000, ago + 6_000, 5_040, 'failed', 255);
    } else {
      add('machine', 'ci-01', 'health check', 10_000, ago + 6_000, mixed && [4, 17, 30].includes(index) ? 11_000 + index * 90 : wobble(index, 950, 380));
    }
    add('core', 'core', 'GET /auth-files', 3_000, ago + 30_000, (slow && index % 6 === 0) || (mixed && index === 2) ? 3_400 + index * 10 : wobble(index, 45, 20));
    if (fail && index % 4 === 0) add('core', 'core', 'POST /api-call', 10_000, ago + 40_000, wobble(index, 2_300, 400), 'failed', 502);
    else add('core', 'core', 'POST /api-call', 10_000, ago + 40_000, slow && index % 5 === 0 ? 12_400 + index * 40 : wobble(index, 780, 300));
    if (fail && index < 3) add('core', 'core', 'GET /usage-queue', 3_000, ago + 50_000, 2, 'failed', null);
  }
  // Rarer ones, once an hour or so.
  for (let index = 0; index < 6; index += 1) {
    const ago = index * 3_600_000 + 5 * minute;
    if (fail && index === 0) add('machine', 'cedar-02', 'setup scan', 60_000, ago, 60_000, 'timedOut');
    else add('machine', 'cedar-02', 'setup scan', 60_000, ago, wobble(index, 6_100, 900));
    add('machine', 'cam-mbp', 'transcript scan', 60_000, ago + 2 * minute, slow && index === 1 ? 75_300 : wobble(index, 2_400, 500));
    add('core', 'core', 'GET /config.yaml', 3_000, ago + 6 * minute, wobble(index, 35, 10));
  }
  if (fail) add('machine', 'cam-mbp', 'agent update', 180_000, 2 * 3_600_000, 48_200, 'failed', 1);
  return calls.sort((a, b) => b.atMs - a.atMs);
}

let diagnosticsCalls = mockCalls(diagnosticsScenario);

let diagnosticsClearedAt: number | null = null;

// Machine health: a synthetic fleet with one hour of five-second history so
// the sparklines, statuses, and reasons all render in the browser.
const healthHosts: MachineHost[] = [
  { machine: 'cam-mbp', endpoint: 'localhost', port: 22, enabled: true, source: 'seed' },
  { machine: 'ci-01', endpoint: 'ci-01', port: 22, enabled: true, source: 'seed' },
  { machine: 'cedar-02', endpoint: 'cedar-02', port: 22, enabled: true, source: 'seed' },
  { machine: 'lab-box', endpoint: '', port: 22, enabled: true, source: 'seed' },
  // Machines seen only through their requests and sessions: a key assigned to one, or a transcript from one, gives
  // it a host to fill in, as Rust's seed_hosts does, rather than leaving its page saying it was removed.
  { machine: 'ci-runner', endpoint: '', port: 22, enabled: true, source: 'seed' },
  { machine: 'studio', endpoint: '', port: 22, enabled: true, source: 'seed' },
];
// `?machines=many` adds a rack of fourteen build machines, one with no host yet, so the sidebar's list of machines is
// longer than a short window has room for. `?size=real` adds eight, for a fleet of fourteen.
const buildMachines = params.get('machines') === 'many' ? 14 : realSize ? 8 : 0;
if (buildMachines) {
  for (let index = 1; index <= buildMachines; index += 1) {
    const name = `build-${String(index).padStart(2, '0')}`;
    healthHosts.push({ machine: name, endpoint: index === 9 ? '' : name, port: 22, enabled: true, source: 'manual' });
  }
}
// `?machines=unhosted` has no machine with a host yet, so nothing checks any machine's health or agents.
if (params.get('machines') === 'unhosted') for (const host of healthHosts) host.endpoint = '';
// A fresh install lists no machine at all, this Mac included.
if (freshInstall) healthHosts.length = 0;
/** This Mac's name in the mock, the one it's listed under by default. */
const MOCK_THIS_MAC = 'cam-mbp';

// Grove's health probes: ci-01 and this Mac stream by default, cedar-02 is read over SSH each round. `?probes=none` has
// no probe anywhere, `?probes=fail` has installing or removing one fail, and `?grove=missing` has Grove unavailable,
// so health comes from Arbor's own script and the machine page and Settings › Machines say why.
const probeScenario = params.get('probes');
const probesInstalled = new Set(probeScenario === 'none' ? [] : ['cam-mbp', 'ci-01']);
const MOCK_GROVE = '0.1.2';
const machineProbes = (): MachineProbes => params.get('grove') === 'missing'
  ? { version: MOCK_GROVE, unavailable: 'Grove answered as 0.1.1 where this build of Arbor expects 0.1.2', machines: [] }
  : {
    version: MOCK_GROVE,
    unavailable: null,
    machines: healthHosts.filter((host) => host.enabled && host.endpoint).map((host) => ({
      machine: host.machine, installed: probesInstalled.has(host.machine), streaming: probesInstalled.has(host.machine),
    })),
  };

const healthPoint = (name: string, t: number): HealthPoint => {
  const phase = t / 60_000;
  const wave = (k: number, offset = 0) => (Math.sin(phase * k + offset) + 1) / 2;
  const cpu = name === 'ci-01' ? 70 + 28 * wave(1.7) : 8 + 30 * wave(0.9, name.length);
  const mem = name === 'cam-mbp' ? 58 + 4 * wave(0.4) : name === 'ci-01' ? 84 + 10 * wave(0.6) : 30 + 5 * wave(0.5);
  const disk = name === 'cam-mbp' ? 91.2 : name === 'ci-01' ? 61 : 22.7;
  const score = Math.round(Math.max(0, 100 - (disk > 82 ? 30 * Math.min(1, (disk - 82) / 14) : 0) - (mem > 78 ? 35 * Math.min(1, (mem - 78) / 18) : 0) - (cpu > 75 ? 35 * Math.min(1, (cpu - 75) / 23) : 0)));
  const memTotal = name === 'cam-mbp' ? 67_108_864 : 64_308_204;
  const diskTotal = name === 'cedar-02' ? 980_760_096 : 482_797_652;
  return {
    t, score, cpu: Math.round(cpu * 10) / 10, mem: Math.round(mem * 10) / 10, memUsedKb: Math.round((memTotal * mem) / 100),
    swap: name === 'cedar-02' ? null : Math.round((name === 'ci-01' ? 62 : 28) + 6 * wave(0.3)), swapUsedKb: name === 'cedar-02' ? null : 3_650_109,
    disk, diskFreeKb: Math.round((diskTotal * (100 - disk)) / 100), load1: 3.6 + 2 * wave(1.1), load5: 3.1, load15: 2.4,
    rxBps: 74_000 + 220_000 * wave(2.3, 1), txBps: 307_000 + 90_000 * wave(1.9),
    // ci-01 is relayed and drops the odd ping; `?ping=none` makes it ignore pings altogether.
    latencyMs: name === 'cam-mbp' || (name === 'ci-01' && (params.get('ping') === 'none' || Math.floor(t / 5_000) % 41 === 0))
      ? null
      : Math.round((name === 'ci-01' ? 38 + 22 * wave(1.6, 2) : 2.2 + 3.5 * wave(2.7)) * 10) / 10,
    cpuTemp: name === 'cam-mbp' ? null : Math.round(48 + 30 * wave(1.3)), gpuTemp: name === 'cedar-02' ? Math.round(52 + 8 * wave(0.8)) : null,
    gpuUtil: name === 'cedar-02' ? Math.round(5 + 40 * wave(2.1)) : null, gpuMemUsedMb: null,
    claudeRunning: name === 'cam-mbp' ? 3 : name === 'ci-01' ? 1 : 0, codexRunning: name === 'cam-mbp' ? 2 : name === 'cedar-02' ? 1 : 0,
  };
};

// Arbor's reporter on each machine, as the agents check finds it: cam-mbp reports from its own homes and a second pair,
// cedar-02 from Claude Code's, and ci-01 hasn't been set up. ?reporter=partial has a second Codex home that stopped
// reporting; ?reporter=fail makes a change fail.
const reporterHomes: Record<string, ReporterHome[]> = {
  'cam-mbp': [
    { agent: 'claude', home: '~/.claude', reporting: true },
    { agent: 'codex', home: '~/.codex', reporting: true },
    { agent: 'claude', home: '~/.agent-app/homes/claude-other', reporting: true },
    { agent: 'codex', home: '~/.agent-app/homes/codex-other', reporting: params.get('reporter') !== 'partial' },
  ],
  'ci-01': [{ agent: 'claude', home: '~/.claude', reporting: false }, { agent: 'codex', home: '~/.codex', reporting: false }],
  'cedar-02': [{ agent: 'claude', home: '~/.claude', reporting: true }],
};

const reporterStatus = (machine: string): ReporterStatus => ({ installed: reporterInstalled[machine] ?? false, homes: reporterHomes[machine] ?? [] });

const reporterPlan = (machine: string, enabled: boolean): ReporterSetup => ({
  reporterChanged: false,
  files: (reporterHomes[machine] ?? []).map(({ agent, home, reporting }) => {
    const created = home.includes('claude-other') && enabled && !reporting;
    return {
      agent, home, path: `${home}/${agent === 'claude' ? 'settings.json' : 'config.toml'}`,
      change: enabled === reporting && reporterInstalled[machine] === enabled ? 'none' : created ? 'create' : 'edit',
      chained: agent === 'codex' && home === '~/.codex', written: false, error: null,
    };
  }),
});

// Claude Code's telemetry: the receiver is on and this Mac and cedar-02 send to it; ci-01 isn't set up. See the
// `?telemetry=` flags in the header.
// A new install has the receiver off, as Rust's default does.
const telemetryScenario = params.get('telemetry') ?? (freshInstall ? 'off' : null);

// Each machine sending, with the port it sends to, which is stale once the receiver moves.
type SendingMachine = Omit<MachineTelemetry, 'stalePort'> & { port: number };

const telemetryState: { enabled: boolean; port: number; machines: SendingMachine[] } = {
  enabled: telemetryScenario !== 'off',
  port: 8319,
  machines: telemetryScenario === 'off' || telemetryScenario === 'none' ? [] : [
    { machine: 'cam-mbp', sinceMs: Date.now() - 12 * 86_400_000, lastMs: telemetryScenario === 'quiet' ? null : Date.now() - 3 * 60_000, requests: telemetryScenario === 'quiet' ? 0 : 412, cumulative: false, port: 8319 },
    { machine: 'cedar-02', sinceMs: Date.now() - 9 * 86_400_000, lastMs: Date.now() - (telemetryScenario === 'quiet' ? 2 * 86_400_000 : 21 * 60_000), requests: 188, cumulative: telemetryScenario === 'cumulative', port: telemetryScenario === 'stale' ? 8320 : 8319 },
  ],
};

const telemetryStatus = (): TelemetryStatus => ({
  enabled: telemetryState.enabled,
  port: telemetryState.port,
  listening: telemetryState.enabled && telemetryScenario !== 'busy' ? `${telemetryScenario === 'local' ? '127.0.0.1' : '*'}:${telemetryState.port}` : null,
  error: telemetryState.enabled && telemetryScenario === 'busy' ? `Arbor couldn't listen on port ${telemetryState.port}: Address already in use (os error 48)` : null,
  lan: telemetryScenario !== 'local',
  machines: telemetryState.machines.map(({ port, ...entry }) => ({ ...entry, stalePort: port === telemetryState.port ? null : port })),
});

// A day's spend, split each way Claude Code's metrics can be. Names are the kind Claude Code sends without its
// tool-detail switch: the user's own skills by name, other marketplaces' as third-party, their own servers and
// subagents as custom.
const TELEMETRY_DAY: Record<string, [string, number, number][]> = {
  sources: [['main', 38.2, 31], ['subagent', 9.4, 12], ['auxiliary', 0.62, 31]],
  skills: [['release-arbor', 6.8, 4], ['frontend-design', 4.1, 3], ['third-party', 2.9, 5], ['browser-check', 2.2, 2], ['pdf', 0.4, 1]],
  plugins: [['superpowers', 3.4, 6], ['context7', 1.1, 4], ['third-party', 0.8, 2]],
  mcpServers: [['context7', 2.6, 7], ['custom', 1.9, 5], ['claude_ai_Linear', 1.2, 3]],
  agents: [['Explore', 5.1, 9], ['general-purpose', 2.7, 5], ['custom', 1.3, 2], ['Plan', 0.3, 1]],
  models: [['claude-opus-5-5', 41.6, 29], ['claude-sonnet-5', 5.9, 14], ['claude-haiku-4-5-20251001', 0.72, 31]],
  versions: [['2.4.12', 30.4, 22], ['2.4.11', 17.82, 11]],
};

const TELEMETRY_SHARE: Record<string, number> = { 'cam-mbp': 0.72, 'cedar-02': 0.28 };

const telemetrySpend = (cost: number, sessions: number): Spend => ({
  cost: Math.round(cost * 100) / 100,
  inputTokens: Math.round(cost * 9_000),
  outputTokens: Math.round(cost * 2_600),
  cacheReadTokens: Math.round(cost * 260_000),
  cacheCreationTokens: Math.round(cost * 14_000),
  sessions: sessions > 0 ? Math.max(1, Math.round(sessions)) : 0,
});

const mockTelemetryBreakdown = (fromMs: number, toMs: number, machine: string | null): TelemetryBreakdown => {
  const now = Date.now();
  const from = Math.max(fromMs, now - 30 * 86_400_000);
  const days = Math.max(0, Math.min(toMs, now) - from) / 86_400_000;
  const sending = telemetryState.machines.filter((entry) => entry.lastMs !== null && (machine === null || entry.machine === machine));
  const share = sending.reduce((sum, entry) => sum + (TELEMETRY_SHARE[entry.machine] ?? 0), 0);
  const scale = telemetryScenario === 'quiet' ? 0 : days * share;
  const group = (rows: [string, number, number][]) => scale > 0
    ? rows.map(([name, cost, sessions]) => ({ name, ...telemetrySpend(cost * scale, sessions * Math.min(scale, 1) * Math.max(1, days / 3)) }))
    : [];
  const sources = group(TELEMETRY_DAY.sources ?? []);
  return {
    total: scale > 0 ? telemetrySpend(sources.reduce((sum, row) => sum + row.cost, 0), 31 * Math.min(scale, 1) * Math.max(1, days / 3)) : telemetrySpend(0, 0),
    machines: scale > 0 ? sending.map((entry) => ({ name: entry.machine, ...telemetrySpend(48.22 * days * (TELEMETRY_SHARE[entry.machine] ?? 0), 22 * Math.max(1, days / 3) * (TELEMETRY_SHARE[entry.machine] ?? 0)) })) : [],
    skills: group(TELEMETRY_DAY.skills ?? []),
    plugins: group(TELEMETRY_DAY.plugins ?? []),
    mcpServers: group(TELEMETRY_DAY.mcpServers ?? []),
    agents: group(TELEMETRY_DAY.agents ?? []),
    sources,
    models: group(TELEMETRY_DAY.models ?? []),
    versions: group(TELEMETRY_DAY.versions ?? []),
    firstHourMs: scale > 0 ? Math.floor(from / 3_600_000) * 3_600_000 : null,
    lastHourMs: scale > 0 ? Math.floor(Math.min(toMs, now) / 3_600_000) * 3_600_000 : null,
  };
};

// Claude Code and Codex on each machine: Claude Code from its own installer and Codex from npm, unless
// `?install=native|brew|npm|bun|pnpm|mise|unknown` puts both there that way, with the paths and update command that
// go with it (`unknown` updates with the agent's own `update`). ci-01 is behind on both; updating it catches it up.
// `?install=fail` is the core's install failing, which leaves the agents as they are.
const installScenario = (['native', 'brew', 'npm', 'bun', 'pnpm', 'mise', 'unknown'] as const).find((method) => method === params.get('install')) ?? null;

const AGENT_PACKAGE = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' } as const;

function mockInstall(agent: AgentKind, version: string | null, home: string, mac: boolean): AgentInstall {
  return { ...mockInstallAt(agent, version, home, mac), copies: [] };
}

function mockInstallAt(agent: AgentKind, version: string | null, home: string, mac: boolean): Omit<AgentInstall, 'copies'> {
  const method = installScenario ?? (agent === 'claude' ? 'native' : 'npm');
  const pkg = AGENT_PACKAGE[agent];
  const brew = mac ? '/opt/homebrew' : '/home/linuxbrew/.linuxbrew';
  const cask = agent === 'claude' ? 'claude-code' : 'codex';
  switch (method) {
    case 'native': return agent === 'claude'
      ? { version, path: `${home}/.local/bin/claude`, real: `${home}/.local/share/claude/versions/${version ?? '2.1.281'}`, method, updateCommand: 'claude update' }
      : { version, path: `${home}/.local/bin/codex`, real: `${home}/.codex/packages/standalone/${version ?? '0.156.0'}/bin/codex`, method, updateCommand: 'codex update' };
    case 'brew': return { version, path: `${brew}/bin/${agent}`, real: `${brew}/${mac ? 'Caskroom' : 'Cellar'}/${cask}/${version ?? '1.0.0'}/${agent}`, method: 'homebrew', updateCommand: mac ? `brew upgrade --cask ${cask}` : `brew upgrade ${cask}` };
    case 'bun': return { version, path: `${home}/.bun/bin/${agent}`, real: `${home}/.bun/install/global/node_modules/${pkg}/bin/${agent}.js`, method, updateCommand: `bun add -g ${pkg}@latest` };
    case 'pnpm': {
      const pnpmHome = mac ? `${home}/Library/pnpm` : `${home}/.local/share/pnpm`;
      return { version, path: `${pnpmHome}/${agent}`, real: `${pnpmHome}/global/5/node_modules/${pkg}/bin/${agent}.js`, method, updateCommand: `pnpm add -g ${pkg}@latest` };
    }
    case 'mise': return { version, path: `${home}/.local/share/mise/shims/${agent}`, real: `${brew}/bin/mise`, method, updateCommand: `mise upgrade npm:${pkg}` };
    case 'unknown': return { version, path: `/usr/local/bin/${agent}`, real: null, method, updateCommand: `${agent} update` };
    default: return {
      version, path: `${home}/.npm-global/bin/${agent}`, real: `${home}/.npm-global/lib/node_modules/${pkg}/bin/${agent}.js`, method: 'npm',
      updateCommand: `npm install -g --prefix ${home}/.npm-global --allow-scripts=${pkg} ${pkg}@latest`,
    };
  }
}

// T3 Code keeps its home on cam-mbp and cedar-02 (0.0.42, from its app); `?t3compat=broken` puts it on ci-01 too,
// with a version Arbor couldn't read. Harnesses a run can be handed to: T3 Code runs on cam-mbp with a setup of its own
// beside the built-ins, and is installed but stopped on cedar-02; Orca runs on cam-mbp and is installed on ci-01.
// `?harness=none` has neither anywhere, and `?t3=stopped` stops T3 Code on cam-mbp too.
const t3Scenario = params.get('t3compat');
const harnessScenario = params.get('harness');
const t3Stopped = params.get('t3') === 'stopped';
const t3On = (install: T3Install): T3Install | null => (harnessScenario === 'none' ? null : install);
const orcaOn = (install: OrcaInstall): OrcaInstall | null => (harnessScenario === 'none' ? null : install);

// Each machine's agents as its last check found them; the reporter's state is added as the snapshot is read.
const healthAgents: Record<string, Omit<MachineAgents, 'reporter'>> = {
  'cam-mbp': {
    claude: mockInstall('claude', '2.1.281', '/Users/cam', true), codex: mockInstall('codex', '0.156.0', '/Users/cam', true), checkedAt: Date.now() - 4 * 60_000, error: null, updating: [],
    t3: t3On({
      version: '0.0.42', running: !t3Stopped,
      setups: [
        { id: 'codex_work', driver: 'codex', name: 'Codex · Work', enabled: true },
        { id: 'claude_proxy', driver: 'claudeAgent', name: 'Claude · Proxy', enabled: true },
        { id: 'codex', driver: 'codex', name: null, enabled: false },
        { id: 'claudeAgent', driver: 'claudeAgent', name: null, enabled: true },
      ],
    }),
    orca: orcaOn({ version: '1.4.217', running: true, agents: ['claude', 'codex'] }),
  },
  'ci-01': {
    claude: mockInstall('claude', '2.1.270', '/home/ci', false), codex: mockInstall('codex', '0.153.3', '/home/ci', false), checkedAt: Date.now() - 7 * 60_000, error: null, updating: [],
    t3: t3Scenario === 'broken' ? { version: null, running: false, setups: [] } : null,
    orca: orcaOn({ version: null, running: false, agents: ['claude', 'codex'] }),
  },
  'cedar-02': {
    claude: mockInstall('claude', '2.1.281', '/home/cam', false), codex: null, checkedAt: Date.now() - 2 * 60_000, error: null, updating: [],
    t3: t3On({ version: '0.0.42', running: false, setups: [{ id: 'claudeAgent', driver: 'claudeAgent', name: null, enabled: true }] }),
    orca: null,
  },
};

// T3 Code's compatibility policies, as its model manifest had them. `?t3compat=broken` has Codex before 0.154.0 known
// not to work and Claude Code before 2.1.280 unsupported, so ci-01 is warned about both; `?t3compat=fail` is the
// manifest failing to load, which shows nothing.
const mockT3Policies = (): T3Policy[] | null => {
  if (t3Scenario === 'fail') return null;
  const broken = t3Scenario === 'broken';
  return [
    {
      agent: 'codex', t3CodeRange: '>=0.0.42', recommendedRange: '>=0.156.0', recommendedVersion: broken ? '0.156.0' : null,
      ranges: broken
        ? [{ range: '>=0.156.0', status: 'supported' }, { range: '>=0.154.0 <0.156.0', status: 'unsupported' }, { range: '<0.154.0', status: 'broken' }]
        : [{ range: '>=0.156.0', status: 'supported' }, { range: '>=0.149.0 <0.156.0', status: 'unsupported' }, { range: '<0.149.0', status: 'broken' }],
    },
    {
      agent: 'claude', t3CodeRange: '>=0.0.42', recommendedRange: '>=2.1.280', recommendedVersion: null,
      ranges: broken
        ? [{ range: '>=2.1.280', status: 'supported' }, { range: '<2.1.280', status: 'unsupported' }]
        : [{ range: '>=2.1.280', status: 'supported' }, { range: '>=2.1.111 <2.1.280', status: 'graceful' }, { range: '<2.1.111', status: 'unsupported' }],
    },
  ];
};

// `?duplicate=claude` or `?duplicate=codex` leaves an older copy of that agent from a Homebrew cask further along
// cam-mbp's PATH.
const duplicateScenario = params.get('duplicate');
if (duplicateScenario === 'claude' || duplicateScenario === 'codex') {
  const cask = duplicateScenario === 'claude' ? 'claude-code' : 'codex';
  const version = duplicateScenario === 'claude' ? '2.1.270' : '0.153.3';
  healthAgents['cam-mbp']?.[duplicateScenario]?.copies.push({
    path: `/opt/homebrew/bin/${duplicateScenario}`, real: `/opt/homebrew/Caskroom/${cask}/${version}/${duplicateScenario}`, version,
  });
}

const noAgents: MachineAgents = { claude: null, codex: null, checkedAt: null, error: null, updating: [], reporter: { installed: false, homes: [] }, t3: null, orca: null };

const agentsOf = (machine: string): MachineAgents => {
  const agents = healthAgents[machine];
  return agents ? { ...agents, reporter: reporterStatus(machine) } : noAgents;
};

// Agent updates: the versions an update brings, and when each machine's agents last changed version. By default
// Claude Code 2.1.281 reached cam-mbp and cedar-02 30 hours ago and Codex 0.156.0 reached cam-mbp 5 hours ago,
// while ci-01 still runs the older ones. With `?rollout=even` every machine is on the same versions already.
const rolloutScenario = params.get('rollout') ?? '';

const latestAgent = rolloutScenario === 'even' ? { claude: '2.1.283', codex: '0.157.0' } : { claude: '2.1.281', codex: '0.156.0' };
if (rolloutScenario === 'even') {
  for (const agents of Object.values(healthAgents)) {
    if (agents.claude) agents.claude.version = '2.1.281';
    if (agents.codex) agents.codex.version = '0.156.0';
  }
}

const agentMoves: Record<string, Partial<Record<AgentKind, { from: string; at: number }>>> = rolloutScenario === 'even' ? {} : {
  'cam-mbp': { claude: { from: '2.1.270', at: Date.now() - 30 * 3_600_000 }, codex: { from: '0.153.3', at: Date.now() - 5 * 3_600_000 } },
  'cedar-02': { claude: { from: '2.1.270', at: Date.now() - 30 * 3_600_000 } },
};

// Each machine's agents' requests by hour, as the proxy's records count them. cedar-02's key isn't assigned to it.
function mockClientVersions(fromMs: number, toMs: number): ClientVersions {
  if (rolloutScenario === 'fail') throw new Error('database is locked');
  const hour = 3_600_000;
  const hours: ClientHour[] = [];
  for (let at = Math.floor(fromMs / hour) * hour; at < Math.min(toMs, Date.now()); at += hour) {
    const index = at / hour;
    for (const [machine, agents] of Object.entries(healthAgents)) {
      for (const agent of ['claude', 'codex'] as const) {
        const install = agents[agent];
        if (!install?.version) continue;
        const move = agentMoves[machine]?.[agent];
        const version = move && at < Math.floor(move.at / hour) * hour ? move.from : install.version;
        const newest = version === latestAgent[agent] && Boolean(move);
        if (rolloutScenario === 'quiet' && machine === 'ci-01' && at >= Date.now() - 30 * hour) continue;
        const seed = (index * 7 + machine.length * 13 + (agent === 'claude' ? 0 : 5)) % 11;
        const requests = (agent === 'claude' ? 24 : 9) + seed;
        const rateLimited = rolloutScenario === 'limits' && newest ? Math.round(requests * 0.08) : seed === 3 ? 1 : 0;
        const errors = rolloutScenario === 'worse' && newest ? Math.round(requests * 0.06) : seed === 7 ? 1 : 0;
        hours.push({
          machine: machine === 'cedar-02' ? '' : machine,
          userAgent: agent === 'claude' ? `claude-cli/${version} (external, cli)` : `codex_cli_rs/${version} (Mac OS 26.0.0; arm64) iTerm.app/3.5`,
          hourMs: at,
          requests,
          failed: errors + rateLimited,
          rateLimited,
        });
      }
    }
  }
  return { hours, truncated: false };
}

// `?model=<id>` gives cam-mbp that model identifier and no product name, as an Intel Mac or one Arbor's list doesn't
// know yet would report.
const modelOverride = params.get('model');

const healthFacts = (name: string): MachineFacts =>
  name === 'cam-mbp'
    ? { hostname: 'Cams-MacBook-Pro.local', os: 'Darwin', osVersion: '27.0', arch: 'arm64', model: modelOverride ?? 'Mac16,8', productName: modelOverride === null ? 'MacBook Pro (14-inch, 2024)' : '', chip: 'Apple M4 Pro', gpu: 'Apple M4 Pro', cores: 12, memTotalKb: 67_108_864, diskTotalKb: 482_797_652, swapTotalKb: 5_242_880, gpuMemTotalMb: null, ip: '192.168.1.151', uptimeS: 820_696, batteryPct: null, batteryState: '' }
    : name === 'cedar-02'
    ? { hostname: 'cedar-02', os: 'Linux', osVersion: 'Ubuntu 26.04 LTS', arch: 'x86_64', model: 'NUC 14', productName: '', chip: 'AMD Ryzen 7 8845HS w/ Radeon 780M Graphics', gpu: 'AMD Raphael', cores: 32, memTotalKb: 29_953_392, diskTotalKb: 980_760_096, swapTotalKb: null, gpuMemTotalMb: null, ip: '192.168.1.40', uptimeS: 2_901_035, batteryPct: null, batteryState: '' }
    // `?machine=new`'s cedar-03: another NUC, set up an hour ago. Its memory and disk are what the readings above assume.
    : name === 'cedar-03'
    ? { hostname: 'cedar-03', os: 'Linux', osVersion: 'Ubuntu 26.04 LTS', arch: 'x86_64', model: 'NUC 14', productName: '', chip: 'Intel(R) Core(TM) Ultra 7 155H', gpu: 'Intel Arc Graphics', cores: 22, memTotalKb: 64_308_204, diskTotalKb: 482_797_652, swapTotalKb: 8_388_604, gpuMemTotalMb: null, ip: '192.168.1.41', uptimeS: 3_840, batteryPct: null, batteryState: '' }
    : { hostname: 'ci-01', os: 'Linux', osVersion: 'Ubuntu 26.04 LTS', arch: 'x86_64', model: 'MS-7D25', productName: '', chip: '12th Gen Intel(R) Core(TM) i9-12900K', gpu: 'NVIDIA GeForce RTX 3080', cores: 24, memTotalKb: 64_308_204, diskTotalKb: 482_797_652, swapTotalKb: 33_554_424, gpuMemTotalMb: 10_240, ip: '192.168.2.2', uptimeS: 860_270, batteryPct: null, batteryState: '' };

// `?path=direct` or `?path=peer` shows ci-01's other Tailscale paths.
const healthPath = (name: string): NetworkPath | null =>
  name === 'cedar-02'
    ? { kind: 'lan', relay: null }
    : name === 'ci-01'
    ? params.get('path') === 'direct' ? { kind: 'direct', relay: null } : { kind: 'relay', relay: params.get('path') === 'peer' ? null : 'syd' }
    : null;

const healthScenario = params.get('health');

const healthDown = healthScenario === 'down' || healthScenario === 'down-long' || healthScenario === 'hostkey' || healthScenario === 'auth';

const healthError = healthScenario === 'hostkey'
  ? 'Host key verification failed.'
  : healthScenario === 'auth'
  ? 'ci@ci-01.tailc0ffee.ts.net: Permission denied (publickey).'
  : 'ssh: connect to host ci-01 port 22: Connection refused';

/** `only` keeps the history to that machine's, as Rust does for a machine's own page. */
const machineHealthSnapshot = (since: number | null, windowMs: number, only: string | null = null): MachineHealthSnapshot => {
  const at = Date.now();
  const floor = at - Math.min(windowMs, 3_600_000);
  return {
    seq: Math.floor(at / 5_000), now: at, intervalMs: 5_000, sampledAt: at - 800, historyMs: 3_600_000,
    machines: healthHosts.filter((host) => host.enabled).map((host): MachineHealth => {
      if (!host.endpoint) return { machine: host.machine, host, local: false, status: 'unconfigured', score: null, reason: null, facts: null, latest: null, points: [], error: null, lastOkAt: null, lastAttemptAt: null, pingTarget: null, path: null, agents: noAgents };
      // `?health=pending`: the first seconds after Arbor starts, before a machine's first check has come back.
      if (healthScenario === 'pending' && host.endpoint !== 'localhost') return { machine: host.machine, host, local: false, status: 'pending', score: null, reason: null, facts: null, latest: null, points: [], error: null, lastOkAt: null, lastAttemptAt: null, pingTarget: null, path: null, agents: noAgents };
      if (host.machine === 'ci-01' && healthDown) return { machine: host.machine, host, local: false, status: 'unreachable', score: null, reason: null, facts: healthFacts(host.machine), latest: null, points: [], error: healthError, lastOkAt: at - (healthScenario === 'down-long' ? 12 * 60_000 : 90_000), lastAttemptAt: at - 800, pingTarget: 'ci-01.tailc0ffee.ts.net', path: null, agents: agentsOf(host.machine) };
      const points: HealthPoint[] = [];
      if (only === null || only === host.machine) {
        for (let t = Math.ceil(floor / 5_000) * 5_000; t <= at; t += 5_000) if (since === null || t > since) points.push(healthPoint(host.machine, t));
      }
      const latest = healthPoint(host.machine, at);
      const reason = host.machine === 'cam-mbp' ? { metric: 'disk' as const, value: latest.disk } : host.machine === 'ci-01' ? { metric: 'memory' as const, value: latest.mem } : null;
      const local = host.endpoint === 'localhost';
      return { machine: host.machine, host, local, status: latest.score >= 75 ? 'healthy' : latest.score >= 45 ? 'degraded' : 'critical', score: latest.score, reason, facts: healthFacts(host.machine), latest, points, error: null, lastOkAt: at - 800, lastAttemptAt: at - 800, pingTarget: local ? null : `${host.endpoint}.tailc0ffee.ts.net`, path: healthPath(host.machine), agents: agentsOf(host.machine) };
    }),
  };
};

// What the Add machine dialog finds in ~/.ssh and on the tailnet. ci-01 and cedar-02 are already added, so the dialog
// leaves them out; lab-box is listed without a host, so its suggestion fills one in.
const discoverScenario = params.get('discover');

const discovered = (name: string, endpoint: string, extra: Partial<DiscoveredHost> = {}): DiscoveredHost => ({
  name, endpoint, port: 22, hostName: null, user: null, addresses: [endpoint.toLowerCase(), name].filter(Boolean), sources: ['sshConfig'], os: null, online: null, ...extra,
});

const discoveredHosts = (): DiscoveredHost[] => {
  if (discoverScenario === 'none') return [];
  if (discoverScenario === 'many') {
    return Array.from({ length: 30 }, (_, index) => {
      const name = `build-${String(index + 1).padStart(2, '0')}`;
      return index % 3 === 0
        ? discovered(name, `${name}.tailc0ffee.ts.net`, { sources: ['tailscale'], os: index % 2 ? 'macOS' : 'linux', online: index % 4 !== 0 })
        : discovered(name, name, { hostName: `10.0.4.${index + 10}`, user: 'ci', sources: index % 2 ? ['sshConfig', 'knownHosts'] : ['sshConfig'] });
    });
  }
  return [
    discovered('build-arm', 'build-arm', { hostName: '10.0.4.21', user: 'ubuntu', port: 2200 }),
    discovered('ci-01', 'ci-01', { hostName: 'ci-01.tailc0ffee.ts.net', user: 'ci', sources: ['sshConfig', 'tailscale', 'knownHosts'], os: 'linux', online: true }),
    discovered('cedar-02', 'cedar-02.tailc0ffee.ts.net', { sources: ['tailscale'], os: 'linux', online: true }),
    discovered('cedar-03', 'cedar-03', { hostName: 'cedar-03.tailc0ffee.ts.net', user: 'cam', sources: ['sshConfig', 'tailscale', 'knownHosts'], os: 'linux', online: true }),
    discovered('lab-box', 'lab-box.local', { port: 2222, sources: ['knownHosts'] }),
    discovered('mac-studio', 'mac-studio.tailc0ffee.ts.net', { sources: ['tailscale'], os: 'macOS', online: false }),
    discovered('', '192.168.1.77', { addresses: ['192.168.1.77'], sources: ['knownHosts'] }),
  ];
};

// A machine added (the sidebar's +, Settings › Machines), or already there with `?machine=new`: a fresh Linux box
// with an older Claude Code and no Codex, its setup as `joinSetupMachine` has it. One just added answers a few seconds
// after it's saved.
const joinMockMachine = (name: string, arrived: boolean) => {
  if (!joinSetupMachine(name, arrived)) return;
  healthAgents[name] = { claude: mockInstall('claude', '2.1.270', '/home/cam', false), codex: null, checkedAt: Date.now(), error: null, updating: [], t3: null, orca: null };
  reporterHomes[name] = [{ agent: 'claude', home: '~/.claude', reporting: false }];
  reporterInstalled[name] = false;
};
if (params.get('machine') === 'new') {
  healthHosts.push({ machine: 'cedar-03', endpoint: 'cedar-03', port: 22, enabled: true, source: 'manual' });
  joinMockMachine('cedar-03', true);
}

// Settings › Agent homes: each machine's list of agent homes, as the first look at it filled it in, each home's role
// following what the last look guessed unless it was picked. `?homes=fresh` for no machine looked at yet, so the list is
// only the standard homes until Look again; `?homes=fail` for cedar-02's last look failing (and failing again);
// `?homes=none` for looks that found nothing more to suggest; `?homes=old` for homes saved before Arbor guessed roles,
// all active and unpicked with no guess, until Look again sorts them.
const homesScenario = params.get('homes') ?? '';

const STANDARD_HOMES: readonly (readonly [AgentHomeKind, string])[] = [
  ['claude', '$CLAUDE_CONFIG_DIR'], ['claude', '~/.claude'], ['codex', '$CODEX_HOME'], ['codex', '~/.codex'],
  ['pi', '$PI_CODING_AGENT_SESSION_DIR'], ['pi', '~/.pi/agent/sessions'], ['pi-agent', '$PI_CODING_AGENT_DIR'], ['pi-agent', '~/.pi/agent'],
  ['prime-agent', '$PRIME_AGENT_CODING_AGENT_DIR'], ['prime-agent', '~/.prime/agent'], ['opencode', '~/.config/opencode'], ['droid', '~/.factory'],
  ['amp', '~/.config/amp'],
];
/** The harness each kind of home belongs to (`AgentHomeKind::harness`). */
const HOME_HARNESS: Record<AgentHomeKind, Harness> = {
  claude: 'claude', codex: 'codex', pi: 'pi', 'claude-desktop': 'claude', 'pi-agent': 'pi', 'prime-agent': 'primeAgent', opencode: 'openCode', droid: 'droid', amp: 'amp',
};
const standardHome = (agent: AgentHomeKind, path: string) => STANDARD_HOMES.some(([kind, standard]) => kind === agent && standard === path);
const homeSyncs = (agent: AgentHomeKind) => agent !== 'pi' && agent !== 'claude-desktop';
const homeReadsSessions = (agent: AgentHomeKind) => agent === 'claude' || agent === 'codex' || agent === 'pi' || agent === 'claude-desktop';
const DESKTOP_HOMES = '~/Library/Application Support/Claude/local-agent-mode-sessions/*/*';
const savedHome = (machine: string, agent: AgentHomeKind, path: string, sync: boolean, chosen = false): AgentHome =>
  ({ machine, agent, path, source: 'found', sessions: true, sync: homesScenario === 'old' ? homeSyncs(agent) : sync, chosen, guess: null });

// What the last look made of each home and suggestion, by machine, then agent and folder.
const homeGuesses: Record<string, Record<string, HomeGuess>> = {
  'cam-mbp': {
    'claude ~/.agent-app/homes/*': { role: 'active', reason: 'recent' },
    'codex ~/.agent-app/homes/*': { role: 'active', reason: 'recent' },
    [`claude-desktop ${DESKTOP_HOMES}`]: { role: 'history', reason: 'idle' },
    [`claude ${DESKTOP_HOMES}/local_*/.claude`]: { role: 'history', reason: 'sessionCopy' },
    'claude ~/.agent-tool/workspace': { role: 'history', reason: 'idle' },
    'claude ~/Library/Application Support/AcmeCode/claude': { role: 'history', reason: 'idle' },
  },
  'cedar-02': {
    'claude ~/.agent-tool/profiles/*': { role: 'active', reason: 'recent' },
    'codex ~/sandbox/*/.codex': { role: 'history', reason: 'sessionCopy' },
  },
};
const guessFor = (machine: string, agent: AgentHomeKind, path: string): HomeGuess | null =>
  homesScenario === 'old' && !homesLookedAgain.has(machine) ? null : homeGuesses[machine]?.[`${agent} ${path}`] ?? null;
// Machines looked at again since the page opened, which sorts `?homes=old`'s homes.
const homesLookedAgain = new Set<string>();

// What each machine's first look found, which it added to the list, and what it found beside that.
const firstLooks: Record<string, { homes: AgentHome[]; suggested: FoundHome[] }> = {
  'cam-mbp': {
    homes: [
      savedHome('cam-mbp', 'claude', '~/.agent-app/homes/*', true),
      savedHome('cam-mbp', 'codex', '~/.agent-app/homes/*', true),
      savedHome('cam-mbp', 'claude-desktop', DESKTOP_HOMES, false),
      savedHome('cam-mbp', 'claude', `${DESKTOP_HOMES}/local_*/.claude`, false),
      // Kept active by hand, though nothing ran there lately.
      savedHome('cam-mbp', 'claude', '~/.agent-tool/workspace', true, true),
    ],
    suggested: [{ agent: 'claude', path: '~/Library/Application Support/AcmeCode/claude', folders: 1, guess: null }],
  },
  'cedar-02': {
    homes: [savedHome('cedar-02', 'claude', '~/.agent-tool/profiles/*', true)],
    suggested: [{ agent: 'codex', path: '~/sandbox/*/.codex', folders: 3, guess: null }],
  },
  'ci-01': { homes: [], suggested: [] },
};
const lookedHomes = (machine: string) => firstLooks[machine] ?? { homes: [], suggested: [] };

const homeScans: Record<string, { at: number; error: string | null; suggested: FoundHome[] }> = {};
let savedHomes: AgentHome[] = [];
if (homesScenario !== 'fresh' && !freshInstall) {
  for (const [machine, looked] of Object.entries(firstLooks)) {
    savedHomes.push(...looked.homes);
    homeScans[machine] = { at: now - 2 * 86_400_000, error: null, suggested: homesScenario === 'none' ? [] : looked.suggested };
  }
  // One added by hand for every machine, and a standard home switched off on one machine.
  savedHomes.push({ machine: '', agent: 'codex', path: '/srv/agents/codex', source: 'added', sessions: true, sync: true, chosen: true, guess: null });
  savedHomes.push({ machine: 'ci-01', agent: 'pi', path: '~/.pi/agent/sessions', source: 'standard', sessions: false, sync: false, chosen: true, guess: null });
  if (homesScenario === 'fail') homeScans['cedar-02'] = { ...homeScans['cedar-02']!, at: now - 40 * 60_000, error: 'ssh: connect to host cedar-02 port 22: Operation timed out' };
}

/** The machines homes are listed for: those scripts run on. */
const homeMachines = () => healthHosts.filter((host) => host.enabled && host.endpoint.trim()).map((host) => host.machine);

/** A machine's homes as its scripts read them: the standard ones, then every machine's, then its own, each taking the place of the same home before it. */
function homesOn(machine: string): AgentHome[] {
  const homes: AgentHome[] = STANDARD_HOMES.map(([agent, path]) => ({ machine: '', agent, path, source: 'standard', sessions: homeReadsSessions(agent), sync: homeSyncs(agent), chosen: true, guess: null }));
  for (const scope of machine ? ['', machine] : ['']) {
    for (const home of savedHomes.filter((entry) => entry.machine === scope)) {
      const at = homes.findIndex((listed) => listed.agent === home.agent && listed.path === home.path);
      if (at >= 0) homes[at] = { ...homes[at]!, machine: home.machine, sessions: home.sessions, sync: home.sync, chosen: home.chosen };
      else homes.push({ ...home, guess: home.machine && home.source !== 'standard' ? guessFor(home.machine, home.agent, home.path) : null });
    }
  }
  return homes;
}

/** The harness catalog as the native side lists it (`harnesses.rs`), before what the scans found. */
const HARNESSES: Omit<HarnessInfo, 'found' | 'foundOn'>[] = [
  { harness: 'claude', binary: 'claude', home: '~/.claude', homeEnv: '$CLAUDE_CONFIG_DIR', sessions: '~/.claude', globalInstructions: '~/.claude/CLAUDE.md', projectInstructions: ['CLAUDE.md', '.claude/CLAUDE.md'], skills: ['~/.claude/skills'], mcp: '~/.claude.json', mcpKey: 'mcpServers', mcpFormat: 'json', sync: true, automations: true, limitsEdits: true },
  { harness: 'codex', binary: 'codex', home: '~/.codex', homeEnv: '$CODEX_HOME', sessions: '~/.codex', globalInstructions: '~/.codex/AGENTS.md', projectInstructions: ['AGENTS.md'], skills: ['~/.agents/skills', '~/.codex/skills'], mcp: '~/.codex/config.toml', mcpKey: 'mcp_servers', mcpFormat: 'toml', sync: true, automations: true, limitsEdits: true },
  { harness: 'pi', binary: 'pi', home: '~/.pi/agent', homeEnv: '$PI_CODING_AGENT_DIR', sessions: '~/.pi/agent/sessions', globalInstructions: '~/.pi/agent/AGENTS.md', projectInstructions: ['AGENTS.md', 'CLAUDE.md'], skills: ['~/.pi/agent/skills', '~/.agents/skills'], mcp: '~/.pi/agent/mcp.json', mcpKey: 'mcpServers', mcpFormat: 'json', sync: true, automations: true, limitsEdits: false },
  { harness: 'primeAgent', binary: 'prime-agent', home: '~/.prime/agent', homeEnv: '$PRIME_AGENT_CODING_AGENT_DIR', globalInstructions: '~/.prime/agent/AGENTS.md', projectInstructions: ['AGENTS.md', 'CLAUDE.md'], skills: ['~/.prime/agent/skills', '~/.agents/skills'], mcp: '~/.prime/agent/settings.json', mcpKey: 'mcpServers', mcpFormat: 'json', sync: true, automations: true, limitsEdits: false },
  { harness: 'openCode', binary: 'opencode', home: '~/.config/opencode', globalInstructions: '~/.config/opencode/AGENTS.md', projectInstructions: ['AGENTS.md', 'CLAUDE.md'], skills: ['~/.config/opencode/skills', '~/.claude/skills', '~/.agents/skills'], mcp: '~/.config/opencode/opencode.json', mcpKey: 'mcp', mcpFormat: 'json', sync: true, automations: false, limitsEdits: false },
  { harness: 'droid', binary: 'droid', home: '~/.factory', globalInstructions: '~/.factory/AGENTS.md', projectInstructions: ['AGENTS.md', 'CLAUDE.md'], skills: ['~/.factory/skills', '~/.agents/skills'], mcp: '~/.factory/mcp.json', mcpKey: 'mcpServers', mcpFormat: 'json', sync: true, automations: true, limitsEdits: true },
  { harness: 'amp', binary: 'amp', home: '~/.config/amp', globalInstructions: '~/.config/amp/AGENTS.md', projectInstructions: ['AGENTS.md', 'AGENT.md', 'CLAUDE.md'], skills: ['~/.config/amp/skills', '~/.config/agents/skills', '~/.agents/skills', '~/.claude/skills'], mcp: '~/.config/amp/settings.json', mcpKey: 'amp.mcpServers', mcpFormat: 'json', sync: true, automations: false, limitsEdits: false },
  { harness: 'gemini', binary: 'gemini', home: '~/.gemini', projectInstructions: [], skills: [], sync: false, automations: false, limitsEdits: false },
];

/** Claude Code and Codex always count as found; any other once a machine's last scan found it (`harnesses::is_found`). */
const harnessFound = (harness: Harness, foundOn: Partial<Record<Harness, string[]>>) =>
  harness === 'claude' || harness === 'codex' || (foundOn[harness]?.length ?? 0) > 0;

const agentHomesView = (): AgentHomesView => {
  const foundOn = mockHarnessesFound();
  const savedEverywhere = (home: AgentHome) => savedHomes.some((saved) => saved.machine === '' && saved.agent === home.agent && saved.path === home.path);
  return {
    harnesses: HARNESSES.map((info) => ({ ...info, found: harnessFound(info.harness, foundOn), foundOn: foundOn[info.harness] ?? [] })),
    // A harness no machine has keeps its standard homes out of sight until one does, unless one was saved for every machine.
    everywhere: homesOn('').filter((home) => home.source !== 'standard' || harnessFound(HOME_HARNESS[home.agent], foundOn) || savedEverywhere(home)),
    machines: homeMachines().map((machine) => {
      const scan = homeScans[machine];
      const homes = homesOn(machine);
      return {
        machine,
        homes,
        scannedAtMs: scan?.at ?? null,
        error: scan?.error ?? null,
        suggested: (scan?.suggested ?? [])
          .filter((found) => !homes.some((home) => home.agent === found.agent && home.path === found.path))
          .map((found) => ({ ...found, guess: guessFor(machine, found.agent, found.path) })),
      };
    }),
  };
};

/** A look at one machine: the first fills its list, and each keeps what it found beside it. */
function lookForHomes(machine: string) {
  if (homesScenario === 'fail' && machine === 'cedar-02') {
    homeScans[machine] = { at: Date.now(), error: 'ssh: connect to host cedar-02 port 22: Operation timed out', suggested: homeScans[machine]?.suggested ?? [] };
    return;
  }
  const looked = lookedHomes(machine);
  if (!homeScans[machine] || homeScans[machine]!.error === null && !savedHomes.some((home) => home.machine === machine)) {
    for (const home of looked.homes) if (!savedHomes.some((saved) => saved.machine === home.machine && saved.agent === home.agent && saved.path === home.path)) savedHomes.push(home);
  }
  homeScans[machine] = { at: Date.now(), error: null, suggested: homesScenario === 'none' ? [] : looked.suggested };
  // Each look sets the homes nobody picked a role for to what it guesses.
  homesLookedAgain.add(machine);
  savedHomes = savedHomes.map((home) => {
    const guess = home.machine === machine && home.source !== 'standard' && !home.chosen ? guessFor(machine, home.agent, home.path) : null;
    return guess ? { ...home, sessions: guess.role !== 'ignored' && homeReadsSessions(home.agent), sync: guess.role === 'active' && homeSyncs(home.agent) } : home;
  });
}

/** The machines: their health, agents, reporters and telemetry. */
export const machinesAnswers: CommandAnswers<MachineCommands> = {
  get_machine_health: (args) => {
    if (args.passive) mockLog('get_machine_health', { passive: true });
    // `?health=fail` fails every read of the machines' health, `failafter` each from ten seconds after load (so what
    // was read first stays up, saying so), and `slow` has each take four seconds.
    if (healthScenario === 'fail' || (healthScenario === 'failafter' && Date.now() - now > 10_000)) {
      return Promise.reject('database is locked');
    }
    const snapshot = () => machineHealthSnapshot(args.since ?? null, args.windowMs ?? 3_600_000, args.machine ?? null);
    return healthScenario === 'slow' ? later(4_000, snapshot) : snapshot();
  },
  get_machine_hosts: () => healthHosts,
  get_machine_probes: () => machineProbes(),
  // A machine's history beyond the hour, as Grove keeps it: two hundred buckets, cam-mbp asleep from midnight to 7am.
  // `?history=empty` has nothing stored yet; with `?grove=missing` it can't be read.
  get_machine_history: ({ machine, windowMs }) => {
    if (params.get('grove') === 'missing') throw 'Grove answered as 0.1.1 where this build of Arbor expects 0.1.2';
    const buckets = 200;
    const bucketMs = Math.max(60_000, Math.round(windowMs / buckets));
    const since = Date.now() - buckets * bucketMs;
    const empty = params.get('history') === 'empty';
    const points = Array.from({ length: buckets }, (_, index) => {
      const t = since + (index + 0.5) * bucketMs;
      const asleep = machine === MOCK_THIS_MAC && new Date(t).getHours() < 7;
      return empty || asleep ? null : healthPoint(machine, t);
    });
    const pick = (read: (point: HealthPoint) => number | null) => points.map((point) => (point ? read(point) : null));
    const history: MachineHistory = {
      machine, since, bucketMs, samples: empty ? 0 : points.filter(Boolean).length * Math.max(1, Math.round(bucketMs / 60_000)),
      cpu: pick((point) => point.cpu), mem: pick((point) => point.mem), disk: pick((point) => point.disk), swap: pick((point) => point.swap),
      load1: pick((point) => point.load1), cpuTemp: pick((point) => point.cpuTemp), gpuTemp: pick((point) => point.gpuTemp),
      rxBps: pick((point) => point.rxBps), txBps: pick((point) => point.txBps),
      agents: pick((point) => (point.claudeRunning ?? 0) + (point.codexRunning ?? 0)),
    };
    return history;
  },
  install_machine_probe: ({ machine }) => later(2_000, () => {
    mockLog('install_machine_probe', { machine });
    if (probeScenario === 'fail') throw 'ssh: connect to host ' + machine + ' port 22: Operation timed out';
    probesInstalled.add(machine);
    return machineProbes();
  }),
  uninstall_machine_probe: ({ machine }) => later(1_200, () => {
    mockLog('uninstall_machine_probe', { machine });
    if (probeScenario === 'fail') throw 'Removing the probe from "' + machine + '" failed: launchctl exited 5.';
    probesInstalled.delete(machine);
    return machineProbes();
  }),
  get_this_mac: () => {
    const listed = healthHosts.find((host) => host.endpoint === 'localhost');
    return { name: listed?.machine ?? MOCK_THIS_MAC, listed: Boolean(listed) };
  },
  ...poolAnswers(() => machineHealthSnapshot(null, 60_000)),
  ...poolSshAnswers(),
  ...runAnswers(() => machineHealthSnapshot(null, 60_000)),
  get_agent_homes: () => agentHomesView(),
  save_agent_home: ({ home }) => {
    mockLog('save_agent_home', home);
    const problem = homePathProblem(home.path);
    if (!standardHome(home.agent, home.path) && problem) throw new Error('A home’s folder starts with ~/ or /');
    const path = home.path.trim().replace(/\/+$/, '');
    const standard = standardHome(home.agent, path);
    const saved: AgentHome = {
      ...home,
      path,
      source: standard ? 'standard' : home.source === 'standard' ? 'added' : home.source,
      sessions: home.sessions && homeReadsSessions(home.agent),
      sync: home.sync && homeSyncs(home.agent),
      chosen: home.chosen || standard,
      guess: null,
    };
    savedHomes = [...savedHomes.filter((entry) => !(entry.machine === saved.machine && entry.agent === saved.agent && entry.path === saved.path)), saved];
    return agentHomesView();
  },
  remove_agent_home: ({ machine, agent, path }) => {
    mockLog('remove_agent_home', { machine, agent, path });
    savedHomes = savedHomes.filter((entry) => !(entry.machine === machine && entry.agent === agent && entry.path === path));
    return agentHomesView();
  },
  scan_agent_homes: ({ machine }) => later(1_500, () => {
    mockLog('scan_agent_homes', { machine });
    for (const name of machine ? [machine] : homeMachines()) lookForHomes(name);
    void emit('agent-homes-updated', Date.now());
    return agentHomesView();
  }),
  preview_agent_home: ({ machine, agent, path }) => later(600, () => {
    mockLog('preview_agent_home', { machine, agent, path });
    if (path.includes('missing')) return [];
    if (!path.includes('*')) return [path.trim()];
    return [`${agent}-proxy`, `${agent}-work`].map((name) => path.trim().replace('*', name).split('*').join('local_1'));
  }),
  // npm's latest is what an update brings; `?npm=fail` is npm not answering, which the pages treat as unknown.
  get_t3_compatibility: () => mockT3Policies(),
  get_agent_latest_versions: () => params.get('npm') === 'fail' ? { claude: null, codex: null } : { ...latestAgent },
  update_machine_agent: ({ machine, agent, command }) => {
    const agents = healthAgents[machine];
    const install = agents?.[agent];
    mockLog('update_machine_agent', { machine, agent, command });
    if (!agents || !install) throw new Error(`Arbor isn't checking a machine called ${machine}`);
    if (command && command !== install.updateCommand) {
      throw new Error(`${agent === 'claude' ? 'Claude Code' : 'Codex'} on ${machine} now updates with ${install.updateCommand} instead. Look at it again, then update.`);
    }
    agents.updating = [...agents.updating, agent];
    const before = install.version;
    return new Promise<AgentUpdate>((resolve, reject) => window.setTimeout(() => {
      agents.updating = agents.updating.filter((entry) => entry !== agent);
      if (params.get('agents') === 'fail') {
        reject(`Current version: ${before}\nError: EACCES: permission denied, mkdir /usr/local/share/${agent}`);
        return;
      }
      const after = latestAgent[agent];
      if (before && before !== after) agentMoves[machine] = { ...agentMoves[machine], [agent]: { from: before, at: Date.now() } };
      install.version = after;
      agents.checkedAt = Date.now();
      // The new version is what the machine's next setup scan finds, as the real one's does.
      const scanned = setupMachines.find((entry) => entry.machine === machine)?.installs.find((found) => found.agent === agent);
      if (scanned) scanned.version = after;
      resolve({ before, after, output: before === after ? `${agent} is up to date (${after})` : `Current version: ${before}\nUpdating to ${after}…\nSuccessfully updated from ${before} to version ${after}` });
    }, 1_500));
  },
  // Another agent's own update: `?harnessupdate=fail` has it refuse, as an agent without the command does.
  update_machine_harness: ({ machine, harness, command }) => later(1_500, () => {
    mockLog('update_machine_harness', { machine, harness, command });
    if (params.get('harnessupdate') === 'fail') throw new Error(`This version of ${command.split(' ')[0]} has no ${command.split(' ')[1]} command. Update it the way it was installed.`);
    const install = setupMachines.find((entry) => entry.machine === machine)?.harnessInstalls.find((found) => found.harness === harness);
    if (!install) throw new Error(`${command.split(' ')[0]} is not installed where Arbor looks for it`);
    const before = install.version;
    const after = before?.replace(/(\d+)$/, (last) => String(Number(last) + 1)) ?? null;
    install.version = after;
    return { before, after, output: `Updated from ${before} to ${after}` };
  }),
  // `?fix=fail` is Terminal not opening, which the Fix menu says in a toast.
  open_fix_session: ({ machine, agent, onMachine, prompt }) => later(300, () => {
    mockLog('open_fix_session', { machine, agent, onMachine, prompt });
    if (params.get('fix') === 'fail') throw 'Couldn’t open Terminal: The application can’t be opened.';
  }),
  discover_machine_hosts: () => {
    return new Promise<DiscoveredHost[]>((resolve, reject) => window.setTimeout(() => {
      if (discoverScenario === 'fail') reject('Couldn’t read /Users/cam/.ssh/config: Permission denied (os error 13)');
      else resolve(discoveredHosts());
    }, 700));
  },
  save_machine_hosts: (args) => {
    for (const machine of args.removed ?? []) {
      const index = healthHosts.findIndex((host) => host.machine === machine);
      if (index < 0) throw new Error(`No machine called ${machine} is on the list`);
      healthHosts.splice(index, 1);
    }
    // Each host is added or updated by name, as the real list does; hosts not sent are left alone.
    for (const host of args.hosts) {
      const saved = { ...host, machine: host.machine.trim(), endpoint: host.endpoint.trim(), source: 'manual' };
      const index = healthHosts.findIndex((entry) => entry.machine === saved.machine);
      if (index >= 0) healthHosts[index] = saved;
      else healthHosts.push(saved);
      if (saved.enabled && saved.endpoint && saved.endpoint !== 'localhost') joinMockMachine(saved.machine, false);
    }
    // A new list, as the native side sends, so the page sees the change.
    return [...healthHosts];
  },
  set_t3_threads_enabled: (args) => {
    setMockT3Enabled(args.enabled);
    mockLog('t3_threads_enabled', args.enabled);
    return null;
  },
  set_t3_thread_titles: ({ enabled }) => {
    setMockT3Titles(enabled);
    mockLog('set_t3_thread_titles', enabled);
    return null;
  },
  set_agent_reporter: ({ machine, enabled, plan: planOnly }) => {
    mockLog('set_agent_reporter', { machine, enabled, plan: planOnly });
    if (!reporterHomes[machine]) throw new Error(`Arbor isn't checking a machine called ${machine}`);
    const plan = reporterPlan(machine, enabled);
    if (planOnly) return plan;
    return later(1_200, (): ReporterSetup => {
      const failing = params.get('reporter') === 'fail';
      const files = plan.files.map((file, index) => failing && index === 0
        ? { ...file, error: 'It changed while Arbor was editing it. Try again.' }
        : { ...file, written: file.change !== 'none' });
      if (!failing) {
        reporterInstalled[machine] = enabled;
        reporterHomes[machine] = reporterHomes[machine]!.map((home) => ({ ...home, reporting: enabled }));
      }
      recordEditMock(machine, 'reporter', files.filter((file) => file.written).map((file) => ({ path: file.path, added: file.change === 'create' })));
      return { files, reporterChanged: !failing };
    });
  },
  get_client_versions: (args) => mockClientVersions(args.fromMs, args.toMs),
  get_agent_telemetry: () => telemetryStatus(),
  set_agent_telemetry: ({ enabled, port }) => {
    mockLog('set_agent_telemetry', { enabled, port });
    if (port < 1024) throw 'Pick a port from 1024 up';
    if (port === Number(configSettings.port)) throw 'That’s the proxy’s port. Pick another';
    telemetryState.enabled = enabled;
    telemetryState.port = port;
    void emit('agent-telemetry-updated', Date.now());
    return telemetryStatus();
  },
  set_machine_telemetry: ({ machine, enabled, plan: planOnly }) => {
    mockLog('set_machine_telemetry', { machine, enabled, plan: Boolean(planOnly) });
    const entry = setupMachines.find((candidate) => candidate.machine === machine);
    if (!entry) throw `Arbor isn't checking a machine called ${machine}`;
    const on = telemetryState.machines.some((candidate) => candidate.machine === machine);
    if (enabled) {
      leaveToPolicy(entry, 'env', [
        'CLAUDE_CODE_ENABLE_TELEMETRY', 'OTEL_METRICS_EXPORTER', 'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
        'OTEL_EXPORTER_OTLP_METRICS_HEADERS', 'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE', 'OTEL_METRICS_INCLUDE_VERSION',
      ]);
    }
    if (enabled && !entry.local && telemetryScenario === 'local') {
      throw 'Arbor only listens on this Mac, so another machine can’t send to it. Set Custom Listen IP to 0.0.0.0 in Settings › Network first.';
    }
    const endpoint = `http://${entry.local ? '127.0.0.1' : '192.168.1.151'}:${telemetryState.port}/v1/metrics`;
    const files = entry.homes.filter((home) => home.agent === 'claude').map((home): SettingsEdit => ({
      home: home.path,
      path: `${home.path}/settings.json`,
      change: !enabled && !on ? 'none' : enabled && !on && home.path.includes('claude-other') ? 'create' : 'edit',
      written: false,
      error: null,
    }));
    const plan: TelemetrySetup = { endpoints: enabled ? [endpoint] : [], files };
    if (planOnly) return plan;
    return later(900, (): TelemetrySetup => {
      const failing = telemetryScenario === 'fail';
      const done = files.map((file, index) => failing && index === 0
        ? { ...file, error: 'It changed while Arbor was editing it. Try again.' }
        : { ...file, written: file.change !== 'none' });
      if (done.some((file) => file.written)) {
        telemetryState.machines = telemetryState.machines.filter((candidate) => candidate.machine !== machine);
        if (enabled) telemetryState.machines.push({ machine, sinceMs: Date.now(), lastMs: null, requests: 0, cumulative: false, port: telemetryState.port });
      }
      recordEditMock(machine, 'telemetry', done.filter((file) => file.written).map((file) => ({ path: file.path, added: file.change === 'create' })));
      void emit('agent-telemetry-updated', Date.now());
      return { ...plan, files: done };
    });
  },
  get_agent_telemetry_breakdown: (args) => {
    // Sync › Cost's Claude Code part saying it couldn't read the spend; see `?costspend=` in the header.
    if (params.get('costspend') === 'fail') throw 'Failed to read Claude Code telemetry: database is locked';
    return mockTelemetryBreakdown(args.fromMs, args.toMs, args.machine ?? null);
  },
  get_call_diagnostics: () => {
    if (diagnosticsScenario === 'error') throw 'Failed to read diagnostics: database is locked';
    const shown = diagnosticsCalls.filter((call) => diagnosticsClearedAt === null || call.atMs > diagnosticsClearedAt);
    return later(250, (): CallDiagnostics => ({ calls: shown, keepDays: 7, maxCalls: 2_000, machineSlowMs: 10_000, coreSlowMs: 3_000, clearedAtMs: diagnosticsClearedAt }));
  },
  clear_call_diagnostics: () => {
    // Like the app: only the latest Clear can be undone, so what an earlier one hid goes now.
    const previous = diagnosticsClearedAt;
    if (previous !== null) diagnosticsCalls = diagnosticsCalls.filter((call) => call.atMs > previous);
    const clearedAtMs = Date.now();
    const count = diagnosticsCalls.filter((call) => call.atMs <= clearedAtMs).length;
    diagnosticsClearedAt = clearedAtMs;
    mockLog('clear_call_diagnostics', { count });
    return { count, clearedAtMs, previousClearedAtMs: previous };
  },
  undo_clear_call_diagnostics: (args) => {
    if (args.clearedAtMs !== diagnosticsClearedAt) throw 'These calls were cleared again since, so they can’t be brought back';
    diagnosticsClearedAt = args.previousClearedAtMs ?? null;
    mockLog('undo_clear_call_diagnostics', args);
    return null;
  },
  keep_claude_sessions: ({ machine, homes }) => {
    mockLog('keep_claude_sessions', { machine, homes });
    const entry = setupMachines.find((candidate) => candidate.machine === machine);
    if (!entry) throw `Arbor isn't checking a machine called ${machine}`;
    leaveToPolicy(entry, 'setting', ['cleanupPeriodDays']);
    return later(900, () => {
      const edits = homes.map((path): SettingsEdit => {
        const home = entry.homes.find((candidate) => candidate.agent === 'claude' && candidate.path === path);
        if (!home) throw `Arbor hasn't found a Claude Code home at ${path} on ${machine}`;
        if (params.get('keep') === 'fail') {
          return { home: path, path: `${path}/settings.json`, change: 'none', written: false, error: 'It changed while Arbor was editing it. Try again.' };
        }
        const change = home.items.some((item) => item.kind === 'setting') ? 'edit' : 'create';
        home.items = [...home.items.filter((item) => !(item.kind === 'setting' && item.name === 'cleanupPeriodDays')), setupItem('setting', 'cleanupPeriodDays', 's6', { value: '36500' })];
        return { home: path, path: `${path}/settings.json`, change, written: true, error: null };
      });
      recordEditMock(machine, 'keepSessions', edits.filter((edit) => edit.written).map((edit) => ({ path: edit.path, added: edit.change === 'create' })));
      scanSetupMock(machine, false);
      return edits;
    });
  },
};

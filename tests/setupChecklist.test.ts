import { describe, expect, it } from 'bun:test';
import {
  agentsStep, alertsStep, checklistProgress, checklistReference, checksStep, cloneCommand, connectStep, firstOpen,
  installCommand, mcpStep, waitsForHost, missingProxySettings, pluginsStep, projectsStep, proxyStep, repoStep, settingsStep, shellPath, skillsStep, toolsStep,
  PROXY_WINDOW_MS, type KeyAssignment, type MachineRequests,
} from '../src/services/setupChecklist';
import { extensionsView } from '../src/services/setupPlugins';
import { withRegistry } from '../src/services/setupMcp';
import { itemAt } from './support/items';
import type {
  MachineHealth,
  MachineProjects,
  MachineToolchain,
  McpRegistry,
  ProjectRepo,
  ProjectToolchain,
  RegistryCell,
  SetupHome,
  SetupInstall,
  SetupItem,
  SetupMachine,
  SetupRepo,
  ToolFound,
} from '../src/native/types';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const item = (kind: SetupItem['kind'], name: string, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind, name, path: null, sum: `${kind}:${name}`, size: null, link: null, value: null, note: null, count: null, enabled: null,
  text: false, skill: null, import: null, ...fields,
});
const skillFacts = { files: 2, hasDoc: true, declaredName: null, descriptionChars: 80, whenToUseChars: 0, manualOnly: false, source: null };
const skill = (home: string, name: string, sum: string, fields: Partial<SetupItem> = {}) =>
  item('skill', name, { path: `${home}/skills/${name}`, sum, skill: skillFacts, ...fields });
const home = (agent: SetupHome['agent'], path: string, items: SetupItem[]): SetupHome => ({ agent, path, items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null });
const install = (agent: SetupInstall['agent'], version: string | null, real: string | null = null): SetupInstall => ({
  agent, path: `~/.local/bin/${agent}`, real, version,
});
const machine = (name: string, homes: SetupHome[], fields: Partial<SetupMachine> = {}): SetupMachine => ({
  machine: name, local: false, reachable: true, homes, harnessHomes: [], harnessInstalls: [], installs: [], policy: null, scannedAt: NOW, error: null, scanning: false, ...fields,
});

const reference = machine('mbp', [
  home('claude', '~/.claude', [
    item('instructions', 'CLAUDE.md', { path: '~/.claude/CLAUDE.md', sum: 'c1', text: true }),
    skill('~/.claude', 'pdf', 'k1', { link: '~/.agents/skills/pdf' }),
    skill('~/.claude', 'harness', 'h1', { link: '~/Developer/harness' }),
    item('plugin', 'context7@official', { value: '1.2.0', enabled: true }),
    item('plugin', 'review@official', { value: '2.0.0', enabled: true }),
    item('plugin', 'local-tool@local', { value: '0.1.0', enabled: true }),
    item('marketplace', 'official', { note: 'anthropics/claude-plugins-official', value: ago(3_600_000) }),
    item('setting', 'model', { value: 'opus', sum: 's-opus' }),
    item('setting', 'effortLevel', { value: 'high' }),
    item('env', 'ANTHROPIC_BASE_URL', { sum: 'e1' }),
    item('hook', 'Stop', { count: 1 }),
  ]),
  home('codex', '~/.codex', [item('setting', 'model_providers.arbor', { count: 4 }), item('setting', 'model', { value: 'gpt-5.5' })]),
  home('shared', '~/.agents', [skill('~/.agents', 'pdf', 'k1'), skill('~/.agents', 'design', 'd1')]),
], {
  local: true,
  installs: [
    install('claude', '2.1.281', '~/.local/share/claude/versions/2.1.281'),
    install('codex', '0.156.0', '/opt/homebrew/Caskroom/codex/0.156.0/codex'),
  ],
});

const fresh = machine('cedar-03', [
  home('claude', '~/.claude', [
    item('plugin', 'review@official', { value: '2.0.0', enabled: false }),
    item('setting', 'model', { value: 'sonnet', sum: 's-sonnet' }),
  ]),
  home('shared', '~/.agents', [skill('~/.agents', 'pdf', 'k1')]),
], { installs: [install('claude', '2.1.270')] });

describe('which machines the checklist compares', () => {
  const machines = [reference, fresh, machine('ci', [])];

  it('never compares a machine with itself', () => {
    expect(checklistReference(machines, 'cedar-03', 'ci')).toBe('ci');
    expect(checklistReference(machines, 'cedar-03', 'cedar-03')).toBe('mbp');
    expect(checklistReference(machines, 'mbp', null)).toBe('cedar-03');
    expect(checklistReference([reference], 'mbp', null)).toBeNull();
  });
});

describe('connecting', () => {
  const health = (error: string | null) => ({ error }) as MachineHealth;

  it('waits for a machine that hasn’t answered yet, and says why one is down', () => {
    expect(connectStep({ ...fresh, reachable: false }, null)).toMatchObject({ state: 'waiting', why: 'connecting' });
    // Arbor's own reading of health failing isn't the machine not answering.
    expect(connectStep({ ...fresh, reachable: false }, null, true)).toMatchObject({ state: 'waiting', why: 'healthUnread' });
    expect(connectStep({ ...fresh, reachable: false }, health('Permission denied (publickey).'))).toEqual({
      state: 'todo', why: 'down', error: 'Permission denied (publickey).',
    });
    // One with no host isn't waited on: it needs one first.
    expect(connectStep({ ...fresh, reachable: false }, { status: 'unconfigured', error: null } as MachineHealth)).toEqual({ state: 'todo', why: 'noHost', error: null });
  });

  it('has the steps that wait on a machine with no host wait for the host, not a read', () => {
    const noHost = connectStep({ ...fresh, reachable: false }, { status: 'unconfigured', error: null } as MachineHealth);
    const connecting = connectStep({ ...fresh, reachable: false }, null);
    expect(waitsForHost(noHost, { state: 'waiting' })).toBe(true);
    // A step with something to do or done stays as it is, and one waiting on a machine that has a host waits on it.
    expect(waitsForHost(noHost, { state: 'todo' })).toBe(false);
    expect(waitsForHost(connecting, { state: 'waiting' })).toBe(false);
  });

  it('waits for the first read, then reports one that failed', () => {
    expect(connectStep({ ...fresh, scannedAt: null, scanning: true }, null).why).toBe('reading');
    expect(connectStep({ ...fresh, scannedAt: null }, null).why).toBe('notRead');
    expect(connectStep({ ...fresh, error: 'timed out' }, null)).toMatchObject({ state: 'todo', why: 'scanFailed' });
    expect(connectStep(fresh, null).state).toBe('done');
  });
});

describe('agents', () => {
  it('installs each agent the way another machine did', () => {
    expect(installCommand('claude', install('claude', '1', '~/.local/share/claude/versions/1'), 'Darwin')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(installCommand('claude', install('claude', '1', '/opt/homebrew/Caskroom/claude-code/1/claude'), 'Darwin')).toBe('brew install --cask claude-code');
    // Claude Code's npm package is deprecated, so npm installs still get the installer.
    expect(installCommand('claude', install('claude', '1', '~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js'), 'Linux')).toContain('claude.ai/install.sh');
    expect(installCommand('codex', install('codex', '1', '~/.npm-global/lib/node_modules/@openai/codex/bin/codex.js'), 'Linux')).toBe('npm install -g @openai/codex');
    expect(installCommand('codex', install('codex', '1', '/opt/homebrew/Caskroom/codex/1/codex'), 'Darwin')).toBe('brew install --cask codex');
    expect(installCommand('codex', null, 'Darwin')).toBe('curl -fsSL https://chatgpt.com/codex/install.sh | sh');
  });

  it('only suggests a cask for a Mac', () => {
    const cask = install('codex', '1', '/opt/homebrew/Caskroom/codex/1/codex');
    expect(installCommand('codex', cask, 'Linux')).toBe('curl -fsSL https://chatgpt.com/codex/install.sh | sh');
    expect(installCommand('codex', cask, null)).toBe('curl -fsSL https://chatgpt.com/codex/install.sh | sh');
  });

  it('finds one missing, one behind, and one that hasn’t made its home', () => {
    const step = agentsStep(fresh, [reference, fresh], reference, 'Darwin');
    expect(step.state).toBe('todo');
    const [claude, codex] = step.agents;
    expect(claude).toMatchObject({ state: 'behind', newest: { version: '2.1.281', machine: 'mbp' } });
    expect(codex).toMatchObject({ state: 'missing', command: 'brew install --cask codex' });
    const noHome = agentsStep({ ...fresh, homes: [], installs: [install('claude', '2.1.281')] }, [reference], reference, 'Darwin');
    expect(itemAt(noHome.agents, 0).state).toBe('noHome');
  });

  it('holds each agent to its latest release once npm has said, even with every machine agreeing', () => {
    const same = { ...fresh, installs: [install('claude', '2.1.281')] };
    const noCodex = { ...reference, installs: [install('claude', '2.1.281')] };
    const step = agentsStep(same, [noCodex, same], noCodex, 'Linux', { claude: '2.1.283', codex: '0.157.0' });
    expect(itemAt(step.agents, 0)).toMatchObject({ state: 'behind', newest: { version: '2.1.283', machine: null } });
    expect(step.state).toBe('todo');
    // A machine on the release, or ahead of it, is fine; an unknown release leaves the fleet to compare with.
    expect(itemAt(agentsStep(same, [noCodex, same], noCodex, 'Linux', { claude: '2.1.281', codex: null }).agents, 0).state).toBe('ok');
    expect(itemAt(agentsStep(same, [noCodex, same], noCodex, 'Linux', { claude: '2.1.280', codex: null }).agents, 0).state).toBe('ok');
    expect(itemAt(agentsStep(same, [noCodex, same], noCodex, 'Linux', { claude: null, codex: null }).agents, 0).state).toBe('ok');
  });

  it('doesn’t ask for an agent no other machine has', () => {
    const noCodex = { ...reference, installs: [install('claude', '2.1.281')] };
    const step = agentsStep({ ...fresh, installs: [install('claude', '2.1.281')] }, [noCodex], noCodex, 'Linux');
    expect(step.agents.map((fact) => fact.state)).toEqual(['ok', 'notNeeded']);
    expect(step.state).toBe('done');
  });

  it('can’t tell when the version is unknown, and waits for the first read', () => {
    const unknown = agentsStep({ ...fresh, installs: [install('claude', null)] }, [{ ...reference, installs: [install('claude', '2.1.281')] }], null, 'Linux');
    expect(unknown.state).toBe('unknown');
    expect(agentsStep({ ...fresh, scannedAt: null, homes: [] }, [reference], reference, 'Linux').state).toBe('waiting');
  });

  it('can’t tell after a first read that failed, rather than asking to install what may be there', () => {
    const failed = { ...fresh, homes: [], installs: [], error: 'ssh: connect to host cedar-03 port 22: Connection refused' };
    expect(agentsStep(failed, [reference, failed], reference, 'Linux')).toEqual({ state: 'unknown', agents: [] });
    // A later read that failed keeps what the last one found.
    expect(agentsStep({ ...fresh, error: 'timed out' }, [reference], reference, 'Linux').agents).toHaveLength(2);
  });
});

describe('reaching the proxy', () => {
  const keys: KeyAssignment[] = [{ api_key_hash: 'a1', label: 'Laptop', machine: 'mbp' }, { api_key_hash: 'b2', label: 'Cedar', machine: 'cedar-03' }];
  const seen = (machine: string, last: string | null, requests = 12): MachineRequests => ({ machine, requests, lastRequest: last });

  it('is done once Arbor has seen the machine’s requests this week', () => {
    const step = proxyStep(fresh, reference, keys, [seen('cedar-03', ago(3_600_000))], null, NOW);
    expect(step).toMatchObject({ state: 'done', why: 'seen', requests: 12, lastRequestMs: NOW - 3_600_000 });
  });

  it('asks for a key first, and names the proxy settings the reference has', () => {
    const step = proxyStep(fresh, reference, [itemAt(keys, 0)], [], null, NOW);
    expect(step).toMatchObject({ state: 'todo', why: 'noKey' });
    expect(step.settings).toEqual([
      { home: 'claude:~/.claude', names: ['ANTHROPIC_BASE_URL'] },
      { home: 'codex:~/.codex', names: ['model_providers.arbor'] },
    ]);
  });

  it('is quiet with a key but no requests in the window', () => {
    const old = proxyStep(fresh, reference, keys, [seen('cedar-03', ago(PROXY_WINDOW_MS + 1))], null, NOW);
    expect(old).toMatchObject({ state: 'todo', why: 'quiet' });
    expect(proxyStep(fresh, reference, keys, [seen('cedar-03', ago(60_000), 0)], null, NOW).why).toBe('quiet');
  });

  it('waits for the records, and says when they failed', () => {
    expect(proxyStep(fresh, reference, null, null, null, NOW).state).toBe('waiting');
    expect(proxyStep(fresh, reference, null, null, 'database is locked', NOW)).toMatchObject({ state: 'unknown', error: 'database is locked' });
  });
});

describe('the setup repo', () => {
  const sha = 'a'.repeat(40);
  const repo = (sum: string): SetupRepo => ({
    path: '/Users/cam/src/agent-setup', branch: 'main', head: { sha, subject: 'Start', atMs: NOW }, upstream: null, uncommitted: [],
    files: [{ path: '~/.claude/CLAUDE.md', kind: 'instructions', sum, ck: 'c1-10', size: 10 }], skills: [], ignored: [], skillMachines: {}, removedSkills: [], removedFiles: [], offSkills: [], offFiles: [], fileMachines: {}, skillProjects: {}, mcpProjects: {}, instructions: [],
    plugins: [], codexPlugins: [],
  });

  it('is in step when nothing is to add or update', () => {
    expect(repoStep('/repo', repo('c1'), null, reference)).toMatchObject({ state: 'done', why: 'inStep' });
    const behind = repoStep('/repo', repo('c1'), null, fresh);
    expect(behind).toMatchObject({ state: 'todo', why: 'behind' });
    expect(behind.counts?.add).toBe(1);
  });

  it('asks for a repo, waits for it, and says when it can’t be read', () => {
    expect(repoStep(null, null, null, fresh)).toMatchObject({ state: 'todo', why: 'noRepo' });
    expect(repoStep('/repo', null, null, fresh).state).toBe('waiting');
    expect(repoStep('/repo', null, 'not a git repo', fresh)).toMatchObject({ state: 'unknown', error: 'not a git repo' });
    expect(repoStep('/repo', { ...repo('c1'), head: null }, null, fresh).why).toBe('noCommits');
    expect(repoStep('/repo', repo('c1'), null, { ...fresh, scannedAt: null, homes: [] }).why).toBe('notRead');
  });
});

describe('skills', () => {
  it('links the store skills the reference has on, and names ones this machine hasn’t got', () => {
    const step = skillsStep(fresh, reference);
    expect(step.state).toBe('todo');
    expect(step.plan.map((change) => [change.cell.home.path, change.row.name, change.action])).toEqual([['~/.claude', 'pdf', 'link']]);
    expect(step.links).toBe(1);
    expect(step.notHere).toEqual(['harness']);
  });

  it('adds the machine’s own tidy-ups, like a copy that could be a link', () => {
    const copy = machine('cedar-03', [
      home('claude', '~/.claude', [skill('~/.claude', 'pdf', 'k1')]),
      home('shared', '~/.agents', [skill('~/.agents', 'pdf', 'k1')]),
    ]);
    const step = skillsStep(copy, null);
    expect(step.plan.map((change) => change.action)).toEqual(['useStore']);
    expect(step.links).toBe(0);
  });

  it('is done when every skill is on, and waits for the first read', () => {
    const done = machine('cedar-03', [
      home('claude', '~/.claude', [skill('~/.claude', 'pdf', 'k1', { link: '~/.agents/skills/pdf' }), skill('~/.claude', 'harness', 'h1', { link: '~/x/harness' })]),
      home('shared', '~/.agents', [skill('~/.agents', 'pdf', 'k1')]),
    ]);
    expect(skillsStep(done, reference)).toMatchObject({ state: 'done', plan: [], notHere: [] });
    expect(skillsStep({ ...fresh, scannedAt: null, homes: [] }, reference).state).toBe('waiting');
  });

  it('leaves out skills either machine’s settings turn off', () => {
    const off = (entry: SetupMachine, names: string[]): SetupMachine => ({
      ...entry,
      homes: entry.homes.map((found) => found.agent === 'claude'
        ? { ...found, skillOverrides: names.map((name) => ({ name, state: 'off' as const, source: 'settings' as const, file: '~/.claude/settings.json' })) }
        : found),
    });
    // This machine turns harness off, so it isn't missing; the reference turns pdf off, so it isn't one to link.
    expect(skillsStep(off(fresh, ['harness']), off(reference, ['pdf']))).toMatchObject({ state: 'done', plan: [], notHere: [] });
    expect(skillsStep(off(fresh, ['harness']), reference)).toMatchObject({ state: 'todo', links: 1, notHere: [] });
  });
});

describe('MCP servers from the repo', () => {
  const machines = [reference, fresh];
  const cell = (name: string, state: RegistryCell['state'], blocked: RegistryCell['blocked'] = null): RegistryCell => ({
    machine: 'cedar-03', home: '~/.claude', name, state, own: false, blocked,
  });
  const definition = { transport: 'http', place: 'mcp.linear.app', variables: [] };
  const registry = (cells: RegistryCell[], fields: Partial<McpRegistry> = {}): McpRegistry => ({
    commit: 'b'.repeat(40), found: true, uncommitted: false, problems: [],
    servers: ['linear', 'sentry', 'bad'].map((name) => ({ name, claude: definition, codex: null, homes: null, agents: [], own: [], off: [], allOff: false, problems: [] })),
    cells, ...fields,
  });

  it('plans the servers to add and update on this machine, and counts ones it can’t', () => {
    const found = registry([cell('linear', 'add'), cell('sentry', 'same'), cell('bad', 'add', 'broken')]);
    const step = mcpStep(fresh, '/repo', found, null, withRegistry(extensionsView(machines, {}, NOW), found));
    expect(step.plan.map((change) => [change.name, change.action])).toEqual([['linear', 'add']]);
    expect(step).toMatchObject({ state: 'todo', blocked: 1 });
  });

  it('skips a machine without a repo or a repo without servers', () => {
    const view = extensionsView(machines, {}, NOW);
    expect(mcpStep(fresh, null, null, null, view)).toMatchObject({ state: 'skip', why: 'noRepo' });
    expect(mcpStep(fresh, '/repo', registry([], { found: false }), null, view)).toMatchObject({ state: 'skip', why: 'noFile' });
    expect(mcpStep(fresh, '/repo', registry([], { problems: ['not JSON'] }), null, view)).toMatchObject({ state: 'unknown', error: 'not JSON' });
    expect(mcpStep(fresh, '/repo', registry([cell('linear', 'same')]), null, view)).toMatchObject({ state: 'done', why: 'inStep' });
    expect(mcpStep({ ...fresh, reachable: false }, '/repo', registry([cell('linear', 'add')]), null, view)).toMatchObject({ state: 'unknown', why: 'offline' });
  });
});

describe('plugins', () => {
  it('installs what the reference has, with its marketplace, turns on what it has on, and names what can’t be installed', () => {
    const step = pluginsStep(fresh, reference, extensionsView([reference, fresh], {}, NOW));
    expect(step.plan.map((change) => [change.action, change.target, change.auto])).toEqual([
      ['addMarketplace', 'official', false],
      ['install', 'context7@official', false],
      ['enable', 'review@official', false],
    ]);
    expect(step.cantInstall).toEqual(['local-tool@local']);
    expect(step.state).toBe('todo');
  });

  it('updates one behind, and skips without a reference', () => {
    const behind = machine('cedar-03', [home('claude', '~/.claude', [
      item('plugin', 'context7@official', { value: '1.1.0', enabled: true }),
      item('marketplace', 'official', { note: 'anthropics/claude-plugins-official', value: ago(60_000) }),
    ])]);
    const small = { ...reference, homes: [home('claude', '~/.claude', [item('plugin', 'context7@official', { value: '1.2.0', enabled: true })])] };
    const step = pluginsStep(behind, small, extensionsView([small, behind], {}, NOW));
    expect(step.plan.map((change) => [change.action, change.target])).toEqual([['update', 'context7@official']]);
    expect(pluginsStep(fresh, null, extensionsView([fresh], {}, NOW)).state).toBe('skip');
  });

  it('leaves plugins either machine’s policy turns on or off to the policy', () => {
    const file = '/etc/claude-code/managed-settings.json';
    const ruled = { ...fresh, policy: { file, keys: [{ kind: 'plugin' as const, name: 'context7@official' }], problem: null, ignoredOverrides: false } };
    const theirs = { ...reference, policy: { file, keys: [{ kind: 'plugin' as const, name: 'review@official' }], problem: null, ignoredOverrides: false } };
    const step = pluginsStep(ruled, theirs, extensionsView([theirs, ruled], {}, NOW));
    expect(step.plan.map((change) => [change.action, change.target])).toEqual([['addMarketplace', 'official']]);
    expect(step.cantInstall).toEqual(['local-tool@local']);
  });

  it('says it can’t tell rather than calling plugins uninstallable on a machine it can’t reach', () => {
    const away = { ...fresh, reachable: false };
    expect(pluginsStep(away, reference, extensionsView([reference, away], {}, NOW))).toMatchObject({ state: 'unknown', offline: true, plan: [], cantInstall: [] });
  });
});

describe('settings', () => {
  it('asks for what’s missing, and only notes what’s set differently', () => {
    const step = settingsStep(fresh, reference);
    expect(step.missing.map((diff) => `${diff.home} ${diff.kind} ${diff.name}`)).toEqual([
      'claude:~/.claude hook Stop',
      'claude:~/.claude setting effortLevel',
      'claude:~/.claude env ANTHROPIC_BASE_URL',
    ]);
    expect(step.different.map((diff) => diff.name)).toEqual(['model']);
    expect(step.state).toBe('todo');
    // Homes the machine hasn't got are the agents step's to make.
    expect(step.missing.some((diff) => diff.home.startsWith('codex:'))).toBe(false);
  });

  it('doesn’t ask for what a policy sets, on either machine', () => {
    const file = '/etc/claude-code/managed-settings.json';
    const theirs = { ...reference, policy: { file, keys: [{ kind: 'hook' as const, name: 'Stop' }], problem: null, ignoredOverrides: false } };
    const ruled = { ...fresh, policy: { file, keys: [{ kind: 'setting' as const, name: 'effortLevel' }, { kind: 'setting' as const, name: 'model' }], problem: null, ignoredOverrides: false } };
    const step = settingsStep(ruled, theirs);
    expect(step.missing.map((diff) => diff.name)).toEqual(['ANTHROPIC_BASE_URL']);
    expect(step.different).toEqual([]);
  });

  it('is done when only differences are left', () => {
    const like = machine('cedar-03', [home('claude', '~/.claude', [
      item('setting', 'model', { value: 'sonnet', sum: 's-sonnet' }), item('setting', 'effortLevel', { value: 'high' }),
      item('env', 'ANTHROPIC_BASE_URL', { sum: 'e1' }), item('hook', 'Stop', { count: 1 }),
    ])]);
    expect(settingsStep(like, reference)).toMatchObject({ state: 'done', missing: [] });
  });
});

describe('alerts', () => {
  const health = (installed: boolean, reporting: boolean[] = [], fields: Partial<MachineHealth> = {}) => ({
    status: 'healthy',
    agents: { claude: null, codex: null, checkedAt: NOW, error: null, updating: [], reporter: { installed, homes: reporting.map((on, index) => ({ agent: 'claude', home: `~/.h${index}`, reporting: on })) } },
    ...fields,
  }) as MachineHealth;

  it('needs the machine listed first', () => {
    expect(alertsStep(false, null, null)).toMatchObject({ state: 'todo', why: 'notListed' });
  });

  it('is done when every home reports, and to do for one that doesn’t', () => {
    expect(alertsStep(true, health(true, [true, true]), null).state).toBe('done');
    expect(alertsStep(true, health(true, [true, false]), null)).toMatchObject({ state: 'todo', why: 'partly' });
  });

  it('only asks when the reference has it', () => {
    expect(alertsStep(true, health(false), health(true, [true]))).toMatchObject({ state: 'todo', why: 'off', onReference: true });
    expect(alertsStep(true, health(false), health(false))).toMatchObject({ state: 'skip', onReference: false });
    expect(alertsStep(true, health(false), null)).toMatchObject({ state: 'todo', onReference: null });
  });

  it('waits for the agent check, and can’t tell while it’s down', () => {
    expect(alertsStep(true, null, null).state).toBe('waiting');
    expect(alertsStep(true, health(false, [], { agents: { ...health(false).agents, checkedAt: null } }), null).state).toBe('waiting');
    expect(alertsStep(true, health(false, [], { status: 'unreachable' }), null).state).toBe('unknown');
  });
});

describe('reads that failed or haven’t happened', () => {
  const failed = (entry: SetupMachine): SetupMachine => ({ ...entry, homes: [], installs: [], error: 'Connection refused' });

  it('keeps every step that compares machines from calling itself done', () => {
    expect(settingsStep(fresh, failed(reference)).state).toBe('unknown');
    expect(pluginsStep(failed(fresh), reference, extensionsView([reference, failed(fresh)], {}, NOW)).state).toBe('unknown');
    expect(skillsStep(failed(fresh), reference).state).toBe('unknown');
    expect(checksStep(failed(fresh)).state).toBe('unknown');
  });

  it('waits for the reference’s skills before saying every one it has is on', () => {
    expect(skillsStep(fresh, { ...reference, scannedAt: null, homes: [], installs: [] }).state).toBe('waiting');
    expect(skillsStep(fresh, failed(reference)).state).toBe('unknown');
  });

  it('only counts env names that reach a proxy as proxy settings', () => {
    const withEnv = machine('mbp', [home('claude', '~/.claude', [
      item('env', 'ANTHROPIC_BASE_URL'), item('env', 'ANTHROPIC_AUTH_TOKEN'), item('env', 'DISABLE_TELEMETRY'), item('env', 'HTTPS_PROXY'),
    ])]);
    expect(missingProxySettings(machine('cedar-03', [home('claude', '~/.claude', [])]), withEnv)).toEqual([
      { home: 'claude:~/.claude', names: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'HTTPS_PROXY'] },
    ]);
  });
});

describe('tools', () => {
  const found = (tool: string, version: string): ToolFound => ({ tool, path: `/usr/bin/${tool}`, version });
  const project = (needs: ProjectToolchain['needs']): ProjectToolchain => ({
    path: '/home/cam/src/app', missing: false, remote: 'github.com/cam/app', lastUsedMs: NOW, needs, libraries: [], librariesMore: 0, packages: [], unread: [],
  });
  const tools = (name: string, list: ToolFound[], projects: ProjectToolchain[] = [], fields: Partial<MachineToolchain> = {}): MachineToolchain => ({
    machine: name, homeDir: '/home/cam', os: 'Linux', arch: 'x86_64', scannedAt: NOW, partial: false, scanning: false, error: null,
    tools: list, kept: [], projects, ...fields,
  });

  it('names tools the reference has, ones behind, and projects that need a look', () => {
    const list = [
      tools('mbp', [found('node', '24.1.0'), found('bun', '1.3.0'), found('git', '2.51.0')]),
      tools('cedar-03', [found('node', '22.3.0'), found('git', '2.51.0')], [project([{ tool: 'bun', wants: '*', kind: 'range', file: 'bun.lock', field: null }])]),
    ];
    const step = toolsStep(fresh, reference, list);
    expect(step).toMatchObject({ state: 'todo', missing: ['bun'], projects: 1, referenceScanned: true });
    expect(step.behind).toEqual([{ tool: 'node', version: '22.3.0', newest: '24.1.0' }]);
  });

  it('waits for a scan, and says when one failed', () => {
    expect(toolsStep(fresh, reference, null).why).toBe('loading');
    expect(toolsStep(fresh, reference, []).why).toBe('notScanned');
    expect(toolsStep(fresh, reference, [tools('cedar-03', [], [], { scannedAt: null, scanning: true })]).why).toBe('scanning');
    expect(toolsStep(fresh, reference, [tools('cedar-03', [], [], { scannedAt: null, error: 'timed out' })])).toMatchObject({ state: 'unknown', error: 'timed out' });
  });

  it('waits for the reference’s tools before calling itself done, and is done alone without a reference', () => {
    const mine = tools('cedar-03', [found('git', '2.51.0')]);
    expect(toolsStep(fresh, reference, [mine])).toMatchObject({ state: 'waiting', referenceScanned: false });
    expect(toolsStep(fresh, reference, [mine, tools('mbp', [], [], { scannedAt: null, error: 'timed out' })])).toMatchObject({ state: 'unknown', referenceError: 'timed out' });
    expect(toolsStep(fresh, null, [mine]).state).toBe('done');
  });
});

describe('projects', () => {
  const repo = (path: string, remote: string | null, fields: Partial<ProjectRepo> = {}): ProjectRepo => ({
    path, state: 'ok', bare: false, remote, defaultBranch: 'origin/main', fetchedAt: null, fetchFailed: false, lastUsedMs: null, worktrees: [], files: [], ...fields,
  });
  const projects = (name: string, homeDir: string, repos: ProjectRepo[], scannedAt: number | null = NOW, error: string | null = null): MachineProjects => ({
    machine: name, homeDir, scannedAt, partial: false, fetchedAt: null, measuredAt: null, scanning: false, measuring: false, removing: false, error, repos,
  });
  const theirs = projects('mbp', '/Users/cam', [
    repo('/Users/cam/src/arbor', 'github.com/cam/arbor', { lastUsedMs: NOW - 60_000 }),
    repo('/Users/cam/src/My App', 'github.com/cam/my-app', { lastUsedMs: NOW }),
    repo('/Users/cam/src/notes', null),
    repo('/Users/cam/src/mirror.git', 'github.com/cam/mirror', { bare: true }),
    repo('/Users/cam/src/gone', 'github.com/cam/gone', { state: 'missing' }),
    repo('/Users/cam/src/local', '/Users/cam/bare/local.git'),
  ]);

  it('lists the reference’s projects that aren’t here, the last used first, with a command to clone each', () => {
    const step = projectsStep(fresh, reference, [theirs, projects('cedar-03', '/home/cam', [repo('/home/cam/code/arbor', 'github.com/cam/arbor')])]);
    expect(step.state).toBe('todo');
    expect(step.missing.map((entry) => [entry.name, entry.path, entry.command])).toEqual([
      ['my-app', '~/src/My App', "git clone https://github.com/cam/my-app.git ~/'src/My App'"],
    ]);
  });

  it('waits for both machines’ scans', () => {
    expect(projectsStep(fresh, reference, null).why).toBe('loading');
    expect(projectsStep(fresh, reference, [theirs]).why).toBe('notScanned');
    expect(projectsStep(fresh, reference, [projects('cedar-03', '/home/cam', [])]).why).toBe('referenceNotScanned');
    expect(projectsStep(fresh, null, []).state).toBe('skip');
  });

  it('says when a scan failed instead of waiting on it', () => {
    expect(projectsStep(fresh, reference, [theirs, projects('cedar-03', '/home/cam', [], null, 'timed out')])).toMatchObject({ state: 'unknown', why: 'failed', error: 'timed out' });
    expect(projectsStep(fresh, reference, [projects('mbp', '/Users/cam', [], null, 'denied'), projects('cedar-03', '/home/cam', [])])).toMatchObject({ state: 'unknown', why: 'referenceFailed' });
  });

  it('leaves out a home folder that’s a repo, and gives an SSH alias no HTTPS command', () => {
    const odd = projects('mbp', '/Users/cam', [repo('/Users/cam', 'github.com/cam/dotfiles'), repo('/Users/cam/src/work', 'github-work/acme/work')]);
    const step = projectsStep(fresh, reference, [odd, projects('cedar-03', '/home/cam', [])]);
    expect(step.missing.map((entry) => [entry.path, entry.command])).toEqual([['~/src/work', null]]);
  });

  it('quotes what a shell would split or expand', () => {
    expect(shellPath('~/src/arbor')).toBe('~/src/arbor');
    expect(shellPath("~/it's here")).toBe(`~/'it'\\''s here'`);
    expect(shellPath('/srv/$HOME')).toBe(`'/srv/$HOME'`);
    expect(cloneCommand('github.com/a/b', '~/src/b')).toBe('git clone https://github.com/a/b.git ~/src/b');
  });
});

describe('checks and progress', () => {
  it('lists the machine’s problems and warnings, not its notes', () => {
    const broken = machine('cedar-03', [home('claude', '~/.claude', [item('rule', 'x.md', { path: '~/.claude/rules/x.md', sum: null, link: '~/nowhere/x.md' })])]);
    const step = checksStep(broken);
    expect(step.state).toBe('todo');
    expect(step.checks.every((check) => check.level !== 'note')).toBe(true);
    expect(checksStep({ ...fresh, scannedAt: null, homes: [] }).state).toBe('waiting');
  });

  it('counts steps done out of those that apply, and opens the first to do', () => {
    expect(checklistProgress(['done', 'skip', 'todo', 'waiting', 'done'])).toEqual({ done: 2, total: 4 });
    expect(firstOpen([{ id: 'connect', state: 'done' }, { id: 'agents', state: 'waiting' }, { id: 'proxy', state: 'todo' }])).toBe('proxy');
    expect(firstOpen([{ id: 'connect', state: 'done' }])).toBeNull();
  });
});

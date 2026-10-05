/**
 * The browser mock's answers for Setup: each machine's agent files, the setup repo, skills, MCP servers and plugins,
 * projects, toolchains and starting context.
 */
import { emit } from '@tauri-apps/api/event';
import type { SetupCommands } from '../../native/setup';
import type {
  AgentKind,
  CodexPluginChange,
  ChangeKind,
  CheckoutInstructions,
  CheckoutInstructionsResult,
  CheckoutMcpResult,
  LocalFileState,
  RepoInstructions,
  CheckoutSkillResult,
  RepoPlugin,
  RepoProjectValue,
  SkillWanted,
  DefinitionView,
  Harness,
  HarnessHome,
  HarnessInstall,
  HiddenReason,
  HomeAgent,
  ItemKind,
  MachineProjects,
  MachineToolchain,
  McpChange,
  McpHealth,
  McpOutcome,
  McpRegistry,
  McpWanted,
  HookCell,
  HookRegistry,
  HookState,
  HookWanted,
  NodeChange,
  NodeResult,
  SettingsEdit,
  McpResult,
  McpStatus,
  PluginAction,
  PluginChange,
  PluginCosts,
  PluginOutcome,
  PluginResult,
  ProjectLibrary,
  ProjectRepo,
  ProjectToolchain,
  ProjectWorktree,
  RegistryCell,
  RegistryState,
  RemovalResult,
  RepoChange,
  RepoCommit,
  RepoEntry,
  RepoFileProblem,
  RepoRole,
  RepoStatus,
  RepoTree,
  RepoUpstream,
  SetupBackup,
  SetupHome,
  SetupInstall,
  SetupItem,
  SetupMachine,
  SetupRepo,
  SetupRepoFile,
  SetupRepoSkill,
  SetupSkillFile,
  SkillChange,
  SkillOverride,
  SkillSource,
  SkillUsageReport,
  SourceCheck,
  SourceState,
  StartingContext,
  SyncChange,
  SyncFileKind,
  SyncOutcome,
  ToolNeed,
  McpUsageReport,
  WorktreeRemoval,
} from '../../native/types';
import { projectOf, skillFolder, skillOf } from '../../services/repoBrowser';
import { HARNESS_SYNC_HOMES, syncKind } from '../../services/setupSync';
import type { CommandAnswers } from './answers';
import { freshInstall, hours, later, mockLog, params } from './scenario';

// Sync › Cost's starting context: sessions' first requests over the last four weeks, from each machine's homes. See
// `?context=`.
const contextScenario = params.get('context') ?? (freshInstall ? 'none' : null);

const CONTEXT_HOMES: { machine: string; agent: AgentKind; home: string; tokens: number; perDay: number; model: string; repos: string[] }[] = [
  { machine: 'casey-mbp', agent: 'claude', home: '~/.claude', tokens: 38_400, perDay: 3, model: 'claude-opus-5-5', repos: ['/Users/casey/src/arbor', '/Users/casey/src/proxy', ''] },
  { machine: 'casey-mbp', agent: 'claude', home: '~/.agent-app/homes/claude-proxy', tokens: 24_100, perDay: 2, model: 'claude-opus-5-5', repos: ['/Users/casey/src/arbor'] },
  { machine: 'casey-mbp', agent: 'codex', home: '~/.codex', tokens: 17_900, perDay: 2, model: 'gpt-6-sol', repos: ['/Users/casey/src/api', '/Users/casey/src/arbor'] },
  { machine: 'cedar-02', agent: 'claude', home: '~/.claude', tokens: 52_300, perDay: 1.5, model: 'claude-opus-5-5', repos: ['/home/casey/src/arbor', '/home/casey/src/infra'] },
  { machine: 'ci-01', agent: 'claude', home: '~/.claude', tokens: 29_800, perDay: 0.5, model: 'claude-sonnet-5', repos: ['/home/ci/work/arbor'] },
];

function mockStartingContext(fromMs: number, toMs: number): StartingContext {
  if (contextScenario === 'fail') throw 'Failed to read the sessions to look at: database is locked';
  if (contextScenario === 'none') return { sessions: [], unplaced: 0, truncated: false };
  if (contextScenario === 'unplaced') return { sessions: [], unplaced: 12, truncated: false };
  const now = Date.now();
  let seed = 7;
  const next = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
  const sessions = CONTEXT_HOMES.flatMap((spec, homeIndex) => {
    const count = Math.round(spec.perDay * 28);
    return Array.from({ length: count }, (_, index) => {
      const atMs = now - ((index + next()) / count) * 28 * 86_400_000;
      const grew = contextScenario === 'grew' && spec.machine === 'cedar-02' && atMs >= now - 7 * 86_400_000;
      const repo = spec.repos[index % spec.repos.length] ?? '';
      return {
        sessionId: `c0ffee00-0000-4000-8000-${String(homeIndex * 1000 + index).padStart(12, '0')}`,
        machine: spec.machine, agent: spec.agent, home: spec.home, repo, model: spec.model,
        tokens: Math.round(spec.tokens + (next() - 0.5) * spec.tokens * 0.12 + (repo.endsWith('arbor') ? 2_600 : 0) + (grew ? 9_000 : 0)),
        atMs: Math.round(atMs),
      };
    });
  }).filter((start) => start.atMs >= fromMs && start.atMs < toMs).sort((a, b) => a.atMs - b.atMs);
  return { sessions, unplaced: 0, truncated: false };
}

// Setup: what the agents load on each machine. ci-01 lags behind this Mac (an older CLAUDE.md, an @import that isn't
// cloned there, drifted skills, an older plugin, a Codex config it can't read) and cedar-02 has no Codex. This Mac
// has a second, older Codex from Homebrew, a skill in Codex's old folder, an old Codex setting and a Claude Code copy
// of a shared skill that has drifted from it; cedar-02 has an npm Claude Code left behind. ci-01 was read 25
// minutes ago, so opening the page reads it again; `?setup=fail` makes that read fail, keeping what it last found.
/** When something happened `days` ago, as Claude Code records it. */
const mockAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** `?hooks=sample` (or `broken`): the setup repo keeps hooks and the scripts they run. */
const hooksSample = params.get('hooks') === 'sample' || params.get('hooks') === 'broken';

export const setupItem = (kind: ItemKind, name: string, sum: string | null, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind, name, path: null, sum, size: null, link: null, value: null, note: null, count: null, enabled: null, text: false, skill: null, import: null, ...fields,
});

const setupFile = (kind: ItemKind, name: string, path: string, sum: string | null, size: number | null, fields: Partial<SetupItem> = {}) =>
  setupItem(kind, name, sum, { path, size, text: sum !== null && kind !== 'profile', ...fields });

const setupSkill = (name: string, path: string, sum: string, files: number, source: string | null = null, fields: Partial<SetupItem> = {}) =>
  setupItem('skill', name, sum, { path, skill: { files, hasDoc: true, declaredName: name, descriptionChars: 180, whenToUseChars: 0, manualOnly: false, source }, ...fields });

/** A machine's copy of another's items: `changes` replaces fields by `kind:name`, or drops the item when null. */
const setupDrift = (items: SetupItem[], changes: Record<string, Partial<SetupItem> | null>, extra: SetupItem[] = []): SetupItem[] => [
  ...items.flatMap((item) => {
    const change = changes[`${item.kind}:${item.name}`];
    return change === undefined ? [item] : change === null ? [] : [{ ...item, ...change }];
  }),
  ...extra,
];

const importFacts = { from: '~/.claude/CLAUDE.md', written: '@~/src/browser-check/SKILL.md', level: 1 };

const claudeItems: SetupItem[] = [
  setupFile('instructions', 'CLAUDE.md', '~/.claude/CLAUDE.md', 'c2b9', 412),
  setupFile('import', '~/src/browser-check/SKILL.md', '~/src/browser-check/SKILL.md', 'b4e1', 5_320, { import: importFacts }),
  setupFile('rule', 'testing.md', '~/.claude/rules/testing.md', 'r7d0', 644),
  setupSkill('pdf', '~/.claude/skills/pdf', 'k1', 4),
  setupSkill('release-notes', '~/.claude/skills/release-notes', 'k2', 2),
  setupSkill('browser-check', '~/.claude/skills/browser-check', 'k3', 6, null, { link: '~/src/browser-check' }),
  setupSkill('agents-md', '~/.claude/skills/agents-md', 'q1', 3, null, { link: '~/.agents/skills/agents-md' }),
  setupSkill('find-skills', '~/.claude/skills/find-skills', 'q2', 1, null, { link: '~/.agents/skills/find-skills' }),
  setupFile('subagent', 'reviewer', '~/.claude/agents/reviewer.md', 'a1', 1_210),
  setupFile('command', 'ship', '~/.claude/commands/ship.md', 'm1', 418),
  setupFile('command', 'old', '~/.claude/commands/old.md', null, null, { link: '~/src/scripts/old.md' }),
  setupItem('hook', 'PreToolUse', 'h1', { count: 2 }),
  setupItem('hook', 'Stop', 'h2', { count: 1 }),
  setupItem('mcp', 'linear', 'x1', { value: 'http', note: 'mcp.linear.app' }),
  setupItem('mcp', 'playwright', 'x2', { value: 'stdio', note: 'npx' }),
  setupItem('plugin', 'superpowers@superpowers-marketplace', 'p1', { value: '4.1.0', enabled: true, note: mockAgo(3) }),
  setupItem('plugin', 'context7@claude-plugins-official', 'p2', { value: '1.2.0', enabled: true, note: mockAgo(2) }),
  setupItem('plugin', 'pr-review-toolkit@claude-plugins-official', 'p3', { value: '1.4.0', enabled: false, note: mockAgo(30) }),
  setupItem('marketplace', 'superpowers-marketplace', 'mk1', { note: 'obra/superpowers-marketplace', value: mockAgo(12) }),
  setupItem('marketplace', 'claude-plugins-official', 'mk2', { note: 'anthropics/claude-plugins-official', value: mockAgo(1), enabled: true }),
  setupItem('setting', 'model', 's1', { value: 'opus' }),
  setupItem('setting', 'effortLevel', 's2', { value: 'high' }),
  setupItem('setting', 'includeCoAuthoredBy', 's4', { value: 'false' }),
  setupItem('setting', 'permissions.allow', 's3', { count: 14 }),
  setupItem('setting', 'permissions.defaultMode', 's5', { value: 'acceptEdits' }),
  setupItem('setting', 'cleanupPeriodDays', 's6', { value: '36500' }),
  setupItem('env', 'ANTHROPIC_BASE_URL', 'e1'),
];

const codexItems: SetupItem[] = [
  setupFile('instructions', 'AGENTS.md', '~/.codex/AGENTS.md', 'g1', 388),
  setupFile('rule', 'default.rules', '~/.codex/rules/default.rules', 'g2', 312),
  setupFile('profile', 'fast', '~/.codex/fast.config.toml', 'g3', 212),
  setupItem('mcp', 'linear', 'x1c', { value: 'http', note: 'mcp.linear.app' }),
  setupItem('setting', 'model', 'gs1', { value: 'gpt-5.5' }),
  setupItem('setting', 'model_reasoning_effort', 'gs2', { value: 'high' }),
  setupItem('setting', 'approval_policy', 'gs3', { value: 'on-request' }),
  setupItem('setting', 'sandbox_mode', 'gs4', { value: 'workspace-write' }),
  setupItem('setting', 'model_providers.arbor', 'gs5', { count: 4 }),
  setupItem('setting', 'features.web_search_request', 'gs6', { value: 'true' }),
  setupSkill('find-skills', '~/.codex/skills/find-skills', 'q2', 1),
  // Codex's own plugins: the app's bundled ones, and one from a team marketplace that's turned off here.
  setupItem('plugin', 'chrome@openai-bundled', 'cp1', { enabled: true }),
  setupItem('plugin', 'pdf@openai-primary-runtime', 'cp2', { enabled: true }),
  setupItem('plugin', 'sketch@team', 'cp3', { enabled: false }),
  setupItem('marketplace', 'openai-bundled', 'cm1', { note: '~/.codex/.tmp/bundled-marketplaces/openai-bundled' }),
  setupItem('marketplace', 'openai-primary-runtime', 'cm2', { note: '~/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime' }),
  setupItem('marketplace', 'team', 'cm3', { note: 'acme/codex-plugins' }),
];

const sharedItems: SetupItem[] = [
  setupSkill('agents-md', '~/.agents/skills/agents-md', 'q1', 3, 'casey/skills'),
  setupSkill('find-skills', '~/.agents/skills/find-skills', 'q2', 1, 'vercel-labs/skills'),
  setupSkill('frontend-design', '~/.agents/skills/frontend-design', 'q3', 4, 'anthropics/skills'),
  setupSkill('pdf', '~/.agents/skills/pdf', 'k1', 4, 'anthropics/skills'),
  setupFile('command', 'review', '~/.agents/commands/review.md', 'q4', 902),
];

const setupHome = (agent: HomeAgent, path: string, items: SetupItem[], problems: string[] = [], skillsLink: string | null = null): SetupHome =>
  ({ agent, path, items, problems, skillsLink, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null });

// The other harnesses' homes, read for their own instructions and skills. `?harnessHomes=none` for machines with none.
const noHarnessHomes = params.get('harnessHomes') === 'none';
const harnessHome = (harness: Harness, path: string, items: SetupItem[]): HarnessHome => ({ harness, path, items, skillsLink: null });
const harnessHomes = (homes: HarnessHome[]) => (noHarnessHomes ? [] : homes);

// Each updates with its own command, as the catalog names it.
const HARNESS_UPDATE: Partial<Record<Harness, string>> = { pi: 'pi update', droid: 'droid update', openCode: 'opencode upgrade', amp: 'amp update', primeAgent: 'prime-agent update' };
const harnessInstall = (harness: Harness, path: string, version: string | null): HarnessInstall => ({
  harness, path, real: null, version, updateCommand: HARNESS_UPDATE[harness] ?? null,
});
const setupInstall = (agent: AgentKind, path: string, version: string | null, real: string | null = null): SetupInstall => ({ agent, path, real, version });

export const setupMachines: SetupMachine[] = [
  {
    machine: 'casey-mbp', local: true, reachable: true, scannedAt: Date.now() - 3 * 60_000, error: null, scanning: false, policy: null,
    homes: [
      setupHome('claude', '~/.claude', [...claudeItems, setupSkill('frontend-design', '~/.claude/skills/frontend-design', 'q3-mine', 3)]),
      setupHome('codex', '~/.codex', codexItems),
      setupHome('shared', '~/.agents', sharedItems),
      setupHome('claude', '~/.agent-app/homes/claude-proxy', [
        setupItem('plugin', 'superpowers@superpowers-marketplace', 'p1', { value: '4.1.0', enabled: true, note: mockAgo(3) }),
        setupItem('plugin', 'context7@claude-plugins-official', 'pg', { value: null, enabled: true }),
        setupItem('marketplace', 'superpowers-marketplace', 'mk1', { note: 'obra/superpowers-marketplace', value: mockAgo(3) }),
      ]),
    ],
    harnessHomes: harnessHomes([
      harnessHome('pi', '~/.pi/agent', [
        setupFile('instructions', 'AGENTS.md', '~/.pi/agent/AGENTS.md', 'pi1', 820),
        setupSkill('deploy', '~/.pi/agent/skills/deploy', 'pd1', 3),
        setupSkill('pdf', '~/.pi/agent/skills/pdf', 'k1', 4),
        setupItem('mcp', 'github', 'pg1', { value: 'stdio', note: 'npx' }),
        setupItem('mcp', 'linear', 'x1r-pi', { value: 'http', note: 'mcp.linear.app' }),
      ]),
      harnessHome('droid', '~/.factory', [
        setupFile('instructions', 'AGENTS.md', '~/.factory/AGENTS.md', 'dr1', 410),
        setupSkill('review-pr', '~/.factory/skills/review-pr', 'dr2', 2),
        setupItem('mcp', 'linear', 'dl1', { value: 'http', note: 'mcp.linear.app', enabled: false }),
        setupItem('hook', 'PreToolUse', 'dh1', { count: 1 }),
        setupItem('hook', 'SessionStart', 'dh2', { count: 2 }),
      ]),
    ]),
    harnessInstalls: [
      harnessInstall('pi', '~/.npm-global/bin/pi', '0.70.2'),
      harnessInstall('droid', '~/.local/bin/droid', '0.22.1'),
      harnessInstall('amp', '~/.amp/bin/amp', '0.0.1751'),
    ],
    installs: [
      setupInstall('claude', '~/.local/bin/claude', '2.1.281', '~/.local/share/claude/versions/2.1.281'),
      setupInstall('codex', '~/.npm-global/bin/codex', '0.156.0', '~/.npm-global/lib/node_modules/@openai/codex/bin/codex.js'),
      setupInstall('codex', '/opt/homebrew/bin/codex', '0.153.3', '/opt/homebrew/Caskroom/codex/0.153.3/codex-aarch64-apple-darwin'),
    ],
  },
  {
    machine: 'ci-01', local: false, reachable: true, scannedAt: Date.now() - 25 * 60_000, error: null, scanning: false, policy: null,
    homes: [
      setupHome('claude', '~/.claude', setupDrift(claudeItems, {
        'instructions:CLAUDE.md': { sum: 'c1a7', size: 298 },
        'import:~/src/browser-check/SKILL.md': { sum: null, size: null, text: false },
        'skill:release-notes': { sum: 'k2-old', skill: { files: 3, hasDoc: true, declaredName: 'release-notes', descriptionChars: 164, whenToUseChars: 0, manualOnly: false, source: null } },
        'skill:browser-check': null,
        'command:old': null,
        'mcp:playwright': null,
        'plugin:superpowers@superpowers-marketplace': { sum: 'p0', value: '4.0.3', note: mockAgo(45) },
        'plugin:context7@claude-plugins-official': { sum: 'p2b', value: '1.1.0', note: mockAgo(40) },
        'plugin:pr-review-toolkit@claude-plugins-official': null,
        'marketplace:claude-plugins-official': { value: mockAgo(20), enabled: false },
        'setting:effortLevel': { sum: 's2b', value: 'medium' },
        'setting:permissions.allow': { sum: 's3b', count: 9 },
        'setting:cleanupPeriodDays': null,
        'env:ANTHROPIC_BASE_URL': { sum: 'e2' },
        'rule:testing.md': { link: '~/src/team-rules/testing.md' },
      }, [
        setupItem('skill', 'scratch', null, { path: '~/.claude/skills/scratch', skill: { files: 0, hasDoc: false, declaredName: null, descriptionChars: 0, whenToUseChars: 0, manualOnly: false, source: null } }),
        setupItem('mcp', 'github', 'x3', { value: 'http', note: 'api.githubcopilot.com' }),
        setupFile('command', 'deploy', '~/.claude/commands/deploy.md', 'm9', 302),
      ])),
      setupHome('codex', '~/.codex', [
        ...codexItems.filter((item) => item.kind !== 'mcp' && item.kind !== 'setting' && item.kind !== 'skill')
          .map((item) => (item.name === 'sketch@team' ? { ...item, enabled: true } : item)),
        ...sharedItems.filter((item) => item.kind === 'skill').map((item) => ({ ...item, path: `~/.codex/skills/${item.name}`, sum: item.name === 'frontend-design' ? 'q3-old' : item.sum })),
      ], ["~/.codex/config.toml isn't TOML Arbor can read"], '~/.agents/skills'),
      setupHome('shared', '~/.agents', setupDrift(sharedItems, { 'skill:frontend-design': { sum: 'q3-old' } })),
    ],
    harnessHomes: harnessHomes([
      harnessHome('pi', '~/.pi/agent', [
        setupFile('instructions', 'AGENTS.md', '~/.pi/agent/AGENTS.md', 'pi0', 612),
        setupSkill('deploy', '~/.pi/agent/skills/deploy', 'pd1', 3),
        setupItem('mcp', 'github', 'pg1', { value: 'stdio', note: 'npx' }),
        setupItem('mcp', 'linear', 'pl0', { value: 'http', note: 'mcp.linear.app' }),
        setupItem('mcp', 'sentry', 'x5-pi', { value: 'http', note: 'mcp.sentry.dev' }),
      ]),
    ]),
    harnessInstalls: [harnessInstall('pi', '~/.npm-global/bin/pi', '0.68.0')],
    installs: [
      setupInstall('claude', '~/.local/bin/claude', '2.1.270', '~/.local/share/claude/versions/2.1.270'),
      setupInstall('codex', '~/.npm-global/bin/codex', '0.153.3', '~/.npm-global/lib/node_modules/@openai/codex/bin/codex.js'),
    ],
  },
  {
    machine: 'cedar-02', local: false, reachable: true, scannedAt: Date.now() - 2 * 60_000, error: null, scanning: false, policy: null,
    homes: [
      setupHome('claude', '~/.claude', setupDrift(claudeItems, {
        'setting:model': { sum: 's1b', value: 'sonnet' },
        'command:old': null,
        'mcp:linear': { sum: 'x1e' },
        'plugin:superpowers@superpowers-marketplace': null,
        'marketplace:superpowers-marketplace': null,
      })),
      setupHome('shared', '~/.agents', [
        ...sharedItems,
        setupSkill('db-migrate', '~/.agents/skills/db-migrate', 'e7', 3, 'casey/skills'),
        setupSkill('log-triage', '~/.agents/skills/log-triage', 'e8', 2),
      ]),
    ],
    harnessHomes: harnessHomes([
      harnessHome('openCode', '~/.config/opencode', [
        setupFile('instructions', 'AGENTS.md', '~/.config/opencode/AGENTS.md', 'oc1', 233),
        setupItem('mcp', 'fs', 'of1', { value: 'stdio', note: 'npx' }),
      ]),
    ]),
    harnessInstalls: [harnessInstall('openCode', '~/.opencode/bin/opencode', '0.15.3')],
    installs: [
      setupInstall('claude', '~/.local/bin/claude', '2.1.281', '~/.local/share/claude/versions/2.1.281'),
      setupInstall('claude', '~/.npm-global/bin/claude', '1.0.128', '~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
    ],
  },
];

/** `?fresh=1`: only this Mac, which isn't listed as a machine yet, as the scan finds it anyway. */
const keepThisMacOnly = <T extends { machine: string }>(entries: T[]) => {
  if (!freshInstall) return;
  const kept = entries.filter((entry) => entry.machine === 'casey-mbp');
  entries.splice(0, entries.length, ...kept);
};
keepThisMacOnly(setupMachines);
// Its own homes, without the other apps' ones a first look at the machine would add.
for (const entry of freshInstall ? setupMachines : []) entry.homes = entry.homes.filter((home) => !home.path.startsWith('~/.agent-app/'));

/** What a machine's first scan finds, held back until Sync scans it: `?fresh=1`'s Mac hasn't been read yet. */
const unscanned = new Map<string, Pick<SetupMachine, 'homes' | 'harnessHomes' | 'installs' | 'harnessInstalls'>>();
for (const entry of freshInstall ? setupMachines : []) {
  const { homes, harnessHomes, installs, harnessInstalls } = entry;
  unscanned.set(entry.machine, { homes, harnessHomes, installs, harnessInstalls });
  Object.assign(entry, { scannedAt: null, homes: [], harnessHomes: [], installs: [], harnessInstalls: [] });
}

// With `?pluginrepo=sample`, ci-01 has agency from its own marketplace, which the repo has removed everywhere, and
// cedar-02's settings still name a plugin that's gone, which the grid counts rather than lists.
if (params.get('pluginrepo') === 'sample') {
  const homeOf = (machine: string) => setupMachines.find((entry) => entry.machine === machine)?.homes.find((home) => home.path === '~/.claude');
  homeOf('ci-01')?.items.push(
    setupItem('plugin', 'agency@agency-skills', 'p9', { value: '1.2.0', enabled: true, note: mockAgo(9) }),
    setupItem('marketplace', 'agency-skills', 'mk9', { note: 'acme/agency-skills', value: mockAgo(9) }),
  );
  homeOf('cedar-02')?.items.push(setupItem('plugin', 'old-helper@claude-plugins-official', null, { value: null, enabled: false }));
}

// With `?hooks=sample`, this Mac and ci-01 have the repo's hook scripts (ci-01 also an old one the repo hasn't got) and
// cedar-02 has none yet, so its hooks can't be brought in step until its files are.
if (hooksSample) {
  const shared = (machine: string) => setupMachines.find((entry) => entry.machine === machine)?.homes.find((home) => home.path === '~/.agents');
  const script = (name: string, sum: string, size: number) => setupFile('hook', name, `~/.agents/hooks/${name}`, sum, size);
  shared('casey-mbp')?.items.push(script('guard.sh', 'hs1', 96), script('notify.py', 'hs2', 88));
  shared('ci-01')?.items.push(script('guard.sh', 'hs1', 96), script('notify.py', 'hs2', 88), script('old.sh', 'hs9', 40));
}

// With `?setup=overrides`, Claude Code's skillOverrides turn skills off or change how they're offered: this Mac's
// ~/.claude turns release-notes off and lists pdf by name only, ci-01's turns browser-check off (so it isn't counted
// missing there), and the second Claude home's settings.json has a value Claude Code doesn't know, so it ignores them all.
const setupScenario = params.get('setup');
if (setupScenario === 'overrides') {
  const homeOf = (machine: string, path: string) => setupMachines.find((entry) => entry.machine === machine)?.homes.find((home) => home.path === path);
  const override = (name: string, state: SkillOverride['state'], file = '~/.claude/settings.json'): SkillOverride => ({ name, state, source: 'settings', file });
  const mac = homeOf('casey-mbp', '~/.claude');
  if (mac) mac.skillOverrides = [override('pdf', 'nameOnly'), override('release-notes', 'off')];
  const ci = homeOf('ci-01', '~/.claude');
  if (ci) ci.skillOverrides = [override('browser-check', 'off')];
  const second = homeOf('casey-mbp', '~/.agent-app/homes/claude-proxy');
  if (second) second.ignoredOverrides = ['~/.agent-app/homes/claude-proxy/settings.json'];
}
// With `?setup=policy`, Claude Code's managed-settings policy on this Mac sets how long sessions are kept, the model,
// a deny list, its telemetry, a hook and a plugin, and turns frontend-design off in every Claude Code home; ci-01's
// can't be read; and cedar-02's has skill overrides Claude Code ignores.
if (setupScenario === 'policy') {
  const machineOf = (machine: string) => setupMachines.find((entry) => entry.machine === machine);
  const mac = machineOf('casey-mbp');
  const macFile = '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (mac) {
    const keys: [ItemKind, string][] = [
      ['hook', 'PreToolUse'], ['plugin', 'context7@claude-plugins-official'], ['setting', 'cleanupPeriodDays'], ['setting', 'model'],
      ['setting', 'permissions.deny'], ['env', 'CLAUDE_CODE_ENABLE_TELEMETRY'], ['env', 'OTEL_METRICS_EXPORTER'],
    ];
    mac.policy = { file: macFile, keys: keys.map(([kind, name]) => ({ kind, name })), problem: null, ignoredOverrides: false };
    for (const home of mac.homes.filter((entry) => entry.agent === 'claude')) {
      home.skillOverrides = [...home.skillOverrides.filter((entry) => entry.name !== 'frontend-design'), { name: 'frontend-design', state: 'off', source: 'policy', file: macFile }];
    }
  }
  const ci = machineOf('ci-01');
  const ciFile = '/etc/claude-code/managed-settings.json';
  if (ci) ci.policy = { file: ciFile, keys: [], problem: `${ciFile} is there, but the user Arbor signs in as can't read it`, ignoredOverrides: false };
  const cedar = machineOf('cedar-02');
  if (cedar) cedar.policy = { file: ciFile, keys: [{ kind: 'setting', name: 'forceLoginMethod' }], problem: null, ignoredOverrides: true };
}
// With `?setup=shadow`, this Mac has a shadow Codex home whose entries link into ~/.codex, so what it shares
// shows under Codex and the shadow home has nothing of its own to compare.
if (setupScenario === 'shadow') {
  const mac = setupMachines.find((entry) => entry.machine === 'casey-mbp');
  if (mac) {
    const shadow = setupHome('codex', '~/.agent-app/homes/codex-proxy', [], [], '~/.codex/skills');
    shadow.shares = { home: '~/.codex', entries: ['AGENTS.md', 'archived_sessions', 'config.toml', 'prompts', 'rules', 'sessions', 'skills', 'sqlite'] };
    mac.homes.push(shadow);
  }
}

/** Refuses a change to what a machine's policy sets, as the backend does. */
export const leaveToPolicy = (entry: SetupMachine, kind: ItemKind, names: string[]) => {
  const set = names.filter((name) => entry.policy?.keys.some((key) => key.kind === kind && key.name === name));
  if (set.length) throw `The managed settings policy on ${entry.machine} sets ${set.join(', ')}, so Arbor leaves it as the policy has it`;
};

// What files say, by fingerprint, so copies that match read the same on every machine and in the setup repo.
const setupTexts: Record<string, string> = {
  c2b9: '# Working agreement\n\n@~/src/browser-check/SKILL.md\n\n## Style\n- Match the surrounding code.\n- Keep comments short and plain.\n\n## Releases\n- Release a patch after finished, verified work.\n- Push to the private remote.\n\n## Reviews\n- Run the test suite before asking for review.\n- Link every pull request you mention.\n',
  c1a7: '# Working agreement\n\n## Style\n- Match the surrounding code.\n\n## Releases\n- Ask before releasing.\n\n## Reviews\n- Run the test suite before asking for review.\n- Link every pull request you mention.\n',
  g1: '# Codex\n\n- Match the surrounding code.\n- Run the tests before finishing.\n- Never commit secrets.\n',
  r7d0: '# Testing\n\n- Use temporary folders, never real data.\n- Keep tests fast and independent.\n',
  r8e2: '# Reviews\n\n- Read the whole change before commenting.\n- Say what would break, not just what looks odd.\n',
  a1: '---\nname: reviewer\ndescription: Reviews a change for bugs before it ships.\n---\n\nRead the diff, run the tests, and list what would break.\n',
  a2: '---\nname: planner\ndescription: Plans a change before any code is written.\n---\n\nList the files involved, the steps, and what to test.\n',
  m1: '---\ndescription: Ship the current branch\n---\n\nRun the tests, then open a pull request.\n',
  m2: '---\ndescription: Ship the current branch\n---\n\nRun the tests and the type check, then open a pull request and link it.\n',
  m9: '---\ndescription: Deploy to staging\n---\n\nBuild, then run ./scripts/deploy.sh staging.\n',
};

const skillFile = (path: string, sum: string, content: string | null, hidden: HiddenReason | null = null): SetupSkillFile => ({ path, sum, size: content?.length ?? 2_048, content, hidden });

const releaseNotesDoc = (steps: string[]) => `---\nname: release-notes\ndescription: Write release notes from the commits since the last tag.\n---\n\n# Release notes\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n`;

const findSkillsDoc = (lines: string[]) => `---\nname: find-skills\ndescription: Find a skill for a task and install it.\n---\n\n${lines.join('\n')}\n`;

const designDoc = (lines: string[]) => `---\nname: frontend-design\ndescription: Build distinctive, production-grade interfaces.\n---\n\n${lines.join('\n')}\n`;

const setupSkills: Record<string, Record<string, SetupSkillFile[]>> = {
  '~/.claude/skills/release-notes': {
    'casey-mbp': [
      skillFile('SKILL.md', 'n2', releaseNotesDoc(['List the commits since the last tag.', 'Group them by what changed for people using the app.', 'Leave out refactors nobody would notice.', 'Keep each line under 80 characters.'])),
      skillFile('template.md', 't1', '## What’s new\n\n## Fixed\n'),
    ],
    'ci-01': [
      skillFile('SKILL.md', 'n1', releaseNotesDoc(['List the commits since the last tag.', 'Group them by area.', 'Keep each line under 80 characters.'])),
      skillFile('template.md', 't1', '## What’s new\n\n## Fixed\n'),
      skillFile('examples.md', 'x1', '## What’s new\n- Faster startup.\n'),
    ],
  },
  '~/.agents/skills/frontend-design': {
    'casey-mbp': [
      skillFile('SKILL.md', 'd2', designDoc(['Pick a clear direction before writing code.', 'Use the project’s tokens; never invent colors.', 'Check it in light and dark.'])),
      skillFile('reference/palette.md', 'pl', '# Palette\n\nNeutral first, one accent.\n'),
      skillFile('.env', 'env2', null, 'secret'),
      skillFile('assets/logo.png', 'png', null, 'binary'),
    ],
    'ci-01': [
      skillFile('SKILL.md', 'd1', designDoc(['Pick a clear direction before writing code.', 'Check it in light and dark.'])),
      skillFile('reference/palette.md', 'pl', '# Palette\n\nNeutral first, one accent.\n'),
      skillFile('.env', 'env1', null, 'secret'),
      skillFile('assets/logo.png', 'png', null, 'binary'),
    ],
  },
  '~/.claude/skills/frontend-design': {
    'casey-mbp': [
      skillFile('SKILL.md', 'd0', designDoc(['Pick a clear direction before writing code.', 'Check it in light and dark.'])),
      skillFile('reference/palette.md', 'pl0', '# Palette\n\nNeutral first.\n'),
      skillFile('assets/logo.png', 'png', null, 'binary'),
    ],
  },
  '~/.agents/skills/find-skills': Object.fromEntries(['casey-mbp', 'ci-01', 'cedar-02'].map((machine) => [machine, [
    skillFile('SKILL.md', 'f1', findSkillsDoc(['Search the skills directory for the task at hand.', 'Suggest the best match with its install command.'])),
  ]])),
  '~/.claude/skills/browser-check': {
    'casey-mbp': [
      skillFile('SKILL.md', 'bh', '---\nname: browser-check\ndescription: Drive a real browser to check a page.\n---\n\nOpen the page, act, then take a snapshot.\n'),
      skillFile('scripts/run.sh', 'rs', '#!/bin/sh\nexec node ./run.mjs "$@"\n'),
    ],
  },
};
// With `?markdown=rich`, casey-mbp's CLAUDE.md (and the setup repo's) holds everything a preview has to handle: GitHub
// tables and task lists, links of every kind, an image, prompt tags, and HTML that must never run. Its release-notes
// SKILL.md gets front matter with lists and block text.
if (params.get('markdown') === 'rich') {
  setupTexts.c2b9 = [
    '# Working agreement',
    '',
    'Read [the style guide](https://example.com/style), the [reference](reference.md) next to this file, and never follow [this](javascript:alert(1)).',
    '',
    '![Architecture diagram](https://example.com/diagram.png)',
    '',
    '## Checklist',
    '',
    '- [x] Match the surrounding code',
    '- [ ] Release after verified work',
    '',
    '| Tool | When | Needs approval |',
    '| --- | --- | :-: |',
    '| `bun run verify` | Before every commit | No |',
    '| `publish-local-update.sh` | Releases only | **Yes** |',
    '',
    '> Plain words, short sentences.',
    '',
    '<example>',
    'User: ship it',
    'Assistant: runs the tests first',
    '</example>',
    '',
    '<script>alert("never runs")</script>',
    '',
    'An inline <img src="x" onerror="alert(1)"> stays text, as does <b onclick="alert(2)">this</b>.',
    '',
    '<!-- A note to self that the preview leaves out. -->',
    '',
    '```sh',
    'bun run verify && bun run build',
    '```',
    '',
  ].join('\n');
  const skill = setupSkills['~/.claude/skills/release-notes']?.['casey-mbp']?.[0];
  if (skill) {
    skill.content = [
      '---',
      'name: release-notes',
      'description: "Write release notes from the commits since the last tag. Use when: the user asks what changed."',
      'allowed-tools: [Read, "Bash(changelog:*)", Grep]',
      'metadata:',
      '  owner: casey',
      '  version: 3',
      'when_to_use: >',
      '  After a release is tagged,',
      '  or when asked for a changelog.',
      '---',
      '',
      '# Release notes',
      '',
      '1. List the commits since the last tag.',
      '2. Group them by what changed for people using the app.',
      '',
    ].join('\n');
  }
}
// With `?diff=far`, casey-mbp's and ci-01's CLAUDE.md are long and have nothing in common past their first lines, too
// far apart to line up, so the comparison shows everything between as removed and added.
if (params.get('diff') === 'far') {
  const lines = (word: string) => Array.from({ length: 1_400 }, (_, index) => `- ${word} rule ${index + 1}: keep ${word} things tidy.`);
  setupTexts.c2b9 = ['# Working agreement', '', ...lines('local'), ''].join('\n');
  setupTexts.c1a7 = ['# Working agreement', '', ...lines('ci'), ''].join('\n');
}
// With `?diff=folded`, casey-mbp's and ci-01's CLAUDE.md are 260 lines long and differ by a word at lines 3, 36 and
// 250, so the comparison folds the unchanged lines between: 26 that open at once, 207 that open a hundred at a time,
// and the 7 at the end.
if (params.get('diff') === 'folded') {
  const rules = (words: Record<number, string>) => Array.from({ length: 258 }, (_, index) => `- Rule ${index + 1}: keep ${words[index + 1] ?? 'things'} tidy.`);
  setupTexts.c2b9 = ['# Working agreement', '', ...rules({ 1: 'commits', 34: 'branches', 248: 'releases' }), ''].join('\n');
  setupTexts.c1a7 = ['# Working agreement', '', ...rules({ 1: 'changes', 34: 'worktrees', 248: 'notes' }), ''].join('\n');
}
// With `?markdown=empty`, ci-01's CLAUDE.md is empty, so its Preview says there's nothing in it.
if (params.get('markdown') === 'empty') setupTexts.c1a7 = '';

// With `?chunks=slow`, the file viewers take four seconds to load the first time one is shown, so the placeholder
// they show meanwhile can be seen; with `?chunks=fail`, they fail to load, as a module the webview can't fetch does,
// so the viewer says it couldn't show the file.
const chunkMock = window as Window & { __mockChunkDelayMs?: number; __mockChunkFail?: string };
if (params.get('chunks') === 'slow') chunkMock.__mockChunkDelayMs = 4_000;
if (params.get('chunks') === 'fail') chunkMock.__mockChunkFail = 'Importing a module script failed.';

/** The item a machine's last scan found at `path`, as the real reads insist on. */
const scannedSetupItem = (machine: string, path: string) => {
  const entry = setupMachines.find((candidate) => candidate.machine === machine);
  const found = [...(entry?.homes ?? []), ...(entry?.harnessHomes ?? [])].flatMap((home) => home.items).find((item) => item.path === path && item.sum !== null);
  if (!found) throw new Error('Arbor can only show what its last scan of this machine found. Scan again.');
  return found;
};

// With `?setupchange=1`, a scan finds ci-01's linear MCP server changed five seconds after the page loads, as if
// someone edited it there; `many` adds a new hook, a plugin and a marketplace, takes a server away and adds one to
// Pi's home.
const setupChangeScenario = params.get('setupchange');
if (setupChangeScenario) {
  window.setTimeout(() => {
    const changes = [
      { home: '~/.claude', kind: 'mcp', name: 'linear', change: 'changed' },
      ...(setupChangeScenario === 'many'
        ? [
            { home: '~/.claude', kind: 'hook', name: 'PreToolUse', change: 'added' },
            { home: '~/.claude', kind: 'plugin', name: 'deploy@acme-tools', change: 'added' },
            { home: '~/.claude', kind: 'marketplace', name: 'acme-tools', change: 'added' },
            { home: '~/.codex', kind: 'mcp', name: 'sentry', change: 'removed' },
            { home: '~/.pi/agent', kind: 'mcp', name: 'browser', change: 'added' },
          ]
        : []),
    ];
    void emit('setup-changed', { machine: 'ci-01', changes });
  }, 5_000);
}

export const scanSetupMock = (machine: string | null, staleOnly: boolean) => {
  const at = Date.now();
  const targets = setupMachines.filter((entry) => (machine === null || entry.machine === machine) && !entry.scanning
    && (!staleOnly || (entry.reachable && (entry.scannedAt === null || at - entry.scannedAt >= 10 * 60_000))));
  if (!targets.length) return;
  for (const entry of targets) entry.scanning = true;
  void emit('setup-inventory-updated', at);
  targets.forEach((entry, index) => window.setTimeout(() => {
    entry.scanning = false;
    entry.scannedAt = Date.now();
    const found = unscanned.get(entry.machine);
    if (found && entry.reachable) {
      Object.assign(entry, found);
      unscanned.delete(entry.machine);
    }
    entry.error = !entry.reachable
      ? `ssh: connect to host ${entry.machine} port 22: Connection refused`
      : setupScenario === 'fail' && entry.machine === 'ci-01' ? 'ssh: connect to host ci-01 port 22: Operation timed out' : null;
    void emit('setup-inventory-updated', entry.scannedAt);
  }, 900 + index * 500));
};

// The setup repo: started from this Mac, then a planner subagent was added and the ship command tightened, so each
// machine has something to take in. ci-01's testing rule is a link, and it has a deploy command only it has;
// cedar-02 has no Codex. A commit on origin/main adding a review rule isn't pulled yet. The folder picker offers
// ~/src/agent-setup to use and ~/src/new-setup to start one in. `?repo=fail` makes reading the repo fail and
// `?repo=dirty` leaves its CLAUDE.md changed but not committed. `?sync=changed` has ci-01's CLAUDE.md change after
// it was read, so nothing changes there, and `?sync=fail` has the last of several files fail to write.
/** A commit, with the files and skills it holds. */
type MockRepoCommit = RepoCommit & { files: SetupRepoFile[]; skills: SetupRepoSkill[] };

type MockRepo = { commits: MockRepoCommit[]; incoming: MockRepoCommit[]; upstream: RepoUpstream | null; ignored: string[] };

const mockSha = (seed: string) => {
  let hash = 2_166_136_261;
  return Array.from({ length: 40 }, (_, index) => {
    hash = Math.imul(hash ^ seed.charCodeAt(index % seed.length) ^ index, 16_777_619) >>> 0;
    return (hash % 16).toString(16);
  }).join('');
};

const repoFile = (kind: SyncFileKind, path: string, sum: string): SetupRepoFile => {
  const size = setupTexts[sum]?.length ?? 0;
  return { path, kind, sum, ck: `c${parseInt(mockSha(sum).slice(0, 8), 16)}-${size}`, size };
};

const repoCommit = (subject: string, atMs: number, files: SetupRepoFile[], skills: SetupRepoSkill[] = []): MockRepoCommit => ({
  sha: mockSha(`${subject}${atMs}`), subject, atMs, files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  skills: [...skills].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
});

const skillSource = (source: string, name: string): SkillSource => ({
  source, sourceType: 'github', sourceUrl: `https://github.com/${source}.git`, ref: null, skillPath: `skills/${name}/SKILL.md`, skillFolderHash: mockSha(`${source}/${name}`),
});

const repoSkill = (name: string, sum: string, files: number, source: string | null, problem: SetupRepoSkill['problem'] = null): SetupRepoSkill => ({
  name, path: `~/.agents/skills/${name}`, sum: problem ? null : sum, ck: problem ? null : `c${parseInt(mockSha(sum).slice(0, 8), 16)}-${files * 40}`,
  files, size: files * 1_536, problem, source: source ? skillSource(source, name) : null,
});

// The store's skills as this Mac had them; frontend-design was committed by hand with its .env, so it can't be synced.
const startedSkills = [
  repoSkill('agents-md', 'q1', 3, 'casey/skills'),
  repoSkill('find-skills', 'q2', 1, 'vercel-labs/skills'),
  repoSkill('frontend-design', 'q3', 4, 'anthropics/skills', 'secret'),
  repoSkill('pdf', 'k1', 4, 'anthropics/skills'),
];

/** Each repo skill's files by its fingerprint, for comparing with a machine's copy. */
const repoSkillFiles: Record<string, SetupSkillFile[]> = {
  q2: [skillFile('SKILL.md', 'f1', findSkillsDoc(['Search the skills directory for the task at hand.', 'Suggest the best match with its install command.']))],
  'q2-new': [
    skillFile('SKILL.md', 'f2', findSkillsDoc(['Search the skills directory for the task at hand.', 'Check the skill’s source and install count first.', 'Suggest the best match with its install command.'])),
    skillFile('references/sources.md', 'f3', '# Trusted sources\n\n- anthropics/skills\n- vercel-labs/skills\n'),
  ],
};

// How each skill's source stands, as GitHub would say; find-skills has a newer copy there.
const sourceStates: Record<string, SourceState> = { 'agents-md': 'current', 'find-skills': 'update', 'frontend-design': 'changedHere', pdf: 'current' };

let sourcesCheckedAt: number | null = null;

const startedFiles = [
  repoFile('instructions', '~/.claude/CLAUDE.md', 'c2b9'),
  repoFile('rule', '~/.claude/rules/testing.md', 'r7d0'),
  repoFile('subagent', '~/.claude/agents/reviewer.md', 'a1'),
  repoFile('command', '~/.claude/commands/ship.md', 'm1'),
  repoFile('instructions', '~/.codex/AGENTS.md', 'g1'),
];

// `?hooks=sample`: the repo keeps two hook scripts, which its hooks run.
if (hooksSample) {
  setupTexts.hs1 = '#!/bin/sh\n# Stops shell commands that would push to main.\ngrep -q "git push.*main" && exit 2\nexit 0\n';
  setupTexts.hs2 = '#!/usr/bin/env python3\n# Rings the bell when a session stops.\nprint("\\a", end="")\n';
}

const tightenedFiles = [
  ...startedFiles.filter((file) => file.path !== '~/.claude/commands/ship.md'),
  repoFile('command', '~/.claude/commands/ship.md', 'm2'),
  repoFile('subagent', '~/.claude/agents/planner.md', 'a2'),
  ...(hooksSample ? [repoFile('hookScript', '~/.agents/hooks/guard.sh', 'hs1'), repoFile('hookScript', '~/.agents/hooks/notify.py', 'hs2')] : []),
];

export const MOCK_REPO = '/Users/casey/src/agent-setup';

const setupRepos: Record<string, MockRepo> = {
  [MOCK_REPO]: {
    commits: [
      repoCommit('Start from casey-mbp', Date.now() - 6 * 86_400_000, startedFiles, startedSkills),
      repoCommit('Add a planner and tighten shipping', Date.now() - 26 * 3_600_000, tightenedFiles, startedSkills),
    ],
    incoming: [repoCommit('Add the review rule', Date.now() - 50 * 60_000, [...tightenedFiles, repoFile('rule', '~/.claude/rules/review.md', 'r8e2')], startedSkills)],
    upstream: { name: 'origin/main', ahead: 0, behind: 1 },
    ignored: ['.claude/settings.json', '.agents/commands/review.md'],
  },
};

/**
 * Skills with a machine's own value (.agents/machines.json); `?skillmachines=sample` keeps pdf off ci-01 and lets
 * cedar-02 keep its own frontend-design.
 */
const mockSkillMachines: Record<string, Record<string, SkillWanted>> = params.get('skillmachines') === 'sample'
  ? { pdf: { ci01: 'off' }, 'frontend-design': { cedar02: 'own' } }
  : {};

/**
 * Skills with a project's own value (.agents/machines.json). `?skillprojects=sample`: pdf off in casey/arbor on every
 * machine (the Mac's main checkout already has it off), frontend-design on there, which only casey-mbp has installed.
 */
const skillProjectsSample = ['sample', 'seen'].includes(params.get('skillprojects') ?? '');
const mockSkillProjects: Record<string, Record<string, RepoProjectValue>> = skillProjectsSample
  ? { pdf: { 'casey/arbor': { all: 'off', machines: {} } }, 'frontend-design': { 'casey/arbor': { all: 'on', machines: {} } } }
  : {};

/**
 * MCP servers with a project's own value (.agents/machines.json). `?mcpprojects=sample`: linear off in casey/arbor on
 * every machine (the Mac's main checkout already denies it), sentry on there, which the Mac sets up per checkout, ci-01
 * has no definition for, cedar-02's main checkout denies in its checked-in settings and brave-otter turned off with /mcp.
 */
const mcpProjectsSample = params.get('mcpprojects') === 'sample';
const mockMcpProjects: Record<string, Record<string, RepoProjectValue>> = mcpProjectsSample
  ? { linear: { 'casey/arbor': { all: 'off', machines: {} } }, sentry: { 'casey/arbor': { all: 'on', machines: {} } } }
  : {};

/**
 * Plugins the repo lists (.agents/plugins.json). `?pluginrepo=sample`: agency removed everywhere (ci-01 has it),
 * superpowers on everywhere but off on cedar-02,
 * context7 on with ci-01 keeping its own, pr-review-toolkit off everywhere; for casey/arbor, context7 off on every machine
 * and superpowers on ci-01 (P3: each arbor checkout's local settings).
 */
const mockRepoPlugins: RepoPlugin[] = params.get('pluginrepo') === 'sample'
  ? [
    { id: 'agency@agency-skills', source: 'acme/agency-skills', all: 'removed', machines: {}, projects: {} },
    { id: 'context7@claude-plugins-official', source: 'anthropics/claude-plugins-official', all: 'on', machines: { ci01: 'own' }, projects: { 'casey/arbor': { all: 'off', machines: {} } } },
    { id: 'pr-review-toolkit@claude-plugins-official', source: 'anthropics/claude-plugins-official', all: 'off', machines: {}, projects: {} },
    { id: 'superpowers@superpowers-marketplace', source: 'obra/superpowers-marketplace', all: 'on', machines: { cedar02: 'off' }, projects: { 'casey/arbor': { all: null, machines: { ci01: 'on' } } } },
  ]
  : [];

/**
 * `?pluginrepo=sample` also lists Codex plugins: sketch on everywhere, which the Mac has off, review, which no machine
 * has yet, and deploy, from a marketplace no machine has either, which Match adds first.
 */
const mockCodexRepoPlugins: RepoPlugin[] = params.get('pluginrepo') === 'sample'
  ? [
    { id: 'deploy@ops', source: 'acme/codex-ops', all: 'on', machines: {}, projects: {} },
    { id: 'review@team', source: 'acme/codex-plugins', all: 'on', machines: {}, projects: {} },
    { id: 'sketch@team', source: 'acme/codex-plugins', all: 'on', machines: {}, projects: {} },
  ]
  : [];

/**
 * Projects' own instructions (.agents/projects/<owner>/<name>/), by `project\u0000machine` with '' for every machine.
 * `?projectinstructions=sample`: casey/arbor has text for every machine and ci-01 its own. The Mac's main checkout has
 * Arbor's CLAUDE.local.md from an older text, its projects-tab worktree a CLAUDE.local.md of someone's own, and
 * cedar-02's brave-otter worktree doesn't ignore one.
 */
const projectInstructionsSample = params.get('projectinstructions') === 'sample';
const mockInstructions: Record<string, string> = projectInstructionsSample
  ? {
    'casey/arbor\u0000': '# Casey\'s notes for Arbor\n\n- Serve the mock on 127.0.0.1:1421, never `bun tauri dev`.\n- Share a design review before any look change ships.\n- Release the next free patch once verify, build and cargo test pass.\n',
    'casey/arbor\u0000ci01': '# Arbor on ci-01\n\n- This machine only runs `bun run verify` and `cargo test`; never build a DMG here.\n',
  }
  : {};

/** Stands in for the fingerprint Arbor's files name a text by. */
const instructionsHash = (text: string) => {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0').concat('beef');
};

const repoInstructions = (): RepoInstructions[] => Object.entries(mockInstructions).map(([key, text]) => {
  const [project = '', machine = ''] = key.split('\u0000');
  return { project, machine: machine || null, hash: instructionsHash(text), size: text.length };
});

/** The text a project's checkouts on a machine get: the machine's own, else every machine's. */
const instructionsFor = (project: string, machine: string) =>
  mockInstructions[`${project}\u0000${machine.toLowerCase().replace(/[^a-z0-9]/g, '')}`] ?? mockInstructions[`${project}\u0000`] ?? null;

/** Skills the repo has taken off every machine, and what each had in the repo before, to put back. */
const mockRemovedSkills = new Set<string>();
const removedRepoSkills = new Map<string, SetupRepoSkill>();
/** Rules, subagents and commands the repo has taken off every machine, and what the repo had of each, to put back. */
const mockRemovedFiles = new Set<string>();
/** Machines' own values for a rule, subagent or command: path → normalized machine → value. */
const mockFileMachines: Record<string, Record<string, SkillWanted>> = {};
const removedRepoFiles = new Map<string, SetupRepoFile>();

const repoHead = (repo: MockRepo) => repo.commits[repo.commits.length - 1] ?? null;

const setupRepoReply = (path: string): SetupRepo => {
  const repo = setupRepos[path];
  if (!repo || params.get('repo') === 'fail') throw `${path} isn't in a git repo`;
  const head = repoHead(repo);
  return {
    path,
    branch: 'main',
    head: head ? { sha: head.sha, subject: head.subject, atMs: head.atMs } : null,
    upstream: repo.upstream,
    uncommitted: [...new Set([...worktreeOf(path).keys()].flatMap((file) => {
      const skill = skillOf(file);
      return skill ? [`~/${skillFolder(skill)}`] : syncKind(`~/${file}`) ? [`~/${file}`] : [];
    }))],
    files: head?.files ?? [],
    skills: head?.skills ?? [],
    ignored: repo.ignored,
    skillMachines: structuredClone(mockSkillMachines),
    removedSkills: [...mockRemovedSkills].filter((name) => !head?.skills.some((skill) => skill.name === name)),
    removedFiles: [...mockRemovedFiles].filter((path) => !head?.files.some((file) => file.path === path)),
    fileMachines: structuredClone(mockFileMachines),
    skillProjects: structuredClone(mockSkillProjects),
    mcpProjects: structuredClone(mockMcpProjects),
    plugins: structuredClone(mockRepoPlugins),
    codexPlugins: structuredClone(mockCodexRepoPlugins),
    instructions: repoInstructions(),
  };
};

const mockRepo = (path: string) => {
  const repo = setupRepos[path];
  if (!repo) throw `${path} isn't in a git repo`;
  return repo;
};

type MockSetupBackup = SetupBackup & {
  /** What each file was before, and what the change left, to put back and to check against. */
  was: Record<string, SetupItem | null>; left: Record<string, string | null>;
  /** What each skill's home and the store had before, and what the change left, by `home\u0000name`. */
  skillWas: Record<string, { home: SetupItem | null; store: SetupItem | null }>;
  skillLeft: Record<string, { home: string; store: string }>;
};

const setupBackups: Record<string, MockSetupBackup[]> = {};

const syncedHome = (entry: SetupMachine, path: string): { items: SetupItem[] } | null =>
  entry.homes.find((home) => (home.path === '~/.claude' || home.path === '~/.codex' || (home.path === '~/.agents' && path.startsWith('~/.agents/hooks/'))) && path.startsWith(`${home.path}/`))
  ?? entry.harnessHomes.find((home) => HARNESS_SYNC_HOMES.some((sync) => sync.harness === home.harness && sync.path === home.path) && path === `${home.path}/AGENTS.md`)
  ?? null;

/** A store skill's name, from where setup sync puts it. */
const storeSkillName = (path: string) => /^~\/\.agents\/skills\/([^/]+)$/.exec(path)?.[1] ?? null;

const syncedItem = (entry: SetupMachine, path: string) => {
  const skill = storeSkillName(path);
  if (skill) return skillIn(storeHomeOf(entry, false), skill);
  return syncedHome(entry, path)?.items.find((item) => item.path === path) ?? null;
};

/** Puts `item` where `path` is on a machine, or takes away what's there. Items are shared between machines, so none is changed in place. */
const placeSyncedItem = (entry: SetupMachine, path: string, item: SetupItem | null) => {
  const skill = storeSkillName(path);
  if (skill) {
    placeSkill(storeHomeOf(entry, true)!, skill, item);
    return;
  }
  const home = syncedHome(entry, path);
  if (!home) return;
  const items = [...home.items];
  const index = items.findIndex((existing) => existing.path === path);
  if (index >= 0 && item) items[index] = item;
  else if (index >= 0) items.splice(index, 1);
  else if (item) items.push(item);
  home.items = items;
};

const mockStamp = (atMs = Date.now()) => `${new Date(atMs).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z-${Math.floor(Math.random() * 65_536).toString(16).padStart(4, '0')}`;

/** A settings file another feature changed on its own, as the list of changes has it. */
export const recordEditMock = (machine: string, what: ChangeKind, files: { path: string; added: boolean }[], atMs = Date.now()): string | null => {
  if (!files.length) return null;
  const backup: MockSetupBackup = {
    id: mockStamp(atMs), atMs, what, commit: null, undoneAtMs: null, was: {}, left: {}, skills: [], skillWas: {}, skillLeft: {},
    files: files.map(({ path, added }) => ({ path, change: added ? 'added' : 'changed', skill: false })),
  };
  setupBackups[machine] = [backup, ...(setupBackups[machine] ?? [])].sort((a, b) => b.atMs - a.atMs).slice(0, 20);
  return backup.id;
};
if (params.get('changes') !== 'none' && !freshInstall) {
  recordEditMock('casey-mbp', 'reporter', [{ path: '~/.claude/settings.json', added: false }, { path: '~/.codex/config.toml', added: false }], Date.now() - 3 * 86_400_000);
  recordEditMock('casey-mbp', 'keepSessions', [{ path: '~/.agent-app/homes/claude-proxy/settings.json', added: true }], Date.now() - 26 * 3_600_000);
}

const applySetupMock = (entry: SetupMachine, commit: MockRepoCommit, changes: SyncChange[]): SyncOutcome => {
  const { files, skills } = commit;
  const scenario = params.get('sync');
  const moved = changes.filter((change) => (syncedItem(entry, change.path)?.sum ?? null) !== change.before
    || (scenario === 'changed' && entry.machine === 'ci-01' && change.path === '~/.claude/CLAUDE.md'));
  if (moved.length) {
    scanSetupMock(entry.machine, false);
    return { backup: null, done: [], failed: moved.map((change) => ({ path: change.path, reason: 'changed' })) };
  }
  const backup: MockSetupBackup = { id: mockStamp(), atMs: Date.now(), what: 'sync', commit: commit.sha, undoneAtMs: null, files: [], was: {}, left: {}, skills: [], skillWas: {}, skillLeft: {} };
  const outcome: SyncOutcome = { backup: backup.id, done: [], failed: [] };
  changes.forEach((change, index) => {
    const was = syncedItem(entry, change.path);
    const skillName = storeSkillName(change.path);
    const skill = skillName ? skills.find((candidate) => candidate.name === skillName && candidate.sum !== null) ?? null : null;
    const file = files.find((candidate) => candidate.path === change.path) ?? null;
    backup.files.push({ path: change.path, change: change.remove ? 'removed' : was ? 'changed' : 'added', skill: skillName !== null });
    backup.was[change.path] = was;
    backup.left[change.path] = change.remove ? null : (skill?.sum ?? file?.sum ?? null);
    if ((scenario === 'fail' && changes.length > 1 && index === changes.length - 1) || (!change.remove && !file && !skill)) {
      outcome.failed.push({ path: change.path, reason: 'failed' });
      return;
    }
    if (change.remove) placeSyncedItem(entry, change.path, null);
    else if (skill) {
      placeSyncedItem(entry, change.path, setupSkill(skill.name, skill.path, skill.sum!, skill.files, skill.source?.source ?? null));
    } else if (!file) placeSyncedItem(entry, change.path, null);
    else {
      const name = change.path.split('/').pop() ?? change.path;
      placeSyncedItem(entry, change.path, was
        ? { ...was, sum: file.sum, size: file.size, link: null, text: true }
        : setupFile(file.kind === 'hookScript' ? 'hook' : file.kind, file.kind === 'subagent' || file.kind === 'command' ? name.replace(/\.md$/, '') : name, file.path, file.sum, file.size));
    }
    outcome.done.push(change.path);
  });
  setupBackups[entry.machine] = [backup, ...(setupBackups[entry.machine] ?? [])].slice(0, 20);
  scanSetupMock(entry.machine, false);
  return outcome;
};

// Skills: the store is ~/.agents/skills, and a Claude Code home loads a store skill through a link to it.
const mockStore = '~/.agents/skills';

const skillPlaceOf = (item: SetupItem | null | undefined) => (!item ? '-' : item.link ? `L${item.link}` : item.sum ? `D${item.sum}` : '?');

const skillHomeOf = (entry: SetupMachine, path: string): { items: SetupItem[]; skillsLink: string | null; agent?: SetupHome['agent'] } | null =>
  entry.homes.find((home) => home.path === path && (home.agent === 'claude' || home.agent === 'codex'))
  ?? entry.harnessHomes.find((home) => home.path === path)
  ?? null;

const storeHomeOf = (entry: SetupMachine, create: boolean) => {
  let store = entry.homes.find((home) => home.agent === 'shared') ?? null;
  if (!store && create) {
    store = setupHome('shared', '~/.agents', []);
    entry.homes.push(store);
  }
  return store;
};

const skillIn = (home: { items: SetupItem[] } | null, name: string) => home?.items.find((item) => item.kind === 'skill' && item.name === name) ?? null;

/** Puts `item` in a home's skills folder by `name`, or takes away what's there, without changing items other machines share. */
const placeSkill = (home: { items: SetupItem[] }, name: string, item: SetupItem | null) => {
  const items = home.items.filter((existing) => !(existing.kind === 'skill' && existing.name === name));
  home.items = item ? [...items, item] : items;
};

const storeLink = (home: string, name: string, of: SetupItem): SetupItem =>
  ({ ...of, path: `${home}/skills/${name}`, link: `${mockStore}/${name}` });

const applySkillsMock = (entry: SetupMachine, changes: SkillChange[]): SyncOutcome => {
  const scenario = params.get('skills');
  const store = storeHomeOf(entry, false);
  const moved = changes.flatMap((change, index) => {
    const home = skillHomeOf(entry, change.home);
    const stale = !home || home.skillsLink || skillPlaceOf(skillIn(home, change.name)) !== change.homeBefore
      || (change.action !== 'remove' && skillPlaceOf(skillIn(store, change.name)) !== change.storeBefore)
      || (scenario === 'changed' && index === 0);
    return stale ? [{ path: `${change.home}/skills/${change.name}`, reason: 'changed' as const }] : [];
  });
  if (moved.length) {
    scanSetupMock(entry.machine, false);
    return { backup: null, done: [], failed: moved };
  }
  const backup: MockSetupBackup = {
    id: mockStamp(), atMs: Date.now(), what: 'skills', commit: null, undoneAtMs: null, files: [], was: {}, left: {}, skills: [], skillWas: {}, skillLeft: {},
  };
  const outcome: SyncOutcome = { backup: backup.id, done: [], failed: [] };
  // What goes into the store first, so the links after it lead to it.
  const ordered = [...changes].sort((a, b) => Number(b.action === 'adopt') - Number(a.action === 'adopt'));
  ordered.forEach((change, index) => {
    const home = skillHomeOf(entry, change.home)!;
    const shared = storeHomeOf(entry, change.action === 'adopt')!;
    const key = `${change.home}\u0000${change.name}`;
    const path = `${change.home}/skills/${change.name}`;
    const own = skillIn(home, change.name);
    backup.skills.push({ home: change.home, name: change.name, action: change.action });
    backup.skillWas[key] = { home: own, store: skillIn(shared, change.name) };
    if (scenario === 'fail' && ordered.length > 1 && index === ordered.length - 1) {
      outcome.failed.push({ path, reason: 'failed' });
      backup.skillLeft[key] = { home: change.homeBefore, store: skillPlaceOf(skillIn(shared, change.name)) };
      return;
    }
    const claude = home.agent === 'claude';
    if (change.action === 'adopt' && own) {
      const adopted = { ...own, path: `${mockStore}/${change.name}`, link: null };
      placeSkill(shared, change.name, adopted);
      placeSkill(home, change.name, claude ? storeLink(change.home, change.name, adopted) : null);
    } else if (change.action === 'link' || change.action === 'useStore') {
      const target = skillIn(shared, change.name);
      if (target) placeSkill(home, change.name, storeLink(change.home, change.name, target));
    } else if (change.action === 'remove') {
      placeSkill(home, change.name, null);
    }
    backup.skillLeft[key] = { home: skillPlaceOf(skillIn(home, change.name)), store: skillPlaceOf(skillIn(shared, change.name)) };
    outcome.done.push(path);
  });
  setupBackups[entry.machine] = [backup, ...(setupBackups[entry.machine] ?? [])].slice(0, 20);
  scanSetupMock(entry.machine, false);
  return outcome;
};

const undoSkillsMock = (entry: SetupMachine, backup: MockSetupBackup): SyncOutcome => {
  const store = storeHomeOf(entry, false);
  const keyOf = (skill: MockSetupBackup['skills'][number]) => `${skill.home}\u0000${skill.name}`;
  const moved = backup.skills.filter((skill) => {
    const home = skillHomeOf(entry, skill.home);
    const now = { home: skillPlaceOf(skillIn(home, skill.name)), store: skillPlaceOf(skillIn(store, skill.name)) };
    const left = backup.skillLeft[keyOf(skill)];
    const was = backup.skillWas[keyOf(skill)];
    const asLeft = left && now.home === left.home && (skill.action === 'remove' || now.store === left.store);
    const asWas = was && now.home === skillPlaceOf(was.home);
    return !asLeft && !asWas;
  });
  if (moved.length) {
    scanSetupMock(entry.machine, false);
    return { backup: null, done: [], failed: moved.map((skill) => ({ path: `${skill.home}/skills/${skill.name}`, reason: 'changed' })) };
  }
  const done: string[] = [];
  for (const skill of [...backup.skills].reverse()) {
    const home = skillHomeOf(entry, skill.home);
    const was = backup.skillWas[keyOf(skill)];
    if (!home || !was || skillPlaceOf(skillIn(home, skill.name)) === skillPlaceOf(was.home)) continue;
    placeSkill(home, skill.name, was.home);
    if (skill.action === 'adopt') placeSkill(storeHomeOf(entry, true)!, skill.name, was.store);
    done.push(`${skill.home}/skills/${skill.name}`);
  }
  backup.undoneAtMs = Date.now();
  scanSetupMock(entry.machine, false);
  return { backup: null, done, failed: [] };
};

// Skill use in the last 30 days, from every machine's transcripts: release-notes and the drifted frontend-design
// copy's own skill see little use, and a few sessions are still to be read.
const skillUsage: SkillUsageReport = {
  skills: [
    { name: 'pdf', sessions: 14, calls: 31, lastMs: Date.now() - 40 * 60_000, machines: { 'casey-mbp': 9, 'ci-01': 5 } },
    { name: 'frontend-design', sessions: 6, calls: 11, lastMs: Date.now() - 3 * 3_600_000, machines: { 'casey-mbp': 6 } },
    { name: 'agents-md', sessions: 3, calls: 0, lastMs: Date.now() - 26 * 3_600_000, machines: { 'casey-mbp': 2, 'cedar-02': 1 } },
    { name: 'find-skills', sessions: 1, calls: 2, lastMs: Date.now() - 5 * 86_400_000, machines: { 'cedar-02': 1 } },
  ],
  counted: 212,
  pending: 4,
};

// MCP and plugin use in the last 30 days, by tool names: playwright hasn't been called, so it reads as unused.
const mcpUsage: McpUsageReport = {
  servers: [
    { name: 'linear', sessions: 9, calls: 41, lastMs: Date.now() - 2 * 3_600_000, machines: { 'casey-mbp': 6, 'ci-01': 3 } },
    { name: 'plugin_context7_context7', sessions: 5, calls: 12, lastMs: Date.now() - 5 * 3_600_000, machines: { 'casey-mbp': 5 } },
    { name: 'codex_apps', sessions: 3, calls: 4, lastMs: Date.now() - 26 * 3_600_000, machines: { 'casey-mbp': 3 } },
    { name: 'github', sessions: 2, calls: 5, lastMs: Date.now() - 4 * 86_400_000, machines: { 'ci-01': 2 } },
  ],
  plugins: [
    { name: 'superpowers', sessions: 11, calls: 17, lastMs: Date.now() - 50 * 60_000, machines: { 'casey-mbp': 8, 'ci-01': 3 } },
    { name: 'context7', sessions: 5, calls: 12, lastMs: Date.now() - 5 * 3_600_000, machines: { 'casey-mbp': 5 } },
  ],
  counted: 212,
  pending: 4,
};

// Plugin changes as `claude plugin` would make them. `?plugins=fail` has an install that runs a command its
// marketplace declares, which comes back for someone at the machine, and a marketplace that can't be fetched.
// Codex plugin changes. `?codexplugins=fail` has Codex refuse installs and removals the way it says so.
const applyCodexPluginsMock = (entry: SetupMachine, changes: CodexPluginChange[]): PluginResult[] => {
  const failing = params.get('codexplugins') === 'fail';
  // A marketplace is added before anything is installed from it.
  const ordered = [...changes].sort((a, b) => Number(b.action === 'addMarketplace') - Number(a.action === 'addMarketplace'));
  const results = ordered.map((change): PluginResult => {
    const result = (outcome: PluginOutcome, message: string): PluginResult => ({ home: change.home, action: change.action, target: change.target, checkout: null, outcome, message });
    const home = entry.homes.find((candidate) => candidate.path === change.home && candidate.agent === 'codex');
    if (!home) throw `${change.home} isn't a Codex home on this machine`;
    if (change.action === 'addMarketplace') {
      if (!change.source) throw `Arbor adds ${change.target} only from a GitHub repository, owner/name`;
      home.items.push(setupItem('marketplace', change.target, `cxm-${change.target}`, { note: change.source }));
      return result('done', '');
    }
    const marketplace = change.target.split('@')[1] ?? '';
    if (marketplace === 'openai-bundled' || marketplace === 'openai-primary-runtime') throw `${marketplace} is the Codex app's own, so Arbor leaves its plugins as the app has them`;
    const found = home.items.find((item) => item.kind === 'plugin' && item.name === change.target);
    if (failing && (change.action === 'install' || change.action === 'uninstall')) return result('failed', `plugin \`${change.target.split('@')[0] ?? ''}\` was not found in marketplace \`${marketplace}\``);
    switch (change.action) {
      case 'install':
        home.items.push(setupItem('plugin', change.target, `cx-${change.target}`, { enabled: true }));
        return result('done', '');
      case 'uninstall':
        home.items = home.items.filter((item) => item !== found);
        return result('done', '');
      case 'enable':
      case 'disable':
        if (!found) throw `Arbor can't ${change.action === 'enable' ? 'turn on' : 'turn off'} ${change.target} in ${change.home} as it is`;
        found.enabled = change.action === 'enable';
        return result('done', '');
      default:
        throw `Arbor can't change ${change.target} that way in Codex`;
    }
  });
  if (changes.some((change) => change.action === 'enable' || change.action === 'disable')) {
    recordEditMock(entry.machine, 'plugins', changes.map((change) => ({ path: `${change.home}/config.toml`, added: false })));
  }
  scanSetupMock(entry.machine, false);
  return results;
};

const applyPluginsMock = (entry: SetupMachine, changes: PluginChange[]): PluginResult[] => {
  const order: PluginAction[] = ['addMarketplace', 'refresh', 'install', 'update', 'enable', 'disable', 'uninstall'];
  const sorted = [...changes].sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
  const newest = (id: string) => setupMachines.flatMap((machine) => machine.homes).flatMap((home) => home.items)
    .filter((item) => item.kind === 'plugin' && item.name === id && typeof item.value === 'string')
    .flatMap((item) => (item.value === null ? [] : [item.value])).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ?? '1.0.0';
  const failing = params.get('plugins') === 'fail';
  const failedAdds = new Set<string>();
  const results = sorted.map((change) => {
    const home = entry.homes.find((candidate) => candidate.path === change.home);
    const found = home?.items.find((item) => item.kind === (change.action === 'addMarketplace' || change.action === 'refresh' ? 'marketplace' : 'plugin') && item.name === change.target);
    const result = (outcome: PluginOutcome, message: string): PluginResult => ({ home: change.home, action: change.action, target: change.target, checkout: change.checkout ?? null, outcome, message });
    if (!home) return result('failed', `${change.home} isn't a Claude Code home on this machine`);
    if (change.checkout) {
      // A project's value, in the checkout's own .claude/settings.local.json.
      const worktree = projectsState.find((scan) => scan.machine === entry.machine)?.repos.flatMap((repo) => repo.worktrees).find((candidate) => candidate.path === change.checkout);
      if (!worktree) return result('failed', 'The checkout isn\'t there any more');
      const on = change.action === 'enable';
      worktree.plugins = [...worktree.plugins.filter((plugin) => !(plugin.local && plugin.id === change.target)), { id: change.target, on, local: true }];
      return result('done', `Successfully ${on ? 'enabled' : 'disabled'} plugin: ${change.target} (scope: local)`);
    }
    const marketplace = change.target.split('@')[1] ?? '';
    if (change.action === 'install' && failedAdds.has(marketplace)) return result('skipped', "Its marketplace couldn't be added");
    if (failing && change.action === 'refresh') return result('failed', 'fatal: could not read from remote repository.');
    if (failing && change.action === 'install') return result('needsYou', 'The install command was only displayed, not run.');
    switch (change.action) {
      case 'addMarketplace':
        if (failing) { failedAdds.add(change.target); return result('failed', `Failed to clone https://github.com/${change.source ?? ''}.git: repository not found`); }
        home.items.push(setupItem('marketplace', change.target, `mk-${change.target}`, { note: change.source ?? null, value: mockAgo(0) }));
        return result('done', `Successfully added marketplace: ${change.target} (declared in user settings)`);
      case 'refresh':
        if (found) Object.assign(found, { value: mockAgo(0) });
        return result('done', `Successfully updated marketplace: ${change.target}`);
      case 'install':
        if (found) Object.assign(found, { value: newest(change.target), enabled: true, note: mockAgo(0) });
        else home.items.push(setupItem('plugin', change.target, `p-${change.target}`, { value: newest(change.target), enabled: true, note: mockAgo(0) }));
        return result('done', `Successfully installed plugin: ${change.target} (scope: user)`);
      case 'update': {
        const version = newest(change.target);
        if (found?.value === version) return result('already', `${change.target.split('@')[0]} is already at the latest version (${version}).`);
        if (found) Object.assign(found, { value: version, note: mockAgo(0) });
        return result('done', `Plugin "${change.target}" updated to ${version}`);
      }
      case 'enable':
      case 'disable':
        if (found) Object.assign(found, { enabled: change.action === 'enable' });
        return result('done', `Successfully ${change.action}d plugin: ${change.target.split('@')[0]} (scope: user)`);
      default:
        home.items = home.items.filter((item) => item !== found);
        return result('done', `Successfully uninstalled plugin: ${change.target.split('@')[0]} (scope: user)`);
    }
  });
  scanSetupMock(entry.machine, false);
  return results;
};

// How each server answers `claude mcp list`: linear needs signing in to on ci-01, github can't connect, and a
// plugin's server and a claude.ai connector show up beside what's set up. `?mcp=fail` makes ci-01's check fail.
// What `claude plugin details` says each plugin costs. With `?plugincost=fail`, cedar-02's measure fails; with
// `old`, ci-01's Claude Code is too old to say.
const PLUGIN_COSTS: Record<string, { alwaysOn: number; components: [string, number, number, boolean?][]; counts: Record<string, number> }> = {
  'superpowers@superpowers-marketplace': {
    alwaysOn: 2_140,
    components: [['brainstorming', 180, 2_300], ['writing-plans', 160, 1_900], ['test-driven-development', 150, 2_600], ['systematic-debugging', 170, 2_100], ['code-reviewer', 120, 900], ['using-git-worktrees', 140, 1_400], ['verification', 20, 20, true]],
    counts: { skills: 14, agents: 1, hooks: 1, mcpServers: 0, lspServers: 0 },
  },
  'context7@claude-plugins-official': { alwaysOn: 60, components: [], counts: { skills: 0, agents: 0, hooks: 0, mcpServers: 1, lspServers: 0 } },
  'pr-review-toolkit@claude-plugins-official': {
    alwaysOn: 610,
    components: [['review-pr', 90, 1_200], ['code-reviewer', 110, 1_500], ['silent-failure-hunter', 100, 1_300], ['type-design-analyzer', 95, 1_100]],
    counts: { skills: 1, agents: 6, hooks: 0, mcpServers: 0, lspServers: 0 },
  },
};

const pluginCostsMock = (entry: SetupMachine, home: string): PluginCosts => {
  const scenario = params.get('plugincost');
  if (scenario === 'fail' && entry.machine === 'cedar-02') throw 'ssh: connect to host cedar-02 port 22: Operation timed out';
  if (scenario === 'old' && entry.machine === 'ci-01') throw "This version of Claude Code can't say what a plugin costs. Update it first.";
  const items = entry.homes.find((candidate) => candidate.path === home)?.items ?? [];
  const plugins = items.filter((item) => item.kind === 'plugin' && typeof item.value === 'string').map((item) => {
    const known = PLUGIN_COSTS[item.name];
    const estimate = (tokens: number, under = false) => ({ tokens, under });
    return known
      ? {
          id: item.name,
          alwaysOn: estimate(known.alwaysOn),
          components: known.components.map(([name, always, invoke, under]) => ({ name, alwaysOn: estimate(always, under), onInvoke: estimate(invoke, under) })),
          counts: known.counts,
          error: null,
        }
      : { id: item.name, alwaysOn: null, components: [], counts: {}, error: 'claude plugin details stopped with code 1 there' };
  });
  return { home, measuredAt: Date.now(), plugins };
};

const mcpHealthMock = (entry: SetupMachine, path: string): McpHealth => {
  if (params.get('mcp') === 'fail' && entry.machine === 'ci-01') throw 'ssh: connect to host ci-01 port 22: Operation timed out';
  const home = entry.homes.find((candidate) => candidate.path === path && candidate.agent === 'claude');
  if (!home) throw `${path} isn't a Claude Code home on this machine`;
  const status = (name: string, enabled: boolean | null): McpStatus => {
    if (enabled === false) return 'disabled';
    if (name === 'github') return 'failed';
    if (name === 'linear' && entry.machine === 'ci-01') return 'needsAuth';
    return 'connected';
  };
  const servers = home.items.filter((item) => item.kind === 'mcp').map((item) => ({ name: item.name, status: status(item.name, item.enabled) }));
  if (home.items.some((item) => item.kind === 'plugin' && item.name.startsWith('context7@') && item.value && item.enabled !== false)) {
    servers.push({ name: 'plugin:context7:context7', status: entry.machine === 'ci-01' ? 'failed' : 'connected' });
  }
  if (entry.local && path === '~/.claude') servers.push({ name: 'claude.ai Gmail', status: 'needsAuth' });
  return { home: path, checkedAt: Date.now(), servers };
};

// The setup repo's MCP servers. linear is defined for both agents, kept to each machine's main homes, with a newer
// Claude Code definition that reads LINEAR_API_KEY than the Mac's and ci-01's, and cedar-02's own (its variant B);
// sentry is only in the repo, and notion's Claude Code definition holds a token, so it's refused. playwright and github are only on machines. linear
// also goes to Pi and Droid, and sentry to Pi and OpenCode, each as Claude Code's definition in its own shape: the Mac's
// Pi has linear as the repo does and its Droid an older one, ci-01's Pi an older one and sentry, which is kept off it,
// and cedar-02's OpenCode hasn't got sentry. Sums stand in for the
// fingerprints the backend compares. `?registry=none` starts with no file, `?registry=bad` with one Arbor can't
// read, `?registry=fail` can't read the repo, and `?registry=dirty` has changes not committed. `?mcpapply=fail`
// has Claude Code fail to set a replaced server up again, and Codex's config.toml change before it's written.
type MockDefinition = DefinitionView & { sum: string };

type MockRegistryServer = {
  name: string; claude: MockDefinition | null; codex: MockDefinition | null; homes: string[] | null;
  machines: Record<string, { claude?: MockDefinition | null; codex?: MockDefinition | null } | null>; agents: Harness[]; problems: string[];
};

const mockDefinition = (transport: string, place: string | null, variables: string[], sum: string): MockDefinition => ({ transport, place, variables, sum });

const mockRegistry: { found: boolean; servers: MockRegistryServer[] } = {
  found: params.get('registry') !== 'none',
  servers: params.get('registry') === 'none' ? [] : [
    {
      name: 'linear',
      claude: mockDefinition('http', 'mcp.linear.app', ['LINEAR_API_KEY'], 'x1r'),
      codex: mockDefinition('http', 'mcp.linear.app', ['LINEAR_API_KEY'], 'x1c'),
      homes: ['~/.claude', '~/.codex'],
      machines: { 'cedar-02': { claude: mockDefinition('sse', 'mcp.linear.app', [], 'x1e') } },
      agents: ['pi', 'droid'],
      problems: [],
    },
    {
      name: 'sentry',
      claude: mockDefinition('http', 'mcp.sentry.dev', ['SENTRY_TOKEN'], 'x5'),
      codex: mockDefinition('http', 'mcp.sentry.dev', ['SENTRY_TOKEN'], 'x5c'),
      homes: null,
      machines: { 'ci-01': null },
      agents: ['pi', 'openCode'],
      problems: [],
    },
    {
      name: 'notion',
      claude: mockDefinition('http', 'mcp.notion.com', [], 'x6'),
      codex: null,
      homes: ['~/.claude'],
      machines: {},
      agents: [],
      problems: ['claude: headers.Authorization looks like a secret. Refer to it with ${VAR} instead, so the repo never holds one.'],
    },
  ],
};

const mcpAgent = (agent: HomeAgent): AgentKind => (agent === 'claude' ? 'claude' : 'codex');

/** The definition a home should have, and whether it's the machine's own. */
const wantedMock = (server: MockRegistryServer, machine: string, agent: AgentKind, home: string): [MockDefinition, boolean] | null => {
  if (server.homes && !server.homes.includes(home)) return null;
  const choice = server.machines[machine];
  if (choice === null) return null;
  if (choice && agent in choice) {
    const own = choice[agent];
    return own ? [own, true] : null;
  }
  return server[agent] ? [server[agent], false] : null;
};

const registryCellsMock = (entry: SetupMachine) => entry.homes.filter((home) => home.agent === 'claude' || home.agent === 'codex').flatMap((home) => {
  const agent = mcpAgent(home.agent);
  const present = new Map(home.items.filter((item) => item.kind === 'mcp').map((item) => [item.name, item.sum]));
  const cell = (name: string, state: RegistryState, own: boolean, broken: boolean): RegistryCell => ({
    machine: entry.machine, home: home.path, name, state, own,
    blocked: !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) ? 'name' : broken && state !== 'extra' ? 'broken' : null,
  });
  const cells = mockRegistry.servers.flatMap((server) => {
    const wanted = wantedMock(server, entry.machine, agent, home.path);
    const found = present.has(server.name);
    if (wanted && !found) return [cell(server.name, 'add', wanted[1], server.problems.length > 0)];
    if (wanted) return [cell(server.name, present.get(server.name) === wanted[0].sum ? 'same' : 'update', wanted[1], server.problems.length > 0)];
    return found ? [cell(server.name, 'extra', false, false)] : [];
  });
  const known = new Set(mockRegistry.servers.map((server) => server.name));
  return [...cells, ...[...present.keys()].filter((name) => !known.has(name)).map((name) => cell(name, 'extra', false, false))];
}).concat(harnessCellsMock(entry));

/** The definition another agent's home should have, as Claude Code's in the agent's shape, and whether it's the machine's own. */
const wantedHarnessMock = (server: MockRegistryServer, machine: string, harness: Harness): [MockDefinition, boolean] | null => {
  if (!server.agents.includes(harness)) return null;
  const choice = server.machines[machine];
  if (choice === null) return null;
  const [definition, own] = choice && 'claude' in choice ? [choice.claude ?? null, true] : [server.claude, false];
  return definition ? [{ ...definition, sum: `${definition.sum}-${harness}` }, own] : null;
};

// The other agents' homes have only what the repo sends them.
function harnessCellsMock(entry: SetupMachine): RegistryCell[] {
  return entry.harnessHomes.flatMap((home) => {
    const present = new Map(home.items.filter((item) => item.kind === 'mcp').map((item) => [item.name, item.sum]));
    return mockRegistry.servers.flatMap((server): RegistryCell[] => {
      const wanted = wantedHarnessMock(server, entry.machine, home.harness);
      const found = present.has(server.name);
      const cell = (state: RegistryState, own: boolean): RegistryCell => ({
        machine: entry.machine, home: home.path, name: server.name, state, own, blocked: server.problems.length ? 'broken' : null,
      });
      if (wanted && !found) return [cell('add', wanted[1])];
      if (wanted) return [cell(present.get(server.name) === wanted[0].sum ? 'same' : 'update', wanted[1])];
      return found && server.agents.includes(home.harness) ? [cell('extra', false)] : [];
    });
  });
}

/** Where each agent keeps its MCP servers, in its home. */
const HARNESS_MCP_FILE: Partial<Record<Harness, string>> = { pi: 'mcp.json', droid: 'mcp.json', openCode: 'opencode.json', amp: 'settings.json' };

// Hooks the repo keeps (.agents/hooks.json), with `?hooks=sample`: guard on every machine's Claude Code homes, and
// notify in Claude Code and Codex, kept off ci-01.
// `?hooks=broken` gives notify a problem, `?hooks=bad` makes the file unreadable, `?hookapply=fail` has bringing a
// machine in step fail as if a settings file changed since the scan, and `?hooktake=secret` has taking one refused.
type MockHook = {
  name: string; event: string; matcher: string | null; command: string; script: string; timeout: number | null;
  agents: AgentKind[]; homes: string[] | null; removed: boolean; off: string[]; problems: string[];
};
const mockHooks: { found: boolean; hooks: MockHook[] } = {
  found: hooksSample || params.get('hooks') === 'bad',
  hooks: hooksSample ? [
    { name: 'guard', event: 'PreToolUse', matcher: 'Bash', command: '~/.agents/hooks/guard.sh', script: 'guard.sh', timeout: 30, agents: ['claude'], homes: null, removed: false, off: [], problems: [] },
    {
      name: 'notify', event: 'Stop', matcher: null, command: 'python3 ~/.agents/hooks/notify.py', script: 'notify.py', timeout: null, agents: ['claude', 'codex'], homes: null, removed: false, off: ['ci-01'],
      problems: params.get('hooks') === 'broken' ? ['timeout should be seconds, from 1 to 3600'] : [],
    },
  ] : [],
};
/** The hooks each Claude Code and Codex home runs from ~/.agents/hooks, by `machine\u0000home`, and whether each is the repo's copy. */
const mockHomeHooks: Record<string, { event: string; script: string; same: boolean }[]> = hooksSample ? {
  'casey-mbp\u0000~/.claude': [{ event: 'PreToolUse', script: 'guard.sh', same: true }, { event: 'Stop', script: 'notify.py', same: false }],
  'casey-mbp\u0000~/.codex': [{ event: 'Stop', script: 'notify.py', same: false }],
  'ci-01\u0000~/.claude': [{ event: 'PreToolUse', script: 'guard.sh', same: true }, { event: 'Stop', script: 'notify.py', same: true }, { event: 'SessionStart', script: 'old.sh', same: true }],
} : {};

const hookWantedMock = (hook: MockHook, machine: string, agent: AgentKind, home: string) =>
  !hook.removed && !hook.off.includes(machine) && hook.agents.includes(agent) && (hook.homes === null || hook.homes.includes(home));

/** The homes whose hooks the repo keeps, with the agent each is. */
const hookHomesMock = (entry: SetupMachine) =>
  entry.homes.flatMap((home) => (home.agent === 'claude' || home.agent === 'codex' ? [{ home, agent: home.agent }] : []));

const hookCellsMock = (entry: SetupMachine): HookCell[] => hookHomesMock(entry).flatMap(({ home, agent }) => {
  const there = mockHomeHooks[`${entry.machine}\u0000${home.path}`] ?? [];
  const cell = (name: string | null, event: string, script: string, state: HookState, broken: boolean): HookCell =>
    ({ machine: entry.machine, agent, home: home.path, name, event, script, state, blocked: broken ? 'broken' : null });
  const cells = mockHooks.hooks.flatMap((hook) => {
    const found = there.filter((entryHook) => entryHook.event === hook.event && entryHook.script === hook.script);
    const wanted = hookWantedMock(hook, entry.machine, agent, home.path);
    const broken = hook.problems.length > 0;
    if (wanted && !found.length) return [cell(hook.name, hook.event, hook.script, 'add', broken)];
    if (wanted) return [cell(hook.name, hook.event, hook.script, found.every((one) => one.same) ? 'same' : 'update', broken)];
    return found.length ? [cell(hook.name, hook.event, hook.script, 'extra', broken)] : [];
  });
  const extras = there.filter((one) => !mockHooks.hooks.some((hook) => hook.event === one.event && hook.script === one.script));
  return [...cells, ...extras.map((one) => cell(null, one.event, one.script, 'extra', false))];
});

const hookRegistryReply = (path: string): HookRegistry => {
  const repo = mockRepo(path);
  const bad = params.get('hooks') === 'bad';
  return {
    commit: repoHead(repo)?.sha ?? null,
    found: mockHooks.found,
    uncommitted: false,
    problems: bad ? [".agents/hooks.json isn't a JSON object Arbor can read"] : [],
    hooks: bad ? [] : mockHooks.hooks.map((hook) => ({
      name: hook.name, event: hook.event, matcher: hook.matcher, command: hook.command, script: hook.script, timeout: hook.timeout,
      agents: hook.agents, homes: hook.homes, removed: hook.removed, off: hook.off, problems: hook.problems,
    })),
    cells: bad ? [] : setupMachines.filter((entry) => entry.scannedAt !== null).flatMap(hookCellsMock),
  };
};

const setHookWantedMock = (path: string, name: string, machine: string | null, wanted: HookWanted): HookRegistry => {
  const hook = mockHooks.hooks.find((candidate) => candidate.name === name);
  if (!hook) throw `The repo hasn't got ${name}`;
  if (machine === null) {
    if (wanted === 'off') throw 'A hook is kept off one machine, or removed from every one';
    hook.removed = wanted === 'removed';
  } else {
    if (wanted === 'removed') throw 'A hook is removed from every machine, or kept off one';
    hook.off = wanted === 'off' ? [...new Set([...hook.off, machine])] : hook.off.filter((one) => one !== machine);
  }
  return hookRegistryReply(path);
};

const setHookAgentsMock = (path: string, name: string, agents: AgentKind[]): HookRegistry => {
  const hook = mockHooks.hooks.find((candidate) => candidate.name === name);
  if (!hook) throw `The repo hasn't got ${name}`;
  if (!agents.length) throw 'A hook goes to Claude Code, Codex or both';
  hook.agents = (['claude', 'codex'] as const).filter((agent) => agents.includes(agent));
  return hookRegistryReply(path);
};

const takeHookMock = (path: string, machine: string, home: string, event: string, script: string): HookRegistry => {
  const found = (mockHomeHooks[`${machine}\u0000${home}`] ?? []).find((one) => one.event === event && one.script === script);
  if (!found) throw 'Arbor can only take a hook its last scan of this machine found. Scan again.';
  if (params.get('hooktake') === 'secret') {
    throw 'Arbor didn’t take the hook: its command looks like it holds a secret, and the repo mustn’t hold one. Have the script read it from a variable, then take it again.';
  }
  const stem = script.split('.')[0] || 'hook';
  const name = mockHooks.hooks.some((hook) => hook.name === stem) ? `${stem}-${event.toLowerCase()}` : stem;
  const agent: AgentKind = setupMachines.find((entry) => entry.machine === machine)?.homes.find((one) => one.path === home)?.agent === 'codex' ? 'codex' : 'claude';
  mockHooks.hooks.push({ name, event, matcher: null, command: `~/.agents/hooks/${script}`, script, timeout: null, agents: [agent], homes: null, removed: false, off: [], problems: [] });
  mockHooks.found = true;
  return hookRegistryReply(path);
};

const applyHooksMock = (entry: SetupMachine): SettingsEdit[] => {
  const broken = mockHooks.hooks.filter((hook) => hook.problems.length).map((hook) => hook.name);
  if (broken.length) throw `Fix the repo's hooks first: ${broken.join(', ')}`;
  const cells = hookCellsMock(entry);
  const homes = hookHomesMock(entry).filter(({ home }) => cells.some((cell) => cell.home === home.path && cell.state !== 'same'));
  if (!homes.length) throw `${entry.machine}'s hooks are in step with the repo already`;
  const scripts = new Set(entry.homes.flatMap((home) => home.items).filter((item) => item.kind === 'hook' && item.path !== null).map((item) => item.name));
  const missing = [...new Set(homes.flatMap(({ home, agent }) => mockHooks.hooks.filter((hook) => hookWantedMock(hook, entry.machine, agent, home.path)).map((hook) => hook.script)))]
    .filter((script) => !scripts.has(script));
  if (missing.length) throw `${entry.machine} hasn't got ${missing.map((script) => `~/.agents/hooks/${script}`).join(', ')} yet. Bring its files in step with the repo first, then its hooks.`;
  if (params.get('hookapply') === 'fail') throw `${entry.machine}'s ~/.claude/settings.json changed since Arbor read it. Scan again, then try again.`;
  const edits: SettingsEdit[] = homes.map(({ home, agent }) => {
    mockHomeHooks[`${entry.machine}\u0000${home.path}`] = mockHooks.hooks
      .filter((hook) => hookWantedMock(hook, entry.machine, agent, home.path))
      .map((hook) => ({ event: hook.event, script: hook.script, same: true }));
    return { home: home.path, path: `${home.path}/${agent === 'codex' ? 'hooks.json' : 'settings.json'}`, change: 'edit', written: true, error: null };
  });
  recordEditMock(entry.machine, 'hooks', edits.map((edit) => ({ path: edit.path, added: false })));
  scanSetupMock(entry.machine, false);
  return edits;
};

const registryReply = (path: string): McpRegistry => {
  const repo = mockRepo(path);
  if (params.get('registry') === 'fail') throw `${path} isn't in a git repo`;
  const view = (definition: MockDefinition | null) => (definition ? { transport: definition.transport, place: definition.place, variables: definition.variables } : null);
  const bad = params.get('registry') === 'bad';
  return {
    commit: repoHead(repo)?.sha ?? null,
    found: mockRegistry.found,
    uncommitted: params.get('registry') === 'dirty',
    problems: bad ? [".agents/mcp-servers.json isn't a JSON object Arbor can read"] : [],
    servers: bad ? [] : mockRegistry.servers.map((server) => ({
      name: server.name, claude: view(server.claude), codex: view(server.codex), homes: server.homes, agents: server.agents,
      own: Object.entries(server.machines).filter(([, choice]) => choice && Object.values(choice).some(Boolean)).map(([machine]) => machine),
      off: Object.entries(server.machines).filter(([, choice]) => choice === null || Object.values(choice).some((definition) => definition === null)).map(([machine]) => machine),
      problems: server.problems,
    })),
    cells: bad ? [] : setupMachines.filter((entry) => entry.scannedAt !== null).flatMap(registryCellsMock),
  };
};

const applyMcpMock = (entry: SetupMachine, changes: McpChange[]): McpResult[] => {
  const failing = params.get('mcpapply') === 'fail';
  const cells = registryCellsMock(entry);
  const theirs = changes.filter((change) => entry.harnessHomes.some((home) => home.path === change.home));
  if (theirs.length) {
    const others = applyHarnessMcpMock(entry, theirs, cells, failing);
    const rest = changes.filter((change) => !theirs.includes(change));
    return rest.length ? [...others, ...applyMcpMock(entry, rest)] : others;
  }
  const sorted = [...changes].sort((a, b) => Number(entry.homes.find((home) => home.path === a.home)?.agent !== 'claude') - Number(entry.homes.find((home) => home.path === b.home)?.agent !== 'claude'));
  for (const change of sorted) {
    const cell = cells.find((candidate) => candidate.home === change.home && candidate.name === change.name);
    const fits = { add: 'add', update: 'update', remove: 'extra' }[change.action] === cell?.state;
    if (!fits) throw `Arbor can't ${change.action === 'add' ? 'set up' : change.action} ${change.name} in ${change.home} as it is`;
  }
  const results = sorted.map((change) => {
    const home = entry.homes.find((candidate) => candidate.path === change.home)!;
    const claude = home.agent === 'claude';
    const result = (outcome: McpOutcome, message: string): McpResult => ({ home: change.home, name: change.name, action: change.action, outcome, message });
    const server = mockRegistry.servers.find((candidate) => candidate.name === change.name);
    const wanted = server ? wantedMock(server, entry.machine, mcpAgent(home.agent), home.path)?.[0] ?? null : null;
    if (!claude && failing) return result('changed', 'config.toml changed after Arbor read it, so nothing in this home was changed. Scan and try again.');
    if (claude && failing && change.action === 'update') {
      home.items = home.items.filter((item) => !(item.kind === 'mcp' && item.name === change.name));
      return result('removed', 'Error: Invalid configuration: url: Invalid url');
    }
    if (change.action === 'remove') {
      home.items = home.items.filter((item) => !(item.kind === 'mcp' && item.name === change.name));
      return result('done', claude ? `Removed MCP server ${change.name} from user config` : '');
    }
    const item = setupItem('mcp', change.name, wanted?.sum ?? null, { value: wanted?.transport ?? null, note: wanted?.place ?? null });
    home.items = [...home.items.filter((existing) => !(existing.kind === 'mcp' && existing.name === change.name)), item];
    return result('done', claude ? `Added ${wanted?.transport === 'stdio' ? 'stdio' : 'HTTP'} MCP server ${change.name} to user config` : '');
  });
  // Codex's config.toml is edited like any settings file; Claude Code changes its own.
  const edited = new Set(results.filter((result) => result.outcome === 'done' && entry.homes.find((home) => home.path === result.home)?.agent !== 'claude').map((result) => `${result.home}/config.toml`));
  recordEditMock(entry.machine, 'mcp', [...edited].map((path) => ({ path, added: false })));
  scanSetupMock(entry.machine, false);
  return results;
};

/** Changes to the other agents' files: guarded edits, kept in one backup the toast's Undo takes them back from. */
const applyHarnessMcpMock = (entry: SetupMachine, changes: McpChange[], cells: RegistryCell[], failing: boolean): McpResult[] => {
  for (const change of changes) {
    const cell = cells.find((candidate) => candidate.home === change.home && candidate.name === change.name);
    const fits = { add: 'add', update: 'update', remove: 'extra' }[change.action] === cell?.state && !cell?.blocked;
    if (!fits) throw `Arbor can't ${change.action === 'add' ? 'set up' : change.action} ${change.name} in ${change.home} as it is`;
  }
  const edited = new Set<string>();
  const results = changes.map((change): McpResult => {
    const home = entry.harnessHomes.find((candidate) => candidate.path === change.home)!;
    const file = `${home.path}/${HARNESS_MCP_FILE[home.harness] ?? 'mcp.json'}`;
    const result = (outcome: McpOutcome, message: string): McpResult => ({ home: change.home, name: change.name, action: change.action, outcome, message });
    if (failing) return result('changed', `${file} changed after Arbor read it, so nothing in it was changed. Scan and try again.`);
    const server = mockRegistry.servers.find((candidate) => candidate.name === change.name);
    const wanted = server ? wantedHarnessMock(server, entry.machine, home.harness)?.[0] ?? null : null;
    home.items = home.items.filter((item) => !(item.kind === 'mcp' && item.name === change.name));
    if (change.action !== 'remove') home.items = [...home.items, setupItem('mcp', change.name, wanted?.sum ?? null, { value: wanted?.transport ?? null, note: wanted?.place ?? null })];
    edited.add(file);
    return result('done', '');
  });
  const backup = recordEditMock(entry.machine, 'mcp', [...edited].map((path) => ({ path, added: false })));
  scanSetupMock(entry.machine, false);
  return results.map((result) => (result.outcome === 'done' && backup ? { ...result, backup } : result));
};

// github's Claude Code definition on ci-01 sends a token in a header, so it's refused like the app refuses it.
// Each machine's git checkouts, as Sessions › Projects' Checkouts shows them. arbor is on all three machines with two
// versions of its .claude/CLAUDE.md (ci-01 has B) and no AGENTS.md on cedar-02; the Mac has a T3 Code worktree
// that's merged, a Claude Code one whose upstream was deleted, one with changes and one never merged. Sums stand in
// for the checksums the backend compares.
const projectsScenario = params.get('projects') ?? (freshInstall ? 'fresh' : null);

const mockWorktree = (path: string, branch: string | null, extra: Partial<ProjectWorktree> = {}): ProjectWorktree => ({
  path, main: false, head: `${path.length.toString(16)}a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9`, branch, locked: false, prunable: false,
  changed: 0, untracked: 0, upstream: branch ? `origin/${branch}` : null, ahead: 0, behind: 0, gone: false, merged: false,
  committedAt: hours(30), touchedAt: hours(30), open: false, hidden: 0, nested: false, midway: false, unreachable: 0, lastUsedMs: null, ignored: [], ignoredMore: 0, sizeKb: null, blocker: null,
  plugins: [], skills: [], ignoredOverrides: [], localSeen: false, mcpDenied: [], mcpLocal: [], mcpDisabled: [],
  instructions: [{ file: 'claudeLocal', state: 'none', text: null, import: null, agents: null }, { file: 'agentsOverride', state: 'none', text: null, import: null, agents: null }],
  agentsMd: null, claudeMd: false, ...extra,
});

/** A checkout's instruction files: `none`, `seen` or `own` for each, or Arbor's CLAUDE.local.md from the text `hash`. */
const instructionFiles = (claude: LocalFileState, codex: LocalFileState, hash: string | null = null): CheckoutInstructions[] => [
  { file: 'claudeLocal', state: claude, text: claude === 'arbor' ? hash : null, import: claude === 'arbor' ? false : null, agents: null },
  { file: 'agentsOverride', state: codex, text: null, import: null, agents: null },
];

const mainCheckout = (path: string, branch: string, extra: Partial<ProjectWorktree> = {}) => mockWorktree(path, branch, { main: true, blocker: 'main', merged: true, ...extra });

const projectRepo = (path: string, remote: string | null, worktrees: ProjectWorktree[], extra: Partial<ProjectRepo> = {}): ProjectRepo => {
  const files = extra.files ?? [];
  // Each checkout's AGENTS.md and CLAUDE.md, as the scan finds them, follow the repo's.
  const agents = files.find((file) => file.name === 'AGENTS.md');
  const claudeMd = files.some((file) => file.name === 'CLAUDE.md' || file.name === '.claude/CLAUDE.md');
  return {
    path, state: 'ok', bare: false, remote, defaultBranch: remote ? 'origin/main' : 'main', fetchedAt: hours(3), fetchFailed: false,
    lastUsedMs: hours(6), files: [], ...extra,
    worktrees: worktrees.map((worktree) => ({ ...worktree, agentsMd: agents ? `c${agents.sum.length}-${agents.size}` : null, claudeMd })),
  };
};

const arborFiles = (claude: string | null, agents: string | null) => [
  ...(claude ? [{ name: '.claude/CLAUDE.md', sum: claude, size: claude === 'arbor-b' ? 5_210 : 4_988 }] : []),
  ...(agents ? [{ name: 'AGENTS.md', sum: agents, size: 4_702 }] : []),
];

const projectRepos: Record<string, { homeDir: string; repos: ProjectRepo[] }> = {
  'casey-mbp': {
    homeDir: '/Users/casey',
    repos: [
      projectRepo('/Users/casey/src/arbor', 'github.com/casey/arbor', [
        // Its own settings already keep context7 off, as the sample setup repo wants for arbor; its worktrees don't yet.
        mainCheckout('/Users/casey/src/arbor', 'main', { behind: 2, lastUsedMs: hours(0.2), touchedAt: hours(0.2), plugins: [{ id: 'context7@claude-plugins-official', on: false, local: true }],
          skills: skillProjectsSample ? [{ name: 'pdf', state: 'off', local: true }] : [],
          mcpDenied: mcpProjectsSample ? [{ name: 'linear', local: true }] : [],
          ...(projectInstructionsSample ? { instructions: instructionFiles('arbor', 'none', 'a0c3e9d1beef') } : {}) }),
        mockWorktree('/Users/casey/.agent-app/worktrees/arbor/login-loop', 'fix/login-loop', {
          merged: true, gone: true, upstream: 'origin/fix/login-loop', ahead: null, behind: null, lastUsedMs: hours(52),
          ignored: ['.env.local', 'dist/', 'node_modules/'], mcpLocal: mcpProjectsSample ? ['sentry'] : [],
        }),
        // The one T3 Code made, in the folder T3 Code keeps its worktrees in, so the row shows whose it is; the others
        // sit in a made-up agent app's folder, which Arbor shows as plain worktrees.
        mockWorktree('/Users/casey/.t3/worktrees/arbor/projects-tab', 't3code/projects-tab', {
          ahead: 3, changed: 4, untracked: 1, open: true, lastUsedMs: hours(0.05), touchedAt: hours(0.05), blocker: 'dirty',
          ...(projectInstructionsSample ? { instructions: instructionFiles('own', 'none') } : {}),
        }),
        mockWorktree('/Users/casey/src/arbor/.claude/worktrees/quiet-fox', 'claude/quiet-fox', {
          gone: true, ahead: null, behind: null, lastUsedMs: hours(120), ignored: ['node_modules/'],
        }),
        mockWorktree('/Users/casey/.agent-app/worktrees/arbor/tray-spike', 'spike/tray', { upstream: null, ahead: null, behind: null, lastUsedMs: hours(400), blocker: 'notMerged' }),
        mockWorktree('/Users/casey/.agent-app/worktrees/arbor/local-config', 'chore/local-config', { merged: true, hidden: 2, lastUsedMs: hours(200), blocker: 'hidden' }),
      ], { lastUsedMs: hours(0.05), files: arborFiles('arbor-a', 'agents-a') }),
      projectRepo('/Users/casey/src/proxy', 'github.com/acme/proxy', [
        mainCheckout('/Users/casey/src/proxy', 'feat/rate-limiter', { ahead: 2, changed: 3, merged: false }),
      ], { lastUsedMs: hours(20), files: [{ name: 'AGENTS.md', sum: 'proxy-a', size: 2_140 }] }),
      projectRepo('/Users/casey/src/notes', null, [mainCheckout('/Users/casey/src/notes', 'main', { upstream: null, ahead: null, behind: null })], {
        lastUsedMs: hours(90), fetchedAt: null, files: [{ name: 'CLAUDE.md', sum: 'notes-a', size: 812 }],
      }),
      projectRepo('/Users/casey/src/legacy-site', 'github.com/casey/legacy-site', [], { state: 'missing', lastUsedMs: hours(700) }),
    ],
  },
  'ci-01': {
    homeDir: '/home/ci',
    repos: [
      projectRepo('/home/ci/src/arbor', 'github.com/casey/arbor', [mainCheckout('/home/ci/src/arbor', 'main', { behind: 14 })], {
        fetchedAt: hours(9 * 24), lastUsedMs: hours(30), files: arborFiles('arbor-b', 'agents-a'),
      }),
      projectRepo('/home/ci/work/proxy', 'github.com/acme/proxy', [mainCheckout('/home/ci/work/proxy', 'main')], {
        lastUsedMs: hours(40), files: [{ name: 'AGENTS.md', sum: 'proxy-a', size: 2_140 }],
      }),
    ],
  },
  'cedar-02': {
    homeDir: '/home/casey',
    repos: [
      projectRepo('/home/casey/src/arbor', 'github.com/casey/arbor', [
        mainCheckout('/home/casey/src/arbor', 'main', { mcpDenied: mcpProjectsSample ? [{ name: 'sentry', local: false }] : [] }),
        mockWorktree('/home/casey/src/arbor/.claude/worktrees/brave-otter', 'claude/brave-otter', {
          mcpDisabled: mcpProjectsSample ? ['sentry'] : [],
          merged: true, upstream: null, ahead: null, behind: null, lastUsedMs: hours(75), ignored: ['.env', 'target/'], ignoredMore: 12,
          // `?skillprojects=seen`: no settings.local.json yet, and Git wouldn't ignore one.
          localSeen: params.get('skillprojects') === 'seen',
          ...(projectInstructionsSample ? { instructions: instructionFiles('seen', 'seen') } : {}),
        }),
      ], { lastUsedMs: hours(3), files: arborFiles('arbor-a', null) }),
      projectRepo('/home/casey/src/billing', 'github.com/casey/billing', [mainCheckout('/home/casey/src/billing', 'main')], {
        fetchFailed: true, lastUsedMs: hours(12), files: [{ name: 'CLAUDE.md', sum: 'billing-a', size: 1_320 }],
      }),
    ],
  },
};

const projectsState: MachineProjects[] = Object.entries(projectRepos).map(([machine, { homeDir, repos }]) => ({
  machine, homeDir, scannedAt: projectsScenario === 'fresh' ? null : Date.now() - 4 * 60_000,
  partial: projectsScenario === 'partial' && machine === 'casey-mbp', fetchedAt: null, measuredAt: null, scanning: false, measuring: false,
  removing: false, error: null, repos: projectsScenario === 'fresh' || projectsScenario === 'none' ? [] : structuredClone(repos),
}));
keepThisMacOnly(projectsState);

const projectTexts: Record<string, string> = {
  'arbor-a': '# Working on Arbor\n\nArbor is a Tauri 2 desktop app for macOS.\n\n## Running things\n\n```sh\nbun run verify\nbun run build\n```\n\n## Hard rules\n\n- The real app and its live data are off limits.\n- Claim, reset and redeem calls are only ever mocked.\n',
  'arbor-b': '# Working on Arbor\n\nArbor is a Tauri 2 desktop app for macOS.\n\n## Running things\n\n```sh\nbun run verify\nbun run verify:rust\n```\n\n## Hard rules\n\n- The real app and its live data are off limits.\n',
};

const projectsEntry = (machine: string) => {
  const entry = projectsState.find((candidate) => candidate.machine === machine);
  if (!entry) throw `Arbor isn't checking a machine called ${machine}`;
  return entry;
};

const projectsReply = (entry: MachineProjects) => structuredClone(entry);

const scanProjectsMock = (machine: string, fetch: boolean) => {
  const entry = projectsEntry(machine);
  if (entry.scanning || entry.measuring) throw `Arbor is already looking at the projects on ${machine}`;
  entry.scanning = true;
  void emit('setup-projects-updated', Date.now());
  return new Promise<MachineProjects>((resolve, reject) => window.setTimeout(() => {
    entry.scanning = false;
    if (projectsScenario === 'fail' && machine === 'cedar-02') {
      entry.error = 'ssh: connect to host cedar-02 port 22: Operation timed out';
      void emit('setup-projects-updated', Date.now());
      reject(entry.error);
      return;
    }
    const sizes = new Map(entry.repos.flatMap((repo) => repo.worktrees.map((worktree) => [worktree.path, worktree.sizeKb] as const)));
    // A checkout's settings stay as the last change left them, as its files would.
    const plugins = new Map(entry.repos.flatMap((repo) => repo.worktrees.map((worktree) => [worktree.path, worktree.plugins] as const)));
    const skills = new Map(entry.repos.flatMap((repo) => repo.worktrees.map((worktree) => [worktree.path, worktree.skills] as const)));
    const mcp = new Map(entry.repos.flatMap((repo) => repo.worktrees.map((worktree) => [worktree.path, { mcpDenied: worktree.mcpDenied, mcpLocal: worktree.mcpLocal, instructions: worktree.instructions }] as const)));
    // A new install has no sessions yet, and a scan only finds the repos sessions have worked in.
    if (projectsScenario !== 'none' && !freshInstall) {
      const fresh = structuredClone(projectRepos[machine]?.repos ?? []);
      const kept = new Set(entry.repos.flatMap((repo) => repo.worktrees.map((worktree) => worktree.path)));
      for (const repo of fresh) {
        // Worktrees removed since stay removed.
        if (entry.scannedAt !== null && entry.repos.length) repo.worktrees = repo.worktrees.filter((worktree) => worktree.main || kept.has(worktree.path));
        for (const worktree of repo.worktrees) Object.assign(worktree, { sizeKb: sizes.get(worktree.path) ?? null, plugins: plugins.get(worktree.path) ?? worktree.plugins, skills: skills.get(worktree.path) ?? worktree.skills, ...mcp.get(worktree.path) });
        if (fetch && repo.remote) {
          repo.fetchedAt = Date.now();
          repo.fetchFailed = repo.path.endsWith('/billing');
        }
      }
      entry.repos = fresh;
    }
    entry.scannedAt = Date.now();
    if (fetch) entry.fetchedAt = entry.scannedAt;
    entry.error = null;
    void emit('setup-projects-updated', entry.scannedAt);
    resolve(projectsReply(entry));
  }, fetch ? 2_600 : 1_400));
};

const measureProjectsMock = (machine: string) => {
  const entry = projectsEntry(machine);
  if (entry.scannedAt === null) throw "Scan this machine's projects first";
  if (entry.scanning || entry.measuring) throw `Arbor is already looking at the projects on ${machine}`;
  entry.measuring = true;
  void emit('setup-projects-updated', Date.now());
  return later(1_800, () => {
    entry.measuring = false;
    for (const repo of entry.repos) {
      const own = new Map(repo.worktrees.map((worktree) => [
        worktree.path,
        40_000 + ([...worktree.path].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 50) * 9_000 + (worktree.main ? 180_000 : 0),
      ] as const));
      // A folder's size takes in the checkouts inside it, as du's does.
      for (const worktree of repo.worktrees) {
        worktree.sizeKb = repo.worktrees
          .filter((other) => other === worktree || other.path.startsWith(`${worktree.path}/`))
          .reduce((sum, other) => sum + (own.get(other.path) ?? 0), 0);
      }
    }
    entry.measuredAt = Date.now();
    void emit('setup-projects-updated', entry.measuredAt);
    return projectsReply(entry);
  });
};

const removeWorktreesMock = (machine: string, removals: WorktreeRemoval[]) => {
  const entry = projectsEntry(machine);
  if (!removals.length) throw "There's nothing to remove";
  if (projectsScenario === 'fail' && machine === 'cedar-02') throw 'ssh: connect to host cedar-02 port 22: Operation timed out';
  return later(1_500, () => {
    if (params.get('worktrees') === 'fail') throw 'Could not start ssh: No such file or directory';
    const results = removals.map((removal, index): RemovalResult => {
      const repo = entry.repos.find((candidate) => candidate.path === removal.repo);
      const worktree = repo?.worktrees.find((candidate) => candidate.path === removal.path);
      if (!repo || !worktree || worktree.blocker !== null) throw `The last scan didn't find ${removal.path}`;
      if (params.get('worktrees') === 'changed' && index > 0) {
        return { path: removal.path, outcome: 'changed', branch: null, message: 'It has changes now' };
      }
      repo.worktrees = repo.worktrees.filter((candidate) => candidate !== worktree);
      return { path: removal.path, outcome: 'removed', branch: worktree.branch ? (worktree.merged ? 'deleted' : 'kept') : null, message: '' };
    });
    void emit('setup-projects-updated', Date.now());
    return results;
  });
};

// Each machine's tools and what its projects ask of them, for Sync › Toolchain. arbor needs Node 22 and Bun,
// which ci-01 lacks (and its zod is a release behind package.json); proxy's Go pin is newer than ci-01's Go, which
// fetches it itself; notes pins Python 3.11, which mise keeps on the Mac. react is 19.1.1 on the Mac and cedar-02
// but 19.1.0 on ci-01, and billing is still on React 18.
const toolchainScenario = params.get('toolchain') ?? (freshInstall ? 'fresh' : null);

const toolNeed = (tool: string, wants: string, kind: ToolNeed['kind'], file: string, field: string | null = null): ToolNeed => ({ tool, wants, kind, file, field });

const lib = (name: string, wants: string, installed: string | null, dev = false): ProjectLibrary => ({ dir: '', name, wants, dev, installed, checked: true });

const toolchainProject = (path: string, remote: string | null, lastUsed: number, extra: Partial<ProjectToolchain> = {}): ProjectToolchain => ({
  path, missing: false, remote, lastUsedMs: hours(lastUsed), needs: [], libraries: [], librariesMore: 0, packages: [], unread: [], ...extra,
});

const arborNeeds = [toolNeed('node', '>=22', 'range', 'package.json', 'engines.node'), toolNeed('rust', '1.85', 'min', 'src-tauri/Cargo.toml', 'rust-version'), toolNeed('bun', '*', 'range', 'bun.lock')];

const arborLibraries = (react: string, zod: string) => [
  lib('@tauri-apps/api', '^2.8.0', '2.8.0'), lib('react', '^19.1.0', react), lib('react-dom', '^19.1.0', react), lib('zod', '^4.0.0', zod),
  lib('tailwindcss', '^4.1.0', '4.1.12', true), lib('typescript', '~5.9.2', '5.9.2', true), lib('vite', '^7.1.0', '7.1.3', true),
];

const bunPackages = [{ dir: '', lockfile: 'bun.lock', modules: true }];

const proxyNeeds = [toolNeed('go', '1.23', 'min', 'go.mod', 'go'), toolNeed('go', '1.24.4', 'pin', '.tool-versions', 'go')];

const toolchainMachines: Record<string, Omit<MachineToolchain, 'machine' | 'scannedAt' | 'partial' | 'scanning' | 'error'>> = {
  'casey-mbp': {
    homeDir: '/Users/casey', os: 'Darwin', arch: 'arm64',
    tools: [
      { tool: 'node', path: '/Users/casey/.nvm/versions/node/v22.17.0/bin/node', version: '22.17.0' },
      { tool: 'npm', path: '/Users/casey/.nvm/versions/node/v22.17.0/bin/npm', version: '10.9.2' },
      { tool: 'pnpm', path: '/opt/homebrew/bin/pnpm', version: '10.12.1' },
      { tool: 'bun', path: '/Users/casey/.bun/bin/bun', version: '1.3.2' },
      { tool: 'python', path: '/Users/casey/.local/share/mise/shims/python3', version: '3.12.4' },
      { tool: 'uv', path: '/opt/homebrew/bin/uv', version: '0.8.3' },
      { tool: 'go', path: '/opt/homebrew/bin/go', version: '1.24.4' },
      { tool: 'rust', path: '/Users/casey/.cargo/bin/rustc', version: '1.88.0' },
      { tool: 'cargo', path: '/Users/casey/.cargo/bin/cargo', version: '1.88.0' },
      { tool: 'git', path: '/opt/homebrew/bin/git', version: '2.50.1' },
      { tool: 'gh', path: '/opt/homebrew/bin/gh', version: '2.74.0' },
      { tool: 'jq', path: '/usr/bin/jq', version: '1.7.1' },
      { tool: 'rg', path: '/opt/homebrew/bin/rg', version: '14.1.1' },
      { tool: 'docker', path: '/usr/local/bin/docker', version: '28.3.0' },
    ],
    kept: [
      { tool: 'node', manager: 'nvm', version: '20.19.0', label: null },
      { tool: 'node', manager: 'nvm', version: '22.17.0', label: null },
      { tool: 'node', manager: 'nvm', version: '24.3.0', label: null },
      { tool: 'python', manager: 'mise', version: '3.11.9', label: null },
      { tool: 'python', manager: 'mise', version: '3.12.4', label: null },
      { tool: 'python', manager: 'uv', version: '3.13.5', label: null },
      { tool: 'rust', manager: 'rustup', version: '1.88.0', label: 'stable' },
      { tool: 'rust', manager: 'rustup', version: '1.90.0-nightly', label: 'nightly-2026-09-01' },
    ],
    projects: [
      toolchainProject('/Users/casey/src/arbor', 'github.com/casey/arbor', 0.05, { needs: arborNeeds, libraries: arborLibraries('19.1.1', '4.1.5'), packages: bunPackages }),
      toolchainProject('/Users/casey/src/proxy', 'github.com/acme/proxy', 20, { needs: proxyNeeds }),
      toolchainProject('/Users/casey/src/notes', null, 90, {
        needs: [toolNeed('python', '3.11', 'pin', '.python-version'), toolNeed('python', '>=3.11', 'python', 'pyproject.toml', 'requires-python'), toolNeed('uv', '*', 'range', 'uv.lock')],
      }),
      toolchainProject('/Users/casey/src/legacy-site', 'github.com/casey/legacy-site', 700, { missing: true }),
    ],
  },
  'ci-01': {
    homeDir: '/home/ci', os: 'Linux', arch: 'x86_64',
    tools: [
      { tool: 'node', path: '/usr/bin/node', version: '20.19.0' },
      { tool: 'npm', path: '/usr/bin/npm', version: '10.8.2' },
      { tool: 'python', path: '/usr/bin/python3', version: '3.10.12' },
      { tool: 'go', path: '/usr/local/go/bin/go', version: '1.22.2' },
      { tool: 'rust', path: '/home/ci/.cargo/bin/rustc', version: '1.85.0' },
      { tool: 'cargo', path: '/home/ci/.cargo/bin/cargo', version: '1.85.0' },
      { tool: 'git', path: '/usr/bin/git', version: '2.43.0' },
      { tool: 'jq', path: '/usr/bin/jq', version: '1.7.1' },
      { tool: 'docker', path: '/usr/bin/docker', version: '27.5.1' },
    ],
    kept: [{ tool: 'rust', manager: 'rustup', version: '1.85.0', label: 'stable' }],
    projects: [
      toolchainProject('/home/ci/src/arbor', 'github.com/casey/arbor', 30, {
        needs: arborNeeds, libraries: arborLibraries('19.1.0', '3.25.76'), packages: bunPackages,
      }),
      toolchainProject('/home/ci/work/proxy', 'github.com/acme/proxy', 40, { needs: proxyNeeds, unread: ['mise.toml'] }),
    ],
  },
  'cedar-02': {
    homeDir: '/home/casey', os: 'Linux', arch: 'aarch64',
    tools: [
      { tool: 'node', path: '/home/casey/.local/share/mise/shims/node', version: '22.12.0' },
      { tool: 'npm', path: '/home/casey/.local/share/mise/shims/npm', version: '10.9.0' },
      { tool: 'pnpm', path: '/home/casey/.local/share/pnpm/pnpm', version: '9.15.0' },
      { tool: 'bun', path: '/home/casey/.bun/bin/bun', version: '1.3.0' },
      { tool: 'python', path: '/usr/bin/python3', version: '3.12.3' },
      { tool: 'uv', path: '/home/casey/.local/bin/uv', version: '0.7.20' },
      { tool: 'rust', path: '/home/casey/.cargo/bin/rustc', version: '1.88.0' },
      { tool: 'cargo', path: '/home/casey/.cargo/bin/cargo', version: '1.88.0' },
      { tool: 'git', path: '/usr/bin/git', version: '2.45.2' },
      { tool: 'gh', path: '/usr/bin/gh', version: '2.63.0' },
      { tool: 'rg', path: '/usr/bin/rg', version: '14.1.0' },
    ],
    kept: [
      { tool: 'node', manager: 'mise', version: '20.18.1', label: null },
      { tool: 'node', manager: 'mise', version: '22.12.0', label: null },
      { tool: 'rust', manager: 'rustup', version: '1.88.0', label: 'stable' },
    ],
    projects: [
      toolchainProject('/home/casey/src/arbor', 'github.com/casey/arbor', 3, { needs: arborNeeds, libraries: arborLibraries('19.1.1', '4.1.5'), packages: bunPackages }),
      toolchainProject('/home/casey/src/billing', 'github.com/casey/billing', 12, {
        needs: [toolNeed('node', '>=20', 'range', 'package.json', 'engines.node'), toolNeed('pnpm', '9.15.0', 'pin', 'package.json', 'packageManager')],
        libraries: [lib('react', '^18.3.1', '18.3.1'), lib('stripe', '^18.0.0', '18.4.0'), lib('zod', '^3.23.0', '3.25.76'), lib('typescript', '~5.6.0', '5.6.3', true), lib('vite', '^6.0.0', null, true)],
        packages: [{ dir: '', lockfile: 'pnpm-lock.yaml', modules: true }],
      }),
    ],
  },
};

// `?nodeversions=many` gives the Mac a crowd of Node versions under nvm and fnm, with a pinned one and patches of
// the same lines to clean up.
if (params.get('nodeversions') === 'many') {
  const mac = toolchainMachines['casey-mbp'];
  if (mac) {
    const extra = [['fnm', '24.12.0'], ['nvm', '22.21.1'], ['fnm', '22.18.0'], ['nvm', '22.13.1'], ['fnm', '22.13.1'], ['nvm', '20.15.1'], ['nvm', '20.12.2'], ['nvm', '19.8.1'], ['nvm', '18.20.4'], ['nvm', '18.15.0'], ['nvm', '18.10.0'], ['fnm', '16.20.2'], ['nvm', '16.14.0']] as const;
    mac.kept = [...mac.kept, ...extra.map(([manager, version]) => ({ tool: 'node', manager, version, label: null }))];
    mac.projects = [...mac.projects, toolchainProject('/Users/casey/src/old-dash', 'github.com/casey/old-dash', 400, { needs: [toolNeed('node', '20.12.2', 'pin', '.nvmrc')] })];
  }
}

const toolchainReply = (machine: string, entry: (typeof toolchainMachines)[string], scannedAt: number | null): MachineToolchain => ({
  machine, scannedAt, partial: toolchainScenario === 'partial' && machine === 'casey-mbp', scanning: false, error: null,
  ...structuredClone(entry),
  projects: toolchainScenario === 'none' || scannedAt === null ? [] : structuredClone(entry.projects),
  ...(scannedAt === null ? { tools: [], kept: [] } : {}),
});

const toolchainState: MachineToolchain[] = Object.entries(toolchainMachines).map(([machine, entry]) =>
  toolchainReply(machine, entry, toolchainScenario === 'fresh' ? null : Date.now() - 12 * 60_000));
keepThisMacOnly(toolchainState);

// `?nodechange=fail` has every install fail to download, as it does off the network.
const changeNodeMock = (machine: string, changes: NodeChange[]) => {
  const source = toolchainMachines[machine];
  const current = toolchainState.find((candidate) => candidate.machine === machine);
  if (!source || !current?.scannedAt) throw `Look at the tools on ${machine} first`;
  const failing = params.get('nodechange') === 'fail';
  return later(2_200, () => {
    const results = changes.map((change): NodeResult => {
      const done = (ok: boolean, message: string | null = null): NodeResult => ({ manager: change.manager, version: change.version, action: change.action, ok, message });
      const bare = change.version.replace(/^v/, '');
      const kept = source.kept.findIndex((entry) => entry.tool === 'node' && entry.manager === change.manager && entry.version === change.version);
      if (change.action === 'install') {
        if (failing) return done(false, 'curl: (6) Could not resolve host: nodejs.org');
        const version = bare.split('.').length === 3 ? bare : `${bare.split('.')[0]}.${bare.split('.')[1] ?? '11'}.0`;
        if (!source.kept.some((entry) => entry.tool === 'node' && entry.manager === change.manager && entry.version === version)) {
          source.kept = [...source.kept, { tool: 'node', manager: change.manager, version, label: null }];
        }
        return done(true);
      }
      if (kept < 0) return done(false, `N/A: version "${change.version}" is not yet installed.`);
      if (change.action === 'uninstall') {
        source.kept = source.kept.filter((_, index) => index !== kept);
        return done(true);
      }
      source.tools = source.tools.map((tool) => (tool.tool === 'node'
        ? { ...tool, version: bare, path: change.manager === 'nvm' ? `${source.homeDir}/.nvm/versions/node/v${bare}/bin/node` : tool.path }
        : tool));
      return done(true);
    });
    void emit('setup-toolchain-updated', Date.now());
    return results;
  });
};

const scanToolchainMock = (machine: string) => {
  const index = toolchainState.findIndex((candidate) => candidate.machine === machine);
  const current = toolchainState[index];
  const source = toolchainMachines[machine];
  if (!current || !source) throw `Arbor isn't checking a machine called ${machine}`;
  if (current.scanning) throw `Arbor is already looking at the tools on ${machine}`;
  current.scanning = true;
  void emit('setup-toolchain-updated', Date.now());
  return new Promise<MachineToolchain>((resolve, reject) => window.setTimeout(() => {
    current.scanning = false;
    if (toolchainScenario === 'fail' && machine === 'cedar-02') {
      current.error = 'ssh: connect to host cedar-02 port 22: Operation timed out';
      void emit('setup-toolchain-updated', Date.now());
      reject(current.error);
      return;
    }
    const next = toolchainReply(machine, source, Date.now());
    toolchainState[index] = next;
    void emit('setup-toolchain-updated', Date.now());
    resolve(structuredClone(next));
  }, 1_600));
};

const takeMcpMock = (path: string, machine: string, homePath: string, name: string, own: boolean) => {
  // How the repo started is read before the registry changes, so the commit shows what this one changed.
  othersAtStart();
  const repo = mockRepo(path);
  const entry = setupMachines.find((candidate) => candidate.machine === machine);
  const home = entry?.homes.find((candidate) => candidate.path === homePath);
  const item = home?.items.find((candidate) => candidate.kind === 'mcp' && candidate.name === name);
  if (!entry || !home || !item) throw 'Arbor can only take a server its last scan of this machine found. Scan again.';
  // As read_file_to_change refuses: the take would commit someone's unfinished edit along with it.
  if (params.get('registry') === 'dirty') {
    throw ".agents/mcp-servers.json has changes in the repo that aren't committed. Commit or drop them, then try again.";
  }
  if (name === 'github') {
    throw "Arbor didn't take github: headers.Authorization looks like a secret, and the repo mustn't hold one. Change them there to ${VAR} references, then take it again.";
  }
  const agent = mcpAgent(home.agent);
  const definition = mockDefinition(item.value ?? 'stdio', item.note, [], item.sum ?? '');
  let server = mockRegistry.servers.find((candidate) => candidate.name === name);
  if (!server) {
    server = { name, claude: null, codex: null, homes: null, machines: {}, agents: [], problems: [] };
    mockRegistry.servers.push(server);
    mockRegistry.servers.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (server.homes && !server.homes.includes(homePath)) server.homes.push(homePath);
  const other = agent === 'claude' ? 'codex' : 'claude';
  if (own) {
    const choice = server.machines[machine];
    server.machines[machine] = { ...(choice === null ? { [other]: null } : choice ?? {}), [agent]: definition };
  } else {
    server[agent] = definition;
    server.problems = server.problems.filter((problem) => !problem.startsWith(`${agent}:`));
    const choice = server.machines[machine];
    if (choice === null) server.machines[machine] = { [other]: null };
    else if (choice && agent in choice) {
      const rest = { ...choice };
      delete rest[agent];
      if (Object.keys(rest).length) server.machines[machine] = rest;
      else delete server.machines[machine];
    }
  }
  mockRegistry.found = true;
  commitRegistry(repo, own ? `Take ${machine}'s own MCP server ${name}` : `Take MCP server ${name} from ${machine}`);
  return registryReply(path);
};

/** Servers removed from every machine, as the repo last defined them. */
const mockRemovedServers = new Map<string, MockRegistryServer>();

const putBackMcpMock = (path: string, name: string) => {
  // How the repo started is read before the registry changes, so the commit shows what this one changed.
  othersAtStart();
  const repo = mockRepo(path);
  const index = mockRegistry.servers.findIndex((candidate) => candidate.name === name);
  const current = mockRegistry.servers[index];
  if (current && (current.claude || current.codex || Object.values(current.machines).some(Boolean))) return registryReply(path);
  const was = mockRemovedServers.get(name);
  if (!was) throw `The repo's history has no definition of ${name} to put back`;
  if (index >= 0) mockRegistry.servers[index] = was;
  else mockRegistry.servers = [...mockRegistry.servers, was].sort((a, b) => a.name.localeCompare(b.name));
  mockRemovedServers.delete(name);
  commitRegistry(repo, `Put back MCP server ${name}`);
  return registryReply(path);
};

const setMcpWantedMock = (path: string, name: string, machine: string | null, wanted: McpWanted) => {
  // How the repo started is read before the registry changes, so the commit shows what this one changed.
  othersAtStart();
  const repo = mockRepo(path);
  let message: string;
  if (machine === null) {
    if (wanted !== 'removed') throw "Every machine's value is a definition: take one into the repo from a home";
    const index = mockRegistry.servers.findIndex((candidate) => candidate.name === name);
    const removed: MockRegistryServer = { name, claude: null, codex: null, homes: null, machines: {}, agents: mockRegistry.servers[index]?.agents ?? [], problems: [] };
    // The repo's history keeps the definition, which putting it back reads.
    const was = mockRegistry.servers[index];
    if (was && (was.claude || was.codex || Object.values(was.machines).some(Boolean))) mockRemovedServers.set(name, was);
    if (index >= 0) mockRegistry.servers[index] = removed;
    else mockRegistry.servers = [...mockRegistry.servers, removed].sort((a, b) => a.name.localeCompare(b.name));
    message = `Remove MCP server ${name} from all machines`;
  } else {
    if (wanted === 'removed') throw 'A server is removed from every machine, or kept off one';
    const server = mockRegistry.servers.find((candidate) => candidate.name === name);
    if (!server) throw `The repo hasn't got ${name}`;
    if (wanted === 'off') server.machines[machine] = null;
    else delete server.machines[machine];
    message = wanted === 'off' ? `Keep MCP server ${name} off ${machine}` : `Give ${machine} MCP server ${name} as every machine has it`;
  }
  mockRegistry.found = true;
  commitRegistry(repo, message);
  return registryReply(path);
};

const undoSetupMock = (entry: SetupMachine, backup: MockSetupBackup): SyncOutcome => {
  if (backup.skills.length) return undoSkillsMock(entry, backup);
  if (backup.what !== 'sync') {
    // A settings edit: the mock keeps no copy of the file, so it's only marked undone.
    backup.undoneAtMs = Date.now();
    return { backup: null, done: backup.files.map((file) => file.path), failed: [] };
  }
  const now = (path: string) => syncedItem(entry, path)?.sum ?? null;
  const moved = backup.files.filter((file) => now(file.path) !== backup.left[file.path] && now(file.path) !== (backup.was[file.path]?.sum ?? null));
  if (moved.length) {
    scanSetupMock(entry.machine, false);
    return { backup: null, done: [], failed: moved.map((file) => ({ path: file.path, reason: 'changed' })) };
  }
  const done: string[] = [];
  for (const file of backup.files) {
    const was = backup.was[file.path] ?? null;
    if (now(file.path) === (was?.sum ?? null)) continue;
    placeSyncedItem(entry, file.path, was);
    done.push(file.path);
  }
  backup.undoneAtMs = Date.now();
  scanSetupMock(entry.machine, false);
  return { backup: null, done, failed: [] };
};

/**
 * A machine added (the sidebar's +, Settings › Machines), or already there with `?machine=new`, as Sync finds it:
 * last year's CLAUDE.md, one skill in its store, none of the fleet's plugins and no projects yet. One that hasn't answered has
 * nothing read from it until it does, a few seconds on. Returns false for a machine Sync already has.
 */
export const joinSetupMachine = (name: string, arrived: boolean) => {
  if (setupMachines.some((entry) => entry.machine === name)) return false;
  const at = Date.now();
  const scannedAt = arrived ? at - 60_000 : null;
  const entry: SetupMachine = {
    machine: name, local: false, reachable: arrived, scannedAt, error: null, scanning: false, policy: null, harnessHomes: [], harnessInstalls: [],
    homes: [
      setupHome('claude', '~/.claude', [
        setupFile('instructions', 'CLAUDE.md', '~/.claude/CLAUDE.md', 'c1a7', 298),
        setupItem('setting', 'model', 's1b', { value: 'sonnet' }),
        setupItem('setting', 'effortLevel', 's2', { value: 'high' }),
      ]),
      setupHome('shared', '~/.agents', [setupSkill('find-skills', '~/.agents/skills/find-skills', 'q2', 1, 'vercel-labs/skills')]),
    ],
    installs: [setupInstall('claude', '~/.local/bin/claude', '2.1.270', '~/.local/share/claude/versions/2.1.270')],
  };
  // Like the real scan, a machine that hasn't answered yet has nothing read from it.
  const { homes, installs } = entry;
  if (!arrived) Object.assign(entry, { homes: [], installs: [] });
  setupMachines.push(entry);
  const toolchain = {
    homeDir: '/home/casey', os: 'Linux', arch: 'x86_64', kept: [], projects: [],
    tools: [
      { tool: 'node', path: '/usr/bin/node', version: '20.19.2' },
      { tool: 'npm', path: '/usr/bin/npm', version: '10.8.2' },
      { tool: 'python', path: '/usr/bin/python3', version: '3.12.3' },
      { tool: 'git', path: '/usr/bin/git', version: '2.43.0' },
    ],
  };
  toolchainMachines[name] = toolchain;
  toolchainState.push(toolchainReply(name, toolchain, scannedAt));
  projectRepos[name] = { homeDir: '/home/casey', repos: [] };
  projectsState.push({
    machine: name, homeDir: '/home/casey', scannedAt, partial: false, fetchedAt: null, measuredAt: null,
    scanning: false, measuring: false, removing: false, error: null, repos: [],
  });
  if (!arrived) {
    window.setTimeout(() => {
      Object.assign(entry, { reachable: true, homes, installs });
      void emit('setup-inventory-updated', Date.now());
    }, 3_000);
  }
  return true;
};

// The repo browser's view of the mock repo: every file in its folder as each commit had it, and as the folder has it
// now. A commit's synced files and skills come from its files and skills; the rest (the README, records, projects' own
// instructions, files Arbor doesn't sync) from the browser's last commit before it, else from how the repo started.

/** One file as a commit or the folder has it; `text` is null for one Arbor never opens. */
type MockBlob = { text: string | null; sum: string; size: number; problem: RepoFileProblem | null };

const textBlob = (text: string): MockBlob => ({ text, sum: instructionsHash(text), size: text.length, problem: null });

const RECORDS = new Set(['.agents/machines.json', '.agents/plugins.json', '.agents/mcp-servers.json', '.agents/hooks.json', '.agents/skill-sources.json']);

/** What a file in the repo is to Arbor, from its path, as the backend reads it. */
const repoRole = (path: string): RepoRole => {
  const kind = syncKind(`~/${path}`);
  if (kind) return kind;
  if (skillOf(path)) return 'skill';
  if (projectOf(path)) return 'projectInstructions';
  return RECORDS.has(path) ? 'record' : 'other';
};

/** Whether a path's text comes from a commit's synced files and skills, rather than the rest of the folder. */
const fromSynced = (path: string) => repoRole(path) !== 'projectInstructions' && repoRole(path) !== 'record' && repoRole(path) !== 'other';

/** Each repo skill's files, for skills the browser's commits made. */
const committedSkillFiles = new WeakMap<SetupRepoSkill, SetupSkillFile[]>();

const skillFilesOf = (skill: SetupRepoSkill): SetupSkillFile[] =>
  committedSkillFiles.get(skill)
  ?? (skill.sum ? repoSkillFiles[skill.sum] : undefined)
  ?? setupSkills[skill.path]?.['casey-mbp']
  ?? [skillFile('SKILL.md', `${skill.name}-doc`, `---\nname: ${skill.name}\ndescription: Kept in the setup repo.\n---\n\n# ${skill.name}\n`)];

const hiddenBlob = (file: SetupSkillFile): MockBlob => ({ text: null, sum: file.sum, size: file.size, problem: file.hidden });

/** Projects' own instructions as files, by their place in the repo. */
const instructionFilesOf = (texts: Record<string, string>) => Object.fromEntries(Object.entries(texts).map(([key, text]) => {
  const [project = '', machine = ''] = key.split('\u0000');
  return [`.agents/projects/${project}/${machine ? `machines/${machine}.md` : 'instructions.md'}`, textBlob(text)];
}));

/** The rest of the folder as the repo started, kept from the first time it's read so later commits show what changed. */
let startedOthers: Record<string, MockBlob> | null = null;

/** `?repo=big`'s made-up skill names: two words each, enough for a repo the size people keep. */
const BIG_WORDS = ['brand', 'motion', 'audio', 'slides', 'chart', 'report', 'launch', 'triage', 'schema', 'theme'];
const bigSkillNames = (offset: number) => BIG_WORDS.flatMap((first) => BIG_WORDS.slice(offset, offset + 5).map((second) => `${first}-${second}-kit`));

/** `?repo=big`: fifty skills' folders with a few files each, beside what every repo starts with. */
const bigRepoFiles = (): Record<string, MockBlob> => params.get('repo') !== 'big' ? {} : Object.fromEntries(bigSkillNames(0).flatMap((name) => [
  [`.agents/skills/${name}/SKILL.md`, textBlob(`---\nname: ${name}\ndescription: Makes a ${name.replace(/-/g, ' ')}.\n---\n\n# ${name}\n`)],
  [`.agents/skills/${name}/references/guide.md`, textBlob(`# ${name} guide\n`)],
  [`.agents/skills/${name}/scripts/run.sh`, textBlob('#!/bin/sh\necho done\n')],
]));

// `?repo=big` has fifty more skills taken off every machine, so the list of them is longer than the browser is tall.
if (params.get('repo') === 'big') for (const name of bigSkillNames(5)) mockRemovedSkills.add(name);

const othersAtStart = () => {
  startedOthers ??= {
    ...bigRepoFiles(),
    'README.md': textBlob('# Agent setup\n\nThe agent files Arbor keeps the same on every machine.\n\n- `.claude/` and `.codex/` go to each machine\'s homes.\n- `.agents/skills/` holds the skills, a folder each.\n- `.agents/projects/` holds projects\' own instructions.\n'),
    '.gitignore': textBlob('.DS_Store\n'),
    '.agents/machines.json': textBlob(`${JSON.stringify({ skills: mockSkillMachines, files: mockFileMachines }, null, 2)}\n`),
    '.claude/settings.json': textBlob('{\n  "permissions": {\n    "allow": ["Bash(bun test:*)"]\n  }\n}\n'),
    '.agents/commands/review.md': textBlob('---\ndescription: Review the current branch\n---\n\nRead the diff and list what would break.\n'),
    ...(mockRegistry.found ? { '.agents/mcp-servers.json': registryFile() } : {}),
    ...instructionFilesOf(mockInstructions),
  };
  return startedOthers;
};

/** The rest of the folder as the browser's commits left it, by commit. */
const commitOthers = new Map<string, Record<string, MockBlob>>();

/** The rest of the folder as of a commit: the last one the browser's commits left, else how the repo started. */
const othersAt = (repo: MockRepo, at: number): Record<string, MockBlob> => {
  for (let back = at; back >= 0; back -= 1) {
    const kept = commitOthers.get(repo.commits[back]?.sha ?? '');
    if (kept) return kept;
  }
  return othersAtStart();
};

/** .agents/mcp-servers.json as the registry stands, each definition written the way its agent's settings take it. */
const registryFile = (): MockBlob => {
  const written = (definition: MockDefinition | null | undefined) => {
    if (!definition) return null;
    const place = definition.transport === 'stdio' ? { command: definition.place } : { url: `https://${definition.place ?? ''}` };
    return { type: definition.transport, ...place, ...(definition.variables.length ? { env_vars: definition.variables } : {}) };
  };
  const servers = Object.fromEntries(mockRegistry.servers.map((server) => [server.name, {
    ...(server.claude ? { claude: written(server.claude) } : {}),
    ...(server.codex ? { codex: written(server.codex) } : {}),
    ...(server.homes ? { homes: server.homes } : {}),
    ...(Object.keys(server.machines).length ? {
      machines: Object.fromEntries(Object.entries(server.machines).map(([machine, choice]) => [
        machine, choice === null ? null : Object.fromEntries(Object.entries(choice).map(([agent, definition]) => [agent, written(definition)])),
      ])),
    } : {}),
  }]));
  return textBlob(`${JSON.stringify({ version: 1, servers }, null, 2)}\n`);
};

/** Commits the registry as it now stands, alone, as the backend's takes and changes to it do. */
const commitRegistry = (repo: MockRepo, subject: string) => {
  const head = repoHead(repo);
  const others = othersAt(repo, repo.commits.length - 1);
  const commit = repoCommit(subject, Date.now(), head?.files ?? [], head?.skills ?? []);
  repo.commits.push(commit);
  commitOthers.set(commit.sha, { ...others, '.agents/mcp-servers.json': registryFile() });
};

/** Every file in a commit, by its path in the repo. */
const commitSnapshot = (repo: MockRepo, at: number): Map<string, MockBlob> => {
  const commit = repo.commits[at];
  const files = new Map<string, MockBlob>();
  if (!commit) return files;
  for (const [path, blob] of Object.entries(othersAt(repo, at))) files.set(path, blob);
  const sources = Object.fromEntries(commit.skills.flatMap((skill) => (skill.source ? [[skill.name, skill.source]] : [])));
  if (Object.keys(sources).length && !commitOthers.has(commit.sha)) files.set('.agents/skill-sources.json', textBlob(`${JSON.stringify({ version: 1, skills: sources }, null, 2)}\n`));
  for (const file of commit.files) files.set(file.path.slice(2), textBlob(setupTexts[file.sum] ?? ''));
  for (const skill of commit.skills) {
    for (const file of skillFilesOf(skill)) {
      files.set(`${skillFolder(skill.name)}/${file.path}`, file.hidden || file.content === null ? hiddenBlob(file) : textBlob(file.content));
    }
  }
  return files;
};

const headSnapshot = (repo: MockRepo) => commitSnapshot(repo, repo.commits.length - 1);

/**
 * Each repo's folder where it differs from the last commit: a file's new text, or null where it's gone. `?repo=dirty`
 * starts with CLAUDE.md and pdf's SKILL.md edited and a new rule.
 */
const repoWorktrees: Record<string, Map<string, MockBlob | null>> = {};

const worktreeOf = (path: string) => {
  const repo = mockRepo(path);
  let worktree = repoWorktrees[path];
  if (!worktree) {
    worktree = new Map();
    repoWorktrees[path] = worktree;
    if (params.get('repo') === 'dirty') {
      const head = headSnapshot(repo);
      const claude = head.get('.claude/CLAUDE.md')?.text ?? '';
      worktree.set('.claude/CLAUDE.md', textBlob(claude.replace('- Push to the private remote.\n', '- Push to the private remote.\n- Write the release notes before the build.\n')));
      const pdf = head.get('.agents/skills/pdf/SKILL.md')?.text ?? '';
      worktree.set('.agents/skills/pdf/SKILL.md', textBlob(`${pdf}\nPrefer the text layer; only read pages as images when it's empty.\n`));
      worktree.set('.claude/rules/naming.md', textBlob('# Naming\n\n- Name things for what they hold, not their type.\n- Spell words out; no abbreviations.\n'));
    }
  }
  return worktree;
};

/** The folder as it is now. */
const folderFiles = (path: string) => {
  const files = headSnapshot(mockRepo(path));
  for (const [file, blob] of worktreeOf(path)) {
    if (blob) files.set(file, blob);
    else files.delete(file);
  }
  return files;
};

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const repoTreeReply = (path: string): RepoTree => {
  const head = headSnapshot(mockRepo(path));
  const folder = folderFiles(path);
  const paths = [...new Set([...head.keys(), ...folder.keys()])].sort(byPath);
  return {
    entries: paths.map((file): RepoEntry => {
      const was = head.get(file);
      const now = folder.get(file);
      const blob = now ?? was;
      const status: RepoStatus = !now ? 'deleted' : !was ? 'added' : was.sum === now.sum ? 'same' : 'modified';
      return { path: file, role: repoRole(file), status, size: blob?.size ?? 0, problem: blob?.problem ?? null };
    }),
    truncated: false,
  };
};

/** Refuses a path outside the folder or in git's own, as the backend does. */
const checkRepoPath = (path: string) => {
  const parts = path.split('/');
  if (!path || path.startsWith('/') || path.includes('\\') || parts.some((part) => !part || part === '.' || part === '..')) throw `${path} isn't a path inside the repo`;
  if (parts[0] === '.git') throw "Arbor doesn't change git's own files";
};

/** A file's two copies, as a change shows them; a file Arbor never opens shows neither. */
const repoChange = (path: string, was: MockBlob | undefined, now: MockBlob | undefined): RepoChange => {
  const problem = now?.problem ?? was?.problem ?? null;
  const status: RepoStatus = !now ? 'deleted' : !was ? 'added' : 'modified';
  return { path, status, before: problem ? null : was?.text ?? null, after: problem ? null : now?.text ?? null, problem };
};

const snapshotChanges = (was: Map<string, MockBlob>, now: Map<string, MockBlob>) =>
  [...new Set([...was.keys(), ...now.keys()])].sort(byPath).flatMap((path) => {
    const before = was.get(path);
    const after = now.get(path);
    return before?.sum === after?.sum ? [] : [repoChange(path, before, after)];
  });

/** The fingerprint a text goes by in the repo's files, made the first time it's committed. */
const committedSum = (text: string) => {
  const found = Object.entries(setupTexts).find(([, known]) => known === text)?.[0];
  if (found) return found;
  const sum = `t${instructionsHash(text)}`;
  setupTexts[sum] = text;
  return sum;
};

/** The folder's skill, from its files, reusing the commit's own when nothing in it changed. */
const committedSkill = (name: string, files: [string, MockBlob][], was: SetupRepoSkill | undefined, wasFiles: Map<string, MockBlob>): SetupRepoSkill => {
  const folder = `${skillFolder(name)}/`;
  const same = was && files.length === [...wasFiles.keys()].filter((path) => path.startsWith(folder)).length
    && files.every(([path, blob]) => wasFiles.get(path)?.sum === blob.sum);
  if (was && same) return was;
  const list = files.map(([path, blob]) => skillFile(path.slice(folder.length), blob.sum, blob.text, blob.problem === 'link' ? null : blob.problem));
  const problem: SetupRepoSkill['problem'] = list.some((file) => file.hidden === 'secret') ? 'secret' : list.some((file) => file.path === 'SKILL.md') ? null : 'noDoc';
  const sum = `s${instructionsHash(list.map((file) => `${file.path}:${file.sum}`).join('\n'))}`;
  const skill = { ...repoSkill(name, sum, list.length, null, problem), source: was?.source ?? null };
  committedSkillFiles.set(skill, list);
  return skill;
};

const commitRepoMock = (path: string, paths: string[], message: string) => {
  const repo = mockRepo(path);
  const worktree = worktreeOf(path);
  const subject = message.trim().split('\n')[0]?.trim() ?? '';
  if (!subject) throw 'Write a message for the commit';
  const chosen = paths.filter((file) => worktree.has(file));
  if (!chosen.length) throw 'None of those files have changes to commit';
  const head = repoHead(repo);
  const was = headSnapshot(repo);
  const next = new Map(was);
  for (const file of chosen) {
    const blob = worktree.get(file);
    if (blob) next.set(file, blob);
    else next.delete(file);
  }
  const files = [...next].flatMap(([file, blob]) => {
    const kind = syncKind(`~/${file}`);
    return kind && blob.text !== null ? [repoFile(kind, `~/${file}`, committedSum(blob.text))] : [];
  });
  const names = [...new Set([...next.keys()].map(skillOf).filter((name): name is string => name !== null))];
  const skills = names.map((name) => committedSkill(name, [...next].filter(([file]) => file.startsWith(`${skillFolder(name)}/`)), head?.skills.find((skill) => skill.name === name), was));
  const others = Object.fromEntries([...next].filter(([file]) => !fromSynced(file)));
  const commit = repoCommit(subject, Date.now(), files, skills);
  commitOthers.set(commit.sha, others);
  repo.commits.push(commit);
  if (repo.upstream) repo.upstream = { ...repo.upstream, ahead: repo.upstream.ahead + 1 };
  for (const file of chosen) worktree.delete(file);
  // A project's instructions committed here are what its checkouts are brought in line with.
  for (const key of Object.keys(mockInstructions)) delete mockInstructions[key];
  for (const [file, blob] of next) {
    const found = projectOf(file);
    if (found && blob.text !== null) mockInstructions[`${found.project}\u0000${found.machine ?? ''}`] = blob.text;
  }
  mockLog('commit_setup_repo', { repo: path, paths: chosen, subject });
  return setupRepoReply(path);
};

/** Sets a file in the folder to `blob`, or deletes it, keeping only what differs from the last commit. */
const setFolderFile = (path: string, file: string, blob: MockBlob | null) => {
  const head = headSnapshot(mockRepo(path)).get(file);
  const worktree = worktreeOf(path);
  if (blob ? head?.sum === blob.sum : !head) worktree.delete(file);
  else worktree.set(file, blob);
};

/** A name the backend never opens or makes, as its `looks_secret` reads one. */
const secretName = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return name.startsWith('.env') || name.startsWith('id_rsa') || name.startsWith('id_ed25519') || name === 'auth.json' || name === '.netrc'
    || ['.pem', '.key', '.p12', '.pfx'].some((end) => name.endsWith(end)) || ['credential', 'secret', 'token'].some((word) => name.includes(word));
};

/** Setup: each machine's agent files, the setup repo, skills, MCP servers, plugins, projects and toolchains. */
export const setupAnswers: CommandAnswers<SetupCommands> = {
  get_starting_context: (args) => mockStartingContext(args.fromMs, args.toMs),
  // A copy, as the real reply is, so what a change does shows up as new objects.
  get_setup_inventory: () => ({ machines: structuredClone(setupMachines) }),
  scan_setup: (args) => {
    mockLog('scan_setup', { machine: args.machine ?? null, staleOnly: Boolean(args.staleOnly) });
    if (params.get('scan') === 'fail') throw 'The usage database is busy, so the scan didn’t start. Try again in a moment.';
    scanSetupMock(args.machine ?? null, Boolean(args.staleOnly));
    return null;
  },
  read_setup_text: ({ machine, path }) => {
    const item = scannedSetupItem(machine, path);
    const content = setupTexts[item.sum ?? ''] ?? `# ${item.name}\n\nThe copy on ${machine}.\n`;
    return later(350, () => ({ content, size: content.length }));
  },
  read_setup_skill: ({ machine, path }) => {
    scannedSetupItem(machine, path);
    const files = setupSkills[path]?.[machine] ?? [skillFile('SKILL.md', 'sk', '# Skill\n')];
    return later(450, () => files);
  },
  get_setup_repo: (args) => later(200, () => setupRepoReply(args.repo)),
  read_setup_repo_file: (args) => {
    const { path } = args;
    const file = mockRepo(args.repo).commits.find((commit) => commit.sha === args.commit)?.files.find((entry) => entry.path === path);
    if (!file) throw `The repo's commit has no ${path.slice(2)}`;
    const content = setupTexts[file.sum] ?? '';
    return later(250, () => ({ content, size: content.length }));
  },
  start_setup_repo: (args) => {
    const path = args.repo;
    mockLog('start_setup_repo', { repo: path });
    if (setupRepos[path]) throw `${path} already has agent files in it. Choose it as the repo instead.`;
    const mac = setupMachines.find((entry) => entry.local)!;
    const files = [...mac.homes.filter((home) => home.path === '~/.claude' || home.path === '~/.codex'), ...mac.harnessHomes].flatMap((home) => home.items)
      .flatMap((item) => {
        const kind = item.path ? syncKind(item.path) : null;
        return kind && item.path && item.sum !== null ? [repoFile(kind, item.path, item.sum)] : [];
      });
    // The store's skills come too, except one with a file that may hold a secret.
    const skills = (storeHomeOf(mac, false)?.items ?? []).flatMap((item) => {
      const facts = item.skill;
      return item.kind === 'skill' && !item.link && item.sum !== null && item.name !== 'frontend-design' && facts
        ? [repoSkill(item.name, item.sum, facts.files, facts.source)]
        : [];
    });
    setupRepos[path] = { commits: [repoCommit(`Start from ${mac.machine}`, Date.now(), files, skills)], incoming: [], upstream: null, ignored: [] };
    return later(800, () => setupRepoReply(path));
  },
  set_setup_skill_removed: (args) => {
    const { repo: path, skill: name, removed } = args;
    mockLog('set_setup_skill_removed', args);
    const repo = mockRepo(path);
    const head = repoHead(repo);
    // `?skillremove=fail`: the skill's folder has changes in the repo that aren't committed.
    if (params.get('skillremove') === 'fail') return later(500, () => { throw `The repo has changes to ${name}, .agents/skill-sources.json or .agents/machines.json that aren't committed. Commit or drop them, then try again.`; });
    return later(700, () => {
      const skills = head?.skills ?? [];
      const kept = removedRepoSkills.get(name);
      if (removed) {
        const found = skills.find((skill) => skill.name === name);
        if (found) removedRepoSkills.set(name, found);
        mockRemovedSkills.add(name);
        repo.commits.push(repoCommit(`Remove skill ${name} from every machine`, Date.now(), head?.files ?? [], skills.filter((skill) => skill !== found)));
      } else {
        mockRemovedSkills.delete(name);
        removedRepoSkills.delete(name);
        const back = kept && !skills.some((skill) => skill.name === name) ? [...skills, kept] : skills;
        repo.commits.push(repoCommit(`Put skill ${name} back on every machine`, Date.now(), head?.files ?? [], back));
      }
      if (repo.upstream) repo.upstream = { ...repo.upstream, ahead: repo.upstream.ahead + 1 };
      return setupRepoReply(path);
    });
  },
  drop_setup_skills: (args) => {
    const { repo: path, skills: names } = args;
    mockLog('drop_setup_skills', args);
    const repo = mockRepo(path);
    const head = repoHead(repo);
    // `?skilldrop=fail`: a skill's folder has changes in the repo that aren't committed.
    if (params.get('skilldrop') === 'fail') return later(500, () => { throw `The repo has changes to ${names.join(', ')} or .agents/skill-sources.json that aren't committed. Commit or drop them, then try again.`; });
    return later(600, () => {
      const skills = head?.skills ?? [];
      const kept = skills.filter((skill) => !names.includes(skill.name));
      if (kept.length !== skills.length) {
        const subject = names.length === 1 ? `Take the ${names[0]} skill back out of the repo` : `Take ${names.length} skills back out of the repo`;
        repo.commits.push(repoCommit(subject, Date.now(), head?.files ?? [], kept));
        if (repo.upstream) repo.upstream = { ...repo.upstream, ahead: repo.upstream.ahead + 1 };
      }
      return setupRepoReply(path);
    });
  },
  set_setup_file_removed: (args) => {
    const { repo: path, path: file, removed } = args;
    mockLog('set_setup_file_removed', args);
    const repo = mockRepo(path);
    const head = repoHead(repo);
    if (!/^~\/\.(claude\/(agents|commands|rules)|codex\/prompts)\/.+\.md$/.test(file)) throw `${file} is every machine's own, so Arbor changes it rather than removing it`;
    // `?fileremove=fail`: the file has changes in the repo that aren't committed.
    if (params.get('fileremove') === 'fail') return later(500, () => { throw `${file.slice(2)} or .agents/machines.json has changes in the repo that aren't committed. Commit or drop them, then try again.`; });
    return later(600, () => {
      const files = head?.files ?? [];
      const kept = removedRepoFiles.get(file);
      if (removed) {
        const found = files.find((entry) => entry.path === file);
        if (found) removedRepoFiles.set(file, found);
        mockRemovedFiles.add(file);
        repo.commits.push(repoCommit(`Remove ${file} from every machine`, Date.now(), files.filter((entry) => entry !== found), head?.skills ?? []));
      } else {
        mockRemovedFiles.delete(file);
        removedRepoFiles.delete(file);
        const back = kept && !files.some((entry) => entry.path === file) ? [...files, kept] : files;
        repo.commits.push(repoCommit(`Put ${file} back on every machine`, Date.now(), back, head?.skills ?? []));
      }
      if (repo.upstream) repo.upstream = { ...repo.upstream, ahead: repo.upstream.ahead + 1 };
      return setupRepoReply(path);
    });
  },
  set_setup_file_machine: (args) => {
    mockLog('set_setup_file_machine', args);
    const key = args.machine.toLowerCase().replace(/[^a-z0-9]/g, '');
    const machines = { ...mockFileMachines[args.path] };
    if (args.wanted === null) delete machines[key];
    else machines[key] = args.wanted;
    if (Object.keys(machines).length) mockFileMachines[args.path] = machines;
    else delete mockFileMachines[args.path];
    return setupRepoReply(args.repo);
  },
  set_setup_skill_machine: (args) => {
    mockLog('set_setup_skill_machine', args);
    const key = args.machine.toLowerCase().replace(/[^a-z0-9]/g, '');
    const machines = { ...mockSkillMachines[args.skill] };
    if (args.wanted === null) delete machines[key];
    else machines[key] = args.wanted;
    if (Object.keys(machines).length) mockSkillMachines[args.skill] = machines;
    else delete mockSkillMachines[args.skill];
    return setupRepoReply(args.repo);
  },
  set_setup_skill_project: (args) => {
    mockLog('set_setup_skill_project', args);
    if (args.wanted === 'own') throw 'A project either turns it on or off; without a value it follows its machine';
    const project = args.project.toLowerCase();
    const skill = mockSkillProjects[args.skill] ?? {};
    const values = skill[project] ?? { all: null, machines: {} };
    if (args.machine === null) values.all = args.wanted;
    else {
      const key = args.machine.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (args.wanted === null) delete values.machines[key];
      else values.machines[key] = args.wanted;
    }
    if (values.all === null && !Object.keys(values.machines).length) delete skill[project];
    else skill[project] = values;
    if (Object.keys(skill).length) mockSkillProjects[args.skill] = skill;
    else delete mockSkillProjects[args.skill];
    return later(300, () => setupRepoReply(args.repo));
  },
  set_setup_mcp_project: (args) => {
    mockLog('set_setup_mcp_project', args);
    if (args.wanted === 'own') throw 'A project either turns it on or off; without a value it follows its machine';
    const project = args.project.toLowerCase();
    const server = mockMcpProjects[args.server] ?? {};
    const values = server[project] ?? { all: null, machines: {} };
    if (args.machine === null) values.all = args.wanted;
    else {
      const key = args.machine.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (args.wanted === null) delete values.machines[key];
      else values.machines[key] = args.wanted;
    }
    if (values.all === null && !Object.keys(values.machines).length) delete server[project];
    else server[project] = values;
    if (Object.keys(server).length) mockMcpProjects[args.server] = server;
    else delete mockMcpProjects[args.server];
    return later(300, () => setupRepoReply(args.repo));
  },
  set_setup_plugin: (args) => {
    mockLog('set_setup_plugin', args);
    const at = mockRepoPlugins.findIndex((plugin) => plugin.id === args.plugin);
    const found = mockRepoPlugins[at];
    if (args.project !== null) {
      if (!found) throw "The repo doesn't list that plugin yet. Add it for All machines first.";
      if (args.wanted === 'own') throw 'A project either turns a plugin on or off; without a value it follows its machine';
      const key = args.project.toLowerCase();
      const values = found.projects[key] ?? { all: null, machines: {} };
      if (args.machine === null) values.all = args.wanted;
      else {
        const machineKey = args.machine.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (args.wanted === null) delete values.machines[machineKey];
        else values.machines[machineKey] = args.wanted;
      }
      if (values.all === null && !Object.keys(values.machines).length) delete found.projects[key];
      else found.projects[key] = values;
      return later(300, () => setupRepoReply(args.repo));
    }
    if (args.machine === null) {
      if (args.wanted === 'own') throw "Every machine can't keep its own; take the plugin out of the repo instead";
      if (args.wanted === null) {
        if (at >= 0) mockRepoPlugins.splice(at, 1);
      } else if (found) {
        found.all = args.wanted;
      } else {
        mockRepoPlugins.push({ id: args.plugin, source: args.source, all: args.wanted, machines: {}, projects: {} });
        mockRepoPlugins.sort((a, b) => a.id.localeCompare(b.id));
      }
    } else {
      if (!found) throw "The repo doesn't list that plugin yet. Add it for All machines first.";
      const key = args.machine.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (args.wanted === null) delete found.machines[key];
      else found.machines[key] = args.wanted;
    }
    return later(300, () => setupRepoReply(args.repo));
  },
  set_setup_codex_plugin: (args) => {
    mockLog('set_setup_codex_plugin', args);
    const marketplace = args.plugin.split('@')[1] ?? '';
    if (marketplace === 'openai-bundled' || marketplace === 'openai-primary-runtime') throw "The Codex app keeps that plugin itself, so the repo doesn't list it";
    const at = mockCodexRepoPlugins.findIndex((plugin) => plugin.id === args.plugin);
    const found = mockCodexRepoPlugins[at];
    if (args.machine === null) {
      if (args.wanted === 'own') throw "Every machine can't keep its own; take the plugin out of the repo instead";
      if (args.wanted === null) {
        if (at >= 0) mockCodexRepoPlugins.splice(at, 1);
      } else if (found) {
        found.all = args.wanted;
      } else {
        mockCodexRepoPlugins.push({ id: args.plugin, source: args.source, all: args.wanted, machines: {}, projects: {} });
        mockCodexRepoPlugins.sort((a, b) => a.id.localeCompare(b.id));
      }
    } else {
      if (!found) throw "The repo doesn't list that plugin yet. Add it for All machines first.";
      const key = args.machine.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (args.wanted === null) delete found.machines[key];
      else found.machines[key] = args.wanted;
    }
    return later(300, () => setupRepoReply(args.repo));
  },
  take_setup_file: (args) => {
    const { repo: path, machine } = args;
    const item = scannedSetupItem(machine, args.path);
    const kind = item.path ? syncKind(item.path) : null;
    if (!kind || !item.path || item.sum === null) throw `Arbor doesn't sync ${args.path}`;
    mockLog('take_setup_file', { repo: path, machine, path: item.path });
    const repo = mockRepo(path);
    if (setupTexts[item.sum] === undefined) setupTexts[item.sum] = `# ${item.name}\n\nThe copy on ${machine}.\n`;
    const taken = repoFile(kind, item.path, item.sum);
    const files = [...(repoHead(repo)?.files.filter((file) => file.path !== taken.path) ?? []), taken];
    repo.commits.push(repoCommit(`Take ${item.path} from ${machine}`, Date.now(), files, repoHead(repo)?.skills ?? []));
    if (repo.upstream) repo.upstream = { ...repo.upstream, ahead: repo.upstream.ahead + 1 };
    return later(600, () => setupRepoReply(path));
  },
  take_setup_skills: (args) => {
    const { repo: path, machine, paths } = args;
    mockLog('take_setup_skills', { repo: path, machine, paths });
    const repo = mockRepo(path);
    const taken = paths.map((skillPath) => {
      const item = scannedSetupItem(machine, skillPath);
      const facts = item.skill;
      if (item.kind !== 'skill' || item.sum === null || !facts) throw `Arbor doesn't sync ${skillPath}`;
      repoSkillFiles[item.sum] ??= setupSkills[skillPath]?.[machine] ?? [skillFile('SKILL.md', `${item.sum}-doc`, `---\nname: ${item.name}\ndescription: The copy on ${machine}.\n---\n`)];
      if (facts.source) sourceStates[item.name] = 'current';
      return repoSkill(item.name, item.sum, facts.files, facts.source);
    });
    const names = new Set(taken.map((skill) => skill.name));
    const head = repoHead(repo);
    const subject = taken.length === 1 ? `Take the ${taken[0]!.name} skill from ${machine}` : `Take ${taken.length} skills from ${machine}`;
    return later(900, () => {
      repo.commits.push(repoCommit(subject, Date.now(), head?.files ?? [], [...(head?.skills.filter((skill) => !names.has(skill.name)) ?? []), ...taken]));
      if (repo.upstream) repo.upstream = { ...repo.upstream, ahead: repo.upstream.ahead + 1 };
      return setupRepoReply(path);
    });
  },
  read_setup_repo_skill: (args) => {
    const { name } = args;
    const skill = mockRepo(args.repo).commits.find((commit) => commit.sha === args.commit)?.skills.find((entry) => entry.name === name);
    if (!skill?.sum) throw `The repo's commit has no ${name} skill Arbor can sync`;
    const files = repoSkillFiles[skill.sum] ?? setupSkills[skill.path]?.['casey-mbp'] ?? [skillFile('SKILL.md', 'sk', '# Skill\n')];
    return later(400, () => files);
  },
  list_setup_repo_tree: (args) => {
    if (params.get('repotree') === 'fail') throw `git couldn't read ${args.repo}: the index is locked by another git process`;
    const tree = repoTreeReply(args.repo);
    return later(250, () => ({ ...tree, truncated: params.get('repotree') === 'truncated' }));
  },
  read_setup_repo_text: (args) => {
    const { repo: path, commit } = args;
    checkRepoPath(args.path);
    const repo = mockRepo(path);
    let blob: MockBlob | undefined;
    if (commit) {
      const at = repo.commits.findIndex((entry) => entry.sha === commit);
      if (at < 0) throw `The repo has no commit ${commit.slice(0, 7)}`;
      blob = commitSnapshot(repo, at).get(args.path);
    } else {
      blob = folderFiles(path).get(args.path);
    }
    const problem = blob?.problem ?? (secretName(args.path) ? 'secret' : null);
    return later(200, () => ({ content: problem ? null : blob?.text ?? null, sum: problem ? null : blob?.sum ?? null, problem }));
  },
  write_setup_repo_text: (args) => {
    const { repo: path, content, expected } = args;
    checkRepoPath(args.path);
    if (secretName(args.path)) throw `${args.path}'s name says it may hold a secret, so Arbor doesn't write it`;
    if (content.length > 1_048_576) throw 'Keep a file in the repo under 1 MB';
    const folder = folderFiles(path);
    const now = folder.get(args.path);
    if (now?.problem) throw `Arbor doesn't edit ${args.path}`;
    if (params.get('repowrite') === 'stale' || (now?.sum ?? null) !== expected) {
      throw now ? `${args.path} changed since Arbor read it. Read it again, then make the edit.` : `${args.path} is gone since Arbor read it`;
    }
    if (!now && [...folder.keys()].some((file) => file.startsWith(`${args.path}/`) || args.path.startsWith(`${file}/`))) throw `There's already something at ${args.path}`;
    mockLog('write_setup_repo_text', { repo: path, path: args.path, size: content.length });
    setFolderFile(path, args.path, textBlob(content));
    return later(300, () => repoTreeReply(path));
  },
  move_setup_repo_path: (args) => {
    const { repo: path, from, to } = args;
    checkRepoPath(from);
    checkRepoPath(to);
    if (secretName(to)) throw `${to}'s name says it may hold a secret, so Arbor doesn't make it`;
    if (to.startsWith(`${from}/`)) throw `Arbor can't move ${from} inside itself`;
    const folder = folderFiles(path);
    const moving = [...folder].filter(([file]) => file === from || file.startsWith(`${from}/`));
    if (!moving.length) throw `The repo has no ${from}`;
    if ([...folder.keys()].some((file) => file === to || file.startsWith(`${to}/`) || to.startsWith(`${file}/`))) throw `There's already something at ${to}`;
    mockLog('move_setup_repo_path', { repo: path, from, to });
    for (const [file, blob] of moving) {
      setFolderFile(path, file, null);
      setFolderFile(path, `${to}${file.slice(from.length)}`, blob);
    }
    return later(300, () => repoTreeReply(path));
  },
  delete_setup_repo_path: (args) => {
    const { repo: path } = args;
    checkRepoPath(args.path);
    const going = [...folderFiles(path).keys()].filter((file) => file === args.path || file.startsWith(`${args.path}/`));
    if (!going.length) throw `The repo has no ${args.path}`;
    mockLog('delete_setup_repo_path', { repo: path, path: args.path, files: going.length });
    for (const file of going) setFolderFile(path, file, null);
    return later(300, () => repoTreeReply(path));
  },
  discard_setup_repo_changes: (args) => {
    const { repo: path, paths } = args;
    paths.forEach(checkRepoPath);
    const worktree = worktreeOf(path);
    mockLog('discard_setup_repo_changes', { repo: path, paths });
    for (const file of worktree.keys()) {
      if (paths.some((chosen) => file === chosen || file.startsWith(`${chosen}/`))) worktree.delete(file);
    }
    return later(300, () => repoTreeReply(path));
  },
  get_setup_repo_changes: (args) => {
    const { repo: path, commit } = args;
    const repo = mockRepo(path);
    if (!commit) return later(300, () => snapshotChanges(headSnapshot(repo), folderFiles(path)));
    const at = repo.commits.findIndex((entry) => entry.sha === commit);
    if (at < 0) throw `The repo has no commit ${commit.slice(0, 7)}`;
    return later(300, () => snapshotChanges(at ? commitSnapshot(repo, at - 1) : new Map(), commitSnapshot(repo, at)));
  },
  get_setup_repo_log: (args) => later(250, () => [...mockRepo(args.repo).commits].reverse().slice(0, args.limit).map(({ sha, subject, atMs }) => ({ sha, subject, atMs }))),
  commit_setup_repo: (args) => later(700, () => commitRepoMock(args.repo, args.paths, args.message)),
  check_setup_skill_sources: (args) => {
    const repo = mockRepo(args.repo);
    const { force } = args;
    mockLog('check_setup_skill_sources', { force });
    // What GitHub said in the last 15 minutes is used again, unless forced.
    const at = Date.now();
    const asked = force || sourcesCheckedAt === null || at - sourcesCheckedAt >= 15 * 60_000;
    if (asked) sourcesCheckedAt = at;
    const checkedAtMs = sourcesCheckedAt;
    const refused = params.get('sources') === 'fail';
    // The app writes this time as "%H:%M" on the Mac's clock, whatever its region.
    const resetDate = new Date(at + 38 * 60_000);
    const resetsAt = `${String(resetDate.getHours()).padStart(2, '0')}:${String(resetDate.getMinutes()).padStart(2, '0')}`;
    const checks = (repoHead(repo)?.skills ?? []).flatMap((skill): SourceCheck[] => {
      if (!skill.source) return [];
      const state = refused ? 'error' : sourceStates[skill.name] ?? 'current';
      const detail = refused ? `GitHub's limit on checks without an account is used up until ${resetsAt}` : null;
      return [{ name: skill.name, source: skill.source.source, ref: skill.source.ref, state, detail, checkedAtMs }];
    });
    return later(asked ? 1_100 : 250, () => checks);
  },
  update_setup_skill: (args) => {
    const { repo: path, name } = args;
    mockLog('update_setup_skill', { repo: path, name });
    const repo = mockRepo(path);
    const head = repoHead(repo);
    const skill = head?.skills.find((entry) => entry.name === name);
    if (!head || !skill?.source) throw `The repo has no ${name} skill from GitHub`;
    if (skill.problem) throw `Arbor can't sync ${name} as the repo has it, so it doesn't update it either`;
    const sum = `${skill.sum ?? name}-new`;
    repoSkillFiles[sum] ??= [...(repoSkillFiles[skill.sum ?? ''] ?? []), skillFile('references/notes.md', `${sum}-notes`, '# Notes\n\nFrom the latest copy.\n')];
    const files = repoSkillFiles[sum]!.length;
    const updated: SetupRepoSkill = {
      ...skill, sum, ck: `c${parseInt(mockSha(sum).slice(0, 8), 16)}-${files * 40}`, files, size: files * 1_536,
      source: { ...skill.source, skillFolderHash: mockSha(sum) },
    };
    return later(1_400, () => {
      sourceStates[name] = 'current';
      repo.commits.push(repoCommit(`Update ${name} from ${skill.source!.source}`, Date.now(), head.files, head.skills.map((entry) => (entry.name === name ? updated : entry))));
      if (repo.upstream) repo.upstream = { ...repo.upstream, ahead: repo.upstream.ahead + 1 };
      return setupRepoReply(path);
    });
  },
  pull_setup_repo: (args) => {
    const path = args.repo;
    const repo = mockRepo(path);
    return later(900, () => {
      if (repo.upstream?.ahead && repo.upstream.behind) {
        throw `This repo and ${repo.upstream.name} each have commits the other hasn't. Merge or rebase them in a terminal, then read the repo again.`;
      }
      repo.commits.push(...repo.incoming);
      repo.incoming = [];
      if (repo.upstream) repo.upstream = { ...repo.upstream, behind: 0 };
      return setupRepoReply(path);
    });
  },
  push_setup_repo: (args) => {
    const path = args.repo;
    const repo = mockRepo(path);
    return later(900, () => {
      if (repo.upstream?.behind) throw `${repo.upstream.name} has commits this repo hasn't. Pull them first.`;
      if (repo.upstream) repo.upstream = { ...repo.upstream, ahead: 0 };
      return setupRepoReply(path);
    });
  },
  apply_setup_sync: (args) => {
    const { repo, commit, machine, changes } = args;
    mockLog('apply_setup_sync', { machine, commit: commit.slice(0, 7), changes });
    const found = mockRepo(repo).commits.find((entry) => entry.sha === commit);
    if (!found) throw "That isn't a commit";
    const entry = setupMachines.find((candidate) => candidate.machine === machine);
    if (!entry) throw `Arbor isn't checking a machine called ${machine}`;
    return later(1_000, () => applySetupMock(entry, found, changes));
  },
  list_setup_backups: (args) => {
    if (params.get('changes') === 'fail') return later(300, () => { throw `ssh: connect to host ${args.machine} port 22: Operation timed out`; });
    const backups = (setupBackups[args.machine] ?? []).map(({ id, atMs, what, commit, undoneAtMs, files, skills }) => ({ id, atMs, what, commit, undoneAtMs, files, skills }));
    return later(300, () => backups);
  },
  undo_setup_sync: (args) => {
    const { machine } = args;
    mockLog('undo_setup_sync', { machine, backup: args.backup });
    const entry = setupMachines.find((candidate) => candidate.machine === machine);
    const backup = setupBackups[machine]?.find((candidate) => candidate.id === args.backup);
    if (!entry || !backup) throw "That change's backup isn't on this machine any more.";
    if (backup.undoneAtMs !== null) throw 'That change was undone already.';
    return later(900, () => undoSetupMock(entry, backup));
  },
  apply_skill_changes: (args) => {
    const { machine, changes } = args;
    mockLog('apply_skill_changes', { machine, changes });
    const entry = setupMachines.find((candidate) => candidate.machine === machine);
    if (!entry) throw `Arbor isn't checking a machine called ${machine}`;
    if (!changes.length) throw "There's nothing to change";
    return later(1_000, () => applySkillsMock(entry, changes));
  },
  get_skill_usage: () => later(350, () => structuredClone(skillUsage)),
  get_mcp_usage: () => later(400, () => structuredClone(mcpUsage)),
  apply_checkout_skills: (args) => {
    mockLog('apply_checkout_skills', args);
    if (!args.changes.length) throw "There's nothing to change";
    const scan = projectsState.find((entry) => entry.machine === args.machine);
    if (!scan) throw `Arbor isn't checking a machine called ${args.machine}`;
    const worktrees = scan.repos.flatMap((repo) => repo.worktrees);
    const missing = args.changes.find((change) => !worktrees.some((worktree) => worktree.path === change.checkout));
    if (missing) throw `Arbor hasn't found ${missing.checkout} on ${args.machine}. Scan its projects again.`;
    // `?skillprojects=seen`: cedar-02's worktrees have no settings.local.json yet and Git would see a new one.
    const seen = params.get('skillprojects') === 'seen';
    return later(1200, () => args.changes.map((change): CheckoutSkillResult => {
      const worktree = worktrees.find((candidate) => candidate.path === change.checkout);
      if (!worktree) return { checkout: change.checkout, skill: change.skill, outcome: 'missing' };
      if (seen && args.machine === 'cedar-02' && !worktree.main) return { checkout: change.checkout, skill: change.skill, outcome: 'notIgnored' };
      const state = change.on ? 'on' : 'off';
      const had = worktree.skills.find((skill) => skill.local && skill.name === change.skill);
      if (had?.state === state) return { checkout: change.checkout, skill: change.skill, outcome: 'already' };
      worktree.skills = [...worktree.skills.filter((skill) => !(skill.local && skill.name === change.skill)), { name: change.skill, state, local: true }];
      return { checkout: change.checkout, skill: change.skill, outcome: 'done' };
    }));
  },
  apply_checkout_mcp: (args) => {
    mockLog('apply_checkout_mcp', args);
    if (!args.changes.length) throw "There's nothing to change";
    const scan = projectsState.find((entry) => entry.machine === args.machine);
    const entry = setupMachines.find((candidate) => candidate.machine === args.machine);
    if (!scan || !entry) throw `Arbor isn't checking a machine called ${args.machine}`;
    const worktrees = scan.repos.flatMap((repo) => repo.worktrees);
    const missing = args.changes.find((change) => !worktrees.some((worktree) => worktree.path === change.checkout));
    if (missing) throw `Arbor hasn't found ${missing.checkout} on ${args.machine}. Scan its projects again.`;
    const home = entry.homes.find((candidate) => candidate.agent === 'claude' && candidate.path === '~/.claude');
    return later(1400, () => args.changes.map((change): CheckoutMcpResult => {
      const result = (outcome: CheckoutMcpResult['outcome']): CheckoutMcpResult => ({ checkout: change.checkout, server: change.server, outcome });
      const worktree = worktrees.find((candidate) => candidate.path === change.checkout);
      if (!worktree) return result('missing');
      if (!change.on) {
        if (worktree.mcpDenied.some((deny) => deny.local && deny.name === change.server)) return result('already');
        worktree.mcpDenied = [...worktree.mcpDenied, { name: change.server, local: true }];
        return result('done');
      }
      if (home?.deniedMcp.includes(change.server) || worktree.mcpDenied.some((deny) => !deny.local && deny.name === change.server)) return result('denied');
      if (worktree.mcpDisabled.includes(change.server)) return result('toggled');
      worktree.mcpDenied = worktree.mcpDenied.filter((deny) => !(deny.local && deny.name === change.server));
      const there = home?.items.some((item) => item.kind === 'mcp' && item.name === change.server) || worktree.mcpLocal.includes(change.server);
      if (!there) {
        const server = mockRegistry.servers.find((candidate) => candidate.name === change.server);
        if (!server || !wantedMock(server, args.machine, 'claude', '~/.claude')) return result('noDefinition');
        worktree.mcpLocal = [...worktree.mcpLocal, change.server];
      }
      return result('done');
    }));
  },
  apply_checkout_instructions: (args) => {
    mockLog('apply_checkout_instructions', args);
    if (!args.changes.length) throw "There's nothing to change";
    const scan = projectsState.find((entry) => entry.machine === args.machine);
    if (!scan) throw `Arbor isn't checking a machine called ${args.machine}`;
    const project = args.project.toLowerCase();
    const worktrees = scan.repos.filter((repo) => repo.remote?.toLowerCase().endsWith(`/${project}`)).flatMap((repo) => repo.worktrees);
    const missing = args.changes.find((change) => !worktrees.some((worktree) => worktree.path === change.checkout));
    if (missing) throw `Arbor hasn't found ${missing.checkout} on ${args.machine} as a checkout of ${project}. Scan its projects again.`;
    const text = instructionsFor(project, args.machine);
    const hash = text === null ? '-' : instructionsHash(text);
    return later(1200, () => args.changes.map((change): CheckoutInstructionsResult => {
      const result = (outcome: CheckoutInstructionsResult['outcome']): CheckoutInstructionsResult => ({ checkout: change.checkout, file: change.file, outcome });
      const worktree = worktrees.find((candidate) => candidate.path === change.checkout);
      const file = worktree?.instructions.find((entry) => entry.file === change.file);
      if (!worktree || !file) return result('missing');
      if (file.state === 'own') return result('own');
      if (file.state === 'seen') return result('notIgnored');
      if (file.state === 'none' && text === null) return result('already');
      const next: CheckoutInstructions = change.file === 'claudeLocal'
        ? { file: change.file, state: 'arbor', text: hash, import: Boolean(worktree.agentsMd) && !worktree.claudeMd, agents: null }
        : { file: change.file, state: 'arbor', text: hash, import: null, agents: worktree.agentsMd ?? '-' };
      if (JSON.stringify(next) === JSON.stringify(file)) return result('already');
      worktree.instructions = worktree.instructions.map((entry) => (entry.file === change.file ? next : entry));
      return result('done');
    }));
  },
  forget_plugin_leftovers: (args) => {
    const { machine, leftovers } = args;
    mockLog('forget_plugin_leftovers', { machine, leftovers });
    const entry = setupMachines.find((candidate) => candidate.machine === machine);
    if (!entry) throw `Arbor isn't checking a machine called ${machine}`;
    if (!leftovers.length) throw "There's nothing to clean up";
    // `?leftovers=fail`: the settings file changed since the scan, so nothing is written.
    if (params.get('leftovers') === 'fail') return later(900, () => { throw `${machine}'s settings.json changed since Arbor read it. Scan again, then clean up.`; });
    const edits: SettingsEdit[] = [];
    for (const home of entry.homes.filter((candidate) => leftovers.some((leftover) => leftover.home === candidate.path))) {
      const names = new Set(leftovers.filter((leftover) => leftover.home === home.path).map((leftover) => leftover.plugin));
      const gone = home.items.filter((item) => item.kind === 'plugin' && names.has(item.name) && item.value === null);
      if (gone.length !== names.size) throw `${home.path} doesn't name ${[...names].join(', ')} as the last scan found it. Scan again.`;
      home.items = home.items.filter((item) => !gone.includes(item));
      edits.push({ home: home.path, path: `${home.path}/settings.json`, change: 'edit', written: true, error: null });
    }
    recordEditMock(machine, 'plugins', edits.map((edit) => ({ path: edit.path, added: false })));
    scanSetupMock(machine, false);
    return later(900, () => edits);
  },
  apply_plugin_changes: (args) => {
    const { machine, changes } = args;
    mockLog('apply_plugin_changes', { machine, changes });
    const entry = setupMachines.find((candidate) => candidate.machine === machine);
    if (!entry) throw `Arbor isn't checking a machine called ${machine}`;
    if (!changes.length) throw "There's nothing to change";
    for (const change of changes) {
      if (change.action !== 'update' && change.action !== 'refresh' && change.action !== 'addMarketplace') leaveToPolicy(entry, 'plugin', [change.target]);
    }
    return later(1_600, () => applyPluginsMock(entry, changes));
  },
  apply_codex_plugin_changes: (args) => {
    const { machine, changes } = args;
    mockLog('apply_codex_plugin_changes', { machine, changes });
    const entry = setupMachines.find((candidate) => candidate.machine === machine);
    if (!entry) throw `Arbor isn't checking a machine called ${machine}`;
    if (!changes.length) throw "There's nothing to change";
    return later(1_400, () => applyCodexPluginsMock(entry, changes));
  },
  get_mcp_registry: (args) => later(250, () => registryReply(args.repo)),
  apply_mcp_changes: (args) => {
    const { machine, changes } = args;
    mockLog('apply_mcp_changes', { repo: args.repo, commit: args.commit, machine, changes });
    const entry = setupMachines.find((candidate) => candidate.machine === machine);
    if (!entry) throw `Arbor isn't checking a machine called ${machine}`;
    if (!changes.length) throw "There's nothing to change";
    return later(1_400, () => applyMcpMock(entry, changes));
  },
  take_mcp_server: (args) => {
    const { repo, machine, home, name, own } = args;
    mockLog('take_mcp_server', { repo, machine, home, name, own });
    return later(700, () => takeMcpMock(repo, machine, home, name, own));
  },
  set_mcp_wanted: (args) => {
    const { repo, name, machine, wanted } = args;
    mockLog('set_mcp_wanted', { repo, name, machine, wanted });
    return later(500, () => setMcpWantedMock(repo, name, machine ?? null, wanted));
  },
  put_back_mcp_server: (args) => {
    const { repo, name } = args;
    mockLog('put_back_mcp_server', { repo, name });
    return later(500, () => putBackMcpMock(repo, name));
  },
  get_hook_registry: (args) => later(250, () => hookRegistryReply(args.repo)),
  set_hook_wanted: (args) => {
    const { repo, name, machine, wanted } = args;
    mockLog('set_hook_wanted', { repo, name, machine, wanted });
    return later(500, () => setHookWantedMock(repo, name, machine ?? null, wanted));
  },
  take_hook: (args) => {
    const { repo, machine, home, event, script } = args;
    mockLog('take_hook', { repo, machine, home, event, script });
    return later(700, () => takeHookMock(repo, machine, home, event, script));
  },
  apply_hooks: (args) => {
    const { repo, commit, machine } = args;
    mockLog('apply_hooks', { repo, commit, machine });
    const entry = setupMachines.find((candidate) => candidate.machine === machine);
    if (!entry) throw `Arbor isn't checking a machine called ${machine}`;
    return later(1_200, () => applyHooksMock(entry));
  },
  set_hook_agents: (args) => {
    const { repo, name, agents } = args;
    mockLog('set_hook_agents', { repo, name, agents });
    return later(500, () => setHookAgentsMock(repo, name, agents));
  },
  get_projects: () => projectsState.map(projectsReply),
  scan_projects: (args) => {
    mockLog('scan_projects', { machine: args.machine, fetch: Boolean(args.fetch) });
    return scanProjectsMock(args.machine, Boolean(args.fetch));
  },
  measure_projects: (args) => measureProjectsMock(args.machine),
  read_project_file: (args) => {
    const entry = projectsEntry(args.machine);
    const file = entry.repos.find((repo) => repo.path === args.repo)?.files.find((candidate) => candidate.name === args.name);
    if (!file) throw 'Arbor can only show what its last scan of this machine found. Scan again.';
    const content = projectTexts[file.sum] ?? `# ${args.name}\n\nThe copy on ${entry.machine}.\n`;
    return later(350, () => ({ content, size: content.length }));
  },
  remove_worktrees: (args) => {
    const { machine, removals } = args;
    mockLog('remove_worktrees', { machine, removals });
    return removeWorktreesMock(machine, removals);
  },
  get_toolchain: () => structuredClone(toolchainState),
  change_node_versions: (args) => {
    mockLog('change_node_versions', { machine: args.machine, changes: args.changes });
    return changeNodeMock(args.machine, args.changes);
  },
  scan_toolchain: (args) => {
    mockLog('scan_toolchain', { machine: args.machine });
    return scanToolchainMock(args.machine);
  },
  check_mcp_health: (args) => {
    const entry = setupMachines.find((candidate) => candidate.machine === args.machine);
    if (!entry) throw `Arbor isn't checking a machine called ${args.machine}`;
    return later(entry.local ? 900 : 1_800, () => mcpHealthMock(entry, args.home));
  },
  measure_plugin_costs: (args) => {
    const entry = setupMachines.find((candidate) => candidate.machine === args.machine);
    if (!entry) throw `Arbor isn't checking a machine called ${args.machine}`;
    return later(entry.local ? 1_200 : 2_400, () => pluginCostsMock(entry, args.home));
  },
};

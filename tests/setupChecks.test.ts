import { describe, expect, it } from 'bun:test';
import { checkCounts, cleanupDays, itemProblem, listingChars, setupChecks, type SetupCheck } from '../src/services/setupChecks';
import type { SetupHome, SetupInstall, SetupItem, SetupMachine, SkillFacts, SkillOverride } from '../src/native/types';

const item = (kind: SetupItem['kind'], name: string, sum: string | null, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind, name, path: null, sum, size: null, link: null, value: null, note: null, count: null, enabled: null, text: false, skill: null, import: null, ...fields,
});
const facts = (fields: Partial<SkillFacts> = {}): SkillFacts => ({
  files: 2, hasDoc: true, declaredName: null, descriptionChars: 120, whenToUseChars: 0, manualOnly: false, source: null, ...fields,
});
const skill = (name: string, sum: string | null, fields: Partial<SkillFacts> | null = {}, link: string | null = null, folder = '~/.claude/skills') =>
  item('skill', name, sum, { path: `${folder}/${name}`, link, skill: fields === null ? null : facts({ declaredName: name, ...fields }) });
const imported = (name: string, sum: string | null, level: number, from = '~/.claude/CLAUDE.md') =>
  item('import', name, sum, { import: { from, written: `@${name}`, level } });
const setting = (name: string, value: string | null = null) => item('setting', name, 's', { value });
const home = (agent: SetupHome['agent'], path: string, items: SetupItem[], problems: string[] = []): SetupHome => ({ agent, path, items, problems, skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null });
const install = (agent: SetupInstall['agent'], path: string, version: string | null): SetupInstall => ({ agent, path, real: null, version });
const machine = (name: string, homes: SetupHome[], fields: Partial<SetupMachine> = {}): SetupMachine => ({
  machine: name, local: false, reachable: true, homes, installs: [], policy: null, scannedAt: 1_000, error: null, scanning: false, ...fields,
});
const find = (checks: SetupCheck[], kind: SetupCheck['kind'], home?: string) =>
  checks.filter((check) => check.kind === kind && (home === undefined || check.home === home));
const named = (check: SetupCheck | undefined) => check?.subjects.map((subject) => subject.value === null ? subject.name : `${subject.name} (${subject.value})`);

describe('setup item problems', () => {
  it('tells an @import that leads nowhere, a link to nothing and a skill without a SKILL.md apart', () => {
    expect(itemProblem(item('import', '~/notes/gone.md', null))).toBe('notFound');
    expect(itemProblem(item('command', 'old', null, { link: '~/dotfiles/old.md' }))).toBe('brokenLink');
    expect(itemProblem(skill('gone', null, null, '~/src/gone'))).toBe('brokenLink');
    // A link to a folder that's there, but isn't a skill.
    expect(itemProblem(skill('all', null, { hasDoc: false, files: 0 }, '~/.agents/skills'))).toBe('noSkillDoc');
    expect(itemProblem(skill('pdf', 'p1'))).toBeNull();
  });
});

describe('Claude Code checks', () => {
  const claude = home('claude', '~/.claude', [
    item('instructions', 'CLAUDE.md', 'c1', { size: 1_700 }),
    item('rule', 'huge.md', 'r1', { size: 5 * 1024 * 1024 }),
    imported('~/Developer/harness/SKILL.md', null, 1),
    imported('~/notes/style.md', 'n1', 1),
    imported('~/notes/four.md', 'n4', 4, '~/notes/three.md'),
    imported('~/notes/five.md', 'n5', 5, '~/notes/four.md'),
    imported('~/notes/gone-five.md', null, 5, '~/notes/four.md'),
    item('command', 'old', null, { link: '~/dotfiles/old.md' }),
    skill('pdf', 'p1', {}, '~/.agents/skills/pdf'),
    skill('design', 'd-mine'),
    skill('notes', 'n-same'),
    skill('scratch', null, { hasDoc: false, files: 0, declaredName: null }),
    skill('all', null, { hasDoc: false, files: 0, declaredName: null }, '~/.agents/skills'),
    skill('gone', null, null, '~/src/gone'),
    skill('bare', 'b1', { descriptionChars: 0, declaredName: null }),
    skill('renamed', 'r1', { declaredName: 'new-name' }),
    item('mcp', 'linear', 'x1'),
    item('mcp', 'playwright', 'x2'),
    item('env', 'ANTHROPIC_BASE_URL', 'e1'),
  ]);
  const shared = home('shared', '~/.agents', [
    skill('pdf', 'p1', {}, null, '~/.agents/skills'),
    skill('design', 'd-shared', {}, null, '~/.agents/skills'),
    skill('notes', 'n-same', {}, null, '~/.agents/skills'),
  ]);
  const second = home('claude', '~/.agent-app/homes/claude-proxy', [item('plugin', 'superpowers@market', 'p')]);
  const checks = setupChecks([machine('mac', [claude, shared, second])]);
  const at = 'claude:~/.claude';

  it('finds @imports that lead nowhere, and ones too deep to be followed', () => {
    expect(find(checks, 'brokenImport')[0]!.subjects).toEqual([{ name: '~/Developer/harness/SKILL.md', value: '~/.claude/CLAUDE.md', home: at, pair: null }]);
    const [deep] = find(checks, 'deepImport');
    expect(named(deep)).toEqual(['~/notes/five.md (~/notes/four.md)', '~/notes/gone-five.md (~/notes/four.md)']);
    expect(deep!.facts.hops).toBe(4);
  });

  it('finds links to nothing, files too large to load and skill folders without a SKILL.md', () => {
    expect(named(find(checks, 'brokenLink')[0])).toEqual(['old (~/dotfiles/old.md)', 'gone (~/src/gone)']);
    expect(find(checks, 'brokenLink')[0]!.facts.agent).toBe('Claude Code');
    expect(named(find(checks, 'tooLarge')[0])).toEqual(['huge.md']);
    const [noDoc] = find(checks, 'skillNoDoc');
    expect(named(noDoc)).toEqual(['scratch', 'all (~/.agents/skills)']);
    expect(noDoc!.level).toBe('warning');
  });

  it('leaves a skill without a description alone, as Claude Code lists its first line instead', () => {
    expect(find(checks, 'skillNoDescription')).toEqual([]);
    expect(named(find(checks, 'skillNameMismatch', at)[0])).toEqual(['renamed (new-name)']);
    expect(find(checks, 'skillNameMismatch', at)[0]!.facts.agentId).toBe('claude');
  });

  it('finds a home’s own copy of a shared skill that no longer matches it', () => {
    const drifted = find(checks, 'skillDrifted');
    expect(drifted.length).toBe(1);
    const [subject] = drifted[0]!.subjects;
    expect(subject!.name).toBe('design');
    expect(subject!.pair!.a).toMatchObject({ home: 'shared:~/.agents', item: { sum: 'd-shared' } });
    expect(subject!.pair!.b).toMatchObject({ home: at, item: { sum: 'd-mine' } });
  });

  it('notes a Claude Code home without skills while ~/.claude has them', () => {
    expect(find(checks, 'noSkills')).toMatchObject([{ home: 'claude:~/.agent-app/homes/claude-proxy', facts: { count: 5 } }]);
    const alone = setupChecks([machine('solo', [home('claude', '~/.agent-app/homes/claude-proxy', [])])]);
    expect(find(alone, 'noSkills')).toEqual([]);
  });

  it('notes tool search being off behind a proxy, until ENABLE_TOOL_SEARCH is set', () => {
    expect(find(checks, 'toolSearchOff')).toMatchObject([{ home: at, facts: { count: 2 } }]);
    const on = setupChecks([machine('mac', [home('claude', '~/.claude', [...claude.items, item('env', 'ENABLE_TOOL_SEARCH', 'e2')])])]);
    expect(find(on, 'toolSearchOff')).toEqual([]);
  });

  it('adds up the skill listing the way Claude Code cuts it, leaving out skills only a person invokes', () => {
    expect(listingChars([
      skill('ab', 's', { descriptionChars: 100, whenToUseChars: 20 }),
      skill('long', 's', { descriptionChars: 1_500, whenToUseChars: 100 }),
      skill('deploy', 's', { manualOnly: true }),
      skill('empty', null, { hasDoc: false }),
      item('command', 'ship', 'c'),
    ])).toBe(2 + 120 + 4 + 4 + 1_536 + 4);
    expect(find(checks, 'listingBudget')).toEqual([]);
    const many = Array.from({ length: 60 }, (_, index) => skill(`skill-${index}`, `s${index}`, { descriptionChars: 150 }));
    const [budget] = find(setupChecks([machine('mac', [home('claude', '~/.claude', many)])]), 'listingBudget');
    expect(budget!.facts).toEqual({ chars: 60 * 4 + 10 * 7 + 50 * 8 + 60 * 150, fallback: 8_000 });
  });

  it('follows the home’s skill overrides: off and typed-only skills aren’t listed, name-only ones by name', () => {
    const override = (name: string, state: SkillOverride['state']): SkillOverride => ({ name, state, source: 'settings', file: '~/.claude/settings.json' });
    const skills = [skill('ab', 's', { descriptionChars: 100 }), skill('cd', 's', { descriptionChars: 100 }), skill('ef', 's', { descriptionChars: 100 }), skill('gh', 's')];
    expect(listingChars(skills, undefined, [override('ab', 'off'), override('cd', 'userInvocableOnly'), override('ef', 'nameOnly'), override('gh', 'on')]))
      .toBe(2 + 4 + 2 + 120 + 4);

    // A copy that drifted from the shared one doesn't matter where the settings turn it off.
    const off = setupChecks([machine('mac', [{ ...claude, skillOverrides: [override('design', 'off')] }, shared])]);
    expect(find(off, 'skillDrifted')).toEqual([]);
  });

  it('names what a machine’s policy sets, says when it can’t be read, and leaves its session setting alone', () => {
    const file = '/Library/Application Support/ClaudeCode/managed-settings.json';
    const ruled = machine('mac', [claude, second], {
      policy: { file, keys: [{ kind: 'setting', name: 'cleanupPeriodDays' }, { kind: 'env', name: 'CLAUDE_CODE_ENABLE_TELEMETRY' }], problem: null, ignoredOverrides: true },
    });
    const found = setupChecks([ruled]);
    expect(find(found, 'policySets')).toMatchObject([{ level: 'note', home: null, facts: { file, count: 2 } }]);
    expect(find(found, 'policySets')[0]!.subjects.map((subject) => [subject.name, subject.home])).toEqual([['cleanupPeriodDays', at], ['CLAUDE_CODE_ENABLE_TELEMETRY', at]]);
    expect(find(found, 'overridesIgnored')).toMatchObject([{ home: null, facts: { file } }]);
    expect(find(found, 'sessionCleanup')).toEqual([]);
    expect(find(checks, 'sessionCleanup').length).toBeGreaterThan(0);

    const unread = setupChecks([machine('mac', [claude], { policy: { file, keys: [], problem: `${file} is there, but the user Arbor signs in as can't read it`, ignoredOverrides: false } })]);
    expect(find(unread, 'policyUnreadable')).toMatchObject([{ level: 'warning', home: null }]);
    expect(find(unread, 'policySets')).toEqual([]);
  });

  it('warns when Claude Code ignores every override in a settings file', () => {
    const ignored = setupChecks([machine('mac', [{ ...claude, ignoredOverrides: ['~/.claude/settings.json'] }])]);
    expect(find(ignored, 'overridesIgnored')).toMatchObject([{ level: 'warning', home: at, facts: { file: '~/.claude/settings.json' } }]);
    expect(find(checks, 'overridesIgnored')).toEqual([]);
  });
});

describe('session cleanup', () => {
  it('warns about a Claude Code home that deletes old sessions, and says after how long', () => {
    const checks = setupChecks([machine('mac', [
      home('claude', '~/.claude', [setting('cleanupPeriodDays', '36500')]),
      home('claude', '~/.agent-app/homes/claude-proxy', []),
      home('claude', '~/.agent-tool/profiles/work2', [setting('cleanupPeriodDays', '90')]),
      home('codex', '~/.codex', []),
    ])]);
    expect(find(checks, 'sessionCleanup').map((check) => [check.home, check.facts])).toEqual([
      ['claude:~/.agent-app/homes/claude-proxy', { count: 30, home: '~/.agent-app/homes/claude-proxy' }],
      ['claude:~/.agent-tool/profiles/work2', { count: 90, home: '~/.agent-tool/profiles/work2' }],
    ]);
    expect(find(checks, 'sessionCleanup')[0]!.level).toBe('note');
    // A machine the session archive keeps loses nothing when they go.
    const kept = setupChecks([machine('mac', [home('claude', '~/.claude', [])])], (scanned) => scanned.machine === 'mac');
    expect(find(kept, 'sessionCleanup')).toEqual([]);
  });

  it('counts 0, and anything that isn’t a whole number, as Claude Code’s 30 days', () => {
    expect(cleanupDays([])).toBe(30);
    expect(cleanupDays([setting('cleanupPeriodDays', '0')])).toBe(30);
    expect(cleanupDays([setting('cleanupPeriodDays')])).toBe(30);
    expect(cleanupDays([setting('cleanupPeriodDays', '7.5')])).toBe(30);
    expect(cleanupDays([setting('cleanupPeriodDays', '3649')])).toBe(3_649);
    expect(cleanupDays([setting('cleanupPeriodDays', '3650')])).toBeNull();
  });
});

describe('Codex checks', () => {
  const codex = home('codex', '~/.codex', [
    item('instructions', 'AGENTS.md', 'a1'),
    skill('mine', 'm1', {}, null, '~/.codex/skills'),
    skill('pdf', 'p2', {}, null, '~/.codex/skills'),
    skill('silent', 's1', { descriptionChars: 0 }, null, '~/.codex/skills'),
    skill('x'.repeat(65), 'l1', { declaredName: null }, null, '~/.codex/skills'),
    setting('profile'),
    setting('approval_policy', 'untrusted'),
    setting('profiles'),
    setting('experimental_instructions_file'),
    setting('features.codex_hooks'),
    setting('model', 'gpt-5.5'),
  ]);
  const shared = home('shared', '~/.agents', [
    skill('pdf', 'p1', {}, null, '~/.agents/skills'),
    skill('pdf-tools', 'p3', { declaredName: 'twin' }, null, '~/.agents/skills'),
    skill('twin', 'p4', {}, null, '~/.agents/skills'),
    skill('group', null, { hasDoc: false, files: 0, declaredName: null }, null, '~/.agents/skills'),
  ]);
  const checks = setupChecks([machine('mac', [codex, shared])]);
  const at = 'codex:~/.codex';

  it('finds skills Codex won’t load, and leaves folders of skills alone', () => {
    expect(named(find(checks, 'skillNoDescription')[0])).toEqual(['silent']);
    expect(named(find(checks, 'skillLongName')[0])).toEqual(['x'.repeat(65)]);
    expect(find(checks, 'skillNoDoc')).toEqual([]);
  });

  it('finds skills Codex would know by one name, in its home and the shared skills', () => {
    expect(named(find(checks, 'skillDuplicate', at)[0])).toEqual(['pdf', 'pdf']);
    expect(find(checks, 'skillDuplicate', at)[0]!.subjects.map((subject) => subject.home)).toEqual([at, 'shared:~/.agents']);
    expect(named(find(checks, 'skillDuplicate', 'shared:~/.agents')[0])).toEqual(['pdf-tools (twin)', 'twin']);
    expect(named(find(checks, 'skillNameMismatch', 'shared:~/.agents')[0])).toEqual(['pdf-tools (twin)']);
  });

  it('finds settings Codex no longer reads, and what takes their place', () => {
    expect(named(find(checks, 'codexUnsupported')[0])).toEqual(['profile (profileFlag)', 'approval_policy (untrusted)']);
    expect(named(find(checks, 'codexDeprecated')[0])).toEqual([
      'profiles (profileFiles)',
      'experimental_instructions_file (model_instructions_file)',
      'features.codex_hooks (features.hooks)',
    ]);
    const current = setupChecks([machine('mac', [home('codex', '~/.codex', [setting('approval_policy', 'on-request')])])]);
    expect(find(current, 'codexUnsupported')).toEqual([]);
  });

  it('notes skills kept in Codex’s old skills folder', () => {
    expect(find(checks, 'codexSkillsFolder')[0]!.subjects.length).toBe(4);
  });
});

describe('the fleet’s checks', () => {
  const mac = machine('mac', [
    home('claude', '~/.claude', [imported('~/gone.md', null, 1)]),
    home('codex', '~/.codex', [], ['~/.codex/config.toml isn’t TOML Arbor can read']),
  ], {
    local: true,
    installs: [
      install('claude', '~/.local/bin/claude', '2.1.281'),
      install('codex', '~/.npm-global/bin/codex', '0.156.1'),
      install('codex', '/opt/homebrew/bin/codex', null),
    ],
  });
  const ci = machine('ci-01', [home('claude', '~/.claude', [item('command', 'old', null, { link: '~/gone.md' }), setting('cleanupPeriodDays', '36500')])], {
    error: 'ssh: connect to host ci-01 port 22: Operation timed out',
  });

  it('lists every install of an agent found more than once, the one that runs first', () => {
    const [duplicate, ...rest] = find(setupChecks([mac]), 'duplicateInstall');
    expect(rest).toEqual([]);
    expect(duplicate).toMatchObject({ home: null, facts: { agent: 'Codex' } });
    expect(named(duplicate)).toEqual(['~/.npm-global/bin/codex (0.156.1)', '/opt/homebrew/bin/codex']);
  });

  it('puts problems first, then goes machine by machine', () => {
    const checks = setupChecks([mac, ci]);
    expect(checks.map((check) => `${check.level} ${check.machine} ${check.kind}`)).toEqual([
      'problem mac brokenImport',
      'problem ci-01 brokenLink',
      'warning mac unreadable',
      'warning mac duplicateInstall',
      'warning ci-01 scanFailed',
      'note mac sessionCleanup',
    ]);
    expect(checkCounts(checks)).toEqual({ problem: 2, warning: 3, note: 1 });
    expect(new Set(checks.map((check) => check.id)).size).toBe(checks.length);
    expect(setupChecks([mac, ci]).map((check) => check.id)).toEqual(checks.map((check) => check.id));
  });

  it('has nothing to say about a machine that hasn’t been scanned', () => {
    expect(setupChecks([machine('new', [], { scannedAt: null })])).toEqual([]);
  });
});

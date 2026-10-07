import { describe, expect, it } from 'bun:test';
import {
  fileWanted,
  nothingToApply,
  isStoreSkill,
  removableKind,
  scanned,
  skillWanted,
  syncChanges,
  syncCounts,
  syncKind,
  syncPlan,
  tally,
  type SyncFile,
} from '../src/services/setupSync';
import type { SetupHome, SetupItem, SetupMachine, SetupRepo, SetupRepoFile, SetupRepoSkill } from '../src/native/types';

const item = (kind: SetupItem['kind'], path: string, sum: string | null, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind, name: path.slice(path.lastIndexOf('/') + 1), path, sum, size: 120, link: null, value: null, note: null, count: null, enabled: null,
  text: true, skill: null, import: null, ...fields,
});
const home = (agent: SetupHome['agent'], path: string, items: SetupItem[]): SetupHome => ({ agent, path, items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null });
const machine = (homes: SetupHome[], fields: Partial<SetupMachine> = {}): SetupMachine => ({
  machine: 'ci-01', local: false, reachable: true, homes, harnessHomes: [], harnessInstalls: [], installs: [], policy: null, scannedAt: 1_000, error: null, scanning: false, ...fields,
});
const sha = (seed: string) => seed.repeat(64).slice(0, 64);
const repoFile = (path: string, sum: string, ck = 'c1-120'): SetupRepoFile => ({ path, kind: syncKind(path)!, sum, ck, size: 120 });
const repo = (files: SetupRepoFile[], skills: SetupRepoSkill[] = []): SetupRepo => ({
  path: '/Users/cam/src/agent-setup', branch: 'main', head: { sha: sha('ab'), subject: 'Start', atMs: 1_000 },
  upstream: null, uncommitted: [], files, skills, ignored: [], skillMachines: {}, removedSkills: [], removedFiles: [], offSkills: [], offFiles: [], fileMachines: {}, skillProjects: {}, mcpProjects: {}, instructions: [],
    plugins: [], codexPlugins: [], layers: { machines: [], projects: [], problems: [] },
});
const repoSkill = (name: string, sum: string | null, fields: Partial<SetupRepoSkill> = {}): SetupRepoSkill => ({
  name, path: `~/.agents/skills/${name}`, sum, ck: sum === null ? null : 'c9-40', files: 3, size: 4_096, problem: null, source: null, ...fields,
});
const facts = (hasDoc = true) => ({ files: 3, hasDoc, declaredName: null, descriptionChars: 80, whenToUseChars: 0, manualOnly: false, source: null });
const storeSkill = (name: string, sum: string | null, fields: Partial<SetupItem> = {}) =>
  item('skill', `~/.agents/skills/${name}`, sum, { text: false, skill: facts(), ...fields });
const states = (files: SyncFile[]) => files.map((file) => [file.path, file.state]);

describe('what the repo syncs', () => {
  it('syncs each agent’s own instructions, and never one in place of the other', () => {
    expect(syncKind('~/.claude/CLAUDE.md')).toBe('instructions');
    expect(syncKind('~/.codex/AGENTS.md')).toBe('instructions');
    expect(syncKind('~/.claude/AGENTS.md')).toBeNull();
    expect(syncKind('~/.codex/CLAUDE.md')).toBeNull();
    expect(syncKind('~/.codex/AGENTS.override.md')).toBeNull();
  });

  it('syncs rules at any depth, subagents at the top of their folder, and commands and prompts', () => {
    expect(syncKind('~/.claude/rules/testing.md')).toBe('rule');
    expect(syncKind('~/.claude/rules/web/react.md')).toBe('rule');
    expect(syncKind('~/.claude/agents/reviewer.md')).toBe('subagent');
    expect(syncKind('~/.claude/agents/team/reviewer.md')).toBeNull();
    expect(syncKind('~/.claude/commands/ship.md')).toBe('command');
    expect(syncKind('~/.codex/prompts/review.md')).toBe('command');
  });

  it('leaves settings, skills, Codex’s rules and anything named like a secret alone', () => {
    expect(syncKind('~/.claude/settings.json')).toBeNull();
    expect(syncKind('~/.claude/skills/pdf/SKILL.md')).toBeNull();
    expect(syncKind('~/.codex/rules/default.rules')).toBeNull();
    expect(syncKind('~/.codex/rules/notes.md')).toBeNull();
    expect(syncKind('~/.claude/commands/rotate-token.md')).toBeNull();
    expect(syncKind('~/.claude/rules/.env.md')).toBeNull();
    expect(syncKind('~/.claude/agents/Secrets.md')).toBeNull();
    expect(syncKind('~/.claude/commands/.md')).toBeNull();
    expect(syncKind('~/.claude/commands/ship.txt')).toBeNull();
  });

  it('only takes paths in the home, with nothing that climbs out of it', () => {
    expect(syncKind('/Users/cam/.claude/CLAUDE.md')).toBeNull();
    expect(syncKind('.claude/CLAUDE.md')).toBeNull();
    expect(syncKind('~/CLAUDE.md')).toBeNull();
    expect(syncKind('~/.claude/rules/../../.ssh/config.md')).toBeNull();
    expect(syncKind('~/.claude/rules/./testing.md')).toBeNull();
    expect(syncKind('~/.claude//CLAUDE.md')).toBeNull();
    expect(syncKind('~/.claude\\rules\\testing.md')).toBeNull();
  });
});

const synced = repo([
  repoFile('~/.codex/AGENTS.md', sha('9')),
  repoFile('~/.claude/rules/testing.md', sha('7')),
  repoFile('~/.claude/commands/ship.md', sha('5')),
  repoFile('~/.claude/agents/reviewer.md', sha('3')),
  repoFile('~/.claude/CLAUDE.md', sha('1')),
]);
const ci01 = machine([
  home('claude', '~/.claude', [
    item('instructions', '~/.claude/CLAUDE.md', sha('1')),
    item('subagent', '~/.claude/agents/reviewer.md', sha('4')),
    item('rule', '~/.claude/rules/testing.md', sha('7'), { link: '~/src/team-rules/testing.md' }),
    item('command', '~/.claude/commands/deploy.md', sha('6')),
    // None of these are the repo's to change: a link only this machine has, a skill, an import and a setting.
    item('command', '~/.claude/commands/old.md', null, { link: '~/src/scripts/old.md' }),
    item('skill', '~/.claude/skills/pdf', sha('8'), { text: false }),
    item('import', '~/.claude/rules/imported.md', sha('a')),
    item('setting', 'model', 's1', { path: null, value: 'opus' }),
  ]),
  // Only the default homes are synced.
  home('claude', '~/.agent-app/homes/claude-other', [item('instructions', '~/.agent-app/homes/claude-other/CLAUDE.md', sha('2'))]),
]);
const plan = syncPlan(synced, ci01);

describe('a machine against the repo', () => {
  it('finds what matches, differs, is missing, is only on the machine, is a link, or has no home there', () => {
    expect(states(plan)).toEqual([
      ['~/.claude/CLAUDE.md', 'same'],
      ['~/.claude/agents/reviewer.md', 'update'],
      ['~/.claude/commands/deploy.md', 'extra'],
      ['~/.claude/commands/ship.md', 'add'],
      ['~/.claude/rules/testing.md', 'linked'],
      ['~/.codex/AGENTS.md', 'noHome'],
    ]);
  });

  it('keeps both copies it compared', () => {
    const [, update, extra, add] = plan;
    expect([update!.repo?.sum, update!.item?.sum]).toEqual([sha('3'), sha('4')]);
    expect([extra!.repo, extra!.item?.sum, extra!.kind]).toEqual([null, sha('6'), 'command']);
    expect([add!.repo?.sum, add!.item]).toEqual([sha('5'), null]);
  });

  it('compares a machine without a SHA-256 tool by its checksum', () => {
    const checked = syncPlan(
      repo([repoFile('~/.claude/CLAUDE.md', sha('1'), 'c3141-120'), repoFile('~/.claude/rules/testing.md', sha('7'), 'c2718-80')]),
      machine([home('claude', '~/.claude', [
        item('instructions', '~/.claude/CLAUDE.md', 'c3141-120'),
        item('rule', '~/.claude/rules/testing.md', 'c2718-81'),
      ])]),
    );
    expect(states(checked)).toEqual([['~/.claude/CLAUDE.md', 'same'], ['~/.claude/rules/testing.md', 'update']]);
  });

  it('reads a SHA-256 that starts with a c as a SHA-256', () => {
    const sum = `c${'0'.repeat(63)}`;
    const checked = syncPlan(repo([repoFile('~/.claude/CLAUDE.md', sum, 'c0-120')]),
      machine([home('claude', '~/.claude', [item('instructions', '~/.claude/CLAUDE.md', sum)])]));
    expect(states(checked)).toEqual([['~/.claude/CLAUDE.md', 'same']]);
  });
});

describe('what applying changes', () => {
  it('writes the repo’s copies where they differ or are missing, and keeps files only the machine has', () => {
    expect(syncChanges(plan)).toEqual([
      { path: '~/.claude/agents/reviewer.md', remove: false, before: sha('4') },
      { path: '~/.claude/commands/ship.md', remove: false, before: null },
    ]);
  });

  it('removes a file only the machine has once it’s chosen, and skips a copy left out', () => {
    expect(syncChanges(plan, { '~/.claude/commands/deploy.md': true, '~/.claude/agents/reviewer.md': false })).toEqual([
      { path: '~/.claude/commands/deploy.md', remove: true, before: sha('6') },
      { path: '~/.claude/commands/ship.md', remove: false, before: null },
    ]);
  });

  it('never changes a file that matches, a link, or one in a home the machine hasn’t got', () => {
    const everything = Object.fromEntries(plan.map((file) => [file.path, true]));
    expect(syncChanges(plan, everything).map((change) => change.path)).toEqual([
      '~/.claude/agents/reviewer.md', '~/.claude/commands/deploy.md', '~/.claude/commands/ship.md',
    ]);
  });
});

describe('whether a machine is in step', () => {
  it('counts each state, and isn’t in step while anything the repo has differs or is missing', () => {
    expect(syncCounts(plan)).toEqual({ same: 1, update: 1, add: 1, extra: 1, removed: 0, linked: 1, noHome: 1, blocked: 0, offHere: 0, own: 0 });
    expect(nothingToApply(syncCounts(plan))).toBe(false);
  });

  it('is in step with files only it has, links, and homes it hasn’t got', () => {
    expect(nothingToApply({ same: 3, update: 0, add: 0, extra: 2, removed: 0, linked: 1, noHome: 1, blocked: 2, offHere: 0, own: 0 })).toBe(true);
  });

  it('has something to compare once it has been read', () => {
    expect(scanned(machine([], { scannedAt: null }))).toBe(false);
    expect(scanned(machine([], { scannedAt: 1_000 }))).toBe(true);
    expect(scanned(machine([home('claude', '~/.claude', [])], { scannedAt: null }))).toBe(true);
  });
});

describe('skills against the repo', () => {
  const skills = repo([], [
    repoSkill('pdf', sha('1')),
    repoSkill('release-notes', sha('2')),
    repoSkill('frontend-design', sha('3')),
    repoSkill('agents-md', sha('4')),
    repoSkill('scratch', sha('5')),
    repoSkill('leaky', null, { problem: 'secret' }),
  ]);
  const store = machine([
    home('shared', '~/.agents', [
      storeSkill('pdf', sha('1')),
      storeSkill('release-notes', sha('9')),
      storeSkill('agents-md', sha('4'), { link: '~/src/skills/agents-md' }),
      storeSkill('scratch', null, { skill: facts(false) }),
      storeSkill('find-skills', sha('6')),
      // Only a store's own skills are the repo's to change: a link, a folder that isn't a skill, and a command.
      storeSkill('mine', sha('7'), { link: '~/src/skills/mine' }),
      storeSkill('notes', sha('8'), { skill: facts(false) }),
      item('command', '~/.agents/commands/review.md', sha('a')),
    ]),
    // A skill in an agent's own home isn't the store's.
    home('claude', '~/.claude', [item('skill', '~/.claude/skills/frontend-design', sha('3'), { text: false, skill: facts() })]),
  ]);
  const skillPlan = syncPlan(skills, store);

  it('finds each skill the store has the same, differently, not at all, as a link, or only there', () => {
    expect(states(skillPlan)).toEqual([
      ['~/.agents/skills/agents-md', 'linked'],
      ['~/.agents/skills/find-skills', 'extra'],
      ['~/.agents/skills/frontend-design', 'add'],
      ['~/.agents/skills/leaky', 'blocked'],
      ['~/.agents/skills/pdf', 'same'],
      ['~/.agents/skills/release-notes', 'update'],
      ['~/.agents/skills/scratch', 'blocked'],
    ]);
    expect(skillPlan.every((file) => file.kind === 'skill' && file.repo === null)).toBe(true);
  });

  it('says why a skill can’t be synced: the repo’s copy’s problem, or a folder there that isn’t a skill', () => {
    const problems = skillPlan.filter((file) => file.state === 'blocked').map((file) => [file.path, file.problem]);
    expect(problems).toEqual([['~/.agents/skills/leaky', 'secret'], ['~/.agents/skills/scratch', 'notSkill']]);
  });

  it('adds skills to a machine that has no store yet, where it’s made', () => {
    const bare = syncPlan(repo([], [repoSkill('pdf', sha('1'))]), machine([home('claude', '~/.claude', [])]));
    expect(states(bare)).toEqual([['~/.agents/skills/pdf', 'add']]);
  });

  it('compares a machine without a SHA-256 tool by its checksum', () => {
    const checked = syncPlan(repo([], [repoSkill('pdf', sha('1'), { ck: 'c3-99' }), repoSkill('xlsx', sha('2'), { ck: 'c4-99' })]),
      machine([home('shared', '~/.agents', [storeSkill('pdf', 'c3-99'), storeSkill('xlsx', 'c5-99')])]));
    expect(states(checked)).toEqual([['~/.agents/skills/pdf', 'same'], ['~/.agents/skills/xlsx', 'update']]);
  });

  it('writes skills as it writes files, and never touches a blocked one or a link', () => {
    const everything = Object.fromEntries(skillPlan.map((file) => [file.path, true]));
    expect(syncChanges(skillPlan, everything)).toEqual([
      { path: '~/.agents/skills/find-skills', remove: true, before: sha('6') },
      { path: '~/.agents/skills/frontend-design', remove: false, before: null },
      { path: '~/.agents/skills/release-notes', remove: false, before: sha('9') },
    ]);
  });

  it('isn’t held out of step by a skill it can’t sync', () => {
    expect(syncCounts(skillPlan)).toEqual({ same: 1, update: 1, add: 1, extra: 1, removed: 0, linked: 1, noHome: 0, blocked: 2, offHere: 0, own: 0 });
    const settled = syncPlan(repo([], [repoSkill('pdf', sha('1')), repoSkill('leaky', null, { problem: 'large' })]),
      machine([home('shared', '~/.agents', [storeSkill('pdf', sha('1'))])]));
    expect(nothingToApply(syncCounts(settled))).toBe(true);
  });

  it('counts skills apart from files', () => {
    expect(isStoreSkill('~/.agents/skills/pdf')).toBe(true);
    expect(isStoreSkill('~/.agents/skills/pdf/SKILL.md')).toBe(false);
    expect(isStoreSkill('~/.agents/skills/.hidden')).toBe(false);
    expect(isStoreSkill('~/.claude/skills/pdf')).toBe(false);
    expect(tally(['~/.claude/CLAUDE.md', '~/.agents/skills/pdf', '~/.agents/skills/xlsx'])).toEqual({ files: 1, skills: 2 });
  });
});

describe('a skill’s own value on a machine', () => {
  const skills = repo([], [repoSkill('pdf', sha('1')), repoSkill('release-notes', sha('2')), repoSkill('frontend-design', sha('3'))]);
  const store = machine([
    home('shared', '~/.agents', [storeSkill('release-notes', sha('9')), storeSkill('frontend-design', sha('8'))]),
  ]);

  it('keeps a skill off a machine, and leaves the machine’s own copy as it is, neither out of step', () => {
    // Machines compare loosely: "CI 01" in the file is ci-01.
    const wanted = { ...skills, skillMachines: { pdf: { ci01: 'off' as const }, 'release-notes': { ci01: 'off' as const }, 'frontend-design': { ci01: 'own' as const } } };
    const plan = syncPlan(wanted, store);
    expect(plan.map((file) => [file.path, file.state])).toEqual([
      ['~/.agents/skills/frontend-design', 'own'],
      ['~/.agents/skills/pdf', 'offHere'],
      ['~/.agents/skills/release-notes', 'offHere'],
    ]);
    expect(syncChanges(plan)).toEqual([]);
    expect(nothingToApply(syncCounts(plan))).toBe(true);
    expect(skillWanted(wanted, '~/.agents/skills/pdf', 'CI 01')).toBe('off');
  });

  it('follows every machine’s value on a machine without one, and adds a skill a machine keeps its own of but hasn’t got', () => {
    const plan = syncPlan({ ...skills, skillMachines: { pdf: { cedar02: 'off' }, 'frontend-design': { ci01: 'own' } } }, store);
    expect(plan.find((file) => file.path.endsWith('/pdf'))?.state).toBe('add');
    expect(syncPlan({ ...skills, skillMachines: { pdf: { ci01: 'own' } } }, store).find((file) => file.path.endsWith('/pdf'))?.state).toBe('add');
  });
});

describe('a skill the repo removed from every machine', () => {
  const store = machine([
    home('shared', '~/.agents', [storeSkill('pdf', sha('1')), storeSkill('sketch', sha('2')), storeSkill('mine', sha('3'))]),
  ]);
  const removed = { ...repo([]), removedSkills: ['pdf', 'sketch'], skillMachines: { sketch: { ci01: 'own' as const } } };

  it('removes the machine’s store copy unless it keeps its own, and holds the machine out of step until it’s gone', () => {
    const plan = syncPlan(removed, store);
    expect(plan.map((file) => [file.path, file.state])).toEqual([
      ['~/.agents/skills/mine', 'extra'],
      ['~/.agents/skills/pdf', 'removed'],
      ['~/.agents/skills/sketch', 'extra'],
    ]);
    // Removed by default; what's only the machine's stays unless chosen.
    expect(syncChanges(plan)).toEqual([{ path: '~/.agents/skills/pdf', remove: true, before: sha('1') }]);
    expect(syncChanges(plan, { '~/.agents/skills/pdf': false })).toEqual([]);
    expect(nothingToApply(syncCounts(plan))).toBe(false);
    expect(nothingToApply(syncCounts(syncPlan(removed, machine([home('shared', '~/.agents', [])]))))).toBe(true);
  });
});

describe('a file the repo removed from every machine', () => {
  it('removes the machine’s copy by default, leaving files the repo never had alone', () => {
    const agents = home('claude', '~/.claude', [
      item('subagent', '~/.claude/agents/old.md', sha('1')),
      item('subagent', '~/.claude/agents/mine.md', sha('2')),
    ]);
    const plan = syncPlan({ ...repo([]), removedFiles: ['~/.claude/agents/old.md'] }, machine([agents]));
    expect(plan.map((entry) => [entry.path, entry.state])).toEqual([
      ['~/.claude/agents/mine.md', 'extra'],
      ['~/.claude/agents/old.md', 'removed'],
    ]);
    expect(syncChanges(plan)).toEqual([{ path: '~/.claude/agents/old.md', remove: true, before: sha('1') }]);
    expect([removableKind('subagent'), removableKind('instructions')]).toEqual([true, false]);
  });
});

describe('a file or skill the repo keeps but turned off on every machine', () => {
  it('takes the machine’s copy out by default, and says it’s off where there’s none, unless the machine keeps its own', () => {
    const agents = home('claude', '~/.claude', [item('subagent', '~/.claude/agents/review.md', sha('1'))]);
    const store = home('shared', '~/.agents', [storeSkill('pdf', sha('3'))]);
    const setup = {
      ...repo([repoFile('~/.claude/agents/review.md', sha('1')), repoFile('~/.claude/commands/ship.md', sha('2'))], [repoSkill('pdf', sha('3')), repoSkill('notes', sha('4'))]),
      offFiles: ['~/.claude/agents/review.md', '~/.claude/commands/ship.md'],
      offSkills: ['pdf', 'notes'],
    };
    const plan = syncPlan(setup, machine([agents, store]));
    expect(states(plan)).toEqual([
      ['~/.agents/skills/notes', 'offHere'],
      ['~/.agents/skills/pdf', 'removed'],
      ['~/.claude/agents/review.md', 'removed'],
      ['~/.claude/commands/ship.md', 'offHere'],
    ]);
    expect(syncChanges(plan)).toEqual([
      { path: '~/.agents/skills/pdf', remove: true, before: sha('3') },
      { path: '~/.claude/agents/review.md', remove: true, before: sha('1') },
    ]);
    // Off everywhere isn't out of step once the copies are gone.
    expect(nothingToApply(syncCounts(syncPlan(setup, machine([home('claude', '~/.claude', []), home('shared', '~/.agents', [])]))))).toBe(true);
    const own = { ...setup, fileMachines: { '~/.claude/agents/review.md': { ci01: 'own' as const } }, skillMachines: { pdf: { ci01: 'own' as const } } };
    expect(states(syncPlan(own, machine([agents, store]))).filter(([path]) => path === '~/.agents/skills/pdf' || path === '~/.claude/agents/review.md')).toEqual([
      ['~/.agents/skills/pdf', 'own'],
      ['~/.claude/agents/review.md', 'own'],
    ]);
  });
});

describe('a file’s own value on a machine', () => {
  it('keeps a rule, subagent or command off a machine, or its own copy, neither out of step', () => {
    const repoFiles = repo([repoFile('~/.claude/agents/old.md', sha('1')), repoFile('~/.claude/commands/ship.md', sha('2'))]);
    const agents = home('claude', '~/.claude', [
      item('subagent', '~/.claude/agents/old.md', sha('9')),
      item('command', '~/.claude/commands/ship.md', sha('8')),
    ]);
    const wanted = { ...repoFiles, fileMachines: { '~/.claude/agents/old.md': { ci01: 'off' as const }, '~/.claude/commands/ship.md': { ci01: 'own' as const } } };
    const plan = syncPlan(wanted, machine([agents]));
    expect(plan.map((entry) => [entry.path, entry.state])).toEqual([
      ['~/.claude/agents/old.md', 'offHere'],
      ['~/.claude/commands/ship.md', 'own'],
    ]);
    expect(syncChanges(plan)).toEqual([]);
    expect(fileWanted(wanted, '~/.claude/agents/old.md', 'CI 01')).toBe('off');
    // Every other machine follows the repo.
    expect(syncPlan(wanted, machine([agents], { machine: 'mac' })).map((entry) => entry.state)).toEqual(['update', 'update']);
  });
});
